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
 *   approval prompt stays with the mounted app;
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
import type { Diag } from '../../diag.ts'
import { runSyncDisposalSteps } from '../../disposal.ts'
import type { TuiApp } from '../../tui-app.ts'
import type { InteractionPort } from '../../runtime/interaction-port.ts'
import type { QuestionAttentionRow } from '../../task-center-attention.ts'
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
  /** The mounted app (throws before `start()`), read through the aggregate. */
  readonly mounted: () => TuiApp
  /** The mounted app WITHOUT the not-mounted throw (the teardown path reads it). */
  readonly liveApp: () => TuiApp | undefined
  /** The live routed session id (the authoritative read of a settled answer). */
  readonly currentSessionId: () => string | undefined
  /** The surface coalesced repaint (the controller asks for it after a mutation). */
  readonly schedulePaint: () => void
  /** The attached Task Center's diagnostics channel (late-bound: the Task Center
   *  owns it and is attached before this owner). */
  readonly diag: () => Diag
  /** The aggregate's cleanup latch (a retired surface publishes nothing). */
  readonly isCleanedUp: () => boolean
  /** Publish the parked-Question count into the surface chrome. */
  readonly setQuestionAttention: (parkedCount: number) => void
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
   * Publish how many PARKED actionable Questions exist, so the footer's ↓
   * trigger and the Quick Task Center stay reachable for a Questions-only
   * session (addendum §11). A visible Question is not counted: it already owns
   * the editor seat. This never touches the active-work counts.
   */
  const publishAttention = (): void => {
    if (options.isCleanedUp()) return
    const rows = questionController?.attentionRows() ?? []
    options.setQuestionAttention(rows.filter(row => row.presentation === 'parked').length)
  }

  return {
    attach(port, deps) {
      // The interactive answerer: every approval ask becomes a dialog. An
      // already-aborted request settles cancelled synchronously; otherwise
      // the prompt's own abort signal withdraws it (turn cancel). P7c: the
      // dialog previews the paired tool call's arguments and flags dangerous
      // commands.
      port.onApprovalRequest((req, next) => {
        if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
        const args = req.callId === undefined ? undefined : deps.lookupCallArgs(req.callId)
        return options.mounted().showApprovalPrompt({
          toolName: req.toolName,
          reason: req.reason,
          signal: req.signal,
          ...args === undefined ? {} : { arguments: args },
          ...args !== undefined && req.toolName === 'bash' && deps.dangerCommand(args) ? { danger: true } : {},
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
      options.mounted().setSettledQuestionAnswersLookup((callId) => {
        const sessionId = options.currentSessionId()
        if (sessionId === undefined) return undefined
        return port.questions.snapshot(sessionId)?.settled.find(entry => entry.callId === callId)?.answers
      })
      const controller = new QuestionSurfaceController({
        port: port.questions,
        ask: (questions, signal, status) => options.mounted().askQuestions(questions, signal, status),
        notify: (message, level) => { options.mounted().notify(message, level) },
        repaint: () => options.schedulePaint(),
        currentSessionId: () => options.currentSessionId(),
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
    dispose() {
      // Retire every one-shot slot before its callback runs: a throwing release
      // can never strand the later ones, and a second dispose is inert.
      const questionAttention = questionAttentionDisposal
      const controller = questionController
      questionAttentionDisposal = undefined
      questionController = undefined
      runSyncDisposalSteps('interaction runtime disposal', [
        () => questionAttention?.(),
        () => controller?.dispose(),
        () => options.liveApp()?.setSettledQuestionAnswersLookup(undefined),
      ])
    },
  }
}
