/**
 * Unit tests for the transcript folding: session events → renderable
 * messages, with streaming chunk accumulation and tool call pairing.
 * Pure functions, no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/transcript.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallId, MessageId, type AssistantStreamRecord, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { foldTranscript, TranscriptFolder, windowMessages, type TranscriptMessage } from '../src/transcript.ts'
import { TranscriptWindowController } from '../src/transcript-window.ts'
import type { AssistantLiveChunk, AssistantLiveContentBlock, AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'

/** Build a minimal event envelope for tests. The type parameter is widened
 * to any string so legacy v1 `assistant/chunk` events (absent from master's
 * SessionEventMap) can be constructed and fed through the live-seam bridge;
 * known types keep their typed data surface, widened with
 * `Record<string, unknown>` so Session v2 fields the installed dsh-session
 * may lag (e.g. `assistant/message.stream`) can be supplied. */
function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** Build an event with loosely-typed data (plugin-extension event tests). */
function rawEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** One Session v2 live chunk input (the transient plane replaces durable
 * `assistant/chunk` events). */
function liveChunk(
  turn: number,
  step: number,
  chunk: AssistantLiveChunk,
  time = 1_700_000_000_000,
): AssistantLiveInput {
  return { kind: 'chunk', sessionId: 'test', attemptId: 'attempt-1', turn, step, time, chunk }
}

/** Fold a mixed event list: durable events through `apply()`, legacy
 * `assistant/chunk` events through the live input seam (Session v2). The
 * legacy type is read STRUCTURALLY (master's event union no longer
 * contains it). */
function foldLive(events: readonly SessionEvent[]): TranscriptMessage[] {
  const folder = new TranscriptFolder()
  for (const event of events) {
    const kind = event.type as string
    if (kind === 'assistant/chunk') {
      const data = event.data as { turn: number; step: number; chunk: AssistantLiveChunk }
      folder.applyLiveInput(liveChunk(data.turn, data.step, data.chunk, event.time))
    } else {
      folder.apply([event])
    }
  }
  return folder.messages()
}

/** Build a surface event carrying its surface metadata marker. The data
 * surface is widened like `event()` so Session v2 fields the installed
 * dsh-session may lag (e.g. `assistant/message.stream`) can be supplied. */
function surfaceEvent<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'] & Record<string, unknown>,
  seq: number,
  surfaceOp: 'append' | { op: 'replace'; start: number; end: number },
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data, surfaceOp } as SessionEvent
}

/** One append-origin tool result for `callId` (surfaceOp=append). */
function toolResult(seq: number, callId: string, text: string, name = 'bash'): SessionEvent {
  return surfaceEvent('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq, 'append')
}

/** One prune replacement of tool/result `callId` (surfaceOp=replace). */
function pruneReplacement(seq: number, callId: string, text: string, originalSeq: number): SessionEvent {
  return surfaceEvent('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-prune-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq, { op: 'replace', start: originalSeq, end: originalSeq })
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
  const first = messages[0]
  assert.ok(first !== undefined && first.kind === 'user')
  assert.equal(first.text, 'hello')
})

test('accumulates streaming text deltas into one assistant message', () => {
  const messages = foldLive([
    event('turn/start', { turn: 0 }, 0),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }, 1),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'lo' } }, 2),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: ' world' } }, 3),
  ])
  assert.deepEqual(kinds(messages), ['assistant'])
  const first = messages[0]
  assert.ok(first !== undefined && first.kind === 'assistant')
  assert.equal(first.text, 'Hello world')
})

test('assistant/message replaces the streamed text for its step', () => {
  const messages = foldLive([
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
      stream: [],
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['assistant'])
  const first = messages[0]
  assert.ok(first !== undefined && first.kind === 'assistant')
  assert.equal(first.text, 'partial')
})

test('pairs tool calls with their results and caps long summaries', () => {
  const long = 'x'.repeat(300)
  const messages = foldTranscript([
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' }, 0),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-3'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-1'),
          content: [{ type: 'text', text: long }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-1') },
      },
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, 'bash')
  assert.equal(tool.status, 'ok')
  // The fold keeps the full result; preview truncation is a render concern.
  assert.equal(tool.result.length, 300)
})

test('turn/end error renders a failure line', () => {
  const messages = foldTranscript([
    event('turn/end', { turn: 0, reason: { kind: 'error', error: { message: 'boom', code: 'AUTH' } } }, 0),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, 'error')
  assert.equal(tool.result, 'authentication failed')
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

test('command/done success text and error text fold into the card', () => {
  const success = foldTranscript([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'title set: hello' }, 1),
  ])
  const ok = success[0]
  assert.ok(ok !== undefined && ok.kind === 'tool')
  assert.equal(ok.result, 'executed — title set: hello')
  const failed = foldTranscript([
    event('command/run', { commandId: CommandId('cmd-2'), name: 'title', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-2'), kind: 'error', text: 'boom' }, 1),
  ])
  const bad = failed[0]
  assert.ok(bad !== undefined && bad.kind === 'tool')
  assert.equal(bad.status, 'error')
  assert.equal(bad.result, 'executed — error: boom')
})

test('plugin-sourced user messages fold as system entries', () => {
  const messages = foldTranscript([
    event('user/message', {
      id: MessageId('msg-4'),
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>\nworkspace instructions…' }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    }, 0),
    event('user/message', {
      id: MessageId('msg-5'),
      role: 'user',
      content: [{ type: 'text', text: 'real prompt' }],
      source: { kind: 'user' },
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['system', 'user'])
  const system = messages[0]
  assert.ok(system !== undefined && system.kind === 'system')
  assert.ok(system.text.includes('<system-reminder>'))
  assert.equal(system.label, 'agent-instructions', 'the producer label must be projected')
})

test('aborted turn/end folds into an interrupted card', () => {
  const messages = foldTranscript([
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 0),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, 'interrupted')
  assert.equal(tool.status, 'error')
  assert.equal(tool.result, 'cancelled by user')
})

test('parallel same-name tool calls pair results by callId', () => {
  // Two bash calls run concurrently; the first result must land on the FIRST
  // card. Name-based pairing would swap them (last running card wins).
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('call-1'), name: 'bash', arguments: '{"cmd":"one"}' }, 1),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('call-2'), name: 'bash', arguments: '{"cmd":"two"}' }, 2),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-a'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-1'),
          content: [{ type: 'text', text: 'out-one' }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-1') },
      },
    }, 3),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-b'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-2'),
          content: [{ type: 'text', text: 'out-two' }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-2') },
      },
    }, 4),
  ])
  const tools = messages.filter(message => message.kind === 'tool')
  assert.equal(tools.length, 2)
  const first = tools[0]
  const second = tools[1]
  assert.ok(first !== undefined && first.kind === 'tool' && second !== undefined && second.kind === 'tool')
  assert.equal(first.args, '{"cmd":"one"}')
  assert.equal(first.result, 'out-one')
  assert.equal(second.args, '{"cmd":"two"}')
  assert.equal(second.result, 'out-two')
})

test('interleaved steps keep separate assistant and thinking entries', () => {
  const chunk = (seq: number, step: number, delta: { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }): SessionEvent =>
    event('assistant/chunk', { turn: 0, step, chunk: delta }, seq)
  const messages = foldLive([
    event('turn/start', { turn: 0 }, 0),
    chunk(1, 0, { type: 'text-delta', index: 0, text: 'Hel' }),
    chunk(2, 0, { type: 'reasoning-delta', index: 1, text: 't0-' }),
    chunk(3, 0, { type: 'text-delta', index: 0, text: 'lo' }),
    chunk(4, 1, { type: 'text-delta', index: 0, text: 'x' }),
    chunk(5, 1, { type: 'reasoning-delta', index: 1, text: 't1-' }),
    chunk(6, 1, { type: 'text-delta', index: 0, text: 'y' }),
    // Step 0's reasoning continues AFTER step 1 started: it must update the
    // step-0 thinking entry, not the step-1 one (last-entry assumption bug).
    chunk(7, 0, { type: 'reasoning-delta', index: 1, text: 'more' }),
  ])
  assert.deepEqual(kinds(messages), ['assistant', 'thinking', 'assistant', 'thinking'])
  const [first, thinking0, second, thinking1] = messages
  assert.ok(first !== undefined && first.kind === 'assistant' && thinking0 !== undefined && thinking0.kind === 'thinking')
  assert.ok(second !== undefined && second.kind === 'assistant' && thinking1 !== undefined && thinking1.kind === 'thinking')
  assert.equal(first.text, 'Hello')
  assert.equal(thinking0.text, 't0-more')
  assert.equal(second.text, 'xy')
  assert.equal(thinking1.text, 't1-')
})

test('thinking lifecycle index retains only unsettled entries by turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: 'settled' }, 1_700_000_000_001))
  folder.apply([
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-settled'),
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 2),
    event('turn/start', { turn: 1 }, 3),
  ])
  folder.applyLiveInput(liveChunk(1, 0, { type: 'reasoning-delta', index: 0, text: 'still thinking' }, 1_700_000_000_004))
  folder.apply([
    event('turn/end', { turn: 0, reason: { kind: 'interrupted' } }, 5),
  ])

  const thinking = folder.messages().filter((message): message is Extract<TranscriptMessage, { kind: 'thinking' }> => message.kind === 'thinking')
  assert.equal(thinking.find(message => message.turn === 0)?.running, false)
  assert.equal(thinking.find(message => message.turn === 1)?.running, true,
    'ending one turn must not settle another turn\'s open reasoning')
  const open = (folder as unknown as { openThinkingByTurn: Map<number, Set<unknown>> }).openThinkingByTurn
  assert.equal(open.has(0), false, 'settled entries must leave the open index')
  assert.equal(open.get(1)?.size, 1)

  folder.apply([event('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 6)])
  const endedThinking = folder.messages().find((message): message is Extract<TranscriptMessage, { kind: 'thinking' }> => message.kind === 'thinking' && message.turn === 1)
  assert.equal(endedThinking?.running, false)
  assert.equal(open.size, 0, 'turn/end should discard the ended turn bucket')
})

test('late reasoning keeps an assistant-settled thinking entry closed', () => {
  const folder = new TranscriptFolder()
  folder.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: 'before' }, 1_700_000_000_000))
  folder.apply([
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-late-thinking'),
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 1),
  ])
  // The transcript preserves the late replay fragment, but it must not
  // re-enter the open lifecycle set or become running again.
  folder.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: ' after' }, 1_700_000_000_002))
  const thinking = folder.messages().find((message): message is Extract<TranscriptMessage, { kind: 'thinking' }> => message.kind === 'thinking')
  assert.ok(thinking)
  assert.equal(thinking.running, false)
  assert.equal(thinking.text, 'before after')
  const open = (folder as unknown as { openThinkingByTurn: Map<number, Set<unknown>> }).openThinkingByTurn
  assert.equal(open.size, 0)
})

