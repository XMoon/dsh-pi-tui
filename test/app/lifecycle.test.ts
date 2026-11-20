/**
 * Headless tests for the lifecycle primitives: the exit orchestration
 * (latch once → surface cleanup → hint → appExit; idempotent, total) and
 * the detached-task entry (rejection capture, cancellation classification,
 * recoverable notify). The Direct owned-session retirement is a SEPARATE
 * step that runs inside the appExit disposal — see
 * test/runtime/direct/direct-owned-session-retirement.test.ts and the runner integration
 * tests.
 * @module @xmoon76/dsh-pi-tui/lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createExitController, daemonResumeBackendOverride, formatDaemonDetachHint } from '../../src/app/bootstrap/exit.ts'
import { createExitIntentCoordinator, type ExitIntentCoordinator, type StopCurrentWorkOutcome } from '../../src/app/bootstrap/exit-intent.ts'
import { createExitIntentFacts } from '../../src/app/bootstrap/exit-facts.ts'
import type { ExitChoiceModel, SurfaceExitChoiceSeam } from '../../src/app/surface/exit-choice.ts'
import type { LiveSessionScope, SessionScope } from '../../src/app/session/scope.ts'
import { classifyExitIntent, type ExitBackendKind, type ExitSessionActivity } from '../../src/domain/command/policy.ts'
import { cancellationError, isCancellation, runDetached, runOwned } from '../../src/runtime/process/tasks.ts'
import { createDiag, type Diag } from '../../src/runtime/process/diagnostics.ts'

/** A promise the test resolves/rejects manually, to stage in-flight races. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A diag channel whose output lands in a test-visible array. */
function captureDiag(): { diag: Diag; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    diag: createDiag({
      filePath: undefined,
      stderrLevel: 'off',
      sinks: [{ write: (line: string) => { lines.push(line) } }],
    }),
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

test('runDetached captures a rejection into diag without rethrowing', async () => {
  const { diag, lines } = captureDiag()
  runDetached('settings write', () => Promise.reject(new Error('boom')), { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /WARN settings write/)
  assert.match(lines[0]!, /error=boom/)
})

test('runDetached treats a cancellation as debug, never a warning', async () => {
  const { diag, lines } = captureDiag()
  runDetached('model load', () => Promise.reject(abortError()), { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /DEBUG model load/)
  assert.match(lines[0]!, /cancelled=true/)
  assert.ok(!lines[0]!.includes('WARN'))
})

test('runDetached notifies user-recoverable failures with the task label', async () => {
  const { diag } = captureDiag()
  const notices: string[] = []
  runDetached('settings write', () => Promise.reject(new Error('quota exceeded')), {
    diag,
    notify: (message) => notices.push(message),
    recoverable: () => true,
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(notices, ['settings write: quota exceeded'])
})

test('runDetached writes the live session id into diagnostics', async () => {
  const { diag, lines } = captureDiag()
  let session = 'session-a'
  runDetached('turn flush', () => Promise.reject(new Error('corrupt')), { diag, sessionId: () => session })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(lines[0]!, /session=session-a/)
  session = 'session-b'
  runDetached('turn flush', () => Promise.reject(new Error('corrupt')), { diag, sessionId: () => session })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(lines[1]!, /session=session-b/)
})

test('runDetached on a settling task writes nothing', async () => {
  const { diag, lines } = captureDiag()
  runDetached('history write', () => Promise.resolve(), { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 0)
})

test('runDetached classifies a synchronous factory throw like a rejection', async () => {
  const { diag, lines } = captureDiag()
  runDetached('settings write', () => {
    throw new Error('sync boom')
  }, { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /WARN settings write/)
  assert.match(lines[0]!, /error=sync boom/)
})

test('runOwned delivers the task result to onResult', async () => {
  const { diag, lines } = captureDiag()
  const results: string[] = []
  runOwned('submit', () => Promise.resolve('queued'), { diag, onResult: (result) => { results.push(result) } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(results, ['queued'])
  assert.equal(lines.length, 0, 'a resolved owned task writes no diagnostics')
})

test('runOwned routes a cancellation to onCancel and ALWAYS records debug diagnostics', async () => {
  const { diag, lines } = captureDiag()
  const cancelled: unknown[] = []
  const errors: unknown[] = []
  runOwned('local shell', () => Promise.reject(abortError()), {
    diag,
    onCancel: (error) => { cancelled.push(error) },
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(cancelled.length, 1, 'cancellation reaches onCancel')
  assert.equal(errors.length, 0, 'cancellation never reaches onError')
  assert.equal(lines.length, 1, 'the classification diagnostic is recorded before onCancel')
  assert.match(lines[0]!, /DEBUG local shell/)
  assert.match(lines[0]!, /cancelled=true/)
  assert.ok(!lines[0]!.includes('ERROR'))
  // Without onCancel the default is debug-only — never a user-level error.
  const { diag: diag2, lines: lines2 } = captureDiag()
  runOwned('model load', () => Promise.reject(abortError()), { diag: diag2 })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines2.length, 1)
  assert.match(lines2[0]!, /DEBUG model load/)
  assert.match(lines2[0]!, /cancelled=true/)
})

test('runOwned routes a real failure to onError and ALWAYS records error diagnostics', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  runOwned('session switch', () => Promise.reject(new Error('boom')), {
    diag,
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(errors.length, 1)
  assert.equal(errors[0] instanceof Error && errors[0].message, 'boom')
  assert.equal(lines.length, 1, 'the classification diagnostic is recorded before onError')
  assert.match(lines[0]!, /ERROR session switch/)
  assert.match(lines[0]!, /error=boom/)
  // Without onError, the default is ERROR diagnostics with label + session.
  const { diag: diag2, lines: lines2 } = captureDiag()
  runOwned('turn flush', () => Promise.reject(new Error('corrupt')), { diag: diag2, sessionId: () => 'session-x' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines2.length, 1)
  assert.match(lines2[0]!, /ERROR turn flush/)
  assert.match(lines2[0]!, /error=corrupt/)
  assert.match(lines2[0]!, /session=session-x/)
})

/** Run a scenario and report every unhandled rejection it produced. */
async function unhandledOf(run: () => void): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const listener = (error: unknown): void => { unhandled.push(error) }
  process.on('unhandledRejection', listener)
  try {
    run()
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', listener)
  }
  return unhandled
}

test('runOwned classifies a synchronous factory throw as a task failure', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  const unhandled = await unhandledOf(() => {
    runOwned('local command', () => {
      throw new Error('sync handler boom')
    }, { diag, onError: (error) => { errors.push(error) } })
  })
  assert.deepEqual(unhandled, [], 'a sync factory throw must never escape')
  assert.equal(errors.length, 1)
  assert.equal(errors[0] instanceof Error && errors[0].message, 'sync handler boom')
  assert.match(lines[0]!, /ERROR local command/)
})

test('runOwned classifies an async onResult failure like a task failure', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  const unhandled = await unhandledOf(() => {
    runOwned('command execution', () => Promise.resolve('ok'), {
      diag,
      async onResult() {
        throw new Error('result consumer exploded')
      },
      onError: (error) => { errors.push(error) },
    })
  })
  assert.deepEqual(unhandled, [], 'an async onResult rejection must never escape')
  assert.equal(errors.length, 1, 'the failure enters the error handling')
  assert.equal(errors[0] instanceof Error && errors[0].message, 'result consumer exploded')
  assert.match(lines[0]!, /ERROR command execution/)
})

test('runOwned routes a throwing onCancel into the handler-failure sink', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runOwned('local shell', () => Promise.reject(abortError()), {
      diag,
      onCancel() {
        throw new Error('onCancel escaped')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'a throwing onCancel must never escape')
  assert.match(lines[0]!, /DEBUG local shell/, 'the cancellation is still classified first')
  assert.match(lines[1]!, /ERROR local shell handler failed/)
  assert.match(lines[1]!, /error=onCancel escaped/)
})

test('runOwned routes a rejecting async onCancel into the handler-failure sink', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runOwned('local shell', () => Promise.reject(abortError()), {
      diag,
      async onCancel() {
        throw new Error('async onCancel escaped')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'an async onCancel rejection must never escape')
  assert.match(lines[1]!, /ERROR local shell handler failed/)
  assert.match(lines[1]!, /error=async onCancel escaped/)
})

test('runOwned routes a throwing onError into the handler-failure sink', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runOwned('steer', () => Promise.reject(new Error('task failed')), {
      diag,
      onError() {
        throw new Error('onError escaped')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'a throwing onError must never escape')
  assert.match(lines[0]!, /ERROR steer/)
  assert.match(lines[1]!, /ERROR steer handler failed/)
  assert.match(lines[1]!, /error=onError escaped/)
})

test('runOwned routes a rejecting async onError into the handler-failure sink', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runOwned('steer', () => Promise.reject(new Error('task failed')), {
      diag,
      async onError() {
        throw new Error('async onError escaped')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'an async onError rejection must never escape')
  assert.match(lines[1]!, /ERROR steer handler failed/)
  assert.match(lines[1]!, /error=async onError escaped/)
})

test('runOwned runs onError EXACTLY ONCE when it throws a primitive', async () => {
  const { diag, lines } = captureDiag()
  let errors = 0
  const unhandled = await unhandledOf(() => {
    runOwned('primitive-handler', () => Promise.reject(new Error('task failed')), {
      diag,
      onError() {
        errors += 1
        throw 'primitive boom' // JS allows throwing any value
      },
    })
  })
  assert.deepEqual(unhandled, [], 'a primitive handler throw must never escape')
  assert.equal(errors, 1, 'onError must run exactly once (a primitive is never re-classified)')
  assert.match(lines[0]!, /ERROR primitive-handler/)
  assert.match(lines[0]!, /error=task failed/)
  assert.equal(lines.length, 2, 'exactly one primary ERROR + one handler-failed line')
  assert.match(lines[1]!, /ERROR primitive-handler handler failed/)
  assert.match(lines[1]!, /error=primitive boom/, 'the original primitive survives in the sink')
})

test('runOwned runs onCancel EXACTLY ONCE when it throws null', async () => {
  const { diag, lines } = captureDiag()
  let cancels = 0
  const unhandled = await unhandledOf(() => {
    runOwned('null-handler', () => Promise.reject(abortError()), {
      diag,
      onCancel() {
        cancels += 1
        throw null
      },
    })
  })
  assert.deepEqual(unhandled, [])
  assert.equal(cancels, 1, 'onCancel must run exactly once')
  assert.match(lines[0]!, /DEBUG null-handler/)
  assert.equal(lines.length, 2, 'one debug + one handler-failed line')
  assert.match(lines[1]!, /ERROR null-handler handler failed/)
  assert.match(lines[1]!, /error=null/)
})

test('runOwned preserves a FROZEN onError throw: original message, no marker TypeError', async () => {
  const { diag, lines } = captureDiag()
  let errors = 0
  const unhandled = await unhandledOf(() => {
    runOwned('frozen-handler', () => Promise.reject(new Error('task failed')), {
      diag,
      onError() {
        errors += 1
        throw Object.freeze(new Error('frozen boom'))
      },
    })
  })
  assert.deepEqual(unhandled, [])
  assert.equal(errors, 1, 'onError must run exactly once')
  assert.equal(lines.length, 2, 'no re-classification, no marker TypeError line')
  assert.match(lines[0]!, /error=task failed/)
  assert.match(lines[1]!, /ERROR frozen-handler handler failed/)
  assert.match(lines[1]!, /error=frozen boom/, 'the frozen error message survives intact')
  assert.ok(!lines[1]!.includes('not extensible'), 'marking must never touch the thrown value')
})

test('runOwned keeps an async non-extensible onError rejection in the sink, once', async () => {
  const { diag, lines } = captureDiag()
  let errors = 0
  const unhandled = await unhandledOf(() => {
    runOwned('sealed-handler', () => Promise.reject(new Error('task failed')), {
      diag,
      async onError() {
        errors += 1
        throw Object.preventExtensions(new Error('sealed boom'))
      },
    })
  })
  assert.deepEqual(unhandled, [])
  assert.equal(errors, 1)
  assert.equal(lines.length, 2)
  assert.match(lines[1]!, /error=sealed boom/)
})

test('runOwned routes a PRIMITIVE classifier throw straight to the handler-failure sink', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  const unhandled = await unhandledOf(() => {
    runOwned('model info', () => Promise.reject(new Error('provider exploded')), {
      diag,
      isCancellation: () => {
        throw 'classifier primitive boom'
      },
      onError: (error) => { errors.push(error) },
    })
  })
  assert.deepEqual(unhandled, [])
  assert.deepEqual(errors, [], 'the original task failure must not be re-classified into onError')
  assert.match(lines[0]!, /ERROR model info handler failed/)
  assert.match(lines[0]!, /error=classifier primitive boom/)
})

test('runOwned classifies an onResult AbortError as a PRIMARY failure, never a cancellation', async () => {
  const { diag, lines } = captureDiag()
  const cancels: unknown[] = []
  const errors: unknown[] = []
  runOwned('result-abort-shape', () => Promise.resolve('ok'), {
    diag,
    onResult: () => {
      throw cancellationError('consumer abort-shaped bug')
    },
    onError: (error) => { errors.push(error) },
    onCancel: (error) => { cancels.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(cancels, [], 'a result-consumer failure is never a cancellation')
  assert.equal(errors.length, 1)
  assert.match(lines[0]!, /ERROR result-abort-shape/)
  assert.match(lines[0]!, /error=consumer abort-shaped bug/)
})

test('runOwned keeps an async onResult ABORT_ERR rejection a failure too', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  runOwned('result-abort-async', () => Promise.resolve('ok'), {
    diag,
    onResult: async () => {
      const coded = new Error('late abort') as Error & { code: string }
      coded.code = 'ABORT_ERR'
      throw coded
    },
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(errors.length, 1)
  assert.match(lines[0]!, /ERROR result-abort-async/)
  assert.match(lines[0]!, /error=late abort/)
})

test('runOwned reads the live session id at settle time, not a captured value', async () => {
  const { diag, lines } = captureDiag()
  let session: string | undefined = 'session-before'
  const gate = deferred<string>()
  runOwned('submit', () => gate.promise, { diag, sessionId: () => session })
  session = 'session-after' // the switch happens while the task is in flight
  gate.reject(new Error('late failure'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(lines[0]!, /session=session-after/)
})

test('runOwned runs the factory exactly once and settles exactly one terminal callback', async () => {
  const { diag } = captureDiag()
  let factoryCalls = 0
  const events: string[] = []
  runOwned('steer', () => {
    factoryCalls += 1
    return Promise.resolve('queued')
  }, {
    diag,
    onResult: (result) => { events.push(`result:${result}`) },
    onError: () => { events.push('error') },
    onCancel: () => { events.push('cancel') },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(factoryCalls, 1, 'the factory runs exactly once')
  assert.deepEqual(events, ['result:queued'], 'exactly one terminal callback fires')
})

test('runOwned starts the factory SYNCHRONOUSLY, before the helper returns', async () => {
  // Ownership actions inside the factory (Ctrl+G's stop(), a latch) must
  // take effect in the SAME call stack: two calls in one input batch must
  // not both start. A sync throw is still captured, never an escape.
  const { diag } = captureDiag()
  let started = false
  let syncThrowCaught = false
  runOwned('external editor', () => {
    started = true
    return Promise.resolve(undefined)
  }, { diag })
  assert.equal(started, true, 'the factory must run before runOwned returns')
  runOwned('local command', () => {
    throw new Error('sync boom')
  }, {
    diag,
    onError: () => { syncThrowCaught = true },
  })
  assert.equal(syncThrowCaught, false, 'the rejection settles asynchronously')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(syncThrowCaught, true, 'a sync factory throw still reaches onError')
})

test('runOwned NEVER applies the task-local classifier to an onResult failure', async () => {
  // The task resolves; onResult flips the task-local cancellation state
  // (disposed/aborted) and THEN throws. The predicate describes the TASK's
  // own state — the task already settled — so this is a real result-
  // consumer failure: ERROR + onError, never DEBUG + onCancel.
  const { diag, lines } = captureDiag()
  let disposed = false
  const cancelled: unknown[] = []
  const errors: unknown[] = []
  runOwned('phase probe', () => Promise.resolve('ok'), {
    diag,
    isCancellation: () => disposed,
    onResult: () => {
      disposed = true
      throw new Error('consumer bug')
    },
    onCancel: (error) => { cancelled.push(error) },
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(cancelled, [], 'an onResult failure must never be classified as a cancellation')
  assert.equal(errors.length, 1)
  assert.equal(errors[0] instanceof Error && errors[0].message, 'consumer bug')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /ERROR phase probe/)
  assert.match(lines[0]!, /error=consumer bug/)
})

test('runOwned keeps an async onResult rejection a failure even after the state flips', async () => {
  const { diag, lines } = captureDiag()
  let aborted = false
  const cancelled: unknown[] = []
  const errors: unknown[] = []
  runOwned('local shell', () => Promise.resolve('done'), {
    diag,
    isCancellation: () => aborted,
    onResult: async () => {
      aborted = true // the signal flips while the consumer is mid-flight
      throw new Error('result handling exploded')
    },
    onCancel: (error) => { cancelled.push(error) },
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(cancelled, [])
  assert.equal(errors.length, 1)
  assert.match(lines[0]!, /ERROR local shell/)
  assert.match(lines[0]!, /error=result handling exploded/)
})

test('runOwned classifies a task-local cancellation BEFORE writing diagnostics', async () => {
  // A plain Error that the task knows is its own cancellation (an aborted
  // signal, a disposed latch): debug + onCancel, NO error line.
  const { diag, lines } = captureDiag()
  const cancelled: unknown[] = []
  const errors: unknown[] = []
  runOwned('local shell', () => Promise.reject(new Error('signal killed')), {
    diag,
    isCancellation: () => true,
    onCancel: (error) => { cancelled.push(error) },
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(cancelled.length, 1, 'task-local cancellation reaches onCancel')
  assert.equal(errors.length, 0, 'task-local cancellation never reaches onError')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /DEBUG local shell/)
  assert.match(lines[0]!, /cancelled=true/)
  assert.ok(!lines[0]!.includes('ERROR'), 'a task-local cancellation must not be an error')
})

test('runOwned keeps a failure an ERROR when the task-local classifier says no', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  runOwned('local shell', () => Promise.reject(new Error('real failure')), {
    diag,
    isCancellation: () => false, // the signal was NOT aborted
    onError: (error) => { errors.push(error) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(errors.length, 1)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /ERROR local shell/)
  assert.match(lines[0]!, /error=real failure/)
})

test('runOwned routes a throwing task-local classifier into the handler-failure sink', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runOwned('model info', () => Promise.reject(new Error('provider exploded')), {
      diag,
      isCancellation: () => {
        throw new Error('classifier exploded')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'a throwing classifier must never escape')
  assert.match(lines[0]!, /ERROR model info handler failed/)
  assert.match(lines[0]!, /error=classifier exploded/)
})

test('cancellationError builds an error the classifier recognizes', () => {
  const error = cancellationError('question flow cancelled')
  assert.equal(isCancellation(error), true)
  assert.equal(error.message, 'question flow cancelled')
})

// --- hostile thrown values: the final sink must be a TOTAL function over
// the `unknown` domain (zero unhandled rejections for ANY legal value) ---

/** An object whose stringification throws (a legal thrown value). */
function hostileString(label: string): object {
  return {
    toString() {
      throw new Error(label)
    },
  }
}

/** A Proxy whose prototype-chain walk throws (breaks `instanceof`). */
function hostileProxy(label: string): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw new Error(label)
    },
  })
}

test('runOwned: onError throwing a hostile toString object is exactly-once with zero unhandled', async () => {
  const { diag, lines } = captureDiag()
  let errors = 0
  const unhandled = await unhandledOf(() => {
    runOwned('owned-string', () => Promise.reject(new Error('task failed')), {
      diag,
      onError() {
        errors += 1
        throw hostileString('owned stringify exploded')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'the final sink must never leak a rejection')
  assert.equal(errors, 1, 'onError runs exactly once')
  assert.match(lines[0]!, /ERROR owned-string/)
  assert.match(lines[0]!, /error=task failed/)
  assert.equal(lines.length, 2)
  assert.match(lines[1]!, /ERROR owned-string handler failed/)
  assert.match(lines[1]!, /error=<unprintable error>/, 'the fallback is a fixed constant, never the payload')
})

test('runOwned: onError throwing a getPrototypeOf-hostile Proxy is exactly-once with zero unhandled', async () => {
  const { diag, lines } = captureDiag()
  let errors = 0
  const unhandled = await unhandledOf(() => {
    runOwned('owned-proxy', () => Promise.reject(new Error('task failed')), {
      diag,
      onError() {
        errors += 1
        throw hostileProxy('owned proxy exploded')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'a Proxy that breaks instanceof must not escape')
  assert.equal(errors, 1)
  assert.equal(lines.length, 2)
  assert.match(lines[1]!, /ERROR owned-proxy handler failed/)
  assert.match(lines[1]!, /error=<unprintable error>/)
})

test('runDetached: a hostile notify throw lands in the total sink with zero unhandled', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runDetached('detached-string', () => Promise.reject(new Error('task failed')), {
      diag,
      recoverable: () => true,
      notify: () => {
        throw hostileString('detached stringify exploded')
      },
    })
  })
  assert.deepEqual(unhandled, [])
  assert.match(lines[0]!, /WARN detached-string/)
  assert.match(lines[0]!, /error=task failed/)
  assert.match(lines[1]!, /ERROR detached-string handler failed/)
  assert.match(lines[1]!, /error=<unprintable error>/, 'detached must keep its handler-failed diagnostic too')
})

test('runOwned: a hostile task rejection still reaches exactly one failure terminal', async () => {
  const { diag, lines } = captureDiag()
  const errors: unknown[] = []
  const unhandled = await unhandledOf(() => {
    runOwned('hostile-task', () => Promise.reject(hostileProxy('task proxy exploded')), {
      diag,
      onError: (error) => { errors.push(error) },
    })
  })
  assert.deepEqual(unhandled, [], 'observing the hostile rejection must not mint a new error')
  assert.equal(errors.length, 1, 'the failure terminal runs exactly once')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /ERROR hostile-task/)
  assert.match(lines[0]!, /error=<unprintable error>/, 'the original phase is never overwritten by an introspection error')
})

test('runOwned: onResult throwing a hostile Proxy is not reclassified and not repeated', async () => {
  const { diag, lines } = captureDiag()
  let errors = 0
  const unhandled = await unhandledOf(() => {
    runOwned('result-proxy', () => Promise.resolve('ok'), {
      diag,
      onResult: () => {
        throw hostileProxy('result proxy exploded')
      },
      onError: () => { errors += 1 },
    })
  })
  assert.deepEqual(unhandled, [])
  assert.equal(errors, 1, 'onError runs exactly once for the result-consumer failure')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /ERROR result-proxy/)
  assert.match(lines[0]!, /error=<unprintable error>/)
})

test('runOwned: an Error with a throwing message getter uses the fixed fallback', async () => {
  const { diag, lines } = captureDiag()
  const tricky = new Error('hidden') as Error & { message: string }
  Object.defineProperty(tricky, 'message', {
    get() {
      throw new Error('message getter exploded')
    },
  })
  const unhandled = await unhandledOf(() => {
    runOwned('message-getter', () => Promise.reject(tricky), {
      diag,
    })
  })
  assert.deepEqual(unhandled, [])
  assert.match(lines[0]!, /ERROR message-getter/)
  assert.match(lines[0]!, /error=<error with unreadable message>/)
})

test('runOwned: a throwing Symbol.toPrimitive cannot escape even when toString is fine', async () => {
  const { diag, lines } = captureDiag()
  const coercive = {
    toString() { return 'fine' },
    [Symbol.toPrimitive]() {
      throw new Error('toPrimitive exploded')
    },
  }
  const unhandled = await unhandledOf(() => {
    runOwned('to-primitive', () => Promise.reject(coercive), {
      diag,
    })
  })
  assert.deepEqual(unhandled, [])
  assert.match(lines[0]!, /ERROR to-primitive/)
  assert.match(lines[0]!, /error=<unprintable error>/)
})

test('runOwned: a throwing sessionId and a throwing diag still end in the total sink', async () => {
  const { diag, lines } = captureDiag()
  const unhandled = await unhandledOf(() => {
    runOwned('hostile-diag', () => Promise.reject(new Error('task failed')), {
      diag,
      sessionId: () => {
        throw new Error('session getter exploded')
      },
      onError() {
        throw Object.freeze(new Error('handler boom'))
      },
    })
  })
  assert.deepEqual(unhandled, [], 'neither sessionId nor the handler may leak a rejection')
  assert.ok(lines.length >= 1, 'some diagnostic is still recorded')
  assert.match(lines[lines.length - 1]!, /ERROR hostile-diag handler failed/)
  assert.match(lines[lines.length - 1]!, /error=handler boom/)
})

test('runOwned: a diag channel that throws everywhere still yields zero unhandled', async () => {
  // The final sink's ENTIRE body is protected — including the diag call
  // itself: a throwing diagnostics channel cannot leak a rejection either.
  const throwingDiag = {
    debug: () => { throw new Error('diag exploded') },
    info: () => { throw new Error('diag exploded') },
    warn: () => { throw new Error('diag exploded') },
    error: () => { throw new Error('diag exploded') },
    dispose: () => {},
  } as unknown as Diag
  const unhandled = await unhandledOf(() => {
    runOwned('throwing-diag', () => Promise.reject(new Error('task failed')), {
      diag: throwingDiag,
      onError() {
        throw new Error('handler boom')
      },
    })
  })
  assert.deepEqual(unhandled, [], 'a throwing diag must never leak a rejection')
})

test('isCancellation recognizes AbortError name and ABORT_ERR code', () => {
  assert.equal(isCancellation(abortError()), true)
  const coded = new Error('aborted') as Error & { code: string }
  coded.code = 'ABORT_ERR'
  assert.equal(isCancellation(coded), true)
  assert.equal(isCancellation(new Error('disk full')), false)
  assert.equal(isCancellation('plain string'), false)
})

// --- createExitController: the ONE exit orchestration (Ctrl+C/D, /exit, /quit) ---

/** A controller harness recording every side effect IN ORDER; `exit`
 * resolves the returned promise so tests await the orchestration's completion.
 * `prepareRetirement` is optional so the "no hook registered" contract stays
 * covered too. */
function exitHarness(options: {
  resumeHint?: () => string | undefined
  prepareRetirement?: () => void
  /** M6 UX PR2: the ONE admin stop result, or a thrown error. */
  adminStop?: () => Promise<{ code: number; stdout: string; stderr: string }>
} = {}) {
  const { diag, lines } = captureDiag()
  const calls = {
    cleanup: 0,
    prepare: 0,
    adminStop: 0,
    hints: [] as string[],
    exits: [] as number[],
    order: [] as string[],
  }
  let resolveExit!: (code: number) => void
  const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
  const { requestExit } = createExitController({
    diag,
    cleanup: () => { calls.cleanup += 1; calls.order.push('cleanup') },
    ...options.prepareRetirement === undefined ? {} : {
      prepareRetirement: () => { calls.prepare += 1; calls.order.push('prepare'); options.prepareRetirement?.() },
    },
    hint: (message) => { calls.hints.push(message); calls.order.push('hint') },
    resumeHint: options.resumeHint ?? (() => 'dsh --profile pi-tui --session session-exit'),
    exit: (code) => { calls.exits.push(code); calls.order.push('exit'); resolveExit(code) },
    ...(options.adminStop === undefined ? {} : {
      adminStop: async () => {
        calls.adminStop += 1
        calls.order.push('adminStop')
        return await options.adminStop!()
      },
    }),
  })
  return { requestExit, calls, exitDone, lines }
}

test('exit cleans up, prepares retirement, hints, and exits once — in that order', async () => {
  const { requestExit, calls, exitDone, lines } = exitHarness({ prepareRetirement: () => {} })
  requestExit()
  assert.equal(await exitDone, 0)
  assert.equal(calls.cleanup, 1)
  assert.equal(calls.prepare, 1)
  assert.deepEqual(calls.exits, [0])
  assert.deepEqual(calls.hints, ['dsh --profile pi-tui --session session-exit'])
  assert.deepEqual(calls.order, ['cleanup', 'prepare', 'hint', 'exit'],
    'the synchronous retirement preparation must sit between the surface cleanup and the resume hint')
  assert.match(lines.join('\n'), /exit/)
})

test('exit without a preparation hook still cleans up, hints, and exits', async () => {
  const { requestExit, calls, exitDone } = exitHarness()
  requestExit()
  assert.equal(await exitDone, 0)
  assert.deepEqual(calls.order, ['cleanup', 'hint', 'exit'])
})

test('exit is idempotent: later requests while in flight or after are no-ops', async () => {
  const { requestExit, calls, exitDone } = exitHarness({ prepareRetirement: () => {} })
  requestExit()
  requestExit() // in-flight: must be a no-op
  assert.equal(await exitDone, 0)
  requestExit() // after completion: must be a no-op
  assert.equal(calls.cleanup, 1, 'a second request must not clean up again')
  assert.equal(calls.prepare, 1, 'a second request must not prepare retirement again')
  assert.deepEqual(calls.exits, [0], 'a second request must not exit again')
})

test('exit without a resume hint prints none', async () => {
  const { requestExit, calls, exitDone } = exitHarness({ resumeHint: () => undefined })
  requestExit()
  assert.equal(await exitDone, 0)
  assert.deepEqual(calls.hints, [])
})

// --- lifecycle-root hostile inputs: exit must stay total ---

test('exit: throwing cleanup/hint cannot skip the exit, zero unhandled', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    const { diag } = captureDiag()
    const calls = { cleanup: 0, prepare: 0, exits: [] as number[] }
    let resolveExit!: (code: number) => void
    const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
    createExitController({
      diag,
      cleanup: () => { calls.cleanup += 1; throw new Error('cleanup exploded') },
      prepareRetirement: () => { calls.prepare += 1 },
      hint: () => { throw new Error('hint exploded') },
      resumeHint: () => 'resume',
      exit: (code) => { calls.exits.push(code); resolveExit(code) },
    }).requestExit()
    assert.equal(await exitDone, 0, 'a throwing cleanup is not an orchestration failure: exit 0')
    assert.equal(calls.cleanup, 1, 'cleanup still runs (and its throw is consumed)')
    assert.equal(calls.prepare, 1, 'a throwing cleanup must not skip the retirement preparation')
    assert.deepEqual(calls.exits, [0], 'a throwing hint/cleanup must never skip the exit')
    assert.deepEqual(unhandled, [], 'no step may leak a rejection')
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('exit: a throwing retirement preparation is recorded and never blocks appExit', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    const { diag, lines } = captureDiag()
    const calls = { prepare: 0, hints: [] as string[], exits: [] as number[] }
    let resolveExit!: (code: number) => void
    const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
    createExitController({
      diag,
      cleanup: () => {},
      prepareRetirement: () => { calls.prepare += 1; throw new Error('cancel exploded') },
      hint: (message) => { calls.hints.push(message) },
      resumeHint: () => 'resume',
      exit: (code) => { calls.exits.push(code); resolveExit(code) },
    }).requestExit()
    assert.equal(await exitDone, 0, 'a failed preparation still exits 0')
    assert.equal(calls.prepare, 1)
    assert.deepEqual(calls.hints, ['resume'], 'the hint must still run')
    assert.deepEqual(calls.exits, [0], 'exit must run exactly once')
    assert.match(lines.join('\n'), /retirement preparation failed/,
      'the failed preparation must be recorded for diagnostics')
    assert.deepEqual(unhandled, [], 'no step may leak a rejection')
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('exit: cleanup AND preparation throwing still exits exactly once', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    const { diag, lines } = captureDiag()
    const exits: number[] = []
    let resolveExit!: (code: number) => void
    const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
    createExitController({
      diag,
      cleanup: () => { throw new Error('cleanup exploded') },
      prepareRetirement: () => { throw new Error('prepare exploded') },
      hint: () => {},
      resumeHint: () => undefined,
      exit: (code) => { exits.push(code); resolveExit(code) },
    }).requestExit()
    assert.equal(await exitDone, 0)
    assert.deepEqual(exits, [0], 'exit runs exactly once')
    assert.match(lines.join('\n'), /cleanup failed/)
    assert.match(lines.join('\n'), /retirement preparation failed/)
    assert.deepEqual(unhandled, [], 'no step may leak a rejection')
  } finally {
    process.off('unhandledRejection', listener)
  }
})

// --- M6 UX PR1: the ONE exit-intent coordinator (Direct/daemon x idle/working/unknown) ---

/** A stand-in captured scope: the coordinator only passes it back to the
 *  injected currentness read, so the branded value is never inspected here. */
function exitScope(sessionId = 'session-a'): LiveSessionScope {
  return { sessionId } as unknown as LiveSessionScope
}

interface ExitIntentHarness {
  readonly coordinator: ExitIntentCoordinator
  readonly commits: Array<{ workStopped: boolean; hostStopRequested?: boolean }>
  readonly opens: ExitChoiceModel[]
  readonly updates: ExitChoiceModel[]
  /** Every created model (open + update) in creation order. */
  readonly models: ExitChoiceModel[]
  readonly stopCalls: Array<{ readonly scope: LiveSessionScope; readonly signal: AbortSignal }>
  /** The runner diagnostics lines the owned task recorded. */
  readonly diagLines: string[]
  readonly state: {
    backend: ExitBackendKind
    activity: ExitSessionActivity
    /** The live projection; undefined models a sessionless surface. */
    live: LiveSessionScope | undefined
    /** A Client-owned user shell is running. */
    shell: boolean
    scopeCurrent: boolean
    mounted: boolean
    /** M6 UX PR2: the transient daemon→direct conversion intent. */
    hostStopEligible: boolean
    /** A reentrant hook run from the presenter's close (focus restoration). */
    onClose: (() => void) | undefined
    /** Optional presenter failure injection (phase: 'open' | 'update' | 'close'). */
    presenterFault: ((phase: 'open' | 'update' | 'close') => void) | undefined
    stop: (signal: AbortSignal) => Promise<StopCurrentWorkOutcome>
  }
  closed(): number
  current(): ExitChoiceModel | undefined
  dispose(): void
}

/** A stand-in SESSIONLESS scope: a real identity with no Session id. */
function sessionlessScope(): SessionScope {
  return { sessionId: undefined } as unknown as SessionScope
}

function exitIntentHarness(options: {
  readonly backend?: ExitBackendKind
  readonly activity?: ExitSessionActivity
  /** Explicit live projection; `undefined` (with `sessionless`) models no Session. */
  readonly live?: LiveSessionScope | undefined
  readonly sessionless?: boolean
  readonly scopeCurrent?: boolean
  readonly mounted?: boolean
  readonly stop?: (signal: AbortSignal) => Promise<StopCurrentWorkOutcome>
  readonly hostStopEligible?: boolean
} = {}): ExitIntentHarness {
  let closes = 0
  let currentModel: ExitChoiceModel | undefined
  let disposed = false
  const commits: Array<{ workStopped: boolean; hostStopRequested?: boolean }> = []
  const opens: ExitChoiceModel[] = []
  const updates: ExitChoiceModel[] = []
  const models: ExitChoiceModel[] = []
  const stopCalls: Array<{ readonly scope: LiveSessionScope; readonly signal: AbortSignal }> = []
  const state: ExitIntentHarness['state'] = {
    backend: options.backend ?? 'daemon',
    activity: options.activity ?? 'idle',
    live: options.sessionless === true ? undefined : (options.live ?? exitScope()),
    shell: false,
    scopeCurrent: options.scopeCurrent ?? true,
    mounted: options.mounted ?? true,
    hostStopEligible: options.hostStopEligible ?? false,
    onClose: undefined,
    presenterFault: undefined,
    stop: options.stop ?? (async () => ({ kind: 'stopped' })),
  }
  const seam: SurfaceExitChoiceSeam = {
    open: (model) => {
      state.presenterFault?.('open')
      currentModel = model
      opens.push(model)
      models.push(model)
    },
    update: (model) => {
      state.presenterFault?.('update')
      currentModel = model
      updates.push(model)
      models.push(model)
    },
    close: () => {
      currentModel = undefined
      closes += 1
      state.onClose?.()
      state.presenterFault?.('close')
    },
  }
  const diagLines: string[] = []
  const diag = createDiag({
    filePath: undefined,
    stderrLevel: 'off',
    sinks: [{ write: (line: string) => { diagLines.push(line) } }],
  })
  const coordinator = createExitIntentCoordinator({
    diag,
    facts: {
      currentBackend: () => state.backend,
      capture: () => ({
        scope: state.live ?? sessionlessScope(),
        live: state.live,
        activity: state.activity,
        shellRunning: state.shell,
      }),
      isScopeCurrent: () => state.scopeCurrent,
      hostStopEligible: () => state.hostStopEligible === true,
    },
    commit: (options) => { commits.push(options) },
    presenter: () => state.mounted ? seam : undefined,
    stopCurrentWork: (scope, signal) => {
      stopCalls.push({ scope, signal })
      return state.stop(signal)
    },
  })
  return {
    coordinator,
    commits,
    opens,
    updates,
    models,
    stopCalls,
    diagLines,
    state,
    closed: () => closes,
    current: () => currentModel,
    dispose: () => {
      if (disposed) return
      disposed = true
      coordinator.dispose()
    },
  }
}

test('exit intent: a proven idle daemon Client detaches immediately with no choice', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle' })
  h.coordinator.request('slash')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'the existing exit controller is the only commit')
  assert.equal(h.opens.length, 0, 'an idle daemon exit never opens a choice')
  assert.equal(h.stopCalls.length, 0, 'an idle detach sends no Host cancel')
})

test('exit intent: a proven idle Direct session exits immediately with no choice', () => {
  const h = exitIntentHarness({ backend: 'direct', activity: 'idle' })
  h.coordinator.request('plain')
  assert.deepEqual(h.commits, [{ workStopped: false }])
  assert.equal(h.opens.length, 0)
})

test('exit intent: a sessionless surface exits/detaches immediately', () => {
  for (const backend of ['direct', 'daemon'] as const) {
    const h = exitIntentHarness({ backend, activity: 'idle', sessionless: true })
    h.coordinator.request('keyboard')
    assert.deepEqual(h.commits, [{ workStopped: false }], `${backend}: sessionless exit is immediate`)
    assert.equal(h.opens.length, 0)
  }
})

test('exit intent: a sessionless surface with an open admission is unknown, not idle', () => {
  const h = exitIntentHarness({ backend: 'direct', activity: 'working', sessionless: true })
  h.coordinator.request('slash')
  assert.equal(h.opens.length, 1, 'a pending admission without a Session fails safe')
  assert.equal(h.commits.length, 0)
  assert.equal(h.current()?.kind, 'direct-unknown')
})

test('daemon busy: the default Keep detaches with zero Host writes; Stay commits nothing', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  const model = h.opens[0]!
  assert.equal(model.kind, 'daemon-busy')
  assert.deepEqual(model.options.map(option => option.id), ['keep-and-disconnect', 'stop-and-disconnect', 'stay'])
  assert.equal(model.focus, 'keep-and-disconnect', 'Keep is the safe default')
  h.current()!.select('keep-and-disconnect')
  assert.deepEqual(h.commits, [{ workStopped: false }])
  assert.equal(h.stopCalls.length, 0, 'Keep never sends a Host cancel')

  const stay = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  stay.coordinator.request('keyboard')
  stay.current()!.select('stay')
  assert.deepEqual(stay.commits, [], 'Stay performs zero Host writes and zero exit')
  assert.equal(stay.closed(), 1, 'Stay closes the one choice')
})

test('daemon busy: Stop sends exactly one cancel and exits only after the same-owner idle proof', async () => {
  const idle = deferred<StopCurrentWorkOutcome>()
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working', stop: () => idle.promise })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  assert.equal(h.updates[0]?.phase, 'stopping', 'the same seat states the in-flight stop')
  assert.equal(h.current()?.phase, 'stopping')
  assert.equal(h.stopCalls.length, 1, 'one official cancel is dispatched')
  // A second confirmation during the wait must not dispatch another cancel.
  h.current()!.select('stop-and-disconnect')
  assert.equal(h.stopCalls.length, 1)
  assert.deepEqual(h.commits, [], 'the Client must not exit before the idle proof')
  idle.resolve({ kind: 'stopped' })
  await idle.promise
  // Let the coordinator's continuation run.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.commits, [{ workStopped: true }], 'the verified stop commits exactly once')
})

test('daemon busy: an unconfirmable stop keeps Keep/Stay, never auto-detaches or claims stopped', async () => {
  const h = exitIntentHarness({
    backend: 'daemon',
    activity: 'working',
    stop: async () => ({ kind: 'unconfirmed', detail: 'the daemon refused the stop' }),
  })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  const model = h.current()!
  assert.equal(model.phase, 'unconfirmed')
  assert.deepEqual(model.options.map(option => option.id), ['disconnect-without-stop', 'stay'])
  assert.equal(model.status, 'the daemon refused the stop', 'a proven refusal is stated')
  assert.deepEqual(h.commits, [], 'no exit and no stopper claim on an unconfirmed stop')
  h.current()!.select('disconnect-without-stop')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'the user can still choose a truthful detach')
})

test('daemon busy: a stale captured scope retires the choice with zero side effects', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.scopeCurrent = false
  h.current()!.select('stop-and-disconnect')
  assert.deepEqual(h.commits, [])
  assert.equal(h.stopCalls.length, 0, 'a stale choice can never cancel a newer owner')
  assert.equal(h.closed(), 1)
})

test('daemon busy: a Stop confirmed after the owner became idle never sends a cancel', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.activity = 'idle'
  h.current()!.select('stop-and-disconnect')
  assert.deepEqual(h.commits, [{ workStopped: true }], 'the same identity is proven idle')
  assert.equal(h.stopCalls.length, 0, 'no redundant cancel is sent')
})

test('daemon busy: an unobservable state at confirm retires the choice instead of stopping', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.activity = 'unknown'
  h.current()!.select('stop-and-disconnect')
  assert.deepEqual(h.commits, [])
  assert.equal(h.stopCalls.length, 0)
  assert.equal(h.closed(), 1)
})

test('daemon unknown: only the truthful disconnect/stay options exist (no Stop)', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'unknown' })
  h.coordinator.request('plain')
  const model = h.opens[0]!
  assert.equal(model.kind, 'daemon-unknown')
  assert.deepEqual(model.options.map(option => option.id), ['disconnect-without-stop', 'stay'])
  assert.equal(model.focus, 'disconnect-without-stop')
})

test('direct busy: Stay is the default; Stop+Exit is one explicit choice', () => {
  const h = exitIntentHarness({ backend: 'direct', activity: 'working' })
  h.coordinator.request('slash')
  const model = h.opens[0]!
  assert.equal(model.kind, 'direct-busy')
  assert.deepEqual(model.options.map(option => option.id), ['stop-and-exit', 'stay'])
  assert.equal(model.focus, 'stay', 'the destructive Direct action is never the default')
  h.current()!.select('stop-and-exit')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'the existing Direct controller owns the retirement')
  assert.equal(h.stopCalls.length, 0, 'the Direct path never uses the daemon cancel operation')
})

test('direct unknown: two options, Stay default, no idle or stopped claim', () => {
  const h = exitIntentHarness({ backend: 'direct', activity: 'unknown' })
  h.coordinator.request('keyboard')
  const model = h.opens[0]!
  assert.equal(model.kind, 'direct-unknown')
  assert.deepEqual(model.options.map(option => option.id), ['exit-local', 'stay'])
  assert.equal(model.focus, 'stay')
  h.current()!.select('exit-local')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'never claims the work stopped')
})

test('exit intent: repeated requests never stack a second choice', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.coordinator.request('keyboard')
  h.coordinator.request('plain')
  assert.equal(h.opens.length, 1, 'exactly one Client-local choice exists')
})

test('exit intent: no mounted surface fails closed (no exit, no write)', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working', mounted: false })
  h.coordinator.request('slash')
  assert.deepEqual(h.commits, [], 'an unavailable choice surface never degrades to an exit')
  assert.equal(h.opens.length, 0)
})

test('exit intent: dispose aborts an in-flight Stop wait and never commits afterwards', async () => {
  let seen: AbortSignal | undefined
  const h = exitIntentHarness({
    backend: 'daemon',
    activity: 'working',
    stop: signal => new Promise(resolve => {
      seen = signal
      signal.addEventListener('abort', () => resolve({ kind: 'unconfirmed', detail: 'aborted' }), { once: true })
    }),
  })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  h.dispose()
  assert.equal(seen?.aborted, true, 'the wait is aborted with the surface')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.commits, [], 'a disposed coordinator never exits')
})

test('exit intent: a host modal withdrawal (dismiss) performs zero business action', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.current()!.dismiss()
  assert.deepEqual(h.commits, [], 'preemption is not a Stay/Keep/Stop decision')
  assert.equal(h.stopCalls.length, 0)
})

// --- M6 UX PR1: the fixed daemon detach hint ---

test('daemon detach hint: fixed block, real profile/session, no unobservable Host claim', () => {
  const hint = formatDaemonDetachHint({ profile: 'pi-tui-dev', sessionId: 'session-42', workStopped: false })
  assert.equal(hint, [
    'Disconnected from dsh-pi-tui (daemon client).',
    'The daemon Host was not stopped by this action.',
    '',
    'Resume this session:',
    '  dsh --profile pi-tui-dev --session session-42',
    '',
    'Manage the daemon:',
    '  dsh --profile pi-tui-dev daemon status',
    '  dsh --profile pi-tui-dev daemon logs',
    '  dsh --profile pi-tui-dev daemon stop',
  ].join('\n'))
  assert.ok(!/Host:\s*running|Turn stopped|pid/i.test(hint), 'no unverified Host state/PID is printed')
})

test('daemon detach hint: sessionless omits Resume; a verified stop adds the one stopped line', () => {
  const sessionless = formatDaemonDetachHint({ profile: 'pi-tui-dev', sessionId: '', workStopped: false })
  assert.ok(!sessionless.includes('Resume this session:'), 'a sessionless detach prints no resume line')
  assert.ok(sessionless.includes('Manage the daemon:'))

  const stopped = formatDaemonDetachHint({ profile: 'pi-tui-dev', sessionId: 'session-42', workStopped: true })
  assert.match(stopped, /^Current work: stopped\.$/m)
  assert.equal(stopped.split('Current work: stopped.').length - 1, 1, 'printed at most once')
})

test('daemon detach hint: a temporary backend override is preserved and arguments are shell-safe', () => {
  const override = formatDaemonDetachHint({ profile: 'pi-tui-dev', sessionId: 'session-42', workStopped: false, backendOverride: true })
  assert.match(override, /DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui-dev --session session-42/u)
  const persisted = formatDaemonDetachHint({ profile: 'pi-tui-dev', sessionId: 'session-42', workStopped: false, backendOverride: false })
  assert.ok(!persisted.includes('DSH_PI_TUI_BACKEND'), 'a Profile-persisted daemon needs no override')
  const quoted = formatDaemonDetachHint({ profile: "team's profile", sessionId: 'session 42', workStopped: false, backendOverride: true })
  assert.match(quoted, /--profile 'team'\\''s profile' --session 'session 42'/u)
  assert.equal(daemonResumeBackendOverride(undefined), true)
  assert.equal(daemonResumeBackendOverride(''), true)
  assert.equal(daemonResumeBackendOverride('{"value":"daemon","source":"env"}'), true)
  assert.equal(daemonResumeBackendOverride('{"value":"daemon","source":"profile"}'), false)
  assert.equal(daemonResumeBackendOverride('not-json'), true)
})

test('classifyExitIntent: the frozen decision matrix, unknown never idle', () => {
  const decide = classifyExitIntent
  const base = {} as const
  assert.equal(decide({ ...base, currentBackend: 'direct', sessionPresence: 'live', activity: 'idle', entry: 'slash' }), 'direct-exit')
  assert.equal(decide({ ...base, currentBackend: 'daemon', sessionPresence: 'live', activity: 'idle', entry: 'slash' }), 'client-detach')
  assert.equal(decide({ ...base, currentBackend: 'direct', sessionPresence: 'none', activity: 'idle', entry: 'plain' }), 'direct-exit')
  assert.equal(decide({ ...base, currentBackend: 'daemon', sessionPresence: 'none', activity: 'idle', entry: 'plain' }), 'client-detach')
  assert.equal(decide({ ...base, currentBackend: 'direct', sessionPresence: 'live', activity: 'working', entry: 'keyboard' }), 'show-direct-choice')
  assert.equal(decide({ ...base, currentBackend: 'daemon', sessionPresence: 'live', activity: 'working', entry: 'keyboard' }), 'show-daemon-choice')
  assert.equal(decide({ ...base, currentBackend: 'direct', sessionPresence: 'live', activity: 'unknown', entry: 'slash' }), 'show-unknown-choice')
  assert.equal(decide({ ...base, currentBackend: 'daemon', sessionPresence: 'live', activity: 'unknown', entry: 'slash' }), 'show-unknown-choice')
  // A sessionless surface that claims activity is internally inconsistent: fail safe.
  assert.equal(decide({ ...base, currentBackend: 'daemon', sessionPresence: 'none', activity: 'unknown', entry: 'keyboard' }), 'show-unknown-choice')
  assert.equal(decide({ ...base, currentBackend: 'direct', sessionPresence: 'none', activity: 'working', entry: 'keyboard' }), 'show-unknown-choice')
  // The entry is provenance, never a safety relaxation: every entry classifies alike.
  for (const entry of ['slash', 'plain', 'keyboard'] as const) {
    assert.equal(decide({ ...base, currentBackend: 'daemon', sessionPresence: 'live', activity: 'unknown', entry }), 'show-unknown-choice')
  }
  // A running user shell is a REMINDER on the normal family (Owner decision),
  // not a separate decision: the activity/backend matrix is unchanged.
})

test('exit intent: a running user shell keeps the exit options and adds a reminder', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.state.shell = true
  h.coordinator.request('slash')
  assert.equal(h.current()?.kind, 'daemon-busy')
  assert.equal(h.current()?.shellRunning, true)
  assert.deepEqual(h.current()?.options.map(option => option.id), ['keep-and-disconnect', 'stop-and-disconnect', 'stay'])
  assert.ok(h.current()?.body.some(paragraph => paragraph.includes('user shell')), 'the shell reminder is painted')
  // Keep is preserved (Owner decision) and commits without a stopped claim.
  h.current()!.select('keep-and-disconnect')
  assert.deepEqual(h.commits, [{ workStopped: false }])
  assert.deepEqual(h.stopCalls, [], 'Keep sends no Host cancel')
})

test('exit intent: a Stop while a user shell runs never claims the shell stopped', async () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.state.shell = true
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.commits, [{ workStopped: false }], 'the Agent idle proof does not prove the shell finished')
})

test('exit intent: a shell reminder on Stop-Unconfirmed keeps the safe option set', async () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.state.shell = true
  h.state.stop = async () => ({ kind: 'unconfirmed', detail: 'the cancel was rejected' })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  const unconfirmed = h.current()
  assert.equal(unconfirmed?.phase, 'unconfirmed')
  assert.equal(unconfirmed?.shellRunning, true, 'the unconfirmed seat carries the shell reminder')
  assert.ok(unconfirmed?.body.some(paragraph => paragraph.includes('user shell')))
  assert.deepEqual(unconfirmed?.options.map(option => option.id), ['disconnect-without-stop', 'stay'])
  assert.equal(unconfirmed?.status, 'the cancel was rejected')
  // The safe Disconnect detaches once and never re-opens a second Stop.
  unconfirmed!.select('disconnect-without-stop')
  assert.deepEqual(h.commits, [{ workStopped: false }])
  assert.equal(h.stopCalls.length, 1, 'no second Agent cancel')
})

test('exit intent: a shell that starts after the Stop refreshes Unconfirmed, never Busy', async () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.state.stop = async () => ({ kind: 'unconfirmed', detail: 'the wait was aborted' })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.current()?.phase, 'unconfirmed')
  assert.equal(h.current()?.shellRunning, false)
  // The shell starts AFTER the Stop request (the late ensureSession boundary).
  h.state.shell = true
  h.current()!.select('disconnect-without-stop')
  assert.deepEqual(h.commits, [], 'the un-warned confirmation refreshes instead of committing')
  assert.equal(h.stopCalls.length, 1, 'the refresh never re-offers a second cancel')
  const refreshed = h.current()
  assert.equal(refreshed?.phase, 'unconfirmed', 'the refusal facts are never replaced by a Busy choice')
  assert.equal(refreshed?.shellRunning, true)
  assert.equal(refreshed?.status, 'the wait was aborted', 'the refusal detail is preserved')
  assert.deepEqual(refreshed?.options.map(option => option.id), ['disconnect-without-stop', 'stay'])
  refreshed!.select('disconnect-without-stop')
  assert.deepEqual(h.commits, [{ workStopped: false }])
  assert.equal(h.stopCalls.length, 1)
})

test('exit intent: a shell-reminder refresh never rebinds the captured transport identity', () => {
  // F1: the refresh must validate the ORIGINAL identity first and update the
  // model in place; a Connection/binding rollover (scope unchanged) retires
  // the choice instead of letting the old intent act on the new generation.
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  const opened = h.current()
  assert.equal(opened?.shellRunning, false)
  h.state.shell = true
  h.state.scopeCurrent = false // the transport token rolled over; the scope id is unchanged
  h.current()!.select('keep-and-disconnect')
  assert.deepEqual(h.commits, [], 'a rolled identity retires the choice, it never refreshes or commits')
  assert.equal(h.current(), undefined)
  assert.deepEqual(h.stopCalls, [])
  // A same-generation refresh keeps the SAME captured identity and options.
  const same = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  same.coordinator.request('slash')
  same.state.shell = true
  same.current()!.select('keep-and-disconnect')
  const refreshed = same.current()
  assert.deepEqual(refreshed?.options.map(option => option.id), ['keep-and-disconnect', 'stop-and-disconnect', 'stay'])
  refreshed!.select('keep-and-disconnect')
  assert.deepEqual(same.commits, [{ workStopped: false }], 'the warned Keep commits once')
})

test('exit intent: a modal that withdraws the Stopping presentation cancels the Stop dispatch', async () => {
  // F2: the Stopping model update is SYNCHRONOUS; a Host modal can dismiss the
  // choice from inside that very update. The Stop must then never dispatch.
  let seen: AbortSignal | undefined
  const h = exitIntentHarness({
    backend: 'daemon',
    activity: 'working',
    stop: signal => new Promise(resolve => {
      seen = signal
      signal.addEventListener('abort', () => resolve({ kind: 'unconfirmed', detail: 'aborted' }), { once: true })
    }),
  })
  h.state.presenterFault = phase => {
    if (phase === 'update') {
      // The modal preemption runs INSIDE the synchronous Stopping update.
      h.state.presenterFault = undefined
      h.current()!.dismiss()
    }
  }
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(seen, undefined, 'the official cancel was never dispatched after the modal withdrew the seat')
  assert.deepEqual(h.stopCalls, [])
  assert.deepEqual(h.commits, [])
})

test('exit intent: a committed session switch retires the open choice with zero action', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  assert.equal(h.current()?.kind, 'daemon-busy')
  // Subscriber path: the session scope no longer matches the captured owner.
  h.state.scopeCurrent = false
  h.coordinator.retireIfStale()
  assert.equal(h.current(), undefined, 'the stale choice is withdrawn immediately')
  assert.equal(h.closed(), 1)
  assert.deepEqual(h.commits, [], 'no Keep/Stop/Stay decision was applied')
  // An unchanged identity keeps the choice.
  const stable = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  stable.coordinator.request('slash')
  stable.coordinator.retireIfStale()
  assert.equal(stable.current()?.kind, 'daemon-busy', 'a still-current choice survives')
})

// --- M6 UX PR1: the live exit facts (the composition seam the keyboard and
// the choice read) ---

interface ExitFactsHarness {
  readonly facts: ReturnType<typeof createExitIntentFacts>
  readonly state: {
    backend: ExitBackendKind
    sessionId: string | undefined
    current: boolean
    admission: boolean
    shell: boolean
    running: boolean | undefined
    tokenCurrent: boolean
    agentRunning: boolean | undefined
    tokenSessionIds: string[]
  }
}

function exitFactsHarness(): ExitFactsHarness {
  const state: ExitFactsHarness['state'] = {
    backend: 'daemon',
    sessionId: 'session-a',
    current: true,
    admission: false,
    shell: false,
    running: false,
    tokenCurrent: true,
    agentRunning: false,
    tokenSessionIds: [],
  }
  const facts = createExitIntentFacts({
    backend: () => state.backend,
    scopes: {
      capture: () => ({ sessionId: state.sessionId }) as unknown as SessionScope,
      captureLive: () => state.sessionId === undefined
        ? undefined
        : ({ sessionId: state.sessionId } as unknown as LiveSessionScope),
      isCurrent: () => state.current,
    },
    admissionPending: () => state.admission,
    shellRunning: () => state.shell,
    remote: {
      running: () => state.running,
      captureTransportToken: (sessionId) => {
        state.tokenSessionIds.push(sessionId)
        return { generation: 1, binding: sessionId }
      },
      isTransportTokenCurrent: () => state.tokenCurrent,
    },
    directAgentRunning: () => state.agentRunning,
  })
  return { facts, state }
}

test('exit facts: a Remote admission/shell working state still captures the transport identity', () => {
  // RFL-001: the activity shortcut must not skip the identity capture, or the
  // confirm fence can never pass and Keep/Stop silently do nothing.
  const h = exitFactsHarness()
  h.state.admission = true
  const captured = h.facts.capture()
  assert.equal(captured.activity, 'working')
  assert.notEqual(captured.transportToken, undefined, 'the transport token is captured beside the scope')
  assert.deepEqual(h.state.tokenSessionIds, ['session-a'])
  assert.equal(h.facts.isScopeCurrent(captured.scope, captured.transportToken), true)
  h.state.tokenCurrent = false
  assert.equal(h.facts.isScopeCurrent(captured.scope, captured.transportToken), false,
    'a Connection/binding rollover invalidates the captured identity')

  const shell = exitFactsHarness()
  shell.state.shell = true
  assert.equal(shell.facts.capture().activity, 'working')
  assert.notEqual(shell.facts.capture().transportToken, undefined)
})

test('exit facts: the official Remote running bit and its absence decide working/idle/unknown', () => {
  const h = exitFactsHarness()
  h.state.running = true
  assert.equal(h.facts.capture().activity, 'working')
  h.state.running = false
  assert.equal(h.facts.capture().activity, 'idle')
  h.state.running = undefined
  assert.equal(h.facts.capture().activity, 'unknown', 'a missing running bit is never idle')
  h.state.running = false
  h.state.tokenCurrent = false
  assert.equal(h.facts.capture().activity, 'unknown', 'a rolled transport is never idle')
})

test('exit facts: a sessionless capture is a real generation and its first Session invalidates it', () => {
  // RFL-003: a sessionless choice must be retired when the first Session
  // publishes; otherwise the old choice could exit the new owner.
  const h = exitFactsHarness()
  h.state.sessionId = undefined
  h.state.admission = true
  const captured = h.facts.capture()
  assert.deepEqual(captured.scope.sessionId, undefined)
  assert.equal(captured.activity, 'working')
  assert.deepEqual(h.state.tokenSessionIds, [''], 'the Connection generation is fenced with the empty-session sentinel')
  assert.equal(h.facts.isScopeCurrent(captured.scope, captured.transportToken), true)
  h.state.current = false
  assert.equal(h.facts.isScopeCurrent(captured.scope, captured.transportToken), false,
    'the published first Session makes the old sessionless choice stale')
  h.state.current = true
  h.state.sessionId = undefined
  h.state.admission = false
  assert.equal(h.facts.capture().activity, 'idle')
})

test('exit facts: Direct uses the attached Agent status, never a cached busy row', () => {
  const h = exitFactsHarness()
  h.state.backend = 'direct'
  h.state.agentRunning = true
  assert.equal(h.facts.capture().activity, 'working')
  h.state.agentRunning = false
  assert.equal(h.facts.capture().activity, 'idle')
  h.state.agentRunning = undefined
  assert.equal(h.facts.capture().activity, 'unknown', 'a live scope without an observable Agent is unknown')
  assert.equal(h.facts.isScopeCurrent(exitScope(), undefined), true, 'Direct currentness is the ownership scope')
})

test('exit intent: a stale sessionless choice never exits the newly published Session', () => {
  // RFL-003 end to end through the coordinator: the choice captured the
  // sessionless generation; the first Session lands; the old Exit must be a
  // no-op (zero commit, zero cancel).
  const h = exitIntentHarness({ backend: 'direct', activity: 'working', sessionless: true })
  h.coordinator.request('slash')
  assert.equal(h.current()?.kind, 'direct-unknown')
  h.state.scopeCurrent = false
  h.coordinator.retireIfStale()
  assert.equal(h.commits.length, 0)
  assert.equal(h.stopCalls.length, 0)
  assert.equal(h.current(), undefined, 'the stale sessionless choice is retired')
})

test('exit intent: a reentrant focus callback that opens a NEW choice owns the decision', () => {
  // RFL-007: closing the old choice can synchronously run another owner's
  // onFocus, which may open a fresh intent. The old confirmation must not
  // commit after it.
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.onClose = () => {
    h.state.onClose = undefined
    h.coordinator.request('keyboard')
  }
  h.current()!.select('keep-and-disconnect')
  assert.equal(h.opens.length, 2, 'the reentrant callback opened the newer choice')
  assert.deepEqual(h.commits, [], 'the old Keep never exits the newer owner')
  assert.equal(h.current()?.kind, 'daemon-busy')
})

test('exit intent: a Stop proof cannot commit after a newer choice takes over', async () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.onClose = () => {
    h.state.onClose = undefined
    h.state.activity = 'working'
    h.coordinator.request('slash')
  }
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.opens.length, 2, 'the close-time callback opened a newer choice')
  assert.deepEqual(h.commits, [], 'the stopped proof belongs to the retired intent')
})

test('exit intent: dismissing the choice during a Stop aborts the wait', async () => {
  // RFL-005: the choice owns the local wait; dismissing it must end that wait.
  let seen: AbortSignal | undefined
  const h = exitIntentHarness({
    backend: 'daemon',
    activity: 'working',
    stop: signal => new Promise(resolve => {
      seen = signal
      signal.addEventListener('abort', () => resolve({ kind: 'unconfirmed', detail: 'aborted' }), { once: true })
    }),
  })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  assert.equal(seen?.aborted, false)
  h.current()!.dismiss()
  assert.equal(seen?.aborted, true, 'the dismissed choice aborted its own wait')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.commits, [])
})

