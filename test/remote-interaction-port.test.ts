/**
 * L3 adapter contract tests for the Remote interaction port
 * (`runtime/remote/interaction-remote.ts`, M3-3B): the adapter maps the
 * published rc.2 wire onto the SAME semantic contract the Direct adapter
 * serves — the forwarded live request (Session identity from the official
 * Client scope), the durable `userQuestions`/`inbox` projection surface, the
 * `attachWait` timed claim (first frame = Host `remainingMs`, generation
 * fenced, released on teardown), the `answer` late-answer taxonomy, and the
 * explicitly unsupported approval-policy write.
 * @module @xmoon76/dsh-pi-tui/remote-interaction-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteInteractionPort } from '../src/runtime/remote/interaction-remote.ts'
import { QuestionAnswerError, QUESTION_BAD_ANSWER, QUESTION_REPLY_QUEUED } from '../src/runtime/interaction-port.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'

type QuestionListener = (
  this: unknown,
  request: {
    questions: readonly { id: string; question: string }[]
    wait?: { callId?: unknown; timed?: unknown }
    signal?: AbortSignal
  },
  next: () => Promise<unknown>,
) => Promise<unknown>

interface FakeRemote {
  readonly listeners: Map<string, QuestionListener>
  readonly $on: (event: string, listener: QuestionListener) => () => void
  readonly userQuestions: {
    attachWait(sessionId: string, callId: string, signal?: AbortSignal): AsyncIterable<{ remainingMs: number }> & { dispose(): void }
    answer(sessionId: string, callId: string, answer: unknown): Promise<{ ok: true; value: boolean } | { ok: false; error: unknown }>
  }
  disposed: number
}

function fakeRemote(overrides: Partial<FakeRemote['userQuestions']> = {}): FakeRemote {
  const listeners = new Map<string, QuestionListener>()
  const state = { disposed: 0 } as { disposed: number }
  return {
    listeners,
    get disposed() { return state.disposed },
    set disposed(value: number) { state.disposed = value },
    $on: (event, listener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    userQuestions: {
      attachWait: () => Object.assign(
        (async function* () { /* no frames by default */ })(),
        { dispose: () => {} },
      ),
      answer: async () => ({ ok: true, value: true }),
      ...overrides,
    },
  }
}

