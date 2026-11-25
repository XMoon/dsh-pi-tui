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
import { installedSdkVersion, pinnedSdkVersion } from '../../lib/split-smoke-sdk.mjs'
import { createC1Scene } from './c1-scene.mjs'

// The ONE SDK version fact: this repository's exact pin and the version the
// process really resolved (see scripts/lib/split-smoke-sdk.mjs).
const PINNED_SDK = pinnedSdkVersion()
const SDK_VERSION = installedSdkVersion()
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
    /**
     * The same settled window, limited to OBSERVED flight output: the
     * supplemental read-only projections of the shared Session are not part of
     * the prompt's attempt.
     */
    flightWindow(from, atSettlement, sessionId) {
      return this.finishWindow(from, atSettlement, sessionId)
        .filter(params => !READ_ONLY_PROJECTION_KINDS.has(params.update.sessionUpdate))
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

/**
 * G-ACP2-PR2 read-only projections of the SHARED Session ride the same
 * connection but are never part of a prompt's flight output. A flight window
 * filters them out EXPLICITLY; a "closed View receives nothing" window stays
 * raw so a projection after close would still fail.
 */
const READ_ONLY_PROJECTION_KINDS = new Set([
  'plan', 'plan_update', 'plan_removed', 'session_info_update', 'usage_update',
  'compaction_update', 'subagent_update', 'session_message', 'notice',
  'available_commands_update', 'config_option_update',
])

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
  const updates = sdk.flightWindow(from, atSettlement, sessionId)
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
function assertTextChunks(updates, message, sessionId, messageId = updates[0]?.update?.messageId) {
  requireFact(message.content.every(block => block.type === 'text'), 'committed assistant text blocks')
  // A streamed message is delivered under the attempt's own opaque ACP message
  // id (the durable message id is not a wire id), so the stable identity is
  // read from the delivered attempt and must hold for every chunk of it.
  requireFact(typeof messageId === 'string' && messageId !== '', 'one stable ACP message id for the attempt')
  const expected = message.content.map(content => ({
    sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content },
  }))
  requireFact(isDeepStrictEqual(updates, expected), 'complete ordered typed text chunks equal the committed text bytes and one stable attempt message id')
}

function imageRef(block) {
  requireFact(block.type === 'image' && /^sha256:[0-9a-f]{64}$/u.test(block.attachment?.attachmentId ?? ''), 'official durable image ref')
  return block.attachment
}

/** Deterministic verbatim file bytes: NUL and non-UTF8 for every seed. */
function deterministicFileBytes(seed, length = 70 * 1024 + 13) {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + seed) % 256
  return bytes
}

