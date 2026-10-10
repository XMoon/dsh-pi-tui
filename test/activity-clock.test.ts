/**
 * UX-2 (three-UX-fixes plan §5): the Activity LIFETIME clock.
 *
 * An Activity's displayed duration is the wall-clock span of the Process run,
 * not the member timing's settle: it keeps counting through the model's silent
 * wait and freezes at the first PROVEN structural boundary (an actually-visible
 * Conversation/Context row, or `turn/end`). These tests drive the real fold →
 * canonical structure → lifetime derivation → card render chain, plus one REAL
 * wall-clock repaint-tick proof that the existing WorkingIndicator heartbeat is
 * the only driver (no `setTranscript`, no input, no second timer).
 * @module @xmoon76/dsh-pi-tui/activity-clock.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { CompactWorkComponent } from '../src/tui/components/transcript/compact-work.ts'
import { projectTranscriptStructure, type TranscriptWorkSpan } from '../src/tui/transcript/structure.ts'
import { summarizeWorkSpan } from '../src/tui/transcript/work-summary.ts'
import { activityClockOf, resolveWorkLifetimes, type ActivityClock, type WorkLifetime } from '../src/tui/transcript/activity-clock.ts'
import { enterChildDisplaySubject } from './support/display-subject.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const T0 = 1_700_000_000_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

function toolCall(callId: string, name: string, time: number, seq: number): SessionEvent {
  return eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId(callId), name, arguments: '{}' }, time, seq)
}

function toolResult(callId: string, time: number, seq: number): SessionEvent {
  return eventAt('tool/result', {
    turn: 1, step: 0,
    message: {
      id: `r-${callId}`, role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, time, seq)
}

function foldEvents(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  return folder
}

/** ONE canonical projection of a folder: its Work spans and their lifetimes
 *  (the lifetime map is keyed by span object identity, so it must be built
 *  once and read back with the SAME span objects). */
function analyze(folder: TranscriptFolder): {
  lifetimes: ReadonlyMap<TranscriptMessage, WorkLifetime>
  spans: readonly TranscriptWorkSpan[]
} {
  const structure = projectTranscriptStructure(folder.messages())
  const spans: TranscriptWorkSpan[] = []
  for (const block of structure) {
    if (block.kind === 'work') spans.push(block.span)
  }
  return { lifetimes: resolveWorkLifetimes(structure, folder.turnActivities()), spans }
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** The FIRST rendered Activity duration in seconds of one plain viewport. */
function durationSeconds(view: string): number {
  const match = /Activity (\d+)s/u.exec(view)
  assert.ok(match !== null, `no Activity duration rendered:\n${view}`)
  return Number(match[1])
}

/** Commit the child's activity flip directly — the official Remote snapshot
 *  channel shape: no `setViewerMode`, so the viewer's entry-time activity keeps
 *  its stale value and only the committed display subject moves. */
function commitChildActivity(app: TuiApp, activity: 'running' | 'inactive'): void {
  app.commitDisplaySubject(
    { view: { subject: { kind: 'subagent', id: 'child-a', label: 'child A', mode: 'continuable', activity } } },
    {},
    { sessionId: 'child-a', workspaceRoot: '/ws/a', title: '', todos: [], goal: undefined },
  )
}

/** The Activity header line of one span at a fixed `now` with `clock`. */
function headerAt(span: TranscriptWorkSpan, clock: ActivityClock | undefined, now: number): string {
  const component = new CompactWorkComponent({
    span, expanded: false, now: () => now,
    ...(clock === undefined ? {} : { clock }),
  })
  return strip(component.render(120)[0] ?? '')
}

test('a settled trailing Tool stays OPEN: the lifetime, not the member flag, decides live', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
  ])
  const { lifetimes, spans } = analyze(folder)
  const span = spans[0]!
  const lifetime = lifetimes.get(span.owner)!
  // The MEMBER evidence still ends at the tool result…
  assert.equal(summarizeWorkSpan(span).timing?.endedAt, T0 + 5_000)
  // …but the Activity is still open, because nothing actually visible closed it.
  assert.deepEqual(lifetime, { startedAt: T0 + 1_000, open: true, trailing: true })
  // A live tail whose displayed subject runs keeps counting; history and an
  // inactive subject do not.
  assert.equal(activityClockOf(lifetime, () => true, () => true).isLive(), true)
  assert.equal(activityClockOf(lifetime, () => true, () => false).isLive(), false, 'an inactive subject is never live')
  assert.equal(activityClockOf(lifetime, () => false, () => true).isLive(), false, 'a history window is never live')
})

test('the silent wait keeps counting: the same value before and after the Conversation boundary lands', () => {
  const before = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
  ])
  const beforeAnalysis = analyze(before)
  const beforeSpan = beforeAnalysis.spans[0]!
  const beforeLifetime = beforeAnalysis.lifetimes.get(beforeSpan.owner)!
  // At +45s the model is still silent: the Activity reads now - start = 44s —
  // NOT the member's 4s.
  const live = headerAt(beforeSpan, activityClockOf(beforeLifetime, () => true, () => true), T0 + 45_000)
  assert.match(live, /Activity 44s/, `the silent wait must keep counting:\n${live}`)

  // The assistant's first visible text lands at +45s: the SAME span closes at
  // that proven boundary — the displayed value does not jump.
  const after = new TranscriptFolder()
  after.hydrate([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
  ])
  after.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 45_000,
    chunk: { type: 'text-delta', index: 1, text: 'the answer' },
  })
  const afterAnalysis = analyze(after)
  const afterSpan = afterAnalysis.spans[0]!
  const afterLifetime = afterAnalysis.lifetimes.get(afterSpan.owner)!
  assert.equal(afterLifetime.endedAt, T0 + 45_000,
    'the first actually-visible assistant text owns the close — never the earlier member settlement')
  assert.equal(afterLifetime.open, false)
  const closed = headerAt(afterSpan, activityClockOf(afterLifetime, () => true, () => true), T0 + 999_999)
  assert.match(closed, /Activity 44s/, `the frozen value must equal the live value (no jump):\n${closed}`)
})

