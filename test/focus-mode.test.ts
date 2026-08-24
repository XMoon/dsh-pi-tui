/**
 * Focus Mode unit tests: TurnActivity V2 aggregation (think / message
 * candidate+confirmed / tool semantic slot / per-turn usage), the Focus
 * presentation projection, the whale header + three-slot body formatters,
 * and the dynamic system-prompt section. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/focus-mode.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import {
  FOCUS_MODE_PROMPT,
  FOCUS_SECTION_NAME,
  FOCUS_SECTION_ORDER,
  focusModeOf,
  installFocusPrompt,
} from '../src/focus.ts'
import {
  FOCUS_TOOL_SUMMARY_MAX_TYPES,
  FocusActivityComponent,
  focusCollapsedBody,
  focusDisclosureIcon,
  focusDurationText,
  focusStatusLabel,
  focusToolStatParts,
  formatFocusDuration,
  formatFocusHeaderLine,
  projectFocus,
  type FocusProjectedBlock,
} from '../src/focus-activity.ts'
import { focusToolDisplay, toolPresenterFrom, type ToolPresenter } from '../src/present.ts'
import { formatTokens, totalTokens } from '../src/token-usage.ts'

/** Build an event with an EXPLICIT time (Focus timing tests need control). */
function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** Build an event with the default time = 1.7e12 + seq. */
function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return eventAt(type, data, 1_700_000_000_000 + seq, seq)
}

/** One full completed turn: user → thinking → tool call/result → assistant → end. */
function completedTurn(turn: number, baseSeq: number, startTime: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn }, startTime, baseSeq),
    eventAt('user/message', {
      id: MessageId(`msg-u-${turn}`),
      role: 'user',
      content: [{ type: 'text', text: `prompt ${turn}` }],
      source: { kind: 'user' },
    }, startTime + 1, baseSeq + 1),
    eventAt('assistant/chunk', {
      turn,
      step: 0,
      chunk: { type: 'reasoning-delta', index: 0, text: 'checking the transcript path…' },
    }, startTime + 2, baseSeq + 2),
    eventAt('tool/call', {
      turn,
      step: 0,
      callId: CallId(`call-${turn}-1`),
      name: 'read',
      arguments: JSON.stringify({ path: 'src/transcript.ts' }),
    }, startTime + 3, baseSeq + 3),
    eventAt('tool/result', {
      turn,
      step: 0,
      message: {
        id: MessageId(`msg-r-${turn}`),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: CallId(`call-${turn}-1`),
          content: [{ type: 'text', text: 'ok' }],
        }],
        source: { kind: 'tool', callId: CallId(`call-${turn}-1`) },
      },
    }, startTime + 4, baseSeq + 4),
    eventAt('assistant/message', {
      turn,
      step: 1,
      message: {
        id: MessageId(`msg-a-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `final answer ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, startTime + 5, baseSeq + 5),
    eventAt('turn/end', { turn, reason: { kind: 'completed' } }, startTime + 6000, baseSeq + 6),
  ]
}

/** A turn with an intermediate message confirmed by a tool call, then a
 * final answer: text → tool/call → tool/result → text → turn/end. */
function intermediateTurn(turn: number, baseSeq: number, startTime: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn }, startTime, baseSeq),
    eventAt('assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', index: 0, text: '我先检查文件' } }, startTime + 1, baseSeq + 1),
    eventAt('tool/call', { turn, step: 0, callId: CallId('c-i1'), name: 'read', arguments: JSON.stringify({ path: 'a.ts' }) }, startTime + 2, baseSeq + 2),
    eventAt('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId('r-i1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c-i1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c-i1') },
      },
    }, startTime + 3, baseSeq + 3),
    eventAt('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: '最终答案是…' } }, startTime + 4, baseSeq + 4),
    eventAt('assistant/message', {
      turn, step: 1,
      message: {
        id: MessageId('a-i1'), role: 'assistant',
        content: [{ type: 'text', text: '最终答案是…' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, startTime + 5, baseSeq + 5),
    eventAt('turn/end', { turn, reason: { kind: 'completed' } }, startTime + 6000, baseSeq + 6),
  ]
}

/** The kinds of the projected blocks, in order ('activity' for Thought). */
function blockKinds(blocks: readonly FocusProjectedBlock[]): string[] {
  return blocks.map(block => block.kind === 'activity' ? 'activity' : block.message.kind)
}

// ── settings normalization (plan §6) ─────────────────────────────────────

test('focusModeOf normalizes persisted values defensively', () => {
  assert.equal(focusModeOf('on'), 'on')
  assert.equal(focusModeOf('off'), 'off')
  assert.equal(focusModeOf(undefined), 'off')
  assert.equal(focusModeOf(''), 'off')
  assert.equal(focusModeOf('yes'), 'off')
  assert.equal(focusModeOf('ON'), 'off')
})

// ── TurnActivity V2 aggregation ─────────────────────────────────────────

test('aggregates turn timing, tool stats and the Think slot from events', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(1, 0, 1000))
  const activity = folder.turnActivity(1)
  assert.ok(activity !== undefined)
  assert.equal(activity.startedAt, 1000)
  assert.equal(activity.endedAt, 7000)
  assert.equal(activity.completed, true)
  assert.equal(activity.reason?.kind, 'completed')
  assert.equal(activity.toolCalls, 1)
  assert.equal(activity.tools.get('read'), 1)
  assert.equal(activity.assistantMessages, 1)
  // The Think slot: the latest meaningful line of the reasoning tail.
  assert.equal(activity.think?.text, 'checking the transcript path…')
  // The Tool slot: the latest raw call, settled by its own result.
  assert.equal(activity.tool?.name, 'read')
  assert.equal(activity.tool?.status, 'ok')
  assert.equal(activity.tool?.args, JSON.stringify({ path: 'src/transcript.ts' }))
  // The activity revision moved with every event.
  assert.ok(activity.revision > 0)
})

test('tool/result never double-counts a call; same-name calls accumulate', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    eventAt('turn/start', { turn: 3 }, 1000, 0),
    eventAt('tool/call', { turn: 3, step: 0, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 1001, 1),
    eventAt('tool/result', {
      turn: 3, step: 0,
      message: {
        id: MessageId('m1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, 1002, 2),
    eventAt('tool/call', { turn: 3, step: 0, callId: CallId('c2'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm typecheck' }) }, 1003, 3),
    eventAt('tool/result', {
      turn: 3, step: 0,
      message: {
        id: MessageId('m2'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c2'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c2') },
      },
    }, 1004, 4),
    eventAt('tool/call', { turn: 3, step: 0, callId: CallId('c3'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm lint' }) }, 1005, 5),
  ]
  folder.apply(events)
  const activity = folder.turnActivity(3)!
  assert.equal(activity.toolCalls, 3, 'tool/result must not double-count')
  assert.equal(activity.tools.get('bash'), 3)
  assert.equal(activity.tools.get('read'), undefined)
  // The Tool slot is the still-running latest call.
  assert.equal(activity.tool?.name, 'bash')
  assert.equal(activity.tool?.status, 'running')
})

// ── Message candidate / confirmed state machine (plan §5) ──────────────

test('running text-delta feeds the Message slot immediately (no assistant/message wait)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '我先检查 provider registry。' } }, 1001, 1),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message?.text, '我先检查 provider registry。')
  assert.equal(activity.think, undefined, 'no reasoning → no Think slot')
})

test('an intermediate message is confirmed by a later tool/call and survives settle', () => {
  const folder = new TranscriptFolder()
  folder.apply(intermediateTurn(0, 0, 1000))
  const activity = folder.turnActivity(0)!
  // The final answer is NOT duplicated into the Message slot: the
  // confirmed intermediate message wins (plan §5.6).
  assert.equal(activity.message?.text, '我先检查文件')
  assert.notEqual(activity.message?.text, '最终答案是…')
})

test('only-final turns show NO Message slot (the final stays outside)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '答案是…' } }, 1001, 1),
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: '答案是…' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1002, 2),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1003, 3),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message, undefined, 'the final answer must never enter the Message slot')
})

test('an interrupted streaming candidate survives turn/end (process information)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '正在分析配置…' } }, 1001, 1),
    eventAt('turn/end', { turn: 0, reason: { kind: 'interrupted' } }, 2000, 2),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message?.text, '正在分析配置…', 'an interrupted candidate is still process information')
})

test('a later step start confirms the earlier candidate (plan §5.3 B)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '第一步说明' } }, 1001, 1),
    eventAt('step/start', { turn: 0, step: 1 }, 1002, 2),
    eventAt('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: '第二步说明' } }, 1003, 3),
    eventAt('assistant/message', {
      turn: 0, step: 1,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: '第二步说明' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  // Step 0's candidate was confirmed by step/start; step 1's candidate is
  // the final answer and must NOT enter the slot.
  assert.equal(activity.message?.text, '第一步说明')
})

test('assistant/message settles the candidate text authoritatively (plan §5.4)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'partial stream' } }, 1001, 1),
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'authoritative text' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1002, 2),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c'), name: 'bash', arguments: '{}' }, 1003, 3),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1004, 4),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message?.text, 'authoritative text', 'the settled text must replace the streaming tail')
})

// ── Tool semantic classification (plan §6/§7/§8) ────────────────────────

test('ANY tool/call is a Tool — skill included (event-first classification)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c1'), name: 'skill', arguments: JSON.stringify({ name: 'session-review' }) }, 1001, 1),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.toolCalls, 1)
  assert.equal(activity.tools.get('skill'), 1)
  assert.equal(activity.tool?.name, 'skill')
  assert.equal(activity.tool?.status, 'running')
  // The compact display: presenter-first, fallback-second — both say the
  // same semantic (plan §9.2/§28).
  assert.equal(focusToolDisplay(activity.tool!, {}), 'Load skill session-review')
})

