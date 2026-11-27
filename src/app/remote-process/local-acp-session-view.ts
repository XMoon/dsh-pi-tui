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
  AcpSessionPolicyError,
  agentTeamConfigOptionOf,
  invalidPolicyOption,
  modeConfigOptionOf,
  modeOfWireId,
  sessionModeStateOf,
  stalePolicy,
  wireModeId,
  ACP_AGENT_TEAM_CONFIG_ID,
  ACP_MODE_CONFIG_ID,
  type AcpSessionMode,
  type AcpSessionPolicyRequest,
  type AcpSessionPolicyErrorCode,
  type AcpSessionPolicyState,
} from './local-acp-session-policy.ts'
import {
  AcpScopedMcpError,
  parseAcpMcpServers,
  type AcpScopedMcpCurrentness,
  type AcpScopedMcpLease,
} from './local-acp-scoped-mcp.ts'
import {
  AcpProjectionError,
  assertFileBudget,
  compactionUpdate,
  durableAgentMessageOf,
  fileAttachmentRef,
  imageRef,
  planEntriesFromTodos,
  planEntriesOf,
  planRemoval,
  planUpdate,
  projectSessionHistory,
  sessionInfoUpdateOf,
  usageUpdateOf,
  type AcpHistoryAgentMessage,
  type AcpHistoryEvent,
  type AcpHistoryHeader,
  type AcpHistoryImage,
  type AcpHistoryToolResult,
  type AcpHistoryUnit,
  type AcpNegotiatedCapabilities,
  type AcpSessionHistory,
  type AcpSessionReadRow,
} from './local-acp-projections.ts'
import {
  AcpHostCommandError,
  catalogUpdate,
  classifyCompactOutcome,
  classifyStandaloneOutcome,
  isAcpCompactAbort,
  isReservedCommandName,
  readLeadingCommand,
  routeLeadingCommand,
  sameCatalogRows,
  type AcpCatalogRow,
  type AcpCommandCatalogRead,
  type AcpCommandFailureCode,
  type AcpCommandOutcome,
  type AcpCommandSettlement,
  type AcpCompactObservedFacts,
  type AcpNativeSkillCatalog,
} from './local-acp-commands.ts'

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
  /**
   * Whether every official read seam a LOAD/LIST capability depends on is
   * bound on this Host (Session Controller authorization + Session Query
   * canonical history/titles). A missing seam is a truthful capability
   * absence: the listener never advertises a method it cannot honor.
   */
  supportsSessionRead(): boolean
  /**
   * The authorized ROOT Session roster of the official Session Controller.
   * Authorization is the Controller's (`remoteAccess.allows`); this seam only
   * forwards its already-filtered summaries plus the official durable title
   * fold of exactly those ids. It never resumes or activates a Session.
   */
  readSessionList(signal?: AbortSignal): Promise<readonly AcpSessionReadRow[]>
  /**
   * Read ONE complete canonical Session history from the official Session
   * Query (replay-validated, ascending seq). This is the ONLY history source:
   * no raw persistence file, no bounded surface window and no cold synthesized
   * closer is ever used.
   */
  readSessionHistory(sessionId: string, signal?: AbortSignal): Promise<AcpSessionHistory>
  /**
   * The official header facts of one exact Session (the subagent provenance
   * cross-check), or `undefined` when the Host cannot prove one.
   */
  sessionHeaderFacts(sessionId: string, signal?: AbortSignal): Promise<AcpHistoryHeader | undefined>
  /** The detached official `contextPressure` projection value of one exact Session. */
  contextPressure(session: object): unknown
  /** The detached official `todos` projection value of one exact Session. */
  sessionTodos(session: object): unknown
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
  /**
   * Read ONE committed generic file reference through the official Host
   * Attachment Store as bounded chunks. The Store owns the leaf/byte/hash
   * verification, which completes only after the final chunk: the caller must
   * iterate to natural EOF and must never stop at the declared size.
   */
  readOutputFile(ref: AcpStoredFileRef, signal: AbortSignal): AsyncIterable<Uint8Array>
  /** Whether the exact configured Host default route explicitly accepts images. */
  supportsImagePrompts(): Promise<boolean>
  /** Submit ONE prompt through the official Session Controller (queue mode only). */
  prompt(
    request: AcpSessionPromptRequest,
    signal: AbortSignal,
    finalCheck?: () => void,
  ): Promise<{ readonly accepted: true }>
  /** Whether the real Host composition can stage ACP embedded resources. */
  supportsFileInput(): boolean
  /**
   * Whether the exact Host installed the official scoped SystemPrompt section
   * seam. This is the ONLY capability prerequisite: a root service shape or a
   * client declaration never advertises the append.
   */
  supportsSystemPromptAppend(): boolean
  /**
   * Register ONE ordinary literal section in the exact live Agent's Cordis
   * scope and return the exact official disposer. The Host re-verifies the
   * captured Agent/Session synchronously before the official `section()` call;
   * `stillCurrent` is read inside the provider so a contribution can never
   * survive its committed View generation. A failure is classified; the View
   * never receives the Agent, its Context or a service object.
   */
  registerSystemPromptAppend(
    agent: LiveAgentViewIdentity,
    session: object,
    text: string,
    stillCurrent: () => boolean,
  ): { readonly dispose: () => void }
  /**
   * Stage ONE already-decoded blob as an official FileUploads receipt for the
   * captured exact Agent/Session. The Host re-verifies the exact live identity
   * synchronously before the actual upload; the caller re-verifies after.
   */
  stageFile(
    agent: LiveAgentViewIdentity,
    session: object,
    data: string,
    name: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly receiptId: string }>
  /**
   * Cleanup-only retirement for receipts obtained by this flight when the
   * prompt was definitely not dispatched (or the Controller rejected it with
   * no insertion). It never commits, never creates an inbox/message fact and
   * never deletes the immutable Store object.
   */
  cleanupStagedFiles(
    agent: LiveAgentViewIdentity,
    requestId: string,
    receiptIds: readonly string[],
  ): void
  /** Retire the staged receipts bound to one actually removed queued occurrence. */
  retirePromptReceipts(agent: LiveAgentViewIdentity, requestId: string): void
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
   * Mount one standard ACP stdio/HTTP MCP declaration list on the exact Agent. The
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
   * Read the committed session policy (collaboration mode and root Agent Team
   * selection) of one exact attached Agent/Session. A missing official service
   * is absence; an unreadable one is `UNAVAILABLE`; neither is a fabricated
   * `default`/`false`.
   */
  readSessionPolicy(agent: LiveAgentViewIdentity, session: object): AcpSessionPolicyState
  /** The exact committed legacy mode alone, independently of the Team row. */
  readSessionMode(agent: LiveAgentViewIdentity, session: object): AcpSessionMode | undefined
  /**
   * Commit ONE official session policy write through the official maintenance
   * admission. `stillCurrent` re-reads the owning View claim in the same
   * synchronous callback stack as the final official call.
   */
  selectSessionPolicy(
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpSessionPolicyRequest,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ): Promise<void>
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
  /**
   * Read the exact live effective command registry. This is a detached
   * metadata read: the returned rows are never an execution capability, and a
   * refusal must be distinguished from a real empty registry.
   */
  readCommandCatalog(agent: LiveAgentViewIdentity, session: object): AcpCommandCatalogRead
  /**
   * Read the exact native human-Skill catalog from the Agent's retained
   * composition and effective committed cwd. `absent` is a proven capability
   * absence; a failed/incomplete read rejects and is never published as empty.
   */
  readNativeSkills(agent: LiveAgentViewIdentity, session: object, signal: AbortSignal): Promise<AcpNativeSkillCatalog>
  /**
   * Execute the ONE approved standalone command through the official command
   * runtime. The method entry is synchronous: every exact-identity and
   * definition check happens before the official call, and the returned
   * Promise is the original handler settlement.
   */
  executeStandaloneCommand(
    agent: LiveAgentViewIdentity,
    session: object,
    line: string,
    signal: AbortSignal,
  ): Promise<unknown>
  /**
   * Enter the exact retained official manual-compaction engine in the same
   * synchronous stack. No command wrapper, sourceCommandId or second
   * maintenance lock is introduced.
   */
  executeManualCompact(
    agent: LiveAgentViewIdentity,
    session: object,
    signal: AbortSignal,
  ): Promise<unknown>
  /** The official DSH leading-slash parser bound by the Host composition. */
  parseCommand(line: string): { readonly name: string; readonly rawInput: string } | undefined
}

/** One transient per-connection config notification. */
export type AcpConfigUpdate =
  /** The complete current config-option list (one standard `config_option_update`). */
  | { readonly kind: 'config'; readonly configOptions: readonly SessionConfigOption[] }
  /** The committed legacy mode change (one standard `current_mode_update`). */
  | { readonly kind: 'mode'; readonly currentModeId: string }

/**
 * The ONE config notification sink of a connection. It sends exactly the two
 * standard update shapes above through the connection's own SDK client.
 */
export type AcpConfigUpdateNotifier = (sessionId: string, update: AcpConfigUpdate) => Promise<void>

/**
 * One complete config snapshot of an attached View. `modes`/`configOptions`
 * are optional DISPLAY facts: an unreadable optional model catalog omits the
 * complete config list (never a partial one), while an absent mode authority
 * omits the mode rows.
 */
export interface AcpSessionConfigSnapshot {
  /** The committed mode of the same policy cut. */
  readonly mode?: AcpSessionMode
  /** The committed root Agent Team selection of the same policy cut. */
  readonly agentTeam?: boolean
  /** The legacy `SessionModeState`, when a committed mode authority exists. */
  readonly modes?: ReturnType<typeof sessionModeStateOf>
  /** The complete fixed-order config-option list, when the model catalog is readable. */
  readonly configOptions?: readonly SessionConfigOption[]
  /**
   * Why an optional display was omitted: a genuine model-catalog absence vs a
   * failed/unstable policy cut. The listener reports the actual cause; a failed
   * policy read is never reported as a model-catalog failure.
   */
  readonly omitted?: 'model' | 'policy'
}

/** The config cut's read purpose: initial display, live refresh or write reply. */
type AcpConfigCutMode = 'attach' | 'refresh' | 'reply'

/** One fenced config cut: the snapshot plus the invalidation generation it proved. */
interface AcpConfigCut {
  readonly snapshot: AcpSessionConfigSnapshot
  readonly epoch: number
}

/**
 * The read-only projection sink of ONE connection: a standard `session/update`
 * of this exact Session. It is bound once at attach (exactly like the
 * config-options notifier) and stays usable until the View detaches.
 */
export type AcpProjectionNotifier = (sessionId: string, update: SessionUpdate) => Promise<void>

/**
 * The stable `session/list` classifications. A malformed cwd/cursor is the
 * standard invalid-params refusal; an absent read seam is a truthful
 * capability absence.
 */
export type LocalAcpListErrorCode =
  | 'LOCAL_ACP_LIST_INVALID_REQUEST'
  | 'LOCAL_ACP_LIST_UNAVAILABLE'

/**
 * The stable `session/load` and read-only projection classifications. They
 * never carry content, a path or an exception: a replay that cannot be proven
 * complete and ordered fails closed and releases only this View.
 */
export type LocalAcpLoadErrorCode =
  /** The canonical history's seq order is not strictly increasing. */
  | 'LOCAL_ACP_LOAD_INVALID_HISTORY'
  /** A committed block has no standard ACP v1 projection. */
  | 'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT'
  /** An image/file the history references could not be read and verified. */
  | 'LOCAL_ACP_LOAD_ATTACHMENT_READ_FAILED'
  /**
   * One history event's generic-file Base64 payload cannot fit this
   * connection's frozen output frame budget. This is the adapter's bounded
   * materialization refusal: it fails the load without touching the writer.
   */
  | 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE'
  /** Live events during the replay window exceeded the bounded replay buffer. */
  | 'LOCAL_ACP_LOAD_BACKPRESSURE'
  /** This View cannot replay history because the Host read seam is absent. */
  | 'LOCAL_ACP_LOAD_UNAVAILABLE'
  /** A live read-only projection could not keep up with its bounded tail. */
  | 'LOCAL_ACP_PROJECTION_BACKPRESSURE'

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
  /** One standard ACP MCP declaration was invalid before any Host create. */
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
   * The official Host Attachment Store could not read/verify an image or
   * generic file a committed assistant or tool block referenced. The event is
   * never sent partially and a fabricated attachment is never substituted.
   */
  | 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED'
  /**
   * One owned event's generic-file Base64 payload cannot fit this connection's
   * frozen output frame budget. This is the adapter's bounded materialization
   * refusal: the event is refused before any Store read, never a transport
   * write, and the connection is not closed.
   */
  | 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE'
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
  | LocalAcpLoadErrorCode
  | LocalAcpListErrorCode
  | AcpCommandFailureCode
  | AcpModelErrorCode
  | AcpSessionPolicyErrorCode

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

/**
 * The stable product identity of the ONE ordinary client-append section this
 * Host registers in the exact Agent's Cordis scope. It is deliberately a
 * normal (never `complete`) section: the official composition keeps final text
 * authority, and a complete/custom persona may legally suppress the append.
 */
export const ACP_SYSTEM_PROMPT_SECTION_NAME = 'pi-tui:acp-system-prompt-append'

/**
 * The fixed placement after the ordinary official instruction sections and
 * before the structured/harness-source tail. The numeric value is product
 * placement, not a durable external contract; the section stays ORDINARY.
 */
export const ACP_SYSTEM_PROMPT_SECTION_ORDER = 9950

/**
 * The ONE committed per-View append budget: the exact UTF-8 bytes of the
 * literal section text including the two-newline separators between blocks.
 * The ACP input frame keeps its own legacy bound; this budget only stops an
 * unbounded extra concatenation and never widens the transport frame.
 */
export const MAX_SYSTEM_PROMPT_APPEND_BYTES = 1024 * 1024

/**
 * One classified failure of the narrow Host system-prompt seam. The View maps
 * it to its stable ACP error classes; the Host never returns a prompt/error
 * text (or any client content) through it.
 */
export class AcpSystemPromptAppendError extends Error {
  readonly kind: 'unavailable' | 'registration-failed' | 'stale'

  constructor(kind: 'unavailable' | 'registration-failed' | 'stale', message: string) {
    super(message)
    this.name = 'AcpSystemPromptAppendError'
    this.kind = kind
  }
}

/**
 * The minimal `session/new` request facts this module validates. A non-null
 * `systemPrompt` is only legal when this connection was actually advertised
 * `sessionCapabilities.systemPrompt`; a valid `append` value becomes ONE
 * ordinary official scoped section in the exact Agent's Cordis scope.
 */
export interface AcpNewSessionParams {
  readonly cwd: string
  readonly additionalDirectories?: readonly string[]
  readonly systemPrompt?: unknown
  readonly mcpServers: readonly unknown[]
}

/** The minimal `session/resume` request facts this module validates. */
export interface AcpResumeSessionParams {
  readonly sessionId: string
  readonly cwd: string
  readonly additionalDirectories?: readonly string[]
  readonly systemPrompt?: unknown
  readonly mcpServers?: readonly unknown[]
}

/** The `session/set_config_option` request facts the View forwards to the Host model service. */
export interface AcpSetConfigOptionParams extends AcpModelOptionRequest {
  readonly sessionId: string
}

/**
 * The `session/load` request facts. `mcpServers` is mandatory in the ACP v1
 * schema; `cwd` is a claim proposal (the official Session keeps its own cwd)
 * and `additionalDirectories` is not supported by this Host. `systemPrompt`
 * follows the same frozen per-connection append admission as the other entries.
 */
export interface AcpLoadSessionParams {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: readonly unknown[]
  readonly additionalDirectories?: readonly string[]
  readonly systemPrompt?: unknown
}
/** Raster MIME vocabulary shared by the ACP wire and official Host admission. */
export const ACP_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** The official Host content accepted by this ACP input adapter. */
export type AcpPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: typeof ACP_IMAGE_MEDIA_TYPES[number]; readonly data: string }
  | { readonly type: 'file'; readonly receiptId: string }

/**
 * One decoded client resource that has NOT reached the Host yet. The blob is
 * a transient upload proposal; it is never part of a Controller request.
 */
export type AcpDecodedPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: typeof ACP_IMAGE_MEDIA_TYPES[number]; readonly data: string }
  | {
    readonly type: 'blob'
    readonly uri: string
    readonly mimeType?: string
    readonly data: string
    readonly name?: string
  }

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
 * The structural official `FileAttachmentRef` a committed file block carries.
 * The View never interprets these fields beyond the opaque content identity:
 * they identify the object the official Host Attachment Store must verify and
 * read back.
 */
export interface AcpStoredFileRef {
  /** The official content-addressed id (`sha256:<64 lowercase hex>`). */
  readonly attachmentId: string
  /** The official sanitized stored leaf name (never a client path). */
  readonly name: string
  /** The declared exact byte length the Store verifies. */
  readonly bytes: number
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
  /** The official effective command registry was invalidated (unfiltered). */
  onCommandCatalogInvalidated(): void
  /** The official Skill registry/loader composition was invalidated. */
  onSkillCatalogInvalidated(): void
  /**
   * The retained Agent composition may have changed (e.g. `tools/change`): any
   * mode/Team availability projected from it must be re-read, never inferred.
   */
  onPolicyAvailabilityInvalidated(): void
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
  /**
   * The official `subagent/start` lifecycle edge of one child run. The View
   * cross-checks the child Session header before announcing the association on
   * its immediate parent Session; an unprovable association announces nothing.
   */
  onSubagentStart(info: AcpSubagentRunInfo): void
  /** The official `subagent/end` lifecycle edge paired by `runId`. */
  onSubagentEnd(info: AcpSubagentRunInfo): void
}

