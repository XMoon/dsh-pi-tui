/**
 * Headless tests for the queue-pane notice filter (index.ts): background-
 * subagent settlement notices (continuable `subagent-settled` messages and
 * tool-jobs one-shot subagent completions) are dropped from the queue
 * mirror, and only FAILED settlements classify as failures for the transient
 * error notify. These pins cover the pure classification; the mirror wiring
 * (refreshQueue) reads the same predicates.
 * @module @xmoon76/dsh-pi-tui/queue-notices.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { foldQueueRows, isPlainExitPrompt, isSubagentSettlementNotice, isUserQueueInput, subagentNoticeIsFailure, type QueueNoticeSource } from '../src/index.ts'

const notice = (source: QueueNoticeSource): QueueNoticeSource => source

test('isSubagentSettlementNotice matches both dsh producers, nothing else', () => {
  // Continuable children: the continuation manager's settlement notice.
  assert.ok(isSubagentSettlementNotice(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x failed before it finished.',
  })))
  // One-shot background subagent jobs: a tool-jobs completion notice whose
  // summary starts with the job kind.
  assert.ok(isSubagentSettlementNotice(notice({
    form: 'notice',
    kind: 'plugin',
    summary: 'subagent build-index [status: failed, boom]',
  })))
  // Plan-mode toasts, bash-job completions, and plain rows stay in the pane.
  assert.ok(!isSubagentSettlementNotice(notice({ form: 'notice', kind: 'plugin', summary: 'plan mode active' })), 'plan-mode toast must stay')
  assert.ok(!isSubagentSettlementNotice(notice({ form: 'notice', kind: 'plugin', summary: 'bash release-build [status: completed]' })), 'bash job must stay')
  assert.ok(!isSubagentSettlementNotice(notice({ form: 'notice', kind: 'coordinator' })), 'non-plugin notice must stay')
  assert.ok(!isSubagentSettlementNotice(undefined), 'plain row must stay')
  assert.ok(!isSubagentSettlementNotice(notice({})), 'source without form must stay')
  // A plugin notice about a SUBAGENT but not a completion (no status line)
  // is still matched on the summary prefix — the kind is the signal.
  assert.ok(isSubagentSettlementNotice(notice({ form: 'notice', kind: 'plugin', summary: 'subagent something' })))
})

test('subagentNoticeIsFailure classifies on the producers\' own wording', () => {
  // subagent-settled: only the "finished and" wording is success.
  assert.ok(!subagentNoticeIsFailure(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x finished and will do no further work unless you send it more.',
  })))
  assert.ok(subagentNoticeIsFailure(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x failed before it finished.',
  })))
  assert.ok(subagentNoticeIsFailure(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x was stopped before it finished.',
  })))
  assert.ok(subagentNoticeIsFailure(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x ran out of room before it finished.',
  })))
  assert.ok(subagentNoticeIsFailure(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x declined the task.',
  })))
  assert.ok(subagentNoticeIsFailure(notice({
    form: 'notice',
    kind: 'subagent-settled',
    summary: 'Background subagent session-x ended abnormally (boom) before it finished.',
  })))
  // tool-jobs subagent: the terminal status line decides (failed/killed).
  assert.ok(subagentNoticeIsFailure(notice({ form: 'notice', kind: 'plugin', summary: 'subagent build [status: failed, exploded]' })))
  assert.ok(subagentNoticeIsFailure(notice({ form: 'notice', kind: 'plugin', summary: 'subagent build [status: killed]' })))
  assert.ok(!subagentNoticeIsFailure(notice({ form: 'notice', kind: 'plugin', summary: 'subagent build [status: completed]' })))
  // Unclassifiable or non-subagent rows are silent.
  assert.ok(!subagentNoticeIsFailure(notice({ form: 'notice', kind: 'plugin', summary: 'bash build [status: failed]' })), 'bash failure is not a subagent failure')
  assert.ok(!subagentNoticeIsFailure(undefined))
})
/** One minimal inbox message for foldQueueRows tests. */
function msg(id: string, source: QueueNoticeSource | undefined, text = 'hello'): { id: string; content: { type: 'text'; text: string }[]; source: QueueNoticeSource | undefined } {
  return { id, content: [{ type: 'text', text }], source }
}

test('foldQueueRows drops settlement notices, reports each failure once, keeps user rows', () => {
  const notified = new Set<string>()
  const batch = [
    msg('u1', undefined),
    msg('s1', { form: 'notice', kind: 'subagent-settled', summary: 'Background subagent x failed before it finished.' }),
    msg('s2', { form: 'notice', kind: 'plugin', summary: 'subagent build [status: failed]' }),
    msg('s3', { form: 'notice', kind: 'plugin', summary: 'subagent build [status: completed]' }),
    msg('b1', { form: 'notice', kind: 'plugin', summary: 'bash build [status: completed]' }),
    msg('n1', { form: 'notice', kind: 'plugin', summary: 'plan mode active' }),
  ]
  const first = foldQueueRows(batch, 'followup', notified)
  assert.deepEqual(first.rows.map(row => row.id), ['u1', 'b1', 'n1'], 'settlement notices must be dropped; bash/plan notices stay')
  assert.deepEqual([...first.failures], [
    'Background subagent x failed before it finished.',
    'subagent build [status: failed]',
  ], 'both failures must notify')
  // A second fold with the same guard must not re-report (once-notify).
  const second = foldQueueRows(batch, 'followup', notified)
  assert.deepEqual(second.failures, [], 'notified failures must not repeat')
  // A fresh guard (session switch) reports again.
  const fresh = foldQueueRows(batch, 'followup', new Set<string>())
  assert.equal(fresh.failures.length, 2, 'a fresh guard re-notifies')
  // next-step rows keep their own mode.
  const step = foldQueueRows([msg('u2', undefined)], 'steer', new Set<string>())
  assert.equal(step.rows[0]?.mode, 'steer')
})