test('windows older turns into one summary entry', () => {
  const events: SessionEvent[] = [
    // Turn 0: user prompt + tool call + result.
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('msg-0'), role: 'user',
      content: [{ type: 'text', text: 'q0' }],
      source: { kind: 'user' },
    }, 1),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('call-0'), name: 'bash', arguments: '{}' }, 2),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('msg-1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('call-0'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: ToolCallId('call-0') },
      },
    }, 3),
    // Turn 1: user + assistant.
    event('turn/start', { turn: 1 }, 4),
    event('user/message', {
      id: MessageId('msg-2'), role: 'user',
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }, 5),
    event('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('msg-3'), role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 6),
    // Turn 2: user prompt.
    event('turn/start', { turn: 2 }, 7),
    event('user/message', {
      id: MessageId('msg-4'), role: 'user',
      content: [{ type: 'text', text: 'q2' }],
      source: { kind: 'user' },
    }, 8),
  ]
  const full = foldTranscript(events)
  assert.equal(full.length, 5)
  const windowed = foldTranscript(events, { maxTurns: 2 })
  const summary = windowed[0]
  assert.ok(summary !== undefined && summary.kind === 'summary', `no summary:\n${JSON.stringify(windowed, null, 2)}`)
  assert.ok(summary.text.includes('1 earlier turn'), `summary text:\n${summary.text}`)
  assert.ok(summary.text.includes('1 tool call'), `summary text:\n${summary.text}`)
  assert.deepEqual(kinds(windowed.slice(1)), ['user', 'assistant', 'user'])
  for (const message of windowed.slice(1)) {
    assert.ok('turn' in message && message.turn >= 1, `window kept an old turn: ${JSON.stringify(message)}`)
  }
})

test('the window projection reads incremental counts: deep history never rescanned', () => {
  // 600 turns × (user + assistant) = 1200 items. The window path must
  // produce the same summary numbers the full-scan path produced, derived
  // from the maintained turn index rather than a history walk.
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 600; turn += 1) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('user/message', {
      id: MessageId(`msg-${turn}-u`), role: 'user',
      content: [{ type: 'text', text: `q${turn}` }],
      source: { kind: 'user' },
    }, seq++))
    events.push(event('assistant/message', {
      turn, step: 0,
      message: {
        id: MessageId(`msg-${turn}-a`), role: 'assistant',
        content: [{ type: 'text', text: `a${turn}` }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, seq++))
  }
  folder.apply(events)
  const windowed = folder.messages({ maxTurns: 5 })
  const summary = windowed[0]
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.ok(summary.text.includes('595 earlier turns'), `summary text:\n${summary.text}`)
  assert.ok(summary.text.includes('0 tool calls'), `summary text:\n${summary.text}`)
  assert.equal(windowed.length, 11, '5 turns × 2 items + summary')
  // The whole transcript is still available (full path unchanged).
  assert.equal(folder.messages().length, 1200)
})

test('a cross-turn read group keeps the fast window consistent with the full scan', () => {
  // turn 1: read ok; turn 2: read ok (merges with turn 1's read into one
  // card with turn 2); turn 3: plain user message. The fast window's
  // turn index counts the RAW items (3 turns) while the grouped output
  // only has turns {2, 3} — the summaries must still agree.
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    event('turn/start', { turn: 1 }, 0),
    event('tool/call', { turn: 1, step: 0, callId: ToolCallId('call-1'), name: 'read', arguments: '{}' }, 1),
    event('tool/result', {
      turn: 1, step: 0,
      message: { id: MessageId('msg-1'), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('call-1'), content: [{ type: 'text', text: 'a' }] }], source: { kind: 'tool', callId: ToolCallId('call-1') } },
    }, 2),
    event('turn/start', { turn: 2 }, 3),
    event('tool/call', { turn: 2, step: 0, callId: ToolCallId('call-2'), name: 'read', arguments: '{}' }, 4),
    event('tool/result', {
      turn: 2, step: 0,
      message: { id: MessageId('msg-2'), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('call-2'), content: [{ type: 'text', text: 'b' }] }], source: { kind: 'tool', callId: ToolCallId('call-2') } },
    }, 5),
    event('turn/start', { turn: 3 }, 6),
    event('user/message', {
      id: MessageId('msg-3'), role: 'user',
      content: [{ type: 'text', text: 'q3' }],
      source: { kind: 'user' },
    }, 7),
  ]
  folder.apply(events)
  const fast = folder.messages({ maxTurns: 1 })
  const full = windowMessages(folder.messages(), 1)
  const bounded = folder.window({ maxTurns: 1 })
  assert.equal(JSON.stringify(bounded.messages), JSON.stringify(full),
    `the indexed window must match the full scan:\n${JSON.stringify(bounded.messages)}\nvs\n${JSON.stringify(full)}`)
  assert.deepEqual({ firstTurn: bounded.firstTurn, lastTurn: bounded.lastTurn, hasOlder: bounded.hasOlder, hasNewer: bounded.hasNewer }, {
    firstTurn: 3, lastTurn: 3, hasOlder: true, hasNewer: false,
  })
  assert.equal(JSON.stringify(fast), JSON.stringify(full),
    `the fast window must match the full scan:\n${JSON.stringify(fast)}\nvs\n${JSON.stringify(full)}`)
  const anchored = folder.window({ maxTurns: 1, endTurn: 2 })
  const anchoredFull = windowMessages(folder.messages(), 1, 2)
  assert.equal(JSON.stringify(anchored.messages), JSON.stringify(anchoredFull),
    `anchored indexed window must match the full scan:\n${JSON.stringify(anchored.messages)}\nvs\n${JSON.stringify(anchoredFull)}`)
  const summary = fast[0]
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.ok(summary.text.includes('1 earlier turn'), `summary text:\n${summary.text}`)
})

test('non-monotonic windows derive metadata from the full fallback projection', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (const turn of [1, 3, 2]) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(`non-monotonic-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn}` }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    }, seq++))
  }
  folder.apply(events)

  const bounded = folder.window({ maxTurns: 1 })
  assert.deepEqual({
    firstTurn: bounded.firstTurn,
    lastTurn: bounded.lastTurn,
    hasOlder: bounded.hasOlder,
    hasNewer: bounded.hasNewer,
  }, { firstTurn: 3, lastTurn: 3, hasOlder: true, hasNewer: false })
  assert.deepEqual(kinds(bounded.messages), ['summary', 'assistant'])
})

test('non-monotonic raw turn indexes retain every turn for search navigation', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (const turn of [1, 3, 2]) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(`non-monotonic-search-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn}` }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    }, seq++))
  }
  folder.apply(events)

  assert.deepEqual(folder.turns(), [1, 3, 2], 'the raw index must retain a lower turn discovered after monotonicity breaks')
  assert.deepEqual(folder.groupedTurns(), [1, 2, 3])
  const match = folder.search('turn 2')
  assert.equal(match.length, 1)
  const matchMessage = match[0]
  assert.ok(matchMessage !== undefined)
  const controller = new TranscriptWindowController({ windowTurns: 1, stepTurns: 1, turns: folder.turns() })
  assert.equal(controller.anchorAt(matchMessage.turn), true, 'search must anchor a retained non-monotonic turn')
  assert.equal(controller.endTurn(), 2)
  const anchored = folder.window({ maxTurns: 1, endTurn: controller.endTurn() })
  assert.equal(anchored.lastTurn, 2)
  assert.ok(anchored.messages.some(message => 'turn' in message && message.turn === 2))
})

test('unknown window anchors preserve latest summary semantics', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 25; turn += 1) {
    events.push(event('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(`unknown-anchor-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn}` }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    }, seq++))
  }
  folder.apply(events)
  const indexed = folder.window({ maxTurns: 20, endTurn: 999 })
  const full = windowMessages(folder.messages(), 20, 999)
  assert.deepEqual(indexed.messages, full)
})

