#!/usr/bin/env node
/**
 * Split-process cross-build Client/Host qualification with two real packages.
 *
 * This lane proves the real old-Host / new-Client transition with two genuine
 * packaged payloads:
 *
 *   old tgz installed in the one canonical profile (Host A + Client A)
 *   new tgz installed side-by-side as a real package root (Client B candidate)
 *     only after Host A has admitted a Turn and Client A is still live
 *   same DSH_HOME / profile / UID / DSH runtime for both builds
 *
 * U07 then reexecutes Client A onto the side-by-side build: the OLD Client A
 * keeps its real PTY, releases every Client resource through its ONE stop
 * coordinator, and a NEW OS PID loads the new `dist/local-client.mjs`, which
 * re-authenticates the SAME Host A and reopens the SAME Session. The old PID
 * remains only as the waiting parent that forwards the replacement exit code.
 *
 * Both packages name the same `dsh-pi-tui/local/1` wire protocol and the same
 * exact DSH runtime, but carry different package versions, bundles and
 * buildIds. The new Client B must authenticate the SAME Host A, call the real
 * official `session/list`, private PiFile RPC and private terminal-progress
 * watch, and the new build's real PTY surface must open the SAME running
 * Session. Neither Client may mutate Host A, its registry/launch files, or
 * release its admitted Turn.
 *
 * Only after the turn completes and a separate explicit SIGTERM (mapped by the
 * Host entry to its ONE official `runProfile` shutdown owner) does the lane
 * install the new payload into the profile and prove a fresh Host identity plus
 * durable Session readback.
 *
 * The side-by-side shape is deliberate: replacing a live profile package
 * payload in place is NOT a qualified hot-upgrade path. A local probe showed
 * the old Host can complete its shutdown records while the process remains
 * alive when its on-disk payload was replaced under it. This lane therefore
 * qualifies the safe order — introduce the new build, stop the old Host
 * explicitly, then replace the installed profile — and leaves the running old
 * installation byte-for-byte intact while the cross-build Client attaches.
 *
 * Usage:
 *   pnpm smoke:split-upgrade -- --old <absolute-old.tgz> --new <absolute-new.tgz> [--evidence <file>]
 *
 * Both artifacts must be real `.tgz` files with a matching package name and a
 * different SHA256. The lane never downloads an arbitrary "latest" build and
 * never derives the old artifact by mutating the new one.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import { tmpdir } from 'node:os'
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

function canonicalAssertValue(value) {
  if (Array.isArray(value)) return value.map(canonicalAssertValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalAssertValue(value[key])]))
  }
  return value
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertNotEqual(actual, unexpected, message) {
  assert(actual !== unexpected, message ?? `did not expect ${JSON.stringify(unexpected)}`)
}

function assertDeepEqual(actual, expected, message) {
  const left = JSON.stringify(canonicalAssertValue(actual))
  const right = JSON.stringify(canonicalAssertValue(expected))
  assert(left === right, message ?? `expected ${right}, got ${left}`)
}

function assertMatch(actual, pattern, message) {
  assert(typeof actual === 'string' && pattern.test(actual),
    message ?? `${JSON.stringify(actual)} does not match ${String(pattern)}`)
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

/** Every durable Host Session log under the isolated DSH home (sorted). */
function sessionLogFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .map(name => String(name))
    .filter(name => name.endsWith('.jsonl.zstd'))
    .sort()
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

/**
 * Assert the active profile owns the exact Client peer set: plain
 * dependencies (never bundle layers) that its own node_modules resolves. A
 * harness devDependency or a checkout ancestor is not a Client peer owner
 * (issue #476). The published store declares its zustand/immer engine imports
 * only as devDependencies, so the profile must own the exact DSH 0.2.1-rc.4
 * pins as well.
 */
function assertProfileClientPeers(profileDir, targetDshVersion, label) {
  const manifest = readJson(join(profileDir, 'package.json'))
  const peers = [
    ['@deepseek-ai/dsh-client-store', targetDshVersion],
    ['zustand', '4.5.7'],
    ['immer', '10.2.0'],
  ]
  for (const [name, version] of peers) {
    assert(manifest.dependencies?.[name] === version,
      `${label}: the active profile does not declare the exact Client peer ${name}@${version}`)
    assert(!(manifest.dsh?.profile?.bundles ?? []).includes(name),
      `${label}: the plain Client peer ${name} must not become a profile bundle`)
    const peerDir = realpathSync(join(profileDir, 'node_modules', name))
    assert(readJson(join(peerDir, 'package.json')).version === version,
      `${label}: the active profile installed a different ${name} version`)
    const resolvedPeer = realpathSync(createRequireFrom(join(profileDir, 'package.json')).resolve(name))
    const peerRelative = relative(peerDir, resolvedPeer)
    assert(peerRelative !== '' && peerRelative !== '..' && !peerRelative.startsWith(`..${sep}`),
      `${label}: the active profile ${name} resolves outside its own package: ${resolvedPeer}`)
  }
  assert((manifest.dsh?.profile?.bundles ?? []).includes(EXPECTED_PACKAGE_NAME),
    `${label}: the candidate bundle row disappeared from the active profile`)
  return peers
}

function assertNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    assert(!text.includes(secret), `${label} leaked a private launch credential`)
  }
}

async function fetchStatus(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store', ...options })
  return { status: response.status, setCookie: response.headers.get('set-cookie') ?? '' }
}

function installSideBuild(dir, tarball, env, targetDshVersion) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org\n', { mode: 0o600 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'c2d-side-by-side-build',
    private: true,
    version: '1.0.0',
    dependencies: {
      [EXPECTED_PACKAGE_NAME]: `file:${tarball}`,
      '@deepseek-ai/dsh-client-store': targetDshVersion,
      zustand: '4.5.7',
      immer: '10.2.0',
    },
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
  if (oldArtifact.manifest.version === newArtifact.manifest.version) {
    throw new Error('split upgrade smoke: --old and --new must carry different package versions')
  }
  const targetDshVersion = npmDshVersion()
  const distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-split-upgrade-'))
  const home = join(workRoot, 'home')
  const dshHome = join(workRoot, 'dsh-home')
  const harnessDir = join(workRoot, 'harness')
  // A sibling of the active profile, never a child: its own pnpm project must
  // not discover or rewrite the running old profile, while DSH's `profiles/**`
  // interception still applies to its installed Client build.
  const sideBuildDir = join(dshHome, 'profiles', 'split-upgrade-side-build')
  // Known before the install exists: the old Client receives this absolute
  // root as its qualification target and only reads it at the reexec trigger.
  const sideBuildPackagePath = join(sideBuildDir, 'node_modules', EXPECTED_PACKAGE_NAME)
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
    // The upgrade work root must be a real OS temp root outside this checkout:
    // an ancestor `node_modules` would otherwise lend the Client peer set that
    // each isolated installation must own itself (issue #476).
    const workRootFromCheckout = relative(realpathSync(PACKAGE_ROOT), realpathSync(workRoot))
    assert(workRootFromCheckout === '..' || workRootFromCheckout.startsWith(`..${sep}`),
      `the split-upgrade work root must be outside the checkout: ${workRoot}`)
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-split-upgrade-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': targetDshVersion,
      },
    }, null, 2) + '\n', 'utf8')
    runPnpmInstall(harnessDir, env, distribution)
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    assert(version.status === 0 && version.stdout.trim() === targetDshVersion,
      `installed DSH version ${JSON.stringify(version.stdout.trim())} is not the pinned ${targetDshVersion}`)

    // ── Install the OLD build into the one canonical profile ────────────────
    // The Client's static platform peer belongs to the profile that will run
    // it, exactly like a production profile dependency; the harness only
    // anchors the DSH CLI installation (issue #476).
    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
    installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
    installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
    installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
    const activeClientPeers = assertProfileClientPeers(profileDir, targetDshVersion, 'old profile install')
    evidence.clientPeers = {
      owner: 'active pi-tui profile',
      packages: activeClientPeers.map(([name, version]) => `${name}@${version}`),
    }
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
      env: {
        ...base.env,
        // Qualification-only reexec trigger. The side-by-side target package
        // does not exist yet: the Client reads it only at the SIGUSR2 request.
        SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
        SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath,
      },
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
    // Client A stays the live PTY Client until the side-by-side build exists
    // and Host A is proven unchanged; U07 then reexecutes it in place.
    assert(alive(hostAReady.pid), 'Host A died while Client A was attached')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A while Client A is attached')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the upgrade attempt')
    evidence.work.clientAPid = clientAPid

    // ── Install the NEW build side-by-side while Host A works ───────────────
    // The old Host and its admitted Turn already exist at this point, so this
    // is the real "introduce another installation while the old Host runs"
    // ordering. The old profile must keep both its resolution target and its
    // byte-identical payload; the production buildId is re-derived from disk.
    assert(alive(hostAReady.pid), 'Host A died before the side-by-side new install')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the side-by-side new install')
    const sideBuildPackage = installSideBuild(sideBuildDir, newArtifact.path, env, targetDshVersion)
    for (const [name, version] of [
      ['@deepseek-ai/dsh-client-store', targetDshVersion],
      ['zustand', '4.5.7'],
      ['immer', '10.2.0'],
    ]) {
      const peerDir = realpathSync(join(sideBuildDir, 'node_modules', name))
      assert(readJson(join(peerDir, 'package.json')).version === version,
        `the side-by-side build installed a different ${name} version`)
      const resolvedPeer = realpathSync(createRequireFrom(join(sideBuildDir, 'package.json')).resolve(name))
      const peerRelative = relative(peerDir, resolvedPeer)
      assert(peerRelative !== '' && peerRelative !== '..' && !peerRelative.startsWith(`..${sep}`),
        `the side-by-side ${name} resolves outside its own package: ${resolvedPeer}`)
    }
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
    evidence.environment = {
      workRootOutsideCheckout: true,
      sideBuild: {
        location: relative(dshHome, sideBuildDir).split(sep).join('/'),
        siblingOfActiveProfile: true,
        packages: activeClientPeers.map(([name, version]) => `${name}@${version}`),
        reusesDshInstallationScope: true,
      },
    }

    // ── Capture old credentials while Host A still owns them ───────────────
    const scopeDir = scopeDirOf(dshHome, hostABefore.scopeId)
    const registryBefore = readFileSync(join(scopeDir, 'instance.json'))
    const launchBefore = readFileSync(join(scopeDir, 'launch.json'))
    const registryBeforeSha256 = createHash('sha256').update(registryBefore).digest('hex')
    const launchBeforeSha256 = createHash('sha256').update(launchBefore).digest('hex')
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

    // ── U07: real Client-only reexec onto the SAME Host A / Session S ───────
    // Client A is still the live PTY Client. The old Client must capture the
    // authoritative Session, release every Client resource through its ONE
    // stop coordinator, and only then spawn the NEW build's real entry as a
    // NEW OS PID. Host A, its Turn and its files must be untouched.
    const newClientEntry = join(sideBuildPackage, 'dist', 'local-client.mjs')
    const clientSeatName = `\0dsh-pi-tui-c-${hostABefore.scopeId.slice(0, 40)}`
    const sessionLogsBeforeReexec = sessionLogFiles(dshHome)
    assert(alive(clientAPid), 'Client A was not a live Client before the reexec handoff')
    assert(alive(hostAReady.pid), 'Host A died before the reexec handoff')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the reexec handoff')
    assertEqual(clientA.records.filter(record => record.m4b2s === 'client-closed').length, 0,
      'Client A closed itself before the reexec request')
    clientA.signalBusiness('SIGUSR2')
    const reexecRequested = await clientA.waitFor(
      record => record.m4r === 'handoff-requested' && record.pid === clientAPid,
      'Client A accepted the reexec handoff request',
      120_000,
    )
    assert(reexecRequested.sessionId === sessionId, 'the reexec request captured another Session')
    assert(reexecRequested.expectedHostInstanceId === hostABefore.instanceId, 'the reexec request captured another Host')
    assert(reexecRequested.targetBuildId === newBuildId, 'the reexec request captured another target build')
    assert(reexecRequested.targetBundleVersion === newArtifact.manifest.version, 'the reexec request captured another target version')
    const clientClosed = await clientA.waitFor(
      record => record.m4b2s === 'client-closed' && record.pid === clientAPid,
      'Client A released every owned Client resource',
      120_000,
    )
    assertEqual(clientClosed.sessionOpen, false, 'Client A still reported an open Session after its release')
    assertEqual(clientClosed.openSessionId, undefined, 'Client A still named an open Session after its release')
    assertEqual(clientClosed.surfaceMounted, false, 'Client A still reported a mounted surface after its release')
    assertEqual(clientClosed.activeWrappers, 0, 'Client A still owned an official transport wrapper after its release')
    assertEqual(clientClosed.liveSockets, 0, 'Client A still owned a live mux socket after its release')
    assertDeepEqual(clientClosed.owners, { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 },
      'Client A still owned Client services after its release')
    const c1Started = await clientA.waitFor(
      record => record.m4a0 === 'client-started' && record.pid !== clientAPid,
      'the replacement Client started as a new OS process',
      120_000,
    )
    const c1Pid = c1Started.pid
    assert(Number.isInteger(c1Pid) && c1Pid !== clientAPid, 'the replacement Client did not get a new OS PID')
    assert(alive(clientAPid), 'the old Client parent exited before its replacement finished')
    const c1Auth = await clientA.waitFor(
      record => record.m4a0 === 'host-authenticated' && record.pid === c1Pid,
      'the replacement Client authenticated Host A',
      180_000,
    )
    assertIdentityKept(c1Auth.host, hostABefore, 'replacement Client authenticated Host A')
    assert(c1Auth.host.buildId === oldBuildId, 'the replacement Client authenticated another Host build')
    const c1Restored = await clientA.waitFor(
      record => record.m4r === 'handoff-restored' && record.pid === c1Pid,
      'the replacement Client restored the original Session',
      180_000,
    )
    assertEqual(c1Restored.expectedHostInstanceId, hostABefore.instanceId)
    assertEqual(c1Restored.hostInstanceId, hostABefore.instanceId)
    assertEqual(c1Restored.sessionId, sessionId)
    assertEqual(c1Restored.sessionOpen, true)
    assertEqual(c1Restored.sessionHistoryOpen, true)
    assertEqual(c1Restored.surfaceMounted, true)
    assertEqual(c1Restored.transport, 'connected')
    assertEqual(c1Restored.clientBuildId, newBuildId, 'the replacement Client did not run the target build')
    assertNotEqual(c1Restored.clientBuildId, oldBuildId, 'the replacement Client re-ran the old build')
    const c1Ready = await clientA.waitFor(
      record => record.m4a0 === 'ready' && record.pid === c1Pid,
      'the replacement Client ready',
      120_000,
    )
    assertEqual(c1Ready.transport, 'connected')
    assertEqual(c1Ready.host?.instanceId, hostABefore.instanceId)
    assertEqual(c1Ready.sessionOpen, true)
    assertEqual(c1Ready.openSessionId, sessionId)
    await clientA.waitForScreen('c2d-upgrade-hold', 'the replacement surface painted the admitted prompt', 120_000)
    // While C1 runs, the OLD PID is only the waiting parent; C1 holds the ONE
    // kernel Client seat and the old Client owns nothing.
    assertEqual(await seatIsFree(clientSeatName), false, 'the replacement Client does not hold the Client seat')
    assert(alive(hostAReady.pid), 'Host A died during the reexec handoff')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
      'Host A starttime changed during the reexec handoff')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after the reexec handoff')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the reexec handoff')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
      'the reexec handoff mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
      'the reexec handoff mutated the old launch material')
    assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeReexec,
      'the reexec handoff created a new Session log')
    // Only the HUMAN-authored prompt counts: the Host also appends its own
    // runtime-context/time-context user-message snapshots on every turn.
    const promptsAfterReexec = (hostSessionEvents(dshHome, sessionId) ?? [])
      .filter(event => event.type === 'user/message'
        && event.data?.source?.kind === 'user'
        && JSON.stringify(event.data?.content ?? []).includes('c2d-upgrade-hold'))
    assertEqual(promptsAfterReexec.length, 1,
      `the reexec handoff replayed or duplicated the admitted prompt: ${JSON.stringify(promptsAfterReexec)}`)
    assertNoSecret('replacement Client records', JSON.stringify(clientA.records), [oldToken, oldCookie])
    assertNoSecret('replacement Client terminal', clientA.raw, [oldToken, oldCookie])
    // The replacement Client is addressed through the SAME real terminal.
    clientA.send('/exit\r')
    const reexecExit = await clientA.waitForExit(120_000)
    assertEqual(reexecExit.code, 0, `the replacement Client exit was ${JSON.stringify(reexecExit)}`)
    assertEqual(reexecExit.signal, null)
    assert(await waitGone(c1Pid), 'the replacement Client process did not exit')
    assert(await waitGone(clientAPid), 'the old Client waiting parent did not exit')
    assert(await seatIsFree(clientSeatName), 'the Client seat stayed owned after the replacement Client exited')
    assert(alive(hostAReady.pid), 'Host A died when the replacement Client exited')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released when the replacement Client exited')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after the replacement Client exit')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
      'the replacement Client exit mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
      'the replacement Client exit mutated the old launch material')
    await clientA.dispose()
    evidence.work.workContinuedAfterClientExit = true
    evidence.reexecHandoff = {
      oldClientPid: clientAPid,
      replacementClientPid: c1Pid,
      newOsPid: c1Pid !== clientAPid,
      oldParentWaitedDuringChild: true,
      oldClientOwnersReleased: true,
      oldClientSessionReferenceReleased: true,
      clientSeatHeldByReplacement: true,
      clientSeatReleasedAfterExit: true,
      targetBundleVersion: newArtifact.manifest.version,
      targetBuildId: newBuildId,
      oldBuildId,
      clientBuildChanged: newBuildId !== oldBuildId,
      hostInstanceId: hostABefore.instanceId,
      hostInstanceIdKept: true,
      hostPidKept: true,
      hostStarttimeKept: true,
      hostBuildIdKept: c1Auth.host.buildId === oldBuildId,
      sessionId,
      sessionOpen: true,
      sessionHistoryOpen: true,
      surfacePromptVisible: true,
      registryBytesUnchanged: true,
      launchBytesUnchanged: true,
      noNewSessionLog: true,
      promptNotReplayed: true,
      workStillRunning: true,
      exitCode: reexecExit.code,
      secretLeak: false,
    }

    // ── U07 negative 1: a wrong expected Host instance is refused pre-connect ─
    const registryBeforeRefusal = readFileSync(join(scopeDir, 'instance.json'))
    const launchBeforeRefusal = readFileSync(join(scopeDir, 'launch.json'))
    const sessionLogsBeforeRefusal = sessionLogFiles(dshHome)
    const wrongExpectation = new SurfaceEntryProcess(newClientEntry, {
      ...base,
      workDir: workRoot,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: randomUUID() },
    })
    clients.push(wrongExpectation)
    const wrongExpectationExit = await wrongExpectation.waitForExit(120_000)
    assert(wrongExpectationExit.code !== 0,
      `a wrong expected Host instance exited ${JSON.stringify(wrongExpectationExit)}`)
    assert(!wrongExpectation.records.some(record => record.m4a0 === 'ready'),
      'a wrong expected Host instance published ready')
    assert(!wrongExpectation.records.some(record => record.m4a0 === 'host-authenticated'),
      'a wrong expected Host instance authenticated the live Host')
    const wrongFailure = wrongExpectation.records.find(record => record.m4a0 === 'failure')
    assert(wrongFailure?.code === 'HOST_IDENTITY_MISMATCH',
      `the wrong expected Host instance failed as ${JSON.stringify(wrongFailure)}`)
    const wrongVisible = `${wrongExpectation.raw}\n${wrongExpectation.stderr}`
    const wrongFailureLines = wrongVisible.split('\n').filter(line => line.includes('Client handoff failed'))
    assertEqual(wrongFailureLines.length, 1, `the wrong expected Host produced ${String(wrongFailureLines.length)} handoff failure lines`)
    const wrongFailureLine = wrongFailureLines[0]
    assertMatch(wrongFailureLine, /Client handoff failed: the live local Host is not the expected instance\./u)
    assertMatch(wrongFailureLine, /The Host was not stopped or replaced\./u)
    assertMatch(wrongFailureLine, /Start a compatible Client manually to continue\./u)
    assertNoSecret('wrong expected Host terminal', wrongVisible, [oldToken, oldCookie])
    for (const privateValue of [scopeDir, sideBuildPackage, workRoot, String(hostABefore.hostPid)]) {
      assert(!wrongFailureLine.includes(privateValue), `the wrong expected Host failure leaked ${JSON.stringify(privateValue)}`)
    }
    assert(alive(hostAReady.pid), 'Host A died on the wrong expected Host refusal')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
      'Host A starttime changed on the wrong expected Host refusal')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore,
      'Host A after the wrong expected Host refusal')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the wrong expected Host refusal')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBeforeRefusal),
      'the wrong expected Host refusal mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBeforeRefusal),
      'the wrong expected Host refusal mutated the old launch material')
    assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeRefusal,
      'the wrong expected Host refusal created a new Session log')
    assert(await seatIsFree(clientSeatName), 'the wrong expected Host refusal did not release the Client seat')
    await wrongExpectation.dispose()
    evidence.reexecRefusals = {
      wrongExpectedHost: {
        exitCode: wrongExpectationExit.code,
        errorCode: wrongFailure.code,
        noReady: true,
        noHostConnect: true,
        hostKept: true,
        registryBytesUnchanged: true,
        launchBytesUnchanged: true,
        noNewSession: true,
        clientSeatReleased: true,
        noPathPidOrSecret: true,
      },
    }

    // ── U07 negative 2: the replacement child fails after a real reexec ─────
    // The one-shot fault injection exists only in the OLD Client's environment
    // and is passed to the CHILD, never applied to the old Client itself.
    const clientA2 = new SurfaceEntryProcess(join(oldProfilePackage, 'dist', 'local-client.mjs'), {
      ...base,
      workDir: workRoot,
      env: {
        ...base.env,
        SPLIT_PROCESS_CLIENT_SESSION: sessionId,
        SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
        SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath,
        SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: 'client-bootstrap',
      },
    })
    clients.push(clientA2)
    const clientA2Ready = await clientA2.waitFor(record => record.m4a0 === 'ready', 'second old Client ready', 240_000)
    const clientA2Pid = clientA2Ready.pid
    assert(Number.isInteger(clientA2Pid), 'the second old Client ready record has no business PID')
    await clientA2.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'the second old Client opened the existing Session',
      120_000,
    )
    const sessionLogsBeforeChildFailure = sessionLogFiles(dshHome)
    clientA2.signalBusiness('SIGUSR2')
    const reexecRequested2 = await clientA2.waitFor(
      record => record.m4r === 'handoff-requested' && record.pid === clientA2Pid,
      'the second old Client accepted the reexec request',
      120_000,
    )
    assertEqual(reexecRequested2.sessionId, sessionId)
    const clientClosed2 = await clientA2.waitFor(
      record => record.m4b2s === 'client-closed' && record.pid === clientA2Pid,
      'the second old Client released every owned Client resource',
      120_000,
    )
    assertEqual(clientClosed2.sessionOpen, false)
    assertDeepEqual(clientClosed2.owners, { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 })
    const childFailure = await clientA2.waitFor(
      record => record.m4a0 === 'failure' && record.pid !== clientA2Pid,
      'the replacement Client failed',
      180_000,
    )
    assertMatch(childFailure.error, /qualification forced client bootstrap failure/u)
    assert(!clientA2.records.some(record => record.m4a0 === 'ready' && record.pid !== clientA2Pid),
      'a failed replacement Client published ready')
    const parentExit = await clientA2.waitFor(
      record => record.m4r === 'handoff-parent-exit' && record.pid === clientA2Pid,
      'the old Client parent reported the replacement exit',
      120_000,
    )
    assertEqual(parentExit.code, 1, `the old Client parent reported ${JSON.stringify(parentExit)}`)
    assertEqual(parentExit.signal, null)
    const childFailureExit = await clientA2.waitForExit(120_000)
    assertEqual(childFailureExit.code, 1, `the failed handoff exit was ${JSON.stringify(childFailureExit)}`)
    assertEqual(childFailureExit.signal, null)
    assert(await waitGone(childFailure.pid), 'the failed replacement Client process stayed alive')
    assert(await waitGone(clientA2Pid), 'the old Client parent stayed alive after the failed child')
    assert(await seatIsFree(clientSeatName), 'the failed handoff did not release the Client seat')
    const childFailureVisible = `${clientA2.raw}\n${clientA2.stderr}`
    const childFailureLines = childFailureVisible.split('\n').filter(line => line.includes('Client handoff failed'))
    assertEqual(childFailureLines.length, 1, `the failed child produced ${String(childFailureLines.length)} handoff failure lines`)
    assertMatch(childFailureLines[0], /Client handoff failed: qualification forced client bootstrap failure\./u)
    assertMatch(childFailureLines[0], /Start a compatible Client manually to continue\./u)
    assertNoSecret('failed replacement terminal', childFailureVisible, [oldToken, oldCookie])
    assert(alive(hostAReady.pid), 'Host A died when the replacement Client failed')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
      'Host A starttime changed when the replacement Client failed')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore,
      'Host A after the failed replacement Client')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the failed replacement Client')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
      'the failed replacement Client mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
      'the failed replacement Client mutated the old launch material')
    assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeChildFailure,
      'the failed replacement Client created a new Session log')
    const promptsAfterChildFailure = (hostSessionEvents(dshHome, sessionId) ?? [])
      .filter(event => event.type === 'user/message'
        && event.data?.source?.kind === 'user'
        && JSON.stringify(event.data?.content ?? []).includes('c2d-upgrade-hold'))
    assertEqual(promptsAfterChildFailure.length, 1, 'the failed replacement Client replayed the admitted prompt')
    await clientA2.dispose()
    evidence.reexecRefusals.childFailure = {
      oldClientPid: clientA2Pid,
      failedChildPid: childFailure.pid,
      childFailureError: childFailure.error,
      oldClientOwnersReleased: true,
      parentExitCode: parentExit.code,
      processExitCode: childFailureExit.code,
      clientSeatReleased: true,
      hostKept: true,
      hostStarttimeKept: true,
      noHostRestart: true,
      registryBytesUnchanged: true,
      launchBytesUnchanged: true,
      noNewSession: true,
      noReplay: true,
      noAutoRecovery: true,
      secretLeak: false,
    }

    // ── U02: new Client B speaks v1 to the live old Host A ─────────────────

    // The new package has a different version, bundle and buildId but the same
    // local protocol and exact DSH runtime. It must authenticate the SAME Host
    // A, call the real official/private RPCs, and exit without touching Host
    // A, its Registry/Launch files or the admitted Turn.
    const clientB = new EntryProcess('client', newClientEntry, base)
    clients.push(clientB)
    const clientBAuth = await clientB.waitFor(
      record => record.m4a0 === 'host-authenticated',
      'new Client B authenticated Host A',
      180_000,
    )
    assertIdentityKept(clientBAuth.host, hostABefore, 'new Client B authenticated Host A')
    assert(clientBAuth.host.buildId === oldBuildId, 'new Client B authenticated a different Host build')
    const clientBReady = await clientB.waitFor(record => record.m4a0 === 'ready', 'new Client B ready', 240_000)
    assert(clientBReady.transport === 'connected', `new Client B transport was ${JSON.stringify(clientBReady.transport)}`)
    assert(clientBReady.host?.instanceId === hostABefore.instanceId, 'new Client B ready record names another Host')
    const crossBuildRpcRequestId = 'pr2-cross-build-rpc'
    clientB.send({ op: 'qualification-host-foundation', requestId: crossBuildRpcRequestId })
    const crossBuildRpc = await clientB.waitFor(
      record => record.m4b2hf === 'host-rpc-proof' && record.requestId === crossBuildRpcRequestId,
      'new Client B cross-build Host RPC proof',
      180_000,
    )
    assert(crossBuildRpc.hostPid === hostABefore.hostPid, 'cross-build RPC proof names another Host PID')
    assert(crossBuildRpc.hostInstanceId === hostABefore.instanceId, 'cross-build RPC proof names another Host instance')
    assert(crossBuildRpc.clientPid === clientBReady.pid, 'cross-build RPC proof names another Client PID')
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      assert(crossBuildRpc[field] === true, `cross-build RPC proof ${field} is not true`)
    }
    assert(alive(hostAReady.pid), 'Host A died while the new Client was connected')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
      'Host A starttime changed while the new Client was connected')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after new Client B')
    const crossBuildLiveness = (await hostStatus(hostA)).liveness
    assert(crossBuildLiveness?.verdict === 'BLOCKED',
      `Host A liveness was ${JSON.stringify(crossBuildLiveness?.verdict)} during the admitted Turn`)
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released while the new Client was connected')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'new Client B mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'new Client B mutated the old launch material')
    const clientBExit = await clientB.shutdown()
    assert(clientBExit.code === 0 && clientBExit.signal === null, `new Client B exit was ${JSON.stringify(clientBExit)}`)
    assert(!clientB.records.some(record => record.m4a0 === 'cleanup-failure'), 'new Client B reported a cleanup failure')
    assert(await seatIsFree(`\0dsh-pi-tui-c-${hostABefore.scopeId.slice(0, 40)}`), 'new Client B did not release the Client seat')
    assert(alive(hostAReady.pid), 'Host A died when the new Client exited')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after new Client B exit')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'new Client B exit mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'new Client B exit mutated the old launch material')
    assertNoSecret('cross-build Client records', JSON.stringify(clientB.records), [oldToken, oldCookie])
    assertNoSecret('cross-build Client stderr', clientB.stderr, [oldToken, oldCookie])
    evidence.crossBuildClient = {
      clientPid: clientBReady.pid,
      hostPid: hostABefore.hostPid,
      hostStarttimeKept: true,
      hostInstanceIdKept: true,
      hostBuildIdKept: hostABefore.buildId === oldBuildId,
      clientBundleDifferent: newArtifact.manifest.version !== oldArtifact.manifest.version,
      clientBuildIdDifferent: newBuildId !== oldBuildId,
      protocol: 'dsh-pi-tui/local/1',
      dshVersion: targetDshVersion,
      transport: 'connected',
      rpcRequestId: crossBuildRpcRequestId,
      officialSessionList: true,
      privateFileRpc: true,
      terminalSnapshot: true,
      cleaned: true,
      registryBytesUnchanged: true,
      registrySha256: registryBeforeSha256,
      launchBytesUnchanged: true,
      launchSha256: launchBeforeSha256,
      hostAlive: true,
      clientSeatReleased: true,
      workStillRunning: true,
      livenessVerdict: crossBuildLiveness.verdict,
      secretLeak: false,
    }
    evidence.hostA = {
      pid: hostABefore.hostPid,
      starttime: hostABefore.hostStarttime,
      instanceId: hostABefore.instanceId,
      buildId: hostABefore.buildId,
      scopeId: hostABefore.scopeId,
    }

    // ── U04: the new build's REAL surface opens the running old Session ─────
    // The qualification Client above proves the RPC path; this is the real PTY
    // surface. It must open the SAME Session whose Turn is currently held,
    // paint its admitted prompt, and exit without releasing the Turn or
    // changing Host A's identity/files.
    const crossBuildSurface = new SurfaceEntryProcess(newClientEntry, {
      ...base,
      workDir: workRoot,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionId },
    })
    clients.push(crossBuildSurface)
    const crossBuildSurfaceReady = await crossBuildSurface.waitFor(
      record => record.m4a0 === 'ready',
      'cross-build surface ready',
      240_000,
    )
    assert(crossBuildSurfaceReady.transport === 'connected',
      `cross-build surface transport was ${JSON.stringify(crossBuildSurfaceReady.transport)}`)
    const crossBuildSurfaceStatus = await crossBuildSurface.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'cross-build surface opened the running old Session',
      180_000,
    )
    assert(crossBuildSurfaceStatus.openSessionId === sessionId, 'cross-build surface opened another Session')
    await crossBuildSurface.waitForScreen('c2d-upgrade-hold', 'cross-build surface painted the admitted prompt', 120_000)
    assert(alive(hostAReady.pid), 'Host A died while the cross-build surface was attached')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
      'Host A starttime changed while the cross-build surface was attached')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A while the cross-build surface is attached')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the cross-build surface attach')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'cross-build surface mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'cross-build surface mutated the old launch material')
    const crossBuildSurfaceExit = await (async () => {
      crossBuildSurface.send('/exit\r')
      return await crossBuildSurface.waitForExit(60_000)
    })()
    assert(crossBuildSurfaceExit.code === 0 && crossBuildSurfaceExit.signal === null,
      `cross-build surface exit was ${JSON.stringify(crossBuildSurfaceExit)}`)
    await crossBuildSurface.dispose()
    assert(alive(hostAReady.pid), 'Host A died when the cross-build surface exited')
    assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
      'Host A starttime changed after the cross-build surface exit')
    assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after cross-build surface exit')
    assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the cross-build surface exit')
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'cross-build surface exit mutated the old registry')
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'cross-build surface exit mutated the old launch material')
    assertNoSecret('cross-build surface records', JSON.stringify(crossBuildSurface.records), [oldToken, oldCookie])
    assertNoSecret('cross-build surface stderr', crossBuildSurface.stderr, [oldToken, oldCookie])
    evidence.crossBuildSurface = {
      clientPid: crossBuildSurfaceReady.pid,
      sessionId,
      sessionOpen: true,
      openSessionIdKept: true,
      promptVisible: true,
      transport: 'connected',
      hostPidKept: true,
      hostStarttimeKept: true,
      hostInstanceIdKept: true,
      registryBytesUnchanged: true,
      registrySha256: registryBeforeSha256,
      launchBytesUnchanged: true,
      launchSha256: launchBeforeSha256,
      hostAlive: true,
      workStillRunning: true,
      secretLeak: false,
    }

    // ── The admitted work completes normally after both cross-build attaches ─
    // The barrier only controls the test's stream timing; releasing it proves
    // the old Host was never stopped or replaced by either new-Client attempt.
    writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
    const released = await waitForC1WorkEvent(
      workRootPath,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
      'Host A Turn completes after the cross-build attaches',
    )
    assert(released.sessionId === sessionId, 'Host A Turn completion names another Session')
    await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'Host A turn/end after the cross-build attaches')
    const durableEvents = hostSessionEvents(dshHome, sessionId) ?? []
    assert(durableEvents.some(event => event.type === 'user/message' && JSON.stringify(event).includes('c2d-upgrade-hold')),
      'the durable Session lost the admitted prompt')
    evidence.work.completedAfterCrossBuild = true

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
    // Replacing the bundle must not prune the Client peer from the same
    // profile owner.
    assertProfileClientPeers(profileDir, targetDshVersion, 'upgraded profile install')
    evidence.clientPeers.upgradedProfileOwnsPeers = true
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
    evidence.verdict = 'cross-build-compatible'
    evidence.compatibility = {
      protocol: 'dsh-pi-tui/local/1',
      dshVersion: targetDshVersion,
      oldBuildId,
      newBuildId,
      differentBundleVersions: oldArtifact.manifest.version !== newArtifact.manifest.version,
      differentBuildIds: oldBuildId !== newBuildId,
      sameProtocol: true,
      sameDshRuntime: true,
    }
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    process.stdout.write('SPLIT_UPGRADE_SMOKE_PASS (cross-build-compatible)\n')
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
