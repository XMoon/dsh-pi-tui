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
  /** How many settings WRITES were attempted (browsing never writes). */
  readonly replacements: () => number
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
  let replacements = 0
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
          replace: () => { replacements += 1 },
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
  return { vt, app, copied, doc, invoke, open, rowsPlain, view, reads: () => reads, replacements: () => replacements, writes: () => writes, dispose }
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

/**
 * The painted ROWS-column cells of one frame line, located from the pane header
 * so the assertion follows the real geometry of the current level (medium L0
 * paints the list in its second column, medium L1/L2 and wide in their own).
 */
const rowsPaneText = (h: Harness, row: number): string => {
  const plain = h.rowsPlain()
  const header = plain.find(candidate => candidate.includes('SETTINGS ('))
  assert.ok(header !== undefined, `the rows pane header must be painted:\n${h.view()}`)
  const start = header.indexOf('SETTINGS (')
  const detailAt = header.indexOf('DETAILS', start)
  const end = detailAt < 0 ? plain[row]!.length : detailAt - 2
  return plain[row]!.slice(start, end)
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
  const h = setup({ columns: 100, rows: 40 })
  await h.vt.waitForRender()
  assert.match(h.view(), /❯/, 'the regular editor seat is painted before opening')
  await h.open()
  const rows = h.rowsPlain()
  assert.ok(rows[0]?.startsWith('SETTINGS'), `the Settings header owns row 0:\n${h.view()}`)
  assert.match(rows[0]!, /SETTINGS · Categories/, 'every width opens on the L0 categories level')
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

test('A-03 100x40 and 76x24 project the medium composition per level and switch category with ↑↓', async () => {
  for (const [columns, rows] of [[100, 40], [76, 24]] as const) {
  const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  // L0 paints categories + rows only; the retired header arrows never paint.
  assert.match(h.rowsPlain()[rowOf(h, 'CATEGORIES (3)')]!, /\[CATEGORIES \(3\)\]/, 'L0 owns the categories level')
  assert.ok(h.rowsPlain().some(line => line.includes('SETTINGS (2)')), `the rows column exists:\n${h.view()}`)
  assert.ok(!h.view().includes('DETAILS'), 'L0 does not paint the Detail column')
  assert.ok(!h.view().includes('←'), 'no medium header category arrows')
  // The categories level moves with ↑↓.
  await key(h, '\x1b[B')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), `Down selects the next category:\n${h.view()}`)
  await key(h, '\x1b[A')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  // Enter advances to L1: rows + detail, no categories column.
  await key(h, '\r')
  assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /DETAILS/, 'L1 paints the Detail column')
  assert.ok(!h.view().includes('CATEGORIES (3)'), 'L1 hides the categories column')
  // Enter again reaches L2 on the same rows+detail composition.
  await key(h, '\r')
  assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /\[DETAILS\]/, 'L2 owns the detail level')
  assert.match(h.view(), /Solarized/, 'the detail shows the selected row value')
  h.dispose()
  }
})

// ── A-04: the narrow drill-down ───────────────────────────────────────────

test('A-04 72x24 drills categories → rows → detail with one Esc per level and a final close', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
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
    const h = setup({ columns: 72, rows })
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

test('A-06 200 → 72 → 44 → 200 preserves the category, the row, the level and the focus', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'plugin:acme/solarized', iconStyle: 'symbols' }, themes: pluginThemes() })
  await h.open()
  await key(h, '\x1b[B') // Appearance -> Display on the categories level
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')))
  await key(h, '\r') // L0 -> L1
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display · Rows/)
  await key(h, '\r') // L1 -> L2 (detail)
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display \/ Transcript display/)
  h.vt.resize(72, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display \/ Transcript d/, 'the level, category and row survive the narrow resize')
  h.vt.resize(44, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Transcript d/, 'the selected row survives the resize')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display \/ Transcript display/, 'the wide projection returns on the same detail context')
  assert.match(h.view(), /Transcript display/, 'the narrow detail level upgrades to the same row')
  assertRowWidths(h, 200)
  h.dispose()
})

// ── A-07: hostile external text ───────────────────────────────────────────

