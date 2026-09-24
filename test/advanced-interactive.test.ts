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
import type { SaveLocationDeps } from '../src/save-location.ts'


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

/** A TuiApp whose empty-editor ↓ affordance is observable (Host shortcut probe). */
async function appWithTasksTrigger() {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  let opened = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onOpenTasks: () => { opened += 1 },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setTasks([{ id: 'job:1', label: 'build', status: 'running' }])
  await vt.waitForRender()
  return { vt, app, opened: () => opened }
}

test('an advanced overlay blur() releases the keyboard seat; focus() reclaims it', async () => {
  const { vt, app, opened } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const component = interactiveComponent({ text: () => 'advanced overlay' })
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()

  assert.equal(lease.focused, true)
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  vt.sendInput('\x1b[B') // ↓ Quick Tasks
  await vt.waitForRender()
  assert.equal(opened(), 0, 'a FOCUSED capturing overlay fences the Host shortcut ladder')

  // blur() releases focus: the overlay stays VISIBLE but the editor owns the
  // keyboard again — the keybinding/input facts must follow, not the mere
  // presence of a visible capturing entry.
  lease.blur()
  await vt.waitForRender()
  assert.ok(view().includes('advanced overlay'), `the blurred overlay must stay visible:\n${view()}`)
  assert.equal(lease.focused, false, 'the lease reports the released focus')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'physical focus returns to the editor')
  assert.equal(app.focusSeatForTest(), 'editor', 'a blurred capturing overlay must not own the seat')

  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, '↓ must work while the capturing overlay is blurred')
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'x', 'typing reaches the editor while the overlay is blurred')

  // focus() reclaims the keyboard.
  lease.focus()
  await vt.waitForRender()
  assert.equal(lease.focused, true)
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'the Host shortcut is fenced again while the overlay holds focus')
  lease.close()
  app.stop()
})

test('an advanced overlay hide()/show() moves the keyboard owner', async () => {
  const { vt, app, opened } = await appWithTasksTrigger()
  const component = interactiveComponent({ text: () => 'advanced overlay' })
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'overlay')

  lease.hide()
  await vt.waitForRender()
  assert.equal(lease.focused, false)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
  assert.equal(app.focusSeatForTest(), 'editor', 'a hidden capturing overlay must not own the seat')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, '↓ must work while the capturing overlay is hidden')

  lease.show()
  await vt.waitForRender()
  assert.equal(lease.focused, true)
  assert.equal(app.focusSeatForTest(), 'overlay', 'showing a capturing overlay reclaims the seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'the Host shortcut is fenced again after show()')
  lease.close()
  app.stop()
})

test('a blurred capturing overlay stays blurred when a child overlay closes', async () => {
  const { vt, app, opened } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  assert.equal(a.focused, true)
  a.blur()
  await vt.waitForRender()
  assert.equal(a.focused, false)
  assert.equal(app.focusSeatForTest(), 'editor')

  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'overlay', 'the picker owns the keyboard while open')
  b.close?.()
  await vt.waitForRender()

  assert.ok(view().includes('advanced A'), `A must be restored visible:\n${view()}`)
  assert.equal(a.focused, false, 'an explicitly blurred overlay must NOT be re-focused by the restore')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'physical focus returns to the editor')
  assert.equal(app.focusSeatForTest(), 'editor', 'a blurred restored overlay must not own the seat')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'Host shortcuts still work after the blurred overlay is restored')
  a.close()
  app.stop()
})

test('a focused capturing overlay regains focus when a child overlay closes', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  assert.equal(a.focused, true)

  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'overlay')
  b.close?.()
  await vt.waitForRender()

  assert.equal(a.focused, true, 'a focused dependent must regain focus on restore')
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  a.close()
  app.stop()
})

