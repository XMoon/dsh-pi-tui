/**
 * Post-F6 PR B Activity span semantics: origin-aware tool/subagent counts
 * (§10), active PTC child parity (§9.4) and span-local wall-clock timing
 * (§12) over TranscriptFolder folds, including live/cold parity, grouped
 * reads and the Preparing → durable elapsed continuity. The post-F6
 * presentation-convergence addendum v2 adds the collapsed Action slot coverage: synthetic
 * rows own the slot by chronology without ever counting as tools.
 * @module @xmoon76/dsh-pi-tui/compact-work-timing.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, transcriptTimingOf } from '../src/transcript.ts'
import { summarizeWorkSpan, formatWorkHeaderLine, compactWorkBody, CompactWorkComponent, type CompactWorkSummary } from '../src/compact-work.ts'
import { compactActionPresentation } from '../src/compact-process-preview.ts'

/** The summary's action stats as a plain record, for exact assertions. */
function statsOf(summary: CompactWorkSummary): { total: number; types: Record<string, number> } {
  const types: Record<string, number> = {}
  for (const [name, count] of summary.actionStats.types) types[name] = count
  return { total: summary.actionStats.total, types }
}

/** The GENUINE tool action types (every non-synthetic subtype) — the
 * per-name counts that must equal the Focus header's `activity.tools`. */
function genuineToolTypes(summary: CompactWorkSummary): Map<string, number> {
  return new Map([...summary.actionStats.types].filter(([name]) => name !== 'subagent' && name !== 'retry' && !name.startsWith('/')))
}
import type { TranscriptWorkSpan } from '../src/transcript-projection.ts'
import { projectTranscriptStructure } from '../src/transcript-projection.ts'

const T0 = 1_000_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

function toolResultEvent(turn: number, callId: string, time: number, seq: number): SessionEvent {
  return eventAt('tool/result', {
    turn, step: 0,
    message: {
      id: MessageId(`r-${callId}`), role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, time, seq)
}

function fold(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  return folder
}

/** The canonical Work spans of the LAST turn in the folder's message list. */
function spansOf(messages: ReturnType<TranscriptFolder['messages']>): TranscriptWorkSpan[] {
  const blocks = projectTranscriptStructure(messages)
  return blocks.filter((block): block is { kind: 'work'; span: TranscriptWorkSpan } => block.kind === 'work').map(block => block.span)
}

function toolCall(turn: number, callId: string, name: string, time: number, seq: number, args = '{}'): SessionEvent {
  return eventAt('tool/call', { turn, step: 0, callId: ToolCallId(callId), name, arguments: args }, time, seq)
}

test('stats: two genuine model tool calls read `2 tools` (no synthetic inflation)', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 100, 1),
    toolResultEvent(1, 'c1', T0 + 200, 2),
    toolCall(1, 'c2', 'bash', T0 + 300, 3),
    toolResultEvent(1, 'c2', T0 + 400, 4),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.deepEqual(statsOf(summary), { total: 2, types: { read: 1, bash: 1 } })
})

test('stats: a subagent delegation counts ONLY as its own action subtype, never as a tool', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 100, 1),
    toolResultEvent(1, 'c1', T0 + 200, 2),
    eventAt('subagent/descriptor', { label: 'scout', mode: 'task' }, T0 + 250, 3),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.deepEqual(statsOf(summary), { total: 2, types: { read: 1, subagent: 1 } }, 'the delegation never counts as a read')
  assert.match(formatWorkHeaderLine(summary, false, 120), /2 actions · read ×1 · subagent ×1/)
})

test('stats: a command-only Activity has no fake `1 tool`', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('command/run', { commandId: 'cmd1', name: 'theme' }, T0 + 100, 1),
    eventAt('command/done', { commandId: 'cmd1', kind: 'success', text: 'theme set' }, T0 + 300, 2),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.deepEqual(statsOf(summary), { total: 1, types: { '/theme': 1 } }, 'the command counts as its own action subtype')
  const header = formatWorkHeaderLine(summary, false, 120)
  assert.match(header, /1 action · \/theme ×1/, `the command name is the subtype:\n${header}`)
})

test('stats: turn-error synthetic cards are attention rows and never enter a span count', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 100, 1),
    toolResultEvent(1, 'c1', T0 + 200, 2),
    eventAt('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E', message: 'boom' } } }, T0 + 500, 3),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.equal(summary.actionStats.total, 1, 'only the genuine call counts')
  assert.ok(!span.members.some(member => member.kind === 'tool' && member.origin === 'turn-error'),
    'the synthetic error card is not a Work member')
})

