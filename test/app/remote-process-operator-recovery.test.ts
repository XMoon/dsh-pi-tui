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
import { operatorRecoveryDecision } from '../../src/app/remote-process/local-transport.ts'

const ORIGIN = 'http://127.0.0.1:6553'

test('a replayable unary request rebuilds the operator and is retried once', () => {
  assert.deepEqual(operatorRecoveryDecision(
    `${ORIGIN}/api/session/list`,
    { method: 'POST', body: JSON.stringify({ args: [] }) },
    ORIGIN,
  ), { rebuild: true, retry: true })
  assert.deepEqual(operatorRecoveryDecision('/api/session/list', { method: 'GET' }, ORIGIN), { rebuild: true, retry: true })
})

test('a forwarded-event result is neither rebuilt nor retried here', () => {
  // Its clientId belongs to the stream/Peer that received the invocation: the
  // Gateway's own generation abort + Host re-delivery owns the recovery.
  assert.deepEqual(operatorRecoveryDecision(
    `${ORIGIN}/api/$events/result`,
    { method: 'POST', body: JSON.stringify({ args: {} }) },
    ORIGIN,
  ), { rebuild: false, retry: false })
  // The relative route resolves against the Host origin exactly like the
  // official rpc caller sends it.
  assert.deepEqual(operatorRecoveryDecision('api/$events/result', { method: 'POST', body: '{}' }, ORIGIN),
    { rebuild: false, retry: false })
})

test('a non-replayable body still rebuilds the connection but is not re-sent', () => {
  // A dead operator affects EVERY route: the upload cannot be replayed, but the
  // connection must be rebuilt so the user's next request is not 401ed forever.
  const stream = new ReadableStream()
  assert.deepEqual(operatorRecoveryDecision(`${ORIGIN}/api/upload`, { method: 'POST', body: stream }, ORIGIN),
    { rebuild: true, retry: false })
  const form = new FormData()
  assert.deepEqual(operatorRecoveryDecision(`${ORIGIN}/api/upload`, { method: 'POST', body: form }, ORIGIN),
    { rebuild: true, retry: false })
})

test('an already-aborted request is not retried', () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  assert.deepEqual(operatorRecoveryDecision(
    `${ORIGIN}/api/session/list`,
    { method: 'POST', body: '{}', signal: controller.signal },
    ORIGIN,
  ), { rebuild: true, retry: false })
})
