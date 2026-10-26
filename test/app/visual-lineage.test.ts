/**
 * The fork-lineage proof: per-seq origin ranges from official Session facts.
 *
 * These cases use hand-built OFFICIAL observation shapes (the exact
 * `sessionQuery.observeSession()` face) so the algorithm is pinned without IO:
 * the own/cut split from `header.isSeeded` + `inheritedEventCount`, the exact
 * cut marker, the strict full-prefix comparison, the recursive ancestor
 * attribution, the release of every observation, and the fail-closed reasons.
 * The real observation service is covered by the production integration test.
 * @module @xmoon76/dsh-pi-tui/app/visual-lineage.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  proveVisualLineage,
  type VisualLineageObservation,
  type VisualLineageQuery,
} from '../../src/app/bootstrap/visual-lineage.ts'
import type { VerifiedVisualOriginSpan } from '../../src/domain/visual/origin.ts'

/** One stored event in the official shape the prefix comparison reads. */
function event(seq: number, type: string, data: unknown): unknown {
  return { type, seq, time: seq + 1, data }
}

/** A completed turn (turn/start, step/start, step/end, turn/end). */
function turn(turnNumber: number, startSeq: number): unknown[] {
  const base = startSeq
  return [
    event(base, 'turn/start', { turn: turnNumber }),
    event(base + 1, 'step/start', { turn: turnNumber, step: 1 }),
    event(base + 2, 'step/end', { turn: turnNumber, step: 1 }),
    event(base + 3, 'turn/end', { turn: turnNumber, reason: { kind: 'completed' } }),
  ]
}

/** The official facts one fake observation exposes. */
interface FakeFacts {
  readonly isSeeded: boolean
  readonly inheritedEventCount: number
  readonly parentSession?: string
  readonly events: readonly unknown[]
}

/** One fake observation, released through the official disposable contract. */
class FakeObservation implements VisualLineageObservation {
  readonly header: { readonly id: string; readonly isSeeded: boolean; readonly parentSession?: string }
  readonly inheritedEventCount: number
  readonly events: readonly unknown[]
  private readonly release: () => void

  constructor(sessionId: string, facts: FakeFacts, release: () => void) {
    this.header = {
      id: sessionId,
      isSeeded: facts.isSeeded,
      ...(facts.parentSession === undefined ? {} : { parentSession: facts.parentSession }),
    }
    this.inheritedEventCount = facts.inheritedEventCount
    this.events = facts.events
    this.release = release
  }

  [Symbol.dispose](): void {
    this.release()
  }
}

interface QueryLog {
  readonly observed: string[];
  readonly disposed: string[];
  readonly query: VisualLineageQuery;
}

/** A fake official query over a sessionId → facts map. */
function queryOf(facts: ReadonlyMap<string, FakeFacts>): QueryLog {
  const observed: string[] = []
  const disposed: string[] = []
  return {
    observed,
    disposed,
    query: {
      async observeSession(sessionId: string) {
        observed.push(sessionId)
        const found = facts.get(sessionId)
        if (found === undefined) throw new Error(`session "${sessionId}" is not stored`)
        return new FakeObservation(sessionId, found, () => disposed.push(sessionId))
      },
    },
  }
}

const PARENT_EVENTS = turn(1, 0)

/** One child-owned `session/end-seed` at the exact cut plus one own turn. */
function seededLog(
  sessionId: string,
  inherited: readonly unknown[],
  ownTurn: number,
  parentSession: string,
): { readonly facts: FakeFacts; readonly events: readonly unknown[] } {
  const events = [
    ...inherited,
    event(inherited.length, 'session/end-seed', { inherited: true }),
    ...turn(ownTurn, inherited.length + 1),
  ]
  return {
    events,
    facts: {
      isSeeded: true,
      inheritedEventCount: inherited.length,
      parentSession,
      events,
    },
  }
}

/** The exact own range of one seeded child (its marker is own history). */
function childOwnRange(child: { readonly facts: FakeFacts }): VerifiedVisualOriginSpan {
  const cut = child.facts.inheritedEventCount
  return { startSeq: cut, endSeqExclusive: child.facts.events.length, sessionId: 'child' }
}

