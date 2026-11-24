/**
 * G-ACP2-PR2 L6: official session facts projected on the stable ACP v1 wire.
 *
 * ONE real installed Host owns the local ACP front door and the shared Session
 * View, one REAL scripted provider produces the durable facts (a whole-list
 * `todo_write`, one REAL subagent child, real provider usage and a real
 * compaction), and official ACP SDK clients consume them over the real socket.
 * The case proves, from real processes and the durable Host log:
 *
 *   - LIST: the authorized root roster (real Session Controller visibility)
 *     reports the real title/cwd/activity, hides the subagent child, honours the
 *     cwd filter, and leaves NO View/claim and NO appended event behind — proven
 *     on an isolated control Session that is created, detached before the read
 *     and successfully loaded again from a fresh connection;
 *   - LOAD: a fresh connection replays the complete canonical history in
 *     `seq` order and only then answers, while `resume` replays NOTHING;
 *   - gating: the SAME durable history reaches a capability-negotiated client as
 *     `plan_update`/`compaction_update`, and a baseline client only as the
 *     standard legacy `plan` (no supplemental frame at all);
 *   - live: the attached View reports the official plan, title, occupancy and
 *     the verified child association of the real subagent run.
 *
 * The child's official `send_message` produces the real durable `agent-message`
 * that becomes `session_message` with the verified author lineage.
 *
 * A second real Host on the same profile serves a persisted root Session that
 * the FIRST Host created before it was fully stopped: the roster still reports
 * it with its official title/cwd, appends no event and leaves no claim, while
 * the live Agent count is reported as NOT_VERIFIED (no official seam).
 *
 * Anything the minimal real Host in this scene cannot produce is reported as an
 * explicit `NOT_OBSERVED` fact in the evidence, never as a fabricated PASS.
 *
 * @module split-process/acp-protocol-projection
 */

import { closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, hostSessionHeader } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

const CASE_ID = 'acp.protocol-projection'

/** The first prompt: todo list + one real subagent + the closing answer. */
const FIRST_PROMPT = 'acp-projection first'
/** The second prompt: the official step-pressure compaction runs first. */
const SECOND_PROMPT = 'acp-projection second'
/**
 * The declared route capacity the fixture's `acp-projection` model reports.
 * The official step-pressure threshold is `min(ratio*window, window-reserved-
 * headroom)`, so this value keeps a real pressure budget above the default
 * 65536-token headroom while the provider's own occupancy sample crosses it.
 */
const PROJECTION_CONTEXT_WINDOW = 200_000
/** The scripted provider's real occupancy sample (usable below the capacity). */
const PROJECTION_PRESSURE_TOKENS = 150_000

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function fail(label) {
  throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}`)
}

function deadline(promise, label, ms = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${CASE_ID}: ${label} timed out after ${String(ms)}ms`)) }, ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** One official ACP SDK client over the real local socket. */
export async function openSdkClient(endpoint, onUpdate, onElicitation) {
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
  const app = acp.client({ name: CASE_ID })
  app.onNotification(acp.methods.client.session.update, ({ params }) => { onUpdate(params) })
  if (onElicitation !== undefined) {
    app.onRequest(acp.methods.client.elicitation.create, async ({ params }) => await onElicitation(params))
  }
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket)))
  // A peer-side EOF is a normal scene teardown; keep the SDK's closed promise
  // observed so it can never become an uncaught rejection after a failure.
  connection.closed.catch(() => {})
  return {
    connection,
    socket,
    socketClosed,
    async request(method, params) {
      return await deadline(connection.agent.request(method, params), `ACP ${method}`)
    },
    async notify(method, params) {
      await deadline(connection.agent.notify(method, params), `ACP notify ${method}`)
    },
    async close() {
      // Destroying the socket is the complete teardown here; the SDK's close()
      // can throw/reject after a peer EOF, which must never mask the verdict.
      socket.destroy()
      try {
        await deadline(Promise.allSettled([connection.closed, socketClosed]), 'ACP connection close', 30_000)
      } catch { /* the caller's original failure owns the verdict */ }
    },
  }
}

