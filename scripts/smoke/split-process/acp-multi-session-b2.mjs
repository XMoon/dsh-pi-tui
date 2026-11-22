/**
 * G-ACP1B/B2 — real packaged ACP same-connection multi-Session qualification.
 *
 * ONE real installed Split Host, one real TUI Client, ONE physical ACP v1 UDS
 * connection and the official `@agentclientprotocol/sdk` client. The TUI and
 * ACP borrow the same Host Session A; the same ACP connection creates a second
 * Session B and proves prompt/cancel/close/MCP routing per Session.
 *
 * Test stand-ins: the scripted offline model and the run-owned harmless stdio
 * MCP server installed by the existing C1 fixture. No production Host hook is
 * added.
 *
 * @module split-process/acp-multi-session-b2
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostAssistantHasText, hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.multi-session-b2'
const ECHO_TOOL = 'mcp__b1scope__echo'
const MODEL_PROVIDER = 'c1-qualification'
const EXTRA_MODEL = 'c1-model-b'

/** The opaque ACP model select value of one exact route. */
function modelValue(modelId) {
  return JSON.stringify([MODEL_PROVIDER, modelId])
}

/** The current standard model config option. */
function modelConfigOption(configOptions) {
  return configOptions?.find(candidate => candidate.id === 'model')
}

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

function eventData(event) {
  return event?.data ?? {}
}

function toolResultText(event) {
  const content = eventData(event).message?.content
  if (!Array.isArray(content)) return ''
  return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
}

function toolResultCode(event) {
  return eventData(event).error?.code
}

function toolCallIdOf(event) {
  return String(eventData(event).callId ?? '')
}

function toolResultCallIdOf(event) {
  return String(eventData(event).message?.toolCallId ?? '')
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

function alivePid(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForGone(pid, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!alivePid(pid)) return true
    await sleep(25)
  }
  return !alivePid(pid)
}

/** One real ACP v1 client owned by the official public SDK. */
async function openSdkClient(endpoint, onUpdate, onPermission) {
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
  const app = acp.client({ name: 'b2-multi-session-qualification' })
  if (onUpdate !== undefined) app.onNotification(acp.methods.client.session.update, ({ params }) => { onUpdate(params) })
  if (onPermission !== undefined) {
    app.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => await onPermission(params))
  }
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

async function expectRequestError(promise, code, label) {
  try {
    await promise
  } catch (error) {
    assert(error?.data?.code === code, `${label}: expected ${code}, got ${JSON.stringify({ code: error?.code, data: error?.data })}`)
    return error
  }
  throw new SplitSmokeAssertionError(`${label}: request unexpectedly succeeded`)
}

