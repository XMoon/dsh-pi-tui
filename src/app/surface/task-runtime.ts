/**
 * The surface-owned Task Center + Job viewer state machine (TS3 §34).
 *
 * This owner holds the WHOLE Task Center application state for the mounted
 * surface: the injected Task read source/deps, the ONE `TaskBrowserRuntime`
 * coordinator (catalog-vs-runtime split, the single-flight + dirty trailing
 * catalog gate, the generation fence, the retained Job snapshot scoped by
 * session key), the browser state (rows, handle, instance token, dataset scope,
 * quick-view state), the selected-Job viewer state (observer disposal, instance
 * token) and the jobs-event subscription.
 *
 * Question attention crosses as an INJECTED read/subscription dependency only:
 * the `QuestionSurfaceController` itself stays in `interaction-runtime.ts`, and
 * no second controller exists.
 *
 * Preserved rules (plan §34/§65): catalog vs runtime refresh split; single-flight
 * + dirty trailing refresh; the generation fence; the retained Job snapshot
 * scoped by session key; the viewer instance token; Job event semantics; the
 * scope reset on a Session generation; Task Browser restoration; and the
 * Question-attention row policy. There is exactly ONE `TaskBrowserRuntime` and
 * ONE catalog refresh gate per surface.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/task-runtime
 */

import { buildTaskRows, isActiveJobStatus, isSubagentRowInterruptible, subagentInterruptParent, viewerAccessOf, workflowMemberViewerTarget, type TaskBrowserJobInput, type TaskBrowserRow } from '../../domain/task/browser.ts'
import { TaskBrowserRuntime, type TaskBrowserDatasetScope, type TaskBrowserRuntimeHooks, type TaskBrowserSummary } from './task-browser-runtime.ts'
import { rowGroup, taskRowLabel, taskTreePrefix, viewerAccessHint, type TaskPanelItem, type TaskScope } from './task-presentation.ts'
import { fullQuestionRows, questionIdentityOf, quickQuestionRows } from './task-attention.ts'
import type { QuestionAttentionRow } from './question-controller.ts'
import type { TaskBrowserHandle, TuiApp, WorkflowAction } from '../../tui-app.ts'
import type { SurfaceDisplaySeam } from './display-seam.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { SessionSubject } from '../session/subject.ts'
import type { JobObservationPort, JobObservedSnapshot, JobStopOutcome } from '../../runtime/job-observation-port.ts'
import type { SubagentInterruptOutcome } from '../../runtime/subagent-port.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

/**
 * The roster-feed capability the Task Center consumes (A4-6, plan §15; M3-5
 * PR2/PR3). Optional: a composition without a roster source has no dock roster
 * feed and no Job viewer. The runner keeps the selected backend-specific read
 * (Direct maps it to the Host JobRegistry `ctx.jobs`; Remote to the official
 * Client Jobs via `remoteSources.task.jobs()`) plus the `JobId`/`SessionId`
 * casts; the surface never imports the Host service or learns which backend
 * produced the rows. The retained-snapshot fence for a transient read failure
 * is owned by {@link TaskRuntime.attachTasks}.
 *
 * `list`/`subscribe` are ONLY the roster feed. The selected-Job detail/Stop
 * capability is `jobObservation` (both backends), so this interface never
 * carries a backend-specific detail/kill read: the neutral Task/Job UI has no
 * backend-specific Job authority (M3-5 PR3).
 */
export interface TaskSurfaceJobs {
  /** A FRESH roster read of the current root's roster (the selected source's
   *  `list` contract; throws on a failed read). */
  list(sessionId: string | undefined): readonly TaskBrowserJobInput[]
  /** Subscribe to scope-owned roster/runtime events (the `owners: 'scope'`
   *  filter). */
  subscribe(listener: (event: { readonly type: string }) => void): () => void
}

/**
 * The selected Task read capability the Task Center consumes (plan §15.2): the
 * full semantic Task read plus the two live facts the coordinator needs at
 * commit time. The runner supplies it from the SELECTED application runtime
 * (Direct maps it to the Host Agent registry/catalog, Remote to the official
 * Client projections/Session list), so the surface never learns which backend
 * produced the rows.
 */
export interface TaskSurfaceRead {
  currentKey: TaskBrowserRuntimeHooks['currentKey']
  currentSessionId(): string | undefined
  /** The selected Task semantic read (descendant tree + root Job roster). */
  readTask: TaskBrowserRuntimeHooks['readTask']
  /** The selected current-activity read of one child, at commit time. */
  activityOf: TaskBrowserRuntimeHooks['activityOf']
}

/**
 * The narrow production capability the Task Browser / Job viewer need
 * (plan §15.2). Injected by the runner; no Backend port is added for
 * symmetry. The `jobs`/`taskRead` halves are independently optional (the
 * corresponding selected source), mirroring the runner's two original
 * conditional wiring blocks.
 */
export interface TaskSurfaceSource {
  /** The live root session id (undefined = no live agent). */
  sessionId(): string | undefined
  /** Capture the exact ownership subject for the destructive-intent fence. */
  captureSubject(): SessionSubject | undefined
  /** Whether a captured subject is still the current owner generation. */
  subjectMatches(subject: SessionSubject | undefined): boolean
  /** Open the child transcript viewer (session-owned, async hydration). */
  enterView(
    childId: string,
    label: string | undefined,
    mode: 'one-shot' | 'continuable',
    parentSessionId: string,
    activity: 'running' | 'inactive',
    depth?: number,
  ): Promise<void>
  /** Stop one continuable child through the session writer admission. */
  interruptSubagent(parentSessionId: string, childSessionId: string): Promise<SubagentInterruptOutcome>
  /** The root row-selection disposition helper (public root seam). */
  rowSelectionDisposition(
    row: { readonly kind: 'job' | 'subagent' } | undefined,
    jobDetail: 'close' | 'keep-open',
  ): 'close' | 'keep-open'
  /** The subagent-job child-session-id probe (public root seam). */
  subagentJobTranscriptId(snapshot: unknown): string | undefined
  /** The subagent-job viewer body hint (public root seam). */
  subagentJobViewHint(status: string, detail: string | undefined): string
  /** The selected-Job observation port (`backend.jobObservation`). */
  readonly jobObservation: JobObservationPort
  readonly jobs?: TaskSurfaceJobs
  readonly taskRead?: TaskSurfaceRead
}

/** The task-center lifetime inputs the surface borrows from the runner. */
export interface TaskSurfaceDeps {
  /** The runner's diagnostics channel for the owned async flows. */
  readonly diag: Diag
  /** The runner's cleanup latch: the ORIGINAL `cleanedUp` fence. A late async
   *  result or a teardown-triggered refresh must stop touching the surface the
   *  moment the runner begins teardown, before `surface.dispose()`. */
  readonly isCleanedUp: () => boolean
}

/**
 * The Question-attention integration the Task Center consumes (plan §34): an
 * injected presentation READ and refresh only — the `QuestionSurfaceController`
 * stays with its own owner (`interaction-runtime.ts`) and there is never a
 * second controller here.
 */
export interface TaskQuestionAttention {
  /** The current detached attention rows (presentation read only). */
  rows(): readonly QuestionAttentionRow[]
  /** Re-derive continued-question answerability before composing a frame. */
  reconcile(): void
  /** Re-publish the parked-Question count into the surface chrome. */
  publish(): void
  /** Reopen the SAME controller entry for one attention row (false = stale). */
  reopen(sessionId: string, callId: string): boolean
}

