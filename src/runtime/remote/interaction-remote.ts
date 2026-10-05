/**
 * The Remote interaction adapter (M3-3B) — the official rc.2 wire mapping of
 * `InteractionPort` over ONE M3-1 `RemoteClientRuntime`. It implements the
 * SAME semantic contract as `src/runtime/direct/interaction-direct.ts`; no
 * Remote-only Question semantics and no Direct fallback exist.
 *
 * Published mapping (docs/m3-entry-contract.md §2.1 interaction rows):
 *
 * ```text
 * live request     -> remote.$on('user-questions/request')   (forwarded waterfall)
 * session identity -> sessions.scopeOf(owner scope)          (official Client scope)
 * timed claim      -> remote.userQuestions.attachWait(sessionId, callId, signal)
 *                      (first frame = Host-computed remainingMs)
 * durable state    -> binding(sessionId).session.projections.faceOf('userQuestions')
 * queued reply     -> the same binding's 'inbox' face, source.kind == 'user-question-reply'
 * late answer      -> remote.userQuestions.answer(sessionId, callId, answer)
 * ```
 *
 * Explicitly unsupported on the wire (docs/m3-entry-contract.md §10):
 * `setApprovalPolicy` has no dedicated approval-policy Remote and no
 * synchronous exact-equivalent carrier in rc.2, so it returns `false` — the
 * Remote `/settings` approval row is shown unavailable, never guessed as
 * `ask`. No private Host seam, no event-log reconstruction and no preset-name
 * inference back it.
 *
 * The adapter never leaks a generated Typert stream object: `QuestionWaitClaim`
 * is the transport-neutral lifetime and this class owns the underlying
 * `attachWait` handle. A replaced Connection generation makes a claim absent
 * rather than surfacing a stale claim into a new UI.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/interaction-remote
 */

import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  ApprovalRequestListener,
  InteractionPort,
  PendingQuestionView,
  QuestionInteractionPort,
  QuestionSurfaceSnapshot,
  QuestionWaitClaim,
  SettledQuestionView,
  UserQuestionProvider,
} from '../interaction-port.ts'
import { QuestionAnswerError } from '../interaction-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import { SupersededReadError } from '../read-error.ts'
import { remoteFailureCode, remoteFailureMessage } from './write-failure.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/** One forwarded `user-questions/request` as the Client projection carries it
 * (the Agent becomes the resolved owner Context; `signal` is the delivery
 * lifetime the Connection materializes). */
export interface RemoteQuestionRequestLike {
  readonly questions: readonly AskUserQuestionItem[]
  readonly wait?: { readonly callId?: unknown; readonly timed?: unknown }
  readonly signal?: AbortSignal
}

/** The official generated `userQuestions` namespace subset consumed here. */
export interface RemoteUserQuestionRemotes {
  readonly userQuestions: {
    attachWait(sessionId: string, callId: string, signal?: AbortSignal): RemoteQuestionWaitStream
    answer(sessionId: string, callId: string, answer: AskUserQuestionAnswer): Promise<RemoteResultLike<boolean>>
  }
}

/** The official `RemoteStreamHandle` subset: downlink items plus cancellation. */
export interface RemoteQuestionWaitStream extends AsyncIterable<{ readonly remainingMs: number }> {
  dispose(): void
}

/** The forwarded interaction events this adapter subscribes to (both arrive
 * through the same official allowlist as waterfalls). */
export interface RemoteInteractionEventsSource {
  $on(
    event: 'user-questions/request',
    listener: (
      this: unknown,
      request: RemoteQuestionRequestLike,
      next: () => Promise<AskUserQuestionAnswer>,
    ) => Promise<AskUserQuestionAnswer>,
  ): () => void
  $on(
    event: 'approval/request',
    listener: (this: unknown, request: unknown, next: unknown) => unknown,
  ): () => void
}

/** One Client projection face (value deliberately `unknown`). */
export interface RemoteQuestionProjectionFace {
  getSnapshot(): unknown
  /** Snapshot invalidation subscription — the Client's OWN inbox observer uses
   *  exactly this seam, so a face without it is not a face this adapter can
   *  treat as observable. */
  subscribe(listener: () => void): () => void
}

/** The official Client Session binding subset consumed here. */
export interface RemoteQuestionBinding {
  readonly session: {
    readonly projections: {
      faceOf(key: string): RemoteQuestionProjectionFace
    }
  }
}

