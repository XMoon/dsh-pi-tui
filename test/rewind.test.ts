/** Contract tests for Host-owned rewind anchors and local navigation identity. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { collectRewindCandidates, isHumanTurnMessage, rewindPickerItem } from '../src/rewind.ts'
import { isRewindIdentityCurrent } from '../src/session-fork.ts'

function event<K extends string>(type: K, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function turnStart(seq: number, turn: number): SessionEvent {
  return event('turn/start', { turn }, seq)
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return event('turn/end', { turn, reason: { kind: 'completed' } }, seq)
}

function userMessage(seq: number, text: string, source: Record<string, unknown> = { kind: 'user' }): SessionEvent<'user/message'> {
  return event('user/message', {
    id: MessageId(`msg-${seq}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, seq) as SessionEvent<'user/message'>
}

function imageMessage(seq: number): SessionEvent<'user/message'> {
  const image: ContentBlock = {
    type: 'image',
    attachment: { attachmentId: `att-${seq}`, mediaType: 'image/png', bytes: 10, width: 10, height: 10 },
  } as ContentBlock
  return event('user/message', {
    id: MessageId(`msg-${seq}`),
    role: 'user',
    content: [image],
    source: { kind: 'user' },
  }, seq) as SessionEvent<'user/message'>
}

test('first human turn is not rewindable because omitted Host anchor means latest boundary', () => {
  const candidates = collectRewindCandidates([
    turnStart(0, 1),
    userMessage(1, 'first'),
    turnEnd(2, 1),
  ])
  assert.deepEqual(candidates, [])
})

test('each later human turn carries its predecessor turn/end sequence', () => {
  const candidates = collectRewindCandidates([
    turnStart(0, 1), userMessage(1, 'A'), turnEnd(2, 1),
    turnStart(3, 2), userMessage(4, 'B'), turnEnd(5, 2),
    turnStart(6, 3), userMessage(7, 'C'), turnEnd(8, 3),
  ])
  assert.deepEqual(candidates.map(candidate => ({ turn: candidate.turn, forkAtSeq: candidate.forkAtSeq })), [
    { turn: 3, forkAtSeq: 5 },
    { turn: 2, forkAtSeq: 2 },
  ])
  assert.equal(candidates[0]?.editorText, 'C')
  assert.equal(rewindPickerItem(candidates[0]!).value, '6')
})

test('a non-human completed turn can become a predecessor without rendering a row', () => {
  const events = [
    turnStart(0, 1),
    userMessage(1, 'injected', { kind: 'plugin', plugin: 'system' }),
    turnEnd(2, 1),
    turnStart(3, 2),
    userMessage(4, 'human'),
    turnEnd(5, 2),
  ]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.turn, 2)
  assert.equal(candidates[0]?.forkAtSeq, 2)
})

test('dangling and malformed turn spans fail soft', () => {
  const candidates = collectRewindCandidates([
    turnStart(0, 1), userMessage(1, 'open'),
    turnStart(2, 2), userMessage(3, 'also open'),
  ])
  assert.deepEqual(candidates, [])
})

test('a turn/end with the wrong turn id never becomes a rewind boundary', () => {
  const candidates = collectRewindCandidates([
    turnStart(0, 1), userMessage(1, 'first'), turnEnd(2, 1),
    turnStart(3, 2), userMessage(4, 'malformed'), turnEnd(5, 99),
    turnStart(6, 3), userMessage(7, 'valid'), turnEnd(8, 3),
  ])
  assert.deepEqual(candidates.map(candidate => ({ turn: candidate.turn, forkAtSeq: candidate.forkAtSeq })), [
    { turn: 3, forkAtSeq: 2 },
  ])
})

test('non-text prompts remain selectable but are not silently restaged', () => {
  const candidates = collectRewindCandidates([
    turnStart(0, 1), userMessage(1, 'first'), turnEnd(2, 1),
    turnStart(3, 2), imageMessage(4), turnEnd(5, 2),
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.hasNonTextContent, true)
  assert.equal(candidates[0]?.editorText, '')
  assert.match(rewindPickerItem(candidates[0]!).label, /attachment/)
})

test('human-source predicate excludes injected user messages', () => {
  assert.equal(isHumanTurnMessage(userMessage(1, 'human')), true)
  assert.equal(isHumanTurnMessage(userMessage(2, 'plugin', { kind: 'plugin' })), false)
})

test('rewind identity includes navigation epoch as a separate supersession axis', () => {
  const expected = { sessionId: 'session-a', generation: 4, navigationEpoch: 8 }
  assert.equal(isRewindIdentityCurrent(expected, { ...expected }), true)
  assert.equal(isRewindIdentityCurrent(expected, { ...expected, generation: 5 }), false)
  assert.equal(isRewindIdentityCurrent(expected, { ...expected, navigationEpoch: 9 }), false)
  assert.equal(isRewindIdentityCurrent(expected, { sessionId: undefined, generation: 4, navigationEpoch: 8 }), false)
})
