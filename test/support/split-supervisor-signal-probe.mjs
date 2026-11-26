#!/usr/bin/env node
/**
 * Split-process external signal/parent-death probe.
 *
 * This file is deliberately outside the test body: it drives real Vitest or
 * Upgrade worker processes and checks OS process state, so a passing test
 * assertion cannot stand in for resource release. It never kills a process by
 * a guessed PID; the Supervisor receipt names the exact Worker/Host/Client
 * identities it owns.
 *
 * Modes (Pilot, unchanged):
 *   --mode main-signal --signal SIGINT|SIGTERM
 *   --mode foreground-group-sigint
 *   --mode worker-kill --at two-clients-ready|host-spawned-before-ack
 *   --mode bootstrap-main-sigterm
 *
 * Upgrade lifecycle probe modes:
 *   --mode upgrade-sequential-hosts
 *   --mode upgrade-live-profile-refusal
 *   --mode upgrade-live-host-exit
 *   --mode upgrade-qualification-host-death
 *   --mode upgrade-worker-kill --at old-host-ready|between-host-generations|new-host-spawned-before-ack|side-build-install|bootstrap-install|reload-child-active|reload-child-started-before-report|qualification-client-active|qualification-pre-spawn
 *
 * Process business Scene modes (this file is still the only external owner):
 *   --mode process-worker-kill --at bootstrap-install|host-spawned-before-ack|client-reserved-before-spawn|client-opened-before-ack|clients-ready|fallback-host-ready
 *   --mode process-main-signal --signal SIGINT|SIGTERM
 *
 * Required env:
 *   Pilot: SPLIT_VITEST_TMP_BASE + SPLIT_VITEST_CANDIDATE_TGZ
 *   Upgrade: SPLIT_VITEST_TMP_BASE + SPLIT_VITEST_UPGRADE_OLD_TGZ + SPLIT_VITEST_UPGRADE_NEW_TGZ
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { isBootstrapInstallInProgress, isSideNewInstallInProgress } from './split-upgrade-install-state.mjs'

const PILOT_MODES = ['main-signal', 'foreground-group-sigint', 'worker-kill', 'bootstrap-main-sigterm']
const UPGRADE_ATS = ['old-host-ready', 'between-host-generations', 'new-host-spawned-before-ack', 'side-build-install', 'bootstrap-install', 'reload-child-active', 'reload-child-started-before-report', 'qualification-client-active', 'qualification-pre-spawn']
const UPGRADE_MODES = ['upgrade-sequential-hosts', 'upgrade-live-profile-refusal', 'upgrade-live-host-exit', 'upgrade-qualification-host-death', 'upgrade-worker-kill']
const PROCESS_ATS = [
  'bootstrap-install',
  'host-spawned-before-ack',
  'client-reserved-before-spawn',
  'client-opened-before-ack',
  'terminal-owner-client-opened-before-ack',
  'clients-ready',
  'fallback-host-ready',
  'host-contenders-spawned',
  'qualification-client-spawned',
  'host-artifact-absent-started',
  'identity-witness-spawned',
  'finalize-compensation-started',
  'public-daemon-before-registry',
  'public-daemon-before-ready-ack',
  'public-daemon-ownership-refused',
]
/**
 * The three installed-entry windows bind ONE exact business test so the probe
 * can never land on an unrelated earlier test in the same file. The historical
 * windows keep the complete target file, unchanged.
 */
const PROCESS_AT_TARGETS = new Map([
  ['terminal-owner-client-opened-before-ack', {
    file: 'test/integration/split-process/business/client-lifecycle.vitest.ts',
    title: 'loses the terminal owner without stopping the Host and reconnects a fresh Client',
  }],
  ['host-contenders-spawned', {
    file: 'test/integration/split-process/business/host-seat.vitest.ts',
    title: 'admits exactly one Host when the same installed profile is started concurrently',
  }],
  ['qualification-client-spawned', {
    file: 'test/integration/split-process/business/transport-authentication.vitest.ts',
    title: 'settles qualification Client startup and exit failures without taking down the authenticated Host',
  }],
  ['host-artifact-absent-started', {
    file: 'test/integration/split-process/business/host-bootstrap.vitest.ts',
    title: 'refuses a missing installed Host Runtime artifact and authenticates after restoring the same bytes',
  }],
  ['identity-witness-spawned', {
    file: 'test/integration/split-process/business/host-seat.vitest.ts',
    title: 'treats a same-birth Linux zombie as dead and never as a signal target',
  }],
  ['finalize-compensation-started', {
    file: 'test/integration/split-process/business/host-bootstrap.vitest.ts',
    title: 'compensates a failed finalization without leaking a live Client or witness',
  }],
  ['public-daemon-before-registry', {
    file: 'test/integration/split-process/business/public-daemon-entry.vitest.ts',
    title: 'starts one real public daemon Client and Host from the installed CLI',
  }],
  ['public-daemon-before-ready-ack', {
    file: 'test/integration/split-process/business/public-daemon-entry.vitest.ts',
    title: 'starts one real public daemon Client and Host from the installed CLI',
  }],
  ['public-daemon-ownership-refused', {
    file: 'test/integration/split-process/business/public-daemon-entry.vitest.ts',
    title: 'refuses an unproven public Host ownership signal and compensates truthfully',
  }],
])
const PROCESS_MODES = ['process-worker-kill', 'process-main-signal']
const VITEST_ENTRY = 'node_modules/vitest/vitest.mjs'
const PROCESS_TARGET_FILE = 'test/integration/split-process/business/host-file-completion.vitest.ts'
const PROCESS_SIBLING_FILE = 'test/integration/split-process/business/preset-defaults.vitest.ts'

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FAIL: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function requireEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '') fail(`${name} must be set`)
  return value
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, label, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value !== undefined && value !== null && value !== false) return value
    await sleep(100)
  }
  fail(`${label}: timed out after ${String(timeoutMs)}ms`)
}

function assertLiveReceipt(receipt) {
  const problems = []
  if (receipt.host === undefined || !pidAlive(receipt.host.pid)) problems.push('Host PID is not live before the probe trigger')
  if ((receipt.clients ?? []).length < 2) problems.push('two Client receipts are missing before the probe trigger')
  for (const client of receipt.clients ?? []) {
    if (!pidAlive(client.shellPid)) problems.push(`Client shell PID is not live before the probe trigger: ${String(client.shellPid)}`)
  }
  if (problems.length > 0) fail(problems.join('; '))
}

function workerKillTarget(receipt, at, vitestPid) {
  const worker = receipt?.worker
  const workerPid = Number(worker?.pid)
  const workerPpid = Number(worker?.ppid)
  if (!Number.isInteger(workerPid) || workerPid <= 0
    || !Number.isInteger(workerPpid) || workerPpid <= 0) {
    fail(`worker-kill receipt did not carry a valid worker identity for ${String(at)}`)
  }
  if (!Number.isInteger(vitestPid) || workerPpid !== vitestPid) {
    fail(`worker PPID ${String(workerPpid)} does not match the probe-owned Vitest PID ${String(vitestPid)}`)
  }
  if (!pidAlive(workerPid)) fail(`worker PID ${String(workerPid)} is not alive before the probe SIGKILL`)
  return workerPid
}

function upgradeWorkerKillTarget(receipt, at) {
  const worker = receipt?.worker
  const workerPid = Number(worker?.pid)
  const workerPpid = Number(worker?.ppid)
  if (!Number.isInteger(workerPid) || workerPid <= 0 || !Number.isInteger(workerPpid) || workerPpid <= 0) {
    fail(`upgrade worker-kill receipt did not carry a valid worker identity for ${String(at)}`)
  }
  if (workerPpid !== process.pid) {
    fail(`upgrade worker PPID ${String(workerPpid)} does not match the probe PID ${String(process.pid)}`)
  }
  if (!pidAlive(workerPid)) fail(`upgrade worker PID ${String(workerPid)} is not alive before the probe SIGKILL`)
  return workerPid
}

async function waitForPidGone(pid, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return
    await sleep(50)
  }
  fail(`SIGKILL target PID ${String(pid)} is still alive`)
}

async function waitChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      reject(new Error(`child did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onClose = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('close', onClose)
  })
}

function readReceipts(tmpBase) {
  const root = join(tmpBase, 'split-resources')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name.endsWith('.json'))
    .flatMap(name => {
      try {
        return [JSON.parse(readFileSync(join(root, name), 'utf8'))]
      } catch {
        return []
      }
    })
}

function receipts(tmpBase, runId) {
  return readReceipts(tmpBase).filter(value => value.runId === runId)
}

function upgradeReceipts(tmpBase, parentRunId) {
  return readReceipts(tmpBase).filter(value => value.parentRunId === parentRunId)
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

/** Whether the kernel Host seat of one scope is free (Linux abstract / Darwin O_EXLOCK). */
async function hostSeatFree(seat) {
  if (seat?.kind === 'linux-abstract') {
    return await new Promise((resolve, reject) => {
      const server = createServer()
      let settled = false
      server.once('error', error => {
        if (settled) return
        settled = true
        if (error?.code === 'EADDRINUSE') {
          resolve(false)
          return
        }
        reject(error)
      })
      server.listen(seat.name, () => {
        if (settled) return
        settled = true
        server.close(() => resolve(true))
      })
    })
  }
  if (seat?.kind === 'darwin-file' && typeof seat.path === 'string' && seat.path !== '') {
    // O_RDWR|O_EXLOCK|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC, no O_CREAT.
    const flags = 2 | 32 | 4 | 256 | 16777216
    const started = Date.now()
    for (;;) {
      try {
        closeSync(openSync(seat.path, flags, 0o600))
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return true
        if (error?.code !== 'EAGAIN' && error?.code !== 'EWOULDBLOCK') throw error
        if (Date.now() - started > 15_000) return false
        await sleep(50)
      }
    }
  }
  fail(`unsupported Host seat descriptor: ${JSON.stringify(seat ?? null)}`)
  return false
}

function checkNoLingeringPaths(receipt) {
  let commands
  try {
    commands = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  } catch (error) {
    fail(`could not inspect OS process commands: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Only THIS Scene's own root is evidence. The shared tmp base may contain
  // other concurrently authorized probe Scenes and is never a leak by itself.
  const needles = [receipt.sceneRoot].filter(value => typeof value === 'string' && value !== '')
  const lingering = commands.split('\n').filter(line => {
    const trimmed = line.trim()
    if (trimmed === '') return false
    if (trimmed.includes('split-supervisor-signal-probe.mjs') || trimmed.includes('split-upgrade-probe-worker.mjs')) return false
    if (trimmed.includes('SPLIT_VITEST_TMP_BASE') || trimmed.includes('SPLIT_VITEST_CANDIDATE_TGZ')
      || trimmed.includes('SPLIT_VITEST_UPGRADE_OLD_TGZ') || trimmed.includes('SPLIT_VITEST_UPGRADE_NEW_TGZ')) return false
    return needles.some(needle => trimmed.includes(needle))
  })
  if (lingering.length > 0) {
    fail(`process(es) still reference the run's private path: ${lingering.join(' | ')}`)
  }
}

function latestReceipt(tmpBase, runId) {
  const all = receipts(tmpBase, runId)
  return all.length === 0 ? undefined : all.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0]
}

function latestUpgradeReceipt(tmpBase, parentRunId) {
  const all = upgradeReceipts(tmpBase, parentRunId)
  return all.length === 0 ? undefined : all.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0]
}

function checkReceiptResources(receipt) {
  const problems = []
  if (receipt.sceneRoot !== undefined && existsSync(receipt.sceneRoot)) {
    problems.push(`scene root still exists: ${receipt.sceneRoot}`)
  }
  if (receipt.install?.inProgress === true) {
    problems.push('install is still marked in progress')
  }
  if (receipt.host !== undefined) {
    for (const pid of [receipt.host.pid, receipt.host.businessPid]) {
      if (pidAlive(pid)) problems.push(`Host PID still alive: ${String(pid)}`)
    }
  }
  if (receipt.host?.pgid !== undefined && groupAlive(receipt.host.pgid)) {
    problems.push(`Host process group still alive: ${String(receipt.host.pgid)}`)
  }
  for (const client of receipt.clients ?? []) {
    if (pidAlive(client.shellPid)) problems.push(`Client shell PID still alive: ${String(client.shellPid)} (${String(client.label)})`)
    for (const pid of client.businessPids ?? []) {
      if (pidAlive(pid)) problems.push(`Client business PID still alive: ${String(pid)} (${String(client.label)})`)
    }
  }
  if (pidAlive(receipt.supervisor?.pid)) problems.push(`Supervisor PID still alive: ${String(receipt.supervisor.pid)}`)
  return problems
}

