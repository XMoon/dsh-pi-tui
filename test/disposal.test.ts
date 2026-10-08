/**
 * The synchronous disposal primitive (M3-6 PR3 plan D1): attempt every step
 * in order, then surface the collected failure(s). The whole PR3 teardown
 * chain relies on this contract, so the primitive is pinned directly.
 * @module @xmoon76/dsh-pi-tui/runtime/process/disposal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { runSyncDisposalSteps } from '../src/runtime/process/disposal.ts'

test('success: every step runs exactly once in caller order', () => {
  const calls: string[] = []
  runSyncDisposalSteps('ok', [
    () => calls.push('a'),
    () => calls.push('b'),
    () => calls.push('c'),
  ])
  assert.deepEqual(calls, ['a', 'b', 'c'])
})

test('one failure: later steps still run and the EXACT value is rethrown', () => {
  const calls: string[] = []
  const thrown = { marker: 'identity' }
  assert.throws(
    () => runSyncDisposalSteps('one', [
      () => calls.push('a'),
      () => { calls.push('b'); throw thrown },
      () => calls.push('c'),
    ]),
    (error: unknown) => error === thrown,
  )
  assert.deepEqual(calls, ['a', 'b', 'c'])
})

test('multiple failures: AggregateError carries them in execution order', () => {
  const calls: string[] = []
  const first = new Error('first')
  const second = new Error('second')
  assert.throws(
    () => runSyncDisposalSteps('multi', [
      () => calls.push('a'),
      () => { calls.push('b'); throw first },
      () => calls.push('c'),
      () => { calls.push('d'); throw second },
      () => calls.push('e'),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.message, 'multi')
      assert.deepEqual(error.errors, [first, second])
      return true
    },
  )
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'e'])
})

test('non-Error thrown values are collected by identity too', () => {
  const values = ['boom', 42]
  assert.throws(
    () => runSyncDisposalSteps('values', [
      () => { throw values[0] },
      () => { throw values[1] },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, values)
      return true
    },
  )
})

test('no steps is inert', () => {
  assert.doesNotThrow(() => runSyncDisposalSteps('empty', []))
})
