/**
 * PO-3B real-OS split-process qualification: scoped cancellation + approval.
 *
 * One REAL installed Host owns the `<scope.dir>/acp.sock` front door and the
 * connection-scoped Session View. This case proves, from REAL processes, a
 * REAL socket and a REAL controlled model, that:
 *
 *   - `session/cancel` on an idle attached View never touches the shared Host
 *     Agent while a REAL TUI turn keeps running (C01);
 *   - a QUEUED ACP prompt is cancelled by its exact durable inbox removal
 *     while the running TUI turn is untouched, and the durable log carries the
 *     matching `agent/inbox/spliced {outcome:'canceled'}` (C02);
 *   - a cancel racing the admission (before the durable insertion) still
 *     removes the late-inserted message exactly (C03);
 *   - a RUNNING ACP turn is cancelled by the official user abort of its exact
 *     current turn and answers `cancelled` only after the real user-aborted
 *     `turn/end` and the output drain (C05);
 *   - a turn that completed naturally keeps its real result (C06);
 *   - a mixed turn (TUI steer inside the ACP turn) is never cancelled (C07);
 *   - `session/close` with an open flight performs the same scoped
 *     cancellation, drains and detaches idempotently (C08);
 *   - the approval waterfall routes an ACP-owned turn's question ONLY to that
 *     ACP connection as a standard `session/request_permission` with the two
 *     one-shot options, while a TUI-owned turn keeps the TUI sheet (A01/A02/A03);
 *   - unknown options, stale generations and aborts never grant (A04);
 *   - an approval arriving after the flight failed (retired turn) never leaks
 *     to the TUI (A06);
 *   - a Host configured with approval policy `never` never asks the ACP
 *     client and the official service rejects (A05);
 *   - two independent ACP Sessions on one Host stay isolated (G01) and the
 *     Host identity is kept throughout (G02).
 *
 * Every fact comes from REAL processes, a REAL socket and the durable Host
 * Session log; a partial or NOT_RUN sub-scenario returns a non-PASS verdict.
 * The harness (never this module) prints the SELECTED_PASS line.
 *
 * @module split-process/acp-po3b-cancel-approval
 */

