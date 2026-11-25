/**
 * L1/L3 contract tests for the M5-U-A Remote read-authority adapter.
 *
 * The tests prove the FIXED U-A classification (never a union/guess), the
 * per-row Unknown/Denied retention, the caller-owned roster, the generation
 * fence, the bounded passive-read concurrency and the per-open Workspace
 * stream's baseline/increment/dispose semantics. They use a structural fake of
 * the official Client faces: this is Adapter semantics (L3), not a real
 * Client/Host wire (L5) and not a real OS qualification.
 *
 * @module @xmoon76/dsh-pi-tui/remote-session-workspace-facts.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIVITY_READ_CAPACITY,
  ACTIVITY_RECHECK_MS,
  WORKSPACE_RESUME_TIMEOUT_MS,
  RemoteSessionWorkspaceFacts,
  type RemoteStreamItemLike,
  SESSION_FACTS_READ_CONCURRENCY,
  classifyReadFailure,
  deriveAttention,
  readPending,
  readQuestionProjection,
  type RemoteSessionFactsRemotes,
  type RemoteSessionWorkspaceFactsSource,
} from '../../../src/runtime/remote/session-workspace-facts-remote.ts'
import type { RemoteWorkspaceFollowFrameLike, RemoteWorkspaceNamespaceLike } from '../../../src/runtime/remote/session-lifecycle-remote.ts'
import type {
  RemoteConnectionGenerationSource,
  RemoteSessionsReadSource,
} from '../../../src/runtime/remote/session-reader-remote.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import type { SessionSummary } from '../../../src/runtime/session-reader-port.ts'
import type { SessionPendingKind, WorkspaceFactsFrame } from '../../../src/runtime/session-workspace-facts-port.ts'
import type { RemoteProjectionValues } from '../../../src/runtime/remote/session-reader-remote.ts'
import {
  silentSessionStatusEvents,
  TestRemoteStreamCarrierError,
  unconfiguredWorkspaceStream,
} from '../../support/remote-session-workspace-source.ts'

// ── L1: the fixed classification ────────────────────────────────────────────

const KNOWN_IDLE = { kind: 'known' as const, running: false, pendingKinds: [] as readonly SessionPendingKind[] }

test('UA-02 an approval pending input classifies as approval', () => {
  const facts = deriveAttention({ kind: 'known', running: true, pendingKinds: ['approval'] }, { kind: 'unknown' })
  assert.equal(facts.attention, 'approval')
  assert.equal(facts.attentionSourceState, 'known')
})

test('UA-06 plan-review comes ONLY from the official AskUserQuestionItem intent', () => {
  const review = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: { active: [{ callId: 'c1', state: 'open', questions: [{ id: 'q', question: 'plan?', intent: { kind: 'plan-review', approve: 'Go' } }] }], settled: [] },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  })
  assert.deepEqual(
    deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, review).attention,
    'plan-review',
  )
  // Only the OPEN pending candidates count: an unrelated continued plan-review
  // must not relabel a different currently-pending question.
  const unrelatedContinued = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: {
        active: [
          { callId: 'old', state: 'continued', questions: [{ id: 'q', question: 'p', intent: { kind: 'plan-review', approve: 'Go' } }] },
          { callId: 'now', state: 'open', questions: [{ id: 'q', question: 'Continue?' }] },
        ],
        settled: [],
      },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  })
  assert.equal(deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, unrelatedContinued).attention, 'question',
    'a continued plan-review never labels the current open question')
  // Multiple open candidates with mixed intents are not guessed as plan-review.
  const mixedOpen = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: {
        active: [
          { callId: 'a', state: 'open', questions: [{ id: 'q', question: 'p', intent: { kind: 'plan-review', approve: 'Go' } }] },
          { callId: 'b', state: 'open', questions: [{ id: 'q', question: 'plain' }] },
        ],
        settled: [],
      },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  })
  assert.equal(deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, mixedOpen).attention, 'question')
  // An open plan-review whose reply is already queued is not the pending one.
  const queuedReview = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: { active: [{ callId: 'a', state: 'open', questions: [{ id: 'q', question: 'p', intent: { kind: 'plan-review', approve: 'Go' } }] }], settled: [] },
      inbox: { 'next-step': [], 'next-turn': [{ source: { kind: 'user-question-reply', callId: 'a' } }] },
    },
  })
  assert.equal(deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, queuedReview).attention, 'question')
  // The unreadable-inbox case keeps the generic question label.
  const noInboxReview = readQuestionProjection({
    kind: 'sequenced',
    values: { userQuestions: { active: [{ callId: 'a', state: 'open', questions: [{ id: 'q', question: 'p', intent: { kind: 'plan-review', approve: 'Go' } }] }], settled: [] } },
  })
  assert.equal(deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, noInboxReview).attention, 'question')
  // A title/snippet/option label never becomes a plan-review signal.
  const textOnly = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: { active: [{ callId: 'c1', state: 'open', questions: [{ id: 'q', question: 'plan-review', header: 'plan-review', options: [{ label: 'plan-review' }] }] }], settled: [] },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  })
  assert.equal(deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, textOnly).attention, 'question')
})

test('UA-02 an unknown pending kind is never guessed as question or approval', () => {
  const facts = deriveAttention({ kind: 'known', running: true, pendingKinds: ['other'] }, { kind: 'unknown' })
  assert.equal(facts.attention, 'unknown')
  assert.equal(facts.attentionSourceState, 'unknown')
})

test('UA-02 a pending question without a readable projection stays a question', () => {
  const facts = deriveAttention({ kind: 'known', running: true, pendingKinds: ['question'] }, { kind: 'unknown' })
  assert.equal(facts.attention, 'question')
  assert.equal(facts.attentionSourceState, 'known')
  assert.equal(facts.continuedQuestionCallIds, undefined)
})

test('UA-05 none requires BOTH official sources to be readable and empty', () => {
  const empty = readQuestionProjection({
    kind: 'sequenced',
    values: { userQuestions: { active: [], settled: [] }, inbox: { 'next-step': [], 'next-turn': [] } },
  })
  assert.equal(deriveAttention(KNOWN_IDLE, empty).attention, 'none')
  // projection null / migration-required / missing unit are unknown, never none.
  assert.equal(deriveAttention(KNOWN_IDLE, readQuestionProjection(null)).attention, 'unknown')
  assert.equal(deriveAttention(KNOWN_IDLE, readQuestionProjection({ kind: 'migration-required', values: {} })).attention, 'unknown')
  assert.equal(deriveAttention(KNOWN_IDLE, readQuestionProjection({ kind: 'sequenced', values: { inbox: {} } })).attention, 'unknown')
  // an unreadable inbox cannot confirm that no continued call is answerable.
  const noInbox = readQuestionProjection({
    kind: 'sequenced',
    values: { userQuestions: { active: [{ callId: 'c1', state: 'continued', questions: [] }], settled: [] } },
  })
  assert.equal(deriveAttention(KNOWN_IDLE, noInbox).attention, 'unknown')
  assert.equal(deriveAttention(KNOWN_IDLE, noInbox).continuedQuestionCallIds, undefined)
})

test('UA-05 a continued call is a late-answer candidate unless its reply is already queued', () => {
  const continued = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: { active: [{ callId: 'c1', state: 'continued', questions: [] }, { callId: 'c2', state: 'continued', questions: [] }], settled: [] },
      inbox: { 'next-step': [], 'next-turn': [{ source: { kind: 'user-question-reply', callId: 'c2' } }] },
    },
  })
  assert.deepEqual(continued.kind === 'known' ? continued.queuedReplyCallIds : undefined, new Set(['c2']))
  const facts = deriveAttention(KNOWN_IDLE, continued)
  assert.equal(facts.attention, 'question')
  assert.deepEqual(facts.continuedQuestionCallIds, ['c1'], 'the queued callId is not answerable')
  // A pendingInput=[] sample never overrides a real continued answerable call.
  assert.equal(facts.attentionSourceState, 'known')
  const mixedContinued = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: {
        active: [
          { callId: 'c1', state: 'continued', questions: [{ id: 'q', question: 'p', intent: { kind: 'plan-review', approve: 'Go' } }] },
          { callId: 'c2', state: 'continued', questions: [{ id: 'q', question: 'plain' }] },
        ],
        settled: [],
      },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  })
  assert.equal(deriveAttention(KNOWN_IDLE, mixedContinued).attention, 'question',
    'mixed continued intents are not guessed as plan-review')
})

test('UA-02/UA-05 an open timed call with no Gateway pending input fails closed to unknown', () => {
  const open = readQuestionProjection({
    kind: 'sequenced',
    values: {
      userQuestions: { active: [{ callId: 'c1', state: 'open', questions: [] }], settled: [] },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  })
  assert.equal(deriveAttention(KNOWN_IDLE, open).attention, 'unknown')
})

test('UA-02 a malformed state/projection shape is unknown, never an empty fact', () => {
  assert.equal(readPending(undefined).kind, 'unknown')
  assert.equal(readPending({ running: 'yes', pendingInput: [] }).kind, 'unknown')
  assert.equal(readPending({ running: true, pendingInput: ['approval-like'] }).kind, 'unknown')
  assert.equal(readQuestionProjection({ kind: 'sequenced', values: { userQuestions: { active: [{ callId: '', state: 'open', questions: [] }], settled: [] } } }).kind, 'unknown')
  assert.equal(classifyReadFailure({ code: 'remote-access/denied' }), 'denied')
  assert.equal(classifyReadFailure({ code: 'gateway/invocation-unavailable' }), 'unavailable')
  assert.equal(classifyReadFailure({ code: 'gateway/internal' }), 'unknown')
  assert.equal(classifyReadFailure(new Error('timeout')), 'unknown')
})

// ── L3: the adapter over the official Client faces ──────────────────────────

interface ReadOutcome {
  readonly result: unknown
}

interface Harness {
  readonly facts: RemoteSessionWorkspaceFacts
  readonly stateCalls: string[]
  readonly projectionCalls: string[]
  readonly otherCalls: string[]
  readonly generation: RemoteConnectionGenerationSource
  setGeneration(id: string | undefined): void
  /** Fire the official list notification (the same subscribers the adapter holds). */
  notifyList(): void
  /** Replace the official listed rows (membership/order/running inputs). */
  setListed(next: readonly SessionSummary[]): void
  /** Replace one official list row's running bit. */
  setRunning(id: string, running: boolean): void
  /** Replace one Session's shared-store projection values (a scheduling witness). */
  setProjectionValues(id: string, values: RemoteProjectionValues | undefined): void
  /** Replace the borrowed binding identity (or remove it). */
  setBinding(next: unknown): void
  /** The live subscription counts, for dispose proof. */
  subscribers(): { readonly list: number; readonly generation: number }
}

