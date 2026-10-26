/**
 * Phase 3A / PR-A — Lifecycle Closure (plan §7 A-01..A-13).
 *
 * The REAL production closure chains, not synthetic helper booleans:
 *
 * - a mounted `TuiApp` + `VirtualTerminal` drives the real OverlayBroker,
 *   `ResponsiveOverlayFrame` and `OutputViewerPanel`/`TaskBrowserPanel`;
 * - the TaskRuntime half composes the REAL `createTaskRuntime` owner against
 *   the real app, with the external Job-observation PORT replaced by an
 *   acquire/disposer recorder (the only substitution: it is the external
 *   boundary port, never an internal owner).
 *
 * The cases assert exactly what the plan requires: `onClose`/observer release
 * happens exactly once across Esc, the returned closer, a physical disposal
 * (screen swap / final teardown) and a parent-only close; a stale owner can
 * never clear a newer one; and a throwing cleanup step never strands its
 * independent siblings.
 *
 * @module @xmoon76/dsh-pi-tui/surface-lifecycle-closure.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, TuiAltScreen } from '@xmoon76/pi-tui'
import { TuiApp, type TaskBrowserHandle, type TuiAppOptions } from '../../src/tui-app.ts'
import { OutputViewerPanel } from '../../src/tui/panels/output-viewer-panel.ts'
import { JobInspectorPanel } from '../../src/tui/panels/job-inspector-panel.ts'
import { SettingsWorkspacePanel, type SettingsWorkspaceSource } from '../../src/tui/panels/settings-workspace-panel.ts'
import { pituiDisplaySeam } from '../../src/app/surface/display-seam-pitui.ts'
import { TaskBrowserPanel } from '../../src/tui/panels/task-panel.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import { pituiTaskCenterPresentation } from '../../src/app/surface/task-presentation-pitui.ts'
import type { AdvancedInteractiveComponent } from '../../src/extension/advanced-types.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import type { JobObservedSnapshot, JobObservationPort, JobStopOutcome } from '../../src/runtime/job-observation-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { createSurfaceRuntime, type SurfaceMountDeps, type SurfaceRendererMount } from '../../src/app/surface/runtime.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { createAuthorizationFlow } from '../../src/app/command/authorization.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Every TuiApp started here is disposed after each test: the process's
 *  single-live-TUI slot (the vendored keybindings are process-global) is held
 *  only by LIVE surfaces. */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function startApp(options: TuiAppOptions = {}): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, options)
  app.start()
  startedApps.add(app)
  return { vt, app }
}

const view = (vt: VirtualTerminal): string => vt.getViewport().map(stripTerminalSequences).join('\n')

/** Phase 3B / B1-A: a Job detail is a dedicated temporary SCREEN whose root is
 *  the `JobInspectorPanel` and which owns the physical keyboard — it is NOT an
 *  overlay child of the Task Browser. */
const jobScreenOpen = (app: TuiApp): boolean => app.focusedComponentForTest() instanceof JobInspectorPanel

/** Let the runtime's owned async flows settle (the catalog read resolves on a
 *  microtask; `runOwned` reports through the diagnostic channel). */
async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

// ── the TaskRuntime half: the real owner over the real app ──────────────────

/** One acquired observer, with its own release counter. */
interface ObservationRecord {
  readonly jobId: string
  closes: number
}

/** The external Job-observation PORT double: records acquire/release only. */
class RecordingJobObservation implements JobObservationPort {
  readonly records: ObservationRecord[] = []

  open(_sessionId: string | undefined, jobId: string, listener: (snapshot: JobObservedSnapshot) => void): () => void {
    const record: ObservationRecord = { jobId, closes: 0 }
    this.records.push(record)
    listener({
      jobId,
      kind: 'bash',
      label: jobId,
      status: 'running',
      text: `retained ${jobId}`,
      gapBefore: false,
      settled: false,
    })
    return () => { record.closes += 1 }
  }

  async stop(): Promise<JobStopOutcome> {
    return { kind: 'requested' }
  }

  forJob(jobId: string): number[] {
    return this.records.filter(record => record.jobId === jobId).map(record => record.closes)
  }

  totalCloses(): number {
    return this.records.reduce((total, record) => total + record.closes, 0)
  }
}

interface TaskHarness {
  readonly tasks: TaskRuntime
  readonly observation: RecordingJobObservation
  /** Every owner-retire reason the app delivered, in order (the sink the
   *  plan's A-02 closure table requires). */
  readonly retires: readonly string[]
  /**
   * Chrome-commit counters. `taskSummary`/`tasks`/`agents` count every commit
   * (they also move on ordinary catalog refreshes); the `reset*` counters
   * count ONLY the committed RESET SIGNATURE (an all-zero summary, an empty
   * task list, an empty agent list), which isolates the session-reset mirror
   * obligations from concurrent catalog traffic.
   */
  readonly mirrors: {
    taskSummary: number
    tasks: number
    agents: number
    resetSummary: number
    resetTasks: number
    resetAgents: number
  }
  /** The most recent browser handle the runtime installed. */
  lastBrowser(): TaskBrowserHandle | undefined
  browsers(): readonly TaskBrowserHandle[]
}

/**
 * Attach the REAL TaskRuntime owner to the real app. The `mounted()` seam
 * returns the real TuiApp (the production wiring); the `TaskSurfaceSource`
 * supplies the session facts plus the external Job-observation port double.
 */
