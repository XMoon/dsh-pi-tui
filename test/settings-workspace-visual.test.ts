/**
 * Phase 3B / B2-A — the fullscreen Settings workspace (implementation plan v1
 * §9 A-01…A-15, §10 visual evidence).
 *
 * Every case drives the REAL composition: the registered `/settings` command,
 * the real `TuiApp` screen lease, a `VirtualTerminal` and the real read
 * projection over the ConfigPort / DisplayState seams. The only substitutions
 * are the external Host-ish seams a unit composition cannot own (the settings
 * document, the display preset and the theme registry), exactly like the
 * existing `/settings` command-entry suites.
 *
 * The layout/state assertions read what the terminal PHYSICALLY painted
 * (row order, cell columns, truecolor attributes, SGR press/release identity),
 * never a pure `render()` return.
 *
 * @module @xmoon76/dsh-pi-tui/settings-workspace-visual.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../src/tui-app.ts'
import { currentPalette, setTheme } from '../src/tui/theme/runtime.ts'
import { ThemeRegistry } from '../src/extension/internal/theme-registry.ts'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from './support/register-tui-commands.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
  // `setTheme` mutates the process-wide palette: leave the dark default behind
  // so a later case never inherits this one's live theme switch.
  setTheme('dark')
})

const DEFAULT_DOC: TuiSettingsDoc = {
  theme: 'auto',
  iconStyle: 'symbols',
  footer: 'default',
  fullscreen: 'off',
  busyEnter: 'queue',
  localShellSandbox: 'off',
  homeEndKeys: 'default',
  notificationMode: 'unfocused',
  notificationMethod: 'auto',
  terminalProgress: '9;4+7501',
  wheelScrollLines: '1',
}

interface HarnessOptions {
  columns?: number
  rows?: number
  /** The settings document; `undefined` with `settingsService: false` means the
   *  port has no settings service at all. */
  doc?: Partial<TuiSettingsDoc>
  settingsService?: boolean
  readiness?: 'ready' | 'stale' | 'unavailable'
  throwOnGet?: boolean
  displayPreset?: string
  themes?: ThemeRegistry
  /** The live clipboard strategy; a promise lets a case hold the settlement. */
  copySelection?: (text: string) => Promise<boolean>
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly copied: string[]
  /** The live settings document the projection reads. */
  readonly doc: TuiSettingsDoc
  readonly invoke: (name?: string) => unknown
  readonly open: () => Promise<void>
  readonly rowsPlain: () => string[]
  readonly view: () => string
  /** How many times the projection read the live document. */
  readonly reads: () => number
  /** Every byte the app wrote to the terminal (the raw write sink). */
  readonly writes: () => readonly string[]
  readonly dispose: () => void
}

function setup(options: HarnessOptions = {}): Harness {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, rows)
  const copied: string[] = []
  const writes: string[] = []
  let reads = 0
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC, ...options.doc }
  // A real owned runner: the copy intent must travel the production `runOwned`
  // ownership path instead of a stubbed promise.
  const owned: OwnedRunner = (_label, task, runOptions) => {
    void Promise.resolve()
      .then(() => task())
      .then(
        result => runOptions.onResult?.(result),
        error => runOptions.onError?.(error),
      )
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string): void => { writes.push(data); originalWrite(data) }
  const app = new TuiApp(vt, events, {
    copySelection: options.copySelection ?? (async (text: string) => { copied.push(text); return true }),
  })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    // A sessionless surface: the completion install and the legacy session rows
    // must see no live scope.
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    listScopedCommands: () => [],
    displayPreset: () => options.displayPreset ?? 'full',
    focusEnabled: () => options.displayPreset === 'focus',
    tuiSettings: options.settingsService === false
      ? undefined
      : {
          get: () => {
            reads += 1
            if (options.throwOnGet === true) throw new Error('settings read exploded')
            return doc
          },
          replace: () => undefined,
        },
    extensions: options.themes === undefined ? undefined : { themes: options.themes },
    openPluginManager: () => {},
    createPluginManagerSubmenu: () => ({ render: () => [], dispose: () => {} }),
    config: {
      configReadiness: () => options.readiness ?? 'ready',
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
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
  const open = async (): Promise<void> => {
    invoke('settings')
    await vt.waitForRender()
  }
  const rowsPlain = (): string[] => vt.getViewport().map(stripTerminalSequences)
  const view = (): string => rowsPlain().join('\n')
  const dispose = (): void => {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
  return { vt, app, copied, doc, invoke, open, rowsPlain, view, reads: () => reads, writes: () => writes, dispose }
}

const rowOf = (h: Harness, needle: string): number => {
  const row = h.rowsPlain().findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${h.view()}`)
  return row
}

/** The terminal-CELL column of the first painted occurrence of `needle`. */
const cellIndexOf = (h: Harness, row: number, needle: string): number => {
  const plain = h.rowsPlain()[row]
  assert.ok(plain !== undefined, `row ${row} must be painted:\n${h.view()}`)
  const index = plain.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}: ${JSON.stringify(plain)}`)
  return visibleWidth(plain.slice(0, index))
}

