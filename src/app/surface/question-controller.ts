/**
 * The Question surface controller (M3-3B) — the ONE TUI-side owner that
 * coordinates the live question channel, the QuestionFlow instance, the
 * optional timed claim, the durable Session projection, the Inbox
 * queued-reply fact, the local countdown and action settlement.
 *
 * It layers the timed/continued lifecycle AROUND the existing
 * `QuestionFlow`; it never forks the component and never bypasses its
 * reentrancy fences (`commitOther` / `deliverOtherInput` / tab+Input
 * identity).
 *
 * Ownership split (docs/surface-decisions.md §timed/continued Question):
 *
 * ```text
 * Host/Client projection     -> whether a question exists / open / continued / settled
 * Inbox projection           -> whether a late reply is durably queued
 * this controller            -> which card is mounted, the local countdown,
 *                               the wire-preserved rejection, reachability
 * QuestionFlow               -> the current form state / navigation only
 * ```
 *
 * Wire-preserved rejection (matching the released Client): the provider
 * rejects the forwarded waterfall with a `UserQuestionError`-shaped error
 * carrying `ASK_TIMED_OUT` / `ASK_CANCELLED` / `ASK_ABORTED`, which the Host
 * maps back to its own outcome. A local countdown reaching zero therefore
 * ends the FOREGROUND answer attempt only — it never cancels the Turn and
 * never cancels the question; durability comes from the projection.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/question-controller
 */

import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  QuestionInteractionPort,
  QuestionRequestView,
  UserQuestionProvider,
} from '../../runtime/interaction-port.ts'
import { QuestionAnswerError, QUESTION_BAD_ANSWER, QUESTION_REPLY_QUEUED } from '../../runtime/interaction-port.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { Diag } from '../../diag.ts'
import { runDetached } from '../../detached.ts'
import type { TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus } from '../../tui-app.ts'

/** Client rejection codes the forwarded waterfall preserves across the wire. */
export const ASK_ABORTED = 'ASK_ABORTED'
export const ASK_CANCELLED = 'ASK_CANCELLED'
export const ASK_TIMED_OUT = 'ASK_TIMED_OUT'

const REJECTION_MESSAGES: Record<string, string> = {
  [ASK_ABORTED]: 'ask_user_question was aborted before the user answered',
  [ASK_CANCELLED]: 'the user cancelled ask_user_question',
  [ASK_TIMED_OUT]: 'ask_user_question timed out before the user answered',
}

