/**
 * M5-W PR-D / S5-PR5 product Browser-by-real-TUI qualification (T75/WP-01..WP-11).
 *
 * This module owns the complete product composite: the single Group-A Host,
 * the per-case isolated Host scenes, the real Chromium driver runs and
 * the WC-01..12 evidence matrix writer. The Browser driver remains
 * `scripts/fixtures/m5-web-product-browser.mjs`; this module never stubs it.
 *
 * @module split-process/web-product
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { PACKAGE_ROOT } from '../../lib/dsh-distribution.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { writeC1WorkFixture, readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  assertClientHostFacts,
  assertIdentityFields,
  chunk,
  fetchStatus,
  hostStatus,
  lastSurfaceStatus,
  productionBuildId,
  readJson,
  readStartIdentity,
  seatFree,
  waitForCondition,
  waitForSurfaceStatus,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  sha16,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import {
  PR_A_WEB_ROWS,
  PR_A_WELCOME_NOTICE_VERSION,
  browserDriverExitBounded,
  readHostWebIndex,
  assertWebIndexQualified,
  redactWebQualificationText,
  whileBrowserDriverRuns,
} from './web-helpers.mjs'

const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let statusSequence = 0

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function createProductEvidence() {
  const requested = process.env.M5_WEB_PRODUCT_EVIDENCE
  const disabled = requested === undefined || requested === ''
  const state = {
    enabled: !disabled,
    dir: disabled ? undefined : resolve(requested),
    startedAt: new Date().toISOString(),
    playwright: undefined,
    chromium: undefined,
    candidate: undefined,
    candidateSha256: undefined,
    dshVersion: undefined,
    ledger: [],
    wc: {},
    features: undefined,
    ternGui: { status: 'NOT_RUN', reason: 'the real Tern GUI lane did not run in this qualification' },
  }
  if (disabled) {
    return {
      state,
      begin() {},
      setBrowserRuntime() {},
      setTernGui(value) { state.ternGui = value },
      caseStart() {},
      caseEnd() {},
      browserCase() {},
      hostIdentity() {},
      environment() {},
      fact() {},
      sessionEvents() {},
      ptyFrame() {},
      features() {},
      wc() {},
      finish() {},
    }
  }
  const dir = state.dir
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`the product evidence directory must be new/empty: ${dir}`)
  }
  for (const sub of ['matrix', 'browser', 'host', 'client', 'tern-gui']) {
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })
    chmodSync(join(dir, sub), 0o700)
  }
  chmodSync(dir, 0o700)
  const write = (relative, value) => {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  const writeText = (relative, text) => {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, text, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  /** Only the correlation fields the plan permits; never prompt/answer text. */
  const eventLine = event => {
    const data = event.data ?? {}
    const kept = {}
    for (const key of ['id', 'callId', 'toolCallId', 'requestId', 'rpcId', 'turn', 'outcome', 'name', 'reason']) {
      if (data[key] !== undefined) kept[key] = data[key]
    }
    return JSON.stringify({
      type: event.type,
      ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
      ...(typeof event.time === 'number' ? { time: event.time } : {}),
      data: kept,
    })
  }
  const manifest = extra => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    return {
      schema: 1,
      createdAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      repositoryHead: head.status === 0 ? head.stdout.trim() : 'unknown',
      candidate: state.candidate,
      candidateSha256: state.candidateSha256,
      dshVersion: state.dshVersion,
      node: process.version,
      playwright: state.playwright ?? 'NOT_INSTALLED',
      chromium: state.chromium ?? 'NOT_STARTED',
      evidenceTier: 'REAL_PLAYWRIGHT_CHROMIUM + REAL_PTY_TUI + REAL_INSTALLED_CANDIDATE',
      osInputVerified: 'NOT_VERIFIED',
      realTernGui: state.ternGui,
      sourceMode: process.env.DSH_MODE === 'source' ? 'source' : 'npm',
      ...extra,
    }
  }
  return {
    state,
    begin(identity) {
      state.candidate = identity.candidate
      state.candidateSha256 = identity.candidateSha256
      state.dshVersion = identity.dshVersion
      write('manifest.json', manifest({ status: 'RUNNING' }))
    },
    setBrowserRuntime(runtime) {
      state.playwright = runtime.playwright
      state.chromium = runtime.chromium
    },
    setTernGui(value) {
      state.ternGui = value
    },
    caseStart(id) {
      state.ledger.push({ case: id, startedAt: new Date().toISOString(), status: 'RUNNING' })
    },
    caseEnd(id, status, fields = {}) {
      const entry = state.ledger.find(candidate => candidate.case === id && candidate.status === 'RUNNING')
      if (entry === undefined) state.ledger.push({ case: id, startedAt: new Date().toISOString(), ...fields, status })
      else Object.assign(entry, { endedAt: new Date().toISOString(), status, ...fields })
    },
    browserCase(id, coordDir, report, exit) {
      write(join('browser', id, 'browser-result.json'), report)
      for (const shot of report.screenshots ?? []) {
        const source = join(coordDir, shot)
        if (!existsSync(source)) continue
        const target = join('browser', id, shot)
        mkdirSync(dirname(join(dir, target)), { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, target), readFileSync(source), { mode: 0o600 })
        chmodSync(join(dir, target), 0o600)
      }
      state.ledger.push({ case: id, startedAt: new Date().toISOString(), status: 'BROWSER_EXIT', exit })
    },
    environment(id, facts) {
      write(join('host', id, 'environment.json'), facts)
    },
    fact(id, name, value) {
      write(join('host', id, `${name}.json`), value)
    },
    hostIdentity(id, facts) {
      write(join('host', id, 'owner-identity.json'), {
        pid: facts.pid ?? facts.hostPid,
        starttime: facts.hostStarttime,
        profile: facts.profile,
        scopeId: facts.scopeId,
        instanceIdDigest: typeof facts.instanceId === 'string' ? sha16(facts.instanceId) : undefined,
        ownerEntries: facts.ownerEntries,
        webServer: facts.webServer,
      })
    },
    sessionEvents(id, events) {
      writeText(join('host', id, 'events-redacted.jsonl'), events.map(eventLine).join('\n') + (events.length > 0 ? '\n' : ''))
    },
    ptyFrame(id, frames) {
      writeText(join('client', id, 'pty-frames.txt'), frames.join('\n'))
    },
    features(matrix) {
      state.features = matrix
      write('matrix/feature-surface.json', { schema: 1, case: 'WP-10', features: matrix })
    },
    wc(matrix) {
      state.wc = matrix
      write('matrix/wc-01-12.json', { schema: 1, wc: matrix })
    },
    finish(extra = {}) {
      write('run-ledger.json', { schema: 1, startedAt: state.startedAt, endedAt: new Date().toISOString(), cases: state.ledger, ...extra })
      write('manifest.json', manifest(extra))
      writeText('README-qualification.md', [
        '# M5-W PR-D product qualification evidence',
        '',
        `- candidate: \`${String(state.candidate)}\``,
        `- candidate SHA256: \`${String(state.candidateSha256)}\``,
        `- DSH: \`${String(state.dshVersion)}\``,
        `- Playwright: \`${String(state.playwright)}\`, Chromium: \`${String(state.chromium)}\``,
        '- Browser: real Playwright Chromium (headless); TUI: real PTY; Host: the installed candidate\'s Split Host',
        '',
        '## Reproduce',
        '',
        '```sh',
        'pnpm pack:artifact',
        'SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1 SPLIT_PROCESS_REQUIRE_WEB_PRODUCT=1 \\',
        'SPLIT_PROCESS_PLAYWRIGHT_ROOT="$TOOLS" SPLIT_PROCESS_PLAYWRIGHT_BROWSERS="$TOOLS/browsers" \\',
        'M5_WEB_PRODUCT_EVIDENCE="$NEW_EVIDENCE_DIR" SPLIT_PROCESS_SMOKE_KEEP=1 \\',
        'pnpm smoke:split-process -- ./xmoon76-dsh-pi-tui-<version>.tgz',
        '```',
        '',
        '## Known qualifications not claimed here',
        '',
        `- real Tern GUI: ${state.ternGui.status} - ${state.ternGui.reason}`,
        '- OS physical input and an OS accessibility bridge: NOT_VERIFIED (control-injected input only).',
        '- Browser Cookie revocation after `/web Disable`: NOT a product contract and not tested.',
        '- Browser-only ACL/multi-user/remote network exposure: not claimed.',
        '',
      ].join('\n'))
    },
  }
}

/**
 * M5-W PR-D (t75): the PRODUCT Browser × real Split TUI qualification.
 *
 * This function is module-level and context-injected so a development run can
 * exercise ONLY the product cases against an already-installed preserved
 * profile; the shipped smoke calls it with the same context after T74.
 */
