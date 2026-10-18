/**
 * Phase 3A / PR-C cross-layer row-grant regression.
 *
 * These tests drive the REAL `/settings` command through a real `TuiApp`
 * and `VirtualTerminal`, so the nested `Keyboard shortcuts` submenu is
 * budgeted by the same chain production uses:
 *
 *   /settings handler → TuiApp.openSettings → ResponsiveOverlayFrame
 *   geometry → SettingsList.setMaxRows → forwardBudgetToSubmenu →
 *   KeybindingEditorPanel.setMaxRows → component render → Frame render.
 *
 * The painted frame is read back from the VirtualTerminal (borders + the
 * operation hint), never from a hand-fed `setMaxRows(26)` call.
 * @module @xmoon76/dsh-pi-tui/surface-row-grant.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../src/tui-app.ts'
import { KeybindingEditorPanel } from '../src/tui/keybindings/ui/list.ts'
import { ThemeRegistry } from '../src/extension/internal/theme-registry.ts'
import { visibleWidth } from '@xmoon76/pi-tui'
import { currentPalette } from '../src/tui/theme/runtime.ts'
import { SettingsRegistry } from '../src/extension/internal/settings-registry.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from './support/register-tui-commands.ts'
import { openLegacySettingsPanel } from './support/open-legacy-settings.ts'

/** Every TuiApp constructed here is disposed after each test: the process
 * slot (the vendored fork keybindings are process-global) is released only
 * by the FINAL dispose (see src/tui/process-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function viewportText(vt: VirtualTerminal): string {
  return vt.getViewport().map(stripAnsi).join('\n')
}

/**
 * The panel's painted frame as the terminal actually shows it: walk up from
 * an in-frame anchor row to the first bordered row (the row above it is the
 * top border), then count the contiguous bordered rows below. `bottomBorder`
 * is false exactly when the compositor head-sliced the frame to the overlay
 * height.
 */
function paintedFrame(vt: VirtualTerminal, anchor: string): { contentRows: number; bottomBorder: boolean } {
  const lines = vt.getViewport().map(stripAnsi)
  const anchorRow = lines.findIndex(line => line.includes(anchor) && line.includes('│'))
  assert.ok(anchorRow >= 0, `the "${anchor}" frame row is missing:\n${lines.join('\n')}`)
  let top = anchorRow
  while (top > 0 && (lines[top - 1] ?? '').includes('│')) top -= 1
  const topBorder = (lines[top - 1] ?? '').includes('╭')
  let contentRows = 0
  while ((lines[top + contentRows] ?? '').includes('│')) contentRows += 1
  return { contentRows, bottomBorder: topBorder && (lines[top + contentRows] ?? '').includes('╰') }
}

/** The selected (cursor-marked) row: the frame content between its own
 * borders must START with the cursor marker (a title row may contain a `›`
 * in its own text, and a row composited over a base-screen line must not
 * contribute text). */
/** The text inside a bordered row (the frame's own cells, trimmed). */
function rowContent(line: string): string {
  return line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')).trim()
}

function selectedRowText(vt: VirtualTerminal): string {
  const content = (line: string): string => rowContent(line)
  const line = vt.getViewport().map(stripAnsi).find(row => row.includes('│') && content(row).startsWith('›'))
  assert.ok(line !== undefined, `no selected row painted:\n${viewportText(vt)}`)
  return content(line)
}

const hexToRgb = (hex: string): number =>
  (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)

/** The viewport row of the first painted occurrence of `needle`. */
function rowOf(vt: VirtualTerminal, needle: string): number {
  const row = vt.getViewport().map(stripAnsi).findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${viewportText(vt)}`)
  return row
}

/** The terminal-CELL column of the first painted occurrence of `needle`. */
function cellIndexOf(vt: VirtualTerminal, row: number, needle: string): number {
  const plain = vt.getViewport().map(stripAnsi)[row] ?? ''
  const index = plain.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}:\n${plain}`)
  return visibleWidth(plain.slice(0, index))
}

/** Whether the row carries the SettingsList cursor marker inside the frame. */
function isCursorRow(vt: VirtualTerminal, row: number): boolean {
  const line = vt.getViewport().map(stripAnsi)[row] ?? ''
  return line.includes('│') && rowContent(line).startsWith('>')
}