test('A-07 hostile OSC/CSI/CJK theme text is sanitized before paint, wrapped to the pane, and copied verbatim', async () => {
  const hostile = `evil\x1b[31mred\x07payload-${'汉'.repeat(60)}`
  const h = setup({ columns: 72, rows: 24, doc: { theme: hostile } })
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
  assert.match(h.view(), /Config READY/, 'the metadata states the live readiness')
  // Display: the runtime value is the current one; the persisted preference is a
  // separate last-read fact and never overwrites it. Wide paints the Detail at
  // every level, but the walk still goes through the same Enter ladder.
  await key(h, '\x1b[B') // Appearance -> Display (its first row is Transcript display)
  await key(h, '\r') // L0 -> L1
  await key(h, '\r') // L1 -> L2
  assert.match(h.view(), /Client runtime · optional TUI preference persistence/)
  assert.match(h.view(), /Persisted preference: compact \(last read/, 'the persisted fact is named as last-read')
  h.dispose()
})

test('A-08b stale and unavailable backends keep the last-known document but never claim it current', async () => {
  for (const readiness of ['stale', 'unavailable'] as const) {
    const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' }, readiness })
    await h.open()
    assert.match(h.view(), new RegExp(`Config ${readiness.toUpperCase()}`), 'the metadata names the readiness')
    await key(h, '\r') // L0 -> L1: the Detail of the selected row becomes visible
    assert.match(h.view(), /Last-known value/)
    assert.ok(!h.view().includes('Ready · on-open snapshot'), 'a stale doc is never presented as ready')
    h.dispose()
  }
})

test('A-08c a missing document and a throwing read are distinct explicit states, never fabricated defaults', async () => {
  const missing = setup({ columns: 100, rows: 40, settingsService: false })
  await missing.open()
  assert.match(missing.view(), /Unavailable — no authoritative config document/)
  assert.ok(!/Value\s+auto/.test(missing.view()), 'the built-in fallback must never appear as the current value')
  missing.dispose()

  const throwing = setup({ columns: 100, rows: 40, throwOnGet: true })
  await throwing.open()
  assert.match(throwing.view(), /Config READY/, 'the backend itself is reachable')
  await key(throwing, '\r') // L0 -> L1: the selected row's Detail carries the read error
  assert.match(throwing.view(), /Read error/, 'the throwing read is surfaced as a read error')
  assert.match(throwing.view(), /settings read exploded/, 'the real error text is reachable in the detail')
  throwing.dispose()
})

// ── A-09: the painted mouse identity ──────────────────────────────────────

test('A-09 SGR press/release hits the same painted row; a repaint between press and release is refused', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { iconStyle: 'minimal' } })
  await h.open()
  const iconRow = rowOf(h, 'Icon style')
  assert.ok(!h.view().includes('> Icon style'), 'Icon style starts unselected')
  const col = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, col)
  release(h, iconRow, col)
  await h.vt.waitForRender()
  // The click selects the clicked item and takes the rows LEVEL; it never
  // advances into the Detail (only Enter does).
  assert.ok(h.rowsPlain()[iconRow]!.startsWith('> Icon style'), 'the same-cell click selects the painted row')
  assert.match(h.view(), /minimal/, 'the detail follows the newly selected row')
  assert.ok(!h.view().includes('SETTINGS · Appearance / Icon style'), 'the click did not enter the Detail level')

  // Press on Configured theme, repaint (resize), then release on the old cell:
  // the target identity no longer matches, so the click must be refused.
  const themeRow = rowOf(h, 'Configured theme')
  const themeCol = cellIndexOf(h, themeRow, 'Configured theme')
  press(h, themeRow, themeCol)
  h.vt.resize(72, 24)
  await h.vt.waitForRender()
  release(h, themeRow, themeCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'the narrow projection replaced the medium row list')
  assert.ok(h.rowsPlain()[rowOf(h, 'Icon style')]!.startsWith('>'), 'the stale release activated nothing')
  assert.match(h.rowsPlain()[rowOf(h, 'Configured theme')]!, /^\s+Configured theme/, 'the stale release did not re-select the pressed row')
  h.dispose()
})

test('A-09b the wheel scrolls only the visible pane under the pointer, and blank chrome is inert', async () => {
  const h = setup({ columns: 100, rows: 10, doc: { theme: 'dark' } })
  await h.open()
  const l0 = h.view()
  // At L0 the Detail is NOT painted, so a wheel in its would-be columns only
  // reaches the rows pane and cannot move a hidden viewport.
  const themeRow = rowOf(h, 'Configured theme')
  wheel(h, themeRow, 96, true)
  await h.vt.waitForRender()
  assert.equal(h.view(), l0, 'L0 has no Detail pane to scroll')
  await key(h, '\r') // L0 -> L1: rows + detail
  const before = h.view()
  // Wheel over the row pane must not scroll the detail pane.
  wheel(h, themeRow, cellIndexOf(h, themeRow, 'Configured theme'), false)
  await h.vt.waitForRender()
  assert.equal(h.view(), before, 'a row-pane wheel leaves the detail viewport untouched')
  // Wheel over the detail pane scrolls it.
  wheel(h, themeRow, 96, true)
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
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
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
    columns: 72,
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
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\x1b[B') // Appearance -> Display
  await key(h, '\x1b[B') // Display -> Other settings
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Other settings')), `the other category is selected:\n${h.view()}`)
  await key(h, '\r') // L0 -> L1 (the Other settings rows level)
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Other settings · Rows/)
  await key(h, '\r') // Enter on the explicit open-legacy row hands off
  const legacy = h.view()
  assert.match(legacy, /Type to search/, `the legacy SettingsList is the physical owner:\n${legacy}`)
  assert.ok(!legacy.includes('Read-only preview'), 'the workspace is gone, not stacked underneath')
  await key(h, '\x1b')
  assert.ok(h.view().includes('❯'), 'closing the legacy editor returns to the conversation')
  h.dispose()
})

// ── A-12: the return surface ──────────────────────────────────────────────

