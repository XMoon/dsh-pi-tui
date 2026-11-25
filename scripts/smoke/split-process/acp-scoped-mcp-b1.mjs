/**
 * G-ACP1B/B1 — real packaged ACP stdio MCP production qualification.
 *
 * ONE real installed Split Host, two real TUI Sessions (A/B), one real Host ACP
 * v1 UDS front door and the OFFICIAL `@deepseek-ai/dsh-mcp-client` mounted by
 * the PRODUCTION View from `session/new|resume.mcpServers`. No test fixture
 * mounts or retires an MCP Fiber: the smoke only supplies a harmless stdio
 * server, an offline model and a small global-shadow/probe control.
 *
 * Covered from real source to real sink: standard ACP declaration validation,
 * exact-Session cwd, Agent-local tool visibility, a real model `tools/call`,
 * global-shadow rejection, create-succeeded/mount-failed session identity,
 * Close/EOF/Off retirement deferred behind a live TUI tool, and quiescence.
 *
 * @module split-process/acp-scoped-mcp-b1
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
import { startScopedMcpHttpServer } from '../../fixtures/scoped-mcp-http-server.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.scoped-mcp-b1'
const ECHO_TOOL = 'mcp__b1scope__echo'
const HOLD_TOOL = 'mcp__b1scope__hold'
const FAIL_TOOL = 'mcp__b1scope__fail'
const GLOBAL_MARKER = 'GLOBAL_ONLY'

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

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
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

function countServerCalls(proof, tag) {
  return proof.filter(line => line.kind === 'tools/call' && line.tag === tag).length
}

async function waitForProof(predicate, path, label, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const match = readProof(path).find(predicate)
    if (match !== undefined) return match
    await sleep(25)
  }
  throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for ${label}`)
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
async function openSdkClient(endpoint) {
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
  const stream = acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket))
  const updates = []
  const app = acp.client({ name: 'b1-scoped-mcp-qualification' })
  app.onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const connection = app.connect(stream)
  return {
    connection,
    socket,
    socketClosed,
    updates,
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

/** Assert one rejected ACP request carries the exact stable data code. */
async function expectRequestError(promise, code, label) {
  try {
    await promise
  } catch (error) {
    assert(error?.data?.code === code, `${label}: expected ${code}, got ${JSON.stringify({ code: error?.code, data: error?.data })}`)
    return error
  }
  throw new SplitSmokeAssertionError(`${label}: request unexpectedly succeeded`)
}

