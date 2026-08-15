/**
 * Headless tests for the lifecycle primitives: the exit flush contract
 * (resolve / reject / hang / late-settle) and the detached-task entry
 * (rejection capture, cancellation classification, recoverable notify).
 * @module @xmoon76/dsh-pi-tui/lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createExitController, flushWithTimeout, type ExitSessionLike } from '../src/exit.ts'
import { isCancellation, runDetached } from '../src/detached.ts'
import { createDiag, type Diag } from '../src/diag.ts'

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
  runDetached('settings write', Promise.reject(new Error('boom')), { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /WARN settings write/)
  assert.match(lines[0]!, /error=boom/)
})

test('runDetached treats a cancellation as debug, never a warning', async () => {
  const { diag, lines } = captureDiag()
  runDetached('model load', Promise.reject(abortError()), { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /DEBUG model load/)
  assert.match(lines[0]!, /cancelled=true/)
  assert.ok(!lines[0]!.includes('WARN'))
})

test('runDetached notifies user-recoverable failures with the task label', async () => {
  const { diag } = captureDiag()
  const notices: string[] = []
  runDetached('settings write', Promise.reject(new Error('quota exceeded')), {
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
  runDetached('turn flush', Promise.reject(new Error('corrupt')), { diag, sessionId: () => session })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(lines[0]!, /session=session-a/)
  session = 'session-b'
  runDetached('turn flush', Promise.reject(new Error('corrupt')), { diag, sessionId: () => session })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(lines[1]!, /session=session-b/)
})

test('runDetached on a settling task writes nothing', async () => {
  const { diag, lines } = captureDiag()
  runDetached('history write', Promise.resolve(), { diag })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, 0)
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