interface StandaloneState {
  readonly panel: KeybindingEditorPanel | undefined
  readonly close: (() => void) | undefined
  /** ACTUAL invocations of the panel's `onDispose` obligation (the command
   * factory's unregister), i.e. the observed teardown effect. `dispose()` is
   * reached twice on the Esc path (the panel closes itself, then the owning
   * FocusForwardingFrame's disposeOnHide releases it); the second call must
   * be a no-op, so this counter is the exactly-once evidence — a removed
   * idempotence guard would make it 2. */
  readonly teardowns: number
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly invoke: (name: string) => unknown
  readonly panel: () => KeybindingEditorPanel | undefined
  readonly standalone: () => StandaloneState
}

/**
 * Mount the real `/settings` command on a real app. The runner is a
 * defaults-permissive stub (every unset dependency is a no-op), matching
 * the existing `/settings` command-entry suites; the pointed-at seams
 * (commands registry, tuiSettings doc, config readiness) are real.
 */
function setup(options: { columns?: number; rows?: number; tuiSettings?: boolean; themes?: ThemeRegistry } = {}): Harness {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.columns ?? 120, options.rows ?? 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const defs: Array<{ name: string; handler?: unknown }> = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const doc = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'full',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
    terminalProgress: '9;4+7501',
    wheelScrollLines: '1',
  }
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
    // A sessionless surface: the settings rows see no live scope.
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    listScopedCommands: () => [],
    tuiSettings: options.tuiSettings === false
      ? undefined
      : { get: () => doc, replace: () => undefined },
    extensions: options.themes === undefined ? undefined : { themes: options.themes, settings: new SettingsRegistry() },
    openPluginManager: () => {},
    createPluginManagerSubmenu: () => ({ render: () => [], invalidate: () => {} }),
    config: {
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      // The Web provider section is Host-only (S2/PR-B): this stub composes no
      // Host settings plane, so the section reports unavailable and offers no write.
      web: { available: () => false },
      // The credential STORE is not mounted either: the Web section's key row
      // reports unavailable instead of claiming "not configured".
      credentials: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  // Test instrumentation ONLY: observe the submenu component the real
  // SettingsList slot builds. `setMaxRows` is never called by the test.
  let captured: KeybindingEditorPanel | undefined
  const originalOpenSettings = app.openSettings.bind(app)
  app.openSettings = ((items: Parameters<TuiApp['openSettings']>[0], ...rest: unknown[]) => {
    for (const item of items) {
      const factory = item.submenu
      if (factory === undefined) continue
      item.submenu = (currentValue, done) => {
        const component = factory(currentValue, done)
        if (component instanceof KeybindingEditorPanel) captured = component
        return component
      }
    }
    return (originalOpenSettings as (...args: unknown[]) => () => void)(items, ...rest)
  }) as TuiApp['openSettings']
  const invoke = (name: string): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  // Test instrumentation ONLY for the standalone `/keybindings` path:
  // observe the panel the real command mounts and count the ACTUAL teardown
  // effect. The command factory registers the panel first (its `unregister`
  // IS the panel's `onDispose` callback); `openKeybindingEditor` registers it
  // again for its own close handle, so only the FIRST registration is the
  // panel's teardown obligation.
  let standalonePanel: KeybindingEditorPanel | undefined
  let standaloneClose: (() => void) | undefined
  let teardowns = 0
  let registrations = 0
  const originalTrackKeybindingEditor = app.trackKeybindingEditor
  app.trackKeybindingEditor = ((component: Parameters<TuiApp['trackKeybindingEditor']>[0]) => {
    const unregister = originalTrackKeybindingEditor.call(app, component)
    const registration = ++registrations
    return () => {
      if (registration === 1) teardowns += 1
      unregister()
    }
  }) as TuiApp['trackKeybindingEditor']
  const originalOpenKeybindingEditor = app.openKeybindingEditor
  app.openKeybindingEditor = ((panel: Parameters<TuiApp['openKeybindingEditor']>[0]) => {
    if (panel instanceof KeybindingEditorPanel) standalonePanel = panel
    const close = originalOpenKeybindingEditor.call(app, panel)
    standaloneClose = close
    return close
  }) as TuiApp['openKeybindingEditor']
  return {
    vt,
    app,
    invoke,
    panel: () => captured,
    standalone: () => ({ panel: standalonePanel, close: standaloneClose, teardowns }),
  }
}

