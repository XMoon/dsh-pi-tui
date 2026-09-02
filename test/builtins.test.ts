/**
 * M3 contract gate: the first-party builtins dogfood the public extension
 * API. A real Cordis tree (startup + extension host + builtins) + a real
 * TuiApp + VirtualTerminal proves:
 * - the version header badge renders;
 * - the turn/step counters are HOST-NATIVE since M1 (plan §13.4 — the
 *   builtin extension segment was removed; the host core state no longer
 *   depends on plugin loading), so they render with or without the
 *   builtins fiber;
 * - builtins use the SAME service API as third-party plugins (no special
 *   host bypass).
 * @module @xmoon76/dsh-pi-tui/builtins.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Text } from '@xmoon76/pi-tui'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import type { PiTuiExtensionService } from '../src/extensions.ts'
import { apply as applyBuiltins } from '../src/builtins.ts'
import type { HeaderBadge } from '../src/extension/public-types.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { TuiApp } from '../src/tui-app.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Mount startup + extension host + builtins; returns the builtins fiber. */
async function mountTree(ctx: Context): Promise<{ builtinsFiber: unknown }> {
  await ctx.plugin(Loader)
  const startupFiber = ctx.plugin((c) => {
    c.provide(TUI_STARTUP_SERVICE, {})
  })
  await startupFiber
  const hostFiber = ctx.plugin(applyExtensionHost)
  await hostFiber
  const builtinsFiber = ctx.plugin(applyBuiltins)
  await builtinsFiber
  return { builtinsFiber }
}

type AttachedExtensionService = PiTuiExtensionService & {
  _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
  attachSurface(
    bridge: { subscribe(listener: (state: unknown) => void): () => void },
    capabilities: ReadonlySet<string>,
    surfaceId: string,
    requestRender?: (force?: boolean) => void,
  ): void
  detachSurface(surfaceId?: string): void
}

type LiveBuiltinApp = {
  service: AttachedExtensionService
  vt: VirtualTerminal
  app: TuiApp
  host: SurfaceHost
}

async function settleRender(app: TuiApp, vt: VirtualTerminal): Promise<void> {
  await settle()
  app.requestRender(true)
  await new Promise<void>(resolve => process.nextTick(resolve))
  await vt.flush()
}

/** Attach the real builtins state bridge to a live TuiApp. */
async function attachBuiltinApp(ctx: Context, width = 80, height = 24): Promise<LiveBuiltinApp> {
  await mountTree(ctx)
  const service = ctx.get('piTuiExtensions') as AttachedExtensionService
  const builtinDockIds = service._ledger().snapshot('input.dock.item').records.map(record => record.id)
  assert.ok(builtinDockIds.includes('builtin-todo-summary'), `builtin todo dock item missing: ${builtinDockIds.join(', ')}`)

  const vt = new VirtualTerminal(width, height)
  let app!: TuiApp
  const host = new SurfaceHost(service._ledger(), () => app.requestRender())
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  startedApps.add(app)
  await settleRender(app, vt)
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId, generation: 1, width, height, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  service.attachSurface(
    { subscribe: listener => host.subscribeState(listener as never) },
    host.capabilitiesOf() as ReadonlySet<string>,
    host.surfaceId,
    force => app.requestRender(force),
  )
  app.refreshChrome()
  await settleRender(app, vt)
  return { service, vt, app, host }
}

async function disposeContext(ctx: Context): Promise<void> {
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
  }
}

async function disposeBuiltinFixture(fixture: LiveBuiltinApp | undefined, ctx: Context): Promise<void> {
  try {
    fixture?.app.dispose()
  } finally {
    fixture?.service.detachSurface(fixture.host.surfaceId)
    await disposeContext(ctx)
  }
}

