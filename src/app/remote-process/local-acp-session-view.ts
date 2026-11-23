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
 * PO-4C widens that projection to the standard committed content of
 * `assistant/message` and `tool/result`: ordered text, thought chunks and
 * images, where every image is re-read and integrity-verified by the official
 * Host Attachment Store before its canonical Base64 reaches the wire. The
 * conversion runs INSIDE the flight's single `outputTail`, so a committed
 * event's asynchronous image read never lets a later event overtake it; a
 * content conversion failure fails the request instead of sending a partial
 * event as success.
 *
 * G-ACP2-PR1 adds the provisional/question halves of the SAME owned flight:
 * the official transient `agent/assistant-stream` frames become ordered
 * `agent_message_chunk`/`agent_thought_chunk` updates BEFORE their durable
 * `assistant/message` commits, and the durable event then only reconciles the
 * exact `seq` (never re-sending text already delivered); the official scoped
 * `user-questions/request` waterfall becomes a standard ACP v1
 * `elicitation/create` form whose accepted answer returns to the SAME official
 * `userQuestions` service, including the timed `continued` hand-off that
 * outlives the prompt flight but not this connection's claim.
 *
 * @module app/remote-process/local-acp-session-view
 */

import { randomUUID } from 'node:crypto'
import type {
  ContentBlock as AcpWireContentBlock,
  ElicitationSchema,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallContent,
} from '@agentclientprotocol/sdk'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { observeSettled, runDetached } from '../../runtime/process/tasks.ts'
import {
  AcpAssistantStream,
  joinStreamedMessage,
  readAssistantStreamFrame,
  type AcpStreamBlock,
} from './local-acp-live-stream.ts'
import {
  answerQuestionForm,
  buildQuestionForm,
  type AcpQuestionAnswerItem,
  type AcpQuestionForm,
  type AcpQuestionSpec,
} from './local-acp-question-form.ts'
import {
  AcpModelError,
  type AcpModelCurrentness,
  type AcpModelErrorCode,
  type AcpModelOptionRequest,
} from './local-acp-model-selection.ts'
import {
  AcpScopedMcpError,
  parseAcpMcpServers,
  type AcpScopedMcpCurrentness,
  type AcpScopedMcpLease,
} from './local-acp-scoped-mcp.ts'

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
  /** The current boot-frozen Host image limits needed to derive UDS framing. */
  imageLimits(): AcpImageLimits | undefined
  /**
   * Re-read ONE committed image reference through the official Host Attachment
   * Store and return its verified bytes plus the stored media type. The Store
   * owns the integrity check; a missing Store, an absent object or corrupt bytes
   * reject. This is not a client-reachable capability: only an owned turn's own
   * committed block may name a reference.
   */
  readOutputImage(ref: AcpStoredImageRef, signal: AbortSignal): Promise<AcpStoredImage>
  /** Whether the exact configured Host default route explicitly accepts images. */
  supportsImagePrompts(): Promise<boolean>
  /** Submit ONE prompt through the official Session Controller (queue mode only). */
  prompt(request: AcpSessionPromptRequest, signal: AbortSignal): Promise<{ readonly accepted: true }>
  /**
   * Synchronously remove one still-pending inbox message on the exact Agent.
   * Only a durable official `true` removal is `'removed'`; a message that is
   * no longer pending is `'not-pending'`; a lost exact identity is `'stale'`.
   */
  cancelPending(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string):
    'removed' | 'not-pending' | 'stale'
  /** Read the exact official pending inbox projection after a discard checkpoint. */
  pendingMessage(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string):
    'pending' | 'absent' | 'stale'
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
  /**
   * Mount one standard ACP stdio MCP declaration list on the exact Agent. The
   * returned lease is owned by the caller; `stillCurrent` is re-checked after
   * every asynchronous Host step.
   */
  mountScopedMcp(
    agent: LiveAgentViewIdentity,
    session: object,
    servers: readonly unknown[],
    stillCurrent: () => AcpScopedMcpCurrentness,
    signal?: AbortSignal,
  ): Promise<AcpScopedMcpLease | undefined>
  /** Request the ONE singleflight retirement of an exact scoped MCP lease. */
  requestRetireScopedMcp(lease: AcpScopedMcpLease): Promise<void>
  /** Read the complete standard config-option state of one exact attached Agent. */
  modelOptions(agent: LiveAgentViewIdentity, session: object): Promise<SessionConfigOption[]>
  /**
   * Validate and commit ONE Session-only model/effort selection on the exact
   * attached Agent. `stillCurrent` re-checks the owning View claim after every
   * asynchronous Host validation and before the durable append.
   */
  selectModelOnly(
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpModelOptionRequest,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ): Promise<SessionConfigOption[]>
  /**
   * Whether the exact Host installed the official `userQuestions` service. An
   * absent service is a capability absence: an ACP-owned question then fails
   * closed instead of being answered by a second/durable answer store.
   */
  hasQuestionService(): boolean
  /**
   * Read the official `userQuestions` projection of the exact Session. The
   * View never derives continued state itself: `unavailable` is a capability
   * absence (no projection registry) and `stale` a lost exact identity.
   */
  questionSnapshot(sessionId: string, agent: LiveAgentViewIdentity, session: object): AcpQuestionSnapshot
  /**
   * Submit ONE official late answer for a continued call. The official
   * `userQuestions.answer` result is preserved exactly: `queued` accepts the
   * reply into the inbox, `not-continued` is its `false`, and `rejected` keeps
   * the official error code instead of becoming a fabricated success. The
   * SYNCHRONOUS `stillCurrent` fence is re-read immediately before the write so
   * a View that lost ownership can never inject a late reply into the shared
   * Session.
   */
  answerContinued(
    sessionId: string,
    agent: LiveAgentViewIdentity,
    session: object,
    callId: string,
    answer: AcpQuestionAnswer,
    stillCurrent: () => boolean,
  ): AcpContinuedAnswerOutcome
}

/** One transient per-connection config-options notification callback. */
export type AcpConfigOptionsNotifier = (sessionId: string, options: readonly SessionConfigOption[]) => Promise<void>

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
  /** One standard ACP stdio MCP declaration was invalid before any Host create. */
  | 'LOCAL_ACP_MCP_INVALID_DECLARATION'
  /** The exact Agent was running or owned another maintenance window. */
  | 'LOCAL_ACP_MCP_AGENT_BUSY'
  /** An MCP tool name would shadow an existing global/Agent tool. */
  | 'LOCAL_ACP_MCP_NAME_CONFLICT'
  /** The MCP server child could not connect or complete its first tool sync. */
  | 'LOCAL_ACP_MCP_START_FAILED'
  /** The MCP Fiber cleanup could not be confirmed; the lease remains fenced. */
  | 'LOCAL_ACP_MCP_CLEANUP_UNCONFIRMED'
  /** The View admission changed while the MCP lease was being mounted. */
  | 'LOCAL_ACP_MCP_STALE'

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
  /**
   * The official Host Attachment Store could not read/verify an image a
   * committed assistant or tool block referenced. The event is never sent
   * partially and a fabricated image is never substituted.
   */
  | 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED'
  /** The bounded View output queue could not keep up with committed events. */
  | 'LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE'
  /** A committed block has no PO-3A standard ACP projection (never truncated). */
  | 'LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT'
  /** The owned turn also claimed another user's message (D23 fail-closed). */
  | 'LOCAL_ACP_PROMPT_MIXED_TURN'
  /** The exact live Agent/Session changed since this View attached. */
  | 'LOCAL_ACP_PROMPT_STALE_AGENT'
  /**
   * A durable `assistant/message` could not be proven identical to the
   * provisional text already delivered for the same attempt/seq. ACP v1
   * chunks are append-only, so the View fails closed instead of re-sending a
   * "correction" (or pretending the failed attempt was committed).
   */
  | 'LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'
  /** The owned turn ended blocked/error/aborted/interrupted or the Agent died. */
  | 'LOCAL_ACP_PROMPT_TURN_FAILED'
  /**
   * A close (or a settling cancellation) could not prove the queued removal or
   * the running turn's real termination: the View never fabricates a
   * `cancelled` stop reason or a successful detach on unproven facts.
   */
  | 'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'

/**
 * The stable question classifications. They never carry an answer, a client
 * name or a fallback: a question this View cannot legitimately serve fails
 * closed instead of being silently answered by the TUI or by a default option.
 */
export type LocalAcpQuestionErrorCode =
  /** The ACP connection did not negotiate the standard Form capability, or the
   * exact Host question service/projection is absent for an ACP-owned turn. */
  | 'LOCAL_ACP_QUESTION_UNAVAILABLE'
  /** The client's elicitation response was not a legal answer to THIS form. */
  | 'LOCAL_ACP_QUESTION_BAD_ANSWER'
  /** The human declined or cancelled the Form: a refusal, never an empty answer. */
  | 'LOCAL_ACP_QUESTION_DECLINED'

/** Every stable local ACP classification the View owner can raise. */
export type LocalAcpSessionErrorCode =
  | LocalAcpViewErrorCode
  | LocalAcpPromptErrorCode
  | LocalAcpQuestionErrorCode
  | AcpModelErrorCode

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

/** The `session/set_config_option` request facts the View forwards to the Host model service. */
export interface AcpSetConfigOptionParams extends AcpModelOptionRequest {
  readonly sessionId: string
}

/** Raster MIME vocabulary shared by the ACP wire and official Host admission. */
export const ACP_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** The official Host content accepted by this ACP input adapter. */
export type AcpPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: typeof ACP_IMAGE_MEDIA_TYPES[number]; readonly data: string }

/** Read-only transport inputs from the Host's boot-frozen attachment limits. */
export interface AcpImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly mediaTypes: readonly string[]
}

/**
 * The structural official `ImageAttachmentRef` a committed image block carries.
 * The View never interprets these fields: they identify the object the official
 * Host Attachment Store must verify and read back.
 */
export interface AcpStoredImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/** One committed image read back and integrity-verified by the Host Store. */
export interface AcpStoredImage {
  /** Exact stored bytes; the View encodes these and nothing else. */
  readonly data: Uint8Array
  /** The media type the Store verified against those bytes. */
  readonly mediaType: string
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
  readonly content: readonly AcpPromptPart[]
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
  /**
   * One transient process-local assistant-stream frame of an emitting Agent.
   * It is the ONLY provisional output source; it never becomes a durable fact
   * and is dropped for every agent that is not the exact attached one.
   */
  onAssistantStream(agent: LiveAgentViewIdentity, frame: unknown): void
  /**
   * The official Agent-scoped question waterfall. It is registered with
   * `prepend: true` for the SAME reason as the approval seat: a proven
   * ACP-owned question is answered from THIS connection (or fails closed) and
   * is never delegated through `next()`; only a proven foreign/TUI question
   * calls `next()` exactly once.
   */
  onQuestionRequest(request: AcpQuestionRequest, next: () => Promise<AcpQuestionAnswer>): Promise<AcpQuestionAnswer>
  /**
   * One official `sessionProjections` change. The View re-reads the official
   * question snapshot of the exact Session; it never derives continued state
   * from a timer or from a client's still-open form.
   */
  onQuestionProjection(session: object, key: string): void
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

/**
 * The official `user-questions/request` facts the View reads. An agentless
 * programmatic request has no ACP-owned turn to attribute and is never
 * intercepted.
 */
export interface AcpQuestionRequest {
  readonly agent?: LiveAgentViewIdentity
  readonly questions: readonly AcpQuestionSpec[]
  readonly signal?: AbortSignal
  /** The official foreground/timed wait identity, when the producer supplied one. */
  readonly wait?: { readonly callId: string; readonly timed?: boolean }
}

/** The official answer batch shape (`AskUserQuestionAnswer` is structurally equal). */
export interface AcpQuestionAnswer {
  readonly answers: readonly AcpQuestionAnswerItem[]
}

/**
 * ONE standard ACP v1 `elicitation/create` request as this View sends it. It
 * carries no client-specific field: `mode:'form'` is the only form of the
 * standard request DSH native questions map onto.
 */
export interface AcpElicitationRequest {
  readonly message: string
  readonly sessionId: string
  /** Present only when the official wait named a tool call. */
  readonly toolCallId?: string
  readonly requestedSchema: ElicitationSchema
}

/** The client's standard response, read structurally (`action` is a wider union). */
export interface AcpElicitationResponse {
  readonly action: string
  readonly content?: unknown
}

/**
 * The ONE connection-scoped reverse-elicitation channel of an attached View.
 * It is created from the SAME SDK client as the `session/new|resume` request,
 * dies with that connection and is never a second SDK Connection.
 */
export type AcpElicitationRequester = (
  request: AcpElicitationRequest,
  options: { readonly signal: AbortSignal },
) => Promise<AcpElicitationResponse>

/** The transient per-connection channels bound at attach time. */
export interface AcpViewChannels {
  /** The config-options notification sink of this connection. */
  readonly notifyConfigOptions?: AcpConfigOptionsNotifier
  /** The reverse elicitation channel of this connection (absent = no Form). */
  readonly requestElicitation?: AcpElicitationRequester
}

/**
 * One official continued timed question this View may still offer as a Form.
 * It is a READ of the official projection, never a durable answer store.
 */
export interface AcpPendingQuestion {
  readonly callId: string
  readonly questions: readonly AcpQuestionSpec[]
}

/** One read of the official continued-question projection of an exact Session. */
export type AcpQuestionSnapshot =
  | {
    readonly kind: 'current'
    /** Continued calls in official ask order. */
    readonly continued: readonly AcpPendingQuestion[]
    /** Calls this Session already settled (any answer, any owner). */
    readonly settled: ReadonlySet<string>
  }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'stale' }