/** `/settings` → filter to the Keyboard shortcuts row → Enter. */
async function openKeyboardShortcuts(h: Harness, filter = 'keyboard'): Promise<void> {
  await openLegacySettingsPanel(h.invoke, h.vt)
  for (const character of filter) {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
}

test('C-T01: the real /settings Keyboard shortcuts submenu takes the parent content grant (120x40)', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openKeyboardShortcuts(h)
  const view = viewportText(h.vt)
  const panel = h.panel()
  assert.ok(panel !== undefined, `the real command must build the KeybindingEditorPanel:\n${view}`)
  // The standalone cap is the whole-terminal budget (40 - 4); the NESTED
  // grant is the overlay content height (28 - 2). The effective budget is
  // the smaller one, and the fix is what makes the child respect it.
  assert.equal(h.app.keybindingEditorMaxRows(), 36)
  const rendered = panel.render(68)
  assert.ok(rendered.length <= 26, `the nested panel must be capped at 26 rows (got ${rendered.length})`)
  const frame = paintedFrame(h.vt, 'Keyboard shortcuts')
  assert.equal(frame.contentRows, rendered.length, 'the painted content rows must match the panel render')
  assert.ok(frame.bottomBorder, `the parent frame bottom border must be painted:\n${view}`)
  assert.match(view, /Esc: close/, 'the bottom operation hint must survive the nested grant')
})

test('C-T02: a taller terminal does not raise the nested grant (200x60)', async () => {
  const h = setup({ columns: 200, rows: 60 })
  await openKeyboardShortcuts(h)
  const view = viewportText(h.vt)
  const panel = h.panel()
  assert.ok(panel !== undefined)
  assert.equal(h.app.keybindingEditorMaxRows(), 56, 'the standalone cap follows the terminal height')
  assert.ok(panel.render(68).length <= 26, 'the nested grant stays at the legacy 28-row overlay cap')
  const frame = paintedFrame(h.vt, 'Keyboard shortcuts')
  assert.ok(frame.bottomBorder, `the frame bottom border must be painted:\n${view}`)
  assert.match(view, /Esc: close/)
  assert.match(view, /›/, 'the selected item must stay inside the viewport')
})

test('C-T03: the nested hint and frame tail survive an ordinary and a short terminal', async () => {
  for (const rows of [24, 10]) {
    const h = setup({ columns: 80, rows })
    await openKeyboardShortcuts(h)
    const view = viewportText(h.vt)
    const panel = h.panel()
    assert.ok(panel !== undefined, `${rows} rows: the panel must exist`)
    const rendered = panel.render(68)
    assert.ok(rendered.length <= h.app.keybindingEditorMaxRows(), `${rows} rows: render must fit the cap`)
    assert.match(rendered[rendered.length - 1]!, /Esc: close/, `${rows} rows: the bottom hint must be the last row`)
    const frame = paintedFrame(h.vt, 'Keyboard shortcuts')
    assert.equal(frame.contentRows, rendered.length, `${rows} rows: painted rows must match render`)
    assert.ok(frame.bottomBorder, `${rows} rows: the frame bottom border must be painted:\n${view}`)
    assert.match(view, /Esc: close/, `${rows} rows: the hint must be visible`)
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    // One live TuiApp per process: release the slot before the next size.
    h.app.dispose()
    startedApps.delete(h.app)
  }
})

