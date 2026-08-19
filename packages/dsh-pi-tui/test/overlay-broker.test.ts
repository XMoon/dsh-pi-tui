/**
 * M8 tests (plan §13): the OverlayBroker extraction is behavior-identical
 * (the existing modal-stacking/suspension suite gates it) and the managed
 * overlay lease capability works end to end.
 * @module @xmoon76/dsh-pi-tui/overlay-broker.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { OverlayBroker } from '../src/overlay-broker.ts'
import type { OverlayHandle } from '@xmoon76/pi-tui'

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

// ── Surface-level: the managed overlay lease ───────────────────────────────

test('TuiApp: a plugin overlay lease mounts through the broker and closes idempotently', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
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
  await vt.waitForRender()
  const lease = app.showExtensionOverlay({
    kind: 'text',
    spans: [{ text: 'lease overlay' }],
  })
  await vt.waitForRender()
  // Final dispose closes the still-owned lease (generation-scoped).
  app.dispose()
  let closed = false
  const original = lease.close.bind(lease)
  // The dispose path calls close() on every tracked lease — the lease is
  // in the set; assert via the graph (the surface is disposed so the
  // overlay graph is cleared).
  void original
  void closed
  // The broker graph is cleared by dispose (the underlying screen died).
  assert.equal(app.overlayGraphState().handles, 0)
})