test('A-12 Esc restores the SAME return surface: the editor draft, the regular footer and the fullscreen mode', async () => {
  const h = setup({ columns: 100, rows: 40 })
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
  const h = setup({ columns: 100, rows: 40 })
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

test('F1-01 narrow item clicks select and focus, never drill past the level', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/)
  const displayRow = rowOf(h, 'Display')
  const displayCol = cellIndexOf(h, displayRow, 'Display')
  press(h, displayRow, displayCol)
  release(h, displayRow, displayCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/, 'a category click stays on the categories level')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), 'the clicked category is selected')
  assert.ok(!h.view().includes('· Rows'), 'the click never drilled into the rows level')
  // Enter is the ONLY level advance.
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display · Rows/)
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  const rowIndex = rowOf(h, 'Transcript display')
  const rowCol = cellIndexOf(h, rowIndex, 'Transcript display')
  press(h, rowIndex, rowCol)
  release(h, rowIndex, rowCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display · Rows/, 'a row click stays on the rows level')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display \/ Transcript display/, 'Enter enters the detail')
  h.dispose()
})

test('F1-02 the painted Copy button copies while the row list owns the keyboard focus', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(!/C copy value/.test(h.rowsPlain().at(-1) ?? ''), 'C is never advertised outside the Detail level')
  await key(h, '\r') // L0 -> L1: the rows keep the keyboard while the Detail is visible
  assert.match(h.rowsPlain()[rowOf(h, 'SETTINGS (2)')]!, /\[SETTINGS \(2\)\]/, 'the rows level owns the keyboard')
  const buttonRow = rowOf(h, '[Copy value]')
  const buttonCol = cellIndexOf(h, buttonRow, '[Copy value]')
  press(h, buttonRow, buttonCol)
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, ['plugin:acme/solarized'], 'the painted mouse button copies without the Detail focus owner')
  assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /\[DETAILS\]/, 'the clicked column becomes the keyboard owner')
  h.dispose()
})

test('F1-03 a click anywhere in a visible column takes that column focus', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[rowOf(h, 'CATEGORIES (3)')]!, /\[CATEGORIES \(3\)\]/, 'the categories level owns focus at open')
  // Clicking a row selects it and takes the rows level's focus (and therefore
  // the rows + detail composition).
  const iconRow = rowOf(h, 'Icon style')
  const iconCol = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, iconCol)
  release(h, iconRow, iconCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[rowOf(h, 'SETTINGS (2)')]!, /\[SETTINGS \(2\)\]/, 'a row click takes the rows level focus')
  const detailRow = rowOf(h, 'Value')
  press(h, detailRow, 96) // inside the Detail pane, away from the Copy button
  release(h, detailRow, 96)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /\[DETAILS\]/, 'clicking the Detail column focuses it')
  h.dispose()
})

// ── F2: the row grant and the actual paint/admission agree ────────────────

test('F2-01 100x3 paints real content in its only body row, not pane headers', async () => {
  const h = setup({ columns: 100, rows: 3, doc: { theme: 'dark' } })
  await h.open()
  const painted = h.rowsPlain()
  assert.equal(painted.length, 3)
  assert.ok(painted.some(line => line.includes('Configured theme')), `the only body row is real content:\n${h.view()}`)
  assert.ok(!painted.some(line => line.includes('CATEGORIES (3)')), 'the pane header yields to the content row')
  h.dispose()
})

test('F2-02 below the body floor Enter/Tab/arrows/C/R are inert; only Esc escapes', async () => {
  const h = setup({ columns: 72, rows: 2, doc: { theme: 'dark' } })
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

test('F2-03 72x3 paints no Copy button and publishes no Copy hit', async () => {
  const h = setup({ columns: 72, rows: 3, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // categories -> rows
  await key(h, '\r') // rows -> detail
  assert.ok(!h.view().includes('[Copy value]'), `the button is not painted at 72x3:\n${h.view()}`)
  const valueRow = rowOf(h, 'Value')
  press(h, valueRow, 0)
  release(h, valueRow, 0)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a click on an unpainted button cell copies nothing')
  h.dispose()
})

// ── F3: a gesture spanning a data change is refused ───────────────────────

test('F3 a release after Refresh is refused instead of copying the newer value', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
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
  const h = setup({ columns: 72, rows: 4, doc: { theme: 'dark' } })
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
  const missing = setup({ columns: 100, rows: 40, settingsService: false })
  await missing.open()
  await key(missing, '\x1b[B') // Appearance -> Display
  await key(missing, '\r') // L0 -> L1
  await key(missing, '\r') // L1 -> L2 (the Transcript display row's detail)
  const missingView = missing.view().replace(/\s+/g, ' ')
  assert.match(missingView, /Persisted preference unknown/, 'absence is an unknown persistence state')
  assert.ok(!missingView.includes('Persisted preference: not set'), 'absence is never "read and not configured"')
  missing.dispose()

  const throwing = setup({ columns: 100, rows: 40, throwOnGet: true })
  await throwing.open()
  await key(throwing, '\x1b[B')
  await key(throwing, '\r')
  await key(throwing, '\r')
  const throwingView = throwing.view().replace(/\s+/g, ' ')
  assert.match(throwingView, /Persisted preference unknown — the TUI settings document could not be read/)
  assert.match(throwingView, /settings read exploded/, 'the real read error is reachable')
  throwing.dispose()
})

// ── F6: raw values are escaped, never silently folded ─────────────────────

test('F6 a raw source value with a line break renders a visible escape distinct from a space', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'file:a\nb' } })
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
  assert.equal(cellIndexOf(h, paneRow, '[CATEGORIES (3)]'), 0, 'the categories level starts at cell 0 and owns focus at L0')
  assert.equal(cellIndexOf(h, paneRow, 'SETTINGS (2)'), 22 + 2, 'the row column starts after the 22-cell column and a 2-cell gap')
  assert.equal(cellIndexOf(h, paneRow, 'DETAILS'), 22 + 2 + 42 + 2, 'the detail column starts after the 42-cell row column and a 2-cell gap')
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 200, `row ${index} must fit the terminal`)
  }
  assert.match(h.rowsPlain().at(-1) ?? '', /^Esc close/, 'the Action Bar stays the last physical row')
  await key(h, '\r') // L0 -> L1 (the row list owns the keyboard)
  await key(h, '\r') // L1 -> L2 (the Detail owns the keyboard)
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  assert.match(h.view().replace(/\s+/g, ''), /x{100}/, 'the long value is wrapped and readable in the Detail')
  h.dispose()
})