test('Work A -> Context -> Work B: A freezes at the context time and B counts from its own members', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'read', T0 + 1_000, 1),
    toolResult('c1', T0 + 2_000, 2),
    // An injected Context row (skill invocation) at +10s is a real boundary.
    eventAt('user/message', {
      id: 'ctx-1', content: [{ type: 'text', text: 'context body' }],
      source: { kind: 'skill-invocation', name: 'demo' },
    }, T0 + 10_000, 3),
    toolCall('c2', 'bash', T0 + 20_000, 4),
  ])
  const { lifetimes, spans } = analyze(folder)
  assert.equal(spans.length, 2, 'two distinct Activity spans')
  const a = lifetimes.get(spans[0]!.owner)!
  const b = lifetimes.get(spans[1]!.owner)!
  assert.deepEqual(a, { startedAt: T0 + 1_000, endedAt: T0 + 10_000, open: false, trailing: false })
  assert.deepEqual(b, { startedAt: T0 + 20_000, open: true, trailing: true })
  assert.equal(activityClockOf(a, () => true, () => true).isLive(), false, 'A is closed even on a live tail')
  const aClock = activityClockOf(a, () => true, () => true)
  assert.equal(headerAt(spans[0]!, aClock, T0 + 999_999), headerAt(spans[0]!, aClock, T0 + 11_000),
    'a closed Activity renders the same value at any now')
})

test('turn/end freezes the turn\u2019s last open Activity, and a proven structural boundary wins over it', () => {
  const ended = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 12_000, 3),
  ])
  const endedAnalysis = analyze(ended)
  const endedSpan = endedAnalysis.spans[0]!
  assert.deepEqual(endedAnalysis.lifetimes.get(endedSpan.owner),
    { startedAt: T0 + 1_000, endedAt: T0 + 12_000, open: false, trailing: true })

  // The structural boundary is EARLIER than the turn end: it wins.
  const boundary = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
    eventAt('user/message', { id: 'u1', content: [{ type: 'text', text: 'next prompt' }], source: { kind: 'user' } }, T0 + 8_000, 3),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 12_000, 4),
  ])
  const boundaryAnalysis = analyze(boundary)
  const boundarySpan = boundaryAnalysis.spans[0]!
  assert.equal(boundaryAnalysis.lifetimes.get(boundarySpan.owner)!.endedAt, T0 + 8_000,
    'the first actually-visible boundary closes the Activity, not the later turn end')
})

test('an unprovable end renders NO duration (unknown), never the member end or a Date.now() extension', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
  ])
  const { lifetimes, spans } = analyze(folder)
  const span = spans[0]!
  const historical = activityClockOf(lifetimes.get(span.owner)!, () => false, () => true)
  assert.equal(historical.isLive(), false)
  const line = headerAt(span, historical, T0 + 999_999)
  assert.ok(!/Activity \d/u.test(line),
    `an unprovable Activity end must hide the duration, never show the member end:\n${line}`)
  assert.ok(!line.includes('998s'), `a historical Activity must never read now:\n${line}`)
  assert.match(line, /Activity · 1 action/u, `the identity and the action stats stay:\n${line}`)
  // The member end is still a MEMBER fact — it is simply not the Activity end.
  assert.equal(summarizeWorkSpan(span).timing?.endedAt, T0 + 5_000)
})

test('the canonical trailing structure decides live: a Work followed by a Context row is not the tail', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
    // A command row is Context/control without its own time evidence: it is the
    // trailing canonical block, so the Work before it is not a live tail even
    // though no boundary time could be proven.
    eventAt('command/run', { commandId: 'cmd1', name: 'theme' }, T0 + 6_000, 3),
  ])
  const { lifetimes, spans } = analyze(folder)
  assert.equal(spans.length, 1)
  const lifetime = lifetimes.get(spans[0]!.owner)!
  assert.equal(lifetime.endedAt, undefined, 'the command row proves no boundary time')
  assert.equal(lifetime.trailing, false, 'a following canonical block means the span is not the tail')
  assert.equal(activityClockOf(lifetime, () => true, () => true).isLive(), false,
    'a non-trailing open Activity is never live')
  assert.ok(!/Activity \d/u.test(headerAt(spans[0]!, activityClockOf(lifetime, () => true, () => true), T0 + 999_999)),
    'an open non-tail Activity has no provable end: no duration renders')
})

test('an interleaved step derives the SAME Activity lifetime live and cold (review blocker: convergence)', () => {
  // The live lane materializes the assistant row on its FIRST VISIBLE text
  // chunk (so it precedes the tool card of the same step); the durable
  // settlement appends the assistant row at its own event index (after the
  // tool). The row provably became visible BEFORE the Work started, so it can
  // neither close the Work nor disqualify it as the live tail — the SAME
  // lifetime must come out of both folds, and the same duration must render.
  const events = (): SessionEvent[] => [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 2_000, 1),
    toolResult('c1', T0 + 3_000, 2),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'let me check' }], source: { kind: 'assistant' } },
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'text-delta', index: 0, text: 'let me check' } },
        { type: 'chunk', time: T0 + 2_000, chunk: { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' } },
      ],
    }, T0 + 4_000, 3),
  ]
  const cold = foldEvents(events())
  const live = new TranscriptFolder()
  live.hydrate([events()[0]!])
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000,
    chunk: { type: 'text-delta', index: 0, text: 'let me check' },
  })
  live.apply([events()[1]!, events()[2]!, events()[3]!])

  const coldAnalysis = analyze(cold)
  const liveAnalysis = analyze(live)
  const coldSpan = coldAnalysis.spans[0]!
  const liveSpan = liveAnalysis.spans[0]!
  assert.equal(coldAnalysis.spans.length, 1)
  assert.equal(liveAnalysis.spans.length, 1)
  // The MEMBER fact is unchanged in both folds…
  assert.equal(summarizeWorkSpan(coldSpan).timing?.endedAt, T0 + 3_000)
  assert.equal(summarizeWorkSpan(liveSpan).timing?.endedAt, T0 + 3_000)
  // …and the LIFETIME is identical: open + trailing (the early assistant row
  // belongs to the same step's lane order, not after this Activity).
  assert.deepEqual(coldAnalysis.lifetimes.get(coldSpan.owner), liveAnalysis.lifetimes.get(liveSpan.owner))
  assert.deepEqual(coldAnalysis.lifetimes.get(coldSpan.owner), { startedAt: T0 + 2_000, open: true, trailing: true })
  const coldClock = activityClockOf(coldAnalysis.lifetimes.get(coldSpan.owner)!, () => true, () => true)
  const liveClock = activityClockOf(liveAnalysis.lifetimes.get(liveSpan.owner)!, () => true, () => true)
  assert.equal(coldClock.isLive(), true, 'the cold fold is just as live as the live fold')
  assert.equal(headerAt(coldSpan, coldClock, T0 + 60_000), headerAt(liveSpan, liveClock, T0 + 60_000),
    'the same event sequence must render the same duration after a cold re-open')
  assert.match(headerAt(coldSpan, coldClock, T0 + 60_000), /Activity 58s/u)
})

