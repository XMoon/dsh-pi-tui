/**
 * The interaction domain port (M3-3B Question reconvergence) — the semantic
 * contract between the TUI and Host-side approval/question authority.
 * Implemented by `src/runtime/direct/` (Direct) and by
 * `src/runtime/remote/interaction-remote.ts` (Remote); both map the SAME
 * official rc.2 business semantics, never two feature semantics.
 *
 * The port owns the REGISTRATION channels; the listeners/providers are
 * registered by the SURFACE owner (`SurfaceRuntime.attachInteraction`) and
 * render through TuiApp, so the port is the boundary — never a callback
 * serializer.
 *
 * The contract is TRANSPORT-NEUTRAL:
 *
 * - Approval and Question are SEPARATE concerns: Approval stays a forwarded
 *   `approval/request` waterfall plus a policy write with no public Remote
 *   carrier (Remote answers `false`), while Question carries the full rc.2
 *   lifecycle — live request, timed claim, durable open/continued projection,
 *   queued-reply fact, late answer, and settled evidence.
 * - Every Question identity is `(sessionId, callId)`: the TUI never sees an
 *   Agent / Context / Typert request object. Both adapters derive the owning
 *   Session identity inside the adapter (Direct from the live Agent scope,
 *   Remote through the official Client scope/session binding semantics).
 * - `QuestionWaitClaim` is the transport-neutral timed-wait lifetime: the
 *   adapter owns the underlying `attachWait` stream, the TUI owns the local
 *   presentation clock seeded from the Host-computed `remainingMs`.
 * - `QuestionSurfaceSnapshot` composes the two official authorities the
 *   reference dsh-web consumer reads: the `userQuestions` projection (open vs
 *   continued vs settled) and the Inbox `user-question-reply` entries (a
 *   durable late reply is queued). Raw Inbox storage shapes never reach
 *   `QuestionFlow`.
 *
 * Plan review rides the same channels; no separate method.
 *
 * Full contract: docs/client-server-migration.md +
 * docs/client-server-coupling.md (interaction rows) + docs/surface-decisions.md.
 * @module @xmoon76/dsh-pi-tui/runtime/interaction-port
 */

import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'

/**
 * One LIVE question request as the semantic port sees it: the owning Session
 * identity, the tool call identity (absent for a legacy blocking request with
 * no `wait`), whether the Host declared a foreground timed wait, the detached
 * question DTOs, and the request's cancellation lifetime. An Agent / Context /
 * Typert request object NEVER crosses the port: each adapter derives the
 * session identity inside the adapter (Direct from the request's Agent scope,
 * Remote through the official Client scope/session binding semantics).
 */
export interface QuestionRequestView {
  readonly sessionId: string
  /** The tool call keying the card; absent for a legacy blocking request. */
  readonly callId: string | undefined
  /** True when the Host declared a foreground timed wait (`wait.timed`). */
  readonly timed: boolean
  readonly questions: readonly AskUserQuestionItem[]
  readonly signal?: AbortSignal
}

/** The live-request listener contract (the answer flows back through the
 * waterfall return value; `next()` delegates to the next answerer). */