test('foldQueueRows keeps plugin-notice marking on surviving rows', () => {
  const result = foldQueueRows(
    [msg('b1', { form: 'notice', kind: 'plugin', summary: 'bash build [status: completed]' })],
    'followup',
    new Set<string>(),
  )
  assert.equal(result.rows[0]?.notice, true, 'bash notices stay marked as notices')
})

test('foldQueueRows marks every non-user-origin message as a notice, only user rows steer', () => {
  const batch = [
    msg('u1', { kind: 'user' }, 'my queued message'),
    msg('u2', undefined),
    // A child's active report: delivered as a relay, never a user input.
    msg('r1', { kind: 'subagent-report', form: 'relay', senderSessionId: 'child-1' }),
    // Injected skill/agent instructions.
    msg('i1', { kind: 'agent-instructions', form: 'instructions' }),
    // Goal messages ride the inbox too.
    msg('g1', { kind: 'goal' }),
  ]
  const result = foldQueueRows(batch, 'followup', new Set<string>())
  assert.deepEqual(result.rows.map(row => row.id), ['u1', 'u2', 'r1', 'i1', 'g1'], 'all five survive the fold')
  assert.deepEqual(result.rows.map(row => row.notice), [false, false, true, true, true],
    'only user-origin rows are steerable; relay/instructions/goal are notices')
})

test('isUserQueueInput: only user-origin (or sourceless) rows are user input', () => {
  assert.ok(isUserQueueInput(undefined), 'a sourceless plain row is user input')
  assert.ok(isUserQueueInput({ kind: 'user' }), 'user origin is user input')
  assert.ok(!isUserQueueInput({ kind: 'subagent-report', form: 'relay' }), 'a relay is not user input')
  assert.ok(!isUserQueueInput({ kind: 'agent-instructions', form: 'instructions' }), 'instructions are not user input')
  assert.ok(!isUserQueueInput({ kind: 'goal' }), 'goal messages are not user input')
  assert.ok(!isUserQueueInput({ kind: 'plugin', form: 'notice', summary: 'bash build [status: completed]' }), 'plugin notices are not user input')
  assert.ok(!isUserQueueInput({ kind: 'subagent-settled', form: 'notice' }), 'settlement notices are not user input')
})

test('foldQueueRows returns an empty pane once the agent claims the inbox (acceptance anchor)', () => {
  // The runner's refreshQueue re-folds the live inbox on every
  // agent/inbox/spliced event; a claim splices the batch out (removedCount),
  // so the next fold sees an empty batch and the pane clears. This pins the
  // user acceptance: once the main agent has received the pending notices,
  // they disappear from the queue pane.
  const notified = new Set<string>()
  const pending = [
    msg('r1', { kind: 'subagent-report', form: 'relay', senderSessionId: 'child-1' }),
    msg('b1', { form: 'notice', kind: 'plugin', summary: 'bash build [status: completed]' }),
    msg('u1', { kind: 'user' }),
  ]
  const before = foldQueueRows(pending, 'steer', notified)
  assert.equal(before.rows.length, 3, 'the pending batch renders')
  // Claimed: the inbox no longer holds the messages.
  const after = foldQueueRows([], 'steer', notified)
  assert.deepEqual(after.rows, [], 'a claimed inbox folds to an empty pane')
  assert.deepEqual(after.failures, [], 'no failures on an empty batch')
})

test('Alt+Up dequeue pulls back only user-origin rows (relay/instructions/goal stay)', () => {
  // The runner's onDequeue filters the inbox with isUserQueueInput — the
  // SAME predicate as the pane classification. This pins the round-1 review
  // repro: an injected relay/instruction/goal message must never land in
  // the editor draft as editable user text.
  const inbox = [
    msg('u1', { kind: 'user' }, 'my queued message'),
    msg('r1', { kind: 'subagent-report', form: 'relay', senderSessionId: 'child-1' }),
    msg('i1', { kind: 'agent-instructions', form: 'instructions' }),
    msg('g1', { kind: 'goal' }),
  ]
  const pulled = inbox.filter(message => isUserQueueInput(message.source))
  assert.deepEqual(pulled.map(message => message.id), ['u1'], 'only the user row is pulled back')
})

test('isPlainExitPrompt matches only the exact trimmed lowercase word', () => {
  assert.ok(isPlainExitPrompt('exit'))
  assert.ok(isPlainExitPrompt('  exit  '))
  assert.ok(!isPlainExitPrompt('exit!'), 'punctuation must not match')
  assert.ok(!isPlainExitPrompt('Exit'), 'case must not match')
  assert.ok(!isPlainExitPrompt('exit now'), 'extra words must not match')
  assert.ok(!isPlainExitPrompt('/exit'), 'the command form is separate')
  assert.ok(!isPlainExitPrompt(''), 'empty must not match')
})

test('foldQueueRows shows image blocks in the queue row (review finding 5)', () => {
  const imageBlock = {
    type: 'image',
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 800, height: 600, name: 'shot.png' },
  }
  const mixed = {
    id: 'm1',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'analyze this' },
      imageBlock,
    ],
  }
  const imageOnly = {
    id: 'm2',
    source: { kind: 'user' },
    content: [imageBlock],
  }
  const result = foldQueueRows([mixed as never, imageOnly as never], 'steer', new Set())
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0]!.text, 'analyze this 🖼️ shot.png', 'mixed row advertises its image')
  assert.equal(result.rows[1]!.text, '🖼️ shot.png', 'image-only row is never empty')
})
