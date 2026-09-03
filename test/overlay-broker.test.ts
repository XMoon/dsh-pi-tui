/**
 * M8 tests (plan §13): the OverlayBroker extraction is behavior-identical
 * (the existing modal-stacking/suspension suite gates it) and the managed
 * overlay lease capability works end to end.
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

/** A fake overlay handle recording setHidden/hide calls. */
function fakeHandle(label: string): OverlayHandle & { label: string; hiddenLog: string[] } {
  let hidden = false
  const handle = {
    label,
    hiddenLog: [] as string[],
    hide() { handle.hiddenLog.push('hide'); hidden = false },
    setHidden(value: boolean) {
      handle.hiddenLog.push(value ? 'hide-temp' : 'show')
      hidden = value
    },
    isHidden() { return hidden },
    focus() {},
    unfocus() {},
    isFocused() { return false },
  }
  return handle
}

test('OverlayBroker: a capturing overlay hides every other visible overlay and restores them on close (reverse order)', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  broker.track(a)
  broker.track(b)
  assert.equal(a.isHidden(), true, 'a is hidden beneath b')
  // Close b: a is restored.
  broker.closeForHost(b)
  assert.equal(a.isHidden(), false, 'a restored after b closes')
  assert.deepEqual(a.hiddenLog, ['hide-temp', 'show'])
})

test('OverlayBroker: non-capturing overlays never hide others', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  broker.track(a)
  broker.track(b, { nonCapturing: true })
  assert.equal(a.isHidden(), false, 'a stays visible under a non-capturing overlay')
})

test('OverlayBroker: a question suspension absorbs new overlays and restores on settle', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  const broker = new OverlayBroker({ question: () => suspension })
  const a = fakeHandle('a')
  broker.track(a)
  assert.equal(a.isHidden(), true, 'the overlay joins the suspension hidden')
  assert.ok(suspension.suspendedOverlays.has(a), 'the suspension tracks the overlay')
  // Settle the question: the suspended overlay is revealed by the host.
  for (const handle of suspension.suspendedOverlays) handle.setHidden(false)
  suspension.suspendedOverlays.clear()
  assert.equal(a.isHidden(), false)
})

test('OverlayBroker: close is question-aware — dependents re-join the suspension, never flash back', () => {
  const suspension = { suspendedOverlays: new Set<OverlayHandle>() }
  const broker = new OverlayBroker({ question: () => suspension })
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  broker.track(a)
  // The question absorbs a; a new capturing overlay b takes the front.
  broker.track(b)
  assert.ok(suspension.suspendedOverlays.has(b))
  // b closes while the question is up: a must NOT flash back — it re-joins
  // the suspension.
  broker.closeForHost(b)
  assert.equal(a.isHidden(), true, 'a stays hidden while the question is up')
  assert.ok(suspension.suspendedOverlays.has(a), 'a is directly owned by the question again')
})

test('OverlayBroker: close idempotent + stale handles are inert', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  broker.track(a)
  broker.closeForHost(a)
  broker.closeForHost(a) // no-op
  assert.equal(broker.graphState().handles, 0)
})

test('OverlayBroker: hideAll + clear (fullscreen migration / surface teardown)', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  broker.track(a)
  broker.track(b)
  broker.hideAll()
  assert.equal(a.isHidden() && b.isHidden(), true)
  broker.clear()
  assert.equal(broker.graphState().handles, 0)
  assert.equal(broker.isTracked(a), false)
})

test('OverlayBroker: disposeAll physically unmounts every tracked overlay WITHOUT restoring dependents (final teardown)', () => {
  const broker = new OverlayBroker()
  const a = fakeHandle('a')
  const b = fakeHandle('b')
  broker.track(a)
  broker.track(b)
  // b hides a; disposeAll must physically unmount BOTH and never restore
  // a — the whole surface is dying, nothing may flash back (unlike
  // closeForHost, which restores dependents).
  broker.disposeAll()
  assert.deepEqual(a.hiddenLog, ['hide-temp', 'hide'], 'a is hidden by b, then physically unmounted')
  assert.deepEqual(b.hiddenLog, ['hide'], 'b is physically unmounted')
  assert.equal(broker.graphState().handles, 0)
  assert.equal(broker.isTracked(a), false)
  assert.equal(broker.isTracked(b), false)
  // Idempotent: a second disposeAll must not re-hide anything.
  broker.disposeAll()
  assert.deepEqual(a.hiddenLog, ['hide-temp', 'hide'])
  assert.deepEqual(b.hiddenLog, ['hide'])
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
  const lease = app.showExtensionOverlay({
    kind: 'text',
    spans: [{ text: 'lease overlay' }],
  })
  await vt.waitForRender()
  // After dispose every lease API must be INERT (round-1 finding 4: the
  // lease was closed by the dispose path — hide/show/close cannot touch a
  // dead surface).
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
  // Deterministic timer control: only setInterval is mocked (the app's
  // render scheduling and waitForRender use real setTimeout/nextTick), so
  // a leaked 10ms interval would fire on tick() regardless of load.
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
    // FINAL dispose WITHOUT invoking the closer: the panel-owned interval
    // must be cleared through the disposeOnHide chain (overlay hide →
    // FocusForwardingFrame.dispose → OutputViewerPanel.dispose), so the
    // refresh callback never fires into the disposed surface.
    app.dispose()
    const afterDispose = refreshes
    mock.timers.tick(1000) // a leaked 10ms interval would fire 100 times
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
  // An open overlay whose physical hide() writes hideCursor when the
  // last overlay leaves the stack.
  app.openOutputViewer({ title: 'job output', initial: '', refresh: () => 'tick' })
  await vt.waitForRender()
  app.dispose()
  // Removing the last overlay writes \x1b[?25l; stop() ends with
  // showCursor (\x1b[?25h). If any overlay unmount ran AFTER stop, the
  // final sequence would be the hide — leaving the user's shell cursor
  // hidden after exit.
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
  const lease = app.showExtensionOverlay({
    kind: 'text',
    spans: [{ text: 'fs overlay' }],
  })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), 'the overlay renders in regular mode')
  // Enter fullscreen: the overlay must be re-mounted on the alt screen.
  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), `the overlay must survive into fullscreen:\n${view}`)
  // The lease still works in fullscreen.
  lease.hide()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('fs overlay'), 'the lease hide must work in fullscreen')
  lease.show()
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), 'the lease show must restore it in fullscreen')
  // Back to regular: the overlay re-mounts again.
  app.setFullscreen(false)
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs overlay'), `the overlay must survive back into regular:\n${view}`)
  // Close removes it.
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
  // The review repro: before dispose 0 owned leases; a late plugin call
  // must NOT create a lease or mount on the dead surface.
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'dispose leaves zero owned leases')
  const late = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'too late' }] })
  assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'a late overlay must not mint a new lease')
  assert.equal(app.overlayGraphState().handles, 0, 'a late overlay must not revive the broker graph')
  // Every lease method is inert (no throw, no dead-terminal touch).
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

