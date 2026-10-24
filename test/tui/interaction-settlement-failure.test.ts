/**
 * M3-6 PR3 interaction-settlement failure regressions (external review P2):
 * a TuiApp-owned presentation cleanup failure must never strand an interaction
 * promise the surface still holds, and the Settings workspace lease's one-shot
 * close notification must not be skipped by a throwing embedded Plugin page
 * dispose.
 *
 * Faults are injected into the REAL owners (private methods shadowed on the
 * instance / the real component). The FIRST three tests drive a non-dispose
 * settlement path (stop() / the Settings lease closer) so the process live-TUI
 * slot stays releasable; the LAST test is the TERMINAL fail-closed approval case
 * (a failed final `dispose()` keeps the slot claimed) and must therefore stay
 * last — node:test runs each file in its own process, so nothing after it is
 * poisoned.
 * @module @xmoon76/dsh-pi-tui/interaction-settlement-failure.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import type { EmbeddedPluginPage } from '../../src/tui/plugin-manager/workspace.ts'
import { liveTuiCountForTest } from '../../src/tui/process-slot.ts'
import type { SaveLocationDeps } from '../../src/tui/interaction/save-location.ts'
import { SaveLocationPrompt } from '../../src/tui/interaction/save-location.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
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

test('a throwing plugin page dispose still fires the one-shot Settings lease notification', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const failure = new Error('plugin page dispose failed')
  let closed = 0
  let disposeCalls = 0
  // The Settings lease hosts the ONE embedded Plugin page; its teardown owner
  // is the SettingsWorkspacePanel, which drops the child BEFORE disposing it.
  const page: EmbeddedPluginPage = {
    focused: false,
    render: () => ['plugin page'],
    invalidate: () => {},
    setViewport: () => {},
    currentView: () => 'list',
    canYieldFocusToNavigation: () => true,
    pendingMutation: () => false,
    gestureRevision: () => 0,
    cancelPointer: () => {},
    handleInput: () => {},
    handleMouse: () => undefined,
    onCellPress: () => {},
    onCellClick: () => {},
    contentLayout: () => ({ dual: false, leftWidth: 1, rightWidth: 1 }),
    dispose: () => {
      disposeCalls += 1
      throw failure
    },
  }
  const settings = app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready', rows: [], capturedAt: Date.now() }) },
    {
      aboutVersionFacts: { tui: 'test-bundle', dsh: undefined },
      onOpenLegacy: () => {},
      onClose: () => { closed += 1 },
      initialCategory: 'plugins',
      onOpenPlugins: () => page,
    },
  )
  // The page is built by the first real Settings frame (the lazy mount).
  await vt.waitForRender()
  assert.equal(disposeCalls, 0, 'the page is mounted, not disposed')

  assert.throws(() => settings.close(), (error: unknown) => error === failure,
    'the child dispose failure stays observable')
  assert.equal(closed, 1, 'the one-shot Settings lease notification still fired exactly once')
  assert.equal(disposeCalls, 1, 'the throwing teardown is not retried by the lease closer')

  // No ghost owner: the Settings root already dropped the page reference before
  // its throwing dispose, so a repeated close never reaches it again.
  settings.close()
  assert.equal(closed, 1, 'a repeated close does not re-notify')
  assert.equal(disposeCalls, 1, 'a repeated close does not re-dispose the child')
})

test('a throwing question presentation cleanup still rejects the question promise', async (t) => {
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

test('a throwing SaveLocationPrompt.dispose() still settles the save-location promise', async (t) => {
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
test('a throwing approval presentation cleanup still settles the approval promise (fail-closed slot)', async (t) => {
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
