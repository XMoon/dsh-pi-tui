/**
 * The BOUND submission runtime (A3 plan §4.1/§4.3/§10.3): the submission
 * domain's own application owner.
 *
 * It owns two things:
 *
 * 1. the PLAIN-PROMPT write orchestration — the fixed order
 *    `writer admission → capability admission → prepare message → semantic
 *    write → durable settlement → draft consume/restore` (`plan §10.3`),
 *    entered through `SessionRuntime.withWriter` so the writer-first /
 *    transition-first contract and the per-Agent image admission window are
 *    unchanged;
 * 2. the deferred QUEUE-RECALL state (`deferQueueRecall` /
 *    `settleQueueRecalls`), which the session runtime only decides WHEN to
 *    settle through `SessionRuntimeSurface.settlePendingQueueRecalls`.
 *
 * The TUI surface (editor, notify, submit ack, pending-input echo, Client-local
 * draft stores) stays in the runner as narrow hooks — this module decides the
 * ORDER, the runner performs the operation. It never sees a Direct module, a
 * Host Agent or a raw `ctx.*` service.
 * @module @xmoon76/dsh-pi-tui/app/submission/runtime
 */

import { cancellationError } from '../../detached.ts'
import { TransitionInProgressError } from '../../session-operation-barrier.ts'
import type { PreparedMessage, WriteOutcome } from '../../runtime/session-writer-port.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../session/scope.ts'

/** One accepted queue pull-back whose local representation waits on a transition. */
export interface PendingQueueRecall {
  /** The transition committed: keep the pulled-back queue removal. */
  commit(): void
  /** The transition failed: restore the recalled text and release its drafts. */
  abort(): void
}

/** One plain-prompt submission the runtime must write. */
export interface PromptSubmission {
  readonly text: string
  /** The atomically-captured live scope: writer admission + currentness fence. */
  readonly scope: LiveSessionScope
  /** The gesture's request identity (the local submission echo). */
  readonly requestId: string
  /** The gesture's submit-ack epoch token. */
  readonly ackToken: number
  /** The generation captured with the submission identity (echo bookkeeping). */
  readonly generation: number
  /** Whether the caller already installed the local echo synchronously. */
  readonly echoInstalled: boolean
}

/** The runner-supplied TUI operations the runtime drives. */
export interface SubmissionRuntimeSurface {
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
  /** The owner-resolved per-Agent prompt/image admission window (reads the
   *  CURRENT Direct attachment inside the held writer section). */
  withPromptAdmission<T>(scope: LiveSessionScope, line: string, task: () => Promise<T>): Promise<T>
  /** Whether the surface is already disposed (`cleanedUp`). */
  isDisposed(): boolean
  /** The scope authority's synchronous currentness read (the ORIGINAL fence). */
  isScopeCurrent(scope: LiveSessionScope): boolean
  /** Merge `text` into the editor, returning whether it came back VERBATIM. */
  mergeDraftIntoEditor(text: string): boolean
  /** Consume ONLY the image/file drafts referenced by one committed write. */
  consumeDraftAttachments(text: string): void
  /** Start the latency dispatch mark for one session. */
  markDispatch(sessionId: string): void
  /** Publish one local submission echo (the runner owns its placement). */
  beginLocalSubmission(input: {
    readonly requestId: string
    readonly text: string
    readonly scope: LiveSessionScope
    readonly generation: number
    readonly ackToken: number
  }): void
  /** Remove one local submission echo on a known terminal exit. */
  settleLocalSubmission(requestId: string): void
  /** Settle the local submit-ack row for one gesture token. */
  settleSubmitAck(reason: string, options: { readonly token: number; readonly terminal: true }): void
  notify(message: string, kind: 'error'): void
  /** The transition write fence refusal (restore the draft + notify). */
  refuseByTransitionFence(text: string): void
  /** Prepare the outgoing message (image/file admission + canonicalization). */
  prepareMessage(text: string, requestId: string): Promise<PreparedMessage>
  /** The semantic session write. */
  prompt(sessionId: string, message: PreparedMessage): Promise<WriteOutcome>
}

export interface SubmissionRuntimeDeps {
  readonly surface: SubmissionRuntimeSurface
}

export interface SubmissionRuntime {
  /** Park one confirmed queue pull-back until its transition settles. */
  deferQueueRecall(recall: PendingQueueRecall): void
  /** Settle every parked recall: commit keeps the removal, abort restores it. */
  settleQueueRecalls(committed: boolean): void
  /**
   * Run one plain-prompt write through the writer barrier. The caller owns the
   * reserved-submit pin/release/restore wrapper; this method owns the ordered
   * write and its terminal ack/echo settlement.
   */
  submitPrompt(submission: PromptSubmission): Promise<void>
}

