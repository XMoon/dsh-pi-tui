/**
 * G-ACP2 real-OS split-process qualification: transient assistant streaming.
 *
 * One REAL installed Host owns the local ACP front door and the shared Session
 * View, and one REAL controlled provider streams TWO text deltas whose text is
 * exactly its durable `assistant/message` block. This case proves, from real
 * processes, a real socket and the durable Host session log:
 *
 *   - the FIRST `agent_message_chunk` reaches the ACP client while the Host has
 *     NOT yet appended the durable `assistant/message` for that turn (the
 *     provider is held between its deltas), so the client really sees a
 *     transient frame before the commit;
 *   - the second delta arrives after the release, the committed message is
 *     appended, and the durable text is NOT sent a second time: the delivered
 *     chunk sequence is exactly the two deltas under ONE ACP message id;
 *   - a provider that REWRITES a block it already streamed is not silently
 *     reported as a committed answer: the request fails closed with
 *     `LOCAL_ACP_PROMPT_STREAM_DIVERGENCE` and no rewritten text is appended;
 *   - a SECOND ACP connection and its own Session receive none of those
 *     transient frames, and the Host identity is untouched throughout.
 *
 * The verdict is PASS only when every sub-fact above was observed; anything
 * partial is a non-PASS verdict for this case. The harness (never this module)
 * prints the SELECTED_PASS line.
 *
 * @module split-process/acp-transient-stream-settlement
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostSessionEvents, hostSessionHeader } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.transient-stream-settlement'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The exact first-delta text marker the scripted provider streams. */
const FIRST_MARKER = 'acp-transient first '
/** The exact second-delta text marker the scripted provider streams. */
const SECOND_MARKER = 'acp-transient second '
/** The prompt that selects the deliberately inconsistent (rewritten) block. */
const INCONSISTENT_PROMPT = 'ts-inconsistent please'

