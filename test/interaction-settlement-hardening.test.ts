/**
 * M3-6 PR3 round-5 hardening regressions (external/internal review F4/F5/F6):
 * - F4: a legitimately thrown `undefined` cleanup failure is NOT swallowed, and
 *   multiple settlement cleanup failures aggregate in execution order;
 * - F5: a queued question synchronously cancelled during handover is never
 *   mounted as the active flow (live-queue handover, not a stale snapshot);
 * - F6: an AbortSignal-listener settlement failure is routed to the owned
 *   diagnostic sink instead of escaping as a next-tick `uncaughtException`.
 *
 * The terminal F4 `throw undefined` case is LAST: a failed final dispose keeps
 * the process slot claimed, and node:test runs each file in its own process.
 * @module @xmoon76/dsh-pi-tui/interaction-settlement-hardening.test
 */

import assert from 'node:assert/strict'
import { afterEach, test, type TestContext } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { runOwned } from '../src/runtime/process/tasks.ts'
import { liveTuiCountForTest } from '../src/process-tui-slot.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(sink?: (label: string, error: unknown) => void): { app: TuiApp; vt: VirtualTerminal } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    ...sink === undefined ? {} : {
      runOwned: <T>(
        label: string,
        task: () => T | Promise<T>,
        options: Omit<import('../src/runtime/process/tasks.ts').OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
      ): void => {
        // Mirror `runOwned`'s option handling: a task-phase throw and an
        // `onResult` failure both reach the sink (the route uses `onResult`).
        void Promise.resolve().then(task).then(
          (result) => {
            try {
              options.onResult?.(result)
            } catch (error) {
              sink(label, error)
            }
          },
          (error: unknown) => { sink(label, error) },
        )
      },
    },
  })
  app.start()
  startedApps.add(app)
  return { app, vt }
}

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

/**
 * Start a TuiApp whose `events.runOwned` is the REAL production primitive with
 * a capturing diagnostics sink — the classification口径 under test is the
 * production one, not a stub.
 */
function startAppWithRealRunOwned(lines: string[]): { app: TuiApp; vt: VirtualTerminal } {
  const diag = createDiag({
    filePath: undefined,
    stderrLevel: 'off',
    sinks: [{ write: line => { lines.push(line) } }],
  })
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<import('../src/runtime/process/tasks.ts').OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void =>
      runOwned(label, task, { ...options, diag }),
  })
  app.start()
  startedApps.add(app)
  return { app, vt }
}

/** One abort-routed settlement failure with a real owned sink; returns its log line. */
async function runAbortRoutedFailure(
  t: TestContext,
  failure: Error,
): Promise<string | undefined> {
  const lines: string[] = []
  const { app } = startAppWithRealRunOwned(lines)
  let armed = false
  t.mock.method(app as unknown as { clearFullscreenPointerGestures(): void }, 'clearFullscreenPointerGestures', () => {
    if (!armed) return
    armed = false
    throw failure
  })
  const controller = new AbortController()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal })
  armed = true
  controller.abort()
  assert.deepEqual(await settleOutcome(decision), { kind: 'resolved', value: 'cancelled' },
    'the approval promise still settles through the abort route')
  // Flush the owned-runner microtask chain that records the diagnostic.
  await new Promise(resolve => setImmediate(resolve))
  t.mock.restoreAll()
  // Release the process slot so the next subcase can start its own app.
  app.dispose()
  startedApps.delete(app)
  return lines.find(entry => entry.includes('approval abort settlement'))
}

test('M3-6 PR3 F6: a cleanup failure is recorded as an ERROR through the real owned sink (never as a cancellation)', async (t) => {
  for (const failure of [
    new Error('plain cleanup failed'),
    Object.assign(new Error('abort-shaped cleanup failed'), { name: 'AbortError' }),
    Object.assign(new Error('code-shaped cleanup failed'), { code: 'ABORT_ERR' }),
  ]) {
    const line = await runAbortRoutedFailure(t, failure)
    assert.ok(line, `the owned sink recorded the settlement failure for ${failure.message}`)
    assert.match(line, / ERROR /, `recorded at error level: ${line}`)
    assert.match(line, new RegExp(failure.message), 'the exact failure message reached the sink')
    assert.doesNotMatch(line, /DEBUG|cancelled=true/,
      'a cleanup failure is never misclassified as a user cancellation')
  }
})

