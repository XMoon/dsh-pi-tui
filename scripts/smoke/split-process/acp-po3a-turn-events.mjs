/**
 * PO-3A real-OS split-process qualification: one shared-host ACP prompt turn.
 *
 * One REAL installed Host owns the `<scope.dir>/acp.sock` front door and the
 * connection-scoped Session View. This case proves, from REAL processes, a REAL
 * socket and a REAL controlled model, that:
 *
 *   - an attached ACP connection sends ONE text prompt through the official
 *     Host Session Controller while a REAL TUI turn is running, its ACK is not
 *     a completed turn, and its `session/update` notifications carry only the
 *     committed output of the turn that claimed that exact message;
 *   - the ACP turn's updates and `end_turn` follow that turn's durable
 *     `turn/end`, and the following REAL TUI turn makes the durable history
 *     exactly A -> B -> C;
 *   - a TUI steer claimed into the ACP turn makes it MIXED: no foreign output is
 *     sent and the request fails closed instead of fabricating a success;
 *   - a physical disconnect during an in-flight prompt never cancels the Host
 *     turn and its late events never reach a newer View generation;
 *   - a committed assistant message larger than the bounded output queue fails
 *     only that request, and the same connection still serves the next prompt.
 *
 * Every fact comes from REAL processes, a REAL socket and the durable Host
 * Session log; a partial or NOT_RUN sub-scenario returns a non-PASS verdict.
 * The harness (never this module) prints the SELECTED_PASS line.
 *
 * @module split-process/acp-po3a-turn-events
 */

import { createRequire } from 'node:module'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { seatFree, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
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
        // A message arrived inside the window: keep it for the next reader.
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
    if (message?.id === id && (message.result !== undefined || message.error !== undefined)) return message
    // A stray message with no id is a protocol violation for this case.
    assert(false, `PO-3A: unexpected ACP message while waiting for response ${String(id)}: ${JSON.stringify(message).slice(0, 300)}`)
  }
}

