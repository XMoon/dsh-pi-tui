/**
 * `Settings → Plugins` entry tests (S4-D1 + PR2): Plugins is a first-level
 * Settings category whose RIGHT column is the ONE embedded Plugin Manager
 * page. Selecting the category paints the real list preview at once while the
 * rail keeps the keyboard; `Enter`/`Right`/`Tab` only hand the keyboard to the
 * page; `Esc` from the plugin List yields back to the rail (the page instance
 * and its Host claim survive) and a second `Esc` closes the Settings lease.
 * `/plugins` is the deep link into that SAME lease.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-settings-entry.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { TuiCommandRunner } from '../../src/commands.ts'
import type {
  EmbeddedPluginPage,
  PluginContentViewport,
  PluginWorkspaceView,
} from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
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

/** A minimal embedded Plugin page: it paints only inside its granted viewport,
 *  keeps ONE semantic bar as its local last line, and reports the navigation
 *  yield instead of closing anything. */
class FakeEmbeddedPluginPage implements EmbeddedPluginPage {
  readonly viewports: PluginContentViewport[] = []
  readonly presses: [number, number][] = []
  readonly clicks: [number, number][] = []
  disposed = false
  focused = false
  /** Bumps on every fake-local state change (see gestureRevision()). */
  private viewRevision = 0
  private view: PluginWorkspaceView = 'list'
  private readonly yieldNavigation: () => void
  private readonly onDispose: () => void
  constructor(yieldNavigation: () => void, onDispose: () => void) {
    this.yieldNavigation = yieldNavigation
    this.onDispose = onDispose
  }
  setViewport(viewport: PluginContentViewport): void {
    this.viewports.push({ ...viewport })
  }
  currentView(): PluginWorkspaceView {
    return this.view
  }
  canYieldFocusToNavigation(): boolean {
    return this.view === 'list'
  }
  pendingMutation(): boolean {
    return false
  }
  gestureRevision(): number {
    return this.viewRevision
  }

  semanticGeneration(): number {
    return this.viewRevision
  }
  grantAwaitingPaint(): boolean {
    return false
  }

  liveIdentity(): string {
    return `${this.viewRevision}:${this.view}`
  }
  cancelPointer(): void {}
  contentLayout(): { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number } {
    const viewport = this.viewports[this.viewports.length - 1] ?? { width: 1, rows: 1, allowDual: false }
    // The SAME frozen local rule the production page applies (the shared pane
    // header must describe the columns really painted).
    const body = Math.max(0, viewport.rows - 1)
    const dual = viewport.allowDual && viewport.width >= 76 && body >= 6
    const leftWidth = dual ? Math.min(42, Math.max(30, Math.floor((viewport.width - 2) * 0.42))) : viewport.width
    return { dual, leftWidth, rightWidth: dual ? viewport.width - leftWidth - 2 : viewport.width }
  }
  render(width: number): string[] {
    const rows = Math.max(1, this.viewports[this.viewports.length - 1]?.rows ?? 1)
    const safeWidth = Math.max(1, width)
    const lines = Array.from({ length: rows }, (_, index) => index === 0 ? 'PLUGIN PAGE'.padEnd(safeWidth) : ' '.repeat(safeWidth))
    lines[rows - 1] = 'PLUGIN BAR'.padEnd(safeWidth)
    return lines
  }
  invalidate(): void {}
  handleInput(data: string): void {
    // The plugin List root's Esc yields; the ROOT commits the focus change.
    if (data === '\u001b') this.yieldNavigation()
  }
  handleMouse(): undefined { return undefined }
  onCellPress(x: number, y: number): void { this.presses.push([x, y]) }
  onCellClick(x: number, y: number): void { this.clicks.push([x, y]) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.onDispose()
  }
}

function setup(options: { columns?: number; rows?: number } = {}): {
  invoke: (name: string) => unknown
  counts: { page: number; disposed: number; aboutReads: number }
  pages: FakeEmbeddedPluginPage[]
  vt: VirtualTerminal
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
  const counts = { page: 0, disposed: 0, aboutReads: 0 }
  const pages: FakeEmbeddedPluginPage[] = []
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
    // C3 About seams: this fixture composes no StatusRuntime, so a Session read
    // can only be attempted through the sessionless path (which must not run).
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => { counts.aboutReads += 1; return undefined },
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    // The prompt-state objects are REQUIRED runner facts: the Conversation rows
    // read their live values through the same shared objects the registered
    // prompt providers read.
    progressUpdatesState: { mode: 'milestones' as const },
    responseStyleState: { style: 'default' as const },
    gitAttributionState: { mode: 'off' as const },
    // C2-R2: the completion controller's read-only facts. This composition's
    // Settings rows read them back; /settings itself stays the same surface.
    currentNotificationMode: () => 'unfocused' as const,
    currentNotificationMethod: () => 'auto' as const,
    tuiSettings: undefined,
    extensions: undefined,
    createPluginManagerPage: (onYieldNavigation: () => void) => {
      counts.page += 1
      const page = new FakeEmbeddedPluginPage(onYieldNavigation, () => { counts.disposed += 1 })
      pages.push(page)
      return page
    },
    config: settingsDirectPageConfig({
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false },
    }),
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
  return { invoke, counts, pages, vt }
}