function portWith(remote: FakeRemote, surfaces: {
  scopeOf?: (owner: unknown) => string | undefined
  projection?: (sessionId: string, key: string) => unknown
  bindingPresent?: boolean
} = {}) {
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const port = new RemoteInteractionPort({
    sessions: {
      scopeOf: surfaces.scopeOf ?? (() => undefined),
      binding: () => surfaces.bindingPresent === false ? undefined : {
        session: {
          projections: {
            faceOf: (key: string) => ({ getSnapshot: () => surfaces.projection?.('session-a', key), subscribe: () => () => {} }),
          },
        },
      },
    },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  return { port, generation }
}

test('questions.onRequest derives the Session identity from the official Client scope', async () => {
  const remote = fakeRemote()
  const owner = { scoped: true }
  const { port } = portWith(remote, { scopeOf: (received) => received === owner ? 'session-a' : undefined })
  const seen: unknown[] = []
  port.questions.onRequest(async (request) => { seen.push(request); return { answers: [] } })
  const listener = remote.listeners.get('user-questions/request')
  assert.ok(listener !== undefined)
  const signal = new AbortController().signal
  await listener.call(owner, {
    questions: [{ id: 'q1', question: 'Pick' }],
    wait: { callId: 'call-1', timed: true },
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

test('questions.onRequest delegates a request whose scope owns no Session', async () => {
  const remote = fakeRemote()
  const { port } = portWith(remote, { scopeOf: () => undefined })
  let called = false
  port.questions.onRequest(async () => { called = true; return { answers: [] } })
  const listener = remote.listeners.get('user-questions/request')!
  const outcome = await listener.call({}, { questions: [{ id: 'q1', question: 'Pick' }] }, async () => 'next')
  assert.equal(called, false)
  assert.equal(outcome, 'next')
})

test('questions.snapshot maps the official userQuestions + inbox projections', () => {
  const remote = fakeRemote()
  const { port } = portWith(remote, {
    projection: (_sessionId, key) => key === 'userQuestions'
      ? {
        active: [
          { callId: 'call-open', questions: [{ id: 'q1', question: 'A' }], state: 'open' },
          { callId: 'call-continued', questions: [{ id: 'q2', question: 'B' }], state: 'continued' },
        ],
        settled: [{ callId: 'call-settled', answers: [{ id: 'q3', selected: [], custom: 'late' }] }],
      }
      : {
        'next-step': [{ source: { kind: 'user-question-reply', callId: 'call-continued' } }],
        'next-turn': [{ source: { kind: 'user-message' } }],
      },
  })
  const snapshot = port.questions.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.active.map(entry => [entry.callId, entry.state, entry.sessionId]), [
    ['call-open', 'open', 'session-a'],
    ['call-continued', 'continued', 'session-a'],
  ])
  assert.deepEqual(snapshot.settled, [{
    callId: 'call-settled',
    sessionId: 'session-a',
    answers: [{ id: 'q3', selected: [], custom: 'late' }],
  }])
  assert.deepEqual([...snapshot.queuedReplyCallIds], ['call-continued'])
})

test('questions.snapshot is undefined for a missing binding or malformed view — never an empty surface', () => {
  const remote = fakeRemote()
  const missingBinding = portWith(remote, { bindingPresent: false })
  assert.equal(missingBinding.port.questions.snapshot('session-a'), undefined)
  const malformed = portWith(remote, { projection: () => ({ active: 'nope', settled: [] }) })
  assert.equal(malformed.port.questions.snapshot('session-a'), undefined, 'a present-but-invalid view is not an empty surface')
  const noCells = portWith(remote, { projection: () => undefined })
  assert.equal(noCells.port.questions.snapshot('session-a'), undefined)
})

test('questions.claimTimedWait seeds the Host remaining duration and releases the stream', async () => {
  let disposed = 0
  const released = new Set<string>()
  const remote = fakeRemote({
    attachWait: (_sessionId, callId, signal) => {
      const handle = {
        dispose: () => { disposed += 1 },
        async *[Symbol.asyncIterator]() {
          yield { remainingMs: 4_200 }
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => { released.add(callId); resolve() }, { once: true })
          })
        },
      }
      return handle as never
    },
  })
  const { port } = portWith(remote)
  const claim = await port.questions.claimTimedWait('session-a', 'call-1')
  assert.ok(claim !== undefined)
  assert.equal(claim.remainingMs, 4_200)
  claim.release()
  await claim.ended
  assert.deepEqual([...released], ['call-1'])
  assert.equal(disposed, 1, 'the underlying stream handle is disposed exactly once')
})

test('questions.claimTimedWait is absent without a first frame or without a Connection generation', async () => {
  const remote = fakeRemote()
  const { port } = portWith(remote)
  assert.equal(await port.questions.claimTimedWait('session-a', 'call-continued'), undefined)

  const noGeneration = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remote as never,
    connection: { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
  })
  assert.equal(await noGeneration.questions.claimTimedWait('session-a', 'call-1'), undefined)
})

test('questions.claimTimedWait drops a claim whose Connection generation was replaced', async () => {
  let disposed = 0
  const remote = fakeRemote({
    attachWait: () => ({
      dispose: () => { disposed += 1 },
      async *[Symbol.asyncIterator]() {
        // The replace lands while the first frame is in flight.
        Promise.resolve().then(() => generation.set({ id: 'gen-2' }))
        yield { remainingMs: 1_000 }
        await new Promise(() => {})
      },
    }) as never,
  })
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const port = new RemoteInteractionPort({
    sessions: {
      scopeOf: () => undefined,
      binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) } } }),
    },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  const claim = await port.questions.claimTimedWait('session-a', 'call-1')
  assert.equal(claim, undefined, 'a replaced generation must not surface a stale claim')
  assert.equal(disposed, 1, 'the stale stream is disposed')
})

