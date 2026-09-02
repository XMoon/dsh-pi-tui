/**
 * Re-vendor lifecycle follow-up P3 gates: the process-global keybindings
 * (the vendored fork's `getKeybindings()` singleton) force a
 * single-LIVE-TUI-per-process invariant. TuiApp.start() claims the
 * process slot and TuiApp.stop() releases it — a second CONCURRENTLY
 * LIVE surface rejects deterministically; stop/start round-trips
 * (external-editor suspend/resume, fullscreen main/alt-screen swaps)
 * never trip the guard. See plan §9–§12 and §17.
 * @module @xmoon76/dsh-pi-tui/process-tui-slot.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { liveTuiCountForTest } from '../src/process-tui-slot.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function newApp(): TuiApp {
  return new TuiApp(new VirtualTerminal(80, 24), { onSubmit: () => {}, onExit: () => {} })
}

test('a second CONCURRENTLY live TuiApp deterministically rejects (plan §12)', async () => {
  const appA = newApp()
  appA.start()
  assert.equal(liveTuiCountForTest(), 1)
  // App B starts while A is LIVE: the process-global keybindings cannot
  // express two apps' bindings — fail fast instead of silently sharing.
  const appB = newApp()
  assert.throws(
    () => appB.start(),
    /one live TuiApp per process/,
    'a second live TuiApp must reject deterministically',
  )
  assert.equal(liveTuiCountForTest(), 1, 'the rejected start must not leak the slot')
  appA.stop()
  assert.equal(liveTuiCountForTest(), 0)
})

test('dispose A → start B succeeds (plan §12)', () => {
  const appA = newApp()
  appA.start()
  assert.equal(liveTuiCountForTest(), 1)
  appA.dispose()
  assert.equal(liveTuiCountForTest(), 0, 'final disposal must release the slot')
  const appB = newApp()
  appB.start()
  assert.equal(liveTuiCountForTest(), 1)
  appB.stop()
  assert.equal(liveTuiCountForTest(), 0)
})

test('a stop/start round-trip does not trip the guard and re-claims cleanly (plan §11/§12)', async () => {
  const app = newApp()
  app.start()
  // The external-editor suspend/resume and ordinary stop/start cycles are
  // temporary transitions INSIDE one surface generation — the same app
  // stopping and starting again must never count as a second TUI.
  app.stop()
  assert.equal(liveTuiCountForTest(), 0, 'a stopped surface is not live')
  app.start()
  assert.equal(liveTuiCountForTest(), 1, 'the round-trip re-claims the slot')
  app.stop()
  // A repeated stop is a no-op (idempotent release).
  app.stop()
  assert.equal(liveTuiCountForTest(), 0)
  // A repeated start without an intervening stop does not double-claim.
  app.start()
  app.start()
  assert.equal(liveTuiCountForTest(), 1, 'a second start on the same surface must not double-claim')
  app.stop()
  assert.equal(liveTuiCountForTest(), 0)
})

test('fullscreen main/alt-screen swaps never trip the guard (plan §11)', async () => {
  const app = newApp()
  app.start()
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(liveTuiCountForTest(), 1)
  // The fullscreen swap stops/starts the SCREENS — never the app — so the
  // app-level slot is untouched end to end.
  app.setFullscreen(true)
  assert.equal(liveTuiCountForTest(), 1, 'fullscreen entry must not release the slot')
  app.setFullscreen(false)
  assert.equal(liveTuiCountForTest(), 1, 'fullscreen exit must not release the slot')
  app.stop()
  assert.equal(liveTuiCountForTest(), 0)
})

test('a stopped surface releases the slot so the next surface may start (the live invariant)', async () => {
  const appA = newApp()
  appA.start()
  appA.stop()
  // A is no longer LIVE: B may start — the failure mode the guard targets
  // is two CONCURRENTLY live surfaces sharing one keybinding singleton.
  const appB = newApp()
  appB.start()
  assert.equal(liveTuiCountForTest(), 1)
  appB.stop()
})

test('a disposed TuiApp can never start again (no process-slot poisoning)', () => {
  const app = newApp()
  app.start()
  app.dispose()
  // start() after dispose is a misuse: the slot is already released and
  // dispose is latched, so a silent "start" would claim a slot nobody can
  // ever release (review-loop round 1 — the previous behavior left the
  // process slot claimed forever and rejected later fresh apps with a
  // misleading error).
  assert.throws(() => app.start(), /cannot start a disposed TuiApp/)
  assert.equal(liveTuiCountForTest(), 0, 'the failed start must not claim anything')
  // A fresh app still works afterwards.
  const next = newApp()
  next.start()
  assert.equal(liveTuiCountForTest(), 1)
  next.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})

test('dispose releases the process slot even before any stop (the release is unconditional)', () => {
  // The slot release must not depend on reaching the END of the stop()
  // path: dispose() releases at its head (review-loop round 1), so a
  // never-started app or a throwing-teardown path cannot poison the slot.
  const app = newApp()
  app.start()
  assert.equal(liveTuiCountForTest(), 1)
  app.dispose()
  assert.equal(liveTuiCountForTest(), 0, 'the disposed surface must not keep the slot')
  // dispose() -> stop() -> finally-release is idempotent (release twice).
  app.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})
