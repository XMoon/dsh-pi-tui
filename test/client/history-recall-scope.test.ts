/**
 * The input-recall SCOPE kernel — pure-semantics unit tests.
 *
 * These exercise ONLY `src/client/history/recall-scope.ts`'s public contract:
 * no terminal, no renderer, no Session and no history file. The point is the
 * rare boundaries of that contract — the sessionless-pool adoption, the
 * settlement/append watermark, the run-bounded occurrences and the linear
 * reconcile — because the PiTui adapter and the TSP adapter now share this ONE
 * implementation and neither may re-derive it.
 *
 * The PiTui-visible half of the same rules (the editor ↑/↓ stack, the mirror,
 * the real submit entries) stays covered by `test/client/tui-app.test.ts`; the
 * renderer wiring by `test/tui/tern-tsp-submission.test.ts` and
 * `test/app/tern-tsp-live-mount.test.ts`. Nothing here re-implements the merge:
 * every expectation is the OUTCOME the public API must produce.
 * @module @xmoon76/dsh-pi-tui/history-recall-scope.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistoryRecallScope, INPUT_RECALL_LIMIT } from '../../src/client/history/recall-scope.ts'

/** Settle one occurrence the kernel handed back, in append order. */
function settleToken(
  scope: ReturnType<typeof createHistoryRecallScope>,
  token: number | undefined,
  owner: string | undefined,
  outcome: 'written' | 'skipped',
  text: string,
): void {
  scope.settle({
    ...(token === undefined ? {} : { token }),
    owner,
    outcome,
    text,
  })
}

test('a boot reset with no owner seeds the cwd recall and leaves the sessionless pool open', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['cwd-new', 'cwd-old'])
  assert.deepEqual(scope.snapshot(), ['cwd-new', 'cwd-old'],
    'the boot seed is the newest-first cwd recall')
  // Boot is NOT a published Session: the pool stays open, so an accepted input
  // still gets an occurrence token.
  const token = scope.rememberAccepted('first prompt')
  assert.equal(typeof token, 'number', 'the sessionless pool is an OPEN scope that tokens input')
  assert.deepEqual(scope.snapshot(), ['first prompt', 'cwd-new', 'cwd-old'])
})

test('the first published owner adopts the pool occurrence and closes on its own reseed', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['cwd-old'])
  const poolToken = scope.rememberAccepted('pool prompt')
  assert.equal(typeof poolToken, 'number')

  scope.begin('B')
  // The outgoing cwd recall never survives into the published owner, while the
  // pool's own unsettled occurrence is adopted (its row lands behind the
  // transition, so the snapshot cannot carry it yet).
  assert.deepEqual(scope.snapshot(), ['pool prompt'],
    'the boot cwd seed is gone and the adopted pool occurrence stays')

  scope.reset([], 'B')
  assert.deepEqual(scope.snapshot(), ['pool prompt'],
    "B's empty hydration snapshot must not drop the accepted pool input")
  assert.equal(scope.rememberAccepted('after close'), undefined,
    'the owner whose hydration committed the reseed closed the scope')
})

test('a pool occurrence settled under another identity stays out of the new owner, written or skipped', () => {
  // A row already written under `undefined` belongs to no Session; a SKIP under
  // `undefined` is equally foreign (cross-Session visibility follows the
  // SETTLEMENT's identity, not whether a row happened to exist).
  for (const outcome of ['written', 'skipped'] as const) {
    const scope = createHistoryRecallScope()
    scope.reset(['cwd-old'])
    const foreignToken = scope.rememberAccepted('/help')
    settleToken(scope, foreignToken, undefined, outcome, '/help')

    scope.begin('B')
    assert.deepEqual(scope.snapshot(), [],
      `a pool occurrence settled as ${outcome} under \`undefined\` never enters B`)

    const bToken = scope.rememberAccepted('b prompt')
    assert.equal(typeof bToken, 'number')
    assert.deepEqual(scope.snapshot(), ['b prompt'],
      `B's own accepted input is unaffected by the ${outcome} exclusion`)
  }
})

