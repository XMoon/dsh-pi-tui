/**
 * Split-process parent-death supervisor.
 *
 * This process is the ONE lifecycle owner for the split-process scene root, the isolated
 * profile installation, and the real Split Host. The Vitest worker owns only
 * the tui-test Clients and business assertions; it never receives a Host
 * ChildProcess handle and never kills a Host by PID/PGID.
 *
 * The process is forked with `detached: true` and an IPC channel. The Vitest
 * main process can be killed (including SIGKILL of a worker); while this
 * supervisor survives, Node's IPC `disconnect` event triggers the ONE
 * bounded cleanup path (`TERM -> KILL`, then the owned scene root removal).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

const SUPERVISOR_STARTED_AT = new Date().toISOString()
const HOST_READY_TIMEOUT_MS = 180_000
const HOST_SHUTDOWN_GRACE_MS = 30_000
const TERM_GRACE_MS = 3_000
const KILL_GRACE_MS = 3_000
const RUN_ID = process.env.SPLIT_VITEST_RUN_ID ?? `supervisor-${String(process.pid)}-${String(Date.now())}`

let scene = undefined
let host = undefined
let receiptPath
let receipt = undefined
let installInProgress = false
let cleanupPromise
let finalized = false
let preserveRoot = false
let disconnected = false
let queue = Promise.resolve()
let workerKillBarrierResolve
let inspectSplitCandidate
let createSplitSmokeProfile
let writeC1WorkFixture
let createTestTempDir

// Register every parent-death / message / signal handler before loading the
// heavy profile and fixture modules. A fork can deliver `disconnect` while the
// module graph is still evaluating; an event registered after that point is not
// replayed. The implementation modules are loaded immediately below this block.
process.on('message', message => {
  queue = queue.then(() => dispatch(message)).catch(error => {
    writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(error) })
  })
})

process.on('disconnect', () => {
  disconnected = true
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
  void cleanup('worker-ipc-disconnect').then(result => {
    process.exit(result.clean ? 0 : 1)
  })
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (preserveRoot) {
      process.exit(1)
      return
    }
    void cleanup(`supervisor-${signal}`).then(result => {
      process.exit(result.clean ? 0 : 1)
    })
  })
}

process.on('uncaughtException', error => {
  writeReceipt({ phase: 'NOT_QUIESCED', errorName: boundedError(error) })
  if (preserveRoot) {
    process.exit(1)
    return
  }
  void cleanup('uncaught-exception').then(() => process.exit(1), () => process.exit(1))
})

// Keep the IPC channel and message loop alive until FINALIZE or disconnect.
setInterval(() => {}, 1_000)

const modulesReady = Promise.all([
  import('../../scripts/lib/split-smoke-profile.mjs'),
  import('../../scripts/lib/split-smoke-fixtures.mjs'),
  import('./temp-lifecycle.ts'),
]).then(([profile, fixtures, tempLifecycle]) => {
  inspectSplitCandidate = profile.inspectSplitCandidate
  createSplitSmokeProfile = profile.createSplitSmokeProfile
  writeC1WorkFixture = fixtures.writeC1WorkFixture
  createTestTempDir = tempLifecycle.createTestTempDir
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
  if ((stats.mode & 0o777) !== 0o700) throw new Error(`INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE must have mode 0700: ${real}`)
  const rel = relative(process.cwd(), real)
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) {
    throw new Error(`INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE must be outside the checkout: ${real}`)
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

function initReceipt(tmpBase, worker) {
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
    clients: [],
    notes: [],
    startedAt: SUPERVISOR_STARTED_AT,
    updatedAt: now(),
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

function killOwnedHost(signal) {
  if (host === undefined || host.exited) return
  try {
    // This is the ChildProcess handle this supervisor itself created. The
    // detached child is the process-group leader, so the negative PGID names
    // only this run's process group.
    process.kill(-host.child.pid, signal)
  } catch {
    try { host.child.kill(signal) } catch { /* already gone */ }
  }
}

