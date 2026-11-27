/**
 * The Split/Daemon Client root recall memory — pure semantics (History PR2-C).
 *
 * These exercise ONLY `src/client/history/memory-recall.ts`'s public contract:
 * no terminal, no renderer, no file and no Host. The real key-sink proof (a
 * real Remote runner's editor/TSP composer ↑ recalling a Host-seeded or locally
 * accepted input) lives in the Remote runner/TSP suites; the private Host read
 * is proved by the Host wire suites. Nothing here re-implements the store.
 * @module @xmoon76/dsh-pi-tui/memory-recall.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { INPUT_RECALL_LIMIT } from '../../src/client/history/recall-scope.ts'
import {
  createInputMemoryRecall,
  type InputRecallScope,
} from '../../src/client/history/memory-recall.ts'

const CARRIER = { connection: { id: 'conn-1' }, binding: { id: 'binding-1' } }
const SCOPE_A: InputRecallScope = { carrier: CARRIER, sessionId: 'session-a' }
const SCOPE_B: InputRecallScope = { carrier: CARRIER, sessionId: 'session-b' }

function seeded(items: ReadonlyArray<{ messageId: string; text: string; rpcId?: string }>): ReadonlyArray<{
  messageId: string
  text: string
  rpcId?: string
}> {
  return items
}

test('a fresh process memory is empty and normalizes each locally accepted input', () => {
  const memory = createInputMemoryRecall()
  assert.deepEqual([...memory.snapshot()], [], 'a new Client root starts empty')
  memory.bindScope(SCOPE_A)

  memory.remember('  A  ')
  memory.remember('A')
  assert.deepEqual([...memory.snapshot()], ['A'], 'a consecutive repeat collapses')

  memory.remember('B')
  memory.remember('A')
  assert.deepEqual([...memory.snapshot()], ['A', 'B', 'A'], 'newest first, non-consecutive repeats kept')

  memory.remember('   ')
  assert.deepEqual([...memory.snapshot()], ['A', 'B', 'A'], 'a whitespace-only input never becomes an entry')
})

test('the scope is the exact carrier+Session; a different one clears and a same one is not a reset', () => {
  const memory = createInputMemoryRecall()
  memory.bindScope(SCOPE_A)
  memory.remember('A input')
  memory.bindScope({ ...SCOPE_A })
  assert.deepEqual([...memory.snapshot()], ['A input'], 'the same carrier+Session scope (a remount) keeps the list')

  memory.bindScope(SCOPE_B)
  assert.deepEqual([...memory.snapshot()], [], 'a different Session clears the outgoing list')

  memory.remember('B input')
  const newCarrier = { connection: { id: 'conn-2' }, binding: { id: 'binding-2' } }
  memory.bindScope({ carrier: newCarrier, sessionId: 'session-b' })
  assert.deepEqual([...memory.snapshot()], [], 'a different authenticated carrier clears even with the same Session id')
  assert.deepEqual([...memory.snapshot()], [], 'a same-id A→B→A publish is a different scope, never inferred from the value')
})

test('a Host seed follows local occurrences and keeps the Host newest-first order', () => {
  const memory = createInputMemoryRecall()
  memory.bindScope(SCOPE_A)
  memory.remember('local one')
  memory.applySeed(seeded([
    { messageId: 'host-1', text: 'host newest', rpcId: 'rpc-1' },
    { messageId: 'host-2', text: 'host older' },
  ]), 'session-a')
  assert.deepEqual([...memory.snapshot()], ['local one', 'host newest', 'host older'])
})

test('an official correlation identifies the SAME occurrence exactly once and local text wins', () => {
  const memory = createInputMemoryRecall()
  memory.bindScope(SCOPE_A)
  memory.applySeed(seeded([
    { messageId: 'host-1', text: 'Host projected text', rpcId: 'rpc-same' },
    { messageId: 'host-2', text: 'unrelated host row' },
  ]), 'session-a')
  // The local acceptance of the SAME official request replaces the Host row.
  memory.remember('  Local original text  ', 'rpc-same')
  assert.deepEqual([...memory.snapshot()], ['Local original text', 'unrelated host row'])

  // The next same-scope seed that still contains the occurrence does not
  // re-add it next to the local row.
  memory.applySeed(seeded([
    { messageId: 'host-1', text: 'Host projected text', rpcId: 'rpc-same' },
    { messageId: 'host-2', text: 'unrelated host row' },
  ]), 'session-a')
  assert.deepEqual([...memory.snapshot()], ['Local original text', 'unrelated host row'])

  // A local-only legacy occurrence has no fabricated correlation: it stays
  // local and is never matched by text.
  memory.remember('Local original text')
  memory.applySeed(seeded([
    { messageId: 'host-other', text: 'other host row' },
    { messageId: 'host-3', text: 'Local original text', rpcId: 'rpc-other' },
  ]), 'session-a')
  assert.deepEqual([...memory.snapshot()], ['Local original text', 'other host row', 'Local original text'],
    'a distinct Host row is never discarded by text: only an exact rpcId correlates')
})

test('a same-scope repeated seed replaces the seed rows instead of appending them', () => {
  const memory = createInputMemoryRecall()
  memory.bindScope(SCOPE_A)
  const first = seeded([{ messageId: 'h1', text: 'one', rpcId: 'r1' }])
  memory.applySeed(first, 'session-a')
  memory.applySeed(first, 'session-a')
  assert.deepEqual([...memory.snapshot()], ['one'], 'the previous seed is replaced, never appended twice')
})

test('a stale seed for another/previous scope never applies', () => {
  const memory = createInputMemoryRecall()
  memory.bindScope(SCOPE_A)
  memory.remember('A local')
  memory.bindScope(SCOPE_B)
  memory.applySeed(seeded([{ messageId: 'a1', text: 'stale A host row', rpcId: 'ra' }]), 'session-a')
  assert.deepEqual([...memory.snapshot()], [], 'an A response after B publication mutates nothing')
})

test('distinct repeated text survives when non-adjacent and the shared cap evicts only the oldest', () => {
  const memory = createInputMemoryRecall()
  memory.bindScope(SCOPE_A)
  memory.applySeed(seeded([
    { messageId: 'h-a', text: 'same', rpcId: 'ra' },
    { messageId: 'h-b', text: 'middle' },
    { messageId: 'h-c', text: 'same', rpcId: 'rc' },
  ]), 'session-a')
  assert.deepEqual([...memory.snapshot()], ['same', 'middle', 'same'], 'non-adjacent repeats are legal history')

  for (let index = 1; index <= INPUT_RECALL_LIMIT + 1; index += 1) {
    memory.remember(`prompt ${String(index)}`)
  }
  const snapshot = memory.snapshot()
  assert.equal(snapshot.length, INPUT_RECALL_LIMIT)
  assert.equal(snapshot[0], `prompt ${String(INPUT_RECALL_LIMIT + 1)}`)
  assert.equal(snapshot.includes('prompt 1'), false, 'the oldest entry is evicted over the cap')
})

test('snapshots are defensive and two memories never share state', () => {
  const first = createInputMemoryRecall()
  const second = createInputMemoryRecall()
  first.bindScope(SCOPE_A)
  second.bindScope(SCOPE_A)
  first.remember('only in first')
  assert.deepEqual([...second.snapshot()], [], 'a second Client root never inherits another list')

  const snapshot = first.snapshot() as string[]
  snapshot.push('mutated by a caller')
  snapshot[0] = 'overwritten by a caller'
  assert.deepEqual([...first.snapshot()], ['only in first'], 'the caller cannot mutate the store through a snapshot')
})