test('an unknown custom tool is still a Tool (never a Message/System/nothing)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c1'), name: 'vendor_probe', arguments: JSON.stringify({ host: 'cache-01' }) }, 1001, 1),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.toolCalls, 1)
  assert.equal(activity.tool?.name, 'vendor_probe')
  assert.equal(activity.tool?.status, 'running')
  assert.equal(focusToolDisplay(activity.tool!, {}), 'vendor_probe cache-01')
})

test('user-explicit /skill invocation and skill-catalog injection are NOT Tools', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('user/message', {
      id: MessageId('s1'), role: 'user',
      content: [{ type: 'text', text: '<skill_content>…</skill_content>' }],
      source: { kind: 'skill-invocation', name: 'session-review' },
    }, 1001, 1),
    eventAt('user/message', {
      id: MessageId('s2'), role: 'user',
      content: [{ type: 'text', text: '<system-reminder>…</system-reminder>' }],
      source: { kind: 'skill-catalog' },
    }, 1002, 2),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.toolCalls, 0, 'injections must never count as tool calls')
  assert.equal(activity.tool, undefined, 'injections must never occupy the Tool slot')
  assert.equal(activity.message, undefined, 'injections must never occupy the Message slot')
  // The context rows still fold into the transcript (expanded view).
  const kinds = folder.messages().map(message => message.kind)
  assert.equal(kinds.filter(kind => kind === 'system').length, 2)
})

test('parallel tool results never yank the Tool slot back to an older call (plan §10/§44)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('A'), name: 'read', arguments: JSON.stringify({ path: 'a.ts' }) }, 1001, 1),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('B'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 1002, 2),
    eventAt('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('rA'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('A'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('A') },
      },
    }, 1003, 3),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.tool?.name, 'bash', 'the LATEST call owns the slot')
  assert.equal(activity.tool?.status, 'running', 'an older result must not settle the latest slot')
  // The matching result settles it.
  folder.apply([eventAt('tool/result', {
    turn: 0, step: 0,
    message: {
      id: MessageId('rB'), role: 'user',
      content: [{ type: 'tool-result', toolCallId: CallId('B'), content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', callId: CallId('B') },
    },
  }, 1004, 4)])
  assert.equal(activity.tool?.status, 'ok')
})

test('an empty assistant/message without a prior chunk still owns the final slot (no earlier fallback)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // step 1: 'final answer text'
    // The exact last assistant/message is EMPTY and has no preceding chunk.
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('empty'), role: 'assistant', content: [{ type: 'text', text: '' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1000 + 11, 21),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1000 + 12, 22),
  ])
  const messages = folder.messages()
  const last = messages.findLast(m => m.kind === 'assistant')
  assert.ok(last !== undefined && last.kind === 'assistant' && last.text === '',
    'the empty message must be preserved as the exact last assistant')
  const blocks = projectFocus(messages, folder.turnActivities(), new Set(), true)
  assert.ok(!blocks.some(b => b.kind === 'message' && b.message.kind === 'assistant'),
    'an empty last step must suppress the final — never fall back to the earlier text assistant')
})

test('later provisional usage chunks REPLACE the earlier one (latest wins, plan §13.2)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('step/start', { turn: 0, step: 0 }, 1001, 1),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1002, 2),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 150, outputTokens: 0 } } }, 1003, 3),
    eventAt('step/end', { turn: 0, step: 0 }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 150, 'the LATEST provisional chunk wins (never the stale first)')
})

test('an orphan tool/result never settles a running card of ANOTHER turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' }, 1001, 1),
    // An orphan result (unknown callId) for turn 2 with the same name.
    eventAt('tool/result', {
      turn: 2, step: 0,
      message: {
        id: MessageId('r'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('unknown'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('unknown') },
      },
    }, 1002, 2),
  ])
  const cards = folder.messages().filter((m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool')
  const turn1 = cards.find(c => c.turn === 1)
  assert.ok(turn1 !== undefined && turn1.status === 'running', 'turn 1\'s running card must stay running')
  assert.ok(cards.some(c => c.turn === 2 && c.status === 'ok'), 'the orphan result appends its own turn-2 card')
})