/** The official `subagent/start|end` run identity facts (structural). */
export interface AcpSubagentRunInfo {
  /** Identity shared by one residency epoch's start/end pair. */
  readonly runId: string
  /** The child Agent/Session identity. */
  readonly id: string
  /** The durable direct creator Session id. */
  readonly parentSessionId: string
  /** Whether this activation owns a local Agent. */
  readonly local: boolean
  /** The child's terminal stop reason (`subagent/end` only). */
  readonly stopReason?: string
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
  /** The config notification sink of this connection. */
  readonly notifyConfigUpdate?: AcpConfigUpdateNotifier
  /** The reverse elicitation channel of this connection (absent = no Form). */
  readonly requestElicitation?: AcpElicitationRequester
  /**
   * The read-only projection sink of this connection (plan/info/usage/
   * compaction/subagent/session-message updates). Absent means the View sends
   * no read-only projection at all.
   */
  readonly notifyProjection?: AcpProjectionNotifier
  /** The capabilities this connection froze at `initialize` (never re-read). */
  readonly capabilities?: AcpNegotiatedCapabilities
  /**
   * This connection's frozen single-frame output budget, in bytes. It is the
   * ONLY source of the generic-file event materialization budget; absent keeps
   * the text/image behavior unchanged and refuses a file-bearing event.
   */
  readonly maxOutputFrameBytes?: number
  /**
   * Whether `initialize` actually advertised `sessionCapabilities.systemPrompt`
   * on this connection. It is frozen there and never re-read: a non-null
   * `systemPrompt` is invalid params on a connection without it.
   */
  readonly systemPromptAppend?: boolean
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
  /** The official durable event time in epoch milliseconds (its own fact). */
  readonly time?: number
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

/**
 * The ONE official scoped append contribution a claim owns. The responsibility
 * exists from BEFORE the synchronous `section()` call until the exact
 * disposer returned (or the exact owning scope's destruction) proves the
 * contribution retired. `active` is committed false FIRST whenever the View
 * detaches or is replaced, so the provider can never contribute from a retired
 * generation; `committed` only becomes true at `commitAttached`.
 */
interface AcpSystemPromptAppendRegistration {
  /** The provider gate: cleared synchronously before the exact disposer runs. */
  active: boolean
  /** True only after this exact View generation committed. */
  committed: boolean
  /** The exact official disposer; replaced after `section()` returns. */
  dispose: () => void
}

/** One reservation held by exactly one connection. Its object identity IS the reservation identity. */
interface ViewClaim {
  readonly connectionIdentity: ConnectionViewState
  readonly sessionId: string
  /**
   * The ONE cancellation owner of this claim's read-only IO: a cold header read
   * or an attachment Store read. It covers BOTH the replay window and ordinary
   * live projection; Close/EOF/Off/dispose abort it, and a replay overflow
   * aborts it too because that replay can never answer.
   */
  readonly readAbort: AbortController
  /** The exact live Agent object verified at `commitAttached`; `undefined` until attached. */
  exactAgent?: LiveAgentViewIdentity
  /** The exact live Session object verified at `commitAttached`; `undefined` until attached. */
  exactSession?: object
  /**
   * The ONE official scoped append contribution this claim owns. It exists only
   * while this exact claim generation's registration responsibility is
   * unsettled; a detach/replacement first fails it closed and then invokes the
   * exact disposer. Never a second registry, cache or persisted record.
   */
  systemPromptAppend?: AcpSystemPromptAppendRegistration
  /** At most ONE unsettled ACP prompt flight, correlated by real Host facts only. */
  inflight?: InflightPrompt
  /**
   * At most ONE standalone/compact command operation. It is a sibling of the
   * prompt flight, never a second prompt and never a durable command store.
   */
  commandOperation?: AcpOwnedCommand
  /**
   * The per-claim catalog invalidation epoch. A read captures this value and
   * must still match it before its result is delivered; an invalidation never
   * cancels command execution or the read-only Session projection.
   */
  catalogEpoch?: number
  /** One catalog read owner is running for this claim. */
  catalogReadRunning?: boolean
  /** A coalesced follow-up read is required after the running one settles. */
  catalogDirty?: boolean
  /** The rows this connection ACTUALLY received (display intent only). */
  lastDeliveredCatalog?: readonly AcpCatalogRow[]
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
   * The ONE transient config notification sink of this claim's connection. It
   * carries no policy fact and dies with the claim; an absent callback (or a
   * closed/replaced claim) means no config update is sent.
   */
  notifyConfigUpdate?: AcpConfigUpdateNotifier
  /** The ordered per-claim config-notification chain; later updates never overtake earlier ones. */
  configNotifyTail?: Promise<void>
  /** One config refresh loop is running for this claim. */
  configRefreshRunning?: boolean
  /**
   * The initial complete config snapshot of this View has been read. Until
   * then every invalidation only marks `configDirty`, so no pre-baseline frame
   * can precede the attach response.
   */
  configReady?: boolean
  /**
   * The per-claim config invalidation generation. A read captures this value
   * and discards its result when a newer invalidation won.
   */
  configEpoch?: number
  /** A coalesced config refresh is required after the running one settles. */
  configDirty?: boolean
  /**
   * Number of successfully validated complete reply cuts currently at their
   * final synchronous submission boundary. Only an unsent config frame is
   * deferred here; already-submitted frames and provider/maintenance work never
   * wait on a reply.
   */
  configReplyBarrier?: number
  /**
   * Whether THIS connection was actually given the legacy `modes` list at
   * attach. Only such a View may receive `current_mode_update` or call the
   * legacy `session/set_mode`; this is a delivered-display fact, never the
   * mode authority.
   */
  legacyModeAnnounced?: boolean
  /** The last legacy mode id this connection was actually delivered. */
  lastLegacyMode?: AcpSessionMode
  /**
   * The ONE session policy write slot of this claim (mode or Agent Team). It is
   * installed synchronously before the official call and cleared only by that
   * call's real terminal settlement; it never replaces/cancels a Host write.
   */
  policyWrite?: Promise<void>
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
  /**
   * The ONE read-only projection sink of this claim's connection. It carries
   * no durable state and dies with the claim; an absent sink (or a closed/
   * replaced claim) means no plan/info/usage/compaction/subagent/session-message
   * update is sent.
   */
  notifyProjection?: AcpProjectionNotifier
  /** The capabilities frozen for this claim's connection at `initialize`. */
  capabilities?: AcpNegotiatedCapabilities
  /** The connection's frozen single-frame output budget bound at attach. */
  maxOutputFrameBytes?: number
  /** The ordered read-only projection chain of this claim (never rejects). */
  projectionTail?: Promise<void>
  /** Read-only projection tasks queued but not yet settled. */
  projectionPending?: number
  /** A bounded projection overflow stopped further read-only updates for this claim. */
  projectionStalled?: boolean
  /**
   * The load replay barrier of a `session/load`ed View: present from the
   * attach critical point until its buffered live events were drained into the
   * ordered tail. It is the ONLY state that makes history replay possible.
   */
  replay?: ViewReplay
  /**
   * The last session-info fields this View proved, so a later durable title
   * event only patches what actually changed (never a fabricated activity).
   */
  lastInfo?: { readonly title?: string }
  /**
   * The verified child associations of THIS View, keyed by the official
   * `subagent/start` runId. The runId is the lifecycle join key: its `end` edge
   * announces the SAME verified child instead of re-reading a lineage after
   * the child's Agent was already disposed. It lives only with this claim.
   */
  subagentRuns?: Map<string, { readonly childId: string; readonly cwd?: string }>
  /**
   * The exact compacted lifecycles this View already projected, keyed by the
   * durable `compactionId`: at most one start, one summary and one end per id,
   * in order. A duplicated or out-of-order callback never re-projects it.
   */
  compactions?: Map<string, 'started' | 'summarized' | 'ended'>
  /** Child Session ids whose association this View already announced. */
  announcedChildren?: Set<string>
  /**
   * Whether this View already announced a standing plan. The official `todos`
   * projection resets to null at the next `turn/start`; only an ALREADY
   * announced plan needs removal then (null never means "unavailable").
   */
  announcedPlan?: boolean
  /** This Session's own official header, read once for inter-agent lineage. */
  selfHeader?: AcpHistoryHeader
}

/** One official subagent lifecycle edge observed by the Host fact source. */
interface AcpSubagentEdge {
  readonly edge: 'start' | 'end'
  readonly info: AcpSubagentRunInfo
}

/** The bounded load replay fence of one View. */
interface ViewReplay {
  /**
   * Live durable events observed while the canonical snapshot was being read.
   * Bounded: an overflow aborts the replay instead of growing without limit.
   */
  readonly buffered: AcpHistoryEvent[]
  /**
   * Official subagent lifecycle edges observed inside the same barrier. They
   * are NOT Session events (they carry no seq), so they are released in arrival
   * order after the canonical history and before the buffered turn.
   */
  readonly subagents: AcpSubagentEdge[]
  /** Aborts the history read and its ordered Store reads on close/EOF/Off. */
  readonly abort: AbortController
  /** Set when the bounded buffer could not hold the live window. */
  overflowed: boolean
  /** Set by close/EOF/Off before the replay owned its output. */
  stopped: boolean
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
 * The maximum number of read-only projection TASKS one claim may queue. A task
 * is one durable event's complete projection; exceeding the bound stops the
 * claim's read-only stream (a fixed diagnostic) instead of growing a second
 * unbounded queue.
 */
const MAX_PENDING_PROJECTION_TASKS = 64

/**
 * The maximum number of live durable events the load replay barrier keeps
 * while the canonical snapshot is read. An overflow aborts that replay with
 * `LOCAL_ACP_LOAD_BACKPRESSURE` and releases only its own View.
 */
const MAX_REPLAY_BUFFERED_EVENTS = 1024

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
  | { readonly kind: 'message-file'; readonly ref: AcpStoredFileRef }
  | { readonly kind: 'tool'; readonly text: string }
  | { readonly kind: 'tool-image'; readonly ref: AcpStoredImageRef }
  | { readonly kind: 'tool-file'; readonly ref: AcpStoredFileRef }

/**
 * One transient command operation. The Host execution Promise is the only
 * execution terminal; the compaction start/summary/end facts are observations
 * of the SAME operation's exact Session events, not a second completion owner.
 */
interface AcpOwnedFrame {
  readonly eventType: 'compaction/start' | 'compaction/summary' | 'compaction/end'
  readonly receipt: { delivered: boolean }
  readonly task: Promise<void>
}

interface AcpOwnedCommand {
  readonly kind: 'standalone' | 'compact'
  /** The ONE stable opaque ACP message id of this command's result text. */
  readonly messageId: string
  /**
   * The compact-only cancellation controller. It never aborts a standalone
   * command after dispatch (the approved feedback handler is noninterruptible)
   * and is always replaced/captured per operation.
   */
  readonly controller: AbortController
  /** This operation's unique ACP abort reason. */
  readonly cancelReason: Error
  /** True only while the official call is on the stack (sync prefix included). */
  dispatching: boolean
  invoked: boolean
  cancelRequested: boolean
  abortScheduled: boolean
  deliveryClosed: boolean
  hostSettled: boolean
  /** Resolves when delivery is closed and no further output should be awaited. */
  readonly deliveryAbort: PromiseWithResolvers<void>
  /** Resolves after this exact op released its claim slot. */
  readonly completion: PromiseWithResolvers<void>
  /** Own negotiated compaction frames, captured at enqueue time. */
  ownFrames: AcpOwnedFrame[]
  compactionId?: string
  startSeq?: number
  summarySeq?: number
  endSeq?: number
  endError?: string
  checkpointSeen: boolean
  factConflict: boolean
  requestAbortDisposer?: () => void
}

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
  /** The ONE file-bearing admission responsibility, from first upload until
   * the original Controller Promise and D4 cleanup have settled. */
  fileAdmissionPending?: boolean
  /** The first real business terminal observed while file admission is still
   * pending; the single owner applies it after the original call settles. */
  pendingBusinessOutcome?:
    | { readonly kind: 'failure'; readonly error: LocalAcpViewError }
    | { readonly kind: 'complete'; readonly result: AcpPromptResult }
  /** The independent D4/D5 resource terminal of this file flight. */
  resourceFailure?: LocalAcpViewError
  /** Receipts returned by THIS flight and not yet handed to the Controller. */
  stagedReceipts?: string[]
  /** A disposal observed while file preparation was still in flight. */
  pendingDisposalFailure?: LocalAcpViewError
  /** Cleanup was attempted and could not be confirmed; never retry or report clean. */
  fileCleanupUnconfirmed?: boolean
  /** Resolves exactly when the admission call's classification completed. */
  readonly admissionSettledPromise: Promise<void>
  /** The resolver behind `admissionSettledPromise`; flight-private. */
  readonly settleAdmission: () => void
  /** PO-3B: output delivery is closed; queued-but-unsent updates are dropped. */
  deliveryClosed: boolean
  /**
   * The ONE cancellable native-Skill preflight read of this flight. It is set
   * synchronously before the first await and cleared after the read settles;
   * Close/EOF/Off/dispose/cancel abort exactly this read, never a Host write.
   */
  skillPreflightAbort?: AbortController
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
   * A definite advertised-Skill pre-dispatch refusal: the official prompt was
   * never invoked, so a concurrent Close has no Host write to settle.
   */
  definiteNoDispatch?: boolean
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
 * The standard ACP v1 resource-not-found code. A Session-scoped request for a
 * Session this View does not hold, and a DEFINITE official
 * `session/not-found`, both answer `-32002` with the requested `sessionId`;
 * they are never a malformed-parameters refusal and never a conflict.
 */
const JSONRPC_RESOURCE_NOT_FOUND = -32002

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

/** One official policy rejection on the View's existing error boundary. */
function policyViewError(error: AcpSessionPolicyError): LocalAcpViewError {
  return new LocalAcpViewError(error.code, error.message, error.rpcCode)
}

/** The stable post-write readback failure: the write may be committed. */
function readbackUnavailablePolicyView(): LocalAcpViewError {
  return new LocalAcpViewError(
    'LOCAL_ACP_CONFIG_READBACK_UNAVAILABLE',
    'the session config state could not be read back completely',
    -32000,
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
      if (claim.commandOperation !== undefined) return true
      if (claim.policyWrite !== undefined) return true
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
        JSONRPC_RESOURCE_NOT_FOUND,
        { sessionId },
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
   * The ONE `session/set_config_option` entry of an attached View.
   *
   * The standard request shape decides exactly one authority: `mode` and the
   * negotiated `agent_team` boolean go to the official session policy, while
   * `model`/`thought_level` keep the existing Session-only official model path.
   * Every other id/type/value is refused before any Host call. The reply is the
   * complete current config list (mode/Team rows included), never a partial
   * model subset.
   */
  async setConfigOption(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpSetConfigOptionParams,
    signal: AbortSignal,
  ): Promise<SessionConfigOption[]> {
    if (request.configId === ACP_MODE_CONFIG_ID) {
      const mode = request.type === undefined ? modeOfWireId(request.value) : undefined
      if (mode === undefined) throw policyViewError(invalidPolicyOption('the requested session mode is not selectable'))
      const claim = this.attachedClaim(state, request.sessionId)
      await this.performPolicyWrite(claim, access, { kind: 'mode', mode }, signal)
      return await this.readConfigReply(claim, access)
    }
    if (request.configId === ACP_AGENT_TEAM_CONFIG_ID) {
      const claim = this.attachedClaim(state, request.sessionId)
      if (claim.capabilities?.booleanConfigOptions !== true) {
        throw policyViewError(invalidPolicyOption('this connection did not negotiate boolean session config options'))
      }
      if (request.type !== 'boolean' || typeof request.value !== 'boolean') {
        throw policyViewError(invalidPolicyOption('the requested Agent Team option requires a boolean value'))
      }
      const enabled = request.value
      await this.performPolicyWrite(claim, access, { kind: 'agent-team', enabled }, signal)
      return await this.readConfigReply(claim, access)
    }
    if (request.configId === 'model' || request.configId === 'thought_level') {
      const claim = this.attachedClaim(state, request.sessionId)
      await this.setModelOnly(state, access, request, signal)
      // A same-value write emits no Session event and changes no projection, so
      // it neither needs nor may race a config notification ahead of its reply.
      // A real model/selection event owns the post-write refresh. The reply is
      // ONE fenced full cut after the model terminal.
      return await this.readConfigReply(claim, access)
    }
    throw policyViewError(invalidPolicyOption('unknown session config option'))
  }

  /**
   * The legacy `session/set_mode` entry. It is admitted ONLY for a View that
   * actually received the legacy `modes` list at attach; a View that never did
   * must re-attach before using this method (the `mode` config row remains
   * available on the same authority). The standard response is an empty object.
   */
  async setMode(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    sessionId: string,
    modeId: string,
    signal: AbortSignal,
  ): Promise<Record<string, never>> {
    const claim = this.attachedClaim(state, sessionId)
    if (claim.legacyModeAnnounced !== true) {
      throw policyViewError(invalidPolicyOption('this session view was not offered the legacy mode list'))
    }
    const mode = modeOfWireId(modeId)
    if (mode === undefined) throw policyViewError(invalidPolicyOption('the requested session mode is not selectable'))
    await this.performPolicyWrite(claim, access, { kind: 'mode', mode }, signal)
    return {}
  }

  /**
   * Read the initial complete config state of one JUST-attached View. The
   * legacy `modes` list and the `mode` config row come from the SAME policy cut
   * (read after the model-catalog await); an optional model-catalog failure
   * omits `configOptions` but keeps the legacy mode list. The delivered legacy
   * list fact is recorded only AFTER this exact claim proved current.
   */
  async sessionConfigState(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    sessionId: string,
  ): Promise<AcpSessionConfigSnapshot> {
    const claim = this.attachedClaim(state, sessionId)
    const cut = await this.readConfigSnapshotFenced(claim, access, 'attach')
    const snapshot = cut.snapshot
    claim.legacyModeAnnounced = snapshot.modes !== undefined
    claim.lastLegacyMode = snapshot.mode
    // `configReady` is the response-submission boundary, not snapshot
    // acquisition. Keep it false until the one scheduled task runs, so no
    // invalidation arriving in between can start a notification ahead of the
    // attach response. The task always runs, even for a currently clean cut.
    claim.configReady = false
    if (snapshot.configOptions === undefined) claim.configDirty = true
    setImmediate(() => {
      if (this.claims.get(claim.sessionId) !== claim) return
      if (claim.connectionIdentity.phase !== 'attached' || claim.detachedWithFence) return
      claim.configReady = true
      if (claim.configDirty === true) this.enqueueConfigUpdate(claim)
    })
    return snapshot
  }

  private async performPolicyWrite(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    request: AcpSessionPolicyRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertPolicyAdmission(claim)
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    const epoch = claim.configEpoch ?? 0
    const completion = Promise.withResolvers<void>()
    claim.policyWrite = completion.promise
    const stillCurrent = (): 'current' | 'stale' => {
      if (claim.connectionIdentity.phase !== 'attached' || claim.detachedWithFence) return 'stale'
      if (this.claims.get(claim.sessionId) !== claim) return 'stale'
      if (claim.exactAgent !== agent || claim.exactSession !== session) return 'stale'
      if (claim.inflight !== undefined || claim.commandOperation !== undefined
        || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
        || claim.closing !== undefined || claim.replay !== undefined
        || claim.mcpMountPending === true || claim.mcpRetireRequested === true) return 'stale'
      return 'current'
    }
    try {
      await this.callPolicyAccess(() => access.selectSessionPolicy(agent, session, request, signal, stillCurrent))
    } finally {
      // The official call's own settlement (or its definite pre-call refusal)
      // is the ONLY terminal; the slot never outlives it.
      if (claim.policyWrite === completion.promise) claim.policyWrite = undefined
      completion.resolve()
      this.notifyWorkSettled()
      // Even a failed/indeterminate write may have committed. The write's own
      // `plan/mode`/`team/mode` event already invalidated the config when it
      // did; only an event-less terminal asks for the extra refresh here.
      if ((claim.configEpoch ?? 0) === epoch) this.enqueueConfigUpdate(claim)
    }
  }

  /** Refuse one policy write while this View owns ANY other Host obligation. */
  private assertPolicyAdmission(claim: ViewClaim): void {
    if (claim.inflight !== undefined || claim.commandOperation !== undefined
      || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
      || claim.closing !== undefined || claim.replay !== undefined
      || claim.mcpMountPending === true || claim.mcpRetireRequested === true
      || claim.policyWrite !== undefined) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_CONFIG_VIEW_BUSY',
        'this session view already owns unsettled work',
        -32046,
      )
    }
  }

  /** The strict complete post-write reply; a partial list is never returned. */
  private async readConfigReply(claim: ViewClaim, access: HostAcpSessionAccess): Promise<SessionConfigOption[]> {
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    // ONE bounded retry total: readConfigSnapshotFenced already retries once
    // on an epoch change. This is only the final identity/epoch boundary.
    const cut = await this.readConfigSnapshotFenced(claim, access, 'reply')
    if (!this.isStillAttached(claim.connectionIdentity, claim, agent, session)) {
      throw readbackUnavailablePolicyView()
    }
    if (cut.epoch !== (claim.configEpoch ?? 0) || cut.snapshot.configOptions === undefined) {
      throw readbackUnavailablePolicyView()
    }
    // Only a successfully validated complete reply cut reaches this narrow
    // submission barrier. It never spans provider/maintenance I/O: an unsent
    // config frame that hits it retains dirty and reschedules on the same task
    // boundary after the resolved response is enqueued.
    claim.configReplyBarrier = (claim.configReplyBarrier ?? 0) + 1
    setImmediate(() => {
      const remaining = (claim.configReplyBarrier ?? 1) - 1
      claim.configReplyBarrier = remaining
      if (remaining <= 0 && claim.configDirty === true) this.enqueueConfigUpdate(claim)
    })
    return [...cut.snapshot.configOptions]
  }

  /**
   * One config cut under the claim's invalidation generation, retried at most
   * once. `attach` may omit an optional display caused by a genuine model or
   * policy unavailability; `refresh` and `reply` never return a partial list.
   * The final attach fallback re-checks the exact View identity and never
   * performs an unfenced read.
   */
  private async readConfigSnapshotFenced(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    mode: AcpConfigCutMode,
  ): Promise<AcpConfigCut> {
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = claim.configEpoch ?? 0
      const snapshot = await this.readConfigSnapshot(claim, access, mode)
      if (!this.isStillAttached(claim.connectionIdentity, claim, agent, session)) {
        if (mode === 'reply') throw readbackUnavailablePolicyView()
        throw new LocalAcpViewError(
          'LOCAL_ACP_CONFIG_STALE',
          'the attached session changed during the config read',
          -32042,
        )
      }
      if ((claim.configEpoch ?? 0) === epoch) return { snapshot, epoch }
    }
    if (mode === 'attach') {
      if (!this.isStillAttached(claim.connectionIdentity, claim, agent, session)) {
        throw new LocalAcpViewError(
          'LOCAL_ACP_CONFIG_STALE',
          'the attached session changed during the config read',
          -32042,
        )
      }
      // No read here: a still-moving cut cannot prove even the policy display.
      return { snapshot: { omitted: 'policy' }, epoch: claim.configEpoch ?? 0 }
    }
    throw readbackUnavailablePolicyView()
  }

  /**
   * One config cut: read the model options first (provider I/O outside any
   * maintenance), then ONE policy snapshot after that await. A failed policy
   * read is not an absence; only the official UNAVAILABLE classification may
   * omit the optional attach display, and a live refresh keeps the previously
   * delivered list instead of sending a partial replacement.
   */
  private async readConfigSnapshot(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    mode: AcpConfigCutMode,
  ): Promise<AcpSessionConfigSnapshot> {
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    let modelOptions: SessionConfigOption[] | undefined
    try {
      modelOptions = await this.callModelAccess(() => access.modelOptions(agent, session))
    } catch (error) {
      if (mode === 'reply') {
        throw readbackUnavailablePolicyView()
      }
      if (mode === 'refresh') {
        // The model list may be temporarily unavailable; the legacy mode fact
        // is independent and must still be deliverable. The full list is not.
        modelOptions = undefined
      } else if (error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_MODEL_UNAVAILABLE') {
        modelOptions = undefined
      } else {
        throw error
      }
    }
    if (!this.isStillAttached(claim.connectionIdentity, claim, agent, session)) {
      if (mode === 'reply') throw readbackUnavailablePolicyView()
      throw new LocalAcpViewError(
        'LOCAL_ACP_CONFIG_STALE',
        'the attached session changed during the config read',
        -32042,
      )
    }
    let policy: AcpSessionPolicyState
    try {
      policy = access.readSessionPolicy(agent, session)
    } catch (error) {
      if (mode === 'attach') {
        if (error instanceof AcpSessionPolicyError && error.code === 'LOCAL_ACP_CONFIG_UNAVAILABLE') {
          this.diag.warn('local-acp.config.policy-unavailable', { code: error.code })
          // The aggregate read may have failed on the Team row while the
          // legacy mode is independently readable. Announce that real mode;
          // never manufacture the missing full list.
          try {
            const narrowMode = access.readSessionMode(agent, session)
            if (narrowMode !== undefined) {
              return {
                mode: narrowMode,
                modes: sessionModeStateOf({ mode: narrowMode }),
                omitted: 'policy',
              }
            }
          } catch (narrowError) {
            if (narrowError instanceof AcpSessionPolicyError
              && narrowError.code === 'LOCAL_ACP_CONFIG_UNAVAILABLE') {
              return { omitted: 'policy' }
            }
            if (narrowError instanceof AcpSessionPolicyError) throw policyViewError(narrowError)
            throw narrowError
          }
          return { omitted: 'policy' }
        }
        if (error instanceof AcpSessionPolicyError) throw policyViewError(error)
        throw error
      }
      throw readbackUnavailablePolicyView()
    }
    const booleanSupported = claim.capabilities?.booleanConfigOptions === true
    const modeRow = modeConfigOptionOf(policy)
    const teamRow = agentTeamConfigOptionOf(policy, booleanSupported)
    const modes = sessionModeStateOf(policy)
    if (modelOptions === undefined) {
      return {
        ...(policy.mode === undefined ? {} : { mode: policy.mode }),
        ...(policy.agentTeam === undefined ? {} : { agentTeam: policy.agentTeam }),
        modes,
        omitted: 'model',
      }
    }
    return {
      ...(policy.mode === undefined ? {} : { mode: policy.mode }),
      ...(policy.agentTeam === undefined ? {} : { agentTeam: policy.agentTeam }),
      modes,
      configOptions: [...modelOptions, ...modeRow === undefined ? [] : [modeRow], ...teamRow === undefined ? [] : [teamRow]],
    }
  }