test('A-10c the copy failure paths report inside the workspace instead of a false success', async () => {
  for (const failing of [async () => false, async () => { throw new Error('clipboard refused') }]) {
    const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' }, copySelection: failing })
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
  const h = setup({ columns: 100, rows: 40 })
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
  const h = setup({ columns: 100, rows: 10, doc: { iconStyle: `symbols-${'z'.repeat(240)}` } })
  await h.open()
  await key(h, '\r') // L0 -> L1 (rows own the keyboard)
  await key(h, '\x1b[B') // Configured theme -> Icon style (non-first)
  await key(h, '\r') // L1 -> L2 (detail)
  const beforeScroll = h.view()
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  const afterScroll = h.view()
  assert.notEqual(afterScroll, beforeScroll, 'the Detail really scrolled on the selected row')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance \/ Icon style/, 'the category and row survive')
  assert.ok(h.view().includes('> Icon style'), 'the non-first row id survives the resize')
  assert.ok(h.view().includes('Icon style'), 'the detail context survives')
  h.dispose()
})

test('A-15c an unhandled printable key is inert inside the workspace', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  const before = h.view()
  for (const data of ['q', 'x', 'z']) await key(h, data)
  assert.equal(h.view(), before, 'a printable key never changes the workspace or leaks to a hidden editor')
  h.dispose()
})

// ── F1 residual: a real item click takes its column focus ─────────────────

test('F1-04 a real category/row item click takes that level and selects the item', async () => {
  const wide = setup({ columns: 200, rows: 24, doc: { theme: 'dark' } })
  await wide.open()
  assert.match(wide.rowsPlain()[rowOf(wide, 'CATEGORIES (3)')]!, /\[CATEGORIES \(3\)\]/, 'the categories level owns focus at open')
  const displayRow = rowOf(wide, 'Display')
  press(wide, displayRow, 2)
  release(wide, displayRow, 2)
  await wide.vt.waitForRender()
  assert.match(wide.rowsPlain()[rowOf(wide, 'CATEGORIES (3)')]!, /\[CATEGORIES \(3\)\]/, 'the clicked category keeps the categories level')
  assert.ok(wide.rowsPlain().some(line => line.startsWith('> Display')), 'and selects the clicked category')
  await key(wide, '\x1b[B')
  assert.ok(wide.rowsPlain().some(line => line.startsWith('> Other settings')), 'Down now moves the CATEGORY, not the row')
  wide.dispose()

  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  const iconRow = rowOf(medium, 'Icon style')
  const iconCol = cellIndexOf(medium, iconRow, 'Icon style')
  press(medium, iconRow, iconCol)
  release(medium, iconRow, iconCol)
  await medium.vt.waitForRender()
  assert.match(medium.rowsPlain()[rowOf(medium, 'SETTINGS (2)')]!, /\[SETTINGS \(2\)\]/, 'a row click takes the rows level')
  assert.ok(medium.view().includes('> Icon style'), 'and selects that row')
  medium.dispose()
})

// ── F2 residual: the bar never advertises a floor-disabled key ────────────

test('F2-04 below the body floor the Action Bar advertises only the Esc semantics', async () => {
  for (const [columns, rows] of [[72, 2], [44, 2], [100, 2]] as const) {
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
  const h = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  // Positive control first: an unchanged gesture selects the pressed row.
  const iconRow = rowOf(h, 'Icon style')
  const iconCol = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, iconCol)
  release(h, iconRow, iconCol)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('> Icon style'), 'the row gesture works before the resize')
  // Press another row, resize without moving it, release on the same cell.
  const themeRow = rowOf(h, 'Configured theme')
  const themeCol = cellIndexOf(h, themeRow, 'Configured theme')
  press(h, themeRow, themeCol)
  h.vt.resize(104, 24)
  await h.vt.waitForRender()
  assert.equal(cellIndexOf(h, themeRow, 'Configured theme'), themeCol, 'the target cell really did not move')
  release(h, themeRow, themeCol)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('> Icon style'), 'a resize between press and release refuses the stale gesture')
  assert.ok(!h.view().includes('> Configured theme'), 'the stale release did not re-select the pressed row')
  h.dispose()
})

