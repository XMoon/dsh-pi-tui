/**
 * Headless tests for the lifecycle primitives: the exit flush contract
 * (resolve / reject / hang / late-settle) and the detached-task entry
 * (rejection capture, cancellation classification, recoverable notify).
 * @module @xmoon76/dsh-pi-tui/lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { flushWithTimeout } from '../src/exit.ts'
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