test('a blurred capturing overlay stays blurred through an approval round-trip', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  assert.equal(a.focused, false)
  assert.equal(app.focusSeatForTest(), 'editor')

  void app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  assert.ok(view().includes('Approve bash?'), `the approval must be visible:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay')
  vt.sendInput('y') // settle the approval → the blurred A is restored
  await vt.waitForRender()
  assert.equal(a.focused, false, 'the approval settle must not re-focus a blurred overlay')
  assert.equal(app.focusSeatForTest(), 'editor', 'the editor owns the seat again')
  assert.ok(view().includes('advanced A'), `A must be restored visible:\n${view()}`)
  a.close()
  app.stop()
})

test('a blurred dependent restore focuses the CURRENT seat owner after a mid-overlay handoff', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()

  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor')

  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'overlay', 'the picker owns the keyboard')

  // Mid-B editor-seat handoff: E1 → plugin E2. mountSeatChild() must NOT steal
  // focus from the capturing picker.
  let pluginText = ''
  registry.register({
    id: 'plugin-editor',
    priority: 1,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'plugin editor' }] },
      getText: () => pluginText,
      setText: (text: string) => { pluginText = text },
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().id, 'plugin-editor')

  b.close?.()
  await vt.waitForRender()
  assert.equal(a.focused, false, 'the blurred dependent stays blurred')
  assert.equal(app.focusSeatForTest(), 'editor')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'focus must return to the CURRENT seat owner, not the stale pre-mount editor')
  // The advanced editor controls drive the VISIBLE seat: they must reach E2.
  app.advancedEditorControlsForTest().setEditorText('typed into current seat')
  assert.equal(pluginText, 'typed into current seat', 'edits must reach the CURRENT seat editor, not the replaced one')
  a.close()
  app.stop()
})

test('a blurred dependent restore focuses the CURRENT host editor after a plugin unload', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  registry.register({
    id: 'plugin-editor',
    priority: 1,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'plugin editor' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().id, 'plugin-editor')

  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor')

  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  // Mid-B the plugin editor unloads: the seat falls back to the host editor.
  registry.dispose('plugin-editor')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().id, 'host')

  b.close?.()
  await vt.waitForRender()
  assert.equal(a.focused, false)
  assert.equal(app.focusSeatForTest(), 'editor')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'focus must return to the CURRENT host editor')
  vt.sendInput('q')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'q', 'typing must reach the CURRENT host editor')
  a.close()
  app.stop()
})

test('closing a hidden capturing lease does not steal focus from the front overlay', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  assert.equal(a.focused, true)

  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(a.focused, false, 'A is hidden beneath the picker')
  assert.equal(app.overlayGraphState().handles, 2)
  assert.equal(app.focusSeatForTest(), 'overlay')

  // The extension owner unloads the HIDDEN lease while the picker is on top.
  a.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'only the picker remains mounted')
  assert.ok(view().includes('provider option'), `the picker must stay visible:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay', 'the visible picker must keep the keyboard')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'input must not leak past the front overlay to the editor')
  b.close?.()
  app.stop()
})

test('closing a hidden middle overlay reparents its dependents to the front overlay', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const c = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced C' }))
  await vt.waitForRender()
  assert.equal(c.focused, true)
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  assert.equal(a.focused, true)
  assert.equal(c.focused, false, 'C is hidden beneath A')
  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 3)
  assert.equal(app.focusSeatForTest(), 'overlay')

  // A is hidden beneath B and still owns C: closing A must REPARENT C under
  // B (kept hidden) instead of flashing it over the front picker.
  a.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2)
  assert.ok(!view().includes('advanced C'), `C must stay hidden beneath the picker:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay', 'the picker keeps the keyboard')

  // Closing the front overlay restores C with its surviving focus intent.
  b.close?.()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1)
  assert.ok(view().includes('advanced C'), `C must be restored after the front overlay closes:\n${view()}`)
  assert.equal(c.focused, true, 'C regains the keyboard')
  assert.equal(app.focusSeatForTest(), 'overlay')
  c.close()
  app.stop()
})

test('a hidden root lease close still releases its dependents', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const c = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced C' }))
  await vt.waitForRender()
  assert.equal(c.focused, true)
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2)
  assert.equal(app.overlayGraphState().dependents, 1, 'A owns the hidden C')

  a.hide() // temporary hide: A is still the stack root and still owns C
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().dependents, 1, 'temporary hide keeps the dependency graph')

  a.close() // permanent close of the HIDDEN root must still release C
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'only C remains tracked')
  assert.equal(app.overlayGraphState().dependents, 0, 'no orphaned dependency entry')
  assert.ok(view().includes('advanced C'), `C must be revealed:\n${view()}`)
  assert.equal(c.focused, true, 'C regains the keyboard')
  assert.equal(app.focusSeatForTest(), 'overlay')
  c.close()
  app.stop()
})

test('an explicit show() detaches a suppressed overlay from its suppressor', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(a.focused, false, 'A is hidden beneath B')
  assert.equal(app.overlayGraphState().dependents, 1, 'B suppresses A')

  // Explicit VISIBILITY override: A shows (and the fork focuses it) AND is
  // detached from B — a node can never keep a suppressor it overrode (I2).
  a.show()
  await vt.waitForRender()
  assert.equal(a.focused, true)
  assert.equal(app.overlayGraphState().dependents, 0, 'A detached from B — no stale parent')

  a.close()
  await vt.waitForRender()
  assert.ok(view().includes('provider option'), `B must stay visible:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay', 'B owns the keyboard after A closes')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'input must not reach the editor past B')
  b.close?.()
  app.stop()
})

