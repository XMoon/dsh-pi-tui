/**
 * Headless tests for Esc cancellation: a SINGLE Esc while the agent is
 * busy fires onCancel at once (pi parity); while idle a fast second Esc
 * fires it; overlays keep their own Esc. The runner-side handler
 * (`interruptAgent`) is covered below — its `keepInbox: true` preserves
 * the pending queue (web Stop parity), so an interrupt never destroys
 * queued input. The conversation-rewind mapping (idle + EMPTY editor +
 * double-Esc → onRewind, fork_rewind plan E01–E11) lives in the second
 * half, including the headless Esc-Esc → picker → select E2E.
 * @module @xmoon76/dsh-pi-tui/cancel.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { SettingItem } from '@xmoon76/pi-tui'
import { interruptAgent } from '../src/index.ts'
import type { SessionWriter } from '../src/runtime/session-writer-port.ts'
import { rewindPickerItem } from '../src/rewind.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces,
 * so a test that starts an app must not leak the slot into the next test
 * (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})


/** A writer stub that routes cancel to the agent's own cancel (the runner
 * wires the Direct adapter the same way). */
function writerStub(): SessionWriter {
  return {
    followup: () => {},
    steer: () => {},
    dequeue: () => {},
    cancel: (sessionId, cause, options) => {
      ;(stubAgents.get(sessionId) as { cancel(c: unknown, o: unknown): void }).cancel(cause, options)
    },
    rename: () => true,
    refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
  }
}

/** The fake live agents the interrupt tests drive (written by the agent
 * fakes below). */
const stubAgents = new Map<string, { cancel(c: unknown, o: unknown): void }>()

function startApp(): { vt: VirtualTerminal; app: TuiApp; cancels: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => { cancels += 1 } })
  app.start()
  startedApps.add(app)
  return { vt, app, get cancels() { return cancels } }
}

/** A host WITH conversation rewind wired (the runner's onRewind). */
function startAppWithRewind(): { vt: VirtualTerminal; app: TuiApp; cancels: number; rewinds: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let rewinds = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
    onRewind: () => { rewinds += 1 },
  })
  app.start()
  startedApps.add(app)
  return { vt, app, get cancels() { return cancels }, get rewinds() { return rewinds } }
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

function startAppWithExits(options: { exitConfirmWindowMs?: number } = {}): { vt: VirtualTerminal; app: TuiApp; cancels: number; exits: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => { exits += 1 },
    onCancel: () => { cancels += 1 },
  }, options)
  app.start()
  startedApps.add(app)
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
  surface.vt.sendInput('\x03') // within the confirmation window: exit
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
  // A third press starts a fresh window: no immediate exit.
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'after exiting the window resets')
})

test('the first empty-editor Ctrl+C shows the exit-confirmation hint', async () => {
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
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  const lines = surface.vt.getViewport()
  // The 100x24 layout: header (0), editor (1-3), then the footer rows. The
  // instruction is an INDEPENDENT surface (plan 2026-08-31 §7): it APPENDS
  // after the status + stats rows instead of replacing the stats line-2
  // slot, so the hint is the footer's LAST line.
  assert.ok(lines[6]!.includes('Press Ctrl+C again to exit'),
    `the hint must sit in the footer's last line:\n${lines.join('\n')}`)
  assert.ok(!lines.slice(0, 4).join('\n').includes('Press Ctrl+C again to exit'),
    `the hint must never enter the transcript notify area:\n${lines.join('\n')}`)
})

test('the exit hint disappears when the window expires (one shared timer)', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 80 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed: hint visible')
  // Past the window: the hint and the exit window die TOGETHER. Poll for
  // the expiry instead of sleeping a fixed delay.
  await waitFor(() => !footerLine(surface.vt).includes('Press Ctrl+C again to exit'), surface.vt)
})

test('a second Ctrl+C after the window expired only re-arms, never exits', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 80 })
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
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
  assert.ok(!footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `the hint must clear on exit:\n${surface.vt.getViewport().join('\n')}`)
})

test('a different exit key replaces the armed key (C → D)', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // arm Ctrl+C
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'), 'armed before Ctrl+D')
  surface.vt.sendInput('\x04') // first Ctrl+D replaces the armed key
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'a cross-key press must not exit')
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+D again to exit'), 'Ctrl+D must be armed')
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'the same Ctrl+D confirms the exit')
})

test('Ctrl+C with text clears the editor AND shows the exit hint', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
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

test('Ctrl+D requires a same-key second press', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'the first Ctrl+D must only arm')
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+D again to exit'))
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
})

test('Ctrl+D with a non-empty draft stays editor-owned for forward delete', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('abc')
  surface.vt.sendInput('\x1b[H') // move the cursor to the start
  surface.vt.sendInput('\x04')
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.app.seatTextForTest(), 'c', 'Ctrl+D must delete forward in non-empty text')
  assert.equal(surface.exits, 0, 'editor-owned Ctrl+D must never exit')
  assert.ok(!footerLine(surface.vt).includes('Press Ctrl+D again to exit'),
    'editor-owned Ctrl+D must not arm Host exit confirmation')
})