function attachTasks(app: TuiApp, options: { jobIds?: readonly string[]; childIds?: readonly string[] } = {}): TaskHarness {
  const jobIds = [...(options.jobIds ?? [])]
  const childIds = [...(options.childIds ?? [])]
  const jobSnapshots = (): TaskBrowserJobInput[] => jobIds.map((id, index) => ({
    id,
    kind: 'bash',
    label: `job ${id}`,
    status: 'running',
    startedAt: 1_000 + index,
  }))
  const observation = new RecordingJobObservation()
  const subject = {} as SessionSubject
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => { throw new Error('subagent interrupt is not exercised by this suite') },
    // Mirrors the REAL root seam: a subagent row REPLACES the Task Center
    // ('close'), a Job row keeps it open (its detail is a child overlay).
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: observation,
    jobs: {
      list: () => jobSnapshots(),
      subscribe: () => () => {},
    },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({
        parentSessionId: 'sess-main',
        parentAvailable: true,
        descendants: childIds.map(id => ({
          kind: 'child' as const,
          id,
          label: `child ${id}`,
          mode: 'continuable' as const,
          activity: 'running' as const,
          hasChildren: false,
          parentId: 'sess-main',
          depth: 1,
        })),
        jobs: jobSnapshots(),
      }),
      activityOf: () => 'running',
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub(),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  // The owner keeps the browser handle private; capture the real production
  // handle, the owner-retire signal and the reset chrome commits at the app
  // seam (the receiver is preserved — never `.bind`).
  const browsers: TaskBrowserHandle[] = []
  const retires: string[] = []
  const mirrors = { taskSummary: 0, tasks: 0, agents: 0, resetSummary: 0, resetTasks: 0, resetAgents: 0 }
  const originalTaskSummary = app.setTaskSummary
  app.setTaskSummary = function (this: TuiApp, summary: Parameters<typeof originalTaskSummary>[0]): void {
    mirrors.taskSummary += 1
    if (summary.runningAgents === 0 && summary.totalAgents === 0 && summary.runningJobs === 0
      && summary.totalJobs === 0 && summary.failedAttention === 0 && summary.failedTotal === 0) {
      mirrors.resetSummary += 1
    }
    originalTaskSummary.call(this, summary)
  }
  const originalSetTasks = app.setTasks
  app.setTasks = function (this: TuiApp, tasks: Parameters<typeof originalSetTasks>[0]): void {
    mirrors.tasks += 1
    if (tasks.length === 0) mirrors.resetTasks += 1
    originalSetTasks.call(this, tasks)
  }
  const originalSetAgents = app.setAgents
  app.setAgents = function (this: TuiApp, agents: Parameters<typeof originalSetAgents>[0]): void {
    mirrors.agents += 1
    if (agents.length === 0) mirrors.resetAgents += 1
    originalSetAgents.call(this, agents)
  }
  const originalOpenTaskBrowser = app.openTaskBrowser
  app.openTaskBrowser = function (
    this: TuiApp,
    items: Parameters<typeof originalOpenTaskBrowser>[0],
    onSelect: Parameters<typeof originalOpenTaskBrowser>[1],
    onCancel: Parameters<typeof originalOpenTaskBrowser>[2],
    options: Parameters<typeof originalOpenTaskBrowser>[3],
  ): TaskBrowserHandle {
    const innerRetire = options.onRetired
    const handle = originalOpenTaskBrowser.call(this, items, onSelect, onCancel, {
      ...options,
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
    mirrors,
    lastBrowser: () => browsers.at(-1),
    browsers: () => browsers,
  }
}

// ── A-01..A-03: the OutputViewer physical/returned/Esc closure ──────────────

test('A-01 Esc finalizes the output viewer once, removes it, and stops its refresh timer', async () => {
  const { vt, app } = startApp()
  // The owned panel release is the timer owner: count it (pass-through double).
  let panelDisposals = 0
  const originalPanelDispose = OutputViewerPanel.prototype.dispose
  OutputViewerPanel.prototype.dispose = function (): void {
    panelDisposals += 1
    originalPanelDispose.call(this)
  }
  try {
    let closes = 0
    let refreshes = 0
    app.openOutputViewer({
      title: 'job detail',
      initial: 'retained body',
      refresh: () => { refreshes += 1; return 'retained body' },
      onClose: () => { closes += 1 },
      intervalMs: 10,
    })
    await vt.waitForRender()
    assert.ok(refreshes >= 1, 'the viewer must refresh while it is open')
    assert.equal(app.overlayGraphState().handles, 1)
    assert.equal(panelDisposals, 0)

    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.equal(closes, 1, 'Esc must finalize the viewer exactly once')
    assert.equal(panelDisposals, 1, 'the owned panel (its timer) must be released exactly once')
    assert.equal(app.overlayGraphState().handles, 0, 'the overlay must be physically removed')

    const afterClose = refreshes
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(refreshes, afterClose, 'the closed viewer must not keep refreshing')

    // Repeating the same gesture must not notify a second time.
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.equal(closes, 1, 'a repeated Esc must not finalize again')
    assert.equal(panelDisposals, 1, 'a repeated Esc must not release the panel again')
    app.stop()
  } finally {
    OutputViewerPanel.prototype.dispose = originalPanelDispose
  }
})

test('A-02 the returned closer is idempotent and a self-reentrant onClose cannot loop', async () => {
  const { vt, app } = startApp()
  let panelDisposals = 0
  const originalPanelDispose = OutputViewerPanel.prototype.dispose
  OutputViewerPanel.prototype.dispose = function (): void {
    panelDisposals += 1
    originalPanelDispose.call(this)
  }
  try {
    let closes = 0
    let closer: () => void = () => {}
    closer = app.openOutputViewer({
      title: 'job detail',
      initial: 'body',
      refresh: () => 'body',
      // The callback re-enters the SAME closer: a single latch must make that a
      // no-op instead of recursing or double-releasing.
      onClose: () => { closes += 1; closer() },
    })
    await vt.waitForRender()
    closer()
    closer()
    assert.equal(closes, 1, 'the returned closer must finalize exactly once')
    assert.equal(panelDisposals, 1, 'the owned panel must be released exactly once')
    assert.equal(app.overlayGraphState().handles, 0)
    app.stop()
  } finally {
    OutputViewerPanel.prototype.dispose = originalPanelDispose
  }
})

test('A-03 a fullscreen swap finalizes a non-remountable viewer once and never a remountable lease', async () => {
  // Phase 3B / B3-A: the Ctrl+R History surface is an EDITOR-SEAT tenant, not an
  // overlay node, so the managed graph holds only the real overlays — and the
  // tenant still survives the swap on the shared seat mount.
  const { vt, app } = startApp({
    historySearchSource: {
      search: async () => ({
        results: [{ id: 'h1', content: 'history entry', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }],
        exhausted: true,
      }),
    },
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
  })
  app.openHistorySearch()
  await vt.waitForRender()
  assert.ok(view(vt).includes('Input History'), `the History tenant must be painted:\n${view(vt)}`)
  const lease = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'lease overlay' }] })
  await vt.waitForRender()
  let closes = 0
  app.openOutputViewer({
    title: 'job detail',
    initial: 'retained body',
    refresh: () => 'retained body',
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2, 'the remountable lease plus the viewer (History is NOT an overlay)')
  assert.ok(view(vt).includes('retained body'))

  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(closes, 1, 'the physical detach must finalize the viewer exactly once')
  const afterSwap = view(vt)
  assert.ok(!afterSwap.includes('job detail'), `the non-remountable viewer must not survive the swap:\n${afterSwap}`)
  assert.ok(afterSwap.includes('lease overlay'), `the remountable lease must survive the swap:\n${afterSwap}`)
  // The capturing lease overlay covers the seat HEADER row, so the tenant is
  // identified by its own query/results rows.
  assert.ok(afterSwap.includes('Results · 1 match'), `the SAME History seat tenant must survive the swap:\n${afterSwap}`)
  assert.equal(app.overlayGraphState().handles, 1, 'only the remountable lease survives; neither overlay is finalized')

  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the remountable lease survives the trip back')
  assert.ok(view(vt).includes('Results · 1 match'), 'the History seat tenant survives the trip back too')
  lease.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0,
    'the History tenant is still not an overlay node after the lease closes')
  assert.ok(view(vt).includes('Results · 1 match'), 'closing an overlay never closes the History seat tenant')
  app.stop()
})

// ── A-04..A-10: the TaskRuntime parent/child ownership closure ──────────────

test('A-04 a parent-only browser close releases the Job child observer once; the Job screen never destroys the browser', async () => {
  const { vt, app } = startApp()
  // Count the real panel release (its 1s elapsed tick lives in the panel):
  // the owning frame must dispose it exactly once, on any close path.
  let panelDisposals = 0
  const originalPanelDispose = TaskBrowserPanel.prototype.dispose
  TaskBrowserPanel.prototype.dispose = function (): void {
    panelDisposals += 1
    originalPanelDispose.call(this)
  }
  try {
    const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
    await flush()
    harness.tasks.openTasksBrowser('full')
    await vt.waitForRender()
    const browser = harness.lastBrowser()
    assert.ok(browser !== undefined, 'the app must return a real browser handle')

    // Select the highlighted Job row through the REAL panel: the Job detail is a
    // dedicated temporary SCREEN — the browser stays the only overlay and is
    // never destroyed or suppressed.
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [0], 'selecting a Job opens exactly one observer')
    assert.equal(app.overlayGraphState().handles, 1, 'the Job workspace is a SCREEN, not an overlay child')
    assert.equal(app.overlayGraphState().dependents, 0, 'the browser is not suppressed by an overlay')
    assert.equal(jobScreenOpen(app), true, 'the Job workspace root owns the physical keyboard')
    assert.equal(panelDisposals, 0, 'the browser must NOT be disposed')
    assert.deepEqual(harness.retires, [], 'keep-open must never retire the owner')

    // Esc on the Job detail restores the SAME browser: the observer is released
    // exactly once and the parent survives.
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the Job detail Esc must release its observer once')
    assert.equal(jobScreenOpen(app), false)
    assert.equal(app.overlayGraphState().handles, 1, 'the parent browser must be restored, never rebuilt')
    assert.equal(panelDisposals, 0, 'restoring the parent must not dispose its panel')

    // Re-open the detail, then close ONLY the parent browser: the parent-only
    // entry must close the still-live Job workspace.
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1, 0])
    assert.equal(jobScreenOpen(app), true)
    browser!.close()
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1, 1], 'the parent-only close must release the child observer once')
    assert.equal(jobScreenOpen(app), false, 'the parent-only close must release the temporary Job screen')
    assert.equal(app.overlayGraphState().handles, 0, 'no ghost overlay may remain')
    assert.deepEqual(harness.retires, ['external'], 'the parent-only close must retire the owner exactly once')
    assert.equal(panelDisposals, 1, 'the browser panel (and its tick) must be released exactly once')

    browser!.close()
    assert.deepEqual(harness.observation.forJob('job-a'), [1, 1], 'the returned closer must stay idempotent')
    assert.equal(panelDisposals, 1, 'a repeated close must not release the panel twice')
    app.stop()
  } finally {
    TaskBrowserPanel.prototype.dispose = originalPanelDispose
  }
})

