/**
 * The visual snapshot provider's ONE bounded fork-lineage task.
 *
 * These cases drive the real provider with a controllable proof promise: the
 * synchronous own-range publish, the single ancestry task per selected
 * identity, the settle→revision→repaint path, the currentness fence, the
 * cached failure state and the live-seq growth of the own range. The proof
 * itself and the real `sessionQuery` read are covered elsewhere.
 * @module @xmoon76/dsh-pi-tui/app/visual-snapshot.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVisualEventSnapshotProvider,
  type VisualSnapshotSessionLike,
} from '../../src/app/bootstrap/visual-snapshot.ts'
import type { VisualLineageProof } from '../../src/app/bootstrap/visual-lineage.ts'
import { ownVisualOriginSpans } from '../../src/domain/visual/origin.ts'

/** A live-shaped Session face with a mutable seq/events pair. */
interface FakeSession extends VisualSnapshotSessionLike {
  seq: number
  events: { type: string }[]
}

function sessionOf(options: {
  readonly id: string
  readonly seeded?: boolean
  readonly cut?: number
  readonly parentSession?: string
  readonly events?: readonly { type: string }[]
}): FakeSession {
  const session: FakeSession = {
    id: options.id,
    seq: (options.events ?? []).length,
    header: {
      isSeeded: options.seeded === true,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    },
    inheritedEventCount: options.cut ?? 0,
    events: [...(options.events ?? [])],
    snapshotEvents() {
      return session.events
    },
  }
  return session
}

interface Harness {
  readonly provider: ReturnType<typeof createVisualEventSnapshotProvider>
  readonly proveCalls: string[];
  readonly tasks: Promise<void>[];
  readonly problems: string[];
  repaints: number;
  /** Whether the captured subject is still current (the repaint fence). */
  current: boolean;
  /** The exact agent currently behind the subject. */
  agent: { session: FakeSession } | undefined;
  resolve(proof: VisualLineageProof): Promise<void>;
  reject(error: unknown): Promise<void>;
  /** Select another agent as the subject. */
  select(next: { session: FakeSession } | undefined): void;
}

function harnessFor(initial: { session: FakeSession } | undefined): Harness {
  let resolveProof: ((proof: VisualLineageProof) => void) | undefined
  let rejectProof: ((error: unknown) => void) | undefined
  const proof = new Promise<VisualLineageProof>((resolve, reject) => {
    resolveProof = resolve
    rejectProof = reject
  })
  const harness: Harness = {
    provider: undefined as never,
    proveCalls: [],
    tasks: [],
    problems: [],
    repaints: 0,
    current: true,
    agent: initial,
    async resolve(next) {
      resolveProof?.(next)
      await harness.tasks[harness.tasks.length - 1]
    },
    async reject(error) {
      rejectProof?.(error)
      await harness.tasks[harness.tasks.length - 1]
    },
    select(next) {
      harness.agent = next
    },
  }
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => harness.agent,
    viewedChildAgent: () => undefined,
    lineage: {
      prove: (sessionId) => {
        harness.proveCalls.push(sessionId)
        return proof
      },
      run: (_label, task) => {
        harness.tasks.push(task())
      },
      isCurrentSubject: () => harness.current,
      requestRepaint: () => {
        harness.repaints += 1
      },
      reportProblem: (message) => {
        harness.problems.push(message)
      },
    },
  })
  Object.defineProperty(harness, 'provider', { value: provider, enumerable: true })
  return harness
}

const MAIN = { subjectKind: 'main' as const, subjectId: 'child' }

test('an unseeded Session proves its whole log synchronously and reads no parent', () => {
  const session = sessionOf({ id: 'root', events: [{ type: 'turn/start' }, { type: 'turn/end' }] })
  const harness = harnessFor({ session })
  const snapshot = harness.provider({ subjectKind: 'main', subjectId: 'root' })
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.verifiedOriginSpans, ownVisualOriginSpans('root', 0, 2))
  assert.equal(snapshot.originRevision, 1)
  assert.deepEqual(harness.proveCalls, [], 'no inherited prefix means no ancestry task')
  assert.deepEqual(harness.tasks, [])
})

