#!/usr/bin/env node
/**
 * M4-C2-D split-process installed-build upgrade safety qualification.
 *
 * This lane proves the real old-Host / new-Client transition with two genuine
 * packaged payloads:
 *
 *   old tgz installed in the one canonical profile (Host A + Client A)
 *   new tgz installed side-by-side as a real package root (Client B candidate)
 *     only after Host A has admitted a Turn and Client A has exited
 *   same DSH_HOME / profile / UID / DSH rc.4 for both builds
 *
 * It then proves readLocalRecord -> /proc starttime -> assertBuildCompatible ->
 * HOST_BUILD_INCOMPATIBLE -> Client exit without spawning, killing, replacing
 * or mutating the live Host, while the old Host-owned Turn is still running.
 * Only after a separate explicit SIGTERM (mapped by the Host entry to its ONE
 * official `runProfile` shutdown owner) does the lane install the new payload
 * into the profile and proves a fresh Host identity plus durable Session
 * readback through the new Client.
 *
 * The side-by-side shape is deliberate: replacing a live profile package
 * payload in place is NOT a qualified hot-upgrade path. A local probe showed
 * the old Host can complete its shutdown records while the process remains
 * alive when its on-disk payload was replaced under it. This lane therefore
 * qualifies the safe order — introduce the new build, stop the old Host
 * explicitly, then replace the installed profile — and leaves the running old
 * installation byte-for-byte intact during the mismatch.
 *
 * Usage:
 *   pnpm smoke:split-upgrade -- --old <absolute-old.tgz> --new <absolute-new.tgz> [--evidence <file>]
 *
 * Both artifacts must be real `.tgz` files with a matching package name and a
 * different SHA256. The lane never downloads an arbitrary "latest" build and
 * never derives the old artifact by mutating the new one.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  run,
  runDsh,
  runPnpmInstall,
} from './pi2dsh-compat-smoke.mjs'
import { loadDshDistribution, npmDshVersion, PACKAGE_ROOT } from './lib/dsh-distribution.mjs'
import { EntryProcess, SurfaceEntryProcess, hostSessionEvents, waitForHostSessionEvent, writeC1WorkFixture } from './split-process-smoke.mjs'

const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
const KEEP = process.env.SPLIT_UPGRADE_KEEP === '1'
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u

let statusSequence = 0
const activeProcesses = new Set()
const trackedHosts = new Map()

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${message}`)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * sha256 over every regular file in one installed package tree. This proves
 * byte identity of the old installation across the side-by-side install, not
 * only that the profile still resolves the same directory path.
 */
function installedPayloadHash(packageRoot) {
  const hash = createHash('sha256')
  const files = readdirSync(packageRoot, { recursive: true })
    .filter(name => {
      try {
        return statSync(join(packageRoot, name)).isFile()
      } catch {
        return false
      }
    })
    .map(name => relative(packageRoot, join(packageRoot, name)).split(sep).join('/'))
    .sort()
  for (const name of files) {
    hash.update(name)
    hash.update('\0')
    hash.update(sha256(join(packageRoot, ...name.split('/'))))
    hash.update('\n')
  }
  return hash.digest('hex')
}

function readTarballManifest(path) {
  const result = spawnSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`the tarball manifest could not be read from ${path}: ${result.stderr || String(result.error ?? '')}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`the tarball manifest is not valid JSON: ${String(error)}`)
  }
}

function inspectArtifact(path, label) {
  const absolute = resolve(path)
  let info
  try {
    info = lstatSync(absolute)
  } catch {
    throw new Error(`${label} artifact does not exist: ${absolute}`)
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} artifact must be a regular file with exactly one link: ${absolute}`)
  }
  const manifest = readTarballManifest(absolute)
  if (manifest?.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`${label} artifact must be ${EXPECTED_PACKAGE_NAME}, got ${String(manifest?.name)}`)
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    throw new Error(`${label} artifact has an invalid version: ${String(manifest.version)}`)
  }
  return { path: absolute, manifest, sha256: sha256(absolute) }
}

/**
 * Parse the lane arguments. Exported so the tooling wiring test can prove the
 * fail-closed argument contract without running the expensive real lane.
 */
