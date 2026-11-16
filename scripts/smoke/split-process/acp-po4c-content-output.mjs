/**
 * PO-4C real Split-process L6: committed assistant / tool standard output.
 *
 * The case drives the REAL Linux Split Host (one Host PID/instance, one TUI
 * Client, the official Session/Agent/persistence Writer) and a raw ACP v1
 * client over the Host-owned pathname UDS. The only offline substitutions are
 * the deterministic C1 model stream, the smoke-generated PNGs and the
 * test-owned Host tool: every image is stored and re-read by the official Host
 * Attachment Store, and every asserted notification is compared against the
 * durable committed Session event of the exact claimed turn.
 *
 * Positive proofs (L6-C01..C04): assistant text/image/text order, image-only
 * output, one ordered tool_call_update with text/JSON/image content and the
 * official failed status, all with exact stored bytes/digests and one standard
 * ACP frame above the legacy 256 KiB cap.
 *
 * Negative/lifecycle proofs (L6-C05..C06): a format-valid but absent image
 * reference fails ONLY its own flight, and a slow reader that stops draining a
 * large frame is closed by the bounded drain while the sibling ACP connection
 * and the real TUI keep completing their own turns on the same Host.
 *
 * @module split-process/acp-po4c-content-output
 */

import assertStrict from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import sharp from 'sharp'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The legacy single outbound ACP frame cap that a real image frame must exceed. */
const LEGACY_FRAME_BYTES = 256 * 1024