test('stats: Focus toolCalls and the Activity toolCount agree on genuine calls', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 100, 1),
    toolResultEvent(1, 'c1', T0 + 200, 2),
    eventAt('subagent/descriptor', { label: 'scout' }, T0 + 250, 3),
    toolCall(1, 'c2', 'bash', T0 + 300, 4),
    toolResultEvent(1, 'c2', T0 + 400, 5),
  ])
  const span = spansOf(folder.messages())[0]!
  const activity = folder.turnActivities().get(1)
  assert.deepEqual(genuineToolTypes(summarizeWorkSpan(span)), activity?.tools, 'genuine per-type actions match the Focus tool stats')
})

test('active PTC children: the Action presentation carries the same active child state as Focus', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'root1', 'run_code', T0 + 100, 1, '{}'),
  ])
  folder.apply([eventAt('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId('root1'), parentCallId: ToolCallId('root1'), subCallId: 's1', name: 'bash', arguments: {},
  }, T0 + 150, 2)])
  const runningSummary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.equal(runningSummary.action?.kind, 'tool')
  const running = runningSummary.action === undefined ? undefined : compactActionPresentation(runningSummary.action)
  assert.deepEqual(running?.activeSubCalls, [{ name: 'bash', count: 1 }], 'a running child shows in the Action presentation')
  assert.match(compactWorkBody(runningSummary, 80, running).join('\n'), /Action:\s+Code.* · Bash running/)
  folder.apply([eventAt('tool/ptc-dispatch', {
    rootCallId: ToolCallId('root1'), parentCallId: ToolCallId('root1'), subCallId: 's1', name: 'bash', arguments: {}, isError: false,
    content: [{ type: 'text', text: 'done' }],
  }, T0 + 900, 3)])
  const settledSummary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  const settled = settledSummary.action === undefined ? undefined : compactActionPresentation(settledSummary.action)
  assert.equal(settled?.activeSubCalls, undefined, 'a settled child drops the suffix')
})

test('timing: a Thinking → Tool Activity uses its own wall span', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 2_000, 1),
    toolResultEvent(1, 'c1', T0 + 6_000, 2),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'done' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      // The durable embedded stream carries the lane timing: the Thinking
      // lane was visible T0+1s → T0+1.5s (post-F6 plan §12.5).
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } },
        { type: 'chunk', time: T0 + 1_500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } } },
        { type: 'chunk', time: T0 + 6_500, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'chunk', time: T0 + 6_500, chunk: { type: 'text-delta', index: 1, text: 'done' } },
        { type: 'chunk', time: T0 + 6_800, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } } },
      ],
    }, T0 + 7_000, 3),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.ok(summary.timing, 'span-local timing exists')
  assert.equal(summary.timing?.startedAt, T0 + 1_000, 'the span starts at the reasoning evidence')
  // The Thinking row's OWN end is its reasoning block-end (T0+1.5s): the
  // later text lane is Conversation evidence and must never stretch it.
  const thinkingRow = folder.messages().find(message => message.kind === 'thinking')
  assert.ok(thinkingRow !== undefined && thinkingRow.kind === 'thinking')
  const thinkingTiming = transcriptTimingOf(thinkingRow)
  assert.equal(thinkingTiming?.endedAt, T0 + 1_500, 'the Thinking span ends at its reasoning block-end, not the text tail')
  // The span's latest owned end is the tool result.
  assert.equal(summary.timing?.endedAt, T0 + 6_000, 'the span ends at the latest owned Process evidence')
  assert.equal(summary.timing?.running, false)
  assert.match(formatWorkHeaderLine(summary, false, 120, 'emoji', '5s'), /Activity 5s · 1 action · read ×1/)
})

test('timing: overlapping evidence uses the wall span, never the summed durations', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 0, 1),
    toolCall(1, 'c2', 'bash', T0 + 2_000, 2),
    toolResultEvent(1, 'c1', T0 + 4_000, 3),
    toolResultEvent(1, 'c2', T0 + 9_000, 4),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.equal(summary.timing?.startedAt, T0)
  assert.equal(summary.timing?.endedAt, T0 + 9_000, 'wall span 9s, not 4s + 7s = 11s')
})

test('timing: a running Tool shows a live duration that follows now', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'bash', T0 + 1_000, 1),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.equal(summary.timing?.running, true)
  let now = T0 + 4_000
  const component = new CompactWorkComponent({ span, expanded: false, action: { kind: 'tool', display: 'Bash x', rootName: 'bash' }, now: () => now })
  const line = (component.render(120)[0] ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(line, /Activity 3s/, `the running header reads now at render:\n${line}`)
  now = T0 + 6_500
  const line2 = (component.render(120)[0] ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(line2, /Activity 5s/, 'the duration advances with the repaint heartbeat')
  assert.equal(summary.action?.kind, 'tool')
  assert.equal(summary.action?.message.status, 'running')
})