/** The official `ClientSessions` identity + binding face. */
export interface RemoteQuestionSessionsSource {
  scopeOf(owner: unknown): string | undefined
  binding(sessionId: string): RemoteQuestionBinding | undefined
}

/** The narrow one-source runtime face this adapter consumes. */
export interface RemoteInteractionRuntimeSource {
  readonly sessions: RemoteQuestionSessionsSource
  readonly remote: RemoteUserQuestionRemotes & RemoteInteractionEventsSource
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
}

const USER_QUESTIONS_PROJECTION_KEY = 'userQuestions'
const INBOX_PROJECTION_KEY = 'inbox'

/** Read one inbox message's `user-question-reply` call id, or undefined. */
function queuedReplyCallId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { readonly kind?: unknown; readonly callId?: unknown }
  return record.kind === 'user-question-reply' && typeof record.callId === 'string' ? record.callId : undefined
}

/** Detach the official `userQuestions` wire view (`{active, settled}`). */
function readQuestionView(value: unknown): {
  readonly active: readonly PendingQuestionView[]
  readonly settled: readonly SettledQuestionView[]
} | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const view = value as { readonly active?: unknown; readonly settled?: unknown }
  if (!Array.isArray(view.active) || !Array.isArray(view.settled)) return undefined
  const active: PendingQuestionView[] = []
  for (const entry of view.active) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const row = entry as { readonly callId?: unknown; readonly questions?: unknown; readonly state?: unknown }
    if (typeof row.callId !== 'string' || !Array.isArray(row.questions)) return undefined
    if (row.state !== 'open' && row.state !== 'continued') return undefined
    active.push({
      callId: row.callId,
      sessionId: '',
      questions: row.questions as readonly AskUserQuestionItem[],
      state: row.state,
    })
  }
  const settled: SettledQuestionView[] = []
  for (const entry of view.settled) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const row = entry as { readonly callId?: unknown; readonly answers?: unknown }
    if (typeof row.callId !== 'string' || !Array.isArray(row.answers)) return undefined
    settled.push({ callId: row.callId, sessionId: '', answers: row.answers as SettledQuestionView['answers'] })
  }
  return { active, settled }
}

/** Detach the queued-reply call ids from the official `inbox` wire state. */
function readQueuedReplyCallIds(value: unknown): Set<string> {
  const queued = new Set<string>()
  if (typeof value !== 'object' || value === null) return queued
  const inbox = value as { readonly 'next-step'?: unknown; readonly 'next-turn'?: unknown }
  for (const lane of [inbox['next-step'], inbox['next-turn']]) {
    if (!Array.isArray(lane)) continue
    for (const message of lane) {
      const callId = queuedReplyCallId(message)
      if (callId !== undefined) queued.add(callId)
    }
  }
  return queued
}

/** The Remote Question sub-domain over the official wire. */
class RemoteQuestionInteractionPort implements QuestionInteractionPort {
  private readonly sessions: RemoteQuestionSessionsSource
  private readonly remote: RemoteUserQuestionRemotes & RemoteInteractionEventsSource
  private readonly generation: RemoteConnectionGenerationSource
  /** Every subscription this adapter owns, released exactly once. */
  private readonly owned: Array<() => void> = []

  constructor(source: RemoteInteractionRuntimeSource) {
    this.sessions = source.sessions
    this.remote = source.remote
    this.generation = source.connection.generation
  }

  onRequest(provider: UserQuestionProvider): boolean {
    // The official Client scope is the ONLY Session identity source on the
    // wire: the forwarded request's Agent became the resolved owner Context.
    const sessions = this.sessions
    this.owned.push(this.remote.$on('user-questions/request', function (this: unknown, request, next) {
      const sessionId = sessions.scopeOf(this)
      // A request with no owned Session cannot be keyed by a durable card.
      if (sessionId === undefined) return next()
      const callId = request.wait?.callId
      return provider({
        sessionId,
        callId: typeof callId === 'string' ? callId : undefined,
        timed: request.wait?.timed === true,
        questions: request.questions,
        ...request.signal === undefined ? {} : { signal: request.signal },
      }, next)
    }))
    return true
  }

  /** Release this sub-domain's subscriptions exactly once. */
  dispose(): void {
    for (const off of this.owned.splice(0)) off()
  }

