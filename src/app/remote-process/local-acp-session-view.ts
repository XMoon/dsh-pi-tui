/**
 * Connection-scoped Host ACP Session View.
 *
 * The Host-owned local ACP v1 listener (PO-1/PO-1B) is a protocol front door
 * that owns NO Agent, Session or business method. PO-2 adds the narrowest
 * shared-Session capability on top of that same `<scope.dir>/acp.sock`: one
 * ACP connection may BORROW at most one live Host Session, while the Session's
 * own Agent/Session/Writer authority stays entirely with the official Host
 * services. This module owns ONLY the ephemeral, per-listener reservation map
 * and the pure connection View lifecycle; it never subscribes to, resumes on
 * its own, cancels, disposes or flushes any Host Agent, and it never persists
 * an ACP mapping.
 *
 * The authority boundaries this module must respect:
 *   - Session create/resume is `sessionController.create` / `resolveAgent`
 *     (the SAME Host services), never `ctx.agents.create/resume`.
 *   - The Host Workspace Controller is the only directory authority for
 *     `session/new`; the client cwd is a proposal only.
 *   - `close` detaches ONLY this connection's View. It never touches a shared
 *     Agent so a human Split TUI Client that also references the Session keeps
 *     working, and a later connection may attach again.
 *
 * A single connection follows the transient protocol view
 * `idle -> attaching -> attached -> idle|closed`. The reservation is committed
 * with a synchronous `Map.set()` BEFORE any official Host await, so a second
 * request on the same connection, or a competing connection, is refused before
 * it can create a second Host business resource. A late async result only
 * commits when its own connection state is still the same live one.
 *
 * @module app/remote-process/local-acp-session-view
 */

import type { Diag } from '../../runtime/process/diagnostics.ts'

/** The exact live identity a borrowed Session View is allowed to believe. */
export interface LiveAgentViewIdentity {
  /** The live Agent id (== the Session id). */
  readonly id: string
  /** The live Session object the Agent currently drives. */
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
  }
}

/**
 * The result of registering the client's proposed directory as a Host
 * Workspace. The classification is decided by the HOST fact, never by which
 * `await` happened to throw: a definite client-directory rejection is
 * `rejected`; a persistence/registry failure that cannot confirm the outcome is
 * `indeterminate`; success is `created`.
 */
export type AcpCreateWorkspaceOutcome =
  | { readonly kind: 'created'; readonly workspaceId: string; readonly path: string }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'indeterminate'; readonly code: string }

/**
 * The result of creating ONE Host Session. `published-with-error` is the
 * official `SessionController.create()` "Session was authored, a later step
 * failed" outcome (e.g. `session/workspace-attach-failed`): the Session EXISTS
 * with the returned authoritative id even though the call failed, so its real
 * identity is preserved instead of being reported as unconfirmed.
 */
export type AcpCreateSessionOutcome =
  | { readonly kind: 'created'; readonly sessionId: string }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'published-with-error'; readonly sessionId: string; readonly code: string }
  | { readonly kind: 'indeterminate'; readonly code: string }

/**
 * The narrow Host access this module is allowed to call. `local-host-entry.ts`
 * binds each callable from the already-settled Host Context; this module never
 * receives the Context, an Agent, a Session or any registry directly.
 */
export interface HostAcpSessionAccess {
  /** Register or resolve the client's proposed absolute directory as a Host Workspace. */
  createWorkspace(path: string): Promise<AcpCreateWorkspaceOutcome>
  /** Create ONE Host Session as a member of a Host Workspace, classified by the Host result. */
  createSession(workspaceId: string): Promise<AcpCreateSessionOutcome>
  /** Resolve (live-first, cold single resume) one Session to its live Agent. */
  resolveAgent(sessionId: string): Promise<
    { agent: LiveAgentViewIdentity } | { error: { code: string; message: string } }
  >
  /** The CURRENT live Agent for a Session, or `undefined`. */
  currentAgent(sessionId: string): LiveAgentViewIdentity | undefined
  /** The CURRENT live Session object for a Session id, or `undefined`. */
  currentSession(sessionId: string): object | undefined
}