test('timing: a settled Activity duration stops changing', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 1_000, 1),
    toolResultEvent(1, 'c1', T0 + 4_000, 2),
  ])
  const span = spansOf(folder.messages())[0]!
  const component = new CompactWorkComponent({ span, expanded: false, action: { kind: 'tool', status: 'ok', display: 'Read a.ts', rootName: 'read' }, now: () => T0 + 999_999 })
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(strip(component.render(120)[0] ?? ''), /Activity 3s/)
  assert.ok(!strip(component.render(120)[0] ?? '').includes('996s'), 'settled does not read now')
})

test('timing: point-only evidence never fabricates `Activity 0s`', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('llm/retry', { turn: 1, step: 0, retry: 1, delayMs: 2_000, failure: { code: 'X', message: 'x' } }, T0 + 100, 1),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.ok(summary.timing, 'the retry point contributed evidence')
  const header = formatWorkHeaderLine(summary, false, 120, 'emoji', undefined)
  assert.ok(!header.includes('0s'), `a point-only span omits the duration:\n${header}`)
  assert.equal(header.includes('Activity'), true)
})

test('timing: an llm-retry point contributes to a mixed span without inventing a retry duration', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 1_000, 1),
    eventAt('llm/retry', { turn: 1, step: 1, retry: 1, delayMs: 3_000, failure: { code: 'X', message: 'x' } }, T0 + 2_000, 2),
    toolResultEvent(1, 'c1', T0 + 5_000, 3),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.equal(summary.timing?.startedAt, T0 + 1_000)
  assert.equal(summary.timing?.endedAt, T0 + 5_000)
})

test('timing: Preparing → durable handoff keeps the elapsed time (no 3s → 0s reset)', () => {
  const folder = new TranscriptFolder()
  // Live streamed tool-call arguments start at T0 + 2s; the durable call
  // lands at T0 + 5s; the result settles at T0 + 8s.
  folder.hydrate([eventAt('turn/start', { turn: 1 }, T0, 0)])
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 2_000, chunk: { type: 'tool-call-delta', index: 2, id: 'pc1', name: 'bash', argumentsDelta: '{"c"' } })
  folder.apply([toolCall(1, 'pc1', 'bash', T0 + 5_000, 1)])
  const runningSpan = spansOf(folder.messages())[0]!
  const running = summarizeWorkSpan(runningSpan)
  assert.equal(running.timing?.startedAt, T0 + 2_000, 'the durable card inherits the preparing start')
  folder.apply([toolResultEvent(1, 'pc1', T0 + 8_000, 2)])
  const settled = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.equal(settled.timing?.startedAt, T0 + 2_000)
  assert.equal(settled.timing?.endedAt, T0 + 8_000, '6s wall span, never a reset to 3s')
})

test('timing: grouped reads aggregate their members within one turn', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 1_000, 1),
    toolResultEvent(1, 'c1', T0 + 2_000, 2),
  ])
  folder.apply([
    toolCall(1, 'c2', 'read', T0 + 3_000, 3),
    toolResultEvent(1, 'c2', T0 + 4_000, 4),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  // §10.2: the merged group is ONE displayed card but still TWO genuine
  // model tool actions — the same counting unit as the Focus header.
  assert.equal(summary.actionStats.types.get('read'), 2, 'a merged read group keeps its genuine call cardinality')
  assert.equal(folder.turnActivities().get(1)?.toolCalls, 2)
  assert.deepEqual(genuineToolTypes(summary), folder.turnActivities().get(1)?.tools, 'Focus and Activity agree on genuine calls')
  assert.equal(summary.timing?.startedAt, T0 + 1_000, 'the group aggregates its members')
  assert.equal(summary.timing?.endedAt, T0 + 4_000)
})

test('action slot: synthetic command and delegation rows own the Action without ever counting as tools', () => {
  const commandFolder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('command/run', { commandId: 'cmd1', name: 'theme' }, T0 + 100, 1),
    eventAt('command/done', { commandId: 'cmd1', kind: 'success', text: 'theme set' }, T0 + 300, 2),
  ])
  const commandSummary = summarizeWorkSpan(spansOf(commandFolder.messages())[0]!)
  assert.equal(commandSummary.actionStats.total, 1)
  assert.equal(commandSummary.action?.kind, 'command', 'a command-only Activity owns the Action slot')
  const commandBody = compactWorkBody(commandSummary, 80, compactActionPresentation(commandSummary.action!))
  assert.match(commandBody.join('\n'), /Action:\s+✓ \/theme/, `the command-only body is meaningful:\n${commandBody.join('\n')}`)
  assert.ok(!formatWorkHeaderLine(commandSummary, false, 120).includes('tool'), 'no `1 tool` stat is invented')

  const delegationFolder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('subagent/descriptor', { label: 'scout', mode: 'task' }, T0 + 100, 1),
  ])
  const delegationSummary = summarizeWorkSpan(spansOf(delegationFolder.messages())[0]!)
  assert.deepEqual(statsOf(delegationSummary), { total: 1, types: { subagent: 1 } })
  assert.equal(delegationSummary.action?.kind, 'subagent', 'a delegation-only Activity owns the Action slot')
  const delegationBody = compactWorkBody(delegationSummary, 80, compactActionPresentation(delegationSummary.action!))
  assert.match(delegationBody.join('\n'), /Action:\s+Subagent · scout/, `the delegation-only body is meaningful:\n${delegationBody.join('\n')}`)
  assert.match(formatWorkHeaderLine(delegationSummary, false, 120), /1 action · subagent ×1/, 'the header count remains `subagent ×1`')
})