test('C-T04: a nested resize re-grants without losing the query or the selection', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openKeyboardShortcuts(h)
  for (const character of 'submit') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  assert.match(viewportText(h.vt), /Search: submit/, 'the panel query must be live')
  const selected = selectedRowText(h.vt)

  h.vt.resize(120, 10)
  await h.vt.waitForRender()
  let view = viewportText(h.vt)
  assert.match(view, /Search: submit/, 'the query must survive the shrink')
  assert.match(view, /Esc: clear/, 'a non-empty query keeps the clear verb')
  assert.equal(selectedRowText(h.vt), selected, 'the selection must survive the shrink')
  let frame = paintedFrame(h.vt, 'Keyboard shortcuts')
  assert.ok(frame.bottomBorder, `the shrunk frame bottom border must be painted:\n${view}`)
  assert.ok(frame.contentRows <= 6, `the shrunk frame must fit the 10-row terminal (got ${frame.contentRows})`)

  h.vt.resize(120, 60)
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /Search: submit/, 'the query must survive the grow')
  assert.equal(selectedRowText(h.vt), selected, 'the selection must survive the grow')
  frame = paintedFrame(h.vt, 'Keyboard shortcuts')
  assert.ok(frame.bottomBorder, `the grown frame bottom border must be painted:\n${view}`)
  assert.match(view, /Esc: clear/)
})

test('C-T05: the nested binding-choice view keeps its rows, its hint and its navigation', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openKeyboardShortcuts(h)
  for (const character of 'submit draft') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r') // Enter: open the action detail
  await h.vt.waitForRender()
  assert.match(viewportText(h.vt), /Keyboard shortcuts › /, 'the action detail must open')
  h.vt.sendInput('a') // choose a binding kind
  await h.vt.waitForRender()
  let view = viewportText(h.vt)
  assert.match(view, /Choose what to record:/)
  assert.match(view, /Direct shortcut/)
  assert.match(view, /Leader completion/)
  assert.match(view, /Esc: back/)
  let frame = paintedFrame(h.vt, 'Enter: choose')
  assert.ok(frame.bottomBorder, `the choice frame bottom border must be painted:\n${view}`)
  // Navigation through the REAL chain: Down/Up move the marker between the
  // two choices, and Enter accepts the selected one (starts its recorder).
  assert.match(selectedRowText(h.vt), /Direct shortcut/)
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.match(selectedRowText(h.vt), /Leader completion/, 'Down must select the leader choice')
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  assert.match(selectedRowText(h.vt), /Direct shortcut/, 'Up must return to the direct choice')

  // A short grant: the footer and the selected choice row must survive.
  h.vt.resize(120, 8)
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /Esc: back/, 'the binding-choice footer must survive the shrink')
  assert.match(selectedRowText(h.vt), /Direct shortcut/, 'the selected choice row must stay painted')
  frame = paintedFrame(h.vt, 'Enter: choose')
  assert.ok(frame.bottomBorder, `the choice frame bottom border must survive the shrink:\n${view}`)
  // Enter accepts the painted selection even on the short grant.
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.match(viewportText(h.vt), /Record shortcut/, 'Enter must start the selected direct recorder')
})

test('C-T07: an unavailable settings service keeps its real error, its Esc hint and its Esc path', async () => {
  const h = setup({ columns: 120, rows: 40, tuiSettings: false })
  await openKeyboardShortcuts(h)
  const view = viewportText(h.vt)
  assert.match(view, /Keyboard shortcuts unavailable/)
  assert.match(view, /The settings service could not be read\./)
  assert.match(view, /Esc: back/)
  const frame = paintedFrame(h.vt, 'Keyboard shortcuts unavailable')
  assert.ok(frame.bottomBorder, `the fallback frame bottom border must be painted:\n${view}`)
  // Esc returns to the parent settings list (the submenu slot closes).
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  const after = viewportText(h.vt)
  assert.ok(!after.includes('Keyboard shortcuts unavailable'), `Esc must return to the parent list:\n${after}`)
  assert.match(after, /Type to search/, 'the settings list must be interactive again')
})

test('C-T09: the Theme submenu keeps the same live grant chain (positive control)', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openLegacySettingsPanel(h.invoke, h.vt)
  for (const character of 'theme') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  let view = viewportText(h.vt)
  assert.match(view, /\[current\]/, 'the theme submenu must keep its source-qualified current chip')
  assert.match(view, /Enter\/Space to change · Esc to cancel/, 'the theme submenu hint must be painted')
  h.vt.resize(120, 10) // shrink: the outer grant must reach the inner SettingsList
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /\[current\]/, 'the current chip must survive the shrink')
  assert.match(view, /Enter\/Space to change · Esc to cancel/, 'the hint must survive the shrink')
  assert.ok(paintedFrame(h.vt, '[current]').bottomBorder, `the theme frame bottom border must survive the shrink:\n${view}`)
})

