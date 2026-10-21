/**
 * The FAULT VERIFIER's shape arithmetic.
 *
 * The verifier is evidence, and evidence has its own failure mode: it can
 * report a comfortable number about a run that did not happen. Two of those
 * modes were real:
 *
 *   - it accepted runs from an older tree (fixed by comparing the run's
 *     commit against the reviewed base);
 *   - it accepted a run whose KNOB VALUES did not match the label, so a
 *     branch labelled "four shards" could carry `prototype-shard-total.txt =
 *     1`, fire its injection on shard 1, and still be reported as the
 *     four-shard boundary.
 *
 * This file covers the second one's arithmetic: the matrix shape the job
 * names encode must be exactly the declared shape.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/verify-faults.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { matrixShape } from '../../scripts/verify-faults.mjs'

/** A job list with the given shard legs. */
function jobsFor(total) {
  return Array.from({ length: total }, (_, index) => ({
    name: `Product shard ${index + 1}/${total} (Node 24)`,
  }))
}

test('a four-shard run reports the four legs', () => {
  assert.deepEqual(matrixShape(jobsFor(4)), { indices: [1, 2, 3, 4], totals: [4] })
})

test('a one-shard run reports one leg', () => {
  assert.deepEqual(matrixShape(jobsFor(1)), { indices: [1], totals: [1] })
})

test('a run that created FEWER legs than it claims cannot look complete', () => {
  // The defect: a branch labelled "N=4" that actually ran `1/1`. The
  // injection still fires on shard 1 and every other check passes, so only
  // the shape can tell the difference.
  const labelledFourButRanOne = jobsFor(1)
  const shape = matrixShape(labelledFourButRanOne)
  assert.notDeepEqual(shape, { indices: [1, 2, 3, 4], totals: [4] })
  assert.deepEqual(shape, { indices: [1], totals: [1] })
})

test('jobs that are not shard legs are ignored', () => {
  const jobs = [...jobsFor(2), { name: 'Aggregate the shards' }, { name: 'Build the shared artifact' }]
  assert.deepEqual(matrixShape(jobs), { indices: [1, 2], totals: [2] })
})

test('an empty job list has no shape, rather than a default one', () => {
  // A default shape would let a run whose jobs were never created report a
  // complete matrix.
  assert.deepEqual(matrixShape([]), { indices: [], totals: [] })
})

test('a MIXED total is visible instead of being averaged', () => {
  // Two different totals in one run means the matrix is not the shape
  // anybody declared.
  const shape = matrixShape([
    { name: 'Product shard 1/4 (Node 24)' },
    { name: 'Product shard 2/2 (Node 24)' },
  ])
  assert.deepEqual(shape.totals, [2, 4])
})