function checkUpgradeReceiptResources(receipt, options = {}) {
  const problems = []
  if (options.allowRemainingRoot !== true && receipt.sceneRoot !== undefined && existsSync(receipt.sceneRoot)) {
    problems.push(`scene root still exists: ${receipt.sceneRoot}`)
  }
  if (receipt.install?.inProgress === true) {
    problems.push('install is still marked in progress')
  }
  const generations = Array.isArray(receipt.hosts) ? receipt.hosts : []
  if (generations.length === 0 && receipt.phase !== 'NOT_QUIESCED' && options.allowNoHosts !== true) {
    problems.push('receipt carries no Host generation ledger')
  }
  for (const host of generations) {
    for (const pid of [host.pid, host.businessPid]) {
      if (pidAlive(pid)) problems.push(`Host generation ${String(host.generation)} PID still alive: ${String(pid)}`)
    }
    if (host.pgid !== undefined && groupAlive(host.pgid)) {
      problems.push(`Host generation ${String(host.generation)} process group still alive: ${String(host.pgid)}`)
    }
  }
  for (const client of receipt.clients ?? []) {
    if (pidAlive(client.shellPid)) problems.push(`Client shell PID still alive: ${String(client.shellPid)} (${String(client.label)})`)
    for (const pid of client.businessPids ?? []) {
      if (pidAlive(pid)) problems.push(`Client business PID still alive: ${String(pid)} (${String(client.label)})`)
    }
  }
  for (const qualification of receipt.qualificationClients ?? []) {
    if (pidAlive(qualification.pid)) problems.push(`qualification Client PID still alive: ${String(qualification.pid)}`)
    if (qualification.pgid !== undefined && groupAlive(qualification.pgid)) {
      problems.push(`qualification Client process group still alive: ${String(qualification.pgid)}`)
    }
  }
  for (const fallback of receipt.fallbackHosts ?? []) {
    if (fallback.reclaimed !== true) problems.push(`fallback Host PID ${String(fallback.pid)} was not reclaimed`)
    if (pidAlive(fallback.pid)) problems.push(`fallback Host PID still alive: ${String(fallback.pid)}`)
    if (fallback.pgid !== undefined && groupAlive(fallback.pgid)) {
      problems.push(`fallback Host process group still alive: ${String(fallback.pgid)}`)
    }
  }
  if (pidAlive(receipt.supervisor?.pid)) problems.push(`Supervisor PID still alive: ${String(receipt.supervisor.pid)}`)
  return problems
}

function verifyUpgradePair(receipt, oldTgz, newTgz) {
  const pair = receipt.pair
  if (pair === undefined) fail('the upgrade receipt carries no pair facts')
  if (pair.old.sha256 !== sha256(oldTgz)) fail('the receipt old SHA256 does not match the actual old tarball')
  if (pair.new.sha256 !== sha256(newTgz)) fail('the receipt new SHA256 does not match the actual new tarball')
  if (pair.old.sha256 === pair.new.sha256) fail('the two artifacts have the same SHA256')
  if (pair.old.manifestPin !== pair.new.manifestPin) fail('the two artifacts declare different DSH pins')
}

// ── process business Scene helpers ─────────────────────────────────────────
// The target is a REAL independent Vitest child. Only its Supervisor receipt
// names the Worker/Host/Client identities this probe may signal or audit.

function processReceipts(tmpBase, parentRunId) {
  return readReceipts(tmpBase).filter(value => value.kind === 'process' && value.parentRunId === parentRunId)
}

function latestProcessReceipt(tmpBase, parentRunId) {
  const all = processReceipts(tmpBase, parentRunId)
  return all.length === 0 ? undefined : all.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0]
}

function processNote(receipt, event, point) {
  return (receipt?.notes ?? []).find(note => note?.event === event
    && (point === undefined || note.detail?.point === point))
}

let kernelHelpers
async function loadKernelHelpers() {
  if (kernelHelpers !== undefined) return kernelHelpers
  const identity = await import('../../src/runtime/native-process/identity.ts')
  const contract = await import('./split-upgrade-native-contract.mjs')
  kernelHelpers = {
    read: identity.readKernelProcess,
    classify: contract.classifyKernelLiveness,
    serialize: contract.serializeKernelIdentity,
    groupMembers: identity.listKernelGroupMembers,
  }
  return kernelHelpers
}

let publicObservationCache
async function loadPublicObservation(receipt) {
  const anchor = receipt?.installation?.anchor
  if (typeof anchor !== 'string' || anchor === '') fail('the receipt carries no installed DSH anchor')
  if (publicObservationCache?.anchor === anchor) return publicObservationCache.observation
  const [seam, identity, darwin, contract] = await Promise.all([
    import('./split-public-process-observation.mjs'),
    import('../../src/runtime/native-process/identity.ts'),
    import('../../src/runtime/native-process/darwin.ts'),
    import('./split-upgrade-native-contract.mjs'),
  ])
  const observation = seam.createPublicObservation({
    anchor,
    koffiEntry: process.platform === 'darwin' ? darwin.resolveDshKoffi(anchor) : undefined,
    kernel: {
      read: identity.readKernelProcess,
      serialize: contract.serializeKernelIdentity,
      classify: contract.classifyKernelLiveness,
      listMembers: identity.listKernelGroupMembers,
    },
  })
  publicObservationCache = { anchor, observation }
  return observation
}

function exactPathAbsent(path, label) {
  try {
    lstatSync(path)
    fail(`${label}: the path exists but must be strictly absent`)
    return false
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    fail(`${label}: the path presence is not ENOENT (${String(error?.code)}), so absence is unproven`)
    return false
  }
}

async function assertPublicChain(receipt, launch, at, options = {}) {
  const obs = await loadPublicObservation(receipt)
  const installation = receipt.installation
  const home = installation?.dshHome
  const anchor = installation?.anchor
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const shellTty = options.shellTty ?? obs.ttyCompareFacts(launch.shellPid) ?? undefined
  if (shellTty === undefined) fail(`${at}: the shell controlling-tty identity is unavailable`)
  if (launch.cli.pid === launch.shellPid && launch.cli.birth !== launch.shellBirth) {
    fail(`${at}: the CLI=shell identity is not the same birth`)
  }
  const cliEntry = realpathSync(join(dirname(anchor), 'lib', 'bin.js'))
  const expected = (facts, role, extra = {}) => {
    const base = {
      birth: facts.birth,
      entry: role === 'cli' ? cliEntry : installation.entries[role],
      receiptEntry: role,
      home,
      profile: role === 'cli' ? undefined : (facts.officialProfile ?? launch.profile),
      anchor: role === 'cli' ? undefined : anchor,
      uid,
      requireEnv: true,
      ...extra,
    }
    return base
  }
  const cliExtra = {}
  if (launch.cli.pid !== launch.shellPid) {
    cliExtra.parentPid = launch.shellPid
    cliExtra.parentBirth = launch.shellBirth
  }
  if (shellTty !== undefined) cliExtra.tty = { kind: 'foreground', shell: shellTty }
  const cli = obs.capture(launch.cli.pid, expected(launch.cli, 'cli', cliExtra))
  if (cli.kind !== 'captured') fail(`${at}: the public CLI is not the complete live installed identity (${cli.kind}/${String(cli.code ?? cli.reason)})`)
  const client = obs.capture(launch.client.pid, expected(launch.client, 'client', {
    parentPid: launch.cli.pid,
    parentBirth: launch.cli.birth,
    tty: shellTty === undefined ? undefined : { kind: 'foreground', shell: shellTty },
  }))
  if (client.kind !== 'captured') fail(`${at}: the public Client is not the complete live direct child (${client.kind}/${String(client.code ?? client.reason)})`)
  const host = obs.capture(launch.host.pid, expected(launch.host, 'host', {
    parentPid: launch.client.pid,
    parentBirth: launch.client.birth,
    tty: { kind: 'detached' },
    groupLeader: true,
    forbidEnv: ['DSH_PI_TUI_BACKEND'],
  }))
  if (host.kind !== 'captured') fail(`${at}: the public Host is not the complete live detached identity (${host.kind}/${String(host.code ?? host.reason)})`)
  if (host.process.birth !== launch.host.birth || host.process.pid !== launch.host.pid) {
    fail(`${at}: the public Host capture did not bind the receipt PID/birth`)
  }
  if (launch.cli.pid !== launch.shellPid) {
    const edge = obs.parentEdge(launch.cli.pid, launch.shellPid, launch.shellBirth, launch.cli.birth)
    if (edge.proven !== true) fail(`${at}: the CLI/shell edge is not the current direct child (${String(edge.reason)})`)
  }
  return { obs, cli, client, host }
}

/**
 * terminal | live | unknown for one owned process group. A same-birth Linux
 * Z/X/x task is readable but NOT a live member; an unreadable group is unknown
 * ownership, never an empty (terminal) group.
 */
function processGroupTerminalState(kernel, pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return 'unknown'
  const members = kernel.groupMembers(pgid)
  if (!Array.isArray(members)) return 'unknown'
  for (const member of members) {
    const state = kernel.classify(member).state
    if (state === 'unknown') return 'unknown'
    if (state === 'alive') return 'live'
  }
  return 'terminal'
}

/** live | foreign (PID reused) | gone | unknown | unproven (no recorded birth). */
function identityLiveness(kernel, pid, birth) {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone'
  let observation
  try {
    observation = kernel.read(pid)
  } catch {
    return 'unknown'
  }
  const liveness = kernel.classify(observation)
  if (liveness.state === 'gone') return 'gone'
  if (liveness.state === 'unknown') return 'unknown'
  if (typeof birth !== 'string' || birth === '') return 'unproven'
  return kernel.serialize(observation.identity) === birth ? 'live' : 'foreign'
}

/** Read one exact live identity and its current parent edge. */
function liveIdentity(kernel, pid, birth, label) {
  if (identityLiveness(kernel, pid, birth) !== 'live') return undefined
  let observation
  try {
    observation = kernel.read(pid)
  } catch {
    return undefined
  }
  if (kernel.classify(observation).state !== 'alive') return undefined
  return observation.identity
}

function assertLiveParentEdge(kernel, childPid, childBirth, parentPid, parentBirth, label) {
  const child = liveIdentity(kernel, childPid, childBirth, label)
  const parent = liveIdentity(kernel, parentPid, parentBirth, label)
  if (child === undefined || parent === undefined) {
    fail(`${label}: the live parent/child identities are not both the registered births`)
  }
  if (child.ppid !== parentPid || child.ppid !== parent.pid) {
    fail(`${label}: the live child PID ${String(childPid)} is not parented by ${String(parentPid)}`)
  }
  if (kernel.serialize(parent) !== parentBirth) {
    fail(`${label}: the live parent birth changed`)
  }
}

/**
 * Capture the REAL kernel identity of the probe-owned Vitest main right after
 * spawn. Every destructive signal re-reads this identity and the current
 * parent table before it acts, so PID reuse or a re-parented process is a
 * controlled failure, never a signal to an unintended process.
 */
