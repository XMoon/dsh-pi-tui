/**
 * The ONE Workflow semantic projection (TS7 move from `src/transcript.ts`).
 *
 * Workflow run/member lifecycle facts — open step/turn owner capture, member
 * and run settlement, and the `interrupted` projection of a MISSING terminal
 * fact plus a closed owner — are transcript semantics, never renderer facts.
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
 * `interrupted` is a presentation projection of a MISSING terminal fact plus
 * a closed owner location — it is never a durable stop reason. */
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
  /** The member's settled state (running until agent-end). */
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

/** The owner location captured at run-start: the authoritative open
 * lifecycle state at fold time (plan §5.2) — never a look-back guess over
 * nearby events. */
export type WorkflowOwner =
  | { kind: 'step'; turn: number; step: number }
  | { kind: 'turn'; turn: number }
  | { kind: 'session' }

/** One active Workflow run inside the shared projection. The
 * `TranscriptWorkflowMessage` itself is the durable model; this state only
 * serves the projection (owner matching, interruption projection). */
interface WorkflowProjectionRun {
  message: TranscriptWorkflowMessage
  /** The owner location captured at run-start. */
  owner: WorkflowOwner
  /** Whether the owner location has closed (step/end or turn/end). */
  ownerClosed: boolean
}

/**
 * The shared Workflow semantic projection (plan §5/§6): ONE owner-tracking
 * state machine consumed by BOTH the visual Transcript fold and the
 * `/transcript` markdown export, so the two can never drift on run/member
 * statuses. It owns the open step/turn lifecycle, the run-start owner
 * capture, member/run settlement, and the `interrupted` projection of a
 * MISSING terminal fact plus a closed owner location (plan §6.4 — never a
 * durable stop reason). The optional `onChange` hook fires whenever a run's
 * message mutated (run-end status, interruption projection) so the visual
 * fold can mark its search entry dirty; the export passes no hook.
 */
export class WorkflowProjection {
  private readonly runs = new Map<string, WorkflowProjectionRun>()
  /** The currently open step (owner capture for run-start). */
  private openStep: { turn: number; step: number } | undefined
  /** The currently open turn (owner capture for run-start). */
  private openTurn: number | undefined

  private readonly onChange: ((runId: WorkflowRunId) => void) | undefined

  constructor(onChange?: (runId: WorkflowRunId) => void) {
    this.onChange = onChange
  }

  /** A step opened (owner capture). The caller applies its own replay fence
   * (a late step/start after turn/end must not reopen the step). */
  onStepStart(turn: number, step: number): void {
    this.openStep = { turn, step }
  }

  /** A step closed: clear the matching open step and project `interrupted`
   * on step-owned runs of that step without a terminal fact. */
  onStepEnd(turn: number, step: number): void {
    if (this.openStep?.turn === turn && this.openStep.step === step) {
      this.openStep = undefined
    }
    this.closeWorkflowOwner({ kind: 'step', turn, step })
  }

  /** A turn opened (owner capture). Monotonic: a replayed turn/start for an
   * OLDER turn must never regress the open turn. */
  onTurnStart(turn: number): void {
    if (this.openTurn === undefined || turn > this.openTurn) this.openTurn = turn
  }

  /** A turn closed: clear the open step/turn and project `interrupted` on
   * every turn-owned AND step-owned run of that turn without a terminal
   * fact (plan §5.3 — upstream `locationClosed(step)` is `step closed OR
   * owning turn closed`). Re-projection on a replayed turn/end is
   * idempotent (already-closed runs are skipped). */
  onTurnEnd(turn: number): void {
    if (this.openTurn === turn) this.openTurn = undefined
    if (this.openStep?.turn === turn) this.openStep = undefined
    this.closeWorkflowOwner({ kind: 'turn', turn })
  }

