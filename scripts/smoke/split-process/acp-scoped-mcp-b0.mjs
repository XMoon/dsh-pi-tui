/**
 * G-ACP1B/B0 — real packaged Agent-scoped MCP qualification.
 *
 * One REAL installed Split Host, two REAL TUI Sessions (A/B), one REAL Host ACP
 * v1 UDS connection, the OFFICIAL live Agent A and the OFFICIAL McpClient
 * plugin mounted on A's Agent Context. The offline model, the harmless stdio
 * MCP server and the test-only mount/retire owner are the only stand-ins.
 *
 * The case proves, from real processes and durable Session events:
 *   - A's live Agent can mount an Agent-scoped MCP server during `runMaintenance`
 *   - the official Agent Loop executes `mcp__b0scope__echo` and the MCP child
 *     receives the real `tools/call` with the case-generated nonce
 *   - Agent B's model-facing tools never carry A's scoped tool
 *   - the same Agent rejects a second same-name MCP instance while the first
 *     remains usable, and a temporary global tool is shadowed by the scoped one
 *   - a real ACP `session/close` leaves the TUI turn in flight; the test owner
 *     retires only Agent A after the durable `tool/result` + `turn/end`
 *
 * This is NOT a production `session/new|resume.mcpServers` admission and NOT a
 * production Close-to-MCP-dispose proof. Those remain G-ACP1B/B1 work.
 *
 * @module split-process/acp-scoped-mcp-b0
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  waitForHostSessionEventAfter,
} from '../../lib/split-smoke-sessions.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.scoped-mcp-b0'
const ECHO_TOOL = 'mcp__b0scope__echo'
const HOLD_TOOL = 'mcp__b0scope__hold'
const FAIL_TOOL = 'mcp__b0scope__fail'
const GLOBAL_MARKER = 'GLOBAL_ONLY'
const SENTINEL_PREFIX = 'B0_TEST_SENTINEL_'

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
  return content
    .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
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

function serverStartOf(proof, tag) {
  return [...proof].reverse().find(line => line.kind === 'server-start' && line.tag === tag)
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
  const connection = acp.client({ name: 'b0-scoped-mcp-qualification' })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
    .connect(stream)
  const client = {
    connection,
    updates,
    async request(method, params) {
      return await deadline(connection.agent.request(method, params), `ACP ${method}`)
    },
    async close() {
      connection.close()
      socket.destroy()
      await deadline(Promise.all([connection.closed, socketClosed]), 'ACP connection close', 30_000)
    },
  }
  try {
    const initialized = await client.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    return { client, initialized }
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

export async function runAcpScopedMcpB0(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context, { scopedMcpB0: true })
  if (typeof scene.c1Work.scopedMcpServerPath !== 'string') {
    throw new SplitSmokeAssertionError(`${CASE_ID}: the B0 MCP server fixture was not installed into the isolated profile`)
  }
  const b0WorkRoot = scene.c1WorkRoot('b0')
  const controlPath = join(b0WorkRoot, 'b0-control.json')
  const proofPath = join(b0WorkRoot, 'scoped-mcp-server.jsonl')
  const holdArm = join(b0WorkRoot, 'b0-hold-arm')
  const holdRelease = join(b0WorkRoot, 'b0-hold-release')
  const sentinel = `${SENTINEL_PREFIX}${digestOf(`${process.pid}-${Date.now()}`).slice(0, 24)}`
  const nonceEcho = `nonce-echo-${digestOf(`echo-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const nonceFail = `nonce-fail-${digestOf(`fail-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const nonceHold = `nonce-hold-${digestOf(`hold-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const nonceB = `nonce-b-${digestOf(`b-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const nonceBShadow = `nonce-b-shadow-${digestOf(`b-shadow-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const nonceAShadow = `nonce-a-shadow-${digestOf(`a-shadow-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const nonceBAfter = `nonce-b-after-${digestOf(`b-after-${process.pid}-${Date.now()}`).slice(0, 16)}`
  const workspace = join(workDir, 'b0-workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const hostCwd = realpathSync(workspace)

  const peers = []
  const acpClients = []
  const tuiPids = []
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
  const serverPids = new Set()
  let originalError

  const hostIdentityFacts = async () => await scene.hostIdentityFacts(host)
  const assertSameHost = async (before, label) => {
    const after = await hostIdentityFacts()
    assert(after.hostPid === before.hostPid, `${label}: the Host process was replaced (${String(before.hostPid)} -> ${String(after.hostPid)})`)
    assert(after.instanceId === before.instanceId, `${label}: the Host instanceId changed`)
    assert(after.scopeId === before.scopeId, `${label}: the Host scope changed`)
    await scene.assertHostIdentityKept(host, before, label)
  }

  const runDsh = args => {
    const [executable, ...prefix] = installation.dshInvocation
    const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', ...args], {
      cwd: installation.profileDir,
      env: installation.env,
      encoding: 'utf8',
      timeout: 120_000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  const daemonStatus = label => {
    const result = runDsh(['daemon', 'status'])
    assert(result.code === 0, `${label}: daemon status exited ${String(result.code)}: ${result.stderr.slice(-500)}`)
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
    const requestId = `b0-acp-access-${String(++sequence)}-${String(process.pid)}`
    process.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return await process.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }

  const control = async (action, fields = {}) => {
    const actionId = `b0-action-${String(++actionSequence)}-${String(process.pid)}`
    // Atomic publish: the fixture must never observe a truncated control file
    // between create and write.
    const temporary = `${controlPath}.tmp-${actionId}`
    writeFileSync(temporary, JSON.stringify({ actionId, action, ...fields }), { mode: 0o600 })
    renameSync(temporary, controlPath)
    return await waitForC1WorkEvent(b0WorkRoot, event => event.kind === 'b0-fact' && event.actionId === actionId,
      `${CASE_ID} control ${action}`, 180_000)
  }

  const openNewSession = async (client, label) => {
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
  const waitForEvent = async (sessionId, afterIndex, predicate, label, timeoutMs = 180_000) => {
    return await waitForHostSessionEventAfter(dshHome, sessionId, afterIndex, predicate, label, timeoutMs)
  }
  const waitForTurnEnd = async (sessionId, afterIndex, label) => {
    return await waitForEvent(sessionId, afterIndex, event => event.type === 'turn/end', label)
  }
  const sessionEventsAfter = (sessionId, index) => eventsOf(sessionId).slice(index)
  const findToolCall = (events, name) => events.find(event => event.type === 'tool/call' && eventData(event).name === name)
  const findToolResult = (events, callId) => events.find(event => event.type === 'tool/result' && toolResultCallIdOf(event) === callId)
  const modelRecords = (sessionId, marker) => readC1WorkEvents(b0WorkRoot)
    .filter(event => event.kind === 'b0-model-tools' && event.sessionId === sessionId && event.marker === marker)

  const assertNoSecretLeak = label => {
    const surfaces = [
      ['host records', JSON.stringify(host?.records ?? [])],
      ['host stderr', host?.stderr ?? ''],
      ['peer records', JSON.stringify(peers.map(process => process.records))],
      ['tui A records', JSON.stringify(tuiA?.records ?? [])],
      ['tui B records', JSON.stringify(tuiB?.records ?? [])],
      ['fixture events', readFileSync(join(b0WorkRoot, 'events.jsonl'), 'utf8')],
      ['MCP proof', readFileSync(proofPath, 'utf8')],
      ['Session A durable events', sessionA === undefined ? '' : JSON.stringify(eventsOf(sessionA))],
      ['Session B durable events', sessionB === undefined ? '' : JSON.stringify(eventsOf(sessionB))],
      ['ACP SDK updates', JSON.stringify(acpClients.map(client => client.updates))],
    ]
    const logsDir = join(dshHome, 'logs')
    if (existsSync(logsDir)) {
      for (const entry of readdirSync(logsDir)) {
        if (entry.endsWith('.log')) surfaces.push([`Host log ${entry}`, readFileSync(join(logsDir, entry), 'utf8')])
      }
    }
    const leaked = surfaces.filter(([, text]) => text.includes(sentinel)).map(([name]) => name)
    assert(leaked.length === 0, `${label}: test sentinel leaked into ${leaked.join(', ')}`)
  }

  try {
    // ── Q00: one REAL installed Host reaches Ready; enable the real ACP
    //     listener through the production PiTuiAcpAccess seam and confirm the
    //     authenticated endpoint through `daemon status`.
    const started = await scene.startC1Host('acp-scoped-mcp-b0', 'b0 host', {
      C1_B0_CONTROL: controlPath,
      C1_B0_MCP_SERVER: scene.c1Work.scopedMcpServerPath,
      C1_B0_PROOF: proofPath,
      C1_B0_HOLD_ARM: holdArm,
      C1_B0_HOLD_RELEASE: holdRelease,
      C1_B0_RUN_NONCE: nonceEcho,
      C1_B0_SECRET_SENTINEL: sentinel,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    }, b0WorkRoot)
    host = started.host
    const ready = started.ready
    hostIdentity = await hostIdentityFacts()
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'Q00: the Host Ready must publish a full 64-character scope id')
    assert(hostIdentity.hostPid === ready.localHost.hostPid, 'Q00: host status and Ready must name the same Host pid')
    assert(isHex64(context.candidateSha256), 'Q00: the candidate SHA256 must be a real 64-hex digest')
    assert(typeof context.targetDshVersion === 'string' && context.targetDshVersion.length > 0,
      'Q00: the exact installed DSH pin must be recorded')

    peer = await startPeer('b0 peer')
    const initialAccess = await acpAccess(peer, 'Q00 initial ACP status', undefined)
    assert(initialAccess.ok === true && initialAccess.status?.state === 'disabled',
      `Q00: the ACP listener must start disabled (${JSON.stringify(initialAccess)})`)
    const enabledAccess = await acpAccess(peer, 'Q00 enable ACP', true)
    assert(enabledAccess.ok === true && enabledAccess.status?.state === 'enabled',
      `Q00: the production ACP access seam must enable the listener (${JSON.stringify(enabledAccess)})`)
    const status = daemonStatus('Q00 daemon status')
    assert(status.host === 'ready', `Q00: daemon status must report the authenticated ready Host: ${JSON.stringify(status)}`)
    assert(status.acp === 'enabled', `Q00: daemon status must report acp=enabled: ${JSON.stringify(status)}`)
    const expectedSocket = process.platform === 'darwin'
      ? `/private/tmp/dpt-${String(process.getuid())}-${scopeId.slice(0, 40)}/acp.sock`
      : join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock')
    assert(status['acp-socket'] === expectedSocket,
      `Q00: daemon status must print the real logical endpoint ${expectedSocket}: ${JSON.stringify(status)}`)
    acpEndpoint = process.platform === 'darwin'
      ? { path: status['acp-socket'] }
      : { path: expectedSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', scopeId) }
    trace('acp-scoped-mcp-b0/q00', {
      candidateSha256: context.candidateSha256,
      dshVersion: context.targetDshVersion,
      bundleVersion: installation.manifest.version,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
      acpSocket: status['acp-socket'],
    })

    // ── Q01: two REAL TUI Sessions A and B on the SAME Host.
    const tuiAStarted = await scene.startC1Client('b0 tui A', {}, { cwd: hostCwd })
    tuiA = tuiAStarted.client
    const tuiBStarted = await scene.startC1Client('b0 tui B', {}, { cwd: hostCwd })
    tuiB = tuiBStarted.client
    if (Number.isInteger(tuiA.child?.pid)) tuiPids.push({ role: 'tui-A', pid: tuiA.child.pid })
    if (Number.isInteger(tuiB.child?.pid)) tuiPids.push({ role: 'tui-B', pid: tuiB.child.pid })
    sessionA = await openNewSession(tuiA, 'Q01 tui A')
    sessionB = await openNewSession(tuiB, 'Q01 tui B')
    assert(typeof sessionA === 'string' && typeof sessionB === 'string' && sessionA !== sessionB,
      'Q01: two distinct real Session ids must exist')
    const identityProbe = await control('probe-B', { sessionId: sessionA, sessionIdB: sessionB })
    assert(identityProbe.ok === true && identityProbe.agentASessionExact === true && identityProbe.agentBSessionExact === true,
      `Q01: the live Agent/Session identities must be exact: ${JSON.stringify(identityProbe)}`)
    assert(identityProbe.agentAId === sessionA && identityProbe.agentBId === sessionB,
      'Q01: each TUI Session must map to its own live Agent')
    await assertSameHost(hostIdentity, 'Q01 Host after two TUI Sessions')

    // ── Q02: real ACP v1 initialize + resume(A) against the live Host UDS.
    const openedA = await openSdkClient(acpEndpoint)
    const acpA = openedA.client
    acpClients.push(acpA)
    assert(openedA.initialized?.protocolVersion === 1, 'Q02: initialize must answer protocolVersion 1')
    assert(openedA.initialized?.agentInfo?.name === 'dsh-pi-tui', 'Q02: initialize must name dsh-pi-tui')
    const resumeA = await acpA.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd })
    assert(JSON.stringify(resumeA) === '{}', `Q02: session/resume(A) must return {} (got ${JSON.stringify(resumeA)})`)
    assert(surfaceSessionId(tuiA) === sessionA, 'Q02: the real TUI A must keep Session A after the ACP resume')
    await assertSameHost(hostIdentity, 'Q02 Host after ACP resume')

    // ── Q03: mount official McpClient on the live idle Agent A through
    //     runMaintenance; prove the real tool registration and the MCP child.
    const mounted = await control('mount-A', { sessionId: sessionA })
    assert(mounted.ok === true && mounted.connectionState === 'connected',
      `Q03: mount-A must activate a connected official MCP fiber: ${JSON.stringify(mounted)}`)
    assert(Array.isArray(mounted.toolNames) && mounted.toolNames.includes(ECHO_TOOL),
      `Q03: Agent A's official tool schemas must carry ${ECHO_TOOL}: ${JSON.stringify(mounted.toolNames)}`)
    assert(mounted.cwd === hostCwd, `Q03: the MCP child cwd must be the Host Session cwd ${hostCwd}`)
    assert(Number.isInteger(mounted.serverPid) && mounted.serverPpid === hostIdentity.hostPid,
      `Q03: the MCP child must be a real Host-owned process: ${JSON.stringify(mounted)}`)
    serverPids.add(mounted.serverPid)
    const probeAfterMount = await control('probe-B', { sessionId: sessionA, sessionIdB: sessionB })
    assert(probeAfterMount.agentAHasEcho === true && probeAfterMount.agentBHasEcho === false,
      `Q03: only Agent A may see the scoped tool: ${JSON.stringify(probeAfterMount)}`)
    const mountModelRecords = modelRecords(sessionA, 'B0_ECHO_A')
    assert(mountModelRecords.length === 0, 'Q03: mounting must not issue a model request')

    // ── Q04: ACP prompt -> real Agent Loop -> official ToolRuntime ->
    //     MCP stdio child -> durable tool/result -> turn/end.
    const beforeEcho = eventsOf(sessionA).length
    const echoResult = await acpA.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: `B0_ECHO_A ${nonceEcho}` }],
    })
    assert(echoResult?.stopReason === 'end_turn', `Q04: the ACP prompt must answer end_turn (got ${JSON.stringify(echoResult)})`)
    const echoTurnEnd = await waitForTurnEnd(sessionA, beforeEcho, 'Q04 ACP prompt turn/end')
    const echoEvents = sessionEventsAfter(sessionA, beforeEcho)
    const echoCall = findToolCall(echoEvents, ECHO_TOOL)
    assert(echoCall !== undefined, 'Q04: the Agent Loop must emit a durable tool/call for mcp__b0scope__echo')
    const echoCallId = toolCallIdOf(echoCall)
    const echoToolResult = findToolResult(echoEvents, echoCallId)
    assert(echoToolResult !== undefined, 'Q04: the official ToolRuntime must emit a durable tool/result')
    assert(toolResultText(echoToolResult).includes(nonceEcho),
      `Q04: the durable tool/result must carry the unique nonce ${nonceEcho}: ${toolResultText(echoToolResult)}`)
    assert(echoEvents.some(event => event.type === 'turn/end'), 'Q04: the ACP prompt must reach a durable turn/end')
    const echoProof = await waitForProof(line => line.kind === 'tools/call' && line.tag === 'b0scope',
      proofPath, 'Q04 MCP child tools/call')
    assert(echoProof.nonceDigest === digestOf(nonceEcho).slice(0, 16),
      'Q04: the MCP child must receive the same unique tools/call nonce')
    const echoModel = modelRecords(sessionA, 'B0_ECHO_A')
    assert(echoModel.some(record => record.afterTool === false && record.hasEchoTool === true),
      'Q04: the real model step must see the scoped tool in its own tools schema')
    assert(surfaceSessionId(tuiA) === sessionA, 'Q04: the real TUI A must stay attached after the ACP turn')
    await assertSameHost(hostIdentity, 'Q04 Host after the ACP tool turn')

    // ── Q05: Agent B isolation: its model tools have no target; an intentional
    //     same-name call is rejected as UNKNOWN_TOOL and never reaches A's MCP.
    const serverCallsBeforeB = countServerCalls(readProof(proofPath), 'b0scope')
    const beforeB = eventsOf(sessionB).length
    const bModelBefore = modelRecords(sessionB, 'B0_ECHO_B').length
    await sendTuiPrompt(tuiB, `B0_ECHO_B ${nonceB}`, 'Q05 tui B')
    await waitForTurnEnd(sessionB, beforeB, 'Q05 B turn/end')
    const bEvents = sessionEventsAfter(sessionB, beforeB)
    const bCall = findToolCall(bEvents, ECHO_TOOL)
    assert(bCall !== undefined, 'Q05: the scripted B model must attempt the same tool name')
    const bResult = findToolResult(bEvents, toolCallIdOf(bCall))
    assert(bResult !== undefined && eventData(bResult).message?.isError === true,
      'Q05: B\'s same-name call must fail as a real tool result error')
    assert(toolResultCode(bResult) === 'UNKNOWN_TOOL',
      `Q05: B's unknown tool must carry UNKNOWN_TOOL (got ${String(toolResultCode(bResult))})`)
    assert(countServerCalls(readProof(proofPath), 'b0scope') === serverCallsBeforeB,
      'Q05: B must never invoke Agent A\'s MCP child')
    const bModel = modelRecords(sessionB, 'B0_ECHO_B').slice(bModelBefore)
    assert(bModel.length > 0 && bModel.every(record => record.hasEchoTool === false),
      `Q05: every B model step must not see the scoped tool: ${JSON.stringify(bModel)}`)

    // ── Q06: same-Agent duplicate refusal + real global shadow.
    const duplicate = await control('mount-duplicate-A', { sessionId: sessionA })
    assert(duplicate.ok === true && duplicate.rejected === true && duplicate.firstConnectionState === 'connected'
      && duplicate.serverStartsBefore === duplicate.serverStartsAfter
      && typeof duplicate.serverStartsBefore === 'number'
      && typeof duplicate.error === 'string' && duplicate.error.includes('serverName "b0scope" is already in use'),
      `Q06: a second same-name MCP instance must be rejected without a second child: ${JSON.stringify(duplicate)}`)
    const shadow = await control('global-shadow-A', { sessionId: sessionA, sessionIdB: sessionB })
    assert(shadow.ok === true, `Q06: the temporary global shadow tool must exist with the expected scoped/global descriptions: ${JSON.stringify(shadow)}`)
    assert(Array.isArray(shadow.aToolNames) && shadow.aToolNames.includes(ECHO_TOOL)
      && Array.isArray(shadow.bToolNames) && shadow.bToolNames.includes(ECHO_TOOL),
      'Q06: both A (scoped) and B (global) must resolve the same public name')
    // The scoped definition must WIN for Agent A while the global one exists:
    // an actual A call still executes A's MCP child and never GLOBAL_ONLY.
    const beforeShadowA = eventsOf(sessionA).length
    const shadowAResult = await acpA.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: `B0_ECHO_A ${nonceAShadow}` }],
    })
    assert(shadowAResult?.stopReason === 'end_turn', 'Q06: A\'s scoped shadow turn must answer end_turn')
    await waitForTurnEnd(sessionA, beforeShadowA, 'Q06 A scoped shadow turn/end')
    const shadowAEvents = sessionEventsAfter(sessionA, beforeShadowA)
    const shadowACall = findToolCall(shadowAEvents, ECHO_TOOL)
    const shadowAResultEvent = shadowACall === undefined ? undefined : findToolResult(shadowAEvents, toolCallIdOf(shadowACall))
    assert(shadowAResultEvent !== undefined && toolResultText(shadowAResultEvent).includes(`b0-echo:${nonceAShadow}`)
      && !toolResultText(shadowAResultEvent).includes(GLOBAL_MARKER),
    'Q06: Agent A must execute its scoped MCP tool, never the global shadow body')
    const serverCallsBeforeShadow = countServerCalls(readProof(proofPath), 'b0scope')
    const beforeShadowB = eventsOf(sessionB).length
    const shadowModelBefore = modelRecords(sessionB, 'B0_ECHO_B').length
    await sendTuiPrompt(tuiB, `B0_ECHO_B ${nonceBShadow}`, 'Q06 shadow tui B')
    await waitForTurnEnd(sessionB, beforeShadowB, 'Q06 shadow B turn/end')
    const shadowEvents = sessionEventsAfter(sessionB, beforeShadowB)
    const shadowCall = findToolCall(shadowEvents, ECHO_TOOL)
    const shadowResult = shadowCall === undefined ? undefined : findToolResult(shadowEvents, toolCallIdOf(shadowCall))
    assert(shadowResult !== undefined && eventData(shadowResult).message?.isError !== true,
      'Q06: B\'s global shadow call must execute successfully')
    assert(toolResultText(shadowResult).includes(GLOBAL_MARKER),
      `Q06: B must execute the global tool body, not A's MCP server: ${toolResultText(shadowResult)}`)
    assert(countServerCalls(readProof(proofPath), 'b0scope') === serverCallsBeforeShadow,
      'Q06: the global shadow execution must not reach A\'s MCP child')
    const shadowModel = modelRecords(sessionB, 'B0_ECHO_B').slice(shadowModelBefore)
    assert(shadowModel.some(record => record.afterTool === false && record.hasEchoTool === true),
      "Q06: B's real model step must see the global shadow tool")
    const cleared = await control('clear-global-shadow', { sessionId: sessionA, sessionIdB: sessionB })
    assert(cleared.ok === true && Array.isArray(cleared.bToolNames) && !cleared.bToolNames.includes(ECHO_TOOL),
      `Q06: removing the global tool must restore B's negative tool set: ${JSON.stringify(cleared)}`)
    const serverCallsBeforeAfterClear = countServerCalls(readProof(proofPath), 'b0scope')
    const beforeAfterClear = eventsOf(sessionB).length
    const afterClearModelBefore = modelRecords(sessionB, 'B0_ECHO_B').length
    await sendTuiPrompt(tuiB, `B0_ECHO_B ${nonceBAfter}`, 'Q06 after-clear tui B')
    await waitForTurnEnd(sessionB, beforeAfterClear, 'Q06 after-clear B turn/end')
    const afterClearEvents = sessionEventsAfter(sessionB, beforeAfterClear)
    const afterClearCall = findToolCall(afterClearEvents, ECHO_TOOL)
    const afterClearResult = afterClearCall === undefined ? undefined : findToolResult(afterClearEvents, toolCallIdOf(afterClearCall))
    assert(afterClearResult !== undefined && toolResultCode(afterClearResult) === 'UNKNOWN_TOOL',
      'Q06: after removing the global tool B must be back to UNKNOWN_TOOL')
    const afterClearModel = modelRecords(sessionB, 'B0_ECHO_B').slice(afterClearModelBefore)
    assert(afterClearModel.length > 0 && afterClearModel.every(record => record.hasEchoTool === false),
      'Q06: after removing the global tool every B model step must be back to no target')
    assert(countServerCalls(readProof(proofPath), 'b0scope') === serverCallsBeforeAfterClear,
      'Q06: the after-clear negative must not reach A\'s MCP child')
    trace('acp-scoped-mcp-b0/q06', { duplicateError: duplicate.error, shadowA: shadow.aDescription, shadowB: shadow.bDescription })

    // ── Q10a: a real MCP `isError: true` result inside its own settled turn.
    const beforeFail = eventsOf(sessionA).length
    const failResult = await acpA.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: `B0_FAIL_A ${nonceFail}` }],
    })
    assert(failResult?.stopReason === 'end_turn', 'Q10a: the fail turn must still answer end_turn')
    await waitForTurnEnd(sessionA, beforeFail, 'Q10a fail turn/end')
    const failEvents = sessionEventsAfter(sessionA, beforeFail)
    const failCall = findToolCall(failEvents, FAIL_TOOL)
    const failToolResult = failCall === undefined ? undefined : findToolResult(failEvents, toolCallIdOf(failCall))
    assert(failToolResult !== undefined && eventData(failToolResult).message?.isError === true,
      'Q10a: the official tool/result must retain MCP isError=true')
    assert(failEvents.some(event => event.type === 'turn/end'), 'Q10a: the fail turn must reach a durable turn/end')
    const failProof = readProof(proofPath).find(line => line.kind === 'tools/call' && line.tag === 'b0scope' && line.rawName === 'fail')
    assert(failProof !== undefined, 'Q10a: the MCP child must receive the fail tools/call')

    // ── Q07: a REAL TUI A held MCP call, then a real ACP session/close that
    //     must NOT kill the Host, Agent, Session, or the in-flight TUI turn.
    writeFileSync(holdArm, 'armed\n', { mode: 0o600 })
    const beforeHold = eventsOf(sessionA).length
    await sendTuiPrompt(tuiA, `B0_HOLD_A ${nonceHold}`, 'Q07 tui A hold')
    const holdCall = await waitForEvent(sessionA, beforeHold,
      event => event.type === 'tool/call' && eventData(event).name === HOLD_TOOL,
      'Q07 durable TUI hold tool/call')
    const holdCallId = toolCallIdOf(holdCall)
    await waitForProof(line => line.kind === 'hold-received' && line.tag === 'b0scope', proofPath, 'Q07 MCP hold received')
    assert(findToolResult(sessionEventsAfter(sessionA, beforeHold), holdCallId) === undefined,
      'Q07: the held tool must still be in flight before the ACP close')
    const closeA = await acpA.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(JSON.stringify(closeA) === '{}', `Q07: a real ACP session/close(A) must return {} (got ${JSON.stringify(closeA)})`)
    assert(surfaceSessionId(tuiA) === sessionA, 'Q07: the TUI A must keep its Session after the ACP close')
    await assertSameHost(hostIdentity, 'Q07 Host after ACP close')
    assert(findToolResult(sessionEventsAfter(sessionA, beforeHold), holdCallId) === undefined,
      'Q07: ACP close must not pretend the in-flight TUI tool settled')

    // ── Q08: the test owner requests retirement only after close; the fixture
    //     must defer while the TUI tool is in flight, then dispose after the
    //     durable tool/result + turn/end.
    const retire = await control('request-retire-A', { sessionId: sessionA })
    assert(retire.ok === true && retire.retireRequested === true && retire.deferred === true
      && Array.isArray(retire.activeCallIds) && retire.activeCallIds.includes(holdCallId),
      `Q08: the retire request must be deferred by the real in-flight call: ${JSON.stringify(retire)}`)
    const holdServer = serverStartOf(readProof(proofPath), 'b0scope')
    assert(holdServer !== undefined && serverPids.has(holdServer.pid), 'Q08: the B0 MCP child must still be the same process')
    assert(readProof(proofPath).some(line => line.kind === 'hold-received' && line.pid === holdServer.pid),
      'Q08: the MCP child must still be alive while the hold call is pending')
    writeFileSync(holdRelease, 'released\n', { mode: 0o600 })
    await waitForEvent(sessionA, beforeHold, event => event.type === 'tool/result' && toolResultCallIdOf(event) === holdCallId,
      'Q08 durable held tool/result')
    await waitForTurnEnd(sessionA, beforeHold, 'Q08 held TUI turn/end')
    const holdResult = findToolResult(sessionEventsAfter(sessionA, beforeHold), holdCallId)
    assert(holdResult !== undefined && toolResultText(holdResult).includes(nonceHold),
      'Q08: the held TUI result must carry its exact nonce')
    const retired = await control('retire-after-terminal', { sessionId: sessionA })
    assert(retired.ok === true && retired.closure?.closeConfirmed === true && retired.closure?.cleanupError === undefined,
      `Q08: the official Fiber must report a confirmed closure: ${JSON.stringify(retired)}`)
    assert(Array.isArray(retired.toolNames) && !retired.toolNames.includes(ECHO_TOOL),
      'Q08: the scoped MCP tool must disappear after dispose')
    assert(retired.serverExited === true, 'Q08: the MCP child process must exit after dispose')

    // ── Q09: ACP can resume A again and the TUI A continues to work on the
    //     SAME Agent; the retired scoped tool stays absent for both Agents.
    await acpA.close()
    const openedResume = await openSdkClient(acpEndpoint)
    const acpResume = openedResume.client
    acpClients.push(acpResume)
    const resumeAgain = await acpResume.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd })
    assert(JSON.stringify(resumeAgain) === '{}', `Q09: A must stay resumable after the retire (got ${JSON.stringify(resumeAgain)})`)
    const beforePlain = eventsOf(sessionA).length
    await sendTuiPrompt(tuiA, `B0_PLAIN_A ${nonceEcho}`, 'Q09 tui A plain')
    await waitForTurnEnd(sessionA, beforePlain, 'Q09 TUI A turn/end')
    assert(hostAssistantHasText(sessionEventsAfter(sessionA, beforePlain), 'b0 plain settled'),
      'Q09: the TUI A must complete a real ordinary turn after the retire')
    const resumeProbe = await control('probe-B', { sessionId: sessionA, sessionIdB: sessionB })
    assert(resumeProbe.agentAHasEcho === false && resumeProbe.agentBHasEcho === false,
      `Q09: the retired scoped tool must stay absent for A and B: ${JSON.stringify(resumeProbe)}`)
    await assertSameHost(hostIdentity, 'Q09 Host after resume and TUI turn')
    await acpResume.close()

    // ── Q10b: deterministic initial handshake failure -> official rollback.
    const failing = await control('mount-failing-A', { sessionId: sessionA })
    assert(failing.ok === true && failing.rejected === true && failing.childExited === true
      && failing.closure?.closeConfirmed === true && failing.closure?.cleanupError === undefined,
      `Q10b: the failed MCP handshake must be rejected with confirmed cleanup: ${JSON.stringify(failing)}`)

    // ── Q10c: a connected MCP child is killed by its exact Host-owned pid;
    //     the official status turns failed and the Fiber disposal is confirmed.
    const crashMounted = await control('mount-crash-A', { sessionId: sessionA })
    assert(crashMounted.ok === true && crashMounted.connectionState === 'connected' && Number.isInteger(crashMounted.serverPid),
      `Q10c: the b0crash instance must connect first: ${JSON.stringify(crashMounted)}`)
    serverPids.add(crashMounted.serverPid)
    const crashed = await control('crash-failing-A', { sessionId: sessionA })
    assert(crashed.ok === true && crashed.connectionState === 'failed' && crashed.serverExited === true
      && crashed.closure?.closeConfirmed === true && crashed.closure?.cleanupError === undefined,
    `Q10c: a killed MCP child must settle as a real failed connection with confirmed cleanup: ${JSON.stringify(crashed)}`)
    await assertSameHost(hostIdentity, 'Q10c Host after MCP crash')
    const postCrashProbe = await control('probe-B', { sessionId: sessionA, sessionIdB: sessionB })
    assert(postCrashProbe.ok === true && postCrashProbe.agentAId === sessionA && postCrashProbe.agentBId === sessionB,
      'Q10c: the MCP crash must not replace the live Agent/Session identities')

    // ── Q11: all owned resources quiesce and the real TUI surfaces exit 0.
    assertNoSecretLeak('Q10')
    await scene.exitC1Client(tuiB, 'Q11 tui B')
    await scene.exitC1Client(tuiA, 'Q11 tui A')
    await acpA.close().catch(() => {})
    for (const pid of serverPids) assert(!alivePid(pid), `Q11: MCP child ${String(pid)} must not survive`)
    const peerExit = peer.exited ? undefined : await peer.shutdown()
    assert(peerExit === undefined || (peerExit.code === 0 && peerExit.signal === null),
      `Q11: the real peer must exit cleanly (${JSON.stringify(peerExit ?? { alreadyExited: true })})`)
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0 && hostExit.signal === null, `Q11: the real Host must exit cleanly (${JSON.stringify(hostExit)})`)
    await scene.awaitSceneSeatFree()
    assert(host.exited === true, 'Q11: the real Host process must exit')
    assert(!existsSync(acpEndpoint.path), 'Q11: the Host-owned ACP socket must be unlinked after shutdown')
    const proofFinal = readProof(proofPath)
    assert(proofFinal.some(line => line.kind === 'server-boot-fail' && line.tag === 'b0fail'), 'Q11: the boot-fail fixture must have run')
    assert(proofFinal.some(line => line.kind === 'server-start' && line.tag === 'b0crash'), 'Q11: the crash fixture must have connected')
    const evidence = {
      schema: 'gacp-b0-evidence/1',
      case_id: CASE_ID,
      platform: process.platform,
      candidate_sha256: context.candidateSha256,
      dsh_version: context.targetDshVersion,
      bundle_version: installation.manifest.version,
      host: {
        pid: hostIdentity.hostPid,
        instanceId: hostIdentity.instanceId,
        scopeId: hostIdentity.scopeId,
      },
      sessions: { A: sessionA, B: sessionB },
      mcp: {
        serverName: 'b0scope',
        processPid: mounted.serverPid,
        scope: 'agent-A',
      },
      call: {
        callId: echoCallId,
        nonceDigest: digestOf(nonceEcho),
        sessionId: sessionA,
        toolResultSeq: echoToolResult.seq,
        turnEndSeq: echoTurnEnd.seq,
      },
      close: {
        acpResult: closeA,
        retireOwnedBy: 'test-fixture',
        closureConfirmed: retired.closure?.closeConfirmed === true,
        cleanupError: retired.closure?.cleanupError ?? null,
      },
      negative: {
        agentBToolVisible: probeAfterMount.agentBHasEcho,
        duplicateRejected: duplicate.rejected === true,
        duplicateServerStarted: duplicate.serverStartsAfter !== duplicate.serverStartsBefore,
        duplicateClosureConfirmed: duplicate.duplicateClosure?.closeConfirmed === true,
        globalShadowObserved: shadow.ok === true,
        collisionGuardRequired: shadow.collisionGuardRequired === true,
        retireDeferredDuringTuiCall: retire.deferred === true,
        secretLeak: false,
      },
      quiesced: true,
      verdict: 'PASS',
    }
    assert(isHex64(evidence.candidate_sha256), 'evidence: candidate SHA256 must be a real digest')
    assert(Number.isInteger(evidence.host.pid) && evidence.host.pid > 0, 'evidence: Host pid must be real')
    assert(Number.isInteger(evidence.mcp.processPid) && evidence.mcp.processPid > 0, 'evidence: MCP child pid must be real')
    assert(evidence.negative.agentBToolVisible === false, 'evidence: Agent B must not see the scoped tool')

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      liveAgentScopedMount: true,
      officialAgentLoopToolCall: true,
      mcpChildStdioCall: true,
      agentBIsolation: true,
      duplicateSameAgentRejected: true,
      globalShadowObserved: true,
      acpCloseKeepsTui: true,
      retireDeferredDuringTuiCall: true,
      retireAfterTerminalClosure: true,
      tuiContinuesAfterRetire: true,
      initialHandshakeFailureRolledBack: true,
      crashCleanupConfirmed: true,
      hostIdentityKept: true,
      mcpChildPids: mounted.serverPid,
      l6EvidenceRecorded: true,
      evidence,
    }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    try { writeFileSync(holdRelease, 'released\n', { mode: 0o600 }) } catch { /* best-effort unblock */ }
    for (const client of acpClients) {
      try { await client.close() } catch { /* already gone */ }
    }
    for (const peerProcess of peers) {
      if (peerProcess.exited) continue
      try { await peerProcess.shutdown() } catch { /* the runner backstop owns leftovers */ }
    }
    try { await scene.dispose() } catch { /* the global backstop owns leftovers */ }
    try { await scene.awaitSceneSeatFree().catch(() => {}) } catch { /* seat proof is best effort on failure */ }
    void originalError
  }
}

function alivePid(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