function harness(options: {
  listed?: readonly SessionSummary[]
  /** The official list row `running` bits, INDEPENDENT of `SessionSummary.live`. */
  listedRunning?: Readonly<Record<string, boolean>>
  listPhase?: 'pending' | 'ready'
  states?: Readonly<Record<string, ReadOutcome | { readonly failure: unknown }>>
  projections?: Readonly<Record<string, ReadOutcome | { readonly failure: unknown }>>
  stateGate?: (sessionId: string) => Promise<void>
  /** Block one row's `session.projections` read (the controlled blocked-RPC case). */
  projectionGate?: (sessionId: string) => Promise<void>
  /** Omit the current Connection generation entirely. */
  noGeneration?: boolean
  workspace?: RemoteWorkspaceNamespaceLike
  /** The shared projection store values (the scheduling hint source). */
  projectionsBySession?: Readonly<Record<string, { readonly values: RemoteProjectionValues; readonly state: 'idle' }>>
  events?: RemoteSessionWorkspaceFactsSource['events']
  workspaceStream?: RemoteSessionWorkspaceFactsSource['workspaceStream']
  initialGeneration?: RemoteSessionWorkspaceFactsSource['initialGeneration']
  /** Register a callback that receives the official list notification. */
  onListNotify?: (notify: () => void) => void
  /** The borrowed official binding identity (undefined = no binding, legal). */
  binding?: unknown
}): Harness {
  const stateCalls: string[] = []
  const projectionCalls: string[] = []
  const otherCalls: string[] = []
  let generation = options.noGeneration === true ? undefined : { id: 'gen-1' }
  let listed = options.listed ?? []
  let binding = options.binding
  let projectionStore = options.projectionsBySession ?? {}
  // The PR1 cases mutate their OWN `listedRunning` record in place to simulate
  // an official list transition; keep reading the caller's live record and use
  // the override map only for the Inspector-specific controlled setters.
  const runningOverrides = new Map<string, boolean>()
  const runningOf = (id: string): boolean =>
    runningOverrides.get(id) ?? options.listedRunning?.[id] ?? false
  const generationListeners = new Set<() => void>()
  const generationSource: RemoteConnectionGenerationSource = {
    getSnapshot: () => generation,
    subscribe: (listener: () => void) => {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  const listListeners = new Set<() => void>()
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: listed.map(row => row.id),
        byId: Object.fromEntries(listed.map(row => [row.id, {
          id: row.id,
          running: runningOf(row.id),
          updatedAt: row.updatedAt,
          ...(row.origin === undefined ? {} : { origin: row.origin }),
        }])),
        phase: options.listPhase ?? 'ready',
        projectionsBySession: projectionStore,
      }),
      subscribe: (listener: () => void) => {
        listListeners.add(listener)
        options.onListNotify?.(listener)
        return () => { listListeners.delete(listener) }
      },
    },
    refresh: async () => { otherCalls.push('refresh') },
    search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    binding: () => { otherCalls.push('binding'); return binding },
  } as unknown as RemoteSessionsReadSource
  const session: RemoteSessionFactsRemotes['session'] = {
    async state(request) {
      stateCalls.push(request.sessionId)
      if (options.stateGate !== undefined) await options.stateGate(request.sessionId)
      const outcome = options.states?.[request.sessionId]
      if (outcome === undefined) return { ok: true, value: { running: false, pendingInput: [] } }
      if ('failure' in outcome) throw outcome.failure
      return { ok: true, value: outcome.result as { readonly running: boolean; readonly pendingInput: readonly string[] } }
    },
    async projections(request) {
      projectionCalls.push(request.sessionId)
      if (options.projectionGate !== undefined) await options.projectionGate(request.sessionId)
      const outcome = options.projections?.[request.sessionId]
      if (outcome === undefined) return { ok: true, value: null }
      if ('failure' in outcome) throw outcome.failure
      return { ok: true, value: outcome.result }
    },
  }
  const source: RemoteSessionWorkspaceFactsSource = {
    sessions,
    remote: {
      session,
      workspace: options.workspace ?? (options.workspaceStream === undefined
        ? { create: async () => ({ ok: false, error: {} }), follow: () => { throw new Error('no workspace stream in this case') } }
        : {
            create: async () => ({ ok: false, error: {} }),
            // The scripted official stream drives the logical items itself; the
            // physical follow opened through `open` only needs a real handle.
            follow: () => ({
              [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> { await new Promise(() => {}) },
              dispose: () => {},
            }),
          }),
    },
    connection: { generation: generationSource },
    events: options.events ?? silentSessionStatusEvents(),
    workspaceStream: options.workspaceStream ?? unconfiguredWorkspaceStream(),
    initialGeneration: options.initialGeneration ?? generation,
  }
  return {
    facts: new RemoteSessionWorkspaceFacts(source),
    stateCalls,
    projectionCalls,
    otherCalls,
    generation: generationSource,
    setGeneration: id => {
      generation = id === undefined ? undefined : { id }
      for (const listener of [...generationListeners]) listener()
    },
    notifyList: () => {
      for (const listener of [...listListeners]) listener()
    },
    setListed: next => { listed = next },
    setRunning: (id, running) => { runningOverrides.set(id, running) },
    setProjectionValues: (id, values) => {
      const next = { ...projectionStore }
      if (values === undefined) delete next[id]
      else next[id] = { values, state: 'idle' as const }
      projectionStore = next
    },
    setBinding: next => { binding = next },
    subscribers: () => ({ list: listListeners.size, generation: generationListeners.size }),
  }
}

const row = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, updatedAt: 1, live: false, ...overrides })

test('UA-01 readActivity keeps the caller roster/order and never enumerates another corpus', async () => {
  const h = harness({
    listed: [row('x'), row('y'), row('child', { origin: 'subagent' })],
    listedRunning: { x: true, y: false },
    states: {
      x: { result: { running: true, pendingInput: ['question'] } },
      y: { result: { running: false, pendingInput: [] } },
    },
    projections: {
      x: { result: { kind: 'sequenced', values: { userQuestions: { active: [{ callId: 'c1', state: 'continued', questions: [] }], settled: [] }, inbox: { 'next-step': [], 'next-turn': [] } } } },
      y: { result: { kind: 'sequenced', values: { userQuestions: { active: [], settled: [] }, inbox: { 'next-step': [], 'next-turn': [] } } } },
    },
  })
  // The roster rows carry the OPPOSITE `live` bits: `running` must come from the
  // official list row, never the old attachment bit.
  const facts = await h.facts.readActivity([row('x', { live: false }), row('y', { live: true }), row('child', { origin: 'subagent' })])
  assert.deepEqual(facts.map(fact => fact.sessionId), ['x', 'y'], 'subagent rows never enter the facts and no id is added')
  assert.equal(facts[0].running, true, 'the official list-row running is true despite live:false')
  assert.equal(facts[1].running, false, 'the official list-row running is false despite live:true')
  assert.equal(facts[0].attention, 'question')
  assert.deepEqual(facts[0].continuedQuestionCallIds, ['c1'])
  assert.equal(facts[1].attention, 'none')
  assert.deepEqual(h.otherCalls, [], 'readActivity never refreshes, retains or binds a Session')
  // The caller roster is the only corpus: a listed-but-unpassed row is not read.
  assert.deepEqual(h.stateCalls.sort(), ['x', 'y'])
})

test('UA-01 a row read failure keeps an in-row Unknown/Denied and does not clear the other rows', async () => {
  const h = harness({
    listed: [row('denied'), row('unavailable'), row('broken')],
    listedRunning: { denied: true, unavailable: true, broken: false },
    states: {
      denied: { failure: { code: 'remote-access/denied' } },
      unavailable: { failure: { code: 'gateway/invocation-unavailable' } },
      broken: { failure: { code: 'gateway/internal' } },
    },
    projections: {
      denied: { failure: { code: 'remote-access/denied' } },
      unavailable: { failure: { code: 'gateway/invocation-unavailable' } },
      broken: { failure: { code: 'gateway/protocol' } },
    },
  })
  const facts = await h.facts.readActivity([row('denied'), row('unavailable'), row('broken')])
  assert.deepEqual(facts.map(fact => fact.attentionSourceState), ['denied', 'unavailable', 'unknown'])
  assert.ok(facts.every(fact => fact.attention === 'unknown'))
  assert.ok(facts.every(fact => fact.pendingKinds === undefined), 'a failed read is never zero pending')
  // The official list-row running bit still answers even when the passive state is denied.
  assert.deepEqual(facts.map(fact => fact.running), [true, true, false])
})

test('UA-01 the official list row owns normal running; the passive state only answers without a list row', async () => {
  const h = harness({
    listed: [row('list-running'), row('agree-idle'), row('state-only')],
    listedRunning: { 'list-running': true, 'agree-idle': false, 'state-only': false },
    // `list-running`'s passive state disagrees: the list row is the normal
    // authority (its status mutations are replayed by the Client Session
    // Manager), so no second cut is compared and no Unknown is fabricated.
    states: {
      'list-running': { result: { running: false, pendingInput: [] } },
      'agree-idle': { result: { running: false, pendingInput: [] } },
      'no-list-row': { result: { running: true, pendingInput: [] } },
      'state-only': { failure: { code: 'gateway/internal' } },
    },
    projections: {},
  })
  const facts = await h.facts.readActivity([row('list-running'), row('agree-idle'), row('state-only'), row('no-list-row')])
  assert.equal(facts[0].running, true, 'the list row is the normal running authority')
  assert.equal(facts[1].running, false)
  // A listed row whose list entry exists keeps the list answer even when the
  // passive state failed: the two sources are never compared.
  assert.equal(facts[2].running, false, 'a failed passive state never overrides the list row')
  // An id with NO list row answers from the passive state (the pending list
  // phase case); the roster alone is not a running authority.
  assert.equal(facts[3].running, true, 'without a list row the passive state answers')
})

test('UA-01 a pending list phase is not an idle claim: running comes from the passive state', async () => {
  const h = harness({
    listed: [row('x'), row('broken')],
    listPhase: 'pending',
    states: {
      x: { result: { running: true, pendingInput: ['question'] } },
      broken: { failure: { code: 'gateway/internal' } },
    },
    projections: { x: { failure: { code: 'gateway/internal' } }, broken: { failure: { code: 'gateway/internal' } } },
  })
  const facts = await h.facts.readActivity([row('x'), row('broken')])
  assert.equal(facts[0].running, true, 'the Host state still proves running with no ready list snapshot')
  assert.equal(facts[0].attention, 'question')
  assert.equal(facts[1].running, undefined, 'a failed state read is unknown, never idle')
  assert.equal(facts[1].attentionSourceState, 'unknown')
})

test('UA-10 no current generation rejects the sample instead of reporting zero facts', async () => {
  const h = harness({ noGeneration: true })
  await assert.rejects(() => h.facts.readActivity([row('x')]), SupersededReadError)
})

test('UA-10 a generation replacement during the read discards the WHOLE sample', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed: [row('x', { live: true })],
    stateGate: async () => { await gate },
  })
  const pending = h.facts.readActivity([row('x')])
  h.setGeneration('gen-2')
  release()
  await assert.rejects(() => pending, SupersededReadError)
})

test('UA-10 an abort rejects the sample instead of publishing it', async () => {
  const controller = new AbortController()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed: [row('x', { live: true })],
    stateGate: async () => { await gate },
  })
  const pending = h.facts.readActivity([row('x')], controller.signal)
  controller.abort()
  release()
  await assert.rejects(() => pending, (error: unknown) => (error as Error).name === 'AbortError')
})

test('UA-09 the passive read batch is bounded by the fixed concurrency', async () => {
  const ids = Array.from({ length: SESSION_FACTS_READ_CONCURRENCY * 2 }, (_, index) => `s${index}`)
  let inFlight = 0
  let peak = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed: ids.map(id => row(id, { live: true })),
    stateGate: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await gate
      inFlight -= 1
    },
  })
  const pending = h.facts.readActivity(ids.map(id => row(id)))
  while (peak < SESSION_FACTS_READ_CONCURRENCY) await new Promise<void>(resolve => setTimeout(resolve, 1))
  assert.equal(peak, SESSION_FACTS_READ_CONCURRENCY)
  release()
  const facts = await pending
  assert.equal(facts.length, ids.length, 'the concurrency bound never truncates the roster')
  assert.deepEqual(facts.map(fact => fact.sessionId), ids)
})

// ── L3: the per-open Workspace stream ────────────────────────────────────────

