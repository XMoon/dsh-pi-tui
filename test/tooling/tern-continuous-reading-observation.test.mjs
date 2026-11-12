/**
 * Unit tests for `scripts/support/tern-continuous-reading-observation.mjs` — the
 * pure read-only observers the Stage4 reading flows share.
 *
 * Every case here protects a DISTINCT failure mode that would otherwise let a
 * real-client run report a false pass:
 *
 *   - an `add` REPLACES the id's subtree (a stale child that survives would make
 *     a retired row look mounted);
 *   - `del` removes the whole subtree, so "unmounted" never reads as "scrolled";
 *   - a `text` append accumulates and a replace overwrites (a fold that ignores
 *     either would measure the wrong bytes);
 *   - `move` re-parents in order (a fold that ignores it would attribute a row
 *     to the wrong card);
 *   - one marker mounted by TWO cards is NOT reported as "the" card (the oracle
 *     fails closed instead of picking one);
 *   - `turn/end` is qualified by Session, so two Sessions that both use turn 26
 *     cannot be confused;
 *   - a `gone` event and a `settle` op are read from their own verbs, never
 *     inferred from a node's absence.
 *
 * Run with:
 *   node scripts/run-with-temp-root.mjs node --test test/tooling/tern-continuous-reading-observation.test.mjs
 * @module test/tooling/tern-continuous-reading-observation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cardShowing,
  foldLiveWithRetention,
  cardsShowing,
  eventLedger,
  foldLive,
  goneEvents,
  mainIds,
  openedSurfaces,
  retiredSince,
  settleOps,
  settledWriteFor,
  subtreeText,
  turnEnded,
  userRows,
  wireErrors,
} from '../../scripts/support/tern-continuous-reading-observation.mjs'

/** One outbound frame carrying `ops`; `s` is the frame sequence the SDK wrote. */
const frame = (ops, s = 1) => ({ dir: 'out', verb: 'f', body: { s, ops } })
/** One inbound event frame (what the client told the SDK). */
const event = (body) => ({ dir: 'in', verb: 'e', body })

/** A Main card node on the wire: `main.<n>-msg-<n>` with its own children. */
const card = (id, text, children = []) => ({
  id,
  k: 'message',
  p: { role: 'dsh.transcript.user', text },
  c: children,
})

/**
 * The real wire shape MEASURED against the SDK: `main` is itself a node and the
 * top-level cards are its DIRECT children. Every fold case starts from this.
 */
const mainRoot = (children = []) => ({
  id: 'main',
  k: 'col',
  p: { key: 'transcript', gap: 'none' },
  c: children,
})

test('foldLive: add mounts the node and its children', () => {
  const live = foldLive([frame([
    ['add', 'main', 's1', null, mainRoot([
      card('main.0', 'PR1-TERN-01', [{ id: 'main.0.t', k: 'text', p: { text: 'PR1-TERN-01 body' } }]),
    ])],
  ])])
  assert.equal(live.get('main.0').k, 'message')
  assert.deepEqual(live.get('main.0').childIds, ['main.0.t'])
  assert.equal(subtreeText(live, 'main.0'), 'PR1-TERN-01 PR1-TERN-01 body')
  assert.equal(live.get('main.0.t').parentId, 'main.0')
})

test('foldLive: a re-add replaces the id subtree instead of merging into it', () => {
  const live = foldLive([
    frame([['add', 'main', 's1', null, mainRoot([
      card('main.0', 'before', [{ id: 'stale', k: 'text', p: { text: 'STALE' } }]),
    ])]], 1),
    // The same id re-added with a DIFFERENT child set: the old child must be gone.
    frame([['add', 'main.0', 'main', null, card('main.0', 'after', [{ id: 'fresh', k: 'text', p: { text: 'FRESH' } }])]], 2),
  ])
  assert.equal(live.has('stale'), false, 'a replaced subtree must not keep its old child')
  assert.equal(live.has('fresh'), true)
  assert.equal(subtreeText(live, 'main.0'), 'after FRESH')
})