const STALE_NOTICE =
  'the session changed while sending — try again'
const STALE_MERGED_NOTICE =
  'the draft changed while sending — review it before submitting again (the earlier text was preserved below)'

export function bindSubmissionRuntime(deps: SubmissionRuntimeDeps): SubmissionRuntime {
  const surface = deps.surface
  // Alt+Up may finish a queue mutation while a transition is waiting on the
  // same writer barrier. Keep its confirmed local representation until the
  // transition outcome is known: commit drops it, failure restores it.
  const pendingQueueRecalls: PendingQueueRecall[] = []

  const settleQueueRecalls = (committed: boolean): void => {
    const recalls = pendingQueueRecalls.splice(0)
    for (const recall of recalls) {
      if (committed) recall.commit()
      else recall.abort()
    }
  }

  /** Restore the submission and settle its gesture as stale (the ORIGINAL branch). */
  const settleStaleSubmission = (submission: PromptSubmission): void => {
    const verbatim = surface.mergeDraftIntoEditor(submission.text)
    surface.settleLocalSubmission(submission.requestId)
    surface.settleSubmitAck('submit stale', { token: submission.ackToken, terminal: true })
    surface.notify(verbatim ? STALE_NOTICE : STALE_MERGED_NOTICE, 'error')
  }

  const submitPrompt = async (submission: PromptSubmission): Promise<void> => {
    const { text, scope, requestId, ackToken } = submission
    let echoInstalled = submission.echoInstalled
    const sessionId = scope.sessionId
    try {
      // The WHOLE write (admission → capability → prepare → write → consume)
      // runs inside the operation barrier and, for an image-bearing draft,
      // inside the SAME per-Agent serialization window as a `/model` selection.
      await surface.withWriter(scope, () => surface.withPromptAdmission(scope, text, async () => {
        // Install the local echo before the first async admission await when
        // the gesture did not already install it synchronously (a deferred
        // start, or a line the final catalog resolved as an ordinary prompt).
        if (!echoInstalled) {
          surface.beginLocalSubmission({ requestId, text, scope, generation: submission.generation, ackToken })
          echoInstalled = true
        }
        const message = await surface.prepareMessage(text, requestId)
        if (surface.isDisposed()) return
        // Re-check the captured scope identity AFTER the async admission (the
        // guard-window rule, AGENTS.md). This is the site's ORIGINAL fence
        // moment — it must not move to the writer admission.
        if (!surface.isScopeCurrent(scope)) {
          settleStaleSubmission(submission)
          return
        }
        // T1 BEFORE the write call: a synchronously-emitted inbox/turn event
        // (Direct in-process) must never log ahead of dispatch.
        surface.markDispatch(sessionId)
        const outcome = await surface.prompt(sessionId, message)
        if (surface.isDisposed()) return
        if (outcome.kind !== 'committed') {
          if (outcome.kind === 'indeterminate') {
            if (surface.isDisposed()) return
            surface.settleLocalSubmission(requestId)
            surface.settleSubmitAck('session write result indeterminate', { token: ackToken, terminal: true })
            surface.notify('session write result is indeterminate — do not retry automatically', 'error')
            return
          }
          if (outcome.kind === 'cancelled') throw cancellationError('session write cancelled')
          const failure = outcome.kind === 'rejected' ? outcome.error.message : outcome.reason
          throw new Error(failure)
        }
        // Consume ONLY the referenced drafts — a concurrent intake's newer
        // image survives.
        surface.consumeDraftAttachments(text)
      }))
    } catch (error) {
      if (surface.isDisposed()) return
      if (error instanceof TransitionInProgressError) {
        surface.settleLocalSubmission(requestId)
        surface.settleSubmitAck('submit refused by transition fence', { token: ackToken, terminal: true })
        surface.refuseByTransitionFence(text)
        return
      }
      // A stale capture is refused at the writer admission (BEFORE the task
      // body); it takes the SAME user-visible stale path as the post-prepare
      // fence above — never the frozen-transition refusal.
      if (error instanceof SessionScopeSupersededError) {
        settleStaleSubmission(submission)
        return
      }
      throw error
    }
  }

  return {
    deferQueueRecall: (recall) => { pendingQueueRecalls.push(recall) },
    settleQueueRecalls,
    submitPrompt,
  }
}
