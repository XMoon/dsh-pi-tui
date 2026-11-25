/**
 * Session-level collaboration mode and Agent Team policy for the Host-owned
 * ACP Session View.
 *
 * This module is the ONE narrow facade over the two OFFICIAL Agent-scoped
 * policies this Host can actually commit:
 *
 * - the retained official PlanModeController (the `plan/mode` collaboration
 *   mode), projected onto the fixed ACP wire ids `default` and `plan`;
 * - the official root-only Agent Team boolean (`agentTeams.setEnabled`).
 *
 * It owns NO durable state: every read re-reads the exact retained service and
 * the official Session projection, and every write re-reads the exact identity,
 * the baseline and the official turn/maintenance admission before ONE official
 * call. Model/effort stay in `local-acp-model-selection.ts`; this module never
 * sees a model catalog, a config store, a profile default or a second registry.
 *
 * The two wire forms of the SAME mode definition (the legacy `SessionModeState`
 * and the `mode` config row) are generated from one constant, never stored
 * separately. `pending` is a TARGET selection, not the committed mode: it is
 * only an admission fact (a write is refused while it exists) and never becomes
 * `currentModeId`.
 *
 * @module app/remote-process/local-acp-session-policy
 */

import type { SessionConfigOption, SessionMode, SessionModeState } from '@agentclientprotocol/sdk'

/** The two real collaboration modes this Host projects. */
export type AcpSessionMode = 'default' | 'plan'

/**
 * One detached policy snapshot. An absent field is a truthful capability
 * absence (no retained official service / no readable authority), never a
 * fabricated `false` or `default`.
 */
export interface AcpSessionPolicyState {
  /** The committed collaboration mode, when a retained official controller exists. */
  readonly mode?: AcpSessionMode
  /** The committed root Agent Team selection, when its official authority is readable. */
  readonly agentTeam?: boolean
}

/** One validated policy write request. */
export type AcpSessionPolicyRequest =
  | { readonly kind: 'mode'; readonly mode: AcpSessionMode }
  | { readonly kind: 'agent-team'; readonly enabled: boolean }

/** The exact retained official PlanModeController seam this module consumes. */
export interface AcpPlanModeService {
  get(agent: object): { readonly active: boolean; readonly pending?: boolean }
  set(agent: object, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}

/** The exact official root-only Agent Team write seam. */
export interface AcpAgentTeamService {
  setEnabled(agent: object, enabled: boolean, signal?: AbortSignal): Promise<void>
}

/**
 * The one Host-composition seam: each callable resolves an official service or
 * projection from the already-settled Host Context. A throwing read is an
 * unavailable capability; an absent service is absence.
 */
export interface AcpSessionPolicyAuthority {
  currentAgent(sessionId: string): object | undefined
  currentSession(sessionId: string): object | undefined
  /** The exact retained official PlanModeController, or undefined when absent/non-official. */
  planMode(agent: object): AcpPlanModeService | undefined
  /** The official root Agent Team write seam, present only for the exact live root. */
  team(agent: object): AcpAgentTeamService | undefined
  /** The official `agentTeam.enabled` projection, or undefined when the key is absent. */
  teamEnabled(session: object): boolean | undefined
  /** Whether the official turn boundary proves no open turn for this exact Session. */
  noOpenTurn(session: object): boolean
}

/** The exact live Agent surface a policy write may touch. */
export interface AcpSessionPolicyAgent {
  readonly id: string
  readonly session: object
  readonly status: 'idle' | 'running'
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** The stable policy failure codes carried on the ACP wire. */
export type AcpSessionPolicyErrorCode =
  /** Malformed/unsupported mode id, config id, type or value. */
  | 'LOCAL_ACP_CONFIG_INVALID_OPTION'
  /** The authoritative mode/Team capability is absent or unreadable. */
  | 'LOCAL_ACP_CONFIG_UNAVAILABLE'
  /** This ACP View still owns another unsettled obligation or policy write. */
  | 'LOCAL_ACP_CONFIG_VIEW_BUSY'
  /** The official maintenance admission refused: open turn, pending selection or busy Agent. */
  | 'LOCAL_ACP_CONFIG_AGENT_BUSY'
  /** The exact View/Agent/Session/service identity changed during the request. */
  | 'LOCAL_ACP_CONFIG_STALE'
  /** The admission baseline changed before the official write. */
  | 'LOCAL_ACP_CONFIG_CONFLICT'
  /** The official call was invoked but its real outcome cannot be confirmed. */
  | 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE'
  /** The official write may have committed but the complete readback cannot be confirmed. */
  | 'LOCAL_ACP_CONFIG_READBACK_UNAVAILABLE'

const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_UNAVAILABLE = -32042
const JSONRPC_BUSY = -32046
const JSONRPC_INTERNAL_ERROR = -32000

/** One classified policy rejection; it never carries a Host path or exception text. */
export class AcpSessionPolicyError extends Error {
  readonly code: AcpSessionPolicyErrorCode
  readonly rpcCode: number
  readonly data: Readonly<Record<string, unknown>>

