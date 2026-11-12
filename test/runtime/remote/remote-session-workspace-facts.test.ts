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
  RemoteSessionWorkspaceFacts,
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
import type { SessionPendingKind } from '../../../src/runtime/session-workspace-facts-port.ts'

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
}

function harness(options: {
  listed?: readonly SessionSummary[]
  /** The official list row `running` bits, INDEPENDENT of `SessionSummary.live`. */
  listedRunning?: Readonly<Record<string, boolean>>
  listPhase?: 'pending' | 'ready'
  states?: Readonly<Record<string, ReadOutcome | { readonly failure: unknown }>>
  projections?: Readonly<Record<string, ReadOutcome | { readonly failure: unknown }>>
  stateGate?: (sessionId: string) => Promise<void>
  /** Omit the current Connection generation entirely. */
  noGeneration?: boolean
  workspace?: RemoteWorkspaceNamespaceLike
}): Harness {
  const stateCalls: string[] = []
  const projectionCalls: string[] = []
  const otherCalls: string[] = []
  let generation = options.noGeneration === true ? undefined : { id: 'gen-1' }
  const generationSource: RemoteConnectionGenerationSource = {
    getSnapshot: () => generation,
    subscribe: () => () => {},
  }
  const listed = options.listed ?? []
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: listed.map(row => row.id),
        byId: Object.fromEntries(listed.map(row => [row.id, {
          id: row.id,
          running: options.listedRunning?.[row.id] ?? false,
          updatedAt: row.updatedAt,
        }])),
        phase: options.listPhase ?? 'ready',
      }),
      subscribe: () => () => {},
    },
    refresh: async () => { otherCalls.push('refresh') },
    search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    binding: () => { otherCalls.push('binding'); return undefined },
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
      workspace: options.workspace ?? { create: async () => ({ ok: false, error: {} }), follow: () => { throw new Error('no workspace stream in this case') } },
    },
    connection: { generation: generationSource },
  }
  return {
    facts: new RemoteSessionWorkspaceFacts(source),
    stateCalls,
    projectionCalls,
    otherCalls,
    generation: generationSource,
    setGeneration: id => { generation = id === undefined ? undefined : { id } },
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

test('UA-01 a list/state running disagreement is unknown, never one guessed value', async () => {
  const h = harness({
    listed: [row('disagree'), row('agree-idle')],
    listedRunning: { disagree: true, 'agree-idle': false },
    states: { disagree: { result: { running: false, pendingInput: [] } }, 'agree-idle': { result: { running: false, pendingInput: [] } }, 'no-list-row': { result: { running: true, pendingInput: [] } } },
    projections: {},
  })
  const facts = await h.facts.readActivity([row('disagree'), row('agree-idle'), row('no-list-row')])
  assert.equal(facts[0].running, undefined)
  assert.equal(facts[1].running, false)
  assert.equal(facts[2].running, true)
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
