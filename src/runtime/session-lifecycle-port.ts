/**
 * The session LIFECYCLE domain port (D2.1 contract convergence, D2.3
 * semantic convergence): the transport-neutral semantic boundary for
 * creating a fresh Session and opening an existing Session.
 *
 * D2.3 removed the ordinary `provider`/`model` semantic inputs. The official
 * create/open contracts own only current Client/Host concepts (session id,
 * location/preset metadata) and derive the activation model from the Host
 * global default; a Direct adapter that still needs in-process activation
 * options resolves them from the Host default service itself, never from the
 * cross-backend request.
 *
 * Open is the official Client semantic `select/open this Session` — not
 * `resume a Host Agent`. The Direct adapter still calls `agents.resume()`
 * internally so the in-process TUI has a live Agent; a Remote adapter maps
 * the same operation to `ClientSessions.open()/binding()`.
 *
 * `meta` still carries the Direct session-header metadata (cwd, parent session
 * and the seeded marker); `seed`/`inheritedEventCount` remain Direct D2.4
 * fork/rewind inputs and must not be described as an already Remote-ready wire
 * payload. The DIRECT adapter still supports them (fork/rewind rely on it); the
 * REMOTE adapter fails closed on a seeded create until D2.4 owns Host fork.
 *
 * Requests carry serializable data plus the explicitly client-local lifecycle
 * signal. The signal is never serialized; a Remote adapter maps it to its own
 * client/connection cancellation. Results carry Session identity and, only
 * for Direct, the ownership escape needed by the current runner.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-lifecycle-port
 */

/** Create one fresh session (the /new and first-session paths). The identity,
 * cwd-like metadata and preset are semantic intent. The seed, inherited count
 * and parent metadata are current Direct fork/rewind creation inputs; D2.4
 * owns their Host-fork convergence. `signal` is client-local and never
 * serialized. */
export interface CreateSessionRequest {
  /** The pre-generated session identity (the TUI owns the id). */
  sessionId: string
  /** Durable session metadata (currently includes cwd, parent session and the
   * Direct seeded-session marker). D2.4 owns convergence of fork metadata. */
  meta: Record<string, unknown>
  /** Semantic preset intent; the Direct adapter resolves its setup. */
  agentPreset?: string
  /** Current Direct fork/rewind seed; D2.4 owns Host fork convergence. */
  seed?: readonly unknown[]
  /** Current Direct fork/rewind inherited prefix length. */
  inheritedEventCount?: number
  /** Client-local creation cancellation; never serialized. */
  signal?: AbortSignal
}

/** Open a persisted session (the ordinary Client semantic:
 * `select/open this Session`, NOT `resume a Host Agent`). The Direct adapter
 * resolves the persisted preset and activation fallback internally. */
export interface OpenSessionRequest {
  /** The persisted Session identity to open. */
  sessionId: string
  /** Client-local open cancellation; never serialized. */
  signal?: AbortSignal
}

/** The lightweight outcome of a lifecycle operation — the cross-backend
 * session identity. Direct backends additionally carry the ownership escape:
 * the live Agent and real AgentHandle. Remote backends leave `direct`
 * undefined; the client runtime owns the Session there. */
export interface SessionHandle {
  readonly session: { readonly id: string }
  /** Direct-only ownership escape. The runner disposes the real owner handle
   * on retirement; a Remote backend leaves it undefined. */
  readonly direct?: {
    readonly agent: unknown
    readonly ownerHandle: unknown
  }
}

/** The session LIFECYCLE domain port. */
export interface SessionLifecycle {
  create(request: CreateSessionRequest): Promise<SessionHandle>
  open(request: OpenSessionRequest): Promise<SessionHandle>
}

/** Extract the Direct ownership handle (the real AgentHandle with
 * `dispose()`) from a lifecycle result. Accepts both the converged
 * SessionHandle and a legacy AgentHandle so transition code cannot lose the
 * ownership capability. Remote handles lack `direct` and yield undefined. */
export function ownerHandleOf(next: unknown): unknown {
  const handle = next as { dispose?: unknown; direct?: { ownerHandle?: unknown } }
  if (handle.direct?.ownerHandle !== undefined) return handle.direct.ownerHandle
  if (typeof handle.dispose === 'function') return handle
  return undefined
}

/** Extract the live in-process agent from a lifecycle result (the Direct
 * SessionHandle via `direct.agent`, or a legacy AgentHandle's `agent`).
 * Remote handles yield undefined. */
export function directAgentOf(next: unknown): unknown {
  const handle = next as { agent?: unknown; direct?: { agent?: unknown } }
  return handle.direct?.agent ?? handle.agent
}