test('C-T13: the Theme submenu [current] chip keeps textMuted on BOTH the selected and the unselected row (real overlay frame)', async () => {
  // §4.5/§12.2 + rollout PR5b requirement 4: the vendored
  // `settingsListTheme.value` paints `selected ? primary : textDim`, so the
  // cell colour is asserted in the REAL painted frame in both states — a
  // string-level assertion cannot see the re-colour.
  const h = setup({ columns: 120, rows: 40 })
  await openLegacySettingsPanel(h.invoke, h.vt)
  for (const character of 'theme') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  // The current row is the doc's `auto` and the submenu opens on it: the
  // SELECTED state is the first frame.
  const selectedRow = rowOf(h.vt, '[current]')
  assert.ok(isCursorRow(h.vt, selectedRow), `the first frame must have the cursor ON the [current] row:\n${viewportText(h.vt)}`)
  assert.equal(h.vt.getCellFgRgb(selectedRow, cellIndexOf(h.vt, selectedRow, '[current]')), hexToRgb(currentPalette.textMuted),
    `the [current] chip is textMuted on the SELECTED row (not primary):\n${viewportText(h.vt)}`)
  // Move the cursor off the current row: the UNSELECTED state must keep the
  // SAME ink (not textDim).
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  const unselectedRow = rowOf(h.vt, '[current]')
  assert.ok(!isCursorRow(h.vt, unselectedRow), `the second frame must have the cursor OFF the [current] row:\n${viewportText(h.vt)}`)
  assert.equal(h.vt.getCellFgRgb(unselectedRow, cellIndexOf(h.vt, unselectedRow, '[current]')), hexToRgb(currentPalette.textMuted),
    `the [current] chip is textMuted on the UNSELECTED row (not textDim):\n${viewportText(h.vt)}`)
})

test('C-T14: the Theme submenu chip survives a narrow frame with an over-wide label (X061, real overlay frame)', async () => {
  // A long plugin theme name pushes the label column to its 36-cell cap, so the
  // value slot is narrow on EVERY row: the chip is reserved (the label clips
  // with `…`) instead of being cut or pushed out of the frame.
  const longName = 'A deliberately very long plugin theme name here'
  for (const columns of [120, 48, 44]) {
    const registry = new ThemeRegistry()
    registry.register({ id: 'long-theme', name: longName, palette: { text: '#123456' } as never }, 'owner-x', 'x')
    const h = setup({ columns, rows: 20, themes: registry })
    await openLegacySettingsPanel(h.invoke, h.vt)
    for (const character of 'theme') {
      h.vt.sendInput(character)
      await h.vt.waitForRender()
    }
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    const view = viewportText(h.vt)
    const marked = view.split('\n').filter(line => line.includes('[current]'))
    assert.equal(marked.length, 1, `at ${columns} columns exactly one row is marked:\n${view}`)
    assert.ok(!/\[curren(?!t\])/.test(marked[0]!), `the chip must be painted whole at ${columns} columns:\n${view}`)
    // The over-wide label is clipped INSIDE its column: no row may overflow.
    for (const line of view.split('\n')) {
      assert.ok(visibleWidth(line) <= columns, `no painted row may exceed ${columns} columns:\n${line}`)
    }
    h.app.stop()
    // A fresh process slot per width (the fork's keybindings are process-global).
    h.app.dispose()
  }
})

