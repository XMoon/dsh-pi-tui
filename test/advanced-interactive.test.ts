/**
 * Phase 2 tests (plan §14): the ADVANCED interactive overlay (focused
 * interactive surface) and the ADVANCED normalized input route inside the
 * host's input path — render/input/focus/blur/invalidate, hide/show,
 * fullscreen migration, surface dispose, and the capture ladder position
 * (after host capturing flows + reserved keys, before the editor).
 * @module @xmoon76/dsh-pi-tui/advanced-interactive.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { AdvancedInputRegistry } from '../src/extension/internal/advanced-input.ts'
import { normalizeInputEvent } from '../src/extension/internal/input-events.ts'
import type { AdvancedInputEvent, AdvancedInteractiveComponent } from '../src/extension/advanced-types.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const startedApps = new Set<DisposableApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A recording interactive component. */
function interactiveComponent(options: {
  text?: () => string
  consume?: boolean
  throwOnRender?: boolean
  throwOnInput?: boolean
} = {}): AdvancedInteractiveComponent & {
  events: AdvancedInputEvent[]
  focusCount: number
  blurCount: number
  disposed: boolean
  renderCount: number
} {
  const state = {
    events: [] as AdvancedInputEvent[],
    focusCount: 0,
    blurCount: 0,
    disposed: false,
    renderCount: 0,
  }
  // NOTE: expose the counters through GETTERS — a copied number field
  // would shadow the closure (the AGENTS.md mutable-counter trap: the
  // closures update `state`, assertions would read the stale copy).
  const component: AdvancedInteractiveComponent = {
    render: () => {
      state.renderCount += 1
      if (options.throwOnRender === true) throw new Error('render boom')
      return { kind: 'text', spans: [{ text: options.text?.() ?? 'interactive' }] }
    },
    handleInput: (event) => {
      state.events.push(event)
      if (options.throwOnInput === true) throw new Error('input boom')
      return options.consume === true
    },
    onFocus: () => { state.focusCount += 1 },
    onBlur: () => { state.blurCount += 1 },
    dispose: () => { state.disposed = true },
  }
  return {
    ...component,
    get events() { return state.events },
    get focusCount() { return state.focusCount },
    get blurCount() { return state.blurCount },
    get disposed() { return state.disposed },
    get renderCount() { return state.renderCount },
  }
}

/** A TuiApp with the advanced input route wired to a fresh registry. */
async function appWithAdvancedRoute() {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new AdvancedInputRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    advancedInputRoute: (data) => registry.route(data, normalizeInputEvent),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  return { vt, app, registry }
}

test('interactive overlay: renders, forwards normalized input, fires focus/blur, invalidates', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const component = interactiveComponent({ text: () => 'hello interactive' })
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('hello interactive'), `overlay content missing:\n${view}`)
  // A capturing overlay owns focus: the wrapper's Focusable setter fired.
  assert.equal(component.focusCount, 1, 'onFocus fired on mount')
  // Input routed to the focused overlay component arrives NORMALIZED.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(component.events.length, 1)
  assert.equal(component.events[0]?.kind, 'key')
  // A paste arrives as a paste event.
  vt.sendInput('\x1b[200~pasted\x1b[201~')
  await vt.waitForRender()
  assert.deepEqual(component.events[1], { kind: 'paste', text: 'pasted' })
  // invalidate() recompiles the plugin's render() output.
  const rendersBefore = component.renderCount
  lease.invalidate()
  await vt.waitForRender()
  assert.ok(component.renderCount > rendersBefore, 'invalidate recompiles the render output')
  // hide/show toggles visibility without closing.
  lease.hide()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('hello interactive'), `hidden overlay still visible:\n${view}`)
  lease.show()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('hello interactive'), `re-shown overlay missing:\n${view}`)
  // close is idempotent and disposes the plugin component.
  lease.close()
  lease.close()
  await vt.waitForRender()
  assert.equal(component.disposed, true, 'close disposes the plugin component')
  assert.equal(app.ownedAdvancedOverlayLeasesForTest(), 0)
  app.stop()
})

test('interactive overlay: a throwing render/input callback is isolated (the host keeps working)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const throwing = interactiveComponent({ throwOnRender: true, throwOnInput: true })
  const lease = app.showAdvancedInteractiveOverlay(throwing)
  await vt.waitForRender()
  // The throwing render produced nothing, but the host did not crash.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(throwing.events.length, 1, 'the input handler still received the event')
  // The lease still works (invalidate recompiles the throwing render
  // without escaping).
  lease.invalidate()
  await vt.waitForRender()
  lease.close()
  app.stop()
})

test('interactive overlay: the surface dispose closes every still-owned lease (inert after)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const component = interactiveComponent()
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  app.dispose()
  // Every lease API must be INERT after the final dispose.
  lease.show()
  lease.hide()
  lease.focus()
  lease.blur()
  lease.invalidate()
  lease.close() // must not throw
  assert.equal(component.disposed, true, 'dispose disposes the plugin component')
  assert.equal(app.ownedAdvancedOverlayLeasesForTest(), 0)
})

