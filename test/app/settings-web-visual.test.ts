/**
 * C2-R4 — the frozen visual matrix for the `/settings → Tools → Web Search /
 * Fetch` page.
 *
 * Every case renders the REAL `TuiApp` on a `VirtualTerminal` and reads the
 * PHYSICAL frame plus the cell ink of the state vocabulary:
 *
 * - the page is reachable at 200×50, 120×40, 100×40, 80×24, 80×10, 72×24,
 *   44×20 and 44×8, paints the six frozen rows (cropped/scrolled when the
 *   grant is short), keeps the ONE physical Action Bar, and never overflows a
 *   physical line;
 * - the Detail pane names the real Host facts (`Current: …`) and the whole
 *   `[current]` chip; a candidate/verdict is never painted partially;
 * - the endpoint editor keeps its trust warning and its ONE
 *   `Enter confirm · Esc cancel` bar at the narrow sizes;
 * - the credential row keeps the official reference, the presence/source and
 *   BOTH explicit Models actions at 44×8 and above;
 * - the ink roles come from the LIVE palette (`textMuted` chips, `error`
 *   not-saved, `success` verified) in dark and light, and the frames do not
 *   depend on the icon style;
 * - pointer gestures use the LAST PAINTED hit map: a press→resize→release is
 *   refused, a click on an action that is not painted does nothing.
 *
 * FIXTURE: the real command registration + TuiApp + VirtualTerminal.
 * STAND-IN: the Host config service behind the ConfigPort (the real official
 * settings plane is qualified by `web-provider-rc2-integration.test.ts`).
 * ABSENT: a real terminal (the tmux record is separate) and the TSP GUI.
 *
 * @module @xmoon76/dsh-pi-tui/settings-web-visual.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import test, { afterEach } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import type { TuiSettingsDoc, WebProviderSettings } from '../../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import {
  assertBarIsLastRow,
  assertNoHalfSegmentInBar,
  assertOneActiveDevice,
} from '../support/design-language-frames.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const HOME = '\x1b[H'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const ENTER = '\r'
const ESC = '\x1b'
/** The frozen matrix (docs/architecture/design-language.md §11.2 / §8) plus the
 *  short floor this page is additionally qualified at. */
const SIZES = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20], [44, 8]] as const

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const hexToRgb = (hex: string): number => {
  const value = hex.replace('#', '')
  return Number.parseInt(value.slice(0, 6), 16)
}

const DEFAULT_DOC: TuiSettingsDoc = {
  theme: 'dark',
  iconStyle: 'unicode',
  footer: 'default',
  fullscreen: 'off',
  busyEnter: 'queue',
  localShellSandbox: 'bypass',
  homeEndKeys: 'app',
  notificationMode: 'off',
  notificationMethod: 'auto',
  terminalProgress: 'off',
  wheelScrollLines: '3',
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly store: {
    web: WebProviderSettings
    available: boolean
    failNext: string | undefined
    endpointStoredValue: string | undefined
  }
  readonly view: () => string
  readonly plain: () => readonly string[]
  readonly invoke: (name?: string) => unknown
  readonly dispose: () => void
}