  /** Map one official policy rejection onto the existing View error boundary. */
  private async callPolicyAccess<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof AcpSessionPolicyError) {
        throw new LocalAcpViewError(error.code, error.message, error.rpcCode)
      }
      throw error
    }
  }

  /**
   * Commit ONE Session-only model/effort selection on the EXACT attached View.
   * A View with any unsettled prompt obligation is refused before the Host
   * service is reached; the Host service re-checks the exact Agent/Session
   * identity and the View claim after every asynchronous validation step.
   */
  private async setModelOnly(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpSetConfigOptionParams,
    signal: AbortSignal,
  ): Promise<SessionConfigOption[]> {
    const claim = this.attachedClaim(state, request.sessionId)
    if (claim.inflight !== undefined || claim.commandOperation !== undefined
      || claim.unclaimedHostObligation !== undefined
      || claim.closing !== undefined || claim.policyWrite !== undefined
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
      if (claim.inflight !== undefined || claim.commandOperation !== undefined
        || claim.unclaimedHostObligation !== undefined || claim.closing !== undefined
        || claim.policyWrite !== undefined
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
    // A completed model terminal is not retroactively refused because an
    // unrelated policy slot appeared after it. Only a lost View identity makes
    // the committed readback undeliverable.
    if (!this.isStillAttached(state, claim, agent, session)) throw staleModelSelection()
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
    let systemPromptAppend: string | undefined
    try {
      systemPromptAppend = this.validateNew(request, channels?.systemPromptAppend === true)
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
    const claim: ViewClaim = { connectionIdentity: state, sessionId, readAbort: new AbortController() }
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
    try {
      this.installSystemPromptAppend(state, op, claim, access, agent, systemPromptAppend)
    } catch (error) {
      // A failed append registration is a failed attach: the official MCP lease
      // (if any) keeps its own retirement fence, and the real created Session id
      // stays in the error data. Nothing is retried or rolled back.
      this.releaseClaimWithMcp(state, claim, access)
      this.resetIdleIfCurrent(state, op)
      throw error
    }
    this.commitAttached(state, op, claim, access, agent, channels)
    this.scheduleCatalogRefresh(claim, access)
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
    reattach = false,
  ): Promise<Record<string, never>> {
    const sessionId = request.sessionId
    let op: number
    let claim: ViewClaim
    let previous: ViewClaim | undefined
    let systemPromptAppend: string | undefined
    if (reattach) {
      // Validate-first: an illegal request or an ineligible held claim leaves the
      // outgoing claim generation entirely untouched (no sink stopped, no abort).
      try {
        systemPromptAppend = this.validateResume(request, channels?.systemPromptAppend === true)
      } catch (error) {
        throw error instanceof AcpScopedMcpError ? mapScopedMcpError(error) : error
      }
      // A reattach only refreshes the View it already owns. Declaring MCP
      // servers (even the same ones) would require a lease restart, which is the
      // explicit close -> ordinary attach path, never a silent reuse/replacement.
      if ((request.mcpServers?.length ?? 0) > 0) throw this.reattachMcpRefused()
      // A request that was already cancelled owns no right to replace the held
      // View: refuse BEFORE the outgoing generation changes in any way.
      requestSignal?.throwIfAborted()
      previous = this.reattachClaim(state, access, sessionId)
      claim = this.replaceClaim(state, previous)
      this.watchRefreshAbort(state, claim, requestSignal)
      op = state.op
    } else {
      op = this.beginAttach(state)
      try {
        systemPromptAppend = this.validateResume(request, channels?.systemPromptAppend === true)
      } catch (error) {
        this.resetIdleIfCurrent(state, op)
        throw error instanceof AcpScopedMcpError ? mapScopedMcpError(error) : error
      }
      if (this.claims.has(sessionId)) {
        this.resetIdleIfCurrent(state, op)
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_ALREADY_ATTACHED', 'the session is already attached to an ACP view', JSONRPC_INVALID_PARAMS)
      }
      claim = { connectionIdentity: state, sessionId, readAbort: new AbortController() }
      this.claims.set(sessionId, claim)
    }
    if (previous !== undefined) this.admitRefreshDispatch(state, op, claim, previous, access, requestSignal)
    const agent = await this.resolveForView(access, state, op, claim)
    if (previous !== undefined) this.requireSameGeneration(state, op, claim, previous, agent)
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
    try {
      this.installSystemPromptAppend(state, op, claim, access, agent, systemPromptAppend)
    } catch (error) {
      // A failed append registration never commits a fresh generation and never
      // resurrects the replaced one; an exact MCP lease keeps its own fence.
      this.releaseClaimWithMcp(state, claim, access)
      this.resetIdleIfCurrent(state, op)
      throw error
    }
    this.commitAttached(state, op, claim, access, agent, channels)
    // A resumed View re-reads the OFFICIAL continued projection: every call
    // that is still answerable is offered once on THIS connection, in official
    // ask order. A brand-new Session (`newSession`) has no such history.
    if (claim.requestElicitation !== undefined && access.hasQuestionService()) {
      this.offerContinuedQuestions(claim, claim.requestElicitation)
    }
    // `resume` replays NO history, so the current official plan is read once
    // from the projection of the EXACT attached Session: `null` (no write yet)
    // sends nothing and an empty list is a real clear.
    this.offerCurrentPlan(claim, access)
    this.scheduleCatalogRefresh(claim, access)
    return {}
  }

  /**
   * Attach an EXISTING Session AND replay its complete canonical history.
   *
   * This reuses the SAME official attach path as `resume` (one cold resume at
   * most, the same one-View-per-Session rule, the same MCP lease policy) and
   * adds ONE thing: a bounded replay barrier opens at the attach critical point,
   * the complete canonical log is read from the official Session Query, every
   * projectable durable fact is handed to this claim's ordered tail, the live
   * events that arrived meanwhile are joined by their official `seq` (each seq
   * exactly once), and only after that ordered drain does the request answer.
   *
   * It never creates a second Agent/Writer/Session and never fabricates
   * history: an unrepresentable block, a non-monotonic canonical order, an
   * unreadable committed image or an over-budget live window fails the load
   * closed and releases ONLY this View.
   */
  async loadSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpLoadSessionParams,
    channels?: AcpViewChannels,
    requestSignal?: AbortSignal,
    reattach = false,
  ): Promise<Record<string, never>> {
    const sessionId = request.sessionId
    let op: number
    let claim: ViewClaim
    let previous: ViewClaim | undefined
    let systemPromptAppend: string | undefined
    const validate = (): string | undefined => {
      try {
        const append = this.validateLoad(request, channels?.systemPromptAppend === true)
        if (!access.supportsSessionRead()) {
          throw new LocalAcpViewError(
            'LOCAL_ACP_LOAD_UNAVAILABLE',
            'this Host cannot read canonical Session history',
            JSONRPC_INVALID_PARAMS,
          )
        }
        return append
      } catch (error) {
        throw error instanceof AcpScopedMcpError ? mapScopedMcpError(error) : error
      }
    }
    if (reattach) {
      // Validate-first: a refusal here never touches the outgoing generation.
      systemPromptAppend = validate()
      if (request.mcpServers.length > 0) throw this.reattachMcpRefused()
      // A request that was already cancelled owns no right to replace the held
      // View: refuse BEFORE the outgoing generation changes in any way.
      requestSignal?.throwIfAborted()
      previous = this.reattachClaim(state, access, sessionId)
      claim = this.replaceClaim(state, previous)
      this.watchRefreshAbort(state, claim, requestSignal)
      op = state.op
    } else {
      op = this.beginAttach(state)
      try {
        systemPromptAppend = validate()
      } catch (error) {
        this.resetIdleIfCurrent(state, op)
        throw error
      }
      if (this.claims.has(sessionId)) {
        this.resetIdleIfCurrent(state, op)
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_ALREADY_ATTACHED', 'the session is already attached to an ACP view', JSONRPC_INVALID_PARAMS)
      }
      claim = { connectionIdentity: state, sessionId, readAbort: new AbortController() }
      this.claims.set(sessionId, claim)
    }
    if (previous !== undefined) this.admitRefreshDispatch(state, op, claim, previous, access, requestSignal)
    const agent = await this.resolveForView(access, state, op, claim)
    if (previous !== undefined) this.requireSameGeneration(state, op, claim, previous, agent)
    if (agent.session.header.cwd !== request.cwd) {
      this.diag.warn('local-acp.view.cwd-mismatch', { mismatch: true })
    }
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
    try {
      this.installSystemPromptAppend(state, op, claim, access, agent, systemPromptAppend)
    } catch (error) {
      // A failed append registration never opens the replay barrier and never
      // commits the View; an exact MCP lease keeps its own retirement fence.
      this.releaseClaimWithMcp(state, claim, access)
      this.resetIdleIfCurrent(state, op)
      throw error
    }
    // REPLAY_BARRIER_OPEN: committed BEFORE the View becomes attached, so no
    // live update of this Session can ever precede the canonical snapshot.
    const replay: ViewReplay = { buffered: [], subagents: [], abort: new AbortController(), overflowed: false, stopped: false }
    claim.replay = replay
    this.commitAttached(state, op, claim, access, agent, channels)
    if (claim.notifyProjection === undefined) {
      this.releaseFailedLoad(state, op, claim, access, replay)
      throw new LocalAcpViewError(
        'LOCAL_ACP_LOAD_UNAVAILABLE',
        'this ACP connection has no read-only projection sink for a loaded session',
        JSONRPC_INTERNAL_ERROR,
      )
    }
    const signal = requestSignal === undefined
      ? replay.abort.signal
      : AbortSignal.any([requestSignal, replay.abort.signal])
    try {
      const history = await access.readSessionHistory(sessionId, signal)
      // The loaded Session's own official header is the ONLY authority for its
      // lineage when it is itself a subagent child.
      claim.selfHeader = history.header
      // The pure converter validates the WHOLE canonical order and every
      // committed block BEFORE a single notification is sent.
      const units = projectSessionHistory(history.events, claim.capabilities ?? NO_PROJECTION_CAPABILITIES, sessionId, claim.maxOutputFrameBytes)
      const cut = history.events[history.events.length - 1]?.seq ?? -1
      // Currentness after the Host await: a closed/replaced claim (or a stopped
      // replay) never publishes a stale history.
      if (this.claims.get(sessionId) !== claim || replay.stopped) {
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view was released while its history was read', JSONRPC_INVALID_PARAMS)
      }
      if (replay.overflowed) throw loadBackpressure()
      // DRAIN: the barrier stays OPEN until the ordered tail really drained, so
      // this View still refuses a new prompt and close/EOF can still abort the
      // replay's Store reads for the whole output phase. `seq <= cut` duplicates
      // the snapshot and is dropped; the rest joins by ascending seq exactly
      // once. The loop re-takes the buffer after every await, and closes the
      // barrier in the SAME synchronous step as an empty check — no observation
      // callback can interleave between them.
      await this.enqueueProjectionTask(claim, async () => {
        await this.sendHistoryUnits(claim, replay, units, access)
        const sentSeqs = new Set<number>()
        for (;;) {
          if (replay.stopped) return
          if (replay.overflowed) throw loadBackpressure()
          // Official child edges were NOT Session events: announce them before
          // the buffered turn, so a child's association precedes any buffered
          // message that names it (stable v1 `subagent_update` ordering).
          const edges = replay.subagents.splice(0, replay.subagents.length)
          const unique = new Map<number, AcpHistoryEvent>()
          for (const event of replay.buffered.splice(0, replay.buffered.length)) {
            if (event.seq <= cut || sentSeqs.has(event.seq) || unique.has(event.seq)) continue
            unique.set(event.seq, event)
          }
          const events = [...unique.values()].sort((left, right) => left.seq - right.seq)
          for (const event of events) sentSeqs.add(event.seq)
          if (edges.length === 0 && events.length === 0) {
            claim.replay = undefined
            return
          }
          for (const edge of edges) await this.releaseSubagent(claim, access, replay, edge)
          // The buffered window is still canonical HISTORY: every transcript fact
          // converts through the SAME pure converter, so a turn committed while
          // the snapshot was read is neither dropped nor re-invented. The
          // live-only read-only classes keep their own projection (a durable
          // title arrives only as a live event; provider usage needs the live
          // projection read).
          for (const event of events) {
            if (event.type === 'session/title') {
              await this.sendLiveEvent(claim, replay, event)
              continue
            }
            await this.sendHistoryUnits(
              claim, replay,
              projectSessionHistory([event], claim.capabilities ?? NO_PROJECTION_CAPABILITIES, claim.sessionId, claim.maxOutputFrameBytes),
              access,
            )
            if (event.type === 'assistant/message') await this.sendLiveEvent(claim, replay, event)
          }
        }
      })
      if (this.claims.get(sessionId) !== claim || replay.stopped) {
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view was released during its history replay', JSONRPC_INVALID_PARAMS)
      }
      // A loaded View resumes the SAME official continued questions a resume
      // would offer. It happens only AFTER the complete history drained and the
      // exact claim is still current: `load` is not a history-only variant of
      // `resume` that forgets the pending human question.
      if (claim.requestElicitation !== undefined && access.hasQuestionService()) {
        this.offerContinuedQuestions(claim, claim.requestElicitation)
      }
      this.scheduleCatalogRefresh(claim, access)
      return {}
    } catch (error) {
      // The cancellation class must be read BEFORE the release marks the replay
      // stopped, otherwise every failure would be classified as a cancellation.
      const cancelled = replay.stopped || signal.aborted
      this.releaseFailedLoad(state, op, claim, access, replay)
      throw this.mapLoadFailure(error, replay, signal, cancelled)
    }
  }

  /** Release a failed load's OWN View without touching the Host Session/Agent/TUI. */
  private releaseFailedLoad(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    replay: ViewReplay,
  ): void {
    replay.stopped = true
    if (replay.abort.signal.aborted === false) replay.abort.abort()
    claim.replay = undefined
    claim.projectionStalled = true
    this.releaseClaimWithMcp(state, claim, access)
    // The slot always returns to idle when THIS attach generation is still
    // current, exactly like `finishClose`: a fenced MCP retirement keeps its
    // claim but never blocks the connection's next attach with a stale phase.
    if (state.op === op && state.phase === 'attached') state.phase = 'idle'
  }

  /** Classify one load failure without leaking an exception or a Host path. */
  private mapLoadFailure(error: unknown, replay: ViewReplay, signal: AbortSignal, cancelled: boolean): unknown {
    if (replay.overflowed) return loadBackpressure()
    // The cancellation class is decided FIRST: a Store/notify failure observed
    // after close/EOF/abort is the replay being cancelled, never a corrupt
    // attachment or a business rejection.
    if (cancelled) {
      return new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view was released during its history replay', JSONRPC_INVALID_PARAMS)
    }
    if (error instanceof LocalAcpViewError || error instanceof AcpScopedMcpError) return error
    if (error instanceof AcpProjectionError) {
      return new LocalAcpViewError(error.code, error.message, JSONRPC_INTERNAL_ERROR)
    }
    return new LocalAcpViewError(
      'LOCAL_ACP_VIEW_HOST_ERROR',
      'the Host could not read the canonical Session history',
      JSONRPC_INTERNAL_ERROR,
    )
  }

  /**
   * Send the CURRENT official plan of one freshly attached View (resume only:
   * load already replays every `todo/write`). `null`/absent projection sends
   * nothing; an empty list is a formal clear.
   */
  /**
   * The ONE plan-removal path: the official `todos` projection reset (a new
   * `turn/start`) removes the plan this View already announced, with the
   * negotiated `plan_removed` or the baseline complete empty `plan`. A View
   * that never announced a plan sends nothing.
   */
  private async resetPlan(claim: ViewClaim): Promise<void> {
    if (claim.announcedPlan !== true) return
    await this.sendProjection(claim, planRemoval(claim.capabilities?.plan === true, claim.sessionId))
    claim.announcedPlan = false
  }

  private offerCurrentPlan(claim: ViewClaim, access: HostAcpSessionAccess): void {
    if (claim.notifyProjection === undefined) return
    const task = this.enqueueProjectionTask(claim, async () => {
      const todos = access.sessionTodos(claim.exactSession as object)
      if (todos === undefined) {
        this.diag.warn('local-acp.projection.unavailable', { key: 'todos' })
        return
      }
      if (todos === null) return
      const entries = planEntriesFromTodos(todos)
      if (entries === undefined) {
        this.diag.warn('local-acp.projection.unsupported', { key: 'todos' })
        return
      }
      await this.sendProjection(claim, planUpdate(entries, claim.capabilities?.plan === true, claim.sessionId))
      claim.announcedPlan = true
    })
    task.catch(error => { this.reportProjectionFailure(error) })
  }

  /** Project one durable Session event into this claim's read-only tail. */
  private observeSessionProjection(
    claim: ViewClaim,
    event: AcpSessionEventLike,
    receipt?: { delivered: boolean },
  ): Promise<void> | undefined {
    if (claim.notifyProjection === undefined) return undefined
    const replay = claim.replay
    if (replay !== undefined) {
      if (replay.buffered.length >= MAX_REPLAY_BUFFERED_EVENTS) {
        replay.overflowed = true
        if (!claim.readAbort.signal.aborted) claim.readAbort.abort()
        replay.abort.abort()
        return
      }
      // Keep the official durable time: a title buffered during the replay must
      // later project the same `updatedAt` the live path would.
      replay.buffered.push({ seq: event.seq, type: event.type, data: event.data, time: event.time })
      return undefined
    }
    if (!this.projectionEventRelevant(claim, event)) return undefined
    const task = this.enqueueProjectionTask(claim, async () => {
      const sent = await this.sendLiveEvent(claim, undefined, event)
      if (receipt !== undefined) receipt.delivered = sent
    })
    task.catch(error => { this.reportProjectionFailure(error) })
    return task
  }

  /** Whether one live durable event carries a read-only ACP projection. */
  private projectionEventRelevant(claim: ViewClaim, event: AcpSessionEventLike): boolean {
    switch (event.type) {
      case 'todo/write':
      case 'session/title':
        return true
      case 'turn/start':
        // ALWAYS queue the reset: the decision whether a plan needs removal
        // belongs to the moment this task RUNS in the one ordered tail, after
        // any earlier plan notification completed. Deciding here would drop the
        // reset while a slow plan send is still in flight.
        return true
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
        return claim.capabilities?.compaction === true
      case 'assistant/message':
        // The usage update is part of the baseline schema, so no capability
        // gates it; only a real provider usage sample can prove occupancy.
        return true
      case 'user/message':
        return claim.capabilities?.subagents === true
      default:
        return false
    }
  }

  /**
   * Project ONE live durable event into standard updates. Every update of this
   * branch is read-only and independent of any prompt flight: it never settles
   * a flight and never re-projects owned assistant output.
   */
  private async sendLiveEvent(claim: ViewClaim, replay: ViewReplay | undefined, event: AcpSessionEventLike): Promise<boolean> {
    switch (event.type) {
      case 'todo/write': {
        const entries = planEntriesOf(event.data)
        if (entries === undefined) {
          this.diag.warn('local-acp.projection.unsupported', { key: 'todo/write' })
          return false
        }
        await this.sendProjection(claim, planUpdate(entries, claim.capabilities?.plan === true, claim.sessionId))
        claim.announcedPlan = true
        return true
      }
      case 'turn/start': {
        // The official `todos` fold clears at every turn start; the removal is
        // sent only when this View already announced a plan.
        await this.resetPlan(claim)
        return false
      }
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end': {
        const update = compactionUpdate({ seq: event.seq, type: event.type, data: event.data })
        if (!this.acceptCompaction(claim, update)) return false
        await this.sendProjection(claim, update)
        this.acceptCompaction(claim, update, true)
        return true
      }
      case 'session/title': {
        const update = sessionInfoUpdateOf(event.data, event.time)
        if (update === undefined) return false
        const title = (update as { readonly title?: string }).title
        if (title !== undefined && claim.lastInfo?.title === title) return false
        await this.sendProjection(claim, update)
        // Recorded only after delivery: a failed send must not suppress the
        // retry of the same durable title.
        claim.lastInfo = { ...(title === undefined ? {} : { title }) }
        return true
      }
      case 'assistant/message': {
        // Occupancy is read ONLY after a message that carries the provider's
        // own usage, and only from the official context-pressure projection.
        if ((event.data as { readonly usage?: unknown } | null)?.usage === undefined) return false
        const access = this.access
        if (access === undefined || claim.exactSession === undefined) return false
        const update = usageUpdateOf(access.contextPressure(claim.exactSession))
        if (update === undefined) return false
        await this.sendProjection(claim, update)
        return true
      }
      case 'user/message': {
        const access = this.access
        if (access === undefined) return false
        let message: AcpHistoryAgentMessage | undefined
        try {
          message = durableAgentMessageOf(event.data)
        } catch {
          this.diag.warn('local-acp.projection.unsupported', { key: 'user/message' })
          return false
        }
        if (message === undefined) return false
        // Lineage, the legalization budget and the association all live in the
        // one shared session-message path: an unproven author must NOT be
        // charged (or diagnosed) for a file the Client can never be shown.
        return await this.projectSessionMessage(claim, access, replay, message)
      }
      default:
        return false
    }
  }

  /**
   * Send ONE durable inter-agent message as a standard `session_message`.
   *
   * Provenance is proven from OFFICIAL Session headers before anything is sent:
   * either the sender is a subagent child of this Session (its header carries
   * `origin:'subagent'` and this exact durable parent), or this Session is
   * itself a subagent child and the sender is its immediate parent (a real
   * author that is not a child association to announce). Any other author is
   * Host-internal or fabricated and projects NOTHING.
   *
   * When the sender IS a child, its association is announced with a
   * `subagent_update` first — at most once per claim — because the stable v1
   * contract has `subagent_update` announce a child before the Client sees that
   * child's traffic. The announcement omits `state`: this View never invents an
   * activity snapshot the Host did not report.
   */
  private async projectSessionMessage(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    replay: ViewReplay | undefined,
    message: AcpHistoryAgentMessage,
  ): Promise<boolean> {
    const lineage = await this.sessionMessageLineage(claim, access, message.senderSessionId)
    if (lineage === 'unproven') {
      this.diag.warn('local-acp.projection.session-message-unverified', { key: 'session_message' })
      return false
    }
    // A PROVEN inter-agent message is ONE ACP update: charge its files after
    // lineage is real and before the child association or any Store read. An
    // unproven author therefore costs no budget, diagnostic or read.
    try {
      assertFileBudget(filesOf(message.content), claim.maxOutputFrameBytes, true)
    } catch (error) {
      // Canonical history is fail-closed; a live projection only loses this
      // one read-only message and keeps the View.
      if (replay !== undefined) throw error
      this.reportProjectionFailure(error)
      return false
    }
    if (lineage === 'child' && !await this.announceChildAssociation(claim, access, message.senderSessionId)) return false
    const blocks: AcpWireContentBlock[] = []
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text.length === 0) continue
        blocks.push({ type: 'text', text: part.text })
        continue
      }
      try {
        blocks.push(part.type === 'image'
          ? await this.readProjectionImage(claim, replay, part.ref)
          : await this.readProjectionFile(claim, replay, part.ref))
      } catch (error) {
        // A CANONICAL HISTORY read is fail-closed: a committed attachment the
        // Store cannot produce must fail the load (the same rule as any other
        // history attachment), never silently drop the message and report a
        // complete replay. A live projection only loses this one message.
        if (replay !== undefined) throw error
        this.diag.warn('local-acp.projection.attachment-failed', { key: 'session_message' })
        return false
      }
    }
    if (blocks.length === 0) return false
    await this.sendProjection(claim, {
      sessionUpdate: 'session_message',
      messageId: message.messageId,
      senderSessionId: message.senderSessionId,
      recipientSessionId: claim.sessionId,
      content: blocks,
    })
    return true
  }

  /**
   * Classify one inter-agent author with the official header facts: `child`
   * (a verified subagent child of this Session), `parent` (this Session is the
   * verified child), or `unproven`.
   */
  private async sessionMessageLineage(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    senderSessionId: string,
  ): Promise<'child' | 'parent' | 'unproven'> {
    if (senderSessionId === claim.sessionId) return 'unproven'
    // A header read is a real official (possibly cold) read: it must be
    // cancellable with THIS claim, for the replay AND for the ordinary live
    // projection, so close/EOF/Off never waits on it.
    const signal = claim.readAbort.signal
    signal?.throwIfAborted()
    const sender = await access.sessionHeaderFacts(senderSessionId, signal)
    signal?.throwIfAborted()
    if (sender?.sessionId !== senderSessionId) return 'unproven'
    if (sender.origin === 'subagent' && sender.parentSessionId === claim.sessionId) return 'child'
    const self = claim.selfHeader ??= await access.sessionHeaderFacts(claim.sessionId, signal)
    signal?.throwIfAborted()
    if (self?.origin === 'subagent' && self.parentSessionId === senderSessionId) return 'parent'
    return 'unproven'
  }

  /**
   * Announce ONE verified child association at most once per claim, without a
   * fabricated state. An unprovable child projects nothing.
   */
  private async announceChildAssociation(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    childId: string,
  ): Promise<boolean> {
    const announced = claim.announcedChildren ??= new Set()
    if (announced.has(childId)) return true
    const signal = claim.readAbort.signal
    signal?.throwIfAborted()
    const facts = await access.sessionHeaderFacts(childId, signal)
    signal?.throwIfAborted()
    if (facts?.sessionId !== childId || facts.origin !== 'subagent' || facts.parentSessionId !== claim.sessionId) {
      this.diag.warn('local-acp.projection.subagent-unverified', {
        edge: 'message',
        reason: facts === undefined ? 'header-unavailable' : 'lineage-mismatch',
      })
      return false
    }
    await this.sendProjection(claim, {
      sessionUpdate: 'subagent_update',
      sessionId: childId,
      ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }),
    })
    announced.add(childId)
    return true
  }

  /**
   * Append ONE read-only projection task to this claim's single ordered tail.
   * The tail is the ONLY read-only queue: it never grows past its bounded task
   * count, the returned promise settles with THIS task (a live caller observes
   * it, the load request awaits it before answering) and the chain itself never
   * rejects.
   */
  private enqueueProjectionTask(claim: ViewClaim, run: () => Promise<void>): Promise<void> {
    if (claim.projectionStalled === true) return Promise.reject(projectionBackpressure())
    const pending = (claim.projectionPending ?? 0) + 1
    if (pending > MAX_PENDING_PROJECTION_TASKS) {
      claim.projectionStalled = true
      this.diag.warn('local-acp.projection.backpressure', { code: 'LOCAL_ACP_PROJECTION_BACKPRESSURE' })
      return Promise.reject(projectionBackpressure())
    }
    claim.projectionPending = pending
    const settled = Promise.withResolvers<void>()
    const execute = async (): Promise<void> => {
      try {
        if (claim.projectionStalled !== true && this.projectionCurrent(claim)) await run()
        settled.resolve()
      } catch (error) {
        settled.reject(error)
      } finally {
        claim.projectionPending = (claim.projectionPending ?? 1) - 1
      }
    }
    claim.projectionTail = (claim.projectionTail ?? Promise.resolve()).then(execute, execute)
    return settled.promise
  }

  /** Whether this exact claim may still deliver a read-only update. */
  private projectionCurrent(claim: ViewClaim): boolean {
    return claim.notifyProjection !== undefined
      && claim.connectionIdentity.phase !== 'closed'
      && claim.detachedWithFence !== true
      && this.claims.get(claim.sessionId) === claim
  }

  /**
   * End this claim's read-only output for good: drop every queued projection,
   * invalidate a still-open load replay and stop its IO (idempotent). Only the
   * claim's OWN connection is affected; the Session/Agent/TUI keep their Host
   * authority.
   */
  private stopProjectionOutput(claim: ViewClaim): void {
    claim.notifyProjection = undefined
    claim.inflight?.skillPreflightAbort?.abort()
    claim.projectionStalled = true
    if (!claim.readAbort.signal.aborted) claim.readAbort.abort()
    const replay = claim.replay
    claim.replay = undefined
    if (replay === undefined) return
    replay.stopped = true
    if (!replay.abort.signal.aborted) replay.abort.abort()
  }

  /** Send ONE read-only update through this claim's OWN connection sink. */
  private async sendProjection(claim: ViewClaim, update: SessionUpdate): Promise<void> {
    const notify = claim.notifyProjection
    if (notify === undefined) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view has no projection sink', JSONRPC_INTERNAL_ERROR)
    }
    await notify(claim.sessionId, update)
  }

  /**
   * The ONE per-claim compaction lifecycle gate. Each durable `compactionId`
   * may contribute at most one start, one summary and one end, in that order;
   * a duplicated or out-of-order callback is dropped instead of re-projecting
   * a lifecycle the client already received.
   */
  private acceptCompaction(claim: ViewClaim, update: SessionUpdate): boolean
  private acceptCompaction(claim: ViewClaim, update: SessionUpdate, commit: true): void
  private acceptCompaction(claim: ViewClaim, update: SessionUpdate, commit = false): boolean | void {
    if (update.sessionUpdate !== 'compaction_update') return commit ? undefined : true
    const states = claim.compactions ??= new Map()
    const current = states.get(update.compactionId)
    let next: 'started' | 'summarized' | 'ended' | undefined
    if (update.status === 'in_progress' && update.summary === undefined) {
      if (current === undefined) next = 'started'
    } else if (update.status === 'in_progress') {
      if (current === 'started') next = 'summarized'
    } else if (current === 'started' || current === 'summarized') {
      next = 'ended'
    }
    if (next === undefined) return commit ? undefined : false
    // The lifecycle is recorded only AFTER the send succeeded, so a failed
    // notification cannot consume the one allowed transition.
    if (commit) {
      states.set(update.compactionId, next)
      return undefined
    }
    return true
  }

  /**
   * Mark one exact claim's catalog stale. The epoch is committed synchronously
   * before any read can settle; the dirty bit coalesces bursts into one
   * follow-up read and never reaches command execution.
   */
  private invalidateCatalog(claim: ViewClaim): void {
    claim.catalogEpoch = (claim.catalogEpoch ?? 0) + 1
    claim.catalogDirty = true
    if (this.access !== undefined) this.scheduleCatalogRefresh(claim, this.access)
  }

  /** One global command-registry invalidation; it carries no scope by contract. */
  onCommandCatalogInvalidated(): void {
    for (const claim of this.claims.values()) this.invalidateCatalog(claim)
  }

  /** One global Skill/loader invalidation; every attached claim re-reads its own scope. */
  onSkillCatalogInvalidated(): void {
    for (const claim of this.claims.values()) this.invalidateCatalog(claim)
  }

  /**
   * One retained-composition invalidation (`tools/change`): every attached
   * claim re-reads the real mode/Team availability instead of trusting the
   * previously projected rows.
   */
  onPolicyAvailabilityInvalidated(): void {
    for (const claim of this.claims.values()) this.invalidateConfig(claim)
  }

  /**
   * Start (or coalesce) the ONE catalog read owner of this claim. A read never
   * crosses an attach/replay barrier, never cancels command execution and is
   * abandoned by the claim's existing `readAbort` lifetime.
   */
  private scheduleCatalogRefresh(claim: ViewClaim, access: HostAcpSessionAccess): void {
    if (claim.notifyProjection === undefined || claim.projectionStalled === true) return
    // The load replay owns the ordered output until its canonical history and
    // live window drained. An invalidation during it stays dirty; `loadSession`
    // schedules the first read after the barrier closes.
    if (claim.replay !== undefined) return
    if (claim.catalogReadRunning === true) return
    if (claim.catalogDirty !== true && claim.lastDeliveredCatalog !== undefined) return
    claim.catalogDirty = true
    claim.catalogReadRunning = true
    runDetached('local acp: command catalog', async () => {
      try {
        while (claim.catalogDirty === true && this.catalogRefreshCurrent(claim)) {
          claim.catalogDirty = false
          const epoch = claim.catalogEpoch ?? 0
          const agent = claim.exactAgent
          const session = claim.exactSession
          if (agent === undefined || session === undefined) return
          let commands: AcpCommandCatalogRead
          try {
            commands = access.readCommandCatalog(agent, session)
          } catch {
            this.diag.warn('local-acp.catalog.failed', { key: 'commands' })
            return
          }
          let skills: AcpNativeSkillCatalog
          try {
            skills = await access.readNativeSkills(agent, session, claim.readAbort.signal)
          } catch (error) {
            if (claim.readAbort.signal.aborted) return
            this.diag.warn('local-acp.catalog.failed', { key: 'skills' })
            return
          }
          if (!this.catalogRefreshCurrent(claim)
            || claim.exactAgent !== agent || claim.exactSession !== session) return
          if (claim.catalogEpoch !== epoch) continue
          const hostNames = new Set(commands.effectiveNames)
          const rows: AcpCatalogRow[] = skills.kind === 'available'
            ? [...commands.rows, ...skills.skills.filter(skill => !hostNames.has(skill.name) && !isReservedCommandName(skill.name))]
            : [...commands.rows]
          const previous = claim.lastDeliveredCatalog
          if (previous !== undefined && sameCatalogRows(previous, rows)) continue
          let delivered = false
          const update = catalogUpdate(rows)
          try {
            await this.enqueueProjectionTask(claim, async () => {
              // A stale read never reaches the client. The dirty bit was already
              // set by the invalidation, so the loop re-reads the current target.
              if (!this.catalogRefreshCurrent(claim) || claim.catalogEpoch !== epoch) return
              await this.sendProjection(claim, update)
              delivered = true
            })
          } catch {
            this.diag.warn('local-acp.catalog.failed', { key: 'delivery' })
            return
          }
          // Record only what the client ACTUALLY received. A skipped/stalled
          // task is not a delivery and must not suppress a later real update.
          if (delivered) claim.lastDeliveredCatalog = rows
        }
      } finally {
        claim.catalogReadRunning = false
        if (claim.catalogDirty === true && this.catalogRefreshCurrent(claim)) {
          this.scheduleCatalogRefresh(claim, access)
        }
      }
    }, { diag: this.diag })
  }

  /** Whether this exact claim may still read and deliver a catalog update. */
  private catalogRefreshCurrent(claim: ViewClaim): boolean {
    return this.claims.get(claim.sessionId) === claim
      && claim.notifyProjection !== undefined
      && claim.projectionStalled !== true
      && claim.detachedWithFence !== true
      && claim.replay === undefined
      && claim.connectionIdentity.phase === 'attached'
  }

  /** Record one live projection failure without failing a Host request. */
  private reportProjectionFailure(error: unknown): void {
    const code = error instanceof LocalAcpViewError
      ? error.code
      : error instanceof AcpProjectionError ? error.code : 'LOCAL_ACP_PROJECTION_FAILED'
    this.diag.warn('local-acp.projection.failed', { code })
  }

  /**
   * Send the converted canonical history in order. Every image is re-read and
   * verified by the official Host Attachment Store inside this tail, so one
   * event keeps its FIFO position and no fabricated placeholder is ever sent.
   */
  private async sendHistoryUnits(
    claim: ViewClaim,
    replay: ViewReplay,
    units: readonly AcpHistoryUnit[],
    access: HostAcpSessionAccess,
  ): Promise<void> {
    for (const unit of units) {
      if (replay.stopped || !this.projectionCurrent(claim)) {
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view was released during its history replay', JSONRPC_INVALID_PARAMS)
      }
      if (unit.kind === 'plan-reset') {
        await this.resetPlan(claim)
        continue
      }
      if (unit.kind === 'update') {
        if (!this.acceptCompaction(claim, unit.update)) continue
        await this.sendProjection(claim, unit.update)
        this.acceptCompaction(claim, unit.update, true)
        if (unit.update.sessionUpdate === 'plan' || unit.update.sessionUpdate === 'plan_update') claim.announcedPlan = true
        if (unit.update.sessionUpdate === 'plan_removed') claim.announcedPlan = false
        continue
      }
      if (unit.kind === 'image') {
        await this.sendProjection(claim, {
          sessionUpdate: unit.image.sessionUpdate,
          messageId: unit.image.messageId,
          content: await this.readProjectionImage(claim, replay, unit.image.ref),
        })
        continue
      }
      if (unit.kind === 'file') {
        await this.sendProjection(claim, {
          sessionUpdate: unit.file.sessionUpdate,
          messageId: unit.file.messageId,
          content: await this.readProjectionFile(claim, replay, unit.file.ref),
        })
        continue
      }
      if (unit.kind === 'session-message') {
        await this.projectSessionMessage(claim, access, replay, unit.message)
        continue
      }
      const content: ToolCallContent[] = []
      for (const part of unit.result.content) {
        if (part.type === 'text') {
          content.push({ type: 'content', content: { type: 'text', text: part.text } })
          continue
        }
        if (part.type === 'image') {
          content.push({ type: 'content', content: await this.readProjectionImage(claim, replay, part.ref) })
          continue
        }
        content.push({ type: 'content', content: await this.readProjectionFile(claim, replay, part.ref) })
      }
      await this.sendProjection(claim, {
        sessionUpdate: 'tool_call_update',
        toolCallId: unit.result.toolCallId,
        status: unit.result.status,
        content,
      })
    }
  }

  /** Read ONE committed image through the official Store and encode its verified bytes. */
  private async readProjectionImage(
    claim: ViewClaim,
    replay: ViewReplay | undefined,
    ref: AcpStoredImageRef,
  ): Promise<AcpWireContentBlock> {
    const access = this.access
    if (access === undefined) throw attachmentLoadFailed()
    try {
      const stored = await access.readOutputImage(ref, claim.readAbort.signal)
      return { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.mediaType }
    } catch {
      // A close/EOF/Off during the Store read is NOT a corrupt attachment: it
      // is THIS claim's read being cancelled (replay or live).
      if (claim.readAbort.signal.aborted || replay?.stopped === true) {
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view was released during its history replay', JSONRPC_INVALID_PARAMS)
      }
      throw attachmentLoadFailed()
    }
  }

  /**
   * Read ONE committed generic file through the official Store and convert its
   * verified bytes to the standard embedded `resource` blob. The stream must be
   * iterated to natural EOF (the Store's hash/byte verification only completes
   * there); an early stop is only the corrupt/over-declared case.
   */
  private async readProjectionFile(
    claim: ViewClaim,
    replay: ViewReplay | undefined,
    ref: AcpStoredFileRef,
  ): Promise<AcpWireContentBlock> {
    const access = this.access
    if (access === undefined) throw attachmentLoadFailed()
    try {
      const bytes = await readVerifiedFileBytes(access.readOutputFile(ref, claim.readAbort.signal), ref, claim.readAbort.signal)
      return fileResourceBlock(ref, bytes)
    } catch {
      if (claim.readAbort.signal.aborted || replay?.stopped === true) {
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP view was released during its history replay', JSONRPC_INVALID_PARAMS)
      }
      throw attachmentLoadFailed()
    }
  }

  /** One official `subagent/start` edge: announce the verified child association. */
  onSubagentStart(info: AcpSubagentRunInfo): void {
    this.announceSubagent(info, 'start')
  }

  /** One official `subagent/end` edge: the same association becomes idle. */
  onSubagentEnd(info: AcpSubagentRunInfo): void {
    this.announceSubagent(info, 'end')
  }

  /**
   * Announce ONE verified child association on its IMMEDIATE parent Session.
   * The child Session header must prove `origin:'subagent'` AND the exact
   * durable creator, so an ordinary fork's `parentSession` is never mistaken
   * for a subagent. Capabilities are always omitted (no child mutation) and an
   * unprovable association announces nothing.
   */
  private announceSubagent(info: AcpSubagentRunInfo, edge: 'start' | 'end'): void {
    for (const claim of this.claims.values()) {
      if (claim.sessionId !== info.parentSessionId) continue
      if (claim.capabilities?.subagents !== true || claim.notifyProjection === undefined) continue
      const access = this.access
      if (access === undefined) continue
      const replay = claim.replay
      if (replay !== undefined) {
        // Inside a load barrier this official edge is NOT a Session event, so it
        // is held with the history and released after it — never before the
        // canonical snapshot it must follow.
        if (replay.subagents.length >= MAX_REPLAY_BUFFERED_EVENTS) {
          replay.overflowed = true
          // The SAME terminal abort as the Session-event buffer: this replay can
          // never succeed, so any read it still waits on must stop now instead
          // of after the drain notices the overflow.
          if (!claim.readAbort.signal.aborted) claim.readAbort.abort()
          replay.abort.abort()
          return
        }
        replay.subagents.push({ edge, info })
        continue
      }
      const task = this.enqueueProjectionTask(claim, async () => {
        await this.releaseSubagent(claim, access, undefined, { edge, info })
      })
      task.catch(error => { this.reportProjectionFailure(error) })
    }
  }

  /**
   * Release ONE official child edge inside this claim's ordered tail: verify
   * the child lineage, send the lifecycle update and keep the runId join.
   */
  private async releaseSubagent(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    replay: ViewReplay | undefined,
    buffered: AcpSubagentEdge,
  ): Promise<void> {
    const { edge, info } = buffered
    if (replay?.stopped === true) return
    // The official runId joins the end edge to the association the start
    // edge already verified on THIS claim. Both edges are resolved INSIDE
    // one FIFO tail, so an end published while the start notification is
    // still held sees the start's verified entry. The child Agent is
    // disposed before `end` is published, so a second lineage read would
    // race that disposal; an end whose start this View never projected
    // announces NOTHING — a lone idle snapshot would create an association
    // this connection never observed.
    const known = edge === 'end' ? claim.subagentRuns?.get(info.runId) : undefined
    if (edge === 'end' && (known === undefined || known.childId !== info.id)) {
      this.diag.warn('local-acp.projection.subagent-unverified', { edge, reason: 'run-unknown' })
      return
    }
    const verified = known !== undefined && known.childId === info.id
      ? { childId: known.childId, ...(known.cwd === undefined ? {} : { cwd: known.cwd }) }
      : await this.verifySubagentChild(claim, access, info, edge)
    if (verified === undefined) return
    await this.sendProjection(claim, {
      sessionUpdate: 'subagent_update',
      sessionId: verified.childId,
      state: edge === 'start'
        ? { state: 'running' }
        : { state: 'idle', stopReason: subagentStopReason(info.stopReason) },
      ...(verified.cwd === undefined ? {} : { cwd: verified.cwd }),
    })
    if (edge === 'start') {
      const runs = claim.subagentRuns ??= new Map()
      runs.set(info.runId, { childId: verified.childId, ...(verified.cwd === undefined ? {} : { cwd: verified.cwd }) })
      ;(claim.announcedChildren ??= new Set()).add(verified.childId)
      return
    }
    claim.subagentRuns?.delete(info.runId)
  }

  /**
   * Cross-check one announced child against the official Session header:
   * `origin:'subagent'` AND the exact durable creator. An unprovable child
   * announces nothing and leaves a bounded diagnostic.
   */
  private async verifySubagentChild(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    info: AcpSubagentRunInfo,
    edge: 'start' | 'end',
  ): Promise<{ readonly childId: string; readonly cwd?: string } | undefined> {
    const signal = claim.readAbort.signal
    signal?.throwIfAborted()
    const facts = await access.sessionHeaderFacts(info.id, signal)
    signal?.throwIfAborted()
    if (facts === undefined || facts.sessionId !== info.id
      || facts.origin !== 'subagent' || facts.parentSessionId !== info.parentSessionId) {
      this.diag.warn('local-acp.projection.subagent-unverified', {
        edge,
        reason: facts === undefined ? 'header-unavailable' : 'lineage-mismatch',
      })
      return undefined
    }
    return { childId: facts.sessionId, ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }) }
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
      if (claim.inflight !== undefined || claim.commandOperation !== undefined
        || claim.policyWrite !== undefined
        || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined) {
        claim.detachedWithFence = true
        this.notifyWorkSettled()
        return
      }
      this.claims.delete(claim.sessionId)
      this.notifyWorkSettled()
    }, { diag: this.diag })
  }

  /**
   * The provider-side currentness fact of ONE registered append contribution.
   * It is read during assembly, so it is purely synchronous and can never
   * resurrect a retired/replaced generation.
   */
  private systemPromptAppendLive(
    state: ConnectionViewState,
    claim: ViewClaim,
    registration: AcpSystemPromptAppendRegistration,
  ): boolean {
    return registration.active && registration.committed
      && claim.connectionIdentity === state
      && this.claims.get(claim.sessionId) === claim
      && claim.detachedWithFence !== true
  }

  /**
   * Register the ONE validated client append in the exact Agent's official
   * Cordis scope BEFORE the View commits. The registration responsibility is
   * installed on the claim first, so a synchronous `system-prompt/change`
   * callback that re-enters close/EOF/replacement can already fail the provider
   * closed. An official `section()` throw has rolled back inside the effect
   * (G0-c), so it leaves no live contribution.
   */
  private installSystemPromptAppend(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    agent: LiveAgentViewIdentity,
    text: string | undefined,
  ): void {
    if (text === undefined) return
    const registration: AcpSystemPromptAppendRegistration = { active: true, committed: false, dispose: () => {} }
    claim.systemPromptAppend = registration
    let handle: { readonly dispose: () => void }
    try {
      handle = access.registerSystemPromptAppend(agent, agent.session, text,
        () => this.systemPromptAppendLive(state, claim, registration))
    } catch (error) {
      if (claim.systemPromptAppend === registration) claim.systemPromptAppend = undefined
      registration.active = false
      if (error instanceof AcpSystemPromptAppendError && error.kind === 'stale') {
        throw new LocalAcpViewError(
          'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE',
          'the resolved session agent is no longer the live Host agent',
          JSONRPC_INTERNAL_ERROR,
          { sessionId: claim.sessionId },
        )
      }
      const reason = error instanceof AcpSystemPromptAppendError && error.kind === 'unavailable'
        ? 'system-prompt-unavailable'
        : 'system-prompt-registration-failed'
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_HOST_ERROR',
        'the Host could not register the client system prompt append',
        JSONRPC_INTERNAL_ERROR,
        { sessionId: claim.sessionId, reason },
      )
    }
    registration.dispose = handle.dispose
    const current = claim.systemPromptAppend === registration
      && this.isCurrentOp(state, op)
      && this.claims.get(claim.sessionId) === claim
      && claim.connectionIdentity === state
      && claim.detachedWithFence !== true
    if (current) return
    // A reentrant close/EOF/replacement retired the responsibility while the
    // exact disposer was still being returned: the late disposer settles it and
    // the stale claim never commits.
    if (claim.systemPromptAppend === registration) claim.systemPromptAppend = undefined
    registration.active = false
    try {
      handle.dispose()
    } catch {
      this.diag.warn('local-acp.system-prompt-retire-notification-failed', { reason: 'change-notification' })
    }
    throw new LocalAcpViewError(
      'LOCAL_ACP_VIEW_CLOSED',
      'the ACP view was released before it attached',
      JSONRPC_INVALID_PARAMS,
      { sessionId: claim.sessionId },
    )
  }

  /**
   * Retire the claim's exact append contribution: fail the provider closed FIRST
   * (so no later assembly can consume it), then invoke the exact official
   * disposer. G0-c proved the installed official scoped layer runs its undo
   * BEFORE the change notification, so a notification throw still follows an
   * exact removal; it is observed with a stable content-free reason and never
   * reported as a clean call. The responsibility is cleared only afterwards.
   */
  private retireSystemPromptAppend(claim: ViewClaim): void {
    const append = claim.systemPromptAppend
    if (append === undefined) return
    claim.systemPromptAppend = undefined
    append.active = false
    append.committed = false
    try {
      append.dispose()
    } catch {
      this.diag.warn('local-acp.system-prompt-retire-notification-failed', { reason: 'change-notification' })
    }
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
    // own this connection's attaching/attached View. A file admission that is
    // still settling must be joined, not reported as a clean close.
    if (claim.detachedWithFence) {
      const flight = claim.inflight
      if (flight !== undefined && !flight.settledDone) {
        await flight.settled.promise.catch(() => {})
        if (flight.fileCleanupUnconfirmed === true) throw this.fileCleanupUnconfirmedError()
      }
      if (flight?.fileCleanupUnconfirmed === true) throw this.fileCleanupUnconfirmedError()
      if (flight?.resourceFailure !== undefined) throw flight.resourceFailure
      if (claim.unclaimedHostObligation !== undefined) {
        throw promptError(
          'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
          'the accepted prompt has no proven Host terminal status yet',
          JSONRPC_INTERNAL_ERROR,
        )
      }
      return {}
    }
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
    if (claim.policyWrite !== undefined) {
      // A policy write is terminal work: commit the singleflight close slot
      // BEFORE stopping delivery, never cancel the Host write, and await its
      // captured real terminal. A repeated close joins the SAME attempt.
      const deferred = Promise.withResolvers<Record<string, never>>()
      claim.closing = deferred.promise
      claim.notifyConfigUpdate = undefined
      runDetached('local acp: policy close', async () => {
        try {
          deferred.resolve(await this.closeClaim(state, sessionId, claim, access))
        } catch (error) {
          deferred.reject(error)
        }
      }, { diag: this.diag })
      try {
        return await deferred.promise
      } finally {
        if (claim.closing === deferred.promise) claim.closing = undefined
      }
    }
    if (claim.commandOperation !== undefined) {
      // Commit the singleflight attempt BEFORE any cancellation callback can
      // re-enter close. The command's exact execution terminal is then awaited
      // without a second close attempt overwriting the slot.
      const deferred = Promise.withResolvers<Record<string, never>>()
      claim.closing = deferred.promise
      runDetached('local acp: command close', async () => {
        try {
          deferred.resolve(await this.closeClaim(state, sessionId, claim, access))
        } catch (error) {
          deferred.reject(error)
        }
      }, { diag: this.diag })
      try {
        return await deferred.promise
      } finally {
        if (claim.closing === deferred.promise) claim.closing = undefined
      }
    }
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
    let resourceFailure: LocalAcpViewError | undefined
    // A policy write owns the Host maintenance window until its ORIGINAL call
    // settles. Close never cancels it; it waits for the captured terminal and
    // only then evaluates the remaining obligations.
    const policy = claim.policyWrite
    if (policy !== undefined) {
      claim.notifyConfigUpdate = undefined
      await policy
    }
    const command = claim.commandOperation
    if (command !== undefined) {
      // Close delivery first, record the exact cancellation intent, and wait
      // for the ORIGINAL official execution Promise. A business error is a real
      // terminal and does not prevent a safe detach; an unproven terminal keeps
      // the claim fenced instead of fabricating success.
      command.deliveryClosed = true
      this.stopProjectionOutput(claim)
      this.requestCommandCancel(claim, command)
      this.abandonCommandDelivery(command)
      // Closed delivery must not retain an already settled Host operation.
      // Dispatch releases the slot only after the ORIGINAL execution Promise
      // settles, so completion already carries that exact terminal.
      await command.completion.promise
    }
    // An unclaimed obligation may still execute. Try ONE exact removal on the
    // current facts; anything short of a real removal is unconfirmed.
    const obligation = claim.unclaimedHostObligation
    if (obligation !== undefined) {
      if (obligation.messageId !== undefined && claim.exactAgent !== undefined && claim.exactSession !== undefined) {
        const removed = access.cancelPending(sessionId, claim.exactAgent, claim.exactSession, obligation.messageId)
        if (removed === 'removed') {
          const retired = this.retireRemovedPrompt(claim, obligation.requestId)
          this.dropUnclaimedObligation(claim)
          if (!retired) {
            // The removal is real, but the resource terminal is unconfirmed.
            // Keep the error, finish the normal detach/MCP path, then report it
            // once on this close.
            resourceFailure = promptError(
              'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
              'the removed queued prompt file receipts could not be confirmed retired',
              JSONRPC_INTERNAL_ERROR,
              { reason: 'file-receipt-retirement-unconfirmed' },
            )
          }
        }
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
      if (flight.fileCleanupUnconfirmed === true || flight.resourceFailure !== undefined) {
        resourceFailure ??= flight.resourceFailure ?? this.fileCleanupUnconfirmedError()
      }
      if (outcome !== 'ok') {
        // A prompt failure is not a close proof (R701-04): only a real Host
        // terminal (its own turn/end, an Agent disposal, or a definite
        // pre-insertion rejection) lets the close proceed.
        const terminal = flight.ownTurnEnded
          || flight.failureCode === 'LOCAL_ACP_PROMPT_HOST_REJECTED'
          || flight.definiteNoDispatch === true
        if (outcome instanceof LocalAcpViewError && this.isFileRetirementError(outcome)) {
          resourceFailure ??= outcome
        } else if (!terminal) {
          throw outcome
        }
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
    const result = this.finishClose(state, sessionId, claim)
    if (resourceFailure !== undefined) throw resourceFailure
    return result
  }

  /** Whether an error is the fixed D4/D5 resource-retirement terminal. */
  private isFileRetirementError(error: unknown): error is LocalAcpViewError {
    return error instanceof LocalAcpViewError
      && error.data.reason === 'file-receipt-retirement-unconfirmed'
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
    if (claim.commandOperation !== undefined) return
    if (claim.policyWrite !== undefined) return
    if (claim.retiringTurn !== undefined) return
    if (claim.unclaimedHostObligation !== undefined) return
    if (claim.mcpMountPending === true || claim.mcpLease !== undefined) return
    // An unsettled append responsibility is a real detach obligation: no release
    // path may step over it (the synchronous retire runs at every real detach).
    if (claim.systemPromptAppend !== undefined) return
    if (this.claims.get(claim.sessionId) === claim) this.claims.delete(claim.sessionId)
  }

  /** Release one settled claim and record the idempotent close fact. */
  private finishClose(state: ConnectionViewState, sessionId: string, claim: ViewClaim): Record<string, never> {
    if (this.claims.get(sessionId) !== claim || claim.detachedWithFence || state.phase === 'closed') return {}
    // The real detach boundary retires the official scoped contribution before
    // the View is gone; an assembled system request already sampled stays as it was.
    this.retireSystemPromptAppend(claim)
    // A closed View owns no connection output or reverse Form any more.
    claim.notifyConfigUpdate = undefined
    // The read-only projection sink dies with the detach: a queued projection
    // is dropped and a still-open load replay is invalidated here.
    this.stopProjectionOutput(claim)
    this.releaseQuestionForms(claim)
    // A transient terminal fact may still outlive the View: a retired-turn
    // approval fence (F2) or an unclaimed Host obligation (v1.1). The View
    // detaches, but the claim survives so a LATE approval of that exact
    // ACP-owned turn can never be delegated to the TUI and a late insertion is
    // still observed. A claim with no such fact is released now.
    if (claim.retiringTurn !== undefined || claim.commandOperation !== undefined
      || claim.policyWrite !== undefined
      || claim.mcpMountPending === true || claim.mcpLease !== undefined) {
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
    const command = claim.commandOperation
    if (command !== undefined) {
      this.requestCommandCancel(claim, command)
      return
    }
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
    // A D4/D5 resource failure is not erased by a business terminal; it must
    // reach the affected close even when the Agent disposal already proved the
    // business side.
    if (outcome instanceof LocalAcpViewError && this.isFileRetirementError(outcome)) throw outcome
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
    if (flight.skillPreflightAbort !== undefined) {
      // The advertised-Skill revalidation is the only live Host read of this
      // flight. Cancelling it is a definite pre-dispatch action; no message or
      // turn exists yet.
      flight.skillPreflightAbort.abort()
      return
    }
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
        if (!this.retireRemovedPrompt(claim, flight.requestId)) {
          flight.resourceFailure ??= this.fileCleanupUnconfirmedError()
          this.failOrDeferAdmission(claim, flight, flight.resourceFailure)
          return
        }
        flight.stagedReceipts = undefined
        this.stopFlightOutput(flight)
        this.settleQueuedRemoval(claim, flight)
        return
      }
      if (removed === 'stale') {
        // The exact Agent/Session identity is gone; the official facts cannot
        // prove a removal. Fail closed — never guess "probably removed".
        this.failOrDeferAdmission(claim, flight, promptError(
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
      this.failOrDeferAdmission(claim, flight, promptError(
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
  /**
   * Route one raw wire prompt from the CURRENT effective registry and the LAST
   * DELIVERED catalog. A Host read failure on a leading candidate fails closed;
   * ordinary prose never reaches the command registry.
   */
  private classifyCommandRoute(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    prompt: readonly unknown[],
  ): { readonly route: ReturnType<typeof routeLeadingCommand>; readonly epoch: number } {
    const leading = readLeadingCommand(prompt, line => access.parseCommand(line))
    const epoch = claim.catalogEpoch ?? 0
    if (leading === undefined) return { route: { kind: 'prose' }, epoch }
    let catalog: AcpCommandCatalogRead
    try {
      catalog = access.readCommandCatalog(
        claim.exactAgent as LiveAgentViewIdentity,
        claim.exactSession as object,
      )
    } catch {
      throw new LocalAcpViewError(
        'LOCAL_ACP_COMMAND_UNAVAILABLE',
        'the Host command registry could not be read; the command was not dispatched',
        JSONRPC_INVALID_PARAMS,
      )
    }
    const deliveredSkills = new Set(
      (claim.lastDeliveredCatalog ?? [])
        .filter(row => row.kind === 'skill')
        .map(row => row.name),
    )
    return { route: routeLeadingCommand(leading, catalog, deliveredSkills, prompt.length), epoch }
  }

  /**
   * Admit one approved command as a transient operation. The slot and the
   * operation-specific execution signal are committed synchronously BEFORE the
   * official call, so the exact Session facts it publishes are attributable.
   */
  private async dispatchCommand(
    claim: ViewClaim,
    access: HostAcpSessionAccess,
    route: { readonly kind: 'standalone'; readonly line: string } | { readonly kind: 'compact' },
    requestSignal: AbortSignal,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): Promise<AcpPromptResult> {
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    if (requestSignal.aborted) {
      throw promptError('LOCAL_ACP_PROMPT_ABORTED', 'the ACP command request was aborted before dispatch', JSONRPC_INVALID_PARAMS)
    }
    const controller = new AbortController()
    const op: AcpOwnedCommand = {
      kind: route.kind,
      messageId: randomUUID(),
      controller,
      cancelReason: new Error('local-acp-compact-cancel'),
      dispatching: true,
      invoked: false,
      cancelRequested: false,
      abortScheduled: false,
      deliveryClosed: false,
      hostSettled: false,
      deliveryAbort: Promise.withResolvers<void>(),
      completion: Promise.withResolvers<void>(),
      ownFrames: [],
      checkpointSeen: false,
      factConflict: false,
    }
    claim.commandOperation = op
    const onAbort = (): void => {
      // This exact command request channel owns only its delivery wait. The
      // raw Host Promise remains the ownership terminal.
      this.abandonCommandDelivery(op)
      this.requestCommandCancel(claim, op)
    }
    requestSignal.addEventListener('abort', onAbort, { once: true })
    op.requestAbortDisposer = () => requestSignal.removeEventListener('abort', onAbort)
    let official: Promise<unknown>
    try {
      if (op.cancelRequested) throw promptError('LOCAL_ACP_PROMPT_ABORTED', 'the ACP command request was cancelled before dispatch', JSONRPC_INVALID_PARAMS)
      op.invoked = true
      official = route.kind === 'compact'
        ? access.executeManualCompact(agent, session, controller.signal)
        : access.executeStandaloneCommand(agent, session, route.line, controller.signal)
    } catch (error) {
      op.hostSettled = true
      this.settleCommandSlot(claim, op)
      throw this.mapHostCommandError(error)
    }
    op.dispatching = false
    this.replayCommandCancel(claim, op)
    try {
      const settlement: AcpCommandSettlement = await official.then(
        value => ({ kind: 'resolved' as const, value }),
        error => ({ kind: 'rejected' as const, error }),
      )
      op.hostSettled = true
      const facts: AcpCompactObservedFacts = {
        ...op.compactionId === undefined ? {} : { compactionId: op.compactionId },
        ...op.startSeq === undefined ? {} : { startSeq: op.startSeq },
        ...op.summarySeq === undefined ? {} : { summarySeq: op.summarySeq },
        ...op.endSeq === undefined ? {} : { endSeq: op.endSeq },
        ...op.endError === undefined ? {} : { endError: op.endError },
        checkpointSeen: op.checkpointSeen,
        conflict: op.factConflict,
      }
      const outcome = route.kind === 'compact'
        ? classifyCompactOutcome(settlement, facts, isAcpCompactAbort(settlement, op.controller.signal, op.cancelReason))
        : classifyStandaloneOutcome(settlement)
      const frames = await this.awaitCommandFrames(op)
      if (frames === 'failed' && !op.deliveryClosed && !requestSignal.aborted) {
        throw new LocalAcpViewError(
          'LOCAL_ACP_COMMAND_OUTPUT_FAILED',
          'a mandatory command compaction update could not be delivered on the ACP connection',
          JSONRPC_INTERNAL_ERROR,
        )
      }
      if (!op.deliveryClosed && !requestSignal.aborted) {
        await this.deliverCommandOutcome(claim, op, outcome, sendUpdate)
      }
      if (outcome.kind === 'failure') throw this.commandOutcomeError(outcome)
      return { stopReason: outcome.kind === 'cancelled' ? 'cancelled' : 'end_turn' }
    } finally {
      this.settleCommandSlot(claim, op)
    }
  }

  /** Release one exact command slot and its waiters, never a newer operation. */
  private settleCommandSlot(claim: ViewClaim, op: AcpOwnedCommand): void {
    op.requestAbortDisposer?.()
    op.requestAbortDisposer = undefined
    if (claim.commandOperation === op) claim.commandOperation = undefined
    op.deliveryAbort.resolve()
    op.completion.resolve()
    this.notifyWorkSettled()
  }

  /**
   * Deliver the command's own standard result AFTER every compaction update
   * already queued by the official synchronous publication. The bounded tail is
   * the existing ordered sink; the result task is the actual delivery receipt.
   */
  private async deliverCommandOutcome(
    claim: ViewClaim,
    op: AcpOwnedCommand,
    outcome: AcpCommandOutcome,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): Promise<void> {
    if (outcome.kind === 'failure' || outcome.kind === 'cancelled') return
    const text = outcome.text
    if (text === undefined || text.length === 0) return
    let delivered = false
    try {
      const task = this.enqueueProjectionTask(claim, async () => {
        if (op.deliveryClosed || claim.commandOperation !== op || !this.projectionCurrent(claim)) return
        await sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          messageId: op.messageId,
          content: { type: 'text', text },
        })
        delivered = true
      })
      const winner = await Promise.race([
        task.then(() => 'task' as const, error => Promise.reject(error)),
        op.deliveryAbort.promise.then(() => 'abandoned' as const),
      ])
      if (winner === 'abandoned') return
    } catch {
      if (op.deliveryClosed) return
      throw new LocalAcpViewError(
        'LOCAL_ACP_COMMAND_OUTPUT_FAILED',
        'the command result could not be delivered on the ACP connection',
        JSONRPC_INTERNAL_ERROR,
      )
    }
    if (op.deliveryClosed) return
    if (!delivered) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_COMMAND_OUTPUT_FAILED',
        'the command result could not be delivered on the ACP connection',
        JSONRPC_INTERNAL_ERROR,
      )
    }
  }

  /** Map one pre-dispatch Host access failure onto its stable ACP classification. */
  private mapHostCommandError(error: unknown): LocalAcpViewError {
    if (error instanceof AcpHostCommandError) {
      switch (error.code) {
        case 'stale':
          return new LocalAcpViewError('LOCAL_ACP_COMMAND_STALE', 'the exact Host command identity changed before dispatch', JSONRPC_INVALID_PARAMS)
        case 'unsupported':
          return new LocalAcpViewError('LOCAL_ACP_COMMAND_UNSUPPORTED', 'this Host command is not supported by the ACP command contract', JSONRPC_INVALID_PARAMS)
        case 'unavailable':
          return new LocalAcpViewError('LOCAL_ACP_COMMAND_UNAVAILABLE', 'the approved Host service is unavailable', JSONRPC_INVALID_PARAMS)
      }
    }
    this.diag.warn('local-acp.command.dispatch-failed', {
      kind: error instanceof Error ? error.name : typeof error,
      ...typeof (error as { readonly code?: unknown } | null)?.code === 'string'
        ? { code: (error as { readonly code: string }).code }
        : {},
    })
    return new LocalAcpViewError('LOCAL_ACP_COMMAND_INDETERMINATE', 'the command could not be dispatched', JSONRPC_INTERNAL_ERROR)
  }

  /** Map one classified command failure onto the existing View error boundary. */
  private commandOutcomeError(outcome: Extract<AcpCommandOutcome, { readonly kind: 'failure' }>): LocalAcpViewError {
    const rpcCode = outcome.code === 'LOCAL_ACP_COMMAND_BUSY'
      || outcome.code === 'LOCAL_ACP_COMMAND_UNSUPPORTED'
      || outcome.code === 'LOCAL_ACP_COMMAND_INVALID_INPUT'
      || outcome.code === 'LOCAL_ACP_COMMAND_STALE'
      || outcome.code === 'LOCAL_ACP_COMMAND_UNAVAILABLE'
      ? JSONRPC_INVALID_PARAMS
      : JSONRPC_INTERNAL_ERROR
    return new LocalAcpViewError(outcome.code, outcome.text ?? outcome.message, rpcCode)
  }

  /**
   * The ONE ACP cancellation seat for a command operation. The intent is
   * synchronous; the actual compact abort decision is deferred exactly one
   * microtask and re-checks the CURRENT slot and this operation's own commit
   * fact. A standalone command is never aborted after dispatch.
   */
  private requestCommandCancel(claim: ViewClaim, op: AcpOwnedCommand): void {
    if (op.hostSettled || op.cancelRequested) return
    op.cancelRequested = true
    // A predispatch intent is consumed by the dispatcher's gate; it must not
    // abort the controller before the official invocation exists.
    if (!op.invoked) return
    if (op.kind === 'standalone') return
    this.scheduleCommandAbort(claim, op)
  }

  /** Replay a cancel intent that arrived during the official synchronous prefix. */
  private replayCommandCancel(claim: ViewClaim, op: AcpOwnedCommand): void {
    if (op.cancelRequested && op.kind === 'compact') this.scheduleCommandAbort(claim, op)
  }

  /** The ONE deferred compact abort decision; commit facts always win. */
  private scheduleCommandAbort(claim: ViewClaim, op: AcpOwnedCommand): void {
    if (op.abortScheduled) return
    op.abortScheduled = true
    queueMicrotask(() => {
      op.abortScheduled = false
      if (this.claims.get(claim.sessionId) !== claim || claim.commandOperation !== op || op.hostSettled) return
      if (op.summarySeq !== undefined) return
      op.controller.abort(op.cancelReason)
    })
  }

  /** Close this operation's delivery wait without inventing a Host terminal. */
  private abandonCommandDelivery(op: AcpOwnedCommand): void {
    op.deliveryClosed = true
    op.deliveryAbort.resolve()
  }

  /**
   * Await up to three own negotiated compaction frames. Skipped/stalled or
   * failed tasks are a delivery failure; a closed channel abandons only this
   * delivery obligation, never the original Host Promise.
   */
  private async awaitCommandFrames(op: AcpOwnedCommand): Promise<'delivered' | 'abandoned' | 'failed'> {
    if (op.ownFrames.length === 0) return 'delivered'
    if (op.deliveryClosed) return 'abandoned'
    const settled = Promise.allSettled(op.ownFrames.map(frame => frame.task))
    const winner = await Promise.race([
      settled.then(results => ({ kind: 'frames' as const, results })),
      op.deliveryAbort.promise.then(() => ({ kind: 'abandoned' as const })),
    ])
    if (winner.kind === 'abandoned') return 'abandoned'
    if (winner.results.some(result => result.status === 'rejected')) return 'failed'
    const required = new Set(op.ownFrames.map(frame => frame.eventType))
    for (const frame of op.ownFrames) {
      if (frame.receipt.delivered) required.delete(frame.eventType)
    }
    return required.size === 0 ? 'delivered' : 'failed'
  }

  /**
   * Revalidate one ALREADY DELIVERED Skill intention against the exact live
   * registry, loader composition and effective cwd. The read is bounded by its
   * own preflight controller plus the claim's read lifetime; it is not a Host
   * write and creates no second operation registry.
   */
  private async preflightAdvertisedSkill(
    claim: ViewClaim,
    flight: InflightPrompt,
    access: HostAcpSessionAccess,
    name: string,
    epoch: number,
  ): Promise<'ok' | 'cancelled'> {
    const controller = new AbortController()
    flight.skillPreflightAbort = controller
    const signal = AbortSignal.any([controller.signal, claim.readAbort.signal])
    const agent = claim.exactAgent as LiveAgentViewIdentity
    const session = claim.exactSession as object
    try {
      const catalog = await access.readNativeSkills(agent, session, signal)
      if (controller.signal.aborted || flight.cancelRequested || flight.deliveryClosed) return 'cancelled'
      if (claim.readAbort.signal.aborted) {
        throw new LocalAcpViewError('LOCAL_ACP_COMMAND_UNAVAILABLE', 'the ACP view stopped its read before the Skill settled', JSONRPC_INVALID_PARAMS)
      }
      if (this.claims.get(claim.sessionId) !== claim || claim.exactAgent !== agent || claim.exactSession !== session
        || (claim.catalogEpoch ?? 0) !== epoch || claim.replay !== undefined) {
        throw new LocalAcpViewError('LOCAL_ACP_COMMAND_STALE', 'the advertised Skill changed before dispatch', JSONRPC_INVALID_PARAMS)
      }
      if (catalog.kind !== 'available' || !catalog.skills.some(skill => skill.name === name)) {
        throw new LocalAcpViewError('LOCAL_ACP_COMMAND_STALE', 'the advertised Skill is no longer available on this exact Agent', JSONRPC_INVALID_PARAMS)
      }
      // Host command precedence is re-read synchronously after the await: a
      // command registered under the same name wins over the Skill intention.
      let commands: AcpCommandCatalogRead
      try {
        commands = access.readCommandCatalog(agent, session)
      } catch {
        throw new LocalAcpViewError('LOCAL_ACP_COMMAND_UNAVAILABLE', 'the Host command registry could not be re-read', JSONRPC_INVALID_PARAMS)
      }
      if (commands.effectiveNames.includes(name)) {
        throw new LocalAcpViewError('LOCAL_ACP_COMMAND_STALE', 'a Host command now shadows the advertised Skill', JSONRPC_INVALID_PARAMS)
      }
      return 'ok'
    } catch (error) {
      if (controller.signal.aborted || flight.cancelRequested) return 'cancelled'
      throw error
    } finally {
      if (flight.skillPreflightAbort === controller) flight.skillPreflightAbort = undefined
    }
  }

  /**
   * Cleanup-only retirement for the receipts this flight actually received.
   * It runs synchronously in one stack, never commits and never deletes the
   * immutable Store object. A failure is recorded and never retried.
   */
  private cleanupPreparedFiles(claim: ViewClaim, flight: InflightPrompt): boolean {
    if (flight.stagedReceipts === undefined || flight.stagedReceipts.length === 0) return true
    if (flight.fileCleanupUnconfirmed === true) return false
    const agent = claim.exactAgent
    const access = this.access
    if (agent === undefined || access === undefined || !access.supportsFileInput()) {
      flight.fileCleanupUnconfirmed = true
      this.diag.warn('local-acp.prompt.file-receipt-retirement-unconfirmed', { key: 'prompt' })
      return false
    }
    try {
      access.cleanupStagedFiles(agent, flight.requestId, flight.stagedReceipts)
      flight.stagedReceipts = undefined
      return true
    } catch {
      flight.fileCleanupUnconfirmed = true
      this.diag.warn('local-acp.prompt.file-receipt-retirement-unconfirmed', { key: 'prompt' })
      return false
    }
  }

  private fileCleanupUnconfirmedError(): LocalAcpViewError {
    return promptError(
      'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
      'the staged file receipts could not be confirmed retired; no clean cancellation is claimed',
      JSONRPC_INTERNAL_ERROR,
      { reason: 'file-receipt-retirement-unconfirmed' },
    )
  }

  /** One synchronous exactness checkpoint between sequential uploads. */
  private filePreparationStop(
    claim: ViewClaim,
    flight: InflightPrompt,
    access: HostAcpSessionAccess,
    signal: AbortSignal,
  ): 'cancelled' | 'stale' | undefined {
    if (flight.deliveryClosed || flight.cancelRequested || signal.aborted) return 'cancelled'
    if (this.claims.get(claim.sessionId) !== claim || claim.inflight !== flight
      || claim.closing !== undefined || claim.exactAgent === undefined || claim.exactSession === undefined) {
      return 'cancelled'
    }
    if (!Object.is(access.currentAgent(claim.sessionId), claim.exactAgent)
      || !Object.is(access.currentSession(claim.sessionId), claim.exactSession)
      || claim.exactAgent.session !== claim.exactSession) {
      return 'stale'
    }
    return undefined
  }

  private staleFilePreparationError(): LocalAcpViewError {
    return promptError(
      'LOCAL_ACP_PROMPT_STALE_AGENT',
      'the borrowed Agent/Session changed while the file input was staged',
      JSONRPC_INVALID_PARAMS,
    )
  }

  /**
   * Stage every decoded blob sequentially before the ONE official Controller
   * call. Text/image parts keep their original order; each blob becomes the
   * official `{type:'file',receiptId}` only after its real upload returned.
   * This method records only the outcome and actual returned ids; the ONE file
   * admission terminal owns D4 and public settlement.
   */
  private async prepareFileContent(
    claim: ViewClaim,
    flight: InflightPrompt,
    access: HostAcpSessionAccess,
    decoded: readonly AcpDecodedPromptPart[],
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'content'; readonly content: readonly AcpPromptPart[] }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'failure'; readonly error: LocalAcpViewError }
  > {
    const content: AcpPromptPart[] = []
    const receipts: string[] = []
    flight.stagedReceipts = receipts
    flight.fileAdmissionPending = true
    const stop = (): 'cancelled' | 'stale' | undefined =>
      this.filePreparationStop(claim, flight, access, signal)
    const disposalFailure = (): { readonly kind: 'failure'; readonly error: LocalAcpViewError } | undefined => {
      if (flight.pendingDisposalFailure === undefined) return undefined
      return { kind: 'failure', error: flight.pendingDisposalFailure }
    }
    try {
      for (const part of decoded) {
        if (part.type !== 'blob') {
          content.push(part)
          continue
        }
        const disposed = disposalFailure()
        if (disposed !== undefined) {
          return disposed
        }
        const before = stop()
        if (before !== undefined) {
          return before === 'stale'
            ? { kind: 'failure', error: this.staleFilePreparationError() }
            : { kind: 'cancelled' }
        }
        const agent = claim.exactAgent
        const session = claim.exactSession
        if (agent === undefined || session === undefined) {
          return { kind: 'failure', error: this.staleFilePreparationError() }
        }
        let staged: { readonly receiptId: string }
        try {
          staged = await access.stageFile(agent, session, part.data, part.name, signal)
        } catch (error) {
          if (flight.pendingDisposalFailure !== undefined) {
            return { kind: 'failure', error: flight.pendingDisposalFailure }
          }
          if (signal.aborted || flight.cancelRequested || flight.deliveryClosed) {
            return { kind: 'cancelled' }
          }
          const hostCode = hostErrorCode(error)
          return {
            kind: 'failure',
            error: promptError(
              'LOCAL_ACP_PROMPT_HOST_REJECTED',
              'the Host did not accept the staged file input',
              JSONRPC_INTERNAL_ERROR,
              hostCode === undefined ? {} : { hostCode },
            ),
          }
        }
        // Record the REAL returned receipt immediately: a cancellation or
        // identity change after this await must still clean this exact id.
        receipts.push(staged.receiptId)
        const disposedAfter = disposalFailure()
        if (disposedAfter !== undefined) {
          return disposedAfter
        }
        const after = stop()
        if (after !== undefined) {
          return after === 'stale'
            ? { kind: 'failure', error: this.staleFilePreparationError() }
            : { kind: 'cancelled' }
        }
        content.push({ type: 'file', receiptId: staged.receiptId })
      }
      if (flight.pendingDisposalFailure !== undefined) {
        return { kind: 'failure', error: flight.pendingDisposalFailure }
      }
      if (flight.deliveryClosed || flight.cancelRequested || signal.aborted) {
        return { kind: 'cancelled' }
      }
      return { kind: 'content', content }
    } catch {
      if (flight.pendingDisposalFailure !== undefined) {
        return { kind: 'failure', error: flight.pendingDisposalFailure }
      }
      return {
        kind: 'failure',
        error: promptError(
          'LOCAL_ACP_PROMPT_HOST_REJECTED',
          'the Host did not accept the staged file input',
          JSONRPC_INTERNAL_ERROR,
        ),
      }
    }
  }


  /**
   * The ONE file-bearing admission terminal. Preparation, Skill preflight and
   * the actual Controller call only return a fact to this method; D4 and the
   * public settlement happen exactly once here.
   */
  private async admitFilePrompt(
    claim: ViewClaim,
    flight: InflightPrompt,
    access: HostAcpSessionAccess,
    request: AcpPromptSessionParams,
    requestSignal: AbortSignal,
    decodedContent: readonly AcpDecodedPromptPart[],
    skillPreflight: { readonly name: string; readonly epoch: number } | undefined,
  ): Promise<AcpPromptResult> {
    type Outcome =
      | { readonly kind: 'not-called'; readonly cancelled: true }
      | { readonly kind: 'not-called'; readonly error: LocalAcpViewError }
      | { readonly kind: 'rejected'; readonly error: unknown }
      | { readonly kind: 'accepted' }
    let called = false
    let outcome: Outcome | undefined
    const finalCheck = (): void => {
      if (claim.inflight !== flight || claim.closing !== undefined
        || flight.cancelRequested || flight.deliveryClosed) {
        throw promptError(
          'LOCAL_ACP_PROMPT_ABORTED',
          'the prompt was cancelled or closed at the final Host admission boundary',
          JSONRPC_INTERNAL_ERROR,
        )
      }
      if (flight.pendingDisposalFailure !== undefined) throw flight.pendingDisposalFailure
      if (requestSignal.aborted || claim.connectionIdentity.phase !== 'attached'
        || !Object.is(access.currentAgent(request.sessionId), claim.exactAgent)
        || !Object.is(access.currentSession(request.sessionId), claim.exactSession)) {
        throw promptError(
          'LOCAL_ACP_PROMPT_STALE_AGENT',
          'the attached Agent/Session identity changed at the final Host admission boundary',
          JSONRPC_INTERNAL_ERROR,
        )
      }
      const current = access.currentTurn(request.sessionId, claim.exactAgent!, claim.exactSession!)
      if (current.kind === 'stale') {
        throw promptError(
          'LOCAL_ACP_PROMPT_STALE_AGENT',
          'the borrowed turn identity changed at the final Host admission boundary',
          JSONRPC_INTERNAL_ERROR,
        )
      }
      if (skillPreflight !== undefined) {
        let commands: AcpCommandCatalogRead
        try {
          commands = access.readCommandCatalog(claim.exactAgent!, claim.exactSession!)
        } catch {
          throw new LocalAcpViewError(
            'LOCAL_ACP_COMMAND_UNAVAILABLE',
            'the Host command registry could not be re-read at the final Host admission boundary',
            JSONRPC_INVALID_PARAMS,
          )
        }
        if ((claim.catalogEpoch ?? 0) !== skillPreflight.epoch
          || commands.effectiveNames.includes(skillPreflight.name)) {
          throw new LocalAcpViewError(
            'LOCAL_ACP_COMMAND_STALE',
            'the advertised Skill changed at the final Host admission boundary; it was not dispatched',
            JSONRPC_INVALID_PARAMS,
          )
        }
      }
      // Re-read the SAME synchronous authority after the final catalog read;
      // no catalog call or other reentrant boundary may sit between this and
      // the actual Controller invocation.
      if (requestSignal.aborted || claim.connectionIdentity.phase !== 'attached'
        || claim.inflight !== flight || claim.closing !== undefined
        || flight.cancelRequested || flight.deliveryClosed
        || !Object.is(access.currentAgent(request.sessionId), claim.exactAgent)
        || !Object.is(access.currentSession(request.sessionId), claim.exactSession)) {
        throw promptError(
          'LOCAL_ACP_PROMPT_ABORTED',
          'the prompt authority changed after the final Skill catalog boundary',
          JSONRPC_INTERNAL_ERROR,
        )
      }
      // The actual call is now adjacent. No later local check is allowed.
      called = true
    }
    try {
      const prepared = await this.prepareFileContent(claim, flight, access, decodedContent, requestSignal)
      if (prepared.kind === 'cancelled') {
        outcome = { kind: 'not-called', cancelled: true }
      } else if (prepared.kind === 'failure') {
        outcome = { kind: 'not-called', error: prepared.error }
      } else {
        const currentAfterStaging = access.currentTurn(request.sessionId, claim.exactAgent!, claim.exactSession!)
        if (currentAfterStaging.kind === 'stale') {
          outcome = { kind: 'not-called', error: this.staleFilePreparationError() }
        } else if (claim.inflight !== flight || claim.closing !== undefined
          || flight.deliveryClosed || flight.cancelRequested) {
          outcome = { kind: 'not-called', cancelled: true }
        } else if (skillPreflight !== undefined) {
          try {
            const preflight = await this.preflightAdvertisedSkill(
              claim, flight, access, skillPreflight.name, skillPreflight.epoch,
            )
            if (preflight === 'cancelled') outcome = { kind: 'not-called', cancelled: true }
          } catch (error) {
            outcome = {
              kind: 'not-called',
              error: error instanceof LocalAcpViewError
                ? error
                : error instanceof AcpHostCommandError
                  ? this.mapHostCommandError(error)
                  : new LocalAcpViewError(
                    'LOCAL_ACP_COMMAND_UNAVAILABLE',
                    'the advertised Skill could not be revalidated before dispatch',
                    JSONRPC_INVALID_PARAMS,
                  ),
            }
          }
        }
        if (outcome === undefined) {
          await access.prompt({
            requestId: flight.requestId,
            sessionId: request.sessionId,
            mode: 'queue',
            content: prepared.content,
          }, requestSignal, finalCheck)
          outcome = { kind: 'accepted' }
        }
      }
    } catch (error) {
      if (!called) {
        outcome = flight.pendingDisposalFailure !== undefined
          ? { kind: 'not-called', error: flight.pendingDisposalFailure }
          : flight.cancelRequested || flight.deliveryClosed
            ? { kind: 'not-called', cancelled: true }
            : { kind: 'not-called', error: error instanceof LocalAcpViewError
                ? error
                : promptError(
                  'LOCAL_ACP_PROMPT_HOST_REJECTED',
                  'the Host did not accept the prompt',
                  JSONRPC_INTERNAL_ERROR,
                  hostErrorCode(error) === undefined ? {} : { hostCode: hostErrorCode(error) },
                ) }
      } else {
        outcome = { kind: 'rejected', error }
      }
    }
    if (outcome === undefined) outcome = { kind: 'accepted' }
    return await this.finishFileAdmission(claim, flight, access, request, outcome)
  }

  private async finishFileAdmission(
    claim: ViewClaim,
    flight: InflightPrompt,
    access: HostAcpSessionAccess,
    request: AcpPromptSessionParams,
    outcome:
      | { readonly kind: 'not-called'; readonly cancelled: true }
      | { readonly kind: 'not-called'; readonly error: LocalAcpViewError }
      | { readonly kind: 'rejected'; readonly error: unknown }
      | { readonly kind: 'accepted' },
  ): Promise<AcpPromptResult> {
    // A true queued removal owns the receipt terminal (D5); D4 must not retry
    // that retirement. Successful acceptance transfers authority to the
    // official message even if this View has not observed the insertion yet.
    if (outcome.kind === 'not-called') flight.definiteNoDispatch = true
    const d5Owned = flight.cancelKind === 'queued-removed'
    if (outcome.kind === 'accepted') {
      flight.stagedReceipts = undefined
    } else if (!d5Owned) {
      if (!this.cleanupPreparedFiles(claim, flight) && flight.resourceFailure === undefined) {
        flight.resourceFailure = this.fileCleanupUnconfirmedError()
      }
    }
    flight.fileAdmissionPending = false
    flight.settleAdmission()
    const saved = flight.pendingBusinessOutcome
    flight.pendingBusinessOutcome = undefined
    if (saved?.kind === 'failure') this.failPrompt(claim, flight, saved.error)
    else if (saved?.kind === 'complete') this.completePrompt(claim, flight, saved.result)
    else if (outcome.kind === 'accepted') {
      if (flight.pendingDisposalFailure !== undefined) this.failPrompt(claim, flight, flight.pendingDisposalFailure)
      else if (flight.cancelKind === 'queued-removed') {
        // settleQueuedRemoval owns the clean cancelled terminal.
      } else if (flight.messageId === undefined && flight.deliveryClosed && flight.cancelRequested) {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_ABORTED',
          'the ACP prompt request was aborted before a real Host settlement',
          JSONRPC_INTERNAL_ERROR,
        ))
      } else {
        const stillExact = Object.is(access.currentAgent(request.sessionId), claim.exactAgent)
          && Object.is(access.currentSession(request.sessionId), claim.exactSession)
        if (flight.messageId === undefined && !stillExact) {
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_STALE_AGENT',
            'the accepted prompt was not observed on the Agent generation this View attached; it was not re-dispatched',
            JSONRPC_INTERNAL_ERROR,
          ))
        } else {
          flight.phase = 'queued'
        }
      }
    } else if (outcome.kind === 'rejected') {
      if (flight.pendingDisposalFailure !== undefined) {
        this.failPrompt(claim, flight, flight.pendingDisposalFailure)
      } else if (flight.resourceFailure !== undefined && flight.messageId === undefined) {
        this.failPrompt(claim, flight, flight.resourceFailure)
      } else if (flight.messageId !== undefined) {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE',
          'the Host prompt outcome could not be confirmed after dispatch; it was not retried',
          JSONRPC_INTERNAL_ERROR,
        ))
      } else {
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_HOST_REJECTED',
          'the Host did not accept the prompt',
          JSONRPC_INTERNAL_ERROR,
          hostErrorCode(outcome.error) === undefined ? {} : { hostCode: hostErrorCode(outcome.error) },
        ))
      }
    } else if ('cancelled' in outcome && flight.pendingDisposalFailure !== undefined) {
      this.failPrompt(claim, flight, flight.pendingDisposalFailure)
    } else if ('cancelled' in outcome && flight.resourceFailure === undefined) {
      this.completePrompt(claim, flight, { stopReason: 'cancelled' })
    } else {
      this.failPrompt(claim, flight, flight.pendingDisposalFailure
        ?? flight.resourceFailure
        ?? ('error' in outcome ? outcome.error : this.fileCleanupUnconfirmedError()))
    }
    return await flight.settled.promise
  }

  async promptSession(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    request: AcpPromptSessionParams,
    requestSignal: AbortSignal,
    imageEnabled: boolean,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
    requestPermission?: (params: AcpRequestPermissionParams, options?: { readonly signal?: AbortSignal }) => Promise<AcpRequestPermissionResponse>,
    resourceInput: { readonly enabled: boolean; readonly budget: number } = { enabled: false, budget: 1024 * 1024 },
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
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_NOT_OWNED',
        'this ACP connection holds no view for that session',
        JSONRPC_RESOURCE_NOT_FOUND,
        { sessionId: request.sessionId },
      )
    }
    if (claim.replay !== undefined) {
      // A loaded View is still replaying its complete history. A new prompt is
      // refused instead of being interleaved into the replay: the client asked
      // for the whole past before any new turn.
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_BUSY',
        'the loaded session is still replaying its history',
        JSONRPC_INVALID_PARAMS,
      )
    }
    if (claim.inflight !== undefined || claim.commandOperation !== undefined
      || claim.policyWrite !== undefined
      || claim.unclaimedHostObligation !== undefined || claim.closing !== undefined) {
      // A previous accepted Prompt/command/policy write still owes a Host
      // terminal fact: the View must not stack a second responsibility on it.
      throw promptError('LOCAL_ACP_PROMPT_IN_FLIGHT', 'a prompt is already in flight for this session view', JSONRPC_INVALID_PARAMS)
    }
    const decodedContent = validatePromptContent(request.prompt, imageEnabled, resourceInput.enabled, resourceInput.budget)
    let content: readonly AcpPromptPart[] = []
    if (requestSignal.aborted) {
      throw promptError('LOCAL_ACP_PROMPT_ABORTED', 'the ACP prompt request was aborted before admission', JSONRPC_INVALID_PARAMS)
    }
    const routed = this.classifyCommandRoute(claim, access, request.prompt)
    if (routed.route.kind === 'error') {
      throw new LocalAcpViewError(routed.route.code, routed.route.message, JSONRPC_INVALID_PARAMS)
    }
    if (routed.route.kind === 'standalone' || routed.route.kind === 'compact') {
      // A retired turn is still an unresolved approval obligation. A command
      // may not start on top of it and later strand that fence on disposal.
      if (claim.retiringTurn !== undefined) {
        throw new LocalAcpViewError('LOCAL_ACP_VIEW_BUSY', 'a retired turn still awaits its terminal fact before a command can start', JSONRPC_INVALID_PARAMS)
      }
      return await this.dispatchCommand(claim, access, routed.route, requestSignal, sendUpdate)
    }
    const skillPreflight = routed.route.kind === 'skill'
      ? { name: routed.route.name, epoch: routed.epoch }
      : undefined
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

    if (decodedContent.some(part => part.type === 'blob')) {
      return await this.admitFilePrompt(
        claim, flight, access, request, requestSignal, decodedContent, skillPreflight,
      )
    }
    content = decodedContent.filter(part => part.type !== 'blob')
    if (skillPreflight !== undefined) {
      const skillAgent = claim.exactAgent
      const skillSession = claim.exactSession
      let preflight: 'ok' | 'cancelled'
      try {
        preflight = await this.preflightAdvertisedSkill(claim, flight, access, skillPreflight.name, skillPreflight.epoch)
      } catch (error) {
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.failPrompt(claim, flight, error instanceof LocalAcpViewError
          ? error
          : error instanceof AcpHostCommandError
            ? this.mapHostCommandError(error)
            : new LocalAcpViewError(
              'LOCAL_ACP_COMMAND_UNAVAILABLE',
              'the advertised Skill could not be revalidated before dispatch',
              JSONRPC_INVALID_PARAMS,
            ))
        return await flight.settled.promise
      }
      if (preflight === 'cancelled') {
        // No Host insertion exists: cleanup before the clean cancellation.
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.completePrompt(claim, flight, { stopReason: 'cancelled' })
        return await flight.settled.promise
      }
      // The preflight await may have outlived the provenance read at admission.
      const currentBeforeDispatch = access.currentTurn(request.sessionId, claim.exactAgent, claim.exactSession)
      if (currentBeforeDispatch.kind === 'stale') {
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.failPrompt(claim, flight, promptError(
          'LOCAL_ACP_PROMPT_STALE_AGENT',
          'the borrowed turn identity changed during the Skill preflight',
          JSONRPC_INVALID_PARAMS,
        ))
        return await flight.settled.promise
      }
      flight.turnProvenance = currentBeforeDispatch.openTurn === null
        ? undefined
        : {
          turn: currentBeforeDispatch.openTurn,
          origin: claim.retiringTurn?.turn === currentBeforeDispatch.openTurn ? claim.retiringTurn.origin : 'tui',
        }
      // FINAL synchronous admission: the preflight's last await is behind us.
      // No cancellation/close/epoch/shadow may slip between this check and the
      // actual official call.
      if (flight.deliveryClosed || flight.cancelRequested) {
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.completePrompt(claim, flight, { stopReason: 'cancelled' })
        return await flight.settled.promise
      }
      let finalCommands: AcpCommandCatalogRead
      try {
        finalCommands = access.readCommandCatalog(claim.exactAgent as LiveAgentViewIdentity, claim.exactSession as object)
      } catch {
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.failPrompt(claim, flight, new LocalAcpViewError(
          'LOCAL_ACP_COMMAND_UNAVAILABLE',
          'the Host command registry could not be re-read at final admission',
          JSONRPC_INVALID_PARAMS,
        ))
        return await flight.settled.promise
      }
      if (this.claims.get(claim.sessionId) !== claim || claim.inflight !== flight
        || claim.closing !== undefined || claim.commandOperation !== undefined || claim.replay !== undefined
        || claim.exactAgent !== skillAgent || claim.exactSession !== skillSession
        || (claim.catalogEpoch ?? 0) !== skillPreflight.epoch
        || finalCommands.effectiveNames.includes(skillPreflight.name)) {
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.failPrompt(claim, flight, new LocalAcpViewError(
          'LOCAL_ACP_COMMAND_STALE',
          'the advertised Skill changed at final admission; it was not dispatched',
          JSONRPC_INVALID_PARAMS,
        ))
        return await flight.settled.promise
      }
      // LAST authority read is behind us. Recheck cancellation/closed
      // immediately adjacent to dispatch, after the catalog read.
      if (flight.deliveryClosed || flight.cancelRequested) {
        flight.definiteNoDispatch = true
        flight.settleAdmission()
        this.completePrompt(claim, flight, { stopReason: 'cancelled' })
        return await flight.settled.promise
      }
    }

    try {
      await access.prompt({
        requestId: flight.requestId,
        sessionId: request.sessionId,
        mode: 'queue',
        content,
      }, requestSignal)
      if (!flight.settledDone) {
        const stillExact = Object.is(access.currentAgent(request.sessionId), claim.exactAgent)
          && Object.is(access.currentSession(request.sessionId), claim.exactSession)
        if (flight.messageId === undefined && !stillExact) {
          this.failPrompt(claim, flight, promptError(
            'LOCAL_ACP_PROMPT_STALE_AGENT',
            'the accepted prompt was not observed on the Agent generation this View attached; it was not re-dispatched',
            JSONRPC_INTERNAL_ERROR,
          ))
        } else if (flight.messageId === undefined && flight.deliveryClosed && flight.cancelRequested) {
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
          if (removed === 'removed') {
            this.retireRemovedPrompt(claim, obligation.requestId)
            this.dropUnclaimedObligation(claim)
          }
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
   * Record the exact compact facts of THIS operation before any projection
   * callback runs. The start is captured only inside the synchronous dispatch
   * window; every later fact must carry the SAME operation's compactionId.
   */
  private observeCommandSessionEvent(claim: ViewClaim, event: AcpSessionEventLike): void {
    const op = claim.commandOperation
    if (op === undefined || op.kind !== 'compact') return
    const data = event.data as {
      readonly compactionId?: unknown
      readonly sourceCommandId?: unknown
      readonly turn?: unknown
      readonly error?: unknown
      readonly source?: { readonly kind?: unknown; readonly compactionId?: unknown }
    } | undefined
    if (event.type === 'compaction/start') {
      if (typeof data?.compactionId !== 'string' || data.turn !== null || data.sourceCommandId !== undefined) return
      if (op.compactionId === undefined) {
        // Only the synchronous dispatch window may establish the identity.
        if (!op.dispatching) return
        op.compactionId = data.compactionId
        op.startSeq = event.seq
        return
      }
      if (data.compactionId !== op.compactionId) op.factConflict = true
      return
    }
    if (op.compactionId === undefined) return
    if (event.type === 'compaction/summary') {
      if (typeof data?.compactionId !== 'string' || data.compactionId !== op.compactionId
        || op.startSeq === undefined || event.seq <= op.startSeq) {
        op.factConflict = true
        return
      }
      if (op.summarySeq === undefined) op.summarySeq = event.seq
      else if (op.summarySeq !== event.seq) op.factConflict = true
      return
    }
    if (event.type === 'compaction/end') {
      if (typeof data?.compactionId !== 'string' || data.compactionId !== op.compactionId
        || op.startSeq === undefined || event.seq <= (op.summarySeq ?? op.startSeq)) {
        op.factConflict = true
        return
      }
      if (op.endSeq === undefined) {
        op.endSeq = event.seq
        op.endError = typeof data.error === 'string' ? data.error : undefined
      } else if (op.endSeq !== event.seq) {
        op.factConflict = true
      }
      return
    }
    if (event.type === 'user/message'
      && data?.source?.kind === 'compact-checkpoint'
      && data.source.compactionId === op.compactionId) {
      op.checkpointSeen = true
    }
  }

  /**
   * One committed Session event. Only the exact Session object and the owned
   * turn are projected; every other event is inert for this View.
   */
  onSessionEvent(session: object, event: AcpSessionEventLike): void {
    for (const claim of this.claims.values()) {
      if (claim.exactSession !== session) continue
      // The command facts are recorded FIRST: a compaction start/summary/end
      // can be published synchronously inside the official call before the
      // read-only projection task is queued, and every later classification
      // must see them even when the projection sink is absent or stalled.
      this.observeCommandSessionEvent(claim, event)
      if (event.type === 'working-directory/change' || event.type === 'agent-preset/selected') {
        this.invalidateCatalog(claim)
      }
      // Every committed source that can change the session policy/config
      // projection re-reads the authority on this claim's single ordered
      // notification chain. The EVENT payload is never the new ACP state.
      if (event.type === 'model/selection' || event.type === 'plan/mode'
        || event.type === 'team/mode' || event.type === 'team/task'
        || event.type === 'agent-preset/selected') {
        this.invalidateConfig(claim)
      }
      // The read-only projection branch is INDEPENDENT of any prompt flight: a
      // TUI/Goal turn's plan, title, usage, compaction and agent message are
      // projected too, while its assistant output stays out of this View's
      // flight (never a second answer to an ACP prompt). During a load replay
      // the same branch buffers by seq behind the canonical snapshot.
      const command = claim.commandOperation
      const own = command !== undefined && command.kind === 'compact'
        && (event.type === 'compaction/start' || event.type === 'compaction/summary' || event.type === 'compaction/end')
        && command.compactionId !== undefined
        && (event.data as { readonly compactionId?: unknown } | undefined)?.compactionId === command.compactionId
        ? { eventType: event.type, receipt: { delivered: false }, task: undefined as Promise<void> | undefined }
        : undefined
      const projection = this.observeSessionProjection(claim, event, own?.receipt)
      if (own !== undefined && projection !== undefined && command !== undefined) {
        own.task = projection
        command.ownFrames.push(own as AcpOwnedFrame)
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
   * Invalidate the config projection of one claim and coalesce a refresh on its
   * single ordered notification chain. The chain is transient and per claim: a
   * close/re-bind/teardown clears the callback, a late read never reaches a
   * newer View, and a delivery failure retires only this callback.
   */
  private invalidateConfig(claim: ViewClaim): void {
    claim.configEpoch = (claim.configEpoch ?? 0) + 1
    this.enqueueConfigUpdate(claim)
  }

  private enqueueConfigUpdate(claim: ViewClaim): void {
    if (claim.notifyConfigUpdate === undefined) return
    claim.configDirty = true
    // No frame may precede the initial attach snapshot, and a load replay owns
    // the ordered output until its canonical history drained: keep the dirty
    // bit and start on the real initial/replay terminal.
    if ((claim.configReplyBarrier ?? 0) > 0) return
    if (claim.configReady !== true || claim.replay !== undefined) return
    if (claim.configRefreshRunning === true) return
    claim.configRefreshRunning = true
    const previous = claim.configNotifyTail ?? Promise.resolve()
    const next = previous.then(async () => {
      try {
        // Bounded coalescing: a still-moving authority is left to the NEXT real
        // invalidation instead of an unbounded read loop.
        for (let pass = 0; claim.configDirty === true && pass < 2; pass++) {
          claim.configDirty = false
          if (!this.configSinkCurrent(claim)) return
          await this.refreshConfig(claim)
        }
      } finally {
        claim.configRefreshRunning = false
        // An invalidation that arrived during the LAST awaited read/send is
        // still authoritative: never clear it, and never leave it without a
        // next ordered pass. A non-current sink is a no-op in enqueue.
        if (claim.configDirty === true) this.enqueueConfigUpdate(claim)
      }
    }).catch(() => {})
    claim.configNotifyTail = next
  }

  /** Whether this claim still owns a live config notification sink. */
  private configSinkCurrent(claim: ViewClaim): boolean {
    return claim.notifyConfigUpdate !== undefined
      && this.claims.get(claim.sessionId) === claim
      && claim.connectionIdentity.phase === 'attached'
      && !claim.detachedWithFence
      && claim.configReady === true
      && claim.replay === undefined
      && claim.exactAgent !== undefined
      && claim.exactSession !== undefined
  }

  /**
   * ONE complete notification refresh: the legacy mode change first (it never
   * depends on the model catalog), then the full fixed-order config list.
   * A model-catalog failure keeps the previously delivered list; a newer
   * invalidation makes this read stale instead of overwriting it.
   */
  private async refreshConfig(claim: ViewClaim): Promise<void> {
    const access = this.access
    const agent = claim.exactAgent
    const session = claim.exactSession
    const notify = claim.notifyConfigUpdate
    if (access === undefined || agent === undefined || session === undefined || notify === undefined) return
    if (claim.configReady !== true || claim.replay !== undefined) return
    // The legacy committed mode is independent of the model catalog and the
    // unrelated Team projection: read and deliver it BEFORE provider I/O.
    if (claim.legacyModeAnnounced === true) {
      try {
        const mode = access.readSessionMode(agent, session)
        if (mode !== undefined && claim.lastLegacyMode !== mode) {
          if (!await this.sendConfigUpdate(claim, notify, claim.configEpoch ?? 0, {
            kind: 'mode', currentModeId: wireModeId(mode),
          })) return
          claim.lastLegacyMode = mode
        }
      } catch {
        // A narrow mode read failure leaves the full cut to retry/recover; it
        // never fabricates absence or blocks a readable mode on a later event.
      }
    }
    let cut: AcpConfigCut
    try {
      cut = await this.readConfigSnapshotFenced(claim, access, 'refresh')
    } catch {
      // A live failed/unstable read never replaces a delivered list. Keep the
      // last complete projection; a later real invalidation retries.
      return
    }
    const { snapshot, epoch } = cut
    if (!this.configSinkCurrent(claim) || claim.notifyConfigUpdate !== notify) return
    // A mode change is delivered BEFORE the full list on the same ordered chain.
    if (claim.legacyModeAnnounced === true && snapshot.mode !== undefined && claim.lastLegacyMode !== snapshot.mode) {
      if (!await this.sendConfigUpdate(claim, notify, epoch, { kind: 'mode', currentModeId: wireModeId(snapshot.mode) })) return
      claim.lastLegacyMode = snapshot.mode
    }
    if (snapshot.configOptions === undefined) return
    await this.sendConfigUpdate(claim, notify, epoch, {
      kind: 'config',
      configOptions: [...snapshot.configOptions],
    })
  }

  /**
   * One wire send on the claim's own sink. The exact claim, current epoch and
   * bound sink are re-checked immediately before submission; a cut invalidated
   * by a close/replacement/newer event is discarded (never a stale frame).
   */
  private async sendConfigUpdate(
    claim: ViewClaim,
    notify: AcpConfigUpdateNotifier,
    epoch: number,
    update: AcpConfigUpdate,
  ): Promise<boolean> {
    if (!this.configSinkCurrent(claim) || claim.notifyConfigUpdate !== notify
      || (claim.configEpoch ?? 0) !== epoch) return false
    if ((claim.configReplyBarrier ?? 0) > 0) {
      claim.configDirty = true
      return false
    }
    try {
      await notify(claim.sessionId, update)
      return true
    } catch {
      if (claim.notifyConfigUpdate === notify) claim.notifyConfigUpdate = undefined
      return false
    }
  }

  /**
   * A discard only triggers verification: edit/steer can reinsert the same id
   * within the current synchronous Host mutation. Cross it once, then read the
   * official pending projection and the CURRENT responsibility of this claim.
   */
  /** The official idempotent retirement of one actually removed request's receipts. */
  private retireRemovedPrompt(claim: ViewClaim, requestId: string): boolean {
    const access = this.access
    const agent = claim.exactAgent
    if (access === undefined || agent === undefined) return false
    if (!access.supportsFileInput()) return true
    try {
      access.retirePromptReceipts(agent, requestId)
      return true
    } catch {
      this.diag.warn('local-acp.prompt.file-receipt-retirement-unconfirmed', { key: 'prompt' })
      return false
    }
  }

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
          if (!this.retireRemovedPrompt(claim, flight.requestId)) {
            flight.resourceFailure ??= this.fileCleanupUnconfirmedError()
            this.failOrDeferAdmission(claim, flight, flight.resourceFailure)
            return
          }
          flight.stagedReceipts = undefined
          this.settleQueuedRemoval(claim, flight)
        } else if (obligation?.messageId === messageId) {
          this.retireRemovedPrompt(claim, obligation.requestId)
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
      // The exact owning Cordis scope is being destroyed: its official effect
      // disposal is the contribution's terminal, so no separate disposer call is
      // fabricated here. The responsibility is cleared before any release path.
      const append = claim.systemPromptAppend
      if (append !== undefined) {
        append.active = false
        append.committed = false
        claim.systemPromptAppend = undefined
      }
      // The disposed Agent can neither ask nor accept an answer any more: every
      // reverse Form of this claim and its read-only projection end here.
      this.stopProjectionOutput(claim)
      this.releaseQuestionForms(claim)
      const policy = claim.policyWrite
      if (policy !== undefined) {
        // The official policy call is still the terminal, even when the Agent
        // was disposed: wait for that exact settlement, never fabricate it.
        claim.notifyConfigUpdate = undefined
        claim.detachedWithFence = true
        if (claim.connectionIdentity.phase !== 'closed') claim.connectionIdentity.phase = 'idle'
        runDetached('local acp: disposed policy terminal', async () => {
          await policy
          if (this.claims.get(claim.sessionId) !== claim) return
          if (claim.mcpLease !== undefined && this.access !== undefined) this.requestMcpRetire(claim, this.access)
          if (claim.policyWrite !== undefined || claim.commandOperation !== undefined || claim.inflight !== undefined
            || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
            || claim.mcpLease !== undefined || claim.mcpMountPending === true
            || claim.systemPromptAppend !== undefined) {
            claim.detachedWithFence = true
            this.notifyWorkSettled()
            return
          }
          this.claims.delete(claim.sessionId)
          this.notifyWorkSettled()
        }, { diag: this.diag })
        continue
      }
      const command = claim.commandOperation
      if (command !== undefined) {
        // The disposed Agent's own cancellation is an INDEPENDENT Host signal;
        // the ACP compact controller is only an additional scoped intent. The
        // original operation Promise remains the terminal, so the exact lease
        // is not retired before it settles and no replacement Agent is used.
        claim.retiringTurn = undefined
        this.abandonCommandDelivery(command)
        this.requestCommandCancel(claim, command)
        claim.detachedWithFence = true
        if (claim.connectionIdentity.phase !== 'closed') claim.connectionIdentity.phase = 'idle'
        runDetached('local acp: disposed command terminal', async () => {
          await command.completion.promise
          if (this.claims.get(claim.sessionId) !== claim) return
          if (claim.mcpLease !== undefined && this.access !== undefined) this.requestMcpRetire(claim, this.access)
          if (claim.commandOperation !== undefined || claim.inflight !== undefined
            || claim.policyWrite !== undefined
            || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
            || claim.mcpLease !== undefined || claim.mcpMountPending === true
            || claim.systemPromptAppend !== undefined) {
            claim.detachedWithFence = true
            this.notifyWorkSettled()
            return
          }
          this.claims.delete(claim.sessionId)
          this.notifyWorkSettled()
        }, { diag: this.diag })
        continue
      }
      const flight = claim.inflight
      if (flight !== undefined && !flight.settledDone
        && flight.fileAdmissionPending === true) {
        // The real upload is already in flight. Do not settle the ACP request
        // before that Promise returns and its receipt is cleaned: record the
        // disposal terminal, stop delivery/currentness, and let the staging
        // loop observe it after the real upload settles.
        flight.pendingDisposalFailure = promptError(
          'LOCAL_ACP_PROMPT_TURN_FAILED',
          'the owned Agent was disposed while the file input was being staged',
          JSONRPC_INTERNAL_ERROR,
          { reason: 'agent-disposed' },
        )
        flight.ownTurnEnded = true
        flight.cancelRequested = true
        flight.deliveryClosed = true
        this.stopFlightOutput(flight)
        claim.detachedWithFence = true
        if (claim.connectionIdentity.phase !== 'closed') claim.connectionIdentity.phase = 'idle'
        if (claim.mcpMountPending === true) claim.mcpRetireRequested = true
        claim.mcpMountAbort?.abort()
        if (claim.mcpLease !== undefined && this.access !== undefined) this.requestMcpRetire(claim, this.access)
        // Disposal also ends the dead retired-turn fence and any unclaimed
        // obligation; a disposed Agent can never reach their turn/end.
        if (claim.unclaimedHostObligation !== undefined) this.dropUnclaimedObligation(claim)
        this.endRetiringFence(claim.sessionId, claim)
        const settled = flight.settled.promise
        runDetached('local acp: disposed file preparation terminal', async () => {
          await settled.catch(() => {})
          if (this.claims.get(claim.sessionId) !== claim) return
          if (claim.inflight !== undefined || claim.retiringTurn !== undefined
            || claim.unclaimedHostObligation !== undefined || claim.policyWrite !== undefined
            || claim.commandOperation !== undefined || claim.mcpLease !== undefined || claim.mcpMountPending === true) {
            claim.detachedWithFence = true
            this.notifyWorkSettled()
            return
          }
          this.claims.delete(claim.sessionId)
          this.notifyWorkSettled()
        }, { diag: this.diag })
        continue
      }
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
      // EOF/Off/replacement loses the ACP contribution immediately; its exact
      // retirement settles independently of the Host obligation fences below.
      this.retireSystemPromptAppend(claim)
      // A physical teardown/Off/replacement ends this connection's notification
      // capability, every reverse Form/continued obligation and every queued
      // read-only projection immediately, even when the claim survives for a
      // fence fact. The Host's own durable `userQuestions` projection is never
      // touched.
      claim.notifyConfigUpdate = undefined
      this.stopProjectionOutput(claim)
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
      const policy = claim.policyWrite
      if (policy !== undefined) {
        // A transport close is not a policy-write cancellation: keep the exact
        // claim fenced until the original official call reaches its terminal,
        // then retire the scoped lease and release only proven work.
        claim.detachedWithFence = true
        runDetached('local acp: policy disconnect', async () => {
          await policy
          if (this.claims.get(sessionId) !== claim) return
          if (claim.mcpLease !== undefined && bound !== undefined) this.requestMcpRetire(claim, bound)
          if (claim.policyWrite !== undefined || claim.commandOperation !== undefined || claim.inflight !== undefined
            || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
            || claim.mcpLease !== undefined || claim.mcpMountPending === true
            || claim.systemPromptAppend !== undefined) {
            claim.detachedWithFence = true
            this.notifyWorkSettled()
            return
          }
          this.claims.delete(sessionId)
          this.notifyWorkSettled()
        }, { diag: this.diag })
        continue
      }
      const command = claim.commandOperation
      if (command !== undefined) {
        // A command owns the shared Session lease until its ORIGINAL execution
        // Promise settles. EOF/Off must not retire scoped MCP or release the
        // claim first; the observer stays installed and the exact operation is
        // still cancellable after delivery closed.
        this.abandonCommandDelivery(command)
        this.requestCommandCancel(claim, command)
        runDetached('local acp: command disconnect', async () => {
          await command.completion.promise
          if (this.claims.get(sessionId) !== claim) return
          if (claim.mcpLease !== undefined && bound !== undefined) {
            this.requestMcpRetire(claim, bound)
          }
          if (claim.commandOperation !== undefined || claim.inflight !== undefined
            || claim.policyWrite !== undefined
            || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
            || claim.mcpLease !== undefined || claim.mcpMountPending === true
            || claim.systemPromptAppend !== undefined) {
            claim.detachedWithFence = true
            this.notifyWorkSettled()
            return
          }
          this.claims.delete(sessionId)
          this.notifyWorkSettled()
        }, { diag: this.diag })
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
            || claim.policyWrite !== undefined
            || claim.mcpLease !== undefined || claim.mcpMountPending === true
            || claim.systemPromptAppend !== undefined) {
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
          if (!this.retireRemovedPrompt(claim, obligation.requestId)) {
            claim.detachedWithFence = true
          }
          this.dropUnclaimedObligation(claim)
        }
      }
      if (claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
        || claim.policyWrite !== undefined
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
    if (claim.retiringTurn !== undefined || claim.commandOperation !== undefined
      || claim.unclaimedHostObligation !== undefined || claim.policyWrite !== undefined
      || claim.mcpLease !== undefined || claim.mcpMountPending === true
      || claim.systemPromptAppend !== undefined) {
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
    if (claim.commandOperation !== undefined || claim.policyWrite !== undefined
      || claim.mcpLease !== undefined || claim.mcpMountPending === true
      || claim.systemPromptAppend !== undefined) {
      claim.detachedWithFence = true
      this.notifyWorkSettled()
      return
    }
    if (this.claims.get(sessionId) === claim) this.claims.delete(sessionId)
    this.notifyWorkSettled()
  }

  /**
   * The exact settled claim this connection owns, for a same-connection
   * reattach. A state that still owns ANY Host obligation refuses the
   * replacement: a prompt flight, command/policy write, retiring turn, unclaimed
   * obligation, joined close, open replay, MCP mount/retire/lease, or an open
   * reverse Form / unresolved continued question is never released, cancelled
   * or silently dropped by a reattach.
   *
   * The exact live Agent/Session identity is verified in the SAME synchronous
   * stack as this call, immediately before the caller invokes the official
   * resolver once; a lost identity fails closed instead of cold-resurrecting a
   * different Agent under this reattach.
   */
  private reattachClaim(
    state: ConnectionViewState,
    access: HostAcpSessionAccess,
    sessionId: string,
  ): ViewClaim {
    if (state.phase === 'closed') {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_CLOSED', 'the ACP connection is closed', JSONRPC_INVALID_PARAMS)
    }
    const claim = this.claims.get(sessionId)
    // NOT_OWNED is reserved for a Session this connection holds NO claim for.
    // An owned claim in ANY other state (attaching, a held terminal fence, or an
    // attached generation without its verified identities) is a TRANSIENT
    // refusal, never the standard not-active class: the client could otherwise
    // drop its local Session state for a View that is still alive on this
    // connection.
    if (claim === undefined || claim.connectionIdentity !== state) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_NOT_OWNED',
        'this ACP connection holds no view for that session',
        JSONRPC_RESOURCE_NOT_FOUND,
        { sessionId },
      )
    }
    if (claim.detachedWithFence === true) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_BUSY',
        'the session view is still retiring its Host obligations',
        JSONRPC_INVALID_PARAMS,
      )
    }
    if (state.phase !== 'attached' || claim.exactAgent === undefined || claim.exactSession === undefined) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_BUSY',
        'the session view is not a settled attached generation',
        JSONRPC_INVALID_PARAMS,
      )
    }
    if (claim.inflight !== undefined || claim.commandOperation !== undefined || claim.policyWrite !== undefined
      || claim.retiringTurn !== undefined || claim.unclaimedHostObligation !== undefined
      || claim.closing !== undefined || claim.replay !== undefined
      || claim.mcpMountPending === true || claim.mcpRetireRequested === true || claim.mcpLease !== undefined
      || (claim.questionForms?.size ?? 0) > 0 || (claim.continuedQuestions?.size ?? 0) > 0) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_BUSY',
        'the session view still owns unsettled ACP work',
        JSONRPC_INVALID_PARAMS,
      )
    }
    if (!Object.is(access.currentAgent(sessionId), claim.exactAgent)
      || !Object.is(access.currentSession(sessionId), claim.exactSession)) {
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE',
        'the attached session agent is no longer the live Host agent',
        JSONRPC_INTERNAL_ERROR,
        { sessionId },
      )
    }
    return claim
  }

  /**
   * Retire the exact fresh claim generation a same-connection reattach just
   * committed when its post-attach phase fails or the request is aborted.
   *
   * Identity is the connection's current claim for that exact Session plus the
   * listener's exclusive refresh marker (no newer generation can exist while
   * the refresh owns the slot), so a claim this request did not create — a
   * concurrent close's fence, another connection's View — is never touched.
   * Only connection-local resources are dropped: no Host Session/Agent/Writer
   * operation, cancellation or close is performed, and the connection returns
   * to idle so a later ordinary attach can proceed.
   */
  retireFailedRefresh(state: ConnectionViewState, sessionId: string): void {
    const claim = this.claims.get(sessionId)
    if (claim === undefined || claim.connectionIdentity !== state) return
    this.retireClaimGeneration(state, claim)
  }

  /**
   * Retire ONE exact fresh claim generation (a reattach's post-attach failure or
   * its request cancellation). The claim identity is re-checked, so a claim
   * this request did not create — a concurrent close's fence, another
   * connection's View, a newer generation — is never touched. A held Host
   * obligation keeps its own fence/terminal retirement.
   */
  private retireClaimGeneration(state: ConnectionViewState, claim: ViewClaim): void {
    if (this.claims.get(claim.sessionId) !== claim || claim.detachedWithFence === true) return
    this.retireSystemPromptAppend(claim)
    claim.notifyConfigUpdate = undefined
    this.stopProjectionOutput(claim)
    this.releaseQuestionForms(claim)
    this.claims.delete(claim.sessionId)
    // A cancellation can land while the fresh claim is still ATTACHING (the
    // official resolve is a real Host await): the connection must return to
    // idle in that phase too, otherwise the listener's slot release and the
    // eight-slot budget would leak an orphaned View. `closed` keeps its own
    // teardown owner.
    if (state.phase === 'attaching' || state.phase === 'attached') state.phase = 'idle'
    this.notifyWorkSettled()
  }

  /**
   * Wire ONE reattach request's real cancellation into its exact fresh claim
   * generation for the request's whole lifetime: the SDK aborts this signal on
   * `$/cancel_request`, and that abort stops the uncommitted read-only output
   * (replay/Store reads), invalidates the async result and retires only this
   * generation — never the old claim and never a Host cancel/close/dispose.
   * The watcher is created AFTER the fresh claim is committed (a pre-admission
   * abort never reaches it) and dies with the request signal.
   */
  private watchRefreshAbort(state: ConnectionViewState, claim: ViewClaim, signal?: AbortSignal): void {
    if (signal === undefined) return
    signal.addEventListener('abort', () => { this.retireClaimGeneration(state, claim) }, { once: true })
  }

  /**
   * Commit ONE fresh claim generation for a held Session in a single synchronous
   * stack: the new reservation and op become current BEFORE the outgoing
   * generation's config sink, read-only output, read IO and reverse Forms are
   * retired, so no reentrant callback can observe two owners or deliver into the
   * replaced generation. The old claim object is never current again.
   */
  private replaceClaim(state: ConnectionViewState, previous: ViewClaim): ViewClaim {
    state.op += 1
    state.phase = 'attaching'
    const claim: ViewClaim = {
      connectionIdentity: state,
      sessionId: previous.sessionId,
      readAbort: new AbortController(),
    }
    this.claims.set(previous.sessionId, claim)
    // The fresh generation is current BEFORE the outgoing contribution becomes
    // invisible: the provider is failed closed first, then its exact disposer is
    // invoked. A failed retirement never lets the outgoing generation return.
    this.retireSystemPromptAppend(previous)
    previous.notifyConfigUpdate = undefined
    this.stopProjectionOutput(previous)
    this.releaseQuestionForms(previous)
    return claim
  }

  /**
   * Reattach dispatch gate: `replaceClaim` has just retired the outgoing
   * generation's read callbacks; the official resolver is cold-capable, so the
   * captured live identity must be re-proved in the SAME synchronous stack
   * BEFORE dispatch. A retirement callback that rolled the Agent/Session over,
   * a concurrent close/fence, or an already-aborted request must fail closed
   * here — never reach the resolver and never resurrect the old generation.
   * The cancellation case also covers an abort that arrived before the abort
   * watcher was registered (`addEventListener` does not replay it).
   */
  private admitRefreshDispatch(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    previous: ViewClaim,
    access: HostAcpSessionAccess,
    requestSignal?: AbortSignal,
  ): void {
    if (requestSignal?.aborted === true) {
      this.releaseReservation(state, claim)
      this.resetIdleIfCurrent(state, op)
      requestSignal.throwIfAborted()
    }
    const current = this.claims.get(claim.sessionId) === claim
      && claim.connectionIdentity === state
      && this.isCurrentOp(state, op)
      && claim.detachedWithFence !== true
    if (!current) {
      // A concurrent close/cancel already owns this fresh generation's phase.
      throw new LocalAcpViewError(
        'LOCAL_ACP_VIEW_CLOSED',
        'the ACP view was released before it attached',
        JSONRPC_INVALID_PARAMS,
        { sessionId: claim.sessionId },
      )
    }
    const capturedAgent = previous.exactAgent
    const capturedSession = previous.exactSession
    const exact = capturedAgent !== undefined && capturedSession !== undefined
      && Object.is(access.currentAgent(claim.sessionId), capturedAgent)
      && Object.is(access.currentSession(claim.sessionId), capturedSession)
      && Object.is(capturedAgent.session, capturedSession)
    if (exact) return
    this.releaseReservation(state, claim)
    this.resetIdleIfCurrent(state, op)
    throw new LocalAcpViewError(
      'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE',
      'the attached session agent is no longer the live Host agent',
      JSONRPC_INTERNAL_ERROR,
      { sessionId: claim.sessionId },
    )
  }

  /**
   * A reattach is a refresh of the SAME borrowed Host Owner: the official
   * resolver's result must be the EXACT captured Agent AND its captured
   * Session, otherwise only this fresh reservation is released and the old
   * generation is never resurrected. `commitAttached` still proves that exact
   * pair is the CURRENT Host identity before the View becomes attached.
   */
  private requireSameGeneration(
    state: ConnectionViewState,
    op: number,
    claim: ViewClaim,
    previous: ViewClaim,
    agent: LiveAgentViewIdentity,
  ): void {
    if (Object.is(agent, previous.exactAgent) && Object.is(agent.session, previous.exactSession)) return
    this.releaseReservation(state, claim)
    this.resetIdleIfCurrent(state, op)
    throw new LocalAcpViewError(
      'LOCAL_ACP_VIEW_AGENT_UNAVAILABLE',
      'the attached session agent is no longer the live Host agent',
      JSONRPC_INTERNAL_ERROR,
      { sessionId: claim.sessionId },
    )
  }

  /** The ONE refusal of an MCP declaration on a same-connection reattach. */
  private reattachMcpRefused(): LocalAcpViewError {
    return new LocalAcpViewError(
      'LOCAL_ACP_VIEW_BUSY',
      'a reattached session view cannot declare MCP servers; close it and attach again',
      JSONRPC_INVALID_PARAMS,
    )
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
    // View becomes attached, so no model/selection event, owned question or
    // read-only projection can slip between attach and wiring. The negotiated
    // capabilities were frozen at `initialize`, never re-read per attach.
    claim.notifyConfigUpdate = channels?.notifyConfigUpdate
    claim.requestElicitation = channels?.requestElicitation
    claim.notifyProjection = channels?.notifyProjection
    claim.capabilities = channels?.capabilities
    claim.maxOutputFrameBytes = channels?.maxOutputFrameBytes
    // Every new View starts with a fresh complete catalog. The first read is
    // scheduled after the attach/load barrier, never from a previous claim.
    claim.catalogEpoch = 0
    claim.catalogDirty = claim.notifyProjection !== undefined
    // Config state is fresh per View: no previous claim's delivered list or
    // legacy mode id may leak into this one.
    claim.configEpoch = 0
    claim.configDirty = false
    claim.configRefreshRunning = false
    claim.configReady = false
    claim.legacyModeAnnounced = false
    claim.lastLegacyMode = undefined
    // The validated append contribution becomes model-visible only together with
    // this exact committed generation; a reentrant retirement already cleared it.
    if (claim.systemPromptAppend !== undefined) claim.systemPromptAppend.committed = true
  }

  /**
   * Remove ONE exact reservation. Identity is by the CLAIM OBJECT (and its
   * owning connection), never by `sessionId` alone: a close-then-re-attach of
   * the SAME Session produces a NEW claim for the same connection+sessionId, so
   * a stale operation's late release must not delete the newer claim.
   */
  private releaseReservation(state: ConnectionViewState, claim: ViewClaim): void {
    this.retireSystemPromptAppend(claim)
    if (claim.commandOperation !== undefined || claim.policyWrite !== undefined
      || claim.mcpMountPending === true || claim.mcpLease !== undefined) {
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
    this.retireSystemPromptAppend(claim)
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
    // entries are the never-streamed durable images/files; an attempt that
    // delivered nothing still falls back to the whole committed projection.
    const residualEntries = attempt.hasSent()
      ? content.entries.filter(entry => entry.kind === 'message-image' || entry.kind === 'message-file')
      : content.entries
    const residual = residualEntries.length
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
        residualEntries,
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
    const files: AcpStoredFileRef[] = []
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
      if (type === 'file') {
        const ref = fileAttachmentRef(block)
        if (ref === undefined) {
          this.failPrompt(claim, flight, unsupportedContent())
          return undefined
        }
        entries.push({ kind: 'message-file', ref })
        files.push(ref)
        continue
      }
      if (type === 'tool-call') {
        // The official `assistant/message` carries its tool-call blocks AND
        // the Host appends each of them as its OWN durable `tool/call` event;
        // the dedicated event (with the real callId/name) is the projection
        // source, so the block here is skipped instead of duplicated.
        continue
      }
      // Audio/tool-change/unknown blocks have no standard ACP output form:
      // never truncate or fake one, and never claim the event was delivered.
      this.failPrompt(claim, flight, unsupportedContent())
      return undefined
    }
    // ONE event equals ONE materialization budget, checked synchronously
    // before this event's Store reads are queued. Each committed assistant
    // block is its own ACP chunk, so only each blob (not their sum) must fit
    // one JS string.
    try {
      assertFileBudget(files, claim.maxOutputFrameBytes, false)
    } catch {
      this.failPrompt(claim, flight, outputFrameTooLarge())
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
    if (entries.every(entry => entry.kind !== 'message-image' && entry.kind !== 'message-file')) {
      this.enqueueOutputTask(claim, flight, entries.length, (): readonly SessionUpdate[] =>
        committedTextUpdates(messageId, entries))
      return
    }
    this.enqueueOutputTask(claim, flight, entries.length, async () =>
      await this.committedUpdates(flight, messageId, entries))
  }

  /** Convert committed entries to standard updates, reading attachments through the Host Store. */
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
      } else if (entry.kind === 'message-file') {
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: await this.readOutputFile(flight, entry.ref),
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
    const files: AcpStoredFileRef[] = []
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
      if (type === 'file') {
        const ref = fileAttachmentRef(block)
        if (ref === undefined) {
          this.failPrompt(claim, flight, unsupportedContent())
          return
        }
        entries.push({ kind: 'tool-file', ref })
        files.push(ref)
        continue
      }
      this.failPrompt(claim, flight, unsupportedContent())
      return
    }
    // The whole tool result is ONE ACP update for the materialization budget
    // and is refused BEFORE any of its Store reads starts; its blobs must share
    // one JSON string as well as fit the frame budget.
    try {
      assertFileBudget(files, claim.maxOutputFrameBytes, true)
    } catch {
      this.failPrompt(claim, flight, outputFrameTooLarge())
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
        } else if (entry.kind === 'tool-file') {
          content.push({ type: 'content', content: await this.readOutputFile(flight, entry.ref) })
        }
      }
      const update: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId, status, content }
      return [update]
    }
    if (entries.every(entry => entry.kind !== 'tool-image' && entry.kind !== 'tool-file')) {
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
   * Read ONE committed generic file through the official Host Attachment Store
   * and convert it to the standard embedded `resource` block. Every Store
   * rejection (missing object, unsupported provider, corrupt/incomplete bytes)
   * keeps the ONE stable attachment-read content class.
   */
  private async readOutputFile(flight: InflightPrompt, ref: AcpStoredFileRef): Promise<AcpWireContentBlock> {
    const access = this.access
    if (access === undefined) throw attachmentReadFailed()
    try {
      const bytes = await readVerifiedFileBytes(access.readOutputFile(ref, flight.outputSignal), ref, flight.outputSignal)
      return fileResourceBlock(ref, bytes)
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

  /** Defer a no-dispatch failure until the actual admission Promise settles. */
  private failOrDeferAdmission(claim: ViewClaim, flight: InflightPrompt, error: LocalAcpViewError): void {
    if (!flight.settledDone && flight.fileAdmissionPending === true) {
      flight.pendingDisposalFailure ??= error
      flight.cancelRequested = true
      flight.deliveryClosed = true
      this.stopFlightOutput(flight)
      return
    }
    this.failPrompt(claim, flight, error)
  }

  /** Fail one flight exactly once and release its slot and correlation state. */
  private failPrompt(claim: ViewClaim, flight: InflightPrompt, error: LocalAcpViewError): void {
    if (flight.settledDone) return
    if (flight.fileAdmissionPending === true && !flight.admissionSettled) {
      flight.pendingBusinessOutcome ??= { kind: 'failure', error }
      flight.deliveryClosed = true
      this.stopFlightOutput(flight)
      this.abortPermissionRequests(flight)
      return
    }
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
    if (flight.fileAdmissionPending === true && !flight.admissionSettled) {
      flight.pendingBusinessOutcome ??= { kind: 'complete', result }
      flight.deliveryClosed = true
      this.stopFlightOutput(flight)
      this.abortPermissionRequests(flight)
      return
    }
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

  private validateNew(request: AcpNewSessionParams, systemPromptCapable: boolean): string | undefined {
    const append = normalizeSystemPromptAppend(request.systemPrompt, systemPromptCapable)
    validateCwd(request.cwd)
    // The complete MCP declaration list is validated BEFORE any Host
    // Workspace/Session create or transport start.
    parseAcpMcpServers(request.mcpServers)
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP additional directories are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
    return append
  }

  private validateResume(request: AcpResumeSessionParams, systemPromptCapable: boolean): string | undefined {
    const append = normalizeSystemPromptAppend(request.systemPrompt, systemPromptCapable)
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'a non-empty sessionId is required', JSONRPC_INVALID_PARAMS)
    }
    validateCwd(request.cwd)
    parseAcpMcpServers(request.mcpServers ?? [])
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP additional directories are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
    return append
  }

  private validateLoad(request: AcpLoadSessionParams, systemPromptCapable: boolean): string | undefined {
    const append = normalizeSystemPromptAppend(request.systemPrompt, systemPromptCapable)
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'a non-empty sessionId is required', JSONRPC_INVALID_PARAMS)
    }
    validateCwd(request.cwd)
    if (!Array.isArray(request.mcpServers)) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'mcpServers must be an array', JSONRPC_INVALID_PARAMS)
    }
    parseAcpMcpServers(request.mcpServers)
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length !== 0) {
      throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'ACP additional directories are not supported by this Host', JSONRPC_INVALID_PARAMS)
    }
    return append
  }
}

