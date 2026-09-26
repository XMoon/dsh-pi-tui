/**
 * A3-3 behavior locks for the scope-bound writer admission and the submission
 * runtime's terminal settlement (plan §1.3/§4.3).
 *
 * 1. `SessionRuntime.withWriter(scope, task)` admits SYNCHRONOUSLY: the scope
 *    check and the barrier occupancy happen in the same call stack, so a
 *    transition started immediately after it returns must WAIT for the writer
 *    (the no-yield invariant). A writer arriving after a transition froze is
 *    refused with the barrier's own `TransitionInProgressError` (no retry); a
 *    STALE scope is refused with the dedicated `SessionScopeSupersededError`
 *    BEFORE the task body runs — never the two conflated.
 * 2. The submission runtime turns those two refusals into their DISTINCT
 *    terminal UX (draft restore + ack): a frozen transition restores the draft,
 *    a stale capture takes the stale path, and neither runs the prompt write.
 * 3. The queue-recall state commits on a committed transition and aborts on a
 *    failed one.
 * @module @xmoon76/dsh-pi-tui/a3-writer-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  bindSessionRuntime,
  type SessionRuntimeDeps,
} from '../src/app/session/runtime.ts'
import type { SessionOwnershipCore } from '../src/app/session/ownership-core.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../src/app/session/scope.ts'
import {
  bindSubmissionRuntime,
  type PromptSubmission,
  type SubmissionRuntimeSurface,
} from '../src/app/submission/runtime.ts'
import { SessionOperationBarrier, TransitionInProgressError } from '../src/session-operation-barrier.ts'

const SCOPE = { sessionId: 's1' } as unknown as LiveSessionScope

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Bind the real session runtime over a bare barrier + a scope predicate. */
function bind(isScopeCurrent: (scope: LiveSessionScope) => boolean) {
  const barrier = new SessionOperationBarrier()
  const runtime = bindSessionRuntime(
    { barrier } as unknown as SessionOwnershipCore,
    { isScopeCurrent } as unknown as SessionRuntimeDeps,
  )
  return { runtime, barrier }
}

