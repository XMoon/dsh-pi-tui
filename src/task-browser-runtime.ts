/**
 * Task-browser runtime refresh coordinator — the single owner of the
 * SUBAGENT half of the task browser / dock badge after a catalog listing
 * lands, and the split between catalog refreshes and runtime-only
 * refreshes:
 *
 * - CATALOG refresh (`refreshCatalog`): re-list the durable descendant
 *   tree (`ctx.subagents.listDescendants`). This is the ONLY path that
 *   changes membership / tree / mode — driven by subagent lifecycle
 *   events (start/end), the subagent tool call in the live session, and
 *   jobs changes (a one-shot settlement implies membership may have
 *   moved). The listing is async and may read persistence.
 * - RUNTIME refresh (`refreshRuntime`): NO listing — reuse the cached
 *   catalog and re-project every child's `running` / `inactive` from the
 *   Agent registry. Driven by `agent/status`: the registry status IS the
 *   live driver activity; the catalog's store-presence `activity` is
 *   never an execution state (an idle continuable child stays live in
 *   the session store and would otherwise read as `running` forever).
 *
 * Stale-response protection (plan §7.3): runtime statuses are projected
 * AT COMMIT TIME — a slow catalog response can never flip an already-
 * idle child back to `running` with the store-presence value it captured
 * earlier. The session fence is a key captured when a refresh starts and
 * re-checked after the async listing: a session switch mid-flight never
 * commits an old session's catalog onto the new surface.
 *
 * The coordinator never imports the runner or the app; every dependency
 * arrives as an injected hook.
 * @module @xmoon76/dsh-pi-tui/task-browser-runtime
 */

import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import {
  buildTaskRows,
  isActiveJobStatus,
  projectSubagentActivity,
  type TaskBrowserJobInput,
  type TaskBrowserRow,
} from './tasks-browser.ts'

/** The runtime hooks the coordinator drives (wired by the runner). */
export interface TaskBrowserRuntimeHooks {
  /** Session-identity key of the CURRENT live root (undefined = no live
   * session). Captured when a refresh starts and re-checked after the
   * async listing: a session switch mid-flight must never commit an old
   * session's catalog onto the new surface. */
  currentKey(): string | undefined
  /** Read the durable descendant catalog of the current root (async; may
   * read persistence for cold children). */
  listDescendants(): Promise<readonly SubagentDescendantListEntry[]>
  /** Read the CURRENT jobs snapshot (sync; re-read at every commit so a
   * job settlement repaints the open browser). */
  readJobs(): readonly TaskBrowserJobInput[]
  /** Live runtime status of one child (the Agent registry). MUST be read
   * at COMMIT time — never captured when the listing started. */
  agentStatusOf(childId: string): string | undefined
  /** Commit the merged rows to the OPEN task browser (no-op when closed).
   * `preferredValue` = the first running subagent in tree order, else the
   * first active job — the panel honors it only while the user has not
   * moved the selection (plan §6.6). */
  commitRows(rows: readonly TaskBrowserRow[], preferredValue?: string): void
  /** Commit the dock badge: the RUNNING children only (id + label). */
  commitBadge(running: ReadonlyArray<{ id: string; label: string }>): void
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
  private catalog: SubagentDescendantListEntry[] = []
  /** The last committed rows (the row-identity source for the open
   * browser's select path — see {@link rows}). */
  private lastRows: TaskBrowserRow[] = []
  /** Monotonic catalog-request epoch: every refreshCatalog request takes
   * the next value. */
  private requestEpoch = 0
  /** The epoch of the LAST SUCCESSFULLY COMMITTED catalog. A response
   * may commit only when its own request epoch is NOT below this — i.e.
   * "latest successfully committed wins", never "latest requested wins":
   * a FAILED newer request must not invalidate a valid older response
   * (it never advances the committed epoch), while a successful newer
   * commit still supersedes every older in-flight response. */
  private committedEpoch = 0

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

  /** A CATALOG refresh: re-list the descendants, then — if the session
   * key is still current AND this request is not superseded — cache and
   * commit. Runtime statuses are projected from the Agent registry AT
   * COMMIT, so a stale catalog response can never flip an already-idle
   * child back to `running` (plan §7.3). The epoch orders OVERLAPPING
   * refreshes of the same session (the initial listing and an
   * open-browser listing may be in flight together): only the LATEST
   * SUCCESSFULLY COMMITTED response wins — an older success response
   * never overwrites a newer committed membership/tree catalog, and a
   * FAILED newer request never invalidates a valid older response. No
   * live session: no-op (the runner clears the badge itself). */
  async refreshCatalog(): Promise<void> {
    const key = this.hooks.currentKey()
    if (key === undefined) return
    const epoch = ++this.requestEpoch
    const entries = await this.hooks.listDescendants()
    if (this.hooks.currentKey() !== key) return
    if (epoch < this.committedEpoch) return
    this.committedEpoch = epoch
    this.catalog = [...entries]
    this.apply(entries)
  }

  /** A RUNTIME-only refresh: NO descendant listing — reuse the cached
   * catalog and re-project every child's activity from the Agent
   * registry. Membership/tree/mode/labels/pre-order never change here;
   * only the status words move (plan §7.5). Synchronous, so the session
   * key is captured and consumed atomically. */
  refreshRuntime(): void {
    if (this.hooks.currentKey() === undefined) return
    this.apply(this.catalog)
  }

  /** Drop the cached catalog (session switch): the next catalog refresh
   * re-reads from the new root, and stale-session status flips find no
   * membership. Every in-flight request is invalidated too (the fence
   * jumps past them), so an old-session listing can never commit even
   * if its key check were somehow satisfied. */
  reset(): void {
    this.committedEpoch = ++this.requestEpoch
    this.catalog = []
    this.lastRows = []
  }

  private apply(entries: readonly SubagentDescendantListEntry[]): void {
    // The runtime projection happens HERE, at commit time: the registry
    // is re-read for every child, so row + badge statuses always reflect
    // the CURRENT drivers — never the listing's snapshot.
    const projected = projectSubagentActivity(entries, (childId) => this.hooks.agentStatusOf(childId))
    const rows = buildTaskRows(this.hooks.readJobs(), projected)
    this.lastRows = rows
    // Preferred cursor (plan §6.6): the first RUNNING subagent in tree
    // order, else the first active job — the tree itself never re-sorts
    // for the cursor (the panel honors it only while the selection is
    // untouched).
    const preferred = rows.find(row => row.kind === 'subagent' && row.activity === 'running')?.value
      ?? rows.find(row => row.kind === 'job' && isActiveJobStatus(row.status))?.value
    this.hooks.commitRows(rows, preferred)
    // The badge counts the PROJECTED running children (the registry
    // projection, never the catalog's store-presence activity): an idle
    // continuable child must not keep the badge permanently armed.
    this.hooks.commitBadge(projected
      .filter((entry): entry is Extract<SubagentDescendantListEntry, { kind: 'child' }> =>
        entry.kind === 'child' && entry.activity === 'running')
      .map(entry => ({ id: entry.id, label: entry.label ?? entry.id })))
  }
}
