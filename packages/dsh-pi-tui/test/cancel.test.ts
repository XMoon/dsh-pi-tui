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

// ── requirement 7: Ctrl+C pi parity + busy single-Esc ─────────────────────

function startAppWithExits(): { vt: VirtualTerminal; app: TuiApp; cancels: number; exits: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => { exits += 1 },
    onCancel: () => { cancels += 1 },
  })
  app.start()
  return { vt, app, get cancels() { return cancels }, get exits() { return exits } }
}

test('Ctrl+C with text clears the editor and does NOT exit', async () => {
  const surface = startAppWithExits()
  await surface.vt.waitForRender()
  surface.vt.sendInput('hello world')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // ctrl+c
  await surface.vt.waitForRender()
  assert.equal(surface.app.seatTextForTest(), '', 'the editor must be cleared')
  assert.equal(surface.exits, 0, 'a first Ctrl+C on text must not exit')
  assert.equal(surface.cancels, 0)
})

test('a second Ctrl+C within the window on the EMPTY editor exits', async () => {
  const surface = startAppWithExits()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // empty editor: record the time
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'the first empty-editor Ctrl+C only arms the chord')
  surface.vt.sendInput('\x03') // within 500ms: exit
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
  // A third press starts a fresh window: no immediate exit.
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'after exiting the window resets')
})

test('Ctrl+C presses spaced beyond the window do not exit', async () => {
  const surface = startAppWithExits()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await new Promise(resolve => setTimeout(resolve, 600))
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'a slow second Ctrl+C must not exit')
})

test('Ctrl+C clears text first, THEN a fast second press exits', async () => {
  const surface = startAppWithExits()
  await surface.vt.waitForRender()
  surface.vt.sendInput('abc')
  surface.vt.sendInput('\x03') // clears the editor (records the time)
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // empty + within the window: exit
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'clear-then-exit is the pi chord')
})

test('a SINGLE Esc while busy cancels immediately (pi parity)', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.app.setBusy(true)
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 1, 'busy: one Esc must cancel at once')
  // A second busy Esc cancels again (no double-Esc windowing while busy).
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 2)
})

test('a single Esc while IDLE only arms the double-Esc window', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.app.setBusy(false)
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 0, 'idle: one Esc must not cancel')
})