/**
 * The stable View failure codes. They are the internal Host contract the
 * qualification asserts; they never carry a path, token or exception text.
 */
export type LocalAcpViewErrorCode =
  | 'LOCAL_ACP_VIEW_INVALID_REQUEST'
  | 'LOCAL_ACP_VIEW_NOT_INITIALIZED'
  | 'LOCAL_ACP_VIEW_BUSY'
  | 'LOCAL_ACP_VIEW_ALREADY_ATTACHED'
  | 'LOCAL_ACP_VIEW_NOT_OWNED'
  | 'LOCAL_ACP_VIEW_SESSION_NOT_FOUND'
  | 'LOCAL_ACP_VIEW_SUBAGENT_OWNED'
  | 'LOCAL_ACP_VIEW_WRITER_HELD'
  | 'LOCAL_ACP_VIEW_WORKSPACE_REJECTED'
  | 'LOCAL_ACP_VIEW_WORKSPACE_UNAVAILABLE'
  | 'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE'
  | 'LOCAL_ACP_VIEW_CREATE_ATTACH_FAILED'
  | 'LOCAL_ACP_VIEW_CREATE_INDETERMINATE'
  | 'LOCAL_ACP_VIEW_HOST_ERROR'
  | 'LOCAL_ACP_VIEW_CLOSED'

/**
 * One classified View rejection. `rpcCode` is the JSON-RPC error code the
 * listener maps onto an ACP `RequestError`; `code` is the stable data code.
 * `data` carries non-sensitive structured facts the caller may act on — most
 * importantly the authoritative `sessionId` of a Session the Host already
 * created before a later step failed.
 */
export class LocalAcpViewError extends Error {
  readonly code: LocalAcpViewErrorCode
  readonly rpcCode: number
  readonly data: Readonly<Record<string, unknown>>

  constructor(
    code: LocalAcpViewErrorCode,
    message: string,
    rpcCode: number,
    data: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'LocalAcpViewError'
    this.code = code
    this.rpcCode = rpcCode
    this.data = data
  }
}

/** The minimal `session/new` request facts this module validates. */
export interface AcpNewSessionParams {
  readonly cwd: string
  readonly additionalDirectories?: readonly string[]
  readonly mcpServers: readonly unknown[]
}

/** The minimal `session/resume` request facts this module validates. */
export interface AcpResumeSessionParams {
  readonly sessionId: string
  readonly cwd: string
  readonly additionalDirectories?: readonly string[]
  readonly mcpServers?: readonly unknown[]
}

/** One connection's transient protocol view state. */
export interface ConnectionViewState {
  phase: 'idle' | 'attaching' | 'attached' | 'closed'
  /** The last Session this connection closed, so a repeated close stays idempotent. */
  lastClosedSessionId?: string
  /**
   * Monotonic attach-operation generation. `beginAttach` bumps it; every async
   * continuation may mutate `phase`/`claims` ONLY while its captured generation
   * is still current, so a late result from a superseded/closed/disconnected
   * operation can never clobber a newer operation's transient state.
   */
  op: number
}

/** One reservation held by exactly one connection. Its object identity IS the reservation identity. */
interface ViewClaim {
  readonly connectionIdentity: ConnectionViewState
  readonly sessionId: string
}

const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603

/**
 * The pure View/claim lifecycle for ONE listener lifetime. A fresh registry is
 * created on every `setEnabled(true)` bind; a rebind never shares a previous
 * connection's claims.
 */
export class AcpSessionViewRegistry {
  private readonly claims = new Map<string, ViewClaim>()
  private readonly diag: Diag

  constructor(diag: Diag) {
    this.diag = diag
  }

  /** Create a fresh connection-scoped view state. */
  createConnection(): ConnectionViewState {
    return { phase: 'idle', op: 0 }
  }

  /** The number of live reservations/attachments (qualification diagnosis only). */
  claimCount(): number {
    return this.claims.size
  }

  /** Whether a Session is currently reserved or attached by ANY connection. */
  hasClaim(sessionId: string): boolean {
    return this.claims.has(sessionId)
  }

  /** The current phase of one connection (qualification diagnosis only). */
  phaseOf(state: ConnectionViewState): ConnectionViewState['phase'] {
    return state.phase
  }