test('a hidden middle overlay reparents to its graph owner across a question round-trip', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const c = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced C' }))
  await vt.waitForRender()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 3)
  assert.equal(app.overlayGraphState().dependents, 2)

  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  assert.ok(view().includes('proceed?'), `the question must be visible:\n${view()}`)
  assert.ok(!view().includes('provider option'), `the question suspends the front picker:\n${view()}`)

  // The hidden middle node A closes while the question is up: C must reparent
  // under B instead of flattening into the question suspension.
  a.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().dependents, 1, 'C is reparented under B')

  vt.sendInput('\x1b') // cancel the question → B restored
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.ok(view().includes('provider option'), `B must be restored after the question:\n${view()}`)
  assert.ok(!view().includes('advanced C'), `C must stay hidden under B:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay')

  b.close?.() // closing B finally reveals C
  await vt.waitForRender()
  assert.ok(view().includes('advanced C'), `C must be revealed when B closes:\n${view()}`)
  c.close()
  app.stop()
})

test('an advanced overlay blur() intent survives a fullscreen swap', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  assert.equal(a.focused, true)
  a.blur()
  await vt.waitForRender()
  assert.equal(a.focused, false, 'blur() releases the keyboard')
  assert.equal(app.focusSeatForTest(), 'editor')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  assert.equal(a.focused, false, 'the blur intent must survive the fullscreen remount')
  assert.equal(app.focusSeatForTest(), 'editor')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'physical focus stays with the editor after the remount')
  a.close()
  app.stop()
})

test('a fullscreen swap preserves a mixed-type stack (advanced below stable)', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'overlay B' }] })
  await vt.waitForRender()
  assert.ok(view().includes('overlay B') && !view().includes('advanced A'), `B must be on top:\n${view()}`)
  assert.equal(app.overlayGraphState().dependents, 1)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  assert.ok(view().includes('overlay B'), `B must remain on top after the swap:\n${view()}`)
  assert.ok(!view().includes('advanced A'), `A must stay hidden beneath B after the swap:\n${view()}`)
  assert.equal(app.overlayGraphState().dependents, 1, 'the stack order must survive the swap')
  assert.equal(a.focused, false)
  assert.equal(app.focusSeatForTest(), 'overlay')
  a.close()
  b.close()
  app.stop()
})

test('a fullscreen swap preserves a mixed-type stack (stable below advanced)', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'overlay A' }] })
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  assert.ok(view().includes('advanced B') && !view().includes('overlay A'), `B must be on top:\n${view()}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  assert.ok(view().includes('advanced B'), `B must remain on top after the swap:\n${view()}`)
  assert.ok(!view().includes('overlay A'), `A must stay hidden beneath B after the swap:\n${view()}`)
  assert.equal(app.overlayGraphState().dependents, 1, 'the stack order must survive the swap')
  assert.equal(b.focused, true)
  b.close()
  a.close()
  app.stop()
})

test('a fullscreen swap keeps a nonCapturing HUD above a capturing overlay', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const hud = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'notice HUD' }] }, { nonCapturing: true })
  await vt.waitForRender()
  // The nonCapturing HUD neither hides nor unfocuses the capturing overlay.
  assert.equal(app.overlayGraphState().handles, 2)
  assert.equal(app.overlayGraphState().dependents, 0, 'a nonCapturing HUD never hides a capturing overlay')
  assert.equal(a.focused, true, 'the capturing overlay owns the keyboard')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  // Re-mounting in global order (A before the HUD) preserves the pair; a
  // type-grouped remount would mount the HUD first and let A hide it.
  assert.equal(app.overlayGraphState().handles, 2, 'both overlays survive the swap')
  assert.equal(app.overlayGraphState().dependents, 0, 'the HUD must NOT be hidden by the remount')
  assert.equal(a.focused, true, 'A keeps the keyboard after the swap')
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 1, 'the HUD lease survives')
  a.close()
  hud.close()
  app.stop()
})

test('a fullscreen swap preserves the CURRENT front order, not the creation order', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  assert.equal(b.focused, true, 'B is the front on creation')
  assert.equal(app.overlayGraphState().dependents, 1, 'B suppresses A')

  // Promote A to the front: the CURRENT logical order is now A above B.
  a.focus()
  await vt.waitForRender()
  assert.equal(a.focused, true)
  assert.equal(b.focused, false)
  assert.equal(app.overlayGraphState().dependents, 0, 'A detached from B when it was focused')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(a.focused, true, 'the CURRENT front (A) survives the swap')
  assert.equal(b.focused, false)
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.equal(app.overlayGraphState().handles, 2)
  a.close()
  b.close()
  app.stop()
})

test('an explicit hide survives a fullscreen swap and the suppressor close', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  assert.equal(a.focused, false, 'A is suppressed by B')
  a.hide()
  await vt.waitForRender()
  assert.ok(!view().includes('advanced A'), `A must be hidden:\n${view()}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.ok(!view().includes('advanced A'), `A must stay hidden across the swap:\n${view()}`)

  b.close()
  await vt.waitForRender()
  assert.ok(!view().includes('advanced A'), `the explicit hide must survive B close:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'editor', 'A must not be revealed/focused')
  a.show()
  await vt.waitForRender()
  assert.ok(view().includes('advanced A'), `an explicit show reveals it:\n${view()}`)
  a.close()
  app.stop()
})

test('a question suspension keeps the overlay stack across a fullscreen swap', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'overlay B' }] })
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().dependents, 1, 'B suppresses A')

  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  assert.ok(view().includes('proceed?'), `the question must be visible:\n${view()}`)
  assert.equal(app.overlayGraphState().suspended, 1, 'the visible front root is suspended')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().suspended, 1, 'the question suspension survives the swap')

  vt.sendInput('\x1b')
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.ok(view().includes('overlay B'), `B must be restored:\n${view()}`)
  assert.ok(!view().includes('advanced A'), `A must stay suppressed under B:\n${view()}`)
  assert.equal(app.overlayGraphState().dependents, 1, 'the B -> A topology survived')
  b.close()
  await vt.waitForRender()
  assert.ok(view().includes('advanced A'), `A is revealed when B closes:\n${view()}`)
  a.close()
  app.stop()
})