/** Send one SGR mouse click using 1-based terminal coordinates. */
function sendFullscreenClick(fixture: LiveBuiltinApp, x: number, y: number): void {
  fixture.vt.sendInput(`\x1b[<0;${x};${y}M`)
  fixture.vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function visibleRow(fixture: LiveBuiltinApp, text: string, context: string): number {
  const row = fixture.vt.getViewport().findIndex(line => line.includes(text))
  if (row < 0) throw new Error(`${context}: row containing ${JSON.stringify(text)} is not visible`)
  return row
}

async function clickFullscreenRow(fixture: LiveBuiltinApp, row: number): Promise<void> {
  const x = Math.max(1, Math.floor(fixture.vt.columns / 2))
  sendFullscreenClick(fixture, x, row + 1)
  await settleRender(fixture.app, fixture.vt)
}

async function clickTodoSummary(fixture: LiveBuiltinApp): Promise<void> {
  await clickFullscreenRow(fixture, visibleRow(fixture, '☑', 'todo summary click'))
}

async function clickTodoRow(fixture: LiveBuiltinApp, text: string): Promise<void> {
  await clickFullscreenRow(fixture, visibleRow(fixture, text, 'todo panel click'))
}

/** Reset the Todo target coalescing window without relying on a timer. */
function resetTodoClickGesture(fixture: LiveBuiltinApp): void {
  const x = Math.max(1, Math.floor(fixture.vt.columns / 2))
  sendFullscreenClick(fixture, x, fixture.vt.rows)
}

function assertBuiltinTodoSummary(fixture: LiveBuiltinApp, expected: string, context: string): void {
  const view = fixture.vt.getViewport().join('\n')
  const label = `☑  ${expected}`
  assert.ok(view.includes(label), `${context}: viewport summary missing:\n${view}`)
  assert.equal((view.match(/☑/g) ?? []).length, 1, `${context}: expected exactly one builtin todo summary:\n${view}`)
  assert.ok(fixture.host.dockText().includes(expected), `${context}: builtin dock summary missing: ${fixture.host.dockText()}`)
}

test('builtins register the version badge through the PUBLIC service API; turns/steps are host-native', async () => {
  const ctx = new Context()
  try {
    await mountTree(ctx)
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): { snapshot(slot: string): { records: Array<{ id: string }> } }
    }
    const badgeIds = service._ledger().snapshot('chrome.header.badge').records.map(record => record.id)
    assert.ok(badgeIds.includes('builtin-version'), `version badge missing: ${badgeIds.join(', ')}`)
    // M1 (plan §13.4): the turn/step counters are a HOST-NATIVE footer
    // item — the builtin no longer contributes a chrome.footer.status
    // segment (the host core state must not depend on plugin loading).
    const footerIds = service._ledger().snapshot('chrome.footer.status').records.map(record => record.id)
    assert.ok(!footerIds.includes('builtin-turns-steps'), `the turns-steps segment must be host-native since M1: ${footerIds.join(', ')}`)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the builtins render into a live TuiApp and the turn/step counter tracks state (host parity)', async () => {
  const ctx = new Context()
  try {
    await mountTree(ctx)
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
    }
    const vt = new VirtualTerminal(80, 24)
    const host = new SurfaceHost(service._ledger(), () => app.requestRender())
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    startedApps.add(app)
    await vt.waitForRender()
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: 'tui', generation: 1, width: 80, height: 24, fullscreen: false,
      focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    // Simulate the runner's attachSurface wiring (F-10): the service's
    // state bridge + capability set go live so the builtins' pending state
    // subscription delivers.
    service.attachSurface(
      { subscribe: (listener) => host.subscribeState(listener as never) },
      host.capabilitiesOf() as ReadonlySet<string>,
      host.surfaceId,
    )
    // F-10 (F8): the capability set is LIVE after attachSurface.
    const apiService = service as unknown as { api(): { capabilities: Set<string> } }
    assert.ok(apiService.api().capabilities.has('slot.chrome.header.badge'), 'capabilities must be live after attach')
    app.refreshChrome()
    await settle()
    await vt.waitForRender()

    let view = vt.getViewport().join('\n')
    // Version badge after the host title; the footer shows t0/s0 from the
    // HOST-NATIVE turns-steps item (M1 — no extension segment involved).
    assert.ok(view.includes('dsh-pi-tui'), `host title missing:\n${view}`)
    // Version badge: the installed dsh version first, then the bundle
    // version prefixed `tui-` (`[dsh-… · tui-vX.Y.Z]`); without a dsh
    // launcher (as in tests) it degrades to `[tui-vX.Y.Z]`.
    assert.ok(/\[tui-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\]/.test(view), `version badge missing:\n${view}`)
    assert.ok(view.includes('t0/s0'), `initial turn/step counter missing:\n${view}`)

    // State change: the host-native item re-composes from the projected
    // usage facts.
    app.setStatus({ model: 'm', cwd: '/w', branch: '', turns: 3, steps: 7, statsLine: '' })
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('t3/s7'), `turn/step counter did not track state:\n${view}`)
    assert.ok(!view.includes('t0/s0'), `stale counter survived:\n${view}`)

    // P1-5: the todo summary flows through the builtin DOCK item (the host
    // renders it directly only WITHOUT an extension host). setTodoSummary
    // mirrors the summary text into the activity snapshot; the builtin
    // dock item renders it.
    app.setTodoSummary([
      { content: 'write tests', status: 'in_progress' },
      { content: 'ship', status: 'pending' },
    ])
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('2 active · write tests'), `todo summary dock item missing (P1-5):\n${view}`)
    // Clearing the list hides the dock item.
    app.setTodoSummary([])
    await settle()
    await vt.waitForRender()
    assert.ok(!vt.getViewport().join('\n').includes('write tests'), `cleared todo dock item survived (P1-5)`)

    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('builtin todo dock summary returns after a >5-item full cycle', async () => {
  const ctx = new Context()
  let fixture: LiveBuiltinApp | undefined
  try {
    fixture = await attachBuiltinApp(ctx)
    const todos = Array.from({ length: 8 }, (_, index) => ({
      content: `todo item ${index + 1}`,
      status: 'pending' as const,
    }))
    fixture.app.setTodoSummary(todos)
    fixture.app.setFullscreen(true)
    await settleRender(fixture.app, fixture.vt)

    let view = fixture.vt.getViewport().join('\n')
    assert.ok(view.includes('☑'), `builtin summary must render while the panel is closed:\n${view}`)
    assert.ok(fixture.host.state().activity.todoSummary !== '', 'closed panel must publish a non-empty todo summary')

    // The summary row opens compact; reset the gesture window before each
    // deliberate follow-up click so the test does not wait on a timer.
    await clickTodoSummary(fixture)
    assert.equal(fixture.app.isTodoPanelVisible(), true, 'summary click opens the panel')
    assert.equal(fixture.app.isTodoPanelExpanded(), false, 'summary click opens the compact panel')
    assert.equal(fixture.host.state().activity.todoSummary, '', 'open panel must clear the extension summary projection')
    view = fixture.vt.getViewport().join('\n')
    assert.ok(!view.includes('☑'), `builtin dock summary must hide while the panel is open:\n${view}`)
    assert.ok(view.includes('todo item 1'), `compact builtin panel missing:\n${view}`)
    assert.ok(!view.includes('todo item 8'), `compact builtin panel must hide the eighth row:\n${view}`)

    resetTodoClickGesture(fixture)
    await clickTodoRow(fixture, 'todo item 1')
    assert.equal(fixture.app.isTodoPanelExpanded(), true, 'panel click expands the full list')
    view = fixture.vt.getViewport().join('\n')
    assert.ok(view.includes('todo item 8'), `full builtin panel missing the last row:\n${view}`)

    resetTodoClickGesture(fixture)
    await clickTodoRow(fixture, 'todo item 8')
    view = fixture.vt.getViewport().join('\n')
    assert.equal(fixture.app.isTodoPanelVisible(), false, 'full panel click closes the panel')
    assert.equal(fixture.app.isTodoPanelExpanded(), false, 'closing resets expansion')
    assertBuiltinTodoSummary(fixture, '8 active · todo item 1', 'full cycle')
    assert.ok(!view.includes('todo item 8'), `closed panel must hide the full-list row:\n${view}`)
    assert.ok(fixture.host.state().activity.todoSummary !== '', 'closing must republish the todo summary projection')
  } finally {
    await disposeBuiltinFixture(fixture, ctx)
  }
})

