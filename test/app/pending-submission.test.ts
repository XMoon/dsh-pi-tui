/**
 * Pure contract tests for the client-local pending-submission ledger
 * (D2.1 follow-up): identity-keyed echoes that bridge the editor-cleared →
 * authoritative-occurrence gap. Correlation is by request id only — never by
 * text.
 * @module @xmoon76/dsh-pi-tui/pending-submission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingSubmissions, pendingSubmissionsNotReplaced, type DirectPendingSubmissionEvent } from '../../src/app/submission/pending-submission.ts'

function ledger(): PendingSubmissions {
  return new PendingSubmissions()
}

test('begin records transcript/queued/steering echoes in insertion order', () => {
  const pending = ledger()
  pending.begin({ requestId: 'r1', placement: 'transcript', text: 'idle', createdAt: 1, sessionId: 's', generation: 3 })
  pending.accept('r1')
  pending.begin({ requestId: 'r2', placement: 'queued', text: 'queued', createdAt: 2, sessionId: 's', generation: 3 })
  pending.accept('r2')
  pending.begin({ requestId: 'r3', placement: 'steering', text: 'steer', createdAt: 3, sessionId: 's', generation: 3 })
  pending.accept('r3')
  assert.deepEqual(pending.snapshot().map(echo => [echo.requestId, echo.placement]), [
    ['r1', 'transcript'],
    ['r2', 'queued'],
    ['r3', 'steering'],
  ])
})

test('two same-text submissions stay distinct by request id', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'same', createdAt: 1 })
  pending.accept('a')
  pending.begin({ requestId: 'b', placement: 'steering', text: 'same', createdAt: 2 })
  pending.accept('b')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['a', 'b'])
})

test('an authoritative rpc id suppresses only the matching echo (identity, never text)', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'same', createdAt: 1 })
  pending.accept('a')
  pending.begin({ requestId: 'b', placement: 'steering', text: 'same', createdAt: 2 })
  pending.accept('b')
  const visible = pendingSubmissionsNotReplaced(pending.snapshot(), new Set(['a']))
  assert.deepEqual(visible.map(echo => echo.requestId), ['b'])
})

test('an echo re-appears when its authoritative counterpart is no longer visible', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'A', createdAt: 1 })
  pending.accept('a')
  assert.deepEqual(pendingSubmissionsNotReplaced(pending.snapshot(), new Set(['a'])), [])
  // The Host claimed the occurrence (removed it from the inbox) before the
  // durable message landed: the echo is retained, not deleted, so the content
  // stays visible instead of blanking.
  const visible = pendingSubmissionsNotReplaced(pending.snapshot(), new Set())
  assert.deepEqual(visible.map(echo => echo.requestId), ['a'])
})

test('observeDurable removes exactly the durable identity (never text)', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'transcript', text: 'same', createdAt: 1 })
  pending.accept('a')
  pending.begin({ requestId: 'b', placement: 'transcript', text: 'same', createdAt: 2 })
  pending.accept('b')
  pending.observeDurable('a')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['b'])
})

test('settle removes a failed/cancelled/indeterminate echo', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'queued', text: 'A', createdAt: 1 })
  pending.accept('a')
  pending.settle('a')
  pending.settle('a')
  assert.deepEqual(pending.snapshot(), [])
})

test('a late settlement of one identity never clears a newer unrelated echo', () => {
  const pending = ledger()
  pending.begin({ requestId: 'old', placement: 'queued', text: 'old', createdAt: 1 })
  pending.accept('old')
  pending.begin({ requestId: 'new', placement: 'queued', text: 'new', createdAt: 2 })
  pending.accept('new')
  pending.settle('old')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['new'])
})

test('clearForSubject drops echoes from another session or generation', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'queued', text: 'A', createdAt: 1, sessionId: 's1', generation: 1 })
  pending.accept('a')
  pending.begin({ requestId: 'b', placement: 'queued', text: 'B', createdAt: 2, sessionId: 's2', generation: 2 })
  pending.accept('b')
  pending.clearForSubject('s1', 1)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['a'])
})

test('clear removes every echo', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'A', createdAt: 1 })
  pending.accept('a')
  pending.begin({ requestId: 'b', placement: 'steering', text: 'B', createdAt: 2 })
  pending.accept('b')
  pending.clear()
  assert.deepEqual(pending.snapshot(), [])
})

test('snapshot is a detached copy: mutation never leaks into the ledger', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'queued', text: 'A', createdAt: 1 })
  pending.accept('a')
  const snapshot = pending.snapshot()
  ;(snapshot[0] as { text: string }).text = 'mutated'
  assert.equal(pending.snapshot()[0]?.text, 'A')
})

// ── Direct Host terminal reconciliation (receipt/index/seq) ─────────────────
// The official Client retires a local echo once its Inbox occurrence was
// CLAIMED (receipt index null) and a strictly later `request/context` /
// `turn/end` crosses that receipt without a durable `user/message`. These
// cases pin the exact identity/ordering predicates, and they pin that a
// canceled Inbox removal — including a queue steer's remove-then-reinsert —
// proves only that the occurrence left its list: a genuine removal is settled
// by the application write, never by the splice marker.

const SESSION = 's1'
const GENERATION = 4

function beginEcho(pending: PendingSubmissions, requestId: string, overrides: {
  sessionId?: string
  generation?: number
  placement?: 'transcript' | 'queued' | 'steering'
  /** PR2: register a held attempt's echo hidden (published by acceptance). */
  hidden?: boolean
} = {}): void {
  pending.begin({
    requestId,
    placement: overrides.placement ?? 'transcript',
    text: `text-${requestId}`,
    createdAt: 1,
    sessionId: overrides.sessionId ?? SESSION,
    generation: overrides.generation ?? GENERATION,
    ...(overrides.hidden === true ? { hidden: true } : {}),
  })
}