function workspaceNamespace(frames: readonly RemoteWorkspaceFollowFrameLike[]): {
  readonly namespace: RemoteWorkspaceNamespaceLike
  readonly disposed: () => number
  readonly follows: () => number
  onFrame(callback: (index: number) => void): void
} {
  let disposeCount = 0
  let followCount = 0
  let hook: (index: number) => void = () => {}
  const namespace: RemoteWorkspaceNamespaceLike = {
    create: async () => ({ ok: false, error: {} }),
    follow: () => {
      followCount += 1
      let disposed = false
      return {
        [Symbol.asyncIterator]: async function* () {
          for (let index = 0; index < frames.length; index += 1) {
            hook(index)
            yield frames[index]
          }
        },
        dispose: () => {
          if (disposed) return
          disposed = true
          disposeCount += 1
        },
      }
    },
  }
  return {
    namespace,
    disposed: () => disposeCount,
    follows: () => followCount,
    onFrame: callback => { hook = callback },
  }
}

const workspaceView = (id: string, sessionIds: readonly string[] = []) =>
  ({ workspaceId: id, path: `/host/${id}`, title: `Workspace ${id}`, sessionIds })

test('UA-07 the Workspace stream forwards baseline + every official increment and ignores archived/pinned', async () => {
  const workspace = workspaceNamespace([
    { type: 'baseline', value: { items: [workspaceView('a', ['s1'])] } },
    { type: 'upsert', workspace: workspaceView('b') },
    { type: 'order', workspaceIds: ['b', 'a'] },
    { type: 'archived', archivedSessionIds: ['s9'] },
    { type: 'pinned', pinnedSessionIds: ['s1'] },
    { type: 'remove', workspaceId: 'a' },
    { type: 'replace', value: { items: [workspaceView('c')] } },
  ])
  const h = harness({ workspace: workspace.namespace })
  const handle = h.facts.followWorkspaces()
  const got: unknown[] = []
  for await (const frame of handle) got.push(frame)
  assert.deepEqual(got, [
    { type: 'baseline', items: [{ workspaceId: 'a', path: '/host/a', title: 'Workspace a', sessionIds: ['s1'] }] },
    { type: 'upsert', workspace: { workspaceId: 'b', path: '/host/b', title: 'Workspace b', sessionIds: [] } },
    { type: 'order', workspaceIds: ['b', 'a'] },
    { type: 'remove', workspaceId: 'a' },
    { type: 'replace', items: [{ workspaceId: 'c', path: '/host/c', title: 'Workspace c', sessionIds: [] }] },
  ])
  assert.equal(workspace.follows(), 1)
  assert.equal(workspace.disposed(), 1, 'the per-open stream is disposed exactly once')
  // The caller's own dispose is idempotent.
  handle.dispose()
  assert.equal(workspace.disposed(), 1)
})

test('UA-07 a stream without a baseline is an unknown Workspace state, never an empty one', async () => {
  const workspace = workspaceNamespace([{ type: 'upsert', workspace: workspaceView('a') }])
  const h = harness({ workspace: workspace.namespace })
  const handle = h.facts.followWorkspaces()
  await assert.rejects(async () => { for await (const _ of handle) { assert.fail('no frame may be published') } },
    /did not begin with a baseline/u)
  assert.equal(workspace.disposed(), 1)
})

test('UA-07 a stream that ends before its baseline publishes nothing', async () => {
  const workspace = workspaceNamespace([])
  const h = harness({ workspace: workspace.namespace })
  const handle = h.facts.followWorkspaces()
  await assert.rejects(async () => { for await (const _ of handle) { assert.fail('no frame may be published') } },
    /ended before its baseline/u)
})

test('UA-10 a generation replacement ends the open Workspace stream', async () => {
  const workspace = workspaceNamespace([
    { type: 'baseline', value: { items: [] } },
    { type: 'upsert', workspace: workspaceView('late') },
  ])
  const h = harness({ workspace: workspace.namespace })
  const handle = h.facts.followWorkspaces()
  workspace.onFrame(index => { if (index === 1) h.setGeneration('gen-2') })
  const iterator = handle[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.deepEqual(first, { done: false, value: { type: 'baseline', items: [] } })
  await assert.rejects(() => iterator.next(), SupersededReadError)
  assert.equal(workspace.disposed(), 1)
})

test('UA-10 the open Workspace handle becomes non-current after a generation replacement', () => {
  const workspace = workspaceNamespace([{ type: 'baseline', value: { items: [] } }])
  const h = harness({ workspace: workspace.namespace })
  const handle = h.facts.followWorkspaces()
  assert.equal(handle.isCurrent(), true, 'the freshly opened baseline is current')
  h.setGeneration('gen-2')
  assert.equal(handle.isCurrent(), false,
    'a replacement makes the baseline unusable for a paired roster read')
  handle.dispose()
})

test('UA-10 a disposed Workspace handle is never current', () => {
  const workspace = workspaceNamespace([{ type: 'baseline', value: { items: [] } }])
  const h = harness({ workspace: workspace.namespace })
  const handle = h.facts.followWorkspaces()
  handle.dispose()
  assert.equal(handle.isCurrent(), false)
})

test('UA-10 an already-aborted signal never opens a Workspace stream', () => {
  const controller = new AbortController()
  controller.abort()
  const workspace = workspaceNamespace([{ type: 'baseline', value: { items: [] } }])
  const h = harness({ workspace: workspace.namespace })
  assert.throws(() => h.facts.followWorkspaces(controller.signal),
    (error: unknown) => (error as Error).name === 'AbortError')
  assert.equal(workspace.follows(), 0, 'no official stream is opened for an aborted generation')
})

test('UA-09 a Workspace stream cannot be opened without a current generation', () => {
  const h = harness({ noGeneration: true })
  assert.throws(() => h.facts.followWorkspaces(), SupersededReadError)
})

// ── L3: the per-open INCREMENTAL Activity observation ───────────────────────

/** Run one observation case and ALWAYS release its recheck timer. */
async function withObservation(
  h: Harness,
  run: (observation: import('../../../src/runtime/session-workspace-facts-port.ts').ActivityObservation) => Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  const observation = h.facts.observeActivity(controller.signal)
  try {
    await run(observation)
  } finally {
    observation.dispose()
    controller.abort()
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

function activityRow(id: string, updatedAt = 1): SessionSummary {
  return { id, updatedAt, live: false }
}

const emptyQuestions = { kind: 'sequenced', values: { userQuestions: { active: [], settled: [] }, inbox: { 'next-step': [], 'next-turn': [] } } }

test('UA-11 the observation publishes the official running projection with the roster and schedules bounded work', async () => {
  const h = harness({
    listed: [activityRow('a'), activityRow('b'), activityRow('c')],
    listedRunning: { a: true, b: false, c: false },
    projections: { a: { result: emptyQuestions }, b: { result: emptyQuestions }, c: { result: emptyQuestions } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a'), activityRow('b'), activityRow('c')], 1, 'a')
    const snapshot = observation.getSnapshot()
    assert.equal(snapshot.rosterRevision, 1)
    assert.deepEqual(snapshot.facts.map(fact => fact.sessionId), ['a', 'b', 'c'], 'one fact per authorized row, in roster order')
    assert.deepEqual(snapshot.facts.map(fact => fact.running), [true, false, false],
      'the official list running projection is published in the SAME roster frame')
    assert.ok(snapshot.facts.every(fact => fact.attention === 'unknown' && fact.pendingKinds === undefined),
      'an unmeasured row is honestly unknown, never idle/none')
    // The current Session is priority work; the ordinary rows get ONE background
    // discovery each. All three are scheduled without blocking the roster frame.
    await waitFor(() => h.projectionCalls.length >= 3, 'every unresolved row receives its discovery')
    await waitFor(() => h.stateCalls.includes('a'), 'the priority candidate is sampled as an exact pair')
    assert.equal(h.stateCalls.filter(id => id === 'a').length, 1, 'the priority row is never sampled twice concurrently')
    assert.equal(h.stateCalls.filter(id => id === 'b' || id === 'c').length, 0,
      'ordinary rows never get a Gateway state sample from discovery alone')
  })
})

test('UA-11 the observation keeps at most four ACTUAL unary requests across both lanes', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `s${index}`)
  let inFlight = 0
  let peak = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const gateCall = async (): Promise<void> => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await gate
    inFlight -= 1
  }
  const h = harness({
    listed: ids.map(id => activityRow(id)),
    listedRunning: Object.fromEntries(ids.map(id => [id, false])),
    states: Object.fromEntries(ids.map(id => [id, { result: { running: false, pendingInput: [] } }])),
    projections: Object.fromEntries(ids.map(id => [id, { result: emptyQuestions }])),
    stateGate: gateCall,
  })
  await withObservation(h, async (observation) => {
    observation.setPriorityIds(new Set(ids.slice(0, 6)))
    observation.setRoster(ids.map(id => activityRow(id)), 1, ids[0])
    await waitFor(() => peak === ACTIVITY_READ_CAPACITY, 'the observation reaches its documented capacity')
    assert.equal(peak, ACTIVITY_READ_CAPACITY, 'peak actual unary concurrency is exactly the fixed capacity')
    release()
    await waitFor(() => h.projectionCalls.length + h.stateCalls.length >= ids.length, 'the queue drains after the gate')
  })
  release()
})

test('UA-11 an unchanged relevant source revision never repeats an ordinary discovery', async () => {
  let notifyList: (() => void) | undefined
  const h = harness({
    listed: [activityRow('a'), activityRow('b')],
    listedRunning: { a: false, b: false },
    projections: { a: { result: emptyQuestions }, b: { result: emptyQuestions } },
    onListNotify: notify => { notifyList = notify },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a'), activityRow('b')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 2, 'both ordinary rows are discovered once')
    const afterFirst = h.projectionCalls.length
    // The official list re-publishes unchanged content: a status/projection
    // notification that changes no relevant semantics must not requeue anything.
    notifyList?.()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(h.projectionCalls.length, afterFirst, 'an unchanged source revision never repeats discovery')
    assert.ok(observation.getSnapshot().revision >= 1, 'the roster commit itself published')
  })
})

test('UA-11 a discovery that finds a real active entry promotes the row and reuses the exact projection', async () => {
  const continued = {
    kind: 'sequenced',
    values: {
      userQuestions: { active: [{ callId: 'c1', state: 'continued', questions: [] }], settled: [] },
      inbox: { 'next-step': [], 'next-turn': [] },
    },
  }
  const h = harness({
    listed: [activityRow('a'), activityRow('cold')],
    listedRunning: { a: false, cold: false },
    states: { cold: { result: { running: true, pendingInput: [] } } },
    projections: { a: { result: emptyQuestions }, cold: { result: continued } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a'), activityRow('cold')], 1, 'a')
    await waitFor(() => observation.getSnapshot().facts.some(fact => fact.sessionId === 'cold' && fact.attention === 'question'),
      'the discovered continued call becomes a real attention fact after the exact state sample')
    const coldFact = observation.getSnapshot().facts.find(fact => fact.sessionId === 'cold')!
    assert.deepEqual(coldFact.continuedQuestionCallIds, ['c1'], 'the continued call is the late-answer candidate')
    assert.equal(coldFact.attentionSourceState, 'known')
    assert.equal(h.projectionCalls.filter(id => id === 'cold').length, 1,
      'the promoted row reuses the discovery response instead of a second projections read')
    assert.equal(h.stateCalls.filter(id => id === 'cold').length, 1)
  })
})

test('UA-11 a denied discovery stays unknown and never becomes a successful negative', async () => {
  let notifyList: (() => void) | undefined
  const h = harness({
    listed: [activityRow('denied')],
    listedRunning: { denied: false },
    projections: { denied: { failure: { code: 'remote-access/denied' } } },
    onListNotify: notify => { notifyList = notify },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('denied')], 1, undefined)
    await waitFor(() => observation.getSnapshot().facts[0]?.attentionSourceState === 'denied',
      'the denied discovery commits its truthful reason')
    const fact = observation.getSnapshot().facts[0]!
    assert.equal(fact.attention, 'unknown')
    assert.equal(fact.attentionSourceState, 'denied', 'the denial stays a truthful reason, never none')
    assert.equal(fact.pendingKinds, undefined)
    notifyList?.()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(h.projectionCalls.length, 1, 'a denied discovery is not retried on the same unchanged witness')
  })
})