// ── F6 residual: the visual escape is unambiguous ─────────────────────────

test('F6b a real newline and a literal backslash-n render differently', async () => {
  const valueLine = (h: Harness): string => h.rowsPlain().find(line => line.includes('Source')) ?? ''
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'file:a\nb' } })
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
  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  await key(medium, '\r') // L0 -> L1
  await key(medium, '\x1b[B') // theme -> icon-style
  assert.ok(medium.view().includes('> Icon style'))
  medium.vt.resize(100, 3)
  await medium.vt.waitForRender()
  assert.ok(medium.view().includes('> Icon style'), `the selected row is revealed after the shrink:\n${medium.view()}`)
  medium.dispose()

  const narrow = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await narrow.open()
  await key(narrow, '\r') // categories -> rows
  await key(narrow, '\x1b[B') // theme -> icon-style
  narrow.vt.resize(72, 3)
  await narrow.vt.waitForRender()
  assert.ok(narrow.view().includes('> Icon style'), `the narrow rows page reveals the selected row:\n${narrow.view()}`)
  narrow.dispose()
})

// ── F1 sibling: the retired Tab cycle and header arrows ───────────────────

test('F1-05 Tab/Shift+Tab and Left/Right are inert on every level: no focus cycle, no category switch', async () => {
  const h = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[rowOf(h, 'CATEGORIES (3)')]!, /\[CATEGORIES \(3\)\]/, 'the categories level owns focus at open')
  assert.ok(!h.view().includes('←'), 'the header paints no category arrows')
  const l0 = h.view()
  for (const data of ['\t', '\x1b[Z', '\x1b[C', '\x1b[D']) await key(h, data)
  assert.equal(h.view(), l0, 'Tab/Shift+Tab/Left/Right are inert on the medium categories level')
  await key(h, '\r') // L0 -> L1
  const l1 = h.view()
  for (const data of ['\t', '\x1b[Z', '\x1b[C', '\x1b[D']) await key(h, data)
  assert.equal(h.view(), l1, 'and inert on the medium rows level')
  await key(h, '\r') // L1 -> L2
  const l2 = h.view()
  for (const data of ['\t', '\x1b[Z', '\x1b[C', '\x1b[D']) await key(h, data)
  assert.equal(h.view(), l2, 'and inert on the medium detail level')
  h.dispose()

  const wide = setup({ columns: 200, rows: 24, doc: { theme: 'dark' } })
  await wide.open()
  const wideL0 = wide.view()
  for (const data of ['\t', '\x1b[C', '\x1b[D']) await key(wide, data)
  assert.equal(wide.view(), wideL0, 'the wide projection has no Tab cycle and no arrow category switch')
  wide.dispose()

  const narrow = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await narrow.open()
  const narrowL0 = narrow.view()
  for (const data of ['\t', '\x1b[Z', '\x1b[C', '\x1b[D']) await key(narrow, data)
  assert.equal(narrow.view(), narrowL0, 'the narrow projection is inert to Tab and Left/Right')
  narrow.dispose()
})

// ── External UI review (PR #295) P2s ───────────────────────────────────────

test('A-02c the list summary survives a long value and stays exact for a short one', async () => {
  const long = `file:${'w'.repeat(120)}`
  // The rows pane is located from its painted pane header, so the assertion
  // follows the real medium geometry (L0 paints the list in its second column).
  const medium = setup({ columns: 100, rows: 40, doc: { theme: long } })
  await medium.open()
  const longRow = rowsPaneText(medium, rowOf(medium, 'Configured theme'))
  assert.ok(longRow.includes('> Configured theme'), `the name stays identifiable: ${JSON.stringify(longRow)}`)
  // The list SUMMARY is the friendly display name (the raw `file:` identity is
  // the Detail/copy fact), so its prefix here is the file name itself.
  assert.ok(longRow.includes('wwww'), `the real summary prefix is painted: ${JSON.stringify(longRow)}`)
  assert.ok(longRow.trimEnd().endsWith('…'), `the truncated summary ends in the list-pane ellipsis: ${JSON.stringify(longRow)}`)
  // Short-value control: the exact value is painted, with no ellipsis at all.
  medium.doc.theme = 'dark'
  await key(medium, 'r')
  const shortRow = rowsPaneText(medium, rowOf(medium, 'Configured theme'))
  assert.ok(shortRow.trimEnd().endsWith('dark'), `the exact short value is visible: ${JSON.stringify(shortRow)}`)
  assert.ok(!shortRow.includes('…'), `a fitting value is never truncated: ${JSON.stringify(shortRow)}`)
  medium.dispose()

  const narrow = setup({ columns: 44, rows: 24, doc: { iconStyle: 'symbols', theme: long } })
  await narrow.open()
  await key(narrow, '\r') // categories -> rows
  const iconRow = narrow.rowsPlain()[rowOf(narrow, 'Icon style')]!
  assert.ok(iconRow.trimEnd().endsWith('symbols'), `the exact short value is visible at 44 cells: ${JSON.stringify(iconRow)}`)
  assert.ok(!iconRow.includes('…'), `a fitting value is never truncated: ${JSON.stringify(iconRow)}`)
  const themeRow = narrow.rowsPlain()[rowOf(narrow, 'Configured theme')]!
  assert.ok(themeRow.includes('Configured theme') && themeRow.includes('wwww'),
    `the long value keeps its prefix: ${JSON.stringify(themeRow)}`)
  assert.ok(themeRow.trimEnd().endsWith('…'), `the long value truncates to the pane edge: ${JSON.stringify(themeRow)}`)
  narrow.dispose()
})