test('an explicit focus() of a nonCapturing advanced overlay fences the editor', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced HUD' }),
    { nonCapturing: true },
  )
  await vt.waitForRender()
  assert.equal(a.focused, false, 'a nonCapturing overlay does not auto-focus')
  assert.equal(app.focusSeatForTest(), 'editor')
  vt.sendInput('h')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'h', 'the editor receives input by default')

  a.focus()
  await vt.waitForRender()
  assert.equal(a.focused, true, 'an explicit focus() is honored')
  assert.equal(app.focusSeatForTest(), 'overlay', 'the focused seat follows the physical owner')
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'h', 'input no longer reaches the editor')

  a.blur()
  await vt.waitForRender()
  assert.equal(a.focused, false)
  assert.equal(app.focusSeatForTest(), 'editor')
  a.close()
  app.stop()
})

test('an approval rebuild across a fullscreen swap restores the overlay beneath it', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  assert.ok(view().includes('bash'), `the approval must be visible:\n${view()}`)
  assert.equal(a.focused, false, 'the approval owns the keyboard')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.ok(view().includes('bash'), `the approval must survive the swap:\n${view()}`)

  vt.sendInput('\x1b') // cancel the approval
  await approval.catch(() => {})
  await vt.waitForRender()
  assert.ok(view().includes('advanced A'), `A must be restored:\n${view()}`)
  assert.equal(a.focused, true, 'A reclaims the keyboard')
  a.close()
  app.stop()
})

test('a fullscreen swap keeps a nonCapturing HUD visually above the focused overlay', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'AAAAAAA' }))
  await vt.waitForRender()
  const hud = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'HHHHHHH' }] }, { nonCapturing: true })
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A owns the keyboard')
  assert.ok(view().includes('HHHHHHH'), `the HUD must be the visual front:\n${view()}`)
  assert.ok(!view().includes('AAAAAAA'), `the focused overlay sits behind the HUD:\n${view()}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  assert.equal(a.focused, true, 'A keeps the keyboard')
  assert.ok(view().includes('HHHHHHH'), `the HUD must remain visually on top after the swap:\n${view()}`)
  assert.ok(!view().includes('AAAAAAA'), `A must not jump to the visual front:\n${view()}`)
  assert.equal(app.overlayGraphState().dependents, 0)
  a.close()
  hud.close()
  app.stop()
})

test('a question round-trip keeps a nonCapturing HUD visually above the focused overlay', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'AAAAAAA' }))
  await vt.waitForRender()
  const hud = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'HHHHHHH' }] }, { nonCapturing: true })
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A owns the keyboard')
  assert.ok(view().includes('HHHHHHH') && !view().includes('AAAAAAA'), `HUD must be the front:\n${view()}`)

  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  assert.ok(view().includes('proceed?'), `the question must be visible:\n${view()}`)
  vt.sendInput('\x1b')
  await questions.catch(() => {})
  await vt.waitForRender()

  assert.equal(a.focused, true, 'A keeps the keyboard after the question')
  assert.ok(view().includes('HHHHHHH'), `the HUD must stay visually on top:\n${view()}`)
  assert.ok(!view().includes('AAAAAAA'), `A must not be promoted by the restore:\n${view()}`)
  a.close()
  hud.close()
  app.stop()
})

test('a fullscreen swap restores a retained overlay when the old front owner was not remountable', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  app.openPicker([{ value: 'b', label: 'picker B' }], () => {}, () => {})
  await vt.waitForRender()
  assert.equal(a.focused, false, 'the picker owns the keyboard')
  assert.equal(app.focusSeatForTest(), 'overlay')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  assert.equal(a.focused, true, 'the retained remountable overlay must own the keyboard')
  assert.equal(app.focusSeatForTest(), 'overlay', 'the seat must not fall back to the editor')
  assert.equal(app.overlayGraphState().handles, 1, 'the non-remountable picker is closed by the swap')
  a.close()
  app.stop()
})

test('a fullscreen swap keeps a nonCapturing HUD above an explicitly focused nonCapturing owner', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'AAAAAAA' }),
    { nonCapturing: true },
  )
  await vt.waitForRender()
  a.focus() // explicit focus: A owns the keyboard
  await vt.waitForRender()
  assert.equal(a.focused, true)
  const hud = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'HHHHHHH' }] }, { nonCapturing: true })
  await vt.waitForRender()
  assert.ok(view().includes('HHHHHHH') && !view().includes('AAAAAAA'),
    `the later HUD must be above the focused owner:\n${view()}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()

  assert.equal(a.focused, true, 'the explicitly focused owner keeps the keyboard')
  assert.ok(view().includes('HHHHHHH'), `the HUD must stay above after the swap:\n${view()}`)
  assert.ok(!view().includes('AAAAAAA'), `the owner must not be promoted to the front:\n${view()}`)
  a.close()
  hud.close()
  app.stop()
})

test('closing the focused overlay does not re-activate a blurred sibling', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  a.show() // explicit override: detach from B, visible + focused
  await vt.waitForRender()
  assert.equal(a.focused, true)
  a.blur()
  await vt.waitForRender()
  b.focus()
  await vt.waitForRender()
  assert.equal(b.focused, true, 'B owns the keyboard')
  assert.equal(a.focused, false, 'A is visible but blurred')
  assert.equal(app.overlayGraphState().dependents, 0, 'A detached from B')

  b.close()
  await vt.waitForRender()
  assert.equal(a.focused, false, 'closing B must not re-activate the blurred A')
  assert.equal(app.focusSeatForTest(), 'editor', 'the editor owns the keyboard')
  a.close()
  app.stop()
})