/** Wait until the PAINTED composer box text contains `needle`. */
async function waitForComposer(tui, needle, label, timeoutMs = 30_000) {
  const deadlineAt = Date.now() + timeoutMs
  while (Date.now() < deadlineAt) {
    const composer = await tui.composerText()
    if (composer !== undefined && composer.includes(needle)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const frame = await tui.viewport().catch(() => [])
  throw new SplitSmokeAssertionError(
    `${label}: composer never contained ${needle}: ${JSON.stringify(await tui.composerText())}`
    + `\n--- viewport tail ---\n${frame.slice(-10).join('\n')}`,
  )
}

/** One committed file block of a durable user message. */
function durableFileOf(message) {
  const file = message.content.find(block => block.type === 'file' && /^sha256:[0-9a-f]{64}$/u.test(block.attachment?.attachmentId ?? ''))
  return file?.attachment
}

/**
 * PR4D TUI-local intake: before any SDK View exists, a REAL TUI `/attach`
 * uploads a Client-local deterministic binary through the official raw upload
 * receipt and submits it with one unique marker. The durable committed
 * user/message therefore names the real Host Store reference this load must
 * later replay; the smoke never fabricates a Session event.
 */
async function primeOutputTuiFile(session) {
  const { context, tui, sessionId } = session
  const bytes = deterministicFileBytes(41)
  const digest = hash(bytes)
  const path = join(context.workDir, 't.bin')
  writeFileSync(path, bytes, { mode: 0o600 })
  const marker = `po4d-tui-file-${String(process.pid)}`
  const before = (hostSessionEvents(context.dshHome, sessionId) ?? []).length
  // Wait for the OPEN Session's own painted workspace footer and composer seat
  // (not the pre-open one) before typing a leading command.
  await tui.waitForScreen('sdk-output-workspace', 'PR4D TUI open workspace', 30_000)
  await waitForComposer(tui, '❯', 'PR4D TUI composer ready')
  tui.send(`/attach ${path}`)
  tui.send('\r')
  await waitForComposer(tui, '[file #', 'PR4D TUI attach staged the Client-local file')
  tui.send(` ${marker}`)
  await waitForComposer(tui, marker, 'PR4D TUI attach marker draft')
  tui.send('\r')
  const durable = await waitForHostSessionEventAfter(context.dshHome, sessionId, before,
    event => event.type === 'user/message' && event.data.source?.kind === 'user'
      && authoredText(event.data).includes(marker) && durableFileOf(event.data) !== undefined,
    'PR4D TUI durable user/message with an official file ref')
  const ref = durableFileOf(durable.data)
  requireFact(ref !== undefined, 'the durable TUI message carries the official file ref')
  requireFact(ref.attachmentId === `sha256:${digest}` && ref.bytes === bytes.length,
    'the durable TUI file ref is the exact uploaded bytes and size')
  const events = hostSessionEvents(context.dshHome, sessionId)
  const userIndex = events.findIndex((event, index) => index >= before && event.type === 'user/message'
    && event.data.id === durable.data.id)
  requireFact(userIndex >= before, 'the durable TUI message belongs to this prime window')
  const turnStart = events.slice(before, userIndex).findLast(event => event.type === 'turn/start')
  const turn = turnStart?.data.turn
  requireFact(Number.isInteger(turn), 'the TUI file message was claimed into a real turn')
  await waitForHostSessionEventAfter(context.dshHome, sessionId, userIndex,
    event => event.type === 'turn/end' && event.data.turn === turn && event.data.reason.kind === 'completed',
    'PR4D TUI file turn completes')
  context.trace('acp-sdk/pr4d-tui-file', {
    sessionId, messageId: durable.data.id, turn, attachmentId: ref.attachmentId, bytes: ref.bytes, sha256: digest,
  })
  return {
    result: {
      tuiFile: {
        messageId: durable.data.id,
        turn,
        attachmentId: ref.attachmentId,
        name: ref.name,
        bytes: ref.bytes,
        sha256: digest,
        uri: `dsh-attachment://sha256/${digest}/${encodeURIComponent(ref.name)}`,
      },
    },
  }
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

/** One standard embedded `resource` block of a typed SDK content position. */
function assertFileResource(content, expected, label) {
  requireFact(content?.type === 'resource' && typeof content.resource?.uri === 'string'
    && typeof content.resource?.blob === 'string', `${label}: typed SDK embedded resource`)
  requireFact(!('mimeType' in content.resource), `${label}: generic file carries no guessed MIME`)
  const bytes = Buffer.from(content.resource.blob, 'base64')
  requireFact(content.resource.blob === bytes.toString('base64'), `${label}: canonical complete file encoding`)
  requireFact(content.resource.uri === expected.uri, `${label}: opaque URI is the exact digest and stored leaf name`)
  requireFact(bytes.length === expected.bytes && hash(bytes) === expected.sha256,
    `${label}: complete SDK bytes match the durable ref size and digest`)
  return bytes
}

/** Each invocation owns one real Host, TUI, control peer and SDK connection. */
async function runScene(context, kind, env, operation, prime) {
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
    tui = (await scene.startC1Client(`SDK ${kind} TUI`, {}, { cwd: workspace, columns: 200 })).client
    tui.send('/new\r')
    const surface = await waitForSurfaceStatus(tui, record => record.sessionOpen === true
      && typeof record.openSessionId === 'string' && record.surfaceMounted === true && record.transport === 'connected',
    `SDK ${kind} TUI Session open`)
    const sessionId = surface.openSessionId
    // An optional TUI-local prime turn runs BEFORE any SDK View attaches, so
    // its durable facts are real shared-Session history rather than SDK input.
    const primed = prime === undefined
      ? undefined
      : await prime({ context, scene, tui, sessionId, workRoot, workspace, identity })
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
    // G-ACP2-PR2: a Host with the official Controller/Query read seams
    // advertises the canonical history and roster methods.
    requireFact(capabilities.loadSession === true && capabilities.sessionCapabilities?.list !== undefined,
      'session/load and session/list are advertised when their read seams are bound')
    const resumed = await sdk.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace })
    // Current contract: the attached View answers the connection-owned display
    // config (`modes` legacy list and/or `configOptions`); no Session business
    // payload (history, message, item, identity) may ride along.
    requireFact(isDeepStrictEqual(
      Object.keys(resumed ?? {}).filter(key => key !== 'configOptions' && key !== 'modes'), []),
    `resume must not carry a business payload beyond its connection config (got ${JSON.stringify(resumed)})`)
    const session = { context, scene, sdk, sessionId, workRoot, identity, workspace, primed }
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
    result = { ...result, ...(primed?.result ?? {}), hostPid: identity.hostPid, hostInstanceId: identity.instanceId, sessionId, hostIdentityKept: true, tuiAfterCloseTurn: tuiTurn }
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
    const healthMarker = `sdk-input-health-${hash(randomBytes(16))}`
    const healthy = await prompt(session, [{ type: 'text', text: healthMarker }], value => authoredText(value) === healthMarker, 'input healthy after rejection')
    assertTextChunks(healthy.updates, assistantMessage(healthy), sessionId)
    // The rejected attempt must leave no durable authored message. The healthy
    // prompt has already supplied the durable user/message + turn/end fence, so
    // this no longer races the official JSONL write-behind buffer: any earlier
    // append on the same Session stream is ordered before that fence.
    const negativeAuthored = (hostSessionEvents(context.dshHome, sessionId) ?? [])
      .slice(negativeStart)
      .filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    requireFact(negativeAuthored.length === 1 && negativeAuthored[0].data.id === healthy.user.id,
      `the rejected admission left no durable authored user/message (got ${String(negativeAuthored.length)} authored message(s) in the negative window)`)
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
    const { sdk, sessionId, workRoot, identity, workspace, primed } = session
    const tuiFile = primed?.result?.tuiFile
    requireFact(tuiFile !== undefined, 'the pre-SDK TUI file turn is part of this scene')
    const run = (text, label, code) => prompt(session, [{ type: 'text', text }], value => authoredText(value) === text, label, code)
    const storeProof = async name => await waitForC1WorkEvent(workRoot, event => event.kind === 'po4c-image-stored'
      && event.name === name && event.pid === identity.hostPid, `SDK official Store ${name}`)
    const fileStoreProof = async name => await waitForC1WorkEvent(workRoot, event => event.kind === 'po4d-file-stored'
      && event.name === name && event.pid === identity.hostPid, `SDK official Store generic file ${name}`)
    const mixed = await run('po4c:assistant-mixed:v1', 'assistant mixed')
    const message = assistantMessage(mixed)
    requireFact(isDeepStrictEqual(message.content.map(block => block.type), ['text', 'image', 'text']), 'committed assistant text/image/text')
    const ref = imageRef(message.content[1])
    const proof = await storeProof('mixed.png')
    // Transient contract: the two standard text deltas arrive as they stream and
    // the never-streamed durable image is appended at the exact-seq join, all
    // under ONE stable ACP message id (which may differ from the durable id).
    requireFact(mixed.updates.length === 3 && mixed.updates.every(params => params.update.sessionUpdate === 'agent_message_chunk'),
      'two streamed text deltas plus the durable image, no more')
    requireFact(new Set(mixed.updates.map(params => params.update.messageId)).size === 1,
      `one attempt uses one stable ACP message id (got ${JSON.stringify(mixed.updates.map(params => params.update.messageId))})`)
    for (const index of [0, 1]) {
      assertTextChunks([mixed.updates[index]], { content: [message.content[index === 0 ? 0 : 2]] }, sessionId, mixed.updates[0].update.messageId)
    }
    const mixedBytes = assertImage(mixed.updates[2].update.content, ref, proof)
    requireFact(Buffer.byteLength(mixed.updates[2].update.content.data) > 256 * 1024, 'typed image logical payload exceeds 256 KiB')

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

    // PR4D: two REAL committed generic files from the controlled model/tool,
    // each verified through the official Store before the View may read it.
    const assistantFileFlight = await run('po4d:assistant-file:v1', 'assistant generic file')
    const assistantFileMessage = assistantMessage(assistantFileFlight)
    requireFact(isDeepStrictEqual(assistantFileMessage.content.map(block => block.type), ['text', 'file', 'text']),
      'committed assistant text/file/text')
    const assistantFileRef = assistantFileMessage.content[1].attachment
    const assistantFileProof = await fileStoreProof(assistantFileRef.name)
    requireFact(assistantFileProof.attachmentId === assistantFileRef.attachmentId
      && assistantFileProof.bytes === assistantFileRef.bytes,
    'the assistant file block carries the exact Store-committed reference')
    requireFact(assistantFileFlight.updates.length === 3
      && assistantFileFlight.updates.every(params => params.update.sessionUpdate === 'agent_message_chunk'),
    'two streamed text deltas plus one durable file residual')
    requireFact(new Set(assistantFileFlight.updates.map(params => params.update.messageId)).size === 1,
      'the file residual shares the one attempt message id')
    for (const index of [0, 2]) {
      assertTextChunks([assistantFileFlight.updates[index]],
        { content: [assistantFileMessage.content[index === 0 ? 0 : 2]] },
        sessionId, assistantFileFlight.updates[0].update.messageId)
    }
    const assistantFileExpected = {
      uri: `dsh-attachment://sha256/${assistantFileProof.sha256}/${encodeURIComponent(assistantFileProof.name)}`,
      bytes: assistantFileProof.bytes,
      sha256: assistantFileProof.sha256,
    }
    assertFileResource(assistantFileFlight.updates[1].update.content, assistantFileExpected, 'assistant generic file')

    const toolFileFlight = await run('po4d:tool-file:v1', 'ordered generic file tool result')
    const toolFileCalls = toolFileFlight.turnEvents.filter(event => event.type === 'tool/call')
    const toolFileResults = toolFileFlight.turnEvents.filter(event => event.type === 'tool/result')
    requireFact(toolFileCalls.length === 1 && toolFileResults.length === 1, 'one real tool call and result')
    const toolFileCall = toolFileCalls[0].data
    const toolFileResult = toolFileResults[0].data.message
    requireFact(toolFileResult.isError === false && toolFileResult.toolCallId === toolFileCall.callId,
      'real successful tool result attribution')
    requireFact(isDeepStrictEqual(toolFileResult.content.map(block => block.type), ['text', 'file', 'text']),
      'ordered committed tool text/file/text content')
    requireFact(isDeepStrictEqual(toolFileFlight.updates.map(params => params.update.sessionUpdate),
      ['tool_call', 'tool_call_update', 'agent_message_chunk']),
    'one tool start, one complete file result and one final assistant chunk')
    const toolFileRef = toolFileResult.content[1].attachment
    const toolFileProof = await fileStoreProof(toolFileRef.name)
    requireFact(toolFileProof.attachmentId === toolFileRef.attachmentId && toolFileProof.bytes === toolFileRef.bytes,
      'the tool file block carries the exact Store-committed reference')
    const toolFileUpdate = toolFileFlight.updates[1].update
    requireFact(toolFileUpdate.toolCallId === toolFileCall.callId && toolFileUpdate.status === 'completed'
      && toolFileUpdate.content.length === 3, 'complete successful tool update')
    const toolFileExpected = {
      uri: `dsh-attachment://sha256/${toolFileProof.sha256}/${encodeURIComponent(toolFileProof.name)}`,
      bytes: toolFileProof.bytes,
      sha256: toolFileProof.sha256,
    }
    assertFileResource(toolFileUpdate.content[1].content, toolFileExpected, 'tool generic file')
    requireFact(isDeepStrictEqual(toolFileUpdate.content[0], { type: 'content', content: toolFileResult.content[0] }),
      'opaque leading tool text bytes remain complete and ordered')
    requireFact(isDeepStrictEqual(toolFileUpdate.content[2], { type: 'content', content: toolFileResult.content[2] }),
      'opaque trailing tool text bytes remain complete and ordered')

    // A `session/load` on the SAME connection and Session must replay the
    // complete canonical history INCLUDING all three committed generic files,
    // while the already-committed outputs stay live-only closed.
    await sdk.request(acp.methods.agent.session.close, { sessionId })
    const loadFrom = sdk.updates.length
    const loaded = await sdk.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] })
    requireFact(loaded !== undefined, 'session/load answered the same real Session')
    const loadWindow = sdk.finishWindow(loadFrom, sdk.updates.length, sessionId)
    const resourceUpdates = loadWindow.filter(params => {
      const update = params.update
      if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') {
        return update.content?.type === 'resource'
      }
      return update.sessionUpdate === 'tool_call_update'
        && update.content.some(content => content.content?.type === 'resource')
    })
    requireFact(resourceUpdates.length === 3,
      `load replays exactly the three committed generic files (got ${String(resourceUpdates.length)})`)
    const loadTui = resourceUpdates[0].update
    requireFact(loadTui.sessionUpdate === 'user_message_chunk' && loadTui.messageId === tuiFile.messageId,
      'the load replays the real TUI-uploaded user file under its durable message id')
    assertFileResource(loadTui.content, tuiFile, 'load TUI generic file')
    const loadAssistant = resourceUpdates[1].update
    requireFact(loadAssistant.sessionUpdate === 'agent_message_chunk'
      && loadAssistant.messageId === assistantFileMessage.id,
    'the load replays the assistant file under its durable message id')
    assertFileResource(loadAssistant.content, assistantFileExpected, 'load assistant generic file')
    const loadTool = resourceUpdates[2].update
    requireFact(loadTool.sessionUpdate === 'tool_call_update' && loadTool.toolCallId === toolFileCall.callId,
      'the load replays the tool file under its real call id')
    assertFileResource(loadTool.content[1].content, toolFileExpected, 'load tool generic file')

    const missing = await run('po4c:missing-image:v1', 'missing verified Store object', 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED')
    const missingRef = imageRef(assistantMessage(missing).content[0])
    const missingProof = await waitForC1WorkEvent(workRoot, event => event.kind === 'po4c-missing-image-rejected'
      && event.attachmentId === missingRef.attachmentId && event.pid === identity.hostPid, 'SDK official missing object rejection')
    requireFact(missingProof.code === 'ATTACHMENT_NOT_FOUND' && missing.updates.length === 0, 'absent Store object sends no image or partial assistant event')

    // The SAME installed Store read failure for a structurally valid generic
    // file reference that was never committed: no resource, no partial event.
    const missingFile = await run('po4d:missing-file:v1', 'missing verified Store generic file', 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED')
    const missingFileRef = assistantMessage(missingFile).content[0].attachment
    const missingFileProof = await waitForC1WorkEvent(workRoot, event => event.kind === 'po4d-missing-file-rejected'
      && event.attachmentId === missingFileRef.attachmentId && event.pid === identity.hostPid,
    'SDK official missing generic file rejection')
    requireFact(missingFileProof.code === 'ATTACHMENT_NOT_FOUND' && missingFile.updates.length === 0,
      'absent Store file object sends no resource or partial assistant event')

    const healthy = await run('po4c:health', 'healthy after missing Store objects')
    assertTextChunks(healthy.updates, assistantMessage(healthy), sessionId)
    return {
      assistantTurn: mixed.turn, assistantMessageId: message.id, assistantAttachmentId: ref.attachmentId,
      assistantImageSha256: hash(mixedBytes), assistantImageBytes: mixedBytes.length, imageOnlyTurn: imageOnly.turn,
      toolTurn: tool.turn, toolCallId: call.callId, toolAttachmentId: toolRef.attachmentId, toolStatus: update.status,
      failedToolTurn: failed.turn, failedToolCallId: failedResult.toolCallId, failedStatus: failed.updates[1].update.status,
      assistantFileTurn: assistantFileFlight.turn, assistantFileMessageId: assistantFileMessage.id,
      assistantFileAttachmentId: assistantFileProof.attachmentId, assistantFileSha256: assistantFileProof.sha256,
      assistantFileBytes: assistantFileProof.bytes,
      toolFileTurn: toolFileFlight.turn, toolFileCallId: toolFileCall.callId,
      toolFileAttachmentId: toolFileProof.attachmentId, toolFileSha256: toolFileProof.sha256,
      toolFileBytes: toolFileProof.bytes,
      loadFileResourceCount: resourceUpdates.length, loadFileReplayVerified: true,
      missingObjectCode: missingProof.code, missingFileCode: missingFileProof.code,
      acpErrorCode: missing.rejection.data.code, missingFileAcpErrorCode: missingFile.rejection.data.code,
      healthyTurn: healthy.turn,
    }
  }, primeOutputTuiFile)
}

export async function runAcpSdkContentInteroperability(context) {
  requireFact(SDK_VERSION === PINNED_SDK && acp.PROTOCOL_VERSION === 1,
    `installed pinned official SDK and ACP v1 (resolved ${String(SDK_VERSION)}, pinned ${String(PINNED_SDK)})`)
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
    tuiFileCommitted: true, assistantFileProjected: true, toolFileProjected: true,
    loadFileReplayVerified: true, missingStoreFileFailedClosed: true,
    healthyAfterFailure: true, tuiHostSurvivedClientClose: true,
    evidence: { candidateSha256: context.candidateSha256, sdkVersion: SDK_VERSION, protocolVersion: acp.PROTOCOL_VERSION, input, output },
  }
  context.trace('acp-sdk/evidence-final', result)
  return result
}