function captureProbeMainIdentity(kernel, spawned, label) {
  if (!Number.isInteger(spawned.pid) || spawned.pid <= 0) {
    fail(`${label}: the spawn returned no PID`)
  }
  if (spawned.exitCode !== null || spawned.signalCode !== null) {
    fail(`${label} already exited before its identity was captured`)
  }
  let observation
  try {
    observation = kernel.read(spawned.pid)
  } catch (error) {
    fail(`${label} kernel identity cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (observation.kind !== 'alive') fail(`${label} is not a live kernel process at capture`)
  return { pid: spawned.pid, birth: kernel.serialize(observation.identity) }
}

function assertProbeMainIdentity(kernel, captured, expectedPid, label) {
  if (captured === undefined) fail(`${label}: the probe did not capture the spawn identity`)
  if (captured.pid !== expectedPid) fail(`${label}: the captured PID is not the probe-owned Vitest main`)
  if (identityLiveness(kernel, captured.pid, captured.birth) !== 'live') {
    fail(`${label} is not the live kernel process captured at spawn`)
  }
  const rows = processTable()
  const row = rows.get(captured.pid)
  if (row === undefined || row.ppid !== process.pid) {
    fail(`${label} is no longer a direct child of this probe`)
  }
  return rows
}

function processTable() {
  let listing
  try {
    listing = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  } catch (error) {
    fail(`could not read the OS process table: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rows = new Map()
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

function isDescendantOf(rows, pid, ancestorPid) {
  let current = rows.get(pid)
  let steps = 0
  while (current !== undefined && current.ppid > 0 && steps < 64) {
    if (current.ppid === ancestorPid) return true
    current = rows.get(current.ppid)
    steps += 1
  }
  return false
}

/** Whether a real installer child of the Supervisor is running for this Scene. */
/** The real fd links of a live Linux process, read by the external probe. */
function processFdLinks(pid) {
  return Object.fromEntries(readdirSync(`/proc/${String(pid)}/fd`).map(name => {
    try { return [name, readlinkSync(`/proc/${String(pid)}/fd/${name}`)] } catch { return [name, '<unreadable>'] }
  }))
}

/** The kernel tty-index of one fd, or undefined when it is not a PTY fd. */
function processFdTtyIndex(pid, fd) {
  const info = readFileSync(`/proc/${String(pid)}/fdinfo/${String(fd)}`, 'utf8')
  const match = /^tty-index:\s*(\d+)$/mu.exec(info)
  if (match === null) throw new Error(`fd ${String(fd)} of PID ${String(pid)} has no tty-index`)
  return Number(match[1])
}


function installerProcessRunning(receipt) {
  const supervisorPid = Number(receipt?.supervisor?.pid) || (Number(receipt?.worker?.ppid) + 1)
  const rows = processTable()
  return [...rows.values()].some(row => row.pid !== supervisorPid
    && isDescendantOf(rows, row.pid, supervisorPid)
    && /\b(?:pnpm|npm|install)\b/u.test(row.command))
}

function checkProcessReceiptResources(receipt, kernel, options = {}) {
  const problems = []
  if (!Number.isInteger(receipt.worker?.ppid) || receipt.worker.ppid <= 0) {
    problems.push('the receipt Worker has no real PPID')
  }
  if (!Number.isInteger(receipt.supervisor?.ppid) || receipt.supervisor.ppid <= 0) {
    problems.push('the receipt Supervisor has no real PPID')
  } else if (receipt.worker?.pid !== undefined && receipt.supervisor.ppid !== receipt.worker.pid) {
    problems.push('the receipt Supervisor PPID is not the Scene Worker')
  }
  if (options.allowRemainingRoot !== true && receipt.sceneRoot !== undefined && existsSync(receipt.sceneRoot)) {
    problems.push(`scene root still exists: ${receipt.sceneRoot}`)
  }
  if (receipt.install?.inProgress === true) problems.push('install is still marked in progress')
  if (receipt.cleanup?.hostSeatFree !== true) problems.push('the process Scene did not report its Host seat free')
  if (receipt.cleanup?.qualificationSeatFree !== true) problems.push('the process Scene did not report its Client seat free')
  for (const host of receipt.hosts ?? []) {
    const state = identityLiveness(kernel, host.pid, host.birth)
    if (state !== 'gone' && state !== 'foreign') {
      problems.push(`Host generation ${String(host.generation)} process is ${state}: ${String(host.pid)}`)
    }
    if (host.pgid !== undefined) {
      const groupState = processGroupTerminalState(kernel, host.pgid)
      if (groupState !== 'terminal') {
        problems.push(`Host generation ${String(host.generation)} process group is ${groupState}: ${String(host.pgid)}`)
      }
    }
  }
  for (const client of receipt.processClients ?? []) {
    if (client.exited !== true) {
      problems.push(`process Client ${String(client.label)} did not record its terminal state`)
    }
    const shellState = identityLiveness(kernel, client.shellPid, client.shellBirth)
    if (shellState !== 'gone' && shellState !== 'foreign') {
      problems.push(`process Client ${String(client.label)} shell is ${shellState}: ${String(client.shellPid)}`)
    }
    for (const business of client.businessIdentities ?? []) {
      const state = identityLiveness(kernel, business.pid, business.birth)
      if (state !== 'gone' && state !== 'foreign') {
        problems.push(`process Client ${String(client.label)} business PID is ${state}: ${String(business.pid)}`)
      }
    }
    if (client.ownerPid !== null && client.ownerPid !== undefined) {
      if (client.ownerExit === null || client.ownerExit === undefined) {
        problems.push(`process Client ${String(client.label)} Owner has no terminal exit fact`)
      }
      const state = identityLiveness(kernel, client.ownerPid, client.ownerBirth)
      if (state !== 'gone' && state !== 'foreign') {
        problems.push(`process Client ${String(client.label)} Owner PID is ${state}: ${String(client.ownerPid)}`)
      }
    }
  }
  for (const client of receipt.qualificationClients ?? []) {
    if (client.kind !== 'qualification-client') continue
    if (client.exited !== true) {
      problems.push(`qualification Client ${String(client.label)} did not record its terminal state`)
    }
    const state = identityLiveness(kernel, client.pid, client.birth)
    if (state !== 'gone' && state !== 'foreign') {
      problems.push(`qualification Client ${String(client.label)} PID is ${state}: ${String(client.pid)}`)
    }
    if (Number.isInteger(client.pgid)) {
      const groupState = processGroupTerminalState(kernel, client.pgid)
      if (groupState !== 'terminal') {
        problems.push(`qualification Client ${String(client.label)} group is ${groupState}: ${String(client.pgid)}`)
      }
    }
  }
  for (const helper of receipt.qualificationHelpers ?? []) {
    if (helper.exited !== true) {
      problems.push(`${String(helper.kind)} ${String(helper.label)} did not record its terminal state`)
    }
    const state = identityLiveness(kernel, helper.pid, helper.birth)
    if (state !== 'gone' && state !== 'foreign') {
      problems.push(`${String(helper.kind)} ${String(helper.label)} PID is ${state}: ${String(helper.pid)}`)
    }
    if (Number.isInteger(helper.pgid)) {
      const groupState = processGroupTerminalState(kernel, helper.pgid)
      if (groupState !== 'terminal') {
        problems.push(`${String(helper.kind)} ${String(helper.label)} group is ${groupState}: ${String(helper.pgid)}`)
      }
    }
  }
  for (const launch of receipt.publicLaunches ?? []) {
    if (launch.closed !== true) problems.push(`public daemon launch ${String(launch.label)} did not record its terminal state`)
    for (const entry of [launch.cli, launch.client]) {
      if (entry === null || entry === undefined) continue
      const state = identityLiveness(kernel, entry.pid, entry.birth)
      if (state !== 'gone' && state !== 'foreign') {
        problems.push(`public daemon launch ${String(launch.label)} ${String(entry.entry)} PID is ${state}: ${String(entry.pid)}`)
      }
    }
    if (launch.cli !== null && launch.cli !== undefined
      && launch.cli.pid !== launch.shellPid && launch.cli.parentBirth !== launch.shellBirth) {
      problems.push(`public daemon launch ${String(launch.label)} CLI parent birth is not the native shell`)
    }
    if (launch.client !== null && launch.client !== undefined
      && launch.client.parentBirth !== launch.cli?.birth) {
      problems.push(`public daemon launch ${String(launch.label)} Client parent birth is not the CLI`)
    }
    if (launch.host !== null && launch.host !== undefined
      && launch.host.parentBirthAtCapture !== launch.client?.birth) {
      problems.push(`public daemon launch ${String(launch.label)} Host parent birth is not the Client`)
    }
    const expectedAnchor = receipt.installation?.anchor
    if (launch.client !== null && launch.client !== undefined
      && (launch.client.officialProfile !== launch.profile
        || typeof launch.client.officialAnchor !== 'string'
        || launch.client.officialAnchor === ''
        || launch.client.officialAnchor !== expectedAnchor)) {
      problems.push(`public daemon launch ${String(launch.label)} Client official profile/anchor is unproven`)
    }
    if (launch.host !== null && launch.host !== undefined
      && (launch.host.officialProfile !== launch.profile
        || launch.host.reservedProfile !== launch.profile
        || typeof launch.host.officialAnchor !== 'string'
        || launch.host.officialAnchor === ''
        || launch.host.officialAnchor !== expectedAnchor)) {
      problems.push(`public daemon launch ${String(launch.label)} Host official profile/anchor is unproven`)
    }
    if (launch.shellPid !== null && launch.shellPid !== undefined) {
      const shellState = identityLiveness(kernel, launch.shellPid, launch.shellBirth)
      if (shellState !== 'gone' && shellState !== 'foreign') {
        problems.push(`public daemon launch ${String(launch.label)} native shell is ${shellState}: ${String(launch.shellPid)}`)
      }
    }
    if (launch.nativeSessionTerminal !== true) {
      problems.push(`public daemon launch ${String(launch.label)} has no native-session terminal fact`)
    }
    if (launch.foregroundGroupTerminal !== true) {
      problems.push(`public daemon launch ${String(launch.label)} has no foreground-group terminal fact`)
    }
    if (launch.nativeRunAttempted !== false) {
      if (!Number.isInteger(launch.shellPgid)) {
        problems.push(`public daemon launch ${String(launch.label)} has no captured foreground group id`)
      } else {
        const groupState = processGroupTerminalState(kernel, launch.shellPgid)
        if (groupState !== 'terminal') {
          problems.push(`public daemon launch ${String(launch.label)} foreground group is ${groupState}: ${String(launch.shellPgid)}`)
        }
      }
    }
  }
  for (const host of receipt.publicHosts ?? []) {
    if (host.reclaimed !== true) problems.push(`public Host PID ${String(host.pid)} was not reclaimed`)
    const state = identityLiveness(kernel, host.pid, host.birth)
    if (state !== 'gone' && state !== 'foreign') {
      problems.push(`public Host PID is ${state}: ${String(host.pid)}`)
    }
    if (Number.isInteger(host.pgid)) {
      const groupState = processGroupTerminalState(kernel, host.pgid)
      if (groupState !== 'terminal') {
        problems.push(`public Host process group is ${groupState}: ${String(host.pgid)}`)
      }
    }
  }
  if ((receipt.publicLaunches ?? []).length > 0) {
    if (receipt.cleanup?.publicHandlersJoined !== true) {
      problems.push('the public startup/close handlers were not joined before cleanup')
    }
    if (receipt.publicOwnershipRefused === undefined && receipt.cleanup?.sceneRootRemoved !== true) {
      problems.push('the public Scene root was not removed after the terminal proof')
    }
    for (const launch of receipt.publicLaunches ?? []) {
      if (typeof launch.startupSettledAt !== 'string' || launch.startupSettledAt === '') {
        problems.push(`public launch ${String(launch.label)} has no settled startup handler fact`)
      }
      if (launch.terminalOutcome !== 'native-exit' && launch.terminalOutcome !== 'unknown-abort') {
        problems.push(`public launch ${String(launch.label)} has no honest terminal outcome`)
      }
      if (launch.verifiedTerminal === undefined) {
        problems.push(`public launch ${String(launch.label)} has no terminal fact`)
      }
    }
  }
  if (receipt.publicOwnershipRefused !== undefined) {
    if (receipt.publicOwnershipRefused.refusalCode !== 'PUBLIC_HOST_BIRTH_MISMATCH') {
      problems.push(`the public ownership refusal did not name the birth-mismatch guard: ${String(receipt.publicOwnershipRefused.refusalCode)}`)
    }
    if (typeof receipt.publicOwnershipRefused.refusal !== 'string'
      || receipt.publicOwnershipRefused.refusal === '') {
      problems.push('the public ownership refusal carries no concrete diagnostic')
    }
    if (receipt.publicOwnershipRefused.signalSent !== false) {
      problems.push('the public ownership refusal claims a signal was sent')
    }
    if (receipt.publicOwnershipRefused.targetLiveAtRefusal !== true) {
      problems.push('the public ownership refusal did not observe its target live')
    }
    if (receipt.publicOwnershipRefused.compensationCompleted !== true) {
      problems.push('the public ownership refusal compensation did not complete')
    }
  }
  if (receipt.installationMutation !== undefined) {
    problems.push(`the scoped installation mutation ${String(receipt.installationMutation.fault)} was not restored`)
  }
  for (const fallback of receipt.fallbackHosts ?? []) {
    if (fallback.reclaimed !== true) {
      problems.push(`fallback Host PID ${String(fallback.pid)} was not reclaimed`)
    }
    const state = identityLiveness(kernel, fallback.pid, fallback.birth ?? fallback.starttime)
    if (state !== 'gone' && state !== 'foreign') {
      problems.push(`fallback Host PID is ${state}: ${String(fallback.pid)}`)
    }
    if (fallback.pgid !== undefined) {
      const groupState = processGroupTerminalState(kernel, fallback.pgid)
      if (groupState !== 'terminal') {
        problems.push(`fallback Host process group is ${groupState}: ${String(fallback.pgid)}`)
      }
    }
  }
  if (pidAlive(receipt.supervisor?.pid)) problems.push(`Supervisor PID still alive: ${String(receipt.supervisor?.pid)}`)
  return problems
}

/** Wait for the process Scene's terminal receipt and refuse a non-quiesced one. */
async function waitProcessTerminal(tmpBase, parentRunId, timeoutMs) {
  return await waitUntil(() => {
    const current = latestProcessReceipt(tmpBase, parentRunId)
    if (current?.phase === 'NOT_QUIESCED') {
      fail(`the process Supervisor reported NOT_QUIESCED (${String(current.errorName ?? 'unknown')}) for ${parentRunId}`)
    }
    return current?.phase === 'ABORTED_CLEAN' ? current : undefined
  }, `process Supervisor ABORTED_CLEAN for ${parentRunId}`, timeoutMs)
}

/**
 * Wait (bounded) for the sibling's authenticated Host + Client checkpoint to be
 * LIVE **before** the target is signalled, then prove the two live Scenes share
 * no root, profile, DSH home, scope/seat, Worker, Host, Client or business
 * identity. The returned receipt is the snapshot that must still describe the
 * SAME live identities across the target's reclaim.
 */
async function waitProcessSiblingCheckpoint(tmpBase, siblingRunId, kernel, target) {
  const sibling = await waitUntil(() => {
    const current = latestProcessReceipt(tmpBase, siblingRunId)
    if (processNote(current, 'process-probe-sibling-ready') === undefined) return undefined
    const host = (current.hosts ?? [])[0]
    const client = (current.processClients ?? [])[0]
    if (host === undefined || client === undefined) return undefined
    if (identityLiveness(kernel, host.pid, host.birth) !== 'live') return undefined
    if (identityLiveness(kernel, client.shellPid, client.shellBirth) !== 'live') return undefined
    for (const business of client.businessIdentities ?? []) {
      if (identityLiveness(kernel, business.pid, business.birth) !== 'live') return undefined
    }
    return current
  }, 'live sibling process Scene at its authenticated checkpoint', 300_000)
  assertProcessSiblingDistinct(sibling, target)
  return sibling
}

function requireDistinctSiblingFact(what, left, right) {
  if (left === undefined || left === null || left === ''
    || right === undefined || right === null || right === ''
    || left === right) {
    fail(`the sibling process Scene does not have a distinct live ${what}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`)
  }
}

function assertProcessSiblingDistinct(sibling, target) {
  requireDistinctSiblingFact('scene root', sibling.sceneRoot, target.sceneRoot)
  requireDistinctSiblingFact('profile', sibling.installation?.profileDir, target.installation?.profileDir)
  requireDistinctSiblingFact('DSH home', sibling.installation?.dshHome, target.installation?.dshHome)
  requireDistinctSiblingFact('scope', sibling.scope?.scopeId, target.scope?.scopeId)
  requireDistinctSiblingFact('host seat',
    sibling.scope?.hostSeat?.path ?? sibling.scope?.hostSeat?.name,
    target.scope?.hostSeat?.path ?? target.scope?.hostSeat?.name)
  requireDistinctSiblingFact('Worker PID', sibling.worker?.pid, target.worker?.pid)
  requireDistinctSiblingFact('Worker PPID', sibling.worker?.ppid, target.worker?.ppid)
  requireDistinctSiblingFact('Host PID', (sibling.hosts ?? [])[0]?.pid, (target.hosts ?? [])[0]?.pid)
  // The serialized birth is the start timestamp; on Linux two distinct
  // processes started in the same clock tick carry the same string. The live
  // identity checks below bind each birth to its own PID.
  const siblingClient = (sibling.processClients ?? [])[0]
  const targetClient = (target.processClients ?? [])[0]
  requireDistinctSiblingFact('Client identity', siblingClient?.clientId, targetClient?.clientId)
  requireDistinctSiblingFact('native session', siblingClient?.sessionId, targetClient?.sessionId)
  requireDistinctSiblingFact('Client scratch', siblingClient?.scratch, targetClient?.scratch)
  requireDistinctSiblingFact('Client shell PID', siblingClient?.shellPid, targetClient?.shellPid)
  const siblingBusiness = (siblingClient?.businessIdentities ?? []).map(value => `${String(value.pid)}:${String(value.birth)}`)
  if (siblingBusiness.length === 0) fail('the sibling process Scene has no live business Client identity')
  const targetBusiness = (target.processClients ?? []).flatMap(entry =>
    (entry.businessIdentities ?? []).map(value => `${String(value.pid)}:${String(value.birth)}`))
  for (const identity of siblingBusiness) {
    if (targetBusiness.includes(identity)) {
      fail(`the sibling process Scene shares a business Client identity with the target: ${identity}`)
    }
  }
  if (sibling.candidate?.sha256 !== target.candidate?.sha256) {
    fail('the sibling process Scene used a different candidate')
  }
}

/** The snapshot identities must still be the SAME live kernel processes. */
function assertProcessSiblingStillLive(kernel, snapshot, label) {
  const host = (snapshot.hosts ?? [])[0]
  const client = (snapshot.processClients ?? [])[0]
  if (host === undefined || client === undefined) fail(`${label}: the sibling snapshot lost its Host/Client`)
  const workerState = identityLiveness(kernel, snapshot.worker?.pid, snapshot.worker?.birth)
  if (workerState !== 'live') fail(`${label}: the sibling Worker is ${workerState}`)
  const hostState = identityLiveness(kernel, host.pid, host.birth)
  if (hostState !== 'live') fail(`${label}: the sibling Host is ${hostState}`)
  const shellState = identityLiveness(kernel, client.shellPid, client.shellBirth)
  if (shellState !== 'live') fail(`${label}: the sibling Client shell is ${shellState}`)
  for (const business of client.businessIdentities ?? []) {
    const state = identityLiveness(kernel, business.pid, business.birth)
    if (state !== 'live') fail(`${label}: the sibling business Client PID ${String(business.pid)} is ${state}`)
  }
  if (!existsSync(snapshot.sceneRoot ?? '')) fail(`${label}: the sibling Scene root disappeared`)
}

/**
 * The target's captured identities must still be the SAME live processes at
 * the trigger: Worker, Host, both Client shells and every business Client. The
 * sibling wait can last minutes, so the earlier checkpoint alone is not a live
 * target proof.
 */
function assertProcessTargetStillLive(kernel, target, label) {
  const workerState = identityLiveness(kernel, target.worker?.pid, target.worker?.birth)
  if (workerState !== 'live') fail(`${label}: the target Worker is ${workerState}`)
  const host = (target.hosts ?? []).find(value => value.exited !== true)
  if (host === undefined) fail(`${label}: the target receipt lost its Host`)
  const hostState = identityLiveness(kernel, host.pid, host.birth)
  if (hostState !== 'live') fail(`${label}: the target Host is ${hostState}`)
  const clients = target.processClients ?? []
  if (clients.length < 2) fail(`${label}: the target receipt lost one of its two Clients`)
  for (const client of clients) {
    const shellState = identityLiveness(kernel, client.shellPid, client.shellBirth)
    if (shellState !== 'live') {
      fail(`${label}: the target Client ${String(client.label)} shell is ${shellState}`)
    }
    for (const business of client.businessIdentities ?? []) {
      const state = identityLiveness(kernel, business.pid, business.birth)
      if (state !== 'live') {
        fail(`${label}: the target Client ${String(client.label)} business PID ${String(business.pid)} is ${state}`)
      }
    }
  }
}

async function main() {
const mode = arg('--mode')
const signal = arg('--signal') ?? 'SIGTERM'
const at = arg('--at')
if (!PILOT_MODES.includes(mode) && !UPGRADE_MODES.includes(mode) && !PROCESS_MODES.includes(mode)) {
  fail(`unknown --mode ${JSON.stringify(mode)}`)
}
if (mode === 'main-signal' && signal !== 'SIGINT' && signal !== 'SIGTERM') {
  fail('--mode main-signal requires --signal SIGINT or SIGTERM')
}
if (mode === 'worker-kill' && at !== 'two-clients-ready' && at !== 'host-spawned-before-ack') {
  fail('--mode worker-kill requires --at two-clients-ready or host-spawned-before-ack')
}
if (mode === 'upgrade-worker-kill' && !UPGRADE_ATS.includes(at)) {
  fail(`--mode upgrade-worker-kill requires --at ${UPGRADE_ATS.join('|')}`)
}
if (mode === 'process-worker-kill' && !PROCESS_ATS.includes(at)) {
  fail(`--mode process-worker-kill requires --at ${PROCESS_ATS.join('|')}`)
}
if (mode === 'process-main-signal' && signal !== 'SIGINT' && signal !== 'SIGTERM') {
  fail('--mode process-main-signal requires --signal SIGINT or SIGTERM')
}
const upgradeMode = UPGRADE_MODES.includes(mode)
const processMode = PROCESS_MODES.includes(mode)

const tmpBase = requireEnv('SPLIT_VITEST_TMP_BASE')
let candidate
let oldTgz
let newTgz
if (upgradeMode) {
  oldTgz = requireEnv('SPLIT_VITEST_UPGRADE_OLD_TGZ')
  newTgz = requireEnv('SPLIT_VITEST_UPGRADE_NEW_TGZ')
  if (!existsSync(tmpBase) || !existsSync(oldTgz) || !existsSync(newTgz)) {
    fail('SPLIT_VITEST_TMP_BASE or an upgrade tarball does not exist')
  }
} else {
  candidate = requireEnv('SPLIT_VITEST_CANDIDATE_TGZ')
  if (!existsSync(tmpBase) || !existsSync(candidate)) fail('SPLIT_VITEST_TMP_BASE or SPLIT_VITEST_CANDIDATE_TGZ does not exist')
}
const runId = `split-vitest-probe-${String(process.pid)}-${String(Date.now())}`
const env = {
  ...process.env,
  SPLIT_VITEST_TMP_BASE: tmpBase,
  SPLIT_VITEST_RUN_ID: runId,
  ...(upgradeMode
    ? {
        SPLIT_VITEST_UPGRADE_OLD_TGZ: oldTgz,
        SPLIT_VITEST_UPGRADE_NEW_TGZ: newTgz,
      }
    : { SPLIT_VITEST_CANDIDATE_TGZ: candidate }),
}
const publicRefusalReleaseFile = join(tmpBase, `split-public-refusal-release-${String(process.pid)}.flag`)
if (processMode && at === 'public-daemon-ownership-refused') {
  if (existsSync(publicRefusalReleaseFile)) unlinkSync(publicRefusalReleaseFile)
  env.SPLIT_VITEST_PUBLIC_REFUSAL_RELEASE = publicRefusalReleaseFile
}
if (mode === 'worker-kill') env.SPLIT_VITEST_WORKER_KILL_POINT = at
if (mode === 'upgrade-worker-kill' && (at === 'new-host-spawned-before-ack' || at === 'qualification-client-active'
  || at === 'qualification-pre-spawn')) {
  env.SPLIT_VITEST_UPGRADE_KILL_POINT = at
}
if (mode === 'process-worker-kill') env.SPLIT_VITEST_PROCESS_PROBE_POINT = at
if (mode === 'process-main-signal') env.SPLIT_VITEST_PROCESS_PROBE_POINT = 'process-main-signal'
if (mode === 'upgrade-live-host-exit') {
  env.SPLIT_VITEST_UPGRADE_HOST_EXIT_AFTER_PROFILE_INSTALL = '1'
}
let seatCheckReleaseFile
if (mode === 'upgrade-qualification-host-death') {
  seatCheckReleaseFile = join(tmpBase, `split-upgrade-seat-check-${String(process.pid)}.flag`)
  env.SPLIT_VITEST_UPGRADE_QUALIFICATION_HOST_DEATH = '1'
  env.SPLIT_VITEST_UPGRADE_SEAT_CHECK_RELEASE = seatCheckReleaseFile
}

const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
})
sentinel.unref()
if (sentinel.pid === undefined) fail('could not start the external sentinel process')

let child
let vitestPid
/** The probe-owned Vitest main identity captured immediately after spawn. */
let probeMainIdentity
/** The probe-owned external sentinel identity captured in the process branch. */
let sentinelIdentity
let siblingChild
let siblingRunId
let siblingStopFile
let processSiblingReleaseFile
if (upgradeMode) {
  if (mode === 'upgrade-worker-kill' && (at === 'reload-child-active' || at === 'reload-child-started-before-report'
    || at === 'qualification-client-active' || at === 'qualification-pre-spawn')) {
    siblingRunId = `${runId}-sibling`
    siblingStopFile = join(tmpBase, `split-upgrade-sibling-stop-${String(process.pid)}.flag`)
    siblingChild = spawn(process.execPath, [
      '--import',
      'tsx/esm',
      'test/support/split-upgrade-probe-worker.mjs',
      '--scenario',
      'upgrade-sibling-live',
    ], {
      cwd: process.cwd(),
      env: {
        ...env,
        SPLIT_VITEST_RUN_ID: siblingRunId,
        SPLIT_UPGRADE_PROBE_SIBLING_STOP_FILE: siblingStopFile,
      },
      stdio: 'inherit',
    })
  }
  const scenario = mode === 'upgrade-worker-kill' ? `upgrade-worker-kill:${at}` : mode
  child = spawn(process.execPath, [
    '--import',
    'tsx/esm',
    'test/support/split-upgrade-probe-worker.mjs',
    '--scenario',
    scenario,
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  vitestPid = process.pid
} else if (processMode) {
  if (mode === 'process-worker-kill' && at === 'clients-ready') {
    // The sibling is a SEPARATE real Vitest invocation, never a second worker of
    // the target invocation: it waits at its authenticated checkpoint until this
    // probe releases it after the target is reclaimed, then finishes its own
    // real business path.
    processSiblingReleaseFile = join(tmpBase, `split-process-sibling-release-${String(process.pid)}.flag`)
    siblingRunId = `${runId}-sibling`
    const siblingEnv = {
      ...env,
      SPLIT_VITEST_RUN_ID: siblingRunId,
      SPLIT_VITEST_PROCESS_PROBE_SIBLING_RELEASE: processSiblingReleaseFile,
    }
    delete siblingEnv.SPLIT_VITEST_PROCESS_PROBE_POINT
    siblingChild = spawn(process.execPath, [
      VITEST_ENTRY,
      'run',
      '--config',
      'vitest.split.config.ts',
      '--project',
      'split-process-business',
      PROCESS_SIBLING_FILE,
    ], {
      cwd: process.cwd(),
      env: siblingEnv,
      stdio: 'inherit',
    })
  }
  const target = PROCESS_AT_TARGETS.get(at)
  child = spawn(process.execPath, [
    VITEST_ENTRY,
    'run',
    '--config',
    'vitest.split.config.ts',
    '--project',
    'split-process-business',
    target === undefined ? PROCESS_TARGET_FILE : target.file,
    ...(target === undefined ? [] : ['-t', target.title]),
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  vitestPid = child.pid
} else {
  child = spawn(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.split.config.ts',
    '--project',
    'split-process',
    'test/integration/split-multi-client.vitest.ts',
    '-t',
    'first real Question',
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    detached: mode === 'foreground-group-sigint',
  })
  vitestPid = child.pid
}

let childExited = false
let killedWorkerPid
let siblingReceipt
let siblingSnapshot
let kernel
try {
  let deadline
  kernel = processMode ? await loadKernelHelpers() : undefined
  if (processMode) {
    probeMainIdentity = captureProbeMainIdentity(kernel, child, 'probe-owned Vitest main')
    // The sentinel is probe-owned too: capture its exact kernel identity once
    // and reclassify it at the terminal claim instead of trusting a numeric PID.
    const observation = kernel.read(sentinel.pid)
    if (observation.kind !== 'alive') fail('the external sentinel is not a live kernel process at capture')
    sentinelIdentity = { pid: sentinel.pid, birth: kernel.serialize(observation.identity) }
  }
  if (upgradeMode && siblingChild !== undefined) {
    siblingReceipt = await waitUntil(() => {
      const current = latestUpgradeReceipt(tmpBase, siblingRunId)
      const live = (current?.notes ?? []).some(note => note.event === 'sibling-live')
      if (!live || !existsSync(current?.sceneRoot ?? '')) return undefined
      return pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid)
        && (current?.clients ?? []).every(client => pidAlive(client.shellPid)
          && (client.businessPids ?? []).every(pid => pidAlive(pid)))
        ? current : undefined
    }, 'live sibling Upgrade Scene', 600_000)
  }
  if (processMode) {
    if (mode === 'process-main-signal') {
      // The checkpoint is two real authenticated Clients over one live Host,
      // reported by the test after the Supervisor registered both identities.
      const ready = await waitUntil(() => {
        const current = latestProcessReceipt(tmpBase, runId)
        return processNote(current, 'process-probe-point', 'process-main-signal') !== undefined ? current : undefined
      }, 'two authenticated process Clients and a live Host', 900_000)
      const point = processNote(ready, 'process-probe-point', 'process-main-signal')
      const host = (ready.hosts ?? []).find(value => identityLiveness(kernel, value.pid, value.birth) === 'live')
      if (host === undefined) fail('process-main-signal: no live registered Host at the main-signal checkpoint')
      if ((ready.processClients ?? []).length < 2) fail('process-main-signal: fewer than two registered Clients at the checkpoint')
      for (const client of ready.processClients ?? []) {
        if (identityLiveness(kernel, client.shellPid, client.shellBirth) !== 'live') {
          fail(`process-main-signal: Client ${String(client.label)} is not the live kernel process it registered`)
        }
      }
      if (point.detail?.workerPid !== ready.worker?.pid) {
        fail('process-main-signal: the reported checkpoint does not name the receipt Worker')
      }
      if (ready.worker?.ppid !== vitestPid) {
        fail('process-main-signal: the receipt Worker is not a child of the probe-owned Vitest main')
      }
      if (identityLiveness(kernel, ready.worker?.pid, ready.worker?.birth) !== 'live') {
        fail('process-main-signal: the receipt Worker is not the live kernel process it registered')
      }
      // The signal goes to the REAL Vitest main this probe spawned, never to the
      // Worker that the receipt names. The spawn identity and the current
      // parent edge are re-read immediately before the signal.
      const mainRows = assertProbeMainIdentity(kernel, probeMainIdentity, vitestPid, 'probe-owned Vitest main')
      const workerRow = mainRows.get(ready.worker?.pid)
      if (workerRow === undefined || workerRow.ppid !== vitestPid) {
        fail('process-main-signal: the receipt Worker is no longer a child of the probe-owned Vitest main')
      }
      if (child.kill(signal) === false) fail('could not signal the Vitest main process')
      deadline = Date.now() + 240_000
    } else {
      let receipt
      if (at === 'bootstrap-install') {
        receipt = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (current?.install?.inProgress !== true) return undefined
          if (typeof current?.sceneRoot !== 'string' || !existsSync(current.sceneRoot)) return undefined
          if (!installerProcessRunning(current)) return undefined
          return current
        }, 'a real installer running under the registered process Scene root', 600_000)
      } else if (at === 'clients-ready') {
        receipt = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (processNote(current, 'process-probe-point', 'clients-ready') === undefined) return undefined
          const clients = current.processClients ?? []
          const host = (current.hosts ?? []).find(value => identityLiveness(kernel, value.pid, value.birth) === 'live')
          if (host === undefined || clients.length < 2) return undefined
          return clients.every(client => identityLiveness(kernel, client.shellPid, client.shellBirth) === 'live')
            ? current : undefined
        }, 'two authenticated process Clients and a live Host', 900_000)
        // The sibling must already be a LIVE authenticated Scene when the
        // target is signalled; a later successful installation is not the
        // required isolation proof.
        if (mode === 'process-worker-kill' && at === 'clients-ready') {
          siblingSnapshot = await waitProcessSiblingCheckpoint(tmpBase, siblingRunId, kernel, receipt)
        }
      } else if (at === 'finalize-compensation-started') {
        receipt = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (processNote(current, 'process-probe-hold', at) === undefined) return undefined
          const note = processNote(current, 'finalize-compensation-started')
          const live = [...(note?.detail?.liveClients ?? []), ...(note?.detail?.liveHelpers ?? [])]
          if (live.length === 0) return undefined
          return live.every(entry => identityLiveness(kernel, entry.pid, entry.birth) === 'live')
            ? current : undefined
        }, 'a failed-FINALIZE compensation holding a live registered entry', 900_000)
      } else if (at === 'fallback-host-ready') {
        receipt = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (processNote(current, 'process-probe-hold', 'fallback-host-ready') === undefined) return undefined
          const fallback = (current.fallbackHosts ?? []).find(value => value.reclaimed !== true)
          if (fallback === undefined) return undefined
          return identityLiveness(kernel, fallback.pid, fallback.birth ?? fallback.starttime) === 'live'
            ? current : undefined
        }, 'a registered live discovery-fallback Host', 900_000)
      } else if (at === 'public-daemon-before-registry' || at === 'public-daemon-before-ready-ack') {
        receipt = await waitUntil(async () => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (current?.phase === 'NOT_QUIESCED') {
            fail(`${String(at)}: the Supervisor failed before reaching the requested window (${String(current.errorName ?? 'unknown')})`)
          }
          const note = processNote(current, 'process-probe-hold', at)
          if (note === undefined) return undefined
          const launch = (current.publicLaunches ?? []).find(value => value.launchId === note.detail?.launchId)
          if (launch === undefined || launch.cli === undefined || launch.cli === null
            || launch.client === undefined || launch.client === null
            || launch.host === undefined || launch.host === null) return undefined
          const cliState = identityLiveness(kernel, launch.cli.pid, launch.cli.birth)
          const clientState = identityLiveness(kernel, launch.client.pid, launch.client.birth)
          const hostState = identityLiveness(kernel, launch.host.pid, launch.host.birth)
          if (cliState !== 'live' || clientState !== 'live' || hostState !== 'live') {
            fail(`${String(at)}: the captured public CLI/Client/Host is not the live kernel identity`)
          }
          const hostObservation = kernel.read(launch.host.pid)
          if (hostObservation.kind !== 'alive' || hostObservation.identity.ppid !== launch.client.pid) {
            fail(`${String(at)}: the public Host is not the captured Client's direct child`)
          }
          if (note.detail?.hostPid !== launch.host.pid) {
            fail(`${String(at)}: the checkpoint note names another public Host`)
          }
          if (at === 'public-daemon-before-registry') {
            if (note.detail?.registryAbsent !== true || note.detail?.registryAbsentBefore !== true
              || note.detail?.registryAbsentAfter !== true) {
              fail('public-daemon-before-registry: strict registry ENOENT was not recorded on both sides of the live capture')
            }
            if (launch.readyAt !== undefined) fail('public-daemon-before-registry: the launch already reached ready')
            if (typeof note.detail?.registryPath !== 'string') {
              fail('public-daemon-before-registry: the checkpoint carries no registry path')
            }
            exactPathAbsent(note.detail.registryPath, 'public-daemon-before-registry')
          } else {
            if (launch.readyAt === undefined || launch.host.instanceId === undefined) return undefined
            if (note.detail?.registryPublished !== true || note.detail?.authenticated !== true
              || note.detail?.ackOutstanding !== true) {
              fail('public-daemon-before-ready-ack: the checkpoint lacks registry/authentication/ACK facts')
            }
            const registryPath = join(current.installation.dshHome, 'run', 'dsh-pi-tui',
              launch.host.scopeId, 'instance.json')
            try {
              lstatSync(registryPath)
            } catch (error) {
              fail(`public-daemon-before-ready-ack: the published registry is not strictly present (${String(error?.code)})`)
            }
            const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
            if (registry.hostPid !== launch.host.pid || registry.instanceId !== launch.host.instanceId) {
              fail('public-daemon-before-ready-ack: the registry does not name the checkpoint Host')
            }
          }
          await assertPublicChain(current, launch, String(at))
          return current
        }, `${String(at)} public daemon checkpoint`, 900_000)
      } else if (at === 'public-daemon-ownership-refused') {
        receipt = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (current?.phase === 'NOT_QUIESCED') {
            fail(`public-daemon-ownership-refused: the Supervisor failed before readiness (${String(current.errorName ?? 'unknown')})`)
          }
          if (processNote(current, 'public-daemon-ownership-refused-ready') === undefined) return undefined
          const launch = (current.publicLaunches ?? []).find(value => value.readyAt !== undefined && value.host !== null)
          if (launch === undefined || launch.host === null) return undefined
          if (identityLiveness(kernel, launch.host.pid, launch.host.birth) !== 'live') return undefined
          if (launch.cli === null || identityLiveness(kernel, launch.cli.pid, launch.cli.birth) !== 'live') return undefined
          if (launch.client === null || identityLiveness(kernel, launch.client.pid, launch.client.birth) !== 'live') return undefined
          return current
        }, 'a ready public daemon launch with a live Host', 900_000)
      } else {
        receipt = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          return processNote(current, 'process-probe-hold', at) !== undefined ? current : undefined
        }, `${String(at)} process Scene checkpoint`, 900_000)
        if (at === 'host-spawned-before-ack') {
          const host = (receipt.hosts ?? []).find(value => value.exited !== true)
          if (host === undefined) fail('host-spawned-before-ack: no registered Host generation')
          if (identityLiveness(kernel, host.pid, host.birth) !== 'live') {
            fail('host-spawned-before-ack: the registered Host is not the live kernel process')
          }
          if (host.pgid === undefined || !groupAlive(host.pgid)) {
            fail('host-spawned-before-ack: the registered Host process group is not alive')
          }
          if (host.exitCode !== null || host.exitSignal !== null) fail('host-spawned-before-ack: the Host already exited')
        } else if (at === 'client-reserved-before-spawn') {
          const client = (receipt.processClients ?? [])[0]
          if (client === undefined) fail('client-reserved-before-spawn: no registered Client reservation')
          if (client.shellPid !== null || client.openedAt !== undefined) {
            fail('client-reserved-before-spawn: the native run already started before the checkpoint')
          }
          const host = (receipt.hosts ?? []).find(value => identityLiveness(kernel, value.pid, value.birth) === 'live')
          if (host === undefined) fail('client-reserved-before-spawn: the Host is not live and ready')
        } else if (at === 'client-opened-before-ack') {
          const client = (receipt.processClients ?? [])[0]
          if (client === undefined || client.shellPid === null) {
            fail('client-opened-before-ack: no real shell identity was registered')
          }
          if (identityLiveness(kernel, client.shellPid, client.shellBirth) !== 'live') {
            fail('client-opened-before-ack: the registered shell is not the live kernel process')
          }
          if (client.readyAt !== undefined) fail('client-opened-before-ack: the Client already reached ready')
        } else if (at === 'terminal-owner-client-opened-before-ack') {
          const client = (receipt.processClients ?? [])[0]
          if (client === undefined || client.shellPid === null || client.ownerPid === null) {
            fail('terminal-owner-client-opened-before-ack: no registered PTY Owner/shell identity')
          }
          if (client.terminal !== 'terminal-owner-loss') {
            fail('terminal-owner-client-opened-before-ack: the Client did not declare the owner-loss terminal')
          }
          if (client.readyAt !== undefined) fail('terminal-owner-client-opened-before-ack: the Client already reached ready')
          if (identityLiveness(kernel, client.ownerPid, client.ownerBirth) !== 'live') {
            fail('terminal-owner-client-opened-before-ack: the PTY Owner is not the live kernel process')
          }
          if (identityLiveness(kernel, client.shellPid, client.shellBirth) !== 'live') {
            fail('terminal-owner-client-opened-before-ack: the shell is not the live kernel process')
          }
          if (!Array.isArray(client.businessIdentities) || client.businessIdentities.length === 0
            || client.businessIdentities.some(value => identityLiveness(kernel, value.pid, value.birth) !== 'live')) {
            fail('terminal-owner-client-opened-before-ack: the business identity is not live')
          }
          if (!Number.isInteger(client.ownerPid) || !Number.isInteger(client.shellPid)) {
            fail('terminal-owner-client-opened-before-ack: the owner/shell PID is not a real kernel PID')
          }
          const host = (receipt.hosts ?? []).find(value => value.exited !== true)
          if (host === undefined || identityLiveness(kernel, host.pid, host.birth) !== 'live') {
            fail('terminal-owner-client-opened-before-ack: the authenticated Host is not live at the checkpoint')
          }
          if (host.pgid === undefined || !groupAlive(host.pgid)) {
            fail('terminal-owner-client-opened-before-ack: the authenticated Host group is not live at the checkpoint')
          }
          const ownerLinks = processFdLinks(client.ownerPid)
          if (Object.values(ownerLinks).includes('<unreadable>')) {
            fail('terminal-owner-client-opened-before-ack: the Owner fd table is unreadable')
          }
          const ownerMasters = Object.entries(ownerLinks).filter(([, link]) => link === '/dev/ptmx')
          if (ownerMasters.length === 0) {
            fail('terminal-owner-client-opened-before-ack: the Owner process holds no /dev/ptmx master')
          }
          const shellLinks = processFdLinks(client.shellPid)
          const shellTty = shellLinks['0']
          const ttyMatch = typeof shellTty === 'string' ? /^\/dev\/pts\/(\d+)$/u.exec(shellTty) : null
          if (ttyMatch === null) fail('terminal-owner-client-opened-before-ack: the shell has no pts index')
          const shellTtyIndex = Number(ttyMatch[1])
          const ownerMasterIndexes = ownerMasters.map(([fd]) => processFdTtyIndex(client.ownerPid, fd))
          const matchingOwnerMasters = ownerMasterIndexes.filter(index => index === shellTtyIndex)
          if (matchingOwnerMasters.length === 0) {
            fail(`terminal-owner-client-opened-before-ack: the Owner has no matching ptmx master for ${String(shellTty)}`)
          }
          if (ownerMasterIndexes.some(index => index !== shellTtyIndex)) {
            fail(`terminal-owner-client-opened-before-ack: the Owner has a ptmx master for another tty (${JSON.stringify(ownerMasterIndexes)})`)
          }
          const supervisorPid = receipt.supervisor?.pid
          if (!Number.isInteger(supervisorPid)) fail('terminal-owner-client-opened-before-ack: no Supervisor PID')
          const supervisorLinks = processFdLinks(supervisorPid)
          const matchingSupervisorMasters = Object.entries(supervisorLinks)
            .filter(([, link]) => link === '/dev/ptmx')
            .filter(([fd]) => processFdTtyIndex(supervisorPid, fd) === shellTtyIndex)
          if (matchingSupervisorMasters.length !== 0) {
            fail('terminal-owner-client-opened-before-ack: the Supervisor holds the matching ptmx master')
          }
          if (typeof shellLinks['0'] !== 'string' || !shellLinks['0'].startsWith('/dev/pts/')) {
            fail('terminal-owner-client-opened-before-ack: the shell has no controlling pts')
          }
          const shellObservation = kernel.read(client.shellPid)
          if (shellObservation.kind !== 'alive' || shellObservation.identity.ppid !== client.ownerPid) {
            fail('terminal-owner-client-opened-before-ack: the shell is not the Owner direct child')
          }
        } else if (at === 'host-contenders-spawned') {
          const contenders = (receipt.hosts ?? []).filter(value => value.mode === 'seat-race')
          if (contenders.length < 2) fail('host-contenders-spawned: fewer than two registered contenders')
          const live = contenders.filter(value => identityLiveness(kernel, value.pid, value.birth) === 'live')
          if (live.length === 0) fail('host-contenders-spawned: no contender is the live kernel process')
          const liveGroups = live.filter(value => Number.isInteger(value.pgid) && groupAlive(value.pgid))
          if (liveGroups.length === 0) fail('host-contenders-spawned: no live contender group is registered')
          if (receipt.host !== undefined) fail('host-contenders-spawned: a winner was already accepted before the signal')
        } else if (at === 'qualification-client-spawned') {
          const clients = (receipt.qualificationClients ?? []).filter(value => value.kind === 'qualification-client')
          if (clients.length === 0) fail('qualification-client-spawned: no registered qualification Client')
          const live = clients.filter(value => identityLiveness(kernel, value.pid, value.birth) === 'live')
          if (live.length === 0) fail('qualification-client-spawned: the qualification Client is not the live kernel process')
          if (!live.some(value => Number.isInteger(value.pgid) && groupAlive(value.pgid))) {
            fail('qualification-client-spawned: the qualification Client group is not alive')
          }
          const host = receipt.host
          if (host === undefined || identityLiveness(kernel, host.pid, host.birth) !== 'live') {
            fail('qualification-client-spawned: the authenticated Host is not live at the checkpoint')
          }
        } else if (at === 'identity-witness-spawned') {
          const helper = (receipt.qualificationHelpers ?? []).find(value => value.kind === 'identity-witness')
          if (helper === undefined) fail('identity-witness-spawned: no registered identity-witness holder')
          if (identityLiveness(kernel, helper.pid, helper.birth) !== 'live') {
            fail('identity-witness-spawned: the registered holder is not the live kernel process')
          }
          if (!Number.isInteger(helper.pgid) || !groupAlive(helper.pgid)) {
            fail('identity-witness-spawned: the registered holder group is not alive')
          }
        } else if (at === 'host-artifact-absent-started') {
          const attempt = (receipt.hosts ?? []).find(value => value.mode === 'host-runtime-absent')
          if (attempt === undefined) fail('host-artifact-absent-started: no registered artifact-absence attempt')
          if (identityLiveness(kernel, attempt.pid, attempt.birth) !== 'live') {
            fail('host-artifact-absent-started: the registered Host attempt is not the live kernel process')
          }
          if (receipt.installationMutation?.fault !== 'host-runtime-absent') {
            fail('host-artifact-absent-started: the scoped installation mutation is not registered')
          }
          if (typeof receipt.installationMutation.target !== 'string'
            || existsSync(receipt.installationMutation.target)) {
            fail('host-artifact-absent-started: the installed artifact is not absent at the checkpoint')
          }
          if (receipt.candidate?.sha256 !== sha256(requireEnv('SPLIT_VITEST_CANDIDATE_TGZ'))) {
            fail('host-artifact-absent-started: the receipt candidate SHA256 changed under the mutation')
          }
        }
      }
      if (at === 'bootstrap-install') {
        // Re-read immediately before the signal: the kill must land inside the
        // SAME real install window this probe reported, never after it.
        const current = latestProcessReceipt(tmpBase, runId)
        if (current?.install?.inProgress !== true || !installerProcessRunning(current)) {
          fail('bootstrap-install: the install window closed before the probe SIGKILL')
        }
        receipt = current
      }
      killedWorkerPid = workerKillTarget(receipt, at, vitestPid)
      // Tight, immediately-preceding identity check: the Worker birth, the
      // probe-owned Vitest main and the current Worker -> main parent edge must
      // all still be the registered identities and the live process tree.
      const rows = assertProbeMainIdentity(kernel, probeMainIdentity, vitestPid, 'probe-owned Vitest main')
      if (identityLiveness(kernel, killedWorkerPid, receipt.worker?.birth) !== 'live') {
        fail(`worker PID ${String(killedWorkerPid)} is not the live kernel process the receipt registered`)
      }
      const workerRow = rows.get(killedWorkerPid)
      if (workerRow === undefined || workerRow.ppid !== vitestPid) {
        fail(`worker PID ${String(killedWorkerPid)} is no longer a child of the probe-owned Vitest main`)
      }
      if (mode === 'process-worker-kill' && at === 'clients-ready') {
        // The sibling checkpoint may be awaited for minutes after the target
        // checkpoint: the SAME target and sibling identities must still be live
        // at the trigger itself, not only when they were first observed.
        if (siblingSnapshot === undefined) fail('the clients-ready sibling snapshot is missing at the trigger')
        assertProcessTargetStillLive(kernel, receipt, 'clients-ready target at the signal trigger')
        assertProcessSiblingStillLive(kernel, siblingSnapshot, 'clients-ready sibling at the signal trigger')
      }
      if (processMode && (at === 'public-daemon-before-registry' || at === 'public-daemon-before-ready-ack')) {
        const note = processNote(receipt, 'process-probe-hold', at)
        const launch = (receipt.publicLaunches ?? []).find(value => value.launchId === note?.detail?.launchId)
        if (launch === undefined) fail(`${at}: no public launch at the trigger`)
        await assertPublicChain(receipt, launch, String(at))
        if (at === 'public-daemon-before-registry') {
          const registryPath = note?.detail?.registryPath
          if (typeof registryPath !== 'string' || registryPath === '') {
            fail('public-daemon-before-registry: the hold carries no registry path')
          }
          // The exact absence is the decisive final fact immediately before the
          // Worker-only SIGKILL; no other read may run between it and the kill.
          exactPathAbsent(registryPath, 'public-daemon-before-registry immediately before SIGKILL')
        } else {
          const registryPath = join(receipt.installation.dshHome, 'run', 'dsh-pi-tui',
            launch.host.scopeId, 'instance.json')
          const launchPath = join(receipt.installation.dshHome, 'run', 'dsh-pi-tui',
            launch.host.scopeId, 'launch.json')
          let registry
          let launchMaterial
          try {
            registry = JSON.parse(readFileSync(registryPath, 'utf8'))
            launchMaterial = JSON.parse(readFileSync(launchPath, 'utf8'))
          } catch (error) {
            fail(`public-daemon-before-ready-ack: the current material is unreadable (${String(error?.code)})`)
          }
          if (registry?.hostPid !== launch.host.pid || registry?.instanceId !== launch.host.instanceId
            || registry?.scopeId !== launch.host.scopeId || registry?.buildId !== launch.host.buildId
            || launchMaterial?.instanceId !== launch.host.instanceId) {
            fail('public-daemon-before-ready-ack: the current registry/launch does not name the checkpoint Host')
          }
          try {
            lstatSync(registryPath)
          } catch (error) {
            fail(`public-daemon-before-ready-ack: the registry is not strictly present immediately before SIGKILL (${String(error?.code)})`)
          }
        }
      }
      if (process.kill(killedWorkerPid, 'SIGKILL') === false) {
        fail(`could not SIGKILL verified process worker PID ${String(killedWorkerPid)}`)
      }
      deadline = Date.now() + 180_000
      if (at === 'public-daemon-ownership-refused') {
        const refused = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          if (current?.phase === 'FAILED' && current.publicOwnershipRefused !== undefined) return current
          return current?.publicOwnershipRefused !== undefined
            && current.publicOwnershipRefused.compensationCompleted !== true
            && current.phase === 'NOT_QUIESCED' ? current : undefined
        }, 'the real public ownership refusal checkpoint', 120_000)
        const refusal = refused.publicOwnershipRefused
        if (refusal.refusalCode !== 'PUBLIC_HOST_BIRTH_MISMATCH') {
          fail(`public-daemon-ownership-refused: the guard did not refuse the mismatched birth (${String(refusal.refusalCode)}: ${String(refusal.refusal)})`)
        }
        const refusedHost = (refused.publicHosts ?? []).find(host => host.pid === refusal.pid)
        if (refusedHost === undefined) fail('public-daemon-ownership-refused: no public Host row at the refusal')
        if (identityLiveness(kernel, refusedHost.pid, refusedHost.birth) !== 'live') {
          fail('public-daemon-ownership-refused: the refused target is not live (a signal was sent)')
        }
        if (refusal.signalSent !== false) fail('public-daemon-ownership-refused: the receipt claims a signal was sent')
        if (refusal.signalAttempts !== 0) fail('public-daemon-ownership-refused: the admission recorded a destructive signal attempt')
        if (refusal.expectedBirth === refusal.birth) fail('public-daemon-ownership-refused: the expected birth was not mismatched')
        if (refusedHost.reclaimed === true) fail('public-daemon-ownership-refused: the Host was already reclaimed before release')
        if (typeof refused.sceneRoot !== 'string' || !existsSync(refused.sceneRoot)) {
          fail('public-daemon-ownership-refused: the refused root was not retained')
        }
        const refusedObs = await loadPublicObservation(refused)
        const refusedLaunch = (refused.publicLaunches ?? []).find(value => value.launchId === refusedHost.attemptByLaunchId)
        if (refusedLaunch === undefined) fail('public-daemon-ownership-refused: the refused Host has no owning launch')
        const refusedCurrent = refusedObs.capture(refusedHost.pid, {
          birth: refusedHost.birth,
          entry: refused.installation.entries.host,
          home: refused.installation.dshHome,
          profile: refusedHost.officialProfile ?? refusedLaunch.profile,
          anchor: refused.installation.anchor,
          uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
          requireEnv: true,
          tty: { kind: 'detached' },
          groupLeader: true,
          forbidEnv: ['DSH_PI_TUI_BACKEND'],
        })
        if (refusedCurrent.kind !== 'captured') {
          fail(`public-daemon-ownership-refused: the refused Host is not the complete current identity (${refusedCurrent.kind}/${String(refusedCurrent.code ?? refusedCurrent.reason)})`)
        }
        const refusedRegistry = join(refused.installation.dshHome, 'run', 'dsh-pi-tui',
          refusedHost.scopeId, 'instance.json')
        const refusedLaunchPath = join(refused.installation.dshHome, 'run', 'dsh-pi-tui',
          refusedHost.scopeId, 'launch.json')
        let refusedRegistryFacts
        let refusedLaunchFacts
        try {
          refusedRegistryFacts = JSON.parse(readFileSync(refusedRegistry, 'utf8'))
          refusedLaunchFacts = JSON.parse(readFileSync(refusedLaunchPath, 'utf8'))
        } catch (error) {
          fail(`public-daemon-ownership-refused: the refused material is unreadable (${String(error?.code)})`)
        }
        if (refusedRegistryFacts?.hostPid !== refusedHost.pid
          || refusedRegistryFacts?.instanceId !== refusedHost.instanceId
          || refusedRegistryFacts?.scopeId !== refusedHost.scopeId
          || refusedRegistryFacts?.buildId !== refusedHost.buildId
          || refusedLaunchFacts?.instanceId !== refusedHost.instanceId) {
          fail('public-daemon-ownership-refused: the current material does not name the refused Host')
        }
        writeFileSync(publicRefusalReleaseFile, 'release\n', { mode: 0o600 })
        const compensated = await waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          return current?.publicOwnershipRefused?.compensationCompleted === true ? current : undefined
        }, 'the ownership-refusal compensation terminal', 120_000)
        const refusedAfter = refusedObs.observe(refusedHost.pid)
        if (refusedAfter.kind === 'alive' && refusedAfter.birth === refusedHost.birth) {
          fail('public-daemon-ownership-refused: the refused Host is still live after compensation')
        }
        if (refusedAfter.kind === 'unknown') {
          fail(`public-daemon-ownership-refused: the refused Host terminal is unknown (${String(refusedAfter.code)})`)
        }
        const refusedGroup = refusedObs.groupMembers(refusedHost.pgid)
        if (refusedGroup.kind !== 'ok' || refusedGroup.members.length !== 0) {
          fail('public-daemon-ownership-refused: the refused Host group is not terminal after compensation')
        }
        if (compensated.publicOwnershipRefused?.signalSent !== false) {
          fail('public-daemon-ownership-refused: compensation lost the zero-signal fact')
        }
      }
    }
  } else if (upgradeMode) {
    if (mode === 'upgrade-qualification-host-death') {
      // Controlled negative for the discovery-fallback window: old Host A dies
      // after the Supervisor's status-before proof and before the real
      // qualification Client's ensureLocalHost(). The operation must refuse and
      // the Supervisor must reclaim the detached Host that fallback started,
      // with a strict terminal proof (no live Host/Client/group/seat/root).
      //
      // Positive control for the seat proof itself: while the real Host is
      // still alive it must hold the authoritative kernel Host seat, so the
      // same probe used for the terminal proof must report it as NOT free.
      // Only after that check does the injected-death window start.
      const liveReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const live = (current?.hosts ?? []).find(host => host.exited !== true
          && typeof host.scopeId === 'string' && host.scopeId !== '')
        return live === undefined ? undefined : current
      }, 'live Host generation with a scope id', 300_000)
      const liveHost = (liveReceipt.hosts ?? []).find(host => host.exited !== true
        && typeof host.scopeId === 'string' && host.scopeId !== '')
      if (liveHost === undefined) fail('upgrade-qualification-host-death: no live Host identity for the seat control')
      if (await hostSeatFree(liveHost.seat)) {
        fail('upgrade-qualification-host-death: the Host seat probe reports free while the Host is live; it is not discriminating')
      }
      writeFileSync(seatCheckReleaseFile, 'checked\n', { mode: 0o600 })
      const exit = await waitChildExit(child, 900_000)
      childExited = true
      if (exit.code !== 0 || exit.signal !== null) {
        fail(`upgrade-qualification-host-death worker exited abnormally: ${JSON.stringify(exit)}`)
      }
      const terminalReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return current?.phase === 'ABORTED_CLEAN' ? current : undefined
      }, 'upgrade-qualification-host-death ABORTED_CLEAN', 120_000)
      verifyUpgradePair(terminalReceipt, oldTgz, newTgz)
      if (!Array.isArray(terminalReceipt.hosts) || terminalReceipt.hosts.length !== 1) {
        fail(`upgrade-qualification-host-death: expected one Host generation, got ${String(terminalReceipt.hosts?.length)}`)
      }
      const injected = (terminalReceipt.notes ?? []).some(note => note.event === 'qualification-host-death-injected')
      if (!injected) fail('upgrade-qualification-host-death: the receipt carries no injected Host-death note')
      if (terminalReceipt.hosts[0].exitSignal !== 'SIGKILL') {
        fail(`upgrade-qualification-host-death: the injected Host did not die by SIGKILL: ${JSON.stringify(terminalReceipt.hosts[0].exitSignal)}`)
      }
      if ((terminalReceipt.qualificationClients ?? []).some(entry => entry.exited !== true)) {
        fail('upgrade-qualification-host-death: a qualification Client did not exit')
      }
      const fallbacks = terminalReceipt.fallbackHosts ?? []
      if (fallbacks.length === 0) {
        fail('upgrade-qualification-host-death: the injected Host death did not exercise the discovery fallback')
      }
      const seat = terminalReceipt.hosts[0].seat
      if (seat === null || seat === undefined) {
        fail('upgrade-qualification-host-death: the terminal receipt carries no Host seat descriptor')
      }
      if (!(await hostSeatFree(seat))) {
        fail('upgrade-qualification-host-death: the Host seat is still held after cleanup')
      }
      const problems = checkUpgradeReceiptResources(terminalReceipt)
      if (problems.length > 0) fail(problems.join('; '))
      checkNoLingeringPaths(terminalReceipt)
      if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        runId,
        workerPid: terminalReceipt.worker.pid,
        supervisorPid: terminalReceipt.supervisor?.pid,
        supervisorPhase: terminalReceipt.phase,
        hosts: terminalReceipt.hosts,
        qualificationClients: terminalReceipt.qualificationClients,
        fallbackHosts: fallbacks,
        hostSeatFree: true,
        sceneRoot: terminalReceipt.sceneRoot,
        sentinelPid: sentinel.pid,
      })}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} supervisor_phase=${terminalReceipt.phase} fallback_hosts=${String(fallbacks.length)}`)
      return
    }
    if (mode === 'upgrade-live-host-exit') {
      const exit = await waitChildExit(child, 600_000)
      childExited = true
      if (exit.code !== 0 || exit.signal !== null) fail(`upgrade-live-host-exit worker exited abnormally: ${JSON.stringify(exit)}`)
      const terminalReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return current?.phase === 'ABORTED_CLEAN' ? current : undefined
      }, 'upgrade-live-host-exit ABORTED_CLEAN', 60_000)
      verifyUpgradePair(terminalReceipt, oldTgz, newTgz)
      if (!Array.isArray(terminalReceipt.hosts) || terminalReceipt.hosts.length !== 1) {
        fail(`upgrade-live-host-exit: expected one Host generation, got ${String(terminalReceipt.hosts?.length)}`)
      }
      const problems = checkUpgradeReceiptResources(terminalReceipt)
      if (problems.length > 0) fail(problems.join('; '))
      checkNoLingeringPaths(terminalReceipt)
      if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        runId,
        workerPid: terminalReceipt.worker.pid,
        supervisorPid: terminalReceipt.supervisor?.pid,
        supervisorPhase: terminalReceipt.phase,
        hosts: terminalReceipt.hosts,
        sceneRoot: terminalReceipt.sceneRoot,
        sentinelPid: sentinel.pid,
      })}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} supervisor_phase=${terminalReceipt.phase} host_exit=${JSON.stringify(terminalReceipt.hosts[0].exitSignal)}`)
      return
    }
    if (mode === 'upgrade-sequential-hosts' || mode === 'upgrade-live-profile-refusal') {
      const finalReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return current?.phase === 'FINALIZED' ? current : undefined
      }, `${mode} FINALIZED`, 900_000)
      const exit = await waitChildExit(child, 30_000)
      childExited = true
      if (exit.code !== 0 || exit.signal !== null) fail(`upgrade worker exited abnormally: ${JSON.stringify(exit)}`)
      verifyUpgradePair(finalReceipt, oldTgz, newTgz)
      if (!Array.isArray(finalReceipt.hosts) || finalReceipt.hosts.length !== 2) {
        fail(`${mode}: expected exactly two Host generations, got ${String(finalReceipt.hosts?.length)}`)
      }
      for (const host of finalReceipt.hosts) {
        if (host.exitCode !== 0 || host.exitSignal !== null) fail(`Host generation ${String(host.generation)} did not exit 0: ${JSON.stringify(host)}`)
      }
      if (mode === 'upgrade-sequential-hosts' && finalReceipt.hosts[0].buildId === finalReceipt.hosts[1].buildId) {
        fail(`${mode}: the two generations published the same buildId`)
      }
      if (mode === 'upgrade-live-profile-refusal' && finalReceipt.hosts[0].buildId !== finalReceipt.hosts[1].buildId) {
        fail(`${mode}: the old profile and side-old generations must publish the same old buildId`)
      }
      if (finalReceipt.hosts[0].pid === finalReceipt.hosts[1].pid) fail(`${mode}: the two generations reused one PID`)
      if (mode === 'upgrade-live-profile-refusal') {
        if (finalReceipt.profile?.old?.version !== finalReceipt.pair.old.version) fail('live-profile-refusal: the old profile facts are missing')
        if (finalReceipt.profile?.newForReload?.version !== finalReceipt.pair.new.version) fail('live-profile-refusal: the legal new-for-reload install facts are missing')
      }
      const problems = checkUpgradeReceiptResources(finalReceipt)
      if (problems.length > 0) fail(problems.join('; '))
      checkNoLingeringPaths(finalReceipt)
      if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        runId,
        workerPid: finalReceipt.worker.pid,
        supervisorPid: finalReceipt.supervisor?.pid,
        supervisorPhase: finalReceipt.phase,
        hosts: finalReceipt.hosts,
        clients: finalReceipt.clients,
        pair: finalReceipt.pair,
        sceneRoot: finalReceipt.sceneRoot,
      })}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} supervisor_phase=${finalReceipt.phase} generations=${String(finalReceipt.hosts.length)}`)
      return
    }
    const barrierPoint = mode === 'upgrade-worker-kill' ? at : undefined
    if (barrierPoint === 'side-build-install') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        // Bind to the authoritative NEW side operation, not merely any current
        // install flag: the old bootstrap writes the same boolean earlier.
        return isSideNewInstallInProgress(current) ? current : undefined
      }, 'new side-build install currently in progress', 300_000)
    } else if (barrierPoint === 'bootstrap-install') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return isBootstrapInstallInProgress(current) ? current : undefined
      }, 'old bootstrap install currently in progress', 300_000)
    } else if (barrierPoint === 'new-host-spawned-before-ack') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const barrierHit = (current?.notes ?? []).some(note => note.event === 'host-spawned-before-ack-barrier' && note.detail?.generation === 2)
        return barrierHit ? current : undefined
      }, 'second Host spawned before ACK', 600_000)
    } else if (barrierPoint === 'reload-child-active' || barrierPoint === 'reload-child-started-before-report') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const note = (current?.notes ?? []).find(value => value.event === 'worker-kill-point'
          && value.detail?.point === barrierPoint)
        if (note === undefined || !pidAlive(current?.host?.pid) || !groupAlive(current?.host?.pgid)) return undefined
        if (barrierPoint === 'reload-child-started-before-report') {
          return pidAlive(note.detail?.oldPid) && pidAlive(note.detail?.replacementPid) ? current : undefined
        }
        const client = (current?.clients ?? []).find(value => value.label === 'reload-child-active-client')
        const pids = client?.businessPids ?? []
        return pids.length >= 2 && pids.every(pid => pidAlive(pid)) ? current : undefined
      }, `reload replacement child at ${barrierPoint}`, 600_000)
    } else if (barrierPoint === 'qualification-pre-spawn') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const held = (current?.notes ?? []).some(note => note.event === 'qualification-pre-spawn-hold')
        if (!held) return undefined
        if ((current?.qualificationClients ?? []).length > 0) {
          fail('qualification-pre-spawn: a qualification Client was registered before the barrier')
        }
        return pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid) ? current : undefined
      }, 'qualification pre-spawn hold', 600_000)
    } else if (barrierPoint === 'qualification-client-active') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const ledger = Array.isArray(current?.qualificationClients) ? current.qualificationClients : []
        const qualification = ledger.at(-1)
        if (qualification === undefined || qualification.exited === true
          || !pidAlive(qualification.pid) || !groupAlive(qualification.pgid)) {
          return undefined
        }
        return pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid) ? current : undefined
      }, 'one-shot qualification Client active', 600_000)
    } else if (barrierPoint === 'old-host-ready') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const hit = (current?.notes ?? []).some(note => note.event === 'worker-kill-point' && note.detail?.point === 'old-host-ready')
        return hit && pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid) ? current : undefined
      }, 'old Host ready barrier', 600_000)
    } else if (barrierPoint === 'between-host-generations') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const hit = (current?.notes ?? []).some(note => note.event === 'worker-kill-point' && note.detail?.point === 'between-host-generations')
        return hit ? current : undefined
      }, 'between Host generations barrier', 600_000)
    }
    const receipt = latestUpgradeReceipt(tmpBase, runId)
    if (barrierPoint === 'bootstrap-install' && isSideNewInstallInProgress(receipt)) {
      fail('old-bootstrap-only kill incorrectly satisfied the side-new install selector')
    }
    killedWorkerPid = upgradeWorkerKillTarget(receipt, barrierPoint)
    if (process.kill(killedWorkerPid, 'SIGKILL') === false) {
      fail(`could not SIGKILL verified upgrade worker PID ${String(killedWorkerPid)}`)
    }
    deadline = Date.now() + (barrierPoint === 'side-build-install' || barrierPoint === 'bootstrap-install' ? 240_000 : 60_000)
    const exit = await waitChildExit(child, Math.max(1, deadline - Date.now()))
    childExited = true
    if (exit.code === 0 && exit.signal === null) fail(`upgrade worker unexpectedly exited 0 under ${mode}/${String(at)}`)
    await waitForPidGone(killedWorkerPid, Math.max(1, deadline - Date.now()))
    const terminalReceipt = await waitUntil(() => {
      const current = latestUpgradeReceipt(tmpBase, runId)
      if (current?.phase !== 'ABORTED_CLEAN' && current?.phase !== 'NOT_QUIESCED') return undefined
      return current
    }, 'Supervisor ABORTED_CLEAN/NOT_QUIESCED', Math.max(1, deadline - Date.now()))
    await sleep(Math.min(300, Math.max(1, deadline - Date.now())))
    if (terminalReceipt.phase !== 'ABORTED_CLEAN') {
      fail(`upgrade worker kill ended ${String(terminalReceipt.phase)}: ${String(terminalReceipt.errorName)}`)
    }
    const problems = checkUpgradeReceiptResources(terminalReceipt, {
      allowNoHosts: barrierPoint === 'side-build-install' || barrierPoint === 'bootstrap-install',
    })
    if (problems.length > 0) fail(problems.join('; '))
    if (barrierPoint === 'qualification-pre-spawn') {
      // The killed worker's request must have created nothing after cleanup
      // took over: no qualification Client, no fallback Host, and the one Host
      // generation plus the kernel Host seat must be fully reclaimed.
      const held = (terminalReceipt.notes ?? []).some(note => note.event === 'qualification-pre-spawn-hold')
      if (!held) fail('qualification-pre-spawn: the pre-spawn barrier note is missing')
      if ((terminalReceipt.qualificationClients ?? []).length !== 0) {
        fail('qualification-pre-spawn: a qualification Client was registered after the Worker died')
      }
      if ((terminalReceipt.fallbackHosts ?? []).length !== 0) {
        fail('qualification-pre-spawn: a fallback Host was started after the Worker died')
      }
      if (!Array.isArray(terminalReceipt.hosts) || terminalReceipt.hosts.length !== 1) {
        fail(`qualification-pre-spawn: expected one Host generation, got ${String(terminalReceipt.hosts?.length)}`)
      }
      const seat = terminalReceipt.hosts[0].seat
      if (seat === null || seat === undefined) fail('qualification-pre-spawn: the receipt carries no Host seat descriptor')
      if (!(await hostSeatFree(seat))) fail('qualification-pre-spawn: the Host seat is still held after cleanup')
    }
    if (Date.now() > deadline) fail('probe exceeded its single fixed post-trigger deadline')
    if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
    let siblingFinal
    if (siblingChild !== undefined) {
      const liveSibling = latestUpgradeReceipt(tmpBase, siblingRunId)
      if (liveSibling === undefined || !existsSync(liveSibling.sceneRoot ?? '')
        || !pidAlive(liveSibling.host?.pid) || !groupAlive(liveSibling.host?.pgid)
        || (liveSibling.clients ?? []).some(client => !pidAlive(client.shellPid)
          || (client.businessPids ?? []).some(pid => !pidAlive(pid)))) {
        fail('the sibling Upgrade Scene was not live when the killed Scene was reclaimed')
      }
      writeFileSync(siblingStopFile, 'stop\n', { mode: 0o600 })
      const siblingExit = await waitChildExit(siblingChild, 300_000)
      if (siblingExit.code !== 0 || siblingExit.signal !== null) {
        fail(`sibling Upgrade worker exited abnormally: ${JSON.stringify(siblingExit)}`)
      }
      siblingFinal = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, siblingRunId)
        return current?.phase === 'FINALIZED' ? current : undefined
      }, 'sibling Upgrade Scene FINALIZED', 120_000)
      const siblingProblems = checkUpgradeReceiptResources(siblingFinal)
      if (siblingProblems.length > 0) fail(`sibling Upgrade Scene: ${siblingProblems.join('; ')}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        at: 'sibling-live',
        runId: siblingRunId,
        workerPid: siblingFinal.worker.pid,
        supervisorPhase: siblingFinal.phase,
        hosts: siblingFinal.hosts,
        clients: siblingFinal.clients,
        sceneRoot: siblingFinal.sceneRoot,
      })}`)
    }
    console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
      mode,
      at,
      runId,
      workerPid: killedWorkerPid,
      workerExit: exit,
      supervisorPid: terminalReceipt.supervisor?.pid,
      supervisorPhase: terminalReceipt.phase,
      hosts: terminalReceipt.hosts,
      clients: terminalReceipt.clients,
      sceneRoot: terminalReceipt.sceneRoot,
      siblingRunId,
      siblingFinalPhase: siblingFinal?.phase,
      sentinelPid: sentinel.pid,
    })}`)
    console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} at=${String(at)} supervisor_phase=${terminalReceipt.phase} worker_exit=${JSON.stringify(exit)}`)
    return
  }

  if (processMode) {
    // The process branch above already owns the trigger; never fall through to
    // the Pilot/Upgrade waiters.
  } else if (mode === 'bootstrap-main-sigterm') {
    await waitUntil(() => {
      const receipt = latestReceipt(tmpBase, runId)
      return (receipt?.notes ?? []).some(note => note.event === 'bootstrap-root-created')
        && receipt?.install?.inProgress === true ? receipt : undefined
    }, 'BOOTSTRAP_ROOT_CREATED receipt', 60_000)
    if (child.kill('SIGTERM') === false) fail('could not signal the Vitest main process')
    deadline = Date.now() + 240_000
  } else if (mode === 'worker-kill') {
    const receipt = await waitUntil(() => {
      const current = latestReceipt(tmpBase, runId)
      if (at === 'host-spawned-before-ack') {
        const barrierHit = (current?.notes ?? []).some(note => note.event === 'host-spawned-before-ack-barrier')
        return barrierHit && pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid)
          ? current : undefined
      }
      return (current?.notes ?? []).some(note => note.event === 'worker-kill-point'
        && note.detail?.point === 'two-clients-ready') ? current : undefined
    }, `${mode}/${at} receipt`, 180_000)
    killedWorkerPid = workerKillTarget(receipt, at, vitestPid)
    if (process.kill(killedWorkerPid, 'SIGKILL') === false) {
      fail(`could not SIGKILL verified worker PID ${String(killedWorkerPid)}`)
    }
    deadline = Date.now() + 30_000
  } else {
    const readyReceipt = await waitUntil(() => {
      const receipt = latestReceipt(tmpBase, runId)
      return receipt?.phase === 'HOST_READY' && (receipt.clients?.length ?? 0) >= 2 ? receipt : undefined
    }, 'HOST_READY with two Clients', 180_000)
    assertLiveReceipt(readyReceipt)
    if (mode === 'foreground-group-sigint') {
      process.kill(-child.pid, 'SIGINT')
    } else if (child.kill(signal) === false) {
      fail('could not signal the Vitest main process')
    }
    deadline = Date.now() + 30_000
  }

  const exit = await waitChildExit(child, Math.max(1, deadline - Date.now()))
  childExited = true
  if (exit.code === 0) fail(`Vitest unexpectedly exited 0 under ${mode}`)
  if (killedWorkerPid !== undefined) {
    await waitForPidGone(killedWorkerPid, Math.max(1, deadline - Date.now()))
  }
  const receipt = processMode
    ? await (at === 'finalize-compensation-started'
      ? waitUntil(() => {
        const current = latestProcessReceipt(tmpBase, runId)
        return current?.phase === 'NOT_QUIESCED' && current?.compensation?.completed === true
          ? current
          : undefined
      }, 'failed FINALIZE compensation terminal', Math.max(1, deadline - Date.now()))
      : at === 'public-daemon-ownership-refused'
        ? waitUntil(() => {
          const current = latestProcessReceipt(tmpBase, runId)
          return current?.phase === 'NOT_QUIESCED'
            && current?.publicOwnershipRefused?.compensationCompleted === true
            && current?.cleanup?.completedAt !== undefined
            && current?.cleanup?.hostSeatFree === true
            && current?.cleanup?.qualificationSeatFree === true
            ? current
            : undefined
        }, 'public ownership refusal compensation terminal', Math.max(1, deadline - Date.now()))
        : waitProcessTerminal(tmpBase, runId, Math.max(1, deadline - Date.now())))
    : await waitUntil(() => {
      const current = latestReceipt(tmpBase, runId)
      return current?.phase === 'ABORTED_CLEAN' ? current : undefined
    }, 'Supervisor ABORTED_CLEAN', Math.max(1, deadline - Date.now()))
  if (processMode) {
    // The exact kernel Host seat this Scene published must be free again.
    if (!(await hostSeatFree(receipt.scope?.hostSeat))) {
      fail('the process Scene Host seat is still held after the terminal receipt')
    }
    if (!(await hostSeatFree(receipt.scope?.qualificationSeat))) {
      fail('the process Scene qualification Client seat is still held after the terminal receipt')
    }
    if (mode === 'process-worker-kill' && at === 'clients-ready') {
      if (siblingSnapshot === undefined) fail('the clients-ready sibling snapshot is missing')
      assertProcessSiblingStillLive(kernel, siblingSnapshot, 'clients-ready sibling after target reclaim')
      if (siblingChild === undefined) fail('the clients-ready sibling invocation is missing')
      writeFileSync(processSiblingReleaseFile, 'release\n', { mode: 0o600 })
      const siblingExit = await waitChildExit(siblingChild, 900_000)
      if (siblingExit.code !== 0 || siblingExit.signal !== null) {
        fail(`the sibling process Scene exit was not a normal completion: ${JSON.stringify(siblingExit)}`)
      }
      const siblingTerminal = await waitUntil(() => {
        const current = latestProcessReceipt(tmpBase, siblingRunId)
        return current?.phase === 'FINALIZED' ? current : undefined
      }, 'sibling process Scene FINALIZED', 120_000)
      const siblingProblems = checkProcessReceiptResources(siblingTerminal, kernel)
      if (siblingProblems.length > 0) fail(`sibling Scene: ${siblingProblems.join('; ')}`)
      const siblingNotes = (siblingTerminal.notes ?? []).map(note => note?.event)
      if (!siblingNotes.includes('process-probe-sibling-ready')
        || !siblingNotes.includes('process-probe-sibling-released')) {
        fail('the sibling Scene did not complete its real business path after the release')
      }
      if ((siblingTerminal.processClients ?? []).length !== 2) {
        fail(`the sibling Scene did not run its two real Clients (got ${String((siblingTerminal.processClients ?? []).length)})`)
      }
    }
  }
  await sleep(Math.min(300, Math.max(1, deadline - Date.now())))
  const problems = processMode
    ? checkProcessReceiptResources(receipt, kernel, {
      allowRemainingRoot: at === 'finalize-compensation-started' || at === 'public-daemon-ownership-refused',
    })
    : checkReceiptResources(receipt)
  if (problems.length > 0) fail(problems.join('; '))
  if (at !== 'finalize-compensation-started' && at !== 'public-daemon-ownership-refused') {
    checkNoLingeringPaths(receipt)
  }
  if (Date.now() > deadline) fail('probe exceeded its single fixed post-trigger deadline')
  const sentinelState = processMode && sentinelIdentity !== undefined
    ? identityLiveness(kernel, sentinelIdentity.pid, sentinelIdentity.birth)
    : (pidAlive(sentinel.pid) ? 'live' : 'gone')
  if (sentinelState !== 'live') {
    fail(`external sentinel PID ${String(sentinel.pid)} is ${sentinelState}; the probe touched an unrelated process`)
  }
  console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
    mode,
    at,
    signal: mode === 'main-signal' ? signal : undefined,
    runId,
    vitestPid: child.pid,
    workerPid: killedWorkerPid,
    vitestExit: exit,
    supervisorPid: receipt.supervisor?.pid,
    supervisorPhase: receipt.phase,
    hostPid: processMode ? (receipt.hosts ?? [])[0]?.pid : (receipt.host?.businessPid ?? receipt.host?.pid),
    clientPids: processMode
      ? (receipt.processClients ?? []).map(client => client.shellPid)
      : (receipt.clients ?? []).map(client => client.shellPid),
    fallbackHostPids: processMode
      ? (receipt.fallbackHosts ?? []).map(fallback => fallback.pid)
      : undefined,
    scopeId: processMode ? receipt.scope?.scopeId : undefined,
    seat: processMode ? receipt.scope?.hostSeat : undefined,
    workerBirth: processMode ? receipt.worker?.birth : undefined,
    supervisorPpid: processMode ? receipt.supervisor?.ppid : undefined,
    supervisorBirth: processMode ? receipt.supervisor?.birth : undefined,
    install: processMode ? receipt.install : undefined,
    sibling: processMode && siblingChild !== undefined ? { runId: siblingRunId, pid: siblingChild.pid } : undefined,
    sceneRoot: receipt.sceneRoot,
    sentinelPid: sentinel.pid,
  })}`)
  console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode}${at === undefined ? '' : ` at=${at}`}${mode === 'main-signal' ? ` signal=${signal}` : ''} vitest_exit=${JSON.stringify(exit)} supervisor_phase=${receipt.phase}`)
} finally {
  if (!childExited && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  if (siblingChild !== undefined && siblingChild.exitCode === null && siblingChild.signalCode === null) {
    try { siblingChild.kill('SIGKILL') } catch { /* already gone */ }
  }
  if (siblingStopFile !== undefined) {
    try { unlinkSync(siblingStopFile) } catch { /* not created */ }
  }
  if (processSiblingReleaseFile !== undefined) {
    try { unlinkSync(processSiblingReleaseFile) } catch { /* not created */ }
  }
  if (seatCheckReleaseFile !== undefined) {
    try { unlinkSync(seatCheckReleaseFile) } catch { /* not created */ }
  }
  if (processMode) {
    // Destructive cleanup follows the SAME captured identity as the terminal
    // check: never signal a numeric group/PID that may be gone, foreign or
    // unclassifiable. A vanished/foreign sentinel is skipped; an unverifiable
    // one fails the probe instead of being signalled.
    if (sentinelIdentity !== undefined) {
      const state = identityLiveness(kernel, sentinelIdentity.pid, sentinelIdentity.birth)
      if (state === 'live') {
        try {
          process.kill(-sentinelIdentity.pid, 'SIGKILL')
        } catch (error) {
          // ESRCH: the captured group vanished between the identity check and
          // this signal, so it is gone; never retry the numeric bare PID. Any
          // other failure is retained and fails the probe.
          if (error?.code !== 'ESRCH') {
            console.error(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FAIL: the captured sentinel group could not be signalled (${String(error?.code ?? 'unknown')}); refusing destructive cleanup`)
            process.exitCode = 1
          }
        }
      } else if (state === 'unknown') {
        console.error('SPLIT_SUPERVISOR_SIGNAL_PROBE_FAIL: the probe-owned sentinel identity is unverifiable; refusing destructive cleanup')
        process.exitCode = 1
      }
    } else if (sentinel.exitCode === null && sentinel.signalCode === null) {
      // The identity was never captured (early failure); an unreaped direct
      // child handle still names this probe's own sentinel, so reclaim it.
      try { sentinel.kill('SIGKILL') } catch { /* already gone */ }
    }
  } else {
    try { process.kill(-sentinel.pid, 'SIGKILL') } catch {
      try { sentinel.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
}
}

main().catch(error => {
  if (process.exitCode !== 1) {
    console.error(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  }
})
