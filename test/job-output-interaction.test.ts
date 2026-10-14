/**
 * Phase 3B / B1-B — the Job retained Output interaction (implementation plan
 * §8, B-01..B-15): the strict End-only follow owner, the Job-local Find over the
 * REAL retained body, the one-frame chrome budget and the retention anchor.
 *
 * The REAL closure for the L6 cases: a mounted `TuiApp` + `VirtualTerminal`
 * drives the REAL `createTaskRuntime` owner, the real Task Browser and the real
 * `JobInspectorPanel` on its own temporary `TuiAltScreen`; only the external
 * Job-observation PORT is replaced by an acquire/emit/disposer recorder. The
 * pure cases exercise the production `JobOutputScrollView` and the pure
 * `rebaseRetainedAnchor`.
 *
 * @module @xmoon76/dsh-pi-tui/job-output-interaction.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { TaskBrowserHandle, TuiAppEvents } from '../src/tui-app.ts'
import { TuiApp } from '../src/tui-app.ts'
import { JobInspectorPanel } from '../src/tui/panels/job-inspector-panel.ts'
import { JobOutputScrollView } from '../src/tui/panels/job-output-scroll-view.ts'
import { rebaseRetainedAnchor } from '../src/tui/panels/job-output-search.ts'
import { createTaskRuntime, type JobInspectorState, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservedSnapshot, JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import { parseUserKeybindings } from '../src/tui/keybindings/config.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(
  options: Record<string, unknown> = {},
  events: Partial<Pick<TuiAppEvents, 'onFullscreenChange' | 'onExit' | 'runOwned'>> = {},
  columns = 80,
  rows = 24,
): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => events.onExit?.() ?? undefined,
    ...(events.onFullscreenChange === undefined ? {} : { onFullscreenChange: events.onFullscreenChange }),
    ...(events.runOwned === undefined ? {} : { runOwned: events.runOwned }),
  }, options)
  app.start()
  startedApps.add(app)
  return { vt, app }
}

const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripTerminalSequences)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')

/** The painted row carrying the STRONG (background) search highlight, or ''. It
 *  reads the real cell attributes, so it names the occurrence the user actually
 *  sees emphasised. */
const highlightedRowText = (vt: VirtualTerminal): string => {
  const rows = rawView(vt)
  const highlighted = rows.findIndex((_, row) => {
    for (let column = 0; column < 200; column += 1) {
      if (vt.getCellBgRgb(row, column) !== undefined) return true
    }
    return false
  })
  return highlighted < 0 ? '' : rows[highlighted]!.trim()
}

/** Paint until the predicate holds (bounded): a UI transition whose last step is
 *  a requestRender-scheduled frame (a reveal, a chrome re-measure) needs one
 *  more committed frame than a single `waitForRender()` is guaranteed to span. */
async function paintedWhen(
  vt: VirtualTerminal,
  predicate: (painted: string) => boolean,
  rounds = 12,
): Promise<string> {
  let painted = view(vt)
  for (let index = 0; index < rounds && !predicate(painted); index += 1) {
    await vt.waitForRender()
    painted = view(vt)
  }
  return painted
}

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

interface ObservationRecord {
  readonly jobId: string
  closes: number
  readonly emit: (patch: Partial<JobObservedSnapshot>) => void
}

class JobObservationDouble implements JobObservationPort {
  readonly records: ObservationRecord[] = []
  readonly stops: string[] = []
  openFailure: string | undefined
  syncEmit = true
  stopOutcome: JobStopOutcome = { kind: 'requested' }
  stopFailure: Error | undefined

  open(_sessionId: string | undefined, jobId: string, listener: (snapshot: JobObservedSnapshot) => void): () => void {
    if (this.openFailure !== undefined) throw new Error(this.openFailure)
    const record: ObservationRecord = {
      jobId,
      closes: 0,
      emit: (patch) => listener({
        jobId,
        kind: 'bash',
        label: `job ${jobId}`,
        status: 'running',
        text: `retained ${jobId}`,
        gapBefore: false,
        settled: false,
        ...patch,
      }),
    }
    this.records.push(record)
    if (this.syncEmit) record.emit({})
    return () => { record.closes += 1 }
  }

  async stop(_sessionId: string, jobId: string): Promise<JobStopOutcome> {
    this.stops.push(jobId)
    if (this.stopFailure !== undefined) throw this.stopFailure
    return this.stopOutcome
  }

  latest(): ObservationRecord | undefined {
    return this.records.at(-1)
  }

  forJob(jobId: string): number[] {
    return this.records.filter(record => record.jobId === jobId).map(record => record.closes)
  }
}

interface TaskHarness {
  readonly tasks: TaskRuntime
  readonly observation: JobObservationDouble
  readonly retires: readonly string[]
  lastBrowser(): TaskBrowserHandle | undefined
}

