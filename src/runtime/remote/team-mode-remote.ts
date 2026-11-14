/**
 * The Remote `TeamModePort`: the official generated `agentTeams` Client
 * namespace behind the shared Team semantic contract, over the ONE
 * authenticated Connection and the ONE Client Session binding.
 *
 * Reads are exact-Session projection reads: the `agentTeam` face owns the
 * saved selection, the `modelSelection` face owns the model-request history and
 * the Session snapshot's subagent address proves Root identity. A missing
 * binding/generation is a truthful `unavailable`/`stale`, never a Direct
 * fallback and never a second transport.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/team-mode-remote
 */

import type { TeamModePort, TeamModeSnapshot, TeamModeWriteOutcome } from '../team-mode-port.ts'
import { SupersededReadError } from '../read-error.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import { copyFailureDetails, remoteFailureCode, remoteFailureMessage } from './write-failure.ts'
import { GATEWAY_PRE_INVOCATION_CODES } from '../write-outcome.ts'
import type { RemoteWriteFailure } from './write-failure.ts'

const AGENT_TEAM_KEY = 'agentTeam'
const MODEL_SELECTION_KEY = 'modelSelection'

/**
 * Team's OWN post-dispatch classifier.
 *
 * The shared `classifyRemoteWriteFailure` treats any domain code as a proven
 * refusal, which is wrong after dispatch: the official `setEnabled` appends the
 * `team/mode` record BEFORE `sessions.flush()`, and flush can throw a listener
 * error carrying a domain code after the append. The generated Client also
 * re-checks the AbortSignal after the RPC returns, so a `gateway/cancelled`
 * arriving here does NOT prove the Host write did not land. Only codes the Host
 * provably raises BEFORE appending (the Root refusal) or the Gateway's
 * pre-invocation admission codes are safe `rejected`; everything else is
 * `indeterminate`.
 */
function classifyTeamWriteFailure(error: unknown): RemoteWriteFailure {
  const code = remoteFailureCode(error)
  const details = copyFailureDetails(error)
  const proven = code !== undefined && (
    code === 'gateway/bad-request'
    || code === 'TEAM_LEAD_REQUIRED'
    || GATEWAY_PRE_INVOCATION_CODES.has(code)
  )
  if (proven) {
    return {
      kind: 'rejected',
      error: { code: code as string, message: remoteFailureMessage(error), ...details === undefined ? {} : { details } },
    }
  }
  return {
    kind: 'indeterminate',
    error: {
      code: code ?? 'agent-team/write-indeterminate',
      message: remoteFailureMessage(error),
      ...details === undefined ? {} : { details },
    },
  }
}


/** One official Client projection face (value deliberately `unknown`). */
export interface RemoteTeamModeProjectionFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** The exact-Session lifecycle facts the Root check consumes. */
export interface RemoteTeamModeSessionSnapshot {
  readonly subagent?: unknown
  readonly removed?: unknown
}

/** The official Client Session binding subset consumed here. */
export interface RemoteTeamModeSessionFace {
  readonly projections: {
    faceOf(key: string): RemoteTeamModeProjectionFace
  }
  /** Present on the real SessionFace; structural stand-ins may omit it. */
  getSnapshot?(): RemoteTeamModeSessionSnapshot
}

/** The official `ClientSessions` identity + binding face. */
export interface RemoteTeamModeSessionsSource {
  binding(sessionId: string): { readonly session: RemoteTeamModeSessionFace } | undefined
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

/** The official generated `agentTeams` namespace (`agentTeams/setEnabled`). */
export interface RemoteTeamModeNamespace {
  setEnabled(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<RemoteResultLike<void>>
}

/** The narrow one-source runtime face this adapter consumes. */
export interface RemoteTeamModeRuntimeSource {
  readonly sessions: RemoteTeamModeSessionsSource
  readonly remote: { readonly agentTeams: RemoteTeamModeNamespace | undefined }
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
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

/** The Remote Team adapter over the official generated namespace. */
export class RemoteTeamModePort implements TeamModePort {
  private readonly sessions: RemoteTeamModeSessionsSource
  private readonly namespace: RemoteTeamModeNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(runtime: RemoteTeamModeRuntimeSource) {
    this.sessions = runtime.sessions
    this.namespace = runtime.remote.agentTeams
    this.generation = runtime.connection.generation
  }

