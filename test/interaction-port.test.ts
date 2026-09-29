/**
 * Adapter contract tests for the Direct interaction port
 * (runtime/direct/interaction-direct.ts, migration M1.6 round 4 + M3-3B
 * Question reconvergence): the port is transport-neutral — approval and
 * Question are separate concerns, the Question sub-domain carries the full
 * rc.2 lifecycle (live request with an explicit Session identity, durable
 * surface from the official projections, timed claim, late answer), and the
 * approval listener receives the Agent-free ApprovalRequestLike. A Remote
 * adapter must satisfy the SAME contract over the wire; these tests pin the
 * contract with a fake Host context.
 * @module @xmoon76/dsh-pi-tui/interaction-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectInteractionPort, type HostContextLike } from '../src/runtime/direct/interaction-direct.ts'
import type { UserQuestionProvider } from '../src/runtime/interaction-port.ts'

type RegisteredListener = (req: unknown, next: unknown) => unknown

function host(
  services: Record<string, unknown>,
  events: Array<string | RegisteredListener> = [],
): HostContextLike {
  return {
    get: (name) => services[name],
    on: (event, listener) => {
      events.push(event)
      events.push(listener as RegisteredListener)
      return listener
    },
  }
}

function port(
  services: Record<string, unknown>,
  agentFor?: (sessionId: string) => unknown,
  events: Array<string | RegisteredListener> = [],
) {
  return new DirectInteractionPort(
    host(services, events),
    (agentFor ?? (() => undefined)) as never,
  )
}

const provider: UserQuestionProvider = async () => ({ answers: [] })

test('questions.onRequest registers on the DSH user-question waterfall', () => {
  const events: Array<string | RegisteredListener> = []
  const p = port({ userQuestions: {} }, undefined, events)
  assert.equal(p.questions.onRequest(provider), true)
  assert.equal(events[0], 'user-questions/request')
  assert.equal(typeof events[1], 'function')
})

test('questions.onRequest reports absent service', () => {
  const p = port({})
  assert.equal(p.questions.onRequest(provider), false)
})

test('questions.onRequest resolves the Session identity and NEVER leaks the Agent', async () => {
  const events: Array<string | RegisteredListener> = []
  const p = port({ userQuestions: {} }, undefined, events)
  const seen: unknown[] = []
  p.questions.onRequest(async (request) => {
    seen.push(request)
    return { answers: [] }
  })
  const handler = events[1]! as RegisteredListener
  const signal = new AbortController().signal
  await handler({
    agent: { session: { id: 'session-a' } },
    wait: { callId: 'call-1', timed: true },
    questions: [{ id: 'q1', question: 'Pick' }],
    signal,
  }, async () => ({ answers: [] }))
  assert.deepEqual(seen, [{
    sessionId: 'session-a',
    callId: 'call-1',
    timed: true,
    questions: [{ id: 'q1', question: 'Pick' }],
    signal,
  }])
})

test('questions.onRequest delegates an agentless request to the next answerer', async () => {
  const events: Array<string | RegisteredListener> = []
  const p = port({ userQuestions: {} }, undefined, events)
  let called = false
  p.questions.onRequest(async () => { called = true; return { answers: [] } })
  const handler = events[1]! as RegisteredListener
  const result = await handler({ questions: [{ id: 'q1', question: 'Pick' }] }, async () => 'next-answer')
  assert.equal(called, false, 'an agentless request has no Session identity to key a card by')
  assert.equal(result, 'next-answer')
})

test('questions.snapshot maps the official projections and the queued-reply fact', () => {
  const liveAgent = { session: { id: 'session-a' } }
  const projections = {
    stateOf: (_session: unknown, key: string) => key === 'userQuestions'
      ? {
        questions: {
          active: [
            { callId: 'call-open', questions: [{ id: 'q1', question: 'A' }], state: 'open' },
            { callId: 'call-continued', questions: [{ id: 'q2', question: 'B' }], state: 'continued' },
          ],
          settled: [{ callId: 'call-settled', answers: [{ id: 'q3', selected: [], custom: 'late' }] }],
        },
      }
      : {
        'next-step': [{ source: { kind: 'user-question-reply', callId: 'call-continued' } }],
        'next-turn': [],
      },
  }
  const p = port({ userQuestions: {}, sessionProjections: projections }, () => liveAgent)
  const snapshot = p.questions.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.active.map(entry => [entry.callId, entry.state]), [
    ['call-open', 'open'],
    ['call-continued', 'continued'],
  ])
  assert.deepEqual(snapshot.settled, [{
    callId: 'call-settled',
    sessionId: 'session-a',
    answers: [{ id: 'q3', selected: [], custom: 'late' }],
  }])
  assert.deepEqual([...snapshot.queuedReplyCallIds], ['call-continued'])
})

test('questions.snapshot reports absence (undefined) — never an authoritative empty surface', () => {
  const p = port({ userQuestions: {} }, () => ({ session: { id: 'session-a' } }))
  assert.equal(p.questions.snapshot('session-a'), undefined, 'no projection registry')
  const p2 = port(
    { userQuestions: {}, sessionProjections: { stateOf: () => undefined } },
    () => ({ session: { id: 'session-a' } }),
  )
  assert.equal(p2.questions.snapshot('session-a'), undefined, 'projection key not registered')
  const p3 = port(
    { userQuestions: {}, sessionProjections: { stateOf: () => undefined } },
    () => undefined,
  )
  assert.equal(p3.questions.snapshot('session-ghost'), undefined, 'no live agent')
})

test('questions.claimTimedWait seeds the claim with the Host remaining duration and releases', async () => {
  const released: string[] = []
  const streams = {
    attachWait: (_agent: unknown, callId: string, signal: AbortSignal) => {
      return (async function* () {
        yield { remainingMs: 12_345 }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { released.push(callId); resolve() }, { once: true })
        })
      })()
    },
  }
  const p = port({ userQuestions: streams }, () => ({ session: { id: 'session-a' } }))
  const claim = await p.questions.claimTimedWait('session-a', 'call-1')
  assert.ok(claim !== undefined)
  assert.equal(claim.remainingMs, 12_345)
  claim.release()
  await claim.ended
  assert.deepEqual(released, ['call-1'])
})

test('questions.claimTimedWait reports undefined when no live timed wait exists', async () => {
  const streams = { attachWait: () => (async function* () { /* no frames */ })() }
  const p = port({ userQuestions: streams }, () => ({ session: { id: 'session-a' } }))
  assert.equal(await p.questions.claimTimedWait('session-a', 'call-continued'), undefined)
  const p2 = port({ userQuestions: streams }, () => undefined)
  assert.equal(await p2.questions.claimTimedWait('session-ghost', 'call-1'), undefined)
})