export type UserQuestionProvider = (
  request: QuestionRequestView,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

/** The sub-set of the official approval request the TUI consumes — the
 * transport-neutral shape (no same-process Agent). A Remote backend maps
 * its PendingWait onto this; the Direct adapter maps the official
 * ApprovalRequest. */
export interface ApprovalRequestLike {
  signal?: AbortSignal
  callId?: string
  /**
   * The owning Session identity, when the backend can derive it from the
   * official request (the Direct branch reads the request's OWN Agent). It lets
   * the surface retire a REPLACED subject's approval presentation at a session
   * publication (B3 findings C/F6). An absent identity (a backend whose
   * approval carrier is not Session-scoped) leaves that request's presentation
   * to its own lifetime — never a fabricated identity.
   */
  readonly sessionId?: string
  /** The tool asking for permission (the TUI renders the prompt for it). */
  toolName: string
  reason?: string
}

/** The approval request listener (the TUI answers through its prompt). */
export type ApprovalRequestListener = (
  request: ApprovalRequestLike,
  next: unknown,
) => unknown

/**
 * One answerable question call as the durable surface sees it: the call
 * identity, the detached question DTOs, and the official open/continued
 * state. `open` while the live request may still return the answer;
 * `continued` once only a late reply can answer it.
 */
export interface PendingQuestionView {
  readonly callId: string
  readonly sessionId: string
  readonly questions: readonly AskUserQuestionItem[]
  readonly state: 'open' | 'continued'
}

/**
 * One settled question call with the FINAL answer batch — the batch its own
 * result carried when the user answered inside the window, otherwise the
 * batch its late reply carried (the timed result records the timeout, not
 * the answer). The transcript's settled `ask_user_question` presentation
 * reads the final answers from here.
 */
export interface SettledQuestionView {
  readonly callId: string
  readonly sessionId: string
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/**
 * The durable Question surface for one Session, composed from the official
 * `userQuestions` projection plus the Inbox queued-reply fact: a `continued`
 * call whose reply is durably queued (still awaiting admission) is listed in
 * `queuedReplyCallIds`, and the editable submission surface for it must not
 * present itself as accepting another reply.
 */
export interface QuestionSurfaceSnapshot {
  readonly sessionId: string
  /** Answerable calls in ask order (open or continued). */
  readonly active: readonly PendingQuestionView[]
  /** Settled calls in settlement order. */
  readonly settled: readonly SettledQuestionView[]
  /** Call ids with a durable late reply queued (not yet admitted/discarded). */
  readonly queuedReplyCallIds: ReadonlySet<string>
}

/**
 * The transport-neutral foreground timed-wait claim. The adapter owns the
 * underlying `userQuestions.attachWait` stream; the TUI reads exactly one
 * Host-computed remaining duration and observes the claim's end.
 *
 * Lifetime rules (official `TimedQuestionWait`):
 * - the claim ends when the question settles, the wait expires, the caller
 *   releases it, or the owning surface/Connection tears down;
 * - a local countdown reaching zero ENDS the foreground answer attempt but
 *   never cancels the Turn and never cancels the question — durable
 *   answerability comes from the projection, not from this claim;
 * - focus/blur must not release the claim; teardown/disconnect does.
 */
export interface QuestionWaitClaim {
  /** The Host-computed remaining duration from the claim's first frame. */
  readonly remainingMs: number
  /** Settles when the wait ends (settled, expired, released, or torn down). */
  readonly ended: Promise<void>
  /** Release the claim (panel teardown, surface teardown, disconnect). */
  release(): void
}

/** The Question sub-domain of the interaction port: semantic operations,
 * never Typert objects. Both adapters implement the SAME contract. */
export interface QuestionInteractionPort {
  /** Observe live question requests (the forwarded waterfall). The request
   * DTO is detached; the adapter derives the owning Session identity inside
   * the adapter so the surface never sees an Agent object. `false` = the
   * questions service is absent. */
  onRequest(provider: UserQuestionProvider): boolean
  /**
   * Read the durable Question surface for one Session. `undefined` = the
   * surface is not (yet) available for that Session — never conflated with
   * an empty surface, which is a present snapshot with empty lists.
   */
  snapshot(sessionId: string): QuestionSurfaceSnapshot | undefined
  /**
   * Observe the DURABLE Question surface of one Session: `listener` fires
   * whenever the authoritative `userQuestions` project, the Inbox queued-reply
   * fact, or the owning Session binding/generation changes, and the consumer
   * re-reads {@link snapshot} to reconcile. `undefined` = this backend cannot
   * observe it (no questions capability / no projection seam), in which case
   * the consumer keeps its event-driven reads.
   *
   * This is what makes the durable lifecycle REACTIVE rather than
   * event-opportunistic: a late reply queued by another client, a question
   * settled elsewhere, or a reconnect that re-hydrates the projections all
   * reach the surface without waiting for an unrelated Session event. The
   * returned disposer is owned by the caller (the surface releases it on
   * teardown / session switch).
   */
  subscribe(sessionId: string, listener: () => void): (() => void) | undefined
  /**
   * Claim the foreground timed wait for one question call. Resolves the
   * claim (whose first frame carries the Host-computed `remainingMs`),
   * `undefined` when no live timed wait exists for the call (already
   * settled, continued, or never timed), and rejects on real transport
   * failure.
   *
   * `signal` is the caller's claim lifetime (surface teardown, countdown
   * end, or the request's own abort). It must cancel the claim attempt from
   * the very FIRST moment — including while the opening frame is still in
   * flight — so a teardown can never leave the Host wait held by a claim the
   * surface will never release. An aborted signal releases the attempt and
   * resolves `undefined`.
   */
  claimTimedWait(sessionId: string, callId: string, signal?: AbortSignal): Promise<QuestionWaitClaim | undefined>
  /**
   * Answer a CONTINUED question (the late-answer path). Resolves the
   * official outcome: `'queued'` when the Host accepted and steered the
   * reply, `'not-continued'` when the call is not answerable-as-continued
   * (already settled or still open — the live request owns the open case).
   * Rejects with the Host taxonomy (`REPLY_QUEUED`, `BAD_ANSWER`) or a real
   * transport failure.
   */
  answerContinued(sessionId: string, callId: string, answer: AskUserQuestionAnswer): Promise<'queued' | 'not-continued'>
}

/** The official Host code for a late answer whose reply is already queued. */
export const QUESTION_REPLY_QUEUED = 'REPLY_QUEUED'
/** The official Host code for a late answer that does not name each question. */
export const QUESTION_BAD_ANSWER = 'BAD_ANSWER'

/**
 * One rejected late answer with the Host's stable code (`REPLY_QUEUED`,
 * `BAD_ANSWER`, `CALLER_NOT_LIVE`, or a transport/gateway code). Both
 * adapters throw THIS shape so a consumer can offer truthful recovery
 * without switching on a backend.
 */
export class QuestionAnswerError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'QuestionAnswerError'
    this.code = code
  }
}

/** Wrap an unknown failure from the late-answer path in the port vocabulary. */
export function questionAnswerError(error: unknown): QuestionAnswerError {
  if (error instanceof QuestionAnswerError) return error
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'question/answer-failed'
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error)
  return new QuestionAnswerError(code, message, { cause: error })
}

/** The interaction domain port. */
export interface InteractionPort {
  /** The Question sub-domain (live requests, durable surface, timed claims,
   * late answers). */
  readonly questions: QuestionInteractionPort
  /** Subscribe to approval requests. The listener renders the approval
   * prompt and returns the outcome. */
  onApprovalRequest(listener: ApprovalRequestListener): void
  /** Set the approval policy for a SESSION (identity-based). `false` = the
   * capability is unavailable on this backend (Remote: no public carrier —
   * never a silent fallback). The Direct adapter resolves the live Agent
   * internally. */
  setApprovalPolicy(sessionId: string, policy: ApprovalPolicy): boolean
}
