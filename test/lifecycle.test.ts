/**
 * Headless tests for the lifecycle primitives: the exit flush contract
 * (resolve / reject / hang / late-settle) and the detached-task entry
 * (rejection capture, cancellation classification, recoverable notify).
 * @module @xmoon76/dsh-pi-tui/lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createExitController, flushWithTimeout, type ExitSessionLike } from '../src/exit.ts'
import { cancellationError, isCancellation, runDetached, runOwned } from '../src/detached.ts'
import { createDiag, type Diag } from '../src/diag.ts'

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

test('flush resolving settles ok with the elapsed time', async () => {
  let clock = 1000
  const outcome = await flushWithTimeout(async () => {
    clock += 25
  }, 1000, () => clock)
  assert.deepEqual(outcome, { kind: 'ok', tookMs: 25 })
})

test('flush rejecting settles failed with the error message', async () => {
  const outcome = await flushWithTimeout(async () => {
    throw new Error('disk full')
  }, 1000)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') {
    assert.equal(outcome.error, 'disk full')
    assert.ok(outcome.tookMs >= 0)
  }
})

test('a hung flush settles timed-out after the hard timeout, not forever', async () => {
  const started = Date.now()
  const outcome = await flushWithTimeout(() => new Promise<never>(() => {}), 40)
  assert.equal(outcome.kind, 'timed-out')
  assert.ok(Date.now() - started >= 35, 'should wait for the timeout')
  if (outcome.kind === 'timed-out') assert.ok(outcome.tookMs >= 35)
})

test('a flush settling after the timeout cannot overwrite the timed-out outcome', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = flushWithTimeout(() => gate, 30)
  const outcome = await pending
  assert.equal(outcome.kind, 'timed-out')
  release() // the flush finishes late
  await new Promise(resolve => setTimeout(resolve, 10))
  // The outcome is settled once: still timed-out.
  const outcome2 = await pending
  assert.equal(outcome2.kind, 'timed-out')
})

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

const SESSION: ExitSessionLike = { id: 'session-exit', events: { length: 7 } }

/** A controller harness recording every side effect; `exit` resolves the
 * returned promise so tests await the orchestration's completion. */
function exitHarness(options: {
  session?: () => ExitSessionLike | undefined
  flush?: () => Promise<unknown>
  timeoutMs?: number
  resumeHint?: () => string | undefined
} = {}) {
  const { diag, lines } = captureDiag()
  const calls = {
    flush: 0,
    cleanup: 0,
    warns: [] as string[],
    hints: [] as string[],
    exits: [] as number[],
  }
  let resolveExit!: (code: number) => void
  const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
  const flushImpl = options.flush ?? (async () => {})
  const { requestExit } = createExitController({
    session: options.session ?? (() => SESSION),
    flush: async () => { calls.flush += 1; await flushImpl() },
    timeoutMs: options.timeoutMs ?? 1000,
    diag,
    cleanup: () => { calls.cleanup += 1 },
    warn: (message) => { calls.warns.push(message) },
    hint: (message) => { calls.hints.push(message) },
    resumeHint: options.resumeHint ?? (() => `dsh --profile pi-tui --session ${SESSION.id}`),
    exit: (code) => { calls.exits.push(code); resolveExit(code) },
  })
  return { requestExit, calls, exitDone, lines }
}

test('exit without a session flushes nothing and exits once', async () => {
  const { requestExit, calls, exitDone } = exitHarness({ session: () => undefined })
  requestExit()
  assert.equal(await exitDone, 0)
  assert.equal(calls.flush, 0, 'no session: nothing to flush')
  assert.equal(calls.cleanup, 1)
  assert.deepEqual(calls.warns, [], 'a clean no-session exit must not warn')
})

test('exit flushes, cleans up, hints, and exits once on a resolving flush', async () => {
  const { requestExit, calls, exitDone, lines } = exitHarness()
  requestExit()
  assert.equal(await exitDone, 0)
  assert.equal(calls.flush, 1)
  assert.equal(calls.cleanup, 1)
  assert.deepEqual(calls.exits, [0])
  assert.deepEqual(calls.hints, ['dsh --profile pi-tui --session session-exit'])
  assert.match(lines.join('\n'), /outcome=ok/)
})

test('a rejecting flush still exits, warns, and never leaks an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const { requestExit, calls, exitDone } = exitHarness({
      flush: async () => { throw new Error('disk full') },
    })
    requestExit()
    assert.equal(await exitDone, 0)
    assert.equal(calls.cleanup, 1)
    assert.deepEqual(calls.warns, ['session flush failed (disk full) — the latest events may not be persisted'])
    assert.deepEqual(unhandled, [], 'the exit path must capture the flush rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a hung flush exits after the hard timeout', async () => {
  const started = Date.now()
  const { requestExit, calls, exitDone } = exitHarness({
    flush: () => new Promise<never>(() => {}),
    timeoutMs: 40,
  })
  requestExit()
  assert.equal(await exitDone, 0)
  assert.ok(Date.now() - started >= 35, 'must wait for the hard timeout')
  assert.equal(calls.cleanup, 1)
  assert.match(calls.warns[0] ?? '', /timed out/)
})