  read(sessionId: string): TeamModeSnapshot {
    const generation = this.generation.getSnapshot()
    if (generation === undefined) {
      return { kind: 'stale', reason: 'the Host connection is not ready' }
    }
    if (this.namespace === undefined) {
      // A readable projection set without the mounted write namespace is NOT a
      // togglable Team mode: the UI must show unavailable, never a dead control.
      return { kind: 'unavailable', reason: 'the Agent Team Remote namespace is not mounted' }
    }
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) {
      return { kind: 'unavailable', reason: `Session "${sessionId}" is not available` }
    }
    const identity = this.rootCheck(sessionId, binding.session)
    if (identity !== undefined) return identity
    const team = teamEnabledOf(binding.session.projections.faceOf(AGENT_TEAM_KEY).getSnapshot())
    const history = modelRequestHistoryOf(binding.session.projections.faceOf(MODEL_SELECTION_KEY).getSnapshot())
    // The two faces and the binding are a synchronous read, but a reconnect or
    // a same-id rebind between the reads must still never be served as one cut.
    if (!Object.is(generation, this.generation.getSnapshot())
      || !Object.is(binding, this.sessions.binding(sessionId))) {
      return { kind: 'stale', reason: 'the Host connection changed while reading the Team state' }
    }
    if (team === undefined) {
      return { kind: 'stale', reason: 'the Agent Team projection is not readable' }
    }
    if (history === undefined) {
      return { kind: 'stale', reason: 'the model request history is not readable' }
    }
    return { kind: 'ready', enabled: team, modelRequestHistory: history }
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let faceOffs: Array<() => void> = []
    let lastBinding: unknown
    /** (Re)arm the two projection faces against the CURRENT binding. */
    const rearm = (force: boolean): boolean => {
      const binding = this.sessions.binding(sessionId)
      if (!force && Object.is(binding, lastBinding)) return false
      for (const off of faceOffs.splice(0)) off()
      lastBinding = binding
      if (binding === undefined) return true
      try {
        faceOffs.push(binding.session.projections.faceOf(AGENT_TEAM_KEY).subscribe(listener))
        faceOffs.push(binding.session.projections.faceOf(MODEL_SELECTION_KEY).subscribe(listener))
      } catch (error) {
        for (const off of faceOffs.splice(0)) off()
        throw error
      }
      return true
    }
    // An initially absent binding must not pin the row at Unavailable forever:
    // the Session-list invalidation feed re-arms as soon as the binding arrives.
    rearm(false)
    // A reconnect keeps the retained binding identity stable, but a retired +
    // same-id rebuilt owner produces NEW faces; re-arm on every generation
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

  async setEnabled(sessionId: string, enabled: boolean, signal: AbortSignal): Promise<TeamModeWriteOutcome> {
    if (signal.aborted) return { kind: 'cancelled', reason: 'the Team mode change was cancelled' }
    if (this.generation.getSnapshot() === undefined) {
      return { kind: 'cancelled', reason: 'the Host connection is not ready' }
    }
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) {
      return { kind: 'rejected', reason: `Session "${sessionId}" is not available` }
    }
    const identity = this.rootCheck(sessionId, binding.session)
    if (identity !== undefined) {
      return { kind: 'rejected', reason: identity.reason }
    }
    if (this.namespace === undefined) {
      return { kind: 'rejected', reason: 'the Agent Team Remote namespace is not mounted' }
    }
    // The official generated method THROWS on a transport/envelope failure and
    // resolves a refusal on its error branch; normalize the throw so a
    // post-dispatch transport failure is classified as indeterminate.
    const result = await this.namespace.setEnabled(sessionId, enabled, signal)
      .catch((error: unknown) => ({ ok: false as const, error }))
    if (result.ok) return { kind: 'committed' }
    const failure = classifyTeamWriteFailure(result.error)
    if (failure.kind === 'cancelled') {
      return { kind: 'cancelled', reason: 'the Team mode change was cancelled' }
    }
    return { kind: failure.kind, reason: failure.error.message }
  }

  /**
   * Fail closed unless the exact binding is a readable root Session. The real
   * Client SessionFace exposes its lifecycle snapshot; a structural stand-in
   * that does not is resolved from the official Session-list origin (a child
   * row proves the root-only refusal, an absent row leaves identity unknown).
   */
  private rootCheck(
    sessionId: string,
    session: RemoteTeamModeSessionFace,
  ): { readonly kind: 'unavailable' | 'stale'; readonly reason: string } | undefined {
    if (typeof session.getSnapshot === 'function') {
      const lifecycle = session.getSnapshot()
      if (lifecycle.removed === true) {
        return { kind: 'stale', reason: 'the Session was removed' }
      }
      if (!Object.hasOwn(lifecycle, 'subagent')) {
        return { kind: 'unavailable', reason: 'the root Session identity is not readable' }
      }
      if (lifecycle.subagent !== null) {
        return { kind: 'unavailable', reason: 'Agent Team mode is available only for the root Session' }
      }
      return undefined
    }
    const row = this.sessions.list.getSnapshot().byId[sessionId]
    if (row === undefined) {
      return { kind: 'unavailable', reason: 'the root Session identity is not readable' }
    }
    if (row.origin === 'subagent') {
      return { kind: 'unavailable', reason: 'Agent Team mode is available only for the root Session' }
    }
    return undefined
  }
}
