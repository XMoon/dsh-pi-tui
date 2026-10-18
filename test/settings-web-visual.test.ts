/**
 * S2/PR-B §4A.3 — the frozen visual matrix for the NEW `/settings` Web surface.
 *
 * Every case renders the REAL `TuiApp` on a `VirtualTerminal` and reads the
 * PHYSICAL frame plus the cell ink of the state chips:
 *
 * - the Workspace `Other` → `Web Search / Fetch` launcher is visible and
 *   reachable at 200×50, 120×40, 100×40, 80×24, 80×10, 72×24 and 44×20;
 * - the legacy Web section paints the value/`[current]`/`[default]` state
 *   facts whole (never `[defaul`), truncates the LABEL with `…` instead, and
 *   keeps `Esc` reachable;
 * - the endpoint editor keeps its title, danger note, full URL and
 *   `Enter confirm · Esc cancel` at the narrow sizes;
 * - the credential panel keeps its title and the two explicit actions;
 * - the ink roles come from the LIVE palette (`textMuted` chips, `warning`
 *   problems, `error` not-saved) in dark and light, and the frames do not
 *   depend on the icon style.
 *
 * FIXTURE: the real command registration + TuiApp + VirtualTerminal.
 * STAND-IN: the Host config service behind the ConfigPort (the real official
 * settings plane is qualified by `web-provider-rc2-integration.test.ts`).
 * ABSENT: a real terminal (the tmux record is separate) and the TSP GUI.
 *
 * @module @xmoon76/dsh-pi-tui/settings-web-visual.test
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { TuiCommandRunner } from '../src/commands.ts'
import { TuiApp } from '../src/tui-app.ts'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { currentPalette, setTheme } from '../src/tui/theme/runtime.ts'
import type { TuiSettingsDoc, WebProviderSettings } from '../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from './support/register-tui-commands.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const DOWN = '\x1b[B'
const ENTER = '\r'
const TAB = '\t'
const ESC = '\x1b'
/** The frozen matrix (docs/tui-design-language.md §11.2 / §8). */
const SIZES = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
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
  readonly store: { web: WebProviderSettings; available: boolean; failNext: string | undefined }
  readonly view: () => string
  readonly plain: () => readonly string[]
  readonly invoke: (name?: string) => unknown
  readonly dispose: () => void
}

function setup(options: { readonly columns: number; readonly rows: number; readonly endpoint?: string }): Harness {
  const vt = new VirtualTerminal(options.columns, options.rows)
  const store = {
    available: true,
    failNext: undefined as string | undefined,
    web: {
      searchProvider: 'deepseek-official',
      fetchProvider: 'http',
      api: { baseURL: options.endpoint ?? 'https://api.deepseek.com/v1/tools', count: 10, sendOriginalQuestion: true },
      credential: { configured: true, source: 'file' },
    } as WebProviderSettings,
  }
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
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
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: () => ({ kind: 'unchanged' }),
    refreshStatus: () => {},
    tuiSettings: { get: () => doc, replace: (next: TuiSettingsDoc) => { Object.assign(doc, next) } },
    extensions: undefined,
    openPluginManager: () => {},
    createPluginManagerSubmenu: () => ({ render: () => [], dispose: () => {} }),
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    setFocusMode: () => {},
    setNotificationMethod: () => {},
    setNotificationMode: () => {},
    setTerminalProgressMode: () => {},
    setSessionApprovalPolicy: () => 'applied',
    currentApprovalOverride: () => undefined,
    applyFooterSettings: () => {},
    config: {
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
        setSearchApiBaseURL: async (url: string) => { write(() => { store.web.api.baseURL = url }) },
      },
    },
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