/** One wire-preserved user-question rejection (the Host restores it by code). */
function questionRejection(code: string): Error {
  const error = new Error(REJECTION_MESSAGES[code] ?? code) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

/** The controller's surface-side hooks (all injected; no Host access). */
export interface QuestionControllerDeps {
  readonly port: QuestionInteractionPort
  /** Mount the terminal flow in the editor seat. */
  readonly ask: (
    questions: readonly TuiQuestion[],
    signal: AbortSignal | undefined,
    status: TuiQuestionStatus,
  ) => Promise<TuiQuestionAnswer[]>
  /** Non-blocking user-facing line. */
  readonly notify: (message: string, level: 'info' | 'error') => void
  /** Best-effort repaint after a status/countdown mutation. */
  readonly repaint: () => void
  readonly currentSessionId: () => string | undefined
  /** Monotonic-enough local clock (tests inject). */
  readonly now?: () => number
  /** Countdown tick interval (tests inject a short one). */
  readonly tickMs?: number
  /** Bounded wait for the projection to expose a continued call (tests inject). */
  readonly continuedDeadlineMs?: number
  /** The runner's diagnostics channel for detached lifecycle work. */
  readonly diag: Diag
}

/** Map one detached official question DTO onto the terminal flow shape. */
function toTuiQuestion(question: AskUserQuestionItem): TuiQuestion {
  return {
    id: question.id,
    question: question.question,
    ...question.header !== undefined ? { header: question.header } : {},
    ...question.detail !== undefined ? { detail: question.detail } : {},
    ...question.options !== undefined ? { options: question.options } : {},
    ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {},
    ...question.intent !== undefined ? { intent: question.intent } : {},
  }
}

/** Map one terminal answer onto the official answer batch item. */
function toAnswerItem(answer: TuiQuestionAnswer): AskUserQuestionAnswerItem {
  return {
    id: answer.id,
    selected: answer.selected,
    ...answer.custom !== undefined ? { custom: answer.custom } : {},
  }
}

/** `mm:ss` remaining-time text for the countdown affordance. */
export function remainingTimeText(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
}

/**
 * One Question surface owner. `attach()` registers the live channel;
 * `reconcile()` re-derives continued-question reachability from the
 * authoritative projection (called on session navigation and after a
 * timeout); `dispose()` releases every claim and subscription.
 */
export class QuestionSurfaceController {
  private readonly deps: QuestionControllerDeps
  private readonly now: () => number
  private readonly tickMs: number
  private readonly continuedDeadlineMs: number
  /** One local presentation per live call (a call is never double-mounted). */
  private readonly presentedCalls = new Set<string>()
  /** Teardown hooks of in-flight live requests (countdown + claim release). */
  private readonly activeCleanups = new Set<() => void>()
  private disposal: (() => void) | undefined
  private disposed = false

  constructor(deps: QuestionControllerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.tickMs = deps.tickMs ?? 1_000
    this.continuedDeadlineMs = deps.continuedDeadlineMs ?? 5_000
  }

  /** Register the live request channel. `false` = no question capability. */
  attach(): boolean {
    if (this.disposed) return false
    const provider: UserQuestionProvider = (request, next) => this.handleLive(request, next)
    return this.deps.port.onRequest(provider)
  }

  /** Release controller-owned state (the port subscription is surface-owned:
   *  a Direct `ctx.on` has no disposer and dies with the Context). Surface
   *  teardown releases every held claim and stops every countdown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposal?.()
    this.disposal = undefined
    for (const cleanup of [...this.activeCleanups]) cleanup()
    this.activeCleanups.clear()
    this.presentedCalls.clear()
  }

  /**
   * Re-derive reachability from the authoritative projection: a `continued`
   * call with no durably queued reply is offered again as an editable late
   * answer. Nothing is reconstructed from a local timer or transcript.
   */
  reconcile(): void {
    if (this.disposed) return
    const sessionId = this.deps.currentSessionId()
    if (sessionId === undefined) return
    const snapshot = this.deps.port.snapshot(sessionId)
    // An absent surface is capability absence / a detached Connection — never
    // an authoritative "no questions".
    if (snapshot === undefined) return
    for (const call of snapshot.active) {
      if (call.state !== 'continued') continue
      if (snapshot.queuedReplyCallIds.has(call.callId)) continue
      const key = this.callKey(call.sessionId, call.callId)
      if (this.presentedCalls.has(key)) continue
      runDetached('question: continued late answer', () => this.presentContinued(call.sessionId, call.callId, call.questions), {
        diag: this.deps.diag,
        sessionId: () => call.sessionId,
      })
    }
  }

  private callKey(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`
  }

  /**
   * The live forwarded request. A timed request claims the Host wait first,
   * seeds the local deadline from the Host-computed remaining duration, and
   * rejects with `ASK_TIMED_OUT` when that countdown ends.
   */
  private async handleLive(
    request: QuestionRequestView,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (this.disposed) return next()
    const callId = request.callId
    const timed = request.timed && callId !== undefined
    const status: TuiQuestionStatus = {}
    const local = new AbortController()
    const signal = request.signal === undefined ? local.signal : AbortSignal.any([local.signal, request.signal])
    let timedOut = false
    let frozen = false
    let settled = false
    /** The Host/claim lifetime ended our foreground attempt (never the user). */
    let hostEnded = false
    let deadline = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const tick = (): void => {
      if (frozen || timedOut) return
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        // End the FOREGROUND attempt. The Turn and the question survive.
        timedOut = true
        stopTimer()
        local.abort()
        return
      }
      status.text = `Foreground wait ${remainingTimeText(remaining)} — Esc to answer later`
      this.deps.repaint()
    }
    // Declared BEFORE the teardown hook: teardown reads it, and a surface
    // dispose can run while the claim's opening frame is still in flight
    // (`claim` still undefined). A `const` declared after the hook would sit in
    // its temporal dead zone exactly then and throw instead of releasing.
    let claim: Awaited<ReturnType<QuestionInteractionPort['claimTimedWait']>>
    const teardown = (): void => {
      stopTimer()
      // Aborting the combined signal releases an IN-FLIGHT claim opening
      // (the adapter's caller-lifetime wiring) and ends the mounted flow;
      // `release()` covers the already-claimed case.
      local.abort()
      claim?.release()
    }
    this.activeCleanups.add(teardown)
    if (timed && callId !== undefined) {
      status.text = 'Claiming this question’s foreground wait…'
      this.deps.repaint()
      try {
        // The combined signal covers surface teardown, the local countdown,
        // and the request's own abort, so the claim attempt itself is
        // cancellable from the first moment (never a leaked Host claim).
        claim = await this.deps.port.claimTimedWait(request.sessionId, callId, signal)
      } catch (error) {
        // A claim failure must never lose the question: the live waterfall
        // still stands, only the countdown is unavailable.
        claim = undefined
        void error
      }
      if (claim !== undefined) {
        deadline = this.now() + claim.remainingMs
        status.text = `Foreground wait ${remainingTimeText(claim.remainingMs)} — Esc to answer later`
        // The first REAL answer mutation freezes the local deadline into
        // indefinite local editing while the claim remains held. Focus/blur
        // never release the claim.
        status.onAnswerMutation = () => {
          if (frozen) return
          frozen = true
          stopTimer()
          status.text = 'Editing — the Agent continues when the wait ends; your answer is still accepted'
          this.deps.repaint()
        }
        // A claim that ends for any OTHER reason (the Host closed the wait,
        // stream loss) must also end the foreground attempt — and it is NOT a
        // user cancel: the durable question survives in the projection and the
        // rejection must stay truthful (ASK_ABORTED, never ASK_CANCELLED). The
        // observation is an owned detached task (never a bare void chain).
        runDetached('question: claim lifetime', () => claim!.ended.then(() => {
          if (settled || timedOut) return
          hostEnded = true
          local.abort()
        }), { diag: this.deps.diag, sessionId: () => request.sessionId })
        timer = setInterval(tick, this.tickMs)
      } else {
        status.text = undefined
      }
      this.deps.repaint()
    }
    // A surface disposed while the claim was still opening must NOT mount a
    // flow (the countdown UI would outlive its owner). This is a Host-side
    // abort from the surface's point of view, never a user cancel.
    if (this.disposed) throw questionRejection(ASK_ABORTED)
    try {
      const answers = await this.deps.ask(request.questions.map(toTuiQuestion), signal, status)
      return { answers: answers.map(toAnswerItem) }
    } catch (error) {
      if (timedOut) throw questionRejection(ASK_TIMED_OUT)
      // A Host/delivery abort, a claim the Host ended, or our own teardown is
      // ABORTED; anything else left the flow through the user's cancel
      // (Esc / Ctrl+C). Reporting a Host-driven end as a user cancel would
      // record a cancellation the human never made.
      if (hostEnded || this.disposed || request.signal?.aborted === true) throw questionRejection(ASK_ABORTED)
      throw questionRejection(ASK_CANCELLED)
    } finally {
      settled = true
      this.activeCleanups.delete(teardown)
      stopTimer()
      claim?.release()
      if (timed && callId !== undefined && (timedOut || hostEnded)) {
        // The foreground attempt ended without an answer (timeout OR a Host
        // wait the Host closed): the question may be durably answerable, so
        // let the projection settle and then offer it. A call the Host
        // actually settled offers nothing (the projection lists it settled).
        runDetached('question: continued reachability', () => this.awaitContinued(request.sessionId, callId, request.questions), {
          diag: this.deps.diag,
          sessionId: () => request.sessionId,
        })
      }
    }
  }

  /**
   * Wait (bounded) for the projection to expose the timed call as
   * `continued`, then offer its late answer. A settled/absent call offers
   * nothing — the transcript card owns the settled evidence.
   */
  private async awaitContinued(
    sessionId: string,
    callId: string,
    questions: readonly AskUserQuestionItem[],
  ): Promise<void> {
    // Bounded poll count (never a clock read): the projection settles when
    // the Host records the timed result, which is what we wait for.
    const attempts = Math.max(1, Math.ceil(this.continuedDeadlineMs / 100))
    for (let attempt = 0; attempt < attempts && !this.disposed; attempt += 1) {
      const snapshot = this.deps.port.snapshot(sessionId)
      if (snapshot !== undefined) {
        const call = snapshot.active.find(entry => entry.callId === callId)
        if (call !== undefined) {
          if (call.state !== 'continued') return
          if (snapshot.queuedReplyCallIds.has(callId)) return
          await this.presentContinued(sessionId, callId, call.questions.length > 0 ? call.questions : questions)
          return
        }
        // A settled call (or one that vanished) is no longer ours to offer.
        if (snapshot.settled.some(entry => entry.callId === callId)) return
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
  }

  /** Offer the editable late answer for one continued call. */
  private async presentContinued(
    sessionId: string,
    callId: string,
    questions: readonly AskUserQuestionItem[],
  ): Promise<void> {
    const key = this.callKey(sessionId, callId)
    if (this.presentedCalls.has(key) || this.disposed) return
    this.presentedCalls.add(key)
    const status: TuiQuestionStatus = {
      text: 'The Agent continued. Your answer will arrive as a new turn; Esc to answer later.',
    }
    try {
      const answers = await this.deps.ask(questions.map(toTuiQuestion), undefined, status)
      const outcome = await this.deps.port.answerContinued(sessionId, callId, { answers: answers.map(toAnswerItem) })
      if (!this.disposed) {
        this.deps.notify(
          outcome === 'queued'
            ? 'Answer queued — it will reach the Agent as a new turn.'
            : 'This question is no longer awaiting an answer.',
          'info',
        )
      }
    } catch (error) {
      if (this.disposed) return
      // A superseded completion must not touch the CURRENT Question surface
      // (plan §7.3 stale-generation row): the answer may or may not have
      // reached the Host, and the new generation re-derives its own truth.
      if (error instanceof SupersededReadError) return
      const code = error instanceof QuestionAnswerError ? error.code : undefined
      if (code === QUESTION_REPLY_QUEUED) {
        // Preserve the intent: a reply is already durably queued, so the
        // editable surface is withdrawn until that reply is admitted or
        // discarded (the projection owns the fact).
        this.deps.notify('A reply is already queued for this question; it will reach the Agent as a new turn.', 'info')
      } else if (code === QUESTION_BAD_ANSWER) {
        this.deps.notify(
          'The Agent rejected that answer batch; the question is still awaiting an answer.',
          'error',
        )
      } else if (this.isUserDismissal(error)) {
        // Dismissing a continued panel never cancels the question: the next
        // session navigation / reconnect reconcile offers it again.
        this.deps.notify('A continued question is still awaiting your answer.', 'info')
      } else if (error instanceof QuestionAnswerError) {
        this.deps.notify(`could not deliver the answer: ${error.message}`, 'error')
      }
      // Any other rejection is the user's own cancel: stay silent.
    } finally {
      this.presentedCalls.delete(key)
    }
  }

  /** Whether a rejection is the local flow's own cancellation (Esc/Ctrl+C). */
  private isUserDismissal(error: unknown): boolean {
    if (error instanceof QuestionAnswerError) return false
    return error instanceof Error && /question flow (cancelled|aborted)/u.test(error.message)
  }
}
