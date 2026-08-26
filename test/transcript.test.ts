/**
 * Unit tests for the transcript folding: session events → renderable
 * messages, with streaming chunk accumulation and tool call pairing.
 * Pure functions, no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/transcript.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTranscript, TranscriptFolder, windowMessages, type TranscriptMessage } from '../src/transcript.ts'

/** Build a minimal event envelope for tests. */
function event<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** Build an event with loosely-typed data (plugin-extension event tests). */
function rawEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
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
  const first = messages[0]
  assert.ok(first !== undefined && first.kind === 'user')
  assert.equal(first.text, 'hello')
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
  const first = messages[0]
  assert.ok(first !== undefined && first.kind === 'assistant')
  assert.equal(first.text, 'Hello world')
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
  const first = messages[0]
  assert.ok(first !== undefined && first.kind === 'assistant')
  assert.equal(first.text, 'partial')
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
  assert.equal(tool.result, 'AUTH: boom')
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
    event('tool/call', { turn: 0, step: 0, callId: CallId('call-1'), name: 'bash', arguments: '{"cmd":"one"}' }, 1),
    event('tool/call', { turn: 0, step: 0, callId: CallId('call-2'), name: 'bash', arguments: '{"cmd":"two"}' }, 2),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-a'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'out-one' }],
        }],
        source: { kind: 'tool', callId: CallId('call-1') },
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
          toolCallId: CallId('call-2'),
          content: [{ type: 'text', text: 'out-two' }],
        }],
        source: { kind: 'tool', callId: CallId('call-2') },
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
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    chunk(1, 0, { type: 'text-delta', index: 0, text: 'Hel' }),
    chunk(2, 0, { type: 'reasoning-delta', index: 0, text: 't0-' }),
    chunk(3, 0, { type: 'text-delta', index: 0, text: 'lo' }),
    chunk(4, 1, { type: 'text-delta', index: 0, text: 'x' }),
    chunk(5, 1, { type: 'reasoning-delta', index: 0, text: 't1-' }),
    chunk(6, 1, { type: 'text-delta', index: 0, text: 'y' }),
    // Step 0's reasoning continues AFTER step 1 started: it must update the
    // step-0 thinking entry, not the step-1 one (last-entry assumption bug).
    chunk(7, 0, { type: 'reasoning-delta', index: 0, text: 'more' }),
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

test('windows older turns into one summary entry', () => {
  const events: SessionEvent[] = [
    // Turn 0: user prompt + tool call + result.
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('msg-0'), role: 'user',
      content: [{ type: 'text', text: 'q0' }],
      source: { kind: 'user' },
    }, 1),
    event('tool/call', { turn: 0, step: 0, callId: CallId('call-0'), name: 'bash', arguments: '{}' }, 2),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('msg-1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('call-0'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('call-0') },
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
    event('tool/call', { turn: 1, step: 0, callId: CallId('call-1'), name: 'read', arguments: '{}' }, 1),
    event('tool/result', {
      turn: 1, step: 0,
      message: { id: MessageId('msg-1'), role: 'user', content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'a' }] }], source: { kind: 'tool', callId: CallId('call-1') } },
    }, 2),
    event('turn/start', { turn: 2 }, 3),
    event('tool/call', { turn: 2, step: 0, callId: CallId('call-2'), name: 'read', arguments: '{}' }, 4),
    event('tool/result', {
      turn: 2, step: 0,
      message: { id: MessageId('msg-2'), role: 'user', content: [{ type: 'tool-result', toolCallId: CallId('call-2'), content: [{ type: 'text', text: 'b' }] }], source: { kind: 'tool', callId: CallId('call-2') } },
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
  assert.equal(JSON.stringify(fast), JSON.stringify(full),
    `the fast window must match the full scan:\n${JSON.stringify(fast)}\nvs\n${JSON.stringify(full)}`)
  const summary = fast[0]
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.ok(summary.text.includes('1 earlier turn'), `summary text:\n${summary.text}`)
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
    events.push(event('tool/call', { turn, step: 0, callId: CallId(`call-${seq}`), name: 'read', arguments: '{}' }, seq++))
    events.push(event('tool/result', {
      turn, step: 0,
      message: { id: MessageId(`msg-${seq}`), role: 'user', content: [{ type: 'tool-result', toolCallId: CallId(`call-${seq}`), content: [{ type: 'text', text: 'file' }] }], source: { kind: 'tool', callId: CallId(`call-${seq}`) } },
    }, seq++))
  }
  const tool = (turn: number): void => {
    events.push(event('tool/call', { turn, step: 0, callId: CallId(`call-${seq}`), name: 'bash', arguments: '{}' }, seq++))
    events.push(event('tool/result', {
      turn, step: 0,
      message: { id: MessageId(`msg-${seq}`), role: 'user', content: [{ type: 'tool-result', toolCallId: CallId(`call-${seq}`), content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: CallId(`call-${seq}`) } },
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
    const full = windowMessages(folder.messages(), maxTurns)
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
    events.push(event('tool/call', { turn, step: 0, callId: CallId(`call-${turn}`), name: 'read', arguments: '{}' }, seq++))
    events.push(event('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId(`msg-${turn}`), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId(`call-${turn}`), content: [{ type: 'text', text: 'file' }] }],
        source: { kind: 'tool', callId: CallId(`call-${turn}`) },
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
  folder.apply([event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }, 1)])
  const first = folder.messages()
  assert.equal(first.length, 1)
  folder.apply([event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'lo' } }, 2)])
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
        toolCallId: CallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: CallId(callId) },
    },
  }, seq)
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: CallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: CallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    readResult(4, 'r2', 'bbb'),
    // A non-read breaks the group.
    event('tool/call', { turn: 0, step: 0, callId: CallId('b1'), name: 'bash', arguments: '{}' }, 5),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('msg-6'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('b1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('b1') },
      },
    }, 6),
    event('tool/call', { turn: 0, step: 0, callId: CallId('r3'), name: 'read', arguments: '{"file":"c.ts"}' }, 7),
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
      content: [{ type: 'tool-result', toolCallId: CallId(callId), content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId: CallId(callId) },
    },
  }, seq)
  // Two reads in DIFFERENT turns, applied incrementally.
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: CallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
  ])
  folder.apply([
    event('turn/start', { turn: 1 }, 3),
    event('tool/call', { turn: 1, step: 0, callId: CallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 4),
    readResult(5, 'r2', 'bbb'),
  ])
  const tools = folder.messages().filter(message => message.kind === 'tool')
  assert.equal(tools.length, 1, 'grouping ignores turn boundaries (same as the one-shot pass)')
  assert.equal(tools[0]?.args, '2 files')
  assert.ok((tools[0]?.result ?? '').includes('aaa') && (tools[0]?.result ?? '').includes('bbb'))
})

