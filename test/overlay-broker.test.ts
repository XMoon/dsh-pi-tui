/**
 * The managed-overlay model (2026-09 revision): stable logical nodes with a
 * single suppressor, explicit visibility intent separate from suppression,
 * per-node focus intent, current logical z-order and physical rebinding across
 * a fullscreen swap. The surface-level lease capability is covered here too.
 * @module @xmoon76/dsh-pi-tui/overlay-broker.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { OverlayBroker } from '../src/overlay-broker.ts'
import type { OverlayHandle } from '@xmoon76/pi-tui'


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

interface FakeHandle extends OverlayHandle {
  label: string
  hiddenLog: string[]
  focusLog: string[]
  isHandFocused(): boolean
}

/** A fake raw overlay handle recording setHidden/hide/focus calls and
 * tracking its own physical focus (so the broker can rebind / restore). */
function fakeHandle(label: string): FakeHandle {
  let hidden = false
  let focused = false
  const handle: FakeHandle = {
    label,
    hiddenLog: [] as string[],
    focusLog: [] as string[],
    isHandFocused: () => focused,
    hide() { handle.hiddenLog.push('hide'); hidden = false; focused = false },
    setHidden(value: boolean) {
      handle.hiddenLog.push(value ? 'hide-temp' : 'show')
      hidden = value
      if (value) focused = false
    },
    isHidden() { return hidden },
    focus() { handle.focusLog.push('focus'); focused = true },
    unfocus() { focused = false },
    isFocused() { return focused },
    getBounds() { return undefined },
  }
  return handle
}

/** Emulate the host's two-phase mount: prepare (snapshot), fork mount+focus,
 * commit (bind + stacking). */
function mountOverlay(
  broker: OverlayBroker,
  handle: OverlayHandle,
  options: { nonCapturing?: boolean; remountable?: boolean } = {},
): OverlayHandle {
  const prepared = broker.prepareMount(options)
  if (options.nonCapturing !== true) handle.focus()
  return broker.commitMount(prepared, handle)
}

test('OverlayBroker: a capturing overlay suppresses visible roots and restores them (with focus) on close', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  mountOverlay(broker, a)
  assert.equal(a.isFocused(), true)
  const bHandle = mountOverlay(broker, b)
  assert.equal(a.isHidden(), true, 'a is suppressed beneath b')
  assert.equal(broker.graphState().dependents, 1)
  // Close b: a is restored AND re-focused (it owned the keyboard before).
  broker.close(bHandle)
  assert.equal(a.isHidden(), false, 'a restored after b closes')
  assert.equal(a.isFocused(), true, 'a reclaims the keyboard')
})

test('OverlayBroker: nonCapturing mounts neither suppress siblings nor steal focus', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const hud = fakeHandle('hud')
  mountOverlay(broker, a)
  mountOverlay(broker, hud, { nonCapturing: true })
  assert.equal(a.isHidden(), false, 'a stays visible under a nonCapturing overlay')
  assert.equal(a.isFocused(), true, 'a keeps the keyboard')
  assert.equal(broker.graphState().dependents, 0)
})

test('OverlayBroker: an explicit focus() makes a nonCapturing overlay the keyboard owner', () => {
  const broker = new OverlayBroker()
  const hud = fakeHandle('hud')
  const wrapped = mountOverlay(broker, hud, { nonCapturing: true })
  assert.equal(broker.hasFocusedOverlay(), false, 'a nonCapturing notice does not auto-focus')
  wrapped.focus()
  assert.equal(hud.isFocused(), true)
  assert.equal(broker.hasFocusedOverlay(), true, 'an explicit focus() is a real keyboard owner')
  assert.equal(broker.hasVisibleModalOverlay(), false, 'but it is still not a modal overlay')
})

test('OverlayBroker: Question suspends visible roots and the broker restores them', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  const broker = new OverlayBroker({ question: () => suspension })
  const a = fakeHandle('a')
  mountOverlay(broker, a)
  broker.suspendVisibleRoots(suspension)
  assert.equal(a.isHidden(), true)
  assert.equal(suspension.suspendedOverlays.size, 1)
  broker.resumeSuspendedRoots(suspension)
  assert.equal(a.isHidden(), false)
  assert.equal(a.isFocused(), true, 'the previously focused root reclaims the keyboard')
})