/**
 * The presentation state carried from Quick Tasks into the full Task Center
 * (and back out through `getViewState()`).
 *
 * The lifecycle owner is this runtime — it stores `quickTaskState` and
 * `restoreState` — so the type lives here and the TUI panel consumes it as a
 * TYPE only (TS4 plan §13/§14). The row model (`TaskPanelItem`, `TaskScope`)
 * stays presentation-owned in `task-presentation.ts`, and the concrete
 * `TaskBrowserPanel` stays TUI-owned.
 */
export interface TaskBrowserViewState {
  readonly mode: 'quick' | 'full'
  readonly openedFrom: 'quick' | 'command'
  readonly scope: TaskScope
  readonly typeFilter: string | null
  readonly searchMode: boolean
  readonly searchQuery: string
  readonly selectedId: string | null
  readonly expandedIds: ReadonlySet<string>
  readonly collapsedIds: ReadonlySet<string>
}

/** The narrow inputs of the Task Center owner; one cohesive lifetime. */
export interface TaskRuntimeOptions {
  /** The mounted app (throws before `start()`), read through the aggregate.
   * PiTui-only sinks (browser/viewer/panel chrome, action receipts) read it;
   * background-reachable roster commits go through {@link display}. */
  readonly mounted: () => TuiApp
  /** PR3-A: the renderer-facing display seam. Background roster/summary
   * commits and the attention reset are reachable while a read-only TSP
   * renderer owns the terminal; they consult the seam's capability flags and
   * are skipped (not faked) when the renderer presents no Task Center. */
  readonly display: () => SurfaceDisplaySeam
  /** The runner's cleanup latch (the ORIGINAL `cleanedUp` fence). */
  readonly isCleanedUp: () => boolean
  /** The injected Question-attention read/subscription (never the controller). */
  readonly attention: TaskQuestionAttention
}

/** The Task Center / Job viewer owner `createSurfaceRuntime()` consumes. */
export interface TaskRuntime {
  /**
   * Acquire the Task Browser + Job viewer wiring (A4-6, plan §15). Called at
   * the original jobs/subagents wiring position: this owner constructs the
   * `TaskBrowserRuntime` from the injected {@link TaskSurfaceSource} and owns
   * the browser handle, the row-identity source, the jobs-event subscription
   * and the selected-Job observation lifetime.
   */
  attachTasks(source: TaskSurfaceSource, deps: TaskSurfaceDeps): void
  /** The runner's cleanup latch (the ORIGINAL `cleanedUp` fence); false before
   *  `attachTasks`. */
  isCleanedUp(): boolean
  /** The runner diagnostics channel for the owned async flows (late-bound). */
  diag(): Diag
  /** The dock/roster feed (the original `refreshTasks`). */
  refreshTasks(): void
  /** A CATALOG refresh of the subagent half (re-lists descendants). */
  refreshAgents(): void
  /** A RUNTIME-only refresh of the subagent half (NEVER re-lists). */
  refreshAgentRuntimeOnly(): void
  /** Whether one child id is a member of the cached descendant catalog. */
  hasTask(childId: string): boolean
  /** Reset the whole Task Center on a session-generation bump. */
  resetTasks(): void
  /** Open the Task Browser (`quick` = the ↓ trigger, `full` = `/tasks`). */
  openTasksBrowser(
    viewMode: 'quick' | 'full',
    restoreState?: TaskBrowserViewState,
    scope?: TaskBrowserDatasetScope,
    header?: string,
  ): void
  /** Open one Job from the Task Browser (a subagent job may replace it). */
  openJobView(jobId: string): 'close' | 'keep-open'
  /** The Workflow card action sink (PR2 plan §9/§10/§14.5). */
  handleWorkflowAction(action: WorkflowAction): void
  /** Repaint the OPEN browser's rows after a Question-attention change. */
  refreshAttentionRows(): void
  /**
   * Early teardown: release the jobs-event subscription at its original FIRST
   * cleanup position (before the Job observation and the browser handle), so
   * no Job listener can refresh a dying surface.
   */
  disposeJobEvents(): void
  /** Release the selected-Job observation + viewer (idempotent). */
  disposeJobObservation(): void
  /** Drop the Task Browser handle + delayed-action token (idempotent). */
  disposeTaskBrowser(): void
}

/**
 * Whether the opt-in Task Center catalog refresh profiler is enabled for this
 * process (`DSH_TUI_TASK_REFRESH_PROFILE=1`). Off by default: the coalescing
 * gate then emits no diagnostics, so the TUI log stays clean.
 */
function taskCatalogRefreshProfilingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_TUI_TASK_REFRESH_PROFILE === '1'
}

/**
 * The task-browser row → panel-item projection (moved with the Task Center
 * wiring, A4-6). JOB rows keep their status/detail; SUBAGENT rows carry the
 * projected runtime activity as the status word, the durable mode as the
 * non-truncatable suffix, and the tree connector from the catalog depth.
 * `canStop` is advertised ONLY for a continuable child with a LIVE running
 * driver — an idle continuable has no driver to stop.
 *
 * JOB rows are openable/stop-capable on BOTH backends: the selected-Job detail
 * and Stop come from the semantic `jobObservation` port the selected backend
 * always provides (M3-5 PR3), never from a backend-specific registry read.
 */
function taskPanelItems(target: readonly TaskBrowserRow[]): TaskPanelItem[] {
  const labels = new Map<string, string>()
  for (const row of target) {
    if (row.kind === 'subagent') labels.set(row.childId, row.label)
  }
  return target.map(row => row.kind === 'job'
    ? {
        value: row.value,
        // A `subagent`-kind job is the registry's reliable contract
        // for a background one-shot delegation: its `one-shot` mode
        // rides as the non-truncatable suffix, like the child rows.
        label: row.jobKind === 'subagent' ? `subagent job · ${row.label}` : taskRowLabel(row),
        suffix: row.jobKind === 'subagent' ? 'one-shot' : undefined,
        status: row.status,
        detail: row.detail,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        group: rowGroup(row),
        source: 'job' as const,
        active: isActiveJobStatus(row.status),
        attention: row.attention ?? (row.status === 'failed' || row.status === 'timed_out' || row.status === 'lost'),
        canOpen: true,
        canStop: isActiveJobStatus(row.status),
        // The Tab type filter: job rows filter by their job kind.
        type: row.jobKind,
      }
    : {
        value: row.value,
        // The mode rides as the panel's non-truncatable SUFFIX
        // (`subagent · <label> · continuable`): the label itself may
        // truncate on a narrow screen, the mode never silently does.
        label: `subagent · ${row.label}`,
        suffix: row.mode,
        status: row.activity,
        group: rowGroup(row),
        source: 'subagent' as const,
        type: 'subagent',
        active: row.activity === 'running',
        canOpen: true,
        // Only a continuable row with a LIVE running driver is Stop-capable
        // (one-shot ids are accepted no-ops for the interrupt transport; an
        // idle continuable has no driver to stop — the UI must not advertise
        // a dead stop verb).
        canStop: isSubagentRowInterruptible(row),
        parentId: row.parentId === '' ? undefined : `agent:${row.parentId}`,
        parentLabel: row.parentId === '' ? undefined : labels.get(row.parentId),
        depth: row.depth,
        hasChildren: row.hasChildren,
        mode: row.mode,
        access: viewerAccessHint(row.mode, viewerAccessOf(row)),
        // The durable descendant tree connector: indentation + branch
        // glyph from the catalog's `depth` (plan §6.7) — a fixed
        // region that never scrolls with the selected label.
        treePrefix: taskTreePrefix(row.depth),
      })
}