test('a replaced owner drops its pending occurrences, its settlements and its projection', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['a row'], 'A')
  scope.begin('B')
  const bToken = scope.rememberAccepted('b pending')
  settleToken(scope, bToken, 'B', 'written', 'b pending')
  assert.deepEqual(scope.snapshot(), ['b pending'])

  // C publishes before B's hydration ever committed.
  scope.begin('C')
  assert.deepEqual(scope.snapshot(), [],
    "B's accepted occurrence and its settlement never cross into C")

  scope.reset(['c row'], 'C')
  assert.deepEqual(scope.snapshot(), ['c row'], 'C carries only its own snapshot')

  // The symmetric A→B→A shape: the outgoing B scope leaves nothing behind.
  scope.begin('B')
  assert.deepEqual(scope.snapshot(), [], 'a re-published owner starts from its own rows only')
  scope.reset(['a row'], 'A')
  assert.deepEqual(scope.snapshot(), ['a row'])
})

test('skipped, written and unsettled occurrences interleave in append order, not by outcome', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  const a = scope.rememberAccepted('a')
  settleToken(scope, a, 'B', 'skipped', 'a')
  const b = scope.rememberAccepted('b')
  settleToken(scope, b, 'B', 'written', 'b')
  scope.rememberAccepted('c')          // still unsettled at the reseed

  scope.reset(['b'], 'B')
  assert.deepEqual(scope.snapshot(), ['c', 'b', 'a'],
    'the skipped occurrence sits at its settlement rank, never hoisted ahead of every row')
})

test('two identical texts are told apart by their tokens around a tokenless writer', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  const firstA = scope.rememberAccepted('a')
  settleToken(scope, firstA, 'B', 'skipped', 'a')
  const b = scope.rememberAccepted('b')
  settleToken(scope, b, 'B', 'written', 'b')
  const secondA = scope.rememberAccepted('a')
  settleToken(scope, secondA, 'B', 'written', 'a')
  // A steer is a real session-history writer with NO occurrence token.
  scope.settle({ owner: 'B', outcome: 'written', text: 'z' })

  scope.reset(['z', 'a', 'b'], 'B')
  assert.deepEqual(scope.snapshot(), ['z', 'a', 'b', 'a'],
    'each occurrence keeps its own rank: the first a stays skipped, the later a owns the appended row')
})

test('a long run of identical pending input costs bounded state and never evicts an older occurrence', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  const b = scope.rememberAccepted('b')
  const tokens: number[] = []
  for (let index = 0; index < 1000; index += 1) tokens.push(scope.rememberAccepted('a')!)

  assert.deepEqual(scope.snapshot(), ['a', 'b'],
    'the projection collapses adjacent duplicates to one row')

  // Settle EVERY token, including the ones a run superseded: only the live
  // occurrences may hold a durable fact.
  settleToken(scope, b, 'B', 'skipped', 'b')
  for (const token of tokens) settleToken(scope, token, 'B', 'skipped', 'a')
  assert.ok(scope.scopeFactCountForTest() <= 3,
    `a 1000-long run must not keep 1000 facts: ${scope.scopeFactCountForTest()}`)

  scope.reset(['b'], 'B')
  assert.ok(scope.snapshot().includes('b'),
    'the older distinct occurrence survives a thousand duplicates')
})

test('the per-owner append watermark outlives the bounded settlement queue', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  const early = scope.rememberAccepted('early')
  settleToken(scope, early, 'B', 'skipped', 'early')   // appendsBefore = 0
  // 150 tokenless appends: the queue keeps the newest 100, the watermark all 150.
  for (let index = 0; index < 150; index += 1) {
    scope.settle({ owner: 'B', outcome: 'written', text: `row${index}` })
  }
  const entries = Array.from({ length: 60 }, (_, index) => `row${59 - index}`)

  scope.reset(entries, 'B')
  assert.equal(scope.snapshot().length, 61, 'the evicted skip still contributes one row')
  assert.equal(scope.snapshot()[0], 'row59', 'the newest disk row is recalled first')
  assert.equal(scope.snapshot()[60], 'early',
    'the queue-evicted skip stays BEHIND the covered window it settled before')
  assert.ok(scope.scopeFactCountForTest() <= INPUT_RECALL_LIMIT,
    `the durable facts stay bounded: ${scope.scopeFactCountForTest()}`)
})

