/**
 * Focus Mode unit tests: TurnActivity aggregation (plan §56), the Focus
 * presentation projection (plan §57), the header/formatters (plan §14), and
 * the dynamic system-prompt section (plan §55). Pure — no dsh tree needed.
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
  focusDurationText,
  focusOperationLine,
  focusStatusLabel,
  focusStatusSymbol,
  focusToolStatParts,
  formatFocusDuration,
  formatFocusHeaderLine,
  projectFocus,
  type FocusProjectedBlock,
} from '../src/focus-activity.ts'

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

// ── TurnActivity aggregation (plan §56) ─────────────────────────────────

test('aggregates turn timing, tool stats and narratives from events', () => {
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
  // The narrative preview: latest thinking beats the assistant text (plan
  // §10.5 priority), and the thinking preview is the LATEST line.
  assert.equal(activity.narrative?.kind, 'thinking')
  assert.equal(activity.narrative?.text, 'checking the transcript path…')
  assert.equal(activity.latestOperation, '✓ read src/transcript.ts')
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
  // The last operation is the still-running bash call.
  assert.equal(activity.latestOperation, 'Tool: bash pnpm lint')
})

test('tool previews use the natural summary key (path/command/query)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c1'), name: 'read', arguments: JSON.stringify({ path: 'src/index.ts' }) }, 1001, 1),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c2'), name: 'search', arguments: JSON.stringify({ query: 'systemPrompt.section' }) }, 1002, 2),
    eventAt('tool/call', { turn: 0, step: 0, callId: CallId('c3'), name: 'weird', arguments: 'not-json' }, 1003, 3),
  ])
  const activity = folder.turnActivity(0)!
  assert.equal(activity.latestOperation, 'Tool: weird')
})

test('latest thinking previews and system narratives follow the priority', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 2 }, 1000, 0),
    // A system/context row first (lowest priority).
    eventAt('user/message', {
      id: MessageId('s1'), role: 'user',
      content: [{ type: 'text', text: 'injected instructions line\nmore' }],
      source: { kind: 'plugin', name: 'skill' },
    }, 1001, 1),
    eventAt('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'first line\nchecking turn boundaries…' } }, 1002, 2),
  ])
  const activity = folder.turnActivity(2)!
  // Thinking beats the system narrative; the preview is the LATEST line.
  assert.equal(activity.narrative?.kind, 'thinking')
  assert.equal(activity.narrative?.text, 'checking turn boundaries…')
  // The full thinking stream is NOT buffered (bounded preview only).
  assert.ok(activity.narrative!.text.length < 60)
})

test('missing turn/start omits the duration (no fake 0s)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('tool/call', { turn: 9, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' }, 1000, 0),
    eventAt('turn/end', { turn: 9, reason: { kind: 'completed' } }, 2000, 1),
  ])
  const activity = folder.turnActivity(9)!
  assert.equal(activity.startedAt, undefined)
  assert.equal(activity.endedAt, 2000)
  assert.equal(focusDurationText(activity, () => 3000), undefined, 'no start → no duration')
})

test('an open turn has no endedAt and stays incomplete', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' }, 1001, 1),
  ])
  const activity = folder.turnActivity(1)!
  assert.equal(activity.completed, false)
  assert.equal(activity.endedAt, undefined)
  assert.equal(activity.reason, undefined)
  assert.equal(activity.latestOperation, 'Tool: bash')
})

test('turn/end records the OFFICIAL reason kinds verbatim', () => {
  for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted']) {
    const folder = new TranscriptFolder()
    folder.apply([
      eventAt('turn/start', { turn: 0 }, 1000, 0),
      eventAt('turn/end', { turn: 0, reason: kind === 'error'
        ? { kind: 'error', error: { code: 'E1', message: 'boom' } }
        : { kind } }, 2000, 1),
    ])
    const activity = folder.turnActivity(0)!
    assert.equal(activity.reason?.kind, kind, `reason ${kind} must be stored verbatim`)
    if (kind === 'error') {
      assert.equal(activity.reason?.error?.code, 'boom'.length > 0 ? 'E1' : '')
      assert.equal(activity.reason?.error?.message, 'boom')
    }
  }
})

// ── formatters (plan §14) ───────────────────────────────────────────────

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

test('status symbols follow the disclosure + reason state', () => {
  const running = activityOf(0, [eventAt('turn/start', { turn: 0 }, 1000, 0)])
  assert.equal(focusStatusSymbol(running!, false), '◐')
  assert.equal(focusStatusSymbol(running!, true), '▾')
  const done = activityOf(0, completedTurn(0, 0, 1000))
  assert.equal(focusStatusSymbol(done!, false), '▸')
  assert.equal(focusStatusSymbol(done!, true), '▾')
  const failed = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'error' } }, 2000, 1),
  ])
  assert.equal(focusStatusSymbol(failed!, false), '⚠')
  assert.equal(focusStatusSymbol(failed!, true), '▾')
  const aborted = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'interrupted' } }, 2000, 1),
  ])
  assert.equal(focusStatusSymbol(aborted!, false), '⨯')
})

test('tool stats sort count-desc/name-asc, cap at 3 types, +N counts TYPES', () => {
  const tools = new Map<string, number>([['read', 7], ['search', 4], ['bash', 3], ['grep', 2]])
  const parts = focusToolStatParts(tools, 16)
  assert.equal(parts[0], '16 tools')
  assert.deepEqual(parts.slice(1, 1 + FOCUS_TOOL_SUMMARY_MAX_TYPES), ['read ×7', 'search ×4', 'bash ×3'])
  assert.equal(parts.at(-1), '+1', 'the +N remainder counts the OTHER types')
  assert.equal(focusToolStatParts(new Map(), 0).length, 0, 'zero tools → no stats tail')
})

test('the header line drops the stats tail progressively on narrow widths', () => {
  const done = activityOf(0, completedTurn(0, 0, 1000))
  const tools = new Map<string, number>([['read', 7], ['search', 4], ['bash', 3], ['z', 2]])
  const rich = { ...done!, tools, toolCalls: 16 }
  const wide = formatFocusHeaderLine(rich, false, () => 35000, 120)
  assert.ok(wide.includes('Thought 6s · 16 tools · read ×7 · search ×4 · bash ×3 · +1'), wide)
  const medium = formatFocusHeaderLine(rich, false, () => 35000, 50)
  assert.ok(medium.includes('· 16 tools') && !medium.includes('+1'), `medium drops the remainder:\n${medium}`)
  const narrow = formatFocusHeaderLine(rich, false, () => 35000, 20)
  assert.equal(visibleWidth(narrow) <= 20, true, `narrow must fit:\n${narrow}`)
  assert.ok(narrow.includes('Thought') && !narrow.includes('·'), `narrow keeps the bare label:\n${narrow}`)
})

test('operation line: Tool: while running, Last: once settled', () => {
  assert.equal(focusOperationLine('Tool: bash pnpm test', true), 'Tool: bash pnpm test')
  assert.equal(focusOperationLine('Tool: bash pnpm test', false), 'Last: bash pnpm test')
  assert.equal(focusOperationLine('✓ read src/index.ts', false), 'Last: read src/index.ts')
  assert.equal(focusOperationLine('Subagent: reviewing', false), 'Subagent: reviewing')
})

test('the collapsed card body shows narrative + operation + error line', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const activity = folder.turnActivity(0)!
  const body = focusCollapsedBody({ ...activity, narrative: { kind: 'thinking', text: 'checking…' } }, 60)
  assert.ok(body[0]!.startsWith('Thinking: checking…'), body.join('|'))
  assert.ok(body[1]!.startsWith('Last: read src/transcript.ts'), body.join('|'))
  // An error reason adds its compact message.
  const failed = activityOf(0, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'E', message: 'boom' } } }, 2000, 1),
  ])!
  const errorBody = focusCollapsedBody(failed, 60)
  assert.ok(errorBody.some(line => line.startsWith('Error: E: boom')), errorBody.join('|'))
})

test('the component renders an indented muted card and refreshes duration live', () => {
  const folder = new TranscriptFolder()
  folder.apply(completedTurn(0, 0, 1000))
  const activity = folder.turnActivity(0)!
  const component = new FocusActivityComponent({ activity, expanded: false, now: () => 35000 })
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('▸ Thought 6s · 1 tools · read ×1'), lines[0])
  assert.ok(lines[0]!.startsWith('  '), 'the card is indented')
  // Running turns re-read `now` per render: a later frame shows the new
  // duration (the WorkingIndicator heartbeat drives the repaint).
  const running = activityOf(0, [eventAt('turn/start', { turn: 0 }, 1000, 0)])!
  const live = new FocusActivityComponent({ activity: running, expanded: false, now: () => 12000 })
  assert.ok(live.render(80)[0]!.includes('◐ Thought 11s'))
  const later = new FocusActivityComponent({ activity: running, expanded: false, now: () => 14000 })
  assert.ok(later.render(80)[0]!.includes('◐ Thought 13s'))
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
  // The narrative slot is materialized eagerly on the shared object.
  assert.equal(first.get(0)?.narrative?.kind, 'thinking')
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