test('a seeded Session publishes its own range first and starts exactly one ancestry task', () => {
  const session = sessionOf({
    id: 'child', seeded: true, cut: 5, parentSession: 'parent',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'turn/start' }, { type: 'turn/end' }, { type: 'turn/start' }, { type: 'session/end-seed' }, { type: 'turn/start' }],
  })
  const harness = harnessFor({ session })
  const first = harness.provider(MAIN)
  assert.ok(first !== undefined)
  assert.deepEqual(first.verifiedOriginSpans, ownVisualOriginSpans('child', 5, 7),
    'the inherited prefix stays unproven until the official read settles')
  assert.equal(harness.proveCalls.length, 1)
  assert.deepEqual(harness.proveCalls, ['child'])
  // Repeated frames reuse the same in-flight conclusion.
  harness.provider(MAIN)
  harness.provider(MAIN)
  assert.equal(harness.proveCalls.length, 1, 'one ancestry read per selected identity, never per frame')
  assert.equal(harness.tasks.length, 1)
})

test('a settled proof adds the inherited ranges, bumps the revision and requests ONE repaint', async () => {
  const session = sessionOf({
    id: 'child', seeded: true, cut: 2, parentSession: 'parent',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }, { type: 'turn/start' }],
  })
  const harness = harnessFor({ session })
  const pending = harness.provider(MAIN)
  assert.ok(pending !== undefined)
  assert.equal(pending.originRevision, 1)
  await harness.resolve({
    spans: [
      { startSeq: 0, endSeqExclusive: 2, sessionId: 'parent' },
      { startSeq: 2, endSeqExclusive: 4, sessionId: 'child' },
    ],
    unproven: undefined,
  })
  const settled = harness.provider(MAIN)
  assert.ok(settled !== undefined)
  assert.deepEqual(settled.verifiedOriginSpans, [
    { startSeq: 0, endSeqExclusive: 2, sessionId: 'parent' },
    { startSeq: 2, endSeqExclusive: 4, sessionId: 'child' },
  ])
  assert.equal(settled.originRevision, 2, 'the same Session seq now serves a new origin revision')
  assert.equal(harness.repaints, 1)
  assert.deepEqual(harness.problems, [])
  // A settled identity never re-reads the parent on later frames.
  harness.provider(MAIN)
  assert.equal(harness.proveCalls.length, 1)
  assert.equal(harness.repaints, 1)
})