test('pinned divergence (F6): a same-step text-before-tool settlement still splits the LIVE run and not the cold one', () => {
  // The canonical Work MEMBERSHIP is owned by the fold's row order, not by this
  // clock. Live materializes the assistant row at its first visible text (+2s,
  // before the step's tool row at +3s); cold appends the durable settlement
  // after that tool row, so the two tools become ONE contiguous Process run.
  // Read grouping merges raw-adjacent reads, so a display-only displacement
  // cannot repair this: it needs the fold's display-order unit (tracked
  // separately). This differential test is that unit's red-to-green witness.
  const events = (): SessionEvent[] => [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    // Different tool names on purpose: two consecutive settled READS would be
    // merged into ONE read-group card by the fold's raw-adjacency grouping,
    // which is an even stronger form of the same ownership divergence.
    eventAt('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' }, T0 + 1_000, 1),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: 'r1', role: 'tool', toolCallId: 'c1',
        content: [{ type: 'text', text: 'a' }], source: { kind: 'tool', callId: 'c1' },
      },
    }, T0 + 1_500, 2),
    eventAt('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"b"}' }, T0 + 3_000, 3),
    eventAt('tool/result', {
      turn: 1, step: 1,
      message: {
        id: 'r2', role: 'tool', toolCallId: 'c2',
        content: [{ type: 'text', text: 'b' }], source: { kind: 'tool', callId: 'c2' },
      },
    }, T0 + 4_000, 4),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'm1', role: 'assistant',
        content: [{ type: 'text', text: 'let me check' }], source: { kind: 'assistant' },
      },
      stream: [
        { type: 'chunk', time: T0 + 2_000, chunk: { type: 'text-delta', index: 0, text: 'let me check' } },
        { type: 'chunk', time: T0 + 3_000, chunk: { type: 'tool-call-delta', index: 1, id: 'c2', name: 'read', argumentsDelta: '{}' } },
      ],
    }, T0 + 5_000, 5),
  ]
  const cold = foldEvents(events())
  const live = new TranscriptFolder()
  live.hydrate([events()[0]!, events()[1]!, events()[2]!])
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 1, time: T0 + 2_000,
    chunk: { type: 'text-delta', index: 0, text: 'let me check' },
  })
  live.apply([events()[3]!, events()[4]!, events()[5]!])

  const coldStructure = projectTranscriptStructure(cold.messages())
  const liveStructure = projectTranscriptStructure(live.messages())
  const coldAnalysis = analyze(cold)
  const liveAnalysis = analyze(live)
  // VISIBLE ROW ORDER: the live fold shows the Conversation BEFORE the second
  // tool row; cold shows it after both.
  assert.deepEqual(live.messages().map(message => message.kind), ['tool', 'assistant', 'tool'])
  assert.deepEqual(cold.messages().map(message => message.kind), ['tool', 'tool', 'assistant'])
  // CANONICAL STRUCTURE: two Work spans live, one cold.
  assert.deepEqual(coldStructure.map(block => block.kind), ['work', 'message'])
  assert.deepEqual(liveStructure.map(block => block.kind), ['work', 'message', 'work'])
  assert.equal(liveAnalysis.spans.length, 2)
  assert.equal(coldAnalysis.spans.length, 1)
  // LIFETIMES: each fold is internally consistent, but they describe different
  // Activities for the same event sequence.
  assert.deepEqual(liveAnalysis.lifetimes.get(liveAnalysis.spans[0]!.owner),
    { startedAt: T0 + 1_000, endedAt: T0 + 2_000, open: false, trailing: false })
  assert.deepEqual(liveAnalysis.lifetimes.get(liveAnalysis.spans[1]!.owner),
    { startedAt: T0 + 3_000, open: true, trailing: true })
  assert.deepEqual(coldAnalysis.lifetimes.get(coldAnalysis.spans[0]!.owner),
    { startedAt: T0 + 1_000, endedAt: T0 + 4_000, open: false, trailing: true })
})

test('a settled surfaced interaction closes the preceding Activity at the tool start, not the human wait', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 2_000, 2),
    // The agent hands control to the human at +3s and the answer arrives at
    // +30s: the waiting time is NOT part of the old Activity.
    toolCall('c2', 'ask_user_question', T0 + 3_000, 3),
    toolResult('c2', T0 + 30_000, 4),
  ])
  const { lifetimes, spans } = analyze(folder)
  assert.ok(spans.length >= 1, 'the pre-interaction tooling forms an Activity')
  const lifetime = lifetimes.get(spans[0]!.owner)!
  assert.equal(lifetime.endedAt, T0 + 3_000,
    'the interaction tool start is the boundary, never the human answer arrival')
  const line = headerAt(spans[0]!, activityClockOf(lifetime, () => true, () => true), T0 + 999_999)
  assert.match(line, /Activity 2s/, `the human wait is not counted into the old Activity:\n${line}`)
})

