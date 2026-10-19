/**
 * The ONE Workflow semantic projection (TS7 move from `src/transcript.ts`).
 *
 * Workflow run/member lifecycle facts are transcript semantics, never
 * renderer facts. The ONLY authority for a Workflow status is its own
 * terminal event: `tool-workflow/run-end` for the run and
 * `tool-workflow/agent-end` for a member. A run whose `run-end` has not been
 * observed is an OPEN durable record and reads `running`; Step, Turn, main
 * Agent idle and the next turn/start carry no Workflow authority and must
 * never settle (or "interrupt") a run.
 *
 * The same projection serves the visual Transcript fold AND the `/transcript`
 * Markdown export, so the two can never drift.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/workflow-projection
 */

import type { ToolWorkflowAgentStartData, ToolWorkflowRunStartData } from '@deepseek-ai/dsh-tool-workflow/types'

/** The official branded workflow run identity (agent-start/run-end
 * `runId`), derived from the direct dependency's event payload. */
export type WorkflowRunId = ToolWorkflowRunStartData['runId']

/** The official branded child-session identity (agent-start `childId`),
 * derived from the direct dependency's event payload. */
export type WorkflowChildSessionId = ToolWorkflowAgentStartData['childId']

/** The run status vocabulary of one Workflow run or member (plan §2.2).
 * `running` means "no terminal fact observed" — an open durable record,
 * NOT proof that a driver is alive. `interrupted` remains part of the
 * existing presentation vocabulary but this projection never produces it:
 * only the authoritative `agent-end` / `run-end` facts may settle a
 * Workflow status. */
export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** One member row of a workflow run card. */
export interface WorkflowMemberView {
  /** The member's durable sequence within its run (agent-start `seq`). */
  seq: number
  /** The member agent's label. */
  label: string
  /** The run phase the member ran under: `null` when the event carried no
   * phase, `''` when it carried an explicit empty phase — the two stay
   * distinct identities (plan §4.2). */
  phase: string | null
  /** The member's child session identity (agent-start `childId`), kept for
   * PR2 child-session navigation. */
  childId: WorkflowChildSessionId
  /** The member's settled state (`running` until its own agent-end). */
  status: WorkflowRunStatus
}

/** The collision-free phase identity key: `null` (absent) and `''` (explicit
 * empty) must never share a group (plan §4.2 — the renderer must stop using
 * `member.phase ?? ''` as the grouping key). */
export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

/** The human-readable phase label (Web WorkflowRunPanel parity, plan §2.4):
 * `null` (absent) and `''` (explicit empty) stay DISTINCT identities with
 * distinct readable labels — the renderer and the search corpus share this
 * single mapping so the two can never drift. */
export function workflowReadablePhase(phase: string | null): string {
  if (phase === null) return 'Unassigned'
  if (phase === '') return 'Empty'
  return phase
}

/** Strict member-outcome mapping (plan §6.3): exhaustive so a new official
 * union variant fails typecheck instead of collapsing into a generic error. */
function workflowMemberStatus(outcome: 'completed' | 'failed' | 'cancelled'): WorkflowRunStatus {
  switch (outcome) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

/** Strict run stop-reason mapping (plan §6.4): `error` becomes the
 * Transcript `failed` vocabulary (Web alpha2 parity) — never stored as
 * `error`. Exhaustive like the member mapping. */
function workflowRunStatus(stopReason: 'completed' | 'cancelled' | 'error'): WorkflowRunStatus {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
  }
}

/**
 * The shared Workflow semantic projection (plan §5/§6): ONE terminal-event
 * state machine consumed by BOTH the visual Transcript fold and the
 * `/transcript` markdown export, so the two can never drift on run/member
 * statuses. Run-start creates an open `running` record; only the matching
 * `run-end` settles the run and only the matching `(runId, seq)` `agent-end`
 * settles a member. The optional `onChange` hook fires whenever a run's
 * message mutated (member/run settlement) so the visual fold can mark its
 * search entry dirty; the export passes no hook.
 */
