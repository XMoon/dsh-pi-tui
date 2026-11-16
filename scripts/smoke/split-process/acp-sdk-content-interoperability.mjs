/**
 * Real Split Host/TUI qualification through the official public ACP SDK client.
 * Only the offline model/tool and generated PNGs are stand-ins; Session events,
 * image storage, the socket, and both process lifecycles are real.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import * as acp from '@agentclientprotocol/sdk'
import sharp from 'sharp'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

const SDK_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@agentclientprotocol/sdk')), 'utf8')).version
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function requireFact(condition, label) {
  if (!condition) throw new SplitSmokeAssertionError(`independent ACP SDK client: ${label}`)
}

async function deadline(promise, label, timeoutMs = 120_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new SplitSmokeAssertionError(`independent ACP SDK client: ${label} timed out`)), timeoutMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}

/** One connection, with all encoding and typed dispatch owned by the SDK. */
async function openSdkClient(scopeDir) {
  const fd = openSync(scopeDir, 'r')
  let socket
  try {
    socket = connect(`/proc/self/fd/${String(fd)}/acp.sock`)
    await deadline(new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    }), 'real Unix socket connect')
  } catch (error) {
    socket?.destroy()
    throw error
  } finally {
    closeSync(fd)
  }
  const socketClosed = new Promise(resolve => socket.once('close', resolve))
  const updates = []
  const incomingMethods = []
  const stream = acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket))
  // Tap only the public SDK's DECODED method names. This detects notifications
  // discarded by typed validation and unexpected methods without another parser.
  const observedStream = {
    ...stream,
    readable: stream.readable.pipeThrough(new TransformStream({
      transform(message, controller) {
        if (typeof message.method === 'string') incomingMethods.push(message.method)
        controller.enqueue(message)
      },
    })),
  }
  const app = acp.client({ name: 'split-qualification-sdk-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const connection = app.connect(observedStream)
  let accountedUpdates = 0
  return {
    updates,
    connection,
    async request(method, params) {
      return await deadline(connection.agent.request(method, params), `SDK ${method}`)
    },
    assertWindow() {
      requireFact(updates.length === accountedUpdates, 'no notification escaped its settled prompt window')
    },
    finishWindow(from, atSettlement, sessionId) {
      requireFact(updates.length === atSettlement, 'all typed notifications precede request settlement')
      requireFact(incomingMethods.length === updates.length
        && incomingMethods.every(method => method === acp.methods.client.session.update),
      'every received notification passes official typed dispatch; no artifact or file method')
      const window = updates.slice(from, atSettlement)
      requireFact(window.every(params => params.sessionId === sessionId), 'notifications belong to the TUI-observed Session')
      accountedUpdates = atSettlement
      return window
    },
    async dispose() {
      connection.close()
      socket.destroy()
      await deadline(Promise.all([connection.closed, socketClosed]), 'SDK connection and socket close', 15_000)
    },
  }
}

function authoredText(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * A private Host workspace per scene. The lane work dir is SHARED by every
 * selected case in one installation, and the existing PO-4 Markdown probe
 * leaves a `000` file under `.po4b` there; this case must own its own directory
 * instead of reusing or deleting a sibling case's workspace.
 */
export function sceneWorkspace(context, kind) {
  const dir = join(context.workDir, `sdk-${kind}-workspace`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return realpathSync(dir)
}

/**
 * Throw the REAL primary failure after every owned teardown was attempted.
 * Wrapping it in an AggregateError would replace the assertion/wait class,
 * message and stack with a generic "scene failed" in the default report.
 */
export function throwSceneFailure(kind, failure, cleanupErrors) {
  if (failure !== undefined) {
    if (cleanupErrors.length > 0) failure.sceneCleanupFailures = cleanupErrors
    throw failure
  }
  if (cleanupErrors.length > 0) {
    const [primary, ...rest] = cleanupErrors
    if (rest.length > 0) primary.sceneCleanupFailures = rest
    throw primary
  }
}

/** The committed user message, not an inbox splice alone, proves dispatch. */
async function prompt(session, promptBlocks, matches, label, errorCode) {
  const { context, sdk, sessionId } = session
  sdk.assertWindow()
  const start = (hostSessionEvents(context.dshHome, sessionId) ?? []).length
  const from = sdk.updates.length
  let response
  let rejection
  try {
    response = await sdk.request(acp.methods.agent.session.prompt, { sessionId, prompt: promptBlocks })
  } catch (error) {
    if (errorCode === undefined) throw error
    rejection = error
  }
  const atSettlement = sdk.updates.length
  if (errorCode === undefined) assert.deepEqual(response, { stopReason: 'end_turn' }, `${label}: standard terminal response`)
  else {
    requireFact(rejection instanceof acp.RequestError, `${label}: official SDK RequestError from Host`)
    assert.equal(rejection.data?.code, errorCode, `${label}: stable Host failure code`)
  }
  // The Host's live terminal is not the persisted log: the official JSONL
  // storage buffers committed events (write-behind batch), so a synchronous
  // disk read at SDK settlement is NOT a Host clock. Correlate the durable
  // facts below with bounded eventual observation instead; the live
  // settlement ordering itself is owned by the production ACP View and the
  // existing raw-wire PO-3A/PO-4C cases.
  const inserted = await waitForHostSessionEventAfter(context.dshHome, sessionId, start,
    event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source?.kind === 'user' && matches(message)),
    `${label} exact authored Inbox insertion`)
  const matching = inserted.data.inserted.filter(message => message.source?.kind === 'user' && matches(message))
  requireFact(matching.length === 1, `${label}: exactly one matching authored message`)
  const admitted = matching[0]
  requireFact(typeof admitted.source.rpcId === 'string' && admitted.source.rpcId.length > 0, `${label}: official source.rpcId`)
  const durable = await waitForHostSessionEventAfter(context.dshHome, sessionId, start,
    event => event.type === 'user/message' && event.data.source?.rpcId === admitted.source.rpcId,
    `${label} durable user/message`)
  assert.equal(durable.data.id, admitted.id, `${label}: the inserted message was really committed`)
  requireFact(matches(durable.data), `${label}: the committed content matches the submitted text or image digest`)
  const events = hostSessionEvents(context.dshHome, sessionId)
  const userIndex = events.findIndex((event, index) => index >= start && event.type === 'user/message'
    && event.data.id === admitted.id && event.data.source?.rpcId === admitted.source.rpcId)
  let turnStart = userIndex
  while (turnStart >= start && events[turnStart].type !== 'turn/start') turnStart -= 1
  requireFact(turnStart >= start, `${label}: a new real turn/start claimed the exact message`)
  const turn = events[turnStart].data.turn
  requireFact(Number.isInteger(turn), `${label}: integer claimed turn`)
  const terminal = await waitForHostSessionEventAfter(context.dshHome, sessionId, userIndex,
    event => event.type === 'turn/end' && event.data.turn === turn, `${label} exact turn/end`)
  assert.equal(terminal.data.reason.kind, 'completed', `${label}: official Host terminal reason`)
  const complete = hostSessionEvents(context.dshHome, sessionId)
  const endIndex = complete.findIndex((event, index) => index > userIndex && event.type === 'turn/end' && event.data.turn === turn)
  const interval = complete.slice(turnStart, endIndex + 1)
  const authored = interval.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
  requireFact(authored.length === 1 && authored[0].data.id === admitted.id, `${label}: no foreign authored user claimed by this turn`)
  requireFact(interval.filter(event => event.type === 'turn/start').length === 1, `${label}: no different turn in the owned interval`)
  const turnEvents = interval.filter(event => event.data?.turn === turn)
  const updates = sdk.finishWindow(from, atSettlement, sessionId)
  context.trace('acp-sdk/prompt', {
    label, sessionId, hostPid: session.identity.hostPid, hostInstanceId: session.identity.instanceId,
    requestId: admitted.source.rpcId, userMessageId: admitted.id, turn,
    updateKinds: updates.map(params => params.update.sessionUpdate), terminal: terminal.data.reason.kind,
    errorCode: rejection?.data?.code,
  })
  return { turn, user: durable.data, turnEvents, updates, rejection }
}

function assistantMessage(flight) {
  const messages = flight.turnEvents.filter(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type !== 'tool-call'))
  requireFact(messages.length === 1, 'exactly one visible committed assistant message in the owned turn')
  return messages[0].data.message
}

/** Compare complete typed text envelopes without printing private text on failure. */
function assertTextChunks(updates, message, sessionId) {
  requireFact(message.content.every(block => block.type === 'text'), 'committed assistant text blocks')
  const expected = message.content.map(content => ({
    sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: message.id, content },
  }))
  requireFact(isDeepStrictEqual(updates, expected), 'complete ordered typed text chunks equal committed text bytes and message id')
}