test('builtin todo dock summary survives two >5-item full cycles', async () => {
  const ctx = new Context()
  let fixture: LiveBuiltinApp | undefined
  try {
    fixture = await attachBuiltinApp(ctx)
    fixture.app.setTodoSummary(Array.from({ length: 8 }, (_, index) => ({
      content: `cycle todo ${index + 1}`,
      status: 'pending' as const,
    })))
    fixture.app.setFullscreen(true)
    await settleRender(fixture.app, fixture.vt)

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      resetTodoClickGesture(fixture)
      await clickTodoSummary(fixture)
      assert.ok(fixture.app.isTodoPanelVisible(), `cycle ${cycle}: summary click must open the panel`)
      assert.ok(!fixture.app.isTodoPanelExpanded(), `cycle ${cycle}: first state must be compact`)

      resetTodoClickGesture(fixture)
      await clickTodoRow(fixture, 'cycle todo 1')
      assert.ok(fixture.app.isTodoPanelExpanded(), `cycle ${cycle}: panel click must expand the full list`)

      resetTodoClickGesture(fixture)
      await clickTodoRow(fixture, 'cycle todo 8')
      assert.equal(fixture.app.isTodoPanelVisible(), false, `cycle ${cycle}: full panel must close`)
      assert.equal(fixture.app.isTodoPanelExpanded(), false, `cycle ${cycle}: close must clear expansion`)
      assertBuiltinTodoSummary(fixture, '8 active · cycle todo 1', `cycle ${cycle}`)
      assert.ok(fixture.host.state().activity.todoSummary !== '', `cycle ${cycle}: closed panel must publish the summary`)
    }
  } finally {
    await disposeBuiltinFixture(fixture, ctx)
  }
})

