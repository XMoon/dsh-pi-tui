/**
 * The visual snapshot provider: exact display-subject selection plus the
 * official seed/cut validation that feeds the session-free epoch authority.
 *
 * These cases drive the real provider with hand-built live Session faces. The
 * provider owns no ancestry query and no async task: a valid log is returned
 * synchronously, while inconsistent seed metadata makes the whole snapshot
 * unavailable instead of guessing that the log belongs to the current Session.
 * @module @xmoon76/dsh-pi-tui/app/visual-snapshot.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVisualEventSnapshotProvider,
  type VisualSnapshotSessionLike,
} from '../../src/app/bootstrap/visual-snapshot.ts'

interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** A live-shaped Session face with a mutable seq/events pair. */
interface FakeSession extends VisualSnapshotSessionLike {
  seq: number
  events: FakeEvent[]
}

function sessionOf(options: {
  readonly id?: string
  readonly seeded?: boolean
  readonly cut?: number
  readonly events?: readonly FakeEvent[]
} = {}): FakeSession {
  const events = [...(options.events ?? [])]
  const session: FakeSession = {
    id: options.id ?? 'session-main',
    seq: events.length,
    header: { isSeeded: options.seeded === true },
    inheritedEventCount: options.cut ?? 0,
    events,
    snapshotEvents() {
      return session.events
    },
  }
  return session
}

const MAIN = { subjectKind: 'main' as const, subjectId: 'session-main' }

test('an unseeded Session returns its committed log synchronously with no parent read', () => {
  const session = sessionOf({
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 0, message: { content: [] } } },
      { type: 'projection/update', seq: 2 },
    ],
  })
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  const snapshot = provider(MAIN)
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.session, session, 'the exact live Session object is returned')
  assert.equal(snapshot.sessionId, 'session-main')
  assert.equal(snapshot.seq, 3)
  assert.deepEqual(snapshot.events.map(event => event.type), ['turn/start', 'assistant/message'],
    'only the authority-relevant committed events are handed on')
})

test('Remote returns undefined: no trusted complete-log seam', () => {
  const session = sessionOf()
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => true,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  assert.equal(provider(MAIN), undefined)
})

test('the requested display subject is fenced by the exact Session id', () => {
  const session = sessionOf()
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  assert.equal(provider({ subjectKind: 'main', subjectId: 'session-other' }), undefined)
  assert.ok(provider({ subjectKind: 'main', subjectId: 'session-main' }) !== undefined)
})

test('the viewed-child subject reads the viewer Agent, never the main one', () => {
  const main = sessionOf({ id: 'session-main' })
  const child = sessionOf({ id: 'session-child' })
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session: main }),
    viewedChildAgent: () => ({ session: child }),
  })
  const snapshot = provider({ subjectKind: 'viewed-child', subjectId: 'session-child' })
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.session, child)
  assert.equal(snapshot.sessionId, 'session-child')
})

test('the seq memo reuses the filtered log for the same Session and seq, and refreshes on growth', () => {
  const session = sessionOf({ events: [{ type: 'turn/start', seq: 0, data: { turn: 1 } }] })
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  const first = provider(MAIN)
  assert.ok(first !== undefined)
  const again = provider(MAIN)
  assert.ok(again !== undefined)
  assert.equal(again.events, first.events, 'the same seq serves the same filtered array')
  session.events.push({ type: 'turn/end', seq: 1, data: { turn: 1 } })
  session.seq = 2
  const grown = provider(MAIN)
  assert.ok(grown !== undefined)
  assert.notEqual(grown.events, first.events, 'a new committed seq re-reads the log')
  assert.deepEqual(grown.events.map(event => event.type), ['turn/start', 'turn/end'])
})

test('a same-id successor Session object never reuses the retired object cache', () => {
  const first = sessionOf({ id: 'session-main' })
  const second = sessionOf({ id: 'session-main', events: [{ type: 'turn/start', seq: 0, data: { turn: 1 } }] })
  let current = first
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session: current }),
    viewedChildAgent: () => undefined,
  })
  const before = provider(MAIN)
  current = second
  const after = provider(MAIN)
  assert.ok(before !== undefined && after !== undefined)
  assert.equal(before.session, first)
  assert.equal(after.session, second, 'the exact live Session object is the identity')
  assert.notEqual(after.events, before.events)
})

test('inconsistent seed metadata makes the whole visual snapshot unavailable', () => {
  const cases: readonly {
    readonly label: string
    readonly session: FakeSession
  }[] = [
    {
      label: 'missing isSeeded',
      session: { ...sessionOf(), header: {} },
    },
    {
      label: 'non-seeded with a non-zero inherited count',
      session: sessionOf({ seeded: false, cut: 1 }),
    },
    {
      label: 'a negative inherited count',
      session: sessionOf({ seeded: true, cut: -1 }),
    },
    {
      label: 'a non-integer inherited count',
      session: sessionOf({ seeded: true, cut: 1.5 }),
    },
    {
      label: 'a cut at the end of the log without a marker',
      session: sessionOf({ seeded: true, cut: 1, events: [{ type: 'turn/start', seq: 0 }] }),
    },
    {
      label: 'a cut beyond the real log',
      session: sessionOf({ seeded: true, cut: 4, events: [{ type: 'turn/start', seq: 0 }] }),
    },
    {
      label: 'a cut without the inherited marker',
      session: sessionOf({
        seeded: true,
        cut: 1,
        events: [
          { type: 'turn/start', seq: 0, data: { turn: 1 } },
          { type: 'turn/end', seq: 1, data: { turn: 1 } },
        ],
      }),
    },
    {
      label: 'a marker at another seq',
      session: sessionOf({
        seeded: true,
        cut: 1,
        events: [
          { type: 'session/end-seed', seq: 0, data: { inherited: true } },
          { type: 'turn/start', seq: 1, data: { turn: 1 } },
        ],
      }),
    },
    {
      label: 'a non-inherited end-seed',
      session: sessionOf({
        seeded: true,
        cut: 1,
        events: [
          { type: 'turn/start', seq: 0, data: { turn: 1 } },
          { type: 'session/end-seed', seq: 1, data: { inherited: false } },
        ],
      }),
    },
  ]
  for (const { label, session } of cases) {
    const provider = createVisualEventSnapshotProvider({
      isRemote: () => false,
      mainAgent: () => ({ session }),
      viewedChildAgent: () => undefined,
    })
    assert.equal(provider({ subjectKind: 'main', subjectId: session.id }), undefined, label)
  }
})

test('a valid seed cut is accepted and keeps the inherited marker in the authority log', () => {
  const session = sessionOf({
    id: 'session-child',
    seeded: true,
    cut: 1,
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'session/end-seed', seq: 1, data: { inherited: true } },
      { type: 'turn/start', seq: 2, data: { turn: 2 } },
    ],
  })
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  const snapshot = provider({ subjectKind: 'main', subjectId: 'session-child' })
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.events.map(event => event.type), ['turn/start', 'session/end-seed', 'turn/start'],
    'the epoch boundary stays visible to the authority')
})

test('a seeded Session with an empty inherited prefix is valid', () => {
  const session = sessionOf({
    seeded: true,
    cut: 0,
    events: [{ type: 'turn/start', seq: 0, data: { turn: 1 } }],
  })
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => ({ session }),
    viewedChildAgent: () => undefined,
  })
  assert.ok(provider(MAIN) !== undefined)
})
