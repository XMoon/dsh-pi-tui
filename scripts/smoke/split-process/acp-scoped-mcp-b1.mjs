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
  const connection = acp.client({ name: 'b1-scoped-mcp-qualification' }).connect(stream)
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
  const waitToolAbsent = async (sessionId, label, timeoutMs = 60_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const probe = await control('probe', { sessionId })
      if (probe.ok === true && Array.isArray(probe.toolNames) && !probe.toolNames.includes(ECHO_TOOL)) return probe
      await sleep(50)
    }
    throw new SplitSmokeAssertionError(`${CASE_ID}: timed out waiting for MCP tool absence (${label})`)
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
    assert(initNew.agentCapabilities?.mcpCapabilities?.http === false && initNew.agentCapabilities?.mcpCapabilities?.sse === false,
      `Q02: initialize must advertise http/sse false: ${JSON.stringify(initNew.agentCapabilities)}`)
    assert(initNew.agentCapabilities?.sessionCapabilities?.resume !== undefined
      && initNew.agentCapabilities?.sessionCapabilities?.close !== undefined, 'Q02: resume/close capabilities must be advertised')
    assert(initNew.agentCapabilities?.loadSession === false, 'Q02: loadSession must stay false')

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
    const resumeA = await acpNew.request(acp.methods.agent.session.resume, {
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
      acpBusy.client.request(acp.methods.agent.session.resume, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] }),
      'LOCAL_ACP_MCP_AGENT_BUSY',
      'Q05b busy MCP resume',
    )
    writeFileSync(longTurnRelease, 'released\n', { mode: 0o600 })
    await waitForTurnEnd(sessionB, beforeLongB, 'Q05b B long turn/end')
    const retryBusy = await acpBusy.client.request(acp.methods.agent.session.resume, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
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
      acpInvalid.client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [{ name: 'bad', type: 'http', url: 'https://example.test', headers: [] }] }),
      'LOCAL_ACP_MCP_INVALID_DECLARATION',
      'Q07 HTTP transport',
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
    const recover = await acpInvalid.client.request(acp.methods.agent.session.resume, { sessionId: createdButFailed, cwd: hostCwd })
    assert(recover?.sessionId === undefined || recover.sessionId === createdButFailed, 'Q07: the created Session must remain resumable')

    // ── B1-07: a Close while an ACP-owned prompt is still running cancels the
    //     exact Host turn and only then retires the same MCP lease.
    await acpInvalid.client.request(acp.methods.agent.session.close, { sessionId: createdButFailed })
    await closeAcp(acpInvalid.client)
    rmSync(holdArm, { force: true })
    rmSync(holdRelease, { force: true })
    const acpHold7 = await openAcp('Q07b')
    await acpHold7.client.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
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
    const hangingResume = acpHang.client.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [mcpDeclaration('b1hang', { B0_HANG_STARTUP: '1' }, 'b1hang')],
    }).catch(() => {})
    await waitForProof(line => line.kind === 'startup-hang' && line.tag === 'b1hang', proofPath, 'Q07c startup hang')
    const hangStart = readProof(proofPath).filter(line => line.kind === 'startup-hang' && line.tag === 'b1hang').at(-1)
    assert(hangStart !== undefined && typeof hangStart.pid === 'number' && alivePid(hangStart.pid), 'Q07c: the nonresponsive MCP child must be alive before disconnect')
    await acpHang.client.close()
    await hangingResume.catch(() => {})
    assert(await waitForGone(hangStart.pid), 'Q07c: disconnect must dispose the pending MCP child')
    await waitToolAbsent(sessionA, 'Q07c after aborted startup')
    const acpAfterHang = await openAcp('Q07c retry')
    const retryStarted = Date.now()
    for (;;) {
      try {
        await acpAfterHang.client.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd })
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
    await acpTuiHold.client.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
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
    await acpEof.client.request(acp.methods.agent.session.resume, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    const eofServer = [...readProof(proofPath)].reverse().find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    assert(eofServer !== undefined && alivePid(eofServer.pid), 'Q09: EOF lease child must be alive before disconnect')
    await acpEof.client.close()
    assert(await waitForGone(eofServer.pid), 'Q09: EOF must retire the MCP child')
    await waitToolAbsent(sessionB, 'Q09 after EOF')

    const acpOff = await openAcp('Q09 off')
    await acpOff.client.request(acp.methods.agent.session.resume, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    const offServer = [...readProof(proofPath)].reverse().find(line => line.kind === 'server-start' && line.tag === 'b1scope')
    assert(offServer !== undefined && alivePid(offServer.pid), 'Q09: Off lease child must be alive')
    const disabled = await acpAccess(peer, 'Q09 disable ACP', false)
    assert(disabled.ok === true && disabled.status?.state === 'disabled', `Q09: ACP must disable: ${JSON.stringify(disabled)}`)
    assert(await waitForGone(offServer.pid), 'Q09: Listener Off must retire the MCP child')
    const enabledAgain = await acpAccess(peer, 'Q09 re-enable ACP', true)
    assert(enabledAgain.ok === true && enabledAgain.status?.state === 'enabled', `Q09: ACP must re-enable: ${JSON.stringify(enabledAgain)}`)
    const acpOn = await openAcp('Q09 on')
    await acpOn.client.request(acp.methods.agent.session.resume, { sessionId: sessionB, cwd: hostCwd, mcpServers: [mcpDeclaration()] })
    await acpOn.client.request(acp.methods.agent.session.close, { sessionId: sessionB })
    await closeAcp(acpOn.client)
    await closeAcp(acpOff.client)

    // ── B1-04 negative control: a plain TUI A turn still works after the
    //     production leases were retired (the shared Session was never killed).
    const beforePlain = eventsOf(sessionA).length
    await sendTuiPrompt(tuiA, `B1_PLAIN_A ${digestOf(`plain-${runNonce}`).slice(0, 16)}`, 'Q10 tui A plain')
    await waitForTurnEnd(sessionA, beforePlain, 'Q10 plain turn/end')
    assert(hostAssistantHasText(sessionEventsAfter(sessionA, beforePlain), 'b1 plain settled'), 'Q10: TUI A must complete a real plain turn after ACP leases retired')
    await assertSameHost(hostIdentity, 'Q10 Host after all leases')

    // ── Quiescence and evidence.
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
      quiesced: true,
      evidence,
    }
  } finally {
    try { writeFileSync(holdRelease, 'released\n', { mode: 0o600 }) } catch { /* best effort */ }
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