test('OverlayBroker: Save Location suspension is symmetric', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  const broker = new OverlayBroker({ saveLocation: () => suspension })
  const a = fakeHandle('a')
  mountOverlay(broker, a)
  broker.suspendVisibleRoots(suspension)
  assert.equal(a.isHidden(), true)
  broker.resumeSuspendedRoots(suspension)
  assert.equal(a.isHidden(), false)
  assert.equal(a.isFocused(), true)
})

test('OverlayBroker: a new overlay mounted under a modal joins its DIRECT suspension (no topology copy)', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  const broker = new OverlayBroker({ saveLocation: () => suspension })
  const a = fakeHandle('a')
  mountOverlay(broker, a)
  broker.suspendVisibleRoots(suspension)
  const c = fakeHandle('c')
  mountOverlay(broker, c)
  assert.equal(c.isHidden(), true, 'the new overlay is suspended, not shown over the modal')
  assert.equal(suspension.suspendedOverlays.size, 2, 'both roots are DIRECTLY suspended')
  assert.equal(broker.graphState().dependents, 0, 'no child topology is invented for the modal')
})

test('OverlayBroker: a hidden middle close reparents to its graph owner, never flattens into the modal', () => {
  for (const modal of ['question', 'saveLocation'] as const) {
    let suspension: { suspendedOverlays: Set<OverlayHandle> } | undefined
    const broker = new OverlayBroker(
      modal === 'question' ? { question: () => suspension } : { saveLocation: () => suspension },
    )
    const c = fakeHandle('c')
    const a = fakeHandle('a')
    const b = fakeHandle('b')
    const cHandle = mountOverlay(broker, c)
    const aHandle = mountOverlay(broker, a) // A suppresses C
    const bHandle = mountOverlay(broker, b) // B suppresses A
    assert.equal(broker.graphState().dependents, 2)

    suspension = { suspendedOverlays: new Set<OverlayHandle>() }
    broker.suspendVisibleRoots(suspension)
    assert.equal(suspension.suspendedOverlays.size, 1, `${modal}: only the visible front root is suspended`)

    broker.close(aHandle)
    assert.ok(!suspension.suspendedOverlays.has(cHandle), `${modal}: C must not flatten into the modal suspension`)
    assert.equal(broker.graphState().dependents, 1, `${modal}: B now owns C`)
    assert.equal(c.isHidden(), true, `${modal}: C stays hidden under B`)
    broker.assertForest()

    broker.resumeSuspendedRoots(suspension)
    assert.equal(c.isHidden(), true, `${modal}: C stays hidden after the modal settles`)
    // The modal is over: closing B finally reveals C.
    suspension = undefined
    broker.close(bHandle)
    assert.equal(c.isHidden(), false, `${modal}: C is revealed when its graph owner closes`)
  }
})

test('OverlayBroker: an explicit show() detaches a suppressed node (forest invariant)', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  const aHandle = mountOverlay(broker, a)
  mountOverlay(broker, b) // B suppresses A
  assert.equal(broker.graphState().dependents, 1)
  aHandle.setHidden(false) // explicit visibility override
  assert.equal(a.isHidden(), false)
  assert.equal(broker.graphState().dependents, 0, 'A detached from B — no stale parent')
  broker.assertForest()
  // A subsequent close of B must not touch A.
  const bHandle = [...broker.handles()].find(handle => handle !== aHandle)!
  broker.close(bHandle)
  assert.equal(a.isHidden(), false)
})

test('OverlayBroker: an explicit hide() survives its suppressor close (I3)', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  const aHandle = mountOverlay(broker, a)
  const bHandle = mountOverlay(broker, b)
  assert.equal(a.isHidden(), true)
  aHandle.setHidden(true) // the caller explicitly hides A while suppressed
  assert.equal(broker.graphState().dependents, 1, 'explicit hide keeps the suppression edge')
  broker.close(bHandle)
  assert.equal(a.isHidden(), true, 'the explicit hide must NOT be undone by the owner close')
  aHandle.setHidden(false)
  assert.equal(a.isHidden(), false, 'an explicit show reveals it')
})