test('a RUNNING human interaction freezes the Activity at the hand-over instant, identical after it settles (review blocker)', () => {
  // While `ask_user_question` / `exit_plan_mode` is RUNNING it is still a
  // Process member (its active panel owns the UI), so the span keeps growing —
  // unless the lifetime reads the interaction start, which is exactly the
  // moment the agent handed control to the human. The waiting time is never
  // counted, and the value must NOT jump when the tool settles and the card
  // leaves the span for a standalone successor boundary.
  const running = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'read', T0 + 1_000, 1),
    toolResult('c1', T0 + 2_000, 2),
    toolCall('c2', 'ask_user_question', T0 + 3_000, 3),
  ])
  const runningAnalysis = analyze(running)
  const runningSpan = runningAnalysis.spans[0]!
  const runningLifetime = runningAnalysis.lifetimes.get(runningSpan.owner)!
  assert.deepEqual(runningLifetime, { startedAt: T0 + 1_000, endedAt: T0 + 3_000, open: false, trailing: true },
    'the running interaction start is the boundary')
  const runningClock = activityClockOf(runningLifetime, () => true, () => true)
  assert.equal(runningClock.isLive(), false, 'the human wait is not Activity liveness')
  const runningLine = headerAt(runningSpan, runningClock, T0 + 999_999)
  assert.match(runningLine, /Activity 2s/u,
    `the waiting time is never counted, and no now() extension happens:\n${runningLine}`)

  // The user answers at +30s: the tool settles and becomes a standalone
  // surfaced-interaction card — the SAME +3s boundary, so the display does not
  // regress (the old per-successor rule would have frozen it back to +3s only
  // AFTER showing ~29s).
  const settled = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'read', T0 + 1_000, 1),
    toolResult('c1', T0 + 2_000, 2),
    toolCall('c2', 'ask_user_question', T0 + 3_000, 3),
    toolResult('c2', T0 + 30_000, 4),
  ])
  const settledAnalysis = analyze(settled)
  const settledSpan = settledAnalysis.spans[0]!
  const settledLifetime = settledAnalysis.lifetimes.get(settledSpan.owner)!
  assert.equal(settledLifetime.endedAt, runningLifetime.endedAt,
    'the settled interaction keeps the SAME boundary (the settled card is now a following block, which only clears the tail bit)')
  assert.equal(settledLifetime.open, runningLifetime.open)
  assert.equal(headerAt(settledSpan, activityClockOf(settledLifetime, () => true, () => true), T0 + 999_999),
    runningLine, 'the displayed value is identical before and after the answer')
})

test('a Remote snapshot-only inactive flip never regresses a running Activity (review blocker)', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    workingIntervalMs: 10_000,
  })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())

  let transcriptCommits = 0
  const setTranscript = app.setTranscript.bind(app)
  app.setTranscript = (...args: Parameters<typeof setTranscript>): void => {
    transcriptCommits += 1
    setTranscript(...args)
  }
  const now = Date.now()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, now - 12_000, 0),
    toolCall('c1', 'bash', now - 11_500, 1),
    toolResult('c1', now - 11_000, 2),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  enterChildDisplaySubject(app, {
    id: 'child-a', label: 'child A', mode: 'continuable', activity: 'running',
    cwd: '/ws/a', turns: 1, steps: 1,
  })
  await vt.waitForRender()
  const running = durationSeconds(strip(vt.getViewport().join('\n')))
  assert.ok(running >= 11, `the running child counts from its own start:\n${strip(vt.getViewport().join('\n'))}`)

  // The official snapshot channel flips the child inactive with NO durable
  // event and NO `setTranscript`. The last member ended 11s ago, but that is
  // NOT the Activity's end: the card must not regress to it.
  commitChildActivity(app, 'inactive')
  await vt.waitForRender()
  const inactiveView = strip(vt.getViewport().join('\n'))
  assert.ok(inactiveView.includes('Activity'), `the Activity card stays:\n${inactiveView}`)
  assert.ok(!/Activity \d+[sm]/u.test(inactiveView),
    `an unprovable end must hide the duration instead of regressing to the member span:\n${inactiveView}`)

  // Running again: the count resumes from the SAME start (no state was lost).
  commitChildActivity(app, 'running')
  await vt.waitForRender()
  const resumed = durationSeconds(strip(vt.getViewport().join('\n')))
  assert.ok(resumed >= running,
    `resuming must not show less than the value the user already saw (${running}s -> ${resumed}s)`)
  assert.equal(transcriptCommits, 1, 'the snapshot flip must not re-commit the transcript')
})

test('F4: an interaction that IS the Activity freezes at its own start, before and after it settles', () => {
  for (const name of ['ask_user_question', 'exit_plan_mode'] as const) {
    const running = foldEvents([
      eventAt('turn/start', { turn: 1 }, T0, 0),
      // The FIRST and ONLY Process member is the interaction itself: the span
      // start IS the hand-over, so the human wait can never be counted.
      toolCall('q1', name, T0 + 3_000, 1),
    ])
    const runningAnalysis = analyze(running)
    assert.equal(runningAnalysis.spans.length, 1)
    const span = runningAnalysis.spans[0]!
    const lifetime = runningAnalysis.lifetimes.get(span.owner)!
    assert.deepEqual(lifetime, { startedAt: T0 + 3_000, endedAt: T0 + 3_000, open: false, trailing: true },
      `${name}: the hand-over IS the Activity`)
    const clock = activityClockOf(lifetime, () => true, () => true)
    assert.equal(clock.isLive(), false, `${name}: the human wait is never Activity liveness`)
    const line = headerAt(span, clock, T0 + 999_999)
    assert.ok(!/Activity \d/u.test(line), `${name}: a zero-length Activity renders no duration:\n${line}`)
    assert.ok(!line.includes('996s') && !line.includes('0s'), `${name}: never now() nor a fake 0s:\n${line}`)

    // After the answer the interaction leaves the span entirely (human-decision
    // evidence, not Process work): the Activity card disappears rather than
    // showing the waiting time.
    const settled = foldEvents([
      eventAt('turn/start', { turn: 1 }, T0, 0),
      toolCall('q1', name, T0 + 3_000, 1),
      toolResult('q1', T0 + 33_000, 2),
    ])
    assert.equal(analyze(settled).spans.length, 0, `${name}: a settled lone interaction is no Activity`)
  }
})