function attachTasks(app: TuiApp, options: { jobIds?: readonly string[] } = {}): TaskHarness {
  const jobIds = [...(options.jobIds ?? [])]
  const jobSnapshots = (): TaskBrowserJobInput[] => jobIds.map((id, index) => ({
    id,
    kind: 'bash',
    label: `job ${id}`,
    status: 'running',
    startedAt: 1_000 + index,
  }))
  const observation = new JobObservationDouble()
  const subject = {} as SessionSubject
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => { throw new Error('subagent interrupt is not exercised by this suite') },
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: observation,
    jobs: { list: () => jobSnapshots(), subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({
        parentSessionId: 'sess-main',
        parentAvailable: true,
        descendants: [],
        jobs: jobSnapshots(),
      }),
      activityOf: () => 'running',
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub(),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  const browsers: TaskBrowserHandle[] = []
  const retires: string[] = []
  const originalOpenTaskBrowser = app.openTaskBrowser
  app.openTaskBrowser = function (
    this: TuiApp,
    items: Parameters<typeof originalOpenTaskBrowser>[0],
    onSelect: Parameters<typeof originalOpenTaskBrowser>[1],
    onCancel: Parameters<typeof originalOpenTaskBrowser>[2],
    browserOptions: Parameters<typeof originalOpenTaskBrowser>[3],
  ): TaskBrowserHandle {
    const innerRetire = browserOptions.onRetired
    const handle = originalOpenTaskBrowser.call(this, items, onSelect, onCancel, {
      ...browserOptions,
      onRetired: (reason) => {
        retires.push(reason)
        innerRetire?.(reason)
      },
    })
    browsers.push(handle)
    return handle
  }
  return { tasks, observation, retires, lastBrowser: () => browsers.at(-1) }
}

/** Open the first Job of the REAL `/tasks` browser through the real selection. */
async function openFirstJob(vt: VirtualTerminal, harness: TaskHarness): Promise<void> {
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
}

/** The ONE retained body text of the fixture: numbered single visual rows. */
const numberedLines = (from: number, to: number, prefix = 'line'): string =>
  Array.from({ length: to - from + 1 }, (_, index) => `${prefix} ${String(from + index).padStart(3, '0')}`).join('\n')

/** The FIRST retained-body row of the painted frame, located by CONTENT
 *  (`line NNN`) rather than a fixed row index, so a header that gains the GAP
 *  fact row (or a SearchRow) never shifts the read and a transient auto
 *  scrollbar glyph (`│` track / `█` thumb) painted over a row's last column can
 *  never defeat the match. */
const bodyTop = (vt: VirtualTerminal): string => {
  for (const row of rawView(vt)) {
    const match = /^(line \d{3})\b/.exec(row.trim())
    if (match !== null) return match[1]!
  }
  return ''
}

// ── B-01: the strict follow owner (pure/component) ──────────────────────────

/** A fixed-size component: the ScrollView's only child in the pure cases. */
class Lines implements Component {
  private readonly count: number
  constructor(count: number) { this.count = count }
  render(): string[] { return Array.from({ length: this.count }, (_, index) => `row ${index}`) }
  invalidate(): void {}
}

test('B-01 JobOutputScrollView: every manual scroll pauses, only End re-arms, and relayout never steals the intent', () => {
  const mk = (content: number, viewport: number): JobOutputScrollView => {
    const view = new JobOutputScrollView(new Lines(content), { follow: 'end', primary: true, scrollbar: 'auto' })
    view.updateLayout(content, viewport, () => {})
    return view
  }

  // Initial: the native tail follows and the intent is ON.
  const view = mk(50, 10)
  assert.equal(view.isFollowRequested, true)
  assert.equal(view.isFollowingEnd, true, 'the native tail follow paints the newest rows')
  assert.equal(view.scrollTop, 40)

  // A single line up pauses and really leaves the tail.
  view.scrollBy(-1)
  assert.equal(view.isFollowRequested, false)
  assert.equal(view.scrollTop, 39)
  assert.equal(view.isFollowingEnd, false)

  // Down to the very last row does NOT re-arm (the fork would).
  assert.equal(view.scrollBy(1), 0, 'the unconsumed remainder is preserved')
  assert.equal(view.scrollTop, 40)
  assert.equal(view.isFollowRequested, false)
  assert.equal(view.isFollowingEnd, false, 'reaching the bottom is not following')

  // A newer snapshot (content append) while PAUSED keeps the same top row.
  view.updateLayout(80, 10, () => {})
  assert.equal(view.scrollTop, 40, 'the visible top row is preserved across an append')
  assert.equal(view.isFollowRequested, false)

  // Content shrink must not re-arm either.
  view.updateLayout(30, 10, () => {})
  assert.equal(view.isFollowRequested, false)

  // Viewport growth must not re-arm.
  view.scrollTo(5)
  view.updateLayout(50, 20, () => {})
  assert.equal(view.isFollowRequested, false, 'a viewport growth never steals the historical row')
  assert.equal(view.scrollTop, 5)

  // Explicit End is the ONLY re-arm. Scrolling to the (already reached) max
  // still returns the unconsumed remainder exactly like the fork.
  assert.equal(view.scrollBy(100), 75)
  view.resumeFollow()
  assert.equal(view.isFollowRequested, true)
  assert.equal(view.scrollTop, 30, 'the viewport growth moved the tail (50 rows - 20 rows)')
  assert.equal(view.isFollowingEnd, true)

  // A scrollbar-equivalent jump pauses even at the max target.
  view.scrollTo(30)
  assert.equal(view.isFollowRequested, false)
  assert.equal(view.isFollowingEnd, false)

  // `scrollToEnd` is an ordinary manual jump, never the End key.
  view.resumeFollow()
  view.scrollToEnd()
  assert.equal(view.isFollowRequested, false)
  assert.equal(view.isFollowingEnd, false)

  // `Home` on short content stays PAUSED too.
  const short = mk(3, 10)
  assert.equal(short.isFollowRequested, true)
  short.scrollToStart()
  assert.equal(short.isFollowRequested, false)
  assert.equal(short.isFollowingEnd, false)

  // The rebase re-positions without touching the intent, and follow stays ON
  // (the tail) when the user never left it.
  view.resumeFollow()
  view.rebaseTo(10)
  assert.equal(view.isFollowRequested, true, 'the rebase never changes the follow intent')
  assert.equal(view.scrollTop, 10)
  view.dispose()
})

test('B-01b rebaseRetainedAnchor: a pure append keeps the row, an eviction shifts by the proven rows', () => {
  const old = ['a', 'b', 'c', 'd', 'e']
  // Pure append: nothing moved.
  assert.equal(rebaseRetainedAnchor({
    previousText: 'x', nextText: 'xy', previousRenderedLines: old, nextRenderedLines: [...old, 'f'], oldScrollTop: 2,
  }), 2)
  // Evicts `a`,`b`: the surviving rows 2..4 shift up by two.
  assert.equal(rebaseRetainedAnchor({
    previousText: 'old window', nextText: 'new window',
    previousRenderedLines: old, nextRenderedLines: ['c', 'd', 'e', 'f'], oldScrollTop: 4,
  }), 2)
  // No provable overlap: the old offset survives and the viewport clamps it.
  assert.equal(rebaseRetainedAnchor({
    previousText: 'old window', nextText: 'new window',
    previousRenderedLines: old, nextRenderedLines: ['x', 'y'], oldScrollTop: 3,
  }), 3)
  // The clamp never invents a negative offset.
  assert.equal(rebaseRetainedAnchor({
    previousText: 'old window', nextText: 'new window',
    previousRenderedLines: old, nextRenderedLines: ['d', 'e'], oldScrollTop: 0,
  }), 0)
  // DECISION-03 compares the ANSI-STRIPPED per-line content: a pure style/reset
  // difference on the same visible rows is not a different row, so the overlap
  // (and therefore the anchor) is still proven.
  assert.equal(rebaseRetainedAnchor({
    previousText: 'old window', nextText: 'new window',
    previousRenderedLines: ['\x1b[31ma\x1b[39m', '\x1b[31mb\x1b[39m', '\x1b[31mc\x1b[39m'],
    nextRenderedLines: ['b', 'c', 'd'],
    oldScrollTop: 2,
  }), 1, 'the SGR-only difference must not defeat the retention overlap')
})

// ── B-02: the real Job screen, keyboard scroll and the strict follow ─────────

test('B-02 the real Job screen follows the tail, PgUp/Home/arrows really scroll the Output, End re-arms, and the background never moves', async () => {
  // 120×40: the frame can carry the LOWEST-priority viewport position too, so
  // the bar's own position fact is read from the user's sink.
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'transcript row' }])
  vt.sendInput('kept draft')
  await vt.waitForRender()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()

  let painted = view(vt)
  assert.match(painted, /line 199/, 'the tail is visible on open')
  assert.match(painted, /Follow on/)
  assert.match(painted, /Job · job-a · bash.*‣ Running/)
  assert.match(painted, /Esc back/)
  assert.equal(bodyTop(vt), 'line 165', 'the 35-row Output viewport starts at the retained tail')

  // PgUp is an active browse: pause and move the body.
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  painted = view(vt)
  assert.match(painted, /Follow paused/)
  assert.ok(!/line 199/.test(painted), 'the tail leaves the viewport')
  assert.equal(bodyTop(vt), 'line 134')
  assert.match(painted, /Job · job-a · bash.*‣ Running/, 'the Header stays pinned')
  assert.match(painted, /Esc back/, 'the Action Bar stays the last row')

  // Home goes to the top of THIS retained preview and stays PAUSED.
  vt.sendInput('\x1b[H')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 000')
  assert.match(view(vt), /Follow paused/)

  // Arrows move one line at a time; PgDn moves back down without re-arming.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 001')
  vt.sendInput('\x1b[6~')
  await vt.waitForRender()
  assert.ok(bodyTop(vt) !== 'line 001')
  assert.match(view(vt), /Follow paused/, 'PgDn is browsing, never a re-arm')

  // Physical End re-arms and returns to the retained tail.
  vt.sendInput('\x1b[F')
  await vt.waitForRender()
  painted = view(vt)
  assert.match(painted, /Follow on/)
  assert.match(painted, /line 199/)
  assert.match(painted, /rows 166-200\/200/, 'the position is the retained preview, not Job history')

  // The background surface never moved and never received the keys.
  assert.equal(app.hostEditorTextForTest(), 'kept draft')
  app.stop()
})

