/**
 * M3-6 PR3 interaction-settlement failure regressions (external review P2):
 * a TuiApp-owned presentation cleanup failure must never strand an interaction
 * promise the surface still holds, and the ResponsiveOverlayFrame's one-shot
 * close notification must not be skipped by a throwing child dispose.
 *
 * Faults are injected into the REAL owners (private methods shadowed on the
 * instance / the real component). The FIRST three tests drive a non-dispose
 * settlement path (stop() / the overlay closer) so the process live-TUI slot
 * stays releasable; the LAST test is the TERMINAL fail-closed approval case
 * (a failed final `dispose()` keeps the slot claimed) and must therefore stay
 * last — node:test runs each file in its own process, so nothing after it is
 * poisoned.
 * @module @xmoon76/dsh-pi-tui/interaction-settlement-failure.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Component } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { liveTuiCountForTest } from '../src/tui/process-slot.ts'
import type { SaveLocationDeps } from '../src/tui/interaction/save-location.ts'
import { SaveLocationPrompt } from '../src/tui/interaction/save-location.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(): TuiApp {
  const app = new TuiApp(new VirtualTerminal(80, 24), { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return app
}

const SAVE_DEPS: SaveLocationDeps = {
  resolveDirectory: () => '/tmp',
  isDirectory: () => true,
  targetExists: () => false,
  complete: async () => null,
}

/** Bounded settlement probe: a stranded promise yields `timeout` instead of hanging. */
async function settleOutcome<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
): Promise<{ kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'timeout' }> {
  return Promise.race([
    promise.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>(resolve => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      timer.unref?.()
    }),
  ])
}

test('M3-6 PR3: a throwing overlay child dispose still fires the one-shot close notification', () => {
  const app = startApp()
  const failure = new Error('panel dispose failed')
  let closed = 0
  let threw = false
  // A plain Component whose FIRST dispose throws (later disposals are no-ops so
  // the afterEach sweep can still dispose the surface cleanly).
  const panel: Component = {
    render: () => ['panel'],
    invalidate: () => {},
    dispose: () => {
      if (threw) return
      threw = true
      throw failure
    },
  } as unknown as Component
  const closer = app.openPluginManagerPanel(panel, () => { closed += 1 })

  assert.throws(() => closer(), (error: unknown) => error === failure,
    'the child dispose failure stays observable')
  assert.equal(closed, 1, 'the one-shot close notification still fired exactly once')

  closer()
  assert.equal(closed, 1, 'a repeated close does not re-notify')
})

test('M3-6 PR3: a throwing question presentation cleanup still rejects the question promise', async (t) => {
  const app = startApp()
  const failure = new Error('question cleanup failed')
  const pending = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  // A REAL final-restoration step in settleQuestions.
  t.mock.method(app as unknown as { mountSeatChild(): void }, 'mountSeatChild', () => {
    throw failure
  })

  assert.throws(() => app.stop(), (error: unknown) => error === failure)
  const outcome = await settleOutcome(pending)
  assert.equal(outcome.kind, 'rejected', 'the question promise settled')
  assert.match(String((outcome as { error: unknown }).error), /question flow cancelled/)
  t.mock.restoreAll()
})

test('M3-6 PR3: a throwing SaveLocationPrompt.dispose() still settles the save-location promise', async (t) => {
  const app = startApp()
  const failure = new Error('save location prompt dispose failed')
  // The REAL prompt disposer in the save-location settlement batch.
  t.mock.method(SaveLocationPrompt.prototype, 'dispose', () => {
    throw failure
  })

  const pending = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    SAVE_DEPS,
  )
  assert.throws(() => app.stop(), (error: unknown) => error === failure)
  assert.deepEqual(await settleOutcome(pending), { kind: 'resolved', value: { kind: 'cancelled' } },
    'the save-location promise settles cancelled')

  t.mock.restoreAll()
})

/* TERMINAL fail-closed case — keep LAST in this file. */
test('M3-6 PR3: a throwing approval presentation cleanup still settles the approval promise (fail-closed slot)', async (t) => {
  const app = startApp()
  const failure = new Error('approval cleanup failed')
  let armed = false
  // A REAL presentation cleanup step in the active-approval branch. It must not
  // fire during the MOUNT (showNextApproval also calls it), so it is armed only
  // after the approval is active; then exactly one settlement call throws.
  t.mock.method(app as unknown as { clearFullscreenPointerGestures(): void }, 'clearFullscreenPointerGestures', () => {
    if (!armed) return
    armed = false
    throw failure
  })

  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe' })
  armed = true
  // Final disposal settles the active approval; the cleanup throw surfaces
  // from app.dispose(), but the promise must still settle cancelled.
  assert.throws(() => app.dispose(), (error: unknown) => error === failure)
  assert.deepEqual(await settleOutcome(decision), { kind: 'resolved', value: 'cancelled' },
    'the approval promise settles cancelled exactly once')
  assert.equal(liveTuiCountForTest(), 1,
    'fail-closed: the failed final TuiApp dispose keeps the process slot claimed')

  t.mock.restoreAll()
})