export async function runAcpScopedMcpB1(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context, { scopedMcpB1: true })
  if (typeof scene.c1Work.scopedMcpServerPath !== 'string') {
    throw new SplitSmokeAssertionError(`${CASE_ID}: the B1 MCP server fixture was not installed into the isolated profile`)
  }
  const b1WorkRoot = scene.c1WorkRoot('b1')
  const controlPath = join(b1WorkRoot, 'b1-control.json')
  const proofPath = join(b1WorkRoot, 'scoped-mcp-server.jsonl')
  const holdArm = join(b1WorkRoot, 'b1-hold-arm')
  const holdRelease = join(b1WorkRoot, 'b1-hold-release')
  const longTurnRelease = join(b1WorkRoot, 'b1-long-turn-release')
  const runNonce = `b1-run-${digestOf(`${process.pid}-${Date.now()}`).slice(0, 16)}`
  const workspace = join(workDir, 'b1-workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const hostCwd = realpathSync(workspace)
  const otherCwd = join(workDir, 'b1-other-cwd')
  mkdirSync(otherCwd, { recursive: true, mode: 0o700 })

  const peers = []
  const acpClients = []
  const httpFixtures = []
  const serverPids = new Set()
  let host
  let hostIdentity
  let peer
  let tuiA
  let tuiB
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
    const requestId = `b1-acp-access-${String(++sequence)}-${String(process.pid)}`
    process.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return await process.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const control = async (action, fields = {}) => {
    const actionId = `b1-action-${String(++actionSequence)}-${String(process.pid)}`
    const temporary = `${controlPath}.tmp-${actionId}`
    writeFileSync(temporary, JSON.stringify({ actionId, action, ...fields }), { mode: 0o600 })
    renameSync(temporary, controlPath)
    return await waitForC1WorkEvent(b1WorkRoot, event => event.kind === 'b1-fact' && event.actionId === actionId,
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
  const surfaceSessionId = client => (client.records.filter(record => record.m4b2s === 'surface-status').at(-1))?.openSessionId
  const sendTuiPrompt = async (client, text, label) => {
    client.send(`${text}\r`)
    await client.waitForScreen(text.slice(0, Math.min(32, text.length)), `${label} prompt painted`, 120_000)
  }
  const eventsOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const waitForEvent = async (sessionId, afterIndex, predicate, label, timeoutMs = 180_000) =>
    await waitForHostSessionEventAfter(dshHome, sessionId, afterIndex, predicate, label, timeoutMs)
  const waitForTurnEnd = async (sessionId, afterIndex, label) =>
    await waitForEvent(sessionId, afterIndex, event => event.type === 'turn/end', label)
  const sessionEventsAfter = (sessionId, index) => eventsOf(sessionId).slice(index)
  const findToolCall = (events, name) => events.find(event => event.type === 'tool/call' && eventData(event).name === name)
  const findToolResult = (events, callId) => events.find(event => event.type === 'tool/result' && toolResultCallIdOf(event) === callId)
  const modelRecords = (sessionId, marker) => readC1WorkEvents(b1WorkRoot)
    .filter(event => event.kind === 'b1-model-tools' && event.sessionId === sessionId && event.marker === marker)

  const mcpDeclaration = (tag = 'b1scope', extraEnv = {}, name = tag) => ({
    name,
    command: process.execPath,
    args: [scene.c1Work.scopedMcpServerPath],
    env: [
      { name: 'B0_FIXTURE_PROOF', value: proofPath },
      { name: 'B0_SERVER_TAG', value: tag },
      { name: 'B0_HOLD_ARM', value: holdArm },
      { name: 'B0_HOLD_RELEASE', value: holdRelease },
      { name: 'B0_RUN_NONCE', value: runNonce },
      ...Object.entries(extraEnv).map(([name, value]) => ({ name, value })),
    ],
  })
  const httpHeaders = () => [
    { name: 'Authorization', value: `Bearer ${runNonce}` },
    { name: 'X-API-Key', value: `b1-http-key-${runNonce}` },
  ]
  const httpDeclaration = (name, url) => ({ name, type: 'http', url, headers: httpHeaders() })
  const startHttpFixture = async label => {
    const fixture = await startScopedMcpHttpServer({
      tag: `b1http-${label}`,
      expectedHeaders: {
        Authorization: `Bearer ${runNonce}`,
        'X-API-Key': `b1-http-key-${runNonce}`,
      },
    })
    httpFixtures.push(fixture)
    return fixture
  }
  const liveProbe = async (sessionId, label) => {
    const probe = await control('probe', { sessionId })
    assert(probe.ok === true && probe.agentId === sessionId,
      `${label}: probe must resolve the exact live Agent ${sessionId}: ${JSON.stringify(probe)}`)
    return probe
  }
  const waitToolPresent = async (sessionId, names, label, timeoutMs = 60_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const probe = await liveProbe(sessionId, label)
      if (Array.isArray(probe.toolNames) && names.every(name => probe.toolNames.includes(name))) return probe
      await sleep(50)
    }
    throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for MCP tool presence (${label})`)
  }
  const waitToolAbsent = async (sessionId, label, names = [ECHO_TOOL], timeoutMs = 60_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const probe = await liveProbe(sessionId, label)
      if (Array.isArray(probe.toolNames) && names.every(name => !probe.toolNames.includes(name))) return probe
      await sleep(50)
    }
    throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for MCP tool absence (${label})`)
  }

  const waitForRequestAfter = async (fixture, beforeCount, predicate, label, timeoutMs = 60_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const found = fixture.requests.slice(beforeCount).find(predicate)
      if (found !== undefined) return found
      await sleep(25)
    }
    throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for ${label}`)
  }
  const openAcp = async label => {
    const client = await openSdkClient(acpEndpoint)
    acpClients.push(client)
    const initialized = await client.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    assert(initialized?.protocolVersion === 1, `${label}: initialize must answer protocolVersion 1`)
    return { client, initialized }
  }
  const closeAcp = async client => {
    await client.close().catch(() => {})
  }
  const lifecycleWhenAttachable = async (handle, method, params, label) => {
    const client = handle.client ?? handle
    const started = Date.now()
    for (;;) {
      try {
        return await client.request(method, params)
      } catch (error) {
        if (error?.data?.code !== 'LOCAL_ACP_VIEW_ALREADY_ATTACHED') throw error
        if (Date.now() - started > 30_000) throw error
        await sleep(50)
      }
    }
  }
  const resumeWhenAttachable = async (handle, params, label = 'resume') =>
    await lifecycleWhenAttachable(handle, acp.methods.agent.session.resume, params, label)
  const loadWhenAttachable = async (handle, params, label = 'load') =>
    await lifecycleWhenAttachable(handle, acp.methods.agent.session.load, params, label)
  const waitForClientUpdate = async (client, predicate, label, timeoutMs = 30_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const found = client.updates.find(predicate)
      if (found !== undefined) return found
      await sleep(25)
    }
    throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for ${label}`)
  }
  try {
    const started = await scene.startC1Host('acp-scoped-mcp-b1', 'b1 host', {
      C1_B1_CONTROL: controlPath,
      C1_HOLD_LONG_TURN: longTurnRelease,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    }, b1WorkRoot)
    host = started.host
    const ready = started.ready
    hostIdentity = await hostIdentityFacts()
    assert(typeof ready.localHost?.scopeId === 'string' && ready.localHost.scopeId.length === 64, 'Q00: Host Ready must publish the scope id')
    assert(isHex64(context.candidateSha256), 'Q00: the candidate SHA256 must be a real digest')
    peer = await startPeer('b1 peer')
    const initialAccess = await acpAccess(peer, 'Q00 initial ACP status', undefined)
    assert(initialAccess.ok === true && initialAccess.status?.state === 'disabled', `Q00: ACP must start disabled: ${JSON.stringify(initialAccess)}`)
    const enabledAccess = await acpAccess(peer, 'Q00 enable ACP', true)
    assert(enabledAccess.ok === true && enabledAccess.status?.state === 'enabled', `Q00: ACP must enable: ${JSON.stringify(enabledAccess)}`)
    const status = daemonStatus('Q00 daemon status')
    assert(status.host === 'ready' && status.acp === 'enabled', `Q00: daemon status: ${JSON.stringify(status)}`)
    const expectedSocket = process.platform === 'darwin'
      ? `/private/tmp/dpt-${String(process.getuid())}-${ready.localHost.scopeId.slice(0, 40)}/acp.sock`
      : join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'acp.sock')
    assert(status['acp-socket'] === expectedSocket, `Q00: daemon status endpoint: ${JSON.stringify(status)}`)
    acpEndpoint = process.platform === 'darwin'
      ? { path: status['acp-socket'] }
      : { path: expectedSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId) }
    trace('acp-scoped-mcp-b1/q00', { candidateSha256: context.candidateSha256, hostPid: hostIdentity.hostPid, scopeId: ready.localHost.scopeId })

    const tuiAStarted = await scene.startC1Client('b1 tui A', {}, { cwd: hostCwd })
    tuiA = tuiAStarted.client
    const tuiBStarted = await scene.startC1Client('b1 tui B', {}, { cwd: hostCwd })
    tuiB = tuiBStarted.client
    sessionA = await openNewTuiSession(tuiA, 'Q01 tui A')
    sessionB = await openNewTuiSession(tuiB, 'Q01 tui B')
    assert(typeof sessionA === 'string' && typeof sessionB === 'string' && sessionA !== sessionB, 'Q01: two distinct TUI Sessions')
    const initialProbe = await control('probe', { sessionId: sessionA })
    assert(initialProbe.ok === true && initialProbe.agentCount >= 2, `Q01: real Host counts: ${JSON.stringify(initialProbe)}`)

    const { client: acpNew, initialized: initNew } = await openAcp('Q02')
    assert(initNew.agentCapabilities?.mcpCapabilities?.http === true && initNew.agentCapabilities?.mcpCapabilities?.sse === false,
      `Q02: initialize must advertise HTTP and keep Legacy SSE false: ${JSON.stringify(initNew.agentCapabilities)}`)
    assert(initNew.agentCapabilities?.sessionCapabilities?.resume !== undefined
      && initNew.agentCapabilities?.sessionCapabilities?.close !== undefined, 'Q02: resume/close capabilities must be advertised')
    // G-ACP2-PR2: canonical history/roster reads are advertised when bound.
    assert(initNew.agentCapabilities?.loadSession === true, 'Q02: a read-seam-ready Host advertises session/load')
    assert(initNew.agentCapabilities?.sessionCapabilities?.list !== undefined, 'Q02: and session/list')

    // ── B1-01: standard session/new starts a real Host Session whose exact
    //     Agent mounts the stdio server and runs a real model tool call.
    const created = await acpNew.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    assert(typeof created?.sessionId === 'string' && created.sessionId !== sessionA && created.sessionId !== sessionB,
      `Q03: session/new must return a distinct Host Session id: ${JSON.stringify(created)}`)
    const sessionNew = created.sessionId
    const beforeEcho = eventsOf(sessionNew).length
    const echoResult = await acpNew.request(acp.methods.agent.session.prompt, {
      sessionId: sessionNew,
      prompt: [{ type: 'text', text: `B1_ECHO_A ${digestOf(runNonce).slice(0, 16)}` }],
    })
    assert(echoResult?.stopReason === 'end_turn', `Q03: session/new prompt: ${JSON.stringify(echoResult)}`)
    await waitForTurnEnd(sessionNew, beforeEcho, 'Q03 session/new turn/end')
    const newEvents = sessionEventsAfter(sessionNew, beforeEcho)
    const newCall = findToolCall(newEvents, ECHO_TOOL)
    assert(newCall !== undefined, 'Q03: the new Session Agent must see mcp__b1scope__echo')
    const newResult = findToolResult(newEvents, toolCallIdOf(newCall))
    assert(newResult !== undefined && eventData(newResult).message?.isError !== true && toolResultText(newResult).includes('b0-echo:'),
      `Q03: real MCP tool result: ${newResult === undefined ? 'missing' : toolResultText(newResult)}`)
    const newModel = modelRecords(sessionNew, 'B1_ECHO_A')
    assert(newModel.some(record => record.afterTool === false && record.hasEchoTool === true), 'Q03: the model step must see the scoped tool')
    const firstServer = await waitForProof(line => line.kind === 'server-start' && line.tag === 'b1scope', proofPath, 'Q03 MCP server start')
    assert(firstServer.cwd === hostCwd, `Q03: new Session MCP child cwd must be ${hostCwd}: ${JSON.stringify(firstServer)}`)
    serverPids.add(firstServer.pid)
    assert(Array.isArray(initialProbe.toolNames) && !initialProbe.toolNames.includes(ECHO_TOOL), 'Q03: the probe before mount must not already show the tool')
    await assertSameHost(hostIdentity, 'Q03 Host after session/new tool call')

    // ── B1-02: resume an existing TUI Session with a DIFFERENT request cwd;
    //     the MCP child still starts in the original Session cwd and the TUI
    //     keeps working on the same Agent.
    await acpNew.request(acp.methods.agent.session.close, { sessionId: sessionNew })
    const resumeA = await resumeWhenAttachable(acpNew, {
      sessionId: sessionA, cwd: otherCwd, mcpServers: [mcpDeclaration()],
    })
    assert(resumeA?.sessionId === undefined || resumeA.sessionId === sessionA, `Q04: resume A: ${JSON.stringify(resumeA)}`)
    assert(surfaceSessionId(tuiA) === sessionA, 'Q04: TUI A must keep its Session')
    const aProofBefore = readProof(proofPath).filter(line => line.kind === 'server-start' && line.tag === 'b1scope').length
    const beforeResumeEcho = eventsOf(sessionA).length
    const resumeEcho = await acpNew.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: `B1_ECHO_A ${digestOf(`resume-${runNonce}`).slice(0, 16)}` }],
    })
    assert(resumeEcho?.stopReason === 'end_turn', 'Q04: resume A prompt must end_turn')
    await waitForTurnEnd(sessionA, beforeResumeEcho, 'Q04 resume A turn/end')
    const resumeEvents = sessionEventsAfter(sessionA, beforeResumeEcho)
    assert(findToolCall(resumeEvents, ECHO_TOOL) !== undefined, 'Q04: resume A must expose the MCP tool')
    const aStart = [...readProof(proofPath)].reverse().find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    assert(aStart !== undefined && aStart.cwd === hostCwd, `Q04: resume MCP child must use the original cwd ${hostCwd}: ${JSON.stringify(aStart)}`)
    assert(readProof(proofPath).filter(line => line.kind === 'server-start' && line.tag === 'b1scope').length >= aProofBefore,
      'Q04: resume must have started an MCP child')
    serverPids.add(aStart.pid)

    // ── B1-03: another Agent never sees A's MCP tool; its same-name call is a
    //     real UNKNOWN_TOOL and never reaches A's child.
    const serverCallsBeforeB = countServerCalls(readProof(proofPath), 'b1scope')
    const beforeB = eventsOf(sessionB).length
    await sendTuiPrompt(tuiB, `B1_ECHO_B ${digestOf(`b-${runNonce}`).slice(0, 16)}`, 'Q05 tui B')
    await waitForTurnEnd(sessionB, beforeB, 'Q05 B turn/end')
    const bEvents = sessionEventsAfter(sessionB, beforeB)
    const bCall = findToolCall(bEvents, ECHO_TOOL)
    assert(bCall !== undefined, 'Q05: B must attempt the same public tool name')
    const bResult = findToolResult(bEvents, toolCallIdOf(bCall))
    assert(bResult !== undefined && eventData(bResult).message?.isError === true && toolResultCode(bResult) === 'UNKNOWN_TOOL',
      `Q05: B's unscoped call must be UNKNOWN_TOOL: ${JSON.stringify(bResult === undefined ? null : { code: toolResultCode(bResult) })}`)
    assert(countServerCalls(readProof(proofPath), 'b1scope') === serverCallsBeforeB, 'Q05: B must never reach A\'s MCP child')
    assert(modelRecords(sessionB, 'B1_ECHO_B').every(record => record.hasEchoTool === false), 'Q05: B model step must not see the scoped tool')

    // ── B1-10: a real running TUI Session B makes a new ACP MCP resume fail
    //     BUSY without queuing a second start; after the real turn ends the
    //     same resume succeeds.
    const beforeLongB = eventsOf(sessionB).length
    await sendTuiPrompt(tuiB, `B1_HOLD_B ${digestOf(`long-${runNonce}`).slice(0, 16)}`, 'Q05b tui B long')
    const longHeld = await waitForC1WorkEvent(b1WorkRoot, event => event.kind === 'b1-long-turn-held' && event.sessionId === sessionB,
      'Q05b B long turn held', 60_000)
    assert(longHeld !== undefined, 'Q05b: the real TUI B turn must be held')
    const acpBusy = await openAcp('Q05b')
    await expectRequestError(
      resumeWhenAttachable(acpBusy, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] }),
      'LOCAL_ACP_MCP_AGENT_BUSY',
      'Q05b busy MCP resume',
    )
    writeFileSync(longTurnRelease, 'released\n', { mode: 0o600 })
    await waitForTurnEnd(sessionB, beforeLongB, 'Q05b B long turn/end')
    const retryBusy = await resumeWhenAttachable(acpBusy, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    assert(retryBusy?.sessionId === undefined || retryBusy.sessionId === sessionB, `Q05b: retry resume must succeed: ${JSON.stringify(retryBusy)}`)
    await acpBusy.client.request(acp.methods.agent.session.close, { sessionId: sessionB })
    await waitToolAbsent(sessionB, 'Q05b after close')
    await closeAcp(acpBusy.client)

    // ── B1-04: a real global tool with the same public name makes the next
    //     standard MCP admission fail closed; the global tool keeps working.
    await acpNew.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeAcp(acpNew)
    const shadow = await control('global-shadow', { sessionId: sessionB })
    assert(shadow.ok === true && Array.isArray(shadow.toolNames) && shadow.toolNames.includes(ECHO_TOOL), `Q06: global shadow installed: ${JSON.stringify(shadow)}`)
    const acpShadow = await openAcp('Q06')
    await expectRequestError(
      acpShadow.client.request(acp.methods.agent.session.resume, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] }),
      'LOCAL_ACP_MCP_NAME_CONFLICT',
      'Q06 global shadow admission',
    )
    const beforeGlobalB = eventsOf(sessionB).length
    await sendTuiPrompt(tuiB, `B1_ECHO_B ${digestOf(`b-global-${runNonce}`).slice(0, 16)}`, 'Q06 tui B global')
    await waitForTurnEnd(sessionB, beforeGlobalB, 'Q06 B global turn/end')
    const globalEvents = sessionEventsAfter(sessionB, beforeGlobalB)
    const globalCall = findToolCall(globalEvents, ECHO_TOOL)
    const globalResult = globalCall === undefined ? undefined : findToolResult(globalEvents, toolCallIdOf(globalCall))
    assert(globalResult !== undefined && toolResultText(globalResult).includes(GLOBAL_MARKER),
      'Q06: the pre-existing global tool must remain executable')
    const cleared = await control('clear-global-shadow', { sessionId: sessionB })
    assert(cleared.ok === true, `Q06: global shadow cleared: ${JSON.stringify(cleared)}`)
    await closeAcp(acpShadow.client)

    // ── B1-06 / B1-05 / B1-11: malformed declarations create nothing; a
    //     partially failed mount preserves the real created Session id.
    const countsBeforeInvalid = await control('probe')
    const acpInvalid = await openAcp('Q07')
    await expectRequestError(
      acpInvalid.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [{ name: 'bad', command: 'relative', args: [], env: [] }] }),
      'LOCAL_ACP_MCP_INVALID_DECLARATION',
      'Q07 relative command',
    )
    await expectRequestError(
      acpInvalid.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [{ name: 'bad', type: 'http', url: 'ftp://example.test/mcp', headers: [] }] }),
      'LOCAL_ACP_MCP_INVALID_DECLARATION',
      'Q07 invalid HTTP transport',
    )
    await expectRequestError(
      acpInvalid.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [{ name: 'legacy', type: 'sse', url: 'https://example.test/mcp', headers: [] }] }),
      'LOCAL_ACP_MCP_INVALID_DECLARATION',
      'Q07 Legacy SSE transport',
    )
    await expectRequestError(
      acpInvalid.client.request(acp.methods.agent.session.new, {
        cwd: hostCwd,
        mcpServers: Array.from({ length: 5 }, (_, index) => ({ name: `s${String(index)}`, command: process.execPath, args: [], env: [] })),
      }),
      'LOCAL_ACP_MCP_INVALID_DECLARATION',
      'Q07 capacity',
    )
    await expectRequestError(
      acpInvalid.client.request(acp.methods.agent.session.new, { cwd: hostCwd, additionalDirectories: ['/tmp'], mcpServers: [] }),
      'LOCAL_ACP_VIEW_INVALID_REQUEST',
      'Q07 additional directories',
    )
    const countsAfterInvalid = await control('probe')
    assert(countsAfterInvalid.agentCount === countsBeforeInvalid.agentCount
      && countsAfterInvalid.sessionCount === countsBeforeInvalid.sessionCount,
    `Q07: invalid declarations must create no Host Session/Agent: ${JSON.stringify({ before: countsBeforeInvalid, after: countsAfterInvalid })}`)

    const partialError = await expectRequestError(
      acpInvalid.client.request(acp.methods.agent.session.new, {
        cwd: hostCwd,
        mcpServers: [mcpDeclaration(), mcpDeclaration('b1fail', { B0_BOOT_FAIL: '1' }, 'b1fail')],
      }),
      'LOCAL_ACP_MCP_START_FAILED',
      'Q07 partial mount failure',
    )
    const createdButFailed = partialError?.data?.sessionId
    assert(typeof createdButFailed === 'string' && createdButFailed.length > 0,
      `Q07: a post-create MCP failure must carry the real sessionId: ${JSON.stringify(partialError?.data)}`)
    const failedCounts = await control('probe')
    assert(failedCounts.sessionCount === countsBeforeInvalid.sessionCount + 1, 'Q07: exactly the failed session exists')
    const bootFail = await waitForProof(line => line.kind === 'server-boot-fail' && line.tag === 'b1fail', proofPath, 'Q07 boot-fail child')
    assert(await waitForGone(bootFail.pid), 'Q07: the failed MCP child must exit')
    const firstPartial = readProof(proofPath).find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    if (firstPartial !== undefined) assert(await waitForGone(firstPartial.pid), 'Q07: the earlier MCP child must be rolled back')
    const recover = await resumeWhenAttachable(acpInvalid, { sessionId: createdButFailed, cwd: hostCwd })
    assert(recover?.sessionId === undefined || recover.sessionId === createdButFailed, 'Q07: the created Session must remain resumable')

    // ── B1-07: a Close while an ACP-owned prompt is still running cancels the
    //     exact Host turn and only then retires the same MCP lease.
    await acpInvalid.client.request(acp.methods.agent.session.close, { sessionId: createdButFailed })
    await closeAcp(acpInvalid.client)
    rmSync(holdArm, { force: true })
    rmSync(holdRelease, { force: true })
    const acpHold7 = await openAcp('Q07b')
    await resumeWhenAttachable(acpHold7, { sessionId: sessionA, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    const promptHold7 = acpHold7.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: `B1_HOLD_A ${digestOf(`close-${runNonce}`).slice(0, 16)}` }],
    })
    await waitForProof(line => line.kind === 'hold-received' && line.tag === 'b1scope', proofPath, 'Q07b MCP hold received')
    const close7 = acpHold7.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    writeFileSync(holdRelease, 'released\n', { mode: 0o600 })
    await promptHold7.catch(() => {})
    assert(JSON.stringify(await close7) === '{}', 'Q07b: close must detach with a real terminal')
    await waitToolAbsent(sessionA, 'Q07b after ACP prompt close')
    await closeAcp(acpHold7.client)

    // ── B1-13 bounded startup: a real nonresponsive stdio child is disposed
    //     when its ACP connection disappears, and the original TUI Agent
    //     remains usable instead of being held in maintenance.
    const acpHang = await openAcp('Q07c')
    const hangingResume = resumeWhenAttachable(acpHang, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [mcpDeclaration('b1hang', { B0_HANG_STARTUP: '1' }, 'b1hang')],
    }).catch(() => {})
    const hangStart = await waitForProof(
      line => line.kind === 'startup-hang' && line.tag === 'b1hang' && typeof line.pid === 'number' && alivePid(line.pid),
      proofPath,
      'Q07c live startup hang',
    )
    assert(alivePid(hangStart.pid), 'Q07c: the nonresponsive MCP child must be alive before disconnect')
    await acpHang.client.close()
    await hangingResume.catch(() => {})
    assert(await waitForGone(hangStart.pid), 'Q07c: disconnect must dispose the pending MCP child')
    await waitToolAbsent(sessionA, 'Q07c after aborted startup')
    const acpAfterHang = await openAcp('Q07c retry')
    const retryStarted = Date.now()
    for (;;) {
      try {
        await resumeWhenAttachable(acpAfterHang, { sessionId: sessionA, cwd: hostCwd })
        break
      } catch (error) {
        if (error?.data?.code !== 'LOCAL_ACP_VIEW_ALREADY_ATTACHED') throw error
        if (Date.now() - retryStarted > 30_000) throw error
        await sleep(50)
      }
    }
    await acpAfterHang.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeAcp(acpAfterHang.client)

    // ── B1-08: a TUI tool using the same MCP lease stays alive across an ACP
    //     close; the View detaches, then retires automatically at the real
    //     tool/result + turn/end terminal.
    const acpTuiHold = await openAcp('Q08')
    await resumeWhenAttachable(acpTuiHold, { sessionId: sessionA, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    rmSync(holdArm, { force: true })
    rmSync(holdRelease, { force: true })
    writeFileSync(holdArm, 'armed\n', { mode: 0o600 })
    const beforeHold = eventsOf(sessionA).length
    await sendTuiPrompt(tuiA, `B1_HOLD_A ${digestOf(`hold-${runNonce}`).slice(0, 16)}`, 'Q08 tui A hold')
    const holdCall = await waitForEvent(sessionA, beforeHold, event => event.type === 'tool/call' && eventData(event).name === HOLD_TOOL, 'Q08 durable hold tool/call')
    const holdCallId = toolCallIdOf(holdCall)
    await waitForProof(line => line.kind === 'hold-received' && line.tag === 'b1scope', proofPath, 'Q08 MCP hold received')
    const holdServer = [...readProof(proofPath)].reverse().find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    assert(holdServer !== undefined && alivePid(holdServer.pid), 'Q08: the MCP child must be alive while the TUI tool runs')
    const closeHold = await acpTuiHold.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(closeHold) === '{}', `Q08: close must return {} while the TUI tool is live: ${JSON.stringify(closeHold)}`)
    assert(alivePid(holdServer.pid), 'Q08: close must not kill the live MCP child')
    assert(findToolResult(sessionEventsAfter(sessionA, beforeHold), holdCallId) === undefined, 'Q08: close must not fabricate the TUI tool result')
    writeFileSync(holdRelease, 'released\n', { mode: 0o600 })
    await waitForEvent(sessionA, beforeHold, event => event.type === 'tool/result' && toolResultCallIdOf(event) === holdCallId, 'Q08 hold tool/result')
    await waitForTurnEnd(sessionA, beforeHold, 'Q08 hold turn/end')
    await waitToolAbsent(sessionA, 'Q08 after TUI terminal')
    assert(await waitForGone(holdServer.pid), 'Q08: the MCP child must exit after automatic retirement')
    await closeAcp(acpTuiHold.client)

    // ── B1-09: a physical EOF retires a live lease; Listener Off/On keeps the
    //     registry and admits exactly the next View.
    const acpEof = await openAcp('Q09')
    await resumeWhenAttachable(acpEof, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    const eofServer = [...readProof(proofPath)].reverse().find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    assert(eofServer !== undefined && alivePid(eofServer.pid), 'Q09: EOF lease child must be alive before disconnect')
    await acpEof.client.close()
    assert(await waitForGone(eofServer.pid), 'Q09: EOF must retire the MCP child')
    await waitToolAbsent(sessionB, 'Q09 after EOF')

    const acpOff = await openAcp('Q09 off')
    await resumeWhenAttachable(acpOff, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    const offServer = [...readProof(proofPath)].reverse().find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    assert(offServer !== undefined && alivePid(offServer.pid), 'Q09: Off lease child must be alive')
    const disabled = await acpAccess(peer, 'Q09 disable ACP', false)
    assert(disabled.ok === true && disabled.status?.state === 'disabled', `Q09: ACP must disable: ${JSON.stringify(disabled)}`)
    assert(await waitForGone(offServer.pid), 'Q09: Listener Off must retire the MCP child')
    const enabledAgain = await acpAccess(peer, 'Q09 re-enable ACP', true)
    assert(enabledAgain.ok === true && enabledAgain.status?.state === 'enabled', `Q09: ACP must re-enable: ${JSON.stringify(enabledAgain)}`)
    const acpOn = await openAcp('Q09 on')
    await resumeWhenAttachable(acpOn, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    await acpOn.client.request(acp.methods.agent.session.close, { sessionId: sessionB })
    await closeAcp(acpOn.client)
    await closeAcp(acpOff.client)

    // ── H1: a real HTTP-only session/new mounts the standard Streamable HTTP
    //     endpoint, keeps the configured headers, opens a real GET stream, runs
    //     a real model tool call and retires the Fiber/stream at close.
    const httpH1 = await startHttpFixture('h1')
    const acpH1 = await openAcp('H1 http new')
    const httpNew = await acpH1.client.request(acp.methods.agent.session.new, {
      cwd: hostCwd,
      mcpServers: [httpDeclaration('b1scope', httpH1.url)],
    })
    const httpSession = httpNew?.sessionId
    assert(typeof httpSession === 'string' && httpSession.length > 0 && httpSession !== sessionA && httpSession !== sessionB,
      `H1: HTTP session/new must return a distinct Session id: ${JSON.stringify(httpNew)}`)
    await waitToolPresent(httpSession, [ECHO_TOOL], 'H1 mounted HTTP tool')
    const beforeHttpEcho = eventsOf(httpSession).length
    const httpEchoNonce = digestOf(`http-${runNonce}`).slice(0, 16)
    const httpEcho = await acpH1.client.request(acp.methods.agent.session.prompt, {
      sessionId: httpSession,
      prompt: [{ type: 'text', text: `B1_ECHO_A ${httpEchoNonce}` }],
    })
    assert(httpEcho?.stopReason === 'end_turn', `H1: HTTP prompt must end_turn: ${JSON.stringify(httpEcho)}`)
    await waitForTurnEnd(httpSession, beforeHttpEcho, 'H1 HTTP turn/end')
    const httpEvents = sessionEventsAfter(httpSession, beforeHttpEcho)
    const httpEchoCall = findToolCall(httpEvents, ECHO_TOOL)
    assert(httpEchoCall !== undefined, 'H1: the HTTP Session Agent must see mcp__b1scope__echo')
    const httpEchoResult = findToolResult(httpEvents, toolCallIdOf(httpEchoCall))
    assert(httpEchoResult !== undefined && eventData(httpEchoResult).message?.isError !== true
      && toolResultText(httpEchoResult).includes(`b0-echo:${httpEchoNonce}`),
    `H1: real HTTP MCP tool result: ${httpEchoResult === undefined ? 'missing' : toolResultText(httpEchoResult)}`)
    assert(modelRecords(httpSession, 'B1_ECHO_A').some(record => record.afterTool === false && record.hasEchoTool === true),
      'H1: the model step must see the HTTP-scoped tool')
    const httpListRequest = await httpH1.waitForEvent(event => event.kind === 'request' && event.rpcMethod === 'tools/list',
      'H1 HTTP tools/list')
    assert(httpListRequest.headerMatches?.Authorization === true && httpListRequest.headerMatches?.['X-API-Key'] === true,
      `H1: the exact configured HTTP headers must reach the endpoint: ${JSON.stringify(httpListRequest)}`)
    const h1Stream = await httpH1.waitForEvent(event => event.kind === 'sse-open', 'H1 HTTP GET stream open')
    await httpH1.waitForEvent(event => event.kind === 'tools/call' && event.name === 'echo'
      && event.nonceDigest === digestOf(httpEchoNonce).slice(0, 16), 'H1 HTTP tools/call exact nonce')
    const httpCallRequest = await httpH1.waitForEvent(
      event => event.kind === 'request' && event.rpcMethod === 'tools/call'
        && event.headerMatches?.Authorization === true && event.headerMatches?.['X-API-Key'] === true,
      'H1 HTTP tools/call exact headers',
    )
    assert(httpCallRequest.headerMatches?.Authorization === true && httpCallRequest.headerMatches?.['X-API-Key'] === true,
      'H1: the actual HTTP tools/call must carry the exact configured headers')
    await acpH1.client.request(acp.methods.agent.session.close, { sessionId: httpSession })
    await waitToolAbsent(httpSession, 'H1 after HTTP close', [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL])
    await httpH1.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h1Stream.streamId,
      'H1 HTTP GET stream close')
    await closeAcp(acpH1.client)
    const acpH1Reborrow = await openAcp('H1 HTTP reborrow')
    await resumeWhenAttachable(acpH1Reborrow, { sessionId: httpSession, cwd: hostCwd, mcpServers: [] })
    await acpH1Reborrow.client.request(acp.methods.agent.session.close, { sessionId: httpSession })
    await closeAcp(acpH1Reborrow.client)
    await assertSameHost(hostIdentity, 'H1 Host after HTTP new Session')

    // ── H2: resume the live TUI Session A with HTTP; another Agent cannot see
    //     the tool, and an ACP close during a live TUI hold defers retirement
    //     until the real TUI tool terminal.
    const httpH2 = await startHttpFixture('h2')
    const acpH2 = await openAcp('H2 http resume')
    const h2ModelBefore = modelRecords(sessionB, 'B1_ECHO_B').length
    await resumeWhenAttachable(acpH2, { sessionId: sessionA, cwd: otherCwd, mcpServers: [httpDeclaration('b1scope', httpH2.url)] })
    // This fixture is fresh for H2; every tools/list event belongs to this mount.
    await httpH2.waitForEvent(event => event.kind === 'request' && event.rpcMethod === 'tools/list', 'H2 HTTP tools/list')
    const h2Stream = await httpH2.waitForEvent(event => event.kind === 'sse-open', 'H2 HTTP GET stream open')
    await waitToolPresent(sessionA, [ECHO_TOOL, HOLD_TOOL], 'H2 mounted HTTP tools')
    const beforeHttpB = eventsOf(sessionB).length
    const h2CallsBefore = httpH2.requests.filter(request => request.method === 'tools/call').length
    await sendTuiPrompt(tuiB, `B1_ECHO_B ${digestOf(`http-b-${runNonce}`).slice(0, 16)}`, 'H2 tui B')
    await waitForTurnEnd(sessionB, beforeHttpB, 'H2 B turn/end')
    const h2BModel = modelRecords(sessionB, 'B1_ECHO_B').slice(h2ModelBefore)
    assert(h2BModel.length > 0 && h2BModel.every(record => record.hasEchoTool === false),
      `H2: another Agent must not see the HTTP-scoped tool: ${JSON.stringify(h2BModel)}`)
    const h2BEvents = sessionEventsAfter(sessionB, beforeHttpB)
    const h2BCall = findToolCall(h2BEvents, ECHO_TOOL)
    assert(h2BCall !== undefined, 'H2: B must make its real named echo tool call')
    const h2BResult = findToolResult(h2BEvents, toolCallIdOf(h2BCall))
    assert(h2BResult !== undefined && eventData(h2BResult).message?.isError === true
      && toolResultCode(h2BResult) === 'UNKNOWN_TOOL',
    `H2: B's real named call must be UNKNOWN_TOOL: ${JSON.stringify(h2BResult === undefined ? null : { code: toolResultCode(h2BResult) })}`)
    assert(httpH2.requests.filter(request => request.method === 'tools/call').length === h2CallsBefore,
      'H2: another Agent must never reach the HTTP endpoint')
    const beforeHttpHold = eventsOf(sessionA).length
    const h2HoldNonce = digestOf(`http-hold-${runNonce}`).slice(0, 16)
    const h2HoldPrompt = `B1_HOLD_A ${h2HoldNonce}`
    await sendTuiPrompt(tuiA, h2HoldPrompt, 'H2 tui A hold')
    const httpHoldCall = await waitForEvent(sessionA, beforeHttpHold,
      event => event.type === 'tool/call' && eventData(event).name === HOLD_TOOL, 'H2 HTTP hold tool/call')
    const httpHoldCallId = toolCallIdOf(httpHoldCall)
    await httpH2.waitForEvent(event => event.kind === 'hold-received', 'H2 HTTP hold received')
    const httpCloseH2 = await acpH2.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(httpCloseH2) === '{}', `H2: HTTP close must detach with a real terminal: ${JSON.stringify(httpCloseH2)}`)
    assert(httpH2.sse.find(stream => stream.id === h2Stream.streamId)?.closedAt === undefined,
      'H2: close must not abort the live HTTP stream')
    assert(findToolResult(sessionEventsAfter(sessionA, beforeHttpHold), httpHoldCallId) === undefined,
      'H2: close must not fabricate the TUI tool result')
    await expectRequestError(
      acpH2.client.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd, mcpServers: [] }),
      'LOCAL_ACP_VIEW_BUSY',
      'H2 deferred claim fence',
    )
    httpH2.releaseHold()
    const httpHoldResult = await waitForEvent(sessionA, beforeHttpHold,
      event => event.type === 'tool/result' && toolResultCallIdOf(event) === httpHoldCallId, 'H2 HTTP hold tool/result')
    assert(eventData(httpHoldResult).message?.isError !== true && toolResultText(httpHoldResult).includes(`b0-hold:${h2HoldNonce}`),
      `H2: the real held TUI tool must succeed with its exact nonce: ${toolResultText(httpHoldResult)}`)
    await waitForTurnEnd(sessionA, beforeHttpHold, 'H2 HTTP hold turn/end')
    await waitToolAbsent(sessionA, 'H2 after TUI terminal', [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL])
    await httpH2.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h2Stream.streamId,
      'H2 HTTP GET stream close after retirement')
    await closeAcp(acpH2.client)
    await assertSameHost(hostIdentity, 'H2 Host after shared HTTP lease')

    // ── H3: session/load replays with a real HTTP lease, EOF retires it, and
    //     Listener Off/On releases then re-admits exactly the next HTTP View.
    const httpH3 = await startHttpFixture('h3')
    const acpH3 = await openAcp('H3 http load')
    const h3LoadRequests = httpH3.requests.length
    await loadWhenAttachable(acpH3, {
      sessionId: sessionA,
      cwd: hostCwd,
      mcpServers: [httpDeclaration('b1scope', httpH3.url)],
    }, 'H3 HTTP load')
    const h3Replay = await waitForClientUpdate(
      acpH3.client,
      update => update.update?.sessionUpdate === 'user_message_chunk'
        && String(update.update?.content?.text ?? '').includes(h2HoldPrompt),
      'H3 HTTP load replay of the H2 durable user marker',
    )
    assert(h3Replay !== undefined, 'H3: session/load must replay the H2 durable user marker')
    await waitForRequestAfter(httpH3, h3LoadRequests, request => request.method === 'tools/list', 'H3 HTTP load tools/list')
    const h3LoadStream = await httpH3.waitForEvent(event => event.kind === 'sse-open', 'H3 HTTP load stream open')
    await waitToolPresent(sessionA, [ECHO_TOOL], 'H3 loaded HTTP tool')
    const beforeH3Echo = eventsOf(sessionA).length
    const h3EchoNonce = digestOf(`http-load-echo-${runNonce}`).slice(0, 16)
    const h3Echo = await acpH3.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: `B1_ECHO_A ${h3EchoNonce}` }],
    })
    assert(h3Echo?.stopReason === 'end_turn', `H3: loaded HTTP prompt must end_turn: ${JSON.stringify(h3Echo)}`)
    await waitForTurnEnd(sessionA, beforeH3Echo, 'H3 loaded HTTP turn/end')
    const h3EchoEvents = sessionEventsAfter(sessionA, beforeH3Echo)
    const h3EchoCall = findToolCall(h3EchoEvents, ECHO_TOOL)
    assert(h3EchoCall !== undefined, 'H3: the loaded HTTP View must expose mcp__b1scope__echo')
    const h3EchoResult = findToolResult(h3EchoEvents, toolCallIdOf(h3EchoCall))
    assert(h3EchoResult !== undefined && eventData(h3EchoResult).message?.isError !== true
      && toolResultText(h3EchoResult).includes(`b0-echo:${h3EchoNonce}`),
    `H3: loaded HTTP tool result: ${h3EchoResult === undefined ? 'missing' : toolResultText(h3EchoResult)}`)
    await httpH3.waitForEvent(event => event.kind === 'tools/call' && event.name === 'echo'
      && event.nonceDigest === digestOf(h3EchoNonce).slice(0, 16), 'H3 loaded HTTP tools/call exact nonce')
    await acpH3.client.close()
    await waitToolAbsent(sessionA, 'H3 HTTP EOF', [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL])
    await httpH3.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h3LoadStream.streamId,
      'H3 HTTP EOF stream close')
    const acpH3Off = await openAcp('H3 http off')
    const h3OffRequests = httpH3.requests.length
    await resumeWhenAttachable(acpH3Off, { sessionId: sessionB, cwd: hostCwd, mcpServers: [httpDeclaration('b1scope', httpH3.url)] })
    await waitForRequestAfter(httpH3, h3OffRequests, request => request.method === 'tools/list', 'H3 HTTP Off tools/list')
    const h3OffStream = await httpH3.waitForEvent(event => event.kind === 'sse-open' && event.streamId > h3LoadStream.streamId,
      'H3 HTTP Off stream open')
    const h3Disabled = await acpAccess(peer, 'H3 disable ACP', false)
    assert(h3Disabled.ok === true && h3Disabled.status?.state === 'disabled', `H3: ACP must disable: ${JSON.stringify(h3Disabled)}`)
    await waitToolAbsent(sessionB, 'H3 HTTP Listener Off', [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL])
    await httpH3.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h3OffStream.streamId,
      'H3 HTTP Off stream close')
    const h3Enabled = await acpAccess(peer, 'H3 re-enable ACP', true)
    assert(h3Enabled.ok === true && h3Enabled.status?.state === 'enabled', `H3: ACP must re-enable: ${JSON.stringify(h3Enabled)}`)
    const acpH3On = await openAcp('H3 http on')
    const h3OnRequests = httpH3.requests.length
    await resumeWhenAttachable(acpH3On, { sessionId: sessionB, cwd: hostCwd, mcpServers: [httpDeclaration('b1scope', httpH3.url)] })
    await waitForRequestAfter(httpH3, h3OnRequests, request => request.method === 'tools/list', 'H3 HTTP On tools/list')
    const h3OnStream = await httpH3.waitForEvent(event => event.kind === 'sse-open' && event.streamId > h3OffStream.streamId,
      'H3 HTTP On stream open')
    await acpH3On.client.request(acp.methods.agent.session.close, { sessionId: sessionB })
    await waitToolAbsent(sessionB, 'H3 HTTP On close', [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL])
    await httpH3.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h3OnStream.streamId,
      'H3 HTTP On stream close')
    await closeAcp(acpH3On.client)
    await closeAcp(acpH3Off.client)
    await assertSameHost(hostIdentity, 'H3 Host after HTTP load/EOF/Off/On')

    // ── H4: a mixed stdio + HTTP + fail-list request fails closed; the
    //     earlier HTTP stream and stdio child retire while the created Session
    //     remains real and reborrowable.
    const httpH4Fail = await startHttpFixture('h4-fail')
    const acpH4Fail = await openAcp('H4 http mixed rollback')
    const h4CountsBefore = await control('probe')
    const h4FailRequests = httpH4Fail.requests.length
    const h4FailError = await expectRequestError(
      acpH4Fail.client.request(acp.methods.agent.session.new, {
        cwd: hostCwd,
        mcpServers: [
          mcpDeclaration('b1h4failstdio'),
          httpDeclaration('b1httpokfail', httpH4Fail.url),
          httpDeclaration('b1httpfail', httpH4Fail.failListUrl),
        ],
      }),
      'LOCAL_ACP_MCP_START_FAILED',
      'H4 mixed stdio+HTTP fail-list rollback',
    )
    const h4FailSession = h4FailError?.data?.sessionId
    assert(typeof h4FailSession === 'string' && h4FailSession.length > 0,
      `H4: mixed failure must preserve the created session id: ${JSON.stringify(h4FailError?.data)}`)
    await waitForRequestAfter(httpH4Fail, h4FailRequests, request => request.method === 'tools/list' && request.path === '/mcp',
      'H5 normal HTTP tools/list')
    await waitForRequestAfter(httpH4Fail, h4FailRequests, request => request.method === 'tools/list' && request.path === '/fail-list',
      'H4 fail-list tools/list')
    const h4FailStream = await httpH4Fail.waitForEvent(event => event.kind === 'sse-open' && event.path === '/mcp',
      'H4 normal HTTP stream open before rollback')
    await httpH4Fail.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h4FailStream.streamId,
      'H4 normal HTTP stream rollback close')
    const h4FailStdio = await waitForProof(line => line.kind === 'server-start' && line.tag === 'b1h4failstdio',
      proofPath, 'H5 stdio child start')
    assert(await waitForGone(h4FailStdio.pid), 'H4: the earlier stdio child must be rolled back')
    await waitToolAbsent(h4FailSession, 'H4 mixed rollback',
      ['mcp__b1h4failstdio__echo', 'mcp__b1httpokfail__echo', 'mcp__b1httpfail__echo'])
    const h4CountsAfter = await control('probe')
    assert(h4CountsAfter.sessionCount === h4CountsBefore.sessionCount + 1,
      'H4: exactly the created Session exists after the mixed failure')
    const acpH4Recover = await openAcp('H4 recover')
    await resumeWhenAttachable(acpH4Recover, { sessionId: h4FailSession, cwd: hostCwd })
    await acpH4Recover.client.request(acp.methods.agent.session.close, { sessionId: h4FailSession })
    await closeAcp(acpH4Recover.client)
    await closeAcp(acpH4Fail.client)
    await assertSameHost(hostIdentity, 'H4 Host after mixed rollback')

    // ── H5: a mixed request mounts stdio + two HTTP transports; a real call
    //     to the fail-call endpoint returns HTTP 500, and close retires all
    //     three scoped transports.
    const httpH4 = await startHttpFixture('h4')
    const acpH4 = await openAcp('H4 http mixed')
    const h4New = await acpH4.client.request(acp.methods.agent.session.new, {
      cwd: hostCwd,
      mcpServers: [
        mcpDeclaration('b1h4stdio'),
        httpDeclaration('b1httpok', httpH4.url),
        httpDeclaration('b1scope', httpH4.failCallUrl),
      ],
    })
    const h4Session = h4New?.sessionId
    assert(typeof h4Session === 'string' && h4Session.length > 0, `H4: mixed session/new must return a Session id: ${JSON.stringify(h4New)}`)
    await waitToolPresent(h4Session, ['mcp__b1h4stdio__echo', 'mcp__b1httpok__echo', FAIL_TOOL], 'H5 mounted mixed tools')
    await httpH4.waitForEvent(event => event.kind === 'request' && event.rpcMethod === 'tools/list' && event.path === '/mcp',
      'H5 normal HTTP tools/list')
    await httpH4.waitForEvent(event => event.kind === 'request' && event.rpcMethod === 'tools/list' && event.path === '/fail-call',
      'H5 fail-call tools/list')
    const h4Stream = await httpH4.waitForEvent(event => event.kind === 'sse-open' && event.path === '/mcp', 'H5 normal HTTP GET stream open')
    const beforeH4Fail = eventsOf(h4Session).length
    const h4FailNonce = digestOf(`http-mixed-fail-${runNonce}`).slice(0, 16)
    const h4Fail = await acpH4.client.request(acp.methods.agent.session.prompt, {
      sessionId: h4Session,
      prompt: [{ type: 'text', text: `B1_FAIL_A ${h4FailNonce}` }],
    })
    assert(h4Fail?.stopReason === 'end_turn', `H4: fail-call prompt must end_turn: ${JSON.stringify(h4Fail)}`)
    await waitForTurnEnd(h4Session, beforeH4Fail, 'H5 fail-call turn/end')
    const h4Events = sessionEventsAfter(h4Session, beforeH4Fail)
    const h4FailCall = findToolCall(h4Events, FAIL_TOOL)
    assert(h4FailCall !== undefined, 'H5: the mixed Session must expose mcp__b1scope__fail')
    const h4FailResult = findToolResult(h4Events, toolCallIdOf(h4FailCall))
    assert(h4FailResult !== undefined && eventData(h4FailResult).message?.isError === true,
      `H4: the HTTP 500 tools/call must produce an error tool result: ${JSON.stringify(h4FailResult === undefined ? null : toolResultText(h4FailResult))}`)
    await httpH4.waitForEvent(event => event.kind === 'request' && event.rpcMethod === 'tools/call' && event.path === '/fail-call'
      && event.headerMatches?.Authorization === true && event.headerMatches?.['X-API-Key'] === true,
    'H5 fail-call actual tools/call headers')
    assert(httpH4.requests.filter(request => request.method === 'tools/call' && request.path === '/mcp').length === 0,
      'H5: the fail tool call must not reach the normal HTTP endpoint')
    const h4Stdio = await waitForProof(line => line.kind === 'server-start' && line.tag === 'b1h4stdio', proofPath, 'H5 stdio child start')
    await acpH4.client.request(acp.methods.agent.session.close, { sessionId: h4Session })
    await waitToolAbsent(h4Session, 'H5 mixed close', ['mcp__b1h4stdio__echo', 'mcp__b1httpok__echo', FAIL_TOOL])
    await httpH4.waitForEvent(event => event.kind === 'sse-close' && event.streamId === h4Stream.streamId,
      'H5 normal HTTP stream close')
    assert(await waitForGone(h4Stdio.pid), 'H5: the mixed stdio child must retire at close')
    await closeAcp(acpH4.client)
    await assertSameHost(hostIdentity, 'H5 Host after mixed success + call error')

    // ── H6: a held HTTP startup is disposed when the ACP connection disappears;
    //     a refused wire endpoint stays START_FAILED with the real created id;
    //     Legacy SSE is rejected before any Host effect.
    const httpH5 = await startHttpFixture('h5')
    const acpH5 = await openAcp('H5 http pending')
    const h5PendingAt = Date.now()
    const h5Pending = resumeWhenAttachable(acpH5, {
      sessionId: sessionA,
      cwd: hostCwd,
      mcpServers: [httpDeclaration('b1scope', httpH5.holdStartupUrl)],
    }).catch(() => {})
    await httpH5.waitForEvent(event => event.kind === 'request' && event.path === '/hold-startup'
      && event.time >= h5PendingAt && event.headerMatches?.Authorization === true
      && event.headerMatches?.['X-API-Key'] === true, 'H6 held HTTP startup exact headers')
    await httpH5.waitForEvent(event => event.kind === 'startup-held' && event.time >= h5PendingAt, 'H6 held HTTP startup')
    assert(!httpH5.events.some(event => event.kind === 'startup-held-closed' && event.time >= h5PendingAt),
      'H6: the held startup must still be open when the ACP connection is closed')
    await acpH5.client.close()
    await h5Pending
    await httpH5.waitForEvent(event => event.kind === 'startup-held-closed' && event.time >= h5PendingAt, 'H6 held HTTP startup close')
    await waitToolAbsent(sessionA, 'H6 HTTP pending startup', [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL])
    const closedWire = await startScopedMcpHttpServer({ tag: 'b1-closed-wire' })
    const closedWireUrl = closedWire.url
    await closedWire.close()
    const acpH5Wire = await openAcp('H6 http wire')
    const h5WireError = await expectRequestError(
      acpH5Wire.client.request(acp.methods.agent.session.new, {
        cwd: hostCwd,
        mcpServers: [httpDeclaration('b1wire', closedWireUrl)],
      }),
      'LOCAL_ACP_MCP_START_FAILED',
      'H6 refused HTTP wire',
    )
    const h5WireSession = h5WireError?.data?.sessionId
    assert(typeof h5WireSession === 'string' && h5WireSession.length > 0,
      `H6: refused wire must preserve the created session id: ${JSON.stringify(h5WireError?.data)}`)
    await waitToolAbsent(h5WireSession, 'H6 refused HTTP wire', ['mcp__b1wire__echo'])
    const h5BeforeSse = await control('probe')
    await expectRequestError(
      acpH5Wire.client.request(acp.methods.agent.session.new, {
        cwd: hostCwd,
        mcpServers: [{ name: 'legacy', type: 'sse', url: 'https://example.test/mcp', headers: [] }],
      }),
      'LOCAL_ACP_MCP_INVALID_DECLARATION',
      'H6 Legacy SSE',
    )
    const h5AfterSse = await control('probe')
    assert(h5AfterSse.sessionCount === h5BeforeSse.sessionCount && h5AfterSse.agentCount === h5BeforeSse.agentCount,
      'H6: Legacy SSE must create no Host Session/Agent')
    const acpH5Recover = await openAcp('H6 recover')
    await resumeWhenAttachable(acpH5Recover, { sessionId: h5WireSession, cwd: hostCwd })
    await acpH5Recover.client.request(acp.methods.agent.session.close, { sessionId: h5WireSession })
    await resumeWhenAttachable(acpH5Recover, { sessionId: sessionA, cwd: hostCwd, mcpServers: [] })
    await acpH5Recover.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeAcp(acpH5Recover.client)
    await closeAcp(acpH5Wire.client)
    await assertSameHost(hostIdentity, 'H6 Host after HTTP pending/wire boundaries')

    // ── B1-04 negative control: a plain TUI A turn still works after the
    //     production leases were retired (the shared Session was never killed).
    const beforePlain = eventsOf(sessionA).length
    await sendTuiPrompt(tuiA, `B1_PLAIN_A ${digestOf(`plain-${runNonce}`).slice(0, 16)}`, 'Q10 tui A plain')
    await waitForTurnEnd(sessionA, beforePlain, 'Q10 plain turn/end')
    assert(hostAssistantHasText(sessionEventsAfter(sessionA, beforePlain), 'b1 plain settled'), 'Q10: TUI A must complete a real plain turn after ACP leases retired')
    await assertSameHost(hostIdentity, 'Q10 Host after all leases')

    // ── Quiescence and evidence: every run-owned fixture stream and held
    //     startup is settled before Host shutdown; close the fixtures on the
    //     success path and keep finally only as the emergency backstop.
    for (const fixture of httpFixtures) {
      assert(fixture.sse.every(stream => stream.closedAt !== undefined),
        `${fixture.tag}: every run-owned HTTP stream must be closed before Host shutdown`)
      await fixture.close()
    }
    await scene.exitC1Client(tuiB, 'Q11 tui B')
    await scene.exitC1Client(tuiA, 'Q11 tui A')
    for (const client of acpClients) await closeAcp(client)
    const peerExit = peer.exited ? undefined : await peer.shutdown()
    assert(peerExit === undefined || (peerExit.code === 0 && peerExit.signal === null), 'Q11: peer must exit cleanly')
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0 && hostExit.signal === null, 'Q11: Host must exit cleanly')
    await scene.awaitSceneSeatFree()
    assert(!existsSync(acpEndpoint.path), 'Q11: the ACP socket must be gone after shutdown')
    const proofFinal = readProof(proofPath)
    for (const pid of serverPids) assert(!alivePid(pid), `Q11: MCP child ${String(pid)} must not survive`)
    const evidence = {
      schema: 'gacp-b1-evidence/1',
      case_id: CASE_ID,
      platform: process.platform,
      candidate_sha256: context.candidateSha256,
      dsh_version: context.targetDshVersion,
      bundle_version: installation.manifest.version,
      host: { pid: hostIdentity.hostPid, instanceId: hostIdentity.instanceId, scopeId: hostIdentity.scopeId },
      sessions: { A: sessionA, B: sessionB, new: sessionNew, failedNew: createdButFailed },
      mcp: { serverName: 'b1scope', toolNames: [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL], childPids: proofFinal.filter(line => line.kind === 'server-start').map(line => line.pid) },
      http: {
        sessions: { new: httpSession, mixedRollback: h4FailSession, mixedCall: h4Session, refusedWire: h5WireSession },
        headersMatched: true,
        newToolCall: true,
        sharedTuiClose: true,
        loadEofOff: true,
        mixedRollback: true,
        mixedCallError: true,
        mixedRetired: true,
        pendingStartup: true,
        refusedWire: true,
        legacySseRejected: true,
        legacySseAdvertised: initNew.agentCapabilities?.mcpCapabilities?.sse,
        httpAdvertised: initNew.agentCapabilities?.mcpCapabilities?.http,
      },
      closeToDispose: { hold: closeHold, toolResultRetired: true, eofRetired: true, offRetired: true },
      negative: { agentBIsolation: true, globalShadowRejected: true, invalidCreatedNothing: true },
      quiesced: true,
      verdict: 'PASS',
    }
    assert(isHex64(evidence.candidate_sha256), 'evidence: candidate SHA256 must be a real digest')
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      productionSessionNewMcp: true,
      productionResumeMcp: true,
      realToolCall: true,
      agentIsolation: true,
      globalShadowRejected: true,
      createdSessionIdPreserved: true,
      closeDefersUntilTuiTerminal: true,
      eofRetiresLease: true,
      listenerOffRetiresLease: true,
      tuiContinuesAfterRetire: true,
      httpScopedMcp: true,
      httpHeadersPreserved: true,
      httpSharedTuiClose: true,
      httpLoadEofOff: true,
      httpMixedRollback: true,
      httpMixedCallError: true,
      httpPendingStartupDisposed: true,
      httpRefusedWireStartFailed: true,
      legacySseRejected: true,
      quiesced: true,
      evidence,
    }
  } finally {
    try { writeFileSync(holdRelease, 'released\n', { mode: 0o600 }) } catch { /* best effort */ }
    for (const fixture of httpFixtures) {
      try { await fixture.close() } catch { /* runner backstop */ }
    }
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