// ── B-03: pushes while PAUSED, End catch-up, then follow again ──────────────

test('B-03 a newer official snapshot never moves a PAUSED viewport; End catches up and keeps following', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  const observation = harness.observation
  observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 134')
  const opensBefore = observation.records.length

  // A pure append while PAUSED: the top row must not move.
  observation.latest()!.emit({ text: numberedLines(0, 239) })
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 134', 'a pure append never pulls the user to the tail')
  assert.match(view(vt), /Follow paused/)
  assert.match(view(vt), /rows 135-169\/240/)

  // End catches up and follows the newer tail; the NEXT push keeps following.
  vt.sendInput('\x1b[F')
  await vt.waitForRender()
  assert.match(view(vt), /line 239/)
  assert.match(view(vt), /Follow on/)
  observation.latest()!.emit({ text: numberedLines(0, 259) })
  await vt.waitForRender()
  assert.match(view(vt), /line 259/, 'follow really tracks the newer tail')
  assert.equal(observation.records.length, opensBefore, 'no second observation was ever opened')
  assert.deepEqual(observation.stops, [], 'scrolling/search never touches Stop')
  app.stop()
})

// ── B-04: real terminal wheel input ─────────────────────────────────────────

test('B-04 a real alt-screen wheel pauses follow, and a later append is not followed', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  assert.match(view(vt), /Follow on/)

  vt.sendInput('\x1b[<64;20;12M') // wheel up over the body
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /Follow paused/, 'a wheel is a real browse and pauses follow')
  assert.ok(!/line 199/.test(painted))

  // Spin all the way to the last row: it is still PAUSED (no auto re-arm).
  for (let index = 0; index < 30; index += 1) vt.sendInput('\x1b[<65;20;12M')
  await vt.waitForRender()
  assert.match(view(vt), /Follow paused/, 'dragging to the bottom never re-arms follow')
  assert.match(view(vt), /line 199/)

  harness.observation.latest()!.emit({ text: numberedLines(0, 219) })
  await vt.waitForRender()
  assert.match(view(vt), /Follow paused/)
  assert.ok(!/line 219/.test(view(vt)), 'a newer tail is not followed after manual browsing')
  app.stop()
})

// ── B-04b: the real scrollbar thumb press/drag/release ──────────────────────

test('B-04b a real scrollbar press, drag and release move the Output, keep it paused and never re-arm follow', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  assert.match(view(vt), /Follow on/)
  // A wheel reveals the transient auto scrollbar (and pauses follow); the press
  // below targets the hidden-auto track directly.
  vt.sendInput('\x1b[<64;40;12M')
  await vt.waitForRender()
  assert.match(view(vt), /Follow paused/)
  const topIndex = (): number => Number(bodyTop(vt).split(' ')[1])
  assert.equal(topIndex(), 179, 'one wheel notch above the tail')

  // Press near the TRACK TOP (not on the thumb, which sits at the bottom): the
  // fork jumps the track and starts the drag through the overridden `scrollTo`.
  vt.sendInput('\x1b[<0;80;4M')
  await vt.waitForRender()
  assert.equal(topIndex(), 0, 'the scrollbar press jumped to the top')
  assert.match(view(vt), /Follow paused/)

  // Drag the thumb down the track, then release. The body box owns rows 3..22
  // (status + summary + tabs above it), so the mid-track row is 14.
  vt.sendInput('\x1b[<32;80;14M')
  await vt.waitForRender()
  const midway = topIndex()
  assert.ok(midway > 80 && midway < 110, `the drag really moved the viewport (top=${midway})`)
  vt.sendInput('\x1b[<32;80;22M')
  await vt.waitForRender()
  const bottom = topIndex()
  assert.ok(bottom >= 160, `dragging to the bottom really scrolled (top=${bottom})`)
  vt.sendInput('\x1b[<0;80;22m')
  await vt.waitForRender()
  assert.match(view(vt), /Follow paused/, 'a scrollbar gesture is browsing, never a re-arm')

  // A newer tail must not be followed after the drag.
  harness.observation.latest()!.emit({ text: numberedLines(0, 219) })
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /Follow paused/)
  assert.ok(!/line 219/.test(painted), 'a newer tail is not followed after a scrollbar drag')
  vt.sendInput('\x1b[F')
  await vt.waitForRender()
  assert.match(view(vt), /Follow on/)
  assert.match(view(vt), /line 219/)
  app.stop()
})

// ── B-05: the effective Find is Job-local ───────────────────────────────────