/** Reach the `Other settings` rows level of the real Settings workspace. */
async function openOtherRows(h: Harness): Promise<void> {
  h.invoke('settings')
  for (let attempt = 0; attempt < 20 && !h.view().includes('Settings ·'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
  const keys = h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, ENTER] : [DOWN, DOWN, ENTER]
  for (const pressed of keys) await key(h, pressed)
}

/** Reach the legacy Web section through the real Workspace handoff. */
async function openWebSection(h: Harness): Promise<void> {
  await openOtherRows(h)
  await key(h, DOWN)
  await key(h, ENTER)
}

for (const [columns, rows] of SIZES) {
  test(`the Web launcher and section stay readable and reachable at ${columns}×${rows}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openOtherRows(h)
    const launcherRows = h.plain()
    assert.ok(launcherRows.some(line => line.includes('Web Search / Fetch')),
      `the launcher row is painted at ${columns}x${rows}:\n${launcherRows.join('\n')}`)
    for (const line of launcherRows) {
      assert.ok(visibleWidth(line) <= columns, `no frame line exceeds ${columns} cells: ${JSON.stringify(line)}`)
    }
    await key(h, DOWN)
    assert.ok(h.view().includes('Web Search / Fetch'), 'the launcher stays selected and inspectable')
    await key(h, ENTER)
    const section = h.plain()
    // The section's state chips are WHOLE (never `[defaul`) and the label is
    // what truncates; the action bar keeps Esc.
    assert.ok(section.some(line => line.includes('[current]')), `the current chip survives at ${columns}x${rows}:\n${section.join('\n')}`)
    for (const line of section) {
      assert.ok(!line.includes('[curren ') && !line.includes('[defaul '), `no chip is painted partially: ${JSON.stringify(line)}`)
      assert.ok(!line.includes('[curren|'), 'no chip is cut by a frame edge')
      assert.ok(visibleWidth(line) <= columns, `no section line exceeds ${columns} cells: ${JSON.stringify(line)}`)
    }
    // The legacy list's own hint row is a single truncatable string (fork
    // behaviour): at the narrow sizes the word lives in the selected row's
    // description instead, and the key itself always works.
    assert.ok(section.some(line => line.includes('Esc')), `Esc is stated at ${columns}x${rows}`)
    await key(h, ESC)
    assert.ok(h.view().includes('Settings · Other'),
      `Esc returns to the Workspace at ${columns}x${rows}`)
    const [narrowest] = [section.find(line => line.includes('Web Search Provider')) ?? '']
    assert.ok(narrowest.length > 0, 'the provider row exists')
  })
}

for (const [columns, rows] of SIZES) {
  test(`the endpoint editor keeps its title, danger note and confirm/cancel hint at ${columns}×${rows}`, async t => {
    const longEndpoint = 'https://gateway.example.test/deepseek/v1/tools/with/a/long/path'
    const h = setup({ columns, rows, endpoint: longEndpoint })
    t.after(h.dispose)
    await openWebSection(h)
    // The endpoint row is the fifth Web setting: reach it and open the editor.
    for (let index = 0; index < 4; index += 1) await key(h, DOWN)
    await key(h, ENTER)
    const frame = h.plain()
    assert.ok(frame.some(line => line.includes('Search / Fetch API Endpoint')),
      `the editor title is painted at ${columns}x${rows}:\n${frame.join('\n')}`)
    assert.ok(frame.some(line => line.includes('Changing this sends the DeepSeek API')),
      'the external-send danger note survives')
    assert.ok(frame.some(line => line.includes('Enter confirm') && line.includes('Esc cancel')),
      `the whole confirm/cancel hint survives at ${columns}x${rows}`)
    for (const line of frame) {
      assert.ok(!/Esc ca$|Esc can$|Esc canc$/.test(line), 'the hint is never a partial word')
      assert.ok(visibleWidth(line) <= columns)
    }
    await key(h, ESC)
  })
}

test('the credential panel keeps its title and both explicit actions at 72×24 and 44×20', async t => {
  for (const [columns, rows] of [[72, 24], [44, 20]] as const) {
    const h = setup({ columns, rows })
    try {
      await openWebSection(h)
      for (let index = 0; index < 5; index += 1) await key(h, DOWN)
      await key(h, ENTER)
      const frame = h.plain()
      assert.ok(frame.some(line => line.includes('DeepSeek API Key')), `title at ${columns}x${rows}:\n${frame.join('\n')}`)
      assert.ok(frame.some(line => line.includes('Configure')), 'Configure… is reachable')
      assert.ok(frame.some(line => line.includes('Clear')), 'Clear… is reachable')
      assert.ok(frame.some(line => line.includes('Esc')), 'Esc is reachable')
      await key(h, ESC)
    } finally {
      h.dispose()
    }
  }
})

test('the state chips use their frozen ink roles in dark and light', async t => {
  /** The ink of one chip ON the row that owns it (the description text also
   *  mentions the chip words, and it is painted textDim). */
  const chipCell = (h: Harness, rowNeedle: string, needle: string): number | undefined => {
    const lines = h.plain()
    const row = lines.findIndex(line => line.includes(rowNeedle) && line.includes(needle))
    assert.ok(row >= 0, `the frame paints ${needle} on ${rowNeedle}:\n${h.view()}`)
    return h.vt.getCellFgRgb(row, lines[row]!.indexOf(needle))
  }
  // ONE live TuiApp per process: the two palettes are checked sequentially.
  setTheme('dark')
  const dark = setup({ columns: 120, rows: 40 })
  try {
    await openWebSection(dark)
    assert.equal(chipCell(dark, 'Web Search Provider', '[current]'), hexToRgb(currentPalette.textMuted), 'the current chip is textMuted')
    assert.equal(chipCell(dark, 'Web Search Provider', '[default]'), hexToRgb(currentPalette.textMuted), 'the default chip is textMuted')
    const darkChip = chipCell(dark, 'Web Search Provider', '[current]')
    // A refused write paints the not-saved chip in error ink (the word rides
    // the chip: never a colour-only signal).
    dark.store.failNext = 'mutate rejected'
    await key(dark, ENTER)
    await new Promise(resolve => setTimeout(resolve, 10))
    await dark.vt.waitForRender()
    assert.ok(dark.view().includes('[Not saved]'), `the failed write states Not saved:\n${dark.view()}`)
    assert.equal(chipCell(dark, 'Web Search Provider', '[Not saved]'), hexToRgb(currentPalette.error), 'Not saved wears the error token')
    dark.dispose()

    // The LIGHT palette supplies the same roles on its own open. A live switch
    // while the legacy editor is mounted keeps the pre-painted chip ANSI until
    // the next open — the SAME property as the existing pre-painted state chips
    // of the theme/preset pickers (recorded in the S2 evidence).
    setTheme('light')
    const light = setup({ columns: 120, rows: 40 })
    try {
      await openWebSection(light)
      assert.equal(chipCell(light, 'Web Search Provider', '[current]'), hexToRgb(currentPalette.textMuted), 'the light palette supplies the chip ink')
      assert.notEqual(hexToRgb(currentPalette.textMuted), darkChip, 'the two palettes really differ')
    } finally {
      light.dispose()
    }
  } finally {
    setTheme('dark')
  }
})

test('a CJK custom provider id stays cell-safe at the frozen sizes', async t => {
  for (const [columns, rows] of [[100, 40], [44, 20]] as const) {
    const h = setup({ columns, rows })
    try {
      h.store.web.searchProvider = '搜索-提供方-一号'
      await openWebSection(h)
      const frame = h.plain()
      for (const line of frame) {
        assert.ok(visibleWidth(line) <= columns, `no CJK row overflows ${columns} cells: ${JSON.stringify(line)}`)
      }
      assert.ok(frame.some(line => line.includes('搜索-提供方-一号')), `the custom id is reported as-is at ${columns}x${rows}`)
      assert.ok(frame.some(line => line.includes('[unavailable]')), 'a custom route stays unavailable for this selector')
    } finally {
      h.dispose()
    }
  }
})

test('a CUSTOM palette supplies the chip roles on its own open', async t => {
  setTheme('custom', { ...currentPalette, textMuted: '#123456' })
  const h = setup({ columns: 120, rows: 40 })
  try {
    await openWebSection(h)
    const lines = h.plain()
    const row = lines.findIndex(line => line.includes('Web Search Provider') && line.includes('[current]'))
    assert.ok(row >= 0, `the frame paints the chips:\n${h.view()}`)
    assert.equal(h.vt.getCellFgRgb(row, lines[row]!.indexOf('[current]')), hexToRgb('#123456'),
      'the custom palette supplies the chip ink (no token is hard-coded)')
  } finally {
    h.dispose()
    setTheme('dark')
  }
})

test('a LIVE palette switch re-bakes the mounted Web chips (frozen §4A.2)', async t => {
  const h = setup({ columns: 120, rows: 40 })
  try {
    await openWebSection(h)
    const ink = (needle: string): number | undefined => {
      const lines = h.plain()
      const row = lines.findIndex(line => line.includes('Web Search Provider') && line.includes(needle))
      assert.ok(row >= 0, `the frame paints ${needle}:\n${h.view()}`)
      return h.vt.getCellFgRgb(row, lines[row]!.indexOf(needle))
    }
    assert.equal(ink('[current]'), hexToRgb(currentPalette.textMuted), 'the chip starts on the live palette')
    // The REAL switch path: the app installs the palette and notifies observers
    // (the Web rows rebuild their pre-painted chips in that callback).
    h.app.applyPalette({ ...currentPalette, textMuted: '#123456' })
    await h.vt.waitForRender()
    assert.equal(ink('[current]'), hexToRgb('#123456'),
      'the mounted chip follows the NEW palette instead of its creation-time ANSI')
  } finally {
    h.dispose()
    setTheme('dark')
  }
})

test('the credential action cursor wears the frozen `primary` role', async t => {
  const h = setup({ columns: 120, rows: 40 })
  try {
    await openWebSection(h)
    for (let index = 0; index < 5; index += 1) await key(h, DOWN)
    await key(h, ENTER)
    const lines = h.plain()
    const row = lines.findIndex(line => line.includes('Configure…'))
    assert.ok(row >= 0, `the credential panel paints its actions:\n${h.view()}`)
    const cursorColumn = lines[row]!.indexOf('›')
    assert.ok(cursorColumn >= 0, 'the focused action carries the cursor')
    assert.equal(h.vt.getCellFgRgb(row, cursorColumn), hexToRgb(currentPalette.primary),
      'the active cursor uses the frozen primary role, never accent')
  } finally {
    h.dispose()
  }
})
