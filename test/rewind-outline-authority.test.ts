/**
 * L2/L3 boundary tests for the whole-log rewind picker authority
 * (M3-4 PR4 Step 4 / plan §4/§18.4):
 *
 * - Direct / projection present → the projection is THE outline (the
 *   full-snapshot compatibility fold must not run);
 * - Direct / projection unavailable (service or key absent) → the exact
 *   attachment's full-snapshot compatibility fold;
 * - Direct / projection present but `[]` → authoritative empty, NEVER the
 *   fallback;
 * - Direct / projection read THROWS → unknown (`undefined`), never masked
 *   by the fallback;
 * - Remote adapter → official projection ONLY (structural source has no
 *   snapshot path at all);
 * - the shared row builder excludes the first outline entry (no
 *   predecessor boundary) on every branch.
 *
 * @module @xmoon76/dsh-pi-tui/rewind-outline-authority.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { directTurnOutlineCompat, rewindOutlineRows } from '../src/rewind.ts'
import { DirectSessionReader } from '../src/runtime/direct/session-direct.ts'

function event<K extends string>(type: K, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function turnSpan(startSeq: number, turn: number, prompt: string, length = 6): SessionEvent[] {
  return [
    event('turn/start', { turn }, startSeq),
    event('step/start', { turn, step: 0 }, startSeq + 1),
    event('user/message', {
      id: MessageId(`u-${turn}`),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    } as never, startSeq + 2),
    event('assistant/message', {
      turn, step: 0,
      message: { id: MessageId(`a-${turn}`), role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    } as never, startSeq + 3),
    event('step/end', { turn, step: 0 }, startSeq + 4),
    event('turn/end', { turn, reason: { kind: 'completed' } }, startSeq + 5),
  ]
}

/** A minimal structural projection service double. */
function projectionsService(snapshot: (session: unknown, keys?: readonly string[]) => { values?: Record<string, unknown> } | undefined) {
  return { snapshot }
}

/** The minimal live-resolver + agent faces DirectSessionReader consumes. */
function readerWith(options: {
  readonly events: readonly SessionEvent[]
  readonly projections?: unknown
}) {
  const agent = {
    session: {
      snapshotEvents: () => [...options.events],
    },
  }
  return new DirectSessionReader(
    { get: (name: string) => (name === 'sessionProjections' ? options.projections : undefined) } as never,
    { agentOf: () => agent } as never,
  )
}

test('Direct / projection present: the projection IS the outline (no snapshot fold)', () => {
  const events = [...turnSpan(0, 0, 'first'), ...turnSpan(6, 1, 'second')]
  // The projection reports entries whose prompts DIFFER from any fold of
  // the raw events — if the adapter folded the snapshot instead, the read
  // would disagree.
  const projectionEntries = [
    { turn: 0, seq: 0, prompt: 'PROJECTION-FIRST', response: 'r0' },
    { turn: 1, seq: 6, prompt: 'PROJECTION-SECOND', response: 'r1' },
  ]
  const reader = readerWith({
    events,
    projections: projectionsService((_session, keys) => {
      assert.deepEqual(keys, ['turnOutline'], 'the adapter reads exactly the turnOutline key')
      return { values: { turnOutline: projectionEntries } }
    }),
  })
  const outline = reader.turnOutline('s')
  assert.deepEqual(outline, projectionEntries, 'the projection value wins verbatim')
})

test('Direct / projection service absent: the exact attachment compat fold', () => {
  const events = [...turnSpan(0, 0, 'first'), ...turnSpan(6, 1, 'second prompt that is long enough to clip when previewing this text here')]
  const reader = readerWith({ events, projections: undefined })
  const outline = reader.turnOutline('s')
  assert.ok(outline !== undefined)
  assert.deepEqual(outline.map(entry => entry.turn), [0, 1], 'every started turn is an entry')
  assert.deepEqual(outline.map(entry => entry.seq), [0, 6], 'the turn/start seq is the loadThrough target')
  assert.equal(outline[0]!.prompt, 'first')
  assert.ok(outline[1]!.prompt.startsWith('second prompt'), `bounded preview of the human message (got "${outline[1]!.prompt.slice(0, 20)}…")`)
})

test('Direct / projection key absent (undefined value): the compat fold still applies', () => {
  const events = [...turnSpan(0, 0, 'only turn')]
  const reader = readerWith({
    events,
    projections: projectionsService(() => ({ values: {} })),
  })
  const outline = reader.turnOutline('s')
  assert.ok(outline !== undefined, 'an absent KEY (no unit mounted) reads through the compat fold')
  assert.equal(outline.length, 1)
  assert.equal(outline[0]!.prompt, 'only turn')
})

test('Direct / projection present but []: authoritative empty, NEVER the fallback', () => {
  const events = [...turnSpan(0, 0, 'first'), ...turnSpan(6, 1, 'second')]
  const reader = readerWith({
    events,
    projections: projectionsService(() => ({ values: { turnOutline: [] } })),
  })
  const outline = reader.turnOutline('s')
  assert.deepEqual(outline, [], 'an authoritative empty projection is final — no fold-over-snapshot may resurrect rows')
})

test('Direct / projection read THROWS: unknown (undefined), never masked by the fallback', () => {
  const events = [...turnSpan(0, 0, 'first')]
  const reader = readerWith({
    events,
    projections: projectionsService(() => { throw new Error('projection exploded') }),
  })
  assert.equal(reader.turnOutline('s'), undefined, 'a projection failure surfaces as unknown — the compat fold must not hide it')
})

test('Remote structural lock: the Remote adapter has NO snapshot/full-log read path', () => {
  const source = readFileSync(new URL('../src/runtime/remote/session-reader-remote.ts', import.meta.url), 'utf8')
  const turnOutlineBody = source.slice(
    source.indexOf('turnOutline(sessionId: string)'),
    source.indexOf('sessionStatus(sessionId: string)'),
  )
  assert.ok(turnOutlineBody.includes('faceOf(\'turnOutline\')'),
    'the Remote outline read is the official projection face only')
  assert.equal(turnOutlineBody.includes('snapshotEvents'), false,
    'the Remote outline never reads a full session snapshot')
  assert.equal(turnOutlineBody.includes('directTurnOutlineCompat'), false,
    'the Remote outline has no compatibility fold import')
})

test('shared row builder: the first outline entry is excluded on every branch (no predecessor boundary)', () => {
  const rows = rewindOutlineRows([
    { turn: 0, seq: 0, prompt: 'first', response: 'r' },
    { turn: 1, seq: 6, prompt: 'second', response: 'r' },
    { turn: 2, seq: 12, prompt: 'third', response: 'r' },
  ])
  assert.deepEqual(rows.map(row => row.value), ['12', '6'], 'newest-first, first entry excluded')
  assert.match(rows[0]!.label, /turn 2 · third/)
})

test('compat fold: a non-advancing turn/start is ignored (official monotone invariant)', () => {
  const events = [
    ...turnSpan(0, 0, 'real first'),
    event('turn/start', { turn: 0 }, 6),
    event('user/message', {
      id: MessageId('dup'), role: 'user', content: [{ type: 'text', text: 'dup turn' }], source: { kind: 'user' },
    } as never, 7),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 8),
  ]
  const outline = directTurnOutlineCompat(events)
  assert.deepEqual(outline.map(entry => entry.turn), [0], 'a replayed turn number collapses to one entry')
  assert.equal(outline[0]!.prompt, 'real first', 'the first non-empty human prompt keeps its preview')
})