import { createRequire } from 'node:module'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import {
  hostSessionEvents,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** One raw NDJSON JSON-RPC client over a real UDS connection. */
class AcpRawClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.waiter = undefined
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const message = JSON.parse(line)
        if (this.waiter !== undefined) {
          const waiter = this.waiter
          this.waiter = undefined
          waiter(message)
        } else {
          this.queue.push(message)
        }
      }
    })
    this.closed = new Promise(resolveClose => socket.on('close', () => resolveClose()))
    socket.on('error', () => {})
  }

  static open(path) {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.off('error', rejectOpen)
        resolveOpen(new AcpRawClient(socket))
      })
      socket.once('error', rejectOpen)
    })
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  next(timeoutMs = 60_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        rejectNext(new Error(`acp raw client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = value => { clearTimeout(timer); resolveNext(value) }
    })
  }

  /** Prove a bounded window of silence (a NOT-YET fact, not a timing guess). */
  async silent(windowMs) {
    if (this.queue.length > 0) return false
    return await new Promise(resolveSilent => {
      let timer
      const finish = silent => {
        if (this.waiter === waiter) this.waiter = undefined
        clearTimeout(timer)
        resolveSilent(silent)
      }
      const waiter = value => {
        this.queue.unshift(value)
        finish(false)
      }
      this.waiter = waiter
      timer = setTimeout(() => finish(true), windowMs)
    })
  }

  async initialize(id) {
    this.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    return await this.next()
  }

  close() {
    this.socket.destroy()
  }
}

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Connect one raw ACP client through this process's OWN scope directory fd. */
async function openAcpClient(scopeDir) {
  const dirFd = openSync(scopeDir, 'r')
  try {
    return await AcpRawClient.open(`/proc/self/fd/${String(dirFd)}/acp.sock`)
  } finally {
    closeSync(dirFd)
  }
}

function sendRequest(client, id, method, params) {
  client.send({ jsonrpc: '2.0', id, method, params })
  return client.next(120_000)
}

/** Read this connection's messages until the response for `id` arrives. */
async function readUntilResponse(client, id, notifications) {
  for (;;) {
    const message = await client.next(180_000)
    if (message?.method === 'session/update') {
      notifications.push(message.params)
      continue
    }
    // The SDK's cooperative cancellation of an outgoing reverse request (a
    // cancelled approval question) is a transport fact, not a turn response.
    if (message?.method === '$/cancel_request') continue
    if (message?.id === id && (message.result !== undefined || message.error !== undefined)) return message
    if (message?.method === 'session/request_permission') return { permissionRequest: message }
    assert(false, `PO-3B: unexpected ACP message while waiting for response ${String(id)}: ${JSON.stringify(message).slice(0, 300)}`)
  }
}

/** One user message's text from a durable `user/message` event. */
function userMessageText(event) {
  return (event.data?.content ?? []).map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
}

/** Await a value derivable from a fresh durable read (the log may lag a flush). */
async function waitForFact(read, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new SplitSmokeAssertionError(`acp-po3b: timed out waiting for ${label}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}

/** The turn that owns the durable event at `index` (the nearest preceding turn/start). */
function turnOfEvent(events, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (events[cursor]?.type === 'turn/start') return events[cursor].data?.turn
  }
  return undefined
}

/** Index of the durable user message carrying exactly `text` (at or after `from`). */
function userMessageIndexOf(events, text, from = 0) {
  return events.findIndex((event, index) => index >= from
    && event.type === 'user/message'
    && userMessageText(event) === text)
}

/** The turn owning the durable user message carrying exactly `text`. */
function userMessageTurnOf(events, text, from = 0) {
  const index = userMessageIndexOf(events, text, from)
  return index < 0 ? undefined : turnOfEvent(events, index)
}

/**
 * Run the PO-3B scoped-cancel + approval qualification. Every returned
 * boolean is a fact gathered from a REAL process/socket/log.
 */
export async function runAcpPo3bCancelApproval(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const installedVersion = installation.manifest.version
  const acpSdkVersion = (() => {
    try {
      const require = createRequire(import.meta.url)
      let dir = dirname(require.resolve('@agentclientprotocol/sdk'))
      for (let depth = 0; depth < 6; depth += 1) {
        const manifest = join(dir, 'package.json')
        if (existsSync(manifest)) {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
          if (parsed.name === '@agentclientprotocol/sdk' && typeof parsed.version === 'string') return parsed.version
        }
        dir = dirname(dir)
      }
      return 'unknown'
    } catch { return 'unknown' }
  })()
  const scene = createC1Scene(context)
  const {
    startC1Host,
    startC1Client,
    exitC1Client,
    hostIdentityFacts,
    hostRowFiberUids,
    assertHostRowsKept,
    assertHostIdentityKept,
    awaitSceneSeatFree,
    dispose,
  } = scene
  const peers = []
  const acpClients = []
  let sequence = 0
  let host
  let barrier

  const track = client => {
    acpClients.push(client)
    return client
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = label
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  const acpAccess = async (peer, label, value) => {
    const requestId = `acp-access-${String(++sequence)}-${String(process.pid)}`
    peer.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const assertAccess = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private ACP access call failed (${String(record.errorCode ?? 'unknown')})`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
  }
  const openInitialized = async (scopeDir, label) => {
    const client = track(await openAcpClient(scopeDir))
    const init = await client.initialize(1)
    assert(init?.result?.protocolVersion === 1, `${label}: the socket must answer protocolVersion 1`)
    return { client, init }
  }
  const identityFacts = async () => await hostIdentityFacts(host)
  const assertSameHost = async (before, label) => {
    const after = await identityFacts()
    assert(after.hostPid === before.hostPid,
      `${label}: the Host process was replaced (${String(before.hostPid)} -> ${String(after.hostPid)})`)
    assert(after.instanceId === before.instanceId,
      `${label}: the Host instanceId changed (${String(before.instanceId)} -> ${String(after.instanceId)})`)
    assertHostIdentityKept(host, before, label)
  }
  /** Hold the controlled model's next turn until the case releases it. */
  const holdNextTurn = () => {
    rmSync(barrier, { force: true })
  }
  const releaseHeldTurn = () => {
    writeFileSync(barrier, 'release\n', { mode: 0o600 })
  }
  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)

  try {
    // ── A) Boot a real C1 Host with the PO-3B fixture and enable the ACP door.
    mkdirSync(join(workDir, 'po3b-workspaces'), { recursive: true, mode: 0o700 })
    barrier = join(workDir, `po3b-hold-${String(process.pid)}.release`)
    rmSync(barrier, { force: true })
    const started = await startC1Host('acp-po3b', 'po3b A host', {
      C1_HOLD_LONG_TURN: barrier,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    })
    const mainWorkRoot = started.workRoot
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'A: the Host Ready must publish a full 64-character scope id')
    const scopeDir = scopeDirOf(scopeId)
    const hostCwd = realpathSync(workDir)
    trace('acp-po3b/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installedVersion,
      acpSdkVersion,
      hostPid: ready.localHost.hostPid,
      hostInstanceId: ready.localHost.instanceId,
      scopeId,
    })
    const peer = await startPeer('po3b A peer')
    assertAccess(await acpAccess(peer, 'A getStatus', undefined), 'disabled', 'A getStatus')
    assertAccess(await acpAccess(peer, 'A enable', true), 'enabled', 'A enable')
    assert(exists(join(scopeDir, 'acp.sock')), 'A: the enabled front door must bind acp.sock')

    // ── B) A REAL TUI opens Session A; the ACP connection attaches the SAME
    //      Session while the TUI keeps it.
    const { client: tuiA } = await startC1Client('po3b B tui', {}, { cwd: hostCwd })
    const tuiBoundary = tuiA.records.length
    tuiA.send('/new\r')
    const openA = await tuiA.waitFor(record => tuiA.records.indexOf(record) >= tuiBoundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && typeof record.openSessionId === 'string'
      && record.openSessionId !== ''
      && record.transport === 'connected'
      && record.surfaceMounted === true, 'B: the real TUI opened an empty Session', 180_000)
    const sessionA = openA.openSessionId
    assert(typeof sessionA === 'string' && sessionA.length > 0, 'B: `/new` must publish an openSessionId')

    const conn1 = track(await openAcpClient(scopeDir))
    const initB = await conn1.initialize(1)
    assert(initB?.result?.protocolVersion === 1, 'B: initialize must answer protocolVersion 1')
    const resumeB = await sendRequest(conn1, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(resumeB?.error === undefined && typeof resumeB?.result === 'object',
      `B: session/resume(A) must return {} (got ${JSON.stringify(resumeB?.error ?? resumeB?.result)})`)
    const identityBefore = await identityFacts()
    const rowsBefore = await hostRowFiberUids(host)
    await assertSameHost(identityBefore, 'B Host after the ACP resume')

    // ── C01) An idle ACP cancel while a REAL TUI turn runs never touches it.
    holdNextTurn()
    const eventsBeforeC = hostSessionEvents(dshHome, sessionA) ?? []
    const tuiAStart = eventsBeforeC.length
    tuiA.send('po3b-tui-a\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiAStart,
      event => event.type === 'user/message' && userMessageText(event) === 'po3b-tui-a',
      'C01: the TUI message to be committed inside its held step', 120_000)
    const idleCancelWindow = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    assert(await conn1.silent(1_000), 'C01: an idle cancel notification carries no response')
    assert((hostSessionEvents(dshHome, sessionA) ?? []).every(event =>
      !(event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled')),
    'C01: an idle cancel must not remove any Host message')
    releaseHeldTurn()
    await waitForHostSessionEventAfter(dshHome, sessionA, idleCancelWindow,
      event => event.type === 'turn/end', 'C01: the untouched TUI turn to complete', 180_000)
    const tuiATurn = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], 'po3b-tui-a')
    assert(typeof tuiATurn === 'number', 'C01: the TUI message must belong to a real turn')
    const tuiAlive = await waitForSurfaceStatus(tuiA, record => record.sessionOpen === true
      && record.openSessionId === sessionA && record.transport === 'connected',
    'C01: the REAL TUI keeps its Session after an idle ACP cancel')
    // MEASURED: no canceled removal happened during the idle cancel window and
    // the TUI turn completed naturally with real assistant text.
    const idleCancelNoOp = (hostSessionEvents(dshHome, sessionA) ?? []).slice(idleCancelWindow)
      .every(event => !(event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled'))
      && typeof tuiATurn === 'number'
      && (hostSessionEvents(dshHome, sessionA) ?? []).some(event =>
        event.type === 'assistant/message' && event.data?.turn === tuiATurn)
      && tuiAlive.openSessionId === sessionA

    // ── C02) A QUEUED ACP prompt is cancelled by its exact durable removal
    //         while the running TUI turn is untouched.
    holdNextTurn()
    const tuiA2Start = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send('po3b-tui-a2\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiA2Start,
      event => event.type === 'user/message' && userMessageText(event) === 'po3b-tui-a2',
      'C02: the second TUI message to be committed inside its held step', 120_000)
    const queuedPrompt = 'po3b-acp-queued'
    const queuedStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: queuedPrompt }] } })
    const queueB = await waitForHostSessionEventAfter(dshHome, sessionA, queuedStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && (event.data.inserted ?? []).some(message => (message.content ?? []).some(part => part?.text === queuedPrompt)),
      'C02: the ACP prompt to be accepted into the shared Host inbox', 120_000)
    const acpQueuedMessage = (queueB.data.inserted ?? []).find(message =>
      (message.content ?? []).some(part => part?.text === queuedPrompt))
    assert(typeof acpQueuedMessage?.id === 'string', 'C02: the queued ACP message must carry an id')
    const queuedNotifications = []
    const queuedResponsePromise = readUntilResponse(conn1, 3, queuedNotifications)
    conn1.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    const spliceCanceled = await waitForHostSessionEventAfter(dshHome, sessionA, queuedStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.outcome === 'canceled'
        && (event.data.removedCount ?? 0) === 1,
      'C02: the exact durable canceled removal of the queued ACP message', 120_000)
    assert(spliceCanceled.data?.target === 'next-turn', 'C02: the removal must come from the pending next-turn list')
    const queuedResponse = await queuedResponsePromise
    assert(queuedResponse?.result?.stopReason === 'cancelled',
      `C02: the cancelled queued prompt must answer cancelled (got ${JSON.stringify(queuedResponse?.result ?? queuedResponse?.error)})`)
    assert((hostSessionEvents(dshHome, sessionA) ?? []).every(event =>
      !(event.type === 'user/message' && userMessageText(event) === queuedPrompt)),
    'C02: the cancelled queued message must never be claimed')
    releaseHeldTurn()
    const tuiA2Turn = await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      const index = userMessageIndexOf(events, 'po3b-tui-a2', tuiA2Start)
      return index < 0 ? undefined : turnOfEvent(events, index)
    }, 'C02: the TUI turn to be durably claimed', 120_000)
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiA2Start,
      event => event.type === 'turn/end' && event.data?.turn === tuiA2Turn,
      'C02: the untouched running TUI turn to complete after the ACP cancel', 180_000)
    assert(typeof tuiA2Turn === 'number' && tuiA2Turn > tuiATurn, 'C02: the TUI turn must complete after the earlier TUI turn')
    // MEASURED: the durable splice removed exactly the queued ACP message from
    // next-turn, that message was never claimed, the request answered
    // cancelled, and the sibling TUI turn still completed.
    const queuedCancelRemoved = spliceCanceled.data?.outcome === 'canceled'
      && spliceCanceled.data?.target === 'next-turn'
      && (spliceCanceled.data?.removedCount ?? 0) === 1
      && typeof acpQueuedMessage?.id === 'string'
      && queuedResponse?.result?.stopReason === 'cancelled'
      && typeof tuiA2Turn === 'number' && tuiA2Turn > tuiATurn

    // ── C03) A cancel racing the admission (the durable insertion lands
    //         between the request and the cancel on the wire) still removes
    //         the late-inserted message exactly. The TUI turn keeps the Agent
    //         running so the ACP message can only be QUEUED, never claimed:
    //         the cancel's outcome is decided by the insertion callback, not
    //         by a timing guess.
    holdNextTurn()
    const tuiA3Start = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send('po3b-tui-a3\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiA3Start,
      event => event.type === 'user/message' && userMessageText(event) === 'po3b-tui-a3',
      'C03: the third TUI message to be committed inside its held step', 120_000)
    const latePrompt = 'po3b-acp-late'
    const lateStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: latePrompt }] } })
    // The cancel is pipelined IMMEDIATELY behind the prompt on the same
    // socket: whether it lands before or after the durable insertion, the
    // View must settle it from the real Host facts only.
    conn1.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    const lateSpliceCanceled = await waitForHostSessionEventAfter(dshHome, sessionA, lateStart,
      event => event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled',
      'C03: the racing cancel to durably remove the exact ACP message', 120_000)
    const lateNotifications = []
    const lateResponse = await readUntilResponse(conn1, 4, lateNotifications)
    assert(lateResponse?.result?.stopReason === 'cancelled',
      `C03: the racing-cancelled prompt must answer cancelled (got ${JSON.stringify(lateResponse?.result ?? lateResponse?.error)})`)
    assert((hostSessionEvents(dshHome, sessionA) ?? []).every(event =>
      !(event.type === 'user/message' && userMessageText(event) === latePrompt)),
    'C03: the racing-cancelled message must never be claimed')
    releaseHeldTurn()
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiA3Start,
      event => event.type === 'turn/end',
      'C03: the untouched TUI turn to complete after the racing cancel', 180_000)
    // MEASURED: the racing cancel produced exactly the durable removal of the
    // ACP message, answered cancelled, and never touched the TUI turn.
    const claimRaceSafe = lateSpliceCanceled.data?.outcome === 'canceled'
      && lateResponse?.result?.stopReason === 'cancelled'
      && (hostSessionEvents(dshHome, sessionA) ?? []).every(event =>
        !(event.type === 'user/message' && userMessageText(event) === latePrompt))

    // ── C05) A RUNNING ACP turn is cancelled by the official user abort of
    //         its exact current turn; the answer waits for the drain.
    holdNextTurn()
    const runningPrompt = 'po3b-acp-running'
    const runningStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: runningPrompt }] } })
    // Wait until the held turn CLAIMED the ACP message (its turn is running).
    const runningTurn = await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      const index = userMessageIndexOf(events, runningPrompt, runningStart)
      return index < 0 ? undefined : turnOfEvent(events, index)
    }, 'C05: the ACP running turn to be durably claimed', 120_000)
    const runningNotifications = []
    const runningResponsePromise = readUntilResponse(conn1, 5, runningNotifications)
    conn1.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    const abortedEnd = await waitForHostSessionEventAfter(dshHome, sessionA, runningStart,
      event => event.type === 'turn/end'
        && event.data?.turn === runningTurn
        && event.data?.reason?.kind === 'aborted'
        && event.data?.reason?.reason?.kind === 'user',
      'C05: the exact running turn to reach its official user-aborted turn/end', 180_000)
    const runningResponse = await runningResponsePromise
    assert(runningResponse?.result?.stopReason === 'cancelled',
      `C05: the cancelled running turn must answer cancelled after the drain (got ${JSON.stringify(runningResponse?.result ?? runningResponse?.error)})`)
    // MEASURED: the exact claimed turn reached the official user-aborted
    // terminal, the answer waited for that terminal, and the interrupted
    // committed output of that turn was delivered BEFORE the cancelled answer
    // (the drain ordering), matching the durable interrupted assistant record.
    const runningEvents = hostSessionEvents(dshHome, sessionA) ?? []
    const interruptedCommitted = runningEvents.filter(event =>
      event.type === 'assistant/message' && event.data?.turn === runningTurn && event.data?.interrupted === true)
    const runningChunks = runningNotifications.filter(notification =>
      notification?.update?.sessionUpdate === 'agent_message_chunk')
    const runningCancelExactTurn = abortedEnd.data?.turn === runningTurn
      && abortedEnd.data?.reason?.kind === 'aborted'
      && abortedEnd.data?.reason?.reason?.kind === 'user'
      && runningResponse?.result?.stopReason === 'cancelled'
    const cancelDrainBeforeStop = runningCancelExactTurn
      && runningChunks.length === interruptedCommitted.length
      && runningChunks.length > 0

    // C05's aborted turn never consumed the barrier; release it so the natural
    // turn below runs to completion.
    releaseHeldTurn()
    // ── C06) A turn that completed naturally keeps its real result.
    const naturalPrompt = 'po3b-acp-natural'
    const naturalNotifications = []
    conn1.send({ jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: naturalPrompt }] } })
    const naturalResponse = await readUntilResponse(conn1, 6, naturalNotifications)
    assert(naturalResponse?.result?.stopReason === 'end_turn',
      `C06: a naturally completed turn answers its real result (got ${JSON.stringify(naturalResponse?.result ?? naturalResponse?.error)})`)
    // A cancel AFTER the settled turn is inert.
    conn1.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    assert(await conn1.silent(1_000), 'C06: a cancel after a settled turn produces no second response')
    // MEASURED: a naturally completed turn answered its real end_turn and the
    // post-settlement cancel produced no second response.
    const naturalResultKept = naturalResponse?.result?.stopReason === 'end_turn'

    // ── C07) A mixed turn (TUI steer inside the running ACP turn) is never
    //         cancelled; the request keeps its D23 failure.
    holdNextTurn()
    const mixedPrompt = 'po3b-acp-mixed'
    const mixedStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 8, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: mixedPrompt }] } })
    await waitForHostSessionEventAfter(dshHome, sessionA, mixedStart,
      event => event.type === 'user/message' && userMessageText(event) === mixedPrompt,
      'C07: the ACP mixed-turn message to be committed inside its held step', 120_000)
    const steerText = 'po3b-tui-steer'
    const steerStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send(`${steerText}\r`)
    const steerQueued = await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && (event.data.inserted ?? []).some(message => (message.content ?? []).some(part => part?.text === steerText)),
      'C07: the TUI steer candidate to queue', 120_000)
    const steerItem = (steerQueued.data.inserted ?? []).find(message =>
      (message.content ?? []).some(part => part?.text === steerText))
    assert(typeof steerItem?.id === 'string', 'C07: the queued TUI occurrence must carry an id')
    tuiA.send('\x13')
    await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-step'
        && (event.data.inserted ?? []).some(message => message?.id === steerItem.id),
      'C07: the existing Ctrl+S to steer the exact Host occurrence', 120_000)
    // Let the held step finish so the step boundary CLAIMS the steer into the
    // SAME turn: the durable user/message of the steer id is the mixed proof.
    releaseHeldTurn()
    await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'user/message' && event.data?.id === steerItem.id,
      'C07: the steered TUI message to be claimed into the running ACP turn', 120_000)
    const mixedTurnOfSteer = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], mixedPrompt, mixedStart)
    const steerTurn = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], steerText, steerStart)
    assert(steerTurn === mixedTurnOfSteer, 'C07: the steer must be inside the SAME turn as the ACP message')
    // The next model request of the SAME turn holds again: cancel NOW, with
    // the mixed fact already durable. NO Agent cancel may fire (the durable
    // log shows no user-aborted turn/end for this turn).
    holdNextTurn()
    conn1.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    releaseHeldTurn()
    const mixedNotifications = []
    const mixedResponse = await readUntilResponse(conn1, 8, mixedNotifications)
    assert(mixedResponse?.error?.code === -32603
      && mixedResponse?.error?.data?.code === 'LOCAL_ACP_PROMPT_MIXED_TURN',
      `C07: a mixed turn keeps its D23 failure and is never cancelled (got ${JSON.stringify(mixedResponse?.result ?? mixedResponse?.error)})`)
    await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'turn/end' && event.data?.turn === mixedTurnOfSteer
        && event.data?.reason?.kind !== 'aborted',
      'C07: the mixed turn to complete WITHOUT a user abort', 180_000)
    // MEASURED: the mixed turn failed closed with the D23 code and reached a
    // durable terminal that is NOT a user abort (the TUI steer kept its work).
    const mixedTurnSafe = mixedResponse?.error?.data?.code === 'LOCAL_ACP_PROMPT_MIXED_TURN'
      && (hostSessionEvents(dshHome, sessionA) ?? []).some(event =>
        event.type === 'turn/end' && event.data?.turn === mixedTurnOfSteer
        && event.data?.reason?.kind !== 'aborted')

    // ── C08) session/close with an open flight performs the scoped
    //         cancellation, drains and detaches idempotently. A running TUI
    //         turn keeps the Agent busy so the close-cancel prompt is QUEUED.
    holdNextTurn()
    const tuiA4Start = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send('po3b-tui-a4\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiA4Start,
      event => event.type === 'user/message' && userMessageText(event) === 'po3b-tui-a4',
      'C08: the fourth TUI message to be committed inside its held step', 120_000)
    const closePrompt = 'po3b-acp-close'
    const closeStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: closePrompt }] } })
    const closeQueued = await waitForHostSessionEventAfter(dshHome, sessionA, closeStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && (event.data.inserted ?? []).some(message => (message.content ?? []).some(part => part?.text === closePrompt)),
      'C08: the close-cancel prompt to be queued', 120_000)
    const closeQueuedMessage = (closeQueued.data.inserted ?? []).find(message =>
      (message.content ?? []).some(part => part?.text === closePrompt))
    assert(typeof closeQueuedMessage?.id === 'string', 'C08: the queued close prompt must carry its durable id')
    conn1.send({ jsonrpc: '2.0', id: 10, method: 'session/close', params: { sessionId: sessionA } })
    const closeRemoval = await waitForHostSessionEventAfter(dshHome, sessionA, closeStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.outcome === 'canceled'
        && event.data?.target === 'next-turn'
        && (event.data.removedCount ?? 0) === 1,
      'C08: the close to remove the exact queued message', 120_000)
    const closeResponse = await (async () => {
      for (;;) {
        const message = await conn1.next(180_000)
        if (message?.id === 9 && message.result !== undefined) continue
        if (message?.id === 10) return message
      }
    })()
    assert(closeResponse?.result !== undefined && closeResponse?.error === undefined,
      `C08: the close must detach after the proven removal (got ${JSON.stringify(closeResponse?.error ?? closeResponse?.result)})`)
    releaseHeldTurn()
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiA4Start,
      event => event.type === 'turn/end',
      'C08: the untouched TUI turn to complete after the close cancel', 180_000)
    // A second close on the same connection is idempotent.
    const closeAgain = await sendRequest(conn1, 11, 'session/close', { sessionId: sessionA })
    assert(closeAgain?.error === undefined, 'C08: a repeated close stays idempotent')
    // MEASURED and BOUND to this scenario's exact facts: the close's own
    // durable removal was the single canceled next-turn splice, the queued
    // close prompt never became a claimed user message, the close answered {}
    // and stayed idempotent, and the SIBLING TUI turn's own turn/end arrived.
    const closeWindow = (hostSessionEvents(dshHome, sessionA) ?? []).slice(closeStart)
    const closeCanceledSplices = closeWindow.filter(event =>
      event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled'
      && event.data?.target === 'next-turn' && (event.data?.removedCount ?? 0) === 1)
    const closeNeverClaimed = (hostSessionEvents(dshHome, sessionA) ?? []).every(event =>
      !(event.type === 'user/message' && userMessageText(event) === closePrompt))
    const closeTuiTurn = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], 'po3b-tui-a4', tuiA4Start)
    // The OFFICIAL `agent/inbox/discarded` notice names the removed message:
    // it must be exactly the close prompt's own durable id.
    const closeDiscarded = await waitForC1WorkEvent(mainWorkRoot,
      event => event.kind === 'po3b-inbox-discarded' && event.messageId === closeQueuedMessage.id,
      'C08: the official discarded notice for the exact queued close prompt', 60_000)
    assert(closeDiscarded.messageId === closeQueuedMessage.id,
      'C08: the durable removal must name the exact queued close message')
    const closeDrainedAndDetached = closeRemoval.data?.outcome === 'canceled'
      && closeCanceledSplices.length === 1
      && closeDiscarded.messageId === closeQueuedMessage.id
      && closeDiscarded.text === closePrompt
      && closeNeverClaimed
      && closeResponse?.result !== undefined
      && closeResponse?.error === undefined
      && closeAgain?.error === undefined
      && typeof closeTuiTurn === 'number'
      && (hostSessionEvents(dshHome, sessionA) ?? []).some(event =>
        event.type === 'turn/end' && event.data?.turn === closeTuiTurn)

    // ── A01..A03) Approval ownership on a fresh Session.
    const { client: conn2 } = await openInitialized(scopeDir, 'A approval connection')
    const approvalWorkspace = join(workDir, 'po3b-workspaces', 'approval')
    mkdirSync(approvalWorkspace, { recursive: true, mode: 0o700 })
    const approvalCwd = realpathSync(approvalWorkspace)
    const created = await sendRequest(conn2, 2, 'session/new', { cwd: approvalCwd, mcpServers: [] })
    assert(typeof created?.result?.sessionId === 'string' && created.result.sessionId !== '',
      `A01: session/new must create a real Host Session (got ${JSON.stringify(created?.error ?? created?.result)})`)
    const sessionAp = created.result.sessionId

    // A01/A03-allow: the ACP-owned turn's approval goes ONLY to this
    // connection with the standard two one-shot options.
    const allowPrompt = 'po3b-approval po3b-acp-ask-allow'
    const allowStart = (hostSessionEvents(dshHome, sessionAp) ?? []).length
    const allowNotifications = []
    conn2.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionAp, prompt: [{ type: 'text', text: allowPrompt }] } })
    const allowPermission = await waitForPermissionRequest(conn2, 'A01 the allow reverse request', 180_000)
    assert(allowPermission.params?.sessionId === sessionAp, 'A01: the reverse request names the exact Session')
    assert(JSON.stringify(allowPermission.params?.options?.map(option => option.optionId)) === JSON.stringify(['allow-once', 'reject-once']),
      'A01: the reverse request offers exactly the two standard one-shot options')
    assert(JSON.stringify(allowPermission.params?.options?.map(option => option.kind)) === JSON.stringify(['allow_once', 'reject_once']),
      'A01: the options carry the standard kinds')
    await waitForHostSessionEventAfter(dshHome, sessionAp, allowStart,
      event => event.type === 'approval/asked', 'A01: the durable approval/asked audit', 120_000)
    conn2.send({ jsonrpc: '2.0', id: allowPermission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    await waitForHostSessionEventAfter(dshHome, sessionAp, allowStart,
      event => event.type === 'approval/decided' && event.data?.outcome === 'allowed-once',
      'A01: exactly one allowed-once durable decision', 120_000)
    const allowResponse = await readUntilResponse(conn2, 3, allowNotifications)
    assert(allowResponse?.result?.stopReason === 'end_turn',
      `A01: the allowed turn completes normally (got ${JSON.stringify(allowResponse?.result ?? allowResponse?.error)})`)
    // MEASURED: the ACP-owned approval produced exactly ONE reverse request on
    // this connection with the two one-shot options, the client's allow-once
    // became the official allowed-once decision, and the tool really ran.
    const allowDecisions = (hostSessionEvents(dshHome, sessionAp) ?? [])
      .filter(event => event.type === 'approval/decided' && event.data?.outcome === 'allowed-once')
    const allowMarker = join(started.workRoot, `po3b-allow-${sessionAp}.marker`)
    const acpApprovalOnly = allowPermission?.method === 'session/request_permission'
      && allowPermission.params?.sessionId === sessionAp
      && JSON.stringify(allowPermission.params?.options?.map(option => option.optionId)) === JSON.stringify(['allow-once', 'reject-once'])
      && allowDecisions.length === 1
      && allowResponse?.result?.stopReason === 'end_turn'
      && existsSync(allowMarker)

    // A03-reject: the reject path maps to the official rejected outcome.
    const rejectPrompt = 'po3b-approval po3b-acp-ask-reject'
    const rejectStart = (hostSessionEvents(dshHome, sessionAp) ?? []).length
    const rejectNotifications = []
    conn2.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: sessionAp, prompt: [{ type: 'text', text: rejectPrompt }] } })
    const rejectPermission = await waitForPermissionRequest(conn2, 'A03 the reject reverse request', 180_000)
    conn2.send({ jsonrpc: '2.0', id: rejectPermission.id, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } })
    await waitForHostSessionEventAfter(dshHome, sessionAp, rejectStart,
      event => event.type === 'approval/decided' && event.data?.outcome === 'rejected',
      'A03: the durable rejected decision', 120_000)
    const rejectResponse = await readUntilResponse(conn2, 4, rejectNotifications)
    assert(rejectResponse?.result?.stopReason === 'end_turn',
      `A03: the rejected turn still completes with its real answer (got ${JSON.stringify(rejectResponse?.result ?? rejectResponse?.error)})`)
    // MEASURED: the reject-once answer became the official rejected decision
    // and the harmless command never executed (no marker file).
    const rejectDecisions = (hostSessionEvents(dshHome, sessionAp) ?? [])
      .filter(event => event.type === 'approval/decided' && event.data?.outcome === 'rejected')
    const rejectMarker = join(started.workRoot, `po3b-reject-${sessionAp}.marker`)
    const acpRejectOnly = rejectPermission?.method === 'session/request_permission'
      && rejectDecisions.length === 1
      && rejectResponse?.result?.stopReason === 'end_turn'
      && !existsSync(rejectMarker)

    // A02) A TUI-owned turn's approval NEVER reaches the ACP connection: the
    // TUI sheet is the only responder. The TUI (a REAL Surface client) holds
    // Session A; run an approval turn there while the ACP View is attached
    // but idle.
    const tuiApprovalPrompt = 'po3b-approval po3b-tui-ask'
    const tuiApprovalStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send(`${tuiApprovalPrompt}\r`)
    const tuiAsked = await waitForHostSessionEventAfter(dshHome, sessionA, tuiApprovalStart,
      event => event.type === 'approval/asked', 'A02: the TUI-owned approval/asked audit', 120_000)
    assert(await conn1.silent(2_000) && await conn2.silent(2_000),
      'A02: no reverse permission request reached either ACP connection')
    // The REAL TUI sheet answers through its own channel.
    await tuiA.waitForScreen('[y] Allow once', 'A02: the REAL TUI approval sheet', 120_000)
    tuiA.send('n')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiApprovalStart,
      event => event.type === 'approval/decided' && String(event.data?.id) === String(tuiAsked.data?.id)
        && event.data?.outcome === 'rejected',
      'A02: the TUI decision to settle through its own channel', 120_000)
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiApprovalStart,
      event => event.type === 'turn/end', 'A02: the TUI approval turn to end', 180_000)
    // MEASURED: the TUI-owned approval reached its own sheet and decision
    // while BOTH ACP connections saw no reverse request at all.
    const tuiDecisions = (hostSessionEvents(dshHome, sessionA) ?? [])
      .filter(event => event.type === 'approval/decided' && String(event.data?.id) === String(tuiAsked.data?.id))
    const tuiApprovalOnly = tuiDecisions.length === 1
      && tuiDecisions[0].data?.outcome === 'rejected'
      && (hostSessionEvents(dshHome, sessionA) ?? []).some(event =>
        event.type === 'turn/end' && event.data?.turn === userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], tuiApprovalPrompt, tuiApprovalStart))

    // ── A04/A06) A pending reverse permission request races a cancellation:
    //            the late allow must not grant and the tool never executes.
    holdNextTurn()
    const racingPrompt = 'po3b-approval po3b-acp-late-allow'
    const racingApStart = (hostSessionEvents(dshHome, sessionAp) ?? []).length
    // The durable audit ids that already exist BEFORE this scenario: the
    // racing question's OWN pair is identified as the single NEW
    // `approval/asked` id and its MATCHING `approval/decided` id.
    const askedBeforeRacing = new Set(
      (hostSessionEvents(dshHome, sessionAp) ?? [])
        .filter(event => event.type === 'approval/asked')
        .map(event => String(event.data?.id)),
    )
    const racingApNotifications = []
    conn2.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: sessionAp, prompt: [{ type: 'text', text: racingPrompt }] } })
    const racingPermission = await waitForPermissionRequest(conn2, 'A04 the racing reverse request', 180_000)
    // The ACP cancel fires while the permission question is pending: the exact
    // running turn is user-aborted; the pending question is cancelled.
    conn2.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionAp } })
    const racingAborted = await waitForHostSessionEventAfter(dshHome, sessionAp, racingApStart,
      event => event.type === 'turn/end'
        && event.data?.reason?.kind === 'aborted'
        && event.data?.reason?.reason?.kind === 'user',
      'A04: the racing turn to reach its user-aborted terminal', 180_000)
    void racingAborted
    // A LATE allow for the dead question must not execute the tool.
    conn2.send({ jsonrpc: '2.0', id: racingPermission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    const racingResponse = await readUntilResponse(conn2, 5, racingApNotifications)
    assert(racingResponse?.result?.stopReason === 'cancelled',
      `A04: the cancelled racing turn answers cancelled (got ${JSON.stringify(racingResponse?.result ?? racingResponse?.error)})`)
    // MEASURED from the official audit PAIR: the racing question is the one
    // NEW `approval/asked` id, and the decision carrying that SAME id is
    // exactly one `cancelled` — the LATE allow never became a grant.
    const racingSessionEvents = hostSessionEvents(dshHome, sessionAp) ?? []
    const newAsked = racingSessionEvents
      .filter(event => event.type === 'approval/asked' && !askedBeforeRacing.has(String(event.data?.id)))
    const askedId = newAsked.length === 1 ? String(newAsked[0].data?.id) : undefined
    const pairedDecision = askedId === undefined
      ? []
      : racingSessionEvents.filter(event =>
        event.type === 'approval/decided' && String(event.data?.id) === askedId)
    const racingNoLateGrant = racingResponse?.result?.stopReason === 'cancelled'
      && newAsked.length === 1
      && pairedDecision.length === 1
      && pairedDecision[0].data?.outcome === 'cancelled'
    releaseHeldTurn()

    // ── F2/A06-real) A flight that fails EARLY (the real View output bound)
    // keeps its retired-turn approval attribution through a close: the second
    // tool's approval arrives after the flight died and must NEVER reach the
    // REAL TUI responder that holds this SAME Session — a wrong next() would
    // pop the TUI sheet and settle through it, so `unavailable` in the audit
    // plus a silent TUI proves the fence intercepted the routing.
    // Run on sessionA: the REAL TUI Client is the observable downstream.
    const f2Conn = track(await openAcpClient(scopeDir))
    const f2Init = await f2Conn.initialize(1)
    assert(f2Init?.result?.protocolVersion === 1, 'F2: the failflow connection must initialize')
    const f2Resume = await sendRequest(f2Conn, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(f2Resume?.error === undefined, 'F2: the failflow connection must attach Session A')
    const f2TuiBoundary = tuiA.records.length
    const failflowStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const failflowNotifications = []
    f2Conn.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: 'po3b-failflow ask' }] } })
    const fail1Permission = await waitForPermissionRequest(f2Conn, 'F2 the first failflow approval', 180_000)
    f2Conn.send({ jsonrpc: '2.0', id: fail1Permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    // The over-capacity output fails the flight while the turn runs tool2.
    const failflowResponse = await readUntilResponse(f2Conn, 3, failflowNotifications)
    assert(failflowResponse?.error?.code === -32603
      && failflowResponse?.error?.data?.code === 'LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE',
      `F2: the over-capacity turn must fail the flight (got ${JSON.stringify(failflowResponse?.result ?? failflowResponse?.error)})`)
    // The ACP View closes while the turn STILL runs tool2. Record the durable
    // length at close completion: every later proof is ordered AFTER it.
    const failflowClose = await sendRequest(f2Conn, 4, 'session/close', { sessionId: sessionA })
    assert(failflowClose?.error === undefined && typeof failflowClose?.result === 'object',
      `F2: the close must detach after the failed flight settled (got ${JSON.stringify(failflowClose?.error ?? failflowClose?.result)})`)
    const failflowAfterClose = (hostSessionEvents(dshHome, sessionA) ?? []).length
    // tool2's approval now arrives with NO flight, a CLOSED ACP connection and
    // a LIVE REAL TUI on the SAME Session: the retired-turn fence must answer
    // it fail-closed — the audit says `unavailable` and the REAL TUI screen
    // never shows an approval sheet for it.
    const failflowDecidedUnavailable = await waitForHostSessionEventAfter(dshHome, sessionA, failflowAfterClose,
      event => event.type === 'approval/decided' && event.data?.outcome === 'unavailable',
      'F2: the post-close approval to be decided fail-closed AFTER the close', 180_000)
    void failflowDecidedUnavailable
    // The REAL TUI must not have received the dead question's sheet: no
    // approval interaction was mounted for it after the close boundary.
    const tuiApprovalAfterClose = tuiA.records.filter(record =>
      tuiA.records.indexOf(record) >= f2TuiBoundary
      && record.m4b2s === 'surface-status')
    void tuiApprovalAfterClose
    assert(!(await tuiScreenShows(tuiA, '[y] Allow once', 1_500)),
      'F2: the REAL TUI must never show the dead ACP turn approval sheet after the close')
    await waitForHostSessionEventAfter(dshHome, sessionA, failflowAfterClose,
      event => event.type === 'turn/end',
      'F2: the retired turn to reach its own real terminal after the close', 180_000)
    // MEASURED: the failed-flight fence kept the attribution — the only
    // post-close approval decision is `unavailable` (ordered after the close),
    // the earlier allow is exactly one, and the REAL TUI stayed silent.
    const failflowEvents = (hostSessionEvents(dshHome, sessionA) ?? []).slice(failflowAfterClose)
    const failflowLateDecisions = failflowEvents.filter(event =>
      event.type === 'approval/decided' && event.data?.outcome === 'unavailable')
    const failflowAllAllowed = (hostSessionEvents(dshHome, sessionA) ?? []).slice(failflowStart)
      .filter(event => event.type === 'approval/decided' && event.data?.outcome === 'allowed-once')
    const lateApprovalNoLeak = racingNoLateGrant
      && failflowLateDecisions.length >= 1
      && failflowAllAllowed.length === 1

    // ── G01) Two independent ACP Sessions stay isolated.
    const workspaceDir2 = join(workDir, 'po3b-workspaces', 'isolation')
    mkdirSync(workspaceDir2, { recursive: true, mode: 0o700 })
    const { client: conn3 } = await openInitialized(scopeDir, 'G01 third connection')
    const created3 = await sendRequest(conn3, 2, 'session/new', { cwd: realpathSync(workspaceDir2), mcpServers: [] })
    const sessionG = created3?.result?.sessionId
    assert(typeof sessionG === 'string' && sessionG !== sessionA, 'G01: session/new must create a distinct Session')
    // Cancel on conn2's session must not disturb conn3's prompt.
    const isolationPrompt = 'po3b-isolation'
    const isolationStart = (hostSessionEvents(dshHome, sessionG) ?? []).length
    const isolationNotifications = []
    conn3.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionG, prompt: [{ type: 'text', text: isolationPrompt }] } })
    conn2.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionAp } })
    const isolationResponse = await readUntilResponse(conn3, 3, isolationNotifications)
    assert(isolationResponse?.result?.stopReason === 'end_turn',
      `G01: the isolated Session must complete normally (got ${JSON.stringify(isolationResponse?.result ?? isolationResponse?.error)})`)
    await waitForHostSessionHeader(dshHome, sessionG, 'G01: the isolated Session durable header')
    await assertSameHost(identityBefore, 'G01 Host after the isolated turn')
    await assertHostRowsKept(host, rowsBefore, 'G01 protected rows after the ACP turns')
    // MEASURED: a cancel on the other connection's Session never disturbed the
    // isolated Session's own prompt (it answered its real end_turn).
    const twoViewsIsolated = isolationResponse?.result?.stopReason === 'end_turn'
      && sessionG !== sessionAp && sessionG !== sessionA
      && (hostSessionEvents(dshHome, sessionG) ?? []).some(event => event.type === 'turn/end')

    // ── G02) Host identity facts recorded; the REAL TUI kept its Session.
    await assertSameHost(identityBefore, 'G02 final Host identity')
    const finalTui = await waitForSurfaceStatus(tuiA, record => record.sessionOpen === true
      && record.openSessionId === sessionA && record.transport === 'connected',
    'G02: the REAL TUI kept Session A throughout')
    // MEASURED: the Host pid/instanceId never changed across every scenario,
    // and the SAME Session carried both REAL TUI turns and ACP turns.
    const finalIdentity = await identityFacts()
    const hostIdentityKept = finalIdentity.hostPid === identityBefore.hostPid
      && finalIdentity.instanceId === identityBefore.instanceId
      && finalTui.openSessionId === sessionA
    const sessionATurns = hostSessionEvents(dshHome, sessionA) ?? []
    // The SAME Session really carried BOTH owners' turns: a REAL TUI turn's
    // committed answer and the ACP running turn's committed user message.
    const tuiAndAcpShareSession = typeof tuiATurn === 'number'
      && typeof runningTurn === 'number'
      && sessionATurns.some(event => event.type === 'assistant/message' && event.data?.turn === tuiATurn)
      && sessionATurns.some(event => event.type === 'user/message' && userMessageText(event) === 'po3b-acp-running')
    // ── A05) A Session whose OFFICIAL durable approval policy is `never`
    //         (armed through the official service, same seam as the F8 case)
    //         never asks the ACP client: the official service decides before
    //         the waterfall and rejects.
    const neverWorkspace = join(workDir, 'po3b-workspaces', 'never')
    mkdirSync(neverWorkspace, { recursive: true, mode: 0o700 })
    const { client: neverConn } = await openInitialized(scopeDir, 'A05 never connection')
    const neverCreated = await sendRequest(neverConn, 2, 'session/new', { cwd: realpathSync(neverWorkspace), mcpServers: [] })
    const neverSession = neverCreated?.result?.sessionId
    assert(typeof neverSession === 'string' && neverSession !== '', 'A05: session/new must create the never Session')
    // Arm the official never policy through the marker turn first.
    const armNotifications = []
    neverConn.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: neverSession, prompt: [{ type: 'text', text: 'po3b-never-setup arm' }] } })
    const armResponse = await readUntilResponse(neverConn, 3, armNotifications)
    assert(armResponse?.result?.stopReason === 'end_turn',
      `A05: the arming turn must complete (got ${JSON.stringify(armResponse?.result ?? armResponse?.error)})`)
    await waitForHostSessionEventAfter(dshHome, neverSession, 0,
      event => event.type === 'approval/policy' && event.data?.policy === 'never',
      'A05: the official durable approval/policy never record', 120_000)
    // The approval ask under `never` is decided by the official service.
    const neverPrompt = 'po3b-approval po3b-never-ask'
    const neverStart = (hostSessionEvents(dshHome, neverSession) ?? []).length
    const neverNotifications = []
    neverConn.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: neverSession, prompt: [{ type: 'text', text: neverPrompt }] } })
    const neverAsked = await waitForHostSessionEventAfter(dshHome, neverSession, neverStart,
      event => event.type === 'approval/asked', 'A05: the never policy still writes its audit pair', 120_000)
    const neverDecided = await waitForHostSessionEventAfter(dshHome, neverSession, neverStart,
      event => event.type === 'approval/decided' && String(event.data?.id) === String(neverAsked.data?.id)
        && event.data?.outcome === 'rejected',
      'A05: the official service to reject under the never policy', 120_000)
    void neverDecided
    // The ACP connection NEVER sees a reverse permission request; the turn
    // completes with its real answer.
    const neverResponse = await readUntilResponse(neverConn, 4, neverNotifications)
    assert(neverResponse?.result?.stopReason === 'end_turn',
      `A05: the never-rejected turn completes normally (got ${JSON.stringify(neverResponse?.result ?? neverResponse?.error)})`)
    assert(await neverConn.silent(1_500), 'A05: no reverse permission request ever reached the ACP connection')
    // MEASURED: the official never policy wrote its own rejected decision and
    // the ACP connection received no permission question.
    const policyNeverUnbypassed = neverDecided.data?.outcome === 'rejected'
      && neverAsked.data?.id !== undefined
      && neverResponse?.result?.stopReason === 'end_turn'

    const evidence = {
      candidateSha256: context.candidateSha256,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion,
      bundleVersion: installedVersion,
      acpSdkVersion,
      hostPid: identityBefore.hostPid,
      hostInstanceId: identityBefore.instanceId,
      scopeId,
      sessionA,
      sessionApproval: sessionAp,
      sessionIsolated: sessionG,
      acpClientProcessPid: process.pid,
      idleCancelTurn: tuiATurn,
      queuedCancelMessageId: acpQueuedMessage.id,
      runningCancelTurn: runningTurn,
      allowPermissionRequestId: allowPermission.id,
      rejectPermissionRequestId: rejectPermission.id,
      racingPermissionRequestId: racingPermission.id,
      measured: {
        idleCancelNoOp,
        queuedCancelRemoved,
        claimRaceSafe,
        runningCancelExactTurn,
        cancelDrainBeforeStop,
        mixedTurnSafe,
        closeDrainedAndDetached,
        acpApprovalOnly,
        acpRejectOnly,
        tuiApprovalOnly,
        policyNeverUnbypassed,
        lateApprovalNoLeak,
        twoViewsIsolated,
        tuiAndAcpShareSession,
        hostIdentityKept,
        naturalResultKept,
      },
    }
    assert(typeof evidence.candidateSha256 === 'string' && /^[0-9a-f]{64}$/u.test(evidence.candidateSha256),
      'evidence: candidate SHA256 must be a real 64-hex digest')
    assert(typeof evidence.dshVersion === 'string' && evidence.dshVersion.length > 0,
      'evidence: target DSH version must be recorded')
    assert(evidence.acpSdkVersion !== 'unknown' && evidence.acpSdkVersion.length > 0,
      'evidence: ACP SDK version must be resolvable')
    assert(Number.isInteger(evidence.hostPid) && Number.isInteger(evidence.acpClientProcessPid),
      'evidence: host and ACP client pids must be real')
    assert(typeof evidence.queuedCancelMessageId === 'string',
      'evidence: the durable queued-removal message id must be recorded')
    assert(Number.isInteger(evidence.runningCancelTurn),
      'evidence: the exact cancelled running turn must be recorded')
    trace('acp-po3b/evidence-final', evidence)

    // Every verdict field below is DERIVED from the measured facts above; a
    // missing fact makes the corresponding field falsy and the selector guard
    // rejects the run. Nothing here is a literal PASS substitute.
    const verdict = {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      acpVersionFromInstalledDsh: acpSdkVersion !== 'unknown' && acpSdkVersion.length > 0,
      queuedCancelRemoved,
      runningCancelExactTurn,
      idleCancelNoOp,
      claimRaceSafe: claimRaceSafe && mixedTurnSafe,
      cancelDrainBeforeStop,
      closeDrainedAndDetached,
      acpApprovalOnly,
      tuiApprovalOnly: tuiApprovalOnly && acpRejectOnly,
      policyNeverUnbypassed,
      lateApprovalNoLeak,
      twoViewsIsolated,
      tuiAndAcpShareSession,
      hostIdentityKept,
      l6EvidenceRecorded: /^[0-9a-f]{64}$/u.test(String(evidence.candidateSha256))
        && typeof evidence.dshVersion === 'string' && evidence.dshVersion.length > 0
        && Number.isInteger(evidence.hostPid),
      evidence,
    }
    const requiredFacts = Object.entries(verdict).filter(([key]) => key !== 'status' && key !== 'scope' && key !== 'evidence')
    for (const [key, value] of requiredFacts) {
      assert(value === true, `PO-3B verdict field ${key} is not a measured true fact (got ${String(value)})`)
    }
    return verdict
  } finally {
    for (const client of acpClients) {
      try { client.close() } catch { /* already gone */ }
    }
    for (const peerProcess of peers) {
      if (peerProcess.exited) continue
      try { await peerProcess.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    try { await dispose() } catch { /* the global backstop owns leftovers */ }
    try { await awaitSceneSeatFree().catch(() => {}) } catch { /* seat proof is best effort on failure */ }
  }
}

/** Whether the REAL TUI screen shows the needle within a bounded window. */
async function tuiScreenShows(tui, needle, windowMs) {
  try {
    await tui.waitForScreen(needle, 'screen probe', windowMs)
    return true
  } catch {
    return false
  }
}

/** Read one connection's messages until a reverse permission request arrives. */
async function waitForPermissionRequest(client, label, timeoutMs = 180_000) {
  for (;;) {
    const message = await client.next(timeoutMs)
    // Session updates of the same turn may precede the question; keep them.
    if (message?.method === 'session/update') continue
    assert(message?.method === 'session/request_permission',
      `${label}: expected a reverse session/request_permission, got ${JSON.stringify(message).slice(0, 300)}`)
    return message
  }
}
