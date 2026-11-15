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
import { observeSettled, runDetached } from '../../runtime/process/tasks.ts'

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
   * Synchronously remove one still-pending inbox message on the exact Agent.
   * Only a durable official `true` removal is `'removed'`; a message that is
   * no longer pending is `'not-pending'`; a lost exact identity is `'stale'`.
   */
  cancelPending(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string):
    'removed' | 'not-pending' | 'stale'
  /**
   * Synchronously address the official user cancel at the CURRENT open turn of
   * the exact Agent. The turn must be open, be the last turn, and belong to a
   * running Agent in the SAME Host callback stack; `'addressed'` means the
   * official cancel was invoked, never that the turn already ended.
   */
  cancelCurrentTurn(sessionId: string, agent: LiveAgentViewIdentity, session: object, turn: number):
    'addressed' | 'not-current' | 'stale'
  /** The current official turn fence of the exact Agent/Session, or `stale`. */
  currentTurn(sessionId: string, agent: LiveAgentViewIdentity, session: object):
    { readonly kind: 'current'; readonly openTurn: number | null } | { readonly kind: 'stale' }
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
  /** The exact live Agent/Session changed since this View attached. */
  | 'LOCAL_ACP_PROMPT_STALE_AGENT'
  /** The owned turn ended without a real non-empty assistant text chunk. */
  | 'LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'
  /** The owned turn ended blocked/error/aborted/interrupted or the Agent died. */
  | 'LOCAL_ACP_PROMPT_TURN_FAILED'
  /**
   * A close (or a settling cancellation) could not prove the queued removal or
   * the running turn's real termination: the View never fabricates a
   * `cancelled` stop reason or a successful detach on unproven facts.
   */
  | 'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'

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
  /** One official inbox discard notice for a removed message. */
  onInboxDiscarded(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void
  /** One Agent interval failure carrying the owning turn. */
  onAgentError(agent: LiveAgentViewIdentity, turn: number): void
  /** The exact live Agent was disposed. */
  onAgentDisposed(agent: LiveAgentViewIdentity): void
  /**
   * The ONE approval classification entry of the shared Host waterfall. It is
   * registered with `prepend: true` ahead of the TUI forwarding listener: a
   * proven ACP-owned request is answered (or fail-closed) here and NEVER
   * delegated through `next()`; only a proven TUI-owned request calls `next()`.
   */
  onApprovalRequest(request: AcpApprovalRequest, next: () => Promise<AcpApprovalOutcome>): Promise<AcpApprovalOutcome>
}