test('an internal restore never fabricates focus transitions (child close)', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  assert.equal(component.focusCount, 1, 'the mount focuses A exactly once')
  a.blur()
  await vt.waitForRender()
  assert.equal(component.blurCount, 1)

  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  b.close()
  await vt.waitForRender()
  assert.equal(component.focusCount, 1, 'a child close must not re-focus the blurred A')
  assert.equal(component.blurCount, 1, 'and must not blur it again')
  a.close()
  app.stop()
})

test('an internal restore never fabricates focus transitions (question / save / fullscreen)', async () => {
  const { vt, app } = await appWithTasksTrigger()

  const questionComponent = interactiveComponent({ text: () => 'question A' })
  const questionOverlay = app.showAdvancedInteractiveOverlay(questionComponent)
  await vt.waitForRender()
  questionOverlay.blur()
  await vt.waitForRender()
  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.deepEqual(
    { focus: questionComponent.focusCount, blur: questionComponent.blurCount },
    { focus: 1, blur: 1 },
    'a question round-trip must not fabricate a focus transition on a blurred overlay',
  )
  questionOverlay.close()

  const saveComponent = interactiveComponent({ text: () => 'save A' })
  const saveOverlay = app.showAdvancedInteractiveOverlay(saveComponent)
  await vt.waitForRender()
  saveOverlay.blur()
  await vt.waitForRender()
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async () => null,
  }
  const prompt = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    deps,
  )
  await vt.waitForRender()
  vt.sendInput('\x1b')
  assert.deepEqual(await prompt, { kind: 'cancelled' })
  await vt.waitForRender()
  assert.deepEqual(
    { focus: saveComponent.focusCount, blur: saveComponent.blurCount },
    { focus: 1, blur: 1 },
    'a Save Location round-trip must not fabricate a focus transition on a blurred overlay',
  )
  saveOverlay.close()

  const fsComponent = interactiveComponent({ text: () => 'fullscreen A' })
  const fsOverlay = app.showAdvancedInteractiveOverlay(fsComponent)
  await vt.waitForRender()
  fsOverlay.blur()
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.deepEqual(
    { focus: fsComponent.focusCount, blur: fsComponent.blurCount },
    { focus: 1, blur: 1 },
    'a fullscreen swap must not fabricate a focus transition on a blurred overlay',
  )
  fsOverlay.close()
  app.stop()
})

test('an approval-preserving fullscreen swap never fabricates focus transitions on the overlay beneath it', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const component = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  assert.equal(component.focusCount, 1, 'the mount focuses A once')

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  assert.equal(component.focusCount, 1, 'the approval must not re-focus A')
  assert.equal(component.blurCount, 1, 'the approval blurs A exactly once')
  assert.equal(app.ownedApprovalFramesForTest(), 1, 'one live approval frame')

  for (let i = 0; i < 2; i += 1) {
    app.setFullscreen(true)
    await vt.waitForRender()
    app.setFullscreen(false)
    await vt.waitForRender()
    assert.deepEqual(
      { focus: component.focusCount, blur: component.blurCount },
      { focus: 1, blur: 1 },
      'an approval-preserving fullscreen swap must not fabricate focus transitions on A',
    )
    assert.equal(app.ownedApprovalFramesForTest(), 1,
      'each swap replaces, never accumulates, the approval frame')
  }

  vt.sendInput('\x1b')
  await approval.catch(() => {})
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0, 'settling the approval disposes its frame')
  assert.equal(a.focused, true, 'A is restored after the approval is cancelled')
  a.close()
  app.stop()
})

test('blurring every visible capturing overlay leaves the editor owning the keyboard', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  a.show() // detach: two independent visible roots, A focused
  await vt.waitForRender()
  assert.equal(a.focused, true)
  a.blur()
  await vt.waitForRender()
  b.focus()
  await vt.waitForRender()
  assert.equal(b.focused, true, 'B took the keyboard after A blurred')

  b.blur() // the fork must NOT hand the keyboard back to the blurred A
  await vt.waitForRender()
  assert.equal(a.focused, false, 'the explicitly blurred A must stay unfocused')
  assert.equal(b.focused, false)
  assert.equal(app.focusSeatForTest(), 'editor', 'the editor owns the keyboard')
  a.close()
  b.close()
  app.stop()
})

test('hiding the focused overlay never re-activates a blurred sibling', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  a.show()
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  b.focus()
  await vt.waitForRender()
  assert.equal(b.focused, true)

  b.hide()
  await vt.waitForRender()
  assert.equal(a.focused, false, 'hiding B must not re-activate the blurred A')
  assert.equal(app.focusSeatForTest(), 'editor')
  a.close()
  b.close()
  app.stop()
})

