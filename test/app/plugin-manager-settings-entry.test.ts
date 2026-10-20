/**
 * `Settings → Plugins` entry tests (S4-D1 + S4-D2 / D2-0): Plugins is a
 * first-level Settings category that opens the ONE fullscreen Plugin page IN
 * PLACE (no empty Rows level, no legacy overlay), and returning restores the
 * same Settings screen with Plugins still selected. Since D2-0 the multi-column
 * Rows pane paints ONE UI-only `Open Plugin Manager` action affordance for that
 * category; it is never a Settings row and opens the SAME page as Enter/Right.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-settings-entry.test
 */

import assert from 'node:assert/strict'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function plain(view: readonly string[]): string {
  return view.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

/** The terminal-CELL column of the first painted occurrence of `needle`. */
function cellIndexOf(view: readonly string[], row: number, needle: string): number {
  const line = plain([view[row] ?? '']).trimEnd()
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}:\n${plain(view)}`)
  return visibleWidth(line.slice(0, index))
}

function rowOf(view: readonly string[], needle: string): number {
  const rows = view.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const row = rows.findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${rows.join('\n')}`)
  return row
}

function setup(options: { columns?: number; rows?: number } = {}): {
  invoke: (name: string) => unknown
  counts: { opened: number; page: number; disposed: number }
  vt: VirtualTerminal
  done: () => void
} {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.columns ?? 100, options.rows ?? 30)
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
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const counts = { opened: 0, page: 0, disposed: 0 }
  let pageDone: (() => void) | undefined
  const page: Component & { handleInput(data: string): void; dispose(): void } = {
    render: (width: number) => ['PLUGIN PAGE'.padEnd(Math.max(1, width))],
    invalidate: () => {},
    handleInput: (data: string) => {
      if (data === '\x1b') pageDone?.()
    },
    dispose: () => { counts.disposed += 1 },
  }
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    listScopedCommands: () => [],
    tuiSettings: undefined,
    extensions: undefined,
    openPluginManager: () => { counts.opened += 1 },
    createPluginManagerPage: (done: () => void) => {
      counts.page += 1
      pageDone = done
      return page
    },
    config: {
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name: string): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return { invoke, counts, vt, done: () => pageDone?.() }
}

const press = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const release = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}

/** Move the L0 selection from Appearance to Plugins (two categories down). */
async function selectPlugins(vt: VirtualTerminal): Promise<void> {
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
}

test('opening /settings alone never builds the inline Plugin page', async () => {
  const { invoke, counts, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  assert.equal(counts.page, 0)
  assert.equal(counts.opened, 0)
  // The first-level category is visible; Plugins is one of the four.
  const view = plain(vt.getViewport())
  assert.match(view, /Settings/)
  assert.match(view, /Plugins/)
})

test('Settings → Plugins opens the page in place; Esc returns to the same Settings L0', async () => {
  const { invoke, counts, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  await selectPlugins(vt)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'activating the Plugins category builds the shared page')
  assert.equal(counts.opened, 0)
  assert.match(plain(vt.getViewport()), /PLUGIN PAGE/)

  // The page's normal close returns to Settings L0 with Plugins selected.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const back = plain(vt.getViewport())
  assert.doesNotMatch(back, /PLUGIN PAGE/)
  assert.match(back, /Settings/)
  assert.match(back, /Plugins/)
  assert.match(back, /> Plugins/)
  assert.equal(counts.disposed, 1, 'the hosted page is disposed exactly once on normal close')
})

test('D2-0: wide 120×40 paints the Rows pane direct entry at its own column', async () => {
  for (const [columns, rows] of [[120, 40], [80, 24]] as const) {
    const { invoke, counts, vt } = setup({ columns, rows })
    await invoke('settings')
    await vt.waitForRender()
    await selectPlugins(vt)
    const view = vt.getViewport()
    const navRow = rowOf(view, 'Open Plugin Manager')
    const headerRow = rowOf(view, 'Rows (1)')
    assert.match(view[0]!, /Settings · Categories/, 'Plugins keeps the L0 header')
    assert.ok(view.some(line => line.includes('Rows (1)')), `the Rows header counts the one visible affordance:\n${plain(view)}`)
    assert.ok(!view.some(line => line.includes('Rows (0)')), 'the Plugins Rows pane is never painted as an empty (0) list')
    // The affordance is painted in the SECOND column: categories own 22 cells
    // plus the 2-cell gutter, exactly like the real row list at this width.
    assert.equal(cellIndexOf(view, headerRow, 'Rows (1)'), 24, `the Rows column starts at cell 24:\n${plain(view)}`)
    assert.equal(cellIndexOf(view, navRow, 'Open Plugin Manager'), 26, 'the action name keeps the list\'s two-cell indent inside the rows pane')
    assert.match(plain([view[navRow]!]).slice(24), /^  Open Plugin Manager/, 'no second strong selection cursor is painted')
    assert.equal(counts.page, 0, 'painting the affordance never builds the page')
    disposeCaseApps()
  }
})

test('D2-0: Enter, Right and a real mouse click open the SAME single page', async () => {
  const { invoke, counts, vt } = setup({ columns: 120, rows: 40 })
  await invoke('settings')
  await vt.waitForRender()
  await selectPlugins(vt)

  // Enter opens the page; while it is open the second entry key cannot build
  // a second page or lease another screen.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1)
  vt.sendInput('\x1b[C')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'the open page owns the input; no second factory runs')
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // Right opens the SAME entry after returning to L0.
  vt.sendInput('\x1b[C')
  await vt.waitForRender()
  assert.equal(counts.page, 2)
  assert.match(plain(vt.getViewport()), /PLUGIN PAGE/)
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // A real press→release on the painted affordance opens the same page. A bare
  // press proves nothing yet.
  const view = vt.getViewport()
  const navRow = rowOf(view, 'Open Plugin Manager')
  const navCol = cellIndexOf(view, navRow, 'Open Plugin Manager')
  press(vt, navRow, navCol)
  await vt.waitForRender()
  assert.equal(counts.page, 2, 'a press alone never dispatches the page')
  release(vt, navRow, navCol)
  await vt.waitForRender()
  assert.equal(counts.page, 3)
  assert.match(plain(vt.getViewport()), /PLUGIN PAGE/)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /> Plugins/)
})