test('the fast window matches the full scan across mixed grouping shapes', () => {
  // A deterministic mixed log: cross-turn read runs, same-turn read runs,
  // user-separated reads, tools, and streaming text. The fast window must
  // agree with windowMessages(folder.messages(), n) for every window size.
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  const user = (turn: number, text: string): void => {
    events.push(event('user/message', { id: MessageId(`msg-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq++))
  }
  const read = (turn: number): void => {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('tool/call', { turn, step: 0, callId: ToolCallId(`call-${seq}`), name: 'read', arguments: '{}' }, seq++))
    events.push(event('tool/result', {
      turn, step: 0,
      message: { id: MessageId(`msg-${seq}`), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId(`call-${seq}`), content: [{ type: 'text', text: 'file' }] }], source: { kind: 'tool', callId: ToolCallId(`call-${seq}`) } },
    }, seq++))
  }
  const tool = (turn: number): void => {
    events.push(event('tool/call', { turn, step: 0, callId: ToolCallId(`call-${seq}`), name: 'bash', arguments: '{}' }, seq++))
    events.push(event('tool/result', {
      turn, step: 0,
      message: { id: MessageId(`msg-${seq}`), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId(`call-${seq}`), content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: ToolCallId(`call-${seq}`) } },
    }, seq++))
  }
  // turn 0: user + read; turn 1: read (cross-turn merge with turn 0)
  user(0, 'q0')
  read(0)
  read(1)
  // turn 2: user + two same-turn reads (merged within one turn)
  user(2, 'q2')
  read(2)
  read(2)
  // turn 3: user + bash tool (not groupable)
  user(3, 'q3')
  tool(3)
  // turn 4: read; turn 5: read (cross-turn merge), then a user
  read(4)
  read(5)
  user(5, 'q5')
  folder.apply(events)
  for (let maxTurns = 1; maxTurns <= 6; maxTurns += 1) {
    const fast = folder.messages({ maxTurns })
     const bounded = folder.window({ maxTurns })
    const full = windowMessages(folder.messages(), maxTurns)
     assert.equal(JSON.stringify(bounded.messages), JSON.stringify(full),
       `indexed window must match the full scan at maxTurns=${maxTurns}:\n${JSON.stringify(bounded.messages)}\nvs\n${JSON.stringify(full)}`)
    assert.equal(JSON.stringify(fast), JSON.stringify(full),
      `fast window must match the full scan at maxTurns=${maxTurns}:\n${JSON.stringify(fast)}\nvs\n${JSON.stringify(full)}`)
  }
})

test('the window summary counts grouped read cards from the incremental projection', () => {
  // 10 turns, each with a settled read (user messages break the read runs,
  // so every read stays its own card). The window (turns 8-9) holds no
  // tools: the summary must report 8 earlier turns and 8 tool calls from
  // the incremental projections, matching the full-scan path.
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 10; turn += 1) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('user/message', {
      id: MessageId(`msg-${turn}-u`), role: 'user',
      content: [{ type: 'text', text: `q${turn}` }],
      source: { kind: 'user' },
    }, seq++))
    events.push(event('tool/call', { turn, step: 0, callId: ToolCallId(`call-${turn}`), name: 'read', arguments: '{}' }, seq++))
    events.push(event('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId(`msg-${turn}`), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId(`call-${turn}`), content: [{ type: 'text', text: 'file' }] }],
        source: { kind: 'tool', callId: ToolCallId(`call-${turn}`) },
      },
    }, seq++))
  }
  folder.apply(events)
  const windowed = folder.messages({ maxTurns: 2 })
  const summary = windowed[0]
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.ok(summary.text.includes('8 earlier turns'), `summary text:\n${summary.text}`)
  assert.ok(summary.text.includes('8 tool calls'), `summary text:\n${summary.text}`)
  // Parity with the full-scan window path (no turn index involved).
  const full = foldTranscript(events, { maxTurns: 2 })
  const fullSummary = full[0]
  assert.ok(fullSummary !== undefined && fullSummary.kind === 'summary')
  assert.equal(summary.text, fullSummary.text, 'incremental and full-scan summaries must match')
  assert.deepEqual(kinds(windowed), kinds(full), 'the windowed output must match the full scan')
})

test('window keeps everything when the log fits', () => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('msg-0'), role: 'user',
      content: [{ type: 'text', text: 'q0' }],
      source: { kind: 'user' },
    }, 1),
    event('turn/start', { turn: 1 }, 2),
    event('user/message', {
      id: MessageId('msg-1'), role: 'user',
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }, 3),
  ]
  const windowed = foldTranscript(events, { maxTurns: 5 })
  assert.deepEqual(kinds(windowed), ['user', 'user'])
})

test('TranscriptFolder applies incrementally with stable objects', () => {
  const folder = new TranscriptFolder()
  folder.apply([event('turn/start', { turn: 0 }, 0)])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'Hel' }, 1_700_000_000_001))
  const first = folder.messages()
  assert.equal(first.length, 1)
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'lo' }, 1_700_000_000_002))
  const second = folder.messages()
  assert.equal(second.length, 1)
  const entry = second[0]
  assert.ok(entry !== undefined && entry.kind === 'assistant')
  assert.equal(entry.text, 'Hello')
  assert.equal(first[0], entry, 'incremental apply must mutate the same objects')
  const windowed = folder.messages({ maxTurns: 5 })
  assert.deepEqual(kinds(windowed), ['assistant'])
})

test('consecutive read results group into one card', () => {
  const readResult = (seq: number, callId: string, text: string): SessionEvent => event('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    readResult(4, 'r2', 'bbb'),
    // A non-read breaks the group.
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('b1'), name: 'bash', arguments: '{}' }, 5),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('msg-6'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('b1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: ToolCallId('b1') },
      },
    }, 6),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r3'), name: 'read', arguments: '{"file":"c.ts"}' }, 7),
    readResult(8, 'r3', 'ccc'),
  ])
  const tools = messages.filter(message => message.kind === 'tool')
  assert.equal(tools.length, 3)
  const first = tools[0]
  assert.ok(first !== undefined && first.kind === 'tool')
  assert.equal(first.name, 'read')
  assert.equal(first.args, '2 files')
  assert.ok(first.result.includes('aaa') && first.result.includes('bbb'), `grouped result missing:\n${first.result}`)
  const last = tools[2]
  assert.ok(last !== undefined && last.kind === 'tool')
  assert.equal(last.name, 'read')
  assert.equal(last.args, '{"file":"c.ts"}', 'a single read keeps its args')
})

test('consecutive read grouping spans turn boundaries (incremental projection parity)', () => {
  const readResult = (seq: number, callId: string, text: string): SessionEvent => event('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(callId), content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
  // Two reads in DIFFERENT turns, applied incrementally.
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
  ])
  folder.apply([
    event('turn/start', { turn: 1 }, 3),
    event('tool/call', { turn: 1, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 4),
    readResult(5, 'r2', 'bbb'),
  ])
  const tools = folder.messages().filter(message => message.kind === 'tool')
  assert.equal(tools.length, 1, 'grouping ignores turn boundaries (same as the one-shot pass)')
  assert.equal(tools[0]?.args, '2 files')
  assert.ok((tools[0]?.result ?? '').includes('aaa') && (tools[0]?.result ?? '').includes('bbb'))
})

test('a failed read breaks the group; late settlement preserves reflow counts', () => {
  const readResult = (seq: number, callId: string, text: string, isError = false): SessionEvent => event('tool/result', {
    turn: 0,
    step: 0,
    ...isError ? { error: { name: 'read-failed', code: 'read-failed' } } : {},
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(callId), content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    // r2 FAILS: the run breaks even though the card is named read.
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    readResult(4, 'r2', 'bbb', true),
    // r3 is called but its result lands LATE (after the next turn started).
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r3'), name: 'read', arguments: '{"file":"c.ts"}' }, 5),
    event('turn/start', { turn: 1 }, 6),
  ])
  const before = folder.messages().filter(message => message.kind === 'tool')
  assert.equal(before.length, 3, 'running + failed reads stay separate')
  assert.equal(before[0]?.status, 'ok')
  assert.equal(before[1]?.status, 'error')
  assert.equal(before[2]?.status, 'running')
  // The late result settles r3; the failed r2 sits between it and r1, so
  // r3 stays a singleton.
  folder.apply([readResult(7, 'r3', 'ccc')])
  const after = folder.messages().filter(message => message.kind === 'tool')
  assert.equal(after.length, 3)
  assert.equal(after[2]?.args, '{"file":"c.ts"}', 'a late-settled read after a failed read stays single')
  // And a late result at the TAIL of a run merges into the preceding group.
  const folder2 = new TranscriptFolder()
  folder2.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    event('turn/start', { turn: 1 }, 4),
  ])
  folder2.apply([readResult(5, 'r2', 'bbb')])
  const tail = folder2.messages().filter(message => message.kind === 'tool')
  assert.equal(tail.length, 1, 'a late result merges the tail read into the group')
  assert.equal(tail[0]?.args, '2 files')

  // A non-tail settlement after an existing group rebuilds the adjacent run;
  // the bounded summary must still count one emitted tool card for that run.
  const folder3 = new TranscriptFolder()
  folder3.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{}' }, 3),
    readResult(4, 'r2', 'bbb'),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r3'), name: 'read', arguments: '{}' }, 5),
    event('turn/start', { turn: 1 }, 6),
    event('user/message', {
      id: MessageId('late-reflow-user'),
      role: 'user',
      content: [{ type: 'text', text: 'later turn' }],
      source: { kind: 'user' },
    }, 7),
  ])
  folder3.apply([readResult(8, 'r3', 'ccc')])
  const reflowed = folder3.messages({ maxTurns: 1 })
  assert.deepEqual(reflowed, windowMessages(folder3.messages(), 1), 'non-tail reflow must preserve bounded/full projection parity')
  const reflowSummary = reflowed[0]
  assert.ok(reflowSummary !== undefined && reflowSummary.kind === 'summary')
  assert.ok(reflowSummary.text.includes('1 tool call'), `reflow summary must count output cards: ${reflowSummary.text}`)
})

test('cold hydrate defers adjacent-read reflow and preserves apply semantics', () => {
  const events: SessionEvent[] = [event('turn/start', { turn: 0 }, 0)]
  for (let index = 0; index < 128; index += 1) {
    const callId = ToolCallId(`hydrate-read-${index}`)
    events.push(event('tool/call', {
      turn: 0,
      step: 0,
      callId,
      name: 'read',
      arguments: JSON.stringify({ file: `file-${index}.ts` }),
    }, events.length))
    events.push(event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId(`hydrate-read-message-${index}`),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `result-${index}` }] }],
        source: { kind: 'tool', callId },
      },
    }, events.length))
  }

  const expected = new TranscriptFolder()
  const liveInternals = expected as unknown as {
    reflowGrouping: (index: number) => void
  }
  const originalLiveReflow = liveInternals.reflowGrouping
  let liveReflowCount = 0
  liveInternals.reflowGrouping = (index) => {
    liveReflowCount += 1
    originalLiveReflow.call(liveInternals, index)
  }
  try {
    for (const item of events) expected.apply([item])
  } finally {
    liveInternals.reflowGrouping = originalLiveReflow
  }
  assert.equal(liveReflowCount, 0, 'tail live reads must append without a full-run reflow')

  const hydrated = new TranscriptFolder()
  const internals = hydrated as unknown as {
    reflowGrouping: (index: number) => void
  }
  const originalReflow = internals.reflowGrouping
  let reflowCount = 0
  internals.reflowGrouping = (index) => {
    reflowCount += 1
    originalReflow.call(internals, index)
  }
  try {
    hydrated.hydrate(events)
  } finally {
    internals.reflowGrouping = originalReflow
  }

  assert.equal(reflowCount, 0, 'cold hydration must finalize read runs once instead of reflowing each result')
  assert.deepEqual(hydrated.messages(), expected.messages())
  const tools = hydrated.messages().filter((message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.args, '128 files')
  assert.ok(tools[0]?.result.startsWith('result-0'))
  assert.ok(tools[0]?.result.endsWith('result-127'))

  // Hydration is a cold-only optimization: a later live suffix still uses the
  // immediate grouping path and retains the same public projection semantics.
  const nextCall = ToolCallId('hydrate-read-live')
  hydrated.apply([
    event('tool/call', { turn: 0, step: 0, callId: nextCall, name: 'read', arguments: '{}' }, events.length),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('hydrate-read-live-message'),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: nextCall, content: [{ type: 'text', text: 'live-result' }] }],
        source: { kind: 'tool', callId: nextCall },
      },
    }, events.length + 1),
  ])
  const liveTools = hydrated.messages().filter((message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool')
  assert.equal(liveTools.length, 1)
  assert.equal(liveTools[0]?.args, '129 files')
  assert.ok(liveTools[0]?.result.endsWith('live-result'))
})

test('subagent/descriptor folds into a delegation card', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('subagent/descriptor', {
      version: 2,
      mode: 'continuable',
      provider: 'in-process',
      label: 'do the thing',
      agentModel: 'deepseek-chat',
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const card = messages[0]
  assert.ok(card !== undefined && card.kind === 'tool')
  assert.equal(card.name, 'subagent')
  assert.equal(card.args, 'do the thing')
  assert.equal(card.status, 'ok')
  assert.ok(card.result.includes('mode: continuable'))
  assert.ok(card.result.includes('model: deepseek-chat'))
})

test('workflow run events fold into one run card with member rows', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    rawEvent('tool-workflow/run-start', { runId: 'run-1', name: 'audit' }, 1),
    rawEvent('tool-workflow/agent-start', { runId: 'run-1', seq: 0, label: 'checker', phase: 'review', childId: 'session-x' }, 2),
    rawEvent('tool-workflow/agent-end', { runId: 'run-1', seq: 0, outcome: 'completed' }, 3),
    rawEvent('tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }, 4),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const run = messages[0]
  assert.ok(run !== undefined && run.kind === 'tool')
  assert.equal(run.name, 'workflow')
  assert.equal(run.args, 'audit')
  assert.equal(run.status, 'ok')
  assert.equal(run.result, 'stop: completed')
  assert.deepEqual(run.members, [{ label: 'checker', phase: 'review', status: 'ok' }])
})

test('a failed workflow member settles its row as error', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    rawEvent('tool-workflow/run-start', { runId: 'run-2', name: 'audit' }, 1),
    rawEvent('tool-workflow/agent-start', { runId: 'run-2', seq: 0, label: 'checker', childId: 'session-x' }, 2),
    rawEvent('tool-workflow/agent-end', { runId: 'run-2', seq: 0, outcome: 'failed' }, 3),
  ])
  const run = messages[0]
  assert.ok(run !== undefined && run.kind === 'tool')
  assert.deepEqual(run.members, [{ label: 'checker', status: 'error' }])
})

test('llm/retry folds into a system line with the delay', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    rawEvent('llm/retry', {
      retryId: 'r1', turn: 0, step: 0, provider: 'deepseek', mode: 'normal',
      policyKey: 'k', retry: 1, maxRetries: 2, delayMs: 3000,
      failure: { message: 'boom', code: 'RATE_LIMITED' },
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['system'])
  const entry = messages[0]
  assert.ok(entry !== undefined && entry.kind === 'system')
  assert.ok(entry.text.includes('llm retry 1/2 in 3s'), `text:\n${entry.text}`)
  assert.ok(entry.text.includes('RATE_LIMITED'), `text:\n${entry.text}`)
})

test('AUTH failures use generic presentation text without leaking durable messages', () => {
  const retry = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    rawEvent('llm/retry', {
      retryId: 'auth-retry', turn: 0, step: 0, provider: 'deepseek', mode: 'normal',
      policyKey: 'k', retry: 1, maxRetries: 2, delayMs: 3000,
      failure: { message: 'secret-provider-credential', code: 'AUTH' },
    }, 1),
  ])
  const retryRow = retry[0]
  assert.ok(retryRow !== undefined && retryRow.kind === 'system')
  assert.equal(retryRow.text, 'llm retry 1/2 in 3s — authentication failed')
  assert.doesNotMatch(retryRow.text, /secret-provider-credential/)

  const turn = foldTranscript([
    event('turn/end', { turn: 0, reason: { kind: 'error', error: { message: 'secret-provider-credential', code: 'AUTH' } } }, 0),
  ])
  const turnRow = turn[0]
  assert.ok(turnRow !== undefined && turnRow.kind === 'tool')
  assert.equal(turnRow.result, 'authentication failed')
  assert.doesNotMatch(turnRow.result, /secret-provider-credential/)

  const server = foldTranscript([
    event('turn/end', { turn: 0, reason: { kind: 'error', error: { message: 'provider down', code: 'SERVER' } } }, 0),
  ])
  const serverRow = server[0]
  assert.ok(serverRow !== undefined && serverRow.kind === 'tool')
  assert.equal(serverRow.result, 'SERVER: provider down')
})

test('max-tokens turn end folds into a notice', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 1),
  ])
  assert.deepEqual(kinds(messages), ['system'])
  const entry = messages[0]
  assert.ok(entry !== undefined && entry.kind === 'system')
  assert.ok(entry.text.includes('max tokens'), `text:\n${entry.text}`)
})

test('window anchored at endTurn shows the match turn instead of the newest', () => {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 5; turn += 1) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('user/message', {
      id: MessageId(`msg-${turn}`), role: 'user',
      content: [{ type: 'text', text: `question-${turn}` }],
      source: { kind: 'user' },
    }, seq++))
    events.push(event('assistant/message', {
      turn, step: 0,
      message: {
        id: MessageId(`ans-${turn}`), role: 'assistant',
        content: [{ type: 'text', text: `answer-${turn}` }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, seq++))
  }
  // Default window: newest 2 turns (3, 4).
  const newest = foldTranscript(events, { maxTurns: 2 })
  assert.equal(newest[0]?.kind, 'summary')
  const newestTurns = newest.slice(1).flatMap(m => 'turn' in m ? [m.turn] : [])
  assert.deepEqual([...new Set(newestTurns)].sort(), [3, 4])
  // Anchored window: 2 turns ending at turn 1 → shows 0 and 1, hiding 2-4.
  const anchored = foldTranscript(events, { maxTurns: 2, endTurn: 1 })
  assert.equal(anchored[0]?.kind, 'summary')
  assert.ok((anchored[0] as { text: string }).text.includes('3 newer turns'), `summary:\n${JSON.stringify(anchored[0])}`)
  const anchoredTurns = anchored.slice(1).flatMap(m => 'turn' in m ? [m.turn] : [])
  assert.deepEqual([...new Set(anchoredTurns)].sort(), [0, 1])
  // The anchored view actually contains the older message text.
  assert.ok(anchored.some(m => 'text' in m && m.text.includes('question-0')), `anchored text:\n${JSON.stringify(anchored, null, 2)}`)
  // A window covering everything hides nothing: no summary noise.
  const recent = foldTranscript(events, { maxTurns: 5, endTurn: 4 })
  assert.equal(recent[0]?.kind, 'user', `no summary expected when the window fits:\n${JSON.stringify(recent[0])}`)
})

test('thinking entries run while deltas stream and settle on the step message', () => {
  const messages = foldLive([
    event('turn/start', { turn: 0 }, 0),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }, 1),
  ])
  const thinking = messages[0]
  assert.ok(thinking !== undefined && thinking.kind === 'thinking')
  assert.equal(thinking.running, true, 'streaming thinking must be running')
  const settled = foldLive([
    event('turn/start', { turn: 0 }, 0),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }, 1),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-2'),
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 2),
  ])
  const done = settled[0]
  assert.ok(done !== undefined && done.kind === 'thinking')
  assert.equal(done.running, false, 'the step message must settle its thinking entry')
})

test('an interrupted turn settles every live thinking entry', () => {
  const messages = foldLive([
    event('turn/start', { turn: 0 }, 0),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }, 1),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 2),
  ])
  const thinking = messages[0]
  assert.ok(thinking !== undefined && thinking.kind === 'thinking')
  assert.equal(thinking.running, false, 'turn/end must settle live thinking entries')
})

test('tool results keep their content blocks and meta for presentation', () => {
  const messages = foldTranscript([
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('call-1'), name: 'read', arguments: '{"file_path":"/ws/src/foo.ts"}' }, 0),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-3'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-1'),
          content: [{ type: 'text', text: 'hi' }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-1') },
      },
      meta: { path: '/ws/src/foo.ts', totalLines: 1 },
    }, 1),
  ])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.resultBlocks?.length, 1, 'result content blocks must be kept')
  assert.deepEqual(tool.meta, { path: '/ws/src/foo.ts', totalLines: 1 }, 'result meta must be kept')
})

test('injected context rows carry their producer labels (web provenance)', () => {
  const injections: { source: Record<string, unknown>; label: string }[] = [
    {
      source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md', kind: 'baseline' }] },
      label: 'AGENTS.md',
    },
    {
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      label: '@deepseek-ai/dsh-system-prompt',
    },
    {
      source: { kind: 'skill-invocation', form: 'instructions', name: 'skill-catalog' },
      label: 'skill-catalog',
    },
  ]
  const events: SessionEvent[] = injections.flatMap((injection, index) => [event('user/message', {
    id: MessageId(`msg-inj-${index}`),
    role: 'user',
    content: [{ type: 'text', text: 'injected body' }],
    source: injection.source as never,
  }, index)])
  const messages = foldTranscript(events)
  assert.deepEqual(kinds(messages), ['system', 'system', 'system'])
  messages.forEach((message, index) => {
    assert.ok(message !== undefined && message.kind === 'system')
    assert.equal(message.label, injections[index]?.label, `label for injection ${index}`)
  })
})

test('a session-reference source folds as recall with its joined labels', () => {
  const messages = foldTranscript([
    event('user/message', {
      id: MessageId('msg-ref'),
      role: 'user',
      content: [{ type: 'text', text: 'recalled material' }],
      source: {
        kind: 'session-reference',
        form: 'recall',
        version: 1,
        references: [
          { sessionId: 's1', label: 'old chat', capturedThroughSeq: 3, compacted: false, originalMessages: 4, retainedMessages: 4, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0 },
          { sessionId: 's2', label: 'old chat', capturedThroughSeq: null, compacted: false, originalMessages: 2, retainedMessages: 2, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 1 },
        ],
      } as never,
    }, 0),
  ])
  const system = messages[0]
  assert.ok(system !== undefined && system.kind === 'system')
  assert.equal(system.label, 'old chat', 'distinct reference labels join as one label')
})

test('a notice-form injection records its one-line summary', () => {
  const messages = foldTranscript([
    event('user/message', {
      id: MessageId('msg-notice'),
      role: 'user',
      content: [{ type: 'text', text: '3 files written' }],
      source: { kind: 'plugin', plugin: 'todo', form: 'notice', summary: 'saved the todo list' },
    }, 0),
  ])
  const system = messages[0]
  assert.ok(system !== undefined && system.kind === 'system')
  assert.equal(system.label, 'todo')
  assert.equal(system.summary, 'saved the todo list')
})

test('an unreadable injection source degrades to its kind as the label', () => {
  const messages = foldTranscript([
    event('user/message', {
      id: MessageId('msg-unknown'),
      role: 'user',
      content: [{ type: 'text', text: 'opaque' }],
      source: { kind: 'mystery-producer' } as never,
    }, 0),
  ])
  const system = messages[0]
  assert.ok(system !== undefined && system.kind === 'system')
  assert.equal(system.label, 'mystery-producer')
})

test('injected context rows carry a source-kind icon SEMANTIC (never a glyph)', () => {
  // The fold must store the semantic identity, not the concrete emoji:
  // an icon-style switch repaints already-folded cards (plan §11).
  const cases: { source: Record<string, unknown>; icon: string }[] = [
    { source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] }, icon: 'context-file' },
    { source: { kind: 'skill-invocation', form: 'instructions', name: 'skill-catalog' }, icon: 'context-skill' },
    { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, icon: 'context-plugin' },
    { source: { kind: 'plugin', plugin: 'todo', form: 'notice', summary: 'saved' }, icon: 'context-notice' },
    { source: { kind: 'session-reference', references: [{ label: 'yesterday' }] }, icon: 'context-recall' },
    { source: { kind: 'mystery-producer' } as never, icon: 'context-generic' },
  ]
  const events: SessionEvent[] = cases.map((entry, index) => event('user/message', {
    id: MessageId(`msg-icon-${index}`),
    role: 'user',
    content: [{ type: 'text', text: 'body' }],
    source: entry.source as never,
  }, index))
  const messages = foldTranscript(events)
  messages.forEach((message, index) => {
    assert.ok(message !== undefined && message.kind === 'system')
    assert.equal(message.icon, cases[index]?.icon, `icon semantic for injection ${index}`)
    // The fold NEVER stores a concrete glyph.
    assert.equal('emoji' in (message as Record<string, unknown>), false, `folded system rows must not carry a glyph field:\n${JSON.stringify(message)}`)
  })
})

// ---------------------------------------------------------------------------
// Human-transcript append-origin contract: model-only surface replacements
// (tool-result pruning after compaction/prune, summary compaction
// checkpoints) must never be replayed as new visible messages.
// ---------------------------------------------------------------------------

test('Test A: an append-origin tool call/result pair folds into one ok card', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('a1'), name: 'bash', arguments: '{"command":"echo"}' }, 1),
    toolResult(2, 'a1', 'ORIGINAL FULL RESULT'),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.status, 'ok')
  assert.equal(tool.result, 'ORIGINAL FULL RESULT')
  // The running → ok pairing is unchanged (verified via the folder).
  const folder = new TranscriptFolder()
  folder.apply([event('turn/start', { turn: 0 }, 0), event('tool/call', { turn: 0, step: 0, callId: ToolCallId('a1'), name: 'bash', arguments: '{}' }, 1)])
  const running = folder.messages()[0]
  assert.ok(running !== undefined && running.kind === 'tool')
  assert.equal(running.status, 'running')
  folder.apply([toolResult(2, 'a1', 'done')])
  const settled = folder.messages()[0]
  assert.ok(settled !== undefined && settled.kind === 'tool')
  assert.equal(settled.status, 'ok')
})

test('Test B: a post-prune replacement tool/result must not add a ghost card', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('a1'), name: 'bash', arguments: '{}' }, 1),
    toolResult(2, 'a1', 'ORIGINAL FULL RESULT'),
    // compaction/prune then the replacement copy of the SAME call.
    rawEvent('compaction/prune', {
      shadowedRange: { start: 2, end: 2 },
      shadowedSeqs: [2],
      shadowedTokenCount: 4200,
    }, 3),
    pruneReplacement(4, 'a1', 'PRUNED RESULT', 2),
  ])
  assert.deepEqual(kinds(messages), ['tool'], 'exactly one tool card expected')
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.result, 'ORIGINAL FULL RESULT', 'the append-origin result must survive pruned replacement')
  assert.notEqual(tool.result, 'PRUNED RESULT')
})

test('Test C: many prune replacements never change the transcript tail', () => {
  const events: SessionEvent[] = [event('turn/start', { turn: 0 }, 0)]
  let seq = 1
  const originalSeqs: number[] = []
  for (let index = 0; index < 13; index += 1) {
    const callId = `call-${index}`
    events.push(event('tool/call', { turn: 0, step: 0, callId: ToolCallId(callId), name: 'bash', arguments: `{"cmd":"${index}"}` }, seq++))
    const originalSeq = seq
    originalSeqs.push(originalSeq)
    events.push(toolResult(seq++, callId, `ORIGINAL ${index}`))
  }
  const before = foldTranscript(events)
  const beforeTools = before.filter(message => message.kind === 'tool')
  assert.equal(beforeTools.length, 13)
  // Every original gets a prune + replacement, at the tail of the log.
  for (let index = 0; index < 13; index += 1) {
    const callId = `call-${index}`
    events.push(rawEvent('compaction/prune', {
      shadowedRange: { start: originalSeqs[index]!, end: originalSeqs[index]! },
      shadowedSeqs: [originalSeqs[index]!],
      shadowedTokenCount: 100,
    }, seq++))
    events.push(pruneReplacement(seq++, callId, `PRUNED ${index}`, originalSeqs[index]!))
  }
  const after = foldTranscript(events)
  assert.deepEqual(kinds(after), kinds(before), 'transcript kinds must be identical before/after pruning')
  const afterTools = after.filter(message => message.kind === 'tool')
  assert.equal(afterTools.length, 13, 'no ghost tool cards after 13 prunes')
  afterTools.forEach((tool, index) => {
    assert.ok(tool !== undefined && tool.kind === 'tool')
    assert.equal(tool.result, `ORIGINAL ${index}`, `tool ${index} result must keep the append-origin text`)
  })
})

test('Test D: a replacement user/message does not enter the transcript', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    surfaceEvent('user/message', {
      id: MessageId('msg-orig'),
      role: 'user',
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }, 1, 'append'),
    // The summary compaction checkpoint replaces the range with one node.
    surfaceEvent('user/message', {
      id: MessageId('msg-summary'),
      role: 'user',
      content: [{ type: 'text', text: 'summary of earlier turns' }],
      source: { kind: 'user' },
    }, 2, { op: 'replace', start: 0, end: 1 }),
  ])
  assert.deepEqual(kinds(messages), ['user'], 'no user or system card for the replacement')
  const only = messages[0]
  assert.ok(only !== undefined && only.kind === 'user')
  assert.equal(only.text, 'original')
})

test('Test E: a replacement assistant/message does not enter the transcript', () => {
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    surfaceEvent('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-ans'),
        role: 'assistant',
        content: [{ type: 'text', text: 'the original answer' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 1, 'append'),
    surfaceEvent('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-ans2'),
        role: 'assistant',
        content: [{ type: 'text', text: 'rewritten answer' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 2, { op: 'replace', start: 1, end: 1 }),
  ])
  assert.deepEqual(kinds(messages), ['assistant'], 'no assistant card for the replacement')
  const only = messages[0]
  assert.ok(only !== undefined && only.kind === 'assistant')
  assert.equal(only.text, 'the original answer', 'the append-origin assistant history must not be overwritten')
})

test('Test F: legacy unmarked sessions keep their current behavior', () => {
  // tool/call + tool/result WITHOUT surfaceOp (a legacy Harness log).
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('legacy-1'), name: 'bash', arguments: '{}' }, 1),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-legacy'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('legacy-1'),
          content: [{ type: 'text', text: 'legacy result' }],
        }],
        source: { kind: 'tool', callId: ToolCallId('legacy-1') },
      },
    }, 2),
  ])
  assert.deepEqual(kinds(messages), ['tool'])
  const tool = messages[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.status, 'ok')
  assert.equal(tool.result, 'legacy result')
  // Legacy user/assistant messages without surfaceOp also survive.
  const legacyUser = foldTranscript([
    event('user/message', {
      id: MessageId('msg-lu'), role: 'user',
      content: [{ type: 'text', text: 'hello legacy' }],
      source: { kind: 'user' },
    }, 0),
  ])
  assert.deepEqual(kinds(legacyUser), ['user'])
})

test('Test G: cold replay and incremental replay agree on replacement logs', () => {
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('a1'), name: 'bash', arguments: '{}' }, 1),
    toolResult(2, 'a1', 'ORIGINAL'),
    rawEvent('compaction/prune', { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1 }, 3),
    pruneReplacement(4, 'a1', 'PRUNED', 2),
  ]
  const cold = foldTranscript(events)
  const folder = new TranscriptFolder()
  for (const eventOne of events) folder.apply([eventOne])
  const incremental = folder.messages()
  assert.deepEqual(incremental, cold, 'incremental replay must match the one-shot cold fold')
  // Windowing must agree too: a window containing the turn keeps one tool.
  const coldWindowed = foldTranscript(events, { maxTurns: 5 })
  const warmWindowed = folder.messages({ maxTurns: 5 })
  assert.deepEqual(warmWindowed, coldWindowed, 'windowed projections must match')
})

test('a replacement does not disturb consecutive-read grouping or the window summary', () => {
  const readResult = (seq: number, callId: string, text: string): SessionEvent => surfaceEvent('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq, 'append')
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    readResult(4, 'r2', 'bbb'),
  ]
  const before = foldTranscript(events)
  const beforeTools = before.filter(message => message.kind === 'tool')
  assert.equal(beforeTools.length, 1)
  assert.equal(beforeTools[0]?.args, '2 files')
  assert.ok((beforeTools[0]?.result ?? '').includes('aaa') && (beforeTools[0]?.result ?? '').includes('bbb'))
  // A prune replacement of the FIRST read lands after the pair.
  const after = foldTranscript([
    ...events,
    rawEvent('compaction/prune', { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1 }, 5),
    pruneReplacement(6, 'r1', 'aaa-pruned', 2),
  ])
  const afterTools = after.filter(message => message.kind === 'tool')
  assert.equal(afterTools.length, 1, 'the group must not gain a member')
  assert.equal(afterTools[0]?.args, '2 files', 'the group card must keep "2 files"')
  assert.ok((afterTools[0]?.result ?? '').includes('aaa') && (afterTools[0]?.result ?? '').includes('bbb'), 'the grouped result must keep both originals')
})

test('window summaries stay identical across a prune replacement', () => {
  const readResult = (seq: number, callId: string, text: string): SessionEvent => surfaceEvent('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq, 'append')
  // Three turns: turn 0 = one grouped read pair, turn 1 = a bash call,
  // turn 2 = a user prompt. A maxTurns=2 window collapses turn 0.
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    readResult(4, 'r2', 'bbb'),
    event('turn/start', { turn: 1 }, 5),
    event('tool/call', { turn: 1, step: 0, callId: ToolCallId('b1'), name: 'bash', arguments: '{}' }, 6),
    toolResult(7, 'b1', 'bash result'),
    event('turn/start', { turn: 2 }, 8),
    surfaceEvent('user/message', {
      id: MessageId('msg-9'), role: 'user',
      content: [{ type: 'text', text: 'newest question' }],
      source: { kind: 'user' },
    }, 9, 'append'),
  ]
  const before = foldTranscript(events, { maxTurns: 2 })
  const summary = before[0]
  assert.ok(summary !== undefined && summary.kind === 'summary', `expected a leading summary:\n${JSON.stringify(before)}`)
  assert.ok(summary.text.includes('1 earlier turn'), `summary text:\n${summary.text}`)
  assert.ok(summary.text.includes('1 tool call'), `summary must collapse the grouped read pair as ONE card:\n${summary.text}`)
  // A prune replacement of the first read lands at the tail (the original
  // accident's shape — the ghost card appears at the transcript tail).
  const after = foldTranscript([
    ...events,
    rawEvent('compaction/prune', { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1 }, 10),
    pruneReplacement(11, 'r1', 'aaa-pruned', 2),
  ], { maxTurns: 2 })
  assert.deepEqual(after, before, 'the windowed projection must be byte-identical after a replacement')
})

test('a late duplicate assistant/message updates text once per step', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('late-message-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'first' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 2),
    event('step/end', { turn: 0, step: 0 }, 3),
  ])
  const before = folder.turnActivity(0)
  assert.ok(before !== undefined)
  assert.equal(before.assistantMessages, 1)

  // The late authoritative replay arrives after step/end but before turn/end.
  folder.apply([event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('late-message-2'),
      role: 'assistant',
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    stream: [],
  }, 4)])

  const after = folder.turnActivity(0)
  assert.ok(after !== undefined)
  assert.equal(after.assistantMessages, 1, 'late replay must not inflate per-step activity')
  const messages = folder.messages()
  assert.equal(messages.length, 1)
  assert.ok(messages[0] !== undefined && messages[0].kind === 'assistant')
  assert.equal(messages[0]?.kind === 'assistant' ? messages[0].text : '', 'replacement')
})

test('a replacement assistant/message does not mutate Focus activity', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    surfaceEvent('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    }, 1, 'append'),
  ]
  folder.apply(events)
  const before = folder.turnActivity(0)
  assert.ok(before !== undefined)
  const beforeMessages = before.assistantMessages
  const beforeRevision = before.revision
  // A replacement assistant/message for the same step lands.
  folder.apply([surfaceEvent('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('msg-2'),
      role: 'assistant',
      content: [{ type: 'text', text: 'rewritten' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    stream: [],
  }, 2, { op: 'replace', start: 1, end: 1 })])
  const after = folder.turnActivity(0)
  assert.ok(after !== undefined)
  assert.equal(after.assistantMessages, beforeMessages, 'replacement must not bump assistantMessages')
  assert.equal(after.revision, beforeRevision, 'replacement must not bump the Focus revision')
  // And the transcript itself still holds the append-origin answer.
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['assistant'])
  const assistant = messages[0]
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.equal(assistant.text, 'first answer', 'append-origin assistant text must survive')
})

// ── Focus Message slot: bounded multiline tail (plan: the fold keeps
// the tail's line structure; the renderer wraps and shows the last rows) ──

test('the Message slot keeps a MULTILINE candidate tail (never flattened to one line)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'line one\nline two\nline three' }, 1_700_000_000_001))
  const activity = folder.turnActivity(0)
  assert.ok(activity !== undefined)
  assert.equal(activity.message?.text, 'line one\nline two\nline three',
    'syncMessage must preserve the multiline tail for the renderer')
})

test('a confirmed intermediate message keeps its bounded LATEST tail (multiline)', () => {
  const folder = new TranscriptFolder()
  const long = 'head\n' + 'x'.repeat(600) + '\ntail marker'
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: long }, 1_700_000_000_001))
  // A tool call confirms the candidate as an intermediate message.
  folder.apply([
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, 2),
  ])
  const activity = folder.turnActivity(0)
  assert.ok(activity !== undefined)
  const message = activity.message
  const length = message?.text.length ?? 0
  assert.ok(message?.text.endsWith('tail marker'), 'the confirmed slot keeps the newest content')
  assert.ok(message !== undefined && length <= 400,
    `the confirmed slot stays bounded to MESSAGE_TAIL_CAP (${length})`)
  assert.ok(message?.text.includes('\n'), 'the confirmed multiline structure survives')
})

test('a later authoritative message updates the correct step in place (multiline tail)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'streamed\nfragment' }, 1_700_000_000_001))
  folder.apply([
    event('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'settled\nmultiline\nanswer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 2),
  ])
  const activity = folder.turnActivity(0)
  assert.ok(activity !== undefined)
  assert.equal(activity.message?.text, 'settled\nmultiline\nanswer',
    'the authoritative text replaces the streamed tail in place')
})

test('a stale older step never resurrects the Message slot', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'step zero text' }, 1_700_000_000_001))
  folder.apply([
    event('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a0'), role: 'assistant', content: [{ type: 'text', text: 'step zero settled' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 2),
  ])
  folder.applyLiveInput(liveChunk(0, 1, { type: 'text-delta', index: 0, text: 'step one text' }, 1_700_000_000_003))
  folder.apply([
    event('assistant/message', {
      turn: 0, step: 1,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'step one settled' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 4),
  ])
  const before = folder.turnActivity(0)
  assert.ok(before !== undefined)
  assert.equal(before.message?.text, 'step one settled', 'the LATEST intermediate wins')
  // A late replay for the OLDER step must not roll the slot back.
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'stale replay' }, 1_700_000_000_005))
  const after = folder.turnActivity(0)
  assert.equal(after?.message?.text, 'step one settled', 'a stale older-step delta never resurrects the slot')
})

test('the final answer never enters the Message slot (multiline final included)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'final\nanswer\nlines' }, 1_700_000_000_001))
  folder.apply([
    event('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'final\nanswer\nlines' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
  ])
  const activity = folder.turnActivity(0)
  assert.ok(activity !== undefined)
  assert.equal(activity.message, undefined, 'a completed turn whose candidate IS the final leaves the slot empty')
})




// ── Session v2 failed-attempt transient lifecycle (P0-2) ────────────────

/** One live attempt OPEN frame (the neutral input, not the wire). */
function liveAttemptStart(turn: number, step: number) {
  return { kind: 'start' as const, sessionId: 'test', attemptId: 'attempt-x', turn, step }
}

/** One live attempt settlement frame (the neutral input, not the wire). */
function liveAttemptEnd(turn: number, step: number, status: 'committed' | 'abandoned', settlement?: 'message' | 'attempt') {
  return {
    kind: 'end' as const,
    sessionId: 'test',
    attemptId: 'attempt-x',
    turn,
    step,
    status,
    ...(settlement === undefined ? {} : { settlement }),
  }
}

function assistantMessageWithBlocks(
  seq: number,
  content: readonly ContentBlock[],
  opts: { turn?: number; step?: number; interrupted?: boolean } = {},
): SessionEvent {
  return event('assistant/message', {
    turn: opts.turn ?? 0,
    step: opts.step ?? 0,
    message: {
      id: MessageId(`a-${seq}`),
      role: 'assistant',
      content: [...content],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    ...(opts.interrupted === true ? { interrupted: true } : {}),
    stream: [],
  }, seq)
}

function assistantMessage(seq: number, text: string, opts: { turn?: number; step?: number } = {}): SessionEvent {
  return assistantMessageWithBlocks(seq, [{ type: 'text', text }], opts)
}

test('live block-end text is authoritative and survives durable settlement without duplication', () => {
  const onlyEnd = new TranscriptFolder()
  onlyEnd.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'complete from block-end' },
  }, 2))
  assert.deepEqual(onlyEnd.messages().filter(message => message.kind === 'assistant').map(message => message.text), ['complete from block-end'])

  const replacesDelta = new TranscriptFolder()
  replacesDelta.applyLiveInput(liveChunk(0, 0, { type: 'block-start', index: 0, blockType: 'text' as const }, 1))
  replacesDelta.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'partial' }, 2))
  replacesDelta.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'authoritative complete' },
  }, 3))
  assert.deepEqual(replacesDelta.messages().filter(message => message.kind === 'assistant').map(message => message.text), ['authoritative complete'])
  assert.equal(replacesDelta.turnActivity(0)?.message?.text, 'authoritative complete')

  const settles = new TranscriptFolder()
  settles.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'live complete' },
  }, 2))
  settles.apply([assistantMessage(3, 'durable complete')])
  // A late transient frame cannot roll the authoritative durable message back.
  settles.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'stale live text' },
  }, 4))
  assert.deepEqual(settles.messages().filter(message => message.kind === 'assistant').map(message => message.text), ['durable complete'])
})

test('live reasoning block-end restores the reasoning body and tool-call block-end stays non-surface', () => {
  const reasoning = new TranscriptFolder()
  reasoning.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'reasoning', text: 'authoritative reasoning' },
  }, 2))
  assert.deepEqual(reasoning.messages().filter(message => message.kind === 'thinking').map(message => message.text), ['authoritative reasoning'])
  assert.equal(reasoning.turnActivity(0)?.think?.text, 'authoritative reasoning')

  const tool = new TranscriptFolder()
  tool.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
  }, 2))
  assert.deepEqual(tool.messages(), [], 'a live assistant tool-call block is preview-only until its durable tool events settle')
})

test('live generic finalized blocks use the same Assistant visibility predicate', () => {
  const futureBlock = { type: 'future-block', payload: { revision: 1, value: 'live-kept' } } as unknown as AssistantLiveContentBlock
  const folder = new TranscriptFolder()
  folder.applyLiveInput(liveChunk(0, 0, {
    type: 'block-end',
    index: 0,
    block: futureBlock,
  }, 2))
  const assistant = folder.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.deepEqual(assistant.content, [futureBlock as unknown as ContentBlock])
})

test('settled Assistant rows follow block visibility while retaining empty authority', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    assistantMessageWithBlocks(1, [], { step: 0 }),
    assistantMessageWithBlocks(2, [{ type: 'text', text: '   ' }], { step: 1 }),
    assistantMessageWithBlocks(3, [{ type: 'reasoning', text: 'thinking only' }], { step: 2 }),
    assistantMessageWithBlocks(4, [{ type: 'tool-call', id: ToolCallId('call-message-only'), name: 'bash', arguments: '{}' }], { step: 3 }),
  ])
  assert.equal(folder.messages().filter(message => message.kind === 'assistant').length, 0)
  assert.equal(folder.messages({ maxTurns: 1 }).filter(message => message.kind === 'assistant').length, 0)
  assert.equal(folder.turnActivity(0)?.assistantMessages, 4)

  const toolRow = new TranscriptFolder()
  toolRow.apply([
    assistantMessageWithBlocks(6, [{ type: 'tool-call', id: ToolCallId('call-row'), name: 'bash', arguments: '{}' }], { step: 0 }),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('call-row'), name: 'bash', arguments: '{}' }, 7),
  ])
  assert.equal(toolRow.messages().filter(message => message.kind === 'assistant').length, 0)
  assert.equal(toolRow.messages().filter(message => message.kind === 'tool').length, 1)

  folder.apply([assistantMessageWithBlocks(5, [], { step: 4, interrupted: true })])
  const interrupted = folder.messages().filter(message => message.kind === 'assistant')
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0]?.interrupted, true)
})

test('partial text attempt evidence has no undefined prefix and matches cold replay', () => {
  const prefix = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ]
  const stream = [
    { type: 'chunk' as const, time: 2, chunk: { type: 'block-start' as const, index: 0, blockType: 'text' as const } },
    { type: 'chunk' as const, time: 3, chunk: { type: 'text-delta' as const, index: 0, text: 'partial' } },
  ]
  const suffix = [
    event('assistant/attempt', { turn: 0, step: 0, stream }, 4),
    event('step/end', { turn: 0, step: 0 }, 5),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 6),
  ]
  const live = new TranscriptFolder()
  live.apply(prefix)
  live.applyLiveInput(liveChunk(0, 0, { type: 'block-start', index: 0, blockType: 'text' as const }, 2))
  live.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'partial' }, 3))
  live.apply(suffix)
  const cold = new TranscriptFolder()
  cold.hydrate([...prefix, ...suffix])
  assert.deepEqual(live.messages(), cold.messages())
  const assistant = cold.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.equal(assistant.text, 'partial')
  assert.doesNotMatch(assistant.text, /undefined/)
  assert.equal(assistant.interrupted, true)
})

test('partial reasoning attempt evidence has no undefined prefix and matches cold replay', () => {
  const prefix = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ]
  const stream = [
    { type: 'chunk' as const, time: 2, chunk: { type: 'block-start' as const, index: 0, blockType: 'reasoning' as const } },
    { type: 'chunk' as const, time: 3, chunk: { type: 'reasoning-delta' as const, index: 0, text: 'thinking' } },
  ]
  const suffix = [
    event('assistant/attempt', { turn: 0, step: 0, stream }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5),
  ]
  const live = new TranscriptFolder()
  live.apply(prefix)
  live.applyLiveInput(liveChunk(0, 0, { type: 'block-start', index: 0, blockType: 'reasoning' as const }, 2))
  live.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: 'thinking' }, 3))
  live.apply(suffix)
  const cold = new TranscriptFolder()
  cold.hydrate([...prefix, ...suffix])
  assert.deepEqual(live.messages(), cold.messages())
  const thinking = cold.messages().find(message => message.kind === 'thinking')
  assert.ok(thinking !== undefined && thinking.kind === 'thinking')
  assert.equal(thinking.text, 'thinking')
  assert.doesNotMatch(thinking.text, /undefined/)
  assert.equal(thinking.running, false)
})

test('partial tool-call attempt evidence preserves id, name, and arguments across replay', () => {
  const callId = ToolCallId('call-partial')
  const prefix = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ]
  const stream = [
    { type: 'chunk' as const, time: 2, chunk: { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const } },
    { type: 'chunk' as const, time: 3, chunk: { type: 'tool-call-delta' as const, index: 0, id: callId, name: 'bash', argumentsDelta: '{"command":' } },
  ]
  const suffix = [
    event('assistant/attempt', { turn: 0, step: 0, stream }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5),
  ]
  const live = new TranscriptFolder()
  live.apply(prefix)
  live.applyLiveInput(liveChunk(0, 0, { type: 'block-start', index: 0, blockType: 'tool-call' as const }, 2))
  live.applyLiveInput(liveChunk(0, 0, { type: 'tool-call-delta', index: 0, id: callId, name: 'bash', argumentsDelta: '{"command":' }, 3))
  live.apply(suffix)
  const cold = new TranscriptFolder()
  cold.hydrate([...prefix, ...suffix])
  assert.deepEqual(live.messages(), cold.messages())
  const assistant = cold.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.equal(assistant.interrupted, true)
  const toolCall = assistant.content?.find(block => block.type === 'tool-call')
  assert.ok(toolCall !== undefined && toolCall.type === 'tool-call')
  assert.equal(toolCall.id, callId)
  assert.equal(toolCall.name, 'bash')
  assert.equal(toolCall.arguments, '{"command":')
  assert.doesNotMatch(toolCall.arguments, /undefined/)
})

test('image-only assistant attempts preserve live/cold parity and interruption evidence', () => {
  const image = {
    type: 'image' as const,
    attachment: {
      attachmentId: 'att-attempt-image' as never,
      mediaType: 'image/png',
      bytes: 100,
      width: 1920,
      height: 1080,
      name: 'attempt.png',
    },
  } as const
  const durableImage = image as unknown as ContentBlock
  const liveImage = image as unknown as AssistantLiveContentBlock
  const stream: AssistantStreamRecord[] = [{
    type: 'chunk',
    time: 2,
    chunk: { type: 'block-end', index: 0, block: durableImage },
  }]
  const prefix = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ]
  const attempt = event('assistant/attempt', { turn: 0, step: 0, stream }, 3)
  const end = event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 4)
  const live = new TranscriptFolder()
  live.apply(prefix)
  live.applyLiveInput(liveChunk(0, 0, { type: 'block-end', index: 0, block: liveImage }, 2))
  live.apply([attempt, end])
  const cold = new TranscriptFolder()
  cold.hydrate([...prefix, attempt, end])
  assert.deepEqual(live.messages(), cold.messages())
  const assistant = cold.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.equal(assistant.interrupted, true)
  assert.deepEqual(assistant.content, [durableImage])
  const assistantImage = assistant.content?.[0]
  assert.ok(assistantImage !== undefined && assistantImage.type === 'image')
  assert.deepEqual(assistantImage.attachment, image.attachment)
})

test('tool-call-only assistant attempts stay hidden until the closed boundary', () => {
  const callId = ToolCallId('call-delayed')
  const stream = [
    { type: 'chunk' as const, time: 2, chunk: { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const } },
    { type: 'chunk' as const, time: 3, chunk: { type: 'tool-call-delta' as const, index: 0, id: callId, name: 'bash', argumentsDelta: '{"command":"pwd"}' } },
  ]
  const prefix = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ]
  const attempt = event('assistant/attempt', { turn: 0, step: 0, stream }, 4)
  const folder = new TranscriptFolder()
  folder.apply([...prefix, attempt])
  assert.equal(folder.messages().some(message => message.kind === 'assistant'), false)
  const beforeRevision = folder.searchRevision()
  const beforeWindow = folder.window({ maxTurns: 1 })
  assert.equal(beforeWindow.messages.some(message => message.kind === 'assistant'), false)
  const stepEnd = event('step/end', { turn: 0, step: 0 }, 5)
  folder.apply([stepEnd])
  const afterStepEnd = folder.messages().find(message => message.kind === 'assistant')
  assert.ok(afterStepEnd !== undefined && afterStepEnd.kind === 'assistant')
  assert.equal(afterStepEnd.interrupted, true)
  assert.ok(folder.searchRevision() > beforeRevision)
  const afterWindow = folder.window({ maxTurns: 1 })
  assert.ok(afterWindow.messages.some(message => message.kind === 'assistant'))
  const end = event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 6)
  folder.apply([end])
  const cold = new TranscriptFolder()
  cold.hydrate([...prefix, attempt, stepEnd, end])
  assert.deepEqual(folder.messages(), cold.messages())
  const assistant = cold.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.equal(assistant.interrupted, true)
  const toolCall = assistant.content?.find(block => block.type === 'tool-call')
  assert.ok(toolCall !== undefined && toolCall.type === 'tool-call')
  assert.equal(toolCall.id, callId)
  assert.equal(toolCall.name, 'bash')
  assert.equal(toolCall.arguments, '{"command":"pwd"}')
})

test('generic finalized attempt blocks remain interruption evidence', () => {
  const futureBlock = { type: 'future-block', payload: { revision: 1, value: 'kept' } } as unknown as ContentBlock
  const stream: AssistantStreamRecord[] = [{
    type: 'chunk',
    time: 2,
    chunk: { type: 'block-end', index: 0, block: futureBlock },
  }]
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('assistant/attempt', { turn: 0, step: 0, stream }, 1),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 2),
  ])
  const assistant = folder.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined && assistant.kind === 'assistant')
  assert.equal(assistant.interrupted, true)
  assert.deepEqual(assistant.content, [futureBlock])
})

test('a durable assistant/attempt with only block-end evidence reopens as interrupted content', () => {
  const stream = [{
    type: 'chunk' as const,
    time: 2,
    chunk: {
      type: 'block-end' as const,
      index: 0,
      block: { type: 'text' as const, text: 'attempt block-end evidence' },
    },
  }]
  const folder = new TranscriptFolder()
  folder.apply([
    event('assistant/attempt', { turn: 0, step: 0, stream }, 0),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1),
  ])
  const interrupted = folder.messages().filter(message => message.kind === 'assistant')
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0]?.text, 'attempt block-end evidence')
  assert.equal(interrupted[0]?.interrupted, true)
})

test('a durable assistant/attempt remains interruption evidence until turn end (live == reopen)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'hello wor' }, 2))
  assert.deepEqual(kinds(folder.messages()), ['assistant'], 'streaming text is visible while the attempt runs')
  const failedStream = [
    { type: 'text-chunks' as const, time0: 1, index: 0, dt: [], texts: ['durable prefix'] },
    { type: 'reasoning-chunks' as const, time0: 2, index: 1, dt: [1], texts: ['durable ', 'diagnostic'] },
    { type: 'chunk' as const, time: 4, chunk: { type: 'usage' as const, usage: { inputTokens: 120, outputTokens: 7 } } },
  ]
  folder.apply([event('assistant/attempt', { turn: 0, step: 0, stream: failedStream }, 3)])
  assert.deepEqual(folder.messages().filter(message => message.kind === 'assistant').map(message => message.text), ['durable prefix'],
    'a committed attempt preserves its durable assistant evidence while the turn is open')
  assert.deepEqual(folder.messages().filter(message => message.kind === 'thinking').map(message => message.text), ['durable diagnostic'])
  assert.deepEqual(folder.turnActivity(0)?.usage, { inputTokens: 120, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(folder.turnActivity(0)?.totalTokens, 127)
  assert.equal(folder.turnActivity(0)?.think?.text, 'durable diagnostic')
  folder.apply([event('step/end', { turn: 0, step: 0 }, 4), event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5)])
  const interrupted = folder.messages().filter(message => message.kind === 'assistant')
  assert.equal(interrupted.length, 1, 'closed attempt evidence remains visible as an interrupted prefix')
  assert.equal(interrupted[0]?.interrupted, true, 'turn/end marks attempt evidence interrupted')
  // Reopen: a cold replay removes only surface text and keeps diagnostic reasoning.
  const reopened = new TranscriptFolder()
  reopened.hydrate([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/attempt', { turn: 0, step: 0, stream: failedStream }, 3),
    event('step/end', { turn: 0, step: 0 }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5),
  ])
  const reopenedInterrupted = reopened.messages().filter(message => message.kind === 'assistant')
  assert.equal(reopenedInterrupted.length, 1, 'cold replay restores the interrupted attempt evidence')
  assert.equal(reopenedInterrupted[0]?.interrupted, true, 'cold replay preserves interruption metadata')
  assert.deepEqual(reopened.messages().filter(message => message.kind === 'thinking').map(message => message.text), ['durable diagnostic'])
  assert.deepEqual(reopened.turnActivity(0)?.usage, { inputTokens: 120, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(reopened.turnActivity(0)?.totalTokens, 127)
  assert.equal(reopened.turnActivity(0)?.think?.text, 'durable diagnostic')
})

test('an ABANDONED live end removes the transient text (no durable settlement exists)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'partial' }, 2))
  folder.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: 'transient thought' }, 3))
  folder.applyLiveInput(liveChunk(0, 0, { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } }, 4))
  folder.applyLiveInput(liveAttemptEnd(0, 0, 'abandoned'))
  assert.deepEqual(folder.messages(), [], 'abandoned output and reasoning never stay on the surface')
  const activity = folder.turnActivity(0)
  assert.equal(activity?.message, undefined)
  assert.equal(activity?.think, undefined)
  assert.equal(activity?.usage, undefined)
  assert.equal(activity?.totalTokens, undefined)
})

test('a retry never concatenates: the durable message carries only the retry text', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'hello wor' }, 2)) // attempt A
  folder.apply([event('assistant/attempt', { turn: 0, step: 0, stream: [] }, 3)]) // A failed
  folder.apply([rawEvent('llm/retry', {
    retryId: 'retry-transcript', turn: 0, step: 0, provider: 'p', mode: 'normal',
    policyKey: 'test', retry: 1, maxRetries: 2, delayMs: 0,
    failure: { message: 'failed', code: 'TEST' },
  }, 3.5)])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'final answer' }, 4)) // attempt B
  const streaming = folder.messages().filter(message => message.kind === 'assistant')
  assert.equal(streaming.length, 1)
  assert.ok(streaming[0] !== undefined && streaming[0].kind === 'assistant')
  assert.equal(streaming[0].text, 'final answer', 'B starts from an empty entry — never "hello worfinal answer"')
  folder.apply([assistantMessage(5, 'final answer'), event('step/end', { turn: 0, step: 0 }, 6), event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 7)])
  const settled = folder.messages().filter(message => message.kind === 'assistant')
  assert.equal(settled.length, 1)
  assert.ok(settled[0] !== undefined && settled[0].kind === 'assistant')
  assert.equal(settled[0].text, 'final answer')
  // Reopen parity: the same durable log replays to the same single message.
  const reopened = new TranscriptFolder()
  reopened.hydrate([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/attempt', { turn: 0, step: 0, stream: [] }, 3),
    assistantMessage(5, 'final answer'),
    event('step/end', { turn: 0, step: 0 }, 6),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 7),
  ])
  const replayed = reopened.messages()
  assert.equal(replayed.length, 1)
  assert.ok(replayed[0] !== undefined && replayed[0].kind === 'assistant')
  assert.equal(replayed[0].text, 'final answer', 'reopen shows exactly the retry, never the failed prefix')
})

test('a retry-started durable message replaces prior reasoning, including no reasoning', () => {
  const attemptA = event('assistant/attempt', {
    turn: 0,
    step: 0,
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'A reasoning' } }],
  }, 2)
  const retry = event('llm/retry-started', { retryId: 'retry-message' as RetryId, turn: 0, step: 0, retry: 1 }, 3)
  const messageB = event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('retry-message-b'),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'B reasoning' },
        { type: 'text', text: 'answer' },
      ],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, 4)
  const noReasoningB = event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('retry-message-empty-reasoning'),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, 5)
  const folder = new TranscriptFolder()
  folder.hydrate([event('turn/start', { turn: 0 }, 0), attemptA, retry, messageB])
  assert.deepEqual(folder.messages().filter(message => message.kind === 'thinking').map(message => message.text), ['B reasoning'])
  assert.equal(folder.turnActivity(0)?.think?.text, 'B reasoning')
  folder.apply([noReasoningB])
  assert.deepEqual(folder.messages().filter(message => message.kind === 'thinking'), [])
  assert.equal(folder.turnActivity(0)?.think, undefined)
})

test('a committed MESSAGE settlement never removes text — the durable message owns the entry', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'streamed' }, 2))
  // The durable message lands (event plane) BEFORE the committed end frame.
  folder.apply([assistantMessage(3, 'authoritative')])
  folder.applyLiveInput(liveAttemptEnd(0, 0, 'committed', 'message'))
  const messages = folder.messages()
  assert.equal(messages.length, 1)
  assert.ok(messages[0] !== undefined && messages[0].kind === 'assistant')
  assert.equal(messages[0].text, 'authoritative', 'the settled message text survives the end frame')
})

test('failed-attempt reasoning resets on retry and matches a cold replay', () => {
  const durable = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'attempt A reasoning' } }] }, 3),
    event('llm/retry-started', { retryId: 'retry-1' as RetryId, turn: 0, step: 0, retry: 1 }, 4),
    event('assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'attempt B reasoning' } }] }, 5),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5),
  ]
  const reopened = new TranscriptFolder()
  reopened.hydrate(durable)
  const coldThinking = reopened.messages().filter(message => message.kind === 'thinking')
  assert.equal(coldThinking.length, 1)
  assert.ok(coldThinking[0] !== undefined && coldThinking[0].kind === 'thinking')
  assert.equal(coldThinking[0].text, 'attempt B reasoning', 'a retry REPLACES the failed attempt\'s reasoning on replay')

  const live = new TranscriptFolder()
  live.apply([event('turn/start', { turn: 0 }, 0), event('step/start', { turn: 0, step: 0 }, 1)])
  live.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: 'attempt A reasoning' }, 2))
  live.apply([event('assistant/attempt', { turn: 0, step: 0, stream: [] }, 3)]) // A fails; reasoning closed
  live.applyLiveInput(liveAttemptStart(0, 0)) // B opens: resets the closed attempt's reasoning
  live.applyLiveInput(liveChunk(0, 0, { type: 'reasoning-delta', index: 0, text: 'attempt B reasoning' }, 4)) // B retry
  live.apply([event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5)])
  const liveThinking = live.messages().filter(message => message.kind === 'thinking')
  assert.equal(liveThinking.length, 1)
  assert.ok(liveThinking[0] !== undefined && liveThinking[0].kind === 'thinking')
  assert.equal(liveThinking[0].text, 'attempt B reasoning', 'the retry reset the failed attempt\'s reasoning text')
})
