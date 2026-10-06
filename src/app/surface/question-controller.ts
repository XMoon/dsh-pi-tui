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
  PendingQuestionView,
  QuestionInteractionPort,
  QuestionRequestView,
  UserQuestionProvider,
} from '../../runtime/interaction-port.ts'
import { QuestionAnswerError, QUESTION_BAD_ANSWER, QUESTION_REPLY_QUEUED } from '../../runtime/interaction-port.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { Diag } from '../../diag.ts'
import { runDetached } from '../../detached.ts'
import { runSyncDisposalSteps } from '../../disposal.ts'
import type { QuestionFlowDraft, TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus } from '../../tui-app.ts'

import type { QuestionAttentionRow } from '../../task-center-attention.ts'

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

/**
 * Local presentation state of one answerable continued Question. `visible`
 * owns the editor seat; `parked` does not, while the HOST question stays
 * exactly as answerable as before (addendum §4.1/§8.1).
 */
type ContinuedPresentationState = 'visible' | 'parked'

/** One continued Question the surface knows about, keyed by (sessionId, callId). */
interface ContinuedEntry {
  readonly sessionId: string
  readonly callId: string
  /** The authoritative question payload (updated when authority replaces it). */
  questions: readonly AskUserQuestionItem[]
  state: ContinuedPresentationState
  /** Owned lifetime of the MOUNTED form; `undefined` while parked. */
  mounted: AbortController | undefined
  /**
   * The user's local progress, kept across park/reopen (§6). The flow reports
   * it on every mutation and at teardown, so parking never loses answers, free
   * text or the current question.
   */
  draft: QuestionFlowDraft | undefined
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
  /**
   * Every continued Question this surface knows about, keyed by
   * (sessionId, callId). The entry — not the mounted form — is the unit of
   * state: it outlives its editor seat so parking preserves the user's work,
   * and it disappears the moment authority says the call is not answerable
   * (queued reply, settled, vanished).
   */
  private readonly entries = new Map<string, ContinuedEntry>()
  /** Task Center attention observers (presentation-only invalidation). */
  private readonly attentionListeners = new Set<() => void>()
  /** The port subscription observing the CURRENT session's durable surface. */
  private subscription: (() => void) | undefined
  private subscribedSessionId: string | undefined
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

  /**
   * Register the live request channel and perform the COLD recovery read.
   *
   * The cold read is why attach() owns the first reconcile: the surface's
   * bootstrap hydrates the Session projections (`initLiveSession`) BEFORE the
   * interaction controller exists, so a question that is ALREADY durably
   * `continued` at attach time can never have gone through a routing callback
   * — waiting for the next Session event would leave it unoffered until an
   * unrelated event happens to arrive. Re-reading authority here is the same
   * projection-driven rule as every later reconcile, never a local guess.
   *
   * `false` = no question capability (nothing to reconcile against).
   */
  attach(): boolean {
    if (this.disposed) return false
    const provider: UserQuestionProvider = (request, next) => this.handleLive(request, next)
    const registered = this.deps.port.onRequest(provider)
    if (registered) {
      // Observe BEFORE the cold read, so a projection change landing between
      // the read and the subscription can never be lost.
      this.ensureSubscription()
      this.reconcile()
    }
    return registered
  }

  /** Release every controller-owned registration: the port subscription, the
   *  mounted late-answer panels (their owned abort controllers) and every held
   *  claim / countdown. Every owner slot/set is retired before any callback
   *  runs, so one throwing cleanup cannot strand the remaining owned
   *  cleanups (M3-6 PR3); the collected failure is surfaced after every
   *  attempt. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const disposal = this.disposal
    this.disposal = undefined
    const subscription = this.subscription
    this.subscription = undefined
    this.subscribedSessionId = undefined
    const mounted = [...this.entries.values()].map(entry => entry.mounted)
    this.entries.clear()
    this.attentionListeners.clear()
    const cleanups = [...this.activeCleanups]
    this.activeCleanups.clear()
    runSyncDisposalSteps('question surface disposal', [
      () => disposal?.(),
      () => subscription?.(),
      ...mounted.map(handle => () => handle?.abort()),
      ...cleanups.map(cleanup => () => cleanup()),
    ])
  }

  /**
   * Keep exactly ONE observation registered, for the session this surface is
   * showing. A session switch re-arms it (the controller must never keep
   * observing a session it no longer presents), and a backend that cannot
   * subscribe yet (the Remote binding is not available on the first read) is
   * retried on the next reconcile instead of being latched as absent.
   */
  private ensureSubscription(): void {
    const sessionId = this.deps.currentSessionId()
    if (sessionId === this.subscribedSessionId) return
    this.releaseSubscription()
    if (sessionId === undefined) return
    const subscription = this.deps.port.subscribe(sessionId, () => this.reconcile())
    if (subscription === undefined) return
    this.subscription = subscription
    this.subscribedSessionId = sessionId
  }