test('B-05 the effective Find opens the JOB Find over the retained body and never enters the Transcript search', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: `retained head\nneedle here\nretained tail` })
  await vt.waitForRender()

  // Patch the LIVE app's production search entry (receiver preserved) so "the
  // Transcript search never opened" is a real call count.
  const originalStart = app.startTranscriptSearch
  let transcriptSearches = 0
  app.startTranscriptSearch = function (this: TuiApp): void {
    transcriptSearches += 1
    originalStart.call(this)
  }
  const overlaysBefore = app.overlayGraphState().handles
  const draftBefore = app.hostEditorTextForTest()

  vt.sendInput('\x06') // Ctrl+F — the effective app.transcript.search binding
  await vt.waitForRender()
  let painted = view(vt)
  assert.match(painted, /Find Output:/, 'the Job SearchRow really opened')
  assert.equal(transcriptSearches, 0, 'the Transcript search handler was never entered')
  assert.equal(app.overlayGraphState().handles, overlaysBefore, 'no transcript search overlay was opened')
  assert.equal(app.hostEditorTextForTest(), draftBefore, 'Find never types into the editor')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false,
    'the SearchRow owns the physical focus while editing')

  vt.sendInput('needle')
  await vt.waitForRender()
  painted = view(vt)
  assert.match(painted, /Find Output: needle/)
  assert.match(painted, /1\/1/, 'the match is counted in the retained window')
  assert.equal(app.hostEditorTextForTest(), draftBefore)

  // A query that only exists in the Header or the Command must NOT match.
  vt.sendInput('\x15') // Ctrl+U clears the Input line
  await vt.waitForRender()
  vt.sendInput('job-a')
  await vt.waitForRender()
  assert.match(view(vt), /0\/0 · No matches/, 'Header/command text is not searchable Output')
  assert.equal(transcriptSearches, 0)
  app.stop()
})

// ── B-05b: the initial (already observed) snapshot is searchable at open ───

test('B-05b a Job opened with an ALREADY observed retained snapshot is searchable and positioned before any push', async () => {
  // The observation port is allowed to emit its first snapshot synchronously
  // inside `open()` (the Remote adapter does), so the opener's `initial` state
  // may already carry `observed.text` — the workspace must project it into the
  // search source and the position fact immediately, never wait for a later
  // push (a settled/quiet Job never sends one).
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  await vt.waitForRender()
  assert.equal(harness.observation.records.length, 1, 'the sync first snapshot opened exactly ONE observer')
  assert.match(view(vt), /retained job-a/, 'the first snapshot really reached the body')
  // The opener's first frame measures the chrome BEFORE the layout commits the
  // real viewport (X054); the onFramePainted re-converge repaints the position
  // fact one throttled frame later. Wait for that committed frame instead of
  // asserting inside the window a single waitForRender() does not cover.
  assert.match(
    await paintedWhen(vt, painted => /rows 1-1\/1/.test(painted)),
    /rows 1-1\/1/,
    'the position fact is live from the FIRST frame, not after a push',
  )

  // No further snapshot is emitted: Find must work on the initial state alone.
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('retained')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: retained/)
  assert.match(view(vt), /1\/1/, 'the initial retained text is searchable without a later push')
  app.stop()
})

// ── B-05c: Stop is not advertised while a Find owns the ordinary keys ──────