test('D2-0: a stale release cannot open the page after a category switch, refresh, resize or close', async () => {
  const scenarios = ['category', 'refresh', 'resize', 'close'] as const
  for (const scenario of scenarios) {
    const { invoke, counts, vt } = setup({ columns: 120, rows: 40 })
    await invoke('settings')
    await vt.waitForRender()
    await selectPlugins(vt)
    let view = vt.getViewport()
    const navRow = rowOf(view, 'Open Plugin Manager')
    const navCol = cellIndexOf(view, navRow, 'Open Plugin Manager')
    press(vt, navRow, navCol)
    await vt.waitForRender()
    if (scenario === 'category') {
      vt.sendInput('\x1b[B')
      await vt.waitForRender()
      assert.ok(plain(vt.getViewport()).includes('> Other settings'), 'the category really changed under the press')
    } else if (scenario === 'refresh') {
      vt.sendInput('r')
      await vt.waitForRender()
      view = vt.getViewport()
    } else if (scenario === 'resize') {
      vt.resize(80, 24)
      await vt.waitForRender()
    } else {
      vt.sendInput('\x1b')
      await vt.waitForRender()
      assert.doesNotMatch(plain(vt.getViewport()), /Settings · Categories/, 'the workspace really closed under the press')
    }
    release(vt, navRow, navCol)
    await vt.waitForRender()
    assert.equal(counts.page, 0, `a release after a ${scenario} change must not open the page`)
    disposeCaseApps()
  }
})

test('D2-0: narrow 44×20 keeps the direct key entry and restores L0 with Plugins selected', async () => {
  const { invoke, counts, vt } = setup({ columns: 44, rows: 20 })
  await invoke('settings')
  await vt.waitForRender()
  await selectPlugins(vt)
  const view = plain(vt.getViewport())
  assert.doesNotMatch(view, /Rows \(/, 'the narrow projection has no second column')
  assert.doesNotMatch(view, /Open Plugin Manager/, 'the narrow projection paints no second-column affordance')
  assert.match(view, /> Plugins/)
  assert.match(view, /Enter open · Esc close/)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /> Plugins/)
})

test('D2-0: every other category keeps its real Rows list and level navigation', async () => {
  const { invoke, counts, vt } = setup({ columns: 120, rows: 40 })
  await invoke('settings')
  await vt.waitForRender()
  const view = vt.getViewport()
  assert.ok(view.some(line => line.includes('Rows (2)')), `Appearance keeps its two real rows:\n${plain(view)}`)
  assert.ok(!plain(view).includes('Open Plugin Manager'), 'the Plugins affordance never leaks into another category')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(vt.getViewport().some(line => line.includes('[Rows (2)]')), 'Enter still enters the real L1')
  assert.equal(counts.page, 0)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(plain(vt.getViewport()).includes('> Appearance'))
})

/** Dispose THIS case's app immediately: the loop scenarios share one test and
 *  must not leave two apps owning the same global surface. */
function disposeCaseApps(): void {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
}