/** One native SGR left-button gesture (1-based terminal cells). */
const press = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`) }
const release = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`) }
const wheel = (h: Harness, row: number, col: number, down = true): void => {
  h.vt.sendInput(`\x1b[<${down ? 65 : 64};${col + 1};${row + 1}M`)
}

async function settle(h: Harness, rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  await h.vt.waitForRender()
}

const key = async (h: Harness, data: string): Promise<void> => {
  h.vt.sendInput(data)
  await h.vt.waitForRender()
}

const pluginThemes = (): ThemeRegistry => {
  const themes = new ThemeRegistry()
  themes.register({ id: 'solarized', name: 'Solarized', palette: { text: '#123456' } as never }, 'acme-owner', 'acme')
  return themes
}

const hexToRgb = (hex: string): number =>
  (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)

const assertRowWidths = (h: Harness, columns: number): void => {
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= columns, `row ${index} must fit ${columns} cells: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

// ── A-01: the dedicated fullscreen workspace ───────────────────────────────

test('A-01 /settings enters a dedicated fullscreen workspace: Settings chrome owns the frame, no editor row behind it', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.vt.waitForRender()
  assert.match(h.view(), /❯/, 'the regular editor seat is painted before opening')
  await h.open()
  const rows = h.rowsPlain()
  assert.ok(rows[0]?.startsWith('SETTINGS'), `the Settings header owns row 0:\n${h.view()}`)
  assert.ok(!h.view().includes('❯'), `no editor/transcript row may render behind the workspace:\n${h.view()}`)
  assert.match(rows.at(-1) ?? '', /^Esc close/, 'the Settings Action Bar is pinned to the physical last row')
  assert.match(h.view(), /SETTINGS \(2\)/, 'the row list column is part of the workspace body')
  h.dispose()
})

// ── A-02 / A-03: the wide and medium projections ──────────────────────────

test('A-02 200x60 and 160x40 paint the three-column projection with the real value/source facts', async () => {
  for (const [columns, rows] of [[200, 60], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
    await h.open()
    const paneRow = rowOf(h, 'CATEGORIES (3)')
    const paneLine = h.rowsPlain()[paneRow]!
    assert.match(paneLine, /SETTINGS \(2\)/, 'the middle column is the current category rows')
    assert.match(paneLine, /DETAILS/, 'the third column is the detail pane')
    assert.match(h.view(), /Solarized/, 'the friendly theme label is in the detail')
    assert.match(h.view(), /plugin:acme\/solarized/, 'the raw source-qualified identity is the copy source')
    assertRowWidths(h, columns)
    h.dispose()
  }
})

test('A-03 120x40 and 100x24 paint two columns and the header arrows switch category by key and by mouse', async () => {
  for (const [columns, rows] of [[120, 40], [100, 24]] as const) {
  const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(h.rowsPlain().some(line => line.includes('SETTINGS (2)')), `the rows column exists:\n${h.view()}`)
  assert.ok(!h.view().includes('CATEGORIES (3)'), 'the medium projection has no category column')
  assert.match(h.rowsPlain()[0]!, /← category →/, 'the header carries the category switch')
  // Keyboard: cycle to the category focus owner, then move right.
  await key(h, '\t')
  await key(h, '\t')
  assert.match(h.rowsPlain()[0]!, /\[← category →\]/, 'the category focus owner is marked by brackets')
  await key(h, '\x1b[C')
  assert.match(h.rowsPlain()[0]!, /Display/, 'Right switches the category under the category focus owner')
  await key(h, '\x1b[D')
  assert.match(h.rowsPlain()[0]!, /Appearance/)
  // The category focus owner must NOT change category while the rows own focus.
  await key(h, '\t') // categories -> rows
  await key(h, '\x1b[C')
  assert.match(h.rowsPlain()[0]!, /Appearance/, 'Right on the row list never switches category')
  // Mouse: the painted arrow glyph is a real hit target.
  await key(h, '\t') // rows -> detail
  await key(h, '\t') // detail -> categories
  const nextCol = cellIndexOf(h, 0, '→')
  press(h, 0, nextCol)
  release(h, 0, nextCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Display/, 'the painted arrow is a real mouse target')
  h.dispose()
  }
})

// ── A-04: the narrow drill-down ───────────────────────────────────────────

test('A-04 80x24 drills categories → rows → detail with one Esc per level and a final close', async () => {
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/)
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance · Rows/)
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance \/ Configured theme/)
  assert.match(h.view(), /plugin:acme\/solarized/, 'the detail shows the exact source value')
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'Esc returns to the rows level')
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /Categories/, 'Esc returns to the categories level')
  await key(h, '\x1b')
  assert.ok(h.view().includes('❯'), `Esc at the root closes to the editor:\n${h.view()}`)
  h.dispose()
})

test('A-04b 44x8 still reaches the Detail, keeps the Action Bar last and copies a long value', async () => {
  const longTheme = 'file:a-very-long-custom-theme-name-that-must-wrap-across-cells'
  const h = setup({ columns: 44, rows: 8, doc: { theme: longTheme } })
  await h.open()
  assert.match(h.rowsPlain().at(-1) ?? '', /^Esc /, 'the Action Bar is the physical last row')
  await key(h, '\r') // categories -> rows (Appearance)
  await key(h, '\r') // rows -> detail (Configured theme)
  assert.match(h.rowsPlain()[0]!, /Appearance \/ Configure/)
  assert.match(h.view(), /Value/, 'the Detail keeps its value field reachable at 44x8')
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [longTheme], 'the copied payload is the exact raw value, never the wrapped display')
  h.dispose()
})

// ── A-05: the extreme-height allocation ───────────────────────────────────

test('A-05 every height keeps the pinned bar last, grants a real body from 3 rows, and Esc always escapes', async () => {
  for (const rows of [1, 2, 3, 4, 5, 8, 10, 24]) {
    const h = setup({ columns: 80, rows })
    await h.open()
    const painted = h.rowsPlain()
    assert.equal(painted.length, rows, `the frame must paint exactly ${rows} rows`)
    assert.match(painted.at(-1) ?? '', /^Esc /, `the Action Bar is pinned at rows=${rows}`)
    if (rows >= 3) {
      assert.ok(painted.some(line => line.includes('Appearance')), `at least one real body row at rows=${rows}:\n${h.view()}`)
    }
    await key(h, '\x1b')
    assert.ok(h.view().includes('❯') || !h.view().includes('SETTINGS'), `Esc must escape at rows=${rows}:\n${h.view()}`)
    h.dispose()
  }
})

// ── A-06: resize only re-projects ─────────────────────────────────────────

test('A-06 200 → 80 → 44 → 120 preserves the category, the row, the level and the focus', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'plugin:acme/solarized', iconStyle: 'symbols' }, themes: pluginThemes() })
  await h.open()
  await key(h, '\t') // rows -> detail
  await key(h, '\t') // detail -> categories
  await key(h, '\x1b[B') // Appearance -> Display
  assert.match(h.rowsPlain()[0]!, /Display/)
  h.vt.resize(80, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Categories/, 'a wide category focus projects to the narrow categories level')
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display · Rows/, 'the selected category survives the resize')
  h.vt.resize(44, 24)
  await h.vt.waitForRender()
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Transcript d/, 'the selected row survives the resize')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display/, 'the wide projection returns on the same detail context')
  assert.match(h.view(), /Transcript display/, 'the narrow detail level upgrades to the same row')
  assertRowWidths(h, 200)
  h.dispose()
})

// ── A-07: hostile external text ───────────────────────────────────────────

test('A-07 hostile OSC/CSI/CJK theme text is sanitized before paint, wrapped to the pane, and copied verbatim', async () => {
  const hostile = `evil\x1b[31mred\x07payload-${'汉'.repeat(60)}`
  const h = setup({ columns: 80, rows: 24, doc: { theme: hostile } })
  await h.open()
  await key(h, '\r') // categories -> rows
  await key(h, '\r') // rows -> detail
  const plain = h.view()
  assert.ok(!plain.includes('\x1b'), 'no raw escape sequence may reach the terminal text')
  assert.ok(!plain.includes('[31m'), 'the CSI sequence must be stripped whole, never left as visible payload')
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 80, `row ${index} must stay inside the pane width`)
  }
  // RAW terminal-write safety: the terminal's own write sink is the witness (a
  // parsed viewport would already have interpreted the sequences). The whole
  // hostile value must never be emitted, nor its raw CSI/BEL/C1 bytes.
  const emitted = h.writes().join('')
  assert.ok(!emitted.includes(hostile), 'the raw hostile value must never reach the terminal')
  assert.ok(!emitted.includes('\x1b[31m'), 'the injected CSI must never reach the terminal')
  assert.ok(!emitted.includes('\x07payload'), 'the injected BEL must never reach the terminal')
  assert.ok(!emitted.includes('\u009b'), 'the injected C1 byte must never reach the terminal')
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [`file:${hostile}`], 'the copy payload is the EXACT normalized source value, byte for byte')
  h.dispose()
})

// ── A-08: read provenance and currentness ─────────────────────────────────

test('A-08 the ready snapshot distinguishes the raw theme identity, the runtime preset and its persisted last-read', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'plugin:acme/solarized', displayPreset: 'compact' },
    displayPreset: 'full',
    themes: pluginThemes(),
  })
  await h.open()
  assert.match(h.view(), /plugin:acme\/solarized/, 'the raw source-qualified theme id is shown')
  assert.match(h.view(), /Solarized/, 'the friendly label is shown beside it')
  assert.match(h.view(), /TUI settings document/, 'the configured scope is stated')
  assert.match(h.view(), /Config READY/, 'the header states the live readiness')
  // Display: the runtime value is the current one; the persisted preference is a
  // separate last-read fact and never overwrites it.
  await key(h, '\t') // rows -> detail
  await key(h, '\t') // detail -> categories
  await key(h, '\x1b[B') // Appearance -> Display (its first row is Transcript display)
  await key(h, '\t') // categories -> rows
  await key(h, '\t') // rows -> detail
  assert.match(h.view(), /Client runtime · optional TUI preference persistence/)
  assert.match(h.view(), /Persisted preference: compact \(last read/, 'the persisted fact is named as last-read')
  h.dispose()
})

test('A-08b stale and unavailable backends keep the last-known document but never claim it current', async () => {
  for (const readiness of ['stale', 'unavailable'] as const) {
    const h = setup({ columns: 120, rows: 40, doc: { theme: 'dark' }, readiness })
    await h.open()
    assert.match(h.view(), new RegExp(`Config ${readiness.toUpperCase()}`), 'the header names the readiness')
    assert.match(h.view(), /Last-known value/)
    assert.ok(!h.view().includes('Ready · on-open snapshot'), 'a stale doc is never presented as ready')
    h.dispose()
  }
})

test('A-08c a missing document and a throwing read are distinct explicit states, never fabricated defaults', async () => {
  const missing = setup({ columns: 120, rows: 40, settingsService: false })
  await missing.open()
  assert.match(missing.view(), /Unavailable — no authoritative config document/)
  assert.ok(!/Value\s+auto/.test(missing.view()), 'the built-in fallback must never appear as the current value')
  missing.dispose()

  const throwing = setup({ columns: 120, rows: 40, throwOnGet: true })
  await throwing.open()
  assert.match(throwing.view(), /Config READY/, 'the backend itself is reachable')
  await key(throwing, '\t')
  assert.match(throwing.view(), /Read error/, 'the throwing read is surfaced as a read error')
  assert.match(throwing.view(), /settings read exploded/, 'the real error text is reachable in the detail')
  throwing.dispose()
})

// ── A-09: the painted mouse identity ──────────────────────────────────────

test('A-09 SGR press/release hits the same painted row; a repaint between press and release is refused', async () => {
  const h = setup({ columns: 120, rows: 40, doc: { iconStyle: 'minimal' } })
  await h.open()
  const iconRow = rowOf(h, 'Icon style')
  assert.ok(h.rowsPlain()[iconRow]!.trimStart().startsWith('Icon style'), 'Icon style starts unselected')
  const col = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, col)
  release(h, iconRow, col)
  await h.vt.waitForRender()
  assert.ok(h.rowsPlain()[iconRow]!.startsWith('>'), 'the same-cell click selects the painted row')
  assert.match(h.view(), /minimal/, 'the detail follows the newly selected row')

  // Press on Configured theme, repaint (resize), then release on the old cell:
  // the target identity no longer matches, so the click must be refused.
  const themeRow = rowOf(h, 'Configured theme')
  const themeCol = cellIndexOf(h, themeRow, 'Configured theme')
  press(h, themeRow, themeCol)
  h.vt.resize(80, 24)
  await h.vt.waitForRender()
  release(h, themeRow, themeCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'the narrow projection replaced the medium row list')
  assert.ok(h.rowsPlain()[rowOf(h, 'Icon style')]!.startsWith('>'), 'the stale release activated nothing')
  assert.match(h.rowsPlain()[rowOf(h, 'Configured theme')]!, /^\s+Configured theme/, 'the stale release did not re-select the pressed row')
  h.dispose()
})

test('A-09b the wheel scrolls only the pane under the pointer, and blank chrome is inert', async () => {
  const h = setup({ columns: 120, rows: 10, doc: { theme: 'dark' } })
  await h.open()
  const before = h.view()
  // Wheel over the row pane must not scroll the detail pane.
  const themeRow = rowOf(h, 'Configured theme')
  wheel(h, themeRow, cellIndexOf(h, themeRow, 'Configured theme'), false)
  await h.vt.waitForRender()
  assert.equal(h.view(), before, 'a row-pane wheel leaves the detail viewport untouched')
  // Wheel over the detail pane scrolls it.
  wheel(h, themeRow, 70, true)
  await h.vt.waitForRender()
  assert.notEqual(h.view(), before, 'a detail-pane wheel moves the detail viewport')
  // A blank rule row is inert.
  const ruleRow = h.rowsPlain().findIndex((line, index) => index > 0 && /^─+$/.test(line))
  const stable = h.view()
  press(h, ruleRow, 4)
  release(h, ruleRow, 4)
  await h.vt.waitForRender()
  assert.equal(h.view(), stable, 'a click on non-interactive chrome changes nothing')
  h.dispose()
})

// ── A-10: exact copy and scoped feedback ──────────────────────────────────

test('A-10 Copy sends the exact source value and its settlement is visible inside the workspace', async () => {
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, ['plugin:acme/solarized'], 'the copy payload is the raw identity, never the friendly label')
  assert.ok(h.rowsPlain().some(line => line.includes('Copy sent')), `the notice is painted inside the workspace:\n${h.view()}`)
  h.dispose()
})

test('A-10b a copy settled after the workspace closed never notifies the restored surface', async () => {
  let settleCopy: ((ok: boolean) => void) | undefined
  const h = setup({
    columns: 80,
    rows: 24,
    doc: { theme: 'dark' },
    copySelection: async (text: string) => {
      h.copied.push(text)
      return new Promise<boolean>(resolve => { settleCopy = resolve })
    },
  })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  await key(h, 'c')
  await key(h, '\x1b') // detail -> rows
  await key(h, '\x1b') // rows -> categories
  await key(h, '\x1b') // close the workspace before the clipboard settles
  assert.ok(h.view().includes('❯'), 'the editor is restored')
  settleCopy?.(true)
  await settle(h)
  assert.equal(h.app.notifyTextForTest(), '', 'a stale copy must not notify the new surface')
  h.dispose()
})

// ── A-11: the legacy compatibility bridge ─────────────────────────────────

test('A-11 Other settings opens the existing complete editor after retiring the workspace, and Esc returns', async () => {
  const h = setup({ columns: 120, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\t')
  await key(h, '\t')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  assert.match(h.rowsPlain()[0]!, /Other settings/)
  await key(h, '\r')
  await key(h, '\r')
  const legacy = h.view()
  assert.match(legacy, /Type to search/, `the legacy SettingsList is the physical owner:\n${legacy}`)
  assert.ok(!legacy.includes('Read-only preview'), 'the workspace is gone, not stacked underneath')
  await key(h, '\x1b')
  assert.ok(h.view().includes('❯'), 'closing the legacy editor returns to the conversation')
  h.dispose()
})

// ── A-12: the return surface ──────────────────────────────────────────────

test('A-12 Esc restores the SAME return surface: the editor draft, the regular footer and the fullscreen mode', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.vt.waitForRender()
  for (const ch of 'draft text') await key(h, ch)
  assert.ok(h.view().includes('draft text'), 'the draft is in the editor before opening')
  await h.open()
  assert.ok(!h.view().includes('draft text'), 'the workspace hides the editor')
  await key(h, '\x1b')
  assert.ok(h.view().includes('draft text'), 'the same editor draft survives the round trip')

  // Fullscreen round trip: the user's display mode is never touched.
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  assert.notEqual(h.app.fullscreenScrollForTest(), undefined, 'the transcript alt screen is the owner')
  await h.open()
  await key(h, '\x1b')
  assert.notEqual(h.app.fullscreenScrollForTest(), undefined, 'the fullscreen preference is untouched')
  assert.ok(h.view().includes('draft text'), 'the fullscreen transcript returns with its draft')
  h.dispose()
})

// ── A-15: live theme tokens ───────────────────────────────────────────────

test('A-15 the workspace chrome paints the live palette tokens (dark → light)', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.open()
  const darkPrimary = h.vt.getCellFgRgb(0, 0)
  assert.equal(darkPrimary, hexToRgb(currentPalette.primary), 'the SETTINGS wordmark uses the live primary token')
  const ruleRow = h.rowsPlain().findIndex(line => /^─+$/.test(line))
  assert.equal(h.vt.getCellFgRgb(ruleRow, 2), hexToRgb(currentPalette.border), 'the visual rule uses the border token')
  setTheme('light')
  h.app.requestRender(true)
  await h.vt.waitForRender()
  assert.equal(h.vt.getCellFgRgb(0, 0), hexToRgb(currentPalette.primary), 'the wordmark follows the light palette')
  assert.notEqual(hexToRgb(currentPalette.primary), darkPrimary, 'the two palettes really differ')
  h.dispose()
})

// ── F1: the painted mouse path really navigates and copies ────────────────

test('F1-01 narrow category/row clicks drill down exactly like Enter', async () => {
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  const displayRow = rowOf(h, 'Display')
  const displayCol = cellIndexOf(h, displayRow, 'Display')
  press(h, displayRow, displayCol)
  release(h, displayRow, displayCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display · Rows/, 'a category click enters its rows')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  const rowIndex = rowOf(h, 'Transcript display')
  const rowCol = cellIndexOf(h, rowIndex, 'Transcript display')
  press(h, rowIndex, rowCol)
  release(h, rowIndex, rowCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display \/ Transcript display/, 'a row click enters its detail')
  h.dispose()
})

test('F1-02 the painted Copy button copies while the row list owns the keyboard focus', async () => {
  const h = setup({ columns: 120, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(!/C copy value/.test(h.rowsPlain().at(-1) ?? ''), 'C is never advertised outside the Detail view')
  const buttonRow = rowOf(h, '[Copy value]')
  const buttonCol = cellIndexOf(h, buttonRow, '[Copy value]')
  press(h, buttonRow, buttonCol)
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, ['plugin:acme/solarized'], 'the painted mouse button copies without the Detail focus owner')
  assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /\[DETAILS\]/, 'the clicked column becomes the keyboard owner')
  h.dispose()
})

test('F1-03 a click anywhere in a column takes that column focus', async () => {
  const h = setup({ columns: 120, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[rowOf(h, 'SETTINGS (2)')]!, /\[SETTINGS \(2\)\]/, 'the row list owns focus at open')
  const detailRow = rowOf(h, 'Value')
  press(h, detailRow, 100) // inside the Detail pane, away from the Copy button
  release(h, detailRow, 100)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /\[DETAILS\]/, 'clicking the Detail column focuses it')
  h.dispose()
})

// ── F2: the row grant and the actual paint/admission agree ────────────────

test('F2-01 120x3 paints real content in its only body row, not pane headers', async () => {
  const h = setup({ columns: 120, rows: 3, doc: { theme: 'dark' } })
  await h.open()
  const painted = h.rowsPlain()
  assert.equal(painted.length, 3)
  assert.ok(painted.some(line => line.includes('Configured theme')), `the only body row is real content:\n${h.view()}`)
  assert.ok(!painted.some(line => line.includes('CATEGORIES (3)')), 'the pane header yields to the content row')
  h.dispose()
})

test('F2-02 below the body floor Enter/Tab/arrows/C/R are inert; only Esc escapes', async () => {
  const h = setup({ columns: 80, rows: 2, doc: { theme: 'dark' } })
  await h.open()
  const before = h.view()
  const readsBefore = h.reads()
  for (const data of ['\r', '\t', '\x1b[B', '\x1b[C', 'c', 'r']) await key(h, data)
  assert.equal(h.view(), before, 'no hidden action may change the frame below the body floor')
  assert.deepEqual(h.copied, [], 'C never copies below the body floor')
  assert.equal(h.reads(), readsBefore, 'R never re-reads below the body floor')
  await key(h, '\x1b')
  assert.ok(!h.view().includes('SETTINGS'), 'Esc still escapes at two rows')
  h.dispose()
})

test('F2-03 80x3 paints no Copy button and publishes no Copy hit', async () => {
  const h = setup({ columns: 80, rows: 3, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // categories -> rows
  await key(h, '\r') // rows -> detail
  assert.ok(!h.view().includes('[Copy value]'), `the button is not painted at 80x3:\n${h.view()}`)
  const valueRow = rowOf(h, 'Value')
  press(h, valueRow, 0)
  release(h, valueRow, 0)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a click on an unpainted button cell copies nothing')
  h.dispose()
})

// ── F3: a gesture spanning a data change is refused ───────────────────────

test('F3 a release after Refresh is refused instead of copying the newer value', async () => {
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r') // detail
  const buttonRow = rowOf(h, '[Copy value]')
  const buttonCol = cellIndexOf(h, buttonRow, '[Copy value]')
  press(h, buttonRow, buttonCol)
  h.doc.theme = 'light'
  await key(h, 'r') // refresh: the row value changes and the state version bumps
  assert.match(h.view(), /light/, 'R really re-read the new value')
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, [], 'the stale press must not copy the refreshed value')
  // Positive control: the same gesture without an intervening change copies.
  // A DIFFERENT cell inside the same painted button keeps it a single click
  // (the fork's 500 ms double-click window would otherwise turn the second
  // click at the same cell into a word selection).
  const settledRow = rowOf(h, '[Copy value]')
  const settledCol = cellIndexOf(h, settledRow, '[Copy value]') + 5
  press(h, settledRow, settledCol)
  release(h, settledRow, settledCol)
  await settle(h)
  assert.deepEqual(h.copied, ['light'], 'an unchanged gesture still copies')
  h.dispose()
})

// ── F4: the wheel owns its own viewport ───────────────────────────────────

test('F4 the wheel scrolls the pane under the pointer without pulling the selection back', async () => {
  const h = setup({ columns: 80, rows: 4, doc: { theme: 'dark' } })
  await h.open()
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  assert.ok(!h.view().includes('Other settings'), 'the third category starts out of view')
  wheel(h, rowOf(h, 'Appearance'), 4, true)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Other settings'), `the wheel scrolled the list:\n${h.view()}`)
  assert.ok(!h.view().includes('> Appearance'), 'the selection left the viewport instead of forcing a rebase')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Other settings')), 'a selection change still rebases to the selected row')
  h.dispose()
})

// ── F5: unknown persistence is never presented as "not set" ───────────────

test('F5 an unreadable document never fabricates a "not set" persisted preference', async () => {
  const missing = setup({ columns: 120, rows: 40, settingsService: false })
  await missing.open()
  await key(missing, '\t')
  await key(missing, '\t')
  await key(missing, '\x1b[B') // categories -> Display
  await key(missing, '\t')
  await key(missing, '\t') // rows -> detail
  const missingView = missing.view().replace(/\s+/g, ' ')
  assert.match(missingView, /Persisted preference unknown/, 'absence is an unknown persistence state')
  assert.ok(!missingView.includes('Persisted preference: not set'), 'absence is never "read and not configured"')
  missing.dispose()

  const throwing = setup({ columns: 120, rows: 40, throwOnGet: true })
  await throwing.open()
  await key(throwing, '\t')
  await key(throwing, '\t')
  await key(throwing, '\x1b[B')
  await key(throwing, '\t')
  await key(throwing, '\t')
  const throwingView = throwing.view().replace(/\s+/g, ' ')
  assert.match(throwingView, /Persisted preference unknown — the TUI settings document could not be read/)
  assert.match(throwingView, /settings read exploded/, 'the real read error is reachable')
  throwing.dispose()
})

// ── F6: raw values are escaped, never silently folded ─────────────────────

test('F6 a raw source value with a line break renders a visible escape distinct from a space', async () => {
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'file:a\nb' } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  assert.ok(h.view().includes('file:a\\nb'), `the newline renders as a visible escape:\n${h.view()}`)
  assert.ok(!h.view().includes('file:a b'), 'it must not be indistinguishable from an ordinary space')
  h.dispose()
})

// ── F9 extras: the remaining matrix controls ──────────────────────────────

test('A-02b the wide geometry is exact and a 300-char value never squeezes the Action Bar', async () => {
  const long = `file:${'x'.repeat(300)}`
  const h = setup({ columns: 200, rows: 60, doc: { theme: long } })
  await h.open()
  const paneRow = rowOf(h, 'CATEGORIES (3)')
  assert.equal(cellIndexOf(h, paneRow, 'CATEGORIES (3)'), 0, 'the category column starts at cell 0')
  assert.equal(cellIndexOf(h, paneRow, '[SETTINGS (2)]'), 22 + 2, 'the row column starts after the 22-cell column and a 2-cell gap (the focused pane is bracketed)')
  assert.equal(cellIndexOf(h, paneRow, 'DETAILS'), 22 + 2 + 42 + 2, 'the detail column starts after the 42-cell row column and a 2-cell gap')
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 200, `row ${index} must fit the terminal`)
  }
  assert.match(h.rowsPlain().at(-1) ?? '', /^Esc close/, 'the Action Bar stays the last physical row')
  await key(h, '\r') // rows: Configured theme -> detail focus (medium? wide: Enter moves focus)
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  assert.match(h.view().replace(/\s+/g, ''), /x{100}/, 'the long value is wrapped and readable in the Detail')
  h.dispose()
})

test('A-10c the copy failure paths report inside the workspace instead of a false success', async () => {
  for (const failing of [async () => false, async () => { throw new Error('clipboard refused') }]) {
    const h = setup({ columns: 80, rows: 24, doc: { theme: 'dark' }, copySelection: failing })
    await h.open()
    await key(h, '\r')
    await key(h, '\r')
    await key(h, 'c')
    await settle(h)
    assert.ok(h.rowsPlain().some(line => line.includes('Copy failed')), `the failure notice is visible:\n${h.view()}`)
    assert.ok(!h.view().includes('Copy sent'), 'a failure is never reported as success')
    h.dispose()
  }
})

test('A-15b a custom palette repaints the workspace tokens', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.open()
  const dark = h.vt.getCellFgRgb(0, 0)
  setTheme('custom', { ...currentPalette, primary: '#010203' })
  h.app.requestRender(true)
  await h.vt.waitForRender()
  assert.equal(h.vt.getCellFgRgb(0, 0), 0x010203, 'the wordmark follows the custom palette')
  assert.notEqual(h.vt.getCellFgRgb(0, 0), dark)
  h.dispose()
})

test('A-06b a non-first row and its REAL detail scroll survive a resize', async () => {
  // A long RAW icon-style value makes the SELECTED row's Detail overflow the
  // short viewport, so the scroll below is observable and meaningful.
  const h = setup({ columns: 120, rows: 10, doc: { iconStyle: `symbols-${'z'.repeat(240)}` } })
  await h.open()
  await key(h, '\x1b[B') // Configured theme -> Icon style (non-first)
  await key(h, '\r') // rows -> detail
  const beforeScroll = h.view()
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  const afterScroll = h.view()
  assert.notEqual(afterScroll, beforeScroll, 'the Detail really scrolled on the selected row')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance/, 'the category survives')
  assert.ok(h.view().includes('> Icon style'), 'the non-first row id survives the resize')
  assert.ok(h.view().includes('Icon style'), 'the detail context survives')
  h.dispose()
})

test('A-15c an unhandled printable key is inert inside the workspace', async () => {
  const h = setup({ columns: 120, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  const before = h.view()
  for (const data of ['q', 'x', 'z']) await key(h, data)
  assert.equal(h.view(), before, 'a printable key never changes the workspace or leaks to a hidden editor')
  h.dispose()
})

// ── F1 residual: a real item click takes its column focus ─────────────────

test('F1-04 a real category/row item click takes that column focus', async () => {
  const wide = setup({ columns: 200, rows: 24, doc: { theme: 'dark' } })
  await wide.open()
  assert.match(wide.rowsPlain()[rowOf(wide, 'CATEGORIES (3)')]!, /\[SETTINGS \(2\)\]/, 'the row list owns focus at open')
  const displayRow = rowOf(wide, 'Display')
  press(wide, displayRow, 2)
  release(wide, displayRow, 2)
  await wide.vt.waitForRender()
  assert.match(wide.rowsPlain()[rowOf(wide, 'CATEGORIES (3)')]!, /\[CATEGORIES \(3\)\]/, 'the category column takes focus')
  assert.match(wide.rowsPlain()[0]!, /SETTINGS · Display/, 'the clicked category is selected')
  await key(wide, '\x1b[B')
  assert.match(wide.rowsPlain()[0]!, /SETTINGS · Other settings/, 'the arrows now move the CATEGORY, not the row')
  wide.dispose()

  const medium = setup({ columns: 120, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  await key(medium, '\t') // rows -> detail
  assert.match(medium.rowsPlain()[rowOf(medium, 'DETAILS')]!, /\[DETAILS\]/)
  const iconRow = rowOf(medium, 'Icon style')
  press(medium, iconRow, 2)
  release(medium, iconRow, 2)
  await medium.vt.waitForRender()
  assert.match(medium.rowsPlain()[rowOf(medium, 'SETTINGS (2)')]!, /\[SETTINGS \(2\)\]/, 'a row click takes the row column focus')
  assert.ok(medium.view().includes('> Icon style'), 'and selects that row')
  medium.dispose()
})

// ── F2 residual: the bar never advertises a floor-disabled key ────────────

test('F2-04 below the body floor the Action Bar advertises only the Esc semantics', async () => {
  for (const [columns, rows] of [[80, 2], [44, 2], [120, 2]] as const) {
    const h = setup({ columns, rows })
    await h.open()
    const bar = h.rowsPlain().at(-1)!
    assert.match(bar, /^Esc /, `the bar keeps its Esc semantics at ${columns}x${rows}`)
    for (const forbidden of ['↑↓', '←→', 'Enter', 'Tab', 'R refresh', 'C copy', 'PgDn', 'PgUp']) {
      assert.ok(!bar.includes(forbidden), `${columns}x${rows} must not advertise the inert ${forbidden}: ${bar}`)
    }
    h.dispose()
  }
})

// ── F3 residual: a resize boundary refuses even an unchanged target ───────

test('F3b a resize that keeps the target geometry still refuses the straddling press', async () => {
  const h = setup({ columns: 120, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  // Positive control first: an unchanged gesture switches the category.
  const nextCol = cellIndexOf(h, 0, '→')
  press(h, 0, nextCol)
  release(h, 0, nextCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Display/, 'the arrow gesture works before the resize')
  // Press the OTHER arrow (a different cell), resize without moving it, release.
  const prevCol = cellIndexOf(h, 0, '←')
  press(h, 0, prevCol)
  h.vt.resize(130, 24)
  await h.vt.waitForRender()
  assert.equal(cellIndexOf(h, 0, '←'), prevCol, 'the target cell really did not move')
  release(h, 0, prevCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Display/, 'a resize between press and release refuses the stale gesture')
  h.dispose()
})

// ── F6 residual: the visual escape is unambiguous ─────────────────────────

test('F6b a real newline and a literal backslash-n render differently', async () => {
  const valueLine = (h: Harness): string => h.rowsPlain().find(line => line.includes('Source')) ?? ''
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'file:a\nb' } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  const realValue = valueLine(h)
  assert.ok(realValue.includes('file:a\\nb'), `a real newline renders as backslash-n: ${JSON.stringify(realValue)}`)
  // The SAME app re-reads a literal backslash-n: the projection must keep the
  // two raw identities distinguishable.
  h.doc.theme = 'file:a\\nb'
  await key(h, 'r')
  const literalValue = valueLine(h)
  assert.ok(literalValue.includes('file:a\\\\nb'), `a literal backslash renders doubled: ${JSON.stringify(literalValue)}`)
  assert.notEqual(literalValue, realValue, 'the two raw identities render differently')
  h.dispose()
})

// ── F10: a shrinking viewport reveals the selection ───────────────────────

test('F10 a viewport shrink reveals the selected row instead of hiding it', async () => {
  const medium = setup({ columns: 120, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  await key(medium, '\x1b[B') // theme -> icon-style
  assert.ok(medium.view().includes('> Icon style'))
  medium.vt.resize(120, 3)
  await medium.vt.waitForRender()
  assert.ok(medium.view().includes('> Icon style'), `the selected row is revealed after the shrink:\n${medium.view()}`)
  medium.dispose()

  const narrow = setup({ columns: 80, rows: 24, doc: { theme: 'dark' } })
  await narrow.open()
  await key(narrow, '\r') // categories -> rows
  await key(narrow, '\x1b[B') // theme -> icon-style
  narrow.vt.resize(80, 3)
  await narrow.vt.waitForRender()
  assert.ok(narrow.view().includes('> Icon style'), `the narrow rows page reveals the selected row:\n${narrow.view()}`)
  narrow.dispose()
})

// ── F1 sibling: the medium header arrows take the category focus ──────────

test('F1-05 the medium header arrows take the category focus, so Left/Right work after the click', async () => {
  const h = setup({ columns: 120, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[rowOf(h, 'SETTINGS (2)')]!, /\[SETTINGS \(2\)\]/, 'the row list owns focus at open')
  const nextCol = cellIndexOf(h, 0, '→')
  press(h, 0, nextCol)
  release(h, 0, nextCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Display/, 'the clicked arrow switches the category')
  assert.match(h.rowsPlain()[0]!, /\[← category →\]/, 'the arrow click takes the categories focus owner')
  await key(h, '\x1b[D')
  assert.match(h.rowsPlain()[0]!, /Appearance/, 'Left now works from the mouse-taken category focus')
  await key(h, '\x1b[C')
  assert.match(h.rowsPlain()[0]!, /Display/, 'Right works too')
  h.dispose()

  // From the Detail focus the arrow click must also move the category owner.
  const detail = setup({ columns: 120, rows: 24, doc: { theme: 'dark' } })
  await detail.open()
  await key(detail, '\t') // rows -> detail
  assert.match(detail.rowsPlain()[rowOf(detail, 'DETAILS')]!, /\[DETAILS\]/)
  const arrowCol = cellIndexOf(detail, 0, '→')
  press(detail, 0, arrowCol)
  release(detail, 0, arrowCol)
  await detail.vt.waitForRender()
  assert.match(detail.rowsPlain()[0]!, /\[← category →\]/, 'the categories owner replaces the Detail focus')
  assert.match(detail.rowsPlain()[0]!, /Display/)
  // Negative control: Left/Right stay inert on the row list owner.
  await key(detail, '\t') // categories -> rows
  await key(detail, '\x1b[C')
  assert.match(detail.rowsPlain()[0]!, /Display/, 'Right on the row list never switches category')
  detail.dispose()
})
