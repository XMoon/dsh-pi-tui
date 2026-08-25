/**
 * Task-browser row model — the merged view over the two background surfaces.
 *
 * Source A — the jobs registry (`ctx.jobs`): bash jobs and one-shot
 * subagent jobs. A job row is STATUS-ONLY:
 *  - a bash job's output has a single read cursor owned by the model's
 *    `job_output`; consuming it from the UI would swallow the main
 *    session's result;
 *  - a one-shot subagent job record carries no child session id, so it can
 *    never be matched to its child transcript — label/order/time are never
 *    identity (see subagentJobTranscriptId).
 *
 * Source B — the subagent registry (`ctx.subagents.listDescendants`):
 * the durable child tree. Every row — continuable AND one-shot, running
 * AND inactive — is a viewable row: the catalog `activity` is live-store
 * PRESENCE, never an outcome, and a finished one-shot child stays
 * reachable through its persisted transcript (plan §6.4). Rows keep the
 * DSH stable pre-order VERBATIM (plan §6.5): the tree structure comes
 * from `parentId` + `depth`, so no running-first re-sort may ever break
 * the lineage.
 *
 * Runtime activity is NOT a catalog fact: the UI projects each child's
 * `running` / `inactive` word from the Agent registry at COMMIT time
 * (`ctx.agents.get(id)?.status === 'running'` — see
 * {@link projectSubagentActivity}). The catalog's store-presence
 * `activity` must never reach a row or the badge as the execution state:
 * an idle continuable child stays live in the session store and would
 * otherwise read as `running` forever.
 *
 * Deliberate overlap: a running BACKGROUND one-shot has BOTH a job record
 * and a child record with no cross-reference, so it may appear twice — the
 * job row (status-only) and the child row (transcript viewable). Dedup is
 * impossible without the missing childSessionId on the job record; the
 * viewable child row is strictly more useful, so the overlap is accepted.
 *
 * Pure and injectable so row typing, ordering, tree prefixes, and
 * descriptions are unit-testable without any dsh service.
 * @module @xmoon76/dsh-pi-tui/tasks-browser
 */

/** Picker-value prefix for a subagent row. */
export const AGENT_ROW_PREFIX = 'agent:'
/** Picker-value prefix for a job row. */
export const JOB_ROW_PREFIX = 'job:'
/** Picker group label for continuable subagents. */
export const SUBAGENT_GROUP = 'subagents'
/** Picker group label for jobs. */
export const JOB_GROUP = 'jobs'