test('A-05b the decorative rules yield before readable content on short screens', async () => {
  // 5 rows without a notice: header + THREE real body rows + bar, no rule row.
  const short = setup({ columns: 72, rows: 5, doc: { theme: 'dark' } })
  await short.open()
  const painted = short.rowsPlain()
  assert.equal(painted.length, 5)
  assert.match(painted.at(-1)!, /^Esc /)
  assert.equal(painted.filter(line => /^─+$/.test(line)).length, 0, 'the decorative rules yield at 5 rows')
  for (const label of ['Appearance', 'Display', 'Other settings']) {
    assert.ok(painted.some(line => line.includes(label)), `the body keeps the real ${label} row:\n${short.view()}`)
  }
  short.dispose()

  // 6 and 8 rows with a LIVE notice: the notice's body floor is honoured first.
  const live = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await live.open()
  await key(live, '\r')
  await key(live, '\r')
  await key(live, 'c')
  await settle(live)
  assert.ok(live.rowsPlain().some(line => line.includes('Copy sent')), 'the notice is live before the shrink')
  for (const rows of [6, 8]) {
    live.vt.resize(72, rows)
    await live.vt.waitForRender()
    const frame = live.rowsPlain()
    assert.equal(frame.length, rows)
    assert.match(frame.at(-1)!, /^Esc /)
    assert.ok(frame.some(line => line.includes('Copy sent')), `the notice is still granted and painted at ${rows} rows:\n${live.view()}`)
    assert.equal(frame.filter(line => /^─+$/.test(line)).length, 0, `the decorative rules yield at ${rows} rows:\n${live.view()}`)
    if (rows === 8) {
      assert.ok(frame.some(line => line.includes('Config READY')), 'the freshness/scope metadata is granted at 8 rows')
    }
    if (rows === 6) {
      assert.ok(frame.some(line => line.includes('Value')), 'the body keeps real detail rows under the notice')
    }
  }
  live.dispose()
})

// ── External UI review round 2 (PR #295): the narrow drill-down contract ───

test('F11 narrow Tab/Shift+Tab never bypass the drill-down and Left/Right never switch category', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/)
  const before = h.view()
  for (const data of ['\t', '\x1b[Z', '\t']) await key(h, data)
  assert.equal(h.view(), before, 'Tab/Shift+Tab are inert on the narrow categories page')
  assert.ok(!h.view().includes('Value'), 'the Detail is never reached directly from Categories')
  await key(h, '\x1b[C')
  assert.equal(h.view(), before, 'Right never switches category on the narrow categories page')
  await key(h, '\x1b[D')
  assert.equal(h.view(), before, 'Left neither')
  // Positive control: the unified per-level Enter/Esc walk still works.
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance · Rows/)
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance \/ Configured theme/)
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'Esc returns one level')
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /Categories/)
  h.dispose()

  // Medium has no Tab focus cycle and no header arrows any more either.
  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  const mediumBefore = medium.view()
  for (const data of ['\t', '\x1b[Z']) await key(medium, data)
  assert.equal(medium.view(), mediumBefore, 'Tab/Shift+Tab do not cycle a focus owner in medium')
  assert.ok(!medium.view().includes('←'), 'the medium header paints no category arrows')
  await key(medium, '\x1b[C')
  assert.equal(medium.view(), mediumBefore, 'Right does not switch category in medium')
  medium.dispose()
})

