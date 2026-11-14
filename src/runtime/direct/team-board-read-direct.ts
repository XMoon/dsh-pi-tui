/**
 * The Direct `TeamBoardReadPort`: the official in-process `sessionProjections`
 * `agentTeam` projection behind the shared READ-ONLY Team board contract.
 *
 * Every read resolves the EXACT live Agent by Session id and proves it is its
 * own subagent-tree root before reading; a child never borrows its parent's
 * board. The projection alone is authoritative — this adapter does not require
 * the `agentTeams` write service or the `modelSelection` history (the FR1
 * `TeamModePort` availability rule), because a legal read-only board must stay
 * readable even when no Team write namespace is mounted.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/team-board-read-direct
 */

import type {
  TeamBoardReadPort,
  TeamBoardSnapshot,
  TeamBoardTask,
} from '../team-board-read-port.ts'

/** The minimal structural Agent face this adapter forwards to the projections. */
export interface DirectTeamBoardAgentLike {
  readonly session: unknown
}

/** One official task view (the wire `TeamTaskView` minus the filtered `deleted` status). */
interface DirectTeamTaskViewLike {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly blockedBy: readonly string[]
  readonly writeScopes: readonly string[]
  readonly ownerId?: string
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: readonly string[]
}

/** The official `agentTeam` wire projection. */
interface DirectTeamProjectionLike {
  readonly enabled: boolean
  readonly tasks: readonly DirectTeamTaskViewLike[]
  readonly failure?: string
}

/** The official `sessionProjections` face used by the read/subscribe paths. */
export interface DirectTeamBoardProjectionsLike {
  snapshot(
    session: unknown,
    keys: readonly string[],
  ): { readonly values: Readonly<Record<string, unknown>> }
  onChanged(
    listener: (session: unknown, key: string, value: unknown, seq: unknown) => void,
  ): () => void
}

/** The official `subagents` face that proves Root identity. */
export interface DirectTeamBoardSubagentsLike {
  rootOf(agent: unknown): unknown
}

/** The minimal Direct Host context face (services resolved per call). */
export interface DirectTeamBoardContextLike {
  get(name: string): unknown
}

/**
 * Copy the official typed projection into a detached readonly DTO. The Host
 * projection is already a client-safe wire view (deleted tasks filtered,
 * `ready`/`writeScopeWarnings` derived); only the fields this surface needs are
 * copied. No duplicate schema is added for the internal Host type.
 */
function detachTask(task: DirectTeamTaskViewLike): TeamBoardTask {
  return Object.freeze({
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.ownerId === undefined ? {} : { ownerId: task.ownerId }),
    ...(task.ownerName === undefined ? {} : { ownerName: task.ownerName }),
    ready: task.ready,
    blockedBy: Object.freeze([...task.blockedBy]),
    writeScopes: Object.freeze([...task.writeScopes]),
    writeScopeWarnings: Object.freeze([...task.writeScopeWarnings]),
  })
}

/**
 * Shape-check the bare minimum that the projection IS a `TeamProjection`: an
 * object with a boolean `enabled` and a task array. The rest of the typed Host
 * view is trusted (this is the in-process authority, not a network boundary).
 */
function teamProjectionOf(value: unknown): DirectTeamProjectionLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { readonly enabled?: unknown; readonly tasks?: unknown; readonly failure?: unknown }
  if (typeof candidate.enabled !== 'boolean') return undefined
  if (!Array.isArray(candidate.tasks)) return undefined
  if (candidate.failure !== undefined && typeof candidate.failure !== 'string') return undefined
  return value as unknown as DirectTeamProjectionLike
}

/** The Direct read-only Team board adapter over the official session projections. */
export class DirectTeamBoardReadPort implements TeamBoardReadPort {
  private readonly ctx: DirectTeamBoardContextLike
  private readonly agentFor: (sessionId: string) => DirectTeamBoardAgentLike | undefined

  constructor(
    ctx: DirectTeamBoardContextLike,
    agentFor: (sessionId: string) => DirectTeamBoardAgentLike | undefined,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  read(sessionId: string): TeamBoardSnapshot {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      return { kind: 'unavailable', cause: 'session-missing', reason: `Session "${sessionId}" is not live` }
    }
    const subagents = this.ctx.get('subagents') as DirectTeamBoardSubagentsLike | undefined
    const projections = this.ctx.get('sessionProjections') as DirectTeamBoardProjectionsLike | undefined
    if (subagents === undefined || projections === undefined) {
      return { kind: 'unavailable', cause: 'authority-missing', reason: 'Agent Team board authority is unavailable' }
    }
    const root = subagents.rootOf(agent)
    if (root === undefined) {
      return { kind: 'unavailable', cause: 'authority-missing', reason: 'Agent Team board authority is unavailable' }
    }
    if (root !== agent) {
      return {
        kind: 'unavailable',
        cause: 'not-root',
        reason: 'The Team board is available only for the root Session',
      }
    }
    const snapshot = projections.snapshot(agent.session, ['agentTeam'])
    const projection = teamProjectionOf(snapshot.values.agentTeam)
    if (projection === undefined) {
      return { kind: 'stale', reason: 'the Agent Team board projection is not readable' }
    }
    return {
      kind: 'ready',
      enabled: projection.enabled,
      tasks: Object.freeze(projection.tasks.map(detachTask)),
      ...(projection.failure === undefined ? {} : { failure: projection.failure }),
    }
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return () => {}
    const subagents = this.ctx.get('subagents') as DirectTeamBoardSubagentsLike | undefined
    if (subagents === undefined) return () => {}
    // Root-only: a confirmed child never receives the Root board feed.
    if (subagents.rootOf(agent) !== agent) return () => {}
    const projections = this.ctx.get('sessionProjections') as DirectTeamBoardProjectionsLike | undefined
    if (projections === undefined) return () => {}
    let disposed = false
    const off = projections.onChanged((session, key) => {
      if (!Object.is(session, agent.session)) return
      if (key !== 'agentTeam') return
      listener()
    })
    return () => {
      if (disposed) return
      disposed = true
      off()
    }
  }
}
