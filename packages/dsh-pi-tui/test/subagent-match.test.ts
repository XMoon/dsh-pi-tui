/**
 * Regression tests for the task browser's safe subagent fallback. The jobs
 * registry exposes no child session id, so the browser must point users at
 * /subagents instead of matching a transcript by label/order/time.
 * @module @xmoon76/dsh-pi-tui/subagent-match.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { subagentJobTranscriptId, subagentJobViewHint } from '../src/index.ts'

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
