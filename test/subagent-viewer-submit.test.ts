/**
 * Runner-level tests for the interactive subagent viewer's follow-up
 * delivery seam (subagent-viewer-submit.ts, plan §17): validation, the
 * exact-live-parent check, the `ctx.subagents.followup` call, and error
 * classification — with pure dependency injection, no TUI surface.
 * @module @xmoon76/dsh-pi-tui/subagent-viewer-submit.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifySubagentFollowupError,
  resolveSubagentSettleTarget,
  submitSubagentFollowup,
  type SubagentFollowupService,
  type SubagentParentLike,
  type SubagentSettleViewerState,
  type SubagentViewerSubmitDeps,
} from '../src/subagent-viewer-submit.ts'

const request = {
  parentSessionId: 'session-parent',
  childSessionId: 'session-child',
  text: 'focus on cancellation races',
}

function parent(id = 'session-parent'): SubagentParentLike {
  return { session: { id } }
}

function deps(overrides: Partial<SubagentViewerSubmitDeps> = {}): SubagentViewerSubmitDeps {
  return {
    currentParent: () => parent(),
    subagents: () => undefined,
    makeSignal: () => new AbortController().signal,
    makeSource: () => ({ kind: 'user' }),
    ...overrides,
  }
}

function service(calls: Array<{ parent: SubagentParentLike; childId: string; content: readonly { type: 'text'; text: string }[] }>): SubagentFollowupService {
  return {
    followup: async (followParent, childId, content) => {
      calls.push({ parent: followParent, childId, content })
      return `inbox-${childId}-1`
    },
  }
}

test('delivers through the continuation runtime with the EXACT live parent and the child id', async () => {
  const calls: Array<{ parent: SubagentParentLike; childId: string; content: readonly { type: 'text'; text: string }[] }> = []
  const live = parent()
  const outcome = await submitSubagentFollowup(request, deps({
    currentParent: () => live,
    subagents: () => service(calls),
    makeSource: () => ({ kind: 'user' }),
  }))
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind === 'ok') assert.equal(outcome.messageId, 'inbox-session-child-1')
  assert.equal(calls.length, 1, 'followup called exactly once')
  assert.equal(calls[0]!.parent, live, 'the exact live parent agent object authorizes the delivery')
  assert.equal(calls[0]!.childId, 'session-child')
  assert.deepEqual(calls[0]!.content, [{ type: 'text', text: request.text }])
})

test('rejects when there is no live parent at send time', async () => {
  const calls: unknown[] = []
  const outcome = await submitSubagentFollowup(request, deps({
    currentParent: () => undefined,
    subagents: () => ({ followup: async () => { calls.push('must not be called'); return 'x' } }),
  }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'parent-unavailable' } })
  assert.equal(calls.length, 0)
})

test('rejects when the live parent session is NOT the viewer target (session switched while sending)', async () => {
  const outcome = await submitSubagentFollowup(request, deps({
    currentParent: () => parent('session-other'),
    subagents: () => ({ followup: async () => 'x' }),
  }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'parent-unavailable' } })
})

test('rejects when the continuation runtime is unavailable', async () => {
  const outcome = await submitSubagentFollowup(request, deps({ subagents: () => undefined }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unavailable' } })
})

test('classifies the DSH typed rejections into the stable reason set', async () => {
  const cases: Array<[string, unknown]> = [
    ['UNAUTHORIZED', makeError('UNAUTHORIZED')],
    ['PARENT_UNAVAILABLE', makeError('PARENT_UNAVAILABLE')],
    ['NOT_RESUMABLE', makeError('NOT_RESUMABLE')],
    ['DRAINING', makeError('DRAINING')],
    ['ACTIVATION_CLOSING', makeError('ACTIVATION_CLOSING')],
    ['DUPLICATE_CHILD', makeError('DUPLICATE_CHILD')],
  ]
  const expectations: Record<string, string> = {
    UNAUTHORIZED: 'unauthorized',
    PARENT_UNAVAILABLE: 'parent-unavailable',
    NOT_RESUMABLE: 'stale-child',
    DRAINING: 'unavailable',
    ACTIVATION_CLOSING: 'unavailable',
    DUPLICATE_CHILD: 'error',
  }
  for (const [code, error] of cases) {
    const reason = classifySubagentFollowupError(error)
    assert.equal(reason.kind, expectations[code], `code ${code}`)
  }
})

test('classifies cancellation before inbox acceptance as cancelled (message never owned by the child)', async () => {
  const reason = classifySubagentFollowupError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  assert.deepEqual(reason, { kind: 'cancelled' })
})

test('a followup that REJECTS surfaces the classified reason (never a throw)', async () => {
  const outcome = await submitSubagentFollowup(request, deps({
    subagents: () => ({
      followup: async () => { throw Object.assign(new Error('subagent "c" is not a live continuable subagent'), { code: 'NOT_RESUMABLE' }) },
    }),
  }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'stale-child' } })
})

test('an unexpected throw surfaces as a safe error reason with a message', async () => {
  const outcome = await submitSubagentFollowup(request, deps({
    subagents: () => ({
      followup: async () => { throw new Error('boom') },
    }),
  }))
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') {
    assert.equal(outcome.reason.kind, 'error')
    if (outcome.reason.kind === 'error') assert.equal(outcome.reason.message, 'boom')
  }
})

function makeError(code: string): Error {
  return Object.assign(new Error(`subagent error: ${code}`), { code })
}

// ── settle target resolution (plan §12: the current/stale split) ──────────

const settleView = (overrides: Partial<SubagentSettleViewerState> = {}): SubagentSettleViewerState => ({
  viewingChildId: 'session-child',
  viewingLabel: 'research',
  viewingParentSessionId: 'session-parent',
  viewerGenerationAtSend: 3,
  viewerGenerationNow: 3,
  liveParentSessionId: 'session-parent',
  ...overrides,
})

test('a settle is CURRENT only while the SAME viewer session is unchanged', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView()),
    { kind: 'current', label: 'research' })
})

test('a close → REOPEN of the SAME child is STALE (the generation moved)', () => {
  // The exact round-2 scenario: the viewer was closed and reopened for the
  // same child id while the send was in flight — the new viewer session
  // must not be touched by the old send's settle.
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewerGenerationNow: 5,
  })), { kind: 'stale' })
})

test('a child switch is STALE even when the new child is the same id via another parent', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewingChildId: 'session-other',
  })), { kind: 'stale' })
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewingParentSessionId: 'session-other-parent',
  })), { kind: 'stale' })
})

test('a parent session switch at settle time is STALE', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    liveParentSessionId: 'session-other',
  })), { kind: 'stale' })
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    liveParentSessionId: undefined,
  })), { kind: 'stale' })
})

test('a closed viewer (no viewing child) is STALE', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewingChildId: undefined,
    viewingLabel: undefined,
    viewingParentSessionId: undefined,
  })), { kind: 'stale' })
})