test('F5: the owning turn/end caps the Activity — a later turn never rewrites a frozen end', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 6_000, 3),
  ])
  const before = analyze(folder)
  const span = before.spans[0]!
  const frozen = before.lifetimes.get(span.owner)!
  assert.deepEqual(frozen, { startedAt: T0 + 1_000, endedAt: T0 + 6_000, open: false, trailing: true })
  const historicalClock = activityClockOf(frozen, () => false, () => true)
  const beforeLine = headerAt(span, historicalClock, T0 + 9_999_999)
  assert.match(beforeLine, /Activity 5s/u)

  // An hour later the user sends the next prompt: the OLD Activity is frozen at
  // its own turn/end and must NOT absorb the idle time between turns.
  folder.apply([
    eventAt('turn/start', { turn: 2 }, T0 + 3_600_000, 4),
    eventAt('user/message', { id: 'u2', content: [{ type: 'text', text: 'next prompt' }], source: { kind: 'user' } }, T0 + 3_600_001, 5),
  ])
  const after = analyze(folder)
  const afterSpan = after.spans.find(candidate => candidate.owner === span.owner)
  assert.ok(afterSpan !== undefined, 'the frozen Activity is still the same span')
  assert.deepEqual(after.lifetimes.get(afterSpan.owner), frozen,
    'a later turn must not rewrite the frozen end')
  assert.equal(headerAt(afterSpan, activityClockOf(after.lifetimes.get(afterSpan.owner)!, () => false, () => true), T0 + 9_999_999),
    beforeLine, 'the rendered duration is unchanged before and after the next prompt')
})

test('F8: a PRECEDING boundary never closes a later Activity (position-qualified lookup)', () => {
  // Live fold: a Preparing tool-call delta at +1s creates the call's earliest
  // start, an injected Context row lands at +2s, and the durable tool/call at
  // +3s reuses the +1s Preparing start. The canonical structure is therefore
  // [Context, Work] — the Work has NO successor — so the Activity must stay
  // OPEN even though the preceding Context's sidecar time is newer.
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, T0, 0)])
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000,
    chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{}' },
  })
  folder.apply([eventAt('user/message', {
    id: 'ctx-after-start', content: [{ type: 'text', text: 'context after the preparing start' }],
    source: { kind: 'skill-invocation', name: 'demo' },
  }, T0 + 2_000, 1)])
  folder.apply([eventAt('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' }, T0 + 3_000, 2)])
  const analysis = analyze(folder)
  assert.deepEqual(projectTranscriptStructure(folder.messages()).map(block => block.kind), ['message', 'work'],
    'the Context precedes the Work: the Work has no successor')
  const span = analysis.spans[0]!
  assert.equal(span.members[0]!.kind, 'tool')
  assert.deepEqual(analysis.lifetimes.get(span.owner), { startedAt: T0 + 1_000, open: true, trailing: true },
    'a preceding boundary can never close a later Activity')
  assert.equal(summarizeWorkSpan(span).timing?.startedAt, T0 + 1_000, 'the Preparing start is reused')
})

test('F5b: the final Activity end is capped by its turn even when a member settles late', () => {
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 6_000, 2),
  ])
  const before = analyze(folder)
  const span = before.spans[0]!
  assert.deepEqual(before.lifetimes.get(span.owner),
    { startedAt: T0 + 1_000, endedAt: T0 + 6_000, open: false, trailing: true },
    'the running member leaves the turn/end as the close')

  // The disclosure contract explicitly allows this EXISTING pending tool card to
  // settle after its own turn ended. The member's own timing follows the real
  // result, but the Activity's lifetime stays frozen at its turn.
  folder.apply([toolResult('c1', T0 + 100_000, 3)])
  const after = analyze(folder)
  const afterSpan = after.spans.find(candidate => candidate.owner === span.owner)
  assert.ok(afterSpan !== undefined, 'the Activity span survives the late settlement')
  assert.equal(summarizeWorkSpan(afterSpan).timing?.endedAt, T0 + 100_000,
    'the Tool member keeps its own real end (never rewritten by the clock)')
  assert.deepEqual(after.lifetimes.get(afterSpan.owner),
    { startedAt: T0 + 1_000, endedAt: T0 + 6_000, open: false, trailing: true },
    'a late member settlement can never lengthen the Activity beyond its turn')
  assert.equal(headerAt(afterSpan, activityClockOf(after.lifetimes.get(afterSpan.owner)!, () => false, () => true), T0 + 9_999_999),
    headerAt(span, activityClockOf(before.lifetimes.get(span.owner)!, () => false, () => true), T0 + 9_999_999),
    'the rendered duration is unchanged by the late settlement')
})