test('an unseeded Session proves its whole log from ONE official observation', async () => {
  const { observed, disposed, query } = queryOf(new Map([
    ['root', { isSeeded: false, inheritedEventCount: 0, events: PARENT_EVENTS }],
  ]))
  const proof = await proveVisualLineage('root', query)
  assert.deepEqual(proof.spans, [{ startSeq: 0, endSeqExclusive: 4, sessionId: 'root' }])
  assert.equal(proof.unproven, undefined)
  assert.deepEqual(observed, ['root'], 'no inherited prefix means no parent read')
  assert.deepEqual(disposed, ['root'])
})

test('a matching parent proves the inherited prefix and the child keeps its own range', async () => {
  const child = seededLog('child', PARENT_EVENTS, 2, 'parent')
  const { observed, disposed, query } = queryOf(new Map([
    ['child', child.facts],
    ['parent', { isSeeded: false, inheritedEventCount: 0, events: PARENT_EVENTS }],
  ]))
  const proof = await proveVisualLineage('child', query)
  assert.deepEqual(proof.spans, [
    { startSeq: 0, endSeqExclusive: 4, sessionId: 'parent' },
    childOwnRange(child),
  ])
  assert.equal(proof.unproven, undefined)
  assert.deepEqual(observed, ['child', 'parent'])
  assert.deepEqual(disposed, ['parent', 'child'], 'every observation lease is released')
})

test('A -> B -> C proves each ancestor level and trims it to the inherited window', async () => {
  const b = seededLog('b', PARENT_EVENTS, 2, 'a')
  const c = seededLog('c', b.events, 3, 'b')
  const { observed, disposed, query } = queryOf(new Map([
    ['c', c.facts],
    ['b', { isSeeded: true, inheritedEventCount: 4, parentSession: 'a', events: b.events }],
    ['a', { isSeeded: false, inheritedEventCount: 0, events: PARENT_EVENTS }],
  ]))
  const proof = await proveVisualLineage('c', query)
  assert.deepEqual(proof.spans, [
    { startSeq: 0, endSeqExclusive: 4, sessionId: 'a' },
    { startSeq: 4, endSeqExclusive: 9, sessionId: 'b' },
    { startSeq: 9, endSeqExclusive: c.events.length, sessionId: 'c' },
  ])
  assert.equal(proof.unproven, undefined)
  assert.deepEqual(observed, ['c', 'b', 'a'], 'the actual chain is walked once, nearest parent after the Session itself')
  assert.deepEqual(disposed, ['a', 'b', 'c'], 'each level releases its own cut after its recursion settles')
})

test('a missing parent Session leaves only the child own range and a bounded reason', async () => {
  const child = seededLog('child', PARENT_EVENTS, 2, 'missing')
  const { observed, query } = queryOf(new Map([['child', child.facts]]))
  const proof = await proveVisualLineage('child', query)
  assert.deepEqual(proof.spans, [childOwnRange(child)])
  assert.match(proof.unproven ?? '', /child: the fork parent could not be read/u)
  assert.deepEqual(observed, ['child', 'missing'])
})

test('a prefix that differs from the parent events is never attributed to the parent', async () => {
  const child = seededLog('child', PARENT_EVENTS, 2, 'parent')
  const tampered = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'step/end', { turn: 1, step: 1 }),
    // One byte-level change in the tail.
    event(3, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]
  const { query } = queryOf(new Map([
    ['child', child.facts],
    ['parent', { isSeeded: false, inheritedEventCount: 0, events: tampered }],
  ]))
  const proof = await proveVisualLineage('child', query)
  assert.deepEqual(proof.spans, [childOwnRange(child)])
  assert.match(proof.unproven ?? '', /prefix differs/u)
})

