/**
 * Unit tests for the transcript folding: session events → renderable
 * messages, with streaming chunk accumulation and tool call pairing.
 * Pure functions, no dsh tree needed.
 * @module @dsh-pi-tui/tui-app/transcript.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTranscript, renderTranscript, type TranscriptMessage } from '../src/transcript.ts'

/** Build a minimal event envelope for tests. */
function event<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** The message list shape expected by assertions. */
function kinds(messages: readonly TranscriptMessage[]): string[] {
  return messages.map(message => message.kind)
}

test('folds a user message into a You message', () => {
  const messages = foldTranscript([
    event('user/message', {
      id: MessageId('msg-1'),
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }, 0),
  ])
  assert.deepEqual(kinds(messages), ['user'])
  assert.equal(messages[0]?.text, 'hello')
})

test('accumulates streaming text deltas into one assistant message', () => {
  const chunk = (seq: number, text: string): SessionEvent => event('assistant/chunk', {
    turn: 0,
    step: 0,
    chunk: { type: 'text-delta', index: 0, text },
  }, seq)
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    chunk(1, 'Hel'),
    chunk(2, 'lo'),
    chunk(3, ' world'),
  ])
  assert.deepEqual(kinds(messages), ['assistant'])
  assert.equal(messages[0]?.text, 'Hello world')
})

test('assistant/message replaces the streamed text for its step', () => {
  const messages = foldTranscript([
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'par' } }, 0),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-2'),
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['assistant'])
  assert.equal(messages[0]?.text, 'partial')
})

test('pairs tool calls with their results and caps long summaries', () => {
  const long = 'x'.repeat(300)
  const messages = foldTranscript([
    event('tool/call', { turn: 0, step: 0, callId: CallId('call-1'), name: 'bash', arguments: '{}' }, 0),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-3'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: long }],
        }],
        source: { kind: 'tool', callId: CallId('call-1') },
      },
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, 'bash')
  assert.ok(tool.text.length <= 201, `summary capped, got ${tool.text.length}`)
  assert.ok(tool.text.endsWith('…'))
})

test('turn/end error renders a failure line', () => {
  const messages = foldTranscript([
    event('turn/end', { turn: 0, reason: { kind: 'error', error: { message: 'boom', code: 'AUTH' } } }, 0),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, 'error')
  assert.equal(tool.text, 'AUTH: boom')
})

test('command/run + command/done fold into an executed line', () => {
  const messages = foldTranscript([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success' }, 1),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, '/compact')
})

test('renderTranscript produces the markdown document', () => {
  const text = renderTranscript([
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: '**hello**' },
    { kind: 'tool', name: 'bash', text: 'ok' },
  ])
  assert.ok(text.includes('**You:** hi'))
  assert.ok(text.includes('**hello**'))
  assert.ok(text.includes('> `bash` — ok'))
})
