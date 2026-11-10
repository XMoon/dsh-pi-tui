/**
 * M5-W PR-B official Web runtime toggle on ONE live Host.
 *
 * @module split-process/web-runtime-toggle
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { writeC1WorkFixture, readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  assertClientHostFacts,
  assertIdentityFields,
  connectCookie,
  fetchStatus,
  hostStatus,
  lastSurfaceStatus,
  readJson,
  saveFile,
  seatFree,
  waitForCondition,
  waitForOutcome,
  waitForSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import {
  PR_A_CLIENT_MODULES_PACKAGE,
  PR_A_SINGLETON_PACKAGES,
  PR_A_WEB_ROWS,
  PR_A_WEB_RUNTIME_ID,
  PR_A_WELCOME_NOTICE_VERSION,
  assertWebIndexQualified,
  browserDriverExitBounded,
  openSseFrames,
  readHostWebIndex,
  redactWebQualificationText,
  sseProbe,
  whileBrowserDriverRuns,
} from './web-helpers.mjs'

const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

export async function runWebRuntimeToggle(context) {
  const { EntryProcess, SurfaceEntryProcess, workDir, dshHome, base, entries, tarball, candidateSha256, targetDshVersion, trace, mode } = context
  const { env, anchor } = context.installation
  const requireBrowser = mode === 'selected' || process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'
  let webScopeSuffix
  let statusSequence = 0
  const toggleRoot = join(workDir, 'pr-b-toggle')
  mkdirSync(toggleRoot, { recursive: true, mode: 0o700 })
  chmodSync(toggleRoot, 0o700)
  const hosts = []
  const clients = []
  const peers = []
  /** The durable Host owners whose fiber identity must never change. */
  const PROTECTED_OWNER_KEYS = [
    'connection', 'apiRemotes', 'typertGateway', 'workspaceRegistry', 'workspaceController',
    'sessionController', 'fileUpload', 'settingsController', 'accountController', 'jobController', 'piTuiHostRuntime',
  ]
  /** `id -> live Loader fiber UID` for EVERY row the Host status reports. */
  const rowUids = ready => Object.fromEntries((ready.entries ?? [])
    .filter(entry => typeof entry.fiberUid === 'number')
    .map(entry => [entry.id, entry.fiberUid]))
  /** `id -> Loader state label` for the frozen Web roster. */
  const webStates = ready => new Map(PR_A_WEB_ROWS.map(row => [row.id, {
    state: (ready.entries ?? []).find(entry => entry.id === row.id)?.state,
    present: (ready.entries ?? []).some(entry => entry.id === row.id),
  }.state]))
  const assertProtectedOwners = (ready, label) => {
    for (const owner of PROTECTED_OWNER_KEYS) {
      assert(ready.ownerEntries?.[owner]?.length === 1,
        `${label}: the ${owner} owner count is ${JSON.stringify(ready.ownerEntries?.[owner])}, expected exactly one`)
    }
    assert(ready.webServer?.host === '127.0.0.1' && typeof ready.webServer?.port === 'number' && ready.webServer.port > 0,
      `${label}: the ONE loopback listener is not a bound 127.0.0.1 port (${JSON.stringify(ready.webServer)})`)
    assert(ready.ownerEntries?.accountController?.[0] === 'split-host-account-controller',
      `${label}: the official Account Controller owner row is ${JSON.stringify(ready.ownerEntries?.accountController)}`)
    assert(ready.services?.piTuiWebAccess === true,
      `${label}: the private Web access service is not part of the Host readiness record`)
  }
  /**
   * Every declared Web row is plainly OFF. `absent` is a row that never
   * mounted on this cold boot; `state-4` is the DISPOSED fiber a row keeps
   * after a toggle unloaded it. Anything else is a live Web graph.
   */
  const assertWebFullyOff = (ready, label) => {
    const live = [...webStates(ready)]
      .filter(([, state]) => state !== 'absent' && state !== 'state-4')
      .map(([id, state]) => `${id}:${state ?? 'missing'}`)
    assert(live.length === 0, `${label}: these Web rows are not plainly disabled: ${live.join(',')}`)
    assert((ready.entries ?? []).filter(entry => entry.name === PR_A_CLIENT_MODULES_PACKAGE && entry.state === 'active').length === 0,
      `${label}: an official Web module graph owner is active with Web off`)
  }
  /** EVERY declared Web row is ACTIVE: the toggle has no tolerated PENDING row. */
  const assertWebFullyOn = (ready, label) => {
    const states = webStates(ready)
    const missing = [...states].filter(([, state]) => state === undefined).map(([id]) => id)
    assert(missing.length === 0, `${label}: the Web roster is not declared: ${missing.join(',')}`)
    const notActive = [...states]
      .filter(([, state]) => state !== 'active')
      .map(([id, state]) => `${id}:${state}`)
    assert(notActive.length === 0, `${label}: these Web rows are not active: ${notActive.join(',')}`)
    return states
  }
  /** The Host's own HTTP surface in the OFF state. */
  const assertWebOffHttp = async (origin, label) => {
    const root = await fetchStatus(`${origin}/`)
    const plugin = await fetchStatus(`${origin}/plugins/@deepseek-ai/dsh-client-ui-theme/client.js`)
    const sse = await sseProbe(origin, '/plugins/events')
    const api = await fetchStatus(`${origin}/api`)
    const connect = await fetchStatus(`${origin}/connect`)
    assert(root.status === 404, `${label}: GET / must be 404 with Web off, got ${root.status}`)
    assert(plugin.status === 404, `${label}: a Web browser bundle must be 404 with Web off, got ${plugin.status}`)
    assert(!(sse.status === 200 && sse.contentType.startsWith('text/event-stream')),
      `${label}: the Web SSE channel is still live (${sse.status} ${sse.contentType})`)
    assert(api.status === 401, `${label}: unauthenticated /api must stay 401, got ${api.status}`)
    assert(connect.status === 401, `${label}: unfunded /connect must stay 401, got ${connect.status}`)
    return { root: root.status, plugin: plugin.status, sse: sse.status, api: api.status, connect: connect.status }
  }
  /** The authenticated Web index + module graph + SSE on a serving Host. */
  const assertWebServing = async (origin, launch, label) => {
    const facts = await readHostWebIndex(origin, launch, label)
    assertWebIndexQualified(facts, label, targetDshVersion)
    const graph = facts.graph
    const batches = []
    for (const batch of graph.batches) {
      const response = await fetchStatus(new URL(batch.url, `${origin}/`).href)
      batches.push({ phase: batch.phase, status: response.status, bytes: response.body.length })
      assert(response.status === 200, `${label}: the ${batch.phase} startup bundle returned HTTP ${response.status}`)
      assert(response.body.length > 1024, `${label}: the ${batch.phase} startup bundle is empty`)
    }
    const unknown = await fetchStatus(`${origin}/plugins/@deepseek-ai/dsh-client-does-not-exist/client.js`)
    assert(unknown.status === 404, `${label}: an unknown plugin id returned HTTP ${unknown.status}`)
    const sse = await sseProbe(origin, '/plugins/events')
    assert(sse.status === 200 && sse.contentType.startsWith('text/event-stream'),
      `${label}: /plugins/events is not a live event stream (${sse.status} ${sse.contentType})`)
    const frames = sse.chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
    assert(frames.length > 0, `${label}: /plugins/events pushed no data frame`)
    const first = JSON.parse(frames[0])
    assert(first.type === 'graph' && first.graph?.rev === graph.rev,
      `${label}: the SSE graph generation differs from the served index graph`)
    const cookie = await connectCookie(origin, launch)
    assert(cookie !== '', `${label}: the authenticated /connect minted no peer cookie`)
    return {
      exchange: facts.exchange.status,
      index: facts.index.status,
      graphEntries: graph.entries.length,
      graphBatches: batches,
      sse: sse.status,
      unknownPlugin: unknown.status,
      token: facts.token,
    }
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peers.push(peer)
    const peerReady = await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return { peer, peerReady }
  }
  /** One correlated `qualification-web-access` round trip on the live Peer. */
  const webAccess = async (peer, label, value) => {
    const requestId = `prb-${++statusSequence}`
    peer.send({
      op: 'qualification-web-access',
      requestId,
      ...(value === undefined ? {} : { webAccessEnabled: value }),
    })
    const record = await peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
      `${label} web-access`, 300_000)
    return record
  }
  /** Assert one toggle result is the reached state, never the requested one. */
  const assertToggle = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
    return record.status
  }
  /** The durable Host prompt/answer of one Session, counted exactly once. */
  const waitDurableTurn = async (sessionId, marker, label) => {
    await waitForHostSessionEventAfter(dshHome, sessionId, 0,
      event => event.type === 'user/message' && JSON.stringify(event).includes(marker), `${label} user/message`, 180_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, 0,
      event => event.type === 'turn/end', `${label} turn/end`, 180_000)
    const events = hostSessionEvents(dshHome, sessionId) ?? []
    const users = hostUserTexts(events).filter(text => text === marker).length
    assert(users === 1, `${label}: the Host committed the prompt ${users} times, expected exactly 1`)
    return events
  }
  // The isolated Host patch: the C1 long-turn model (so a real Turn can be
  // HELD across the toggle) plus the two isolated-fixture facts the official
  // Web UI needs. Both are row CONFIG on rows that stay disabled until the
  // toggle enables them — the patch never enables a Web row.
  const documentsDirectory = join(toggleRoot, 'documents')
  mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 })
  chmodSync(documentsDirectory, 0o700)
  // The C1 fixture is written into the INSTALLED profile so its own
  // `@deepseek-ai/*` imports resolve exactly like a Host row's; the outer
  // C1 section's bindings are block-scoped there, so this lane builds the
  // fixture it owns from the launcher facts it can see.
  const c1Fixture = writeC1WorkFixture(join(dshHome, 'profiles', base.profile), toggleRoot)
  const hostPatch = join(toggleRoot, 'pr-b-host.patch.yml')
  writeFileSync(hostPatch, [
    readFileSync(c1Fixture.patchPath, 'utf8').trimEnd(),
    '- id: ui-settings-general',
    '  config:',
    `    welcomeNoticeVersion: '${PR_A_WELCOME_NOTICE_VERSION}'`,
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: '${documentsDirectory}'`,
    '',
  ].join('\n'), { mode: 0o600 })
  chmodSync(hostPatch, 0o600)
  const longTurnBarrier = join(toggleRoot, 'long-turn.release')
  const workRoot = join(toggleRoot, 'work')
  mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  chmodSync(workRoot, 0o700)
  // The installed profile's own patch: the file a persisted toggle would
  // have to write, and the one this lane proves byte-identical.
  const hostProfiles = { profilePath: join(dshHome, 'profiles', base.profile, 'cordis.patch.yml') }
  const profilePatchBefore = existsSync(hostProfiles.profilePath)
    ? readFileSync(hostProfiles.profilePath)
    : undefined
  const promptEvidence = () => {
    const text = readFileSync(promptEvidencePath, 'utf8').trim()
    return text === '' ? [] : text.split('\n').map(line => JSON.parse(line))
  }
  const promptEvidencePath = join(toggleRoot, 'prompt-evidence.jsonl')
  writeFileSync(promptEvidencePath, '', { mode: 0o600 })
  const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
  /** The real Chromium verdict: only a completed driver run is a PASS. */
  let browserCase = 'NOT_RUN'
  const verdict = {}
  try {
    // ── A. Default-off Host (PB-01) ─────────────────────────────────────
    const host = new EntryProcess('host', entries.host, {
      ...base,
      env: {
        ...base.env,
        SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
        SPLIT_PROCESS_PROMPT_EVIDENCE: promptEvidencePath,
        C1_SCENARIO: 'long-turn',
        C1_WORK_ROOT: workRoot,
        C1_HOLD_LONG_TURN: longTurnBarrier,
      },
    })
    hosts.push(host)
    const ready = await host.waitFor(record => record.m4a0 === 'ready', 'PR-B default-off Host ready', 240_000)
    webScopeSuffix = ready.localHost.scopeId.slice(0, 40)
    const origin = ready.localHost.origin
    const launch = readJson(join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'launch.json'))
    assertWebFullyOff(ready, 'PB-01')
    assertProtectedOwners(ready, 'PB-01')
    const offHttp = await assertWebOffHttp(origin, 'PB-01')
    const protectedUids = rowUids(ready)
    const { peer } = await startPeer('PB-01')
    assertToggle(await webAccess(peer, 'PB-01', undefined), 'disabled', 'PB-01 getStatus')
    // A real Split TUI works on the default-off Host and owns Session T.
    await seatFree(`\0dsh-pi-tui-c-${webScopeSuffix}`, 15_000)
    const tui = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    clients.push(tui)
    const tuiReady = await tui.waitFor(record => record.m4a0 === 'ready', 'PB-01 TUI ready', 180_000)
    assertClientHostFacts(tuiReady.host, ready.localHost, 'PB-01 TUI vs Host')
    assert(tuiReady.surfaceMounted === true && tuiReady.transport === 'connected',
      'PB-01 the default-off Host does not serve a real TUI surface')
    /** The real TUI reads the SAME Host Account state while Web is on/off. */
    const assertTuiAccountSignedOut = async label => {
      tui.send('/login deepseek-account\r')
      await tui.waitForScreen('DeepSeek Account', `${label} TUI Account page`, 60_000)
      await tui.waitForScreen('Signed out / no stored credential', `${label} TUI Host Account state`, 30_000)
      tui.send('\x1b')
      await waitForCondition(async () => (await tui.viewport()).join('\n').includes('[Categories (9)]'),
        `${label} TUI Account page yielded to Settings`, 20_000)
      tui.send('\x1b')
      await waitForCondition(async () => {
        const frame = (await tui.viewport()).join('\n')
        return !frame.includes('DeepSeek Account') && !frame.includes('[Categories (9)]')
      }, `${label} TUI returned to its Session`, 20_000)
      trace('t73-account-tui-state', { label, account: 'signed-out', hostCredential: 'absent', webToggle: label.startsWith('PB-10') ? 'off' : 'on' })
    }
    // The first real Turn is HELD and stays held across BOTH toggles: the
    // default-off HTTP surface, the Web enable and the Web disable are all
    // asserted while the Host is genuinely mid-Turn, and the barrier is
    // created exactly once, after the disable. Re-holding a second time
    // would race the agent's own follow-up step.
    // Session T is CREATED by this first prompt, so its durable log starts
    // empty; every witness below is counted from that empty baseline.
    const heldStart = 0
    tui.send('pr-b plain tui\r')
    await tui.waitForScreen('pr-b plain tui', 'PB-01 TUI prompt painted', 120_000)
    const plainHeld = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'long-turn-held' && event.userText.includes('pr-b plain tui'),
      'PB-01 held Turn', 120_000)
    assert(plainHeld.agentStatus === 'running',
      `PB-01 the Host Agent was ${JSON.stringify(plainHeld.agentStatus)} while the Turn was held`)
    const sessionT = (await waitForSurfaceStatus(tui,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'PB-01 TUI Session')).openSessionId
    trace('t73-web-default-off', {
      webRowsDeclared: PR_A_WEB_ROWS.length,
      webRowsLive: 0,
      rootStatus: offHttp.root,
      pluginStatus: offHttp.plugin,
      sseStatus: offHttp.sse,
      apiStatus: offHttp.api,
      connectStatus: offHttp.connect,
      tuiSession: sessionT,
      tuiTurn: 'held (accepted and still running; settled after the disable)',
      webRowStates: 'absent (no Web row has ever mounted on this cold boot)',
      hostServices: ready.services?.piTuiWebAccess === true ? 'piTuiWebAccess live' : 'missing',
    })

    // ── B. Enable the official Web frontend (PB-02/PB-03) ───────────────
    assertToggle(await webAccess(peer, 'PB-02', true), 'enabled', 'PB-02 setEnabled(true)')
    const enabledStatus = await hostStatus(host)
    const enabledStates = assertWebFullyOn(enabledStatus, 'PB-02')
    assertProtectedOwners(enabledStatus, 'PB-02')
    assertIdentityFields(enabledStatus.localHost, ready.localHost, 'PB-02 Host identity')
    for (const id of ['web-runtime', 'modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller']) {
      assert(enabledStates.get(id) === 'active', `PB-02 the "${id}" row is ${enabledStates.get(id)}, not active`)
    }
    // S5-PR5: the changed-files Host recorder and its consumer must BOTH be
    // part of the enabled composition; a PENDING `ui-deliverables` would mean
    // the advertised Deliverables surface is not actually live.
    for (const id of ['workspace-changes', 'ui-deliverables']) {
      assert(enabledStates.get(id) === 'active',
        `PB-02 the "${id}" row is ${enabledStates.get(id)}, not active; an enabled Web claim requires it`)
    }
    const workspaceChangesRows = (enabledStatus.entries ?? [])
      .filter(entry => entry.name === '@deepseek-ai/dsh-workspace-changes')
    assert(workspaceChangesRows.length === 1,
      `PB-02 expected exactly ONE "@deepseek-ai/dsh-workspace-changes" Host row, found ${workspaceChangesRows.length}`)
    // The shared Host owners keep their LIVE fiber: the toggle mounted the Web
    // rows and nothing else.
    const enabledUids = rowUids(enabledStatus)
    for (const id of ['agent', 'session', 'job-controller', 'typert-gateway', 'split-host-connection',
      'split-host-api-remotes', 'split-host-session-controller', 'split-host-account-controller', 'split-host-pi-tui-runtime']) {
      assert(enabledUids[id] === protectedUids[id], `PB-05 the "${id}" Host owner was re-mounted by the Web enable`)
    }
    const serving = await assertWebServing(origin, launch, 'PB-03')
    assertProtectedOwners(await hostStatus(host), 'PB-03')
    trace('t73-web-enabled', {
      rowsActive: [...enabledStates].filter(([, state]) => state === 'active').length,
      rowsNotActive: [...enabledStates].filter(([, state]) => state !== 'active').map(([id, state]) => `${id}:${state}`),
      tokenExchange: serving.exchange,
      indexStatus: serving.index,
      graphEntries: serving.graphEntries,
      graphBatches: serving.graphBatches,
      sseStatus: serving.sse,
      unknownPluginStatus: serving.unknownPlugin,
      uiDeliverables: enabledStates.get('ui-deliverables'),
      workspaceChanges: enabledStates.get('workspace-changes'),
      accountControllerOwner: enabledStatus.ownerEntries?.accountController?.[0],
      accountControllerFiberUid: enabledUids['split-host-account-controller'],
      accountControllerFiberUnchanged: enabledUids['split-host-account-controller'] === protectedUids['split-host-account-controller'],
      hostOwnersRemounted: false,
    })
    await assertTuiAccountSignedOut('PB-03')

    // ── C. Disable while a real TUI holds an accepted Turn (PB-04/PB-05/PB-06) ──
    const tuiGeneration = lastSurfaceStatus(tui)?.generationId
    assert(typeof tuiGeneration === 'number', 'PB-05 the TUI published no transport generation to freeze')
    // The SAME accepted Turn is still in flight: it was held before the
    // enable and has not been released or cancelled since.
    const heldStillPending = readC1WorkEvents(workRoot).every(event =>
      event.kind !== 'long-turn-released' || event.sessionId !== sessionT)
    assert(heldStillPending, 'PB-05 the accepted Turn was released before the disable')
    await tui.waitForScreen('long-turn started', 'PB-06 the running Turn is painted', 120_000)
    assertToggle(await webAccess(peer, 'PB-04', false), 'disabled', 'PB-04 setEnabled(false)')
    const disabledStatus = await hostStatus(host)
    assertWebFullyOff(disabledStatus, 'PB-04')
    const disabledStates = webStates(disabledStatus)
    for (const id of ['workspace-changes', 'ui-deliverables']) {
      const state = disabledStates.get(id)
      assert(state === 'absent' || state === 'state-4',
        `PB-04 the "${id}" row is ${String(state)} after the disable, expected a released fiber`)
    }
    assertProtectedOwners(disabledStatus, 'PB-04')
    assertIdentityFields(disabledStatus.localHost, ready.localHost, 'PB-04 Host identity')
    const disabledUids = rowUids(disabledStatus)
    for (const id of ['agent', 'session', 'job-controller', 'typert-gateway', 'split-host-connection',
      'split-host-api-remotes', 'split-host-session-controller', 'split-host-account-controller', 'split-host-pi-tui-runtime']) {
      assert(disabledUids[id] === protectedUids[id], `PB-05 the "${id}" Host owner changed identity across the disable`)
    }
    const offAfterDisable = await assertWebOffHttp(origin, 'PB-04')
    const tuiStillOn = await waitForSurfaceStatus(tui,
      record => record.sessionOpen === true && record.openSessionId === sessionT && record.transport === 'connected',
      'PB-04 the TUI kept its Session')
    assert(tuiStillOn.generationId === tuiGeneration, 'PB-05 the TUI transport generation changed across the disable')
    // The accepted Turn was NOT cancelled: release it AFTER the disable and
    // read its settlement from the durable Host log and the TUI frame.
    writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
    const settled = await waitForHostSessionEventAfter(dshHome, sessionT, heldStart,
      event => event.type === 'turn/end', 'PB-06 the held Turn settled after the disable', 180_000)
    assert(settled !== undefined, 'PB-05 the accepted Turn produced no settlement')
    const settledEvents = hostSessionEvents(dshHome, sessionT) ?? []
    assert(hostUserTexts(settledEvents).filter(text => text === 'pr-b plain tui').length === 1,
      'PB-05 the accepted prompt was committed more than once across the toggle')
    assert(hostAssistantHasText(settledEvents, 'long-turn answer'),
      'PB-05 the Host persisted no assistant answer after the disable')
    // The answer's own attempt number comes from the durable Host log, never
    // from a guess: the frame must show the answer the Host committed.
    const answerPrefix = events => {
      const answer = events.find(event => event.type === 'assistant/message')
      const prefix = /long-turn answer \d+/u.exec(JSON.stringify(answer?.data ?? ''))?.[0]
      assert(prefix !== undefined, 'PB-06 the durable answer carries no attempt prefix')
      return prefix
    }
    const heldAnswer = answerPrefix(settledEvents.slice(heldStart))
    await tui.waitForScreen(heldAnswer, 'PB-06 the TUI painted the answer after the disable', 180_000)
    // The same TUI Session accepts a NEW prompt with Web still off.
    const afterDisableStart = (hostSessionEvents(dshHome, sessionT) ?? []).length
    const postDisablePrompt = 'pr-b after disable'
    const postDisableEvidenceStart = promptEvidence().length
    tui.send(`${postDisablePrompt}\r`)
    await tui.waitForScreen('pr-b after disable', 'PB-06 the TUI prompt painted with Web off', 120_000)
    await waitForHostSessionEventAfter(dshHome, sessionT, afterDisableStart,
      event => event.type === 'user/message' && JSON.stringify(event).includes('pr-b after disable'),
      'PB-06 the Host accepted a new prompt with Web off', 180_000)
    await waitForHostSessionEventAfter(dshHome, sessionT, afterDisableStart,
      event => event.type === 'turn/end', 'PB-06 the post-disable Turn settled', 180_000)
    const postDisableAnswer = answerPrefix((hostSessionEvents(dshHome, sessionT) ?? []).slice(afterDisableStart))
    await tui.waitForScreen(postDisableAnswer, 'PB-06 the TUI painted the post-disable answer', 180_000)
    const postDisableRequests = promptEvidence().slice(postDisableEvidenceStart)
    const postDisableStandard = postDisableRequests.filter(record => record.presentTool === true)
    assert(postDisableStandard.length === 1 && postDisableStandard[0].markerCount === 1
      && postDisableStandard[0].presentInstruction === true,
    `PB-06 the Web-off fresh standard prompt lost shared delivery guidance: ${JSON.stringify({ records: postDisableRequests.length, standard: postDisableStandard })}`)
    trace('t73-web-disabled-live', {
      webRowsLive: 0,
      webRowStates: 'state-4 (every Web row DISPOSED by the toggle)',
      rootStatus: offAfterDisable.root,
      pluginStatus: offAfterDisable.plugin,
      sseStatus: offAfterDisable.sse,
      apiStatus: offAfterDisable.api,
      connectStatus: offAfterDisable.connect,
      tuiSessionRetained: sessionT,
      tuiGenerationUnchanged: true,
      acceptedTurnSettled: true,
      postDisablePrompt: 'answered',
      accountControllerOwner: disabledStatus.ownerEntries?.accountController?.[0],
      accountControllerFiberUid: disabledUids['split-host-account-controller'],
      accountControllerFiberUnchanged: disabledUids['split-host-account-controller'] === protectedUids['split-host-account-controller'],
      hostOwnersRemounted: false,
    })

    // ── D. Enable again on the SAME Host (PB-07) ────────────────────────
    assertToggle(await webAccess(peer, 'PB-07', true), 'enabled', 'PB-07 setEnabled(true) again')
    const reenabledStatus = await hostStatus(host)
    const reenabledStates = assertWebFullyOn(reenabledStatus, 'PB-07')
    for (const id of ['workspace-changes', 'ui-deliverables']) {
      assert(reenabledStates.get(id) === 'active',
        `PB-07 the "${id}" row is ${reenabledStates.get(id)}, not active after the re-enable`)
    }
    assertProtectedOwners(reenabledStatus, 'PB-07')
    assertIdentityFields(reenabledStatus.localHost, ready.localHost, 'PB-07 Host identity')
    const reenabledUids = rowUids(reenabledStatus)
    for (const id of ['agent', 'session', 'job-controller', 'typert-gateway', 'split-host-connection',
      'split-host-api-remotes', 'split-host-session-controller', 'split-host-account-controller', 'split-host-pi-tui-runtime']) {
      assert(reenabledUids[id] === protectedUids[id], `PB-07 the "${id}" Host owner changed identity across the re-enable`)
    }
    const servingAgain = await assertWebServing(origin, launch, 'PB-07')
    // The real Chromium run: a NEW Browser Session on the SAME Host process.
    if (playwrightRoot === undefined || playwrightRoot === '') {
      assert(!requireBrowser,
        'PB-07 the real-Browser case is REQUIRED (SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1 (or a selected Web case)) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the Browser proof')
      trace('t73-web-browser', {
        status: 'NOT_RUN',
        reason: 'SPLIT_PROCESS_PLAYWRIGHT_ROOT is not set; this run does NOT exercise a real Browser after the re-enable and does not claim it',
      })
    } else {
      const coordination = join(toggleRoot, 'browser')
      mkdirSync(coordination, { recursive: true, mode: 0o700 })
      chmodSync(coordination, 0o700)
      const marker = `pr-b browser ${randomUUID().slice(0, 8)}`
      const chromiumLibs = process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
      const browsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
      const browserProcess = spawn(process.execPath, [
        join(SCRIPT_DIR, 'fixtures', 'pr-a-web-browser.mjs'),
        coordination,
        marker,
      ], {
        cwd: workDir,
        env: {
          ...env,
          PR_A_DSH_HOME: dshHome,
          PR_A_PLAYWRIGHT_ROOT: playwrightRoot,
          PR_A_EXPECTED_ANSWER_PREFIX: 'long-turn answer',
          PR_A_ACCOUNT_UI_CHECK: '1',
          PLAYWRIGHT_BROWSERS_PATH: browsers,
          LD_LIBRARY_PATH: `${chromiumLibs}${process.env.LD_LIBRARY_PATH === undefined ? '' : `:${process.env.LD_LIBRARY_PATH}`}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      let browserOut = ''
      let browserErr = ''
      browserProcess.stdout.setEncoding('utf8')
      browserProcess.stdout.on('data', chunk => { browserOut += chunk })
      browserProcess.stderr.setEncoding('utf8')
      browserProcess.stderr.on('data', chunk => { browserErr += chunk })
      const browserExit = new Promise(resolveExit => browserProcess.on('close', (code, signal) => resolveExit({ code, signal })))
      const browserExitBounded = timeoutMs => browserDriverExitBounded(browserExit, timeoutMs, 'PR_B_BROWSER_EXIT_TIMEOUT')
      try {
        // The Browser Session file is a fact the DRIVER owns: a driver that
        // exited early can never write it, so the wait must fail with the
        // exit facts instead of burning its whole budget.
        await whileBrowserDriverRuns(
          browserExit,
          signal => waitForCondition(
            () => existsSync(join(coordination, 'browser-session.json')),
            'PR-B Browser Session creation', 240_000, signal,
          ),
          'PB-07',
          'the Browser Session file appeared',
        )
        const browserSession = readJson(join(coordination, 'browser-session.json')).sessionId
        assert(typeof browserSession === 'string' && browserSession !== '', 'PB-07 the Browser created no Host Session')
        // A REAL TUI attaches to the Browser's Session on the SAME Host, so
        // "the Browser Turn is visible to the TUI" is a real frame fact of a
        // Client that never typed the marker. The other TUI keeps owning
        // Session T for the continuity witnesses.
        await seatFree(`\0dsh-pi-tui-c-${webScopeSuffix}`, 15_000)
        const browserTui = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: browserSession },
        })
        clients.push(browserTui)
        const browserTuiReady = await browserTui.waitFor(record => record.m4a0 === 'ready', 'PB-07 Browser-Session TUI ready', 180_000)
        assertClientHostFacts(browserTuiReady.host, ready.localHost, 'PB-07 Browser-Session TUI vs Host')
        await waitForSurfaceStatus(browserTui,
          record => record.sessionOpen === true && record.openSessionId === browserSession,
          'PB-07 the TUI attached to the Browser Session')
        // The Browser's Turn answers immediately: this case proves the
        // re-enabled graph serves a REAL Browser, not a second held Turn.
        // The barrier is already present (phase C released the held Turn with
        // it); writing it again keeps this case independent of that ordering.
        writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
        writeFileSync(join(coordination, 'browser-go'), `${Date.now()}\n`, { mode: 0o600 })
        const browserEvents = await waitDurableTurn(browserSession, marker, 'PB-07 Browser')
        await browserTui.waitForScreen(marker, 'PB-07 the TUI painted the Browser prompt', 180_000)
        const browserAnswer = events => {
          const answer = events.find(event => event.type === 'assistant/message')
          const prefix = /long-turn answer \d+/u.exec(JSON.stringify(answer?.data ?? ''))?.[0]
          assert(prefix !== undefined, 'PB-07 the durable Browser answer carries no attempt prefix')
          return prefix
        }
        await browserTui.waitForScreen(browserAnswer(browserEvents), 'PB-07 the TUI painted the Browser answer', 180_000)
        const browserResult = await browserExitBounded(180_000)
        const browserReport = readJson(join(coordination, 'browser-result.json'))
        assert(browserResult.code === 0,
          `PB-07 the real Chromium driver failed (exit ${JSON.stringify(browserResult.code)}/${String(browserResult.signal)}): ${redactWebQualificationText(browserReport.error ?? 'driver-failure', [servingAgain.token])}`)
        assert(browserReport.indexStatus === 200,
          `PB-07 the real Browser loaded no authenticated index (${browserReport.indexStatus})`)
        assert(browserReport.sessionId === browserSession, 'PB-07 the Browser reported a different Session')
        assert(browserReport.answerSeen === true, 'PB-07 the Browser never painted the Host answer')
        assert(browserReport.accountSignedOut === true,
          'PB-07 the official Web Account UI did not read the shared signed-out Host Account state')
        browserCase = 'PASS'
        verdict.browser = {
          indexStatus: browserReport.indexStatus,
          sessionId: browserSession,
          accountSignedOut: browserReport.accountSignedOut,
          tuiPainted: [marker, browserAnswer(browserEvents)],
          hostTurn: 'complete',
          consoleErrors: browserReport.consoleErrors.length,
          screenshot: browserReport.screenshot,
        }
      } finally {
        try { process.kill(-browserProcess.pid, 'SIGKILL') } catch { /* already exited */ }
        const cleanupExit = await browserExitBounded(15_000)
        if (browserCase !== 'PASS') {
          browserCase = existsSync(join(coordination, 'browser-result.json')) ? 'FAILED' : 'INCOMPLETE'
          process.stderr.write(`PR_B_BROWSER_DIAGNOSTIC: ${redactWebQualificationText(
            `${browserErr} ${browserOut}`, [servingAgain.token],
          ).trim().split('\n').slice(-3).map(line => line.slice(0, 300)).join(' | ')}\n`)
        }
        trace('t73-web-browser-result', {
          status: browserCase,
          ...(verdict.browser ?? {}),
          driverExit: cleanupExit.code,
          driverSignal: cleanupExit.signal,
        })
      }
    }
    trace('t73-web-reenabled', {
      rowsActive: [...webStates(reenabledStatus)].filter(([, state]) => state === 'active').length,
      tokenExchange: servingAgain.exchange,
      indexStatus: servingAgain.index,
      graphEntries: servingAgain.graphEntries,
      sseStatus: servingAgain.sse,
      sameHostProcess: true,
      hostOwnersRemounted: false,
    })

    // ── E. Disable again and finish the official Host (PB-04/PB-10) ──────
    assertToggle(await webAccess(peer, 'PB-10', false), 'disabled', 'PB-10 setEnabled(false) again')
    const finalOff = await hostStatus(host)
    assertWebFullyOff(finalOff, 'PB-10')
    assertProtectedOwners(finalOff, 'PB-10')
    assertIdentityFields(finalOff.localHost, ready.localHost, 'PB-10 Host identity')
    const finalOffHttp = await assertWebOffHttp(origin, 'PB-10')
    // The toggle never persisted anything: the profile patch the Host booted
    // with is byte-identical, so the next cold boot is default-off again.
    const profilePatchAfter = existsSync(hostProfiles.profilePath)
      ? readFileSync(hostProfiles.profilePath)
      : undefined
    assert(profilePatchBefore === undefined
      ? profilePatchAfter === undefined
      : profilePatchAfter !== undefined && profilePatchAfter.equals(profilePatchBefore),
    'PB-10 the Web toggle wrote the profile patch')
    // The TUI is still usable after the second disable.
    const finalUids = rowUids(finalOff)
    assert(finalUids['split-host-account-controller'] === protectedUids['split-host-account-controller'],
      'PB-10 the official Account Controller owner changed identity across the final Web disable')
    await assertTuiAccountSignedOut('PB-10')
    tui.send('/exit\r')
    const tuiExit = await tui.waitForExit(60_000)
    assert(tuiExit.code === 0 && tuiExit.signal === null, `PB-10 TUI exit was ${JSON.stringify(tuiExit)}`)
    const hostShutdown = await host.shutdown()
    assert(hostShutdown.code === 0, `PB-10 official Host shutdown exit was ${JSON.stringify(hostShutdown)}`)
    trace('t73-web-toggle-final', {
      rootStatus: finalOffHttp.root,
      pluginStatus: finalOffHttp.plugin,
      sseStatus: finalOffHttp.sse,
      apiStatus: finalOffHttp.api,
      connectStatus: finalOffHttp.connect,
      tuiUsable: true,
      accountControllerOwner: finalOff.ownerEntries?.accountController?.[0],
      accountControllerFiberUid: finalUids['split-host-account-controller'],
      accountControllerFiberUnchanged: finalUids['split-host-account-controller'] === protectedUids['split-host-account-controller'],
      profilePatchUnchanged: true,
      hostShutdownExit: hostShutdown.code,
    })

    // ── F. Negative lanes: a partial Web surface is never served (PB-08/PB-09) ──
    const negatives = {}
    // (1) The official Web ASSET is missing. The plan's PB-09 disjunction is
    // "an intentionally unavailable Web asset/core module leads to
    // `unavailable`/error AND a non-served index". The official
    // `frontend-static` owner resolves its dist at REQUEST time (its own
    // contract), so the toggle CANNOT see a missing page during enable
    // without adding the request-time HTTP probe the plan forbids — the
    // serving half below is therefore the authentic witness here; lane (2)
    // proves the `unavailable`/error half for a CORE module. The dist is
    // restored byte for byte.
    const distIndex = join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
    const savedDist = saveFile(distIndex)
    const missingDist = `${distIndex}.missing-pr-b`
    try {
      renameSync(distIndex, missingDist)
      await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
      const absentHost = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
        SPLIT_PROCESS_PROMPT_EVIDENCE: promptEvidencePath,
          C1_SCENARIO: 'long-turn',
          C1_WORK_ROOT: workRoot,
          C1_HOLD_LONG_TURN: longTurnBarrier,
        },
      })
      hosts.push(absentHost)
      const absentReady = await absentHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 dist-absent Host ready', 240_000)
      const { peer: absentPeer } = await startPeer('PB-09')
      const absentRecord = await webAccess(absentPeer, 'PB-09', true)
      assert(absentRecord.ok === true, `PB-09 the enable call itself failed: ${JSON.stringify(absentRecord.errorCode ?? null)}`)
      assert(absentRecord.status?.state === 'enabled' || absentRecord.status?.state === 'unavailable',
        `PB-09 a Host with NO official frontend dist reported ${JSON.stringify(absentRecord.status)}`)
      // The index chain is probed the ONLY way the official Web shell admits
      // a page: launch token -> 303 -> signed index cookie -> `/`. A mux
      // credential or an unauthenticated probe would only prove the
      // admission gate, never that a missing dist serves nothing.
      const absentLaunch = readJson(join(dshHome, 'run', 'dsh-pi-tui', absentReady.localHost.scopeId, 'launch.json'))
      const absentIndex = await readHostWebIndex(absentReady.localHost.origin, absentLaunch, 'PB-09')
      assert(!(absentIndex.index.status === 200 && absentIndex.hasModuleLoader),
        `PB-09 a Host whose official frontend dist is missing SERVED a DSH Web index (HTTP ${absentIndex.index.status})`)
      assert(absentIndex.graph === undefined,
        'PB-09 a Host whose official frontend dist is missing served a browser graph')
      // The plan's `unavailable` verdict belongs to a Web surface that cannot
      // be COMPOSED; the official static owner resolves its dist per request,
      // so the enable can only be truthful about the mounted graph. Record
      // the verdict honestly and prove the serving half above.
      assert(absentRecord.status?.state === 'enabled' || absentRecord.status?.state === 'unavailable',
        `PB-09 unexpected verdict for a missing asset: ${JSON.stringify(absentRecord.status)}`)
      negatives.distAbsent = {
        reported: absentRecord.status?.state,
        tokenExchange: absentIndex.exchange.status,
        indexStatus: absentIndex.index.status,
        indexServed: absentIndex.index.status === 200 && absentIndex.hasModuleLoader,
        officialStaticOwnsRequestTimeRead: true,
      }
      try { await absentHost.shutdown() } catch { /* the outcome owns it */ }
    } finally {
      renameSync(missingDist, distIndex)
      assert(existsSync(distIndex) && readFileSync(distIndex).equals(savedDist.bytes),
        'PB-09 the official frontend dist was not restored byte for byte')
    }
    // (2) A CORE Web module cannot be imported: the enable must refuse with
    // `unavailable` and serve nothing. The installed module is restored byte
    // for byte.
    const modulesEntry = join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-client-modules/package.json')), 'lib', 'index.js')
    const savedModules = saveFile(modulesEntry)
    const missingModules = `${modulesEntry}.missing-pr-b`
    try {
      renameSync(modulesEntry, missingModules)
      await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
      const brokenModuleHost = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
        SPLIT_PROCESS_PROMPT_EVIDENCE: promptEvidencePath,
          C1_SCENARIO: 'long-turn',
          C1_WORK_ROOT: workRoot,
          C1_HOLD_LONG_TURN: longTurnBarrier,
        },
      })
      hosts.push(brokenModuleHost)
      const brokenReady = await brokenModuleHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 broken-module Host ready', 240_000)
      const { peer: brokenPeer } = await startPeer('PB-09 broken module')
      const brokenRecord = await webAccess(brokenPeer, 'PB-09', true)
      assert(brokenRecord.ok === true && brokenRecord.status?.state === 'unavailable',
        `PB-09 a Host whose core Web module cannot be imported reported ${JSON.stringify(brokenRecord.status)}`)
      assert(/fiber|module|import/iu.test(String(brokenRecord.status.reason ?? '')),
        `PB-09 the unavailable reason does not name the failed mount: ${String(brokenRecord.status.reason ?? '')}`)
      const brokenIndex = await readHostWebIndex(brokenReady.localHost.origin,
        readJson(join(dshHome, 'run', 'dsh-pi-tui', brokenReady.localHost.scopeId, 'launch.json')), 'PB-09')
      assert(!(brokenIndex.index.status === 200 && brokenIndex.hasModuleLoader),
        `PB-09 the refused core module still served a DSH Web index (HTTP ${brokenIndex.index.status})`)
      const brokenActive = [...webStates(await hostStatus(brokenModuleHost))]
        .filter(([, state]) => state === 'active').map(([id]) => id)
      assert(brokenActive.length === 0,
        `PB-09 a refused enable left these Web rows mounted: ${brokenActive.join(',')}`)
      negatives.coreModuleUnavailable = {
        reported: brokenRecord.status?.state,
        indexStatus: brokenIndex.index.status,
        rowsLeftMounted: brokenActive.length,
      }
      try { await brokenModuleHost.shutdown() } catch { /* the outcome owns it */ }
    } finally {
      renameSync(missingModules, modulesEntry)
      assert(existsSync(modulesEntry) && readFileSync(modulesEntry).equals(savedModules.bytes),
        'PB-09 the official client-modules entry was not restored byte for byte')
    }
    // (2) A second owner of the same official Web package: the roster is
    // refused before any row is toggled.
    const duplicatePatch = join(toggleRoot, 'pr-b-duplicate-modules.patch.yml')
    writeFileSync(duplicatePatch, `${readFileSync(hostPatch, 'utf8').trimEnd()}\n- insert:\n    - id: modules-duplicate\n      name: '${PR_A_CLIENT_MODULES_PACKAGE}'\n      disabled: true\n`, { mode: 0o600 })
    chmodSync(duplicatePatch, 0o600)
    await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
    const duplicateHost = new EntryProcess('host', entries.host, {
      ...base,
      env: {
        ...base.env,
        SPLIT_PROCESS_EXTRA_PATCH: duplicatePatch,
        C1_SCENARIO: 'long-turn',
        C1_WORK_ROOT: workRoot,
        C1_HOLD_LONG_TURN: longTurnBarrier,
      },
    })
    hosts.push(duplicateHost)
    const duplicateReady = await duplicateHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 duplicate-modules Host ready', 240_000)
    const { peer: duplicatePeer } = await startPeer('PB-09 duplicate')
    const duplicateRecord = await webAccess(duplicatePeer, 'PB-09', true)
    assert(duplicateRecord.ok === true && duplicateRecord.status?.state === 'unavailable',
      `PB-09 a Host with a SECOND official module owner reported ${JSON.stringify(duplicateRecord.status)}`)
    assert(/second .*dsh-client-modules/u.test(String(duplicateRecord.status.reason ?? '')),
      `PB-09 the refusal did not name the duplicate owner: ${String(duplicateRecord.status.reason ?? '')}`)
    const duplicateRoot = await fetchStatus(`${duplicateReady.localHost.origin}/`)
    assert(duplicateRoot.status === 404, `PB-09 the refused duplicate composition served an index (HTTP ${duplicateRoot.status})`)
    negatives.duplicateModules = { reported: duplicateRecord.status?.state, rootStatus: duplicateRoot.status }
    try { await duplicateHost.shutdown() } catch { /* the outcome owns it */ }
    rmSync(duplicatePatch, { force: true })
    // (3) A malformed `enabled` is refused by the v2 Remote contract, not by
    // the control channel: the Host never runs a mutation for it.
    await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
    const contractHost = new EntryProcess('host', entries.host, {
      ...base,
      env: {
        ...base.env,
        SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
        SPLIT_PROCESS_PROMPT_EVIDENCE: promptEvidencePath,
        C1_SCENARIO: 'long-turn',
        C1_WORK_ROOT: workRoot,
        C1_HOLD_LONG_TURN: longTurnBarrier,
      },
    })
    hosts.push(contractHost)
    const contractReady = await contractHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 contract Host ready', 240_000)
    const { peer: contractPeer } = await startPeer('PB-09 contract')
    const malformed = await webAccess(contractPeer, 'PB-09 malformed', 'yes')
    assert(malformed.ok === false, `PB-09 a malformed boolean was accepted: ${JSON.stringify(malformed)}`)
    assert(malformed.errorCode === 'gateway/input-invalid',
      `PB-09 the malformed argument was refused as ${String(malformed.errorCode)}, not by the v2 contract`)
    const contractRoot = await fetchStatus(`${contractReady.localHost.origin}/`)
    assert(contractRoot.status === 404, `PB-09 a refused mutation served an index (HTTP ${contractRoot.status})`)
    assertToggle(await webAccess(contractPeer, 'PB-09 after-refusal', undefined), 'disabled',
      'PB-09 the refused mutation must not change the Host state')
    negatives.malformedArgument = { code: malformed.errorCode, rootStatus: contractRoot.status }
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'PB-09 the candidate artifact changed during the Web toggle qualification')
    try { await contractHost.shutdown() } catch { /* the outcome owns it */ }
    trace('t73-web-negative-controls', negatives)
  } finally {
    for (const client of clients) {
      try { await client.dispose() } catch { /* best effort */ }
    }
    for (const peer of peers) {
      if (peer.exited) continue
      try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const host of hosts) {
      if (host.exited) continue
      try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    rmSync(longTurnBarrier, { force: true })
  }
  assert(!requireBrowser || browserCase === 'PASS',
    `PB-07 the required real-Browser qualification ended as ${String(browserCase)}; only PASS qualifies this case`)
  return { status: 'PASS', browser: browserCase }
}
