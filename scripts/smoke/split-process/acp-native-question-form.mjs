/**
 * ACP-NATIVE-QUESTION L6: one real Host, one official ACP SDK client.
 *
 * Proves the native DSH question waterfall end to end without a fake Host:
 * the official `ask_user_question` tool asks, THIS connection's standard ACP v1
 * `elicitation/create` form is the only human channel, the accepted answer
 * becomes the official tool result, a timed question stays answerable through
 * the official continued reply (`source.kind = 'user-question-reply'`), and a
 * declined form fails the tool closed instead of fabricating an answer.
 *
 * @module
 */
import assertStrict from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import { installedSdkVersion } from '../../lib/split-smoke-sdk.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.native-question-form'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function fail(label) {
  throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}`)
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
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
  } catch (error) {
    socket.destroy()
    throw error
  }
  const socketClosed = new Promise(resolve => socket.once('close', resolve))
  const app = acp.client({ name: CASE_ID })
  app.onNotification(acp.methods.client.session.update, ({ params }) => { onUpdate(params) })
  /** Every reverse elicitation this connection received, answerable later. */
  const forms = []
  app.onRequest(acp.methods.client.elicitation.create, ({ params }) => new Promise(resolveForm => {
    forms.push({ params, resolve: resolveForm })
  }))
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket)))
  return {
    connection,
    socket,
    socketClosed,
    forms,
    async request(method, params) {
      return await connection.agent.request(method, params)
    },
    async close() {
      try { await connection.close() } catch { /* already closed by the peer */ }
      socket.destroy()
      await Promise.allSettled([connection.closed, socketClosed])
    },
  }
}

/** Await one value from a fresh read (never a fixed sleep on a durable fact). */
async function waitForFact(read, label, timeoutMs = 180_000) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) fail(`timed out waiting for ${label}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}

/** The tool call/result events of one turn, in durable order. */
function toolEventsOf(events, turn, type) {
  return events.filter(event => event.type === type && event.data?.turn === turn)
}

/** The parsed answer/pending object the official tool rendered into its result. */
function toolResultObject(resultEvent) {
  const text = (resultEvent?.data?.message?.content ?? [])
    .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
  return text === '' ? undefined : JSON.parse(text)
}

/** The text of one durable user message event. */
function userText(event) {
  return (event.data?.content ?? []).map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
}

/** The turn owning the durable user message that carries exactly `text`. */
function turnOfUserText(events, text) {
  const index = events.findIndex(event => event.type === 'user/message' && userText(event) === text)
  if (index < 0) return undefined
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (events[cursor]?.type === 'turn/start') return events[cursor].data?.turn
  }
  return undefined
}

/** Assert one standard ACP v1 form request of this real question. */
function assertStandardForm(form, { sessionId, callId, label }) {
  const params = form.params
  assert(params?.sessionId === sessionId, `${label}: the form belongs to the prompted Session`)
  assert(typeof params?.message === 'string' && params.message.length > 0, `${label}: the form carries a message`)
  assert(params?.toolCallId === callId,
    `${label}: the form is keyed by the official tool call id (form=${JSON.stringify(params?.toolCallId)} call=${JSON.stringify(callId)})`)
  const schema = params?.requestedSchema
  assert(schema?.type === 'object' && Array.isArray(schema.required) && schema.required.length === 0,
    `${label}: the form schema is an object with no required field`)
  const q0 = schema?.properties?.q0
  assert(q0?.type === 'string' && typeof q0.title === 'string' && typeof q0.description === 'string',
    `${label}: one standard string property with a title and description`)
  assertStrict.deepEqual((q0.oneOf ?? []).map(option => option.const), ['Proceed', 'Cancel'],
    `${label}: the official option labels become the form choices`)
}

/**
 * Run the native-question qualification.
 * @param {object} context - the split smoke run context.
 * @returns {Promise<object>} the verdict facts gathered from real processes.
 */