  constructor(
    code: AcpSessionPolicyErrorCode,
    message: string,
    rpcCode: number,
  ) {
    super(message)
    this.name = 'AcpSessionPolicyError'
    this.code = code
    this.rpcCode = rpcCode
    this.data = {}
  }
}

/** One malformed/unsupported mode id or config option shape. */
export function invalidPolicyOption(message: string): AcpSessionPolicyError {
  return new AcpSessionPolicyError('LOCAL_ACP_CONFIG_INVALID_OPTION', message, JSONRPC_INVALID_PARAMS)
}

/** The authoritative mode/Team capability is absent or unreadable. */
export function unavailablePolicy(message: string): AcpSessionPolicyError {
  return new AcpSessionPolicyError('LOCAL_ACP_CONFIG_UNAVAILABLE', message, JSONRPC_UNAVAILABLE)
}

/** This View still owns another unsettled obligation or policy write. */
export function viewBusyPolicy(message: string): AcpSessionPolicyError {
  return new AcpSessionPolicyError('LOCAL_ACP_CONFIG_VIEW_BUSY', message, JSONRPC_BUSY)
}

/** The official maintenance/admission refused the write. */
export function agentBusyPolicy(message: string): AcpSessionPolicyError {
  return new AcpSessionPolicyError('LOCAL_ACP_CONFIG_AGENT_BUSY', message, JSONRPC_BUSY)
}

/** The exact identity changed during the request. */
export function stalePolicy(): AcpSessionPolicyError {
  return new AcpSessionPolicyError(
    'LOCAL_ACP_CONFIG_STALE',
    'the attached session changed during the config request',
    JSONRPC_UNAVAILABLE,
  )
}

/** The admission baseline changed before the official write. */
export function conflictPolicy(): AcpSessionPolicyError {
  return new AcpSessionPolicyError(
    'LOCAL_ACP_CONFIG_CONFLICT',
    'the session policy changed during the request',
    JSONRPC_BUSY,
  )
}

/** The official call was invoked but its outcome cannot be confirmed. */
export function indeterminatePolicy(message: string): AcpSessionPolicyError {
  return new AcpSessionPolicyError('LOCAL_ACP_CONFIG_WRITE_INDETERMINATE', message, JSONRPC_INTERNAL_ERROR)
}

/** The official write may have settled but its complete state cannot be read back. */
export function readbackUnavailablePolicy(message = 'the committed session policy state could not be read back'): AcpSessionPolicyError {
  return new AcpSessionPolicyError('LOCAL_ACP_CONFIG_READBACK_UNAVAILABLE', message, JSONRPC_INTERNAL_ERROR)
}

/** The fixed two-mode wire definition; both wire forms are generated from this. */
export const ACP_SESSION_MODES: readonly SessionMode[] = Object.freeze([
  {
    id: 'default',
    name: 'Default',
    description: 'Normal collaboration mode.',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Plan and review before implementation; does not change sandbox or approval policy.',
  },
])

/** The stable `mode` config-row identity. */
export const ACP_MODE_CONFIG_ID = 'mode'
/** The stable Agent Team boolean config-row identity (no reserved category). */
export const ACP_AGENT_TEAM_CONFIG_ID = 'agent_team'

const ACP_MODE_OPTION_NAME = 'Mode'
const ACP_AGENT_TEAM_OPTION_NAME = 'Agent Team'
const ACP_AGENT_TEAM_DESCRIPTION = 'Enable Agent Team collaboration for this root session.'

/** Decode one ACP wire mode id into this Host's fixed vocabulary. */
export function modeOfWireId(value: unknown): AcpSessionMode | undefined {
  if (value === 'default' || value === 'plan') return value
  return undefined
}

/** Encode one committed mode as its fixed wire id. */
export function wireModeId(mode: AcpSessionMode): string {
  return mode
}

/**
 * The legacy `SessionModeState` for one policy snapshot, or undefined when no
 * committed mode authority is readable. `pending` is never projected.
 */
export function sessionModeStateOf(state: AcpSessionPolicyState): SessionModeState | undefined {
  if (state.mode === undefined) return undefined
  return {
    currentModeId: wireModeId(state.mode),
    availableModes: ACP_SESSION_MODES.map(mode => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description === undefined ? {} : { description: mode.description }),
    })),
  }
}

