/**
 * The session LIFECYCLE domain port (M1.5, contract-reviewed) — the
 * semantic contract between the TUI and session creation/resumption,
 * implemented by `src/runtime/direct/` (Direct) today and by a Remote
 * adapter in a later milestone. The contract is deliberately
 * transport-neutral:
 *
 * - Requests carry SERIALIZABLE data only (session id, provider/model,
 *   preset id, seed, meta) — never callbacks. A Remote adapter maps them
 *   to the official DSH API.
 * - The result is a lightweight `SessionHandle` (session identity plus an
 *   optional Direct-only agent escape) — never the in-process
 *   `AgentHandle` object.
 * - The Direct adapter resolves the preset composition (which builds the
 *   agent-setup callback) INTERNALLY; the runner keeps its preflight
 *   compose for lock-ordering and passes the preset id through the
 *   request.
 *
 * The runner keeps the Direct-mode ownership machinery (owner.lock,
 * lease/cooling, PINNED, transition gate, operation barrier) around the
 * port calls — those are M8 territory and never move here.
 *
 * Fork and rewind are NOT separate port methods: they ride the
 * dependency-injected seams in src/session-fork.ts (ForkAgentHost) and
 * src/rewind.ts, and the runner wires their `agents` surface through this
 * port's create/resume.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-lifecycle-port
 */

/** Create one fresh session (the /new and first-session paths). All fields
 * are serializable — never callbacks. */
export interface CreateSessionRequest {
  /** The pre-generated session identity (the TUI owns the id). */
  sessionId: string
  /** Durable session metadata (cwd, parent session, seed length, ...). */
  meta: Record<string, unknown>
  provider?: string
  model?: string
  /** The agent preset id the session runs on (undefined = deployment
   * default); the Direct adapter composes the setup from it. */
  agentPreset?: string
  /** The seed events (fork/rewind); a Remote backend maps them to its own
   * seed contract. */
  seed?: readonly unknown[]
  /** Creation-only cancellation; the handle detaches on publication. */
  signal?: AbortSignal
}

/** Resume a persisted session (the ordinary open path). */
export interface ResumeSessionRequest {
  resumeSessionId: string
  provider?: string
  model?: string
  /** The recorded preset id (resolved from the session log); the Direct
   * adapter composes the setup from it. */
  agentPreset?: string
}

/** The lightweight outcome of a lifecycle operation — the cross-backend
 * session identity. Direct backends additionally carry the live in-process
 * agent through the Direct-only escape. */
export interface SessionHandle {
  readonly session: { readonly id: string }
  /** DIRECT-ONLY escape: the live in-process agent object. Remote
   * backends leave this undefined — the client runtime owns the session
   * there. The runner (Direct mode) extracts it to drive its transition
   * machinery; the contract itself never types the Host object. */
  readonly directAgent?: unknown
}

/** The session LIFECYCLE domain port. */
export interface SessionLifecycle {
  create(request: CreateSessionRequest): Promise<SessionHandle>
  resume(request: ResumeSessionRequest): Promise<SessionHandle>
}