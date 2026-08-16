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
 * continuable children. These are separate durable conversations that
 * deliver no result to the parent, so Enter may open the read-only
 * transcript viewer directly.
 *
 * One-shot children are deliberately NOT merged: a background one-shot has
 * both a job record and a child record with no cross-reference (listing
 * both would double rows with no safe dedup), and a foreground one-shot is
 * the parent's pending tool call, not a background task. `/subagents`
 * remains their surface.
 *
 * Pure and injectable so row typing, ordering, and descriptions are
 * unit-testable without any dsh service.
 * @module @xmoon76/dsh-pi-tui/tasks-browser
 */

/** Picker-value prefix for a continuable-subagent row. */
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
      readonly kind: 'continuable-subagent'
      readonly value: string
      readonly childId: string
      readonly label: string
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
  // Only continuable children become rows; one-shot children and
  // diagnostics stay out (their surface is /subagents).
  type AgentRow = Extract<TaskBrowserRow, { kind: 'continuable-subagent' }>
  const agentRows: AgentRow[] = agents
    .filter(agent => agent.kind === 'child' && agent.mode === 'continuable')
    .map(agent => ({
      kind: 'continuable-subagent' as const,
      value: `${AGENT_ROW_PREFIX}${agent.id}`,
      childId: agent.id,
      label: agent.label ?? agent.id,
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

/** The one-line picker label for a row. */
export function taskRowLabel(row: TaskBrowserRow): string {
  if (row.kind === 'job') return `${row.jobKind} · ${row.label}`
  return `subagent · ${row.label}`
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
