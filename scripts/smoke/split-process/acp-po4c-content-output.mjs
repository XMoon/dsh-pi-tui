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
 * Positive proofs (L6-C01..C03): committed assistant text/image/text and ONE
 * large ordered tool_call_update with a text/image/text result, all with exact
 * stored bytes/digests/MIME and one standard ACP frame above the legacy 256 KiB
 * cap. The large tool image is a distinct real Host Store object and keeps the
 * `toolRef` association the later two-image overflow negative needs.
 *
 * Negative/lifecycle proofs (L6-C06..C07): a slow reader that stops draining a
 * large frame is closed by the bounded drain while the sibling ACP connection
 * and the real TUI keep completing their own turns on the same Host; a
 * two-image tool result above the connection allowance fails closed. Ordinary
 * image-only / failed-tool / missing-object content semantics are owned by the
 * independent official SDK content case, not repeated here.
 *
 * @module split-process/acp-po4c-content-output
 */

import assertStrict from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import sharp from 'sharp'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { installedSdkVersion } from '../../lib/split-smoke-sdk.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The legacy single outbound ACP frame cap that a real image frame must exceed. */
const LEGACY_FRAME_BYTES = 256 * 1024

/** The fixture's frozen committed-content samples (mirrored from the C1 fixture). */
const MARKERS = Object.freeze({
  assistantMixed: 'po4c:assistant-mixed:v1',
  toolContent: 'po4c:tool-content:v1',
  health: 'po4c:health',
  toolTwoImages: 'po4c:tool-two-images:v1',
})

/**
 * F1 (Owner amendment A1) capacity qualification: a legal, independent Host
 * attachment configuration where a stored output image is NOT bounded by the
 * prompt-batch limit (`maxImageBytes` > `maxMessageImageBytes`), and the single
 * event allowance is one image.
 */
const CAPACITY_LIMITS = Object.freeze({
  maxImageBytes: 4 * 1024 * 1024,
  maxImagesPerMessage: 1,
  maxMessageImageBytes: 512 * 1024,
})
const CAPACITY_PNG_DIMENSION = 1080
const WRITER_BACKLOG_BOUND_BYTES = 256 * 1024

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

/**
 * The canonical TEXT bytes of one committed content block list, in committed
 * block order. A legal streaming segmentation may split these bytes into any
 * number of chunks; the concatenated delivered text must equal this exactly.
 */
