/**
 * The surface-owned approval/question attachment lifetime (TS3 §35).
 *
 * This owner holds the ONE `QuestionSurfaceController` per surface, the approval
 * → mounted-prompt bridge, the settled-answer lookup and the Question-attention
 * subscription. It CONSUMES the existing `app/surface/question-controller.ts`
 * (which keeps the timed/continued Question semantics) and the injected
 * `runtime/interaction-port.ts`; neither is merged into this module.
 *
 * Preserved rules:
 *
 * - an already-aborted approval request settles `cancelled` SYNCHRONOUSLY (the
 *   prompt's own signal withdraws it otherwise) and the ownership of the
 *   approval prompt stays with the injected presenter;
 * - the settled `userQuestions` projection is the authoritative final answer of
 *   a timed-out call: the transcript card renders what the user finally answered,
 *   never the timeout payload;
 * - the attention subscription is a PRESENTATION-only refresh (it never re-lists
 *   the Subagent catalog and never touches the Job registry);
 * - there is exactly ONE `QuestionSurfaceController` per surface and the
 *   aggregate disposes it exactly once.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/interaction-runtime
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import type { InteractionPort } from '../../runtime/interaction-port.ts'
import type { SurfaceInteractionPresenter } from './interaction-presenter.ts'
import type { QuestionAttentionRow } from './question-controller.ts'
import { QuestionSurfaceController } from './question-controller.ts'

/** The approval/question presentation inputs (A4-7, plan §13.3/§16). */
export interface SurfaceInteractionDeps {
  /** The paired tool-call arguments cache (the runner owns the session-event
   *  feed; this is a narrow read of the current call's args). */
  readonly lookupCallArgs: (callId: string) => string | undefined
  /** The dangerous-command predicate (a pure root helper in the runner). */
  readonly dangerCommand: (command: string) => boolean
}

/** The narrow inputs of the approval/question owner; one cohesive lifetime. */
export interface InteractionRuntimeOptions {
  /**
   * PR3-B §3.2: the renderer-facing modal presenter. The composition injects
   * the narrow `SurfaceInteractionPresenter` projection here (the PiTui branch
   * is the delegating adapter over the live `TuiApp`; the TSP branch installs
   * its real interaction seat — B3 — and opts into modals only afterwards).
   * Reads before `start()` throw, exactly like the previous `mounted()` read.
   */
  readonly presenter: () => SurfaceInteractionPresenter
  /** The mounted presenter WITHOUT the not-mounted throw (the teardown path
   *  reads it; `undefined` when no presenter is live). */
  readonly livePresenter: () => SurfaceInteractionPresenter | undefined
  /**
   * PR3-A: the renderer-facing display seam. When the live renderer cannot
   * present interactive modals (`supportsModals === false`, the read-only TSP
   * renderer), `attach` registers the LEGAL fail-closed answerers instead of
   * the interactive ones: approvals resolve `'unavailable'` (the official
   * policy's no-answerer outcome — never an implicit allow), questions
   * delegate to `next()` (the Host's own timeout/continued lifecycle owns
   * them), and the dock pins an observable notice.
   */
  readonly display: () => import('./display-seam.ts').SurfaceDisplaySeam
  /** The live routed session id (the authoritative read of a settled answer). */
  readonly currentSessionId: () => string | undefined
  /**
   * ADMISSION/PRESENTATION currentness (B3 findings F10/F12): whether a request
   * for this Session may still be PRESENTED. The surface's own authority answers
   * `true` for the Session it currently shows AND for a Session currently being
   * opened (a tentative opening is not an owner replacement), so a replaced
   * subject's late request — a legal upstream delay can deliver it after the
   * replacement was published — is never mounted, while an opening target's
   * request still is. The SAME authority decides the continuous retirement
   * sweep, so admission and presentation follow ONE policy.
   *
   * It is wired ONLY on the renderer-owned branch (the TSP modal seat, F13): the
   * PiTui branch (the default AND the SDK-declined fallback) answers `true`
   * unconditionally and keeps its original delegation semantics — every request
   * is forwarded to the app exactly as before this slice.
   */
  readonly isAdmissibleSession: (sessionId: string) => boolean
  /** The surface coalesced repaint (the controller asks for it after a mutation). */
  readonly schedulePaint: () => void
  /** The attached Task Center's diagnostics channel (late-bound: the Task Center
   *  owns it and is attached before this owner). */
  readonly diag: () => Diag
  /** The aggregate's cleanup latch (a retired surface publishes nothing). */
  readonly isCleanedUp: () => boolean
  /** The Task Center's PRESENTATION-only refresh after an attention change. */
  readonly onAttentionChanged: () => void
}

