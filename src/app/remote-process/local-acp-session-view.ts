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
 * PO-3A adds ONE prompt flight per attached View. The View mints the official
 * `requestId`, submits the official Session Controller prompt exactly once in
 * queue mode, and correlates the real Host facts back to that exact request:
 * `source.rpcId === requestId` at `agent/inbox/inserted`, the claimed
 * `agent/inbox/claimed` turn for that exact message id, and the committed
 * Session events carrying that same `data.turn`. It projects only that turn's
 * committed output as standard ACP `session/update` notifications, drains them,
 * and only then answers a real ACP StopReason. A turn that also claims another
 * user's message is a MIXED turn: no further output is projected and the
 * request fails closed instead of returning a fabricated success.
 *
 * @module app/remote-process/local-acp-session-view
 */

import { randomUUID } from 'node:crypto'
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runDetached } from '../../runtime/process/tasks.ts'

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
  /** Submit ONE prompt through the official Session Controller (queue mode only). */
  prompt(request: AcpSessionPromptRequest, signal: AbortSignal): Promise<{ readonly accepted: true }>
  /**
   * Register the exact Agent/Session facts a prompt flight is correlated
   * against. The subscription belongs to the listener lifetime; the returned
   * disposer removes exactly these listeners.
   */
  observePromptFacts(listener: AcpPromptFactListener): () => void
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
  | 'LOCAL_ACP_VIEW_WORKSPACE_UNAVAILABLE'
  | 'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE'
  | 'LOCAL_ACP_VIEW_CREATE_ATTACH_FAILED'
  | 'LOCAL_ACP_VIEW_CREATE_INDETERMINATE'
  | 'LOCAL_ACP_VIEW_HOST_ERROR'
  | 'LOCAL_ACP_VIEW_CLOSED'

/**
 * The stable prompt-flight failure codes. Each one names ONE Host fact the
 * settlement could prove; none of them is a fabricated ACP StopReason.
 */
export type LocalAcpPromptErrorCode =
  /** This View already owns an unsettled prompt flight. */
  | 'LOCAL_ACP_PROMPT_IN_FLIGHT'
  /** The prompt content was empty, whitespace-only or not a standard text block. */
  | 'LOCAL_ACP_PROMPT_INVALID_CONTENT'
  /** The ACP request/transport aborted before a real Host settlement. */
  | 'LOCAL_ACP_PROMPT_ABORTED'
  /** The Host refused the prompt before accepting it into the Agent inbox. */
  | 'LOCAL_ACP_PROMPT_HOST_REJECTED'
  /** The Host call failed after the message was already inserted: never retried. */
  | 'LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE'
  /** A committed event could not be projected and delivery kept its real failure. */
  | 'LOCAL_ACP_PROMPT_OUTPUT_FAILED'
  /** The bounded View output queue could not keep up with committed events. */
  | 'LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE'
  /** A committed block has no PO-3A standard ACP projection (never truncated). */
  | 'LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT'
  /** The owned turn also claimed another user's message (D23 fail-closed). */
  | 'LOCAL_ACP_PROMPT_MIXED_TURN'
  /** The owned turn ended without a real non-empty assistant text chunk. */
  | 'LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'
  /** The owned turn ended blocked/error/aborted/interrupted or the Agent died. */
  | 'LOCAL_ACP_PROMPT_TURN_FAILED'

/** Every stable local ACP classification the View owner can raise. */
export type LocalAcpSessionErrorCode = LocalAcpViewErrorCode | LocalAcpPromptErrorCode

/**
 * One classified View rejection. `rpcCode` is the JSON-RPC error code the
 * listener maps onto an ACP `RequestError`; `code` is the stable data code.
 * `data` carries non-sensitive structured facts the caller may act on — most
 * importantly the authoritative `sessionId` of a Session the Host already
 * created before a later step failed.
 */
export class LocalAcpViewError extends Error {
  readonly code: LocalAcpSessionErrorCode
  readonly rpcCode: number
  readonly data: Readonly<Record<string, unknown>>