export function parseUpgradeArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const selected = { old: undefined, new: undefined, evidence: undefined }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument !== '--old' && argument !== '--new' && argument !== '--evidence') {
      throw new Error(`split upgrade smoke: unknown argument ${JSON.stringify(argument)}`)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`split upgrade smoke: ${argument} requires a path`)
    }
    const key = argument.slice(2)
    if (selected[key] !== undefined) {
      throw new Error(`split upgrade smoke: duplicate ${argument}`)
    }
    selected[key] = value
    index += 1
  }
  if (selected.old === undefined || selected.new === undefined) {
    throw new Error('split upgrade smoke: both --old <tgz> and --new <tgz> are required')
  }
  const oldPath = resolve(selected.old)
  const newPath = resolve(selected.new)
  if (oldPath === newPath) {
    throw new Error('split upgrade smoke: --old and --new must name different artifacts')
  }
  return {
    old: oldPath,
    new: newPath,
    evidence: selected.evidence === undefined ? undefined : resolve(selected.evidence),
  }
}

function usage() {
  return 'usage: pnpm smoke:split-upgrade -- --old <absolute-old.tgz> --new <absolute-new.tgz> [--evidence <file>]'
}

/** The production build fingerprint from the owning source module. */
function productionBuildId(packageRoot, dshVersion) {
  const moduleUrl = pathToFileURL(join(PACKAGE_ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
  const code = `import { computeBuildId } from ${JSON.stringify(moduleUrl)}; process.stdout.write(computeBuildId(process.argv[1], process.argv[2]))`
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', code, packageRoot, dshVersion],
    { cwd: PACKAGE_ROOT, env: process.env, encoding: 'utf8', timeout: 60_000 },
  )
  if (result.status !== 0) {
    throw new Error(`the production build fingerprint could not be computed for ${packageRoot}: ${result.stderr || String(result.error ?? '')}`)
  }
  const value = result.stdout.trim()
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`the production build fingerprint is not 64 hex characters: ${JSON.stringify(value)}`)
  }
  return value
}

function readProcessStarttime(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return tail[19]
  } catch {
    return undefined
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  return !alive(pid)
}

async function seatIsFree(name) {
  return await new Promise((resolveSeat, rejectSeat) => {
    const server = createServer()
    let settled = false
    server.once('error', error => {
      if (settled) return
      settled = true
      if (error.code === 'EADDRINUSE') resolveSeat(false)
      else rejectSeat(error)
    })
    server.listen(name, () => {
      if (settled) return
      settled = true
      server.close(() => resolveSeat(true))
    })
  })
}

/** Kill every split-process entry owned by this isolated DSH_HOME. */
function killIsolatedProcesses(dshHome) {
  const marker = `DSH_HOME=${dshHome}`
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return
  }
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue
    const pid = Number(name)
    let cmdline
    let environ
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
    } catch {
      continue
    }
    if (!cmdline.includes('local-host.mjs') && !cmdline.includes('local-client.mjs')) continue
    if (!environ.split('\0').includes(marker)) continue
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

async function hostStatus(host) {
  const requestId = `upgrade-status-${String(++statusSequence)}`
  host.send({ op: 'status', requestId })
  return await host.waitFor(
    record => record.m4a0 === 'status' && record.requestId === requestId,
    `Host status ${requestId}`,
    30_000,
  )
}

function safeIdentity(record) {
  return {
    schema: record.schema,
    scopeId: record.scopeId,
    instanceId: record.instanceId,
    hostPid: record.hostPid,
    hostStarttime: record.hostStarttime,
    origin: record.origin,
    protocol: record.protocol,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
  }
}

function assertIdentityKept(actual, expected, label) {
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'hostStarttime', 'protocol', 'bundleVersion', 'dshVersion', 'buildId']) {
    assert(actual?.[key] === expected?.[key], `${label}: identity ${key} changed`)
  }
}

function readC1WorkEvents(workRoot) {
  const path = join(workRoot, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

async function waitForC1WorkEvent(workRoot, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const event = readC1WorkEvents(workRoot).find(predicate)
    if (event !== undefined) return event
    await sleep(25)
  }
  throw new Error(`${label}: no C1 work proof matched within ${String(timeoutMs)}ms`)
}

function c1WorkHadRelease(workRoot) {
  return readC1WorkEvents(workRoot).some(event => event.kind === 'long-turn-released')
}

function scopeDirOf(dshHome, scopeId) {
  return join(dshHome, 'run', 'dsh-pi-tui', scopeId)
}

function scopeScratchDirs(scopeDir) {
  if (!existsSync(scopeDir)) return []
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('host-scratch-'))
    .map(entry => entry.name)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readHostLogRecords(scopeDir, pid) {
  const path = join(scopeDir, 'host.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const record = JSON.parse(line)
      return record?.pid === pid ? [record] : []
    } catch {
      return []
    }
  })
}