export async function runAcpMultiSessionB2(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context, { scopedMcpB1: true })
  if (typeof scene.c1Work.scopedMcpServerPath !== 'string') {
    throw new SplitSmokeAssertionError(`${CASE_ID}: the stdio MCP server fixture was not installed into the isolated profile`)
  }
  const b2WorkRoot = scene.c1WorkRoot('b2')
  const controlPath = join(b2WorkRoot, 'b1-control.json')
  const proofPath = join(b2WorkRoot, 'scoped-mcp-server.jsonl')
  const longTurnRelease = join(b2WorkRoot, 'b1-long-turn-release')
  const runNonce = `b2-run-${digestOf(`${process.pid}-${Date.now()}`).slice(0, 16)}`
  const workspace = join(workDir, 'b2-workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const hostCwd = realpathSync(workspace)
  const otherCwd = join(workDir, 'b2-other-cwd')
  mkdirSync(otherCwd, { recursive: true, mode: 0o700 })

  const peers = []
  const acpClients = []
  const serverPids = new Set()
  let host
  let hostIdentity
  let peer
  let tui
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
    const requestId = `b2-acp-access-${String(++sequence)}-${String(process.pid)}`
    process.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return await process.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const control = async (action, fields = {}) => {
    const actionId = `b2-action-${String(++actionSequence)}-${String(process.pid)}`
    const temporary = `${controlPath}.tmp-${actionId}`
    writeFileSync(temporary, JSON.stringify({ actionId, action, ...fields }), { mode: 0o600 })
    renameSync(temporary, controlPath)
    return await waitForC1WorkEvent(b2WorkRoot, event => event.kind === 'b1-fact' && event.actionId === actionId,
      `${CASE_ID} control ${action}`, 180_000)
  }
  const openNewTuiSession = async (client, label) => {
    client.send('/new\r')
    const status = await waitForSurfaceStatus(client, record => record.sessionOpen === true
      && typeof record.openSessionId === 'string'
      && record.openSessionId !== ''
      && record.surfaceMounted === true
      && record.transport === 'connected', `${label} Session open`, 180_000)
    return status.openSessionId
  }
  const sendTuiPrompt = async (client, text, label) => {
    client.send(`${text}\r`)
    await client.waitForScreen(text.slice(0, Math.min(32, text.length)), `${label} prompt painted`, 120_000)
  }
  const eventsOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const waitForTurnEnd = async (sessionId, afterIndex, label) =>
    await waitForHostSessionEventAfter(dshHome, sessionId, afterIndex, event => event.type === 'turn/end', label)
  const modelRecords = (sessionId, marker) => readC1WorkEvents(b2WorkRoot)
    .filter(event => event.kind === 'b1-model-tools' && event.sessionId === sessionId && event.marker === marker)
  const mcpDeclaration = (tag = 'b1scope') => ({
    name: tag,
    command: process.execPath,
    args: [scene.c1Work.scopedMcpServerPath],
    env: [
      { name: 'B0_FIXTURE_PROOF', value: proofPath },
      { name: 'B0_SERVER_TAG', value: tag },
      { name: 'B0_RUN_NONCE', value: runNonce },
    ],
  })
  const openAcp = async (label, onUpdate, onPermission) => {
    const client = await openSdkClient(acpEndpoint, onUpdate, onPermission)
    acpClients.push(client)
    const initialized = await client.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    assert(initialized?.protocolVersion === 1, `${label}: initialize must answer protocolVersion 1`)
    return { client, initialized }
  }
  const closeAcp = async client => { await client.close().catch(() => {}) }
  const resumeWhenAttachable = async (client, params, label = 'resume') => {
    const started = Date.now()
    for (;;) {
      try {
        return await client.request(acp.methods.agent.session.resume, params)
      } catch (error) {
        if (error?.data?.code !== 'LOCAL_ACP_VIEW_ALREADY_ATTACHED') throw error
        if (Date.now() - started > 30_000) throw error
        await sleep(50)
      }
    }
  }
  const readUpdates = updates => updates.slice()
  const assertOnlySession = (updates, sessionId, label) => {
    for (const update of updates) assert(update.sessionId === sessionId, `${label}: cross-Session update ${JSON.stringify(update)}`)
  }

  try {
    const started = await scene.startC1Host('acp-scoped-mcp-b1', 'b2 host', {
      C1_B1_CONTROL: controlPath,
      C1_HOLD_LONG_TURN: longTurnRelease,
      C1_EXTRA_MODEL: EXTRA_MODEL,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    }, b2WorkRoot)
    host = started.host
    const ready = started.ready
    hostIdentity = await hostIdentityFacts()
    assert(typeof ready.localHost?.scopeId === 'string' && ready.localHost.scopeId.length === 64, 'B2-01: Host Ready must publish the scope id')
    assert(/^[0-9a-f]{64}$/u.test(context.candidateSha256), 'B2-01: candidate SHA256 must be a real digest')
    peer = await startPeer('b2 peer')
    const initialAccess = await acpAccess(peer, 'B2-01 initial ACP status', undefined)
    assert(initialAccess.ok === true && initialAccess.status?.state === 'disabled', `B2-01: ACP must start disabled: ${JSON.stringify(initialAccess)}`)
    const enabledAccess = await acpAccess(peer, 'B2-01 enable ACP', true)
    assert(enabledAccess.ok === true && enabledAccess.status?.state === 'enabled', `B2-01: ACP must enable: ${JSON.stringify(enabledAccess)}`)
    const status = daemonStatus('B2-01 daemon status')
    assert(status.host === 'ready' && status.acp === 'enabled', `B2-01: daemon status: ${JSON.stringify(status)}`)
    const expectedSocket = process.platform === 'darwin'
      ? `/private/tmp/dpt-${String(process.getuid())}-${ready.localHost.scopeId.slice(0, 40)}/acp.sock`
      : join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'acp.sock')
    assert(status['acp-socket'] === expectedSocket, `B2-01: daemon status endpoint: ${JSON.stringify(status)}`)
    acpEndpoint = process.platform === 'darwin'
      ? { path: status['acp-socket'] }
      : { path: expectedSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId) }
    trace('acp-multi-session-b2/b2-01', { candidateSha256: context.candidateSha256, hostPid: hostIdentity.hostPid, scopeId: ready.localHost.scopeId })

    const tuiStarted = await scene.startC1Client('b2 tui', {}, { cwd: hostCwd })
    tui = tuiStarted.client
    sessionA = await openNewTuiSession(tui, 'B2-02 tui A')
    assert(typeof sessionA === 'string' && sessionA.length > 0, 'B2-02: the TUI Session must be real')

    const updatesA = []
    const updatesB = []
    const permissionRequests = []
    const acpMain = await openAcp('B2-01', params => {
      if (params?.sessionId === sessionA) updatesA.push(params)
      else if (params?.sessionId === sessionB) updatesB.push(params)
    }, async params => {
      permissionRequests.push(params)
      return { outcome: { outcome: 'selected', optionId: params.sessionId === sessionA ? 'allow-once' : 'reject-once' } }
    })
    assert(acpMain.initialized.agentCapabilities?.loadSession === false, 'B2-01: loadSession must stay false')
    assert(acpMain.initialized.agentCapabilities?.sessionCapabilities?.resume !== undefined
      && acpMain.initialized.agentCapabilities?.sessionCapabilities?.close !== undefined,
    'B2-01: resume/close capabilities must be advertised')
    assert(acpMain.initialized.agentCapabilities?.mcpCapabilities?.http === false
      && acpMain.initialized.agentCapabilities?.mcpCapabilities?.sse === false,
    'B2-01: http/sse MCP capabilities must stay false')

    // B2-02/B2-12: resume the live TUI Session A with a DIFFERENT absolute
    // request cwd on the SAME physical SDK connection, then create B on it.
    const updatesBeforeResumeA = updatesA.length
    const resumedA = await resumeWhenAttachable(acpMain.client, { sessionId: sessionA, cwd: otherCwd, mcpServers: [mcpDeclaration()] })
    assert(resumedA?.sessionId === undefined || resumedA.sessionId === sessionA, `B2-02: resume A: ${JSON.stringify(resumedA)}`)
    assert(!updatesA.slice(updatesBeforeResumeA).some(update => update.update?.sessionUpdate === 'agent_message_chunk'
      || update.update?.sessionUpdate === 'tool_call_update'),
    'B2-12: lenient resume must not replay historical assistant/tool updates')
    const createdB = await acpMain.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    sessionB = createdB?.sessionId
    assert(typeof sessionB === 'string' && sessionB !== sessionA, `B2-02: second Session id: ${JSON.stringify(createdB)}`)
    const probeA = await control('probe', { sessionId: sessionA })
    const probeB = await control('probe', { sessionId: sessionB })
    assert(probeA.ok === true && Array.isArray(probeA.toolNames) && probeA.toolNames.includes(ECHO_TOOL),
      `B2-09: A must own the scoped MCP tool: ${JSON.stringify(probeA)}`)
    assert(probeB.ok === true && Array.isArray(probeB.toolNames) && !probeB.toolNames.includes(ECHO_TOOL),
      `B2-09: B must not own A's scoped MCP tool: ${JSON.stringify(probeB)}`)
    assert(probeA.hostPid === hostIdentity.hostPid && probeB.hostPid === hostIdentity.hostPid,
      'B2-02: both Sessions must live in the ONE Host PID')
    assert(probeA.sessionCount >= 2, `B2-02: two Host Sessions must exist: ${JSON.stringify({ A: probeA, B: probeB })}`)
    assert(probeA.sessionId === sessionA && probeB.sessionId === sessionB, 'B2-02: distinct exact Host Sessions')
    assert(typeof probeA.agentId === 'string' && typeof probeB.agentId === 'string' && probeA.agentId !== probeB.agentId,
      `B2-02: each Session must own a distinct exact Agent: ${JSON.stringify({ A: probeA.agentId, B: probeB.agentId })}`)

    // B2-08: the second Session owns its model selection independently. The
    // official Host commits B's config write and emits the full standard update
    // on this same ACP connection; A's route is never touched.
    const bModel = modelConfigOption(createdB.configOptions)
    assert(bModel !== undefined && Array.isArray(bModel.options)
      && bModel.options.flatMap(group => group.options ?? []).some(option => option.value === modelValue(EXTRA_MODEL)),
    `B2-08: B must advertise the extra model: ${JSON.stringify(createdB.configOptions)}`)
    const beforeModelB = eventsOf(sessionB).length
    const setModelB = await acpMain.client.request(acp.methods.agent.session.setConfigOption, {
      sessionId: sessionB, configId: 'model', value: modelValue(EXTRA_MODEL),
    })
    assert(modelConfigOption(setModelB?.configOptions)?.currentValue === modelValue(EXTRA_MODEL),
      `B2-08: B model write: ${JSON.stringify(setModelB)}`)
    await waitForHostSessionEventAfter(dshHome, sessionB, beforeModelB,
      event => event.type === 'model/selection' && event.data?.provider === MODEL_PROVIDER && event.data?.model === EXTRA_MODEL,
      'B2-08 B durable model selection')
    let configNotified = false
    for (let attempt = 0; attempt < 200 && !configNotified; attempt += 1) {
      configNotified = readUpdates(updatesB).some(update => update.update?.sessionUpdate === 'config_option_update'
        && modelConfigOption(update.update?.configOptions)?.currentValue === modelValue(EXTRA_MODEL))
      if (!configNotified) await sleep(10)
    }
    assert(configNotified, 'B2-08: B must receive its own config option update')
    assert(!readUpdates(updatesA).some(update => update.update?.sessionUpdate === 'config_option_update'
      && modelConfigOption(update.update?.configOptions)?.currentValue === modelValue(EXTRA_MODEL)),
    'B2-08: B model update must never reach A')

    // B2-14: the physical connection owns exactly eight live View slots. Six
    // additional Sessions fill A/B's roster; the ninth is refused before any
    // Host create, and a settled close makes the slot reusable.
    const extraSessions = []
    for (let index = 0; index < 6; index += 1) {
      const extra = await acpMain.client.request(acp.methods.agent.session.new, {
        cwd: hostCwd, mcpServers: [],
      })
      assert(typeof extra?.sessionId === 'string', `B2-14: extra Session ${String(index)}: ${JSON.stringify(extra)}`)
      extraSessions.push(extra.sessionId)
    }
    const beforeNinth = await control('probe')
    await expectRequestError(
      acpMain.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] }),
      'LOCAL_ACP_VIEW_BUSY',
      'B2-14 ninth View',
    )
    const afterNinth = await control('probe')
    assert(afterNinth.sessionCount === beforeNinth.sessionCount,
      `B2-14: the ninth View must create no Host Session: ${JSON.stringify({ before: beforeNinth, after: afterNinth })}`)
    const closedExtra = await acpMain.client.request(acp.methods.agent.session.close, { sessionId: extraSessions[0] })
    assert(JSON.stringify(closedExtra) === '{}', 'B2-14: an extra View must close normally')
    const reused = await acpMain.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    assert(typeof reused?.sessionId === 'string' && !extraSessions.includes(reused.sessionId) && reused.sessionId !== sessionA && reused.sessionId !== sessionB,
      `B2-14: a freed slot must admit the ninth View: ${JSON.stringify(reused)}`)
    await acpMain.client.request(acp.methods.agent.session.close, { sessionId: reused.sessionId })
    for (const sessionId of extraSessions.slice(1)) {
      assert(JSON.stringify(await acpMain.client.request(acp.methods.agent.session.close, { sessionId })) === '{}',
        `B2-14: extra Session ${sessionId} must close without affecting A/B`)
    }

    // B2-03: A and B prompts are independent and their notifications stay on
    // their own sessionId. A mounts the real MCP echo tool; B gets UNKNOWN_TOOL.
    const beforeA = eventsOf(sessionA).length
    const beforeB = eventsOf(sessionB).length
    const promptA = acpMain.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: `B1_ECHO_A ${digestOf(`b2-a-${runNonce}`).slice(0, 16)}` }],
    })
    const promptB = acpMain.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionB,
      prompt: [{ type: 'text', text: `B1_ECHO_B ${digestOf(`b2-b-${runNonce}`).slice(0, 16)}` }],
    })
    const [resultA, resultB] = await Promise.all([promptA, promptB])
    assert(resultA?.stopReason === 'end_turn', `B2-03: A prompt: ${JSON.stringify(resultA)}`)
    assert(resultB?.stopReason === 'end_turn', `B2-03: B prompt: ${JSON.stringify(resultB)}`)
    await waitForTurnEnd(sessionA, beforeA, 'B2-03 A turn/end')
    await waitForTurnEnd(sessionB, beforeB, 'B2-03 B turn/end')
    const eventsA = eventsOf(sessionA).slice(beforeA)
    const eventsB = eventsOf(sessionB).slice(beforeB)
    const callA = eventsA.find(event => event.type === 'tool/call' && eventData(event).name === ECHO_TOOL)
    const callB = eventsB.find(event => event.type === 'tool/call' && eventData(event).name === ECHO_TOOL)
    assert(callA !== undefined, 'B2-03/B2-09: A must execute the real scoped MCP tool')
    assert(callB !== undefined, 'B2-03: B must attempt the same public tool name')
    const resultATool = eventsA.find(event => event.type === 'tool/result' && toolResultCallIdOf(event) === toolCallIdOf(callA))
    const resultBTool = eventsB.find(event => event.type === 'tool/result' && toolResultCallIdOf(event) === toolCallIdOf(callB))
    assert(resultATool !== undefined && eventData(resultATool).message?.isError !== true && toolResultText(resultATool).includes('b0-echo:'),
      `B2-09: A real MCP result: ${JSON.stringify(resultATool === undefined ? null : toolResultText(resultATool))}`)
    assert(resultBTool !== undefined && eventData(resultBTool).message?.isError === true && toolResultCode(resultBTool) === 'UNKNOWN_TOOL',
      `B2-09: B unscoped tool must be UNKNOWN_TOOL: ${JSON.stringify(resultBTool === undefined ? null : { code: toolResultCode(resultBTool) })}`)
    assert(hostAssistantHasText(eventsA, 'B1_ECHO_A settled'), 'B2-03: A assistant output missing')
    assert(hostAssistantHasText(eventsB, 'B1_ECHO_B settled'), 'B2-03: B assistant output missing')
    assert(modelRecords(sessionA, 'B1_ECHO_A').some(record => record.hasEchoTool === true), 'B2-09: A model step must see its scoped MCP tool')
    assert(modelRecords(sessionB, 'B1_ECHO_B').every(record => record.hasEchoTool === false), 'B2-09: B model step must not see A tool')
    assertOnlySession(readUpdates(updatesA), sessionA, 'B2-03 A updates')
    assertOnlySession(readUpdates(updatesB), sessionB, 'B2-03 B updates')
    await assertSameHost(hostIdentity, 'B2-03 Host after two prompts')

    // B2-07: each Session's own reverse permission request carries its exact
    // sessionId/toolCallId; the socket-level callback answers only that request.
    const permissionPromptA = acpMain.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: `B1_APPROVAL_A ${digestOf(`b2-permission-a-${runNonce}`).slice(0, 16)}` }],
    })
    const permissionPromptB = acpMain.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionB, prompt: [{ type: 'text', text: `B1_APPROVAL_B ${digestOf(`b2-permission-b-${runNonce}`).slice(0, 16)}` }],
    })
    const [permissionResultA, permissionResultB] = await Promise.all([permissionPromptA, permissionPromptB])
    assert(permissionResultA?.stopReason === 'end_turn' && permissionResultB?.stopReason === 'end_turn',
      `B2-07: permission prompts: ${JSON.stringify({ A: permissionResultA, B: permissionResultB })}`)
    assert(permissionRequests.length === 2, `B2-07: expected two reverse requests: ${JSON.stringify(permissionRequests)}`)
    const permissionSessions = permissionRequests.map(request => request.sessionId).sort()
    assert(JSON.stringify(permissionSessions) === JSON.stringify([sessionA, sessionB].sort()),
      `B2-07: reverse requests must name exactly A and B: ${JSON.stringify(permissionRequests.map(request => request.sessionId))}`)
    assert(permissionRequests[0].toolCall?.toolCallId !== permissionRequests[1].toolCall?.toolCallId,
      'B2-07: each Session must receive its own toolCallId')

    // B2-04: close A; B keeps running and can complete another turn. Repeated
    // and unknown closes are empty `{}` with no Host side effect.
    const closeA = await acpMain.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(closeA) === '{}', `B2-04: first A close: ${JSON.stringify(closeA)}`)
    const probeBeforeUnknown = await control('probe')
    const closeAgainA = await acpMain.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(closeAgainA) === '{}', 'B2-04: repeated A close must stay idempotent')
    const unknownClose = await acpMain.client.request(acp.methods.agent.session.close, { sessionId: 'b2-unknown-session' })
    assert(JSON.stringify(unknownClose) === '{}', 'B2-04: unknown close must return {}')
    const probeAfterUnknown = await control('probe')
    assert(probeAfterUnknown.agentCount === probeBeforeUnknown.agentCount
      && probeAfterUnknown.sessionCount === probeBeforeUnknown.sessionCount,
    `B2-04: unknown close must not create/destroy Host Sessions: ${JSON.stringify({ before: probeBeforeUnknown, after: probeAfterUnknown })}`)
    const beforeBPlain = eventsOf(sessionB).length
    const plainB = await acpMain.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionB, prompt: [{ type: 'text', text: `B1_PLAIN_B ${digestOf(`b2-plain-b-${runNonce}`).slice(0, 16)}` }],
    })
    assert(plainB?.stopReason === 'end_turn', `B2-04: B must keep working after A close: ${JSON.stringify(plainB)}`)
    await waitForTurnEnd(sessionB, beforeBPlain, 'B2-04 B turn/end')
    assert(hostAssistantHasText(eventsOf(sessionB).slice(beforeBPlain), 'B1_PLAIN_B settled'), 'B2-04: B plain answer missing')
    assert((await hostIdentityFacts()).hostPid === hostIdentity.hostPid, 'B2-04: A close must not replace the Host')

    // B2-06: a held B turn is cancelled only on B; the TUI A prompt still settles.
    const beforeHeldB = eventsOf(sessionB).length
    const heldB = acpMain.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionB, prompt: [{ type: 'text', text: `B1_HOLD_B ${digestOf(`b2-hold-${runNonce}`).slice(0, 16)}` }],
    })
    await waitForC1WorkEvent(b2WorkRoot, event => event.kind === 'b1-long-turn-held' && event.sessionId === sessionB,
      'B2-06 B held turn', 60_000)
    await acpMain.client.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: sessionB })
    writeFileSync(longTurnRelease, 'released\n', { mode: 0o600 })
    let cancelledB
    try { cancelledB = await heldB } catch (error) { throw new SplitSmokeAssertionError(`B2-06: B cancel failed: ${String(error?.message ?? error)}`) }
    assert(cancelledB?.stopReason === 'cancelled', `B2-06: B held prompt must settle cancelled: ${JSON.stringify(cancelledB)}`)
    await waitForTurnEnd(sessionB, beforeHeldB, 'B2-06 B turn/end')
    const beforeTuiAfterCancel = eventsOf(sessionA).length
    await sendTuiPrompt(tui, `B1_PLAIN_A ${digestOf(`b2-tui-${runNonce}`).slice(0, 16)}`, 'B2-06 tui A')
    await waitForTurnEnd(sessionA, beforeTuiAfterCancel, 'B2-06 TUI A turn/end')
    assert(hostAssistantHasText(eventsOf(sessionA).slice(beforeTuiAfterCancel), 'b1 plain settled'), 'B2-06: TUI A must continue after B cancel')

    // B2-10: Off releases the remaining B view; On reuses the SAME registry and
    // admits a fresh view for B (A is detached and may be resumed anew).
    const disabled = await acpAccess(peer, 'B2-10 disable ACP', false)
    assert(disabled.ok === true && disabled.status?.state === 'disabled', `B2-10: ACP must disable: ${JSON.stringify(disabled)}`)
    await acpMain.client.close().catch(() => {})
    const enabledAgain = await acpAccess(peer, 'B2-10 re-enable ACP', true)
    assert(enabledAgain.ok === true && enabledAgain.status?.state === 'enabled', `B2-10: ACP must re-enable: ${JSON.stringify(enabledAgain)}`)
    const acpOn = await openAcp('B2-10')
    const resumedB = await resumeWhenAttachable(acpOn.client, { sessionId: sessionB, cwd: hostCwd })
    assert(resumedB?.sessionId === undefined || resumedB.sessionId === sessionB, `B2-10: B must resume after Off/On: ${JSON.stringify(resumedB)}`)
    await acpOn.client.request(acp.methods.agent.session.close, { sessionId: sessionB })

    // B2-13: another connection must still respect the one-ACP-View rule.
    const acpOther = await openAcp('B2-13')
    const resumedAOnOn = await resumeWhenAttachable(acpOn.client, { sessionId: sessionA, cwd: hostCwd })
    assert(resumedAOnOn?.sessionId === undefined || resumedAOnOn.sessionId === sessionA, 'B2-13: A must be attachable after A close')
    await expectRequestError(
      acpOther.client.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd }),
      'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
      'B2-13 second connection A',
    )
    await acpOn.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeAcp(acpOther.client)
    await closeAcp(acpOn.client)

    // B2-04 TUI survives every ACP detachment and remains the same Session.
    await assertSameHost(hostIdentity, 'B2 final Host identity')
    assert((await scene.hostIdentityFacts(host)).hostPid === hostIdentity.hostPid, 'B2 final: Host identity changed')

    await scene.exitC1Client(tui, 'B2 exit tui')
    for (const client of acpClients) await closeAcp(client)
    const peerExit = peer.exited ? undefined : await peer.shutdown()
    assert(peerExit === undefined || (peerExit.code === 0 && peerExit.signal === null), 'B2 final: peer must exit cleanly')
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0 && hostExit.signal === null, 'B2 final: Host must exit cleanly')
    await scene.awaitSceneSeatFree()
    assert(!existsSync(acpEndpoint.path), 'B2 final: the ACP socket must be gone after shutdown')
    const proofFinal = readProof(proofPath)
    for (const pid of serverPids) assert(!alivePid(pid), `B2 final: MCP child ${String(pid)} must not survive`)
    const childPids = proofFinal.filter(line => line.kind === 'server-start' && line.tag === 'b1scope').map(line => line.pid)
    for (const pid of childPids) {
      assert(await waitForGone(pid), `B2 final: MCP child ${String(pid)} must not survive`)
    }
    const evidence = {
      schema: 'gacp1b-b2-session-multiplex/1',
      case_id: CASE_ID,
      platform: process.platform,
      candidate_sha256: context.candidateSha256,
      dsh_version: context.targetDshVersion,
      bundle_version: installation.manifest.version,
      host: { pid: hostIdentity.hostPid, instanceId: hostIdentity.instanceId, scopeId: hostIdentity.scopeId },
      sessions: { A: sessionA, B: sessionB },
      socket: { path: acpEndpoint.path, initializedOnce: true, sameConnectionAandB: true },
      routing: { sameHostPid: true, distinctSessionIds: true, promptA: resultA.stopReason, promptB: resultB.stopReason },
      permissions: { requests: permissionRequests.length, scoped: true },
      close: { a: '{}', repeatedA: '{}', unknown: '{}', bAfterA: plainB.stopReason },
      cancel: { b: cancelledB.stopReason, tuiA: 'end_turn' },
      mcp: { aTool: ECHO_TOOL, aResult: true, bUnknownTool: true, childPids },
      offOn: { reusedRegistry: true, restoredSessionB: true },
      quiesced: true,
      verdict: 'PASS',
    }
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      sameConnectionAandB: true,
      sameHostPid: true,
      promptA: resultA.stopReason,
      promptB: resultB.stopReason,
      closeA: '{}',
      unknownClose: '{}',
      mcpIsolation: true,
      cancelB: cancelledB.stopReason,
      permissionsScoped: true,
      tuiContinues: true,
      offOnReusedRegistry: true,
      quiesced: true,
      evidence,
    }
  } finally {
    try { writeFileSync(longTurnRelease, 'released\n', { mode: 0o600 }) } catch { /* best effort */ }
    for (const client of acpClients) {
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