export const runWebProductQualification = async context => {
  const { EntryProcess, SurfaceEntryProcess, workDir, dshHome, base, entries, profilePackage, tarball, candidateSha256, targetDshVersion, trace, mode } = context
  const { env } = context.installation
  const productRoot = join(workDir, 'pr-d-product')
  mkdirSync(productRoot, { recursive: true, mode: 0o700 })
  chmodSync(productRoot, 0o700)
  const browserRoot = join(productRoot, 'browser')
  mkdirSync(browserRoot, { recursive: true, mode: 0o700 })
  chmodSync(browserRoot, 0o700)
  const productNonce = `prd-${randomUUID().slice(0, 8)}`
  const evidence = createProductEvidence()
  evidence.begin({
    candidate: basename(tarball),
    candidateSha256,
    dshVersion: targetDshVersion,
  })
  const wc = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const code = `WC-${String(index + 1).padStart(2, '0')}`
    return [code, { status: 'NOT_RUN', reason: 'this qualification did not reach the case', evidence: [] }]
  }))
  const setWc = (code, status, reason, refs = []) => {
    wc[code] = { status, reason, evidence: refs }
    evidence.wc(wc)
  }
  evidence.wc(wc)
  const hosts = []
  const clients = []
  const peers = []
  const cleanup = async () => {
    for (const client of clients) {
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    for (const peer of peers) {
      if (peer.exited) continue
      try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const host of hosts) {
      if (host.exited) continue
      try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
  }
  const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
  const requireProduct = mode === 'selected' || process.env.SPLIT_PROCESS_REQUIRE_WEB_PRODUCT === '1'
  if (!requireProduct) {
    trace('t75-web-product', {
      status: 'NOT_RUN',
      reason: 'SPLIT_PROCESS_REQUIRE_WEB_PRODUCT is not set; this run does NOT exercise the product Browser qualification and does not claim it',
    })
    evidence.setTernGui({ status: 'NOT_RUN', reason: 'the product qualification was not required in this run' })
    evidence.finish({ status: 'NOT_RUN' })
    return { status: 'NOT_RUN', wc }
  }
  assert(playwrightRoot !== undefined && playwrightRoot !== '',
    'PR-D the product Browser qualification is REQUIRED (selected Web case or SPLIT_PROCESS_REQUIRE_WEB_PRODUCT=1) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the product proof')
  assert(existsSync(join(playwrightRoot, 'node_modules', 'playwright', 'package.json')),
    `PR-D SPLIT_PROCESS_PLAYWRIGHT_ROOT has no pinned Playwright install: ${playwrightRoot}`)
  const browsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
  assert(existsSync(browsers), `PR-D the Playwright browser install is missing: ${browsers}`)
  const chromiumLibs = process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
  const driverPath = join(SCRIPT_DIR, 'fixtures', 'm5-web-product-browser.mjs')
  assert(existsSync(driverPath), 'PR-D the product Browser driver is missing')
  const driverEnv = {
    ...env,
    M5_WEB_DSH_HOME: dshHome,
    M5_WEB_PLAYWRIGHT_ROOT: playwrightRoot,
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    LD_LIBRARY_PATH: `${chromiumLibs}${process.env.LD_LIBRARY_PATH === undefined ? '' : `:${process.env.LD_LIBRARY_PATH}`}`,
  }
  // The isolated-fixture facts the official Web UI needs on top of the C1
  // workload: the first-run notice acknowledgement and the Workspace
  // Controller's Documents override. Neither is a product default.
  const documentsDirectory = join(productRoot, 'documents')
  mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 })
  chmodSync(documentsDirectory, 0o700)
  const c1Fixture = writeC1WorkFixture(join(dshHome, 'profiles', base.profile), productRoot)
  const productPatch = join(productRoot, 'pr-d-product.patch.yml')
  writeFileSync(productPatch, [
    readFileSync(c1Fixture.patchPath, 'utf8').trimEnd(),
    '- id: ui-settings-general',
    '  config:',
    `    welcomeNoticeVersion: '${PR_A_WELCOME_NOTICE_VERSION}'`,
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: '${documentsDirectory}'`,
    '',
  ].join('\n'), { mode: 0o600 })
  chmodSync(productPatch, 0o600)
  const timedRows = JSON.parse(readFileSync(c1Fixture.timedPatchPath, 'utf8'))
  timedRows.push(
    { id: 'ui-settings-general', config: { welcomeNoticeVersion: PR_A_WELCOME_NOTICE_VERSION } },
    { id: 'workspace-controller', config: { documentsDirectory } },
  )
  const timedProductPatch = join(productRoot, 'pr-d-product-timed.patch.yml')
  writeFileSync(timedProductPatch, `${JSON.stringify(timedRows, null, 2)}\n`, { mode: 0o600 })
  chmodSync(timedProductPatch, 0o600)

  /** The durable events of one Session (empty before its first write). */
  const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const requestIdOf = event => event.data?.source?.rpcId ?? event.data?.rpcId ?? event.data?.requestId ?? event.data?.id
  const userEvents = (sessionId, text) => durableOf(sessionId)
    .filter(event => event.type === 'user/message' && JSON.stringify(event).includes(text))
  /** Persist the redacted durable correlation events of one case Session. */
  const recordSession = (id, sessionId) => {
    const events = durableOf(sessionId)
    if (events.length > 0) evidence.sessionEvents(id, events)
  }
  const launchOf = ready => readJson(join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'launch.json'))
  const productWorkRoot = label => {
    const root = join(productRoot, `work-${label}`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    return root
  }
  const startHost = async (scenario, label, extraEnv = {}, patch = productPatch) => {
    // The FIRST Host relies on the kernel claim; every later Host uses the
    // scope this case learned from its own first real Ready, never T08's.
    if (webScopeSuffix !== undefined) await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000)
    const workRoot = productWorkRoot(label)
    const host = new EntryProcess('host', entries.host, {
      ...base,
      env: {
        ...base.env,
        SPLIT_PROCESS_EXTRA_PATCH: patch,
        C1_SCENARIO: scenario,
        C1_WORK_ROOT: workRoot,
        ...extraEnv,
      },
    })
    hosts.push(host)
    const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 240_000)
    if (webScopeSuffix === undefined) webScopeSuffix = ready.localHost.scopeId.slice(0, 40)
    evidence.hostIdentity(label, {
      ...ready.localHost,
      pid: ready.pid,
      ownerEntries: ready.ownerEntries,
      webServer: ready.webServer,
      hostStarttime: readStartIdentity(ready.pid),
    })
    return { host, ready, workRoot }
  }
  const startTui = async (label, extraEnv = {}, extraOptions = {}) => {
    const tui = new SurfaceEntryProcess(entries.client, {
      ...base,
      ...extraOptions,
      workDir,
      env: { ...base.env, ...extraEnv },
    })
    clients.push(tui)
    const ready = await tui.waitFor(record => record.m4a0 === 'ready', `${label} TUI ready`, 180_000)
    assert(ready.surfaceMounted === true && ready.transport === 'connected',
      `${label}: the real Split TUI did not mount and connect`)
    return { tui, ready }
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  /** The single official owner graph, asserted on every Product Host edge. */
  const assertSingleHostOwners = (ready, label) => {
    for (const owner of ['connection', 'apiRemotes', 'typertGateway', 'workspaceRegistry', 'workspaceController',
      'sessionController', 'fileUpload', 'settingsController', 'jobController', 'piTuiHostRuntime']) {
      assert(ready.ownerEntries?.[owner]?.length === 1,
        `${label}: the ${owner} owner count is ${JSON.stringify(ready.ownerEntries?.[owner])}, expected exactly one`)
    }
    assert(ready.webServer?.host === '127.0.0.1' && typeof ready.webServer?.port === 'number' && ready.webServer.port > 0,
      `${label}: the ONE loopback listener is not a bound 127.0.0.1 port`)
    assert(ready.services?.piTuiWebAccess === true, `${label}: the private Web access service is missing`)
  }
  /** Move the `/web` menu highlight until the requested action is selected. */
  const selectWebRow = async (tui, description, label) => {
    for (let step = 0; step < 10; step += 1) {
      if ((await tui.viewport()).join('\n').includes(description)) {
        tui.send('\r')
        return
      }
      tui.send('\u001b[B')
      await sleep(120)
    }
    throw new SplitSmokeAssertionError(`${label}: the /web menu never selected "${description}"`)
  }
  const enableWeb = async (tui, label, options = {}) => {
    tui.send('/web\r')
    await tui.waitForScreen('Status:', `${label} /web menu`, 120_000)
    const menu = (await tui.viewport()).join('\n')
    const initial = menu.includes('Status: enabled') ? 'enabled'
      : menu.includes('Status: disabled') ? 'disabled' : 'unknown'
    assert(initial !== 'unknown', `${label}: the /web menu painted no known Web status`)
    if (options.requireDisabled === true) {
      assert(initial === 'disabled', `${label}: the initial Web state was ${initial}, expected disabled`)
    }
    if (initial === 'enabled') {
      tui.send('\u001b')
      await tui.waitForScreenGone('Status:', `${label} menu closed`, 30_000)
      return initial
    }
    await selectWebRow(tui, 'Start serving the official Web frontend', `${label} Enable Web`)
    await tui.waitForScreen('Status: enabled', `${label} enabled projection`, 180_000)
    tui.send('\u001b')
    await tui.waitForScreenGone('Status: enabled', `${label} menu closed`, 30_000)
    return initial
  }
  const disableWeb = async (tui, label) => {
    tui.send('/web\r')
    await tui.waitForScreen('Status: enabled', `${label} /web enabled menu`, 120_000)
    await selectWebRow(tui, 'Stop serving the official Web frontend', `${label} Disable Web`)
    await tui.waitForScreen('Status: disabled', `${label} disabled projection`, 180_000)
    tui.send('\u001b')
    await tui.waitForScreenGone('Status: disabled', `${label} menu closed`, 30_000)
  }
  const tuiNewSession = async (tui, label) => {
    const boundary = tui.records.length
    const before = lastSurfaceStatus(tui)?.openSessionId
    tui.send('/new\r')
    const opened = await tui.waitFor(record => tui.records.indexOf(record) >= boundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && typeof record.openSessionId === 'string'
      && record.openSessionId !== ''
      && record.openSessionId !== before
      && record.transport === 'connected', `${label} /new`, 120_000)
    return opened.openSessionId
  }
  const tuiResume = async (tui, sessionId, label) => {
    const boundary = tui.records.length
    tui.send(`/resume ${sessionId}\r`)
    const opened = await tui.waitFor(record => tui.records.indexOf(record) >= boundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && record.openSessionId === sessionId
      && record.transport === 'connected', `${label} /resume`, 120_000)
    return opened
  }
  /** One real TUI prompt with its durable user/message and turn/end. */
  const tuiTurn = async (tui, sessionId, text, label) => {
    const boundary = durableOf(sessionId).length
    const committed = () => durableOf(sessionId).slice(boundary)
      .some(event => event.type === 'user/message' && JSON.stringify(event).includes(text))
    tui.send(`${text}\r`)
    await tui.waitForScreen(text, `${label} prompt painted`, 120_000)
    // A `/web` overlay close or a just-mounted `/new` session can swallow
    // the FIRST Enter while the draft is already painted. This is a real
    // UI race; the prompt is only submitted again after the Host's durable
    // log PROVES the first submit did not commit and the text is still the
    // live composer draft. It is never a replay of an accepted write.
    for (let attempt = 0; attempt < 2 && !committed(); attempt += 1) {
      // One full settle second: a submit that really reached the Host has
      // cleared the composer and/or become durable long before this. Only
      // a draft that is demonstrably still live is submitted again.
      await sleep(1_000)
      if (committed()) break
      const composer = await tui.composerText()
      if (composer === undefined || !composer.includes(text)) break
      tui.send('\r')
    }
    await waitForHostSessionEventAfter(dshHome, sessionId, boundary,
      event => event.type === 'user/message' && JSON.stringify(event).includes(text), `${label} user/message`, 180_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, boundary,
      event => event.type === 'turn/end', `${label} turn/end`, 180_000)
    return boundary
  }
  /**
   * Submit a trigger prompt whose completion is a Host/Fixture fact rather
   * than a Session turn/end (Question/Approval/held Turn). The same
   * swallow-the-first-Enter race is handled with the SAME rule: re-Enter
   * only after the draft is still live and the authoritative fact is absent.
   */
  const tuiSubmitUntil = async (tui, text, label, committed) => {
    tui.send(`${text}\r`)
    await tui.waitForScreen(text, `${label} painted`, 120_000)
    for (let attempt = 0; attempt < 2 && !(await committed()); attempt += 1) {
      await sleep(1_000)
      if (await committed()) break
      const composer = await tui.composerText()
      if (composer === undefined || !composer.includes(text)) break
      tui.send('\r')
    }
  }
  /** One correlated `qualification-web-access` round trip. */
  const webAccess = async (peer, label, value) => {
    const requestId = `prd-${++statusSequence}`
    peer.send({
      op: 'qualification-web-access',
      requestId,
      ...(value === undefined ? {} : { webAccessEnabled: value }),
    })
    return peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
      `${label} web-access`, 300_000)
  }
  /** One correlated `qualification-workspace-create` round trip. */
  const workspaceCreate = async (peer, label, workspacePath) => {
    const requestId = `prd-ws-${++statusSequence}`
    peer.send({ op: 'qualification-workspace-create', requestId, workspacePath })
    return peer.waitFor(entry => entry.op === 'workspace-create' && entry.requestId === requestId,
      `${label} workspace-create`, 120_000)
  }
  const webPreference = async (peer, label, value) => {
    const requestId = `prd-pref-${++statusSequence}`
    peer.send({
      op: 'qualification-web-autostart',
      requestId,
      ...(value === undefined ? {} : { webAutoStart: value }),
    })
    return peer.waitFor(entry => entry.op === 'web-autostart' && entry.requestId === requestId,
      `${label} web-autostart`, 120_000)
  }
  const assertToggle = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
  }
  const webFullyOff = ready => {
    const live = PR_A_WEB_ROWS
      .map(row => [row.id, (ready.entries ?? []).find(entry => entry.id === row.id)?.state])
      .filter(([, state]) => state !== 'absent' && state !== 'state-4')
    assert(live.length === 0, `the Web rows are not plainly off: ${live.map(([id, state]) => `${id}:${state ?? 'missing'}`).join(',')}`)
  }
  // EVERY declared Web row must be active: S5-PR5 removed the tolerated
  // `ui-deliverables` PENDING state now that the Host mounts `workspace-changes`.
  const webFullyOn = ready => {
    const notActive = PR_A_WEB_ROWS
      .map(row => [row.id, (ready.entries ?? []).find(entry => entry.id === row.id)?.state])
      .filter(([, state]) => state !== 'active')
    assert(notActive.length === 0, `the Web rows are not active: ${notActive.map(([id, state]) => `${id}:${state ?? 'missing'}`).join(',')}`)
  }
  let browserRun = 0
  let webScopeSuffix
  const browserCase = async (caseId, config, body) => {
    const coord = join(browserRoot, `${caseId}-${String(++browserRun)}`)
    mkdirSync(coord, { recursive: true, mode: 0o700 })
    chmodSync(coord, 0o700)
    writeFileSync(join(coord, 'case.json'), `${JSON.stringify({ caseId, nonce: productNonce, ...config }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(join(coord, 'case.json'), 0o600)
    const child = spawn(process.execPath, [driverPath, coord, caseId, productNonce], {
      cwd: workDir,
      env: driverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { out = `${out}${chunk}`.slice(-16_384) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { err = `${err}${chunk}`.slice(-16_384) })
    const exit = new Promise(resolveExit => child.on('close', (code, signal) => resolveExit({ code, signal })))
    const handle = {
      coord,
      signal: name => {
        writeFileSync(join(coord, `signal-${name}`), `${Date.now()}\n`, { mode: 0o600 })
      },
      waitFact: async (name, label, timeoutMs = 240_000) => {
        const factPath = join(coord, `browser-${name}.json`)
        try {
          await whileBrowserDriverRuns(
            exit,
            signal => waitForCondition(() => existsSync(factPath), label, timeoutMs, signal),
            `PR-D ${caseId}`,
            label,
          )
        } catch (error) {
          // A driver may write its final fact and exit in the same tick;
          // the exit race must not discard a fact that ALREADY exists.
          if (!existsSync(factPath)) throw error
        }
        return readJson(factPath)
      },
      readFact: name => readJson(join(coord, `browser-${name}.json`)),
      writeCommand: command => {
        appendFileSync(join(coord, 'commands.jsonl'), `${JSON.stringify(command)}\n`, { mode: 0o600 })
      },
      waitStep: async (seq, label, timeoutMs = 240_000) => {
        const stepPath = join(coord, `browser-step-${seq}.json`)
        try {
          await whileBrowserDriverRuns(
            exit,
            signal => waitForCondition(() => existsSync(stepPath), label, timeoutMs, signal),
            `PR-D ${caseId}`,
            label,
          )
        } catch (error) {
          if (!existsSync(stepPath)) throw error
        }
        return readJson(stepPath)
      },
      readStep: seq => readJson(join(coord, `browser-step-${seq}.json`)),
    }
    evidence.caseStart(caseId)
    let passed = false
    try {
      await body(handle)
      const finished = await browserDriverExitBounded(exit, 300_000, `PR_D_BROWSER_EXIT_TIMEOUT(${caseId})`)
      const report = readJson(join(coord, 'browser-result.json'))
      assert(finished.code === 0,
        `PR-D ${caseId}: the product Browser driver failed (exit ${JSON.stringify(finished.code)}/${String(finished.signal)}): ${redactWebQualificationText(report.error ?? 'driver-failure')}`)
      assert(report.ok === true && report.caseId === caseId && report.nonce === productNonce,
        `PR-D ${caseId}: the product Browser result is not a completed PASS (${String(report.error ?? 'no error')})`)
      // RFL-001: the Driver's observed ids are the start; the AUTHORITATIVE
      // correlations are the durable Host ids of this case's Session. Enrich
      // the retained result BEFORE it leaves the run, so the evidence copy is
      // not a Browser-only claim.
      const sessionForCorrelation = typeof config.sessionId === 'string' && config.sessionId !== ''
        ? config.sessionId
        : report.sessionId
      if (typeof sessionForCorrelation === 'string' && sessionForCorrelation !== '') {
        const durableIds = durableOf(sessionForCorrelation).flatMap(event => [
          event.data?.source?.rpcId,
          event.data?.rpcId,
          event.data?.requestId,
          event.data?.callId,
          event.data?.id,
        ]).filter(value => typeof value === 'string' && value !== '')
        report.requestIds = [...new Set([...(Array.isArray(report.requestIds) ? report.requestIds : []), ...durableIds])]
      }
      writeFileSync(join(coord, 'browser-result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      const reportText = JSON.stringify(report)
      assert(!/[?&]token=/u.test(reportText) && !/127\.0\.0\.1:\d+/u.test(reportText) && !/(?:Cookie|Authorization)\s*:/iu.test(reportText),
        `PR-D ${caseId}: the product Browser result leaked an authenticated-link secret`)
      assert(typeof report.sessionId === 'string' && report.sessionId !== '',
        `PR-D ${caseId}: the product Browser case has no Host Session identity`)
      assert(Array.isArray(report.steps) && report.steps.length > 0,
        `PR-D ${caseId}: the product Browser case recorded no real step`)
      assert(report.steps.every(entry => entry.passed === true),
        `PR-D ${caseId}: a product Browser step did not pass`)
      assert(Array.isArray(report.requestIds) && report.requestIds.length > 0,
        `PR-D ${caseId}: the product Browser case carries no Host request/rpc correlation`)
      evidence.browserCase(caseId, coord, report, finished)
      evidence.setBrowserRuntime({
        playwright: report.runtimeVersion?.playwright,
        chromium: report.runtimeVersion?.chromium,
      })
      evidence.caseEnd(caseId, 'PASS')
      passed = true
      return report
    } catch (error) {
      // A failed case still retains its driver result/screenshots: the plan
      // forbids discarding the evidence of the failure that is being fixed.
      try {
        const failedReport = join(coord, 'browser-result.json')
        if (existsSync(failedReport)) evidence.browserCase(caseId, coord, readJson(failedReport), { code: 'FAILED' })
      } catch { /* the evidence copy must not hide the real failure */ }
      evidence.caseEnd(caseId, 'FAILED')
      if (err.trim() !== '' || out.trim() !== '') {
        process.stderr.write(`PR_D_BROWSER_DIAGNOSTIC(${caseId}): ${redactWebQualificationText(`${err} ${out}`).trim().split('\n').slice(-3).map(line => line.slice(0, 300)).join(' | ')}\n`)
      }
      throw error
    } finally {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
      if (!passed) await browserDriverExitBounded(exit, 15_000, `PR_D_BROWSER_CLEANUP(${caseId})`)
    }
  }
  const ptyFrames = async (id, tui) => {
    const frames = (await tui.viewport()).map(line => line.trimEnd())
    evidence.ptyFrame(id, [`# ${id}`, ...frames])
  }

  try {
    // T74 ends with the profile-owned Auto-start preference ON (its last
    // scene proves the next cold boot auto-starts). WP-01 requires a fresh
    // default-OFF profile, so reset the preference through the OFFICIAL
    // settings wire on its own short-lived Host BEFORE the product Host
    // boots. The reset Host may itself auto-start Web; that is irrelevant.
    const fastBarrier = join(productRoot, 'long-turn.fast')
    writeFileSync(fastBarrier, 'release\n', { mode: 0o600 })
    {
      const resetHost = await startHost('long-turn', 'pref-reset', { C1_HOLD_LONG_TURN: fastBarrier })
      const resetPeer = await startPeer('PR-D preference reset')
      const reset = await webPreference(resetPeer, 'PR-D preference reset', false)
      assert(reset.ok === true && reset.readBack === true,
        `PR-D could not reset the profile Auto-start preference to Off: ${JSON.stringify(reset)}`)
      await resetPeer.shutdown()
      const resetIndex = peers.indexOf(resetPeer)
      if (resetIndex >= 0) peers.splice(resetIndex, 1)
      const resetStop = await resetHost.host.shutdown()
      assert(resetStop.code === 0, 'PR-D the preference-reset Host did not stop normally')
    }

    // ── Group A: WP-01/02/06/08/09/10 on ONE fast-answer Host ───────────
    const groupA = await startHost('long-turn', 'wp01-group', { C1_HOLD_LONG_TURN: fastBarrier })
    assertSingleHostOwners(groupA.ready, 'WP-01 Host')
    const groupAIdentity = groupA.ready.localHost
    const { tui: tuiA } = await startTui('wp01-group')
    let groupTui = tuiA
    await enableWeb(groupTui, 'WP-01', { requireDisabled: true })
    const groupAEnabled = await hostStatus(groupA.host)
    assertSingleHostOwners(groupAEnabled, 'WP-01 enabled Host')
    webFullyOn(groupAEnabled)
    assertIdentityFields(groupAEnabled.localHost, groupAIdentity, 'WP-01 enable kept the Host identity')
    const groupALaunch = launchOf(groupA.ready)
    const groupAIndex = await readHostWebIndex(groupA.ready.localHost.origin, groupALaunch, 'WP-01')
    assertWebIndexQualified(groupAIndex, 'WP-01', targetDshVersion)

    // WP-01: token -> Cookie -> index -> shell -> one real Session action.
    const wp01 = await browserCase('wp01-login', {
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      const browserSession = await handle.waitFact('session', 'WP-01 Browser Session creation', 240_000)
      // The Browser Session lives on the SAME Host the real TUI is connected
      // to; the TUI currently sits on the sessionless welcome seat, where a
      // direct `/resume` is not the product path under test (WP-02B proves
      // the picker/resume flow once the TUI owns a Session). Here the shared
      // authority is the Host identity and the durable Browser Turn.
      assertClientHostFacts(lastSurfaceStatus(groupTui)?.host, groupA.ready.localHost, 'WP-01 TUI vs Browser Host')
      const boundary = durableOf(browserSession.sessionId).length
      await waitForHostSessionEventAfter(dshHome, browserSession.sessionId, boundary,
        event => event.type === 'user/message' && JSON.stringify(event).includes(`wp01-${productNonce}`),
        'WP-01 Browser prompt committed', 180_000)
      await waitForHostSessionEventAfter(dshHome, browserSession.sessionId, boundary,
        event => event.type === 'turn/end', 'WP-01 Browser turn settled', 180_000)
      await handle.signal('runner-go')
    })
    const wp01Session = wp01.sessionId
    assert(userEvents(wp01Session, `wp01-${productNonce}`).length === 1,
      'WP-01 the Browser prompt was not committed to the Host exactly once')
    assert(wp01.indexStatus === 200, `WP-01 the Browser index was HTTP ${String(wp01.indexStatus)}`)
    const wp01Negatives = wp01.negatives ?? {}
    assert(wp01Negatives.index !== 200,
      `WP-01 the unauthenticated index was accepted (HTTP ${String(wp01Negatives.index)})`)
    assert(wp01Negatives.api === 401,
      `WP-01 the unauthenticated /api was not 401 (HTTP ${String(wp01Negatives.api)})`)
    // The unauth wrong-host/origin statuses are recorded but do NOT prove the
    // source policy; the authenticated ones below do.
    assert(wp01Negatives.wrongHost !== 200,
      `WP-01 an unauthenticated wrong Host header was accepted (HTTP ${String(wp01Negatives.wrongHost)})`)
    assert(wp01Negatives.wrongOrigin !== 200,
      `WP-01 an unauthenticated wrong Origin was accepted (HTTP ${String(wp01Negatives.wrongOrigin)})`)
    assert(wp01Negatives.wrongHostAuthenticated === 401,
      `WP-01 an AUTHENTICATED wrong Host was not 401 (HTTP ${String(wp01Negatives.wrongHostAuthenticated)})`)
    assert(wp01Negatives.wrongOriginAuthenticated === 403,
      `WP-01 an AUTHENTICATED wrong Origin was not 403 (HTTP ${String(wp01Negatives.wrongOriginAuthenticated)})`)
    // `/plugins/events` may be an official public graph stream; the plan does
    // not require every non-index resource to be 401. Record it, never use it
    // as an authentication negative.
    trace('t75-web-product-wp01-negatives', wp01Negatives)
    assert((wp01.network?.statuses ?? []).some(entry => entry.path === '/plugins/events' && entry.status === 200),
      'WP-01 the Browser never loaded the official plugin event stream')
    assert((wp01.network?.failedPaths ?? []).every(path => !/\/plugins\/.*\.js|\/api\/.* -> 5\d\d/iu.test(path)),
      `WP-01 the Browser failed a required Web resource: ${JSON.stringify(wp01.network?.failedPaths)}`)
    assertIdentityFields((await hostStatus(groupA.host)).localHost, groupAIdentity, 'WP-01 Host identity kept after the Browser Session')
    await ptyFrames('wp01', groupTui)
    setWc('WC-01', 'PASS', 'one Host owner graph; Browser and TUI share it', ['WP-01'])
    setWc('WC-02', 'PASS', 'real Browser token->Cookie->index, live plugin stream and dynamic resources', ['WP-01'])
    setWc('WC-11', 'PASS', 'the Browser loaded the installed candidate Web resources; the candidate digest is re-proved at the end', ['WP-01'])

    // WP-02A: TUI creates a Session; the Browser finds and opens it.
    const sessionA = await tuiNewSession(groupTui, 'WP-02A')
    const markerA = `T-${productNonce}-a`
    await tuiTurn(groupTui, sessionA, markerA, 'WP-02A')
    await browserCase('wp02a-open-existing', {
      sessionId: sessionA,
      marker: markerA,
      expectedAnswer: 'long-turn answer',
    }, async () => {})
    const sessionAHeader = await waitForHostSessionHeader(dshHome, sessionA, 'WP-02A Session header')
    assert(typeof sessionAHeader.cwd === 'string' && sessionAHeader.cwd !== '', 'WP-02A no durable Host workspace header')
    assert(userEvents(sessionA, markerA).length === 1, 'WP-02A the TUI marker was not committed once')
    recordSession('wp02a-open-existing', sessionA)
    await ptyFrames('wp02a-open-existing', groupTui)
    setWc('WC-03', 'PASS', 'TUI created a Session; the Browser opened the same Session through the official sidebar', ['WP-02A'])

    // WP-02B: the Browser creates a Session; the TUI resumes it.
    const markerB = `B-${productNonce}-b`
    let sessionB
    await browserCase('wp02b-browser-session', { marker: markerB }, async handle => {
      const browserSession = await handle.waitFact('session', 'WP-02B Browser Session creation', 240_000)
      sessionB = browserSession.sessionId
      await tuiResume(groupTui, sessionB, 'WP-02B')
      await groupTui.waitForScreen(markerB, 'WP-02B TUI paints the Browser prompt', 180_000)
      await groupTui.waitForScreen('long-turn answer', 'WP-02B TUI paints the Browser answer', 180_000)
      await handle.signal('runner-go')
    })
    assert(typeof sessionB === 'string' && sessionB !== '', 'WP-02B the Browser created no Host Session')
    assert(userEvents(sessionB, markerB).length === 1, 'WP-02B the Browser prompt was not committed once')
    await waitForHostSessionHeader(dshHome, sessionB, 'WP-02B Session header')
    recordSession('wp02b-browser-session', sessionB)
    await ptyFrames('wp02b-browser-session', groupTui)

    // WP-02C: both Clients write the SAME Session with different markers.
    const markerB2 = `B-${productNonce}-c`
    const markerT2 = `T-${productNonce}-c`
    await browserCase('wp02c-dual-prompts', {
      sessionId: sessionB,
      marker: markerB2,
      tuiMarker: markerT2,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('turn-done', 'WP-02C Browser turn', 240_000)
      await tuiTurn(groupTui, sessionB, markerT2, 'WP-02C')
      const after = durableOf(sessionB)
      const browserRequest = userEvents(sessionB, markerB2).map(requestIdOf).filter(id => typeof id === 'string')
      const tuiRequest = userEvents(sessionB, markerT2).map(requestIdOf).filter(id => typeof id === 'string')
      assert(browserRequest.length === 1 && tuiRequest.length === 1 && browserRequest[0] !== tuiRequest[0],
        'WP-02C the two Clients did not produce two distinct Host request identities')
      assert(after.filter(event => event.type === 'turn/end').length >= 2,
        'WP-02C the same Session did not settle two Turns')
      await handle.signal('tui-done')
    })
    recordSession('wp02c-dual-prompts', sessionB)
    await ptyFrames('wp02c-dual-prompts', groupTui)
    setWc('WC-04', 'PASS', 'two distinct request identities, two user/message writes and two turn ends on ONE Session', ['WP-02C'])

    // WP-02D: the SAME text from both Clients stays two independent Turns.
    const sameText = `S-${productNonce}-same`
    await browserCase('wp02d-same-text', {
      sessionId: sessionB,
      marker: sameText,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('turn-done', 'WP-02D Browser same-text turn', 240_000)
      // The two prompts have the SAME text: before the TUI writes its own,
      // prove the Browser's occurrence and turn are already durable. The TUI
      // boundary then cannot be satisfied by the Browser's late flush, which
      // would otherwise hide a swallowed TUI Enter.
      await waitForHostSessionEvent(dshHome, sessionB,
        event => event.type === 'user/message' && JSON.stringify(event).includes(sameText),
        'WP-02D Browser user/message durable', 120_000)
      await waitForHostSessionEvent(dshHome, sessionB,
        event => event.type === 'turn/end', 'WP-02D Browser turn/end durable', 120_000)
      await tuiTurn(groupTui, sessionB, sameText, 'WP-02D')
      const occurrences = userEvents(sessionB, sameText)
      assert(occurrences.length === 2, `WP-02D the Host committed ${String(occurrences.length)} same-text user messages, expected 2`)
      const ids = occurrences.map(requestIdOf)
      assert(ids.every(id => typeof id === 'string') && ids[0] !== ids[1],
        'WP-02D the same text was deduplicated into one Host request identity')
      await handle.signal('tui-done')
    })
    recordSession('wp02d-same-text', sessionB)
    setWc('WC-04', 'PASS', 'two distinct request identities; the same text from both Clients stays two Turns', ['WP-02C', 'WP-02D'])

    // WP-02E: independent Browser/TUI current Session references.
    const markerA2 = `T-${productNonce}-e`
    await browserCase('wp02e-independent-view', {
      sessionA,
      sessionB,
      markerA: markerA,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('on-b', 'WP-02E Browser on Session B', 240_000)
      await handle.signal('nav-to-a')
      await handle.waitFact('on-a', 'WP-02E Browser on Session A', 240_000)
      // The TUI keeps writing B while the Browser is on A.
      await tuiTurn(groupTui, sessionB, markerA2, 'WP-02E B turn')
      await tuiResume(groupTui, sessionA, 'WP-02E')
      await groupTui.waitForScreen(markerA, 'WP-02E TUI on Session A history', 180_000)
      await handle.signal('runner-done')
    })
    const tuiOnA = lastSurfaceStatus(groupTui)
    assert(tuiOnA?.openSessionId === sessionA && tuiOnA.transport === 'connected',
      'WP-02E the TUI did not keep its own Session A reference')
    assert(userEvents(sessionB, markerA2).length === 1,
      'WP-02E the TUI Turn in B was not committed while the Browser was on A')
    recordSession('wp02e-independent-view-a', sessionA)
    recordSession('wp02e-independent-view-b', sessionB)
    setWc('WC-05', 'PASS', 'Browser and TUI keep independent current Sessions; a Turn in B lands while the Browser shows A', ['WP-02E'])

    // WP-06: TUI /reload-client, normal exit and SIGKILL while the Browser
    // keeps advancing the SAME Session.
    const sessionLife = await tuiNewSession(groupTui, 'WP-06')
    const lifeSeed = `L-${productNonce}-seed`
    await tuiTurn(groupTui, sessionLife, lifeSeed, 'WP-06 seed')
    const lifeBrowser = await browserCase('wp06-tui-lifecycle', { sessionId: sessionLife }, async handle => {
      await handle.waitFact('ready', 'WP-06 Browser ready', 240_000)
      const commands = [
        { kind: 'prompt', prompt: `L-${productNonce}-after-reload`, marker: `L-${productNonce}-after-reload` },
        { kind: 'prompt', prompt: `L-${productNonce}-tui-exited`, marker: `L-${productNonce}-tui-exited` },
        { kind: 'prompt', prompt: `L-${productNonce}-new-tui`, marker: `L-${productNonce}-new-tui` },
        { kind: 'prompt', prompt: `L-${productNonce}-after-sigkill`, marker: `L-${productNonce}-after-sigkill` },
        { kind: 'finish' },
      ]
      // 1. A REAL /reload-client command; the Host PID must not move and the
      //    reexecuted Client must restore Session S. The manual command
      //    truthfully refuses `already-current` when the profile install IS
      //    the running build, so the installed Client payload is given the
      //    T17 harmless-comment drift first and restored byte-for-byte after
      //    the replacement is live. This is a REAL profile reexec, not a
      //    SIGUSR2 qualification shortcut.
      const installedClientChunk = chunk(profilePackage, 'client-bootstrap-')
      const installedClientBytes = readFileSync(installedClientChunk)
      let reloadAccepted = false
      try {
        appendFileSync(installedClientChunk, '\n// PR-D /reload-client build drift: protocol unchanged\n')
        const driftBuildId = productionBuildId(profilePackage, groupAIdentity.dshVersion)
        assert(driftBuildId !== groupAIdentity.buildId,
          'WP-06 the harmless installed-payload drift did not change the Client build fingerprint')
        const reloadBoundary = groupTui.records.length
        const oldClientPid = groupTui.records.filter(record => record.m4a0 === 'ready').at(-1)?.pid
        groupTui.send('/reload-client\r')
        const reloaded = await groupTui.waitFor(record => groupTui.records.indexOf(record) >= reloadBoundary
          && record.m4a0 === 'ready' && record.pid !== oldClientPid, 'WP-06 Client reexec', 180_000)
        assert(Number.isInteger(reloaded.pid) && reloaded.pid !== oldClientPid,
          'WP-06 /reload-client did not replace the Client business PID')
        await waitForSurfaceStatus(groupTui, record => record.sessionOpen === true
          && record.openSessionId === sessionLife && record.transport === 'connected', 'WP-06 reloaded Client resumed its Session', 120_000)
        reloadAccepted = true
      } finally {
        writeFileSync(installedClientChunk, installedClientBytes)
        assert(readFileSync(installedClientChunk).equals(installedClientBytes),
          'WP-06 the installed Client payload was not restored byte for byte')
      }
      assert(reloadAccepted, 'WP-06 the real /reload-client gesture was not accepted')
      const reloadTurn = durableOf(sessionLife).length
      handle.writeCommand({ seq: 1, ...commands[0] })
      await handle.waitStep(1, 'WP-06 Browser after /reload-client')
      await waitForHostSessionEventAfter(dshHome, sessionLife, reloadTurn,
        event => event.type === 'turn/end', 'WP-06 turn after reload', 180_000)
      assert(alive(groupA.ready.pid), 'WP-06 the /reload-client stopped the Host')
      assertIdentityFields((await hostStatus(groupA.host)).localHost, groupAIdentity, 'WP-06 Host identity after /reload-client')
      // 2. Normal TUI exit; the Browser still writes the SAME Session.
      groupTui.send('/exit\r')
      assert((await groupTui.waitForExit(60_000)).code === 0, 'WP-06 the TUI did not exit normally')
      await groupTui.dispose()
      handle.writeCommand({ seq: 2, ...commands[1] })
      await handle.waitStep(2, 'WP-06 Browser after the TUI exit')
      assert(alive(groupA.ready.pid), 'WP-06 the TUI exit stopped the Host')
      // 3. A NEW TUI attaches, then a SIGKILL of its business PID.
      const { tui: tuiB } = await startTui('WP-06 new TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
      await tuiB.waitForScreen(lifeSeed, 'WP-06 new TUI reads the durable history', 180_000)
      handle.writeCommand({ seq: 3, ...commands[2] })
      await handle.waitStep(3, 'WP-06 Browser while the new TUI is alive')
      const tuiBPid = tuiB.records.find(record => record.m4a0 === 'ready')?.pid
      assert(Number.isInteger(tuiBPid) && alive(tuiBPid), 'WP-06 the new TUI published no business PID')
      tuiB.signalBusiness('SIGKILL')
      await waitGone(tuiBPid, 15_000)
      await tuiB.dispose()
      handle.writeCommand({ seq: 4, ...commands[3] })
      await handle.waitStep(4, 'WP-06 Browser after the TUI SIGKILL')
      assert(alive(groupA.ready.pid), 'WP-06 the TUI SIGKILL stopped the Host')
      // 4. A fresh TUI reads the whole segment and keeps its own generation.
      const { tui: tuiC } = await startTui('WP-06 fresh TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
      for (const marker of [lifeSeed, `L-${productNonce}-after-reload`, `L-${productNonce}-tui-exited`,
        `L-${productNonce}-new-tui`, `L-${productNonce}-after-sigkill`]) {
        await tuiC.waitForScreen(marker, `WP-06 fresh TUI reads ${marker}`, 180_000)
      }
      const generation = lastSurfaceStatus(tuiC)?.generationId
      assert(typeof generation === 'number', 'WP-06 the fresh TUI published no transport generation')
      handle.writeCommand({ seq: 5, ...commands[4] })
      await handle.waitStep(5, 'WP-06 Browser finish')
      groupTui = tuiC
    })
    assert(userEvents(sessionLife, `L-${productNonce}-after-sigkill`).length === 1,
      'WP-06 the Browser Turn after the TUI SIGKILL was not committed once')
    recordSession('wp06-tui-lifecycle', sessionLife)
    await ptyFrames('wp06-tui-lifecycle', groupTui)
    setWc('WC-08', 'PASS', 'real /reload-client, normal TUI exit and TUI SIGKILL left the Host and the Browser-written Session advancing', ['WP-06'])

    // WP-08: `/web` runtime toggle and a settings recomposition with a live
    // Browser and a live TUI.
    const sessionToggle = await tuiNewSession(groupTui, 'WP-08')
    await tuiTurn(groupTui, sessionToggle, `W-${productNonce}-seed`, 'WP-08 seed')
    const togglePeer = await startPeer('WP-08')
    assertToggle(await webAccess(togglePeer, 'WP-08 initial', undefined), 'enabled', 'WP-08 initial')
    const toggleIdentity = (await hostStatus(groupA.host)).localHost
    await browserCase('wp08-web-toggle', { sessionId: sessionToggle }, async handle => {
      await handle.waitFact('ready', 'WP-08 Browser ready', 240_000)
      handle.writeCommand({ seq: 1, kind: 'prompt', prompt: `W-${productNonce}-before-off`, marker: `W-${productNonce}-before-off` })
      await handle.waitStep(1, 'WP-08 Browser before the disable')
      await disableWeb(groupTui, 'WP-08')
      const off = await hostStatus(groupA.host)
      webFullyOff(off)
      assertIdentityFields(off.localHost, toggleIdentity, 'WP-08 disable kept the Host identity')
      const root = await fetchStatus(`${groupA.ready.localHost.origin}/`)
      assert(root.status === 404, `WP-08 the disabled Host still serves the Web root (HTTP ${root.status})`)
      // The TUI keeps working on the SAME Host while Web is off.
      await tuiTurn(groupTui, sessionToggle, `W-${productNonce}-tui-while-off`, 'WP-08 TUI while off')
      // The old page is deliberately NOT guaranteed to stay usable: the
      // product contract stops serving the page and unloads the Web rows;
      // the re-enable is proved by a NEW authenticated page below.
      await enableWeb(groupTui, 'WP-08 re-enable')
      assertToggle(await webAccess(togglePeer, 'WP-08 after re-enable', undefined), 'enabled', 'WP-08 after re-enable')
      handle.writeCommand({ seq: 3, kind: 'reconnect', sessionId: sessionToggle })
      await handle.waitStep(3, 'WP-08 Browser reconnected')
      handle.writeCommand({ seq: 4, kind: 'prompt', prompt: `W-${productNonce}-after-on`, marker: `W-${productNonce}-after-on` })
      await handle.waitStep(4, 'WP-08 Browser after the re-enable')
      // A settings recomposition may briefly unload the Web rows; the
      // FINAL state must still be enabled and the Host PID unchanged.
      const saved = await webPreference(togglePeer, 'WP-08 recompose save', false)
      assert(saved.ok === true && saved.readBack === true, 'WP-08 the settings write did not read back')
      const finalDeadline = Date.now() + 90_000
      let finalState = 'unknown'
      while (Date.now() < finalDeadline) {
        const record = await webAccess(togglePeer, 'WP-08 final state', undefined)
        finalState = record.status?.state
        if (finalState === 'enabled') break
        await sleep(250)
      }
      assert(finalState === 'enabled', `WP-08 the final Web state after recomposition was ${finalState}`)
      assertIdentityFields((await hostStatus(groupA.host)).localHost, toggleIdentity, 'WP-08 recomposition kept the Host identity')
      handle.writeCommand({ seq: 5, kind: 'reconnect', sessionId: sessionToggle })
      await handle.waitStep(5, 'WP-08 Browser reconnected after the recomposition')
      handle.writeCommand({ seq: 6, kind: 'prompt', prompt: `W-${productNonce}-after-recompose`, marker: `W-${productNonce}-after-recompose` })
      await handle.waitStep(6, 'WP-08 Browser after the recomposition')
      handle.writeCommand({ seq: 7, kind: 'finish' })
      await handle.waitStep(7, 'WP-08 Browser finish')
    })
    for (const marker of [`W-${productNonce}-before-off`, `W-${productNonce}-tui-while-off`,
      `W-${productNonce}-after-on`, `W-${productNonce}-after-recompose`]) {
      assert(userEvents(sessionToggle, marker).length === 1, `WP-08 the Host committed "${marker}" once`)
    }
    recordSession('wp08-web-toggle', sessionToggle)
    await ptyFrames('wp08-web-toggle', groupTui)
    setWc('WC-09', 'PASS', 'the real TUI `/web Disable` unloaded the Web rows and stopped serving while the Host/TUI kept working; Enable and a settings recomposition restored the final enabled state', ['WP-08'])
    assert(await togglePeer.shutdown() !== undefined, 'WP-08 the qualification Peer did not stop')
    const peerIndex = peers.indexOf(togglePeer)
    if (peerIndex >= 0) peers.splice(peerIndex, 1)

    // WP-09: Browser-local upload, TUI Client-local intake/export and the
    // distinct Host/TUI/Browser environments.
    const tuiCwd = join(productRoot, 'client-local-tui')
    const tuiHome = join(productRoot, 'client-local-tui-home')
    mkdirSync(tuiCwd, { recursive: true, mode: 0o700 })
    mkdirSync(tuiHome, { recursive: true, mode: 0o700 })
    chmodSync(tuiCwd, 0o700)
    chmodSync(tuiHome, 0o700)
    mkdirSync(join(productRoot, 'client-local-scratch'), { recursive: true, mode: 0o700 })
    writeFileSync(join(tuiCwd, 'tui-private-sentinel.txt'), `prd-tui-private-${productNonce}\n`, { mode: 0o600 })
    // The Remote prompt serializer has NO generic-file upload-receipt seam
    // (`prompt-serializer-remote.ts` returns `unsupported` for a generic
    // file), so the TUI Client-local intake is qualified with an IMAGE: the
    // bytes are read by the Client, encoded into the prompt and stored by the
    // Host attachment owner. The generic-file `/attach` boundary is recorded
    // as UNAVAILABLE, never claimed as PASS.
    const tuiImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
    const tuiImagePath = join(tuiCwd, 'tui-local-image.png')
    writeFileSync(tuiImagePath, tuiImageBytes, { mode: 0o600 })
    const tuiPath = join(tuiCwd, 'bin')
    mkdirSync(tuiPath, { recursive: true, mode: 0o700 })
    const tuiPathValue = `${tuiPath}:${base.env.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`
    // The REAL TUI process gets its OWN cwd, HOME and PATH; the Host keeps
    // base.cwd/base home/PATH. The locality assertions must compare the real
    // process facts, not two directories that were only created.
    const { tui: tuiLocal } = await startTui('WP-09 Client-local TUI', {
      HOME: tuiHome,
      PATH: tuiPathValue,
      SPLIT_PROCESS_CLIENT_SESSION: sessionToggle,
      SPLIT_PROCESS_SCRATCH: join(productRoot, 'client-local-scratch'),
    }, { cwd: tuiCwd })
    await tuiLocal.waitForScreen(`W-${productNonce}-seed`, 'WP-09 Client-local TUI reads the Session', 180_000)
    const browserUploadMarker = `w-${productNonce}-browser-upload`
    let hostShellFact
    let hostShellFeature
    await browserCase('wp09-locality', {
      sessionId: sessionToggle,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('upload', 'WP-09 Browser upload', 240_000)
      hostShellFact = await handle.waitFact('host-shell', 'WP-09 Host terminal command', 240_000)
    })
    await tuiLocal.waitForScreen('browser-local-sentinel.txt', 'WP-09 TUI sees the Browser attachment', 180_000)
    // The TUI Client-local intake reads the image in the TUI process; the
    // bytes are encoded into the prompt and the Host attachment owner stores
    // them. The placeholder is a Client draft, never a Host path.
    tuiLocal.send(`/image ${tuiImagePath}\r`)
    await tuiLocal.waitForScreen('[image #', 'WP-09 TUI Client-local image staged', 60_000)
    await tuiTurn(tuiLocal, sessionToggle, `w-${productNonce}-tui-image`, 'WP-09 TUI image turn')
    assert(durableOf(sessionToggle).some(event => event.type === 'user/message'
      && JSON.stringify(event).includes('"type":"image"')),
    'WP-09 the TUI Client-local image never reached the Host user message')
    // A real Client-local export: `/copy` writes the last assistant message
    // through the client clipboard policy (the OSC 52 leg is observable on
    // the PTY and never reaches the Host).
    const rawBeforeCopy = tuiLocal.raw.length
    tuiLocal.send('/copy\r')
    await waitForCondition(() => tuiLocal.raw.slice(rawBeforeCopy).includes('\u001b]52;'),
      'WP-09 Client-local clipboard export', 30_000)
    // The Host storage holds the OFFICIAL uploads of both Clients' sentinel
    // bytes, but never the TUI-private file that was never attached.
    const storageMatches = async needle => {
      const roots = [join(dshHome, 'attachments'), join(dshHome, 'storages'), join(dshHome, 'files')]
        .filter(root => existsSync(root))
      for (const root of roots) {
        const stack = [root]
        while (stack.length > 0) {
          const current = stack.pop()
          const stats = statSync(current)
          if (stats.isDirectory()) {
            for (const name of readdirSync(current)) stack.push(join(current, name))
            continue
          }
          if (stats.size > 8 * 1024 * 1024) continue
          try {
            if (readFileSync(current).includes(needle)) return current
          } catch { /* unreadable transient file */ }
        }
      }
      return undefined
    }
    const storageMatchesBytes = async needle => {
      const roots = [join(dshHome, 'attachments'), join(dshHome, 'storages'), join(dshHome, 'files')]
        .filter(root => existsSync(root))
      for (const root of roots) {
        const stack = [root]
        while (stack.length > 0) {
          const current = stack.pop()
          const stats = statSync(current)
          if (stats.isDirectory()) {
            for (const name of readdirSync(current)) stack.push(join(current, name))
            continue
          }
          if (stats.size > 8 * 1024 * 1024) continue
          try {
            if (readFileSync(current).includes(needle)) return current
          } catch { /* unreadable transient file */ }
        }
      }
      return undefined
    }
    const browserUpload = await storageMatches(`prd-browser-local-${productNonce}`)
    assert(typeof browserUpload === 'string', 'WP-09 the Browser-local uploaded bytes never reached Host storage')
    const tuiUpload = await storageMatchesBytes(tuiImageBytes)
    assert(typeof tuiUpload === 'string', 'WP-09 the TUI Client-local image bytes never reached Host storage')
    const privateLeak = await storageMatches(`prd-tui-private-${productNonce}`)
    assert(privateLeak === undefined, `WP-09 the Host read a TUI-private file that was never attached: ${String(privateLeak)}`)
    const localityHeader = await waitForHostSessionHeader(dshHome, sessionToggle, 'WP-09 Session header')
    // Read the REAL process facts from /proc: the TUI's own cwd/HOME/PATH and
    // the Host's own cwd/HOME/PATH. Creating tuiCwd/tuiHome is not isolation.
    const tuiPid = tuiLocal.records.filter(record => record.m4a0 === 'ready').at(-1)?.pid
    assert(Number.isInteger(tuiPid) && tuiPid > 0, 'WP-09 the TUI published no business PID')
    const procCwd = pid => realpathSync(readlinkSync(`/proc/${String(pid)}/cwd`))
    const procEnv = pid => Object.fromEntries(readFileSync(`/proc/${String(pid)}/environ`).toString('utf8')
      .split('\0').filter(Boolean).map(entry => {
        const equals = entry.indexOf('=')
        return [entry.slice(0, equals), entry.slice(equals + 1)]
      }))
    const tuiCwdActual = procCwd(tuiPid)
    const hostCwdActual = procCwd(groupA.ready.pid)
    const tuiEnvActual = procEnv(tuiPid)
    const hostEnvActual = procEnv(groupA.ready.pid)
    assert(tuiCwdActual === realpathSync(tuiCwd),
      `WP-09 the TUI process cwd is ${tuiCwdActual}, not the isolated tuiCwd`)
    assert(hostCwdActual !== tuiCwdActual,
      `WP-09 the Host and TUI share the same cwd (${hostCwdActual})`)
    assert(tuiEnvActual.HOME === tuiHome, `WP-09 the TUI HOME is ${String(tuiEnvActual.HOME)}, not tuiHome`)
    assert(hostEnvActual.HOME !== tuiEnvActual.HOME,
      `WP-09 the Host and TUI share HOME (${String(hostEnvActual.HOME)})`)
    assert(tuiEnvActual.PATH === tuiPathValue, 'WP-09 the TUI PATH is not the isolated path')
    assert(hostEnvActual.PATH !== tuiEnvActual.PATH,
      'WP-09 the Host and TUI share PATH')
    assert(localityHeader.cwd === hostCwdActual,
      `WP-09 the Session workspace ${localityHeader.cwd} is not the Host cwd ${hostCwdActual}`)
    evidence.environment('wp09-locality', {
      host: { cwd: hostCwdActual, home: hostEnvActual.HOME, path: hostEnvActual.PATH },
      tui: { cwd: tuiCwdActual, home: tuiEnvActual.HOME, path: tuiEnvActual.PATH },
      sessionWorkspace: localityHeader.cwd,
    })
    assert(typeof localityHeader.cwd === 'string' && !localityHeader.cwd.startsWith(tuiCwd),
      `WP-09 the Session workspace is the TUI client cwd (${String(localityHeader.cwd)}) instead of a Host workspace`)
    assert(!existsSync(join(tuiCwd, 'browser-local-sentinel.txt')),
      'WP-09 the Browser-local file was written into the TUI Client cwd')
    // Host-owned workspace shell/path: the real Web terminal (right sidebar →
    // New tab → New terminal) runs a Host PTY in the Session workspace. Its
    // commands must create Host-side files, never files in the TUI Client cwd.
    assert(hostShellFact !== undefined && typeof hostShellFact.marker === 'string',
      'WP-09 the Host terminal command produced no marker fact')
    const hostShellMarkerPath = join(localityHeader.cwd, 'host-shell-marker.txt')
    const hostShellPwdPath = join(localityHeader.cwd, 'host-shell-pwd.txt')
    assert(existsSync(hostShellMarkerPath),
      `WP-09 the Host terminal marker is absent from the Host Session workspace (${hostShellMarkerPath})`)
    assert(readFileSync(hostShellMarkerPath, 'utf8').trim() === hostShellFact.marker,
      'WP-09 the Host terminal marker content is not the command marker')
    assert(existsSync(hostShellPwdPath), `WP-09 the Host terminal pwd file is absent (${hostShellPwdPath})`)
    const hostShellPwd = readFileSync(hostShellPwdPath, 'utf8').trim()
    assert(hostShellPwd === localityHeader.cwd || realpathSync(hostShellPwd) === realpathSync(localityHeader.cwd),
      `WP-09 the Host terminal ran in ${hostShellPwd}, not the Host Session workspace ${localityHeader.cwd}`)
    assert(!existsSync(join(tuiCwd, 'host-shell-marker.txt')),
      'WP-09 the Host terminal marker landed in the TUI Client cwd')
    hostShellFeature = {
      feature: 'web terminal/PTY',
      entryVisible: true,
      actualAction: 'opened the official Web terminal (right sidebar → New tab → New terminal) and ran pwd/printf in the Host PTY',
      hostApi: 'official Web terminal/PTY, Host-owned Session workspace',
      durableOrUiResult: `Host files created at ${hostShellPwd}: host-shell-marker.txt and host-shell-pwd.txt`,
      status: 'SUPPORTED_PASS',
      reason: '',
      evidence: ['WP-09-host-shell', hostShellPwd],
      supportText: 'The official Web terminal runs in the Session workspace on the Host; commands create files on the Host, not in the TUI client cwd.',
    }
    recordSession('wp09-locality', sessionToggle)
    await ptyFrames('wp09-locality', tuiLocal)
    setWc('WC-10', 'PASS', 'Browser-local upload, TUI Client-local image intake and a real Host-owned Web terminal command were proven: Host-side files were created in the Session workspace and not in the TUI cwd; a TUI-private file never reached the Host. TUI generic-file /attach is UNAVAILABLE in the Remote composition (no upload-receipt seam) and is recorded, not claimed', ['WP-04A', 'WP-09'])

    // WP-10: the honest visible-feature inventory.
    const inventory = await browserCase('wp10-inventory', {}, async () => {})
    const featureMatrix = (inventory.features ?? []).filter(feature => feature.feature !== 'web terminal/PTY')
    if (hostShellFeature !== undefined) featureMatrix.push(hostShellFeature)
    evidence.features(featureMatrix)
    recordSession('wp10-inventory', inventory.sessionId)
    await ptyFrames('wp10-inventory', groupTui)
    assert((inventory.features ?? []).some(feature => feature.feature === 'session.create/list/open' && feature.status === 'SUPPORTED_PASS'),
      'WP-10 the core Session create/list/open surface did not PASS')
    assert((inventory.features ?? []).some(feature => feature.feature === 'conversation live Turn/history' && feature.status === 'SUPPORTED_PASS'),
      'WP-10 the core live Turn surface did not PASS')
    for (const feature of ['Questions', 'Approvals']) {
      assert((inventory.features ?? []).some(entry => entry.feature === feature && entry.status === 'SUPPORTED_PASS'),
        `WP-10 the core ${feature} surface did not PASS`)
    }
    setWc('WC-12', 'DEFERRED_WITH_OWNER', 'the Web feature inventory is recorded (core Session/Turn/Question/Approval PASS; optional panels are honestly NOT_VERIFIED). The REAL Tern GUI half is deferred by explicit OWNER decision on 2026-11-05: the TSP `/web` picker is only reachable from the Direct renderer selection while the serving `piTuiWebAccess` Host service is only composed by the Split Host-only overlay. Responsible: M5-W owner. Re-entry: when a composition change lets the TSP/Tern GUI reach the serving Host WebAccessPort. This is NOT a GUI PASS and NOT stage closure.', ['WP-10'])

    // The evidence PTY frame of the last group-A TUI state.
    const tuiAAfter = await hostStatus(groupA.host)
    assertSingleHostOwners(tuiAAfter, 'PR-D group A final')
    assertIdentityFields(tuiAAfter.localHost, groupAIdentity, 'PR-D group A Host identity')
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'PR-D the candidate artifact changed during the product qualification')
    trace('t75-web-product-group-a', {
      hostPid: groupA.ready.pid,
      sessions: { wp01: wp01Session, tui: sessionA, browser: sessionB, toggled: sessionToggle },
      hostOwners: tuiAAfter.ownerEntries,
      browserSessions: wp01.browserClientActions?.length ?? 0,
    })
    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!groupA.host.exited) {
      try { await groupA.host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }

    // ── Group B: WP-03 Questions ────────────────────────────────────────
    const questionGroup = await startHost('question', 'wp03')
    assertSingleHostOwners(questionGroup.ready, 'WP-03 Host')
    const { tui: tuiQ } = await startTui('wp03')
    await enableWeb(tuiQ, 'WP-03')
    const questionWork = questionGroup.workRoot

    const startQuestionSession = async (label, trigger) => {
      const sessionId = await tuiNewSession(tuiQ, `${label} new Session`)
      const boundary = durableOf(sessionId).length
      await tuiSubmitUntil(tuiQ, trigger, label, () => readC1WorkEvents(questionWork)
        .some(event => event.kind === 'question-request' && event.sessionId === sessionId))
      await tuiQ.waitForScreen('[1] Proceed', `${label} question modal`, 180_000)
      await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-request' && event.sessionId === sessionId, `${label} Host question request`, 120_000)
      return { sessionId, boundary }
    }

    // WP-03A: the Browser answers the Question.
    const qa = await startQuestionSession('WP-03A', `wp03a-${productNonce}`)
    await browserCase('wp03a-question-browser-first', { sessionId: qa.sessionId }, async handle => {
      await handle.waitFact('question-visible', 'WP-03A Browser question', 240_000)
      await handle.waitFact('answered', 'WP-03A Browser answer', 240_000)
      const settled = await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-settled' && event.sessionId === qa.sessionId, 'WP-03A Host question settled', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `WP-03A the Host received ${JSON.stringify(settled.answers)} instead of Proceed`)
      await tuiQ.waitForScreen('question answered', 'WP-03A TUI converged', 180_000)
      await tuiQ.waitForScreenGone('[1] Proceed', 'WP-03A TUI pending withdrew', 120_000)
      const late = durableOf(qa.sessionId).length
      tuiQ.send('2')
      await sleep(300)
      tuiQ.send('\x15')
      await sleep(300)
      assert(durableOf(qa.sessionId).slice(late).every(event => event.type !== 'tool/call'
        && event.type !== 'tool/result' && event.type !== 'turn/end'),
      'WP-03A a late TUI option key produced Host activity')
      await handle.signal('runner-go')
    })
    const qaSettlements = readC1WorkEvents(questionWork)
      .filter(event => event.kind === 'question-settled' && event.sessionId === qa.sessionId)
    assert(qaSettlements.length === 1, `WP-03A the Host settled the question ${String(qaSettlements.length)} times`)
    recordSession('wp03a-question-browser-first', qa.sessionId)
    await ptyFrames('wp03a-question-browser-first', tuiQ)
    setWc('WC-06', 'PASS', 'Browser-first Question settled the Host once and the TUI converged', ['WP-03A'])

    // WP-03B: the TUI answers; the Browser's old location is inert.
    const qb = await startQuestionSession('WP-03B', `wp03b-${productNonce}`)
    await browserCase('wp03b-question-tui-first', { sessionId: qb.sessionId }, async handle => {
      await handle.waitFact('question-visible', 'WP-03B Browser question', 240_000)
      tuiQ.send('1')
      await tuiQ.waitForScreen('Review your answer before submit', 'WP-03B TUI review', 30_000)
      tuiQ.send('\r')
      await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-settled' && event.sessionId === qb.sessionId, 'WP-03B Host settled', 120_000)
      await tuiQ.waitForScreen('question answered', 'WP-03B TUI answer landed', 180_000)
      await handle.signal('tui-answered')
      await handle.waitFact('settled', 'WP-03B Browser converged', 180_000)
    })
    assert(readC1WorkEvents(questionWork)
      .filter(event => event.kind === 'question-settled' && event.sessionId === qb.sessionId).length === 1,
    'WP-03B the Host settled the TUI-first question more than once')
    recordSession('wp03b-question-tui-first', qb.sessionId)
    await ptyFrames('wp03b-question-tui-first', tuiQ)
    setWc('WC-06', 'PASS', 'Browser-first and TUI-first Questions both settled the Host once; the loser stayed inert', ['WP-03A', 'WP-03B'])

    // WP-03C: Browser detach while pending, TUI settles, stale Browser inert.
    const qc = await startQuestionSession('WP-03C', `wp03c-${productNonce}`)
    await browserCase('wp03c-question-detach', { sessionId: qc.sessionId }, async handle => {
      await handle.waitFact('question-visible', 'WP-03C Browser question', 240_000)
      await handle.waitFact('detached', 'WP-03C Browser detached', 120_000)
      tuiQ.send('1')
      await tuiQ.waitForScreen('Review your answer before submit', 'WP-03C TUI review', 30_000)
      tuiQ.send('\r')
      await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-settled' && event.sessionId === qc.sessionId, 'WP-03C Host settled', 120_000)
      await handle.signal('tui-answered')
      await handle.waitFact('reattached', 'WP-03C Browser reattached', 240_000)
    })
    assert(readC1WorkEvents(questionWork)
      .filter(event => event.kind === 'question-settled' && event.sessionId === qc.sessionId).length === 1,
    'WP-03C the detached Browser produced a second question settlement')
    recordSession('wp03c-question-detach', qc.sessionId)
    await ptyFrames('wp03c-question-detach', tuiQ)
    setWc('WC-06', 'PASS', 'a detached Browser could not resurrect or re-settle the Question; the TUI answer was the only settlement', ['WP-03A', 'WP-03B', 'WP-03C'])

    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!questionGroup.host.exited) {
      try { await questionGroup.host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }

    // WP-03D: the official timed question is a negative control, not a
    // substitute for a legal Browser responder.
    const timed = await startHost('question', 'wp03-timed', { C1_TIMED_QUESTION: '1' }, timedProductPatch)
    const { tui: tuiTimed } = await startTui('wp03-timed')
    await enableWeb(tuiTimed, 'WP-03D')
    await browserCase('wp03d-question-timed', {}, async handle => {
      await tuiSubmitUntil(tuiTimed, `wp03d-${productNonce}`, 'WP-03D', () => readC1WorkEvents(timed.workRoot)
        .some(event => event.kind === 'question-request'))
      // The official timed window is one second: the TUI modal may already
      // be gone. The Host fixture's own request record is the authority for
      // the Session id, and the 1s window is exactly the negative control.
      const request = await waitForC1WorkEvent(timed.workRoot,
        event => event.kind === 'question-request', 'WP-03D timed question request', 180_000)
      const sessionId = request.sessionId
      assert(typeof sessionId === 'string' && sessionId !== '', 'WP-03D the timed trigger created no Session')
      writeFileSync(join(handle.coord, 'session.json'), `${JSON.stringify({ sessionId }, null, 2)}\n`, { mode: 0o600 })
      await handle.waitFact('timed', 'WP-03D timed Browser observation', 240_000)
    })
    const timedSession = lastSurfaceStatus(tuiTimed)?.openSessionId
    const timedProofs = readC1WorkEvents(timed.workRoot)
    assert(timedProofs.some(event => event.kind === 'question-request' && event.timed === true),
      'WP-03D the Host question was not the official timed form')
    assert(timedProofs.some(event => event.kind === 'question-failed'),
      'WP-03D the timed question produced no official timeout failure')
    assert(!timedProofs.some(event => event.kind === 'question-settled' && event.sessionId === timedSession),
      'WP-03D the timed question was reported as an answered question')
    if (typeof timedSession === 'string') recordSession('wp03d-question-timed', timedSession)
    await ptyFrames('wp03d-question-timed', tuiTimed)
    setWc('WC-06', 'PASS', 'Browser/TUI first-winner, detach and the official timed negative are recorded', ['WP-03A', 'WP-03B', 'WP-03C', 'WP-03D'])
    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!timed.host.exited) {
      try { await timed.host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }

    // ── Group C/D: WP-04 Approvals ──────────────────────────────────────
    const runApprovalGroup = async (scenario, cases) => {
      const group = await startHost(scenario, `wp04-${scenario}`)
      const { tui } = await startTui(`wp04-${scenario}`)
      await enableWeb(tui, `WP-04 ${scenario}`)
      const sessionFor = async (label, trigger) => {
        const sessionId = await tuiNewSession(tui, `${label} new Session`)
        await tuiSubmitUntil(tui, trigger, label, () => readC1WorkEvents(group.workRoot)
          .some(event => event.kind === 'approval-request' && event.sessionId === sessionId))
        await tui.waitForScreen('[y] Allow once', `${label} approval sheet`, 180_000)
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-request' && event.sessionId === sessionId, `${label} Host approval request`, 120_000)
        return sessionId
      }
      try {
        await cases({ group, tui, sessionFor })
      } finally {
        for (const client of clients.splice(0)) {
          if (client.exited) continue
          try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
        }
        if (!group.host.exited) {
          try { await group.host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
      }
      return group
    }
    const approvalAllow = await runApprovalGroup('approval-allow', async ({ group, tui, sessionFor }) => {
      // WP-04A: Browser Allow wins; the TUI late Reject is inert.
      const a1 = await sessionFor('WP-04A', `wp04a-${productNonce}`)
      await browserCase('wp04a-approval-browser-allow', { sessionId: a1 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04A Browser approval', 240_000)
        await handle.waitFact('answered', 'WP-04A Browser Allow', 240_000)
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'WP-04A Host allowed the approval', 120_000)
        await waitForCondition(() => existsSync(join(group.workRoot, 'approval-allow.marker')),
          'WP-04A the allowed harmless command ran', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04A TUI converged', 180_000)
        await tui.waitForScreenGone('[y] Allow once', 'WP-04A TUI sheet withdrew', 120_000)
        const late = durableOf(a1).length
        tui.send('n')
        await sleep(300)
        tui.send('\x15')
        await sleep(300)
        assert(durableOf(a1).slice(late).every(event => event.type !== 'approval/decided'
          && event.type !== 'tool/result' && event.type !== 'turn/end'),
        'WP-04A a late TUI Reject produced a second Host decision')
        await handle.signal('runner-go')
      })
      const decided = durableOf(a1).filter(event => event.type === 'approval/decided')
      assert(decided.length === 1 && decided[0].data?.outcome === 'allowed-once',
        `WP-04A the Host decided ${JSON.stringify(decided.map(event => event.data?.outcome))}`)
      assert(existsSync(join(group.workRoot, 'approval-allow.marker')),
        'WP-04A the allowed marker command did not run on the Host')
      assert(!existsSync(join(tuiCwd, 'approval-allow.marker')),
        'WP-04A the Host marker landed in the TUI client cwd')
      recordSession('wp04a-approval-browser-allow', a1)
      await ptyFrames('wp04a-approval-browser-allow', tui)

      // WP-04C: TUI Allow wins; the Browser late Allow is inert.
      const a2 = await sessionFor('WP-04C', `wp04c-${productNonce}`)
      await browserCase('wp04c-approval-tui-first', { sessionId: a2 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04C Browser approval', 240_000)
        tui.send('y')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'WP-04C Host allowed the approval', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04C TUI settled', 180_000)
        await handle.signal('tui-answered')
        await handle.waitFact('settled', 'WP-04C Browser converged', 180_000)
      })
      assert(durableOf(a2).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04C the TUI-first approval produced more than one Host decision')
      recordSession('wp04c-approval-tui-first', a2)
      await ptyFrames('wp04c-approval-tui-first', tui)

      // WP-04F: the Browser sees the pending Approval, detaches, the TUI
      // settles, and the reattached Browser can only read the decision.
      const a3 = await sessionFor('WP-04F', `wp04f-${productNonce}`)
      await browserCase('wp04f-approval-offline', { sessionId: a3 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04F Browser approval', 240_000)
        await handle.waitFact('detached', 'WP-04F Browser detached', 120_000)
        tui.send('y')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'WP-04F Host allowed the approval', 120_000)
        await handle.signal('tui-answered')
        await handle.waitFact('reattached', 'WP-04F Browser reattached', 240_000)
      })
      assert(durableOf(a3).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04F the detached Browser produced a second Host approval decision')
      recordSession('wp04f-approval-offline', a3)
      await ptyFrames('wp04f-approval-offline', tui)
    })

    const approvalReject = await runApprovalGroup('approval-reject', async ({ group, tui, sessionFor }) => {
      // WP-04B: Browser Reject; the TUI late Allow cannot execute.
      const b1 = await sessionFor('WP-04B', `wp04b-${productNonce}`)
      await browserCase('wp04b-approval-browser-reject', { sessionId: b1 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04B Browser approval', 240_000)
        await handle.waitFact('answered', 'WP-04B Browser Reject', 240_000)
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04B Host rejected the approval', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04B TUI converged', 180_000)
        await tui.waitForScreenGone('[y] Allow once', 'WP-04B TUI sheet withdrew', 120_000)
        const late = durableOf(b1).length
        tui.send('y')
        await sleep(300)
        tui.send('\x15')
        await sleep(300)
        assert(durableOf(b1).slice(late).every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
          'WP-04B a late TUI Allow produced Host activity')
        await handle.signal('runner-go')
      })
      assert(durableOf(b1).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04B the Browser-first rejection decided more than once')
      assert(!existsSync(join(group.workRoot, 'approval-reject.marker')),
        'WP-04B the rejected command ran')
      recordSession('wp04b-approval-browser-reject', b1)
      await ptyFrames('wp04b-approval-browser-reject', tui)

      // WP-04D: TUI Reject wins; the Browser late Allow is inert.
      const b2 = await sessionFor('WP-04D', `wp04d-${productNonce}`)
      await browserCase('wp04d-approval-tui-reject', { sessionId: b2 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04D Browser approval', 240_000)
        tui.send('n')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04D Host rejected the approval', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04D TUI settled', 180_000)
        await handle.signal('tui-answered')
        await handle.waitFact('settled', 'WP-04D Browser converged', 180_000)
      })
      assert(durableOf(b2).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04D the TUI-first rejection decided more than once')
      assert(!existsSync(join(group.workRoot, 'approval-reject.marker')),
        'WP-04D the rejected command ran')
      recordSession('wp04d-approval-tui-reject', b2)
      await ptyFrames('wp04d-approval-tui-reject', tui)
    })

    // WP-04E: the existing qualification Peer's legal stale `$events/result`
    // frame must never produce a second decision. This is the official
    // Gateway/`$events` path, not a private approval endpoint.
    {
      const group = await startHost('approval-allow', 'wp04-stale')
      const { tui } = await startTui('wp04-stale')
      await enableWeb(tui, 'WP-04 stale')
      const stalePeer = await startPeer('WP-04E')
      try {
        const sessionId = await tuiNewSession(tui, 'WP-04E new Session')
        await tuiSubmitUntil(tui, `wp04e-${productNonce}`, 'WP-04E', () => readC1WorkEvents(group.workRoot)
          .some(event => event.kind === 'approval-request' && event.sessionId === sessionId))
        await tui.waitForScreen('[y] Allow once', 'WP-04E approval sheet', 180_000)
        const frame = await stalePeer.waitFor(record => record.m4a0 === 'peer-frame'
          && record.event === 'approval/request', 'WP-04E old Peer captured the approval frame', 180_000)
        assert(typeof frame.eventId === 'string' && typeof frame.clientId === 'string',
          'WP-04E the old Peer frame has no eventId/clientId')
        // While the Approval is STILL pending, a Peer with a FORGED identity
        // must not be able to settle the real pending event. This is the
        // pending-state wrong-Peer control the settled-only lane cannot prove.
        const pendingDecisionsBefore = durableOf(sessionId)
          .filter(event => event.type === 'approval/decided').length
        const forgedPendingClientId = `forged-pending-${productNonce}`
        stalePeer.send({
          op: 'peer-send-stale-result',
          eventId: frame.eventId,
          clientId: forgedPendingClientId,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const forgedPending = await stalePeer.waitFor(record => record.m4a0 === 'peer-stale-result-sent'
          && record.eventId === frame.eventId && record.clientId === forgedPendingClientId,
        'WP-04E forged pending Peer frame submitted', 30_000)
        await sleep(800)
        assert(durableOf(sessionId).filter(event => event.type === 'approval/decided').length === pendingDecisionsBefore,
          'WP-04E a forged Peer settled a PENDING approval')
        assert(!existsSync(join(group.workRoot, 'approval-allow.marker')),
          'WP-04E a forged pending allow executed the command')
        tui.send('n')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04E the legal reject settled', 120_000)
        const afterReject = durableOf(sessionId).filter(event => event.type === 'approval/decided').length
        stalePeer.send({
          op: 'peer-send-stale-result',
          eventId: frame.eventId,
          clientId: frame.clientId,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const stale = await stalePeer.waitFor(record => record.m4a0 === 'peer-stale-result-sent'
          && record.eventId === frame.eventId && record.clientId === frame.clientId,
        'WP-04E stale frame submitted', 30_000)
        assert(stale.ok === true, 'WP-04E the Host did not receive the old legal frame')
        await sleep(800)
        assert(durableOf(sessionId).filter(event => event.type === 'approval/decided').length === afterReject,
          'WP-04E the stale Peer frame produced a second Host decision')
        assert(!existsSync(join(group.workRoot, 'approval-allow.marker')),
          'WP-04E the stale allow executed the rejected command')
        // A forged identity is recorded honestly: the RPC may acknowledge
        // receipt while the Host ignores it through the stale fence.
        stalePeer.send({
          op: 'peer-send-stale-result',
          eventId: `forged-${productNonce}`,
          clientId: `forged-client-${productNonce}`,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const forged = await stalePeer.waitFor(record => record.m4a0 === 'peer-stale-result-sent'
          && record.eventId === `forged-${productNonce}`, 'WP-04E forged frame submitted', 30_000)
        await sleep(500)
        assert(durableOf(sessionId).filter(event => event.type === 'approval/decided').length === afterReject,
          'WP-04E a forged approval frame produced a second Host decision')
        evidence.fact('wp04e-stale-peer', 'peer-negative-controls', {
          pendingForged: {
            eventId: frame.eventId,
            clientId: forgedPendingClientId,
            ok: forgedPending.ok === true,
            ...(forgedPending.errorCode === undefined ? {} : { errorCode: forgedPending.errorCode }),
            decisions: pendingDecisionsBefore,
          },
          staleAfterSettle: {
            eventId: frame.eventId,
            clientId: frame.clientId,
            ok: stale.ok === true,
            ...(stale.errorCode === undefined ? {} : { errorCode: stale.errorCode }),
            decisions: afterReject,
          },
          forgedEventId: {
            eventId: `forged-${productNonce}`,
            ok: forged.ok === true,
            ...(forged.errorCode === undefined ? {} : { errorCode: forged.errorCode }),
            decisions: afterReject,
          },
        })
        recordSession('wp04e-stale-peer', sessionId)
        await ptyFrames('wp04e-stale-peer', tui)
        trace('t75-web-product-stale-peer', {
          pendingForgedRefused: true,
          pendingForgedOk: forgedPending.ok === true,
          pendingForgedErrorCode: forgedPending.errorCode,
          legalFrameIgnored: true,
          forgedFrameOk: forged.ok === true,
          forgedErrorCode: forged.errorCode,
          decisions: afterReject,
        })
      } finally {
        try { await stalePeer.shutdown() } catch { /* the global backstop owns leftovers */ }
        const index = peers.indexOf(stalePeer)
        if (index >= 0) peers.splice(index, 1)
        for (const client of clients.splice(0)) {
          if (client.exited) continue
          try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
        }
        if (!group.host.exited) {
          try { await group.host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
      }
    }
    setWc('WC-07', 'PASS', 'Browser first Allow/Reject, TUI first Allow/Reject, Browser offline, a PENDING forged-identity Peer refusal and the official stale `$events/result` frame all produced exactly one Host decision and the matching side effect', ['WP-04A', 'WP-04B', 'WP-04C', 'WP-04D', 'WP-04E', 'WP-04F'])
    assert(approvalAllow !== undefined && approvalReject !== undefined, 'WP-04 groups did not complete')

    // ── Group F: WP-05 Browser reload during a HELD Turn ────────────────
    {
      const holdBarrier = join(productRoot, 'long-turn.hold')
      rmSync(holdBarrier, { force: true })
      const held = await startHost('long-turn', 'wp05', { C1_HOLD_LONG_TURN: holdBarrier })
      const { tui } = await startTui('wp05')
      await enableWeb(tui, 'WP-05')
      const sessionHold = await tuiNewSession(tui, 'WP-05 new Session')
      const markerHold = `H-${productNonce}`
      const holdBoundary = durableOf(sessionHold).length
      await tuiSubmitUntil(tui, markerHold, 'WP-05', () => readC1WorkEvents(held.workRoot)
        .some(event => event.kind === 'long-turn-held' && event.sessionId === sessionHold))
      await tui.waitForScreen(markerHold, 'WP-05 held prompt painted', 180_000)
      const heldProof = await waitForC1WorkEvent(held.workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionHold, 'WP-05 held Turn', 180_000)
      assert(heldProof.agentStatus === 'running', 'WP-05 the held Turn is not actually running')
      await waitForHostSessionEventAfter(dshHome, sessionHold, holdBoundary,
        event => event.type === 'turn/start', 'WP-05 turn/start', 120_000)
      const hostBefore = (await hostStatus(held.host)).localHost
      await browserCase('wp05-refresh-held', { sessionId: sessionHold, marker: markerHold }, async handle => {
        await handle.waitFact('viewing', 'WP-05 Browser viewing the held Turn', 240_000)
        await handle.waitFact('reloaded', 'WP-05 Browser reloaded', 240_000)
        assert(!existsSync(holdBarrier), 'WP-05 the Turn was released before the reload proof')
        writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEventAfter(dshHome, sessionHold, holdBoundary,
          event => event.type === 'turn/end', 'WP-05 the held Turn settled', 180_000)
        await tui.waitForScreen('long-turn answer', 'WP-05 TUI painted the settled answer', 180_000)
        await handle.signal('turn-released')
      })
      assertIdentityFields((await hostStatus(held.host)).localHost, hostBefore,
        'WP-05 the Browser reload or the Turn release replaced the Host')
      recordSession('wp05-refresh-held', sessionHold)
      await ptyFrames('wp05-refresh-held', tui)
      setWc('WC-05', 'PASS', 'a real page reload during a HELD Host Turn preserved the Session and the single Host; the released Turn settled once', ['WP-02E', 'WP-05'])
      setWc('WC-08', 'PASS', 'TUI reload/exit/SIGKILL and a real Browser reload kept ONE Host and the durable Session advancing', ['WP-05', 'WP-06'])
      for (const client of clients.splice(0)) {
        if (client.exited) continue
        try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
      }
      if (!held.host.exited) {
        try { await held.host.shutdown() } catch { /* the global backstop owns leftovers */ }
      }
    }

    // ── Group E: WP-07 graceful Host stop and SIGKILL cold resume ───────
    {
      const lifecycle = await startHost('long-turn', 'wp07', { C1_HOLD_LONG_TURN: fastBarrier })
      const { tui } = await startTui('wp07')
      await enableWeb(tui, 'WP-07')
      const sessionLife = await tuiNewSession(tui, 'WP-07 new Session')
      await tuiTurn(tui, sessionLife, `H-${productNonce}-host-life`, 'WP-07 seed')
      const lifecyclePeer = await startPeer('WP-07')
      const savedOn = await webPreference(lifecyclePeer, 'WP-07 autoStart On', true)
      assert(savedOn.ok === true && savedOn.readBack === true, 'WP-07 the autoStart On write did not read back')
      await lifecyclePeer.shutdown()
      const beforeStop = (await hostStatus(lifecycle.host)).localHost
      let wp07Final
      await browserCase('wp07-host-lifecycle', { sessionId: sessionLife }, async handle => {
        await handle.waitFact('ready', 'WP-07 Browser ready', 240_000)
        // 1. Graceful owner-governed stop. Capture the failure boundary BEFORE
        //    the stop so this generation's disconnect cannot borrow an earlier
        //    generation's network/console failure.
        handle.writeCommand({ seq: 0, kind: 'mark', name: 'graceful' })
        await handle.waitStep(0, 'WP-07 mark before the graceful stop')
        const stopped = await lifecycle.host.shutdown()
        assert(stopped.code === 0, 'WP-07 the graceful Host stop exited non-zero')
        handle.writeCommand({ seq: 1, kind: 'expect-offline', mark: 'graceful', timeoutMs: 180_000 })
        await handle.waitStep(1, 'WP-07 Browser observed the graceful stop')
        await waitForCondition(() => !alive(beforeStop.hostPid), 'WP-07 the stopped Host process is gone', 30_000)
        assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', beforeStop.scopeId, 'instance.json')),
          'WP-07 the graceful stop left the Host registry')
        // 2. A NEW Host in the same profile scope; its autoStart preference
        //    loads the Web rows BEFORE Ready and the durable Session log.
        const next = await startHost('long-turn', 'wp07-next', { C1_HOLD_LONG_TURN: fastBarrier })
        assert(next.ready.pid !== beforeStop.hostPid, 'WP-07 the cold resume reused the stopped Host process')
        webFullyOn(next.ready)
        assertSingleHostOwners(await hostStatus(next.host), 'WP-07 cold-resumed Host')
        handle.writeCommand({ seq: 2, kind: 'reconnect', sessionId: sessionLife })
        await handle.waitStep(2, 'WP-07 Browser reconnected to the new Host')
        await waitForHostSessionEvent(dshHome, sessionLife,
          event => event.type === 'user/message' && JSON.stringify(event).includes(`H-${productNonce}-host-life`),
          'WP-07 the durable Session survived the graceful stop', 120_000)
        const { tui: nextTui } = await startTui('WP-07 resumed TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
        await nextTui.waitForScreen(`H-${productNonce}-host-life`, 'WP-07 resumed TUI reads the Session', 180_000)
        const afterResumeBoundary = durableOf(sessionLife).length
        handle.writeCommand({ seq: 3, kind: 'prompt', prompt: `H-${productNonce}-after-resume`, marker: `H-${productNonce}-after-resume` })
        await handle.waitStep(3, 'WP-07 Browser turn after cold resume')
        // The Browser driver's scroll-container wait can observe the painted
        // prompt beside an OLD answer; the durable Host write is the authority.
        // Anchor it AFTER the boundary captured before the command, never a
        // bare "some answer exists" wait.
        await waitForHostSessionEventAfter(dshHome, sessionLife, afterResumeBoundary,
          event => event.type === 'user/message' && JSON.stringify(event).includes(`H-${productNonce}-after-resume`),
          'WP-07 Browser prompt after cold resume durable', 120_000)
        const afterResumeCount = userEvents(sessionLife, `H-${productNonce}-after-resume`).length
        assert(afterResumeCount === 1,
          `WP-07 the Browser turn after cold resume was committed ${String(afterResumeCount)} times, expected exactly 1`)
        // 3. SIGKILL the new Host; a pending/unknown write must not become a
        //    fake success and the old identity must be invalid. The failure
        //    boundary is captured before this generation is killed.
        handle.writeCommand({ seq: 4, kind: 'mark', name: 'sigkill' })
        await handle.waitStep(4, 'WP-07 mark before the SIGKILL')
        const oldInstance = next.ready.localHost.instanceId
        next.host.kill('SIGKILL')
        const killed = await next.host.waitForExit(60_000)
        assert(killed.signal === 'SIGKILL' || killed.code !== 0, `WP-07 the SIGKILL Host exit was ${JSON.stringify(killed)}`)
        handle.writeCommand({ seq: 5, kind: 'expect-offline', mark: 'sigkill', timeoutMs: 180_000 })
        await handle.waitStep(5, 'WP-07 Browser observed the Host SIGKILL')
        const staleInstance = readJson(join(dshHome, 'run', 'dsh-pi-tui', next.ready.localHost.scopeId, 'instance.json'))
        assert(staleInstance.instanceId === oldInstance,
          'WP-07 the SIGKILL left no stale identity for the negative control')
        const final = await startHost('long-turn', 'wp07-final', { C1_HOLD_LONG_TURN: fastBarrier })
        wp07Final = final
        assert(final.ready.localHost.instanceId !== oldInstance,
          'WP-07 a cold-started Host reused the killed instance id')
        await waitForHostSessionHeader(dshHome, sessionLife, 'WP-07 final Session header')
        handle.writeCommand({ seq: 6, kind: 'reconnect', sessionId: sessionLife })
        await handle.waitStep(6, 'WP-07 Browser reconnected after the SIGKILL')
        handle.writeCommand({ seq: 7, kind: 'finish' })
        await handle.waitStep(7, 'WP-07 Browser finish')
      })
      recordSession('wp07-host-lifecycle', sessionLife)
      setWc('WC-08', 'PASS', 'graceful stop and SIGKILL each left a stale/absent old identity, no fabricated settlement, and ONE fresh Host with the durable Session and autoStart preference', ['WP-05', 'WP-06', 'WP-07'])
      if (wp07Final !== undefined && !wp07Final.host.exited) {
        const stop = await wp07Final.host.shutdown()
        assert(stop.code === 0, 'WP-07 the final Host did not stop before the pending case')
      }

      // WP-07 pending/unknown Browser write across a Host SIGKILL.
      {
        const pendingBarrier = join(productRoot, 'long-turn.pending')
        rmSync(pendingBarrier, { force: true })
        const pending = await startHost('long-turn', 'wp07-pending', { C1_HOLD_LONG_TURN: pendingBarrier })
        const { tui: pendingTui } = await startTui('wp07-pending')
        await enableWeb(pendingTui, 'WP-07 pending')
        const pendingMarker = `H-${productNonce}-pending`
        let pendingSession
        let pendingNext
        try {
          await browserCase('wp07-pending-write', {}, async handle => {
            const session = await handle.waitFact('session', 'WP-07 pending Session', 240_000)
            pendingSession = session.sessionId
            handle.writeCommand({ seq: 1, kind: 'send', prompt: pendingMarker })
            await handle.waitStep(1, 'WP-07 pending Browser send')
            await waitForC1WorkEvent(pending.workRoot,
              event => event.kind === 'long-turn-held' && event.sessionId === pendingSession,
              'WP-07 pending Host held the Turn', 180_000)
            const beforeKill = durableOf(pendingSession)
            assert(beforeKill.filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(pendingMarker)).length === 1,
            'WP-07 pending: the Browser prompt was not committed once before the kill')
            assert(!beforeKill.some(event => event.type === 'assistant/message'),
              'WP-07 pending: an assistant message settled before the kill')
            assert(!beforeKill.some(event => event.type === 'turn/end'),
              'WP-07 pending: the Turn settled before the kill')
            handle.writeCommand({ seq: 2, kind: 'mark', name: 'pending' })
            await handle.waitStep(2, 'WP-07 pending mark before the SIGKILL')
            pending.host.kill('SIGKILL')
            const killed = await pending.host.waitForExit(60_000)
            assert(killed.signal === 'SIGKILL' || killed.code !== 0,
              `WP-07 pending Host exit was ${JSON.stringify(killed)}`)
            handle.writeCommand({ seq: 3, kind: 'expect-offline', mark: 'pending', timeoutMs: 180_000 })
            await handle.waitStep(3, 'WP-07 pending Browser observed the SIGKILL')
            const afterKill = durableOf(pendingSession)
            assert(afterKill.filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(pendingMarker)).length === 1,
            'WP-07 pending: the kill duplicated the pending prompt')
            assert(!afterKill.some(event => event.type === 'assistant/message'),
              'WP-07 pending: the killed Host fabricated an assistant answer')
            pendingNext = await startHost('long-turn', 'wp07-pending-next', { C1_HOLD_LONG_TURN: pendingBarrier })
            assert(pendingNext.ready.localHost.instanceId !== pending.ready.localHost.instanceId,
              'WP-07 pending: the cold Host reused the killed instance id')
            handle.writeCommand({ seq: 4, kind: 'reconnect', sessionId: pendingSession })
            await handle.waitStep(4, 'WP-07 pending Browser reconnected')
            await sleep(1_000)
            const finalEvents = durableOf(pendingSession)
            assert(finalEvents.filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(pendingMarker)).length === 1,
            'WP-07 pending: the cold Host replayed or duplicated the pending prompt')
            assert(!finalEvents.some(event => event.type === 'assistant/message'),
              'WP-07 pending: the pending prompt was answered after cold resume')
            assert(!finalEvents.some(event => event.type === 'turn/end'
              && event.data?.reason?.kind === 'completed'),
            'WP-07 pending: a fake completed settlement survived the kill')
            handle.writeCommand({ seq: 5, kind: 'finish' })
            await handle.waitStep(5, 'WP-07 pending finish')
          })
          assert(typeof pendingSession === 'string' && pendingSession !== '',
            'WP-07 pending: the Browser created no Session')
          recordSession('wp07-pending-write', pendingSession)
          setWc('WC-08', 'PASS', 'TUI reload/exit/SIGKILL, a real Browser reload and a pending Browser write across Host SIGKILL/cold resume all kept ONE Host/Writer with no fabricated settlement and no replay', ['WP-05', 'WP-06', 'WP-07'])
        } finally {
          try { await pendingTui.dispose() } catch { /* best effort */ }
          if (!pending.host.exited) { try { await pending.host.shutdown() } catch { /* best effort */ } }
          if (pendingNext !== undefined && !pendingNext.host.exited) {
            try { await pendingNext.host.shutdown() } catch { /* best effort */ }
          }
        }
      }
      // ── Group W: WP-11 (S5-PR5) official Web user capabilities ─────────
      // One real Host, one real PTY TUI, one real Chromium: the official
      // file-actions Download, message-quotes draft, and the Host-recorded
      // changed-files card/review. The Browser driver owns every user gesture;
      // this runner owns the authoritative Host facts and the official
      // authenticated routes.
      {
        const changesNonce = productNonce
        // The earlier WP-07 group leaves the profile-owned Auto-start
        // preference On (its own cold-boot scene). WP-11 starts from the
        // product default, Off, through the OFFICIAL settings wire — never a
        // direct patch write.
        {
          const resetHost = await startHost('web-workspace-changes', 'wp11-pref-reset', { C1_CHANGES_NONCE: changesNonce })
          const resetPeer = await startPeer('WP-11 preference reset')
          try {
            const reset = await webPreference(resetPeer, 'WP-11 preference reset', false)
            assert(reset.ok === true && reset.readBack === true,
              `WP-11 could not reset the profile Auto-start preference to Off: ${JSON.stringify(reset)}`)
          } finally {
            try { await resetPeer.shutdown() } catch { /* best effort */ }
            if (!resetHost.host.exited) { try { await resetHost.host.shutdown() } catch { /* best effort */ } }
          }
        }
        const wp11 = await startHost('web-workspace-changes', 'wp11-capabilities', { C1_CHANGES_NONCE: changesNonce })
        let wp11Next
        let wp11Peer
        let tuiW
        try {
          assertSingleHostOwners(wp11.ready, 'WP-11 Host')
          tuiW = (await startTui('wp11-capabilities')).tui
          await enableWeb(tuiW, 'WP-11', { requireDisabled: true })
          const enabled11 = await hostStatus(wp11.host)
          assertSingleHostOwners(enabled11, 'WP-11 enabled Host')
          webFullyOn(enabled11)
          for (const id of ['workspace-changes', 'ui-deliverables']) {
            const entry = (enabled11.entries ?? []).find(candidate => candidate.id === id)
            assert(entry?.state === 'active', `WP-11 the "${id}" row is ${String(entry?.state)}, not active`)
          }
          assert((enabled11.entries ?? []).filter(entry => entry.name === '@deepseek-ai/dsh-workspace-changes').length === 1,
            'WP-11 expected exactly ONE official workspace-changes Host row')
          const launch11 = launchOf(wp11.ready)
          const index11 = await readHostWebIndex(wp11.ready.localHost.origin, launch11, 'WP-11')
          assertWebIndexQualified(index11, 'WP-11', targetDshVersion)
          // The W5-CHANGES fixture: ONE dedicated, disposable folder under this
          // lane's product root, adopted as a Workspace through the official
          // generated workspace wire; the REAL Browser then starts the Session
          // in it through its own "New session in <Workspace>" action.
          const dedicatedWorkspace = join(productRoot, 'documents', 'w5-changed-files')
          mkdirSync(dedicatedWorkspace, { recursive: true, mode: 0o700 })
          const workspacePeer = await startPeer('WP-11 workspace')
          const workspaceFacts = await workspaceCreate(workspacePeer, 'WP-11 workspace', dedicatedWorkspace)
          assert(workspaceFacts.ok === true,
            `WP-11 could not adopt the dedicated Workspace through the official wire: ${JSON.stringify(workspaceFacts)}`)
          await workspacePeer.shutdown()
          const workspaceIndex = peers.indexOf(workspacePeer)
          if (workspaceIndex >= 0) peers.splice(workspaceIndex, 1)

          let wp11Session
          let wp11Seq
          let wp11Turn
          let wp11Cwd
          let wp11HostBytes
          let wp11Diff
          let wp11Download
          let wp11Seq2
          let wp11Turn2
          await browserCase('wp11-official-web-capabilities', { changesNonce }, async handle => {
            const session = await handle.waitFact('session', 'WP-11 Browser Session creation', 240_000)
            wp11Session = session.sessionId
            assert(typeof wp11Session === 'string' && wp11Session !== '', 'WP-11 the Browser created no Host Session')
            const header = await waitForHostSessionHeader(dshHome, wp11Session, 'WP-11 Session header')
            wp11Cwd = header.cwd
            assert(typeof wp11Cwd === 'string' && wp11Cwd !== '', 'WP-11 the Session records no authoritative cwd')
            // The plan-fixed fixture: the Session's authoritative cwd is the
            // DEDICATED, disposable Default-workspace folder under this lane's
            // isolated product root — never the profile directory, the smoke
            // work root itself, or the developer's repository.
            assert(resolve(wp11Cwd) === resolve(dedicatedWorkspace),
              `WP-11 the Session cwd is not the dedicated Default workspace of this lane: ${wp11Cwd} != ${dedicatedWorkspace}`)
            assert(existsSync(dedicatedWorkspace) === true, 'WP-11 the dedicated workspace folder does not exist')
            // The isolated, disposable Git work tree at the Session's OWN cwd.
            const git = args => spawnSync('git', args, { cwd: wp11Cwd, encoding: 'utf8' })
            const init = git(['init', '--quiet'])
            assert(init.status === 0, `WP-11 could not initialize the isolated Git work tree: ${init.stderr}`)
            writeFileSync(join(wp11Cwd, 'README.md'), `w5-base-${changesNonce}\n`, { mode: 0o600 })
            // The W5-FILE Copy image source: a real PNG inside the dedicated
            // workspace, part of the baseline (never a turn change).
            const shotPng = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              'base64',
            )
            writeFileSync(join(wp11Cwd, 'shot.png'), shotPng, { mode: 0o600 })
            const shotHash = createHash('sha256').update(shotPng).digest('hex')
            assert(git(['add', '--all']).status === 0, 'WP-11 could not stage the initial work tree')
            const committed = git(['-c', 'user.name=WP11', '-c', 'user.email=wp11@example.invalid', 'commit', '--quiet', '-m', 'w5 baseline'])
            assert(committed.status === 0, `WP-11 could not create the initial commit: ${committed.stderr}`)
            handle.signal('workspace-ready')

            // W5-CHANGES source: the scripted model's OWN proof, the durable
            // official `write` tool call/result, the live official summary/diff
            // routes, and the real file bytes agree.
            const boundary = durableOf(wp11Session).length
            const changesEvent = await waitForHostSessionEventAfter(dshHome, wp11Session, boundary,
              event => event.type === 'workspace/changes', 'WP-11 durable workspace/changes event', 300_000)
            assert(Number.isSafeInteger(changesEvent.data?.turn) && changesEvent.data.turn >= 1,
              `WP-11 the workspace/changes event carries no turn: ${JSON.stringify(changesEvent.data)}`)
            wp11Seq = changesEvent.seq
            wp11Turn = changesEvent.data.turn
            // The scripted model's own proof that IT issued the call (not the
            // fixture writing the file), matched to this Session and nonce.
            const writeProof = readC1WorkEvents(wp11.workRoot)
              .filter(event => event.kind === 'web-changes-write-issued' && event.sessionId === wp11Session)
            assert(writeProof.length === 1,
              `WP-11 the C1 model issued ${String(writeProof.length)} write calls for this Session, expected exactly 1`)
            assert(writeProof[0].nonce === changesNonce, 'WP-11 the model write proof belongs to another nonce')
            assert(writeProof[0].userText.includes(`w5-changes-${changesNonce}`),
              'WP-11 the model write proof was not issued for the qualification prompt')
            // The Host's OWN official write tool executed the fixed call inside
            // this turn, and its successful result precedes the announced event.
            const turnEvents = durableOf(wp11Session).filter(event => event.data?.turn === wp11Turn)
            const writeCalls = turnEvents.filter(event => event.type === 'tool/call' && event.data?.name === 'write')
            assert(writeCalls.length === 1,
              `WP-11 the turn persisted ${String(writeCalls.length)} official write tool calls, expected exactly 1`)
            const writeArgs = JSON.parse(writeCalls[0].data.arguments)
            assert(JSON.stringify(writeArgs) === JSON.stringify({ file_path: 'changed.txt', content: `w5-change-${changesNonce}\n` }),
              `WP-11 the write tool arguments drifted: ${JSON.stringify(writeArgs)}`)
            const writeResults = turnEvents.filter(event => event.type === 'tool/result'
              && event.data?.message?.toolCallId === writeCalls[0].data.callId)
            assert(writeResults.length === 1,
              `WP-11 the write tool call settled ${String(writeResults.length)} times, expected exactly 1`)
            assert(writeResults[0].data.message.isError === false,
              'WP-11 the official write tool result reports an error')
            assert(writeResults[0].seq > writeCalls[0].seq && changesEvent.seq > writeResults[0].seq,
              'WP-11 the workspace/changes event does not follow the successful write tool result')
            const coordinates = new URLSearchParams({ sessionId: wp11Session, seq: String(wp11Seq) })
            const summaryUrl = `${wp11.ready.localHost.origin}/api/changes.summary?${coordinates}`
            const summary = await fetchStatus(summaryUrl, { headers: { cookie: index11.cookie } })
            assert(summary.status === 200, `WP-11 the authenticated summary route returned HTTP ${String(summary.status)}`)
            const summaryBody = JSON.parse(summary.body)
            assert(summaryBody.turn === wp11Turn, 'WP-11 the summary turn differs from the announced event turn')
            assert(Array.isArray(summaryBody.files) && summaryBody.files.length === 1,
              `WP-11 the dedicated workspace summary must list exactly the one written file: ${JSON.stringify(summaryBody.files)}`)
            assert(summaryBody.files[0].path === 'changed.txt',
              `WP-11 the summary path drifted from the written file: ${JSON.stringify(summaryBody.files[0]?.path)}`)
            assert(summaryBody.total === 1, `WP-11 the summary total is ${String(summaryBody.total)}, expected 1`)
            const fileIndex = 0
            assert(summaryBody.files[fileIndex].added >= 1, 'WP-11 the summary reports no added line for the real write')
            wp11HostBytes = readFileSync(join(wp11Cwd, 'changed.txt'))
            assert(wp11HostBytes.toString('utf8') === `w5-change-${changesNonce}\n`,
              'WP-11 the Host file does not hold the exact written content')
            const diffUrl = `${wp11.ready.localHost.origin}/api/changes.diff?${coordinates}&index=${String(fileIndex)}`
            const diff = await fetchStatus(diffUrl, { headers: { cookie: index11.cookie } })
            assert(diff.status === 200, `WP-11 the authenticated comparison route returned HTTP ${String(diff.status)}`)
            wp11Diff = JSON.parse(diff.body)
            assert(wp11Diff.kind === 'text' && wp11Diff.before === false && wp11Diff.after === true,
              `WP-11 the comparison is not the created text file: ${JSON.stringify({ kind: wp11Diff.kind, before: wp11Diff.before, after: wp11Diff.after })}`)
            const addedText = wp11Diff.hunks.flatMap(hunk => hunk.lines).filter(line => line.startsWith('+')).join('\n')
            assert(addedText.includes(`w5-change-${changesNonce}`),
              'WP-11 the official comparison does not serve the recorded line')
            const anonymous = await fetchStatus(summaryUrl)
            assert(anonymous.status === 401,
              `WP-11 the unauthenticated summary route was not refused (HTTP ${String(anonymous.status)})`)
            await handle.signal('changes-review-go')

            // The Browser sink: the card and its Review page paint the Host facts.
            const card = await handle.waitFact('changes-card', 'WP-11 changed-files card', 300_000)
            assert(typeof card.text === 'string' && card.text.includes('changed.txt'),
              'WP-11 the changed-files card does not name the changed file')
            const review = await handle.waitFact('review', 'WP-11 changes review', 300_000)
            assert(review.state === 'ready', `WP-11 the changes review state is ${String(review.state)}`)
            assert(typeof review.file === 'string' && review.file.endsWith('changed.txt'),
              `WP-11 the review opened ${String(review.file)}, not changed.txt`)
            assert((review.text ?? '').includes(`w5-change-${changesNonce}`),
              'WP-11 the review does not paint the Host-served change')
            const network = review.network ?? {}
            assert((network.statuses ?? []).some(entry => entry.path === '/api/changes.summary' && entry.status === 200),
              'WP-11 the Browser never read the official summary route')
            assert((network.statuses ?? []).some(entry => entry.path === '/api/changes.diff' && entry.status === 200),
              'WP-11 the Browser never read the official comparison route')

            // W5-FILE: the downloaded bytes ARE the Host bytes.
            wp11Download = await handle.waitFact('download', 'WP-11 real Browser download', 300_000)
            const hostHash = createHash('sha256').update(wp11HostBytes).digest('hex')
            assert(wp11Download.sha256 === hostHash,
              `WP-11 the downloaded bytes (${String(wp11Download.sha256)}) are not the Host file (${hostHash})`)
            assert(wp11Download.bytes === wp11HostBytes.length,
              `WP-11 the downloaded byte count ${String(wp11Download.bytes)} differs from the Host file`)
            assert(!(wp11Download.labels ?? []).some(label => /^Save as/u.test(label)),
              'WP-11 the Web file menu offered the Desktop-only Save as')
            const fileNegative = await handle.waitFact('file-negative', 'WP-11 missing-file refusal', 300_000)
            assert(fileNegative.downloadStarted === false, 'WP-11 a missing Session file started a download')
            assert(readFileSync(join(wp11Cwd, 'changed.txt')).equals(wp11HostBytes),
              'WP-11 the refused file action modified the Host file')

            // W5-FILE image: the official image menu's Copy image must place the
            // ORIGINAL workspace PNG on the real browser clipboard.
            const copied = await handle.waitFact('copy-image', 'WP-11 image Copy', 300_000)
            assert(copied.ok === true && copied.type === 'image/png' && copied.pngSignature === true,
              `WP-11 Copy image did not put a real PNG on the clipboard: ${JSON.stringify(copied)}`)
            // Clipboard equivalence is DECODED-pixel level: Chromium may
            // re-encode the PNG bytes, so the byte sha256 is informational only.
            assert(copied.pixelsEqual === true,
              `WP-11 the clipboard PNG pixels differ from the workspace source: ${JSON.stringify({ width: copied.width, height: copied.height, pixelSha256: copied.pixelSha256, source: copied.source })}`)
            assert(copied.width === 1 && copied.height === 1,
              `WP-11 the clipboard PNG is ${String(copied.width)}x${String(copied.height)}, expected the 1x1 fixture`)
            assert(copied.source?.pixelSha256 === copied.pixelSha256,
              'WP-11 the clipboard pixels are not the source image pixels')
            assert(!(copied.labels ?? []).some(label => /^Save as/u.test(label)),
              'WP-11 the Web image menu offered the Desktop-only Save as')
            // A REAL copy refusal: the rendered image's Host source disappears,
            // so the official authorized read fails and the fixed failure
            // feedback must appear instead of a fake success; the source is
            // restored afterwards. (Chromium grants an activation-backed
            // clipboard write even with the permission setting denied, so a
            // permission-denial failure is recorded as not observable — never
            // faked with a JS mock.)
            rmSync(join(wp11Cwd, 'shot.png'), { force: true })
            handle.signal('image-source-removed')
            const copyNegative = await handle.waitFact('copy-negative', 'WP-11 refused image Copy', 300_000)
            assert(copyNegative.failureFeedback === true,
              'WP-11 a refused Copy image surfaced no official failure feedback')
            writeFileSync(join(wp11Cwd, 'shot.png'), shotPng, { mode: 0o600 })
            assert(readFileSync(join(wp11Cwd, 'shot.png')).equals(shotPng),
              'WP-11 could not restore the image source')

            // W5-QUOTE: selection drafts only; the explicit Send is the ONE write.
            // The Host appends its own per-turn runtime/time context as
            // user-role messages, so the comparison is the LIVE count at the
            // moment the selection was admitted, never a hard-coded 1.
            const userCountBeforeQuote = durableOf(wp11Session).filter(event => event.type === 'user/message').length
            const draft = await handle.waitFact('quote-draft', 'WP-11 Quote draft', 300_000)
            assert(Array.isArray(draft.quoteNodes)
              && draft.quoteNodes.some(text => typeof text === 'string' && text.includes(`w5-editing ${changesNonce}`)),
            'WP-11 the Quote action did not insert the selected text as an atomic draft quote')
            // The draft's model-visible Markdown is the official editor's own
            // clipboard serialization; a refused Clipboard API is recorded, not claimed.
            assert(draft.markdownDraft === null
              || (typeof draft.markdownDraft === 'string' && draft.markdownDraft.includes(`> w5-editing ${changesNonce}`)),
            `WP-11 the composer draft is not the expected Markdown blockquote: ${JSON.stringify(draft.markdownDraft)}`)
            const userCountAtDraft = durableOf(wp11Session).filter(event => event.type === 'user/message').length
            assert(userCountAtDraft === userCountBeforeQuote,
              `WP-11 the Quote draft added ${String(userCountAtDraft - userCountBeforeQuote)} user message(s); selection must not submit`)
            // A separate TUI Session is kept for the Web-off continuity Turn;
            // the Browser's cross-Session check uses its own new Session in the
            // same dedicated Workspace.
            const otherSession = await tuiNewSession(tuiW, 'WP-11 other Session')
            const other = await handle.waitFact('quote-other-session', 'WP-11 other-Session check', 300_000)
            assert(typeof other.sessionId === 'string' && other.sessionId !== wp11Session,
              'WP-11 the other-Session check reused the quoted Session')
            assert(!String(other.draft ?? '').includes(`w5-editing ${changesNonce}`)
              && !(other.quotes ?? []).some(text => String(text).includes(`w5-editing ${changesNonce}`)),
            'WP-11 the Quote draft leaked into another Session')
            assert(durableOf(wp11Session).filter(event => event.type === 'user/message').length === userCountBeforeQuote,
              'WP-11 navigating to another Session wrote the Quote into the original Session')
            const authoredAtDraft = durableOf(wp11Session)
              .filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user').length
            const systemBeforeSend = durableOf(wp11Session)
              .filter(event => event.type === 'system/message' || event.type === 'developer/message').length
            const lastTurnEndBeforeQuote = durableOf(wp11Session)
              .filter(event => event.type === 'turn/end').at(-1)?.seq ?? 0
            await handle.signal('quote-send-go')
            await handle.waitFact('quote-sent', 'WP-11 quoted Send', 300_000)
            const afterSend = durableOf(wp11Session)
            const authoredAfterSend = afterSend
              .filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
            assert(authoredAfterSend.length === authoredAtDraft + 1,
              `WP-11 the explicit Send wrote ${String(authoredAfterSend.length - authoredAtDraft)} user-authored messages, expected exactly 1`)
            const quotedWrites = authoredAfterSend.filter(event => JSON.stringify(event).includes(`> w5-editing ${changesNonce}`))
            assert(quotedWrites.length === 1,
              `WP-11 the quoted prompt was committed ${String(quotedWrites.length)} times, expected exactly 1`)
            assert(quotedWrites[0] === authoredAfterSend[authoredAfterSend.length - 1],
              'WP-11 the quoted prompt is not the one user message the explicit Send appended')
            assert(hostAssistantHasText(afterSend, 'w5-quote answer'),
              'WP-11 the quoted prompt produced no normal assistant answer')
            assert(afterSend.filter(event => event.type === 'system/message' || event.type === 'developer/message').length === systemBeforeSend,
              'WP-11 the Quote inserted a system/developer message')
            // Anchor the two later settlement barriers on durable turn ends:
            // the quoted turn, then the no-change turn.
            const quoteTurnEnd = await waitForHostSessionEvent(dshHome, wp11Session,
              event => event.type === 'turn/end' && event.seq > lastTurnEndBeforeQuote,
              'WP-11 quoted turn/end', 180_000)

            // W5-CHANGES negative: a tool-active Turn with no file change stays card-free.
            await handle.waitFact('nochange-prompted', 'WP-11 no-change prompt', 300_000)
            // The Host's own turn settlement is the barrier: no fixed sleep can
            // prove a card absence, and the durable events are the authority.
            await waitForHostSessionEvent(dshHome, wp11Session,
              event => event.type === 'turn/end' && event.seq > quoteTurnEnd.seq,
              'WP-11 no-change turn/end', 180_000)
            assert(durableOf(wp11Session).filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(`w5-nochange-${changesNonce}`)).length === 1,
            'WP-11 the no-change prompt was not committed exactly once')
            let changesAfter = []
            const changesStableUntil = Date.now() + 2_000
            while (Date.now() < changesStableUntil) {
              changesAfter = durableOf(wp11Session).filter(event => event.type === 'workspace/changes')
              if (changesAfter.length !== 1) break
              await sleep(100)
            }
            assert(changesAfter.length === 1,
              `WP-11 the Host persisted ${String(changesAfter.length)} workspace/changes events, expected exactly the changed Turn`)
            handle.signal('nochange-settled')
            const noChange = await handle.waitFact('nochange', 'WP-11 no-change Browser frame', 120_000)
            assert(noChange.cardsAfter === noChange.cardsBefore,
              'WP-11 a no-change Turn painted a new changed-files card')

            // ── A5 same-Host isolation: with a live Changes summary, Web off ->
            // TUI keeps working -> Web on. The new recorder must not reuse the
            // old coordinates, and a NEW real write must record normally.
            const toggleBoundary = durableOf(wp11Session).length
            const identityBeforeToggle = (await hostStatus(wp11.host)).localHost
            const generationBeforeToggle = lastSurfaceStatus(tuiW)?.generationId
            await handle.waitFact('toggle-ready', 'WP-11 toggle checkpoint', 300_000)
            await disableWeb(tuiW, 'WP-11 disable')
            const disabled11 = await hostStatus(wp11.host)
            webFullyOff(disabled11)
            assertSingleHostOwners(disabled11, 'WP-11 disabled Host')
            assertIdentityFields(disabled11.localHost, identityBeforeToggle, 'WP-11 disable kept the Host identity')
            // The TUI keeps operating on the SAME Host while Web is off.
            await tuiTurn(tuiW, otherSession, `w5-during-disable-${changesNonce}`, 'WP-11 TUI while Web off')
            assert(lastSurfaceStatus(tuiW)?.generationId === generationBeforeToggle,
              'WP-11 the TUI transport generation changed while Web was off')
            await enableWeb(tuiW, 'WP-11 re-enable')
            const reenabled11 = await hostStatus(wp11.host)
            webFullyOn(reenabled11)
            assertSingleHostOwners(reenabled11, 'WP-11 re-enabled Host')
            assertIdentityFields(reenabled11.localHost, identityBeforeToggle, 'WP-11 re-enable kept the Host identity')
            assert(lastSurfaceStatus(tuiW)?.generationId === generationBeforeToggle,
              'WP-11 the TUI transport generation changed across the Web toggle')
            // The freshly composed recorder must NOT serve the old coordinates.
            const staleOnSameHost = await fetchStatus(summaryUrl, { headers: { cookie: index11.cookie } })
            assert(staleOnSameHost.status === 404,
              `WP-11 the re-enabled Host served the pre-disable summary (HTTP ${String(staleOnSameHost.status)})`)
            const staleDiffSameHost = await fetchStatus(diffUrl, { headers: { cookie: index11.cookie } })
            assert(staleDiffSameHost.status === 404,
              `WP-11 the re-enabled Host served the pre-disable comparison (HTTP ${String(staleDiffSameHost.status)})`)
            handle.signal('toggle-reenabled')
            const secondChange = await handle.waitFact('toggle-second-change', 'WP-11 post-re-enable change', 300_000)
            assert((secondChange.text ?? []).some(text => String(text).includes('changed2.txt')),
              'WP-11 the post-re-enable Turn painted no changed2.txt card')
            const secondEvent = await waitForHostSessionEventAfter(dshHome, wp11Session, toggleBoundary,
              event => event.type === 'workspace/changes' && event.seq > wp11Seq,
              'WP-11 post-re-enable workspace/changes event', 180_000)
            wp11Seq2 = secondEvent.seq
            wp11Turn2 = secondEvent.data.turn
            // RFL-006: the SECOND real change must carry the SAME official
            // write-tool source witness as the first one.
            const write2Proof = readC1WorkEvents(wp11.workRoot)
              .filter(event => event.kind === 'web-changes-write2-issued' && event.sessionId === wp11Session)
            assert(write2Proof.length === 1,
              `WP-11 the C1 model issued ${String(write2Proof.length)} second write calls, expected exactly 1`)
            assert(write2Proof[0].nonce === changesNonce
              && write2Proof[0].userText.includes(`w5-changes2-${changesNonce}`),
            `WP-11 the second model write proof belongs to another prompt (nonce=${String(write2Proof[0].nonce)})`)
            assert(durableOf(wp11Session).filter(event => event.type === 'user/message'
              && event.data?.source?.kind === 'user'
              && JSON.stringify(event).includes(`w5-changes2-${changesNonce}`)).length === 1,
            'WP-11 the second write prompt was not committed as exactly one authored user message')
            const secondTurnEvents = durableOf(wp11Session).filter(event => event.data?.turn === wp11Turn2)
            const secondWriteCalls = secondTurnEvents.filter(event => event.type === 'tool/call' && event.data?.name === 'write')
            assert(secondWriteCalls.length === 1,
              `WP-11 the post-re-enable turn persisted ${String(secondWriteCalls.length)} official write tool calls, expected exactly 1`)
            const secondWriteArgs = JSON.parse(secondWriteCalls[0].data.arguments)
            assert(JSON.stringify(secondWriteArgs) === JSON.stringify({ file_path: 'changed2.txt', content: `w5-change2-${changesNonce}\n` }),
              `WP-11 the second write tool arguments drifted: ${JSON.stringify(secondWriteArgs)}`)
            const secondWriteResults = secondTurnEvents.filter(event => event.type === 'tool/result'
              && event.data?.message?.toolCallId === secondWriteCalls[0].data.callId)
            assert(secondWriteResults.length === 1,
              `WP-11 the second write tool call settled ${String(secondWriteResults.length)} times, expected exactly 1`)
            assert(secondWriteResults[0].data.message.isError === false,
              'WP-11 the second official write tool result reports an error')
            assert(secondWriteResults[0].seq > secondWriteCalls[0].seq && secondEvent.seq > secondWriteResults[0].seq,
              'WP-11 the post-re-enable workspace/changes event does not follow the successful write tool result')
            const secondCoordinates = new URLSearchParams({ sessionId: wp11Session, seq: String(wp11Seq2) })
            const secondSummary = await fetchStatus(`${wp11.ready.localHost.origin}/api/changes.summary?${secondCoordinates}`,
              { headers: { cookie: index11.cookie } })
            assert(secondSummary.status === 200,
              `WP-11 the post-re-enable summary route returned HTTP ${String(secondSummary.status)}`)
            const secondSummaryBody = JSON.parse(secondSummary.body)
            assert(secondSummaryBody.total === 1 && secondSummaryBody.files.length === 1
              && secondSummaryBody.files[0].path === 'changed2.txt',
            `WP-11 the post-re-enable summary is not the one new file: ${JSON.stringify(secondSummaryBody.files)}`)
            const secondDiff = await fetchStatus(`${wp11.ready.localHost.origin}/api/changes.diff?${secondCoordinates}&index=0`,
              { headers: { cookie: index11.cookie } })
            assert(secondDiff.status === 200,
              `WP-11 the post-re-enable comparison route returned HTTP ${String(secondDiff.status)}`)
            const secondDiffBody = JSON.parse(secondDiff.body)
            assert(secondDiffBody.kind === 'text'
              && secondDiffBody.hunks.flatMap(hunk => hunk.lines).some(line => line.includes(`w5-change2-${changesNonce}`)),
            'WP-11 the post-re-enable comparison does not serve the new change')
            const secondHostBytes = readFileSync(join(wp11Cwd, 'changed2.txt'))
            assert(secondHostBytes.toString('utf8') === `w5-change2-${changesNonce}\n`,
              'WP-11 the new Host file does not hold the second written content')
            assert((await fetchStatus(summaryUrl, { headers: { cookie: index11.cookie } })).status === 404,
              'WP-11 the pre-disable summary came back after the new Turn')
            // The retained, redacted WP-11 evidence record: no prompt text, no
            // Cookie, no launch token and no absolute private path (the cwd is a
            // digest only).
            evidence.fact('wp11-official-web-capabilities', 'web-capabilities', {
              hostPid: wp11.ready.pid,
              hostInstanceIdDigest: sha16(wp11.ready.localHost.instanceId),
              sessionId: wp11Session,
              otherSession,
              workspace: 'dedicated-w5-changed-files',
              cwdDigest: sha16(wp11Cwd),
              changesEvent: { turn: wp11Turn, seq: wp11Seq },
              summary: { status: summary.status, turn: summaryBody.turn, total: summaryBody.total, files: summaryBody.files.map(file => file.path) },
              diff: { status: diff.status, kind: wp11Diff.kind, hunks: wp11Diff.hunks.length },
              anonymousSummaryStatus: anonymous.status,
              webRows: { workspaceChanges: 'active', uiDeliverables: 'active' },
              download: wp11Download,
              quote: {
                quoteNodes: draft.quoteNodes,
                markdownDraft: draft.markdownDraft,
                userMessagesBeforeSend: userCountBeforeQuote,
                quotedUserMessages: quotedWrites.length,
              },
              fileNegative: { downloadStarted: fileNegative.downloadStarted, rows: fileNegative.rows },
              copyImage: {
                type: copied.type,
                bytes: copied.bytes,
                sha256: copied.sha256,
                sourceSha256: shotHash,
                width: copied.width,
                height: copied.height,
                pixelSha256: copied.pixelSha256,
                pixelsEqual: copied.pixelsEqual,
              },
              copyNegative: { failureFeedback: copyNegative.failureFeedback, cause: copyNegative.cause },
              noChange,
              toggle: {
                staleSummary404: staleOnSameHost.status,
                staleDiff404: staleDiffSameHost.status,
                disabledRowsReleased: true,
                reenabledRowsActive: true,
                secondChange: { turn: wp11Turn2, seq: wp11Seq2, files: ['changed2.txt'] },
              },
            })
            recordSession('wp11-official-web-capabilities', wp11Session)
            await ptyFrames('wp11-capabilities', tuiW)
            trace('t75-web-product-wp11', {
              sessionId: wp11Session,
              otherSession,
              turn: wp11Turn,
              seq: wp11Seq,
              cwdDigest: sha16(wp11Cwd),
              download: { bytes: wp11Download.bytes, sha256: wp11Download.sha256 },
              copyImage: { bytes: copied.bytes, sha256: copied.sha256 },
              copyDeniedFeedback: copyNegative.failureFeedback,
              secondChange: { turn: wp11Turn2, seq: wp11Seq2 },
              diffKind: wp11Diff.kind,
              workspaceChanges: 'active',
              uiDeliverables: 'active',
            })
          })

          // The real TUI has proven the product enable; dispose it BEFORE the
          // Host stop so no Client owns a live surface across the restart.
          try { await tuiW.dispose() } catch { /* the global backstop owns leftovers */ }
          // Stale coordinates after a REAL Host restart: the old summary/diff
          // must be unavailable, and the new Host must never replay the content.
          const stop = await wp11.host.shutdown()
          assert(stop.code === 0, 'WP-11 the first qualification Host did not stop normally')
          wp11Next = await startHost('web-workspace-changes', 'wp11-restart', { C1_CHANGES_NONCE: changesNonce })
          wp11Peer = await startPeer('WP-11 restart peer')
          assertToggle(await webAccess(wp11Peer, 'WP-11 restart', true), 'enabled', 'WP-11 restart webAccess')
          const restartFacts = await readHostWebIndex(wp11Next.ready.localHost.origin, launchOf(wp11Next.ready), 'WP-11 restart')
          assertWebIndexQualified(restartFacts, 'WP-11 restart', targetDshVersion)
          const coordinates = new URLSearchParams({ sessionId: wp11Session, seq: String(wp11Seq) })
          const staleSummary = await fetchStatus(`${wp11Next.ready.localHost.origin}/api/changes.summary?${coordinates}`,
            { headers: { cookie: restartFacts.cookie } })
          assert(staleSummary.status === 404,
            `WP-11 a restarted Host served the old summary (HTTP ${String(staleSummary.status)})`)
          const staleDiff = await fetchStatus(`${wp11Next.ready.localHost.origin}/api/changes.diff?${coordinates}&index=0`,
            { headers: { cookie: restartFacts.cookie } })
          assert(staleDiff.status === 404,
            `WP-11 a restarted Host served the old comparison (HTTP ${String(staleDiff.status)})`)
          for (const body of [staleSummary.body, staleDiff.body]) {
            assert(!body.includes(`w5-change-${changesNonce}`),
              'WP-11 a restarted Host replayed content it no longer owns')
          }
          evidence.fact('wp11-restart', 'stale-coordinates', {
            summary: staleSummary.status,
            diff: staleDiff.status,
            replayRefused: true,
          })
          trace('t75-web-product-wp11-stale', {
            summary: staleSummary.status,
            diff: staleDiff.status,
            replayRefused: true,
          })
        } finally {
          if (tuiW !== undefined && !tuiW.exited) { try { await tuiW.dispose() } catch { /* best effort */ } }
          if (wp11Peer !== undefined && !wp11Peer.exited) { try { await wp11Peer.shutdown() } catch { /* best effort */ } }
          if (wp11Next !== undefined && !wp11Next.host.exited) { try { await wp11Next.host.shutdown() } catch { /* best effort */ } }
          if (!wp11.host.exited) { try { await wp11.host.shutdown() } catch { /* best effort */ } }
        }
      }

      for (const client of clients.splice(0)) {
        if (client.exited) continue
        try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
      }
    }

    // The evidence writer's final status is deliberately explicit: WP-11's
    // real Tern GUI half is a product-composition blocker, not a PASS.
    evidence.setTernGui({
      status: 'DEFERRED_WITH_OWNER',
      reason: 'the TSP `/web` picker is mounted only by the Direct renderer selection, while the Host WebAccessPort is composed only by the Split Host-only overlay; the current product boundary has no real Tern GUI path to the same serving Host',
      ownerApproval: 'Owner explicitly selected DEFERRED_WITH_OWNER for WP-11/WC-12 in the PR-D session on 2026-11-05',
      responsible: 'M5-W owner',
      reentry: 'when a composition change lets the TSP/Tern GUI reach the same serving Host WebAccessPort',
    })
    const browserSubsetPassed = Object.entries(wc)
      .filter(([code]) => code !== 'WC-12')
      .every(([, entry]) => entry.status === 'PASS')
    const allPassed = Object.values(wc).every(entry => entry.status === 'PASS')
    const ownerDeferredOnly = Object.entries(wc).every(([code, entry]) => entry.status === 'PASS'
      || (code === 'WC-12' && entry.status === 'DEFERRED_WITH_OWNER'))
    // Plan §15/§19: ANY MUST `BLOCKED/NOT_RUN` forbids declaring the PR-D
    // product qualification complete. WC-12 includes the real Tern GUI gate
    // (§12), now explicitly DEFERRED_WITH_OWNER; the overall status records
    // that deferral, while the Browser×TUI subset it actually ran is separate.
    const finalStatus = allPassed ? 'PASS'
      : browserSubsetPassed && ownerDeferredOnly ? 'DEFERRED_WITH_OWNER'
        : browserSubsetPassed ? 'BLOCKED' : 'INCOMPLETE'
    const browserSubset = browserSubsetPassed ? 'PASS' : 'FAIL'
    evidence.finish({ status: finalStatus, browserSubset, wc, browserCases: browserRun })
    trace('t75-web-product', {
      status: finalStatus,
      browserSubset,
      cases: browserRun,
      wc,
      hostPid: groupA.ready.pid,
      ternGui: 'DEFERRED_WITH_OWNER: no real Tern GUI path to the Split Host WebAccessPort in the current composition; Owner-approved on 2026-11-05',
    })
    return { status: finalStatus, browserSubset, wc }
  } finally {
    await cleanup()
  }
}