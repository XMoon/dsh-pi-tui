/**
 * Phase 3B / B1-A — the Job Workspace (implementation plan §10 A-01..A-12).
 *
 * The REAL closure: a mounted `TuiApp` + `VirtualTerminal` drives the REAL
 * `createTaskRuntime` owner and the real Task Browser; only the external
 * Job-observation PORT is replaced by an acquire/emit/disposer recorder (the
 * external boundary port, never an internal owner). The Job workspace itself is
 * the production `JobInspectorPanel` on its own temporary `TuiAltScreen`.
 *
 * The cases assert what the plan requires: a true fullscreen Job root (not an
 * enlarged overlay), typed Header vs retained Body, a pinned Action Bar on short
 * terminals, the SAME paused return surface and focus owner across the round
 * trip, ONE observer open/exactly-once release, Stop only through the existing
 * port under its live capability fence, and blocking-modal pre-emption.
 *
 * @module @xmoon76/dsh-pi-tui/job-inspector-workspace.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, TuiAltScreen, TuiMainScreen, visibleWidth } from '@xmoon76/pi-tui'
import type { TaskBrowserHandle, TuiAppEvents } from '../src/tui-app.ts'
import { TuiApp } from '../src/tui-app.ts'
import { JobInspectorPanel, deriveJobInspectorView } from '../src/tui/panels/job-inspector-panel.ts'
import { createTaskRuntime, type JobInspectorState, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservedSnapshot, JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import { parseUserKeybindings } from '../src/tui/keybindings/config.ts'
import type { TranscriptMessage } from '../src/transcript.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp started here is disposed after each test: the process's
 *  single-live-TUI slot (the vendored keybindings are process-global) is held
 *  only by LIVE surfaces. */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** Start the real surface with the caller's REAL event sinks (a fullscreen
 *  preference callback, a keyboard-exit counter) — never a later patch. */
function startApp(
  options: Record<string, unknown> = {},
  events: Partial<Pick<TuiAppEvents, 'onFullscreenChange' | 'onExit' | 'runOwned'>> = {},
): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
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

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** One acquired observer: its release counter and the exact emission channel
 *  the production follow stream would use. */
interface ObservationRecord {
  readonly jobId: string
  closes: number
  readonly emit: (patch: Partial<JobObservedSnapshot>) => void
}

/** The external Job-observation PORT double: acquire/emit/release only. */
class JobObservationDouble implements JobObservationPort {
  readonly records: ObservationRecord[] = []
  readonly stops: string[] = []
  /** Set to make the next `open` throw (the composition-without-controller
   *  safety valve). */
  openFailure: string | undefined
  /** Whether `open` emits its first snapshot synchronously (the official
   *  follow stream does). */
  syncEmit = true
  /** The settlement the next `stop` returns (default: requested). */
  stopOutcome: JobStopOutcome = { kind: 'requested' }
  /** Set to make the next `stop` throw instead of settling. */
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

  forJob(jobId: string): number[] {
    return this.records.filter(record => record.jobId === jobId).map(record => record.closes)
  }

  opensFor(jobId: string): number {
    return this.records.filter(record => record.jobId === jobId).length
  }

  latest(): ObservationRecord | undefined {
    return this.records.at(-1)
  }
}

interface TaskHarness {
  readonly tasks: TaskRuntime
  readonly observation: JobObservationDouble
  /** Every owner-retire reason the app delivered, in order. */
  readonly retires: readonly string[]
  /** Roster reads through the Task surface's `jobs.list` (the TUI's ONLY Job
   *  roster seam — a Job observation must never trigger one). */
  rosterReads(): number
  lastBrowser(): TaskBrowserHandle | undefined
  browsers(): readonly TaskBrowserHandle[]
}

/** Attach the REAL TaskRuntime owner to the real app (the production wiring:
 *  `mounted()` returns this app). */
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
  let rosterReads = 0
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
    jobs: {
      list: () => { rosterReads += 1; return jobSnapshots() },
      subscribe: () => () => {},
    },
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
  // Capture the real production browser handle and the owner-retire signal at
  // the app seam (the receiver is preserved — never `.bind`).
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
  return {
    tasks,
    observation,
    retires,
    rosterReads: () => rosterReads,
    lastBrowser: () => browsers.at(-1),
    browsers: () => browsers,
  }
}

/** Count every `start()` of the two long-lived screen classes, keeping the
 *  instance identity (the same object restarting IS the pause/resume proof). */
function recordScreenStarts(): { readonly main: TuiMainScreen[]; readonly alt: TuiAltScreen[]; restore: () => void } {
  const main: TuiMainScreen[] = []
  const alt: TuiAltScreen[] = []
  const originalMainStart = TuiMainScreen.prototype.start
  const originalAltStart = TuiAltScreen.prototype.start
  TuiMainScreen.prototype.start = function (this: TuiMainScreen): void {
    main.push(this)
    originalMainStart.call(this)
  }
  TuiAltScreen.prototype.start = function (this: TuiAltScreen): void {
    alt.push(this)
    originalAltStart.call(this)
  }
  return {
    main,
    alt,
    restore: () => {
      TuiMainScreen.prototype.start = originalMainStart
      TuiAltScreen.prototype.start = originalAltStart
    },
  }
}

/** The opening row of the harness' first Job (the projector's fallback input). */
const openingRow = (id = 'job-a'): JobInspectorState => ({
  opening: { jobId: id, kind: 'bash', label: `job ${id}`, status: 'running' },
})

// ── A-01: the pure typed projection ─────────────────────────────────────────

test('A-01 the projector separates connecting / observed / empty / gap+error+settled / unavailable', () => {
  // (1) no snapshot yet: the opener identity is a FALLBACK, the phase is
  // connecting and no retained output is claimed.
  const connecting = deriveJobInspectorView(openingRow())
  assert.equal(connecting.phase, 'connecting')
  assert.equal(connecting.retainedText, '')
  assert.equal(connecting.settled, false)
  assert.equal(connecting.observationError, undefined)

  // (2) an observed snapshot is the ONLY metadata source: retained text is the
  // exact snapshot text, never a composed header/prefix.
  const observed = deriveJobInspectorView({
    ...openingRow(),
    observed: {
      jobId: 'job-a',
      kind: 'bash',
      label: 'pnpm build',
      status: 'running',
      progress: 'building 3/8',
      text: 'line one\nline two\n',
      gapBefore: false,
      settled: false,
    },
  })
  assert.equal(observed.phase, 'observed')
  assert.equal(observed.retainedText, 'line one\nline two\n')
  assert.equal(observed.label, 'pnpm build')
  assert.equal(observed.progress, 'building 3/8')
  assert.match(observed.retainedText, /^line one/, 'the body must start at the retained text, never a status header')

  // (3) a settled Job with an empty retained tail is NOT the connecting state.
  const empty = deriveJobInspectorView({
    ...openingRow(),
    observed: {
      jobId: 'job-a', kind: 'bash', label: 'job a', status: 'completed',
      text: '', gapBefore: false, settled: true,
    },
  })
  assert.equal(empty.phase, 'observed')
  assert.equal(empty.retainedText, '')
  assert.equal(empty.settled, true)

  // (4) gap + error + settled are INDEPENDENT and co-visible on ONE snapshot.
  const combined = deriveJobInspectorView({
    ...openingRow(),
    observed: {
      jobId: 'job-a', kind: 'bash', label: 'job a', status: 'failed',
      text: 'tail', gapBefore: true, settled: true, error: 'stream reset',
    },
  })
  assert.equal(combined.gapBefore, true)
  assert.equal(combined.settled, true)
  assert.equal(combined.observationError, 'stream reset')
  assert.equal(combined.status, 'failed')

  // (5) the port refused to open: the reason stays visible, the identity falls
  // back to the opening row and there is NO retained text (never "finished with
  // no output").
  const unavailable = deriveJobInspectorView({ ...openingRow(), observationError: 'no job controller' })
  assert.equal(unavailable.phase, 'unavailable')
  assert.equal(unavailable.observationError, 'no job controller')
  assert.equal(unavailable.retainedText, '')
  assert.equal(unavailable.settled, false)
})