  snapshot(sessionId: string): QuestionSurfaceSnapshot | undefined {
    // A Connection with no current generation has NO authority to present:
    // this is a SYNCHRONOUS projection read, so it cannot capture-then-compare
    // a generation the way the async read/write paths do; the established sync
    // convention (`RemoteSessionReader.measureContext`/`turnOutline`/
    // `sessionStatus`) is that a missing generation is capability absence. A
    // disconnected surface must therefore present NO answerable card rather
    // than a last-known one (plan §7.3 reconnect/stale rows).
    if (this.generation.getSnapshot() === undefined) return undefined
    const binding = this.sessions.binding(sessionId)
    // A missing binding is "not available", never an authoritative empty
    // surface: a detached/replaced Connection must not close a live card.
    if (binding === undefined) return undefined
    const view = readQuestionView(binding.session.projections.faceOf(USER_QUESTIONS_PROJECTION_KEY).getSnapshot())
    if (view === undefined) return undefined
    const queuedReplyCallIds = readQueuedReplyCallIds(
      binding.session.projections.faceOf(INBOX_PROJECTION_KEY).getSnapshot(),
    )
    return {
      sessionId,
      active: view.active.map(entry => ({ ...entry, sessionId })),
      settled: view.settled.map(entry => ({ ...entry, sessionId })),
      queuedReplyCallIds,
    }
  }

  subscribe(sessionId: string, listener: () => void): (() => void) | undefined {
    if (this.sessions.binding(sessionId) === undefined) return undefined
    let faceOffs: Array<() => void> = []
    /** (Re)register the two projected units against the CURRENT binding. */
    const armFaces = (): void => {
      for (const off of faceOffs.splice(0)) off()
      const current = this.sessions.binding(sessionId)
      if (current === undefined) return
      try {
        for (const key of [USER_QUESTIONS_PROJECTION_KEY, INBOX_PROJECTION_KEY]) {
          faceOffs.push(current.session.projections.faceOf(key).subscribe(listener))
        }
      } catch (error) {
        // A face that cannot be observed must not leak the earlier registration.
        for (const off of faceOffs.splice(0)) off()
        throw error
      }
    }
    armFaces()
    // The CONNECTION generation is part of the observed surface, not just a
    // fence on the read. Two reasons it must be owned:
    //  1. Nothing in the Client notifies on DISCONNECT (its projection stores
    //     are cleared when a NEW generation connects), so without this a
    //     continued panel would stay editable through a disconnect and only
    //     discover it on submit (SupersededReadError → silently gone). The
    //     consumer's reconcile re-reads `snapshot()`, which answers `undefined`
    //     with no generation and therefore withdraws.
    //  2. A reconnect keeps the retained binding identity-stable (asserted by
    //     the official client test), but a full retire + same-id rebuild
    //     produces a NEW session owner and therefore NEW faces — the previous
    //     registrations would then be attached to a dead store. Re-arming on
    //     every generation change covers both cases.
    const generationOff = this.generation.subscribe(() => {
      armFaces()
      listener()
    })
    return () => {
      generationOff()
      for (const off of faceOffs.splice(0)) off()
    }
  }

