/**
 * Contract tests for the D2.1 pending-input read projection: Direct inbox
 * collection names stay inside the adapter, while consumers receive official
 * placement and stable occurrence identity.
 * @module @xmoon76/dsh-pi-tui/pending-input-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectPendingInputReader } from '../src/runtime/direct/pending-input-reader-direct.ts'

test('normalizes Direct next-turn and next-step occurrences into placements', () => {
  const agent = {
    session: { id: 'session-queue' },
    status: 'running',
    inbox: {
      nextTurn: [
        { id: 'queued-a', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } },
        { id: 'queued-b', content: [{ type: 'text', text: 'B' }], source: { kind: 'plugin' } },
      ],
      nextStep: [
        { id: 'steering-c', content: [{ type: 'text', text: 'C' }], source: { kind: 'user' } },
      ],
    },
  }
  const reader = new DirectPendingInputReader(sessionId => sessionId === agent.session.id ? agent : undefined)

  assert.deepEqual(reader.snapshot('session-queue'), {
    running: true,
    items: [
      { id: 'queued-a', placement: 'queued', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } },
      { id: 'queued-b', placement: 'queued', content: [{ type: 'text', text: 'B' }], source: { kind: 'plugin' } },
      { id: 'steering-c', placement: 'steering', content: [{ type: 'text', text: 'C' }], source: { kind: 'user' } },
    ],
  })
})

test('an unavailable Direct session has no fabricated empty snapshot', () => {
  const reader = new DirectPendingInputReader(() => undefined)
  assert.equal(reader.snapshot('missing'), undefined)
})