/** One-line viewer hint for a job state (never touches the read cursor). */
function jobStatusHint(status: string, detail: string | undefined): string {
  const tail = status === 'running' || status === 'stopping'
    ? ' — opening the non-consuming retained-output stream…'
    : ` — final output is delivered to the agent via job_output${detail === undefined ? '' : ` (${detail})`}`
  return `${status}${tail}`
}

/** The Job detail body from the detached observation (never a Host read). */
function formatJobObservation(observed: JobObservedSnapshot): string {
  const lines: string[] = [observed.status]
  if (observed.progress !== undefined) lines.push(`progress: ${observed.progress}`)
  if (observed.detail !== undefined) lines.push(`detail: ${observed.detail}`)
  if (observed.gapBefore) lines.push('note: earlier output was evicted before this retained preview')
  if (observed.error !== undefined) lines.push(`follow error: ${observed.error}`)
  lines.push('', 'best-effort retained output preview (not a complete transcript):', '', observed.text)
  return lines.join('\n')
}

/**
 * The ONE user-facing settlement of a Job Stop (plan J2). It preserves the
 * certainty distinction: an unproven `indeterminate` settlement is never
 * reported as "not stopped" and is never replayed — the authoritative Job
 * streams decide.
 */
export function jobStopNotice(outcome: JobStopOutcome, label: string): { message: string; level: 'info' | 'error' } {
  switch (outcome.kind) {
    case 'requested':
      return { message: `stopping ${label}`, level: 'info' }
    case 'already-finished':
      return { message: `${label} already finished`, level: 'info' }
    case 'not-found':
      return { message: `${label} is no longer active`, level: 'info' }
    case 'rejected':
      return { message: `could not stop ${label}: ${outcome.message}`, level: 'error' }
    case 'indeterminate':
      return { message: `could not confirm stopping ${label} — the state will decide`, level: 'error' }
  }
}

/**
 * Create the surface Task Center / Job viewer owner. Every body is the
 * aggregate's original task/job closure verbatim; only the free variables became
 * the injected `mounted`/`isCleanedUp`/`attention` reads.
 */