test('M3-6 PR3 F4: multiple settlement cleanup failures aggregate in execution order', async (t) => {
  const observed: unknown[] = []
  const { app } = startApp((_label, error) => observed.push(error))
  const failureA = new Error('cleanup A failed')
  const failureB = new Error('cleanup B failed')
  let armedA = false
  let armedB = false
  t.mock.method(app as unknown as { clearFullscreenPointerGestures(): void }, 'clearFullscreenPointerGestures', () => {
    if (!armedA) return
    armedA = false
    throw failureA
  })
  t.mock.method(app as unknown as { projectActivity(): void }, 'projectActivity', () => {
    if (!armedB) return
    armedB = false
    throw failureB
  })

  const controller = new AbortController()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal })
  armedA = true
  armedB = true
  controller.abort()

  assert.deepEqual(await settleOutcome(decision), { kind: 'resolved', value: 'cancelled' })
  assert.equal(observed.length, 1, 'one aggregated failure reached the sink')
  const aggregate = observed[0]
  assert.ok(aggregate instanceof AggregateError, 'multiple failures surface as an AggregateError')
  assert.deepEqual(aggregate.errors, [failureA, failureB], 'failures aggregate in execution order')
  t.mock.restoreAll()
})

test('M3-6 PR3 F5: a queued question synchronously cancelled during handover is never mounted', async () => {
  const { app, vt } = startApp()
  const secondController = new AbortController()
  const first = app.askQuestions(
    [{ id: 'q1', question: 'first?', options: [{ label: 'a' }] }],
    undefined,
    { onDraftChange: () => { secondController.abort() } },
  )
  const second = app.askQuestions(
    [{ id: 'q2', question: 'second?', options: [{ label: 'a' }] }],
    secondController.signal,
  )
  await vt.waitForRender()

  // Cancel the ACTIVE first flow: its settlement runs the draft callback, which
  // synchronously aborts the queued second.
  vt.sendInput('\x1b')
  const secondOutcome = await settleOutcome(second)
  assert.equal(secondOutcome.kind, 'rejected', 'the synchronously cancelled queued question settled')
  assert.match(String((secondOutcome as { error: unknown }).error), /question flow cancelled/)
  assert.equal((await settleOutcome(first)).kind, 'rejected', 'the first flow settled too')

  // The editor seat is NOT stuck on the cancelled queued flow: a fresh question
  // is presented (if the cancelled one had been mounted, this would queue).
  const third = app.askQuestions([{ id: 'q3', question: 'third?', options: [{ label: 'a' }] }])
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('').includes('third?'),
    'a fresh question is presented after the cancelled handover')
  vt.sendInput('\x1b')
  assert.equal((await settleOutcome(third)).kind, 'rejected', 'the fresh question settles normally')
})

/* TERMINAL fail-closed case — keep LAST in this file. */
test('M3-6 PR3 F4: a settlement cleanup that throws undefined is not swallowed (fail-closed slot)', async (t) => {
  const { app } = startApp()
  let armed = false
  t.mock.method(app as unknown as { clearFullscreenPointerGestures(): void }, 'clearFullscreenPointerGestures', () => {
    if (!armed) return
    armed = false
    throw undefined
  })

  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe' })
  armed = true
  let threw = false
  try {
    app.dispose()
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'a thrown-undefined cleanup failure must not be swallowed')
  assert.deepEqual(await settleOutcome(decision), { kind: 'resolved', value: 'cancelled' },
    'the approval promise still settles')
  assert.equal(liveTuiCountForTest(), 1,
    'fail-closed: the failed final dispose keeps the process TUI slot claimed')
  t.mock.restoreAll()
})