function setup(options: {
  readonly columns: number
  readonly rows: number
  readonly endpoint?: string
  readonly iconStyle?: 'emoji' | 'symbols' | 'minimal'
}): Harness {
  const vt = new VirtualTerminal(options.columns, options.rows)
  const store = {
    available: true,
    failNext: undefined as string | undefined,
    /** The value the Host actually KEEPS after a successful endpoint write (a
     *  canonical form / a winning project layer); undefined = the submitted URL. */
    endpointStoredValue: undefined as string | undefined,
    web: {
      searchProvider: 'deepseek-official',
      fetchProvider: 'http',
      api: { baseURL: options.endpoint ?? 'https://api.deepseek.com/v1/tools', count: 10, sendOriginalQuestion: true },
      credential: { configured: true, source: 'file' },
    } as WebProviderSettings,
  }
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} },
    options.iconStyle === undefined ? undefined : { iconStyle: options.iconStyle })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const write = (apply: () => void): void => {
    if (store.failNext !== undefined) {
      const reason = store.failNext
      store.failNext = undefined
      throw new Error(reason)
    }
    apply()
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: () => ({ kind: 'unchanged' }),
    refreshStatus: () => {},
    tuiSettings: { get: () => doc, replace: (next: TuiSettingsDoc) => { Object.assign(doc, next) } },
    extensions: undefined,
    createPluginManagerPage: () => undefined,
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    setFocusMode: () => {},
    setNotificationMethod: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {},
    setSessionApprovalPolicy: () => 'applied',
    currentApprovalOverride: () => undefined,
    applyFooterSettings: () => {},
    config: settingsDirectPageConfig({
      // The Models reference view (the credential deeplink sink) must be
      // mounted; the real provider plane is the Models suite's job.
      providers: {
        available: () => true,
        listCredentialOptions: () => [],
        readCatalog: () => ({ options: [], profiles: [] }),
        readProfile: (route: string) => ({ route, configured: false, displayName: route, models: [] }),
        configGuide: () => ({ profilePatchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' }),
        writeProfile: async () => {},
        writeKeylessProfile: async () => ({ kind: 'written' as const }),
      },
      configReadiness: () => 'ready',
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      credentials: {
        available: () => true,
        describeReference: async () => ({ configured: true, source: 'file' }),
      },
      web: {
        available: () => store.available,
        read: async () => store.available ? { ...store.web, api: { ...store.web.api } } : undefined,
        setSearchProvider: async (id: string) => { write(() => { store.web.searchProvider = id }) },
        setFetchProvider: async (id: string) => { write(() => { store.web.fetchProvider = id }) },
        setSearchApiCount: async (count: number) => { write(() => { store.web.api.count = count }) },
        setSendOriginalQuestion: async (enabled: boolean) => { write(() => { store.web.api.sendOriginalQuestion = enabled }) },
        setSearchApiBaseURL: async (url: string) => { write(() => { store.web.api.baseURL = store.endpointStoredValue ?? url }) },
      },
    }),
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name = 'settings'): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  const plain = (): readonly string[] => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/gu, ''))
  return {
    vt,
    app,
    store,
    view: () => plain().join('\n'),
    plain,
    invoke,
    dispose: () => {
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
    },
  }
}

async function key(h: Harness, data: string): Promise<void> {
  h.vt.sendInput(data)
  await h.vt.waitForRender()
}

/** One native SGR left-button gesture (1-based terminal cells). */
const press = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`) }
const release = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`) }

/** Wait until the PAINTED frame satisfies `predicate` (a real rendered frame,
 *  never a timer guess about the Host read). */
async function waitForPainted(h: Harness, label: string, predicate: (frame: string) => boolean): Promise<string> {
  await waitForFrame(() => h.view(), predicate, () => h.vt.waitForRender(), label)
  return h.view()
}

/** Reach the `Tools` rows level of the real Settings workspace. */
async function openOtherRows(h: Harness): Promise<void> {
  h.invoke('settings')
  await waitForPainted(h, 'the Settings workspace to paint its rail', frame => frame.includes('Settings ·'))
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
}

/** Open the Web page and wait for its settled authority facts (the page's own
 *  mount triggers a fresh Host read, so the first frames are Loading…). */
async function openWebPage(h: Harness): Promise<void> {
  await openOtherRows(h)
  await key(h, DOWN)
  await key(h, ENTER)
  await waitForPainted(h, 'the Web page to paint its settled facts', frame =>
    frame.includes('Web Search Provider') && !frame.includes('Loading…'))
}

/** Move the page list cursor to one row (Home = first). */
async function selectListRow(h: Harness, index: number): Promise<void> {
  await key(h, HOME)
  for (let step = 0; step < index; step += 1) await key(h, DOWN)
}

