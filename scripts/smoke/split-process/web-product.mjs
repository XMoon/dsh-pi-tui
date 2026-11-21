/**
 * M5-W PR-D / S5-PR5 product Browser-by-real-TUI qualification (T75/WP-01..WP-11).
 *
 * This module owns the complete product composite: the single Group-A Host,
 * the per-case isolated Host scenes and the real Chromium driver runs. The
 * Browser driver remains `scripts/fixtures/m5-web-product-browser.mjs`; this
 * module never stubs it.
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
  fetchStatus,
  hostStatus,
  lastSurfaceStatus,
  readJson,
  readProcessFacts,
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
import { runOwnedDetachedDriver } from '../../lib/owned-browser-driver.mjs'
import {
  assertWebIndexQualified,
  browserDriverExitBounded,
  readDeclaredWebRows,
  readHostWebIndex,
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
    ternGui: { status: 'NOT_VERIFIED', reason: 'the real Tern GUI/TSP native gesture path is outside this qualification' },
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
      settingsPersistence() {},
      finish() {},
    }
  }
  const dir = state.dir
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`the product evidence directory must be new/empty: ${dir}`)
  }
  for (const sub of ['browser', 'host', 'client', 'tern-gui']) {
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
    settingsPersistence(result) {
      write('web-settings-persistence.json', result)
    },
    passedCaseIds() {
      return state.ledger.filter(entry => entry.status === 'PASS').map(entry => entry.case)
    },
    finish(extra = {}) {
      write('run-ledger.json', { schema: 1, startedAt: state.startedAt, endedAt: new Date().toISOString(), cases: state.ledger, ...extra })
      write('manifest.json', manifest(extra))
      writeText('README-qualification.md', [
        '# Browser × Split Host/TUI differential qualification evidence',
        '',
        `- candidate: \`${String(state.candidate)}\``,
        `- candidate SHA256: \`${String(state.candidateSha256)}\``,
        `- DSH: \`${String(state.dshVersion)}\``,
        `- Playwright: \`${String(state.playwright)}\`, Chromium: \`${String(state.chromium)}\``,
        '- Browser: real Playwright Chromium (headless); TUI: real PTY; Host: the installed candidate\'s Split Host',
        '',
        'This run reproduces the current Browser × Split differential subset: one packed official',
        'Web Browser and a real Split TUI sharing one Host, competing writes, stale refusals,',
        'crash recovery, the same-Host Web toggle and three-way file locality. It is not an',
        'inventory of every official Web UI feature and does not claim the real Tern GUI.',
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
        '## Not covered',
        '',
        `- real Tern GUI/TSP native gesture path: ${state.ternGui.status} - ${state.ternGui.reason}`,
        '- OS physical input and an OS accessibility bridge: NOT_VERIFIED (control-injected input only).',
        '- Browser Cookie revocation after `/web Disable`: NOT a product contract and not tested.',
        '- Browser-only ACL/multi-user/remote network exposure: not claimed.',
        '- Official Web page-only menus, clipboard, quote and feature inventories retired by the test-consolidation plan: not claimed.',
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
  // The packed candidate's current Web declaration. Every live OFF/ON check
  // below still reads the Host status entries separately; this only says what
  // the installed bundle declares before the case starts.
  const declaredWebRows = readDeclaredWebRows(profilePackage)
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
  evidence.setTernGui({
    status: 'NOT_VERIFIED',
    reason: 'the real Tern GUI/TSP native gesture path is outside this Browser × Split product subset and was not run',
  })
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
    evidence.setTernGui({ status: 'NOT_VERIFIED', reason: 'the product qualification was not required in this run' })
    evidence.finish({ status: 'NOT_RUN', browserSubset: 'NOT_RUN' })
    return { status: 'NOT_RUN', browserSubset: 'NOT_RUN' }
  }
  assert(playwrightRoot !== undefined && playwrightRoot !== '',
    'PR-D the product Browser qualification is REQUIRED (selected Web case or SPLIT_PROCESS_REQUIRE_WEB_PRODUCT=1) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the product proof')
  assert(existsSync(join(playwrightRoot, 'node_modules', 'playwright', 'package.json')),
    `PR-D SPLIT_PROCESS_PLAYWRIGHT_ROOT has no pinned Playwright install: ${playwrightRoot}`)
  const browsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
  assert(existsSync(browsers), `PR-D the Playwright browser install is missing: ${browsers}`)
  // The Linux Chromium needs the extra shared libraries the pinned install
  // ships beside it; a Darwin Chromium links its own frameworks and takes no
  // LD_LIBRARY_PATH (setting one there is inert at best).
  const linuxLibs = process.platform === 'linux'
    ? process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
    : undefined
  const driverPath = join(SCRIPT_DIR, 'fixtures', 'm5-web-product-browser.mjs')
  assert(existsSync(driverPath), 'PR-D the product Browser driver is missing')
  const driverEnv = {
    ...env,
    M5_WEB_DSH_HOME: dshHome,
    M5_WEB_PLAYWRIGHT_ROOT: playwrightRoot,
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    ...(linuxLibs === undefined
      ? {}
      : { LD_LIBRARY_PATH: `${linuxLibs}${process.env.LD_LIBRARY_PATH === undefined ? '' : `:${process.env.LD_LIBRARY_PATH}`}` }),
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
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: '${documentsDirectory}'`,
    '',
  ].join('\n'), { mode: 0o600 })
  chmodSync(productPatch, 0o600)

  /** The durable events of one Session (empty before its first write). */
  const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  /** One offline model request record per call (the fixture's model-facing sink). */
  const promptEvidence = () => {
    const text = readFileSync(context.installation.surfaceLlm.promptEvidencePath, 'utf8').trim()
    return text === '' ? [] : text.split('\n').map(line => JSON.parse(line))
  }
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
    if (webScopeId !== undefined) await seatFree(`\0dsh-pi-tui-h-${webScopeSuffix}`, 15_000, { scopeId: webScopeId })
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
    // Linux spells the seat name with a 40-char scope suffix; Darwin holds the
    // seat as an `O_EXLOCK` file keyed by the FULL scope id. Keep both so the
    // platform-aware `seatFree` can observe the real claim on either OS.
    if (webScopeId === undefined) webScopeId = ready.localHost.scopeId
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
      'sessionController', 'fileUpload', 'settingsController', 'jobController', 'piTuiHostRuntime', 'cordisInspectProviders']) {
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
  /** The canonical Host-neutral mention dropped into a real TUI/Browser draft. */
  const canonicalSessionMention = sessionId =>
    `@[r](dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')})`
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
  /** One real TUI prompt citing a canonical session reference. */
  const tuiReferenceTurn = async (tui, sessionId, targetSessionId, marker, label) => {
    const boundary = durableOf(sessionId).length
    tui.send(`${canonicalSessionMention(targetSessionId)} ${marker}\r`)
    await tui.waitForScreen(marker, `${label} prompt painted`, 120_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, boundary,
      event => event.type === 'user/message' && JSON.stringify(event).includes(marker),
      `${label} user/message`, 180_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, boundary,
      event => event.type === 'turn/end', `${label} turn/end`, 180_000)
    return boundary
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
    const live = declaredWebRows
      .map(row => [row.id, (ready.entries ?? []).find(entry => entry.id === row.id)?.state])
      .filter(([, state]) => state !== 'absent' && state !== 'state-4')
    assert(live.length === 0, `the Web rows are not plainly off: ${live.map(([id, state]) => `${id}:${state ?? 'missing'}`).join(',')}`)
  }
  // EVERY declared Web row must be active: S5-PR5 removed the tolerated
  // `ui-deliverables` PENDING state now that the Host mounts `workspace-changes`.
  const webFullyOn = ready => {
    const notActive = declaredWebRows
      .map(row => [row.id, (ready.entries ?? []).find(entry => entry.id === row.id)?.state])
      .filter(([, state]) => state !== 'active')
    assert(notActive.length === 0, `the Web rows are not active: ${notActive.map(([id, state]) => `${id}:${state ?? 'missing'}`).join(',')}`)
  }
  let browserRun = 0
  let webScopeId
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
        `PR-D ${caseId}: the product Browser result is not a completed PASS (${redactWebQualificationText(String(report.error ?? 'no error'))})`)
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

    // M6 PR-A (A1-W01/W02): the REAL first-run Welcome acknowledgement and the
    // Appearance theme write must land in the official USER Profile and be read
    // back after a reload. This is the profile-writable contract the generated
    // bundle roster exists for; an overlay-supplied welcome version would mask
    // it, so this case deliberately leaves `ui-settings-general` unwritten.
    const settingsDriverPath = join(SCRIPT_DIR, 'fixtures', 'm6-web-settings-browser.mjs')
    assert(existsSync(settingsDriverPath), 'PR-A the Web settings persistence driver is missing')
    const settingsResultPath = join(browserRoot, `web-settings-${String(++browserRun)}.json`)
    /** Own the detached driver + Chromium group on EVERY exit path. */
    let settingsOut = ''
    let settingsErr = ''
    const settingsRun = await runOwnedDetachedDriver({
      command: process.execPath,
      args: [settingsDriverPath, settingsResultPath],
      options: {
        cwd: workDir,
        env: {
          ...driverEnv,
          M6_DSH_HOME: dshHome,
          M6_PROFILE_PATCH: join(dshHome, 'profiles', base.profile, 'cordis.patch.yml'),
          M6_PLAYWRIGHT_ROOT: playwrightRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      timeoutMs: 300_000,
      cleanupMs: 15_000,
      bounded: browserDriverExitBounded,
      tag: 'PR_A_WEB_SETTINGS',
      onSpawn(child) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => { settingsOut = `${settingsOut}${chunk}`.slice(-8_192) })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', chunk => { settingsErr = `${settingsErr}${chunk}`.slice(-8_192) })
      },
    })
    const settingsFinished = settingsRun.finished
    const settingsResult = existsSync(settingsResultPath) ? readJson(settingsResultPath) : {}
    assert(settingsFinished.code === 0,
      `PR-A the real Browser settings witness failed (exit ${JSON.stringify(settingsFinished.code)}/${String(settingsFinished.signal)}): ${redactWebQualificationText(`${settingsErr}${settingsOut}${String(settingsResult.error ?? '')}`)}`)
    for (const fact of ['welcomeVisible', 'welcomePersisted', 'welcomeStayedHiddenAfterReload', 'themePersisted', 'themeStayedSelectedAfterReload']) {
      assert(settingsResult[fact] === true, `PR-A the real Browser settings witness did not prove ${fact}`)
    }
    evidence.settingsPersistence(settingsResult)
    trace('t75-web-product-settings-persistence', settingsResult)

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
      const armed = await handle.waitFact('session-reference-armed', 'WP-01 session-reference armed', 240_000)
      const referenceEvidenceStart = promptEvidence().length
      handle.signal('session-reference-send')
      const wiring = await handle.waitFact('rc5-host-wiring', 'WP-01 rc.5 Host wiring', 240_000)
      assert(wiring.inventoryModule === '@deepseek-ai/dsh-client-connection'
        && wiring.enabled !== false && wiring.inventoryPhase === 'active'
        && wiring.feedback === 'positive',
      `WP-01 the Browser did not report the rc.5 Host wiring facts: ${JSON.stringify(wiring)}`)
      const reference = handle.readFact('session-reference')
      assert(reference.candidatesStatus === 200 && typeof reference.siblingId === 'string'
        && reference.siblingId === armed.siblingId
        && reference.siblingId !== browserSession.sessionId
        && reference.selectedFromCandidates === true,
      `WP-01 the Browser did not select a real session-reference candidate: ${JSON.stringify(reference)}`)
      assert(wiring.sessionReference === true && wiring.referenceMarker === reference.marker,
        `WP-01 the session-reference fact does not match the wiring report: ${JSON.stringify({ wiring, reference })}`)
      await waitForHostSessionEventAfter(dshHome, browserSession.sessionId, 0,
        event => event.type === 'user/message' && JSON.stringify(event).includes(reference.marker),
        'WP-01 canonical session-reference user/message', 120_000)
      const referenceDeadline = Date.now() + 120_000
      let referenceReached = false
      let referenceRecords = []
      while (Date.now() < referenceDeadline) {
        referenceRecords = promptEvidence().slice(referenceEvidenceStart)
        if (referenceRecords.some(record => record.referencedSessions === true)) {
          referenceReached = true
          break
        }
        await sleep(250)
      }
      assert(referenceReached,
        `WP-01 canonical session reference reaches the Host model input: ${JSON.stringify(referenceRecords.slice(-4))}`)
      const feedbackEvents = durableOf(browserSession.sessionId)
        .filter(event => event.type === 'feedback/message-put')
      assert(feedbackEvents.length === 1,
        `WP-01 the message-feedback write produced ${feedbackEvents.length} Host events, expected exactly 1`)
      const feedbackItem = feedbackEvents[0].data?.item
      assert(feedbackItem?.rating === 'positive' && feedbackItem?.category === 'task-result',
        `WP-01 the Host feedback item does not match the Browser action: ${JSON.stringify(feedbackItem)}`)
      assert(typeof feedbackItem?.messageId === 'string' && feedbackItem.messageId !== '',
        'WP-01 the Host feedback event carries no message identity')
      const assistantEvents = durableOf(browserSession.sessionId).filter(event => event.type === 'assistant/message')
      assert(assistantEvents.some(event => JSON.stringify(event).includes(feedbackItem.messageId)),
        'WP-01 the feedback message id does not identify an assistant message in the same Session log')
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

    // WP-02 baseline: a TUI-created Session A provides the independent-view
    // comparison Session. The retired Browser open-existing demo is covered by
    // WP-02B's Browser-created Session and the authoritative Host writer.
    const sessionA = await tuiNewSession(groupTui, 'WP-02 baseline')
    const markerA = `T-${productNonce}-a`
    await tuiTurn(groupTui, sessionA, markerA, 'WP-02 baseline')
    await waitForHostSessionHeader(dshHome, sessionA, 'WP-02 baseline Session header')

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

    // WP-06: one real TUI SIGKILL leaves the Browser writing the SAME Session;
    // a fresh TUI resumes it. Client reload/normal exit permutations belong to
    // the Split recovery Owner and are not repeated here.
    const sessionLife = await tuiNewSession(groupTui, 'WP-06')
    const lifeSeed = `L-${productNonce}-seed`
    await tuiTurn(groupTui, sessionLife, lifeSeed, 'WP-06 seed')
    const lifeMarker = `L-${productNonce}-after-sigkill`
    await browserCase('wp06-tui-lifecycle', {
      sessionId: sessionLife,
      marker: lifeMarker,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('ready', 'WP-06 Browser ready', 240_000)
      const tuiPid = groupTui.records.filter(record => record.m4a0 === 'ready').at(-1)?.pid
      assert(Number.isInteger(tuiPid) && alive(tuiPid), 'WP-06 the TUI published no business PID')
      groupTui.signalBusiness('SIGKILL')
      await waitGone(tuiPid, 15_000)
      await groupTui.dispose()
      handle.signal('tui-killed')
      await handle.waitFact('browser-wrote-after-tui-kill', 'WP-06 Browser write after the TUI SIGKILL', 300_000)
      await waitForHostSessionEventAfter(dshHome, sessionLife, 0,
        event => event.type === 'user/message' && JSON.stringify(event).includes(lifeMarker),
        'WP-06 Browser prompt after the TUI SIGKILL', 180_000)
      await waitForHostSessionEventAfter(dshHome, sessionLife, 0,
        event => event.type === 'turn/end', 'WP-06 Browser turn after the TUI SIGKILL', 180_000)
      const { tui: freshTui } = await startTui('WP-06 fresh TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
      await freshTui.waitForScreen(lifeSeed, 'WP-06 fresh TUI reads the durable seed', 180_000)
      await freshTui.waitForScreen(lifeMarker, 'WP-06 fresh TUI reads the Browser write', 180_000)
      assert(typeof lastSurfaceStatus(freshTui)?.generationId === 'number', 'WP-06 the fresh TUI published no transport generation')
      handle.signal('fresh-tui-resumed')
      groupTui = freshTui
    })
    assert(userEvents(sessionLife, lifeMarker).length === 1,
      'WP-06 the Browser Turn after the TUI SIGKILL was not committed once')
    recordSession('wp06-tui-lifecycle', sessionLife)
    await ptyFrames('wp06-tui-lifecycle', groupTui)

    // WP-08: the TUI keeps working across Web ON -> OFF -> ON, and the
    // canonical session-reference pre-step disappears with Web off and comes
    // back with the SAME Host process. Browser page/recompose permutations
    // belong to `web.runtime-toggle`.
    const sessionToggle = await tuiNewSession(groupTui, 'WP-08')
    await tuiTurn(groupTui, sessionToggle, `W-${productNonce}-seed`, 'WP-08 seed')
    const referenceOnBefore = promptEvidence().length
    await tuiReferenceTurn(groupTui, sessionToggle, sessionLife,
      `W-${productNonce}-ref-before-off`, 'WP-08 reference before off')
    assert(promptEvidence().slice(referenceOnBefore).some(record => record.referencedSessions === true),
      'WP-08 the enabled Web composition did not inject the canonical session reference into the model input')
    const toggleIdentity = (await hostStatus(groupA.host)).localHost
    await disableWeb(groupTui, 'WP-08')
    const off = await hostStatus(groupA.host)
    webFullyOff(off)
    assertIdentityFields(off.localHost, toggleIdentity, 'WP-08 disable kept the Host identity')
    const root = await fetchStatus(`${groupA.ready.localHost.origin}/`)
    assert(root.status === 404, `WP-08 the disabled Host still serves the Web root (HTTP ${root.status})`)
    await tuiTurn(groupTui, sessionToggle, `W-${productNonce}-tui-while-off`, 'WP-08 TUI while off')
    const sessionOffReference = await tuiNewSession(groupTui, 'WP-08 off reference')
    const referenceOffBefore = promptEvidence().length
    await tuiReferenceTurn(groupTui, sessionOffReference, sessionLife,
      `W-${productNonce}-ref-while-off`, 'WP-08 reference while off')
    const referenceOffRecords = promptEvidence().slice(referenceOffBefore)
    assert(referenceOffRecords.length > 0 && referenceOffRecords.every(record => record.referencedSessions !== true),
      'WP-08 the Web-off Host still injected a session-reference context from a disposed listener')
    await enableWeb(groupTui, 'WP-08 re-enable')
    const reenabled = await hostStatus(groupA.host)
    webFullyOn(reenabled)
    assertIdentityFields(reenabled.localHost, toggleIdentity, 'WP-08 re-enable kept the Host identity')
    const referenceOnAgain = promptEvidence().length
    await tuiReferenceTurn(groupTui, sessionOffReference, sessionLife,
      `W-${productNonce}-ref-after-on`, 'WP-08 reference after re-enable')
    assert(promptEvidence().slice(referenceOnAgain).some(record => record.referencedSessions === true),
      'WP-08 the re-enabled Web composition did not restore the session-reference listener')
    recordSession('wp08-web-toggle', sessionToggle)
    await ptyFrames('wp08-web-toggle', groupTui)

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
    // This case qualifies Client-local image intake through the prompt path.
    // Generic-file `/attach` has its own official Host upload-receipt proof in
    // `surface.generic-file-upload-f4`; it is not exercised by this image case.
    const tuiImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
    const tuiImagePath = join(tuiCwd, 'tui-local-image.png')
    writeFileSync(tuiImagePath, tuiImageBytes, { mode: 0o600 })
    const tuiPath = join(tuiCwd, 'bin')
    mkdirSync(tuiPath, { recursive: true, mode: 0o700 })
    const tuiPathValue = `${tuiPath}:${base.env.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`
    // The REAL TUI process gets its OWN cwd, HOME and PATH; the Host keeps
    // base.cwd/base home/PATH. The locality assertions must compare the real
    // process facts, not two directories that were only created.
    const { tui: tuiLocal, ready: tuiLocalReady } = await startTui('WP-09 Client-local TUI', {
      HOME: tuiHome,
      PATH: tuiPathValue,
      SPLIT_PROCESS_CLIENT_SESSION: sessionToggle,
      SPLIT_PROCESS_SCRATCH: join(productRoot, 'client-local-scratch'),
    }, { cwd: tuiCwd })
    assert(tuiLocalReady.sessionOpen === true && tuiLocalReady.openSessionId === sessionToggle,
      'WP-09 the Client-local TUI must open the exact Host Session before its painted history is checked')
    assertClientHostFacts(tuiLocalReady.host, toggleIdentity, 'WP-09 Client-local TUI Host identity')
    // The cold surface follows the transcript tail. WP-08 has committed the
    // toggle/reference turns, so its original seed can already be outside the
    // visible viewport. The latest marker was independently verified in the
    // Host log above.
    await tuiLocal.waitForScreen(`W-${productNonce}-tui-while-off`, 'WP-09 Client-local TUI reads the Session', 180_000)
    const browserUploadMarker = `w-${productNonce}-browser-upload`
    let hostShellFact
    await browserCase('wp09-locality', {
      sessionId: sessionToggle,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('upload', 'WP-09 Browser upload', 240_000)
      hostShellFact = await handle.waitFact('host-shell', 'WP-09 Host terminal command', 240_000)
    })
    // The HOST is the authority: the Browser's upload must be ONE durable
    // user message carrying this run's marker AND its file attachment before
    // any transcript assertion is trusted. A Browser driver that never really
    // submitted (or submitted without the file) fails here with a precise
    // fact instead of a 180s display timeout.
    const browserAttachmentMarker = `wp09 attachment ${productNonce}`
    await waitForCondition(() => durableOf(sessionToggle).some(event => event.type === 'user/message'
      && JSON.stringify(event).includes(browserAttachmentMarker)
      && JSON.stringify(event).includes('browser-local-sentinel.txt')),
    'WP-09 Host durable Browser attachment message', 120_000)
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
    // through the client clipboard policy and never reaches the Host.
    //
    // The OBSERVABLE channel differs by driver and neither is a weaker claim:
    // both read the SAME product fact (the copied text reached its sink).
    // Linux owns the Client's real byte stream, so the OSC 52 sequence is
    // visible there. A Darwin pane is a REAL terminal: it consumes the escape,
    // and the product's tmux leg leaves the text in the pane's own buffer.
    // The Linux byte window must start BEFORE the command is sent.
    const rawBeforeCopy = tuiLocal.raw.length
    tuiLocal.send('/copy\r')
    if (process.platform === 'darwin') {
      // The pane consumes the escape sequence, so the product's tmux leg is the
      // observable: it must carry the REAL last answer, not just any buffer.
      const lastAnswer = durableOf(sessionToggle)
        .filter(event => event.type === 'assistant/message')
        .map(event => JSON.stringify(event.data?.content?.map(block => block?.text ?? '').join('') ?? ''))
        .at(-1)
      assert(typeof lastAnswer === 'string' && lastAnswer !== '',
        'WP-09 the Host Session records no assistant message to copy')
      await waitForCondition(async () => (await tuiLocal.clipboardText() ?? '').includes(JSON.parse(lastAnswer)),
        'WP-09 Client-local clipboard export', 30_000)
    } else {
      await waitForCondition(() => tuiLocal.raw.slice(rawBeforeCopy).includes('\u001b]52;'),
        'WP-09 Client-local clipboard export', 30_000)
    }
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
    // Read the REAL process facts from the OS (Linux /proc, Darwin lsof+ps):
    // the TUI's own cwd/HOME/PATH and the Host's own cwd/HOME/PATH. Creating
    // tuiCwd/tuiHome is not isolation.
    const tuiPid = tuiLocal.records.filter(record => record.m4a0 === 'ready').at(-1)?.pid
    assert(Number.isInteger(tuiPid) && tuiPid > 0, 'WP-09 the TUI published no business PID')
    const tuiFacts = readProcessFacts(tuiPid)
    const hostFacts = readProcessFacts(groupA.ready.pid)
    const tuiCwdActual = tuiFacts.cwd
    const hostCwdActual = hostFacts.cwd
    const tuiEnvActual = tuiFacts.env
    const hostEnvActual = hostFacts.env
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
    assert(typeof localityHeader.cwd === 'string' && !localityHeader.cwd.startsWith(realpathSync(tuiCwd)),
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
    recordSession('wp09-locality', sessionToggle)
    await ptyFrames('wp09-locality', tuiLocal)

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

    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!questionGroup.host.exited) {
      try { await questionGroup.host.shutdown() } catch { /* the global backstop owns leftovers */ }
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
    })

    const approvalReject = await runApprovalGroup('approval-reject', async ({ group, tui, sessionFor }) => {
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
        const decisionBoundary = durableOf(sessionId).length
        tui.send('n')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04E the legal reject settled', 120_000)
        // The fixture record is emitted before the official durable decision
        // can be observed. Wait for the Host's own approval/decided event so a
        // later read cannot attribute the legal decision to the stale frame.
        await waitForHostSessionEventAfter(dshHome, sessionId, decisionBoundary,
          event => event.type === 'approval/decided' && event.data?.outcome === 'rejected',
          'WP-04E legal rejected decision durable', 120_000)
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
    assert(approvalAllow !== undefined && approvalReject !== undefined, 'WP-04 groups did not complete')

    // ── Group E: WP-07 Host SIGKILL and cold resume ──────────────────────
    {
      const lifecycle = await startHost('long-turn', 'wp07', { C1_HOLD_LONG_TURN: fastBarrier })
      const { tui } = await startTui('wp07')
      await enableWeb(tui, 'WP-07')
      const sessionLife = await tuiNewSession(tui, 'WP-07 new Session')
      const seedMarker = `H-${productNonce}-host-life`
      await tuiTurn(tui, sessionLife, seedMarker, 'WP-07 seed')
      const lifecyclePeer = await startPeer('WP-07')
      const savedOn = await webPreference(lifecyclePeer, 'WP-07 autoStart On', true)
      assert(savedOn.ok === true && savedOn.readBack === true, 'WP-07 the autoStart On write did not read back')
      await lifecyclePeer.shutdown()
      const beforeKill = (await hostStatus(lifecycle.host)).localHost
      let wp07Next
      const hostMarker = `H-${productNonce}-after-host-kill`
      await browserCase('wp07-host-lifecycle', {
        sessionId: sessionLife,
        seedMarker,
        marker: hostMarker,
        expectedAnswer: 'long-turn answer',
      }, async handle => {
        await handle.waitFact('ready', 'WP-07 Browser ready', 240_000)
        const oldInstance = beforeKill.instanceId
        lifecycle.host.kill('SIGKILL')
        const killed = await lifecycle.host.waitForExit(60_000)
        assert(killed.signal === 'SIGKILL' || killed.code !== 0,
          `WP-07 the SIGKILL Host exit was ${JSON.stringify(killed)}`)
        const staleInstance = readJson(join(dshHome, 'run', 'dsh-pi-tui', beforeKill.scopeId, 'instance.json'))
        assert(staleInstance.instanceId === oldInstance,
          'WP-07 the SIGKILL left no stale identity for the negative control')
        handle.signal('host-killed')
        await handle.waitFact('host-killed', 'WP-07 Browser observed the Host SIGKILL', 300_000)
        wp07Next = await startHost('long-turn', 'wp07-next', { C1_HOLD_LONG_TURN: fastBarrier })
        assert(wp07Next.ready.localHost.instanceId !== oldInstance,
          'WP-07 a cold-started Host reused the killed instance id')
        webFullyOn(wp07Next.ready)
        assertSingleHostOwners(await hostStatus(wp07Next.host), 'WP-07 cold-resumed Host')
        handle.signal('new-host-ready')
        await handle.waitFact('browser-reconnected', 'WP-07 Browser reconnected after the Host SIGKILL', 300_000)
        await handle.waitFact('browser-wrote-after-reconnect', 'WP-07 Browser wrote after the reconnect', 300_000)
        await waitForHostSessionEventAfter(dshHome, sessionLife, 0,
          event => event.type === 'user/message' && JSON.stringify(event).includes(hostMarker),
          'WP-07 Browser prompt after cold resume', 180_000)
        await waitForHostSessionEventAfter(dshHome, sessionLife, 0,
          event => event.type === 'turn/end', 'WP-07 Browser turn after cold resume', 180_000)
      })
      assert(userEvents(sessionLife, hostMarker).length === 1,
        'WP-07 the Browser Turn after cold resume was not committed once')
      recordSession('wp07-host-lifecycle', sessionLife)
      if (wp07Next !== undefined && !wp07Next.host.exited) {
        const stop = await wp07Next.host.shutdown()
        assert(stop.code === 0, 'WP-07 the cold-resumed Host did not stop before the pending case')
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
        } finally {
          try { await pendingTui.dispose() } catch { /* best effort */ }
          if (!pending.host.exited) { try { await pending.host.shutdown() } catch { /* best effort */ } }
          if (pendingNext !== undefined && !pendingNext.host.exited) {
            try { await pendingNext.host.shutdown() } catch { /* best effort */ }
          }
        }
      }
      // ── Group W: WP-11 official Host changed-files chain ───────────────
      // One real Host, one real PTY TUI and one real Chromium prove the
      // official write -> workspace/changes -> summary/diff sink, the
      // no-change negative and the same-Host Web toggle/cold-restart refusal.
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

          const otherSession = await tuiNewSession(tuiW, 'WP-11 other Session')
          let wp11Session
          let wp11Seq
          let wp11Turn
          let wp11Cwd
          let wp11HostBytes
          let wp11Diff
          let wp11Seq2
          let wp11Turn2
          await browserCase('wp11-host-changes', { changesNonce }, async handle => {
            const session = await handle.waitFact('session', 'WP-11 Browser Session creation', 240_000)
            wp11Session = session.sessionId
            assert(typeof wp11Session === 'string' && wp11Session !== '', 'WP-11 the Browser created no Host Session')
            const header = await waitForHostSessionHeader(dshHome, wp11Session, 'WP-11 Session header')
            wp11Cwd = header.cwd
            assert(typeof wp11Cwd === 'string' && wp11Cwd !== '', 'WP-11 the Session records no authoritative cwd')
            assert(realpathSync(wp11Cwd) === realpathSync(dedicatedWorkspace),
              `WP-11 the Session cwd is not the dedicated Default workspace of this lane: ${realpathSync(wp11Cwd)} != ${realpathSync(dedicatedWorkspace)}`)
            const git = args => spawnSync('git', args, { cwd: wp11Cwd, encoding: 'utf8' })
            assert(git(['init', '--quiet']).status === 0, 'WP-11 could not initialize the isolated Git work tree')
            writeFileSync(join(wp11Cwd, 'README.md'), `w5-base-${changesNonce}\n`, { mode: 0o600 })
            assert(git(['add', '--all']).status === 0, 'WP-11 could not stage the initial work tree')
            const committed = git(['-c', 'user.name=WP11', '-c', 'user.email=wp11@example.invalid', 'commit', '--quiet', '-m', 'w5 baseline'])
            assert(committed.status === 0, `WP-11 could not create the initial commit: ${committed.stderr}`)
            handle.signal('workspace-ready')

            const firstBoundary = durableOf(wp11Session).length
            const changesEvent = await waitForHostSessionEventAfter(dshHome, wp11Session, firstBoundary,
              event => event.type === 'workspace/changes', 'WP-11 durable workspace/changes event', 300_000)
            assert(Number.isSafeInteger(changesEvent.data?.turn) && changesEvent.data.turn >= 1,
              `WP-11 the workspace/changes event carries no turn: ${JSON.stringify(changesEvent.data)}`)
            wp11Seq = changesEvent.seq
            wp11Turn = changesEvent.data.turn
            const writeProof = readC1WorkEvents(wp11.workRoot)
              .filter(event => event.kind === 'web-changes-write-issued' && event.sessionId === wp11Session)
            assert(writeProof.length === 1,
              `WP-11 the C1 model issued ${String(writeProof.length)} write calls for this Session, expected exactly 1`)
            assert(writeProof[0].nonce === changesNonce, 'WP-11 the model write proof belongs to another nonce')
            assert(writeProof[0].userText.includes(`w5-changes-${changesNonce}`),
              'WP-11 the model write proof was not issued for the qualification prompt')
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
            assert(writeResults[0].data.message.isError === false, 'WP-11 the official write tool result reports an error')
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
            assert(addedText.includes(`w5-change-${changesNonce}`), 'WP-11 the official comparison does not serve the recorded line')
            const anonymous = await fetchStatus(summaryUrl)
            assert(anonymous.status === 401,
              `WP-11 the unauthenticated summary route was not refused (HTTP ${String(anonymous.status)})`)
            handle.signal('first-write-verified')

            await handle.waitFact('nochange-sent', 'WP-11 no-change prompt sent', 300_000)
            await waitForHostSessionEventAfter(dshHome, wp11Session, changesEvent.seq,
              event => event.type === 'turn/end' && event.seq > changesEvent.seq,
              'WP-11 no-change turn/end', 180_000)
            assert(durableOf(wp11Session).filter(event => event.type === 'workspace/changes').length === 1,
              'WP-11 a no-change Turn appended a workspace/changes event')
            handle.signal('nochange-verified')

            const toggleBoundary = durableOf(wp11Session).length
            const identityBeforeToggle = (await hostStatus(wp11.host)).localHost
            const generationBeforeToggle = lastSurfaceStatus(tuiW)?.generationId
            await disableWeb(tuiW, 'WP-11 disable')
            const disabled11 = await hostStatus(wp11.host)
            webFullyOff(disabled11)
            assertSingleHostOwners(disabled11, 'WP-11 disabled Host')
            assertIdentityFields(disabled11.localHost, identityBeforeToggle, 'WP-11 disable kept the Host identity')
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
            const staleOnSameHost = await fetchStatus(summaryUrl, { headers: { cookie: index11.cookie } })
            assert(staleOnSameHost.status === 404,
              `WP-11 the re-enabled Host served the pre-disable summary (HTTP ${String(staleOnSameHost.status)})`)
            const staleDiffSameHost = await fetchStatus(diffUrl, { headers: { cookie: index11.cookie } })
            assert(staleDiffSameHost.status === 404,
              `WP-11 the re-enabled Host served the pre-disable comparison (HTTP ${String(staleDiffSameHost.status)})`)
            handle.signal('toggle-reenabled')

            await handle.waitFact('second-write-sent', 'WP-11 second write sent', 300_000)
            const secondEvent = await waitForHostSessionEventAfter(dshHome, wp11Session, toggleBoundary,
              event => event.type === 'workspace/changes' && event.seq > wp11Seq,
              'WP-11 post-re-enable workspace/changes event', 180_000)
            wp11Seq2 = secondEvent.seq
            wp11Turn2 = secondEvent.data.turn
            const write2Proof = readC1WorkEvents(wp11.workRoot)
              .filter(event => event.kind === 'web-changes-write2-issued' && event.sessionId === wp11Session)
            assert(write2Proof.length === 1,
              `WP-11 the C1 model issued ${String(write2Proof.length)} second write calls, expected exactly 1`)
            assert(write2Proof[0].nonce === changesNonce
              && write2Proof[0].userText.includes(`w5-changes2-${changesNonce}`),
            `WP-11 the second model write proof belongs to another prompt (nonce=${String(write2Proof[0].nonce)})`)
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
            handle.signal('second-write-verified')

            evidence.fact('wp11-host-changes', 'web-capabilities', {
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
              noChange: { workspaceChanges: 1 },
              toggle: { staleSummary404: staleOnSameHost.status, staleDiff404: staleDiffSameHost.status, secondChange: { turn: wp11Turn2, seq: wp11Seq2, files: ['changed2.txt'] } },
            })
            recordSession('wp11-host-changes', wp11Session)
            await ptyFrames('wp11-host-changes', tuiW)
            trace('t75-web-product-wp11', {
              sessionId: wp11Session,
              otherSession,
              turn: wp11Turn,
              seq: wp11Seq,
              cwdDigest: sha16(wp11Cwd),
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

    const verifiedCaseIds = evidence.passedCaseIds()
    assert(verifiedCaseIds.length > 0,
      'the product Browser qualification recorded no successful case')
    evidence.finish({
      status: 'PASS',
      browserSubset: 'PASS',
      verifiedCaseIds,
      browserCases: browserRun,
    })
    trace('t75-web-product', {
      status: 'PASS',
      browserSubset: 'PASS',
      cases: browserRun,
      verifiedCaseIds,
      hostPid: groupA.ready.pid,
      ternGui: 'NOT_VERIFIED: the real Tern GUI/TSP native gesture path is outside this Browser × Split product subset',
    })
    return { status: 'PASS', browserSubset: 'PASS', verifiedCaseIds }
  } finally {
    await cleanup()
  }
}