/** Await one value from a fresh read (never a fixed sleep on a durable fact). */
async function waitForFact(read, label, timeoutMs = 180_000) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) fail(`timed out waiting for ${label}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}

/** The text of one durable user message event. */
function userText(event) {
  return (event.data?.content ?? []).map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
}

/** Every `session/update` payload a connection received for one Session. */
function updatesOf(updates, sessionId) {
  // The baseline command catalog is an independent standard notification every
  // attached View receives; it is not replayed history or a supplemental frame.
  return updates
    .filter(params => params?.sessionId === sessionId)
    .map(params => params.update)
    .filter(update => update?.sessionUpdate !== 'available_commands_update')
}

/** The kinds of a collected update list. */
function kindsOf(updates) {
  return updates.map(update => update?.sessionUpdate)
}

/**
 * Run the protocol-projection qualification.
 * @param {object} context - the split smoke run context.
 * @returns {Promise<object>} the verdict facts gathered from real processes.
 */
export async function runAcpProtocolProjection(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context)
  const hostCwd = realpathSync(workDir)
  const clients = []
  let peer
  let host

  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const eventsOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []

  try {
    mkdirSync(join(workDir, 'projection-workspaces'), { recursive: true, mode: 0o700 })
    rmSync(join(workDir, 'projection-workspaces', 'probe'), { recursive: true, force: true })

    // ── A) One real Host whose scripted provider produces the durable facts.
    const started = await scene.startC1Host('acp-projection', 'projection A host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_PROJECTION_CONTEXT_WINDOW: String(PROJECTION_CONTEXT_WINDOW),
      C1_PROJECTION_PRESSURE_TOKENS: String(PROJECTION_PRESSURE_TOKENS),
    })
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'PP-01: the Host Ready must publish a full scope id')
    const hostIdentity = await scene.hostIdentityFacts(host)
    trace('acp-projection/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installation.manifest.version,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
    })

    // ── B) Enable the opt-in front door on the running Host.
    peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = 'projection B peer'
    await peer.waitFor(record => record.m4a0 === 'ready', 'PP-02 peer ready', 180_000)
    const requestId = `projection-access-${String(Date.now())}-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId, acpEnabled: true })
    const access = await peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      'PP-02 ACP access', 120_000)
    assert(access.ok === true && access.status?.state === 'enabled', `PP-02: the ACP front door must enable (${JSON.stringify(access)})`)
    const endpoint = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${scopeId.slice(0, 40)}/acp.sock` }
      : { path: join(scopeDirOf(scopeId), 'acp.sock'), dir: scopeDirOf(scopeId) }
    assert(existsSync(endpoint.path), `PP-02: the enabled front door must publish ${endpoint.path}`)

    // ── C) A capability-negotiated client and a baseline client.
    const capableUpdates = []
    const capable = await openSdkClient(endpoint, params => { capableUpdates.push(params) })
    clients.push(capable)
    const baselineUpdates = []
    const baseline = await openSdkClient(endpoint, params => { baselineUpdates.push(params) })
    clients.push(baseline)

    const capableInit = await capable.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        plan: {},
        subagents: {},
        session: { compaction: {}, notices: {} },
      },
    })
    assert(capableInit?.protocolVersion === 1, 'PP-03: initialize must answer protocolVersion 1')
    assert(capableInit?.agentCapabilities?.loadSession === true,
      'PP-03: a Host with the official read seams advertises session/load')
    assert(capableInit?.agentCapabilities?.sessionCapabilities?.list !== undefined,
      'PP-03: and session/list')
    const baselineInit = await baseline.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    assert(baselineInit?.protocolVersion === 1, 'PP-03: the baseline initialize must answer protocolVersion 1')

    // ── D) First real turn: todo list, real subagent, closing answer + usage.
    const sessionP = (await capable.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    assert(typeof sessionP === 'string' && sessionP !== '', 'PP-04: session/new must create a real Session')
    const turnOne = await capable.request(acp.methods.agent.session.prompt, {
      sessionId: sessionP,
      prompt: [{ type: 'text', text: FIRST_PROMPT }],
    })
    assert(turnOne?.stopReason === 'end_turn', `PP-04: the first turn must end_turn (${JSON.stringify(turnOne)})`)

    const liveKinds = () => kindsOf(updatesOf(capableUpdates, sessionP))
    for (const kind of ['plan_update', 'subagent_update', 'usage_update', 'session_info_update']) {
      await waitForFact(() => (liveKinds().includes(kind) ? true : undefined),
        `PP-04 the live ${kind} projection (observed: ${JSON.stringify(liveKinds())})`)
    }
    const liveOne = updatesOf(capableUpdates, sessionP)
    const planUpdates = liveOne.filter(update => update.sessionUpdate === 'plan_update')
    assert(planUpdates.length >= 1, 'PP-04: the real todo_write must arrive as plan_update')
    const firstPlan = planUpdates[0]
    assert(firstPlan.plan?.type === 'items' && firstPlan.plan.planId === `dsh-todos:${sessionP}`,
      `PP-04: one stable per-Session plan id (${JSON.stringify(firstPlan.plan)})`)
    assert(JSON.stringify(firstPlan.plan.entries.map(entry => entry.content))
      === JSON.stringify(['inspect the projection', 'prove the replay']),
    `PP-04: the plan entries are the official todo list (${JSON.stringify(firstPlan.plan.entries)})`)
    assert(firstPlan.plan.entries.every(entry => entry.priority === 'medium'),
      'PP-04: the presentation priority is the fixed documented default')

    const usageUpdates = liveOne.filter(update => update.sessionUpdate === 'usage_update')
    const pressureUsage = usageUpdates[0]
    assert(pressureUsage !== undefined && Number.isFinite(pressureUsage.used) && pressureUsage.used > 0,
      `PP-04: the real provider occupancy must be projected (${JSON.stringify(usageUpdates)})`)
    assert(pressureUsage.size === PROJECTION_CONTEXT_WINDOW,
      `PP-04: the capacity is the official route context window (${String(pressureUsage.size)})`)
    assert(pressureUsage.cost === undefined, 'PP-04: no cost is ever fabricated')

    const infoUpdate = liveOne.find(update => update.sessionUpdate === 'session_info_update')
    assert(typeof infoUpdate?.title === 'string' && infoUpdate.title.length > 0,
      'PP-04: the official durable title is projected as session_info_update')

    // The real subagent child association is announced with its real identity.
    const subagentUpdates = liveOne.filter(update => update.sessionUpdate === 'subagent_update')
    const childId = subagentUpdates[0]?.sessionId
    assert(typeof childId === 'string' && childId !== sessionP,
      `PP-04: a real child association must be announced (${JSON.stringify(subagentUpdates)})`)
    const childHeader = await waitForFact(() => hostSessionHeader(dshHome, childId), 'PP-04 the durable child header')
    assert(childHeader.origin === 'subagent', `PP-04: the child Session carries origin=subagent (${JSON.stringify(childHeader)})`)
    assert(childHeader.parentSession === sessionP,
      `PP-04: the announced parent is the official durable creator (${JSON.stringify(childHeader.parentSession)})`)
    assert(subagentUpdates.every(update => update.capabilities === undefined),
      'PP-04: no child mutation capability is ever advertised')
    // The child sends ONE official `send_message`; the PARENT transcript gets a
    // durable agent-message and this View projects it as a standard
    // `session_message` with the real author Session id.
    const sessionMessage = await waitForFact(() => updatesOf(capableUpdates, sessionP)
      .find(update => update.sessionUpdate === 'session_message'), 'PP-04 the real session_message projection')
    assert(sessionMessage.senderSessionId === childId,
      `PP-04: the message author is the real child Session (${JSON.stringify(sessionMessage.senderSessionId)})`)
    assert(sessionMessage.recipientSessionId === sessionP,
      `PP-04: the message recipient is this Session (${JSON.stringify(sessionMessage.recipientSessionId)})`)
    assert(JSON.stringify(sessionMessage.content).includes('projection child message'),
      `PP-04: the message carries the child content (${JSON.stringify(sessionMessage.content).slice(0, 200)})`)
    const childUpdates = () => updatesOf(capableUpdates, sessionP)
      .filter(update => update.sessionUpdate === 'subagent_update' && update.sessionId === childId)
    const runningChild = childUpdates().find(update => update.state?.state === 'running')
    assert(runningChild !== undefined, 'PP-04: the child start is announced as running')
    await waitForFact(() => (childUpdates().some(update => update.state?.state === 'idle') ? true : undefined),
      `PP-04 the settled child idle announcement (observed: ${JSON.stringify(childUpdates().map(update => update.state))})`)

    // ── E) Second real turn: the official step-pressure compaction runs first.
    const secondTurn = await capable.request(acp.methods.agent.session.prompt, {
      sessionId: sessionP,
      prompt: [{ type: 'text', text: SECOND_PROMPT }],
    })
    assert(secondTurn?.stopReason === 'end_turn', `PP-05: the second turn must end_turn (${JSON.stringify(secondTurn)})`)
    /** Every compaction id's ordered updates on THIS connection. */
    const compactionById = () => {
      const byId = new Map()
      for (const update of updatesOf(capableUpdates, sessionP)) {
        if (update.sessionUpdate !== 'compaction_update') continue
        const list = byId.get(update.compactionId) ?? []
        list.push(update)
        byId.set(update.compactionId, list)
      }
      return byId
    }
    const liveAll = await waitForFact(() => {
      const updates = updatesOf(capableUpdates, sessionP)
      const complete = [...compactionById().values()].some(list =>
        list.some(update => update.status === 'in_progress' && update.summary !== undefined)
        && list.some(update => update.status === 'completed'))
      return complete ? updates : undefined
    }, `PP-05 the compaction lifecycle updates (observed: ${JSON.stringify([...compactionById().entries()].map(([id, list]) => [id, list.map(update => update.status)]))})`)
    const compactionUpdates = liveAll.filter(update => update.sessionUpdate === 'compaction_update')
    const lifecycle = [...compactionById().entries()].find(([, list]) =>
      list.some(update => update.status === 'in_progress' && update.summary !== undefined)
      && list.some(update => update.status === 'completed'))
    assert(lifecycle !== undefined, `PP-05: one compaction id owns a real start/summary/end lifecycle (${JSON.stringify(compactionUpdates)})`)
    const [compactionId, lifecycleUpdates] = lifecycle
    assert(typeof compactionId === 'string' && compactionId.length > 0, 'PP-05: one durable compaction id')
    assert(lifecycleUpdates[0]?.status === 'in_progress', 'PP-05: compaction starts in_progress')
    assert(lifecycleUpdates.some(update => update.status === 'in_progress' && update.summary !== undefined),
      `PP-05: the completed summary is the complete official replacement (${JSON.stringify(lifecycleUpdates)})`)
    assert(lifecycleUpdates.some(update => update.status === 'completed'),
      'PP-05: the same id reaches its official completed terminal')
    assert(compactionUpdates.every(update => typeof update.compactionId === 'string' && update.compactionId.length > 0),
      'PP-05: every reported compaction is keyed by an official id')
    // The official `todos` fold reset at turn 2's `turn/start` removes the plan
    // announced in turn 1 (the negotiated client gets plan_removed).
    const resetPlan = await waitForFact(() => updatesOf(capableUpdates, sessionP)
      .find(update => update.sessionUpdate === 'plan_removed'), 'PP-05 the plan reset of the new turn')
    assert(resetPlan.planId === `dsh-todos:${sessionP}`,
      `PP-05: the reset names the announced plan id (${JSON.stringify(resetPlan.planId)})`)
    const durableCompaction = eventsOf(sessionP).filter(event => event.type.startsWith('compaction/'))
    assert(durableCompaction.length >= 3,
      `PP-05: the durable log owns the real compaction lifecycle (${JSON.stringify(durableCompaction.map(event => event.type))})`)

    // ── F) Baseline-capability negative: the SAME real facts, no supplemental frame.
    const baselineSession = (await baseline.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    const baselineTurn = await baseline.request(acp.methods.agent.session.prompt, {
      sessionId: baselineSession,
      prompt: [{ type: 'text', text: FIRST_PROMPT }],
    })
    assert(baselineTurn?.stopReason === 'end_turn', 'PP-06: the baseline turn must end_turn')
    const baselineLive = await waitForFact(() => {
      const updates = updatesOf(baselineUpdates, baselineSession)
      return kindsOf(updates).includes('plan') ? updates : undefined
    }, 'PP-06 the baseline legacy plan')
    const baselineKinds = kindsOf(baselineLive)
    assert(baselineKinds.includes('plan'), 'PP-06: an unnegotiated client still receives the baseline plan')
    for (const forbidden of ['plan_update', 'plan_removed', 'compaction_update', 'subagent_update', 'session_message', 'notice']) {
      assert(!baselineKinds.includes(forbidden),
        `PP-06: an unnegotiated client must never receive ${forbidden} (${JSON.stringify(baselineKinds)})`)
    }
    assert(!baselineKinds.includes('plan_update'), 'PP-06: no plan_update without the client capability')

    // ── G) LIST: the authorized root roster, from real Host facts.
    // An isolated, freshly created root Session is the CONTROL: it carries no
    // projection-scene history, so any View/claim left behind by the roster read
    // is visible on it. Create it, close its View, then measure.
    const coldConn = await openSdkClient(endpoint, () => {})
    clients.push(coldConn)
    await coldConn.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const coldSession = (await coldConn.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    assert(typeof coldSession === 'string' && coldSession !== sessionP, 'PP-07: the control Session is a distinct real Session')
    await coldConn.request(acp.methods.agent.session.close, { sessionId: coldSession })
    // The official JSONL storage is write-behind: the Session's own creation
    // events land shortly after `session/new` returns. Establish a STABLE
    // baseline before the roster read instead of mistaking that write for the
    // list's side effect.
    const stableEventCount = async sessionId => {
      let stable = 0
      let previous = -1
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const current = eventsOf(sessionId).length
        stable = current > 0 && current === previous ? stable + 1 : 0
        if (stable >= 3) return current
        previous = current
        await new Promise(resolveWait => setTimeout(resolveWait, 150))
      }
      fail(`the ${sessionId} event log never settled`)
    }
    const rootEventsBeforeList = eventsOf(sessionP).length
    const firstPage = await capable.request(acp.methods.agent.session.list, {})
    const listedIds = (firstPage?.sessions ?? []).map(session => session.sessionId)
    assert(listedIds.includes(sessionP), `PP-07: the real root Session is listed (${JSON.stringify(listedIds)})`)
    assert(listedIds.includes(coldSession), `PP-07: the isolated control Session is listed too (${JSON.stringify(listedIds)})`)
    assert(!listedIds.includes(childId), 'PP-07: the subagent Session is never a top-level row')
    const rowP = firstPage.sessions.find(session => session.sessionId === sessionP)
    assert(rowP.cwd === hostCwd, `PP-07: the row carries the official absolute cwd (${JSON.stringify(rowP.cwd)})`)
    assert(typeof rowP.title === 'string' && rowP.title.length > 0, 'PP-07: the row carries the official title')
    assert(typeof rowP.updatedAt === 'string' && !Number.isNaN(Date.parse(rowP.updatedAt)),
      `PP-07: last activity is ISO 8601 (${JSON.stringify(rowP.updatedAt)})`)
    const filtered = await capable.request(acp.methods.agent.session.list, { cwd: hostCwd })
    assert(JSON.stringify((filtered?.sessions ?? []).map(session => session.sessionId)) === JSON.stringify(listedIds),
      'PP-07: the cwd filter selects exactly the authorized rows of that workspace')
    const otherCwd = await capable.request(acp.methods.agent.session.list, { cwd: join(hostCwd, 'no-such-workspace') })
    assert((otherCwd?.sessions ?? []).length === 0, 'PP-07: an unrelated cwd lists nothing instead of every row')
    const repeatPage = await capable.request(acp.methods.agent.session.list, {})
    assert(JSON.stringify((repeatPage?.sessions ?? []).map(session => session.sessionId)) === JSON.stringify(listedIds),
      'PP-07: the same roster read is deterministic')
    // Listing is a pure read, measured on the real Host: the authorized root
    // Session's canonical log gained NO event for the roster reads, and the
    // child Session was never claimed by this connection (it would have been
    // refused as already attached).
    const rootEventsAfterList = eventsOf(sessionP).length
    assert(rootEventsAfterList === rootEventsBeforeList,
      `PP-07: listing appends no event to the projection Session (${String(rootEventsBeforeList)} -> ${String(rootEventsAfterList)})`)
    // POSITIVE proof: a FRESH connection loads the control Session successfully.
    // A Host-wide View/claim left behind by the list would refuse it as already
    // attached; this asserts the actual success instead of excluding one code.
    const probeUpdates = []
    const probe = await openSdkClient(endpoint, params => { probeUpdates.push(params) })
    clients.push(probe)
    await probe.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const coldProbeLoad = await probe.request(acp.methods.agent.session.load, {
      sessionId: coldSession, cwd: hostCwd, mcpServers: [],
    })
    assert(coldProbeLoad !== undefined, 'PP-07: the control Session loads after the roster reads (no claim was left)')
    await probe.request(acp.methods.agent.session.close, { sessionId: coldSession })
    const listReadsWithoutSideEffects = rootEventsAfterList === rootEventsBeforeList
      && coldProbeLoad !== undefined

    // ── H) LOAD: the complete canonical history replays before the response.
    await capable.request(acp.methods.agent.session.close, { sessionId: sessionP })
    const resumeUpdates = []
    const resumer = await openSdkClient(endpoint, params => { resumeUpdates.push(params) })
    clients.push(resumer)
    await resumer.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { plan: {} } })
    const resumed = await resumer.request(acp.methods.agent.session.resume, { sessionId: sessionP, cwd: hostCwd })
    assert(resumed !== undefined, 'PP-08: resume must attach the existing Session')
    await new Promise(resolveTick => setTimeout(resolveTick, 400))
    assert(updatesOf(resumeUpdates, sessionP).length === 0,
      `PP-08: resume NEVER replays history (${JSON.stringify(kindsOf(updatesOf(resumeUpdates, sessionP)))})`)
    await resumer.request(acp.methods.agent.session.close, { sessionId: sessionP })

    const loadBaselineUpdates = []
    const baselineLoader = await openSdkClient(endpoint, params => { loadBaselineUpdates.push(params) })
    clients.push(baselineLoader)
    await baselineLoader.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const baselineLoad = await baselineLoader.request(acp.methods.agent.session.load, {
      sessionId: sessionP, cwd: hostCwd, mcpServers: [],
    })
    assert(baselineLoad !== undefined, 'PP-08: the baseline load must answer')
    const baselineHistory = updatesOf(loadBaselineUpdates, sessionP)
    const baselineHistoryKinds = kindsOf(baselineHistory)
    assert(baselineHistoryKinds.includes('user_message_chunk'), 'PP-08: the canonical human prompt is replayed')
    assert(baselineHistoryKinds.includes('tool_call') && baselineHistoryKinds.includes('tool_call_update'),
      `PP-08: the real tool call/result pair is replayed (${JSON.stringify(baselineHistoryKinds)})`)
    assert(baselineHistoryKinds.includes('plan') && !baselineHistoryKinds.includes('plan_update'),
      'PP-08: a baseline loader receives the legacy plan only')
    assert(!baselineHistoryKinds.includes('compaction_update') && !baselineHistoryKinds.includes('subagent_update'),
      `PP-08: a baseline loader receives no supplemental history frames (${JSON.stringify(baselineHistoryKinds)})`)
    assert(baselineHistoryKinds[0] === 'user_message_chunk',
      `PP-08: the replay starts at the oldest canonical fact (${JSON.stringify(baselineHistoryKinds[0])})`)
    await baselineLoader.request(acp.methods.agent.session.close, { sessionId: sessionP })

    // The capable loader receives the SAME history plus its negotiated frames.
    const loadCapableUpdates = []
    // The connection records the REAL wire order: every decoded update, then the
    // load response when it finally settles.
    const loadWireOrder = []
    const capableLoader = await openSdkClient(endpoint, params => {
      loadCapableUpdates.push(params)
      loadWireOrder.push('update')
    })
    clients.push(capableLoader)
    await capableLoader.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { plan: {}, subagents: {}, session: { compaction: {} } },
    })
    const capableLoad = await capableLoader.request(acp.methods.agent.session.load, {
      sessionId: sessionP, cwd: hostCwd, mcpServers: [],
    })
    loadWireOrder.push('load-response')
    assert(capableLoad !== undefined, 'PP-09: the capable load must answer')
    const capableHistory = updatesOf(loadCapableUpdates, sessionP)
    const capableHistoryKinds = kindsOf(capableHistory)
    assert(capableHistoryKinds.includes('plan_update'), 'PP-09: the negotiated client receives plan_update in history')
    assert(capableHistoryKinds.includes('compaction_update'),
      `PP-09: and the real compaction lifecycle (${JSON.stringify(capableHistoryKinds)})`)
    assert(capableHistoryKinds.filter(kind => kind === 'compaction_update').length >= 3,
      'PP-09: start/summary/end all replay from the canonical log')
    assert(capableHistoryKinds.every(kind => kind !== 'notice'),
      'PP-09: no notice is ever fabricated')
    const historyMessage = capableHistory.find(update => update.sessionUpdate === 'session_message')
    assert(historyMessage !== undefined && historyMessage.senderSessionId === childId,
      `PP-09: the canonical history replays the real agent message (${JSON.stringify(capableHistoryKinds)})`)
    // The response is the LAST frame on the wire: every replayed update was
    // already decoded by the official client before the response settled.
    assert(loadWireOrder.length > 1 && loadWireOrder.at(-1) === 'load-response'
      && loadWireOrder.slice(0, -1).every(entry => entry === 'update'),
    `PP-09: the load response follows every replayed update (${JSON.stringify(loadWireOrder)})`)
    const loadAnsweredAfterDrain = loadWireOrder.at(-1) === 'load-response'
      && loadWireOrder.slice(0, -1).every(entry => entry === 'update')
      && capableHistory.length > 0

    // ── I) The Host and the Session authority are untouched.
    const hostAfter = await scene.hostIdentityFacts(host)
    const hostIdentityKept = hostAfter?.hostPid === hostIdentity.hostPid
      && hostAfter?.instanceId === hostIdentity.instanceId
    assert(hostIdentityKept,
      `PP-10: the same Host instance serves every read (${JSON.stringify({ before: hostIdentity, after: hostAfter })})`)
    assert(eventsOf(sessionP).length > 0, 'PP-10: the durable Session log stays readable')

    // ── J) COLD LIST after a FULL Host restart. The Session below is created and
    // persisted by this Host's official Controller, then the whole Host process
    // stops; a fresh Host on the same profile must serve it from disk. The
    // roster read must not create a claim and must not append any durable event.
    // The live Agent count is NOT observable from outside (no official seam;
    // `session/close` does not dispose an Agent), so that sub-fact is reported
    // as NOT_VERIFIED instead of being inferred from "no write".
    const restartSession = (await capable.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    assert(typeof restartSession === 'string' && restartSession !== sessionP, 'PP-11: the cold candidate is a real root Session')
    const restartTurn = await capable.request(acp.methods.agent.session.prompt, {
      sessionId: restartSession,
      prompt: [{ type: 'text', text: FIRST_PROMPT }],
    })
    assert(restartTurn?.stopReason === 'end_turn', 'PP-11: the cold candidate completes one real turn')
    const restartTitle = (await capable.request(acp.methods.agent.session.list, {})).sessions
      .find(session => session.sessionId === restartSession)?.title
    assert(typeof restartTitle === 'string' && restartTitle.length > 0, 'PP-11: the cold candidate has its durable title')
    await capable.request(acp.methods.agent.session.close, { sessionId: restartSession })
    for (const client of clients) await client.close()
    clients.length = 0
    if (peer !== undefined) {
      await peer.shutdown()
      peer = undefined
    }
    await scene.stopC1Host(host)
    host = undefined
    const second = await scene.startC1Host('acp-projection', 'projection cold host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_PROJECTION_CONTEXT_WINDOW: String(PROJECTION_CONTEXT_WINDOW),
      C1_PROJECTION_PRESSURE_TOKENS: String(PROJECTION_PRESSURE_TOKENS),
      // QUALIFICATION-ONLY fixture watch: the fixture records the official live
      // Session/Agent registry for this ONE id on every provider call.
      C1_WATCH_SESSION: restartSession,
    })
    // Phase-associated observations: the fixture records the phase from the
    // prompt marker, so "after" can only come from the post-list step.
    const registryPhase = async phase => {
      const events = readC1WorkEvents(second.workRoot)
        .filter(event => event.kind === 'live-registry' && event.phase === phase)
      if (events.length === 0) fail(`PP-11: no registry observation for phase ${phase}`)
      for (const event of events) {
        assert(event.watched === restartSession, 'PP-11: the watch targets the cold Session')
        assert(event.selfSessionLive === true && event.selfAgentLive === true,
          `PP-11: the probe sees the live registry (${phase}: ${JSON.stringify(event)})`)
        assert(event.watchedSessionLive === false && event.watchedAgentLive === false,
          `PP-11: the cold Session/Agent is NOT live (${phase}: ${JSON.stringify(event)})`)
      }
      return events.at(-1)
    }
    host = second.host
    const scopeIdB = second.ready.localHost.scopeId
    assert(typeof scopeIdB === 'string' && scopeIdB.length === 64, 'PP-11: the cold Host publishes its own scope id')
    peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = 'projection cold peer'
    await peer.waitFor(record => record.m4a0 === 'ready', 'PP-11 cold peer ready', 180_000)
    const restartRequestId = `projection-cold-access-${String(Date.now())}-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId: restartRequestId, acpEnabled: true })
    const restartAccess = await peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === restartRequestId,
      'PP-11 cold ACP access', 120_000)
    assert(restartAccess.ok === true && restartAccess.status?.state === 'enabled',
      `PP-11: the cold Host enables its ACP front door (${JSON.stringify(restartAccess)})`)
    const endpointB = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${scopeIdB.slice(0, 40)}/acp.sock` }
      : { path: join(scopeDirOf(scopeIdB), 'acp.sock'), dir: scopeDirOf(scopeIdB) }
    assert(existsSync(endpointB.path), `PP-11: the cold Host publishes ${endpointB.path}`)
    const restartEventsBeforeList = await stableEventCount(restartSession)
    const restartConnUpdates = []
    const restartConn = await openSdkClient(endpointB, params => { restartConnUpdates.push(params) })
    clients.push(restartConn)
    await restartConn.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { plan: {}, subagents: {} },
    })
    // A real provider turn on ANOTHER Session is the fixture-only trigger for
    // the official registry observation; it happens BEFORE the roster read.
    const watchSession = (await restartConn.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })).sessionId
    const watchBefore = await restartConn.request(acp.methods.agent.session.prompt, {
      sessionId: watchSession, prompt: [{ type: 'text', text: `${FIRST_PROMPT} projection-registry-marker:before` }],
    })
    assert(watchBefore?.stopReason === 'end_turn', 'PP-11: the registry-watch turn completes')
    const registryBefore = await registryPhase('before')
    assert(registryBefore.sessionCount > 0 && registryBefore.agentCount > 0,
      `PP-11: the official live registries are populated before the roster read (${JSON.stringify(registryBefore)})`)
    const restartPage = await restartConn.request(acp.methods.agent.session.list, {})
    const restartRow = (restartPage?.sessions ?? []).find(session => session.sessionId === restartSession)
    assert(restartRow !== undefined, 'PP-11: the cold Session is in the authorized roster of the NEW Host')
    assert(restartRow.cwd === hostCwd && restartRow.title === restartTitle,
      `PP-11: the cold row keeps its official cwd/title (${JSON.stringify(restartRow)})`)
    const restartEventsAfterList = eventsOf(restartSession).length
    assert(restartEventsAfterList === restartEventsBeforeList,
      `PP-11: the cold list appends no durable event (${String(restartEventsBeforeList)} -> ${String(restartEventsAfterList)})`)
    const watchAfter = await restartConn.request(acp.methods.agent.session.prompt, {
      sessionId: watchSession, prompt: [{ type: 'text', text: `${SECOND_PROMPT} projection-registry-marker:after` }],
    })
    assert(watchAfter?.stopReason === 'end_turn', 'PP-11: the second registry-watch turn completes')
    const registryAfter = await registryPhase('after')
    // The criterion is "the roster read must not RAISE the count": a settled
    // child from the earlier turn may legitimately disappear between phases.
    assert(registryAfter.sessionCount <= registryBefore.sessionCount
      && registryAfter.agentCount <= registryBefore.agentCount,
    `PP-11: the roster read did not raise the official live Session/Agent count (before ${JSON.stringify(registryBefore)} after ${JSON.stringify(registryAfter)})`)
    // NEGATIVE PROOF for the phase identity: a turn WITHOUT a marker must not
    // reuse the previous step's phase, even though its derived history still
    // contains the earlier marker.
    const phaseCountBefore = readC1WorkEvents(second.workRoot).filter(event => event.kind === 'live-registry-phase').length
    const watchNoMarker = await restartConn.request(acp.methods.agent.session.prompt, {
      sessionId: watchSession, prompt: [{ type: 'text', text: 'A prompt without any registry phase marker.' }],
    })
    assert(watchNoMarker?.stopReason === 'end_turn', 'PP-11: the unmarked turn completes')
    const afterNoMarker = readC1WorkEvents(second.workRoot)
    const phaseCountAfter = afterNoMarker.filter(event => event.kind === 'live-registry-phase').length
    assert(phaseCountAfter === phaseCountBefore, 'PP-11: an unmarked prompt never reuses an older registry phase')
    assert(afterNoMarker.some(event => event.kind === 'live-registry' && event.phase === null),
      'PP-11: the unmarked turn is observed without a phase, not folded into the previous one')
    const restartLoader = await openSdkClient(endpointB, () => {})
    clients.push(restartLoader)
    await restartLoader.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const restartLoad = await restartLoader.request(acp.methods.agent.session.load, {
      sessionId: restartSession, cwd: hostCwd, mcpServers: [],
    })
    assert(restartLoad !== undefined, 'PP-11: the cold Session loads from a fresh connection (no claim was left)')
    await restartLoader.request(acp.methods.agent.session.close, { sessionId: restartSession })
    const restartList = {
      sessionId: restartSession,
      title: restartTitle,
      listedOnNewHost: true,
      appendedNoEvent: restartEventsAfterList === restartEventsBeforeList,
      freshLoadSucceeded: restartLoad !== undefined,
      registryBefore: {
        phase: registryBefore.phase,
        watchedSessionLive: registryBefore.watchedSessionLive,
        watchedAgentLive: registryBefore.watchedAgentLive,
        sessionCount: registryBefore.sessionCount,
        agentCount: registryBefore.agentCount,
      },
      registryAfter: {
        phase: registryAfter.phase,
        watchedSessionLive: registryAfter.watchedSessionLive,
        watchedAgentLive: registryAfter.watchedAgentLive,
        sessionCount: registryAfter.sessionCount,
        agentCount: registryAfter.agentCount,
      },
      // Both values are the fixture's read of the OFFICIAL `sessions.list()` /
      // `agents.list()` counts; the observed property is "did not increase"
      // (a settled child may disappear), not "strictly unchanged".
      liveAgentCount: 'OBSERVED_NOT_INCREASED',
      // The official Writer is a kernel flock (`SessionWriteLease`) with no
      // in-process count; acquiring it would be a write. The frozen Writer
      // sub-item is therefore reported as NOT_VERIFIED (Owner adjudication),
      // backed by the static source->sink chain and the cold id being absent
      // from both official live registries.
      writer: 'WRITER_L6_NOT_VERIFIED',
    }

    const durableKinds = eventsOf(sessionP).map(event => event.type)
    const evidence = {
      schema: 'gacp2-protocol-projection/1',
      case_id: CASE_ID,
      platform: process.platform,
      candidate_sha256: context.candidateSha256,
      dsh_version: context.targetDshVersion,
      bundle_version: installation.manifest.version,
      host: { pid: hostIdentity.hostPid, instanceId: hostIdentity.instanceId, scopeId },
      sessions: { root: sessionP, child: childId, baseline: baselineSession },
      list: {
        rows: listedIds.length,
        ownRow: rowP,
        childHidden: !listedIds.includes(childId),
        controlSession: coldSession,
        controlLoadedAfterList: coldProbeLoad !== undefined,
        cwdFiltered: true,
      },
      load: {
        baselineKinds: baselineHistoryKinds,
        capableKinds: capableHistoryKinds,
        resumeKinds: kindsOf(updatesOf(resumeUpdates, sessionP)),
      },
      live: {
        planEntries: firstPlan.plan.entries.length,
        usage: { used: pressureUsage.used, size: pressureUsage.size, cost: pressureUsage.cost ?? null },
        title: infoUpdate.title,
        childOrigin: childHeader.origin,
        childParent: childHeader.parentSession,
        compaction: { id: compactionId, updates: compactionUpdates.length },
      },
      durableEventKinds: durableKinds,
      coldRestart: restartList,
      sessionMessage: { sender: childId, recipient: sessionP, projected: true },
      notice: 'NO_OFFICIAL_PRODUCER',
      verdict: 'PASS',
    }

    for (const client of clients) await client.close()
    clients.length = 0
    const peerExit = peer.exited ? undefined : await peer.shutdown()
    assert(peerExit === undefined || (peerExit.code === 0 && peerExit.signal === null), 'PP-10: the peer must exit cleanly')
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0 && hostExit.signal === null, 'PP-10: the Host must exit cleanly')
    await scene.awaitSceneSeatFree()
    assert(!existsSync(endpoint.path), 'PP-10: the ACP socket must be gone after shutdown')
    host = undefined

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      listAuthorizedRoster: listedIds.includes(sessionP) && !listedIds.includes(childId),
      listReadsWithoutSideEffects,
      loadReplayedCanonicalHistory: baselineHistoryKinds.includes('user_message_chunk'),
      loadAnsweredAfterDrain,
      resumeReplayedNothing: updatesOf(resumeUpdates, sessionP).length === 0,
      planFromOfficialTodos: firstPlan.plan.entries.length === 2,
      usageFromOfficialContext: pressureUsage.size === PROJECTION_CONTEXT_WINDOW,
      titleFromDurableEvent: typeof infoUpdate.title === 'string',
      subagentVerified: childHeader.origin === 'subagent' && childHeader.parentSession === sessionP,
      compactionReplayed: capableHistoryKinds.includes('compaction_update'),
      baselineGating: !baselineHistoryKinds.includes('compaction_update') && !baselineHistoryKinds.includes('plan_update'),
      noticeNeverFabricated: !capableHistoryKinds.includes('notice'),
      hostIdentityKept,
      coldListAfterRestart: restartList.listedOnNewHost && restartList.appendedNoEvent && restartList.freshLoadSucceeded,
      acpProtocolVersion: capableInit.protocolVersion,
      evidence,
    }
  } finally {
    for (const client of clients) {
      try { await client.close() } catch { /* already gone */ }
    }
    if (peer !== undefined && peer.exited !== true) {
      try { await peer.shutdown() } catch { /* runner backstop */ }
    }
    if (host !== undefined && host.exited !== true) {
      try { await host.shutdown() } catch { /* runner backstop */ }
    }
    try { await scene.dispose() } catch { /* runner backstop */ }
    try { await scene.awaitSceneSeatFree().catch(() => {}) } catch { /* best effort */ }
  }
}