test('a question suspension never fabricates focus on a blurred sibling', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const aComponent = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  a.show()
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  b.focus()
  await vt.waitForRender()
  assert.equal(b.focused, true)
  assert.equal(a.focused, false)
  const focusCount = aComponent.focusCount
  const blurCount = aComponent.blurCount

  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.deepEqual(
    { focus: aComponent.focusCount, blur: aComponent.blurCount },
    { focus: focusCount, blur: blurCount },
    'the suspension snapshot must not read a sibling it just re-focused',
  )
  assert.equal(b.focused, true, 'the pre-modal owner is restored')
  assert.equal(a.focused, false, 'the blurred sibling stays unfocused')
  a.close()
  b.close()
  app.stop()
})

test('a fullscreen swap never fabricates focus on a blurred sibling root', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const aComponent = interactiveComponent({ text: () => 'advanced A' })
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  a.show()
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  b.focus()
  await vt.waitForRender()
  const focusCount = aComponent.focusCount
  const blurCount = aComponent.blurCount

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.deepEqual(
    { focus: aComponent.focusCount, blur: aComponent.blurCount },
    { focus: focusCount, blur: blurCount },
    'the detach must not transiently focus the blurred sibling',
  )
  assert.equal(b.focused, true, 'the pre-swap owner is restored')
  a.close()
  b.close()
  app.stop()
})

test('mounting a capturing overlay under a question does not take the keyboard first', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()

  const cComponent = interactiveComponent({ text: () => 'advanced C' })
  app.showAdvancedInteractiveOverlay(cComponent)
  await vt.waitForRender()
  assert.deepEqual(
    { focus: cComponent.focusCount, blur: cComponent.blurCount },
    { focus: 0, blur: 0 },
    'a mount under a modal must not focus and immediately unhide',
  )

  vt.sendInput('\x1b')
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.equal(cComponent.focusCount, 1, 'the settled modal hands C the keyboard once')
  assert.equal(cComponent.blurCount, 0)
  a.close()
  app.stop()
})

test('a plugin onFocus that mounts another overlay cannot double-adopt a child', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()

  let c: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced B' }] }),
    handleInput: () => false,
    onFocus: () => {
      if (c === undefined) {
        c = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced C' }))
      }
    },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  await vt.waitForRender()

  assert.equal(app.overlayGraphState().handles, 3, 'A, B and C are all managed')
  assert.equal(app.overlayGraphState().dependents, 2, 'C -> B -> A, a single forest')
  assert.doesNotThrow(() => app.assertOverlayForestForTest(), 'the forest invariant must hold')
  assert.ok(c !== undefined, 'the re-entrant mount succeeded')

  c!.close()
  await vt.waitForRender()
  assert.equal(b.focused, true, 'B is restored and focused')
  assert.ok(!view().includes('advanced A'), `A stays hidden under B:\n${view()}`)
  assert.equal(app.overlayGraphState().dependents, 1, 'only B -> A remains')
  assert.doesNotThrow(() => app.assertOverlayForestForTest())

  b.close()
  await vt.waitForRender()
  assert.ok(view().includes('advanced A'), `A is revealed when B closes:\n${view()}`)
  assert.equal(a.focused, true, 'A reclaims the keyboard')
  a.close()
  app.stop()
})

test('a nested nonCapturing HUD mounted from onFocus keeps the logical front order', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()

  let hud: ReturnType<typeof app.showExtensionOverlay> | undefined
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'BBBBBBB' }] }),
    handleInput: () => false,
    onFocus: () => {
      if (hud === undefined) {
        hud = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'HHHHHHH' }] }, { nonCapturing: true })
      }
    },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  await vt.waitForRender()

  // The nested HUD mounted later: it is the physical front, B keeps the
  // keyboard, and the logical z must agree (no post-callback overtake).
  assert.equal(b.focused, true, 'B keeps the keyboard')
  assert.ok(view().includes('HHHHHHH'), `the nested HUD is the visual front:\n${view()}`)
  assert.ok(!view().includes('BBBBBBB'), `B sits behind the HUD:\n${view()}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(b.focused, true, 'B keeps the keyboard after the swap')
  assert.ok(view().includes('HHHHHHH'), `the HUD stays above after the swap:\n${view()}`)
  assert.ok(!view().includes('BBBBBBB'), `B must not flip to the front:\n${view()}`)
  b.close()
  hud?.close()
  a.close()
  app.stop()
})

test('an explicit show whose onFocus mounts a nested overlay keeps its focus intent', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let c: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onFocus: () => {
      if (arm && c === undefined) {
        c = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced C' }))
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()

  // The explicit show detaches A and focuses it; A's onFocus then mounts a
  // nested capturing C that suppresses both A and B.
  arm = true
  a.show()
  await vt.waitForRender()
  assert.ok(c !== undefined, 'the nested overlay mounted from onFocus')
  assert.equal(c!.focused, true, 'C owns the keyboard')
  assert.equal(app.overlayGraphState().handles, 3)

  c!.close()
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A keeps the focus intent of its explicit show')
  assert.equal(app.focusSeatForTest(), 'overlay')
  b.close()
  a.close()
  app.stop()
})

test('a blur inside the focus callback keeps the overlay released', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let armed = false
  let aRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onFocus: () => { if (armed) aRef?.blur() },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  aRef = a
  await vt.waitForRender()
  a.blur()
  await vt.waitForRender()
  assert.equal(a.focused, false)
  armed = true
  a.focus() // onFocus blurs it again → the released intent must win
  await vt.waitForRender()
  assert.equal(a.focused, false, 'the blur inside onFocus wins')

  // B is nonCapturing, so closing it does not re-derive A's intent from
  // physical focus: a stale logical intent would wrongly resurrect A.
  const b = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced B' }),
    { nonCapturing: true },
  )
  await vt.waitForRender()
  b.focus()
  await vt.waitForRender()
  assert.equal(b.focused, true)
  b.close()
  await vt.waitForRender()
  assert.equal(a.focused, false, 'A must not regain focus from a stale intent')
  assert.equal(app.focusSeatForTest(), 'editor')
  a.close()
  app.stop()
})

test('a hidden capturing focus whose onFocus mounts a nonCapturing HUD keeps the HUD in front', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  let hud: ReturnType<typeof app.showExtensionOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'AAAAAAA' }] }),
    handleInput: () => false,
    onFocus: () => {
      if (arm && hud === undefined) {
        hud = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'HHHHHHH' }] }, { nonCapturing: true })
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  a.hide()
  await vt.waitForRender()
  assert.equal(a.focused, false)

  arm = true
  a.focus() // hidden capturing show → focus → onFocus mounts the HUD
  await vt.waitForRender()
  assert.ok(hud !== undefined, 'the nested HUD mounted')
  assert.equal(a.focused, true, 'A owns the keyboard')
  assert.ok(view().includes('HHHHHHH'), `the HUD is the visual front:\n${view()}`)
  assert.ok(!view().includes('AAAAAAA'), `A sits behind the HUD:\n${view()}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A keeps the keyboard after the swap')
  assert.ok(view().includes('HHHHHHH'), `the HUD stays above after the swap:\n${view()}`)
  assert.ok(!view().includes('AAAAAAA'), `A must not flip to the front:\n${view()}`)
  a.close()
  hud?.close()
  app.stop()
})