/** The capabilities of a connection that negotiated none of the optional ones. */
const NO_PROJECTION_CAPABILITIES: AcpNegotiatedCapabilities = {
  plan: false,
  compaction: false,
  subagents: false,
  notices: false,
  booleanConfigOptions: false,
}

/** The bounded load replay window could not hold every live event. */
function loadBackpressure(): LocalAcpViewError {
  return new LocalAcpViewError(
    'LOCAL_ACP_LOAD_BACKPRESSURE',
    'the live Session events exceeded the bounded replay window',
    JSONRPC_INTERNAL_ERROR,
  )
}

/** The bounded read-only projection tail could not keep up. */
function projectionBackpressure(): LocalAcpViewError {
  return new LocalAcpViewError(
    'LOCAL_ACP_PROJECTION_BACKPRESSURE',
    'the read-only projection tail exceeded its bound',
    JSONRPC_INTERNAL_ERROR,
  )
}

/** The official Store could not read and verify one projected image/file. */
function attachmentLoadFailed(): LocalAcpViewError {
  return new LocalAcpViewError(
    'LOCAL_ACP_LOAD_ATTACHMENT_READ_FAILED',
    'a projected attachment could not be read and verified',
    JSONRPC_INTERNAL_ERROR,
  )
}

/**
 * Map one official subagent terminal stop reason onto the standard ACP work
 * state. An unrecognized reason is `error`: a child whose ending cannot be
 * named is never reported as a clean finish.
 */