test('UA-11 a generation replacement revokes every positive fact and re-runs one discovery pass', async () => {
  const h = harness({
    listed: [activityRow('a')],
    listedRunning: { a: true },
    states: { a: { result: { running: true, pendingInput: ['question'] } } },
    projections: { a: { result: { kind: 'sequenced', values: { userQuestions: { active: [{ callId: 'c1', state: 'open', questions: [] }], settled: [] }, inbox: { 'next-step': [], 'next-turn': [] } } } } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a')], 1, 'a')
    await waitFor(() => observation.getSnapshot().facts[0]?.attention === 'question', 'the exact pair classifies the pending question')
    const before = h.projectionCalls.length
    h.setGeneration('gen-2')
    const revoked = observation.getSnapshot().facts[0]!
    assert.equal(revoked.running, undefined, 'the old generation running proof is revoked')
    assert.equal(revoked.attention, 'unknown', 'the old generation attention proof is revoked')
    await waitFor(() => h.projectionCalls.length > before, 'the new generation runs its one discovery pass')
  })
})

test('UA-11 a current-generation status event re-proves running after a rollover', async () => {
  let statusListener: ((sessionId: string, running: boolean) => void) | undefined
  const h = harness({
    listed: [activityRow('a')],
    listedRunning: { a: false },
    states: { a: { result: { running: false, pendingInput: [] } } },
    projections: { a: { result: emptyQuestions } },
    events: { onSessionStatus: listener => { statusListener = listener; return () => { statusListener = undefined } } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a')], 1, 'a')
    await waitFor(() => observation.getSnapshot().facts[0]?.attentionSourceState === 'known', 'the first exact pair lands')
    h.setGeneration('gen-2')
    assert.equal(observation.getSnapshot().facts[0]?.running, undefined, 'a replayed list cannot re-prove running')
    statusListener?.('a', true)
    await waitFor(() => observation.getSnapshot().facts[0]?.running === true, 'the current-generation status event proves running')
  })
})

test('UA-11 disposing the observation aborts its work and publishes nothing afterwards', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed: [activityRow('a')],
    listedRunning: { a: true },
    stateGate: async () => { await gate },
  })
  const controller = new AbortController()
  const observation = h.facts.observeActivity(controller.signal)
  observation.setRoster([activityRow('a')], 1, 'a')
  await waitFor(() => h.stateCalls.length === 1, 'the priority read started')
  const revision = observation.getSnapshot().revision
  const published: number[] = []
  observation.subscribe(() => published.push(observation.getSnapshot().revision))
  observation.dispose()
  release()
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.deepEqual(published, [], 'a disposed observation never notifies')
  assert.equal(observation.getSnapshot().revision, revision)
  controller.abort()
})

test('UA-11 an already-aborted signal never opens an observation', () => {
  const controller = new AbortController()
  controller.abort()
  const h = harness({})
  assert.throws(() => h.facts.observeActivity(controller.signal),
    (error: unknown) => (error as Error).name === 'AbortError')
})

// ── L3: the OFFICIAL reconnecting Workspace lifecycle ───────────────────────

/** Drive ONE structural `$stream` lifecycle the way the official supervisor
 *  does: the scripted physical generations, then a live wait until the handle
 *  is disposed (a real logical stream never ends on its own). */
function scriptedWorkspaceStream(
  script: (options: {
    readonly carrierFailed?: (error: Error) => void
  }) => readonly { readonly generation: number; readonly frame: RemoteWorkspaceFollowFrameLike }[],
  onItem?: (generation: number) => void,
  behaviour: { readonly emitCarrierFailure?: boolean; readonly stall?: boolean } = {},
): {
  readonly source: RemoteSessionWorkspaceFactsSource['workspaceStream']
  readonly accepted: number[]
  readonly lastOptions: () => Parameters<RemoteSessionWorkspaceFactsSource['workspaceStream']['stream']>[0] | undefined
  readonly carrierFailures: Error[]
  readonly disposed: () => number
} {
  const emitCarrierFailures = behaviour.emitCarrierFailure !== false
  const accepted: number[] = []
  const carrierFailures: Error[] = []
  let lastOptions: Parameters<RemoteSessionWorkspaceFactsSource['workspaceStream']['stream']>[0] | undefined
  let disposeCount = 0
  const source: RemoteSessionWorkspaceFactsSource['workspaceStream'] = {
    stream: (options) => {
      lastOptions = options
      let finish!: () => void
      const live = new Promise<void>(resolve => { finish = resolve })
      // The official supervisor opens ONE physical follow per physical
      // generation through the same `open` callback the adapter owns.
      const physical: unknown[] = []
      const iterator = (async function* (): AsyncGenerator<RemoteStreamItemLike<RemoteWorkspaceFollowFrameLike>> {
        let acceptedGeneration: number | undefined
        let openedGeneration: number | undefined
        for (const item of script(options)) {
          // The official wait-for-reconnect establishes the replacement
          // Connection BEFORE the new physical open runs.
          onItem?.(item.generation)
          if (item.generation !== openedGeneration) {
            openedGeneration = item.generation
            physical.push(options.open(new AbortController().signal))
          }
          const emitCarrierFailure = options.carrierFailed !== undefined && emitCarrierFailures
          if (item.generation !== acceptedGeneration && emitCarrierFailure && accepted.length > 0 && item.generation > 1) {
            const error = new TestRemoteStreamCarrierError('api gateway: Remote stream WebSocket closed')
            carrierFailures.push(error)
            options.carrierFailed(error)
          }
          yield {
            generation: item.generation,
            value: item.frame,
            signal: new AbortController().signal,
            accept: () => {
              if (acceptedGeneration === item.generation) return
              acceptedGeneration = item.generation
              accepted.push(item.generation)
            },
          }
        }
        if (behaviour.stall === true) {
          // The physical carrier is lost with NO further item: a real
          // reconnect delivers or a truthful terminal failure ends the follow.
          options.carrierFailed?.(new TestRemoteStreamCarrierError('api gateway: Remote stream WebSocket closed'))
        }
        await live
      })()
      return {
        [Symbol.asyncIterator]: () => iterator,
        dispose: async () => {
          disposeCount += 1
          for (const handle of physical) (handle as { dispose?(): void }).dispose?.()
          physical.length = 0
          finish()
        },
        restart: () => {},
      }
    },
    // A test-defined class: the adapter must construct ITS carrier error from
    // the exact constructor the source supplies.
    carrierError: TestRemoteStreamCarrierError,
  }
  return {
    source,
    accepted,
    lastOptions: () => lastOptions,
    carrierFailures,
    disposed: () => disposeCount,
  }
}

test('UA-12 a recovering follow invalidates membership on a carrier failure and restores a fresh baseline in the SAME handle', async () => {
  const stream = scriptedWorkspaceStream(() => [
    { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('old')] } } },
    { generation: 2, frame: { type: 'baseline', value: { items: [workspaceView('new')] } } },
    { generation: 2, frame: { type: 'upsert', workspace: workspaceView('extra') } },
  ])
  const h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const frames: WorkspaceFactsFrame[] = []
  for (let index = 0; index < 4; index += 1) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    frames.push(next.value)
  }
  // A same-Connection carrier retry keeps the SAME attempt identity (A/A
  // control): only a real Connection replacement makes it B.
  const attempted = handle.attemptedGeneration?.()
  assert.deepEqual(attempted, { id: 'gen-1' },
    'a same-Connection carrier retry keeps the attempt identity')
  handle.dispose()
  await iterator.next()
  assert.deepEqual(frames, [
    { type: 'baseline', items: [{ workspaceId: 'old', path: '/host/old', title: 'Workspace old', sessionIds: [] }] },
    { type: 'invalidated', reason: 'reconnecting' },
    { type: 'baseline', items: [{ workspaceId: 'new', path: '/host/new', title: 'Workspace new', sessionIds: [] }] },
    { type: 'upsert', workspace: { workspaceId: 'extra', path: '/host/extra', title: 'Workspace extra', sessionIds: [] } },
  ])
  assert.equal(stream.carrierFailures.length, 1)
  assert.equal(stream.carrierFailures[0]!.constructor, TestRemoteStreamCarrierError,
    'the reported carrier loss is the official same-installation class')
  assert.deepEqual(stream.accepted, [1, 2], 'each physical generation accepts exactly ONE opening baseline')
})

test('UA-12 the recovering ended() classification uses the SAME carrier-error constructor for an accepted generation', async () => {
  const stream = scriptedWorkspaceStream(() => [])
  const h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const pending = iterator.next()
  const options = stream.lastOptions()
  assert.ok(options !== undefined, 'the recovering handle opened the official stream factory')
  const acceptedEnd = options!.ended(true)
  assert.equal(acceptedEnd.constructor, TestRemoteStreamCarrierError,
    'an accepted baseline that then ends is a retryable carrier loss of the SAME installation class')
  const unopenedEnd = options!.ended(false)
  assert.notEqual(unopenedEnd.constructor, TestRemoteStreamCarrierError,
    'an end before the baseline is a real protocol/availability error, not a retryable carrier loss')
  handle.dispose()
  await pending
})

test('UA-12 a terminal recovering failure ends the handle truthfully and never retries the same generation', async () => {
  let streams = 0
  const h = harness({
    workspaceStream: {
      carrierError: TestRemoteStreamCarrierError,
      stream: () => {
        streams += 1
        const iterator = (async function* (): AsyncGenerator<RemoteStreamItemLike<RemoteWorkspaceFollowFrameLike>> {
          yield {
            generation: 1,
            value: { type: 'baseline', value: { items: [] } },
            signal: new AbortController().signal,
            accept: () => {},
          }
          throw new Error('the Host denied the Workspace follow')
        })()
        return { [Symbol.asyncIterator]: () => iterator, dispose: async () => {}, restart: () => {} }
      },
    },
  })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  await assert.rejects(async () => { for await (const _frame of handle) { /* consume */ } },
    /the Host denied the Workspace follow/u)
  assert.equal(streams, 1, 'no same-generation retry and no duplicate logical stream')
})

test('UA-12 the one-shot follow never consumes the reconnecting stream source', async () => {
  let streams = 0
  const workspace = workspaceNamespace([{ type: 'baseline', value: { items: [workspaceView('only')] } }])
  const h = harness({
    workspace: workspace.namespace,
    workspaceStream: {
      carrierError: TestRemoteStreamCarrierError,
      stream: () => {
        streams += 1
        throw new Error('the one-shot contract must not open the reconnecting stream')
      },
    },
  })
  const handle = h.facts.followWorkspaces()
  const frames: WorkspaceFactsFrame[] = []
  for await (const frame of handle) frames.push(frame)
  assert.equal(streams, 0)
  assert.deepEqual(frames.map(frame => frame.type), ['baseline'], 'the raw one-shot baseline is preserved')
  assert.equal(workspace.disposed(), 1, 'the one-shot raw stream is disposed exactly once')
})