function userMessage(rpcId: string): { id: string; role: 'user'; content: []; source: { kind: 'user'; rpcId: string } } {
  return { id: `message-${rpcId}`, role: 'user', content: [], source: { kind: 'user', rpcId } }
}

function insertedSplice(seq: number, target: 'next-turn' | 'next-step', start: number, rpcIds: readonly string[]): DirectPendingSubmissionEvent {
  return {
    type: 'agent/inbox/spliced',
    seq,
    data: { target, start, inserted: rpcIds.map(userMessage) },
  }
}

function removedSplice(seq: number, target: 'next-turn' | 'next-step', start: number, removedCount: number, outcome?: 'canceled'): DirectPendingSubmissionEvent {
  return {
    type: 'agent/inbox/spliced',
    seq,
    data: { target, start, removedCount, inserted: [], ...(outcome === undefined ? {} : { outcome }) },
  }
}

function observe(pending: PendingSubmissions, event: DirectPendingSubmissionEvent, overrides: {
  sessionId?: string
  generation?: number
} = {}): boolean {
  return pending.observeDirectHostEvent({
    sessionId: overrides.sessionId ?? SESSION,
    generation: overrides.generation ?? GENERATION,
    event,
  })
}

test('a claimed echo retires on a later turn/end without a durable message; an unclaimed sibling stays', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r2')
  assert.equal(observe(pending, insertedSplice(10, 'next-turn', 0, ['r1'])), false,
    'an insertion is a receipt update, not a visible change')
  assert.equal(observe(pending, insertedSplice(11, 'next-turn', 1, [])), false)
  // The Host claims r1: removal without the producer's `canceled` marker.
  assert.equal(observe(pending, removedSplice(12, 'next-turn', 0, 1)), false)
  assert.equal(observe(pending, { type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'error' } } }), true,
    'the claimed, non-durable echo retires on the strictly later turn boundary')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2'],
    'an echo without an Inbox receipt is untouched')
})