test('OverlayBroker: a blur() while suppressed is honored when the owner closes (E)', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  const aHandle = mountOverlay(broker, a)
  const bHandle = mountOverlay(broker, b)
  const focusCount = a.focusLog.length
  aHandle.unfocus() // the plugin blurs A while it is hidden
  broker.close(bHandle)
  assert.equal(a.isHidden(), false, 'A is revealed')
  assert.equal(a.focusLog.length, focusCount, 'the blurred intent suppresses the restore focus')
})

test('OverlayBroker: closing a root releases its children with their saved intent (Case C)', () => {
  const broker = new OverlayBroker()
  const c = fakeHandle('c')
  const a = fakeHandle('a')
  const cHandle = mountOverlay(broker, c)
  const aHandle = mountOverlay(broker, a) // A suppresses C
  broker.close(aHandle)
  assert.equal(c.isHidden(), false, 'C becomes a root')
  assert.equal(c.isFocused(), true, 'C reclaims the keyboard (it was focused before A)')
  assert.equal(broker.graphState().handles, 1)
  assert.equal(broker.graphState().dependents, 0)
  assert.ok(cHandle)
})

test('OverlayBroker: hasVisibleModalOverlay tracks policy, hasFocusedOverlay tracks focus', () => {
  const broker = new OverlayBroker()
  const hud = fakeHandle('hud')
  const hudHandle = mountOverlay(broker, hud, { nonCapturing: true })
  assert.equal(broker.hasVisibleModalOverlay(), false, 'a nonCapturing notice is not modal')
  assert.equal(broker.hasFocusedOverlay(), false)
  const a = fakeHandle('a')
  const aHandle = mountOverlay(broker, a)
  assert.equal(broker.hasVisibleModalOverlay(), true)
  assert.equal(broker.hasFocusedOverlay(), true)
  hudHandle.focus()
  assert.equal(broker.hasFocusedOverlay(), true, 'the explicitly focused nonCapturing notice owns the keyboard')
  assert.equal(broker.hasVisibleModalOverlay(), true)
  broker.close(aHandle)
  assert.equal(broker.hasVisibleModalOverlay(), false, 'only the (focused) nonCapturing notice remains')
  assert.equal(broker.hasFocusedOverlay(), true)
})

test('OverlayBroker: close is idempotent and a closed handle is inert', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const aHandle = mountOverlay(broker, a)
  broker.close(aHandle)
  broker.close(aHandle) // no-op
  assert.equal(broker.graphState().handles, 0)
  assert.equal(aHandle.isHidden(), true)
})

test('OverlayBroker: disposeAll physically unmounts every node without restoring', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  mountOverlay(broker, a)
  mountOverlay(broker, b)
  broker.disposeAll()
  assert.deepEqual(a.hiddenLog, ['hide-temp', 'hide'], 'a is suppressed then physically unmounted')
  assert.deepEqual(b.hiddenLog, ['hide'], 'b is physically unmounted')
  assert.equal(broker.graphState().handles, 0)
  broker.disposeAll() // idempotent
  assert.deepEqual(a.hiddenLog, ['hide-temp', 'hide'])
})

test('OverlayBroker: detach + rebind preserves topology, visibility, focus intent and z-order', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  const aHandle = mountOverlay(broker, a, { remountable: true })
  mountOverlay(broker, b, { remountable: true })
  broker.detachPhysical()
  // Re-create the raw projections back → front by the CURRENT logical order.
  const order = broker.remountOrder()
  assert.equal(order.length, 2)
  const nextA = fakeHandle('a2')
  const nextB = fakeHandle('b2')
  broker.rebind(aHandle, nextA)
  broker.rebind(order[1]!, nextB)
  assert.equal(nextA.isHidden(), true, 'A stays suppressed after the rebind')
  assert.equal(nextB.isHidden(), false, 'B stays visible')
  nextB.focus()
  broker.restoreFocusAfterSwap()
  assert.equal(nextB.isFocused(), true, 'the pre-swap keyboard owner is restored')
  broker.close(aHandle)
  assert.equal(broker.graphState().handles, 1)
})