test('exit is idempotent: later requests while in flight or after are no-ops', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { requestExit, calls, exitDone } = exitHarness({ flush: () => gate })
  requestExit()
  requestExit() // in-flight: must be a no-op
  release()
  assert.equal(await exitDone, 0)
  requestExit() // after completion: must be a no-op
  assert.equal(calls.flush, 1, 'a second request must not flush again')
  assert.equal(calls.cleanup, 1, 'a second request must not clean up again')
  assert.deepEqual(calls.exits, [0], 'a second request must not exit again')
})

test('a late flush resolving after the timeout cannot re-run cleanup or exit', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { requestExit, calls, exitDone } = exitHarness({ flush: () => gate, timeoutMs: 30 })
  requestExit()
  assert.equal(await exitDone, 0)
  release() // the flush settles late
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls.cleanup, 1)
  assert.deepEqual(calls.exits, [0])
})

test('exit without a resume hint prints none', async () => {
  const { requestExit, calls, exitDone } = exitHarness({ resumeHint: () => undefined })
  requestExit()
  assert.equal(await exitDone, 0)
  assert.deepEqual(calls.hints, [])
})

// --- lifecycle-root hostile inputs: flush and exit must stay total ---

/** An object whose stringification throws (a legal thrown value). */
function hostileFlushValue(): object {
  return {
    toString() {
      throw new Error('flush stringify exploded')
    },
  }
}

test('flushWithTimeout: a hostile flush rejection settles `failed` immediately, never timed-out', async () => {
  const unhandled = await unhandledOf(() => {
    void flushWithTimeout(() => Promise.reject(hostileFlushValue()), 40)
  })
  assert.deepEqual(unhandled, [], 'a hostile flush rejection must never leak')
  const outcome = await flushWithTimeout(() => Promise.reject(hostileFlushValue()), 40)
  assert.equal(outcome.kind, 'failed', 'the failure must be reported as failed, not timed-out')
  if (outcome.kind === 'failed') {
    assert.equal(outcome.error, '<unprintable error>')
  }
})

test('flushWithTimeout: with the timeout disabled a hostile rejection still settles', async () => {
  const outcome = await flushWithTimeout(() => Promise.reject(hostileFlushValue()), 0)
  assert.equal(outcome.kind, 'failed', 'the disabled-timeout path must still settle')
})

test('exit: a throwing session() still cleans up exactly once and exits 1, zero unhandled', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    const { diag, lines } = captureDiag()
    const calls = { cleanup: 0, exits: [] as number[] }
    let resolveExit!: (code: number) => void
    const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
    createExitController({
      session: () => { throw hostileFlushValue() },
      flush: async () => {},
      timeoutMs: 1000,
      diag,
      cleanup: () => { calls.cleanup += 1 },
      warn: () => {},
      hint: () => {},
      resumeHint: () => undefined,
      exit: (code) => { calls.exits.push(code); resolveExit(code) },
    }).requestExit()
    assert.equal(await exitDone, 1, 'an orchestration failure must exit with code 1')
    assert.equal(calls.cleanup, 1, 'cleanup runs exactly once')
    assert.deepEqual(calls.exits, [1])
    assert.deepEqual(unhandled, [], 'a throwing session() must never leak from the discarded IIFE')
    assert.match(lines.join('\n'), /exit orchestration failed/)
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('exit: throwing cleanup/warn/hint cannot skip the exit, zero unhandled', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    const { diag } = captureDiag()
    const calls = { cleanup: 0, exits: [] as number[] }
    let resolveExit!: (code: number) => void
    const exitDone = new Promise<number>(resolve => { resolveExit = resolve })
    createExitController({
      session: () => SESSION,
      flush: async () => { throw new Error('disk full') },
      timeoutMs: 1000,
      diag,
      cleanup: () => { calls.cleanup += 1; throw new Error('cleanup exploded') },
      warn: () => { throw new Error('warn exploded') },
      hint: () => { throw new Error('hint exploded') },
      resumeHint: () => 'resume',
      exit: (code) => { calls.exits.push(code); resolveExit(code) },
    }).requestExit()
    assert.equal(await exitDone, 0, 'a flush failure is not an orchestration failure: exit 0')
    assert.equal(calls.cleanup, 1, 'cleanup still runs (and its throw is consumed)')
    assert.deepEqual(calls.exits, [0], 'a throwing warn/hint/cleanup must never skip the exit')
    assert.deepEqual(unhandled, [], 'no step may leak a rejection')
  } finally {
    process.off('unhandledRejection', listener)
  }
})