test('Ctrl+D → Ctrl+C replaces the armed key without exiting', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0)
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'))
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
})

test('an ordinary editor key disarms the keyboard exit confirmation', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  surface.vt.sendInput('a')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'typing between exit presses must disarm')
  assert.equal(surface.app.seatTextForTest(), 'a', 'Ctrl+D must remain an editor key with text')
  assert.ok(!footerLine(surface.vt).includes('Press Ctrl+D again to exit'),
    'editor-owned Ctrl+D must not re-arm Host confirmation')
})

test('a host action disarms the keyboard exit confirmation', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x0f') // Ctrl+O: transcript expansion action
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'a host action between presses must disarm')
})

test('a custom exit key uses dynamic same-key confirmation', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  surface.app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.exit.request': 'ctrl+x' }))
  await surface.vt.waitForRender()
  surface.vt.sendInput('draft')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x18')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0)
  assert.equal(surface.app.seatTextForTest(), 'draft', 'custom exit keys preserve the draft')
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+X again to exit'))
  surface.vt.sendInput('\x18')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
})

test('an explicit Ctrl+D exit remap stays Host-owned with a non-empty draft', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  surface.app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.exit.request': 'ctrl+d' }))
  await surface.vt.waitForRender()
  surface.app.setDraft('draft')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.app.seatTextForTest(), 'draft', 'a custom Ctrl+D must preserve the draft')
  assert.equal(surface.exits, 0)
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+D again to exit'))
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'the custom Ctrl+D must confirm through the Host path')
})

test('Ctrl+D confirmation expires and must be re-armed', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 50 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+D again to exit'))
  await waitFor(() => !footerLine(surface.vt).includes('Press Ctrl+D again to exit'), surface.vt)
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0)
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+D again to exit'))
})

test('a submit clears the armed exit confirmation', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
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
  const surface = startAppWithExits({ exitConfirmWindowMs: 50 })
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

test('stop/start cannot carry an armed exit confirmation forward', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+D again to exit'))

  surface.app.stop()
  surface.app.start()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'the first press after restart must re-arm')
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1, 'only the post-restart second press may exit')
})

test('a session transition clears the armed exit confirmation', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  surface.app.clearExitConfirmation()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'a stale first press must not exit the new session')
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
})

test('the compact footer preset still shows the armed hint', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 200 })
  await surface.vt.waitForRender()
  surface.app.setFooterPreset('compact')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.ok(footerLine(surface.vt).includes('Press Ctrl+C again to exit'),
    `compact must not hide the armed hint (the user just triggered it):\n${surface.vt.getViewport().join('\n')}`)
})

test('Ctrl+C presses spaced beyond the window do not exit', async () => {
  const surface = startAppWithExits({ exitConfirmWindowMs: 80 })
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
  assert.equal(surface.exits, 1, 'same-key confirmation preserves the pi chord')
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

// ── conversation rewind (fork_rewind plan): idle empty double-Esc ─────────

test('E03: an idle EMPTY single Esc never rewinds', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 0, 'one Esc must only arm the window')
  assert.equal(surface.cancels, 0)
})

test('E04: an idle EMPTY double-Esc opens rewind, never cancel', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 1, 'empty editor + fast second Esc must rewind')
  assert.equal(surface.cancels, 0)
})

test('E05: an idle NON-EMPTY double-Esc keeps the cancel semantics', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.vt.sendInput('half-written draft')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 0, 'a non-empty draft must never open rewind')
  assert.equal(surface.cancels, 1, 'the historical idle double-Esc cancel stays')
})

test('E06: a slow second Esc never rewinds', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  await new Promise(resolve => setTimeout(resolve, 500))
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 0)
  assert.equal(surface.cancels, 0)
})

test('E12: an intervening key press disarms the double-Esc window', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b') // arm
  surface.vt.sendInput('\x1b[D') // Left between the presses: disarms
  surface.vt.sendInput('\x1b') // a third Esc within the window: re-arms only
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 0, 'Esc + Left + Esc must NOT rewind')
  assert.equal(surface.cancels, 0, 'Esc + Left + Esc must NOT cancel either')
  // A clean consecutive double-Esc after the disarm still fires.
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 1, 'a clean consecutive double-Esc still rewinds')
})

test('E01/E02: busy Esc stays a pure cancel — a quick second Esc never rewinds a half turn', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.app.setBusy(true)
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.cancels, 2, 'busy: every Esc cancels at once')
  assert.equal(surface.rewinds, 0, 'busy Esc must never open rewind')
})

test('E07: an open autocomplete owns Esc (closes it, never rewinds)', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.app.setCommandCompletions(
    [{ name: 'rewind', description: 'Fork this conversation from an earlier user turn', argumentHint: '' }],
    '/ws',
  )
  surface.vt.sendInput('/')
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 0, 'autocomplete Esc must close the dropdown, never rewind')
  assert.equal(surface.cancels, 0)
})