export async function runAcpNativeQuestionForm(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context)
  const hostCwd = realpathSync(workDir)
  const clients = []
  let peer
  let host

  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const eventsOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const updates = []

  try {
    mkdirSync(join(workDir, 'naq-workspaces'), { recursive: true, mode: 0o700 })
    rmSync(join(workDir, 'naq-workspaces', 'probe'), { recursive: true, force: true })

    // ── A) One real Host whose scripted provider asks the native question. The
    //      profile uses the official TIMED `ask_user_question` mode (the same
    //      preset patch the T52 preset case owns) so both the indefinite
    //      blocking form (`timeout: -1`) and the timed/continued form exist.
    const started = await scene.startC1Host('question', 'naq A host', {
      SPLIT_PROCESS_EXTRA_PATCH: scene.c1Work.timedPatchPath,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
    })
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    const hostIdentity = await scene.hostIdentityFacts(host)
    trace('acp-native-question/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installation.manifest.version,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
    })

    // ── B) Enable the opt-in front door and open ONE official SDK client that
    //      advertises the standard FORM elicitation capability.
    peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = 'naq B peer'
    await peer.waitFor(record => record.m4a0 === 'ready', 'NAQ B peer ready', 180_000)
    const enable = async (value) => {
      const requestId = `naq-access-${String(Date.now())}-${String(process.pid)}`
      peer.send({ op: 'qualification-acp-access', requestId, acpEnabled: value })
      const record = await peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
        'NAQ B ACP access', 120_000)
      assert(record.ok === true && record.status?.state === 'enabled',
        `NAQ B: the ACP front door must enable (${JSON.stringify(record)})`)
    }
    await enable(true)
    const endpoint = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${scopeId.slice(0, 40)}/acp.sock` }
      : { path: join(scopeDirOf(scopeId), 'acp.sock'), dir: scopeDirOf(scopeId) }
    assert(existsSync(endpoint.path), `NAQ B: the enabled front door must publish ${endpoint.path}`)

    const client = await openSdkClient(endpoint, params => { updates.push(params) })
    clients.push(client)
    const init = await client.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    })
    assert(init?.protocolVersion === 1, 'NAQ C: initialize must answer protocolVersion 1')
    assert(init?.agentInfo?.name === 'dsh-pi-tui', 'NAQ C: initialize must name dsh-pi-tui')

    // ── D) BLOCKING: the real native tool asks, the standard Form is the only
    //      human channel, and the accepted answer becomes the official result.
    trace('naq/step-initialized')
    const sessionA = (await client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    trace('naq/step-session-a')
    assert(typeof sessionA === 'string' && sessionA !== '', 'NAQ D: session/new must create a real Session')
    const promptA = 'acp-question-blocking'
    const startA = eventsOf(sessionA).length
    const resultA = client.request(acp.methods.agent.session.prompt, { sessionId: sessionA, prompt: [{ type: 'text', text: promptA }] })
      .then(value => ({ value }), error => ({ error }))
    trace('naq/step-prompt-a')
    const formA = await waitForFact(() => client.forms.find(form => form.params?.sessionId === sessionA),
      'NAQ D the standard form of the blocking question')
    const callA = await waitForFact(() => {
      const turn = turnOfUserText(eventsOf(sessionA), promptA)
      if (turn === undefined) return undefined
      const call = toolEventsOf(eventsOf(sessionA), turn, 'tool/call')
        .find(event => event.data?.name === 'ask_user_question')
      return call === undefined ? undefined : call.data.callId
    }, 'NAQ D the official ask_user_question tool call')
    assertStandardForm(formA, { sessionId: sessionA, callId: callA, label: 'NAQ D' })
    formA.resolve({ action: 'accept', content: { q0: 'Proceed' } })
    trace('naq/step-form-a')
    const outcomeA = await resultA
    if (outcomeA.error !== undefined) fail(`NAQ D: the blocking prompt rejected (${String(outcomeA.error?.message ?? outcomeA.error)})`)
    const settledA = outcomeA.value
    assert(settledA?.stopReason === 'end_turn', `NAQ D: the answered turn must end_turn (${JSON.stringify(settledA)})`)
    const turnA = turnOfUserText(eventsOf(sessionA), promptA)
    const resultEventA = toolEventsOf(eventsOf(sessionA), turnA, 'tool/result')
      .find(event => event.data?.message?.toolCallId === callA)
    assert(resultEventA?.data?.message?.isError === false, 'NAQ D: the answered question commits a successful tool result')
    assertStrict.deepEqual(toolResultObject(resultEventA), {
      answers: [{ id: 'c1-question', selected: ['Proceed'] }],
    }, 'NAQ D: the human answer is the official tool result')
    assert(eventsOf(sessionA).slice(startA).every(event => event.data?.source?.kind !== 'user-question-reply'),
      'NAQ D: a blocking answer never steers a continued reply')
    const answeredText = eventsOf(sessionA).some(event => event.type === 'assistant/message'
      && (event.data?.message?.content ?? []).some(block => block.type === 'text' && block.text.includes('question answered')))
    assert(answeredText, 'NAQ D: the turn continues to its committed answer text')

    // ── E) TIMED: the official deadline settles the tool as PENDING, the Form
    //      stays answerable, and the late answer steers the official continued
    //      reply exactly once.
    trace('naq/step-blocking-done')
    const sessionB = (await client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    trace('naq/step-session-b')
    const promptB = 'acp-question-timed'
    const startB = eventsOf(sessionB).length
    const resultB = client.request(acp.methods.agent.session.prompt, { sessionId: sessionB, prompt: [{ type: 'text', text: promptB }] })
      .then(value => ({ value }), error => ({ error }))
    const formB = await waitForFact(() => client.forms.find(form => form.params?.sessionId === sessionB),
      'NAQ E the standard form of the timed question')
    trace('naq/step-form-b')
    const outcomeB = await resultB
    if (outcomeB.error !== undefined) fail(`NAQ E: the timed prompt rejected (${String(outcomeB.error?.message ?? outcomeB.error)})`)
    const settledB = outcomeB.value
    assert(settledB?.stopReason === 'end_turn', `NAQ E: the timed turn must end_turn (${JSON.stringify(settledB)})`)
    const turnB = turnOfUserText(eventsOf(sessionB), promptB)
    const callB = toolEventsOf(eventsOf(sessionB), turnB, 'tool/call')
      .find(event => event.data?.name === 'ask_user_question')?.data?.callId
    assert(typeof callB === 'string' && callB !== '', 'NAQ E: the timed question owns a real tool call')
    assertStandardForm(formB, { sessionId: sessionB, callId: callB, label: 'NAQ E' })
    const resultEventB = toolEventsOf(eventsOf(sessionB), turnB, 'tool/result')
      .find(event => event.data?.message?.toolCallId === callB)
    const pendingB = toolResultObject(resultEventB)
    assert(pendingB?.pending === true && pendingB?.callId === callB,
      `NAQ E: the expired foreground wait commits the official pending result (${JSON.stringify(pendingB)})`)
    assert(eventsOf(sessionB).slice(startB).every(event => event.data?.source?.kind !== 'user-question-reply'),
      'NAQ E: no answer is fabricated before the human answers')
    // The Form outlived the turn: answering it late uses the official service.
    formB.resolve({ action: 'accept', content: { q0: 'Cancel' } })
    const replyB = await waitForFact(() => eventsOf(sessionB).slice(startB)
      .find(event => event.type === 'user/message'
        && event.data?.source?.kind === 'user-question-reply'
        && event.data?.source?.callId === callB), 'NAQ E the official continued reply message')
    const repliesB = eventsOf(sessionB).slice(startB)
      .filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply')
    assert(repliesB.length === 1, `NAQ E: exactly one continued reply is steered (got ${String(repliesB.length)})`)
    assert(replyB.data.source.outcome === 'answered', 'NAQ E: the reply records the answered outcome')

    // ── F) NEGATIVE: a declined Form fails the tool closed and invents nothing.
    trace('naq/step-timed-done')
    const sessionC = (await client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    trace('naq/step-session-c')
    const promptC = 'acp-question-decline'
    const startC = eventsOf(sessionC).length
    const resultC = client.request(acp.methods.agent.session.prompt, { sessionId: sessionC, prompt: [{ type: 'text', text: promptC }] })
      .then(value => ({ value }), error => ({ error }))
    const formC = await waitForFact(() => client.forms.find(form => form.params?.sessionId === sessionC),
      'NAQ F the standard form of the declined question')
    formC.resolve({ action: 'decline' })
    trace('naq/step-form-c')
    const outcomeC = await resultC
    if (outcomeC.error !== undefined) fail(`NAQ F: the declined prompt rejected (${String(outcomeC.error?.message ?? outcomeC.error)})`)
    const settledC = outcomeC.value
    assert(settledC?.stopReason === 'end_turn', `NAQ F: the turn still ends after the decline (${JSON.stringify(settledC)})`)
    const turnC = turnOfUserText(eventsOf(sessionC), promptC)
    const callC = toolEventsOf(eventsOf(sessionC), turnC, 'tool/call')
      .find(event => event.data?.name === 'ask_user_question')?.data?.callId
    const resultEventC = toolEventsOf(eventsOf(sessionC), turnC, 'tool/result')
      .find(event => event.data?.message?.toolCallId === callC)
    assert(resultEventC?.data?.message?.isError === true, 'NAQ F: a declined Form fails the official tool closed')
    assert(eventsOf(sessionC).slice(startC).every(event => event.data?.source?.kind !== 'user-question-reply'),
      'NAQ F: no reply is written for a declined question')

    // ── G) No Host replacement and no leaked reverse requests.
    const identityAfter = await scene.hostIdentityFacts(host)
    assert(identityAfter.hostPid === hostIdentity.hostPid && identityAfter.instanceId === hostIdentity.instanceId,
      'NAQ G: the qualification never replaces the Host process or instance')
    const openForms = client.forms.filter(form => form.params?.sessionId !== undefined)
    assert(openForms.length === 3, `NAQ G: exactly three reverse Forms were requested (got ${String(openForms.length)})`)
    trace('acp-native-question/evidence-final', { forms: openForms.length })

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      candidateSha256: context.candidateSha256,
      dshVersion: context.targetDshVersion,
      acpSdkVersion: installedSdkVersion(),
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
      sessions: [sessionA, sessionB, sessionC],
      blocking: { callId: callA, answers: toolResultObject(resultEventA) },
      timed: { callId: callB, pending: pendingB, replies: repliesB.length },
      declined: { callId: callC, isError: resultEventC.data.message.isError },
      forms: openForms.length,
      hostIdentityKept: true,
      acpProtocolVersion: init.protocolVersion,
      nativeQuestionToolResult: true,
      continuedReplySteered: true,
      declineFailsClosed: true,
      l6EvidenceRecorded: true,
    }
  } finally {
    for (const client of clients) await client.close().catch(() => {})
    if (peer !== undefined && peer.exited !== true) {
      try { await peer.shutdown() } catch { /* runner backstop */ }
    }
    if (host !== undefined && host.exited !== true) {
      try { await host.shutdown() } catch { /* runner backstop */ }
    }
    try { await scene.dispose() } catch { /* runner backstop */ }
  }
}