test('a claimed echo retires on a later request/context; an equal or earlier boundary never retires', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(20, 'next-turn', 0, ['r1']))
  observe(pending, removedSplice(21, 'next-turn', 0, 1))
  assert.equal(observe(pending, { type: 'request/context', seq: 21, data: {} }), false,
    'a boundary at the claim seq is not strictly later')
  assert.equal(observe(pending, { type: 'request/context', seq: 20, data: {} }), false,
    'an earlier boundary cannot retire a later receipt')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
  assert.equal(observe(pending, { type: 'request/context', seq: 22, data: {} }), true)
  assert.deepEqual(pending.snapshot(), [])
})

test('an unclaimed echo survives other turn boundaries and keeps the receipt position', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(30, 'next-turn', 0, ['r1']))
  assert.equal(observe(pending, { type: 'turn/end', seq: 31, data: { turn: 1, reason: { kind: 'error' } } }), false,
    'the occurrence is still in the Inbox: a turn boundary proves nothing about it')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
  // A later claim still addresses the SAME occurrence at its original index.
  assert.equal(observe(pending, removedSplice(32, 'next-turn', 0, 1)), false)
  assert.equal(observe(pending, { type: 'turn/end', seq: 33, data: { turn: 2, reason: { kind: 'error' } } }), true)
  assert.deepEqual(pending.snapshot(), [])
})

test('receipt indices follow prior splices, so a second claim retires the shifted echo too', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r2')
  observe(pending, insertedSplice(40, 'next-turn', 0, ['r1', 'r2']))
  // r1 claimed: r2 moves from index 1 to 0.
  assert.equal(observe(pending, removedSplice(41, 'next-turn', 0, 1)), false)
  // The claim now addresses r2 at its ACTUAL shifted index.
  assert.equal(observe(pending, removedSplice(42, 'next-turn', 0, 1)), false)
  assert.equal(observe(pending, { type: 'turn/end', seq: 43, data: { turn: 1, reason: { kind: 'error' } } }), true)
  assert.deepEqual(pending.snapshot(), [], 'both claimed echoes retire; a stale index would leave r2 behind')
})

test('a canceled removal alone never retires: it only clears the receipt position', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r2')
  observe(pending, insertedSplice(50, 'next-turn', 0, ['r1', 'r2']))
  assert.equal(observe(pending, removedSplice(51, 'next-turn', 0, 1, 'canceled')), false,
    'the producer marker proves only that the occurrence left its list')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1', 'r2'],
    'a genuine queue removal is settled by the application write, never inferred from the splice')
  // The claimed r1 has no successor: the strictly later boundary retires it.
  // r2 is still an Inbox occurrence and must stay.
  assert.equal(observe(pending, { type: 'turn/end', seq: 52, data: {} }), true)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2'])
})

test('a queued echo promoted to steering survives the removal and follows the placement', () => {
  const pending = ledger()
  beginEcho(pending, 'r1', { placement: 'queued' })
  observe(pending, insertedSplice(55, 'next-turn', 0, ['r1']))
  // Queue steer = a canceled removal followed by a LATER insertion of the same
  // identity into next-step (the real Direct writer + Agent Inbox sequence).
  assert.equal(observe(pending, removedSplice(56, 'next-turn', 0, 1, 'canceled')), false,
    'the removal is not a business cancel')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'],
    'the only local representation of the still-processed message is kept')
  assert.equal(observe(pending, insertedSplice(57, 'next-step', 0, ['r1'])), true,
    'the promotion to the steering lane is a visible placement change')
  assert.equal(pending.snapshot()[0]?.placement, 'steering',
    'the echo follows the authoritative occurrence into the steering lane')
  // The occurrence is authoritative in next-step: a boundary cannot retire it.
  assert.equal(observe(pending, { type: 'turn/end', seq: 58, data: {} }), false)
  // The Host claims the steering occurrence, then fails before admission.
  assert.equal(observe(pending, removedSplice(59, 'next-step', 0, 1)), false)
  assert.equal(observe(pending, { type: 'request/context', seq: 60, data: {} }), true)
  assert.deepEqual(pending.snapshot(), [])
})

