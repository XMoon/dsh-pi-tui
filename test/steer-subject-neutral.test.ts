/**
 * L1 contract tests for the transport-neutral writer subject (M3-5 PR2 Step 8,
 * plan §5 Must 18, §14 L1 "transport-neutral queue-steer subject-currentness
 * helper semantics").
 *
 * `SteerDeps.currentSubject()` names a subject whose ONLY contract is the
 * Session id its writes address: on Direct that is the live child Agent object,
 * on Remote the viewer publishes its own stable token. These tests prove the
 * steer orchestration never needs an Agent shape, addresses the write by the
 * CHILD id, and re-validates the exact subject object + generation before every
 * occurrence.
 * @module @xmoon76/dsh-pi-tui/steer-subject-neutral.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionUnchanged, steerAll, type SteerDeps, type SteerSubjectLike } from '../src/steer.ts'
import type { WriteOutcome } from '../src/runtime/write-outcome.ts'

const CHILD = 'child-x'
const PARENT = 'parent-1'

interface QueueWrite {
  readonly sessionId: string
  readonly itemId: string
}

interface PromptWrite {
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
}

interface NeutralFixture {
  queued: string[]
  running: boolean
  readonly readerCalls: string[]
  /** Any address of the parent session — the child gesture must produce none. */
  readonly parentAddresses: string[]
  readonly queueWrites: QueueWrite[]
  readonly promptWrites: PromptWrite[]
  readonly restored: string[]
  readonly notices: string[]
  onQueued: ((itemId: string) => void) | undefined
  queueOverride: ((itemId: string) => WriteOutcome | undefined) | undefined
  promptOverride: WriteOutcome | undefined
}

/** The official steer subject contract is `session.id` and nothing else. */
type ViewToken = SteerSubjectLike

interface AgentLikeSubject extends SteerSubjectLike {
  readonly status: 'running'
  readonly inbox: {
    readonly nextTurn: readonly { readonly id: string }[]
    remove(id: string): void
  }
  steer(message: unknown): void
  followup(message: unknown): void
}

function newWorld(queued: string[]): NeutralFixture {
  return {
    queued,
    running: true,
    readerCalls: [],
    parentAddresses: [],
    queueWrites: [],
    promptWrites: [],
    restored: [],
    notices: [],
    onQueued: undefined,
    queueOverride: undefined,
    promptOverride: undefined,
  }
}

/** A child-id-addressed semantic reader/writer over one world; the writer never
 *  consults an Agent object — only the addressed Session id. */
function neutralDeps(
  world: NeutralFixture,
  subject: () => SteerSubjectLike | undefined,
): SteerDeps {
  return {
    currentSubject: subject,
    currentGeneration: () => 1,
    pendingInputReader: {
      snapshot: (sessionId) => {
        world.readerCalls.push(sessionId)
        if (sessionId === PARENT) world.parentAddresses.push(`read:${sessionId}`)
        if (sessionId !== CHILD) return undefined
        return {
          running: world.running,
          items: world.queued.map(id => ({ id, placement: 'queued' as const, content: [] })),
        }
      },
    },
    writer: {
      prompt: async (sessionId, _message, mode) => {
        if (sessionId === PARENT) world.parentAddresses.push(`prompt:${sessionId}`)
        world.promptWrites.push({ sessionId, mode })
        return world.promptOverride ?? { kind: 'committed', value: undefined }
      },
      updateQueue: async (sessionId, itemId) => {
        if (sessionId === PARENT) world.parentAddresses.push(`queue:${sessionId}`)
        world.queueWrites.push({ sessionId, itemId })
        const override = world.queueOverride?.(itemId)
        if (override !== undefined) return override
        world.queued = world.queued.filter(id => id !== itemId)
        world.onQueued?.(itemId)
        return { kind: 'committed', value: undefined }
      },
    },
    notify: (message, kind) => { world.notices.push(`${kind}: ${message}`) },
    restoreDraft: (text) => { world.restored.push(text); return true },
    createDraft: (text) => ({ id: `draft:${text}`, text }),
    staleNotice: () => 'the child viewer changed while steering — try again',
    mergedNotice: () => 'the child viewer changed while steering — try again',
  }
}

function agentLikeSubject(calls: string[]): AgentLikeSubject {
  return {
    session: { id: CHILD },
    status: 'running',
    inbox: { nextTurn: [], remove: () => {} },
    steer: () => { calls.push('steer') },
    followup: () => { calls.push('followup') },
  }
}

/** One empty-draft queue sweep followed by one payload-bearing draft steer. */
async function runGestures(subject: SteerSubjectLike): Promise<NeutralFixture> {
  const world = newWorld(['a', 'b'])
  const deps = neutralDeps(world, () => subject)
  assert.equal(await steerAll(deps, '', { draftHasPayload: false }), 'ok')
  assert.equal(await steerAll(deps, 'hello', { draftHasPayload: true }), 'ok')
  return world
}

function token(id: string = CHILD): ViewToken {
  return Object.freeze({ session: Object.freeze({ id }) })
}