test('OverlayBroker: detachPhysical closes non-remountable nodes', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  mountOverlay(broker, a) // non-remountable
  mountOverlay(broker, b, { remountable: true })
  broker.detachPhysical()
  assert.equal(broker.graphState().handles, 1, 'only the remountable node survives')
  assert.deepEqual(a.hiddenLog, ['hide-temp', 'hide'], 'the non-remountable overlay is closed')
})

// ── Surface-level: the managed overlay lease ───────────────────────────────

test('TuiApp: a plugin overlay lease mounts through the broker and closes idempotently', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // A plugin overlay via the public lease API.
  const lease = app.showExtensionOverlay({
    kind: 'frame',
    child: { kind: 'text', spans: [{ text: 'plugin overlay' }] },
  })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('plugin overlay'), `overlay content missing:\n${view}`)
  // The broker tracks it.
  assert.equal(app.overlayGraphState().handles, 1)
  // hide/show toggles visibility without closing.
  lease.hide()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('plugin overlay'), `hidden overlay still visible:\n${view}`)
  lease.show()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('plugin overlay'), `re-shown overlay missing:\n${view}`)
  // close is idempotent and removes the overlay.
  lease.close()
  lease.close()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('plugin overlay'), `closed overlay still visible:\n${view}`)
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('TuiApp: the surface dispose closes every still-owned plugin overlay lease', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const lease = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'lease overlay' }] })
  await vt.waitForRender()
  app.dispose()
  lease.show()
  lease.hide()
  lease.close() // must not throw
  assert.equal(app.overlayGraphState().handles, 0)
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'dispose must drop every owned lease')
})

test('TuiApp: final dispose stops the output viewer refresh timer even without the closer (X007)', async () => {
  const { mock } = await import('node:test')
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    startedApps.add(app)
    await vt.waitForRender()
    let refreshes = 0
    app.openOutputViewer({
      title: 'job output',
      initial: '',
      refresh: () => { refreshes += 1; return 'tick' },
      intervalMs: 10,
    })
    mock.timers.tick(10)
    assert.ok(refreshes >= 1, 'the viewer must refresh while open')
    app.dispose()
    const afterDispose = refreshes
    mock.timers.tick(1000)
    assert.equal(refreshes, afterDispose, 'the refresh timer must not fire after final dispose')
  } finally {
    mock.timers.reset()
  }
})

test('TuiApp: openOutputViewer after final dispose mints no refresh timer (round-1 P1)', async () => {
  const { mock } = await import('node:test')
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    startedApps.add(app)
    await vt.waitForRender()
    app.dispose()
    let refreshes = 0
    const closer = app.openOutputViewer({
      title: 'job output',
      initial: '',
      refresh: () => { refreshes += 1; return 'tick' },
      intervalMs: 10,
    })
    closer() // must be inert
    mock.timers.tick(1000)
    assert.equal(refreshes, 0, 'a disposed surface must not mint a refresh timer')
  } finally {
    mock.timers.reset()
  }
})

test('TuiApp: final dispose leaves the terminal cursor VISIBLE (every overlay unmount runs before stop)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.openOutputViewer({ title: 'job output', initial: '', refresh: () => 'tick' })
  await vt.waitForRender()
  app.dispose()
  assert.equal(vt.cursorWrites.at(-1), '\x1b[?25h', 'the final cursor sequence must be SHOW')
})

test('TuiApp: a plugin overlay lease survives a fullscreen toggle (round-1 finding 2)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const lease = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'fs overlay' }] })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), 'the overlay renders in regular mode')
  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), `the overlay must survive into fullscreen:\n${view}`)
  lease.hide()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('fs overlay'), 'the lease hide must work in fullscreen')
  lease.show()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), 'the lease show must restore it in fullscreen')
  app.setFullscreen(false)
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), `the overlay must survive back into regular:\n${view}`)
  lease.close()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('fs overlay'), 'close must remove the overlay')
  app.stop()
})