test('A-05 a display-mode switch is refused while the Job screen owns the surface, and the physical browser disposal still retires once afterwards', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the browser is the only overlay')

  // A fullscreen toggle while a Job workspace is leased must NOT detach the
  // paused surface: the browser/observer/Job screen all survive and no display
  // preference is written.
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), false, 'the user display mode is untouched by the Job view')
  assert.deepEqual(harness.observation.forJob('job-a'), [0], 'the Job observer stays live')
  assert.equal(app.overlayGraphState().handles, 1)
  assert.equal(jobScreenOpen(app), true)
  assert.deepEqual(harness.retires, [], 'the paused browser is not retired by the refused switch')

  // Leaving the Job screen restores the browser, and THEN the swap behaves
  // exactly as before.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'leaving the Job releases its observer once')
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'the browser may not survive the physical swap')
  assert.deepEqual(harness.retires, ['external'],
    'the physical browser disposal must notify the owner exactly once, without any closer call')

  // The runtime slot stays usable on the new screen.
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'a fresh browser must open after the physical retire')
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('A-06 the Workflow-scoped Full browser preserves the dataset scope across a close/reopen cycle', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'], childIds: ['child-1', 'child-2'] })
  await flush()
  // A Workflow-scoped browser over TWO child ids: exactly the scope, no
  // Job rows.
  harness.tasks.openTasksBrowser('full', { kind: 'subagents', childIds: ['child-1', 'child-2'] })
  await vt.waitForRender()
  const scoped = harness.lastBrowser()!
  const actorRows = (handle: TaskBrowserHandle): string[] =>
    handle.visibleItems!().map(item => item.value).filter(value => value.startsWith('agent:'))
  assert.deepEqual(actorRows(scoped), ['agent:child-1', 'agent:child-2'],
    `the scoped browser must show exactly the scope child ids:
${JSON.stringify(scoped.visibleItems!().map(i => i.value))}`)
  assert.ok(!scoped.visibleItems!().some(item => item.value.startsWith('job:')), 'jobs must never leak into a subagents scope')

  // Establish a NON-DEFAULT selection inside the scoped browser (child-2):
  // the selection STARTS on the first running row (child-1, the preferred),
  // so one Down reaches child-2.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(scoped.getViewState!().selectedId, 'agent:child-2', 'the selection must have moved')

  // Close and reopen the SAME scope: the dataset scope resets through the
  // close paths (PR2 plan §10.8) — a fresh ordinary open starts from all.
  scoped.close()
  await vt.waitForRender()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const fresh = harness.lastBrowser()!
  assert.notEqual(fresh, scoped, 'the reopen must be a NEW browser instance')
  const freshRows = fresh.visibleItems!().map(item => item.value)
  assert.ok(freshRows.some(value => value.startsWith('job:')), 'a fresh open must see the global dataset')
  assert.equal(fresh.getViewState!().scope, 'all', 'the fresh open resets the presentation scope')
  app.stop()
})

test('A-06b the Full browser carries its presentation state across an overlay round-trip', async () => {
  // B4-B: the Quick→Full promotion is retired with the modal Quick. The
  // surviving contract: the Full browser keeps its OWN presentation state
  // (type filter, selection) across a Job-detail overlay round-trip.
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'], childIds: ['child-1', 'child-2'] })
  await flush()
  harness.tasks.openTasksBrowser('full', { kind: 'subagents', childIds: ['child-1', 'child-2'] })
  await vt.waitForRender()
  const first = harness.lastBrowser()!
  // A type filter in the Full (Tab cycles: subagents → ... ).
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.notEqual(first.getViewState!().typeFilter, null, 'Tab must set a type filter in the Full')
  const filtered = first.getViewState!().typeFilter

  // Open + close a Job-detail overlay (the same round-trip shape): the
  // browser beneath keeps its state.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const same = harness.lastBrowser()!
  assert.equal(same.getViewState!().typeFilter, filtered, 'the type filter survives the overlay round-trip')
  app.stop()
})

test('A-07 a same-session Job A → B replacement releases each observer once and B survives A\'s late close', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()

  assert.equal(harness.tasks.openJobView('job-a'), 'keep-open')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [0])
  const tasksBeforeReplacement = harness.mirrors.tasks

  // The same session selects another Job: the PREVIOUS viewer must be
  // released by the replacement, and its finalizer must not clear B.
  assert.equal(harness.tasks.openJobView('job-b'), 'keep-open')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the replacement must release A exactly once')
  assert.deepEqual(harness.observation.forJob('job-b'), [0], 'B must own a live observer')
  assert.equal(harness.mirrors.tasks, tasksBeforeReplacement,
    'the stale A finalizer must NOT refresh the task mirror of the replacement owner')

  // Esc closes the CURRENT viewer: A's stale finalizer must not have stolen
  // B's closer slot, so this really reaches B — and the CURRENT finalizer is
  // the one that repaints the owner.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1], 'B must still be closable after A\'s finalizer ran')
  assert.equal(harness.mirrors.tasks, tasksBeforeReplacement + 1,
    'the CURRENT viewer finalizer must be the one that refreshes the owner')
  assert.equal(app.overlayGraphState().handles, 1, 'the parent browser must remain after the Job detail closes')

  // …and the GLOBAL closer slot (not the panel) really points at the live
  // viewer: the PARENT-only close must release the CURRENT Job's observer.
  assert.equal(harness.tasks.openJobView('job-a'), 'keep-open')
  assert.equal(harness.tasks.openJobView('job-b'), 'keep-open')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1, 0], 'the second B viewer owns the global slot')
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-b'), [1, 1],
    'the parent close must release the replacement viewer through the GLOBAL closer slot')
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('A-07b a reentrant replacement inside a viewer finalizer wins over the outer replacement', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a', 'job-b', 'job-c'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()

  // A production-plausible reentrancy: the OUTER replacement (B) closes A,
  // and A's finalizer synchronously opens ANOTHER Job (C). The newer intent
  // must win — B must never mount, and A's tail must not clear C's closer.
  const originalOpenJobInspector = app.openJobInspector
  let injected = false
  app.openJobInspector = function (
    this: TuiApp,
    options: Parameters<typeof originalOpenJobInspector>[0],
  ) {
    if (injected || options.initial.opening.jobId !== 'job-a') return originalOpenJobInspector.call(this, options)
    injected = true
    const originalOnClose = options.onClose
    return originalOpenJobInspector.call(this, {
      ...options,
      onClose: () => {
        originalOnClose?.()
        harness.tasks.openJobView('job-c')
      },
    })
  }

  harness.tasks.openJobView('job-a')
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), true, 'job-a owns the temporary Job screen')

  harness.tasks.openJobView('job-b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'A must be released exactly once')
  assert.deepEqual(harness.observation.forJob('job-b'), [], 'the superseded outer selection must never mount')
  assert.deepEqual(harness.observation.forJob('job-c'), [0], 'the reentrant selection must own the live observer')
  assert.equal(app.overlayGraphState().handles, 1, 'exactly one Job screen may be leased, never two')
  assert.equal(jobScreenOpen(app), true, 'C owns the physical keyboard')

  // C owns the live slot: Esc closes C (and its observer), leaving the parent.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-c'), [1], 'C must still be closable')
  assert.equal(jobScreenOpen(app), false)
  assert.equal(app.overlayGraphState().handles, 1, 'the parent browser must remain')
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('A-08 a browser retired inside its own retire callback cannot touch the replacement', async () => {
  const { vt, app } = startApp()
  const reasons: string[] = []
  let reentered = false
  let replacement: TaskBrowserHandle | undefined

  const openBrowser = (label: string): TaskBrowserHandle => app.openTaskBrowser(
    [{ value: `job:${label}`, label, status: 'running', active: true, source: 'job', type: 'bash', canStop: true, startedAt: 1, group: 'jobs' }],
    () => 'keep-open',
    () => {},
    {
      mode: 'full',
      header: label,
      enableSearch: true,
      maxVisible: 10,
      onRetired: (reason) => {
        reasons.push(`${label}:${reason}`)
        if (label === 'A' && !reentered) {
          reentered = true
          replacement = openBrowser('B')
        }
      },
    },
  )

  const a = openBrowser('A')
  await vt.waitForRender()
  a.close()
  await vt.waitForRender()
  assert.deepEqual(reasons, ['A:external'], 'A must retire exactly once')
  assert.equal(app.overlayGraphState().handles, 1, 'only the replacement browser may remain')
  assert.ok(view(vt).includes('B'), `the replacement browser must be alive and visible:\n${view(vt)}`)

  // The replacement is fully functional: its own Esc retires IT, not A again.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.deepEqual(reasons, ['A:external', 'B:cancel'])
  assert.equal(app.overlayGraphState().handles, 0)
  replacement!.close()
  assert.deepEqual(reasons, ['A:external', 'B:cancel'], 'a late close of the retired replacement must be a no-op')
  app.stop()
})

test('A-08b TaskRuntime: a browser opened by a plugin focus callback during the close wins over the retired browser\'s navigation tails', async () => {
  // Phase 1 — the Esc (cancel) tail. A REAL advanced-interactive overlay owns
  // the pre-browser focus: closing the Full browser restores plugin focus, and
  // the plugin's onFocus synchronously opens a NEWER browser with its own Job
  // child. The retired browser's Esc tail must not open a stale Quick over it.
  {
    const { vt, app } = startApp()
    const harness = attachTasks(app, { jobIds: ['job-a'], childIds: ['child-1'] })
    await flush()
    let armed = false
    const component: AdvancedInteractiveComponent = {
      render: () => ({ kind: 'text', spans: [{ text: 'intro overlay' }] }),
      onFocus: () => {
        if (!armed) return
        armed = false
        harness.tasks.openTasksBrowser('full')
        harness.tasks.openJobView('job-a')
      },
    }
    const lease = app.showAdvancedInteractiveOverlay(component)
    await vt.waitForRender()

    armed = true
    harness.tasks.openTasksBrowser('full')
    await vt.waitForRender()
    assert.equal(harness.browsers().length, 1)

    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.equal(harness.browsers().length, 2,
      'the retired browser\'s Esc tail must NOT open a stale Quick over the newer browser')
    assert.equal(harness.lastBrowser()!.getViewState!().mode, 'full', 'the newer Full must own the slot')
    assert.deepEqual(harness.observation.forJob('job-a'), [0],
      'the retired browser\'s tail must not touch the newer browser\'s Job child')
    assert.equal(app.overlayGraphState().handles, 2, 'the intro overlay and the newer browser')
    assert.equal(jobScreenOpen(app), true, 'the newer browser\'s Job screen owns the keyboard')
    assert.deepEqual(harness.retires, ['cancel'], 'only the retired Full must have retired')

    // The newer browser is fully interactive: its Job detail Esc returns to it,
    // then its own parent close releases ITS child exactly once.
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1])
    assert.equal(jobScreenOpen(app), false)
    assert.equal(app.overlayGraphState().handles, 2)
    assert.equal(harness.tasks.openJobView('job-a'), 'keep-open')
    await vt.waitForRender()
    harness.lastBrowser()!.close()
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1, 1],
      'the newer browser\'s own close must release its child through the global closer slot')
    assert.deepEqual(harness.retires, ['cancel', 'external'])
    assert.equal(app.overlayGraphState().handles, 1, 'only the plugin overlay remains')
    lease.close()
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0)
    app.dispose()
  }
  // Phase 2 — the Quick → Full promotion tail (the same root cause).
  {
    const { vt, app } = startApp()
    const harness = attachTasks(app, { jobIds: [], childIds: ['child-1'] })
    await flush()
    let armed = false
    const component: AdvancedInteractiveComponent = {
      render: () => ({ kind: 'text', spans: [{ text: 'intro overlay' }] }),
      onFocus: () => {
        if (!armed) return
        armed = false
        harness.tasks.openTasksBrowser('full')
      },
    }
    const lease = app.showAdvancedInteractiveOverlay(component)
    await vt.waitForRender()
    harness.tasks.openTasksBrowser('full', { kind: 'subagents', childIds: ['child-1'] })
    await vt.waitForRender()
    assert.equal(harness.browsers().length, 1)
    armed = true
    // Enter through the real panel (one scoped child row; the modal-only
    // pseudo row retired with the modal Quick).
    vt.sendInput('\x1b[B')
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.equal(harness.browsers().length, 2, 'the Enter tail must not open a second browser')
    assert.equal(harness.lastBrowser()!.getViewState!().mode, 'full')
    assert.equal(app.overlayGraphState().handles, 2, 'the intro overlay plus the newer browser')
    harness.lastBrowser()!.close()
    await vt.waitForRender()
    lease.close()
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0)
    app.stop()
  }
})