test('F12 / UX-10 pre-paint keys resolve the level, never the projection: the same walk at 72, 100 and 160', async () => {
  for (const [columns, rows] of [[72, 24], [100, 40], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    // Deliberately do NOT await a paint: the first keys arrive before the initial
    // frame, exactly when the level — not the layout — must be the state.
    h.invoke('settings')
    h.vt.sendInput('\r') // L0 -> L1
    h.vt.sendInput('\x1b') // L1 -> L0, NEVER a full close
    await h.vt.waitForRender()
    assert.ok(h.view().includes('SETTINGS'), `the pre-paint Esc must not close the workspace at ${columns}:\n${h.view()}`)
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/, 'the pre-paint Esc returns to the categories level')
    // After a paint the deeper walk behaves identically.
    await key(h, '\r')
    await key(h, '\r')
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance · Rows/, `the post-paint Esc returns exactly one level at ${columns}`)
    h.dispose()
  }

  // Three keys BEFORE the first paint: Enter -> Enter -> Esc must land on L1
  // (neither close nor skip a level), exactly like the painted walk.
  for (const [columns, rows] of [[72, 24], [100, 40], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    h.invoke('settings')
    h.vt.sendInput('\r') // L0 -> L1
    h.vt.sendInput('\r') // L1 -> L2
    h.vt.sendInput('\x1b') // L2 -> L1, NEVER a full close
    await h.vt.waitForRender()
    assert.ok(h.view().includes('SETTINGS'), `the pre-paint deep walk never closes at ${columns}:\n${h.view()}`)
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance · Rows/, `the pre-paint deep walk lands on L1 at ${columns}`)
    // The rest of the walk closes exactly once from the outermost level.
    await key(h, '\x1b')
    await key(h, '\x1b')
    await key(h, '\x1b')
    assert.ok(h.view().includes('❯'), `the walk closes from L0 at ${columns}`)
    h.dispose()
  }
})

// ── UX-01…UX-11: the unified three-level navigation contract ──────────────
//
// The cases below are the plan's Step-D matrix (UX-01…UX-11) in one place; the
// A-*/F* cases above carry the older evidence levels for the same component.
// UX-12 (Job lease / Question / Approval / Save / session switch / legacy
// handoff lifecycle) stays in `test/surface-lifecycle-closure.test.ts`.

test('UX-01 every width opens at L0, ↑↓ changes the category and Enter enters the rows level', async () => {
  for (const [columns, rows] of [[200, 40], [100, 40], [72, 24], [44, 8]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    await h.open()
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/, `L0 at ${columns} columns`)
    assert.ok(!h.view().includes('· Rows'), `no level is pre-entered at ${columns}`)
    await key(h, '\x1b[B')
    assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), `↓ selects Display at ${columns}:\n${h.view()}`)
    await key(h, '\r')
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Display · Rows/, `Enter enters the Display rows at ${columns}`)
    h.dispose()
  }
})

test('UX-02 Esc walks one level back at every width; only L0 closes', async () => {
  for (const [columns, rows] of [[200, 40], [100, 40], [72, 24]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\r') // L1
    assert.match(h.rowsPlain()[0]!, /· Rows/)
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/, `Esc from L1 returns to L0 at ${columns}, never closes`)
    await key(h, '\r')
    await key(h, '\r') // L2
    assert.match(h.rowsPlain()[0]!, /Configured theme/)
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /· Rows/, `Esc from L2 returns to L1 at ${columns}`)
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/)
    await key(h, '\x1b')
    assert.ok(h.view().includes('❯'), `Esc at L0 closes the workspace at ${columns}:\n${h.view()}`)
    h.dispose()
  }
})

test('UX-03 the medium projection is a pure function of the level: L0 categories+rows, L1/L2 rows+detail', async () => {
  for (const columns of [76, 107]) {
    const h = setup({ columns, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
    await h.open()
    assert.ok(h.rowsPlain().some(line => line.includes('CATEGORIES (3)')), `L0 categories at ${columns}:\n${h.view()}`)
    assert.ok(!h.view().includes('DETAILS'), 'L0 paints no Detail pane')
    assert.ok(!h.view().includes('[Copy value]'), 'L0 publishes no Detail button')
    await key(h, '\r')
    assert.ok(h.rowsPlain().some(line => line.includes('DETAILS')), 'L1 paints rows+detail')
    assert.ok(!h.view().includes('CATEGORIES (3)'), 'L1 drops the categories column')
    await key(h, '\r')
    assert.match(h.rowsPlain()[rowOf(h, 'DETAILS')]!, /\[DETAILS\]/, 'L2 focuses the detail on the same composition')
    assert.ok(!h.view().includes('CATEGORIES (3)'), 'L2 keeps the rows+detail projection')
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /· Rows/, 'Esc from L2 returns to L1 on the same rows+detail projection')
    await key(h, '\x1b')
    assert.ok(h.rowsPlain().some(line => line.includes('CATEGORIES (3)')), 'Esc from L1 returns to categories+rows')
    assert.ok(!h.view().includes('DETAILS'), 'and hides the detail again')
    h.dispose()
  }
})

test('UX-04 the narrow projection paints only the current level and a resize never resets the level', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Categories/)
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  assert.ok(!h.view().includes('Configured theme'), 'L0 shows only the categories')
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /· Rows/)
  assert.ok(!h.view().includes('Display'), 'L1 shows only the current category rows')
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Configured theme/)
  h.vt.resize(100, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Configured theme/, 'the medium resize keeps the detail level')
  h.vt.resize(44, 8)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Appearance \/ Conf/, 'the 44-column projection keeps the detail level')
  assert.ok(h.view().includes('Value'), 'the real value stays reachable')
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, ['dark'], 'the copy still sends the exact source value')
  h.dispose()
})