test('C-T15: two long same-prefix theme names stay distinguishable at 44 columns (PR #309 review)', async () => {
  const prefix = 'A deliberately very long theme name '
  const suffixA = `${prefix}alpha`
  const suffixB = `${prefix}bravo`
  const h = setup({ columns: 44, rows: 20, themes: (() => {
    const registry = new ThemeRegistry()
    registry.register({ id: 'long-a', name: suffixA, palette: { text: '#123456' } as never }, 'owner-x', 'x')
    registry.register({ id: 'long-b', name: suffixB, palette: { text: '#654321' } as never }, 'owner-x', 'x')
    return registry
  })() })
  await openLegacySettingsPanel(h.invoke, h.vt)
  for (const character of 'theme') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  const view = viewportText(h.vt)
  const rowA = view.split('\n').find(line => line.includes('alpha'))
  const rowB = view.split('\n').find(line => line.includes('bravo'))
  assert.ok(rowA !== undefined && rowB !== undefined,
    `each theme row must keep its own tail:\n${view}`)
  assert.notEqual(rowA, rowB, `the two rows must not paint identically:\n${view}`)
  // Both ENDS must survive: the head identifies the theme, the tail separates the pair.
  assert.ok(rowA.includes('A deliberate') && rowB.includes('A deliberate'),
    `each row must keep the name's head too:\n${view}`)
  // Walk the cursor onto the first long row: its description must carry the
  // COMPLETE display name (the row identity), not only the source class.
  for (let step = 0; step < 6; step += 1) {
    if (viewportText(h.vt).split('\n').some(line => line.includes('alpha') && line.includes('> '))) break
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
  }
  // The description WRAPS, so the complete name spans two painted lines.
  const flat = viewportText(h.vt).replace(/\u2502/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ')
  assert.ok(flat.includes(suffixA),
    `the selected row's description must expand the complete name:\n${viewportText(h.vt)}`)
  h.app.stop()
})

test('C-T16: the Theme submenu searches the complete name, not the abbreviated label (PR #309 review)', async () => {
  // The external review's exact case: the label is abbreviated for its column
  // (`Classic Dark…l Edition v9`), so the list — which runs `enableSearch: true` —
  // must read the row's COMPLETE display name (fork X062), or `quasar` answers an
  // empty list even though the theme exists.
  const registry = new ThemeRegistry()
  registry.register(
    { id: 'classic', name: 'Classic Dark quasar Special Edition v9', palette: { text: '#123456' } as never },
    'owner-x',
    'x',
  )
  const h = setup({ columns: 120, rows: 24, themes: registry })
  await openLegacySettingsPanel(h.invoke, h.vt)
  for (const character of 'theme') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  const labelRow = viewportText(h.vt).split('\n').find(line => line.includes('Classic Dark'))
  assert.ok(labelRow !== undefined, `the theme row must paint:\n${viewportText(h.vt)}`)
  assert.ok(labelRow.includes('\u2026') && !labelRow.includes('quasar'),
    `the label must be the abbreviation that cut the keyword: ${JSON.stringify(labelRow)}`)
  // The search goes through the REAL submenu input, not the row object.
  h.vt.sendInput('quasar')
  await h.vt.waitForRender()
  const view = viewportText(h.vt)
  assert.ok(!view.includes('No matching settings'), `a middle keyword must still find the theme row:\n${view}`)
  assert.ok(view.includes('Classic Dark quasar Special Edition v9'),
    `the found row must carry the complete name:\n${view}`)
  h.app.stop()
})

test('C-T11: a question suspends the nested submenu and restores its grant and query', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openKeyboardShortcuts(h)
  for (const character of 'submit') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  const question = h.app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await h.vt.waitForRender()
  let view = viewportText(h.vt)
  assert.match(view, /Proceed\?/, 'the question must take the front')
  assert.ok(!view.includes('Search: submit'), `the suspended submenu must be hidden:\n${view}`)
  h.vt.sendInput('1')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /Search: submit/, 'the submenu query must survive the suspension')
  const frame = paintedFrame(h.vt, 'Keyboard shortcuts')
  assert.ok(frame.bottomBorder, `the restored frame bottom border must be painted:\n${view}`)
  assert.match(view, /Esc: clear/)
})