function createRequireFrom(anchor) {
  return createRequire(anchor)
}

function assertNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    assert(!text.includes(secret), `${label} leaked a private launch credential`)
  }
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/gu, '')
}

async function fetchStatus(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store', ...options })
  return { status: response.status, setCookie: response.headers.get('set-cookie') ?? '' }
}

function installSideBuild(dir, tarball, env) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org\n', { mode: 0o600 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'c2d-side-by-side-build',
    private: true,
    version: '1.0.0',
    dependencies: { [EXPECTED_PACKAGE_NAME]: `file:${tarball}` },
  }, null, 2) + '\n', 'utf8')
  const result = run('pnpm', [
    'install',
    '--ignore-scripts',
    '--no-frozen-lockfile',
    '--config.auto-install-peers=false',
    '--config.minimum-release-age=0',
    '--reporter=append-only',
  ], { cwd: dir, env, timeout: 10 * 60_000 })
  if (result.status !== 0) {
    throw new Error(`the side-by-side new-build install failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  const packageRoot = realpathSync(join(dir, 'node_modules', EXPECTED_PACKAGE_NAME))
  if (!existsSync(join(packageRoot, 'dist', 'local-client.mjs'))) {
    throw new Error('the side-by-side new-build install has no local Client entry')
  }
  return packageRoot
}

function killProcessGroup(process_handle) {
  if (process_handle === undefined) return
  try { process.kill(-process_handle.child.pid, 'SIGKILL') } catch {
    try { process_handle.child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

async function stopHostForCleanup(host) {
  if (host === undefined || host.exited) return
  try { process.kill(host.records.find(record => record.m4a0 === 'ready')?.pid ?? host.child.pid, 'SIGTERM') } catch { /* already gone */ }
  try { await host.waitForExit(20_000) } catch { killProcessGroup(host) }
}

async function main() {
  const options = parseUpgradeArguments(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const oldArtifact = inspectArtifact(options.old, 'old')
  const newArtifact = inspectArtifact(options.new, 'new')
  if (oldArtifact.sha256 === newArtifact.sha256) {
    throw new Error('split upgrade smoke: --old and --new must be different packaged bytes')
  }
  const targetDshVersion = npmDshVersion()
  const distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
  mkdirSync(join(PACKAGE_ROOT, 'temp'), { recursive: true })
  const workRoot = mkdtempSync(join(PACKAGE_ROOT, 'temp', 'split-upgrade-'))
  const home = join(workRoot, 'home')
  const dshHome = join(workRoot, 'dsh-home')
  const harnessDir = join(workRoot, 'harness')
  const sideBuildDir = join(workRoot, 'side-build')
  const scratch = join(workRoot, 'scratch')
  for (const directory of [home, dshHome, harnessDir, scratch]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(workRoot, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workRoot, home, dshHome, join(workRoot, 'evidence.json'))
  const hosts = []
  const clients = []
  const evidence = {
    lane: 'M4-C2-D split-process upgrade safety',
    status: 'RUNNING',
    dshVersion: targetDshVersion,
    old: {
      tarball: basename(oldArtifact.path),
      sha256: oldArtifact.sha256,
      packageVersion: oldArtifact.manifest.version,
      sourceRevision: process.env.SPLIT_UPGRADE_OLD_REVISION,
    },
    new: {
      tarball: basename(newArtifact.path),
      sha256: newArtifact.sha256,
      packageVersion: newArtifact.manifest.version,
    },
  }

  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-split-upgrade-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': targetDshVersion,
        '@deepseek-ai/dsh-client-store': targetDshVersion,
      },
    }, null, 2) + '\n', 'utf8')
    runPnpmInstall(harnessDir, env, distribution)
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    assert(version.status === 0 && version.stdout.trim() === targetDshVersion,
      `installed DSH version ${JSON.stringify(version.stdout.trim())} is not the pinned ${targetDshVersion}`)

    // ── Install the OLD build into the one canonical profile ────────────────
    installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    const profilePackage = join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)
    const oldProfilePackage = realpathSync(profilePackage)
    assert(existsSync(join(oldProfilePackage, 'dist', 'local-host.mjs')), 'the old profile install has no local Host entry')
    assert(existsSync(join(oldProfilePackage, 'dist', 'local-client.mjs')), 'the old profile install has no local Client entry')
    const oldBuildId = productionBuildId(oldProfilePackage, targetDshVersion)
    const oldPayloadHash = installedPayloadHash(oldProfilePackage)
    evidence.old.buildId = oldBuildId
    evidence.old.payloadSha256 = oldPayloadHash
    evidence.old.profilePackage = basename(oldProfilePackage)

    const anchor = realpathSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const c1Work = writeC1WorkFixture(profileDir, workRoot)
    const workRootPath = join(workRoot, 'c1-upgrade-work')
    mkdirSync(workRootPath, { recursive: true, mode: 0o700 })
    const releaseBarrier = join(workRoot, 'long-turn.release')
    const base = { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }
    const hostBase = {
      ...base,
      env: {
        ...base.env,
        SPLIT_PROCESS_EXTRA_PATCH: c1Work.patchPath,
        C1_SCENARIO: 'long-turn',
        C1_HOLD_LONG_TURN: releaseBarrier,
        C1_WORK_ROOT: workRootPath,
      },
    }

    // ── U01/U03: old Host A, old Client A, one real admitted Host Turn ──────
    const hostA = new EntryProcess('host', join(oldProfilePackage, 'dist', 'local-host.mjs'), hostBase)
    hosts.push(hostA)
    const hostAReady = await hostA.waitFor(record => record.m4a0 === 'ready', 'Host A ready', 240_000)
    assert(hostAReady.localHost.buildId === oldBuildId, 'Host A did not publish the old production buildId')
    assert(hostAReady.localHost.dshVersion === targetDshVersion, 'Host A DSH version is not the pinned rc.4')
    const hostABefore = safeIdentity(hostAReady.localHost)

    const clientA = new SurfaceEntryProcess(join(oldProfilePackage, 'dist', 'local-client.mjs'), {
      ...base,
      workDir: workRoot,
    })
    clients.push(clientA)
    const clientAReady = await clientA.waitFor(record => record.m4a0 === 'ready', 'Client A ready', 240_000)
    const clientAAuth = await clientA.waitFor(record => record.m4a0 === 'host-authenticated', 'Client A authenticated Host', 60_000)
    assertIdentityKept(clientAAuth.host, hostABefore, 'Client A authenticated Host')
    clientA.send('c2d-upgrade-hold\r')
    await clientA.waitForScreen('c2d-upgrade-hold', 'Client A prompt painted', 120_000)
    const sessionStatus = await clientA.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
      'Client A open Session',
      120_000,
    )
    const sessionId = sessionStatus.openSessionId
    const held = await waitForC1WorkEvent(workRootPath, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'Host A Turn held')
    assert(held.agentStatus === 'running', `Host A Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
    evidence.work = { sessionId, agentStatusAtHold: 'running', turnHeld: true }
    await clientA.waitFor(
      record => record.m4a0 === 'ready' && record.transport === 'connected',
      'Client A connected transport',
      60_000,
    )
    const clientAPid = clientA.records.find(record => record.m4a0 === 'ready')?.pid
    assert(Number.isInteger(clientAPid), 'Client A ready record has no business PID')
    const clientAExit = await (async () => {
      clientA.send('/exit\r')
      return await clientA.waitForExit(60_000)
    })()
    assert(clientAExit.code === 0 && clientAExit.signal === null, `Client A exit was ${JSON.stringify(clientAExit)}`)
    await clientA.dispose()
    assert(alive(hostAReady.pid), 'Host A died when Client A exited')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after Client A exit')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the upgrade attempt')
    evidence.work.clientAPid = clientAPid
    evidence.work.workContinuedAfterClientExit = true

    // ── Install the NEW build side-by-side while Host A works ───────────────
    // The old Host and its admitted Turn already exist at this point, so this
    // is the real "introduce another installation while the old Host runs"
    // ordering. The old profile must keep both its resolution target and its
    // byte-identical payload; the production buildId is re-derived from disk.
    assert(alive(hostAReady.pid), 'Host A died before the side-by-side new install')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the side-by-side new install')
    const sideBuildPackage = installSideBuild(sideBuildDir, newArtifact.path, env)
    const newBuildId = productionBuildId(sideBuildPackage, targetDshVersion)
    assert(newBuildId !== oldBuildId, 'the two packaged builds produced the same production buildId')
    assert(productionBuildId(oldProfilePackage, targetDshVersion) === oldBuildId,
      'the side-by-side install changed the old profile production buildId')
    assert(installedPayloadHash(oldProfilePackage) === oldPayloadHash,
      'the side-by-side install changed bytes in the old profile payload')
    const profileAnchor = join(profileDir, 'package.json')
    const resolvedProfileIndex = realpathSync(createRequireFrom(profileAnchor).resolve(EXPECTED_PACKAGE_NAME))
    const resolvedProfilePackage = dirname(dirname(resolvedProfileIndex))
    assert(resolvedProfilePackage === oldProfilePackage, 'the profile no longer resolves the old installation after the side-by-side install')
    assert(alive(hostAReady.pid), 'Host A died on the side-by-side new install')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after the side-by-side new install')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the side-by-side new install')
    evidence.new.buildId = newBuildId
    evidence.new.sideBuildPackage = basename(sideBuildPackage)
    evidence.new.installedAfterAdmittedWork = true
    evidence.old.profilePayloadUnchanged = true
    evidence.old.profileBuildIdUnchanged = true

    // ── Capture old credentials while Host A still owns them ───────────────
    const scopeDir = scopeDirOf(dshHome, hostABefore.scopeId)
    const registryBefore = readFileSync(join(scopeDir, 'instance.json'))
    const launchBefore = readFileSync(join(scopeDir, 'launch.json'))
    const oldLaunch = readJson(join(scopeDir, 'launch.json'))
    const oldOrigin = new URL(oldLaunch.connectUrl).origin
    const oldToken = new URL(oldLaunch.connectUrl).searchParams.get('token')
    assert(typeof oldToken === 'string' && oldToken !== '', 'Host A launch material has no token')
    const oldConnectUrl = new URL(oldLaunch.connectUrl)
    oldConnectUrl.searchParams.set('interactions', 'answer')
    const oldConnect = await fetchStatus(oldConnectUrl.href)
    assert(oldConnect.status === 302 && oldConnect.setCookie !== '', `Host A rejected its own launch token with status ${String(oldConnect.status)}`)
    const oldCookie = oldConnect.setCookie.split(';')[0]
    assert(oldCookie.includes('='), 'Host A did not return a Cookie for its launch token')
    const oldCookieIdentity = await fetchStatus(`${oldOrigin}/api/pi-tui.local-host`, { headers: { cookie: oldCookie } })
    assert(oldCookieIdentity.status === 200, 'Host A did not accept its own minted Cookie')

    // ── U02: new Client B (same scope, new build) refuses the live old Host ─
    const newClientEntry = join(sideBuildPackage, 'dist', 'local-client.mjs')
    const clientB = new EntryProcess('client', newClientEntry, base)
    clients.push(clientB)
    const clientBFailure = await clientB.waitFor(record => record.m4a0 === 'failure', 'new Client B refusal', 120_000)
    assert(clientBFailure.code === 'HOST_BUILD_INCOMPATIBLE',
      `new Client B expected HOST_BUILD_INCOMPATIBLE, got ${JSON.stringify(clientBFailure.code ?? clientBFailure.error)}`)
    assert(clientBFailure.phase === 'startup', `new Client B failure phase was ${JSON.stringify(clientBFailure.phase)}`)
    const clientBExit = await clientB.waitForExit(60_000)
    assert(clientBExit.code === 1 && clientBExit.signal === null, `new Client B exit was ${JSON.stringify(clientBExit)}`)
    for (const forbidden of ['ready', 'host-authenticated', 'transport-ready', 'context-ready']) {
      assert(!clientB.records.some(record => record.m4a0 === forbidden), `new Client B emitted ${forbidden} before/after the refusal`)
    }
    assert(!clientB.records.some(record => record.m4b2s === 'qualification' && record.stage === 'domains-ready'),
      'new Client B mounted Client Domains before the refusal')
    assert(!clientB.records.some(record => record.m4b2s === 'surface-status'), 'new Client B reported a surface status')
    evidence.refusal = {
      code: clientBFailure.code,
      exitCode: clientBExit.code,
      readyEmitted: false,
      hostAuthenticatedEmitted: false,
      clientContextEmitted: false,
      domainsReady: false,
    }

    // Old Host identity, registry and in-flight work are untouched.
    assert(alive(hostAReady.pid), 'Host A died on the new Client refusal')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime, 'Host A starttime changed after the refusal')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'new Client B mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'new Client B mutated the old launch material')
    const hostAAfterRefusal = safeIdentity((await hostStatus(hostA)).localHost)
    assertIdentityKept(hostAAfterRefusal, hostABefore, 'Host A after new Client refusal')
    const afterRefusalLiveness = (await hostStatus(hostA)).liveness
    assert(afterRefusalLiveness?.verdict === 'BLOCKED', `Host A liveness was ${JSON.stringify(afterRefusalLiveness?.verdict)} during the admitted Turn`)
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the new Client refusal')
    evidence.refusal.hostIdentityKept = true
    evidence.refusal.registryBytesUnchanged = true
    evidence.refusal.launchBytesUnchanged = true
    evidence.refusal.workStillRunning = true
    evidence.refusal.livenessVerdict = afterRefusalLiveness.verdict
    evidence.hostA = {
      pid: hostABefore.hostPid,
      starttime: hostABefore.hostStarttime,
      instanceId: hostABefore.instanceId,
      buildId: hostABefore.buildId,
      scopeId: hostABefore.scopeId,
    }

    // ── U04: the human-facing surface refusal is actionable and secret-free ─
    const surfaceRefusal = new SurfaceEntryProcess(newClientEntry, { ...base, workDir: workRoot })
    clients.push(surfaceRefusal)
    const surfaceExit = await surfaceRefusal.waitForExit(120_000)
    assert(surfaceExit.code === 1 && surfaceExit.signal === null, `surface refusal exit was ${JSON.stringify(surfaceExit)}`)
    // A surface startup refusal is a terminal line, not a JSON record: wait
    // for the pty output to arrive, then refresh the private record snapshot
    // once more (the poll interval may have stopped at the close event).
    let surfaceText = ''
    const surfaceDeadline = Date.now() + 15_000
    while (Date.now() < surfaceDeadline) {
      surfaceRefusal.readRecords()
      surfaceText = stripAnsi(`${surfaceRefusal.raw}\n${surfaceRefusal.stderr}`)
      if (surfaceText.includes('HOST_BUILD_INCOMPATIBLE:')) break
      await sleep(50)
    }
    assert(surfaceText.includes('HOST_BUILD_INCOMPATIBLE:'),
      `the surface refusal did not print the stable code; tail=${JSON.stringify(surfaceText.slice(-1600))} records=${JSON.stringify(surfaceRefusal.records.slice(-4))}`)
    assert(surfaceText.includes('has not been stopped or replaced'), 'the surface refusal did not say the old Host is preserved')
    assert(surfaceText.includes('explicitly stop that Host through its normal operating-system shutdown signal'),
      'the surface refusal did not require an explicit owner-verified stop')
    assert(surfaceText.includes('Automatic upgrade and migration of in-memory work are not supported'),
      'the surface refusal did not state that hot migration is unsupported')
    assert(!surfaceRefusal.records.some(record => record.m4a0 === 'ready'), 'the surface refusal reported ready')
    assert(!surfaceRefusal.records.some(record => record.m4b2s === 'surface-status' && record.surfaceMounted === true),
      'the surface refusal mounted the real surface')
    assertNoSecret('surface refusal output', surfaceText, [oldToken, oldCookie])
    assert(!surfaceText.includes(dshHome), 'the surface refusal leaked the private DSH home')
    assert(!surfaceText.includes(profileDir), 'the surface refusal leaked the private profile path')
    await surfaceRefusal.dispose()
    evidence.surfaceRefusal = {
      exitCode: surfaceExit.code,
      codeVisible: true,
      oldHostPreservedText: true,
      manualStopText: true,
      noHotMigrationText: true,
      surfaceReady: false,
      secretLeak: false,
    }

    // ── The admitted work completes normally after both refusals ─────────────
    // The barrier only controls the test's stream timing; releasing it proves
    // the old Host was never stopped or replaced by either new-Client attempt.
    writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
    const released = await waitForC1WorkEvent(
      workRootPath,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
      'Host A Turn completes after the refusals',
    )
    assert(released.sessionId === sessionId, 'Host A Turn completion names another Session')
    await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'Host A turn/end after the refusals')
    const durableEvents = hostSessionEvents(dshHome, sessionId) ?? []
    assert(durableEvents.some(event => event.type === 'user/message' && JSON.stringify(event).includes('c2d-upgrade-hold')),
      'the durable Session lost the admitted prompt')
    evidence.work.completedAfterRefusal = true

    // ── U05: explicit owner-verified SIGTERM, one official shutdown ─────────
    // Production spawns the Host with stdin ignored. The qualification harness
    // keeps a JSONL control pipe open, so close it before the signal: an open
    // `process.stdin` would keep the Node event loop alive after the completed
    // owner cleanup and turn a real graceful exit into a false timeout.
    hostA.child.stdin.end()
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime, 'the stop target PID starttime no longer matches Host A')
    process.kill(hostAReady.pid, 'SIGTERM')
    const stopRequested = await hostA.waitFor(record => record.m4a0 === 'stop-requested', 'Host A stop-requested', 60_000)
    assert(stopRequested.signal === 'SIGTERM', `Host A stop signal was ${JSON.stringify(stopRequested.signal)}`)
    const cleanup = await hostA.waitFor(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure', 'Host A cleanup', 120_000)
    assert(cleanup.m4a0 === 'cleanup' && cleanup.status === 'completed', `Host A cleanup was ${JSON.stringify(cleanup)}`)
    const hostAExit = await hostA.waitForExit(120_000)
    assert(hostAExit.code === 0 && hostAExit.signal === null, `Host A explicit stop exit was ${JSON.stringify(hostAExit)}`)
    assert(hostA.records.filter(record => record.m4a0 === 'stop-requested').length === 1, 'Host A admitted more than one stop intent')
    assert(hostA.records.filter(record => record.m4a0 === 'cleanup').length === 1, 'Host A reported more than one cleanup')
    assert(!hostA.records.some(record => record.m4a0 === 'cleanup-failure'), 'Host A reported a cleanup failure')
    assert(!existsSync(join(scopeDir, 'instance.json')), 'Host A left its instance.json behind')
    assert(!existsSync(join(scopeDir, 'launch.json')), 'Host A left its launch.json behind')
    assert(scopeScratchDirs(scopeDir).length === 0, 'Host A left its owner scratch behind')
    assert(await seatIsFree(`\0dsh-pi-tui-h-${hostABefore.scopeId.slice(0, 40)}`), 'Host A did not release the kernel Host seat')
    assert(await waitGone(hostAReady.pid), 'Host A process did not exit')
    evidence.stop = {
      signal: 'SIGTERM',
      stopRequests: 1,
      cleanupCompleted: 1,
      cleanupFailures: 0,
      exitCode: hostAExit.code,
      instanceRemoved: true,
      launchRemoved: true,
      scratchRemoved: true,
      hostSeatReleased: true,
    }

    // ── U06: after the old Host is gone, install the new build and boot it ─
    installPlugin(dsh, newArtifact.path, harnessDir, env, false)
    const installedNewPackage = realpathSync(profilePackage)
    assert(existsSync(join(installedNewPackage, 'dist', 'local-host.mjs')), 'the upgraded profile has no new local Host entry')
    const installedNewBuildId = productionBuildId(installedNewPackage, targetDshVersion)
    assert(installedNewBuildId === newBuildId, 'the upgraded profile buildId differs from the side-by-side new build')
    const clientB2 = new SurfaceEntryProcess(join(installedNewPackage, 'dist', 'local-client.mjs'), {
      ...base,
      workDir: workRoot,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionId },
    })
    clients.push(clientB2)
    const clientB2Ready = await clientB2.waitFor(record => record.m4a0 === 'ready', 'new Client B2 ready', 240_000)
    const newAuth = await clientB2.waitFor(record => record.m4a0 === 'host-authenticated', 'new Client B2 authenticated Host', 60_000)
    const newHost = safeIdentity(newAuth.host)
    assert(newHost.scopeId === hostABefore.scopeId, 'the new Host changed the canonical scope id')
    assert(newHost.instanceId !== hostABefore.instanceId, 'the new Host reused the old instance id')
    assert(newHost.hostPid !== hostABefore.hostPid, 'the new Host reused the old PID')
    assert(newHost.hostStarttime !== hostABefore.hostStarttime, 'the new Host reused the old starttime')
    assert(newHost.buildId === newBuildId, 'the new Host did not publish the new production buildId')
    assert(clientB2Ready.transport === 'connected', `new Client B2 transport was ${JSON.stringify(clientB2Ready.transport)}`)
    assert(clientB2Ready.host?.instanceId === newHost.instanceId, 'new Client B2 ready record names another Host')
    await clientB2.waitForScreen('c2d-upgrade-hold', 'new Client B2 durable Session readback', 120_000)
    const resumedStatus = await clientB2.waitFor(
      record => record.m4b2s === 'surface-status' && record.openSessionId === sessionId,
      'new Client B2 resumed the durable Session',
      120_000,
    )
    assert(resumedStatus.openSessionId === sessionId, 'new Client B2 did not resume the persisted Session id')
    const resumedDurable = hostSessionEvents(dshHome, sessionId) ?? []
    assert(resumedDurable.some(event => event.type === 'user/message' && JSON.stringify(event).includes('c2d-upgrade-hold')),
      'the durable Session history lost the admitted prompt after the new Host boot')
    assert(resumedDurable.some(event => event.type === 'turn/start'), 'the durable Session history lost the Turn start')
    assert(resumedDurable.some(event => event.type === 'turn/end'), 'the durable Session history lost the Turn end')

    // Old launch token and Cookie are invalid on the new Host.
    const newScopeDir = scopeDirOf(dshHome, newHost.scopeId)
    const newLaunch = readJson(join(newScopeDir, 'launch.json'))
    const newToken = new URL(newLaunch.connectUrl).searchParams.get('token')
    assert(typeof newToken === 'string' && newToken !== oldToken, 'the new Host reused the old launch token')
    const oldTokenOnNew = await fetchStatus(`${newHost.origin}/connect?token=${encodeURIComponent(oldToken)}&interactions=answer`)
    assert(oldTokenOnNew.status === 401 || oldTokenOnNew.status === 403 || oldTokenOnNew.status === 400,
      `the new Host accepted the old token with status ${String(oldTokenOnNew.status)}`)
    const oldCookieOnNew = await fetchStatus(`${newHost.origin}/api/pi-tui.local-host`, { headers: { cookie: oldCookie } })
    assert(oldCookieOnNew.status === 401 || oldCookieOnNew.status === 403,
      `the new Host accepted the old Cookie with status ${String(oldCookieOnNew.status)}`)
    evidence.newHost = {
      pid: newHost.hostPid,
      starttime: newHost.hostStarttime,
      instanceId: newHost.instanceId,
      buildId: newHost.buildId,
      scopeIdSame: true,
      authenticated: true,
      transport: 'connected',
      durableSessionReadback: true,
      oldTokenRejectedStatus: oldTokenOnNew.status,
      oldCookieRejectedStatus: oldCookieOnNew.status,
      oldInMemoryTurnNotContinued: true,
    }

    const clientB2Exit = await (async () => {
      clientB2.send('/exit\r')
      return await clientB2.waitForExit(60_000)
    })()
    assert(clientB2Exit.code === 0 && clientB2Exit.signal === null, `new Client B2 exit was ${JSON.stringify(clientB2Exit)}`)
    await clientB2.dispose()
    assert(alive(newHost.hostPid), 'the new Host died when its Client exited')
    // Stop the new Host through the same explicit owner-governed path. The
    // Host was spawned by the Client (not by this lane), so its records are in
    // the 0600 host.log and its starttime is rechecked before the signal.
    assert(readProcessStarttime(newHost.hostPid) === newHost.hostStarttime, 'the new Host stop target starttime no longer matches')
    process.kill(newHost.hostPid, 'SIGTERM')
    assert(await waitGone(newHost.hostPid, 120_000), 'the new Host process did not exit after SIGTERM')
    const newHostRecords = readHostLogRecords(newScopeDir, newHost.hostPid)
    assert(newHostRecords.filter(record => record.m4a0 === 'stop-requested').length === 1, 'the new Host did not admit exactly one stop intent')
    const newCleanup = newHostRecords.find(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
    assert(newCleanup?.m4a0 === 'cleanup' && newCleanup.status === 'completed', `the new Host cleanup was ${JSON.stringify(newCleanup)}`)
    assert(!newHostRecords.some(record => record.m4a0 === 'cleanup-failure'), 'the new Host reported a cleanup failure')
    assert(!existsSync(join(newScopeDir, 'instance.json')), 'the new Host left its instance.json behind')
    assert(!existsSync(join(newScopeDir, 'launch.json')), 'the new Host left its launch.json behind')
    assert(await seatIsFree(`\0dsh-pi-tui-h-${newHost.scopeId.slice(0, 40)}`), 'the new Host did not release the kernel Host seat')

    for (const path of [oldArtifact.path, newArtifact.path]) {
      assert(sha256(path) === (path === oldArtifact.path ? oldArtifact.sha256 : newArtifact.sha256),
        `the packaged artifact changed during the lane: ${basename(path)}`)
    }
    evidence.status = 'PASS'
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    process.stdout.write('SPLIT_UPGRADE_SMOKE_PASS\n')
    if (options.evidence !== undefined) {
      writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    }
  } finally {
    for (const client of clients) {
      try { await client.dispose?.() } catch { /* best effort */ }
    }
    for (const host of hosts) {
      await stopHostForCleanup(host).catch(() => undefined)
      killProcessGroup(host)
    }
    killIsolatedProcesses(dshHome)
    if (!KEEP) rmSync(workRoot, { recursive: true, force: true })
    else process.stderr.write(`preserved split-upgrade environment: ${workRoot}\n`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