test('a newer focus from the release callback survives a stale blur', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  let arm = false
  const aRef = a
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced B' }] }),
    handleInput: () => false,
    onFocus: () => {
      if (arm) {
        arm = false
        aRef.focus()
      }
    },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  await vt.waitForRender()
  a.show() // detach: A/B are independent roots, A focused
  await vt.waitForRender()
  assert.equal(a.focused, true)
  assert.equal(b.focused, false)

  arm = true
  a.blur() // release → focus B → B.onFocus → A.focus()
  await vt.waitForRender()
  assert.equal(a.focused, true, 'the callback focus is newer than the blur')
  assert.equal(b.focused, false)
  assert.equal(app.focusSeatForTest(), 'overlay')
  b.close()
  a.close()
  app.stop()
})

test('a newer focus from the release callback survives a stale hide', async () => {
  const { vt, app } = await appWithTasksTrigger()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')
  const a = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced A' }))
  await vt.waitForRender()
  let arm = false
  const aRef = a
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced B' }] }),
    handleInput: () => false,
    onFocus: () => {
      if (arm) {
        arm = false
        aRef.focus()
      }
    },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  await vt.waitForRender()
  a.show()
  await vt.waitForRender()
  assert.equal(a.focused, true)

  arm = true
  a.hide() // release → focus B → B.onFocus → A.focus()
  await vt.waitForRender()
  assert.equal(a.focused, true, 'the callback focus is newer than the hide')
  assert.ok(view().includes('advanced A'), `A stays visible:\n${view()}`)

  // The newer focus() cleared the hidden intent: a fullscreen rebind must still
  // show A.
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.ok(view().includes('advanced A'), `A stays visible across fullscreen:\n${view()}`)
  assert.equal(a.focused, true)
  b.close()
  a.close()
  app.stop()
})

test('a newer focus from the detach seat release is restored after a fullscreen swap', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let bRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && bRef !== undefined) {
        arm = false
        bRef.focus()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced B' }),
    { nonCapturing: true },
  )
  bRef = b
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A owns the keyboard')
  assert.equal(b.focused, false)

  // The fullscreen seat handoff blurs A; its onBlur issues a NEWER B.focus().
  arm = true
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(b.focused, true, 'the newer focus from the seat release wins')
  assert.equal(a.focused, false, 'the stale pre-swap owner must not be restored')
  assert.equal(app.focusSeatForTest(), 'overlay')
  a.close()
  b.close()
  app.stop()
})

test('a newer focus from the modal suspension release wins on settle', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let bRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && bRef !== undefined) {
        arm = false
        bRef.focus()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced B' }),
    { nonCapturing: true },
  )
  bRef = b
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A owns the keyboard')

  // During the modal suspension release A blurs; its onBlur issues a NEWER
  // B.focus(), which detaches B from the suspension.
  arm = true
  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.equal(b.focused, true, 'the newer focus from the suspension release wins on settle')
  assert.equal(a.focused, false, 'A is not re-focused over the newer owner')
  assert.equal(app.focusSeatForTest(), 'overlay')
  a.close()
  b.close()
  app.stop()
})