  /**
   * Attach a freshly created Host Session to this connection's View. `session/new`
   * creates ONE Host Workspace, then ONE Host Session, then borrows the official
   * live Agent. The failure category is decided by the HOST result: a definite
   * directory rejection, a peer-visible attachment failure that PRESERVES the
   * real created Session id, an unconfirmed outcome, or success. It is never
   * retried and never rolled back.
   */
  async newSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpNewSessionParams,
  ): Promise<{ sessionId: string }> {
    const op = this.beginAttach(state)
    try {
      this.validateNew(request)
    } catch (error) {
      this.resetIdleIfCurrent(state, op)
      throw error
    }

    const workspace = await access.createWorkspace(request.cwd)
    if (workspace.kind === 'rejected') {
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_WORKSPACE_REJECTED', 'the Host refused the proposed workspace directory', JSONRPC_INVALID_PARAMS)
    }
    if (workspace.kind === 'indeterminate') {
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_WORKSPACE_UNAVAILABLE', 'the Host could not register the workspace; the outcome is unconfirmed', JSONRPC_INTERNAL_ERROR)
    }
    if (!this.isCurrentOp(state, op)) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP connection closed before the session was created', JSONRPC_INVALID_PARAMS)
    }

    // ONE Host Session create per request: never a second attempt on failure.
    const created = await access.createSession(workspace.workspaceId)
    if (created.kind === 'rejected') {
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'the Host rejected the session create request', JSONRPC_INVALID_PARAMS)
    }
    if (created.kind === 'published-with-error') {
      // The Session EXISTS with this authoritative id; a later Host step (e.g.
      // `workspace.attachSession`) failed. Preserve the real identity so the
      // client can recover the exact Session instead of being told "unknown".
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_CREATE_ATTACH_FAILED',
        'the Host created the session but a later step failed',
        JSONRPC_INTERNAL_ERROR,
        { sessionId: created.sessionId },
      )
    }
    if (created.kind === 'indeterminate') {
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_CREATE_INDETERMINATE',
        'the Host did not confirm the new session; it may or may not exist',
        JSONRPC_INTERNAL_ERROR,
      )
    }
    const sessionId = created.sessionId
    if (!this.isCurrentOp(state, op)) {
      // The Session exists on the Host but this connection is already gone (or a
      // newer operation owns it); do not hold a claim for a dead/superseded op.
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP connection closed before the session view attached', JSONRPC_INVALID_PARAMS, { sessionId })
    }
    if (this.claims.has(sessionId)) {
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_ALREADY_ATTACHED', 'the new session is already attached to an ACP view', JSONRPC_INVALID_PARAMS)
    }

    // Reserve the brand-new id synchronously BEFORE the identity await.
    const claim: ViewClaim = { connectionIdentity: state, sessionId }
    this.claims.set(sessionId, claim)
    // resolveForView carries the authoritative { sessionId } on failure, so a
    // failed Agent borrow after a CONFIRMED create still preserves the identity.
    const agent = await this.resolveForView(access, state, op, claim)
    this.commitAttached(state, op, claim, access, agent)
    return { sessionId }
  }

  /**
   * Attach an EXISTING Session to this connection's View. The official
   * `resolveAgent` is the only cold-resume owner; a live Session borrows the
   * same Agent object. The request cwd never changes the Host Session.
   */
  async resumeSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpResumeSessionParams,
  ): Promise<Record<string, never>> {
    const op = this.beginAttach(state)
    try {
      this.validateResume(request)
    } catch (error) {
      this.resetIdleIfCurrent(state, op)
      throw error
    }
    const sessionId = request.sessionId
    if (this.claims.has(sessionId)) {
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_ALREADY_ATTACHED', 'the session is already attached to an ACP view', JSONRPC_INVALID_PARAMS)
    }
    const claim: ViewClaim = { connectionIdentity: state, sessionId }
    this.claims.set(sessionId, claim)
    const agent = await this.resolveForView(access, state, op, claim)
    // cwd is a claim proposal only; a difference is a fixed non-sensitive note,
    // never a Host cwd/model/workspace change.
    if (agent.session.header.cwd !== request.cwd) {
      this.diag.warn('local-acp.view.cwd-mismatch', { mismatch: true })
    }
    this.commitAttached(state, op, claim, access, agent)
    return {}
  }

  /**
   * Detach ONLY this connection's View for one Session. The Host Agent and
   * Session stay alive; a repeated close on the same connection is idempotent.
   * No other connection's claim and no Host Agent lifecycle is touched.
   */
  closeSession(state: ConnectionViewState, sessionId: string): Record<string, never> {
    const claim = this.claims.get(sessionId)
    if (claim !== undefined && claim.connectionIdentity === state) {
      this.claims.delete(sessionId)
      // This close also cancels any in-flight attach for this connection: the
      // op generation is unchanged, but the claim is gone and the phase is idle,
      // so the pending continuation sees `!isCurrentOp`/`claims.get !== claim`
      // and never commits.
      state.phase = 'idle'
      state.lastClosedSessionId = sessionId
      return {}
    }
    if (state.lastClosedSessionId === sessionId) return {}
    throw new LocalAcpViewError('LOCAL_ACP_VIEW_NOT_OWNED', 'this ACP connection holds no view for that session', JSONRPC_INVALID_PARAMS)
  }

  /**
   * Release every claim owned by one connection and mark it closed. Used by
   * BOTH an explicit `session/close` teardown path and a physical `socket`
   * end/error/destroy or Host Off; it is idempotent and never touches another
   * connection's claim or any Host Agent/Session.
   */
  releaseConnection(state: ConnectionViewState): void {
    state.phase = 'closed'
    // Bump the generation so any in-flight continuation is treated as stale and
    // can never mutate this (closed) connection's state.
    state.op += 1
    for (const [sessionId, claim] of this.claims) {
      if (claim.connectionIdentity === state) this.claims.delete(sessionId)
    }
  }

  /**
   * Enforce `idle -> attaching` BEFORE any Host await; a busy/closed view
   * refuses. Returns the attach-operation generation captured by the caller.
   */
  private beginAttach(state: ConnectionViewState): number {
    if (state.phase === 'closed') {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP connection is closed', JSONRPC_INVALID_PARAMS)
    }
    if (state.phase !== 'idle') {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_BUSY', 'this ACP connection already holds or is attaching a view', JSONRPC_INVALID_PARAMS)
    }
    state.op += 1
    state.phase = 'attaching'
    state.lastClosedSessionId = undefined
    return state.op
  }

  /** Whether `op` is still this connection's live attach generation. */
  private isCurrentOp(state: ConnectionViewState, op: number): boolean {
    return state.op === op && state.phase === 'attaching'
  }

  /** Reset to idle ONLY while `op` is still this connection's attaching generation. */
  private resetIdleIfCurrent(state: ConnectionViewState, op: number): void {
    if (state.op === op && state.phase === 'attaching') state.phase = 'idle'
  }

  /**
   * Resolve one Session to its live Agent through the sole official owner,
   * releasing the reservation and classifying every failure. A closed,
   * superseded or already-released operation owns no claim even if its await
   * resolves later, and its continuation never mutates the connection state.
   */
  private async resolveForView(
    access: HostAcpSessionAccess,
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
  ): Promise<LiveAgentViewIdentity> {
    let resolved: Awaited<ReturnType<HostAcpSessionAccess['resolveAgent']>>
    try {
      resolved = await access.resolveAgent(claim.sessionId)
    } catch {
      this.onResolveFailure(state, op, claim)
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_HOST_ERROR',
        'the Host could not resolve the session',
        JSONRPC_INTERNAL_ERROR,
        { sessionId: claim.sessionId },
      )
    }
    if ('error' in resolved) {
      this.onResolveFailure(state, op, claim)
      throw mapResolveError(resolved.error, claim.sessionId)
    }
    if (!this.isCurrentOp(state, op) || this.claims.get(claim.sessionId) !== claim) {
      // A superseded / released / closed operation: drop ONLY this exact claim.
      this.releaseReservation(state, claim)
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_CLOSED',
        'the ACP view was released before it attached',
        JSONRPC_INVALID_PARAMS,
        { sessionId: claim.sessionId },
      )
    }
    return resolved.agent
  }

  /** Release a failed resolution's OWN exact reservation without touching a newer op's claim. */
  private onResolveFailure(state: ConnectionViewState, op: number, claim: ViewClaim): void {
    this.releaseReservation(state, claim)
    this.resetIdleIfCurrent(state, op)
  }

  /**
   * Commit an attached View only when `op` is still the connection's live
   * generation, the claim is still this connection's, AND the borrowed
   * Agent/Session are the EXACT live Host objects. Any mismatch releases ONLY
   * this exact claim instead of publishing a stale View, and never mutates a
   * state now owned by a newer/closed operation.
   */
  private commitAttached(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    agent: LiveAgentViewIdentity,
  ): void {
    if (state.op !== op || this.claims.get(claim.sessionId) !== claim || claim.connectionIdentity !== state) {
      // A newer op owns this connection or the claim was released; the late
      // result is inert and must not change the current transient state.
      this.releaseReservation(state, claim)
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_CLOSED',
        'the ACP view was released before it attached',
        JSONRPC_INVALID_PARAMS,
        { sessionId: claim.sessionId },
      )
    }
    const exact = Object.is(access.currentAgent(claim.sessionId), agent)
      && Object.is(access.currentSession(claim.sessionId), agent.session)
    if (!exact) {
      this.releaseReservation(state, claim)
      this.resetIdleIfCurrent(state, op)
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE',
        'the resolved session agent is no longer the live Host agent',
        JSONRPC_INTERNAL_ERROR,
        { sessionId: claim.sessionId },
      )
    }
    state.phase = 'attached'
  }

  /**
   * Remove ONE exact reservation. Identity is by the CLAIM OBJECT (and its
   * owning connection), never by `sessionId` alone: a close-then-re-attach of
   * the SAME Session produces a NEW claim for the same connection+sessionId, so
   * a stale operation's late release must not delete the newer claim.
   */
  private releaseReservation(state: ConnectionViewState, claim: ViewClaim): void {
    if (this.claims.get(claim.sessionId) === claim && claim.connectionIdentity === state) {
      this.claims.delete(claim.sessionId)
    }
  }

  private validateNew(request: AcpNewSessionParams): void {
    validateCwd(request.cwd)
    if (request.mcpServers.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP MCP servers are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP additional directories are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
  }

  private validateResume(request: AcpResumeSessionParams): void {
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'a non-empty sessionId is required', JSONRPC_INVALID_PARAMS)
    }
    validateCwd(request.cwd)
    if (request.mcpServers !== undefined && request.mcpServers.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP MCP servers are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP additional directories are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
  }
}