test('B-05c the Action Bar stops advertising Stop while a Find is active and restores it after Esc', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: 'retained job-a' })
  await vt.waitForRender()
  const bar = (): string => rawView(vt).at(-1) ?? ''
  assert.match(bar(), /stop/, 'a running Job advertises Stop in the normal state')

  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/)
  assert.ok(!bar().includes('stop'),
    `the Action Bar must not advertise Stop while the SearchRow consumes ordinary keys:\n${bar()}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(bar(), /stop/, 'leaving the search restores the Stop advertisement')
  app.stop()
})

// ── B-05e: the Action Bar does not promise keys the search state consumes ──

test('B-05e the Action Bar drops the inert End/Find hints while the query is being edited', async () => {
  const { vt, app } = startApp({}, {}, 200, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 99) })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  const bar = (): string => rawView(vt).at(-1) ?? ''
  assert.match(bar(), /Follow paused · End resume/)
  assert.match(bar(), /Ctrl\+F find/)

  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/)
  assert.match(bar(), /Follow paused/)
  assert.ok(!bar().includes('End resume'),
    `End belongs to the query Input while editing, so the bar must not promise it:\n${bar()}`)
  assert.ok(!bar().includes('Ctrl+F find'),
    `the Find entry cannot re-enter while already editing:\n${bar()}`)
  assert.ok(!bar().includes('stop'))

  vt.sendInput('\r') // NAVIGATE: End really resumes, Find really re-enters
  await vt.waitForRender()
  assert.match(bar(), /Follow paused · End resume/)
  assert.match(bar(), /Ctrl\+F find/)
  assert.ok(!bar().includes('stop'), 'NAVIGATE keeps the read-only result keys')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(bar(), /stop/, 'leaving the search restores Stop')
  app.stop()
})

// ── B-05d: the fork's own search key never opens a second overlay ──────────

test('B-05d Ctrl+Shift+F (the fork search chord) opens the Job Find, never the fork search overlay', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: 'needle in the retained body' })
  await vt.waitForRender()
  const originalStart = app.startTranscriptSearch
  let transcriptSearches = 0
  app.startTranscriptSearch = function (this: TuiApp): void {
    transcriptSearches += 1
    originalStart.call(this)
  }
  vt.sendInput('\x1b[102;6u') // Kitty CSI-u Ctrl+Shift+F
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /Find Output:/, 'the Job Find owns the chord')
  assert.ok(!/Find in transcript/.test(painted), 'the fork built-in search overlay never opened')
  assert.equal(transcriptSearches, 0)
  app.stop()
})

// ── B-06: EDIT vs NAVIGATE and n/N ─────────────────────────────────────────

test('B-06 EDIT types n/N as query text, Enter enters result navigation, n/N cycle, and 0 hits stay 0/0', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: `needle one\nmiddle\nneedle two\nneedle three` })
  await vt.waitForRender()

  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/)
  // In EDIT, `n` is query text — it can never navigate.
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: needlen/)
  assert.match(view(vt), /0\/0 · No matches/)
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: needle/)

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/, 'Enter selects the nearest hit to the opening anchor')
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /2\/3/)
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /3\/3/)
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/, 'n wraps')
  vt.sendInput('N')
  await vt.waitForRender()
  assert.match(view(vt), /3\/3/, 'N wraps backwards')
  // Ordinary printing in NAVIGATE is inert: the Job stays read-only.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.match(view(vt), /3\/3/)
  assert.equal(app.hostEditorTextForTest(), '')
  // Semantic key matching: the Kitty CSI-u form of `n` and the
  // modifyOtherKeys form of Shift+N reach the SAME navigation (a raw byte
  // comparison would silently dead-key them on those terminals).
  vt.sendInput('\x1b[110u')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/, 'a CSI-u n really navigates')
  vt.sendInput('\x1b[27;2;78~')
  await vt.waitForRender()
  assert.match(view(vt), /3\/3/, 'a modifyOtherKeys Shift+N really navigates backwards')
  app.stop()
})

// ── B-06b: End in the query editor stays in the Input ──────────────────────

test('B-06b End while EDITING the query stays in the Input and never resumes follow', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  const anchorTop = bodyTop(vt)
  assert.match(view(vt), /Follow paused/)

  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('line 05')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: line 05/)
  vt.sendInput('\x1b[H') // Home in EDIT: the Input's own line-start, not the viewport
  vt.sendInput('\x1b[F') // End in EDIT: the Input's own line-end, never a follow re-arm
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /Find Output: line 05/, 'the query editor keeps the search open')
  assert.match(painted, /1\/10/, 'the query and its count are unchanged')
  assert.match(painted, /Follow paused/, 'End inside the query NEVER re-arms follow')
  assert.equal(bodyTop(vt), anchorTop, 'End moved the Input cursor, never the Output viewport')
  app.stop()
})

// ── B-07: Esc layering and End ─────────────────────────────────────────────

test('B-07 the first Esc leaves only the search (still PAUSED in the same Job) and the second returns to the same browser; End resumes from a search', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 99) })
  await vt.waitForRender()
  const browser = harness.lastBrowser()!

  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('line 05')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: line 05/)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(view(vt), /1\/10/)

  vt.sendInput('\x1b')
  await vt.waitForRender()
  const painted = view(vt)
  assert.ok(!/Find Output:/.test(painted), 'the first Esc closes the search')
  assert.match(painted, /Job · job-a · bash.*‣ Running/, 'the Job workspace is still open')
  assert.match(painted, /Follow paused/, 'the Esc never re-arms follow')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)

  // End inside a result view leaves the search AND returns to the tail.
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\x1b[F')
  await vt.waitForRender()
  const tail = view(vt)
  assert.ok(!/Find Output:/.test(tail), 'End leaves the result view')
  assert.match(tail, /Follow on/)
  assert.match(tail, /line 099/)
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true,
    'End restores the physical focus from the now-hidden SearchRow')

  // The second Esc returns to the SAME browser instance.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(harness.lastBrowser(), browser)
  assert.match(view(vt), /job-a/, 'the Task Browser is painted again')
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

// ── B-08: remap / disable / leader ─────────────────────────────────────────

test('B-08 the Job Find follows the EFFECTIVE Find binding: a remap, a disable and a leader completion are all honored', async () => {
  // A wide frame so the LOWEST-priority Find hint is actually on screen and can
  // be read as the user's sink (plan §6.2 degradation order).
  const { vt, app } = startApp({}, {}, 200, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: 'needle' })
  await vt.waitForRender()
  assert.match(view(vt), /Ctrl\+F find/, 'the default direct binding is advertised')

  // A disabled Find advertises nothing and Ctrl+F is inert.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    bindings: { 'app.transcript.search': false },
  }))
  await vt.waitForRender()
  assert.ok(!/Ctrl\+F/.test(view(vt)), 'a disabled Find never advertises Ctrl+F')
  assert.match(view(vt), /\/ find/, 'the Job-local `/` alias still advertises the only live entry')
  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.ok(!/Find Output:/.test(view(vt)), 'a disabled binding does not open the Job Find')
  // `/` remains the Job-local alias.
  vt.sendInput('/')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/)
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // A remap is what the Job honors — both the hint and the real key.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    bindings: { 'app.transcript.search': 'ctrl+y' },
  }))
  await vt.waitForRender()
  assert.match(view(vt), /Ctrl\+Y find/, 'the hint follows the effective remap')
  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.ok(!/Find Output:/.test(view(vt)), 'the old key is really inert')
  vt.sendInput('\x19')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/)
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // A leader-bound Find completes into the Job Find without dispatching the
  // Transcript search.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.transcript.search': '<leader>s' },
  }))
  const originalStart = app.startTranscriptSearch
  let transcriptSearches = 0
  app.startTranscriptSearch = function (this: TuiApp): void {
    transcriptSearches += 1
    originalStart.call(this)
  }
  await vt.waitForRender()
  vt.sendInput('\x18')
  await vt.waitForRender()
  vt.sendInput('s')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/, 'the leader completion opens the Job Find')
  assert.equal(transcriptSearches, 0, 'the Transcript search handler is never dispatched')
  app.stop()
})

// ── B-08b: a Find remap onto a reserved viewport key cannot shadow End ─────

test('B-08b a Find binding remapped onto the reserved physical End cannot shadow the only follow re-arm or be advertised', async () => {
  // A wide frame so the LOWEST-priority Find hint really fits: with the reserved
  // key filtered out the segment is the bare `/ find`, and without the filter it
  // would advertise the inert `End` as `End find`.
  const { vt, app } = startApp({}, {}, 200, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.match(view(vt), /Follow paused/)
  const bar = (): string => rawView(vt).at(-1) ?? ''
  assert.match(bar(), /Ctrl\+F find/)

  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    bindings: { 'app.transcript.search': 'end' },
  }))
  await vt.waitForRender()
  assert.match(bar(), /Follow paused · End resume/, 'End still really resumes follow')
  assert.match(bar(), /\/ find/, 'the Job-local `/` alias is the only live Find entry')
  assert.ok(!/End find/.test(bar()),
    `a Find binding the Job reserves must never be advertised as usable:\n${bar()}`)

  // Physical End keeps its reserved meaning: resume follow and show the tail.
  vt.sendInput('\x1b[F')
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /Follow on/, 'physical End is still the ONLY follow re-arm')
  assert.match(painted, /line 199/, 'End really returned to the retained tail')
  assert.ok(!/Find Output:/.test(painted), 'the reserved End never opens the Job Find')

  // `/` remains the Job-local Find alias for the remapped action.
  vt.sendInput('/')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/)
  app.stop()
})

// ── B-09: CJK / wrapping / ANSI ────────────────────────────────────────────

test('B-09 searching CJK, wrapped and ANSI text keeps the rendered row count and visible width, and highlights the hit', async () => {
  // A SHORT body so the whole fixture stays inside the Output viewport: the
  // highlight comparison is then a same-row, same-width proof.
  const lines = [
    'alpha 中文 needle beta',
    `wrap ${'x'.repeat(60)}`,
    '\x1b[31mred needle tail\x1b[39m',
    'tail needle end',
  ].join('\n')
  const contentRows = (vt: VirtualTerminal): string[] =>
    rawView(vt).filter(row => /alpha|wrap|red needle|tail needle/.test(row)).map(row => row.trim())
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: lines })
  await vt.waitForRender()
  const before = contentRows(vt)
  const beforeWidths = before.map(row => visibleWidth(row))
  assert.equal(before.length, 4, 'the whole fixture is visible before the search')

  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('中文')
  await vt.waitForRender()
  assert.match(view(vt), /1\/1/, 'CJK text is matched through the rendered matcher')
  vt.sendInput('\x15')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/)
  // Navigate so the first hit (row 0) is the current, strongly highlighted one
  // and the others stay weak — the reveal must not change any content row.
  vt.sendInput('\r')
  await vt.waitForRender()
  const after = contentRows(vt)
  assert.deepEqual(after, before, 'highlighting never changes the rendered content')
  assert.deepEqual(after.map(row => visibleWidth(row)), beforeWidths,
    'highlighting never changes a visible width')
  for (const row of rawView(vt)) assert.ok(visibleWidth(row) <= 80)

  const rowsWith = (fragment: string): number => rawView(vt).findIndex(row => row.includes(fragment))
  const scan = (row: number): { background: number; underline: number } => {
    let background = 0
    let underline = 0
    for (let column = 0; column < 80; column += 1) {
      if (vt.getCellBgRgb(row, column) !== undefined) background += 1
      if (vt.getCellUnderline(row, column)) underline += 1
    }
    return { background, underline }
  }
  const currentRow = rowsWith('alpha 中文 needle beta')
  assert.ok(currentRow >= 0, 'the current hit row is visible (the reveal ran)')
  assert.ok(scan(currentRow).background > 0, 'the current hit carries the themed background highlight')
  const weakRow = rowsWith('red needle tail')
  assert.ok(weakRow >= 0, 'the other occurrence stays visible')
  const weak = scan(weakRow)
  assert.ok(weak.underline > 0, 'the other occurrence is weak-underlined')
  assert.equal(weak.background, 0, 'only the current occurrence gets the strong background')

  // A re-search over the ALREADY highlighted render must not see the highlight
  // decoration: the matcher indexes the raw retained rows only.
  vt.sendInput('\x15')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/, 'the decorated render never becomes the search source')
  app.stop()
})

// ── B-10: bounded retention and the GAP truth ──────────────────────────────

test('B-10 a truncated retained window rebases a provable anchor, never fabricates GAP, and the footer stays preview-relative', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  const observation = harness.observation
  observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()

  // Pause at a provable row, then evict ten old rows in the new window.
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 134')
  observation.latest()!.emit({ text: numberedLines(10, 199) })
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 134', 'the same provable row stays visible across the eviction')
  assert.match(view(vt), /Follow paused/)
  assert.ok(!/\[GAP\]/.test(view(vt)), 'a local window change never fabricates GAP')
  assert.match(view(vt), /rows 125-159\/190/, 'the position is relative to the retained window')

  // The official gap fact is the ONLY source of [GAP].
  observation.latest()!.emit({ text: numberedLines(10, 199), gapBefore: true })
  await vt.waitForRender()
  assert.match(view(vt), /\[GAP\]/)
  assert.match(view(vt), /Earlier output evicted/)

  // An anchor whose bytes are gone clamps instead of guessing.
  vt.sendInput('\x1b[H')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 010')
  observation.latest()!.emit({ text: numberedLines(120, 199) })
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 120', 'the evicted anchor clamps to the earliest surviving row')
  assert.match(view(vt), /Follow paused/)
  app.stop()
})

// ── B-10b: a source change between frames never falsifies the anchor ───────

test('B-10b several snapshots before the next frame keep the anchor on the same provable row', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  const observation = harness.observation
  observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 134', 'the DRAWN baseline (line 134) is the anchor')

  // THREE windows land BEFORE the next frame (no render in between). The anchor
  // is compared against the last DRAWN window and moved by the TOTAL proven
  // eviction (5 + 5 + 5), so `line 134` — still present in the newest window —
  // stays visible. Rebasing each undrawn hop separately (or re-applying an
  // eviction) would drift to `line 149`.
  observation.latest()!.emit({ text: numberedLines(5, 199) })
  observation.latest()!.emit({ text: numberedLines(10, 199) })
  observation.latest()!.emit({ text: numberedLines(15, 199) })
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 134',
    'the total proven eviction against the drawn baseline preserves the row')
  assert.match(view(vt), /Follow paused/)
  assert.ok(!/\[GAP\]/.test(view(vt)), 'no fabricated GAP')

  // A window with NO provable overlap clamps instead of guessing: the 40 brand
  // new rows cannot be aligned with the drawn baseline, so the offset stays and
  // the viewport clamps it into the new (shorter) window.
  observation.latest()!.emit({ text: Array.from({ length: 40 }, (_, index) => `fresh ${String(index).padStart(3, '0')}`).join('\n') })
  await vt.waitForRender()
  assert.match((rawView(vt)[3] ?? '').trim(), /^fresh 005/,
    'an unprovable window safely clamps the offset into the new window (40 rows, 35 body rows)')
  assert.match(view(vt), /Follow paused/)
  assert.ok(!/\[GAP\]/.test(view(vt)), 'a clamp never fabricates a GAP')
  app.stop()
})

// ── B-10b2: a surviving current hit stays current across a newer window ────

test('B-10b2 the current result survives a newer retained window when its row is still provable', async () => {
  // Two hits inside ONE viewport: step to the second, then let a newer (pure
  // append) snapshot arrive. The row is unchanged, so the hit is still provable
  // and MUST stay current — a streaming Job must not reset `n`/`N` on every push.
  const lines = Array.from({ length: 12 }, (_, index) => `line ${String(index).padStart(3, '0')}`)
  lines[5] = 'needle one'
  lines[8] = 'needle two'
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: lines.join('\n') })
  await vt.waitForRender()

  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.match(view(vt), /1\/2/)
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /2\/2/, 'the second hit is current')

  harness.observation.latest()!.emit({ text: `${lines.join('\n')}\nline 012\nline 013` })
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /2\/2/,
    `a newer window must not reset the provable current hit:\n${painted}`)
  assert.match(painted, /Find Output: needle/)
  assert.match(painted, /Follow paused/)
  app.stop()
})

// ── B-10b3: a hit is carried through its PROVEN row mapping, not coordinates ──

test('B-10b3 a truncated window never transfers the current hit to another occurrence that reuses its old coordinates', async () => {
  // Three identical-geometry hits at rows 100/110/120. Evicting ten rows lands
  // `needle C` exactly on the old row/column coordinates of the selected
  // `needle B`; a coordinate key would silently inherit C, while the proven
  // eviction maps B to its new row.
  const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index).padStart(3, '0')}`)
  lines[100] = 'needle A'
  lines[110] = 'needle B'
  lines[120] = 'needle C'
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: lines.join('\n') })
  await vt.waitForRender()
  vt.sendInput('\x1b[H')
  await vt.waitForRender()
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/)
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /2\/3/, 'needle B is current')
  assert.match(highlightedRowText(vt), /needle B/, 'the strong highlight is on the selected hit')

  // Evict ten rows: B moves to row 100 while C lands on B's old row 110.
  harness.observation.latest()!.emit({ text: lines.slice(10).join('\n') })
  await vt.waitForRender()
  assert.match(view(vt), /2\/3/, 'the same occurrence stays current')
  assert.match(highlightedRowText(vt), /needle B/,
    'the hit follows the PROVEN row mapping, never the old coordinates')
  assert.ok(!/needle C/.test(highlightedRowText(vt)), 'needle C must not inherit the selection')
  app.stop()
})