test('UA-11 an observation opened while disconnected publishes unknown facts and adopts the first real generation', async () => {
  const h = harness({
    noGeneration: true,
    listed: [activityRow('a')],
    listedRunning: { a: true },
    states: { a: { result: { running: true, pendingInput: [] } } },
    projections: { a: { result: emptyQuestions } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a')], 1, 'a')
    assert.equal(observation.getSnapshot().facts[0]?.running, undefined,
      'no Connection generation means no proven running fact, never a fabricated idle')
    assert.equal(h.stateCalls.length, 0, 'no read is issued without a generation')
    h.setGeneration('gen-1')
    await waitFor(() => observation.getSnapshot().facts[0]?.running === true,
      'the first real generation re-proves what it can')
  })
})

test('UA-11 the exact state sample establishes running only while list/status has not proven it', async () => {
  let statusListener: ((sessionId: string, running: boolean) => void) | undefined
  const h = harness({
    listed: [activityRow('a')],
    listedRunning: { a: false },
    states: { a: { result: { running: true, pendingInput: [] } } },
    projections: { a: { result: emptyQuestions } },
    events: { onSessionStatus: listener => { statusListener = listener; return () => { statusListener = undefined } } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([activityRow('a')], 1, 'a')
    // The initial generation's list owns running: the disagreeing state sample
    // never overwrites it.
    await waitFor(() => observation.getSnapshot().facts[0]?.attentionSourceState === 'known', 'the exact pair lands')
    assert.equal(observation.getSnapshot().facts[0]?.running, false, 'the list/status authority owns normal running')
    // A rollover revokes the list proof; the CURRENT generation's exact state
    // may then establish running until the official status changes.
    h.setGeneration('gen-2')
    await waitFor(() => observation.getSnapshot().facts[0]?.running === true,
      'the recovery path re-proves running from the exact current state')
    statusListener?.('a', false)
    await waitFor(() => observation.getSnapshot().facts[0]?.running === false, 'a current status event wins')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(observation.getSnapshot().facts[0]?.running, false,
      'a later exact state can never override a current status event')
  })
})

test('UA-11 a measured none row leaves the active recheck set; a running row keeps ONE bounded recheck', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Node's mock timers do not touch setImmediate: this flushes the pending
  // promise chain between two virtual clock advances.
  const flushTurns = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
  // A) The only active reason is local eligibility; the exact pair proves
  //    `none`, then the eligibility is revoked. Nothing keeps it active.
  const idleHarness = harness({
    listed: [activityRow('idle')],
    listedRunning: { idle: false },
    states: { idle: { result: { running: false, pendingInput: [] } } },
    projections: { idle: { result: emptyQuestions } },
  })
  await withObservation(idleHarness, async (observation) => {
    observation.setPriorityIds(new Set(['idle']))
    observation.setRoster([activityRow('idle')], 1, undefined)
    await waitFor(() => observation.getSnapshot().facts[0]?.attention === 'none', 'the exact pair proves none')
    const measured = idleHarness.stateCalls.length
    // The revocation itself re-reads the affected id exactly once (contract).
    observation.setPriorityIds(new Set())
    await waitFor(() => idleHarness.stateCalls.length === measured + 1, 'the revoked id is re-read once')
    const settled = idleHarness.stateCalls.length
    await flushTurns()
    t.mock.timers.tick(ACTIVITY_RECHECK_MS)
    await flushTurns()
    t.mock.timers.tick(ACTIVITY_RECHECK_MS)
    await flushTurns()
    assert.equal(idleHarness.stateCalls.length, settled,
      'a measured none row must leave the active set instead of being sampled every 20 s forever')
  })
  // B) Positive control: a running row really is rechecked by the ONE timer.
  const runningHarness = harness({
    listed: [activityRow('run')],
    listedRunning: { run: true },
    states: { run: { result: { running: true, pendingInput: [] } } },
    projections: { run: { result: emptyQuestions } },
  })
  await withObservation(runningHarness, async (observation) => {
    observation.setRoster([activityRow('run')], 1, undefined)
    await waitFor(() => runningHarness.stateCalls.length === 1, 'the first priority sample lands')
    await flushTurns()
    t.mock.timers.tick(ACTIVITY_RECHECK_MS)
    await waitFor(() => runningHarness.stateCalls.length === 2, 'the active row keeps ONE bounded recheck')
  })
})

test('UA-12 a recovering follow adopts a Connection replacement and keeps the new generation baseline instead of dropping it', async () => {
  let h!: ReturnType<typeof harness>
  const stream = scriptedWorkspaceStream(
    () => [
      { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('old')] } } },
      { generation: 2, frame: { type: 'baseline', value: { items: [workspaceView('new')] } } },
      { generation: 2, frame: { type: 'upsert', workspace: workspaceView('extra') } },
    ],
    (() => {
      let replaced = false
      return (generation: number) => {
        // A real Connection generation replacement lands right before the new
        // physical generation's first item: that item IS the fresh baseline and
        // must be accepted, not skipped as a stale old-generation frame.
        if (generation !== 2 || replaced) return
        replaced = true
        h.setGeneration('gen-2')
      }
    })(),
    { emitCarrierFailure: false },
  )
  h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const frames: WorkspaceFactsFrame[] = []
  for (let index = 0; index < 4; index += 1) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    frames.push(next.value)
  }
  // The replacement's LATE physical open belongs to B: the attempt identity
  // must be the replacement Connection, never the opening A.
  const attempted = handle.attemptedGeneration?.()
  assert.deepEqual(attempted, { id: 'gen-2' },
    'the recovering handle recorded the replacement physical-attempt generation')
  handle.dispose()
  await iterator.next()
  assert.deepEqual(frames, [
    { type: 'baseline', items: [{ workspaceId: 'old', path: '/host/old', title: 'Workspace old', sessionIds: [] }] },
    { type: 'invalidated', reason: 'replaced' },
    { type: 'baseline', items: [{ workspaceId: 'new', path: '/host/new', title: 'Workspace new', sessionIds: [] }] },
    { type: 'upsert', workspace: { workspaceId: 'extra', path: '/host/extra', title: 'Workspace extra', sessionIds: [] } },
  ])
  assert.deepEqual(stream.accepted, [1, 2], 'both physical generations accept their own baseline')
})

test('UA-12 a queued item produced by a replaced physical attempt is never admitted as fresh', async () => {
  let h!: ReturnType<typeof harness>
  const stream = scriptedWorkspaceStream(
    () => [
      { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('old')] } } },
      { generation: 1, frame: { type: 'upsert', workspace: workspaceView('stale') } },
      { generation: 2, frame: { type: 'baseline', value: { items: [workspaceView('fresh')] } } },
    ],
    (() => {
      let calls = 0
      return (generation: number) => {
        calls += 1
        // The replacement lands BETWEEN the two queued items of the old
        // physical attempt: the second belongs to a Connection that is gone.
        if (generation === 1 && calls === 2) h.setGeneration('gen-2')
      }
    })(),
    { emitCarrierFailure: false },
  )
  h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const frames: WorkspaceFactsFrame[] = []
  for (let index = 0; index < 3; index += 1) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    frames.push(next.value)
  }
  handle.dispose()
  await iterator.next()
  assert.deepEqual(frames.map(frame => frame.type), ['baseline', 'invalidated', 'baseline'],
    'the stale old-attempt upsert is fenced; the fresh B baseline is admitted')
  assert.equal((handle.attemptedGeneration?.() as { readonly id?: string }).id, 'gen-2',
    'the late physical attempt identity is the replacement Connection')
})

test('UA-12 a physical attempt that fails before its baseline retains its attempt identity', async () => {
  let h!: ReturnType<typeof harness>
  const stream = scriptedWorkspaceStream(
    () => [{ generation: 2, frame: { type: 'upsert', workspace: workspaceView('x') } }],
    () => { h.setGeneration('gen-2') },
    { emitCarrierFailure: false },
  )
  h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const invalidated = await iterator.next()
  assert.deepEqual(invalidated.value, { type: 'invalidated', reason: 'replaced' })
  await assert.rejects(async () => { await iterator.next() }, /did not begin with a baseline/u)
  assert.deepEqual(handle.attemptedGeneration?.(), { id: 'gen-2' },
    'a failure before baseline still belongs to the attempt Connection, not the opening one')
  handle.dispose()
})

test('UA-12 a recovering follow that never resumes after a carrier loss fails truthfully at the bounded deadline', async (t) => {
  const stream = scriptedWorkspaceStream(() => [
    { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('old')] } } },
  ], undefined, { stall: true })
  const h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const baseline = await iterator.next()
  assert.deepEqual(baseline.value, {
    type: 'baseline',
    items: [{ workspaceId: 'old', path: '/host/old', title: 'Workspace old', sessionIds: [] }],
  })
  const invalidated = await iterator.next()
  assert.deepEqual(invalidated.value, { type: 'invalidated', reason: 'reconnecting' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The physical generation is gone and no resumed item ever arrives: the
  // follow must fail truthfully at the bounded deadline instead of hanging.
  const pending = iterator.next()
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(WORKSPACE_RESUME_TIMEOUT_MS)
  await assert.rejects(pending, /did not resume on the new Connection generation/)
  handle.dispose()
})

// ── Review-driven currentness/scheduling regressions ────────────────────────

const activeQuestions = {
  kind: 'sequenced' as const,
  values: {
    // The classifier reads the QUESTION ITEMS (`questions[].intent`), so a real
    // continued fixture must carry them; a bare callId would be malformed.
    userQuestions: { active: [{ callId: 'q1', state: 'continued', questions: [{ id: 'q1', question: 'Continue?' }] }], settled: [] },
    inbox: { 'next-step': [], 'next-turn': [] },
  },
}

const flushTurns = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }

test('R1 a continued hint that arrives during a BLOCKED discovery is sampled by the newer epoch once it settles', async () => {
  const listed = [row('x')]
  const listedRunning = { x: false }
  // A REAL continued late answer: the Gateway reports NO pending input; only
  // the readable projection/inbox proves the continued call.
  const states = { x: { result: { running: false, pendingInput: [] as string[] } } }
  const projections: Record<string, { readonly result: unknown }> = { x: { result: emptyQuestions } }
  const hints: Record<string, { readonly values: unknown; readonly state: 'idle' }> = {}
  let releaseDiscovery!: () => void
  let gated = false
  const discoveryBlocked = new Promise<void>(resolve => { releaseDiscovery = resolve })
  const h = harness({
    listed,
    listedRunning,
    states: states as never,
    projections: projections as never,
    projectionsBySession: hints as never,
    projectionGate: async (id) => { if (id === 'x' && !gated) { gated = true; await discoveryBlocked } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'the ordinary discovery starts')
    // The official source changes WHILE the discovery RPC is blocked.
    hints.x = { values: { userQuestions: { active: [{ callId: 'q1', state: 'continued' }], settled: [] } }, state: 'idle' }
    projections.x = { result: activeQuestions }
    h.notifyList()
    // The invalidation must not be lost behind the blocked read.
    assert.equal(observation.getSnapshot().facts[0]?.attention, 'unknown', 'the invalidated fact is not kept painting')
    releaseDiscovery()
    await waitFor(() => observation.getSnapshot().facts[0]?.attention === 'question',
      'the newer epoch is sampled after the old read settles')
    assert.deepEqual(observation.getSnapshot().facts[0]?.continuedQuestionCallIds, ['q1'],
      'the REAL continued call (no Gateway pending) is classified from the readable projection')
    assert.ok(h.projectionCalls.length >= 2, 'the newer evidence was really re-read, not the old response committed')
  })
})

test('R2 an older read settling after removal/re-add never retires the newer row operation and dispatches ONE new read', async () => {
  const listed = [row('x')]
  let release!: () => void
  let gated = false
  const blocked = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed,
    listedRunning: { x: false },
    projections: { x: { result: emptyQuestions } } as never,
    projectionGate: async (id) => { if (id === 'x' && !gated) { gated = true; await blocked } },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'the first discovery starts')
    observation.setRoster([], 2, undefined)
    observation.setRoster([row('x')], 3, undefined)
    release()
    await waitFor(() => h.projectionCalls.length === 2, 'the re-added row receives exactly ONE new discovery')
    await flushTurns()
    assert.equal(h.projectionCalls.length, 2, 'the stale completion never caused a duplicate request')
  })
})