test('exit intent: a presenter failure is recorded and never becomes an unhandled rejection', async () => {
  // RFL-004: the WHOLE stop task (presentation included) is owned.
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
    h.state.presenterFault = (phase) => {
      if (phase === 'update') throw new Error('presenter-update-failed')
    }
    h.coordinator.request('slash')
    h.current()!.select('stop-and-disconnect')
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'no rejection escapes the owned task')
    assert.match(h.diagLines.join('\n'), /presenter-update-failed/, 'the failure is recorded for diagnostics')
    assert.deepEqual(h.commits, [], 'a broken presentation never claims a stop or an exit')
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('exit intent: an old confirmation cannot commit after a newer choice opened AND withdrew', () => {
  // RFL-007 (reopened): `open === undefined` is not proof that no newer
  // operation happened; the operation epoch is.
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.onClose = () => {
    h.state.onClose = undefined
    h.coordinator.request('keyboard') // a newer choice opens
    h.current()!.dismiss() // ... and is withdrawn by a Host modal
  }
  h.current()!.select('keep-and-disconnect')
  assert.deepEqual(h.commits, [], 'the old confirmation loses to the newer operation')
  assert.equal(h.current(), undefined)
})

test('exit intent: a dispose from a close-time callback blocks the old commit', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working' })
  h.coordinator.request('slash')
  h.state.onClose = () => {
    h.state.onClose = undefined
    h.coordinator.dispose()
  }
  h.current()!.select('keep-and-disconnect')
  assert.deepEqual(h.commits, [])
})

