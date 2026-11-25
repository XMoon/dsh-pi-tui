/**
 * Split-process parent-death supervisor.
 *
 * This process is the ONE lifecycle owner for a split-process scene root, its
 * isolated profile installation, the side-by-side upgrade payloads and every
 * real Split Host generation. A Vitest worker owns only the tui-test Clients
 * and business assertions; it never receives a Host ChildProcess handle and
 * never kills a Host by PID/PGID.
 *
 * The process is forked with `detached: true` and an IPC channel. The worker
 * can be killed (including SIGKILL); while this supervisor survives, Node's IPC
 * `disconnect` event triggers the ONE bounded cleanup path (TERM -> KILL, then
 * the owned scene root removal).
 *
 * Three scene kinds share this ONE supervisor wire:
 *   - `pilot`: the existing BOOTSTRAP/START_HOST/STOP_HOST behaviour with its
 *     one-Host-per-scene restriction unchanged.
 *   - `upgrade`: BOOTSTRAP_UPGRADE installs the old profile and owns sequential
 *     Host generations. At most ONE Host is active; a next generation may be
 *     created only after the previous generation's official stop and whole
 *     process-group disappearance are proven.
 *   - `process`: BOOTSTRAP_PROCESS installs ONE immutable single-package
 *     profile and this process also OWNS every real tui-test Client of the
 *     Scene. The Worker only drives bounded typed operations over IPC; it never
 *     holds a native terminal handle.
 */

import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { waitForEntryClose } from './entry-close.mjs'

import {
  allowNativeMutation,
  applyServiceObservation,
  assertManagedReservationScene,
  assertNativeManagedProfileInstall,
  assertNativeRollbackAdmission,
  classifyCurrentProfile,
  classifyKernelLiveness,
  classifyManagedInspection,
  classifyNativeCliFence,
  classifyNativeClientOwnership,
  classifyRegisteredProcessLiveness,
  cleanupNativeService,
  combineNativeFailures,
  executeNativeServiceReservation,
  isAcceptedCustomizedObservation,
  isNativeDaemonUnquiesced,
  loadNativeManagerAdapter,
  mergeHostIdentityLedger,
  nativeIdentityRecordMatches,
  nativeObservationCommitAllowed,
  runOwnedNativeCli,
  nativeBootstrapAdmission,
  parseManagedDaemonStatus,
  readNativeClientSnapshot,
  requireLaunchdCustomization,
  runFixedDaemonVerb,
  serializeKernelIdentity,
  waitForOwnedMutation,
} from './split-upgrade-native-contract.mjs'
import {
  assertKernelGroupSignalOwnership,
  kernelGroupLiveMemberPids,
} from './split-kernel-group-ownership.mjs'

const SUPERVISOR_STARTED_AT = new Date().toISOString()
const HOST_READY_TIMEOUT_MS = 180_000
const HOST_SHUTDOWN_GRACE_MS = 30_000
const TERM_GRACE_MS = 3_000
const KILL_GRACE_MS = 3_000
const MUTATING_HELPER_GRACE_MS = 30_000
const QUALIFICATION_PROOF_TIMEOUT_MS = 180_000
const QUALIFICATION_SHUTDOWN_GRACE_MS = 30_000
const RUN_ID = process.env.SPLIT_VITEST_RUN_ID ?? `supervisor-${String(process.pid)}-${String(Date.now())}`

let scene
/** The single live Host generation, or undefined when none is active. */
let activeHost
/** Every Host generation this scene ever created, in creation order. */
const hosts = []
/** The ONE in-flight one-shot qualification Client, or undefined. */
let activeQualificationClient
/** Every self-owned one-shot qualification Client, in creation order. */
const qualificationClients = []
/** Detached Hosts a Scene Client's discovery fallback started, reclaimed by this Supervisor. */
const fallbackHosts = []
/** Scratch directories that already existed when the current Host was declared dead. */
let processFallbackScratchBaseline = []
/** Process-scene native Clients this Supervisor owns; the Worker never holds one. */
const processClients = []
/**
 * Public daemon launches this Supervisor owns. A public launch is the REAL
 * installed `dsh --profile …` CLI under a native PTY; the product itself spawns
 * the foreground Client and the detached public Host, so these rows are an
 * observation ledger, never a second composition owner.
 */
const publicLaunches = []
let publicLaunchSequence = 0
/**
 * The public Hosts captured by launch observation. The public Client starts
 * these detached; this ledger is the Supervisor's reclaim ownership, never a
 * second Host authority.
 */
const publicHosts = []
/**
 * The one test-only offline-LLM profile patch applied for public launches. The
 * public Host strips `SPLIT_PROCESS_EXTRA_PATCH`, so the same stub must live in
 * the disposable profile's own user patch layer. It is never restored: the
 * whole private profile is inside the Scene root removed by this Supervisor.
 */
let publicProfileLlmPatch
/** Why the one armed public ownership negative refused to signal, if it did. */
let publicOwnershipRefusal
/** The immutable candidate a process Scene installed. */
let processCandidate
/** The read-only installed scope of a process Scene, proved before any Host. */
let processScope
let processClientSequence = 0
/**
 * The ONE native terminal operation in flight. It is registered synchronously
 * before its first await so the closing fence can wait for the REAL settlement
 * instead of removing a root a live native operation still owns.
 */
let processNativeOperation
let qualificationClientSequence = 0
/** The one in-flight bootstrap-CLI profile patch obligation, if any. */
let processBootstrapCliPatch
let receiptPath
let receipt
/** Once the terminal phase is recorded, a late handler may not rewrite it. */
let receiptTerminal = false
let installInProgress = false
let cleanupPromise
let finalized = false
let preserveRoot = false
let disconnected = false
/** Once closed, no dispatch or spawn may create a new process. */
let lifecycleClosed = false
let queue = Promise.resolve()
let workerKillBarrierResolve
let inspectSplitCandidate
let inspectImmutableSplitCandidate
let assertImmutableSplitCandidateUnchanged
let createSplitSmokeProfile
let prepareInstallCache
let installCacheEnvironment
let writeC1WorkFixture
let createTestTempDir
let inspectSplitUpgradePair
let assertSplitUpgradePairStillQualified
let installSideBuild
let installPlugin
let runDsh
let readJson
let productionBuildId
let installedPayloadHash
let readProcessStarttime
let safeIdentity
let assertIdentityKept
let seatIsFree
let readKernelProcess
let sameKernelProcess
let listKernelGroupMembers
let inspectInstalledProfileScope
let createSplitTerminal
let readOfficialClientRecords
let waitForTerminalExit
let openTuiSessions
let readScopeFiles
let assertPublishedHostMatchesKernel
let assertClientHostMatchesPublished
let readAuthenticatedIdentity
let exchangeCookie
let readJsonFile
let processC1Work
const SUPERVISOR_DIR = fileURLToPath(new URL('.', import.meta.url))
const PROCESS_PTY_OWNER = fileURLToPath(new URL('./split-process-pty-owner.mjs', import.meta.url))
const PROCESS_HOST_SCENARIOS = new Set(['long-turn', 'job'])
const PROCESS_HOST_CRASH_SIGNALS = new Set(['SIGHUP', 'SIGKILL'])
const PROCESS_CLIENT_HMR_MODES = new Set(['replace', 'mount-failure', 'hold'])
const PROCESS_CLIENT_TERMINAL_MODES = new Set(['normal', 'sigint', 'hmr-failure', 'terminal-owner-loss'])
const PROCESS_CLIENT_SIGNALS = new Set(['SIGUSR2', 'SIGINT', 'SIGTERM'])
let EXPECTED_PACKAGE_NAME
let hostStatusSequence = 0
/** The ONE native managed-service bridge state, or undefined for default/pilot scenes. */
let nativeRuntime
/** The one-shot native cleanup of this run (idempotent across FINALIZE/disconnect). */
let nativeCleanupPromise

// Register every parent-death / message / signal handler before loading the
// heavy profile and fixture modules. A fork can deliver `disconnect` while the
// module graph is still evaluating; an event registered after that point is not
// replayed. The implementation modules are loaded immediately below this block.
process.on('message', message => {
  queue = queue.then(() => {
    // After the lifecycle closed, pending messages are dropped, never run:
    // a queued request must not recreate a directory or a process while
    // cleanup owns the Scene.
    if (lifecycleClosed) return undefined
    return dispatch(message)
  }).catch(error => {
    // A late message racing the close is an expected drop, not a quiescence
    // failure; never overwrite the terminal receipt with NOT_QUIESCED for it.
    if (lifecycleClosed) return
    writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(error) })
  })
})

process.on('disconnect', () => {
  disconnected = true
  lifecycleClosed = true
  if (workerKillBarrierResolve !== undefined) {
    const resolve = workerKillBarrierResolve
    workerKillBarrierResolve = undefined
    resolve()
  }
  if (finalized) {
    process.exit(0)
    return
  }
  // preserveRoot only decides whether the diagnostic directory survives. It
  // never permits leaving an in-flight compensation (or a not-yet-started one)
  // without joining its real terminal.
  const settle = cleanupPromise !== undefined
    ? cleanupPromise
    : closeLifecycle('worker-ipc-disconnect')
  void settle.then(
    result => { process.exit(result.clean && !preserveRoot ? 0 : 1) },
    () => { process.exit(1) },
  )
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    lifecycleClosed = true
    const settle = cleanupPromise !== undefined
      ? cleanupPromise
      : closeLifecycle(`supervisor-${signal}`)
    void settle.then(
      result => { process.exit(result.clean && !preserveRoot ? 0 : 1) },
      () => { process.exit(1) },
    )
  })
}

process.on('uncaughtException', error => {
  writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(error) })
  lifecycleClosed = true
  const settle = cleanupPromise !== undefined
    ? cleanupPromise
    : closeLifecycle('uncaught-exception')
  void settle.then(() => process.exit(1), () => process.exit(1))
})

// Keep the IPC channel and message loop alive until FINALIZE or disconnect.
setInterval(() => {}, 1_000)

const modulesReady = Promise.all([
  import('../../scripts/lib/split-smoke-profile.mjs'),
  import('../../scripts/lib/test-install-cache.mjs'),
  import('../../scripts/lib/split-smoke-fixtures.mjs'),
  import('./temp-lifecycle.ts'),
  import('./split-upgrade-pair.mjs'),
  import('../../scripts/lib/split-upgrade-support.mjs'),
  import('../../scripts/lib/dsh-smoke-harness.mjs'),
  import('../../src/runtime/native-process/identity.ts'),
  import('../../src/app/remote-process/local-scope.ts'),
  import('./split-process-client.ts'),
  import('./split-process-authentication.ts'),
  import('@microsoft/tui-test'),
]).then(([profile, installCache, fixtures, tempLifecycle, pair, upgradeSupport, smokeHarness, nativeIdentity, localScope, processClient, authentication, tuiTest]) => {
  inspectSplitCandidate = profile.inspectSplitCandidate
  inspectImmutableSplitCandidate = profile.inspectImmutableSplitCandidate
  assertImmutableSplitCandidateUnchanged = profile.assertImmutableSplitCandidateUnchanged
  createSplitSmokeProfile = profile.createSplitSmokeProfile
  prepareInstallCache = installCache.prepareInstallCache
  installCacheEnvironment = installCache.installCacheEnvironment
  writeC1WorkFixture = fixtures.writeC1WorkFixture
  createTestTempDir = tempLifecycle.createTestTempDir
  inspectSplitUpgradePair = pair.inspectSplitUpgradePair
  assertSplitUpgradePairStillQualified = pair.assertSplitUpgradePairStillQualified
  installSideBuild = upgradeSupport.installSideBuild
  productionBuildId = upgradeSupport.productionBuildId
  installedPayloadHash = upgradeSupport.installedPayloadHash
  readProcessStarttime = upgradeSupport.readProcessStarttime
  safeIdentity = upgradeSupport.safeIdentity
  assertIdentityKept = upgradeSupport.assertIdentityKept
  seatIsFree = upgradeSupport.seatIsFree
  EXPECTED_PACKAGE_NAME = upgradeSupport.EXPECTED_PACKAGE_NAME
  installPlugin = smokeHarness.installPlugin
  runDsh = smokeHarness.runDsh
  readJson = smokeHarness.readJson
  readKernelProcess = nativeIdentity.readKernelProcess
  sameKernelProcess = nativeIdentity.sameKernelProcess
  listKernelGroupMembers = nativeIdentity.listKernelGroupMembers
  inspectInstalledProfileScope = localScope.inspectInstalledProfileScope
  createSplitTerminal = processClient.createSplitTerminal
  readOfficialClientRecords = processClient.readOfficialClientRecords
  waitForTerminalExit = processClient.waitForTerminalExit
  openTuiSessions = tuiTest.sessions
  readScopeFiles = authentication.readScopeFiles
  assertPublishedHostMatchesKernel = authentication.assertPublishedHostMatchesKernel
  assertClientHostMatchesPublished = authentication.assertClientHostMatchesPublished
  readAuthenticatedIdentity = authentication.readAuthenticatedIdentity
  exchangeCookie = authentication.exchangeCookie
  readJsonFile = authentication.readJsonFile
})

function validateTmpBase(raw) {
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) {
    throw new Error('INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE must be an absolute path')
  }
  let real
  let stats
  try {
    real = realpathSync(raw)
    stats = statSync(real)
  } catch (error) {
    throw new Error(`INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE is not a readable existing directory: ${boundedError(error)}`)
  }
  if (!stats.isDirectory()) throw new Error(`INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE is not a directory: ${real}`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE is not owned by this user: ${real}`)
  }
  if ((stats.mode & 0o777) !== 0o700) throw new Error('INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE must have mode 0700')
  const rel = relative(process.cwd(), real)
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) {
    throw new Error('INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE must be outside the checkout')
  }
  return real
}

function now() {
  return new Date().toISOString()
}

async function waitForWorkerKillBarrier() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workerKillBarrierResolve = undefined
      reject(new Error('START_HOST: worker-kill barrier timed out'))
    }, 120_000)
    workerKillBarrierResolve = () => {
      clearTimeout(timer)
      resolve()
    }
  })
}

/** A classified input refusal this process can carry into its receipt. */
function codedInputError(code, message) {
  const error = new Error(`INPUT_UNQUALIFIED: ${code} (INVALID_TEST_INPUT, not a product regression): ${message}`)
  error.code = code
  return error
}

/** Remove credential-looking substrings from diagnostic text. */
function redactText(text) {
  return String(text)
    .replace(/([?&](?:token|cookie)=)[^&\s"'`]+/giu, '$1[redacted]')
    .replace(/((?:token|cookie|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu, '$1[redacted]')
}

function boundedError(error) {
  const name = error instanceof Error ? error.name : 'Error'
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  return code === undefined ? name : `${name}:${code}`
}

function getPgrp() {
  try {
    return typeof process.getpgrp === 'function' ? process.getpgrp() : undefined
  } catch {
    return undefined
  }
}

function evidenceRoot(tmpBase) {
  const root = join(tmpBase, 'split-resources')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function appendNote(event, detail = {}) {
  if (receipt === undefined) return
  receipt.notes = [...(receipt.notes ?? []), { event, detail, at: now() }]
}

function writeReceipt(update) {
  if (receiptPath === undefined) return
  if (receiptTerminal) {
    if (update.phase === undefined || update.phase !== receipt.phase) return
  }
  receipt = { ...receipt, ...update, updatedAt: now() }
  // Publish one complete snapshot: the sibling Scene, the external probe and
  // the Worker all read this file while the owner keeps writing it.
  const temporary = `${receiptPath}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, receiptPath)
}

/** The serialized kernel birth of the real Worker that owns this Scene. */
function workerKernelBirth(pid) {
  if (typeof readKernelProcess !== 'function' || !Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const observation = readKernelProcess(pid)
    return observation.kind === 'alive' ? serializeKernelIdentity(observation.identity) : undefined
  } catch {
    return undefined
  }
}

function initReceipt(tmpBase, worker, extra = {}) {
  const root = evidenceRoot(tmpBase)
  receiptPath = join(root, `${RUN_ID}.json`)
  receipt = {
    schemaVersion: 1,
    runId: RUN_ID,
    supervisor: {
      pid: process.pid,
      ppid: process.ppid,
      pgrp: getPgrp() ?? process.pid,
      birth: workerKernelBirth(process.pid),
      startedAt: SUPERVISOR_STARTED_AT,
    },
    worker: { pid: worker.pid, ppid: worker.ppid, birth: workerKernelBirth(worker.pid) },
    phase: 'STARTED',
    sceneRoot: undefined,
    candidate: undefined,
    install: { inProgress: false, completed: false, startedAt: undefined, completedAt: undefined },
    host: undefined,
    hosts: [],
    clients: [],
    qualificationClients: [],
    fallbackHosts: [],
    notes: [],
    startedAt: SUPERVISOR_STARTED_AT,
    updatedAt: now(),
    ...extra,
  }
  writeReceipt({})
}

function send(message, callback) {
  if (process.connected !== true) {
    callback?.(new Error('supervisor IPC is disconnected'))
    return
  }
  try {
    process.send(message, error => {
      if (error !== undefined && error !== null) callback?.(error)
      else callback?.()
    })
  } catch (error) {
    callback?.(error instanceof Error ? error : new Error(String(error)))
  }
}

function reply(requestId, payload) {
  send({ type: 'RESPONSE', requestId, ok: true, payload })
}

function fail(requestId, code, error) {
  const message = redactText(error instanceof Error ? error.message : String(error))
  if (process.env.SPLIT_VITEST_DEBUG_SUPERVISOR === '1') {
    writeReceipt({ debugLastError: { code, message, stack: error instanceof Error ? error.stack : undefined, at: now() } })
  }
  send({ type: 'ERROR', requestId, code, message })
}

function progress(requestId, event, payload = {}) {
  send({ type: 'PROGRESS', requestId, event, payload })
}

async function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      reject(new Error(`child ${String(child.pid)} did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onClose = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('close', onClose)
  })
}

async function waitForHostRecord(target, predicate, label, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const record = target.records.find(predicate)
    if (record !== undefined) return record
    if (target.spawnError !== undefined) throw new Error(`${label}: Host spawn failed (${boundedError(target.spawnError)})`)
    if (target.exited) throw new Error(`${label}: Host exited before the record`)
    await sleep(20)
  }
  throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
}

/** The production kernel readers the shared group-ownership predicate uses. */
function processKernelReaders() {
  return { read: pid => readKernelProcess(pid), listMembers: pgid => listKernelGroupMembers(pgid) }
}

/**
 * The exact ownership proof for ONE Process Scene Host signal, delegated to the
 * ONE shared predicate: the recorded kernel birth is still the live PID, it is
 * still its own detached group/session leader, and the exact leader PID plus
 * its birth is still a LIVE member of that group. The production kernel-group
 * authority is read immediately before EVERY signal; an unknown/absent/foreign
 * fact refuses the signal instead of falling back to a bare PID.
 */
function assertProcessHostSignalOwnership(handle, reason) {
  return assertKernelGroupSignalOwnership(processKernelReaders(), handle.child.pid, handle.birth, reason)
}

function killProcessHost(handle, signal, reason) {
  assertProcessHostSignalOwnership(handle, reason)
  try {
    process.kill(-handle.child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw new Error(`${reason}: the owned Host group ${String(handle.child.pid)} could not be signalled (${String(error?.code ?? 'unknown')})`)
    }
  }
}

function killOwnedHost(handle, signal) {
  if (handle === undefined || handle.exited) return
  try {
    // This is the ChildProcess handle this supervisor itself created. The
    // detached child is the process-group leader, so the negative PGID names
    // only this generation's process group.
    process.kill(-handle.child.pid, signal)
  } catch {
    try { handle.child.kill(signal) } catch { /* already gone */ }
  }
}

function hostPgid(handle) {
  return handle?.pgid ?? handle?.child?.pid
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function processGroupAlive(pgid) {
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

async function waitForGroupGone(pgid, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!processGroupAlive(pgid)) return
    await sleep(50)
  }
}

/**
 * Bounded wait for one owned group to become terminal under the Process
 * contract: only classifier-LIVE members keep it alive, so a same-birth Linux
 * Z/X/x task is terminal and an unreadable group fails closed. Returns the
 * remaining live member PIDs (empty = terminal).
 */
async function waitForKernelGroupTerminal(pgid, timeoutMs, reason) {
  const started = Date.now()
  for (;;) {
    const live = kernelGroupLiveMemberPids(processKernelReaders(), pgid, reason)
    if (live.length === 0 || Date.now() - started >= timeoutMs) return live
    await sleep(50)
  }
}

async function assertHostGroupGone(handle, reason) {
  const pgid = hostPgid(handle)
  if (!processGroupAlive(pgid)) return
  // The original ChildProcess and its detached PGID are still the identity we
  // created. Give the group a bounded chance to disappear, then fail closed:
  // a live descendant means the generation cannot be called quiesced.
  await waitForGroupGone(pgid, 3_000)
  if (scene?.kind === 'process') {
    // A same-birth Linux Z/X/x task is readable but NOT a live member; only the
    // product classifier may decide liveness, and an unreadable group is
    // unknown ownership rather than an empty (quiesced) group.
    const live = kernelGroupLiveMemberPids(processKernelReaders(), pgid, reason)
    if (live.length > 0) {
      throw new Error(`${reason}: Host process group ${String(pgid)} still has live members: ${JSON.stringify(live)}`)
    }
    return
  }
  if (processGroupAlive(pgid)) {
    throw new Error(`${reason}: Host process group ${String(pgid)} still has live members`)
  }
}

function readHostStarttime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const value = readProcessStarttime(pid)
    if (value !== undefined) return value
  } catch {
    // Fall through to the Darwin kernel clock below.
  }
  if (process.platform === 'darwin') {
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The authoritative kernel Host seat identity for one scope. Linux uses the
 * abstract-socket name; Darwin uses the account-home O_EXLOCK file owned by
 * `darwinHostProfileSeatDir` (NOT the DSH-home scope directory, which owns the
 * qualification-Client seat). The receipt carries this descriptor so the
 * external probe checks the exact same seat the Supervisor does.
 */
function hostSeatDescriptor(scopeId) {
  if (process.platform === 'linux') return { kind: 'linux-abstract', name: `\0dsh-pi-tui-h-${scopeId.slice(0, 40)}` }
  if (process.platform === 'darwin') {
    return { kind: 'darwin-file', path: join(userInfo().homedir, '.dsh-pi-tui', 'run', scopeId, `seat-host-${scopeId}.lock`) }
  }
  throw new Error(`no Host seat descriptor is implemented for ${process.platform}`)
}

/** The qualification-only Client seat of one scope (Linux abstract / Darwin file). */
function qualificationSeatDescriptor(scopeId, dshHome) {
  if (process.platform === 'linux') return { kind: 'linux-abstract', name: `\0dsh-pi-tui-c-${scopeId.slice(0, 40)}` }
  if (process.platform === 'darwin') {
    return { kind: 'darwin-file', path: join(dshHome, 'run', 'dsh-pi-tui', scopeId, `seat-qualification-client-${scopeId}.lock`) }
  }
  throw new Error(`no qualification Client seat descriptor is implemented for ${process.platform}`)
}

/**
 * The serialized kernel birth captured when this generation was spawned. It is
 * a durable fact: re-reading after the child exits would erase the evidence the
 * external probe and the receipt ledger need.
 */
function hostKernelBirth(handle) {
  return handle.birth
}

function publicHostFacts(handle) {
  const scopeId = handle.ready?.localHost?.scopeId
  return {
    id: handle.hostId,
    hostId: handle.hostId,
    entryId: handle.entryId ?? handle.hostId,
    kind: handle.kind ?? 'host',
    mode: handle.mode ?? null,
    expected: handle.expected ?? null,
    generation: handle.generation,
    source: handle.source ?? 'profile',
    pid: handle.child.pid ?? null,
    birth: hostKernelBirth(handle),
    pgid: hostPgid(handle),
    businessPid: handle.businessPid ?? null,
    scopeId: scopeId ?? null,
    seat: typeof scopeId === 'string' && scopeId !== '' ? hostSeatDescriptor(scopeId) : null,
    buildId: handle.buildId,
    entryRealpath: handle.entryRealpath,
    workRoot: handle.workRoot,
    startedAt: handle.startedAt,
    starttime: handle.starttime,
    closedAt: handle.closedAt,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    exited: handle.exited,
    finished: handle.finished === true,
    terminal: handle.terminal ?? null,
  }
}

function hostLedger() {
  return hosts.map(publicHostFacts)
}

function syncHostReceipt() {
  const update = { hosts: hostLedger() }
  // The receipt's `host` row is the ONE accepted live Host, never the latest
  // contender: concurrent attempts are a ledger, not the Scene owner.
  if (activeHost !== undefined) update.host = publicHostFacts(activeHost)
  writeReceipt(update)
}

function publicQualificationClientFacts(handle) {
  return {
    entryId: handle.entryId ?? null,
    kind: handle.kind ?? 'qualification-one-shot',
    label: handle.label ?? null,
    mode: handle.mode ?? null,
    expected: handle.expected ?? null,
    pid: handle.child.pid ?? null,
    birth: handle.birth ?? null,
    pgid: handle.pgid ?? hostPgid(handle),
    starttime: handle.starttime,
    scratch: handle.scratch,
    hostId: handle.hostId ?? handle.expectedHostId ?? null,
    generation: handle.generation ?? null,
    startedAt: handle.startedAt,
    closedAt: handle.closedAt,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    signalIntent: handle.signalIntent ?? null,
    exited: handle.exited,
    finished: handle.finished === true,
    terminal: handle.terminal ?? null,
  }
}

function syncQualificationClientReceipt() {
  writeReceipt({ qualificationClients: qualificationClients.map(publicQualificationClientFacts) })
}

/** Bounded TERM -> KILL reclaim of the ONE Supervisor-owned qualification Client. */
async function terminateQualificationClient(reason) {
  const handle = activeQualificationClient
  if (handle === undefined) return
  if (handle.termination !== undefined) return await handle.termination
  handle.termination = terminateQualificationClientHandle(handle, reason)
  return await handle.termination
}

async function terminateQualificationClientHandle(handle, reason) {
  if (!handle.exited) {
    killOwnedHost(handle, 'SIGTERM')
    try {
      await waitForChildClose(handle.child, TERM_GRACE_MS)
    } catch {
      killOwnedHost(handle, 'SIGKILL')
      try {
        await waitForChildClose(handle.child, KILL_GRACE_MS)
      } catch (error) {
        throw new Error(`qualification Client ${String(handle.child.pid)} did not exit after ${reason}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    handle.exited = true
    handle.exitResult = { code: handle.child.exitCode, signal: handle.child.signalCode }
    handle.closedAt = now()
  }
  await assertHostGroupGone(handle, `qualification Client ${reason}`)
  syncQualificationClientReceipt()
  activeQualificationClient = undefined
  // The qualification Client's own production discovery can spawn a detached
  // Host candidate when the old Host died in the window. It must be reclaimed
  // by this Supervisor before any terminal quiescence claim.
  await reclaimClientFallbackHosts(`qualification Client ${String(handle.child.pid)} ${reason}`)
}

/**
 * Bounded TERM -> KILL reclaim of ONE process qualification entry. Every signal
 * re-proves the exact captured kernel birth; there is no bare-PID fallback.
 */
async function terminateOwnedEntry(handle, reason) {
  if (handle.termination !== undefined) return await handle.termination
  handle.termination = (async () => {
    const signal = value => {
      assertKernelGroupSignalOwnership(processKernelReaders(), handle.child.pid, handle.birth, `${reason}: ${value}`)
      try {
        process.kill(-handle.child.pid, value)
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw new Error(`${reason}: the owned entry group ${String(handle.child.pid)} could not be signalled (${String(error?.code ?? 'unknown')})`)
        }
      }
    }
    if (!handle.exited) {
      const osExited = handle.child.exitCode !== null || handle.child.signalCode !== null
      if (osExited) {
        await waitForEntryClose(handle, `${reason}: pending close`, TERM_GRACE_MS)
        await assertHostGroupGone(handle, reason)
        if (handle === activeQualificationClient) activeQualificationClient = undefined
        syncQualificationClientReceipt?.()
        syncQualificationHelpersReceipt?.()
        return
      }
      try {
        signal('SIGTERM')
      } catch (error) {
        try {
          await waitForEntryClose(handle, `${reason}: refused the SIGTERM as an exited leader`, TERM_GRACE_MS)
        } catch {
          throw error
        }
        await assertHostGroupGone(handle, reason)
        if (handle === activeQualificationClient) activeQualificationClient = undefined
        syncQualificationClientReceipt?.()
        syncQualificationHelpersReceipt?.()
        return
      }
      try {
        await waitForEntryClose(handle, `${reason}: SIGTERM`, TERM_GRACE_MS)
      } catch {
        if (!handle.exited && handle.child.exitCode === null && handle.child.signalCode === null) {
          try {
            signal('SIGKILL')
          } catch (error) {
            try {
              await waitForEntryClose(handle, `${reason}: refused the SIGKILL as an exited leader`, TERM_GRACE_MS)
            } catch {
              throw error
            }
          }
        }
        await waitForEntryClose(handle, `${reason}: SIGKILL`, KILL_GRACE_MS)
      }
    }
    await assertHostGroupGone(handle, reason)
    if (handle === activeQualificationClient) activeQualificationClient = undefined
    syncQualificationClientReceipt()
    syncQualificationHelpersReceipt()
  })()
  return await handle.termination
}

async function terminateAllProcessEntries(reason) {
  const problems = []
  const reclaim = async (handle, label) => {
    try {
      if (!handle.exited) await terminateOwnedEntry(handle, label)
      else await assertHostGroupGone(handle, label)
      if (handle.witnessKind === 'linux-zombie' && Number.isInteger(handle.witnessPid)) {
        const observation = readKernelProcess(handle.witnessPid)
        if (observation.kind === 'unknown') {
          throw new Error(`${label}: the zombie witness identity is unverifiable`)
        }
        if (observation.kind === 'alive' && observation.identity.state !== 'Z' && observation.identity.state !== 'X'
          && (handle.witnessBirth === undefined || serializeKernelIdentity(observation.identity) === handle.witnessBirth)) {
          throw new Error(`${label}: the zombie witness ${String(handle.witnessPid)} is still live`)
        }
      }
    } catch (error) {
      problems.push({ entryId: handle.entryId, kind: handle.kind ?? null, error: boundedError(error) })
    }
  }
  for (const handle of [...qualificationClients].reverse()) {
    if (handle.kind !== 'qualification-client') continue
    await reclaim(handle, `${reason}: qualification Client`)
  }
  for (const handle of [...qualificationHelpers].reverse()) {
    await reclaim(handle, `${reason}: ${entryKindLabel(handle)}`)
  }
  return problems
}

/** The Darwin qualification-Client seat is an O_EXLOCK file inside the scope. */
async function assertClientSeatFree(installation, scopeId, reason) {
  if (process.platform === 'linux') {
    const free = await seatIsFree(`\0dsh-pi-tui-c-${scopeId.slice(0, 40)}`)
    if (!free) throw new Error(`${reason}: the qualification Client seat is still held`)
    return
  }
  if (process.platform === 'darwin') {
    // O_RDWR|O_EXLOCK|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC; Node omits O_EXLOCK from
    // fs.constants, so the Darwin ABI numbers are named explicitly. No O_CREAT.
    const flags = 2 | 32 | 4 | 256 | 16777216
    const path = join(installation.dshHome, 'run', 'dsh-pi-tui', scopeId, `seat-qualification-client-${scopeId}.lock`)
    const started = Date.now()
    for (;;) {
      try {
        closeSync(openSync(path, flags, 0o600))
        return
      } catch (error) {
        if (error?.code === 'ENOENT') return
        if (error?.code !== 'EAGAIN' && error?.code !== 'EWOULDBLOCK') throw error
        if (Date.now() - started > 15_000) throw new Error(`${reason}: the qualification Client seat is still held`)
        await sleep(50)
      }
    }
  }
  throw new Error(`${reason}: no qualification Client seat probe is implemented for ${process.platform}`)
}

/** Await ONE official qualification record; a failure record fails immediately. */
async function waitForQualificationRecord(handle, predicate, label, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const record = handle.records.find(predicate)
    if (record !== undefined) return record
    const failure = handle.records.find(value => value?.m4a0 === 'failure' || value?.m4a0 === 'control-failure' || value?.m4a0 === 'control-error')
    if (failure !== undefined) {
      throw new Error(`${label}: the qualification Client reported ${String(failure.m4a0)} (code=${String(failure.code ?? 'none')}, phase=${String(failure.phase ?? 'none')})`)
    }
    if (handle.spawnError !== undefined) throw new Error(`${label}: qualification Client spawn failed (${boundedError(handle.spawnError)})`)
    if (handle.exited) throw new Error(`${label}: qualification Client exited before the record`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    await sleep(20)
  }
}

// ── process Scene: immutable input, native Client ownership, closing fence ──
// The Supervisor is the ONLY owner of a process Scene's native tui-test handle.
// A Worker receives typed facts and bounded operations; it never runs a native
// terminal call, so a Worker SIGKILL can never strand a PTY session in a dead
// process.

function requireProcessScene(label) {
  if (scene?.kind !== 'process' || scene.installation === undefined) {
    throw new Error(`${label}: no process scene`)
  }
  return scene
}

/** Re-read the frozen installed package and refuse a payload/build change. */
function assertProcessInstalledFacts(label) {
  requireProcessScene(label)
  if (processCandidate === undefined) throw new Error(`${label}: the process candidate is not recorded`)
  const facts = installedPackageFacts(
    scene.installation.profilePackage,
    processCandidate.manifest?.version,
    processCandidate.targetDshVersion,
    label,
  )
  if (facts.payloadHash !== scene.installFacts.payloadHash || facts.buildId !== scene.installFacts.buildId) {
    throw codedInputError('INPUT_CANDIDATE_CHANGED', `${label}: the installed package payload changed after its installation`)
  }
  if (processScope === undefined || facts.buildId !== processScope.buildId) {
    throw codedInputError('INPUT_CANDIDATE_CHANGED', `${label}: the installed build identity changed after its installation`)
  }
  return facts
}

/** One Client's real OS ownership facts, captured from the kernel. */
function captureProcessClientIdentity(pid, label, { expectedEntry, scratch }) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the official record carries no real business PID`)
  }
  const snapshot = nativeProcessSnapshot(pid)
  if (snapshot === null) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} has no readable kernel identity`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && snapshot.uid !== uid) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} is not owned by this user`)
  }
  const entry = realpathSync(expectedEntry)
  if (!snapshot.command.includes(entry)) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} does not run the installed Client entry`)
  }
  if (processEnvironmentValue(pid, 'SPLIT_PROCESS_SCRATCH') !== scratch) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} does not carry this Client's scratch`)
  }
  if (processEnvironmentValue(pid, 'DSH_HOME') !== scene.installation.dshHome) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} does not carry this Scene's DSH home`)
  }
  const observation = readKernelProcess(pid)
  if (observation.kind !== 'alive') {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} disappeared while its identity was captured`)
  }
  if (serializeKernelIdentity(observation.identity) !== snapshot.birth) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: business PID ${String(pid)} changed between its ownership snapshot and its kernel identity`)
  }
  return { identity: observation.identity, uid: snapshot.uid, command: snapshot.command, birth: snapshot.birth }
}

function publicProcessClientFacts(handle) {
  return {
    kind: 'process',
    clientId: handle.clientId,
    label: handle.label,
    sessionId: handle.sessionId,
    hostId: handle.hostId,
    generation: handle.generation,
    cwd: handle.cwd,
    home: handle.home,
    scratch: handle.scratch,
    recordFile: handle.recordFile,
    expectedEntry: handle.expectedEntry,
    hmr: handle.hmr ?? null,
    dropPromptAck: handle.dropPromptAck === true,
    terminal: handle.terminalMode ?? null,
    ownerPid: handle.owner?.pid ?? null,
    ownerBirth: handle.owner?.birth ?? null,
    ownerExit: handle.owner?.exit ?? null,
    ptyOwnerFacts: handle.ptyOwnerFacts ?? null,
    verifiedTerminal: handle.verifiedTerminal ?? null,
    shellPid: handle.shellPid,
    shellBirth: handle.shellIdentity?.birth,
    businessPids: handle.businessPids,
    businessIdentities: handle.businessIdentities.map(value => ({
      pid: value.identity.pid,
      birth: value.birth,
      uid: value.uid,
    })),
    readyHost: handle.readyHost,
    reservedAt: handle.reservedAt,
    openedAt: handle.openedAt,
    readyAt: handle.readyAt,
    exited: handle.exited,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    closedAt: handle.closedAt,
  }
}

function syncProcessClientsReceipt() {
  writeReceipt({
    processClients: processClients.map(publicProcessClientFacts),
    processNativeOperation,
  })
}

function processClientById(clientId, label) {
  const handle = processClients.find(client => client.clientId === clientId)
  if (handle === undefined) throw new Error(`${label}: unknown clientId ${String(clientId)}`)
  return handle
}

/**
 * Register the ONE native operation synchronously, BEFORE its first await.
 * The closing fence waits on this fact; it never deletes a root a live native
 * operation still owns.
 */
async function withProcessNativeOperation(description, clientId, body) {
  if (processNativeOperation !== undefined) {
    throw new Error(`NATIVE_OPERATION_IN_FLIGHT: ${description} cannot start while ${processNativeOperation.description} is unsettled`)
  }
  const operation = { description, clientId, startedAt: now() }
  processNativeOperation = operation
  writeReceipt({ processNativeOperation: operation })
  try {
    return await body()
  } finally {
    if (processNativeOperation === operation) processNativeOperation = undefined
    writeReceipt({ processNativeOperation: processNativeOperation ?? undefined })
  }
}

/** Await the real settlement of the in-flight native operation, bounded. */
async function settlePendingProcessNativeOperation(reason) {
  const operation = processNativeOperation
  if (operation === undefined) return
  appendNote('process-native-operation-pending', {
    description: operation.description,
    clientId: operation.clientId,
    startedAt: operation.startedAt,
  })
  writeReceipt({})
  const started = Date.now()
  while (processNativeOperation === operation && Date.now() - started < 120_000) await sleep(50)
  if (processNativeOperation === operation) {
    throw new Error(`${reason}: the native operation ${operation.description} did not settle within 120000ms; the Scene is NOT_QUIESCED`)
  }
}

/**
 * Read the official Client ledger while the Client is still producing it. A
 * torn tail is not durable yet; a malformed COMPLETE line still fails.
 */
async function waitForProcessClientRecord(handle, predicate, label, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const records = readOfficialClientRecords(handle.recordFile, label, { allowIncompleteTail: true })
    const record = records.find(predicate)
    if (record !== undefined) return record
    const failure = records.find(value => value?.m4a0 === 'failure' || value?.m4a0 === 'control-failure')
    if (failure !== undefined) {
      throw new Error(`${label}: the Client reported ${String(failure.m4a0)} (code=${String(failure.code ?? 'none')}, phase=${String(failure.phase ?? 'none')})`)
    }
    if (handle.exited) throw new Error(`${label}: the Client exited before the record`)
    if (lifecycleClosed) throw new Error(`${label}: the Supervisor lifecycle closed while the record was awaited`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    await sleep(25)
  }
}

/** The exact installed Host identity facts a Client ready record must match. */
function assertProcessHostRecord(handle, record, label) {
  const host = record.host
  if (host === undefined || host === null) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the record carries no authenticated Host facts`)
  }
  if (host.scopeId !== processScope.scopeId) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the record names another Host scope`)
  }
  if (host.buildId !== handle.expectedBuildId) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the record names Host build ${String(host.buildId)}, not the installed ${String(handle.expectedBuildId)}`)
  }
  if (!Number.isInteger(host.hostPid) || host.hostPid <= 0) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the record carries no real Host PID`)
  }
  return host
}

function assertHostIdentityMatchesKernel(hostFacts, hostPid, label) {
  if (hostFacts.hostPid !== hostPid) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the authenticated Host PID ${String(hostFacts.hostPid)} is not the Scene's Host ${String(hostPid)}`)
  }
  const expected = readHostStarttime(hostPid)
  if (expected === undefined) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the Scene Host has no readable kernel birth`)
  }
  if (hostFacts.schema === 1 && hostFacts.hostStarttime !== expected) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the authenticated Host birth is not the live kernel birth`)
  }
  if (hostFacts.schema === 2) {
    const observation = readKernelProcess(hostPid)
    if (observation.kind !== 'alive') {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the Scene Host kernel identity is unreadable`)
    }
    const kernel = hostFacts.hostKernelIdentity
    if (kernel === undefined || kernel.uniqueId !== observation.identity.uniqueId || kernel.pid !== hostPid) {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the authenticated Host kernel identity is not the live kernel identity`)
    }
  }
}

/**
 * The only probe-window hold inside this Supervisor. The durable checkpoint is
 * written BEFORE the hold; the hold is bounded (120s) and only an external
 * Worker death releases it. After release the handler always fails: no probe
 * mode may return a PASS by itself.
 */
async function processProbeHold(point, detail, options = {}) {
  if (process.env.SPLIT_VITEST_PROCESS_PROBE_POINT !== point) return
  appendNote('process-probe-hold', { point, ...detail })
  writeReceipt({ phase: `PROCESS_PROBE_${point.toUpperCase().replaceAll('-', '_')}_HOLD` })
  await waitForWorkerKillBarrier()
  if (options.continueAfterKill === true) {
    appendNote('process-probe-continued', { point })
    return
  }
  throw new Error(`the worker was killed at the ${point} probe point`)
}

/**
 * The whole command line of one live process, or undefined when unreadable.
 */
function processCommandLine(pid) {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').join(' ').trim()
    } catch {
      return undefined
    }
  }
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/**
 * Whether one live process carries exactly `entry` in its environment.
 * `undefined` means the environment could not be read (never a false negative).
 */
function processEnvironmentContains(pid, entry) {
  if (process.platform === 'linux') {
    let raw
    try {
      raw = readFileSync(`/proc/${String(pid)}/environ`, 'utf8')
    } catch {
      return undefined
    }
    return raw.split('\0').includes(entry)
  }
  let raw
  try {
    raw = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  } catch {
    return undefined
  }
  return raw.split(/\s+/u).includes(entry)
}

/**
 * Every `local-host.mjs` process whose entry lives under THIS Scene root. The
 * product's qualification/legacy discovery fallback spawns such a Host
 * detached; it is not a ChildProcess this Supervisor created, so it can only be
 * found by its real command line and the Client scratch it inherited.
 */
function sceneLocalHostCandidates() {
  if (scene === undefined) return []
  const pids = []
  if (process.platform === 'linux') {
    let entries
    try {
      entries = readdirSync('/proc')
    } catch (error) {
      throw new Error(`the local Host fallback audit cannot enumerate /proc: ${boundedError(error)}`)
    }
    for (const name of entries) {
      if (!/^\d+$/u.test(name)) continue
      const pid = Number(name)
      if (pid === process.pid) continue
      const command = processCommandLine(pid)
      if (command === undefined) continue
      if (!command.includes('local-host.mjs') || !command.includes(scene.workDir)) continue
      pids.push(pid)
    }
    return pids
  }
  let listing
  try {
    listing = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`the local Host fallback audit cannot enumerate processes: ${boundedError(error)}`)
  }
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    const command = match[2]
    if (!command.includes('local-host.mjs') || !command.includes(scene.workDir)) continue
    pids.push(pid)
  }
  return pids
}

function isKnownHostEntryProcess(pid) {
  return hosts.some(handle => handle.child.pid === pid)
    || publicHosts.some(host => host.pid === pid)
}

function clientScratchOrigins() {
  const origins = new Map()
  for (const client of receipt?.clients ?? []) {
    if (typeof client.scratch === 'string' && client.scratch !== '') origins.set(client.scratch, `surface-client:${String(client.label)}`)
  }
  for (const qualification of qualificationClients) {
    origins.set(qualification.scratch, `qualification-client:${String(qualification.child.pid)}`)
  }
  for (const client of receipt?.processClients ?? []) {
    if (typeof client.scratch === 'string' && client.scratch !== '') {
      origins.set(client.scratch, `split-process-client:${String(client.label)}`)
    }
  }
  return origins
}

function syncFallbackHostsReceipt() {
  writeReceipt({ fallbackHosts })
}

/**
 * The authoritative ownership proof of ONE discovery-fallback Host in a
 * process Scene, taken immediately before a signal: uid, the live kernel
 * identity, the detached group/session it leads, the installed Host entry
 * under this Scene root, the registered Client scratch, this Scene's DSH home
 * and the product scope registry naming that exact live process.
 *
 * Any mismatch or unreadable fact is unknown ownership: the caller fails
 * closed (NOT_QUIESCED), never falls back to a bare PID signal.
 */
function assertProcessFallbackOwnership(pid, scratch, registered, reason) {
  if (processScope === undefined || scene?.kind !== 'process') {
    throw new Error(`${reason}: the process Scene scope is not recorded`)
  }
  const snapshot = nativeProcessSnapshot(pid)
  if (snapshot === null) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} has no readable kernel identity`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && snapshot.uid !== uid) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} is not owned by this user`)
  }
  const hostEntry = realpathSync(scene.installFacts.entries.host)
  if (!snapshot.command.includes('local-host.mjs')
    || !snapshot.command.includes(scene.workDir)
    || !snapshot.command.includes(hostEntry)) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} does not run this Scene's installed Host entry`)
  }
  if (processEnvironmentValue(pid, 'SPLIT_PROCESS_SCRATCH') !== scratch) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} does not carry the registered Client scratch`)
  }
  if (processEnvironmentValue(pid, 'DSH_HOME') !== scene.installation.dshHome) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} does not carry this Scene's DSH home`)
  }
  const observation = readKernelProcess(pid)
  const liveness = classifyKernelLiveness(observation)
  if (liveness.state !== 'alive') {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} has no live kernel identity (${liveness.state})`)
  }
  const identity = observation.identity
  // The ownership snapshot and this later identity read must describe the SAME
  // kernel process, exactly like the Client identity capture: a torn or re-used
  // read is unknown ownership, never a signallable candidate.
  if (serializeKernelIdentity(identity) !== snapshot.birth) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} changed between its ownership snapshot and its kernel identity`)
  }
  // The detached Host is the leader of its OWN process group AND session; only
  // such a group can be signalled as one owned unit.
  if (identity.pgid !== pid || identity.sid !== pid) {
    throw new Error(`${reason}: fallback Host PID ${String(pid)} is not the detached group/session leader this Scene created`)
  }
  if (registered !== undefined) {
    if (registered.birth !== snapshot.birth) {
      throw new Error(`${reason}: fallback Host PID ${String(pid)} is not the kernel process this Scene registered`)
    }
    if (registered.scratch !== scratch) {
      throw new Error(`${reason}: fallback Host PID ${String(pid)} does not match its registered scratch`)
    }
  }
  let registry
  try {
    registry = JSON.parse(readFileSync(join(processScope.dir, 'instance.json'), 'utf8'))
  } catch (error) {
    throw new Error(`${reason}: the product scope registry for fallback Host PID ${String(pid)} cannot be read (${boundedError(error)})`)
  }
  if (registry?.scopeId !== processScope.scopeId || registry?.hostPid !== pid) {
    throw new Error(`${reason}: the product scope registry does not name fallback Host PID ${String(pid)} in this scope`)
  }
  if (registered !== undefined && registry.instanceId !== registered.instanceId) {
    throw new Error(`${reason}: the product scope registry names another Host instance than the one this Scene registered`)
  }
  if (registry.schema === 1) {
    if (registry.hostStarttime !== readHostStarttime(pid)) {
      throw new Error(`${reason}: the registry Host starttime is not the live kernel birth`)
    }
  } else if (registry.schema === 2) {
    if (sameKernelProcess(registry.hostKernelIdentity, observation) !== 'same') {
      throw new Error(`${reason}: the registry Host kernel identity is not the live kernel identity`)
    }
  } else {
    throw new Error(`${reason}: the product scope registry carries an unsupported Host identity schema`)
  }
  return { identity, birth: snapshot.birth, registry }
}

/** Reclaim ONE detached discovery-fallback Host by its real kernel identities. */
async function reclaimFallbackHost(pid, origin, scratch, reason, processOwner) {
  const command = processCommandLine(pid)
  if (command === undefined || !command.includes('local-host.mjs')) {
    throw new Error(`${reason}: the fallback Host candidate ${String(pid)} is no longer a Host entry process`)
  }
  const starttime = readHostStarttime(pid)
  if (starttime === undefined) {
    throw new Error(`${reason}: the fallback Host candidate ${String(pid)} has no readable OS starttime`)
  }
  // A process Scene registers a discovery fallback while it is still live, so
  // the terminal reclaim must UPDATE that durable fact instead of appending a
  // second, contradictory ledger row.
  const existing = fallbackHosts.find(entry => entry.pid === pid && entry.starttime === starttime && entry.reclaimed !== true)
  const record = existing ?? {
    pid,
    pgid: pid,
    starttime,
    origin,
    scratch,
    detectedAt: now(),
    reclaimed: false,
    exitObserved: undefined,
  }
  const strict = processOwner === true
    ? assertProcessFallbackOwnership(pid, scratch,
      fallbackHosts.find(entry => entry.pid === pid && entry.starttime === starttime && entry.reclaimed !== true), reason)
    : undefined
  // A detached Host candidate is its own process-group leader. In a process
  // Scene the strict proof above already rejected any other shape; there is no
  // bare-PID fallback because a group-signal failure is not an ownership proof.
  //
  // Every signal re-proves the exact captured ownership IMMEDIATELY before it,
  // including the TERM -> KILL escalation. A leader that already exited while
  // members remain cannot authorize signalling the numeric group: that is
  // refused and the evidence is preserved instead of a blanket reclaim.
  const signalGroup = signal => {
    if (strict !== undefined) {
      assertKernelGroupSignalOwnership(processKernelReaders(), pid, strict.birth, `${reason}: ${signal}`)
    }
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if (strict !== undefined) {
        if (error?.code !== 'ESRCH') {
          throw new Error(`${reason}: the owned fallback Host group ${String(pid)} could not be signalled (${String(error?.code ?? 'unknown')})`)
        }
        return false
      }
      try { process.kill(pid, signal) } catch { /* already gone */ }
    }
    return true
  }
  signalGroup('SIGTERM')
  if (strict === undefined) {
    // Legacy Pilot/Upgrade policy is unchanged: numeric group liveness.
    await waitForGroupGone(pid, TERM_GRACE_MS)
    if (processGroupAlive(pid)) {
      signalGroup('SIGKILL')
      await waitForGroupGone(pid, KILL_GRACE_MS)
    }
    if (processGroupAlive(pid) || pidAlive(pid)) {
      throw new Error(`${reason}: the fallback Host ${String(pid)} is still alive after TERM/KILL`)
    }
    const currentStarttime = readHostStarttime(pid)
    if (currentStarttime !== undefined && currentStarttime !== starttime) {
      throw new Error(`${reason}: the fallback Host PID ${String(pid)} was reused by another process during reclaim`)
    }
  } else {
    // Process terminal classification uses the SAME shared contract as the
    // signal fence: the grace wait counts only classifier-LIVE members, so a
    // same-birth Z/X/x leader/group is terminal without a KILL escalation. Only
    // a still-live captured leader may authorize the freshly fenced escalation;
    // a gone/reused leader or an unreadable group never authorizes a signal.
    let remaining = await waitForKernelGroupTerminal(pid, TERM_GRACE_MS, reason)
    if (remaining.length > 0) {
      const leaderState = processIdentityState(strict.identity)
      if (leaderState === 'unknown') {
        throw new Error(`${reason}: the fallback Host leader state is unverifiable; refusing the KILL escalation`)
      }
      if (leaderState === 'alive') {
        signalGroup('SIGKILL')
        remaining = await waitForKernelGroupTerminal(pid, KILL_GRACE_MS, reason)
      }
    }
    const state = processIdentityState(strict.identity)
    if (state === 'unknown') {
      throw new Error(`${reason}: the reclaimed fallback Host PID ${String(pid)} is unverifiable`)
    }
    if (state === 'alive' || remaining.length > 0) {
      const members = remaining.length > 0 ? `; live group members: ${JSON.stringify(remaining)}` : ''
      throw new Error(`${reason}: the fallback Host PID ${String(pid)} is still ${state}${members}`)
    }
  }
  record.reclaimed = true
  record.exitObserved = 'group-gone'
  record.reclaimedAt = now()
  if (existing === undefined) fallbackHosts.push(record)
  syncFallbackHostsReceipt()
  appendNote('fallback-host-reclaimed', { pid, pgid: pid, starttime, origin, scratch })
  return record
}

/**
 * Detect and reclaim every detached Host a Scene Client's discovery fallback
 * started. A Host under this Scene root that cannot be attributed to a
 * registered Client is unknown ownership: fail closed, never report clean.
 */
async function reclaimClientFallbackHosts(reason) {
  if (scene?.kind !== 'upgrade' && scene?.kind !== 'process') return []
  const reclaimed = []
  const pass = async () => {
    const origins = clientScratchOrigins()
    for (const pid of sceneLocalHostCandidates()) {
      if (isKnownHostEntryProcess(pid)) continue
      let matched
      for (const [scratch, origin] of origins) {
        const present = processEnvironmentContains(pid, `SPLIT_PROCESS_SCRATCH=${scratch}`)
        if (present === undefined) {
          throw new Error(`${reason}: the environment of local Host process ${String(pid)} cannot be read; its ownership is unknown`)
        }
        if (present) {
          matched = { scratch, origin }
          break
        }
      }
      if (matched === undefined) {
        throw new Error(`${reason}: local Host process ${String(pid)} under the Scene root is not attributable to any registered Client`)
      }
      reclaimed.push(await reclaimFallbackHost(pid, matched.origin, matched.scratch, reason, scene.kind === 'process'))
    }
  }
  await pass()
  // A detached spawn forks BEFORE it execs the Host entry, so one settling
  // window plus a second pass closes the fork->exec observation race. This is
  // not a readiness sleep: a still-live or unattributable Host always fails.
  await sleep(250)
  const second = sceneLocalHostCandidates().filter(pid => !isKnownHostEntryProcess(pid))
  if (second.length > 0) await pass()
  const remaining = sceneLocalHostCandidates().filter(pid => !isKnownHostEntryProcess(pid))
  if (remaining.length > 0) {
    throw new Error(`${reason}: local Host process(es) ${JSON.stringify(remaining)} are still present after the fallback reclaim`)
  }
  return reclaimed
}

function latestHostScopeId() {
  for (let index = hosts.length - 1; index >= 0; index -= 1) {
    const scopeId = hosts[index].ready?.localHost?.scopeId
    if (typeof scopeId === 'string' && scopeId !== '') return scopeId
  }
  return undefined
}

/**
 * The kernel Host seat must be free once every Supervisor-owned generation
 * exited. A still-live fallback Host would hold it; this is the terminal proof.
 */
async function assertSceneHostSeatFree(reason) {
  // A process Scene knows its installed scope BEFORE any Host is ready, so a
  // before-Ready crash (or a discovery fallback Host) still audits the exact
  // kernel seat it claimed.
  const processSeatScopeId = scene?.kind === 'process' ? processScope?.scopeId : undefined
  if (hosts.length === 0 && processSeatScopeId === undefined) return
  if (hosts.some(handle => !handle.exited)) return
  const scopeId = latestHostScopeId() ?? processSeatScopeId
  if (scopeId === undefined) {
    // A Host killed before its ready record never published a scope identity
    // (the Pilot host-spawned-before-ack barrier). Its own process group is
    // already proven gone, so no seat can be named authoritatively; record the
    // truthful skip instead of inventing a scope.
    appendNote('host-seat-audit-skipped', { reason, detail: 'no Host generation published a scope identity' })
    writeReceipt({})
    return
  }
  const seat = hostSeatDescriptor(scopeId)
  if (seat.kind === 'linux-abstract') {
    const free = await seatIsFree(seat.name)
    if (!free) throw new Error(`${reason}: the Host seat is still held after every Host generation exited`)
    return
  }
  // Darwin: O_RDWR|O_EXLOCK|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC, no O_CREAT.
  const flags = 2 | 32 | 4 | 256 | 16777216
  const started = Date.now()
  for (;;) {
    try {
      closeSync(openSync(seat.path, flags, 0o600))
      return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (error?.code !== 'EAGAIN' && error?.code !== 'EWOULDBLOCK') throw error
      if (Date.now() - started > 15_000) throw new Error(`${reason}: the Host seat is still held after every Host generation exited`)
      await sleep(50)
    }
  }
}

/** Test-only fault injection: simulate an abrupt old-Host crash in one window. */
async function waitForHostClose(handle, label, timeoutMs) {
  if (handle.closePromise === undefined) {
    // A spawn that produced no PID has no close event; its failure is committed
    // by the spawn-error path, never invented here.
    throw new Error(`${label}: the Host has no registered close event`)
  }
  return await waitForEntryClose(handle, label, timeoutMs)
}

async function crashHost(handle, reason) {
  if (handle.exited) return
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    await waitForHostClose(handle, `Host ${String(handle.child.pid)} pending close`, KILL_GRACE_MS)
    await assertHostGroupGone(handle, reason)
    if (activeHost === handle) activeHost = undefined
    syncHostReceipt()
    return
  }
  if (scene?.kind === 'process') killProcessHost(handle, 'SIGKILL', `crashHost:${reason}`)
  else killOwnedHost(handle, 'SIGKILL')
  try {
    await waitForHostClose(handle, `Host ${String(handle.child.pid)} after ${reason}`, KILL_GRACE_MS)
  } catch (error) {
    throw new Error(`Host ${String(handle.child.pid)} did not close after ${reason}: ${error instanceof Error ? error.message : String(error)}`)
  }
  await assertHostGroupGone(handle, reason)
  if (activeHost === handle) activeHost = undefined
  syncHostReceipt()
}

async function terminateHost(handle, reason) {
  if (handle === undefined) return { code: null, signal: null, alreadyGone: true }
  if (handle.exited) {
    await assertHostGroupGone(handle, reason)
    return handle.exitResult ?? { code: handle.child.exitCode, signal: handle.child.signalCode }
  }
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    await waitForHostClose(handle, `Host ${String(handle.child.pid)} pending close`, KILL_GRACE_MS)
    await assertHostGroupGone(handle, reason)
    return handle.exitResult ?? { code: null, signal: null }
  }
  const kill = signal => {
    if (scene?.kind === 'process') killProcessHost(handle, signal, `terminateHost:${reason}`)
    else killOwnedHost(handle, signal)
  }
  try {
    kill('SIGTERM')
  } catch (error) {
    try {
      await waitForHostClose(handle, `Host ${String(handle.child.pid)} refused the SIGTERM as an exited leader`, TERM_GRACE_MS)
    } catch {
      throw error
    }
    await assertHostGroupGone(handle, reason)
    syncHostReceipt()
    return handle.exitResult
  }
  try {
    await waitForHostClose(handle, `Host ${String(handle.child.pid)} after ${reason}`, TERM_GRACE_MS)
  } catch {
    if (!handle.exited && handle.child.exitCode === null && handle.child.signalCode === null) {
      try {
        kill('SIGKILL')
      } catch (error) {
        try {
          await waitForHostClose(handle, `Host ${String(handle.child.pid)} refused the SIGKILL as an exited leader`, TERM_GRACE_MS)
        } catch {
          throw error
        }
      }
    }
    try {
      await waitForHostClose(handle, `Host ${String(handle.child.pid)} after ${reason} SIGKILL`, KILL_GRACE_MS)
    } catch (error) {
      throw new Error(`Host ${String(handle.child.pid)} did not close after ${reason}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await assertHostGroupGone(handle, reason)
  syncHostReceipt()
  return handle.exitResult
}

async function officialStopHost(handle = activeHost) {
  if (handle === undefined) throw new Error('STOP_HOST: no Host exists in this scene')
  if (handle.exited) {
    await assertHostGroupGone(handle, 'STOP_HOST')
    const result = handle.exitResult ?? { code: handle.child.exitCode, signal: handle.child.signalCode }
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`STOP_HOST: Host had already exited abnormally: ${JSON.stringify(result)}`)
    }
    return result
  }
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    const result = await waitForHostClose(handle, 'STOP_HOST pending close', KILL_GRACE_MS)
    await assertHostGroupGone(handle, 'STOP_HOST')
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`STOP_HOST: official shutdown was abnormal: ${JSON.stringify(result)}`)
    }
    if (activeHost === handle) activeHost = undefined
    syncHostReceipt()
    return result
  }
  try {
    handle.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
    const result = await waitForHostClose(handle, 'STOP_HOST', HOST_SHUTDOWN_GRACE_MS)
    await assertHostGroupGone(handle, 'STOP_HOST')
    if (activeHost === handle) activeHost = undefined
    syncHostReceipt()
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`STOP_HOST: official shutdown was abnormal: ${JSON.stringify(result)}`)
    }
    return result
  } catch (error) {
    await terminateHost(handle, 'STOP_HOST timeout').catch(() => undefined)
    if (activeHost === handle) activeHost = undefined
    throw error
  }
}

async function cleanupSceneRoot(reason) {
  if (scene === undefined) return
  const root = scene.workDir
  rmSync(root, { recursive: true, force: true })
  if (existsSync(root)) throw new Error(`${reason}: scene root still exists after removal: ${root}`)
}

function assertOwnedRecordFile(recordFile, label) {
  if (typeof recordFile !== 'string' || recordFile === '') {
    throw new Error(`${label}: the Client receipt carries no recordFile`)
  }
  const real = realpathSync(recordFile)
  const rel = relative(scene.workDir, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label}: the recordFile is outside the Scene root: ${real}`)
  }
  return real
}

/** Validate one Client scratch directory the Supervisor may later audit. */
function assertOwnedSceneDirectory(directory, label) {
  if (typeof directory !== 'string' || directory === '') {
    throw new Error(`${label}: the Client receipt carries no scratch directory`)
  }
  const real = realpathSync(directory)
  const rel = relative(scene.workDir, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label}: the scratch directory is outside the Scene root: ${real}`)
  }
  return real
}

function readClientRecordLedger(recordFile, label) {
  const text = readFileSync(recordFile, 'utf8')
  if (text === '') throw new Error(`${label}: the official Client record file is empty`)
  if (!text.endsWith('\n')) throw new Error(`${label}: the official Client record file has an incomplete trailing line`)
  const pids = new Set()
  const lines = text.slice(0, -1).split('\n')
  for (const [index, line] of lines.entries()) {
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`${label}: client record line ${String(index + 1)} is invalid JSON: ${boundedError(error)}`)
    }
    if (record?.m4a0 !== 'client-started' && record?.m4a0 !== 'ready') continue
    if (!Number.isInteger(record.pid) || record.pid <= 0) {
      throw new Error(`${label}: client record line ${String(index + 1)} carries no real business PID`)
    }
    pids.add(record.pid)
  }
  if (pids.size === 0) throw new Error(`${label}: the official Client record file carries no client-started/ready PID`)
  return { pids: [...pids], records: lines.length }
}

function auditClientLedger(reason) {
  if (scene?.kind !== 'upgrade') return
  const problems = []
  for (const client of receipt.clients ?? []) {
    let ledger
    try {
      ledger = readClientRecordLedger(assertOwnedRecordFile(client.recordFile, client.label), client.label)
    } catch (error) {
      problems.push(boundedError(error))
      continue
    }
    const reported = new Set(Array.isArray(client.businessPids) ? client.businessPids : [])
    const facts = new Map((client.businessPidFacts ?? []).map(value => [value.pid, value.starttime]))
    for (const pid of ledger.pids) {
      // The worker may be SIGKILLed after the official JSONL records a
      // replacement Client but before its PID REPORT reaches this Supervisor.
      // A dead ledger PID is proven gone; only a LIVE PID whose reported OS
      // starttime still matches is an unresolved owner. A live PID reused by
      // an unrelated process (different starttime) is not this Scene's.
      if (!pidAlive(pid)) continue
      if (!reported.has(pid)) {
        problems.push(`${String(client.label)}: live unreported business PID ${String(pid)} cannot be proven dead or foreign`)
        continue
      }
      const expectedStarttime = facts.get(pid)
      if (expectedStarttime === undefined) {
        problems.push(`${String(client.label)}: live business PID ${String(pid)} has no reported OS starttime`)
        continue
      }
      const actualStarttime = readHostStarttime(pid)
      if (actualStarttime === undefined) {
        problems.push(`${String(client.label)}: live business PID ${String(pid)} has no readable OS starttime`)
        continue
      }
      if (actualStarttime !== expectedStarttime) continue
      problems.push(`${String(client.label)}: business PID ${String(pid)} is still alive`)
    }
    if (pidAlive(client.shellPid)) problems.push(`${String(client.label)}: tui-test shell PID ${String(client.shellPid)} is still alive`)
  }
  if (problems.length > 0) {
    throw new Error(`${reason}: Client ledger audit failed: ${problems.join('; ')}`)
  }
}

/** The ONE lifecycle gate: once closing, no new process may start. */
function assertLifecycleOpen(label) {
  if (lifecycleClosed || disconnected) {
    throw new Error(`${label}: the Supervisor lifecycle is closing; no new process may start`)
  }
}

/**
 * Close the ONE Supervisor lifecycle, drain the in-flight request chain with a
 * bounded wait, then reclaim every owned resource. A request that is still
 * pending after the bound cannot create anything: every spawn re-checks
 * `assertLifecycleOpen` synchronously before it runs.
 */
async function closeLifecycle(reason) {
  lifecycleClosed = true
  if (cleanupPromise !== undefined) return await cleanupPromise
  await Promise.race([queue.catch(() => undefined), sleep(5_000)])
  return await cleanup(reason)
}

async function cleanup(reason, options = {}) {
  const preserve = options.preserveRoot === true
  lifecycleClosed = true
  if (finalized) return { clean: true }
  if (cleanupPromise !== undefined) return await cleanupPromise
  cleanupPromise = (async () => {
    let clean = true
    // A synchronous real installer may still be running inside a bootstrap
    // handler. Removing its root or reporting a terminal phase while it writes
    // would be a false quiescence; wait for the real settlement first.
    if (installInProgress) {
      const installStarted = Date.now()
      while (installInProgress && Date.now() - installStarted < 600_000) await sleep(100)
      if (installInProgress) {
        throw new Error(`${reason}: the profile install did not settle within 600000ms; the Scene is NOT_QUIESCED`)
      }
    }
    writeReceipt({
      phase: 'CLEANUP_STARTED',
      notes: [...(receipt?.notes ?? []), { event: 'cleanup-started', detail: { reason }, at: now() }],
    })
    if (options.failure !== undefined && scene?.kind === 'process') {
      const liveClients = qualificationClients.filter(handle => !handle.exited).map(handle => ({
        entryId: handle.entryId, pid: handle.child.pid, birth: handle.birth,
      }))
      const liveHelpers = qualificationHelpers.filter(handle => !handle.exited).map(handle => ({
        entryId: handle.entryId, pid: handle.child.pid, birth: handle.birth,
      }))
      appendNote('finalize-compensation-started', { liveClients, liveHelpers, reason })
      await processProbeHold('finalize-compensation-started', { liveClients, liveHelpers }, { continueAfterKill: true })
    }
    try {
      // The one-shot qualification Client is a Supervisor-owned process group:
      // reclaim it BEFORE the Host generations and before the scene root.
      await terminateQualificationClient(reason)
      if (scene?.kind === 'process') {
        try {
          const problems = await terminateAllProcessEntries(reason)
          if (problems.length > 0) {
            clean = false
            for (const problem of problems) appendNote('process-entry-termination-failed', problem)
          }
        } catch (error) {
          clean = false
          appendNote('process-entry-termination-failed', { reason: boundedError(error) })
        }
      }
      // Public daemon launches are REAL installed-CLI PTYs: close every
      // foreground session, then reclaim the public Hosts they started. The
      // registered public Host rows keep the generic discovery-fallback scan
      // from claiming them as unattributed internal Hosts.
      if (scene?.kind === 'process') {
        await settlePendingProcessNativeOperation(`cleanup:${reason}:public`)
        for (const handle of [...publicLaunches].reverse()) {
          if (handle.closed) continue
          try {
            await reclaimPublicLaunch(handle, `cleanup:${reason}`)
          } catch (error) {
            clean = false
            appendNote('public-daemon-launch-reclaim-failed', {
              launchId: handle.launchId,
              reason: boundedError(error),
            })
          }
        }
        for (const host of [...publicHosts].reverse()) {
          if (host.reclaimed === true) continue
          try {
            await reclaimPublicHost(host, `cleanup:${reason}`)
          } catch (error) {
            clean = false
            appendNote('public-host-reclaim-failed', {
              pid: host.pid,
              birth: host.birth,
              reason: boundedError(error),
            })
          }
        }
        if (publicOwnershipRefusal !== undefined) {
          // The refusal is a REAL failed admission, never a pass: preserve the
          // NOT_QUIESCED phase + root while the separate compensation result is
          // recorded truthfully.
          clean = false
          writeReceipt({
            publicOwnershipRefused: publicOwnershipRefusal,
            compensation: { ...(receipt?.compensation ?? {}), publicOwnershipRefused: { ...publicOwnershipRefusal } },
          })
        }
        try {
          await auditPublicLaunchLedger(`cleanup:${reason}`)
        } catch (error) {
          clean = false
          appendNote('public-daemon-ledger-audit-failed', { reason: boundedError(error) })
        }
      }
      // A process Scene's native Clients are owned by THIS process. Let the ONE
      // in-flight native operation reach its real settlement first, then close
      // every handle; a root is never removed while a native call still owns it.
      if (scene?.kind === 'process') {
        await settlePendingProcessNativeOperation(`cleanup:${reason}`)
        for (const handle of [...processClients].reverse()) {
          if (handle.closed) continue
          try {
            await settleProcessClientHandler(handle, `cleanup:${reason}`)
            await settleProcessClientClose(handle, `cleanup:${reason}`)
            await reclaimProcessClient(handle, `cleanup:${reason}`)
          } catch (error) {
            clean = false
            appendNote('process-client-reclaim-failed', { clientId: handle.clientId, reason: boundedError(error) })
          }
        }
      }
      // A Scene Client's production discovery fallback can start a detached
      // Host this Supervisor never created. Audit and reclaim it before any
      // terminal quiescence claim or root removal. A native Scene skips this
      // FIRST pass: the manager-owned Host legitimately runs local-host.mjs
      // under the Scene root but belongs to the reserved service, not to a
      // Client fallback; it is stopped by cleanupNativeManagedService below
      // and the post-host audit then owns any true leftover.
      if (isNativeScene()) {
        // Native-only compensation runs BEFORE the Host generations are stopped:
        // the registered Client/shell PIDs are validated against uid, kernel
        // birth, command and the run-owned scratch, never by name or group.
        try {
          await reclaimNativeClients(`cleanup:${reason}`)
        } catch (error) {
          clean = false
          appendNote('native-client-reclaim-failed', { reason: boundedError(error) })
        }
      } else if (scene?.kind === 'process') {
        try {
          await reclaimClientFallbackHosts(`cleanup:${reason}:client`)
        } catch (error) {
          clean = false
          appendNote('process-fallback-host-audit-failed', { reason: boundedError(error) })
        }
      } else {
        await reclaimClientFallbackHosts(`cleanup:${reason}:client`)
      }
      for (const handle of [...hosts].reverse()) {
        try {
          // A leader whose OS process already exited is not a live target: its
          // registered close must settle before the group/seat audit.
          if (!handle.exited && (handle.child.exitCode !== null || handle.child.signalCode !== null)) {
            await waitForHostClose(handle, `${reason}: pending close`, KILL_GRACE_MS)
          }
          if (handle.exited) {
            await waitForGroupGone(hostPgid(handle), 15_000)
            await assertHostGroupGone(handle, reason)
          } else {
            await terminateHost(handle, reason)
          }
        } catch (error) {
          clean = false
          appendNote('host-termination-failed', {
            hostId: handle.hostId,
            generation: handle.generation,
            reason: boundedError(error),
            detail: redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
          })
          if (scene?.kind !== 'process') throw error
        }
      }
      activeHost = undefined
      if (scene !== undefined) {
        // Only the supervisor owns the scene root. A worker crash may leave a
        // tui-test Client behind; the official record files are re-read BEFORE
        // the root is removed so a live replacement child can never be hidden
        // by the Supervisor's own cleanup.
        if (isNativeScene()) {
          const nativeCleanup = await cleanupNativeManagedService(reason)
          if (!nativeCleanup.clean) {
            clean = false
            appendNote('native-service-cleanup-failed', { reason: nativeCleanup.reason })
          }
        } else {
          auditClientLedger(`cleanup:${reason}`)
        }
        if (scene.kind === 'process') {
          try {
            await auditProcessClientLedger(`cleanup:${reason}`)
          } catch (error) {
            clean = false
            appendNote('process-client-audit-failed', {
              reason: boundedError(error),
              detail: (error instanceof Error ? error.message : String(error)).slice(0, 400),
            })
          }
        }
        await reclaimClientFallbackHosts(`cleanup:${reason}:post-host`)
        await assertSceneHostSeatFree(`cleanup:${reason}`)
        if (scene.kind === 'process') {
          await assertClientSeatFree(scene.installation, processScope.scopeId, `cleanup:${reason}`)
        }
        // Both seats are terminal before the scoped input is restored, so no
        // live consumer and no owner of the seat observes a half-restored copy.
        if (scene.kind === 'process' && processInstallationMutation !== undefined && clean) {
          try {
            await restoreInstallationMutation({ compensating: true })
          } catch (error) {
            clean = false
            appendNote('installation-mutation-restore-failed', {
              fault: processInstallationMutation?.fault ?? null,
              reason: boundedError(error),
              detail: redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
            })
          }
        }
        if (processBootstrapCliPatch !== undefined && clean) {
          const patch = processBootstrapCliPatch
          try {
            if (patch.previous === undefined) rmSync(patch.path, { force: true })
            else atomicReplaceFile(patch.path, patch.previous.bytes, patch.previous.mode, 'bootstrap CLI patch restore')
            processBootstrapCliPatch = undefined
          } catch (error) {
            clean = false
            appendNote('bootstrap-cli-patch-restore-failed', {
              path: patch.path,
              reason: boundedError(error),
              detail: redactText(error instanceof Error ? error.message : String(error)).slice(0, 300),
            })
          }
        }
        const compensation = options.failure === undefined ? undefined : {
          attempted: true,
          completed: clean,
          failure: boundedError(options.failure),
          attemptedAt: now(),
        }
        if (!clean) {
          writeReceipt({
            phase: 'NOT_QUIESCED',
            ...(compensation === undefined ? {} : { compensation }),
            cleanup: {
              ...(receipt?.cleanup ?? {}),
              reason,
              completedAt: now(),
              hostsExited: hosts.every(handle => handle.exited),
              hostSeatFree: true,
              qualificationSeatFree: scene.kind === 'process' ? true : undefined,
              sceneRootRemoved: false,
            },
          })
          throw new Error(`${reason}: the Scene is not quiesced; the root is preserved for diagnosis`)
        }
        if (!preserve) await cleanupSceneRoot(reason)
        writeReceipt({
          phase: preserve ? 'NOT_QUIESCED' : 'ABORTED_CLEAN',
          ...(compensation === undefined ? {} : { compensation }),
          ...(options.failure === undefined ? {} : { errorName: boundedError(options.failure), errorDetail: String(boundedError(options.failure)).slice(0, 600) }),
          cleanup: {
            ...(receipt?.cleanup ?? {}),
            reason,
            completedAt: now(),
            hostsExited: hosts.every(handle => handle.exited),
            hostSeatFree: true,
            qualificationSeatFree: scene.kind === 'process' ? true : undefined,
            sceneRootRemoved: scene === undefined ? undefined : !existsSync(scene.workDir),
          },
        })
        receiptTerminal = true
        return { clean: true, compensation }
      }
      installInProgress = false
      writeReceipt({
        phase: preserve || !clean ? 'NOT_QUIESCED' : 'ABORTED_CLEAN',
        cleanup: {
          ...(receipt?.cleanup ?? {}),
          reason,
          completedAt: now(),
          hostsExited: hosts.every(handle => handle.exited),
          sceneRootRemoved: scene === undefined ? undefined : !existsSync(scene.workDir),
        },
        install: { ...(receipt?.install ?? {}), inProgress: false },
      })
      receiptTerminal = true
    } catch (error) {
      clean = false
      writeReceipt({ phase: 'NOT_QUIESCED', cleanup: { ...(receipt?.cleanup ?? {}), reason, errorName: boundedError(error), completedAt: now() } })
      receiptTerminal = true
    }
    return { clean }
  })()
  return await cleanupPromise
}


// ── native managed-service bridge helpers ─────────────────────────────────
// The Supervisor owns every persistent native fact; the shared contract module
// owns the classification decisions. These helpers only feed it real inputs.

/** Whether this Scene is the native upgrade Scene. */
function isNativeScene() {
  return scene?.kind === 'upgrade' && scene.pair?.policy === 'native'
}

function requireNativeScene(label) {
  if (!isNativeScene() || nativeRuntime === undefined) {
    throw new Error(`${label}: this is not a native upgrade Scene`)
  }
  return nativeRuntime
}

function requireNativeRuntime(label) {
  const runtime = requireNativeScene(label)
  if (runtime.reservation === undefined) {
    throw new Error(`${label}: no managed service was reserved`)
  }
  return runtime
}

function writeNativeRecord(record) {
  nativeRuntime.record = record
  writeReceipt({ native: record })
}

/** Read `/proc/<pid>/status` Uid (first/real column) on Linux. */
function readLinuxProcessUid(pid) {
  let raw
  try {
    raw = readFileSync(`/proc/${String(pid)}/status`, 'utf8')
  } catch {
    return undefined
  }
  const match = /^Uid:\s+(\d+)/mu.exec(raw)
  return match === null ? undefined : Number(match[1])
}

/** The exact environment value of one live process, or undefined. */
function processEnvironmentValue(pid, key) {
  if (process.platform === 'linux') {
    let raw
    try {
      raw = readFileSync(`/proc/${String(pid)}/environ`, 'utf8')
    } catch {
      return undefined
    }
    for (const entry of raw.split('\0')) {
      if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1)
    }
    return undefined
  }
  let raw
  try {
    raw = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  } catch {
    return undefined
  }
  const match = new RegExp(`(?:^|\\s)${key}=([^\\s]*)`, 'u').exec(raw)
  return match?.[1]
}

/** One live process's kernel birth + real uid, or null when unprovable. */
function nativeProcessSnapshot(pid) {
  if (typeof readKernelProcess !== 'function') return null
  let observation
  try {
    observation = readKernelProcess(pid)
  } catch {
    return null
  }
  if (observation.kind !== 'alive') return null
  const identity = observation.identity
  const uid = identity.platform === 'darwin' ? identity.uid : readLinuxProcessUid(pid)
  if (!Number.isInteger(uid) || uid <= 0) return null
  const command = processCommandLine(pid)
  if (typeof command !== 'string' || command === '') return null
  return { uid, birth: serializeKernelIdentity(identity), command }
}

/** The classifier's kernel fact for one manager-named Host main PID. */
function nativeKernelFacts(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'unknown', uid: null }
  if (typeof readKernelProcess !== 'function') return { status: 'unknown', uid: null }
  let observation
  try {
    observation = readKernelProcess(pid)
  } catch {
    return { status: 'unknown', uid: null }
  }
  if (observation.kind === 'gone') return { status: 'gone', uid: null }
  if (observation.kind === 'unknown') return { status: 'unknown', uid: null }
  const identity = observation.identity
  if (identity.pid !== pid) return { status: 'different', uid: null }
  const uid = identity.platform === 'darwin' ? identity.uid : readLinuxProcessUid(pid)
  if (!Number.isInteger(uid) || uid <= 0) return { status: 'unknown', uid: null }
  return { status: 'alive', uid }
}

/** The exact CLI child's fresh kernel birth for the sticky ownership fence. */
function nativeCliKernelFacts(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof readKernelProcess !== 'function') return { status: 'unknown' }
  let observation
  try {
    observation = readKernelProcess(pid)
  } catch {
    return { status: 'unknown' }
  }
  if (observation.kind === 'gone') return { status: 'gone' }
  if (observation.kind === 'unknown') return { status: 'unknown' }
  return { status: 'alive', birth: serializeKernelIdentity(observation.identity) }
}

/**
 * Record a sticky exact-child obligation. The in-memory single-CLI slot may be
 * cleared when its promise settles, but this fence blocks every later manager
 * command until the same kernel child is independently proved gone.
 */
function setNativeCliFence(verb, error, pending) {
  const runtime = requireNativeScene('native CLI fence')
  const pid = Number.isInteger(error?.pid)
    ? error.pid
    : (Number.isInteger(pending?.pid) ? pending.pid : null)
  let kernelIdentity = pending?.kernelIdentity ?? null
  if (pid !== null && kernelIdentity === null) {
    const fresh = nativeCliKernelFacts(pid)
    if (fresh.status === 'alive') kernelIdentity = fresh.birth
  }
  runtime.cliFence = { verb, pid, kernelIdentity, at: now(), reason: String(error?.message ?? 'NOT_QUIESCED') }
  appendNote('native-cli-unquiesced', { verb, pid, reason: runtime.cliFence.reason })
}

/** Fresh terminal state of one recorded managed-Host kernel identity. */
function nativeHostIdentityState(identity) {
  const fresh = nativeCliKernelFacts(identity.pid)
  if (fresh.status === 'gone') return 'gone'
  if (fresh.status === 'unknown') return 'unknown'
  return fresh.birth === identity.kernelIdentity ? 'alive' : 'different'
}

/** Fresh fence verdict; a proven gone/reused child is the only way to lift it. */
function refreshNativeCliFence() {
  const runtime = requireNativeScene('native CLI fence')
  const fence = runtime.cliFence
  if (fence === undefined) return { state: 'clear', pid: null }
  const kernel = fence.pid === null ? null : nativeCliKernelFacts(fence.pid)
  const decision = classifyNativeCliFence({ fence, kernel })
  if (decision.state === 'clear') {
    runtime.cliFence = undefined
    appendNote('native-cli-fence-released', { pid: fence.pid, verb: fence.verb })
  }
  return decision
}

/** Capture the ownership facts of ONE Worker-owned Client/shell PID. */
function captureNativeClientIdentity(pid, { requireScratch, scratch }) {
  const snapshot = nativeProcessSnapshot(pid)
  if (snapshot === null) {
    throw new Error(`NATIVE_CLIENT_IDENTITY_UNPROVEN: process ${String(pid)} is not a readable live process`)
  }
  let observedScratch = null
  if (requireScratch) {
    observedScratch = processEnvironmentValue(pid, 'SPLIT_PROCESS_SCRATCH')
    if (typeof observedScratch !== 'string' || observedScratch !== scratch) {
      throw new Error(`NATIVE_CLIENT_IDENTITY_UNPROVEN: process ${String(pid)} does not carry this Scene's scratch`)
    }
  }
  return { pid, uid: snapshot.uid, birth: snapshot.birth, command: snapshot.command, scratch: observedScratch }
}

/**
 * Fresh ownership verdict for one registered native process. A different
 * kernel birth means the numeric PID was reused: our process is gone and the
 * new process is never signalled.
 */
function nativeRegisteredProcessState(registered) {
  if (typeof readKernelProcess !== 'function') return { state: 'unknown', reason: 'KERNEL_IDENTITY_UNAVAILABLE' }
  let kernel
  try {
    kernel = readKernelProcess(registered.pid)
  } catch {
    return { state: 'unknown', reason: 'KERNEL_READ_FAILED' }
  }
  const liveness = classifyRegisteredProcessLiveness({
    kernel,
    birth: registered.birth,
    readSnapshot: () => readNativeClientSnapshot({
      pid: registered.pid,
      requireScratch: registered.scratch !== null,
      readSnapshot: nativeProcessSnapshot,
      readEnvironment: processEnvironmentValue,
    }),
    rereadKernel: () => readKernelProcess(registered.pid),
  })
  if (liveness.state !== 'alive') return liveness
  const snapshot = liveness.snapshot
  const observed = {
    pid: registered.pid,
    uid: snapshot.uid,
    birth: snapshot.birth,
    scratch: snapshot.scratch,
    entry: snapshot.command,
  }
  const decision = classifyNativeClientOwnership({
    registered: {
      pid: registered.pid,
      uid: registered.uid,
      birth: registered.birth,
      scratch: registered.scratch,
      entry: registered.command,
    },
    observed,
    sceneRoot: scene.workDir,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  })
  return decision.owned ? { state: 'owned' } : { state: 'unowned', reason: decision.reason }
}

/** The complete (newline-terminated) official Client records; a half line is ignored. */
function readCompleteClientRecords(recordFile) {
  const text = readFileSync(recordFile, 'utf8')
  const end = text.endsWith('\n') ? text.length - 1 : text.lastIndexOf('\n')
  if (end < 0) return []
  const records = []
  for (const [index, line] of text.slice(0, end).split('\n').entries()) {
    if (line === '') continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`the official Client record line ${String(index + 1)} is invalid JSON: ${boundedError(error)}`)
    }
  }
  return records
}

/** The fixed instance registry path of this reservation's scope. */
function nativeInstanceRegistryPath(reservation) {
  return join(reservation.dshHome, 'run', 'dsh-pi-tui', reservation.scopeId, 'instance.json')
}

/** Strictly read this scope's instance registry; malformed data is unverifiable. */
function readNativeInstanceRegistry(reservation) {
  const path = nativeInstanceRegistryPath(reservation)
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  if (value.scopeId !== reservation.scopeId) return null
  if (!Number.isInteger(value.hostPid) || value.hostPid <= 0) return null
  if (typeof value.instanceId !== 'string' || value.instanceId === '') return null
  if (typeof value.buildId !== 'string' || value.buildId === '') return null
  return value
}

/**
 * Bind one manager-named Host PID to the official authenticated identity. A
 * Client's own `host-authenticated` record is preferred; the official instance
 * registry plus a fresh kernel re-read is the fallback. An unknown identity is
 * never converted into an owned one.
 */
function findNativeHostIdentity(pid, reservation) {
  let kernel
  try {
    kernel = readKernelProcess(pid)
  } catch {
    return null
  }
  if (kernel.kind !== 'alive') return null
  const kernelIdentity = serializeKernelIdentity(kernel.identity)
  for (const client of receipt.clients ?? []) {
    if (typeof client.recordFile !== 'string' || client.recordFile === '') continue
    let records
    try {
      records = readCompleteClientRecords(client.recordFile)
    } catch {
      continue
    }
    for (const record of records) {
      if (record?.m4a0 !== 'host-authenticated') continue
      const host = record.host
      if (host === null || typeof host !== 'object') continue
      if (host.hostPid !== pid || host.scopeId !== reservation.scopeId) continue
      // An old host-authenticated record must not authenticate a new process
      // that reused the numeric PID. Compare the schema-specific kernel birth.
      if (!nativeIdentityRecordMatches(host, kernel.identity)) continue
      if (typeof host.instanceId !== 'string' || host.instanceId === '') continue
      if (typeof host.buildId !== 'string' || host.buildId === '') continue
      return {
        pid,
        scopeId: host.scopeId,
        instanceId: host.instanceId,
        kernelIdentity,
        buildId: host.buildId,
        source: 'official-client-auth-record',
      }
    }
  }
  const registry = readNativeInstanceRegistry(reservation)
  if (registry !== null && registry.hostPid === pid && nativeIdentityRecordMatches(registry, kernel.identity)) {
    return {
      pid,
      scopeId: registry.scopeId,
      instanceId: registry.instanceId,
      kernelIdentity,
      buildId: registry.buildId,
      source: 'official-registry-and-kernel-verified',
    }
  }
  return null
}

/** The real Linux user runtime, proven by lstat before any daemon CLI uses it. */
function verifiedLinuxRuntimeDir(uid) {
  const path = `/run/user/${String(uid)}`
  let info
  try {
    info = lstatSync(path)
  } catch {
    return undefined
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) return undefined
  return path
}

/** The real session-bus socket of the verified runtime, or undefined. */
function verifiedLinuxBusPath(runtimeDir, uid) {
  const path = join(runtimeDir, 'bus')
  let info
  try {
    info = lstatSync(path)
  } catch {
    return undefined
  }
  if (info.uid !== uid || !info.isSocket()) return undefined
  return path
}

/** The exact official daemon CLI installation this run may call. */
function nativeDaemonInstallation() {
  const runtime = requireNativeRuntime('daemon')
  const reservation = runtime.reservation
  if (process.platform === 'linux') {
    const runtimeDir = verifiedLinuxRuntimeDir(reservation.uid)
    if (runtimeDir === undefined) {
      throw new Error('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: the verified /run/user/<uid> runtime directory is unavailable')
    }
    return {
      dshInvocation: scene.installation.dshInvocation,
      profileDir: scene.installation.profileDir,
      env: scene.installation.env,
      platform: 'linux',
      runtimeDir,
      busPath: verifiedLinuxBusPath(runtimeDir, reservation.uid) ?? null,
    }
  }
  return {
    dshInvocation: scene.installation.dshInvocation,
    profileDir: scene.installation.profileDir,
    env: scene.installation.env,
    platform: 'darwin',
    runtimeDir: null,
    busPath: null,
  }
}

/** The commit-point hooks of ONE official daemon CLI child. */
function nativeCliHooks(verb, { mutating = true, recordOperation = true } = {}) {
  if (!recordOperation) return {}
  return {
    onIssued: ({ at }) => {
      const record = nativeRuntime.record
      nativeRuntime.record = {
        ...record,
        lifecycle: mutating ? 'mutating' : record.lifecycle,
        lastOperation: { verb, phase: 'ISSUED', pid: null, exitCode: null, signal: null, at },
      }
      writeReceipt({ native: nativeRuntime.record })
    },
    onSpawned: ({ pid, at }) => {
      if (nativeRuntime?.cliPending !== undefined) {
        nativeRuntime.cliPending.pid = pid
        const kernel = nativeCliKernelFacts(pid)
        if (kernel.status === 'alive') nativeRuntime.cliPending.kernelIdentity = kernel.birth
      }
      const record = nativeRuntime.record
      nativeRuntime.record = {
        ...record,
        lastOperation: { ...(record.lastOperation ?? { verb, at }), verb, pid },
      }
      writeReceipt({ native: nativeRuntime.record })
    },
    onExited: ({ exitCode, signal, at }) => {
      const record = nativeRuntime.record
      nativeRuntime.record = {
        ...record,
        lastOperation: {
          verb,
          phase: 'EXITED',
          pid: record.lastOperation?.pid ?? null,
          exitCode,
          signal,
          at,
        },
      }
      writeReceipt({ native: nativeRuntime.record })
    },
    onNotQuiesced: ({ pid, at }) => {
      const record = nativeRuntime.record
      nativeRuntime.record = {
        ...record,
        lastOperation: {
          verb,
          phase: 'UNKNOWN',
          pid,
          exitCode: null,
          signal: null,
          at,
        },
      }
      writeReceipt({ native: nativeRuntime.record })
    },
  }
}

/** Execute ONE fixed daemon verb through the scene-level cancellation scope. */
async function executeNativeDaemonVerb(verb, { mutating = true, abortSignal, recordOperation = true } = {}) {
  const runtime = requireNativeRuntime(`daemon ${verb}`)
  return await runFixedDaemonVerb({
    installation: nativeDaemonInstallation(),
    verb,
    // Business commands share the Scene cancellation scope; the dedicated
    // cleanup sequence owns its own scope so an earlier abort cannot silently
    // skip the official stop/uninstall.
    abortSignal: abortSignal ?? runtime.abortController.signal,
    hooks: nativeCliHooks(verb, { mutating, recordOperation }),
  })
}

/**
 * The ONE official CLI owner. Every real child (including read-only `status`)
 * enters the same in-flight slot and the same sticky terminal fence before it
 * spawns. A closed lifecycle is re-checked after every async precondition;
 * cleanup verbs may pass `allowClosed` because the cleanup itself is the owner
 * of the closing lifecycle.
 */
async function runNativeCli(verb, { mutating = true, abortSignal, recordOperation = true, allowClosed = false } = {}) {
  const runtime = requireNativeRuntime(`daemon ${verb}`)
  return await runOwnedNativeCli({
    slot: runtime,
    verb,
    allowClosed,
    lifecycleClosed,
    refreshFence: () => refreshNativeCliFence(),
    setFence: (failedVerb, error) => setNativeCliFence(failedVerb, error, runtime.cliPending),
    execute: async action => await executeNativeDaemonVerb(action, { mutating, abortSignal, recordOperation }),
  })
}

/**
 * Read the real manager/profile/Host facts and fold them into the ONE native
 * receipt. A status query is only attempted when the raw observation is safe to
 * query; helper unverifiability never authorizes a manager mutation.
 */
async function observeNativeService({ runStatus = true, lifecycle } = {}) {
  const runtime = requireNativeRuntime('verify')
  const reservation = runtime.reservation
  const inspection = await runtime.adapter.inspectManagedService(reservation)
  const kernel = inspection.mainPid === null ? null : nativeKernelFacts(inspection.mainPid)
  let status = null
  const canQueryStatus = runStatus
    && !lifecycleClosed
    && inspection.file !== 'foreign'
    && inspection.file !== 'unverifiable'
    && inspection.managerState !== 'unknown'
  if (canQueryStatus) {
    try {
      const result = await runNativeCli('status', { mutating: false, recordOperation: false })
      status = parseManagedDaemonStatus(result.stdout)
    } catch (error) {
      appendNote('native-status-unavailable', { code: error?.code ?? boundedError(error) })
    }
  }
  let identity = null
  if (status !== null
    && status.host === 'ready'
    && status.manager === reservation.manager
    && status.unit === reservation.unitName
    && Number.isInteger(status.pid)) {
    identity = findNativeHostIdentity(status.pid, reservation)
  }
  const authenticatedHost = identity === null
    ? null
    : { ready: true, pid: identity.pid, scopeId: identity.scopeId, instanceId: identity.instanceId }
  const observation = classifyManagedInspection({
    reservation,
    history: { everObservedInstalled: runtime.record.everObservedInstalled },
    inspection,
    authenticatedHost,
    kernel,
    verifiedAt: now(),
  })
  let record = applyServiceObservation(runtime.record, observation, lifecycle === undefined ? {} : { lifecycle })
  if (identity !== null && observation.authenticatedHostReady) {
    record = { ...record, hostIdentities: mergeHostIdentityLedger(record.hostIdentities, identity) }
  }
  // A business pre-cleanup observation that completes after the lifecycle
  // closed must not overwrite the cleanup-owned live receipt. The cleanup
  // observation is the only late writer allowed.
  if (!nativeObservationCommitAllowed({ lifecycleClosed, cleanupOwned: lifecycle === 'cleaning' })) {
    return { reservation, observation: record.observed }
  }
  writeNativeRecord(record)
  return { reservation, observation: record.observed }
}

/**
 * The ONE idempotent native cleanup. Official stop/uninstall are attempted only
 * for a strictly owned service of this run; unknown/foreign state goes straight
 * to the helper, which must re-prove ownership before it acts.
 */
async function cleanupNativeManagedService(reason) {
  if (nativeCleanupPromise !== undefined) return await nativeCleanupPromise
  nativeCleanupPromise = (async () => {
    if (!isNativeScene() || nativeRuntime === undefined || nativeRuntime.reservation === undefined) {
      return { clean: true, reason: 'no-native-reservation' }
    }
    const runtime = nativeRuntime
    const reservation = runtime.reservation
    runtime.cleanupStarted = true
    runtime.abortController.abort()
    const pending = runtime.cliPending
    if (pending !== undefined) {
      let rejection
      await pending.promise.catch(error => { rejection = error })
      const unquiesced = isNativeDaemonUnquiesced(rejection)
      if (unquiesced !== null) setNativeCliFence(pending.verb, unquiesced, pending)
      runtime.cliPending = undefined
      await Promise.resolve()
    }
    const mutationDrain = await waitForOwnedMutation({
      mutation: runtime.mutationPending,
      timeoutMs: MUTATING_HELPER_GRACE_MS,
    })
    if (!mutationDrain.settled) {
      // The helper may still commit a manager file change. No manager cleanup
      // and no root removal may run; keep the Scene NOT_QUIESCED.
      writeNativeRecord({
        ...runtime.record,
        lifecycle: 'unverifiable',
        cleanup: {
          attempted: true,
          officialStop: 'not-attempted',
          officialUninstall: 'not-attempted',
          fallback: 'not-attempted',
          reason: 'NATIVE_MUTATION_NOT_QUIESCED',
        },
      })
      return { clean: false, reason: 'NATIVE_MUTATION_NOT_QUIESCED' }
    }
    const fence = refreshNativeCliFence()
    const cliFence = fence.state === 'clear' ? null : fence
    const cleanupAbort = new AbortController()
    const result = await cleanupNativeService({
      reservation,
      record: runtime.record,
      adapter: runtime.adapter,
      cliFence,
      observe: async () => (await observeNativeService({ runStatus: false, lifecycle: 'cleaning' })).observation,
      runOfficialVerb: async verb => await runNativeCli(verb, {
        mutating: false,
        abortSignal: cleanupAbort.signal,
        recordOperation: false,
        allowClosed: true,
      }),
      writeRecord: record => writeNativeRecord(record),
      readRecord: () => runtime.record,
      probeKernel: async pid => (pid === null ? null : nativeKernelFacts(pid)),
      probeHostKernel: identity => nativeHostIdentityState(identity),
      probeClients: async () => (receipt.clients ?? []).map(client => ({
        label: String(client.label),
        gone: nativeRegisteredClientGone(client),
      })),
      verifiedAt: now(),
    })
    if (!result.clean) {
      appendNote('native-cleanup-failed', { reason: result.reason })
    }
    return result
  })()
  return await nativeCleanupPromise
}

/** Whether one registered native Client process set is proven gone. */
function nativeRegisteredClientGone(client) {
  const identities = client.nativeOs
  if (identities === undefined) return false
  for (const registered of [...(identities.business ?? []), ...(identities.shell === null ? [] : [identities.shell])]) {
    const state = nativeRegisteredProcessState(registered)
    if (state.state === 'unknown' || state.state === 'owned' || state.state === 'unowned') return false
  }
  return true
}

/**
 * Native-only compensation for a dead Worker: terminate ONLY registered PIDs
 * whose uid, kernel birth, command and run-owned scratch still prove ownership.
 * Never a process group, never a name pattern, never an unregistered PID.
 */
async function reclaimNativeClients(reason) {
  if (!isNativeScene()) return
  const problems = []
  for (const client of receipt.clients ?? []) {
    const identities = client.nativeOs
    if (identities === undefined) {
      problems.push(`${String(client.label)}: no native OS identity was registered`)
      continue
    }
    const registered = [...(identities.business ?? []), ...(identities.shell === null ? [] : [identities.shell])]
    for (const identity of registered) {
      const state = nativeRegisteredProcessState(identity)
      if (state.state === 'gone') continue
      if (state.state !== 'owned') {
        problems.push(`${String(client.label)}: PID ${String(identity.pid)} is not provably this run's process (${String(state.reason ?? state.state)})`)
        continue
      }
      try {
        process.kill(identity.pid, 'SIGTERM')
      } catch {
        continue
      }
      const deadline = Date.now() + TERM_GRACE_MS
      while (Date.now() < deadline && nativeRegisteredProcessState(identity).state === 'owned') {
        await sleep(50)
      }
      if (nativeRegisteredProcessState(identity).state === 'owned') {
        try { process.kill(identity.pid, 'SIGKILL') } catch { /* already gone */ }
        const killDeadline = Date.now() + KILL_GRACE_MS
        while (Date.now() < killDeadline && nativeRegisteredProcessState(identity).state === 'owned') {
          await sleep(50)
        }
      }
      const after = nativeRegisteredProcessState(identity)
      if (after.state === 'owned') {
        problems.push(`${String(client.label)}: PID ${String(identity.pid)} survived TERM/KILL`)
      } else if (after.state === 'unknown') {
        problems.push(`${String(client.label)}: PID ${String(identity.pid)} cannot be proven gone (${String(after.reason)})`)
      }
    }
    // Complete official JSONL records may name a replacement PID that never
    // reached a REPORT. A live one is unproven ownership, never silently clean.
    if (typeof client.recordFile === 'string' && existsSync(client.recordFile)) {
      try {
        const reported = new Set(registered.map(value => value.pid))
        for (const record of readCompleteClientRecords(client.recordFile)) {
          if (record?.m4a0 !== 'client-started' && record?.m4a0 !== 'ready') continue
          if (!Number.isInteger(record.pid) || record.pid <= 0) continue
          if (reported.has(record.pid)) continue
          let kernel = { kind: 'unknown' }
          if (typeof readKernelProcess === 'function') {
            try {
              kernel = readKernelProcess(record.pid)
            } catch {
              kernel = { kind: 'unknown' }
            }
          }
          const recordLiveness = classifyKernelLiveness(kernel)
          if (recordLiveness.state === 'alive') {
            problems.push(`${String(client.label)}: live official record PID ${String(record.pid)} has no registered OS identity`)
          } else if (recordLiveness.state === 'unknown') {
            problems.push(`${String(client.label)}: official record PID ${String(record.pid)} cannot be proven terminated (${String(recordLiveness.reason)})`)
          }
        }
      } catch (error) {
        problems.push(`${String(client.label)}: official records are unreadable (${boundedError(error)})`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`${reason}: native Client reclaim failed: ${problems.join('; ')}`)
  }
}

function publicInstallation(installation) {
  return {
    workDir: installation.workDir,
    dshHome: installation.dshHome,
    profileDir: installation.profileDir,
    entries: installation.entries,
    anchor: installation.anchor,
    base: installation.base,
    scratch: installation.scratch,
  }
}

/** The durable receipt projection: roots/build facts, never the spawn environment. */
function receiptInstallation(installation) {
  const { env: _env, ...baseFacts } = installation.base ?? {}
  return { ...publicInstallation(installation), base: baseFacts }
}

function installedPackageFacts(packageRoot, expectedVersion, targetDshVersion, label) {
  const root = realpathSync(packageRoot)
  const manifest = readJson(join(root, 'package.json'), `${label} package.json`)
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`${label}: installed package name is ${String(manifest.name)}`)
  }
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(`${label}: installed package version ${String(manifest.version)} != expected ${expectedVersion}`)
  }
  const hostEntry = realpathSync(join(root, 'dist', 'local-host.mjs'))
  const clientEntry = realpathSync(join(root, 'dist', 'local-client.mjs'))
  return {
    packageRoot: root,
    version: manifest.version,
    buildId: productionBuildId(root, targetDshVersion),
    payloadHash: installedPayloadHash(root),
    entries: { host: hostEntry, client: clientEntry },
  }
}

function assertPairReceipt(pair, expectedPairSha) {
  if (expectedPairSha === null || typeof expectedPairSha !== 'object') {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP_UPGRADE requires expectedPairSha')
  }
  if (expectedPairSha.old !== pair.old.sha256 || expectedPairSha.new !== pair.new.sha256) {
    throw new Error('INPUT_UNQUALIFIED: INPUT_PAIR_CHANGED (INVALID_TEST_PAIRING, not a product regression): '
      + 'the Supervisor re-read different old/new package bytes than the Worker preflight')
  }
}

/**
 * A side-by-side package runs as a REAL installed package, but its declared
 * `@deepseek-ai/*` peers belong to the ONE isolated DSH runtime anchored by the
 * harness. Link only those peer packages into the side directory; the side
 * payload itself is never copied or rewritten. This is the same peer closure the
 * official profile runner supplies to the active profile install.
 */
function linkSideBuildRuntimePeers(sideDir, installation, packageRoot) {
  const targetDir = join(sideDir, 'node_modules', '@deepseek-ai')
  mkdirSync(targetDir, { recursive: true })
  // The isolated harness's hidden pnpm hoist carries the exact DSH family the
  // anchor install resolved. Link exactly the peer packages this side payload
  // declares; the payload itself and its dependency closure are untouched.
  const hoistDir = join(installation.harnessDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai')
  if (!existsSync(hoistDir)) {
    throw new Error(`the isolated DSH harness has no @deepseek-ai family closure at ${hoistDir}`)
  }
  const manifest = readJson(join(packageRoot, 'package.json'), 'side package.json')
  const names = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'))
  for (const name of names) {
    const linkPath = join(targetDir, name.slice('@deepseek-ai/'.length))
    if (existsSync(linkPath)) continue
    const source = join(hoistDir, name.slice('@deepseek-ai/'.length))
    if (!existsSync(source)) {
      throw new Error(`the isolated DSH harness does not carry the declared peer ${name}`)
    }
    symlinkSync(realpathSync(source), linkPath, 'dir')
  }
}

async function installProfilePackage(tarball) {
  const before = existsSync(scene.installation.profilePackage)
    ? installedPayloadHash(realpathSync(scene.installation.profilePackage))
    : undefined
  installInProgress = true
  writeReceipt({ install: { inProgress: true, completed: false, startedAt: now(), completedAt: undefined } })
  try {
    const installEnv = installCacheEnvironment(scene.installation.env, scene.installCacheRoot)
    installPlugin(scene.installation.dshInvocation, tarball, scene.installation.harnessDir, installEnv, false)
    const facts = installedPackageFacts(
      join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'),
      undefined,
      scene.pair.targetDshVersion,
      'active profile',
    )
    if (before !== undefined && before === facts.payloadHash) {
      throw new Error('the active profile package payload did not change after the official install')
    }
    installInProgress = false
    writeReceipt({ install: { inProgress: false, completed: true, startedAt: receipt.install?.startedAt, completedAt: now() } })
    return facts
  } catch (error) {
    installInProgress = false
    writeReceipt({ install: { inProgress: false, completed: false, failedAt: now() } })
    throw error
  }
}

async function handleBootstrap(message) {
  await modulesReady
  if (scene !== undefined) throw new Error('BOOTSTRAP: scene already exists')
  if (!Number.isInteger(message.workerPid) || message.workerPid <= 0
    || !Number.isInteger(message.workerPpid) || message.workerPpid <= 0) {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP requires real workerPid and workerPpid')
  }
  installInProgress = true
  const tmpBase = validateTmpBase(message.tmpBase)
  initReceipt(tmpBase, { pid: message.workerPid, ppid: message.workerPpid }, { kind: 'pilot' })
  let root
  let candidate
  let installation
  let c1Work
  try {
    candidate = inspectSplitCandidate(message.tarball)
    root = createTestTempDir('scene-', tmpBase)
    // Register the root before install so a later disconnect still owns and
    // retries removal even if installation fails half-way.
    scene = { kind: 'pilot', workDir: root }
    appendNote('bootstrap-root-created', { sceneRoot: root })
    writeReceipt({ phase: 'BOOTSTRAP_ROOT_CREATED', sceneRoot: root, install: { inProgress: true, completed: false, startedAt: now(), completedAt: undefined } })
    installation = createSplitSmokeProfile({
      tarball: candidate.tarball,
      targetDshVersion: candidate.targetDshVersion,
      workDir: root,
    })
    c1Work = writeC1WorkFixture(installation.profileDir, root)
    scene = { kind: 'pilot', workDir: root, installation, candidate, c1Work }
  } catch (error) {
    installInProgress = false
    let cleanupError
    if (root !== undefined) {
      try {
        rmSync(root, { recursive: true, force: true })
        scene = undefined
      } catch (removeError) {
        cleanupError = boundedError(removeError)
      }
    }
    writeReceipt({
      phase: 'NOT_QUIESCED',
      errorName: boundedError(error),
      cleanupError,
      install: { inProgress: false, completed: false, failedAt: now() },
    })
    throw error
  }
  installInProgress = false
  writeReceipt({
    phase: 'INSTALL_COMPLETE',
    install: { inProgress: false, completed: true, startedAt: receipt.install?.startedAt, completedAt: now() },
  })
  if (disconnected || process.connected !== true) {
    await cleanup('worker-disconnected-during-bootstrap')
    return undefined
  }
  writeReceipt({
    phase: 'SCENE_READY',
    candidate: { tarball: candidate.tarball, sha256: candidate.candidateSha256, dshVersion: candidate.targetDshVersion },
    install: { inProgress: false, completed: true, startedAt: receipt.install?.startedAt, completedAt: now() },
  })
  return {
    workDir: root,
    candidate: { tarball: candidate.tarball, candidateSha256: candidate.candidateSha256, targetDshVersion: candidate.targetDshVersion },
    installation: publicInstallation(installation),
    c1Work: { patchPath: c1Work.patchPath },
  }
}

/**
 * Bootstrap the ONE immutable single-package process Scene.
 *
 * The Worker's preflight facts are NOT trusted: this process re-reads the real
 * candidate bytes, the exact DSH pin and the SHA256 before it creates a root,
 * installs anything or starts a Host. The install uses the existing bundled
 * single-package provisioning, and the read-only product scope authority
 * publishes the exact scope/seat BEFORE the first Host can exist.
 */
async function handleBootstrapProcess(message) {
  await modulesReady
  if (scene !== undefined) throw new Error('BOOTSTRAP_PROCESS: scene already exists')
  if (!Number.isInteger(message.workerPid) || message.workerPid <= 0
    || !Number.isInteger(message.workerPpid) || message.workerPpid <= 0) {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP_PROCESS requires real workerPid and workerPpid')
  }
  if (typeof message.sceneId !== 'string' || message.sceneId === '') {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP_PROCESS requires a sceneId')
  }
  if (typeof message.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(message.expectedSha256)) {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP_PROCESS requires the expected candidate SHA256')
  }
  const tmpBase = validateTmpBase(message.tmpBase)
  // The resource owner mirrors the Worker wrapper's canonical-input contract: a
  // symlink alias is refused BEFORE any receipt, root or install exists. The
  // historical validators keep resolving aliases for their other consumers.
  if (tmpBase !== message.tmpBase) {
    throw new Error(`INPUT_UNQUALIFIED: BOOTSTRAP_PROCESS requires a canonical tmpBase, not a symlink alias: ${message.tmpBase} -> ${tmpBase}`)
  }
  initReceipt(tmpBase, { pid: message.workerPid, ppid: message.workerPpid }, {
    kind: 'process',
    sceneId: message.sceneId,
    parentRunId: typeof message.parentRunId === 'string' && message.parentRunId !== '' ? message.parentRunId : undefined,
    installation: undefined,
    scope: undefined,
    installFacts: undefined,
    processClients: [],
    publicLaunches: [],
    publicHosts: [],
    processNativeOperation: undefined,
    qualificationHelpers: [],
    installationMutation: undefined,
  })
  let root
  let installation
  let scope
  let installFacts
  try {
    processCandidate = inspectImmutableSplitCandidate(message.tarball)
    if (processCandidate.candidateSha256 !== message.expectedSha256) {
      throw codedInputError('INPUT_CANDIDATE_CHANGED',
        'the Supervisor re-read different candidate bytes than the Worker preflight')
    }
    // The run root is the ONE directory this Supervisor will later remove; its
    // name makes the provenance of a retained root unmistakable.
    assertLifecycleOpen('BOOTSTRAP_PROCESS before the Scene root')
    // The shared download cache is account-level state, not a Scene resource:
    // it is validated before the root/install/Host exists and is never removed
    // by Scene cleanup. Only this explicit Process branch opts in.
    const installCacheRoot = prepareInstallCache({
      tmpBase,
      override: process.env.SPLIT_VITEST_PNPM_CACHE_ROOT,
      candidateTarballs: [processCandidate.tarball],
    })
    root = createTestTempDir('dsh-split-process-foundation.', tmpBase)
    scene = { kind: 'process', workDir: root }
    installInProgress = true
    appendNote('bootstrap-root-created', { sceneRoot: root })
    writeReceipt({
      phase: 'PROCESS_BOOTSTRAP_ROOT_CREATED',
      sceneRoot: root,
      candidate: {
        tarball: processCandidate.tarball,
        sha256: processCandidate.candidateSha256,
        version: processCandidate.manifest?.version,
        manifestPin: processCandidate.manifestPin,
        dshVersion: processCandidate.targetDshVersion,
        stat: processCandidate.stat,
      },
      install: { inProgress: true, completed: false, startedAt: now(), completedAt: undefined },
    })
    // A synchronous real installer runs here. The external bootstrap-install
    // probe window is this durable in-progress receipt plus the real installer
    // process tree; no artificial delay is inserted.
    installation = createSplitSmokeProfile({
      tarball: processCandidate.tarball,
      targetDshVersion: processCandidate.targetDshVersion,
      workDir: root,
      clientPlatformProvisioning: 'bundled',
      installCacheRoot,
    })
    assertImmutableSplitCandidateUnchanged(processCandidate)
    if (process.env.SPLIT_VITEST_PROCESS_FAILURE_POINT === 'after-profile-install') {
      // Negative control: the real installation completed and the Supervisor
      // must fail closed BEFORE any Host exists, then remove its own root.
      throw new Error('SPLIT_VITEST_INTENTIONAL_FAILURE: setup failed after the profile install')
    }
    installFacts = installedPackageFacts(
      installation.profilePackage,
      processCandidate.manifest?.version,
      processCandidate.targetDshVersion,
      'process profile',
    )
    scope = inspectInstalledProfileScope({
      dshHome: installation.dshHome,
      profileDir: installation.profileDir,
      packageRoot: installFacts.packageRoot,
      dshVersion: processCandidate.targetDshVersion,
    })
    if (scope.buildId !== installFacts.buildId) {
      throw new Error('the read-only installed scope does not name the installed package build')
    }
    processScope = scope
    scene = { kind: 'process', workDir: root, installation, installFacts, scope }
    installInProgress = false
    writeReceipt({
      phase: 'INSTALL_COMPLETE',
      install: { inProgress: false, completed: true, startedAt: receipt.install?.startedAt, completedAt: now() },
      installation: {
        ...receiptInstallation(installation),
        profilePackage: installation.profilePackage,
        clientPlatformProvisioning: installation.clientPlatformProvisioning,
      },
      scope: {
        scopeId: scope.scopeId,
        buildId: scope.buildId,
        bundleVersion: scope.bundleVersion,
        dshVersion: scope.dshVersion,
        hostSeat: hostSeatDescriptor(scope.scopeId),
        qualificationSeat: qualificationSeatDescriptor(scope.scopeId, installation.dshHome),
      },
      installFacts,
    })
  } catch (error) {
    installInProgress = false
    let cleanupError
    if (root !== undefined) {
      try {
        rmSync(root, { recursive: true, force: true })
        scene = undefined
      } catch (removeError) {
        cleanupError = boundedError(removeError)
      }
    }
    writeReceipt({
      phase: cleanupError === undefined ? 'ABORTED_CLEAN' : 'NOT_QUIESCED',
      errorName: boundedError(error),
      cleanupError,
      install: { inProgress: false, completed: false, failedAt: now() },
    })
    throw error
  }
  if (disconnected || process.connected !== true) {
    await cleanup('worker-disconnected-during-bootstrap')
    return undefined
  }
  writeReceipt({ phase: 'SCENE_READY' })
  return {
    workDir: root,
    candidate: {
      tarball: processCandidate.tarball,
      candidateSha256: processCandidate.candidateSha256,
      version: processCandidate.manifest?.version,
      manifestPin: processCandidate.manifestPin,
      targetDshVersion: processCandidate.targetDshVersion,
    },
    installation: publicInstallation(installation),
    scope: {
      scopeId: scope.scopeId,
      buildId: scope.buildId,
      bundleVersion: scope.bundleVersion,
      dshVersion: scope.dshVersion,
      hostSeat: hostSeatDescriptor(scope.scopeId),
      qualificationSeat: qualificationSeatDescriptor(scope.scopeId, installation.dshHome),
    },
  }
}

async function handleBootstrapUpgrade(message) {
  await modulesReady
  if (scene !== undefined) throw new Error('BOOTSTRAP_UPGRADE: scene already exists')
  if (!Number.isInteger(message.workerPid) || message.workerPid <= 0
    || !Number.isInteger(message.workerPpid) || message.workerPpid <= 0) {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP_UPGRADE requires real workerPid and workerPpid')
  }
  if (typeof message.sceneId !== 'string' || message.sceneId === '') {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP_UPGRADE requires a sceneId')
  }
  const policy = message.policy ?? 'default'
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const admission = nativeBootstrapAdmission({ policy, manager: message.manager, platform: process.platform, uid })
  // The fixed platform helper is loaded BEFORE any Scene root, Profile install
  // or manager call. A default Scene never reaches this branch or this import.
  const nativeAdapter = admission.native
    ? await loadNativeManagerAdapter(admission.manager)
    : undefined
  installInProgress = true
  const tmpBase = validateTmpBase(message.tmpBase)
  initReceipt(tmpBase, { pid: message.workerPid, ppid: message.workerPpid }, {
    kind: 'upgrade',
    sceneId: message.sceneId,
    parentRunId: typeof message.parentRunId === 'string' && message.parentRunId !== '' ? message.parentRunId : undefined,
    native: null,
  })
  let root
  let pair
  let installation
  let c1Work
  let oldProfile
  let currentProfile
  try {
    pair = inspectSplitUpgradePair(message.oldTgz, message.newTgz, { policy })
    assertPairReceipt(pair, message.expectedPairSha)
    // The account-level download cache is validated after the real pair
    // receipt and before any Scene root, install or manager mutation. The
    // Upgrade lifecycle uses the same shared qualifier as the Process branch,
    // but admits BOTH real candidate input directories.
    const installCacheRoot = prepareInstallCache({
      tmpBase,
      override: process.env.SPLIT_VITEST_PNPM_CACHE_ROOT,
      candidateTarballs: [pair.old.path, pair.new.path],
    })
    root = createTestTempDir('upgrade-scene-', tmpBase)
    scene = { kind: 'upgrade', workDir: root, pair, installCacheRoot, sideOld: undefined, sideNew: undefined, profileInstall: undefined }
    if (nativeAdapter !== undefined) {
      nativeRuntime = {
        manager: admission.manager,
        adapter: nativeAdapter,
        reservation: undefined,
        record: undefined,
        currentProfile: undefined,
        cliPending: undefined,
        cliFence: undefined,
        mutationPending: undefined,
        cleanupStarted: false,
        abortController: new AbortController(),
      }
    }
    appendNote('bootstrap-root-created', { sceneRoot: root })
    writeReceipt({
      phase: 'UPGRADE_BOOTSTRAP_ROOT_CREATED',
      sceneRoot: root,
      pair: {
        old: { path: pair.old.path, version: pair.old.version, sha256: pair.old.sha256, manifestPin: pair.old.manifestPin },
        new: { path: pair.new.path, version: pair.new.version, sha256: pair.new.sha256, manifestPin: pair.new.manifestPin },
        targetDshVersion: pair.targetDshVersion,
        policy: pair.policy,
      },
      install: { inProgress: true, completed: false, startedAt: now(), completedAt: undefined },
    })
    installation = createSplitSmokeProfile({
      tarball: pair.old.path,
      targetDshVersion: pair.targetDshVersion,
      workDir: root,
      clientPlatformProvisioning: 'legacy-preseed',
      installCacheRoot,
    })
    c1Work = writeC1WorkFixture(installation.profileDir, root)
    oldProfile = installedPackageFacts(installation.profilePackage, pair.old.version, pair.targetDshVersion, 'old profile')
    currentProfile = { role: 'old', installGeneration: 1, ...oldProfile }
    if (nativeRuntime !== undefined) nativeRuntime.currentProfile = currentProfile
    scene = { kind: 'upgrade', workDir: root, pair, installation, installCacheRoot, c1Work, sideOld: undefined, sideNew: undefined, profileInstall: oldProfile }
  } catch (error) {
    installInProgress = false
    let cleanupError
    if (root !== undefined) {
      try {
        rmSync(root, { recursive: true, force: true })
        scene = undefined
      } catch (removeError) {
        cleanupError = boundedError(removeError)
      }
    }
    writeReceipt({
      phase: 'NOT_QUIESCED',
      errorName: boundedError(error),
      cleanupError,
      install: { inProgress: false, completed: false, failedAt: now() },
    })
    throw error
  }
  installInProgress = false
  writeReceipt({
    phase: 'INSTALL_COMPLETE',
    install: { inProgress: false, completed: true, startedAt: receipt.install?.startedAt, completedAt: now() },
    profile: { old: oldProfile, current: currentProfile },
  })
  if (disconnected || process.connected !== true) {
    await cleanup('worker-disconnected-during-bootstrap')
    return undefined
  }
  writeReceipt({
    phase: 'SCENE_READY',
    profile: { old: oldProfile, current: currentProfile },
  })
  return {
    workDir: root,
    pair,
    installation: publicInstallation(installation),
    c1Work: { patchPath: c1Work.patchPath },
    oldProfile,
    ...(nativeRuntime === undefined ? {} : { native: { manager: nativeRuntime.manager } }),
  }
}

async function handleUpgradeOldProfile() {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_INSTALL_OLD_PROFILE: no upgrade scene')
  // BOOTSTRAP already performed the one real old-profile install; this is the
  // idempotent read-only result method, never a second pnpm transaction.
  if (nativeRuntime !== undefined) {
    // The native Scene's current install record is the ONLY authority. This
    // read-only method must never overwrite a newer native install receipt.
    const current = nativeRuntime.currentProfile
    if (current?.role !== 'old') {
      throw new Error('UPGRADE_INSTALL_OLD_PROFILE: the old Profile is not the current native install')
    }
    const recorded = receipt.profile?.old
    if (recorded === undefined) throw new Error('UPGRADE_INSTALL_OLD_PROFILE: no old Profile install is recorded')
    return recorded
  }
  const facts = installedPackageFacts(scene.installation.profilePackage, scene.pair.old.version, scene.pair.targetDshVersion, 'old profile')
  scene.profileInstall = facts
  writeReceipt({ profile: { ...(receipt.profile ?? {}), old: facts } })
  return facts
}

async function handleUpgradeInstallSide(message, role) {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_INSTALL_SIDE: no upgrade scene')
  if (role !== 'old' && role !== 'new') throw new Error(`UPGRADE_INSTALL_SIDE: unknown role ${String(role)}`)
  assertSplitUpgradePairStillQualified(scene.pair)
  const dir = join(scene.workDir, role === 'old' ? 'side-old' : 'side-new')
  installInProgress = true
  writeReceipt({
    phase: role === 'old' ? 'SIDE_OLD_INSTALL_STARTED' : 'SIDE_NEW_INSTALL_STARTED',
    notes: [...(receipt?.notes ?? []), { event: `${role}-side-install-started`, detail: { dir }, at: now() }],
    install: { inProgress: true, completed: false, startedAt: now(), completedAt: undefined },
  })
  let facts
  try {
    const installEnv = installCacheEnvironment(scene.installation.env, scene.installCacheRoot)
    const packageRoot = installSideBuild(
      dir,
      scene.pair[role].path,
      installEnv,
      scene.pair.targetDshVersion,
      { legacyClientPeers: role === 'old' },
    )
    facts = installedPackageFacts(packageRoot, scene.pair[role].version, scene.pair.targetDshVersion, `side-${role}`)
    linkSideBuildRuntimePeers(dir, scene.installation, packageRoot)
    if (role === 'old') scene.sideOld = facts
    else {
      if (scene.sideOld !== undefined && scene.sideOld.version === facts.version && scene.sideOld.buildId === facts.buildId) {
        throw new Error('INPUT_UNQUALIFIED: INPUT_PAIR_BUILD_ID_EQUAL (INVALID_TEST_PAIRING, not a product regression): '
          + 'the same-SemVer native pair produced identical production build ids')
      }
      scene.sideNew = facts
    }
    installInProgress = false
    writeReceipt({
      install: { inProgress: false, completed: true, startedAt: receipt.install?.startedAt, completedAt: now() },
      sideBuilds: {
        ...(receipt.sideBuilds ?? {}),
        [role]: { packageRoot: facts.packageRoot, version: facts.version, buildId: facts.buildId, payloadHash: facts.payloadHash },
      },
      phase: role === 'old' ? 'SIDE_OLD_INSTALLED' : 'SIDE_NEW_INSTALLED',
    })
    return facts
  } catch (error) {
    installInProgress = false
    writeReceipt({ install: { inProgress: false, completed: false, failedAt: now() }, phase: 'NOT_QUIESCED', errorName: boundedError(error) })
    throw error
  }
}

async function handleUpgradeInstallNewProfileForReload() {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: no upgrade scene')
  if (nativeRuntime !== undefined) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: a native Scene installs Profiles through installManagedProfile')
  }
  if (activeHost === undefined) throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: no active Host')
  if (activeHost.source !== 'side-old' || scene.sideOld === undefined) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: the active Host must run from the side-old package root')
  }
  const sideOldRelative = relative(scene.sideOld.packageRoot, activeHost.entryRealpath)
  if (sideOldRelative === '' || sideOldRelative === '..' || sideOldRelative.startsWith(`..${sep}`)) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: the active Host entry is outside the side-old package')
  }
  assertSplitUpgradePairStillQualified(scene.pair)
  const sideOldHashBefore = installedPayloadHash(scene.sideOld.packageRoot)
  if (sideOldHashBefore !== scene.sideOld.payloadHash) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: the side-old payload changed')
  }
  const hostPidBefore = activeHost.child.pid
  const pgidBefore = hostPgid(activeHost)
  if (!pidAlive(hostPidBefore) || !processGroupAlive(pgidBefore)) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: the active Host is not alive before the profile update')
  }
  const statusBefore = await queryHostStatus(activeHost)
  const identityBefore = safeIdentity(statusBefore.localHost)
  const facts = await installProfilePackage(scene.pair.new.path)
  if (process.env.SPLIT_VITEST_UPGRADE_HOST_EXIT_AFTER_PROFILE_INSTALL === '1') {
    // Test-harness negative control for the fresh-liveness contract: the
    // install succeeded, but the owned Host disappears before the post-install
    // status check. This must be observed as a failure, never papered over by
    // the cached ready record.
    await terminateHost(activeHost, 'injected-host-exit-during-profile-install')
  }
  if (activeHost.exited || activeHost.child.exitCode !== null || activeHost.child.signalCode !== null
    || !pidAlive(hostPidBefore) || !processGroupAlive(pgidBefore)) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: the active Host exited during the profile update')
  }
  const statusAfter = await queryHostStatus(activeHost)
  assertIdentityKept(safeIdentity(statusAfter.localHost), identityBefore, 'UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD')
  const sideOldHashAfter = installedPayloadHash(scene.sideOld.packageRoot)
  if (sideOldHashAfter !== sideOldHashBefore) {
    throw new Error('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD: the official install modified the live side-old payload')
  }
  scene.profileInstall = facts
  writeReceipt({ profile: { ...(receipt.profile ?? {}), newForReload: facts }, phase: 'NEW_PROFILE_INSTALLED_FOR_RELOAD' })
  return facts
}

async function handleUpgradeActivateNewProfileAfterStop() {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP: no upgrade scene')
  if (nativeRuntime !== undefined) {
    throw new Error('UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP: a native Scene installs Profiles through installManagedProfile')
  }
  if (activeHost !== undefined) throw new Error('UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP: a Host is still active')
  const first = hosts[0]
  if (first === undefined || first.generation !== 1) {
    throw new Error('UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP: no old Profile Host generation was recorded')
  }
  if (!first.exited || first.exitResult?.code !== 0 || first.exitResult?.signal !== null) {
    throw new Error('UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP: the old Host was not officially stopped')
  }
  for (const handle of hosts) await assertHostGroupGone(handle, 'UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP')
  assertSplitUpgradePairStillQualified(scene.pair)
  const facts = await installProfilePackage(scene.pair.new.path)
  scene.profileInstall = facts
  writeReceipt({ profile: { ...(receipt.profile ?? {}), new: facts }, phase: 'NEW_PROFILE_ACTIVATED' })
  return facts
}


/** The ONE durable native reservation, written BEFORE any native install/start. */
async function handleNativeReserveManagedService() {
  const runtime = requireNativeScene('NATIVE_RESERVE_MANAGED_SERVICE')
  if (runtime.reservation !== undefined) {
    throw new Error('NATIVE_RESERVE_MANAGED_SERVICE: the managed service is already reserved')
  }
  const seed = hosts[0]
  const scopeId = seed?.ready?.localHost?.scopeId
  if (typeof scopeId !== 'string' || scopeId === '') {
    throw new Error('NATIVE_RESERVE_MANAGED_SERVICE: the seed Host published no official scope identity')
  }
  for (const handle of hosts) await assertHostGroupGone(handle, 'NATIVE_RESERVE_MANAGED_SERVICE')
  await assertSceneHostSeatFree('NATIVE_RESERVE_MANAGED_SERVICE')
  const current = runtime.currentProfile
  if (current === undefined) throw new Error('NATIVE_RESERVE_MANAGED_SERVICE: the current Profile install is not recorded')
  const packageRoot = realpathSync(scene.installation.profilePackage)
  const installedBuildId = productionBuildId(packageRoot, scene.pair.targetDshVersion)
  const installedPayload = installedPayloadHash(packageRoot)
  const profileBuildIdMatch = installedBuildId === current.buildId && installedPayload === current.payloadHash
  const sceneFacts = {
    kind: scene.kind,
    policy: scene.pair.policy,
    manager: runtime.manager,
    selectedManager: runtime.manager,
    activeHost: activeHost !== undefined,
    hosts: hosts.map(handle => ({
      generation: handle.generation,
      exited: handle.exited,
      exitCode: handle.exitResult?.code ?? null,
      exitSignal: handle.exitResult?.signal ?? null,
      groupGone: !processGroupAlive(hostPgid(handle)),
    })),
    seatFree: true,
    profileBuildIdMatch,
  }
  assertManagedReservationScene(sceneFacts)
  // The shared transaction asks the helper, classifies the raw facts and then
  // durably writes the single receipt BEFORE the Worker is acknowledged.
  const result = await executeNativeServiceReservation({
    reservationInput: {
      manager: runtime.manager,
      uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
      accountHome: realpathSync(userInfo().homedir),
      profileRealpath: realpathSync(scene.installation.profileDir),
      dshHome: realpathSync(scene.installation.dshHome),
      scopeId,
      oldBuildId: current.buildId,
      sceneId: receipt.sceneId,
      parentRunId: receipt.parentRunId ?? null,
    },
    adapter: runtime.adapter,
    writeDurable: async record => {
      assertLifecycleOpen('NATIVE_RESERVE_MANAGED_SERVICE')
      runtime.reservation = record.reservation
      runtime.record = record
      writeReceipt({ phase: 'NATIVE_SERVICE_RESERVED', native: record })
    },
    verifiedAt: now(),
  })
  return { reservation: result.reservation, observation: result.observation }
}

/** Read the real manager/Profile/Host facts; never a Worker-provided identity. */
async function handleNativeVerifyManagedService() {
  requireNativeRuntime('NATIVE_VERIFY_MANAGED_SERVICE')
  return await observeNativeService({ runStatus: true })
}

/** Execute ONE fixed official daemon verb through the single CLI slot. */
async function handleNativeRunProfileDaemon(message) {
  const runtime = requireNativeRuntime('NATIVE_RUN_PROFILE_DAEMON')
  const verb = message.verb
  if (!['status', 'install', 'start', 'restart', 'stop', 'uninstall'].includes(verb)) {
    throw new Error(`NATIVE_RUN_PROFILE_DAEMON: unsupported daemon verb ${String(verb)}`)
  }
  if (runtime.cliPending !== undefined) {
    throw new Error(`NATIVE_CLI_BUSY: daemon ${String(runtime.cliPending.verb)} is still in flight`)
  }
  const previousFence = refreshNativeCliFence()
  if (previousFence.state !== 'clear') {
    throw new Error(`NATIVE_CLI_NOT_QUIESCED: a previous daemon child is not proven reaped (${previousFence.state}, pid ${String(previousFence.pid)})`)
  }
  if (verb !== 'status') {
    const verified = await observeNativeService({ runStatus: false })
    const decision = allowNativeMutation({
      reservation: runtime.reservation,
      observation: verified.observation,
      verb,
      cliBusy: false,
    })
    if (!decision.allowed) {
      throw new Error(`NATIVE_DAEMON_NOT_ADMITTED: daemon ${verb} refused (${String(decision.reason)})`)
    }
  }
  let result
  try {
    result = await runNativeCli(verb, { mutating: verb !== 'status' })
    // Every successful official mutation is verified against the real manager
    // before the Worker receives the exit facts; `status` already ran.
    await observeNativeService({ runStatus: verb !== 'status' })
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const unquiesced = isNativeDaemonUnquiesced(error)
    const topCode = unquiesced !== null ? 'NOT_QUIESCED' : error?.code
    const terminalPhase = topCode === 'NATIVE_DAEMON_CANCELLED' && error?.issued !== false
      ? 'CANCELLED'
      : topCode === 'NATIVE_DAEMON_TIMEOUT' || topCode === 'NOT_QUIESCED'
        || topCode === 'NATIVE_DAEMON_SPAWN_FAILED'
        ? 'UNKNOWN'
        : undefined
    if (terminalPhase !== undefined && runtime.record?.lastOperation !== undefined && runtime.record.lastOperation !== null) {
      runtime.record = {
        ...runtime.record,
        lastOperation: { ...runtime.record.lastOperation, phase: terminalPhase },
      }
      writeReceipt({ native: runtime.record })
    }
    // A committed-but-unacknowledged command is never called "not executed":
    // re-read the real manager unless the CLI child itself is still unsettled.
    if (!lifecycleClosed && unquiesced === null) {
      let observeError
      try {
        await observeNativeService({ runStatus: false })
      } catch (readError) {
        observeError = readError
      }
      const combined = combineNativeFailures(error, observeError)
      throw combined === error ? error : combined
    }
    throw error
  }
}

/** Install the new or the old Profile through the official DSH command. */
async function handleNativeInstallManagedProfile(message) {
  const runtime = requireNativeRuntime('NATIVE_INSTALL_MANAGED_PROFILE')
  const role = message.role
  if (role !== 'new' && role !== 'old') {
    throw new Error(`NATIVE_INSTALL_MANAGED_PROFILE: unknown role ${String(role)}`)
  }
  const current = runtime.currentProfile
  if (current === undefined) throw new Error('NATIVE_INSTALL_MANAGED_PROFILE: the current Profile install is not recorded')
  if (role === 'new' && current.role !== 'old') {
    throw new Error('NATIVE_PROFILE_INSTALL_ORDER: a new Profile install requires the old Profile as current')
  }
  if (role === 'old' && current.role !== 'new') {
    throw new Error('NATIVE_PROFILE_INSTALL_ORDER: a rollback install requires the new Profile as current')
  }
  if (role === 'old') {
    const verified = await observeNativeService({ runStatus: false })
    // Linux may roll back over a strictly verified installed-inactive unit:
    // the product's verified restart adopts the current install. macOS must
    // recreate the LaunchAgent plist, so an installed job is refused.
    assertNativeRollbackAdmission({ manager: runtime.manager, observation: verified.observation })
  }
  // The lifecycle may have closed while the manager was read. Re-check
  // synchronously at the official install boundary, not only at dispatch entry.
  assertLifecycleOpen('NATIVE_INSTALL_MANAGED_PROFILE')
  const facts = await installProfilePackage(scene.pair[role].path)
  const installGeneration = current.installGeneration + 1
  try {
    assertNativeManagedProfileInstall({
      role,
      pair: scene.pair,
      oldBuildId: runtime.reservation.oldBuildId,
      installed: facts,
    })
  } catch (error) {
    // The official package install committed. Record the REAL installed facts
    // (never "not installed") and fail; the run cleanup reclaims the service.
    const committed = { role, installGeneration, ...facts }
    scene.profileInstall = facts
    runtime.currentProfile = committed
    writeReceipt({
      profile: { ...(receipt.profile ?? {}), current: committed },
      phase: 'NOT_QUIESCED',
      errorName: boundedError(error),
      notes: [...(receipt?.notes ?? []), { event: 'native-profile-install-committed', detail: { role, buildId: facts.buildId }, at: now() }],
    })
    throw error
  }
  const installed = { role, installGeneration, ...facts }
  scene.profileInstall = facts
  runtime.currentProfile = installed
  writeReceipt({
    profile: {
      ...(receipt.profile ?? {}),
      current: installed,
      ...(role === 'new' ? { new: facts } : { rollback: facts }),
    },
    phase: role === 'new' ? 'NATIVE_NEW_PROFILE_INSTALLED' : 'NATIVE_OLD_PROFILE_REINSTALLED',
  })
  return facts
}

/** The launchd-only, fixed user customization transaction. */
async function handleNativeCustomizeManagedService(message) {
  const runtime = requireNativeRuntime('NATIVE_CUSTOMIZE_MANAGED_SERVICE')
  if (runtime.manager !== 'launchd') {
    throw new Error('NATIVE_CUSTOMIZE_NOT_LAUNCHD: managed-service customization is launchd-only')
  }
  const customization = requireLaunchdCustomization(message.customization)
  if (typeof runtime.adapter.customizeManagedService !== 'function') {
    throw new Error('NATIVE_MANAGER_ADAPTER_INVALID: the launchd helper exposes no customizeManagedService')
  }
  const verified = await observeNativeService({ runStatus: false })
  const observation = verified.observation
  if (observation.file !== 'owned' || observation.ownerVerified !== true || observation.fileFacts === null) {
    throw new Error('NATIVE_CUSTOMIZE_UNOWNED: the managed plist is not strictly owned by this run')
  }
  if (observation.state !== 'installed-inactive' && observation.state !== 'managed-active') {
    throw new Error(`NATIVE_CUSTOMIZE_UNOWNED: the managed plist is not an installed definition (${observation.state})`)
  }
  if (runtime.record.fileIdentity === null) {
    throw new Error('NATIVE_CUSTOMIZE_UNOWNED: the managed plist has no recorded file identity')
  }
  assertLifecycleOpen('NATIVE_CUSTOMIZE_MANAGED_SERVICE')
  /**
   * The helper performs real manager/plist IO. Track the whole customize
   * transaction so disconnect cleanup either waits for its terminal state or
   * preserves the Scene as NOT_QUIESCED; it may never remove the root while the
   * helper can still commit.
   */
  let settleMutation
  const mutationTerminal = new Promise(resolve => { settleMutation = resolve })
  runtime.mutationPending = { verb: 'customize', promise: mutationTerminal }
  // If cleanup already timed out on this transaction, the late commit must not
  // erase its NOT_QUIESCED terminal state; keep the mutation facts but preserve
  // the cleanup reason and the unverifiable lifecycle.
  const commitCustomizeRecord = (next) => {
    const timedOut = runtime.cleanupStarted && runtime.record?.cleanup?.reason === 'NATIVE_MUTATION_NOT_QUIESCED'
    writeNativeRecord(timedOut
      ? { ...next, lifecycle: 'unverifiable', cleanup: runtime.record.cleanup }
      : next)
    return timedOut
  }
  /**
   * The helper already replaced the plist. Any result that does not prove this
   * run's owned definition and the returned file identity is an UNKNOWN commit,
   * never an EXITED success. The live and persistent records carry that state.
   */
  const uncertainCommit = (errorName, record = runtime.record) => {
    commitCustomizeRecord({
      ...record,
      lifecycle: 'unverifiable',
      lastOperation: { verb: 'customize', phase: 'UNKNOWN', pid: null, exitCode: null, signal: null, at: now() },
    })
    writeReceipt({ phase: 'NOT_QUIESCED', errorName })
  }
  try {
    let result
    try {
      result = await runtime.adapter.customizeManagedService({
        ...runtime.reservation,
        fileIdentity: runtime.record.fileIdentity,
      }, customization)
    } catch (error) {
      // The helper failed at an unknown point: it may or may not have replaced
      // the plist. Keep the live and persistent record uncertain.
      uncertainCommit(boundedError(error))
      throw error
    }
    const inspection = result?.observation
    if (inspection === undefined || inspection === null) {
      uncertainCommit('NATIVE_CUSTOMIZE_INVALID')
      throw new Error('NATIVE_CUSTOMIZE_INVALID: the helper returned no observation')
    }
    let nextObservation
    try {
      const kernel = inspection.mainPid === null ? null : nativeKernelFacts(inspection.mainPid)
      nextObservation = classifyManagedInspection({
        reservation: runtime.reservation,
        history: { everObservedInstalled: runtime.record.everObservedInstalled },
        inspection,
        kernel,
        verifiedAt: now(),
      })
    } catch (error) {
      // The raw helper observation cannot be classified at the commit boundary.
      uncertainCommit(boundedError(error))
      throw error
    }
    const record = applyServiceObservation(runtime.record, nextObservation)
    // Only a proven owned target of this run may be acknowledged. A classified
    // `unverifiable`/foreign/removed observation is a committed-but-unproven
    // customization, even when the helper returned an owned file identity.
    if (!isAcceptedCustomizedObservation(nextObservation)) {
      uncertainCommit('NATIVE_CUSTOMIZE_UNVERIFIABLE', record)
      throw new Error(`NATIVE_CUSTOMIZE_UNVERIFIABLE: the customized plist is not a proven owned definition (${nextObservation.state})`)
    }
    const returnedIdentity = result.fileIdentity
    const invalidIdentity = (message) => {
      // The helper may already have replaced the plist. Never present the old
      // identity as current; the live and persistent record both carry the
      // unverifiable committed state.
      uncertainCommit('NATIVE_CUSTOMIZE_IDENTITY_MISMATCH', record)
      throw new Error(`NATIVE_CUSTOMIZE_IDENTITY_MISMATCH: ${message}`)
    }
    if (returnedIdentity === null || returnedIdentity === undefined) {
      invalidIdentity('the helper returned no customized file identity')
    }
    if (typeof returnedIdentity.device !== 'string' || typeof returnedIdentity.inode !== 'string'
      || typeof returnedIdentity.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(returnedIdentity.sha256)) {
      invalidIdentity('the helper returned an invalid file identity')
    }
    if (record.fileIdentity === null
      || record.fileIdentity.device !== returnedIdentity.device
      || record.fileIdentity.inode !== returnedIdentity.inode
      || record.fileIdentity.sha256 !== returnedIdentity.sha256) {
      invalidIdentity('the receipt identity is not the observed customized file')
    }
    const committed = {
      ...record,
      lastOperation: { verb: 'customize', phase: 'EXITED', pid: null, exitCode: 0, signal: null, at: now() },
    }
    // The updated real file identity is durable in BOTH the live record and the
    // receipt before the Worker is acknowledged; a later status rebuild starts
    // from the committed identity, never the previous one.
    const timedOut = commitCustomizeRecord(committed)
    if (!timedOut) writeReceipt({ phase: 'NATIVE_SERVICE_CUSTOMIZED' })
    if (lifecycleClosed) {
      // The helper transaction already committed. The record above is the truth;
      // the Worker must not receive a success acknowledgement from a closing Scene.
      throw new Error('NATIVE_SCENE_CLOSED: the managed-plist customization committed while the Scene was closing')
    }
    return { reservation: runtime.reservation, observation: committed.observed }
  } finally {
    settleMutation()
    runtime.mutationPending = undefined
  }
}

/** Re-bind the Client entry to the CURRENT install receipt before any spawn. */
async function handleNativeCurrentProfile() {
  const runtime = requireNativeScene('NATIVE_CURRENT_PROFILE')
  const current = runtime.currentProfile
  if (current === undefined) {
    throw new Error('NATIVE_PROFILE_INSTALL_UNRECORDED: the current Profile install is not recorded')
  }
  const packageRoot = realpathSync(join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'))
  const manifest = readJson(join(packageRoot, 'package.json'), 'current profile package.json')
  const onDisk = {
    packageRoot,
    version: manifest.version,
    buildId: productionBuildId(packageRoot, scene.pair.targetDshVersion),
    payloadHash: installedPayloadHash(packageRoot),
    entries: {
      host: realpathSync(join(packageRoot, 'dist', 'local-host.mjs')),
      client: realpathSync(join(packageRoot, 'dist', 'local-client.mjs')),
    },
  }
  const verdict = classifyCurrentProfile({ receipt: current, current: onDisk })
  if (!verdict.current) {
    throw new Error(`${verdict.reason}: the current Profile package does not match this run's install receipt`)
  }
  return {
    packageRoot,
    version: onDisk.version,
    buildId: onDisk.buildId,
    payloadHash: onDisk.payloadHash,
    entries: onDisk.entries,
  }
}

async function handleStartHost(message) {
  if (scene === undefined) throw new Error('START_HOST: no scene')
  if (nativeRuntime?.reservation !== undefined) {
    throw new Error('START_HOST: a native managed service owns this Scene; use runProfileDaemon')
  }
  if (activeHost !== undefined) throw new Error('START_HOST: one active Host per scene is supported')
  if (scene.kind === 'pilot' && hosts.length > 0) throw new Error('START_HOST: one Host per scene is supported')
  if (scene.kind === 'process') assertNoBootstrapCliPatch('START_HOST')
  if (scene.kind !== 'process' && message.crashSignal !== undefined) {
    throw new Error('START_HOST: only a process Scene accepts a declared Host crash signal')
  }

  let source = 'profile'
  let entry
  let entryRealpath
  let buildId
  let expectedVersion
  let expectedScopeId
  let workRoot
  let env
  let scenario
  let crashSignal
  let workloadRoot
  let holdReleasePath
  let jobWorkRoot
  if (scene.kind === 'process') {
    scenario = message.scenario
    crashSignal = message.crashSignal
    if (scenario !== undefined && !PROCESS_HOST_SCENARIOS.has(scenario)) {
      throw new Error(`START_HOST: unknown process workload scenario ${JSON.stringify(scenario)}`)
    }
    if (crashSignal !== undefined && !PROCESS_HOST_CRASH_SIGNALS.has(crashSignal)) {
      throw new Error(`START_HOST: unknown process crash signal ${JSON.stringify(crashSignal)}`)
    }
    if (crashSignal !== undefined && scenario !== 'long-turn') {
      throw new Error('START_HOST: a declared crash signal requires the long-turn workload')
    }
    if (message.extraEnv !== undefined) {
      throw new Error('START_HOST: a process scene does not accept arbitrary extra environment')
    }
    // A next generation is allowed only after the previous one is provably
    // stopped: a finished qualification attempt with its declared terminal, or
    // an ordinary generation with a clean exit. A bare `finished` flag is not
    // enough — the attempt's terminal contract was already validated against
    // its real records, exit and group.
    for (const previous of hosts) {
      if (!previous.exited) throw new Error('START_HOST: the previous Host generation has not stopped')
      await assertHostGroupGone(previous, 'START_HOST: previous generation')
      const cleanExit = previous.exitResult?.code === 0 && previous.exitResult?.signal === null
      if (previous.acceptedHost === true) {
        // The ONE explicit qualification exception: ACCEPT_HOST_WINNER validated
        // the ready identity/seat/terminal owner before setting this flag.
        if (!cleanExit) {
          throw new Error(`START_HOST: the accepted Host exited abnormally: ${JSON.stringify(previous.exitResult ?? null)}`)
        }
        continue
      }
      if (previous.finished === true) {
        // FINISH_ENTRY validated this attempt's whole terminal contract. A
        // finished attempt (including a declared refusal or a stopped window)
        // is a legal predecessor; only an UN-finished mode-bearing contender is
        // not, regardless of its exit code.
        if (previous.terminal === undefined) {
          throw new Error('START_HOST: the previous attempt has no validated terminal facts')
        }
        continue
      }
      if (previous.mode !== undefined) {
        throw new Error('START_HOST: an un-finished Host attempt cannot become a previous generation')
      }
      if (!cleanExit) {
        throw new Error(`START_HOST: the previous Host generation exited abnormally: ${JSON.stringify(previous.exitResult ?? null)}`)
      }
    }
    for (const fallback of fallbackHosts) {
      if (fallback.normalStopRequired !== true) continue
      if (fallback.reclaimed !== true) {
        throw new Error(`START_HOST: the discovered Host PID ${String(fallback.pid)} has not been normally reclaimed`)
      }
      if (fallback.normalStop !== true) {
        throw new Error(`START_HOST: the discovered Host PID ${String(fallback.pid)} was not stopped through RECLAIM_DISCOVERED_HOST`)
      }
    }
    if (processInstallationMutation !== undefined) {
      throw codedInputError('INPUT_INSTALLATION_MUTATED', 'START_HOST is not allowed under a mutated installation')
    }
    await assertSceneHostSeatFree('START_HOST: previous generation')
    const facts = assertProcessInstalledFacts('START_HOST')
    if (processScope === undefined) throw new Error('START_HOST: the process scope is not recorded')
    entry = facts.entries.host
    entryRealpath = realpathSync(entry)
    buildId = facts.buildId
    expectedVersion = facts.version
    expectedScopeId = processScope.scopeId
    const generationLabel = String(hosts.length + 1)
    workRoot = join(scene.workDir, `host-${generationLabel}`)
    mkdirSync(workRoot, { recursive: true, mode: 0o700 })
    const hostScratch = join(scene.workDir, `host-scratch-${generationLabel}`)
    mkdirSync(hostScratch, { recursive: true, mode: 0o700 })
    // The curated install environment already carries the offline LLM patch.
    // A workload is prepared once, on demand, with the existing C1 fixture; its
    // roots are Supervisor-owned and no Worker path/environment is accepted.
    env = {
      ...scene.installation.base.env,
      DSH_PI_TUI_ENTRY_RECORDS: '1',
      SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
      SPLIT_PROCESS_PROFILE: 'pi-tui',
      SPLIT_PROCESS_SCRATCH: hostScratch,
    }
    if (scenario !== undefined) {
      processC1Work = processC1Work ?? writeC1WorkFixture(scene.installation.profileDir, scene.workDir)
      const workloadLabel = `${scenario}-${generationLabel}`
      workloadRoot = scenario === 'job'
        ? join(scene.installation.profileDir, `c1-job-${workloadLabel}`)
        : join(scene.workDir, `c1-workload-${workloadLabel}`)
      mkdirSync(workloadRoot, { recursive: true, mode: 0o700 })
      if (scenario === 'job') jobWorkRoot = workloadRoot
      env.SPLIT_PROCESS_EXTRA_PATCH = processC1Work.patchPath
      env.C1_SCENARIO = scenario
      env.C1_WORK_ROOT = workloadRoot
      if (scenario === 'long-turn') {
        holdReleasePath = join(workloadRoot, 'long-turn.release')
        env.C1_HOLD_LONG_TURN = holdReleasePath
      }
    }
  } else if (scene.kind === 'upgrade') {
    source = message.source ?? 'profile'
    if (source !== 'profile' && source !== 'side-old') {
      throw new Error(`START_HOST: upgrade scenes only start profile or side-old Hosts, got ${String(source)}`)
    }
    if (source === 'side-old') {
      if (scene.sideOld === undefined) throw new Error('START_HOST: side-old has not been installed')
      if (installedPayloadHash(scene.sideOld.packageRoot) !== scene.sideOld.payloadHash) {
        throw new Error('START_HOST: the side-old payload changed after its installation')
      }
      expectedVersion = scene.pair.old.version
      entry = scene.sideOld.entries.host
      buildId = scene.sideOld.buildId
    } else {
      const packageRoot = realpathSync(scene.installation.profilePackage)
      const expected = scene.profileInstall
      if (expected === undefined) throw new Error('START_HOST: the active profile install facts are missing')
      if (installedPayloadHash(packageRoot) !== expected.payloadHash) {
        throw new Error('START_HOST: the active profile payload changed after its installation')
      }
      expectedVersion = expected.version
      entry = realpathSync(join(packageRoot, 'dist', 'local-host.mjs'))
      buildId = productionBuildId(packageRoot, scene.pair.targetDshVersion)
    }
    entryRealpath = realpathSync(entry)
  } else {
    entry = scene.installation.entries.host
    entryRealpath = realpathSync(entry)
  }

  if (env === undefined) {
    workRoot = join(scene.workDir, `c1-${message.scenario}-${String(hosts.length + 1)}`)
    mkdirSync(workRoot, { recursive: true, mode: 0o700 })
    env = {
      ...scene.installation.base.env,
      SPLIT_PROCESS_EXTRA_PATCH: scene.c1Work.patchPath,
      C1_SCENARIO: message.scenario,
      C1_WORK_ROOT: workRoot,
      ...(scene.kind === 'upgrade' && message.scenario === 'long-turn'
        ? { C1_HOLD_LONG_TURN: join(workRoot, 'long-turn.release') }
        : {}),
      DSH_PI_TUI_ENTRY_RECORDS: '1',
      SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
      SPLIT_PROCESS_PROFILE: 'pi-tui',
      SPLIT_PROCESS_SCRATCH: join(scene.workDir, `host-scratch-${message.scenario}-${String(hosts.length + 1)}`),
      ...(message.extraEnv ?? {}),
    }
    mkdirSync(env.SPLIT_PROCESS_SCRATCH, { recursive: true, mode: 0o700 })
  }
  const hostLabel = message.scenario ?? 'split-process'
  // Same lifecycle gate as the qualification Client: a queued/in-flight
  // START_HOST must never create a detached Host after cleanup took over.
  assertLifecycleOpen('START_HOST')
  const child = spawn(process.execPath, [entryRealpath], {
    cwd: scene.installation.base.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  let settleClose
  const closePromise = new Promise(resolve => { settleClose = resolve })
  const records = []
  let stderr = ''
  createInterface({ input: child.stdout }).on('line', line => {
    const trimmed = line.trim()
    if (trimmed === '') return
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      stderr += `${trimmed}\n`
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const generation = hosts.length + 1
  const hostId = `host-${String(generation)}-${String(child.pid)}-${String(Date.now())}`
  const handle = {
    hostId,
    generation,
    source,
    scenario: scenario ?? message.scenario,
    crashSignal,
    workloadRoot,
    holdReleasePath,
    jobWorkRoot,
    child,
    records,
    workRoot,
    entryRealpath,
    buildId,
    expectedVersion,
    expectedScopeId,
    ready: undefined,
    businessPid: null,
    startedAt: now(),
    starttime: readHostStarttime(child.pid),
    birth: (() => {
      try {
        const observation = readKernelProcess(child.pid)
        return observation.kind === 'alive' ? serializeKernelIdentity(observation.identity) : undefined
      } catch {
        return undefined
      }
    })(),
    closePromise,
    closedAt: undefined,
    exited: false,
    exitResult: undefined,
    spawnError: undefined,
    pgid: child.pid ?? null,
  }
  activeHost = handle
  hosts.push(handle)
  // Every handler closes over its OWN generation object. A later generation
  // must never receive an earlier child's close/error event.
  child.once('error', error => {
    handle.spawnError = error
    writeReceipt({ phase: 'HOST_SPAWN_ERROR', errorName: boundedError(error), hostId, generation })
  })
  child.once('close', (code, signal) => {
    handle.exited = true
    handle.exitResult = { code, signal }
    handle.closedAt = now()
    settleClose({ code, signal })
    syncHostReceipt()
  })
  appendNote('host-spawned', {
    hostId,
    generation,
    source,
    pid: child.pid ?? null,
    workerPid: receipt.worker?.pid,
    workRoot,
  })
  syncHostReceipt()
  writeReceipt({ phase: 'HOST_SPAWNED' })
  progress(message.requestId, 'HOST_SPAWNED', { hostId, generation, pid: child.pid ?? null, workRoot })
  if (scene.kind === 'process') {
    // The durable checkpoint (host PID/birth/group and, once known, the seat)
    // is written BEFORE this bounded hold; only an external Worker death
    // releases it and the handler always fails afterwards.
    await processProbeHold('host-spawned-before-ack', {
      hostId,
      generation,
      hostPid: child.pid ?? null,
      hostBirth: handle.starttime,
      scopeId: expectedScopeId,
      seat: hostSeatDescriptor(expectedScopeId),
      workerPid: receipt.worker?.pid,
      workerPpid: receipt.worker?.ppid,
    })
  }
  if (process.env.SPLIT_VITEST_WORKER_KILL_POINT === 'host-spawned-before-ack'
    || (process.env.SPLIT_VITEST_UPGRADE_KILL_POINT === 'new-host-spawned-before-ack' && generation === 2)) {
    appendNote('host-spawned-before-ack-barrier', {
      hostId,
      generation,
      hostPid: child.pid ?? null,
      workerPid: receipt.worker?.pid,
      workerPpid: receipt.worker?.ppid,
    })
    writeReceipt({ phase: 'HOST_SPAWNED_BEFORE_ACK' })
    await waitForWorkerKillBarrier()
    throw new Error('START_HOST: worker was killed at the host-spawned-before-ack barrier')
  }

  let ready
  try {
    ready = await waitForHostRecord(handle, record => record.m4a0 === 'ready' || record.m4a0 === 'failure',
      `${hostLabel} Host ready`, HOST_READY_TIMEOUT_MS)
  } catch (error) {
    if (handle.spawnError !== undefined && child.pid === undefined) {
      handle.exited = true
      handle.exitResult = { code: null, signal: null }
      handle.closedAt = now()
    } else {
      await terminateHost(handle, 'START_HOST wait failed').catch(() => undefined)
    }
    throw error
  }
  if (ready.m4a0 === 'failure') {
    await terminateHost(handle, 'Host reported startup failure').catch(() => undefined)
    throw new Error(`${hostLabel} Host boot failed: ${JSON.stringify({
      code: ready.code,
      error: ready.error,
      phase: ready.phase,
    })}${stderr === '' ? '' : ' (Host stderr present)'}`)
  }
  if (scene.kind === 'process') {
    const localHost = ready.localHost
    if (localHost === undefined || localHost === null) {
      await terminateHost(handle, 'Host published no identity').catch(() => undefined)
      throw new Error('START_HOST: the process Host published no authenticated identity')
    }
    if (localHost.buildId !== handle.buildId) {
      await terminateHost(handle, 'Host build identity mismatch').catch(() => undefined)
      throw new Error(`START_HOST: Host published buildId ${String(localHost.buildId)} but the installed package is ${String(handle.buildId)}`)
    }
    if (localHost.scopeId !== expectedScopeId) {
      await terminateHost(handle, 'Host scope identity mismatch').catch(() => undefined)
      throw new Error('START_HOST: Host published a scope different from the installed profile scope')
    }
    try {
      assertHostIdentityMatchesKernel(localHost, child.pid, 'START_HOST')
    } catch (error) {
      await terminateHost(handle, 'Host kernel identity mismatch').catch(() => undefined)
      throw error
    }
  } else if (scene.kind === 'upgrade' && ready.localHost?.buildId !== handle.buildId) {
    await terminateHost(handle, 'Host build identity mismatch').catch(() => undefined)
    throw new Error(`START_HOST: Host published buildId ${String(ready.localHost?.buildId)} but the installed ${source} package is ${String(handle.buildId)}`)
  }
  handle.ready = ready
  handle.businessPid = ready.pid ?? null
  syncHostReceipt()
  writeReceipt({ phase: 'HOST_READY' })
  return {
    hostId,
    generation,
    ready,
    workRoot,
    source,
    scenario: handle.scenario ?? null,
    crashSignal: handle.crashSignal ?? null,
    workloadRoot: handle.workloadRoot ?? null,
    holdReleasePath: handle.holdReleasePath ?? null,
    jobWorkRoot: handle.jobWorkRoot ?? null,
    buildId: handle.buildId,
    scopeId: expectedScopeId,
    pgid: hostPgid(handle),
    entryRealpath: handle.entryRealpath,
  }
}

async function queryHostStatus(handle) {
  if (handle === undefined || handle.exited || handle.child.exitCode !== null || handle.child.signalCode !== null) {
    throw new Error('HOST_STATUS: Host already exited')
  }
  if (!pidAlive(handle.child.pid) || !processGroupAlive(hostPgid(handle))) {
    throw new Error('HOST_STATUS: Host OS process or process group is not alive')
  }
  const hostRequestId = `supervisor-host-status-${String(++hostStatusSequence)}`
  handle.child.stdin.write(`${JSON.stringify({ op: 'status', requestId: hostRequestId })}\n`)
  const status = await waitForHostRecord(handle,
    record => record.m4a0 === 'status' && record.requestId === hostRequestId,
    `Host status ${hostRequestId}`, 30_000)
  if (status.localHost === undefined || status.localHost === null) {
    throw new Error('HOST_STATUS: the official status response carries no localHost identity')
  }
  return status
}

async function handleHostStatus(message) {
  const handle = activeHost
  if (handle === undefined || handle.hostId !== message.hostId) throw new Error('HOST_STATUS: unknown hostId')
  return await queryHostStatus(handle)
}

async function handleUpgradeReleaseHeldTurn(message) {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_RELEASE_HELD_TURN: no upgrade scene')
  const handle = activeHost
  if (handle === undefined || handle.hostId !== message.hostId) throw new Error('UPGRADE_RELEASE_HELD_TURN: unknown hostId')
  if (handle.exited || handle.child.exitCode !== null || handle.child.signalCode !== null) {
    throw new Error('UPGRADE_RELEASE_HELD_TURN: Host already exited')
  }
  if (!pidAlive(handle.child.pid) || !processGroupAlive(hostPgid(handle))) {
    throw new Error('UPGRADE_RELEASE_HELD_TURN: Host OS process or process group is not alive')
  }
  const releasePath = join(handle.workRoot, 'long-turn.release')
  if (handle.scenario !== 'long-turn' || !existsSync(join(handle.workRoot, 'events.jsonl'))) {
    throw new Error('UPGRADE_RELEASE_HELD_TURN: the active Host is not the long-turn generation')
  }
  const status = await queryHostStatus(handle)
  const identity = safeIdentity(status.localHost)
  writeFileSync(releasePath, 'release\n', { mode: 0o600, flag: 'wx' })
  appendNote('long-turn-released', {
    hostId: handle.hostId,
    generation: handle.generation,
    releasePath,
    instanceId: identity.instanceId,
  })
  writeReceipt({ phase: 'LONG_TURN_RELEASED' })
  return { hostId: handle.hostId, generation: handle.generation, releasePath }
}

async function handleUpgradeRemoveProfileForReloadRefusal(message) {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: no upgrade scene')
  const handle = activeHost
  if (handle === undefined || handle.hostId !== message.hostId) throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: unknown hostId')
  if (handle.source !== 'side-old' || scene.sideOld === undefined) {
    throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: the active Host must run from the side-old package root')
  }
  if (handle.exited || handle.child.exitCode !== null || handle.child.signalCode !== null
    || !pidAlive(handle.child.pid) || !processGroupAlive(hostPgid(handle))) {
    throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: the active Host is not alive')
  }
  const statusBefore = await queryHostStatus(handle)
  const identityBefore = safeIdentity(statusBefore.localHost)
  const sideOldHashBefore = installedPayloadHash(scene.sideOld.packageRoot)
  const profilePackageRoot = join(scene.installation.profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)
  if (!existsSync(profilePackageRoot)) {
    throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: the profile package is not installed before removal')
  }
  const installEnv = installCacheEnvironment(scene.installation.env, scene.installCacheRoot)
  const result = runDsh(scene.installation.dshInvocation,
    ['plugin', '--profile', 'pi-tui', 'remove', EXPECTED_PACKAGE_NAME],
    scene.installation.harnessDir, installEnv)
  if (result.status !== 0) {
    throw new Error(`UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: the official DSH remove failed (status ${String(result.status)})`)
  }
  if (existsSync(profilePackageRoot)) {
    throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: the official removal left the profile package behind')
  }
  const statusAfter = await queryHostStatus(handle)
  assertIdentityKept(safeIdentity(statusAfter.localHost), identityBefore, 'UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL')
  if (installedPayloadHash(scene.sideOld.packageRoot) !== sideOldHashBefore) {
    throw new Error('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL: the official removal changed the live side-old payload')
  }
  writeReceipt({ phase: 'PROFILE_REMOVED_FOR_RELOAD_REFUSAL' })
  return { removed: true, profilePackageRoot, hostStatus: statusAfter }
}

async function handleUpgradeProbeSideNewClientHostFoundation(message) {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: no upgrade scene')
  if (activeQualificationClient !== undefined) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: a qualification Client is already in progress')
  }
  const host = activeHost
  // `activeHost` is the ONE live generation and its hostId carries that
  // generation's PID/timestamp, so an earlier generation can never satisfy
  // this request. The proof below is additionally bound to this generation's
  // real PID/instance and recorded with its generation number.
  if (host === undefined || host.hostId !== message.hostId) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: unknown hostId')
  }
  if (host.exited || host.child.exitCode !== null || host.child.signalCode !== null
    || !pidAlive(host.child.pid) || !processGroupAlive(hostPgid(host))) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the active Host is not alive')
  }
  const sideNew = scene.sideNew
  if (sideNew === undefined) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: side-new has not been installed')
  }
  if (installedPayloadHash(sideNew.packageRoot) !== sideNew.payloadHash) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the side-new payload changed after its installation')
  }
  if (productionBuildId(sideNew.packageRoot, scene.pair.targetDshVersion) !== sideNew.buildId) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the side-new build identity changed')
  }
  const entry = realpathSync(sideNew.entries.client)
  const entryRelative = relative(sideNew.packageRoot, entry)
  if (entryRelative === '' || entryRelative === '..' || entryRelative.startsWith(`..${sep}`)) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the Client entry is outside the installed side-new package')
  }
  // The ONE premise of this proof: a NEW Client build against an OLD Host build.
  if (host.buildId === sideNew.buildId) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the active Host already runs the installed side-new build')
  }
  assertLifecycleOpen('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION')
  appendNote('qualification-status-issued', {
    hostId: host.hostId,
    generation: host.generation,
    pid: host.child.pid ?? null,
  })
  const statusBefore = await queryHostStatus(host)
  // The status await is a lifecycle TOCTOU point: a Worker disconnect can take
  // over cleanup while this handler is suspended. Never continue a spawn after
  // the lifecycle closed.
  assertLifecycleOpen('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION after status')
  const identityBefore = safeIdentity(statusBefore.localHost)
  if (identityBefore.hostPid !== host.child.pid) {
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the Host identity does not name the Supervisor-owned process')
  }
  if (process.env.SPLIT_VITEST_UPGRADE_KILL_POINT === 'qualification-pre-spawn') {
    // Deterministic barrier for the pre-registration window: the Host status
    // was already received and no qualification Client exists yet.
    appendNote('qualification-pre-spawn-hold', {
      hostId: host.hostId,
      generation: host.generation,
      pid: host.child.pid ?? null,
      statusRecordReceived: true,
    })
    writeReceipt({ phase: 'QUALIFICATION_PRE_SPAWN_HOLD' })
    await waitForWorkerKillBarrier()
    // The ONLY stop here is the shared lifecycle admission gate. When the
    // Worker died, the gate rejects and no Client exists. The handler then
    // continues along the real production path (spawn and register) whenever
    // the gate does not reject, so the external negative observes a real late
    // registration or leak instead of a fabricated short-circuit PASS.
    assertLifecycleOpen('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION after the pre-spawn barrier')
  }
  if (process.env.SPLIT_VITEST_UPGRADE_QUALIFICATION_HOST_DEATH === '1') {
    // Controlled negative control for the reported window: the old Host A
    // crashes AFTER the Supervisor's status-before proof and BEFORE the
    // qualification Client's own ensureLocalHost() discovery runs.
    await crashHost(host, 'injected Host death before qualification discovery')
    appendNote('qualification-host-death-injected', {
      hostId: host.hostId,
      generation: host.generation,
      pid: host.child.pid ?? null,
      starttime: host.starttime,
    })
    writeReceipt({ phase: 'QUALIFICATION_HOST_DEATH_INJECTED' })
  }

  // Last synchronous gate before the only spawn in this handler: no await may
  // interleave between this check and the registration below.
  assertLifecycleOpen('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION before spawn')
  const sequence = ++qualificationClientSequence
  const clientDir = join(scene.workDir, `qualification-client-${String(sequence)}`)
  mkdirSync(clientDir, { recursive: true, mode: 0o700 })
  const scratch = join(clientDir, 'scratch')
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, [entry], {
    cwd: scene.installation.base.cwd,
    env: {
      ...scene.installation.base.env,
      DSH_PI_TUI_ENTRY_RECORDS: '1',
      SPLIT_PROCESS_CLIENT_MODE: 'qualification',
      SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
      SPLIT_PROCESS_PROFILE: 'pi-tui',
      SPLIT_PROCESS_SCRATCH: scratch,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  // Register the self-owned one-shot process at the synchronous spawn boundary,
  // before any await or external event: a Worker SIGKILL must never leave it
  // unowned.
  const handle = {
    child,
    pgid: child.pid ?? null,
    scratch,
    hostId: host.hostId,
    generation: host.generation,
    startedAt: now(),
    starttime: readHostStarttime(child.pid),
    records: [],
    spawnError: undefined,
    exited: false,
    exitResult: undefined,
    closedAt: undefined,
    termination: undefined,
  }
  qualificationClients.push(handle)
  activeQualificationClient = handle
  child.once('error', error => { handle.spawnError = error })
  createInterface({ input: child.stdout }).on('line', line => {
    const trimmed = line.trim()
    if (trimmed === '') return
    try {
      handle.records.push(JSON.parse(trimmed))
    } catch {
      // Non-protocol bytes are not records; they never become evidence.
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => { /* never carried into the receipt or proof */ })
  child.once('close', (code, signal) => {
    handle.exited = true
    handle.exitResult = { code, signal }
    handle.closedAt = now()
    syncQualificationClientReceipt()
  })
  appendNote('qualification-client-active', {
    pid: child.pid ?? null,
    pgid: handle.pgid,
    starttime: handle.starttime,
    hostId: host.hostId,
    generation: host.generation,
    hostBuildId: host.buildId,
    clientBuildId: sideNew.buildId,
  })
  syncQualificationClientReceipt()
  writeReceipt({ phase: 'QUALIFICATION_CLIENT_ACTIVE' })
  if (process.env.SPLIT_VITEST_UPGRADE_KILL_POINT === 'qualification-client-active') {
    await waitForWorkerKillBarrier()
    throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: worker was killed at the qualification-client-active barrier')
  }

  const requestId = `qualification-host-foundation-${String(sequence)}`
  try {
    child.stdin.write(`${JSON.stringify({ op: 'qualification-host-foundation', requestId })}\n`)
    const proof = await waitForQualificationRecord(
      handle,
      record => record?.m4b2hf === 'host-rpc-proof' && record.requestId === requestId,
      'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION proof',
      QUALIFICATION_PROOF_TIMEOUT_MS,
    )
    if (proof.clientPid !== child.pid) {
      throw new Error(`UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the proof names Client PID ${String(proof.clientPid)}, not ${String(child.pid)}`)
    }
    if (proof.hostPid !== identityBefore.hostPid) {
      throw new Error(`UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the proof names Host PID ${String(proof.hostPid)}, not ${String(identityBefore.hostPid)}`)
    }
    if (proof.hostInstanceId !== identityBefore.instanceId) {
      throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the proof names another Host instance')
    }
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      if (proof[field] !== true) {
        throw new Error(`UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the proof field ${field} is not true`)
      }
    }
    child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
    const exit = await waitForChildClose(child, QUALIFICATION_SHUTDOWN_GRACE_MS)
    handle.exited = true
    handle.exitResult = exit
    handle.closedAt = now()
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the qualification Client exit was ${JSON.stringify(exit)}`)
    }
    await assertHostGroupGone(handle, 'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION')
    await assertClientSeatFree(scene.installation, String(identityBefore.scopeId), 'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION')
    const fallback = await reclaimClientFallbackHosts('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION proof')
    if (fallback.length > 0) {
      throw new Error(`UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the qualification Client started ${String(fallback.length)} unattributed Host(s); the proof is not trustworthy`)
    }
    const statusAfter = await queryHostStatus(host)
    assertIdentityKept(safeIdentity(statusAfter.localHost), identityBefore, 'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION')
    if (!pidAlive(host.child.pid) || !processGroupAlive(hostPgid(host))) {
      throw new Error('UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION: the old Host is no longer alive after the proof')
    }
    activeQualificationClient = undefined
    syncQualificationClientReceipt()
    appendNote('qualification-client-proof', {
      clientPid: proof.clientPid,
      hostPid: proof.hostPid,
      hostInstanceId: proof.hostInstanceId,
      exitCode: exit.code,
    })
    writeReceipt({ phase: 'QUALIFICATION_CLIENT_PROOF' })
    return {
      clientPid: proof.clientPid,
      hostPid: proof.hostPid,
      hostInstanceId: proof.hostInstanceId,
      officialSessionList: true,
      privateFileRpc: true,
      terminalSnapshot: true,
      cleaned: true,
      exitCode: 0,
    }
  } catch (error) {
    try {
      await terminateQualificationClient('qualification proof failed')
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION failed and its qualification Client cleanup also failed')
    }
    throw error
  }
}

// ── process Scene: typed Client requests over the ONE IPC wire ────────────

/** One canonical directory strictly inside the Scene root. */
function requireProcessSceneDirectory(raw, name) {
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT requires an absolute ${name} directory`)
  }
  let real
  try {
    real = realpathSync(raw)
  } catch (error) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT ${name} does not exist (${boundedError(error)})`)
  }
  if (real !== raw) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT ${name} must be a canonical path (${real})`)
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT ${name} is not a directory`)
  }
  const rel = relative(scene.workDir, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT ${name} must be inside the Scene root`)
  }
  return real
}

function requireProcessDimension(value, name, fallback, maximum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT ${name} must be a positive integer <= ${String(maximum)}`)
  }
  return value
}

/** The real tui-test shell identity: uid + kernel birth, no guessed `ps` text. */
function captureShellIdentity(pid, label) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: tui-test returned no real shell PID`)
  }
  const observation = readKernelProcess(pid)
  if (observation.kind !== 'alive') {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the tui-test shell PID ${String(pid)} has no readable kernel identity`)
  }
  const uid = observation.identity.platform === 'darwin' ? observation.identity.uid : readLinuxProcessUid(pid)
  if (typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the tui-test shell PID ${String(pid)} is not owned by this user`)
  }
  return { identity: observation.identity, uid, birth: serializeKernelIdentity(observation.identity) }
}

/** gone | reused | alive | unknown for one captured kernel identity. */
function processIdentityState(identity) {
  let observation
  try {
    observation = readKernelProcess(identity.pid)
  } catch {
    return 'unknown'
  }
  const liveness = classifyKernelLiveness(observation)
  if (liveness.state === 'unknown') return 'unknown'
  if (liveness.state === 'gone') return 'gone'
  return sameKernelProcess(identity, observation) === 'same' ? 'alive' : 'reused'
}

/** Bounded proof that one captured identity no longer names this run. */
async function waitForProcessIdentityTerminal(identity, reason, timeoutMs = 10_000) {
  const started = Date.now()
  for (;;) {
    const state = processIdentityState(identity)
    if (state === 'gone' || state === 'reused') return state
    if (state === 'unknown') {
      throw new Error(`${reason}: the kernel state of PID ${String(identity.pid)} is unverifiable`)
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${reason}: PID ${String(identity.pid)} is still the process this run captured`)
    }
    await sleep(50)
  }
}

/**
 * The common terminal-resource proof of one process Client: its exact native
 * session is gone and every captured shell/business identity is gone or a
 * provably different PID. A live identity, or an unverifiable one, fails.
 */
function assertProcessClientTerminalContract(handle, reason) {
  const terminal = handle.verifiedTerminal
  if (terminal === undefined) throw new Error(`${reason}: ${handle.label} has no verified terminal fact`)
  if (handle.terminalMode === 'terminal-owner-loss') {
    if (terminal.kind !== 'owner-loss'
      || terminal.ownerPid !== handle.owner?.pid
      || terminal.ownerExit?.code !== null
      || terminal.ownerExit?.signal !== 'SIGKILL') {
      throw new Error(`${reason}: ${handle.label} has no verified terminal-owner-loss fact`)
    }
    return
  }
  if (terminal.kind !== 'native') throw new Error(`${reason}: ${handle.label} has no native terminal fact`)
  const expected = handle.terminalMode === 'sigint'
    ? { code: 130, signal: null }
    : handle.terminalMode === 'hmr-failure'
      ? { code: 1, signal: null }
      : { code: 0, signal: null }
  if (terminal.code !== expected.code || terminal.signal !== expected.signal) {
    throw new Error(`${reason}: ${handle.label} terminal ${JSON.stringify(terminal)} is not the declared ${JSON.stringify(expected)}`)
  }
  if (handle.terminalMode === 'hmr-failure') {
    const records = readOfficialClientRecords(handle.recordFile, handle.label)
    const count = op => records.filter(record => record?.m4b2s === 'qualification' && record?.op === op).length
    if (count('hmr-revision-start') !== 1 || count('hmr-revision-retired') !== 1 || count('hmr-revision-failure') !== 1) {
      throw new Error(`${reason}: ${handle.label} HMR failure records are not exactly one start/retired/failure`)
    }
    if (records.some(record => record?.m4b2s === 'qualification' && record?.op === 'hmr-revision-ready')) {
      throw new Error(`${reason}: ${handle.label} HMR failure published a replacement Ready`)
    }
    const closed = records.find(record => record?.m4b2s === 'client-closed')
    if (closed === undefined) throw new Error(`${reason}: ${handle.label} HMR failure has no client-closed inventory`)
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      if (closed.owners?.[owner] !== 0) throw new Error(`${reason}: ${handle.label} HMR failure left ${owner} owner alive`)
    }
  }
}

async function assertProcessClientQuiesced(handle, reason) {
  if (handle.terminalMode === 'terminal-owner-loss') {
    if (handle.shellIdentity === undefined || handle.businessIdentities.length === 0) {
      throw new Error(`${reason}: ${handle.label} has no captured shell/business identity to prove Owner quiescence`)
    }
    if (handle.owner?.exit === undefined) throw new Error(`${reason}: ${handle.label} PTY Owner has not exited`)
    if (handle.ownerLossAttempted === true) {
      if (handle.owner.exit.code !== null || handle.owner.exit.signal !== 'SIGKILL') {
        throw new Error(`${reason}: ${handle.label} PTY Owner has no verified SIGKILL exit`)
      }
    } else if (!(handle.owner.exit.code === 0 && handle.owner.exit.signal === null)
      && !(handle.owner.exit.code === null && handle.owner.exit.signal === 'SIGKILL')) {
      throw new Error(`${reason}: ${handle.label} PTY Owner cleanup was neither a normal close nor an owned emergency kill`)
    }
    if (handle.shellIdentity !== undefined) {
      await waitForProcessIdentityTerminal(handle.shellIdentity.identity, `${reason}: ${handle.label} shell`)
    }
    for (const value of handle.businessIdentities) {
      await waitForProcessIdentityTerminal(value.identity, `${reason}: ${handle.label} business`)
    }
    return
  }
  const openSessions = new Set(await openTuiSessions())
  if (openSessions.has(handle.sessionId)) {
    throw new Error(`${reason}: ${handle.label} left its native TUI session open`)
  }
  if (handle.shellIdentity !== undefined) {
    await waitForProcessIdentityTerminal(handle.shellIdentity.identity, `${reason}: ${handle.label} shell`)
  }
  for (const value of handle.businessIdentities) {
    await waitForProcessIdentityTerminal(value.identity, `${reason}: ${handle.label} business`)
  }
}

/** Register the real fallback Host one Client's product discovery started. */
function registerProcessFallbackHost(handle, hostFacts, label, scratchBaseline) {
  const pid = hostFacts.hostPid
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host carries no real PID`)
  }
  if (hostFacts.scopeId !== processScope.scopeId) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host names another scope`)
  }
  if (hostFacts.buildId !== handle.expectedBuildId) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host runs another build`)
  }
  const snapshot = nativeProcessSnapshot(pid)
  if (snapshot === null) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host PID ${String(pid)} has no readable identity`)
  }
  if (!snapshot.command.includes('local-host.mjs') || !snapshot.command.includes(scene.workDir)) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host does not run this Scene's Host entry`)
  }
  if (processEnvironmentValue(pid, 'SPLIT_PROCESS_SCRATCH') !== handle.scratch) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host does not carry this Client's scratch`)
  }
  // `starttime` keeps the SAME OS representation the shared fallback reclaim
  // reads, so the registered row is updated in place instead of duplicated;
  // `birth` carries the precise kernel identity the external probe compares.
  const starttime = readHostStarttime(pid)
  if (starttime === undefined) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the discovered Host PID ${String(pid)} has no readable OS birth`)
  }
  const record = {
    pid,
    pgid: pid,
    starttime,
    birth: snapshot.birth,
    origin: 'product-discovery-fallback',
    scratch: handle.scratch,
    clientId: handle.clientId,
    label: handle.label,
    scopeId: hostFacts.scopeId,
    instanceId: hostFacts.instanceId,
    buildId: hostFacts.buildId,
    uid: snapshot.uid,
    detectedAt: now(),
    reclaimed: false,
    normalStopRequired: handle.kind === undefined,
    scratchBaseline: handle.kind === undefined
      ? (scratchBaseline ?? readdirSync(processScope.dir).filter(name => name.startsWith('host-scratch-')))
      : undefined,
    exitObserved: undefined,
  }
  assertProcessFallbackOwnership(pid, handle.scratch, record, 'PROCESS_FALLBACK registration')
  fallbackHosts.push(record)
  syncFallbackHostsReceipt()
  appendNote('process-fallback-host-registered', {
    pid,
    birth: snapshot.birth,
    clientId: handle.clientId,
    scopeId: hostFacts.scopeId,
    instanceId: hostFacts.instanceId,
  })
  return record
}

/** The one PTY Owner used ONLY by a declared terminal-owner-loss Client. */
function startProcessPtyOwner({ traceDirectory, artifactsDirectory }) {
  const child = spawn(process.execPath, [PROCESS_PTY_OWNER], {
    cwd: scene.workDir,
    env: { PATH: process.env.PATH ?? '', HOME: scene.workDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const pending = new Map()
  let requestId = 0
  let stderr = ''
  const ready = Promise.withResolvers()
  const owner = {
    child,
    pid: Number.isInteger(child.pid) ? child.pid : undefined,
    birth: undefined,
    uid: undefined,
    pending,
    ready,
    spawnError: undefined,
    validationError: undefined,
    stderr: () => stderr,
    exit: undefined,
  }
  child.once('spawn', () => ready.resolve())
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { if (stderr.length < 32_000) stderr += chunk })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (stderr.length < 32_000) stderr += chunk
  })
  // Register the real child BEFORE any identity check or await. A spawn error
  // can arrive on the next tick; it settles every wait and never fabricates a
  // native close.
  child.once('error', error => {
    owner.spawnError = error
    ready.reject(error)
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  child.once('close', (code, signal) => {
    owner.exit = { code, signal }
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`PTY Owner exited before ${waiter.requestId}: ${JSON.stringify(owner.exit)}`))
    }
    pending.clear()
  })
  child.on('message', message => {
    if (message?.type === 'owner-response' || message?.type === 'owner-error') {
      const waiter = pending.get(message.requestId)
      if (waiter === undefined) return
      pending.delete(message.requestId)
      if (message.type === 'owner-error' || message.ok !== true) {
        waiter.reject(new Error(`PTY Owner ${message.requestId} failed: ${String(message.message ?? 'unknown')}`))
      } else {
        waiter.resolve(message)
      }
      return
    }
    if (message?.type === 'owner-fatal') {
      for (const waiter of pending.values()) waiter.reject(new Error(`PTY Owner fatal: ${String(message.message)}`))
      pending.clear()
    }
  })
  owner.request = async (op, payload = {}, timeoutMs = 120_000) => {
    if (owner.spawnError !== undefined) throw owner.spawnError
    await ready.promise
    if (!child.connected) throw new Error(`PTY Owner ${op} cannot be requested: the IPC channel is closed`)
    const id = `pty-owner-${String(++requestId)}`
    let timer
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`PTY Owner ${op} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      pending.set(id, {
        requestId: id,
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
    })
    try {
      child.send({ requestId: id, op, ...payload })
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      throw error
    }
    return await result
  }
  if (owner.pid === undefined) {
    owner.validationError = new Error('START_PROCESS_CLIENT: the PTY Owner child has no real PID')
    return owner
  }
  try {
    const observation = readKernelProcess(owner.pid)
    if (observation.kind !== 'alive' || observation.identity.ppid !== process.pid) {
      throw new Error('START_PROCESS_CLIENT: the PTY Owner is not the live direct child')
    }
    const uid = readLinuxProcessUid(owner.pid)
    if (typeof process.getuid === 'function' && uid !== process.getuid()) {
      throw new Error('START_PROCESS_CLIENT: the PTY Owner is not owned by this user')
    }
    const snapshot = nativeProcessSnapshot(owner.pid)
    if (snapshot === null || !snapshot.command.includes(PROCESS_PTY_OWNER)) {
      throw new Error('START_PROCESS_CLIENT: the PTY Owner does not run this Scene helper entry')
    }
    owner.birth = serializeKernelIdentity(observation.identity)
    owner.uid = uid
  } catch (error) {
    owner.validationError = error
  }
  return owner
}

/** Prove the child Owner holds the real master for the Client's controlling tty. */
function assertProcessPtyOwnerMaster(handle, shellPid, reason) {
  if (process.platform !== 'linux') throw new Error(`${reason}: the PTY Owner proof is Linux-only`)
  const ownerPid = handle.owner.pid
  if (!Number.isInteger(ownerPid) || !Number.isInteger(shellPid)) throw new Error(`${reason}: missing real PTY Owner/shell PID`)
  const readLinks = pid => {
    try {
      return Object.fromEntries(readdirSync(`/proc/${String(pid)}/fd`).map(name => {
        try { return [name, readlinkSync(`/proc/${String(pid)}/fd/${name}`)] } catch { return [name, '<unreadable>'] }
      }))
    } catch (error) {
      throw new Error(`${reason}: cannot read fd table of PID ${String(pid)} (${boundedError(error)})`)
    }
  }
  const ownerLinks = readLinks(ownerPid)
  const unreadable = Object.entries(ownerLinks).filter(([, link]) => link === '<unreadable>')
  if (unreadable.length > 0) throw new Error(`${reason}: the Owner fd table has unreadable entries ${JSON.stringify(unreadable)}`)
  const ownerMasters = Object.entries(ownerLinks).filter(([, link]) => link === '/dev/ptmx')
  if (ownerMasters.length === 0) throw new Error(`${reason}: the Owner holds no /dev/ptmx master`)
  const shellLinks = readLinks(shellPid)
  const shellTty = shellLinks['0']
  if (typeof shellTty !== 'string' || !shellTty.startsWith('/dev/pts/')) {
    throw new Error(`${reason}: the Client shell has no controlling pts`)
  }
  const shellTtyMatch = /^\/dev\/pts\/(\d+)$/u.exec(shellTty)
  if (shellTtyMatch === null) throw new Error(`${reason}: the Client shell controlling tty is not a pts index`)
  const shellTtyIndex = Number(shellTtyMatch[1])
  const ttyIndex = fd => {
    try {
      const info = readFileSync(`/proc/${String(ownerPid)}/fdinfo/${String(fd)}`, 'utf8')
      const match = /^tty-index:\s*(\d+)$/mu.exec(info)
      return match === null ? undefined : Number(match[1])
    } catch (error) {
      throw new Error(`${reason}: cannot read Owner tty-index for fd ${String(fd)} (${boundedError(error)})`)
    }
  }
  const ownerMasterIndexes = ownerMasters.map(([fd]) => ttyIndex(fd))
  const matchingOwnerMasters = ownerMasterIndexes.filter(index => index === shellTtyIndex)
  if (matchingOwnerMasters.length === 0) {
    throw new Error(`${reason}: the Owner holds no /dev/ptmx master for ${shellTty}`)
  }
  if (ownerMasterIndexes.some(index => index !== shellTtyIndex)) {
    throw new Error(`${reason}: the Owner holds a /dev/ptmx master for another tty (${JSON.stringify(ownerMasterIndexes)} vs ${String(shellTtyIndex)})`)
  }
  const selfLinks = readLinks(process.pid)
  const selfMasters = Object.entries(selfLinks).filter(([, link]) => link === '/dev/ptmx')
  for (const [fd] of selfMasters) {
    try {
      const info = readFileSync(`/proc/${String(process.pid)}/fdinfo/${String(fd)}`, 'utf8')
      const match = /^tty-index:\s*(\d+)$/mu.exec(info)
      if (match !== null && Number(match[1]) === shellTtyIndex) {
        throw new Error(`${reason}: the Supervisor also holds the matching /dev/ptmx master for ${shellTty}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('also holds')) throw error
      throw new Error(`${reason}: cannot audit the Supervisor ptmx fd ${String(fd)} (${boundedError(error)})`)
    }
  }
  const shellObservation = readKernelProcess(shellPid)
  if (shellObservation.kind !== 'alive' || shellObservation.identity.ppid !== ownerPid) {
    throw new Error(`${reason}: the Client shell is not the Owner's direct child`)
  }
  return { ownerPid, ownerMasters: ownerMasters.length, matchingOwnerMasters: matchingOwnerMasters.length, shellPid, shellTty, shellTtyIndex, parentMasters: 0 }
}

async function closeProcessPtyOwner(handle, reason) {
  if (handle.owner === undefined) return
  if (handle.owner.spawnError !== undefined) throw new Error(`${reason}: the PTY Owner spawn failed: ${boundedError(handle.owner.spawnError)}`)
  if (handle.owner.exit !== undefined) {
    if (handle.owner.exit.code !== 0 && handle.owner.exit.signal !== null) {
      throw new Error(`${reason}: the PTY Owner exited abnormally: ${JSON.stringify(handle.owner.exit)}`)
    }
    return
  }
  const closed = await handle.owner.request('close', {}, 30_000).catch(error => {
    handle.owner.closeError = error
    return undefined
  })
  const started = Date.now()
  while (handle.owner.exit === undefined && Date.now() - started < 10_000) await sleep(50)
  if (handle.owner.exit === undefined) {
    throw new Error(`${reason}: the PTY Owner did not exit after close${closed === undefined ? ` (${String(handle.owner.closeError?.message ?? 'close failed')})` : ''}`)
  }
  if (handle.owner.exit.code !== 0 || handle.owner.exit.signal !== null) {
    throw new Error(`${reason}: the PTY Owner close was abnormal: ${JSON.stringify(handle.owner.exit)}`)
  }
}

async function waitProcessPtyOwnerTerminal(handle, reason, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (handle.owner.exit === undefined && Date.now() < deadline) await sleep(50)
  if (handle.owner.exit === undefined) throw new Error(`${reason}: the PTY Owner did not terminate within ${String(timeoutMs)}ms`)
  if (handle.owner.exit.code !== null || handle.owner.exit.signal !== 'SIGKILL') {
    throw new Error(`${reason}: the PTY Owner terminal was not the intentional SIGKILL: ${JSON.stringify(handle.owner.exit)}`)
  }
  const remaining = () => deadline - Date.now()
  if (handle.shellIdentity !== undefined) {
    if (remaining() <= 0) throw new Error(`${reason}: the shared Owner terminal deadline expired before the shell`)
    await waitForProcessIdentityTerminal(handle.shellIdentity.identity, `${reason}: Client shell`, remaining())
  }
  for (const value of handle.businessIdentities) {
    if (remaining() <= 0) throw new Error(`${reason}: the shared Owner terminal deadline expired before the business identity`)
    await waitForProcessIdentityTerminal(value.identity, `${reason}: Client business`, remaining())
  }
  return true
}

async function handleStartProcessClient(message) {
  requireProcessScene('START_PROCESS_CLIENT')
  assertLifecycleOpen('START_PROCESS_CLIENT')
  assertNoBootstrapCliPatch('START_PROCESS_CLIENT')
  const label = message.label
  if (typeof label !== 'string' || label === '') {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT requires a non-empty label')
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(label)) {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT label must be a path-safe lowercase component')
  }
  if (processClients.some(client => client.label === label)) {
    throw new Error(`START_PROCESS_CLIENT: the Client label ${label} is already registered in this Scene`)
  }
  const cwd = requireProcessSceneDirectory(message.cwd, 'cwd')
  const home = requireProcessSceneDirectory(message.home, 'home')
  const cols = requireProcessDimension(message.cols, 'cols', 140, 400)
  const rows = requireProcessDimension(message.rows, 'rows', 40, 200)
  if (message.sessionId !== undefined && (typeof message.sessionId !== 'string' || message.sessionId === '')) {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT sessionId must be non-empty when set')
  }
  const hmr = message.hmr
  const dropPromptAck = message.dropPromptAck === true
  const terminalMode = message.terminal ?? 'normal'
  const recoverFromHostId = message.recoverFromHostId
  const attachRecoveredHostId = message.attachRecoveredHostId
  if (hmr !== undefined && !PROCESS_CLIENT_HMR_MODES.has(hmr)) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT unknown hmr mode ${JSON.stringify(hmr)}`)
  }
  if (message.dropPromptAck !== undefined && message.dropPromptAck !== true) {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT dropPromptAck may only be true when set')
  }
  if (!PROCESS_CLIENT_TERMINAL_MODES.has(terminalMode)) {
    throw new Error(`INPUT_UNQUALIFIED: START_PROCESS_CLIENT unknown terminal mode ${JSON.stringify(terminalMode)}`)
  }
  if (hmr !== undefined && dropPromptAck) {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT cannot combine HMR and a dropped prompt ACK')
  }
  if (terminalMode === 'hmr-failure' && hmr !== 'mount-failure') {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT hmr-failure terminal requires the mount-failure mode')
  }
  if (terminalMode === 'sigint' && (hmr !== undefined || dropPromptAck)) {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT SIGINT terminal excludes HMR and ACK-drop modes')
  }
  if (terminalMode === 'terminal-owner-loss' && process.platform !== 'linux') {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT terminal-owner-loss is implemented on Linux only')
  }
  if (terminalMode === 'terminal-owner-loss' && (hmr !== undefined || dropPromptAck)) {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT terminal-owner-loss excludes HMR and ACK-drop modes')
  }
  if (hmr === 'hold' && terminalMode !== 'normal') {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT HMR hold requires the normal terminal contract')
  }
  if (hmr === 'replace' && terminalMode !== 'normal') {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT HMR replacement requires the normal terminal contract')
  }
  if (hmr === 'mount-failure' && terminalMode !== 'normal' && terminalMode !== 'hmr-failure') {
    throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT mount failure only permits normal or hmr-failure terminal')
  }
  const fallbackProbe = process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'fallback-host-ready'
  const recovery = recoverFromHostId !== undefined
  const attach = attachRecoveredHostId !== undefined
  if (recovery && attach) throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT cannot recover and attach at once')
  if (recovery || attach) {
    if (hmr !== undefined || dropPromptAck || terminalMode !== 'normal') {
      throw new Error('INPUT_UNQUALIFIED: a recovered-Host Client requires the ordinary terminal contract')
    }
    if (recovery && (typeof recoverFromHostId !== 'string' || recoverFromHostId === '')) {
      throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT recoverFromHostId must be a non-empty hostId')
    }
    if (attach && (typeof attachRecoveredHostId !== 'string' || attachRecoveredHostId === '')) {
      throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT attachRecoveredHostId must name the discovery Client')
    }
    if (recovery && message.sessionId !== undefined) {
      throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT recoverFromHostId starts a sessionless Client')
    }
    if (attach && (typeof message.sessionId !== 'string' || message.sessionId === '')) {
      throw new Error('INPUT_UNQUALIFIED: START_PROCESS_CLIENT attachRecoveredHostId requires the recovered Session id')
    }
    if (activeHost !== undefined) {
      throw new Error('START_PROCESS_CLIENT: a recovered-Host Client must start without an active Scene Host')
    }
    if (processClients.some(client => !client.closed || client.verifiedTerminal === undefined)) {
      throw new Error('START_PROCESS_CLIENT: every older Client must be verified terminal before recovery')
    }
    await auditProcessClientLedger('START_PROCESS_CLIENT recovery admission')
    if (recovery && fallbackHosts.some(record => record.reclaimed !== true)) {
      throw new Error('START_PROCESS_CLIENT: an earlier discovered Host is still attached')
    }
  }
  let recoveryHost
  let recoveredRecord
  if (recovery) {
    recoveryHost = hosts.find(handle => handle.hostId === recoverFromHostId && handle.crashSignal !== undefined)
    if (recoveryHost === undefined) {
      throw new Error('START_PROCESS_CLIENT: recoverFromHostId does not name a declared-crash Host')
    }
    if (recoveryHost.finished !== true || recoveryHost.terminal?.outcome !== 'business-crash') {
      throw new Error('START_PROCESS_CLIENT: the predecessor Host has no verified business-crash terminal')
    }
    await assertHostGroupGone(recoveryHost, 'START_PROCESS_CLIENT recovery predecessor')
    await assertSceneHostSeatFree('START_PROCESS_CLIENT recovery predecessor')
  }
  if (attach) {
    const discoveryClient = processClients.find(client => client.clientId === attachRecoveredHostId)
    if (discoveryClient === undefined || !discoveryClient.closed) {
      throw new Error('START_PROCESS_CLIENT: attachRecoveredHostId must name a closed discovery Client')
    }
    recoveredRecord = fallbackHosts.find(record => record.clientId === attachRecoveredHostId)
    if (recoveredRecord === undefined || recoveredRecord.reclaimed === true) {
      throw new Error('START_PROCESS_CLIENT: the discovery Client registered no live recovered Host')
    }
    assertProcessFallbackOwnership(recoveredRecord.pid, recoveredRecord.scratch, recoveredRecord,
      'START_PROCESS_CLIENT attach recovered Host')
  }
  let host = activeHost
  if (fallbackProbe) {
    if (host !== undefined || hosts.length > 0) {
      throw new Error('START_PROCESS_CLIENT: the fallback-host-ready probe must run without an explicit Host')
    }
  } else if (recovery || attach) {
    host = undefined
  } else {
    if (host === undefined) throw new Error('START_PROCESS_CLIENT: no ready Host exists in this Scene')
    if (host.exited || host.child.exitCode !== null || host.child.signalCode !== null
      || !pidAlive(host.child.pid) || !processGroupAlive(hostPgid(host))) {
      throw new Error('START_PROCESS_CLIENT: the Scene Host is not alive')
    }
    if (host.ready === undefined) throw new Error('START_PROCESS_CLIENT: the Scene Host is not ready')
    if (host.ready.localHost?.scopeId !== processScope?.scopeId) {
      throw new Error('START_PROCESS_CLIENT: the ready Host is not this Scene scope')
    }
  }
  const facts = assertProcessInstalledFacts('START_PROCESS_CLIENT')
  const fallbackScratchBaseline = [...processFallbackScratchBaseline]
  const sequence = ++processClientSequence
  const clientDir = join(scene.workDir, 'process-clients', `${label}-${String(sequence)}`)
  mkdirSync(clientDir, { recursive: true, mode: 0o700 })
  const scratch = join(clientDir, 'scratch')
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  const recordFile = join(clientDir, 'records.jsonl')
  writeFileSync(recordFile, '', { mode: 0o600, flag: 'wx' })
  const clientId = `split-process-client-${String(sequence)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const holdBarrier = hmr === 'hold' ? join(clientDir, 'hmr-hold.barrier') : undefined
  // The reservation is durable BEFORE any native handle exists, so a Worker
  // death in any startup window remains owned by this process. The native
  // terminal/owner is attached only after the row is visible in the receipt.
  const handle = {
    clientId,
    label,
    sessionId: null,
    terminal: undefined,
    owner: undefined,
    recordFile,
    scratch,
    clientDir,
    cwd,
    home,
    hostId: recoveryHost?.hostId ?? recoveredRecord?.clientId ?? host?.hostId ?? null,
    generation: recoveryHost?.generation ?? host?.generation ?? null,
    expectedEntry: facts.entries.client,
    expectedBuildId: facts.buildId,
    hmr,
    dropPromptAck,
    terminalMode,
    holdBarrier,
    recoverFromHostId,
    attachRecoveredHostId,
    recoveryHost,
    recoveredRecord,
    ownerLossTerminal: undefined,
    verifiedTerminal: undefined,
    signalIntents: [],
    shellPid: null,
    shellIdentity: undefined,
    businessPids: [],
    businessIdentities: [],
    readyHost: undefined,
    reservedAt: now(),
    openedAt: undefined,
    readyAt: undefined,
    exited: false,
    exitResult: undefined,
    closedAt: undefined,
    closed: false,
  }
  processClients.push(handle)
  handle.settlement = Promise.withResolvers()
  let splitTerminal
  try {
    if (terminalMode === 'terminal-owner-loss') {
      handle.owner = startProcessPtyOwner({
        traceDirectory: join(scene.workDir, 'trace'),
        artifactsDirectory: join(scene.workDir, 'artifacts'),
      })
      if (handle.owner.validationError !== undefined) throw handle.owner.validationError
      if (handle.owner.birth === undefined) throw new Error(`${label}: the PTY Owner produced no readable kernel identity`)
      const created = await withProcessNativeOperation('client-owner-create', clientId, () => handle.owner.request('create', {
        prefix: 'split-process-owner',
        traceDirectory: join(scene.workDir, 'trace'),
        artifactsDirectory: join(scene.workDir, 'artifacts'),
      }))
      handle.sessionId = String(created.sessionId)
    } else {
      splitTerminal = createSplitTerminal({
        prefix: 'split-process',
        traceDirectory: join(scene.workDir, 'trace'),
        artifactsDirectory: join(scene.workDir, 'artifacts'),
      })
      handle.terminal = splitTerminal.terminal
      handle.sessionId = splitTerminal.sessionId
    }
  } catch (error) {
    handle.exited = true
    handle.exitResult = { code: null, signal: null }
    handle.closeFailure = error
    syncProcessClientsReceipt()
    const cleanupError = await closeProcessPtyOwner(handle, 'START_PROCESS_CLIENT PTY Owner create failure')
      .then(() => undefined)
      .catch(failure => failure)
    handle.settlement.resolve()
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], `${label}: the PTY Owner create failed and its cleanup also failed`)
    }
    throw error
  }
  syncProcessClientsReceipt()
  try {
  appendNote('process-client-reserved', {
    clientId,
    label,
    sessionId: handle.sessionId,
    hostId: handle.hostId,
    generation: handle.generation,
    cwd,
    home,
    scratch,
    recordFile,
    expectedEntry: handle.expectedEntry,
    expectedBuildId: handle.expectedBuildId,
  })
  syncProcessClientsReceipt()
  writeReceipt({ phase: 'PROCESS_CLIENT_RESERVED' })
  await processProbeHold('client-reserved-before-spawn', {
    clientId,
    label,
    sessionId: handle.sessionId,
    hostId: handle.hostId,
    hostPid: host?.child.pid ?? null,
    hostBirth: host?.starttime ?? null,
    scopeId: processScope?.scopeId,
    workerPid: receipt.worker?.pid,
    workerPpid: receipt.worker?.ppid,
  })
  // No await may interleave between this gate and the ONE native spawn.
  assertLifecycleOpen('START_PROCESS_CLIENT before spawn')
  const env = {
    ...scene.installation.base.env,
    HOME: home,
    DSH_PI_TUI_ENTRY_RECORDS: '1',
    SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
    SPLIT_PROCESS_PROFILE: 'pi-tui',
    SPLIT_PROCESS_CLIENT_MODE: 'surface',
    SPLIT_PROCESS_SCRATCH: scratch,
    SPLIT_PROCESS_CLIENT_RECORD_FILE: recordFile,
    ...(message.sessionId === undefined ? {} : { SPLIT_PROCESS_CLIENT_SESSION: message.sessionId }),
    ...(hmr === 'replace' || hmr === 'mount-failure' || hmr === 'hold'
      ? { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' }
      : {}),
    ...(hmr === 'mount-failure' ? { SPLIT_PROCESS_CLIENT_HMR_FAIL: '1' } : {}),
    ...(hmr === 'hold' ? { SPLIT_PROCESS_CLIENT_HMR_HOLD: `surface@${String(holdBarrier)}` } : {}),
    ...(dropPromptAck ? { SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1' } : {}),
  }
  let opened
  try {
    if (handle.owner !== undefined) {
      const ownerRun = await withProcessNativeOperation('client-owner-run', clientId, () => handle.owner.request('run', {
        entry: facts.entries.client,
        cwd,
        cols,
        rows,
        env,
      }, 180_000))
      opened = { session: ownerRun.sessionId, shell_pid: ownerRun.shellPid }
    } else {
      opened = await withProcessNativeOperation('client-run', clientId, () => handle.terminal.run(
        process.execPath,
        [facts.entries.client],
        { cwd, cols, rows, waitReady: false, env },
      ))
    }
  } catch (error) {
    // The native run may have failed before returning. Its handle is still
    // owned here; close it and prove the terminal state before rethrowing.
    let cleanupError
    try {
      if (handle.owner !== undefined) {
        await closeProcessPtyOwner(handle, 'START_PROCESS_CLIENT owner run failure')
      } else {
        await withProcessNativeOperation('client-run-reclaim', clientId, () => handle.terminal.closeQuiet())
      }
      await assertProcessClientQuiesced(handle, 'START_PROCESS_CLIENT run failure')
    } catch (failure) {
      cleanupError = failure
    }
    handle.exited = true
    handle.exitResult = handle.exitResult ?? { code: null, signal: null }
    if (cleanupError === undefined) {
      handle.closed = true
      handle.closedAt = now()
    } else {
      handle.closeFailure = cleanupError
    }
    syncProcessClientsReceipt()
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], `${label}: the native run failed and its Client cleanup also failed`)
    }
    throw error
  }
  if (opened.session !== handle.sessionId) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the native session identity changed at run()`)
  }
  // The returned native identity is registered BEFORE the cancellation branch:
  // a lifecycle that closed while the native run was in flight still reclaims
  // exactly the shell the run returned.
  handle.openedAt = now()
  handle.shellPid = Number.isInteger(opened.shell_pid) ? opened.shell_pid : null
  handle.shellIdentity = captureShellIdentity(handle.shellPid, `${label} shell`)
  if (handle.owner !== undefined) {
    handle.ptyOwnerFacts = assertProcessPtyOwnerMaster(handle, handle.shellPid, `${label} PTY Owner`)
  }
  syncProcessClientsReceipt()
  writeReceipt({ phase: 'PROCESS_CLIENT_OPENED' })
  if (lifecycleClosed || disconnected) {
    await reclaimProcessClient(handle, 'START_PROCESS_CLIENT after a closed lifecycle')
    throw new Error('START_PROCESS_CLIENT: the Supervisor lifecycle closed while the native run was in flight')
  }
  // The real shell/session identity is already registered and durable here;
  // the Worker still has no ACK.
  await processProbeHold('client-opened-before-ack', {
    clientId,
    label,
    sessionId: handle.sessionId,
    shellPid: handle.shellPid,
    shellBirth: handle.shellIdentity.birth,
    hostId: handle.hostId,
    hostPid: host?.child.pid ?? null,
    workerPid: receipt.worker?.pid,
    workerPpid: receipt.worker?.ppid,
  })
  const started = await waitForProcessClientRecord(
    handle,
    record => record.m4a0 === 'client-started',
    `${label} official client-started record`,
    120_000,
  )
  if (lifecycleClosed || disconnected) {
    await reclaimProcessClient(handle, 'START_PROCESS_CLIENT after a closed lifecycle')
    throw new Error('START_PROCESS_CLIENT: the Supervisor lifecycle closed before the Client was authenticated')
  }
  const business = captureProcessClientIdentity(started.pid, `${label} client-started`, {
    expectedEntry: facts.entries.client,
    scratch,
  })
  handle.businessPids = [started.pid]
  handle.businessIdentities = [business]
  syncProcessClientsReceipt()
  if (terminalMode === 'terminal-owner-loss') {
    await processProbeHold('terminal-owner-client-opened-before-ack', {
      clientId,
      label,
      sessionId: handle.sessionId,
      ownerPid: handle.owner.pid,
      ownerBirth: handle.owner.birth,
      shellPid: handle.shellPid,
      shellBirth: handle.shellIdentity.birth,
      businessPid: started.pid,
      businessBirth: business.birth,
      hostId: handle.hostId,
      workerPid: receipt.worker?.pid,
      workerPpid: receipt.worker?.ppid,
    })
  }
  const authenticated = await waitForProcessClientRecord(
    handle,
    record => record.m4a0 === 'host-authenticated',
    `${label} official host-authenticated record`,
    120_000,
  )
  const authenticatedHost = assertProcessHostRecord(handle, authenticated, `${label} host-authenticated`)
  assertHostIdentityMatchesKernel(authenticatedHost, authenticatedHost.hostPid, `${label} host-authenticated`)
  if (fallbackProbe || recovery) {
    handle.fallbackHostRecord = registerProcessFallbackHost(handle, authenticatedHost, `${label} host-authenticated`, fallbackScratchBaseline)
  } else if (attach) {
    if (authenticatedHost.hostPid !== recoveredRecord.pid
      || authenticatedHost.instanceId !== recoveredRecord.instanceId) {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the Client authenticated a Host other than the recovered Host`)
    }
    handle.fallbackHostRecord = recoveredRecord
  } else if (authenticatedHost.hostPid !== host.child.pid) {
    // A normal anchor must never be silently rebound to a discovery fallback.
    registerProcessFallbackHost(handle, authenticatedHost, `${label} unexpected fallback`, fallbackScratchBaseline)
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the Client authenticated a Host other than this Scene's ready Host`)
  }
  if (lifecycleClosed || disconnected) {
    await reclaimProcessClient(handle, 'START_PROCESS_CLIENT after a closed lifecycle')
    throw new Error('START_PROCESS_CLIENT: the Supervisor lifecycle closed before the Client was ready')
  }
  const ready = await waitForProcessClientRecord(
    handle,
    record => record.m4a0 === 'ready',
    `${label} official ready record`,
    120_000,
  )
  if (ready.pid !== started.pid) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the ready record names another business PID`)
  }
  if (ready.transport !== 'connected' || ready.surfaceMounted !== true) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the ready record is not a connected mounted surface (${JSON.stringify({
      transport: ready.transport,
      surfaceMounted: ready.surfaceMounted,
    })})`)
  }
  if (message.sessionId === undefined) {
    if (ready.sessionOpen !== false) {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: a sessionless Client reported an open Session`)
    }
  } else if (ready.sessionOpen !== true || ready.openSessionId !== message.sessionId) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the Client did not open the requested Session`)
  }
  const readyHost = assertProcessHostRecord(handle, ready, `${label} ready`)
  assertHostIdentityMatchesKernel(readyHost, readyHost.hostPid, `${label} ready`)
  if (fallbackProbe || recovery) {
    if (readyHost.instanceId !== authenticatedHost.instanceId || readyHost.hostPid !== authenticatedHost.hostPid
      || readyHost.hostPid !== handle.fallbackHostRecord.pid) {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the ready Host is not the recovered discovery Host`)
    }
  } else if (attach) {
    if (readyHost.hostPid !== recoveredRecord.pid || readyHost.instanceId !== recoveredRecord.instanceId) {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the ready Host is not the recovered Host`)
    }
  } else if (readyHost.hostPid !== host.child.pid) {
    throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the ready Host is not this Scene's ready Host`)
  }
  handle.readyHost = {
    hostPid: readyHost.hostPid,
    instanceId: readyHost.instanceId,
    scopeId: readyHost.scopeId,
    buildId: readyHost.buildId,
    transport: ready.transport,
    surfaceMounted: ready.surfaceMounted,
    sessionOpen: ready.sessionOpen,
    openSessionId: ready.openSessionId,
    generationId: ready.generationId,
    shellPid: handle.shellPid,
    businessPid: started.pid,
  }
  handle.readyAt = now()
  syncProcessClientsReceipt()
  writeReceipt({ phase: 'PROCESS_CLIENT_READY' })
  await processProbeHold('fallback-host-ready', {
    clientId,
    label,
    sessionId: handle.sessionId,
    hostPid: readyHost.hostPid,
    hostInstanceId: readyHost.instanceId,
    scopeId: processScope.scopeId,
    fallbackHosts: fallbackHosts.map(value => ({ pid: value.pid, birth: value.starttime, reclaimed: value.reclaimed })),
    workerPid: receipt.worker?.pid,
    workerPpid: receipt.worker?.ppid,
  })
  return {
    clientId,
    label,
    sessionId: handle.sessionId,
    recordFile,
    cwd,
    home,
    cols,
    rows,
    shellPid: handle.shellPid,
    businessPids: handle.businessPids,
    hmr: handle.hmr ?? null,
    dropPromptAck: handle.dropPromptAck === true,
    terminal: handle.terminalMode,
    holdBarrier: handle.holdBarrier ?? null,
    ownerPid: handle.owner?.pid ?? null,
    ownerBirth: handle.owner?.birth ?? null,
    ptyOwnerFacts: handle.ptyOwnerFacts ?? null,
    ready: handle.readyHost,
  }
  } finally {
    handle.settlement.resolve()
  }
}

function requireProcessClientRequest(message, label) {
  requireProcessScene(label)
  assertLifecycleOpen(label)
  const handle = processClientById(message.clientId, label)
  if (handle.closed) throw new Error(`${label}: the Client ${handle.label} is already closed`)
  return handle
}

async function handleProcessClientInput(message) {
  const handle = requireProcessClientRequest(message, 'PROCESS_CLIENT_INPUT')
  const input = message.input
  if (input === null || typeof input !== 'object') {
    throw new Error('INPUT_UNQUALIFIED: PROCESS_CLIENT_INPUT requires an input object')
  }
  if (handle.owner !== undefined) {
    throw new Error('INPUT_UNQUALIFIED: PROCESS_CLIENT_INPUT is not available on a terminal-owner-loss Client')
  }
  let body
  if (input.type === 'type') {
    if (typeof input.text !== 'string') {
      throw new Error('INPUT_UNQUALIFIED: PROCESS_CLIENT_INPUT type requires text')
    }
    body = () => handle.terminal.type(input.text)
  } else if (input.type === 'press') {
    if (!Array.isArray(input.keys) || input.keys.length === 0
      || input.keys.some(key => typeof key !== 'string' || key === '')) {
      throw new Error('INPUT_UNQUALIFIED: PROCESS_CLIENT_INPUT press requires a non-empty key list')
    }
    body = () => handle.terminal.press(...input.keys)
  } else if (input.type === 'submit') {
    if (input.text !== undefined && typeof input.text !== 'string') {
      throw new Error('INPUT_UNQUALIFIED: PROCESS_CLIENT_INPUT submit text must be a string')
    }
    body = () => (input.text === undefined ? handle.terminal.submit() : handle.terminal.submit(input.text))
  } else {
    throw new Error('INPUT_UNQUALIFIED: PROCESS_CLIENT_INPUT type must be one of type/press/submit')
  }
  await withProcessNativeOperation(`client-${String(input.type)}`, handle.clientId, body)
  return { ok: true }
}

async function handleProcessClientText(message) {
  const handle = requireProcessClientRequest(message, 'PROCESS_CLIENT_TEXT')
  // The CURRENT visible screen is the only observable; scrollback is never a
  // substitute for what the surface paints now.
  if (handle.owner !== undefined) {
    const text = await withProcessNativeOperation('client-owner-text', handle.clientId, () => handle.owner.request('text', {}, 30_000))
    return { text: String(text.text) }
  }
  const text = await withProcessNativeOperation('client-text', handle.clientId, () => handle.terminal.text({ full: false }))
  return { text }
}

async function handleProcessClientState(message) {
  requireProcessScene('PROCESS_CLIENT_STATE')
  assertLifecycleOpen('PROCESS_CLIENT_STATE')
  const handle = processClientById(message.clientId, 'PROCESS_CLIENT_STATE')
  if (handle.closed) {
    // The terminal fact of a closed Client is its recorded exit; the native
    // handle is gone and must never be touched again.
    return {
      clientId: handle.clientId,
      label: handle.label,
      sessionId: handle.sessionId,
      shellPid: handle.shellPid,
      businessPids: handle.businessPids,
      exited: true,
      exitCode: handle.exitResult?.code ?? null,
      exitSignal: handle.exitResult?.signal ?? null,
      kind: handle.verifiedTerminal?.kind ?? handle.ownerLossTerminal?.kind ?? 'native',
      terminal: handle.verifiedTerminal ?? handle.ownerLossTerminal ?? null,
      sessionListed: handle.terminalMode === 'terminal-owner-loss' ? false : new Set(await openTuiSessions()).has(handle.sessionId),
      shellState: handle.shellIdentity === undefined ? 'unknown' : processIdentityState(handle.shellIdentity.identity),
      businessStates: handle.businessIdentities.map(value => ({
        pid: value.identity.pid,
        state: processIdentityState(value.identity),
      })),
    }
  }
  if (handle.owner !== undefined) {
    const ownerState = await withProcessNativeOperation('client-owner-state', handle.clientId, () => handle.owner.request('state', {}, 30_000))
    return {
      clientId: handle.clientId,
      label: handle.label,
      sessionId: handle.sessionId,
      shellPid: handle.shellPid,
      businessPids: handle.businessPids,
      exited: Boolean(ownerState.state?.exited),
      exitCode: null,
      exitSignal: ownerState.state?.exit_signal ?? null,
      kind: 'owner-loss',
      terminal: handle.ownerLossTerminal ?? null,
      sessionListed: false,
      shellState: handle.shellIdentity === undefined ? 'unknown' : processIdentityState(handle.shellIdentity.identity),
      businessStates: handle.businessIdentities.map(value => ({
        pid: value.identity.pid,
        state: processIdentityState(value.identity),
      })),
    }
  }
  const state = await withProcessNativeOperation('client-state', handle.clientId, () => handle.terminal.state())
  const openSessions = new Set(await openTuiSessions())
  if (state.exited !== null && !handle.exited) {
    handle.exited = true
    handle.exitResult = { code: state.exited, signal: state.exit_signal ?? null }
    handle.closedAt = handle.closedAt ?? now()
    syncProcessClientsReceipt()
  }
  return {
    clientId: handle.clientId,
    label: handle.label,
    sessionId: handle.sessionId,
    shellPid: handle.shellPid,
    businessPids: handle.businessPids,
    exited: state.exited !== null,
    exitCode: state.exited,
    exitSignal: state.exit_signal ?? null,
    sessionListed: openSessions.has(handle.sessionId),
    shellState: handle.shellIdentity === undefined ? 'unknown' : processIdentityState(handle.shellIdentity.identity),
    businessStates: handle.businessIdentities.map(value => ({
      pid: value.identity.pid,
      state: processIdentityState(value.identity),
    })),
    cols: state.cols,
    rows: state.rows,
  }
}

async function handleSignalProcessClient(message) {
  requireProcessScene('SIGNAL_PROCESS_CLIENT')
  assertLifecycleOpen('SIGNAL_PROCESS_CLIENT')
  const handle = processClientById(message.clientId, 'SIGNAL_PROCESS_CLIENT')
  if (handle.closed) throw new Error('SIGNAL_PROCESS_CLIENT: the Client is already closed')
  const signal = message.signal
  if (!PROCESS_CLIENT_SIGNALS.has(signal)) {
    throw new Error(`INPUT_UNQUALIFIED: SIGNAL_PROCESS_CLIENT unsupported signal ${JSON.stringify(signal)}`)
  }
  if (handle.terminalMode === 'terminal-owner-loss') {
    throw new Error('SIGNAL_PROCESS_CLIENT: a terminal-owner-loss Client never receives a test signal')
  }
  if (handle.readyAt === undefined || handle.businessIdentities.length === 0) {
    throw new Error('SIGNAL_PROCESS_CLIENT: the Client is not ready')
  }
  if (signal === 'SIGUSR2') {
    if (handle.hmr === undefined) throw new Error('SIGNAL_PROCESS_CLIENT: SIGUSR2 requires a declared HMR mode')
    if (handle.hmrSignalled === true) throw new Error('SIGNAL_PROCESS_CLIENT: the one HMR replacement was already requested')
  } else if (signal === 'SIGINT') {
    if (handle.terminalMode !== 'sigint') throw new Error('SIGNAL_PROCESS_CLIENT: SIGINT requires the declared sigint terminal')
    if (handle.signalIntents.includes('SIGINT')) throw new Error('SIGNAL_PROCESS_CLIENT: SIGINT was already sent')
  } else if (signal === 'SIGTERM') {
    if (handle.terminalMode !== 'normal') throw new Error('SIGNAL_PROCESS_CLIENT: SIGTERM requires the ordinary terminal contract')
    if (handle.signalIntents.includes('SIGTERM')) throw new Error('SIGNAL_PROCESS_CLIENT: SIGTERM was already sent')
  }
  const business = handle.businessIdentities[0]
  if (business === undefined || processIdentityState(business.identity) !== 'alive') {
    throw new Error('SIGNAL_PROCESS_CLIENT: the captured business Client identity is not alive')
  }
  if (signal === 'SIGUSR2') handle.hmrSignalled = true
  handle.signalIntents.push(signal)
  appendNote('process-client-signalled', {
    clientId: handle.clientId,
    pid: business.identity.pid,
    birth: business.birth,
    signal,
    terminal: handle.terminalMode,
  })
  writeReceipt({})
  try {
    process.kill(business.identity.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw new Error(`SIGNAL_PROCESS_CLIENT: the captured business PID ${String(business.identity.pid)} could not be signalled (${String(error?.code ?? 'unknown')})`)
    }
  }
  if (signal === 'SIGINT' || signal === 'SIGTERM') {
    const record = await waitForProcessClientRecord(handle,
      value => value?.m4a0 === 'signal' && value.signal === signal && value.pid === business.identity.pid,
      `${handle.label} ${signal} admission`, 30_000)
    if (record.pid !== business.identity.pid) {
      throw new Error(`SIGNAL_PROCESS_CLIENT: the ${signal} record came from another PID`)
    }
  }
  syncProcessClientsReceipt()
  return { clientId: handle.clientId, signal, pid: business.identity.pid, birth: business.birth }
}

/**
 * The ONE declared terminal-owner loss. This is the only positive path that
 * kills the PTY Owner; it never touches the business Client, its group or the
 * Host. The Owner's real close and the Client's actual kernel terminal are both
 * required before the tagged terminal fact exists.
 */
async function handleProcessClientTerminalLoss(message) {
  requireProcessScene('PROCESS_CLIENT_TERMINAL_LOSS')
  assertLifecycleOpen('PROCESS_CLIENT_TERMINAL_LOSS')
  const handle = processClientById(message.clientId, 'PROCESS_CLIENT_TERMINAL_LOSS')
  if (handle.terminalMode !== 'terminal-owner-loss') {
    throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the Client did not declare the terminal-owner-loss contract')
  }
  if (handle.closed) throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the Client is already closed')
  if (handle.readyAt === undefined) throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the Client is not ready')
  if (handle.owner === undefined || handle.owner.exit !== undefined) {
    throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the PTY Owner is not live')
  }
  if (processNativeOperation !== undefined) {
    throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: a native operation is still in flight')
  }
  if (handle.ownerLossAttempted === true) throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the Owner loss was already attempted')
  if (activeHost === undefined) throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the business Host is not active')
  const ownerObservation = readKernelProcess(handle.owner.pid)
  if (ownerObservation.kind !== 'alive'
    || serializeKernelIdentity(ownerObservation.identity) !== handle.owner.birth
    || ownerObservation.identity.ppid !== process.pid) {
    throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the PTY Owner lost its captured kernel/parent identity')
  }
  if (handle.shellIdentity === undefined || processIdentityState(handle.shellIdentity.identity) !== 'alive') {
    throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the Client shell is not fresh-live before the fault')
  }
  for (const value of handle.businessIdentities) {
    if (processIdentityState(value.identity) !== 'alive') {
      throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: a captured business identity is not fresh-live before the fault')
    }
  }
  assertProcessPtyOwnerMaster(handle, handle.shellPid, 'PROCESS_CLIENT_TERMINAL_LOSS')
  handle.ownerLossAttempted = true
  appendNote('process-client-terminal-owner-loss', {
    clientId: handle.clientId,
    ownerPid: handle.owner.pid,
    ownerBirth: handle.owner.birth,
    shellPid: handle.shellPid,
    shellBirth: handle.shellIdentity?.birth,
    businessPids: handle.businessPids,
    hostPid: activeHost.child.pid,
  })
  writeReceipt({})
  // The only fault signal: the exact Supervisor-owned PTY Owner. The Client
  // receives the kernel's terminal HUP; no test facility signal is sent to it.
  process.kill(handle.owner.pid, 'SIGKILL')
  await waitProcessPtyOwnerTerminal(handle, 'PROCESS_CLIENT_TERMINAL_LOSS', 20_000)
  const hostStatus = await queryHostStatus(activeHost)
  if (hostStatus.localHost?.hostPid !== activeHost.child.pid
    || hostStatus.localHost?.instanceId !== activeHost.ready?.localHost?.instanceId) {
    throw new Error('PROCESS_CLIENT_TERMINAL_LOSS: the business Host identity changed')
  }
  handle.ownerLossTerminal = {
    kind: 'owner-loss',
    ownerPid: handle.owner.pid,
    ownerBirth: handle.owner.birth,
    ownerExit: handle.owner.exit,
    shellPid: handle.shellPid,
    businessPids: [...handle.businessPids],
    hostPid: activeHost.child.pid,
    hostInstanceId: hostStatus.localHost.instanceId,
    terminalAt: now(),
  }
  handle.verifiedTerminal = handle.ownerLossTerminal
  handle.exited = true
  handle.exitResult = { code: null, signal: null }
  handle.closed = true
  handle.closedAt = now()
  handle.closeFailure = undefined
  syncProcessClientsReceipt()
  writeReceipt({ phase: 'PROCESS_CLIENT_CLOSED' })
  return {
    clientId: handle.clientId,
    kind: 'owner-loss',
    terminal: handle.ownerLossTerminal,
    exitCode: null,
    exitSignal: null,
    ownerPid: handle.owner.pid,
    ownerExit: handle.owner.exit,
    hostPid: activeHost.child.pid,
    hostInstanceId: hostStatus.localHost.instanceId,
  }
}

async function handleCloseProcessClient(message) {
  requireProcessScene('CLOSE_PROCESS_CLIENT')
  assertLifecycleOpen('CLOSE_PROCESS_CLIENT')
  const handle = processClientById(message.clientId, 'CLOSE_PROCESS_CLIENT')
  if (handle.closeFailure !== undefined) throw handle.closeFailure
  if (handle.closed) {
    return {
      clientId: handle.clientId,
      kind: handle.verifiedTerminal?.kind ?? 'native',
      exitCode: handle.exitResult?.code ?? null,
      exitSignal: handle.exitResult?.signal ?? null,
      ownerPid: handle.owner?.pid ?? null,
      ownerExit: handle.owner?.exit ?? null,
      terminal: handle.verifiedTerminal ?? null,
      closedAt: handle.closedAt,
    }
  }
  handle.closeSettlement = Promise.withResolvers()
  try {
    if (handle.terminalMode === 'terminal-owner-loss') {
      if (handle.ownerLossTerminal === undefined || handle.ownerLossAttempted !== true) {
        const failure = new Error(`CLOSE_PROCESS_CLIENT: ${handle.label} has no verified terminal-owner-loss fact`)
        handle.closeFailure = failure
        syncProcessClientsReceipt()
        throw failure
      }
      handle.verifiedTerminal = handle.ownerLossTerminal
      assertProcessClientTerminalContract(handle, 'CLOSE_PROCESS_CLIENT')
      await assertProcessClientQuiesced(handle, 'CLOSE_PROCESS_CLIENT')
      handle.closed = true
      handle.closedAt = now()
      handle.closeFailure = undefined
      syncProcessClientsReceipt()
      writeReceipt({ phase: 'PROCESS_CLIENT_CLOSED' })
      return {
        clientId: handle.clientId,
        kind: 'owner-loss',
        exitCode: null,
        exitSignal: null,
        ownerPid: handle.owner.pid,
        ownerExit: handle.owner.exit,
        terminal: handle.verifiedTerminal,
        closedAt: handle.closedAt,
      }
    }
    let failure
    let exit
    try {
      exit = await withProcessNativeOperation('client-close', handle.clientId, () => waitForTerminalExit(handle.terminal, handle.label, 120_000))
      const expected = handle.terminalMode === 'sigint' ? 130 : handle.terminalMode === 'hmr-failure' ? 1 : 0
      if (exit.code !== expected || exit.signal !== null) {
        throw new Error(`CLOSE_PROCESS_CLIENT: ${handle.label} exited ${JSON.stringify(exit)}; the declared ${handle.terminalMode} path requires code ${String(expected)} and no signal`)
      }
      if (handle.terminalMode === 'sigint') {
        const records = readOfficialClientRecords(handle.recordFile, handle.label)
        const businessPid = handle.businessPids[0]
        const admitted = records.find(record => record?.m4a0 === 'signal' && record.signal === 'SIGINT' && record.pid === businessPid)
        if (admitted === undefined) throw new Error(`CLOSE_PROCESS_CLIENT: ${handle.label} has no SIGINT admission record from its business PID`)
      }
      handle.verifiedTerminal = { kind: 'native', code: exit.code, signal: exit.signal }
      assertProcessClientTerminalContract(handle, 'CLOSE_PROCESS_CLIENT')
    } catch (error) {
      failure = error
    }
    try {
      await withProcessNativeOperation('client-close-native', handle.clientId, () => handle.terminal.closeQuiet())
    } catch (error) {
      // The native child already reached its declared exit. tui-test may have
      // removed that session itself; only a still-open session is a cleanup
      // failure. A missing session is the terminal fact, not a second defect.
      const stillOpen = new Set(await openTuiSessions()).has(handle.sessionId)
      if (stillOpen) failure = failure === undefined ? error : new AggregateError([failure, error], `${handle.label}: close and native teardown both failed`)
    }
    try {
      await assertProcessClientQuiesced(handle, 'CLOSE_PROCESS_CLIENT')
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], `${handle.label}: close did not reach a quiescent terminal state`)
    }
    handle.exited = true
    handle.exitResult = exit ?? handle.exitResult
    if (failure !== undefined) {
      handle.closeFailure = failure
      syncProcessClientsReceipt()
      writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(failure) })
      throw failure
    }
    handle.closed = true
    handle.closedAt = now()
    handle.closeFailure = undefined
    syncProcessClientsReceipt()
    writeReceipt({ phase: 'PROCESS_CLIENT_CLOSED' })
    return {
      clientId: handle.clientId,
      kind: 'native',
      exitCode: handle.exitResult?.code ?? null,
      exitSignal: handle.exitResult?.signal ?? null,
      terminal: handle.verifiedTerminal ?? null,
      closedAt: handle.closedAt,
    }
  } finally {
    handle.closeSettlement.resolve()
  }
}

/**
 * Wait for one START_PROCESS_CLIENT handler to reach its own settlement.
 * A closing lifecycle aborts its record waits, so this is bounded.
 */
async function settleProcessClientHandler(handle, reason, timeoutMs = 120_000) {
  const settlement = handle.settlement
  if (settlement === undefined) return
  const settled = await Promise.race([
    settlement.promise.then(() => true),
    sleep(timeoutMs).then(() => false),
  ])
  if (!settled) {
    throw new Error(`${reason}: the ${handle.label} handler did not settle within ${timeoutMs}ms`)
  }
}

/** Wait for one in-flight normal-close handler to reach its own settlement. */
async function settleProcessClientClose(handle, reason, timeoutMs = 120_000) {
  const settlement = handle.closeSettlement
  if (settlement === undefined) return
  const settled = await Promise.race([
    settlement.promise.then(() => true),
    sleep(timeoutMs).then(() => false),
  ])
  if (!settled) {
    throw new Error(`${reason}: the ${handle.label} close handler did not settle within ${timeoutMs}ms`)
  }
}

/** Reclaim one process Client after a Worker death or a failed close. */
async function reclaimProcessClient(handle, reason) {
  if (handle.closed) return
  if (handle.reclaimPromise !== undefined) return await handle.reclaimPromise
  handle.reclaimPromise = (async () => {
    // A handler that already entered a native call owns the settlement; close
    // only after that operation really returned. Never race a second native call.
    const started = Date.now()
    while (processNativeOperation !== undefined && Date.now() - started < 120_000) await sleep(50)
    let failure
    if (processNativeOperation !== undefined) {
      failure = new Error(`${reason}: a native operation is still unsettled after 120000ms`)
    } else if (handle.terminalMode === 'terminal-owner-loss') {
      try {
        if (handle.owner?.exit === undefined) {
          await closeProcessPtyOwner(handle, `${reason}: PTY Owner cleanup`)
        }
      } catch (error) {
        failure = error
      }
      if (handle.owner?.exit === undefined) {
        try {
          const observation = readKernelProcess(handle.owner.pid)
          if (observation.kind !== 'alive'
            || serializeKernelIdentity(observation.identity) !== handle.owner.birth
            || observation.identity.ppid !== process.pid) {
            throw new Error(`${reason}: the PTY Owner is no longer the captured live child`)
          }
          process.kill(handle.owner.pid, 'SIGKILL')
          const ownerDeadline = Date.now() + 10_000
          while (handle.owner.exit === undefined && Date.now() < ownerDeadline) await sleep(50)
          if (handle.owner.exit === undefined) throw new Error(`${reason}: the PTY Owner did not exit after the owned kill`)
        } catch (error) {
          failure = failure === undefined ? error : new AggregateError([failure, error], `${reason}: ${handle.label} owner cleanup failed`)
        }
      }
    } else {
      try {
        await withProcessNativeOperation('client-reclaim', handle.clientId, () => handle.terminal.closeQuiet())
      } catch (error) {
        const stillOpen = new Set(await openTuiSessions()).has(handle.sessionId)
        if (stillOpen) failure = error
      }
    }
    if (handle.terminalMode === 'terminal-owner-loss') {
      if (handle.owner?.exit === undefined) {
        failure = failure ?? new Error(`${reason}: the PTY Owner has no terminal fact`)
      } else if (handle.ownerLossAttempted === true) {
        try {
          await waitProcessPtyOwnerTerminal(handle, `${reason}: PTY Owner terminal`, 20_000)
        } catch (error) {
          failure = failure === undefined ? error : new AggregateError([failure, error], `${reason}: ${handle.label} owner terminal failed`)
        }
      }
    }
    try {
      await assertProcessClientQuiesced(handle, reason)
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], `${reason}: ${handle.label} reclaim failed`)
    }
    handle.exited = true
    handle.exitResult = handle.exitResult ?? { code: null, signal: null }
    if (failure !== undefined) {
      handle.closeFailure = failure
      syncProcessClientsReceipt()
      throw failure
    }
    handle.closed = true
    handle.closedAt = now()
    handle.closeFailure = undefined
    syncProcessClientsReceipt()
  })()
  return await handle.reclaimPromise
}

/**
 * The terminal audit shared by normal finalization and abnormal reclaim: every
 * process Client's exact native session is gone, every captured identity is
 * gone or reused, the official ledger parses completely, and no live
 * unregistered business PID remains. It never decides business PASS.
 */
async function auditProcessClientLedger(reason) {
  if (scene?.kind !== 'process') return
  const problems = []
  const openSessions = new Set(await openTuiSessions())
  for (const handle of processClients) {
    if (!handle.closed) problems.push(`${handle.label}: the Client is not closed`)
    if (handle.terminalMode !== 'terminal-owner-loss' && openSessions.has(handle.sessionId)) {
      problems.push(`${handle.label}: its native TUI session is still open`)
    }
    if (handle.terminalMode === 'terminal-owner-loss') {
      if (handle.owner?.exit === undefined) problems.push(`${handle.label}: its PTY Owner has no terminal fact`)
      else if (handle.ownerLossAttempted === true
        && (handle.owner.exit.code !== null || handle.owner.exit.signal !== 'SIGKILL')) {
        problems.push(`${handle.label}: its PTY Owner did not terminate by the intentional SIGKILL`)
      } else if (handle.ownerLossAttempted !== true
        && !(handle.owner.exit.code === 0 && handle.owner.exit.signal === null)
        && !(handle.owner.exit.code === null && handle.owner.exit.signal === 'SIGKILL')) {
        problems.push(`${handle.label}: its PTY Owner cleanup was not a normal close`)
      }
    }
    try {
      const records = readOfficialClientRecords(handle.recordFile, handle.label)
      const started = records.find(record => record?.m4a0 === 'client-started')
      // A Client killed before its record sink wrote anything never published a
      // business identity; only a Client that DID reach ready must have one.
      if (started === undefined && handle.readyAt !== undefined) {
        problems.push(`${handle.label}: the official ledger carries no client-started record`)
      }
      const registered = new Set(handle.businessIdentities.map(value => value.identity.pid))
      for (const record of records) {
        if (record?.m4a0 !== 'client-started' && record?.m4a0 !== 'ready') continue
        if (!Number.isInteger(record.pid) || record.pid <= 0) {
          problems.push(`${handle.label}: an official record carries no real business PID`)
          continue
        }
        if (!registered.has(record.pid) && pidAlive(record.pid)) {
          problems.push(`${handle.label}: live unreported business PID ${String(record.pid)} cannot be proven dead or foreign`)
        }
      }
    } catch (error) {
      problems.push(`${handle.label}: ${boundedError(error)}`)
    }
    if (handle.shellIdentity !== undefined) {
      const state = processIdentityState(handle.shellIdentity.identity)
      if (state === 'alive' || state === 'unknown') problems.push(`${handle.label}: its shell PID ${String(handle.shellIdentity.identity.pid)} is ${state}`)
    }
    for (const value of handle.businessIdentities) {
      const state = processIdentityState(value.identity)
      if (state === 'alive' || state === 'unknown') problems.push(`${handle.label}: its business PID ${String(value.identity.pid)} is ${state}`)
    }
  }
  if (problems.length > 0) throw new Error(`${reason}: process Client ledger audit failed: ${problems.join('; ')}`)
}

// ── process Scene: public daemon entry (real installed CLI, native PTY) ───
//
// The public daemon launch is the REAL installed `dsh --profile …` CLI under a
// native PTY. The CLI spawns the foreground Client itself and that Client
// starts/discovers the public Host; this Supervisor only owns the PTY handle,
// observes the real OS identities and reclaims the resources it can prove.
// Public evidence therefore never reads the internal Client JSONL (the public
// Client legitimately has no record sink) and never substitutes a registry
// fact for a live kernel identity.

const PUBLIC_DAEMON_BACKENDS = new Set(['daemon', 'direct', '', 'wire-local'])
const PUBLIC_DAEMON_COMPOSER = /❯/u
const PUBLIC_DAEMON_READY_TIMEOUT_MS = 240_000

function publicLaunchById(launchId, label) {
  if (typeof launchId !== 'string' || launchId === '') {
    throw new Error(`INPUT_UNQUALIFIED: ${label} requires a non-empty launchId`)
  }
  const handle = publicLaunches.find(value => value.launchId === launchId)
  if (handle === undefined) throw new Error(`${label}: unknown public launchId ${String(launchId)}`)
  return handle
}

function publicDaemonHostFacts(host) {
  return {
    pid: host.pid,
    birth: host.birth,
    instanceId: host.instanceId,
    scopeId: host.scopeId,
    buildId: host.buildId,
    origin: host.origin,
    protocol: host.protocol,
    bundleVersion: host.bundleVersion,
    dshVersion: host.dshVersion,
    schema: host.schema,
    pgid: host.pgid,
    sid: host.sid,
    ppidAtCapture: host.ppidAtCapture,
    registeredAt: host.registeredAt,
    reclaimed: host.reclaimed === true,
    normalStop: host.normalStop === true,
    stoppedAt: host.stoppedAt,
  }
}

function publicLaunchFacts(handle) {
  return {
    launchId: handle.launchId,
    label: handle.label,
    profile: handle.profile,
    alias: handle.alias ?? null,
    sessionId: handle.sessionId,
    shellPid: handle.shellPid,
    shellBirth: handle.shellIdentity?.birth ?? null,
    cli: handle.cli ?? null,
    client: handle.client ?? null,
    host: handle.host == null ? null : publicDaemonHostFacts(handle.host),
    backend: handle.backend ?? null,
    startedAt: handle.startedAt,
    openedAt: handle.openedAt,
    readyAt: handle.readyAt,
    surface: handle.surfaceProbe ?? null,
    exited: handle.exited === true,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    closed: handle.closed === true,
    closedAt: handle.closedAt,
    refused: handle.refused === true,
    exitTextBytes: typeof handle.exitText === 'string' ? handle.exitText.length : null,
    verifiedTerminal: handle.verifiedTerminal ?? null,
    hostStopped: handle.hostStopped ?? null,
    herdr: handle.herdr ?? null,
  }
}

function syncPublicLaunchReceipt() {
  writeReceipt({
    publicLaunches: publicLaunches.map(publicLaunchFacts),
    publicHosts: publicHosts.map(publicDaemonHostFacts),
  })
}

function linuxChildPids(pid) {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8').trim()
    if (raw === '') return []
    return raw.split(/\s+/u).filter(value => /^\d+$/u.test(value)).map(Number)
  } catch {
    return []
  }
}

function linuxDescendantPids(rootPid) {
  const seen = new Set()
  const pending = [rootPid]
  const descendants = []
  while (pending.length > 0) {
    const pid = pending.shift()
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue
    seen.add(pid)
    if (pid !== rootPid) descendants.push(pid)
    for (const child of linuxChildPids(pid)) pending.push(child)
  }
  return descendants
}

/**
 * Capture one real public-entry process (CLI, Client or Host) by its installed
 * entry marker AND this Scene's live DSH home environment. A readable snapshot
 * that does not match is a different process, never a candidate.
 */
function capturePublicProcess(pid, marker, label) {
  const snapshot = nativeProcessSnapshot(pid)
  if (snapshot === null) return undefined
  const tokens = processCommandLineTokens(pid)
  if (tokens === undefined) return undefined
  // The installed entry is the NODE SCRIPT argument: `node <entry> …`. A shell
  // wrapper's `-c` command token is not the entry token and never matches.
  if (tokens[1] !== marker && !(marker.startsWith('local-') && tokens[1]?.endsWith(`/${marker}`) === true)) {
    return undefined
  }
  if (processEnvironmentValue(pid, 'DSH_HOME') !== scene.installation.dshHome) return undefined
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && snapshot.uid !== uid) return undefined
  return { pid, birth: snapshot.birth, entry: marker }
}

function processCommandLineTokens(pid) {
  if (process.platform !== 'linux') return undefined
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').filter(value => value !== '')
  } catch {
    return undefined
  }
}

/**
 * Wait for one public entry role OR a real early exit. A refused CLI is a
 * business fact, not a discovery timeout: the caller reads the actual exit and
 * frame instead of inventing a missing process.
 */
async function waitForPublicProcessOrExit(handle, rootPid, marker, label, timeoutMs, options = {}) {
  const started = Date.now()
  for (;;) {
    const candidates = options.includeRoot === true ? [rootPid, ...linuxDescendantPids(rootPid)] : linuxDescendantPids(rootPid)
    for (const pid of candidates) {
      if (options.excludePids?.includes(pid) === true) continue
      const captured = capturePublicProcess(pid, marker, label)
      if (captured !== undefined) return { kind: 'process', process: captured }
    }
    const state = await handle.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      const text = await handle.terminal.text({ full: true }).catch(() => '')
      return { kind: 'exit', exit: { code: state.exited, signal: state.exit_signal ?? null }, text }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no real ${marker} process and no real exit under PID ${String(rootPid)} within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

function finishPublicRefusal(handle, outcome) {
  handle.refused = true
  handle.exited = true
  handle.exitResult = outcome.exit
  handle.exitText = outcome.text
  handle.verifiedTerminal = { kind: 'native', code: outcome.exit.code, signal: outcome.exit.signal }
  syncPublicLaunchReceipt()
  writeReceipt({ phase: 'PUBLIC_DAEMON_REFUSED' })
  return { ...publicLaunchReturnFacts(handle), exit: outcome.exit, text: outcome.text }
}

async function waitForPublicProcess(rootPid, marker, label, timeoutMs, options = {}) {
  const started = Date.now()
  for (;;) {
    const candidates = options.includeRoot === true ? [rootPid, ...linuxDescendantPids(rootPid)] : linuxDescendantPids(rootPid)
    for (const pid of candidates) {
      if (options.excludePids?.includes(pid) === true) continue
      const captured = capturePublicProcess(pid, marker, label)
      if (captured !== undefined) return captured
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no real ${marker} process under PID ${String(rootPid)} within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

/**
 * A later public Client may attach to the SAME live public Host instead of
 * starting one. Readiness is the real painted surface together with the
 * provably still-live existing Host; a new Host child wins if the product
 * actually started one.
 */
/**
 * A launch with NO backend environment fact follows the persisted Profile. The
 * CLI supervisor paints nothing, so a painted composer with no local-client.mjs
 * child is Direct; an actual Client child is Daemon. Both are observed real
 * facts, never inferred from the absence of an env value.
 */
async function waitForPublicProfileBackendKind(handle, label, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    for (const pid of linuxDescendantPids(handle.cli.pid)) {
      const captured = capturePublicProcess(pid, 'local-client.mjs', `${label} profile Client`)
      if (captured !== undefined) return { kind: 'daemon', client: captured }
    }
    const state = await handle.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      return {
        kind: 'exit',
        exit: { code: state.exited, signal: state.exit_signal ?? null },
        text: await handle.terminal.text({ full: true }).catch(() => ''),
      }
    }
    const frame = await handle.terminal.text({ full: false }).catch(() => '')
    if (publicComposerVisible(frame)) {
      // The CLI itself paints nothing in daemon mode; the Client child must be
      // observed before a composer can exist there. One settling read avoids
      // classifying a just-spawned Client as Direct.
      await sleep(50)
      let lateClient
      for (const pid of linuxDescendantPids(handle.cli.pid)) {
        const captured = capturePublicProcess(pid, 'local-client.mjs', `${label} profile Client`)
        if (captured !== undefined) { lateClient = captured; break }
      }
      if (lateClient !== undefined) return { kind: 'daemon', client: lateClient }
      return { kind: 'direct' }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: neither a real Client nor a painted Direct composer appeared within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

async function waitForPublicHostChildOrUsableSurface(handle, existing, label, surface) {
  const started = Date.now()
  for (;;) {
    for (const pid of linuxDescendantPids(handle.client.pid)) {
      const captured = capturePublicProcess(pid, 'local-host.mjs', `${label} new Host child`)
      if (captured === undefined) continue
      const observation = readKernelProcess(pid)
      if (observation.kind !== 'alive') continue
      if (serializeKernelIdentity(observation.identity) !== captured.birth) continue
      if (observation.identity.ppid !== handle.client.pid) continue
      return { kind: 'new', host: { ...captured, identity: observation.identity } }
    }
    const state = await handle.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      throw new Error(`${label}: the public CLI exited while the existing Host was live and no new Host started`)
    }
    const frame = await handle.terminal.text({ full: false }).catch(() => '')
    if (surface === 'workspace') {
      if (frame.includes('Choose workspace') || frame.includes('Sessions')) {
        return {
          kind: 'reuse',
          surface: { marker: 'workspace', typed: false, cleared: true, frame },
        }
      }
    } else if (publicComposerVisible(frame)) {
      return {
        kind: 'reuse',
        surface: await waitForPublicUsableSurface(handle, `${label} reused daemon surface`),
      }
    }
    if (Date.now() - started >= 180_000) {
      throw new Error(`${label}: the public Client neither started a Host nor reached a usable surface within 180000ms; last=${JSON.stringify(frame.slice(-1200))}`)
    }
    await sleep(50)
  }
}

async function waitForPublicHostChild(clientPid, label, timeoutMs) {
  const started = Date.now()
  for (;;) {
    for (const pid of linuxDescendantPids(clientPid)) {
      const captured = capturePublicProcess(pid, 'local-host.mjs', label)
      if (captured === undefined) continue
      const observation = readKernelProcess(pid)
      if (observation.kind !== 'alive') continue
      const identity = observation.identity
      if (serializeKernelIdentity(identity) !== captured.birth) continue
      if (identity.ppid !== clientPid) {
        throw new Error(`${label}: the captured public Host PID ${String(pid)} is no longer the Client's direct child`)
      }
      if (identity.pgid !== pid || identity.sid !== pid) {
        throw new Error(`${label}: the public Host PID ${String(pid)} is not its own detached group/session leader`)
      }
      if (processEnvironmentValue(pid, 'DSH_PI_TUI_BACKEND') !== undefined) {
        throw new Error(`${label}: the public Host inherited a backend selector`)
      }
      return { ...captured, identity }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the public Client started no local-host.mjs child within ${String(timeoutMs)}ms`)
    }
    await sleep(20)
  }
}

function publicFrameOf(text) {
  return typeof text === 'string' ? text : ''
}

function publicComposerVisible(frame) {
  return PUBLIC_DAEMON_COMPOSER.test(publicFrameOf(frame))
}

async function waitForPublicFrame(handle, predicate, label, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const text = await withProcessNativeOperation('public-daemon-text', handle.launchId,
      () => handle.terminal.text({ full: false }))
    if (predicate(text)) return text
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the public launch never painted the expected frame within ${String(timeoutMs)}ms; last=${JSON.stringify(text.slice(-1200))}`)
    }
    await sleep(50)
  }
}

/**
 * Wait for the real painted, usable composer: the marker exists, a printable
 * probe really enters the composer, and Ctrl+U clears it. A border, registry
 * record or authenticated Host alone is not user-ready evidence.
 */
async function waitForPublicUsableSurface(handle, label, timeoutMs = PUBLIC_DAEMON_READY_TIMEOUT_MS) {
  const started = Date.now()
  for (;;) {
    const state = await handle.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      const text = await handle.terminal.text({ full: true }).catch(() => '')
      throw new Error(`${label}: the public CLI exited before a usable surface (exit=${JSON.stringify({ code: state.exited, signal: state.exit_signal ?? null })}); text=${JSON.stringify(text.slice(-1200))}`)
    }
    const frame = await handle.terminal.text({ full: false }).catch(() => '')
    if (publicComposerVisible(frame)) {
      await withProcessNativeOperation('public-daemon-probe-type', handle.launchId,
        () => handle.terminal.type('x'))
      const accepted = await waitForPublicFrame(handle, text => /❯\s*x/u.test(text), `${label} composer probe`, 30_000)
      await withProcessNativeOperation('public-daemon-probe-clear', handle.launchId,
        () => handle.terminal.press('Ctrl+U'))
      const cleared = await waitForPublicFrame(handle, text => !/❯\s*x/u.test(text), `${label} composer clear`, 30_000)
      return { marker: 'composer', typed: accepted.includes('x'), cleared: !/❯\s*x/u.test(cleared), frame: cleared }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the public launch painted no usable composer within ${String(timeoutMs)}ms; last=${JSON.stringify(publicFrameOf(frame).slice(-1200))}`)
    }
    await sleep(100)
  }
}

async function waitForPublicWorkspaceSurface(handle, label, timeoutMs = PUBLIC_DAEMON_READY_TIMEOUT_MS) {
  const started = Date.now()
  for (;;) {
    const state = await handle.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      const text = await handle.terminal.text({ full: true }).catch(() => '')
      throw new Error(`${label}: the public CLI exited before the Session Workspace painted (exit=${JSON.stringify({ code: state.exited, signal: state.exit_signal ?? null })}); text=${JSON.stringify(text.slice(-1200))}`)
    }
    const frame = await handle.terminal.text({ full: false }).catch(() => '')
    if (frame.includes('Choose workspace') || frame.includes('Sessions')) {
      return { marker: 'workspace', typed: false, cleared: true, frame }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the public launch painted no Session Workspace within ${String(timeoutMs)}ms; last=${JSON.stringify(frame.slice(-1200))}`)
    }
    await sleep(100)
  }
}

function assertPublicHostRecord(host, registry, launch) {
  if (registry === null || typeof registry !== 'object') throw new Error('the public Host registry is not an object')
  if (registry.hostPid !== host.pid) throw new Error('the public Host registry names another PID')
  if (host.instanceId !== undefined && registry.instanceId !== host.instanceId) {
    throw new Error('the public Host registry names another instance')
  }
  if (registry.scopeId !== processScope.scopeId) throw new Error('the public Host registry names another scope')
  if (registry.buildId !== processScope.buildId) throw new Error('the public Host registry names another build')
  if (registry.profileRealpath !== processScope.profileRealpath) throw new Error('the public Host registry names another profile')
  if (registry.protocol !== 'dsh-pi-tui/local/2') throw new Error(`the public Host registry carries an unexpected protocol: ${String(registry.protocol)}`)
  if (launch === null || typeof launch !== 'object') throw new Error('the public Host launch record is not an object')
  const launchKeys = Object.keys(launch).sort().join(',')
  if (launchKeys !== 'connectUrl,instanceId,schema') throw new Error(`the public Host launch record has unexpected keys: ${launchKeys}`)
  if (launch.schema !== 1) throw new Error('the public Host launch record has an unexpected schema')
  if (launch.instanceId !== registry.instanceId) throw new Error('the public Host launch record names another instance')
  let connectUrl
  try {
    connectUrl = new URL(String(launch.connectUrl))
  } catch {
    throw new Error('the public Host launch record carries no valid connect URL')
  }
  if (connectUrl.origin !== registry.origin || connectUrl.pathname !== '/connect'
    || connectUrl.username !== '' || connectUrl.password !== '' || connectUrl.hash !== ''
    || connectUrl.searchParams.getAll('token').length !== 1
    || (connectUrl.searchParams.get('token') ?? '') === ''
    || [...connectUrl.searchParams.keys()].length !== 1) {
    throw new Error('the public Host launch record is not the Host-owned /connect token URL')
  }
}

async function waitForPublicHostRegistry(handle, timeoutMs = 180_000) {
  const registryPath = join(processScope.dir, 'instance.json')
  const launchPath = join(processScope.dir, 'launch.json')
  const started = Date.now()
  for (;;) {
    if (existsSync(registryPath) && existsSync(launchPath)) {
      const registry = readJson(registryPath, 'public Host registry')
      const launch = readJson(launchPath, 'public Host launch record')
      if (handle.host === undefined) throw new Error('the public Host row was not bound before its registry')
      assertPublicHostRecord(handle.host, registry, launch)
      return { registry, launch, registryPath, launchPath }
    }
    const state = await handle.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      throw new Error(`the public CLI exited before its Host published registry material (exit=${JSON.stringify({ code: state.exited, signal: state.exit_signal ?? null })})`)
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`the public Host published no registry/launch material within ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

/**
 * Authenticate the public Host through the official `/connect` Cookie exchange
 * and Owner identity route. The Cookie is memory-only and never enters a
 * receipt. A transient route failure while the Host is still booting is retried
 * within the one bounded window; a dead/mismatched Host fails closed.
 */
async function waitForPublicHostAuthentication(handle, registry, launch, timeoutMs = 120_000) {
  const started = Date.now()
  let lastError
  for (;;) {
    try {
      const cookie = await exchangeCookie(registry.origin, launch)
      const response = await readAuthenticatedIdentity(registry.origin, cookie, 'public Host authentication')
      assertClientHostMatchesPublished(response.identity, registry, 'public Host authentication')
      assertPublishedHostMatchesKernel(registry, 'public Host authentication')
      return { identity: response.identity, authenticatedAt: now() }
    } catch (error) {
      lastError = error
      const state = await handle.terminal.state().catch(() => undefined)
      if (state !== undefined && state.exited !== null) {
        throw new Error(`the public CLI exited during Host authentication (exit=${JSON.stringify({ code: state.exited, signal: state.exit_signal ?? null })})`)
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`public Host authentication did not settle within ${String(timeoutMs)}ms: ${boundedError(lastError)}`)
      }
      await sleep(100)
    }
  }
}

/** Apply the existing offline-LLM stub to the disposable profile's own patch layer. */
function applyPublicProfileLlmPatch() {
  if (publicProfileLlmPatch !== undefined) return
  const patchPath = join(scene.installation.profileDir, 'cordis.patch.yml')
  const stub = readFileSync(scene.installation.surfaceLlm.patchPath, 'utf8')
  const previous = existsSync(patchPath)
    ? { bytes: readFileSync(patchPath), mode: statSync(patchPath).mode & 0o777 }
    : undefined
  const current = previous?.bytes.toString('utf8') ?? ''
  if (current.includes(scene.installation.surfaceLlm.stubPath)) {
    publicProfileLlmPatch = { path: patchPath, previous, appended: false }
    return
  }
  // An empty profile patch is the YAML `[]` flow document; a block sequence
  // after it is invalid YAML, so replace the empty document exactly like the
  // existing public smoke fixture does.
  const document = current.split('\n').filter(line => line.trim() !== '[]').join('\n').replace(/\s*$/u, '')
  writeFileSync(patchPath, `${document}${document === '' ? '' : '\n'}${stub}`, { mode: 0o600 })
  publicProfileLlmPatch = { path: patchPath, previous, appended: true }
}

/** Create the controlled Herdr executable + its real-argv log for one launch. */
function preparePublicHerdr(clientDir, label) {
  const binPath = join(clientDir, 'herdr-fake')
  const logPath = join(clientDir, 'herdr.log')
  writeFileSync(binPath, `#!/bin/sh
{
  printf '%s' "$PPID"
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$HERDR_FAKE_LOG"
`, { mode: 0o700 })
  writeFileSync(logPath, '', { mode: 0o600, flag: 'wx' })
  return {
    paneId: `public-${label}-${String(publicLaunchSequence)}`,
    binPath,
    socketPath: join(clientDir, 'herdr.sock'),
    logPath,
    env: {
      HERDR_ENV: '1',
      HERDR_PANE_ID: `public-${label}-${String(publicLaunchSequence)}`,
      HERDR_BIN_PATH: binPath,
      HERDR_SOCKET_PATH: join(clientDir, 'herdr.sock'),
      HERDR_FAKE_LOG: logPath,
    },
  }
}

function publicCliArgs(message, profileName) {
  const args = message.args ?? {}
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON args must be an object')
  }
  const argv = []
  if (args.session !== undefined) {
    if (typeof args.session !== 'string' || args.session === '') {
      throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON session must be a non-empty string')
    }
    argv.push('--session', args.session)
  }
  if (args.continue !== undefined) {
    if (args.continue !== true) throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON continue may only be true')
    argv.push('-c')
  }
  if (args.preset !== undefined) {
    if (typeof args.preset !== 'string' || args.preset === '') {
      throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON preset must be a non-empty string')
    }
    argv.push('--preset', args.preset)
  }
  return { argv: ['--profile', profileName, ...argv], args }
}

function assertPublicLaunchInputs(message) {
  const label = message.label
  if (typeof label !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(label)) {
    throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON label must be a path-safe lowercase component')
  }
  if (publicLaunches.some(handle => handle.label === label)) {
    throw new Error(`START_PUBLIC_DAEMON: the launch label ${label} is already registered in this Scene`)
  }
  const profile = message.profile ?? 'pi-tui'
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/u.test(profile)) {
    throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON profile must be a public profile name')
  }
  if (message.backend !== undefined && !PUBLIC_DAEMON_BACKENDS.has(message.backend)) {
    throw new Error(`INPUT_UNQUALIFIED: START_PUBLIC_DAEMON backend must be one of ${[...PUBLIC_DAEMON_BACKENDS].map(value => JSON.stringify(value)).join(', ')}`)
  }
  if (message.alias !== undefined && (typeof message.alias !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/u.test(message.alias))) {
    throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON alias must be a public profile name')
  }
  const cols = message.cols ?? 140
  const rows = message.rows ?? 40
  if (!Number.isInteger(cols) || cols < 20 || cols > 400) throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON cols must be an integer in 20..400')
  if (!Number.isInteger(rows) || rows < 10 || rows > 200) throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON rows must be an integer in 10..200')
  const surface = message.surface ?? 'chat'
  if (surface !== 'chat' && surface !== 'workspace') {
    throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON surface must be chat or workspace')
  }
  return { label, profile, alias: message.alias, cols, rows, surface }
}

async function handleStartPublicDaemon(message) {
  requireProcessScene('START_PUBLIC_DAEMON')
  assertLifecycleOpen('START_PUBLIC_DAEMON')
  if (process.platform !== 'linux') {
    throw codedInputError('INPUT_PUBLIC_DAEMON_PLATFORM', 'the real public daemon PTY qualification is implemented on Linux only')
  }
  const { label, profile, alias, cols, rows, surface } = assertPublicLaunchInputs(message)
  if (processScope === undefined) throw new Error('START_PUBLIC_DAEMON: the process scope is not recorded')
  const sequence = ++publicLaunchSequence
  const launchDir = join(scene.workDir, 'public-launches', `${label}-${String(sequence)}`)
  mkdirSync(launchDir, { recursive: true, mode: 0o700 })
  let aliasPath
  if (alias !== undefined) {
    aliasPath = join(scene.installation.dshHome, 'profiles', alias)
    if (existsSync(aliasPath)) {
      if (realpathSync(aliasPath) !== realpathSync(scene.installation.profileDir)) {
        throw new Error(`START_PUBLIC_DAEMON: the private alias ${alias} does not resolve to the canonical profile`)
      }
    } else {
      symlinkSync(scene.installation.profileDir, aliasPath, 'dir')
    }
  }
  const profileName = alias ?? profile
  applyPublicProfileLlmPatch()
  const herdr = message.herdr === true ? preparePublicHerdr(launchDir, label) : undefined
  const loaderDumpPath = message.loaderDump === true ? join(launchDir, 'loader-rows.json') : undefined
  if (loaderDumpPath !== undefined && existsSync(loaderDumpPath)) {
    throw new Error('START_PUBLIC_DAEMON: the qualification Loader dump target already exists')
  }
  const backend = message.replayCommand !== undefined ? 'daemon' : message.backend
  let program
  let argv
  if (message.replayCommand !== undefined) {
    if (!Array.isArray(message.replayCommand) || message.replayCommand.some(value => typeof value !== 'string')) {
      throw new Error('INPUT_UNQUALIFIED: START_PUBLIC_DAEMON replayCommand must be a string array')
    }
    const captured = message.replayCommand
    const expected = ['env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh', '--profile', profileName, '--session']
    if (captured.length !== 7 || expected.some((value, index) => captured[index] !== value)
      || typeof captured[6] !== 'string' || captured[6] === '') {
      throw new Error(`INPUT_UNQUALIFIED: the captured Herdr resume argv is not the declared public shape: ${JSON.stringify(captured)}`)
    }
    const binDir = join(launchDir, 'bin')
    mkdirSync(binDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(binDir, 'dsh'), `#!/bin/sh
exec ${JSON.stringify(scene.installation.dshInvocation[0])} ${JSON.stringify(scene.installation.dshInvocation[1])} "$@"
`, { mode: 0o700 })
    program = 'env'
    argv = captured
    aliasPath = aliasPath ?? join(scene.installation.dshHome, 'profiles', profileName)
  } else {
    const built = publicCliArgs(message, profileName)
    program = scene.installation.dshInvocation[0]
    argv = [...scene.installation.dshInvocation.slice(1), ...built.argv]
  }
  const env = {
    ...scene.installation.base.env,
    ...(backend === undefined ? {} : { DSH_PI_TUI_BACKEND: backend }),
    ...(loaderDumpPath === undefined ? {} : { M62A_LOADER_DUMP: loaderDumpPath }),
    ...(herdr === undefined ? {} : herdr.env),
    ...(message.replayCommand === undefined ? {} : {
      PATH: `${join(launchDir, 'bin')}:${scene.installation.base.env.PATH ?? ''}`,
    }),
  }
  const handle = {
    launchId: `public-daemon-${String(sequence)}-${String(Date.now().toString(36))}`,
    label,
    profile: profileName,
    alias: alias ?? null,
    aliasPath,
    initialSurface: surface,
    backend: backend ?? null,
    sequence,
    launchedDir: launchDir,
    sessionId: null,
    terminal: undefined,
    shellPid: null,
    shellIdentity: undefined,
    cli: undefined,
    client: undefined,
    host: undefined,
    loaderDumpPath,
    loaderRows: undefined,
    herdr,
    reservedAt: now(),
    openedAt: undefined,
    readyAt: undefined,
    surfaceProbe: undefined,
    exited: false,
    exitResult: undefined,
    exitText: undefined,
    closed: false,
    closedAt: undefined,
    refused: false,
    verifiedTerminal: undefined,
    hostStopped: undefined,
  }
  publicLaunches.push(handle)
  handle.settlement = Promise.withResolvers()
  syncPublicLaunchReceipt()
  try {
    const splitTerminal = createSplitTerminal({
      prefix: 'public-daemon',
      traceDirectory: join(scene.workDir, 'trace'),
      artifactsDirectory: join(scene.workDir, 'artifacts'),
    })
    handle.terminal = splitTerminal.terminal
    handle.sessionId = splitTerminal.sessionId
    syncPublicLaunchReceipt()
    appendNote('public-daemon-reserved', {
      launchId: handle.launchId,
      label,
      profile: profileName,
      alias: handle.alias,
      backend: handle.backend,
      sessionId: handle.sessionId,
      cols,
      rows,
      argv,
    })
    writeReceipt({ phase: 'PUBLIC_DAEMON_RESERVED' })
    const opened = await withProcessNativeOperation('public-daemon-run', handle.launchId, () => handle.terminal.run(
      program,
      argv,
      { cwd: scene.installation.profileDir, cols, rows, waitReady: false, env },
    ))
    if (opened.session !== handle.sessionId) {
      throw new Error(`CLIENT_IDENTITY_UNVERIFIED: ${label}: the public native session identity changed at run()`)
    }
    handle.openedAt = now()
    handle.shellPid = Number.isInteger(opened.shell_pid) ? opened.shell_pid : null
    handle.shellIdentity = captureShellIdentity(handle.shellPid, `${label} public shell`)
    syncPublicLaunchReceipt()
    writeReceipt({ phase: 'PUBLIC_DAEMON_OPENED' })
    if (handle.backend === 'wire-local' || handle.backend === '') {
      const exit = await waitForTerminalExit(handle.terminal, `${label} illegal backend`, 60_000)
      return finishPublicRefusal(handle, {
        exit,
        text: await handle.terminal.text({ full: true }).catch(() => ''),
      })
    }
    const cliOutcome = await waitForPublicProcessOrExit(handle, handle.shellPid,
      scene.installation.dshInvocation[1], `${label} public CLI`, 120_000, { includeRoot: true })
    if (cliOutcome.kind === 'exit') return finishPublicRefusal(handle, cliOutcome)
    handle.cli = cliOutcome.process
    if (handle.cli.pid === handle.shellPid) {
      // A direct native spawn has no intermediate shell; the same kernel
      // identity is one process, never a fabricated edge.
      handle.shellIdentity = captureShellIdentity(handle.shellPid, `${label} public CLI/shell`)
    }
    syncPublicLaunchReceipt()
    appendNote('public-daemon-cli-captured', {
      launchId: handle.launchId,
      shellPid: handle.shellPid,
      shellBirth: handle.shellIdentity.birth,
      cliPid: handle.cli.pid,
      cliBirth: handle.cli.birth,
    })
    writeReceipt({})
    if (handle.backend === 'direct') {
      handle.surfaceProbe = surface === 'workspace'
        ? await waitForPublicWorkspaceSurface(handle, `${label} direct workspace surface`)
        : await waitForPublicUsableSurface(handle, `${label} direct surface`)
      handle.readyAt = now()
      syncPublicLaunchReceipt()
      writeReceipt({ phase: 'PUBLIC_DAEMON_READY' })
      return publicLaunchReturnFacts(handle)
    }
    let clientOutcome
    if (handle.backend === null) {
      const kind = await waitForPublicProfileBackendKind(handle, label)
      if (kind.kind === 'exit') return finishPublicRefusal(handle, kind)
      if (kind.kind === 'direct') {
        handle.surfaceProbe = surface === 'workspace'
          ? await waitForPublicWorkspaceSurface(handle, `${label} persisted-direct workspace surface`)
          : await waitForPublicUsableSurface(handle, `${label} persisted-direct surface`)
        handle.readyAt = now()
        syncPublicLaunchReceipt()
        writeReceipt({ phase: 'PUBLIC_DAEMON_READY' })
        return publicLaunchReturnFacts(handle)
      }
      clientOutcome = { kind: 'process', process: kind.client }
    } else {
      clientOutcome = await waitForPublicProcessOrExit(handle, handle.cli.pid,
        'local-client.mjs', `${label} public Client`, 120_000)
    }
    if (clientOutcome.kind === 'exit') return finishPublicRefusal(handle, clientOutcome)
    handle.client = clientOutcome.process
    syncPublicLaunchReceipt()
    appendNote('public-daemon-client-captured', {
      launchId: handle.launchId,
      cliPid: handle.cli.pid,
      clientPid: handle.client.pid,
      clientBirth: handle.client.birth,
    })
    writeReceipt({})
    const reusable = publicHosts.find(value => value.reclaimed !== true
      && publicIdentityState({ pid: value.pid, birth: value.birth, entry: 'local-host.mjs' }) === 'alive')
    let hostChild
    let reusedSurface
    if (reusable !== undefined) {
      const outcome = await waitForPublicHostChildOrUsableSurface(handle, reusable, label, surface)
      if (outcome.kind === 'reuse') {
        reusedSurface = outcome.surface
        handle.host = reusable
        syncPublicLaunchReceipt()
        appendNote('public-daemon-host-reused', {
          launchId: handle.launchId,
          hostPid: reusable.pid,
          hostBirth: reusable.birth,
          instanceId: reusable.instanceId,
          clientPid: handle.client.pid,
        })
      } else {
        hostChild = outcome.host
      }
    } else {
      hostChild = await waitForPublicHostChild(handle.client.pid, `${label} public Host`, 180_000)
    }
    if (hostChild !== undefined) {
      const host = {
        pid: hostChild.pid,
        birth: hostChild.birth,
        instanceId: undefined,
        scopeId: processScope.scopeId,
        buildId: processScope.buildId,
        origin: undefined,
        protocol: undefined,
        bundleVersion: undefined,
        dshVersion: undefined,
        schema: undefined,
        pgid: hostChild.identity.pgid,
        sid: hostChild.identity.sid,
        ppidAtCapture: hostChild.identity.ppid,
        registeredAt: now(),
        reclaimed: false,
        normalStop: false,
      }
      handle.host = host
      publicHosts.push(host)
      syncPublicLaunchReceipt()
      writeReceipt({ phase: 'PUBLIC_DAEMON_HOST_CAPTURED' })
    }
    const registryPath = join(processScope.dir, 'instance.json')
    const registryAbsent = !existsSync(registryPath)
    if (hostChild !== undefined && process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'public-daemon-before-registry') {
      await processProbeHold('public-daemon-before-registry', {
        launchId: handle.launchId,
        label,
        workerPid: receipt.worker?.pid,
        workerPpid: receipt.worker?.ppid,
        shellPid: handle.shellPid,
        shellBirth: handle.shellIdentity.birth,
        cliPid: handle.cli.pid,
        cliBirth: handle.cli.birth,
        clientPid: handle.client.pid,
        clientBirth: handle.client.birth,
        hostPid: handle.host.pid,
        hostBirth: handle.host.birth,
        hostPpid: handle.host.ppidAtCapture,
        scopeId: processScope.scopeId,
        registryPath,
        registryAbsent,
        ackOutstanding: true,
      })
    }
    const material = await waitForPublicHostRegistry(handle)
    const host = handle.host
    if (host === undefined) throw new Error('START_PUBLIC_DAEMON: the public Host row was not bound')
    host.instanceId = material.registry.instanceId
    host.origin = material.registry.origin
    host.protocol = material.registry.protocol
    host.bundleVersion = material.registry.bundleVersion
    host.dshVersion = material.registry.dshVersion
    host.schema = material.registry.schema
    host.registryPath = material.registryPath
    host.launchPath = material.launchPath
    syncPublicLaunchReceipt()
    const authentication = await waitForPublicHostAuthentication(handle, material.registry, material.launch)
    host.authenticatedAt = authentication.authenticatedAt
    host.identity = authentication.identity
    syncPublicLaunchReceipt()
    writeReceipt({ phase: 'PUBLIC_DAEMON_HOST_AUTHENTICATED' })
    if (loaderDumpPath !== undefined) {
      handle.loaderRows = await waitForPublicLoaderRows(loaderDumpPath, `${label} Loader dump`)
      syncPublicLaunchReceipt()
    }
    handle.surfaceProbe = reusedSurface ?? (surface === 'workspace'
      ? await waitForPublicWorkspaceSurface(handle, `${label} daemon workspace surface`)
      : await waitForPublicUsableSurface(handle, `${label} daemon surface`))
    handle.readyAt = now()
    syncPublicLaunchReceipt()
    writeReceipt({ phase: 'PUBLIC_DAEMON_READY' })
    if (process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'public-daemon-before-ready-ack') {
      await processProbeHold('public-daemon-before-ready-ack', {
        launchId: handle.launchId,
        label,
        workerPid: receipt.worker?.pid,
        workerPpid: receipt.worker?.ppid,
        shellPid: handle.shellPid,
        shellBirth: handle.shellIdentity.birth,
        cliPid: handle.cli.pid,
        cliBirth: handle.cli.birth,
        clientPid: handle.client.pid,
        clientBirth: handle.client.birth,
        hostPid: host.pid,
        hostBirth: host.birth,
        instanceId: host.instanceId,
        origin: host.origin,
        scopeId: host.scopeId,
        registryPublished: true,
        authenticated: true,
        surface: handle.surfaceProbe,
        ackOutstanding: true,
      })
    }
    return publicLaunchReturnFacts(handle)
  } catch (error) {
    handle.startFailure = error
    syncPublicLaunchReceipt()
    throw error
  } finally {
    handle.settlement.resolve()
  }
}

function publicLaunchReturnFacts(handle) {
  return {
    launchId: handle.launchId,
    label: handle.label,
    profile: handle.profile,
    alias: handle.alias,
    sessionId: handle.sessionId,
    backend: handle.backend,
    shellPid: handle.shellPid,
    shellBirth: handle.shellIdentity?.birth ?? null,
    cli: handle.cli ?? null,
    client: handle.client ?? null,
    host: handle.host == null ? null : publicDaemonHostFacts(handle.host),
    ready: handle.readyAt !== undefined,
    refused: handle.refused === true,
    exit: handle.exitResult ?? null,
    surface: handle.surfaceProbe ?? null,
    loaderRows: handle.loaderRows ?? null,
    herdr: handle.herdr == null ? null : {
      paneId: handle.herdr.paneId,
      binPath: handle.herdr.binPath,
      socketPath: handle.herdr.socketPath,
      logPath: handle.herdr.logPath,
    },
  }
}

async function waitForPublicLoaderRows(target, label, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (existsSync(target)) {
      const rows = JSON.parse(readFileSync(target, 'utf8'))
      if (!Array.isArray(rows)) throw new Error(`${label}: the Loader dump is not an array`)
      if (rows.length > 0) {
        if ((statSync(target).mode & 0o777) !== 0o600) throw new Error(`${label}: the Loader dump is not 0600`)
        return rows
      }
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: no evaluated Loader rows appeared within ${String(timeoutMs)}ms`)
    await sleep(50)
  }
}

function requirePublicDaemonRequest(message, label) {
  requireProcessScene(label)
  assertLifecycleOpen(label)
  const handle = publicLaunchById(message.launchId, label)
  if (handle.closed) throw new Error(`${label}: the public launch ${handle.label} is already closed`)
  return handle
}

async function handlePublicDaemonInput(message) {
  const handle = requirePublicDaemonRequest(message, 'PUBLIC_DAEMON_INPUT')
  const input = message.input
  if (input === null || typeof input !== 'object') throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_INPUT requires an input object')
  let body
  if (input.type === 'type') {
    if (typeof input.text !== 'string') throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_INPUT type requires text')
    body = () => handle.terminal.type(input.text)
  } else if (input.type === 'press') {
    if (!Array.isArray(input.keys) || input.keys.length === 0 || input.keys.some(key => typeof key !== 'string' || key === '')) {
      throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_INPUT press requires a non-empty key list')
    }
    body = () => handle.terminal.press(...input.keys)
  } else if (input.type === 'submit') {
    if (input.text !== undefined && typeof input.text !== 'string') throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_INPUT submit text must be a string')
    body = () => (input.text === undefined ? handle.terminal.submit() : handle.terminal.submit(input.text))
  } else {
    throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_INPUT type must be one of type/press/submit')
  }
  await withProcessNativeOperation(`public-daemon-${String(input.type)}`, handle.launchId, body)
  return { ok: true }
}

async function handlePublicDaemonKernelState(message) {
  requireProcessScene('PUBLIC_DAEMON_KERNEL_STATE')
  const handle = publicLaunchById(message.launchId, 'PUBLIC_DAEMON_KERNEL_STATE')
  return {
    launchId: handle.launchId,
    label: handle.label,
    exited: handle.exited === true,
    closed: handle.closed === true,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    cliState: publicIdentityState(handle.cli),
    clientState: publicIdentityState(handle.client),
    hostState: handle.host === undefined ? 'unknown' : publicIdentityState(handle.host),
    cliPid: handle.cli?.pid ?? null,
    clientPid: handle.client?.pid ?? null,
    hostPid: handle.host?.pid ?? null,
    hostInstanceId: handle.host?.instanceId ?? null,
  }
}

async function handlePublicDaemonText(message) {
  const handle = requirePublicDaemonRequest(message, 'PUBLIC_DAEMON_TEXT')
  const full = message.full === true
  const text = await withProcessNativeOperation('public-daemon-text', handle.launchId, () => handle.terminal.text({ full }))
  return { text }
}

async function handlePublicDaemonState(message) {
  const handle = requirePublicDaemonRequest(message, 'PUBLIC_DAEMON_STATE')
  if (handle.closed) {
    return {
      launchId: handle.launchId,
      label: handle.label,
      sessionId: handle.sessionId,
      exited: true,
      exitCode: handle.exitResult?.code ?? null,
      exitSignal: handle.exitResult?.signal ?? null,
      closed: true,
      cliState: publicIdentityState(handle.cli),
      clientState: publicIdentityState(handle.client),
      hostState: handle.host === undefined ? 'unknown' : publicIdentityState(handle.host),
    }
  }
  const state = await withProcessNativeOperation('public-daemon-state', handle.launchId, () => handle.terminal.state())
  if (state.exited !== null && !handle.exited) {
    handle.exited = true
    handle.exitResult = { code: state.exited, signal: state.exit_signal ?? null }
    handle.closedAt = handle.closedAt ?? now()
    handle.exitText = await handle.terminal.text({ full: true }).catch(() => handle.exitText)
    syncPublicLaunchReceipt()
  }
  return {
    launchId: handle.launchId,
    label: handle.label,
    sessionId: handle.sessionId,
    exited: state.exited !== null,
    exitCode: state.exited,
    exitSignal: state.exit_signal ?? null,
    closed: false,
    cliState: publicIdentityState(handle.cli),
    clientState: publicIdentityState(handle.client),
    hostState: handle.host === undefined ? 'unknown' : publicIdentityState(handle.host),
    cols: state.cols,
    rows: state.rows,
  }
}

function publicIdentityState(processFacts) {
  if (processFacts === undefined) return 'gone'
  const observation = readKernelProcess(processFacts.pid)
  if (observation.kind === 'unknown') return 'unknown'
  if (observation.kind === 'gone') return 'gone'
  return serializeKernelIdentity(observation.identity) === processFacts.birth
    ? (classifyKernelLiveness(observation).state === 'alive' ? 'alive' : 'gone')
    : 'reused'
}

async function handlePublicDaemonClose(message) {
  const handle = publicLaunchById(message.launchId, 'PUBLIC_DAEMON_CLOSE')
  if (handle.closed) return { ...publicLaunchFacts(handle), ok: true }
  if (handle.closeFailure !== undefined) throw handle.closeFailure
  assertLifecycleOpen('PUBLIC_DAEMON_CLOSE')
  let failure
  try {
    if (!handle.exited) {
      const exit = await withProcessNativeOperation('public-daemon-close-exit', handle.launchId,
        () => waitForTerminalExit(handle.terminal, handle.label, 120_000))
      handle.exitResult = exit
      handle.exited = true
    }
    handle.exitText = await handle.terminal.text({ full: true }).catch(() => handle.exitText)
  } catch (error) {
    failure = error
  }
  try {
    await withProcessNativeOperation('public-daemon-close-native', handle.launchId, () => handle.terminal.closeQuiet())
  } catch (error) {
    const stillOpen = new Set(await openTuiSessions()).has(handle.sessionId)
    if (stillOpen) failure = failure === undefined ? error : new AggregateError([failure, error], `${handle.label}: public close and native teardown both failed`)
  }
  try {
    await assertPublicLaunchTerminalContract(handle, 'PUBLIC_DAEMON_CLOSE')
  } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], `${handle.label}: public launch did not reach a quiescent terminal`)
  }
  if (failure !== undefined) {
    handle.closeFailure = failure
    syncPublicLaunchReceipt()
    throw failure
  }
  handle.closed = true
  handle.closedAt = now()
  handle.verifiedTerminal = {
    kind: 'native',
    code: handle.exitResult?.code ?? null,
    signal: handle.exitResult?.signal ?? null,
  }
  syncPublicLaunchReceipt()
  writeReceipt({ phase: 'PUBLIC_DAEMON_CLOSED' })
  return publicLaunchFacts(handle)
}

/** The public launch must be really gone: no native session, no CLI/Client identity. */
async function assertPublicLaunchTerminalContract(handle, reason) {
  const openSessions = new Set(await openTuiSessions())
  if (openSessions.has(handle.sessionId)) throw new Error(`${reason}: ${handle.label} left its native public session open`)
  for (const entry of [handle.cli, handle.client]) {
    if (entry === undefined) continue
    const state = publicIdentityState(entry)
    if (state === 'alive' || state === 'unknown') {
      throw new Error(`${reason}: ${handle.label} ${entry.entry} PID ${String(entry.pid)} is ${state}`)
    }
  }
  if (handle.shellIdentity !== undefined) {
    const state = processIdentityState(handle.shellIdentity.identity)
    if (state === 'alive' || state === 'unknown') {
      throw new Error(`${reason}: ${handle.label} native shell PID ${String(handle.shellPid)} is ${state}`)
    }
  }
}

async function handlePublicDaemonReclaim(message) {
  requireProcessScene('PUBLIC_DAEMON_RECLAIM')
  const handle = publicLaunchById(message.launchId, 'PUBLIC_DAEMON_RECLAIM')
  if (handle.closed) return publicLaunchFacts(handle)
  await reclaimPublicLaunch(handle, 'PUBLIC_DAEMON_RECLAIM')
  return publicLaunchFacts(handle)
}

async function handlePublicDaemonTerminateCli(message) {
  const handle = requirePublicDaemonRequest(message, 'PUBLIC_DAEMON_TERMINATE_CLI')
  if (handle.cli === undefined) throw new Error('PUBLIC_DAEMON_TERMINATE_CLI: the public CLI was never captured')
  if (handle.cliTerminated === true) throw new Error('PUBLIC_DAEMON_TERMINATE_CLI: the one declared CLI TERM was already sent')
  const observation = readKernelProcess(handle.cli.pid)
  if (observation.kind !== 'alive') throw new Error('PUBLIC_DAEMON_TERMINATE_CLI: the captured CLI is not alive')
  if (serializeKernelIdentity(observation.identity) !== handle.cli.birth) {
    throw new Error('PUBLIC_DAEMON_TERMINATE_CLI: the captured CLI identity was reused')
  }
  if (processEnvironmentValue(handle.cli.pid, 'DSH_HOME') !== scene.installation.dshHome) {
    throw new Error('PUBLIC_DAEMON_TERMINATE_CLI: the captured CLI does not carry this Scene DSH home')
  }
  handle.cliTerminated = true
  appendNote('public-daemon-cli-terminated', {
    launchId: handle.launchId,
    cliPid: handle.cli.pid,
    cliBirth: handle.cli.birth,
    signal: 'SIGTERM',
  })
  process.kill(handle.cli.pid, 'SIGTERM')
  syncPublicLaunchReceipt()
  return { launchId: handle.launchId, pid: handle.cli.pid, birth: handle.cli.birth, signal: 'SIGTERM' }
}

function parseDaemonStatusFields(text) {
  const lines = String(text).split('\n')
  const start = lines.findLastIndex(line => line.startsWith('profile='))
  const fields = {}
  if (start >= 0) {
    for (const line of lines.slice(start)) {
      const at = line.indexOf('=')
      if (at > 0 && !line.includes(' ')) fields[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return fields
}

async function handlePublicDaemonStatus(message) {
  requireProcessScene('PUBLIC_DAEMON_STATUS')
  assertLifecycleOpen('PUBLIC_DAEMON_STATUS')
  const handle = publicLaunchById(message.launchId, 'PUBLIC_DAEMON_STATUS')
  const profileName = handle.profile
  const helper = await runTrackedOnce(scene.installation.dshInvocation,
    ['--profile', profileName, 'daemon', 'status'],
    scene.installation.profileDir,
    scene.installation.env,
    `${handle.label} public daemon status`,
    120_000)
  const output = helper.outputText ?? ''
  const fields = parseDaemonStatusFields(output)
  return {
    exit: helper.exitResult,
    fields,
    stdoutBytes: output.length,
  }
}

async function handlePublicDaemonHeadless(message) {
  requireProcessScene('PUBLIC_DAEMON_HEADLESS')
  assertLifecycleOpen('PUBLIC_DAEMON_HEADLESS')
  const label = message.label
  if (typeof label !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(label)) {
    throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_HEADLESS label must be a path-safe lowercase component')
  }
  if (message.backend !== 'daemon') throw new Error('INPUT_UNQUALIFIED: PUBLIC_DAEMON_HEADLESS only exercises the daemon backend')
  const built = publicCliArgs({ args: message.args ?? {} }, 'pi-tui')
  const helper = await runTrackedOnce(scene.installation.dshInvocation,
    built.argv,
    scene.installation.profileDir,
    { ...scene.installation.env, DSH_PI_TUI_BACKEND: 'daemon' },
    `${label} headless daemon refusal`,
    120_000)
  return {
    exit: helper.exitResult,
    text: (helper.outputText ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-4000),
  }
}

async function handlePublicDaemonStop(message) {
  requireProcessScene('PUBLIC_DAEMON_STOP')
  assertLifecycleOpen('PUBLIC_DAEMON_STOP')
  const handle = publicLaunchById(message.launchId, 'PUBLIC_DAEMON_STOP')
  if (!handle.closed) throw new Error('PUBLIC_DAEMON_STOP: every public foreground session must be terminal before the Host stop')
  const host = handle.host
  if (host === undefined) throw new Error('PUBLIC_DAEMON_STOP: this public launch owns no Host')
  if (host.reclaimed === true) return publicDaemonHostFacts(host)
  const helper = await runTrackedOnce(scene.installation.dshInvocation,
    ['--profile', handle.profile, 'daemon', 'stop'],
    scene.installation.profileDir,
    scene.installation.env,
    `${handle.label} public daemon stop`,
    180_000)
  if (helper.exitResult?.code !== 0 || helper.exitResult?.signal !== null) {
    throw new Error(`PUBLIC_DAEMON_STOP: the public daemon stop failed: exit=${JSON.stringify(helper.exitResult)} output=${JSON.stringify((helper.outputText ?? '').slice(-1200))}`)
  }
  await waitForPublicHostTerminal(host, 'PUBLIC_DAEMON_STOP', 60_000)
  const registryPath = join(processScope.dir, 'instance.json')
  const launchPath = join(processScope.dir, 'launch.json')
  if (existsSync(registryPath)) {
    const after = readJson(registryPath, 'public Host registry after daemon stop')
    if (after.hostPid === host.pid && after.instanceId === host.instanceId) {
      throw new Error('PUBLIC_DAEMON_STOP: the stopped public Host left its own registry record')
    }
  }
  if (existsSync(launchPath)) {
    throw new Error('PUBLIC_DAEMON_STOP: the stopped public Host left its one-shot launch material')
  }
  await assertSceneHostSeatFree('PUBLIC_DAEMON_STOP')
  host.reclaimed = true
  host.normalStop = true
  host.stoppedAt = now()
  handle.hostStopped = { at: host.stoppedAt, exit: helper.exitResult, fields: parseDaemonStatusFields(helper.outputText ?? '') }
  syncPublicLaunchReceipt()
  appendNote('public-daemon-host-stopped', { launchId: handle.launchId, hostPid: host.pid, hostBirth: host.birth, instanceId: host.instanceId })
  writeReceipt({})
  return publicDaemonHostFacts(host)
}

function publicHostStillLive(host) {
  return publicIdentityState({ pid: host.pid, birth: host.birth, entry: 'local-host.mjs' }) === 'alive'
}

/** Wait until the captured public Host kernel identity is gone or provably reused. */
async function waitForPublicHostTerminal(host, reason, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    const state = publicIdentityState({ pid: host.pid, birth: host.birth, entry: 'local-host.mjs' })
    if (state === 'gone' || state === 'reused') return state
    if (state === 'unknown') throw new Error(`${reason}: the public Host kernel identity is unverifiable`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${reason}: the public Host PID ${String(host.pid)} is still the captured process`)
    await sleep(50)
  }
}

/**
 * The public Host ownership proof immediately before a destructive signal:
 * uid, exact kernel birth, detached group/session, installed Host entry, this
 * DSH home, and (when published) the product registry naming this instance.
 * An absent registry is admitted only through the captured pre-registry edge.
 */
function assertPublicHostOwnership(host, reason, expectedBirth = host.birth) {
  const snapshot = nativeProcessSnapshot(host.pid)
  if (snapshot === null) throw new Error(`${reason}: the public Host has no readable kernel identity`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && snapshot.uid !== uid) throw new Error(`${reason}: the public Host is not owned by this user`)
  if (!snapshot.command.includes('local-host.mjs')) throw new Error(`${reason}: the PID does not run the public Host entry`)
  if (processEnvironmentValue(host.pid, 'DSH_HOME') !== scene.installation.dshHome) {
    throw new Error(`${reason}: the public Host does not carry this Scene DSH home`)
  }
  const observation = readKernelProcess(host.pid)
  if (observation.kind !== 'alive') throw new Error(`${reason}: the public Host is not a live kernel process`)
  const birth = serializeKernelIdentity(observation.identity)
  if (birth !== host.birth) throw new Error(`${reason}: the public Host kernel birth changed`)
  if (birth !== expectedBirth) throw new Error(`${reason}: the public Host birth does not match the expected admission identity`)
  const identity = observation.identity
  if (identity.pgid !== host.pid || identity.sid !== host.pid) {
    throw new Error(`${reason}: the public Host is not its own detached group/session leader`)
  }
  const registryPath = join(processScope.dir, 'instance.json')
  if (existsSync(registryPath)) {
    const registry = readJson(registryPath, 'public Host registry before signal')
    if (registry.hostPid !== host.pid || registry.instanceId !== host.instanceId
      || registry.scopeId !== processScope.scopeId) {
      throw new Error(`${reason}: the product registry names another live Host instance`)
    }
    if (registry.schema === 1) {
      if (registry.hostStarttime !== readHostStarttime(host.pid)) {
        throw new Error(`${reason}: the public Host registry starttime is not the live kernel birth`)
      }
    }
  } else if (host.instanceId !== undefined) {
    throw new Error(`${reason}: a published public Host lost its registry under a live kernel identity`)
  }
  return { birth, identity }
}

/** Reclaim one public Host this Scene captured (normal stop or compensation). */
async function reclaimPublicHost(host, reason) {
  if (host.reclaimed === true) return
  const registryPath = join(processScope.dir, 'instance.json')
  if (publicIdentityState({ pid: host.pid, birth: host.birth, entry: 'local-host.mjs' }) === 'gone') {
    host.reclaimed = true
    host.stoppedAt = now()
    syncPublicLaunchReceipt()
    return
  }
  if (process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'public-daemon-ownership-refused'
    && publicOwnershipRefusal === undefined) {
    const wrongBirth = `${host.birth}-mismatch`
    let refusal
    try {
      assertPublicHostOwnership(host, 'public ownership refusal', wrongBirth)
      refusal = 'the mismatched ownership proof unexpectedly passed'
    } catch (error) {
      refusal = boundedError(error)
    }
    const targetLive = publicIdentityState({ pid: host.pid, birth: host.birth, entry: 'local-host.mjs' }) === 'alive'
    publicOwnershipRefusal = {
      launchId: publicLaunches.find(handle => handle.host === host)?.launchId ?? null,
      pid: host.pid,
      birth: host.birth,
      expectedBirth: wrongBirth,
      refusal,
      targetLiveAtRefusal: targetLive,
      signalSent: false,
      rootRetainedAtRefusal: existsSync(scene.workDir),
      registryPresent: existsSync(registryPath),
      refusedAt: now(),
    }
    appendNote('public-daemon-ownership-refused', publicOwnershipRefusal)
    writeReceipt({
      phase: 'NOT_QUIESCED',
      errorName: 'PUBLIC_DAEMON_OWNERSHIP_REFUSED',
      publicOwnershipRefused: publicOwnershipRefusal,
    })
    // The external probe must independently observe the refused admission while
    // the same-birth Host is still live. The handshake is probe-owned, so this
    // path never invents a delay or signals before the release exists.
    const releasePath = process.env.SPLIT_VITEST_PUBLIC_REFUSAL_RELEASE
    if (typeof releasePath !== 'string' || releasePath === '') {
      throw new Error('public-daemon-ownership-refused: the external release path is not configured')
    }
    const started = Date.now()
    while (!existsSync(releasePath)) {
      if (Date.now() - started >= 120_000) {
        throw new Error('public-daemon-ownership-refused: the external probe never released the compensation')
      }
      await sleep(50)
    }
    publicOwnershipRefusal.releasedAt = now()
    publicOwnershipRefusal.compensationStartedAt = now()
  }
  const ownership = assertPublicHostOwnership(host, `reclaimPublicHost:${reason}`)
  const foregroundLive = publicLaunches.some(handle => handle.host === host && !handle.closed)
  if (foregroundLive) throw new Error(`reclaimPublicHost:${reason}: a public foreground session is still live`)
  appendNote('public-host-terminated', { pid: host.pid, birth: ownership.birth, reason, signal: 'SIGTERM' })
  process.kill(host.pid, 'SIGTERM')
  try {
    await waitForPublicHostTerminal(host, `reclaimPublicHost:${reason}`, 30_000)
  } catch (error) {
    const fresh = assertPublicHostOwnership(host, `reclaimPublicHost:${reason}: escalation`)
    appendNote('public-host-escalated', { pid: host.pid, birth: fresh.birth, reason, signal: 'SIGKILL' })
    process.kill(host.pid, 'SIGKILL')
    await waitForPublicHostTerminal(host, `reclaimPublicHost:${reason}: SIGKILL`, 10_000)
  }
  const remaining = kernelGroupLiveMemberPids(processKernelReaders(), host.pid, 'public Host group')
  if (remaining.length > 0) throw new Error(`reclaimPublicHost:${reason}: the public Host group still has live members: ${JSON.stringify(remaining)}`)
  await assertSceneHostSeatFree(`reclaimPublicHost:${reason}`)
  if (existsSync(registryPath)) {
    const after = readJson(registryPath, 'public Host registry after stop')
    if (after.hostPid === host.pid && after.instanceId === host.instanceId) {
      throw new Error(`reclaimPublicHost:${reason}: the stopped public Host left its own registry record`)
    }
  }
  const launchPath = join(processScope.dir, 'launch.json')
  if (existsSync(launchPath)) {
    throw new Error(`reclaimPublicHost:${reason}: the stopped public Host left its one-shot launch material`)
  }
  host.reclaimed = true
  host.stoppedAt = now()
  if (publicOwnershipRefusal !== undefined) {
    publicOwnershipRefusal.compensatedAt = now()
    publicOwnershipRefusal.compensationCompleted = true
    writeReceipt({ compensation: { ...(receipt?.compensation ?? {}), publicOwnershipRefused: { ...publicOwnershipRefusal } } })
  }
  syncPublicLaunchReceipt()
}

async function reclaimPublicLaunch(handle, reason) {
  if (handle.closed) return
  if (handle.reclaimPromise !== undefined) return await handle.reclaimPromise
  handle.reclaimPromise = (async () => {
    // The real frame is captured BEFORE the PTY is closed; after closeQuiet the
    // native handle legitimately has no readable state, so terminal exit code is
    // unknown and never invented.
    handle.exitText = await handle.terminal.text({ full: true }).catch(() => handle.exitText)
    try {
      await withProcessNativeOperation('public-daemon-reclaim-close', handle.launchId, () => handle.terminal.closeQuiet())
    } catch (error) {
      const stillOpen = new Set(await openTuiSessions()).has(handle.sessionId)
      if (stillOpen) throw error
    }
    await waitForPublicIdentityGone(handle.cli, `${reason}: ${handle.label} CLI`, 30_000)
    await waitForPublicIdentityGone(handle.client, `${reason}: ${handle.label} Client`, 30_000)
    if (handle.shellIdentity !== undefined) {
      await waitForProcessIdentityTerminal(handle.shellIdentity.identity, `${reason}: ${handle.label} shell`, 30_000)
    }
    if (new Set(await openTuiSessions()).has(handle.sessionId)) {
      throw new Error(`${reason}: ${handle.label} left its native public session open`)
    }
    handle.exited = true
    handle.exitResult = handle.exitResult ?? { code: null, signal: null }
    handle.closed = true
    handle.closedAt = now()
    handle.verifiedTerminal = { kind: 'native', code: handle.exitResult?.code ?? null, signal: handle.exitResult?.signal ?? null }
    syncPublicLaunchReceipt()
  })()
  return await handle.reclaimPromise
}

async function waitForPublicIdentityGone(processFacts, label, timeoutMs) {
  if (processFacts === undefined) return
  const started = Date.now()
  for (;;) {
    const state = publicIdentityState(processFacts)
    if (state === 'gone' || state === 'reused') return
    if (state === 'unknown') throw new Error(`${label}: the kernel identity is unverifiable`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: PID ${String(processFacts.pid)} is still the captured process`)
    await sleep(50)
  }
}

async function auditPublicLaunchLedger(reason) {
  if (scene?.kind !== 'process') return
  const problems = []
  const openSessions = new Set(await openTuiSessions())
  for (const handle of publicLaunches) {
    if (!handle.closed) problems.push(`${handle.label}: the public launch is not closed`)
    if (openSessions.has(handle.sessionId)) problems.push(`${handle.label}: its native public session is still open`)
    for (const [kind, entry] of [['CLI', handle.cli], ['Client', handle.client]]) {
      if (entry === undefined) continue
      const state = publicIdentityState(entry)
      if (state === 'alive' || state === 'unknown') problems.push(`${handle.label}: its ${kind} PID ${String(entry.pid)} is ${state}`)
    }
    if (handle.shellIdentity !== undefined) {
      const state = processIdentityState(handle.shellIdentity.identity)
      if (state === 'alive' || state === 'unknown') problems.push(`${handle.label}: its shell PID ${String(handle.shellPid)} is ${state}`)
    }
  }
  for (const host of publicHosts) {
    const state = publicIdentityState({ pid: host.pid, birth: host.birth, entry: 'local-host.mjs' })
    if (state === 'alive' || state === 'unknown') problems.push(`public Host PID ${String(host.pid)} is ${state}`)
  }
  if (problems.length > 0) throw new Error(`${reason}: public launch ledger audit failed: ${problems.join('; ')}`)
}

async function handleFinalize(message) {
  if (scene?.kind === 'process') {
    const preconditions = []
    for (const handle of qualificationClients) {
      if (handle.kind !== 'qualification-client') continue
      if (!handle.exited) preconditions.push(`the qualification Client ${String(handle.label)} is still live`)
      else if (handle.finished !== true) preconditions.push(`the qualification Client ${String(handle.label)} is not finished`)
    }
    for (const handle of qualificationHelpers) {
      if (!handle.exited) preconditions.push(`the ${entryKindLabel(handle)} ${String(handle.label)} is still live`)
      else if (handle.finished !== true) preconditions.push(`the ${entryKindLabel(handle)} ${String(handle.label)} is not finished`)
    }
    for (const handle of processClients) {
      if (!handle.closed) preconditions.push(`the process Client ${String(handle.label)} is not closed`)
      if (handle.verifiedTerminal === undefined) {
        preconditions.push(`the process Client ${String(handle.label)} has no verified terminal fact`)
        continue
      }
      try {
        assertProcessClientTerminalContract(handle, 'FINALIZE')
      } catch (error) {
        preconditions.push(boundedError(error))
      }
    }
    for (const handle of publicLaunches) {
      if (!handle.closed) preconditions.push(`the public daemon launch ${String(handle.label)} is not closed`)
      if (handle.verifiedTerminal === undefined) {
        preconditions.push(`the public daemon launch ${String(handle.label)} has no verified terminal fact`)
      }
    }
    for (const host of publicHosts) {
      if (host.reclaimed !== true) {
        preconditions.push(`the public Host PID ${String(host.pid)} was not reclaimed`)
      } else if (host.normalStop !== true) {
        preconditions.push(`the public Host PID ${String(host.pid)} was not stopped through the public daemon stop`)
      }
    }
    if (processClients.length > 0 && !preconditions.some(value => value.includes('process Client'))) {
      try {
        await auditProcessClientLedger('FINALIZE: pre-stop')
      } catch (error) {
        preconditions.push(`the process Client ledger is not terminal (${boundedError(error)})`)
      }
    }
    for (const fallback of fallbackHosts) {
      if (fallback.normalStopRequired !== true) continue
      if (fallback.reclaimed !== true) {
        preconditions.push(`the discovered Host PID ${String(fallback.pid)} was not reclaimed`)
      } else if (fallback.normalStop !== true) {
        preconditions.push(`the discovered Host PID ${String(fallback.pid)} was not normally stopped`)
      }
    }
    if (processInstallationMutation !== undefined) {
      preconditions.push(`the installed-copy mutation ${String(processInstallationMutation.fault)} is not restored`)
    }
    if (processBootstrapCliPatch !== undefined) preconditions.push('the inherited profile patch is not restored')
    if (message.clientsClosed !== true) preconditions.push('the Worker did not confirm its Clients closed')
    for (const handle of hosts) {
      if (handle.mode !== undefined && handle.finished !== true && handle.acceptedHost !== true) {
        preconditions.push(`the Host attempt ${String(handle.label)} is not finished`)
      }
    }
    if (preconditions.length > 0) {
      throw new Error(`FINALIZE: Process terminal preconditions failed before Host stop: ${preconditions.join('; ')}`)
    }
  }
  let hostStopError
  // The one-shot qualification Client must already be gone on the normal path;
  // a still-live one is reclaimed so FINALIZE never leaks, then fails closed.
  if (activeQualificationClient !== undefined) {
    try {
      await terminateQualificationClient('FINALIZE')
    } catch (error) {
      hostStopError = hostStopError ?? error
    }
  }
  for (const handle of qualificationClients) {
    if (handle.kind === 'qualification-client') {
      // A process qualification entry carries its OWN declared terminal
      // (success or a pre-registered refusal); forgetting to finish it is a
      // failed finalization, never silently reclaimed as clean.
      if (handle.finished !== true) {
        hostStopError = hostStopError ?? new Error(
          `FINALIZE: the qualification Client ${String(handle.label)} was not finished by the Worker`)
      }
      if (!handle.exited) {
        hostStopError = hostStopError ?? new Error(
          `FINALIZE: the qualification Client ${String(handle.label)} is still live`)
      }
      continue
    }
    if (handle.exitResult?.code !== 0 || handle.exitResult?.signal !== null) {
      hostStopError = hostStopError ?? new Error(
        `FINALIZE: qualification Client PID ${String(handle.child.pid)} did not exit normally: ${JSON.stringify(handle.exitResult ?? null)}`)
    }
  }
  for (const handle of qualificationHelpers) {
    if (handle.finished !== true || !handle.exited) {
      hostStopError = hostStopError ?? new Error(
        `FINALIZE: the ${entryKindLabel(handle)} ${String(handle.label)} was not finished by the Worker`)
    }
  }
  if (processInstallationMutation !== undefined) {
    hostStopError = hostStopError ?? new Error(
      `FINALIZE: the installed-copy mutation ${String(processInstallationMutation.fault)} was not restored by the Worker`)
  }
  if (scene?.kind !== 'process') {
    for (const handle of processClients) {
      if (handle.closed) continue
      try {
        await settleProcessClientHandler(handle, 'FINALIZE')
        await settleProcessClientClose(handle, 'FINALIZE')
        await reclaimProcessClient(handle, 'FINALIZE')
      } catch (error) {
        hostStopError = hostStopError ?? error
      }
      hostStopError = hostStopError ?? new Error(
        `FINALIZE: the process Client ${handle.label} was not closed by the Worker`)
    }
    for (const handle of processClients) {
      if (handle.exitResult?.code !== 0 || handle.exitResult?.signal !== null) {
        hostStopError = hostStopError ?? new Error(
          `FINALIZE: process Client ${handle.label} did not exit normally: ${JSON.stringify(handle.exitResult ?? null)}`)
      }
    }
    for (const handle of hosts) {
      if (handle.mode !== undefined && handle.finished !== true && handle.acceptedHost !== true) {
        hostStopError = hostStopError ?? new Error(
          `FINALIZE: the Host attempt ${String(handle.label)} was not finished by the Worker`)
      }
    }
  }
  // Native leftover Clients/shells are reclaimed BEFORE any Host stop, using
  // only their registered uid/kernel-birth/command/scratch ownership proof.
  if (isNativeScene()) {
    try {
      await reclaimNativeClients('FINALIZE')
    } catch (error) {
      hostStopError = hostStopError ?? error
    }
  }
  // A failed native Client close must not prevent the final Host reclaim.
  if (activeHost !== undefined) {
    try {
      await officialStopHost(activeHost)
    } catch (error) {
      hostStopError = hostStopError ?? error
    }
  }
  for (const handle of hosts) {
    if (!handle.exited) {
      try {
        await terminateHost(handle, 'FINALIZE')
      } catch (error) {
        hostStopError = hostStopError ?? error
      }
    } else {
      try {
        await assertHostGroupGone(handle, 'FINALIZE')
      } catch (error) {
        hostStopError = hostStopError ?? error
      }
    }
  }
  if (scene?.kind !== 'process' && message.clientsClosed !== true) {
    hostStopError = hostStopError ?? new Error('FINALIZE: worker did not confirm Clients closed')
  }
  if (isNativeScene()) {
    const nativeCleanup = await cleanupNativeManagedService('FINALIZE')
    if (!nativeCleanup.clean) {
      hostStopError = hostStopError ?? new Error(`FINALIZE: the native managed service is not reclaimed (${String(nativeCleanup.reason)})`)
    }
  } else {
    try {
      auditClientLedger('FINALIZE')
    } catch (error) {
      hostStopError = hostStopError ?? error
    }
  }
  if (hostStopError !== undefined) throw hostStopError
  for (const handle of hosts) {
    if (handle.finished === true) continue
    if (handle.exitResult?.code !== 0 || handle.exitResult?.signal !== null) {
      throw new Error(`FINALIZE: Host generation ${String(handle.generation)} did not exit normally: ${JSON.stringify(handle.exitResult)}`)
    }
  }
  for (const handle of hosts) {
    if (handle.finished === true && handle.terminal?.outcome === undefined) {
      throw new Error(`FINALIZE: Host generation ${String(handle.generation)} has an unvalidated terminal record`)
    }
  }
  try {
    await auditPublicLaunchLedger('FINALIZE')
  } catch (error) {
    hostStopError = hostStopError ?? error
  }
  try {
    await reclaimClientFallbackHosts('FINALIZE')
  } catch (error) {
    hostStopError = hostStopError ?? error
  }
  try {
    await assertSceneHostSeatFree('FINALIZE')
  } catch (error) {
    hostStopError = hostStopError ?? error
  }
  if (scene?.kind === 'process') {
    try {
      await assertClientSeatFree(scene.installation, processScope.scopeId, 'FINALIZE')
    } catch (error) {
      hostStopError = hostStopError ?? error
    }
  }
  if (hostStopError !== undefined) throw hostStopError
  if (scene !== undefined) {
    await cleanupSceneRoot('FINALIZE')
  }
  finalized = true
  writeReceipt({
    phase: 'FINALIZED',
    cleanup: {
      ...(receipt?.cleanup ?? {}),
      completedAt: now(),
      ...(scene?.kind === 'process'
        ? { hostsExited: hosts.every(handle => handle.exited), hostSeatFree: true, qualificationSeatFree: true }
        : {}),
    },
  })
  receiptTerminal = true
}


/** Capture the OS ownership facts of a native Client/shell report at report time. */
function captureNativeReportIdentities({ shellPid, businessPids, scratch }) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) {
    throw new Error('NATIVE_CLIENT_IDENTITY_UNPROVEN: REPORT client-started requires the real tui-test shell PID')
  }
  const shell = captureNativeClientIdentity(shellPid, { requireScratch: false })
  const business = businessPids.map(pid => captureNativeClientIdentity(pid, { requireScratch: true, scratch }))
  return { shell, business, recordedAt: now() }
}

async function handleReport(message) {
  const detail = message.detail === undefined ? undefined : message.detail
  if (message.event === 'client-started' && scene?.kind === 'process') {
    throw new Error('REPORT client-started: the Supervisor owns every process Client identity; a Worker report cannot register one')
  }
  if (message.event === 'client-started' && detail !== undefined) {
    if (receipt.clients?.some(client => client.label === detail.label)) {
      throw new Error(`REPORT client-started: the Client label ${String(detail.label)} is already registered`)
    }
    const businessPids = Array.isArray(detail.businessPids)
      ? detail.businessPids.filter(pid => Number.isInteger(pid) && pid > 0)
      : []
    const recordFile = scene?.kind === 'upgrade'
      ? assertOwnedRecordFile(detail.recordFile, 'REPORT client-started')
      : (typeof detail.recordFile === 'string' ? detail.recordFile : undefined)
    const clientScratch = scene?.kind === 'upgrade'
      ? assertOwnedSceneDirectory(detail.scratch, 'REPORT client-started')
      : undefined
    const nativeOs = isNativeScene()
      ? captureNativeReportIdentities({ shellPid: detail.shellPid, businessPids, scratch: clientScratch })
      : undefined
    receipt.clients = [...(receipt.clients ?? []), {
      label: detail.label,
      session: detail.session,
      shellPid: detail.shellPid ?? null,
      recordFile,
      ...(scene?.kind === 'upgrade' ? { scratch: clientScratch } : {}),
      businessPids,
      ...(scene?.kind === 'upgrade'
        ? { businessPidFacts: businessPids.map(pid => ({ pid, starttime: readHostStarttimeOrUndefined(pid) })) }
        : {}),
      ...(nativeOs === undefined ? {} : { nativeOs }),
      businessPid: businessPids.at(-1) ?? null,
      startedAt: now(),
    }]
    writeReceipt({})
    return
  }
  if (message.event === 'client-pids' && detail !== undefined) {
    if (scene?.kind !== 'upgrade') throw new Error('REPORT client-pids: only an upgrade scene has an official Client PID ledger')
    const client = (receipt.clients ?? []).find(value => value.label === detail.label)
    if (client === undefined) throw new Error(`REPORT client-pids: unknown Client label ${String(detail.label)}`)
    if (client.recordFile !== assertOwnedRecordFile(detail.recordFile, 'REPORT client-pids')) {
      throw new Error(`REPORT client-pids: ${String(detail.label)} does not match its registered recordFile`)
    }
    const merged = new Set(Array.isArray(client.businessPids) ? client.businessPids : [])
    const facts = new Map((client.businessPidFacts ?? []).map(value => [value.pid, value.starttime]))
    const additions = []
    for (const pid of Array.isArray(detail.businessPids) ? detail.businessPids : []) {
      if (!Number.isInteger(pid) || pid <= 0) continue
      if (merged.has(pid)) continue
      additions.push(pid)
      merged.add(pid)
      if (!facts.has(pid)) facts.set(pid, readHostStarttimeOrUndefined(pid))
    }
    if (isNativeScene()) {
      if (client.nativeOs === undefined) {
        throw new Error(`REPORT client-pids: ${String(detail.label)} has no registered native OS identity`)
      }
      for (const pid of additions) {
        client.nativeOs.business = [...(client.nativeOs.business ?? []),
          captureNativeClientIdentity(pid, { requireScratch: true, scratch: client.scratch })]
      }
    }
    client.businessPids = [...merged]
    client.businessPidFacts = [...facts].map(([pid, starttime]) => ({ pid, starttime }))
    client.businessPid = client.businessPids.at(-1) ?? null
    writeReceipt({})
    return
  }
  receipt.notes = [...(receipt.notes ?? []), { event: message.event, detail, at: now() }]
  writeReceipt({})
}

// ── process Scene: installed-entry qualification seams ───────────────────
//
// The process Project needs bounded observation of real installed entry
// processes that are NOT the normal ready Host/Client pair: concurrent Host
// contenders, one-shot qualification Clients, the installed regular CLI and
// real identity witnesses. Every one of them is a real detached child this
// Supervisor created; the Worker only holds an opaque entry id and the facts
// this process proves. There is no second process manager.

const HOST_ATTEMPT_MODES = new Set([
  'seat-race',
  'seat-conflict',
  'host-runtime-disabled',
  'tui-row-enabled',
  'connection-disabled',
  'session-controller-disabled',
  'workspace-controller-disabled',
  'host-runtime-absent',
  'host-bootstrap-absent',
  'scratch-removal-failure',
  'early-exit',
  'stop-during-publication',
  'stop-during-initial-liveness',
])

const QUALIFICATION_CLIENT_MODES = new Set([
  'attach',
  'seat-race',
  'omit-cookie',
  'startup-fatal',
  'refresh-unresponsive-once',
  'bootstrap-failure',
  'client-bootstrap-drift',
  'discover-after-host-death',
  'discover-with-pre-profile-failure',
  'discovery-refusal',
  'identity-changed',
])

/**
 * The fixed discovery-refusal classes the Worker may pre-declare. Each maps to
 * the exact official product classification; the test still performs the real
 * private-file mutation and observes the real Client terminal.
 */
const DISCOVERY_REFUSALS = new Map([
  ['registry-symlink', 'LOCAL_FILE_UNSAFE'],
  ['launch-symlink', 'LOCAL_FILE_UNSAFE'],
  ['forged-instance', 'HOST_IDENTITY_MISMATCH'],
  ['forged-pid', 'HOST_IDENTITY_MISMATCH'],
  ['forged-build', 'HOST_IDENTITY_MISMATCH'],
  ['forged-origin', 'HOST_UNRESPONSIVE'],
  ['unresponsive-dummy-origin', 'HOST_UNRESPONSIVE'],
  ['protocol', 'HOST_PROTOCOL_INCOMPATIBLE'],
  ['wrong-token', 'HOST_AUTH_FAILED'],
  // Darwin: the scope directory is also the qualification-seat directory, so a
  // group/other-accessible scope is a real seat refusal, never a fake mode.
  ['scope-directory', 'SCOPE_DIRECTORY_UNSAFE'],
])

const ENTRY_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL'])

const HOST_ATTEMPT_PATCHES = new Map([
  ['host-runtime-disabled', '- id: split-host-pi-tui-runtime\n  disabled: true\n'],
  ['tui-row-enabled', '- id: tui-app\n  disabled: false\n'],
  ['connection-disabled', '- id: split-host-connection\n  disabled: true\n'],
  ['session-controller-disabled', '- id: split-host-session-controller\n  disabled: true\n'],
  ['workspace-controller-disabled', '- id: workspace-controller\n  disabled: true\n'],
])

/** The bounded set of secret/path fields never carried into a Worker fact. */
const ENTRY_REDACTED_KEYS = new Set([
  'token', 'cookie', 'setCookie', 'authorization', 'connectUrl', 'launch',
  'env', 'environment', 'secret', 'profileRealpath', 'profileDir', 'harnessDir',
  'stack', 'cause',
])

/** The real detached helper processes this Scene owns beyond Host/Client. */
const qualificationHelpers = []
let qualificationHelperSequence = 0
/**
 * The ONE scoped installed-copy mutation of a process Scene, or undefined.
 * It records only what is needed to undo the change this Scene made.
 */
let processInstallationMutation

function entryKindLabel(handle) {
  switch (handle.kind) {
    case 'host-attempt': return 'Host attempt'
    case 'qualification-client': return 'qualification Client'
    case 'bootstrap-cli': return 'installed CLI'
    case 'identity-witness': return 'identity witness'
    default: return 'entry'
  }
}

function findEntryById(entryId, label) {
  if (typeof entryId !== 'string' || entryId === '') {
    throw new Error(`INPUT_UNQUALIFIED: ${label} requires a non-empty entryId`)
  }
  const host = hosts.find(handle => handle.hostId === entryId)
  if (host !== undefined) return host
  const client = qualificationClients.find(handle => handle.entryId === entryId)
  if (client !== undefined) return client
  const helper = qualificationHelpers.find(handle => handle.entryId === entryId)
  if (helper !== undefined) return helper
  throw new Error(`INPUT_UNQUALIFIED: ${label}: unknown entryId ${JSON.stringify(entryId)}`)
}

function findHostAttemptById(entryId, label) {
  const handle = findEntryById(entryId, label)
  if (handle.kind !== undefined && handle.kind !== 'host-attempt') {
    throw new Error(`INPUT_UNQUALIFIED: ${label}: entry ${entryId} is not a Host attempt`)
  }
  return handle
}

function findQualificationClientById(entryId, label) {
  const handle = findEntryById(entryId, label)
  if (handle.kind !== 'qualification-client' && handle.kind !== 'bootstrap-cli' && handle.kind !== 'identity-witness') {
    throw new Error(`INPUT_UNQUALIFIED: ${label}: entry ${entryId} is not a qualification Client`)
  }
  return handle
}

function captureEntryBirth(child, label) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return undefined
  try {
    const observation = readKernelProcess(child.pid)
    return observation.kind === 'alive' ? serializeKernelIdentity(observation.identity) : undefined
  } catch {
    return undefined
  }
}

function publicEntryFacts(handle) {
  const child = handle.child ?? handle.pid
  const pid = typeof child === 'object' ? child?.pid ?? null : child
  return {
    entryId: handle.entryId,
    kind: handle.kind,
    label: handle.label ?? null,
    mode: handle.mode ?? null,
    refusal: handle.refusal ?? null,
    expected: handle.expected ?? null,
    pid: pid ?? null,
    birth: handle.birth ?? null,
    pgid: handle.pgid ?? pid ?? null,
    starttime: handle.starttime ?? null,
    workRoot: handle.workRoot ?? null,
    scratch: handle.scratch ?? null,
    barriers: handle.barriers ?? {},
    signalIntent: handle.signalIntent ?? null,
    coStarted: handle.coStarted ?? null,
    ready: handle.readyRecord === undefined ? undefined : sanitizeEntryRecord(handle.readyRecord).value,
    exited: handle.exited === true,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    finished: handle.finished === true,
    terminal: handle.terminal === undefined ? null : sanitizeEntryRecord(handle.terminal),
    recordCount: handle.records?.length ?? 0,
  }
}

/**
 * Persist the raw stderr of one refused entry as 0600 private evidence inside
 * its own work directory. The receipt carries only the path and markers; raw
 * diagnostics never enter a Worker fact or the Vitest transcript.
 */
function writeEntryStderrEvidence(directory, text, label) {
  if (typeof directory !== 'string' || directory === '' || text === '') return undefined
  const path = join(directory, `${label}-stderr.log`)
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function syncQualificationHelpersReceipt() {
  writeReceipt({ qualificationHelpers: qualificationHelpers.map(publicEntryFacts) })
}

function sanitizeEntryRecord(record) {
  const walk = (value, depth) => {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') {
      if (typeof scene?.installation?.profileDir === 'string' && value.includes(scene.installation.profileDir)) {
        return '[scene-path]'
      }
      const redacted = redactText(value)
      return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…` : redacted
    }
    if (typeof value !== 'object') return value
    if (depth >= 6) return '[depth-limit]'
    if (Array.isArray(value)) return value.slice(0, 200).map(item => walk(item, depth + 1))
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      if (ENTRY_REDACTED_KEYS.has(key)) continue
      result[key] = walk(item, depth + 1)
    }
    if ((value.m4a0 === 'failure' || value.m4a0 === 'control-failure' || value.m4a0 === 'control-error')
      && 'error' in result) {
      // The raw failure text is private Supervisor evidence. Only the one
      // stable business conflict code is a Worker-visible fact.
      if (result.error === 'HOST_ALREADY_OWNED') result.error = 'HOST_ALREADY_OWNED'
      else delete result.error
    }
    return result
  }
  return walk(record, 0)
}

function entryRecordsOf(handle) {
  const records = (handle.records ?? []).map(record => sanitizeEntryRecord(record))
  const stderrMarkers = entryStderrMarkers(handle)
  return {
    entryId: handle.entryId,
    kind: handle.kind,
    mode: handle.mode ?? null,
    exited: handle.exited === true,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    stderrMarkers,
    stderrBytes: (handle.stderrText ?? '').length,
    records,
  }
}

/** The fixed, non-secret stderr observations the qualification modes need. */
function entryStderrMarkers(handle) {
  const text = handle.stderrText ?? ''
  return {
    loaderImportFailed: /split-host-pi-tui-runtime \(@xmoon76\/dsh-pi-tui\/host-runtime\): failed to import/u.test(text),
    moduleNotFound: /ERR_MODULE_NOT_FOUND/u.test(text),
    requiredTuiSurfaceMissing: /required TUI surface did not mount/u.test(text)
      || /required TUI surface did not mount/u.test(handle.outputText ?? ''),
  }
}

function recordMatches(record, match) {
  if (record === null || typeof record !== 'object') return false
  for (const key of ['m4a0', 'm4b2hf', 'requestId', 'phase', 'signal', 'op']) {
    if (match[key] !== undefined && record[key] !== match[key]) return false
  }
  return true
}

/** Strict known-field admission for one new qualification IPC operation. */
function requireKnownFields(message, allowed, label) {
  for (const key of Object.keys(message)) {
    if (key === 'type' || key === 'requestId') continue
    if (!allowed.includes(key)) {
      throw codedInputError('INPUT_UNEXPECTED_FIELD', `${label} rejects the field ${JSON.stringify(key)}`)
    }
  }
}

function requireEntryMatch(match, label) {
  if (match === null || typeof match !== 'object' || Array.isArray(match)) {
    throw new Error(`INPUT_UNQUALIFIED: ${label} requires a record match object`)
  }
  const allowed = new Set(['m4a0', 'm4b2hf', 'requestId', 'phase', 'signal', 'op'])
  const keys = Object.keys(match)
  if (keys.length === 0 || keys.some(key => !allowed.has(key))) {
    throw new Error(`INPUT_UNQUALIFIED: ${label} rejects that record match shape`)
  }
  for (const [key, value] of Object.entries(match)) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`INPUT_UNQUALIFIED: ${label} requires non-empty string ${key}`)
    }
  }
  return match
}

/**
 * Await ONE official record of a registered entry. The wait is close-aware and
 * lifecycle-aware; an unrelated failure/control failure fails immediately so a
 * negative is never decided by the wrong terminal.
 */
async function waitForEntryRecord(handle, match, label, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const record = (handle.records ?? []).find(value => recordMatches(value, match))
    if (record !== undefined) {
      if (record.m4a0 === 'ready') {
        handle.readyRecord = record
        if (handle.kind === 'qualification-client' && handle.mode === 'discover-after-host-death') {
          if (record.host === undefined || record.host === null) {
            throw new Error(`${label}: the discovered Host ready record carries no Host facts`)
          }
          if (activeHost === undefined) registerProcessFallbackHost(handle, record.host, `${label} discovered Host`)
        }
      }
      return sanitizeEntryRecord(record)
    }
    const control = (handle.records ?? []).find(value => value?.m4a0 === 'control-failure' || value?.m4a0 === 'control-error')
    if (control !== undefined) {
      throw new Error(`${label}: the entry reported ${String(control.m4a0)} (code=${String(control.code ?? 'none')}, phase=${String(control.phase ?? 'none')})`)
    }
    const failure = (handle.records ?? []).find(value => value?.m4a0 === 'failure')
    if (failure !== undefined && !recordMatches(failure, match)) {
      throw new Error(`${label}: the entry failed before the awaited record (code=${String(failure.code ?? 'none')}, phase=${String(failure.phase ?? 'none')})`)
    }
    if (handle.spawnError !== undefined) throw new Error(`${label}: the entry spawn failed (${boundedError(handle.spawnError)})`)
    if (handle.exited) throw new Error(`${label}: the entry exited before the awaited record`)
    if (lifecycleClosed) throw new Error(`${label}: the Supervisor lifecycle closed while the record was awaited`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    await sleep(25)
  }
}

/** The exact live-env observation of one registered entry, bounded. */
async function waitForEntryEnvironment(handle, target, label, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (handle.exited) throw new Error(`${label}: the entry exited before its environment could be observed`)
    const present = processEnvironmentContains(handle.child.pid, `SPLIT_PROCESS_SCRATCH=${target}`)
    if (present === true) return
    if (present === false && Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the entry never carried the exact SPLIT_PROCESS_SCRATCH input`)
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the entry environment could not be observed within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

function requireSceneBarrier(raw, name) {
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) {
    throw new Error(`INPUT_UNQUALIFIED: ${name} must be an absolute path`)
  }
  const relativePath = relative(scene.workDir, raw)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`INPUT_UNQUALIFIED: ${name} must be a contained Scene path`)
  }
  // Every caller requires an EXISTING directory. Resolve the real parent
  // before any side effect: a Scene-local symlink alias to the outside is
  // rejected by the canonical containment check without creating anything.
  const parentPath = dirname(raw)
  const parent = realpathSync(parentPath)
  const parentRel = relative(scene.workDir, parent)
  if (parentRel === '..' || parentRel.startsWith(`..${sep}`)) {
    throw new Error(`INPUT_UNQUALIFIED: ${name} must stay inside the Scene root`)
  }
  return { path: raw, parent }
}

function composeExtraPatch(attemptDir, mode) {
  const mutation = HOST_ATTEMPT_PATCHES.get(mode)
  if (mutation === undefined) return undefined
  // Keep the real offline LLM prerequisite and append the row mutation AFTER
  // it, the same overlay order the profile itself applies.
  const base = readFileSync(scene.installation.surfaceLlm.patchPath, 'utf8')
  const path = join(attemptDir, 'entry-mutation.patch.yml')
  writeFileSync(path, `${base.endsWith('\n') ? base : `${base}\n`}${mutation}`, { mode: 0o600 })
  return path
}

function hostAttemptEnv(mode, attemptDir, scratch) {
  const env = {
    ...scene.installation.base.env,
    DSH_PI_TUI_ENTRY_RECORDS: '1',
    SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
    SPLIT_PROCESS_PROFILE: 'pi-tui',
    SPLIT_PROCESS_SCRATCH: scratch,
  }
  const patchPath = composeExtraPatch(attemptDir, mode)
  if (patchPath !== undefined) env.SPLIT_PROCESS_EXTRA_PATCH = patchPath
  if (mode === 'scratch-removal-failure') env.SPLIT_PROCESS_HOST_FORCE_SCRATCH_REMOVE_FAILURE = '1'
  if (mode === 'early-exit') env.SPLIT_PROCESS_HOST_FORCE_EARLY_EXIT = '1'
  return env
}

/** The real installed Host entry of this Scene, independent of a live fault. */
function pristineHostEntry() {
  if (scene?.installFacts?.entries?.host === undefined) {
    throw new Error('the process Scene install facts have no Host entry')
  }
  return realpathSync(scene.installFacts.entries.host)
}

function pristineClientEntry() {
  if (scene?.installFacts?.entries?.client === undefined) {
    throw new Error('the process Scene install facts have no Client entry')
  }
  return realpathSync(scene.installFacts.entries.client)
}

function assertNoOtherUnfinishedHost(label, except) {
  for (const handle of hosts) {
    if (handle === except) continue
    if (!handle.exited) throw new Error(`${label}: Host/attempt ${String(handle.entryId ?? handle.hostId)} is still live`)
    if (handle.finished === true && handle.terminal?.outcome === 'signal') continue
    if (handle.mode !== undefined && handle.acceptedHost !== true) {
      if (handle.finished !== true) {
        throw new Error(`${label}: Host/attempt ${String(handle.entryId)} has not finished its declared terminal contract`)
      }
    } else if (handle.exitResult?.code !== 0 || handle.exitResult?.signal !== null) {
      throw new Error(`${label}: the previous Host generation exited abnormally: ${JSON.stringify(handle.exitResult ?? null)}`)
    }
  }
}

function requirePristineInstalledFacts(label) {
  if (processInstallationMutation !== undefined) {
    throw codedInputError('INPUT_INSTALLATION_MUTATED',
      `${label}: the installed copy is under the registered mutation ${processInstallationMutation.fault}`)
  }
  return assertProcessInstalledFacts(label)
}

async function handleStartHostAttempts(message) {
  requireKnownFields(message, ['mode', 'count', 'scratchTarget', 'signal'], 'START_HOST_ATTEMPTS')
  requireProcessScene('START_HOST_ATTEMPTS')
  assertLifecycleOpen('START_HOST_ATTEMPTS')
  assertNoBootstrapCliPatch('START_HOST_ATTEMPTS')
  const mode = message.mode
  if (!HOST_ATTEMPT_MODES.has(mode)) {
    throw codedInputError('INPUT_HOST_ATTEMPT_MODE', `START_HOST_ATTEMPTS: unknown Host attempt mode ${JSON.stringify(mode)}`)
  }
  if (mode === 'seat-conflict') {
    // The conflict contender is the real negative of the LIVE winner; it is an
    // owned entry, not a new generation, and must not displace the winner.
    requireReadyHost('START_HOST_ATTEMPTS seat-conflict')
  } else {
    if (activeHost !== undefined) throw new Error('START_HOST_ATTEMPTS: an accepted Host is already active')
    assertNoOtherUnfinishedHost('START_HOST_ATTEMPTS')
  }
  const signal = message.signal
  if (mode === 'stop-during-publication' || mode === 'stop-during-initial-liveness') {
    if (!ENTRY_SIGNALS.has(signal) || signal === 'SIGKILL') {
      throw codedInputError('INPUT_HOST_ATTEMPT_SIGNAL', `START_HOST_ATTEMPTS: ${mode} requires SIGTERM or SIGINT`)
    }
  } else if (signal !== undefined) {
    throw codedInputError('INPUT_HOST_ATTEMPT_SIGNAL', `START_HOST_ATTEMPTS: ${mode} does not accept a signal`)
  }
  const faultRequired = mode === 'host-runtime-absent' || mode === 'host-bootstrap-absent'
  if (faultRequired && processInstallationMutation?.fault !== mode) {
    throw codedInputError('INPUT_INSTALLATION_FAULT', `START_HOST_ATTEMPTS: ${mode} requires its registered installation fault`)
  }
  if (!faultRequired && processInstallationMutation !== undefined) {
    throw codedInputError('INPUT_INSTALLATION_MUTATED', `START_HOST_ATTEMPTS: ${mode} is not allowed under a mutated installation`)
  }
  let count = 1
  if (mode === 'seat-race') {
    count = message.count ?? 16
    if (!Number.isInteger(count) || count < 2 || count > 16) {
      throw codedInputError('INPUT_HOST_ATTEMPT_COUNT', 'START_HOST_ATTEMPTS: seat-race count must be 2..16')
    }
  } else if (message.count !== undefined) {
    throw codedInputError('INPUT_HOST_ATTEMPT_COUNT', `START_HOST_ATTEMPTS: ${mode} always starts exactly one contender`)
  }
  let scratchTarget
  if (mode === 'seat-conflict') {
    scratchTarget = requireSceneBarrier(message.scratchTarget, 'scratchTarget').path
    let targetReal
    try {
      targetReal = realpathSync(scratchTarget)
    } catch (error) {
      throw codedInputError('INPUT_HOST_ATTEMPT_SCRATCH', `START_HOST_ATTEMPTS: scratchTarget does not exist (${boundedError(error)})`)
    }
    if (targetReal !== scratchTarget) {
      throw codedInputError('INPUT_HOST_ATTEMPT_SCRATCH', 'START_HOST_ATTEMPTS: scratchTarget must be a canonical path')
    }
    if (!statSync(targetReal).isDirectory()) {
      throw codedInputError('INPUT_HOST_ATTEMPT_SCRATCH', 'START_HOST_ATTEMPTS: scratchTarget must be a directory')
    }
    scratchTarget = targetReal
  } else if (message.scratchTarget !== undefined) {
    throw codedInputError('INPUT_HOST_ATTEMPT_SCRATCH', `START_HOST_ATTEMPTS: ${mode} does not accept a scratchTarget`)
  }

  const pristine = faultRequired ? undefined : requirePristineInstalledFacts('START_HOST_ATTEMPTS')
  const entry = pristineHostEntry()
  const buildId = pristine?.buildId ?? processScope.buildId
  const expectedScopeId = processScope.scopeId
  const attempts = []
  for (let index = 0; index < count; index += 1) {
    const generation = hosts.length + 1
    const label = mode === 'seat-race' ? `seat-contender-${String(index + 1)}` : `host-attempt-${String(generation)}`
    const attemptDir = join(scene.workDir, `host-attempts`, `${String(generation)}-${String(index + 1)}`)
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 })
    const scratch = join(attemptDir, 'scratch')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const env = hostAttemptEnv(mode, attemptDir, scratchTarget ?? scratch)
    const barriers = {}
    if (mode === 'stop-during-publication') {
      barriers.publish = join(attemptDir, 'publication.barrier')
      barriers.stop = join(attemptDir, 'shutdown.barrier')
      env.SPLIT_PROCESS_HOST_PUBLISH_BARRIER = barriers.publish
      env.SPLIT_PROCESS_HOST_STOP_BARRIER = barriers.stop
    }
    if (mode === 'stop-during-initial-liveness') {
      barriers.liveness = join(attemptDir, 'liveness.barrier')
      env.SPLIT_PROCESS_HOST_LIVENESS_BARRIER = barriers.liveness
    }
    if (scratchTarget !== undefined) env.SPLIT_PROCESS_SCRATCH = scratchTarget
    assertLifecycleOpen('START_HOST_ATTEMPTS before spawn')
    const child = spawn(process.execPath, [entry], {
      cwd: scene.installation.base.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const records = []
    const stderr = { text: '' }
    createInterface({ input: child.stdout }).on('line', line => {
      const trimmed = line.trim()
      if (trimmed === '') return
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        stderr.text += `${trimmed}\n`
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (stderr.text.length < 64_000) stderr.text += chunk
    })
    const entryId = `host-attempt-${String(generation)}-${String(child.pid)}-${String(Date.now())}`
    let settleClose
    const closePromise = new Promise(resolve => { settleClose = resolve })
    const handle = {
      entryId,
      hostId: entryId,
      kind: 'host-attempt',
      label,
      mode,
      declaredSignal: signal,
      signalIntent: undefined,
      expected: mode,
      child,
      records,
      get stderrText() { return stderr.text },
      workRoot: attemptDir,
      entryRealpath: entry,
      buildId,
      expectedScopeId,
      generation,
      scratch: scratchTarget ?? scratch,
      barriers,
      startedAt: now(),
      starttime: readHostStarttime(child.pid),
      birth: captureEntryBirth(child, label),
      closePromise,
      closedAt: undefined,
      exited: false,
      exitResult: undefined,
      spawnError: undefined,
      pgid: child.pid ?? null,
      ready: undefined,
      businessPid: null,
      finished: false,
      terminal: undefined,
    }
    hosts.push(handle)
    attempts.push(handle)
    child.once('error', error => {
      handle.spawnError = error
      writeReceipt({ phase: 'ENTRY_SPAWN_ERROR', errorName: boundedError(error), entryId })
    })
    child.once('close', (code, signalValue) => {
      handle.exited = true
      handle.exitResult = { code, signal: signalValue }
      handle.closedAt = now()
      settleClose({ code, signal: signalValue })
      appendNote('host-attempt-closed', {
        entryId,
        pid: child.pid ?? null,
        exitCode: code,
        exitSignal: signalValue,
        recordCount: records.length,
        recordTail: records.slice(-4).map(record => sanitizeEntryRecord(record)),
        stderrMarkers: entryStderrMarkers(handle),
        stderrEvidence: writeEntryStderrEvidence(attemptDir, stderr.text, 'host-attempt'),
      })
      syncHostReceipt()
    })
    appendNote('host-attempt-spawned', {
      entryId,
      mode,
      label,
      generation,
      pid: child.pid ?? null,
      birth: handle.birth ?? null,
      scratch: handle.scratch,
      workerPid: receipt.worker?.pid,
      workerPpid: receipt.worker?.ppid,
    })
    if (handle.birth === undefined) {
      // A spawn that never produced a readable kernel identity cannot later
      // authorize a signal; fail closed and let the normal reclaim own it.
      throw new Error(`START_HOST_ATTEMPTS: ${label} produced no readable kernel identity at spawn`)
    }
  }
  syncHostReceipt()
  writeReceipt({ phase: count > 1 ? 'HOST_CONTENDERS_SPAWNED' : 'HOST_ATTEMPT_SPAWNED' })
  if (mode === 'seat-conflict') {
    await waitForEntryEnvironment(attempts[0], scratchTarget, 'START_HOST_ATTEMPTS')
    attempts[0].observedScratchEnv = scratchTarget
  }
  if (mode === 'seat-race') {
    // The batch spawn is synchronous; read the real kernel liveness right after
    // it so at least two contenders are proven to have actually co-started
    // before any wait. A sequential start loop cannot produce this fact.
    const coStarted = attempts.filter(handle => {
      try {
        return readKernelProcess(handle.child.pid).kind === 'alive'
      } catch {
        return false
      }
    }).length
    for (const handle of attempts) handle.coStarted = coStarted
    appendNote('host-contenders-spawned', {
      count,
      coStarted,
      attempts: attempts.map(handle => ({
        entryId: handle.entryId,
        pid: handle.child.pid,
        birth: handle.birth,
        pgid: handle.pgid,
        workRoot: handle.workRoot,
      })),
    })
    if (coStarted < 2) {
      throw new Error(`START_HOST_ATTEMPTS: only ${String(coStarted)} contender(s) were really alive at the batch boundary`)
    }
  }
  await processProbeHold('host-contenders-spawned', {
    count,
    attempts: attempts.map(handle => ({ entryId: handle.entryId, pid: handle.child.pid, birth: handle.birth })),
  })
  if (mode === 'host-runtime-absent') {
    appendNote('host-artifact-absent-started', {
      entryId: attempts[0].entryId,
      pid: attempts[0].child.pid,
      birth: attempts[0].birth,
      fault: processInstallationMutation?.fault ?? null,
      candidateSha256: processCandidate?.candidateSha256 ?? null,
    })
    writeReceipt({ phase: 'HOST_ARTIFACT_ABSENT_STARTED' })
    await processProbeHold('host-artifact-absent-started', {
      entryId: attempts[0].entryId,
      pid: attempts[0].child.pid,
      birth: attempts[0].birth,
      fault: processInstallationMutation?.fault ?? null,
    })
  }
  return { attempts: attempts.map(publicEntryFacts) }
}

function qualificationClientEnv(mode, clientDir, scratch, barrierPath) {
  const env = {
    ...scene.installation.base.env,
    DSH_PI_TUI_ENTRY_RECORDS: '1',
    SPLIT_PROCESS_CLIENT_MODE: 'qualification',
    SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
    SPLIT_PROCESS_PROFILE: 'pi-tui',
    SPLIT_PROCESS_SCRATCH: scratch,
  }
  if (mode === 'omit-cookie') env.SPLIT_PROCESS_CLIENT_OMIT_COOKIE = '1'
  if (mode === 'startup-fatal') env.SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL = '1'
  if (mode === 'refresh-unresponsive-once') env.SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE = '1'
  if (mode === 'bootstrap-failure') env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE = 'client-bootstrap'
  if (mode === 'discover-with-pre-profile-failure') env.SPLIT_PROCESS_HOST_FORCE_BOOT_FAILURE = 'before-profile'
  if (barrierPath !== undefined) env.SPLIT_PROCESS_HOST_FOUNDATION_BARRIER = barrierPath
  return env
}

function qualificationClientLabel(mode, index) {
  return mode === 'seat-race' ? `qualification-contender-${String(index + 1)}` : `qualification-${mode}`
}

function requireReadyHost(label) {
  const host = activeHost
  if (host === undefined) throw new Error(`${label}: no accepted Host exists in this Scene`)
  if (host.exited || host.child.exitCode !== null || host.child.signalCode !== null
    || !pidAlive(host.child.pid) || !processGroupAlive(hostPgid(host))) {
    throw new Error(`${label}: the accepted Host is not alive`)
  }
  if (host.ready === undefined) throw new Error(`${label}: the accepted Host is not ready`)
  return host
}

/**
 * The Host a qualification Client may attach to: the ONE accepted generation,
 * or the ONE live discovery-fallback Host this Scene registered and verified.
 */
function requireAttachableHost(label) {
  if (activeHost !== undefined) return activeHost
  const candidates = fallbackHosts.filter(record => record.reclaimed !== true)
  if (candidates.length !== 1) {
    throw new Error(`${label}: no accepted Host exists in this Scene`)
  }
  const record = candidates[0]
  let observation
  try {
    observation = readKernelProcess(record.pid)
  } catch (error) {
    throw new Error(`${label}: the discovered Host kernel identity is unreadable (${boundedError(error)})`)
  }
  if (classifyKernelLiveness(observation).state !== 'alive'
    || serializeKernelIdentity(observation.identity) !== record.birth) {
    throw new Error(`${label}: the registered discovered Host is not the live kernel process`)
  }
  if (record.scopeId !== processScope.scopeId) {
    throw new Error(`${label}: the registered discovered Host names another scope`)
  }
  return record
}

function assertDiscoveredStaleHost(label) {
  if (activeHost !== undefined) throw new Error(`${label}: the stale-Host recovery must start without a live Host`)
  const killed = [...hosts].reverse().find(handle => handle.exited && handle.exitResult?.signal === 'SIGKILL')
  if (killed === undefined) {
    throw new Error(`${label}: no real SIGKILLed Host generation provides the stale registry premise`)
  }
  const registry = join(processScope.dir, 'instance.json')
  if (!existsSync(registry)) throw new Error(`${label}: the stale registry does not exist`)
  return killed
}

async function handleStartQualificationClients(message) {
  requireKnownFields(message, ['mode', 'count', 'refusal', 'foundationBarrier'], 'START_QUALIFICATION_CLIENTS')
  requireProcessScene('START_QUALIFICATION_CLIENTS')
  assertLifecycleOpen('START_QUALIFICATION_CLIENTS')
  assertNoBootstrapCliPatch('START_QUALIFICATION_CLIENTS')
  const mode = message.mode
  if (!QUALIFICATION_CLIENT_MODES.has(mode)) {
    throw codedInputError('INPUT_QUALIFICATION_CLIENT_MODE',
      `START_QUALIFICATION_CLIENTS: unknown qualification Client mode ${JSON.stringify(mode)}`)
  }
  let refusal
  if (mode === 'discovery-refusal') {
    refusal = message.refusal
    if (!DISCOVERY_REFUSALS.has(refusal)) {
      throw codedInputError('INPUT_DISCOVERY_REFUSAL',
        `START_QUALIFICATION_CLIENTS: discovery-refusal requires one of ${[...DISCOVERY_REFUSALS.keys()].join(', ')}`)
    }
  } else if (message.refusal !== undefined) {
    throw codedInputError('INPUT_DISCOVERY_REFUSAL', `START_QUALIFICATION_CLIENTS: ${mode} does not accept a refusal class`)
  }
  let count = 1
  if (mode === 'seat-race') {
    if (message.count !== undefined && message.count !== 2) {
      throw codedInputError('INPUT_QUALIFICATION_CLIENT_COUNT', 'START_QUALIFICATION_CLIENTS: seat-race starts exactly two Clients')
    }
    count = 2
  } else if (message.count !== undefined) {
    throw codedInputError('INPUT_QUALIFICATION_CLIENT_COUNT', `START_QUALIFICATION_CLIENTS: ${mode} starts exactly one Client`)
  }
  const discovered = mode === 'discover-after-host-death'
  const preProfile = mode === 'discover-with-pre-profile-failure'
  let expectedBuildId
  if (discovered || preProfile) {
    if (discovered) assertDiscoveredStaleHost('START_QUALIFICATION_CLIENTS')
    else if (activeHost !== undefined) throw new Error('START_QUALIFICATION_CLIENTS: the pre-profile failure requires no live Host')
    expectedBuildId = processScope.buildId
  } else {
    requireAttachableHost('START_QUALIFICATION_CLIENTS')
    if (mode === 'client-bootstrap-drift') {
      if (processInstallationMutation?.fault !== 'client-bootstrap-drift') {
        throw codedInputError('INPUT_INSTALLATION_FAULT',
          'START_QUALIFICATION_CLIENTS: client-bootstrap-drift requires its registered installation fault')
      }
    } else if (processInstallationMutation !== undefined) {
      throw codedInputError('INPUT_INSTALLATION_MUTATED',
        `START_QUALIFICATION_CLIENTS: ${mode} is not allowed under a mutated installation`)
    }
    expectedBuildId = processScope.buildId
  }
  if (message.foundationBarrier !== undefined && message.foundationBarrier !== true) {
    throw codedInputError('INPUT_FOUNDATION_BARRIER', 'START_QUALIFICATION_CLIENTS: foundationBarrier must be the boolean true')
  }
  const clients = []
  for (let index = 0; index < count; index += 1) {
    const sequence = ++qualificationClientSequence
    const clientDir = join(scene.workDir, 'qualification-clients', `${String(sequence)}-${String(index + 1)}`)
    mkdirSync(clientDir, { recursive: true, mode: 0o700 })
    const scratch = join(clientDir, 'scratch')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const barrierPath = message.foundationBarrier === true ? join(clientDir, 'foundation.barrier') : undefined
    const entry = pristineClientEntry()
    assertLifecycleOpen('START_QUALIFICATION_CLIENTS before spawn')
    const child = spawn(process.execPath, [entry], {
      cwd: scene.installation.base.cwd,
      env: qualificationClientEnv(mode, clientDir, scratch, barrierPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const records = []
    const stderr = { text: '' }
    createInterface({ input: child.stdout }).on('line', line => {
      const trimmed = line.trim()
      if (trimmed === '') return
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        stderr.text += `${trimmed}\n`
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (stderr.text.length < 64_000) stderr.text += chunk
    })
    const entryId = `qualification-${mode}-${String(sequence)}-${String(child.pid)}-${String(Date.now())}`
    let settleClose
    const closePromise = new Promise(resolve => { settleClose = resolve })
    const handle = {
      entryId,
      clientId: entryId,
      kind: 'qualification-client',
      label: qualificationClientLabel(mode, index),
      mode,
      refusal,
      expected: mode,
      child,
      records,
      get stderrText() { return stderr.text },
      scratch,
      clientDir,
      barriers: barrierPath === undefined ? {} : { foundation: barrierPath },
      expectedBuildId,
      expectedHostId: discovered ? null : activeHost?.hostId ?? null,
      startedAt: now(),
      starttime: readHostStarttime(child.pid),
      birth: captureEntryBirth(child, 'qualification Client'),
      closePromise,
      closedAt: undefined,
      exited: false,
      exitResult: undefined,
      spawnError: undefined,
      finished: false,
      terminal: undefined,
      signalIntent: undefined,
      recordsSeen: 0,
    }
    qualificationClients.push(handle)
    clients.push(handle)
    child.once('error', error => {
      handle.spawnError = error
      writeReceipt({ phase: 'ENTRY_SPAWN_ERROR', errorName: boundedError(error), entryId })
    })
    child.once('close', (code, signalValue) => {
      handle.exited = true
      handle.exitResult = { code, signal: signalValue }
      handle.closedAt = now()
      settleClose({ code, signal: signalValue })
      appendNote('qualification-client-closed', {
        entryId,
        label: handle.label,
        exitCode: code,
        exitSignal: signalValue,
        recordCount: records.length,
        recordTail: records.slice(-4).map(record => sanitizeEntryRecord(record)),
        stderrMarkers: entryStderrMarkers(handle),
        stderrEvidence: writeEntryStderrEvidence(clientDir, stderr.text, 'qualification-client'),
      })
      syncQualificationClientReceipt()
    })
    appendNote('qualification-client-spawned', {
      entryId,
      mode,
      label: handle.label,
      pid: child.pid ?? null,
      birth: handle.birth ?? null,
      scratch,
      hostId: handle.expectedHostId,
      workerPid: receipt.worker?.pid,
      workerPpid: receipt.worker?.ppid,
    })
    if (handle.birth === undefined) {
      throw new Error(`START_QUALIFICATION_CLIENTS: ${handle.label} produced no readable kernel identity at spawn`)
    }
  }
  syncQualificationClientReceipt()
  writeReceipt({ phase: 'QUALIFICATION_CLIENTS_SPAWNED' })
  await processProbeHold('qualification-client-spawned', {
    count,
    clients: clients.map(handle => ({
      entryId: handle.entryId,
      pid: handle.child.pid,
      birth: handle.birth,
      hostId: handle.expectedHostId,
    })),
  })
  return { clients: clients.map(publicEntryFacts) }
}

async function handleQualificationClientControl(message) {
  requireKnownFields(message, ['entryId', 'control'], 'QUALIFICATION_CLIENT_CONTROL')
  requireProcessScene('QUALIFICATION_CLIENT_CONTROL')
  const handle = findQualificationClientById(message.entryId, 'QUALIFICATION_CLIENT_CONTROL')
  if (handle.kind !== 'qualification-client') {
    throw new Error('QUALIFICATION_CLIENT_CONTROL: the entry is not a qualification Client')
  }
  if (handle.exited) throw new Error('QUALIFICATION_CLIENT_CONTROL: the qualification Client already exited')
  const control = message.control
  if (control === null || typeof control !== 'object' || Array.isArray(control)) {
    throw new Error('INPUT_UNQUALIFIED: QUALIFICATION_CLIENT_CONTROL requires a control object')
  }
  const op = control.op
  if (op !== 'qualification-host-foundation' && op !== 'qualification-drop-websocket') {
    throw codedInputError('INPUT_QUALIFICATION_CONTROL', `QUALIFICATION_CLIENT_CONTROL: unsupported op ${JSON.stringify(op)}`)
  }
  const requestId = control.requestId
  if (typeof requestId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(requestId)) {
    throw codedInputError('INPUT_QUALIFICATION_CONTROL', 'QUALIFICATION_CLIENT_CONTROL requires a business requestId')
  }
  const allowed = new Set(['op', 'requestId', 'workspacePath', 'workspaceResume', 'schedule'])
  for (const key of Object.keys(control)) {
    if (!allowed.has(key)) {
      throw codedInputError('INPUT_QUALIFICATION_CONTROL', `QUALIFICATION_CLIENT_CONTROL rejects the field ${key}`)
    }
  }
  const body = { op, requestId }
  if (op === 'qualification-drop-websocket') {
    if (control.workspacePath !== undefined || control.workspaceResume !== undefined || control.schedule !== undefined) {
      throw codedInputError('INPUT_QUALIFICATION_CONTROL', 'QUALIFICATION_CLIENT_CONTROL: drop-websocket accepts no extra fields')
    }
  }
  if (control.workspacePath !== undefined) {
    const path = requireSceneBarrier(control.workspacePath, 'workspacePath').path
    let real
    try {
      real = realpathSync(path)
    } catch (error) {
      throw codedInputError('INPUT_QUALIFICATION_CONTROL', `QUALIFICATION_CLIENT_CONTROL: workspacePath does not exist (${boundedError(error)})`)
    }
    if (real !== path || !statSync(real).isDirectory()) {
      throw codedInputError('INPUT_QUALIFICATION_CONTROL', 'QUALIFICATION_CLIENT_CONTROL: workspacePath must be a canonical Scene directory')
    }
    body.workspacePath = real
  }
  if (control.workspaceResume !== undefined) {
    if (control.workspaceResume !== true || control.workspacePath === undefined) {
      throw codedInputError('INPUT_QUALIFICATION_CONTROL', 'QUALIFICATION_CLIENT_CONTROL: workspaceResume requires workspacePath and the boolean true')
    }
    body.workspaceResume = true
  }
  if (control.schedule !== undefined) {
    if (control.schedule !== true) {
      throw codedInputError('INPUT_QUALIFICATION_CONTROL', 'QUALIFICATION_CLIENT_CONTROL: schedule must be the boolean true')
    }
    body.schedule = true
  }
  handle.child.stdin.write(`${JSON.stringify(body)}\n`)
  if (op === 'qualification-host-foundation') appendNote('qualification-control-sent', { entryId: handle.entryId, requestId })
  return { sent: true, op, requestId }
}

async function handleQualificationClientStatus(message) {
  requireKnownFields(message, ['entryId'], 'QUALIFICATION_CLIENT_STATUS')
  requireProcessScene('QUALIFICATION_CLIENT_STATUS')
  const handle = findQualificationClientById(message.entryId, 'QUALIFICATION_CLIENT_STATUS')
  if (handle.kind !== 'qualification-client') {
    throw new Error('QUALIFICATION_CLIENT_STATUS: the entry is not a qualification Client')
  }
  if (handle.exited) throw new Error('QUALIFICATION_CLIENT_STATUS: the qualification Client already exited')
  const requestId = `qualification-status-${String(++hostStatusSequence)}`
  handle.child.stdin.write(`${JSON.stringify({ op: 'status', requestId })}\n`)
  const record = await waitForEntryRecord(handle,
    { m4a0: 'status', requestId }, 'QUALIFICATION_CLIENT_STATUS', 60_000)
  return record
}

async function handleSignalEntry(message) {
  requireKnownFields(message, ['entryId', 'signal'], 'SIGNAL_ENTRY')
  requireProcessScene('SIGNAL_ENTRY')
  assertLifecycleOpen('SIGNAL_ENTRY')
  const handle = findEntryById(message.entryId, 'SIGNAL_ENTRY')
  const signal = message.signal
  // A normal process Host generation may declare one real business crash. It is
  // delivered to the Host PID itself, never to the group, after the same exact
  // kernel-identity/group ownership proof every Host signal uses.
  if (hosts.includes(handle) && handle.kind === undefined && handle.crashSignal !== undefined) {
    if (handle.crashSignal !== signal) {
      throw codedInputError('INPUT_ENTRY_SIGNAL',
        `SIGNAL_ENTRY: this Host declared ${String(handle.crashSignal)}, not ${String(signal)}`)
    }
    if (handle.ready === undefined) throw new Error('SIGNAL_ENTRY: the Host is not ready')
    if (handle.exited || handle.child.exitCode !== null || handle.child.signalCode !== null) {
      throw new Error('SIGNAL_ENTRY: the Host already exited')
    }
    if (handle.signalIntent !== undefined) throw new Error('SIGNAL_ENTRY: the Host already received its declared crash signal')
    assertProcessHostSignalOwnership(handle, `SIGNAL_ENTRY ${signal}`)
    processFallbackScratchBaseline = readdirSync(processScope.dir).filter(name => name.startsWith('host-scratch-'))
    try {
      process.kill(handle.child.pid, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw new Error(`SIGNAL_ENTRY: the owned Host PID ${String(handle.child.pid)} could not be signalled (${String(error?.code ?? 'unknown')})`)
      }
    }
    handle.signalIntent = signal
    appendNote('host-business-crash-signalled', {
      entryId: handle.hostId,
      pid: handle.child.pid,
      birth: handle.birth,
      signal,
      target: 'host-pid',
    })
    writeReceipt({})
    return { entryId: handle.hostId, signal, pid: handle.child.pid, birth: handle.birth, target: 'host-pid' }
  }
  if (!ENTRY_SIGNALS.has(signal)) {
    throw codedInputError('INPUT_ENTRY_SIGNAL', `SIGNAL_ENTRY: unsupported signal ${JSON.stringify(signal)}`)
  }
  if (handle.exited) throw new Error('SIGNAL_ENTRY: the entry already exited')
  if (handle.birth === undefined) throw new Error('SIGNAL_ENTRY: the entry has no captured kernel birth')
  if (handle.declaredSignal !== undefined && handle.declaredSignal !== signal) {
    throw codedInputError('INPUT_ENTRY_SIGNAL',
      `SIGNAL_ENTRY: the Host attempt declared ${String(handle.declaredSignal)}, not ${String(signal)}`)
  }
  if (handle.declaredSignal === undefined && handle.kind === 'host-attempt') {
    throw codedInputError('INPUT_ENTRY_SIGNAL', 'SIGNAL_ENTRY: this Host attempt declared no stop signal')
  }
  if (handle.kind === 'qualification-client' && handle.mode !== 'attach') {
    throw codedInputError('INPUT_ENTRY_SIGNAL',
      `SIGNAL_ENTRY: qualification Client mode ${String(handle.mode)} has a declared non-signal terminal`)
  }
  if (handle.kind === 'bootstrap-cli' || handle.kind === 'identity-witness') {
    throw codedInputError('INPUT_ENTRY_SIGNAL', `SIGNAL_ENTRY: ${entryKindLabel(handle)} is not a signal target`)
  }
  if (handle.signalIntent !== undefined && handle.signalIntent !== signal) {
    throw new Error(`SIGNAL_ENTRY: the entry already declared ${String(handle.signalIntent)}`)
  }
  assertKernelGroupSignalOwnership(processKernelReaders(), handle.child.pid, handle.birth, `SIGNAL_ENTRY ${signal}`)
  handle.signalIntent = signal
  try {
    process.kill(-handle.child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw new Error(`SIGNAL_ENTRY: the owned entry group ${String(handle.child.pid)} could not be signalled (${String(error?.code ?? 'unknown')})`)
    }
  }
  appendNote('entry-signalled', {
    entryId: handle.entryId,
    kind: handle.kind,
    mode: handle.mode ?? null,
    pid: handle.child.pid,
    birth: handle.birth,
    signal,
  })
  writeReceipt({})
  return { entryId: handle.entryId, signal, pid: handle.child.pid, birth: handle.birth }
}

async function validateHostAttemptTerminal(handle, exit) {
  const label = `FINISH_ENTRY ${handle.label ?? handle.entryId}`
  const ready = (handle.records ?? []).find(record => record?.m4a0 === 'ready')
  const failure = (handle.records ?? []).find(record => record?.m4a0 === 'failure')
  const conflict = (handle.records ?? []).find(record => record?.m4a0 === 'host-seat-conflict')
  const cleanupCompleted = (handle.records ?? []).filter(record => record?.m4a0 === 'cleanup' && record.status === 'completed')
  const cleanupFailures = (handle.records ?? []).filter(record => record?.m4a0 === 'cleanup-failure')
  const stopRequests = (handle.records ?? []).filter(record => record?.m4a0 === 'stop-requested')
  const repeatIgnored = (handle.records ?? []).filter(record => record?.m4a0 === 'stop-repeat-ignored')
  const mode = handle.mode
  const expect = (condition, message) => {
    if (!condition) throw new Error(`${label}: ${message}; exit=${JSON.stringify(exit)}`)
  }
  if (mode === undefined) {
    if (handle.signalIntent === 'SIGKILL') {
      expect(exit.code === null && exit.signal === 'SIGKILL', 'the exact owned Host group was not killed by SIGKILL')
      return { outcome: 'signal', signal: 'SIGKILL', readyEmitted: ready !== undefined }
    }
    if (handle.signalIntent === 'SIGTERM') {
      expect(exit.code === 0 && exit.signal === null, 'a SIGTERM Host must exit 0 with no signal')
      expect(failure === undefined, 'a SIGTERM Host reported a failure record')
      return { outcome: 'signal', signal: 'SIGTERM', readyEmitted: ready !== undefined }
    }
    expect(exit.code === 0 && exit.signal === null, 'the normal Host did not exit 0 with no signal')
    return { outcome: 'normal-exit', readyEmitted: ready !== undefined }
  }
  if (mode === 'seat-race' || mode === 'seat-conflict') {
    if (handle.readyRecord !== undefined || ready !== undefined) {
      throw new Error(`${label}: a seat contender reached Ready; it must be accepted through ACCEPT_HOST_WINNER`)
    }
    expect(exit.code === 0 && exit.signal === null, 'a seat conflict must exit 0 with no signal')
    expect(conflict !== undefined && conflict.error === 'HOST_ALREADY_OWNED', 'the seat-conflict record is missing or names another refusal')
    expect(failure === undefined, 'a seat conflict must not report a failure record')
    return { outcome: 'seat-conflict', conflictError: conflict.error, readyEmitted: false }
  }
  if (mode === 'scratch-removal-failure') {
    expect(ready !== undefined, 'the faulted attempt never reached Ready, so its shutdown cleanup is not the declared contract')
    expect(exit.code === 1 && exit.signal === null, 'a failed scratch cleanup must exit 1 with no signal')
    const scratchFailure = cleanupFailures.find(record => record.step === 'scratch-remove')
    expect(scratchFailure !== undefined, 'no cleanup-failure record names the scratch-remove step')
    expect(cleanupCompleted.length === 0, 'a failed scratch cleanup must not claim a completed cleanup')
    expect(ready.services?.piTuiHostReady === true, 'the ready attempt did not own the private Host Runtime service')
    return {
      outcome: 'cleanup-failure',
      step: scratchFailure.step,
      cleanupFailureCount: cleanupFailures.length,
      readyEmitted: true,
    }
  }
  if (mode === 'stop-during-publication' || mode === 'stop-during-initial-liveness') {
    const expectedCode = handle.signalIntent === 'SIGINT' ? 130 : 0
    expect(exit.code === expectedCode && exit.signal === null,
      `a ${String(handle.signalIntent)} stop must exit ${String(expectedCode)} with no signal`)
    expect(ready === undefined, 'a stopped qualification Host must never emit Ready')
    expect(failure === undefined, 'a stop-requested Host must not report a failure record')
    expect(stopRequests.length === 1, 'exactly one stop-requested record is required')
    expect(cleanupCompleted.length === 1, 'exactly one completed cleanup record is required')
    if (mode === 'stop-during-publication') {
      expect(repeatIgnored.length === 2, 'the repeated publication/shutdown signals were not both admitted and ignored')
      const phases = repeatIgnored.map(record => record.phase).sort()
      expect(phases[0] === 'publication' && phases[1] === 'shutdown', `the repeated signals did not cover both windows: ${JSON.stringify(phases)}`)
    }
    return {
      outcome: 'signal-stop',
      signal: handle.signalIntent,
      stopRequested: stopRequests.length,
      repeatIgnored: repeatIgnored.length,
      readyEmitted: false,
    }
  }
  if (mode === 'early-exit') {
    expect(exit.code === 1 && exit.signal === null, 'the forced early exit must exit 1 with no signal')
    expect(ready === undefined, 'the forced early exit emitted Ready')
    expect(failure === undefined, 'the synchronous forced exit must not be rewritten as a reported failure')
    return { outcome: 'early-exit', readyEmitted: false }
  }
  // Every remaining attempt mode is a declared startup refusal.
  expect(exit.code === 1 && exit.signal === null, 'a refused Host startup must exit 1 with no signal')
  expect(ready === undefined, 'a refused Host startup emitted Ready')
  expect(failure !== undefined, 'a refused Host startup reported no official failure record')
  expect(failure.services?.piTuiHostReady !== true, 'a refused Host startup published piTuiHostReady')
  const errorText = String(failure.error ?? '')
  if (mode === 'host-runtime-disabled') {
    expect(/expected exactly one active piTuiHostRuntime owner row, found 0/u.test(errorText), 'the real product failure did not match its declared startup class')
  } else if (mode === 'tui-row-enabled') {
    expect(/forbidden TUI\/Client-UI rows are (?:active|not disabled): tui-app/u.test(errorText), 'the real product failure did not match its declared startup class')
  } else if (mode === 'connection-disabled') {
    expect(/connection owner row, found 0/u.test(errorText), 'the real product failure did not match its declared startup class')
  } else if (mode === 'session-controller-disabled') {
    expect(/sessionController owner row, found 0/u.test(errorText), 'the real product failure did not match its declared startup class')
  } else if (mode === 'workspace-controller-disabled') {
    expect(/expected exactly one active workspaceController owner row, found 0/u.test(errorText), 'the real product failure did not match its declared startup class')
    expect(failure.services?.workspaceController !== true, 'the refused Host reported a live workspaceController service')
  } else if (mode === 'host-runtime-absent') {
    expect(/expected exactly one active piTuiHostRuntime owner row, found 0/u.test(errorText), 'the real product failure did not match its declared startup class')
    const markers = entryStderrMarkers(handle)
    expect(markers.loaderImportFailed && markers.moduleNotFound,
      'the real Loader module-absence markers are missing from the Host stderr')
  } else if (mode === 'host-bootstrap-absent') {
    expect(failure.phase === 'after-boot', `expected an after-boot failure, got ${String(failure.phase)}`)
    expect(cleanupCompleted.length === 1, 'the missing bootstrap chunk did not produce one completed cleanup')
    expect(cleanupFailures.length === 0, 'the missing bootstrap chunk reported an unexpected cleanup failure')
  } else {
    throw new Error(`${label}: no terminal contract is implemented for mode ${String(mode)}`)
  }
  return {
    outcome: 'startup-refusal',
    mode,
    errorClass: 'declared-startup-refusal',
    code: failure.code ?? null,
    phase: failure.phase ?? null,
    cleanupCompleted: cleanupCompleted.length,
    stderrMarkers: entryStderrMarkers(handle),
  }
}

const QUALIFICATION_SUCCESS_MODES = new Set([
  'attach',
  'refresh-unresponsive-once',
  'client-bootstrap-drift',
  'discover-after-host-death',
])

async function validateQualificationClientTerminal(handle, exit) {
  const label = `FINISH_ENTRY ${handle.label}`
  const ready = (handle.records ?? []).find(record => record?.m4a0 === 'ready')
  const failure = (handle.records ?? []).find(record => record?.m4a0 === 'failure')
  const cleanupCompleted = (handle.records ?? []).filter(record => record?.m4a0 === 'cleanup' && record.status === 'completed')
  const cleanupFailures = (handle.records ?? []).filter(record => record?.m4a0 === 'cleanup-failure')
  const expect = (condition, message) => {
    if (!condition) throw new Error(`${label}: ${message}; exit=${JSON.stringify(exit)}`)
  }
  const signalIntent = handle.signalIntent
  if (signalIntent === 'SIGKILL') {
    expect(exit.code === null && exit.signal === 'SIGKILL', 'the exact owned Client group was not killed by SIGKILL')
    return { outcome: 'signal', signal: 'SIGKILL', readyEmitted: ready !== undefined }
  }
  if (signalIntent === 'SIGTERM') {
    expect(exit.code === 0 && exit.signal === null, 'a SIGTERM qualification Client must exit 0 with no signal')
    expect(failure === undefined, 'a SIGTERM qualification Client reported a failure record')
    return { outcome: 'signal', signal: 'SIGTERM', readyEmitted: ready !== undefined }
  }
  const mode = handle.mode
  if (mode === 'seat-race') {
    if (failure !== undefined) {
      expect(exit.code === 1 && exit.signal === null, 'the qualification seat loser must exit 1 with no signal')
      expect(failure.code === 'CLIENT_ALREADY_ACTIVE',
        `the qualification seat loser reported code=${String(failure.code ?? 'none')} phase=${String(failure.phase ?? 'none')}`)
      return { outcome: 'startup-refusal', mode, code: failure.code, readyEmitted: false }
    }
    expect(ready !== undefined, 'the qualification seat winner never reached Ready')
    expect(exit.code === 0 && exit.signal === null, 'the qualification seat winner did not exit 0 with no signal')
    return { outcome: 'normal-exit', readyEmitted: true, generationId: ready.generationId ?? null }
  }
  if (QUALIFICATION_SUCCESS_MODES.has(mode)) {
    expect(exit.code === 0 && exit.signal === null, 'the live qualification Client did not exit 0 with no signal')
    expect(failure === undefined, 'the live qualification Client reported a failure record')
    if (mode === 'client-bootstrap-drift' || mode === 'refresh-unresponsive-once'
      || mode === 'attach' || mode === 'discover-after-host-death') {
      expect(ready !== undefined, 'the successful qualification Client never reached Ready')
    }
    return { outcome: 'normal-exit', readyEmitted: ready !== undefined, generationId: ready?.generationId ?? null }
  }
  if (mode === 'identity-changed') {
    expect(ready !== undefined, 'the identity-changed Client never reached its first Ready')
    expect(exit.code === 1 && exit.signal === null, 'a fatal identity change must exit 1 with no signal')
    expect(failure !== undefined && failure.code === 'HOST_IDENTITY_MISMATCH',
      `the identity change was not classified as HOST_IDENTITY_MISMATCH (code=${String(failure?.code ?? 'none')}, phase=${String(failure?.phase ?? 'none')})`)
    expect(cleanupCompleted.length === 1, 'the fatal identity change did not report one completed cleanup')
    expect(cleanupFailures.length === 0, 'the fatal identity change reported an unexpected cleanup failure')
    return { outcome: 'startup-refusal', code: failure.code, readyEmitted: true, cleanupCompleted: 1 }
  }
  if (mode === 'bootstrap-failure') {
    expect(exit.code === 1 && exit.signal === null, 'the after-context bootstrap failure must exit 1 with no signal')
    expect(failure !== undefined && failure.phase === 'after-context',
      `the client-bootstrap failure was not an after-context failure (phase=${String(failure?.phase)})`)
    expect(cleanupCompleted.length === 1, 'the after-context failure did not report one completed cleanup')
    expect(cleanupFailures.length === 0, 'the after-context failure reported an unexpected cleanup failure')
    expect(failure.activeWrappers === 0 && failure.liveSockets === 0,
      `the after-context failure retained transport resources (activeWrappers=${String(failure.activeWrappers)}, liveSockets=${String(failure.liveSockets)})`)
    return { outcome: 'startup-refusal', code: failure.code ?? null, phase: failure.phase, readyEmitted: false }
  }
  // Every remaining mode is a declared official Client refusal.
  expect(ready === undefined, 'a refused qualification Client emitted Ready')
  expect(exit.code === 1 && exit.signal === null, 'a refused qualification Client must exit 1 with no signal')
  expect(failure !== undefined, 'a refused qualification Client reported no official failure record')
  let expectedCode
  if (mode === 'omit-cookie') expectedCode = 'HOST_UNRESPONSIVE'
  else if (mode === 'startup-fatal') expectedCode = 'HOST_IDENTITY_MISMATCH'
  else if (mode === 'discover-with-pre-profile-failure') expectedCode = 'HOST_START_TIMEOUT'
  else if (mode === 'discovery-refusal') expectedCode = DISCOVERY_REFUSALS.get(handle.refusal)
  else throw new Error(`${label}: no terminal contract is implemented for mode ${String(mode)}`)
  expect(failure.code === expectedCode,
    `expected ${String(expectedCode)} but the Client reported code=${String(failure.code ?? 'none')} phase=${String(failure.phase ?? 'none')}`)
  return {
    outcome: 'startup-refusal',
    mode,
    refusal: handle.refusal ?? null,
    code: failure.code,
    phase: failure.phase ?? null,
    cleanupCompleted: cleanupCompleted.length,
    cleanupFailureCount: cleanupFailures.length,
    readyEmitted: false,
  }
}

async function finishHostAttempt(handle) {
  if (handle.signalIntent !== undefined) return await waitForEntryClose(handle, 'FINISH_ENTRY')
  if (handle.mode === 'scratch-removal-failure') {
    // The faulted Host is expected to become Ready and then fail its own
    // shutdown cleanup; drive the official shutdown only after the real Ready
    // record exists.
    await waitForEntryRecord(handle, { m4a0: 'ready' }, 'FINISH_ENTRY scratch-removal-ready', 180_000)
    handle.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
  } else if (handle.mode === 'seat-race' && handle.readyRecord !== undefined) {
    throw new Error('FINISH_ENTRY: a seat winner must be accepted through ACCEPT_HOST_WINNER')
  }
  return await waitForEntryClose(handle, 'FINISH_ENTRY')
}

async function finishQualificationClient(handle) {
  if (handle.signalIntent !== undefined) return await waitForEntryClose(handle, 'FINISH_ENTRY')
  if (handle.mode === 'identity-changed') return await waitForEntryClose(handle, 'FINISH_ENTRY')
  const ready = (handle.records ?? []).some(record => record?.m4a0 === 'ready')
  if (ready && !handle.exited && handle.child.exitCode === null && handle.child.signalCode === null) {
    // The one-shot qualification Client owns the official stdin shutdown op.
    handle.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
  }
  return await waitForEntryClose(handle, 'FINISH_ENTRY')
}

async function handleFinishEntry(message) {
  requireKnownFields(message, ['entryId'], 'FINISH_ENTRY')
  requireProcessScene('FINISH_ENTRY')
  assertLifecycleOpen('FINISH_ENTRY')
  const handle = findEntryById(message.entryId, 'FINISH_ENTRY')
  if (handle.finished) {
    return handle.terminal ?? { entryId: handle.entryId, outcome: 'already-finished' }
  }
  let exit
  const isHostEntry = hosts.includes(handle)
  if (isHostEntry && handle.kind === undefined && handle.crashSignal !== undefined) {
    if (handle.signalIntent !== handle.crashSignal) {
      throw new Error(`FINISH_ENTRY: the Host did not receive its declared ${String(handle.crashSignal)} crash signal`)
    }
    exit = await finishHostAttempt(handle)
    await assertHostGroupGone(handle, `FINISH_ENTRY ${handle.label ?? handle.hostId}`)
    if (exit.code !== null || exit.signal !== handle.crashSignal) {
      throw new Error(`FINISH_ENTRY: the declared Host crash was not ${JSON.stringify({
        code: null,
        signal: handle.crashSignal,
      })}; actual=${JSON.stringify(exit)}`)
    }
    if (handle.ready === undefined) throw new Error('FINISH_ENTRY: a crashed Host never reached Ready')
    if (activeHost === handle) activeHost = undefined
    const liveOthers = hosts.some(other => other !== handle && !other.exited)
    if (!liveOthers) await assertSceneHostSeatFree(`FINISH_ENTRY ${handle.hostId}`)
    handle.finished = true
    handle.terminal = {
      outcome: 'business-crash',
      signal: handle.crashSignal,
      readyEmitted: true,
      hostPid: handle.child.pid,
      hostBirth: handle.birth ?? null,
      entryId: handle.hostId,
      kind: 'host',
      mode: null,
      exit: { code: exit.code, signal: exit.signal },
      records: entryRecordsOf(handle).records,
      stderrMarkers: entryStderrMarkers(handle),
    }
    syncHostReceipt()
    writeReceipt({ phase: 'ENTRY_FINISHED' })
    return handle.terminal
  }
  if (isHostEntry) exit = await finishHostAttempt(handle)
  else if (handle.kind === 'qualification-client') exit = await finishQualificationClient(handle)
  else throw new Error(`FINISH_ENTRY: ${entryKindLabel(handle)} does not use finishEntry`)
  await assertHostGroupGone(handle, `FINISH_ENTRY ${handle.label ?? handle.hostId ?? handle.entryId}`)
  const terminal = isHostEntry
    ? await validateHostAttemptTerminal(handle, exit)
    : await validateQualificationClientTerminal(handle, exit)
  if (handle === activeHost) activeHost = undefined
  if (isHostEntry && handle.readyRecord !== undefined && terminal.outcome === 'startup-refusal') {
    throw new Error('FINISH_ENTRY: a ready attempt cannot be accepted as a refusal')
  }
  if (handle.kind === 'qualification-client') {
    const liveOthers = qualificationClients.some(other => other !== handle && !other.exited)
    if (!liveOthers) await assertClientSeatFree(scene.installation, processScope.scopeId, 'FINISH_ENTRY')
  } else {
    const liveOthers = hosts.some(other => other !== handle && !other.exited)
    if (!liveOthers) await assertSceneHostSeatFree('FINISH_ENTRY')
  }
  handle.finished = true
  handle.terminal = {
    ...terminal,
    entryId: handle.entryId,
    kind: handle.kind,
    mode: handle.mode ?? null,
    exit: { code: exit.code, signal: exit.signal },
    records: entryRecordsOf(handle).records,
    stderrMarkers: entryStderrMarkers(handle),
  }
  if (handle.kind === 'qualification-client') syncQualificationClientReceipt()
  else syncHostReceipt()
  writeReceipt({ phase: 'ENTRY_FINISHED' })
  return handle.terminal
}

async function handleAcceptHostWinner(message) {
  requireKnownFields(message, ['entryId'], 'ACCEPT_HOST_WINNER')
  requireProcessScene('ACCEPT_HOST_WINNER')
  assertLifecycleOpen('ACCEPT_HOST_WINNER')
  const handle = findHostAttemptById(message.entryId, 'ACCEPT_HOST_WINNER')
  if (handle.mode !== 'seat-race') throw new Error('ACCEPT_HOST_WINNER: only a seat-race contender can be accepted')
  if (activeHost !== undefined) throw new Error('ACCEPT_HOST_WINNER: a Host is already active')
  handle.readyRecord = handle.readyRecord ?? (handle.records ?? []).find(record => record?.m4a0 === 'ready')
  if (handle.readyRecord === undefined) throw new Error('ACCEPT_HOST_WINNER: the contender has no ready record')
  if (handle.exited) throw new Error('ACCEPT_HOST_WINNER: the contender is not live')
  const localHost = handle.readyRecord.localHost
  if (localHost === undefined || localHost === null) throw new Error('ACCEPT_HOST_WINNER: the ready record carries no Host identity')
  if (localHost.buildId !== handle.buildId) {
    throw new Error(`ACCEPT_HOST_WINNER: the ready build ${String(localHost.buildId)} is not the installed ${String(handle.buildId)}`)
  }
  if (localHost.scopeId !== handle.expectedScopeId) {
    throw new Error('ACCEPT_HOST_WINNER: the ready Host published another scope')
  }
  assertHostIdentityMatchesKernel(localHost, handle.child.pid, 'ACCEPT_HOST_WINNER')
  if (!pidAlive(handle.child.pid) || !processGroupAlive(hostPgid(handle))) {
    throw new Error('ACCEPT_HOST_WINNER: the ready contender is not alive')
  }
  const winners = hosts.filter(candidate => candidate.readyRecord !== undefined)
  if (winners.length !== 1 || winners[0] !== handle) {
    throw new Error(`ACCEPT_HOST_WINNER: ${String(winners.length)} contenders reached Ready; exactly one is required`)
  }
  const liveOthers = hosts.filter(candidate => candidate !== handle && !candidate.exited)
  if (liveOthers.length > 0) {
    throw new Error('ACCEPT_HOST_WINNER: a non-winner contender is still live')
  }
  for (const candidate of hosts) {
    if (candidate === handle) continue
    if (candidate.finished !== true) {
      throw new Error(`ACCEPT_HOST_WINNER: contender ${String(candidate.entryId)} has not finished its declared conflict terminal`)
    }
    if (candidate.terminal?.outcome !== 'seat-conflict') {
      throw new Error(`ACCEPT_HOST_WINNER: contender ${String(candidate.entryId)} did not report a seat conflict`)
    }
  }
  handle.ready = handle.readyRecord
  handle.businessPid = handle.readyRecord.localHost.hostPid ?? null
  handle.acceptedHost = true
  activeHost = handle

  syncHostReceipt()
  writeReceipt({ phase: 'HOST_READY' })
  return {
    hostId: handle.hostId,
    entryId: handle.entryId,
    generation: handle.generation,
    ready: handle.readyRecord,
    workRoot: handle.workRoot,
    source: 'profile',
    buildId: handle.buildId,
    scopeId: handle.expectedScopeId,
    pgid: hostPgid(handle),
    entryRealpath: handle.entryRealpath,
  }
}

async function handleEntryRecords(message) {
  requireKnownFields(message, ['entryId'], 'ENTRY_RECORDS')
  requireProcessScene('ENTRY_RECORDS')
  const handle = findEntryById(message.entryId, 'ENTRY_RECORDS')
  const facts = entryRecordsOf(handle)
  // Re-reading a closed entry is the complete ledger fact; a live entry's
  // records are only a current snapshot and this operation never waits.
  return facts
}

async function handleWaitEntryRecord(message) {
  requireKnownFields(message, ['entryId', 'match', 'timeoutMs'], 'WAIT_ENTRY_RECORD')
  requireProcessScene('WAIT_ENTRY_RECORD')
  const handle = findEntryById(message.entryId, 'WAIT_ENTRY_RECORD')
  const match = requireEntryMatch(message.match, 'WAIT_ENTRY_RECORD')
  const timeoutMs = message.timeoutMs ?? 180_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw codedInputError('INPUT_WAIT_BOUND', 'WAIT_ENTRY_RECORD timeoutMs must be 1..600000')
  }
  const record = await waitForEntryRecord(handle, match, `WAIT_ENTRY_RECORD ${handle.label ?? handle.entryId}`, timeoutMs)
  syncHostReceipt()
  syncQualificationClientReceipt()
  return record
}

const BOOTSTRAP_CLI_MODES = new Set(['inherited-host-role', 'direct-help'])
const IDENTITY_WITNESS_KINDS = new Set(['live-non-host', 'linux-zombie'])

/** Mutation admission: no live Client/helper/fallback may consume the target. */
async function assertNoLiveMutationConsumers({ allowStableHost, label }) {
  const stableHost = allowStableHost ? activeHost : undefined
  if (!allowStableHost && activeHost !== undefined) {
    throw new Error(`${label}: a live Host still consumes the installed copy`)
  }
  for (const handle of hosts) {
    if (handle === stableHost) continue
    if (!handle.exited) throw new Error(`${label}: a Host attempt is still live`)
    await assertHostGroupGone(handle, label)
  }
  for (const handle of qualificationClients) {
    if (!handle.exited || handle.finished !== true) {
      throw new Error(`${label}: a qualification Client is not terminal`)
    }
    await assertHostGroupGone(handle, label)
  }
  for (const handle of qualificationHelpers) {
    if (!handle.exited || handle.finished !== true) {
      throw new Error(`${label}: a qualification helper is not terminal`)
    }
    await assertHostGroupGone(handle, label)
  }
  if (processClients.some(client => !client.closed)) {
    throw new Error(`${label}: a process Client is still live`)
  }
  if (processClients.length > 0) await auditProcessClientLedger(label)
  if (fallbackHosts.some(record => record.reclaimed !== true)) {
    throw new Error(`${label}: a discovered Host fallback is still live`)
  }
  // Refuse before returning permission to perform the synchronous side effect.
  assertLifecycleOpen(label)
}

function installedChunk(prefix) {
  const packageRoot = realpathSync(scene.installation.profilePackage)
  const file = readdirSync(join(packageRoot, 'dist')).find(name => name.startsWith(prefix) && name.endsWith('.mjs'))
  if (file === undefined) throw new Error(`the installed package has no ${prefix} chunk`)
  return join(packageRoot, 'dist', file)
}

function registerHelperHandle({ entryId, kind, label, child, dir, extra = {} }) {
  const records = []
  const stderr = { text: '' }
  if (child.stdout !== null) {
    createInterface({ input: child.stdout }).on('line', line => {
      const trimmed = line.trim()
      if (trimmed === '') return
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        stderr.text += `${trimmed}\n`
      }
    })
  }
  if (child.stderr !== null) {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (stderr.text.length < 64_000) stderr.text += chunk
    })
  }
  let settleClose
  const closePromise = new Promise(resolve => { settleClose = resolve })
  const handle = {
    entryId,
    kind,
    label,
    child,
    records,
    get stderrText() { return stderr.text },
    get outputText() { return handle.rawOutput ?? '' },
    dir,
    startedAt: now(),
    starttime: readHostStarttime(child.pid),
    birth: captureEntryBirth(child, label),
    pgid: child.pid ?? null,
    closePromise,
    exited: false,
    exitResult: undefined,
    closedAt: undefined,
    finished: false,
    terminal: undefined,
    ...extra,
  }
  qualificationHelpers.push(handle)
  child.once('error', error => {
    handle.spawnError = error
    writeReceipt({ phase: 'ENTRY_SPAWN_ERROR', errorName: boundedError(error), entryId })
  })
  child.once('close', (code, signalValue) => {
    handle.exited = true
    handle.exitResult = { code, signal: signalValue }
    handle.closedAt = now()
    settleClose({ code, signal: signalValue })
    syncQualificationHelpersReceipt()
  })
  syncQualificationHelpersReceipt()
  return handle
}

async function runTrackedOnce(invocation, args, cwd, env, label, timeoutMs) {
  const child = spawn(invocation[0], [...invocation.slice(1), ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const entryId = `installed-cli-${String(++qualificationHelperSequence)}-${String(child.pid)}-${String(Date.now())}`
  const handle = registerHelperHandle({ entryId, kind: 'bootstrap-cli', label, child, dir: cwd })
  const output = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { if (output.stdout.length < 64_000) output.stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { if (output.stderr.length < 64_000) output.stderr += chunk })
  const exit = await waitForEntryClose(handle, label, timeoutMs)
  handle.rawOutput = `${output.stdout}\n${output.stderr}`
  await assertHostGroupGone(handle, label)
  handle.finished = true
  handle.terminal = {
    outcome: 'cli',
    exit: { code: exit.code, signal: exit.signal },
    markers: entryStderrMarkers(handle),
    stdoutBytes: output.stdout.length,
    stderrBytes: output.stderr.length,
  }
  syncQualificationHelpersReceipt()
  return handle
}

function assertNoBootstrapCliPatch(label) {
  if (processBootstrapCliPatch !== undefined) {
    throw codedInputError('INPUT_INSTALLATION_MUTATED', `${label}: an inherited profile patch is still unresolved`)
  }
}

async function handleRunBootstrapCli(message) {
  requireKnownFields(message, ['mode'], 'RUN_BOOTSTRAP_CLI')
  requireProcessScene('RUN_BOOTSTRAP_CLI')
  assertLifecycleOpen('RUN_BOOTSTRAP_CLI')
  const mode = message.mode
  if (!BOOTSTRAP_CLI_MODES.has(mode)) {
    throw codedInputError('INPUT_BOOTSTRAP_CLI_MODE', `RUN_BOOTSTRAP_CLI: unknown mode ${JSON.stringify(mode)}`)
  }
  if (processInstallationMutation !== undefined) {
    throw codedInputError('INPUT_INSTALLATION_MUTATED', 'RUN_BOOTSTRAP_CLI is not allowed under a mutated installation')
  }
  assertNoBootstrapCliPatch('RUN_BOOTSTRAP_CLI')
  const installation = scene.installation
  const profilePatchPath = join(installation.profileDir, 'cordis.patch.yml')
  let response
  if (mode === 'inherited-host-role') {
    await assertNoLiveMutationConsumers({ allowStableHost: false, label: 'RUN_BOOTSTRAP_CLI inherited-host-role' })
    const helpersBefore = qualificationHelpers.length
    let primaryError
    const previous = existsSync(profilePatchPath)
      ? { bytes: readFileSync(profilePatchPath), mode: statSync(profilePatchPath).mode & 0o777 }
      : undefined
    processBootstrapCliPatch = { path: profilePatchPath, previous }
    try {
      atomicReplaceFile(profilePatchPath, Buffer.from('- id: tui-app\n  disabled: true\n'), 0o600, 'bootstrap CLI patch write')
      const env = { ...installation.env, DSH_PI_TUI_ROLE: 'host' }
      delete env.DSH_PI_TUI_HOST_ENTRY
      const handle = await runTrackedOnce(installation.dshInvocation, ['--profile', 'pi-tui'],
        installation.profileDir, env, 'installed regular CLI with an inherited Host role', 180_000)
      const markers = entryStderrMarkers(handle)
      if (handle.terminal.exit.code === 0) {
        throw new Error('RUN_BOOTSTRAP_CLI: an inherited DSH_PI_TUI_ROLE=host must not turn a missing TUI into success')
      }
      if (!markers.requiredTuiSurfaceMissing) {
        throw new Error('RUN_BOOTSTRAP_CLI: the real CLI never reported the missing required TUI surface')
      }
      response = { mode, entryId: handle.entryId, exit: handle.terminal.exit, markers }
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      const spawned = qualificationHelpers.slice(helpersBefore)
        .filter(handle => handle.kind === 'bootstrap-cli')
      const helper = spawned.at(-1)
      // No helper was spawned: the private patch is the only effect. Once a
      // helper exists, only its validated finished state (real close + exact
      // group audit) permits restoration; otherwise keep the obligation for
      // the joined compensation.
      const mayRestore = helper === undefined || helper.finished === true
      if (mayRestore && processBootstrapCliPatch !== undefined) {
        const patch = processBootstrapCliPatch
        try {
          if (patch.previous === undefined) rmSync(patch.path, { force: true })
          else atomicReplaceFile(patch.path, patch.previous.bytes, patch.previous.mode, 'bootstrap CLI patch restore')
          processBootstrapCliPatch = undefined
        } catch (error) {
          if (primaryError !== undefined) {
            throw new AggregateError([primaryError, error], 'the inherited CLI failed and its private patch restore also failed')
          }
          throw error
        }
      } else if (!mayRestore) {
        appendNote('bootstrap-cli-patch-restore-deferred', { path: profilePatchPath })
      }
    }
  } else {
    const handle = await runTrackedOnce(installation.dshInvocation, ['--profile', 'pi-tui', '--help'],
      installation.profileDir, installation.env, 'installed Direct help', 180_000)
    if (handle.terminal.exit.code !== 0 || handle.terminal.exit.signal !== null) {
      throw new Error(`RUN_BOOTSTRAP_CLI: the Direct --help positive exited ${JSON.stringify(handle.terminal.exit)}`)
    }
    response = { mode, entryId: handle.entryId, exit: handle.terminal.exit, markers: handle.terminal.markers }
  }
  return { ...response, profilePatchRestored: processBootstrapCliPatch === undefined }
}

function assertPristineInstalledCopy(label) {
  const facts = installedPackageFacts(
    scene.installation.profilePackage,
    processCandidate.manifest?.version,
    processCandidate.targetDshVersion,
    label,
  )
  if (facts.payloadHash !== scene.installFacts.payloadHash || facts.buildId !== scene.installFacts.buildId) {
    throw codedInputError('INPUT_CANDIDATE_CHANGED', `${label}: the installed package payload is not pristine`)
  }
  return facts
}

/** Atomic private replacement: never follows or writes through a hardlink. */
function atomicReplaceFile(path, bytes, mode, label) {
  const temp = join(dirname(path), `.split-process-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`)
  try {
    writeFileSync(temp, bytes, { mode, flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The primary replacement error is the failure that must surface.
    }
    throw new Error(`${label}: the atomic private replacement failed (${boundedError(error)})`)
  }
}

async function handleSetInstallationFault(message) {
  requireKnownFields(message, ['fault'], 'SET_INSTALLATION_FAULT')
  requireProcessScene('SET_INSTALLATION_FAULT')
  assertLifecycleOpen('SET_INSTALLATION_FAULT')
  assertNoBootstrapCliPatch('SET_INSTALLATION_FAULT')
  if (processInstallationMutation !== undefined) {
    throw new Error('SET_INSTALLATION_FAULT: a scoped installation mutation is already active')
  }
  const fault = message.fault
  if (fault !== 'host-runtime-absent' && fault !== 'host-bootstrap-absent' && fault !== 'client-bootstrap-drift') {
    throw codedInputError('INPUT_INSTALLATION_FAULT', `SET_INSTALLATION_FAULT: unknown fault ${JSON.stringify(fault)}`)
  }
  if (processCandidate === undefined || scene.installFacts === undefined) {
    throw new Error('SET_INSTALLATION_FAULT: the process install facts are missing')
  }
  assertPristineInstalledCopy('SET_INSTALLATION_FAULT')
  assertImmutableSplitCandidateUnchanged(processCandidate)
  const installation = scene.installation
  const packageRoot = realpathSync(installation.profilePackage)
  const base = {
    fault,
    candidateSha256: processCandidate.candidateSha256,
    payloadHashBefore: scene.installFacts.payloadHash,
    buildIdBefore: scene.installFacts.buildId,
    startedAt: now(),
  }
  if (fault === 'host-runtime-absent') {
    await assertNoLiveMutationConsumers({ allowStableHost: false, label: 'SET_INSTALLATION_FAULT host-runtime-absent' })
    const artifact = join(packageRoot, 'dist', 'host-runtime.mjs')
    const absent = `${artifact}.artifact-absent`
    const packageScopeBarrier = join(installation.dshHome, 'package.json')
    const barrierBody = '{"name":"dsh-split-process-package-scope-barrier","private":true}\n'
    const profilesManifest = join(dirname(installation.profileDir), 'package.json')
    if (existsSync(profilesManifest)) {
      const manifest = readJson(profilesManifest, 'profiles package.json')
      if (manifest.name === '@xmoon76/dsh-pi-tui') {
        throw new Error('SET_INSTALLATION_FAULT: an enclosing profiles manifest carries the candidate package name')
      }
    }
    const profileRequire = createRequire(join(installation.profileDir, 'package.json'))
    if (profileRequire.resolve('@xmoon76/dsh-pi-tui/host-runtime') !== realpathSync(artifact)) {
      throw new Error('SET_INSTALLATION_FAULT: the profile copy is not the normal resolvable Host Runtime artifact')
    }
    const ancestorCopies = []
    for (let directory = dirname(installation.profileDir); ; directory = dirname(directory)) {
      const candidateCopy = join(directory, 'node_modules', '@xmoon76', 'dsh-pi-tui')
      if (existsSync(candidateCopy)) ancestorCopies.push(candidateCopy)
      if (dirname(directory) === directory) break
    }
    const harnessCopy = join(installation.harnessDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    if (existsSync(harnessCopy)) ancestorCopies.push(harnessCopy)
    if (ancestorCopies.length > 0) {
      throw new Error(`SET_INSTALLATION_FAULT: another installed package copy is reachable: ${ancestorCopies.join(', ')}`)
    }
    const previousBarrier = existsSync(packageScopeBarrier)
      ? { bytes: readFileSync(packageScopeBarrier), mode: statSync(packageScopeBarrier).mode & 0o777 }
      : undefined
    // Register the rollback obligation BEFORE the first side effect. A failure
    // between the rename and the post-check is still owned by this mutation.
    const mutation = {
      ...base,
      target: artifact,
      absentPath: absent,
      barrier: { path: packageScopeBarrier, previous: previousBarrier },
      barrierWritten: false,
      artifactRenamed: false,
      restore: async () => {
        if (mutation.artifactRenamed) {
          renameSync(absent, artifact)
          mutation.artifactRenamed = false
        }
        if (mutation.barrierWritten) {
          if (previousBarrier === undefined) rmSync(packageScopeBarrier, { force: true })
          else atomicReplaceFile(packageScopeBarrier, previousBarrier.bytes, previousBarrier.mode, 'install barrier restore')
          mutation.barrierWritten = false
        }
      },
    }
    processInstallationMutation = mutation
    try {
      mutation.barrierWritten = true
      atomicReplaceFile(packageScopeBarrier, Buffer.from(barrierBody), 0o600, 'install barrier write')
      renameSync(artifact, absent)
      mutation.artifactRenamed = true
      let resolutionError
      try {
        profileRequire.resolve('@xmoon76/dsh-pi-tui/host-runtime')
      } catch (error) {
        resolutionError = error
      }
      if (resolutionError === undefined) {
        throw new Error('SET_INSTALLATION_FAULT: the renamed artifact is still resolvable from the profile anchor')
      }
      writeReceipt({ installationMutation: { fault, target: artifact, recordedAt: now() } })
      appendNote('installation-mutation-committed', { fault, target: artifact, candidateSha256: processCandidate.candidateSha256 })
      return {
        ...base,
        target: artifact,
        barrierPath: packageScopeBarrier,
        resolverRefused: true,
      }
    } catch (error) {
      try {
        await mutation.restore()
        processInstallationMutation = undefined
      } catch (restoreError) {
        appendNote('installation-mutation-rollback-failed', { fault, reason: boundedError(restoreError) })
      }
      throw error
    }
  }
  if (fault === 'host-bootstrap-absent') {
    await assertNoLiveMutationConsumers({ allowStableHost: false, label: 'SET_INSTALLATION_FAULT host-bootstrap-absent' })
    const chunkPath = installedChunk('host-bootstrap-')
    const absent = `${chunkPath}.absent`
    const mutation = {
      ...base,
      target: chunkPath,
      absentPath: absent,
      renamed: false,
      restore: async () => {
        if (mutation.renamed) {
          renameSync(absent, chunkPath)
          mutation.renamed = false
        }
      },
    }
    processInstallationMutation = mutation
    try {
      renameSync(chunkPath, absent)
      mutation.renamed = true
      if (!existsSync(join(packageRoot, 'dist', 'local-host.mjs'))) {
        throw new Error('SET_INSTALLATION_FAULT: the real Host entry disappeared with the bootstrap chunk')
      }
      writeReceipt({ installationMutation: { fault, target: chunkPath, recordedAt: now() } })
      appendNote('installation-mutation-committed', { fault, target: chunkPath })
      return { ...base, target: chunkPath, hostEntryPresent: true }
    } catch (error) {
      try {
        await mutation.restore()
        processInstallationMutation = undefined
      } catch (restoreError) {
        appendNote('installation-mutation-rollback-failed', { fault, reason: boundedError(restoreError) })
      }
      throw error
    }
  }
  // client-bootstrap-drift: a stable live Host and no other qualification Client.
  requireReadyHost('SET_INSTALLATION_FAULT client-bootstrap-drift')
  await assertNoLiveMutationConsumers({ allowStableHost: true, label: 'SET_INSTALLATION_FAULT client-bootstrap-drift' })
  const chunkPath = installedChunk('client-bootstrap-')
  const canonicalChunk = realpathSync(chunkPath)
  if (canonicalChunk !== chunkPath) {
    throw new Error('SET_INSTALLATION_FAULT: the installed bootstrap chunk is not a canonical package file')
  }
  const chunkStat = statSync(canonicalChunk)
  if (!chunkStat.isFile() || chunkStat.uid !== process.getuid()) {
    throw new Error('SET_INSTALLATION_FAULT: the installed bootstrap chunk is not an owned regular file')
  }
  const original = { bytes: readFileSync(canonicalChunk), mode: chunkStat.mode & 0o777 }
  const drift = Buffer.concat([original.bytes, Buffer.from('\n// split-process qualification installed-copy drift\n')])
  // The replacement is a private atomic rename, so a pnpm store hardlink can
  // never be mutated in place; the rollback obligation exists before the write.
  const mutation = {
    ...base,
    target: canonicalChunk,
    original,
    restore: async () => {
      atomicReplaceFile(canonicalChunk, original.bytes, original.mode, 'installed-copy restore')
    },
  }
  processInstallationMutation = mutation
  try {
    atomicReplaceFile(canonicalChunk, drift, original.mode, 'installed-copy drift')
    const driftFacts = installedPackageFacts(packageRoot, processCandidate.manifest?.version,
      processCandidate.targetDshVersion, 'SET_INSTALLATION_FAULT drift')
    if (driftFacts.payloadHash === scene.installFacts.payloadHash) {
      throw new Error('SET_INSTALLATION_FAULT: the installed-copy drift did not change the payload hash')
    }
    if (driftFacts.buildId === processScope.buildId || driftFacts.buildId === activeHost.buildId) {
      throw new Error('SET_INSTALLATION_FAULT: the drift did not change the build identity away from the live Host')
    }
    mutation.payloadHashAfter = driftFacts.payloadHash
    mutation.buildIdAfter = driftFacts.buildId
    writeReceipt({
      installationMutation: {
        fault,
        target: chunkPath,
        buildIdBefore: processScope.buildId,
        buildIdAfter: driftFacts.buildId,
        recordedAt: now(),
      },
    })
    appendNote('installation-mutation-committed', {
      fault,
      target: chunkPath,
      buildIdBefore: processScope.buildId,
      buildIdAfter: driftFacts.buildId,
    })
    return {
      ...base,
      target: chunkPath,
      payloadHashAfter: driftFacts.payloadHash,
      buildIdAfter: driftFacts.buildId,
      liveHostBuildId: activeHost.buildId,
    }
  } catch (error) {
    try {
      await mutation.restore()
      processInstallationMutation = undefined
    } catch (restoreError) {
      appendNote('installation-mutation-rollback-failed', { fault, reason: boundedError(restoreError) })
    }
    throw error
  }
}

/** Restore the ONE registered installed-copy mutation. */
async function restoreInstallationMutation({ compensating = false } = {}) {
  const mutation = processInstallationMutation
  if (mutation === undefined) throw new Error('RESTORE_INSTALLATION: no scoped installation mutation is active')
  if (mutation.fault !== 'client-bootstrap-drift' && activeHost !== undefined) {
    throw new Error('RESTORE_INSTALLATION: the Host artifact mutation cannot be restored under a live Host')
  }
  if (!compensating) {
    if (hosts.some(handle => handle.mode !== undefined && handle.finished !== true && handle.acceptedHost !== true)) {
      throw new Error('RESTORE_INSTALLATION: a Host attempt is not finished')
    }
    const allowStableHost = mutation.fault === 'client-bootstrap-drift'
    await assertNoLiveMutationConsumers({ allowStableHost, label: 'RESTORE_INSTALLATION' })
    await assertClientSeatFree(scene.installation, processScope.scopeId, 'RESTORE_INSTALLATION')
    if (!allowStableHost) await assertSceneHostSeatFree('RESTORE_INSTALLATION')
    // The seat probes are real async operations; re-check admission at the
    // actual commit boundary immediately before the synchronous fs effect.
    assertLifecycleOpen('RESTORE_INSTALLATION')
  }
  // Compensation is the cleanup owner: it already audited every owned group,
  // PTY ledger, fallback and both seats before calling this restore.
  await mutation.restore()
  const restored = installedPackageFacts(scene.installation.profilePackage,
    processCandidate.manifest?.version, processCandidate.targetDshVersion, 'RESTORE_INSTALLATION')
  if (restored.payloadHash !== scene.installFacts.payloadHash || restored.buildId !== scene.installFacts.buildId) {
    throw new Error('RESTORE_INSTALLATION: the restored payload does not match the pristine installed facts')
  }
  assertImmutableSplitCandidateUnchanged(processCandidate)
  const fault = mutation.fault
  processInstallationMutation = undefined
  writeReceipt({ installationMutation: undefined })
  appendNote('installation-mutation-restored', { fault, payloadHash: restored.payloadHash, buildId: restored.buildId })
  return {
    fault,
    payloadHash: restored.payloadHash,
    buildId: restored.buildId,
    candidateSha256: processCandidate.candidateSha256,
  }
}

async function handleRestoreInstallation() {
  requireProcessScene('RESTORE_INSTALLATION')
  assertLifecycleOpen('RESTORE_INSTALLATION')
  return await restoreInstallationMutation()
}

async function handleStartIdentityWitness(message) {
  requireKnownFields(message, ['kind'], 'START_IDENTITY_WITNESS')
  requireProcessScene('START_IDENTITY_WITNESS')
  assertLifecycleOpen('START_IDENTITY_WITNESS')
  const kind = message.kind
  if (!IDENTITY_WITNESS_KINDS.has(kind)) {
    throw codedInputError('INPUT_IDENTITY_WITNESS', `START_IDENTITY_WITNESS: unknown kind ${JSON.stringify(kind)}`)
  }
  const witnessDir = join(scene.workDir, 'identity-witnesses', `${kind}-${String(++qualificationHelperSequence)}`)
  mkdirSync(witnessDir, { recursive: true, mode: 0o700 })
  if (kind === 'linux-zombie') {
    if (process.platform !== 'linux') {
      throw codedInputError('INPUT_IDENTITY_WITNESS', 'START_IDENTITY_WITNESS: the same-birth zombie is Linux-only')
    }
    // The holder keeps the dead child unreaped: it becomes the holder's zombie
    // child and no code in this repository waits for it.
    const holder = spawn('/bin/sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!; exec sleep 300'], {
      cwd: witnessDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    const entryId = `identity-witness-zombie-${String(holder.pid)}-${String(Date.now())}`
    // Register the holder synchronously, BEFORE awaiting its first output: a
    // Worker death in this window must reclaim the holder, never leave it
    // outside the ledger while cleanup removes the scene root.
    const handle = registerHelperHandle({
      entryId,
      kind: 'identity-witness',
      label: `linux-zombie-holder-${String(holder.pid)}`,
      child: holder,
      dir: witnessDir,
      extra: { witnessKind: kind, witnessPid: undefined },
    })
    await processProbeHold('identity-witness-spawned', { entryId, holderPid: holder.pid })
    let zombiePid
    try {
      zombiePid = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('START_IDENTITY_WITNESS: the holder never published its zombie child')), 30_000)
        const lines = createInterface({ input: holder.stdout })
        const fence = setInterval(() => {
          if (!lifecycleClosed) return
          clearInterval(fence)
          clearTimeout(timer)
          lines.close()
          reject(new Error('START_IDENTITY_WITNESS: the Supervisor lifecycle closed while the holder registration window was open'))
        }, 50)
        lines.once('line', line => {
          clearTimeout(timer)
          clearInterval(fence)
          lines.close()
          const pid = Number(line.trim())
          if (!Number.isInteger(pid) || pid <= 0) reject(new Error('START_IDENTITY_WITNESS: the holder published no real PID'))
          else resolve(pid)
        })
      })
    } catch (error) {
      // The holder is already registered, so this path reclaims it even when the
      // Worker disappears before the child identity exists.
      await terminateOwnedEntry(handle, 'START_IDENTITY_WITNESS registration failure').catch(() => undefined)
      throw error
    }
    assertLifecycleOpen('START_IDENTITY_WITNESS after holder output')
    const before = readKernelProcess(zombiePid)
    if (before.kind !== 'alive' || before.identity.state === 'Z' || before.identity.state === 'X'
      || before.identity.ppid !== holder.pid || before.identity.pgid !== holder.pid || before.identity.sid !== holder.pid) {
      await terminateOwnedEntry(handle, 'START_IDENTITY_WITNESS child ownership failure').catch(() => undefined)
      throw new Error('START_IDENTITY_WITNESS: the published PID is not a live child in the holder\'s owned group/session')
    }
    const preSignalBirth = serializeKernelIdentity(before.identity)
    assertLifecycleOpen('START_IDENTITY_WITNESS before child signal')
    const recheck = readKernelProcess(zombiePid)
    if (recheck.kind !== 'alive' || serializeKernelIdentity(recheck.identity) !== preSignalBirth
      || recheck.identity.ppid !== holder.pid || recheck.identity.pgid !== holder.pid) {
      await terminateOwnedEntry(handle, 'START_IDENTITY_WITNESS child identity changed before signal').catch(() => undefined)
      throw new Error('START_IDENTITY_WITNESS: the child identity changed before its individual signal')
    }
    // The individual signal is authorized by the exact captured birth and the
    // holder/group/session membership just re-read; a group signal would kill
    // the holder that must keep the zombie unreaped.
    process.kill(zombiePid, 'SIGKILL')
    const started = Date.now()
    let zombieObservation
    for (;;) {
      if (Date.now() - started >= 30_000) {
        await terminateOwnedEntry(handle, 'START_IDENTITY_WITNESS zombie timeout').catch(() => undefined)
        throw new Error('START_IDENTITY_WITNESS: the real child never became a readable zombie with the captured birth')
      }
      try {
        zombieObservation = readKernelProcess(zombiePid)
      } catch {
        zombieObservation = undefined
      }
      if (zombieObservation?.kind === 'alive' && zombieObservation.identity.state === 'Z'
        && serializeKernelIdentity(zombieObservation.identity) === preSignalBirth) break
      await sleep(25)
    }
    handle.witnessPid = zombiePid
    handle.witnessIdentity = zombieObservation.identity
    handle.witnessBirth = preSignalBirth
    handle.witnessStarttime = readHostStarttime(zombiePid)
    syncQualificationHelpersReceipt()
    appendNote('identity-witness-live', {
      entryId,
      kind,
      witnessPid: zombiePid,
      holderPid: holder.pid,
      witnessBirth: handle.witnessBirth,
    })
    return {
      entryId,
      kind,
      pid: zombiePid,
      holderPid: holder.pid,
      birth: handle.witnessBirth,
      starttime: handle.witnessStarttime ?? null,
      kernelIdentity: zombieObservation.identity,
    }
  }
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: witnessDir,
    stdio: 'ignore',
    detached: true,
  })
  const entryId = `identity-witness-live-${String(dummy.pid)}-${String(Date.now())}`
  const handle = registerHelperHandle({
    entryId,
    kind: 'identity-witness',
    label: `live-non-host-${String(dummy.pid)}`,
    child: dummy,
    dir: witnessDir,
    extra: { witnessKind: kind, witnessPid: dummy.pid },
  })
  const started = Date.now()
  let observation
  for (;;) {
    if (Date.now() - started >= 30_000) throw new Error('START_IDENTITY_WITNESS: the live dummy never produced a readable kernel identity')
    try {
      observation = readKernelProcess(dummy.pid)
    } catch {
      observation = undefined
    }
    if (observation?.kind === 'alive') break
    await sleep(25)
  }
  handle.witnessIdentity = observation.identity
  handle.witnessBirth = serializeKernelIdentity(observation.identity)
  handle.witnessStarttime = readHostStarttime(dummy.pid)
  syncQualificationHelpersReceipt()
  appendNote('identity-witness-live', {
    entryId,
    kind,
    witnessPid: dummy.pid,
    witnessBirth: handle.witnessBirth,
  })
  return {
    entryId,
    kind,
    pid: dummy.pid,
    holderPid: null,
    birth: handle.witnessBirth,
    starttime: handle.witnessStarttime ?? null,
    kernelIdentity: observation.identity,
  }
}

async function handleFinishIdentityWitness(message) {
  requireKnownFields(message, ['entryId'], 'FINISH_IDENTITY_WITNESS')
  requireProcessScene('FINISH_IDENTITY_WITNESS')
  assertLifecycleOpen('FINISH_IDENTITY_WITNESS')
  const handle = findEntryById(message.entryId, 'FINISH_IDENTITY_WITNESS')
  if (handle.kind !== 'identity-witness') throw new Error('FINISH_IDENTITY_WITNESS: the entry is not an identity witness')
  if (handle.finished) return handle.terminal ?? { outcome: 'already-finished' }
  if (!handle.exited) {
    assertKernelGroupSignalOwnership(processKernelReaders(), handle.child.pid, handle.birth, 'FINISH_IDENTITY_WITNESS')
    try {
      process.kill(-handle.child.pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw new Error(`FINISH_IDENTITY_WITNESS: the owned witness group could not be killed (${String(error?.code ?? 'unknown')})`)
    }
    await waitForEntryClose(handle, 'FINISH_IDENTITY_WITNESS')
  }
  await assertHostGroupGone(handle, 'FINISH_IDENTITY_WITNESS')
  if (handle.witnessKind === 'linux-zombie') {
    const started = Date.now()
    for (;;) {
      const observation = (() => {
        try { return readKernelProcess(handle.witnessPid) } catch { return undefined }
      })()
      if (observation === undefined || observation.kind !== 'alive' || observation.identity.state !== 'Z') break
      if (Date.now() - started >= 10_000) {
        throw new Error('FINISH_IDENTITY_WITNESS: the real zombie identity survived its holder')
      }
      await sleep(25)
    }
  }
  handle.finished = true
  handle.terminal = { outcome: 'witness-finished', kind: handle.witnessKind, pid: handle.witnessPid };
  syncQualificationHelpersReceipt()
  appendNote('identity-witness-finished', { entryId: handle.entryId, witnessPid: handle.witnessPid })
  return handle.terminal
}

async function stopRecoveredProcessHost(record, client) {
  if (record.reclaimed === true) throw new Error('RECLAIM_DISCOVERED_HOST: the recovered Host is already reclaimed')
  const ownership = assertProcessFallbackOwnership(record.pid, record.scratch, record,
    'RECLAIM_DISCOVERED_HOST recovered Host')
  const scopeDir = processScope.dir
  const launchPath = join(scopeDir, 'launch.json')
  const instancePath = join(scopeDir, 'instance.json')
  if (!existsSync(scopeDir) || !statSync(scopeDir).isDirectory()) {
    throw new Error('RECLAIM_DISCOVERED_HOST: the full-scope run directory is missing')
  }
  if (!existsSync(launchPath) || !existsSync(instancePath)) {
    throw new Error('RECLAIM_DISCOVERED_HOST: the live recovered Host did not publish launch/instance material')
  }
  const before = readJson(instancePath, 'recovered Host instance')
  if (before?.hostPid !== record.pid || before?.instanceId !== record.instanceId
    || before?.scopeId !== processScope.scopeId) {
    throw new Error('RECLAIM_DISCOVERED_HOST: the product instance record does not name the recovered Host')
  }
  if (before.schema === 1) {
    if (before.hostStarttime !== readHostStarttime(record.pid)) {
      throw new Error('RECLAIM_DISCOVERED_HOST: the instance starttime is not the live kernel birth')
    }
  } else if (before.schema === 2) {
    if (sameKernelProcess(before.hostKernelIdentity, readKernelProcess(record.pid)) !== 'same') {
      throw new Error('RECLAIM_DISCOVERED_HOST: the instance kernel identity is not live')
    }
  } else {
    throw new Error('RECLAIM_DISCOVERED_HOST: unsupported instance identity schema')
  }
  // Normal business stop: one exact SIGTERM to the Host PID itself. No group
  // signal and no forced escalation in this positive path.
  process.kill(record.pid, 'SIGTERM')
  await waitForProcessIdentityTerminal(ownership.identity, 'RECLAIM_DISCOVERED_HOST Host PID', 30_000)
  const remaining = kernelGroupLiveMemberPids(processKernelReaders(), record.pid, 'RECLAIM_DISCOVERED_HOST Host group')
  if (remaining.length > 0) {
    throw new Error(`RECLAIM_DISCOVERED_HOST: the stopped Host group still has live members: ${JSON.stringify(remaining)}`)
  }
  await assertSceneHostSeatFree('RECLAIM_DISCOVERED_HOST')
  await assertClientSeatFree(scene.installation, processScope.scopeId, 'RECLAIM_DISCOVERED_HOST')
  if (existsSync(launchPath)) throw new Error('RECLAIM_DISCOVERED_HOST: the stopped Host left launch material')
  if (existsSync(instancePath)) {
    const after = readJson(instancePath, 'recovered Host instance after stop')
    if (after?.instanceId === record.instanceId) {
      throw new Error('RECLAIM_DISCOVERED_HOST: the stopped Host left its own instance record')
    }
  }
  const baseline = new Set(record.scratchBaseline ?? [])
  const scratchEntries = readdirSync(scopeDir).filter(name => name.startsWith('host-scratch-'))
  const newScratch = scratchEntries.filter(name => !baseline.has(name))
  if (newScratch.length > 0) {
    throw new Error(`RECLAIM_DISCOVERED_HOST: the stopped Host left its own scratch material: ${JSON.stringify(newScratch)}`)
  }
  record.reclaimed = true
  record.exitObserved = 'sigterm'
  record.normalStop = true
  record.stoppedAt = now()
  record.stoppedByClientId = client.clientId
  syncFallbackHostsReceipt()
  appendNote('discovered-host-stopped', {
    pid: record.pid,
    birth: ownership.birth,
    clientId: client.clientId,
    signal: 'SIGTERM',
  })
  writeReceipt({})
  let registryRemoved = true
  if (existsSync(instancePath)) {
    const after = readJson(instancePath, 'recovered Host registry after normal stop')
    registryRemoved = after?.instanceId !== record.instanceId
  }
  return {
    pid: record.pid,
    birth: ownership.birth,
    reclaimed: true,
    normalStop: true,
    registryRemoved,
    scratchEntries,
  }
}

async function handleReclaimDiscoveredHost(message) {
  requireProcessScene('RECLAIM_DISCOVERED_HOST')
  assertLifecycleOpen('RECLAIM_DISCOVERED_HOST')
  if (message.clientId !== undefined) {
    const client = processClientById(message.clientId, 'RECLAIM_DISCOVERED_HOST')
    if (!client.closed) throw new Error('RECLAIM_DISCOVERED_HOST: the discovery Client is still live')
    if (client.terminalMode !== 'normal') throw new Error('RECLAIM_DISCOVERED_HOST: the discovery Client did not use the normal terminal')
    if (processClients.some(value => !value.closed || value.verifiedTerminal === undefined)) {
      throw new Error('RECLAIM_DISCOVERED_HOST: every related Client must be verified terminal before normal stop')
    }
    await auditProcessClientLedger('RECLAIM_DISCOVERED_HOST admission')
    const record = fallbackHosts.find(entry => entry.clientId === client.clientId)
    if (record === undefined) throw new Error('RECLAIM_DISCOVERED_HOST: this Client registered no recovered Host')
    return await stopRecoveredProcessHost(record, client)
  }
  requireKnownFields(message, ['entryId'], 'RECLAIM_DISCOVERED_HOST')
  const client = findQualificationClientById(message.entryId, 'RECLAIM_DISCOVERED_HOST')
  if (client.kind !== 'qualification-client') throw new Error('RECLAIM_DISCOVERED_HOST: the entry is not a qualification Client')
  if (!client.exited) throw new Error('RECLAIM_DISCOVERED_HOST: the attached qualification Client is still live')
  const record = fallbackHosts.find(entry => entry.clientId === client.clientId || entry.scratch === client.scratch)
  if (record === undefined) throw new Error('RECLAIM_DISCOVERED_HOST: this Client registered no discovered Host')
  if (record.reclaimed === true) throw new Error('RECLAIM_DISCOVERED_HOST: the discovered Host is already reclaimed')
  const claimed = await reclaimFallbackHost(record.pid, record.origin, record.scratch,
    'RECLAIM_DISCOVERED_HOST', true)
  const registryPath = join(processScope.dir, 'instance.json')
  if (existsSync(registryPath)) {
    const registry = readJson(registryPath, 'discovered Host registry after reclaim')
    if (registry.hostPid === record.pid) {
      throw new Error('RECLAIM_DISCOVERED_HOST: the product registry still names the reclaimed Host')
    }
  }
  const scratchEntries = readdirSync(processScope.dir).filter(name => name.startsWith('host-scratch-'))
  appendNote('discovered-host-reclaimed', {
    pid: record.pid,
    birth: record.birth ?? record.starttime,
    clientId: client.clientId,
  })
  writeReceipt({})
  return {
    pid: record.pid,
    birth: claimed.birth ?? claimed.starttime ?? null,
    reclaimed: true,
    registryRemoved: !existsSync(registryPath),
    scratchEntries,
  }
}

async function handleAssertEntrySeatsFree() {
  requireProcessScene('ASSERT_ENTRY_SEATS_FREE')
  assertLifecycleOpen('ASSERT_ENTRY_SEATS_FREE')
  for (const handle of hosts) {
    if (!handle.exited) throw new Error(`ASSERT_ENTRY_SEATS_FREE: Host/attempt ${String(handle.entryId)} is still live`)
    await assertHostGroupGone(handle, 'ASSERT_ENTRY_SEATS_FREE')
  }
  for (const handle of qualificationClients) {
    if (!handle.exited) throw new Error(`ASSERT_ENTRY_SEATS_FREE: qualification Client ${handle.label} is still live`)
    await assertHostGroupGone(handle, 'ASSERT_ENTRY_SEATS_FREE')
  }
  for (const handle of qualificationHelpers) {
    if (!handle.exited) throw new Error(`ASSERT_ENTRY_SEATS_FREE: ${entryKindLabel(handle)} ${handle.label} is still live`)
    await assertHostGroupGone(handle, 'ASSERT_ENTRY_SEATS_FREE')
  }
  const unfinishedHost = hosts.find(handle => handle.mode !== undefined
    && handle.finished !== true && handle.acceptedHost !== true)
  if (unfinishedHost !== undefined) {
    throw new Error(`ASSERT_ENTRY_SEATS_FREE: Host/attempt ${String(unfinishedHost.entryId)} was never finished`)
  }
  const unfinishedClient = qualificationClients.find(handle => handle.kind === 'qualification-client' && handle.finished !== true)
  if (unfinishedClient !== undefined) {
    throw new Error(`ASSERT_ENTRY_SEATS_FREE: qualification Client ${unfinishedClient.label} was never finished`)
  }
  const liveFallback = sceneLocalHostCandidates()
  if (liveFallback.length > 0) {
    throw new Error(`ASSERT_ENTRY_SEATS_FREE: unowned local Host process(es) are still live: ${JSON.stringify(liveFallback)}`)
  }
  await assertSceneHostSeatFree('ASSERT_ENTRY_SEATS_FREE')
  await assertClientSeatFree(scene.installation, processScope.scopeId, 'ASSERT_ENTRY_SEATS_FREE')
  return { hostSeatFree: true, qualificationClientSeatFree: true, entries: hosts.length + qualificationClients.length + qualificationHelpers.length }
}

function readHostStarttimeOrUndefined(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return readHostStarttime(pid)
}

async function dispatch(message) {
  if (lifecycleClosed) throw new Error('the Supervisor lifecycle is closed; no request may run')
  if (message === null || typeof message !== 'object' || typeof message.type !== 'string') return
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
  try {
    switch (message.type) {
      case 'BOOTSTRAP': {
        const payload = await handleBootstrap(message)
        if (payload !== undefined && requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'BOOTSTRAP_UPGRADE': {
        const payload = await handleBootstrapUpgrade(message)
        if (payload !== undefined && requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_INSTALL_OLD_PROFILE': {
        const payload = await handleUpgradeOldProfile()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_INSTALL_SIDE_OLD': {
        const payload = await handleUpgradeInstallSide(message, 'old')
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_INSTALL_SIDE_NEW': {
        const payload = await handleUpgradeInstallSide(message, 'new')
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD': {
        const payload = await handleUpgradeInstallNewProfileForReload()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP': {
        const payload = await handleUpgradeActivateNewProfileAfterStop()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'BOOTSTRAP_PROCESS': {
        const payload = await handleBootstrapProcess(message)
        if (payload !== undefined && requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'START_HOST': {
        const payload = await handleStartHost(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'START_PROCESS_CLIENT': {
        const payload = await handleStartProcessClient(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PROCESS_CLIENT_INPUT': {
        const payload = await handleProcessClientInput(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PROCESS_CLIENT_TEXT': {
        const payload = await handleProcessClientText(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PROCESS_CLIENT_STATE': {
        const payload = await handleProcessClientState(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'CLOSE_PROCESS_CLIENT': {
        const payload = await handleCloseProcessClient(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'SIGNAL_PROCESS_CLIENT': {
        const payload = await handleSignalProcessClient(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PROCESS_CLIENT_TERMINAL_LOSS': {
        const payload = await handleProcessClientTerminalLoss(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'START_PUBLIC_DAEMON': {
        const payload = await handleStartPublicDaemon(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_INPUT': {
        const payload = await handlePublicDaemonInput(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_KERNEL_STATE': {
        const payload = await handlePublicDaemonKernelState(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_TEXT': {
        const payload = await handlePublicDaemonText(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_STATE': {
        const payload = await handlePublicDaemonState(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_CLOSE': {
        const payload = await handlePublicDaemonClose(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_RECLAIM': {
        const payload = await handlePublicDaemonReclaim(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_TERMINATE_CLI': {
        const payload = await handlePublicDaemonTerminateCli(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_STATUS': {
        const payload = await handlePublicDaemonStatus(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_HEADLESS': {
        const payload = await handlePublicDaemonHeadless(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'PUBLIC_DAEMON_STOP': {
        const payload = await handlePublicDaemonStop(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'HOST_STATUS': {
        const payload = await handleHostStatus(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'START_HOST_ATTEMPTS': {
        const payload = await handleStartHostAttempts(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'START_QUALIFICATION_CLIENTS': {
        const payload = await handleStartQualificationClients(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'ENTRY_RECORDS': {
        const payload = await handleEntryRecords(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'WAIT_ENTRY_RECORD': {
        const payload = await handleWaitEntryRecord(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'QUALIFICATION_CLIENT_STATUS': {
        const payload = await handleQualificationClientStatus(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'QUALIFICATION_CLIENT_CONTROL': {
        const payload = await handleQualificationClientControl(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'SIGNAL_ENTRY': {
        const payload = await handleSignalEntry(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'FINISH_ENTRY': {
        const payload = await handleFinishEntry(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'ACCEPT_HOST_WINNER': {
        const payload = await handleAcceptHostWinner(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'RUN_BOOTSTRAP_CLI': {
        const payload = await handleRunBootstrapCli(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'SET_INSTALLATION_FAULT': {
        const payload = await handleSetInstallationFault(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'RESTORE_INSTALLATION': {
        const payload = await handleRestoreInstallation()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'START_IDENTITY_WITNESS': {
        const payload = await handleStartIdentityWitness(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'FINISH_IDENTITY_WITNESS': {
        const payload = await handleFinishIdentityWitness(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'RECLAIM_DISCOVERED_HOST': {
        const payload = await handleReclaimDiscoveredHost(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'ASSERT_ENTRY_SEATS_FREE': {
        const payload = await handleAssertEntrySeatsFree()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_RELEASE_HELD_TURN': {
        const payload = await handleUpgradeReleaseHeldTurn(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL': {
        const payload = await handleUpgradeRemoveProfileForReloadRefusal(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION': {
        const payload = await handleUpgradeProbeSideNewClientHostFoundation(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'NATIVE_RESERVE_MANAGED_SERVICE': {
        const payload = await handleNativeReserveManagedService()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'NATIVE_VERIFY_MANAGED_SERVICE': {
        const payload = await handleNativeVerifyManagedService()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'NATIVE_RUN_PROFILE_DAEMON': {
        const payload = await handleNativeRunProfileDaemon(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'NATIVE_INSTALL_MANAGED_PROFILE': {
        const payload = await handleNativeInstallManagedProfile(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'NATIVE_CUSTOMIZE_MANAGED_SERVICE': {
        const payload = await handleNativeCustomizeManagedService(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'NATIVE_CURRENT_PROFILE': {
        const payload = await handleNativeCurrentProfile()
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'STOP_HOST': {
        if (activeHost === undefined || activeHost.hostId !== message.hostId) throw new Error('STOP_HOST: unknown hostId')
        if (scene?.kind === 'process') {
          const blocking = qualificationClients.some(handle => handle.kind === 'qualification-client'
            && (!handle.exited || handle.finished !== true))
          if (blocking) throw new Error('STOP_HOST: a live or un-finished qualification Client owns the Host')
        }
        const stopped = activeHost
        const result = await officialStopHost(stopped)
        if (requestId !== undefined) reply(requestId, { code: result.code, signal: result.signal, generation: stopped.generation })
        break
      }
      case 'FINALIZE': {
        try {
          await handleFinalize(message)
        } catch (error) {
          preserveRoot = true
          // ONE joined owner path: explicit failed FINALIZE uses the same
          // compound cleanup as a disconnect/main signal, but preserves the
          // root for the primary test failure. Compensation success never
          // turns the failed finalization into a success.
          let compensation
          try {
            compensation = await cleanup('FINALIZE', { preserveRoot: true, failure: error })
          } catch (compensationError) {
            appendNote('finalize-compensation-failed', { reason: boundedError(compensationError) })
          }
          const detail = error instanceof Error ? error.message : String(error)
          writeReceipt({
            phase: 'NOT_QUIESCED',
            errorName: boundedError(error),
            errorDetail: redactText(detail).slice(0, 600),
            compensation: compensation?.compensation ?? receipt.compensation ?? {
              attempted: true,
              completed: false,
              failure: boundedError(error),
            },
            cleanup: {
              ...(receipt.cleanup ?? {}),
              reason: 'FINALIZE',
              failedAt: now(),
              hostsExited: hosts.every(handle => handle.exited),
              sceneRootRemoved: false,
            },
          })
          if (requestId !== undefined) fail(requestId, 'SUPERVISOR_FINALIZE_FAILED', error)
          if (process.connected) process.disconnect()
          setTimeout(() => process.exit(1), 10)
          break
        }
        if (requestId !== undefined) {
          send({ type: 'RESPONSE', requestId, ok: true, payload: { cleaned: true } }, () => {
            if (process.connected) process.disconnect()
            setTimeout(() => process.exit(0), 10)
          })
        } else {
          if (process.connected) process.disconnect()
          setTimeout(() => process.exit(0), 10)
        }
        break
      }
      case 'REPORT': {
        await handleReport(message)
        if (requestId !== undefined) reply(requestId, { recorded: true })
        break
      }
      default:
        throw new Error(`unknown supervisor message: ${message.type}`)
    }
  } catch (error) {
    if (requestId !== undefined) fail(requestId, 'SUPERVISOR_OPERATION_FAILED', error)
  }
}
