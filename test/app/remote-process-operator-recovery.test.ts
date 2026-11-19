/**
 * The two hard rules of the split Client's operator recovery.
 *
 * A 401 from the official unary carrier is an authentication rejection BEFORE
 * Host dispatch, so a replayable request may be retried once after the
 * Connection re-admitted a new operator. A forwarded-event RESULT may never be
 * retried: its payload names the stream (and Peer) that received the
 * invocation, and replaying it with the replacement operator reproduces the
 * exact "Remote event result belongs to another Peer" defect. A request body
 * this transport cannot replay is not re-sent either.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { operatorRecoveryMayRetry } from '../../src/app/remote-process/local-transport.ts'

const ORIGIN = 'http://127.0.0.1:6553'

test('a replayable unary request may be retried once', () => {
  assert.equal(operatorRecoveryMayRetry(
    `${ORIGIN}/api/session/list`,
    { method: 'POST', body: JSON.stringify({ args: [] }) },
    ORIGIN,
  ), true)
  assert.equal(operatorRecoveryMayRetry('/api/session/list', { method: 'GET' }, ORIGIN), true)
})

test('a forwarded-event result is never retried, whoever asks', () => {
  assert.equal(operatorRecoveryMayRetry(
    `${ORIGIN}/api/$events/result`,
    { method: 'POST', body: JSON.stringify({ args: {} }) },
    ORIGIN,
  ), false)
  // The relative route resolves against the Host origin exactly like the
  // official rpc caller sends it.
  assert.equal(operatorRecoveryMayRetry(
    'api/$events/result',
    { method: 'POST', body: '{}' },
    ORIGIN,
  ), false)
})

test('a body the transport cannot replay is not re-sent', () => {
  const stream = new ReadableStream()
  assert.equal(operatorRecoveryMayRetry(`${ORIGIN}/api/upload`, { method: 'POST', body: stream }, ORIGIN), false)
  const form = new FormData()
  assert.equal(operatorRecoveryMayRetry(`${ORIGIN}/api/upload`, { method: 'POST', body: form }, ORIGIN), false)
})

test('an already-aborted request is not retried', () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  assert.equal(operatorRecoveryMayRetry(
    `${ORIGIN}/api/session/list`,
    { method: 'POST', body: '{}', signal: controller.signal },
    ORIGIN,
  ), false)
})
