/**
 * The Remote `TeamBoardReadPort`: the official generated `agentTeam` Client
 * projection behind the shared READ-ONLY Team board contract, over the ONE
 * authenticated Connection and the ONE Client Session binding.
 *
 * The board is a Root-Session projection: a read proves the exact binding is a
 * readable root (its Session snapshot `subagent === null`, falling back to the
 * official Session-list `origin` when a structural face cannot expose the
 * snapshot), and a child is refused. A missing binding is a truthful
 * `session-missing` (recoverable through the Session-list invalidation feed) or
 * `not-root` (a confirmed child), never a Direct fallback and never a second
 * transport. No `remote.agentTeams` writer namespace is required: this port is
 * read-only.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/team-board-read-remote
 */

import type {
  TeamBoardReadPort,
  TeamBoardSnapshot,
  TeamBoardTask,
} from '../team-board-read-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'

const AGENT_TEAM_KEY = 'agentTeam'

/** One official Client projection face (value deliberately `unknown`). */
export interface RemoteTeamBoardProjectionFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** The exact-Session lifecycle facts the Root check consumes. */
export interface RemoteTeamBoardSessionSnapshot {
  readonly subagent?: unknown
  readonly removed?: unknown
}

/** The official Client Session binding subset consumed here. */
export interface RemoteTeamBoardSessionFace {
  readonly projections: {
    faceOf(key: string): RemoteTeamBoardProjectionFace
  }
  /** Present on the real SessionFace; structural stand-ins may omit it. */
  getSnapshot?(): RemoteTeamBoardSessionSnapshot
}

/** The official `ClientSessions` identity + binding face. */
export interface RemoteTeamBoardSessionsSource {
  binding(sessionId: string): { readonly session: RemoteTeamBoardSessionFace } | undefined
  /** The official Session-list rows: the fallback Root fact (subagent origin)
   *  when a binding face cannot expose its lifecycle snapshot. */
  readonly list: {
    getSnapshot(): {
      readonly byId: Readonly<Record<string, { readonly origin?: 'subagent' } | undefined>>
    }
    /** Optional invalidation feed: lets an initially absent binding recover. */
    subscribe?(listener: () => void): () => void
  }
}

/** The narrow one-source runtime face this adapter consumes. */
export interface RemoteTeamBoardRuntimeSource {
  readonly sessions: RemoteTeamBoardSessionsSource
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
}

/** Identity-free shape check on the projection value (network boundary). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every(item => typeof item === 'string') ? Object.freeze([...value] as string[]) : undefined
}

/**
 * Detach one official `TeamTaskView` at the network boundary. Returns
 * `'deleted'` for the filtered status (never shown), `undefined` for any
 * structurally invalid task (the whole read then fails closed — never an empty
 * board), otherwise the detached DTO. An unknown status is NEVER silently
 * coerced to `completed`.
 */
function detachTask(raw: unknown): TeamBoardTask | 'deleted' | undefined {
  if (!isRecord(raw)) return undefined
  const { id, revision, subject, description, status, ready } = raw
  if (typeof id !== 'string' || typeof subject !== 'string' || typeof description !== 'string') return undefined
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return undefined
  if (typeof ready !== 'boolean') return undefined
  if (status === 'deleted') return 'deleted'
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return undefined
  const blockedBy = stringArray(raw.blockedBy)
  const writeScopes = stringArray(raw.writeScopes)
  const writeScopeWarnings = stringArray(raw.writeScopeWarnings)
  if (blockedBy === undefined || writeScopes === undefined || writeScopeWarnings === undefined) return undefined
  const ownerId = raw.ownerId
  const ownerName = raw.ownerName
  if (ownerId !== undefined && typeof ownerId !== 'string') return undefined
  if (ownerName !== undefined && typeof ownerName !== 'string') return undefined
  return Object.freeze({
    id,
    revision,
    subject,
    description,
    status,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(ownerName === undefined ? {} : { ownerName }),
    ready,
    blockedBy,
    writeScopes,
    writeScopeWarnings,
  })
}

/** Outcome of parsing one projection wire value: a ready board or an unreadable one. */
type ParsedBoard =
  | { readonly kind: 'ready'; readonly enabled: boolean; readonly tasks: readonly TeamBoardTask[]; readonly failure?: string }
  | { readonly kind: 'unreadable' }

function parseProjection(value: unknown): ParsedBoard {
  if (!isRecord(value)) return { kind: 'unreadable' }
  const enabled = value.enabled
  if (typeof enabled !== 'boolean') return { kind: 'unreadable' }
  if (!Array.isArray(value.tasks)) return { kind: 'unreadable' }
  const tasks: TeamBoardTask[] = []
  for (const raw of value.tasks) {
    const task = detachTask(raw)
    if (task === undefined) return { kind: 'unreadable' }
    if (task === 'deleted') continue
    tasks.push(task)
  }
  const failure = value.failure
  if (failure !== undefined && typeof failure !== 'string') return { kind: 'unreadable' }
  return {
    kind: 'ready',
    enabled,
    tasks: Object.freeze(tasks),
    ...(failure === undefined ? {} : { failure }),
  }
}