test('an orphan tool/result attributes to its OWN turn, never the stale current turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' }, 1001, 1),
    // A result for an UNKNOWN call, from turn 2 (replay fragment): the
    // orphan card must carry turn 2, and turn 1's slot must stay running.
    eventAt('tool/result', {
      turn: 2, step: 0,
      message: {
        id: MessageId('r'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('unknown'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('unknown') },
      },
    }, 1002, 2),
  ])
  const activity = folder.turnActivity(1)!
  assert.equal(activity.tool?.status, 'running', 'an orphan result must not settle another turn\'s slot')
  const cards = folder.messages().filter(m => m.kind === 'tool')
  assert.ok(cards.some(c => c.turn === 2 && c.name === 'tool'), 'the orphan result card must carry its own turn')
})

test('step/end commits the open step usage and clears the pending state', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('step/start', { turn: 0, step: 0 }, 1001, 1),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1002, 2),
    eventAt('step/end', { turn: 0, step: 0 }, 1003, 3),
    // A LATER usage chunk for the CLOSED step is the latest fact: it
    // REPLACES the committed provisional value (never adds — the step's
    // usage is one value, the latest fact wins).
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 0 } } }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 50, 'the latest fact replaces the closed step\'s committed value')
})

test('an authoritative message BEFORE step/start keeps its provenance (a late chunk never replaces it)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    // The authoritative message arrives BEFORE the step/start (replay).
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 110, outputTokens: 0 },
    }, 1001, 1),
    eventAt('step/start', { turn: 0, step: 0 }, 1002, 2),
    eventAt('step/end', { turn: 0, step: 0 }, 1003, 3),
    // A late PROVISIONAL chunk is stale: it must NOT replace the
    // authoritative committed value (and never double-count it).
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 0 } } }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 110, 'the authoritative value stands; the stale chunk is ignored')
})

test('usage ordering matrix: every chunk/message/start/end permutation counts the step once', () => {
  const chunk = (seq: number): SessionEvent => eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1000 + seq, seq)
  const message = (seq: number): SessionEvent => eventAt('assistant/message', {
    turn: 0, step: 0,
    message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    usage: { inputTokens: 110, outputTokens: 0 },
  }, 1000 + seq, seq)
  const start = (seq: number): SessionEvent => eventAt('step/start', { turn: 0, step: 0 }, 1000 + seq, seq)
  const end = (seq: number): SessionEvent => eventAt('step/end', { turn: 0, step: 0 }, 1000 + seq, seq)
  const permutations: SessionEvent[][] = [
    [start(1), chunk(2), message(3), end(4)], // normal
    [start(1), message(2), chunk(3), end(4)], // message before a late chunk
    [chunk(1), start(2), message(3), end(4)], // chunk before start
    [message(1), start(2), chunk(3), end(4)], // message before start, late chunk
    [chunk(1), message(2), start(3), end(4)], // both before start
    [start(1), chunk(2), end(3), message(4)], // message after end
    [chunk(1), end(2), message(3)],           // no start, message after end
    [message(1), end(2), chunk(3)],           // no start, late chunk
    [chunk(1), end(2)],                       // no start, no message
    [message(1), end(2)],                     // no start, message only
  ]
  for (const events of permutations) {
    const folder = new TranscriptFolder()
    folder.apply([eventAt('turn/start', { turn: 0 }, 1000, 0), ...events])
    const activity = folder.turnActivity(0)!
    // The authoritative 110 wins whenever a message exists; a lone
    // provisional chunk commits its own value; a stale chunk after an
    // authoritative value is ignored.
    const hasMessage = events.some(e => e.type === 'assistant/message')
    const expected = hasMessage ? 110 : 100
    assert.equal(activity.totalTokens, expected,
      `permutation ${events.map(e => e.type).join(' -> ')} must total ${expected}, got ${activity.totalTokens}`)
  }
})

test('a late authoritative message after step/end replaces the committed provisional value (no double count)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('step/start', { turn: 0, step: 0 }, 1001, 1),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1002, 2),
    eventAt('step/end', { turn: 0, step: 0 }, 1003, 3),
    // The authoritative message arrives AFTER step/end (replay edge).
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 110, outputTokens: 0 },
    }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 110, 'the late authoritative message must replace the committed provisional, never add')
})

test('a turn-start-less tool/call attributes to its OWN turn (replay fragment)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('tool/call', { turn: 7, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' }, 1000, 0),
  ])
  const activity = folder.turnActivity(7)!
  assert.equal(activity.toolCalls, 1)
  assert.equal(activity.tool?.name, 'bash')
  assert.equal(folder.turnActivity(0), undefined, 'the call must not leak into the stale current turn')
})

test('a late authoritative message for an already-confirmed candidate updates the confirmed text in place', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'partial stream' } }, 1001, 1),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c'), name: 'bash', arguments: '{}' }, 1002, 2),
    // The authoritative message arrives AFTER the confirmation (replay).
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'authoritative intermediate' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1003, 3),
    eventAt('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: '最终答案' } }, 1004, 4),
    eventAt('assistant/message', {
      turn: 0, step: 1,
      message: { id: MessageId('a2'), role: 'assistant', content: [{ type: 'text', text: '最终答案' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1005, 5),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1006, 6),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message?.text, 'authoritative intermediate',
    'the authoritative text must replace the stale streamed fragment, never resurrect a candidate')
})

test('a late message for an OLDER confirmed step never regresses the slot', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '第一步' } }, 1001, 1),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' }, 1002, 2),
    eventAt('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: '第二步' } }, 1003, 3),
    eventAt('tool/call', { turn: 0, step: 1, callId: CallId('c2'), name: 'bash', arguments: '{}' }, 1004, 4),
    // Step 0's authoritative message arrives late (after step 1 confirmed).
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a0'), role: 'assistant', content: [{ type: 'text', text: '第一步权威' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1005, 5),
    eventAt('assistant/chunk', { turn: 0, step: 2, chunk: { type: 'text-delta', index: 0, text: '最终' } }, 1006, 6),
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('a2'), role: 'assistant', content: [{ type: 'text', text: '最终' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1007, 7),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1008, 8),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message?.text, '第二步',
    'the LATEST intermediate must stay; the older step\'s late message is ignored')
})

