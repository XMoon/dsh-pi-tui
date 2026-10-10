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

test('a history window renders the conservative member end, never a Date.now() extension', () => {
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
  assert.match(line, /Activity 4s/, `an unprovable close falls back to the member end:\n${line}`)
  assert.ok(!line.includes('998s'), `a historical Activity must never read now:\n${line}`)
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
})

test('a reordered early Conversation row proves no close (and never fabricates a 0s)', () => {
  // Cold hydration can order the assistant row AFTER the Process rows it
  // chronologically preceded (the live lane materializes it on its first
  // visible chunk; the durable settlement appends at its own event index). The
  // early first-visible time must not be read as an end of the LATER Work.
  const folder = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 5_000, 1),
    toolResult('c1', T0 + 9_000, 2),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'let me check' }], source: { kind: 'assistant' } },
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'text-delta', index: 0, text: 'let me check' } },
        { type: 'chunk', time: T0 + 5_000, chunk: { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' } },
      ],
    }, T0 + 10_000, 3),
  ])
  const { lifetimes, spans } = analyze(folder)
  assert.equal(spans.length, 1, 'the settled interaction/tooling shape keeps ONE Work span')
  const lifetime = lifetimes.get(spans[0]!.owner)!
  assert.deepEqual(lifetime, { startedAt: T0 + 5_000, open: true, trailing: false })
  assert.equal(activityClockOf(lifetime, () => true, () => true).isLive(), false,
    'a following canonical block always prevents live, even with no valid close')
  const line = headerAt(spans[0]!, activityClockOf(lifetime, () => true, () => true), T0 + 999_999)
  assert.match(line, /Activity 4s/, `the conservative member end renders instead:\n${line}`)

  // The same shape with a STILL-RUNNING member has no proven end at all: the
  // duration is omitted (unknown), never a fabricated `0s`.
  const running = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('c1', 'bash', T0 + 5_000, 1),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'let me check' }], source: { kind: 'assistant' } },
      stream: [{ type: 'chunk', time: T0 + 1_000, chunk: { type: 'text-delta', index: 0, text: 'let me check' } }],
    }, T0 + 10_000, 2),
  ])
  const runningSpan = analyze(running).spans[0]!
  const runningLine = headerAt(runningSpan, activityClockOf(analyze(running).lifetimes.get(runningSpan.owner)!, () => true, () => true), T0 + 999_999)
  assert.ok(!/Activity \d/u.test(runningLine), `an unprovable live span omits the duration:\n${runningLine}`)
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

test('a snapshot-only child activity flip re-gates a CACHED Activity card without re-committing the transcript', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset: 'compact' }, workingIntervalMs: 10_000 })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())
  let transcriptCommits = 0
  const setTranscript = app.setTranscript.bind(app)
  app.setTranscript = (...args: Parameters<typeof setTranscript>): void => {
    transcriptCommits += 1
    setTranscript(...args)
  }
  // A settled tool at now-6s inside an unclosed turn: the member span is 4s
  // while the OPEN Activity has been running for ~10s.
  const now = Date.now()
  const folder = new TranscriptFolder()
  folder.hydrate([
    eventAt('turn/start', { turn: 1 }, now - 10_500, 0),
    toolCall('c1', 'bash', now - 10_500, 1),
    toolResult('c1', now - 6_500, 2),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  enterChildDisplaySubject(app, {
    id: 'child-a', label: 'child A', mode: 'continuable', activity: 'running',
    cwd: '/ws/a', turns: 1, steps: 1,
  })
  await vt.waitForRender()
  const running = /Activity (\d+)s/u.exec(strip(vt.getViewport().join('\n')))
  assert.ok(running !== null, `the running child must render a live Activity:\n${strip(vt.getViewport().join('\n'))}`)
  assert.ok(Number(running[1]) >= 9, `the open Activity counts from its own start, not the member end:\n${running[0]}`)

  // The official snapshot channel flips the child inactive with NO durable
  // event and NO `setTranscript`: the cached card must re-gate and render the
  // conservative member end (4s), never keep extending with now().
  app.commitDisplaySubject(
    { view: { subject: { kind: 'subagent', id: 'child-a', label: 'child A', mode: 'continuable', activity: 'inactive' } } },
    {},
    { sessionId: 'child-a', workspaceRoot: '/ws/a', title: '', todos: [], goal: undefined },
  )
  await vt.waitForRender()
  const frozen = /Activity (\d+)s/u.exec(strip(vt.getViewport().join('\n')))
  assert.ok(frozen !== null, `the inactive child must still render the frozen Activity:\n${strip(vt.getViewport().join('\n'))}`)
  assert.equal(frozen[1], '4', `the inactive child must freeze at the member evidence:\n${frozen[0]}`)
  assert.equal(transcriptCommits, 1, 'the flip must not re-commit the transcript')
})

// ── the REAL repaint tick (plan §10) ────────────────────────────────────────

test('a real WorkingIndicator tick grows the Activity duration with no setTranscript and no input', async (t) => {
  const vt = new VirtualTerminal(100, 30)
  // A fast injected frame interval keeps the test short; the DURATION still
  // reads the real wall clock (no fake clock — a fake clock could hide a jump).
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    workingIntervalMs: 60,
  })
  app.start()
  startedApps.add(app)
  t.after(() => app.dispose())

  // The witness that the tick — not a transcript commit — drives the repaint.
  let transcriptCommits = 0
  const setTranscript = app.setTranscript.bind(app)
  app.setTranscript = (...args: Parameters<typeof setTranscript>): void => {
    transcriptCommits += 1
    setTranscript(...args)
  }

  const startedAt = Date.now() - 1_000
  const folder = new TranscriptFolder()
  folder.hydrate([
    eventAt('turn/start', { turn: 1 }, startedAt - 1_000, 0),
    toolCall('c1', 'bash', startedAt, 1),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  // The MAIN subject is running: the existing indicator animation is the only
  // repaint heartbeat.
  app.setWorking(true)
  app.setFullscreen(true)
  await vt.waitForRender()
  const first = /Activity (\d+)s/u.exec(strip(vt.getViewport().join('\n')))
  assert.ok(first !== null, `the live Activity must render a duration:\n${strip(vt.getViewport().join('\n'))}`)

  // REAL wall-clock wait — no input, no transcript commit, no manual repaint.
  await new Promise(resolve => setTimeout(resolve, 2_600))
  await vt.waitForRender()
  const second = /Activity (\d+)s/u.exec(strip(vt.getViewport().join('\n')))
  assert.ok(second !== null, `the Activity must still render:\n${strip(vt.getViewport().join('\n'))}`)
  assert.ok(Number(second[1]) >= Number(first[1]) + 2,
    `the duration must grow with the real clock (${first[1]}s -> ${second[1]}s)`)
  assert.equal(transcriptCommits, 1,
    'the repaint tick must never re-commit the transcript (one setTranscript call, the fixture)')

  app.setFullscreen(false)
  app.stop()
})