/**
 * One official late-answer submission. `queued` means the official service
 * accepted the reply into the Agent inbox (not that the model used it);
 * `not-continued` is the official `false`; `rejected` keeps the official
 * error code (`REPLY_QUEUED`, `BAD_ANSWER`, `CALLER_NOT_LIVE`, …).
 */
export type AcpContinuedAnswerOutcome =
  | { readonly kind: 'queued' }
  | { readonly kind: 'not-continued' }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'stale' }

/** The inbox message facts the View reads (`UserMessage` is structurally wider). */
export interface AcpUserMessageLike {
  readonly id: string
  readonly source?: { readonly kind?: string; readonly rpcId?: string }
}

/** The committed Session event facts the View reads (`SessionEvent` is structurally wider). */
export interface AcpSessionEventLike {
  readonly type: string
  /**
   * The official monotonic Session sequence number. It is the ONLY join key a
   * transient stream attempt may use to reconcile its provisional text with
   * the durable message the Host committed.
   */
  readonly seq: number
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
  /**
   * Monotonic attach-operation generation. `beginAttach` bumps it; every async
   * continuation may mutate `phase`/`claims` ONLY while its captured generation
   * is still current, so a late result from a superseded/closed/disconnected
   * operation can never clobber a newer operation's transient state.
   */
  op: number
}

/** The official turn checkpoint and the responder that already owned it. */
interface TurnProvenance {
  readonly turn: number | null
  readonly origin: 'acp' | 'tui' | 'unknown'
}

/** The transient unclaimed Host obligation of one claim (PO-3B v1.1 §3). */
interface UnclaimedHostObligation {
  /** The View-minted request identity the obligation belongs to. */
  readonly requestId: string
  /** The official inserted message id, once observed. */
  messageId?: string
  /** The official admission classification this obligation tracks. */
  admission: 'pending' | 'accepted' | 'unconfirmed'
  /** Minimal turn provenance retained if this message is later claimed. */
  turnProvenance?: TurnProvenance
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
   * `turn/end` keeps exactly this transient record for a LATE `approval/request`.
   * ACP-origin turns remain intercepted; TUI-origin turns retain their original
   * responder. It dies on the matching `turn/end` (or the Agent's disposal)
   * and is never reused for output or a new prompt.
   */
  retiringTurn?: TurnProvenance
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
  /** Set synchronously while an async MCP admission crosses this claim. */
  mcpMountPending?: boolean
  /** Cancels a pending MCP Fiber startup on Close/EOF/Off/Agent disposal. */
  mcpMountAbort?: AbortController
  /** The ONE exact Agent-scoped MCP lease this claim owns. */
  mcpLease?: AcpScopedMcpLease
  /** Close/EOF/Off committed the retirement intent for `mcpLease`. */
  mcpRetireRequested?: boolean
  /**
   * The ONE transient config-options notification callback of this claim's
   * connection. It carries no model fact and dies with the claim; an absent
   * callback (or a closed/replaced claim) means no config update is sent.
   */
  notifyConfigOptions?: AcpConfigOptionsNotifier
  /** The ordered per-claim config-notification chain; later updates never overtake earlier ones. */
  configNotifyTail?: Promise<void>
  /**
   * The ONE reverse-elicitation channel of this claim's connection. It is
   * bound at attach time from the SAME SDK client as `session/new|resume`,
   * dies with that connection and is never a second SDK Connection.
   */
  requestElicitation?: AcpElicitationRequester
  /**
   * Every outstanding reverse Form this claim owns (one per in-flight native
   * question, plus the single continued offer). Close/EOF/Off/Agent disposal
   * abort them here — one release hook, no second owner.
   */
  questionForms?: Set<QuestionFormAbort>
  /**
   * The continued timed questions this connection may still answer after their
   * original foreground waterfalls ended, keyed by their OFFICIAL tool-call id.
   * The official projection allows several simultaneous continued calls, so a
   * second timeout must never overwrite the first obligation: every answer is
   * watched and applied under its own call identity and never becomes another
   * call's answer.
   */
  continuedQuestions?: Map<string, ContinuedQuestionObligation>
  /**
   * The continued calls this EXACT connection already offered as a Form. It is
   * a connection-local dedupe fact, never a durable answer/state store.
   */
  offeredQuestions?: Set<string>
  /** Serializes the resumed continued-question offers of this claim (one Form at a time). */
  questionOfferTail?: Promise<void>
}

/** The abort handle of ONE outstanding reverse Form. */
interface QuestionFormAbort {
  /** `blocking` forms serve a live waterfall; `continued` forms are resumable offers. */
  readonly kind: 'blocking' | 'continued'
  /** The official tool call id this Form was keyed by, when the producer named one. */
  readonly callId?: string
  abort(): void
}

/** One continued-question obligation: the timed Form outlived its waterfall. */
interface ContinuedQuestionObligation {
  readonly callId: string
  readonly form: AcpQuestionForm
  /** Aborts the client-side Form when the obligation ends. */
  readonly abort: QuestionFormAbort
  /** The single legal answer already received, if any (applied at most once). */
  answer?: AcpQuestionAnswer
  /** Whether `answer` was already submitted to the official service. */
  applied?: boolean
}

/** The maximum number of not-yet-written notifications ONE prompt flight may queue. */
const MAX_PENDING_OUTPUT_UPDATES = 64

/**
 * One synchronously validated committed-output unit. The flight builds the WHOLE
 * event's plan in its event callback (so the FIFO position and the reserved
 * update count are committed before any await), then the tail resolves image
 * entries through the official Host Store and sends the ordered updates.
 */
type CommittedOutputEntry =
  | { readonly kind: 'thought'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'message-image'; readonly ref: AcpStoredImageRef }
  | { readonly kind: 'tool'; readonly text: string }
  | { readonly kind: 'tool-image'; readonly ref: AcpStoredImageRef }

/**
 * One unsettled prompt flight. Each field is a DIFFERENT authoritative fact:
 * `requestId` is View-minted, `messageId` comes from the official
 * `agent/inbox/inserted`, `turn` from the official `agent/inbox/claimed`, and
 * `stream` only from the official transient `agent/assistant-stream` frames of
 * that exact claimed turn.
 */
interface InflightPrompt {
  readonly requestId: string
  phase: 'admitting' | 'queued' | 'claimed' | 'settling'
  messageId?: string
  turn?: number
  /** The most recent turn claimed by a FOREIGN message while this flight had no
   * own turn yet. Claims are monotonic and a same-batch claim emits the
   * foreign message before the queued one, so one marker answers "did the turn
   * that claims me already carry another user's message?".
   */
  foreignTurn?: number
  /** The official open turn and its approval origin before Host admission. */
  turnProvenance?: TurnProvenance
  mixed: boolean
  /**
   * The ONE open transient attempt this flight streams. It belongs to THIS
   * flight (never to the Agent or a second store) and is cleared at its
   * durable reconciliation, its flight settlement or a framing violation.
   */
  stream?: AcpAssistantStream
  /**
   * The attempt id of provisional bytes this flight delivered and can NEVER
   * prove committed (an official retry/replacement/abandoned attempt, or an
   * `end` that never arrived). ACP v1 output is append-only, so those bytes
   * cannot be retracted: once set, no terminal of this flight may report
   * success, because the client would keep an answer that no durable message
   * owns. Set at most once and never cleared.
   */
  unprovenProvisional?: string
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
   * PO-4C: the ONLY abort channel of this flight's own output work. It is
   * passed to the official image read and to nothing else — never to the
   * Agent, Session or writer — and is aborted whenever this flight's output is
   * stopped (close, disconnect, request abort, Off, disposal, MIXED or a
   * committed cancellation).
   */
  readonly outputAbort: AbortController
  /** The `outputAbort` signal handed to the official image read. */
  readonly outputSignal: AbortSignal
  /**
   * Whether this flight's output IO was intentionally stopped. An output
   * rejection observed after this fact is a local closure, never a content
   * failure (the flight keeps its real Host terminal classification).
   */
  outputStopped: boolean
  /**
   * PO-3B/PO-4C handoff fence: number of output tasks enqueued so far. A
   * committed cancellation snapshots this count; every task already queued at
   * that point is ours to drop (no longer safe to hand to the client), while
   * output of the SAME turn committed afterwards still drains under the
   * accepted PO-3B "cancelled answer waits for the ordered notification drain"
   * contract.
   */
  outputTasksQueued: number
  /** The task count frozen by a committed cancellation, if any. */
  outputStoppedAtTask?: number
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

/**
 * The official message-source discriminants that prove HUMAN inbox input.
 * Everything else (`skill-invocation`, `time-context`, any context-form
 * injection) is Host/plugin context: it can never make an owned turn MIXED.
 */
const HUMAN_INBOX_SOURCES: ReadonlySet<string> = new Set(['user', 'user-question-reply'])

/** The official code a timed foreground wait aborts with when its deadline ends. */
const QUESTION_TIMED_OUT_CODE = 'ASK_TIMED_OUT'

/** One standard classified prompt failure. */
function promptError(
  code: LocalAcpPromptErrorCode,
  message: string,
  rpcCode: number,
  data: Readonly<Record<string, unknown>> = {},
): LocalAcpViewError {
  return new LocalAcpViewError(code, message, rpcCode, data)
}

/** One standard classified question failure (never a fabricated answer). */
function questionError(
  code: LocalAcpQuestionErrorCode,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): LocalAcpViewError {
  return new LocalAcpViewError(code, message, JSONRPC_INTERNAL_ERROR, data)
}

/** Whether one abort reason is the official timed-wait deadline expiry. */
function isTimedOutReason(reason: unknown): boolean {
  return hostErrorCode(reason) === QUESTION_TIMED_OUT_CODE
}

/** The classified abort of one question request (the official reason, or a stable refusal). */
function questionAborted(reason: unknown, signal: AbortSignal | undefined): unknown {
  if (reason !== undefined) return reason
  const signalReason = signal?.reason
  return signalReason === undefined
    ? questionError('LOCAL_ACP_QUESTION_UNAVAILABLE', 'the question request was aborted')
    : signalReason
}

/** The stable rejection when an attached View/Agent/Session identity changed mid-request. */
function staleModelSelection(): LocalAcpViewError {
  return new LocalAcpViewError(
    'LOCAL_ACP_MODEL_STALE',
    'the attached session changed during the model request',
    -32042,
  )
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
      if (claim.mcpMountPending === true || claim.mcpLease !== undefined) return true
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

  /**
   * Whether this exact connection currently owns the Session's one ACP claim.
   * The read is side-effect free and includes a pending, attached or
   * detached-with-fence claim; it is never proof that Host work completed.
   */
  ownsClaim(state: ConnectionViewState, sessionId: string): boolean {
    return this.claims.get(sessionId)?.connectionIdentity === state
  }

  /**
   * Whether this exact connection owns ANY live claim. Used by the listener's
   * bounded per-connection roster to retain slots that still carry a Host
   * obligation or terminal fence.
   */
  hasClaimOwnedBy(state: ConnectionViewState): boolean {
    for (const claim of this.claims.values()) {
      if (claim.connectionIdentity === state) return true
    }
    return false
  }

  /** The current phase of one connection (qualification diagnosis only). */
  phaseOf(state: ConnectionViewState): ConnectionViewState['phase'] {
    return state.phase
  }

  /**
   * The ONE attached claim this connection owns for a Session. An idle,
   * closed, re-bound or foreign View holds no model capability.
   */
  private attachedClaim(state: ConnectionViewState, sessionId: string): ViewClaim {
    const claim = this.claims.get(sessionId)
    if (
      state.phase !== 'attached'
      || claim === undefined
      || claim.connectionIdentity !== state
      || claim.detachedWithFence
      || claim.exactAgent === undefined
      || claim.exactSession === undefined
    ) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_NOT_OWNED',
        'this ACP connection holds no view for that session',
        JSONRPC_INVALID_PARAMS,
      )
    }
    return claim
  }

  /** Whether this exact claim is still the live attached View of this connection. */
  private isStillAttached(
    state: ConnectionViewState,
    claim: ViewClaim,
    agent: LiveAgentViewIdentity,
    session: object,
  ): boolean {
    return this.claims.get(claim.sessionId) === claim
      && claim.connectionIdentity === state
      && state.phase === 'attached'
      && !claim.detachedWithFence
      && claim.exactAgent === agent
      && claim.exactSession === session
  }

