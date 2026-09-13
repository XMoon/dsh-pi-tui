/**
 * The session LIFECYCLE domain port (D2.1 contract convergence): the
 * transport-neutral semantic boundary for creating a fresh Session and
 * opening an existing Session. Direct implements `open()` with the Host's
 * `agents.resume()` detail today; a future Remote adapter maps the same
 * semantic operation to official ClientSessions.open()/binding().
 *
 * The request types are transitional. `sessionId`, metadata such as cwd and
 * the preset id express current semantic intent. Provider/model are still
 * Direct activation inputs and D2.3 owns their convergence to official
 * Session-local selection. Seed/inheritedEventCount/parent metadata remain
 * Direct fork/rewind creation inputs and D2.4 owns their retirement in favor
 * of Host session.fork. These fields must not be described as an already
 * Remote-ready wire payload.
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
 * cwd-like metadata and preset are semantic intent. The provider/model fields
 * are current Direct activation inputs; D2.3 owns their convergence. The seed,
 * inherited count and parent metadata are current Direct fork/rewind inputs;
 * D2.4 owns their retirement. `signal` is client-local and never serialized. */
export interface CreateSessionRequest {
  /** The pre-generated session identity (the TUI owns the id). */
  sessionId: string
  /** Durable session metadata (currently includes cwd, parent session and the
   * Direct seeded-session marker). D2.4 owns convergence of fork metadata. */
  meta: Record<string, unknown>
  /** Current Direct activation fallback; D2.3 owns Session-local selection. */
  provider?: string
  /** Current Direct activation fallback; D2.3 owns Session-local selection. */
  model?: string
  /** Semantic preset intent; the Direct adapter resolves its setup. */
  agentPreset?: string
  /** Current Direct fork/rewind seed; D2.4 owns Host fork convergence. */
  seed?: readonly unknown[]
  /** Current Direct fork/rewind inherited prefix length. */
  inheritedEventCount?: number
  /** Client-local creation cancellation; never serialized. */
  signal?: AbortSignal
}

/** Open a persisted session (the ordinary Client semantic). The Direct
 * adapter still maps this to `agents.resume()` until lifecycle convergence. */
export interface OpenSessionRequest {
  /** The persisted Session identity to open. The field retains the current
   * Direct request spelling until the lifecycle payload converges. */
  resumeSessionId: string
  /** Current Direct activation fallback; D2.3 owns Session-local selection. */
  provider?: string
  /** Current Direct activation fallback; D2.3 owns Session-local selection. */
  model?: string
  /** Semantic preset intent; the Direct adapter resolves its setup. */
  agentPreset?: string
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