test('a later assistant/message confirms the earlier candidate and becomes the new candidate (plan §5.3 C)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '第一步说明' } }, 1001, 1),
    // Step 1's message arrives WITHOUT a step-1 text delta (replay edge).
    eventAt('assistant/message', {
      turn: 0, step: 1,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: '第二步说明' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1002, 2),
    eventAt('assistant/chunk', { turn: 0, step: 2, chunk: { type: 'text-delta', index: 0, text: '最终答案' } }, 1003, 3),
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('a2'), role: 'assistant', content: [{ type: 'text', text: '最终答案' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  // The LATEST intermediate message wins (step 1's settled text), never
  // the earliest (step 0's streamed text); the step-2 final stays out.
  assert.equal(activity.message?.text, '第二步说明')
})

test('a long confirmed intermediate message previews its TAIL, never the stale head', () => {
  const folder = new TranscriptFolder()
  const long = 'line one\n' + 'x'.repeat(600) + '\nTHE END MARKER'
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: long } }, 1001, 1),
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: long }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1002, 2),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c'), name: 'bash', arguments: '{}' }, 1003, 3),
    eventAt('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: '最终答案' } }, 1004, 4),
    eventAt('assistant/message', {
      turn: 0, step: 1,
      message: { id: MessageId('a2'), role: 'assistant', content: [{ type: 'text', text: '最终答案' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1005, 5),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1006, 6),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message?.text, 'THE END MARKER', 'the preview must come from the message TAIL')
})

test('a settled message without any prior candidate is still the final when the turn ends (no phantom slot)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: '直接答案' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1001, 1),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1002, 2),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.message, undefined, 'a lone final answer must never enter the Message slot')
})

test('workflow/subagent lifecycle events never touch the Tool slot or the count (plan §17)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool-workflow/run-start', { runId: 'r1', name: 'audit' }, 1001, 1),
    eventAt('subagent/descriptor', { label: 'reviewer', mode: 'subagent' }, 1002, 2),
    eventAt('llm/retry', { retry: 0, delayMs: 1000, failure: { code: 'E', message: 'boom' } }, 1003, 3),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.toolCalls, 0)
  assert.equal(activity.tool, undefined)
})

// ── Per-turn token usage (plan §12/§13/§45) ────────────────────────────

/** One step with a usage chunk + assistant/message + step/end. */
function usageStep(turn: number, step: number, usage: Record<string, number>, baseSeq: number, startTime: number): SessionEvent[] {
  return [
    eventAt('step/start', { turn, step }, startTime, baseSeq),
    eventAt('assistant/chunk', { turn, step, chunk: { type: 'usage', usage } }, startTime + 1, baseSeq + 1),
    eventAt('assistant/message', {
      turn, step,
      message: { id: MessageId(`u-${turn}-${step}`), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage,
    }, startTime + 2, baseSeq + 2),
    eventAt('step/end', { turn, step }, startTime + 3, baseSeq + 3),
  ]
}

test('per-turn token totals include cache read/write and output (plan §12.2)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    ...usageStep(0, 0, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 }, 1, 1001),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2000, 10),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 200)
  assert.equal(activity.usage?.inputTokens, 100)
  assert.equal(activity.usage?.cacheReadTokens, 50)
  assert.equal(activity.usage?.cacheWriteTokens, 10)
  assert.equal(activity.usage?.outputTokens, 40)
})

test('multi-step turns sum their committed steps', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    ...usageStep(0, 0, { inputTokens: 200, outputTokens: 0 }, 1, 1001),
    ...usageStep(0, 1, { inputTokens: 300, outputTokens: 0 }, 10, 2001),
    ...usageStep(0, 2, { inputTokens: 150, outputTokens: 0 }, 20, 3001),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4000, 30),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 650)
})

test('provisional usage is replaced, never added (plan §13.2/§45)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('step/start', { turn: 0, step: 0 }, 1001, 1),
    // Streaming provisional: 100.
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1002, 2),
    // Authoritative: 110 — replaces, never adds.
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 110, outputTokens: 0 },
    }, 1003, 3),
    eventAt('step/end', { turn: 0, step: 0 }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 110, 'the authoritative usage must replace the provisional, never add')
})

test('a usage chunk without assistant/message still counts (plan §45)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('step/start', { turn: 0, step: 0 }, 1001, 1),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 80, outputTokens: 20 } } }, 1002, 2),
    eventAt('step/end', { turn: 0, step: 0 }, 1003, 3),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1004, 4),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 100)
})

test('an orphan fact is reconciled when its step opens late (no double count)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    // The usage chunk arrives BEFORE the step/start (out-of-order replay).
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1001, 1),
    eventAt('step/start', { turn: 0, step: 0 }, 1002, 2),
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 110, outputTokens: 0 },
    }, 1003, 3),
    eventAt('step/end', { turn: 0, step: 0 }, 1004, 4),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1005, 5),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 110, 'the orphan fact must reconcile into the open step, never double-counted')
})

test('orphan usage: the authoritative message REPLACES the provisional chunk (never adds)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    // No step/start: both facts are orphan replay edges.
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1001, 1),
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 110, outputTokens: 0 },
    }, 1002, 2),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1003, 3),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 110, 'the authoritative orphan must replace the provisional orphan')
})

test('a turn-start-less turn/end attributes its synthetic cards to the EVENT turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    // Turn 2's end arrives without a turn/start (replay fragment).
    eventAt('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'E', message: 'boom' } } }, 2000, 1),
  ])
  const cards = folder.messages().filter((m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool')
  assert.ok(cards.some(c => c.turn === 2 && c.name === 'error'), 'the error card must carry turn 2')
  assert.ok(!cards.some(c => c.turn === 1 && c.name === 'error'), 'the error card must not land in turn 1')
  const activity = folder.turnActivity(2)!
  assert.equal(activity.reason?.kind, 'error')
})

test('usage without a step boundary still attributes to the turn (replay edge)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    // No step/start: the usage fact is a settled replay edge.
    eventAt('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 500, outputTokens: 50 },
    }, 1001, 1),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1002, 2),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 550, 'orphan usage must attribute to its turn (sum(per-turn) == session)')
})

test('no usage fact → no token segment (never a fake 0 tok)', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const activity = folder.turnActivity(0)!
  assert.equal(activity.usage, undefined)
  assert.equal(activity.totalTokens, undefined)
  const header = formatFocusHeaderLine(activity, false, () => 35000, 120)
  assert.ok(!header.includes('tok'), `no usage → no token segment:\n${header}`)
})

test('replay determinism: per-turn tokens match a fresh fold of the same events', () => {
  const events = [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    ...usageStep(0, 0, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 }, 1, 1001),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2000, 10),
  ]
  const live = new TranscriptFolder()
  live.apply(events)
  const replay = new TranscriptFolder()
  replay.apply(events)
  assert.equal(live.turnActivity(0)!.totalTokens, replay.turnActivity(0)!.totalTokens)
  assert.deepEqual(live.turnActivity(0)!.usage, replay.turnActivity(0)!.usage)
})

test('the running display includes the open step provisional usage', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('step/start', { turn: 0, step: 0 }, 1001, 1),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 1002, 2),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.totalTokens, 100, 'the running header shows the provisional total')
})

// ── formatters (plan §14/§25/§46) ──────────────────────────────────────

