/**
 * C2-R4 — the frozen visual matrix for the `/settings → Tools → Web Search /
 * Fetch` page.
 *
 * Every case renders the REAL `TuiApp` on a `VirtualTerminal` and reads the
 * PHYSICAL frame plus the cell ink of the state vocabulary:
 *
 * - the page is reachable at 200×50, 120×40, 100×40, 80×24, 80×10, 72×24,
 *   44×20 and 44×8, paints the nine frozen rows (cropped/scrolled when the
 *   grant is short), keeps the ONE physical Action Bar, and never overflows a
 *   physical line;
 * - the Detail pane names the real Host facts (`Current: …`) and the whole
 *   `[current]` chip; a candidate/verdict is never painted partially;
 * - the Search billing row keeps its three official candidates and its
 *   `Confirm [Enter]` bar at the narrow sizes;
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
import { unconfiguredPolicyObservation } from '../support/session-policy-fake.ts'

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
    current: { both: boolean; web: boolean; api: boolean }
    failNext: string | undefined
  }
  readonly view: () => string
  readonly plain: () => readonly string[]
  readonly invoke: (name?: string) => unknown
  /** The number of REAL fresh Host reads the mounted page started. */
  readonly reads: () => number
  readonly dispose: () => void
}

function setup(options: {
  readonly columns: number
  readonly rows: number
  readonly iconStyle?: 'emoji' | 'symbols' | 'minimal'
  /** The stored `web.searchProvider`; explicit `undefined` IS the Host's
   *  AUTOMATIC routing state (kept as `undefined`, never defaulted). */
  readonly searchProvider?: string
}): Harness {
  const vt = new VirtualTerminal(options.columns, options.rows)
  const hostGeneration = {}
  let freshReads = 0
  const store = {
    available: true,
    current: { both: true, web: true, api: true },
    failNext: undefined as string | undefined,
    web: {
      searchProvider: 'searchProvider' in options ? options.searchProvider : 'deepseek-official',
      fetchProvider: 'http',
      providerSelection: {
        search: ('searchProvider' in options ? options.searchProvider : 'deepseek-official') === undefined
          ? { baseId: undefined, userSet: false, userId: undefined }
          : {
              baseId: undefined,
              userSet: true,
              userId: 'searchProvider' in options ? options.searchProvider : 'deepseek-official',
            },
        fetch: { baseId: 'http', userSet: false, userId: undefined },
      },
      api: { searchBilling: 'auto', fetchBilling: 'auto', count: 10, sendOriginalQuestion: true },
      advanced: {},
      credential: { configured: true, source: 'file' },
      authority: { generation: hostGeneration, webRevision: 1, apiRevision: 1 },
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
  const bumpAuthority = (ns: 'web' | 'api'): void => {
    const authority = store.web.authority
    store.web.authority = ns === 'web'
      ? { ...authority, webRevision: authority.webRevision + 1 }
      : { ...authority, apiRevision: authority.apiRevision + 1 }
  }
  const write = (apply: () => void, bump?: 'web' | 'api'): { readonly kind: 'accepted' } | { readonly kind: 'rejected'; readonly reason: string } => {
    if (store.failNext !== undefined) {
      const reason = store.failNext
      store.failNext = undefined
      return { kind: 'rejected', reason }
    }
    apply()
    if (bump !== undefined) bumpAuthority(bump)
    return { kind: 'accepted' }
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
    policy: unconfiguredPolicyObservation(),
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
      subagentLimits: {
        read: () => ({ kind: 'unavailable' as const, reason: 'not mounted' }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      subagentModelSelection: {
        read: () => ({ kind: 'unavailable' as const, reason: 'not mounted' }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      credentials: {
        available: () => true,
        describeReference: async () => ({ configured: true, source: 'file' }),
      },
      web: {
        available: () => store.available,
        read: async () => store.available
          ? {
              ...store.web,
              providerSelection: structuredClone(store.web.providerSelection),
              api: { ...store.web.api },
              authority: { ...store.web.authority },
            }
          : undefined,
        readFresh: async () => {
          freshReads += 1
          return store.available
            ? {
                ...store.web,
                providerSelection: structuredClone(store.web.providerSelection),
                api: { ...store.web.api },
                authority: { ...store.web.authority },
              }
            : undefined
        },
        isObservationCurrent: (_capture: WebProviderSettings, target: 'both' | 'web' | 'api' = 'both') => store.current[target],
        setSearchProvider: async (id: string, _capture: WebProviderSettings) => {
          const selection = store.web.providerSelection.search
          if (store.web.searchProvider === id && selection.userSet && selection.userId === id) {
            return { kind: 'no-changes' as const }
          }
          return write(() => {
            store.web.searchProvider = id
            store.web.providerSelection = {
              ...store.web.providerSelection,
              search: { baseId: store.web.providerSelection.search.baseId, userSet: true, userId: id },
            }
          }, 'web')
        },
        setFetchProvider: async (id: string, _capture: WebProviderSettings) => {
          const selection = store.web.providerSelection.fetch
          if (store.web.fetchProvider === id && selection.userSet && selection.userId === id) {
            return { kind: 'no-changes' as const }
          }
          return write(() => {
            store.web.fetchProvider = id
            store.web.providerSelection = {
              ...store.web.providerSelection,
              fetch: { baseId: store.web.providerSelection.fetch.baseId, userSet: true, userId: id },
            }
          }, 'web')
        },
        restoreSearchProvider: async (_capture: WebProviderSettings) => {
          const selection = store.web.providerSelection.search
          if (!selection.userSet && store.web.searchProvider === selection.baseId) {
            return { kind: 'no-changes' as const }
          }
          return write(() => {
            const baseId = store.web.providerSelection.search.baseId
            store.web.searchProvider = baseId
            store.web.providerSelection = {
              ...store.web.providerSelection,
              search: { baseId, userSet: false, userId: undefined },
            }
          }, 'web')
        },
        restoreFetchProvider: async (_capture: WebProviderSettings) => {
          const selection = store.web.providerSelection.fetch
          if (!selection.userSet && store.web.fetchProvider === selection.baseId) {
            return { kind: 'no-changes' as const }
          }
          return write(() => {
            const baseId = store.web.providerSelection.fetch.baseId
            store.web.fetchProvider = baseId
            store.web.providerSelection = {
              ...store.web.providerSelection,
              fetch: { baseId, userSet: false, userId: undefined },
            }
          }, 'web')
        },
        setSearchApiCount: async (count: number, _capture: WebProviderSettings) => store.web.api.count === count
          ? { kind: 'no-changes' as const }
          : write(() => { store.web.api.count = count }, 'api'),
        setSendOriginalQuestion: async (enabled: boolean, _capture: WebProviderSettings) => store.web.api.sendOriginalQuestion === enabled
          ? { kind: 'no-changes' as const }
          : write(() => { store.web.api.sendOriginalQuestion = enabled }, 'api'),
        setSearchBilling: async (mode: string, _capture: WebProviderSettings) => store.web.api.searchBilling === mode
          ? { kind: 'no-changes' as const }
          : write(() => { store.web.api.searchBilling = mode as 'auto' | 'account' | 'api-key' }, 'api'),
        setFetchBilling: async (mode: string, _capture: WebProviderSettings) => store.web.api.fetchBilling === mode
          ? { kind: 'no-changes' as const }
          : write(() => { store.web.api.fetchBilling = mode as 'auto' | 'account' | 'api-key' }, 'api'),
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
    reads: () => freshReads,
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

/** The painted (row, cell) of the LAST line containing `word`. */
function paintedWordPoint(h: Harness, word: string): { readonly row: number; readonly column: number } {
  const lines = h.plain()
  const row = lines.findLastIndex(line => line.includes(word))
  assert.ok(row >= 0, `${word} is not painted:\n${h.view()}`)
  const column = lines[row]!.indexOf(word)
  assert.ok(column >= 0, `${word} has no painted column`)
  return { row, column }
}

/** One complete real SGR press+release on a painted word. */
function clickWord(h: Harness, word: string): void {
  const point = paintedWordPoint(h, word)
  press(h, point.row, point.column + 1)
  release(h, point.row, point.column + 1)
}

/** The painted (row, cell) of ONE candidate row in the REAL local projection:
 *  the dual Detail column, or the whole line on a single-region frame. The
 *  first matching line is the candidate list itself (the prose notes that
 *  mention the same provider name come later). */
function paintedCandidatePoint(h: Harness, label: string): { readonly row: number; readonly column: number } {
  const rows = h.plain()
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`^\\s*(?:› )?${escaped}\\b`, 'u')
  const header = rows.find(line => line.includes('Current / Detail'))
  if (header === undefined) {
    const row = rows.findIndex(line => pattern.test(line))
    assert.ok(row >= 0, `${label} candidate is not painted:\n${h.view()}`)
    return { row, column: rows[row]!.indexOf(label) }
  }
  const at = header.indexOf('Current / Detail')
  const start = header[at - 1] === '[' ? at - 1 : at
  const row = rows.findIndex(line => pattern.test(line.slice(start)))
  assert.ok(row >= 0, `${label} candidate is not painted:\n${h.view()}`)
  return { row, column: start + rows[row]!.slice(start).indexOf(label) }
}

/** The joined text of the painted DETAIL column. In a dual frame the Detail
 *  shares physical rows with the List, so a sentence must be read from the
 *  Detail's own column instead of the whole (interleaved) line. A single-region
 *  frame has no second column and reads as a whole line. */
function detailPaneText(h: Harness): string {
  const rows = h.plain()
  const header = rows.find(candidate => candidate.includes('Current / Detail'))
  if (header === undefined) return h.view().replace(/\s+/gu, ' ')
  const at = header.indexOf('Current / Detail')
  const start = header[at - 1] === '[' ? at - 1 : at
  return rows.map(line => line.slice(start)).join(' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Wait out the alt screen's DOUBLE_CLICK window before the NEXT pointer
 * gesture on the same word. An intentional second click on one painted word
 * inside that window reads as a word-selection double click in the fork,
 * never as a second disclosure; this paces the gesture out. The bound is the
 * fork's real contract (DOUBLE_CLICK_INTERVAL_MS = 500 plus one frame of
 * slack), not a blind wait for an async result.
 */
async function settlePointerClick(h: Harness): Promise<void> {
  // The fork's real DOUBLE_CLICK window contract (500 ms), not an async guess:
  await new Promise<void>(resolve => setTimeout(resolve, 550))
  await h.vt.waitForRender()
}

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

/** Move the Tools rows cursor onto the Web launcher row (label-driven, so a new
 *  neighbouring row can never silently shift this navigation). */
async function highlightWebRow(h: Harness): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    if (/> Web Search \/ Fetch/u.test(h.view())) return
    await key(h, DOWN)
  }
  assert.fail(`the Web launcher row never owned the selection:\n${h.view()}`)
}

/** Open the Web page and wait for its settled authority facts (the page's own
 *  mount triggers a fresh Host read, so the first frames are Loading…). */
async function openWebPage(h: Harness): Promise<void> {
  await openOtherRows(h)
  await highlightWebRow(h)
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
    // PO-1B added two ACP rows to Tools, so at the shortest grant the Web
    // launcher row is CROPPED from the first screen. It stays reachable by
    // scrolling the rows cursor onto it (the label-driven helper), which is the
    // real user path; assert it is painted once selected rather than assuming
    // every Tools row fits at once.
    await highlightWebRow(h)
    const launcherRows = h.plain()
    assert.ok(launcherRows.some(line => line.includes('Web Search / Fetch')),
      `the launcher row is painted at ${columns}x${rows}:\n${launcherRows.join('\n')}`)
    await key(h, ENTER)
    const frame = await waitForPainted(h, `the Web page at ${columns}x${rows}`, frame =>
      frame.includes('Web Search Provider') && !frame.includes('Loading…'))
    // The nine frozen rows exist and the FIRST is always visible at the top; a
    // short grant crops/scolls the rest instead of inventing a compact mode.
    assert.match(frame, /Web Search Provider/u, 'the first frozen row is painted')
    assert.match(frame, /Open \[Enter\]/u, 'the list bar states the ONE explicit Open action')
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
    for (let step = 0; step < 8; step += 1) await key(h, DOWN)
    const scrolled = h.view()
    // The wide/medium projections paint the Detail pane; a narrow frame paints
    // the list alone, where the selected row's own value IS the Host fact.
    assert.match(scrolled, /Current: |Reference: |Configured · source: file/u,
      `the selected row states a real Host fact:\n${scrolled}`)
    const lastRowPainted = scrolled.includes('DeepSeek API Key') || scrolled.includes('Search API Override')
      || scrolled.includes('Search Billing') || scrolled.includes('Search API Result Count')
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
    assert.match(frame, /Current: DeepSeek server-side search/u, `the Detail states the real Host value:\n${frame}`)
    assert.match(frame, /Confirm \[Enter\]/u, 'the Detail bar advertises the ONE confirm action')
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
  test(`the Search billing row keeps its candidates and confirm bar at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    // The Billing row exists only for the Search API route (server-side Search
    // never consumes searchBilling).
    h.store.web.searchProvider = 'deepseek-search-api'
    await openWebPage(h)
    await selectListRow(h, 4)
    await key(h, ENTER) // the billing Detail
    const frame = h.view()
    assert.match(frame, /Current: Automatic/u, `the stored billing mode is painted at ${columns}x${rows}`)
    assert.match(frame, /› Automatic/u, 'the current candidate is highlighted')
    assert.match(frame, /Confirm \[Enter\]/u, `the confirm bar survives at ${columns}x${rows}`)
    assert.ok(!/Confirm \[Ente?r?$|Back \[Es$/u.test(frame), 'no hint is painted as a partial word')
    for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
    assertBarIsLastRow(h.plain(), (row, col) => h.vt.getCellFgRgb(row, col), 'Back [Esc]')
    // The three official modes are offered with their credential claims. The
    // highlighted candidate is the current mode; a short grant crops the rest
    // of the Detail, so the remaining candidates are reachable by scrolling
    // (never dropped) — a tiny viewport may not show two at once.
    const disclosure = frame.replace(/\s+/gu, ' ')
    assert.match(disclosure, /› Automatic \[current\]/u, 'the current candidate chip survives every frozen size')
    assert.match(disclosure, /Confirm \[Enter\]/u)
    for (let step = 0; step < 10 && !h.view().includes('API key · API key credential only'); step += 1) {
      await key(h, '\x1b[6~') // PgDn scrolls the Detail viewport
    }
    assert.match(h.view().replace(/\s+/gu, ' '), /API key · API key credential only/u)
    for (let step = 0; step < 10 && !h.view().includes('Account · signed-in account only'); step += 1) {
      await key(h, '\x1b[5~') // PgUp scrolls back
    }
    assert.match(h.view().replace(/\s+/gu, ' '), /Account · signed-in account only/u)
    await key(h, ESC) // back to the list without a write
    assert.equal(h.store.web.api.searchBilling, 'auto', 'browsing the billing Detail writes nothing')
  })
}

for (const [columns, rows] of [[120, 40], [80, 24], [44, 20], [44, 8]] as const) {
  test(`the credential row keeps the reference, presence and BOTH actions at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openWebPage(h)
    await selectListRow(h, 8)
    await key(h, ENTER)
    const frame = h.view()
    assert.match(frame, /Reference: DEEPSEEK_API_KEY/u, `the official reference is painted:\n${frame}`)
    assert.match(frame, /Configured/u, 'presence/source come from the store')
    assert.match(frame, /Configure in Models…/u, 'Configure is painted')
    assert.match(frame, /Clear in Models…/u, 'Clear is painted (the reference is configured)')
    assert.match(frame, /Open in Models… \[Enter\]/u, 'the ONE action bar names the Models deeplink')
    assert.doesNotMatch(frame, /sk-|secret value/iu, 'no secret is ever painted')
    for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
    assertBarIsLastRow(h.plain(), (row, col) => h.vt.getCellFgRgb(row, col), 'Back [Esc]')
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
    const darkChip = chipCell(dark, 'DeepSeek server-side search', '[current]')
    assert.equal(darkChip, hexToRgb(currentPalette.textMuted), 'the current chip is textMuted')
    // A REFUSED write paints Could not save in error ink (the word rides the state).
    dark.store.failNext = 'mutate rejected'
    await key(dark, DOWN)
    await key(dark, ENTER)
    await waitForPainted(dark, 'the refused write verdict', frame => frame.includes('Could not save'))
    const verdictRow = dark.plain().findIndex(line => line.includes('Could not save ·'))
    assert.ok(verdictRow >= 0, `the Detail paints the verdict:\n${dark.view()}`)
    const verdictCol = dark.plain()[verdictRow]!.indexOf('Could not save ·')
    assert.equal(dark.vt.getCellFgRgb(verdictRow, verdictCol), hexToRgb(currentPalette.error),
      'Could not save wears the error token')
    dark.dispose()

    // The LIGHT palette supplies the same roles on its own open.
    setTheme('light')
    const light = setup({ columns: 120, rows: 40 })
    try {
      await openWebPage(light)
      await selectListRow(light, 0)
      await key(light, ENTER)
      assert.equal(chipCell(light, 'DeepSeek server-side search', '[current]'), hexToRgb(currentPalette.textMuted),
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

test('a VERIFIED write paints Saved in the success role', async t => {
  const h = setup({ columns: 120, rows: 40 })
  try {
    await openWebPage(h)
    await selectListRow(h, 0)
    await key(h, ENTER)
    await key(h, DOWN)
    await key(h, ENTER)
    await waitForPainted(h, 'the verified verdict', frame => frame.includes('Saved'))
    const lines = h.plain()
    const row = lines.findIndex(line => line.includes('Saved'))
    assert.ok(row >= 0)
    const col = lines[row]!.indexOf('Saved')
    assert.equal(h.vt.getCellFgRgb(row, col), hexToRgb(currentPalette.success),
      'Saved wears the success token')
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

test('a list row click only selects; the painted Open is the ONE way into the Detail, and a straddling resize is refused', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  const lines = h.plain()
  const count = paintedWordPoint(h, 'Search API Result Count')
  press(h, count.row, count.column)
  release(h, count.row, count.column)
  await h.vt.waitForRender()
  // The click selected the row and kept the LIST seat: the explicit Open is
  // still the advertised action and the Detail is a passive preview.
  assert.match(h.view(), /Open \[Enter\]/u, 'the row click did not open the Detail')
  assert.match(h.view(), /Current: 10/u, 'the selected row previews its authoritative fact')
  assert.match(h.view(), /\[Web Search \/ Fetch\]/u, 'the list still owns the active device')

  // The complete painted Open span is the explicit entry.
  clickWord(h, 'Open [Enter]')
  await waitForPainted(h, 'the explicit Open to reach the Detail', frame => frame.includes('Confirm [Enter]'))
  await key(h, ESC) // Detail -> list
  // A gesture straddling a RESIZE is refused and leaves the list seat intact.
  const provider = paintedWordPoint(h, 'Web Search Provider')
  press(h, provider.row, provider.column)
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h, provider.row, provider.column)
  await h.vt.waitForRender()
  assert.match(h.view(), /Open \[Enter\]/u, 'the refused gesture stays at the list (no Detail opened)')
})

test('a click on an option only highlights it; the explicit Confirm [Enter] click is the ONE write', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 0)
  await key(h, ENTER)
  const option = paintedCandidatePoint(h, 'DeepSeek Search API')
  press(h, option.row, option.column)
  release(h, option.row, option.column)
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'an option click never writes')
  assert.match(h.view(), /› DeepSeek Search API/u, 'the click only moved the draft')
  // The complete painted Confirm [Enter] is the ONE delegated target.
  clickWord(h, 'Confirm [Enter]')
  await waitForPainted(h, 'the confirmed write', frame => frame.includes('Saved'))
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  assert.equal(h.store.web.api.count, 10, 'no neighbouring Web field was written')
  // The commit verb uses the primary action ink while the Back affordance keeps
  // the secondary ink (design language §7.1; the key caps stay muted).
  const confirmPoint = paintedWordPoint(h, 'Confirm [Enter]')
  assert.equal(h.vt.getCellFgRgb(confirmPoint.row, confirmPoint.column), hexToRgb(currentPalette.text),
    'Confirm uses the primary action ink')
  const barLines = h.plain()
  const barRow = barLines.length - 1
  const backColumn = barLines[barRow]!.indexOf('Back [Esc]')
  assert.ok(backColumn >= 0)
  assert.equal(h.vt.getCellFgRgb(barRow, backColumn), hexToRgb(currentPalette.textDim),
    'Back keeps the secondary action ink')
})

test('the AUTOMATIC page offers a complete pointer-only route: click the row, the API candidate, Confirm, Saved, Back out', async t => {
  // With NO stored provider the page paints the real AUTOMATIC fact, paints no
  // [current] chip, and the pointer route reaches the SAME real write path:
  // row click (opens the Detail) → option click (draft only) → Confirm click
  // → Saved → the painted Back span returns to the list. The only keyboard
  // input is the workspace-level entry into the page itself.
  const h = setup({ columns: 120, rows: 40, searchProvider: undefined })
  t.after(h.dispose)
  await openWebPage(h)
  assert.match(h.view(), /Current: Automatic/u, 'the page states the AUTOMATIC current fact')
  assert.match(h.view(), /› Automatic \[current\] · the Host selects per request/u,
    'the Automatic entry is the current choice under the official automatic routing')
  const provider = paintedWordPoint(h, 'Web Search Provider')
  press(h, provider.row, provider.column)
  release(h, provider.row, provider.column)
  await h.vt.waitForRender()
  assert.match(h.view(), /Open \[Enter\]/u, 'the row click only selected the row')
  clickWord(h, 'Open [Enter]')
  await waitForPainted(h, 'the explicit Open to enter the provider Detail', frame =>
    frame.includes('Confirm [Enter]') && frame.includes('Current: Automatic'))
  const option = paintedCandidatePoint(h, 'DeepSeek Search API')
  press(h, option.row, option.column)
  release(h, option.row, option.column)
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, undefined, 'the option click only moves the draft')
  assert.match(h.view(), /› DeepSeek Search API/u)
  clickWord(h, 'Confirm [Enter]')
  await waitForPainted(h, 'the verified explicit write', frame => frame.includes('Saved'))
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api', 'the ONE real Host write landed')
  // The painted Back span (the page's own last-row Esc affordance) exits the
  // Detail to the list — pointer-only, no keyboard Esc. The Root requests a
  // render after admitting a body press, so the release resolves against the
  // child's next painted frame; the settled Saved verdict legitimately stays
  // painted on the list, so the exit is proven by the list's own bar.
  const back = paintedWordPoint(h, 'Back [Esc]')
  press(h, back.row, back.column)
  await h.vt.waitForRender()
  release(h, back.row, back.column)
  await waitForPainted(h, 'the pointer Back to return to the list', frame =>
    frame.includes('Open [Enter]') && !frame.includes('Confirm [Enter]'))
})

for (const [columns, rows] of [[120, 40], [44, 20]] as const) {
  test(`the provider Detail restores the deployment default through the complete pointer route at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openWebPage(h)
    // Row click only selects; the painted Open span enters the Detail.
    const provider = paintedWordPoint(h, 'Web Search Provider')
    press(h, provider.row, provider.column)
    release(h, provider.row, provider.column)
    await h.vt.waitForRender()
    clickWord(h, 'Open [Enter]')
    await waitForPainted(h, 'the provider Detail', frame =>
      frame.includes('Confirm [Enter]') && frame.includes('Current: DeepSeek server-side search'))
    // Option click only moves the draft to the Automatic (official reset) row.
    const option = paintedCandidatePoint(h, 'Automatic')
    press(h, option.row, option.column)
    release(h, option.row, option.column)
    await h.vt.waitForRender()
    assert.equal(h.store.web.searchProvider, 'deepseek-official', 'the option click never writes')
    assert.match(h.view(), /› Automatic · the Host selects per request/u)
    // The complete painted Confirm [Enter] is the ONE delegated reset target.
    clickWord(h, 'Confirm [Enter]')
    await waitForPainted(h, 'the verified deployment reset', frame =>
      frame.includes('Saved') && frame.includes('Current: Automatic'))
    assert.equal(h.store.web.searchProvider, undefined, 'the official unset restored the deployment selection')
    assert.equal(h.store.web.providerSelection.search.userSet, false)
    // The painted Back span returns to the list without a keyboard Esc.
    const back = paintedWordPoint(h, 'Back [Esc]')
    press(h, back.row, back.column)
    await h.vt.waitForRender()
    release(h, back.row, back.column)
    await waitForPainted(h, 'the pointer Back to the list', frame =>
      frame.includes('Open [Enter]') && !frame.includes('Confirm [Enter]'))
    for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
  })
}

test('a Confirm press followed by a key, wheel or resize never writes on release', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 0)
  await key(h, ENTER)
  await key(h, DOWN) // highlight DeepSeek Search API
  // A key between the press and the release refuses the gesture.
  let point = paintedWordPoint(h, 'Confirm [Enter]')
  press(h, point.row, point.column + 1)
  await key(h, 'r') // a Host refresh: pending facts + a new semantic frame
  release(h, point.row, point.column + 1)
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'a key between press and release never writes')
  await waitForPainted(h, 'the refreshed Detail', frame =>
    frame.includes('Confirm [Enter]') && !frame.includes('Loading…'))
  // A wheel between the press and the release refuses it, even at the list's
  // own top boundary where the selection does not move.
  await settlePointerClick(h)
  point = paintedWordPoint(h, 'Confirm [Enter]')
  press(h, point.row, point.column + 1)
  h.vt.sendInput('\x1b[<64;5;5M') // wheel up at the list top
  await h.vt.waitForRender()
  release(h, point.row, point.column + 1)
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'a wheel between press and release never writes')
  // A resize between the press and the release refuses it.
  await settlePointerClick(h)
  await waitForPainted(h, 'the settled Detail before the resize', frame => frame.includes('Confirm [Enter]'))
  point = paintedWordPoint(h, 'Confirm [Enter]')
  press(h, point.row, point.column + 1)
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h, point.row, point.column + 1)
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'a resize between press and release never writes')
  // A fresh complete gesture against the CURRENT frame writes exactly once.
  await settlePointerClick(h)
  await waitForPainted(h, 'the resized Detail', frame => frame.includes('Confirm [Enter]'))
  clickWord(h, 'Confirm [Enter]')
  await waitForPainted(h, 'the confirmed write', frame => frame.includes('Saved'))
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
})

test('a cropped candidate publishes no Confirm target and a click there writes nothing', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 2) // Search API Result Count
  await key(h, ENTER)
  await key(h, DOWN) // 10 -> 20
  assert.match(h.view(), /Confirm \[Enter\]/u)
  h.vt.resize(120, 3)
  await h.vt.waitForRender()
  const cropped = h.view()
  assert.doesNotMatch(cropped, /Confirm \[Enter\]/u, `a cropped candidate offers no Confirm:\n${cropped}`)
  const barRow = h.plain().length - 1
  press(h, barRow, 10)
  release(h, barRow, 10)
  await h.vt.waitForRender()
  assert.equal(h.store.web.api.count, 10, 'a click where Confirm was dispatches nothing')
  h.vt.resize(120, 40)
  await waitForPainted(h, 'the restored Confirm target', frame => frame.includes('Confirm [Enter]'))
  clickWord(h, 'Confirm [Enter]')
  await waitForPainted(h, 'the restored confirm write', frame => frame.includes('Saved'))
  assert.equal(h.store.web.api.count, 20)
})

for (const [columns, rows] of [[80, 24], [44, 20], [44, 8]] as const) {
  for (const iconStyle of ['symbols', 'minimal'] as const) {
    test(`the delegated Confirm [Enter] works with ${iconStyle} icons at ${columns}×${rows}`, async t => {
      const h = setup({ columns, rows, iconStyle })
      t.after(h.dispose)
      await openWebPage(h)
      await selectListRow(h, 0)
      await key(h, ENTER)
      await key(h, HOME) // Automatic -> server-side search
      await key(h, DOWN)
      const frame = h.view()
      assert.match(frame, /Confirm \[Enter\] · .*Back \[Esc\]/u,
        `the complete delegated span is painted at ${columns}x${rows}:\n${frame}`)
      for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
      clickWord(h, 'Confirm [Enter]')
      await waitForPainted(h, 'the delegated provider verdict', painted => painted.includes('No changes'))
      assert.equal(h.store.web.searchProvider, 'deepseek-official',
        'the already-pinned official provider is a validated zero-write confirmation')
    })
  }
}

test('a credential body click hands the same lease to Models without a Web write', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 8)
  await key(h, ENTER)
  const actionRow = h.plain().findIndex(line => line.includes('Configure in Models…'))
  assert.ok(actionRow >= 0, `the credential action row is painted:\n${h.view()}`)
  const actionColumn = h.plain()[actionRow]!.indexOf('Configure in Models…')
  press(h, actionRow, actionColumn + 1)
  release(h, actionRow, actionColumn + 1)
  await waitForPainted(h, 'the Models reference view', frame =>
    frame.includes('Settings · Models') && frame.includes('API Key Reference'))
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'the deeplink never writes a Web field')
  assert.doesNotMatch(h.view(), /Configure in Models…/u, 'the Web page retired into the same lease')
})

test('a Root Back press whose release follows a wheel never leaves the Web page', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  const point = paintedWordPoint(h, 'Back [Esc]')
  press(h, point.row, point.column + 1)
  h.vt.sendInput('\x1b[<64;5;5M') // wheel at the list top: no selection change, new identity
  await h.vt.waitForRender()
  release(h, point.row, point.column + 1)
  await h.vt.waitForRender()
  assert.match(h.view(), /Settings · Tools · Web Search \/ Fetch/u,
    `the stale Esc release keeps the page:\n${h.view()}`)
  // A fresh complete Back gesture still returns to the Tools rows (paced past
  // the alt screen's double-click window for the same word).
  await settlePointerClick(h)
  const fresh = paintedWordPoint(h, 'Back [Esc]')
  press(h, fresh.row, fresh.column + 1)
  release(h, fresh.row, fresh.column + 1)
  await h.vt.waitForRender()
  assert.match(h.view(), /Settings · Tools/u, 'the fresh Back returns to the Tools rows')
  assert.doesNotMatch(h.view(), /Web Search Provider/u)
})

test('an unavailable authority paints the reason and offers no Confirm', async t => {
  for (const [columns, rows] of [[120, 40], [44, 20], [44, 8]] as const) {
    const h = setup({ columns, rows })
    try {
      h.store.available = false
      await openOtherRows(h)
      await highlightWebRow(h)
      await key(h, ENTER)
      const frame = await waitForPainted(h, 'the unavailable page', frame =>
        frame.includes('Web Search Provider') && !frame.includes('Loading…'))
      assert.match(frame, /Unavailable/u, `the unreadable authority is stated:\n${frame}`)
      await key(h, ENTER) // the read-only Detail
      const detail = detailPaneText(h)
      assert.match(detail, /the Host Web provider settings are not available on this backend/u,
        'the Detail names the real reason')
      assert.doesNotMatch(h.view(), /Confirm \[Enter\]/u, 'no Confirm affordance exists without an authority')
      // A click where the Confirm span would be has no target and writes nothing.
      const barRow = h.plain().length - 1
      press(h, barRow, Math.min(20, columns - 1))
      release(h, barRow, Math.min(20, columns - 1))
      await h.vt.waitForRender()
      assert.match(h.view(), /Unavailable/u, 'the read-only page stays')
      for (const line of h.plain()) assert.ok(visibleWidth(line) <= columns)
    } finally {
      h.dispose()
    }
  }
})

test('the list region never carries a settled success word', async t => {
  const h = setup({ columns: 44, rows: 20 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 2) // Search API Result Count
  await key(h, ENTER) // Detail (single region at this width)
  await key(h, DOWN) // 10 -> 20
  await key(h, ENTER)
  await waitForPainted(h, 'the count Saved', frame => frame.includes('Saved'))
  await key(h, ESC) // back to the list region only
  const list = h.view()
  assert.match(list, /Search API Result Count/u)
  assert.doesNotMatch(list, /Saved|No changes/u,
    'the list row suppresses success words; only the selected Detail may carry one')
})

test('a replaced ready Host demotes the old Current/Saved to Last-known read-only and offers no confirm', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 2) // Search API Result Count
  await key(h, ENTER)
  await key(h, DOWN) // 10 -> 20
  await key(h, ENTER)
  await waitForPainted(h, 'the count Saved', frame => frame.includes('Current: 20') && frame.includes('Saved'))
  // B is a new ready Host generation; the page's cached A observation is no
  // longer current, even if the numeric revisions/values happen to match.
  h.store.current = { both: false, web: false, api: false }
  h.store.web.authority = { ...h.store.web.authority, generation: {} }
  h.store.web.api.count = 50
  // A real fresh read publishes B; the old A Saved receipt must retire, and
  // the ready-but-not-current facts may only be painted as read-only.
  await key(h, 'r')
  const frame = await waitForPainted(h, 'the last-known demotion',
    f => f.includes('Last-known · read-only: 50'))
  assert.doesNotMatch(frame, /Saved/u, 'A\'s receipt is retired, never painted as B\'s current save')
  assert.doesNotMatch(frame, /Confirm \[Enter\]/u, 'a non-current observation offers no confirm')
  assert.equal(h.store.web.api.count, 50, 'the stale gesture dispatched nothing')
})

test('a Root press across a published new generation dispatches nothing; the fresh count Confirm and Back are clean', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 2) // Search API Result Count
  await key(h, ENTER)
  await key(h, DOWN) // 10 -> 20
  const oldPoint = paintedWordPoint(h, 'Confirm [Enter]')
  press(h, oldPoint.row, oldPoint.column + 1)
  // A fresh read publishes B with a NEW opaque generation and the SAME
  // numeric revisions. The old press must die with the A frame; a new explicit
  // count Confirm is still target-current under B.
  h.store.web.authority = { ...h.store.web.authority, generation: {} }
  h.store.current = { both: false, web: false, api: true }
  await key(h, 'r')
  await waitForPainted(h, 'the fresh count Detail', f => f.includes('Current: 10') && f.includes('Confirm [Enter]'))
  release(h, oldPoint.row, oldPoint.column + 1)
  await h.vt.waitForRender()
  assert.equal(h.store.web.api.count, 10, 'the old A press dispatched no count write')
  await settlePointerClick(h)
  clickWord(h, 'Confirm [Enter]')
  const frame = await waitForPainted(h, 'the fresh count write', f => f.includes('Current: 20') && f.includes('Saved'))
  assert.match(frame, /Current: 20/u)
  assert.equal(h.store.web.api.count, 20, 'the fresh target-current gesture wrote exactly once')
  await key(h, '\x1b') // Back to the list
  assert.equal(h.store.web.api.count, 20, 'Back never replays the write')
  const countRow = h.plain().find(line => line.includes('> Search API Result Count'))
  assert.ok(countRow !== undefined)
  assert.doesNotMatch(countRow, /Saved|No changes/u, 'the list row does not revive A\'s or the fresh receipt')
})

test('the rail/child pair keeps ONE page instance, its scroll seat and the real return level', async t => {
  const h = setup({ columns: 80, rows: 24 })
  t.after(h.dispose)
  await openWebPage(h)
  // Child focus at 80×24 is the REAL pair `Web List(34) | Details(46)`; the
  // Categories rail has stepped aside.
  assert.match(h.view(), /\[Web Search \/ Fetch\]/u)
  assert.match(h.view(), /Current \/ Detail/u, 'the passive Detail column is still named beside the active list')
  assert.doesNotMatch(h.view(), /Categories \(10\)/u, 'the rail is not painted while the content owns the pair')
  const readsBefore = h.reads()
  // Shift+Tab from the untouched list yields to the visible rail: the SAME
  // page instance, list cursor and Host facts stay, and NO new read starts.
  await key(h, '\x1b[Z')
  await waitForPainted(h, 'the rail + list pair', frame =>
    frame.includes('[Categories (10)]') && frame.includes('Web Search Provider'))
  assert.equal(h.reads(), readsBefore, 'yielding the focus never re-reads the Host')
  assert.match(h.view(), /Categories \(10\)/u)
  // Enter returns the keyboard to the SAME child list; no remount, no read.
  await key(h, ENTER)
  await waitForPainted(h, 'the child list seat', frame =>
    frame.includes('[Web Search / Fetch]') && frame.includes('Current / Detail')
    && frame.includes('Open [Enter]'))
  assert.equal(h.reads(), readsBefore, 'returning to the child never re-reads the Host')
  // The list root's Esc returns to the REAL initiating Rows level.
  await key(h, ESC)
  assert.match(h.view(), /Settings · Tools · Rows/u, 'the page returns to the level it was opened from')
  assert.equal(h.reads(), readsBefore, 'the return itself starts no Host read')
  // Reopening from those Rows mounts ONE new page and performs its own fresh read.
  await key(h, ENTER)
  await waitForPainted(h, 'the reopened page', frame =>
    frame.includes('Web Search Provider') && !frame.includes('Loading…'))
  assert.equal(h.reads(), readsBefore + 1, 'the explicit reopen performs exactly one fresh read')
})

test('a zero-body grant keeps only the real Back and admits no hidden body action', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openWebPage(h)
  await selectListRow(h, 0)
  await key(h, ENTER) // the provider Detail owns the choice
  assert.match(h.view(), /Confirm \[Enter\]/u)
  const readsBefore = h.reads()
  h.vt.resize(120, 2)
  await h.vt.waitForRender()
  const barOnly = h.view()
  assert.match(barOnly, /Back \[Esc\]/u, 'the zero-body frame still paints the real Back')
  assert.doesNotMatch(barOnly, /Web Search Provider|Confirm \[Enter\]|Open \[Enter\]|Refresh \[R\]/u,
    `no hidden body action is advertised without a body row:\n${barOnly}`)
  // r / Tab / Enter are inert: no Host read and no hidden activation.
  await key(h, 'r')
  await key(h, '\t')
  await key(h, ENTER)
  assert.equal(h.reads(), readsBefore, 'a zero-body frame starts no Host read')
  assert.match(h.view(), /Back \[Esc\]/u)
  // The REAL Esc still runs the page's own Detail -> List ladder.
  await key(h, ESC)
  h.vt.resize(120, 40)
  await waitForPainted(h, 'the restored list seat', frame =>
    frame.includes('Open [Enter]') && frame.includes('Web Search Provider'))
  assert.match(h.view(), /Open \[Enter\]/u)

  // The RAIL seat has the same zero-body contract: only the truthful Back row,
  // no rail browse bar and no hidden Tab transfer.
  await key(h, '\x1b[Z') // list -> rail (the 120x40 pair really exists)
  await waitForPainted(h, 'the rail pair', frame => frame.includes('[Categories (10)]'))
  h.vt.resize(120, 2)
  await h.vt.waitForRender()
  const railBarOnly = h.view()
  assert.match(railBarOnly, /Back \[Esc\]/u, 'the rail zero-body frame keeps the real Back')
  assert.doesNotMatch(railBarOnly, /Up\/Down select|Tab focus|Open \[Enter\]|Web Search Provider/u,
    `the zero-body rail bar never advertises a dead key:\n${railBarOnly}`)
  await key(h, '\t')
  assert.equal(h.reads(), readsBefore, 'Tab on a zero-body rail starts no read')
  assert.match(h.view(), /Back \[Esc\]/u, 'Tab never seats a zero-body child')
  await key(h, ESC) // the rail Back leaves the workbench for the real origin
  assert.match(h.view(), /Settings · Tools · Rows/u)
  h.vt.resize(120, 40)
  await h.vt.waitForRender()
})

test('a one-region grant keeps Tab and Shift+Tab inert (44×20)', async t => {
  const h = setup({ columns: 44, rows: 20 })
  t.after(h.dispose)
  await openWebPage(h)
  const readsBefore = h.reads()
  assert.match(h.view(), /Open \[Enter\]/u)
  assert.doesNotMatch(h.view(), /Categories \(10\)/u, 'the rail is not painted in one region')
  await key(h, '\x1b[Z')
  await key(h, '\t')
  assert.equal(h.reads(), readsBefore, 'an inert Tab never re-reads the Host')
  assert.match(h.view(), /> Web Search Provider/u, 'the list keeps the one visible seat')
  assert.match(h.view(), /Open \[Enter\]/u)
  assert.doesNotMatch(h.view(), /Categories \(10\)/u, 'Tab never paints a hidden rail')
})

test('Left is the same explicit Back verb as Esc from the Detail and the list', async t => {
  const h = setup({ columns: 44, rows: 20 })
  t.after(h.dispose)
  await openWebPage(h)
  const readsBefore = h.reads()
  await selectListRow(h, 0)
  await key(h, ENTER)
  assert.match(h.view(), /Confirm \[Enter\]/u)
  await key(h, '\x1b[D') // Detail -> list
  assert.match(h.view(), /Open \[Enter\]/u)
  await key(h, '\x1b[D') // list -> the real Rows origin
  assert.match(h.view(), /Settings · Tools · Rows/u)
  assert.equal(h.reads(), readsBefore, 'the Back verb never re-reads or rebinds')
})

test('the Detail Configure Web entry returns to the Tools Detail before Rows', async t => {
  const h = setup({ columns: 120, rows: 40 })
  t.after(h.dispose)
  await openOtherRows(h)
  await highlightWebRow(h)
  const readsBefore = h.reads()
  const configure = paintedWordPoint(h, 'Configure Web…')
  press(h, configure.row, configure.column)
  release(h, configure.row, configure.column)
  await waitForPainted(h, 'the Web page from the Detail Manage entry', frame =>
    frame.includes('Web Search Provider') && !frame.includes('Loading…'))
  assert.equal(h.reads(), readsBefore + 1, 'the explicit entry performs one fresh read')
  await key(h, ESC) // list root -> the REAL Tools Detail origin
  const detail = h.view()
  assert.match(detail, /Settings · Tools · Web Search \/ Fetch/u)
  assert.match(detail, /Categories \(10\)/u)
  assert.match(detail, /Configure Web…/u, 'the row Detail owns the frame again')
  assert.equal(h.reads(), readsBefore + 1, 'the return starts no Host read')
  await key(h, ESC) // Detail -> Rows
  assert.match(h.view(), /Settings · Tools · Rows/u)
})