  /** One run opened: capture the authoritative owner (open step wins, then
   * the open turn, else the session) and create the durable message. */
  onRunStart(runId: WorkflowRunId, name: string, turn: number): TranscriptWorkflowMessage {
    const owner: WorkflowOwner = this.openStep !== undefined
      ? { kind: 'step', turn: this.openStep.turn, step: this.openStep.step }
      : this.openTurn !== undefined
        ? { kind: 'turn', turn: this.openTurn }
        : { kind: 'session' }
    const message: TranscriptWorkflowMessage = {
      kind: 'workflow',
      turn,
      runId,
      name,
      status: 'running',
      members: [],
    }
    this.runs.set(runId, { message, owner, ownerClosed: false })
    return message
  }

  /** One member published: fold it into the run card (Web WorkflowRunPanel
   * parity). A member starting after its owner closed is interrupted from
   * birth (plan §6.2 — the projection comes from the current fold facts, no
   * invented recovery flow). The member's label/phase/status entered the
   * search corpus (PR2 plan §13.3): the onChange hook marks it dirty. */
  onAgentStart(runId: WorkflowRunId, seq: number, label: string, phase: string | null, childId: WorkflowChildSessionId): void {
    const state = this.runs.get(runId)
    if (state === undefined) return
    const member: WorkflowMemberView = {
      seq,
      label,
      phase,
      childId,
      status: state.ownerClosed ? 'interrupted' : 'running',
    }
    // Replace the members array reference so render caches observe the live
    // append (plan §6.2 — never rely on in-place push).
    state.message.members = [...state.message.members, member]
    this.onChange?.(runId)
  }

  /** One member settled: only the started member with the matching runId +
   * seq settles (plan §6.3 — never infer a member outcome from run-end).
   * The member's status word changed in the search corpus (PR2 plan
   * §13.3): the onChange hook marks it dirty. */
  onAgentEnd(runId: WorkflowRunId, seq: number, outcome: 'completed' | 'failed' | 'cancelled'): void {
    const state = this.runs.get(runId)
    if (state === undefined) return
    const target = state.message.members.find(member => member.seq === seq)
    if (target === undefined) return
    const status = workflowMemberStatus(outcome)
    // Replace the settled member AND the members array reference so render
    // caches observe the live update (plan §6.2).
    state.message.members = state.message.members.map(member =>
      member === target ? { ...member, status } : member,
    )
    this.onChange?.(runId)
  }

  /** One run settled: set the terminal status, notify, and drop the fold
   * state (the message itself stays in the transcript items / export).
   * @returns the final message, or `undefined` when the run was unknown. */
  onRunEnd(runId: WorkflowRunId, stopReason: 'completed' | 'cancelled' | 'error'): TranscriptWorkflowMessage | undefined {
    const state = this.runs.get(runId)
    if (state === undefined) return undefined
    state.message.status = workflowRunStatus(stopReason)
    this.onChange?.(runId)
    this.runs.delete(runId)
    return state.message
  }

  /** Every run still active (no terminal event yet), in run-start order —
   * the export's full-log flush. */
  activeRuns(): readonly TranscriptWorkflowMessage[] {
    return [...this.runs.values()].map(state => state.message)
  }

  /** Project `interrupted` on every active run whose owner location just
   * closed and which has no terminal fact yet (plan §5.3). */
  private closeWorkflowOwner(closed: WorkflowOwner): void {
    for (const state of this.runs.values()) {
      if (state.ownerClosed) continue
      const owner = state.owner
      const matches = owner.kind === 'step'
        ? (closed.kind === 'step' && closed.turn === owner.turn && closed.step === owner.step)
          || (closed.kind === 'turn' && closed.turn === owner.turn)
        : owner.kind === 'turn' && closed.kind === 'turn' && closed.turn === owner.turn
      if (matches) this.projectWorkflowInterrupted(state)
    }
  }

  /** The owner-close projection: `interrupted` is a presentation/model
   * projection of a MISSING terminal fact plus a closed owner — never a
   * durable stop reason (plan §6.4). Members without an agent-end follow
   * the run; settled members keep their durable outcome. */
  private projectWorkflowInterrupted(state: WorkflowProjectionRun): void {
    state.ownerClosed = true
    state.message.status = 'interrupted'
    state.message.members = state.message.members.map(member =>
      member.status === 'running' ? { ...member, status: 'interrupted' } : member,
    )
    this.onChange?.(state.message.runId)
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