test('questions.answerContinued maps the Host boolean and preserves the Host taxonomy', async () => {
  const calls: unknown[] = []
  const service = {
    answer: (agent: unknown, callId: string, answer: unknown) => {
      calls.push({ agent, callId, answer })
      return true
    },
  }
  const liveAgent = { session: { id: 'session-a' } }
  const p = port({ userQuestions: service }, () => liveAgent)
  const answer = { answers: [{ id: 'q1', selected: ['x'] }] }
  assert.equal(await p.questions.answerContinued('session-a', 'call-1', answer), 'queued')
  assert.deepEqual(calls, [{ agent: liveAgent, callId: 'call-1', answer }])

  const notContinued = port({ userQuestions: { answer: () => false } }, () => liveAgent)
  assert.equal(await notContinued.questions.answerContinued('session-a', 'call-1', answer), 'not-continued')

  const queued = port({
    userQuestions: { answer: () => { throw Object.assign(new Error('already queued'), { code: 'REPLY_QUEUED' }) } },
  }, () => liveAgent)
  await assert.rejects(() => queued.questions.answerContinued('session-a', 'call-1', answer), /already queued/u)

  await assert.rejects(
    () => port({}, () => liveAgent).questions.answerContinued('session-a', 'call-1', answer),
    /userQuestions service is unavailable/u,
  )
  await assert.rejects(
    () => port({ userQuestions: service }, () => undefined).questions.answerContinued('session-ghost', 'call-1', answer),
    /userQuestions service is unavailable/u,
  )
})

test('onApprovalRequest subscribes to the approval/request event', () => {
  const events: Array<string | RegisteredListener> = []
  const p = port({}, undefined, events)
  const listener = () => 'ok'
  p.onApprovalRequest(listener)
  assert.equal(events[0], 'approval/request')
})

test('onApprovalRequest adapts the official ApprovalRequest onto the Agent-free Like shape', () => {
  const received: Array<{ signal?: AbortSignal; callId?: string; toolName: string; reason?: string }> = []
  const events: Array<string | RegisteredListener> = []
  const p = port({}, undefined, events)
  p.onApprovalRequest((req) => { received.push(req); return 'ok' })
  // events[0] is the event NAME; events[1] is the registered handler.
  const handler = events[1]! as RegisteredListener
  // The real dsh ApprovalRequest carries a same-process agent; the adapter
  // must strip it and pass ONLY the transport-neutral subset.
  handler({ agent: { session: { id: 'x' } }, toolName: 'bash', reason: 'r', callId: 'call-1', signal: undefined }, () => {})
  assert.deepEqual(received, [{ toolName: 'bash', reason: 'r', callId: 'call-1' }])
})

test('setApprovalPolicy resolves the session id to the live Agent internally and delegates', () => {
  const calls: Array<{ agent: unknown; policy: unknown }> = []
  const liveAgent = { session: { id: 'session-a' } }
  const p = port(
    { approval: { setPolicy: (agent: unknown, policy: string) => { calls.push({ agent, policy }) } } },
    (sessionId) => sessionId === 'session-a' ? liveAgent : undefined,
  )
  assert.equal(p.setApprovalPolicy('session-a', 'ask'), true)
  assert.deepEqual(calls, [{ agent: liveAgent, policy: 'ask' }])
})

test('setApprovalPolicy reports unavailable when the service or the session is absent', () => {
  const p = port({}, (sessionId) => sessionId === 'session-a' ? { session: { id: 'session-a' } } : undefined)
  assert.equal(p.setApprovalPolicy('session-ghost', 'never'), false, 'no live agent for the session')
  const p2 = port({})
  assert.equal(p2.setApprovalPolicy('session-a', 'never'), false, 'no approval service')
})