test('UX-05 a resize keeps focus/category/row and invalidates the previous painted hit map', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\x1b[B') // Display
  await key(h, '\r') // L1
  await key(h, '\r') // L2
  const buttonRow = rowOf(h, '[Copy value]')
  const buttonCol = cellIndexOf(h, buttonRow, '[Copy value]')
  press(h, buttonRow, buttonCol)
  h.vt.resize(100, 40)
  await h.vt.waitForRender()
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a press recorded against the wide geometry is refused after the resize')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Display/, 'the category and level survive the resize')
  h.dispose()
})

test('UX-05b a resize that has NOT repainted yet still refuses the straddling press', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // L0 -> L1 (narrow)
  await key(h, '\r') // L1 -> L2: the narrow Detail paints the Copy button at x=0
  const buttonRow = rowOf(h, '[Copy value]')
  const buttonCol = cellIndexOf(h, buttonRow, '[Copy value]')
  press(h, buttonRow, buttonCol)
  // The LIVE terminal is already 96 columns (medium, two panes) but NO repaint
  // has run yet: the resize is a gesture boundary by itself, so the press-time
  // cell must not activate even though the painted hit map is still the old one.
  h.vt.resize(96, 24)
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a release after a resize without a repaint must be refused')
  assert.match(h.rowsPlain()[0]!, /SETTINGS · Appearance \/ Configured theme/, 'the level survives the resize')
  h.dispose()
})

test('UX-06 changing category refreshes the row selection and the detail; browsing never writes config', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(h.view().includes('Configured theme'), 'the appearance rows are the L0 list')
  await key(h, '\x1b[B') // Appearance -> Display
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')))
  await key(h, '\r') // L1
  assert.ok(h.view().includes('Transcript display'), 'the Display rows replace the appearance rows')
  await key(h, '\x1b[B') // display-preset -> thinking
  await key(h, '\r') // L2
  assert.match(h.rowsPlain()[0]!, /Thinking detail/, 'the detail follows the new stable row id')
  await key(h, '\x1b') // L1
  await key(h, '\x1b') // L0
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), 'the selected category id survives')
  assert.equal(h.replacements(), 0, 'navigation never writes the configuration')
  h.dispose()
})

test('UX-07 Tab/arrows never change the level and never leak into the hidden editor', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.vt.waitForRender()
  for (const ch of 'draft') await key(h, ch)
  await h.open()
  const before = h.view()
  for (const data of ['\t', '\x1b[Z', '\x1b[C', '\x1b[D']) await key(h, data)
  assert.equal(h.view(), before, 'Tab/Shift+Tab/Left/Right change nothing in the workspace')
  assert.ok(!h.view().includes('draft'), 'no key leaks into the hidden editor')
  assert.deepEqual(h.copied, [], 'no key leaks into a clipboard action')
  await key(h, '\x1b')
  assert.ok(h.view().includes('draft'), 'the editor draft is untouched after the round trip')
  h.dispose()
})

test('UX-08 only visible panes publish hits: the hidden Detail band neither copies nor focuses', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(!h.view().includes('[Copy value]'), 'L0 paints no Detail button')
  const row = rowOf(h, 'Configured theme')
  press(h, row, 96)
  release(h, row, 96)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a click in the would-be Detail band copies nothing')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Configured theme')), 'it acted on the visible rows pane instead')
  h.dispose()
})

test('UX-09 C copies only in the Detail level; R refreshes in place; browsing never writes', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [], 'C is inert on the categories level')
  await key(h, '\r') // L1
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [], 'C is inert on the rows level')
  const readsBefore = h.reads()
  await key(h, 'r')
  assert.ok(h.reads() > readsBefore, 'R re-reads the same authority')
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'R keeps the current level')
  await key(h, '\r') // L2
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, ['plugin:acme/solarized'], 'C in the Detail copies the exact source value')
  assert.equal(h.replacements(), 0, 'no navigation or refresh ever writes the config document')
  h.dispose()
})

test('UX-11 a long CJK value wraps inside the narrow Detail and copies byte-exact', async () => {
  const value = `file:${'汉'.repeat(40)}`
  const h = setup({ columns: 44, rows: 8, doc: { theme: value } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 44, `row ${index} must stay inside the pane width`)
  }
  await key(h, '\x1b[B') // scroll the wrapped detail
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [value], 'the copy is the exact source value, never the wrapped display')
  h.dispose()
})

// ── UX-12: the frozen responsive projection table ─────────────────────────

test('UX-12 the projection table is frozen: below 76 columns one pane, 76..107 two, 108 and up three', async () => {
  for (const [columns, panes] of [[75, 1], [76, 2], [107, 2], [108, 3]] as const) {
    const h = setup({ columns, rows: 24, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\r') // L0 -> L1: the rows pane always, plus the detail when the width grants it
    const painted = h.rowsPlain()
    assert.equal(painted.some(line => line.includes('CATEGORIES (3)')), panes === 3, `the categories pane at ${columns} columns:\n${h.view()}`)
    assert.equal(painted.some(line => line.includes('DETAILS')), panes >= 2, `the detail pane at ${columns} columns:\n${h.view()}`)
    assertRowWidths(h, columns)
    h.dispose()
  }
})