/** The Remote read-only Team board adapter over the official Client binding. */
export class RemoteTeamBoardReadPort implements TeamBoardReadPort {
  private readonly sessions: RemoteTeamBoardSessionsSource
  private readonly generation: RemoteConnectionGenerationSource

  constructor(runtime: RemoteTeamBoardRuntimeSource) {
    this.sessions = runtime.sessions
    this.generation = runtime.connection.generation
  }

  read(sessionId: string): TeamBoardSnapshot {
    const generation = this.generation.getSnapshot()
    if (generation === undefined) {
      return { kind: 'stale', reason: 'the Host connection is not ready' }
    }
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) {
      // Distinguish a confirmed child (a Session-list subagent origin) from a
      // not-yet-materialized root binding. A child must never show the Root tab.
      const row = this.sessions.list.getSnapshot().byId[sessionId]
      if (row?.origin === 'subagent') {
        return {
          kind: 'unavailable',
          cause: 'not-root',
          reason: 'The Team board is available only for the root Session',
        }
      }
      return { kind: 'unavailable', cause: 'session-missing', reason: `Session "${sessionId}" is not available` }
    }
    const identity = this.rootCheck(sessionId, binding.session)
    if (identity !== undefined) return identity
    const parsed = parseProjection(binding.session.projections.faceOf(AGENT_TEAM_KEY).getSnapshot())
    // A reconnect or a same-id rebind between the reads must never be served as
    // one cut: re-validate both fences before returning.
    if (!Object.is(generation, this.generation.getSnapshot())
      || !Object.is(binding, this.sessions.binding(sessionId))) {
      return { kind: 'stale', reason: 'the Host connection changed while reading the Team board' }
    }
    if (parsed.kind === 'unreadable') {
      return { kind: 'stale', reason: 'the Agent Team board projection is not readable' }
    }
    return parsed
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let faceOffs: Array<() => void> = []
    let lastBinding: unknown
    /** (Re)arm the `agentTeam` face against the CURRENT binding. */
    const rearm = (force: boolean): boolean => {
      const binding = this.sessions.binding(sessionId)
      if (!force && Object.is(binding, lastBinding)) return false
      for (const off of faceOffs.splice(0)) off()
      lastBinding = binding
      if (binding === undefined) return true
      try {
        faceOffs.push(binding.session.projections.faceOf(AGENT_TEAM_KEY).subscribe(listener))
      } catch (error) {
        for (const off of faceOffs.splice(0)) off()
        throw error
      }
      return true
    }
    // An initially absent binding must not pin the page at Unavailable forever:
    // the Session-list invalidation feed re-arms as soon as the binding arrives.
    rearm(false)
    // A reconnect keeps the retained binding identity stable, but a retired +
    // same-id rebuilt owner produces a NEW face; re-arm on every generation
    // change so a retired binding's callback is never mistaken for current.
    const generationOff = this.generation.subscribe(() => {
      rearm(true)
      listener()
    })
    const listOff = this.sessions.list.subscribe?.(() => {
      if (rearm(false)) listener()
    })
    return () => {
      generationOff()
      listOff?.()
      for (const off of faceOffs.splice(0)) off()
    }
  }

  /**
   * Fail closed unless the exact binding is a readable root Session. The real
   * Client SessionFace exposes its lifecycle snapshot; a structural stand-in
   * that does not falls back to the official Session-list origin (a child row
   * proves the root-only refusal; an absent row leaves the identity unknown).
   */
  private rootCheck(
    sessionId: string,
    session: RemoteTeamBoardSessionFace,
  ): TeamBoardSnapshot | undefined {
    if (typeof session.getSnapshot === 'function') {
      const lifecycle = session.getSnapshot()
      if (lifecycle.removed === true) {
        return { kind: 'stale', reason: 'the Session was removed' }
      }
      if (!Object.hasOwn(lifecycle, 'subagent')) {
        return { kind: 'unavailable', cause: 'session-missing', reason: 'the root Session identity is not readable' }
      }
      if (lifecycle.subagent !== null) {
        return {
          kind: 'unavailable',
          cause: 'not-root',
          reason: 'The Team board is available only for the root Session',
        }
      }
      return undefined
    }
    // Structural stand-in with no lifecycle snapshot: use the official
    // Session-list origin evidence (a child row proves the refusal; an absent
    // row leaves identity unknown, never silently treated as root).
    const row = this.sessions.list.getSnapshot().byId[sessionId]
    if (row?.origin === 'subagent') {
      return {
        kind: 'unavailable',
        cause: 'not-root',
        reason: 'The Team board is available only for the root Session',
      }
    }
    if (row === undefined) {
      return { kind: 'unavailable', cause: 'session-missing', reason: 'the root Session identity is not readable' }
    }
    return undefined
  }
}