  constructor(
    code: LocalAcpSessionErrorCode,
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

/** One standard text prompt part in the client's original order. */
export interface AcpTextPromptPart {
  readonly type: 'text'
  readonly text: string
}

/**
 * The ONE official Session Controller prompt this View submits per ACP request.
 * `mode: 'queue'` is the only delivery this phase supports and `requestId` is
 * the View-minted identity the official wrapper records as `source.rpcId`.
 */
export interface AcpSessionPromptRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue'
  readonly content: readonly AcpTextPromptPart[]
}

/** The minimal `session/prompt` request facts this module validates. */
export interface AcpPromptSessionParams {
  readonly sessionId: string
  readonly prompt: readonly unknown[]
}

/**
 * The exact Host facts a prompt flight is correlated against. They are read
 * from the official Agent/Session event sources after the settled Host Context
 * registered them; nothing here is inferred from status, text or time.
 */
export interface AcpPromptFactListener {
  /** One message entered the live inbox (synchronous with admission). */
  onInboxInserted(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void
  /** One message was claimed into an open turn. */
  onInboxClaimed(agent: LiveAgentViewIdentity, message: AcpUserMessageLike, turn: number): void
  /** One committed durable Session event. */
  onSessionEvent(session: object, event: AcpSessionEventLike): void
  /** One Agent interval failure carrying the owning turn. */
  onAgentError(agent: LiveAgentViewIdentity, turn: number): void
  /** The exact live Agent was disposed. */
  onAgentDisposed(agent: LiveAgentViewIdentity): void
}

/** The inbox message facts the View reads (`UserMessage` is structurally wider). */
export interface AcpUserMessageLike {
  readonly id: string
  readonly source?: { readonly kind?: string; readonly rpcId?: string }
}

/** The committed Session event facts the View reads (`SessionEvent` is structurally wider). */
export interface AcpSessionEventLike {
  readonly type: string
  readonly data: unknown
}

/** One ACP prompt result: only a real legal stop reason is ever returned. */
export interface AcpPromptResult {
  readonly stopReason: StopReason
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
  /** The exact live Agent object verified at `commitAttached`; `undefined` until attached. */
  exactAgent?: LiveAgentViewIdentity
  /** The exact live Session object verified at `commitAttached`; `undefined` until attached. */
  exactSession?: object
  /** At most ONE unsettled ACP prompt flight, correlated by real Host facts only. */
  inflight?: InflightPrompt
}

/** The maximum number of not-yet-written notifications ONE prompt flight may queue. */
const MAX_PENDING_OUTPUT_UPDATES = 64

/**
 * One unsettled prompt flight. Each field is a DIFFERENT authoritative fact:
 * `requestId` is View-minted, `messageId` comes from the official
 * `agent/inbox/inserted`, `turn` from the official `agent/inbox/claimed`, and
 * `assistantText` only from a committed, non-empty assistant text block.
 */
interface InflightPrompt {
  readonly requestId: string
  phase: 'admitting' | 'queued' | 'claimed' | 'settling'
  messageId?: string
  turn?: number
  /**
   * The most recent turn claimed by a FOREIGN message while this flight had no
   * own turn yet. Claims are monotonic and a same-batch claim emits the
   * foreign message before the queued one, so one marker answers "did the turn
   * that claims me already carry another user's message?".
   */
  foreignTurn?: number
  mixed: boolean
  assistantText: boolean
  pendingUpdates: number
  outputTail: Promise<void>
  readonly sendUpdate: (update: SessionUpdate) => Promise<void>
  readonly settled: PromiseWithResolvers<AcpPromptResult>
  settledDone: boolean
  detachAbort?: () => void
}

const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603

/** One standard classified prompt failure. */
function promptError(
  code: LocalAcpPromptErrorCode,
  message: string,
  rpcCode: number,
  data: Readonly<Record<string, unknown>> = {},
): LocalAcpViewError {
  return new LocalAcpViewError(code, message, rpcCode, data)
}

/** A stable code from a rejecting Host call, never its message or stack. */
function hostErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return undefined
}

/** The committed turn reason facts the View reads (`TurnEndReason` is wider). */
function turnEndReasonKind(data: unknown): string | undefined {
  const reason = (data as { readonly reason?: { readonly kind?: unknown } } | undefined)?.reason
  return typeof reason?.kind === 'string' ? reason.kind : undefined
}

/**
 * The pure View/claim lifecycle for ONE listener lifetime. A fresh registry is
 * created on every `setEnabled(true)` bind; a rebind never shares a previous
 * connection's claims.
 */
export class AcpSessionViewRegistry implements AcpPromptFactListener {
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
    if (workspace.kind === 'indeterminate') {
      // The official Workspace Controller wraps non-path failures as
      // `workspace/invalid-path`, so a failure here can NOT prove whether a
      // partial Workspace/registry change happened. Report the outcome as
      // unconfirmed (never as a definite client directory error).
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
      if (claim.inflight !== undefined) {
        // PO-3A cannot cancel a shared Host turn; pretending the View detached
        // would leave an unanswerable request behind. PO-3B owns that policy.
        throw promptError(
          'LOCAL_ACP_PROMPT_IN_FLIGHT',
          'a prompt is still in flight for this session view',
          JSONRPC_INVALID_PARAMS,
        )
      }
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
   * Admit ONE text prompt on this connection's attached View and settle it on
   * the exact Host facts. The slot and the View-minted `requestId` are committed
   * BEFORE the official prompt call, so a synchronous inbox notice or a second
   * pipelined request can never be attributed to a later flight.
   *
   * The returned promise settles only from real Host facts: the claimed turn of
   * THIS message id, that turn's committed events, its `turn/end`, and the
   * ordered notification drain. No status, text, timestamp or ACK is treated as
   * a completed turn.
   */
  async promptSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpPromptSessionParams,
    requestSignal: AbortSignal,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): Promise<AcpPromptResult> {
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'a non-empty sessionId is required', JSONRPC_INVALID_PARAMS)
    }
    const claim = this.claims.get(request.sessionId)
    if (
      state.phase !== 'attached'
      || claim === undefined
      || claim.connectionIdentity !== state
      || claim.exactAgent === undefined
      || claim.exactSession === undefined
    ) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_NOT_OWNED', 'this ACP connection holds no view for that session', JSONRPC_INVALID_PARAMS)
    }
    if (claim.inflight !== undefined) {
      throw promptError('LOCAL_ACP_PROMPT_IN_FLIGHT', 'a prompt is already in flight for this session view', JSONRPC_INVALID_PARAMS)
    }
    const content = validatePromptContent(request.prompt)
    if (requestSignal.aborted) {
      throw promptError('LOCAL_ACP_PROMPT_ABORTED', 'the ACP prompt request was aborted before admission', JSONRPC_INVALID_PARAMS)
    }

    const flight: InflightPrompt = {
      requestId: randomUUID(),
      phase: 'admitting',
      mixed: false,
      assistantText: false,
      pendingUpdates: 0,
      outputTail: Promise.resolve(),
      sendUpdate,
      settled: Promise.withResolvers<AcpPromptResult>(),
      settledDone: false,
    }
    const onAbort = (): void => {
      this.failPrompt(claim, flight, promptError(
        'LOCAL_ACP_PROMPT_ABORTED',
        'the ACP prompt request was aborted before a real Host settlement',
        JSONRPC_INTERNAL_ERROR,
      ))
    }
    requestSignal.addEventListener('abort', onAbort, { once: true })
    flight.detachAbort = () => requestSignal.removeEventListener('abort', onAbort)
    claim.inflight = flight

    try {
      await access.prompt({
        requestId: flight.requestId,
        sessionId: request.sessionId,
        mode: 'queue',
        content,
      }, requestSignal)
      if (!flight.settledDone) flight.phase = 'queued'
    } catch (error) {
      if (!flight.settledDone) {
        if (flight.messageId !== undefined) {
          // The official call rejected AFTER the message entered the live
          // inbox: the prompt may already be queued forever. Never retry and
          // never report a definite "not accepted".
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE',
            'the Host prompt outcome could not be confirmed after dispatch; it was not retried',
            JSONRPC_INTERNAL_ERROR,
          ))
        } else {
          const hostCode = hostErrorCode(error)
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_HOST_REJECTED',
            'the Host did not accept the prompt',
            JSONRPC_INTERNAL_ERROR,
            hostCode === undefined ? {} : { hostCode },
          ))
        }
      }
    }
    return await flight.settled.promise
  }

  /** One message entered the live inbox: correlate the View-minted request id. */
  onInboxInserted(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void {
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent) continue
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone || flight.messageId !== undefined) continue
      if (message.source?.kind === 'user' && message.source.rpcId === flight.requestId) {
        flight.messageId = message.id
      }
    }
  }

  /**
   * One message was claimed. The exact message id (never text or timing) links
   * the prompt to its turn; any other user message claimed into that same turn
   * proves the turn is MIXED.
   */
  onInboxClaimed(agent: LiveAgentViewIdentity, message: AcpUserMessageLike, turn: number): void {
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent) continue
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (flight.messageId !== undefined && message.id === flight.messageId) {
        if (flight.turn === undefined) {
          flight.turn = turn
          if (flight.phase === 'admitting' || flight.phase === 'queued') flight.phase = 'claimed'
          if (flight.foreignTurn === turn) flight.mixed = true
          flight.foreignTurn = undefined
        }
        continue
      }
      if (flight.turn !== undefined) {
        if (flight.turn === turn) flight.mixed = true
        continue
      }
      flight.foreignTurn = turn
    }
  }

  /**
   * One committed Session event. Only the exact Session object and the owned
   * turn are projected; every other event is inert for this View.
   */
  onSessionEvent(session: object, event: AcpSessionEventLike): void {
    for (const claim of this.claims.values()) {
      if (claim.exactSession !== session) continue
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) return
      const data = event.data as { readonly turn?: unknown } | undefined
      if (typeof data?.turn !== 'number' || flight.turn === undefined || data.turn !== flight.turn) return
      if (flight.mixed) {
        // A mixed turn projects NOTHING further; it can only settle as a
        // failure once the turn reaches its own terminal record.
        if (event.type === 'turn/end') this.settleTurnEnd(claim, flight, data)
        return
      }
      switch (event.type) {
        case 'assistant/message':
          this.projectAssistantMessage(claim, flight, data)
          break
        case 'tool/call':
          this.projectToolCall(claim, flight, data)
          break
        case 'tool/result':
          this.projectToolResult(claim, flight, data)
          break
        case 'turn/end':
          this.settleTurnEnd(claim, flight, data)
          break
        default:
          break
      }
      return
    }
  }

  /** One Agent interval failure: only the owned turn of the exact Agent is attributed. */
  onAgentError(agent: LiveAgentViewIdentity, turn: number): void {
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent) continue
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (flight.turn !== undefined && flight.turn === turn) {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_TURN_FAILED',
          'the owned turn reported an Agent failure',
          JSONRPC_INTERNAL_ERROR,
          { reason: 'agent-error' },
        ))
      }
    }
  }

  /** The exact live Agent was disposed: its in-flight prompt can never settle. */
  onAgentDisposed(agent: LiveAgentViewIdentity): void {
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent) continue
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      this.failPrompt(claim, flight, promptError(
        'LOCAL_ACP_PROMPT_TURN_FAILED',
        'the owned Agent was disposed before the prompt settled',
        JSONRPC_INTERNAL_ERROR,
        { reason: 'agent-disposed' },
      ))
    }
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
      if (claim.connectionIdentity !== state) continue
      const flight = claim.inflight
      if (flight !== undefined) {
        // A physical connection end cannot answer the ACP request any more and
        // must not cancel the shared Host turn; the flight settles as failed
        // and this View stops projecting. The Host Agent keeps running.
        this.failPrompt(claim, flight, new LocalAcpViewError(
          'LOCAL_ACP_VIEW_CLOSED',
          'the ACP connection closed before the prompt settled',
          JSONRPC_INTERNAL_ERROR,
        ))
      }
      this.claims.delete(sessionId)
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
    // The verified exact objects are the identity fence every prompt claim and
    // committed event is checked against; never a sessionId lookup.
    claim.exactAgent = agent
    claim.exactSession = agent.session
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

  /** Project one committed assistant message of the owned turn in block order. */
  private projectAssistantMessage(claim: ViewClaim, flight: InflightPrompt, data: unknown): void {
    const message = (data as { readonly message?: { readonly id?: unknown; readonly content?: unknown } }).message
    if (message === undefined || typeof message.id !== 'string' || !Array.isArray(message.content)) {
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    const updates: SessionUpdate[] = []
    for (const block of message.content as readonly unknown[]) {
      const type = (block as { readonly type?: unknown } | null)?.type
      const text = (block as { readonly text?: unknown } | null)?.text
      if (type === 'reasoning') {
        if (typeof text !== 'string') {
          this.failPrompt(claim, flight, unsupportedContent())
          return
        }
        if (text.length > 0) updates.push({ sessionUpdate: 'agent_thought_chunk', messageId: message.id, content: { type: 'text', text } })
        continue
      }
      if (type === 'text') {
        if (typeof text !== 'string') {
          this.failPrompt(claim, flight, unsupportedContent())
          return
        }
        if (text.length === 0) continue
        updates.push({ sessionUpdate: 'agent_message_chunk', messageId: message.id, content: { type: 'text', text } })
        flight.assistantText = true
        continue
      }
      // Images/audio/unknown blocks belong to PO-4: never truncate or fake one.
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    this.enqueueUpdates(claim, flight, updates)
  }

  /** Project one committed tool call of the owned turn as a standard start update. */
  private projectToolCall(claim: ViewClaim, flight: InflightPrompt, data: unknown): void {
    const call = data as { readonly callId?: unknown; readonly name?: unknown; readonly arguments?: unknown }
    if (typeof call.callId !== 'string' || typeof call.name !== 'string') {
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    const rawInput = typeof call.arguments === 'string' ? parseToolArguments(call.arguments) : undefined
    this.enqueueUpdates(claim, flight, [{
      sessionUpdate: 'tool_call',
      toolCallId: call.callId,
      title: call.name,
      kind: 'other',
      status: 'in_progress',
      ...(rawInput === undefined ? {} : { rawInput }),
    }])
  }

  /** Project one committed tool result of the owned turn, text content only. */
  private projectToolResult(claim: ViewClaim, flight: InflightPrompt, data: unknown): void {
    const message = (data as {
      readonly message?: {
        readonly toolCallId?: unknown
        readonly isError?: unknown
        readonly content?: unknown
      }
    }).message
    if (message === undefined || typeof message.toolCallId !== 'string' || !Array.isArray(message.content)) {
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    const content: Array<{ readonly type: 'content'; readonly content: { readonly type: 'text'; readonly text: string } }> = []
    for (const block of message.content as readonly unknown[]) {
      const type = (block as { readonly type?: unknown } | null)?.type
      const text = (block as { readonly text?: unknown } | null)?.text
      if (type !== 'text' || typeof text !== 'string') {
        this.failPrompt(claim, flight, unsupportedContent())
        return
      }
      if (text.length > 0) content.push({ type: 'content', content: { type: 'text', text } })
    }
    this.enqueueUpdates(claim, flight, [{
      sessionUpdate: 'tool_call_update',
      toolCallId: message.toolCallId,
      status: message.isError === true ? 'failed' : 'completed',
      content,
    }])
  }

  /**
   * Append one committed event's updates to this flight's single ordered output
   * tail. The bounded pending count is the ONLY additional queue: exceeding it
   * fails this View's request instead of growing without limit.
   */
  private enqueueUpdates(claim: ViewClaim, flight: InflightPrompt, updates: readonly SessionUpdate[]): void {
    if (updates.length === 0 || flight.settledDone) return
    flight.pendingUpdates += updates.length
    if (flight.pendingUpdates > MAX_PENDING_OUTPUT_UPDATES) {
      this.failPrompt(claim, flight, promptError(
        'LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE',
        'the ACP output queue exceeded its bounded capacity',
        JSONRPC_INTERNAL_ERROR,
      ))
      return
    }
    flight.outputTail = flight.outputTail.then(async () => {
      for (const update of updates) {
        if (flight.settledDone) {
          flight.pendingUpdates -= 1
          continue
        }
        try {
          await flight.sendUpdate(update)
        } catch {
          // The transport failure keeps its real classification; it never turns
          // into a StopReason and never touches the Host Agent.
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_OUTPUT_FAILED',
            'an ACP session/update notification could not be delivered',
            JSONRPC_INTERNAL_ERROR,
          ))
        } finally {
          flight.pendingUpdates -= 1
        }
      }
    })
  }

  /**
   * Settle the owned turn after `turn/end`: first drain every notification this
   * flight queued, then answer one real legal StopReason or a stable failure.
   */
  private settleTurnEnd(claim: ViewClaim, flight: InflightPrompt, data: unknown): void {
    flight.phase = 'settling'
    runDetached('local acp: prompt settlement', async () => {
      await flight.outputTail
      if (flight.settledDone) return
      if (flight.mixed) {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_MIXED_TURN',
          'the owned turn also carried another user message, so its output cannot be reported as this prompt',
          JSONRPC_INTERNAL_ERROR,
        ))
        return
      }
      if (!flight.assistantText) {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT',
          'the owned turn ended without a non-empty assistant text chunk',
          JSONRPC_INTERNAL_ERROR,
        ))
        return
      }
      const kind = turnEndReasonKind(data)
      if (kind === 'completed') {
        this.completePrompt(claim, flight, { stopReason: 'end_turn' })
        return
      }
      if (kind === 'max-tokens') {
        this.completePrompt(claim, flight, { stopReason: 'max_tokens' })
        return
      }
      this.failPrompt(claim, flight, promptError(
        'LOCAL_ACP_PROMPT_TURN_FAILED',
        'the owned turn did not reach a successful completion',
        JSONRPC_INTERNAL_ERROR,
        kind === undefined ? { reason: 'unknown' } : { reason: kind },
      ))
    }, { diag: this.diag })
  }

  /** Fail one flight exactly once and release its slot and correlation state. */
  private failPrompt(claim: ViewClaim, flight: InflightPrompt, error: LocalAcpViewError): void {
    if (flight.settledDone) return
    flight.settledDone = true
    flight.phase = 'settling'
    flight.detachAbort?.()
    flight.detachAbort = undefined
    flight.foreignTurn = undefined
    if (claim.inflight === flight) claim.inflight = undefined
    flight.settled.reject(error)
  }

  /** Complete one flight with its real ACP StopReason and release its slot. */
  private completePrompt(claim: ViewClaim, flight: InflightPrompt, result: AcpPromptResult): void {
    if (flight.settledDone) return
    flight.settledDone = true
    flight.phase = 'settling'
    flight.detachAbort?.()
    flight.detachAbort = undefined
    flight.foreignTurn = undefined
    if (claim.inflight === flight) claim.inflight = undefined
    flight.settled.resolve(result)
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

/**
 * Admit one ACP prompt as ordered standard text parts. PO-3A is a TEXT-ONLY
 * phase: an empty/whitespace-only prompt, a missing block or any non-text
 * block is refused before any Host dispatch, and order is preserved verbatim.
 */
function validatePromptContent(prompt: readonly unknown[]): readonly AcpTextPromptPart[] {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a prompt must contain at least one non-empty text block', JSONRPC_INVALID_PARAMS)
  }
  const content: AcpTextPromptPart[] = []
  for (const block of prompt) {
    const type = (block as { readonly type?: unknown } | null)?.type
    const text = (block as { readonly text?: unknown } | null)?.text
    if (type !== 'text' || typeof text !== 'string') {
      throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'this Host accepts standard ACP text prompt blocks only', JSONRPC_INVALID_PARAMS)
    }
    content.push({ type: 'text', text })
  }
  if (!content.some(part => part.text.trim().length > 0)) {
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a prompt must include non-whitespace text', JSONRPC_INVALID_PARAMS)
  }
  return content
}

/** One stable "this committed block has no PO-3A projection" failure. */
function unsupportedContent(): LocalAcpViewError {
  return promptError(
    'LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT',
    'a committed content block has no standard ACP projection in this phase',
    JSONRPC_INTERNAL_ERROR,
  )
}

/** Preserve malformed model tool arguments as opaque input instead of dropping them. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
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
