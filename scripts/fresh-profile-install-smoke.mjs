#!/usr/bin/env node
/**
 * Fresh single-TUI-package installation gate.
 *
 * This is the SECOND, different distribution proof next to the existing Split
 * smoke: the Split lane starts from a Profile that already declares the three
 * Client platform packages (`legacy-preseed`); this gate creates a brand-new
 * isolated Profile that installs the candidate ONCE (`bundled` provisioning)
 * and proves the TUI package's Client Shell already carries the official
 * Store/Zustand/Immer closure.
 *
 * It accepts an ABSOLUTE candidate tarball path (or exactly one tarball in the
 * package root) and an explicit DSH runtime pin (rc.3/rc.4/rc.5, default rc.5),
 * installs the real npm DSH family into an isolated harness, and drives the
 * PUBLIC `dsh --profile pi-tui` Direct and `DSH_PI_TUI_BACKEND=daemon` entries
 * through real PTYs. The internal surface records are used only as structured
 * evidence for the official Client Domains readiness; the public painted
 * frames and process lifecycle remain the user-visible authority.
 *
 * PR1 qualification mode: the isolated test-owned Profile records
 * `allowBuilds.koffi: false` before the first install (the same explicit
 * decision the repository root records). The report says
 * `controlledKoffi: "YES"`; PR2 owns the pristine no-preset release gate.
 *
 * Usage:
 *   node scripts/fresh-profile-install-smoke.mjs <absolute-candidate.tgz> [--dsh <0.2.2-rc.X>]
 *   pnpm smoke:fresh-profile -- [candidate.tgz] [--dsh <0.2.2-rc.X>]
 *
 * @module @xmoon76/dsh-pi-tui/scripts/fresh-profile-install-smoke
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  dshInvocation,
  installPlugin,
  readJson,
  readCandidatePackageData,
  redact,
  resultText,
  runDsh,
  sha256,
  tmuxRunner,
} from './lib/dsh-smoke-harness.mjs'
import { assertInstalledDshFamily, PACKAGE_ROOT } from './lib/dsh-distribution.mjs'
import { createSplitSmokeProfile } from './lib/split-smoke-profile.mjs'
import { createSplitProcessScope, readStartIdentity } from './lib/split-smoke-processes.mjs'
import { selectCandidate } from './qualify-tarball.mjs'

const EXPECTED_NAME = '@xmoon76/dsh-pi-tui'
const DEFAULT_DSH_TARGET = '0.2.2-rc.5'
const SUPPORTED_DSH_TARGETS = new Set(['0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5'])
const STORE_PACKAGES = ['@deepseek-ai/dsh-client-store', 'zustand', 'immer']
const KEEP = process.env.FRESH_PROFILE_KEEP === '1'
const REPORT_PATH = process.env.FRESH_PROFILE_REPORT
const FAILPOINT = process.env.FRESH_PROFILE_FAILPOINT ?? ''

export class FreshProfileGateError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FreshProfileGateError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details = {}) {
  throw new FreshProfileGateError(code, message, details)
}

function assert(condition, message, code = 'ASSERTION_FAILED') {
  if (!condition) fail(code, message)
}

function failpoint(name) {
  if (FAILPOINT === name) fail('TEST_FAILPOINT', `fresh-profile test failpoint: ${name}`)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Parse the candidate and explicit runtime pin. */
export function parseFreshProfileArgs(args) {
  const positionals = []
  let dshTarget = DEFAULT_DSH_TARGET
  let upgradeOld
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--') continue
    if (value === '--dsh') {
      const next = args[index + 1]
      if (next === undefined || next === '') fail('INPUT_UNQUALIFIED', '--dsh requires an exact DSH version')
      dshTarget = next
      index += 1
      continue
    }
    if (value === '--upgrade-old') {
      const next = args[index + 1]
      if (next === undefined || next === '') fail('INPUT_UNQUALIFIED', '--upgrade-old requires the published 0.5.7 tarball path')
      upgradeOld = next
      index += 1
      continue
    }
    if (value.startsWith('--')) fail('INPUT_UNQUALIFIED', `unknown option: ${value}`)
    positionals.push(value)
  }
  if (positionals.length > 1) fail('INPUT_UNQUALIFIED', `expected at most one candidate tarball, got ${positionals.length}`)
  assert(SUPPORTED_DSH_TARGETS.has(dshTarget), `unsupported DSH target ${dshTarget}; expected one of ${[...SUPPORTED_DSH_TARGETS].join(', ')}`, 'INPUT_UNQUALIFIED')
  return { candidate: positionals[0], dshTarget, upgradeOld }
}

