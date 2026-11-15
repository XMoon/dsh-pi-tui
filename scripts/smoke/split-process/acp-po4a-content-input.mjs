import assertStrict from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

class AcpRawClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.waiters = []
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const message = JSON.parse(line)
        const waiterIndex = this.waiters.findIndex(waiter => waiter.matches(message))
        if (waiterIndex >= 0) {
          const [waiter] = this.waiters.splice(waiterIndex, 1)
          clearTimeout(waiter.timer)
          waiter.resolve(message)
        } else this.queue.push(message)
      }
    })
    this.closed = new Promise(resolve => socket.on('close', resolve))
    socket.on('error', () => {})
  }

  send(message) { this.socket.write(`${JSON.stringify(message)}\n`) }
  sendBytes(bytes) { this.socket.write(bytes) }

  next(timeoutMs = 120_000, matches = () => true) {
    const queuedIndex = this.queue.findIndex(matches)
    if (queuedIndex >= 0) return Promise.resolve(this.queue.splice(queuedIndex, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, timer: undefined }
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`PO-4A ACP client: no message within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async initialize(id) {
    this.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    return await this.next(120_000, message => message.id === id)
  }

  close() { this.socket.destroy() }
}

async function openAcpClient(scopeDir) {
  const dirFd = openSync(scopeDir, 'r')
  try {
    return await connectAcpClient(`/proc/self/fd/${String(dirFd)}/acp.sock`)
  } finally {
    closeSync(dirFd)
  }
}

function connectAcpClient(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(new AcpRawClient(socket))
    })
    socket.once('error', reject)
  })
}

async function sendRequest(client, id, method, params) {
  client.send({ jsonrpc: '2.0', id, method, params })
  return await client.next(120_000, message => message.id === id)
}

async function sendPrompt(client, id, sessionId, prompt) {
  client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt } })
  return await readPromptResponse(client, id)
}

async function readPromptResponse(client, id) {
  const updates = []
  for (;;) {
    const message = await client.next(120_000, response => response.method === 'session/update' || response.id === id)
    if (message?.method === 'session/update') {
      updates.push(message.params)
      continue
    }
    if (message?.id === id && (message.result !== undefined || message.error !== undefined)) {
      return { response: message, updates }
    }
    throw new SplitSmokeAssertionError(`PO-4A: unexpected ACP message: ${JSON.stringify(message).slice(0, 300)}`)
  }
}

async function waitForFact(read, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new SplitSmokeAssertionError(`PO-4A: timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

function messageText(message) {
  return (message?.content ?? []).map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

async function promptMessageAfter(home, sessionId, start, matches, label) {
  const inserted = await waitForHostSessionEventAfter(home, sessionId, start,
    event => event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(message => matches(message)),
    `${label} exact official Inbox insertion`)
  const message = (inserted.data.inserted ?? []).find(candidate => matches(candidate))
  const requestId = message?.source?.rpcId
  assert(typeof requestId === 'string' && requestId.length > 0, `${label}: official insertion must carry its exact requestId`)
  const durable = await waitForFact(async () => (hostSessionEvents(home, sessionId) ?? []).slice(start)
    .find(event => event.type === 'user/message' && event.data?.source?.rpcId === requestId),
  `${label} durable message for exact requestId`)
  return { requestId, message: durable }
}

function userEventsAfter(home, sessionId, start) {
  return (hostSessionEvents(home, sessionId) ?? []).slice(start).filter(event => event.type === 'user/message')
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function imageProbeEvents(probeDir) {
  const path = join(probeDir, 'image-probe.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.success === true)
}

export async function runAcpPo4aContentInput(context) {
  const { dshHome, workDir, trace, installation } = context
  const scene = createC1Scene(context, { imageProbe: true })
  const workRoot = scene.c1WorkRoot('acp-po4a')
  const probeDir = join(workDir, 'po4a-image-probes')
  const hostCwd = realpathSync(workDir)
  const pngDir = join(workDir, 'po4a-images')
  mkdirSync(probeDir, { recursive: true, mode: 0o700 })
  mkdirSync(pngDir, { recursive: true, mode: 0o700 })
  chmodSync(probeDir, 0o700)
  chmodSync(pngDir, 0o700)
  const tuiHold = join(workDir, 'po4a-tui.release')
  const imageAdmissionHold = join(workDir, 'po4a-image-admission.hold')
  const imageAdmissionRelease = join(workDir, 'po4a-image-admission.release')
  const pngSmall = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#20a040' } }).png().toBuffer()
  const pngLarge = await sharp(randomBytes(640 * 640 * 3), { raw: { width: 640, height: 640, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
  const pngOverLimit = await sharp(randomBytes(1100 * 1100 * 3), { raw: { width: 1100, height: 1100, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
  assert(pngLarge.length > 1024 * 1024 && pngLarge.length < 2 * 1024 * 1024,
    `PO-4A L6 needs a valid 1..2 MiB PNG; got ${pngLarge.length} bytes`)
  assert(pngOverLimit.length > 2 * 1024 * 1024, 'PO-4A over-limit control must exceed the Host single-image limit')

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
    await peer.waitFor(record => record.m4a0 === 'ready', 'PO-4A ACP control peer ready', 180_000)
    const requestId = `po4a-enable-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId, acpEnabled: true })
    const response = await peer.waitFor(record => record.op === 'acp-access' && record.requestId === requestId,
      'PO-4A ACP listener enabled', 120_000)
    assert(response.ok === true && response.status?.state === 'enabled', `PO-4A ACP did not enable: ${JSON.stringify(response)}`)
  }
  const openImageConnection = async (scopeDir, label) => {
    const client = track(await openAcpClient(scopeDir))
    const init = await client.initialize(++caseId)
    assert(init?.result?.agentCapabilities?.promptCapabilities?.image === true,
      `${label}: Host must advertise image for the explicit image-capable route`)
    assert(init?.result?.agentInfo?.version === context.installation.manifest.version,
      'PO-4A initialize reports the installed bundle version')
    assert(init.result.agentCapabilities.promptCapabilities.audio === false
      && init.result.agentCapabilities.promptCapabilities.embeddedContext === false,
    `${label}: audio and embedded resources stay disabled`)
    assert(init.result.agentCapabilities.sessionCapabilities?.resume !== undefined
      && init.result.agentCapabilities.sessionCapabilities?.close !== undefined,
    `${label}: the connection must advertise its shared Session View`)
    return client
  }
  const resume = async (client, sessionId, label) => {
    const result = await sendRequest(client, ++caseId, 'session/resume', { sessionId, cwd: hostCwd })
    assert(result.error === undefined, `${label}: resume failed: ${JSON.stringify(result.error)}`)
  }
  const finishPrompt = async (client, sessionId, prompt, label, matches) => {
    const start = (hostSessionEvents(dshHome, sessionId) ?? []).length
    const id = ++caseId
    const pending = sendPrompt(client, id, sessionId, prompt)
    const proof = await promptMessageAfter(dshHome, sessionId, start, matches, label)
    const settled = await pending
    assert(settled.response.error === undefined && settled.response.result?.stopReason === 'end_turn',
      `${label}: prompt failed: ${JSON.stringify(settled.response.error ?? settled.response.result)}`)
    await waitForHostSessionEventAfter(dshHome, sessionId, start, event => event.type === 'turn/end', `${label} real turn/end`)
    return { ...proof, ...settled, start }
  }

  try {
    const started = await scene.startC1Host('acp-po4a', 'po4a Host', {
      C1_PO4A_IMAGE_CAPABLE: '1',
      C1_PO4A_IMAGE_PROBE_DIR: probeDir,
      C1_PO4A_TUI_HOLD: tuiHold,
      C1_PO4A_ADMISSION_HOLD: imageAdmissionHold,
      C1_PO4A_ADMISSION_RELEASE: imageAdmissionRelease,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
    }, workRoot)
    host = started.host
    const ready = started.ready
    const hostIdentity = await scene.hostIdentityFacts(host)
    const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId)
    assert(ready.localHost?.hostPid === hostIdentity.hostPid && typeof ready.localHost.instanceId === 'string',
      'PO-4A L6 must retain the exact Host process and instance identity')
    trace('acp-po4a/evidence-start', {
      candidateSha256: context.candidateSha256,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion,
      bundleVersion: context.installation.manifest.version,
      acpSdkVersion: '1.4.0',
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId: ready.localHost.scopeId,
    })
    await enableAcp()
    assert(lstatSync(join(scopeDir, 'acp.sock')).isSocket(), 'PO-4A Host has one real pathname UDS socket')
    const opened = await scene.startC1Client('po4a TUI', {}, { cwd: hostCwd })
    tui = opened.client
    tui.send('/new\r')
    const openedSession = await waitForSurfaceStatus(tui,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.transport === 'connected' && record.surfaceMounted === true,
      'PO-4A shared Session open')
    const sessionId = openedSession.openSessionId
    const acp = await openImageConnection(scopeDir, 'PO-4A primary ACP connection')
    assert((await scene.hostIdentityFacts(host)).hostPid === hostIdentity.hostPid, 'ACP initialize keeps the same Host process')
    await resume(acp, sessionId, 'PO-4A attach TUI Session')

    // L6-02: the link is only the official model-facing bracketed text.
    const resource = { type: 'resource_link', name: 'external "note"', uri: 'file:///host/not-read.png' }
    const linked = await finishPrompt(acp, sessionId, [
      { type: 'text', text: 'before<' }, resource, { type: 'text', text: '>after' },
    ], 'PO-4A resource_link', message => messageText(message).includes('before<') && messageText(message).includes('>after'))
    assertStrict.deepEqual(linked.message.data.content, [{ type: 'text', text:
      `before<\n[resource_link name=${JSON.stringify(resource.name)} uri=${JSON.stringify(resource.uri)}]\n>after` }],
    'PO-4A resource_link is the exact standard literal in ordered Host content')

    // L6-03: image-only has one real durable ref and no empty text block.
    const only = await finishPrompt(acp, sessionId, [
      { type: 'image', mimeType: 'image/png', data: pngSmall.toString('base64') },
    ], 'PO-4A image-only prompt', message => message.content?.some(part => part.type === 'image'))
    assertStrict.deepEqual(only.message.data.content.map(part => part.type), ['image'], 'image-only admission has no empty text block')
    assert(only.message.data.content[0].attachment?.attachmentId, 'image-only Host message carries a durable attachment ref')

    // L6-04: text/image/resource_link/text preserves order and durable refs.
    const mixed = await finishPrompt(acp, sessionId, [
      { type: 'text', text: 'mixed-before' },
      { type: 'image', mimeType: 'image/png', data: pngSmall.toString('base64') },
      { type: 'resource_link', name: 'tail', uri: 'https://example.invalid/no-fetch' },
      { type: 'text', text: 'mixed-after' },
    ], 'PO-4A mixed content', message => messageText(message).includes('mixed-before'))
    assertStrict.deepEqual(mixed.message.data.content.map(part => part.type), ['text', 'image', 'text'])
    assertStrict.equal(mixed.message.data.content[0].text, 'mixed-before')
    assertStrict.equal(mixed.message.data.content[2].text,
      `\n[resource_link name=${JSON.stringify('tail')} uri=${JSON.stringify('https://example.invalid/no-fetch')}]\nmixed-after`)
    assertStrict.equal(JSON.stringify(hostSessionEvents(dshHome, sessionId)).includes(pngSmall.toString('base64')), false,
      'Host durable Session logs refs only, never Base64')

    // L6-05: one valid fragmented frame crosses the old 1 MiB frame ceiling.
    const largePng = join(pngDir, 'po4a-large.png')
    writeFileSync(largePng, pngLarge, { mode: 0o600 })
    const largeBytes = pngLarge.toString('base64')
    const largeId = ++caseId
    const largeWire = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: largeId, method: 'session/prompt', params: {
      sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: largeBytes }],
    } }) + '\n', 'utf8')
    assert(largeWire.length > 1024 * 1024, 'the real image request frame must exceed 1 MiB')
    const largeStart = (hostSessionEvents(dshHome, sessionId) ?? []).length
    const largePending = readPromptResponse(acp, largeId)
    acp.sendBytes(largeWire)
    const largeProof = await promptMessageAfter(dshHome, sessionId, largeStart,
      message => message.content?.some(part => part.type === 'image' && part.attachment?.bytes === pngLarge.length),
      'PO-4A >1 MiB image prompt')
    const largeResult = await largePending
    assert(largeResult.response.error === undefined && largeResult.response.result?.stopReason === 'end_turn',
      `PO-4A >1 MiB image prompt failed: ${JSON.stringify(largeResult.response.error ?? largeResult.response.result)}`)
    assertStrict.equal(largeProof.message.data.content.find(part => part.type === 'image')?.attachment?.bytes, pngLarge.length)
    assertStrict.equal(JSON.stringify(hostSessionEvents(dshHome, sessionId)).includes(largeBytes), false,
      'the >1 MiB image Base64 is never written to the Host Session log')

    // L6-06: the official Host rejects malformed encoding, wrong MIME and its
    // actual 2 MiB per-image limit before any user/message enters the Session.
    const negativeStart = (hostSessionEvents(dshHome, sessionId) ?? []).length
    const invalidBase64 = await sendPrompt(acp, ++caseId, sessionId, [{ type: 'image', mimeType: 'image/png', data: 'AA=A' }])
    assert(invalidBase64.response.error !== undefined, 'non-canonical Base64 must be an ACP error')
    const mimeMismatch = await sendPrompt(acp, ++caseId, sessionId,
      [{ type: 'image', mimeType: 'image/jpeg', data: pngSmall.toString('base64') }])
    assert(mimeMismatch.response.error !== undefined, 'MIME/bytes mismatch must be rejected')
    const overLimit = await sendPrompt(acp, ++caseId, sessionId,
      [{ type: 'image', mimeType: 'image/png', data: pngOverLimit.toString('base64') }])
    assert(overLimit.response.error !== undefined, 'official Host image byte limit must reject the oversized raster')
    assertStrict.equal((hostSessionEvents(dshHome, sessionId) ?? []).slice(negativeStart)
      .filter(event => event.type === 'user/message').length, 0, 'failed image admission writes no user/message')
    const afterNegative = await finishPrompt(acp, sessionId, [{ type: 'text', text: 'po4a-after-negative' }],
      'PO-4A healthy after negatives', message => messageText(message) === 'po4a-after-negative')
    assert(afterNegative.response.result.stopReason === 'end_turn', 'the negative controls leave the connection usable')

    // L6-07: a fixture-only barrier inside the existing official saveImages call.
    // `waitForBarrier` proceeds only when the file EXISTS: remove it to hold.
    rmSync(tuiHold, { force: true })
    rmSync(imageAdmissionHold, { force: true })
    rmSync(imageAdmissionRelease, { force: true })
    const tuiStart = (hostSessionEvents(dshHome, sessionId) ?? []).length
    tui.send('po4a-held-tui\r')
    await waitForC1WorkEvent(workRoot, event => event.kind === 'po4a-tui-turn-held', 'PO-4A held TUI turn')
    writeFileSync(imageAdmissionHold, '', { mode: 0o600 })
    const canceledStart = (hostSessionEvents(dshHome, sessionId) ?? []).length
    const canceledId = ++caseId
    const canceledPending = sendPrompt(acp, canceledId, sessionId,
      [{ type: 'image', mimeType: 'image/png', data: pngSmall.toString('base64') }])
    await waitForC1WorkEvent(workRoot, event => event.kind === 'po4a-image-admission-held', 'PO-4A official attachment barrier')
    acp.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    acp.send({ jsonrpc: '2.0', id: ++caseId, method: 'session/new', params: { cwd: hostCwd, mcpServers: [] } })
    const afterCancel = await acp.next()
    assert(afterCancel.id === caseId && afterCancel.error?.data?.code === 'LOCAL_ACP_VIEW_BUSY',
      `PO-4A socket-order barrier must observe the active prompt: ${JSON.stringify(afterCancel)}`)
    writeFileSync(imageAdmissionRelease, 'release\n', { mode: 0o600 })
    const canceled = await canceledPending
    assert(canceled.response.result?.stopReason === 'cancelled',
      `PO-4A cancellation must follow exact queued removal: ${JSON.stringify(canceled.response)}`)
    const canceledInsert = await waitForHostSessionEventAfter(dshHome, sessionId, canceledStart,
      event => event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(message =>
        message.source?.kind === 'user' && message.content?.some(part => part.type === 'image')),
      'PO-4A exact ACP image insertion during the held admission')
    const canceledMessage = canceledInsert.data.inserted.find(message =>
      message.source?.kind === 'user' && message.content?.some(part => part.type === 'image'))
    const canceledRpcId = canceledMessage?.source?.rpcId
    assert(typeof canceledRpcId === 'string' && canceledRpcId.length > 0, 'the canceled Host image message carries its exact ACP requestId')
    await waitForC1WorkEvent(workRoot, event => event.kind === 'po4a-inbox-discarded'
      && event.rpcId === canceledRpcId && event.messageId === canceledMessage.id,
    'PO-4A exact official discarded message fact')
    assertStrict.equal((hostSessionEvents(dshHome, sessionId) ?? []).slice(canceledStart)
      .filter(event => event.type === 'user/message').length, 0, 'the canceled image never reaches user/message')
    writeFileSync(tuiHold, 'release\n', { mode: 0o600 })
    await waitForHostSessionEventAfter(dshHome, sessionId, tuiStart,
      event => event.type === 'turn/end', 'PO-4A TUI-owned turn ends after the ACP cancel')
    assert((tui.records.filter(record => record.m4b2s === 'surface-status').at(-1))?.openSessionId === sessionId,
      'the ACP image cancellation leaves the real TUI Session active')

    // L6-08: another connection cannot acquire this claim; after close it can
    // reattach the same Session without replacing the Host Agent/Writer.
    const sibling = await openImageConnection(scopeDir, 'PO-4A second connection')
    const conflict = await sendRequest(sibling, ++caseId, 'session/resume', { sessionId, cwd: hostCwd })
    assert(conflict.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED', 'one ACP View owns the Session at a time')
    const close = await sendRequest(acp, ++caseId, 'session/close', { sessionId })
    assertStrict.deepEqual(close.result, {})
    await resume(sibling, sessionId, 'PO-4A reattach after close')
    const reattached = await finishPrompt(sibling, sessionId, [{ type: 'text', text: 'po4a-reattached' }],
      'PO-4A reattached prompt', message => messageText(message) === 'po4a-reattached')
    assert(reattached.response.result.stopReason === 'end_turn')

    const imageProbes = imageProbeEvents(probeDir)
    assert(imageProbes.length >= 3, `the Host readImage probe must verify admitted images (got ${imageProbes.length})`)
    const verifiedHashes = new Set(imageProbes.map(event => event.sha256))
    assert(verifiedHashes.has(hash(pngSmall)) && verifiedHashes.has(hash(pngLarge)),
      'Host readImage digests must match accepted generated PNG inputs')
    assert(imageProbes.every(event => typeof event.attachmentId === 'string'
      && /^sha256:/u.test(event.attachmentId) && event.mediaType === 'image/png' && event.bytes > 0),
    'Host image probe records carry the actual durable attachment metadata')
    const finalIdentity = await scene.hostIdentityFacts(host)
    assert(finalIdentity.hostPid === hostIdentity.hostPid && finalIdentity.instanceId === hostIdentity.instanceId,
      'PO-4A never replaces the Host process')
    const evidence = {
      status: 'PASS', scope: 'REAL_SPLIT_PROCESS_L6', hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId, sessionId, candidateSha256: context.candidateSha256,
      dshVersion: context.targetDshVersion, acpSdkVersion: '1.4.0', imageCapability: true,
      resourceLinkExact: true, imageOnly: true, mixedOrder: true, largeFrameBytes: largeWire.length,
      largeImageBytes: pngLarge.length, invalidImagesRejectedWithoutMessage: true,
      imageCancelRemovalProven: true, tuiTurnPreserved: true, reattachSameHost: true,
      imageProbes,
    }
    trace('acp-po4a/evidence-final', evidence)
    return {
      status: 'PASS', scope: 'REAL_SPLIT_PROCESS_L6', imageCapabilityAdvertised: true,
      resourceLinkAdmittedAsText: true, imageOnlyAdmitted: true, mixedContentOrderPreserved: true,
      largeImageFrameOverOneMiB: true, hostRejectedInvalidAndOverLimit: true,
      imageCancelScopedToOwnAdmission: true, tuiRemainsActive: true,
      perSessionViewIsolation: true, sameSessionReattach: true, hostIdentityKept: true,
      readImageVerified: true, l6EvidenceRecorded: true, evidence,
    }
  } finally {
    for (const client of acpClients) { try { client.close() } catch { /* already closed */ } }
    for (const peer of peers) { if (!peer.exited) { try { await peer.shutdown() } catch { /* process backstop */ } } }
    if (tui !== undefined) { try { await scene.exitC1Client(tui, 'PO-4A TUI') } catch { /* process backstop */ } }
    try { await scene.dispose() } catch { /* process backstop */ }
    try { await scene.awaitSceneSeatFree().catch(() => {}) } catch { /* seat best effort on failure */ }
  }
}