const press = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const release = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}

/** Walk the Settings category rail to one category with the real keys. */
const selectCategory = selectSettingsCategory

/** Move the L0 selection to the Plugins category. */
async function selectPlugins(vt: VirtualTerminal): Promise<void> {
  await selectCategory(vt, 'Plugins')
}

test('opening /settings alone never builds the embedded Plugin page', async () => {
  const { invoke, counts, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  assert.equal(counts.page, 0, 'the plugin factory is never called by a plain /settings')
  assert.equal(counts.aboutReads, 0, 'no About Session read starts on the lazy path')
  const view = plain(vt.getViewport())
  assert.match(view, /Settings · Categories/)
  assert.match(view, /> Plugins|Plugins/)
})

test('/plugins deep-links into the SAME Settings lease with the plugin List focused', async () => {
  const { invoke, counts, pages, vt } = setup({ columns: 100, rows: 30 })
  const result = await invoke('plugins') as { kind: string }
  assert.equal(result.kind, 'success')
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'the deep link mounts exactly ONE page')
  const view = plain(vt.getViewport())
  assert.match(view, /Settings · Plugins/, 'the deep link uses the Settings workspace header')
  assert.match(view, /PLUGIN PAGE/, 'the deep link lands on the plugin list')
  assert.match(view, /PLUGIN BAR/, 'the keyboard is already on the plugin list')
  assert.doesNotMatch(view, /Settings · Categories/, 'the deep link is not the About home')
  assert.equal(counts.aboutReads, 0, 'the deep link starts no About read')
  assert.equal(pages[0]!.focused, true, 'the page owns the keyboard')
  // Esc from the List yields to the rail (page kept), a second Esc closes it.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Categories/)
  assert.equal(counts.disposed, 0, 'the yield never disposes the page')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · /, 'the second Esc closed the ONE Settings lease')
  assert.equal(counts.disposed, 1, 'the real teardown disposes the page exactly once')
})

test('selecting Plugins previews the page in place; Enter only moves the keys', async () => {
  const { invoke, counts, pages, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  await selectPlugins(vt)
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'the visible category preview mounts the ONE page')
  const preview = plain(vt.getViewport())
  assert.match(preview, /PLUGIN PAGE/, 'the right column paints the real list preview')
  assert.match(preview, /Settings · Categories/, 'the rail keeps the keyboard (its header owns the trail)')
  assert.match(plain([vt.getViewport().at(-1)!]), /Esc close/, 'the rail owns the physical last row')
  assert.equal(pages[0]!.focused, false, 'the preview does not own the input focus')
  assert.equal(counts.disposed, 0)

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'Enter never builds a second page')
  assert.match(plain([vt.getViewport().at(-1)!]), /PLUGIN BAR/, 'Enter hands the bar to the plugin List')
  assert.equal(pages[0]!.focused, true, 'the page now owns the input focus')
  assert.match(plain(vt.getViewport()), /Settings · Plugins/)

  // Esc from the List yields to the rail; the page instance and its state stay.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(counts.page, 1)
  assert.equal(counts.disposed, 0, 'a yield never disposes the page')
  assert.equal(pages[0]!.focused, false)
  assert.match(plain([vt.getViewport().at(-1)!]), /Esc close/)
  // A second Esc closes the Settings lease and notifies the page once.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · /)
  assert.equal(counts.disposed, 1)
})

test('120×40 previews Categories | List | Details and 80×24 previews Categories | List', async () => {
  for (const [columns, rows, dual] of [[120, 40, true], [80, 24, false]] as const) {
    const { invoke, counts, vt } = setup({ columns, rows })
    await invoke('settings')
    await vt.waitForRender()
    await selectPlugins(vt)
    await vt.waitForRender()
    const view = vt.getViewport()
    const headerRow = rowOf(view, 'Categories (9)')
    assert.match(plain([view[headerRow]!]), /\[Categories \(9\)\]/, `${columns}: the rail is the ONE active device`)
    assert.equal(cellIndexOf(view, headerRow, 'Plugins'), 24, `${columns}: the preview starts after the rail`)
    if (dual) {
      assert.match(plain([view[headerRow]!]), /Details/, `${columns}: the wide preview keeps the Details column label`)
    } else {
      assert.doesNotMatch(plain([view[headerRow]!]), /Details/, `${columns}: the medium rail preview paints no Details label`)
    }
    const previewRow = rowOf(view, 'PLUGIN PAGE')
    assert.equal(cellIndexOf(view, previewRow, 'PLUGIN PAGE'), 24, `${columns}: the preview body is the right column`)
    assert.equal(counts.page, 1)
    disposeStartedApps()
  }
})

