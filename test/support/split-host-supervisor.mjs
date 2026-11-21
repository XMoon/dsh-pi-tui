/**
 * S0 parent-death supervisor.
 *
 * This process is the ONE lifecycle owner for the S0 scene root, the isolated
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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

import { inspectSplitCandidate, createSplitSmokeProfile } from '../../scripts/lib/split-smoke-profile.mjs'
import { writeC1WorkFixture } from '../../scripts/lib/split-smoke-fixtures.mjs'
import { createTestTempDir } from './temp-lifecycle.ts'

const SUPERVISOR_STARTED_AT = new Date().toISOString()
const HOST_READY_TIMEOUT_MS = 180_000
const HOST_SHUTDOWN_GRACE_MS = 30_000
const TERM_GRACE_MS = 3_000
const KILL_GRACE_MS = 3_000
const RUN_ID = process.env.S0_RUN_ID ?? `supervisor-${String(process.pid)}-${String(Date.now())}`

let scene = undefined
let host = undefined
let receiptPath
let receipt = undefined
let installInProgress = false
let cleanupPromise
let finalized = false
let disconnected = false
let queue = Promise.resolve()

function now() {
  return new Date().toISOString()
}

function getPgrp() {
  try {
    return typeof process.getpgrp === 'function' ? process.getpgrp() : undefined
  } catch {
    return undefined
  }
}

function evidenceRoot(tmpBase) {
  const root = join(tmpBase, 's0-resources')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function writeReceipt(update) {
  if (receiptPath === undefined) return
  receipt = { ...receipt, ...update, updatedAt: now() }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
}

function initReceipt(tmpBase) {
  const root = evidenceRoot(tmpBase)
  receiptPath = join(root, `${RUN_ID}.json`)
  receipt = {
    schemaVersion: 1,
    runId: RUN_ID,
    supervisor: { pid: process.pid, pgrp: getPgrp(), startedAt: SUPERVISOR_STARTED_AT },
    phase: 'STARTED',
    sceneRoot: undefined,
    candidate: undefined,
    install: { inProgress: false, completed: false },
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

async function terminateHost(reason) {
  if (host === undefined) return { code: null, signal: null, alreadyGone: true }
  if (host.exited) return host.exitResult ?? { code: host.child.exitCode, signal: host.child.signalCode }
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
  writeReceipt({ host: { ...host.publicFacts, exitCode: host.exitResult.code, exitSignal: host.exitResult.signal } })
  return host.exitResult
}

async function officialStopHost() {
  if (host === undefined) throw new Error('STOP_HOST: no Host exists in this scene')
  if (host.exited) {
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
    try {
      if (host !== undefined && !host.exited) {
        await terminateHost(reason)
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
      writeReceipt({ phase: 'NOT_QUIESCED', cleanup: { reason, error: errorMessage, completedAt: now() } })
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
  if (scene !== undefined) throw new Error('BOOTSTRAP: scene already exists')
  installInProgress = true
  initReceipt(message.tmpBase)
  let root
  let candidate
  let installation
  let c1Work
  try {
    candidate = inspectSplitCandidate(message.tarball)
    root = createTestTempDir('scene-', message.tmpBase)
    writeReceipt({ phase: 'BOOTSTRAP_ROOT_CREATED', sceneRoot: root })
    installation = createSplitSmokeProfile({
      tarball: candidate.tarball,
      targetDshVersion: candidate.targetDshVersion,
      workDir: root,
    })
    c1Work = writeC1WorkFixture(installation.profileDir, root)
    scene = { workDir: root, installation, candidate, c1Work }
  } catch (error) {
    installInProgress = false
    if (root !== undefined) {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup best-effort */ }
    }
    writeReceipt({ phase: 'NOT_QUIESCED', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  installInProgress = false
  if (disconnected || process.connected !== true) {
    await cleanup('worker-disconnected-during-bootstrap')
    return undefined
  }
  writeReceipt({
    phase: 'SCENE_READY',
    candidate: { tarball: candidate.tarball, sha256: candidate.candidateSha256, dshVersion: candidate.targetDshVersion },
    install: { inProgress: false, completed: true },
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
  host = {
    id: hostId,
    child,
    records,
    workRoot,
    exited: false,
    exitResult: undefined,
    publicFacts: { id: hostId, pid: child.pid ?? null, workRoot },
  }
  child.once('close', (code, signal) => {
    if (host === undefined) return
    host.exited = true
    host.exitResult = { code, signal }
    writeReceipt({ host: { ...host.publicFacts, exitCode: code, exitSignal: signal } })
  })
  writeReceipt({ phase: 'HOST_SPAWNED', host: host.publicFacts })
  progress(message.requestId, 'HOST_SPAWNED', { hostId, pid: child.pid ?? null, workRoot })

  let ready
  try {
    ready = await waitForHostRecord(host, record => record.m4a0 === 'ready' || record.m4a0 === 'failure',
      `${message.scenario} Host ready`, HOST_READY_TIMEOUT_MS)
  } catch (error) {
    await terminateHost('START_HOST wait failed').catch(() => undefined)
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
  if (message.clientsClosed !== true) {
    writeReceipt({ phase: 'NOT_QUIESCED', error: 'FINALIZE refused: worker did not confirm Clients closed' })
    throw new Error('FINALIZE: worker did not confirm Clients closed')
  }
  if (host !== undefined && !host.exited) {
    await officialStopHost()
  }
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

process.on('message', message => {
  queue = queue.then(() => dispatch(message)).catch(error => {
    // dispatch already reports request failures; an unexpected failure must
    // remain visible through the receipt and exit, never be swallowed.
    writeReceipt({ phase: 'NOT_QUIESCED', error: error instanceof Error ? error.message : String(error) })
  })
})

process.on('disconnect', () => {
  disconnected = true
  if (finalized) {
    process.exit(0)
    return
  }
  void cleanup('worker-ipc-disconnect').then(result => {
    process.exit(result.clean ? 0 : 1)
  })
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void cleanup(`supervisor-${signal}`).then(result => {
      process.exit(result.clean ? 0 : 1)
    })
  })
}

process.on('uncaughtException', error => {
  writeReceipt({ phase: 'NOT_QUIESCED', error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})

// Keep the IPC channel and message loop alive until FINALIZE or disconnect.
setInterval(() => {}, 1_000)