test('interactive overlay: a lease survives a fullscreen toggle (screen migration)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const component = interactiveComponent({ text: () => 'fs interactive' })
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs interactive'), `overlay content missing:\n${view}`)
  // Fullscreen toggle: the old screen's raw handles die; the lease must
  // re-mount on the new active screen. REPEATED toggles must not grow the
  // wrapper set (round-1 finding 2: every remount used to leave a stale
  // wrapper behind, so resize recompiled every historical wrapper).
  for (let toggle = 0; toggle < 3; toggle += 1) {
    app.setFullscreen(true)
    await vt.waitForRender()
    view = vt.getViewport().map(strip).join('\n')
    assert.ok(view.includes('fs interactive'), `overlay missing after fullscreen #${toggle}:\n${view}`)
    assert.equal(app.advancedOverlayWrappersForTest(), 1, `remount #${toggle} drops the old wrapper (no set growth)`)
    app.setFullscreen(false)
    await vt.waitForRender()
    view = vt.getViewport().map(strip).join('\n')
    assert.ok(view.includes('fs interactive'), `overlay missing after fullscreen exit #${toggle}:\n${view}`)
    assert.equal(app.advancedOverlayWrappersForTest(), 1, `exit #${toggle} also keeps exactly one wrapper`)
  }
  // A terminal resize recompiles the ONE live wrapper exactly once (the
  // stale-wrapper leak would recompile every historical wrapper).
  const rendersBefore = component.renderCount
  vt.resize(100, 30)
  await vt.waitForRender()
  assert.equal(component.renderCount, rendersBefore + 1, 'a resize recompiles the live overlay exactly once')
  lease.close()
  assert.equal(app.advancedOverlayWrappersForTest(), 0, 'close drops the wrapper')
  app.stop()
})

test('advanced input route: a consuming capture preempts the editor; a passing one does not', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const registry = new AdvancedInputRegistry()
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} }, {
    advancedInputRoute: (data) => registry.route(data, normalizeInputEvent),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // A capture that consumes 'x' — the editor must never see it.
  registry.register({
    id: 'consume-x',
    handle: (event) => event.kind === 'key' && event.key.key === 'x',
  }, 'owner')
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'the consumed key never reached the editor')
  // A passing capture lets the editor see the key.
  registry.register({
    id: 'observe-all',
    mode: 'observe',
    handle: () => {},
  }, 'owner')
  vt.sendInput('y')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'y', 'a passing capture lets the editor receive the key')
  app.stop()
})

test('advanced input route: reserved host lifecycle keys never reach a capture', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  let exited = 0
  const registry = new AdvancedInputRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => { exited += 1 } }, {
    advancedInputRoute: (data) => registry.route(data, normalizeInputEvent),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const seen: string[] = []
  registry.register({
    id: 'spy',
    mode: 'observe',
    handle: (event) => { seen.push(event.kind === 'key' ? event.key.key : event.kind) },
  }, 'owner')
  // Ctrl+C is the host exit shortcut (the first press arms the same-key
  // confirmation, the second within the configured window exits) — the
  // capture must never see it.
  vt.sendInput('\x03')
  await vt.waitForRender()
  assert.equal(exited, 0, 'a single Ctrl+C only arms exit confirmation')
  vt.sendInput('\x03')
  await vt.waitForRender()
  assert.equal(exited, 1, 'the second Ctrl+C exits')
  assert.ok(!seen.includes('c'), 'the capture never saw Ctrl+C')
  // Esc (the host's double-Esc cancel) is host-owned too.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!seen.includes('escape'), 'the capture never saw Esc')
  app.stop()
})

test('advanced input route: captures do not run while a host overlay owns the seat', async () => {
  const { vt, app, registry } = await appWithAdvancedRoute()
  const seen: string[] = []
  registry.register({
    id: 'spy',
    mode: 'observe',
    handle: (event) => { seen.push(event.kind === 'key' ? event.key.key : event.kind) },
  }, 'owner')
  // A host overlay (the stable managed overlay) owns the seat.
  const lease = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'host overlay' }] })
  await vt.waitForRender()
  vt.sendInput('z')
  await vt.waitForRender()
  assert.equal(seen.length, 0, 'captures are not consulted while an overlay owns the seat')
  lease.close()
  await vt.waitForRender()
  vt.sendInput('z')
  await vt.waitForRender()
  assert.equal(seen.length, 1, 'captures resume after the overlay closes')
  app.stop()
})

test('advanced input route: a throwing capture fails open (the editor still receives the key)', async () => {
  const { vt, app, registry } = await appWithAdvancedRoute()
  registry.register({
    id: 'thrower',
    handle: () => { throw new Error('capture boom') },
  }, 'owner')
  vt.sendInput('q')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'q', 'a throwing capture never stalls the editor')
  app.stop()
})