test('E10: the subagent viewer owns its Esc (exits, never rewinds)', async () => {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let rewinds = 0
  let singleEscapes = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
    onRewind: () => { rewinds += 1 },
    // The runner's viewer exit hook consumes the first Esc.
    onSingleEscape: () => { singleEscapes += 1; return true },
  })
  app.start()

  startedApps.add(app)
  app.setViewerMode({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    label: 'research',
    mode: 'one-shot',
    activity: 'inactive',
  })
  await vt.waitForRender()
  vt.sendInput('\x1b')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 2, 'every viewer Esc exits through the single-Esc hook')
  assert.equal(rewinds, 0, 'the viewer owns Esc — rewind must never fire')
  assert.equal(cancels, 0)
})

test('E11: Kitty release/repeat escapes never count toward the double-Esc window', async () => {
  const surface = startAppWithRewind()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x1b[27;1:3u') // release
  surface.vt.sendInput('\x1b[27;1:2u') // repeat
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 0)
  assert.equal(surface.cancels, 0)
  // Real presses still arm and fire the window.
  surface.vt.sendInput('\x1b')
  surface.vt.sendInput('\x1b')
  await surface.vt.waitForRender()
  assert.equal(surface.rewinds, 1, 'release/repeat noise must not break real presses')
})

// ── headless E2E: Esc Esc → rewind picker → select (plan §28) ─────────────

test('Esc Esc opens the rewind picker and Enter selects the turn (headless E2E)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const picked: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The runner's onRewind shape: collect candidates, open the picker.
    onRewind: () => {
      app.openPicker(
        [
          rewindPickerItem({ turnStartSeq: 8, turn: 3, messageSeq: 9, editorText: 'C', preview: 'C', hasNonTextContent: false }),
          rewindPickerItem({ turnStartSeq: 4, turn: 2, messageSeq: 5, editorText: 'B', preview: 'B', hasNonTextContent: false }),
          rewindPickerItem({ turnStartSeq: 0, turn: 1, messageSeq: 1, editorText: 'A', preview: 'A', hasNonTextContent: false }),
        ],
        (value) => picked.push(value),
        () => {},
        { header: 'Rewind conversation · workspace unchanged', enableSearch: true, noMatchText: 'No matching turn', width: 72, maxHeight: 24, showHint: true },
      )
    },
  })
  app.start()

  startedApps.add(app)
  await vt.waitForRender()
  vt.sendInput('\x1b')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Rewind conversation'), `the picker must open:\n${view}`)
  assert.ok(view.includes('turn 3 · C'), `the newest candidate must render:\n${view}`)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(picked, ['8'], 'Enter selects the highlighted turnStartSeq')
  app.stop()
})

test('Esc Esc while busy never opens the rewind picker (plan §28 second half)', async () => {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let pickerOpened = false
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
    onRewind: () => { pickerOpened = true },
  })
  app.start()

  startedApps.add(app)
  app.setBusy(true)
  await vt.waitForRender()
  vt.sendInput('\x1b')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancels, 2, 'busy Esc only aborts')
  assert.equal(pickerOpened, false, 'no picker while the agent streams')
})

// ── interruptAgent: the runner-side cancel preserves the queue ────────────

test('interruptAgent cancels with keepInbox: true (web Stop parity)', () => {
  const calls: Array<{ cause: unknown; options: unknown }> = []
  const agent = {
    session: { id: 'session-a' },
    status: 'running',
    cancel: (cause: unknown, options: unknown) => { calls.push({ cause, options }) },
  }
  stubAgents.set('session-a', agent)
  interruptAgent(agent as never, writerStub())
  assert.equal(calls.length, 1, 'a running agent is interrupted exactly once')
  assert.deepEqual(calls[0]!.cause, { kind: 'user' })
  // THE regression: the default dsh cancel clears queued + steering
  // input; the interrupt must pass keepInbox so Esc never destroys the
  // queue (the P0 of the 2026-08-22 plan).
  assert.deepEqual(calls[0]!.options, { keepInbox: true })
})

test('interruptAgent tolerates an idle agent (no status gate, no throw)', () => {
  const calls: Array<{ cause: unknown; options: unknown }> = []
  const agent = {
    session: { id: 'session-b' },
    // 'idle' — a maintenance task (compaction) may still be aborted by
    // dsh's cancel, so the helper must NOT gate on the running status.
    status: 'idle',
    cancel: (cause: unknown, options: unknown) => { calls.push({ cause, options }) },
  }
  stubAgents.set('session-b', agent)
  interruptAgent(agent as never, writerStub())
  assert.equal(calls.length, 1, 'the cancel call itself is still made (dsh no-ops when idle)')
  assert.deepEqual(calls[0]!.options, { keepInbox: true })
})

test('interruptAgent with no live agent is a silent no-op', () => {
  interruptAgent(undefined, writerStub())
})