test('A-01b the panel header keeps status/gap/error visible and its Action Bar is the last row at every budget', () => {
  const budgets = [
    { width: 80, rows: 8 },
    { width: 80, rows: 24 },
    { width: 120, rows: 40 },
    { width: 200, rows: 60 },
    { width: 44, rows: 10 },
  ] as const
  for (const budget of budgets) {
    let stops = 0
    const panel = new JobInspectorPanel(
      {
        ...openingRow(),
        observed: {
          jobId: 'job-a', kind: 'bash', label: 'pnpm build --watch', status: 'failed',
          progress: 'building 3/8', detail: 'exit code 1',
          text: 'retained tail', gapBefore: true, settled: true, error: 'stream reset',
        },
      },
      {
        rows: () => budget.rows,
        requestRender: () => {},
        notice: () => undefined,
        onClose: () => {},
        canStop: () => true,
        onStop: () => { stops += 1 },
        isFindKey: () => false,
        findHint: () => '',
        focusComponent: () => {},
        onCopy: () => {},
        paintedBox: () => undefined,
        setNativeCopyOnSelect: () => {},
      },
    )
    const lines = panel.render(budget.width)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= budget.width, `no line may exceed ${budget.width} columns: ${JSON.stringify(line)}`)
    }
    // The header's own tokens carry theme ANSI, so assert on the VISIBLE text.
    const painted = lines.map(stripTerminalSequences).join('\n')
    // The status and every fact marker survive EVERY budget; the identity prefix
    // is only kept while it still fits beside them.
    assert.match(painted, /Failed/, `the status must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /\[GAP\]/, `the gap marker must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /\[ERROR\]/, `the error marker must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /\[SETTLED\]/, `the settled marker must stay visible at ${budget.width}x${budget.rows}`)
    if (budget.width >= 80 && budget.rows >= 10) {
      // The descriptive fact text rides the standard-size metadata row; on a
      // compact terminal the [GAP] marker on the status row is the fact that
      // survives every budget (plan B1-D §3.1/§3.2).
      assert.match(painted, /Earlier output evicted/, `the gap fact must be readable at ${budget.width}x${budget.rows}`)
    }
    if (budget.width >= 80) {
      assert.match(painted, /Job · job-a · bash.*‣ Failed/, `the identity must stay visible at ${budget.width}x${budget.rows}`)
    }
    // The Command/Label summary is part of the locked workspace UI: a short or
    // narrow screen may drop the descriptive fact text, never the Command row.
    assert.match(painted, /Command {2}pnpm build --watch/,
      `the command identity must be shown at every budget (${budget.width}x${budget.rows})`)
    if (budget.width >= 80 && budget.rows >= 10) {
      assert.match(painted, /Progress: building 3\/8/, 'the typed progress row must be shown on a tall screen')
    }
    // The pinned chrome never exceeds the granted row budget: the Action Bar is
    // the LAST rendered row and the layout always has room for it.
    assert.ok(lines.length <= Math.max(1, budget.rows - 1), 'the pinned chrome must leave a body row')
    assert.match(lines.at(-1)!, /Esc back/, `the Action Bar is the last rendered row at ${budget.width}x${budget.rows}`)
    if (budget.width >= 80) {
      // The bounded preview is disclosed at every standard budget — by the
      // DEDICATED reading-facts row where the frame grants it, and by the pinned
      // Action Bar otherwise. It is never advertised twice and never as a
      // complete history (plan B1-D §3.3).
      const disclosure = lines.findIndex(line => /Retained preview · not full history/.test(line))
      assert.notEqual(disclosure, -1, `the bounded preview is disclosed at ${budget.width}x${budget.rows}`)
      if (budget.width >= 100 && budget.rows >= 12) {
        assert.notEqual(disclosure, lines.length - 1, 'the dedicated facts row sits above the Action Bar')
        assert.match(lines[disclosure]!, /rows 0-0\/1/, 'the dedicated facts row carries the real position')
        assert.ok(!/Retained preview/.test(lines.at(-1)!), 'the Action Bar never repeats the disclosure')
      } else {
        assert.equal(disclosure, lines.length - 1, 'the pinned Action Bar carries the disclosure')
      }
    }
    if (budget.width >= 80) assert.match(lines.at(-1)!, /stop/, 'Stop is advertised while the capability is live')
    // Esc and the stop action are the panel's only intents.
    panel.handleInput('x')
    assert.equal(stops, 0, 'an ordinary key never stops the Job')
    panel.handleInput('s')
    assert.equal(stops, 1, 'the tasks.stop component action reaches the injected intent')
    panel.dispose()
    panel.handleInput('s')
    assert.equal(stops, 1, 'a disposed panel is inert')
  }
})

test('A-01c the Action Bar drops the Stop verb (never Esc back) when the capability dies', () => {
  let live = true
  let closes = 0
  const panel = new JobInspectorPanel(openingRow(), {
    rows: () => 24,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => { closes += 1 },
    canStop: () => live,
    onStop: () => {},
    isFindKey: () => false,
    findHint: () => '',
    focusComponent: () => {},
    onCopy: () => {},
    paintedBox: () => undefined,
    setNativeCopyOnSelect: () => {},
  })
  assert.match(panel.render(100).at(-1)!, /stop/)
  assert.match(panel.render(100).at(-1)!, /Esc back/)
  live = false
  const settled = panel.render(100).at(-1)!
  assert.match(settled, /Esc back/)
  assert.ok(!/stop/.test(settled), 'a settled Job must not advertise Stop')
  // The panel's only intents are Esc (close) and the gated stop action.
  panel.handleInput('s')
  assert.equal(closes, 0)
  panel.handleInput('\x1b')
  assert.equal(closes, 1)
  panel.dispose()
})

test('A-01d a long Job identity and a long error text never hide the status or the independent markers', () => {
  const longId = `job-${'x'.repeat(120)}`
  const panel = new JobInspectorPanel(
    {
      opening: { jobId: longId, kind: 'bash', label: 'long', status: 'failed' },
      observed: {
        jobId: longId, kind: 'bash', label: 'pnpm build --watch', status: 'failed',
        progress: 'p'.repeat(200), detail: 'd'.repeat(200),
        text: 'tail', gapBefore: true, settled: true, error: 'E'.repeat(180),
      },
    },
    {
      rows: () => 24,
      requestRender: () => {},
      notice: () => undefined,
      onClose: () => {},
      canStop: () => false,
      onStop: () => {},
      isFindKey: () => false,
      findHint: () => '',
      focusComponent: () => {},
      onCopy: () => {},
      paintedBox: () => undefined,
      setNativeCopyOnSelect: () => {},
    },
  )
  const lines = panel.render(80)
  const painted = lines.map(stripTerminalSequences).join('\n')
  assert.match(painted, /Failed/, `the status must survive a long identity:\n${painted}`)
  assert.match(painted, /\[GAP\]/, `the gap marker must survive:\n${painted}`)
  assert.match(painted, /\[ERROR\]/, `the error marker must survive:\n${painted}`)
  assert.match(painted, /\[SETTLED\]/, `the settled marker must survive a long error text:\n${painted}`)
  assert.match(painted, /Earlier output evicted/, `the gap fact must survive:\n${painted}`)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 80, `no line may exceed the row width: ${JSON.stringify(line)}`)
  }
  panel.dispose()
})

test('A-01e the ONE chrome plan keeps the Action Bar on screen at every height, notice included', () => {
  const flags = (): JobInspectorState => ({
    ...openingRow(),
    observed: {
      jobId: 'job-a', kind: 'bash', label: 'pnpm build --watch', status: 'failed',
      progress: 'building 3/8', detail: 'exit code 1',
      text: 'retained tail', gapBefore: true, settled: true, error: 'stream reset',
    },
  })
  const panelAt = (rows: number, noticeLive: boolean): JobInspectorPanel => new JobInspectorPanel(flags(), {
    rows: () => rows,
    requestRender: () => {},
    notice: () => (noticeLive ? { text: 'could not stop job job-a: refused', kind: 'error' } : undefined),
    onClose: () => {},
    canStop: () => false,
    onStop: () => {},
    isFindKey: () => false,
    findHint: () => '',
    focusComponent: () => {},
    onCopy: () => {},
    paintedBox: () => undefined,
    setNativeCopyOnSelect: () => {},
  })

  // 44×8 with GAP/ERROR: the compact header is status + summary + tabs, every
  // marker survives on the status row, and the Action Bar is the last row.
  const compact = panelAt(8, false).render(44)
  assert.equal(compact.length, 4, 'a compact header (status, summary, tabs) plus the pinned Action Bar (1)')
  assert.match(compact.at(-1)!, /Esc back/)
  assert.match(compact.join('\n'), /\[GAP\]/)
  assert.match(compact.join('\n'), /\[ERROR\]/)
  assert.match(compact.join('\n'), /\[SETTLED\]/)
  assert.match(compact.join('\n'), /Command {2}pnpm build --watch/)
  assert.match(compact.join('\n'), /Failed/)

  // 44×4 with a LIVE notice: the notice, the summary and the tabs all yield,
  // because taking a row would leave the Output with nothing.
  const tight = panelAt(4, true).render(44)
  assert.equal(tight.length, 2, 'only the status row and the pinned Action Bar fit a 4-row grant')
  assert.match(tight.at(-1)!, /Esc back/)
  assert.ok(!/could not stop/.test(tight.join('\n')), 'no notice row on a 4-row grant')

  // A 5-row grant is still too few for the notice (plan B1-D §3.2 grants it only
  // from six rows); 44×6 fits status + summary + tabs + notice + Action Bar with
  // exactly one Output row left over.
  assert.ok(!/could not stop/.test(panelAt(5, true).render(44).join('\n')),
    'a 5-row grant still has no notice row')
  const withNotice = panelAt(6, true).render(44)
  assert.equal(withNotice.length, 5, 'the notice is inside the height budget, never below the bar')
  assert.match(withNotice.at(-1)!, /Esc back/)
  assert.match(withNotice.join('\n'), /✗ could not stop job job-a: refused/)

  // 80×2 with a live notice: the notice YIELDS to the header and the Action Bar.
  const tiny = panelAt(2, true).render(80)
  assert.equal(tiny.length, 2, 'only the status row and the pinned Action Bar')
  assert.match(tiny.at(-1)!, /Esc back/)
  assert.match(tiny[0]!, /Failed/)
  assert.match(tiny.join('\n'), /\[GAP\]/)
  assert.ok(!/could not stop/.test(tiny.join('\n')), 'the notice yields on a 2-row terminal')
  assert.ok(!/Command/.test(tiny.join('\n')), 'the Command ranks below the status/markers')

  // 80×1 with a live notice: the Action Bar ALONE — it is never budgeted away.
  const one = panelAt(1, true).render(80)
  assert.equal(one.length, 1)
  assert.match(one[0]!, /Esc back/)
})

// ── A-02: the real Task Browser → Job workspace → same browser ─────────────
test('A-02 selecting a Job in the real Task Browser opens the fullscreen Job workspace and Esc returns to the SAME browser', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the browser is the only overlay')
  const focusBefore = app.focusedComponentForTest()
  assert.ok(focusBefore !== null, 'the browser owns the physical focus')

  const rosterBefore = harness.rosterReads()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(harness.observation.opensFor('job-a'), 1, 'selecting a Job opens exactly ONE observer')
  // The Job is a dedicated SCREEN, not a child overlay: the browser stays the
  // only physical overlay and the workspace root is the input owner.
  assert.equal(app.overlayGraphState().handles, 1, 'the Job workspace is never an overlay child')
  assert.equal(app.overlayGraphState().dependents, 0, 'the browser is not suppressed by an overlay')
  assert.ok(app.focusedComponentForTest() instanceof JobInspectorPanel,
    'the Job workspace root owns the physical focus')
  assert.deepEqual(harness.retires, [], 'opening a Job never retires the browser')
  const painted = view(vt)
  assert.match(painted, /Job · job-a · bash.*‣ Running/, `the typed header must be painted:\n${painted}`)
  assert.match(painted, /Command {2}job job-a/, 'a bash Job shows the Command identity row')
  assert.match(painted, /retained job-a/, 'the retained tail is painted in the body')
  assert.match(painted, /Retained preview · not full history/, 'the retained-preview disclosure stays pinned')
  assert.ok(!/job job-b/.test(painted), 'the Job screen shows ONE Job, never the roster')
  assert.equal(harness.rosterReads(), rosterBefore, 'a Job observation never triggers a roster read')

  // Esc leaves the workspace and returns to the SAME browser instance and
  // focus owner: nothing is rebuilt and no second observer appears.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'Esc releases the observer exactly once')
  assert.equal(app.overlayGraphState().handles, 1, 'the browser survived the round trip')
  assert.equal(app.focusedComponentForTest(), focusBefore, 'the SAME focus owner is restored')
  assert.equal(harness.tasks.openJobView('job-a'), 'keep-open', 'the runtime slot is reusable after the round trip')
  await vt.waitForRender()
  assert.equal(harness.observation.opensFor('job-a'), 2)
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1, 1], 'the parent close releases the child observer once')
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

// ── A-03/A-04: the paused return surface and the user's display mode ────────

test('A-03 regular → Job → regular: the SAME main screen restarts, the draft/cursor and the browser selection survive, and no display preference is written', async () => {
  let fullscreenChanges = 0
  const { vt, app } = startApp({}, { onFullscreenChange: () => { fullscreenChanges += 1 } })
  const screens = recordScreenStarts()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  // A real draft + cursor typed into the ORIGINAL editor must survive the round
  // trip (a rebuilt editor would come back empty at offset 0).
  vt.sendInput('kept draft text')
  await vt.waitForRender()
  assert.equal(app.hostEditorTextForTest(), 'kept draft text')
  const cursorBefore = app.seatEditorForTest().getCursor()
  assert.equal(cursorBefore, 'kept draft text'.length, 'the cursor really sits after the draft')

  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const browserBefore = harness.lastBrowser()!
  const selectionBefore = browserBefore.getViewState!().selectedId
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), false, 'a Job workspace is not the transcript fullscreen mode')
  const mainStartsDuring = screens.main.length
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), false)
  // The SAME main screen instance was restarted (identity, not a rebuild), and
  // the product display mode was never reported as changed.
  assert.equal(screens.main.at(-1), screens.main[0], 'the original main screen instance restarted')
  assert.ok(screens.main.length > mainStartsDuring, 'the pause was a real stop/start of the same screen')
  assert.equal(app.hostEditorTextForTest(), 'kept draft text', 'the original draft survived the Job round trip')
  assert.equal(app.seatEditorForTest().getCursor(), cursorBefore, 'the original cursor offset survived')
  assert.equal(harness.lastBrowser(), browserBefore, 'no second browser was constructed')
  assert.equal(harness.lastBrowser()!.getViewState!().selectedId, selectionBefore, 'the selected row survived')
  assert.equal(fullscreenChanges, 0, 'the Job round trip never wrote the user display preference')
  screens.restore()
  app.stop()
})

test('A-04 transcript fullscreen → Job → fullscreen: the SAME alt screen restarts with its NON-DEFAULT scroll state, and the user preference changes exactly once', async () => {
  let fullscreenChanges = 0
  const { vt, app } = startApp({}, { onFullscreenChange: () => { fullscreenChanges += 1 } })
  const screens = recordScreenStarts()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  // A real transcript taller than the viewport, scrolled to a NON-DEFAULT
  // position: a rebuilt screen/ScrollView would come back following the end.
  const lines: TranscriptMessage[] = [{
    kind: 'assistant',
    turn: 1,
    text: Array.from({ length: 160 }, (_, index) => `transcript line ${index}`).join('\n'),
  }]
  app.setTranscript(lines)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true)
  assert.equal(fullscreenChanges, 1, 'the explicit toggle is the ONE reported display change')
  vt.sendInput('\x1b[5~') // PageUp through the alt screen's viewport listener
  await vt.waitForRender()
  const altInstance = screens.alt.at(-1)!
  const scrollBefore = app.fullscreenScrollForTest()
  assert.ok(scrollBefore !== undefined, 'the transcript alt screen owns its ScrollView')
  assert.equal(scrollBefore.isFollowingEnd, false, 'the transcript really left the live tail')
  assert.ok(scrollBefore.scrollTop > 0, `the transcript really scrolled (${scrollBefore.scrollTop})`)
  const altStartsBefore = screens.alt.length
  const contentBefore = app.transcriptContentHeightForTest()

  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  // The transcript display mode is UNTOUCHED and the workspace is a THIRD
  // physical owner, not the transcript alt screen.
  assert.equal(app.isFullscreen(), true, 'the user transcript mode survives the Job view')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  const altDuring = screens.alt.length
  assert.equal(fullscreenChanges, 1, 'opening the workspace reports no display change')

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true)
  assert.equal(screens.alt.at(-1), altInstance, 'the SAME transcript alt screen restarted')
  assert.ok(screens.alt.length > altDuring, 'the transcript screen was paused, not rebuilt')
  assert.ok(screens.alt.length > altStartsBefore)
  const scrollAfter = app.fullscreenScrollForTest()
  assert.equal(scrollAfter?.isFollowingEnd, false, 'the off-tail follow state survived')
  assert.equal(scrollAfter?.scrollTop, scrollBefore.scrollTop, 'the exact scroll offset survived')
  assert.equal(app.transcriptContentHeightForTest(), contentBefore, 'the transcript content was not rebuilt')
  assert.equal(fullscreenChanges, 1, 'closing the workspace reports no display change')
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  screens.restore()
  app.stop()
})

// ── A-05: ONE observer, live pushes, gated Stop ─────────────────────────────

test('A-05 ONE observer pushes every snapshot into the painted workspace and Stop runs through the port once under its live gate', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(harness.observation.records.length, 1, 'exactly ONE observer is opened')

  // The synchronous first snapshot is already painted (never a lost first
  // frame), and a later push repaints the SAME workspace.
  assert.match(view(vt), /retained job-a/)
  harness.observation.latest()!.emit({ status: 'completed', text: 'final tail', settled: true })
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /final tail/, `the pushed snapshot must reach the paint:\n${painted}`)
  assert.match(painted, /Job · job-a · bash.*‣ Completed/)
  assert.match(painted, /\[SETTLED\]/)
  assert.equal(harness.observation.records.length, 1, 'no second subscription is ever opened')
  assert.equal(harness.observation.stops.length, 0)

  // A settled Job no longer advertises or accepts Stop.
  assert.ok(!/stop/.test(painted), `a settled Job must not advertise Stop:\n${painted}`)

  // A RUNNING Job accepts the component action exactly once, through the port.
  harness.observation.latest()!.emit({ status: 'running', text: 'live', settled: false })
  await vt.waitForRender()
  vt.sendInput('s')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.stops, ['job-a'], 'Stop dispatches the ONE port mutation')
  app.stop()
})

test('A-05c a Stop settlement failure is visible INSIDE the workspace (its own notice row) with no optimistic state change', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  const headerBefore = view(vt)

  // An unproven settlement: the workspace must SAY so where the user is looking.
  harness.observation.stopOutcome = { kind: 'indeterminate', message: 'the state will decide' }
  vt.sendInput('s')
  await flush()
  await vt.waitForRender()
  const first = view(vt)
  assert.match(first, /could not confirm stopping/, `the settlement failure must be visible in the workspace:\n${first}`)
  // …and the Job facts were NOT rewritten by the local Stop (no optimistic state).
  assert.match(first, /Job · job-a · bash.*‣ Running/)
  assert.match(first, /retained job-a/)

  // A throwing Stop dispatch is reported the same way, replacing the notice.
  harness.observation.stopFailure = new Error('kill admission refused')
  vt.sendInput('s')
  await flush()
  await vt.waitForRender()
  const second = view(vt)
  assert.match(second, /could not stop job job-a/, `the dispatch failure must be visible in the workspace:\n${second}`)
  assert.match(second, /Job · job-a · bash.*‣ Running/, 'still no optimistic state change')
  assert.deepEqual(harness.observation.stops, ['job-a', 'job-a'], 'each press dispatches exactly one port Stop')
  // The pinned Action Bar stays the last row even with the notice row present.
  const barRow = rawView(vt).findIndex(line => /Esc back/.test(line))
  assert.equal(barRow, 23, 'the Action Bar stays pinned to the physical bottom')
  assert.equal(headerBefore.includes('Esc back'), true)
  // The same notice on an extremely short REAL terminal: the pins hold.
  vt.resize(80, 2)
  await vt.waitForRender()
  const tiny = rawView(vt)
  assert.equal(tiny.length, 2)
  assert.match(tiny[1]!, /Esc back/, `the Action Bar must survive an 80x2 grant with a live notice:\n${tiny.join('\n')}`)
  assert.ok(!/could not stop/.test(tiny.join('\n')), 'the notice yields to the pinned chrome')

  // 44×4: the notice still yields — the Output keeps its row.
  vt.resize(44, 4)
  await vt.waitForRender()
  const tight = rawView(vt)
  assert.equal(tight.length, 4)
  assert.match(tight[3]!, /Esc back/, `the Action Bar stays last at 44x4:\n${tight.join('\n')}`)
  assert.ok(!/could not stop/.test(tight.join('\n')), 'a notice never squeezes the last output row away')
  assert.match(tight.join('\n'), /retained job-a/, `the Output keeps its row at 44x4:\n${tight.join('\n')}`)

  // 44×5: summary + tabs + Output + Action Bar use the whole grant, so the
  // notice still yields — the Output keeps its row.
  vt.resize(44, 5)
  await vt.waitForRender()
  const five = rawView(vt)
  assert.equal(five.length, 5)
  assert.match(five[4]!, /Esc back/, 'the Action Bar stays the last row')
  assert.ok(!/could not stop/.test(five.join('\n')),
    `a notice still yields at 44x5:\n${five.join('\n')}`)
  assert.match(five.join('\n'), /retained job-a/, `the Output keeps its row at 44x5:\n${five.join('\n')}`)

  // 44×6: the first grant tall enough for the transient notice — status, summary,
  // tabs, Output, notice, Action Bar.
  vt.resize(44, 6)
  await vt.waitForRender()
  const six = rawView(vt)
  assert.equal(six.length, 6)
  assert.match(six[5]!, /Esc back/, 'the Action Bar stays the last row at 44x6')
  assert.match(six.join('\n'), /could not stop job job-a/, `the notice shows once an output row is still guaranteed:\n${six.join('\n')}`)
  assert.match(six.join('\n'), /retained job-a/, `the Output keeps its row at 44x6:\n${six.join('\n')}`)

  vt.resize(80, 24)
  await vt.waitForRender()
  assert.match(view(vt), /could not stop job job-a/, 'the notice row returns with the room')
  app.stop()
})

test('A-05b a failed observation open still opens the workspace with the reason visible and Esc usable', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  harness.observation.openFailure = 'no job controller'
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /\[ERROR\]/, `the error marker must stay visible:\n${painted}`)
  assert.match(painted, /Error: no job controller/, `the reason must stay visible:\n${painted}`)
  assert.match(painted, /Retained output unavailable/)
  assert.equal(harness.observation.records.length, 0)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the browser is still there')
  app.stop()
})

// ── A-06: real terminal budgets and resize ──────────────────────────────────

test('A-06 the workspace re-budgets with the LIVE terminal: tail and Action Bar stay visible on short/narrow/large screens', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  const longText = Array.from({ length: 200 }, (_, index) => `output line ${index}`).join('\n')
  harness.observation.latest()!.emit({ text: `${longText}\nLATEST TAIL LINE` })
  await vt.waitForRender()

  for (const [width, height] of [[80, 8], [80, 24], [120, 40], [44, 10], [200, 60]] as const) {
    vt.resize(width, height)
    await vt.waitForRender()
    const lines = rawView(vt)
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
    assert.match(lines.join('\n'), /Job · job-a · bash.*‣ Running/, `the header must survive ${width}x${height}`)
    const barRow = lines.findIndex(line => /Esc back/.test(line))
    assert.notEqual(barRow, -1, `the Action Bar must be painted at ${width}x${height}`)
    assert.ok(barRow < height, `the Action Bar must be inside the screen at ${width}x${height}`)
    assert.ok(lines[barRow]!.includes('Retained preview') || lines[barRow]!.includes('Esc back'))
    assert.match(lines.join('\n'), /LATEST TAIL LINE/, `the latest retained line must be visible at ${width}x${height}`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `no physical line may exceed ${width} columns at ${height} rows`)
    }
    // The Action Bar never scrolls away with the body: it is the LAST row.
    assert.equal(barRow, height - 1, `the Action Bar must be pinned to the physical bottom at ${width}x${height}`)
  }
  vt.resize(80, 24)
  await vt.waitForRender()
  app.stop()
})

// ── A-07: same-session replacement and closure re-entry ─────────────────────

test('A-07 a same-session A → B replacement releases each observer once and a re-entrant open inside A\'s close owns the final workspace', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(harness.observation.opensFor('job-a'), 1)
  // A → B through the runtime (a second selection while A is open).
  harness.tasks.openJobView('job-b')
  await vt.waitForRender()
  assert.equal(harness.observation.opensFor('job-b'), 1)
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'A is released exactly once when B replaces it')
  assert.match(view(vt), /Job · job-b · bash.*‣ Running/)
  assert.ok(!/Job · job-a/.test(view(vt)), 'A must not repaint over B')
  // Esc leaves B and the runtime slot is clean.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1])
  app.stop()
})

test('A-07b a re-entrant Job open inside the closing workspace\'s onClose wins over the outer replacement', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b', 'job-c'] })
  await flush()
  const closed: string[] = []
  const originalOpen = app.openJobInspector
  let reentered = false
  try {
    // Wrapped BEFORE the first open, so workspace A's own onClose re-enters.
    app.openJobInspector = function (this: TuiApp, options: Parameters<typeof originalOpen>[0]) {
      const inner = options.onClose
      return originalOpen.call(this, {
        ...options,
        onClose: () => {
          inner()
          closed.push('close')
          if (!reentered && !app.isDisposed()) {
            reentered = true
            // A's closure synchronously selects job C: the newer intent must win
            // and A may never restore its own screen over C.
            harness.tasks.openJobView('job-c')
          }
        },
      })
    }
    harness.tasks.openTasksBrowser('full')
    await vt.waitForRender()
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.match(view(vt), /Job · job-a · bash.*‣ Running/)

    // A -> B: B commits its token, then closing A re-enters and commits C.
    harness.tasks.openJobView('job-b')
    await vt.waitForRender()
    assert.equal(reentered, true, 'the re-entry ran inside A\'s closure')
    assert.deepEqual(closed, ['close'], 'A notified its owner exactly once')
    assert.equal(harness.observation.opensFor('job-b'), 0, 'B never opened an observer: C superseded it first')
    assert.equal(harness.observation.opensFor('job-c'), 1)
    assert.match(view(vt), /Job · job-c · bash.*‣ Running/, 'the newer workspace owns the screen')
    assert.ok(!/Job · job-b/.test(view(vt)), 'B must never paint over C')
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'A released its observer once')
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-c'), [1])
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  } finally {
    app.openJobInspector = originalOpen
  }
  app.stop()
})

// ── A-08: every external close path ─────────────────────────────────────────

test('A-08 the parent browser close, resetTasks, the explicit observer release and TUI dispose all close the workspace exactly once', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()

  // (1) parent-only close.
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the parent close releases the child once')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  assert.equal(app.overlayGraphState().handles, 0)

  // (2) resetTasks (a session transition).
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  harness.tasks.resetTasks()
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1, 1])
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)

  // (3) the runner's explicit observer release.
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  harness.tasks.disposeJobObservation()
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1, 1, 1])
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)

  // (4) the final surface disposal of a still-open workspace.
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  app.dispose()
  startedApps.delete(app)
  assert.deepEqual(harness.observation.forJob('job-a'), [1, 1, 1, 1], 'disposal releases the workspace observer once')
})

test('A-08b a Job workspace requested while a blocking modal owns the surface is REFUSED without a half screen', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const pending = app.askQuestions([{ id: 'q1', question: 'answer me?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.match(view(vt), /answer me\?/)
  // The blocking owner is live: the runtime's Job caller must refuse the lease
  // (its mount refuses) and release the observation it just acquired — never a
  // half screen under the question, and never a leaked background stream.
  assert.throws(() => harness.tasks.openJobView('job-a'), /blocking modal owns the surface/,
    'the refusing seam relays the real failure')
  await vt.waitForRender()
  assert.equal(harness.observation.records.length, 1, 'the observer was acquired before the refusal')
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the refused workspace releases its observer exactly once')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  assert.match(view(vt), /answer me\?/, 'the question still owns the screen')
  // The question really owns the keyboard and settles normally (its two-step
  // confirm: select the option, then submit).
  vt.sendInput('\r')
  vt.sendInput('\r')
  const answer = await pending.catch(() => undefined)
  assert.ok(answer !== undefined, 'the blocking owner received the confirm keys')
  await vt.waitForRender()
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

// ── A-09: blocking-owner pre-emption while the Job is open ──────────────────

test('A-09 a Question / Approval / Save request arriving while the Job is open leaves the workspace BEFORE it can swallow the keys', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)

  const pending = app.askQuestions([{ id: 'q1', question: 'blocking question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the workspace releases its observer on pre-emption')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  const painted = view(vt)
  assert.match(painted, /blocking question\?/, `the question frame must be painted:\n${painted}`)
  assert.ok(!/Job · job-a · bash/.test(painted), 'the Job screen must be gone, not layered under the question')
  // The question really owns the keyboard: its own two-step confirm is routed.
  vt.sendInput('\r')
  vt.sendInput('\r')
  const answer = await pending.catch(() => undefined)
  assert.ok(answer !== undefined, 'the blocking owner received the keys')
  await vt.waitForRender()
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-09b an Approval arriving while the Job is open leaves the workspace and really receives the keys', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run the build' })
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the workspace releases its observer on pre-emption')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  const painted = view(vt)
  assert.match(painted, /run the build/, `the approval must be painted:\n${painted}`)
  assert.ok(!/Job · job-a · bash/.test(painted), 'the Job screen must be gone, not layered under the approval')
  // The approval owns the keyboard: its own approve key reaches it.
  vt.sendInput('y')
  const outcome = await approval
  assert.equal(outcome, 'allowed-once')
  await vt.waitForRender()
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-09c a Save Location prompt arriving while the Job is open leaves the workspace and really receives the keys', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)

  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    {
      resolveDirectory: input => input,
      isDirectory: () => true,
      targetExists: () => false,
      complete: async () => null,
    },
  )
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the workspace releases its observer on pre-emption')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  const painted = view(vt)
  assert.match(painted, /Save session archive/, `the Save prompt must be painted:\n${painted}`)
  assert.ok(!/Job · job-a · bash/.test(painted), 'the Job screen must be gone, not layered under the prompt')
  // The prompt owns the keyboard: Esc cancels it through its own contract.
  vt.sendInput('\x1b')
  const result = await save
  assert.equal(result.kind, 'cancelled', 'the prompt really received its cancel key')
  await vt.waitForRender()
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-09d a Question presented BY the workspace close callback queues the older request instead of overwriting it', async () => {
  const { vt, app } = startApp()
  let innerQuestion: Promise<unknown> | undefined
  let reentered = false
  const handle = app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {
      if (reentered) return
      reentered = true
      innerQuestion = app.askQuestions([{ id: 'inner', question: 'inner question?', options: [{ label: 'Yes' }] }])
    },
  })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)

  // The OUTER question is requested while the workspace is open: its
  // abandonment callback presents the NEWER inner question, which must keep the
  // seat (a callback's newer operation wins) while the outer stays queued with a
  // live owner.
  const outerQuestion = app.askQuestions([{ id: 'outer', question: 'outer question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.equal(handle !== undefined, true)
  const painted = view(vt)
  assert.match(painted, /inner question\?/, `the newer question must own the seat:\n${painted}`)
  assert.ok(!/outer question\?/.test(painted), `the older request must be queued, not mounted:\n${painted}`)
  // Answer the inner flow: the queued outer request is handed the seat and can
  // still be answered — neither promise is orphaned.
  vt.sendInput('\r')
  vt.sendInput('\r')
  const innerAnswer = await innerQuestion
  assert.deepEqual(innerAnswer, [{ id: 'inner', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.match(view(vt), /outer question\?/, 'the queued older request takes the seat when the newer one settles')
  vt.sendInput('\r')
  vt.sendInput('\r')
  const outerAnswer = await outerQuestion
  assert.deepEqual(outerAnswer, [{ id: 'outer', selected: ['Yes'] }])
  await vt.waitForRender()
  app.stop()
})

test('A-09e a Save Location request whose abandonment callback presents a Question is REFUSED, never mounted over it', async () => {
  const { vt, app } = startApp()
  let innerQuestion: Promise<unknown> | undefined
  let reentered = false
  app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {
      if (reentered) return
      reentered = true
      innerQuestion = app.askQuestions([{ id: 'inner', question: 'newer question?', options: [{ label: 'Yes' }] }])
    },
  })
  await vt.waitForRender()
  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    {
      resolveDirectory: input => input,
      isDirectory: () => true,
      targetExists: () => false,
      complete: async () => null,
    },
  )
  const result = await save.catch((error: unknown) => error)
  assert.ok(result instanceof Error, 'the prompt is refused, never constructed behind the newer owner')
  assert.match(result.message, /a host question or approval is active/)
  await vt.waitForRender()
  const painted = view(vt)
  assert.match(painted, /newer question\?/, `the newer question keeps the seat:\n${painted}`)
  assert.ok(!/Save session archive/.test(painted), 'no Save prompt may be mounted over the newer owner')
  vt.sendInput('\r')
  vt.sendInput('\r')
  await innerQuestion
  await vt.waitForRender()
  app.stop()
})

test('A-09k an ALREADY-aborted Approval never preempts the Job workspace', async () => {
  const { vt, app } = startApp()
  const handle = app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  const controller = new AbortController()
  controller.abort()
  // The approvals owner settles a pre-aborted request `cancelled` synchronously and
  // never mounts a prompt: it must not kick the user out of the workspace either.
  const outcome = await app.showApprovalPrompt({ toolName: 'bash', reason: 'cancelled long ago', signal: controller.signal })
  assert.equal(outcome, 'cancelled')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true,
    'the workspace keeps the physical surface for a request that can never appear')
  const painted = view(vt)
  assert.match(painted, /Job · job-a · bash.*‣ Running/, `the workspace must stay visible:\n${painted}`)
  assert.ok(!/cancelled long ago/.test(painted), 'no approval frame may be mounted')
  handle.close()
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  app.stop()
})

test('A-09f the effective exit request keeps its Host admission inside the workspace', async () => {
  let exits = 0
  const { vt, app } = startApp({}, { onExit: () => { exits += 1 } })
  const handle = app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  assert.equal(exits, 0)
  // The default exit keys are Ctrl+C / Ctrl+D and require a same-key second
  // press: the workspace must not swallow either one.
  vt.sendInput('\x04')
  await vt.waitForRender()
  assert.equal(exits, 0, 'the first press only arms the confirmation')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true, 'the workspace stays open')
  vt.sendInput('\x04')
  await vt.waitForRender()
  assert.equal(exits, 1, 'the second effective exit press really exits even while the workspace is open')
  handle.close()
  await vt.waitForRender()
  app.stop()
})

test('A-09g a throwing workspace close never truncates the stop teardown', async () => {
  const { vt, app } = startApp()
  const stops: TuiMainScreen[] = []
  const originalStop = TuiMainScreen.prototype.stop
  TuiMainScreen.prototype.stop = function (this: TuiMainScreen, options?: Parameters<typeof originalStop>[0]): void {
    stops.push(this)
    originalStop.call(this, options)
  }
  try {
    app.openJobInspector({
      initial: openingRow(),
      canStop: () => false,
      onStop: () => {},
      onClose: () => { throw new Error('owner notification failed') },
    })
    await vt.waitForRender()
    const stopsBefore = stops.length
    assert.throws(() => app.stop(), /owner notification failed/,
      'the real failure is still reported')
    // The independent teardown obligations ran regardless: the main screen (the
    // return surface) was really stopped and the surface is not left owning the
    // terminal.
    assert.ok(stops.length > stopsBefore, 'the main screen stop must still run under a throwing workspace close')
    assert.equal(app.isDisposed(), false, 'stop() is not dispose()')
  } finally {
    TuiMainScreen.prototype.stop = originalStop
  }
})

test('A-09h a workspace leased BY the close callback during stop() is refused: no lease, no observer and no input owner survives', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const stops: TuiMainScreen[] = []
  const originalStop = TuiMainScreen.prototype.stop
  TuiMainScreen.prototype.stop = function (this: TuiMainScreen, options?: Parameters<typeof originalStop>[0]): void {
    stops.push(this)
    originalStop.call(this, options)
  }
  const originalOpen = app.openJobInspector
  let reentered = false
  app.openJobInspector = function (this: TuiApp, options: Parameters<typeof originalOpen>[0]) {
    const inner = options.onClose
    return originalOpen.call(this, {
      ...options,
      onClose: () => {
        inner()
        if (!reentered) {
          reentered = true
          // The callback synchronously selects ANOTHER Job while the stop is
          // abandoning this one.
          harness.tasks.openJobView('job-b')
        }
      },
    })
  }
  try {
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
    const stopsBefore = stops.length
    assert.throws(() => app.stop(), /completing a transition/,
      'the refused reentrant lease is surfaced by the stop batch, never swallowed')
    assert.equal(reentered, true, 'the callback really attempted a newer lease')
    // The refused lease never kept a screen, an observer or the keyboard.
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false, 'no workspace survives the stop')
    assert.deepEqual(harness.observation.forJob('job-b'), [1],
      'the refused lease released its observation exactly once')
    assert.ok(stops.length > stopsBefore, 'the terminal transition really ran')
    // The latch is not stuck: a normal round-trip can lease again.
    app.start()
    await vt.waitForRender()
    const reopened = app.openJobInspector({
      initial: openingRow('job-b'),
      canStop: () => false,
      onStop: () => {},
      onClose: () => {},
    })
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
    reopened.close()
    await vt.waitForRender()
  } finally {
    app.openJobInspector = originalOpen
    TuiMainScreen.prototype.stop = originalStop
  }
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-09i a workspace leased BY the abandonment callback while a blocking owner arrives is refused: the Question is visible and owns the keyboard', async () => {
  const failures: unknown[] = []
  const { vt, app } = startApp({}, {
    // The failure channel of `routeTerminalSettlementFailure`: the abandonment
    // failure is REPORTED, never swallowed and never propagated into the
    // blocking owner's commit.
    runOwned: (<T>(_label: string, run: () => T | Promise<T>, options?: {
      onResult?: (result: T) => void | Promise<void>
      onError?: (error: unknown) => void
    }): void => {
      try {
        options?.onResult?.(run() as T)
      } catch (error) {
        failures.push(error)
        options?.onError?.(error)
      }
    }) as TuiAppEvents['runOwned'],
  })
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const originalOpen = app.openJobInspector
  let reentered = false
  app.openJobInspector = function (this: TuiApp, options: Parameters<typeof originalOpen>[0]) {
    const inner = options.onClose
    return originalOpen.call(this, {
      ...options,
      onClose: () => {
        inner()
        if (!reentered) {
          reentered = true
          harness.tasks.openJobView('job-b')
        }
      },
    })
  }
  try {
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)

    const question = app.askQuestions([{ id: 'q1', question: 'blocking question?', options: [{ label: 'Yes' }] }])
    await vt.waitForRender()
    assert.equal(reentered, true, 'the abandonment callback really attempted a newer lease')
    // The newer lease was refused: the blocking owner is VISIBLE on the restored
    // surface and really owns the keyboard — never an invisible frame over a Job.
    const painted = view(vt)
    assert.match(painted, /blocking question\?/, `the blocking owner must be visible:\n${painted}`)
    assert.ok(!/Job · job-a · bash/.test(painted), 'no Job screen may remain behind the blocking owner')
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
    assert.deepEqual(harness.observation.forJob('job-b'), [1],
      'the refused lease released its observation exactly once')
    assert.equal(failures.length, 1, 'the abandonment failure was reported, never swallowed')
    assert.match(String(failures[0]), /completing a transition/)
    vt.sendInput('\r')
    vt.sendInput('\r')
    const answer = await question
    assert.deepEqual(answer, [{ id: 'q1', selected: ['Yes'] }], 'the question really received its keys')
  } finally {
    app.openJobInspector = originalOpen
  }
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-09j a leader-bound effective exit still leaves the TUI while every other leader action stays blocked', async () => {
  let exits = 0
  let tasksOpened = 0
  const { vt, app } = startApp({}, { onExit: () => { exits += 1 } })
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.exit.request': '<leader>x', 'app.tasks.open': '<leader>t' },
  }))
  const handle = app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  const press = async (key: string): Promise<void> => {
    vt.sendInput('\x18') // leader prefix
    await vt.waitForRender()
    vt.sendInput(key)
    await vt.waitForRender()
  }

  // Phase 1: a NON-exit leader action is cancelled inside the workspace (never
  // dispatched), and the leader-bound EXIT needs its same-sequence second
  // completion, exactly like the direct exit key.
  await press('t')
  assert.equal(tasksOpened, 0, 'a leader-bound background action must stay blocked inside the workspace')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true, 'the workspace keeps the keyboard')
  await press('x')
  assert.equal(exits, 0, 'the first leader completion only arms the confirmation')
  await press('x')
  assert.equal(exits, 1, 'the same leader sequence confirms and really leaves the TUI')

  // Phase 2: a BLOCKED non-exit completion is an intervening action — it must
  // disarm the pending exit confirmation, so a fresh exit sequence only arms.
  await press('x')
  assert.equal(exits, 1)
  await press('t')
  assert.equal(tasksOpened, 0)
  await press('x')
  assert.equal(exits, 1, 'a blocked leader action must disarm the pending exit confirmation')
  await press('x')
  assert.equal(exits, 2, 'the re-armed same leader sequence confirms')

  // Phase 3: a pending sequence cancelled by Escape disarms it too, and the
  // Escape itself only cancels the sequence (the workspace stays open).
  await press('x')
  assert.equal(exits, 2)
  vt.sendInput('\x18')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true,
    'a pending-sequence Escape only cancels the sequence')
  await press('x')
  assert.equal(exits, 2, 'a cancelled sequence must disarm the pending exit confirmation')
  await press('x')
  assert.equal(exits, 3, 'the confirmed leader-bound exit really leaves the TUI')
  handle.close()
  await vt.waitForRender()
  app.stop()
})

// ── A-10: read-only workspace ───────────────────────────────────────────────

test('A-10 ordinary keys and host shortcuts are inert inside the workspace and never touch the editor, transcript or browser; the effective Find opens ONLY the Job Find', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const browserBefore = harness.lastBrowser()!
  const selectedBefore = browserBefore.getViewState!().selectedId
  vt.sendInput('\r')
  await vt.waitForRender()
  const draftBefore = app.hostEditorTextForTest()
  const overlayBefore = app.overlayGraphState().handles
  // Patch the LIVE app's production Transcript-search entry (receiver preserved)
  // so "B1-B never enters the background search" is a real call count.
  const originalStartTranscriptSearch = app.startTranscriptSearch
  let transcriptSearches = 0
  app.startTranscriptSearch = function (this: TuiApp): void {
    transcriptSearches += 1
    originalStartTranscriptSearch.call(this)
  }

  for (const chunk of ['x', '\r', '\x0f', '\x1b[B', '\x1b[A', '1']) {
    vt.sendInput(chunk)
    await vt.waitForRender()
  }
  assert.equal(app.hostEditorTextForTest(), draftBefore, 'the workspace never types into the editor')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true, 'the workspace keeps the keyboard')
  assert.equal(app.overlayGraphState().handles, overlayBefore, 'no search/overlay was opened from inside the Job')
  assert.equal(browserBefore.getViewState!().selectedId, selectedBefore, 'the browser selection never moved')
  assert.equal(transcriptSearches, 0)

  // B1-B: the effective Find binding opens the JOB's own Find — not the
  // Transcript search handler and not any overlay.
  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output:/, 'the Job Find really opened in the workspace')
  assert.equal(transcriptSearches, 0, 'the Transcript search handler was never entered')
  assert.equal(app.overlayGraphState().handles, overlayBefore, 'the Job Find is a layout row, never an overlay')
  assert.equal(app.hostEditorTextForTest(), draftBefore, 'Find never types into the editor')
  vt.sendInput('job-a')
  await vt.waitForRender()
  assert.match(view(vt), /Find Output: job-a/)
  assert.equal(app.hostEditorTextForTest(), draftBefore)

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true, 'the first Esc leaves only the search')
  assert.ok(!/Find Output:/.test(view(vt)))

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(harness.lastBrowser(), browserBefore, 'Esc Back returns to the SAME browser instance')
  assert.equal(browserBefore.getViewState!().selectedId, selectedBefore)
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

// ── A-11: the legacy sibling path is untouched ──────────────────────────────

test('A-11 the standalone output viewer stays the legacy overlay and never becomes a Job workspace', async () => {
  const { vt, app } = startApp()
  let closes = 0
  const closer = app.openOutputViewer({
    title: 'sign-in notice',
    initial: 'legacy body',
    refresh: () => 'legacy body',
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the legacy viewer is still an overlay')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  const painted = view(vt)
  assert.match(painted, /sign-in notice/)
  assert.match(painted, /legacy body/)
  assert.ok(!/Retained preview · not full history/.test(painted), 'the legacy viewer keeps its own hint contract')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(closes, 1)
  assert.equal(app.overlayGraphState().handles, 0)
  closer()
  assert.equal(closes, 1)
  app.stop()
})

// ── A-12: failure propagation and re-entry ──────────────────────────────────

test('A-12 a throwing workspace open releases the observation once, retires the viewer token and rethrows the real error', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const originalOpen = app.openJobInspector
  try {
    // The RUNTIME seam failure (the app-level mount refusing/throwing before any
    // physical step). The REAL screen start/stop unwind is covered by A-12d.
    app.openJobInspector = function (): never {
      throw new Error('screen start failed')
    }
    assert.throws(() => harness.tasks.openJobView('job-a'), /screen start failed/,
      'the runtime relays the REAL mount failure instead of a silent "no output"')
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the failed open must still release the observer once')
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false)
  } finally {
    app.openJobInspector = originalOpen
  }
  // The token fence is retired: a later Job B opens cleanly and A can never
  // clear it.
  harness.tasks.openJobView('job-b')
  await vt.waitForRender()
  assert.match(view(vt), /Job · job-b · bash.*‣ Running/)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1])
  assert.deepEqual(harness.observation.forJob('job-a'), [1])
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-12b a throwing workspace onClose still releases the screen and panel once and restores the return surface', async () => {
  const { vt, app } = startApp()
  const screens = recordScreenStarts()
  const panelDisposals: number[] = []
  const originalDispose = JobInspectorPanel.prototype.dispose
  JobInspectorPanel.prototype.dispose = function (this: JobInspectorPanel): void {
    panelDisposals.push(1)
    originalDispose.call(this)
  }
  try {
    const focusBefore = app.focusedComponentForTest()
    const handle = app.openJobInspector({
      initial: openingRow(),
      canStop: () => false,
      onStop: () => {},
      onClose: () => { throw new Error('owner notification failed') },
    })
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
    assert.throws(() => handle.close(), /owner notification failed/, 'the real failure propagates')
    // The non-truncating cleanup ran: the panel was released exactly once, the
    // main screen restarted and the physical focus owner is back.
    assert.equal(panelDisposals.length, 1, 'the panel is released exactly once despite the throwing notification')
    assert.equal(screens.main.at(-1), screens.main[0], 'the same main screen instance restarted')
    assert.equal(app.focusedComponentForTest(), focusBefore)
    // A repeated close is inert.
    handle.close()
    handle.update(openingRow())
    assert.equal(panelDisposals.length, 1)
    assert.equal(app.focusedComponentForTest(), focusBefore)
  } finally {
    JobInspectorPanel.prototype.dispose = originalDispose
    screens.restore()
  }
  app.stop()
})

test('A-12d a REAL failing Job screen start unwinds: the observation is released once, the return surface is restarted and the terminal owner is restored', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const focusBefore = app.focusedComponentForTest()
  const originalAltStart = TuiAltScreen.prototype.start
  let failing = true
  TuiAltScreen.prototype.start = function (this: TuiAltScreen): void {
    if (failing) {
      failing = false
      // The mount really fails at the physical step: the return screen is
      // already stopped and the Job screen never takes the terminal.
      throw new Error('screen start failed')
    }
    originalAltStart.call(this)
  }
  try {
    assert.throws(() => harness.tasks.openJobView('job-a'), /screen start failed/,
      'the physical start failure is relayed, never a silent "no output"')
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the failed mount releases its observer exactly once')
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false, 'no Job screen survives')
    assert.equal(app.focusedComponentForTest(), focusBefore, 'the paused surface and its focus owner were restored')
    // The restored surface really owns the terminal input again: the SAME
    // browser answers Enter and a Job opens through the real runtime path.
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true,
      'the restored browser is interactive after the failed mount')
    assert.deepEqual(harness.observation.forJob('job-a'), [1, 0],
      'the restored browser re-acquires the observer through the real runtime path')
  } finally {
    TuiAltScreen.prototype.start = originalAltStart
  }
  // The lease was unwound: the surface is fully usable afterwards.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1, 1])
  harness.tasks.openJobView('job-b')
  await vt.waitForRender()
  assert.match(view(vt), /Job · job-b · bash.*‣ Running/)
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1])
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-12e a REAL failing Job screen stop never strands the panel, the return surface or the observation', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const focusBefore = app.focusedComponentForTest()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  const panelDisposals: number[] = []
  const originalPanelDispose = JobInspectorPanel.prototype.dispose
  JobInspectorPanel.prototype.dispose = function (this: JobInspectorPanel): void {
    panelDisposals.push(1)
    originalPanelDispose.call(this)
  }
  const originalAltStop = TuiAltScreen.prototype.stop
  TuiAltScreen.prototype.stop = function (this: TuiAltScreen, options?: Parameters<typeof originalAltStop>[0]): void {
    originalAltStop.call(this, options)
    throw new Error('job screen stop failed')
  }
  try {
    // The workspace close really fails at the physical screen stop.
    assert.throws(() => vt.sendInput('\x1b'), /job screen stop failed/, 'the real failure propagates')
    await vt.waitForRender()
    // The INDEPENDENT obligations still ran: the panel (its ScrollView/body) was
    // released exactly once, the observation was released exactly once, the
    // return surface and its focus owner were restored, and no lease survives.
    assert.equal(panelDisposals.length, 1, 'the panel is released exactly once despite the failing screen stop')
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the observer is released exactly once')
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, false, 'no lease survives')
    assert.equal(app.focusedComponentForTest(), focusBefore, 'the return surface and its focus owner were restored')
    // The restored surface really owns the terminal input again.
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true,
      'the restored browser is interactive after the failed stop')
    assert.deepEqual(harness.observation.forJob('job-a'), [1, 0])
  } finally {
    TuiAltScreen.prototype.stop = originalAltStop
    JobInspectorPanel.prototype.dispose = originalPanelDispose
  }
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1, 1])
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

test('A-12c a second workspace lease is refused while one is open, and a disposed surface refuses both', async () => {
  const { vt, app } = startApp()
  const handle = app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  })
  await vt.waitForRender()
  assert.throws(() => app.openJobInspector({
    initial: openingRow('job-b'),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  }), /already leased/, 'a second physical screen owner is refused')
  // setFullscreen must not tear the paused surface down while the Job owns the
  // screen (and must not write a user preference).
  app.setFullscreen(true)
  assert.equal(app.isFullscreen(), false, 'a display-mode switch is not applied while a workspace is leased')
  handle.close()
  await vt.waitForRender()
  app.dispose()
  startedApps.delete(app)
  assert.throws(() => app.openJobInspector({
    initial: openingRow(),
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  }), /disposed surface/)
})

test('A-13 entering the Job workspace re-samples the observation its predecessor lost', async () => {
  const saved = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    CI: process.env.CI,
    COLORFGBG: process.env.COLORFGBG,
  }
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = ''
  process.env.CI = ''
  delete process.env.COLORFGBG
  try {
    const { vt, app } = startApp({}, {
      runOwned: (_label, task, options) => {
        void Promise.resolve()
          .then(() => task())
          .then(
            result => options.onResult?.(result),
            error => options.onError?.(error),
          )
      },
    })
    const writes: string[] = []
    const originalWrite = vt.write.bind(vt)
    vt.write = (data: string): void => {
      writes.push(data)
      originalWrite(data)
    }
    const queries = (): number => writes.join('').split('\x1b]11;?\x07').length - 1

    // A boot-shaped observation for the screen that owns the terminal right now.
    app.noteThemeSelection('auto')
    const pending = app.autoDetectTheme({ shouldApply: () => app.themeFollowsTerminal() })
    assert.equal(queries(), 1, 'the observation is issued on the main screen')

    // Entering the Job workspace stops that screen, so its probe is released.
    const handle = app.openJobInspector({
      initial: openingRow(),
      canStop: () => false,
      onStop: () => {},
      onClose: () => {},
    })
    await pending
    await vt.waitForRender()
    assert.ok(queries() > 1, `the entering Job screen issues a FRESH observation:\n${JSON.stringify(writes)}`)

    vt.sendInput('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    await vt.waitForRender()
    assert.equal(app.currentTheme(), 'light', 'and the Job screen applies its answer')

    handle.close()
    await vt.waitForRender()
    app.stop()
  } finally {
    if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = saved.NO_COLOR
    if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = saved.FORCE_COLOR
    if (saved.CI === undefined) delete process.env.CI
    else process.env.CI = saved.CI
    if (saved.COLORFGBG === undefined) delete process.env.COLORFGBG
    else process.env.COLORFGBG = saved.COLORFGBG
  }
})
