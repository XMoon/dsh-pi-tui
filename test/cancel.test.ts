/**
 * Headless tests for Esc cancellation: a SINGLE Esc while the agent is
 * busy fires onCancel at once (pi parity); while idle a fast second Esc
 * fires it; overlays keep their own Esc. The runner-side handler
 * (`interruptAgent`) is covered below — its `keepInbox: true` preserves
 * the pending queue (web Stop parity), so an interrupt never destroys
 * queued input.
 * @module @xmoon76/dsh-pi-tui/cancel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SettingItem } from '@xmoon76/pi-tui'
import { interruptAgent } from '../src/index.ts'
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

function startAppWithExits(options: { ctrlCExitWindowMs?: number } = {}): { vt: VirtualTerminal; app: TuiApp; cancels: number; exits: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => { exits += 1 },
    onCancel: () => { cancels += 1 },
  }, options)
  app.start()
  return { vt, app, get cancels() { return cancels }, get exits() { return exits } }
}

/** The footer's second line (the last non-empty viewport row). */
function footerLine(vt: VirtualTerminal): string {
  const lines = vt.getViewport()
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim() !== '') return lines[i]!
  }
  return ''
}

/** Poll until the predicate holds (bounded) — never a fixed sleep, which
 * would make the timer tests timing-sensitive (AGENTS.md trap). Flushes a
 * render between polls so the predicate sees settled frames. */
async function waitFor(predicate: () => boolean, vt: VirtualTerminal, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the condition')
    await new Promise(resolve => setTimeout(resolve, 10))
    await vt.waitForRender()
  }
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

test('the first empty-editor Ctrl+C shows the exit-chord hint', async () => {
  const surface = startAppWithExits()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // empty editor: arms the window
  await surface.vt.waitForRender()
  const viewport = surface.vt.getViewport().join('\n')
  assert.ok(viewport.includes('Press Ctrl+C again to exit'),
    `the armed window must be visible (a silent arm is a missed chord):\n${viewport}`)
  assert.equal(surface.exits, 0, 'the first press must not exit')
})

// ── issue #8: the exit hint lives in the footer for EXACTLY the window ───

test('the exit hint renders in the FOOTER, never the transcript notify', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  const lines = surface.vt.getViewport()
  // The 100x24 layout: header (0), editor (1-3), footer line1 (4), footer
  // line2 (5). The hint must be the footer's second line — the transcript
  // area (rows 0-3) must NOT carry it.
  assert.ok(lines[5]!.includes('Press Ctrl+C again to exit'),
    `the hint must sit in the footer line 2:\n${lines.join('\n')}`)
  assert.ok(!lines.slice(0, 4).join('\n').includes('Press Ctrl+C again to exit'),
    `the hint must never enter the transcript notify area:\n${lines.join('\n')}`)
})

test('the exit hint disappears when the window expires (one shared timer)', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 80 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed: hint visible')
  // Past the window: the hint and the exit window die TOGETHER. Poll for
  // the expiry instead of sleeping a fixed delay.
  await waitFor(() => !footerLine(surface.vt).includes('Press Ctrl+C again to exit'), surface.vt)
})

test('a second Ctrl+C after the window expired only re-arms, never exits', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 80 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed: hint visible')
  // Wait for the window to expire (poll, never a fixed sleep).
  await waitFor(() => !footerLine(surface.vt).includes('Press Ctrl+C again to exit'), surface.vt)
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'a slow second press must not exit')
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'the slow press re-arms the hint')
  // A fast third press now exits.
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'a fast press after re-arming exits')
})

test('a successful exit clears the hint', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
  assert.ok(!footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `the hint must clear on exit:\n${surface.vt.getViewport().join('\n')}`)
})

test('Ctrl+D while armed clears the hint too (round-1 finding)', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // arm
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed before Ctrl+D')
  surface.vt.sendInput('\x04') // ctrl+d
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'Ctrl+D exits')
  assert.ok(!footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `the armed hint must not survive a Ctrl+D exit:\n${surface.vt.getViewport().join('\n')}`)
})

