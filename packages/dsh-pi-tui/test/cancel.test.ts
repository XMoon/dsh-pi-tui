/**
 * Headless tests for double-Esc cancellation: a fast second Esc fires
 * onCancel, a single Esc does not, and overlays keep their own Esc.
 * @module @xmoon76/dsh-pi-tui/cancel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SettingItem } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp; cancels: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => { cancels += 1 } })
  app.start()
  return { vt, app, get cancels() { return cancels } }
}

test('a single Esc does not cancel', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 0)
})

test('a fast second Esc cancels once', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 1)
  // A third Esc starts a fresh window; a fast fourth fires again.
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 2)
})

test('an overlay keeps Esc for itself', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  const items: SettingItem[] = [{ id: 'a', label: 'alpha', currentValue: '', values: ['✓'] }]
  let closed = false
  surface.app.openSettings(items, () => {}, () => { closed = true })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 0)
  assert.ok(closed, 'overlay cancel callback should have run')
})

test('a slow second Esc does not cancel', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  await new Promise(resolve => setTimeout(resolve, 500))
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 0)
})