test('a proof that adds nothing keeps the revision and requests no repaint', async () => {
  const session = sessionOf({
    id: 'child', seeded: true, cut: 2, parentSession: 'parent',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const harness = harnessFor({ session })
  harness.provider(MAIN)
  const before = harness.provider(MAIN)
  await harness.resolve({ spans: [], unproven: 'child: the fork parent could not be read' })
  const after = harness.provider(MAIN)
  assert.ok(before !== undefined && after !== undefined)
  assert.equal(after.originRevision, before.originRevision)
  assert.equal(harness.repaints, 0, 'nothing new to paint, so no extra frame')
  assert.deepEqual(harness.problems, ['child: the fork parent could not be read'])
})

test('a failed proof is cached for the identity and reported once', async () => {
  const session = sessionOf({
    id: 'child', seeded: true, cut: 2, parentSession: 'parent',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const harness = harnessFor({ session })
  harness.provider(MAIN)
  await harness.reject(new Error('sessionQuery exploded'))
  harness.provider(MAIN)
  harness.provider(MAIN)
  assert.equal(harness.proveCalls.length, 1, 'a failed identity is not re-read every frame')
  assert.equal(harness.problems.length, 1)
  assert.match(harness.problems[0] ?? '', /sessionQuery exploded/u)
  assert.equal(harness.repaints, 0)
})

test('a late proof for a replaced subject never repaints or rewrites the new subject', async () => {
  const first = sessionOf({
    id: 'child-a', seeded: true, cut: 2, parentSession: 'parent-a',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const second = sessionOf({ id: 'child-b', events: [{ type: 'turn/start' }] })
  const harness = harnessFor({ session: first })
  const firstSnapshot = harness.provider({ subjectKind: 'main', subjectId: 'child-a' })
  assert.ok(firstSnapshot !== undefined)
  harness.select({ session: second })
  const secondSnapshot = harness.provider({ subjectKind: 'main', subjectId: 'child-b' })
  assert.ok(secondSnapshot !== undefined)
  assert.deepEqual(secondSnapshot.verifiedOriginSpans, ownVisualOriginSpans('child-b', 0, 1))
  const secondRevision = secondSnapshot.originRevision
  await harness.resolve({
    spans: [
      { startSeq: 0, endSeqExclusive: 2, sessionId: 'parent-a' },
      { startSeq: 2, endSeqExclusive: 3, sessionId: 'child-a' },
    ],
    unproven: undefined,
  })
  assert.equal(harness.repaints, 0, 'a replaced subject never repaints the new one')
  const after = harness.provider({ subjectKind: 'main', subjectId: 'child-b' })
  assert.ok(after !== undefined)
  assert.deepEqual(after.verifiedOriginSpans, ownVisualOriginSpans('child-b', 0, 1))
  assert.equal(after.originRevision, secondRevision, 'the late result never mutates the new subject state')
})

test('the currentness fence suppresses the repaint of a subject that was already replaced', async () => {
  const session = sessionOf({
    id: 'child', seeded: true, cut: 2, parentSession: 'parent',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const harness = harnessFor({ session })
  harness.provider(MAIN)
  harness.current = false
  await harness.resolve({
    spans: [
      { startSeq: 0, endSeqExclusive: 2, sessionId: 'parent' },
      { startSeq: 2, endSeqExclusive: 3, sessionId: 'child' },
    ],
    unproven: undefined,
  })
  assert.equal(harness.repaints, 0, 'a disowned subject never drives a surface repaint')
  assert.equal(harness.provider(MAIN)?.verifiedOriginSpans.length, 2,
    'the proven ranges are still served to the owning snapshot')
})

test('the own range follows live appends while the inherited ranges stay fixed', async () => {
  const session = sessionOf({
    id: 'child', seeded: true, cut: 2, parentSession: 'parent',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const harness = harnessFor({ session })
  harness.provider(MAIN)
  await harness.resolve({
    spans: [
      { startSeq: 0, endSeqExclusive: 2, sessionId: 'parent' },
      { startSeq: 2, endSeqExclusive: 3, sessionId: 'child' },
    ],
    unproven: undefined,
  })
  assert.equal(harness.repaints, 1)
  // A live append after the child committed more of its own history.
  session.events.push({ type: 'turn/start' }, { type: 'step/start' })
  session.seq = session.events.length
  const grown = harness.provider(MAIN)
  assert.ok(grown !== undefined)
  assert.deepEqual(grown.verifiedOriginSpans, [
    { startSeq: 0, endSeqExclusive: 2, sessionId: 'parent' },
    { startSeq: 2, endSeqExclusive: 5, sessionId: 'child' },
  ])
  assert.equal(harness.repaints, 1, 'an append does not start a second ancestry read or repaint')
  assert.equal(harness.proveCalls.length, 1)
})

test('an A -> B -> A subject round trip proves each binding again instead of reusing the old task', async () => {
  const first = sessionOf({
    id: 'child-a', seeded: true, cut: 2, parentSession: 'parent-a',
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const second = sessionOf({ id: 'child-b', events: [{ type: 'turn/start' }] })
  const harness = harnessFor({ session: first })
  harness.provider({ subjectKind: 'main', subjectId: 'child-a' })
  harness.select({ session: second })
  harness.provider({ subjectKind: 'main', subjectId: 'child-b' })
  harness.select({ session: first })
  harness.provider({ subjectKind: 'main', subjectId: 'child-a' })
  assert.equal(harness.proveCalls.length, 2, 'the rebound A identity starts its own proof')
  assert.equal(harness.proveCalls[1], 'child-a')
})

test('Remote returns no snapshot at all', () => {
  const session = sessionOf({ id: 'remote', events: [{ type: 'turn/start' }] })
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => true,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  assert.equal(provider(MAIN), undefined)
})

test('a subject whose id does not match the live Session is refused', () => {
  const session = sessionOf({ id: 'live', events: [{ type: 'turn/start' }] })
  const harness = harnessFor({ session })
  assert.equal(harness.provider({ subjectKind: 'main', subjectId: 'other' }), undefined)
  assert.equal(harness.proveCalls.length, 0)
})

test('inconsistent seed facts prove nothing and start no ancestry task', () => {
  // A non-seeded header that still records inherited events (or a missing
  // flag) cannot be split into own/inherited history: attributing the whole
  // log to the current Session would grant it over an ancestor's events.
  const inconsistent = sessionOf({
    id: 'child', seeded: false, cut: 3,
    events: [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/end-seed' }],
  })
  const harness = harnessFor({ session: inconsistent })
  const snapshot = harness.provider(MAIN)
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.verifiedOriginSpans, [], 'no seq is attributed to any Session')
  assert.equal(harness.proveCalls.length, 0, 'inconsistent metadata never triggers a parent read')

  const missingFlag = sessionOf({ id: 'child', events: [{ type: 'turn/start' }] })
  Object.defineProperty(missingFlag.header, 'isSeeded', { value: undefined, enumerable: true })
  Object.defineProperty(missingFlag, 'inheritedEventCount', { value: 1, enumerable: true })
  const absent = harnessFor({ session: missingFlag })
  assert.deepEqual(absent.provider(MAIN)?.verifiedOriginSpans, [],
    'an absent seed flag is not a licence to attribute the whole log')
  assert.equal(absent.proveCalls.length, 0)
})