function subagentStopReason(reason: string | undefined): 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | { readonly stopReason: 'error' } {
  switch (reason) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
      return 'cancelled'
    case 'refusal':
      return 'refusal'
    default:
      return { stopReason: 'error' }
  }
}

/**
 * Validate and normalize ONE optional client system prompt BEFORE any Host side
 * effect. Omitted and `null` are equivalent (this View carries NO append) and
 * never reuse a historical value. On a connection that did not actually receive
 * the standard `sessionCapabilities.systemPrompt` advertisement, any non-null
 * value is a request error; the View never silently ignores it.
 *
 * A valid value is EXACTLY `{mode:'append', content:[text blocks]}`: every block
 * must be a standard text block, the array must be non-empty, and the ordered
 * texts are joined literally with two newlines between blocks (no trim,
 * interpolation, Markdown rewrite, URI fetch or Unicode normalization). The
 * aggregate UTF-8 bytes including separators must fit the ONE committed budget;
 * the check accumulates before the single join so no unbounded copy is made.
 */
function normalizeSystemPromptAppend(systemPrompt: unknown, capable: boolean): string | undefined {
  if (systemPrompt === undefined || systemPrompt === null) return undefined
  if (!capable) {
    throw new LocalAcpViewError(
      'LOCAL_ACP_VIEW_INVALID_REQUEST',
      'ACP system prompts are not supported on this connection',
      JSONRPC_INVALID_PARAMS,
    )
  }
  if (typeof systemPrompt !== 'object') {
    throw invalidSystemPromptAppend()
  }
  const request = systemPrompt as { readonly mode?: unknown; readonly content?: unknown }
  if (request.mode !== 'append' || !Array.isArray(request.content) || request.content.length === 0) {
    throw invalidSystemPromptAppend()
  }
  const texts: string[] = []
  let bytes = 0
  for (const block of request.content) {
    if (block === null || typeof block !== 'object') throw invalidSystemPromptAppend()
    const candidate = block as { readonly type?: unknown; readonly text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') throw invalidSystemPromptAppend()
    bytes += Buffer.byteLength(candidate.text, 'utf8') + (texts.length === 0 ? 0 : 2)
    if (bytes > MAX_SYSTEM_PROMPT_APPEND_BYTES) throw invalidSystemPromptAppend()
    texts.push(candidate.text)
  }
  return texts.join('\n\n')
}

/** The ONE stable invalid-params class of a malformed client system prompt. */
function invalidSystemPromptAppend(): LocalAcpViewError {
  return new LocalAcpViewError(
    'LOCAL_ACP_VIEW_INVALID_REQUEST',
    'the client system prompt is not a supported append request',
    JSONRPC_INVALID_PARAMS,
  )
}

/** A `session/new|resume` cwd is a non-empty Linux absolute path with no NUL. */
function validateCwd(cwd: string): void {
  if (typeof cwd !== 'string' || cwd.length === 0 || !cwd.startsWith('/') || cwd.includes('\u0000')) {
    throw new LocalAcpViewError('LOCAL_ACP_VIEW_INVALID_REQUEST', 'cwd must be a non-empty absolute path', JSONRPC_INVALID_PARAMS)
  }
}

/** The finite per-prompt blob admission fixed by the PR-A product contract. */
const MAX_RESOURCE_BLOBS_PER_PROMPT = 16

/** The fixed descriptive header shared by text and blob resources. */
function resourceHeader(uri: string, mimeType: string | undefined): string {
  const mimeField = mimeType === undefined ? '' : ` mimeType=${JSON.stringify(mimeType)}`
  return `\n[resource uri=${JSON.stringify(uri)}${mimeField}]\n`
}

/**
 * The display filename proposal from a standard URI's LAST hierarchical path
 * segment. It is only a proposal for the official Store sanitizer: no path
 * lookup, no query/fragment, no second decode and no MIME guess.
 */
function resourceDisplayName(uri: string): string | undefined {
  try {
    const parsed = new URL(uri)
    if (!parsed.pathname.startsWith('/') || parsed.pathname.endsWith('/')) return undefined
    const segment = parsed.pathname.split('/').filter(part => part.length > 0).at(-1)
    if (segment === undefined) return undefined
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * Validate and normalize standard ACP prompt blocks in client order.
 * `resource_link` blocks become official bracketed text hints; inline images
 * require this connection's negotiated Host capability. A standard resource is
 * either descriptive text (folded into the adjacent user text) or a decoded
 * pending blob descriptor that the caller stages before dispatch. Embedded
 * resource, audio, unknown blocks, empty prompts and whitespace-only text stay
 * rejected before any Host dispatch.
 */
function validatePromptContent(
  prompt: readonly unknown[],
  imageEnabled: boolean,
  resourceEnabled: boolean,
  resourceBudget: number,
): readonly AcpDecodedPromptPart[] {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a prompt must contain non-empty text or an image', JSONRPC_INVALID_PARAMS)
  }
  const content: AcpDecodedPromptPart[] = []
  let pendingText = ''
  let resourceBytes = 0
  let blobCount = 0
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
    if (type === 'resource') {
      if (!resourceEnabled) {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'this connection did not negotiate embedded resource input', JSONRPC_INVALID_PARAMS)
      }
      const resource = (wireBlock as { readonly resource?: unknown }).resource
      if (resource === null || typeof resource !== 'object') {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt contains an invalid resource block', JSONRPC_INVALID_PARAMS)
      }
      const uri = (resource as { readonly uri?: unknown }).uri
      const mimeValue = (resource as { readonly mimeType?: unknown }).mimeType
      const textValue = (resource as { readonly text?: unknown }).text
      const blobValue = (resource as { readonly blob?: unknown }).blob
      if (typeof uri !== 'string'
        || (mimeValue !== undefined && mimeValue !== null && typeof mimeValue !== 'string')
        || (textValue !== undefined && typeof textValue !== 'string')
        || (blobValue !== undefined && typeof blobValue !== 'string')) {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt contains an invalid resource shape', JSONRPC_INVALID_PARAMS)
      }
      const hasText = typeof textValue === 'string'
      const hasBlob = typeof blobValue === 'string'
      if (hasText === hasBlob) {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a resource must contain exactly one of text or blob', JSONRPC_INVALID_PARAMS)
      }
      const mimeType = mimeValue === null ? undefined : mimeValue
      const text = hasText ? textValue as string : undefined
      const blob = hasText ? undefined : blobValue as string
      resourceBytes += Buffer.byteLength(uri)
        + (mimeType === undefined ? 0 : Buffer.byteLength(mimeType))
        + Buffer.byteLength(text ?? blob ?? '')
      if (resourceBytes > resourceBudget) {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt resources exceed the embedded input budget', JSONRPC_INVALID_PARAMS)
      }
      if (text !== undefined) {
        pendingText += resourceHeader(uri, mimeType) + text + '\n'
        continue
      }
      blobCount += 1
      if (blobCount > MAX_RESOURCE_BLOBS_PER_PROMPT) {
        throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'the prompt contains too many embedded blob resources', JSONRPC_INVALID_PARAMS)
      }
      pendingText += resourceHeader(uri, mimeType)
      flushText()
      const name = resourceDisplayName(uri)
      content.push({
        type: 'blob',
        uri,
        ...(mimeType === undefined ? {} : { mimeType }),
        data: blob as string,
        ...(name === undefined ? {} : { name }),
      })
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
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'this Host accepts standard ACP text, resource_link, resource and negotiated image blocks only', JSONRPC_INVALID_PARAMS)
  }
  flushText()
  if (!content.some(part => part.type === 'image' || part.type === 'blob'
    || (part.type === 'text' && part.text.trim().length > 0))) {
    throw promptError('LOCAL_ACP_PROMPT_INVALID_CONTENT', 'a prompt must include non-whitespace text, a resource or an image', JSONRPC_INVALID_PARAMS)
  }
  return content
}