test('exit intent: a late Stop failure never rewrites a newer choice', async () => {
  // RFL-011: the error settlement is bound to the OWN stop controller.
  const stop = deferred<StopCurrentWorkOutcome>()
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working', stop: () => stop.promise })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  h.current()!.dismiss()
  h.state.activity = 'working'
  h.coordinator.request('slash')
  const newer = h.current()!
  stop.reject(new Error('old-stop-late-failure'))
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.current(), newer, 'the newer choice is not replaced by the retired task')
  assert.equal(h.current()!.phase, 'choose')
  assert.deepEqual(h.commits, [], 'a retired Stop can never commit an exit')
})

test('exit intent: a cancellation-shaped Stop failure still settles the seat', async () => {
  // RFL-012: only the task's own AbortSignal/typed outcome is a cancellation;
  // a thrown cancellation-shaped error is an unexpected failure.
  const h = exitIntentHarness({
    backend: 'daemon',
    activity: 'working',
    stop: async () => { throw cancellationError('stop aborted') },
  })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.current()?.phase, 'unconfirmed', 'the seat leaves the Stopping state')
  assert.deepEqual(h.commits, [])
})

// ── M6 UX PR2: the whole-Host stop confirm (Step E) ─────────────────────────

test('PR2: an ordinary daemon exit with no conversion intent never asks about the Host', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: false })
  h.coordinator.request('slash')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'the plain detach commits directly')
  assert.equal(h.opens.length, 0, 'no Host confirm is offered without the intent')
})