test('F9: an EQUAL-time following Conversation closes the Activity (a coarse clock never leaves it live)', () => {
  // A legitimate coarse clock stamps the whole step — the reasoning delta, its
  // block-end AND the first visible text — with the same millisecond. The
  // following Conversation is already visible at the Activity's own start, so it
  // closes the Activity from that instant (a point span, duration hidden); only
  // a PROVABLY STRICTLY EARLIER row may be ignored.
  const at = T0 + 1_000
  const settlement = (): SessionEvent => eventAt('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: 'm1', role: 'assistant',
      content: [{ type: 'reasoning', text: 'same-ms thought' }, { type: 'text', text: 'same-ms answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [
      { type: 'chunk', time: at, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', time: at, chunk: { type: 'reasoning-delta', index: 0, text: 'same-ms thought' } },
      { type: 'chunk', time: at, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'same-ms thought' } } },
      { type: 'chunk', time: at, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
      { type: 'chunk', time: at, chunk: { type: 'text-delta', index: 1, text: 'same-ms answer' } },
    ],
  }, at, 1)

  const cold = foldEvents([eventAt('turn/start', { turn: 1 }, T0, 0), settlement()])
  const live = new TranscriptFolder()
  live.hydrate([eventAt('turn/start', { turn: 1 }, T0, 0)])
  for (const chunk of [
    { type: 'reasoning-delta', index: 0, text: 'same-ms thought' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'same-ms thought' } },
  ] as const) {
    live.applyLiveInput({ kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: at, chunk })
  }
  live.apply([settlement()])

  const coldAnalysis = analyze(cold)
  const liveAnalysis = analyze(live)
  const coldSpan = coldAnalysis.spans[0]!
  const liveSpan = liveAnalysis.spans[0]!
  assert.equal(summarizeWorkSpan(coldSpan).timing?.startedAt, at)
  assert.deepEqual(coldAnalysis.lifetimes.get(coldSpan.owner),
    { startedAt: at, endedAt: at, open: false, trailing: true },
    'the equal-time following Conversation closes the point Activity')
  assert.deepEqual(liveAnalysis.lifetimes.get(liveSpan.owner), coldAnalysis.lifetimes.get(coldSpan.owner),
    'the same equal-time sequence derives the same lifetime live and cold')
  const clock = activityClockOf(coldAnalysis.lifetimes.get(coldSpan.owner)!, () => true, () => true)
  assert.equal(clock.isLive(), false,
    'an already-visible Conversation at the SAME instant never leaves the Activity counting')
  const line = headerAt(coldSpan, clock, T0 + 999_999)
  assert.ok(!/Activity \d/u.test(line), `a point Activity hides its duration:\n${line}`)
})

test('F9b (production): an equal-time Conversation switches the LIVE card to a closed point (viewport + cache state)', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    workingIntervalMs: 60,
  })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())

  const at = Date.now() - 1_000
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 1 }, at - 500, 0)])
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: at,
    chunk: { type: 'reasoning-delta', index: 0, text: 'same-ms thought' },
  })
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setWorking(true)
  await vt.waitForRender()
  const liveView = strip(vt.getViewport().join('\n'))
  const liveSeconds = durationSeconds(liveView)
  assert.ok(liveSeconds >= 0, `the open trailing span is live first:\n${liveView}`)

  // The coarse clock stamps the block-end AND the first visible text with the
  // same instant as the Activity's start: the card must switch to a CLOSED
  // point (no duration) instead of keeping the live clock.
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: at,
    chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'same-ms thought' } },
  })
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: at,
    chunk: { type: 'text-delta', index: 1, text: 'same-ms answer' },
  })
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const closedView = strip(vt.getViewport().join('\n'))
  assert.ok(!/Activity \d/u.test(closedView),
    `an equal-time Conversation must close the point Activity and hide its duration:\n${closedView}`)
  assert.ok(closedView.includes('same-ms answer'), `the Conversation row renders:\n${closedView}`)

  // Cache state: a stale LIVE component would resume/extend the count with the
  // wall clock, so the closed card must stay duration-less across real ticks.
  await new Promise(resolve => setTimeout(resolve, 1_300))
  await vt.waitForRender()
  const settledView = strip(vt.getViewport().join('\n'))
  assert.ok(!/Activity \d/u.test(settledView),
    `the closed card must never resume counting (cache switched to the closed clock):\n${settledView}`)
  app.stop()
})

test('F7: the lifetime derivation reads the structure in bounded linear order', () => {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 60; turn += 1) {
    const base = T0 + turn * 20_000
    events.push(eventAt('turn/start', { turn }, base, seq++))
    events.push(toolCall(`c${turn}`, 'bash', base + 1_000, seq++))
    events.push(toolResult(`c${turn}`, base + 2_000, seq++))
    events.push(eventAt('user/message', {
      id: `ctx${turn}`, content: [{ type: 'text', text: 'ctx' }],
      source: { kind: 'skill-invocation', name: 'demo' },
    }, base + 3_000, seq++))
  }
  const folder = foldEvents(events)
  const structure = projectTranscriptStructure(folder.messages())
  assert.ok(structure.length >= 100, `the fixture must be large enough (got ${structure.length} blocks)`)
  let reads = 0
  const counted = new Proxy(structure, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key)) reads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  const lifetimes = resolveWorkLifetimes(counted, folder.turnActivities())
  assert.equal(lifetimes.size, 60, 'every Work span still resolves')
  // Two bounded passes over the structure (collect + suffix flag) and one
  // binary search per span; anything quadratic (the old per-Work suffix walk)
  // reads ~n²/2 here.
  assert.ok(reads <= structure.length * 3,
    `bounded linear reads expected, got ${reads} for ${structure.length} blocks`)
})

test('a trailing retry point can keep counting while the Activity is live', () => {
  // `llm/retry` is point evidence: as the still-open trailing Work it may count
  // from that point (a historical retry-only span must not fabricate a span).
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('llm/retry', { turn: 1, step: 0, retry: 1, delayMs: 2_000, failure: { code: 'X', message: 'x' } }, T0 + 1_000, 1),
  ])
  const { lifetimes, spans } = analyze(folder)
  const lifetime = lifetimes.get(spans[0]!.owner)!
  assert.deepEqual(lifetime, { startedAt: T0 + 1_000, open: true, trailing: true })
  const line = headerAt(spans[0]!, activityClockOf(lifetime, () => true, () => true), T0 + 6_000)
  assert.match(line, /Activity 5s/, `the open trailing retry point keeps counting:\n${line}`)
  const historical = headerAt(spans[0]!, activityClockOf(lifetime, () => false, () => true), T0 + 999_999)
  assert.ok(!historical.includes('998s'), `a historical retry point fabricates no span:\n${historical}`)
})