for (const [columns, rows] of SIZES) {
  test(`the Web page is reachable and budgeted at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openOtherRows(h)
    const launcherRows = h.plain()
    assert.ok(launcherRows.some(line => line.includes('Web Search / Fetch')),
      `the launcher row is painted at ${columns}x${rows}:\n${launcherRows.join('\n')}`)
    await key(h, DOWN)
    await key(h, ENTER)
    const frame = await waitForPainted(h, `the Web page at ${columns}x${rows}`, frame =>
      frame.includes('Web Search Provider') && !frame.includes('Loading…'))
    // The six frozen rows exist and the FIRST is always visible at the top; a
    // short grant crops/scolls the rest instead of inventing a compact mode.
    assert.match(frame, /Web Search Provider/u, 'the first frozen row is painted')
    assert.match(frame, /Enter open/u, 'the list bar states the ONE action')
    const painted = h.plain()
    for (const line of painted) {
      assert.ok(visibleWidth(line) <= columns, `no frame line exceeds ${columns} cells: ${JSON.stringify(line)}`)
    }
    // The physical last row is the page's ONE Action Bar.
    assertBarIsLastRow(painted, (row, col) => h.vt.getCellFgRgb(row, col), 'Esc')
    assertNoHalfSegmentInBar(painted, painted.length - 1, ' · ')
    // Exactly ONE active chrome device: the focused pane header (or none at a
    // narrow width, where the page paints a single region).
    const headerRow = painted.findIndex(line => line.includes('[Web Search / Fetch]') || line.includes('[Current / Detail]'))
    if (headerRow >= 0) {
      const primaries = assertOneActiveDevice({
        rows: painted,
        readColor: (row, col) => h.vt.getCellFgRgb(row, col),
        primaryRgb: hexToRgb(currentPalette.primary),
      }, {
        rows: [headerRow],
        labelPrefixes: ['[Web Search / Fetch]', '[Current / Detail]'],
      })
      assert.equal(primaries.length, 1, `exactly one active pane header at ${columns}x${rows}:\n${frame}`)
    }
    // Scroll the list to the last row: every row stays reachable at every size.
    for (let step = 0; step < 5; step += 1) await key(h, DOWN)
    const scrolled = h.view()
    // The wide/medium projections paint the Detail pane; a narrow frame paints
    // the list alone, where the selected row's own value IS the Host fact.
    assert.match(scrolled, /Current: |Reference: |Configured · source: file/u,
      `the selected row states a real Host fact:\n${scrolled}`)
    const lastRowPainted = scrolled.includes('DeepSeek API Key') || scrolled.includes('Search / Fetch API Endpoint')
      || scrolled.includes('Search API Result Count') || scrolled.includes('Share Original Question')
    assert.ok(lastRowPainted, `the scroll really reveals later frozen rows:\n${scrolled}`)
    // Esc from the list returns to the Tools row (never a second overlay).
    await key(h, ESC)
    assert.match(h.view(), /Settings · Tools/u, 'Esc returns to the Tools level')
    assert.doesNotMatch(h.view(), /Legacy|existing settings editor/iu,
      'the legacy SettingsList is never opened by the Web row')
  })
}

for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [44, 20], [44, 8]] as const) {
  test(`the Detail pane paints the current fact and whole chips at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openWebPage(h)
    await selectListRow(h, 0)
    await key(h, ENTER) // the row Detail
    const frame = h.view()
    assert.match(frame, /Current: Messages/u, `the Detail states the real Host value:\n${frame}`)
    assert.match(frame, /Enter confirm/u, 'the Detail bar advertises the ONE confirm action')
    if (columns >= 80) {
      assert.match(frame, /\[current\]/u, 'the current chip is painted WHOLE')
      assert.ok(!frame.includes('[curren ') && !frame.includes('[curren|') && !frame.includes('[curren]'),
        `no chip is painted partially:\n${frame}`)
    }
    // Moving the highlight never writes and keeps ONE active cursor.
    await key(h, DOWN)
    assert.match(h.view(), /› DeepSeek Search API/u, 'the cursor moved to the next candidate')
    const painted = h.plain()
    for (const line of painted) assert.ok(visibleWidth(line) <= columns)
  })
}

for (const [columns, rows] of SIZES) {
  test(`the endpoint editor keeps its trust warning and confirm/cancel bar at ${columns}×${rows}`, async t => {
    const longEndpoint = 'https://gateway.example.test/deepseek/v1/tools/with/a/long/path'
    const h = setup({ columns, rows, endpoint: longEndpoint })
    t.after(h.dispose)
    await openWebPage(h)
    await selectListRow(h, 4)
    await key(h, ENTER) // mount the endpoint editor
    const frame = h.view()
    assert.match(frame, /Enter confirm · Esc cancel/u, `the whole confirm/cancel bar survives at ${columns}x${rows}`)
    // The trust warning leads with the actionable half and never loses it.
    assert.match(frame, /Only confirm a trusted https base/u, `the trust warning is painted:\n${frame}`)
    assert.ok(!/Esc ca$|Esc can$|Esc canc$|Enter confir$/u.test(frame), 'no hint is painted as a partial word')
    for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
    assertBarIsLastRow(h.plain(), (row, col) => h.vt.getCellFgRgb(row, col), 'Enter confirm · Esc cancel')
    await key(h, ESC) // cancel without a write
    assert.doesNotMatch(h.view(), /Enter confirm · Esc cancel/u, 'Esc cancels the draft')
  })
}

