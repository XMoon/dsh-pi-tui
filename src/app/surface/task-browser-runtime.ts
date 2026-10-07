/**
 * Task-browser runtime refresh coordinator — the single owner of the
 * SUBAGENT half of the task browser / dock badge after a catalog listing
 * lands, and the split between catalog refreshes and runtime-only
 * refreshes:
 *
 * - CATALOG refresh (`refreshCatalog`): run the selected Task semantic read
 *   (the full descendant tree + the root Job roster). This is the ONLY path
 *   that changes membership / tree / mode — driven by the selected backend's
 *   invalidation sources (Direct: subagent lifecycle events, tool calls, Job
 *   membership; Remote: the official Client observable sources). The listing
 *   is async and may read persistence on Direct.
 * - RUNTIME refresh (`refreshRuntime`): NO listing — reuse the cached
 *   catalog and re-project every child's `running` / `inactive` and the Job
 *   roster from the selected source's live reads.
 *
 * Stale-response protection (plan §7.3): runtime statuses are projected
 * AT COMMIT TIME — a slow catalog response can never flip an already-
 * idle child back to `running` with the value it captured earlier. The
 * session fence is a key captured when a refresh starts and re-checked
 * after the async listing: a session switch mid-flight never commits an
 * old session's catalog onto the new surface.
 *
 * The coordinator never imports the runner or the app; every dependency
 * arrives as an injected hook, and the Task dataset itself arrives through
 * the shared semantic read port (never a Host service type).
 * @module @xmoon76/dsh-pi-tui/app/surface/task-browser-runtime
 */

import type {
  TaskReadSnapshot,
  TaskSubagentEntry,
} from '../../runtime/task-read-port.ts'
import {
  buildTaskRows,
  isActiveJobStatus,
  projectSubagentActivity,
  type TaskBrowserJobInput,
  type TaskBrowserRow,
} from '../../domain/task/browser.ts'

/** The separate job/agent counts and unacknowledged failure attention. */
export interface TaskBrowserSummary {
  readonly runningAgents: number
  readonly totalAgents: number
  readonly runningJobs: number
  readonly totalJobs: number
  readonly failedAttention: number
  readonly failedTotal: number
}

/** The generic dataset scope of the OPEN task browser (PR2 plan §10.2):
 * `all` is the ordinary Task Center; `subagents` restricts the browser to
 * an EXACT child-id set (a Workflow phase/run scope). The scope is generic
 * — the Task Browser never knows what a Workflow is, and the Workflow
 * presentation never reaches into the browser's runtime. */
export type TaskBrowserDatasetScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'subagents'; readonly childIds: readonly string[] }

/** The runtime hooks the coordinator drives (wired by the runner). */
export interface TaskBrowserRuntimeHooks {
  /** Session-identity key of the CURRENT live root (undefined = no live
   * session). Captured when a refresh starts and re-checked after the
   * async listing: a session switch mid-flight must never commit an old
   * session's catalog onto the new surface. */
  currentKey(): string | undefined
  /** Run the selected Task semantic read (full descendant tree + root Job
   * roster). Async; may read persistence on Direct. `undefined` = the root
   * session has no current owner (the caller clears the badge itself). */
  readTask(): Promise<TaskReadSnapshot | undefined>
  /** Read the CURRENT job roster (sync; re-read at every commit so a job
   * settlement repaints the open browser). */
  readJobs(): readonly TaskBrowserJobInput[]
  /** Current runtime activity of one child as the SELECTED backend reads it
   * (Direct: the Agent registry; Remote: the official Session list running
   * bit). MUST be read at COMMIT time — never captured when the listing
   * started. `undefined` keeps the entry's own read-time activity. */
  activityOf(childId: string): string | undefined
  /** Commit the merged rows to the OPEN task browser (no-op when closed).
   * `preferredValue` = the first running subagent in tree order, else the
   * first active job — the panel honors it only while the user has not
   * moved the selection (plan §6.6). */
  commitRows(rows: readonly TaskBrowserRow[], preferredValue?: string): void
  /** Commit the dock badge: the RUNNING children only (id + label). */
  commitBadge(running: ReadonlyArray<{ id: string; label: string }>): void
  /** Commit independent job/agent totals and failure attention. */
  commitSummary?(summary: TaskBrowserSummary): void
  /** Commit async loading/stale state for the open presentation. */
  commitRefreshState?(state: 'loading' | 'ready' | 'stale', error?: string): void
}