test('C-T12: a mouse press acts on the painted row and a click after a resize uses the new frame', async () => {
  const h = setup({ columns: 120, rows: 40 })
  // Fullscreen makes the composited overlay's screen rows match the app's
  // own layout rows (the inline screen's scroll origin does not), so the
  // synthetic SGR coordinates address the same cells the user sees.
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  await openKeyboardShortcuts(h)
  for (const character of 'submit draft') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  let lines = h.vt.getViewport().map(stripAnsi)
  const actionRow = lines.findIndex(line => line.includes('Submit draft'))
  assert.ok(actionRow >= 0, `the filtered action row must be painted:\n${lines.join('\n')}`)
  const column = lines[actionRow]!.indexOf('│') + 4
  assert.ok(column >= 4)
  // Mouse parity: the painted row identity decides, never a re-derived list
  // index — the SAME address must be re-resolved for the current paint.
  h.vt.sendInput(`\x1b[<0;${column};${actionRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;${column};${actionRow + 1}m`)
  await h.vt.waitForRender()
  assert.match(viewportText(h.vt), /Keyboard shortcuts › /, 'the painted action row must open its detail')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()

  // A press, then a resize before the repaint: the last-painted mouse
  // geometry is fenced, so the release must not act on the stale frame.
  h.vt.sendInput(`\x1b[<0;${column};${actionRow + 1}M`)
  h.vt.resize(120, 30)
  h.vt.sendInput(`\x1b[<0;${column};${actionRow + 1}m`)
  await h.vt.waitForRender()
  assert.ok(!viewportText(h.vt).includes('Keyboard shortcuts › '), 'a click after a resize without a repaint must be fenced')

  // After the repaint the SAME cell address may hold a different row: the
  // click is re-derived from the new paint.
  lines = h.vt.getViewport().map(stripAnsi)
  const repaintedRow = lines.findIndex(line => line.includes('Submit draft'))
  assert.ok(repaintedRow >= 0, `the action row must be painted after the resize:\n${lines.join('\n')}`)
  const repaintedColumn = lines[repaintedRow]!.indexOf('│') + 4
  h.vt.sendInput(`\x1b[<0;${repaintedColumn};${repaintedRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;${repaintedColumn};${repaintedRow + 1}m`)
  await h.vt.waitForRender()
  assert.match(viewportText(h.vt), /Keyboard shortcuts › /, 'the repainted row must be clickable')
})

test('C-T10: the outer settings list keeps its own filter and navigation (baseline)', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openLegacySettingsPanel(h.invoke, h.vt)
  const marked = (): string => {
    // A LIST row, not the search prompt (which trims to a bare `>`) and not the
    // detail's title row (the same `> <label>` shape, painted earlier): every settings
    // row carries its value after the padded label column.
    const line = h.vt.getViewport().map(stripAnsi)
      .find(row => row.includes('│') && rowContent(row).startsWith('> ') && /\S {2,}\S/.test(rowContent(row)))
    assert.ok(line !== undefined, `no selected settings row painted:\n${viewportText(h.vt)}`)
    return line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')).trim()
  }
  // No paging wrapper is added by this PR: the fork SettingsList keeps its
  // own selection/filter path (the filtered-state Home/End paging gap is
  // Phase 3B Settings-Workspace debt, not a PR-C claim).
  const first = marked()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  const second = marked()
  assert.notEqual(second, first, 'Down must move the outer settings selection')
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  assert.equal(marked(), first, 'Up must return to the previous settings row')
  for (const character of 'home') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  assert.match(viewportText(h.vt), /> home/, 'the outer settings search must still filter')
  assert.match(marked(), /Home\/End keys/, 'the filtered row must be selectable')
})

test('C-T08: the bare /keybindings command keeps the whole-terminal budget and disposes its panel once', async () => {
  for (const [columns, rows] of [[80, 24], [120, 40]] as const) {
    const h = setup({ columns, rows })
    h.invoke('keybindings')
    await h.vt.waitForRender()
    let view = viewportText(h.vt)
    const panel = h.standalone().panel
    assert.ok(panel !== undefined, `${columns}x${rows}: the real command must mount the plugin panel:\n${view}`)
    // The standalone editor never receives `setMaxRows`: its budget is the
    // whole-terminal cap (rows - 4), not the nested 26 content rows.
    const cap = h.app.keybindingEditorMaxRows()
    assert.equal(cap, rows - 4)
    const rendered = panel.render(84)
    assert.equal(rendered.length, cap - 1, `${columns}x${rows}: the standalone editor must use its own budget`)
    if (rows >= 40) assert.ok(rendered.length > 26, `${columns}x${rows}: the nested cap must not shrink the standalone editor`)
    const frame = paintedFrame(h.vt, 'Keyboard shortcuts')
    assert.equal(frame.contentRows, rendered.length, `${columns}x${rows}: painted rows must match the standalone render`)
    assert.ok(frame.bottomBorder, `${columns}x${rows}: the standalone frame bottom border must be painted:\n${view}`)
    assert.match(view, /Esc: close/)
    // Esc (empty query) closes the REAL panel: the base screen returns and
    // the panel's teardown effect ran exactly once (the owning frame's later
    // dispose call must not reach the teardown body again).
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    view = viewportText(h.vt)
    assert.ok(!view.includes('Keyboard shortcuts'), `${columns}x${rows}: Esc must close the standalone editor:\n${view}`)
    const closed = h.standalone()
    assert.equal(closed.teardowns, 1, `${columns}x${rows}: the panel teardown effect must run exactly once`)
    // A repeated close is idempotent.
    closed.close?.()
    await h.vt.waitForRender()
    assert.equal(h.standalone().teardowns, 1, `${columns}x${rows}: a repeated close must not re-run the teardown body`)
    h.app.dispose()
    startedApps.delete(h.app)
  }
})

