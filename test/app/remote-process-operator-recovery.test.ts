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
import {
  abortReasonOf,
  operatorRecoveryDecision,
  sendWithOperatorRecovery,
  settleWithOwnSignal,
} from '../../src/app/remote-process/local-transport.ts'

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

test('an already-aborted caller neither rebuilds nor retries', () => {
  // The shared re-admit is driven by whichever 401 waiter is still live; a
  // cancelled caller must not keep work alive on its behalf.
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  assert.deepEqual(operatorRecoveryDecision(
    `${ORIGIN}/api/session/list`,
    { method: 'POST', body: '{}', signal: controller.signal },
    ORIGIN,
  ), { rebuild: false, retry: false })
})

test('a caller abort while the shared re-admit runs is reported as cancellation', async () => {
  // The shared operation keeps running for every other waiter; only this
  // caller's await is released, with the signal's OWN reason.
  let releaseShared: () => void = () => {}
  const shared = new Promise<void>(resolve => { releaseShared = resolve })
  const controller = new AbortController()
  const reason = new Error('caller cancelled the unary request')
  const waiting = settleWithOwnSignal(shared, controller.signal)
  controller.abort(reason)
  await assert.rejects(waiting, error => error === reason)
  assert.equal(abortReasonOf(controller.signal, undefined), reason)
  // The shared re-admit was not cancelled by that caller.
  let sharedFinished = false
  releaseShared()
  await shared
  sharedFinished = true
  assert.equal(sharedFinished, true)
})

test('the cancellation reason is the signal reason, with a real fallback', () => {
  // A bare abort() still carries the platform AbortError as its reason.
  const controller = new AbortController()
  controller.abort()
  const bare = abortReasonOf(controller.signal, undefined)
  assert.ok(bare instanceof Error)
  assert.match(`${bare.name}:${bare.message}`, /Abort/iu)
  // The fallback is for a signal that carries no Error reason at all.
  const fallback = new Error('re-admit failed')
  assert.equal(abortReasonOf({ reason: undefined } as unknown as AbortSignal, fallback), fallback)
})

/** One fake carrier: answer 401 first, then the scripted follow-up. */
function fakeCarrier(answers: readonly Response[]): {
  readonly calls: Array<{ readonly input: string; readonly init: RequestInit | undefined }>
  readonly send: (input: string | URL, init?: RequestInit) => Promise<Response>
} {
  const calls: Array<{ readonly input: string; readonly init: RequestInit | undefined }> = []
  return {
    calls,
    send: async (input, init) => {
      calls.push({ input: String(input), init })
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
      return answer
    },
  }
}

const unauthorized = (): Response => new Response('unauthorized', { status: 401 })
const ok = (): Response => new Response('ok', { status: 200 })

test('a 401 that arrives after the caller cancelled is reported as cancellation', async () => {
  // The signal aborts while the HTTP promise is settling: the official rpc
  // caller throws on !ok before it re-checks the signal, so returning the 401
  // here would surface as an auth failure. No recovery is started either.
  const controller = new AbortController()
  const reason = new Error('caller cancelled while the 401 was settling')
  const recoverCalls: string[] = []
  const deps = {
    send: async () => { controller.abort(reason); return unauthorized() },
    recoverOperator: async () => { recoverCalls.push('recover') },
    origin: ORIGIN,
  }
  await assert.rejects(
    sendWithOperatorRecovery(deps, `${ORIGIN}/api/session/list`, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    }),
    error => error === reason,
  )
  assert.deepEqual(recoverCalls, [])
})

test('a genuine re-admit failure still returns the original 401', async () => {
  const carrier = fakeCarrier([unauthorized()])
  const response = await sendWithOperatorRecovery({
    send: carrier.send,
    recoverOperator: async () => { throw new Error('generation never became ready') },
    origin: ORIGIN,
  }, `${ORIGIN}/api/session/list`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
  assert.equal(carrier.calls.length, 1)
})

test('a replayable 401 rebuilds and is re-sent exactly once', async () => {
  const carrier = fakeCarrier([unauthorized(), ok()])
  const recoverCalls: string[] = []
  const response = await sendWithOperatorRecovery({
    send: carrier.send,
    recoverOperator: async () => { recoverCalls.push('recover') },
    origin: ORIGIN,
  }, `${ORIGIN}/api/session/list`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(carrier.calls.length, 2)
  assert.deepEqual(recoverCalls, ['recover'])
})

test('a non-replayable 401 rebuilds the connection but is not re-sent', async () => {
  const carrier = fakeCarrier([unauthorized()])
  const recoverCalls: string[] = []
  const response = await sendWithOperatorRecovery({
    send: carrier.send,
    recoverOperator: async () => { recoverCalls.push('recover') },
    origin: ORIGIN,
  }, `${ORIGIN}/api/session/uploadFileBinary`, { method: 'POST', body: new FormData() })
  assert.equal(response.status, 401)
  assert.equal(carrier.calls.length, 1)
  assert.deepEqual(recoverCalls, ['recover'])
})

test('a forwarded event result neither rebuilds nor is re-sent', async () => {
  const carrier = fakeCarrier([unauthorized()])
  const recoverCalls: string[] = []
  const response = await sendWithOperatorRecovery({
    send: carrier.send,
    recoverOperator: async () => { recoverCalls.push('recover') },
    origin: ORIGIN,
  }, `${ORIGIN}/api/$events/result`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
  assert.equal(carrier.calls.length, 1)
  assert.deepEqual(recoverCalls, [])
})
