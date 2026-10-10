/**
 * SurfaceInteractionPresenter (PR3-B §3.2): the renderer-facing modal
 * presentation seam the interaction runtime consumes instead of the PiTui
 * `TuiApp`.
 *
 * The contract is exactly the members `app/surface/interaction-runtime.ts`
 * uses to present Question/Approval modals, its notice line and its
 * parked-count projection, with the types expressed through the presenter
 * module so the interaction owner reads them from their application-side seam.
 * The shared declarations stay where they are (re-exported by the stable
 * `tui-app.ts` facade — the same path the previous `TuiApp` import used, which
 * the architecture gate admits); this module only re-exports them as the
 * presenter's contract surface, so no consumer breaks and no DTO duplication
 * enters the tree.
 *
 * The PiTui implementation is the narrow delegating adapter
 * {@link pituiSurfaceInteractionPresenter} over the mounted `TuiApp`: the app
 * itself is NOT the presenter any more, because `withdrawPending` has no
 * `TuiApp` counterpart — on that branch the app's own `dispose()` stays the
 * ONE pending-prompt cancellation owner. A TSP implementation is tied to
 * exactly one live form per request — it never mints a second question/
 * approval lifecycle owner (`QuestionSurfaceController` stays the ONE
 * controller either way).
 * @module @xmoon76/dsh-pi-tui/app/surface/interaction-presenter
 */

import type {
  ApprovalOutcome,
  ApprovalPromptRequest,
  TuiApp,
  TuiQuestion,
  TuiQuestionAnswer,
  TuiQuestionStatus,
} from '../../tui-app.ts'

export type { ApprovalOutcome, ApprovalPromptRequest }
export type { TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus }

/**
 * The authoritative settled-answer lookup the presenter installs: given a
 * settled question call id, the authoritative final answers (or undefined
 * when the projection has no settled entry for it). Same shape as
 * `TuiApp.setSettledQuestionAnswersLookup`.
 */
export type SettledQuestionAnswersLookup = (callId: string) => readonly { id: string; selected: string[]; custom?: string }[] | undefined

/**
 * The modal presentation capabilities the interaction owner consumes.
 * Semantics of each member mirror the same-named `TuiApp` method exactly.
 */
export interface SurfaceInteractionPresenter {
  /** Present one approval prompt (`TuiApp.showApprovalPrompt`). */
  showApprovalPrompt(request: ApprovalPromptRequest, agentInputWait: boolean): Promise<ApprovalOutcome>
  /**
   * Ask the user one or more questions (`TuiApp.askQuestions`). The promise
   * resolves with the answers in question order, or rejects with the flow's
   * cancellation error.
   */
  askQuestions(
    questions: readonly TuiQuestion[],
    signal: AbortSignal | undefined,
    status: TuiQuestionStatus | undefined,
    agentInputWait: boolean,
  ): Promise<TuiQuestionAnswer[]>
  /**
   * Install the authoritative settled-answer lookup (`TuiApp.
   * setSettledQuestionAnswersLookup`); `undefined` clears it (teardown).
   */
  setSettledQuestionAnswersLookup(lookup: SettledQuestionAnswersLookup | undefined): void
  /** One transient user-facing notice (`TuiApp.notify`). */
  notify(text: string, kind?: 'error' | 'info'): void
  /**
   * Present the authoritative parked-Question count (`TuiApp.
   * setQuestionAttention`). A PRESENTATION of the count the interaction
   * owner read from its ONE controller — never a second registry, and never
   * an answerability fact.
   */
  setQuestionAttention(parkedCount: number): void
  /**
   * Synchronously end this presenter's queued/active promises on surface
   * teardown, so no caller is left hanging. Called by the interaction owner
   * AFTER its controller is retired (the controller's own disposal classifies
   * the Host outcome first).
   */
  withdrawPending(): void
  /**
   * PR3-B B3 (findings C/F6/F7): withdraw the PRESENTATION of ONE live official
   * request (approval or question flow) identified by the exact lifetime object
   * its presenter call received, when a newly committed Session has taken the
   * surface. The promise is NOT settled and the flow is NOT cancelled: the
   * official request keeps its own Host-owned lifetime (its abort still ends it
   * through the ordinary path), and nothing of the replacement subject is
   * touched. A request whose presentation is still opening is retired too — its
   * form is never mounted. A renderer whose presentation seat can outlive a
   * session switch (the TSP `layer` modal) implements this; the others may leave
   * it inert.
   */
  withdrawPresentation(lifetime: AbortSignal): void
}

/**
 * The exact `TuiApp` members the PiTui presenter adapts. Declared structurally
 * so a test can supply a narrow recording double without an `as`-cast, and so
 * the adapter's delegation surface is exactly the five methods it forwards.
 */
export type PiTuiInteractionApp = Pick<
  TuiApp,
  'showApprovalPrompt' | 'askQuestions' | 'setSettledQuestionAnswersLookup' | 'notify' | 'setQuestionAttention'
>

/**
 * The PiTui presenter: a narrow delegating adapter over the ONE mounted
 * `TuiApp`. Every member forwards to the same-named app method with the app as
 * receiver (a spread such as `{ ...app }` would lose the receiver), and
 * `withdrawPending` is deliberately a NO-OP — the app's own `dispose()`, which
 * the surface runs right after the interaction owner, is the ONE cancellation
 * owner on this branch. It never simulates an answer or swallows an app error.
 * `withdrawPresentation` is a NO-OP for the same ownership reason: PiTui keeps
 * its long-standing session-switch behavior (a mounted editor-seat flow is NOT
 * withdrawn by a switch there), and this slice changes no PiTui behavior.
 */
export function pituiSurfaceInteractionPresenter(app: PiTuiInteractionApp): SurfaceInteractionPresenter {
  return {
    showApprovalPrompt: (request, agentInputWait) => app.showApprovalPrompt(request, agentInputWait),
    askQuestions: (questions, signal, status, agentInputWait) => app.askQuestions(questions, signal, status, agentInputWait),
    setSettledQuestionAnswersLookup: lookup => { app.setSettledQuestionAnswersLookup(lookup) },
    notify: (text, kind) => { app.notify(text, kind) },
    setQuestionAttention: parkedCount => { app.setQuestionAttention(parkedCount) },
    withdrawPending: () => {},
    withdrawPresentation: () => {},
  }
}