test('R3 revoking eligibility removes the precise Needs fact in the SAME frame, before the re-read settles', async () => {
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: true },
    states: { x: { result: { running: true, pendingInput: ['question'] } } },
    projections: { x: { result: activeQuestions } } as never,
  })
  await withObservation(h, async (observation) => {
    observation.setPriorityIds(new Set(['x']))
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => observation.getSnapshot().facts[0]?.attention === 'question', 'the eligible row proves its question')
    observation.setPriorityIds(new Set())
    assert.equal(observation.getSnapshot().facts[0]?.attention, 'unknown',
      'a revoked eligibility never keeps painting its old sample while the re-read is in flight')
  })
})

test('R4 a failed projection is re-read by the next recheck instead of being cached forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const projections: Record<string, unknown> = { x: { failure: { code: 'remote-access/denied' } } }
  const states: Record<string, unknown> = { x: { failure: { code: 'gateway/internal' } } }
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: true },
    states: states as never,
    projections: projections as never,
  })
  await withObservation(h, async (observation) => {
    // The CURRENT Session keeps the row active through the failed pair.
    observation.setRoster([row('x')], 1, 'x')
    await waitFor(() => h.projectionCalls.filter(id => id === 'x').length === 1, 'the failed pair is sampled once')
    const before = h.projectionCalls.length
    states.x = { result: { running: true, pendingInput: ['question'] } }
    projections.x = { result: activeQuestions }
    await flushTurns()
    t.mock.timers.tick(ACTIVITY_RECHECK_MS)
    await waitFor(() => observation.getSnapshot().facts[0]?.attention === 'question',
      'the active recheck re-reads the pair and proves the question')
    assert.ok(h.projectionCalls.length > before, 'the failed projection was re-read, never reused')
  })
})

test('R5 a Connection loss revokes a running-only row and publishes the revocation', async () => {
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: true },
    states: { x: { failure: { code: 'gateway/internal' } } },
    projections: { x: { failure: { code: 'gateway/internal' } } } as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    assert.equal(observation.getSnapshot().facts[0]?.running, true, 'the initial list baseline proves running')
    let emissions = 0
    observation.subscribe(() => { emissions += 1 })
    h.setGeneration(undefined)
    assert.equal(observation.getSnapshot().facts[0]?.running, undefined, 'the old Working proof is revoked')
    assert.ok(emissions >= 1, 'the revocation reaches the renderer, not only the internal row')
  })
})

test('R6 a replacement generation unverified positive list running schedules the exact read that alone proves it', async () => {
  const listedRunning = { x: false }
  const states = { x: { result: { running: false, pendingInput: [] } } }
  const h = harness({
    listed: [row('x')],
    listedRunning,
    states: states as never,
    projections: { x: { result: emptyQuestions } } as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => observation.getSnapshot().facts[0]?.attentionSourceState === 'known', 'the initial idle discovery settles')
    // The new generation arrives with a latest-known positive list running and
    // no status transition at all.
    listedRunning.x = true
    states.x = { result: { running: true, pendingInput: [] } }
    h.setGeneration('gen-2')
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length >= 1, 'the unverified positive row is scheduled')
    await waitFor(() => observation.getSnapshot().facts[0]?.running === true, 'the targeted current state proves running')
  })
})

test('R6b a replacement generation positive list row that the current state contradicts never becomes Working', async () => {
  const listedRunning = { x: false }
  const h = harness({
    listed: [row('x')],
    listedRunning,
    states: { x: { result: { running: false, pendingInput: [] } } },
    projections: { x: { result: emptyQuestions } } as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => observation.getSnapshot().facts[0]?.attentionSourceState === 'known', 'the initial idle discovery settles')
    listedRunning.x = true
    h.setGeneration('gen-2')
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length >= 1, 'the stale positive row is still scheduled once')
    await flushTurns()
    assert.notEqual(observation.getSnapshot().facts[0]?.running, true,
      'a replayed list row is never Working proof in a replacement generation')
  })
})

test('R7 no unary read is dispatched while the Connection is lost', async () => {
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: true },
    states: { x: { result: { running: true, pendingInput: [] } } },
    projections: { x: { result: emptyQuestions } } as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => h.stateCalls.length >= 1, 'the first read lands')
    h.setGeneration(undefined)
    const before = h.stateCalls.length + h.projectionCalls.length
    observation.setPriorityIds(new Set(['x']))
    await flushTurns()
    assert.equal(h.stateCalls.length + h.projectionCalls.length, before,
      'the disconnected observation clears its dispatch authority instead of sending a doomed RPC')
  })
})

test('R7b the exact sample prefers the current state in a replacement generation over the stale ready row', async () => {
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: true },
    states: { x: { result: { running: false, pendingInput: [] } } },
    projections: { x: { result: emptyQuestions } } as never,
  })
  h.setGeneration('gen-2')
  const facts = await h.facts.readActivity([row('x')])
  assert.equal(facts[0].running, false, 'the current exact state is the recovery evidence, not the replayed list row')
})

test('R8 a close/reopen with an unchanged source repeats NO ordinary discovery, and every real invalidation re-opens it', async () => {
  const listed = [row('a'), row('b'), row('c'), row('denied')]
  const hints: Record<string, unknown> = {}
  const projections: Record<string, unknown> = {
    a: { result: emptyQuestions },
    b: { result: emptyQuestions },
    c: { result: emptyQuestions },
    denied: { failure: { code: 'remote-access/denied' } },
  }
  const h = harness({
    listed,
    listedRunning: { a: false, b: false, c: false, denied: false },
    projections: projections as never,
    projectionsBySession: hints as never,
  })
  // First open: every ordinary row is discovered once; the denied row records
  // no successful receipt.
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.length >= 4, 'the cold open discovers every ordinary row')
  })
  h.projectionCalls.length = 0
  // Warm reopen, same generation and source: only the FAILED row retries.
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.length >= 1, 'the failed discovery is retried on reopen')
    await flushTurns()
    assert.deepEqual([...h.projectionCalls].sort(), ['denied'],
      'successful negative discoveries are not repeated on an unchanged warm reopen')
  })
  h.projectionCalls.length = 0
  // A real relevant-source change invalidates ONLY that row's receipt.
  hints.b = { values: { userQuestions: { active: [{ callId: 'q9', state: 'continued' }], settled: [] } }, state: 'idle' }
  projections.b = { result: activeQuestions }
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.includes('b'), 'the changed witness re-opens its discovery')
    await flushTurns()
    assert.ok(!h.projectionCalls.includes('a'), 'an unchanged sibling keeps its receipt')
  })
  h.projectionCalls.length = 0
  // A source revision that genuinely REVERTS to an earlier witness is a new
  // revision, not a resurrected receipt: W1→W2→W1 must discover on the return.
  hints.b = {}
  projections.b = { result: emptyQuestions }
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.includes('b'), 'the reverted witness is discovered again')
  })
  h.projectionCalls.length = 0
  // A generation replacement discards every receipt.
  h.setGeneration('gen-2')
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.length >= 4, 'the new generation discovers the roster once again')
  })
})

test('R9 a Connection loss invalidates the Workspace membership without waiting for a carrier error', async () => {
  const stream = scriptedWorkspaceStream(() => [
    { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('w')] } } },
  ])
  const h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  const baseline = await iterator.next()
  assert.equal(baseline.done, false)
  const pending = iterator.next()
  h.setGeneration(undefined)
  const invalidated = await pending
  assert.deepEqual(invalidated.value, { type: 'invalidated', reason: 'reconnecting' },
    'the loss itself revokes the proof, independently of carrier error timing')
  handle.dispose()
  await iterator.next()
})

test('R10 a repeated opening baseline inside ONE physical generation is rejected', async () => {
  const stream = scriptedWorkspaceStream(() => [
    { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('a')] } } },
    { generation: 1, frame: { type: 'baseline', value: { items: [workspaceView('b')] } } },
  ])
  const h = harness({ workspaceStream: stream.source })
  const handle = h.facts.followWorkspaces(undefined, 'recovering')
  const iterator = handle[Symbol.asyncIterator]()
  await iterator.next()
  await assert.rejects(() => iterator.next(), /repeated an opening baseline/)
  handle.dispose()
})

test('R13 a late positive list row schedules AND pumps its recovery read with no other activity', async () => {
  const listedRunning = { x: false }
  const h = harness({
    listed: [row('x')],
    listedRunning,
    states: { x: { result: { running: true, pendingInput: [] } } },
    projections: { x: { result: emptyQuestions } } as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    // The replacement generation's discovery pass settles with no active row,
    // no candidate, no in-flight work and no armed recheck.
    h.setGeneration('gen-2')
    await waitFor(() => observation.getSnapshot().facts[0]?.attentionSourceState === 'known', 'the replacement discovery settles')
    const before = h.stateCalls.filter(id => id === 'x').length
    // The real list then publishes running=true with NO status transition.
    listedRunning.x = true
    h.notifyList()
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length > before,
      'the queued recovery read is pumped, not left stranded in the queue')
    await waitFor(() => observation.getSnapshot().facts[0]?.running === true, 'the current state proves running')
  })
})

test('R13b a failed precise state in a replacement generation is unknown, never the stale list bit', async () => {
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: true },
    states: { x: { failure: { code: 'remote-access/denied' } } },
    projections: { x: { result: emptyQuestions } } as never,
  })
  h.setGeneration('gen-2')
  const facts = await h.facts.readActivity([row('x')])
  assert.equal(facts[0].running, undefined,
    'a denied exact state is unknown; the replayed ready row cannot resurrect running')
})

test('R14 a source that changes and REVERTS (W1→W2→W1) is discovered on the return', async () => {
  const hints: Record<string, unknown> = {}
  const projections: Record<string, unknown> = { b: { result: emptyQuestions } }
  const h = harness({
    listed: [row('b')],
    listedRunning: { b: false },
    projections: projections as never,
    projectionsBySession: hints as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('b')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'W1 is discovered')
    // W2: the source becomes active while the Browser is open.
    hints.b = { values: { userQuestions: { active: [{ callId: 'q2', state: 'continued', questions: [{ id: 'q2', question: 'Continue?' }] }], settled: [] } }, state: 'idle' }
    projections.b = { result: activeQuestions }
    h.notifyList()
    await waitFor(() => h.projectionCalls.length === 2, 'W2 discards the W1 receipt and reads its own revision')
    // Back to W1: a reverted revision is NOT the earlier completed one.
    hints.b = {}
    projections.b = { result: emptyQuestions }
    h.notifyList()
    await waitFor(() => h.projectionCalls.length === 3, 'the reverted witness is discovered again')
  })
})