test('TuiApp: a LATE showExtensionOverlay after dispose is inert — no new lease, no revived overlay (P1-09)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.dispose()
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'dispose leaves zero owned leases')
  const late = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'too late' }] })
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'a late overlay must not mint a new lease')
  assert.equal(app.overlayGraphState().handles, 0, 'a late overlay must not revive the broker graph')
  late.show()
  late.hide()
  late.close()
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('too late'), 'a late overlay never renders')
  app.dispose() // idempotent
})

test('TuiApp: an explicitly closed lease is dropped from the owned set (round-1 finding 1)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const lease = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'x' }] })
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 1)
  lease.close()
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'a closed lease must not leak until dispose')
  lease.close() // idempotent
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0)
  app.stop()
})

test('TuiApp: closing a capturing overlay restores the underlying overlay seat AND physical focus (shared close invariant)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = (): string => vt.getViewport().map(strip).join('\n')

  const a = app.openPicker([{ value: 'a', label: 'overlay A' }], () => {}, () => {})
  await vt.waitForRender()
  const b = app.openPicker([{ value: 'b', label: 'overlay B' }], () => {}, () => {})
  await vt.waitForRender()
  assert.ok(view().includes('overlay B'), `B must be visible:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay')

  b.close?.()
  await vt.waitForRender()
  assert.ok(view().includes('overlay A'), `A must be restored:\n${view()}`)
  assert.ok(!view().includes('overlay B'), `B must be gone:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'overlay', 'the restored A owns the derived seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored A holds physical focus, not the editor')
  assert.equal(app.overlayGraphState().handles, 1, 'only A remains tracked')

  a.close?.()
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the editor regains physical focus when the stack empties')
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('TuiApp: a stable capturing overlay hide()/show() moves the keyboard seat', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()

  const lease = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'stable overlay' }] })
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'a capturing lease takes physical focus on mount')

  lease.hide()
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'hiding the lease returns physical focus to the editor')
  assert.equal(app.focusSeatForTest(), 'editor', 'a hidden capturing overlay must not own the seat')

  lease.show()
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component)
  lease.close()
  app.stop()
})

test('OverlayBroker: an explicit focus() on a suppressed nonCapturing node detaches and focuses it (F)', () => {
  const broker = new OverlayBroker()
  const hud = fakeHandle('hud')
  const b = fakeHandle('b')
  const hudHandle = mountOverlay(broker, hud, { nonCapturing: true })
  mountOverlay(broker, b) // B suppresses the HUD (it was a visible root)
  assert.equal(hud.isHidden(), true)
  assert.equal(broker.graphState().dependents, 1)

  hudHandle.focus()
  assert.equal(hud.isHidden(), false, 'the explicit focus reveals it')
  assert.equal(hud.isFocused(), true, 'a nonCapturing node can own the keyboard on request')
  assert.equal(broker.graphState().dependents, 0, 'it detached from B')
  assert.equal(broker.hasFocusedOverlay(), true)
  broker.assertForest()
})

test('OverlayBroker: an explicit show() of a nonCapturing node does not fabricate focus (B)', () => {
  const broker = new OverlayBroker()
  const hud = fakeHandle('hud')
  const b = fakeHandle('b')
  const hudHandle = mountOverlay(broker, hud, { nonCapturing: true })
  mountOverlay(broker, b) // B suppresses the HUD
  assert.equal(hud.isHidden(), true)

  hudHandle.setHidden(false)
  assert.equal(hud.isHidden(), false, 'the explicit show reveals it')
  assert.equal(hud.isFocused(), false, 'a nonCapturing show must not fabricate keyboard focus')
  assert.equal(broker.graphState().dependents, 0, 'it detached from B')
  assert.equal(b.isFocused(), true, 'B keeps the keyboard')
})