function committedText(message) {
  return (message?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('')
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

/**
 * G-ACP2-PR2 read-only projections of the SHARED Session ride the same
 * connection but are never part of a prompt's flight output. A flight
 * assertion filters them out explicitly; a "nothing at all arrives" assertion
 * does not use this filter.
 */
const READ_ONLY_PROJECTION_KINDS = new Set([
  'plan', 'plan_update', 'plan_removed', 'session_info_update', 'usage_update',
  'compaction_update', 'subagent_update', 'session_message', 'notice',
  // PR3A adds the complete command catalog and connection-owned config options
  // as baseline attach notifications. They are not assistant content.
  'available_commands_update', 'config_option_update',
])
const flightOnly = updates => updates.filter(entry =>
  !READ_ONLY_PROJECTION_KINDS.has(entry?.message?.params?.update?.sessionUpdate))

export async function runAcpPo4cContentOutput(context) {
  const { dshHome, workDir, trace } = context
  const scene = createC1Scene(context, { imageProbe: true })
  const workRoot = scene.c1WorkRoot('acp-po4c')
  const hostCwd = realpathSync(workDir)
  const pngDir = join(workDir, 'po4c-images')
  mkdirSync(pngDir, { recursive: true, mode: 0o700 })
  chmodSync(pngDir, 0o700)
  // The official Store normalizes what it stores, so every capacity proof below
  // is made against the REAL stored reference/frame, never against this input.
  // Each source sits just under the configured per-object admission ceiling and
  // inside the official normalization limits, so it is stored verbatim.
  const dimension = CAPACITY_PNG_DIMENSION
  const mixedPng = await sharp(randomBytes(dimension * dimension * 3), { raw: { width: dimension, height: dimension, channels: 3 } })
    .png({ compressionLevel: 1 }).toBuffer()
  const toolPng = await sharp(randomBytes(dimension * dimension * 3), { raw: { width: dimension, height: dimension, channels: 3 } })
    .png({ compressionLevel: 1 }).toBuffer()
  for (const [label, png] of [['mixed', mixedPng], ['tool', toolPng]]) {
    assert(png.length > 3 * 1024 * 1024 && png.length < CAPACITY_LIMITS.maxImageBytes,
      `PO-4C L6 needs a valid near-ceiling PNG under the Host per-object limit (${label}: ${String(png.length)} bytes)`)
  }
  writeFileSync(join(pngDir, 'mixed.png'), mixedPng, { mode: 0o600 })
  writeFileSync(join(pngDir, 'tool.png'), toolPng, { mode: 0o600 })

  const acpClients = []
  const peers = []
  let host
  let tui
  let caseId = 0
  /** The Host RSS sampler of this case; always cleared by the outer finally. */
  let rssTimer
  const rssSamples = []
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
    return {
      start, id, turn, requestId, messageId: durable.data.id, turnEvents,
      settled: { ...settled, updates: flightOnly(settled.updates ?? []) },
    }
  }

  /**
   * Wait for a Host record arriving AFTER `fromIndex`. The Host's stdout record
   * stream is append-only, so the index is the fence between "before this step"
   * and "this step's own fact".
   */
  const waitForHostRecordAfter = async (fromIndex, matches, label, timeoutMs = 120_000) => {
    const started = Date.now()
    for (;;) {
      const record = host.records.slice(fromIndex).find(matches)
      if (record !== undefined) return record
      if (Date.now() - started > timeoutMs) {
        throw new SplitSmokeAssertionError(`PO-4C: timed out waiting for ${label}`)
      }
      await new Promise(resolveTick => setTimeout(resolveTick, 25))
    }
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
      C1_PO4C_IMAGE_LIMITS_JSON: JSON.stringify(CAPACITY_LIMITS),
      C1_PO4C_READ_ARM: join(workDir, 'po4c-read.arm'),
      C1_PO4C_READ_RELEASE: join(workDir, 'po4c-read.release'),
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
    }, workRoot)
    host = started.host
    const ready = started.ready
    const hostIdentity = await scene.hostIdentityFacts(host)
    const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId)
    // F1 memory evidence: sample the REAL Host process RSS while the bounded
    // transport carries a near-ceiling image frame and rejects an over-budget
    // one. The SDK materializes the complete JSON + Uint8Array before the
    // writer sees the frame, so the peak is the fact that matters.
    const rssPath = `/proc/${String(hostIdentity.hostPid)}/status`
    const sampleRss = () => {
      try {
        const match = /VmRSS:\s+(\d+) kB/u.exec(readFileSync(rssPath, 'utf8'))
        if (match !== null) rssSamples.push(Number(match[1]) * 1024)
      } catch {
        // The sample window may race the process; a missing sample is not a fact.
      }
    }
    sampleRss()
    rssTimer = setInterval(sampleRss, 20)
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
    const attached = await resume(acp, sessionId, 'PO-4C attach the TUI Session')
    assertStrict.equal(attached.error, undefined,
      `PO-4C: attaching the TUI Session must succeed (got ${JSON.stringify(attached.error)})`)
    // An attach success is a real non-array object; legal ACP v1 fields such as
    // `modes`/`configOptions` are protocol output, not a business-payload
    // allowlist. The following real prompt/turn facts are the actual proof.
    assert(attached.result !== undefined && typeof attached.result === 'object' && attached.result !== null
      && !Array.isArray(attached.result),
    `PO-4C: resume must return a real attach object (got ${JSON.stringify(attached.result)})`)

    // L6-C01: committed assistant text/image/text. The transient contract may
    // segment the text into ANY number of legal chunks; the wire facts are ONE
    // stable ACP message id, the concatenated delivered text equal to the
    // committed canonical text (no loss/duplication), and the never-streamed
    // durable IMAGE appended exactly once after the delivered text, in a
    // standard frame above the legacy 256 KiB cap.
    const mixed = await runPrompt(acp, sessionId, MARKERS.assistantMixed, 'PO-4C assistant text/image/text')
    assertEndTurn(mixed.settled, 'PO-4C assistant text/image/text')
    const mixedMessages = mixed.turnEvents.filter(event => event.type === 'assistant/message')
    assertStrict.equal(mixedMessages.length, 1, 'PO-4C: the mixed turn commits exactly one assistant message')
    const mixedCommitted = mixedMessages[0].data.message
    assertStrict.deepEqual(mixedCommitted.content.map(block => block.type), ['text', 'image', 'text'],
      'PO-4C: the durable assistant content is text/image/text')
    const mixedRef = imageRefOf(mixedCommitted.content[1])
    const mixedCanonicalText = committedText(mixedCommitted)
    assert(mixedCanonicalText.length > 0, 'PO-4C: the committed assistant text must be non-empty')
    const mixedUpdates = mixed.settled.updates
    for (const entry of mixedUpdates) {
      assertStrict.equal(entry.message.params.sessionId, sessionId,
        'PO-4C: every mixed-turn update belongs to the exact attached Session')
    }
    const mixedChunks = mixedUpdates
      .filter(entry => entry.message.params.update.sessionUpdate === 'agent_message_chunk')
    assertStrict.equal(mixedChunks.length, mixedUpdates.length,
      'PO-4C: a pure assistant turn delivers only standard message chunks')
    const mixedTextChunks = mixedChunks
      .filter(entry => entry.message.params.update.content.type === 'text')
    const mixedImageChunks = mixedChunks
      .filter(entry => entry.message.params.update.content.type === 'image')
    assertStrict.equal(mixedTextChunks.length + mixedImageChunks.length, mixedChunks.length,
      'PO-4C: the mixed turn delivers no unexpected content type')
    assert(mixedTextChunks.length > 0, 'PO-4C: the committed assistant text must be delivered')
    assertStrict.equal(mixedTextChunks
      .map(entry => entry.message.params.update.content.text).join(''), mixedCanonicalText,
    'PO-4C: the delivered text bytes must equal the committed canonical text (no loss or duplication)')
    assertStrict.equal(mixedImageChunks.length, 1,
      'PO-4C: the committed assistant image is delivered exactly once')
    const mixedImageEntry = mixedImageChunks[0]
    const mixedMessageIds = new Set(mixedChunks.map(entry => entry.message.params.update.messageId))
    assertStrict.equal(mixedMessageIds.size, 1,
      `PO-4C: one attempt uses ONE stable ACP message id (got ${JSON.stringify([...mixedMessageIds])})`)
    assertStrict.equal(mixedImageEntry.message.params.update.messageId,
      mixedTextChunks[0].message.params.update.messageId,
    'PO-4C: the durable image belongs to the SAME ACP message as the delivered text')
    assert(mixedChunks.at(-1) === mixedImageEntry,
      'PO-4C: an append-only join appends the durable image after the delivered text chunks')
    const mixedImage = assertImageContent(mixedImageEntry.message.params.update.content, mixedRef, 'PO-4C assistant image')
    const mixedFrameBytes = mixedImageEntry.rawBytes
    assert(mixedFrameBytes > LEGACY_FRAME_BYTES,
      `PO-4C: the delivered image frame must exceed the legacy 256 KiB cap (got ${String(mixedFrameBytes)})`)
    const mixedStored = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-image-stored' && event.name === 'mixed.png' && event.pid === hostIdentity.hostPid,
      'PO-4C official Store mixed image proof')
    assert(mixedStored.attachmentId === mixedRef.attachmentId && mixedStored.bytes === mixedImage.length
      && mixedStored.sha256 === hash(mixedImage) && mixedStored.mediaType === mixedRef.mediaType,
    'PO-4C: the wire bytes/digest/MIME must equal the Host Store save + re-read proof')
    // F1 capacity positive: the Host ran an independent legal configuration
    // (maxImageBytes > maxMessageImageBytes), the official Store kept a stored
    // image near the per-object ceiling, and the complete frame arrived.
    const effectiveLimits = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-image-limits' && event.pid === hostIdentity.hostPid,
      'PO-4C effective official attachment limits')
    assert(effectiveLimits.maxImageBytes === CAPACITY_LIMITS.maxImageBytes
      && effectiveLimits.maxImagesPerMessage === CAPACITY_LIMITS.maxImagesPerMessage
      && effectiveLimits.maxMessageImageBytes === CAPACITY_LIMITS.maxMessageImageBytes,
    `PO-4C: the Host must run the requested independent attachment limits (got ${JSON.stringify(effectiveLimits)})`)
    const encodedPerImage = 4 * Math.ceil(effectiveLimits.maxImageBytes / 3)
    const derivedBudget = effectiveLimits.maxImagesPerMessage * encodedPerImage
      + effectiveLimits.maxImagesPerMessage * 65_536 + 4_096 + 1024 * 1024
    assert(mixedRef.bytes > CAPACITY_LIMITS.maxMessageImageBytes,
      'PO-4C: the delivered stored image must exceed the prompt-batch limit (the F1 gap)')
    assert(mixedFrameBytes <= Math.max(LEGACY_FRAME_BYTES, derivedBudget),
      `PO-4C: the delivered frame must fit the amended allowance (frame ${String(mixedFrameBytes)}, budget ${String(derivedBudget)})`)

    // L6-C03: ONE large tool success turn. The durable call/result are the only
    // authority: one start update, one ordered result update carrying the
    // committed text/image/text (verified Store bytes), and the final assistant
    // answer chunk. The tool image is a DISTINCT real Store object, so the later
    // two-image overflow negative can correlate its own `toolRef`.
    const tool = await runPrompt(acp, sessionId, MARKERS.toolContent, 'PO-4C tool content')
    assertEndTurn(tool.settled, 'PO-4C tool content')
    const toolCallEvent = tool.turnEvents.find(event => event.type === 'tool/call')
    const toolResultEvent = tool.turnEvents.find(event => event.type === 'tool/result')
    assert(toolCallEvent !== undefined && toolResultEvent !== undefined, 'PO-4C: the tool turn commits one call and one result')
    const toolCallId = toolCallEvent.data.callId
    const toolResult = toolResultEvent.data.message
    assertStrict.equal(toolResult.isError, false, 'PO-4C: the retained tool turn is a real success')
    assertStrict.deepEqual(toolResult.content.map(block => block.type), ['text', 'image', 'text'],
      'PO-4C: the durable tool result content is text/image/text')
    const toolRef = imageRefOf(toolResult.content[1])
    assert(toolRef.attachmentId !== mixedRef.attachmentId,
      'PO-4C: the tool image must be an independent real Store object')
    const toolUpdates = tool.settled.updates
    for (const entry of toolUpdates) {
      assertStrict.equal(entry.message.params.sessionId, sessionId,
        'PO-4C: every tool-turn update belongs to the exact attached Session')
    }
    const toolStarts = toolUpdates.filter(entry => entry.message.params.update.sessionUpdate === 'tool_call')
    const toolResults = toolUpdates.filter(entry => entry.message.params.update.sessionUpdate === 'tool_call_update')
    const toolAnswerChunks = toolUpdates
      .filter(entry => entry.message.params.update.sessionUpdate === 'agent_message_chunk')
    assertStrict.equal(toolStarts.length, 1, 'PO-4C: one durable tool/call produces exactly ONE start update')
    assertStrict.equal(toolResults.length, 1, 'PO-4C: one durable tool/result produces exactly ONE result update')
    assertStrict.equal(toolAnswerChunks.length, 1, 'PO-4C: the streamed tool answer is never re-sent')
    assert(toolUpdates.indexOf(toolStarts[0]) < toolUpdates.indexOf(toolResults[0]),
      'PO-4C: the tool start precedes its result')
    assert(toolUpdates.indexOf(toolResults[0]) < toolUpdates.indexOf(toolAnswerChunks[0]),
      'PO-4C: the final assistant answer follows the completed tool result')
    const startUpdate = toolStarts[0].message.params.update
    assertStrict.equal(startUpdate.toolCallId, toolCallId)
    assertStrict.equal(startUpdate.title, toolCallEvent.data.name,
      'PO-4C: the start update carries the committed tool name')
    assertStrict.equal(startUpdate.kind, 'other')
    assertStrict.equal(startUpdate.status, 'in_progress')
    const resultUpdate = toolResults[0].message.params.update
    assertStrict.equal(resultUpdate.toolCallId, toolCallId)
    assertStrict.equal(resultUpdate.status, 'completed',
      'PO-4C: the result status comes from the official committed success, never a fabricated terminal')
    assertStrict.equal(resultUpdate.content.length, toolResult.content.length,
      'PO-4C: one tool_call_update carries the whole ordered committed content')
    for (const [index, committed] of toolResult.content.entries()) {
      const delivered = resultUpdate.content[index].content
      assertStrict.equal(delivered.type, committed.type,
        `PO-4C: the delivered tool content block ${String(index)} keeps its committed type`)
      if (committed.type === 'text') {
        assertStrict.equal(delivered.text, committed.text,
          `PO-4C: the delivered tool text block ${String(index)} equals its committed bytes`)
      }
    }
    const toolImage = assertImageContent(resultUpdate.content[1].content, toolRef, 'PO-4C tool image')
    const toolResultFrameBytes = toolResults[0].rawBytes
    assert(toolResultFrameBytes > LEGACY_FRAME_BYTES,
      `PO-4C: the large tool result frame must exceed the legacy 256 KiB cap (got ${String(toolResultFrameBytes)})`)
    assert(toolResultFrameBytes <= Math.max(LEGACY_FRAME_BYTES, derivedBudget),
      `PO-4C: the large tool result frame must fit the amended allowance (frame ${String(toolResultFrameBytes)}, budget ${String(derivedBudget)})`)
    assert(toolRef.bytes > CAPACITY_LIMITS.maxMessageImageBytes,
      'PO-4C: the tool image must carry a real near-ceiling stored object')
    const finalToolMessage = tool.turnEvents.filter(event => event.type === 'assistant/message').at(-1)?.data.message
    const toolAnswer = committedText(finalToolMessage)
    assert(toolAnswer.length > 0, 'PO-4C: the committed tool answer must be non-empty')
    assertStrict.equal(toolAnswerChunks[0].message.params.update.content.text, toolAnswer,
      'PO-4C: the delivered tool answer bytes equal the committed canonical answer')
    assertStrict.equal(typeof toolAnswerChunks[0].message.params.update.messageId, 'string')
    const toolStored = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'po4c-image-stored' && event.name === 'tool.png' && event.pid === hostIdentity.hostPid,
      'PO-4C official Store tool image proof')
    assert(toolStored.attachmentId === toolRef.attachmentId && toolStored.bytes === toolImage.length
      && toolStored.sha256 === hash(toolImage) && toolStored.mediaType === toolRef.mediaType,
    'PO-4C: the tool image wire bytes/digest/MIME equal the verified stored object')

    // Ordinary image-only / failed-tool / missing-object content semantics are
    // owned by the independent official SDK content case, which runs against
    // the same candidate. This case keeps only the transport-capacity scenes it
    // alone can prove (near-ceiling frames, slow reader, late read, overflow).

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
      // Only the TUI turn's OWN output would be a violation; the shared
      // Session's read-only projections are legitimate on this connection.
      if (!READ_ONLY_PROJECTION_KINDS.has(entry.message?.params?.update?.sessionUpdate)) strayTui.push(entry)
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
    const closeRecordIndex = host.records.length
    acp.close()
    // The Host's own listener teardown record for the destroyed connection is
    // the only authority that the close was PROCESSED (the SDK client close is
    // not enough). No other ACP connection is closing here, so the first new
    // teardown record belongs to this close.
    const closeRecord = await waitForHostRecordAfter(closeRecordIndex,
      record => record.m4a0 === 'diag' && record.message === 'local-acp.connection.close',
      'PO-4C Host-processed teardown of the destroyed ACP connection')
    // Session correlation: the destroyed connection's View still owns the
    // Session claim because its flight is held on the Store read.
    const claimProbe = await openConnection(scopeDir, 'PO-4C claim probe after the destroyed close')
    const claimProbeResume = await resume(claimProbe, sessionId, 'PO-4C claim probe after the destroyed close')
    claimProbe.close()
    assert(claimProbeResume.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
      `PO-4C: the destroyed connection must still hold the Session claim until its flight settles (got ${JSON.stringify(claimProbeResume)})`)
    // Only AFTER those Host facts is the held Store read released.
    const releasedAfterHostClose = closeRecord.connections >= 1
      && claimProbeResume.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED'
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

    // L6-C08 (F1 negative): the bounded allowance is finite. ONE committed tool
    // result carrying TWO independently stored images exceeds the count-1
    // allowance; the frame fails closed before any byte, only that connection
    // closes, and the Host/sibling/TUI keep working.
    const capacity = await openConnection(scopeDir, 'PO-4C capacity-negative connection')
    const capacityNew = ++caseId
    capacity.send({ jsonrpc: '2.0', id: capacityNew, method: 'session/new', params: { cwd: hostCwd, mcpServers: [] } })
    const capacitySession = (await capacity.next(message => message.id === capacityNew)).message.result?.sessionId
    assert(typeof capacitySession === 'string' && capacitySession !== sessionId,
      'PO-4C: the capacity-negative connection owns its own Host Session')
    const capacityRecordIndex = host.records.length
    const capacityPromptId = ++caseId
    capacity.send({ jsonrpc: '2.0', id: capacityPromptId, method: 'session/prompt',
      params: { sessionId: capacitySession, prompt: [{ type: 'text', text: MARKERS.toolTwoImages }] } })
    const overflowRecord = await waitForHostRecordAfter(capacityRecordIndex,
      record => record.m4a0 === 'diag' && record.message === 'local-acp.error'
        && record.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
      'PO-4C over-budget frame classification')
    await withDeadline(capacity.closed, 30_000, 'PO-4C over-budget connection close')
    // The tool-start update was already handed to the transport BEFORE the
    // oversized result frame existed; delivered notifications cannot be
    // retracted. What must NEVER appear is any image content from the
    // over-budget frame or a fabricated StopReason.
    const capacityUpdates = capacity.entries
      .filter(entry => entry.message?.method === 'session/update')
      .map(entry => entry.message.params?.update)
    const capacityResponses = capacity.entries.filter(entry => entry.message?.id === capacityPromptId)
    assert(capacityResponses.length === 0,
      `PO-4C: an over-budget frame never fabricates a StopReason (got ${String(capacityResponses.length)})`)
    // The capacity connection owns its own new Session, whose first prompt also
    // projects that Session's durable title; what must NEVER appear is RESULT
    // content or an image from the over-budget frame.
    const capacityDeliveredNoResultContent = capacityUpdates.every(update => update?.sessionUpdate === 'tool_call'
      || READ_ONLY_PROJECTION_KINDS.has(update?.sessionUpdate))
    assert(capacityDeliveredNoResultContent,
      `PO-4C: an over-budget frame delivers no result content (got ${JSON.stringify(capacityUpdates.map(update => update?.sessionUpdate))})`)
    assert(!JSON.stringify(capacity.entries).includes('"type":"image"'),
      'PO-4C: an over-budget frame never delivers any image content')
    const afterOverflow = await runPrompt(sibling, siblingSession, MARKERS.health,
      'PO-4C sibling ACP prompt after the over-budget frame')
    assertEndTurn(afterOverflow.settled, 'PO-4C sibling ACP prompt after the over-budget frame')
    const tuiAfterOverflow = (tui.records.filter(record => record.m4b2s === 'surface-status').at(-1))?.openSessionId
    assert(tuiAfterOverflow === sessionId,
      'PO-4C: the real TUI keeps its Session after the over-budget frame')

    // F1 memory evidence: the SDK materializes the complete frame before the
    // writer sees it, so the REAL Host RSS peak is part of the verdict.
    clearInterval(rssTimer)
    sampleRss()
    const rssBaselineBytes = rssSamples[0]
    const rssPeakBytes = rssSamples.length === 0 ? undefined : Math.max(...rssSamples)
    assert(Number.isInteger(rssBaselineBytes) && Number.isInteger(rssPeakBytes),
      'PO-4C: the Host RSS samples must be real integers')

    const identityAfter = await scene.hostIdentityFacts(host)
    assert(identityAfter.hostPid === hostIdentity.hostPid && identityAfter.instanceId === hostIdentity.instanceId,
      'PO-4C: no Host process/instance was replaced or restarted')
    // The two NECESSARY Store objects are associated by their real ref/name,
    // digest, bytes and writer Host identity. A global "exactly two probes"
    // count is not the contract: unrelated legal observations are allowed.
    const imageRefs = {
      mixed: {
        name: mixedStored.name,
        attachmentId: mixedStored.attachmentId,
        sha256: mixedStored.sha256,
        bytes: mixedStored.bytes,
        mediaType: mixedStored.mediaType,
        writerPid: mixedStored.pid,
      },
      tool: {
        name: toolStored.name,
        attachmentId: toolStored.attachmentId,
        sha256: toolStored.sha256,
        bytes: toolStored.bytes,
        mediaType: toolStored.mediaType,
        writerPid: toolStored.pid,
      },
    }
    assert(imageRefs.mixed.attachmentId !== imageRefs.tool.attachmentId,
      'PO-4C: the mixed/tool image refs must stay two distinct real objects')
    assert(imageRefs.mixed.writerPid === hostIdentity.hostPid && imageRefs.tool.writerPid === hostIdentity.hostPid,
      'PO-4C: both Store writes must belong to the exact running Host process')
    assert(imageRefs.mixed.sha256 === hash(mixedImage) && imageRefs.tool.sha256 === hash(toolImage),
      'PO-4C: the associated Store digests must equal the decoded wire bytes')

    const evidence = {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      candidateSha256: context.candidateSha256,
      dshVersion: context.targetDshVersion,
      acpSdkVersion: installedSdkVersion(),
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
        blockSha256: [hash(mixedCommitted.content[0].text), hash(mixedCommitted.content[2].text)],
      },
      tool: {
        turn: tool.turn,
        callId: toolCallId,
        resultAttachmentId: toolRef.attachmentId,
        resultStoredBytes: toolRef.bytes,
        resultMimeType: toolRef.mediaType,
        resultFrameBytes: toolResultFrameBytes,
      },
      imageRefs,
      slowPeer: {
        backpressureCode: backpressure.code,
        victimSessionId: victimSession,
        siblingSessionId: siblingSession,
        tuiTurn,
        reattachAttempts,
        lateRead: {
          attachmentId: mixedRef.attachmentId,
          hostCloseConnections: closeRecord.connections,
          claimHeldBeforeRelease: true,
          releasedAfterDisconnect: releasedAfterHostClose,
          lateAttempts,
        },
      },
      capacity: {
        maxImageBytes: effectiveLimits.maxImageBytes,
        maxImagesPerMessage: effectiveLimits.maxImagesPerMessage,
        maxMessageImageBytes: effectiveLimits.maxMessageImageBytes,
        storedBytes: mixedRef.bytes,
        base64Bytes: 4 * Math.ceil(mixedRef.bytes / 3),
        deliveredFrameBytes: mixedFrameBytes,
        derivedBudget,
        positive: true,
      },
      boundedTransport: {
        overBudgetCode: overflowRecord.code,
        overBudgetImageCount: 2,
        overBudgetStoredBytes: [mixedRef.bytes, toolRef.bytes],
        noContentOrStopReason: capacityDeliveredNoResultContent
          && capacityResponses.length === 0,
        siblingAfterOverflow: true,
        tuiAlive: tuiAfterOverflow === sessionId,
      },
      memory: {
        hostPid: hostIdentity.hostPid,
        rssBaselineBytes,
        rssPeakBytes,
        rssDeltaBytes: rssPeakBytes - rssBaselineBytes,
        storedBytes: mixedRef.bytes,
        base64Bytes: 4 * Math.ceil(mixedRef.bytes / 3),
        sdkFrameBytes: mixedFrameBytes,
        writerBacklogBoundBytes: WRITER_BACKLOG_BOUND_BYTES,
        sdkMaterializesWholeFrame: true,
      },
    }
    trace('acp-po4c/evidence', evidence)
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      assistantTextImageTextOrdered: true,
      largeToolImageCapacity: true,
      largeImageFrameAboveLegacyCap: true,
      capacityPositive: true,
      capacityNegative: true,
      slowPeerIsolated: true,
      siblingAcpAndTuiUnaffected: true,
      reattachAfterFailureClean: true,
      lateReadAfterCloseInert: true,
      noForeignTurnProjected: true,
      hostIdentityKept: true,
      readImageVerified: true,
      memoryMeasured: true,
      l6EvidenceRecorded: true,
      evidence,
    }
  } finally {
    if (rssTimer !== undefined) clearInterval(rssTimer)
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