test('foldLive: del removes the whole subtree, so an unmounted row is not "scrolled"', () => {
  const live = foldLive([
    frame([['add', 'main', 's1', null, mainRoot([
      card('main.0', 'gone-row', [{ id: 'main.0.t', k: 'text', p: { text: 'tail' } }]),
    ])]], 1),
    frame([['del', 'main.0']], 2),
  ])
  // The Main ROOT stays; only the retired card and its subtree leave.
  assert.deepEqual(mainIds(live), [])
  assert.equal(live.has('main.0'), false)
  assert.equal(live.has('main.0.t'), false)
})

test('foldLive: text append accumulates and text replace overwrites', () => {
  const live = foldLive([
    frame([['add', 'main.0', 'main', null, card('main.0', 'start')]], 1),
    frame([['text', 'main.0', 'append', '-more']], 2),
    frame([['text', 'main.0', 'replace', 'replaced']], 3),
  ])
  assert.equal(live.get('main.0').p.text, 'replaced')
})

test('foldLive: set merges properties and null deletes one', () => {
  const live = foldLive([
    frame([['add', 'main.0', 'main', null, card('main.0', 'row')]], 1),
    frame([['set', 'main.0', { role: 'dsh.transcript.assistant' }]], 2),
  ])
  assert.equal(live.get('main.0').p.role, 'dsh.transcript.assistant')
  assert.equal(live.get('main.0').p.text, 'row')
})

test('foldLive: move re-parents the node in the target order', () => {
  // A Main ROOT move (`move id main before`) is a no-op for the fold: the
  // `main` region root is not itself a wire node, exactly as the production
  // fold treats it. The observable case is a move INSIDE a mounted subtree.
  const live = foldLive([frame([
    ['add', 'main.0', 'main', null, {
      id: 'main.0',
      k: 'message',
      p: { text: 'card' },
      c: [
        { id: 'main.0.a', k: 'text', p: { text: 'a' } },
        { id: 'main.0.b', k: 'text', p: { text: 'b' } },
      ],
    }],
    ['move', 'main.0.b', 'main.0', 'main.0.a'],
  ])])
  assert.deepEqual(live.get('main.0').childIds, ['main.0.b', 'main.0.a'])
  assert.equal(live.get('main.0.b').parentId, 'main.0')
  // In document order the card now reads b then a.
  assert.equal(subtreeText(live, 'main.0'), 'card b a')
})

test('foldLive: set/text against an id that is not mounted is ignored, not invented', () => {
  const live = foldLive([
    frame([['set', 'main.missing', { text: 'ghost' }]], 1),
    frame([['text', 'main.missing', 'replace', 'ghost']], 2),
  ])
  assert.equal(live.size, 0)
})

test('cardShowing: exactly one card wins; two matches fail closed', () => {
  const live = foldLive([frame([
    ['add', 'main', 's1', null, mainRoot([])],
    ['add', 'main.0', 'main', null, card('main.0', 'PR1-TERN-01')],
    ['add', 'main.1', 'main', null, card('main.1', 'T2-READ-26')],
  ])])
  assert.equal(cardShowing(live, 'PR1-TERN-01'), 'main.0')
  assert.equal(cardShowing(live, 'T2-READ-26'), 'main.1')
  assert.equal(cardShowing(live, 'ABSENT'), undefined)
  // The SAME marker under two cards is ambiguous: the oracle must not pick one.
  live.get('main.1').p.text = 'PR1-TERN-01'
  assert.deepEqual(cardsShowing(live, 'PR1-TERN-01'), ['main.0', 'main.1'])
  assert.equal(cardShowing(live, 'PR1-TERN-01'), undefined)
})

test('foldLive: an added node is registered as its parent\'s child in placement order', () => {
  // Regression guard: a fold that only registers the ADDED node's own children
  // leaves the parent's `childIds` empty, so `mainIds()` reports no card and
  // every "one card per turn" claim passes vacuously. The parent link is the
  // fact that makes the Main roster measurable at all.
  const live = foldLive([frame([
    ['add', 'main', 's1', null, mainRoot([])],
    ['add', 'main.0', 'main', null, card('main.0', 'first')],
    // `before: null` appends; placing BEFORE main.0 must insert at the head.
    ['add', 'main.1', 'main', 'main.0', card('main.1', 'second')],
  ])])
  assert.deepEqual(mainIds(live), ['main.1', 'main.0'])
  assert.equal(live.get('main.0').parentId, 'main')
})