function activityOf(turn: number, events: SessionEvent[]): ReturnType<TranscriptFolder['turnActivity']> {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return folder.turnActivity(turn)
}

test('formatFocusDuration renders seconds and minutes', () => {
  assert.equal(formatFocusDuration(5000), '5s')
  assert.equal(formatFocusDuration(0), '0s')
  assert.equal(formatFocusDuration(65_000), '1m 5s')
  assert.equal(formatFocusDuration(120_000), '2m')
  assert.equal(formatFocusDuration(undefined), undefined)
  assert.equal(formatFocusDuration(-5), '0s')
})

test('the header label names failures; durations only when known', () => {
  const running = activityOf(0, [eventAt('turn/start', { turn: 0 }, 1000, 0)])
  assert.equal(focusStatusLabel(running!, '16s'), 'Thought 16s')
  assert.equal(focusStatusLabel(running!, undefined), 'Thought')
  const done = activityOf(0, completedTurn(0, 0, 1000))
  assert.equal(focusStatusLabel(done!, '34s'), 'Thought 34s')
  const failed = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } }, 18000, 1),
  ])
  assert.equal(focusStatusLabel(failed!, '17s'), 'Failed after 17s')
  const aborted = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'aborted' } }, 10000, 1),
  ])
  assert.equal(focusStatusLabel(aborted!, '9s'), 'Interrupted 9s')
  const blocked = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'blocked' } }, 5000, 1),
  ])
  assert.equal(focusStatusLabel(blocked!, '4s'), 'Blocked 4s')
  const tokens = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 42000, 1),
  ])
  assert.equal(focusStatusLabel(tokens!, '41s'), 'Max tokens 41s')
})

test('the whale icon encodes ONLY the disclosure state (plan §2/§39)', () => {
  assert.equal(focusDisclosureIcon(false), '🐋')
  assert.equal(focusDisclosureIcon(true), '🐳')
  // Every collapsed state — running, settled, failed, interrupted — reads
  // the SAME collapsed whale; the outcome lives in the label.
  const running = activityOf(0, [eventAt('turn/start', { turn: 0 }, 1000, 0)])
  const done = activityOf(0, completedTurn(0, 0, 1000))
  const failed = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'E', message: 'boom' } } }, 2000, 1),
  ])
  const interrupted = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'interrupted' } }, 2000, 1),
  ])
  for (const activity of [running!, done!, failed!, interrupted!]) {
    assert.equal(focusDisclosureIcon(false), '🐋', 'collapsed is ALWAYS 🐋')
    assert.equal(focusDisclosureIcon(true), '🐳', 'expanded is ALWAYS 🐳')
  }
  // The old mixed symbols are gone from the header line.
  const header = formatFocusHeaderLine(failed!, false, () => 3000, 120)
  assert.ok(header.includes('🐋 Failed after 1s'), header)
  assert.ok(!header.includes('◐') && !header.includes('▸') && !header.includes('▾') && !header.includes('⚠'), header)
})

test('tool stats sort count-desc/name-asc, cap at 3 types, +N counts TYPES', () => {
  const tools = new Map<string, number>([['read', 7], ['search', 4], ['bash', 3], ['grep', 2]])
  const parts = focusToolStatParts(tools, 16)
  assert.equal(parts[0], '16 tools')
  assert.deepEqual(parts.slice(1, 1 + FOCUS_TOOL_SUMMARY_MAX_TYPES), ['read ×7', 'search ×4', 'bash ×3'])
  assert.equal(parts.at(-1), '+1', 'the +N remainder counts the OTHER types')
  assert.equal(focusToolStatParts(new Map(), 0).length, 0, 'zero tools → no stats tail')
})