/** Structural type for the jobs the coordinator merges (a projection of
 * the runner's `jobs.list` snapshots). */
/**
 * The coordinator. One instance per runner session lifetime; `reset()` on
 * every session-generation bump.
 */
export class TaskBrowserRuntime {
  // Explicit fields, not constructor parameter properties (Node's
  // strip-only mode rejects `constructor(private readonly x: T)`).
  private readonly hooks: TaskBrowserRuntimeHooks
  /** The cached descendant catalog of the CURRENT root (membership/tree/
   * mode facts). Cleared on session switch via {@link reset}. */
  private catalog: TaskSubagentEntry[] = []
  /** The last committed rows (the row-identity source for the open
   * browser's select path — see {@link rows}). */
  private lastRows: TaskBrowserRow[] = []
  /** Failure ids acknowledged by opening/reading the visible Task Center. */
  private readonly acknowledgedFailures = new Set<string>()
  /** Failure ids in the previous committed job projection. */
  private previousFailureIds = new Set<string>()
  /** Monotonic catalog-request epoch: every refreshCatalog request takes
   * the next value. */
  private requestEpoch = 0
  /**
   * The refresh-state request token: the LATEST-STARTED catalog request
   * (key + epoch) owns the loading/ready/stale transitions. A superseded
   * or cross-session request never commits refresh state, so an
   * overlapping pair cannot strand the browser in loading (a global
   * in-flight counter could: the superseded request's finally would
   * decrement it and no one would ever send 'ready' — PR review P1).
   */
  private pendingKey: string | undefined = undefined
  private pendingEpoch = 0
  /** The epoch of the LAST SUCCESSFULLY COMMITTED catalog. A response
   * may commit only when its own request epoch is NOT below this — i.e.
   * "latest successfully committed wins", never "latest requested wins":
   * a FAILED newer request must not invalidate a valid older response
   * (it never advances the committed epoch), while a successful newer
   * commit still supersedes every older in-flight response. */
  private committedEpoch = 0
  /** The dataset scope of the OPEN browser (PR2 plan §10.5): applied at
   * EVERY row commit — a refresh after the scope was set must never leak
   * the global rows back into a scoped browser. Reset to `all` on close
   * (the runner) and on session switch (reset). */
  private scope: TaskBrowserDatasetScope = { kind: 'all' }

  constructor(hooks: TaskBrowserRuntimeHooks) {
    this.hooks = hooks
  }

  /** The most recently committed rows. The open browser's select path
   * reads row facts (mode/activity/parentId/depth) from HERE, so a
   * runtime refresh that repainted the panel is never contradicted by a
   * stale local snapshot. */
  rows(): readonly TaskBrowserRow[] {
    return this.lastRows
  }

  /** Whether one child id is a member of the cached catalog. The
   * runner's `agent/status` gate: only status flips of known descendants
   * may refresh the surface — the MAIN agent's own per-turn flips (and
   * any stale post-switch event) never repaint. */
  has(childId: string): boolean {
    return this.catalog.some(entry => entry.id === childId)
  }

  /** Set the dataset scope of the OPEN browser and re-commit the cached
   * rows through it (PR2 plan §10.5/§10.8): the scope applies at EVERY
   * commit, so a later refresh/status update can never leak global rows
   * into a scoped browser. The runner resets to `all` when the browser
   * closes. */
  setScope(scope: TaskBrowserDatasetScope): void {
    this.scope = scope
    this.apply()
  }