/** Structural job input (a projection of dsh's JobSnapshot). */
export interface TaskBrowserJobInput {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Structural subagent-list entry (a projection of dsh's
 * SubagentDescendantListEntry). parentId/depth are the CATALOG'S OWN
 * facts (plan §6.3) — never guessed from labels or order. The `activity`
 * field may carry the catalog's store-presence value on INPUT, but the
 * caller MUST overwrite it with the live Agent-registry projection before
 * the entry becomes a row (see {@link projectSubagentActivity}) — a row's
 * `running`/`inactive` means "an Agent driver is executing right now". */
export interface TaskBrowserAgentInput {
  readonly kind: 'child' | 'diagnostic'
  readonly id: string
  /** Absent for a one-shot child; continuable children always carry one. */
  readonly label?: string
  readonly mode?: 'one-shot' | 'continuable'
  /** UI-PROJECTED runtime activity of the child's Agent driver
   * (`running` = the registry reports `status === 'running'` right now;
   * `inactive` = no live driver — idle, cold, or disposed, never
   * completed/failed/terminal). Never interpret the catalog's
   * store-presence value as execution state. */
  readonly activity?: 'running' | 'inactive'
  readonly hasChildren?: boolean
  /** Durable direct parent (descendant rows; absent for direct children
   * of the requested root — the root is then the implicit parent). */
  readonly parentId?: string
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth?: number
  /** Diagnostic rows carry the fold reason instead of identity facts. */
  readonly reason?: 'corrupt' | 'unsupported' | 'unavailable'
}

/** One task-browser row. The value is the picker row id. */
export type TaskBrowserRow =
  | {
      readonly kind: 'job'
      readonly value: string
      readonly jobId: string
      readonly jobKind: string
      readonly label: string
      readonly status: string
      readonly detail?: string
      readonly startedAt: number
      readonly finishedAt?: number
    }
  | {
      readonly kind: 'subagent'
      readonly value: string
      readonly childId: string
      readonly label: string
      /** The catalog's classification — NEVER derived from activity: a
       * running child is not necessarily continuable and an inactive one
       * is not necessarily one-shot. The viewer's interactivity and the
       * follow-up write path both key off this exact field. */
      readonly mode: 'one-shot' | 'continuable'
      /** UI-PROJECTED runtime activity (see {@link projectSubagentActivity}):
       * `running` = the child's Agent driver is executing right now;
       * `inactive` = no live driver (idle/cold/disposed) — never
       * completed/failed. The catalog's store-presence value never
       * reaches a row. */
      readonly activity: 'running' | 'inactive'
      readonly hasChildren: boolean
      /** Durable direct parent ('' for a direct child — the browser's
       * root is the implicit parent). */
      readonly parentId: string
      /** Edge distance from the requested root; direct children are 1. */
      readonly depth: number
    }

const isActiveJob = (status: string): boolean => status === 'running' || status === 'stopping'

/** Whether a job status is ACTIVE (running/stopping) — the preferred-row
 * rule's job half (plan §6.6). */
export function isActiveJobStatus(status: string): boolean {
  return isActiveJob(status)
}

/**
 * Build the merged browser rows.
 *
 * SUBAGENT rows keep the catalog's stable pre-order VERBATIM (plan §6.5):
 * the descendant listing IS the tree, so rows are NEVER re-sorted by
 * activity — a running grandchild must not jump above its inactive
 * parent. Every healthy child (kind 'child' with a classified mode) is a
 * row: the finished one-shot filter is REMOVED (plan §6.4), because the
 * projected activity is runtime-only, never an outcome — a settled
 * one-shot's persisted transcript stays viewable.
 *
 * JOB rows keep their own registry ordering (active by startedAt,
 * terminal newest-finish first) as a separate flat group after the tree —
 * job status is never fused into subagent lineage (plan §2.2).
 */
export function buildTaskRows(
  jobs: readonly TaskBrowserJobInput[],
  agents: readonly TaskBrowserAgentInput[],
): TaskBrowserRow[] {
  // Child rows: every healthy classified child — continuable AND one-shot,
  // running AND inactive (a settled one-shot's persisted transcript is
  // still viewable, plan §6.3). The filter is a TYPE GUARD on mode: a
  // catalog entry whose mode is missing is NOT treated as a healthy
  // interactive child — it is dropped like a diagnostic (never silently
  // defaulted to continuable).
  type AgentRow = Extract<TaskBrowserRow, { kind: 'subagent' }>
  const agentRows: AgentRow[] = agents
    .filter((agent): agent is TaskBrowserAgentInput & { mode: 'one-shot' | 'continuable' } =>
      agent.kind === 'child' && (
        agent.mode === 'continuable' || agent.mode === 'one-shot'
      ))
    .map(agent => ({
      kind: 'subagent' as const,
      value: `${AGENT_ROW_PREFIX}${agent.id}`,
      childId: agent.id,
      label: agent.label ?? agent.id,
      mode: agent.mode,
      activity: agent.activity ?? 'inactive',
      hasChildren: agent.hasChildren ?? false,
      parentId: agent.parentId ?? '',
      depth: agent.depth ?? 1,
    }))
  // The tree order is the catalog order: no running-first re-sort.
  const sortedJobs = [...jobs].sort((a, b) => {
    const aTerminal = !isActiveJob(a.status)
    const bTerminal = !isActiveJob(b.status)
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1
    if (!aTerminal) return a.startedAt - b.startedAt
    return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)
  }).map(job => ({
    kind: 'job' as const,
    value: `${JOB_ROW_PREFIX}${job.id}`,
    jobId: job.id,
    jobKind: job.kind,
    label: job.label,
    status: job.status,
    detail: job.detail,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }))
  return [...agentRows, ...sortedJobs]
}

/**
 * Project the UI runtime activity of one descendant catalog onto its
 * entries: a child's `activity` is overwritten from the live Agent
 * registry (`agentStatusOf(id) === 'running'`), read AT COMMIT TIME —
 * never captured when the (async) listing started. A slow catalog
 * response must not flip an already-idle child back to `running` with
 * the store-presence status it captured earlier (plan §7.3).
 *
 * EVERYTHING else is untouched: id/label/mode/hasChildren/parentId/depth
 * and the pre-order all stay catalog facts (plan §7.5). Diagnostic rows
 * pass through unchanged.
 */
export function projectSubagentActivity(
  entries: readonly TaskBrowserAgentInput[],
  agentStatusOf: (childId: string) => string | undefined,
): TaskBrowserAgentInput[] {
  return entries.map(entry =>
    entry.kind === 'child'
      ? { ...entry, activity: agentStatusOf(entry.id) === 'running' ? 'running' : 'inactive' }
      : entry)
}

/** Whether a subagent row can be interrupted RIGHT NOW: only a
 * continuable child with a LIVE running driver — an idle/inactive
 * continuable has no driver to stop, so the UI must not advertise (or
 * fire) the stop verb for it. One-shot rows are never interruptible (the
 * interrupt transport is an accepted no-op for them). */
export function isSubagentRowInterruptible(
  row: Extract<TaskBrowserRow, { kind: 'subagent' }>,
): boolean {
  return row.mode === 'continuable' && row.activity === 'running'
}

/**
 * The tree connector prefix for one subagent row: indentation by depth
 * (the browser's root is depth 1) plus a stable `├─ ` branch connector.
 * The connector is a fixed layout region (plan §6.7) — it never scrolls
 * with the selected label (M4 marquee) and never carries label text, so
 * the marquee's moving window starts after it.
 */