test('a settlement of an occurrence the scope cap dropped neither resurrects it nor duplicates a row', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  const tokens: number[] = []
  for (let index = 0; index < 130; index += 1) tokens.push(scope.rememberAccepted(`p${index}`)!)
  // Every occurrence settles as a write; the oldest 30 are already gone.
  for (const [index, token] of tokens.entries()) {
    settleToken(scope, token, 'B', 'written', `p${index}`)
  }
  const entries = Array.from({ length: 130 }, (_, index) => `p${129 - index}`)

  scope.reset(entries, 'B')
  const recalled = scope.snapshot()
  assert.equal(recalled.length, INPUT_RECALL_LIMIT, 'the recall window stays capped at 100')
  assert.equal(new Set(recalled).size, recalled.length,
    'no synthetic row is inserted for an occurrence the scope no longer holds')
  assert.equal(recalled.includes('p0'), false, 'a token the scope cap evicted never comes back')
  assert.ok(scope.scopeFactCountForTest() <= INPUT_RECALL_LIMIT,
    `the facts are bounded by the LIVE occurrences: ${scope.scopeFactCountForTest()}`)
})

test('seed appends and keeps non-consecutive repeats without opening or closing a scope', () => {
  const boot = createHistoryRecallScope()
  boot.reset(['a', 'b', 'a'])
  assert.deepEqual(boot.snapshot(), ['a', 'b', 'a'],
    'a non-consecutive repeat is legal history and survives')

  const seeded = createHistoryRecallScope()
  seeded.reset(['older'])
  seeded.seed(['a', 'a', 'b', 'a'])
  assert.deepEqual(seeded.snapshot(), ['older', 'a', 'b', 'a'],
    'seed appends at the OLDEST end and collapses only adjacent duplicates')

  const open = createHistoryRecallScope()
  open.seed(['a', 'b', 'a'])
  assert.equal(typeof open.rememberAccepted('still open'), 'number',
    'a seed neither opens nor closes a scope')

  const capped = createHistoryRecallScope()
  capped.reset(Array.from({ length: 150 }, (_, index) => `r${index}`))
  assert.deepEqual(capped.snapshot(), Array.from({ length: 100 }, (_, index) => `r${index}`),
    'the cap keeps the newest 100 in the newest-first order')
})

test('the recall reconcile visits a linear number of positions in the scope and the window', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  for (let index = 1; index <= 100; index += 1) scope.rememberAccepted(`pending ${index}`)
  const rows: string[] = []
  for (let index = 1; index <= 100; index += 1) {
    const text = `written ${index}`
    rows.push(text)
    scope.settle({ owner: 'B', outcome: 'written', text })
  }

  scope.reset([...rows].reverse(), 'B')
  assert.equal(scope.snapshot().length, INPUT_RECALL_LIMIT, 'the seed caps the recall at 100 entries')
  assert.equal(scope.snapshot()[0], 'pending 100', 'the newest occurrence is recalled first')
  assert.ok(scope.reconcileStepsForTest() <= 4 * (INPUT_RECALL_LIMIT + INPUT_RECALL_LIMIT),
    `the reconcile must stay linear: ${scope.reconcileStepsForTest()} positions visited`)
})

test('an evicted SKIP that settled after an evicted WRITE stays newer than that row', () => {
  // The boundary is the settlement's own append count, not "behind the window":
  // the covered window also carries rows whose WRITE the queue evicted.
  const scope = createHistoryRecallScope()
  scope.reset(['anchor'], 'A')
  scope.begin('B')
  const w = scope.rememberAccepted('w')
  const s = scope.rememberAccepted('s')
  settleToken(scope, w, 'B', 'written', 'w')     // w's row is appended first
  settleToken(scope, s, 'B', 'skipped', 's')     // s settles AFTER that append
  for (let index = 0; index < 100; index += 1) {
    scope.settle({ owner: 'B', outcome: 'skipped', text: 'x' })
  }

  scope.reset(['w'], 'B')
  assert.deepEqual(scope.snapshot(), ['s', 'w'],
    'the later skip is newer than the evicted write row it settled after')
})

test('a blank input is refused an occurrence and never enters the projection', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['cwd'])
  assert.equal(scope.rememberAccepted('   '), undefined,
    'blank input is not a submission, even with an OPEN scope')
  assert.deepEqual(scope.snapshot(), ['cwd'], 'blank input adds no recall row')
})

test('the snapshot is a defensive copy: a caller cannot mutate the projection', () => {
  const scope = createHistoryRecallScope()
  scope.reset(['a', 'b'])
  const first = scope.snapshot() as string[]
  first.push('injected')
  first[0] = 'clobbered'
  assert.deepEqual(scope.snapshot(), ['a', 'b'], 'the kernel owns its snapshot, not the caller')
})