  async claimTimedWait(
    sessionId: string,
    callId: string,
    signal?: AbortSignal,
  ): Promise<QuestionWaitClaim | undefined> {
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    if (signal?.aborted === true) return undefined
    const lifetime = new AbortController()
    // Wire the caller's claim lifetime to the stream from the FIRST moment:
    // aborting it cancels the opening too, so a surface teardown can never
    // leave the Host holding a claim nobody will release.
    const onCallerAbort = (): void => { lifetime.abort() }
    // Read the caller's abort state through a function: the early guard above
    // narrows the parameter, and the flag can change while we await.
    const callerAborted = (): boolean => signal !== undefined && signal.aborted
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    let opening: IteratorResult<{ readonly remainingMs: number }>
    let handle: RemoteQuestionWaitStream | undefined
    let iterator: AsyncIterator<{ readonly remainingMs: number }>
    try {
      // Setup is INSIDE the cleanup region: a synchronous throw from
      // `attachWait`/`Symbol.asyncIterator` must still release the caller
      // listener and the stream handle.
      handle = this.remote.userQuestions.attachWait(sessionId, callId, lifetime.signal)
      iterator = handle[Symbol.asyncIterator]()
      opening = await iterator.next()
    } catch (error) {
      signal?.removeEventListener('abort', onCallerAbort)
      handle?.dispose()
      // A caller abort that surfaces as a stream rejection is the ordinary
      // "no claim" outcome the port documents (`undefined`), not a transport
      // failure; only a real error propagates.
      if (callerAborted() || lifetime.signal.aborted) return undefined
      throw error
    }
    // No first frame: no live timed wait for this call (already settled,
    // continued, never timed — including a caller abort). Never a fabricated
    // remaining duration.
    if (opening.done === true) {
      signal?.removeEventListener('abort', onCallerAbort)
      handle.dispose()
      return undefined
    }
    // The caller may have aborted between the opening frame resolving and this
    // return (the released Client checks its claim signal at exactly this
    // point): handing back such a claim would be a claim nobody owns.
    if (callerAborted() || lifetime.signal.aborted) {
      signal?.removeEventListener('abort', onCallerAbort)
      handle.dispose()
      return undefined
    }
    // A replaced Connection must not surface a stale claim into a new UI.
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
      signal?.removeEventListener('abort', onCallerAbort)
      handle.dispose()
      return undefined
    }
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', onCallerAbort)
      lifetime.abort()
      handle.dispose()
    }
    // The stream ends when the wait settles/expires, this claim releases, or
    // the carrier fails. The drain IS the claim's `ended` lifetime, so no
    // detached fire-and-forget promise exists: a consumer that never awaits
    // `ended` leaves no unhandled rejection, and durable answerability comes
    // from the projection rather than this stream.
    const ended = (async () => {
      try {
        await iterator.next()
      } catch {
        // A stream failure ends the claim like any other settlement.
      } finally {
        release()
      }
    })()
    return { remainingMs: opening.value.remainingMs, ended, release }
  }

  async answerContinued(
    sessionId: string,
    callId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<'queued' | 'not-continued'> {
    // Pre-dispatch fence ONLY: with no current Connection generation the
    // write provably never left (§9.3 pre-dispatch unavailable).
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) {
      throw new SupersededReadError('the question answer was not dispatched: no current Connection generation')
    }
    const result = await this.remote.userQuestions.answer(sessionId, callId, answer)
    // The write HAS BEEN dispatched: its settlement is a real Host fact and
    // is classified from the Host result alone (frozen §9.1 "Host
    // settlements stay real" / PR2 §16.3 "DO NOT reinterpret solely from
    // B"). A Connection replacement after dispatch loses only the OLD
    // surface's presentation ownership — the controller and the surface
    // fences decide where (and whether) a notice renders, exactly like
    // every other Remote write adapter (session-writer / host-command
    // dispatch-then-classify). Convergence is authoritative: the queued
    // reply lands in the inbox projection and reconcile withdraws the
    // entry.
    if (!result.ok) {
      // Preserve the Host taxonomy (REPLY_QUEUED / BAD_ANSWER / transport) in
      // the shared port vocabulary so both backends recover identically.
      throw new QuestionAnswerError(
        remoteFailureCode(result.error) ?? 'question/answer-failed',
        remoteFailureMessage(result.error),
      )
    }
    return result.value ? 'queued' : 'not-continued'
  }
}

/** The Remote backend's interaction port over ONE Client runtime source. */
export class RemoteInteractionPort implements InteractionPort {
  readonly questions: QuestionInteractionPort
  private readonly remote: RemoteInteractionEventsSource
  /** Every subscription this port owns, released exactly once. */
  private readonly owned: Array<() => void> = []
  private readonly questionsPort: RemoteQuestionInteractionPort

  constructor(source: RemoteInteractionRuntimeSource) {
    this.remote = source.remote
    this.questionsPort = new RemoteQuestionInteractionPort(source)
    this.questions = this.questionsPort
  }

  onApprovalRequest(listener: ApprovalRequestListener): void {
    // Approval rides the forwarded `approval/request` waterfall; the
    // transport-neutral listener receives the same Agent-free shape.
    this.owned.push(this.remote.$on('approval/request', function (this: unknown, request: unknown, next: unknown) {
      return listener(request as Parameters<ApprovalRequestListener>[0], next)
    }))
  }

  /**
   * Release every subscription this adapter owns. The assembly runs it BEFORE
   * the Client Context disposal (the frozen adapter-disposal order), so a
   * forwarded-event listener never outlives its owner.
   */
  dispose(): void {
    this.questionsPort.dispose()
    for (const off of this.owned.splice(0)) off()
  }

  setApprovalPolicy(_sessionId: string, _policy: ApprovalPolicy): boolean {
    // INTENTIONAL_UNSUPPORTED_IN_M3 (docs/m3-entry-contract.md §10): rc.2 has
    // no dedicated approval-policy Remote and no synchronous exact carrier.
    // Never a silent fallback to a different semantic.
    return false
  }
}