export class WorkflowProjection {
  /** Open records only: a run leaves this map at its authoritative run-end.
   * The transcript item itself is the durable model. */
  private readonly runs = new Map<WorkflowRunId, TranscriptWorkflowMessage>()

  private readonly onChange: ((runId: WorkflowRunId) => void) | undefined

  constructor(onChange?: (runId: WorkflowRunId) => void) {
    this.onChange = onChange
  }

  /** One run opened: create its durable message as an OPEN record. A later
   * terminal event for the same runId settles it in place. */
  onRunStart(runId: WorkflowRunId, name: string, turn: number): TranscriptWorkflowMessage {
    const message: TranscriptWorkflowMessage = {
      kind: 'workflow',
      turn,
      runId,
      name,
      status: 'running',
      members: [],
    }
    this.runs.set(runId, message)
    return message
  }

  /** One member published: fold it into the run card (Web WorkflowRunPanel
   * parity). A member is `running` from birth regardless of any Step/Turn
   * closure — only its own agent-end may settle it. The member's
   * label/phase/status entered the search corpus (PR2 plan §13.3): the
   * onChange hook marks it dirty. */
  onAgentStart(runId: WorkflowRunId, seq: number, label: string, phase: string | null, childId: WorkflowChildSessionId): void {
    const message = this.runs.get(runId)
    if (message === undefined) return
    const member: WorkflowMemberView = {
      seq,
      label,
      phase,
      childId,
      status: 'running',
    }
    // Replace the members array reference so render caches observe the live
    // append (plan §6.2 — never rely on in-place push).
    message.members = [...message.members, member]
    this.onChange?.(runId)
  }

  /** One member settled: only the started member with the matching runId +
   * seq settles (plan §6.3 — never infer a member outcome from run-end).
   * The member's status word changed in the search corpus (PR2 plan
   * §13.3): the onChange hook marks it dirty. */
  onAgentEnd(runId: WorkflowRunId, seq: number, outcome: 'completed' | 'failed' | 'cancelled'): void {
    const message = this.runs.get(runId)
    if (message === undefined) return
    const target = message.members.find(member => member.seq === seq)
    if (target === undefined) return
    const status = workflowMemberStatus(outcome)
    // Replace the settled member AND the members array reference so render
    // caches observe the live update (plan §6.2).
    message.members = message.members.map(member =>
      member === target ? { ...member, status } : member,
    )
    this.onChange?.(runId)
  }

  /** One run settled by its own `run-end`: set the terminal status, notify,
   * and drop the fold state (the message itself stays in the transcript
   * items / export). Members keep their own agent-end facts; a run outcome
   * never back-fills a member.
   * @returns the final message, or `undefined` when the run was unknown. */
  onRunEnd(runId: WorkflowRunId, stopReason: 'completed' | 'cancelled' | 'error'): TranscriptWorkflowMessage | undefined {
    const message = this.runs.get(runId)
    if (message === undefined) return undefined
    message.status = workflowRunStatus(stopReason)
    this.onChange?.(runId)
    this.runs.delete(runId)
    return message
  }

  /** Every run still active (no terminal event observed), in run-start order
   * — the export's full-log flush. These records are OPEN durable facts, not
   * proof of a live process. */
  activeRuns(): readonly TranscriptWorkflowMessage[] {
    return [...this.runs.values()]
  }
}

/**
 * One workflow run card — a durable lifecycle record, NOT a model
 * tool/call (it never enters the Focus Tool slot or the tool count). The
 * run and its members keep the full alpha.2 status vocabulary; `seq`,
 * `childId` and the exact phase identity are preserved for PR2 navigation
 * and disclosure (plan §4).
 */
export interface TranscriptWorkflowMessage {
  kind: 'workflow'
  turn: number
  /** The durable run identity (the official branded WorkflowRunId). */
  runId: WorkflowRunId
  /** The run's display name (run-start `name`). */
  name: string
  status: WorkflowRunStatus
  /** The run's member rows in durable `agent-start` arrival order. */
  members: WorkflowMemberView[]
}