/**
 * The standard `mode` config row for one policy snapshot. The same definition
 * drives the legacy mode list; this is a projection, not a second state.
 */
export function modeConfigOptionOf(state: AcpSessionPolicyState): SessionConfigOption | undefined {
  if (state.mode === undefined) return undefined
  return {
    id: ACP_MODE_CONFIG_ID,
    name: ACP_MODE_OPTION_NAME,
    category: 'mode',
    type: 'select',
    currentValue: wireModeId(state.mode),
    options: ACP_SESSION_MODES.map(mode => ({
      value: mode.id,
      name: mode.name,
      ...(mode.description === undefined ? {} : { description: mode.description }),
    })),
  }
}

/**
 * The Agent Team boolean row, present only when the client negotiated boolean
 * config options and the official root selection is readable.
 */
export function agentTeamConfigOptionOf(
  state: AcpSessionPolicyState,
  booleanSupported: boolean,
): SessionConfigOption | undefined {
  if (!booleanSupported || state.agentTeam === undefined) return undefined
  return {
    id: ACP_AGENT_TEAM_CONFIG_ID,
    name: ACP_AGENT_TEAM_OPTION_NAME,
    type: 'boolean',
    currentValue: state.agentTeam,
    description: ACP_AGENT_TEAM_DESCRIPTION,
  }
}

/** The mode facts of one exact official controller read. */
interface ModeFacts {
  readonly active: boolean
  readonly pending?: boolean
}

/**
 * The ONE transient policy service bound once per Host ACP access. It owns no
 * state: every call re-reads the official authority and revalidates the exact
 * identity and admission baseline around the one official write.
 */
export class AcpSessionPolicyService {
  private readonly authority: AcpSessionPolicyAuthority

  constructor(authority: AcpSessionPolicyAuthority) {
    this.authority = authority
  }

  /**
   * Read the committed session policy synchronously. A retained official
   * capability that cannot be read is `UNAVAILABLE`, never an absent row and
   * never a fabricated value; a child Session carries no Team row.
   */
  read(agent: AcpSessionPolicyAgent): AcpSessionPolicyState {
    this.assertExact(agent)
    let mode: AcpSessionMode | undefined
    const plan = this.readPlanService(agent)
    if (plan !== undefined) {
      mode = this.readModeFacts(plan, agent).active ? 'plan' : 'default'
    }
    let agentTeam: boolean | undefined
    const team = this.readTeamService(agent)
    if (team !== undefined) {
      const enabled = this.readTeamEnabled(agent.session)
      if (enabled !== undefined) agentTeam = enabled
    }
    return {
      ...(mode === undefined ? {} : { mode }),
      ...(agentTeam === undefined ? {} : { agentTeam }),
    }
  }

  /**
   * Commit ONE policy write through the official runMaintenance admission.
   * The callback performs only synchronous checks plus the official call; the
   * exact invoked service/target identity is re-read after settlement. The
   * return is terminal-only: a successful setter does not re-read unrelated
   * policy rows that the caller would discard.
   */
  async select(
    agent: AcpSessionPolicyAgent,
    request: AcpSessionPolicyRequest,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ): Promise<void> {
    this.assertExact(agent)
    signal.throwIfAborted()
    if (request.kind === 'mode') {
      await this.selectMode(agent, request.mode, signal, stillCurrent)
      return
    }
    await this.selectTeam(agent, request.enabled, signal, stillCurrent)
  }

  /** Read ONLY the exact committed legacy mode; unrelated Team rows are not read. */
  readMode(agent: AcpSessionPolicyAgent): AcpSessionMode | undefined {
    this.assertExact(agent)
    const plan = this.readPlanService(agent)
    if (plan === undefined) return undefined
    const facts = this.readModeFacts(plan, agent)
    return facts.active ? 'plan' : 'default'
  }