export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime {
  let taskSource: TaskSurfaceSource | undefined
  let taskDeps: TaskSurfaceDeps | undefined
  let refreshTasks: () => void = () => {}
  let refreshAgents: () => void = () => {}
  let refreshAgentRuntimeOnly: () => void = () => {}
  let taskBrowserRows: TaskBrowserRow[] = []
  let taskRuntime: TaskBrowserRuntime | undefined
  let taskBrowserScope: TaskBrowserDatasetScope = { kind: 'all' }
  let quickTaskState: TaskBrowserViewState | undefined
  let activeTaskBrowser: TaskBrowserHandle | undefined
  let activeTaskBrowserToken: object | undefined
  /** The open browser's mode: Question attention rows are mode-dependent
   *  (Quick lists parked ones only, Full lists every actionable one). */
  let activeTaskBrowserMode: 'quick' | 'full' | undefined
  let activeJobViewerClose: (() => void) | undefined
  /**
   * The CURRENT selected-Job viewer instance. The ownership SessionSubject is
   * NOT viewer currentness: a Job viewer is an overlay that never changes the
   * main owner/generation, so a Stop settlement that resolves after THIS
   * viewer was closed or replaced must be dropped by instance identity.
   */
  let activeJobViewerToken: object | undefined
  let jobsEventsDispose: (() => void) | undefined
  // The surface-owned CATALOG refresh GATE (coalescing): every production Task
  // Center catalog invalidation funnels through `refreshAgents()`, which starts
  // at most ONE coordinator catalog read at a time and records any
  // invalidation arriving mid-flight as `dirty`. When the current traversal
  // settles, a single trailing refresh re-reads the latest membership; a
  // session-generation bump resets the whole gate. The runtime epoch/committed
  // fence stays the OVERLAP-correctness authority; this gate is the performance
  // (single-flight) authority.
  let taskCatalogRefreshGeneration = 0
  let taskCatalogRefreshInFlight = false
  let taskCatalogRefreshDirty = false
  let taskCatalogRefreshPendingInvalidations = 0
  /** The GLOBAL durable descendant count of the last committed catalog (NOT the
   *  scope-filtered presentation rows): profiler-only instrumentation state. */
  let taskCatalogDescendants = 0

  /** The injected task capability; only reachable while attached. */
  const taskCenter = (): TaskSurfaceSource => {
    if (taskSource === undefined) throw new Error('the task center is not attached')
    return taskSource
  }
  /** The runner diagnostics channel for the owned async flows. */
  const taskDiag = (): Diag => {
    if (taskDeps === undefined) throw new Error('the task center is not attached')
    return taskDeps.diag
  }

  /**
   * Start exactly ONE Task Center catalog traversal. Ownership state is
   * committed BEFORE `runOwned` invokes the factory: `refreshCatalog()` runs
   * synchronously up to its first await (it emits the loading state
   * immediately), so a re-entrant invalidation from there must already see
   * `inFlight = true`. `trailing` records whether this read was scheduled by a
   * settle (a coalesced trailing read) rather than by a direct invalidation.
   */
  const startTaskCatalogRefresh = (trailing: boolean): void => {
    if (options.isCleanedUp()) return
    const generation = taskCatalogRefreshGeneration
    taskCatalogRefreshInFlight = true
    taskCatalogRefreshDirty = false
    const invalidations = Math.max(1, taskCatalogRefreshPendingInvalidations)
    taskCatalogRefreshPendingInvalidations = 0
    const startedAt = Date.now()
    runOwned('task browser agents refresh', () => taskRuntime!.refreshCatalog(), {
      diag: taskDiag(),
      sessionId: () => taskCenter().sessionId(),
      onResult: () => settleTaskCatalogRefresh(generation, invalidations, trailing, startedAt, 'ok'),
      onCancel: () => settleTaskCatalogRefresh(generation, invalidations, trailing, startedAt, 'cancelled'),
      onError: () => settleTaskCatalogRefresh(generation, invalidations, trailing, startedAt, 'error'),
    })
  }
  /**
   * Release the gate after ONE traversal settles. A settled refresh of a
   * SUPERSEDED generation (a session switch happened mid-flight) is a gate
   * no-op: the new generation owns the gate, and the old traversal must neither
   * clear the new session's in-flight mark nor schedule a trailing read. (It is
   * still profiled, with only its own start-time facts.) Otherwise the gate is
   * released and, when any invalidation arrived while the traversal was in
   * flight, EXACTLY ONE trailing refresh starts.
   */
  const settleTaskCatalogRefresh = (
    generation: number,
    invalidations: number,
    trailing: boolean,
    startedAt: number,
    outcome: 'ok' | 'cancelled' | 'error',
  ): void => {
    const superseded = generation !== taskCatalogRefreshGeneration
    if (taskCatalogRefreshProfilingEnabled()) {
      // Opt-in profile (default off): one line per REAL started traversal —
      // including one of a SUPERSEDED generation, whose result never commits.
      // A superseded line carries ONLY the facts captured when the read
      // started; the current gate/catalog state belongs to the new session and
      // must not be attributed to the old read. Never records session ids,
      // prompts or child labels.
      const fields: Record<string, unknown> = {
        elapsedMs: Date.now() - startedAt,
        invalidations,
        trailing,
        outcome,
        generation,
        superseded,
      }
      if (!superseded) {
        fields.dirtyAtSettle = taskCatalogRefreshDirty
        // Only an `ok` read COMMITTED a catalog: a failed/cancelled read leaves
        // the previous membership in place, so the last committed count must
        // not be reported as this traversal's descendant scale.
        if (outcome === 'ok') fields.descendants = taskCatalogDescendants
      }
      taskDiag().info('task catalog refresh profile', fields)
    }
    if (superseded) return
    taskCatalogRefreshInFlight = false
    if (!taskCatalogRefreshDirty) return
    taskCatalogRefreshDirty = false
    startTaskCatalogRefresh(true)
  }
  /** Reset the task-browser dataset scope to the global dataset (PR2 plan
   *  §10.8): every close path (Esc, row selection) clears the scope so the
   *  next ordinary `/tasks` / ↓ Task Center sees `all` again. */
  const resetTaskBrowserScope = (): void => {
    taskBrowserScope = { kind: 'all' }
    taskRuntime?.setScope({ kind: 'all' })
  }
  // The four coordinator commits: the row-identity source for the open
  // browser's select path always reflects the latest commit, and the repaint
  // targets ONLY the open handle. Every commit keeps the runner's `cleanedUp`
  // fence.
  /**
   * Task Center rows = Question attention ABOVE the work rows (§7.2/§9.3).
   * Attention is composed from the controller's detached presentation model
   * only — Task Center never reads the Question projection or the Inbox — and
   * it is composed BEFORE the first frame so a work-only list never flashes.
   */
  const taskPanelItemsWithAttention = (
    rows: readonly TaskBrowserRow[],
    mode: 'quick' | 'full',
  ): TaskPanelItem[] => {
    const attention = options.attention.rows()
    const questionItems = mode === 'quick' ? quickQuestionRows(attention) : fullQuestionRows(attention)
    return [...questionItems, ...taskPanelItems(rows)]
  }

  const commitRows = (rows: readonly TaskBrowserRow[], preferred?: string): void => {
    if (options.isCleanedUp()) return
    taskBrowserRows = [...rows]
    if (activeTaskBrowserMode === undefined) {
      // No browser open: only the select-path identity source is updated.
      return
    }
    activeTaskBrowser?.setItems(taskPanelItemsWithAttention(rows, activeTaskBrowserMode), preferred)
  }
  const commitBadge = (running: ReadonlyArray<{ id: string; label: string }>): void => {
    if (options.isCleanedUp()) return
    // PR3-A: the roster badge is Task-Center chrome; a renderer without it
    // (read-only TSP) legitimately skips the commit — never a fake roster.
    if (!options.display().supportsTaskCenter) return
    options.mounted().setAgents(running.map(entry => ({
      id: entry.id,
      label: entry.label,
      activity: 'running',
    })))
  }
  const commitSummary = (summary: TaskBrowserSummary): void => {
    // Profiler-only: remember the GLOBAL durable descendant count of this
    // commit. `summary.totalAgents` is projected before the browser's dataset
    // scope filters the rows, so it stays the catalog scale for a scoped
    // browser too — and it excludes the Job rows that `rows()` carries.
    taskCatalogDescendants = summary.totalAgents
    if (options.isCleanedUp()) return
    if (!options.display().supportsTaskCenter) return
    options.mounted().setTaskSummary(summary)
  }
  const commitRefreshState = (state: 'loading' | 'ready' | 'stale', error?: string): void => {
    if (options.isCleanedUp()) return
    activeTaskBrowser?.setRefreshState?.(state, error)
  }

  /**
   * Open the selected-Job status viewer. Its facts are backend-neutral: the
   * opening Task row is the fallback until the FIRST observed snapshot, and
   * from then on the viewer repaints the LATEST local observation — its timer
   * never reads Host/Client Job output. `jobObservation.stop` is the one Stop
   * mutation, fenced by the viewer's captured subject + the latest active
   * status.
   */
  const openJobStatusViewer = (
    jobId: string,
    title: string,
    row: { readonly jobKind: string; readonly label: string; readonly status: string; readonly detail?: string },
  ): void => {
    const source = taskCenter()
    // One viewer at a time, and a fresh selection replaces the previous.
    activeJobViewerClose?.()
    const ownerSessionId = source.sessionId()
    if (ownerSessionId === undefined) return
    // The destructive-intent fence is captured at OPEN time (like the browser
    // fence): a Stop confirmed later belongs to THIS viewer's subject.
    const viewerSubject = source.captureSubject()
    // …and the viewer INSTANCE token is the currentness fence: the ownership
    // subject alone stays current across a same-Session Job A -> Job B
    // replacement, so a stale settlement is dropped by identity.
    const viewerToken = {}
    activeJobViewerToken = viewerToken
    const viewerCurrent = (): boolean => activeJobViewerToken === viewerToken
    const fallbackText = row.jobKind === 'subagent'
      ? source.subagentJobViewHint(row.status, row.detail)
      : jobStatusHint(row.status, row.detail)
    // The selected Job is the ONLY observed Job (P1-B1). The observer is
    // event-driven at its data source: the official follow stream updates
    // this local snapshot and the viewer's existing refresh timer merely
    // repaints it — the tick never reads Host output.
    let observed: JobObservedSnapshot | undefined
    let observationError: string | undefined
    let closeObserver: () => void = () => {}
    try {
      closeObserver = source.jobObservation.open(ownerSessionId, jobId, (next) => { observed = next })
    } catch (error) {
      // A composition without the official job-controller row (the injected
      // production row guarantees it) degrades to the status-only detail —
      // the documented safety valve — and says so explicitly.
      observationError = safeErrorMessage(error)
    }
    const refreshBody = (): string => {
      if (observed !== undefined) return formatJobObservation(observed)
      // Only the opening row projection before the first observed snapshot:
      // never a registry/roster re-read on the timer.
      return observationError === undefined
        ? fallbackText
        : `${fallbackText}\nlive observation unavailable: ${observationError}`
    }
    // The Stop key and its hint share ONE live capability source: THIS viewer
    // instance still current, the captured subject still current, and the
    // latest OBSERVED status (the opening row before the first snapshot).
    const activeForStop = (): boolean =>
      viewerCurrent()
      && source.subjectMatches(viewerSubject)
      && isActiveJobStatus(observed?.status ?? row.status)
    activeJobViewerClose = options.mounted().openOutputViewer({
      title,
      initial: fallbackText,
      refresh: refreshBody,
      onStop: () => {
        // Re-check both fences at dispatch: a stale viewer/session
        // confirmation dispatches nothing.
        if (!activeForStop()) return
        runOwned('job stop', () => source.jobObservation.stop(ownerSessionId, jobId), {
          diag: taskDiag(),
          sessionId: () => ownerSessionId,
          onResult: (outcome) => {
            if (options.isCleanedUp() || !viewerCurrent() || !source.subjectMatches(viewerSubject)) return
            const notice = jobStopNotice(outcome, row.label)
            options.mounted().notify(notice.message, notice.level)
          },
          onError: (error) => {
            if (options.isCleanedUp() || !viewerCurrent() || !source.subjectMatches(viewerSubject)) return
            options.mounted().notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
          },
        })
        // No optimistic local mutation: the official roster/observation
        // streams converge on their own.
      },
      canStop: activeForStop,
      // The viewer was opened from the Task Center browser: Esc returns
      // to the parent browser, not to the editor.
      closeHint: 'back',
      onClose: () => {
        // Invalidate THIS viewer's instance fence BEFORE releasing, so a Stop
        // settlement still in flight can never notify a replacement surface.
        if (activeJobViewerToken === viewerToken) activeJobViewerToken = undefined
        // Closing the viewer always releases the observer (Esc, the parent
        // browser closing, a session transition, or surface teardown).
        closeObserver()
        activeJobViewerClose = undefined
        refreshTasks()
      },
    })
  }

  /**
   * Open one job from the task browser from its CURRENT row projection: an
   * ordinary Job opens the backend-neutral selected-Job viewer, whose facts
   * come from `jobObservation` (never `jobs.read()`); a subagent job whose
   * stable child session id is unknown shows the same Job detail with a /tasks
   * hint. The row projection is the row identity + opening-metadata authority
   * — never a fresh registry read. Returns the navigation disposition for the
   * selecting browser: the transcript path REPLACES the Task Center
   * (`'close'`); a Job detail is a child overlay of it (`'keep-open'`).
   */
  const openJobView = (jobId: string): 'close' | 'keep-open' => {
    const source = taskCenter()
    const ownerSessionId = source.sessionId()
    if (ownerSessionId === undefined) return 'keep-open'
    const row = taskBrowserRows.find(
      (candidate): candidate is Extract<TaskBrowserRow, { readonly kind: 'job' }> =>
        candidate.kind === 'job' && candidate.jobId === jobId,
    )
    if (row === undefined) return 'keep-open'
    if (row.jobKind === 'subagent') {
      const childSessionId = source.subagentJobTranscriptId(row)
      if (childSessionId !== undefined) {
        // The registry's `subagent` kind IS the reliable contract
        // for a background ONE-SHOT delegation (the registry never
        // records continuable children): the transcript viewer opens
        // read-only. The parent is the job owner.
        runOwned('subagent view from tasks', () => source.enterView(
          childSessionId, row.label, 'one-shot', ownerSessionId, 'inactive',
        ), {
          diag: taskDiag(),
          sessionId: () => ownerSessionId,
          onError: (error) => {
            if (options.isCleanedUp()) return
            options.mounted().notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error')
          },
        })
        // The transcript viewer is a session surface, not a Job child
        // overlay: it keeps its own Esc semantics (browser closed).
        return 'close'
      }
      // The rc.2 Job row carries no stable child id. Use the reliable status
      // fallback and let /tasks (which owns child identities through
      // the merged browser) perform transcript selection; never substitute
      // label/order/time matching.
      openJobStatusViewer(jobId, `subagent ${row.jobId} · ${row.label}`, row)
      return 'keep-open'
    }
    openJobStatusViewer(jobId, `${row.jobKind} ${row.jobId} · ${row.label}`, row)
    return 'keep-open'
  }

  /**
   * Open the Task Browser. `quick` is the ↓ trigger, `full` is the `/tasks`
   * surface; the SAME browser serves both.
   */
  const openTasksBrowser = (
    viewMode: 'quick' | 'full',
    restoreState?: TaskBrowserViewState,
    scope?: TaskBrowserDatasetScope,
    header?: string,
  ): void => {
    const source = taskCenter()
    const browserSessionId = source.sessionId()
    if (options.isCleanedUp() || browserSessionId === undefined) return
    // PR2 plan §10.5/§10.8: an EXPLICIT scope (a Workflow phase/run
    // dataset) becomes the browser's dataset scope; a transition
    // (Quick→Full / Full→Quick) without one keeps the current scope; a
    // fresh ordinary open after a close always starts from `all` (the
    // close paths reset it). The scope applies at EVERY runtime commit.
    if (scope !== undefined) taskBrowserScope = scope
    taskRuntime?.setScope(taskBrowserScope)
    // The destructive-intent fence is captured at OPEN time: a Stop
    // confirmed later belongs to THIS surface's session. Comparing the
    // generation/session AT dispatch against values captured AT dispatch
    // (as in an earlier revision) could never fail — the intent must be
    // bound to the browser that hosted the confirmation (PR review P1).
    const browserSubject = source.captureSubject()
    const browserToken = {}
    activeTaskBrowserToken = browserToken
    let jobSnapshots: readonly TaskBrowserJobInput[] = []
    const jobs = source.jobs
    if (jobs !== undefined) {
      try {
        // Job ownership is the Session id (DSH 0.1.7 JobRegistry): the
        // live session id is only the id source here.
        jobSnapshots = jobs.list(browserSessionId)
      } catch {
        // The registry read is best-effort; the jobs half stays empty.
      }
    }
    // The trigger only fires while something is ACTIVE (jobs or live
    // children), so an empty jobs half is NOT an empty browser: the
    // children half enriches below. Never early-return on row count —
    // a children-only session would never open the browser. The row
    // identity source is the SURFACE-level `taskBrowserRows` (kept fresh
    // by every coordinator commit), so the select/action paths below
    // never contradict a runtime refresh that already repainted.
    //
    // FIRST FRAME: seed from the coordinator's CURRENT state instead of
    // flashing a jobs-only list — refreshRuntime() is synchronous, never
    // touches persistence, reuses the cached catalog and re-reads the
    // current jobs + registry statuses (activeTaskBrowser is not set
    // yet, so it only seeds taskBrowserRows + the badge). The badge and
    // the panel therefore agree from the first frame, and a FAILED fresh
    // listing below cannot leave a panel that contradicts the badge.
    // Without the runtime (no subagents service) the jobs-only fallback
    // applies.
    const runtime = taskRuntime
    if (runtime !== undefined) {
      runtime.refreshRuntime()
      taskBrowserRows = [...runtime.rows()]
    } else {
      taskBrowserRows = buildTaskRows(jobSnapshots, [])
    }
    const selectRow = (value: string): 'close' | 'keep-open' => {
      if (options.isCleanedUp()) return 'close'
      // A Question attention row is NOT a Job: it never enters the Job
      // stop/detail paths. Enter reopens the SAME controller entry, and a row
      // that went stale between rendering and selection (another client
      // queued/settled the call) fails closed and keeps the browser usable.
      const questionIdentity = questionIdentityOf(value)
      if (questionIdentity !== undefined) {
        const reopened = options.attention.reopen(questionIdentity.sessionId, questionIdentity.callId)
        return reopened ? 'close' : 'keep-open'
      }
      const row = taskBrowserRows.find(candidate => candidate.value === value)
      if (row === undefined) return source.rowSelectionDisposition(undefined, 'keep-open')
      if (row.kind === 'subagent') {
        // The viewer target carries the row's OWN parent (plan §6.10:
        // childId + parentId + depth + mode + activity — never just
        // childId + mode). A nested row's durable parent is the exact
        // direct parent recorded by DSH; only a direct child falls back
        // to the browser root (the live main session).
        const parentSessionId = row.parentId !== '' ? row.parentId : source.sessionId()
        if (parentSessionId === undefined) return 'close'
        // The row carries the catalog MODE + projected activity + DEPTH:
        // the viewer target is pinned to them (continuable → interactive
        // editor only at depth 1, one-shot → read-only, depth > 1 →
        // nested read-only), and the follow-up write path to the exact
        // parent.
        runOwned('subagent view from tasks', () => source.enterView(
          row.childId, row.label, row.mode, parentSessionId, row.activity, row.depth,
        ), {
          diag: taskDiag(),
          sessionId: () => source.sessionId(),
          onError: (error) => {
            if (options.isCleanedUp()) return
            options.mounted().notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error')
          },
        })
        // The subagent transcript is a session/viewer surface, not a
        // child overlay of the browser: it REPLACES the Task Center and
        // keeps its own Esc semantics.
        return source.rowSelectionDisposition(row, 'keep-open')
      }
      // A Job View is the selected row's DETAIL: it opens as a child
      // overlay (hiding this browser, not destroying it) and returns to
      // the exact browser state on Esc. A job that has already vanished
      // simply opens nothing — the parent stays usable either way.
      return source.rowSelectionDisposition(row, openJobView(row.jobId))
    }
    const stopRow = (value: string): void => {
      if (options.isCleanedUp()) return
      const row = taskBrowserRows.find(candidate => candidate.value === value)
      if (row === undefined) return
      const actionBrowserToken = activeTaskBrowserToken
      if (actionBrowserToken !== browserToken) return
      // The SURFACE fence: the user's destructive intent is bound to the
      // session that owned this browser when it opened. A session that
      // switched after the browser opened (or while a confirmation was
      // pending) must never be stopped by the stale confirmation — the
      // captured browser values, not the dispatch-time values, are the
      // comparison side that can actually fail.
      if (!source.subjectMatches(browserSubject)) return
      if (row.kind === 'subagent') {
        if (!isSubagentRowInterruptible(row)) return
        // Re-read the live driver at confirmation time; the panel row is
        // only a snapshot and may have become idle since it was rendered.
        if (source.taskRead?.activityOf(row.childId) !== 'running') return
        // The interrupt authority names the child's DURABLE DIRECT parent;
        // deep descendants must not be addressed through the main root.
        const interruptParent = subagentInterruptParent(row, browserSessionId)
        // The scope-bound writer admission (A3-4): the Task-Center subagent
        // interrupt is NOT a submission write, so its business ownership
        // stays in the runner — only the admission moves through
        // SessionRuntime.withWriter. The surface calls the injected op.
        runOwned('subagent interrupt', function () {
          return source.interruptSubagent(interruptParent, row.childId)
        }, {
          diag: taskDiag(),
          sessionId: () => browserSessionId,
          onResult: (outcome) => {
            if (options.isCleanedUp() || activeTaskBrowserToken !== actionBrowserToken || !source.subjectMatches(browserSubject)) return
            if (outcome.kind === 'committed') {
              options.mounted().notify(`stopping ${row.label}`, 'info')
              return
            }
            if (outcome.kind === 'indeterminate') {
              // A dispatched interrupt whose settlement is unknown must not
              // be reported as "not stopped"; the authoritative task/read
              // state decides and no automatic replay happens.
              options.mounted().notify(`could not confirm stopping ${row.label} — the session state will decide`, 'error')
              return
            }
            const reason = outcome.reason.kind === 'error'
              ? outcome.reason.message
              : outcome.reason.message ?? (outcome.reason.kind === 'unauthorized'
                ? 'subagent interrupt unauthorized'
                : 'subagent service unavailable')
            options.mounted().notify(`could not stop ${row.label}: ${reason}`, 'error')
          },
          onError: (error) => {
            if (options.isCleanedUp() || activeTaskBrowserToken !== actionBrowserToken || !source.subjectMatches(browserSubject)) return
            options.mounted().notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
          },
        })
        return
      }
      // Job Stop uses the SAME semantic operation as the viewer on BOTH
      // backends: the browser/subject fence above already bound the intent,
      // the CURRENT projection row must still be active, then the ONE
      // `jobObservation.stop` is dispatched. No optimistic local mutation —
      // the authoritative roster/observation streams converge the row.
      if (!isActiveJobStatus(row.status)) return
      runOwned('job stop from tasks', () => taskCenter().jobObservation.stop(browserSessionId, row.jobId), {
        diag: taskDiag(),
        sessionId: () => browserSessionId,
        onResult: (outcome) => {
          if (options.isCleanedUp() || activeTaskBrowserToken !== actionBrowserToken || !source.subjectMatches(browserSubject)) return
          const notice = jobStopNotice(outcome, row.label)
          options.mounted().notify(notice.message, notice.level)
        },
        onError: (error) => {
          if (options.isCleanedUp() || activeTaskBrowserToken !== actionBrowserToken || !source.subjectMatches(browserSubject)) return
          options.mounted().notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
        },
      })
    }
    // Read Question authority BEFORE composing the first frame: the attention
    // rows Task Center shows must reflect the current projection, never only
    // whatever the last routed event happened to reconcile (addendum §9.3).
    options.attention.reconcile()
    // Re-publish the parked count with the same fresh authority: the footer
    // affordance must never lag a Question that is already known to be pending.
    options.attention.publish()
    const initialScope = restoreState?.scope ?? (viewMode === 'quick' ? 'active' : 'all')
    const initialQuery = restoreState?.searchQuery ?? ''
    const initialSelected = restoreState?.selectedId === 'task:view-all' ? undefined : restoreState?.selectedId ?? undefined
    const initialPreferred = initialSelected
      ?? taskBrowserRows.find(row => row.kind === 'subagent' && row.activity === 'running')?.value
      ?? taskBrowserRows.find(row => row.kind === 'job' && isActiveJobStatus(row.status))?.value
    const handle = options.mounted().openTaskBrowser(
      taskPanelItemsWithAttention(taskBrowserRows, viewMode),
      // Selection disposition decides whether the browser survives: a Job
      // detail keeps it MOUNTED underneath (the overlay stack hides and
      // restores the exact instance/state on Esc); a terminal navigation
      // (subagent transcript, row left the dataset) drops the
      // active-handle reference so a later runtime refresh cannot repaint
      // a closed browser, and resets the dataset scope (PR2 plan §10.8 —
      // the next ordinary Task Center must see the global dataset).
      (value) => {
        if (options.isCleanedUp()) return 'close'
        const disposition = selectRow(value)
        if (disposition === 'keep-open') return 'keep-open'
        activeTaskBrowser = undefined
        activeTaskBrowserToken = undefined
        activeTaskBrowserMode = undefined
        resetTaskBrowserScope()
        return 'close'
      },
      () => {
        if (options.isCleanedUp()) return
        const current = activeTaskBrowser?.getViewState?.()
        activeTaskBrowser = undefined
        activeTaskBrowserToken = undefined
        activeTaskBrowserMode = undefined
        resetTaskBrowserScope()
        if (viewMode === 'full' && restoreState !== undefined) {
          // Esc from a promoted full view returns to Quick with the latest
          // shared context, not the state from the promotion moment.
          const state = current ?? quickTaskState ?? restoreState
          openTasksBrowser('quick', state)
        }
      },
      {
        header: header ?? 'Tasks',
        enableSearch: true,
        mode: viewMode,
        openedFrom: viewMode === 'full' && restoreState !== undefined ? 'quick' : 'command',
        scope: initialScope,
        typeFilter: restoreState?.typeFilter,
        initialQuery,
        initialSearchMode: restoreState?.searchMode,
        expandedIds: [...(restoreState?.expandedIds ?? [])],
        collapsedIds: [...(restoreState?.collapsedIds ?? [])],
        selectedId: initialSelected,
        preferredValue: initialPreferred,
        maxVisible: viewMode === 'quick' ? 8 : 18,
        loading: runtime !== undefined && taskBrowserRows.length === 0,
        groupLabels: true,
        onRefresh: () => {
          if (options.isCleanedUp()) return
          if (runtime === undefined) {
            refreshTasks()
            return
          }
          // R routes through the coalesced catalog gate: an invalidation while
          // a traversal is in flight marks the gate dirty, and the current read
          // settles into ONE trailing refresh that reads the latest membership
          // — instead of racing a second full descendant traversal. Refresh
          // state stays SINGLE-OWNER: only the coordinator's
          // commitRefreshState (fenced by session key + request epoch) may set
          // loading/ready/stale on the presentation. The surface must never
          // touch setRefreshState directly — an unfenced onError could mark a
          // NEW session's browser as failed when the OLD session's listing
          // rejects (PR review P1).
          refreshAgents()
        },
        onViewFull: state => {
          if (options.isCleanedUp()) return
          activeTaskBrowser = undefined
          activeTaskBrowserToken = undefined
          activeTaskBrowserMode = undefined
          quickTaskState = state
          openTasksBrowser('full', state)
        },
        onStop: stopRow,
        onViewportExpose: ids => { if (!options.isCleanedUp()) runtime?.acknowledge(ids) },
      },
    )
    activeTaskBrowser = handle
    activeTaskBrowserMode = viewMode
    // Acknowledging failures is CONTINUOUS, not one-shot-at-open: the
    // panel reports each attention row the first time it enters the
    // open viewport (first frame AND every later scroll/page/jump), and
    // the runtime acknowledges exactly those ids (PR review P1/P2). Only
    // rows the user can actually see lose their footer attention;
    // Quick's Active scope leaves terminal failures pending while live
    // work is present, so its badge stays useful.
    // The open routes through the SAME coalesced catalog gate as every other
    // invalidation (membership may have drifted since the last listing): a
    // traversal already in flight is never duplicated — opening only marks the
    // gate dirty and the current read settles into ONE trailing refresh. The
    // coordinator fences that read against a session switch and commits through
    // the ACTIVE handle, so a browser closed while it is in flight is never
    // repainted; the first frame above already painted cached membership +
    // fresh runtime status. Refresh state is single-owner: the coordinator's
    // fenced commitRefreshState is the ONLY path that sets loading/ready/stale
    // (an unfenced error path could mark a new session's browser failed when an
    // old session's listing rejects — PR review P1).
    refreshAgents()
  }

  /** The Workflow card action sink (PR2 plan §9/§10/§14.5): the TUI emits
   *  semantic intents; THIS handler resolves them against the real Task Center
   *  / Subagent catalog and opens the existing surfaces — never a
   *  Workflow-specific viewer or browser. */
  const handleWorkflowAction = (action: WorkflowAction): void => {
    const source = taskCenter()
    const sessionId = source.sessionId()
    if (sessionId === undefined) return
    switch (action.kind) {
      case 'open-member': {
        // Direct member navigation (plan §9.2): the SINGLE authority
        // resolver checks the catalog facts (row exists, subagent,
        // direct child of the current session, driver running) — the
        // model-side `member.status === running` was already verified by
        // the app at click time. A missing catalog row (agent-start
        // before the listing) or any failed condition is a no-op — the
        // row simply does not open (plan §9.5).
        const row = taskBrowserRows.find(candidate =>
          candidate.kind === 'subagent' && candidate.childId === action.childId)
        const target = workflowMemberViewerTarget(
          { status: 'running', childId: action.childId },
          row,
          sessionId,
        )
        if (target === undefined) return
        runOwned('workflow member view', () => source.enterView(
          target.childSessionId,
          target.label,
          target.mode,
          target.parentSessionId,
          target.activity,
          target.depth,
        ), {
          diag: taskDiag(),
          sessionId: () => source.sessionId(),
          onError: (error) => {
            if (options.isCleanedUp()) return
            options.mounted().notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error')
          },
        })
        return
      }
      case 'open-phase-agents':
      case 'open-run-agents': {
        // Scoped Task Viewer (plan §10): the EXACT workflow child-id set
        // becomes the browser's dataset scope; the existing Task Center
        // provides search/filter/browse and the existing cold-view
        // semantics for terminal children (plan §10.7).
        if (taskRuntime === undefined) return
        const count = action.childIds.length
        const header = action.kind === 'open-phase-agents'
          ? `Workflow · ${action.name} · ${action.phaseLabel} · ${count} agent${count === 1 ? '' : 's'}`
          : `Workflow · ${action.name} · ${count} agent${count === 1 ? '' : 's'}`
        openTasksBrowser('full', undefined, { kind: 'subagents', childIds: action.childIds }, header)
        return
      }
    }
  }

  return {
    attachTasks(source, deps) {
      taskSource = source
      taskDeps = deps
      // The last SUCCESSFUL jobs read, FENCED to the session identity: a
      // transient registry failure must keep the retained Job rows, but a
      // switched-in session must never inherit the old session's rows.
      let retainedJobsSnapshot: { key: string; rows: readonly TaskBrowserJobInput[] } | undefined
      // The jobs half: the dock roster feed + the scope-owned event
      // subscription. Absent service = no jobs surface (the original two
      // conditional blocks are preserved).
      const jobs = source.jobs
      if (jobs !== undefined) {
        refreshTasks = (): void => {
          if (options.isCleanedUp()) return
          let snapshots: readonly TaskBrowserJobInput[]
          try {
            // Keep terminal records in the catalog — the registry IS the
            // membership authority, and TRACKED is its current roster.
            // Job ownership is the Session id; without a live agent the
            // registry read is the unowned-only view (caller omitted).
            snapshots = jobs.list(source.sessionId())
          } catch {
            // Best-effort: a failed registry read is NOT an authoritative
            // empty catalog. Keeping the previous snapshot matters most for
            // a Job detail's retained parent browser — the close-time
            // refresh must not blank the rows/selection it restores.
            return
          }
          const tasks = snapshots.map(job => ({
            id: job.id,
            label: job.label,
            status: job.status,
            kind: job.kind,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
          }))
          if (options.display().supportsTaskCenter) options.mounted().setTasks(tasks)
          // A jobs-only session has no catalog coordinator, so this is the
          // ONLY refresh channel for an OPEN browser. Keep it in step with
          // the registry, or a Job detail's hidden parent returns with stale
          // status (the subagents path commits through TaskBrowserRuntime).
          if (taskRuntime === undefined && activeTaskBrowser !== undefined && activeTaskBrowserMode !== undefined) {
            taskBrowserRows = buildTaskRows(snapshots, [])
            activeTaskBrowser.setItems(taskPanelItemsWithAttention(taskBrowserRows, activeTaskBrowserMode))
          }
        }
        // Events route by SEMANTICS, mirroring the TaskBrowserRuntime's own
        // catalog/runtime split:
        // - `output` is a ring APPEND and changes no roster/status fact;
        // - `progress` / `stopping` change only JobView runtime facts (the
        //   runtime-only refresh re-projects from the cached catalog);
        // - everything else may move membership: the full catalog refresh.
        jobsEventsDispose = jobs.subscribe((event) => {
          switch (event.type) {
            case 'output':
              return
            case 'progress':
            case 'stopping':
              refreshTasks()
              refreshAgentRuntimeOnly()
              return
            default:
              refreshTasks()
              refreshAgents()
          }
        })
        refreshTasks()
      }
      // The subagent half: the TaskBrowserRuntime coordinator owns the
      // catalog-vs-runtime split (see task-browser-runtime.ts). Its Task
      // dataset arrives through the SELECTED semantic read source, so the
      // Remote branch never reaches the process-local Host services.
      const taskRead = source.taskRead
      if (taskRead !== undefined) {
        taskRuntime = new TaskBrowserRuntime({
          currentKey: taskRead.currentKey,
          readTask: taskRead.readTask,
          // The merged rows re-read the CURRENT jobs snapshot at every commit,
          // so a job settlement repaints an open browser too.
          readJobs: () => {
            const key = taskRead.currentKey()
            const sessionId = taskRead.currentSessionId()
            if (jobs === undefined || key === undefined || sessionId === undefined) return []
            try {
              const rows = jobs.list(sessionId)
              retainedJobsSnapshot = { key, rows }
              return rows
            } catch {
              // The registry read is best-effort: a failed read is NOT an
              // authoritative empty catalog. Returning the last successful
              // snapshot preserves the retained Job rows — but ONLY for the same
              // session identity, so a switched-in session never inherits the
              // old session's rows.
              return retainedJobsSnapshot?.key === key ? retainedJobsSnapshot.rows : []
            }
          },
          activityOf: taskRead.activityOf,
          commitRows,
          commitBadge,
          commitSummary,
          commitRefreshState,
        })
        // Seed the summary synchronously from jobs before the durable
        // catalog listing lands; this prevents a terminal/jobs-only first
        // frame from claiming every record is still running.
        taskRuntime.refreshRuntime()
        // The single production CATALOG invalidation entry: every trigger
        // (attach seed, subagent lifecycle, tool fallback, Job membership,
        // browser open, Full Task Center R) funnels here. An in-flight
        // traversal absorbs any number of invalidations as `dirty`; its settle
        // then starts exactly one trailing read.
        refreshAgents = (): void => {
          if (options.isCleanedUp()) return
          if (source.sessionId() === undefined) {
            if (options.display().supportsTaskCenter) options.mounted().setAgents([])
            return
          }
          taskCatalogRefreshPendingInvalidations += 1
          if (taskCatalogRefreshInFlight) {
            taskCatalogRefreshDirty = true
            return
          }
          startTaskCatalogRefresh(false)
        }
        refreshAgentRuntimeOnly = (): void => {
          if (options.isCleanedUp()) return
          if (source.sessionId() === undefined) {
            if (options.display().supportsTaskCenter) options.mounted().setAgents([])
            return
          }
          taskRuntime!.refreshRuntime()
        }
        refreshAgents()
      }
    },
    refreshTasks() {
      refreshTasks()
    },
    diag() {
      return taskDiag()
    },
    isCleanedUp() {
      return taskDeps?.isCleanedUp() === true
    },
    refreshAgents() {
      refreshAgents()
    },
    refreshAgentRuntimeOnly() {
      refreshAgentRuntimeOnly()
    },
    hasTask(childId) {
      return taskRuntime?.has(childId) === true
    },
    resetTasks() {
      // A session switch drops the old session's Question attention with the
      // rest of the Task Center state: its parked count must not arm the new
      // session's footer trigger.
      if (options.display().supportsTaskCenter) options.mounted().setQuestionAttention(0)
      // Invalidate the coalescing gate BEFORE any close/dispose that can
      // synchronously run a callback: the old session's slow traversal must
      // neither hold the new session's refresh back (`inFlight`) nor clear the
      // new generation's gate when it settles (the generation fence). The
      // runtime's own session/epoch fence remains the second protection for the
      // catalog commit.
      taskCatalogRefreshGeneration += 1
      taskCatalogRefreshInFlight = false
      taskCatalogRefreshDirty = false
      taskCatalogRefreshPendingInvalidations = 0
      // A new session owns the surface: close the Job child overlay FIRST
      // (so closing the hidden parent cannot leave the child alive), then
      // the browser, then reset the coordinator + the synchronous
      // badge/summary/row mirrors (the new session's first listing is async
      // and the old session's state must not hang on screen).
      activeJobViewerClose?.()
      activeJobViewerClose = undefined
      activeTaskBrowser?.close()
      activeTaskBrowser = undefined
      activeTaskBrowserToken = undefined
      activeTaskBrowserMode = undefined
      taskRuntime?.reset()
      // The dataset scope is session-scoped too: a switched-in session must
      // never inherit a Workflow-scoped browser (PR2 plan §10.8).
      taskBrowserScope = { kind: 'all' }
      if (options.display().supportsTaskCenter) {
        options.mounted().setTaskSummary({ runningAgents: 0, totalAgents: 0, runningJobs: 0, totalJobs: 0, failedAttention: 0, failedTotal: 0 })
        options.mounted().setTasks([])
      }
      if (options.display().supportsTaskCenter) options.mounted().setAgents([])
      taskBrowserRows = []
    },
    openTasksBrowser(viewMode, restoreState, scope, header) {
      openTasksBrowser(viewMode, restoreState, scope, header)
    },
    openJobView(jobId) {
      return openJobView(jobId)
    },
    handleWorkflowAction(action) {
      handleWorkflowAction(action)
    },
    refreshAttentionRows() {
      // The Question-attention subscription is a PRESENTATION-only refresh: it
      // never re-lists the Subagent catalog or touches the Job registry.
      if (options.isCleanedUp() || activeTaskBrowserMode === undefined) return
      activeTaskBrowser?.setItems(taskPanelItemsWithAttention(taskBrowserRows, activeTaskBrowserMode))
    },
    disposeJobEvents() {
      jobsEventsDispose?.()
      jobsEventsDispose = undefined
    },
    disposeJobObservation() {
      // Release the selected-Job follow stream explicitly: TuiApp.dispose()
      // does not invoke the viewer's onClose, so the observer would otherwise
      // outlive the surface.
      activeJobViewerClose?.()
      activeJobViewerClose = undefined
    },
    disposeTaskBrowser() {
      // TuiApp.dispose() hides overlays without invoking their user cancel
      // callbacks. Drop the browser handle and invalidate the token so an
      // action already waiting on Direct/Host work cannot notify or repaint
      // the dead surface after teardown.
      activeTaskBrowser = undefined
      activeTaskBrowserToken = undefined
      activeTaskBrowserMode = undefined
    },
  }
}
