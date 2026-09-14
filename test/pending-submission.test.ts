/**
 * Pure contract tests for the client-local pending-submission ledger
 * (D2.1 follow-up): identity-keyed echoes that bridge the editor-cleared →
 * authoritative-occurrence gap. Correlation is by request id only — never by
 * text.
 * @module @xmoon76/dsh-pi-tui/pending-submission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingSubmissions, pendingSubmissionsNotReplaced } from '../src/pending-submission.ts'

function ledger(): PendingSubmissions {
  return new PendingSubmissions()
}

test('begin records transcript/queued/steering echoes in insertion order', () => {
  const pending = ledger()
  pending.begin({ requestId: 'r1', placement: 'transcript', text: 'idle', createdAt: 1, sessionId: 's', generation: 3 })
  pending.begin({ requestId: 'r2', placement: 'queued', text: 'queued', createdAt: 2, sessionId: 's', generation: 3 })
  pending.begin({ requestId: 'r3', placement: 'steering', text: 'steer', createdAt: 3, sessionId: 's', generation: 3 })
  assert.deepEqual(pending.snapshot().map(echo => [echo.requestId, echo.placement]), [
    ['r1', 'transcript'],
    ['r2', 'queued'],
    ['r3', 'steering'],
  ])
})

test('two same-text submissions stay distinct by request id', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'same', createdAt: 1 })
  pending.begin({ requestId: 'b', placement: 'steering', text: 'same', createdAt: 2 })
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['a', 'b'])
})

test('an authoritative rpc id suppresses only the matching echo (identity, never text)', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'same', createdAt: 1 })
  pending.begin({ requestId: 'b', placement: 'steering', text: 'same', createdAt: 2 })
  const visible = pendingSubmissionsNotReplaced(pending.snapshot(), new Set(['a']))
  assert.deepEqual(visible.map(echo => echo.requestId), ['b'])
})

test('an echo re-appears when its authoritative counterpart is no longer visible', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'A', createdAt: 1 })
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
  pending.begin({ requestId: 'b', placement: 'transcript', text: 'same', createdAt: 2 })
  pending.observeDurable('a')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['b'])
})

test('settle removes a failed/cancelled/indeterminate echo', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'queued', text: 'A', createdAt: 1 })
  pending.settle('a')
  pending.settle('a')
  assert.deepEqual(pending.snapshot(), [])
})

test('a late settlement of one identity never clears a newer unrelated echo', () => {
  const pending = ledger()
  pending.begin({ requestId: 'old', placement: 'queued', text: 'old', createdAt: 1 })
  pending.begin({ requestId: 'new', placement: 'queued', text: 'new', createdAt: 2 })
  pending.settle('old')
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['new'])
})

test('clearForSubject drops echoes from another session or generation', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'queued', text: 'A', createdAt: 1, sessionId: 's1', generation: 1 })
  pending.begin({ requestId: 'b', placement: 'queued', text: 'B', createdAt: 2, sessionId: 's2', generation: 2 })
  pending.clearForSubject('s1', 1)
  assert.deepEqual(pending.snapshot().map(echo => echo.requestId), ['a'])
})

test('clear removes every echo', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'steering', text: 'A', createdAt: 1 })
  pending.begin({ requestId: 'b', placement: 'steering', text: 'B', createdAt: 2 })
  pending.clear()
  assert.deepEqual(pending.snapshot(), [])
})

test('snapshot is a detached copy: mutation never leaks into the ledger', () => {
  const pending = ledger()
  pending.begin({ requestId: 'a', placement: 'queued', text: 'A', createdAt: 1 })
  const snapshot = pending.snapshot()
  ;(snapshot[0] as { text: string }).text = 'mutated'
  assert.equal(pending.snapshot()[0]?.text, 'A')
})