/** One stable "the official Store could not read this committed attachment" failure. */
function attachmentReadFailed(): LocalAcpViewError {
  return promptError(
    'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED',
    'a committed attachment could not be read and verified',
    JSONRPC_INTERNAL_ERROR,
  )
}

/** One stable "this event's file payload cannot be materialized" failure. */
function outputFrameTooLarge(): LocalAcpViewError {
  return promptError(
    'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
    'a committed event file payload cannot be represented in one output frame',
    JSONRPC_INTERNAL_ERROR,
  )
}

/**
 * The generic file occurrences of one inter-agent message in wire order.
 * A repeated reference is a separate occurrence and costs its payload again.
 */
function filesOf(content: AcpHistoryAgentMessage['content']): AcpStoredFileRef[] {
  const files: AcpStoredFileRef[] = []
  for (const part of content) {
    if (part.type === 'file') files.push(part.ref)
  }
  return files
}

/**
 * Materialize ONE verified generic file from its official Store stream.
 *
 * The official Store verifies the object only AFTER the final chunk, so the
 * iteration always continues to natural EOF; stopping at the declared size
 * would skip that verification. An over-declared chunk count aborts the
 * iteration immediately (the Store's own `finally` destroys its read stream),
 * and a short read is a corrupt attachment. The single concatenation is the
 * only full-payload copy.
 */