test('withWriter admits synchronously: a transition started right after must wait', async () => {
  const { runtime, barrier } = bind(() => true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writerInside = false
  const pending = runtime.withWriter(SCOPE, async () => {
    writerInside = true
    await gate
  })
  // The writer is occupied BEFORE the returned promise is awaited — the
  // no-yield admission. A transition started now must wait for it to drain.
  assert.equal(barrier.activeWriters, 1, 'the writer must be occupied synchronously at admission')
  let transitionDone = false
  const transition = barrier.runTransition(async () => { transitionDone = true })
  await flush()
  assert.equal(writerInside, true)
  assert.equal(transitionDone, false, 'the transition must wait for the admitted writer')
  release()
  await pending
  await transition
  assert.equal(transitionDone, true)
})

test('withWriter arriving after a transition froze keeps TransitionInProgressError (no retry)', async () => {
  const { runtime, barrier } = bind(() => true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  // Freeze the barrier SYNCHRONOUSLY (runTransition flips `frozen` before its
  // first await) and hold the transition open.
  const transition = barrier.runTransition(async () => { await gate })
  let taskRan = false
  await assert.rejects(
    runtime.withWriter(SCOPE, () => { taskRan = true }),
    (error: unknown) => error instanceof TransitionInProgressError,
  )
  assert.equal(taskRan, false, 'a frozen transition must refuse BEFORE the task body')
  release()
  await transition
})

test('withWriter on a stale scope rejects SessionScopeSupersededError and runs NO task body', async () => {
  // The scope predicate answers stale: the captured owner is gone. This is a
  // DIFFERENT signal from a frozen transition and must never be reported as one.
  const { runtime, barrier } = bind(() => false)
  let taskRan = false
  await assert.rejects(
    runtime.withWriter(SCOPE, () => { taskRan = true }),
    (error: unknown) => error instanceof SessionScopeSupersededError
      && !(error instanceof TransitionInProgressError),
  )
  assert.equal(taskRan, false, 'a stale scope must not run the task body')
  assert.equal(barrier.activeWriters, 0, 'a stale admission must not occupy the writer')
})

/** A full recording surface; overrides flip individual behaviors. */
function recordingSurface(overrides: Partial<SubmissionRuntimeSurface>): {
  surface: SubmissionRuntimeSurface
  calls: string[]
} {
  const calls: string[] = []
  const never = (): never => { throw new Error('unexpected surface call') }
  const surface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: () => { calls.push('merge'); return true },
    consumeDraftAttachments: () => { calls.push('consume') },
    markDispatch: () => { calls.push('dispatch') },
    beginLocalSubmission: () => { calls.push('echo') },
    settleLocalSubmission: () => { calls.push('settleLocal') },
    settleSubmitAck: (reason) => { calls.push(`ack:${reason}`) },
    notify: (message, kind) => { calls.push(`notify:${kind}:${message}`) },
    refuseByTransitionFence: () => { calls.push('fence') },
    prepareMessage: never,
    prompt: never,
    ...overrides,
  }
  return { surface, calls }
}

const SUBMISSION: PromptSubmission = {
  text: 'hello',
  scope: SCOPE,
  requestId: 'request-1',
  ackToken: 7,
  generation: 3,
  echoInstalled: true,
}

test('a frozen transition refuses the prompt write, restores the draft and settles its ack', async () => {
  const { surface, calls } = recordingSurface({
    withWriter: () => Promise.reject(new TransitionInProgressError()),
    withPromptAdmission: () => { throw new Error('the admission must never run') },
  })
  const runtime = bindSubmissionRuntime({ surface })
  await runtime.submitPrompt(SUBMISSION)
  assert.deepEqual(calls, [
    'settleLocal',
    'ack:submit refused by transition fence',
    'fence',
  ], 'the fence refusal settles the echo/ack and restores the draft — never a prompt write')
})

test('a stale scope refused at admission takes the distinct stale path and runs no write', async () => {
  const { surface, calls } = recordingSurface({
    withWriter: () => Promise.reject(new SessionScopeSupersededError()),
    withPromptAdmission: () => { throw new Error('the admission must never run') },
  })
  const runtime = bindSubmissionRuntime({ surface })
  await runtime.submitPrompt(SUBMISSION)
  assert.deepEqual(calls, [
    'merge',
    'settleLocal',
    'ack:submit stale',
    `notify:error:the session changed while sending — try again`,
  ], 'a stale capture takes the stale path — never the transition refusal')
})

test('a committed transition settles the queue recall; a failed one restores it', () => {
  const { surface } = recordingSurface({})
  const runtime = bindSubmissionRuntime({ surface })
  const log: string[] = []
  runtime.deferQueueRecall({ commit: () => log.push('commit'), abort: () => log.push('abort') })
  runtime.settleQueueRecalls(true)
  assert.deepEqual(log, ['commit'])
  runtime.deferQueueRecall({ commit: () => log.push('commit-2'), abort: () => log.push('abort-2') })
  runtime.settleQueueRecalls(false)
  assert.deepEqual(log, ['commit', 'abort-2'])
  // Settling with nothing parked is a no-op (a preflight failure still settles).
  runtime.settleQueueRecalls(false)
  assert.deepEqual(log, ['commit', 'abort-2'])
})

test('app/submission owns the submission domain only: no Direct module, no Host Agent', () => {
  const source = readFileSync(new URL('../src/app/submission/runtime.ts', import.meta.url), 'utf8')
  for (const forbidden of [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-session',
    'app/direct/',
    'runtime/direct/',
  ]) {
    assert.equal(source.includes(forbidden), false, `app/submission must not reach ${forbidden}`)
  }
})

test('the queue-recall state and the plain-submit write body live in app/submission', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // The concrete state and its settle body moved out; only the WHEN seam
  // (`SessionRuntimeSurface.settlePendingQueueRecalls`) remains in the runner.
  assert.equal(index.includes('const pendingQueueRecalls'), false,
    'the pendingQueueRecalls state must live in app/submission')
  assert.equal(index.includes('pendingQueueRecalls.push'), false,
    'the settle body must live in app/submission')
  // The plain-prompt write orchestration (prepare → semantic write → consume)
  // is gone from the runner: the two write sites delegate to the submission
  // runtime through `submitPrompt`.
  assert.equal((index.match(/submissionRuntime\.submitPrompt\(/g) ?? []).length, 2,
    'the command-fallback and direct prompt sites must delegate to the submission runtime')
})