test('A-08c TaskRuntime: a synchronous session reset during the close retires the pending navigation tail', async () => {
  // B4-B: the Quick → Full promotion is retired, so the probed "pending
  // Esc restore into Quick" no longer exists. The surviving contract: a
  // synchronous resetTasks() fired from an overlay focus hook (the physical
  // hide of the browser restoring plugin focus) retires the whole browser
  // generation — the close tails (scope reset, mirrors) run exactly once and
  // no stale browser survives.
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: [], childIds: ['child-1'] })
  await flush()
  let armed = false
  const component: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'intro overlay' }] }),
    onFocus: () => {
      if (!armed) return
      armed = false
      harness.tasks.resetTasks()
    },
  }
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()
  harness.tasks.openTasksBrowser('full', { kind: 'subagents', childIds: ['child-1'] })
  await vt.waitForRender()
  assert.equal(harness.browsers().length, 1)

  const mirrorsBefore = { ...harness.mirrors }
  armed = true
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The reset really ran inside the hook (the committed RESET SIGNATURE, which
  // concurrent catalog commits cannot forge)…
  assert.equal(harness.mirrors.resetSummary, mirrorsBefore.resetSummary + 1, 'the reset must really run inside the hook')
  assert.equal(harness.mirrors.resetTasks, mirrorsBefore.resetTasks + 1, 'the reset must really run inside the hook')
  assert.equal(harness.mirrors.resetAgents, mirrorsBefore.resetAgents + 1, 'the reset must really run inside the hook')
  // …and no stale browser survives the retired generation.
  assert.deepEqual(harness.retires, ['cancel'], 'only the real retire may be delivered')
  assert.equal(app.overlayGraphState().handles, 1, 'only the plugin overlay may remain')
  lease.close()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('A-08d TaskRuntime: a stale browser\'s late close cannot clear the replacement\'s slot, scope or child', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'], childIds: ['child-1', 'child-2'] })
  await flush()
  // A = a Workflow-scoped browser that is still mounted but NOT retired.
  harness.tasks.openTasksBrowser('full', { kind: 'subagents', childIds: ['child-1'] })
  await vt.waitForRender()
  const stale = harness.lastBrowser()!
  // B = a replacement browser with a LIVE Job child (it needs the global
  // dataset, so it carries an explicit `all` scope).
  harness.tasks.openTasksBrowser('full', { kind: 'all' })
  await vt.waitForRender()
  const replacement = harness.lastBrowser()!
  assert.notEqual(replacement, stale)
  assert.equal(harness.tasks.openJobView('job-a'), 'keep-open')
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [0])
  assert.equal(app.overlayGraphState().handles, 2, 'the stale browser and the replacement (the Job is a SCREEN)')
  assert.equal(jobScreenOpen(app), true, 'the replacement Job workspace owns the surface')

  // Closing the STALE browser (its TaskRuntime token is no longer current)
  // must hit the browserToken mismatch fence: the replacement keeps its slot,
  // its scope and its Job child.
  stale.close()
  await vt.waitForRender()
  assert.deepEqual(harness.retires, ['external'], 'only the stale browser may retire')
  assert.deepEqual(harness.observation.forJob('job-a'), [0],
    'the stale browser\'s retire must NOT release the replacement\'s Job child')
  assert.equal(jobScreenOpen(app), true, 'the replacement\'s Job workspace must survive the stale close')
  assert.equal(app.overlayGraphState().handles, 1, 'the replacement browser must survive')
  assert.deepEqual(
    replacement.visibleItems!().map(item => item.value)
      .filter(value => value.startsWith('agent:') || value.startsWith('job:')),
    ['agent:child-1', 'agent:child-2', 'job:job-a'],
    'the replacement must keep its own (global) dataset scope',
  )

  // The replacement is still the owner: its own close releases ITS child
  // through the global closer slot.
  replacement.close()
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1],
    'the replacement must still own the global closer slot after the stale close')
  assert.deepEqual(harness.retires, ['external', 'external'])
  assert.equal(app.overlayGraphState().handles, 0)
  app.stop()
})

test('A-09 resetTasks is idempotent: one observer release, one browser disposal, reusable afterwards', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), true)

  harness.tasks.resetTasks()
  await vt.waitForRender()
  assert.equal(harness.observation.totalCloses(), 1, 'the session reset must release the observer once')
  assert.equal(jobScreenOpen(app), false, 'the reset must release the temporary Job screen')
  assert.equal(app.overlayGraphState().handles, 0, 'the reset must drop the browser')
  assert.deepEqual(harness.retires, ['external'], 'the reset must retire the browser owner exactly once')

  harness.tasks.resetTasks()
  await vt.waitForRender()
  assert.equal(harness.observation.totalCloses(), 1, 'a repeated reset must not release twice')

  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the runtime must stay reusable after a reset')
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  app.stop()
})

test('A-09b a throwing Job finalizer cannot strand the browser disposal during a session reset', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const boom = new Error('viewer finalizer boom')
  const originalOpenJobInspector = app.openJobInspector
  app.openJobInspector = function (
    this: TuiApp,
    options: Parameters<typeof originalOpenJobInspector>[0],
  ) {
    const inner = options.onClose
    return originalOpenJobInspector.call(this, {
      ...options,
      onClose: () => { inner?.(); throw boom },
    })
  }
  harness.tasks.openJobView('job-a')
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), true)

  // The Job finalizer throws (after releasing its observer). The browser
  // disposal is an INDEPENDENT obligation and must still run; the original
  // error is rethrown.
  assert.throws(() => harness.tasks.resetTasks(), (error: unknown) => error === boom)
  await vt.waitForRender()
  assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the observer must still be released exactly once')
  assert.equal(app.overlayGraphState().handles, 0, 'the independent browser disposal must still run')
  assert.deepEqual(harness.retires, ['external'], 'the browser must still be retired exactly once')
  app.stop()
})