async function readVerifiedFileBytes(
  stream: AsyncIterable<Uint8Array>,
  ref: AcpStoredFileRef,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted()
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    signal.throwIfAborted()
    total += chunk.byteLength
    if (total > ref.bytes) throw new Error('a stored file yielded more bytes than its declared length')
    chunks.push(chunk)
  }
  signal.throwIfAborted()
  if (total !== ref.bytes) throw new Error('a stored file ended before its declared byte length')
  return Buffer.concat(chunks, total)
}

/**
 * One standard embedded `resource` blob for a committed generic file. The URI
 * is this adapter's opaque, stable content identity (`dsh-attachment://`); it
 * is never a Host path, a download URL or a token, and it carries no guessed
 * MIME type because the Store's generic file has none.
 */
function fileResourceBlock(ref: AcpStoredFileRef, bytes: Buffer): AcpWireContentBlock {
  return {
    type: 'resource',
    resource: {
      uri: `dsh-attachment://sha256/${ref.attachmentId.slice('sha256:'.length)}/${encodeURIComponent(ref.name)}`,
      // The concatenated verified Buffer IS the Base64 source: no extra copy.
      blob: bytes.toString('base64'),
    },
  }
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
      // The standard not-active Session error: `-32002` plus the REQUESTED
      // sessionId, distinguished from the connection's own routing conflict.
      return new LocalAcpViewError('LOCAL_ACP_VIEW_SESSION_NOT_FOUND', 'the session does not exist on this Host', JSONRPC_RESOURCE_NOT_FOUND, data)
    case 'session/agent-busy':
      return new LocalAcpViewError('LOCAL_ACP_VIEW_SUBAGENT_OWNED', 'the session is owned by subagent routing', JSONRPC_INVALID_PARAMS, data)
    case 'session/writer-held':
      return new LocalAcpViewError('LOCAL_ACP_VIEW_WRITER_HELD', 'the session is written by another owner', JSONRPC_INVALID_PARAMS, data)
    default:
      return new LocalAcpViewError('LOCAL_ACP_VIEW_HOST_ERROR', 'the Host could not resolve the session', JSONRPC_INTERNAL_ERROR, data)
  }
}