  /** Map one typed Host model rejection onto the existing View error boundary. */
  private async callModelAccess<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof AcpModelError) {
        throw new LocalAcpViewError(error.code, error.message, error.rpcCode, error.data)
      }
      throw error
    }
  }

  /**
   * Read the complete standard config-option state of the EXACT attached View.
   * The async Host read is fenced against a close/re-bind/rebind before its
   * result is returned to the connection.
   */
  async modelOptions(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    sessionId: string,
  ): Promise<SessionConfigOption[]> {
    const claim = this.attachedClaim(state, sessionId)
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    try {
      const options = await this.callModelAccess(() => access.modelOptions(agent, session))
      if (!this.isStillAttached(state, claim, agent, session)) throw staleModelSelection()
      return options
    } catch (error) {
      // Both a catalog success and a catalog rejection are fenced against the
      // ORIGINAL claim. A detached/replaced View must never turn a catalog
      // failure into a successful optional-display omission.
      if (!this.isStillAttached(state, claim, agent, session)) throw staleModelSelection()
      throw error
    }
  }

  /**
   * Commit ONE Session-only model/effort selection on the EXACT attached View.
   * A View with any unsettled prompt obligation is refused before the Host
   * service is reached; the Host service re-checks the exact Agent/Session
   * identity and the View claim after every asynchronous validation step.
   */
  async setModelOption(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpSetConfigOptionParams,
    signal: AbortSignal,
  ): Promise<SessionConfigOption[]> {
    const claim = this.attachedClaim(state, request.sessionId)
    if (claim.inflight !== undefined || claim.unclaimedHostObligation !== undefined
      || claim.mcpMountPending === true || claim.mcpRetireRequested === true) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_MODEL_VIEW_BUSY',
        'a prompt is already in flight for this session view',
        -32046,
      )
    }
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    const stillCurrent = (): AcpModelCurrentness => {
      if (!this.isStillAttached(state, claim, agent, session)) return 'stale'
      if (claim.inflight !== undefined || claim.unclaimedHostObligation !== undefined
        || claim.mcpMountPending === true || claim.mcpRetireRequested === true) return 'view-busy'
      return 'current'
    }
    const options = await this.callModelAccess(() => access.selectModelOnly(
      agent,
      session,
      {
        configId: request.configId,
        ...(request.type === undefined ? {} : { type: request.type }),
        value: request.value,
      },
      signal,
      stillCurrent,
    ))
    const currentness = stillCurrent()
    if (currentness === 'view-busy') {
      throw new LocalAcpViewError(
        'LOCAL_ACP_MODEL_VIEW_BUSY',
        'a prompt is already in flight for this session view',
        -32046,
      )
    }
    if (currentness !== 'current') throw staleModelSelection()
    return options
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
    channels?: AcpViewChannels,
    requestSignal?: AbortSignal,
  ): Promise<{ sessionId: string }> {
    const op = this.beginAttach(state)
    try {
      this.validateNew(request)
    } catch (error) {
      this.resetIdleIfCurrent(state, op)
      throw error instanceof AcpScopedMcpError ? mapScopedMcpError(error) : error
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
    claim.exactAgent = agent
    claim.exactSession = agent.session
    if (request.mcpServers.length > 0) {
      try {
        await this.installScopedMcp(state, op, claim, access, agent, request.mcpServers, requestSignal)
      } catch (error) {
        this.releaseReservation(state, claim)
        this.resetIdleIfCurrent(state, op)
        throw error
      }
    }
    this.commitAttached(state, op, claim, access, agent, channels)
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
    channels?: AcpViewChannels,
    requestSignal?: AbortSignal,
  ): Promise<Record<string, never>> {
    const op = this.beginAttach(state)
    try {
      this.validateResume(request)
    } catch (error) {
      this.resetIdleIfCurrent(state, op)
      throw error instanceof AcpScopedMcpError ? mapScopedMcpError(error) : error
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
    claim.exactAgent = agent
    claim.exactSession = agent.session
    if (request.mcpServers !== undefined && request.mcpServers.length > 0) {
      try {
        await this.installScopedMcp(state, op, claim, access, agent, request.mcpServers, requestSignal)
      } catch (error) {
        this.releaseReservation(state, claim)
        this.resetIdleIfCurrent(state, op)
        throw error
      }
    }
    this.commitAttached(state, op, claim, access, agent, channels)
    // A resumed View re-reads the OFFICIAL continued projection: every call
    // that is still answerable is offered once on THIS connection, in official
    // ask order. A brand-new Session (`newSession`) has no such history.
    if (claim.requestElicitation !== undefined && access.hasQuestionService()) {
      this.offerContinuedQuestions(claim, claim.requestElicitation)
    }
    return {}
  }

  /** Whether one MCP admission is still owned by the same live attach op. */
  private isMcpAdmissionCurrent(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    agent: LiveAgentViewIdentity,
  ): boolean {
    return state.op === op
      && state.phase === 'attaching'
      && this.claims.get(claim.sessionId) === claim
      && claim.connectionIdentity === state
      && !claim.detachedWithFence
      && claim.exactAgent === agent
      && claim.exactSession === agent.session
  }

  /**
   * Mount one already-validated non-empty declaration list before the View is
   * committed. The reservation (`mcpMountPending`) is committed BEFORE the
   * async Host call; a close/EOF/Off during that window leaves the claim alive
   * and commits the retirement intent, so a late success owns a lease that is
   * immediately retired instead of becoming an orphan.
   */
  private async installScopedMcp(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    agent: LiveAgentViewIdentity,
    servers: readonly unknown[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    claim.mcpMountPending = true
    const mountAbort = new AbortController()
    claim.mcpMountAbort = mountAbort
    const forwardAbort = (): void => { mountAbort.abort() }
    if (signal !== undefined) {
      if (signal.aborted) mountAbort.abort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    let lease: AcpScopedMcpLease | undefined
    try {
      lease = await access.mountScopedMcp(agent, agent.session, servers, () => {
        if (signal?.aborted === true || mountAbort.signal.aborted) return 'stale'
        return this.isMcpAdmissionCurrent(state, op, claim, agent) ? 'current' : 'stale'
      }, mountAbort.signal)
    } catch (error) {
      claim.mcpMountPending = false
      claim.mcpMountAbort = undefined
      signal?.removeEventListener('abort', forwardAbort)
      if (error instanceof AcpScopedMcpError) {
        if (error.lease !== undefined) {
          claim.mcpLease = error.lease
          this.requestMcpRetire(claim, access)
          claim.detachedWithFence = true
        }
        throw mapScopedMcpError(error, claim.sessionId)
      }
      throw new LocalAcpViewError(
        'LOCAL_ACP_MCP_START_FAILED',
        'the scoped MCP server could not be started',
        JSONRPC_INTERNAL_ERROR,
        { sessionId: claim.sessionId },
      )
    }
    claim.mcpMountPending = false
    claim.mcpMountAbort = undefined
    signal?.removeEventListener('abort', forwardAbort)
    if (lease === undefined) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_MCP_START_FAILED',
        'the scoped MCP server could not be started',
        JSONRPC_INTERNAL_ERROR,
        { sessionId: claim.sessionId },
      )
    }
    claim.mcpLease = lease
    if (claim.mcpRetireRequested === true || !this.isMcpAdmissionCurrent(state, op, claim, agent)) {
      this.requestMcpRetire(claim, access)
      throw new LocalAcpViewError(
        'LOCAL_ACP_MCP_STALE',
        'the ACP view changed while its MCP servers were mounted',
        JSONRPC_INVALID_PARAMS,
        { sessionId: claim.sessionId },
      )
    }
  }

  /**
   * Start the ONE singleflight retirement of this claim's exact lease. The
   * claim stays reserved/fenced until the official Fiber closure and tool
   * absence are confirmed; a failed cleanup keeps the lease instead of
   * allowing a second View to reuse the Session.
   */
  private requestMcpRetire(claim: ViewClaim, access: HostAcpSessionAccess): void {
    const lease = claim.mcpLease
    if (lease === undefined) return
    if (claim.mcpRetireRequested === true && lease.retirePromise !== undefined) return
    claim.mcpRetireRequested = true
    runDetached('local acp: scoped MCP retirement', async () => {
      try {
        await access.requestRetireScopedMcp(lease)
      } catch (error) {
        const code = error instanceof AcpScopedMcpError ? error.code : 'CLEANUP_UNCONFIRMED'
        this.diag.warn('local-acp.mcp-retire-unconfirmed', { code })
        return
      }
      if (claim.mcpLease !== lease) return
      claim.mcpLease = undefined
      if (claim.mcpMountPending === true) return
      if (this.claims.get(claim.sessionId) !== claim) return
      // A still-attached View keeps its Session claim; only a detached View
      // releases after the MCP responsibility is gone.
      if (claim.connectionIdentity.phase === 'attached' && !claim.detachedWithFence) return
      if (claim.inflight !== undefined || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined) {
        claim.detachedWithFence = true
        this.notifyWorkSettled()
        return
      }
      this.claims.delete(claim.sessionId)
      this.notifyWorkSettled()
    }, { diag: this.diag })
  }

  /**
   * Detach ONLY this connection's View for one Session. PO-3B: when a prompt
   * flight is still open, the close FIRST drives the same scoped cancellation
   * and waits for its real settlement (durable queued removal or the exact
   * running turn's terminal plus the output drain); only a proven settlement
   * detaches the View. A repeated close awaits the SAME settlement; an
   * unknown, inactive or foreign Session close is the standard idempotent `{}`
   * and has no Host side effect. The Host Agent and Session always stay alive;
   * no other connection's claim is touched.
   */
  async closeSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    sessionId: string,
  ): Promise<Record<string, never>> {
    const claim = this.claims.get(sessionId)
    if (claim === undefined || claim.connectionIdentity !== state) return {}
    // A detached claim observes Host settlement only; another Session may now
    // own this connection's attaching/attached View.
    if (claim.detachedWithFence) return {}
    // A close during the async MCP admission commits retirement intent; the
    // late mount result must retire its own lease instead of attaching.
    if (claim.mcpMountPending === true) {
      claim.mcpRetireRequested = true
      claim.mcpMountAbort?.abort()
      claim.detachedWithFence = true
      state.phase = 'idle'
      return {}
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
    // The View is detached now; request the scoped MCP retirement so the
    // claim stays fenced only until the official Fiber closure is confirmed.
    if (claim.mcpLease !== undefined) this.requestMcpRetire(claim, access)
    return this.finishClose(state, sessionId, claim)
  }

  /** End one unclaimed obligation on a real terminal fact. A discarded notice
   * only schedules a checkpoint; official pending absence is verified later.
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

  private retainRetiringTurn(claim: ViewClaim, turn: TurnProvenance): void {
    const existing = claim.retiringTurn
    if (existing !== undefined && existing.turn !== turn.turn) {
      const current = claim.exactAgent !== undefined && claim.exactSession !== undefined
        ? this.access?.currentTurn(claim.sessionId, claim.exactAgent, claim.exactSession)
        : undefined
      if (current?.kind === 'current' && current.openTurn === existing.turn) return
    }
    claim.retiringTurn = turn
  }

  /** Release a detached claim once no Host obligation or fence remains. */
  private releaseDetachedIfSettled(claim: ViewClaim): void {
    if (!claim.detachedWithFence) return
    if (claim.inflight !== undefined) return
    if (claim.retiringTurn !== undefined) return
    if (claim.unclaimedHostObligation !== undefined) return
    if (claim.mcpMountPending === true || claim.mcpLease !== undefined) return
    if (this.claims.get(claim.sessionId) === claim) this.claims.delete(claim.sessionId)
  }

  /** Release one settled claim and record the idempotent close fact. */
  private finishClose(state: ConnectionViewState, sessionId: string, claim: ViewClaim): Record<string, never> {
    if (this.claims.get(sessionId) !== claim || claim.detachedWithFence || state.phase === 'closed') return {}
    // A closed View owns no connection output or reverse Form any more.
    claim.notifyConfigOptions = undefined
    this.releaseQuestionForms(claim)
    // A transient terminal fact may still outlive the View: a retired-turn
    // approval fence (F2) or an unclaimed Host obligation (v1.1). The View
    // detaches, but the claim survives so a LATE approval of that exact
    // ACP-owned turn can never be delegated to the TUI and a late insertion is
    // still observed. A claim with no such fact is released now.
    if (claim.retiringTurn !== undefined || claim.mcpMountPending === true || claim.mcpLease !== undefined) {
      claim.detachedWithFence = true
    } else if (this.claims.get(sessionId) === claim) {
      this.claims.delete(sessionId)
      this.notifyWorkSettled()
    }
    // This close also cancels any in-flight attach for this connection (same
    // generation semantics as PO-2); a superseded op can never re-commit.
    state.phase = 'idle'
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
    if (claim === undefined || claim.connectionIdentity !== state || claim.detachedWithFence) return
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
    // A closing or disconnected View cannot deliver any further output: close
    // delivery FIRST, then stop this flight's own output IO (never the Host
    // Agent/Session/Writer). A held image read is therefore abandoned here and
    // the flight still settles on the real Host terminal facts below.
    if (reason === 'disconnect' || reason === 'closing') {
      flight.deliveryClosed = true
      this.stopFlightOutput(flight)
    }
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
        this.stopFlightOutput(flight)
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
      // The official user cancel is now the authority for this turn: stop this
      // flight's own output IO so a held Store read can never delay the real
      // cancelled `turn/end` settlement. Already delivered notifications stay.
      this.stopFlightOutput(flight)
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
   * Admit one ACP text/resource_link/image prompt on this connection's attached View and
   * settle it on the exact Host facts. The slot and the View-minted `requestId` are committed
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
    imageEnabled: boolean,
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
      || claim.detachedWithFence
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
    const content = validatePromptContent(request.prompt, imageEnabled)
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

    const currentAtFlightStart = access.currentTurn(request.sessionId, claim.exactAgent, claim.exactSession)
    if (currentAtFlightStart.kind === 'stale') {
      throw promptError('LOCAL_ACP_PROMPT_STALE_AGENT', 'the borrowed turn identity changed before admission', JSONRPC_INVALID_PARAMS)
    }
    const admission = Promise.withResolvers<void>()
    const outputAbort = new AbortController()
    const flight: InflightPrompt = {
      requestId: randomUUID(),
      phase: 'admitting',
      ...(currentAtFlightStart.openTurn === null ? {} : {
        turnProvenance: {
          turn: currentAtFlightStart.openTurn,
          origin: claim.retiringTurn?.turn === currentAtFlightStart.openTurn ? claim.retiringTurn.origin : 'tui',
        },
      }),
      mixed: false,
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
      outputAbort,
      outputSignal: outputAbort.signal,
      outputStopped: false,
      outputTasksQueued: 0,
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
      // The request channel is gone: this flight's OWN output IO stops here
      // (a later settlement still owns the real Host fact). The Agent is
      // untouched — an aborted request is never a Host cancellation proof.
      this.stopFlightOutput(flight)
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

  /** The source of a turn already open when this exact ACP message is inserted. */
  private turnProvenanceAtOwnInsertion(claim: ViewClaim, agent: LiveAgentViewIdentity): TurnProvenance | undefined {
    const session = claim.exactSession
    const access = this.access
    if (session === undefined || access === undefined) return undefined
    const checkpoint = access.currentTurn(claim.sessionId, agent, session)
    if (checkpoint.kind === 'stale') return { turn: null, origin: 'unknown' }
    if (checkpoint.openTurn === null) return undefined
    return {
      turn: checkpoint.openTurn,
      origin: claim.retiringTurn?.turn === checkpoint.openTurn ? claim.retiringTurn.origin : 'tui',
    }
  }

  /** One message entered or re-entered the live inbox: correlate the View-minted request id. */
  onInboxInserted(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void {
    const rpcId = message.source?.kind === 'user' ? message.source.rpcId : undefined
    for (const claim of this.claims.values()) {
      // Reinserted obligations use the same exact-id checkpoint as live Flights.
      const obligation = claim.unclaimedHostObligation
      if (
        obligation !== undefined && claim.exactAgent === agent
        && (obligation.messageId === message.id
          || (obligation.messageId === undefined && rpcId !== undefined && rpcId === obligation.requestId))
      ) {
        const firstInsertion = obligation.messageId === undefined
        obligation.messageId = message.id
        obligation.turnProvenance = this.turnProvenanceAtOwnInsertion(claim, agent)
        if (firstInsertion && claim.exactSession !== undefined && this.access !== undefined) {
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
      if (flight.messageId !== message.id
        && (flight.messageId !== undefined || rpcId === undefined || rpcId !== flight.requestId)) continue
      // Save the durable id before cancellation and refresh its turn source on
      // every same-id reinsert, before the official Inbox wakes the driver.
      flight.messageId = message.id
      flight.turnProvenance = this.turnProvenanceAtOwnInsertion(claim, agent)
      if (flight.cancelRequested && this.access !== undefined) {
        this.addressCancelIntent(claim, flight, this.access)
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
        this.retainRetiringTurn(claim, {
          turn,
          origin: obligation.turnProvenance?.turn === turn ? obligation.turnProvenance.origin : 'acp',
        })
        this.notifyWorkSettled()
      }
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (flight.messageId !== undefined && message.id === flight.messageId) {
        if (flight.turn === undefined) {
          flight.turn = turn
          if (flight.phase === 'admitting' || flight.phase === 'queued') flight.phase = 'claimed'
          const turnProvenance = flight.turnProvenance
          if (turnProvenance?.turn === turn || flight.foreignTurn === turn) this.markFlightMixed(flight)
          flight.foreignTurn = undefined
          // A pending cancellation now has its authoritative turn: address it
          // in this SAME callback stack before the Agent can run further.
          if (flight.cancelRequested && this.access !== undefined) {
            this.addressCancelIntent(claim, flight, this.access)
          }
        }
        continue
      }
      // A user-role context injection is not another user's prompt. Only a
      // claim carrying a proven HUMAN source discriminant can make this
      // flight's turn MIXED: an ordinary user prompt and a late
      // `user-question-reply` are both human input, whatever their text says.
      if (!HUMAN_INBOX_SOURCES.has(message.source?.kind ?? '')) continue
      if (flight.turn !== undefined) {
        if (flight.turn === turn) this.markFlightMixed(flight)
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
      // A committed model/selection record is the ONLY config-update trigger.
      // It re-reads the Host authority asynchronously; the per-claim chain and
      // the post-read identity checks keep a late result from replacing a
      // newer View's state.
      if (event.type === 'model/selection' && claim.notifyConfigOptions !== undefined) {
        this.enqueueConfigNotification(claim, session)
      }
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
      // never plants a retired-turn fence for a turn that already ended, and
      // release any provisional attempt whose own `end` frame never arrived —
      // its durable message can then never be joined to the shown bytes.
      if (event.type === 'turn/end') {
        flight.ownTurnEnded = true
        const open = flight.stream
        if (open !== undefined) {
          // Its `end` frame never arrived: whatever it already delivered can
          // never be joined to a durable append.
          if (!open.hasTerminal && open.hasSent()) flight.unprovenProvisional ??= open.attemptId
          open.endWithoutTerminal()
        }
      }
      if (flight.mixed) {
        // A mixed turn projects NOTHING further; it can only settle as a
        // failure once the turn reaches its own terminal record.
        if (event.type === 'turn/end') this.settleTurnEnd(claim, flight, data)
        continue
      }
      switch (event.type) {
        case 'assistant/message':
          this.projectAssistantMessage(claim, flight, event, data)
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
   * One transient assistant-stream frame of an emitting Agent.
   *
   * Only THIS View's exact attached Agent and its already-claimed turn may
   * stream: `start.turn` must be the official claimed turn of a live flight,
   * every later chunk/end resolves through the attempt id the View opened, and
   * a foreign/stale/settled/mixed/closed flight never emits anything. Deltas
   * are handed to the flight's single bounded output tail in frame order, so a
   * slow transport fails the one request instead of growing a second buffer.
   */
  onAssistantStream(agent: LiveAgentViewIdentity, frame: unknown): void {
    const parsed = readAssistantStreamFrame(frame)
    if (parsed === undefined) return
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent) continue
      const flight = claim.inflight
      if (flight === undefined || flight.settledDone) continue
      if (flight.mixed || flight.deliveryClosed || flight.outputStopped) continue
      // A stream frame is attributable ONLY through the flight's official
      // claimed turn: nothing is inferred from Session status or the latest turn.
      if (flight.turn === undefined) continue
      // A flight that already delivered bytes no durable message can own never
      // accepts another attempt: streaming more would only stack more
      // unretractable output in front of the failure this flight must report.
      if (flight.unprovenProvisional !== undefined) continue
      if (parsed.type === 'start') {
        if (parsed.turn !== flight.turn) continue
        // A new attempt replaces a previous one whose terminal frame never
        // arrived; the old attempt can then never join a durable message, so
        // its delivered bytes poison this flight's success.
        const previous = flight.stream
        if (previous !== undefined) {
          if (!previous.hasTerminal && previous.hasSent()) flight.unprovenProvisional ??= previous.attemptId
          previous.endWithoutTerminal()
        }
        flight.stream = new AcpAssistantStream(parsed, randomUUID())
        continue
      }
      const attempt = flight.stream
      if (attempt === undefined || attempt.attemptId !== parsed.attemptId) continue
      if (parsed.type === 'chunk') {
        const action = attempt.acceptChunk(parsed)
        if (action.kind !== 'delta') continue
        const update: SessionUpdate = action.delta.kind === 'message'
          ? { sessionUpdate: 'agent_message_chunk', messageId: attempt.messageId, content: { type: 'text', text: action.delta.text } }
          : { sessionUpdate: 'agent_thought_chunk', messageId: attempt.messageId, content: { type: 'text', text: action.delta.text } }
        this.enqueueOutputTask(claim, flight, 1, () => [update])
        continue
      }
      attempt.acceptEnd(parsed)
      // A committed assistant ATTEMPT (the official retry: `assistant/attempt`)
      // or an abandoned attempt never owns a durable message, so provisional
      // bytes already delivered under it can never be reconciled.
      if (attempt.hasSent()
        && !(parsed.outcome.kind === 'committed' && parsed.outcome.eventType === 'assistant/message')) {
        flight.unprovenProvisional ??= attempt.attemptId
      }
    }
  }

  /**
   * The ONE question classification seat of the shared `user-questions/request`
   * waterfall. Registered with `prepend: true`, it decides from exact facts only:
   * this View's exact attached Agent, the official current-turn fence and the
   * flight/retired turn that already owns that turn.
   *
   * A proven foreign (TUI/autonomous) turn calls `next()` exactly once and never
   * touches the existing TUI seat. A proven ACP-owned turn is answered HERE
   * through the standard Form of THIS connection; when the Form capability, the
   * Host question service or the attribution itself is unavailable it fails
   * closed instead of handing an ACP question to the TUI or a permission flow.
   */
  async onQuestionRequest(
    request: AcpQuestionRequest,
    next: () => Promise<AcpQuestionAnswer>,
  ): Promise<AcpQuestionAnswer> {
    const agent = request.agent
    // An agentless programmatic ask has no Session identity to attribute.
    if (agent === undefined) return await next()
    let claim: ViewClaim | undefined
    for (const candidate of this.claims.values()) {
      if (candidate.exactAgent === agent) {
        claim = candidate
        break
      }
    }
    // Not an ACP-borrowed Agent: the TUI/other owner keeps its own seat.
    if (claim === undefined) return await next()
    const attribution = this.questionAttribution(claim, agent)
    if (attribution === 'foreign') return await next()
    const access = this.access
    const requester = claim.requestElicitation
    if (attribution !== 'acp' || access === undefined || requester === undefined || !access.hasQuestionService()) {
      // Fail closed: never a stolen TUI answer, never a permission fallback and
      // never a fabricated "skipped" batch.
      throw questionError(
        'LOCAL_ACP_QUESTION_UNAVAILABLE',
        'this ACP view cannot serve an owned user question on this connection',
      )
    }
    return request.wait?.timed === true
      ? await this.askTimedQuestion(claim, requester, request)
      : await this.askBlockingQuestion(claim, requester, request)
  }

  /**
   * One official projection change. The View never derives continued state
   * itself: it re-reads the official snapshot of the exact Session and either
   * applies its single stored legal answer or stops a resumed Form whose call
   * another owner already settled.
   */
  onQuestionProjection(session: object, key: string): void {
    if (key !== 'userQuestions' && key !== 'inbox') return
    for (const claim of this.claims.values()) {
      if (claim.exactSession !== session) continue
      for (const obligation of [...claim.continuedQuestions?.values() ?? []]) {
        if (obligation.answer !== undefined && obligation.applied !== true) {
          this.applyContinuedAnswer(claim, obligation)
        }
      }
      for (const form of [...claim.questionForms ?? []]) {
        if (form.kind !== 'continued' || form.callId === undefined) continue
        if (this.callAnswerability(claim, form.callId) !== 'settled') continue
        // Another human/client already settled this call: stop the Form AND
        // reclaim the EXACT obligation it belongs to, so a long-lived View never
        // accumulates dead obligations (Map entry + Form handle). A call that is
        // merely not YET recorded as continued keeps its Form and its answer:
        // the official `tool/result` may still be committing.
        const obligation = claim.continuedQuestions?.get(form.callId)
        form.abort()
        if (obligation !== undefined && obligation.abort === form) {
          this.dropContinuedQuestion(claim, obligation)
        }
      }
    }
  }

  /**
   * Read one call's answerability from the official `userQuestions` projection.
   * `unknown` is a real fact too (the projection is unavailable, or it has not
   * recorded the call yet because its durable result is still committing) and is
   * NEVER the same as "settled".
   */
  private callAnswerability(claim: ViewClaim, callId: string): 'continued' | 'settled' | 'unknown' {
    const access = this.access
    const agent = claim.exactAgent
    const session = claim.exactSession
    if (access === undefined || agent === undefined || session === undefined) return 'unknown'
    const snapshot = access.questionSnapshot(claim.sessionId, agent, session)
    if (snapshot.kind !== 'current') return 'unknown'
    if (snapshot.continued.some(question => question.callId === callId)) return 'continued'
    return snapshot.settled.has(callId) ? 'settled' : 'unknown'
  }

  /**
   * Attribute one question to this View's owned turn, or to another owner.
   * The ORIGIN decision is the SAME one the approval seat makes: the exact
   * Agent, the official current-turn fence, and the live flight or retained
   * retired turn that already declared the responder of that turn. A turn this
   * View did not open (a TUI-origin turn the ACP message was steered into)
   * keeps its TUI responder even while this flight is mixed. `unknown` is a
   * real fact (lost identity, unprovable turn, or a dead View) and must fail
   * closed rather than delegate an ACP question to the TUI.
   */
  private questionAttribution(claim: ViewClaim, agent: LiveAgentViewIdentity): 'acp' | 'foreign' | 'unknown' {
    const access = this.access
    const session = claim.exactSession
    if (access === undefined || session === undefined || claim.exactAgent !== agent) return 'unknown'
    const fence = access.currentTurn(claim.sessionId, agent, session)
    if (fence.kind === 'stale') return 'unknown'
    const openTurn = fence.openTurn
    if (openTurn === null) return 'unknown'
    const flight = claim.inflight
    const declared: TurnProvenance | undefined = claim.retiringTurn?.turn === openTurn
      ? claim.retiringTurn
      : flight !== undefined && !flight.settledDone && flight.turn === openTurn
        ? { turn: openTurn, origin: flight.turnProvenance?.turn === openTurn ? flight.turnProvenance.origin : 'acp' }
        : flight?.turnProvenance?.turn === openTurn
          ? flight.turnProvenance
          : undefined
    if (declared === undefined) return 'foreign'
    if (declared.origin === 'unknown') return 'unknown'
    if (declared.origin === 'tui') return 'foreign'
    // ACP-owned, but this View no longer serves the Session: a closed/detached
    // claim must not answer from a dead connection.
    if (claim.connectionIdentity.phase !== 'attached' || claim.detachedWithFence) return 'unknown'
    return 'acp'
  }

  /**
   * One blocking question of an owned turn: send ONE standard Form on THIS
   * connection and return the human's answer to the original waterfall. The
   * request's own abort (turn cancellation, disconnect, disposal) revokes the
   * Form; the Form is never converted into a permission or a TUI question.
   */
  private async askBlockingQuestion(
    claim: ViewClaim,
    requester: AcpElicitationRequester,
    request: AcpQuestionRequest,
  ): Promise<AcpQuestionAnswer> {
    const form = buildQuestionForm(request.questions)
    if (form === undefined) {
      throw questionError('LOCAL_ACP_QUESTION_UNAVAILABLE', 'the question batch cannot be represented as a standard form')
    }
    const abort = new AbortController()
    const handle = this.addQuestionForm(claim, abort, 'blocking', request.wait?.callId)
    // A blocking Form shares the official request lifetime: the turn's own
    // cancellation (or this claim's release) revokes the reverse request.
    const pending = requester(this.elicitationRequest(claim, form, request.wait?.callId), {
      signal: combinedSignal(request.signal, abort.signal),
    })
    // Observe the reverse request BEFORE racing: an aborted Form can reject
    // late, and a rejection with no handler would surface in the Host process.
    observeSettled(pending, () => {})
    try {
      const raced = await raceQuestionResponse(pending, request.signal, abort.signal)
      if (raced.kind === 'aborted') {
        abort.abort()
        throw questionAborted(raced.reason, request.signal)
      }
      return answerOutcome(form, raced.response)
    } finally {
      this.removeQuestionForm(claim, handle)
    }
  }

  /**
   * One TIMED question of an owned turn. The DSH `askTimed` deadline stays the
   * only clock (this View never attaches a wait, so no Client countdown can
   * extend it): when that deadline aborts the waterfall, the original request
   * settles as pending immediately while the Form becomes this CONNECTION's
   * continued obligation. Any other abort revokes the Form.
   */
  private async askTimedQuestion(
    claim: ViewClaim,
    requester: AcpElicitationRequester,
    request: AcpQuestionRequest,
  ): Promise<AcpQuestionAnswer> {
    const signal = request.signal
    const callId = request.wait?.callId
    if (signal === undefined || callId === undefined) {
      throw questionError('LOCAL_ACP_QUESTION_UNAVAILABLE', 'a timed question needs its official wait identity')
    }
    const form = buildQuestionForm(request.questions)
    if (form === undefined) {
      throw questionError('LOCAL_ACP_QUESTION_UNAVAILABLE', 'the question batch cannot be represented as a standard form')
    }
    const abort = new AbortController()
    const handle = this.addQuestionForm(claim, abort, 'continued', callId)
    // The Form follows ONLY this claim/connection lifetime, never the DSH
    // deadline: when that deadline ends the foreground waterfall the Form is
    // intentionally kept, and only a claim release/disposal aborts it.
    const pending = requester(this.elicitationRequest(claim, form, callId), { signal: abort.signal })
    observeSettled(pending, () => {})
    const raced = await raceQuestionResponse(pending, signal)
    if (raced.kind === 'aborted') {
      if (!isTimedOutReason(raced.reason)) {
        // Turn cancel/dispose/Close/Off: the Form is revoked with the turn.
        abort.abort()
        this.removeQuestionForm(claim, handle)
        throw questionAborted(raced.reason, signal)
      }
      // The foreground wait expired. Hand the still-open Form to its OWN
      // continued obligation (keyed by the official call id) and let the
      // official `askTimed` answer `pending`. Other timed questions of the same
      // claim keep their own obligations untouched.
      const obligation: ContinuedQuestionObligation = { callId, form, abort: handle }
      const obligations = claim.continuedQuestions ?? new Map<string, ContinuedQuestionObligation>()
      claim.continuedQuestions = obligations
      obligations.set(callId, obligation)
      this.watchContinuedResponse(claim, obligation, pending)
      throw raced.reason
    }
    this.removeQuestionForm(claim, handle)
    return answerOutcome(form, raced.response)
  }

  /** The standard Form request of one exact attached View. */
  private elicitationRequest(claim: ViewClaim, form: AcpQuestionForm, callId: string | undefined): AcpElicitationRequest {
    return {
      message: form.message,
      sessionId: claim.sessionId,
      ...callId === undefined ? {} : { toolCallId: callId },
      requestedSchema: form.requestedSchema,
    }
  }

  /** Register one outstanding reverse Form of this claim (aborted on release). */
  private addQuestionForm(
    claim: ViewClaim,
    abort: AbortController,
    kind: QuestionFormAbort['kind'],
    callId: string | undefined,
  ): QuestionFormAbort {
    const handle: QuestionFormAbort = {
      kind,
      ...callId === undefined ? {} : { callId },
      abort: () => abort.abort(),
    }
    const forms = claim.questionForms ?? new Set<QuestionFormAbort>()
    claim.questionForms = forms
    forms.add(handle)
    return handle
  }

  private removeQuestionForm(claim: ViewClaim, handle: QuestionFormAbort): void {
    claim.questionForms?.delete(handle)
  }

  /**
   * A late Form response of a continued question: the original waterfall is
   * already settled, so the answer may only reach the official
   * `userQuestions.answer` once the projection proves the call is continued.
   */
  private watchContinuedResponse(
    claim: ViewClaim,
    obligation: ContinuedQuestionObligation,
    pending: Promise<AcpElicitationResponse>,
  ): void {
    runDetached('local acp: continued question response', async () => {
      let response: AcpElicitationResponse
      try {
        response = await pending
      } catch {
        // The reverse request died. A connection release already cleared every
        // obligation; a Form the claim still lists must instead be reclaimed
        // here by identity, so a rejected reverse request can never leave a dead
        // obligation (and its Form handle) behind.
        if (claim.continuedQuestions?.get(obligation.callId) === obligation) {
          this.dropContinuedQuestion(claim, obligation)
        }
        return
      }
      // The response may have crossed a real await: only the claim that still
      // owns this exact obligation on a LIVE attached View may act on it.
      if (!this.continuedObligationCurrent(claim, obligation)) return
      this.removeQuestionForm(claim, obligation.abort)
      const outcome = answerQuestionForm(obligation.form, response)
      if (outcome.kind !== 'answered') {
        if (outcome.kind === 'invalid') {
          this.diag.warn('local-acp.question', { code: 'LOCAL_ACP_QUESTION_BAD_ANSWER' })
        }
        // decline/cancel/invalid: never write a fabricated late answer.
        this.dropContinuedQuestion(claim, obligation)
        return
      }
      obligation.answer = { answers: outcome.answers }
      this.applyContinuedAnswer(claim, obligation)
    }, { diag: this.diag })
  }

  /**
   * Apply the ONE stored legal late answer through the official service, at
   * most once. The official projection is the answerability authority, and the
   * official `answer()` result keeps its exact meaning: `true` is "queued into
   * the inbox", `false` is "no longer continued", and a rejection keeps its own
   * code (never retried, never converted into success).
   */
  private applyContinuedAnswer(claim: ViewClaim, obligation: ContinuedQuestionObligation): void {
    if (obligation.answer === undefined || obligation.applied === true) return
    if (!this.continuedObligationCurrent(claim, obligation)) return
    const access = this.access
    const agent = claim.exactAgent
    const session = claim.exactSession
    if (access === undefined || agent === undefined || session === undefined) {
      this.dropContinuedQuestion(claim, obligation)
      return
    }
    const answerability = this.callAnswerability(claim, obligation.callId)
    if (answerability === 'settled') {
      this.dropContinuedQuestion(claim, obligation)
      return
    }
    if (answerability === 'unknown') {
      // The durable `tool/result` that marks the call continued may not be
      // committed yet: keep the single answer for the projection change.
      return
    }
    // Nothing may await between this fence and the write: `answer()` is
    // synchronous, so the claim that passed the fence is the one that writes.
    if (!this.questionClaimCurrent(claim)) {
      this.dropContinuedQuestion(claim, obligation)
      return
    }
    obligation.applied = true
    const outcome = access.answerContinued(
      claim.sessionId,
      agent,
      session,
      obligation.callId,
      obligation.answer,
      () => this.questionClaimCurrent(claim),
    )
    this.reportContinuedOutcome(outcome)
    this.dropContinuedQuestion(claim, obligation)
  }

  /** Read one official continued-answer result without inventing a success. */
  private reportContinuedOutcome(outcome: AcpContinuedAnswerOutcome): void {
    if (outcome.kind === 'queued' || outcome.kind === 'not-continued' || outcome.kind === 'stale') return
    const code = outcome.kind === 'rejected' ? outcome.code : 'LOCAL_ACP_QUESTION_UNAVAILABLE'
    this.diag.warn('local-acp.question', { code })
  }

  /**
   * The ONE ownership fence of every question write. It is re-read after each
   * real await and immediately before the official submission: a View that was
   * closed, detached, re-bound or disposed must never answer a shared-Session
   * question, because its human is no longer the connection's human.
   */
  private questionClaimCurrent(claim: ViewClaim): boolean {
    return this.claims.get(claim.sessionId) === claim
      && claim.connectionIdentity.phase === 'attached'
      && !claim.detachedWithFence
      && this.access !== undefined
  }

  /** Whether this claim still owns THIS exact obligation on a live attached View. */
  private continuedObligationCurrent(claim: ViewClaim, obligation: ContinuedQuestionObligation): boolean {
    return claim.continuedQuestions?.get(obligation.callId) === obligation && this.questionClaimCurrent(claim)
  }

  /** Release one continued obligation and its reverse Form. */
  private dropContinuedQuestion(claim: ViewClaim, obligation: ContinuedQuestionObligation): void {
    this.removeQuestionForm(claim, obligation.abort)
    const obligations = claim.continuedQuestions
    if (obligations?.get(obligation.callId) === obligation) obligations.delete(obligation.callId)
    this.notifyWorkSettled()
  }

  /**
   * Release every reverse Form and continued obligation of one claim. It is
   * the ONE release hook shared by close, disconnect/Off, Agent disposal and
   * claim retirement: the Host durable question projection is never touched.
   */
  private releaseQuestionForms(claim: ViewClaim): void {
    const forms = claim.questionForms
    claim.questionForms = undefined
    if (forms !== undefined) {
      for (const form of forms) form.abort()
    }
    claim.continuedQuestions = undefined
    claim.questionOfferTail = undefined
    claim.offeredQuestions = undefined
  }

  /**
   * Offer every still-answerable continued question of a resumed Session as
   * ONE Form at a time, in official ask order. The offer is connection-local:
   * `offeredQuestions` only dedupes THIS connection, and no durable answer
   * state is created. A call another owner settles first stops its Form.
   */
  private offerContinuedQuestions(claim: ViewClaim, requester: AcpElicitationRequester): void {
    const access = this.access
    const agent = claim.exactAgent
    const session = claim.exactSession
    if (access === undefined || agent === undefined || session === undefined) return
    const snapshot = access.questionSnapshot(claim.sessionId, agent, session)
    if (snapshot.kind !== 'current') return
    const offered = claim.offeredQuestions ?? new Set<string>()
    claim.offeredQuestions = offered
    for (const question of snapshot.continued) {
      if (offered.has(question.callId)) continue
      offered.add(question.callId)
      const previous = claim.questionOfferTail ?? Promise.resolve()
      claim.questionOfferTail = previous.then(async () => {
        if (this.claims.get(claim.sessionId) !== claim || claim.detachedWithFence) return
        if (claim.connectionIdentity.phase !== 'attached') return
        const form = buildQuestionForm(question.questions)
        if (form === undefined) return
        const abort = new AbortController()
        const handle = this.addQuestionForm(claim, abort, 'continued', question.callId)
        try {
          const response = await requester(this.elicitationRequest(claim, form, question.callId), {
            signal: abort.signal,
          })
          const outcome = answerQuestionForm(form, response)
          if (outcome.kind !== 'answered') return
          const submission = this.submitContinuedAnswer(claim, question.callId, { answers: outcome.answers })
          if (submission !== 'submitted') {
            this.diag.warn('local-acp.question', { code: 'LOCAL_ACP_QUESTION_NOT_CONTINUED' })
          }
        } catch {
          // The Form was aborted with its connection/claim or the call was
          // settled elsewhere: this offer ends here, nothing is retried.
        } finally {
          this.removeQuestionForm(claim, handle)
        }
      }).catch(() => {})
    }
  }

  /**
   * Submit ONE already-received legal answer for a continued call exactly once.
   * `wait` means the official projection has not yet recorded the call as
   * continued (or settled) — the caller decides whether to keep the answer.
   */
  private submitContinuedAnswer(claim: ViewClaim, callId: string, answer: AcpQuestionAnswer): 'submitted' | 'not-continued' | 'wait' {
    const access = this.access
    const agent = claim.exactAgent
    const session = claim.exactSession
    if (access === undefined || agent === undefined || session === undefined) return 'not-continued'
    if (!this.questionClaimCurrent(claim)) return 'not-continued'
    const answerability = this.callAnswerability(claim, callId)
    if (answerability === 'settled') return 'not-continued'
    if (answerability === 'unknown') return 'wait'
    const outcome = access.answerContinued(
      claim.sessionId,
      agent,
      session,
      callId,
      answer,
      () => this.questionClaimCurrent(claim),
    )
    this.reportContinuedOutcome(outcome)
    return outcome.kind === 'queued' ? 'submitted' : 'not-continued'
  }

  /**
   * Queue ONE full-option refresh on the claim's ordered notification chain.
   * The chain is transient and per claim: a close/re-bind/teardown clears the
   * callback, a late catalog read never reaches a newer View, and a delivery
   * failure retires only this callback instead of becoming a Host failure.
   */
  private enqueueConfigNotification(claim: ViewClaim, session: object): void {
    const notify = claim.notifyConfigOptions
    const agent = claim.exactAgent
    if (notify === undefined || agent === undefined) return
    const previous = claim.configNotifyTail ?? Promise.resolve()
    const next = previous.then(async () => {
      if (claim.notifyConfigOptions !== notify) return
      if (this.claims.get(claim.sessionId) !== claim || claim.exactSession !== session || claim.exactAgent !== agent) return
      if (claim.connectionIdentity.phase !== 'attached' || claim.detachedWithFence) return
      const access = this.access
      if (access === undefined) return
      let options: SessionConfigOption[]
      try {
        options = await access.modelOptions(agent, session)
      } catch {
        return
      }
      if (claim.notifyConfigOptions !== notify) return
      if (this.claims.get(claim.sessionId) !== claim || claim.exactSession !== session || claim.exactAgent !== agent) return
      if (claim.connectionIdentity.phase !== 'attached' || claim.detachedWithFence) return
      try {
        await notify(claim.sessionId, options)
      } catch {
        // A closed transport only ends this transient capability; the Host,
        // Agent and Session keep their own lifecycle and authority.
        claim.notifyConfigOptions = undefined
      }
    }).catch(() => {})
    claim.configNotifyTail = next
  }

  /**
   * A discard only triggers verification: edit/steer can reinsert the same id
   * within the current synchronous Host mutation. Cross it once, then read the
   * official pending projection and the CURRENT responsibility of this claim.
   */
  onInboxDiscarded(agent: LiveAgentViewIdentity, message: AcpUserMessageLike): void {
    const messageId = message.id
    for (const claim of this.claims.values()) {
      if (claim.exactAgent !== agent || claim.exactSession === undefined) continue
      if (claim.inflight?.messageId !== messageId && claim.unclaimedHostObligation?.messageId !== messageId) continue
      const session = claim.exactSession
      const sessionId = claim.sessionId
      runDetached('local acp: inbox discard checkpoint', async () => {
        await Promise.resolve()
        if (this.claims.get(sessionId) !== claim || claim.exactAgent !== agent || claim.exactSession !== session) return
        const flight = claim.inflight
        const obligation = claim.unclaimedHostObligation
        if (flight?.messageId !== messageId && obligation?.messageId !== messageId) return
        if (this.access?.pendingMessage(sessionId, agent, session, messageId) !== 'absent') return
        if (flight?.messageId === messageId) {
          if (flight.settledDone || flight.turn !== undefined || flight.cancelKind !== undefined) return
          flight.cancelKind = 'queued-removed'
          this.settleQueuedRemoval(claim, flight)
        } else if (obligation?.messageId === messageId) {
          this.dropUnclaimedObligation(claim)
        }
      }, { diag: this.diag })
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
      // The disposed Agent can neither ask nor accept an answer any more: every
      // reverse Form of this claim ends here.
      this.releaseQuestionForms(claim)
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
      // A disposed Agent can never serve this View again: mark the exact claim
      // detached first, then release it once every real obligation/fence has
      // ended. A scoped MCP lease/mount still owns its own retirement path.
      claim.detachedWithFence = true
      if (claim.connectionIdentity.phase !== 'closed') claim.connectionIdentity.phase = 'idle'
      if (claim.mcpMountPending === true) claim.mcpRetireRequested = true
      claim.mcpMountAbort?.abort()
      if (claim.mcpLease !== undefined && this.access !== undefined) this.requestMcpRetire(claim, this.access)
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
    const currentTurn = fence.openTurn
    if (currentTurn === null) {
      return flight?.turn !== undefined || owner.retiringTurn !== undefined ? 'unavailable' : await next()
    }
    // Match the official open turn first; a later queued Flight never hides
    // the retiring ACP turn or takes its original TUI responder.
    const declaredTurn: TurnProvenance | undefined = owner.retiringTurn?.turn === currentTurn
      ? owner.retiringTurn
      : flight !== undefined && !flight.settledDone && flight.turn === currentTurn
        ? { turn: currentTurn, origin: flight.turnProvenance?.turn === currentTurn ? flight.turnProvenance.origin : 'acp' }
        : flight?.turnProvenance?.turn === currentTurn
          ? flight.turnProvenance
          : undefined
    if (declaredTurn === undefined) return await next()
    if (declaredTurn.origin === 'unknown') return 'unavailable'
    if (declaredTurn.origin === 'tui') return await next()
    if (flight === undefined || flight.settledDone || flight.cancelRequested || flight.mixed
      || request.callId === undefined || flight.turn !== currentTurn) {
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
   * PO-3B: a flight with a durable message fact drives the SAME scoped
   * cancellation (queued removal or exact-turn user cancel). A pending
   * admission retains its request identity and claim for late insertion;
   * only proven Host settlement, or classified admission with no inserted
   * message on the exact identity, releases the responsibility. Without any
   * bound Host access, raw-socket contracts retain the PO-3A fail-closed path.
   */
  releaseConnection(state: ConnectionViewState, access?: HostAcpSessionAccess): void {
    state.phase = 'closed'
    // Bump the generation so any in-flight continuation is treated as stale and
    // can never mutate this (closed) connection's state.
    state.op += 1
    for (const [sessionId, claim] of this.claims) {
      if (claim.connectionIdentity !== state) continue
      // A physical teardown/Off/replacement ends this connection's notification
      // capability and every reverse Form/continued obligation immediately,
      // even when the claim survives for a fence fact. The Host's own durable
      // `userQuestions` projection is never touched.
      claim.notifyConfigOptions = undefined
      this.releaseQuestionForms(claim)
      const bound = access ?? this.access
      // An in-flight MCP admission is not cancellable synchronously; commit the
      // retirement intent and keep the reservation until its late result owns
      // and retires its exact lease.
      if (claim.mcpMountPending === true) {
        claim.mcpRetireRequested = true
        claim.mcpMountAbort?.abort()
        claim.detachedWithFence = true
        continue
      }
      if (claim.mcpLease !== undefined && bound !== undefined) this.requestMcpRetire(claim, bound)
      const flight = claim.inflight
      if (flight !== undefined) {
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
          if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
            || claim.mcpLease !== undefined || claim.mcpMountPending === true) {
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
      if (
        obligation !== undefined && obligation.messageId !== undefined
        && claim.exactAgent !== undefined && claim.exactSession !== undefined && bound !== undefined
      ) {
        if (bound.cancelPending(sessionId, claim.exactAgent, claim.exactSession, obligation.messageId) === 'removed') {
          this.dropUnclaimedObligation(claim)
        }
      }
      if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
        || claim.mcpLease !== undefined) {
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
    if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
      || claim.mcpLease !== undefined || claim.mcpMountPending === true) {
      // The fence/obligation survives for its own facts; the claim dies with it.
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
    if (claim.mcpLease !== undefined || claim.mcpMountPending === true) {
      claim.detachedWithFence = true
      this.notifyWorkSettled()
      return
    }
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
    channels?: AcpViewChannels,
  ): void {
    if (state.op !== op || this.claims.get(claim.sessionId) !== claim || claim.connectionIdentity !== state) {
      // A newer op owns this connection or the claim was released; the late
      // result is inert and must not change the current transient state. A
      // successfully mounted lease is retired before its claim can release.
      this.releaseClaimWithMcp(state, claim, access)
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
      this.releaseClaimWithMcp(state, claim, access)
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
    // The transient per-connection channels are bound at the SAME moment the
    // View becomes attached, so no model/selection event or owned question can
    // slip between attach and wiring.
    claim.notifyConfigOptions = channels?.notifyConfigOptions
    claim.requestElicitation = channels?.requestElicitation
  }

  /**
   * Remove ONE exact reservation. Identity is by the CLAIM OBJECT (and its
   * owning connection), never by `sessionId` alone: a close-then-re-attach of
   * the SAME Session produces a NEW claim for the same connection+sessionId, so
   * a stale operation's late release must not delete the newer claim.
   */
  private releaseReservation(state: ConnectionViewState, claim: ViewClaim): void {
    if (claim.mcpMountPending === true || claim.mcpLease !== undefined) {
      claim.detachedWithFence = true
      this.notifyWorkSettled()
      return
    }
    if (this.claims.get(claim.sessionId) === claim && claim.connectionIdentity === state) {
      this.claims.delete(claim.sessionId)
      this.notifyWorkSettled()
    }
  }

  /** Release a failed commit while preserving any exact MCP lease it owns. */
  private releaseClaimWithMcp(state: ConnectionViewState, claim: ViewClaim, access: HostAcpSessionAccess): void {
    if (claim.mcpLease !== undefined) {
      claim.detachedWithFence = true
      this.requestMcpRetire(claim, access)
      this.notifyWorkSettled()
      return
    }
    this.releaseReservation(state, claim)
  }

  /**
   * Clear the CURRENT attempt slot only when it still holds this attempt. A
   * slower reconciliation must never erase the attempt a later step already
   * opened, and the reconciliation itself is owned by its own attempt + seq,
   * not by whichever attempt happens to be current.
   */
  private releaseAttempt(flight: InflightPrompt, attempt: AcpAssistantStream): void {
    if (flight.stream === attempt) flight.stream = undefined
  }

  /**
   * Validate ONE committed assistant message synchronously and reserve its
   * ordered output units on this flight's single tail. Shapes are checked here
   * (a malformed/unsupported event fails before anything is queued); the image
   * reads and the sends happen inside the tail so no later event can overtake
   * this one.
   *
   * When this flight delivered provisional `agent/assistant-stream` text for
   * the SAME attempt, the durable message is a RECONCILIATION, not a second
   * delivery: its slot waits for the attempt's official `end`, proves the exact
   * `seq` join and only then adds the durable blocks that were never streamed
   * (images). Text already shown is never sent twice, and an unprovable join
   * fails closed instead of re-sending a correction.
   */
  private projectAssistantMessage(
    claim: ViewClaim,
    flight: InflightPrompt,
    event: AcpSessionEventLike,
    data: unknown,
  ): void {
    const message = (data as { readonly message?: { readonly id?: unknown; readonly content?: unknown } }).message
    if (message === undefined || typeof message.id !== 'string' || !Array.isArray(message.content)) {
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    const content = this.readAssistantContent(claim, flight, message.content)
    if (content === undefined) return
    const messageId = message.id
    const attempt = flight.stream
    if (attempt === undefined) {
      // No live provisional attempt: the durable event IS the committed output.
      this.enqueueCommittedEntries(claim, flight, messageId, content.entries)
      return
    }
    const interrupted = (data as { readonly interrupted?: unknown }).interrupted === true
    // Reserve only what the join may ACTUALLY send. A streamed attempt already
    // delivered its text/thought under its own ACP message id, so the residual
    // entries are the never-streamed durable images; an attempt that delivered
    // nothing still falls back to the whole committed projection.
    const residual = attempt.hasSent()
      ? content.entries.filter(entry => entry.kind === 'message-image').length
      : content.entries.length
    this.enqueueOutputTask(claim, flight, residual, async () => {
      // Delivered bytes that no durable append can own make every later
      // outcome of this flight a failure, whatever this event proves.
      if (flight.unprovenProvisional !== undefined) throw streamDivergence()
      const end = await attempt.terminalFact
      const joined = joinStreamedMessage(attempt.streamedBlocks(), content.text, {
        sent: attempt.hasSent(),
        interrupted,
      })
      if (joined.kind === 'divergence') throw streamDivergence()
      if (joined.kind === 'unstreamed') {
        // Nothing provisional was delivered: the ordinary committed projection
        // is authoritative and must not be suppressed.
        this.releaseAttempt(flight, attempt)
        return await this.committedUpdates(flight, messageId, content.entries)
      }
      // `joined` needs the official terminal fact of THIS attempt as well: the
      // committed message and its `end` frame close in the same event loop, and
      // only the exact durable `seq` proves both name the same append.
      if (end === undefined || end.kind !== 'committed'
        || end.eventType !== 'assistant/message' || end.seq !== event.seq) {
        throw streamDivergence()
      }
      this.releaseAttempt(flight, attempt)
      // Text/thought blocks were already delivered under the attempt's ACP
      // message id; only durable blocks that were never streamed are added.
      return await this.committedUpdates(
        flight,
        attempt.messageId,
        content.entries.filter(entry => entry.kind === 'message-image'),
      )
    })
  }

  /**
   * Validate one committed assistant block list synchronously. The returned
   * `text` keeps EVERY text/thought block (including empty ones) because the
   * official assembler keeps them too and the stream join compares the exact
   * sequence; `entries` is the ACP projection, which skips empty text/thought
   * blocks and the dedicated tool-call events.
   */
  private readAssistantContent(
    claim: ViewClaim,
    flight: InflightPrompt,
    content: readonly unknown[],
  ): { readonly entries: readonly CommittedOutputEntry[]; readonly text: readonly AcpStreamBlock[] } | undefined {
    const entries: CommittedOutputEntry[] = []
    const text: AcpStreamBlock[] = []
    for (const block of content) {
      const type = (block as { readonly type?: unknown } | null)?.type
      const value = (block as { readonly text?: unknown } | null)?.text
      if (type === 'reasoning' || type === 'text') {
        if (typeof value !== 'string') {
          this.failPrompt(claim, flight, unsupportedContent())
          return undefined
        }
        const kind: AcpStreamBlock['kind'] = type === 'text' ? 'message' : 'thought'
        text.push({ kind, text: value })
        if (value.length > 0) entries.push({ kind: type === 'text' ? 'message' : 'thought', text: value })
        continue
      }
      if (type === 'image') {
        const ref = committedImageRef(block)
        if (ref === undefined) {
          this.failPrompt(claim, flight, unsupportedContent())
          return undefined
        }
        entries.push({ kind: 'message-image', ref })
        continue
      }
      if (type === 'tool-call') {
        // The official `assistant/message` carries its tool-call blocks AND
        // the Host appends each of them as its OWN durable `tool/call` event;
        // the dedicated event (with the real callId/name) is the projection
        // source, so the block here is skipped instead of duplicated.
        continue
      }
      // Audio/file/tool-change/unknown blocks have no standard ACP output form:
      // never truncate or fake one, and never claim the event was delivered.
      this.failPrompt(claim, flight, unsupportedContent())
      return undefined
    }
    return { entries, text }
  }

  /** Append one committed assistant projection to this flight's ordered tail. */
  private enqueueCommittedEntries(
    claim: ViewClaim,
    flight: InflightPrompt,
    messageId: string,
    entries: readonly CommittedOutputEntry[],
  ): void {
    if (entries.every(entry => entry.kind !== 'message-image')) {
      this.enqueueOutputTask(claim, flight, entries.length, (): readonly SessionUpdate[] =>
        committedTextUpdates(messageId, entries))
      return
    }
    this.enqueueOutputTask(claim, flight, entries.length, async () =>
      await this.committedUpdates(flight, messageId, entries))
  }

  /** Convert committed entries to standard updates, reading images through the Host Store. */
  private async committedUpdates(
    flight: InflightPrompt,
    messageId: string,
    entries: readonly CommittedOutputEntry[],
  ): Promise<readonly SessionUpdate[]> {
    const updates: SessionUpdate[] = []
    for (const entry of entries) {
      if (entry.kind === 'thought') {
        updates.push({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: entry.text } })
      } else if (entry.kind === 'message') {
        updates.push({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: entry.text } })
      } else if (entry.kind === 'message-image') {
        const stored = await this.readOutputImage(flight, entry.ref)
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.mediaType },
        })
      }
    }
    return updates
  }

  /** Project one committed tool call of the owned turn as a standard start update. */
  private projectToolCall(claim: ViewClaim, flight: InflightPrompt, data: unknown): void {
    const call = data as { readonly callId?: unknown; readonly name?: unknown; readonly arguments?: unknown }
    if (typeof call.callId !== 'string' || typeof call.name !== 'string') {
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    const rawInput = typeof call.arguments === 'string' ? parseToolArguments(call.arguments) : undefined
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: call.callId,
      title: call.name,
      kind: 'other',
      status: 'in_progress',
      ...(rawInput === undefined ? {} : { rawInput }),
    }
    this.enqueueOutputTask(claim, flight, 1, () => [update])
  }

  /**
   * Project ONE committed tool result as a single standard `tool_call_update`.
   * Its `content` keeps the committed block order (non-empty text and verified
   * images); the status comes only from the official `isError` fact and the
   * `toolCallId` only from the durable message.
   */
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
    const entries: CommittedOutputEntry[] = []
    for (const block of message.content as readonly unknown[]) {
      const type = (block as { readonly type?: unknown } | null)?.type
      const text = (block as { readonly text?: unknown } | null)?.text
      if (type === 'text') {
        if (typeof text !== 'string') {
          this.failPrompt(claim, flight, unsupportedContent())
          return
        }
        if (text.length > 0) entries.push({ kind: 'tool', text })
        continue
      }
      if (type === 'image') {
        const ref = committedImageRef(block)
        if (ref === undefined) {
          this.failPrompt(claim, flight, unsupportedContent())
          return
        }
        entries.push({ kind: 'tool-image', ref })
        continue
      }
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    const toolCallId = message.toolCallId
    const status = message.isError === true ? 'failed' : 'completed'
    const toUpdate = async (): Promise<readonly SessionUpdate[]> => {
      const content: ToolCallContent[] = []
      for (const entry of entries) {
        if (entry.kind === 'tool') {
          content.push({ type: 'content', content: { type: 'text', text: entry.text } })
        } else if (entry.kind === 'tool-image') {
          const stored = await this.readOutputImage(flight, entry.ref)
          content.push({
            type: 'content',
            content: { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.mediaType },
          })
        }
      }
      const update: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId, status, content }
      return [update]
    }
    if (entries.every(entry => entry.kind !== 'tool-image')) {
      this.enqueueOutputTask(claim, flight, 1, (): SessionUpdate[] => {
        const content: ToolCallContent[] = []
        for (const entry of entries) {
          if (entry.kind === 'tool') content.push({ type: 'content', content: { type: 'text', text: entry.text } })
        }
        return [{ sessionUpdate: 'tool_call_update', toolCallId, status, content }]
      })
      return
    }
    this.enqueueOutputTask(claim, flight, 1, toUpdate)
  }

  /**
   * Read ONE committed image through the official Host Attachment Store. The
   * Store owns the ID/format/byte/dimension verification; the View only encodes
   * the verified bytes. Every Store rejection keeps ONE stable content class —
   * never a partial event, a fabricated image or a leaked path/exception.
   */
  private async readOutputImage(flight: InflightPrompt, ref: AcpStoredImageRef): Promise<AcpStoredImage> {
    const access = this.access
    if (access === undefined) throw attachmentReadFailed()
    try {
      return await access.readOutputImage(ref, flight.outputSignal)
    } catch {
      throw attachmentReadFailed()
    }
  }

  /**
   * Append ONE committed event's conversion to this flight's single ordered
   * output tail. `reserve` is the event's synchronously known update count: the
   * FIFO position and the bounded pending counter are committed BEFORE any
   * await, the whole event is converted (official image reads included) inside
   * the tail, and only then are its updates handed to the transport. The
   * bounded pending counter is the ONLY additional queue: exceeding it fails
   * this View's request instead of growing without limit.
   */
  private enqueueOutputTask(
    claim: ViewClaim,
    flight: InflightPrompt,
    reserve: number,
    build: () => readonly SessionUpdate[] | Promise<readonly SessionUpdate[]>,
  ): void {
    if (flight.settledDone) return
    const taskIndex = flight.outputTasksQueued
    flight.outputTasksQueued += 1
    // `reserve` is the number of updates this task will hand to the transport,
    // charged BEFORE any await so a slow Store read cannot outgrow the budget.
    // A reconciliation that will send nothing (every streamed block already
    // delivered) reserves 0 and therefore occupies no output budget: it only
    // owns a tail position.
    if (reserve > 0) {
      flight.pendingUpdates += reserve
      if (flight.pendingUpdates > MAX_PENDING_OUTPUT_UPDATES) {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE',
          'the ACP output queue exceeded its bounded capacity',
          JSONRPC_INTERNAL_ERROR,
        ))
        return
      }
    }
    flight.outputTail = flight.outputTail.then(async () => {
      try {
        // A mixed turn, a settled flight or a closed delivery stops ALL output
        // that has not yet been handed to the transport. Notifications already
        // sent cannot be retracted, but a queued event is still ours to drop.
        if (flight.settledDone || flight.mixed || flight.deliveryClosed
          || (flight.outputStoppedAtTask !== undefined && taskIndex < flight.outputStoppedAtTask)) return
        const built = build()
        // A synchronously converted event is handed to the transport without an
        // extra microtask, preserving the pre-PO-4C delivery timing for text.
        const updates = Array.isArray(built) ? built : await built
        for (const update of updates) {
          // The same enqueue-time fence applies here: a task that was already
          // queued when output was stopped must not hand a late image (or its
          // sibling text) to the transport after its read finally settles.
          if (flight.settledDone || flight.mixed || flight.deliveryClosed
            || (flight.outputStoppedAtTask !== undefined && taskIndex < flight.outputStoppedAtTask)) return
          try {
            await flight.sendUpdate(update)
          } catch {
            // The transport failure keeps its real classification; it never
            // turns into a StopReason and never touches the Host Agent.
            this.failPrompt(claim, flight, promptError(
              'LOCAL_ACP_PROMPT_OUTPUT_FAILED',
              'an ACP session/update notification could not be delivered',
              JSONRPC_INTERNAL_ERROR,
            ))
            return
          }
        }
      } catch (error) {
        // An abort caused by this flight's own output stop (close, disconnect,
        // request abort, Off, disposal, MIXED or a committed cancellation) is
        // not a content failure: the flight keeps its real Host classification.
        // Anything else is this event's own real failure and settles the request
        // here, so the tail never rejects unobserved and `turn/end` never waits
        // forever.
        if (flight.outputStopped || flight.settledDone || flight.mixed || flight.deliveryClosed) return
        this.failPrompt(claim, flight, error instanceof LocalAcpViewError
          ? error
          : promptError('LOCAL_ACP_PROMPT_OUTPUT_FAILED', 'the committed output could not be delivered', JSONRPC_INTERNAL_ERROR))
      } finally {
        flight.pendingUpdates -= reserve
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
      // The REAL terminal reason decides. A blocked/error/aborted/interrupted
      // turn keeps its actual classification. A successful completion needs NO
      // visible assistant output: ACP v1 has no such requirement, and a
      // tool-only (or deliberately silent) completed turn is a real `end_turn`.
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
      // A successful terminal is possible ONLY when every delivered provisional
      // byte was proven committed: unretractable bytes of a retried, replaced,
      // abandoned or lost attempt can never be reported as this success.
      if (flight.unprovenProvisional !== undefined) {
        this.failPrompt(claim, flight, streamDivergence())
        return
      }
      this.completePrompt(claim, flight, { stopReason: kind === 'completed' ? 'end_turn' : 'max_tokens' })
    }, { diag: this.diag })
  }

  /**
   * Stop ONLY this flight's own output IO. Already delivered notifications stay
   * delivered; a queued read is abandoned and its rejection is classified as a
   * closure by the tail, never as a content failure. The Host Agent, Session
   * and writer keep their authority.
   */
  private stopFlightOutput(flight: InflightPrompt): void {
    flight.outputStopped = true
    flight.outputStoppedAtTask ??= flight.outputTasksQueued
    // A provisional attempt whose terminal can never be observed any more must
    // not leave a reconciliation slot waiting forever.
    flight.stream?.endWithoutTerminal()
    flight.outputAbort.abort()
  }

  /**
   * Commit the MIXED fact of one flight: no output committed from now on is
   * projected, and this flight's own not-yet-finished output IO stops (an
   * in-flight official image read is abandoned) so a stalled read can never
   * hold the `turn/end` settlement forever. Already handed-off notifications
   * stay delivered; queued-but-unsent output is dropped at its send check (the
   * accepted PO-3A contract). The Host Agent/Session/Writer are untouched.
   */
  private markFlightMixed(flight: InflightPrompt): void {
    flight.mixed = true
    this.stopFlightOutput(flight)
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
    // Only this flight's own output IO stops here: the official Host Agent,
    // Session and writer keep their authority.
    this.stopFlightOutput(flight)
    this.abortPermissionRequests(flight)
    flight.failureCode = error.code
    // A flight that already holds its official claimed turn but settles before
    // that turn's `turn/end` keeps a transient retired-turn fence: a LATE
    // approval/request of the still-running turn stays ACP-owned (never
    // delegated to the TUI) until the real terminal record arrives. A turn
    // whose durable terminal ALREADY arrived has nothing left to fence.
    if (flight.turn !== undefined && !flight.ownTurnEnded) {
      this.retainRetiringTurn(claim, {
        turn: flight.turn,
        origin: flight.turnProvenance?.turn === flight.turn ? flight.turnProvenance.origin : 'acp',
      })
    }
    // The UNCLAIMED responsibility (v1.1 §3/§5.A.3) is transferred to the
    // claim BEFORE the flight is dropped whenever the official Host has not
    // proven terminal status and no turn was claimed:
    //   - an inserted message that was never claimed (any failure reason);
    //   - an admission still in flight (no insertion fact observed yet).
    // An owned claimed turn is covered by `retiringTurn` above, a definite
    // pre-insertion rejection leaves nothing behind, and the disposed-Agent
    // terminal (ownTurnEnded) covered.
    if (flight.turn === undefined && !flight.ownTurnEnded && flight.cancelKind !== 'queued-removed') {
      if (flight.messageId !== undefined) {
        claim.unclaimedHostObligation = {
          requestId: flight.requestId,
          messageId: flight.messageId,
          admission: flight.admissionSettled ? 'unconfirmed' : 'accepted',
          ...(flight.turnProvenance === undefined ? {} : { turnProvenance: flight.turnProvenance }),
        }
      } else if (!flight.admissionSettled) {
        claim.unclaimedHostObligation = {
          requestId: flight.requestId,
          admission: 'pending',
          ...(flight.turnProvenance === undefined ? {} : { turnProvenance: flight.turnProvenance }),
        }
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
    this.stopFlightOutput(flight)
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
    // The complete stdio declaration list is validated BEFORE any Host
    // Workspace/Session create or child process start.
    parseAcpMcpServers(request.mcpServers)
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP additional directories are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
  }

  private validateResume(request: AcpResumeSessionParams): void {
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'a non-empty sessionId is required', JSONRPC_INVALID_PARAMS)
    }
    validateCwd(request.cwd)
    parseAcpMcpServers(request.mcpServers ?? [])
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
 * Validate and normalize standard ACP prompt blocks in client order.
 * `resource_link` blocks become official bracketed text hints; inline images
 * require this connection's negotiated Host capability. Embedded resource,
 * audio, unknown blocks, empty prompts and whitespace-only text stay rejected
 * before any Host dispatch.
 */
function validatePromptContent(prompt: readonly unknown[], imageEnabled: boolean): readonly AcpPromptPart[] {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a prompt must contain non-empty text or an image', JSONRPC_INVALID_PARAMS)
  }
  const content: AcpPromptPart[] = []
  let pendingText = ''
  const flushText = (): void => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }
  for (const block of prompt) {
    const wireBlock = block as AcpWireContentBlock | null | undefined
    if (wireBlock === null || wireBlock === undefined) {
      throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt contains an invalid content block', JSONRPC_INVALID_PARAMS)
    }
    const type = wireBlock.type
    if (type === 'text') {
      if (typeof wireBlock.text !== 'string') {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt contains an invalid text block', JSONRPC_INVALID_PARAMS)
      }
      pendingText += wireBlock.text
      continue
    }
    if (type === 'resource_link') {
      if (typeof wireBlock.name !== 'string' || typeof wireBlock.uri !== 'string') {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt contains an invalid resource link', JSONRPC_INVALID_PARAMS)
      }
      pendingText += `\n[resource_link name=${JSON.stringify(wireBlock.name)} uri=${JSON.stringify(wireBlock.uri)}]\n`
      continue
    }
    if (type === 'image') {
      if (!imageEnabled || typeof wireBlock.mimeType !== 'string' || typeof wireBlock.data !== 'string'
        || !ACP_IMAGE_MEDIA_TYPES.includes(wireBlock.mimeType as typeof ACP_IMAGE_MEDIA_TYPES[number])) {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'this connection cannot accept the requested image block', JSONRPC_INVALID_PARAMS)
      }
      flushText()
      content.push({
        type: 'image',
        mediaType: wireBlock.mimeType as typeof ACP_IMAGE_MEDIA_TYPES[number],
        data: wireBlock.data,
      })
      continue
    }
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'this Host accepts standard ACP text, resource_link and negotiated image blocks only', JSONRPC_INVALID_PARAMS)
  }
  flushText()
  if (!content.some(part => part.type === 'image' || (part.type === 'text' && part.text.trim().length > 0))) {
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a prompt must include non-whitespace text or an image', JSONRPC_INVALID_PARAMS)
  }
  return content
}

/** One stable "the official Store could not read this committed image" failure. */
function attachmentReadFailed(): LocalAcpViewError {
  return promptError(
    'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED',
    'a committed image attachment could not be read and verified',
    JSONRPC_INTERNAL_ERROR,
  )
}

/**
 * The structural official `ImageAttachmentRef` of one committed image block.
 * Only the reference SHAPE is checked here; the official Host Attachment Store
 * remains the authority that verifies the object named by this reference.
 */
function committedImageRef(block: unknown): AcpStoredImageRef | undefined {
  const attachment = (block as { readonly attachment?: unknown } | null)?.attachment
  if (attachment === null || typeof attachment !== 'object') return undefined
  const ref = attachment as Record<string, unknown>
  if (typeof ref.attachmentId !== 'string' || typeof ref.mediaType !== 'string'
    || typeof ref.bytes !== 'number' || typeof ref.width !== 'number' || typeof ref.height !== 'number') {
    return undefined
  }
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
}

/** One stable "this committed block has no PO-3A projection" failure. */
function unsupportedContent(): LocalAcpViewError {
  return promptError(
    'LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT',
    'a committed content block has no standard ACP projection in this phase',
    JSONRPC_INTERNAL_ERROR,
  )
}

/**
 * The stable failure of one unprovable transient/durable join. ACP v1 chunks
 * are append-only: once provisional bytes were delivered, a durable message
 * that cannot be proven identical must fail the request instead of being
 * re-sent (or silently dropped) as if the attempt had committed cleanly.
 */
function streamDivergence(): LocalAcpViewError {
  return promptError(
    'LOCAL_ACP_PROMPT_STREAM_DIVERGENCE',
    'the committed assistant message could not be joined to the delivered provisional stream',
    JSONRPC_INTERNAL_ERROR,
  )
}

/** Convert already-validated committed entries with no image reads involved. */
function committedTextUpdates(messageId: string, entries: readonly CommittedOutputEntry[]): readonly SessionUpdate[] {
  const updates: SessionUpdate[] = []
  for (const entry of entries) {
    if (entry.kind === 'thought') {
      updates.push({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: entry.text } })
    } else if (entry.kind === 'message') {
      updates.push({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: entry.text } })
    }
  }
  return updates
}

/** One abort signal that follows BOTH the official request lifetime and the Form's own abort. */
function combinedSignal(request: AbortSignal | undefined, form: AbortSignal): AbortSignal {
  return request === undefined ? form : AbortSignal.any([request, form])
}

/** The classified outcome of racing one reverse Form against its abort lifetimes. */
type QuestionRace =
  | { readonly kind: 'response'; readonly response: AcpElicitationResponse }
  | { readonly kind: 'aborted'; readonly reason: unknown }

/**
 * Race one outstanding reverse Form against the abort signals that own it. The
 * loser is never left unobserved: this promise resolves exactly once, the abort
 * listeners are removed at that moment, and the caller keeps an observer on the
 * request's own promise.
 */
function raceQuestionResponse(
  pending: Promise<AcpElicitationResponse>,
  request: AbortSignal | undefined,
  form?: AbortSignal,
): Promise<QuestionRace> {
  const outcome = Promise.withResolvers<QuestionRace>()
  const disposers: Array<() => void> = []
  let settled = false
  const settle = (value: QuestionRace): void => {
    if (settled) return
    settled = true
    for (const dispose of disposers) dispose()
    outcome.resolve(value)
  }
  for (const signal of [request, form]) {
    if (signal === undefined) continue
    const onAbort = (): void => { settle({ kind: 'aborted', reason: signal.reason }) }
    if (signal.aborted) {
      settle({ kind: 'aborted', reason: signal.reason })
      return outcome.promise
    }
    signal.addEventListener('abort', onAbort, { once: true })
    disposers.push(() => signal.removeEventListener('abort', onAbort))
  }
  observeSettled(pending, () => {})
  pending.then(
    response => { settle({ kind: 'response', response }) },
    () => { settle({ kind: 'aborted', reason: undefined }) },
  )
  return outcome.promise
}

/** Convert one client Form outcome into the official answer batch or a stable refusal. */
function answerOutcome(form: AcpQuestionForm, response: AcpElicitationResponse): AcpQuestionAnswer {
  const outcome = answerQuestionForm(form, response)
  if (outcome.kind === 'answered') return { answers: outcome.answers }
  if (outcome.kind === 'declined') {
    throw questionError('LOCAL_ACP_QUESTION_DECLINED', 'the client declined the question form')
  }
  if (outcome.kind === 'cancelled') {
    throw questionError('LOCAL_ACP_QUESTION_DECLINED', 'the client cancelled the question form')
  }
  throw questionError('LOCAL_ACP_QUESTION_BAD_ANSWER', 'the client response was not a legal answer to this form')
}

/** Preserve malformed model tool arguments as opaque input instead of dropping them. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** Map one Host-only scoped-MCP failure onto a stable View rejection. */
function mapScopedMcpError(error: AcpScopedMcpError, sessionId?: string): LocalAcpViewError {
  const data = sessionId === undefined || sessionId === '' ? {} : { sessionId }
  switch (error.code) {
    case 'INVALID_DECLARATION':
      return new LocalAcpViewError('LOCAL_ACP_MCP_INVALID_DECLARATION', 'the MCP server declaration is invalid', JSONRPC_INVALID_PARAMS, data)
    case 'AGENT_BUSY':
      return new LocalAcpViewError('LOCAL_ACP_MCP_AGENT_BUSY', 'the session agent is busy', -32045, data)
    case 'NAME_CONFLICT':
      return new LocalAcpViewError('LOCAL_ACP_MCP_NAME_CONFLICT', 'an MCP tool name collides with an existing tool', JSONRPC_INVALID_PARAMS, data)
    case 'START_FAILED':
      return new LocalAcpViewError('LOCAL_ACP_MCP_START_FAILED', 'the MCP server could not be started', JSONRPC_INTERNAL_ERROR, data)
    case 'CLEANUP_UNCONFIRMED':
      return new LocalAcpViewError('LOCAL_ACP_MCP_CLEANUP_UNCONFIRMED', 'the MCP server cleanup could not be confirmed', JSONRPC_INTERNAL_ERROR, data)
    case 'STALE':
      return new LocalAcpViewError('LOCAL_ACP_MCP_STALE', 'the ACP view changed during the MCP admission', JSONRPC_INVALID_PARAMS, data)
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