test('R14b a source that changes and reverts while the Browser is CLOSED is still discovered on reopen', async () => {
  const hints: Record<string, unknown> = {}
  const projections: Record<string, unknown> = { b: { result: emptyQuestions } }
  const h = harness({
    listed: [row('b')],
    listedRunning: { b: false },
    projections: projections as never,
    projectionsBySession: hints as never,
  })
  // First open records the W1 receipt, then closes.
  await withObservation(h, async (observation) => {
    observation.setRoster([row('b')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'W1 is discovered')
  })
  h.projectionCalls.length = 0
  // The adapter's lifetime subscription sees both revisions while closed.
  hints.b = { values: { userQuestions: { active: [{ callId: 'q3', state: 'continued', questions: [{ id: 'q3', question: 'Continue?' }] }], settled: [] } }, state: 'idle' }
  h.notifyList()
  hints.b = {}
  h.notifyList()
  // The revert to W1 must not resurrect the W1 receipt: reopen discovers again.
  await withObservation(h, async (observation) => {
    observation.setRoster([row('b')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'the reverted revision is discovered on reopen')
  })
})

test('R15 a stale completion after removal/re-add records no receipt a later reopen could trust', async () => {
  const releases: Array<() => void> = []
  const h = harness({
    listed: [row('x')],
    listedRunning: { x: false },
    projections: { x: { result: emptyQuestions } } as never,
    projectionGate: () => new Promise<void>((resolve) => { releases.push(resolve) }),
  })
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'the first incarnation discovery is blocked in flight')
    observation.setRoster([], 2, undefined)
    observation.setRoster([row('x')], 3, undefined)
    releases[0]!()
    await waitFor(() => h.projectionCalls.length === 2, 'the re-added incarnation starts its OWN discovery')
    // That read is still blocked: disposing aborts it (no receipt), while the
    // stale completion must not have recorded one for the new id either.
    observation.dispose()
  })
  releases[1]?.()
  h.projectionCalls.length = 0
  await withObservation(h, async (observation) => {
    observation.setRoster([row('x')], 1, undefined)
    await waitFor(() => h.projectionCalls.length === 1, 'the stale incarnation left no trusted receipt')
  })
})

test('R18 an official running transition while the Browser is CLOSED invalidates the receipt, an unrelated sibling keeps it', async () => {
  const listed = [row('a'), row('b')]
  const listedRunning = { a: false, b: false }
  const projections: Record<string, unknown> = {
    a: { result: emptyQuestions },
    b: { result: emptyQuestions },
  }
  const h = harness({
    listed,
    listedRunning,
    projections: projections as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.length === 2, 'the cold open records both negative receipts')
  })
  h.projectionCalls.length = 0
  // b's official row runs and returns to idle while the panel is closed; the
  // relevant hint witness never changes. A status transition is a relevant
  // discovery invalidation too, so its receipt must not survive.
  listedRunning.b = true
  h.notifyList()
  listedRunning.b = false
  h.notifyList()
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.projectionCalls.includes('b'), 'the status transitioned row is discovered again on reopen')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual([...h.projectionCalls].sort(), ['b'],
      'the untouched sibling keeps its receipt across the other row status transition')
  })
})

test('R19 an unrelated roster metadata/add/remove change never re-reads a stable candidate pair', async () => {
  const listed = [row('cur'), row('stable'), row('gone')]
  const listedRunning = { cur: true, stable: true, gone: false }
  const hints: Record<string, unknown> = {}
  const h = harness({
    listed,
    listedRunning,
    states: {
      cur: { result: { running: true, pendingInput: [] } },
      stable: { result: { running: true, pendingInput: [] } },
    },
    projections: { cur: { result: emptyQuestions }, stable: { result: emptyQuestions } },
    projectionsBySession: hints as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, 'cur')
    await waitFor(() => h.stateCalls.includes('cur') && h.stateCalls.includes('stable'), 'the two candidates get their ONE pair')
    await flushTurns()
    const stablePair = {
      state: h.stateCalls.filter(id => id === 'stable').length,
      projection: h.projectionCalls.filter(id => id === 'stable').length,
    }
    // An unrelated title/updatedAt change, a new idle row and a removal: none of
    // these is a relevant change for the stable candidate.
    const next = [
      row('cur', { updatedAt: 2 }),
      row('stable', { updatedAt: 9, title: 'Renamed elsewhere' }),
      row('added'),
    ]
    for (const id of Object.keys(listedRunning)) if (id === 'gone') delete (listedRunning as Record<string, boolean>)[id]
    ;(listedRunning as Record<string, boolean>).added = false
    listed.splice(0, listed.length, ...next)
    observation.setRoster(next, 2, 'cur')
    await waitFor(() => h.projectionCalls.includes('added') || h.stateCalls.includes('added'),
      'the NEWLY admitted row receives its necessary initial read')
    await flushTurns()
    assert.deepEqual({
      state: h.stateCalls.filter(id => id === 'stable').length,
      projection: h.projectionCalls.filter(id => id === 'stable').length,
    }, stablePair, 'the stable blocked/complete pair was not re-read by an unrelated roster change')
  })
})

test('R20 the priority tiers keep a late current row ahead of hinted candidates while discovery stays live', async () => {
  const hinted = Array.from({ length: 6 }, (_, index) => `hint-${index}`)
  const listed = [...hinted.map(id => row(id)), row('current-late'), row('plain')]
  const hints: Record<string, unknown> = Object.fromEntries(hinted.map(id => [id, {
    values: { userQuestions: { active: [{ callId: `q-${id}`, state: 'continued', questions: [{ id: 'q', question: 'Continue?' }] }], settled: [] } },
    state: 'idle',
  }]))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed,
    listedRunning: Object.fromEntries(listed.map(id => [id, false])),
    states: Object.fromEntries(listed.map(id => [id, { result: { running: false, pendingInput: [] } }])),
    projections: Object.fromEntries(listed.map(id => [id, { result: emptyQuestions }])),
    projectionsBySession: hints as never,
    stateGate: async () => { await gate },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, 'current-late')
    // The current row is LAST in the roster but tier 1; the hinted rows are
    // tier 2. The first actual priority dispatch must be the current row.
    // All priority reads are HELD: the fixed capacity is three, and the reserved
    // discovery slot must still start the ordinary row while they are blocked.
    await waitFor(() => h.stateCalls.length === 3, 'the three priority candidates are dispatched first')
    assert.equal(h.stateCalls[0], 'current-late',
      'a late current row precedes the hinted candidates in the fixed dispatch tiers')
    await waitFor(() => h.projectionCalls.includes('plain'), 'the reserved discovery lane stays live while every priority read is held')
    release()
    await flushTurns()
    release()
  })
})

test('R21 an unrelated list publication never re-dirties a held recovery read (a real transition still does)', async () => {
  const listed = [row('x'), row('z')]
  const listedRunning: Record<string, boolean> = { x: false, z: false }
  const states: Record<string, unknown> = { x: { failure: { code: 'gateway/internal' } } }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({
    listed,
    listedRunning,
    states: states as never,
    projections: { x: { result: emptyQuestions }, z: { result: emptyQuestions } } as never,
    stateGate: async () => { await gate },
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    // A replacement generation adopts with the latest-known positive bit: the
    // targeted recovery read is scheduled ONCE (state held in flight).
    listedRunning.x = true
    h.setGeneration('gen-2')
    await waitFor(() => h.stateCalls.includes('x'), 'the recovery read starts once')
    const xBefore = h.stateCalls.filter(id => id === 'x').length
    // Unrelated session churn: z's title/updatedAt changes, X's own sources and
    // its positive bit are unchanged.
    listed[1] = row('z', { updatedAt: 9, title: 'Renamed elsewhere' })
    h.notifyList()
    await flushTurns()
    release()
    await waitFor(() => h.projectionCalls.filter(id => id === 'x').length >= 1, 'the held recovery pair completes')
    await flushTurns()
    assert.equal(h.stateCalls.filter(id => id === 'x').length, xBefore,
      'an unrelated notification while the same unproven positive is held never adds a second pair')
    // Positive control: a REAL false→true transition schedules a fresh read.
    const afterFirst = h.stateCalls.filter(id => id === 'x').length
    listedRunning.x = false
    h.notifyList()
    listedRunning.x = true
    states.x = { result: { running: true, pendingInput: [] } }
    h.notifyList()
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length > afterFirst,
      'a genuine positive transition still schedules the targeted recovery read')
  })
})

test('R22 a COMBINED running+witness publication commits both inputs before dispatch, so no later unchanged notification re-dirties it', async () => {
  const listed = [row('x'), row('z')]
  const listedRunning: Record<string, boolean> = { x: false, z: false }
  const hints: Record<string, unknown> = {}
  const states: Record<string, unknown> = { x: { failure: { code: 'gateway/internal' } } }
  let releases: Array<() => void> = []
  const h = harness({
    listed,
    listedRunning,
    states: states as never,
    projections: { x: { result: emptyQuestions }, z: { result: emptyQuestions } } as never,
    projectionsBySession: hints as never,
    stateGate: () => new Promise<void>((resolve) => { releases.push(resolve) }),
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    // One official snapshot changes BOTH the relevant hint and the late
    // positive running bit (a refreshed baseline batches both).
    listedRunning.x = true
    hints.x = { values: { userQuestions: { active: [{ callId: 'q1', state: 'continued', questions: [{ id: 'q', question: 'Continue?' }] }], settled: [] } }, state: 'idle' }
    h.notifyList()
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length >= 1, 'the combined publication schedules ONE read (held)')
    const held = h.stateCalls.filter(id => id === 'x').length
    // An unrelated unchanged publication while the held read is in flight must
    // not look like a second transition.
    listed[1] = row('z', { updatedAt: 5, title: 'Renamed elsewhere' })
    h.notifyList()
    await flushTurns()
    releases.splice(0).forEach(release => { release() })
    await waitFor(() => h.projectionCalls.filter(id => id === 'x').length >= 1, 'the held pair completes')
    await flushTurns()
    assert.equal(h.stateCalls.filter(id => id === 'x').length, held,
      'the combined publication was committed once: the later unchanged notification adds no pair')
    // Symmetric: true→false WITH a witness change commits the false baseline, so
    // a later true with the same witness is a genuine transition and schedules.
    const beforeSymmetric = h.stateCalls.filter(id => id === 'x').length
    listedRunning.x = false
    hints.x = { values: { userQuestions: { active: [{ callId: 'q2', state: 'continued', questions: [{ id: 'q2', question: 'Continue?' }] }], settled: [] } }, state: 'idle' }
    h.notifyList()
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length > beforeSymmetric, 'the witness change schedules its own read')
    releases.splice(0).forEach(release => { release() })
    await flushTurns()
    const beforeTransition = h.stateCalls.filter(id => id === 'x').length
    listedRunning.x = true
    h.notifyList()
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length > beforeTransition,
      'a later unproven positive with the same witness is still a genuine transition')
  })
})

test('R23 an official removal not yet consumed by the caller roster never dispatches or commits that row', async () => {
  const listed = [row('x'), row('y')]
  const hints = { x: { values: { userQuestions: { active: [{ callId: 'q-x', state: 'continued', questions: [{ id: 'q', question: 'Continue?' }] }], settled: [] } }, state: 'idle' } }
  const h = harness({
    listed,
    listedRunning: { x: true, y: false },
    states: { x: { result: { running: false, pendingInput: [] } }, y: { result: { running: false, pendingInput: [] } } },
    projections: { x: { result: emptyQuestions }, y: { result: emptyQuestions } },
    projectionsBySession: hints as never,
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.stateCalls.includes('x'), 'x receives its hinted pair')
    const beforeRemoval = h.stateCalls.filter(id => id === 'x').length
    // The official store removes x from `ids`; the caller roster still holds it
    // until the Browser consumes the removal notification.
    listed.splice(0, listed.length, row('y'))
    h.notifyList()
    await flushTurns()
    // Unrelated churn on the surviving sibling must not dispatch the removed id.
    listed[0] = row('y', { updatedAt: 5, title: 'Renamed elsewhere' })
    h.notifyList()
    await flushTurns()
    assert.equal(h.stateCalls.filter(id => id === 'x').length, beforeRemoval,
      'an id outside the current official corpus never dispatches a read')
    // The caller consumes the removal, then re-adds x as a NEW incarnation.
    observation.setRoster(listed, 2, undefined)
    listed.push(row('x'))
    h.notifyList()
    observation.setRoster(listed, 3, undefined)
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length > beforeRemoval,
      'the re-added incarnation receives its necessary read')
  })
})