// ── the committed display subject gates a cached card (plan §5.3) ───────────

test('E4 (production pipeline): the settled Tool keeps counting through a real silent wait, then the assistant boundary freezes it without a jump', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  // Fast injected frames keep the test short; the DURATION reads the real wall
  // clock (a fake clock could hide a jump).
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    workingIntervalMs: 60,
  })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())

  const transcriptCommits = { count: 0 }
  const setTranscript = app.setTranscript.bind(app)
  app.setTranscript = (...args: Parameters<typeof setTranscript>): void => {
    transcriptCommits.count += 1
    setTranscript(...args)
  }
  // The PRODUCTION instance's own row-map refresh path: the only way a frame
  // rebuilds the fullscreen geometry (`commitFullscreenPaintSnapshot` calls it
  // directly when the rows are dirty). Patched through the instance with the
  // UNBOUND prototype function + an explicit receiver (never `.bind`), and
  // restored by deleting the own property so the prototype identity is intact.
  const appInternals = app as unknown as { refreshMessageRows(): void }
  const originalRefreshMessageRows = appInternals.refreshMessageRows
  let rowMapRefreshes = 0
  appInternals.refreshMessageRows = function (this: unknown): void {
    rowMapRefreshes += 1
    originalRefreshMessageRows.call(this)
  }
  t.after(() => { delete (app as unknown as Record<string, unknown>)['refreshMessageRows'] })
  const seconds = (): number => durationSeconds(strip(vt.getViewport().join('\n')))

  // L1 fold (the production sidecar evidence) → the production TUI commit.
  const startedAt = Date.now()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, startedAt, 0),
    toolCall('c1', 'bash', startedAt + 100, 1),
    toolResult('c1', startedAt + 600, 2), // the member settles almost immediately
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  // The MAIN subject is running: the existing indicator animation is the only
  // repaint heartbeat.
  app.setWorking(true)
  app.setFullscreen(true)
  await vt.waitForRender()
  const settled = seconds()

  // REAL wall-clock silent wait — the tool has SETTLED, no new event lands, no
  // input, no manual repaint. The old member-settle algorithm would freeze at
  // the member span; the Activity lifetime must keep counting.
  rowMapRefreshes = 0
  await new Promise(resolve => setTimeout(resolve, 2_600))
  await vt.waitForRender()
  const silent = seconds()
  assert.ok(silent >= settled + 2,
    `the settled Activity must keep counting through the silent wait (${settled}s -> ${silent}s)`)
  assert.equal(transcriptCommits.count, 1,
    'the repaint tick must never re-commit the transcript (one setTranscript call, the fixture)')
  assert.equal(rowMapRefreshes, 0,
    'the 500ms heartbeat must never rebuild the fullscreen row geometry (a per-tick fullscreenRowsDirty mutation makes this fail)')

  // The model answers: the assistant's first visible text becomes the proven
  // boundary. The frozen value must equal what the user was just seeing.
  const boundaryAt = Date.now()
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: boundaryAt,
    chunk: { type: 'text-delta', index: 1, text: 'the answer' },
  })
  // The production runtime re-commits the fold after applying the event.
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const frozen = seconds()
  assert.ok(frozen >= silent && frozen <= silent + 1,
    `the boundary must freeze the value the user was seeing (${silent}s -> ${frozen}s), never jump or reset`)
  assert.equal(transcriptCommits.count, 2, 'the event commit is the second setTranscript')

  app.setFullscreen(false)
  app.stop()
})

test('E5 (production pipeline): an injected Context closes the previous Activity; Reasoning closes at the visible assistant text; turn/end closes the rest', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    workingIntervalMs: 10_000,
  })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())

  const T = Date.now() - 60_000
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, T, 0),
    // Work A: a settled tool that the CONTEXT row must close (no assistant in
    // between). Removing the Context's point sidecar makes this assertion fail:
    // the span would stay open-but-not-live and render NO duration.
    toolCall('c0', 'bash', T + 500, 1),
    toolResult('c0', T + 1_000, 2),
    eventAt('user/message', {
      id: 'ctx-a', content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'skill-invocation', name: 'demo' },
    }, T + 6_000, 3),
    // Work B: the reasoning lane, closed by its own first VISIBLE assistant
    // text (+8s) while the reasoning member ends at +7.5s.
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: 'a1', role: 'assistant',
        content: [{ type: 'reasoning', text: 'brief thought' }, { type: 'text', text: 'answer one' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [
        { type: 'chunk', time: T + 7_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T + 7_000, chunk: { type: 'reasoning-delta', index: 0, text: 'brief thought' } },
        { type: 'chunk', time: T + 7_500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'brief thought' } } },
        { type: 'chunk', time: T + 8_000, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'chunk', time: T + 8_000, chunk: { type: 'text-delta', index: 1, text: 'answer one' } },
        { type: 'chunk', time: T + 8_500, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'answer one' } } },
      ],
    }, T + 9_000, 4),
    // Work C: closed by the owning turn/end (+20s).
    toolCall('c1', 'bash', T + 12_000, 5),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T + 20_000, 6),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setWorking(true)
  await vt.waitForRender()
  const view = strip(vt.getViewport().join('\n'))
  // A settled Reasoning-only span renders the historical `Thought` identity
  // (existing policy) — the LIFETIME assertion matches either identity.
  const durations = [...view.matchAll(/(?:Activity|Thought) (\d+)s/gu)].map(match => match[1])
  assert.deepEqual(durations, ['5', '1', '8'],
    `Context(+6s) closes A(0.5s), the visible assistant text(+8s) closes the Reasoning(7s), turn/end(+20s) closes C(12s):\n${view}`)
  app.stop()
})