test('C-T11b: an approval suspends the nested submenu and restores its grant and query', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openKeyboardShortcuts(h)
  for (const character of 'submit') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  const approval = h.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await h.vt.waitForRender()
  let view = viewportText(h.vt)
  assert.match(view, /Approve bash\?/, 'the approval must take the modal front')
  assert.ok(!view.includes('Search: submit'), `the suspended submenu must be hidden:\n${view}`)
  h.vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /Search: submit/, 'the submenu query must survive the approval')
  assert.match(view, /Esc: clear/, 'the submenu grant must survive the approval')
  assert.ok(paintedFrame(h.vt, 'Keyboard shortcuts').bottomBorder, `the restored frame bottom border must be painted:\n${view}`)
})

test('C-T12b: a narrow terminal with a wide (CJK) query stays bounded and keeps its painted hit map', async () => {
  const h = setup({ columns: 44, rows: 12 })
  // Fullscreen aligns the composited overlay rows with the app layout rows,
  // so the synthetic SGR cells address what the user sees (see C-T12).
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  await openKeyboardShortcuts(h)
  // The panel's own copy is ASCII, so the wide (2-cell) content enters
  // through the query row and the frame truncation it triggers.
  for (const character of '提交') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  let lines = h.vt.getViewport().map(stripAnsi)
  assert.deepEqual(lines.filter(line => visibleWidth(line) > h.vt.columns), [], `no painted row may exceed the terminal width:\n${lines.join('\n')}`)
  const panel = h.panel()
  assert.ok(panel !== undefined)
  const frame = paintedFrame(h.vt, 'Search')
  assert.equal(frame.contentRows, panel.render(40).length, 'the narrow frame must paint the granted rows')
  assert.ok(frame.bottomBorder, `the narrow CJK frame bottom border must be painted:\n${lines.join('\n')}`)
  // The hint ROW is mandatory; at 44 columns the frame truncation may cut
  // its tail text (pre-existing width behavior, not a grant regression).
  assert.ok(lines.some(line => line.includes('Enter: details')), `the operation hint row must be painted:\n${lines.join('\n')}`)
  // Clear the wide query, filter to one action and click its PAINTED row.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  for (const character of 'submit') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  lines = h.vt.getViewport().map(stripAnsi)
  assert.deepEqual(lines.filter(line => visibleWidth(line) > h.vt.columns), [], `the filtered frame must stay bounded:\n${lines.join('\n')}`)
  const actionRow = lines.findIndex(line => line.includes('Submit draft'))
  assert.ok(actionRow >= 0, `the filtered action row must be painted:\n${lines.join('\n')}`)
  const column = lines[actionRow]!.indexOf('│') + 4
  h.vt.sendInput(`\x1b[<0;${column};${actionRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;${column};${actionRow + 1}m`)
  await h.vt.waitForRender()
  // At this grant the action detail's own viewport scrolls its title off,
  // so identify the detail by its footer and then prove the IDENTITY of the
  // clicked row: Esc returns to the list with the clicked action selected.
  assert.match(viewportText(h.vt), /Enter: edit · a: add/, 'the narrow painted row must open an action detail')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.match(selectedRowText(h.vt), /Submit draft/, 'the detail must belong to the clicked painted row')
})