test('a same-mutation replacement of the same rpcId keeps the echo pending', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(60, 'next-turn', 0, ['r1']))
  // `Inbox.replace()` removes and reinserts in ONE canceled-marked splice.
  assert.equal(observe(pending, {
    type: 'agent/inbox/spliced',
    seq: 61,
    data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [userMessage('r1')], outcome: 'canceled' },
  }), false, 'the replacement keeps the request alive')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
  // The rebound receipt still points at the occurrence: a later turn boundary
  // must not retire it while the occurrence is present.
  assert.equal(observe(pending, { type: 'turn/end', seq: 62, data: { turn: 1, reason: { kind: 'error' } } }), false)
  // A real claim of the replacement at its new index retires it after the
  // strictly later boundary.
  assert.equal(observe(pending, removedSplice(63, 'next-turn', 0, 1)), false)
  assert.equal(observe(pending, { type: 'turn/end', seq: 64, data: { turn: 2, reason: { kind: 'error' } } }), true)
  assert.deepEqual(pending.snapshot(), [])
})

test('a requeue after a claim rebinds the receipt and keeps the echo pending', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(70, 'next-turn', 0, ['r1']))
  // The Host claims the occurrence (removal without a discard marker)...
  observe(pending, removedSplice(71, 'next-turn', 0, 1))
  // ...then requeues the SAME identity in a LATER mutation.
  assert.equal(observe(pending, insertedSplice(72, 'next-turn', 0, ['r1'])), false)
  assert.equal(observe(pending, { type: 'turn/end', seq: 73, data: {} }), false,
    'the requeued occurrence is pending again: a boundary cannot retire it')
  assert.equal(observe(pending, removedSplice(74, 'next-turn', 0, 1)), false)
  assert.equal(observe(pending, { type: 'request/context', seq: 75, data: {} }), true)
  assert.deepEqual(pending.snapshot(), [])
})

test('a durable admission retires by identity and a later boundary never double-settles', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r2')
  observe(pending, insertedSplice(80, 'next-turn', 0, ['r1']))
  pending.observeDurable('r1')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2'])
  assert.equal(observe(pending, { type: 'turn/end', seq: 81, data: { turn: 1, reason: { kind: 'completed' } } }), false,
    'the durable echo is already gone; the boundary cannot touch the sibling')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2'])
})

test('a same-text different rpcId echo is never correlated', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r2')
  observe(pending, insertedSplice(90, 'next-turn', 0, ['r1']))
  observe(pending, removedSplice(91, 'next-turn', 0, 1))
  assert.equal(observe(pending, { type: 'turn/end', seq: 92, data: { turn: 1, reason: { kind: 'error' } } }), true)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2'],
    'identity is the rpcId, never the display text')
})

test('old session and generation events cannot mutate the current ledger', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(100, 'next-turn', 0, ['r1']))
  observe(pending, removedSplice(101, 'next-turn', 0, 1))
  assert.equal(observe(pending, { type: 'turn/end', seq: 102, data: {} }, { generation: GENERATION - 1 }), false,
    'an older ownership generation is fenced')
  assert.equal(observe(pending, { type: 'turn/end', seq: 102, data: {} }, { sessionId: 'other-session' }), false,
    'a different session identity is fenced')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
  assert.equal(observe(pending, { type: 'turn/end', seq: 102, data: {} }), true)
})

test('a same-id begin after admission does not inherit the previous receipt', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(110, 'next-turn', 0, ['r1']))
  observe(pending, removedSplice(111, 'next-turn', 0, 1))
  // A NEW submission reuses the id: its receipt starts unknown.
  beginEcho(pending, 'r1')
  assert.equal(observe(pending, { type: 'turn/end', seq: 112, data: {} }), false,
    'a fresh begin has no receipt yet: a boundary cannot retire it')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
})