test('a plain viewer-owned token drives the same queue/draft semantics as a Direct Agent object', async () => {
  const agentCalls: string[] = []
  const directWorld = await runGestures(agentLikeSubject(agentCalls))
  const tokenWorld = await runGestures(token())

  assert.deepEqual(tokenWorld.queueWrites, directWorld.queueWrites,
    'the queue occurrence steer is transport-neutral')
  assert.deepEqual(tokenWorld.promptWrites, directWorld.promptWrites,
    'the draft steer is transport-neutral')
  assert.deepEqual(tokenWorld.queueWrites.map(write => write.itemId), ['a', 'b'],
    'both queued occurrences are steered in FIFO order')
  assert.deepEqual(tokenWorld.promptWrites, [{ sessionId: CHILD, mode: 'steer' }],
    'the payload draft is one occurrence-level steer of the child')
  assert.deepEqual(agentCalls, [],
    'the Agent object own steer/followup methods are never the delivery path')
  assert.deepEqual(tokenWorld.parentAddresses, [],
    'the child gesture never addresses the parent session')
})

test('a replaced subject token aborts the sweep before the next occurrence', async () => {
  const world = newWorld(['a', 'b'])
  let current: SteerSubjectLike = token()
  world.onQueued = () => { current = token() }
  const deps = neutralDeps(world, () => current)

  const outcome = await steerAll(deps, '', { draftHasPayload: false })
  assert.equal(outcome, 'stale', 'a replaced token refuses the rest of the sweep')
  assert.deepEqual(world.queueWrites.map(write => write.itemId), ['a'],
    'only the occurrence admitted by the replaced token is written')
  assert.deepEqual(world.queued, ['b'], 'the remaining occurrence is never replayed')
})

test('sessionUnchanged compares the subject object identity and generation, not the session id', () => {
  const held = token()
  assert.equal(sessionUnchanged({ subject: held, generation: 4 }, held, 4), true)
  assert.equal(sessionUnchanged({ subject: held, generation: 4 }, token(), 4), false,
    'a different object with the SAME session.id is stale')
  assert.equal(sessionUnchanged({ subject: held, generation: 4 }, held, 5), false,
    'a generation bump is stale')
  assert.equal(sessionUnchanged({ subject: held, generation: 4 }, undefined, 4), false,
    'a gone subject is stale')
})

test('the child-viewer gesture is child-id addressed and never reads an Agent field', async () => {
  const world = newWorld(['a', 'b'])
  // A viewer-owned token that throws on ANY property read other than `session`:
  // if the orchestration needed an Agent shape, this test would fail loudly.
  const agentFree = new Proxy(
    { session: { id: CHILD } },
    {
      get(target, prop) {
        if (prop === 'session') return target.session
        throw new Error(`the transport-neutral writer subject must not read "${String(prop)}"`)
      },
    },
  )
  const deps = neutralDeps(world, () => agentFree)

  assert.equal(await steerAll(deps, '', { draftHasPayload: false }), 'ok')
  assert.equal(await steerAll(deps, 'hello', { draftHasPayload: true }), 'ok')

  assert.deepEqual(world.readerCalls, [CHILD, CHILD], 'PendingInputReader is addressed by child id')
  assert.deepEqual(world.queueWrites.map(write => write.sessionId), [CHILD, CHILD])
  assert.deepEqual(world.promptWrites.map(write => write.sessionId), [CHILD],
    'SessionWriter.updateQueue/prompt receive the child id, never an Agent object')
  assert.deepEqual(world.parentAddresses, [], 'the parent session is never substituted for the child')
})

test('a convergent queue refusal on the token path settles without replay or restore', async () => {
  const world = newWorld(['a', 'b'])
  world.queueOverride = () => ({
    kind: 'rejected',
    error: { code: 'session/steer-unavailable', message: 'steering closed' },
  })
  const subject = token()
  const deps = neutralDeps(world, () => subject)

  assert.equal(await steerAll(deps, '', { draftHasPayload: false }), 'ok')
  assert.deepEqual(world.queueWrites.map(write => write.itemId), ['a'],
    'the sweep stops at the unavailable occurrence')
  assert.deepEqual(world.queued, ['a', 'b'], 'the refused occurrence is neither removed nor replayed')
  assert.deepEqual(world.restored, [], 'there is no draft payload to restore')
  assert.deepEqual(world.notices, [])
})

test('an indeterminate draft settle on the token path is reported without automatic retry', async () => {
  const world = newWorld([])
  world.promptOverride = {
    kind: 'indeterminate',
    error: { code: 'transport/unknown', message: 'unknown' },
  }
  const subject = token()
  const deps = neutralDeps(world, () => subject)

  assert.equal(await steerAll(deps, 'hello', { draftHasPayload: true }), 'indeterminate')
  assert.deepEqual(world.restored, [], 'an indeterminate send is never restored as unsent')
  assert.ok(
    world.notices.some(note => note.includes('indeterminate')),
    `the indeterminate settle must be reported: ${world.notices.join(' | ')}`,
  )
  assert.deepEqual(world.promptWrites.map(write => write.sessionId), [CHILD])
})