/** A `session/new|resume` cwd is a non-empty Linux absolute path with no NUL. */
function validateCwd(cwd: string): void {
  if (typeof cwd !== 'string' || cwd.length === 0 || !cwd.startsWith('/') || cwd.includes('\u0000')) {
    throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'cwd must be a non-empty absolute path', JSONRPC_INVALID_PARAMS)
  }
}

/** Map an official Session-domain failure onto a stable View rejection. */
function mapResolveError(error: { code: string; message: string }, sessionId: string): LocalAcpViewError {
  const data = { sessionId }
  switch (error.code) {
    case 'session/not-found':
      return new LocalAcpViewError('LOCAL_ACP_VIEW_SESSION_NOT_FOUND', 'the session does not exist on this Host', JSONRPC_INVALID_PARAMS, data)
    case 'session/agent-busy':
      return new LocalAcpViewError('LOCAL_ACP_VIEW_SUBAGENT_OWNED', 'the session is owned by subagent routing', JSONRPC_INVALID_PARAMS, data)
    case 'session/writer-held':
      return new LocalAcpViewError('LOCAL_ACP_VIEW_WRITER_HELD', 'the session is written by another owner', JSONRPC_INVALID_PARAMS, data)
    default:
      return new LocalAcpViewError('LOCAL_ACP_VIEW_HOST_ERROR', 'the Host could not resolve the session', JSONRPC_INTERNAL_ERROR, data)
  }
}
