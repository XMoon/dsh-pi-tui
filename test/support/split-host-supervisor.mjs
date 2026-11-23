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
 * Two scene kinds share this ONE supervisor wire:
 *   - `pilot`: the existing BOOTSTRAP/START_HOST/STOP_HOST behaviour with its
 *     one-Host-per-scene restriction unchanged.
 *   - `upgrade`: BOOTSTRAP_UPGRADE installs the old profile and owns sequential
 *     Host generations. At most ONE Host is active; a next generation may be
 *     created only after the previous generation's official stop and whole
 *     process-group disappearance are proven.
 */

import { spawn, execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  allowNativeMutation,
  applyServiceObservation,
  assertManagedReservationScene,
  assertNativeManagedProfileInstall,
  assertNativeRollbackAdmission,
  classifyCurrentProfile,
  classifyManagedInspection,
  classifyNativeCliFence,
  classifyNativeClientOwnership,
  cleanupNativeService,
  combineNativeFailures,
  executeNativeServiceReservation,
  isNativeDaemonUnquiesced,
  loadNativeManagerAdapter,
  runOwnedNativeCli,
  nativeBootstrapAdmission,
  parseManagedDaemonStatus,
  requireLaunchdCustomization,
  runFixedDaemonVerb,
  serializeKernelIdentity,
} from './split-upgrade-native-contract.mjs'

const SUPERVISOR_STARTED_AT = new Date().toISOString()
const HOST_READY_TIMEOUT_MS = 180_000
const HOST_SHUTDOWN_GRACE_MS = 30_000
const TERM_GRACE_MS = 3_000
const KILL_GRACE_MS = 3_000
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
let qualificationClientSequence = 0
let receiptPath
let receipt
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
let createSplitSmokeProfile
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
  if (preserveRoot) {
    process.exit(1)
    return
  }
  void closeLifecycle('worker-ipc-disconnect').then(
    result => { process.exit(result.clean ? 0 : 1) },
    () => { process.exit(1) },
  )
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (preserveRoot) {
      process.exit(1)
      return
    }
    void closeLifecycle(`supervisor-${signal}`).then(
      result => { process.exit(result.clean ? 0 : 1) },
      () => { process.exit(1) },
    )
  })
}

process.on('uncaughtException', error => {
  writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(error) })
  if (preserveRoot) {
    process.exit(1)
    return
  }
  void closeLifecycle('uncaught-exception').then(() => process.exit(1), () => process.exit(1))
})

// Keep the IPC channel and message loop alive until FINALIZE or disconnect.
setInterval(() => {}, 1_000)