function imageRef(block) {
  requireFact(block.type === 'image' && /^sha256:[0-9a-f]{64}$/u.test(block.attachment?.attachmentId ?? ''), 'official durable image ref')
  return block.attachment
}

function assertImage(content, ref, probe) {
  requireFact(content.type === 'image' && typeof content.data === 'string', 'typed SDK image content')
  const bytes = Buffer.from(content.data, 'base64')
  requireFact(content.data === bytes.toString('base64'), 'canonical complete image encoding')
  requireFact(content.mimeType === 'image/png' && content.mimeType === ref.mediaType, 'verified stored MIME')
  requireFact(bytes.length === ref.bytes && hash(bytes) === ref.attachmentId.slice(7), 'complete SDK bytes match durable ref size and digest')
  requireFact(probe.attachmentId === ref.attachmentId && probe.bytes === bytes.length
    && probe.mediaType === content.mimeType && probe.sha256 === hash(bytes), 'SDK image equals official Store save/read proof')
  requireFact(isDeepStrictEqual(Object.keys(content).sort(), ['data', 'mimeType', 'type']), 'only standard image fields')
  return bytes
}

/** Each invocation owns one real Host, TUI, control peer and SDK connection. */
async function runScene(context, kind, env, operation) {
  const input = kind === 'input'
  const scene = createC1Scene(context, { imageProbe: true, ...(input ? { markdownProbe: true } : {}) })
  const workRoot = scene.c1WorkRoot(`acp-sdk-${kind}`)
  const workspace = sceneWorkspace(context, kind)
  let peer
  let tui
  let sdk
  let ready
  let result
  let failure
  try {
    const started = await scene.startC1Host(input ? 'acp-po4a' : 'acp-po4c', `SDK ${kind}`, env, workRoot)
    ready = started.ready
    const host = started.host
    const identity = await scene.hostIdentityFacts(host)
    requireFact(identity.hostPid === host.child.pid && identity.hostPid === ready.localHost.hostPid
      && identity.instanceId === ready.localHost.instanceId, 'real Host PID and authenticated instance identity')
    peer = new context.EntryProcess('peer', context.entries.client, {
      ...context.base, env: { ...context.base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    await peer.waitFor(record => record.m4a0 === 'ready', `SDK ${kind} control peer ready`, 180_000)
    const requestId = `sdk-enable-${kind}-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId, acpEnabled: true })
    const enabled = await peer.waitFor(record => record.op === 'acp-access' && record.requestId === requestId,
      `SDK ${kind} listener enabled`)
    requireFact(enabled.ok === true && enabled.status.state === 'enabled', 'real control peer enables default-OFF ACP')
    tui = (await scene.startC1Client(`SDK ${kind} TUI`, {}, { cwd: workspace })).client
    tui.send('/new\r')
    const surface = await waitForSurfaceStatus(tui, record => record.sessionOpen === true
      && typeof record.openSessionId === 'string' && record.surfaceMounted === true && record.transport === 'connected',
    `SDK ${kind} TUI Session open`)
    const sessionId = surface.openSessionId
    sdk = await openSdkClient(join(context.dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId))
    const initialized = await sdk.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(initialized.protocolVersion, 1)
    assert.equal(initialized.agentInfo.version, context.installation.manifest.version)
    const capabilities = initialized.agentCapabilities
    requireFact(capabilities.sessionCapabilities?.resume !== null
      && typeof capabilities.sessionCapabilities?.resume === 'object'
      && capabilities.sessionCapabilities?.close !== null
      && typeof capabilities.sessionCapabilities?.close === 'object',
    'the connection advertises its shared Session View')
    assert.equal(capabilities.promptCapabilities.image, input)
    assert.equal(capabilities.promptCapabilities.audio, false)
    assert.equal(capabilities.promptCapabilities.embeddedContext, false)
    requireFact(capabilities.loadSession !== true, 'session/load remains unadvertised')
    assert.deepEqual(await sdk.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace }), {})
    const session = { context, scene, sdk, sessionId, workRoot, identity, workspace }
    result = await operation(session)
    sdk.assertWindow()
    assert.deepEqual(await sdk.request(acp.methods.agent.session.close, { sessionId }), {})
    const afterCloseStart = (hostSessionEvents(context.dshHome, sessionId) ?? []).length
    const afterCloseUpdates = sdk.updates.length
    const tuiMarker = `sdk-view-closed-${kind}`
    tui.send(`${tuiMarker}\r`)
    const tuiUser = await waitForHostSessionEventAfter(context.dshHome, sessionId, afterCloseStart,
      event => event.type === 'user/message' && event.data.source?.kind === 'user' && authoredText(event.data) === tuiMarker,
      `SDK ${kind} close leaves the real TUI able to submit`)
    const tuiEvents = hostSessionEvents(context.dshHome, sessionId)
    const tuiIndex = tuiEvents.findIndex((event, index) => index >= afterCloseStart && event.type === 'user/message' && event.data.id === tuiUser.data.id)
    const tuiTurn = tuiEvents.slice(afterCloseStart, tuiIndex).findLast(event => event.type === 'turn/start')?.data.turn
    requireFact(Number.isInteger(tuiTurn), 'the post-close TUI message belongs to a real turn')
    await waitForHostSessionEventAfter(context.dshHome, sessionId, tuiIndex,
      event => event.type === 'turn/end' && event.data.turn === tuiTurn && event.data.reason.kind === 'completed',
      `SDK ${kind} exact TUI turn completes after View close`)
    requireFact(sdk.finishWindow(afterCloseUpdates, sdk.updates.length, sessionId).length === 0, 'closed View receives no TUI turn output')
    const retained = await waitForSurfaceStatus(tui, record => record.openSessionId === sessionId
      && record.sessionOpen === true && record.surfaceMounted === true && record.transport === 'connected',
    `SDK ${kind} close retains real TUI Session`)
    assert.equal(retained.openSessionId, sessionId)
    await scene.assertHostIdentityKept(host, identity, `SDK ${kind} close retains Host`)
    await sdk.dispose()
    sdk = undefined
    result = { ...result, hostPid: identity.hostPid, hostInstanceId: identity.instanceId, sessionId, hostIdentityKept: true, tuiAfterCloseTurn: tuiTurn }
  } catch (error) {
    failure = error
  } finally {
    // Attempt every owned teardown, then rethrow the REAL primary failure.
    const cleanupErrors = []
    if (sdk !== undefined) { try { await sdk.dispose() } catch (error) { cleanupErrors.push(error) } }
    if (peer !== undefined && !peer.exited) { try { await peer.shutdown() } catch (error) { cleanupErrors.push(error) } }
    if (tui !== undefined && !tui.exited) { try { await scene.exitC1Client(tui, `SDK ${kind} TUI`) } catch (error) { cleanupErrors.push(error) } }
    try { await scene.dispose() } catch (error) { cleanupErrors.push(error) }
    if (ready !== undefined) { try { await scene.awaitSceneSeatFree() } catch (error) { cleanupErrors.push(error) } }
    throwSceneFailure(kind, failure, cleanupErrors)
  }
  context.trace(`acp-sdk/${kind}-disposed`, result)
  return result
}

async function inputScene(context) {
  const probeDir = join(context.workDir, 'sdk-input-probes')
  mkdirSync(probeDir, { mode: 0o700 })
  const small = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#20a040' } }).png().toBuffer()
  const large = await sharp(randomBytes(640 * 640 * 3), { raw: { width: 640, height: 640, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
  requireFact(large.length > 1024 * 1024 && large.length < 2 * 1024 * 1024, 'native SDK input PNG exceeds 1 MiB within the Store limit')
  return await runScene(context, 'input', {
    C1_PO4A_IMAGE_CAPABLE: '1', C1_PO4A_IMAGE_PROBE_DIR: probeDir,
    C1_PO4B_EXPECTED_WORKSPACE: sceneWorkspace(context, 'input'), DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
  }, async session => {
    const { sdk, sessionId, workspace, workRoot, identity } = session
    const resource = { type: 'resource_link', name: 'external "note"', uri: 'file:///host/not-read.png' }
    const expected = 'before<\n[resource_link name=' + JSON.stringify(resource.name) + ' uri=' + JSON.stringify(resource.uri) + ']\n>after'
    const link = await prompt(session, [{ type: 'text', text: 'before<' }, resource, { type: 'text', text: '>after' }],
      message => authoredText(message) === expected, 'resource link')
    requireFact(isDeepStrictEqual(link.user.content, [{ type: 'text', text: expected }]), 'resource link is exactly one escaped durable text block')
    assertTextChunks(link.updates, assistantMessage(link), sessionId)

    const images = []
    for (const [label, bytes] of [['small input', small], ['large native SDK input', large]]) {
      const digest = hash(bytes)
      const flight = await prompt(session, [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }],
        message => message.content.length === 1 && message.content[0].type === 'image'
          && message.content[0].attachment?.attachmentId === `sha256:${digest}`, label)
      const ref = imageRef(flight.user.content[0])
      requireFact(ref.bytes === bytes.length && ref.mediaType === 'image/png', `${label}: stored size and media`)
      const probes = readFileSync(join(probeDir, 'image-probe.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      requireFact(probes.some(probe => probe.success === true && probe.sessionId === sessionId
        && probe.attachmentId === ref.attachmentId && probe.sha256 === digest && probe.bytes === bytes.length && probe.mediaType === ref.mediaType),
      `${label}: real Host readImage verified the submitted digest`)
      requireFact(!JSON.stringify(hostSessionEvents(context.dshHome, sessionId)).includes(bytes.toString('base64')), 'durable Session contains no inline Base64')
      assertTextChunks(flight.updates, assistantMessage(flight), sessionId)
      images.push({ turn: flight.turn, ref, digest })
    }

    const marker = 'po4b:markdown-host-files:v1'
    const markdown = await prompt(session, [{ type: 'text', text: marker }], message => authoredText(message) === marker, 'Markdown and Host locality')
    const message = assistantMessage(markdown)
    requireFact(message.content.length === 2 && message.content.every(block => block.type === 'text'), 'two committed Markdown text blocks')
    requireFact(message.content[0].text.includes('\r\n') && message.content[1].text.includes('```'), 'committed Markdown includes CRLF and fenced text')
    assertTextChunks(markdown.updates, message, sessionId)
    const fileProof = await waitForC1WorkEvent(workRoot, event => event.kind === 'po4b-host-file-proof'
      && event.sessionId === sessionId && event.pid === identity.hostPid, 'SDK real Host workspace file proof')
    requireFact(fileProof.workspaceMatched === true && fileProof.missing === 'ENOENT' && fileProof.unreadable === 'EACCES', 'Host workspace and actual OS permission classification')
    const report = readFileSync(join(workspace, '.po4b', 'report.md'))
    requireFact(hash(report) === fileProof.reportSha256, 'same-UID independent client reads the actual Host file digest')
    requireFact(!JSON.stringify(markdown.updates).includes(report.toString('utf8')), 'Markdown notifications contain no raw Host file body')
    const local = join(context.workDir, 'sdk-client-local')
    mkdirSync(local, { mode: 0o700 })
    assert.throws(() => readFileSync(join(local, '.po4b', 'report.md')), error => error.code === 'ENOENT')

    sdk.assertWindow()
    const negativeStart = (hostSessionEvents(context.dshHome, sessionId) ?? []).length
    const from = sdk.updates.length
    await assert.rejects(sdk.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: [{ type: 'image', mimeType: 'image/jpeg', data: small.toString('base64') }],
    }), error => {
      requireFact(error instanceof acp.RequestError, 'MIME mismatch returns an official SDK RequestError')
      requireFact(error.data?.code === 'LOCAL_ACP_PROMPT_HOST_REJECTED',
        `MIME mismatch reaches Host admission (ACP code ${String(error.data?.code)})`)
      // The official Session Controller maps AttachmentError into its RemoteError
      // taxonomy before the ACP View preserves the Host code on the wire.
      requireFact(error.data?.hostCode === 'session/attachment-invalid',
        `MIME mismatch preserves the Session Controller code (${String(error.data?.hostCode)})`)
      context.trace('acp-sdk/negative-admission', { sessionId, acpCode: error.data.code, hostCode: error.data.hostCode })
      return true
    })
    requireFact(sdk.finishWindow(from, sdk.updates.length, sessionId).length === 0, 'rejected admission emits no content')
    requireFact(hostSessionEvents(context.dshHome, sessionId).slice(negativeStart).every(event => event.type !== 'user/message'), 'Host rejection precedes every durable user/message')
    const healthMarker = `sdk-input-health-${hash(randomBytes(16))}`
    const healthy = await prompt(session, [{ type: 'text', text: healthMarker }], value => authoredText(value) === healthMarker, 'input healthy after rejection')
    assertTextChunks(healthy.updates, assistantMessage(healthy), sessionId)
    return {
      imageAttachmentId: images[0].ref.attachmentId, imageSha256: images[0].digest, largeImageBytes: large.length,
      resourceLinkTurn: link.turn, imageTurn: images[0].turn, largeImageTurn: images[1].turn,
      markdownTurn: markdown.turn, markdownMessageId: message.id, hostReportSha256: fileProof.reportSha256,
      missingPathErrno: fileProof.missing, unreadablePathErrno: fileProof.unreadable, negativeRejectedBeforeMessage: true,
    }
  })
}

