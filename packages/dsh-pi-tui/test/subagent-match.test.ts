/**
 * Regression tests for the task browser's safe subagent fallback. The jobs
 * registry exposes no child session id, so the browser must point users at
 * /subagents instead of matching a transcript by label/order/time.
 * @module @xmoon76/dsh-pi-tui/subagent-match.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchPendingSubagentCall,
  subagentJobTranscriptId,
  subagentJobViewHint,
} from '../src/index.ts'

test('label and timing cannot stand in for a stable child session id', () => {
  assert.equal(subagentJobTranscriptId({
    id: 'subagent-1',
    label: 'research',
    startedAt: 1_000_000,
  }), undefined)
  assert.equal(subagentJobTranscriptId({
    id: 'subagent-1',
    label: 'research',
    startedAt: 1_000_000,
    childSessionId: '',
  }), undefined)
})

test('an explicit child session id is the only accepted transcript target', () => {
  assert.equal(subagentJobTranscriptId({ childSessionId: 'child-stable-id' }), 'child-stable-id')
})

test('the subagent status fallback points at the identity-owning browser', () => {
  const hint = subagentJobViewHint('completed', 'exit code: 0')
  assert.ok(hint.includes('status: completed'), `status line missing:\n${hint}`)
  assert.ok(hint.includes('/subagents'), `the hint must direct to /subagents:\n${hint}`)
  assert.ok(hint.includes('does not carry the child session id'), `stable-id explanation missing:\n${hint}`)
  assert.ok(hint.includes('same-label foreground'), `the unsafe label fallback must stay documented:\n${hint}`)
})

test('running subagent fallback explains that the transcript remains available', () => {
  const hint = subagentJobViewHint('running', undefined)
  assert.ok(hint.includes('running in the background'), `running state missing:\n${hint}`)
  assert.ok(hint.includes('/subagents'), `transcript route missing:\n${hint}`)
})

test('an exact label matches the most recent pending call and removes it', () => {
  const pending = [
    { callId: 'c1', description: 'review a' },
    { callId: 'c2', description: 'review b' },
    { callId: 'c3', description: 'review a' },
  ]
  const matched = matchPendingSubagentCall(pending, 'review a')
  assert.equal(matched?.callId, 'c3', 'duplicate labels must take the most recent call')
  assert.deepEqual(pending, [
    { callId: 'c1', description: 'review a' },
    { callId: 'c2', description: 'review b' },
  ], 'the matched call must be removed')
})

test('an empty or absent label falls back to a lone pending call only', () => {
  const lone = [{ callId: 'c1', description: 'review' }]
  assert.equal(matchPendingSubagentCall(lone, undefined)?.callId, 'c1')
  assert.deepEqual(lone, [], 'the lone call is consumed')

  const empty = [{ callId: 'c1', description: 'review' }]
  assert.equal(matchPendingSubagentCall(empty, '')?.callId, 'c1')
  assert.deepEqual(empty, [], 'the lone call is consumed')
})

test('an unmatched label with multiple pending calls disables the auto-pop', () => {
  const pending = [
    { callId: 'c1', description: 'review a' },
    { callId: 'c2', description: 'review b' },
  ]
  const matched = matchPendingSubagentCall(pending, 'review c')
  assert.equal(matched, undefined, 'no match must not guess')
  assert.equal(pending.length, 2, 'nothing is consumed on a failed match')
})

test('an absent label with multiple pending calls does not guess', () => {
  const pending = [
    { callId: 'c1', description: 'review a' },
    { callId: 'c2', description: 'review b' },
  ]
  assert.equal(matchPendingSubagentCall(pending, undefined), undefined)
  assert.equal(pending.length, 2, 'nothing is consumed without a label')
})