/** The approval/question owner `createSurfaceRuntime()` consumes. */
export interface InteractionRuntime {
  /** Register the approval/question presentation providers (A4-7, §13.3/§16). */
  attach(port: InteractionPort, deps: SurfaceInteractionDeps): void
  /** The ONE Question surface controller (undefined before `attach`). */
  controller(): QuestionSurfaceController | undefined
  /** The current attention rows (the presentation read; `[]` before `attach`). */
  attentionRows(): readonly QuestionAttentionRow[]
  /** Publish the parked-Question count (idempotent; a no-op after cleanup). */
  publishAttention(): void
  /**
   * PR3-B B3 (findings C/F6): withdraw the PRESENTATION of every live approval
   * whose Session no longer owns the surface. The official request keeps its own
   * lifetime (its abort still settles it `cancelled` — the fail-closed outcome),
   * so this only ends the stale modal's ownership of the seat.
   */
  withdrawReplacedApprovals(): void
  /**
   * Re-derive the WHOLE presentation (Question flows/entries + live approvals)
   * against the surface's currentness authority. The publication seam and the
   * ordinary event-driven reconcile both call THIS, so a presentation that
   * stopped being admissible is retired by the same rule that admitted it.
   */
  reconcilePresentation(): void
  /**
   * The SYNCHRONOUS publication-commit half of the same policy (external review
   * P2-B): withdraw the replaced subject's live presentation (its foreground
   * flows, a live approval prompt, its mounted continued forms) and close the
   * renderer's transient list, WITHOUT any projection read, subscription work or
   * Host access — safe to run inside the commit section, where the outgoing owner
   * has just been replaced and modal-first input routing would otherwise still
   * accept keys for it. The full pass still runs later (hydration/activity).
   */
  withdrawReplacedPresentation(): void
  /** Release the attention subscription, the controller and the answer lookup. */
  dispose(): void
}