test('action slot: a failed command keeps its honest ✗ prefix', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('command/run', { commandId: 'cmd1', name: 'foo' }, T0 + 100, 1),
    eventAt('command/done', { commandId: 'cmd1', kind: 'error', text: 'unknown command' }, T0 + 300, 2),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.equal(summary.action?.kind, 'command')
  const body = compactWorkBody(summary, 80, compactActionPresentation(summary.action!))
  assert.match(body.join('\n'), /Action:\s+✗ \/foo/, body.join('\n'))
})

test('action slot: a retry-only Activity owns the Action with its own subtype stat', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('llm/retry', { turn: 1, step: 0, retry: 2, maxRetries: 6, delayMs: 3_000, failure: { code: 'AUTH' } }, T0 + 100, 1),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.deepEqual(statsOf(summary), { total: 1, types: { retry: 1 } }, 'the retry occurrence counts as its own action subtype')
  assert.equal(summary.action?.kind, 'retry')
  const body = compactWorkBody(summary, 80, compactActionPresentation(summary.action!))
  assert.match(body.join('\n'), /Action:\s+Retry 2\/6 in 3s · authentication failed/, body.join('\n'))
  assert.match(formatWorkHeaderLine(summary, false, 120), /1 action · retry ×1/, 'the retry is never a tool stat')
})

test('action slot: mixed chronology keeps counts independent from the Action', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 100, 1),
    toolResultEvent(1, 'c1', T0 + 200, 2),
    toolCall(1, 'c2', 'bash', T0 + 300, 3),
    toolResultEvent(1, 'c2', T0 + 400, 4),
    eventAt('subagent/descriptor', { label: 'reviewer', mode: 'task' }, T0 + 500, 5),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  assert.deepEqual(statsOf(summary), { total: 3, types: { read: 1, bash: 1, subagent: 1 } }, 'the genuine calls still count')
  assert.equal(summary.action?.kind, 'subagent', 'the chronologically-latest candidate owns the slot')
  const body = compactWorkBody(summary, 80, compactActionPresentation(summary.action!))
  assert.match(body.join('\n'), /Action:\s+Subagent · reviewer/, body.join('\n'))
  assert.match(formatWorkHeaderLine(summary, false, 120), /3 actions · bash ×1 · read ×1 · subagent ×1/, 'the Action and the stats answer different questions')
})

test('action slot: Preparing temporarily overrides the durable Action candidate', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('subagent/descriptor', { label: 'scout' }, T0 + 100, 1),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  const body = compactWorkBody(summary, 80, compactActionPresentation(summary.action!), 'Preparing Edit…')
  assert.match(body.join('\n'), /Action:\s+Preparing Edit…/, `the live call owns the slot:\n${body.join('\n')}`)
  assert.ok(!body.some(line => line.includes('Subagent')), 'the durable candidate is overridden while Preparing')
})

test('singleton stats: `1 action` with its subtype stays visible (no singleton suppression)', () => {
  const oneTool = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 100, 1),
    toolResultEvent(1, 'c1', T0 + 200, 2),
  ])
  const toolSummary = summarizeWorkSpan(spansOf(oneTool.messages())[0]!)
  assert.equal(toolSummary.action?.kind, 'tool')
  assert.match(formatWorkHeaderLine(toolSummary, false, 120), /1 action · read ×1/, 'the current header keeps the singleton action stat')
  const oneSubagent = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('subagent/descriptor', { label: 'scout' }, T0 + 100, 1),
  ])
  const subagentSummary = summarizeWorkSpan(spansOf(oneSubagent.messages())[0]!)
  assert.match(formatWorkHeaderLine(subagentSummary, false, 120), /1 action · subagent ×1/, 'the current header keeps `subagent ×1`')
})