test('a parent header naming another Session, or a shorter log, stays unproven', async () => {
  const child = seededLog('child', PARENT_EVENTS, 2, 'parent')
  const base = queryOf(new Map([
    ['child', child.facts],
    ['parent', { isSeeded: false, inheritedEventCount: 0, events: PARENT_EVENTS }],
  ]))

  const wrongId = await proveVisualLineage('child', {
    async observeSession(sessionId: string) {
      if (sessionId === 'parent') {
        return new FakeObservation(
          'someone-else',
          { isSeeded: false, inheritedEventCount: 0, events: PARENT_EVENTS },
          () => {},
        )
      }
      return base.query.observeSession(sessionId, { projectionMode: 'none' })
    },
  })
  assert.deepEqual(wrongId.spans, [childOwnRange(child)])
  assert.match(wrongId.unproven ?? '', /identifies another Session/u)

  const short = queryOf(new Map([
    ['child', child.facts],
    ['parent', { isSeeded: false, inheritedEventCount: 0, events: PARENT_EVENTS.slice(0, 2) }],
  ]))
  const shortProof = await proveVisualLineage('child', short.query)
  assert.deepEqual(shortProof.spans, [childOwnRange(child)])
  assert.match(shortProof.unproven ?? '', /shorter than the inherited prefix/u)
})

test('a missing official cut marker refuses the inherited prefix', async () => {
  const events = [
    ...PARENT_EVENTS,
    ...turn(2, 4),
  ]
  const { observed, query } = queryOf(new Map([
    ['child', { isSeeded: true, inheritedEventCount: 4, parentSession: 'parent', events }],
  ]))
  const proof = await proveVisualLineage('child', query)
  assert.deepEqual(proof.spans, [{ startSeq: 4, endSeqExclusive: events.length, sessionId: 'child' }])
  assert.match(proof.unproven ?? '', /not the official session\/end-seed marker/u)
  assert.deepEqual(observed, ['child'], 'an unusable cut never triggers a parent read')
})

test('an unusable inherited cut proves nothing at all (fail closed)', async () => {
  const { query } = queryOf(new Map([
    ['child', { isSeeded: true, inheritedEventCount: 99, parentSession: 'parent', events: PARENT_EVENTS }],
  ]))
  const proof = await proveVisualLineage('child', query)
  assert.deepEqual(proof.spans, [])
  assert.match(proof.unproven ?? '', /does not fit its log/u)
})

test('a repeated Session in the actual parent chain stops the recursion without a gap-fill', async () => {
  // b's recorded parent points back at c — a corrupt metadata shape. c still
  // owns [7, len); b's own [4, 7) is attributable; b's inherited [0, 4) is not.
  const bEvents = [
    ...PARENT_EVENTS,
    event(4, 'session/end-seed', { inherited: true }),
    event(5, 'turn/start', { turn: 2 }),
    event(6, 'step/start', { turn: 2, step: 1 }),
  ]
  const cEvents = [
    ...bEvents,
    event(7, 'session/end-seed', { inherited: true }),
    ...turn(3, 8),
  ]
  const { observed, query } = queryOf(new Map([
    ['c', { isSeeded: true, inheritedEventCount: 7, parentSession: 'b', events: cEvents }],
    ['b', { isSeeded: true, inheritedEventCount: 4, parentSession: 'c', events: bEvents }],
  ]))
  const proof = await proveVisualLineage('c', query)
  assert.deepEqual(proof.spans, [
    { startSeq: 4, endSeqExclusive: 7, sessionId: 'b' },
    { startSeq: 7, endSeqExclusive: cEvents.length, sessionId: 'c' },
  ])
  assert.match(proof.unproven ?? '', /repeats "c"/u)
  assert.deepEqual(observed, ['c', 'b'], 'the cycle is detected from the actual chain, never by a depth budget')
})

test('a parent reporting an inherited cut without seed lineage is refused', async () => {
  const child = seededLog('child', PARENT_EVENTS, 2, 'parent')
  const { query } = queryOf(new Map([
    ['child', child.facts],
    ['parent', { isSeeded: false, inheritedEventCount: 2, events: PARENT_EVENTS }],
  ]))
  const proof = await proveVisualLineage('child', query)
  assert.deepEqual(proof.spans, [childOwnRange(child)])
  assert.match(proof.unproven ?? '', /without seed lineage/u)
})

test('an unobservable Session reports a bounded reason instead of throwing', async () => {
  const proof = await proveVisualLineage('missing', {
    async observeSession() {
      throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
    },
  })
  assert.deepEqual(proof.spans, [])
  assert.match(proof.unproven ?? '', /missing: the Session could not be observed \(SESSION_QUERY_SESSION_NOT_FOUND\)/u)
})