  /** A CATALOG refresh: run the Task semantic read, then — if the session
   * key is still current AND this request is not superseded — cache and
   * commit. Runtime statuses are re-read through the selected source AT
   * COMMIT, so a stale catalog response can never flip an already-idle
   * child back to `running` (plan §7.3). The epoch orders OVERLAPPING
   * refreshes of the same session from overlapping direct/future callers
   * (the production surface's catalog gate is single-flight, so it no
   * longer creates such an overlap itself): only the LATEST
   * SUCCESSFULLY COMMITTED response wins — an older success response
   * never overwrites a newer committed membership/tree catalog, and a
   * FAILED newer request never invalidates a valid older response. No
   * live session: no-op (the runner clears the badge itself). */
  async refreshCatalog(): Promise<void> {
    const key = this.hooks.currentKey()
    if (key === undefined) return
    const epoch = ++this.requestEpoch
    // This request takes over the refresh-state token: any older in-flight
    // request becomes state-silent (it may still commit rows if its epoch
    // is not superseded, but only the token holder ends loading).
    this.pendingKey = key
    this.pendingEpoch = epoch
    this.hooks.commitRefreshState?.('loading')
    let snapshot: TaskReadSnapshot | undefined
    try {
      snapshot = await this.hooks.readTask()
    } catch (error) {
      // A stale session's failure must not overwrite the new session's
      // state, and a superseded failure must not clear a newer token.
      if (this.hooks.currentKey() === key && this.pendingKey === key && this.pendingEpoch === epoch) {
        const message = error instanceof Error ? error.message : 'Task catalog refresh failed'
        this.hooks.commitRefreshState?.('stale', message)
        this.pendingKey = undefined
        this.pendingEpoch = 0
      }
      throw error
    }
    if (this.hooks.currentKey() !== key) {
      // Cross-session: the new session's own requests own refresh state.
      return
    }
    if (snapshot === undefined) {
      // The root session lost its owner mid-read: a superseded read commits
      // nothing (the caller's generation fence owns the surface).
      return
    }
    if (epoch < this.committedEpoch) {
      // Superseded by a newer successful commit; that request owns the
      // token and will end the loading state.
      return
    }
    this.committedEpoch = epoch
    this.catalog = [...snapshot.descendants]
    this.apply()
    if (this.pendingKey === key && this.pendingEpoch === epoch) {
      this.hooks.commitRefreshState?.('ready')
      this.pendingKey = undefined
      this.pendingEpoch = 0
    }
  }

  /** A RUNTIME-only refresh: NO descendant reading — reuse the cached
   * catalog and re-project every child's activity (and the Job roster)
   * from the selected source's live reads. Membership/tree/mode/labels/
   * pre-order never change here; only the status words move (plan §7.5).
   * Synchronous, so the session key is captured and consumed atomically. */
  refreshRuntime(): void {
    if (this.hooks.currentKey() === undefined) return
    // Rows only — never a 'ready' commit: this runs on idle/status events
    // and must not clear a "Refresh failed · R retry" stale notice (only a
    // successful CATALOG listing, or the rows replacing an empty loading
    // frame, is allowed to clear async state).
    // The coordinator reads the LIVE roster through its own session-fenced
    // hook on EVERY commit (never a catalog snapshot promoted to "current"):
    // the surface owner retains the last good roster across a transient read
    // failure, which the semantic read's own snapshot cannot do.
    this.apply()
  }

  /** Drop the cached catalog (session switch): the next catalog refresh
   * re-reads from the new root, and stale-session status flips find no
   * membership. Every in-flight request is invalidated too (the fence
   * jumps past them), so an old-session listing can never commit even
   * if its key check were somehow satisfied. The dataset scope resets to
   * `all` with it (a switched-in session must never inherit a scoped
   * browser). */
  reset(): void {
    this.committedEpoch = ++this.requestEpoch
    this.catalog = []
    this.lastRows = []
    this.acknowledgedFailures.clear()
    this.previousFailureIds = new Set()
    this.scope = { kind: 'all' }
    // Invalidates any pending refresh-state token: the old session's
    // in-flight promises are state-silent (their key check fails against
    // the new session), and the new session's requests mint a fresh token.
    this.pendingKey = undefined
    this.pendingEpoch = 0
  }