test('builtin todo dock summary survives two <=5-item list cycles', async () => {
  const ctx = new Context()
  let fixture: LiveBuiltinApp | undefined
  try {
    fixture = await attachBuiltinApp(ctx)
    fixture.app.setTodoSummary(Array.from({ length: 3 }, (_, index) => ({
      content: `small todo ${index + 1}`,
      status: index === 0 ? ('in_progress' as const) : ('pending' as const),
    })))
    fixture.app.setFullscreen(true)
    await settleRender(fixture.app, fixture.vt)

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      resetTodoClickGesture(fixture)
      await clickTodoSummary(fixture)
      assert.ok(fixture.app.isTodoPanelVisible(), `cycle ${cycle}: summary click must open the list`)
      assert.ok(!fixture.app.isTodoPanelExpanded(), `cycle ${cycle}: small list must not expand`)

      resetTodoClickGesture(fixture)
      await clickTodoRow(fixture, 'small todo 1')
      assert.equal(fixture.app.isTodoPanelVisible(), false, `cycle ${cycle}: list click must close the panel`)
      assert.equal(fixture.app.isTodoPanelExpanded(), false, `cycle ${cycle}: close must clear expansion`)
      assertBuiltinTodoSummary(fixture, '3 active · small todo 1', `cycle ${cycle}`)
      assert.ok(fixture.host.state().activity.todoSummary !== '', `cycle ${cycle}: closed panel must publish the summary`)
    }
  } finally {
    await disposeBuiltinFixture(fixture, ctx)
  }
})

test('Ctrl+T restores the builtin todo dock summary after closing the panel', async () => {
  const ctx = new Context()
  let fixture: LiveBuiltinApp | undefined
  try {
    fixture = await attachBuiltinApp(ctx)
    fixture.app.setTodoSummary([
      { content: 'keyboard todo 1', status: 'in_progress' },
      { content: 'keyboard todo 2', status: 'pending' },
      { content: 'keyboard todo 3', status: 'pending' },
    ])
    fixture.app.setFullscreen(true)
    await settleRender(fixture.app, fixture.vt)

    fixture.vt.sendInput('\x14')
    await settleRender(fixture.app, fixture.vt)
    assert.equal(fixture.app.isTodoPanelVisible(), true, 'Ctrl+T opens the panel')
    assert.equal(fixture.app.isTodoPanelExpanded(), false, 'Ctrl+T opens the compact/list state')
    assert.equal(fixture.host.state().activity.todoSummary, '', 'Ctrl+T open must clear the extension summary projection')
    const openView = fixture.vt.getViewport().join('\n')
    assert.ok(!openView.includes('☑'), `Ctrl+T open must hide the builtin dock summary:\n${openView}`)

    fixture.vt.sendInput('\x14')
    await settleRender(fixture.app, fixture.vt)
    assert.equal(fixture.app.isTodoPanelVisible(), false, 'Ctrl+T closes the panel')
    assert.equal(fixture.app.isTodoPanelExpanded(), false, 'Ctrl+T close must clear expansion')
    assertBuiltinTodoSummary(fixture, '3 active · keyboard todo 1', 'Ctrl+T close')
    assert.ok(fixture.host.state().activity.todoSummary !== '', 'Ctrl+T close must publish the summary projection')
  } finally {
    await disposeBuiltinFixture(fixture, ctx)
  }
})