/** The fixture's frozen committed-content samples (mirrored from the C1 fixture). */
const MARKERS = Object.freeze({
  assistantMixed: 'po4c:assistant-mixed:v1',
  assistantImageOnly: 'po4c:assistant-image-only:v1',
  toolContent: 'po4c:tool-content:v1',
  toolFailed: 'po4c:tool-failed:v1',
  missingImage: 'po4c:missing-image:v1',
  health: 'po4c:health',
})
const TEXT_BEFORE = 'before\r\n'
const TEXT_AFTER = 'after 中文🙂\n'
const TOOL_TAIL = 'tool-tail\n'
const A2UI_TEXT = 'A2UI_JSON={"version":"popo.a2ui/1","components":[{"kind":"text","value":"透明"}]}'
const TOOL_ANSWER = 'tool completed\n'
const TOOL_FAILED_ANSWER = 'tool failed\n'
const TOOL_NAME = 'po4c_output_tool'

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Bound one lifecycle wait so a stuck fact fails the case instead of hanging it. */
function withDeadline(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new SplitSmokeAssertionError(`PO-4C: timed out waiting for ${label}`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

function authoredText(message) {
  return (message?.content ?? []).map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

/** One raw NDJSON client that keeps the exact wire byte length of every frame. */
class AcpRawClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.entries = []
    this.waiters = []
    this.closed = new Promise(resolveClose => socket.on('close', resolveClose))
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const entry = { message: JSON.parse(line), rawBytes: Buffer.byteLength(line, 'utf8') + 1 }
        const waiterIndex = this.waiters.findIndex(waiter => waiter.matches(entry.message))
        if (waiterIndex >= 0) {
          const [waiter] = this.waiters.splice(waiterIndex, 1)
          clearTimeout(waiter.timer)
          waiter.resolve(entry)
        } else this.entries.push(entry)
      }
    })
  }

  send(message) { this.socket.write(`${JSON.stringify(message)}\n`) }
  sendBytes(bytes) { this.socket.write(bytes) }
  pause() { this.socket.pause() }
  resume() { this.socket.resume() }
  close() { this.socket.destroy() }

  next(matches = () => true, timeoutMs = 180_000) {
    const index = this.entries.findIndex(entry => matches(entry.message))
    if (index >= 0) return Promise.resolve(this.entries.splice(index, 1)[0])
    return new Promise((resolveNext, rejectNext) => {
      const waiter = { matches, resolve: resolveNext, timer: undefined }
      waiter.timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter)
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)
        rejectNext(new Error(`PO-4C ACP client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async initialize(id) {
    this.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    return await this.next(message => message.id === id)
  }
}

async function openAcpClient(scopeDir) {
  const dirFd = openSync(scopeDir, 'r')
  try {
    const path = `/proc/self/fd/${String(dirFd)}/acp.sock`
    return await new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.off('error', rejectOpen)
        resolveOpen(new AcpRawClient(socket))
      })
      socket.once('error', rejectOpen)
    })
  } finally {
    closeSync(dirFd)
  }
}

/** Read one prompt request's ordered `session/update` entries and its response. */
async function readPrompt(client, id) {
  const updates = []
  for (;;) {
    const entry = await client.next(message => message?.method === 'session/update' || message?.id === id)
    if (entry.message?.method === 'session/update') {
      updates.push(entry)
      continue
    }
    return { response: entry.message, responseBytes: entry.rawBytes, updates }
  }
}

/** The nearest turn/start before one durable event index. */
function turnOfEvent(events, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (events[cursor]?.type === 'turn/start') return events[cursor].data?.turn
  }
  return undefined
}

/** One committed image content block's durable reference. */
function imageRefOf(block) {
  assert(block?.type === 'image' && typeof block?.attachment?.attachmentId === 'string',
    'PO-4C: a committed image block must carry its durable official reference')
  return block.attachment
}

export async function runAcpPo4cContentOutput(context) {
  const { dshHome, workDir, trace } = context
  const scene = createC1Scene(context, { imageProbe: true })
  const workRoot = scene.c1WorkRoot('acp-po4c')
  const hostCwd = realpathSync(workDir)
  const pngDir = join(workDir, 'po4c-images')
  mkdirSync(pngDir, { recursive: true, mode: 0o700 })
  chmodSync(pngDir, 0o700)
  // The official Store normalizes what it stores, so the >256 KiB proof is made
  // against the REAL stored reference/frame below, never against this input.
  const mixedPng = await sharp(randomBytes(700 * 700 * 3), { raw: { width: 700, height: 700, channels: 3 } })
    .png({ compressionLevel: 1 }).toBuffer()
  const toolPng = await sharp(randomBytes(120 * 120 * 3), { raw: { width: 120, height: 120, channels: 3 } })
    .png({ compressionLevel: 1 }).toBuffer()
  assert(mixedPng.length > 1024 * 1024 && mixedPng.length < 2 * 1024 * 1024,
    `PO-4C L6 needs a valid 1..2 MiB PNG under the Host single-image limit; got ${String(mixedPng.length)} bytes`)
  writeFileSync(join(pngDir, 'mixed.png'), mixedPng, { mode: 0o600 })
  writeFileSync(join(pngDir, 'tool.png'), toolPng, { mode: 0o600 })

  const acpClients = []
  const peers = []
  let host
  let tui
  let caseId = 0
  const track = client => { acpClients.push(client); return client }

  const enableAcp = async () => {
    const peer = new context.EntryProcess('peer', context.entries.client, {
      ...context.base,
      env: { ...context.base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', 'PO-4C ACP control peer ready', 180_000)
    const requestId = `po4c-enable-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId, acpEnabled: true })
    const response = await peer.waitFor(record => record.op === 'acp-access' && record.requestId === requestId,
      'PO-4C ACP listener enabled', 120_000)
    assert(response.ok === true && response.status?.state === 'enabled', `PO-4C ACP did not enable: ${JSON.stringify(response)}`)
  }

  const openConnection = async (scopeDir, label) => {
    const client = track(await openAcpClient(scopeDir))
    const init = await client.initialize(++caseId)
    assert(init?.message?.result?.protocolVersion === 1, `${label}: ACP initialize must answer the ACP v1 protocol`)
    assert(init.message.result.agentInfo?.version === context.installation.manifest.version,
      `${label}: initialize reports the installed bundle version`)
    // The C1 route declares no image input modality: assistant/tool OUTPUT
    // images must not depend on this prompt capability.
    assert(init.message.result.agentCapabilities?.promptCapabilities?.image === false,
      `${label}: the fixture route must NOT advertise image prompts (output must not depend on it)`)
    return client
  }

  const resume = async (client, sessionId, label) => {
    const id = ++caseId
    client.send({ jsonrpc: '2.0', id, method: 'session/resume', params: { sessionId, cwd: hostCwd } })
    const entry = await client.next(message => message.id === id)
    return entry.message
  }

  /**
   * Run one ACP prompt and correlate it with the exact durable facts:
   * official insertion (`source.rpcId`) -> durable user/message -> claimed turn
   * -> the turn's real `turn/end`.
   */
  const runPrompt = async (client, sessionId, text, label) => {
    const start = (hostSessionEvents(dshHome, sessionId) ?? []).length
    const id = ++caseId
    const pending = readPrompt(client, id)
    client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
    const inserted = await waitForHostSessionEventAfter(dshHome, sessionId, start,
      event => event.type === 'agent/inbox/spliced'
        && (event.data?.inserted ?? []).some(message => message.source?.kind === 'user' && authoredText(message) === text),
      `${label} exact official Inbox insertion`)
    const insertedMessage = (inserted.data.inserted ?? []).find(message => message.source?.kind === 'user' && authoredText(message) === text)
    const requestId = insertedMessage?.source?.rpcId
    assert(typeof requestId === 'string' && requestId.length > 0, `${label}: the official insertion must carry its exact requestId`)
    const durable = await waitForHostSessionEventAfter(dshHome, sessionId, start,
      event => event.type === 'user/message' && event.data?.source?.rpcId === requestId,
      `${label} durable user/message for the exact requestId`)
    const events = hostSessionEvents(dshHome, sessionId) ?? []
    const userIndex = events.findIndex((event, index) => index >= start
      && event.type === 'user/message' && event.data?.source?.rpcId === requestId)
    const turn = turnOfEvent(events, userIndex)
    assert(Number.isInteger(turn), `${label}: the durable user message must be claimed by a real turn/start`)
    const settled = await pending
    await waitForHostSessionEventAfter(dshHome, sessionId, start,
      event => event.type === 'turn/end' && event.data?.turn === turn, `${label} real turn/end`)
    const turnEvents = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.data?.turn === turn)
    return { start, id, turn, requestId, messageId: durable.data.id, settled, turnEvents }
  }

  const assertEndTurn = (settled, label) => {
    assert(settled.response.error === undefined && settled.response.result?.stopReason === 'end_turn',
      `${label}: prompt failed: ${JSON.stringify(settled.response.error ?? settled.response.result)}`)
  }

  const assertImageContent = (content, ref, label) => {
    assert(content?.type === 'image', `${label}: expected one standard ACP image content block`)
    const decoded = Buffer.from(content.data ?? '', 'base64')
    assertStrict.equal(content.mimeType, ref.mediaType, `${label}: the wire MIME must be the verified stored MIME`)
    assertStrict.equal(decoded.length, ref.bytes, `${label}: the wire image must decode to the stored byte length`)
    assertStrict.equal(hash(decoded), ref.attachmentId.replace(/^sha256:/u, ''),
      `${label}: the wire image bytes must equal the verified stored object`)
    return decoded
  }

  try {
    const started = await scene.startC1Host('acp-po4c', 'po4c Host', {
      C1_PO4C_IMAGE_DIR: pngDir,
      C1_PO4C_READ_ARM: join(workDir, 'po4c-read.arm'),
      C1_PO4C_READ_RELEASE: join(workDir, 'po4c-read.release'),
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
    }, workRoot)
    host = started.host
    const ready = started.ready
    const hostIdentity = await scene.hostIdentityFacts(host)
    const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId)
    assert(ready.localHost?.hostPid === hostIdentity.hostPid && typeof ready.localHost.instanceId === 'string',
      'PO-4C L6 must retain the exact Host process and instance identity')
    await enableAcp()
    const opened = await scene.startC1Client('po4c TUI', {}, { cwd: hostCwd })
    tui = opened.client
    tui.send('/new\r')
    const openedSession = await waitForSurfaceStatus(tui,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.transport === 'connected' && record.surfaceMounted === true,
      'PO-4C shared Session open')
    const sessionId = openedSession.openSessionId

    const acp = await openConnection(scopeDir, 'PO-4C primary ACP connection')
    assertStrict.deepEqual((await resume(acp, sessionId, 'PO-4C attach the TUI Session')).result, {})

    // L6-C01: committed assistant text/image/text in exact order, same message
    // id, and a standard ACP image frame above the legacy 256 KiB cap.
    const mixed = await runPrompt(acp, sessionId, MARKERS.assistantMixed, 'PO-4C assistant text/image/text')
    assertEndTurn(mixed.settled, 'PO-4C assistant text/image/text')
    const mixedMessages = mixed.turnEvents.filter(event => event.type === 'assistant/message')
    assertStrict.equal(mixedMessages.length, 1, 'PO-4C: the mixed turn commits exactly one assistant message')
    const mixedCommitted = mixedMessages[0].data.message
    assertStrict.deepEqual(mixedCommitted.content.map(block => block.type), ['text', 'image', 'text'],
      'PO-4C: the durable assistant content is text/image/text')
    assertStrict.equal(mixedCommitted.content[0].text, TEXT_BEFORE)
    assertStrict.equal(mixedCommitted.content[2].text, TEXT_AFTER)
    const mixedRef = imageRefOf(mixedCommitted.content[1])
    assertStrict.equal(mixed.settled.updates.length, 3, 'PO-4C: one ACP chunk per committed assistant block, no more')
    const mixedKinds = mixed.settled.updates.map(entry => entry.message.params.update.sessionUpdate)
    assertStrict.deepEqual(mixedKinds, ['agent_message_chunk', 'agent_message_chunk', 'agent_message_chunk'])
    assert(mixed.settled.updates.every(entry => entry.message.params.update.messageId === mixedCommitted.id),
      'PO-4C: every assistant chunk keeps the committed message id')
    assertStrict.equal(mixed.settled.updates[0].message.params.update.content.text, TEXT_BEFORE)
    assertStrict.equal(mixed.settled.updates[2].message.params.update.content.text, TEXT_AFTER)
    const mixedImage = assertImageContent(mixed.settled.updates[1].message.params.update.content, mixedRef, 'PO-4C assistant image')
    const mixedFrameBytes = mixed.settled.updates[1].rawBytes
    assert(mixedFrameBytes > LEGACY_FRAME_BYTES,
      `PO-4C: the delivered image frame must exceed the legacy 256 KiB cap (got ${String(mixedFrameBytes)})`)
    const mixedStored = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-image-stored' && event.name === 'mixed.png' && event.pid === hostIdentity.hostPid,
      'PO-4C official Store mixed image proof')
    assert(mixedStored.attachmentId === mixedRef.attachmentId && mixedStored.bytes === mixedImage.length
      && mixedStored.sha256 === hash(mixedImage) && mixedStored.mediaType === mixedRef.mediaType,
    'PO-4C: the wire bytes/digest/MIME must equal the Host Store save + re-read proof')

    // L6-C02: an image-only assistant message is real visible output.
    const imageOnly = await runPrompt(acp, sessionId, MARKERS.assistantImageOnly, 'PO-4C assistant image-only')
    assertEndTurn(imageOnly.settled, 'PO-4C assistant image-only')
    const imageOnlyMessage = imageOnly.turnEvents.find(event => event.type === 'assistant/message')?.data.message
    assertStrict.deepEqual(imageOnlyMessage.content.map(block => block.type), ['image'])
    assertStrict.equal(imageOnly.settled.updates.length, 1)
    assertImageContent(imageOnly.settled.updates[0].message.params.update.content, imageRefOf(imageOnlyMessage.content[0]), 'PO-4C image-only assistant')

    // L6-C03: one ordered tool_call_update with text / JSON-byte sample / image.
    const tool = await runPrompt(acp, sessionId, MARKERS.toolContent, 'PO-4C tool content')
    assertEndTurn(tool.settled, 'PO-4C tool content')
    const toolCallEvent = tool.turnEvents.find(event => event.type === 'tool/call')
    const toolResultEvent = tool.turnEvents.find(event => event.type === 'tool/result')
    assert(toolCallEvent !== undefined && toolResultEvent !== undefined, 'PO-4C: the tool turn commits one call and one result')
    const toolCallId = toolCallEvent.data.callId
    const toolResult = toolResultEvent.data.message
    assertStrict.equal(toolResult.isError, false)
    assertStrict.deepEqual(toolResult.content.map(block => block.type), ['text', 'image', 'text'])
    assertStrict.equal(toolResult.content[0].text, A2UI_TEXT)
    assertStrict.equal(toolResult.content[2].text, TOOL_TAIL)
    const toolRef = imageRefOf(toolResult.content[1])
    const toolKinds = tool.settled.updates.map(entry => entry.message.params.update.sessionUpdate)
    assertStrict.deepEqual(toolKinds, ['tool_call', 'tool_call_update', 'agent_message_chunk'],
      'PO-4C: exactly one start update, ONE result update and the final assistant chunk')
    const startUpdate = tool.settled.updates[0].message.params.update
    assertStrict.equal(startUpdate.toolCallId, toolCallId)
    assertStrict.equal(startUpdate.title, TOOL_NAME)
    assertStrict.equal(startUpdate.kind, 'other')
    assertStrict.equal(startUpdate.status, 'in_progress')
    const resultUpdate = tool.settled.updates[1].message.params.update
    assertStrict.equal(resultUpdate.toolCallId, toolCallId)
    assertStrict.equal(resultUpdate.status, 'completed')
    assertStrict.equal(resultUpdate.content.length, 3, 'PO-4C: one tool_call_update carries the whole ordered content')
    assertStrict.equal(resultUpdate.content[0].content.type, 'text')
    assertStrict.equal(resultUpdate.content[0].content.text, A2UI_TEXT,
      'PO-4C: the A2UI JSON sample stays ordinary text bytes (never parsed)')
    assertImageContent(resultUpdate.content[1].content, toolRef, 'PO-4C tool image')
    assertStrict.equal(resultUpdate.content[2].content.text, TOOL_TAIL)
    const finalToolChunk = tool.settled.updates[2].message.params.update
    assertStrict.equal(finalToolChunk.messageId, tool.turnEvents
      .filter(event => event.type === 'assistant/message').at(-1)?.data.message.id)
    assertStrict.equal(finalToolChunk.content.text, TOOL_ANSWER)
    assertStrict.equal(tool.settled.updates.filter(entry => entry.message.params.update.sessionUpdate === 'tool_call').length, 1,
      'PO-4C: the assistant tool-call block never duplicates the durable tool/call start')
    const toolStored = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-image-stored' && event.name === 'tool.png' && event.pid === hostIdentity.hostPid,
      'PO-4C official Store tool image proof')
    assert(toolStored.attachmentId === toolRef.attachmentId && toolStored.sha256 === toolRef.attachmentId.replace(/^sha256:/u, ''),
      'PO-4C: the tool image wire bytes equal the verified stored object')

    // L6-C04: the failed status comes from the official isError fact only.
    const failed = await runPrompt(acp, sessionId, MARKERS.toolFailed, 'PO-4C failed tool result')
    assertEndTurn(failed.settled, 'PO-4C failed tool result')
    const failedResult = failed.turnEvents.find(event => event.type === 'tool/result')?.data.message
    assertStrict.equal(failedResult.isError, true, 'PO-4C: the durable tool result is a real failure')
    const failedKinds = failed.settled.updates.map(entry => entry.message.params.update.sessionUpdate)
    assertStrict.deepEqual(failedKinds, ['tool_call', 'tool_call_update', 'agent_message_chunk'])
    const failedUpdate = failed.settled.updates[1].message.params.update
    assertStrict.equal(failedUpdate.status, 'failed')
    assertStrict.equal(failedUpdate.toolCallId, failedResult.toolCallId)
    assertStrict.equal(failed.settled.updates[2].message.params.update.content.text, TOOL_FAILED_ANSWER)

    // L6-C05: a format-valid but absent image reference fails ONLY this flight.
    const missing = await runPrompt(acp, sessionId, MARKERS.missingImage, 'PO-4C missing image')
    assert(missing.settled.response.error?.data?.code === 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED',
      `PO-4C: an absent committed image must fail with the attachment-read class (got ${JSON.stringify(missing.settled.response.error ?? missing.settled.response.result)})`)
    assert(missing.settled.response.result === undefined, 'PO-4C: a failed image read never answers a StopReason')
    assert(missing.settled.updates.every(entry => entry.message.params.update.sessionUpdate !== 'agent_message_chunk'),
      'PO-4C: no partial assistant chunk is sent for the failed event')
    const missingMessage = missing.turnEvents.find(event => event.type === 'assistant/message')?.data.message
    const missingRef = imageRefOf(missingMessage?.content?.[0])
    const missingRejected = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-missing-image-rejected' && event.attachmentId === missingRef.attachmentId,
      'PO-4C official Store absent-image rejection')
    assert(missingRejected.code === 'ATTACHMENT_NOT_FOUND',
      `PO-4C: the real official Store must reject the absent object (got ${String(missingRejected.code)})`)
    const healthyAfterMissing = await runPrompt(acp, sessionId, MARKERS.health, 'PO-4C healthy prompt after the failure')
    assertEndTurn(healthyAfterMissing.settled, 'PO-4C healthy prompt after the failure')
    assertStrict.equal(healthyAfterMissing.settled.updates.length, 1,
      'PO-4C: the failure is scoped to its own flight; the same view keeps working')

    // L6-C06: a slow reader is closed by the bounded drain while a sibling ACP
    // connection and the real TUI keep completing their own turns.
    const victim = await openConnection(scopeDir, 'PO-4C slow reader')
    const victimNew = ++caseId
    victim.send({ jsonrpc: '2.0', id: victimNew, method: 'session/new', params: { cwd: hostCwd, mcpServers: [] } })
    const victimSession = (await victim.next(message => message.id === victimNew)).message.result?.sessionId
    assert(typeof victimSession === 'string' && victimSession !== sessionId,
      'PO-4C: the slow reader owns its own Host Session')
    victim.pause()
    const victimPromptId = ++caseId
    victim.send({ jsonrpc: '2.0', id: victimPromptId, method: 'session/prompt',
      params: { sessionId: victimSession, prompt: [{ type: 'text', text: MARKERS.assistantMixed }] } })

    // Sibling ACP connection: a NEW Host Session on the SAME Host, completed
    // while the slow reader's large frame is stalled.
    const sibling = await openConnection(scopeDir, 'PO-4C sibling ACP connection')
    const siblingNew = ++caseId
    sibling.send({ jsonrpc: '2.0', id: siblingNew, method: 'session/new', params: { cwd: hostCwd, mcpServers: [] } })
    const siblingSession = (await sibling.next(message => message.id === siblingNew)).message.result?.sessionId
    assert(typeof siblingSession === 'string' && siblingSession !== sessionId,
      'PO-4C: the sibling connection creates its own Host Session')
    const siblingPrompt = await runPrompt(sibling, siblingSession, MARKERS.health, 'PO-4C sibling ACP prompt')
    assertEndTurn(siblingPrompt.settled, 'PO-4C sibling ACP prompt')

    // The real TUI keeps its own turn on the shared Host while the reader stalls.
    const tuiStart = (hostSessionEvents(dshHome, sessionId) ?? []).length
    tui.send(`${MARKERS.health}-tui\r`)
    const tuiTurnEnd = await waitForHostSessionEventAfter(dshHome, sessionId, tuiStart,
      event => event.type === 'turn/end', 'PO-4C TUI-owned turn end', 120_000)
    const tuiTurn = tuiTurnEnd.data.turn
    const tuiAnswer = (hostSessionEvents(dshHome, sessionId) ?? [])
      .filter(event => event.type === 'assistant/message' && event.data?.turn === tuiTurn)
      .map(event => authoredText({ content: event.data.message.content }))
      .join('')
    assert(tuiAnswer.includes('po4c answer'), 'PO-4C: the real TUI completes its own turn on the same Host')
    // The TUI-owned turn shares the ACP View's Session: its committed output
    // must never be attributed to the ACP flight. The fence is the connection's
    // OWN serialized write order: the SDK writes this connection's frames one at
    // a time, so any stray projection would arrive BEFORE this response.
    const fenceId = ++caseId
    acp.send({ jsonrpc: '2.0', id: fenceId, method: 'session/list', params: {} })
    const strayTui = []
    for (;;) {
      const entry = await acp.next(message => message?.id === fenceId || message?.method === 'session/update')
      if (entry.message?.id === fenceId) break
      strayTui.push(entry)
    }
    assert(strayTui.length === 0,
      `PO-4C: a foreign TUI turn never projects onto the ACP View (got ${String(strayTui.length)} stray update(s))`)

    // The bounded drain (30s) is the ONLY way this stalled large frame ends:
    // the Host records the backpressure class and closes that ONE connection.
    const backpressure = await host.waitFor(record => record.m4a0 === 'diag'
      && record.message === 'local-acp.error' && record.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE',
    'PO-4C slow-reader bounded drain close', 120_000)
    assert(backpressure.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE')
    victim.resume()
    await withDeadline(victim.closed, 30_000, 'PO-4C slow-reader connection close')
    const siblingStill = await runPrompt(sibling, siblingSession, MARKERS.health, 'PO-4C sibling ACP prompt after the close')
    assertEndTurn(siblingStill.settled, 'PO-4C sibling ACP prompt after the close')

    // A new View of the SLOW READER's own Session is clean: the closed
    // connection's late output never enters it. The old claim is released by
    // its own settlement.
    let reattached
    let reattachAttempts = 0
    for (;;) {
      reattachAttempts += 1
      const candidate = await openConnection(scopeDir, `PO-4C reattach attempt ${String(reattachAttempts)}`)
      const resumed = await resume(candidate, victimSession, 'PO-4C reattach after the slow-reader close')
      if (resumed.error === undefined) { reattached = candidate; break }
      assert(resumed.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
        `PO-4C: unexpected reattach rejection ${JSON.stringify(resumed.error)}`)
      candidate.close()
      await new Promise(resolveTick => setTimeout(resolveTick, 50))
      assert(reattachAttempts < 200, 'PO-4C: the closed View never released its Session claim')
    }
    const clean = await runPrompt(reattached, victimSession, MARKERS.health, 'PO-4C clean prompt after reattach')
    assertEndTurn(clean.settled, 'PO-4C clean prompt after reattach')
    assertStrict.equal(clean.settled.updates.length, 1,
      'PO-4C: the new View receives exactly its own output, never a late read of the closed one')
    assertStrict.equal(clean.settled.updates[0].message.params.update.content.type, 'text')

    // L6-C06 (late read): the official Store read completes AFTER the ACP
    // connection was destroyed. The new View of that Session must never see
    // the late image.
    const armPath = join(workDir, 'po4c-read.arm')
    const releasePath = join(workDir, 'po4c-read.release')
    writeFileSync(armPath, '', { mode: 0o600 })
    const latePromptId = ++caseId
    acp.send({ jsonrpc: '2.0', id: latePromptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: MARKERS.assistantMixed }] } })
    const readHeld = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-read-held' && event.attachmentId === mixedRef.attachmentId,
      'PO-4C held official Store read', 120_000)
    assert(readHeld.attachmentId === mixedRef.attachmentId)
    acp.close()
    writeFileSync(releasePath, 'release\n', { mode: 0o600 })
    await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-read-released' && event.attachmentId === mixedRef.attachmentId,
      'PO-4C late official Store read completion', 120_000)
    rmSync(armPath, { force: true })
    let lateView
    let lateAttempts = 0
    for (;;) {
      lateAttempts += 1
      const candidate = await openConnection(scopeDir, `PO-4C late-read reattach attempt ${String(lateAttempts)}`)
      const resumed = await resume(candidate, sessionId, 'PO-4C late-read reattach')
      if (resumed.error === undefined) { lateView = candidate; break }
      assert(resumed.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
        `PO-4C: unexpected late-read reattach rejection ${JSON.stringify(resumed.error)}`)
      candidate.close()
      await new Promise(resolveTick => setTimeout(resolveTick, 50))
      assert(lateAttempts < 200, 'PO-4C: the disconnected View never released its Session claim')
    }
    const lateClean = await runPrompt(lateView, sessionId, MARKERS.health, 'PO-4C clean prompt after the late read')
    assertEndTurn(lateClean.settled, 'PO-4C clean prompt after the late read')
    assertStrict.equal(lateClean.settled.updates.length, 1,
      'PO-4C: the new View receives only its own output after a late Store read completion')
    assertStrict.equal(lateClean.settled.updates[0].message.params.update.content.type, 'text')

    const identityAfter = await scene.hostIdentityFacts(host)
    assert(identityAfter.hostPid === hostIdentity.hostPid && identityAfter.instanceId === hostIdentity.instanceId,
      'PO-4C: no Host process/instance was replaced or restarted')
    const imageProbes = readC1WorkEvents(workRoot).filter(event => event.kind === 'po4c-image-stored')
    assert(imageProbes.length === 2, `PO-4C: both fixture images were stored exactly once (got ${String(imageProbes.length)})`)

    const evidence = {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      candidateSha256: context.candidateSha256,
      dshVersion: context.targetDshVersion,
      acpSdkVersion: '1.4.0',
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId: ready.localHost.scopeId,
      sessionId,
      assistant: {
        turn: mixed.turn,
        messageId: mixedCommitted.id,
        attachmentId: mixedRef.attachmentId,
        storedBytes: mixedRef.bytes,
        wireFrameBytes: mixedFrameBytes,
        legacyFrameBytes: LEGACY_FRAME_BYTES,
        blockSha256: [hash(TEXT_BEFORE), hash(TEXT_AFTER)].map(value => value),
      },
      tool: {
        turn: tool.turn,
        callId: toolCallId,
        resultAttachmentId: toolRef.attachmentId,
        resultStoredBytes: toolRef.bytes,
        a2uiSha256: hash(A2UI_TEXT),
      },
      failedTool: { turn: failed.turn, callId: failedResult.toolCallId, isError: failedResult.isError },
      missingImage: { turn: missing.turn, attachmentId: missingRef.attachmentId, hostCode: missingRejected.code,
        acpCode: missing.settled.response.error?.data?.code },
      slowPeer: {
        backpressureCode: backpressure.code,
        victimSessionId: victimSession,
        siblingSessionId: siblingSession,
        tuiTurn,
        reattachAttempts,
        lateRead: { attachmentId: mixedRef.attachmentId, releasedAfterDisconnect: true, lateAttempts },
      },
      imageProbes,
    }
    trace('acp-po4c/evidence', evidence)
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      assistantTextImageTextOrdered: true,
      assistantImageOnlyAccepted: true,
      toolResultOrderedContent: true,
      toolFailedStatus: true,
      missingImageRejected: true,
      largeImageFrameAboveLegacyCap: true,
      slowPeerIsolated: true,
      siblingAcpAndTuiUnaffected: true,
      reattachAfterFailureClean: true,
      lateReadAfterCloseInert: true,
      noForeignTurnProjected: true,
      hostIdentityKept: true,
      readImageVerified: true,
      l6EvidenceRecorded: true,
      evidence,
    }
  } finally {
    for (const client of acpClients) {
      try { client.close() } catch { /* already closed */ }
    }
    for (const peer of peers) {
      if (!peer.exited) {
        try { await peer.shutdown() } catch { /* process backstop */ }
      }
    }
    if (tui !== undefined) {
      try { await scene.exitC1Client(tui, 'PO-4C TUI') } catch { /* process backstop */ }
    }
    try { await scene.dispose() } catch { /* process backstop */ }
    try { await scene.awaitSceneSeatFree().catch(() => {}) } catch { /* seat best effort on failure */ }
  }
}
