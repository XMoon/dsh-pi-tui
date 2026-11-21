/**
 * The Direct `TeamModePort`: the official in-process `agentTeams`,
 * `sessionProjections` and `subagents` services behind the shared Team
 * semantic contract.
 *
 * Every call resolves the EXACT live Agent by Session id and proves it is its
 * own subagent-tree root before reading or writing. The official `agentTeam`
 * projection is the saved selection and the official `modelSelection`
 * projection is the model-request history; this adapter keeps no cache and
 * appends no Session event itself.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/team-mode-direct
 */

import type { TeamModePort, TeamModeSnapshot, TeamModeWriteOutcome } from '../team-mode-port.ts'
import { safeErrorMessage } from '../process/errors.ts'

/** The minimal structural Agent face this adapter forwards to the official services. */
export interface DirectTeamModeAgentLike {
  readonly session: unknown
}

/** The official `sessionProjections` face used by the read/subscribe paths. */
export interface DirectTeamModeProjectionsLike {
  snapshot(
    session: unknown,
    keys: readonly string[],
  ): { readonly values: Readonly<Record<string, unknown>> }
  onChanged(
    listener: (session: unknown, key: string, value: unknown, seq: unknown) => void,
  ): () => void
}

/** The official `subagents` face that proves Root identity. */
export interface DirectTeamModeSubagentsLike {
  rootOf(agent: unknown): unknown
}

/** The official `agentTeams` write face. */
export interface DirectTeamModeServiceLike {
  setEnabled(agent: unknown, enabled: boolean, signal?: AbortSignal): Promise<void>
}

/** The minimal Direct Host context face (services resolved per call). */
export interface DirectTeamModeContextLike {
  get(name: string): unknown
}

/** Private diagnostic codes raised by the official Team service. */
function isTeamLeadRequired(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | undefined)?.code
  return typeof code === 'string' && code === 'TEAM_LEAD_REQUIRED'
}

/** Strictly read the `agentTeam` wire value (`{enabled: boolean, ...}`). */
function teamEnabledOf(value: unknown): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const enabled = (value as { readonly enabled?: unknown }).enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}

/**
 * Strictly read the `modelSelection` wire value. `null` is the recorded
 * "no request yet" state; an absent/invalid projection is NOT that state.
 */
function modelRequestHistoryOf(value: unknown): 'none' | 'recorded' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const lastUsed = (value as { readonly lastUsed?: unknown }).lastUsed
  if (lastUsed === null) return 'none'
  if (typeof lastUsed !== 'object' || lastUsed === null) return undefined
  const selection = lastUsed as { readonly provider?: unknown; readonly model?: unknown }
  if (typeof selection.provider !== 'string' || selection.provider === '') return undefined
  if (typeof selection.model !== 'string' || selection.model === '') return undefined
  return 'recorded'
}

/** The Direct Team adapter over the official in-process services. */
export class DirectTeamModePort implements TeamModePort {
  private readonly ctx: DirectTeamModeContextLike
  private readonly agentFor: (sessionId: string) => DirectTeamModeAgentLike | undefined

  constructor(
    ctx: DirectTeamModeContextLike,
    agentFor: (sessionId: string) => DirectTeamModeAgentLike | undefined,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  read(sessionId: string): TeamModeSnapshot {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      return { kind: 'unavailable', reason: `Session "${sessionId}" is not live` }
    }
    const subagents = this.ctx.get('subagents') as DirectTeamModeSubagentsLike | undefined
    if (subagents === undefined) {
      return { kind: 'unavailable', reason: 'Agent Team authority is unavailable' }
    }
    if (this.ctx.get('agentTeams') === undefined) {
      // The projection alone is not a write capability: never present a dead
      // toggle when the official Team service is absent.
      return { kind: 'unavailable', reason: 'Agent Team authority is unavailable' }
    }
    if (subagents.rootOf(agent) !== agent) {
      return { kind: 'unavailable', reason: 'Agent Team mode is available only for the root Session' }
    }
    const projections = this.ctx.get('sessionProjections') as DirectTeamModeProjectionsLike | undefined
    if (projections === undefined) {
      return { kind: 'unavailable', reason: 'Session projections are unavailable' }
    }
    const snapshot = projections.snapshot(agent.session, ['agentTeam', 'modelSelection'])
    const enabled = teamEnabledOf(snapshot.values.agentTeam)
    const modelRequestHistory = modelRequestHistoryOf(snapshot.values.modelSelection)
    if (enabled === undefined) {
      return { kind: 'stale', reason: 'the Agent Team projection is not readable' }
    }
    if (modelRequestHistory === undefined) {
      return { kind: 'stale', reason: 'the model request history is not readable' }
    }
    return { kind: 'ready', enabled, modelRequestHistory }
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return () => {}
    const projections = this.ctx.get('sessionProjections') as DirectTeamModeProjectionsLike | undefined
    if (projections === undefined) return () => {}
    let disposed = false
    const off = projections.onChanged((session, key) => {
      if (!Object.is(session, agent.session)) return
      if (key !== 'agentTeam' && key !== 'modelSelection') return
      listener()
    })
    return () => {
      if (disposed) return
      disposed = true
      off()
    }
  }

  async setEnabled(sessionId: string, enabled: boolean, signal: AbortSignal): Promise<TeamModeWriteOutcome> {
    if (signal.aborted) return { kind: 'cancelled', reason: 'the Team mode change was cancelled' }
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      return { kind: 'rejected', reason: `Session "${sessionId}" is not live` }
    }
    const subagents = this.ctx.get('subagents') as DirectTeamModeSubagentsLike | undefined
    if (subagents === undefined) {
      return { kind: 'rejected', reason: 'Agent Team authority is unavailable' }
    }
    if (subagents.rootOf(agent) !== agent) {
      return { kind: 'rejected', reason: 'Agent Team mode can only be changed from the root Session' }
    }
    const service = this.ctx.get('agentTeams') as DirectTeamModeServiceLike | undefined
    if (service === undefined) {
      return { kind: 'rejected', reason: 'Agent Team authority is unavailable' }
    }
    try {
      // The official write appends the one `team/mode` record and flushes the
      // Session itself; no client-side append/flush is added here.
      await service.setEnabled(agent, enabled, signal)
      return { kind: 'committed' }
    } catch (error) {
      // The ONLY pre-dispatch cancellation is the caller's abort, checked
      // before this call. Once the official `setEnabled` was entered it may
      // already have appended `team/mode` before `sessions.flush()` failed —
      // and a flush listener can throw an AbortError-shaped value. An error
      // name here can never prove non-commit, so a cancellation-shaped error is
      // `indeterminate`, not `cancelled`. The Root refusal is the one exception:
      // the official service raises it BEFORE any append.
      if (isTeamLeadRequired(error)) {
        return { kind: 'rejected', reason: 'Agent Team mode can only be changed from the root Session' }
      }
      return {
        kind: 'indeterminate',
        reason: `the Host did not confirm the Team mode write: ${safeErrorMessage(error)}`,
      }
    }
  }
}