test('a normal shape has the SAME lifetime live and cold (live/cold parity)', () => {
  const events = (): SessionEvent[] => [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 2_000, 2),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'assistant' } },
      stream: [{ type: 'chunk', time: T0 + 9_000, chunk: { type: 'text-delta', index: 0, text: 'done' } }],
    }, T0 + 10_000, 3),
  ]
  const cold = foldEvents(events())
  const live = new TranscriptFolder()
  live.hydrate([events()[0]!])
  live.apply([events()[1]!, events()[2]!])
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 9_000,
    chunk: { type: 'text-delta', index: 0, text: 'done' },
  })
  live.apply([events()[3]!])
  const coldAnalysis = analyze(cold)
  const liveAnalysis = analyze(live)
  const coldSpan = coldAnalysis.spans[0]!
  const liveSpan = liveAnalysis.spans[0]!
  assert.deepEqual(coldAnalysis.lifetimes.get(coldSpan.owner), liveAnalysis.lifetimes.get(liveSpan.owner),
    'the same event sequence must derive the same lifetime live and cold')
  assert.equal(coldAnalysis.lifetimes.get(coldSpan.owner)!.endedAt, T0 + 9_000,
    'the first visible assistant text is the boundary in both folds')
  const clock = activityClockOf(coldAnalysis.lifetimes.get(coldSpan.owner)!, () => true, () => true)
  assert.equal(headerAt(coldSpan, clock, T0 + 999_999), headerAt(liveSpan, clock, T0 + 999_999),
    'and the rendered duration is identical')
})

test('F1: a VISIBLE streamless settlement is the proven boundary; turn/end never overrides it', () => {
  const streamless = (content: readonly unknown[]): SessionEvent => eventAt('assistant/message', {
    turn: 1, step: 0,
    message: { id: 'm1', role: 'assistant', content, source: { kind: 'assistant' } },
  }, T0 + 45_000, 3)

  const visible = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
    streamless([{ type: 'text', text: 'streamless answer' }]),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 60_000, 4),
  ])
  const visibleAnalysis = analyze(visible)
  const visibleSpan = visibleAnalysis.spans[0]!
  const visibleLifetime = visibleAnalysis.lifetimes.get(visibleSpan.owner)!
  assert.equal(visibleLifetime.endedAt, T0 + 45_000,
    'a visible streamless settlement proves the Conversation boundary')
  const visibleClock = activityClockOf(visibleLifetime, () => true, () => true)
  assert.match(headerAt(visibleSpan, visibleClock, T0 + 999_999), /Activity 44s/u,
    'and the later turn/end (+60s) must not override it')

  // A settlement with NO visible Conversation content materializes no row at
  // all: nothing closed the Activity, so it stays the OPEN trailing candidate
  // (live while the subject runs) and no boundary is fabricated from the
  // settlement. Without liveness there is no provable end: no duration.
  const invisible = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
    streamless([]),
  ])
  const invisibleAnalysis = analyze(invisible)
  const invisibleSpan = invisibleAnalysis.spans[0]!
  const invisibleLifetime = invisibleAnalysis.lifetimes.get(invisibleSpan.owner)!
  assert.equal(invisibleAnalysis.spans.length, 1)
  assert.deepEqual(invisibleLifetime, { startedAt: T0 + 1_000, open: true, trailing: true })
  const invisibleLive = activityClockOf(invisibleLifetime, () => true, () => true)
  assert.equal(invisibleLive.isLive(), true, 'no row means no close: the tail stays live')
  const invisibleHistorical = activityClockOf(invisibleLifetime, () => false, () => true)
  assert.equal(invisibleHistorical.isLive(), false)
  assert.ok(!/Activity \d/u.test(headerAt(invisibleSpan, invisibleHistorical, T0 + 999_999)),
    'without a provable end and without liveness the duration is hidden')

  // An EXISTING live row's earlier first-visible evidence survives a later
  // streamless settlement (never regressed to the settlement time).
  const liveRow = new TranscriptFolder()
  liveRow.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 1_000, 1),
    toolResult('c1', T0 + 5_000, 2),
  ])
  liveRow.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 40_000,
    chunk: { type: 'text-delta', index: 0, text: 'streamed first' },
  })
  liveRow.apply([streamless([{ type: 'text', text: 'streamless answer' }])])
  const liveRowAnalysis = analyze(liveRow)
  const liveRowSpan = liveRowAnalysis.spans[0]!
  assert.equal(liveRowAnalysis.lifetimes.get(liveRowSpan.owner)!.endedAt, T0 + 40_000,
    'the earliest proven first-visible time is preserved')
})

test('F2: a CACHED Activity card re-gates when a following structure block appears (production component cache)', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    workingIntervalMs: 10_000,
  })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())

  const now = Date.now()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, now - 40_500, 0),
    toolCall('c1', 'bash', now - 40_000, 1),
    toolResult('c1', now - 35_000, 2),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setWorking(true)
  await vt.waitForRender()
  const first = /Activity (\d+)s/u.exec(strip(vt.getViewport().join('\n')))
  assert.ok(first !== null && Number(first[1]) >= 39,
    `the open trailing Activity must be live:\n${strip(vt.getViewport().join('\n'))}`)

  // Append a canonical boundary with NO proven point sidecar (a turn-less
  // command row): the span stops being the canonical tail while its start/end
  // and summary stay identical. The CACHED card must be re-created as
  // open-but-not-live instead of extending the stale live closure.
  folder.apply([eventAt('command/run', { commandId: 'cmd1', name: 'theme' }, now - 1_000, 3)])
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const secondView = strip(vt.getViewport().join('\n'))
  assert.ok(secondView.includes('Activity'), `the Activity must still render:\n${secondView}`)
  assert.ok(!/Activity \d/u.test(secondView),
    `the cached card must drop the stale live value and show no unprovable end:\n${secondView}`)
  app.stop()
})