test('R24 a falling-only running transition fences the held read and schedules the latest work once', async () => {
  const listed = [row('x')]
  const hints = { x: { values: { userQuestions: { active: [{ callId: 'q-x', state: 'continued', questions: [{ id: 'q', question: 'Continue?' }] }], settled: [] } }, state: 'idle' } }
  const listedRunning: Record<string, boolean> = { x: false }
  const gates: Array<() => void> = []
  const h = harness({
    listed,
    listedRunning,
    states: { x: { result: { running: false, pendingInput: [] } } },
    projections: { x: { result: emptyQuestions } },
    projectionsBySession: hints as never,
    stateGate: () => new Promise<void>((resolve) => { gates.push(resolve) }),
  })
  await withObservation(h, async (observation) => {
    observation.setRoster(listed, 1, undefined)
    await waitFor(() => h.stateCalls.includes('x'), 'the hinted pair is in flight')
    const held = h.stateCalls.filter(id => id === 'x').length
    // A replacement generation arrives with the latest-known positive: the
    // recovery intent coalesces behind the held read (never a second pair beside
    // it).
    listedRunning.x = true
    h.setGeneration('gen-2')
    await flushTurns()
    assert.equal(h.stateCalls.filter(id => id === 'x').length, held,
      'the recovery intent coalesces behind the held read')
    // The official bit FALLS with an unchanged hint while that read is held.
    listedRunning.x = false
    h.notifyList()
    await flushTurns()
    const heldCount = h.stateCalls.filter(id => id === 'x').length
    // Release the held read: its completion is fenced (epoch), and the latest
    // authorized work is dispatched exactly once.
    gates.splice(0).forEach(release => { release() })
    await waitFor(() => h.stateCalls.filter(id => id === 'x').length > heldCount,
      'the latest work is dispatched once after the falling transition')
    const afterSchedule = h.stateCalls.filter(id => id === 'x').length
    h.notifyList()
    await flushTurns()
    assert.equal(h.stateCalls.filter(id => id === 'x').length, afterSchedule,
      'an unchanged follow-up notification adds no extra pair')
    gates.splice(0).forEach(release => { release() })
    await flushTurns()
  })
})

// ── L3: the per-selection Remote Inspector source ───────────────────────────

const INSPECTOR_SESSION = 'session-inspector-remote'
const INSPECTOR_OTHER = 'session-inspector-other'

function deferred<Value>(): { readonly promise: Promise<Value>; readonly resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`${label}: timed out`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const inspectorStats = {
  turns: 2,
  steps: 3,
  llmMs: 3000,
  toolMs: 700,
  ttftMs: 600,
  ttftSteps: 2,
  decodeMs: 1500,
  decodeTokens: 120,
}

const inspectorSequenced = (values: Readonly<Record<string, unknown>>, asOfSeq = 3): { readonly result: unknown } => ({
  result: { kind: 'sequenced', asOfSeq, values },
})

test('INS-R1 ONE exact unary targets the selected Session and maps the sequenced envelope', async () => {
  const h = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: {
      [INSPECTOR_SESSION]: inspectorSequenced({
        sessionStats: inspectorStats,
        workingDirectory: '/host/project',
      }, 11),
    },
  })
  const source = h.facts.openInspector(INSPECTOR_SESSION, () => {
    throw new Error('an exact cut never invalidates itself')
  })
  const result = await source.read(new AbortController().signal)
  assert.equal(result.kind, 'ready')
  if (result.kind === 'ready') {
    assert.equal(result.data.sessionId, INSPECTOR_SESSION)
    assert.equal(result.data.asOfSeq, 11)
    assert.equal(result.data.stats?.decodeTokensPerSec, 80)
    assert.equal(result.data.effectiveCwd, '/host/project')
  }
  assert.deepEqual(h.projectionCalls, [INSPECTOR_SESSION], 'exactly one unary at the selected id')
  assert.equal(h.otherCalls.includes('refresh'), false, 'an exact read never refreshes the roster')
  source.dispose()
})

test('INS-R2 migration/cache/absent/denied/unavailable/error envelopes never become statistics', async () => {
  const migration = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: {
      [INSPECTOR_SESSION]: { result: { kind: 'migration-required', values: { sessionStats: inspectorStats } } },
    },
  })
  const migrationResult = await migration.facts.openInspector(INSPECTOR_SESSION, () => {})
    .read(new AbortController().signal)
  assert.deepEqual(migrationResult, { kind: 'migration-required', message: 'Session migration is required' },
    'migration-required wins and its cached values are ignored')

  const absent = harness({ listed: [row(INSPECTOR_SESSION)] })
  assert.equal((await absent.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable', 'a null envelope is unavailable, never an empty DTO')

  const cachedHint = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: { result: { kind: 'cached', asOfSeq: 1, values: { sessionStats: inspectorStats } } } },
  })
  assert.equal((await cachedHint.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable', 'a cached hint is never an exact cut')

  const badCut = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: inspectorSequenced({ sessionStats: inspectorStats }, 1.5) },
  })
  assert.equal((await badCut.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable', 'a non-integer cut cannot be presented as exact')

  const denied = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: { failure: { code: 'remote-access/denied' } } },
  })
  assert.equal((await denied.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'denied')

  const unavailable = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: { failure: { code: 'gateway/invocation-unavailable' } } },
  })
  assert.equal((await unavailable.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable')

  const unknown = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: { failure: { code: 'gateway/internal' } } },
  })
  const unknownResult = await unknown.facts.openInspector(INSPECTOR_SESSION, () => {})
    .read(new AbortController().signal)
  assert.equal(unknownResult.kind, 'error')
  if (unknownResult.kind === 'error') assert.ok(unknownResult.message !== '', 'a real failure keeps a safe message')

  const noGeneration = harness({ noGeneration: true, listed: [row(INSPECTOR_SESSION)] })
  assert.equal((await noGeneration.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable')
  assert.deepEqual(noGeneration.projectionCalls, [], 'a missing generation never sends an RPC')

  const missingTarget = harness({ listed: [row(INSPECTOR_OTHER)] })
  assert.equal((await missingTarget.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable')
  assert.deepEqual(missingTarget.projectionCalls, [], 'an unlisted target never sends an RPC')

  const subagentTarget = harness({ listed: [row(INSPECTOR_SESSION, { origin: 'subagent' })] })
  assert.equal((await subagentTarget.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal)).kind,
    'unavailable')
  assert.deepEqual(subagentTarget.projectionCalls, [], 'a subagent child is never an Inspector target')
})

test('INS-R3 generation/binding/removal changes during the unary supersede the result', async () => {
  const cases: Array<{
    readonly label: string
    readonly mutate: (h: Harness) => void
  }> = [
    { label: 'generation replacement', mutate: h => { h.setGeneration('gen-2') } },
    { label: 'binding identity replacement', mutate: h => { h.setBinding({}) } },
    { label: 'target removal', mutate: h => { h.setListed([]) } },
  ]
  for (const scenario of cases) {
    const gate = deferred<void>()
    const h = harness({
      listed: [row(INSPECTOR_SESSION)],
      projections: { [INSPECTOR_SESSION]: inspectorSequenced({ sessionStats: inspectorStats }) },
      projectionGate: async () => gate.promise,
    })
    const source = h.facts.openInspector(INSPECTOR_SESSION, () => {})
    const pending = source.read(new AbortController().signal)
    await until(() => h.projectionCalls.length === 1, `${scenario.label} started`)
    scenario.mutate(h)
    gate.resolve()
    await assert.rejects(pending, (error: unknown) => error instanceof SupersededReadError,
      `${scenario.label} must never commit the stale exact result`)
    source.dispose()
  }
})

test('INS-R4 only the selected relevant witness change/identity replacement notifies', () => {
  const reasons: Array<'changed' | 'source-replaced'> = []
  const h = harness({
    listed: [row(INSPECTOR_SESSION), row(INSPECTOR_OTHER)],
    listedRunning: { [INSPECTOR_SESSION]: false, [INSPECTOR_OTHER]: false },
    projectionsBySession: {
      [INSPECTOR_SESSION]: {
        values: { sessionStats: { turns: 1 }, title: 'before' } as unknown as RemoteProjectionValues,
        state: 'idle',
      },
      [INSPECTOR_OTHER]: {
        values: { sessionStats: { turns: 9 } } as unknown as RemoteProjectionValues,
        state: 'idle',
      },
    },
  })
  const source = h.facts.openInspector(INSPECTOR_SESSION, reason => { reasons.push(reason) })
  // +1 each is the adapter-lifetime discovery-receipt subscription, which stays
  // open across every per-selection source.
  assert.deepEqual(h.subscribers(), { list: 2, generation: 2 }, 'the source subscribes once to each official source')
  h.notifyList()
  assert.deepEqual(reasons, [], 'an unchanged publication is inert')
  h.setProjectionValues(INSPECTOR_SESSION, { sessionStats: { turns: 2 }, title: 'before' } as unknown as RemoteProjectionValues)
  h.notifyList()
  assert.deepEqual(reasons, ['changed'], 'a relevant selected-key value change is a real change')
  h.setProjectionValues(INSPECTOR_OTHER, { sessionStats: { turns: 99 } } as unknown as RemoteProjectionValues)
  h.notifyList()
  assert.deepEqual(reasons, ['changed'], 'another row never notifies')
  h.setRunning(INSPECTOR_OTHER, true)
  h.notifyList()
  assert.deepEqual(reasons, ['changed'], 'another row running never notifies')
  h.setRunning(INSPECTOR_SESSION, true)
  h.notifyList()
  assert.deepEqual(reasons, ['changed', 'changed'], 'the selected official running bit is a real change')
  h.setBinding({ id: 'replacement' })
  h.notifyList()
  assert.deepEqual(reasons, ['changed', 'changed', 'source-replaced'], 'a binding identity change revokes the data')
  h.setGeneration('gen-2')
  assert.deepEqual(reasons, ['changed', 'changed', 'source-replaced', 'source-replaced'],
    'a generation change revokes the data')
  h.setListed([row(INSPECTOR_OTHER)])
  h.notifyList()
  assert.deepEqual(reasons, ['changed', 'changed', 'source-replaced', 'source-replaced', 'source-replaced'],
    'a removed selected target revokes the data')
  source.dispose()
  assert.deepEqual(h.subscribers(), { list: 1, generation: 1 }, 'dispose releases both per-selection subscriptions')
  h.notifyList()
  h.setGeneration('gen-3')
  assert.equal(reasons.length, 5, 'a disposed source never publishes a later callback')
})

test('INS-R5 a missing generation reads unavailable and a real arrival re-proves the same target', async () => {
  const reasons: Array<'changed' | 'source-replaced'> = []
  const h = harness({
    noGeneration: true,
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: inspectorSequenced({ sessionStats: inspectorStats }, 4) },
  })
  const source = h.facts.openInspector(INSPECTOR_SESSION, reason => { reasons.push(reason) })
  assert.equal((await source.read(new AbortController().signal)).kind, 'unavailable')
  assert.deepEqual(h.projectionCalls, [], 'no generation means no RPC')
  h.setGeneration('gen-1')
  assert.deepEqual(reasons, ['source-replaced'], 'the generation arrival revokes the old identity')
  const result = await source.read(new AbortController().signal)
  assert.equal(result.kind, 'ready')
  assert.deepEqual(h.projectionCalls, [INSPECTOR_SESSION])
  source.dispose()
})

test('INS-R6 a transport cancellation during the unary rejects as a superseded read, never as a statistic', async () => {
  const h = harness({
    listed: [row(INSPECTOR_SESSION)],
    projections: { [INSPECTOR_SESSION]: { failure: { code: 'gateway/cancelled' } } },
  })
  await assert.rejects(
    h.facts.openInspector(INSPECTOR_SESSION, () => {}).read(new AbortController().signal),
    (error: unknown) => error instanceof SupersededReadError,
  )
})