test('timing: a long final-text tail never stretches the Thinking span', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [
          { type: 'reasoning', text: 'brief thought' },
          { type: 'text', text: 'a very long final answer' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'brief thought' } },
        { type: 'chunk', time: T0 + 2_000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'brief thought' } } },
        { type: 'chunk', time: T0 + 3_000, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'chunk', time: T0 + 3_000, chunk: { type: 'text-delta', index: 1, text: 'a very long final answer' } },
        { type: 'chunk', time: T0 + 30_000, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'a very long final answer' } } },
      ],
    }, T0 + 31_000, 1),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 32_000, 2),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  // §25: the Thinking span must stop at its reasoning block-end (T0+2s);
  // the 27s text tail is Conversation evidence and never stretches it.
  assert.equal(summary.timing?.endedAt, T0 + 2_000, 'the Thinking span ignores the text tail')
  assert.equal(summary.timing?.startedAt, T0 + 1_000)
  const header = formatWorkHeaderLine(summary, false, 120, 'emoji', '1s')
  assert.match(header, /Activity 1s/, `no 29s stretch:\n${header}`)
})

test('timing: a streamless settlement keeps the last live reasoning evidence as the end', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  // Live reasoning streams (two accepted deltas) but the durable
  // `assistant/message` arrives WITHOUT the embedded stream (legacy log):
  // the last accepted reasoning evidence is the row's honest end.
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking ' } })
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 2_500, chunk: { type: 'reasoning-delta', index: 0, text: 'harder' } })
  folder.apply([eventAt('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: MessageId('a1'), role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking harder' },
        { type: 'text', text: 'done' },
      ],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, T0 + 9_000, 1)])
  const thinkingRow = folder.messages().find(message => message.kind === 'thinking')
  assert.ok(thinkingRow !== undefined && thinkingRow.kind === 'thinking')
  const timing = transcriptTimingOf(thinkingRow)
  assert.equal(timing?.startedAt, T0 + 1_000)
  assert.equal(timing?.endedAt, T0 + 2_500, 'the streamless settlement falls back to the last reasoning evidence, not end-less')
  assert.equal(timing?.running, false)
})

test('timing: Preparing continuity survives a delayed formal call id', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  // The first deltas carry NO formal id yet (the preview keys on
  // turn/step/index); the formal id arrives 3s later, the durable call 1s
  // after that. The earliest delta owns the start (§12.14).
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'tool-call-delta', index: 2, id: '', name: 'bash', argumentsDelta: '{"c"' } })
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 4_000, chunk: { type: 'tool-call-delta', index: 2, id: 'late-1', name: 'bash', argumentsDelta: '}' } })
  folder.apply([toolCall(1, 'late-1', 'bash', T0 + 5_000, 1)])
  const card = folder.messages().findLast(message => message.kind === 'tool' && message.name === 'bash')
  assert.ok(card !== undefined && card.kind === 'tool', 'fixture: the durable call card exists')
  assert.equal(transcriptTimingOf(card)?.startedAt, T0 + 1_000, 'the delayed-id handoff inherits the fallback identity start')
  assert.equal(transcriptTimingOf(card)?.running, true)
})

test('timing: a retried attempt never lends its preparing start to a reused call id', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  // Attempt A prepares (no formal id yet)…
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a1', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'tool-call-delta', index: 2, id: '', name: 'bash', argumentsDelta: '{"c"' } })
  // …then the retry invalidates the attempt's preparing evidence.
  folder.apply([eventAt('llm/retry', { turn: 1, step: 0, retry: 1, delayMs: 1_000, failure: { code: 'X', message: 'x' } }, T0 + 2_000, 1)])
  folder.applyLiveInput({ kind: 'start', sessionId: 's', attemptId: 'a2', turn: 1, step: 0 })
  // Attempt B reuses the SAME identity (empty id → formal id → durable call).
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a2', turn: 1, step: 0, time: T0 + 5_000, chunk: { type: 'tool-call-delta', index: 2, id: '', name: 'bash', argumentsDelta: '{"c"' } })
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a2', turn: 1, step: 0, time: T0 + 6_000, chunk: { type: 'tool-call-delta', index: 2, id: 'reused-1', name: 'bash', argumentsDelta: '}' } })
  folder.apply([toolCall(1, 'reused-1', 'bash', T0 + 7_000, 2)])
  const card = folder.messages().findLast(message => message.kind === 'tool' && message.name === 'bash')
  assert.ok(card !== undefined && card.kind === 'tool')
  assert.equal(transcriptTimingOf(card)?.startedAt, T0 + 5_000, 'attempt B starts at its OWN first delta, never attempt A timer')
})