test('Ctrl+C with text clears the editor AND shows the exit hint', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('abc')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.app.seatTextForTest(), '', 'the editor must be cleared')
  assert.equal(surface.exits, 0, 'a first Ctrl+C on text must not exit')
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `clear-then-arm must show the hint:\n${surface.vt.getViewport().join('\n')}`)
})

test('a submit clears the armed exit chord', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // arm
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed before submit')
  surface.vt.sendInput('hello')
  surface.vt.sendInput('\r') // submit
  await surface.vt.waitForRender()
  assert.ok(!footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `a fresh explicit action must disarm the chord:\n${surface.vt.getViewport().join('\n')}`)
})

test('dispose clears the exit timer (no stale timer fires into a dead surface)', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 50 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // arm
  await surface.vt.waitForRender()
  surface.app.dispose()
  // Past the window: the timer was cleared by dispose — nothing fires, no
  // crash, no exit. There is no rendered state to poll after dispose, so
  // the bounded wait only gives a stale timer a chance to fire (an
  // unhandled error would fail the test); the assertion itself is not
  // timing-sensitive.
  const deadline = Date.now() + 100
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await surface.vt.waitForRender()
  }
  assert.equal(surface.exits, 0)
})

test('the compact footer preset still shows the armed hint', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.app.setFooterPreset('compact')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `compact must not hide the armed hint (the user just triggered it):\n${surface.vt.getViewport().join('\n')}`)
})

test('Ctrl+C presses spaced beyond the window do not exit', async () => {
  const surface = startAppWithExits({ ctrlCExitWindowMs: 80 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed: hint visible')
  // A press beyond the window must only re-arm. Poll for the expiry
  // instead of sleeping a fixed delay (round-2 finding).
  await waitFor(() => !footerLine(surface.vt).includes('Press Ctrl+C again to exit'), surface.vt)
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

test('Ctrl+C clearing the editor REPAINTS the frame (stale-clear trap)', async () => {
  const surface = startAppWithExits()
  await surface.vt.waitForRender()
  surface.vt.sendInput('hello world')
  await surface.vt.waitForRender()
  const before = surface.vt.getViewport().join('\n')
  assert.ok(before.includes('hello world'), `the draft must be visible before Ctrl+C:\n${before}`)
  surface.vt.sendInput('\x03') // ctrl+c
  await surface.vt.waitForRender()
  assert.equal(surface.app.seatTextForTest(), '', 'the editor must be cleared')
  const after = surface.vt.getViewport().join('\n')
  assert.ok(!after.includes('hello world'),
    `the cleared editor must paint on the next frame (the key is app-consumed, so the fork never renders on its own):\n${after}`)
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

// ── interruptAgent: the runner-side cancel preserves the queue ────────────

test('interruptAgent cancels with keepInbox: true (web Stop parity)', () => {
  const calls: Array<{ cause: unknown; options: unknown }> = []
  interruptAgent({
    status: 'running',
    cancel: (cause, options) => { calls.push({ cause, options }) },
  })
  assert.equal(calls.length, 1, 'a running agent is interrupted exactly once')
  assert.deepEqual(calls[0]!.cause, { kind: 'user' })
  // THE regression: the default dsh cancel clears queued + steering
  // input; the interrupt must pass keepInbox so Esc never destroys the
  // queue (the P0 of the 2026-08-22 plan).
  assert.deepEqual(calls[0]!.options, { keepInbox: true })
})

test('interruptAgent tolerates an idle agent (no status gate, no throw)', () => {
  const calls: Array<{ cause: unknown; options: unknown }> = []
  interruptAgent({
    // 'idle' — a maintenance task (compaction) may still be aborted by
    // dsh's cancel, so the helper must NOT gate on the running status.
    status: 'idle',
    cancel: (cause, options) => { calls.push({ cause, options }) },
  })
  assert.equal(calls.length, 1, 'the cancel call itself is still made (dsh no-ops when idle)')
  assert.deepEqual(calls[0]!.options, { keepInbox: true })
})

test('interruptAgent with no live agent is a silent no-op', () => {
  interruptAgent(undefined)
})
