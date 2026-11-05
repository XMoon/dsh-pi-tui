/**
 * M5-W PR-A official Web composition: default-off, isolated enable and a
 * real Chromium x real Split TUI on the SAME Host/Session.
 *
 * @module split-process/official-web-composition
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

export async function runOfficialWebComposition(context) {
  const { EntryProcess, SurfaceEntryProcess, workDir, dshHome, base, entries, tarball, candidateSha256, targetDshVersion, trace, mode } = context
  const { env, anchor, surfaceLlm } = context.installation
  const requireBrowser = mode === 'selected' || process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'
  let webScopeSuffix
  const webRoot = join(workDir, 'pr-a-web')
  mkdirSync(webRoot, { recursive: true, mode: 0o700 })
  chmodSync(webRoot, 0o700)
  const webHosts = []
  const webClients = []
  const negatives = {}
  /**
   * Every Host-only overlay a live `host-scratch-*` process wrote under this
   * isolated DSH home. The scope directory is discovered (never derived from
   * the truncated seat-name suffix) so a snapshot before/after one boot can
   * tell WHICH overlay this Host wrote.
   */
  const hostScratchOverlays = () => {
    const root = join(dshHome, 'run', 'dsh-pi-tui')
    if (!existsSync(root)) return []
    const overlays = []
    for (const scope of readdirSync(root, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue
      for (const entry of readdirSync(join(root, scope.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('host-scratch-')) continue
        const overlay = join(root, scope.name, entry.name, 'host-only.patch.yml')
        if (existsSync(overlay)) overlays.push(overlay)
      }
    }
    return overlays
  }
  /** Compare the LIVE overlay against the frozen roster (id, name, order, disabled). */
  const assertDeclaredWebRows = (overlayPath, label) => {
    const entries = parseYaml(readFileSync(overlayPath, 'utf8'))
    const inserts = entries.filter(entry => Array.isArray(entry.insert))
    assert(inserts.length === 2, `${label}: expected the Host execution insert and ONE Web insert, found ${inserts.length}`)
    const rows = inserts[inserts.length - 1].insert
    assert(rows.length === PR_A_WEB_ROWS.length,
      `${label}: the Web insert declares ${rows.length} rows, expected ${PR_A_WEB_ROWS.length}`)
    // The lane's `assert` is a plain predicate, not node:assert: compare the
    // two sequences through one canonical JSON projection.
    assert(JSON.stringify(rows.map(row => row.id)) === JSON.stringify(PR_A_WEB_ROWS.map(row => row.id)),
      `${label}: the Web insert ids drifted from the frozen roster`)
    assert(JSON.stringify(rows.map(row => row.name)) === JSON.stringify(PR_A_WEB_ROWS.map(row => row.name)),
      `${label}: a Web row was re-pointed at a different package`)
    assert(rows.every(row => row.disabled === true), `${label}: every Web row must be disabled by default`)
    const runtime = rows.find(row => row.id === PR_A_WEB_RUNTIME_ID)
    assert(runtime !== undefined, `${label}: the Web runtime row is missing`)
    assert(JSON.stringify(runtime.inject) === JSON.stringify(['webServer']),
      `${label}: web-runtime must inject the existing webserver only`)
    assert(JSON.stringify(runtime.config) === JSON.stringify({ openBrowser: false, printUrl: false, surfaceContext: false }),
      `${label}: web-runtime config must stay false/false/false`)
    return rows
  }
  /** The Host authorities the Web composition must not duplicate. */
  const assertHostOwnersUnchanged = (ready, label) => {
    for (const owner of ['connection', 'apiRemotes', 'workspaceRegistry', 'workspaceController', 'sessionController', 'fileUpload', 'settingsController', 'typertGateway', 'jobController', 'piTuiHostRuntime']) {
      assert(ready.ownerEntries?.[owner]?.length === 1,
        `${label}: the ${owner} owner count is ${JSON.stringify(ready.ownerEntries?.[owner])}, expected exactly one`)
    }
    assert(ready.webServer?.host === '127.0.0.1' && typeof ready.webServer?.port === 'number' && ready.webServer.port > 0,
      `${label}: the ONE loopback listener is not a bound 127.0.0.1 port (${JSON.stringify(ready.webServer)})`)
  }
  /** The ONE per-package owner count of the core official Web rows. */
  const assertSingleWebOwners = (ready, label) => {
    assertHostOwnersUnchanged(ready, label)
    for (const name of PR_A_SINGLETON_PACKAGES) {
      const rows = ready.entries.filter(entry => entry.name === name)
      assert(rows.length === 1, `${label}: expected exactly ONE "${name}" Loader row, found ${rows.length}`)
      assert(rows[0].state === 'active', `${label}: the "${name}" row is ${rows[0].state}, not active`)
    }
  }
  /** Read the Host's own launch material for the ONE browser cookie chain. */
  const launchOf = ready => readJson(join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'launch.json'))
  /** The official Web-created marker fact in the Host's OWN Session log. */
  const waitBrowserTurn = async (sessionId, marker, label) => {
    const userMessage = await waitForHostSessionEventAfter(
      dshHome, sessionId, 0,
      event => event.type === 'user/message' && JSON.stringify(event).includes(marker),
      `${label} Host user/message`, 120_000,
    )
    assert(userMessage !== undefined, `${label}: the Host never persisted the Browser prompt`)
    await waitForHostSessionEventAfter(
      dshHome, sessionId, 0,
      event => event.type === 'turn/end', `${label} Host turn/end`, 120_000,
    )
    const events = hostSessionEvents(dshHome, sessionId) ?? []
    const users = hostUserTexts(events).filter(text => text === marker).length
    assert(users === 1, `${label}: the Host committed the Browser prompt ${users} times, expected exactly 1`)
    assert(hostAssistantHasText(events, 'stub answer'), `${label}: the Host persisted no assistant answer`)
  }
  // The real-Browser case verdict this qualification reports to the caller;
  // it is function-scoped because the final inventory reads it.
  let browserCase = 'NOT_RUN'
  let browserFacts
  try {
    // ── A. The plain candidate: no Web surface, real TUI still works ────
    const scratchBefore = new Set(hostScratchOverlays())
    const plainHost = new EntryProcess('host', entries.host, base)
    webHosts.push(plainHost)
    const plainReady = await plainHost.waitFor(record => record.m4a0 === 'ready', 'PR-A default Host ready', 180_000)
    webScopeSuffix = plainReady.localHost.scopeId.slice(0, 40)
    const plainOrigin = plainReady.localHost.origin
    const declared = hostScratchOverlays().filter(path => !scratchBefore.has(path))
    assert(declared.length === 1, `PA-01 expected ONE overlay written by this Host, found ${declared.length}`)
    const declaredRows = assertDeclaredWebRows(declared[0], 'PA-01')
    assertHostOwnersUnchanged(plainReady, 'PA-01')
    const declaredById = new Map(plainReady.entries.map(entry => [entry.id, entry]))
    const notAbsent = PR_A_WEB_ROWS.map(row => row.id)
      .filter(id => declaredById.get(id)?.state !== 'absent')
    assert(notAbsent.length === 0, `PA-01 these Web rows are not plainly disabled: ${notAbsent.join(',')}`)
    // The ONE loopback listener and the existing authenticated routes stay
    // the only Host network surface.
    const plainRoot = await fetchStatus(`${plainOrigin}/`)
    assert(plainRoot.status === 404, `PA-01 GET / must be 404 without a Web composition, got ${plainRoot.status}`)
    const plainPlugin = await fetchStatus(`${plainOrigin}/plugins/@deepseek-ai/dsh-client-ui-theme/client.js`)
    assert(plainPlugin.status !== 200, `PA-01 the plain Host served an official Browser bundle (HTTP ${plainPlugin.status})`)
    const plainSse = await sseProbe(plainOrigin, '/plugins/events')
    assert(!(plainSse.status === 200 && plainSse.contentType.startsWith('text/event-stream')),
      `PA-01 the plain Host serves a usable Web SSE channel (${plainSse.status} ${plainSse.contentType})`)
    assert(!plainSse.chunk.includes('"graph"'), 'PA-01 the plain Host pushed a browser graph frame')
    const plainApi = await fetchStatus(`${plainOrigin}/api`)
    assert(plainApi.status === 401, `PA-01 the unauthenticated /api route must stay 401, got ${plainApi.status}`)
    const plainConnect = await fetchStatus(`${plainOrigin}/connect`)
    assert(plainConnect.status === 401, `PA-01 the unfunded /connect route must stay 401, got ${plainConnect.status}`)
    // A real TUI Session still works on this plain Host.
    await seatFree(`\0dsh-pi-tui-c-${webScopeSuffix}`, 15_000)
    const plainClient = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    webClients.push(plainClient)
    const plainClientReady = await plainClient.waitFor(record => record.m4a0 === 'ready', 'PR-A default TUI ready', 180_000)
    assert(plainClientReady.surfaceMounted === true && plainClientReady.transport === 'connected',
      'PA-01 the plain Host no longer serves a real TUI Client')
    const plainPrompt = `pr-a plain tui ${randomUUID().slice(0, 8)}`
    plainClient.send(`${plainPrompt}\r`)
    await plainClient.waitForScreen(plainPrompt, 'PA-01 plain TUI prompt painted', 120_000)
    await waitForSurfaceStatus(plainClient, record => record.sessionOpen === true && typeof record.openSessionId === 'string', 'PA-01 plain TUI session')
    await plainClient.waitForScreen('stub answer', 'PA-01 plain TUI answer painted', 120_000)
    plainClient.send('/exit\r')
    const plainExit = await plainClient.waitForExit(60_000)
    assert(plainExit.code === 0 && plainExit.signal === null, `PA-01 plain TUI exit was ${JSON.stringify(plainExit)}`)
    const plainShutdown = await plainHost.shutdown()
    assert(plainShutdown.code === 0, `PA-01 plain Host shutdown exit was ${JSON.stringify(plainShutdown)}`)
    trace('t67-web-default-off', {
      webRowsDeclared: declaredRows.length,
      webRowsDisabled: declaredRows.filter(row => row.disabled === true).length,
      rootStatus: plainRoot.status,
      pluginBundleStatus: plainPlugin.status,
      webSseStatus: plainSse.status,
      apiStatus: plainApi.status,
      connectStatus: plainConnect.status,
      tuiSession: 'painted',
      tuiAnswer: 'painted',
    })

    // ── B. Isolated qualification: the 59 rows enabled by ONE patch ─────
    // The override rows are appended to the SAME single extra patch this
    // lane already uses for its offline Host LLM. The entry accepts exactly
    // ONE extra patch file, so splitting them would silently drop one.
    const webPatch = join(webRoot, 'pr-a-web-enabled.patch.yml')
    // Two ISOLATED-FIXTURE facts ride this private patch and never the
    // product: the official Web UI's first-run preview notice cannot
    // persist its acknowledgement while the whole roster rides a
    // command-line overlay (the config editor refuses an overlay-owned
    // row), so the acknowledgement is written as the row's own config; and
    // the official Workspace Controller needs its deployment Documents
    // override because an isolated HOME has no usable Documents directory.
    const documentsDirectory = join(webRoot, 'documents')
    mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 })
    chmodSync(documentsDirectory, 0o700)
    const llmOperations = readFileSync(surfaceLlm.patchPath, 'utf8').trimEnd()
    const webOverrides = PR_A_WEB_ROWS.map(row => row.id === 'ui-settings-general'
      ? [
        `- id: ${row.id}`,
        '  disabled: false',
        '  config:',
        `    welcomeNoticeVersion: '${PR_A_WELCOME_NOTICE_VERSION}'`,
      ].join('\n')
      : `- id: ${row.id}\n  disabled: false`)
    writeFileSync(webPatch, `${llmOperations}\n${webOverrides.join('\n')}\n- id: workspace-controller\n  config:\n    documentsDirectory: '${documentsDirectory}'\n`, { mode: 0o600 })
    chmodSync(webPatch, 0o600)
    await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
    const webHost = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: webPatch },
    })
    webHosts.push(webHost)
    const webReady = await webHost.waitFor(record => record.m4a0 === 'ready', 'PR-A Web Host ready', 240_000)
    assertSingleWebOwners(webReady, 'PA-04')
    const webEntriesById = new Map(webReady.entries.map(entry => [entry.id, entry]))
    for (const id of [PR_A_WEB_RUNTIME_ID, 'modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller']) {
      assert(webEntriesById.get(id)?.state === 'active', `PA-02 the qualified Host did not activate "${id}"`)
    }
    // `ui-deliverables` may legitimately stay PENDING (state 0) until the
    // Host-side workspaceChanges projection exists. This stage does not add
    // it and does not claim Deliverables support; the fact is recorded.
    const deliverablesState = webEntriesById.get('ui-deliverables')?.state
    const launch = launchOf(webReady)
    const facts = await readHostWebIndex(webReady.localHost.origin, launch, 'PA-02')
    assertWebIndexQualified(facts, 'PA-02', targetDshVersion)
    const graph = facts.graph
    for (const id of [
      '@deepseek-ai/dsh-client-ui-theme',
      '@deepseek-ai/dsh-client-ui-chat',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-session',
    ]) {
      assert(graph.entries.some(entry => entry.id === id), `PA-03 the browser graph is missing the official "${id}" component`)
    }
    // The Web graph reuses the Host authorities this composition already
    // owns: their `dsh.client` faces ride along without a second row.
    assert(graph.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-connection'),
      'PA-03 the graph is missing the existing official Connection client face')
    assert(graph.entries.some(entry => entry.id === '@deepseek-ai/dsh-api-workspace-controller'),
      'PA-03 the graph is missing the WS-1 Workspace Controller client face')
    // Browser resources are fetched from the URLs the SERVED index
    // advertises, never from a path this script invented.
    const pluginStatuses = []
    for (const batch of graph.batches) {
      const response = await fetchStatus(new URL(batch.url, `${webReady.localHost.origin}/`).href)
      pluginStatuses.push({ phase: batch.phase, status: response.status, bytes: response.body.length })
      assert(response.status === 200, `PA-03 the ${batch.phase} startup bundle returned HTTP ${response.status}`)
      assert(response.body.length > 1024, `PA-03 the ${batch.phase} startup bundle is empty`)
    }
    const single = graph.entries.find(entry => entry.url !== undefined)
    assert(single !== undefined, 'PA-03 the graph advertises no package-local client bundle')
    const singleResponse = await fetchStatus(new URL(single.url, `${webReady.localHost.origin}/`).href)
    assert(singleResponse.status === 200 && singleResponse.body.length > 1024,
      `PA-03 a package-local client bundle returned ${singleResponse.status}/${singleResponse.body.length} bytes`)
    const unknownPlugin = await fetchStatus(`${webReady.localHost.origin}/plugins/@deepseek-ai/dsh-client-does-not-exist/client.js`)
    assert(unknownPlugin.status === 404, `PA-03 an unknown plugin id returned HTTP ${unknownPlugin.status}`)
    // The Web SSE channel carries the SAME composed graph generation.
    const webSse = await sseProbe(webReady.localHost.origin, '/plugins/events')
    assert(webSse.status === 200 && webSse.contentType.startsWith('text/event-stream'),
      `PA-03 /plugins/events is not a live event stream (${webSse.status} ${webSse.contentType})`)
    // The FIRST complete SSE frame must describe the SAME generation the
    // served index bootstrapped: one composition, two projections.
    const sseDataFrames = webSse.chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
    assert(sseDataFrames.length > 0, 'PA-03 /plugins/events pushed no data frame')
    const sseFirst = JSON.parse(sseDataFrames[0])
    assert(sseFirst.type === 'graph', `PA-03 the first /plugins/events frame is "${String(sseFirst.type)}", not "graph"`)
    assert(sseFirst.graph?.rev === graph.rev,
      'PA-03 the SSE graph generation differs from the served index graph')
    // The official /connect Cookie chain and the v2 API Peer stay intact.
    const webConnect = await fetchStatus(`${webReady.localHost.origin}/connect`)
    assert(webConnect.status === 401, `PA-04 the unauthenticated /connect must stay 401, got ${webConnect.status}`)
    const peerCookie = await connectCookie(webReady.localHost.origin, launch)
    assert(peerCookie !== '', 'PA-04 the authenticated /connect minted no peer cookie')
    // PA-06: the runtime values stay silent — no printed token URL, no
    // auto-opened browser line and no Web shell variable in this process.
    const hostOutput = `${webHost.records.map(record => JSON.stringify(record)).join('\n')}\n${webHost.stderr}`
    assert(facts.token !== null && !hostOutput.includes(facts.token),
      'PA-06 the qualified Host leaked the launch token into its records/stderr')
    assert(!/dsh web:\s*http/iu.test(hostOutput), 'PA-06 the qualified Host printed an authenticated URL line')
    assert(!hostOutput.includes('DSH_WEB_URL'), 'PA-06 the qualified Host exposed the Web shell variable')
    const activatedWebRows = PR_A_WEB_ROWS.filter(row => webEntriesById.get(row.id)?.state === 'active')
    trace('t68-web-qualified', {
      dshVersion: targetDshVersion,
      rowsActivated: activatedWebRows.length,
      rowsNotActivated: PR_A_WEB_ROWS
        .filter(row => webEntriesById.get(row.id)?.state !== 'active')
        .map(row => `${row.id}:${webEntriesById.get(row.id)?.state ?? 'missing'}`),
      indexStatus: facts.index.status,
      tokenExchange: facts.exchange.status,
      graphRelease: graph.release,
      graphEntries: graph.entries.length,
      // `pluginStatuses` is pushed in `graph.batches` order: report it as is,
      // so two application phases cannot both resolve to the first one.
      graphBatches: pluginStatuses,
      singleBundleBytes: singleResponse.body.length,
      unknownPluginStatus: unknownPlugin.status,
      webSseStatus: webSse.status,
      uiDeliverablesState: deliverablesState,
      agentShellVar: 'DSH_WEB_URL stays unregistered by design (surfaceContext:false); asserted structurally and by the absent stdout/records evidence — no private probe row exists in this lane',
    })

    // ── B1. Real Browser x real TUI on ONE Host and ONE Session ─────────
    // Playwright lives OUTSIDE the checkout and is not a dependency of the
    // candidate; without it this case reports NOT_RUN, never PASS.
    const coordination = join(webRoot, 'browser')
    mkdirSync(coordination, { recursive: true, mode: 0o700 })
    chmodSync(coordination, 0o700)
    const marker = `pr-a browser ${randomUUID().slice(0, 8)}`
    const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
    if (playwrightRoot === undefined || playwrightRoot === '') {
      assert(!requireBrowser,
        'PA-05 the real-Browser case is REQUIRED (SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1 (or a selected Web case)) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the Browser proof')
      trace('t69-web-browser', { status: 'NOT_RUN', reason: 'SPLIT_PROCESS_PLAYWRIGHT_ROOT is not set; this run does NOT exercise the real Browser and does not claim it' })
    } else {
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
      const browserExitBounded = timeoutMs => browserDriverExitBounded(browserExit, timeoutMs, 'PR_A_BROWSER_EXIT_TIMEOUT')
      /**
       * Only facts the DRIVER owns belong here. A TUI paint is not one of
       * them: the driver may exit normally while the renderer paints the
       * same Host message a moment later.
       */
      const whileBrowserRuns = (startWait, label) => whileBrowserDriverRuns(browserExit, startWait, 'PA-05', label)
      try {
        await whileBrowserRuns(
          signal => waitForCondition(
            () => existsSync(join(coordination, 'browser-session.json')),
            'PR-A Browser Session creation', 240_000, signal,
          ),
          'the Browser Session file appeared',
        )
        const browserSession = readJson(join(coordination, 'browser-session.json')).sessionId
        assert(typeof browserSession === 'string' && browserSession !== '', 'PA-05 the Browser created no Host Session')
        const headerBefore = await waitForHostSessionHeader(dshHome, browserSession, 'PA-08 Browser Session header')
        assert(typeof headerBefore.cwd === 'string' && headerBefore.cwd !== '',
          'PA-08 the Web-created Session has no Host-persisted workspace header')
        // The real Split TUI attaches to the SAME Host and SAME Session.
        await seatFree(`\0dsh-pi-tui-c-${webScopeSuffix}`, 15_000)
        const tui = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: browserSession },
        })
        webClients.push(tui)
        const tuiReady = await tui.waitFor(record => record.m4a0 === 'ready', 'PA-05 TUI ready on the Web Host', 180_000)
        assertClientHostFacts(tuiReady.host, webReady.localHost, 'PA-05 TUI vs Web Host')
        assert(tuiReady.transport === 'connected', 'PA-05 the TUI did not connect to the Web Host')
        await waitForSurfaceStatus(tui, record => record.sessionOpen === true && record.openSessionId === browserSession,
          'PA-05 TUI attached to the Browser Session')
        // Release the Browser prompt only now: both Clients observe ONE Turn.
        writeFileSync(join(coordination, 'browser-go'), `${Date.now()}\n`, { mode: 0o600 })
        // The TUI paint is NOT gated on Browser liveness: the Host committed
        // the prompt (asserted from the durable log below), and the renderer
        // may paint it after an otherwise successful Browser exit.
        await tui.waitForScreen(marker, 'PA-05 TUI paints the Browser prompt', 180_000)
        await tui.waitForScreen('stub answer', 'PA-05 TUI paints the Host answer', 180_000)
        await waitBrowserTurn(browserSession, marker, 'PA-05')
        const headerAfter = await waitForHostSessionHeader(dshHome, browserSession, 'PA-08 Browser Session header after TUI attach')
        assert(headerAfter.cwd === headerBefore.cwd,
          'PA-08 the TUI attach rewrote the Web-created Session workspace')
        const browserResult = await browserExitBounded(120_000)
        const browserReport = readJson(join(coordination, 'browser-result.json'))
        assert(browserResult.code === 0,
          `PA-05 the real Chromium driver failed (exit ${JSON.stringify(browserResult.code)}/${String(browserResult.signal)}): ${redactWebQualificationText(browserReport.error ?? 'driver-failure', [facts.token])}`)
        assert(browserReport.indexStatus === 200, `PA-05 the real Browser loaded no authenticated index (${browserReport.indexStatus})`)
        assert(browserReport.sessionId === browserSession, 'PA-05 the Browser reported a different Session')
        assert(browserReport.answerSeen === true, 'PA-05 the Browser never painted the Host answer')
        browserFacts = {
          indexStatus: browserReport.indexStatus,
          sessionId: browserSession,
          tuiAttached: true,
          tuiPainted: [marker, 'stub answer'],
          hostTurn: 'complete',
          consoleErrors: browserReport.consoleErrors.length,
          screenshot: browserReport.screenshot,
        }
        browserCase = 'PASS'
        tui.send('/exit\r')
        const tuiExit = await tui.waitForExit(60_000)
        assert(tuiExit.code === 0 && tuiExit.signal === null, `PA-05 TUI exit was ${JSON.stringify(tuiExit)}`)
      } finally {
        try { process.kill(-browserProcess.pid, 'SIGKILL') } catch { /* already exited */ }
        const cleanupExit = await browserExitBounded(15_000)
        if (browserCase !== 'PASS') {
          // The case never reached its PASS marker: record the HONEST verdict
          // (a driver that died before writing its result is INCOMPLETE, not
          // "not run").
          browserCase = existsSync(join(coordination, 'browser-result.json')) ? 'FAILED' : 'INCOMPLETE'
        }
        if (browserCase !== 'PASS') {
          // Only the FIXED category leaves this process by default; the raw
          // driver text is redacted and bounded, never traced.
          process.stderr.write(`PR_A_BROWSER_DIAGNOSTIC: ${redactWebQualificationText(
            `${browserErr} ${browserOut}`, [facts.token],
          ).trim().split('\n').slice(-3).map(line => line.slice(0, 300)).join(' | ')}\n`)
        }
        trace('t69-web-browser-result', {
          status: browserCase,
          ...(browserFacts ?? {}),
          driverExit: cleanupExit.code,
          driverSignal: cleanupExit.signal,
          diagnosticRetained: browserFacts === undefined ? 'redacted-terminal-only' : 'none',
        })
      }
    }

    // ── B2. Bundle-level client-hmr: graph only, no Host row reload ─────
    const beforeStatus = await hostStatus(webHost)
    const beforeUids = new Map(beforeStatus.entries.map(entry => [entry.id, entry.fiberUid]))
    const webAppAnchor = createRequire(anchor).resolve('@deepseek-ai/dsh-web-app/package.json')
    const themeBundle = createRequire(webAppAnchor).resolve('@deepseek-ai/dsh-client-ui-theme/client')
    const stream = openSseFrames(webReady.localHost.origin, '/plugins/events')
    const stamp = new Date(Date.now() + 3_600_000)
    utimesSync(themeBundle, stamp, stamp)
    await waitForCondition(
      () => stream.frames.some(frame => frame.type === 'rebuilt' && frame.id === '@deepseek-ai/dsh-client-ui-theme'),
      'PR-A client-hmr rebuilt frame', 30_000,
    )
    await waitForCondition(
      () => stream.frames.some(frame => frame.type === 'graph' && frame.rev !== graph.rev),
      'PR-A client-hmr graph revision', 30_000,
    )
    stream.close()
    const afterStatus = await hostStatus(webHost)
    const afterUids = new Map(afterStatus.entries.map(entry => [entry.id, entry.fiberUid]))
    const remounted = [...beforeUids.keys()].filter(id => beforeUids.get(id) !== afterUids.get(id))
    assert(remounted.length === 0, `PA-07 the browser bundle rebuild re-mounted these Host rows: ${remounted.join(',')}`)
    assert(afterStatus.localHost.instanceId === webReady.localHost.instanceId,
      'PA-07 the browser bundle rebuild replaced the Host instance')
    assert(afterStatus.pid === webReady.pid, 'PA-07 the browser bundle rebuild replaced the Host PID')
    const hmrFrame = stream.frames.find(frame => frame.type === 'graph' && frame.rev !== graph.rev)
    trace('t70-web-hmr', {
      touched: '@deepseek-ai/dsh-client-ui-theme',
      rebuiltFrame: true,
      graphRevBefore: graph.rev,
      graphRevAfter: hmrFrame.rev,
      hostRowsRemounted: 0,
      hostInstanceKept: true,
      scope: 'bundle-level module graph; real Browser HMR UI remains a later product qualification',
    })

    // The Web Host's own owner-governed shutdown happens BEFORE the negative
    // controls: both need the ONE Host seat this profile owns.
    const webShutdown = await webHost.shutdown()
    assert(webShutdown.code === 0, `PA-04 the Web Host shutdown exit was ${JSON.stringify(webShutdown)}`)
    assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', webReady.localHost.scopeId, 'instance.json')),
      'PA-04 the Web Host registry survived its owner-governed shutdown')
    trace('t71-web-shutdown', { exit: webShutdown.code, registryRemoved: true })

    // ── B3. Negative controls: base ready is never Web ready ────────────
    // (1) The official frontend dist is absent from the isolated install.
    const distIndex = join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
    const savedDist = saveFile(distIndex)
    const missingDist = `${distIndex}.missing-pr-a`
    try {
      renameSync(distIndex, missingDist)
      await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
      const absentHost = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: webPatch },
      })
      webHosts.push(absentHost)
      const outcome = await waitForOutcome(absentHost, 'PR-A dist-absent Host', 240_000)
      let refusedBy = outcome.m4a0 === 'failure' ? 'host-startup' : undefined
      if (refusedBy === undefined) {
        const absentFacts = await readHostWebIndex(outcome.localHost.origin, launchOf(outcome), 'PA-09')
        try {
          assertWebIndexQualified(absentFacts, 'PA-09', targetDshVersion)
        } catch {
          refusedBy = `http-${absentFacts.index.status}`
        }
      }
      assert(refusedBy !== undefined,
        'PA-09 a Host with NO official frontend dist was reported as Web ready')
      negatives.distAbsent = { refusedBy, hostPhase: outcome.phase ?? outcome.m4a0 }
      try { await absentHost.shutdown() } catch { /* the outcome owns it */ }
    } finally {
      renameSync(missingDist, distIndex)
      assert(existsSync(distIndex) && readFileSync(distIndex).equals(savedDist.bytes),
        'PA-09 the official frontend dist was not restored byte for byte')
    }
    // (2) A second client-modules owner: the singleton must be refused.
    const duplicatePatch = join(webRoot, 'pr-a-duplicate-modules.patch.yml')
    writeFileSync(duplicatePatch, `${readFileSync(webPatch, 'utf8')}\n- insert:\n    - id: modules-duplicate\n      name: '${PR_A_CLIENT_MODULES_PACKAGE}'\n`, { mode: 0o600 })
    chmodSync(duplicatePatch, 0o600)
    await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
    const duplicateHost = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: duplicatePatch },
    })
    webHosts.push(duplicateHost)
    const duplicateOutcome = await waitForOutcome(duplicateHost, 'PR-A duplicate modules Host', 240_000)
    let duplicateRefusedBy = duplicateOutcome.m4a0 === 'failure' ? 'host-startup' : undefined
    if (duplicateRefusedBy === undefined) {
      const moduleRows = duplicateOutcome.entries.filter(entry => entry.name === PR_A_CLIENT_MODULES_PACKAGE)
      try {
        assertSingleWebOwners(duplicateOutcome, 'PA-09')
      } catch {
        duplicateRefusedBy = `singleton-rows(${moduleRows.map(row => `${row.id}:${row.state}`).join('|')})`
      }
    }
    assert(duplicateRefusedBy !== undefined,
      'PA-09 a second client-modules owner was accepted as a qualified Web composition')
    negatives.duplicateModules = { refusedBy: duplicateRefusedBy }
    try { await duplicateHost.shutdown() } catch { /* the outcome owns it */ }
    rmSync(duplicatePatch, { force: true })

    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'PA-09 the candidate artifact changed during the Web qualification')
    trace('t72-web-negative-controls', negatives)
  } finally {
    for (const client of webClients) {
      try { await client.dispose() } catch { /* best effort */ }
    }
    for (const host of webHosts) {
      if (host.exited) continue
      try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
  }
  assert(!requireBrowser || browserCase === 'PASS',
    `PA-05 the required real-Browser qualification ended as ${String(browserCase)}; only PASS qualifies this case`)
  return { status: 'PASS', browser: browserCase }
}