export function taskTreePrefix(depth: number): string {
  const safe = Math.max(1, Math.floor(depth))
  return `${'  '.repeat(safe - 1)}├─ `
}

/** The one-line picker label for a row. The subagent label CARRIES the
 * mode as its final segment (never inferred from running/inactive): the
 * user must know before entering a viewer whether it is interactive. A
 * JOB row whose kind is `subagent` is the jobs registry's reliable
 * contract for a background ONE-SHOT subagent job (continuable children
 * never register jobs), so it carries `one-shot` too; any other job kind
 * keeps its own semantics (no fabricated mode). */
export function taskRowLabel(row: TaskBrowserRow): string {
  if (row.kind === 'job') {
    return row.jobKind === 'subagent'
      ? `subagent job · ${row.label} · one-shot`
      : `${row.jobKind} · ${row.label}`
  }
  return `subagent · ${row.label} · ${row.mode}`
}

/** The picker group a row belongs to. */
export function rowGroup(row: TaskBrowserRow): string {
  return row.kind === 'job' ? JOB_GROUP : SUBAGENT_GROUP
}

/** The picker description line for a row. The subagent line carries the
 * PROJECTED runtime activity only — `has children` is deliberately NOT
 * shown: the tree connector already expresses parenthood, so the text
 * would duplicate the structure (the `hasChildren` data fact stays on
 * the row for future fold/disclosure work). */
export function describeTaskRow(row: TaskBrowserRow, now: number): string {
  if (row.kind === 'job') {
    const elapsed = Math.max(0, Math.floor((now - row.startedAt) / 1000))
    return `${row.status}${row.detail === undefined ? '' : ` — ${row.detail}`} · ${elapsed}s`
  }
  return `${row.activity}${row.depth > 1 ? ` · depth ${row.depth}` : ''}`
}

/** The viewer's interaction authority for one row (plan §6.10): mode is
 * the DURABLE semantic, access is the CURRENT surface authority. A direct
 * (depth 1) continuable child is interactive from the root; every other
 * row is read-only from this surface — nested descendants belong to their
 * exact parent, never to the root (plan §2.4). */
export type ViewerAccess =
  | 'interactive-direct-child'
  | 'readonly-one-shot'
  | 'readonly-nested'

/** Classify a subagent row's viewer authority from the row's own facts
 * (mode + depth — never activity). */
export function viewerAccessOf(row: Extract<TaskBrowserRow, { kind: 'subagent' }>): ViewerAccess {
  if (row.depth > 1) return 'readonly-nested'
  if (row.mode === 'one-shot') return 'readonly-one-shot'
  return 'interactive-direct-child'
}

/** Resolve a viewer target's authority, deriving the DEFAULT from the
 * mode when the caller did not pass one (a plain depth-1 viewer): a
 * continuable child is interactive, a one-shot child is read-only. A
 * caller that KNOWS the row is nested passes `readonly-nested` explicitly
 * (the mode alone cannot express it). */
export function resolveViewerAccess(
  mode: 'one-shot' | 'continuable',
  access: ViewerAccess | undefined,
): ViewerAccess {
  if (access !== undefined) return access
  return mode === 'continuable' ? 'interactive-direct-child' : 'readonly-one-shot'
}

/** Whether an access permits drafting a follow-up to the child (only the
 * interactive direct child does, plan §6.10). */
export function isViewerAccessInteractive(access: ViewerAccess): boolean {
  return access === 'interactive-direct-child'
}

/** The viewer header hint for one access (plan §6.10: the UI shows the
 * REAL mode and states the surface authority explicitly — a nested
 * continuable child is never relabeled one-shot to borrow read-only
 * logic, and a nested ONE-SHOT child keeps its own mode too). MODE is
 * the durable semantic, ACCESS the surface authority — the hint must
 * render BOTH truthfully, so it takes the mode alongside the access: a
 * nested one-shot row reads `one-shot · nested · read-only from this
 * parent`, never `continuable · …` (review P2). */
export function viewerAccessHint(mode: 'one-shot' | 'continuable', access: ViewerAccess): string {
  switch (access) {
    case 'interactive-direct-child': return 'continuable · interactive'
    case 'readonly-one-shot': return 'one-shot · read-only'
    case 'readonly-nested': return `${mode} · nested · read-only from this parent`
  }
}

/** The interrupt authority for one subagent row (review P1): DSH's
 * `{ kind: 'user', parentSessionId }` contract requires the child's
 * DURABLE DIRECT parent — a deep descendant passed with the main session
 * id is rejected as unauthorized. The row's own parentId is the durable
 * address the tree already carries; a direct child (no parentId) falls
 * back to the browser root (the live main session). */
export function subagentInterruptParent(
  row: Extract<TaskBrowserRow, { kind: 'subagent' }>,
  rootSessionId: string,
): string {
  return row.parentId !== '' ? row.parentId : rootSessionId
}