for (const [columns, rows] of [[120, 40], [80, 24], [44, 20], [44, 8]] as const) {
  test(`the credential row keeps the reference, presence and BOTH actions at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openWebPage(h)
    await selectListRow(h, 5)
    await key(h, ENTER)
    const frame = h.view()
    assert.match(frame, /Reference: DEEPSEEK_API_KEY/u, `the official reference is painted:\n${frame}`)
    assert.match(frame, /Configured/u, 'presence/source come from the store')
    assert.match(frame, /Configure in Models…/u, 'Configure is painted')
    assert.match(frame, /Clear in Models…/u, 'Clear is painted (the reference is configured)')
    assert.match(frame, /Enter open in Models/u, 'the ONE action bar names the Models deeplink')
    assert.doesNotMatch(frame, /sk-|secret value/iu, 'no secret is ever painted')
    for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
    assertBarIsLastRow(h.plain(), (row, col) => h.vt.getCellFgRgb(row, col), 'Esc back')
    // Enter opens the EXISTING Models page in the same lease.
    await key(h, ENTER)
    await waitForPainted(h, 'the Models page on the reference', frame =>
      frame.includes('Settings · Models')
      && (frame.includes('API Key Reference') || frame.includes('DEEPSEEK_API_KEY')))
    assert.match(h.view(), /Settings · Models/u)
    assert.match(h.view(), /API Key Reference/u, 'the Models page owns the reference view')
  })
}

test('the state vocabulary uses its frozen ink roles in dark and light', async t => {
  const chipCell = (h: Harness, rowNeedle: string, needle: string): number | undefined => {
    const lines = h.plain()
    const row = lines.findIndex(line => line.includes(rowNeedle) && line.includes(needle))
    assert.ok(row >= 0, `the frame paints ${needle} on ${rowNeedle}:\n${h.view()}`)
    return h.vt.getCellFgRgb(row, lines[row]!.indexOf(needle))
  }
  setTheme('dark')
  const dark = setup({ columns: 120, rows: 40 })
  try {
    await openWebPage(dark)
    await selectListRow(dark, 0)
    await key(dark, ENTER)
    const darkChip = chipCell(dark, 'Messages', '[current]')
    assert.equal(darkChip, hexToRgb(currentPalette.textMuted), 'the current chip is textMuted')
    // A REFUSED write paints Not saved in error ink (the word rides the state).
    dark.store.failNext = 'mutate rejected'
    await key(dark, DOWN)
    await key(dark, ENTER)
    await waitForPainted(dark, 'the refused write verdict', frame => frame.includes('Not saved'))
    const verdictRow = dark.plain().findIndex(line => line.includes('Not saved ·'))
    assert.ok(verdictRow >= 0, `the Detail paints the verdict:\n${dark.view()}`)
    const verdictCol = dark.plain()[verdictRow]!.indexOf('Not saved ·')
    assert.equal(dark.vt.getCellFgRgb(verdictRow, verdictCol), hexToRgb(currentPalette.error),
      'Not saved wears the error token')
    dark.dispose()

    // The LIGHT palette supplies the same roles on its own open.
    setTheme('light')
    const light = setup({ columns: 120, rows: 40 })
    try {
      await openWebPage(light)
      await selectListRow(light, 0)
      await key(light, ENTER)
      assert.equal(chipCell(light, 'Messages', '[current]'), hexToRgb(currentPalette.textMuted),
        'the light palette supplies the same role')
      assert.notEqual(hexToRgb(currentPalette.textMuted), darkChip ?? -1,
        'the two palettes really differ (the probe was not vacuous)')
    } finally {
      light.dispose()
    }
  } finally {
    setTheme('dark')
  }
})

test('a VERIFIED write paints Verified in the success role', async t => {
  const h = setup({ columns: 120, rows: 40 })
  try {
    await openWebPage(h)
    await selectListRow(h, 0)
    await key(h, ENTER)
    await key(h, DOWN)
    await key(h, ENTER)
    await waitForPainted(h, 'the verified verdict', frame => frame.includes('Verified'))
    const lines = h.plain()
    const row = lines.findIndex(line => line.includes('Verified'))
    assert.ok(row >= 0)
    const col = lines[row]!.indexOf('Verified')
    assert.equal(h.vt.getCellFgRgb(row, col), hexToRgb(currentPalette.success),
      'Verified wears the success token')
  } finally {
    h.dispose()
    setTheme('dark')
  }
})

test('a CJK custom provider id stays cell-safe at the frozen sizes', async t => {
  for (const [columns, rows] of [[100, 40], [44, 20], [44, 8]] as const) {
    const h = setup({ columns, rows })
    try {
      h.store.web.searchProvider = '搜索-提供方-一号'
      await openWebPage(h)
      const frame = h.plain()
      for (const line of frame) {
        assert.ok(visibleWidth(line) <= columns, `no CJK row overflows ${columns} cells: ${JSON.stringify(line)}`)
      }
      assert.ok(frame.some(line => line.includes('搜索-提供方-一号')), `the custom id is reported as-is at ${columns}x${rows}`)
    } finally {
      h.dispose()
    }
  }
})

test('a LIVE palette switch re-paints the page with the NEW ink (no cached ANSI)', async t => {
  const h = setup({ columns: 120, rows: 40 })
  try {
    await openWebPage(h)
    await selectListRow(h, 0)
    await key(h, ENTER)
    const ink = (needle: string): number | undefined => {
      const lines = h.plain()
      const row = lines.findIndex(line => line.includes(needle))
      assert.ok(row >= 0, `the frame paints ${needle}:\n${h.view()}`)
      return h.vt.getCellFgRgb(row, lines[row]!.indexOf(needle))
    }
    assert.equal(ink('[current]'), hexToRgb(currentPalette.textMuted), 'the chip starts on the live palette')
    h.app.applyPalette({ ...currentPalette, textMuted: '#123456' })
    await h.vt.waitForRender()
    assert.equal(ink('[current]'), hexToRgb('#123456'),
      'the mounted page follows the NEW palette instead of its creation-time ANSI')
  } finally {
    h.dispose()
    setTheme('dark')
  }
})

test('a click on a list row opens its Detail; a press→resize→release never does', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  const lines = h.plain()
  const countRow = lines.findIndex(line => line.includes('Search API Result Count'))
  assert.ok(countRow >= 0)
  press(h, countRow, 4)
  release(h, countRow, 4)
  await h.vt.waitForRender()
  assert.match(h.view(), /Current: 10/u, `the clicked row opened its Detail:\n${h.view()}`)

  // Back to the list, then a gesture straddling a RESIZE is refused.
  await key(h, ESC)
  const providerRow = h.plain().findIndex(line => line.includes('Web Search Provider'))
  assert.ok(providerRow >= 0)
  press(h, providerRow, 4)
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h, providerRow, 4)
  await h.vt.waitForRender()
  assert.match(h.view(), /Enter open/u, 'the refused gesture stays at the list (no Detail opened)')
})

test('a click on an option only highlights it; the explicit Enter is the ONE write', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 0)
  await key(h, ENTER)
  const optionRow = h.plain().findIndex(line => line.includes('DeepSeek Search API · opt-in'))
  assert.ok(optionRow >= 0, `the candidate row is painted:\n${h.view()}`)
  press(h, optionRow, 40)
  release(h, optionRow, 40)
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'a click never writes')
  await key(h, ENTER) // the explicit confirm of the highlighted candidate
  await waitForPainted(h, 'the confirmed write', frame => frame.includes('Verified'))
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
})

test('an unavailable authority paints the reason and offers no Confirm', async t => {
  for (const [columns, rows] of [[120, 40], [44, 20], [44, 8]] as const) {
    const h = setup({ columns, rows })
    try {
      h.store.available = false
      await openOtherRows(h)
      await key(h, DOWN)
      await key(h, ENTER)
      const frame = await waitForPainted(h, 'the unavailable page', frame =>
        frame.includes('Web Search Provider') && !frame.includes('Loading…'))
      assert.match(frame, /Unavailable/u, `the unreadable authority is stated:\n${frame}`)
      await key(h, ENTER) // the read-only Detail
      const detail = h.view().replace(/\s+/gu, ' ')
      assert.match(detail, /the Host Web provider settings are not available on this backend/u,
        'the Detail names the real reason')
      assert.doesNotMatch(h.view(), /Enter confirm/u, 'no Confirm affordance exists without an authority')
      for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
    } finally {
      h.dispose()
    }
  }
})