/** The Linux abstract seat name one Host scope claims for this profile. */
function seatName(scopeId) {
  return `\0dsh-pi-tui-h-${String(scopeId).slice(0, 40)}`
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
    if (Date.now() > deadline) throw new SplitSmokeAssertionError(`acp-po3a: timed out waiting for ${label}`)
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
 * Run the PO-3A shared-host ACP prompt/turn/event/StopReason qualification.
 * Every returned boolean is a fact gathered from a REAL process/socket/log.
 */
export async function runAcpPo3aTurnEvents(context) {
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
    // ── A) Boot a real C1 Host and enable the ACP front door at runtime.
    mkdirSync(join(workDir, 'po3a-workspaces'), { recursive: true, mode: 0o700 })
    barrier = join(workDir, `po3a-hold-${String(process.pid)}.release`)
    rmSync(barrier, { force: true })
    const started = await startC1Host('long-turn', 'po3a A host', {
      C1_HOLD_LONG_TURN: barrier,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    })
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'the Host Ready must publish a full 64-character scope id')
    const scopeDir = scopeDirOf(scopeId)
    const hostCwd = realpathSync(workDir)
    trace('acp-po3a/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installedVersion,
      acpSdkVersion,
      hostPid: ready.localHost.hostPid,
      hostInstanceId: ready.localHost.instanceId,
      scopeId,
    })
    const peer = await startPeer('po3a A peer')
    assertAccess(await acpAccess(peer, 'A getStatus', undefined), 'disabled', 'A getStatus')
    assertAccess(await acpAccess(peer, 'A enable', true), 'enabled', 'A enable')
    assert(exists(join(scopeDir, 'acp.sock')), 'A: the enabled front door must bind acp.sock')

    // ── B) A REAL TUI opens Session A; the ACP connection attaches the SAME
    //      Session while the TUI keeps it.
    const { client: tuiA } = await startC1Client('po3a B tui', {}, { cwd: hostCwd })
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
    assert(initB?.result?.agentInfo?.version === installedVersion,
      `B: agentInfo.version must be the installed bundle version ${installedVersion}`)
    assert(initB?.result?.agentCapabilities?.loadSession === false, 'B: loadSession must stay false')
    assert(initB?.result?.agentCapabilities?.promptCapabilities?.image === false,
      'B: inline image prompts must stay unadvertised')
    assert(initB?.result?.agentCapabilities?.sessionCapabilities?.resume !== undefined,
      'B: sessionCapabilities.resume must be advertised')
    assert(initB?.result?.agentCapabilities?.sessionCapabilities?.close !== undefined,
      'B: sessionCapabilities.close must be advertised')
    const resumeB = await sendRequest(conn1, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(resumeB?.error === undefined && typeof resumeB?.result === 'object',
      `B: session/resume(A) must return {} (got ${JSON.stringify(resumeB?.error ?? resumeB?.result)})`)

    const identityBefore = await identityFacts()
    const rowsBefore = await hostRowFiberUids(host)
    await assertSameHost(identityBefore, 'B Host after the ACP resume')

    // ── C) A REAL TUI turn runs and is HELD; the ACP prompt is accepted while
    //      it runs but is NOT a completed turn. Its updates belong only to the
    //      later turn that claims its own message.
    holdNextTurn()
    const eventsBeforeC = hostSessionEvents(dshHome, sessionA) ?? []
    const tuiAStart = eventsBeforeC.length
    tuiA.send('po3a-tui-a\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiAStart,
      event => event.type === 'user/message' && userMessageText(event) === 'po3a-tui-a',
      'C: the TUI message to be committed inside its held step', 120_000)
    const tuiATurn = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], 'po3a-tui-a')
    assert(typeof tuiATurn === 'number', 'C: the TUI message must belong to a real turn')

    const turnBPrompt = 'po3a-acp-b'
    const turnBStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: turnBPrompt }] } })
    const queueB = await waitForHostSessionEventAfter(dshHome, sessionA, turnBStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && (event.data.inserted ?? []).some(message => message?.source?.rpcId !== undefined
          && (message.content ?? []).some(part => part?.text === turnBPrompt)),
      'C: the ACP prompt to be accepted into the shared Host inbox', 120_000)
    const acpQueued = (queueB.data.inserted ?? []).find(message =>
      (message.content ?? []).some(part => part?.text === turnBPrompt))
    const acpRequestId = acpQueued?.source?.rpcId
    assert(typeof acpRequestId === 'string' && acpRequestId.length > 0,
      'C: the accepted ACP message must carry the View-minted requestId')
    assert((hostSessionEvents(dshHome, sessionA) ?? []).every(event =>
      !(event.type === 'user/message' && userMessageText(event) === turnBPrompt)),
    'C: the accepted ACP message must NOT have been claimed while the TUI turn runs')
    assert(await conn1.silent(1_500), 'C: an accepted ACP prompt must not answer before its turn settles')

    releaseHeldTurn()
    const bNotifications = []
    const turnBResponse = await readUntilResponse(conn1, 3, bNotifications)
    const bChunks = bNotifications.filter(notification => notification?.update?.sessionUpdate === 'agent_message_chunk')
    assert(turnBResponse?.error === undefined, `C: the ACP prompt must settle successfully (got ${JSON.stringify(turnBResponse?.error)})`)
    assert(turnBResponse?.result?.stopReason === 'end_turn',
      `C: a completed turn must answer end_turn (got ${JSON.stringify(turnBResponse?.result)})`)
    assert(bChunks.length === 1, `C: the ACP prompt must carry exactly one real assistant text chunk (got ${String(bChunks.length)})`)
    const bChunkText = bChunks[0]?.update?.content?.text ?? ''
    assert(bChunkText.includes(`long-turn answer 2 long-turn-${sessionA}`),
      `C: the ACP chunk must be the committed answer of its own turn (got ${JSON.stringify(bChunkText)})`)
    assert(!bChunkText.includes('long-turn answer 1'),
      'C: the ACP connection must never receive the earlier TUI turn output')

    // The durable log may lag the live response by one checkpoint flush, so
    // every derived fact is awaited through the SAME bounded durable wait.
    const bTurn = await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      const index = userMessageIndexOf(events, turnBPrompt, turnBStart)
      return index < 0 ? undefined : turnOfEvent(events, index)
    }, 'C: the ACP prompt to be durably claimed', 120_000)
    assert(typeof bTurn === 'number' && bTurn > tuiATurn, 'C: the ACP prompt must be claimed in a strictly later turn')
    await waitForHostSessionEventAfter(dshHome, sessionA, turnBStart,
      event => event.type === 'assistant/message' && event.data?.turn === bTurn
        && JSON.stringify(event).includes(bChunkText),
      'C: the committed assistant answer of the ACP turn', 120_000)
    const eventsAfterB = hostSessionEvents(dshHome, sessionA) ?? []
    const bAnswerEvents = eventsAfterB.filter(event => event.type === 'assistant/message'
      && event.data?.turn === bTurn
      && JSON.stringify(event).includes(bChunkText))
    assert(bAnswerEvents.length === 1, 'C: the committed assistant answer must belong to the ACP turn')
    const tuiATurnText = eventsAfterB.filter(event => event.type === 'assistant/message' && event.data?.turn === tuiATurn)
      .map(event => JSON.stringify(event))
      .join('\n')
    assert(!tuiATurnText.includes(bChunkText), 'C: the ACP chunk must not be the earlier TUI turn output')
    await waitForHostSessionEventAfter(dshHome, sessionA, turnBStart,
      event => event.type === 'turn/end' && event.data?.turn === bTurn,
      'C: the ACP turn to reach a durable turn/end', 120_000)

    // ── D) A following REAL TUI turn lands after the ACP turn; the durable
    //      history is exactly A -> B -> C.
    const eventsBeforeD = hostSessionEvents(dshHome, sessionA) ?? []
    const tuiCStart = eventsBeforeD.length
    tuiA.send('po3a-tui-c\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiCStart,
      event => event.type === 'user/message' && userMessageText(event) === 'po3a-tui-c',
      'D: the TUI C message to be committed', 120_000)
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiCStart,
      event => event.type === 'turn/end',
      'D: the TUI C turn to end', 120_000)
    const eventsAfterC = hostSessionEvents(dshHome, sessionA) ?? []
    const humanTexts = hostUserTexts(eventsAfterC)
    assert(humanTexts.indexOf('po3a-tui-a') < humanTexts.indexOf(turnBPrompt)
      && humanTexts.indexOf(turnBPrompt) < humanTexts.indexOf('po3a-tui-c'),
    `D: the durable human history must be A -> B -> C (got ${JSON.stringify(humanTexts)})`)
    assert(hostAssistantHasText(eventsAfterC, `long-turn answer 2 long-turn-${sessionA}`),
      'D: the ACP answer must stay in the shared durable history')
    await assertSameHost(identityBefore, 'D Host after the ACP and TUI turns')
    await assertHostRowsKept(host, rowsBefore, 'D protected rows after the ACP turn')

    // ── E) A TUI steer claimed INTO the running ACP turn makes it MIXED: no
    //      foreign output is projected and the request fails closed.
    holdNextTurn()
    const mixedPrompt = 'po3a-acp-mixed'
    const mixedStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn1.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: mixedPrompt }] } })
    await waitForHostSessionEventAfter(dshHome, sessionA, mixedStart,
      event => event.type === 'user/message' && userMessageText(event) === mixedPrompt,
      'E: the ACP turn user message to be committed inside its held step', 120_000)
    const mixedTurn = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], mixedPrompt)
    assert(typeof mixedTurn === 'number', 'E: the ACP turn must be durably owned')

    const steerText = 'po3a-tui-steer'
    const steerStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send(`${steerText}\r`)
    const steerQueued = await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && (event.data.inserted ?? []).some(message => (message.content ?? []).some(part => part?.text === steerText)),
      'E: the TUI steer candidate to queue', 120_000)
    const steerItem = (steerQueued.data.inserted ?? []).find(message =>
      (message.content ?? []).some(part => part?.text === steerText))
    assert(typeof steerItem?.id === 'string', 'E: the queued TUI occurrence must carry an id')
    tuiA.send('\x13')
    await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-step'
        && (event.data.inserted ?? []).some(message => message?.id === steerItem.id),
      'E: the existing Ctrl+S to steer the exact Host occurrence', 120_000)
    assert(await conn1.silent(1_000),
      'E: the ACP turn must still be held when the steer is claimed')

    releaseHeldTurn()
    const mixedNotifications = []
    const mixedResponse = await readUntilResponse(conn1, 4, mixedNotifications)
    assert(mixedResponse?.error?.code === -32603,
      `E: a mixed turn must fail as a JSON-RPC internal failure (got ${JSON.stringify(mixedResponse?.result ?? mixedResponse?.error)})`)
    assert(mixedResponse?.error?.data?.code === 'LOCAL_ACP_PROMPT_MIXED_TURN',
      `E: a mixed turn must name LOCAL_ACP_PROMPT_MIXED_TURN (got ${JSON.stringify(mixedResponse?.error?.data)})`)
    const mixedChunks = mixedNotifications.filter(notification => notification?.update?.sessionUpdate === 'agent_message_chunk')
    assert(mixedChunks.length === 1,
      `E: only the pre-mix committed half may reach the ACP connection (got ${String(mixedChunks.length)})`)
    await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'user/message' && event.data?.id === steerItem.id,
      'E: the steered TUI message to be durably claimed', 120_000)
    const foreignTurn = await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      const index = events.findIndex(entry => entry.type === 'user/message' && entry.data?.id === steerItem.id)
      return index < 0 ? undefined : turnOfEvent(events, index)
    }, 'E: the steered message turn to be read', 120_000)
    assert(foreignTurn === mixedTurn, 'E: the TUI steer must be claimed into the SAME ACP turn')
    const mixedAssistantCount = await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      const count = events.filter(entry => entry.type === 'assistant/message' && entry.data?.turn === mixedTurn).length
      return count >= 2 ? count : undefined
    }, 'E: the mixed turn second committed answer', 120_000)
    assert(mixedAssistantCount >= 2, 'E: the mixed turn must have produced more than one committed answer')
    const mixedAfter = hostSessionEvents(dshHome, sessionA) ?? []
    const mixedAssistant = mixedAfter.filter(event => event.type === 'assistant/message' && event.data?.turn === mixedTurn)
    const lastAssistantText = (mixedAssistant.at(-1).data?.message?.content ?? [])
      .map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    assert(lastAssistantText.length > 0, 'E: the foreign step must have committed real text')
    assert(!mixedNotifications.some(notification => JSON.stringify(notification).includes(lastAssistantText)),
      'E: no content of the foreign step may be projected')
    await waitForHostSessionEventAfter(dshHome, sessionA, steerStart,
      event => event.type === 'turn/end' && event.data?.turn === mixedTurn,
      'E: the mixed turn to reach its own durable end', 120_000)
    await assertSameHost(identityBefore, 'E Host after the mixed turn')
    assert((tuiA.records.filter(record => record.m4b2s === 'surface-status').at(-1))?.openSessionId === sessionA,
      'E: the REAL TUI must keep its Session and not be cancelled by the ACP failure')

    // ── F) Two ACP connections on DIFFERENT Sessions never pollute each other.
    const workspaceDir = join(workDir, 'po3a-workspaces', 'two-view')
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
    const hostCwdNew = realpathSync(workspaceDir)
    const { client: conn2 } = await openInitialized(scopeDir, 'F second connection')
    const created = await sendRequest(conn2, 2, 'session/new', { cwd: hostCwdNew, mcpServers: [] })
    assert(typeof created?.result?.sessionId === 'string' && created.result.sessionId !== '',
      `F: session/new must create a real Host Session (got ${JSON.stringify(created?.error ?? created?.result)})`)
    const sessionB = created.result.sessionId
    assert(sessionB !== sessionA, 'F: session/new must create a distinct Session')
    const firstNotifications = []
    const secondNotifications = []
    conn1.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: 'po3a-acp-first' }] } })
    conn2.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'po3a-acp-second' }] } })
    const [firstResponse, secondResponse] = await Promise.all([
      readUntilResponse(conn1, 5, firstNotifications),
      readUntilResponse(conn2, 3, secondNotifications),
    ])
    assert(firstResponse?.result?.stopReason === 'end_turn' && secondResponse?.result?.stopReason === 'end_turn',
      'F: both connections must settle their own end_turn')
    const firstText = JSON.stringify(firstNotifications)
    const secondText = JSON.stringify(secondNotifications)
    assert(firstText.includes(`long-turn-${sessionA}`) && !firstText.includes(`long-turn-${sessionB}`),
      'F: connection 1 must receive only its own Session output')
    assert(secondText.includes(`long-turn-${sessionB}`) && !secondText.includes(`long-turn-${sessionA}`),
      'F: connection 2 must receive only its own Session output')
    await waitForHostSessionHeader(dshHome, sessionB, 'F: Session B durable header')
    await assertSameHost(identityBefore, 'F Host after two ACP turns')

    // ── G) A physical disconnect during an in-flight prompt never cancels the
    //      Host turn, and its late events never reach a newer View generation.
    //      The first connection detaches its own View so another connection can
    //      borrow the SAME Session (one ACP View per Session).
    const closeG = await sendRequest(conn1, 6, 'session/close', { sessionId: sessionA })
    assert(closeG?.error === undefined && typeof closeG?.result === 'object',
      `G: the first connection must detach its own View (got ${JSON.stringify(closeG?.error ?? closeG?.result)})`)
    holdNextTurn()
    const { client: conn3 } = await openInitialized(scopeDir, 'G third connection')
    const resumeG = await sendRequest(conn3, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(resumeG?.error === undefined, 'G: the third connection must attach Session A')
    const disconnectPrompt = 'po3a-acp-disconnect'
    const disconnectStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    conn3.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: disconnectPrompt }] } })
    await waitForHostSessionEventAfter(dshHome, sessionA, disconnectStart,
      event => event.type === 'user/message' && userMessageText(event) === disconnectPrompt,
      'G: the disconnected prompt to be committed inside its held step', 120_000)
    conn3.close()
    await conn3.closed
    releaseHeldTurn()
    await waitForHostSessionEventAfter(dshHome, sessionA, disconnectStart,
      event => event.type === 'user/message' && userMessageText(event) === disconnectPrompt,
      'G: the disconnected prompt to stay committed', 120_000)
    const disconnectTurn = userMessageTurnOf(hostSessionEvents(dshHome, sessionA) ?? [], disconnectPrompt)
    await waitForHostSessionEventAfter(dshHome, sessionA, disconnectStart,
      event => event.type === 'turn/end' && event.data?.turn === disconnectTurn,
      'G: the Host turn to complete after the ACP disconnect', 180_000)
    const { client: conn4 } = await openInitialized(scopeDir, 'G fourth connection')
    const resumeG2 = await sendRequest(conn4, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(resumeG2?.error === undefined, 'G: a new connection must attach Session A after the teardown')
    assert(await conn4.silent(2_000),
      'G: the old generation turn must never be replayed to the new View')
    await assertSameHost(identityBefore, 'G Host after the physical ACP disconnect')
    const closeG2 = await sendRequest(conn4, 3, 'session/close', { sessionId: sessionA })
    assert(closeG2?.error === undefined && typeof closeG2?.result === 'object',
      `G: the fourth connection must detach its View before H (got ${JSON.stringify(closeG2?.error ?? closeG2?.result)})`)

    // ── H) A committed message beyond the View's bounded output queue fails
    //      ONLY that request; the same connection serves the next prompt.
    const { client: conn5 } = await openInitialized(scopeDir, 'H backpressure connection')
    const resumeH = await sendRequest(conn5, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(resumeH?.error === undefined, 'H: the backpressure connection must attach Session A')
    const largeStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const backpressureResponse = await sendRequest(conn5, 3, 'session/prompt',
      { sessionId: sessionA, prompt: [{ type: 'text', text: 'po3a-large-output' }] })
    // Let the Host finish that turn before the next prompt so the next prompt
    // is unambiguously queued for a NEW turn, not the running one.
    const largeTurn = await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      const index = userMessageIndexOf(events, 'po3a-large-output', largeStart)
      return index < 0 ? undefined : turnOfEvent(events, index)
    }, 'H: the large-output turn to be durably owned', 120_000)
    await waitForHostSessionEventAfter(dshHome, sessionA, largeStart,
      event => event.type === 'turn/end' && event.data?.turn === largeTurn,
      'H: the large-output turn to end', 180_000)
    assert(backpressureResponse?.error?.code === -32603,
      `H: an over-capacity output turn must fail internally (got ${JSON.stringify(backpressureResponse?.result ?? backpressureResponse?.error)})`)
    assert(backpressureResponse?.error?.data?.code === 'LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE',
      `H: the failure must name LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE (got ${JSON.stringify(backpressureResponse?.error?.data)})`)
    const afterBackpressureNotifications = []
    conn5.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt',
      params: { sessionId: sessionA, prompt: [{ type: 'text', text: 'po3a-after-backpressure' }] } })
    const afterBackpressure = await readUntilResponse(conn5, 4, afterBackpressureNotifications)
    assert(afterBackpressure?.result?.stopReason === 'end_turn',
      `H: the same connection must serve the next prompt (got ${JSON.stringify(afterBackpressure?.error ?? afterBackpressure?.result)})`)
    const largeAssistantCount = (hostSessionEvents(dshHome, sessionA) ?? [])
      .filter(event => event.type === 'assistant/message' && event.data?.turn === largeTurn).length
    trace('acp-po3a/large-turn', { largeTurn, largeAssistantCount })
    const afterChunks = afterBackpressureNotifications.filter(notification => notification?.update?.sessionUpdate === 'agent_message_chunk')
    assert(afterChunks.length === 1, 'H: the next prompt must deliver exactly its own answer chunk')
    assert(!JSON.stringify(afterBackpressureNotifications).includes('po3a-large-block-'),
      'H: no stale large-output notification may reach the next prompt')
    await waitForHostSessionHeader(dshHome, sessionB, 'H: Session B durable header')
    await assertSameHost(identityBefore, 'H Host after the output-bound failure')
    const tuiAlive = await waitForSurfaceStatus(tuiA, record => record.sessionOpen === true
      && record.openSessionId === sessionA && record.transport === 'connected',
    'H: the REAL TUI must still be connected to Session A')

    // ── I) The controlled model and the TUI completed their own turns: the
    //      final durable history is intact and the Host was never replaced.
    await waitForFact(async () => {
      const events = hostSessionEvents(dshHome, sessionA) ?? []
      return events.filter(event => event.type === 'turn/end').length >= 4 ? true : undefined
    }, 'I: every real turn to have a durable end', 60_000)
    const finalEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(hostAssistantHasText(finalEvents, bChunkText),
      'I: the earlier committed ACP answer must survive')
    await assertSameHost(identityBefore, 'I final Host identity')
    await assertHostRowsKept(host, rowsBefore, 'I final protected rows')
    assert(tuiAlive.openSessionId === sessionA, 'I: the REAL TUI kept Session A throughout')

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
      sessionB,
      acpClientProcessPid: process.pid,
      acpRequestId,
      acpMessageId: acpQueued.id,
      acpTuiTurn: tuiATurn,
      acpTurn: bTurn,
      mixedTurn,
      mixedSteerMessageId: steerItem.id,
      stopReason: turnBResponse.result.stopReason,
      updateType: bChunks[0].update.sessionUpdate,
      tuiTurnsAfterAcp: true,
    }
    assert(typeof evidence.candidateSha256 === 'string' && /^[0-9a-f]{64}$/u.test(evidence.candidateSha256),
      'evidence: candidate SHA256 must be a real 64-hex digest')
    assert(typeof evidence.dshVersion === 'string' && evidence.dshVersion.length > 0,
      'evidence: target DSH version must be recorded')
    assert(evidence.acpSdkVersion !== 'unknown' && evidence.acpSdkVersion.length > 0,
      'evidence: ACP SDK version must be resolvable')
    assert(Number.isInteger(evidence.hostPid) && Number.isInteger(evidence.acpClientProcessPid),
      'evidence: host and ACP client pids must be real')
    assert(typeof evidence.acpRequestId === 'string' && typeof evidence.acpMessageId === 'string',
      'evidence: the official requestId/messageId correlation must be recorded')
    assert(Number.isInteger(evidence.acpTurn) && Number.isInteger(evidence.acpTuiTurn)
      && evidence.acpTurn > evidence.acpTuiTurn,
    'evidence: the ACP turn must be a later real turn')
    trace('acp-po3a/evidence-final', evidence)

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      acpVersionFromInstalledDsh: true,
      tuiAndAcpShareSession: true,
      promptAcceptedWhileRunning: true,
      ackIsNotCompletion: true,
      acpOnlyOutput: true,
      exactTurnCorrelation: true,
      updatesBeforeStopReason: true,
      tuiAfterPromptHistory: true,
      mixedTurnFailClosed: true,
      twoViewIsolation: true,
      disconnectKeepsHostTurn: true,
      staleGenerationNotReplayed: true,
      outputBackpressureIsolated: true,
      sameConnectionAfterFailure: true,
      hostIdentityKept: true,
      originalSplitClientIntact: true,
      l6EvidenceRecorded: true,
      evidence,
    }
  } finally {
    for (const client of acpClients) {
      try { client.close() } catch { /* already gone */ }
    }
    for (const peerProcess of peers) {
      if (peerProcess.exited) continue
      try { await peerProcess.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    try { await scene.dispose() } catch { /* the global backstop owns leftovers */ }
    try { await awaitSceneSeatFree().catch(() => {}) } catch { /* seat proof is best effort on failure */ }
  }
}