test('Enter, Right and a real preview click keep the SAME single page', async () => {
  const { invoke, counts, pages, vt } = setup({ columns: 120, rows: 40 })
  await invoke('settings')
  await vt.waitForRender()
  await selectPlugins(vt)
  assert.equal(counts.page, 1)
  const first = pages[0]!

  // Enter: focus only.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(pages[0], first, 'Enter reuses the mounted page instance')
  assert.equal(counts.page, 1)
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // Right: focus only.
  vt.sendInput('\x1b[C')
  await vt.waitForRender()
  assert.equal(pages[0], first)
  assert.equal(counts.page, 1)
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // A real press→release inside the painted preview transfers the focus to the
  // page and hands it the translated pointer cell; it never mutates anything.
  const view = vt.getViewport()
  const previewRow = rowOf(view, 'PLUGIN PAGE')
  const previewCol = cellIndexOf(view, previewRow, 'PLUGIN PAGE')
  press(vt, previewRow, previewCol)
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'a press alone never mounts a page')
  release(vt, previewRow, previewCol)
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'the release never builds a second page')
  assert.equal(pages[0], first)
  assert.deepEqual(first.presses, [[previewCol - 24, previewRow - 4]], 'the root translated the press into the page viewport')
  assert.deepEqual(first.clicks, [[previewCol - 24, previewRow - 4]], 'the root translated the release into the page viewport')
  assert.match(plain([vt.getViewport().at(-1)!]), /PLUGIN BAR/, 'the click moved the keyboard into the plugin content')
})

test('a stale rail press cannot affect the page after a category, refresh, resize or close change', async () => {
  for (const scenario of ['category', 'refresh', 'resize', 'close'] as const) {
    const { invoke, counts, pages, vt } = setup({ columns: 120, rows: 40 })
    await invoke('settings')
    await vt.waitForRender()
    await selectPlugins(vt)
    const view = vt.getViewport()
    const pluginsRow = rowOf(view, '> Plugins')
    // Press on the ALREADY selected rail category: no release may re-enter the
    // page or resurrect the old frame after a state change.
    press(vt, pluginsRow, 2)
    await vt.waitForRender()
    if (scenario === 'category') {
      vt.sendInput('\x1b[A')
      await vt.waitForRender()
      assert.match(plain(vt.getViewport()), /> Tools/, 'the category really changed under the press')
    } else if (scenario === 'refresh') {
      vt.sendInput('r')
      await vt.waitForRender()
    } else if (scenario === 'resize') {
      vt.resize(80, 24)
      await vt.waitForRender()
    } else {
      vt.sendInput('\x1b')
      await vt.waitForRender()
      assert.doesNotMatch(plain(vt.getViewport()), /Settings · /, 'the workspace really closed under the press')
    }
    release(vt, pluginsRow, 2)
    await vt.waitForRender()
    assert.equal(counts.page, 1, `a release after a ${scenario} change never builds another page`)
    if (scenario === 'close') {
      assert.doesNotMatch(plain(vt.getViewport()), /PLUGIN BAR/, 'the closed workspace never resurrects the page bar')
    }
    assert.deepEqual(pages[0]!.clicks, [], `a release after a ${scenario} change never reaches the page`)
    disposeStartedApps()
  }
})

test('narrow 44×20 mounts the page only on Enter and restores the rail with Plugins selected', async () => {
  const { invoke, counts, pages, vt } = setup({ columns: 44, rows: 20 })
  await invoke('settings')
  await vt.waitForRender()
  await selectPlugins(vt)
  await vt.waitForRender()
  const view = plain(vt.getViewport())
  assert.doesNotMatch(view, /PLUGIN PAGE/, 'a narrow rail selection paints no plugin content')
  assert.equal(counts.page, 0, 'a narrow rail selection mounts nothing')
  assert.match(view, /> Plugins/)
  assert.match(view, /Esc close/)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'Enter mounts the page once')
  assert.match(plain(vt.getViewport()), /Settings · Plugins/)
  assert.match(plain(vt.getViewport()), /PLUGIN PAGE/)
  assert.equal(pages[0]!.viewports.at(-1)?.width, 44, 'the narrow content owns the full width')
  // Esc yields back to the single-column rail; a second Esc closes.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /> Plugins/)
  assert.equal(counts.disposed, 0)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(counts.disposed, 1)
})

test('every other category keeps its real Rows list and level navigation', async () => {
  const { invoke, counts, vt } = setup({ columns: 120, rows: 40 })
  await invoke('settings')
  await vt.waitForRender()
  await selectCategory(vt, 'Appearance')
  const view = vt.getViewport()
  assert.ok(view.some(line => line.includes('Rows (4)')), `Appearance keeps its four real rows:\n${plain(view)}`)
  assert.ok(!plain(view).includes('PLUGIN PAGE'), 'the plugin preview never leaks into another category')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(vt.getViewport().some(line => line.includes('[Rows (4)]')), 'Enter still enters the real L1')
  assert.equal(counts.page, 0)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(plain(vt.getViewport()).includes('> Appearance'))
})