test('questions.answerContinued maps the official RemoteResult and preserves the Host taxonomy', async () => {
  const accepted = fakeRemote({ answer: async () => ({ ok: true, value: true }) })
  assert.equal(
    await portWith(accepted).port.questions.answerContinued('session-a', 'call-1', { answers: [] }),
    'queued',
  )
  const notContinued = fakeRemote({ answer: async () => ({ ok: true, value: false }) })
  assert.equal(
    await portWith(notContinued).port.questions.answerContinued('session-a', 'call-1', { answers: [] }),
    'not-continued',
  )
  for (const code of [QUESTION_REPLY_QUEUED, QUESTION_BAD_ANSWER]) {
    const refused = fakeRemote({ answer: async () => ({ ok: false, error: { code, message: `${code} refusal` } }) })
    await assert.rejects(
      () => portWith(refused).port.questions.answerContinued('session-a', 'call-1', { answers: [] }),
      (error: unknown) => {
        assert.ok(error instanceof QuestionAnswerError, 'the shared port error vocabulary is used')
        assert.equal(error.code, code)
        return true
      },
    )
  }
})

test('setApprovalPolicy fails closed (no public rc.2 carrier) and approval rides the forwarded waterfall', () => {
  const remote = fakeRemote()
  const { port } = portWith(remote)
  assert.equal(port.setApprovalPolicy('session-a', 'ask'), false)
  assert.equal(port.setApprovalPolicy('session-a', 'never'), false)
  const seen: unknown[] = []
  port.onApprovalRequest((request) => { seen.push(request); return 'ok' })
  const handler = remote.listeners.get('approval/request')
  assert.ok(handler !== undefined, 'the approval waterfall is subscribed')
  ;(handler as unknown as (this: unknown, request: unknown, next: unknown) => unknown)
    .call({}, { toolName: 'bash' }, () => {})
  assert.deepEqual(seen, [{ toolName: 'bash' }])
})

test('answerContinued refuses to report an outcome once the Connection generation was replaced', async () => {
  // A late answer is a write whose completion must not repaint a NEWER
  // Question surface (plan §7.3 stale-generation row): the adapter captures
  // the generation before dispatch and throws a superseded read afterwards, so
  // the controller stays silent about an outcome it cannot vouch for.
  const remote = fakeRemote({
    answer: async () => {
      // The replace lands while the answer is in flight.
      generation.set({ id: 'gen-2' })
      return { ok: true, value: true }
    },
  })
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const port = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  await assert.rejects(
    () => port.questions.answerContinued('session-a', 'call-1', { answers: [] }),
    (error: unknown) => {
      assert.equal((error as Error).name, 'SupersededReadError')
      return true
    },
  )
})

test('answerContinued is not dispatched at all without a current Connection generation', async () => {
  const calls: number[] = []
  const remote = fakeRemote({ answer: async () => { calls.push(1); return { ok: true, value: true } } })
  const port = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remote as never,
    connection: { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
  })
  await assert.rejects(
    () => port.questions.answerContinued('session-a', 'call-1', { answers: [] }),
    (error: unknown) => {
      assert.equal((error as Error).name, 'SupersededReadError')
      return true
    },
  )
  assert.deepEqual(calls, [], 'a disconnected Connection never dispatches the write')
})

test('snapshot presents no answerable surface while the Connection has no generation', () => {
  // A disconnected Connection cannot vouch for a last-known continuation: the
  // synchronous projection read follows the established sync convention and
  // reports absence, so reconcile() mounts nothing from a stale binding.
  const remote = fakeRemote()
  const port = new RemoteInteractionPort({
    sessions: {
      scopeOf: () => undefined,
      binding: () => ({
        session: {
          projections: {
            faceOf: (key: string) => ({
              getSnapshot: () => key === 'userQuestions'
                ? { active: [{ callId: 'call-continued', questions: [{ id: 'q1', question: 'A' }], state: 'continued' }], settled: [] }
                : { 'next-step': [], 'next-turn': [] },
              subscribe: () => () => {},
            }),
          },
        },
      }),
    },
    remote: remote as never,
    connection: { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
  })
  assert.equal(port.questions.snapshot('session-a'), undefined)
})

test('claimTimedWait resolves undefined when the caller aborts during the opening frame', async () => {
  const remote = fakeRemote({
    attachWait: (_sessionId, _callId, signal) => ({
      dispose: () => {},
      async *[Symbol.asyncIterator]() {
        // Reject the opening because the caller aborted: the port documents
        // this as the ordinary "no claim" outcome, not a transport failure.
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('stream aborted')), { once: true })
        })
        yield { remainingMs: 1 }
      },
    }) as never,
  })
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const controller = new AbortController()
  const port = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  const pending = port.questions.claimTimedWait('session-a', 'call-1', controller.signal)
  controller.abort()
  assert.equal(await pending, undefined, 'a caller abort is a normal absent claim')
})

