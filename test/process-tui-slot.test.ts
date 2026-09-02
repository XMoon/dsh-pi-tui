/**
 * Re-vendor lifecycle follow-up P3 gates: the vendored fork's
 * `getKeybindings()` singleton is PROCESS-GLOBAL, and a TuiApp's
 * HostKeybindingManager syncs `app.input.submit` → `tui.editor.submit`
 * into it on EVERY rebuild — the manager SURVIVES `stop()` (only final
 * `dispose()` ends the surface generation). The process slot therefore
 * protects the process-global KEYBINDING NAMESPACE, not terminal
 * raw-mode: it is claimed at the FIRST successful start, KEPT across
 * stop/start round-trips and fullscreen/external-editor screen swaps,
 * and released ONLY at the END of a completed final dispose
 * (fail-closed). See plan §9–§12, §17 and review-loop round 2.
 * @module @xmoon76/dsh-pi-tui/process-tui-slot.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { liveTuiCountForTest } from '../src/process-tui-slot.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function newApp(): TuiApp {
  return new TuiApp(new VirtualTerminal(80, 24), { onSubmit: () => {}, onExit: () => {} })
}

test('a second CONCURRENTLY live TuiApp deterministically rejects (plan §12)', () => {
  const appA = newApp()
  appA.start()
  assert.equal(liveTuiCountForTest(), 1)
  // App B starts while A owns the process slot: the process-global
  // keybindings cannot express two apps' bindings — fail fast instead of
  // silently sharing.
  const appB = newApp()
  assert.throws(
    () => appB.start(),
    /one live TuiApp per process/,
    'a second live TuiApp must reject deterministically',
  )
  assert.equal(liveTuiCountForTest(), 1, 'the rejected start must not leak the slot')
  appA.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})

test('dispose A → start B succeeds (plan §12)', () => {
  const appA = newApp()
  appA.start()
  assert.equal(liveTuiCountForTest(), 1)
  appA.dispose()
  assert.equal(liveTuiCountForTest(), 0, 'the completed final disposal must release the slot')
  const appB = newApp()
  appB.start()
  assert.equal(liveTuiCountForTest(), 1)
  appB.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})

test('a stop/start round-trip never releases the slot (process-global namespace stays owned)', () => {
  const app = newApp()
  app.start()
  assert.equal(liveTuiCountForTest(), 1)
  // stop() deliberately does NOT release (review-loop round 2): the
  // surface generation survives the stop and its HostKeybindingManager
  // still owns the process-global keybindings.
  app.stop()
  assert.equal(liveTuiCountForTest(), 1, 'a stopped-but-not-disposed surface keeps the slot')
  app.start()
  assert.equal(liveTuiCountForTest(), 1, 'a resume must not re-claim (the slot was never released)')
  app.stop()
  app.stop() // a repeated stop is a no-op
  assert.equal(liveTuiCountForTest(), 1)
  app.start()
  app.start() // a repeated start does not double-claim
  assert.equal(liveTuiCountForTest(), 1, 'a second start on the same surface must not double-claim')
  app.dispose()
  assert.equal(liveTuiCountForTest(), 0, 'only the final dispose releases')
})

test('fullscreen main/alt-screen swaps never trip the guard (plan §11)', () => {
  const app = newApp()
  app.start()
  assert.equal(liveTuiCountForTest(), 1)
  // The fullscreen swap stops/starts the SCREENS — never the app — so the
  // app-level slot is untouched end to end.
  app.setFullscreen(true)
  assert.equal(liveTuiCountForTest(), 1, 'fullscreen entry must not release the slot')
  app.setFullscreen(false)
  assert.equal(liveTuiCountForTest(), 1, 'fullscreen exit must not release the slot')
  app.stop()
  assert.equal(liveTuiCountForTest(), 1, 'a screen-level stop must not release the slot')
  app.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})

test('a stopped-but-not-final-disposed surface keeps the process slot (fail-closed ownership)', () => {
  const appA = newApp()
  appA.start()
  appA.stop()
  assert.equal(liveTuiCountForTest(), 1, 'the stopped surface still owns the namespace')
  // App B must NOT start while A is stopped but alive: A's keybinding
  // manager can rebuild at any time and repaint the process-global
  // bindings under B.
  const appB = newApp()
  assert.throws(() => appB.start(), /one live TuiApp per process/)
  // The same-generation resume works (no re-claim, no trip).
  appA.start()
  assert.equal(liveTuiCountForTest(), 1)
  appA.stop()
  // Only the FINAL dispose frees the slot for the next surface.
  appA.dispose()
  assert.equal(liveTuiCountForTest(), 0)
  appB.start()
  assert.equal(liveTuiCountForTest(), 1)
  appB.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})

test('the slot covers process-global keybinding ownership, not terminal raw-mode', () => {
  const appA = newApp()
  appA.start()
  appA.stop()
  // A's HostKeybindingManager survives stop(): a remap / plugin sync
  // rebuilds and SYNCES A's submit keys into the PROCESS-GLOBAL fork
  // keybindings (getKeybindings().setUserBindings) — the exact pollution
  // vector the slot must block.
  appA.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': 'ctrl+x' }))
  // Even though A is not rendering (raw mode released), it still owns the
  // shared keybinding namespace: B must be rejected.
  const appB = newApp()
  assert.throws(
    () => appB.start(),
    /one live TuiApp per process/,
    'a rebuild by a stopped-but-alive surface must not make room for a second app',
  )
  appA.dispose()
  const appC = newApp()
  appC.start()
  appC.dispose()
})

test('a disposed TuiApp can never start again (no process-slot poisoning)', () => {
  const app = newApp()
  app.start()
  app.dispose()
  // start() after dispose is a misuse: the slot is already released and
  // dispose is latched, so a silent "start" would claim a slot nobody can
  // ever release (review-loop round 1).
  assert.throws(() => app.start(), /cannot start a disposed TuiApp/)
  assert.equal(liveTuiCountForTest(), 0, 'the failed start must not claim anything')
  // A fresh app still works afterwards.
  const next = newApp()
  next.start()
  assert.equal(liveTuiCountForTest(), 1)
  next.dispose()
  assert.equal(liveTuiCountForTest(), 0)
})

test('the final dispose releases the process slot exactly once (idempotent)', () => {
  const app = newApp()
  app.start()
  assert.equal(liveTuiCountForTest(), 1)
  // The release happens at the END of the completed final teardown —
  // after the keybinding manager, extension host and editor holder were
  // all disposed (fail-closed: a throwing teardown keeps the claim).
  app.dispose()
  assert.equal(liveTuiCountForTest(), 0, 'the completed final dispose must release the slot')
  assert.equal(app.isDisposed(), true)
  app.dispose() // idempotent
  assert.equal(liveTuiCountForTest(), 0, 'a repeated dispose must not re-release anything')
})
