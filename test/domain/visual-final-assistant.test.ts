/**
 * The shared final-Assistant qualification used by Focus and by the visual
 * Assistant-body projection.
 *
 * The fixtures are real `TranscriptFolder` folds so the private step identity
 * and the authoritative `lastAssistantVisible` fence are exercised exactly as
 * production supplies them; the assertion only reads the shared predicate.
 * @module @xmoon76/dsh-pi-tui/domain/visual-final-assistant.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/transcript.ts'
import { eligibleFinalAssistant } from '../../src/domain/transcript/final-assistant.ts'
import type { AssistantLiveChunk } from '../../src/runtime/assistant-stream-port.ts'

function event(type: string, data: Record<string, unknown>, seq: number, time = 1_700_000_000_000 + seq): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function assistantMessage(
  turn: number,
  step: number,
  text: string,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return event('assistant/message', {
    turn,
    step,
    message: {
      id: MessageId(`msg-${turn}-${step}`),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    ...extra,
  }, 10 + step)
}

function finalOf(folder: TranscriptFolder, turn = 0) {
  const group = folder.messages().filter(message => 'turn' in message && message.turn === turn)
  return eligibleFinalAssistant(folder.turnActivity(turn), group)
}

function completedFolder(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return folder
}

test('a completed turn selects the assistant owning its structural latest step', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'older answer'),
    assistantMessage(0, 1, 'final answer'),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
  ])
  const final = finalOf(folder)
  assert.equal(final?.message.text, 'final answer')
  assert.equal(final?.truncated, false)
})

test('a max-tokens turn returns the same final with the truncated flag', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'cut off'),
    event('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 20),
  ])
  const final = finalOf(folder)
  assert.equal(final?.message.text, 'cut off')
  assert.equal(final?.truncated, true)
})

for (const reason of ['aborted', 'interrupted', 'error', 'blocked', 'cancelled']) {
  test(`a ${reason} turn never yields a final assistant`, () => {
    const folder = completedFolder([
      event('turn/start', { turn: 0 }, 0),
      assistantMessage(0, 0, 'prefix only'),
      event('turn/end', { turn: 0, reason: { kind: reason } }, 20),
    ])
    assert.equal(finalOf(folder), undefined)
  })
}

test('an empty latest step suppresses the final and never falls back to an older non-empty step', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'older non-empty answer'),
    assistantMessage(0, 1, ''),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
  ])
  assert.equal(finalOf(folder), undefined)
})

test('an interrupted latest assistant is process evidence, never the final', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'interrupted prefix', { interrupted: true }),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
  ])
  assert.equal(finalOf(folder), undefined)
})

test('a late assistant for an older step never steals the structural latest-step owner', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('step/end', { turn: 0, step: 0 }, 2),
    event('step/start', { turn: 0, step: 1 }, 3),
    assistantMessage(0, 1, 'latest answer'),
    event('step/end', { turn: 0, step: 1 }, 5),
    // A durable replay of the older step lands AFTER the newer message.
    assistantMessage(0, 0, 'late older answer'),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
  ])
  const final = finalOf(folder)
  assert.equal(final?.message.text, 'latest answer')
})

test('a turn whose final row is outside the supplied window yields no final', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'answer'),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
  ])
  assert.equal(eligibleFinalAssistant(folder.turnActivity(0), []), undefined)
})

test('a still-running turn yields no final even when an assistant row is present', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'streaming candidate'),
  ])
  assert.equal(finalOf(folder), undefined)
})

test('an open opaque latest assistant is not renderable and yields no final', () => {
  const folder = new TranscriptFolder()
  folder.apply([event('turn/start', { turn: 0 }, 0)])
  const chunk: AssistantLiveChunk = { type: 'block-start', index: 0, blockType: 'future-final' } as never
  folder.applyLiveInput({ kind: 'chunk', sessionId: 'test', attemptId: 'attempt-1', turn: 0, step: 0, time: 1, chunk })
  folder.apply([event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20)])
  const final = finalOf(folder)
  assert.equal(final, undefined)
})

test('a deliverables-only final is renderable even when the text body is empty', () => {
  // The durable declarations event requires the official 1-based turn.
  const folder = completedFolder([
    event('turn/start', { turn: 1 }, 0),
    event('deliverables/presented', { turn: 1, callId: 'present-1', files: [{ path: 'out/report.md', description: 'Report' }] }, 1),
    assistantMessage(1, 0, ''),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20),
  ])
  const final = finalOf(folder, 1)
  assert.equal(final?.message.kind, 'assistant')
  assert.deepEqual(final?.message.deliverables?.map(file => file.path), ['out/report.md'])
})

test('a steer does not move final ownership back to the committed pre-steer answer', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('user-1'),
      role: 'user',
      content: [{ type: 'text', text: 'start' }],
      source: { kind: 'user' },
    }, 1),
    assistantMessage(0, 0, 'pre-steer answer'),
    event('user/message', {
      id: MessageId('user-2'),
      role: 'user',
      content: [{ type: 'text', text: 'steer' }],
      source: { kind: 'user' },
    }, 12),
    assistantMessage(0, 1, 'post-steer answer'),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
  ])
  const final = finalOf(folder)
  assert.equal(final?.message.text, 'post-steer answer')
})

test('a turn group from another turn never supplies this turn final', () => {
  const folder = completedFolder([
    event('turn/start', { turn: 0 }, 0),
    assistantMessage(0, 0, 'turn zero answer'),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 20),
    event('turn/start', { turn: 1 }, 21),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 22),
  ])
  const group = folder.messages().filter(message => message.kind === 'assistant' && message.turn === 0)
  assert.equal(eligibleFinalAssistant(folder.turnActivity(1), group), undefined)
})
