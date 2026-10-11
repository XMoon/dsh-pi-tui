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
import { VirtualTerminal } from './virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from './support/register-tui-commands.ts'

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

/** The selected (cursor-marked) row of the keyboard shortcut list: the
 * frame content between its own borders (a row composited over a base-screen
 * line must not contribute text). */
function selectedRowText(vt: VirtualTerminal): string {
  const line = vt.getViewport().map(stripAnsi).find(row => row.includes('›') && row.includes('│'))
  assert.ok(line !== undefined, `no selected row painted:\n${viewportText(vt)}`)
  return line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')).trim()
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly invoke: (name: string) => unknown
  readonly panel: () => KeybindingEditorPanel | undefined
}

/**
 * Mount the real `/settings` command on a real app. The runner is a
 * defaults-permissive stub (every unset dependency is a no-op), matching
 * the existing `/settings` command-entry suites; the pointed-at seams
 * (commands registry, tuiSettings doc, config readiness) are real.
 */
function setup(options: { columns?: number; rows?: number; tuiSettings?: boolean } = {}): Harness {
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
    extensions: undefined,
    openPluginManager: () => {},
    createPluginManagerSubmenu: () => ({ render: () => [], invalidate: () => {} }),
    config: {
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
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
  return { vt, app, invoke, panel: () => captured }
}

/** `/settings` → filter to the Keyboard shortcuts row → Enter. */
async function openKeyboardShortcuts(h: Harness, filter = 'keyboard'): Promise<void> {
  h.invoke('settings')
  await h.vt.waitForRender()
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

  // A short grant: the footer and the selected choice row must survive.
  h.vt.resize(120, 8)
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /Esc: back/, 'the binding-choice footer must survive the shrink')
  assert.match(view, /›/, 'the selected choice row must stay painted')
  frame = paintedFrame(h.vt, 'Enter: choose')
  assert.ok(frame.bottomBorder, `the choice frame bottom border must survive the shrink:\n${view}`)
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
  h.invoke('settings')
  await h.vt.waitForRender()
  for (const character of 'theme') {
    h.vt.sendInput(character)
    await h.vt.waitForRender()
  }
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  let view = viewportText(h.vt)
  assert.match(view, /← current/, 'the theme submenu must keep its source-qualified current marker')
  assert.match(view, /Enter\/Space to change · Esc to cancel/, 'the theme submenu hint must be painted')
  h.vt.resize(120, 10) // shrink: the outer grant must reach the inner SettingsList
  await h.vt.waitForRender()
  view = viewportText(h.vt)
  assert.match(view, /← current/, 'the current marker must survive the shrink')
  assert.match(view, /Enter\/Space to change · Esc to cancel/, 'the hint must survive the shrink')
  assert.ok(paintedFrame(h.vt, '← current').bottomBorder, `the theme frame bottom border must survive the shrink:\n${view}`)
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
  h.invoke('settings')
  await h.vt.waitForRender()
  const marked = (): string => {
    const line = h.vt.getViewport().map(stripAnsi).find(row => row.includes('›') && row.includes('│'))
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