const modulesReady = Promise.all([
  import('../../scripts/lib/split-smoke-profile.mjs'),
  import('../../scripts/lib/split-smoke-fixtures.mjs'),
  import('./temp-lifecycle.ts'),
  import('./split-upgrade-pair.mjs'),
  import('../../scripts/lib/split-upgrade-support.mjs'),
  import('../../scripts/lib/dsh-smoke-harness.mjs'),
  import('../../src/runtime/native-process/identity.ts'),
]).then(([profile, fixtures, tempLifecycle, pair, upgradeSupport, smokeHarness, nativeIdentity]) => {
  inspectSplitCandidate = profile.inspectSplitCandidate
  createSplitSmokeProfile = profile.createSplitSmokeProfile
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
  receipt = { ...receipt, ...update, updatedAt: now() }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
}

function initReceipt(tmpBase, worker, extra = {}) {
  const root = evidenceRoot(tmpBase)
  receiptPath = join(root, `${RUN_ID}.json`)
  receipt = {
    schemaVersion: 1,
    runId: RUN_ID,
    supervisor: { pid: process.pid, pgrp: getPgrp() ?? process.pid, startedAt: SUPERVISOR_STARTED_AT },
    worker: { pid: worker.pid, ppid: worker.ppid },
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
  const message = error instanceof Error ? error.message : String(error)
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

async function assertHostGroupGone(handle, reason) {
  const pgid = hostPgid(handle)
  if (!processGroupAlive(pgid)) return
  // The original ChildProcess and its detached PGID are still the identity we
  // created. Give the group a bounded chance to disappear, then fail closed:
  // a live descendant means the generation cannot be called quiesced.
  await waitForGroupGone(pgid, 3_000)
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

function publicHostFacts(handle) {
  const scopeId = handle.ready?.localHost?.scopeId
  return {
    id: handle.hostId,
    hostId: handle.hostId,
    generation: handle.generation,
    source: handle.source,
    pid: handle.child.pid ?? null,
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
  }
}

function hostLedger() {
  return hosts.map(publicHostFacts)
}

function syncHostReceipt() {
  const update = { hosts: hostLedger() }
  const latest = hosts[hosts.length - 1]
  if (latest !== undefined) update.host = publicHostFacts(latest)
  writeReceipt(update)
}

function publicQualificationClientFacts(handle) {
  return {
    pid: handle.child.pid ?? null,
    pgid: hostPgid(handle),
    starttime: handle.starttime,
    scratch: handle.scratch,
    hostId: handle.hostId,
    generation: handle.generation,
    startedAt: handle.startedAt,
    closedAt: handle.closedAt,
    exitCode: handle.exitResult?.code ?? null,
    exitSignal: handle.exitResult?.signal ?? null,
    exited: handle.exited,
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
      throw new Error(`${label}: the qualification Client reported ${String(failure.m4a0)}${failure.code === undefined ? '' : ` [${String(failure.code)}]`}: ${String(failure.error ?? failure.op ?? '')}`)
    }
    if (handle.spawnError !== undefined) throw new Error(`${label}: qualification Client spawn failed (${boundedError(handle.spawnError)})`)
    if (handle.exited) throw new Error(`${label}: qualification Client exited before the record`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    await sleep(20)
  }
}

/** The whole command line of one live process, or undefined when unreadable. */
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
}

function clientScratchOrigins() {
  const origins = new Map()
  for (const client of receipt?.clients ?? []) {
    if (typeof client.scratch === 'string' && client.scratch !== '') origins.set(client.scratch, `surface-client:${String(client.label)}`)
  }
  for (const qualification of qualificationClients) {
    origins.set(qualification.scratch, `qualification-client:${String(qualification.child.pid)}`)
  }
  return origins
}

function syncFallbackHostsReceipt() {
  writeReceipt({ fallbackHosts })
}

/** Reclaim ONE detached discovery-fallback Host by its real kernel identities. */
async function reclaimFallbackHost(pid, origin, scratch, reason) {
  const command = processCommandLine(pid)
  if (command === undefined || !command.includes('local-host.mjs')) {
    throw new Error(`${reason}: the fallback Host candidate ${String(pid)} is no longer a Host entry process`)
  }
  const starttime = readHostStarttime(pid)
  if (starttime === undefined) {
    throw new Error(`${reason}: the fallback Host candidate ${String(pid)} has no readable OS starttime`)
  }
  const record = {
    pid,
    pgid: pid,
    starttime,
    origin,
    scratch,
    detectedAt: now(),
    reclaimed: false,
    exitObserved: undefined,
  }
  // A detached Host candidate is its own process-group leader.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  await waitForGroupGone(pid, TERM_GRACE_MS)
  if (processGroupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await waitForGroupGone(pid, KILL_GRACE_MS)
  }
  if (processGroupAlive(pid) || pidAlive(pid)) {
    throw new Error(`${reason}: the fallback Host ${String(pid)} is still alive after TERM/KILL`)
  }
  const currentStarttime = readHostStarttime(pid)
  if (currentStarttime !== undefined && currentStarttime !== starttime) {
    throw new Error(`${reason}: the fallback Host PID ${String(pid)} was reused by another process during reclaim`)
  }
  record.reclaimed = true
  record.exitObserved = 'group-gone'
  fallbackHosts.push(record)
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
  if (scene?.kind !== 'upgrade') return []
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
      reclaimed.push(await reclaimFallbackHost(pid, matched.origin, matched.scratch, reason))
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
  if (hosts.length === 0) return
  if (hosts.some(handle => !handle.exited)) return
  const scopeId = latestHostScopeId()
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
async function crashHost(handle, reason) {
  if (handle.exited) return
  killOwnedHost(handle, 'SIGKILL')
  try {
    await waitForChildClose(handle.child, KILL_GRACE_MS)
  } catch (error) {
    throw new Error(`Host ${String(handle.child.pid)} did not die after ${reason}: ${error instanceof Error ? error.message : String(error)}`)
  }
  handle.exited = true
  handle.exitResult = { code: handle.child.exitCode, signal: handle.child.signalCode }
  handle.closedAt = now()
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
  killOwnedHost(handle, 'SIGTERM')
  try {
    await waitForChildClose(handle.child, TERM_GRACE_MS)
  } catch {
    killOwnedHost(handle, 'SIGKILL')
    try {
      await waitForChildClose(handle.child, KILL_GRACE_MS)
    } catch (error) {
      throw new Error(`Host ${String(handle.child.pid)} did not exit after ${reason}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  handle.exited = true
  handle.exitResult = { code: handle.child.exitCode, signal: handle.child.signalCode }
  handle.closedAt = now()
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
  try {
    handle.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
    const result = await waitForChildClose(handle.child, HOST_SHUTDOWN_GRACE_MS)
    handle.exited = true
    handle.exitResult = result
    handle.closedAt = now()
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
  await Promise.race([queue.catch(() => undefined), sleep(5_000)])
  return await cleanup(reason)
}

async function cleanup(reason) {
  lifecycleClosed = true
  if (finalized) return { clean: true }
  if (cleanupPromise !== undefined) return await cleanupPromise
  cleanupPromise = (async () => {
    let clean = true
    writeReceipt({
      phase: 'CLEANUP_STARTED',
      notes: [...(receipt?.notes ?? []), { event: 'cleanup-started', detail: { reason }, at: now() }],
    })
    try {
      // The one-shot qualification Client is a Supervisor-owned process group:
      // reclaim it BEFORE the Host generations and before the scene root.
      await terminateQualificationClient(reason)
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
      } else {
        await reclaimClientFallbackHosts(`cleanup:${reason}:client`)
      }
      for (const handle of [...hosts].reverse()) {
        if (handle.exited) await assertHostGroupGone(handle, reason)
        else await terminateHost(handle, reason)
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
        await reclaimClientFallbackHosts(`cleanup:${reason}:post-host`)
        await assertSceneHostSeatFree(`cleanup:${reason}`)
        if (!clean) {
          throw new Error(`${reason}: the Scene is not quiesced; the root is preserved for diagnosis`)
        }
        await cleanupSceneRoot(reason)
      }
      installInProgress = false
      writeReceipt({
        phase: clean ? 'ABORTED_CLEAN' : 'NOT_QUIESCED',
        cleanup: {
          reason,
          completedAt: now(),
          hostsExited: hosts.every(handle => handle.exited),
          sceneRootRemoved: scene === undefined ? undefined : !existsSync(scene.workDir),
        },
        install: { ...(receipt?.install ?? {}), inProgress: false },
      })
    } catch (error) {
      clean = false
      writeReceipt({ phase: 'NOT_QUIESCED', cleanup: { reason, errorName: boundedError(error), completedAt: now() } })
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
  if (kernel.kind === 'gone') return { state: 'gone' }
  if (kernel.kind === 'unknown') return { state: 'unknown', reason: 'KERNEL_IDENTITY_UNKNOWN' }
  if (serializeKernelIdentity(kernel.identity) !== registered.birth) return { state: 'gone', reason: 'PID_REUSED' }
  const snapshot = nativeProcessSnapshot(registered.pid)
  if (snapshot === null) return { state: 'unknown', reason: 'PROCESS_FACTS_UNREADABLE' }
  const observed = {
    pid: registered.pid,
    uid: snapshot.uid,
    birth: snapshot.birth,
    scratch: registered.scratch === null ? null : processEnvironmentValue(registered.pid, 'SPLIT_PROCESS_SCRATCH'),
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

/** Whether one registry record still names the SAME live kernel process. */
function registryIdentityMatches(record, identity) {
  if (identity.platform === 'linux') {
    return record.schema === 1 && record.hostStarttime === identity.startTicks
  }
  if (identity.platform === 'darwin') {
    const recorded = record.hostKernelIdentity
    if (record.schema !== 2 || recorded === null || typeof recorded !== 'object') return false
    return recorded.platform === 'darwin'
      && recorded.pid === identity.pid
      && recorded.bootUUID === identity.bootUUID
      && recorded.uniqueId === identity.uniqueId
      && recorded.processUUID === identity.processUUID
      && recorded.startSec === identity.startSec
      && recorded.startUsec === identity.startUsec
  }
  return false
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
  if (registry !== null && registry.hostPid === pid && registryIdentityMatches(registry, kernel.identity)) {
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

/** Merge one verified managed-Host identity into the receipt ledger (one per PID). */
function mergeHostIdentities(identities, identity) {
  const merged = (identities ?? []).filter(value => value.pid !== identity.pid)
  merged.push(identity)
  return merged
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
    record = { ...record, hostIdentities: mergeHostIdentities(record.hostIdentities, identity) }
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
      probeHostKernel: pid => nativeKernelFacts(pid).status,
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
          if (pidAlive(record.pid)) {
            problems.push(`${String(client.label)}: live official record PID ${String(record.pid)} has no registered OS identity`)
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
    installPlugin(scene.installation.dshInvocation, tarball, scene.installation.harnessDir, scene.installation.env, false)
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
    root = createTestTempDir('upgrade-scene-', tmpBase)
    scene = { kind: 'upgrade', workDir: root, pair, sideOld: undefined, sideNew: undefined, profileInstall: undefined }
    if (nativeAdapter !== undefined) {
      nativeRuntime = {
        manager: admission.manager,
        adapter: nativeAdapter,
        reservation: undefined,
        record: undefined,
        currentProfile: undefined,
        cliPending: undefined,
        cliFence: undefined,
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
    })
    c1Work = writeC1WorkFixture(installation.profileDir, root)
    oldProfile = installedPackageFacts(installation.profilePackage, pair.old.version, pair.targetDshVersion, 'old profile')
    currentProfile = { role: 'old', installGeneration: 1, ...oldProfile }
    if (nativeRuntime !== undefined) nativeRuntime.currentProfile = currentProfile
    scene = { kind: 'upgrade', workDir: root, pair, installation, c1Work, sideOld: undefined, sideNew: undefined, profileInstall: oldProfile }
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
    const packageRoot = installSideBuild(
      dir,
      scene.pair[role].path,
      scene.installation.env,
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
  const result = await runtime.adapter.customizeManagedService({
    ...runtime.reservation,
    fileIdentity: runtime.record.fileIdentity,
  }, customization)
  const inspection = result?.observation
  if (inspection === undefined || inspection === null) {
    throw new Error('NATIVE_CUSTOMIZE_INVALID: the helper returned no observation')
  }
  const kernel = inspection.mainPid === null ? null : nativeKernelFacts(inspection.mainPid)
  const nextObservation = classifyManagedInspection({
    reservation: runtime.reservation,
    history: { everObservedInstalled: runtime.record.everObservedInstalled },
    inspection,
    kernel,
    verifiedAt: now(),
  })
  let record = applyServiceObservation(runtime.record, nextObservation)
  const returnedIdentity = result.fileIdentity
  const invalidIdentity = (message) => {
    // The helper may already have replaced the plist. Never present the old
    // identity as current; record the unverifiable committed state and fail.
    writeReceipt({
      phase: 'NOT_QUIESCED',
      errorName: 'NATIVE_CUSTOMIZE_IDENTITY_MISMATCH',
      notes: [...(receipt?.notes ?? []), { event: 'native-customize-unverified', detail: { reason: message }, at: now() }],
      native: {
        ...record,
        lifecycle: 'unverifiable',
        lastOperation: { verb: 'customize', phase: 'UNKNOWN', pid: null, exitCode: null, signal: null, at: now() },
      },
    })
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
  record = {
    ...record,
    lastOperation: { verb: 'customize', phase: 'EXITED', pid: null, exitCode: 0, signal: null, at: now() },
  }
  // The updated real file identity is durable BEFORE the Worker is acknowledged.
  writeReceipt({ phase: 'NATIVE_SERVICE_CUSTOMIZED', native: record })
  if (lifecycleClosed) {
    // The helper transaction already committed. The record above is the truth;
    // the Worker must not receive a success acknowledgement from a closing Scene.
    throw new Error('NATIVE_SCENE_CLOSED: the managed-plist customization committed while the Scene was closing')
  }
  return { reservation: runtime.reservation, observation: record.observed }
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

  let source = 'profile'
  let entry
  let entryRealpath
  let buildId
  let expectedVersion
  if (scene.kind === 'upgrade') {
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

  const workRoot = join(scene.workDir, `c1-${message.scenario}-${String(hosts.length + 1)}`)
  mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  const env = {
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
  // Same lifecycle gate as the qualification Client: a queued/in-flight
  // START_HOST must never create a detached Host after cleanup took over.
  assertLifecycleOpen('START_HOST')
  const child = spawn(process.execPath, [entryRealpath], {
    cwd: scene.installation.base.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
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
    scenario: message.scenario,
    child,
    records,
    workRoot,
    entryRealpath,
    buildId,
    expectedVersion,
    ready: undefined,
    businessPid: null,
    startedAt: now(),
    starttime: readHostStarttime(child.pid),
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
      `${message.scenario} Host ready`, HOST_READY_TIMEOUT_MS)
  } catch (error) {
    if (handle.spawnError !== undefined) {
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
    throw new Error(`${message.scenario} Host boot failed: ${JSON.stringify({
      code: ready.code,
      error: ready.error,
      phase: ready.phase,
    })}${stderr === '' ? '' : ' (Host stderr present)'}`)
  }
  if (scene.kind === 'upgrade' && ready.localHost?.buildId !== handle.buildId) {
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
    buildId: handle.buildId,
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
  const result = runDsh(scene.installation.dshInvocation,
    ['plugin', '--profile', 'pi-tui', 'remove', EXPECTED_PACKAGE_NAME],
    scene.installation.harnessDir, scene.installation.env)
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

async function handleFinalize(message) {
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
    if (handle.exitResult?.code !== 0 || handle.exitResult?.signal !== null) {
      hostStopError = hostStopError ?? new Error(
        `FINALIZE: qualification Client PID ${String(handle.child.pid)} did not exit normally: ${JSON.stringify(handle.exitResult ?? null)}`)
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
  if (message.clientsClosed !== true) {
    writeReceipt({ phase: 'NOT_QUIESCED', errorName: 'FINALIZE_CLIENTS_NOT_CLOSED' })
    throw new Error('FINALIZE: worker did not confirm Clients closed')
  }
  if (isNativeScene()) {
    const nativeCleanup = await cleanupNativeManagedService('FINALIZE')
    if (!nativeCleanup.clean) {
      hostStopError = hostStopError ?? new Error(`FINALIZE: the native managed service is not reclaimed (${String(nativeCleanup.reason)})`)
    }
  } else {
    auditClientLedger('FINALIZE')
  }
  if (hostStopError !== undefined) throw hostStopError
  for (const handle of hosts) {
    if (handle.exitResult?.code !== 0 || handle.exitResult?.signal !== null) {
      throw new Error(`FINALIZE: Host generation ${String(handle.generation)} did not exit normally: ${JSON.stringify(handle.exitResult)}`)
    }
  }
  await reclaimClientFallbackHosts('FINALIZE')
  await assertSceneHostSeatFree('FINALIZE')
  if (scene !== undefined) {
    await cleanupSceneRoot('FINALIZE')
  }
  finalized = true
  writeReceipt({ phase: 'FINALIZED', cleanup: { completedAt: now() } })
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
      case 'START_HOST': {
        const payload = await handleStartHost(message)
        if (requestId !== undefined) reply(requestId, payload)
        break
      }
      case 'HOST_STATUS': {
        const payload = await handleHostStatus(message)
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
          writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(error) })
          if (requestId !== undefined) fail(requestId, 'SUPERVISOR_FINALIZE_FAILED', error)
          process.disconnect()
          setTimeout(() => process.exit(1), 10)
          break
        }
        if (requestId !== undefined) {
          send({ type: 'RESPONSE', requestId, ok: true, payload: { cleaned: true } }, () => {
            process.disconnect()
            setTimeout(() => process.exit(0), 10)
          })
        } else {
          process.disconnect()
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