export function resolveFreshCandidate(explicit) {
  if (explicit !== undefined && !isAbsolute(explicit)) {
    fail('INPUT_UNQUALIFIED', `the fresh-profile candidate must be an absolute path: ${explicit}`)
  }
  const selected = selectCandidate(PACKAGE_ROOT, explicit)
  const manifest = readCandidatePackageData(selected)
  assert(manifest.name === EXPECTED_NAME, `candidate name is ${String(manifest.name)}, expected ${EXPECTED_NAME}`, 'INPUT_UNQUALIFIED')
  const sourceVersion = readJson(join(PACKAGE_ROOT, 'package.json'), 'source package.json').version
  assert(manifest.version === sourceVersion, `candidate version is ${String(manifest.version)}, expected ${sourceVersion}`, 'INPUT_UNQUALIFIED')
  return { path: selected, sha256: sha256(selected), manifest }
}

function isInside(dir, root) {
  const rel = relative(root, dir)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function hasAncestorNodeModules(directory) {
  let current = realpathSync(directory)
  while (true) {
    if (existsSync(join(current, 'node_modules'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function resolveOldCandidate(explicit) {
  if (explicit === undefined || !isAbsolute(explicit)) {
    fail('INPUT_UNQUALIFIED', 'the --upgrade-old artifact must be an absolute path')
  }
  const selected = selectCandidate(PACKAGE_ROOT, explicit)
  const manifest = readCandidatePackageData(selected)
  assert(manifest.name === EXPECTED_NAME && manifest.version === '0.5.7',
    `the upgrade-old artifact is ${String(manifest.name)}@${String(manifest.version)}, expected ${EXPECTED_NAME}@0.5.7`,
    'INPUT_UNQUALIFIED')
  return { path: selected, sha256: sha256(selected), manifest }
}

export function assertIsolatedWorkRoot(workRoot, checkoutRoot = PACKAGE_ROOT) {
  assert(existsSync(workRoot), `fresh-profile work root does not exist: ${workRoot}`, 'INFRA_ISOLATION_FAILURE')
  const realWork = realpathSync(workRoot)
  assert(!isInside(realWork, realpathSync(checkoutRoot)), `fresh-profile work root is inside the checkout: ${realWork}`, 'INFRA_ISOLATION_FAILURE')
  const polluted = hasAncestorNodeModules(realWork)
  assert(polluted === undefined, `fresh-profile work root has an ancestor node_modules: ${polluted}`, 'INFRA_ISOLATION_FAILURE')
  return realWork
}

export function createFreshWorkRoot(checkoutRoot = PACKAGE_ROOT) {
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-fresh-profile-'))
  assertIsolatedWorkRoot(workRoot, checkoutRoot)
  return workRoot
}

function writeLauncher(workDir, invocation, env, exitPath, extraEnv = {}) {
  const lines = [
    '#!/bin/sh',
    'set -u',
    `export HOME=${shellQuote(env.HOME)}`,
    `export DSH_HOME=${shellQuote(env.DSH_HOME)}`,
    `export npm_config_registry=${shellQuote(env.npm_config_registry)}`,
    `export NPM_CONFIG_REGISTRY=${shellQuote(env.NPM_CONFIG_REGISTRY)}`,
    `export npm_config_minimum_release_age=${shellQuote(env.npm_config_minimum_release_age)}`,
    `export pnpm_config_minimum_release_age=${shellQuote(env.pnpm_config_minimum_release_age)}`,
    `export npm_config_userconfig=${shellQuote(env.npm_config_userconfig)}`,
    `export NPM_CONFIG_USERCONFIG=${shellQuote(env.NPM_CONFIG_USERCONFIG)}`,
    ...Object.entries(extraEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    'export TERM="${TERM:-xterm-256color}"',
    `${shellQuote(invocation[0])} ${shellQuote(invocation[1])} --profile pi-tui`,
    '__status=$?',
    `printf '%s' "$__status" > ${shellQuote(exitPath)}`,
    'exit $__status',
    '',
  ]
  const path = join(workDir, `launcher-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(path, lines.join('\n'), { mode: 0o700 })
  return path
}

async function waitFor(predicate, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await sleep(150)
  }
  fail('WAIT_TIMEOUT', `${label} timed out after ${timeoutMs}ms`)
}

function processFacts(profileDir, dshHome) {
  const all = []
  if (process.platform === 'linux' && existsSync('/proc')) {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue
      try {
        const command = readFileSync(`/proc/${name}/cmdline`, 'utf8')
        const environ = readFileSync(`/proc/${name}/environ`, 'utf8')
        if (!environ.split('\0').includes(`DSH_HOME=${dshHome}`)) continue
        if (!command.includes('local-host.mjs') && !command.includes('local-client.mjs')) continue
        all.push({ pid: Number(name), command })
      } catch {
        // The process disappeared while it was enumerated.
      }
    }
  } else {
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    if (ps.status === 0) {
      for (const line of ps.stdout.split('\n')) {
        if (!line.includes(profileDir)) continue
        all.push({ pid: Number(line.trim().split(/\s+/u)[0]), command: line })
      }
    }
  }
  const host = all.filter(entry => entry.command.includes('local-host.mjs'))
  const client = all.filter(entry => entry.command.includes('local-client.mjs'))
  return { host, client, dshHome }
}

async function runPaintedSurface({ workDir, profileDir, harnessDir, env, label, extraEnv = {} }) {
  const invocation = dshInvocation(harnessDir)
  const exitPath = join(workDir, `${label}-exit.txt`)
  const launcher = writeLauncher(workDir, invocation, env, exitPath, extraEnv)
  const socket = `fresh-${label}-${process.pid}-${Date.now().toString(36)}`
  const tmux = tmuxRunner(socket, label, { ...env, ...extraEnv, TERM: 'xterm-256color' })
  let frame = ''
  try {
    const started = tmux.tmux(['new-session', '-d', '-s', label, '-x', '120', '-y', '40', launcher], { timeout: 20_000 })
    if (started.status !== 0) fail('SURFACE_BOOT_FAILURE', `${label}: tmux failed to start: ${resultText(started)}`)
    let sawFrame = false
    await waitFor(() => {
      frame = tmux.capturePane()
      if (/[╭╮╰╯]/u.test(frame) && /type a message|New session|DeepSeek/u.test(frame)) { sawFrame = true; return true }
      return !tmux.hasSession()
    }, `${label} painted frame`, 180_000)
    assert(sawFrame, `${label}: no painted TUI frame; tail=${frame.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-800)}`, 'SURFACE_BOOT_FAILURE')
    return { tmux, exitPath }
  } catch (error) {
    tmux.stop()
    throw error
  }
}

async function finishPaintedSurface({ tmux, exitPath, label }) {
  try {
    tmux.sendLiteral('/exit')
    tmux.sendKey('Enter')
    await waitFor(() => !tmux.hasSession(), `${label} exit`, 90_000)
    const status = Number(readFileSync(exitPath, 'utf8'))
    assert(status === 0, `${label}: exited ${String(status)}`, 'SURFACE_EXIT_FAILURE')
    return status
  } finally {
    tmux.stop()
  }
}

const STORE_PROBE_SOURCE = `
import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'
const resultPath = process.env.FRESH_PROFILE_STORE_PROBE
const tracked = new Set(['@deepseek-ai/dsh-client-store', 'zustand', 'immer'])
const state = { storeRequests: 0, storeInjected: false, storeIdentityStable: true, firstStore: null, resolutions: [] }
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (tracked.has(specifier) || specifier.startsWith('@deepseek-ai/dsh-')) {
      state.resolutions.push({ specifier, url: result.url })
    }
    return result
  },
})
function writeResult() {
  if (typeof resultPath === 'string' && resultPath !== '') {
    writeFileSync(resultPath, JSON.stringify(state, null, 2) + '\\n', { mode: 0o600 })
  }
}
const originalDefineProperty = Object.defineProperty
Object.defineProperty = function (target, property, descriptor) {
  if (target === globalThis && property === 'window' && descriptor?.value !== null && typeof descriptor?.value === 'object') {
    const loader = descriptor.value.__ModuleLoader__
    if (loader !== null && typeof loader === 'object' && typeof loader.load === 'function') {
      const originalLoad = loader.load
      descriptor = {
        ...descriptor,
        value: {
          ...descriptor.value,
          __ModuleLoader__: {
            load: registration => originalLoad({
              ...registration,
              factory: requireModule => registration.factory(specifier => {
                const value = requireModule(specifier)
                if (specifier === '@deepseek-ai/dsh-client-store') {
                  state.storeRequests += 1
                  state.storeInjected = true
                  if (state.firstStore === null) state.firstStore = value
                  else if (value !== state.firstStore) state.storeIdentityStable = false
                  writeResult()
                }
                return value
              }),
            }),
          },
        },
      }
    }
  }
  return originalDefineProperty.call(Object, target, property, descriptor)
}
process.on('exit', writeResult)
`

function writeStoreProbe(workDir) {
  const path = join(workDir, 'store-identity-probe.mjs')
  writeFileSync(path, STORE_PROBE_SOURCE.trimStart(), { mode: 0o600 })
  return path
}

export function assertOrdinaryDependencies(profilePackage) {
  const requireFrom = createRequire(join(profilePackage, 'package.json'))
  for (const name of ['ws', 'zod', 'yaml']) {
    try {
      requireFrom.resolve(name)
    } catch (error) {
      fail('PROFILE_DEPENDENCY_MISSING', `the installed TUI package cannot resolve ordinary dependency ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function assertBundledClientChunk(profilePackage) {
  const manifest = readJson(join(profilePackage, 'package.json'), 'installed TUI package.json')
  for (const name of STORE_PACKAGES) {
    assert(manifest.dependencies?.[name] === undefined, `the installed TUI package declares runtime dependency ${name}`, 'BUNDLED_CLOSURE_INVALID')
    assert(manifest.peerDependencies?.[name] === undefined, `the installed TUI package declares runtime peer ${name}`, 'BUNDLED_CLOSURE_INVALID')
  }
  const distDir = join(profilePackage, 'dist')
  const files = readdirSync(distDir).filter(name => name.endsWith('.mjs'))
  let storeChunk
  for (const file of files) {
    const text = readFileSync(join(distDir, file), 'utf8')
    if (text.includes('createSnapshotStore') && text.includes('defineStore')) {
      assert(storeChunk === undefined, `the Store implementation lives in more than one chunk: ${storeChunk}, ${file}`, 'BUNDLED_CLOSURE_INVALID')
      storeChunk = file
    }
    const external = [...text.matchAll(/(?:from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["'])/gu)]
      .map(match => match[1] ?? match[2] ?? match[3])
      .filter(specifier => STORE_PACKAGES.some(name => specifier === name || specifier.startsWith(`${name}/`)))
    assert(external.length === 0, `${file} still has an external Store/Zustand/Immer import: ${external.join(', ')}`, 'BUNDLED_CLOSURE_INVALID')
  }
  assert(storeChunk !== undefined, 'no packed Client chunk carries the bundled Store implementation', 'BUNDLED_CLOSURE_INVALID')
  return { storeChunk, files: files.length }
}

function assertProfileRoot(profileDir, expectedDependencies = [EXPECTED_NAME]) {
  const manifest = readJson(join(profileDir, 'package.json'), 'profile package.json')
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort()
  const expected = [...expectedDependencies].sort()
  assert(JSON.stringify(dependencies) === JSON.stringify(expected),
    `the fresh profile root dependencies are ${JSON.stringify(dependencies)}, expected ${JSON.stringify(expected)}`, 'PROFILE_MANIFEST_INVALID')
  if (expectedDependencies.length === 1) {
    for (const name of STORE_PACKAGES) {
      assert(!existsSync(join(profileDir, 'node_modules', ...name.split('/'))), `the fresh profile installs ${name}`, 'PROFILE_MANIFEST_INVALID')
    }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  assert(bundles.includes(EXPECTED_NAME), 'the TUI bundle row is missing from the fresh profile', 'PROFILE_MANIFEST_INVALID')
  return { dependencies, bundles }
}

async function internalDomainEvidence({ workDir, profileDir, harnessDir, profilePackage, env }) {
  const probePath = writeStoreProbe(workDir)
  const probeResult = join(workDir, 'store-identity-probe.json')
  const scope = createSplitProcessScope()
  const anchor = join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const client = new scope.SurfaceEntryProcess(join(profilePackage, 'dist', 'local-client.mjs'), {
    cwd: profileDir,
    env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(probePath).href}`, FRESH_PROFILE_STORE_PROBE: probeResult },
    anchor,
    profile: 'pi-tui',
    scratch: join(workDir, 'domain-scratch'),
    workDir,
  })
  try {
    await client.waitFor(record => record.m4a0 === 'host-authenticated', 'Client authenticated the Daemon Host', 180_000)
    await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'startup-stage' && record.stage === 'domains-ready', 'official Client Domains ready', 180_000)
    await client.waitFor(record => record.m4a0 === 'ready' && record.surfaceMounted === true, 'TUI Surface mounted', 180_000)
    const recordIndex = predicate => client.records.findIndex(predicate)
    const authenticatedIndex = recordIndex(record => record.m4a0 === 'host-authenticated')
    const domainsIndex = recordIndex(record => record.m4b2s === 'qualification' && record.op === 'startup-stage' && record.stage === 'domains-ready')
    const surfaceIndex = recordIndex(record => record.m4a0 === 'ready' && record.surfaceMounted === true)
    assert(authenticatedIndex >= 0 && domainsIndex > authenticatedIndex && surfaceIndex > domainsIndex,
      `the Client load order is not authenticated -> domains-ready -> surface-ready: ${JSON.stringify([authenticatedIndex, domainsIndex, surfaceIndex])}`,
      'DAEMON_LOAD_ORDER_FAILURE')
    const order = ['host-authenticated', 'domains-ready', 'surface-ready']
    client.send('/exit\r')
    const exit = await client.waitForExit(120_000)
    assert(exit.code === 0, `the structured Domain Client exited ${JSON.stringify(exit)}`, 'DAEMON_CLIENT_EXIT_FAILURE')
    const probe = existsSync(probeResult) ? readJson(probeResult, 'store identity probe') : undefined
    assert(probe?.storeInjected === true, 'no official /client bundle requested the platform store', 'STORE_IDENTITY_MISSING')
    assert(probe?.storeIdentityStable === true, 'the platform store was not ONE stable namespace', 'STORE_DUPLICATE_INSTANCE')
    const externalStore = (probe?.resolutions ?? []).filter(entry => STORE_PACKAGES.some(name => entry.specifier === name || entry.specifier.startsWith(`${name}/`)))
    assert(externalStore.length === 0, `the Client resolved Store closure externally: ${externalStore.map(entry => entry.specifier).join(', ')}`, 'STORE_ROOT_OUTSIDE_PROFILE')
    return {
      loadOrder: order,
      storeRequests: probe.storeRequests,
      storeIdentityStable: true,
      externalStoreResolutions: 0,
    }
  } finally {
    if (!client.exited) await client.dispose()
    if (scope.darwinScope !== undefined && process.platform === 'darwin') {
      try { await scope.darwinScope.stopServer() } catch { /* best effort */ }
    }
  }
}

function processStartIdentity(pid) {
  const linux = readStartIdentity(pid)
  if (linux !== undefined) return linux
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  if (ps.status !== 0) return undefined
  const text = ps.stdout.trim()
  return text === '' ? undefined : text
}

export function assertSingleHost(facts, expectedIdentity, label, identityOf = processStartIdentity) {
  assert(facts.host.length === 1, `${label}: expected exactly one Daemon Host, saw ${facts.host.length}`, 'DAEMON_HOST_IDENTITY_FAILURE')
  const current = { pid: facts.host[0].pid, start: identityOf(facts.host[0].pid) }
  assert(Number.isInteger(current.pid) && current.start !== undefined, `${label}: the Daemon Host has no stable start identity`, 'DAEMON_HOST_IDENTITY_FAILURE')
  if (expectedIdentity !== undefined) {
    assert(current.pid === expectedIdentity.pid && current.start === expectedIdentity.start,
      `${label}: the Daemon Host was replaced (${JSON.stringify(expectedIdentity)} -> ${JSON.stringify(current)})`, 'DAEMON_HOST_IDENTITY_FAILURE')
  }
  return current
}

async function quiesceDaemon({ dsh, profile, daemon }) {
  try { daemon?.tmux.stop() } catch { /* already gone */ }
  try {
    runDsh(dsh, ['--profile', 'pi-tui', 'daemon', 'stop'], profile.profileDir, profile.env, 30_000)
  } catch { /* the explicit process cleanup below is the backstop */ }
  const gone = async () => {
    const facts = processFacts(profile.profileDir, profile.dshHome)
    return facts.host.length === 0 && facts.client.length === 0
  }
  try {
    await waitFor(gone, 'fresh-profile Daemon cleanup', 30_000)
    return
  } catch { /* SIGTERM the owned processes below */ }
  let facts = processFacts(profile.profileDir, profile.dshHome)
  for (const entry of [...facts.host, ...facts.client]) {
    try { process.kill(entry.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  await sleep(1_000)
  facts = processFacts(profile.profileDir, profile.dshHome)
  for (const entry of [...facts.host, ...facts.client]) {
    try { process.kill(entry.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  await sleep(250)
  await waitFor(gone, 'fresh-profile Daemon cleanup after SIGKILL', 5_000)
}

function daemonStatus(dsh, profileDir, env) {
  const result = runDsh(dsh, ['--profile', 'pi-tui', 'daemon', 'status'], profileDir, env, 120_000)
  const fields = {}
  for (const line of `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0 && !line.includes(' ') && /^[a-z-]+=/u.test(line)) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  return { status: result.status, fields }
}

async function runLiveEvidence({ profile, profileRoot, bundled, workDir }) {
  const dsh = dshInvocation(profile.harnessDir)
  const direct = await runPaintedSurface({
    workDir,
    profileDir: profile.profileDir,
    harnessDir: profile.harnessDir,
    env: profile.env,
    label: 'direct',
  })
  const directExit = await finishPaintedSurface({ ...direct, label: 'direct' })

  let daemon
  try {
    daemon = await runPaintedSurface({
      workDir,
      profileDir: profile.profileDir,
      harnessDir: profile.harnessDir,
      env: profile.env,
      label: 'daemon',
      extraEnv: { DSH_PI_TUI_BACKEND: 'daemon' },
    })
  } catch (error) {
    await quiesceDaemon({ dsh, profile })
    throw error
  }
  let normalCompletion = false
  try {
    await waitFor(() => processFacts(profile.profileDir, profile.dshHome).client.length === 1, 'public Daemon Client process', 180_000)
    const status = daemonStatus(dsh, profile.profileDir, profile.env)
    assert(status.status === 0 && status.fields.host === 'ready', `daemon status did not report an authenticated Host: ${JSON.stringify(status.fields)}`, 'DAEMON_HOST_FAILURE')
    const beforeExit = processFacts(profile.profileDir, profile.dshHome)
    const hostIdentity = assertSingleHost(beforeExit, undefined, 'before Client exit')
    assert(beforeExit.client.length === 1, `expected one Daemon Client process, saw ${beforeExit.client.length}`, 'DAEMON_CLIENT_FAILURE')
    failpoint('after-daemon-start')
    await finishPaintedSurface({ ...daemon, label: 'daemon' })
    await waitFor(() => processFacts(profile.profileDir, profile.dshHome).client.length === 0, 'public Daemon Client exit', 90_000)
    assertSingleHost(processFacts(profile.profileDir, profile.dshHome), hostIdentity, 'after Client exit')
    failpoint('after-client-exit')

    const domains = await internalDomainEvidence({
      workDir,
      profileDir: profile.profileDir,
      harnessDir: profile.harnessDir,
      profilePackage: profile.profilePackage,
      env: profile.env,
    })
    assertSingleHost(processFacts(profile.profileDir, profile.dshHome), hostIdentity, 'after domain evidence')

    const stop = runDsh(dsh, ['--profile', 'pi-tui', 'daemon', 'stop'], profile.profileDir, profile.env, 120_000)
    await waitFor(() => processFacts(profile.profileDir, profile.dshHome).host.length === 0, 'Daemon Host stop', 90_000)
    normalCompletion = true
    return {
      profileRoot,
      bundled,
      direct: { painted: true, exitCode: directExit },
      daemon: {
        painted: true,
        hostReady: status.fields.host === 'ready',
        oneClient: beforeExit.client.length === 1,
        hostIdentity,
        clientExited: true,
        hostPreserved: true,
        hostStopped: true,
        stopCommandStatus: stop.status,
        ...domains,
      },
    }
  } finally {
    if (!normalCompletion) await quiesceDaemon({ dsh, profile, daemon })
  }
}

async function runScenario({ candidate, dshTarget, workDir }) {
  mkdirSync(workDir, { recursive: true })
  const profile = createSplitSmokeProfile({
    tarball: candidate.path,
    targetDshVersion: dshTarget,
    workDir,
    clientPlatformProvisioning: 'bundled',
  })
  assertInstalledDshFamily(profile.harnessDir, dshTarget)
  assertOrdinaryDependencies(profile.profilePackage)
  const profileRoot = assertProfileRoot(profile.profileDir)
  const bundled = assertBundledClientChunk(profile.profilePackage)
  return runLiveEvidence({ profile, profileRoot, bundled, workDir })
}

/**
 * P5 upgrade evidence: a published 0.5.7 profile with no manual peers (F1)
 * and with the old three-peer workaround (F2) both upgrade in place to the
 * candidate and still start the same bundled Client. The old 0.5.7 artifact is
 * an explicitly supplied test input; this mode is not part of every CI row.
 */
async function runUpgradeScenario({ oldCandidate, candidate, workDir, withOldPeers }) {
  mkdirSync(workDir, { recursive: true })
  const profile = createSplitSmokeProfile({
    tarball: oldCandidate.path,
    targetDshVersion: DEFAULT_DSH_TARGET,
    workDir,
    clientPlatformProvisioning: withOldPeers ? 'legacy-preseed' : 'bundled',
  })
  installPlugin(profile.dshInvocation, candidate.path, profile.harnessDir, profile.env, false)
  assertInstalledDshFamily(profile.harnessDir, DEFAULT_DSH_TARGET)
  assertOrdinaryDependencies(profile.profilePackage)
  const expectedDependencies = withOldPeers
    ? [EXPECTED_NAME, ...STORE_PACKAGES]
    : [EXPECTED_NAME]
  const profileRoot = assertProfileRoot(profile.profileDir, expectedDependencies)
  const installed = readJson(join(profile.profilePackage, 'package.json'), 'upgraded TUI package.json')
  assert(installed.version === candidate.manifest.version,
    `the upgraded profile carries ${String(installed.version)}, expected ${candidate.manifest.version}`, 'UPGRADE_FAILED')
  const bundled = assertBundledClientChunk(profile.profilePackage)
  return {
    oldTui: `${oldCandidate.manifest.name}@${oldCandidate.manifest.version}`,
    oldPeers: withOldPeers,
    ...(await runLiveEvidence({ profile, profileRoot, bundled, workDir })),
  }
}

function writeReport(report, workRoot) {
  const text = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(join(workRoot, 'fresh-profile-report.json'), text, { mode: 0o600 })
  if (REPORT_PATH !== undefined && REPORT_PATH !== '') {
    mkdirSync(dirname(resolve(REPORT_PATH)), { recursive: true })
    writeFileSync(resolve(REPORT_PATH), text, { mode: 0o600 })
  }
  process.stderr.write(text)
}

async function main() {
  const cli = parseFreshProfileArgs(process.argv.slice(2))
  const candidate = resolveFreshCandidate(cli.candidate)
  const oldCandidate = cli.upgradeOld === undefined ? undefined : resolveOldCandidate(cli.upgradeOld)
  const workRoot = createFreshWorkRoot()
  const report = {
    schema: 1,
    gate: 'fresh-profile-install',
    qualification: oldCandidate === undefined ? 'FRESH_BUNDLED_PASS' : 'FRESH_BUNDLED_PASS_WITH_UPGRADE',
    status: 'RUNNING',
    controlledKoffi: 'YES',
    candidate: { path: candidate.path, sha256: candidate.sha256, name: candidate.manifest.name, version: candidate.manifest.version },
    dshTarget: cli.dshTarget,
    node: process.versions.node,
    scenarios: {},
  }
  try {
    report.scenarios.F0 = await runScenario({ candidate, dshTarget: cli.dshTarget, workDir: join(workRoot, 'F0') })
    if (oldCandidate !== undefined) {
      report.scenarios.F1 = await runUpgradeScenario({ oldCandidate, candidate, workDir: join(workRoot, 'F1'), withOldPeers: false })
      report.scenarios.F2 = await runUpgradeScenario({ oldCandidate, candidate, workDir: join(workRoot, 'F2'), withOldPeers: true })
    }
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'
    report.error = {
      code: error instanceof FreshProfileGateError ? error.code : 'ASSERTION_FAILED',
      message: redact(error instanceof Error ? error.message : String(error)),
    }
    process.exitCode = 1
  } finally {
    writeReport(report, workRoot)
    if (!KEEP) rmSync(workRoot, { recursive: true, force: true })
    else process.stderr.write(`[fresh-profile] kept work root ${workRoot}\n`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`FRESH_PROFILE_SMOKE_FAILURE: ${redact(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  }
}