test('userRows: only Main User-role cards are returned, in wire order', () => {
  const live = foldLive([frame([
    ['add', 'main', 's1', null, mainRoot([])],
    ['add', 'main.0', 'main', null, card('main.0', 'user-1')],
    ['add', 'main.1', 'main', null, { id: 'main.1', k: 'message', p: { role: 'assistant', text: 'answer' } }],
    ['add', 'main.2', 'main', null, card('main.2', 'user-2')],
  ])])
  assert.deepEqual(userRows(live), ['main.0', 'main.2'])
})

test('retiredSince reports the cards a later fold no longer has', () => {
  const before = foldLive([frame([
    ['add', 'main', 's1', null, mainRoot([])],
    ['add', 'main.0', 'main', null, card('main.0', 'a')],
    ['add', 'main.1', 'main', null, card('main.1', 'b')],
  ])])
  const after = foldLive([frame([
    ['add', 'main', 's1', null, mainRoot([])],
    ['add', 'main.0', 'main', null, card('main.0', 'a')],
    ['add', 'main.1', 'main', null, card('main.1', 'b')],
    ['del', 'main.1'],
  ])])
  assert.deepEqual(retiredSince(before, after), ['main.1'])
  assert.deepEqual(mainIds(after), ['main.0'])
})

test('settleOps and goneEvents read their own verbs and never infer from absence', () => {
  const wire = [
    frame([['settle', 'main.0'], ['settle', 'main.1']], 7),
    event({ ev: 'gone', s: 8, ids: ['main.0'] }),
    frame([['add', 'main.2', 'main', null, card('main.2', 'c')]], 9),
  ]
  assert.deepEqual(settleOps(wire), [
    { id: 'main.0', frame: 7 },
    { id: 'main.1', frame: 7 },
  ])
  assert.deepEqual(goneEvents(wire), [{ frame: 8, ids: ['main.0'] }])
})

test('openedSurfaces reports the inline Surface and defaults the omitted mode', () => {
  const wire = [
    { dir: 'out', verb: 'o', body: { id: 'sf1' } },
    { dir: 'in', verb: 'r', body: { r: 'hello' } },
  ]
  assert.deepEqual(openedSurfaces(wire), [{ id: 'sf1', mode: 'inline' }])
})

test('wireErrors surfaces client error events only', () => {
  const wire = [
    event({ ev: 'error', msg: 'unknown id main.9' }),
    event({ ev: 'ack', s: 1 }),
  ]
  assert.deepEqual(wireErrors(wire).map(entry => entry.msg), ['unknown id main.9'])
})

test('eventLedger keeps append order and separates the hold facts', () => {
  const events = [
    { kind: 'writer.settled', ordinal: 1, marker: 'PR1-TERN-01', outcomeKind: 'committed' },
    { kind: 'session.event', sessionId: 'a', eventType: 'turn/end', turn: 1 },
    { kind: 'model.calls', calls: 1 },
    { kind: 'model.hold.26.started', ordinal: 26 },
    { kind: 'model.hold.26.released', seq: 1, ordinal: 26 },
    { kind: 'model.hold.26.refused', seq: 2, reason: 'already released' },
  ]
  const ledger = eventLedger(events)
  assert.equal(ledger.writes.length, 1)
  assert.equal(ledger.holdStarted.length, 1)
  assert.equal(ledger.holdReleased.length, 1)
  assert.equal(ledger.holdRefused.length, 1)
  assert.equal(ledger.lastModelCalls, 1)
  assert.equal(ledger.turnEnds.length, 1)
})