// ── B-10b4: a resize re-wrap never hands the hit to a coincidental match ───

test('B-10b4 a resize re-wrap drops the unprovable hit identity instead of handing it to a coincidental match', async () => {
  // Line 0 is exactly ONE row at width 120 and TWO rows at width 80, so after the
  // shrink both same-geometry hits sit one row lower: `NEED c` (the current hit)
  // lands on the row `NEED b` occupied before, and vice versa.
  const lines = Array.from({ length: 120 }, (_, index) => `line ${String(index).padStart(3, '0')}`)
  lines[0] = 'Z'.repeat(100)
  lines[9] = 'NEED b'
  lines[10] = 'NEED c'
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  const text = lines.join('\n')
  harness.observation.latest()!.emit({ text })
  await vt.waitForRender()
  vt.sendInput('\x1b[H')
  await vt.waitForRender()
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('NEED')
  await vt.waitForRender()
  assert.match(view(vt), /1\/2/)
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('n')
  await vt.waitForRender()
  assert.match(view(vt), /2\/2/, 'NEED c is current')
  assert.match(highlightedRowText(vt), /NEED c/)

  // Park the viewport on the current hit's row with plain scrolling and NO Job
  // output update at all: the frame-painted boundary is what records the visible
  // anchor the post-resize fallback must re-select from.
  for (let step = 0; step < 11; step += 1) vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(bodyTop(vt), 'line 011')
  assert.match(view(vt), /2\/2/, 'the hit is still current after plain scrolling')

  // Shrink: the re-wrap has NO proven row mapping, so the carried identity is
  // dropped and the VISIBLE ANCHOR (row 11) decides. `NEED c` moved to row 11 and
  // `NEED b` still occupies the old row 10, so a coordinate-carrying hit would
  // select index 0 (`1/2`); the anchor-correct result is the SECOND match.
  vt.resize(80, 40)
  const painted = await paintedWhen(vt, current => /2\/2/.test(current))
  assert.match(painted, /2\/2/, `the hit must not fall back to the coincidental match:\n${painted}`)
  // Bring the pair into view for the visible-sink check: the strong highlight
  // must be on `NEED c`, never on the coincidental `NEED b`.
  vt.sendInput('\x1b[H')
  await vt.waitForRender()
  assert.match(highlightedRowText(vt), /NEED c/,
    'the strong highlight stays on the occurrence the user was reading')
  assert.ok(!/NEED b/.test(highlightedRowText(vt)), 'NEED b must not inherit the selection')
  app.stop()
})