test('PR2: an idle daemon exit WITH the intent opens the host-stop confirm, default Leave', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  const model = h.opens[0]!
  assert.equal(model.kind, 'daemon-host-stop')
  assert.deepEqual(model.options.map(option => option.id),
    ['leave-host-and-exit', 'stop-host-and-exit', 'stay'])
  assert.equal(model.focus, 'leave-host-and-exit', 'the safe Leave is the default, never the Stop')
  assert.match(model.body.join('\n'), /ALL connected Clients, Sessions, Jobs and pending interactions/u)
  assert.deepEqual(h.commits, [], 'opening the confirm commits nothing')
})

test('PR2: `Leave daemon Host running and exit` detaches with zero Host management', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  h.current()!.select('leave-host-and-exit')
  assert.deepEqual(h.commits, [{ workStopped: false }])
  assert.equal(h.stopCalls.length, 0, 'Leave never touches the Host')
})

test('PR2: `Stop daemon Host and exit` hands the ONE authorization to the final exit root', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  h.current()!.select('stop-host-and-exit')
  assert.deepEqual(h.commits, [{ workStopped: false, hostStopRequested: true }],
    'the confirm commits the verdict; the admin stop runs only in the final exit root')
  assert.equal(h.stopCalls.length, 0, 'the PR1 session cancel is NOT the Host stop')
})