test('A-09c a throwing browser hide cannot strand the reset mirrors or the dataset scope', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'], childIds: ['child-1', 'child-2'] })
  await flush()
  // A Workflow-scoped browser: the scope reset is observable on the next open.
  harness.tasks.openTasksBrowser('full', { kind: 'subagents', childIds: ['child-1'] })
  await vt.waitForRender()
  assert.deepEqual(
    harness.lastBrowser()!.visibleItems!().map(item => item.value).filter(value => value.startsWith('agent:')),
    ['agent:child-1'],
    'the scoped browser must show exactly the scope child ids',
  )
  const panelError = new Error('browser panel dispose boom')
  const originalPanelDispose = TaskBrowserPanel.prototype.dispose
  TaskBrowserPanel.prototype.dispose = function (): void {
    originalPanelDispose.call(this)
    throw panelError
  }
  try {
    const before = { ...harness.mirrors }
    assert.throws(() => harness.tasks.resetTasks(), (error: unknown) => error === panelError)
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0, 'the browser must still be removed')
    assert.deepEqual(harness.retires, ['external'], 'the browser must still be retired exactly once')
    assert.equal(harness.mirrors.resetSummary, before.resetSummary + 1, 'the summary mirror must still be reset')
    assert.equal(harness.mirrors.resetTasks, before.resetTasks + 1, 'the task mirror must still be reset')
    assert.equal(harness.mirrors.resetAgents, before.resetAgents + 1, 'the agent mirror must still be reset')
  } finally {
    TaskBrowserPanel.prototype.dispose = originalPanelDispose
  }

  // The dataset scope was reset despite the throw: the next ordinary open
  // sees the GLOBAL dataset again.
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  assert.deepEqual(
    harness.lastBrowser()!.visibleItems!().map(item => item.value)
      .filter(value => value.startsWith('agent:') || value.startsWith('job:')),
    ['agent:child-1', 'agent:child-2', 'job:job-a'],
    'the session reset must clear the Workflow dataset scope even when a closer throws',
  )
  harness.lastBrowser()!.close()
  await vt.waitForRender()
  app.stop()
})

test('A-10 TuiApp.dispose and the explicit observer release are order-independent and release once', async () => {
  // Order 1: the physical teardown finalizes the viewer first.
  {
    const { vt, app } = startApp()
    const harness = attachTasks(app, { jobIds: ['job-a'] })
    await flush()
    harness.tasks.openTasksBrowser('full')
    await vt.waitForRender()
    harness.tasks.openJobView('job-a')
    await vt.waitForRender()
    app.dispose()
    assert.deepEqual(harness.observation.forJob('job-a'), [1],
      'the physical teardown must release the observer exactly once')
    assert.deepEqual(harness.retires, ['external'],
      'the final physical teardown must retire the browser owner without a closer call')
    harness.tasks.disposeJobObservation()
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the explicit release must then be a no-op')
  }
  // Order 2: the runner's explicit release runs first.
  {
    const { vt, app } = startApp()
    const harness = attachTasks(app, { jobIds: ['job-a'] })
    await flush()
    harness.tasks.openTasksBrowser('full')
    await vt.waitForRender()
    harness.tasks.openJobView('job-a')
    await vt.waitForRender()
    harness.tasks.disposeJobObservation()
    assert.deepEqual(harness.observation.forJob('job-a'), [1])
    app.dispose()
    assert.deepEqual(harness.observation.forJob('job-a'), [1], 'the physical teardown must not release twice')
  }
})

// ── A-11..A-13: failure propagation and callback chaining ───────────────────

test('A-11 a throwing owned-child dispose still finalizes once, preserves the error, and aggregates two failures', async () => {
  const { vt, app } = startApp()
  const originalDispose = OutputViewerPanel.prototype.dispose
  const disposeError = new Error('panel dispose boom')
  const closeError = new Error('onClose boom')
  // The fault double stands in for the real release: it must still PERFORM the
  // release (the panel's timer clear + disposed latch) before throwing, so the
  // injected failure cannot leak the panel's interval.
  OutputViewerPanel.prototype.dispose = function (): void {
    originalDispose.call(this)
    throw disposeError
  }
  try {
    let closes = 0
    let refreshes = 0
    const closer = app.openOutputViewer({
      title: 'job detail',
      initial: 'body',
      refresh: () => { refreshes += 1; return 'body' },
      onClose: () => { closes += 1 },
      intervalMs: 10,
    })
    await vt.waitForRender()
    // The frame's disposal collects the child failure, still runs the
    // one-shot notification, and the outer closer rethrows the ORIGINAL
    // thrown value (a single failure is never wrapped).
    assert.throws(() => closer(), (error: unknown) => error === disposeError)
    assert.equal(closes, 1, 'the notification is an independent obligation')
    assert.equal(app.overlayGraphState().handles, 0, 'the overlay must be removed despite the throw')
    // Despite the injected throw, the REAL release ran: no interval survives.
    const afterThrow = refreshes
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(refreshes, afterThrow, 'the throwing double must still have released the panel (no leaked timer)')
    closer()
    assert.equal(closes, 1, 'the second call must be a no-op')

    // Two independent failures surface as an AggregateError carrying BOTH.
    const aggregateCloser = app.openOutputViewer({
      title: 'job detail',
      initial: 'body',
      refresh: () => 'body',
      onClose: () => { throw closeError },
    })
    await vt.waitForRender()
    assert.throws(() => aggregateCloser(), (error: unknown) => {
      assert.ok(error instanceof AggregateError, 'two failures must aggregate')
      assert.deepEqual(error.errors, [disposeError, closeError], 'both original errors must be preserved')
      return true
    })
    aggregateCloser()
    app.dispose()

    // TaskRuntime level: a REAL Job observation released by its owner must
    // still be released exactly once when the workspace panel's own release
    // throws (the workspace release is ONE non-truncating batch, so the
    // return-surface restore and the owner notification still run).
    const { vt: vt2, app: app2 } = startApp()
    const harness = attachTasks(app2, { jobIds: ['job-a'] })
    const originalJobPanelDispose = JobInspectorPanel.prototype.dispose
    JobInspectorPanel.prototype.dispose = function (this: JobInspectorPanel): void {
      originalJobPanelDispose.call(this)
      throw disposeError
    }
    try {
      await flush()
      harness.tasks.openTasksBrowser('full')
      await vt2.waitForRender()
      harness.tasks.openJobView('job-a')
      await vt2.waitForRender()
      assert.deepEqual(harness.observation.forJob('job-a'), [0])
      assert.throws(() => harness.tasks.disposeJobObservation(), (error: unknown) => error === disposeError)
      assert.deepEqual(harness.observation.forJob('job-a'), [1],
        'the real observer must still be released exactly once under a throwing panel dispose')
      assert.equal(app2.overlayGraphState().handles, 1, 'the Job screen must be gone; its parent browser remains')
      assert.equal(jobScreenOpen(app2), false, 'the throwing release must not strand the temporary Job screen')
      app2.stop()
    } finally {
      JobInspectorPanel.prototype.dispose = originalJobPanelDispose
    }
  } finally {
    OutputViewerPanel.prototype.dispose = originalDispose
  }
  app.stop()
})