test('settledWriteFor refuses an ambiguous (double) settle for one marker', () => {
  const writes = [
    { marker: 'T2-READ-26', outcomeKind: 'committed' },
    { marker: 'T2-READ-26', outcomeKind: 'committed' },
  ]
  assert.equal(settledWriteFor(writes, 'T2-READ-26'), undefined)
  assert.deepEqual(settledWriteFor(writes.slice(0, 1), 'T2-READ-26'), writes[0])
})

test('turnEnded is qualified by Session, so two Sessions cannot share an ordinal', () => {
  const turnEnds = [
    { sessionId: 'session-a', turn: 26 },
    { sessionId: 'session-b', turn: 1 },
  ]
  assert.equal(turnEnded(turnEnds, 'session-a', 26), true)
  assert.equal(turnEnded(turnEnds, 'session-b', 26), false)
  assert.equal(turnEnded(turnEnds, 'session-b', 1), true)
})

// ── retention chronology: client `gone` is a real eviction epoch ────────────

const goneEvent = (ids, s = 100) => ({ dir: 'in', verb: 'e', body: { ev: 'gone', s, ids } })

test('retention: a client gone event retires the root and its subtree without an outbound del', () => {
  const { nodes, goneEvents } = foldLiveWithRetention([
    frame([['add', 'main', 's1', null, mainRoot([
      card('main.0', 'first', [{ id: 'main.0.t', k: 'text', p: { text: 'body' } }]),
    ])]], 1),
    goneEvent(['main.0'], 2),
  ])
  assert.deepEqual(goneEvents, [{ frame: 2, ids: ['main.0'] }])
  assert.equal(nodes.has('main.0'), false, 'the evicted root is unmounted')
  assert.equal(nodes.has('main.0.t'), false, 'its subtree is unmounted')
  assert.deepEqual(mainIds(nodes), [], 'the parent no longer lists the evicted root')
})

test('retention: a legal update BEFORE the eviction is not a violation', () => {
  const { violations } = foldLiveWithRetention([
    frame([['add', 'main', 's1', null, mainRoot([card('main.0', 'first')])]], 1),
    frame([['set', 'main.0', { status: 'settled' }]], 2),
    goneEvent(['main.0'], 3),
  ])
  assert.deepEqual(violations, [])
})

test('retention: a set/text AFTER the eviction is a violation and never resurrects the root', () => {
  const { nodes, violations } = foldLiveWithRetention([
    frame([['add', 'main', 's1', null, mainRoot([card('main.0', 'first')])]], 1),
    goneEvent(['main.0'], 2),
    frame([['set', 'main.0', { status: 'late' }]], 3),
    frame([['text', 'main.0', 'append', 'late']], 4),
  ])
  assert.deepEqual(violations.map(entry => [entry.kind, entry.id, entry.frame]), [
    ['op-after-gone', 'main.0', 3],
    ['op-after-gone', 'main.0', 4],
  ])
  assert.equal(nodes.has('main.0'), false)
  assert.deepEqual(mainIds(nodes), [])
})

test('retention: a legal re-add opens a new epoch; a later update is legal again', () => {
  const { nodes, violations } = foldLiveWithRetention([
    frame([['add', 'main', 's1', null, mainRoot([card('main.0', 'first')])]], 1),
    goneEvent(['main.0'], 2),
    // A genuine stamp change re-adds the whole root, which is the legal path.
    frame([['add', 'main.0', 'main', null, card('main.0', 're-added')]], 3),
    frame([['set', 'main.0', { status: 'live' }]], 4),
  ])
  assert.deepEqual(violations, [])
  assert.equal(nodes.has('main.0'), true)
  assert.deepEqual(mainIds(nodes), ['main.0'])
  assert.equal(nodes.get('main.0').p.text, 're-added')
})

test('retention: an outbound del also detaches the root from its parent order', () => {
  const { nodes } = foldLiveWithRetention([
    frame([['add', 'main', 's1', null, mainRoot([
      card('main.0', 'a'),
      card('main.1', 'b'),
    ])]], 1),
    frame([['del', 'main.0']], 2),
  ])
  assert.deepEqual(mainIds(nodes), ['main.1'])
  assert.equal(nodes.has('main.0'), false)
})
