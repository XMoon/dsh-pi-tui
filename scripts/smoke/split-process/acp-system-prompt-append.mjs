/**
 * G-ACP2 supplemental PR-B — real packaged ACP v1 client system prompt append.
 *
 * ONE real installed Split Host + real TUI Client + independent official ACP v1
 * SDK clients. The case proves the advertised `sessionCapabilities.systemPrompt`
 * contract end to end: a valid `append` becomes ONE ordinary official scoped
 * section in the EXACT Agent's Cordis scope (so the human TUI turn on the SAME
 * Session receives it), the real model request is the sink, a sibling Session
 * or a retired View never receives it, the official complete minimal preset
 * legitimately suppresses it, and close / same-connection reattach / null /
 * Off retire the contribution before the View is released. The scripted
 * offline model only records sanitized request facts; one narrow run-owned
 * control action invokes the SAME official `agentPresets.select` the TUI
 * `/preset` command dispatches (complete minimal preset), and no production
 * hook is added.
 *
 * @module split-process/acp-system-prompt-append
 */

import { closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.system-prompt-append'
const MARKER_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']

function markerOf(id) {
  return `ACP_SYSTEM_PROMPT_APPEND_${id}_MARKER`
}

function appendRequest(id, extraBlock) {
  return {
    mode: 'append',
    content: [
      { type: 'text', text: markerOf(id) },
      ...(extraBlock === undefined ? [] : [{ type: 'text', text: extraBlock }]),
    ],
  }
}

function requireFact(condition, label) {
  if (!condition) throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}`)
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
  const app = acp.client({ name: 'acp-system-prompt-append-qualification' })
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

async function expectRequestError(promise, label) {
  try {
    await promise
  } catch (error) {
    requireFact(error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
      `${label}: expected LOCAL_ACP_VIEW_INVALID_REQUEST, got ${JSON.stringify({ code: error?.code, data: error?.data })}`)
    requireFact(error?.code === -32602, `${label}: expected -32602, got ${JSON.stringify(error?.code)}`)
    return
  }
  throw new SplitSmokeAssertionError(`${CASE_ID}: ${label} unexpectedly succeeded`)
}

export async function runAcpSystemPromptAppend(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context)
  const workRoot = scene.c1WorkRoot('acp-system-prompt')
  const controlPath = join(workRoot, 'acp-system-prompt-control.json')
  const holdBarrier = join(workRoot, 'acp-system-prompt-hold.release')
  const workspace = join(workDir, 'acp-system-prompt-workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const hostCwd = realpathSync(workspace)
  const peers = []
  const acpClients = []
  let tui
  let host
  let hostIdentity
  let actionSequence = 0
  let endpoint
  let sessionA
  let sessionC
  let conn1
  let conn2
  let sequence = 0

  const hostIdentityFacts = async () => await scene.hostIdentityFacts(host)
  const assertSameHost = async (before, label) => {
    const after = await hostIdentityFacts()
    requireFact(after.hostPid === before.hostPid && after.instanceId === before.instanceId
      && after.scopeId === before.scopeId, `${label}: the Host identity changed`)
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
    requireFact(result.status === 0, `${label}: daemon status exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
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
    const requestId = `asp-acp-access-${String(++sequence)}-${String(process.pid)}`
    process.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return await process.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const openClient = async (label, onUpdate) => {
    const client = await openSdkClient(endpoint, onUpdate, async () => ({ outcome: { outcome: 'cancelled' } }))
    acpClients.push(client)
    const initialized = await client.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    requireFact(initialized?.protocolVersion === 1, `${label}: initialize must answer v1`)
    return { client, initialized }
  }
  const closeClient = async client => { await client.close().catch(() => {}) }
  const openNewTui = async (client, label) => {
    // Type, prove the command is painted, then submit as a separate real key
    // (a coalesced PTY write can keep the CR inside the editor's paste path).
    client.send('/new')
    await client.waitForScreen('/new', `${label} command painted`, 120_000)
    await sleep(100)
    client.send('\r')
    await sleep(100)
    const status = await waitForSurfaceStatus(client, record => record.sessionOpen === true
      && typeof record.openSessionId === 'string' && record.openSessionId !== ''
      && record.transport === 'connected', `${label} Session open`, 180_000)
    return status.openSessionId
  }
  const sendTuiPrompt = async (client, text, label) => {
    // Type, prove the draft is painted, then submit as ONE separate real key.
    // A single write with the text can be coalesced into the editor's paste
    // path on some PTY/timing combinations, so the submit key is explicit.
    client.send(text)
    await client.waitForScreen(text.slice(0, Math.min(32, text.length)), `${label} prompt painted`, 120_000)
    await sleep(100)
    client.send('\r')
    await sleep(100)
  }
  const turnEndAfter = async (sessionId, afterIndex, label) =>
    await waitForHostSessionEventAfter(dshHome, sessionId, afterIndex, event => event.type === 'turn/end', label, 180_000)
  /**
   * Wait for a model request record of one Session that appeared AFTER
   * `fromCount` (the proof-file length captured before the triggering action).
   * The same Session legitimately produces several records with identical
   * system text, so a plain "first match" wait could return an earlier turn.
   */
  const sessionMarker = async (sessionId, label, predicate, fromCount, promptTag, root = workRoot) => {
    const started = Date.now()
    while (Date.now() - started < 180_000) {
      const match = readC1WorkEvents(root).slice(fromCount)
        .find(event => event.kind === 'acp-system-prompt-request'
          && event.sessionId === sessionId && predicate(event)
          && (promptTag === undefined || event.promptTag === promptTag))
      if (match !== undefined) return match
      await sleep(25)
    }
    throw new SplitSmokeAssertionError(`${CASE_ID}: ${label} timed out`)
  }
  const allMarkerCounts = (request, channel = 'markers') =>
    MARKER_IDS.map(id => request[channel]?.[id] ?? 0)
  const assertOnly = (request, label, expected) => {
    for (const id of MARKER_IDS) {
      requireFact((request.markers?.[id] ?? 0) === (expected === id ? 1 : 0),
        `${label}: marker ${id} count was ${String(request.markers?.[id])}, expected ${expected === id ? 1 : 0}`)
    }
  }
  const systemNodes = sessionId => (hostSessionEvents(dshHome, sessionId) ?? [])
    .filter(event => event.type === 'system/message')

  try {
    const started = await scene.startC1Host('acp-system-prompt', 'asp host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_SYSTEM_PROMPT_CONTROL: controlPath,
      C1_SYSTEM_PROMPT_HOLD: holdBarrier,
    }, workRoot)
    host = started.host
    const ready = started.ready
    hostIdentity = await hostIdentityFacts()
    requireFact(typeof ready.localHost?.scopeId === 'string' && ready.localHost.scopeId.length === 64,
      'Host Ready must publish the scope id')
    requireFact(/^[0-9a-f]{64}$/u.test(context.candidateSha256), 'candidate SHA256 must be a real digest')

    const peer = await startPeer('asp peer')
    const disabled = await acpAccess(peer, 'ASP-01 initial ACP status', undefined)
    requireFact(disabled.ok === true && disabled.status?.state === 'disabled', `ASP-01: ACP must start disabled: ${JSON.stringify(disabled)}`)
    const enabled = await acpAccess(peer, 'ASP-01 enable ACP', true)
    requireFact(enabled.ok === true && enabled.status?.state === 'enabled', `ASP-01: ACP must enable: ${JSON.stringify(enabled)}`)
    const status = daemonStatus('ASP-01 daemon status')
    const expectedSocket = process.platform === 'darwin'
      ? `/private/tmp/dpt-${String(process.getuid())}-${ready.localHost.scopeId.slice(0, 40)}/acp.sock`
      : join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'acp.sock')
    requireFact(status['acp-socket'] === expectedSocket, `ASP-01: daemon status endpoint: ${JSON.stringify(status)}`)
    endpoint = process.platform === 'darwin'
      ? { path: status['acp-socket'] }
      : { path: expectedSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId) }
    const tuiStarted = await scene.startC1Client('asp tui', {}, { cwd: hostCwd })
    tui = tuiStarted.client
    sessionA = await openNewTui(tui, 'ASP-02 TUI A')
    requireFact(typeof sessionA === 'string' && sessionA.length > 0, 'ASP-02: the TUI Session must be real')
    // ASP-03: the frozen capability is advertised on a real Host (append only).
    const main = await openClient('ASP-03', () => {})
    conn1 = main.client
    const sessionCaps = main.initialized.agentCapabilities?.sessionCapabilities
    requireFact(sessionCaps?.systemPrompt !== undefined && sessionCaps.systemPrompt?.mode?.override === undefined,
      `ASP-03: systemPrompt append must be advertised without override: ${JSON.stringify(sessionCaps)}`)
    requireFact(main.initialized.agentCapabilities?.loadSession === true
      && sessionCaps.resume !== undefined && sessionCaps.close !== undefined && sessionCaps.list !== undefined,
    'ASP-03: the real View still advertises load/list/resume/close')
    // ASP-04: invalid values are invalid params before any Host effect.
    await expectRequestError(conn1.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [], systemPrompt: { mode: 'override', content: [{ type: 'text', text: 'x' }] },
    }), 'ASP-04 override mode')
    await expectRequestError(conn1.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: { mode: 'append', content: [] },
    }), 'ASP-04 empty content')
    await expectRequestError(conn1.request(acp.methods.agent.session.load, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [],
      systemPrompt: { mode: 'append', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    }), 'ASP-04 non-text content')
    // ASP-05: valid append on the shared Session, visible to the human TUI turn.
    const resumedA = await conn1.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [],
      systemPrompt: appendRequest('A', 'second block {{literal}}'),
    })
    // ACP v1 `session/resume` returns only optional mode/config state, never a
    // second session id; the settled object is the proof the attach succeeded.
    requireFact(resumedA !== null && typeof resumedA === 'object', `ASP-05: resume A must settle: ${JSON.stringify(resumedA)}`)
    const aBefore = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const sharedFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-tui-a', 'ASP-05 TUI shared A')
    let sharedA
    try {
      sharedA = await sessionMarker(sessionA, 'TUI shared A', request => request.markers?.A === 1, sharedFrom, 'asp-tui-a')
    } catch (error) {
      const frame = await tui.viewport().catch(() => [])
      throw new SplitSmokeAssertionError(`${CASE_ID}: TUI shared A timed out; screen=${JSON.stringify(frame.slice(-24))}`)
    }
    requireFact(sharedA.literalPreserved === true && sharedA.harnessIdentity === true,
      'ASP-05: the TUI turn on the SAME Agent must carry the literal append and the default instructions')
    requireFact((sharedA.systemChannelMarkers?.A ?? 0) + (sharedA.historyChannelMarkers?.A ?? 0) === 1,
      'ASP-05: the append must be present exactly once across the effective system channels')
    await turnEndAfter(sessionA, aBefore, 'ASP-05 TUI turn end')

    // ASP-06: the ACP-owned prompt of the same View carries it too.
    const acpFrom = readC1WorkEvents(workRoot).length
    const promptA = await conn1.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-acp-a' }],
    })
    requireFact(promptA?.stopReason === 'end_turn', `ASP-06: ACP prompt stop reason: ${JSON.stringify(promptA)}`)
    const acpA = await sessionMarker(sessionA, 'ACP prompt A', request => request.markers?.A === 1, acpFrom, 'asp-acp-a')
    requireFact(acpA.markers?.B === 0, 'ASP-06: Session A must never see the other View marker')

    // ASP-07: a second Session/connection is isolated in both directions.
    const second = await openClient('ASP-07', () => {})
    conn2 = second.client
    const createdB = await conn2.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('B'),
    })
    const sessionB = createdB?.sessionId
    requireFact(typeof sessionB === 'string' && sessionB !== sessionA, `ASP-07: Session B: ${JSON.stringify(createdB)}`)
    const bFrom = readC1WorkEvents(workRoot).length
    const promptB = await conn2.request(acp.methods.agent.session.prompt, {
      sessionId: sessionB, prompt: [{ type: 'text', text: 'asp-acp-b' }],
    })
    requireFact(promptB?.stopReason === 'end_turn', `ASP-07: B prompt: ${JSON.stringify(promptB)}`)
    const requestB = await sessionMarker(sessionB, 'ACP prompt B', request => request.markers?.B === 1, bFrom, 'asp-acp-b')
    assertOnly(requestB, 'ASP-07 B request', 'B')
    const a2From = readC1WorkEvents(workRoot).length
    const promptA2 = await conn1.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-acp-a2' }],
    })
    requireFact(promptA2?.stopReason === 'end_turn', 'ASP-07: A remains usable')
    const requestA2 = await sessionMarker(sessionA, 'ACP prompt A2', request => request.markers?.A === 1, a2From, 'asp-acp-a2')
    assertOnly(requestA2, 'ASP-07 A request', 'A')

    // ASP-07b: a real formal child owns its OWN Agent scope; the parent append
    // must never reach the child's model request.
    const childTurnBefore = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const childFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-child-parent', 'ASP-07b TUI child parent')
    const delegation = await sessionMarker(sessionA, 'ASP-07b parent request', request => request.markers?.A === 1, childFrom, 'asp-child-parent')
    requireFact(delegation.markers?.A === 1, 'ASP-07b: the parent request keeps its append')
    const childStart = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'subagent-start', 'ASP-07b formal child start', 120_000)
    const childId = childStart.childId
    requireFact(typeof childId === 'string' && childId !== sessionA,
      `ASP-07b: a real formal child Session must exist: ${JSON.stringify(childStart)}`)
    const childRequest = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'acp-system-prompt-request' && event.sessionId === childId
        && event.promptTag === 'asp-child-task',
      'ASP-07b formal child request', 120_000)
    requireFact(allMarkerCounts(childRequest).every(count => count === 0),
      `ASP-07b: the formal child must never inherit the parent append: ${JSON.stringify(childRequest.markers)}`)
    await turnEndAfter(sessionA, childTurnBefore, 'ASP-07b child parent turn end')

    // ASP-08: a close during an ACTIVE foreign TUI turn only retires the ACP
    // contribution; the already-sampled request is not withdrawn, the same
    // turn's next step carries none, and the foreign turn ends normally.
    const heldTurnBefore = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const heldFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-hold-a', 'ASP-08 TUI held A')
    const heldRequest = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'acp-system-prompt-held' && event.sessionId === sessionA
        && event.promptTag === 'asp-hold-a',
      'ASP-08 held foreign request', 120_000)
    requireFact(heldRequest.markers?.A === 1, 'ASP-08: the already-sampled foreign request keeps the append')
    const closedA = await conn1.request(acp.methods.agent.session.close, { sessionId: sessionA })
    requireFact(closedA !== null && typeof closedA === 'object', 'ASP-08: close during the foreign turn must settle')
    writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
    const postHold = await sessionMarker(sessionA, 'ASP-08 post-detach step',
      request => request.afterTool === true && request.markers?.A === 0, heldFrom, 'asp-hold-a')
    requireFact(allMarkerCounts(postHold).every(count => count === 0),
      'ASP-08: the next step of the held foreign turn must not consume the retired append')
    await turnEndAfter(sessionA, heldTurnBefore, 'ASP-08 held foreign turn end')
    requireFact((hostSessionEvents(dshHome, sessionA) ?? []).slice(heldTurnBefore)
      .some(event => event.type === 'assistant/message'), 'ASP-08: the foreign turn must complete normally')

    const aAfterClose = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const afterCloseFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-tui-after-close', 'ASP-08 TUI after close')
    const afterClose = await sessionMarker(sessionA, 'TUI after close', request => allMarkerCounts(request).every(count => count === 0)
      && request.harnessIdentity === true, afterCloseFrom, 'asp-tui-after-close')
    requireFact(afterClose.markers?.A === 0, 'ASP-08: the retired append must not reach the next real turn')
    await turnEndAfter(sessionA, aAfterClose, 'ASP-08 TUI turn end')
    const repeatedClose = await conn1.request(acp.methods.agent.session.close, { sessionId: sessionA })
    requireFact(repeatedClose !== null && typeof repeatedClose === 'object', 'ASP-08: a repeated close stays idempotent')

    // ASP-09: a fresh attach after close carries the value; a same-connection
    // reattach with null clears it. (Replacement on a live reattach is covered
    // by the owner tests, where the outgoing generation is observable.)
    await conn1.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('C'),
    })
    const cFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-tui-c', 'ASP-09 TUI C')
    const requestC = await sessionMarker(sessionA, 'TUI C', request => request.markers?.C === 1, cFrom, 'asp-tui-c')
    assertOnly(requestC, 'ASP-09 C request', 'C')
    // The REAL live reattach replaces the value on the SAME connection.
    await conn1.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('H'),
    })
    const hFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-tui-h', 'ASP-09 TUI H')
    const requestH = await sessionMarker(sessionA, 'TUI H', request => request.markers?.H === 1, hFrom, 'asp-tui-h')
    assertOnly(requestH, 'ASP-09 H request', 'H')
    await conn1.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: null,
    })
    const clearedFrom = readC1WorkEvents(workRoot).length
    await sendTuiPrompt(tui, 'asp-tui-cleared', 'ASP-09 TUI cleared')
    const cleared = await sessionMarker(sessionA, 'TUI cleared', request => allMarkerCounts(request).every(count => count === 0), clearedFrom, 'asp-tui-cleared')
    requireFact(cleared.literalPreserved === false, 'ASP-09: null must clear the literal append too')

    // ASP-10: cold load carries no opaque value; an explicit resend applies.
    await conn1.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeClient(conn1)
    conn1 = undefined
    const loader = await openClient('ASP-10', () => {})
    const loaded = await loader.client.request(acp.methods.agent.session.load, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [],
    })
    requireFact(loaded !== null && typeof loaded === 'object', 'ASP-10: plain cold load must succeed')
    const coldFrom = readC1WorkEvents(workRoot).length
    const loadPrompt = await loader.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-load-no-append' }],
    })
    requireFact(loadPrompt?.stopReason === 'end_turn', 'ASP-10: loaded prompt must answer end_turn')
    const coldRequest = await sessionMarker(sessionA, 'cold load request', request => allMarkerCounts(request).every(count => count === 0), coldFrom, 'asp-load-no-append')
    requireFact(systemNodes(sessionA).some(node => JSON.stringify(node).includes(markerOf('A'))),
      'ASP-10: the original durable system record is retained (never rewritten)')
    await loader.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeClient(loader.client)
    const resender = await openClient('ASP-10b', () => {})
    await resender.client.request(acp.methods.agent.session.load, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('D'),
    })
    const resendFrom = readC1WorkEvents(workRoot).length
    const resendPrompt = await resender.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-load-resend' }],
    })
    requireFact(resendPrompt?.stopReason === 'end_turn', 'ASP-10: explicit append resend must answer end_turn')
    const resendRequest = await sessionMarker(sessionA, 'cold load resend', request => request.markers?.D === 1, resendFrom, 'asp-load-resend')
    assertOnly(resendRequest, 'ASP-10 resend request', 'D')
    await resender.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeClient(resender.client)

    // ASP-11: the official complete minimal preset keeps its authority.
    sessionC = await openNewTui(tui, 'ASP-11 TUI C')
    // The complete-preset owner is the SAME official `agentPresets.select` the
    // TUI `/preset` command dispatches; the fixture invokes it through a narrow
    // run-owned control action, so this case never re-implements or races the
    // TUI command surface.
    const presetActionId = `asp-preset-${String(++actionSequence)}`
    const presetTemporary = `${controlPath}.tmp-${presetActionId}`
    writeFileSync(presetTemporary, JSON.stringify({
      actionId: presetActionId, action: 'select-preset', sessionId: sessionC, preset: 'minimal',
    }), { mode: 0o600 })
    renameSync(presetTemporary, controlPath)
    const presetControl = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'acp-system-prompt-control' && event.actionId === presetActionId,
      'ASP-11 official preset select', 120_000)
    requireFact(presetControl.ok === true && presetControl.preset === 'minimal',
      `ASP-11: the official blank-session preset select must commit minimal: ${JSON.stringify(presetControl)}`)
    const presetRecordDeadline = Date.now() + 15_000
    for (;;) {
      const recorded = (hostSessionEvents(dshHome, sessionC) ?? [])
        .some(event => event.type === 'agent-preset/selected' && event.data?.agentPreset === 'minimal')
      if (recorded) break
      if (Date.now() > presetRecordDeadline) {
        throw new SplitSmokeAssertionError(`${CASE_ID}: ASP-11: the durable agent-preset/selected record did not appear`)
      }
      await sleep(50)
    }
    const completer = await openClient('ASP-11', () => {})
    await completer.client.request(acp.methods.agent.session.resume, {
      sessionId: sessionC, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('E'),
    })
    const completeFrom = readC1WorkEvents(workRoot).length
    const completePrompt = await completer.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionC, prompt: [{ type: 'text', text: 'asp-complete' }],
    })
    requireFact(completePrompt?.stopReason === 'end_turn', 'ASP-11: the complete preset prompt must answer end_turn')
    const completeRequest = await sessionMarker(sessionC, 'complete request', request => request.markers?.E === 0, completeFrom, 'asp-complete')
    requireFact(completeRequest.harnessIdentity === false && completeRequest.systemLength < 1024,
      `ASP-11: the complete minimal prompt must be the sole authority: ${JSON.stringify(completeRequest)}`)
    await completer.client.request(acp.methods.agent.session.close, { sessionId: sessionC })
    await closeClient(completer.client)

    // ASP-12: Off retires the live contribution; On serves a fresh View.
    const fresh = await openClient('ASP-12', () => {})
    await fresh.client.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('F'),
    })
    const disabledAgain = await acpAccess(peer, 'ASP-12 disable ACP', false)
    requireFact(disabledAgain.ok === true && disabledAgain.status?.state === 'disabled', 'ASP-12: ACP must disable')
    for (let attempt = 0; attempt < 400 && existsSync(endpoint.path); attempt += 1) await sleep(10)
    requireFact(!existsSync(endpoint.path), 'ASP-12: Off must retire the socket')
    const enabledAgain = await acpAccess(peer, 'ASP-12 re-enable ACP', true)
    requireFact(enabledAgain.ok === true && enabledAgain.status?.state === 'enabled', 'ASP-12: ACP must enable again')
    endpoint = process.platform === 'darwin'
      ? { path: daemonStatus('ASP-12 status')['acp-socket'] }
      : { path: expectedSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId) }
    const afterOff = await openClient('ASP-12b', () => {})
    await afterOff.client.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('G'),
    })
    const offFrom = readC1WorkEvents(workRoot).length
    const offPrompt = await afterOff.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-after-off' }],
    })
    requireFact(offPrompt?.stopReason === 'end_turn', 'ASP-12: the post-Off View must serve a real turn')
    const offRequest = await sessionMarker(sessionA, 'post-Off request', request => request.markers?.G === 1, offFrom, 'asp-after-off')
    assertOnly(offRequest, 'ASP-12 post-Off request', 'G')
    await afterOff.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeClient(afterOff.client)

    await assertSameHost(hostIdentity, 'ASP-13')
    requireFact(!host.exited, 'ASP-13: the Host must survive the whole case')
    requireFact(conn2 !== undefined, 'ASP-13: the second connection was established')
    await closeClient(conn2)
    conn2 = undefined

    // ASP-14: REAL cold recovery. Stop the TUI/peer/Host, boot a new Host on the
    // same profile and Session store, and prove the SAME Session resumes with
    // its effective default; the old append is never resurrected from history,
    // and an explicit resend applies exactly once on the cold View.
    const beforeCold = hostIdentity
    await scene.exitC1Client(tui, 'ASP-14 TUI')
    tui = undefined
    await peer.shutdown()
    await host.shutdown()
    requireFact(host.exited, 'ASP-14: the old Host must really stop before the cold resume')
    const coldWorkRoot = scene.c1WorkRoot('asp cold host')
    const coldStarted = await scene.startC1Host('acp-system-prompt', 'asp cold host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_SYSTEM_PROMPT_CONTROL: join(coldWorkRoot, 'acp-system-prompt-control.json'),
      C1_SYSTEM_PROMPT_HOLD: join(coldWorkRoot, 'acp-system-prompt-hold.release'),
    }, coldWorkRoot)
    host = coldStarted.host
    const coldIdentity = await hostIdentityFacts()
    requireFact(coldIdentity.hostPid !== beforeCold.hostPid
      && coldIdentity.instanceId !== beforeCold.instanceId
      && coldIdentity.scopeId === beforeCold.scopeId,
    'ASP-14: the cold Host must be a NEW process on the SAME profile scope')
    const coldPeer = await startPeer('asp cold peer')
    const coldAccess = await acpAccess(coldPeer, 'ASP-14 cold enable ACP', true)
    requireFact(coldAccess.ok === true && coldAccess.status?.state === 'enabled', 'ASP-14: the cold Host ACP must enable')
    const coldStatus = daemonStatus('ASP-14 cold daemon status')
    const coldScopeId = coldStarted.ready.localHost?.scopeId
    requireFact(typeof coldScopeId === 'string' && coldScopeId.length === 64, 'ASP-14: the cold Host must publish its scope id')
    const coldSocket = process.platform === 'darwin'
      ? `/private/tmp/dpt-${String(process.getuid())}-${coldScopeId.slice(0, 40)}/acp.sock`
      : join(dshHome, 'run', 'dsh-pi-tui', coldScopeId, 'acp.sock')
    requireFact(coldStatus['acp-socket'] === coldSocket, `ASP-14: the cold ACP endpoint: ${JSON.stringify(coldStatus)}`)
    endpoint = process.platform === 'darwin'
      ? { path: coldStatus['acp-socket'] }
      : { path: coldSocket, dir: join(dshHome, 'run', 'dsh-pi-tui', coldScopeId) }
    const cold = await openClient('ASP-14', () => {})
    await cold.client.request(acp.methods.agent.session.load, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: null,
    })
    const coldBootFrom = readC1WorkEvents(coldWorkRoot).length
    const coldPrompt = await cold.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-cold-resume' }],
    })
    requireFact(coldPrompt?.stopReason === 'end_turn', 'ASP-14: the cold null resume must serve a real turn')
    const coldBootRequest = await sessionMarker(sessionA, 'ASP-14 cold resume request',
      request => allMarkerCounts(request).every(count => count === 0), coldBootFrom, 'asp-cold-resume', coldWorkRoot)
    requireFact(coldBootRequest.sessionId === sessionA, 'ASP-14: the cold resume must keep the exact Session id')
    requireFact(coldBootRequest.harnessIdentity === true && coldBootRequest.systemLength > 0,
      'ASP-14: an omitted/null cold resume uses the Host effective default instructions')
    requireFact(systemNodes(sessionA).some(node => JSON.stringify(node).includes(markerOf('A'))),
      'ASP-14: the original canonical system record is retained (never rewritten)')
    await cold.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await cold.client.request(acp.methods.agent.session.load, {
      sessionId: sessionA, cwd: hostCwd, mcpServers: [], systemPrompt: appendRequest('I'),
    })
    const coldResendFrom = readC1WorkEvents(coldWorkRoot).length
    const coldResendPrompt = await cold.client.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: 'asp-cold-resend' }],
    })
    requireFact(coldResendPrompt?.stopReason === 'end_turn', 'ASP-14: the explicit cold resend must serve a real turn')
    const coldResendRequest = await sessionMarker(sessionA, 'ASP-14 cold resend request',
      request => request.markers?.I === 1, coldResendFrom, 'asp-cold-resend', coldWorkRoot)
    assertOnly(coldResendRequest, 'ASP-14 cold resend request', 'I')
    requireFact(coldResendRequest.markers?.A === 0, 'ASP-14: the pre-restart append is never resurrected')
    await cold.client.request(acp.methods.agent.session.close, { sessionId: sessionA })
    await closeClient(cold.client)
    requireFact(!host.exited, 'ASP-14: the cold Host must survive the cold resume')
    await coldPeer.shutdown()

    const result = {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      officialSdkClient: true,
      appendAdvertised: true,
      overrideNotAdvertised: true,
      invalidValuesRejected: true,
      tuiSharedAgent: true,
      acpOwnedPrompt: true,
      siblingIsolated: true,
      closeRetired: true,
      foreignTurnHeld: true,
      formalChildIsolated: true,
      reattachReplaced: true,
      nullCleared: true,
      coldLoadNoCarrier: true,
      explicitResendApplied: true,
      coldHostRestart: true,
      coldResumeNoCarrier: true,
      coldResendOnce: true,
      completePresetSuppressed: true,
      offRetired: true,
      onFreshView: true,
      hostIdentityKept: true,
      candidateSha256: context.candidateSha256,
      sessionA,
      sessionB: createdB?.sessionId,
      sessionC,
      evidence: {
        sharedA,
        acpA,
        requestB,
        requestA2,
        childRequest,
        heldRequest,
        postHold,
        afterClose,
        requestC,
        requestH,
        cleared,
        coldRequest,
        resendRequest,
        completeRequest,
        offRequest,
        coldBootRequest,
        coldResendRequest,
      },
    }
    context.trace(`${CASE_ID}/evidence`, result)
    return result
  } finally {
    await scene.dispose()
  }
}