  /** Acknowledge only failure rows the current surface actually showed. */
  acknowledge(values: readonly string[]): void {
    const visible = new Set(values)
    for (const id of this.previousFailureIds) {
      if (visible.has(id)) this.acknowledgedFailures.add(id)
    }
    if (this.hooks.currentKey() !== undefined) this.apply()
  }

  private apply(): void {
    // The runtime projection happens HERE, at commit time: the selected
    // source is re-read for every child AND for the roster, so row + badge
    // statuses always reflect the CURRENT facts — never a listing snapshot.
    const projected = projectSubagentActivity(this.catalog, (childId) => this.hooks.activityOf(childId))
    const jobs = this.hooks.readJobs()
    const rawRows = buildTaskRows(jobs, projected)
    // The dataset scope (PR2 plan §10.5/§10.6): a scoped browser shows
    // EXACTLY the scope's child ids — unrelated subagents and every job
    // row are excluded, on EVERY commit (never just the first frame).
    // The scope filters ONLY the visible rows: the failure-attention
    // ledger and the summary stay GLOBAL, so opening and closing a scoped
    // viewer never re-arms previously acknowledged unrelated failures
    // (review finding).
    const scope = this.scope
    const scopedRows = scope.kind === 'all'
      ? rawRows
      : rawRows.filter(row => row.kind === 'subagent' && scope.childIds.includes(row.childId))
    const currentFailureIds = new Set(rawRows
      .filter(row => row.kind === 'job' && (row.status === 'failed' || row.status === 'timed_out' || row.status === 'lost'))
      .map(row => row.value))
    for (const id of this.previousFailureIds) {
      if (!currentFailureIds.has(id)) this.acknowledgedFailures.delete(id)
    }
    // A row that transitions into failure is a new attention event even if
    // the registry reused its stable job id.
    for (const id of currentFailureIds) {
      if (!this.previousFailureIds.has(id)) this.acknowledgedFailures.delete(id)
    }
    this.previousFailureIds = currentFailureIds
    const attentionIds = new Set([...currentFailureIds].filter(id => !this.acknowledgedFailures.has(id)))
    const rows = scopedRows.map(row => row.kind === 'job'
      ? { ...row, attention: attentionIds.has(row.value) }
      : row)
    this.lastRows = rows
    // Preferred cursor (plan §6.6): the first RUNNING subagent in tree
    // order, else the first active job — the tree itself never re-sorts
    // for the cursor (the panel honors it only while the selection is
    // untouched).
    const preferred = rows.find(row => row.kind === 'subagent' && row.activity === 'running')?.value
      ?? rows.find(row => row.kind === 'job' && isActiveJobStatus(row.status))?.value
    this.hooks.commitRows(rows, preferred)
    const runningAgents = projected.filter(entry => entry.kind === 'child' && entry.activity === 'running')
    const totalAgents = projected.filter(entry => entry.kind === 'child').length
    const summary: TaskBrowserSummary = {
      runningAgents: runningAgents.length,
      totalAgents,
      runningJobs: jobs.filter(job => isActiveJobStatus(job.status)).length,
      totalJobs: jobs.length,
      failedAttention: attentionIds.size,
      failedTotal: currentFailureIds.size,
    }
    this.hooks.commitSummary?.(summary)
    // The badge counts the PROJECTED running children (the registry
    // projection, never the catalog's store-presence activity): an idle
    // continuable child must not keep the badge permanently armed.
    this.hooks.commitBadge(runningAgents
      .map(entry => ({ id: entry.id, label: entry.label ?? entry.id })))
  }
}