  private async selectMode(
    agent: AcpSessionPolicyAgent,
    mode: AcpSessionMode,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ): Promise<void> {
    const plan = this.readPlanService(agent)
    if (plan === undefined) throw unavailablePolicy('this Agent has no retained official plan-mode service')
    const baseline = this.readModeFacts(plan, agent)
    if (baseline.pending !== undefined) throw agentBusyPolicy('a plan-mode selection is still waiting for its boundary')
    const intended = mode === 'plan'
    let invoked = false
    let maintenance: Promise<void>
    try {
      maintenance = agent.runMaintenance(async maintenanceSignal => {
        if (signal.aborted || maintenanceSignal.aborted) {
          throw new AcpSessionPolicyError('LOCAL_ACP_CONFIG_STALE', 'the policy request was cancelled before the official call', JSONRPC_UNAVAILABLE)
        }
        if (stillCurrent() !== 'current') throw stalePolicy()
        this.assertExact(agent)
        // Resolve the retained service again at the LAST admission boundary:
        // an old handle is not proof that the current Agent still owns it.
        const currentPlan = this.readPlanService(agent)
        if (currentPlan === undefined) throw unavailablePolicy('the retained plan-mode service disappeared before the write')
        if (!this.authority.noOpenTurn(agent.session)) throw agentBusyPolicy('the session still has an open turn')
        const current = this.readModeFacts(currentPlan, agent)
        if (current.pending !== undefined) throw agentBusyPolicy('a plan-mode selection is still waiting for its boundary')
        if (current.active !== baseline.active) throw conflictPolicy()
        invoked = true
        let outcome: 'committed' | 'queued' | 'cancelled' | 'noop'
        try {
          outcome = currentPlan.set(agent, intended)
        } catch {
          // The official append can commit before a later inject throws; the
          // real state is re-read for notification, never reported as no-write.
          throw indeterminatePolicy('the plan-mode write outcome is unconfirmed')
        }
        if (outcome !== 'committed' && outcome !== 'noop') {
          throw indeterminatePolicy('the plan-mode write did not commit synchronously')
        }
        try {
          this.assertExact(agent)
          const afterPlan = this.readPlanService(agent)
          if (afterPlan === undefined) {
            throw readbackUnavailablePolicy('the current plan-mode authority is unavailable after the write')
          }
          const after = this.readModeFacts(afterPlan, agent)
          if (after.active !== intended || after.pending !== undefined) {
            throw indeterminatePolicy('the plan-mode readback does not match the requested mode')
          }
        } catch (error) {
          // The setter already settled. A changed identity or an unreadable
          // projection after the commit is NOT a pre-write refusal; only the
          // explicit target mismatch above stays WRITE_INDETERMINATE.
          if (error instanceof AcpSessionPolicyError
            && error.code === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE') throw error
          throw readbackUnavailablePolicy('the committed plan-mode state could not be read back')
        }
      })
    } catch (error) {
      if (error instanceof AcpSessionPolicyError) throw error
      throw agentBusyPolicy('the Agent maintenance admission refused the policy write')
    }
    try {
      await maintenance
    } catch (error) {
      if (error instanceof AcpSessionPolicyError) throw error
      throw invoked
        ? indeterminatePolicy('the plan-mode write outcome is unconfirmed')
        : agentBusyPolicy('the Agent maintenance admission refused the policy write')
    }
  }

  private async selectTeam(
    agent: AcpSessionPolicyAgent,
    enabled: boolean,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ): Promise<void> {
    const team = this.readTeamService(agent)
    if (team === undefined) throw unavailablePolicy('the Agent Team policy is unavailable for this Session')
    const baseline = this.readTeamEnabled(agent.session)
    if (baseline === undefined) throw unavailablePolicy('the Agent Team projection is unavailable')
    let invoked = false
    let maintenance: Promise<void>
    try {
      maintenance = agent.runMaintenance(async maintenanceSignal => {
        if (signal.aborted || maintenanceSignal.aborted) {
          throw new AcpSessionPolicyError('LOCAL_ACP_CONFIG_STALE', 'the Team request was cancelled before the official call', JSONRPC_UNAVAILABLE)
        }
        if (stillCurrent() !== 'current') throw stalePolicy()
        this.assertExact(agent)
        // The root write seam is resolved again at the final admission; a
        // retained old handle/setter is not the current root authority.
        const currentTeam = this.readTeamService(agent)
        if (currentTeam === undefined) throw unavailablePolicy('the Agent Team service disappeared before the write')
        if (!this.authority.noOpenTurn(agent.session)) throw agentBusyPolicy('the session still has an open turn')
        const current = this.readTeamEnabled(agent.session)
        if (current === undefined) throw unavailablePolicy('the Agent Team projection is unavailable')
        if (current !== baseline) throw conflictPolicy()
        invoked = true
        try {
          // Even selecting the SAME value goes through the official service:
          // its own flush is the durability terminal, not a local no-op.
          await currentTeam.setEnabled(agent, enabled, signal)
        } catch {
          throw indeterminatePolicy('the Agent Team write outcome is unconfirmed')
        }
        try {
          this.assertExact(agent)
          const afterTeam = this.readTeamService(agent)
          if (afterTeam === undefined) {
            throw readbackUnavailablePolicy('the current Agent Team authority is unavailable after the write')
          }
          const after = this.readTeamEnabled(agent.session)
          if (after === undefined) {
            throw readbackUnavailablePolicy('the committed Agent Team state is not readable')
          }
          if (after !== enabled) {
            throw indeterminatePolicy('the Agent Team readback does not match the requested value')
          }
        } catch (error) {
          // Post-settlement identity/projection failure is a readback fact, not
          // a pre-write refusal; a real target mismatch stays indeterminate.
          if (error instanceof AcpSessionPolicyError
            && error.code === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE') throw error
          throw readbackUnavailablePolicy('the committed Agent Team state could not be read back')
        }
      })
    } catch (error) {
      if (error instanceof AcpSessionPolicyError) throw error
      throw agentBusyPolicy('the Agent maintenance admission refused the policy write')
    }
    try {
      await maintenance
    } catch (error) {
      if (error instanceof AcpSessionPolicyError) throw error
      throw invoked
        ? indeterminatePolicy('the Agent Team write outcome is unconfirmed')
        : agentBusyPolicy('the Agent maintenance admission refused the policy write')
    }
  }

  /** The exact retained PlanModeController, or absence; a failed read is unavailable. */
  private readPlanService(agent: AcpSessionPolicyAgent): AcpPlanModeService | undefined {
    let service: AcpPlanModeService | undefined
    try {
      service = this.authority.planMode(agent)
    } catch {
      throw unavailablePolicy('the retained plan-mode service could not be resolved')
    }
    return service
  }

  /** The official Team write seam, present only for the exact live root. */
  private readTeamService(agent: AcpSessionPolicyAgent): AcpAgentTeamService | undefined {
    let service: AcpAgentTeamService | undefined
    try {
      service = this.authority.team(agent)
    } catch {
      throw unavailablePolicy('the Agent Team service could not be resolved')
    }
    return service
  }

  /** One valid official mode read; malformed state is unavailable, never a default. */
  private readModeFacts(plan: AcpPlanModeService, agent: AcpSessionPolicyAgent): ModeFacts {
    let state: unknown
    try {
      state = plan.get(agent)
    } catch {
      throw unavailablePolicy('the retained plan-mode state could not be read')
    }
    if (state === null || typeof state !== 'object') {
      throw unavailablePolicy('the retained plan-mode state is not readable')
    }
    const facts = state as { readonly active?: unknown; readonly pending?: unknown }
    if (typeof facts.active !== 'boolean' || (facts.pending !== undefined && typeof facts.pending !== 'boolean')) {
      throw unavailablePolicy('the retained plan-mode state is malformed')
    }
    return {
      active: facts.active,
      ...(facts.pending === undefined ? {} : { pending: facts.pending }),
    }
  }

  /** One valid official Team read; a task-board failure never negates the bool. */
  private readTeamEnabled(session: object): boolean | undefined {
    let enabled: unknown
    try {
      enabled = this.authority.teamEnabled(session)
    } catch {
      throw unavailablePolicy('the official Agent Team projection could not be read')
    }
    if (enabled === undefined) return undefined
    if (typeof enabled !== 'boolean') throw unavailablePolicy('the official Agent Team projection is malformed')
    return enabled
  }

  /** The exact attached Agent/Session pair must still be the live Host pair. */
  private assertExact(agent: AcpSessionPolicyAgent): void {
    if (this.authority.currentAgent(agent.id) !== agent || this.authority.currentSession(agent.id) !== agent.session) {
      throw stalePolicy()
    }
  }
}
