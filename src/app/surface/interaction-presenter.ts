/**
 * SurfaceInteractionPresenter (PR3-B §3.2): the renderer-facing modal
 * presentation seam the interaction runtime consumes instead of the PiTui
 * `TuiApp`.
 *
 * The contract is exactly the four members `app/surface/interaction-runtime.ts`
 * uses to present Question/Approval modals plus its notice line, with the
 * types expressed through the presenter module so the interaction owner reads
 * them from their application-side seam. The shared declarations stay where
 * they are (re-exported by the stable `tui-app.ts` facade — the same path the
 * previous `TuiApp` import used, which the architecture gate admits); this
 * module only re-exports them as the presenter's contract surface, so no
 * consumer breaks and no DTO duplication enters the tree.
 *
 * `TuiApp` satisfies this interface structurally; the PiTui implementation is
 * the mounted app itself. A TSP implementation is tied to exactly one live
 * form per request — it never mints a second question/approval lifecycle
 * owner (`QuestionSurfaceController` stays the ONE controller either way).
 * @module @xmoon76/dsh-pi-tui/app/surface/interaction-presenter
 */

import type {
  ApprovalOutcome,
  ApprovalPromptRequest,
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
}