test('timing: live folding and cold hydration produce the same Activity timing', () => {
  const durableEvents: SessionEvent[] = [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 2_000, 1),
    toolResultEvent(1, 'c1', T0 + 5_000, 2),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'done' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } },
        { type: 'chunk', time: T0 + 1_500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } } },
        { type: 'chunk', time: T0 + 6_000, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'chunk', time: T0 + 6_000, chunk: { type: 'text-delta', index: 1, text: 'done' } },
        { type: 'chunk', time: T0 + 6_200, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } } },
      ],
    }, T0 + 6_000, 3),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 7_000, 4),
  ]
  // The LIVE folder saw the same reasoning deltas through the transient
  // plane BEFORE the durable settlement; the COLD folder only hydrates the
  // durable log. The Activity timing must agree.
  const live = new TranscriptFolder()
  live.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } })
  for (const event of durableEvents) live.apply([event])
  const cold = new TranscriptFolder()
  cold.hydrate(durableEvents)
  const liveSummary = summarizeWorkSpan(spansOf(live.messages())[0]!)
  const coldSummary = summarizeWorkSpan(spansOf(cold.messages())[0]!)
  assert.deepEqual(liveSummary.timing, coldSummary.timing, 'live and cold agree')
  assert.equal(liveSummary.timing?.startedAt, T0 + 1_000)
  // The span's end is the tool result (T0+5s): the Thinking lane ended at
  // its own reasoning block-end (T0+1.5s), the text tail is Conversation.
  assert.equal(liveSummary.timing?.endedAt, T0 + 5_000)
  assert.deepEqual(liveSummary.think, coldSummary.think)
})

test('timing: read grouping never crosses a turn boundary (per-turn ownership)', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 1_000, 1),
    toolResultEvent(1, 'c1', T0 + 2_000, 2),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 2_500, 3),
    eventAt('turn/start', { turn: 2 }, T0 + 3_000, 4),
    toolCall(2, 'c2', 'read', T0 + 4_000, 5),
    toolResultEvent(2, 'c2', T0 + 6_000, 6),
  ])
  const messages = folder.messages()
  // Reads in DIFFERENT turns never merge into one cross-turn card: each
  // turn's Activity owns its own count and timing.
  assert.ok(!messages.some(message => message.kind === 'tool' && message.args === '2 files'),
    'a group must not cross a turn boundary')
  const turn1 = summarizeWorkSpan(spansOf(messages).find(span => span.turn === 1)!)
  const turn2 = summarizeWorkSpan(spansOf(messages).find(span => span.turn === 2)!)
  assert.equal(turn1.actionStats.total, 1)
  assert.equal(turn1.timing?.startedAt, T0 + 1_000)
  assert.equal(turn1.timing?.endedAt, T0 + 2_000)
  assert.equal(turn2.actionStats.total, 1)
  assert.equal(turn2.timing?.startedAt, T0 + 4_000)
  assert.equal(turn2.timing?.endedAt, T0 + 6_000)
  // Full Focus/Activity parity on BOTH turns.
  assert.deepEqual(genuineToolTypes(turn1), folder.turnActivities().get(1)?.tools)
  assert.deepEqual(genuineToolTypes(turn2), folder.turnActivities().get(2)?.tools)
})

test('timing: a next-turn read starts a NEW run and never touches the previous group', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 1_000, 1),
    toolResultEvent(1, 'c1', T0 + 2_000, 2),
  ])
  folder.apply([
    toolCall(1, 'c2', 'read', T0 + 3_000, 3),
    toolResultEvent(1, 'c2', T0 + 4_000, 4),
  ])
  // Precondition: the turn-1 same-turn group is merged and timed.
  const merged = folder.messages().find(message => message.kind === 'tool' && message.args === '2 files')
  assert.ok(merged !== undefined && merged.kind === 'tool', 'fixture: the same-turn group formed')
  assert.equal(merged.turn, 1)
  const groupTiming = transcriptTimingOf(merged)
  assert.equal(groupTiming?.startedAt, T0 + 1_000)
  assert.equal(groupTiming?.endedAt, T0 + 4_000)
  // A third read settles in the NEXT turn: it starts its OWN run — the
  // turn-1 group stays exactly as it was.
  folder.apply([
    eventAt('turn/start', { turn: 2 }, T0 + 5_000, 5),
    toolCall(2, 'c3', 'read', T0 + 6_000, 6),
    toolResultEvent(2, 'c3', T0 + 8_000, 7),
  ])
  const messages = folder.messages()
  assert.ok(!messages.some(message => message.kind === 'tool' && message.args === '3 files'),
    'the next-turn read must not extend the previous group')
  const untouched = messages.find(message => message.kind === 'tool' && message.args === '2 files')
  assert.ok(untouched !== undefined && untouched.kind === 'tool')
  assert.equal(untouched.turn, 1)
  const still = transcriptTimingOf(untouched)
  assert.equal(still?.startedAt, T0 + 1_000)
  assert.equal(still?.endedAt, T0 + 4_000)
  // Turn 2 owns exactly its own read — full Focus/Activity parity.
  const turn2 = summarizeWorkSpan(spansOf(messages).find(span => span.turn === 2)!)
  assert.equal(turn2.actionStats.total, 1)
  assert.deepEqual(genuineToolTypes(turn2), folder.turnActivities().get(2)?.tools)
  assert.equal(turn2.timing?.startedAt, T0 + 6_000)
  assert.equal(turn2.timing?.endedAt, T0 + 8_000)
})