test('OverlayBroker: a node mounted under a modal becomes a root when the modal settles (reviewer P1)', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  let modalActive = true
  const broker = new OverlayBroker({ saveLocation: () => modalActive ? suspension : undefined })
  const a = fakeHandle('a')
  mountOverlay(broker, a)
  broker.suspendVisibleRoots(suspension)
  const b = fakeHandle('b')
  mountOverlay(broker, b) // mounted while the modal owns the seat
  assert.equal(b.isHidden(), true)

  broker.resumeSuspendedRoots(suspension)
  assert.equal(a.isHidden(), false)
  assert.equal(b.isHidden(), false, 'the node mounted under the modal is revealed')
  modalActive = false

  const c = fakeHandle('c')
  mountOverlay(broker, c) // a new capturing overlay must suppress BOTH resumed roots
  assert.equal(a.isHidden(), true)
  assert.equal(b.isHidden(), true, 'the resumed node must participate in suppression')
  assert.equal(broker.graphState().dependents, 2)
  broker.assertForest()
})

test('OverlayBroker: children re-homed into a modal suspension still become roots (reviewer P1)', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  let modalActive = true
  const broker = new OverlayBroker({ question: () => modalActive ? suspension : undefined })
  const b = fakeHandle('b')
  const a = fakeHandle('a')
  mountOverlay(broker, b) // root B
  const aHandle = mountOverlay(broker, a) // A suppresses B
  broker.suspendVisibleRoots(suspension) // suspends the visible front root A only
  broker.close(aHandle) // B is re-homed into the modal suspension
  broker.resumeSuspendedRoots(suspension)
  assert.equal(b.isHidden(), false, 'the re-homed child is revealed')
  modalActive = false

  const c = fakeHandle('c')
  mountOverlay(broker, c)
  assert.equal(b.isHidden(), true, 'the re-homed child must participate in suppression')
  assert.equal(broker.graphState().dependents, 1)
  broker.assertForest()
})

test('OverlayBroker: an explicitly focused nonCapturing node keeps focus across an overlay suppression (reviewer P1-2)', () => {
  const broker = new OverlayBroker()
  const hud = fakeHandle('hud')
  const hudHandle = mountOverlay(broker, hud, { nonCapturing: true })
  hudHandle.focus()
  assert.equal(hud.isFocused(), true)

  const b = fakeHandle('b')
  const bHandle = mountOverlay(broker, b) // suppresses the focused HUD
  assert.equal(hud.isHidden(), true)
  broker.close(bHandle)
  assert.equal(hud.isHidden(), false)
  assert.equal(hud.isFocused(), true, 'the explicit focus intent survives the suppression')
  assert.equal(broker.hasFocusedOverlay(), true)
})

test('OverlayBroker: an explicitly focused nonCapturing node keeps focus across a modal suspension (reviewer P1-2)', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  let modalActive = true
  const broker = new OverlayBroker({ saveLocation: () => modalActive ? suspension : undefined })
  const hud = fakeHandle('hud')
  const hudHandle = mountOverlay(broker, hud, { nonCapturing: true })
  hudHandle.focus()
  broker.suspendVisibleRoots(suspension)
  assert.equal(hud.isHidden(), true)
  modalActive = false
  broker.resumeSuspendedRoots(suspension)
  assert.equal(hud.isHidden(), false)
  assert.equal(hud.isFocused(), true, 'the saved focus intent must not be vetoed by the mount policy')
  assert.equal(broker.hasFocusedOverlay(), true)
})

test('OverlayBroker: closing a directly modal-suspended overlay never steals the modal seat (reviewer P1-3)', () => {
  for (const modal of ['question', 'saveLocation'] as const) {
    const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
    let calls = 0
    const broker = new OverlayBroker({
      ...(modal === 'question'
        ? { question: () => suspension }
        : { saveLocation: () => suspension }),
      focusSeatOwner: () => { calls += 1 },
    })
    const a = fakeHandle('a')
    mountOverlay(broker, a)
    broker.suspendVisibleRoots(suspension)
    const b = fakeHandle('b')
    const bHandle = mountOverlay(broker, b) // direct-suspended under the active modal
    calls = 0
    broker.close(bHandle)
    assert.equal(calls, 0, `${modal}: the modal frame keeps physical focus`)
    assert.equal(broker.graphState().dependents, 0)
    assert.equal(a.isHidden(), true, `${modal}: the existing suspension is untouched`)
  }
})