function hostPgid() {
  return host?.publicFacts?.pgid ?? host?.child?.pid
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

async function assertHostGroupGone(reason) {
  const pgid = hostPgid()
  if (!processGroupAlive(pgid)) return
  // The original ChildProcess and its detached PGID are still the identity we
  // created. Give the group a bounded chance to disappear, then fail closed:
  // a live descendant means the scene cannot be called quiesced.
  await waitForGroupGone(pgid, 3_000)
  if (processGroupAlive(pgid)) {
    throw new Error(`${reason}: Host process group ${String(pgid)} still has live members`)
  }
}

async function terminateHost(reason) {
  if (host === undefined) return { code: null, signal: null, alreadyGone: true }
  if (host.exited) {
    await assertHostGroupGone(reason)
    return host.exitResult ?? { code: host.child.exitCode, signal: host.child.signalCode }
  }
  killOwnedHost('SIGTERM')
  try {
    await waitForChildClose(host.child, TERM_GRACE_MS)
  } catch {
    killOwnedHost('SIGKILL')
    try {
      await waitForChildClose(host.child, KILL_GRACE_MS)
    } catch (error) {
      throw new Error(`Host ${String(host.child.pid)} did not exit after ${reason}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  host.exited = true
  host.exitResult = { code: host.child.exitCode, signal: host.child.signalCode }
  await assertHostGroupGone(reason)
  writeReceipt({ host: { ...host.publicFacts, exitCode: host.exitResult.code, exitSignal: host.exitResult.signal } })
  return host.exitResult
}

async function officialStopHost() {
  if (host === undefined) throw new Error('STOP_HOST: no Host exists in this scene')
  if (host.exited) {
    await assertHostGroupGone('STOP_HOST')
    const result = host.exitResult ?? { code: host.child.exitCode, signal: host.child.signalCode }
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`STOP_HOST: Host had already exited abnormally: ${JSON.stringify(result)}`)
    }
    return result
  }
  try {
    host.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
    const result = await waitForChildClose(host.child, HOST_SHUTDOWN_GRACE_MS)
    host.exited = true
    host.exitResult = result
    await assertHostGroupGone('STOP_HOST')
    writeReceipt({ host: { ...host.publicFacts, exitCode: result.code, exitSignal: result.signal } })
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`STOP_HOST: official shutdown was abnormal: ${JSON.stringify(result)}`)
    }
    return result
  } catch (error) {
    await terminateHost('STOP_HOST timeout').catch(() => undefined)
    throw error
  }
}

async function cleanupSceneRoot(reason) {
  if (scene === undefined) return
  const root = scene.workDir
  rmSync(root, { recursive: true, force: true })
  if (existsSync(root)) throw new Error(`${reason}: scene root still exists after removal: ${root}`)
}

async function cleanup(reason) {
  if (finalized) return { clean: true }
  if (cleanupPromise !== undefined) return await cleanupPromise
  cleanupPromise = (async () => {
    let clean = true
    let errorMessage
    writeReceipt({
      phase: 'CLEANUP_STARTED',
      notes: [...(receipt?.notes ?? []), { event: 'cleanup-started', detail: { reason }, at: now() }],
    })
    try {
      if (host !== undefined) {
        if (host.exited) await assertHostGroupGone(reason)
        else await terminateHost(reason)
      }
      if (scene !== undefined) {
        // Only the supervisor owns the scene root. A worker crash may leave a
        // tui-test Client behind; that fact is checked by the external probe,
        // never assumed from the Supervisor receipt.
        await cleanupSceneRoot(reason)
      }
      writeReceipt({
        phase: clean ? 'ABORTED_CLEAN' : 'NOT_QUIESCED',
        cleanup: { reason, completedAt: now(), hostExited: host === undefined ? undefined : host.exited },
      })
    } catch (error) {
      clean = false
      errorMessage = error instanceof Error ? error.message : String(error)
      writeReceipt({ phase: 'NOT_QUIESCED', cleanup: { reason, errorName: boundedError(error), completedAt: now() } })
    }
    return { clean, errorMessage }
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

async function handleBootstrap(message) {
  await modulesReady
  if (scene !== undefined) throw new Error('BOOTSTRAP: scene already exists')
  if (!Number.isInteger(message.workerPid) || message.workerPid <= 0
    || !Number.isInteger(message.workerPpid) || message.workerPpid <= 0) {
    throw new Error('INPUT_UNQUALIFIED: BOOTSTRAP requires real workerPid and workerPpid')
  }
  installInProgress = true
  const tmpBase = validateTmpBase(message.tmpBase)
  initReceipt(tmpBase, { pid: message.workerPid, ppid: message.workerPpid })
  let root
  let candidate
  let installation
  let c1Work
  try {
    candidate = inspectSplitCandidate(message.tarball)
    root = createTestTempDir('scene-', tmpBase)
    // Register the root before install so a later disconnect still owns and
    // retries removal even if installation fails half-way.
    scene = { workDir: root }
    appendNote('bootstrap-root-created', { sceneRoot: root })
    writeReceipt({ phase: 'BOOTSTRAP_ROOT_CREATED', sceneRoot: root, install: { inProgress: true, completed: false, startedAt: now(), completedAt: undefined } })
    installation = createSplitSmokeProfile({
      tarball: candidate.tarball,
      targetDshVersion: candidate.targetDshVersion,
      workDir: root,
    })
    c1Work = writeC1WorkFixture(installation.profileDir, root)
    scene = { workDir: root, installation, candidate, c1Work }
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

async function handleStartHost(message) {
  if (scene === undefined) throw new Error('START_HOST: no scene')
  if (host !== undefined) throw new Error('START_HOST: one Host per scene is supported')
  const workRoot = join(scene.workDir, `c1-${message.scenario}`)
  mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  const env = {
    ...scene.installation.base.env,
    SPLIT_PROCESS_EXTRA_PATCH: scene.c1Work.patchPath,
    C1_SCENARIO: message.scenario,
    C1_WORK_ROOT: workRoot,
    DSH_PI_TUI_ENTRY_RECORDS: '1',
    SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
    SPLIT_PROCESS_PROFILE: 'pi-tui',
    SPLIT_PROCESS_SCRATCH: join(scene.workDir, `host-scratch-${message.scenario}`),
    ...(message.extraEnv ?? {}),
  }
  mkdirSync(env.SPLIT_PROCESS_SCRATCH, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, [scene.installation.entries.host], {
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
  const hostId = `host-${String(child.pid)}-${String(Date.now())}`
  let spawnError
  child.once('error', error => {
    spawnError = error
    if (host !== undefined) host.spawnError = error
    writeReceipt({ phase: 'HOST_SPAWN_ERROR', errorName: boundedError(error) })
  })
  host = {
    id: hostId,
    child,
    records,
    workRoot,
    exited: false,
    exitResult: undefined,
    spawnError,
    publicFacts: { id: hostId, pid: child.pid ?? null, pgid: child.pid ?? null, workRoot },
  }
  child.once('close', (code, signal) => {
    if (host === undefined) return
    host.exited = true
    host.exitResult = { code, signal }
    writeReceipt({ host: { ...host.publicFacts, exitCode: code, exitSignal: signal } })
  })
  appendNote('host-spawned', { hostId, pid: child.pid ?? null, workerPid: receipt.worker?.pid, workRoot })
  writeReceipt({ phase: 'HOST_SPAWNED', host: host.publicFacts })
  progress(message.requestId, 'HOST_SPAWNED', { hostId, pid: child.pid ?? null, workRoot })
  if (process.env.SPLIT_VITEST_WORKER_KILL_POINT === 'host-spawned-before-ack') {
    appendNote('host-spawned-before-ack-barrier', {
      hostId,
      hostPid: child.pid ?? null,
      workerPid: receipt.worker?.pid,
      workerPpid: receipt.worker?.ppid,
    })
    writeReceipt({ phase: 'HOST_SPAWNED_BEFORE_ACK', host: host.publicFacts })
    await waitForWorkerKillBarrier()
    throw new Error('START_HOST: worker was killed at the host-spawned-before-ack barrier')
  }

  let ready
  try {
    ready = await waitForHostRecord(host, record => record.m4a0 === 'ready' || record.m4a0 === 'failure',
      `${message.scenario} Host ready`, HOST_READY_TIMEOUT_MS)
  } catch (error) {
    if (host.spawnError !== undefined) {
      host.exited = true
      host.exitResult = { code: null, signal: null }
    } else {
      await terminateHost('START_HOST wait failed').catch(() => undefined)
    }
    throw error
  }
  if (ready.m4a0 === 'failure') {
    await terminateHost('Host reported startup failure').catch(() => undefined)
    throw new Error(`${message.scenario} Host boot failed: ${JSON.stringify({
      code: ready.code,
      error: ready.error,
      phase: ready.phase,
    })}${stderr === '' ? '' : ' (Host stderr present)'}`)
  }
  host.publicFacts = { ...host.publicFacts, businessPid: ready.pid ?? null }
  writeReceipt({ phase: 'HOST_READY', host: host.publicFacts })
  return { hostId, ready, workRoot }
}

async function handleHostStatus(message) {
  if (host === undefined || host.id !== message.hostId) throw new Error('HOST_STATUS: unknown hostId')
  if (host.exited) throw new Error('HOST_STATUS: Host already exited')
  const hostRequestId = String(message.hostRequestId)
  host.child.stdin.write(`${JSON.stringify({ op: 'status', requestId: hostRequestId })}\n`)
  return await waitForHostRecord(host,
    record => record.m4a0 === 'status' && record.requestId === hostRequestId,
    `Host status ${hostRequestId}`, 30_000)
}

async function handleFinalize(message) {
  let hostStopError
  // A failed native Client close must not prevent the final Host reclaim.
  if (host !== undefined) {
    try {
      if (host.exited) {
        await assertHostGroupGone('FINALIZE')
        if (host.exitResult === undefined) throw new Error('FINALIZE: Host has no real exit record')
      } else {
        await officialStopHost()
      }
    } catch (error) {
      hostStopError = error
    }
  }
  if (message.clientsClosed !== true) {
    writeReceipt({ phase: 'NOT_QUIESCED', errorName: 'FINALIZE_CLIENTS_NOT_CLOSED' })
    throw new Error('FINALIZE: worker did not confirm Clients closed')
  }
  if (hostStopError !== undefined) throw hostStopError
  if (host !== undefined && (host.exitResult?.code !== 0 || host.exitResult?.signal !== null)) {
    throw new Error(`FINALIZE: Host did not exit normally: ${JSON.stringify(host.exitResult)}`)
  }
  if (scene !== undefined) {
    await cleanupSceneRoot('FINALIZE')
  }
  finalized = true
  writeReceipt({ phase: 'FINALIZED', cleanup: { completedAt: now() } })
}

async function handleReport(message) {
  const detail = message.detail === undefined ? undefined : message.detail
  if (message.event === 'client-started' && detail !== undefined) {
    receipt.clients = [...(receipt.clients ?? []), {
      label: detail.label,
      session: detail.session,
      shellPid: detail.shellPid ?? null,
      startedAt: now(),
    }]
    writeReceipt({})
  } else {
    receipt.notes = [...(receipt.notes ?? []), { event: message.event, detail, at: now() }]
    writeReceipt({})
  }
}

async function dispatch(message) {
  if (message === null || typeof message !== 'object' || typeof message.type !== 'string') return
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
  try {
    switch (message.type) {
      case 'BOOTSTRAP': {
        const payload = await handleBootstrap(message)
        if (payload !== undefined && requestId !== undefined) reply(requestId, payload)
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
      case 'STOP_HOST': {
        if (host === undefined || host.id !== message.hostId) throw new Error('STOP_HOST: unknown hostId')
        const result = await officialStopHost()
        if (requestId !== undefined) reply(requestId, { code: result.code, signal: result.signal })
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