test('stats: an orphan tool/result (no seen call) never counts as a genuine tool call', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    // A result whose call was never seen (post-compaction fragment): the
    // fold materializes the card, but no genuine tool/call event exists.
    toolResultEvent(1, 'orphan-1', T0 + 1_000, 1),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.equal(summary.actionStats.total, 0, 'an orphan result is not a genuine tool action')
  assert.equal(summary.action?.kind, 'orphan-tool-result', 'the orphan owns the Action with the honest diagnostic')
  const body = compactWorkBody(summary, 80, compactActionPresentation(summary.action!))
  assert.match(body.join('\n'), /Action:\s+Unpaired tool result/, `never a normal successful Tool:\n${body.join('\n')}`)
  // The same counting unit as the Focus header: Focus also counts ZERO.
  assert.equal(folder.turnActivities().get(1)?.toolCalls, 0)
  assert.equal(summary.actionStats.total, 0)
})

test('timing: a retried attempt never lends its preparing start to a reused call id', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  // Attempt A prepares WITH a formal id…
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a1', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'tool-call-delta', index: 2, id: 'reused-1', name: 'bash', argumentsDelta: '{"c"' } })
  // …then the retry invalidates the attempt's preparing evidence — BOTH
  // the fallback identity and the formal call id.
  folder.apply([eventAt('llm/retry', { turn: 1, step: 0, retry: 1, delayMs: 1_000, failure: { code: 'X', message: 'x' } }, T0 + 2_000, 1)])
  folder.applyLiveInput({ kind: 'start', sessionId: 's', attemptId: 'a2', turn: 1, step: 0 })
  // Attempt B reuses the SAME formal id.
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a2', turn: 1, step: 0, time: T0 + 5_000, chunk: { type: 'tool-call-delta', index: 2, id: 'reused-1', name: 'bash', argumentsDelta: '{"c"' } })
  folder.apply([toolCall(1, 'reused-1', 'bash', T0 + 7_000, 2)])
  const card = folder.messages().findLast(message => message.kind === 'tool' && message.name === 'bash')
  assert.ok(card !== undefined && card.kind === 'tool')
  assert.equal(transcriptTimingOf(card)?.startedAt, T0 + 5_000, 'attempt B starts at its OWN delta, never attempt A timer')
})

test('timing: a retried Thinking re-records the new attempt start', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  // Attempt 1 streams reasoning; its live plane closes as COMMITTED (the
  // entry stays mounted, closed) while the step itself never settled.
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a1', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'first attempt' } })
  folder.applyLiveInput({ kind: 'end', sessionId: 's', attemptId: 'a1', turn: 1, step: 0, status: 'committed' })
  // Attempt 2 reopens the SAME (turn, step): the reopen clears the stale
  // sidecar, and the new attempt's FIRST chunk must re-record the start
  // (post-F6 plan §12.6) — otherwise the streaming reasoning runs UNTIMED.
  folder.applyLiveInput({ kind: 'start', sessionId: 's', attemptId: 'a2', turn: 1, step: 0 })
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a2', turn: 1, step: 0, time: T0 + 5_000, chunk: { type: 'reasoning-delta', index: 0, text: 'second attempt' } })
  const thinking = folder.messages().find(message => message.kind === 'thinking' && message.text.includes('second attempt'))
  assert.ok(thinking !== undefined && thinking.kind === 'thinking', 'fixture: the reopened reasoning row exists')
  const timing = transcriptTimingOf(thinking)
  assert.ok(timing !== undefined, 'the reopened reasoning must carry timing evidence while it streams')
  assert.equal(timing.startedAt, T0 + 5_000, 'the start is the NEW attempt first chunk, not the old one')
  assert.equal(timing.running, true, 'the new attempt is still streaming')
  assert.equal(timing.endedAt, undefined, 'no fabricated end while running')
})