test('builtins unload with their owner fiber (HMR parity)', async () => {
  const ctx = new Context()
  try {
    const { builtinsFiber } = await mountTree(ctx)
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): { snapshot(slot: string): { records: Array<{ id: string }> } }
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
    }
    // Attach a state bridge so the builtin's subscribeState calls go live;
    // their disposers must be fiber-bound (F1 — no listener leak on
    // unload). ONE builtin state subscription remains since M1 (the
    // todo-summary dock item; the turns-steps segment is host-native now).
    let subscribed = 0
    const fakeBridge = { subscribe: () => { subscribed += 1; return () => { subscribed -= 1 } } }
    service.attachSurface(fakeBridge as never, new Set(), 'fake-surface')
    assert.equal(subscribed, 1, 'the todo-summary state listener must be live after attach')
    // Unload the builtins fiber: its registrations AND its state
    // subscription must disappear.
    await (builtinsFiber as { dispose(): Promise<void> }).dispose()
    await settle()
    const badgeIds = service._ledger().snapshot('chrome.header.badge').records.map(record => record.id)
    assert.ok(!badgeIds.includes('builtin-version'), `version badge survived builtins unload: ${badgeIds.join(', ')}`)
    assert.equal(subscribed, 0, `the state listener leaked after builtins unload (F1): ${subscribed}`)
    assert.equal(
      (service as unknown as { _listenerUnsubscribersSize(): number })._listenerUnsubscribersSize(),
      0,
      'the listenerUnsubscribers map must be empty after owner unload (round-2 finding 1)',
    )
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('P0-1: a plugin following the README example registers BEFORE any surface exists (advertised capabilities)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide('tuiStartup', {})
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber

    // A THIRD-PARTY-shaped plugin exactly like the README example: it
    // feature-detects the slot capability and registers. It runs BEFORE
    // any surface is attached — the service is provided, the runner has
    // not created the TUI yet. The advertised capabilities (P0-1) make the
    // feature-detect succeed in this window.
    let registered = false
    const pluginFiber = ctx.plugin((c) => {
      const service = c.get('piTuiExtensions') as PiTuiExtensionService
      if (!service.api().capabilities.has('slot.chrome.header.badge')) return
      service.register<HeaderBadge>('chrome.header.badge', { id: 'pre-surface' }, { text: 'pre-surface' })
      registered = true
    })
    await pluginFiber

    // The plugin must have registered even though no surface exists yet.
    assert.equal(registered, true, 'the plugin must feature-detect the slot capability BEFORE any surface (P0-1)')

    // Attach a surface afterwards: the contribution renders.
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
    }
    const vt = new VirtualTerminal(80, 24)
    const host = new SurfaceHost(service._ledger(), () => app.requestRender())
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    startedApps.add(app)
    await vt.waitForRender()
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: host.surfaceId, generation: 1, width: 80, height: 24, fullscreen: false,
      focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    app.refreshChrome()
    await settle()
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('pre-surface'), `pre-surface registration must render after attach (P0-1):\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the version badge shows the dsh version first, then the tui- bundle version', async (t) => {
  const life = testLifecycle(t)
  // Point the launcher at a fabricated @deepseek-ai/dsh package so the
  // shared dshVersion() resolves: bin → ../../package.json named dsh.
  const root = life.tempDir('dsh-version-badge-')
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'bin'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.1' }))
  const bin = join(dshDir, 'bin', 'dsh')
  writeFileSync(bin, '')
  const previousArgv = process.argv[1]
  process.argv[1] = bin
  try {
    const ctx = new Context()
    try {
      await mountTree(ctx)
      const service = ctx.get('piTuiExtensions') as {
        _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
      }
      const host = new SurfaceHost(service._ledger(), () => app.requestRender())
      const vt = new VirtualTerminal(90, 24)
      const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
      app.start()
      startedApps.add(app)
      life.defer(() => app.stop())
      await vt.waitForRender()
      host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
        surfaceId: host.surfaceId, generation: 1, width: 90, height: 24, fullscreen: false,
        focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
      })
      app.refreshChrome()
      await settle()
      await vt.waitForRender()
      const view = vt.getViewport().join('\n')
      assert.ok(
        /\[dsh-0\.1\.2-alpha\.1 · tui-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\]/.test(view),
        `dsh-first badge missing:\n${view}`,
      )
    } finally {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
      }
    }
  } finally {
    process.argv[1] = previousArgv
  }
})
