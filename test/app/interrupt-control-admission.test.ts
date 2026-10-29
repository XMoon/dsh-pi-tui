/**
 * The Busy Esc / extension `cancel-activity` entry must use the session
 * CONTROL admission, not an ordinary writer admission: while a navigation
 * transition has frozen the writer barrier and an already-admitted writer is
 * still in flight, the interrupt must still reach its captured owner and must
 * not produce a misclassified `agent interrupt` ERROR.
 *
 * The exact-owner/backend-cancel contract is proven by the session-runtime and
 * Direct/Remote owner suites; this case proves the production user-shell wiring
 * chooses the control entry and settles it silently on `committed`.
 * @module @xmoon76/dsh-pi-tui/interrupt-control-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserShell } from '../../src/app/submission/user-shell.ts'
import { SessionOperationBarrier } from '../../src/app/session/operation-barrier.ts'
import type { InterruptAgentLike } from '../../src/app/session/interrupt.ts'
import type { LiveSessionScope } from '../../src/app/session/scope.ts'
import type { TuiApp } from '../../src/tui-app.ts'

test('Busy Esc uses the control admission while a frozen transition drains a writer, without an agent interrupt ERROR', async () => {
  const barrier = new SessionOperationBarrier()
  const scope = { sessionId: 'session-a' } as unknown as LiveSessionScope
  const notices: string[] = []
  const errors: string[] = []
  let withWriterCalls = 0
  let writerCancelCalls = 0
  let interruptCalls = 0
  let markInterrupted!: () => void
  const interrupted = new Promise<void>(resolve => { markInterrupted = resolve })

  const shell = createUserShell<InterruptAgentLike>({
    app: () => ({}) as TuiApp,
    notify: (message, kind) => { notices.push(`${kind ?? 'info'}:${message}`) },
    diag: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => { errors.push(message) },
      dispose: () => {},
    },
    isCleanedUp: () => false,
    liveAgent: () => ({ session: { id: 'session-a' }, status: 'running', cancel: () => {} }),
    ownership: { generation: () => 1 },
    session: {
      withWriter: (_scope, task) => {
        withWriterCalls += 1
        return Promise.resolve().then(task)
      },
      // The production seam is SessionRuntime.interrupt; this harness routes
      // it through the REAL barrier control section so the freeze admission is
      // exercised too.
      interrupt: () => barrier.runControl(async () => {
        interruptCalls += 1
        markInterrupted()
        return { kind: 'committed' as const, value: undefined }
      }),
    },
    requireLiveScope: () => scope,
    captureLiveScope: () => scope,
    writerSection: (task) => task(),
    writer: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => {
        writerCancelCalls += 1
        return { kind: 'committed' as const, value: undefined }
      },
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    status: { sessionCwd: () => '/tmp' },
    tuiSettings: undefined,
    shell: {
      execute: async () => ({ kind: 'unavailable' as const, reason: new Error('not exercised') }),
    } as never,
    submission: { settleAck: () => {}, markDispatch: () => {} },
  })

  // A writer admitted BEFORE the navigation holds the barrier drain open; the
  // transition freezes synchronously and parks on that writer.
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  let transitionRan = false
  const writer = barrier.runWriter('session-a', async () => { await writerGate })
  const transition = barrier.runTransition(async () => { transitionRan = true })
  assert.equal(barrier.inTransition, true)
  assert.equal(barrier.activeWriters, 1)

  shell.interrupt()
  await interrupted
  assert.equal(interruptCalls, 1, 'the control interrupt reached the backend seam')
  assert.equal(withWriterCalls, 0, 'the interrupt never entered the ordinary writer admission')
  assert.equal(writerCancelCalls, 0, 'the session writer cancel is not the control path anymore')
  assert.equal(barrier.inTransition, true, 'the transition is still frozen')
  assert.equal(transitionRan, false, 'the interrupt did not shortcut the writer drain')
  assert.deepEqual(errors, [], 'a normally admitted interrupt must not emit an ERROR diagnostic')
  assert.deepEqual(notices, [], 'a committed interrupt is silent')

  releaseWriter()
  await writer
  await transition
  assert.equal(transitionRan, true, 'the transition still completes after the drain')
})