  private releaseSubscription(): void {
    this.subscription?.()
    this.subscription = undefined
    this.subscribedSessionId = undefined
  }

  /**
   * Re-derive the continued-Question MODEL from authority. Nothing is
   * reconstructed from a local timer or the transcript:
   *
   * 1. entries whose call is no longer answerable are deleted (queued reply,
   *    settled, vanished) — the notice names the fact the projection owns;
   * 2. entries of another session are dropped, so a session switch never
   *    leaks a form or a Task Center row into the new session;
   * 3. missing entries are created **parked**: cold recovery must not steal
   *    the editor seat merely because a pending Question was discovered
   *    (addendum §13.2);
   * 4. an existing entry keeps its presentation — authority NEVER turns
   *    `parked` back into `visible` on its own (§4.2).
   *
   * Only a live foreground transition (see {@link awaitContinued}) or an
   * explicit {@link reopen} may make a continued Question visible.
   */
  reconcile(): void {
    if (this.disposed) return
    this.ensureSubscription()
    const sessionId = this.deps.currentSessionId()
    if (sessionId === undefined) {
      // No session owns the surface: whatever is mounted belongs to a session
      // that is no longer shown.
      this.parkMounted()
      this.notifyAttention()
      return
    }
    let changed = false
    // 2. another session's entries are not this surface's business any more.
    for (const [key, entry] of [...this.entries]) {
      if (entry.sessionId === sessionId) continue
      this.removeEntry(key, undefined, false)
      changed = true
    }
    const snapshot = this.deps.port.snapshot(sessionId)
    if (snapshot === undefined) {
      // No authority to present (capability absence, or a detached/replaced
      // Connection): fail closed. A mounted form is withdrawn and parked —
      // `attentionRows()` hides every row while authority stays unreadable.
      this.parkMounted()
      this.notifyAttention()
      return
    }
    const answerable = new Map<string, PendingQuestionView>()
    for (const call of snapshot.active) {
      if (call.state !== 'continued') continue
      if (snapshot.queuedReplyCallIds.has(call.callId)) continue
      answerable.set(this.callKey(call.sessionId, call.callId), call)
    }
    // 1. authority ends the interaction.
    for (const [key, entry] of [...this.entries]) {
      if (answerable.has(key)) continue
      if (snapshot.queuedReplyCallIds.has(entry.callId)) {
        this.removeEntry(key, 'A reply for this question is already queued; the local form was withdrawn.', false)
      } else if (snapshot.settled.some(settled => settled.callId === entry.callId)) {
        this.removeEntry(key, 'This question is no longer awaiting an answer.', false)
      } else {
        this.removeEntry(key, undefined, false)
      }
      changed = true
    }
    // 3./4. create parked; update the payload; never auto-reveal.
    for (const [key, call] of answerable) {
      const entry = this.entries.get(key)
      if (entry === undefined) {
        this.entries.set(key, {
          sessionId: call.sessionId,
          callId: call.callId,
          questions: call.questions,
          state: 'parked',
          mounted: undefined,
          draft: undefined,
        })
        changed = true
        continue
      }
      if (entry.questions !== call.questions) {
        entry.questions = call.questions
        changed = true
      }
    }
    if (changed) this.notifyAttention()
  }