test('an onBlur re-focus is not overwritten by a capturing mount', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let arm = false
  let aRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && aRef !== undefined) {
        arm = false
        aRef.focus()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  aRef = a
  await vt.waitForRender()
  assert.equal(a.focused, true)

  arm = true
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  assert.equal(a.focused, true, 'the onBlur re-focus wins over the mount transition')
  assert.equal(b.focused, false)
  assert.equal(app.focusSeatForTest(), 'overlay')

  app.setFullscreen(true)
  await vt.waitForRender()
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(a.focused, true, 'A still owns the keyboard after the swap')
  b.close()
  a.close()
  app.stop()
})

test('an onBlur re-focus is not overwritten by a blur release', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let arm = false
  let aRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && aRef !== undefined) {
        arm = false
        aRef.focus()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  aRef = a
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(interactiveComponent({ text: () => 'advanced B' }))
  await vt.waitForRender()
  a.show() // independent roots, A focused
  await vt.waitForRender()
  assert.equal(a.focused, true)

  arm = true
  a.blur() // release focuses B → A.onBlur → A.focus()
  await vt.waitForRender()
  assert.equal(a.focused, true, 'the onBlur re-focus wins over the release transition')
  assert.equal(b.focused, false)
  assert.equal(app.focusSeatForTest(), 'overlay')
  b.close()
  a.close()
  app.stop()
})

test('a pending focus target blurred from the previous onBlur is not installed', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let bRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && bRef !== undefined) {
        arm = false
        bRef.blur()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced B' }),
    { nonCapturing: true },
  )
  bRef = b
  await vt.waitForRender()
  assert.equal(a.focused, true)

  arm = true
  b.focus() // A.onBlur blurs the pending target
  await vt.waitForRender()
  assert.equal(b.focused, false, 'a released pending target must not be installed')
  assert.equal(a.focused, true, 'the previous owner keeps the keyboard')
  assert.equal(app.focusSeatForTest(), 'overlay')
  b.close()
  a.close()
  app.stop()
})

test('a pending focus target hidden from the previous onBlur is not installed', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let bRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && bRef !== undefined) {
        arm = false
        bRef.hide()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced B' }),
    { nonCapturing: true },
  )
  bRef = b
  await vt.waitForRender()

  arm = true
  b.focus() // A.onBlur hides the pending target
  await vt.waitForRender()
  assert.equal(b.focused, false, 'a hidden pending target must not be focused')
  assert.equal(a.focused, true)
  assert.equal(app.focusSeatForTest(), 'overlay')
  b.close()
  a.close()
  app.stop()
})

test('a pending focus target closed from the previous onBlur is not installed', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let bRef: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const aComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced A' }] }),
    handleInput: () => false,
    onBlur: () => {
      if (arm && bRef !== undefined) {
        arm = false
        bRef.close()
      }
    },
    dispose: () => {},
  }
  const a = app.showAdvancedInteractiveOverlay(aComponent)
  await vt.waitForRender()
  const b = app.showAdvancedInteractiveOverlay(
    interactiveComponent({ text: () => 'advanced B' }),
    { nonCapturing: true },
  )
  bRef = b
  await vt.waitForRender()

  arm = true
  b.focus() // A.onBlur closes the pending target
  await vt.waitForRender()
  assert.equal(b.active, false, 'the pending target was closed')
  assert.equal(b.focused, false, 'a closed target is never focused')
  assert.equal(a.focused, true)
  assert.equal(app.focusSeatForTest(), 'overlay')
  a.close()
  app.stop()
})

test('a pending focus target blurred from its own onFocus is not installed', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let target: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced B' }] }),
    handleInput: () => false,
    onFocus: () => { if (arm) { arm = false; target?.blur() } },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  target = b
  await vt.waitForRender()
  b.blur()
  await vt.waitForRender()
  arm = true
  b.focus() // B.onFocus blurs itself
  await vt.waitForRender()
  assert.equal(b.focused, false, 'the self-blur wins')
  assert.equal(app.focusSeatForTest(), 'editor', 'the editor fallback owns the keyboard')
  b.close()
  app.stop()
})

test('a pending focus target hidden from its own onFocus is not installed', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let target: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced B' }] }),
    handleInput: () => false,
    onFocus: () => { if (arm) { arm = false; target?.hide() } },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  target = b
  await vt.waitForRender()
  b.blur()
  await vt.waitForRender()
  arm = true
  b.focus() // B.onFocus hides itself
  await vt.waitForRender()
  assert.equal(b.focused, false, 'a self-hidden target is not focused')
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(!vt.getViewport().map(strip).join('\n').includes('advanced B'), 'the target is hidden')
  b.close()
  app.stop()
})

test('a pending focus target closed from its own onFocus is not installed', async () => {
  const { vt, app } = await appWithTasksTrigger()
  let target: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  let arm = false
  const bComponent: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced B' }] }),
    handleInput: () => false,
    onFocus: () => { if (arm) { arm = false; target?.close() } },
    dispose: () => {},
  }
  const b = app.showAdvancedInteractiveOverlay(bComponent)
  target = b
  await vt.waitForRender()
  b.blur()
  await vt.waitForRender()
  arm = true
  b.focus() // B.onFocus closes itself
  await vt.waitForRender()
  assert.equal(b.active, false, 'the target closed itself')
  assert.equal(b.focused, false, 'a closed target is never focused')
  app.stop()
})