/** The official `approval/request` facts the View reads. */
export interface AcpApprovalRequest {
  readonly agent: LiveAgentViewIdentity
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** The official closed approval outcome vocabulary (fail-closed union). */
export type AcpApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

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

/** The standard reverse `session/request_permission` params the View sends. */
export interface AcpRequestPermissionParams {
  readonly sessionId: string
  readonly toolCall: { readonly toolCallId: string }
  readonly options: ReadonlyArray<{
    readonly optionId: string
    readonly name: string
    readonly kind: 'allow_once' | 'reject_once'
  }>
}

/** The standard response the client may answer a permission request with. */
export type AcpRequestPermissionResponse = {
  readonly outcome:
    | { readonly outcome: 'cancelled' }
    | { readonly outcome: 'selected'; readonly optionId?: unknown }
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

/** The transient unclaimed Host obligation of one claim (PO-3B v1.1 §3). */
interface UnclaimedHostObligation {
  /** The View-minted request identity the obligation belongs to. */
  readonly requestId: string
  /** The official inserted message id, once observed. */
  messageId?: string
  /** The official admission classification this obligation tracks. */
  admission: 'pending' | 'accepted' | 'unconfirmed'
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
  /**
   * PO-3B: serializes an in-flight `session/close` settlement. A repeated
   * close on the same View awaits the SAME real settlement instead of running
   * a second cancellation.
   */
  closing?: Promise<Record<string, never>>
  /**
   * PO-3B: the retired turn attribution fence. A flight that already obtained
   * the official claimed turn but settled (or was released) BEFORE its
   * `turn/end` keeps exactly this transient record so a LATE `approval/request`
   * of that still-running turn can never be delegated to the TUI. It dies on
   * the matching `turn/end` (or the Agent's disposal) and is never reused for
   * output or a new prompt.
   */
  retiringTurn?: { readonly turn: number }
  /**
   * PO-3B v1.1: the transient UNCLAIMED Host obligation fence. It is created
   * only when the local Flight settled while the official Host had not yet
   * PROVEN the request terminal and no turn was claimed: the exact inserted
   * message (or the still-pending admission) may still execute. Local flight
   * state being cleared is NOT a Host settlement — the reservation and the
   * Host fact observer survive until an official terminal fact settles it.
   */
  unclaimedHostObligation?: UnclaimedHostObligation
  /**
   * PO-3B F2: set when the View detached while a transient terminal fact still
   * had to arrive (a retired-turn fence, or an unproven cancellation). The
   * claim then lives ONLY for that fact and is deleted when it settles.
   */
  detachedWithFence?: boolean
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
  /**
   * PO-3B: the narrow reverse-request channel of THIS flight's own ACP
   * connection (the SDK client of the `session/prompt` request). It is the
   * only path a permission question may take; absent keeps approval
   * fail-closed.
   */
  readonly requestPermission?: (params: AcpRequestPermissionParams, options?: { readonly signal?: AbortSignal }) => Promise<AcpRequestPermissionResponse>
  readonly settled: PromiseWithResolvers<AcpPromptResult>
  settledDone: boolean
  detachAbort?: () => void
  /**
   * PO-3B: the requester wants this prompt gone. It is INTENT ONLY — never a
   * proof that a Host cancellation was committed; the committed proofs are
   * `cancelKind` plus the correlated Host facts.
   */
  cancelRequested: boolean
  /**
   * The committed cancellation fact this flight is settling on:
   * `'queued-removed'` after the exact durable inbox removal, or
   * `'running-addressed'` after the official same-stack user cancel of the
   * exact current turn.
   */
  cancelKind?: 'queued-removed' | 'running-addressed'
  /** The admission call resolved (accepted or classified failure). */
  admissionSettled: boolean
  /** Resolves exactly when the admission call's classification completed. */
  readonly admissionSettledPromise: Promise<void>
  /** The resolver behind `admissionSettledPromise`; flight-private. */
  readonly settleAdmission: () => void
  /** PO-3B: output delivery is closed; queued-but-unsent updates are dropped. */
  deliveryClosed: boolean
  /**
   * PO-3B F2: this flight's Host work is provably TERMINAL — the owned turn
   * reached its durable `turn/end`, or the exact Agent was disposed (nothing
   * can ever run that turn again). A prompt failure after this fact says
   * nothing about cancellation safety.
   */
  ownTurnEnded: boolean
  /** The stable classification this flight settled with (set by failPrompt). */
  failureCode?: LocalAcpSessionErrorCode
  /**
   * PO-3B: pending reverse permission requests keyed by their exact callId,
   * alive only for THIS flight's lifetime (never a second global registry).
   */
  readonly permissionRequests: Map<string, PendingPermissionRequest>
}

/** One in-flight reverse `session/request_permission` of one flight. */
interface PendingPermissionRequest {
  readonly promise: Promise<AcpApprovalOutcome>
  /** Abort the SDK `cancellationSignal` (close/cancel/disconnect path). */
  abort(): void
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
 * Whether one committed `turn/end` proves a USER cancellation: the official
 * `aborted` reason whose nested cause is exactly `{kind:'user'}`. Any other
 * abort cause (parent/hook/disposed/legacy) is NOT this user's cancellation.
 */
function turnEndUserAborted(data: unknown): boolean {
  const reason = (data as { readonly reason?: { readonly kind?: unknown; readonly reason?: { readonly kind?: unknown } } } | undefined)?.reason
  return reason?.kind === 'aborted' && (reason as { readonly reason?: { readonly kind?: unknown } }).reason?.kind === 'user'
}

/**
 * The pure View/claim lifecycle. The registry's lifetime is owned by its
 * OWNER: the ACP controller holds ONE registry across listener rebinds so a
 * retired-turn approval fence and the one-View-per-Session rule survive an
 * Off -> On cycle, and that same registry carries the ONE Host fact/approval
 * subscription; a raw-socket listener without a controller creates a
 * bind-local registry and owns both its claims and its subscription.
 */
export class AcpSessionViewRegistry implements AcpPromptFactListener {
  private readonly claims = new Map<string, ViewClaim>()
  /** Waiters for "every claim's Host work settled" (listener retirement). */
  private readonly workWaiters = new Set<PromiseWithResolvers<void>>()
  /** The ONE Host fact/approval subscription of this registry (R701-03). */
  private factsDisposer: (() => void) | undefined
  private readonly diag: Diag
  /**
   * The Host access the fact callbacks may act through. It is bound exactly
   * once when the listener installs its fact subscription (the same lifetime
   * that owns these callbacks) and is never a second authority.
   */
  private access?: HostAcpSessionAccess

  constructor(diag: Diag) {
    this.diag = diag
  }

  /**
   * Install the ONE Host fact/approval subscription for this registry, if it
   * is not installed yet. The subscription belongs to the REGISTRY's owner
   * (a bind-local registry is owned by its listener; the controller-owned
   * registry outlives listener rebinds), never to an individual bind — an
   * Off -> On overlap must not register the same registry twice (R701-03).
   */
  observeFacts(access: HostAcpSessionAccess): void {
    this.bindAccess(access)
    if (this.factsDisposer !== undefined) return
    this.factsDisposer = access.observePromptFacts(this)
  }

  /** Whether the ONE Host fact subscription is currently installed. */
  hasFactsObserver(): boolean {
    return this.factsDisposer !== undefined
  }

  /** Dispose the ONE Host fact subscription (idempotent). */
  disposeFacts(): void {
    const dispose = this.factsDisposer
    this.factsDisposer = undefined
    dispose?.()
  }

  /** Bind the ONE Host access the prompt-fact lifecycle may act through. */
  bindAccess(access: HostAcpSessionAccess): void {
    this.access = access
  }

  /** Create a fresh connection-scoped view state. */
  createConnection(): ConnectionViewState {
    return { phase: 'idle', op: 0 }
  }

  /** The number of live reservations/attachments (qualification diagnosis only). */
  claimCount(): number {
    return this.claims.size
  }

  /**
   * Whether ANY claim still owns unsettled Host work that the prompt-fact
   * subscription must keep observing: an open flight (pending admission,
   * queued message, running turn or its drain) or a detached retired-turn
   * approval fence. When this is false, retiring the Host fact subscription
   * can no longer strand any accepted ACP work (R701-01).
   */
  hasUnsettledHostWork(): boolean {
    for (const claim of this.claims.values()) {
      if (claim.inflight !== undefined && !claim.inflight.settledDone) return true
      if (claim.retiringTurn !== undefined) return true
      if (claim.unclaimedHostObligation !== undefined) return true
    }
    return false
  }

  /**
   * Resolve when every claim's Host work has settled: flights completed or
   * failed, detached fences ended at their own death facts. Event-driven: the
   * settlement transitions notify the waiters, no polling.
   */
  whenHostWorkSettled(): Promise<void> {
    if (!this.hasUnsettledHostWork()) return Promise.resolve()
    const waiter = Promise.withResolvers<void>()
    this.workWaiters.add(waiter)
    return waiter.promise
  }

  /** Notify (and drop) every work waiter after a settlement transition. */
  private notifyWorkSettled(): void {
    if (this.hasUnsettledHostWork()) return
    const waiters = [...this.workWaiters]
    this.workWaiters.clear()
    for (const waiter of waiters) waiter.resolve()
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
   * Detach ONLY this connection's View for one Session. PO-3B: when a prompt
   * flight is still open, the close FIRST drives the same scoped cancellation
   * and waits for its real settlement (durable queued removal or the exact
   * running turn's terminal plus the output drain); only a proven settlement
   * detaches the View. A repeated close awaits the SAME settlement; a close of
   * a Session this connection never held is still refused. The Host Agent and
   * Session always stay alive; no other connection's claim is touched.
   */
  async closeSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    sessionId: string,
  ): Promise<Record<string, never>> {
    const claim = this.claims.get(sessionId)
    if (claim === undefined || claim.connectionIdentity !== state) {
      if (state.lastClosedSessionId === sessionId) return {}
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_NOT_OWNED', 'this ACP connection holds no view for that session', JSONRPC_INVALID_PARAMS)
    }
    // Join only an attempt that is STILL in flight: a failed attempt is not a
    // settlement proof and must not lock the retry (v1.1 §5.B.3).
    const inFlightAttempt = claim.closing
    if (inFlightAttempt !== undefined) return await inFlightAttempt
    const attempt = this.closeClaim(state, sessionId, claim, access)
    claim.closing = attempt
    try {
      return await attempt
    } finally {
      if (claim.closing === attempt) claim.closing = undefined
    }
  }

  /**
   * One close attempt against the CURRENT official Host facts (v1.1 §4): a
   * safe detach needs a real terminal proof — an exact queued removal, the
   * owned turn's `turn/end` (or its exact Agent's disposal), or a definite
   * pre-insertion admission rejection. A local flight having disappeared is
   * never such a proof.
   */
  private async closeClaim(
    state: ConnectionViewState,
    sessionId: string,
    claim: ViewClaim,
    access: HostAcpSessionAccess,
  ): Promise<Record<string, never>> {
    // An unclaimed obligation may still execute. Try ONE exact removal on the
    // current facts; anything short of a real removal is unconfirmed.
    const obligation = claim.unclaimedHostObligation
    if (obligation !== undefined) {
      if (obligation.messageId !== undefined && claim.exactAgent !== undefined && claim.exactSession !== undefined) {
        const removed = access.cancelPending(sessionId, claim.exactAgent, claim.exactSession, obligation.messageId)
        if (removed === 'removed') this.dropUnclaimedObligation(claim)
      }
      if (claim.unclaimedHostObligation !== undefined) {
        throw promptError(
          'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
          'the accepted prompt has no proven Host terminal status yet',
          JSONRPC_INTERNAL_ERROR,
        )
      }
    }
    const flight = claim.inflight
    if (flight !== undefined) {
      const outcome = await this.cancelOwnedFlight(claim, flight, access, 'closing')
        .then(() => 'ok' as const, (error: unknown) => error)
      if (outcome !== 'ok') {
        // A prompt failure is not a close proof (R701-04): only a real Host
        // terminal (its own turn/end, an Agent disposal, or a definite
        // pre-insertion rejection) lets the close proceed.
        const terminal = flight.ownTurnEnded || flight.failureCode === 'LOCAL_ACP_PROMPT_HOST_REJECTED'
        if (!terminal) throw outcome
      }
    }
    // Re-read: the settled flight/cancellation may have planted a fence or an
    // obligation while this close was waiting.
    if (claim.unclaimedHostObligation !== undefined) {
      throw promptError(
        'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
        'the accepted prompt has no proven Host terminal status yet',
        JSONRPC_INTERNAL_ERROR,
      )
    }
    return this.finishClose(state, sessionId, claim)
  }

  /**
   * End one unclaimed obligation on a REAL terminal fact (exact removal, the
   * official discarded notice, promotion to a claimed turn's fence, or the
   * exact Agent's disposal) and release a detached claim when nothing else
   * remains.
   */
  private dropUnclaimedObligation(claim: ViewClaim): void {
    claim.unclaimedHostObligation = undefined
    this.releaseDetachedIfSettled(claim)
    this.notifyWorkSettled()
  }

  /**
   * The official admission of a flight that already settled while its
   * obligation was still `pending`: a definite pre-insertion rejection proves
   * nothing was admitted (terminal), while an accepted admission keeps the
   * obligation for the exact late-insertion/terminal fact (v1.1 §5.A.4).
   */
  private settleUnclaimedAdmission(claim: ViewClaim, flight: InflightPrompt): void {
    const obligation = claim.unclaimedHostObligation
    if (obligation === undefined || obligation.requestId !== flight.requestId) return
    if (obligation.admission !== 'pending') return
    if (flight.failureCode === 'LOCAL_ACP_PROMPT_HOST_REJECTED') {
      // Definite rejection with no insertion fact: nothing was admitted.
      this.dropUnclaimedObligation(claim)
      return
    }
    obligation.admission = 'accepted'
    this.notifyWorkSettled()
  }

  /** Release a detached claim once no Host obligation or fence remains. */
  private releaseDetachedIfSettled(claim: ViewClaim): void {
    if (!claim.detachedWithFence) return
    if (claim.inflight !== undefined) return
    if (claim.retiringTurn !== undefined) return
    if (claim.unclaimedHostObligation !== undefined) return
    if (this.claims.get(claim.sessionId) === claim) this.claims.delete(claim.sessionId)
  }

  /** Release one settled claim and record the idempotent close fact. */
  private finishClose(state: ConnectionViewState, sessionId: string, claim: ViewClaim): Record<string, never> {
    // A transient terminal fact may still outlive the View: a retired-turn
    // approval fence (F2) or an unclaimed Host obligation (v1.1). The View
    // detaches, but the claim survives so a LATE approval of that exact
    // ACP-owned turn can never be delegated to the TUI and a late insertion is
    // still observed. A claim with no such fact is released now.
    if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined) {
      claim.detachedWithFence = true
    } else if (this.claims.get(sessionId) === claim) {
      this.claims.delete(sessionId)
      this.notifyWorkSettled()
    }
    // This close also cancels any in-flight attach for this connection (same
    // generation semantics as PO-2); a superseded op can never re-commit.
    state.phase = 'idle'
    state.lastClosedSessionId = sessionId
    return {}
  }

  /**
   * PO-3B scoped `session/cancel`: ONLY this connection's own unsettled flight
   * is addressed — a queued message by its exact durable inbox removal, a
   * running turn by the official same-stack user cancel of that exact current
   * turn. An idle View (and any Session this connection does not own) is a
   * no-op that never touches a Host Agent; a mixed owned turn is NOT cancelled
   * (the TUI steer inside it keeps its authority) and keeps the D23 failure.
   */
  cancelSession(state: ConnectionViewState, access: HostAcpSessionAccess, sessionId: string): void {
    const claim = this.claims.get(sessionId)
    if (claim === undefined || claim.connectionIdentity !== state) return
    const flight = claim.inflight
    if (flight === undefined || flight.settledDone) return
    // Commit the intent FIRST so a late insertion/claim still observes it.
    flight.cancelRequested = true
    this.addressCancelIntent(claim, flight, access)
  }

  /**
   * Drive ONE scoped cancellation to its real settlement. The returned promise
   * resolves only when the cancellation is PROVEN (durable removal committed
   * and the admission classified, or the exact turn's real `turn/end` plus the
   * output drain); it rejects with `LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED` when
   * no legal proof can be obtained. The ACP request's own settlement (a real
   * `cancelled` stop reason or its true failure) happens through the SAME
   * flight settlement path this method feeds, never beside it.
   */
  private async cancelOwnedFlight(
    claim: ViewClaim,
    flight: InflightPrompt,
    access: HostAcpSessionAccess,
    reason: 'cancel' | 'closing' | 'disconnect',
  ): Promise<void> {
    // A disconnect cannot deliver any further output; close delivery first.
    if (reason === 'disconnect') flight.deliveryClosed = true
    flight.cancelRequested = true
    this.addressCancelIntent(claim, flight, access)
    if (
      flight.admissionSettled && flight.messageId === undefined && flight.cancelKind === undefined
      && !flight.settledDone
      && Object.is(access.currentAgent(claim.sessionId), claim.exactAgent)
      && Object.is(access.currentSession(claim.sessionId), claim.exactSession)
    ) {
      // The official admission already resolved and this View never observed
      // its own message on the exact attached identity: the official
      // insertion fact is synchronous with the accepted admission, so no
      // durable Host object exists for this requestId. Nothing can ever be
      // cancelled or attributed — end bounded instead of holding the
      // reservation (and the listener's Host fact subscription) forever.
      this.failPrompt(claim, flight, promptError(
        'LOCAL_ACP_PROMPT_ABORTED',
        'the ACP prompt request was aborted before a real Host settlement',
        JSONRPC_INTERNAL_ERROR,
      ))
      return
    }
    // Wait for the flight's own settlement, which the fact callbacks drive:
    // a proven queued removal, the exact turn's real terminal, or the
    // admission's own classified failure. observeSettled already guards the
    // rejection against going unhandled.
    const outcome = await flight.settled.promise.then(() => 'settled', (error: unknown) => error)
    // A disconnect has no channel left to answer, so its flight's own
    // settlement is all this side owns.
    if (reason === 'disconnect') return
    if (outcome === 'settled') return
    // A PROMPT outcome is not a cancellation-safety proof (R701-04): once the
    // owned turn's durable terminal arrived, the Host work is provably over —
    // a mixed or failed turn keeps ITS OWN prompt error — so the close may
    // detach truthfully instead of caching that rejection forever.
    if (flight.ownTurnEnded) return
    // Only an unproven settlement (e.g. a stale identity that may hide a late
    // insertion) surfaces as the real close/cancel error.
    throw outcome
  }

  /**
   * Address the cancellation intent against the CURRENT Host facts. This is
   * the single decision point for every entry (notification, close, insert
   * callback, claim callback): a queued message is removed exactly; a running
   * owned turn is user-cancelled in the same stack only when the official
   * current-turn fence still matches; a mixed turn is never cancelled; an
   * admission still in flight keeps its intent for the insertion callback.
   */
  private addressCancelIntent(claim: ViewClaim, flight: InflightPrompt, access: HostAcpSessionAccess): void {
    if (flight.settledDone || flight.cancelKind !== undefined) return
    const session = claim.exactSession
    const agent = claim.exactAgent
    const sessionId = claim.sessionId
    if (session === undefined || agent === undefined) return
    if (flight.turn === undefined) {
      if (flight.messageId === undefined) {
        // Not inserted yet: the insertion callback re-runs this exactly when
        // the durable id exists. Nothing can be removed before that fact.
        return
      }
      if (flight.mixed) {
        // The turn claiming this message also carried a foreign message: D23.
        // The flight settles with its real mixed failure at its turn/end.
        return
      }
      const removed = access.cancelPending(sessionId, agent, session, flight.messageId)
      if (removed === 'removed') {
        flight.cancelKind = 'queued-removed'
        this.settleQueuedRemoval(claim, flight)
        return
      }
      if (removed === 'stale') {
        // The exact Agent/Session identity is gone; the official facts cannot
        // prove a removal. Fail closed — never guess "probably removed".
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
          'the queued cancellation could not be proven on the exact live Agent',
          JSONRPC_INTERNAL_ERROR,
        ))
        return
      }
      // 'not-pending': the message left the pending lists between the intent
      // and this read. It was either claimed (the claim callback will observe
      // the real turn) or already settled; wait for that authoritative fact.
      return
    }
    if (flight.mixed) {
      // D23 fail-closed: the owned turn also carries a TUI steer; cancelling
      // the Agent would kill the human's work. The flight keeps its mixed
      // settlement; no Agent cancel is issued.
      return
    }
    const addressed = access.cancelCurrentTurn(sessionId, agent, session, flight.turn)
    if (addressed === 'addressed') {
      flight.cancelKind = 'running-addressed'
      return
    }
    if (addressed === 'stale') {
      this.failPrompt(claim, flight, promptError(
        'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
        'the running-turn cancellation could not be proven on the exact live Agent',
        JSONRPC_INTERNAL_ERROR,
      ))
      return
    }
    // 'not-current': the turn already left the current fence (its real
    // terminal is on the wire or the next turn began); the durable turn/end
    // settles the request with its TRUE outcome.
  }

  /**
   * Complete a proven queued removal: the durable splice committed. The
   * completion waits for the admission path's classification (accepted or a
   * definite rejection) through the flight's `admissionSettled` promise so the
   * client never learns "cancelled" for a prompt the Host actually rejected.
   */
  private settleQueuedRemoval(claim: ViewClaim, flight: InflightPrompt): void {
    runDetached('local acp: queued-cancel settlement', async () => {
      await flight.admissionSettledPromise
      await flight.outputTail
      if (flight.settledDone) return
      this.completePrompt(claim, flight, { stopReason: 'cancelled' })
    }, { diag: this.diag })
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
    requestPermission?: (params: AcpRequestPermissionParams, options?: { readonly signal?: AbortSignal }) => Promise<AcpRequestPermissionResponse>,
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
    if (claim.inflight !== undefined || claim.unclaimedHostObligation !== undefined) {
      // A previous accepted Prompt still owes a Host terminal fact: the View
      // must not stack a second Host responsibility on top of it (v1.1 §5.D).
      throw promptError('LOCAL_ACP_PROMPT_IN_FLIGHT', 'a prompt is already in flight for this session view', JSONRPC_INVALID_PARAMS)
    }
    const content = validatePromptContent(request.prompt)
    if (requestSignal.aborted) {
      throw promptError('LOCAL_ACP_PROMPT_ABORTED', 'the ACP prompt request was aborted before admission', JSONRPC_INVALID_PARAMS)
    }
    // A View is only a BORROWER: it keeps no claim on the Agent's lifetime, so
    // the exact identity verified at attach time must STILL be current before a
    // prompt is dispatched. Otherwise the official Controller would cold-resume
    // a NEW Agent under the same Session and accept a message this View can
    // never observe (its facts require the exact attached Agent/Session).
    if (
      !Object.is(access.currentAgent(request.sessionId), claim.exactAgent)
      || !Object.is(access.currentSession(request.sessionId), claim.exactSession)
    ) {
      throw promptError(
        'LOCAL_ACP_PROMPT_STALE_AGENT',
        'the borrowed Session Agent changed since this View attached; the prompt was not dispatched',
        JSONRPC_INVALID_PARAMS,
      )
    }

    const admission = Promise.withResolvers<void>()
    const flight: InflightPrompt = {
      requestId: randomUUID(),
      phase: 'admitting',
      mixed: false,
      assistantText: false,
      pendingUpdates: 0,
      outputTail: Promise.resolve(),
      sendUpdate,
      requestPermission,
      settled: Promise.withResolvers<AcpPromptResult>(),
      settledDone: false,
      cancelRequested: false,
      admissionSettled: false,
      admissionSettledPromise: admission.promise,
      settleAdmission: () => {
        if (flight.admissionSettled) return
        flight.admissionSettled = true
        admission.resolve()
      },
      deliveryClosed: false,
      ownTurnEnded: false,
      permissionRequests: new Map(),
    }
    // Observe the settlement promise BEFORE the first await: an abort, physical
    // disconnect or Agent disposal can reject it while this method is still
    // suspended inside the official admission, and a rejection with no handler
    // would surface as an unhandled rejection in the Host process. This attaches
    // only the observation — the SAME rejection is still returned to the ACP
    // request below and is never swallowed.
    observeSettled(flight.settled.promise, () => {})
    const onAbort = (): void => {
      // The SDK aborts the RequestSignal both when THIS connection dies and
      // when the client cancels the request. Either way the ACP channel can
      // no longer receive anything, but that is a CHANNEL fact, never a Host
      // cancellation proof (F1): the message may still be admitted late,
      // queued or running on the exact Agent. Close delivery, kill the
      // reverse channel, and route the intent through the SAME scoped
      // cancellation every other path uses; the real Host facts alone settle
      // the flight (never this signal).
      flight.deliveryClosed = true
      this.abortPermissionRequests(flight)
      if (!flight.settledDone && !flight.cancelRequested) {
        flight.cancelRequested = true
        if (this.access !== undefined) this.addressCancelIntent(claim, flight, this.access)
      }
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
      if (!flight.settledDone) {
        // The official call resolved. If this View never observed its own
        // message AND the exact identity is no longer current, the async
        // resolve cold-resumed a DIFFERENT Agent that accepted the request; it
        // can never settle here, so fail bounded instead of waiting for events
        // that cannot match (never re-dispatch, never rebind).
        const stillExact = Object.is(access.currentAgent(request.sessionId), claim.exactAgent)
          && Object.is(access.currentSession(request.sessionId), claim.exactSession)
        if (flight.messageId === undefined && !stillExact) {
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_STALE_AGENT',
            'the accepted prompt was not observed on the Agent generation this View attached; it was not re-dispatched',
            JSONRPC_INTERNAL_ERROR,
          ))
        } else if (flight.messageId === undefined && flight.deliveryClosed && flight.cancelRequested) {
          // The admission resolved AFTER the channel died and this View never
          // observed its own durable message: there is no live channel to
          // answer, no message fact to cancel and no turn to attribute, so
          // the flight ends bounded instead of waiting forever.
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_ABORTED',
            'the ACP prompt request was aborted before a real Host settlement',
            JSONRPC_INTERNAL_ERROR,
          ))
        } else {
          flight.phase = 'queued'
        }
      }
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
    } finally {
      flight.settleAdmission()
      this.settleUnclaimedAdmission(claim, flight)
    }
    return await flight.settled.promise
  }

  /** One message entered the live inbox: correlate the View-minted request id. */
  onInboxInserted(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void {
    const rpcId = message.source?.kind === 'user' ? message.source.rpcId : undefined
    for (const claim of this.claims.values()) {
      // A LATE insertion of the request this claim still owes a Host terminal
      // fact for: bind the exact id, then remove it exactly on the current
      // facts. Only a real removal proves the obligation is over.
      const obligation = claim.unclaimedHostObligation
      if (
        obligation !== undefined && obligation.messageId === undefined
        && claim.exactAgent === agent && rpcId !== undefined && rpcId === obligation.requestId
      ) {
        obligation.messageId = message.id
        if (claim.exactSession !== undefined && this.access !== undefined) {
          const removed = this.access.cancelPending(claim.sessionId, agent, claim.exactSession, message.id)
          if (removed === 'removed') this.dropUnclaimedObligation(claim)
        }
      }
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (claim.exactAgent !== agent) {
        // This View's own requestId was accepted by a DIFFERENT Agent
        // generation (the official Controller cold-resumed a new Agent during
        // admission). It can never settle against this View's exact identity:
        // fail bounded, never re-dispatch and never rebind to the new Agent.
        if (rpcId !== undefined && rpcId === flight.requestId && flight.messageId === undefined) {
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_STALE_AGENT',
            'the prompt was accepted by a different Agent generation than this View attached',
            JSONRPC_INTERNAL_ERROR,
          ))
        }
        continue
      }
      if (flight.messageId !== undefined) continue
      if (rpcId !== undefined && rpcId === flight.requestId) {
        // Save the durable id FIRST so every later path addresses the exact
        // message; a cancellation that arrived before this fact now sees it.
        flight.messageId = message.id
        if (flight.cancelRequested && this.access !== undefined) {
          this.addressCancelIntent(claim, flight, this.access)
        }
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
      // The old unclaimed message was formally CLAIMED into turn T: the
      // obligation becomes the claimed-turn approval fence and stays until T's
      // own terminal (v1.1 §4).
      const obligation = claim.unclaimedHostObligation
      if (obligation !== undefined && obligation.messageId === message.id) {
        claim.unclaimedHostObligation = undefined
        if (claim.inflight === undefined) claim.retiringTurn = { turn }
        this.notifyWorkSettled()
      }
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (flight.messageId !== undefined && message.id === flight.messageId) {
        if (flight.turn === undefined) {
          flight.turn = turn
          if (flight.phase === 'admitting' || flight.phase === 'queued') flight.phase = 'claimed'
          if (flight.foreignTurn === turn) flight.mixed = true
          flight.foreignTurn = undefined
          // A pending cancellation now has its authoritative turn: address it
          // in this SAME callback stack before the Agent can run further.
          if (flight.cancelRequested && this.access !== undefined) {
            this.addressCancelIntent(claim, flight, this.access)
          }
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
      const data = event.data as { readonly turn?: unknown } | undefined
      // The retired-turn fence dies on its own terminal record even when no
      // flight is open any more (the flight settled before this turn/end).
      if (event.type === 'turn/end' && typeof data?.turn === 'number' && claim.retiringTurn?.turn === data.turn) {
        this.endRetiringFence(claim.sessionId, claim)
      }
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (typeof data?.turn !== 'number' || flight.turn === undefined || data.turn !== flight.turn) continue
      // The durable terminal of the OWNED turn arrives before the async
      // settlement drains (mixed or not): record it so a later failPrompt
      // never plants a retired-turn fence for a turn that already ended.
      if (event.type === 'turn/end') flight.ownTurnEnded = true
      if (flight.mixed) {
        // A mixed turn projects NOTHING further; it can only settle as a
        // failure once the turn reaches its own terminal record.
        if (event.type === 'turn/end') this.settleTurnEnd(claim, flight, data)
        continue
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
    }
  }

  /**
   * One official inbox discard notice: the message left the pending lists for
   * good. For a standing unclaimed obligation this is its terminal proof
   * (v1.1 §4); a live-flight cancellation keeps its own proven removal path.
   */
  onInboxDiscarded(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void {
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent) continue
      const obligation = claim.unclaimedHostObligation
      if (obligation !== undefined && obligation.messageId === message.id) {
        this.dropUnclaimedObligation(claim)
      }
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
      if (flight !== undefined && !flight.settledDone) {
        // Disposal ends this flight's Host work for good: the disposed Agent
        // can never run the turn or reach its turn/end.
        flight.ownTurnEnded = true
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_TURN_FAILED',
          'the owned Agent was disposed before the prompt settled',
          JSONRPC_INTERNAL_ERROR,
          { reason: 'agent-disposed' },
        ))
      }
      // Disposal ends the retired-turn fence for good (a disposed Agent can
      // never reach its turn/end), so it is cleared AFTER the failure
      // transition, which would otherwise preserve that dead turn. The same
      // terminal fact settles an UNPROVEN cancellation (R701-05): a disposed
      // Agent can never execute the message the View could not remove.
      if (claim.unclaimedHostObligation !== undefined) this.dropUnclaimedObligation(claim)
      this.endRetiringFence(claim.sessionId, claim)
    }
  }

  /**
   * PO-3B approval classification entry (the ONE prepended waterfall seat).
   *
   * The decision is made ONLY from authoritative facts: the request's exact
   * Agent against every claim's exact identity, the claim's live flight turn
   * or its transient retired-turn fence, and the official current-turn fence.
   * A turn proven ACP-owned is answered here — standard reverse
   * `session/request_permission` when the channel allows it, `'unavailable'`
   * (fail closed) when it does not — and NEVER delegated through `next()`. A
   * turn proven NOT owned by any ACP View is delegated exactly once.
   */
  async onApprovalRequest(
    request: AcpApprovalRequest,
    next: () => Promise<AcpApprovalOutcome>,
  ): Promise<AcpApprovalOutcome> {
    const agent = request.agent
    // Find the one claim whose EXACT Agent object matches the request's Agent.
    let owner: ViewClaim | undefined
    for (const claim of this.claims.values()) {
      if (claim.exactAgent === agent) {
        owner = claim
        break
      }
    }
    if (owner === undefined) {
      // No ACP View holds this exact Agent: the TUI keeps its own channel.
      return await next()
    }
    // The OFFICIAL current-turn fence is read for EVERY request, before any
    // ownership claim is believed: a stale flight marker or retired fence can
    // never suppress the TUI responder of a turn this View does not own.
    const session = owner.exactSession
    const fence = session === undefined || this.access === undefined
      ? undefined
      : this.access.currentTurn(owner.sessionId, agent, session)
    if (fence === undefined || fence.kind === 'stale') {
      // Stale identity: the ownership cannot be proven either way; fail
      // closed rather than guess (never delegate an unprovable request).
      return 'unavailable'
    }
    const flight = owner.inflight
    const declaredTurn = flight !== undefined && !flight.settledDone && flight.turn !== undefined
      ? flight.turn
      : owner.retiringTurn?.turn
    if (declaredTurn === undefined) {
      // No ACP declaration at all: the open turn (if any) belongs to another
      // owner (the TUI). Delegated exactly once.
      return await next()
    }
    if (fence.openTurn !== declaredTurn) {
      // The declared turn is no longer the official open current turn (it
      // terminalized, or a newer turn began). This View cannot own the
      // request: with no open turn the ask cannot legally belong to it
      // (fail closed); with another open turn, that turn is the TUI's.
      return fence.openTurn === null ? 'unavailable' : await next()
    }
    // The declared turn IS the official open current turn: PROVEN ACP-owned.
    // Never delegate it to the TUI.
    if (flight === undefined || flight.settledDone || flight.cancelRequested || flight.mixed
      || request.callId === undefined) {
      // No live channel to ask (settled/retired, cancelled, mixed, or a
      // request without a tool callId): fail closed; the official service
      // records its own audit pair with this outcome.
      return 'unavailable'
    }
    const pending = flight.permissionRequests.get(request.callId)
    if (pending !== undefined) return await pending.promise
    const channel = flight.requestPermission
    if (channel === undefined) return 'unavailable'
    // Wait for this flight's queued output first (ordered channel), then ask
    // through the SAME connection the prompt arrived on.
    const asked = this.askPermission(flight, owner, request, channel)
    flight.permissionRequests.set(request.callId, asked)
    try {
      return await asked.promise
    } finally {
      flight.permissionRequests.delete(request.callId)
    }
  }

  /** Issue ONE reverse permission request on the flight's own channel. */
  private askPermission(
    flight: InflightPrompt,
    owner: ViewClaim,
    request: AcpApprovalRequest,
    channel: NonNullable<InflightPrompt['requestPermission']>,
  ): PendingPermissionRequest {
    const upstreamSignal = request.signal
    const cancellation = new AbortController()
    const onUpstreamAbort = (): void => { cancellation.abort() }
    upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true })
    const promise = (async (): Promise<AcpApprovalOutcome> => {
      if (upstreamSignal?.aborted === true) return 'cancelled'
      try {
        // Ordered: the client sees the turn's updates before the question.
        await flight.outputTail
        if (flight.settledDone || flight.deliveryClosed) return 'unavailable'
        const response = await channel({
          sessionId: owner.sessionId,
          toolCall: { toolCallId: request.callId as string },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        }, { signal: cancellation.signal })
        if (flight.settledDone || flight.deliveryClosed) return 'unavailable'
        // A response racing an upstream abort: the abort already decided this
        // question; a late answer (even a valid allow) must not grant it.
        const raced = upstreamSignal
        if ((raced?.aborted ?? false) === true) return 'cancelled'
        const outcome = response?.outcome
        if (outcome?.outcome === 'cancelled') return 'cancelled'
        if (outcome?.outcome === 'selected') {
          if (outcome.optionId === 'allow-once') return 'allowed-once'
          if (outcome.optionId === 'reject-once') return 'rejected'
        }
        // An unknown optionId or malformed response never grants anything.
        return 'unavailable'
      } catch {
        // A transport failure, a timeout or an aborted reverse request fails
        // closed; it never falls through to the TUI.
        const signal = upstreamSignal
        const aborted = (signal?.aborted ?? false) || cancellation.signal.aborted
        return aborted ? 'cancelled' : 'unavailable'
      } finally {
        upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
      }
    })()
    return {
      promise,
      abort: () => { cancellation.abort() },
    }
  }

  /**
   * Release every claim owned by one connection and mark it closed. Used by
   * BOTH an explicit teardown completion and a physical `socket`
   * end/error/destroy or Host Off; it is idempotent and never touches another
   * connection's claim or any Host Agent/Session.
   *
   * PO-3B: a flight that already owns a real Host fact (its durable message
   * id) is no longer dropped synchronously — the SAME scoped cancellation runs
   * (a queued removal or the exact turn's user cancel) and only the proven
   * settlement releases the claim. A flight with no durable fact yet has no
   * Host object any cancellation could address, so it keeps the PO-3A
   * fail-closed release.
   */
  releaseConnection(state: ConnectionViewState, access?: HostAcpSessionAccess): void {
    state.phase = 'closed'
    // Bump the generation so any in-flight continuation is treated as stale and
    // can never mutate this (closed) connection's state.
    state.op += 1
    for (const [sessionId, claim] of this.claims) {
      if (claim.connectionIdentity !== state) continue
      const flight = claim.inflight
      if (flight !== undefined) {
        const bound = access ?? this.access
        if (bound === undefined) {
          // No Host access was ever bound (raw-socket contracts): keep the
          // PO-3A fail-closed release.
          this.failPrompt(claim, flight, new LocalAcpViewError(
            'LOCAL_ACP_VIEW_CLOSED',
            'the ACP connection closed before the prompt settled',
            JSONRPC_INTERNAL_ERROR,
          ))
          this.releaseClaimIfUnfenced(sessionId, claim)
          continue
        }
        // The flight owns (or may still acquire) a real Host fact: the same
        // scoped cancellation runs — the late-insertion fence included — and
        // its proven settlement (or its real failure) releases the claim.
        runDetached('local acp: disconnect cancellation', async () => {
          try {
            await this.cancelOwnedFlight(claim, flight, bound, 'disconnect')
          } catch {
            // The flight settled with its real failure; the claim release
            // below still honours a fence born from that failure.
          }
          // A failure DURING the disconnect may have planted a retired-turn
          // fence (RFL-005) or left an unproven cancellation (R701-05): the
          // claim then survives for that terminal fact alone and dies at it,
          // never leaking the approval and never faking a settled detach.
          if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined) {
            claim.detachedWithFence = true
            this.notifyWorkSettled()
            return
          }
          this.releaseClaimAfterDisconnect(sessionId, claim)
        }, { diag: this.diag })
        continue
      }
      // No open flight: the claim may still carry the retired-turn approval
      // fence of an ALREADY-failed flight whose turn has not ended (F2), or an
      // unclaimed Host obligation (v1.1). A disconnect is not a settlement, but
      // it may still drive ONE exact removal when the message is known — only
      // a real removal ends the obligation; anything else keeps the claim.
      const obligation = claim.unclaimedHostObligation
      const bound = access ?? this.access
      if (
        obligation !== undefined && obligation.messageId !== undefined
        && claim.exactAgent !== undefined && claim.exactSession !== undefined && bound !== undefined
      ) {
        if (bound.cancelPending(sessionId, claim.exactAgent, claim.exactSession, obligation.messageId) === 'removed') {
          this.dropUnclaimedObligation(claim)
        }
      }
      if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined) {
        claim.detachedWithFence = true
        continue
      }
      if (this.claims.get(sessionId) === claim) {
        this.claims.delete(sessionId)
      }
    }
    this.notifyWorkSettled()
  }

  /**
   * End one retired-turn fence: clear it and, when the View already detached
   * (a close/disconnect left the claim alive ONLY for this fence), release
   * the claim so the Session can be attached again (RFL-006).
   */
  private endRetiringFence(sessionId: string, claim: ViewClaim): void {
    claim.retiringTurn = undefined
    this.releaseDetachedIfSettled(claim)
    this.notifyWorkSettled()
  }

  /**
   * Release one claim after a fail-closed flight UNLESS it still carries a
   * retired-turn fence that must survive until its own facts end it.
   */
  private releaseClaimIfUnfenced(sessionId: string, claim: ViewClaim): void {
    if (claim.retiringTurn !== undefined) {
      // The fence survives for its own facts; the claim dies with it.
      claim.detachedWithFence = true
      return
    }
    if (this.claims.get(sessionId) === claim) {
      this.claims.delete(sessionId)
      this.notifyWorkSettled()
    }
  }

  /** Release one disconnect claim after its flight settled. */
  private releaseClaimAfterDisconnect(sessionId: string, claim: ViewClaim): void {
    if (this.claims.get(sessionId) === claim) this.claims.delete(sessionId)
    this.notifyWorkSettled()
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
      this.notifyWorkSettled()
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
      if (type === 'tool-call') {
        // The official `assistant/message` carries its tool-call blocks AND
        // the Host appends each of them as its OWN durable `tool/call` event;
        // the dedicated event (with the real callId/name) is the projection
        // source, so the block here is skipped instead of duplicated.
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
        // A mixed turn, a settled flight or a closed delivery stops ALL output
        // that has not yet been handed to the transport. Notifications already
        // sent cannot be retracted, but a queued one is still ours to drop.
        if (flight.settledDone || flight.mixed || flight.deliveryClosed) {
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
      // A PROVEN user cancellation of this exact turn answers `cancelled`: the
      // official `turn/end {kind:'aborted', reason:{kind:'user'}}` of the turn
      // this flight cancelled is the authoritative fact.
      if (flight.cancelKind === 'running-addressed' && turnEndUserAborted(data)) {
        this.completePrompt(claim, flight, { stopReason: 'cancelled' })
        return
      }
      // The REAL terminal reason decides first: a blocked/error/aborted/
      // interrupted turn keeps its actual classification even when it produced
      // no assistant text. Only a successful candidate needs the text check.
      const kind = turnEndReasonKind(data)
      if (kind !== 'completed' && kind !== 'max-tokens') {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_TURN_FAILED',
          'the owned turn did not reach a successful completion',
          JSONRPC_INTERNAL_ERROR,
          kind === undefined ? { reason: 'unknown' } : { reason: kind },
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
      this.completePrompt(claim, flight, { stopReason: kind === 'completed' ? 'end_turn' : 'max_tokens' })
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
    flight.deliveryClosed = true
    this.abortPermissionRequests(flight)
    flight.failureCode = error.code
    // A flight that already holds its official claimed turn but settles before
    // that turn's `turn/end` keeps a transient retired-turn fence: a LATE
    // approval/request of the still-running turn stays ACP-owned (never
    // delegated to the TUI) until the real terminal record arrives. A turn
    // whose durable terminal ALREADY arrived has nothing left to fence.
    if (flight.turn !== undefined && !flight.ownTurnEnded) claim.retiringTurn = { turn: flight.turn }
    // The UNCLAIMED responsibility (v1.1 §3/§5.A.3) is transferred to the
    // claim BEFORE the flight is dropped whenever the official Host has not
    // proven terminal status and no turn was claimed:
    //   - an inserted message that was never claimed (any failure reason);
    //   - an admission still in flight (no insertion fact observed yet).
    // An owned claimed turn is covered by `retiringTurn` above, a definite
    // pre-insertion rejection leaves nothing behind, and the disposed-Agent
    // terminal (ownTurnEnded) covered.
    if (flight.turn === undefined && !flight.ownTurnEnded) {
      if (flight.messageId !== undefined) {
        claim.unclaimedHostObligation = {
          requestId: flight.requestId,
          messageId: flight.messageId,
          admission: flight.admissionSettled ? 'unconfirmed' : 'accepted',
        }
      } else if (!flight.admissionSettled) {
        claim.unclaimedHostObligation = { requestId: flight.requestId, admission: 'pending' }
      }
    }
    if (claim.inflight === flight) claim.inflight = undefined
    this.notifyWorkSettled()
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
    flight.deliveryClosed = true
    this.abortPermissionRequests(flight)
    if (claim.inflight === flight) claim.inflight = undefined
    this.notifyWorkSettled()
    flight.settled.resolve(result)
  }

  /** Abort every pending reverse permission request of one settling flight. */
  private abortPermissionRequests(flight: InflightPrompt): void {
    for (const pending of flight.permissionRequests.values()) pending.abort()
    flight.permissionRequests.clear()
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
