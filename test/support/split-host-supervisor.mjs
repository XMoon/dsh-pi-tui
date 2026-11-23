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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

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
let EXPECTED_PACKAGE_NAME
let hostStatusSequence = 0

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
]).then(([profile, fixtures, tempLifecycle, pair, upgradeSupport, smokeHarness]) => {
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
      // terminal quiescence claim or root removal.
      await reclaimClientFallbackHosts(`cleanup:${reason}:client`)
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
        auditClientLedger(`cleanup:${reason}`)
        await reclaimClientFallbackHosts(`cleanup:${reason}:post-host`)
        await assertSceneHostSeatFree(`cleanup:${reason}`)
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
  installInProgress = true
  const tmpBase = validateTmpBase(message.tmpBase)
  initReceipt(tmpBase, { pid: message.workerPid, ppid: message.workerPpid }, {
    kind: 'upgrade',
    sceneId: message.sceneId,
    parentRunId: typeof message.parentRunId === 'string' && message.parentRunId !== '' ? message.parentRunId : undefined,
  })
  let root
  let pair
  let installation
  let c1Work
  let oldProfile
  try {
    pair = inspectSplitUpgradePair(message.oldTgz, message.newTgz, { policy: 'default' })
    assertPairReceipt(pair, message.expectedPairSha)
    root = createTestTempDir('upgrade-scene-', tmpBase)
    scene = { kind: 'upgrade', workDir: root, pair, sideOld: undefined, sideNew: undefined, profileInstall: undefined }
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
    profile: { old: oldProfile },
  })
  if (disconnected || process.connected !== true) {
    await cleanup('worker-disconnected-during-bootstrap')
    return undefined
  }
  writeReceipt({
    phase: 'SCENE_READY',
    profile: { old: oldProfile },
  })
  return {
    workDir: root,
    pair,
    installation: publicInstallation(installation),
    c1Work: { patchPath: c1Work.patchPath },
    oldProfile,
  }
}

async function handleUpgradeOldProfile() {
  if (scene?.kind !== 'upgrade') throw new Error('UPGRADE_INSTALL_OLD_PROFILE: no upgrade scene')
  // BOOTSTRAP already performed the one real old-profile install; this is the
  // idempotent read-only result method, never a second pnpm transaction.
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

async function handleStartHost(message) {
  if (scene === undefined) throw new Error('START_HOST: no scene')
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
  // A failed native Client close must not prevent the final Host reclaim.
  if (activeHost !== undefined) {
    try {
      await officialStopHost(activeHost)
    } catch (error) {
      hostStopError = error
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
  auditClientLedger('FINALIZE')
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
    receipt.clients = [...(receipt.clients ?? []), {
      label: detail.label,
      session: detail.session,
      shellPid: detail.shellPid ?? null,
      recordFile,
      ...(scene?.kind === 'upgrade'
        ? { scratch: assertOwnedSceneDirectory(detail.scratch, 'REPORT client-started') }
        : {}),
      businessPids,
      ...(scene?.kind === 'upgrade'
        ? { businessPidFacts: businessPids.map(pid => ({ pid, starttime: readHostStarttimeOrUndefined(pid) })) }
        : {}),
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
    for (const pid of Array.isArray(detail.businessPids) ? detail.businessPids : []) {
      if (!Number.isInteger(pid) || pid <= 0) continue
      merged.add(pid)
      if (!facts.has(pid)) facts.set(pid, readHostStarttimeOrUndefined(pid))
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
