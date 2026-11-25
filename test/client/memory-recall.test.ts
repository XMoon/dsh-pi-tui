/**
 * The Split/Daemon Client process recall memory — pure-semantics unit tests
 * (Feature History PR2-A).
 *
 * These exercise ONLY `src/client/history/memory-recall.ts`'s public contract:
 * no terminal, no renderer, no Session, no file and no Host. The real key-sink
 * proof (a real Remote runner's editor/TSP composer ↑ recalling an actually
 * accepted input) lives in `test/app/runner-remote-presentation.test.ts`; the
 * negative direction (a disk-only row never enters the list) is proved there
 * through the real production readers. Nothing here re-implements the store.
 * @module @xmoon76/dsh-pi-tui/memory-recall.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { INPUT_RECALL_LIMIT } from '../../src/client/history/recall-scope.ts'
import { createInputMemoryRecall } from '../../src/client/history/memory-recall.ts'

test('a fresh process memory is empty and normalizes each admitted input', () => {
  const memory = createInputMemoryRecall()
  assert.deepEqual([...memory.snapshot()], [], 'a new process starts with no recall')

  // Leading/trailing blank space is trimmed; a blank input is ignored.
  memory.remember('  A  ')
  memory.remember('A')
  assert.deepEqual([...memory.snapshot()], ['A'], 'a consecutive repeat collapses')

  // A non-consecutive repeat is legal history and survives.
  memory.remember('B')
  memory.remember('A')
  assert.deepEqual([...memory.snapshot()], ['A', 'B', 'A'], 'newest first, non-consecutive repeats kept')

  // A whitespace-only input never becomes an entry.
  memory.remember('   ')
  assert.deepEqual([...memory.snapshot()], ['A', 'B', 'A'])
})

test('the newest input is first and the shared 100-entry cap evicts only the oldest', () => {
  const memory = createInputMemoryRecall()
  for (let index = 1; index <= INPUT_RECALL_LIMIT + 1; index += 1) {
    memory.remember(`prompt ${String(index)}`)
  }
  const snapshot = memory.snapshot()
  assert.equal(snapshot.length, INPUT_RECALL_LIMIT, 'the list is bounded by the shared recall cap')
  assert.equal(snapshot[0], `prompt ${String(INPUT_RECALL_LIMIT + 1)}`, 'the newest submission is recalled first')
  assert.equal(snapshot.includes('prompt 1'), false, 'the oldest entry is evicted once over the cap')
  assert.equal(snapshot.at(-1), 'prompt 2')
})

test('snapshots are defensive and two memories never share state', () => {
  const first = createInputMemoryRecall()
  const second = createInputMemoryRecall()
  first.remember('only in first')
  assert.deepEqual([...second.snapshot()], [], 'a second Client root never inherits another list')

  const snapshot = first.snapshot() as string[]
  snapshot.push('mutated by a caller')
  snapshot[0] = 'overwritten by a caller'
  assert.deepEqual([...first.snapshot()], ['only in first'], 'the caller cannot mutate the store through a snapshot')
})
