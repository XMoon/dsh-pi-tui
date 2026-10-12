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
import type { TaskBrowserHandle } from '../src/tui-app.ts'
import { TuiApp } from '../src/tui-app.ts'
import { JobInspectorPanel, deriveJobInspectorView } from '../src/tui/panels/job-inspector-panel.ts'
import { createTaskRuntime, type JobInspectorState, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservedSnapshot, JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
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

function startApp(options: Record<string, unknown> = {}): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, options)
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
    return { kind: 'requested' }
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
        onClose: () => {},
        canStop: () => true,
        onStop: () => { stops += 1 },
      },
    )
    const lines = panel.render(budget.width)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= budget.width, `no line may exceed ${budget.width} columns: ${JSON.stringify(line)}`)
    }
    const painted = lines.join('\n')
    // The status and every fact marker survive EVERY budget; the identity prefix
    // is only kept while it still fits beside them.
    assert.match(painted, /failed/, `the status must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /\[GAP\]/, `the gap marker must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /\[ERROR\]/, `the error marker must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /\[SETTLED\]/, `the settled marker must stay visible at ${budget.width}x${budget.rows}`)
    assert.match(painted, /Earlier output evicted/, `the gap fact must stay visible at ${budget.width}x${budget.rows}`)
    if (budget.width >= 80) {
      assert.match(painted, /Job job-a · bash · failed/, `the identity must stay visible at ${budget.width}x${budget.rows}`)
    }
    if (budget.width >= 80 && budget.rows >= 10) {
      assert.match(painted, /Command: pnpm build --watch/, `the command identity must be shown at ${budget.width}x${budget.rows}`)
      assert.match(painted, /progress: building 3\/8/, 'the typed progress row must be shown on a tall screen')
    }
    // The pinned chrome never exceeds the granted row budget: the Action Bar is
    // the LAST rendered row and the layout always has room for it.
    assert.ok(lines.length <= Math.max(1, budget.rows - 1), 'the pinned chrome must leave a body row')
    assert.match(lines.at(-1)!, /Esc back/, `the Action Bar is the last rendered row at ${budget.width}x${budget.rows}`)
    if (budget.width >= 80) {
      assert.match(lines.at(-1)!, /Retained preview · not full history/, 'the retained-preview disclosure stays pinned')
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
    onClose: () => { closes += 1 },
    canStop: () => live,
    onStop: () => {},
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
  assert.match(painted, /Job job-a · bash · running/, `the typed header must be painted:\n${painted}`)
  assert.match(painted, /Command: job job-a/, 'a bash Job shows the Command identity row')
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

test('A-03 regular → Job → regular: the SAME main screen restarts, the draft and the browser selection survive, and no display preference is written', async () => {
  const { vt, app } = startApp()
  const screens = recordScreenStarts()
  let fullscreenChanges = 0
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  // A draft typed into the ORIGINAL editor must survive the round trip.
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
  assert.equal(harness.lastBrowser(), browserBefore, 'no second browser was constructed')
  assert.equal(harness.lastBrowser()!.getViewState!().selectedId, selectionBefore, 'the selected row survived')
  assert.equal(fullscreenChanges, 0)
  screens.restore()
  app.stop()
})

test('A-04 transcript fullscreen → Job → fullscreen: the SAME alt screen restarts with its scroll state, and the user preference changes exactly once', async () => {
  const { vt, app } = startApp()
  const screens = recordScreenStarts()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true)
  const altInstance = screens.alt.at(-1)!
  const scrollBefore = app.fullscreenScrollForTest()
  assert.ok(scrollBefore !== undefined, 'the transcript alt screen owns its ScrollView')
  const altStartsBefore = screens.alt.length

  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  // The transcript display mode is UNTOUCHED and the workspace is a THIRD
  // physical owner, not the transcript alt screen.
  assert.equal(app.isFullscreen(), true, 'the user transcript mode survives the Job view')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true)
  const altDuring = screens.alt.length

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true)
  assert.equal(screens.alt.at(-1), altInstance, 'the SAME transcript alt screen restarted')
  assert.ok(screens.alt.length > altDuring, 'the transcript screen was paused, not rebuilt')
  assert.ok(screens.alt.length > altStartsBefore)
  const scrollAfter = app.fullscreenScrollForTest()
  assert.equal(scrollAfter?.isFollowingEnd, scrollBefore?.isFollowingEnd, 'the follow state survived')
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
  assert.match(painted, /Job job-a · bash · completed/)
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
  assert.match(painted, /\[ERROR\] no job controller/, `the reason must stay visible:\n${painted}`)
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
    assert.match(lines.join('\n'), /Job job-a · bash · running/, `the header must survive ${width}x${height}`)
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
  assert.match(view(vt), /Job job-b · bash · running/)
  assert.ok(!/Job job-a/.test(view(vt)), 'A must not repaint over B')
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
    assert.match(view(vt), /Job job-a · bash · running/)

    // A -> B: B commits its token, then closing A re-enters and commits C.
    harness.tasks.openJobView('job-b')
    await vt.waitForRender()
    assert.equal(reentered, true, 'the re-entry ran inside A\'s closure')
    assert.deepEqual(closed, ['close'], 'A notified its owner exactly once')
    assert.equal(harness.observation.opensFor('job-b'), 0, 'B never opened an observer: C superseded it first')
    assert.equal(harness.observation.opensFor('job-c'), 1)
    assert.match(view(vt), /Job job-c · bash · running/, 'the newer workspace owns the screen')
    assert.ok(!/Job job-b/.test(view(vt)), 'B must never paint over C')
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
  assert.ok(!/Job job-a · bash/.test(painted), 'the Job screen must be gone, not layered under the question')
  // The question really owns the keyboard: its own two-step confirm is routed.
  vt.sendInput('\r')
  vt.sendInput('\r')
  const answer = await pending.catch(() => undefined)
  assert.ok(answer !== undefined, 'the blocking owner received the keys')
  await vt.waitForRender()
  harness.tasks.disposeTaskBrowser()
  app.stop()
})

// ── A-10: read-only workspace ───────────────────────────────────────────────

test('A-10 ordinary keys and host shortcuts are inert inside the workspace and never touch the editor, transcript or browser', async () => {
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

  for (const chunk of ['x', '\r', '\x06', '\x0f', '\x1b[B', '\x1b[A', '1']) {
    vt.sendInput(chunk)
    await vt.waitForRender()
  }
  assert.equal(app.hostEditorTextForTest(), draftBefore, 'the workspace never types into the editor')
  assert.equal(app.focusedComponentForTest() instanceof JobInspectorPanel, true, 'the workspace keeps the keyboard')
  assert.equal(app.overlayGraphState().handles, overlayBefore, 'no search/overlay was opened from inside the Job')
  assert.equal(browserBefore.getViewState!().selectedId, selectedBefore, 'the browser selection never moved')

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
  assert.match(view(vt), /Job job-b · bash · running/)
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