test('A-12 a late Sign-in notice onClose cannot clear the CURRENT notice handle', async () => {
  // Phase 1 — Esc, a notice SWAP (a re-attempt) and the explicit attempt close.
  {
    const { vt, app } = startApp()
    const onCloses: (() => void)[] = []
    const originalOpenOutputViewer = app.openOutputViewer
    app.openOutputViewer = function (this: TuiApp, options: Parameters<typeof originalOpenOutputViewer>[0]): () => void {
      if (options.onClose !== undefined) onCloses.push(options.onClose)
      return originalOpenOutputViewer.call(this, options)
    }
    const flow = createAuthorizationFlow(app, { respond: async () => {}, cancel: async () => {} })
    flow.bind('attempt')
    flow.onEvent({
      kind: 'notice',
      attemptId: 'attempt',
      notice: { message: 'Continue in your browser', url: 'https://example.com/auth', code: 'ABCD-EFGH' },
    })
    await vt.waitForRender()
    const notice = view(vt)
    assert.ok(notice.includes('https://example.com/auth'), `the notice URL must render:\n${notice}`)
    assert.ok(notice.includes('ABCD-EFGH'), `the device code must render:\n${notice}`)
    assert.ok(!notice.includes('stop'), 'a Sign-in notice has no Job Stop affordance')

    // Esc closes the notice through the real viewer path.
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0)
    assert.equal(onCloses.length, 1)

    // A RE-ATTEMPT opens a fresh notice. Replaying the FIRST notice's onClose
    // (a late duplicate) must not clear the new handle — otherwise the real
    // `flow.close()` below would leave the overlay mounted.
    flow.onEvent({ kind: 'notice', attemptId: 'attempt', notice: { message: 'second notice' } })
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 1, 'the re-attempt must open a fresh notice')
    assert.equal(onCloses.length, 2)
    onCloses[0]!()
    assert.equal(app.overlayGraphState().handles, 1, 'the stale onClose must not close the current notice')
    flow.close()
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0, 'the attempt close must still reach the CURRENT notice')
    app.dispose()
  }
  // Phase 2 — the real settlement route: `settled` closes the notice through
  // the flow's own close and resolves the outcome exactly once; a notice that
  // arrives afterwards is ignored (never a reopened panel).
  {
    const { vt, app } = startApp()
    const flow = createAuthorizationFlow(app, { respond: async () => {}, cancel: async () => {} })
    flow.bind('attempt')
    flow.onEvent({ kind: 'notice', attemptId: 'attempt', notice: { message: 'waiting for the browser' } })
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 1)
    flow.onEvent({ kind: 'settled', attemptId: 'attempt', status: 'authorized' })
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0, 'a settled attempt must close its notice')
    assert.equal((await flow.outcome).status, 'authorized', 'the settlement must resolve the outcome')
    flow.onEvent({ kind: 'notice', attemptId: 'attempt', notice: { message: 'late notice' } })
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0, 'a settled flow must never reopen a notice')
    app.dispose()
  }
  // Phase 3 — a REAL screen swap: the non-remountable notice dies with the old
  // screen, the flow's identity is retired through the real physical path, a
  // fresh notice opens on the new screen, and the PRE-swap notice's onClose
  // replayed afterwards must not clear it.
  {
    const { vt, app } = startApp()
    const onCloses: (() => void)[] = []
    const originalOpenOutputViewer = app.openOutputViewer
    app.openOutputViewer = function (this: TuiApp, options: Parameters<typeof originalOpenOutputViewer>[0]): () => void {
      if (options.onClose !== undefined) onCloses.push(options.onClose)
      return originalOpenOutputViewer.call(this, options)
    }
    const flow = createAuthorizationFlow(app, { respond: async () => {}, cancel: async () => {} })
    flow.bind('attempt')
    flow.onEvent({
      kind: 'notice',
      attemptId: 'attempt',
      notice: { message: 'pre-swap notice', url: 'https://example.com/auth' },
    })
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 1)
    assert.equal(onCloses.length, 1)

    app.setFullscreen(true)
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0, 'a non-remountable notice dies with the old screen')
    assert.equal(onCloses.length, 1, 'the physical disposal must not mint a second notice')

    // The attempt is still alive: the next notice opens a FRESH panel on the
    // new screen (the flow's handle was retired by the physical finalization).
    flow.onEvent({
      kind: 'notice',
      attemptId: 'attempt',
      notice: { message: 'post-swap notice', code: 'WXYZ-1234' },
    })
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 1, 'a fresh notice must open after the swap')
    assert.equal(onCloses.length, 2)
    assert.ok(view(vt).includes('WXYZ-1234'), `the fresh notice must render its device code:\n${view(vt)}`)

    // Replaying the PRE-swap notice's onClose must not clear the fresh handle.
    onCloses[0]!()
    assert.equal(app.overlayGraphState().handles, 1, 'the pre-swap onClose must not close the fresh notice')
    flow.close()
    await vt.waitForRender()
    assert.equal(app.overlayGraphState().handles, 0, 'the attempt close must still reach the fresh notice')
    app.dispose()
  }
})

test('A-14 a viewer disposed during its own mount never starts its refresh timer', async () => {
  const { vt, app } = startApp()
  // A REAL plugin overlay owns the keyboard first. The new viewer's mount focus
  // transition blurs it, and its onBlur swaps the screen — which physically
  // disposes the viewer that is still mounting, BEFORE openOutputViewer
  // returns. The refresh timer must never be armed for that dead panel.
  let blurs = 0
  const component: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'plugin overlay' }] }),
    onBlur: () => {
      blurs += 1
      if (blurs === 1) app.setFullscreen(true)
    },
  }
  const lease = app.showAdvancedInteractiveOverlay(component)
  await vt.waitForRender()

  const starts: number[] = []
  const originalStart = OutputViewerPanel.prototype.startRefreshing
  OutputViewerPanel.prototype.startRefreshing = function (
    this: OutputViewerPanel,
    ...args: Parameters<typeof originalStart>
  ): void {
    starts.push(1)
    originalStart.apply(this, args)
  }
  try {
    let closes = 0
    app.openOutputViewer({
      title: 'job detail',
      initial: 'body',
      refresh: () => 'body',
      onClose: () => { closes += 1 },
      intervalMs: 10,
    })
    await vt.waitForRender()
    assert.ok(blurs >= 1, 'the mount focus transition must have blurred the plugin overlay')
    assert.equal(app.isFullscreen(), true, 'the plugin onBlur must have swapped the screen')
    assert.equal(closes, 1, 'the mount-time disposal must finalize the viewer exactly once')
    assert.equal(starts.length, 0,
      'a viewer finalized during its own mount must never start a refresh timer (leaked interval)')
    assert.equal(app.overlayGraphState().handles, 1, 'only the remountable plugin overlay survives the swap')
  } finally {
    OutputViewerPanel.prototype.startRefreshing = originalStart
  }
  app.setFullscreen(false)
  await vt.waitForRender()
  lease.close()
  await vt.waitForRender()
  app.stop()
})

test('A-13 a throwing owner retire and a throwing parent hide are both attempted; no ghost child remains', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  const browser = harness.lastBrowser()!

  const childError = new Error('job finalizer boom')
  const panelError = new Error('browser panel dispose boom')
  // The Job finalizer throws AFTER releasing its observer, and the browser's
  // owned panel throws from its real release (pass-through double, so the tick
  // is still cleared).
  const originalOpenJobInspector = app.openJobInspector
  app.openJobInspector = function (this: TuiApp, options: Parameters<typeof originalOpenJobInspector>[0]) {
    const inner = options.onClose
    return originalOpenJobInspector.call(this, { ...options, onClose: () => { inner?.(); throw childError } })
  }
  const originalPanelDispose = TaskBrowserPanel.prototype.dispose
  let panelDisposals = 0
  TaskBrowserPanel.prototype.dispose = function (): void {
    panelDisposals += 1
    originalPanelDispose.call(this)
    throw panelError
  }
  try {
    harness.tasks.openJobView('job-a')
    await vt.waitForRender()
    assert.equal(jobScreenOpen(app), true, 'the Job workspace screen owns the surface')

    // Both independent obligations fail — the owner retire (through the Job
    // child) and the browser's own physical hide — and BOTH original errors
    // must survive in one AggregateError.
    assert.throws(() => browser.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError, `two failures must aggregate: ${String(error)}`)
      assert.deepEqual(error.errors, [childError, panelError], 'both original errors must be preserved')
      return true
    })
    await vt.waitForRender()
    assert.deepEqual(harness.observation.forJob('job-a'), [1],
      'the Job observer must still be released exactly once despite both throws')
    assert.deepEqual(harness.retires, ['external'], 'the retire notifier must fire exactly once (latched), never twice')
    assert.equal(panelDisposals, 1, 'the browser panel must be released exactly once')
    assert.equal(jobScreenOpen(app), false, 'no ghost Job screen (parent or child) may remain')
    assert.equal(app.overlayGraphState().handles, 0, 'no ghost overlay may remain')

    browser.close()
    assert.deepEqual(harness.retires, ['external'], 'a repeated close must be a strict no-op')
    assert.equal(panelDisposals, 1, 'a repeated close must not release the panel twice')
    app.stop()
  } finally {
    TaskBrowserPanel.prototype.dispose = originalPanelDispose
  }
})

// ── Phase 3B / B2-A: the Settings workspace lifecycle ──────────────────────

const settingsScreenOpen = (app: TuiApp): boolean =>
  app.focusedComponentForTest() instanceof SettingsWorkspacePanel

/** The minimal readonly projection the lifecycle cases lease the workspace
 *  with (the real `/settings` builder is exercised by its own suite). */
/** The About page's two version facts. A lease-lifecycle case never
 *  asserts on their VALUE; the workspace only requires that they exist. */
const ABOUT_VERSION_FACTS = { tui: '0.0.0-test', dsh: '0.0.0-test' }