test('timing: a reopened Thinking never inherits the PREVIOUS attempt evidence', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  // Attempt 1 streams reasoning and its live plane closes committed.
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a1', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'first attempt' } })
  folder.applyLiveInput({ kind: 'end', sessionId: 's', attemptId: 'a1', turn: 1, step: 0, status: 'committed' })
  // Attempt 2 reopens the SAME (turn, step) but closes WITHOUT producing
  // any new reasoning evidence: the previous attempt's last-evidence time
  // is stale and must not survive as attempt 2's point.
  folder.applyLiveInput({ kind: 'start', sessionId: 's', attemptId: 'a2', turn: 1, step: 0 })
  folder.applyLiveInput({ kind: 'end', sessionId: 's', attemptId: 'a2', turn: 1, step: 0, status: 'committed' })
  const thinking = folder.messages().find(message => message.kind === 'thinking' && message.text === '')
  assert.ok(thinking !== undefined && thinking.kind === 'thinking', 'fixture: the reopened (evidence-free) row exists')
  assert.equal(transcriptTimingOf(thinking), undefined, 'stale attempt-A evidence must not become attempt-B point timing')
})

test('timing: a thinking-only Activity wall-spans its reasoning evidence', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [
          { type: 'reasoning', text: 'only reasoning' },
          { type: 'text', text: 'answer' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'only reasoning' } },
        { type: 'chunk', time: T0 + 3_000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'only reasoning' } } },
        { type: 'chunk', time: T0 + 4_000, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'chunk', time: T0 + 4_000, chunk: { type: 'text-delta', index: 1, text: 'answer' } },
        { type: 'chunk', time: T0 + 4_500, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } } },
      ],
    }, T0 + 5_000, 1),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 6_000, 2),
  ])
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.equal(summary.actionStats.total, 0, 'a thinking-only Activity has no actions')
  assert.equal(summary.action, undefined, 'Thinking evidence never owns the Action slot')
  assert.equal(summary.timing?.startedAt, T0 + 1_000, 'the span starts with the reasoning lane')
  // The Thinking span ends at its OWN reasoning block-end (T0+3s); the
  // later text lane (T0+4s–4.5s) is Conversation evidence, never Process.
  assert.equal(summary.timing?.endedAt, T0 + 3_000, 'the text tail never stretches the Thinking span')
  const header = formatWorkHeaderLine(summary, false, 120, 'emoji', '2s')
  assert.ok(!header.includes('action'), `no action stat:\n${header}`)
  assert.match(header, /Activity 2s/)
})

test('timing: a running Thinking shows a live Activity duration', () => {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  folder.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'streaming reasoning...' } })
  const span = spansOf(folder.messages())[0]!
  const summary = summarizeWorkSpan(span)
  assert.equal(summary.timing?.running, true, 'the reasoning row is still streaming')
  assert.equal(summary.timing?.startedAt, T0 + 1_000)
  assert.equal(summary.think?.running, true)
  const component = new CompactWorkComponent({ span, expanded: false, now: () => T0 + 4_500 })
  const line = (component.render(120)[0] ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(line, /Activity 3s/, `the running header reads now at render:\n${line}`)
})

// ── Activity header degradation + the no-token contract (addendum v2 §24/§25/§50) ──

test('Activity header degrades duration→stats without tokens and never fabricates tok', () => {
  const folder = fold([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall(1, 'c1', 'read', T0 + 1_000, 1),
    toolResultEvent(1, 'c1', T0 + 2_000, 2),
    toolCall(1, 'c2', 'bash', T0 + 3_000, 3),
    toolResultEvent(1, 'c2', T0 + 9_000, 4),
    eventAt('subagent/descriptor', { label: 'scout' }, T0 + 9_500, 5),
  ])
  const summary = summarizeWorkSpan(spansOf(folder.messages())[0]!)
  // duration + full stats.
  assert.equal(formatWorkHeaderLine(summary, false, 120, 'emoji', '9s'), '▸ Activity 9s · 3 actions · bash ×1 · read ×1 · subagent ×1')
  // duration + action total only.
  assert.equal(formatWorkHeaderLine(summary, false, 34, 'emoji', '9s'), '▸ Activity 9s · 3 actions')
  // duration only, then the bare identity.
  assert.equal(formatWorkHeaderLine(summary, false, 16, 'emoji', '9s'), '▸ Activity 9s')
  assert.equal(formatWorkHeaderLine(summary, false, 11, 'emoji', '9s'), '▸ Activity')
  // Without duration: full stats → total → identity.
  assert.equal(formatWorkHeaderLine(summary, false, 120), '▸ Activity · 3 actions · bash ×1 · read ×1 · subagent ×1')
  assert.equal(formatWorkHeaderLine(summary, false, 24), '▸ Activity · 3 actions')
  assert.equal(formatWorkHeaderLine(summary, false, 10), '▸ Activity')
  // The Activity header NEVER renders a token segment under any width.
  for (const width of [8, 12, 20, 40, 80, 120]) {
    const header = formatWorkHeaderLine(summary, false, width, 'emoji', '9s')
    assert.ok(!header.includes('tok'), `no fabricated span tokens at width ${width}:\n${header}`)
  }
})
