/**
 * Workflow run presentation projection (PR2 plan §6): the pure, bounded
 * presentation of one `TranscriptWorkflowMessage` for the TUI transcript.
 *
 * The durable lifecycle model lives in `transcript.ts` (PR1) and is NEVER
 * touched here: this module only derives counts, phase groups, aggregate
 * statuses and the adaptive inline/summary mode from the member rows. No
 * TUI component, no session service, no Task Browser, no mutation, no
 * cache — the renderer feeds the projection and renders what it returns.
 *
 * The adaptive rule (plan §5): a phase with `<= WORKFLOW_INLINE_MEMBER_LIMIT`
 * members renders every member inline; a larger phase renders aggregate
 * counts + a capped abnormal preview + a scoped Task Viewer entry, so a
 * 100+ agent run never grows the transcript linearly.
 * @module @xmoon76/dsh-pi-tui/workflow-presentation
 */

import {
  workflowPhaseKey,
  workflowReadablePhase,
  type WorkflowMemberView,
  type WorkflowRunStatus,
} from './transcript.ts'

/** A phase with at most this many members renders every member inline. */
export const WORKFLOW_INLINE_MEMBER_LIMIT = 5

/** A large phase previews at most this many abnormal (failed / cancelled /
 * interrupted) members, in durable `seq` order. */
export const WORKFLOW_ANOMALY_PREVIEW_LIMIT = 3

/** Exact per-status member counts of one run or phase. */
export interface WorkflowStatusCounts {
  running: number
  completed: number
  failed: number
  cancelled: number
  interrupted: number
}

/** The adaptive presentation of ONE phase group. */
export interface WorkflowPhasePresentation {
  /** The collision-free phase identity key (`workflowPhaseKey`). */
  key: string
  /** The exact durable phase identity (`null` and `''` stay distinct). */
  phase: string | null
  /** The human-readable phase label (`Unassigned` / `Empty` / the raw name). */
  label: string
  /** The phase's member rows in durable `seq` / arrival order. */
  members: readonly WorkflowMemberView[]
  counts: WorkflowStatusCounts
  /** The visual summary precedence of the phase's members. */
  aggregateStatus: WorkflowRunStatus
  /** `inline` = every member renders; `summary` = aggregate + preview. */
  mode: 'inline' | 'summary'
  /** The capped abnormal preview (large phases only; `seq` order). */
  anomalyPreview: readonly WorkflowMemberView[]
  /** Abnormal members beyond the preview cap (large phases only). */
  hiddenAnomalyCount: number
}

/** Exact status counts of one member list. */
export function workflowStatusCounts(members: readonly WorkflowMemberView[]): WorkflowStatusCounts {
  const counts: WorkflowStatusCounts = { running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 }
  for (const member of members) {
    counts[member.status] += 1
  }
  return counts
}

/** The deterministic visual summary precedence of a member list (plan §6.1):
 * `failed > interrupted > cancelled > running > completed`. Presentation
 * only — the exact counts are always preserved; no durable phase status is
 * ever written back. */
export function workflowAggregateStatus(members: readonly WorkflowMemberView[]): WorkflowRunStatus {
  const counts = workflowStatusCounts(members)
  if (counts.failed > 0) return 'failed'
  if (counts.interrupted > 0) return 'interrupted'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.running > 0) return 'running'
  return 'completed'
}

/** The adaptive phase presentations of one run's member rows, grouped by
 * exact phase identity and ordered by first appearance (durable arrival
 * order). A phase with `<= 5` members is `inline`; a larger phase is
 * `summary` with a capped abnormal preview — never a dynamic running
 * top-N (plan §5.3: 100 concurrent settles must not jitter the rows). */
export function workflowPhasePresentations(
  members: readonly WorkflowMemberView[],
): WorkflowPhasePresentation[] {
  const groups = new Map<string, WorkflowMemberView[]>()
  for (const member of members) {
    const key = workflowPhaseKey(member.phase)
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [member])
    else list.push(member)
  }
  const presentations: WorkflowPhasePresentation[] = []
  for (const [key, phaseMembers] of groups) {
    const phase = phaseMembers[0]?.phase ?? null
    const counts = workflowStatusCounts(phaseMembers)
    const mode = phaseMembers.length > WORKFLOW_INLINE_MEMBER_LIMIT ? 'summary' : 'inline'
    const abnormal = phaseMembers.filter(member =>
      member.status === 'failed' || member.status === 'cancelled' || member.status === 'interrupted')
    presentations.push({
      key,
      phase,
      label: workflowReadablePhase(phase),
      members: phaseMembers,
      counts,
      aggregateStatus: workflowAggregateStatus(phaseMembers),
      mode,
      anomalyPreview: mode === 'summary' ? abnormal.slice(0, WORKFLOW_ANOMALY_PREVIEW_LIMIT) : [],
      hiddenAnomalyCount: mode === 'summary' ? Math.max(0, abnormal.length - WORKFLOW_ANOMALY_PREVIEW_LIMIT) : 0,
    })
  }
  return presentations
}

/** The run summary line: `N agents · running · completed · failed ·
 * cancelled · interrupted`, only non-zero counts, stable order (plan §5.4).
 * Empty when the run has no members. */
export function workflowRunSummaryText(counts: WorkflowStatusCounts): string {
  const total = counts.running + counts.completed + counts.failed + counts.cancelled + counts.interrupted
  if (total === 0) return ''
  const parts = [`${total} agent${total === 1 ? '' : 's'}`]
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.completed > 0) parts.push(`${counts.completed} completed`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.interrupted > 0) parts.push(`${counts.interrupted} interrupted`)
  return parts.join(' · ')
}

/** The phase aggregate line: `running · completed · failed · cancelled ·
 * interrupted`, only non-zero counts, stable order (plan §5.4). */
export function workflowCountsText(counts: WorkflowStatusCounts): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.completed > 0) parts.push(`${counts.completed} completed`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.interrupted > 0) parts.push(`${counts.interrupted} interrupted`)
  return parts.join(' · ')
}

/** Whether a run-level `View all N agents` entry is useful (plan §5.5):
 * a run with `<= 5` agents needs no entry, and a single phase group's own
 * `View N agents` already covers the whole run — the run-level entry only
 * appears when the run spans at least two phase groups. */
export function workflowRunViewAllVisible(totalAgents: number, phaseGroupCount: number): boolean {
  return totalAgents > WORKFLOW_INLINE_MEMBER_LIMIT && phaseGroupCount >= 2
}
