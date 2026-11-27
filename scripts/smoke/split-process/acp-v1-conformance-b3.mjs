/**
 * G-ACP1B/B3 — real packaged ACP v1 capability and entry conformance.
 *
 * ONE real installed Split Host, its Host-owned authenticated Unix socket, and
 * the official `@agentclientprotocol/sdk` client. This case does NOT replace the
 * B0/B1/B2 lifecycle proofs and does not run a TCK: it proves the v1 entry
 * negotiation, advertised capability/negative pairs, standard new/prompt/close,
 * unsupported-method refusals and the Off/On resume path on the current package.
 *
 * PRODUCTION PREREQUISITES REPRODUCED = installed package, official SDK, real
 * C1 Host/Agent/Session/Writer, Host-owned authenticated UDS, real raw frame.
 * TEST STAND-INS = deterministic scripted offline LLM and run-owned
 * workspace/credentials.
 * DELIBERATELY ABSENT = public stdio Adapter, actual external UI/T3, real
 * provider billing, TCK.
 *
 * @module split-process/acp-v1-conformance-b3
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { installedSdkVersion } from '../../lib/split-smoke-sdk.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEventAfter,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.v1-conformance-b3'
const PROTOCOL_VERSION = 1

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

async function deadline(promise, label, timeoutMs = 180_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new SplitSmokeAssertionError(`${CASE_ID}: ${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function updateText(params) {
  const content = params?.update?.content
  if (Array.isArray(content)) {
    return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
  }
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
}

function readProof(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** One raw NDJSON JSON-RPC client over a real ACP UDS connection. */
class RawAcpClient {
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
        const waiter = this.waiter
        if (waiter !== undefined) {
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

  static async open(endpoint) {
    const socket = await connectAcpSocket(endpoint)
    return new RawAcpClient(socket)
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  next(timeoutMs = 8_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        rejectNext(new Error(`acp raw client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = value => { clearTimeout(timer); resolveNext(value) }
    })
  }

  async request(id, method, params) {
    this.send({ jsonrpc: '2.0', id, method, params })
    const message = await this.next()
    assert(message?.id === id, `${CASE_ID}: raw ${method} response id ${JSON.stringify(message?.id)} instead of ${String(id)}`)
    return message
  }

  /**
   * Send one request whose expected response may be preceded by asynchronous
   * `session/update` notifications (an attach legitimately starts catalog/plan
   * delivery). Only real notifications may interleave; anything else fails.
   */
  async requestSkippingNotifications(id, method, params) {
    this.send({ jsonrpc: '2.0', id, method, params })
    for (;;) {
      const message = await this.next()
      if (message?.id === id) return message
      assert(message?.id === undefined && typeof message?.method === 'string',
        `${CASE_ID}: non-notification message before raw ${method} response ${String(id)}: ${JSON.stringify(message)}`)
    }
  }

  async silent(windowMs) {
    if (this.queue.length > 0) return false
    return await new Promise(resolveSilent => {
      let timer
      const finish = value => {
        if (this.waiter === waiter) this.waiter = undefined
        clearTimeout(timer)
        resolveSilent(value)
      }
      const waiter = value => {
        this.queue.unshift(value)
        finish(false)
      }
      this.waiter = waiter
      timer = setTimeout(() => finish(true), windowMs)
    })
  }

  close() {
    this.socket.destroy()
    return this.closed
  }
}

async function connectAcpSocket(endpoint) {
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
  return socket
}

/** One real ACP v1 SDK client owned by the public SDK package. */
async function openSdkClient(endpoint, options = {}) {
  const socket = await connectAcpSocket(endpoint)
  const socketClosed = new Promise(resolve => socket.once('close', resolve))
  const updates = []
  const reverseCalls = []
  const app = acp.client({ name: options.name ?? 'b3-v1-conformance' })
  app.onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params)
    options.onUpdate?.(params)
  })
  if (options.captureClientReverseRequests === true) {
    for (const method of [
      acp.methods.client.fs.readTextFile,
      acp.methods.client.fs.writeTextFile,
      acp.methods.client.terminal.create,
      acp.methods.client.terminal.output,
      acp.methods.client.terminal.release,
      acp.methods.client.terminal.waitForExit,
      acp.methods.client.terminal.kill,
    ]) {
      app.onRequest(method, async ({ params }) => {
        reverseCalls.push({ method, params })
        throw new Error(`unexpected client reverse request ${method}`)
      })
    }
  }
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket)))
  return {
    connection,
    socket,
    updates,
    reverseCalls,
    async request(method, params) {
      return await deadline(connection.agent.request(method, params), `ACP ${method}`)
    },
    async notify(method, params) {
      await deadline(connection.agent.notify(method, params), `ACP notify ${method}`)
    },
    async close() {
      try { await connection.close() } catch { /* already closed by the peer */ }
      socket.destroy()
      await deadline(Promise.allSettled([connection.closed, socketClosed]), 'ACP connection close', 30_000).catch(() => {})
    },
  }
}

async function expectRequestError(promise, label) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}: request unexpectedly succeeded`)
}

export async function runAcpV1ConformanceB3(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context, { scopedMcpB1: true })
  const b3WorkRoot = scene.c1WorkRoot('b3')
  const controlPath = join(b3WorkRoot, 'b1-control.json')
  const workspace = join(workDir, 'b3-workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const hostCwd = realpathSync(workspace)
  const otherCwd = join(workDir, 'b3-other-cwd')
  mkdirSync(otherCwd, { recursive: true, mode: 0o700 })
  const runNonce = `b3-run-${digestOf(`${process.pid}-${Date.now()}`).slice(0, 16)}`
  const modelMarker = `B1_PLAIN_A ${digestOf(`b3-${runNonce}`).slice(0, 16)}`
  const modelAnswer = `b1 plain settled ${digestOf(`b3-${runNonce}`).slice(0, 16)}`
  const peers = []
  const acpClients = []
  const rawClients = []
  let host
  let hostIdentity
  let peer
  let sessionA
  let sessionB
  let acpEndpoint
  let sequence = 0
  let actionSequence = 0

  const hostIdentityFacts = async () => await scene.hostIdentityFacts(host)
  const assertSameHost = async (before, label) => {
    const after = await hostIdentityFacts()
    assert(after.hostPid === before.hostPid, `${label}: the Host process was replaced`)
    assert(after.instanceId === before.instanceId, `${label}: the Host instanceId changed`)
    assert(after.scopeId === before.scopeId, `${label}: the Host scope changed`)
    await scene.assertHostIdentityKept(host, before, label)
  }
  const runDsh = args => {
    const [executable, ...prefix] = installation.dshInvocation
    return spawnSync(executable, [...prefix, '--profile', 'pi-tui', ...args], {
      cwd: installation.profileDir,
      env: installation.env,
      encoding: 'utf8',
      timeout: 120_000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  const daemonStatus = label => {
    const result = runDsh(['daemon', 'status'])
    assert(result.status === 0, `${label}: daemon status exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
    const fields = {}
    for (const line of result.stdout.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
    }
    return fields
  }
  const startPeer = async label => {
    const process = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    process.qualificationLabel = label
    peers.push(process)
    await process.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return process
  }
  const acpAccess = async (process, label, value) => {
    const requestId = `b3-acp-access-${String(++sequence)}-${String(process.pid)}`
    process.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return await process.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const control = async (action, fields = {}) => {
    const actionId = `b3-action-${String(++actionSequence)}-${String(process.pid)}`
    const temporary = `${controlPath}.tmp-${actionId}`
    writeFileSync(temporary, JSON.stringify({ actionId, action, ...fields }), { mode: 0o600 })
    renameSync(temporary, controlPath)
    return await waitForC1WorkEvent(b3WorkRoot, event => event.kind === 'b1-fact' && event.actionId === actionId,
      `${CASE_ID} control ${action}`, 180_000)
  }
  const eventsOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const openAcp = async (label, options = {}) => {
    const client = await openSdkClient(acpEndpoint, options)
    acpClients.push(client)
    const initialized = await client.request(acp.methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: options.clientCapabilities ?? {},
    })
    assert(initialized?.protocolVersion === PROTOCOL_VERSION, `${label}: initialize must answer protocolVersion 1`)
    return { client, initialized }
  }
  const closeAcp = async client => { await client.close().catch(() => {}) }
  const assertOnlySession = (updates, sessionId, label) => {
    for (const update of updates) assert(update.sessionId === sessionId, `${label}: cross-Session update ${JSON.stringify(update)}`)
  }
  const expectedUserText = `${modelMarker}\n[resource_link name=${JSON.stringify('external "note"')} uri=${JSON.stringify('file:///host/not-read.png')}]\n after-link`

  try {
    const started = await scene.startC1Host('acp-scoped-mcp-b1', 'b3 host', {
      C1_B1_CONTROL: controlPath,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    }, b3WorkRoot)
    host = started.host
    const ready = started.ready
    hostIdentity = await hostIdentityFacts()
    assert(typeof ready.localHost?.scopeId === 'string' && ready.localHost.scopeId.length === 64, 'B3-01: Host Ready must publish the scope id')
    assert(/^[0-9a-f]{64}$/u.test(context.candidateSha256), 'B3-01: candidate SHA256 must be a real digest')
    assert(typeof installation.manifest.version === 'string' && installation.manifest.version.length > 0,
      'B3-01: installed package version must be real')
    const expectedSocket = process.platform === 'darwin'
      ? `/private/tmp/dpt-${String(process.getuid())}-${ready.localHost.scopeId.slice(0, 40)}/acp.sock`
      : join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'acp.sock')
    acpEndpoint = process.platform === 'darwin'
      ? { path: expectedSocket }
      : { path: expectedSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId) }
    assert(!existsSync(acpEndpoint.path), 'B3-01: the default-OFF Host must not bind an ACP socket')
    peer = await startPeer('b3 peer')
    const initialAccess = await acpAccess(peer, 'B3-01 initial ACP status', undefined)
    assert(initialAccess.ok === true && initialAccess.status?.state === 'disabled', `B3-01: ACP must start disabled: ${JSON.stringify(initialAccess)}`)
    const enabledAccess = await acpAccess(peer, 'B3-01 enable ACP', true)
    assert(enabledAccess.ok === true && enabledAccess.status?.state === 'enabled', `B3-01: ACP must enable: ${JSON.stringify(enabledAccess)}`)
    const status = daemonStatus('B3-01 daemon status')
    assert(status.host === 'ready' && status.acp === 'enabled', `B3-01: daemon status: ${JSON.stringify(status)}`)
    assert(status['acp-socket'] === expectedSocket, `B3-01: daemon status endpoint: ${JSON.stringify(status)}`)
    assert(existsSync(expectedSocket), 'B3-02: the real Host must bind the published ACP socket')
    trace('acp-v1-conformance-b3/b3-01', { candidateSha256: context.candidateSha256, hostPid: hostIdentity.hostPid, scopeId: ready.localHost.scopeId })

    // B3-03: a raw legal ACP frame negotiates the requested future version to
    // v1. The same socket rejects a second initialize; an SDK connection with
    // v1 is independent.
    const raw = await RawAcpClient.open(acpEndpoint)
    rawClients.push(raw)
    const rawInit = await raw.request(1, 'initialize', { protocolVersion: 65535, clientCapabilities: {} })
    assert(rawInit.error === undefined, `B3-03: raw initialize(65535) returned an error: ${JSON.stringify(rawInit.error)}`)
    assert(rawInit.result?.protocolVersion === PROTOCOL_VERSION, `B3-03: raw initialize(65535) result: ${JSON.stringify(rawInit.result)}`)
    assert(rawInit.result?.agentInfo?.name === 'dsh-pi-tui', `B3-03: raw agentInfo: ${JSON.stringify(rawInit.result?.agentInfo)}`)
    assert(await raw.silent(100), 'B3-03: initialize must not emit an extra session/update')
    const duplicate = await raw.request(2, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert(duplicate.error?.code === -32043, `B3-03: duplicate initialize: ${JSON.stringify(duplicate)}`)
    assert(duplicate.error?.data?.code === 'LOCAL_ACP_ALREADY_INITIALIZED', 'B3-03: duplicate initialize must keep its stable data code')
    raw.close()

    const main = await openAcp('B3-03 main SDK', { captureClientReverseRequests: false })
    assert(main.initialized.protocolVersion === 1, 'B3-03: SDK initialize must answer protocolVersion 1')
    const listedRoster = await main.client.request('session/list', {})
    assert(Array.isArray(listedRoster?.sessions),
      `B3-03: the initialized SDK connection must serve the authorized Session roster (got ${JSON.stringify(listedRoster)})`)

    // B3-04: client capability combinations never manufacture server auth,
    // fs/terminal, list/load/delete/fork or a positive MCP HTTP/SSE promise.
    const extra = await openAcp('B3-04 extra SDK', {
      captureClientReverseRequests: true,
      clientCapabilities: {
        auth: { terminal: true },
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    const mainCaps = main.initialized.agentCapabilities
    const extraCaps = extra.initialized.agentCapabilities
    assert(main.initialized.agentInfo?.name === 'dsh-pi-tui', `B3-04: agentInfo name: ${JSON.stringify(main.initialized.agentInfo)}`)
    assert(main.initialized.agentInfo?.title === 'dsh-pi-tui', 'B3-04: agentInfo title must be the product identity')
    assert(main.initialized.agentInfo?.version === installation.manifest.version,
      `B3-04: agentInfo.version must be the installed bundle version, got ${JSON.stringify(main.initialized.agentInfo?.version)}`)
    assert(JSON.stringify(main.initialized.authMethods) === '[]', `B3-04: authMethods must be empty: ${JSON.stringify(main.initialized.authMethods)}`)
    assert(mainCaps?.loadSession === true,
      'B3-04: a Host with the official Controller/Query read seams must advertise session/load')
    assert(mainCaps?.sessionCapabilities?.resume !== undefined && mainCaps.sessionCapabilities.close !== undefined,
      'B3-04: a real Host View must advertise resume/close')
    assert(mainCaps?.sessionCapabilities?.list !== undefined,
      'B3-04: and the authorized Session roster')
    assert(mainCaps?.sessionCapabilities?.load === undefined
      && mainCaps?.sessionCapabilities?.delete === undefined
      && mainCaps?.sessionCapabilities?.fork === undefined
      && mainCaps?.sessionCapabilities?.additionalDirectories === undefined
      && mainCaps?.sessionCapabilities?.options === undefined
      && mainCaps?.sessionCapabilities?.systemPrompt === undefined,
    `B3-04: unsupported Session capabilities must stay absent: ${JSON.stringify(mainCaps?.sessionCapabilities)}`)
    assert(mainCaps?.promptCapabilities?.audio === false && mainCaps?.promptCapabilities?.embeddedContext === true,
      'B3-04: audio stays false and embeddedContext is real on the complete Host')
    assert(typeof mainCaps?.promptCapabilities?.image === 'boolean', 'B3-04: image prompt capability must be an explicit boolean')
    assert(mainCaps?.mcpCapabilities?.http === true && mainCaps?.mcpCapabilities?.sse === false,
      'B3-04: HTTP MCP must be advertised and Legacy SSE must be false')
    assert(mainCaps?.mcpCapabilities?.acp !== true, 'B3-04: unstable ACP MCP transport must not be advertised')
    assert(mainCaps?.fs === undefined && mainCaps?.terminal === undefined,
      'B3-04: Agent capabilities must not expose client fs/terminal capabilities')
    assert(JSON.stringify(extraCaps) === JSON.stringify(mainCaps),
      `B3-04: the client fs/terminal/auth claims changed the Agent capability response: ${JSON.stringify({ mainCaps, extraCaps })}`)
    const extraCreated = await extra.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    assert(typeof extraCreated?.sessionId === 'string' && extraCreated.sessionId.length > 0,
      `B3-04: the capability-test Session: ${JSON.stringify(extraCreated)}`)
    const extraPrompt = await extra.client.request(acp.methods.agent.session.prompt, {
      sessionId: extraCreated.sessionId,
      prompt: [{ type: 'text', text: 'b3-client-capabilities' }],
    })
    assert(extraPrompt?.stopReason === 'end_turn', `B3-04: the capability-test prompt: ${JSON.stringify(extraPrompt)}`)
    assert(extra.client.reverseCalls.length === 0,
      `B3-04: a client fs/terminal claim caused a reverse request: ${JSON.stringify(extra.client.reverseCalls)}`)
    assert(JSON.stringify(await extra.client.request(acp.methods.agent.session.close, { sessionId: extraCreated.sessionId })) === '{}',
      'B3-04: the capability-test Session must close with {}')

    // B3-05: one real standard Session, one text+resource_link prompt and
    // real Host durable assistant/turn output on the exact Session.
    const created = await main.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    sessionA = created?.sessionId
    assert(typeof sessionA === 'string' && sessionA.length > 0, `B3-05: session/new: ${JSON.stringify(created)}`)
    const beforePrompt = eventsOf(sessionA).length
    const updatesBefore = main.client.updates.length
    const prompt = [
      { type: 'text', text: modelMarker },
      { type: 'resource_link', name: 'external "note"', uri: 'file:///host/not-read.png' },
      { type: 'text', text: ' after-link' },
    ]
    const promptResult = await main.client.request(acp.methods.agent.session.prompt, { sessionId: sessionA, prompt })
    assert(promptResult?.stopReason === 'end_turn', `B3-05: prompt result: ${JSON.stringify(promptResult)}`)
    await waitForHostSessionEventAfter(dshHome, sessionA, beforePrompt,
      event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed', 'B3-05 turn/end')
    const promptUpdates = main.client.updates.slice(updatesBefore)
    assertOnlySession(promptUpdates, sessionA, 'B3-05 updates')
    const assistantUpdates = promptUpdates.filter(update => update.update?.sessionUpdate === 'agent_message_chunk')
    assert(assistantUpdates.length >= 1 && assistantUpdates.some(update => updateText(update).includes(modelAnswer)),
      `B3-05: assistant chunk missing: ${JSON.stringify(assistantUpdates)}`)
    const events = eventsOf(sessionA)
    assert(hostAssistantHasText(events, modelAnswer), 'B3-05: durable assistant/message missing')
    assert(hostUserTexts(events).includes(expectedUserText),
      `B3-05: durable resource_link text differs: ${JSON.stringify(hostUserTexts(events))}`)

    // Negative prompt content is refused before a Host write. Image is only
    // added when the handshake did not advertise the prompt capability.
    const beforeNegative = eventsOf(sessionA).length
    const negatives = [
      { label: 'audio', block: { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' } },
      { label: 'unknown block', block: { type: 'b3-unknown', text: 'x' } },
      ...(mainCaps.promptCapabilities.image === false
        ? [{ label: 'unnegotiated image', block: { type: 'image', mimeType: 'image/png', data: 'AAAA' } }]
        : []),
    ]
    for (const negative of negatives) {
      const error = await expectRequestError(
        main.client.request(acp.methods.agent.session.prompt, { sessionId: sessionA, prompt: [negative.block] }),
        `B3-05 ${negative.label}`,
      )
      assert(error !== undefined, `B3-05: ${negative.label} must fail`)
    }
    const afterNegative = eventsOf(sessionA)
    assert(afterNegative.length === beforeNegative || afterNegative.slice(beforeNegative)
      .every(event => event.type !== 'user/message' && event.type !== 'assistant/message'),
    'B3-05: refused content must not write a Host user/assistant message')

    // B3-06: exact close, repeated/unknown close, no cross-Session control,
    // and the same socket still admits a new Session.
    const closedA = await main.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(closedA) === '{}', `B3-06: first close: ${JSON.stringify(closedA)}`)
    const closedAgainA = await main.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(closedAgainA) === '{}', 'B3-06: repeated close must be idempotent')
    const unknownClose = await main.client.request(acp.methods.agent.session.close, { sessionId: 'b3-unknown-session' })
    assert(JSON.stringify(unknownClose) === '{}', 'B3-06: unknown close must be {}')
    const closedPrompt = await expectRequestError(
      main.client.request(acp.methods.agent.session.prompt, { sessionId: sessionA, prompt: [{ type: 'text', text: 'after close' }] }),
      'B3-06 prompt after close',
    )
    // A closed Session is the standard not-active class: -32002 plus the
    // REQUESTED id, never a malformed-params or conflict classification.
    assert(closedPrompt?.code === -32002
      && closedPrompt?.data?.code === 'LOCAL_ACP_VIEW_NOT_OWNED'
      && closedPrompt?.data?.sessionId === sessionA,
    `B3-06: closed View prompt: ${JSON.stringify(closedPrompt)}`)
    const createdB = await main.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    sessionB = createdB?.sessionId
    assert(typeof sessionB === 'string' && sessionB !== sessionA, `B3-06: post-close new Session: ${JSON.stringify(createdB)}`)
    // The other connection has no View for the ACTIVE Session B. A foreign
    // close must remain the empty no-op and must not detach main's live claim;
    // the subsequent main prompt proves the claim survived. A foreign prompt is
    // refused before any Host dispatch.
    const other = await openAcp('B3-06 other connection')
    const foreignCloseB = await other.client.request(acp.methods.agent.session.close, { sessionId: sessionB })
    assert(JSON.stringify(foreignCloseB) === '{}', 'B3-06: a foreign close must be a no-op {}')
    const beforeForeignPromptB = eventsOf(sessionB).length
    const foreignPromptB = await expectRequestError(
      other.client.request(acp.methods.agent.session.prompt, { sessionId: sessionB, prompt: [{ type: 'text', text: 'foreign' }] }),
      'B3-06 foreign prompt',
    )
    assert(foreignPromptB?.code === -32002
      && foreignPromptB?.data?.code === 'LOCAL_ACP_VIEW_NOT_OWNED'
      && foreignPromptB?.data?.sessionId === sessionB,
    `B3-06: foreign prompt must be the standard not-active error: ${JSON.stringify(foreignPromptB)}`)
    assert(eventsOf(sessionB).slice(beforeForeignPromptB)
      .every(event => event.type !== 'user/message' && event.type !== 'assistant/message'),
    'B3-06: a refused foreign prompt must not write a Host user/assistant message')
    const beforeSurvivorB = eventsOf(sessionB).length
    const survivorB = await main.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionB,
      prompt: [{ type: 'text', text: 'b3-active-view-survivor' }],
    })
    assert(survivorB?.stopReason === 'end_turn',
      `B3-06: the foreign close must not detach the active View: ${JSON.stringify(survivorB)}`)
    await waitForHostSessionEventAfter(dshHome, sessionB, beforeSurvivorB,
      event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed', 'B3-06 active-B turn/end')
    assert(hostAssistantHasText(eventsOf(sessionB).slice(beforeSurvivorB), 'b1 plain'),
      'B3-06: the active View did not produce its own Host answer')
    await assertSameHost(hostIdentity, 'B3-06 Host after close/new')

    // B3-07: unadvertised methods fail without Side effects. session/list serves
    // the authorized roster; session/load stays fail-closed for an already
    // attached Session; the standard set_mode method is registered and an
    // unknown mode id is a stable invalid-option refusal (never method-not-found
    // or a Host write), while unknown RPC methods stay method-not-found.
    const optional = await RawAcpClient.open(acpEndpoint)
    rawClients.push(optional)
    const optionalInit = await optional.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert(optionalInit.result?.protocolVersion === 1, 'B3-07: raw SDK-compatible initialize failed')
    const settingsPath = join(dshHome, 'settings.yaml')
    const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined
    const probeBefore = await control('probe', { sessionId: sessionA })
    // A probe without a sessionId returns the fixture's default empty roster, so
    // it can never prove that a target Agent's tools were unchanged. Anchor the
    // real roster to the SAME still-live Host Agent of the closed sessionA View.
    assert(probeBefore.ok === true && probeBefore.agentId === sessionA,
      `B3-10: the probe must resolve sessionA's live Host Agent: ${JSON.stringify(probeBefore)}`)
    assert(Array.isArray(probeBefore.toolNames) && probeBefore.toolNames.length > 0,
      `B3-10: the probe must observe a real Host tool roster: ${JSON.stringify(probeBefore.toolNames)}`)
    const listed = await optional.request(2, 'session/list', {})
    assert(Array.isArray(listed.result?.sessions),
      `B3-07: session/list must serve the authorized roster: ${JSON.stringify(listed)}`)
    // `session/load` is a real method now, but a Session another connection
    // already holds must stay fail-closed: no second View, no Host side effect.
    const loaded = await optional.request(3, 'session/load', { sessionId: sessionB, cwd: hostCwd, mcpServers: [] })
    assert(loaded.error?.code === -32602
      && (loaded.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED' || loaded.error?.data?.code === 'LOCAL_ACP_VIEW_BUSY'),
    `B3-07: a foreign-attached Session must never get a second View: ${JSON.stringify(loaded)}`)
    // A definite official `session/not-found` on resume/load is the same
    // standard not-active class with the requested id; it is never a
    // malformed request and never queries a Host guess.
    const unknownResume = await optional.request(16, 'session/resume', { sessionId: 'b3-unknown-session', cwd: hostCwd, mcpServers: [] })
    assert(unknownResume.error?.code === -32002
      && unknownResume.error?.data?.code === 'LOCAL_ACP_VIEW_SESSION_NOT_FOUND'
      && unknownResume.error?.data?.sessionId === 'b3-unknown-session',
    `B3-07: unknown resume must be the standard not-active error: ${JSON.stringify(unknownResume)}`)
    const unknownLoad = await optional.request(17, 'session/load', { sessionId: 'b3-unknown-session', cwd: hostCwd, mcpServers: [] })
    assert(unknownLoad.error?.code === -32002
      && unknownLoad.error?.data?.code === 'LOCAL_ACP_VIEW_SESSION_NOT_FOUND'
      && unknownLoad.error?.data?.sessionId === 'b3-unknown-session',
    `B3-07: unknown load must be the standard not-active error: ${JSON.stringify(unknownLoad)}`)
    const setMode = await optional.request(4, 'session/set_mode', { sessionId: sessionB, modeId: 'x' })
    assert(setMode.error?.code === -32602
      && setMode.error?.data?.code === 'LOCAL_ACP_CONFIG_INVALID_OPTION',
    `B3-07: an unknown mode id must be a stable invalid-option refusal with no side effect: ${JSON.stringify(setMode)}`)
    const removed = await optional.request(5, 'session/delete', { sessionId: sessionB })
    assert(removed.error?.code === -32601, `B3-07: session/delete must be method-not-found: ${JSON.stringify(removed)}`)
    const unknownMethod = await optional.request(6, '_/b3-method', {})
    assert(unknownMethod.error?.code === -32601, `B3-07: unknown method must be method-not-found: ${JSON.stringify(unknownMethod)}`)
    optional.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
    assert(await optional.silent(200), 'B3-07: session/cancel must not receive a response')
    // B3-10: an unadvertised systemPrompt is refused on every lifecycle entry
    // BEFORE any Host side effect. The pinned v1 schema accepts the field, so a
    // raw frame is the only way to prove the View does not silently ignore it.
    // `sessionA` was closed in B3-06, so it has no ACP claim and its resume/load
    // refusal cannot be masked by a busy/foreign rejection.
    const historyBefore = eventsOf(sessionA)
    assert(historyBefore.length > 0
      && hostUserTexts(historyBefore).includes(expectedUserText)
      && hostAssistantHasText(historyBefore, modelAnswer)
      && historyBefore.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed'),
    `B3-10: sessionA must carry its proven durable history before the refusals: ${JSON.stringify(historyBefore)}`)
    const systemPrompt = {
      mode: 'append',
      content: [{ type: 'text', text: `b3-unannounced-prompt-${digestOf(`b3-prompt-${runNonce}`).slice(0, 16)}` }],
    }
    // A schema-valid but empty content array must not be read as "nothing to
    // apply": the capability is absent, so the field's presence alone decides.
    const emptySystemPrompt = { mode: 'append', content: [] }
    // The standard override mode is the representative "other advertised mode"
    // that a client might send; it must be refused exactly like append.
    const overrideSystemPrompt = { mode: 'override', content: [{ type: 'text', text: systemPrompt.content[0].text }] }
    const promptNew = await optional.request(7, 'session/new', { cwd: hostCwd, mcpServers: [], systemPrompt })
    assert(promptNew.error?.code === -32602
      && promptNew.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
    `B3-10: session/new must refuse an unadvertised systemPrompt: ${JSON.stringify(promptNew)}`)
    const promptResume = await optional.request(8, 'session/resume', {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: emptySystemPrompt,
    })
    assert(promptResume.error?.code === -32602
      && promptResume.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
    `B3-10: session/resume must refuse an unadvertised systemPrompt: ${JSON.stringify(promptResume)}`)
    const promptLoad = await optional.request(9, 'session/load', {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: overrideSystemPrompt,
    })
    assert(promptLoad.error?.code === -32602
      && promptLoad.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
    `B3-10: session/load must refuse an unadvertised systemPrompt: ${JSON.stringify(promptLoad)}`)
    assert(await optional.silent(200), 'B3-10: a refused session/load must not replay Session history')
    assert(JSON.stringify(eventsOf(sessionA)) === JSON.stringify(historyBefore),
      'B3-10: the refused requests must not alter sessionA durable records')
    const probeAfter = await control('probe', { sessionId: sessionA })
    const settingsAfter = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined
    assert(probeAfter.ok === true && probeAfter.agentId === sessionA,
      `B3-10: the after probe must resolve the same sessionA Agent: ${JSON.stringify(probeAfter)}`)
    assert(probeAfter.sessionCount === probeBefore.sessionCount && probeAfter.agentCount === probeBefore.agentCount,
      `B3-07: unsupported methods created a Host Session/Agent: ${JSON.stringify({ probeBefore, probeAfter })}`)
    assert(JSON.stringify(probeAfter.toolNames) === JSON.stringify(probeBefore.toolNames),
      'B3-10: the refused requests changed the target Agent tool roster')
    assert(settingsAfter === settingsBefore, 'B3-07: unsupported methods changed Settings')
    await assertSameHost(hostIdentity, 'B3-07 Host after unsupported methods')
    // B3-10 positive controls: `null` keeps the default instructions, and the
    // refused resume/load left no claim that could block a later normal attach.
    // A real attach may start catalog/plan delivery before its response, so the
    // positive requests tolerate only genuine notifications.
    const nullPromptNew = await optional.requestSkippingNotifications(10, 'session/new', { cwd: hostCwd, mcpServers: [], systemPrompt: null })
    assert(typeof nullPromptNew.result?.sessionId === 'string' && nullPromptNew.result.sessionId.length > 0,
      `B3-10: a null systemPrompt must keep the default create path: ${JSON.stringify(nullPromptNew)}`)
    const nullPromptClose = await optional.requestSkippingNotifications(11, 'session/close', { sessionId: nullPromptNew.result.sessionId })
    assert(JSON.stringify(nullPromptClose.result) === '{}',
      `B3-10: the null-prompt positive Session must close with {}: ${JSON.stringify(nullPromptClose)}`)
    const resumedA = await optional.requestSkippingNotifications(12, 'session/resume', { sessionId: sessionA, cwd: hostCwd, mcpServers: [] })
    assert(resumedA.error === undefined,
      `B3-10: the refused resume must leave no residual claim: ${JSON.stringify(resumedA)}`)
    const resumedClose = await optional.requestSkippingNotifications(13, 'session/close', { sessionId: sessionA })
    assert(JSON.stringify(resumedClose.result) === '{}',
      `B3-10: the no-residual-claim resume must close with {}: ${JSON.stringify(resumedClose)}`)
    optional.close()

    // B3-08: the packaged Host's real capability positive; the empty-View
    // negative is owned by the listener L5 contract test.
    assert(mainCaps.sessionCapabilities.resume !== undefined && mainCaps.sessionCapabilities.close !== undefined,
      'B3-08: the real Host must advertise both implemented Session capabilities')

    // B3-09: close this SDK connection, take the listener Off and On, keep the
    // same Host identity and resume the existing Session without replay.
    await main.client.request(acp.methods.agent.session.close, { sessionId: sessionB })
    for (const client of [...acpClients]) await closeAcp(client)
    for (const client of [...rawClients]) await client.close().catch(() => {})
    acpClients.length = 0
    rawClients.length = 0
    const disabled = await acpAccess(peer, 'B3-09 disable ACP', false)
    assert(disabled.ok === true && disabled.status?.state === 'disabled', `B3-09: ACP must disable: ${JSON.stringify(disabled)}`)
    for (let attempt = 0; attempt < 200 && existsSync(acpEndpoint.path); attempt += 1) await sleep(10)
    assert(!existsSync(acpEndpoint.path), 'B3-09: Off must retire the socket')
    const enabledAgain = await acpAccess(peer, 'B3-09 re-enable ACP', true)
    assert(enabledAgain.ok === true && enabledAgain.status?.state === 'enabled', `B3-09: ACP must re-enable: ${JSON.stringify(enabledAgain)}`)
    assert(existsSync(acpEndpoint.path), 'B3-09: On must rebind the socket')
    await assertSameHost(hostIdentity, 'B3-09 Host after Off/On')
    const resumedClient = await openAcp('B3-09 resumed SDK')
    const resumeStart = resumedClient.client.updates.length
    const resumed = await resumedClient.client.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: otherCwd })
    assert(resumed?.sessionId === undefined || resumed.sessionId === sessionA, `B3-09: resume result: ${JSON.stringify(resumed)}`)
    assert(!resumedClient.client.updates.slice(resumeStart).some(update => update.update?.sessionUpdate === 'agent_message_chunk'
      || update.update?.sessionUpdate === 'tool_call_update'),
    'B3-09: resume must not replay historical output')
    const resumedBefore = eventsOf(sessionA).length
    const resumedPrompt = await resumedClient.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: modelMarker }],
    })
    assert(resumedPrompt?.stopReason === 'end_turn', `B3-09: resumed Session prompt: ${JSON.stringify(resumedPrompt)}`)
    await waitForHostSessionEventAfter(dshHome, sessionA, resumedBefore,
      event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed', 'B3-09 resumed turn/end')
    assert(hostAssistantHasText(eventsOf(sessionA).slice(resumedBefore), modelAnswer), 'B3-09: resumed Session produced no Host answer')
    await resumedClient.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeAcp(resumedClient.client)
    acpClients.length = 0

    await assertSameHost(hostIdentity, 'B3 final Host identity')
    assert(hostIdentity.hostPid === (await scene.hostIdentityFacts(host)).hostPid, 'B3 final: Host identity changed')
    const peerExit = peer.exited ? undefined : await peer.shutdown()
    assert(peerExit === undefined || (peerExit.code === 0 && peerExit.signal === null), 'B3 final: peer must exit cleanly')
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0 && hostExit.signal === null, 'B3 final: Host must exit cleanly')
    await scene.awaitSceneSeatFree()
    assert(!existsSync(acpEndpoint.path), 'B3 final: the ACP socket must be gone after shutdown')
    const proof = readProof(join(b3WorkRoot, 'scoped-mcp-server.jsonl'))
    assert(proof.length === 0, 'B3 final: this case declares no MCP servers, so no child may start')

    const evidence = {
      schema: 'gacp1b-b3-v1-conformance/1',
      case_id: CASE_ID,
      platform: process.platform,
      candidate_sha256: context.candidateSha256,
      dsh_version: context.targetDshVersion,
      bundle_version: installation.manifest.version,
      sdk_version: installedSdkVersion(),
      host: { pid: hostIdentity.hostPid, instanceId: hostIdentity.instanceId, scopeId: hostIdentity.scopeId },
      protocol: {
        requestedVersions: [65535, 1],
        fallbackAnswer: PROTOCOL_VERSION,
        duplicateInitialize: duplicate.error?.data?.code,
      },
      capabilities: {
        loadSession: mainCaps.loadSession,
        authMethods: main.initialized.authMethods,
        resume: mainCaps.sessionCapabilities.resume,
        close: mainCaps.sessionCapabilities.close,
        image: mainCaps.promptCapabilities.image,
        audio: mainCaps.promptCapabilities.audio,
        embeddedContext: mainCaps.promptCapabilities.embeddedContext,
        mcpHttp: mainCaps.mcpCapabilities.http,
        mcpSse: mainCaps.mcpCapabilities.sse,
        clientExtrasDoNotChangeAgentCaps: true,
      },
      sessions: { A: sessionA, B: sessionB },
      unsupported: { list: listed.error?.code, load: loaded.error?.code, setMode: setMode.error?.code, unknown: unknownMethod.error?.code },
      notActive: {
        closedPrompt: { code: closedPrompt?.code, dataCode: closedPrompt?.data?.code, sessionId: closedPrompt?.data?.sessionId },
        foreignPrompt: { code: foreignPromptB?.code, dataCode: foreignPromptB?.data?.code, sessionId: foreignPromptB?.data?.sessionId },
        unknownResume: { code: unknownResume.error?.code, dataCode: unknownResume.error?.data?.code, sessionId: unknownResume.error?.data?.sessionId },
        unknownLoad: { code: unknownLoad.error?.code, dataCode: unknownLoad.error?.data?.code, sessionId: unknownLoad.error?.data?.sessionId },
        close: { exact: '{}', repeated: '{}', unknown: '{}' },
      },
      systemPrompt: {
        entries: ['new', 'resume', 'load'],
        modes: { new: 'append', resume: 'append-empty-content', load: 'override' },
        rpcCode: promptNew.error?.code,
        code: promptNew.error?.data?.code,
        nullAccepted: true,
        targetToolRoster: true,
        targetHistory: true,
        replay: false,
      },
      prompt: { stopReason: promptResult.stopReason, resourceLink: true, durableUserText: expectedUserText },
      close: { exact: '{}', repeated: '{}', unknown: '{}' },
      offOn: { sameHost: true, resumed: true, replay: false },
      quiesced: true,
      verdict: 'PASS',
    }
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      protocolFallback: true,
      preinitializeInvalidRequest: true,
      capabilitiesPositive: true,
      capabilitiesNegative: true,
      standardPrompt: promptResult.stopReason,
      closeIdempotent: true,
      offOnResume: true,
      quiesced: true,
      evidence,
    }
  } finally {
    for (const client of acpClients) {
      try { await client.close() } catch { /* already gone */ }
    }
    for (const client of rawClients) {
      try { await client.close() } catch { /* already gone */ }
    }
    for (const process of peers) {
      if (process.exited) continue
      try { await process.shutdown() } catch { /* runner backstop */ }
    }
    try { await scene.dispose() } catch { /* runner backstop */ }
    try { await scene.awaitSceneSeatFree().catch(() => {}) } catch { /* best effort */ }
  }
}