test('a canceled removal never retires siblings or receipt-less echoes', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r2')
  beginEcho(pending, 'r3')
  observe(pending, insertedSplice(120, 'next-turn', 0, ['r1', 'r2']))
  assert.equal(observe(pending, removedSplice(121, 'next-turn', 0, 1, 'canceled')), false)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1', 'r2', 'r3'],
    'the canceled splice retires nothing')
  // The removed r1 is claimed; a later boundary retires only it.
  assert.equal(observe(pending, { type: 'turn/end', seq: 122, data: {} }), true)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2', 'r3'],
    'only the claimed identity retires; in-Inbox and receipt-less echoes remain')
})

test('a stale duplicate splice never rolls a receipt back', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  observe(pending, insertedSplice(130, 'next-turn', 0, ['r1']))
  observe(pending, removedSplice(131, 'next-turn', 0, 1))
  // A replayed OLDER insertion must not resurrect an index that the claim
  // already cleared.
  assert.equal(observe(pending, insertedSplice(130, 'next-turn', 0, ['r1'])), false)
  assert.equal(observe(pending, { type: 'turn/end', seq: 132, data: {} }), true,
    'the claim watermark survives the stale replay')
})

// ── PR2: hidden registration → Host acceptance publishes ───────────────────
// The official Client's `beginSubmission` echo enters `pendingSubmissions`
// only once the Host accepted the prompt. The Direct ledger mirrors that
// shape: `begin` REGISTERS (so synchronously-emitted Inbox events can still
// record receipts — Trap A), `accept` publishes exactly once, and the live
// editor draft carries pre-acceptance presentation instead.

test('PR2: a hidden begin stays invisible; accept publishes exactly once', () => {
  const pending = ledger()
  pending.begin({ requestId: 'r1', placement: 'transcript', text: 'A', createdAt: 1, sessionId: SESSION, generation: GENERATION, hidden: true })
  assert.deepEqual(pending.snapshot(), [], 'a registered-but-unaccepted record is NOT visible')
  assert.equal(pending.accept('r1'), true)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
  assert.equal(pending.accept('r1'), false, 'accept is exactly-once per record')
})

test('PR2: pre-acceptance receipts still fold; the record stays hidden', () => {
  const pending = ledger()
  beginEcho(pending, 'r1', { hidden: true })
  // The synchronous Direct Inbox splice arrives BEFORE the writer returns:
  // the receipt is recorded while the echo remains invisible.
  assert.equal(observe(pending, insertedSplice(10, 'next-turn', 0, ['r1'])), false)
  assert.deepEqual(pending.snapshot(), [])
  pending.accept('r1')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'],
    'the acceptance publishes the record whose receipt was already tracked')
})

test('PR2: a retired record is not resurrected by a late accept', () => {
  const pending = ledger()
  beginEcho(pending, 'r1', { hidden: true })
  observe(pending, insertedSplice(10, 'next-turn', 0, ['r1']))
  observe(pending, removedSplice(11, 'next-turn', 0, 1))
  // A durable admission removed the record already.
  pending.observeDurable('r1')
  assert.equal(pending.accept('r1'), false)
  assert.deepEqual(pending.snapshot(), [])
})

test('PR2: a claim boundary retiring an invisible record is not a visible change', () => {
  const pending = ledger()
  beginEcho(pending, 'r1', { hidden: true })
  beginEcho(pending, 'r2')
  observe(pending, insertedSplice(20, 'next-turn', 0, ['r1', 'r2']))
  observe(pending, removedSplice(21, 'next-turn', 0, 1))
  assert.equal(observe(pending, { type: 'turn/end', seq: 22, data: {} }), false,
    'the retired record was never visible: the visible set did not change')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r2'])
})

test('PR2: a same-id re-begin after acceptance starts invisible again', () => {
  const pending = ledger()
  beginEcho(pending, 'r1')
  beginEcho(pending, 'r1', { hidden: true })
  assert.deepEqual(pending.snapshot(), [], 'the replacement record is a NEW invisible registration')
  pending.accept('r1')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['r1'])
})