test('PR2: `Stay` withdraws the whole exit and keeps the intent for the next exit', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  h.current()!.select('stay')
  assert.deepEqual(h.commits, [], 'Stay commits nothing')
  assert.equal(h.closed(), 1)
  // The next exit asks again: the intent is a process-lifetime fact.
  h.coordinator.request('slash')
  assert.equal(h.opens.length, 2, 'the confirm is offered again on the next exit')
  assert.equal(h.current()?.kind, 'daemon-host-stop')
})

test('PR2: PR1 Keep on a busy Daemon reaches the Host confirm when the intent holds', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'working', hostStopEligible: true })
  h.coordinator.request('slash')
  h.current()!.select('keep-and-disconnect')
  assert.equal(h.current()?.kind, 'daemon-host-stop', 'Keep detaches, then asks about the old Host')
  assert.equal(h.commits.length, 0, 'nothing is committed yet')
  h.current()!.select('stop-host-and-exit')
  assert.deepEqual(h.commits, [{ workStopped: false, hostStopRequested: true }])
})

test('PR2: a confirmed Session Stop reaches the Host confirm with its own truthful proof', async () => {
  const idle = deferred<StopCurrentWorkOutcome>()
  const h = exitIntentHarness({
    backend: 'daemon',
    activity: 'working',
    hostStopEligible: true,
    stop: () => idle.promise,
  })
  h.coordinator.request('slash')
  h.current()!.select('stop-and-disconnect')
  idle.resolve({ kind: 'stopped' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.current()?.kind, 'daemon-host-stop', 'the turn stop is proven first, then the Host ask')
  h.current()!.select('leave-host-and-exit')
  assert.deepEqual(h.commits, [{ workStopped: true }], 'the PR1 turn proof is carried into the detach')
})

test('PR2: an intent that is no longer eligible never opens the Host confirm', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  assert.equal(h.current()?.kind, 'daemon-host-stop')
  h.current()!.select('stay')
  // The live facts changed (another Client reverted the Profile): no more ask.
  h.state.hostStopEligible = false
  h.coordinator.request('slash')
  assert.equal(h.opens.length, 1, 'no NEW host-stop confirm is opened')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'the ordinary detach still commits')
})