/** Create the surface approval/question owner. */
export function createInteractionRuntime(options: InteractionRuntimeOptions): InteractionRuntime {
  /** The ONE Question surface owner (M3-3B timed/continued lifecycle). */
  let questionController: QuestionSurfaceController | undefined
  /** The controller's attention subscription, released with the surface. */
  let questionAttentionDisposal: (() => void) | undefined
  /**
   * The live approval presentations, keyed by the EXACT lifetime the seat
   * received (the request's own signal), carrying the Session identity the
   * backend derived from the official request. The approval flow has no
   * continuation model, so this registry is what lets a published replacement
   * retire its presentation (B3 findings C/F6).
   */
  const liveApprovals = new Map<AbortSignal, {
    readonly sessionId: string
    /**
     * P2-2: the settlement for a request with NO official cancellation lifetime.
     * This owner created the lifetime, so it is the only possible owner of its
     * end; a real subject replacement settles it `cancelled` (fail-closed).
     * `undefined` for a request that carries a Host signal — only the Host may
     * end that one, and the presentation retirement never does.
     */
    readonly retire: (() => void) | undefined
  }>()
  /**
   * Whether THIS owner is ended. Combined with the surface's own cleanup latch it
   * fences ADMISSION (B3 finding F11): a request that only arrives during/after
   * exit teardown must never register a presentation this owner can no longer
   * drain — it takes the same fail-closed cancellation the sibling approval
   * answerers answer in that window.
   */
  let ended = false
  /**
   * The refused admissions' waits (F11): they never reached the seat, so THIS
   * owner is their teardown owner.
   */
  const refusedPresentations = new Set<() => void>()

  /**
   * Publish how many PARKED actionable Questions exist, so the footer's ↓
   * trigger and the Quick Task Center stay reachable for a Questions-only
   * session (addendum §11). A visible Question is not counted: it already owns
   * the editor seat. This never touches the active-work counts.
   *
   * PR3-B B3: the count is a PRESENTATION fact and therefore travels through
   * the renderer's own presenter (PiTui app chrome, TSP dock line) instead of a
   * PiTui-only `TuiApp` read — the read-only renderer has no app at all.
   */
  const publishAttention = (): void => {
    if (options.isCleanedUp()) return
    const rows = questionController?.attentionRows() ?? []
    options.presenter().setQuestionAttention(rows.filter(row => row.presentation === 'parked').length)
  }

  /** Whether a request for this Session may still be presented (F10/F12/F13). */
  const isAdmissible = (sessionId: string): boolean => options.isAdmissibleSession(sessionId)

  /**
   * This request's OWN presentation lifetime (F9) plus the release that detaches
   * the borrowed Host wiring (F11). The official signal is a BORROWED
   * cancellation scope and is not guaranteed to be unique per request, so it is
   * never the presentation address itself; the derivation keeps the borrowed
   * abort semantics exactly and gives this owner an explicit handle to detach.
   */
  const presentationLifetime = (host: AbortSignal | undefined): {
    lifetime: AbortSignal
    release: () => void
    retire: (() => void) | undefined
  } => {
    const own = new AbortController()
    if (host === undefined) {
      // No Host lifetime at all: THIS owner's controller is the request's only
      // possible end, so it hands out the retirement (P2-2).
      return { lifetime: own.signal, release: () => {}, retire: () => { own.abort() } }
    }
    if (host.aborted) {
      own.abort()
      return { lifetime: own.signal, release: () => {}, retire: undefined }
    }
    const forward = (): void => { own.abort() }
    host.addEventListener('abort', forward, { once: true })
    return {
      lifetime: own.signal,
      release: () => { host.removeEventListener('abort', forward) },
      retire: undefined,
    }
  }

  /**
   * The fail-closed outcome of a request that must NEVER be presented: nothing is
   * mounted and nothing is settled until the Host's OWN lifetime ends, or until
   * THIS owner's lifetime ends. The wait is registered here (F11) because the seat
   * never received it: a teardown drains it exactly like every other live
   * presentation, so a refused admission can never become an unowned hanging
   * promise.
   */
  const waitForLifetime = (lifetime: AbortSignal, release: () => void): Promise<ApprovalOutcome> =>
    new Promise(resolve => {
      let settled = false
      let detachLifetime: (() => void) | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        refusedPresentations.delete(finish)
        detachLifetime?.()
        release()
        resolve('cancelled')
      }
      const onAbort = (): void => { finish() }
      refusedPresentations.add(finish)
      if (lifetime.aborted) { finish(); return }
      lifetime.addEventListener('abort', onAbort, { once: true })
      detachLifetime = () => { lifetime.removeEventListener('abort', onAbort) }
    })

  /**
   * Withdraw the PRESENTATION of every live approval that is no longer ADMISSIBLE
   * (findings C/F6/F10/F12) — the same authority that admits a request decides
   * whether it may keep owning the seat, so a replaced subject and a rolled-back
   * opening target are retired by ONE rule. The official request is untouched: its
   * own abort still settles it `cancelled`.
   */
  const withdrawReplacedApprovals = (): void => {
    if (options.isCleanedUp()) return
    for (const [lifetime, live] of [...liveApprovals]) {
      if (isAdmissible(live.sessionId)) continue
      liveApprovals.delete(lifetime)
      options.livePresenter()?.withdrawPresentation(lifetime)
      // P2-2: a request with no Host lifetime has no other owner that could ever
      // settle it, so the replacement does — and only that KIND of request: a
      // request carrying a Host signal keeps the Host's own settlement right.
      live.retire?.()
    }
  }

  /**
   * Re-derive the WHOLE presentation against that SAME authority: the Question
   * controller's live flows and continued entries, plus every live approval. The
   * runner calls it at a publication and the ordinary event-driven reconcile
   * calls it on activity, so admission and retirement can never disagree.
   */
  const reconcilePresentation = (): void => {
    questionController?.reconcile()
    withdrawReplacedApprovals()
  }

  /**
   * The commit-section half: state-only, non-throwing (the renderer's own frame
   * failure routes to its fatal sink), no Host read.
   */
  const withdrawReplacedPresentation = (): void => {
    if (options.isCleanedUp()) return
    questionController?.withdrawReplacedPresentation()
    withdrawReplacedApprovals()
    options.livePresenter()?.closeTransientList()
  }

  return {
    attach(port, deps) {
      // PR3-A: a renderer that cannot present interactive modals (the
      // read-only TSP renderer) still registers BOTH answerers, but
      // fail-closed: approvals resolve `'unavailable'` (the official
      // `ask`-policy no-answerer outcome — NEVER an implicit allow), questions
      // delegate to `next()` so the Host's own timed-wait/continued lifecycle
      // owns them, and the dock pins an OBSERVABLE notice. No promise is
      // swallowed and no answer is fabricated.
      if (options.display().supportsModals === false) {
        // The refusal must be observable AT THE TIME OF THE REQUEST, not only at
        // attach: the dock notice is transient (a hydrate-tail reset clears it and
        // enough ordinary notices evict it), and a programmatic or timed request
        // can arrive with no other carrier — leaving the user with no visible
        // explanation at all. Re-publishing on every unsupported request keeps the
        // notice current without fabricating an answer.
        const publishUnsupportedNotice = (): void => {
          options.display().setDockNotice({
            id: 'modals-unsupported',
            text: 'Question/Approval dialogs are not answerable in this read-only renderer — approvals fail closed and questions time out to their continued lifecycle',
            kind: 'info',
          })
        }
        publishUnsupportedNotice()
        port.onApprovalRequest((req, next) => {
          if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
          publishUnsupportedNotice()
          return Promise.resolve<ApprovalOutcome>('unavailable')
        })
        port.questions.onRequest(async (_request, next) => {
          publishUnsupportedNotice()
          return next()
        })
        return
      }
      // The interactive answerer: every approval ask becomes a dialog. An
      // already-aborted request settles cancelled synchronously; otherwise
      // the prompt's own abort signal withdraws it (turn cancel). P7c: the
      // dialog previews the paired tool call's arguments and flags dangerous
      // commands.
      port.onApprovalRequest((req, next) => {
        if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
        // The owner is GONE (a request can still arrive during exit teardown): the
        // fail-closed cancellation, never a registration nothing can drain (F11).
        if (ended || options.isCleanedUp()) return Promise.resolve<ApprovalOutcome>('cancelled')
        const args = req.callId === undefined ? undefined : deps.lookupCallArgs(req.callId)
        // This request's OWN presentation lifetime (F9) and its borrowed-abort
        // release (F11).
        const { lifetime, release, retire } = presentationLifetime(req.signal)
        const sessionId = req.sessionId
        if (sessionId !== undefined && !isAdmissible(sessionId)) {
          // A request whose Session the surface no longer shows (B3 finding F10):
          // it is NEVER presented. With a Host-owned lifetime only the Host ends
          // it (unchanged). With NO Host lifetime there is no later retirement to
          // wait for — this request arrives AFTER its Session was replaced — so
          // THIS owner settles it fail-closed AT ADMISSION (external review P2-A)
          // instead of leaving it pending until the whole TUI exits.
          return req.signal === undefined
            ? Promise.resolve<ApprovalOutcome>('cancelled')
            : waitForLifetime(lifetime, release)
        }
        if (sessionId !== undefined) liveApprovals.set(lifetime, { sessionId, retire })
        return options.presenter().showApprovalPrompt({
          toolName: req.toolName,
          reason: req.reason,
          signal: lifetime,
          ...args === undefined ? {} : { arguments: args },
          ...args !== undefined && req.toolName === 'bash' && deps.dangerCommand(args) ? { danger: true } : {},
        }, true).finally(() => {
          liveApprovals.delete(lifetime)
          release()
        })
      })
      // The interactive question answerer: ask_user_question tool calls
      // become dialog flows; the tool receives the structured answers. M3-3B
      // layers the timed/continued lifecycle AROUND the same QuestionFlow
      // (`QuestionSurfaceController`): the live request is the only mount
      // path, the controller owns the claim/countdown, and a timed-out
      // question stays reachable as a continued late answer.
      // M3-3B: the settled `userQuestions` projection is the authoritative
      // final answer of a timed-out call, so the transcript card renders what
      // the user finally answered instead of the timeout payload.
      options.presenter().setSettledQuestionAnswersLookup((callId) => {
        const sessionId = options.currentSessionId()
        if (sessionId === undefined) return undefined
        return port.questions.snapshot(sessionId)?.settled.find(entry => entry.callId === callId)?.answers
      })
      const controller = new QuestionSurfaceController({
        port: port.questions,
        // The controller decides per presentation whether the Agent is blocked
        // on the answer: a LIVE foreground wait is, a CONTINUED late answer is not.
        ask: (questions, signal, status, agentInputWait) =>
          options.presenter().askQuestions(questions, signal, status, agentInputWait),
        notify: (message, level) => { options.presenter().notify(message, level) },
        repaint: () => options.schedulePaint(),
        currentSessionId: () => options.currentSessionId(),
        isAdmissibleSession: sessionId => options.isAdmissibleSession(sessionId),
        // PR3-B B3 (finding C): a live foreground flow whose Session no longer
        // owns the surface is withdrawn from the PRESENTATION only (the official
        // request keeps its own lifetime). The read is the non-throwing one: the
        // controller is retired before the presenter in the teardown order.
        withdrawPresentation: lifetime => { options.livePresenter()?.withdrawPresentation(lifetime) },
        diag: options.diag(),
      })
      controller.attach()
      questionController = controller
      // Task Center attention invalidation is a PRESENTATION-only refresh: it
      // never re-lists the Subagent catalog or touches the Job registry
      // (addendum §9.4).
      questionAttentionDisposal = controller.subscribeAttention(() => {
        publishAttention()
        options.onAttentionChanged()
      })
      publishAttention()
    },
    controller: () => questionController,
    attentionRows: () => questionController?.attentionRows() ?? [],
    publishAttention,
    withdrawReplacedApprovals,
    reconcilePresentation,
    withdrawReplacedPresentation,
    dispose() {
      if (ended) return
      ended = true
      // Retire every one-shot slot before its callback runs: a throwing release
      // can never strand the later ones, and a second dispose is inert.
      const questionAttention = questionAttentionDisposal
      const controller = questionController
      questionAttentionDisposal = undefined
      questionController = undefined
      // PR3-B B3 (§3.2.4): the ORDER is part of the contract. The controller
      // retires FIRST, so a live question/approval is still classified by the
      // Host's own ASK_ABORTED / ASK_CANCELLED path; only then does the
      // presenter withdraw the promises it still owns (a TSP form whose modal
      // dies with the surface), and the settled lookup is cleared last so no
      // late repaint can reach through it.
      runSyncDisposalSteps('interaction runtime disposal', [
        () => questionAttention?.(),
        () => controller?.dispose(),
        () => options.livePresenter()?.withdrawPending(),
        // F11: a refused admission never reached the seat, so THIS owner drains
        // it here — exactly once, and its borrowed Host listener is detached with
        // it. Nothing may outlive the surface as an unowned pending promise.
        () => { for (const finish of [...refusedPresentations]) finish() },
        // The pending approvals were settled by the withdrawal above; the
        // registry must not outlive the presenter it addresses.
        () => { liveApprovals.clear() },
        () => options.livePresenter()?.setSettledQuestionAnswersLookup(undefined),
      ])
    },
  }
}
