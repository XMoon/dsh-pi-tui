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
import { afterEach, test } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
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
      runOwned: <T>(label: string, task: () => T | Promise<T>): void => {
        void Promise.resolve().then(task).then(
          () => {},
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

test('M3-6 PR3 F6: an abort-listener settlement cleanup failure is routed to the owned sink', async (t) => {
  const observed: Array<{ label: string; error: unknown }> = []
  const { app } = startApp((label, error) => observed.push({ label, error }))
  const failure = new Error('abort settlement cleanup failed')
  let armed = false
  t.mock.method(app as unknown as { clearFullscreenPointerGestures(): void }, 'clearFullscreenPointerGestures', () => {
    if (!armed) return
    armed = false
    throw failure
  })

  const controller = new AbortController()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal })
  armed = true
  // The EventTarget dispatcher must not leak the failure to the process root.
  controller.abort()

  assert.deepEqual(await settleOutcome(decision), { kind: 'resolved', value: 'cancelled' },
    'the approval promise still settles through the abort route')
  assert.equal(observed.length, 1, 'the owned sink observed exactly one settlement failure')
  assert.equal(observed[0]!.label, 'approval abort settlement')
  assert.equal(observed[0]!.error, failure, 'the exact cleanup failure reached the sink')
  t.mock.restoreAll()
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