async function outputScene(context) {
  const pngDir = join(context.workDir, 'sdk-output-images')
  mkdirSync(pngDir, { mode: 0o700 })
  chmodSync(pngDir, 0o700)
  for (const [name, dimension] of [['mixed', 700], ['tool', 120]]) {
    const bytes = await sharp(randomBytes(dimension * dimension * 3), { raw: { width: dimension, height: dimension, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
    if (name === 'mixed') requireFact(bytes.length > 1024 * 1024 && bytes.length < 2 * 1024 * 1024, 'output PNG within the existing Store limit')
    writeFileSync(join(pngDir, `${name}.png`), bytes, { mode: 0o600 })
  }
  return await runScene(context, 'output', { C1_PO4C_IMAGE_DIR: pngDir, DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8' }, async session => {
    const { sessionId, workRoot, identity } = session
    const run = (text, label, code) => prompt(session, [{ type: 'text', text }], value => authoredText(value) === text, label, code)
    const storeProof = async name => await waitForC1WorkEvent(workRoot, event => event.kind === 'po4c-image-stored'
      && event.name === name && event.pid === identity.hostPid, `SDK official Store ${name}`)
    const mixed = await run('po4c:assistant-mixed:v1', 'assistant mixed')
    const message = assistantMessage(mixed)
    requireFact(isDeepStrictEqual(message.content.map(block => block.type), ['text', 'image', 'text']), 'committed assistant text/image/text')
    const ref = imageRef(message.content[1])
    const proof = await storeProof('mixed.png')
    requireFact(mixed.updates.length === 3 && mixed.updates.every(params => params.update.sessionUpdate === 'agent_message_chunk'
      && params.update.messageId === message.id), 'three ordered chunks of the exact committed message')
    for (const index of [0, 2]) assertTextChunks([mixed.updates[index]], { id: message.id, content: [message.content[index]] }, sessionId)
    const mixedBytes = assertImage(mixed.updates[1].update.content, ref, proof)
    requireFact(Buffer.byteLength(mixed.updates[1].update.content.data) > 256 * 1024, 'typed image logical payload exceeds 256 KiB')

    const imageOnly = await run('po4c:assistant-image-only:v1', 'assistant image only with image input disabled')
    const onlyMessage = assistantMessage(imageOnly)
    requireFact(isDeepStrictEqual(onlyMessage.content.map(block => block.type), ['image']) && imageOnly.updates.length === 1,
      'one committed image-only assistant yields exactly one SDK notification')
    requireFact(imageOnly.updates[0].update.sessionUpdate === 'agent_message_chunk'
      && imageOnly.updates[0].update.messageId === onlyMessage.id, 'image-only committed message identity')
    assertImage(imageOnly.updates[0].update.content, imageRef(onlyMessage.content[0]), proof)

    const tool = await run('po4c:tool-content:v1', 'ordered tool result')
    const callEvents = tool.turnEvents.filter(event => event.type === 'tool/call')
    const results = tool.turnEvents.filter(event => event.type === 'tool/result')
    requireFact(callEvents.length === 1 && results.length === 1, 'one real tool call and result in the owned turn')
    const call = callEvents[0].data
    const result = results[0].data.message
    requireFact(result.isError === false && result.toolCallId === call.callId, 'real successful tool result attribution')
    requireFact(isDeepStrictEqual(result.content.map(block => block.type), ['text', 'image', 'text']), 'ordered committed tool content')
    requireFact(isDeepStrictEqual(tool.updates.map(params => params.update.sessionUpdate), ['tool_call', 'tool_call_update', 'agent_message_chunk']),
      'one tool start, one complete result and one final assistant chunk')
    const start = tool.updates[0].update
    requireFact(start.toolCallId === call.callId && start.title === call.name && start.kind === 'other'
      && start.status === 'in_progress', 'standard tool start from committed tool/call')
    const update = tool.updates[1].update
    requireFact(update.toolCallId === call.callId && update.status === 'completed' && update.content.length === 3, 'complete successful tool update')
    for (const index of [0, 2]) requireFact(isDeepStrictEqual(update.content[index], { type: 'content', content: result.content[index] }),
      'opaque tool text bytes remain complete and ordered')
    const toolRef = imageRef(result.content[1])
    requireFact(update.content[1].type === 'content', 'standard tool image content wrapper')
    assertImage(update.content[1].content, toolRef, await storeProof('tool.png'))
    assertTextChunks(tool.updates.slice(2), assistantMessage(tool), sessionId)

    const failed = await run('po4c:tool-failed:v1', 'real failed tool status')
    const failedCall = failed.turnEvents.filter(event => event.type === 'tool/call')
    const failedResults = failed.turnEvents.filter(event => event.type === 'tool/result')
    requireFact(failedCall.length === 1 && failedResults.length === 1, 'one real failed tool call/result')
    const failedResult = failedResults[0].data.message
    requireFact(failedResult.isError === true && failedResult.toolCallId === failedCall[0].data.callId, 'official isError and exact failed callId')
    requireFact(isDeepStrictEqual(failed.updates.map(params => params.update.sessionUpdate), ['tool_call', 'tool_call_update', 'agent_message_chunk']), 'failed tool update sequence')
    requireFact(failed.updates[0].update.toolCallId === failedResult.toolCallId && failed.updates[0].update.status === 'in_progress'
      && failed.updates[1].update.toolCallId === failedResult.toolCallId && failed.updates[1].update.status === 'failed', 'official failure becomes standard failed status')
    assertTextChunks(failed.updates.slice(2), assistantMessage(failed), sessionId)

    const missing = await run('po4c:missing-image:v1', 'missing verified Store object', 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED')
    const missingRef = imageRef(assistantMessage(missing).content[0])
    const missingProof = await waitForC1WorkEvent(workRoot, event => event.kind === 'po4c-missing-image-rejected'
      && event.attachmentId === missingRef.attachmentId && event.pid === identity.hostPid, 'SDK official missing object rejection')
    requireFact(missingProof.code === 'ATTACHMENT_NOT_FOUND' && missing.updates.length === 0, 'absent Store object sends no image or partial assistant event')
    const healthy = await run('po4c:health', 'healthy after missing Store object')
    assertTextChunks(healthy.updates, assistantMessage(healthy), sessionId)
    return {
      assistantTurn: mixed.turn, assistantMessageId: message.id, assistantAttachmentId: ref.attachmentId,
      assistantImageSha256: hash(mixedBytes), assistantImageBytes: mixedBytes.length, imageOnlyTurn: imageOnly.turn,
      toolTurn: tool.turn, toolCallId: call.callId, toolAttachmentId: toolRef.attachmentId, toolStatus: update.status,
      failedToolTurn: failed.turn, failedToolCallId: failedResult.toolCallId, failedStatus: failed.updates[1].update.status,
      missingObjectCode: missingProof.code, acpErrorCode: missing.rejection.data.code, healthyTurn: healthy.turn,
    }
  })
}

export async function runAcpSdkContentInteroperability(context) {
  requireFact(SDK_VERSION === '1.4.0' && acp.PROTOCOL_VERSION === 1, 'installed pinned official SDK and ACP v1')
  const input = await inputScene(context)
  // inputScene returns only AFTER SDK/TUI/Host teardown and kernel seat release.
  // Rewriting the existing fixture in this same profile is safe only then.
  const output = await outputScene(context)
  requireFact(input.hostInstanceId !== output.hostInstanceId && input.sessionId !== output.sessionId, 'two sequential distinct Host instances and Sessions')
  const result = {
    status: 'PASS', scope: 'REAL_SPLIT_PROCESS_L6', officialSdkClient: true,
    inputResourceLinkExact: true, inputImageStoredVerified: true, inputLargeImageViaSdk: true,
    markdownBlocksExact: true, workspaceLocalityProven: true, negativeAdmissionNoHostMessage: true,
    assistantBlocksOrdered: true, outputImageVerified: true, imageOnlyAccepted: true,
    toolResultOrdered: true, toolFailedStatusVerified: true, missingStoreObjectFailedClosed: true,
    healthyAfterFailure: true, tuiHostSurvivedClientClose: true,
    evidence: { candidateSha256: context.candidateSha256, sdkVersion: SDK_VERSION, protocolVersion: acp.PROTOCOL_VERSION, input, output },
  }
  context.trace('acp-sdk/evidence-final', result)
  return result
}