function settingsWorkspaceSource(): SettingsWorkspaceSource {
  return {
    readSnapshot: () => ({
      configReadiness: 'ready',
      capturedAt: Date.now(),
      rows: [
        { id: 'theme', category: 'appearance', label: 'Configured theme', summary: 'auto', value: 'auto', scope: 'TUI settings document', freshness: 'ready', description: 'palette', action: 'inspect' },
        { id: 'icon-style', category: 'appearance', label: 'Icon style', summary: 'emoji', value: 'emoji', scope: 'TUI settings document', freshness: 'ready', description: 'icons', action: 'inspect' },
        { id: 'footer-settings-legacy', category: 'appearance', label: 'Footer & status line…', summary: 'Existing settings editor', scope: 'Existing settings editor', freshness: 'ready', description: 'legacy', action: 'open-legacy', legacyTargetId: 'footer' },
        { id: 'display-preset', category: 'conversation', label: 'Transcript display', summary: 'full', value: 'full', scope: 'Client runtime', freshness: 'runtime', description: 'display', action: 'inspect' },
        { id: 'thinking', category: 'conversation', label: 'Thinking detail', summary: 'collapsed', value: 'collapsed', scope: 'Current TUI display state', freshness: 'runtime', description: 'thinking', action: 'inspect' },
        { id: 'default-permission', category: 'agent', label: 'Default permission', summary: 'workspace-write', value: 'workspace-write', scope: 'DSH Host profile · permission default for new sessions', freshness: 'ready', description: 'permission default', action: 'inspect' },
      ],
    }),
  }
}

test('a Question preempts the Settings workspace; a blocking owner refuses a new lease and the workspace never resurrects', async () => {
  const { vt, app } = startApp()
  app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true, 'the Settings panel owns the physical keyboard')

  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'the workspace is abandoned BEFORE the question claims the seat')
  assert.ok(view(vt).includes('proceed?'), `the question is the physical owner:\n${view(vt)}`)
  assert.ok(!view(vt).includes('Settings ·'), 'no Settings chrome may survive behind the question')

  // A new lease while the blocking owner owns the surface is refused outright.
  assert.throws(
    () => app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS }),
    /blocking modal owns the surface/,
  )

  vt.sendInput('\x1b') // cancel the question
  await questions.catch(() => {})
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'the workspace must not resurrect after the question settles')
  assert.ok(view(vt).includes('❯'), 'the conversation surface is restored')
  app.stop()
})

test('the Job and Settings workspace leases are mutually exclusive, and a stale closer cannot release twice', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), true, 'the Job lease owns the surface')

  // Settings refuses while the Job owns the surface.
  assert.throws(
    () => app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS }),
    /workspace screen is already leased/,
  )
  vt.sendInput('\x1b') // close the Job workspace
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), false)

  let closes = 0
  const handle = app.openSettingsWorkspace(settingsWorkspaceSource(), {
    onOpenLegacy: () => {},
    aboutVersionFacts: ABOUT_VERSION_FACTS,
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true)
  // A second Settings lease and a Job lease are both refused while it owns the screen.
  assert.throws(
    () => app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS }),
    /workspace screen is already leased/,
  )
  assert.throws(
    () => app.openJobInspector({
      initial: { opening: { jobId: 'job-b', kind: 'bash', label: 'job b', status: 'running' } },
      canStop: () => false,
      onStop: () => {},
      onClose: () => {},
    }),
    /another workspace screen is already leased/,
  )

  handle.close()
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false)
  assert.equal(closes, 1, 'the owner notification fires exactly once')
  assert.ok(view(vt).includes('❯'), 'the conversation surface is restored')
  handle.close()
  assert.equal(closes, 1, 'a repeated close is a strict no-op')
  app.stop()
})

test('TuiApp.dispose releases a leased Settings workspace exactly once', async () => {
  const { vt, app } = startApp()
  let closes = 0
  app.openSettingsWorkspace(settingsWorkspaceSource(), {
    onOpenLegacy: () => {},
    aboutVersionFacts: ABOUT_VERSION_FACTS,
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true)
  app.dispose()
  assert.equal(closes, 1, 'the final teardown retires the workspace exactly once')
  assert.equal(settingsScreenOpen(app), false)
  app.dispose()
  assert.equal(closes, 1, 'a repeated dispose cannot double-notify')
})

test('a legacy handoff that loses the surface to a NEWER workspace never mounts the legacy editor', async () => {
  const { vt, app } = startApp()
  let legacyOpens = 0
  let innerOpened = false
  const outer = app.openSettingsWorkspace(settingsWorkspaceSource(), {
    onOpenLegacy: () => { legacyOpens += 1 },
    aboutVersionFacts: ABOUT_VERSION_FACTS,
    // A synchronous callback during the close leases a NEWER workspace: the
    // stale handoff must then refuse instead of stacking the legacy editor on
    // the new screen.
    onClose: () => {
      app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS })
      innerOpened = true
    },
  })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true)
  // Wide (80x24): the About home -> Appearance -> rows -> its transition
  // launcher. The rail order is About, Models, Account, Agent, Appearance, ...
  // and the launcher is the LAST Appearance row (Theme, Icon style, launcher).
  for (let step = 0; step < 4; step += 1) {
    vt.sendInput('\x1b[B'); await vt.waitForRender()
  }
  vt.sendInput('\r'); await vt.waitForRender()
  for (let step = 0; step < 2; step += 1) {
    vt.sendInput('\x1b[B'); await vt.waitForRender()
  }
  vt.sendInput('\r'); await vt.waitForRender()
  assert.equal(innerOpened, true, 'the close callback really leased a newer workspace')
  assert.equal(legacyOpens, 0, 'the stale intent must not open the legacy editor')
  assert.equal(settingsScreenOpen(app), true, 'the newer Settings workspace keeps the surface')
  assert.equal(app.overlayGraphState().handles, 0, 'no legacy overlay may mount on the new screen')
  assert.match(app.notifyTextForTest(), /could not open the settings editor: the surface changed/)
  outer.close() // a stale closer is a strict no-op
  assert.equal(settingsScreenOpen(app), true, 'the stale closer cannot release the newer lease')
  app.stop()
})

test('the session hydration boundary retires a leased Settings workspace exactly once', async () => {
  const { vt, app } = startApp()
  let closes = 0
  app.openSettingsWorkspace(settingsWorkspaceSource(), {
    onOpenLegacy: () => {},
    aboutVersionFacts: ABOUT_VERSION_FACTS,
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true)
  // The REAL production hydration entry the session runtime calls.
  pituiDisplaySeam(app).beginSessionHydration()
  await vt.waitForRender()
  assert.equal(closes, 1, 'the session switch retires the workspace exactly once')
  assert.equal(settingsScreenOpen(app), false)
  assert.ok(view(vt).includes('❯'), 'the main surface is restored')
  app.stop()
})

test('an Approval and a Save Location both pre-empt the Settings workspace, which then refuses a new lease', async () => {
  const { vt, app } = startApp()
  app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true)

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'the approval pre-empts the workspace')
  assert.throws(
    () => app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS }),
    /blocking modal owns the surface/,
  )
  vt.sendInput('\x1b')
  await approval.catch(() => {})
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'the workspace must not resurrect after the approval')

  app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS })
  await vt.waitForRender()
  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    { resolveDirectory: input => input, isDirectory: () => true, targetExists: () => false, complete: async () => null },
  )
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'the Save Location prompt pre-empts the workspace')
  vt.sendInput('\x1b')
  await save.catch(() => {})
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'the workspace must not resurrect after the save prompt')
  app.stop()
})

test('stop() releases a leased Settings workspace once and restarts with no ghost screen', async () => {
  const { vt, app } = startApp()
  let closes = 0
  app.openSettingsWorkspace(settingsWorkspaceSource(), {
    onOpenLegacy: () => {},
    aboutVersionFacts: ABOUT_VERSION_FACTS,
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()
  app.stop()
  assert.equal(closes, 1, 'the stop retires the workspace exactly once')
  assert.equal(settingsScreenOpen(app), false)
  app.start()
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false, 'no ghost workspace survives the stop/start pair')
  vt.sendInput('after-stop')
  await vt.waitForRender()
  assert.ok(view(vt).includes('after-stop'), 'ordinary input is live again after the restart')
  app.stop()
})

test('a Settings round trip preserves an open Task Browser overlay (same instance)', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1)
  app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS })
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), true)
  assert.ok(!view(vt).includes('job job-a'), 'the workspace HIDES the browser rows while it owns the screen')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false)
  assert.equal(app.overlayGraphState().handles, 1, 'the SAME browser overlay survives the round trip')
  assert.equal(harness.browsers().length, 1, 'no browser was rebuilt')
  assert.ok(view(vt).includes('job job-a'), 'the SAME browser rows are painted again after the round trip')
  app.stop()
})