test('dispose releases every forwarded-event subscription exactly once', () => {
  // The adapter OWNS its subscriptions (the established Remote convention):
  // the assembly runs dispose() BEFORE the Client Context disposal, so a
  // forwarded-event listener never outlives its owner.
  const offs: string[] = []
  const remote = fakeRemote()
  const subscriptions = new Map<string, () => void>()
  const remoteWithDisposers = {
    ...remote,
    $on: (event: string, listener: unknown) => {
      const off = remote.$on(event, listener as never)
      subscriptions.set(event, off)
      return () => { offs.push(event); off() }
    },
  }
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const port = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remoteWithDisposers as never,
    connection: { generation: generation.source },
  })
  port.questions.onRequest(async () => ({ answers: [] }))
  port.onApprovalRequest(() => 'ok')
  assert.deepEqual([...subscriptions.keys()].sort(), ['approval/request', 'user-questions/request'])

  port.dispose()
  port.dispose()
  assert.deepEqual(offs.sort(), ['approval/request', 'user-questions/request'],
    'each subscription is released exactly once')
})

test('claimTimedWait drops the claim when the caller aborts between frame and return', async () => {
  // The released Client re-checks its claim signal after the opening frame; a
  // caller abort landing in that window must not hand back a dead claim.
  let disposed = 0
  const controller = new AbortController()
  const remote = fakeRemote({
    attachWait: () => ({
      dispose: () => { disposed += 1 },
      async *[Symbol.asyncIterator]() {
        // The abort is queued BEFORE the frame is delivered, so it lands in the
        // window between the frame resolving and the adapter returning the
        // claim (the microtask precedes the adapter's await continuation).
        queueMicrotask(() => { controller.abort() })
        yield { remainingMs: 5_000 }
        await new Promise(() => {})
      },
    }) as never,
  })
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const port = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  const claim = await port.questions.claimTimedWait('session-a', 'call-1', controller.signal)
  assert.equal(claim, undefined, 'a claim whose caller already aborted is not handed back')
  assert.equal(disposed, 1, 'the dead stream is disposed')
})

test('subscribe observes BOTH durable projects and releases them exactly once (Remote)', () => {
  // The Client projection faces are the session-scoped observables; the
  // adapter registers one per projected unit and hands back a disposer that
  // releases them exactly once (a reconnect keeps the face identity, so the
  // registration stays valid and the re-hydrated value notifies through it).
  const registered: string[] = []
  const released: string[] = []
  const remote = fakeRemote()
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const port = new RemoteInteractionPort({
    sessions: {
      scopeOf: () => undefined,
      binding: () => ({
        session: {
          projections: {
            faceOf: (key: string) => ({
              getSnapshot: () => key === 'userQuestions' ? { active: [], settled: [] } : { 'next-step': [], 'next-turn': [] },
              subscribe: (listener: () => void) => {
                registered.push(key)
                listener // the face notifies with no arguments
                return () => { released.push(key) }
              },
            }),
          },
        },
      }),
    },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  let notified = 0
  const off = port.questions.subscribe('session-a', () => { notified += 1 })
  assert.ok(off !== undefined)
  assert.deepEqual(registered.sort(), ['inbox', 'userQuestions'], 'both durable projects are observed')
  off()
  assert.deepEqual(released.sort(), ['inbox', 'userQuestions'], 'each registration is released once')
  assert.equal(notified, 0)

  // No binding (detached connection) reports that it cannot observe.
  const detached = new RemoteInteractionPort({
    sessions: { scopeOf: () => undefined, binding: () => undefined },
    remote: remote as never,
    connection: { generation: generation.source },
  })
  assert.equal(detached.questions.subscribe('session-a', () => {}), undefined)
})