test('a failed read breaks the group; a read settling late re-groups into the run', () => {
  const readResult = (seq: number, callId: string, text: string, isError = false): SessionEvent => event('tool/result', {
    turn: 0,
    step: 0,
    ...isError ? { error: { name: 'read-failed', code: 'read-failed' } } : {},
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: CallId(callId), content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId: CallId(callId) },
    },
  }, seq)
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: CallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    // r2 FAILS: the run breaks even though the card is named read.
    event('tool/call', { turn: 0, step: 0, callId: CallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    readResult(4, 'r2', 'bbb', true),
    // r3 is called but its result lands LATE (after the next turn started).
    event('tool/call', { turn: 0, step: 0, callId: CallId('r3'), name: 'read', arguments: '{"file":"c.ts"}' }, 5),
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
    event('tool/call', { turn: 0, step: 0, callId: CallId('r1'), name: 'read', arguments: '{"file":"a.ts"}' }, 1),
    readResult(2, 'r1', 'aaa'),
    event('tool/call', { turn: 0, step: 0, callId: CallId('r2'), name: 'read', arguments: '{"file":"b.ts"}' }, 3),
    event('turn/start', { turn: 1 }, 4),
  ])
  folder2.apply([readResult(5, 'r2', 'bbb')])
  const tail = folder2.messages().filter(message => message.kind === 'tool')
  assert.equal(tail.length, 1, 'a late result merges the tail read into the group')
  assert.equal(tail[0]?.args, '2 files')
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
      policyKey: 'k', retry: 0, maxRetries: 2, delayMs: 3000,
      failure: { message: 'boom', code: 'RATE_LIMITED' },
    }, 1),
  ])
  assert.deepEqual(kinds(messages), ['system'])
  const entry = messages[0]
  assert.ok(entry !== undefined && entry.kind === 'system')
  assert.ok(entry.text.includes('llm retry 1/2 in 3s'), `text:\n${entry.text}`)
  assert.ok(entry.text.includes('RATE_LIMITED'), `text:\n${entry.text}`)
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
  const messages = foldTranscript([
    event('turn/start', { turn: 0 }, 0),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }, 1),
  ])
  const thinking = messages[0]
  assert.ok(thinking !== undefined && thinking.kind === 'thinking')
  assert.equal(thinking.running, true, 'streaming thinking must be running')
  const settled = foldTranscript([
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
    }, 2),
  ])
  const done = settled[0]
  assert.ok(done !== undefined && done.kind === 'thinking')
  assert.equal(done.running, false, 'the step message must settle its thinking entry')
})

test('an interrupted turn settles every live thinking entry', () => {
  const messages = foldTranscript([
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
    event('tool/call', { turn: 0, step: 0, callId: CallId('call-1'), name: 'read', arguments: '{"file_path":"/ws/src/foo.ts"}' }, 0),
    event('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('msg-3'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'hi' }],
        }],
        source: { kind: 'tool', callId: CallId('call-1') },
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