test('a legacy handoff never crosses a blocking owner started by its own close', async () => {
  const { vt, app } = startApp()
  let legacyOpens = 0
  let question: Promise<unknown> | undefined
  app.openSettingsWorkspace(settingsWorkspaceSource(), {
    onOpenLegacy: () => { legacyOpens += 1 },
    aboutVersionFacts: ABOUT_VERSION_FACTS,
    // The close callback starts a REAL blocking owner instead of a workspace.
    onClose: () => {
      question = app.askQuestions([{ id: 'q1', question: 'still there?', options: [{ label: 'yes' }] }])
      // Attach the rejection handler immediately: cancelling the question must
      // never surface as an unhandled rejection.
      question.catch(() => {})
    },
  })
  await vt.waitForRender()
  // Wide (80x24): the About home -> Appearance -> rows -> its transition
  // launcher (the last Appearance row). Agent has no launcher any more.
  for (let step = 0; step < 4; step += 1) {
    vt.sendInput('\x1b[B'); await vt.waitForRender()
  }
  vt.sendInput('\r'); await vt.waitForRender()
  for (let step = 0; step < 2; step += 1) {
    vt.sendInput('\x1b[B'); await vt.waitForRender()
  }
  vt.sendInput('\r'); await vt.waitForRender()
  assert.ok(question !== undefined, 'the close callback really started a blocking owner')
  assert.equal(legacyOpens, 0, 'the handoff must not cross the new blocking owner')
  assert.equal(app.overlayGraphState().handles, 0, 'no legacy overlay may mount under the question')
  assert.ok(view(vt).includes('still there?'), 'the question owns the pane')
  vt.sendInput('\x1b')
  await question.catch(() => {})
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'cancelling the question must not reveal a hidden legacy overlay')
  assert.ok(!view(vt).includes('Type to search'), 'no legacy editor was ever mounted')
  app.stop()
})

test('closing a workspace hands the terminal over without flushing its own document into the resumed surface', async () => {
  const { vt, app } = startApp()
  // The physical byte stream is the contract here: a workspace screen stopped
  // WITHOUT `preserveScreen` exits the alternate screen and then writes its own
  // rendered document into the regular terminal — one extra synchronized frame
  // that flashes the departing Job/Settings chrome over the surface taking over.
  const writes: string[] = []
  let capturing = false
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string): void => {
    if (capturing) writes.push(data)
    originalWrite(data)
  }
  const captured = (): string => writes.join('')

  // ── Settings: Esc is the close path the user takes ────────────────────────
  capturing = true
  app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS })
  await vt.waitForRender()
  assert.ok(captured().includes('Settings'), 'control: the live Settings document is what writes the mark')
  writes.length = 0
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(settingsScreenOpen(app), false)
  assert.ok(!captured().includes('Settings'), `the departing Settings document must not be flushed:\n${captured()}`)

  // ── Job: the same hand-over from the browser's own detail lease ───────────
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  harness.tasks.openTasksBrowser('full')
  await vt.waitForRender()
  writes.length = 0
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), true, 'the Job workspace owns the surface')
  // The marker must be CONTIGUOUS in the write stream (the terminal receives
  // per-span diffs, so text split across two chalk spans is not a substring) and
  // UNIQUE to the departing Job document. The workspace's own action-bar verb
  // `Esc back` (D13) qualifies on both counts: it is a single span, it is painted
  // at EVERY width (Esc is never dropped), and no other surface in this
  // transition paints it — the restored Task Browser paints `Esc close`.
  //
  // It is deliberately NOT the shared status group `‣ Running` any more: since
  // B4-A the RESUMED regular surface paints the passive Task Quick window, whose
  // rows carry that same shared `‣` group by design (design language D5+D7), so
  // its presence could no longer tell "the Job document was flushed" apart from
  // "the restored surface legitimately painted a task row".
  const jobMark = 'Esc back'
  assert.ok(captured().includes(jobMark), 'control: the live Job document is what writes the mark')
  writes.length = 0
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(jobScreenOpen(app), false)
  assert.ok(!captured().includes(jobMark), `the departing Job document must not be flushed:\n${captured()}`)
  capturing = false
  app.stop()
})

test('a workspace open unwind never flushes the partially started screen document into the restored surface', async () => {
  const { vt, app } = startApp()
  const harness = attachTasks(app, { jobIds: ['job-a'] })
  await flush()
  const writes: string[] = []
  let capturing = false
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string): void => {
    if (capturing) writes.push(data)
    originalWrite(data)
  }
  const captured = (): string => writes.join('')
  // The REAL start runs — the alternate screen is entered and the document is
  // renderable — and the failure lands on the open-sequence step right after it,
  // the same shape as a throwing `assertStillOpening()` re-entrancy fence. The
  // unwind must release that started screen without flushing its document.
  const originalStart = TuiAltScreen.prototype.start
  TuiAltScreen.prototype.start = function (this: TuiAltScreen): void {
    originalStart.call(this)
    throw new Error('post-start open failure')
  }
  try {
    // ── Job: the browser's own detail lease ─────────────────────────────────
    harness.tasks.openTasksBrowser('full')
    await vt.waitForRender()
    capturing = true
    assert.throws(() => harness.tasks.openJobView('job-a'), /post-start open failure/, 'the real mount failure is relayed')
    await vt.waitForRender()
    capturing = false
    assert.equal(jobScreenOpen(app), false, 'no Job screen survives the unwind')
    assert.ok(!captured().includes('JOB'), `the unwound Job document must not be flushed:\n${captured()}`)

    // ── Settings: the same unwind on its own lease ──────────────────────────
    writes.length = 0
    capturing = true
    assert.throws(
      () => app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {}, aboutVersionFacts: ABOUT_VERSION_FACTS }),
      /post-start open failure/,
    )
    await vt.waitForRender()
    capturing = false
    assert.equal(settingsScreenOpen(app), false, 'no Settings screen survives the unwind')
    assert.ok(!captured().includes('SETTINGS'), `the unwound Settings document must not be flushed:\n${captured()}`)
    // The restored surface really owns the terminal again.
    assert.ok(view(vt).includes('❯'), 'the conversation surface is restored')
  } finally {
    TuiAltScreen.prototype.start = originalStart
  }
  app.stop()
})

// ---------------------------------------------------------------------------
// Image-6A: the ImageLoader teardown hook (Owner-approved narrow runtime.ts
// scope extension). The loader itself is internal to the surface runtime, so
// the test spies on the public `clear()` method to prove WHEN it is called.
// ---------------------------------------------------------------------------

const nullNotificationPresentationForImageLifecycle = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

function spyOnImageLoaderClear(): { clears: () => number; restore: () => void } {
  const prototype = ImageLoader.prototype as unknown as { clear: () => void }
  const original = prototype.clear
  let clears = 0
  prototype.clear = function (this: ImageLoader): void {
    clears += 1
    original.call(this)
  }
  return {
    clears: () => clears,
    restore: () => { prototype.clear = original },
  }
}

function minimalSurfaceDeps(renderer?: SurfaceRendererMount): SurfaceMountDeps {
  return {
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised by this test')) },
    readImage: () => Promise.reject(new Error('not exercised by this test')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: 'image-6a-lifecycle', isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text: string) => text,
    ...(renderer === undefined ? {} : { renderer }),
  }
}

function mountImageLifecycleSurface(renderer?: SurfaceRendererMount) {
  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullNotificationPresentationForImageLifecycle,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.start(minimalSurfaceDeps(renderer))
  return surface
}

test('surface dispose clears the mounted PiTui image loader exactly once', async () => {
  const spy = spyOnImageLoaderClear()
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const surface = mountImageLifecycleSurface()
  try {
    await vt.waitForRender()
    startedApps.add(surface.app)
    surface.dispose()
    assert.equal(spy.clears(), 1, 'normal PiTui teardown clears the ONE loader once')
    surface.dispose()
    assert.equal(spy.clears(), 1, 'repeated surface dispose never clears twice')
  } finally {
    spy.restore()
    restoreTerminal()
  }
})

test('a throwing app.dispose() cannot strand the image-loader clear step', () => {
  const spy = spyOnImageLoaderClear()
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const surface = mountImageLifecycleSurface()
  const app = surface.app
  const originalDispose = app.dispose.bind(app) as TuiApp['dispose']
  app.dispose = () => { throw new Error('app dispose failed') }
  try {
    assert.throws(() => surface.dispose(), /app dispose failed/)
    assert.equal(spy.clears(), 1, 'the non-truncating disposal batch still runs the clear step')
  } finally {
    app.dispose = originalDispose
    originalDispose()
    spy.restore()
    restoreTerminal()
  }
})

test('the TSP renderer branch keeps its ImageLoader lifecycle (no PiTui clear hook)', () => {
  const spy = spyOnImageLoaderClear()
  let rendererDisposes = 0
  const renderer = {
    mount: () => ({
      display: displaySeamStub(),
      taskPresentation: {},
      composer: {},
      // The disposal path reads these two presenter methods; the fake answers
      // them so the TSP test exercises only the loader-lifecycle condition.
      interaction: {
        withdrawPending: () => {},
        setSettledQuestionAnswersLookup: () => {},
      },
      bindInput: () => {},
      dispose: async () => { rendererDisposes += 1 },
    }),
  } as unknown as SurfaceRendererMount
  const surface = mountImageLifecycleSurface(renderer)
  try {
    surface.dispose()
    assert.equal(spy.clears(), 0, 'the TSP branch is not cleared by the PiTui teardown hook')
    assert.equal(rendererDisposes, 1, 'the renderer release still runs')
  } finally {
    spy.restore()
  }
})