// ── B-10c: a pending reveal survives a snapshot landing before the paint ───

test('B-10c a pending result reveal survives a snapshot that lands between the keypress and the paint', async () => {
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 199) })
  await vt.waitForRender()
  assert.match(view(vt), /line 199/)

  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('line 05')
  await vt.waitForRender()
  assert.match(view(vt), /1\/10/)
  // Enter arms the reveal, and the newest retained window arrives BEFORE the
  // frame paints: the reveal must still happen against the new epoch.
  vt.sendInput('\r')
  harness.observation.latest()!.emit({ text: numberedLines(0, 219) })
  const painted = await paintedWhen(vt, current => /line 05[0-9]/.test(current))
  assert.match(painted, /Find Output: line 05/)
  assert.match(painted, /1\/10/, 'the selection survived the push')
  assert.match(painted, /line 05[0-9]/, `the selected match is really revealed:\n${painted}`)
  assert.match(painted, /Follow paused/)
  app.stop()
})

// ── B-10d: a lost current match falls back to the visible anchor ───────────

test('B-10d a truncation that EVICTS the current match falls back to the nearest provable match at the visible anchor', async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index).padStart(3, '0')}`)
  lines[10] = 'needle alpha'
  lines[190] = 'needle beta'
  lines[195] = 'needle gamma'
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: lines.join('\n') })
  await vt.waitForRender()
  vt.sendInput('\x1b[H') // top: the opening anchor is the window top
  await vt.waitForRender()
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(view(vt), /1\/3/, 'the first hit (row 10) is current after the reveal')

  // The new window evicts rows 0-149, so the current occurrence itself is GONE
  // (its predicted row is negative) while two other matches survive. With no
  // provable survivor the selection must fall back to the FIRST match at/after
  // the visible anchor — never to the clamped old ordinal (which would pick the
  // LAST surviving match). The "same occurrence survives the eviction" case is
  // B-10b3's.
  harness.observation.latest()!.emit({ text: numberedLines(150, 199).replace('line 190', 'needle beta').replace('line 195', 'needle gamma') })
  const painted = await paintedWhen(vt, current => /1\/2/.test(current))
  assert.match(painted, /1\/2/, `the nearest provable match from the visible anchor is selected:\n${painted}`)
  assert.match(painted, /Find Output: needle/)
  assert.match(painted, /Follow paused/)
  assert.ok(!/\[GAP\]/.test(painted))
  app.stop()
})

// ── B-11: the short-screen budget ──────────────────────────────────────────

test('B-11 short frames keep one Output row, the Action Bar last, and a Find only where its row can exist', async () => {
  const { vt, app } = startApp({}, {}, 44, 4)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 9) })
  await vt.waitForRender()
  let rows = rawView(vt)
  assert.equal(rows.length, 4)
  assert.match(rows[3]!, /Esc back/, 'the Action Bar is the last row')
  assert.match(rows[0]!, /Running/, 'the status row survives')
  assert.ok(rows.slice(0, 3).some(row => /line 00/.test(row)), 'at least one Output row stays readable')

  // A 4-row frame CAN host the SearchRow: it takes the header's second row.
  vt.sendInput('\x06')
  await vt.waitForRender()
  rows = rawView(vt)
  assert.equal(rows.length, 4)
  assert.match(rows[1]!, /Find Output:/, 'the SearchRow is inside the 4-row budget')
  assert.match(rows[3]!, /Esc back/)
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // Shrinking below four rows leaves the search (keeping the Job + PAUSED).
  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/)
  vt.resize(44, 3)
  await vt.waitForRender()
  const tiny = view(vt)
  assert.ok(!/Find Output:/.test(tiny), 'a frame with no SearchRow leaves the search')
  assert.match(tiny, /Esc back/, 'the Action Bar survives the shrink')
  assert.match(tiny, /job-a/, 'the Job is still the owner')

  // Growing again does not silently reopen a hidden editor.
  vt.resize(120, 40)
  await vt.waitForRender()
  assert.ok(!/Find Output:/.test(view(vt)), 'the search needs a fresh explicit Find')
  app.stop()
})

// ── B-12: lifecycle ────────────────────────────────────────────────────────

test('B-12 a Job replacement/dispose keeps ONE observer per Job and never restores the old query, anchor or focus', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  await openFirstJob(vt, harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 99) })
  await vt.waitForRender()
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('line 05')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: line 05/)

  // A same-session replacement (A → B) retires A once and B starts clean.
  harness.tasks.openJobView('job-b')
  await vt.waitForRender()
  const painted = view(vt)
  assert.ok(!/Find Output:/.test(painted), 'the new Job has no inherited search row')
  assert.match(painted, /Job · job-b · bash.*‣ Running/)
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true, 'the new Job owns the panel focus')
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'A released its observer exactly once')

  // Esc closes B once; the old search never revives on the browser.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1])
  assert.ok(!/Find Output:/.test(view(vt)))
  assert.equal(app.hostEditorTextForTest(), '', 'no stale Job input ever reached the editor')
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

// ── B-13: the strict follow survives a real production push (Direct shape) ──

test('B-13 the strict follow/search work over the production observer push, and the PAUSED state is not reset by a newer snapshot', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  const record = harness.observation.latest()!
  record.emit({ text: numberedLines(0, 159), progress: 'step 1', status: 'running' })
  await vt.waitForRender()
  assert.match(view(vt), /Progress: step 1/)
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('line 12')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(view(vt), /1\/10/)
  assert.match(view(vt), /Follow paused/)

  // A reconnect-style newer retained tail arrives through the SAME port.
  record.emit({ text: numberedLines(0, 179), progress: 'step 2', status: 'running' })
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /Progress: step 2/, 'the newer snapshot still updates the Header')
  assert.match(painted, /Follow paused/, 'the newer tail never resets the follow intent')
  assert.match(painted, /Find Output: line 12/, 'the search row keeps its query')
  assert.equal(harness.observation.records.length, 1, 'no reconnect opens a second observation')
  app.stop()
})

// ── B-08c: the reserved Tab page toggle outranks a Find remap onto it ───────

test('B-08c a Find binding remapped onto the reserved Tab cannot shadow the page toggle or be advertised', async () => {
  // `Tab` is reserved for the workspace's own page toggle exactly like Home/End: the
  // owner matches it BEFORE the Find check, and the Find hint drops such a binding. A
  // user remap onto `Tab` must therefore change NEITHER what the key does NOR what the
  // bar promises — the failure mode this pins is "Tab find" and "Tab switch" both
  // advertised while `Tab` really opened the Find.
  const { vt, app } = startApp({}, {}, 120, 40)
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  await openFirstJob(vt, harness)
  const bar = (): string => rawView(vt).at(-1) ?? ''
  harness.observation.latest()!.emit({ label: 'pnpm build --watch', text: 'line 001\nline 002' })
  await vt.waitForRender()
  assert.match(view(vt), /Ctrl\+F find/, 'the default direct binding is advertised')

  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    bindings: { 'app.transcript.search': 'tab' },
  }))
  await vt.waitForRender()

  assert.match(view(vt), /Tab switch/, 'the page toggle is advertised')
  assert.ok(!/Tab find/.test(view(vt)), 'a Find remapped onto the reserved Tab is never advertised')
  assert.match(view(vt), /\/ find/, '`/` is the only live Find entry left to name')

  // …and it cannot shadow the toggle: `Tab` really switches the page, BOTH ways.
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.match(view(vt), /Esc output/, 'Tab opened the Command page')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.match(view(vt), /Esc back/, 'Tab returned to the Output page')

  // The search stays reachable through the Job-local alias.
  vt.sendInput('/')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/, '`/` still opens the Output Find')

  // ── NAVIGATE: the reserved key is consumed there too, it never re-enters EDIT ──
  // A Find binding remapped onto `Tab` used to reach `openFind()` in this state and
  // flip the search back to EDIT. The discriminator is the SEARCH ROW itself: in EDIT
  // a printable key is query text, in NAVIGATE it is inert.
  const searchRow = (): string => rawView(vt).find(line => line.includes('Find Output:')) ?? ''
  vt.sendInput('line')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(bar(), /Follow paused · End resume/, 'Enter left the Output Find in NAVIGATE')
  const navigateRow = searchRow()
  assert.ok(navigateRow !== '', 'the Output search row is still painted in NAVIGATE')

  vt.sendInput('\t')
  await vt.waitForRender()
  assert.match(bar(), /Esc back/, 'Tab did NOT switch the page out of a NAVIGATE Find')
  assert.ok(!/Esc output/.test(view(vt)), 'the Command page was never entered')
  assert.match(bar(), /Follow paused · End resume/, 'Tab did NOT re-enter EDIT')
  vt.sendInput('z')
  await vt.waitForRender()
  assert.equal(searchRow(), navigateRow, 'a printable key is still inert: the search is still NAVIGATE, not EDIT')

  // The same from the Command page's own Find.
  vt.sendInput('\x1b') // ONE Esc leaves the NAVIGATE search; a second would close the workspace
  await vt.waitForRender()
  assert.match(bar(), /Esc back/, 'one Esc left only the search, the workspace is still up')
  vt.sendInput('\t') // now inactive: the reserved toggle switches the page
  await vt.waitForRender()
  assert.match(view(vt), /Esc output/, 'Tab switched to the Command page')
  vt.sendInput('/')
  await vt.waitForRender()
  assert.match(view(vt), /Find Command:/, 'the Job-local `/` opens the Command Find')
  const commandRow = (): string => rawView(vt).find(line => line.includes('Find Command:')) ?? ''
  vt.sendInput('cmd')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  const commandNavigateRow = commandRow()
  assert.ok(commandNavigateRow !== '', 'the Command search row is painted in NAVIGATE')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.match(view(vt), /Esc output/, 'Tab did NOT switch the page out of the Command NAVIGATE Find')
  vt.sendInput('z')
  await vt.waitForRender()
  assert.equal(commandRow(), commandNavigateRow, 'the Command Find is still NAVIGATE, not EDIT')
  app.stop()
})