test('PR2: a Host modal preemption dismisses the confirm with zero Host writes', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  const model = h.current()!
  // A higher-priority Host Question/Approval withdraws the seat exactly like
  // the PR1 choice: zero business action, the Client stays online.
  model.dismiss()
  assert.deepEqual(h.commits, [])
  assert.equal(h.stopCalls.length, 0)
  assert.equal(h.closed(), 1)
})

test('PR2: two simultaneous confirmations dispatch exactly ONE authorization', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  // A double key press and a pointer release can land in the same frame; the
  // epoch/commit latch must keep the authorization single.
  const model = h.current()!
  model.select('stop-host-and-exit')
  model.select('stop-host-and-exit')
  assert.equal(h.commits.length, 1, 'exactly one Host-stop verdict is committed')
})

test('PR2: a reentrant close callback that opens a newer intent wins over the old confirm', () => {
  const h = exitIntentHarness({ backend: 'daemon', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  const first = h.current()!
  h.state.onClose = () => {
    // A close-time focus callback starts (and keeps) a NEWER exit operation.
    h.coordinator.request('slash')
  }
  first.select('stop-host-and-exit')
  assert.equal(h.commits.length, 0, 'the old confirmation cannot commit behind the newer operation')
})

test('PR2: a Direct-process exit never asks about the daemon Host', () => {
  const h = exitIntentHarness({ backend: 'direct', activity: 'idle', hostStopEligible: true })
  h.coordinator.request('slash')
  assert.deepEqual(h.commits, [{ workStopped: false }], 'Direct exits directly')
  assert.equal(h.opens.length, 0)
})

// ── M6 UX PR2: the post-TTY whole-Host stop (Step F) ────────────────────────

test('PR2: a confirmed Host stop runs AFTER the terminal restore and before the hint/exit', async () => {
  const { requestExit, calls, exitDone } = exitHarness({
    prepareRetirement: () => {},
    adminStop: async () => ({ code: 0, stdout: 'host=stopped', stderr: '' }),
  })
  requestExit({ hostStopRequested: true })
  assert.equal(await exitDone, 0)
  assert.equal(calls.adminStop, 1, 'the admin stop runs exactly once')
  assert.deepEqual(calls.order, ['cleanup', 'prepare', 'adminStop', 'hint', 'exit'],
    'the admin stop sits between the terminal restore and the truthful hint')
  assert.deepEqual(calls.exits, [0], 'a proven stop exits 0')
})

test('PR2: an ordinary exit never runs the admin stop', async () => {
  const { requestExit, calls, exitDone } = exitHarness({
    adminStop: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  requestExit()
  assert.equal(await exitDone, 0)
  assert.equal(calls.adminStop, 0, 'no verdict means zero Host management')
  assert.deepEqual(calls.order, ['cleanup', 'hint', 'exit'])
})

test('PR2: a refused stop exits with the control plane code and claims no success', async () => {
  for (const code of [3, 4, 5]) {
    const { requestExit, calls, exitDone } = exitHarness({
      adminStop: async () => ({ code, stdout: '', stderr: 'IDENTITY_OR_OWNERSHIP_REFUSED: the unit is foreign' }),
    })
    requestExit({ hostStopRequested: true })
    assert.equal(await exitDone, code, `the stable refusal class ${code} is the exit code`)
    assert.deepEqual(calls.exits, [code])
  }
})

test('PR2: an unexpected admin throw falls back to the manager/OS failure class (4)', async () => {
  const { requestExit, calls, exitDone } = exitHarness({
    adminStop: async () => { throw new Error('management call exploded') },
  })
  requestExit({ hostStopRequested: true })
  assert.equal(await exitDone, 4)
  assert.equal(calls.adminStop, 1, 'the failed call is still exactly one attempt (no retry)')
})

test('PR2: a duplicate request after the verdict never runs a second admin stop', async () => {
  const { requestExit, calls, exitDone } = exitHarness({
    adminStop: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  requestExit({ hostStopRequested: true })
  requestExit({ hostStopRequested: true })
  assert.equal(await exitDone, 0)
  assert.equal(calls.adminStop, 1, 'the latch keeps the authorization single')
})

test('PR2: the detach hint replaces the not-stopped line only for a verified stop', () => {
  const confirmed = formatDaemonDetachHint({
    profile: 'pi-tui',
    sessionId: 'session-a',
    workStopped: false,
    hostStop: { confirmed: true },
  })
  assert.match(confirmed, /Daemon Host stopped for this Profile\./u)
  assert.doesNotMatch(confirmed, /The daemon Host was not stopped by this action\./u,
    'the two texts never coexist')

  const refused = formatDaemonDetachHint({
    profile: 'pi-tui',
    sessionId: 'session-a',
    workStopped: false,
    hostStop: { confirmed: false, detail: 'IDENTITY_OR_OWNERSHIP_REFUSED: the unit is foreign' },
  })
  assert.match(refused, /The daemon Host was not stopped by this action\./u)
  assert.match(refused, /Daemon Host stop was not confirmed: IDENTITY_OR_OWNERSHIP_REFUSED/u)

  const ordinary = formatDaemonDetachHint({ profile: 'pi-tui', sessionId: 'session-a', workStopped: false })
  assert.match(ordinary, /The daemon Host was not stopped by this action\./u)
  assert.doesNotMatch(ordinary, /Daemon Host stop was not confirmed/u)
})