  /**
   * The current session's answerable continued Questions, in authority order —
   * the detached model Task Center composes from. Empty while authority is
   * unreadable: the rows must never outlive the truth that produced them.
   */
  attentionRows(): readonly QuestionAttentionRow[] {
    if (this.disposed) return []
    const sessionId = this.deps.currentSessionId()
    if (sessionId === undefined) return []
    if (this.deps.port.snapshot(sessionId) === undefined) return []
    const rows: QuestionAttentionRow[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId) continue
      rows.push({
        sessionId: entry.sessionId,
        callId: entry.callId,
        questions: entry.questions,
        presentation: entry.state,
      })
    }
    return rows
  }

  /** Observe Question attention changes (presentation-only invalidation). */
  subscribeAttention(listener: () => void): () => void {
    this.attentionListeners.add(listener)
    return () => { this.attentionListeners.delete(listener) }
  }

  private notifyAttention(): void {
    for (const listener of [...this.attentionListeners]) listener()
  }

  /**
   * Reopen the SAME logical continued Question (Task Center row -> Enter).
   * Rechecks authority FIRST, so a row that went stale between rendering and
   * selection fails closed without creating a panel, and never creates a
   * second concurrent form for one call.
   */
  reopen(sessionId: string, callId: string): boolean {
    if (this.disposed) return false
    // The row must belong to the session this surface currently owns.
    if (this.deps.currentSessionId() !== sessionId) return false
    const snapshot = this.deps.port.snapshot(sessionId)
    if (snapshot === undefined) return false
    const call = snapshot.active.find(entry => entry.callId === callId && entry.state === 'continued')
    if (call === undefined || snapshot.queuedReplyCallIds.has(callId)) return false
    const key = this.callKey(sessionId, callId)
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    if (entry.state === 'visible') {
      // Already on screen: reassert it (repaint) instead of mounting a second
      // flow for one call.
      this.deps.repaint()
      return true
    }
    entry.questions = call.questions
    entry.state = 'visible'
    this.mountEntry(entry)
    this.notifyAttention()
    return true
  }

  /** Withdraw a mounted form without ending answerability: the entry, its
   *  draft and the Host question all survive as `parked`. */
  private parkMounted(): void {
    for (const entry of this.entries.values()) {
      if (entry.state !== 'visible') continue
      entry.state = 'parked'
      const mounted = entry.mounted
      entry.mounted = undefined
      mounted?.abort()
    }
  }

  /** Park ONE entry after its form was torn down (Esc). */
  private park(entry: ContinuedEntry): void {
    if (!this.entries.has(this.callKey(entry.sessionId, entry.callId))) return
    entry.state = 'parked'
    this.notifyAttention()
  }

  /**
   * Delete one entry (authority ended it, the answer was delivered, or the
   * surface is done with it) and abort the form it owned.
   *
   * `notify` is false only while {@link reconcile} is batching a whole pass into
   * ONE invalidation; every standalone removal (an accepted late answer, a
   * REPLY_QUEUED outcome) invalidates immediately, so chrome that mirrors the
   * attention count (the footer's Task Center affordance) can never show a
   * Question that is already gone.
   */
  private removeEntry(key: string, notice: string | undefined, notify = true): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    const mounted = entry.mounted
    entry.mounted = undefined
    mounted?.abort()
    if (notice !== undefined && !this.disposed) this.deps.notify(notice, 'info')
    if (notify) this.notifyAttention()
  }

  /** Ensure an entry exists (parked) for one answerable call. */
  private ensureEntry(
    sessionId: string,
    callId: string,
    questions: readonly AskUserQuestionItem[],
  ): ContinuedEntry {
    const key = this.callKey(sessionId, callId)
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing
    const entry: ContinuedEntry = {
      sessionId,
      callId,
      questions,
      state: 'parked',
      mounted: undefined,
      draft: undefined,
    }
    this.entries.set(key, entry)
    return entry
  }

  /** Mount the editable late answer for one entry under an OWNED abort
   *  controller, so authority can withdraw it and the user can park it. */
  private mountEntry(entry: ContinuedEntry): void {
    const controller = new AbortController()
    entry.mounted = controller
    runDetached('question: continued late answer', () => this.presentContinued(entry, controller), {
      diag: this.deps.diag,
      sessionId: () => entry.sessionId,
    })
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
          // The live foreground interaction just transitioned into `continued`,
          // so the user was ALREADY handling this call: the entry is offered
          // visible instead of parked (addendum §4.1). A cold discovery, by
          // contrast, parks (see reconcile).
          const entry = this.ensureEntry(
            sessionId,
            callId,
            call.questions.length > 0 ? call.questions : questions,
          )
          if (entry.state !== 'visible') {
            entry.state = 'visible'
            this.mountEntry(entry)
            this.notifyAttention()
          }
          return
        }
        // A settled call (or one that vanished) is no longer ours to offer.
        if (snapshot.settled.some(entry => entry.callId === callId)) return
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
  }

  /**
   * Offer the editable late answer for one entry under the OWNED abort
   * controller created by {@link mountEntry}. The entry — not this promise —
   * owns the state: a rejection caused by authority (or by the surface) leaves
   * the entry alone, and a user park keeps it as `parked` with its draft.
   */
  private async presentContinued(entry: ContinuedEntry, controller: AbortController): Promise<void> {
    const key = this.callKey(entry.sessionId, entry.callId)
    const status: TuiQuestionStatus = {
      text: 'The Agent continued. Your answer will arrive as a new turn; Esc to answer later.',
      // Keep the user's progress live while they work, and restore it when this
      // is a reopen of the SAME call (§6).
      onDraftChange: (draft) => { entry.draft = draft },
      ...entry.draft === undefined ? {} : { initialDraft: entry.draft },
    }
    try {
      // The panel is withdrawn through THIS signal when authority changes or
      // the user parks, so the form never outlives its answerability.
      const answers = await this.deps.ask(entry.questions.map(toTuiQuestion), controller.signal, status)
      const outcome = await this.deps.port.answerContinued(
        entry.sessionId,
        entry.callId,
        { answers: answers.map(toAnswerItem) },
      )
      // The settlement is REAL (the adapter classifies it from the Host
      // result); this fence only decides WHERE it may be announced. The
      // notice belongs to the surface that still owns the interaction: the
      // entry must still be live AND belong to the session this surface is
      // showing. A session switch deletes the entry (the replacement
      // surface must not see A's notice), while a normal reconnect PARKS it
      // on the SAME surface (the queued reply is real and displayable
      // there). `controller.signal.aborted` cannot make this distinction
      // (both paths abort the mounted form), so ownership is judged from
      // the entry map + the current session, never from the abort state.
      if (!this.disposed && this.entries.get(key) === entry
        && this.deps.currentSessionId() === entry.sessionId) {
        this.deps.notify(
          outcome === 'queued'
            ? 'Answer queued — it will reach the Agent as a new turn.'
            : 'This question is no longer awaiting an answer.',
          'info',
        )
      }
      // Submitted: the interaction is spent (authority will confirm). Delete
      // only OUR entry: a superseded settlement must never retire a NEWER
      // entry reconcile created for the same (session, call) after the
      // queued reply was discarded and the call became answerable again —
      // that would delete/abort a live form the user is editing.
      if (this.entries.get(key) === entry) this.removeEntry(key, undefined)
    } catch (error) {
      // A WITHDRAWN/parked form is not an outcome: the owner already decided
      // (authority ended it, the surface is disposing, or the user parked it),
      // and no answer was sent.
      if (controller.signal.aborted) return
      if (this.disposed) return
      // A superseded completion must not touch the CURRENT Question surface
      // (plan §7.3 stale-generation row): the answer may or may not have
      // reached the Host, and the new generation re-derives its own truth.
      if (error instanceof SupersededReadError) return
      const code = error instanceof QuestionAnswerError ? error.code : undefined
      if (code === QUESTION_REPLY_QUEUED) {
        // Preserve the intent: a reply is already durably queued, so the entry
        // is withdrawn until that reply is admitted or discarded (the
        // projection owns the fact).
        this.removeEntry(key, 'A reply is already queued for this question; it will reach the Agent as a new turn.')
      } else if (code === QUESTION_BAD_ANSWER) {
        // The batch was refused: the question is still answerable, so the entry
        // parks (never a re-presentation loop) and Task Center can reopen it.
        this.park(entry)
        this.deps.notify('The Agent rejected that answer batch; the question is still awaiting an answer.', 'error')
      } else if (this.isUserDismissal(error)) {
        // Esc PARKS a continued Question (addendum §4.1): the Host question is
        // untouched, the draft survives, the editor seat returns, and Quick/Full
        // Task Center own the reopen. It is never reported as a cancellation.
        this.park(entry)
        this.deps.notify('A continued question is parked — ↓ Quick Tasks or /tasks to answer it.', 'info')
      } else if (error instanceof QuestionAnswerError) {
        this.park(entry)
        this.deps.notify(`could not deliver the answer: ${error.message}`, 'error')
      } else {
        // An ordinary local cancel parks silently; the question survives.
        this.park(entry)
      }
    } finally {
      // Only OUR mount is cleared: authority or a reopen may have moved on.
      if (entry.mounted === controller) entry.mounted = undefined
    }
  }

  /** Whether a rejection is the local flow's own cancellation (Esc/Ctrl+C). */
  private isUserDismissal(error: unknown): boolean {
    if (error instanceof QuestionAnswerError) return false
    return error instanceof Error && /question flow (cancelled|aborted)/u.test(error.message)
  }
}