function deadline(promise, label, ms = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${CASE_ID}: ${label} timed out after ${String(ms)}ms`)) }, ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** One official ACP SDK client over the real local socket. */
async function openSdkClient(endpoint, onUpdate) {
  let socket
  if (endpoint.dir !== undefined) {
    const dirFd = openSync(endpoint.dir, 'r')
    try {
      socket = connect(`/proc/self/fd/${String(dirFd)}/acp.sock`)
    } finally {
      closeSync(dirFd)
    }
  } else {
    socket = connect(endpoint.path)
  }
  try {
    await deadline(new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    }), 'ACP socket connect', 30_000)
  } catch (error) {
    socket.destroy()
    throw error
  }
  const socketClosed = new Promise(resolve => socket.once('close', resolve))
  const app = acp.client({ name: 'acp-transient-stream-settlement' })
  app.onNotification(acp.methods.client.session.update, ({ params }) => { onUpdate(params) })
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket)))
  return {
    connection,
    socket,
    socketClosed,
    async request(method, params) {
      return await deadline(connection.agent.request(method, params), `ACP ${method}`)
    },
    async close() {
      try { await connection.close() } catch { /* already closed by the peer */ }
      socket.destroy()
      await deadline(Promise.allSettled([connection.closed, socketClosed]), 'ACP connection close', 30_000).catch(() => {})
    },
  }
}

/** Await one value from a fresh read (never a fixed sleep on a durable fact). */
async function waitForFact(read, label, timeoutMs = 180_000) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for ${label}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}

/** One user message's text from a durable `user/message` event. */
function userMessageText(event) {
  return (event.data?.content ?? []).map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
}

/** The durable assistant message text of one turn, or `undefined`. */
function assistantTextOf(events, turn) {
  const event = events.find(item => item.type === 'assistant/message' && item.data?.turn === turn)
  if (event === undefined) return undefined
  return (event.data?.message?.content ?? [])
    .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/** The first committed assistant message carrying `text`, at or after `from`. */
function assistantEventWithText(events, text, from = 0) {
  return events.slice(from)
    .find(event => event.type === 'assistant/message'
      && (event.data?.message?.content ?? []).some(block => block?.type === 'text'
        && typeof block.text === 'string' && block.text.includes(text)))
}

/** The turn owning the durable user message that carries exactly `text`. */
function turnOfUserText(events, text) {
  const index = events.findIndex(event => event.type === 'user/message' && userMessageText(event) === text)
  if (index < 0) return undefined
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (events[cursor]?.type === 'turn/start') return events[cursor].data?.turn
  }
  return undefined
}

/**
 * Run the transient-stream settlement qualification.
 * @param {object} context - the split smoke run context.
 * @returns {Promise<object>} the verdict facts gathered from real processes.
 */
export async function runAcpTransientStreamSettlement(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context)
  const hostCwd = realpathSync(workDir)
  const clients = []
  let peer
  let host
  let holdFile

  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)

  try {
    mkdirSync(join(workDir, 'ts-workspaces'), { recursive: true, mode: 0o700 })
    holdFile = join(workDir, `ts-hold-${String(process.pid)}.release`)
    rmSync(holdFile, { force: true })

    // ── A) A real Host whose controlled provider streams the transient text.
    const started = await scene.startC1Host('acp-transient', 'ts A host', {
      C1_HOLD_ACP_TRANSIENT: holdFile,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
    })
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'TS-01: the Host Ready must publish a full scope id')
    const hostIdentity = await scene.hostIdentityFacts(host)
    trace('acp-transient/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installation.manifest.version,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
    })

    // ── B) Enable the opt-in front door on the running Host, then derive the
    //      ONE public endpoint of this profile scope.
    peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = 'ts B peer'
    await peer.waitFor(record => record.m4a0 === 'ready', 'TS-02 peer ready', 180_000)
    const access = async (label, value) => {
      const requestId = `ts-access-${String(Date.now())}-${String(process.pid)}`
      peer.send({ op: 'qualification-acp-access', requestId, ...(value === undefined ? {} : { acpEnabled: value }) })
      const record = await peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId, label, 120_000)
      assert(record.ok === true, `TS-02: ${label} failed (${String(record.errorCode ?? 'unknown')})`)
      return record
    }
    const disabled = await access('TS-02 initial ACP status', undefined)
    assert(disabled.status?.state === 'disabled', `TS-02: the listener must start disabled: ${JSON.stringify(disabled.status)}`)
    const enabled = await access('TS-02 enable ACP', true)
    assert(enabled.status?.state === 'enabled', `TS-02: the listener must enable: ${JSON.stringify(enabled.status)}`)
    const endpoint = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${scopeId.slice(0, 40)}/acp.sock` }
      : { path: join(scopeDirOf(scopeId), 'acp.sock'), dir: scopeDirOf(scopeId) }
    assert(existsSync(endpoint.path), `TS-02: the enabled front door must publish ${endpoint.path}`)

    // ── C) TWO independent ACP connections with their own Sessions: the second
    //      one is the no-leak control for the first one's transient frames.
    // Every `session/update` a connection receives, in wire order; the case
    // filters by its OWN Session id once it exists (never by a guessed label).
    const updatesA = []
    const updatesB = []
    const acpA = await openSdkClient(endpoint, params => { updatesA.push(params) })
    clients.push(acpA)
    const acpB = await openSdkClient(endpoint, params => { updatesB.push(params) })
    clients.push(acpB)
    /** The text of every agent chunk this connection delivered for one Session. */
    const chunkTextsOf = (updates, sessionId, from = 0) => updates.slice(from)
      .filter(params => params?.sessionId === sessionId && params.update?.sessionUpdate === 'agent_message_chunk')
      .map(params => (params.update.content?.type === 'text' ? params.update.content.text : ''))
    const initA = await acpA.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    assert(initA?.protocolVersion === 1, 'TS-03: initialize must answer protocolVersion 1')
    const initB = await acpB.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    assert(initB?.protocolVersion === 1, 'TS-03: the second initialize must answer protocolVersion 1')
    const sessionA = (await acpA.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    const sessionB = (await acpB.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    assert(typeof sessionA === 'string' && typeof sessionB === 'string' && sessionA !== sessionB,
      'TS-03: the two connections must own two distinct real Sessions')

    // ── D) The streaming proof: the first delta is visible BEFORE the durable
    //      append. The scripted provider holds between its two deltas.
    const promptText = 'ts-consistent stream'
    await waitForFact(() => hostSessionHeader(dshHome, sessionA) === undefined ? undefined : true,
      'TS-04 the Session A durable header')
    const eventsBefore = hostSessionEvents(dshHome, sessionA) ?? []
    const promptStart = eventsBefore.length
    const promptPromise = acpA.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: promptText }],
    })
    const promptResult = promptPromise.then(value => ({ value }), error => ({ error }))
    const turn = await waitForFact(() => turnOfUserText(hostSessionEvents(dshHome, sessionA) ?? [], promptText),
      'TS-04 the streamed turn to be durably owned')
    // The FIRST transient chunk must arrive while the durable message is absent.
    const firstChunk = await waitForFact(() => {
      const streamed = chunkTextsOf(updatesA, sessionA)
      return streamed.join('').includes(FIRST_MARKER) ? streamed : undefined
    }, 'TS-04 the first transient chunk')
    assert(hostSessionEvents(dshHome, sessionA) !== undefined, 'TS-04: the shared durable log must be readable')
    const preCommitEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(assistantEventWithText(preCommitEvents, FIRST_MARKER, promptStart) === undefined,
      `TS-04: the first chunk must arrive BEFORE its durable assistant/message (events: ${JSON.stringify(preCommitEvents.slice(promptStart).map(event => event.type))})`)
    assert(updatesB.filter(update => update?.update?.sessionUpdate !== 'available_commands_update').length === 0,
      'TS-04: the sibling ACP Session must receive none of these transient frames')
    trace('acp-transient/first-chunk-before-commit', { turn, chunks: firstChunk.length })

    // ── E) Release the provider: the second delta and the durable commit follow.
    writeFileSync(holdFile, 'release\n', { mode: 0o600 })
    const settled = await promptResult
    assert(settled.error === undefined, `TS-05: the owned prompt must settle (got ${JSON.stringify(settled.error?.data ?? settled.error?.message)})`)
    assert(settled.value?.stopReason === 'end_turn', `TS-05: the owned prompt must answer end_turn (got ${JSON.stringify(settled.value)})`)
    const chunkUpdates = updatesA
      .filter(params => params?.sessionId === sessionA && params.update?.sessionUpdate === 'agent_message_chunk')
      .map(params => params.update)
    const chunkTexts = chunkTextsOf(updatesA, sessionA)
    assert(chunkTexts.length === 2, `TS-05: exactly the two provider deltas must be delivered (got ${JSON.stringify(chunkTexts)})`)
    assert(chunkTexts[0].includes(FIRST_MARKER) && chunkTexts[1].includes(SECOND_MARKER),
      `TS-05: the delivered deltas must be the provider's own order (got ${JSON.stringify(chunkTexts)})`)
    const messageIds = new Set(chunkUpdates.map(update => update.messageId))
    assert(messageIds.size === 1, `TS-05: one attempt must use ONE ACP message id (got ${JSON.stringify([...messageIds])})`)
    const committedEvent = await waitForFact(
      () => assistantEventWithText(hostSessionEvents(dshHome, sessionA) ?? [], FIRST_MARKER, promptStart),
      'TS-05 the committed assistant message',
    )
    const committedTurn = committedEvent.data?.turn
    const durable = assistantTextOf(hostSessionEvents(dshHome, sessionA) ?? [], committedTurn)
    assert(chunkTexts.join('') === durable,
      `TS-05: the delivered transient text must equal the committed text exactly (${JSON.stringify(chunkTexts.join(''))} vs ${JSON.stringify(durable)})`)
    assert(chunkTextsOf(updatesA, sessionA).length === 2,
      'TS-05: the committed text must never be re-sent after the join')
    assert(updatesB.filter(update => update?.update?.sessionUpdate !== 'available_commands_update').length === 0,
      'TS-05: the sibling Session must still have received nothing')

    // ── F) Negative control: a provider that rewrites an already-streamed block
    //      cannot be reported as a committed answer.
    const beforeInconsistent = updatesA.length
    const inconsistent = acpA.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: INCONSISTENT_PROMPT }],
    }).then(value => ({ value }), error => ({ error }))
    const inconsistentOutcome = await inconsistent
    assert(inconsistentOutcome.error !== undefined,
      `TS-06: a rewritten block must fail the request closed (got ${JSON.stringify(inconsistentOutcome.value)})`)
    assert(inconsistentOutcome.error?.data?.code === 'LOCAL_ACP_PROMPT_STREAM_DIVERGENCE',
      `TS-06: the failure must name LOCAL_ACP_PROMPT_STREAM_DIVERGENCE (got ${JSON.stringify(inconsistentOutcome.error?.data)})`)
    const provisional = chunkTextsOf(updatesA, sessionA, beforeInconsistent)
    assert(provisional.length === 1 && provisional[0].includes('acp-transient provisional'),
      `TS-06: only the provisional delta may be delivered (got ${JSON.stringify(provisional)})`)
    await waitForFact(
      () => turnOfUserText(hostSessionEvents(dshHome, sessionA) ?? [], INCONSISTENT_PROMPT),
      'TS-06 the rewritten turn to be durably owned',
    )
    const rewritten = (hostSessionEvents(dshHome, sessionA) ?? [])
      .filter(event => event.type === 'assistant/message' && JSON.stringify(event).includes('acp-transient committed'))
    assert(rewritten.length === 1, 'TS-06: the committed rewritten block must exist exactly once')
    const afterCommit = chunkTextsOf(updatesA, sessionA, beforeInconsistent)
    assert(afterCommit.length === 1, 'TS-06: the rewritten committed text must never be appended as a chunk')

    // ── G) Both connections and the Host keep their own authority.
    await scene.assertHostIdentityKept(host, hostIdentity, 'TS-07 Host identity')
    await acpA.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await acpA.request(acp.methods.agent.session.close, { sessionId: sessionA })
    const siblingUpdates = updatesB.filter(update => update?.update?.sessionUpdate !== 'available_commands_update')
    assert(siblingUpdates.length === 0, 'TS-07: the sibling connection observed nothing through the whole case')
    assert((hostSessionEvents(dshHome, sessionA) ?? []).length >= eventsBefore.length, 'TS-07: the durable log must stay readable')
    await acpA.request(acp.methods.agent.session.close, { sessionId: sessionB }).catch(() => {})

    const evidence = {
      schema: 'gacp2-transient-stream-settlement/1',
      case_id: CASE_ID,
      platform: process.platform,
      candidate_sha256: context.candidateSha256,
      dsh_version: context.targetDshVersion,
      bundle_version: installation.manifest.version,
      host: { pid: hostIdentity.hostPid, instanceId: hostIdentity.instanceId, scopeId },
      sessions: { A: sessionA, B: sessionB },
      stream: {
        turn: committedTurn,
        firstChunkBeforeCommit: true,
        deliveredChunks: chunkTexts.length,
        ackMessageIds: messageIds.size,
        committedTextMatches: chunkTexts.join('') === durable,
        stopReason: settled.value?.stopReason,
      },
      divergence: {
        code: inconsistentOutcome.error?.data?.code,
        provisionalChunks: provisional.length,
        rewrittenChunkAppended: afterCommit.length > 1,
      },
      leak: { siblingSessionUpdates: siblingUpdates.length },
      verdict: 'PASS',
    }

    for (const client of clients) await client.close()
    clients.length = 0
    const peerExit = peer.exited ? undefined : await peer.shutdown()
    assert(peerExit === undefined || (peerExit.code === 0 && peerExit.signal === null), 'TS-07: the peer must exit cleanly')
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0 && hostExit.signal === null, 'TS-07: the Host must exit cleanly')
    await scene.awaitSceneSeatFree()
    assert(!existsSync(endpoint.path), 'TS-07: the ACP socket must be gone after shutdown')
    host = undefined

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      firstChunkBeforeCommit: true,
      noDuplicateAfterJoin: chunkTexts.length === 2,
      committedTextMatches: chunkTexts.join('') === durable,
      streamDivergenceFailClosed: inconsistentOutcome.error?.data?.code === 'LOCAL_ACP_PROMPT_STREAM_DIVERGENCE',
      noRewriteResend: afterCommit.length === 1,
      siblingSessionIsolated: siblingUpdates.length === 0,
      hostIdentityKept: true,
      acpProtocolVersion: initA.protocolVersion,
      stopReason: settled.value?.stopReason,
      l6EvidenceRecorded: true,
      evidence,
    }
  } finally {
    try { if (holdFile !== undefined) writeFileSync(holdFile, 'released\n', { mode: 0o600 }) } catch { /* best effort */ }
    for (const client of clients) {
      try { await client.close() } catch { /* already gone */ }
    }
    if (peer !== undefined && peer.exited !== true) {
      try { await peer.shutdown() } catch { /* runner backstop */ }
    }
    if (host !== undefined && host.exited !== true) {
      try { await host.shutdown() } catch { /* runner backstop */ }
    }
    try { await scene.dispose() } catch { /* runner backstop */ }
    try { await scene.awaitSceneSeatFree().catch(() => {}) } catch { /* best effort */ }
  }
}
