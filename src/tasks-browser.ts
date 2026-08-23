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
 * Source B — the subagent registry (`ctx.subagents.listChildren`):
 * live child subagents. Continuable children are separate durable
 * conversations that deliver no result to the parent, so Enter may open
 * the read-only transcript viewer directly. A RUNNING one-shot child
 * (the parent's pending foreground tool call, which registers no job
 * record) is merged the same way, so the ↓ trigger stays armed while a
 * foreground delegation is in flight. A finished one-shot child is not
 * merged — its work is over and `/subagents` remains its surface.
 *
 * Deliberate overlap: a running BACKGROUND one-shot has BOTH a job record
 * and a child record with no cross-reference, so it may appear twice — the
 * job row (status-only) and the child row (transcript viewable). Dedup is
 * impossible without the missing childSessionId on the job record; the
 * viewable child row is strictly more useful, so the overlap is accepted.
 *
 * Pure and injectable so row typing, ordering, and descriptions are
 * unit-testable without any dsh service.
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

/** Structural subagent-list entry (a projection of SubagentListEntry). */
export interface TaskBrowserAgentInput {
  readonly kind: 'child' | 'diagnostic'
  readonly id: string
  /** Absent for a one-shot child; continuable children always carry one. */
  readonly label?: string
  readonly mode?: 'one-shot' | 'continuable'
  /** Absent on diagnostic rows. */
  readonly activity?: 'running' | 'inactive'
  readonly hasChildren?: boolean
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
      readonly activity: 'running' | 'inactive'
      readonly hasChildren: boolean
    }

const isActiveJob = (status: string): boolean => status === 'running' || status === 'stopping'

/**
 * Ordering shared with kimi's tasks browser: active rows first, terminal
 * rows last. Jobs keep their registry order within each class (active by
 * startedAt, terminal newest-finish first); subagents keep the registry's
 * createdAt order (running before inactive).
 */
export function buildTaskRows(
  jobs: readonly TaskBrowserJobInput[],
  agents: readonly TaskBrowserAgentInput[],
): TaskBrowserRow[] {
  // Child rows: every continuable child (resumable conversations stay
  // reachable) plus RUNNING one-shot children (the parent's pending
  // foreground tool call). Finished one-shot children and diagnostics
  // stay out — their surface is /subagents. The filter is a TYPE GUARD on
  // mode: a catalog entry whose mode is missing is NOT treated as a
  // healthy interactive child — it is dropped like a diagnostic (never
  // silently defaulted to continuable).
  type AgentRow = Extract<TaskBrowserRow, { kind: 'subagent' }>
  const agentRows: AgentRow[] = agents
    .filter((agent): agent is TaskBrowserAgentInput & { mode: 'one-shot' | 'continuable' } =>
      agent.kind === 'child' && (
        agent.mode === 'continuable' || (agent.mode === 'one-shot' && agent.activity === 'running')
      ))
    .map(agent => ({
      kind: 'subagent' as const,
      value: `${AGENT_ROW_PREFIX}${agent.id}`,
      childId: agent.id,
      label: agent.label ?? agent.id,
      mode: agent.mode,
      activity: agent.activity ?? 'inactive',
      hasChildren: agent.hasChildren ?? false,
    }))
  const sortedAgents: TaskBrowserRow[] = [...agentRows].sort((a, b) => {
    if (a.activity !== b.activity) return a.activity === 'running' ? -1 : 1
    return 0
  })
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
  return [...sortedAgents, ...sortedJobs]
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

/** The picker description line for a row. */
export function describeTaskRow(row: TaskBrowserRow, now: number): string {
  if (row.kind === 'job') {
    const elapsed = Math.max(0, Math.floor((now - row.startedAt) / 1000))
    return `${row.status}${row.detail === undefined ? '' : ` — ${row.detail}`} · ${elapsed}s`
  }
  return `${row.activity}${row.hasChildren ? ' · has children' : ''}`
}