test('the header drops the token/tool tail progressively on narrow widths (plan §46)', () => {
  const done = activityOf(0, completedTurn(0, 0, 1000))
  const tools = new Map<string, number>([['read', 7], ['search', 4], ['bash', 3], ['z', 2]])
  const rich = { ...done!, tools, toolCalls: 16, usage: { inputTokens: 62_000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 62_800 }
  const wide = formatFocusHeaderLine(rich, false, () => 35000, 120)
  assert.ok(wide.includes('🐋 Thought 6s · 63k tok · 16 tools · read ×7 · search ×4 · bash ×3 · +1'), wide)
  const medium = formatFocusHeaderLine(rich, false, () => 35000, 50)
  assert.ok(medium.includes('· 63k tok · 16 tools') && !medium.includes('read ×7'), `medium drops the types:\n${medium}`)
  const narrow = formatFocusHeaderLine(rich, false, () => 35000, 30)
  assert.equal(narrow, '🐋 Thought 6s · 63k tok', `narrow keeps token + label:\n${narrow}`)
  const tiny = formatFocusHeaderLine(rich, false, () => 35000, 16)
  assert.equal(tiny, '🐋 Thought 6s', `tiny keeps the bare label:\n${tiny}`)
  const minuscule = formatFocusHeaderLine(rich, false, () => 35000, 4)
  assert.ok(visibleWidth(minuscule) <= 4, `hard truncate as the last resort:\n${minuscule}`)
})

test('the header never wraps: every candidate fits its width', () => {
  const done = activityOf(0, completedTurn(0, 0, 1000))
  const rich = { ...done!, tools: new Map([['read', 3], ['bash', 2], ['skill', 1]]), toolCalls: 6, usage: { inputTokens: 34_000, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 34_700 }
  for (const width of [8, 12, 20, 30, 40, 60, 80, 120]) {
    const line = formatFocusHeaderLine(rich, false, () => 35000, width)
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)} (${visibleWidth(line)})`)
  }
})

test('the collapsed body renders the three slots in fixed order, one line each (plan §24/§25/§47)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: '这应该是 presenter fallback。' } }, 1001, 1),
    eventAt('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '我已经找到 skill 的特殊处理。' } }, 1002, 2),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c1'), name: 'read', arguments: JSON.stringify({ path: 'src/present.ts' }) }, 1003, 3),
  ])
  const activity = folder.turnActivity(0)!
  const body = focusCollapsedBody(activity, 60, focusToolDisplay(activity.tool!, {}))
  assert.equal(body.length, 3, `exactly the three slots:\n${body.join('\n')}`)
  assert.ok(body[0]!.startsWith('Think:   '), body[0])
  assert.ok(body[1]!.startsWith('Message: '), body[1])
  assert.ok(body[2]!.startsWith('Tool:    '), body[2])
  assert.ok(body[2]!.includes('Read src/present.ts'), body[2])
  // The labels align at the same column (visible width 9).
  for (const line of body) {
    const lead = line.slice(0, 9)
    assert.equal(visibleWidth(lead), 9, `label column must align: ${JSON.stringify(line)}`)
  }
  // Every line fits the width (CJK included).
  for (const line of body) {
    assert.ok(visibleWidth(line) <= 60, `line exceeds width: ${JSON.stringify(line)}`)
  }
})

test('the Tool slot line carries the status prefix: none running, ✓ ok, ✗ error (plan §10)', () => {
  const running = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 1001, 1),
  ])!
  const body = focusCollapsedBody(running, 60, focusToolDisplay(running.tool!, {}))
  assert.ok(body.some(line => line.includes('Tool:    Bash pnpm test')), body.join('|'))
  // Settled ok.
  const ok = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 1001, 1),
    eventAt('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('r'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c') },
      },
    }, 1002, 2),
  ])!
  const okBody = focusCollapsedBody(ok, 60, focusToolDisplay(ok.tool!, {}))
  assert.ok(okBody.some(line => line.includes('✓ Bash pnpm test')), okBody.join('|'))
  // Settled error.
  const err = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 1001, 1),
    eventAt('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('r'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c'), content: [{ type: 'text', text: 'boom' }] }],
        source: { kind: 'tool', callId: CallId('c') },
      },
      error: { code: 'E', message: 'boom' },
    }, 1002, 2),
  ])!
  const errBody = focusCollapsedBody(err, 60, focusToolDisplay(err.tool!, {}))
  assert.ok(errBody.some(line => line.includes('✗ Bash pnpm test')), errBody.join('|'))
})

test('the error line follows the three slots (plan §24)', () => {
  const failed = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'E', message: 'boom' } } }, 2000, 1),
  ])!
  const body = focusCollapsedBody(failed, 60)
  assert.ok(body.some(line => line.startsWith('Error:   E: boom')), body.join('|'))
})

test('the component renders an indented muted card and refreshes duration live', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const activity = folder.turnActivity(0)!
  const component = new FocusActivityComponent({ activity, expanded: false, now: () => 35000 })
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('🐋 Thought 6s · 1 tool · read ×1'), lines[0])
  assert.ok(lines[0]!.startsWith('  '), 'the card is indented')
  // Running turns re-read `now` per render: a later frame shows the new
  // duration (the WorkingIndicator heartbeat drives the repaint).
  const running = activityOf(0, [eventAt('turn/start', { turn: 0 }, 1000, 0)])!
  const live = new FocusActivityComponent({ activity: running, expanded: false, now: () => 12000 })
  assert.ok(live.render(80)[0]!.includes('🐋 Thought 11s'))
  const later = new FocusActivityComponent({ activity: running, expanded: false, now: () => 14000 })
  assert.ok(later.render(80)[0]!.includes('🐋 Thought 13s'))
})

test('the Tool display is presenter-first with a static fallback (plan §9/§43)', () => {
  const presenter: ToolPresenter = {
    call(name, argsRaw) {
      if (name === 'skill') {
        return { card: 'generic', title: 'Load skill session-review', kind: 'read', rawInput: 'session-review' }
      }
      if (name === 'vendor_probe') {
        return { card: 'generic', title: 'Probe Redis', kind: 'read', rawInput: 'cache-01' }
      }
      if (name === 'bash') {
        return { card: 'terminal', title: 'pnpm test --filter provider' }
      }
      return undefined
    },
    result() { return undefined },
  }
  // Live presenter: the tool-owned title wins.
  assert.equal(focusToolDisplay({ name: 'skill', args: JSON.stringify({ name: 'session-review' }) }, { presenter }), 'Load skill session-review')
  assert.equal(focusToolDisplay({ name: 'vendor_probe', args: JSON.stringify({ host: 'cache-01' }) }, { presenter }), 'Probe Redis cache-01')
  assert.equal(focusToolDisplay({ name: 'bash', args: JSON.stringify({ command: 'pnpm test --filter provider' }) }, { presenter }), 'pnpm test --filter provider')
  // Fallback (replay / registry unavailable): the same semantic.
  assert.equal(focusToolDisplay({ name: 'skill', args: JSON.stringify({ name: 'session-review' }) }, {}), 'Load skill session-review')
  assert.equal(focusToolDisplay({ name: 'bash', args: JSON.stringify({ command: 'pnpm test --filter provider' }) }, {}), 'Bash pnpm test --filter provider')
  // A throwing presenter degrades to the fallback (toolPresenterFrom guards).
  const guarded = toolPresenterFrom(() => ({ presentCall() { throw new Error('boom') } }))
  assert.equal(focusToolDisplay({ name: 'read', args: JSON.stringify({ path: 'a.ts' }) }, { presenter: guarded }), 'Read a.ts')
})

test('formatTokens renders the pi abbreviation vocabulary', () => {
  assert.equal(formatTokens(847), '847')
  assert.equal(formatTokens(3200), '3.2k')
  assert.equal(formatTokens(38_000), '38k')
  assert.equal(formatTokens(1_400_000), '1.4M')
})

test('totalTokens sums all four accounting fields', () => {
  assert.equal(totalTokens({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 }), 200)
})

// ── projection (plan §57) ───────────────────────────────────────────────

test('Focus OFF returns the current normal ordering (identity projection)', () => {
  const messages = [
    { kind: 'user', turn: 0, text: 'hi' },
    { kind: 'thinking', turn: 0, text: 'hmm' },
    { kind: 'assistant', turn: 0, text: 'answer' },
  ] as TranscriptMessage[]
  const blocks = projectFocus(messages, new Map(), new Set(), false)
  assert.deepEqual(blockKinds(blocks), ['user', 'thinking', 'assistant'])
  assert.deepEqual(blocks, messages.map(m => ({ kind: 'message', message: m })))
})

test('Focus ON collapsed: user → FocusActivity → final, process hidden', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  assert.deepEqual(blockKinds(blocks), ['user', 'activity', 'assistant'])
  const final = blocks[2]
  assert.ok(final !== undefined && final.kind === 'message')
  if (final.kind === 'message' && final.message.kind === 'assistant') {
    assert.equal(final.message.text, 'final answer 0')
  } else {
    assert.fail('the final block must be the assistant message')
  }
})

test('intermediate assistant messages are hidden when collapsed', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000),
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('mid'), role: 'assistant', content: [{ type: 'text', text: 'intermediate step' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1000 + 7, 8),
    eventAt('assistant/message', {
      turn: 0, step: 3,
      message: { id: MessageId('fin'), role: 'assistant', content: [{ type: 'text', text: 'the final' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1000 + 8, 9),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1000 + 9000, 10),
  ])
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  const kinds = blockKinds(blocks)
  assert.equal(kinds.filter(k => k === 'assistant').length, 1, 'only the LAST assistant survives collapsed')
  const final = blocks.find(b => b.kind === 'message' && b.message.kind === 'assistant')
  assert.ok(final !== undefined && final.kind === 'message')
  if (final.kind === 'message' && final.message.kind === 'assistant') {
    assert.equal(final.message.text, 'the final')
  } else {
    assert.fail('the final block must be the assistant message')
  }
})

test('no final assistant before turn/end (running collapsed)', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000).slice(0, -1)) // drop turn/end
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  assert.deepEqual(blockKinds(blocks), ['user', 'activity'])
})

test('FocusActivity always precedes the final assistant', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  const activityIndex = blocks.findIndex(b => b.kind === 'activity')
  const finalIndex = blocks.findIndex(b => b.kind === 'message' && b.message.kind === 'assistant')
  assert.ok(activityIndex >= 0 && activityIndex < finalIndex)
})

test('expanded turns show the full process in order and never duplicate the final', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set([0]), true)
  const kinds = blockKinds(blocks)
  assert.deepEqual(kinds, ['user', 'activity', 'thinking', 'tool', 'assistant'])
  const assistants = blocks.filter(b => b.kind === 'message' && b.message.kind === 'assistant')
  assert.equal(assistants.length, 1, 'the final assistant appears exactly once (in the process)')
})

test('aborted/interrupted/error turns show no final assistant collapsed', () => {
  for (const reason of ['aborted', 'interrupted', 'error', 'blocked']) {
    const folder = new TranscriptFolder()
    folder.apply([
      ...completedTurn(0, 0, 1000).slice(0, -1),
      eventAt('turn/end', { turn: 0, reason: reason === 'error'
        ? { kind: 'error', error: { code: 'X', message: 'boom' } }
        : { kind: reason } }, 7000, 99),
    ])
    const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
    assert.ok(!blocks.some(b => b.kind === 'message' && b.message.kind === 'assistant'),
      `${reason}: an interrupted prefix must never be promoted to a final answer`)
    assert.ok(blocks.some(b => b.kind === 'activity'), `${reason}: the Thought card stays`)
  }
})

test('max-tokens keeps the useful settled assistant with the truncated marker', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1),
    eventAt('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 7000, 99),
  ])
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  const final = blocks.find(b => b.kind === 'message' && b.message.kind === 'assistant')
  assert.ok(final !== undefined && final.kind === 'message')
  if (final.kind === 'message') {
    assert.equal(final.truncated, true, 'the max-tokens final must carry the truncated marker')
  } else {
    assert.fail('the max-tokens final must be a message block')
  }
})

test('an EXPANDED max-tokens turn keeps the truncated marker on its last assistant', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1),
    eventAt('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 7000, 99),
  ])
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set([0]), true)
  const assistants = blocks.filter((b): b is Extract<FocusProjectedBlock, { kind: 'message' }> =>
    b.kind === 'message' && b.message.kind === 'assistant')
  assert.equal(assistants.length, 1, 'one final assistant in the expanded process')
  assert.equal(assistants[0]!.truncated, true, 'the expanded max-tokens final must carry the marker')
  // A COMPLETED expanded turn has no marker.
  const done = new TranscriptFolder()
  done.apply(completedTurn(0, 0, 1000))
  const doneBlocks = projectFocus(done.messages(), done.turnActivities(), new Set([0]), true)
  const doneAssistant = doneBlocks.find((b): b is Extract<FocusProjectedBlock, { kind: 'message' }> =>
    b.kind === 'message' && b.message.kind === 'assistant')
  assert.equal(doneAssistant?.truncated, undefined, 'a completed final never carries the marker')
})

test('turnActivities returns the SAME objects by reference (no per-repaint copy)', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  folder.apply(completedTurn(1, 10, 20_000))
  const first = folder.turnActivities()
  const second = folder.turnActivities()
  assert.equal(first, second, 'the map itself must not be rebuilt per repaint')
  assert.equal(first.get(0), second.get(0), 'activity objects must not be copied per repaint')
  assert.equal(folder.turnActivity(0), first.get(0), 'turnActivity returns the same object')
  // The Think slot is materialized eagerly on the shared object.
  assert.equal(first.get(0)?.think?.text, 'checking the transcript path…')
})

test('the final is the EXACT last assistant: an empty last step yields NO final (no earlier fallback)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // step 1 settles 'final answer text'
    // step 2 streams then settles to EMPTY text (the folder keeps the
    // entry, text becomes '').
    eventAt('assistant/chunk', { turn: 0, step: 2, chunk: { type: 'text-delta', index: 0, text: 'partial' } }, 1000 + 10, 20),
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('empty'), role: 'assistant', content: [{ type: 'text', text: '' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1000 + 11, 21),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1000 + 12, 22),
  ])
  const messages = folder.messages()
  const last = messages.findLast(m => m.kind === 'assistant')
  assert.ok(last !== undefined && last.kind === 'assistant' && last.text === '', 'fixture: the exact last assistant is empty')
  const blocks = projectFocus(messages, folder.turnActivities(), new Set(), true)
  assert.ok(!blocks.some(b => b.kind === 'message' && b.message.kind === 'assistant'),
    'an empty last step must suppress the final — never fall back to the earlier text assistant')
})

test('an image-only final assistant is the EXACT final (never falls back to the earlier text step)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // step 1: 'final answer text'
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: {
        id: 'img', role: 'assistant',
        content: [{ type: 'image', attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 100, width: 1920, height: 1080, name: 'shot.png' } }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 1000 + 11, 21),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1000 + 12, 22),
  ])
  const messages = folder.messages()
  const last = messages.findLast(m => m.kind === 'assistant')
  assert.ok(last !== undefined && last.kind === 'assistant' && last.text === '' && last.content !== undefined,
    'precondition: the exact last assistant is image-only')
  const blocks = projectTools(folder.messages(), folder.turnActivities(), new Set())
  const assistants = blocks.filter((b): b is Extract<FocusProjectedBlock, { kind: 'message' }> =>
    b.kind === 'message' && b.message.kind === 'assistant')
  assert.equal(assistants.length, 1, 'exactly one assistant survives collapsed')
  const final = assistants[0]!
  if (final.message.kind === 'assistant') {
    assert.equal(final.message.text, '', 'the image-only assistant is the final — not the earlier text one')
  } else {
    assert.fail('the final block must be an assistant message')
  }
})

test('a reasoning-only exact last assistant is NOT renderable — no final', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // earlier text assistant
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: {
        id: 'rsn', role: 'assistant',
        // The assistant renderer paints only text/image blocks: reasoning
        // content renders ZERO rows, so it must not qualify as a final.
        content: [{ type: 'reasoning', text: 'thinking only' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 1000 + 11, 21),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 1000 + 12, 22),
  ])
  const messages = folder.messages()
  const last = messages.findLast(m => m.kind === 'assistant')
  assert.ok(last !== undefined && last.kind === 'assistant' && last.text === '' && last.content !== undefined,
    'precondition: the exact last assistant is reasoning-only')
  const blocks = projectFocus(messages, folder.turnActivities(), new Set(), true)
  assert.ok(!blocks.some(b => b.kind === 'message' && b.message.kind === 'assistant'),
    'a reasoning-only last step must not be promoted to the final')
})

test('a tool-call-only exact last assistant is NOT renderable — no final', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // earlier text assistant
    eventAt('assistant/message', {
      turn: 0, step: 2,
      message: {
        id: 'tc', role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('late-call'), name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 1000 + 11, 21),
    eventAt('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 1000 + 12, 22),
  ])
  const blocks = projectTools(folder.messages(), folder.turnActivities(), new Set())
  assert.ok(!blocks.some(b => b.kind === 'message' && b.message.kind === 'assistant'),
    'a tool-call-only last step must not end in a bare truncated marker')
})

test('max-tokens also never falls back to an earlier assistant', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1),
    eventAt('assistant/chunk', { turn: 0, step: 3, chunk: { type: 'text-delta', index: 0, text: 'partial' } }, 1000 + 11, 21),
    eventAt('assistant/message', {
      turn: 0, step: 3,
      message: { id: 'empty3', role: 'assistant', content: [{ type: 'text', text: '' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1000 + 12, 22),
    eventAt('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 1000 + 13, 23),
  ])
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  assert.ok(!blocks.some(b => b.kind === 'message' && b.message.kind === 'assistant'),
    'max-tokens must not promote an earlier text assistant when the last step is empty')
})

test('the EXPANDED final is always the LAST block (a max-tokens system row cannot precede it)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // assistant step 1 settles
    eventAt('turn/end', { turn: 0, reason: { kind: 'max-tokens' } }, 1000 + 13, 23),
  ])
  // The folder appends `system: max tokens reached` AFTER the assistant —
  // the expanded projection must hold the final back and emit it last.
  const messages = folder.messages()
  assert.equal(messages.at(-1)?.kind, 'system', 'precondition: the raw fold ends with the max-tokens system row')
  const blocks = projectFocus(messages, folder.turnActivities(), new Set([0]), true)
  const last = blocks.at(-1)
  assert.ok(last !== undefined && last.kind === 'message' && last.message.kind === 'assistant',
    `the final assistant must be the LAST expanded block, got: ${blocks.map(b => b.kind === 'message' ? b.message.kind : 'activity').join(',')}`)
  const assistants = blocks.filter(b => b.kind === 'message' && b.message.kind === 'assistant')
  assert.equal(assistants.length, 1, 'the expanded final never duplicates')
})

test('the Thought component never renders a line wider than the terminal', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const activity = folder.turnActivity(0)!
  const running = new FocusActivityComponent({ activity, expanded: false, now: () => 35000 })
  const open = new FocusActivityComponent({ activity, expanded: true, now: () => 35000 })
  for (const width of [12, 20, 40, 80]) {
    for (const line of [...running.render(width), ...open.render(width)]) {
      assert.ok(visibleWidth(line) <= width, `line ${JSON.stringify(line)} exceeds width ${width}`)
    }
  }
})

/** projectFocus helper with the focus-mode flag preset. */
function projectTools(
  messages: readonly TranscriptMessage[],
  activities: ReadonlyMap<number, import('../src/transcript.ts').TurnActivity>,
  expanded: ReadonlySet<number>,
): FocusProjectedBlock[] {
  return projectFocus(messages, activities, expanded, true)
}

test('collapsed turns never render process rows at all (no Ctrl+O leak)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1), // still running
    eventAt('user/message', { id: MessageId('m2'), role: 'user', content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }, 2000, 50),
  ])
  const messages = folder.messages()
  // Ctrl+O = expand recent turns; the projection must ignore that boundary
  // for a COLLAPSED Focus turn (the rows simply are not there).
  const blocks = projectFocus(messages, folder.turnActivities(), new Set(), true)
  assert.ok(!blocks.some(b => b.kind === 'message' && (b.message.kind === 'tool' || b.message.kind === 'thinking')),
    'a collapsed Focus turn must hide its process regardless of Ctrl+O')
})

test('compaction cards keep their existing lifecycle under Focus', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ...completedTurn(0, 0, 1000).slice(0, -1),
    eventAt('compaction/start', { compactionId: 'c1' }, 7000, 99),
    eventAt('compaction/end', { compactionId: 'c1' }, 8000, 100),
    eventAt('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9000, 101),
  ])
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  assert.ok(blockKinds(blocks).includes('compaction'), 'compaction cards stay visible')
})

test('window summaries (turn-less entries) pass through the projection', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const windowed = [{ kind: 'summary', text: '… 3 earlier turns' }, ...folder.messages()] as TranscriptMessage[]
  const blocks = projectFocus(windowed, folder.turnActivities(), new Set(), true)
  assert.equal(blocks[0]?.kind === 'message' ? blocks[0].message.kind : '', 'summary')
})

// ── system prompt (plan §55) ────────────────────────────────────────────

/** A fake agent context exposing only the systemPrompt service. */
function fakeAgentCtx(sections: Array<{ name: string; order: number; text: string | (() => string) }>): {
  get(name: string): unknown
  dispose(): void
} {
  return {
    get(name: string): unknown {
      if (name !== 'systemPrompt') return undefined
      return {
        section(section: { name: string; order: number; text: string | (() => string); complete?: boolean }): () => void {
          sections.push(section)
          return () => {
            const index = sections.indexOf(section)
            if (index !== -1) sections.splice(index, 1)
          }
        },
      }
    },
    dispose(): void {},
  }
}

test('installFocusPrompt registers ONE dynamic section with the TUI-private name', () => {
  const sections: Array<{ name: string; order: number; text: string | (() => string); complete?: boolean }> = []
  const agentCtx = fakeAgentCtx(sections)
  const focusState = { enabled: false }
  const dispose = installFocusPrompt(agentCtx as never, focusState)
  assert.ok(dispose !== undefined)
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.name, FOCUS_SECTION_NAME)
  assert.equal(sections[0]!.order, FOCUS_SECTION_ORDER)
  assert.equal(sections[0]!.complete, undefined, 'never a complete section')
  const text = sections[0]!.text
  assert.equal(typeof text === 'function' ? text() : text, '', 'off → empty text')
  focusState.enabled = true
  assert.equal(typeof text === 'function' ? text() : '', FOCUS_MODE_PROMPT, 'on → the exact instruction')
  // The same registered section flips without re-registration.
  focusState.enabled = false
  assert.equal(typeof text === 'function' ? text() : '', '', 'off again without re-registering')
  assert.equal(sections.length, 1, 'no re-registration on toggles')
  dispose?.()
  assert.equal(sections.length, 0, 'the disposer removes the section')
})

test('installFocusPrompt degrades gracefully when the service is missing', () => {
  const agentCtx = { get: () => undefined }
  const dispose = installFocusPrompt(agentCtx as never, { enabled: true })
  assert.equal(dispose, undefined, 'no service → no section, no throw')
})

test('installFocusPrompt tolerates a throwing registration', () => {
  const agentCtx = {
    get: (name: string) => name === 'systemPrompt'
      ? { section: () => { throw new Error('duplicate name') } }
      : undefined,
  }
  const dispose = installFocusPrompt(agentCtx as never, { enabled: true })
  assert.equal(dispose, undefined)
})
