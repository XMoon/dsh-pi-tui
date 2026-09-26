/**
 * The BOUND submission runtime (A3 plan §4.1/§4.3/§10.3): the submission
 * domain's own application owner.
 *
 * It owns three things:
 *
 * 1. the PLAIN-PROMPT write orchestration — the fixed order
 *    `writer admission → capability admission → prepare message → semantic
 *    write → durable settlement → draft consume/restore` (`plan §10.3`),
 *    entered through `SessionRuntime.withWriter` so the writer-first /
 *    transition-first contract and the per-Agent image admission window are
 *    unchanged;
 * 2. the SUBMISSION-domain writer sections — busy delivery / steer, the queue
 *    pull-back removals and the HostCommandPort submission enter the operation
 *    barrier through {@link SubmissionRuntime.withWriter} (the M3
 *    `session/writer-held` insertion point), which delegates to
 *    `SessionRuntime.withWriter`;
 * 3. the deferred QUEUE-RECALL state (`deferQueueRecall` /
 *    `settleQueueRecalls`), which the session runtime only decides WHEN to
 *    settle through `SessionRuntimeSurface.settlePendingQueueRecalls`.
 *
 * The TUI surface (editor, notify, submit ack, pending-input echo, Client-local
 * draft stores) stays in the runner as narrow hooks — this module decides the
 * ORDER, the runner performs the operation. It never sees a Direct module, a
 * Host Agent or a raw `ctx.*` service.
 * @module @xmoon76/dsh-pi-tui/app/submission/runtime
 */

import { randomUUID } from 'node:crypto'
import { cancellationError, isCancellation, runOwned } from '../../detached.ts'
import type { Diag } from '../../diag.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { runReservedSubmit } from '../../image/submit-flow.ts'
import { TransitionInProgressError } from '../../session-operation-barrier.ts'
import {
  formatShellSubmitText,
  submitShellResult,
  type ShellSubmitAgentLike,
} from '../../shell-context.ts'
import type { PreparedMessage, SessionWriter, WriteOutcome } from '../../runtime/session-writer-port.ts'
import type { PendingInputReader, PendingInputSnapshot } from '../../runtime/pending-input-reader-port.ts'
import type { HostCommandOutcome } from '../../runtime/host-command-port.ts'
import {
  hasParkedSteering,
  mergeDraft,
  PARKED_STEERING_NOTICE,
  steerAll,
  steerHasPayload,
  type SteerAgentLike,
} from '../../steer.ts'
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
   * One scope-bound submission writer section (the M3 `session/writer-held`
   * insertion point): busy delivery / steer, the queue pull-back removals and
   * the HostCommandPort submission enter the operation barrier HERE, not
   * through the raw barrier. It delegates to `SessionRuntime.withWriter`, so a
   * stale scope is refused with `SessionScopeSupersededError` and a frozen
   * transition with `TransitionInProgressError` — the writer-first contract is
   * unchanged. No caller re-reads `transitionGate.busy` AFTER it was admitted:
   * the gate is read only as a PRE-admission quick refusal (the command-dispatch
   * check below and the attachment-intake UX fence), never inside an admitted
   * writer section.
   */
  withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
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

  /**
   * The submission-domain writer admission. It is a deliberate delegation to
   * the session runtime's `withWriter`: the barrier stays owned there, while
   * this module is the single caller-side insertion point a future Remote
   * `session/writer-held` recovery hangs off.
   */
  const withWriter = <T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T> =>
    surface.withWriter(scope, task)

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
    withWriter,
    submitPrompt,
  }
}

// ── The submission-facing application entrypoints (A3-4 fix round) ─────────
//
// Each entrypoint owns the `WriteOutcome` classification and the
// draft/queue/card settlement for one submission domain. The runner keeps the
// TUI operations as narrow hooks (editor/card/notify/ack/session-writer); this
// module decides the ORDER and the terminal settlement, and is therefore the
// single place a future `session/writer-held` recovery is added. The helpers
// (`src/steer.ts`, `src/shell-context.ts`) keep their own write bodies.

/**
 * One completed `!` context run's submission (kimi parity). The runner owns the
 * shell card; this entrypoint owns the session write, its ack settlement and
 * the settled-card dismissal.
 */
export interface ShellSubmitDeps {
  readonly command: string
  readonly result: string
  /** The generation the run STARTED under (a later switch skips the submit). */
  readonly generationAtRun: number
  readonly isDisposed: () => boolean
  readonly currentGeneration: () => number
  /** The live session id for the dispatch mark (undefined before a session). */
  readonly currentSessionId: () => string | undefined
  /** The live agent for the helper's own re-validation. */
  readonly currentAgent: () => ShellSubmitAgentLike | undefined
  /** Finish the terminal ack row armed at the gesture. */
  readonly terminalAck: (reason: string) => void
  readonly clearSettledLocalMessages: () => void
  readonly notify: (message: string, kind: 'info' | 'error') => void
  readonly markDispatch: (sessionId: string | undefined) => void
  /** The scope-bound writer section (captures a fresh live scope). */
  readonly writerSection: <T>(task: () => Promise<T>) => Promise<T>
  readonly writer: { prompt(sessionId: string, message: unknown, mode?: 'queue' | 'steer'): Promise<WriteOutcome> }
  readonly createMessage: (text: string) => unknown
  readonly diag: Diag
}

/**
 * Submit one completed `!` shell run to the session: a session switch while the
 * command ran skips the submit; otherwise the helper's re-validate → followup
 * runs and its outcome settles the ack row and the settled card.
 */
export function submitShell(deps: ShellSubmitDeps): void {
  if (deps.isDisposed()) return
  if (deps.currentGeneration() !== deps.generationAtRun) {
    deps.terminalAck('shell submit skipped after a session switch')
    deps.notify('the session changed while the command ran — the output was not submitted', 'error')
    return
  }
  const submitted = formatShellSubmitText(deps.command, deps.result)
  // T1 BEFORE the dispatch: same ordering rule as the Enter path.
  deps.markDispatch(deps.currentSessionId())
  runOwned('shell submit', () => submitShellResult({
    currentAgent: () => deps.currentAgent(),
    currentGeneration: () => deps.currentGeneration(),
    notify: (message, kind) => {
      if (deps.isDisposed()) return
      deps.notify(message, kind)
    },
    staleNotice: () => 'the session changed while the submission was being checked — the output was not submitted',
    // The shell submit is admitted through `writerSection`: a transition that
    // arrives after admission WAITS for the whole write, so the fence carries
    // only the surface lifetime (never the session gate).
    fence: () => deps.isDisposed(),
    writerSection: deps.writerSection,
    fenceNotice: () => 'a session transition is in progress — the output stays on the card; re-run ! after it settles',
    writer: deps.writer,
    createMessage: (text) => deps.createMessage(text),
    onSubmitted: () => {
      if (deps.isDisposed()) return
      // The write was accepted. The ACK ROW STAYS until the first
      // authoritative event (the inbox insert) settles it.
      deps.clearSettledLocalMessages()
    },
  }, submitted), {
    diag: deps.diag,
    sessionId: () => deps.currentAgent()?.session.id,
    onResult: (outcome) => {
      if (deps.isDisposed()) return
      if (outcome !== 'ok') deps.terminalAck(`shell submit ${outcome}`)
      else if (deps.currentAgent() === undefined) deps.terminalAck('shell submit without an agent')
    },
    onCancel: () => {
      if (deps.isDisposed()) return
      deps.terminalAck('shell submit cancelled')
    },
    onError: (error) => {
      if (deps.isDisposed()) return
      // The submission failed before the write ran: keep the card (the output
      // is not lost) and surface the reason.
      deps.terminalAck('shell submit failure')
      deps.notify(`shell submit failed: ${safeErrorMessage(error)}`, 'error')
    },
  })
}

// ── Queue pull-back (Alt+Up) ───────────────────────────────────────────────

/** One pullable queue content block. Structurally the Direct `ContentBlock`
 * union; the runner projects it so this module never imports the Host type. */
export type PullableQueueBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }
  | { readonly type: 'file'; readonly attachment: unknown }

/** One pullable queued occurrence (the runner's semantic queue projection).
 * `content` stays structural: the runner projects the Host content blocks. */
export interface PullableQueueMessage {
  readonly id: string
  readonly content: readonly unknown[]
}

/** The runner-supplied operations the Alt+Up queue pull-back drives. */
export interface PullBackQueueDeps {
  readonly isDisposed: () => boolean
  /** The subagent viewer is read-only: a pull-back there would target the parent. */
  readonly isViewing: () => boolean
  /** The live Agent identity (structural). */
  readonly currentAgent: () => { readonly session: { readonly id: string } } | undefined
  /** Capture the owner subject token synchronously (identity fence). */
  readonly captureOwnerToken: () => unknown
  /** Whether a captured owner token is still the current owner. */
  readonly isOwnerTokenCurrent: (token: unknown) => boolean
  /** Capture the live session scope for the writer admission (throws if absent). */
  readonly requireLiveScope: () => LiveSessionScope
  /** The queued occurrences to pull back (`undefined` = no projection). */
  readonly readPullableQueue: (sessionId: string) => readonly PullableQueueMessage[] | undefined
  /** A transition is queued or already holds the barrier. */
  readonly isTransitionPending: () => boolean
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  readonly withWriter: <T>(scope: LiveSessionScope, task: () => Promise<T>) => Promise<T>
  /** The official single-item queue removal. */
  readonly updateQueue: (
    sessionId: string,
    messageId: string,
    operation: { readonly kind: 'remove' },
  ) => Promise<WriteOutcome>
  /** Park one confirmed recall until its transition settles. */
  readonly deferQueueRecall: (recall: PendingQueueRecall) => void
  /** Stage one durable queued image as a recalled draft; returns its id + placeholder. */
  readonly stageRecalledImage: (attachment: unknown) => { readonly id: number; readonly placeholder: string }
  /** Stage one durable queued file as a recalled draft; returns its id + placeholder. */
  readonly stageRecalledFile: (attachment: unknown) => { readonly id: number; readonly placeholder: string }
  /** Drop one staged recalled draft. */
  readonly discardStagedDraft: (kind: 'image' | 'file', id: number) => void
  /** Pin the recalled drafts for the duration of the writer section. */
  readonly pinRecalledDrafts: (text: string) => () => void
  readonly readDraft: () => string
  readonly writeDraft: (text: string) => void
  readonly notify: (message: string, kind: 'info' | 'error') => void
  readonly refreshPendingInput: () => void
  readonly diag: Diag
}

/**
 * Alt+Up queue pull-back: stage every queued occurrence as recalled drafts
 * (durable image/file refs are reused), then remove each occurrence FIFO
 * through the semantic writer. The queue is spliced only after the drafts are
 * staged; a confirmed prefix is reflected only after settlement. A waiting
 * transition defers the local representation to {@link PendingQueueRecall}.
 */
export function pullBackQueue(deps: PullBackQueueDeps): void {
  if (deps.isDisposed() || deps.isViewing()) return
  const queuedAgent = deps.currentAgent()
  if (queuedAgent === undefined) return
  const queuedSubject = deps.captureOwnerToken()
  // The scope-bound writer admission for the pull-back removals: ONE atomic
  // capture with the subject fence above.
  const queuedScope = deps.requireLiveScope()
  const queued = deps.readPullableQueue(queuedAgent.session.id)
  if (queued === undefined || queued.length === 0) return
  // Multimodal queued messages (durable attachments) ARE pullable: each block
  // becomes a RECALLED draft. The queue is spliced ONLY after the drafts are
  // staged (a failure keeps the queue intact).
  let recalledText = ''
  const staged: { kind: 'image' | 'file'; id: number }[] = []
  const recalledEntries: { text: string; staged: { kind: 'image' | 'file'; id: number }[] }[] = []
  try {
    const lines: string[] = []
    for (const message of queued) {
      const messageStaged: { kind: 'image' | 'file'; id: number }[] = []
      const parts: string[] = []
      for (const raw of message.content) {
        const block = raw as PullableQueueBlock
        if (block.type === 'text') {
          parts.push(block.text)
        } else if (block.type === 'image') {
          const draft = deps.stageRecalledImage(block.attachment)
          staged.push({ kind: 'image', id: draft.id })
          messageStaged.push({ kind: 'image', id: draft.id })
          parts.push(draft.placeholder)
        } else if (block.type === 'file') {
          const draft = deps.stageRecalledFile(block.attachment)
          staged.push({ kind: 'file', id: draft.id })
          messageStaged.push({ kind: 'file', id: draft.id })
          parts.push(draft.placeholder)
        }
      }
      const messageText = parts.join('')
      lines.push(messageText)
      recalledEntries.push({ text: messageText, staged: messageStaged })
    }
    recalledText = lines.join('\n\n')
  } catch (error) {
    // The recalled drafts could not be staged (capacity): roll back the drafts
    // staged so far and keep the queue fully intact — nothing removed, no
    // capacity leaked.
    for (const entry of staged) deps.discardStagedDraft(entry.kind, entry.id)
    deps.notify(safeErrorMessage(error), 'error')
    return
  }
  // Pin recalled refs before the first async boundary. The editor still lacks
  // these placeholders until the semantic queue removal commits, so an
  // attach-time prune must not delete them in the meantime.
  const releaseRecalled = deps.pinRecalledDrafts(recalledText)
  let draftApplied = false
  let settledRemovals = 0
  let failureKind: 'transition' | 'stale' | 'indeterminate' | 'cancelled' | undefined
  const discardStaged = (from = 0): void => {
    for (const entry of recalledEntries.slice(from)) {
      for (const attachment of entry.staged) deps.discardStagedDraft(attachment.kind, attachment.id)
    }
  }
  let deferredToTransition = false
  const deferRecalledToTransition = (count: number): void => {
    discardStaged(count)
    const restoreText = recalledEntries.slice(0, count).map(entry => entry.text).join('\n\n')
    deps.deferQueueRecall({
      commit: () => {
        discardStaged()
        releaseRecalled()
      },
      abort: () => {
        if (deps.isDisposed() || !deps.isOwnerTokenCurrent(queuedSubject)) {
          discardStaged()
          releaseRecalled()
          return
        }
        if (restoreText !== '') {
          const current = deps.readDraft()
          deps.writeDraft(current === '' ? restoreText : `${restoreText}\n\n${current}`)
        }
        deps.refreshPendingInput()
        releaseRecalled()
      },
    })
    deferredToTransition = true
  }
  // Remove each pulled-back occurrence through the official single-item queue
  // mutation, FIFO admission keeps pending input behind it; confirmed removals
  // are reflected only after each settlement. The write enters through the
  // submission runtime's writer admission.
  runOwned('queue pull-back', () => deps.withWriter(queuedScope, async () => {
    try {
      if (deps.isDisposed()) {
        for (const entry of staged) deps.discardStagedDraft(entry.kind, entry.id)
        return
      }
      if (!deps.isOwnerTokenCurrent(queuedSubject)) {
        discardStaged()
        deps.notify('the session changed while pulling messages back — try again', 'info')
        return
      }
      const outcomes: WriteOutcome[] = []
      for (const message of queued) {
        const next = await deps.updateQueue(
          queuedAgent.session.id,
          message.id,
          { kind: 'remove' },
        )
        outcomes.push(next)
        if (next.kind !== 'committed') break
        settledRemovals += 1
      }
      const outcome = outcomes[outcomes.length - 1]!
      const confirmed = recalledEntries.slice(0, settledRemovals)
      // Final disposal may happen while the semantic removal is in flight.
      // Leave recalled refs owned by this dead workflow rather than touching
      // the disposed app; in particular, an indeterminate removal must never
      // discard the only local representation.
      if (deps.isDisposed()) return
      if (deps.isTransitionPending()) {
        const preserveCount = outcome.kind === 'committed' || outcome.kind === 'indeterminate'
          ? recalledEntries.length
          : settledRemovals
        deferRecalledToTransition(preserveCount)
        return
      }
      if (outcome.kind === 'committed') {
        const current = deps.readDraft()
        deps.writeDraft(recalledText === '' ? current : current === '' ? recalledText : `${recalledText}\n\n${current}`)
        draftApplied = true
        deps.refreshPendingInput()
        return
      }
      if (outcome.kind === 'indeterminate') {
        // Keep the staged recalled refs visible for manual review. The queue
        // state is unknown, so this must not silently discard the only local
        // representation or trigger an automatic retry.
        const current = deps.readDraft()
        deps.writeDraft(recalledText === '' ? current : current === '' ? recalledText : `${recalledText}\n\n${current}`)
        draftApplied = true
        deps.notify('queue pull-back result is indeterminate — do not retry automatically', 'error')
        return
      }
      // A known refusal means only the confirmed prefix was removed. Preserve
      // that prefix in the draft and release staged refs for rows that remain
      // in the queue; never pretend this was atomic.
      discardStaged(confirmed.length)
      const confirmedText = confirmed.map(entry => entry.text).join('\n\n')
      if (confirmedText !== '') {
        const current = deps.readDraft()
        deps.writeDraft(current === '' ? confirmedText : `${confirmedText}\n\n${current}`)
      }
      draftApplied = true
      if (outcome.kind === 'cancelled') throw cancellationError('queue pull-back cancelled')
      const failure = outcome.kind === 'rejected' ? outcome.error.message : outcome.reason
      deps.notify(`queue pull-back stopped after ${confirmed.length} message${confirmed.length === 1 ? '' : 's'}: ${failure}`, 'error')
      deps.refreshPendingInput()
    } catch (error) {
      // Preserve or discard local representations before releasing the writer
      // barrier. A waiting transition must not overtake this reconciliation
      // and prune/cross-session the recalled draft.
      if (deps.isDisposed()) {
        discardStaged()
        throw error
      }
      if (deps.isTransitionPending()) {
        if (!draftApplied) {
          deferRecalledToTransition(isCancellation(error) ? settledRemovals : recalledEntries.length)
        }
        failureKind = 'transition'
        throw error
      }
      if (draftApplied) throw error
      if (error instanceof TransitionInProgressError) {
        discardStaged()
        failureKind = 'transition'
        throw error
      }
      if (!deps.isOwnerTokenCurrent(queuedSubject)) {
        discardStaged()
        failureKind = 'stale'
        throw error
      }
      if (isCancellation(error)) {
        discardStaged(settledRemovals)
        const confirmedText = recalledEntries.slice(0, settledRemovals).map(entry => entry.text).join('\n\n')
        if (confirmedText !== '') {
          const current = deps.readDraft()
          deps.writeDraft(current === '' ? confirmedText : `${confirmedText}\n\n${current}`)
        }
        draftApplied = true
        failureKind = 'cancelled'
        throw error
      }
      const current = deps.readDraft()
      deps.writeDraft(recalledText === '' ? current : current === '' ? recalledText : `${recalledText}\n\n${current}`)
      draftApplied = true
      failureKind = 'indeterminate'
      throw error
    } finally {
      // Release the pin while the writer still owns the barrier. The outer
      // finally is idempotent and only covers pre-entry refusal.
      if (!deferredToTransition) releaseRecalled()
    }
  }).catch(error => {
    // A pre-entry refusal never enters the callback above, so its staged
    // representation is reconciled by this outer catch only. A frozen
    // transition and a superseded capture are DIFFERENT refusals: the stale
    // one must drop the staged attachments and report the stale notice,
    // never the transition one.
    if (error instanceof TransitionInProgressError) {
      discardStaged()
      failureKind = 'transition'
    } else if (error instanceof SessionScopeSupersededError) {
      discardStaged()
      failureKind = 'stale'
    }
    throw error
  }).finally(() => {
    if (!deferredToTransition) releaseRecalled()
  }), {
    diag: deps.diag,
    sessionId: () => deps.currentAgent()?.session.id,
    onError: (_error) => {
      if (deps.isDisposed()) return
      if (failureKind === 'transition') {
        deps.notify('a session transition is in progress — try again in a moment', 'info')
        return
      }
      if (failureKind === 'stale') {
        deps.notify('the session changed while pulling messages back — try again', 'info')
        return
      }
      if (failureKind === 'indeterminate') {
        deps.notify('queue pull-back result is indeterminate — do not retry automatically', 'error')
        return
      }
      if (draftApplied || failureKind === 'cancelled') return
      deps.notify('queue pull-back result is indeterminate — do not retry automatically', 'error')
    },
    onCancel: () => {
      if (deps.isDisposed() || draftApplied || failureKind !== undefined) return
    },
  })
}

// ── Ctrl+S steer / busy-Enter draft steer ──────────────────────────────────

/** The live steer agent identity (structural: session + activity). */
export interface SteerSubmissionAgent extends SteerAgentLike {
  readonly status: string
}

/** The runner-supplied operations the steer sweep drives. */
export interface SteerSubmissionDeps {
  readonly isDisposed: () => boolean
  /** The subagent viewer is read-only: steering would target the parent. */
  readonly isViewing: () => boolean
  readonly currentAgent: () => SteerSubmissionAgent | undefined
  readonly currentGeneration: () => number
  readonly captureOwnerToken: () => unknown
  readonly isOwnerTokenCurrent: (token: unknown) => boolean
  readonly readPendingInput: (sessionId: string) => PendingInputSnapshot | undefined
  readonly draftHasAttachments: (text: string) => boolean
  readonly draftHasImages: (text: string) => boolean
  readonly clearSettledLocalMessages: () => void
  /** Merge the draft into the editor; returns whether it came back VERBATIM. */
  readonly mergeDraftIntoEditor: (text: string) => boolean
  readonly notify: (message: string, kind: 'info' | 'error') => void
  readonly acceptSubmitAck: () => number
  readonly settleLocalSubmission: (requestId: string) => void
  readonly settleSubmitAck: (reason: string, options: { readonly token: number; readonly terminal: true }) => void
  /** Install the local steer echo with the gesture-resolved delivery mode. */
  readonly beginLocalSteerEcho: (input: {
    readonly requestId: string
    readonly text: string
    readonly running: boolean
    readonly sessionId: string
    readonly generation: number
    readonly ackToken: number
  }) => void
  readonly takeSubmitTurn: () => { readonly wait: Promise<void>; readonly release: () => void }
  readonly pinDraftAttachments: (text: string) => () => void
  readonly persistAfterSession: (
    resolveSession: () => Promise<string | undefined>,
    persist: (sessionId: string | undefined) => void,
  ) => Promise<void>
  readonly ensureSession: () => Promise<void>
  readonly withPromptAdmission: <T>(
    agent: SteerSubmissionAgent,
    hasImages: boolean,
    task: () => Promise<T>,
  ) => Promise<T>
  readonly prepareMessage: (text: string, requestId: string) => Promise<PreparedMessage>
  readonly markDispatch: (sessionId: string) => void
  readonly restoreSubmissionDraft: (text: string) => void
  readonly notifySubmissionFailure: (error: unknown) => void
  readonly consumeDraftAttachments: (text: string) => void
  readonly writerSection: <T>(task: () => Promise<T>) => Promise<T>
  readonly pendingInputReader: PendingInputReader
  readonly writer: Pick<SessionWriter, 'prompt' | 'updateQueue'>
  readonly diag: Diag
}

/** One steer gesture: the draft, whether it is the busy-Enter DRAFT-ONLY
 * gesture, and the call site's history-persist closure. */
export interface SteerSubmissionInput {
  readonly text: string
  readonly onlyDraft: boolean
  readonly persistHistory?: (sessionId: string | undefined) => void
}

/**
 * Ctrl+S steer-all sweep (`onlyDraft: false`) or the busy-Enter DRAFT-ONLY
 * steer (`onlyDraft: true`): the pre-flight payload gate, the shared FIFO
 * turn, the deferred-start persist, the image admission window, `steerAll`'s
 * occurrence sweep and its terminal ack/echo/consume settlement.
 */
export function steer(deps: SteerSubmissionDeps, input: Omit<SteerSubmissionInput, 'onlyDraft'>): void {
  steerSubmission(deps, { ...input, onlyDraft: false })
}

/** The busy-Enter gesture: steer the draft ONLY, never the queue. */
export function deliverBusy(deps: SteerSubmissionDeps, input: Omit<SteerSubmissionInput, 'onlyDraft'>): void {
  steerSubmission(deps, { ...input, onlyDraft: true })
}

function steerSubmission(deps: SteerSubmissionDeps, input: SteerSubmissionInput): void {
  const text = input.text
  const onlyDraft = input.onlyDraft
  const persistHistory = input.persistHistory
  // The subagent viewer is read-only: steering would send to the PARENT
  // session. Refuse with a notice and restore the draft.
  if (deps.isViewing()) {
    if (text.trim() !== '') deps.mergeDraftIntoEditor(text)
    deps.notify('viewing a subagent — Esc returns before steering', 'info')
    return
  }
  // Same dismissal rule as submissions: settled local cards are a live view,
  // not a record (completed `!`/`!!` runs).
  deps.clearSettledLocalMessages()
  // The payload verdict is computed ONCE here on the SERIALIZED wire form and
  // passed to steerAll (steer.ts never guesses shell/image semantics): `!` /
  // `!!` shell modes make a bare prefix a payload, attachment placeholders
  // make an empty-text draft a payload, whitespace alone is not.
  const draftHasPayload = text.trim() !== '' || deps.draftHasAttachments(text)
  // The empty-Ctrl+S gate: nothing to steer is a clean no-op BEFORE any
  // runOwned / ensureSession work — the deferred-start contract (an empty
  // Ctrl+S must never create the session).
  const pendingAgent = deps.currentAgent()
  const pendingForGate = pendingAgent === undefined
    ? undefined
    : deps.readPendingInput(pendingAgent.session.id)
  // An unavailable projection is not an empty queue. Let steerAll report that
  // stale read unless this is the draft-only policy, which never depends on
  // queue state.
  if (pendingForGate !== undefined || deps.currentAgent() === undefined || onlyDraft) {
    if (!steerHasPayload(draftHasPayload, {
      onlyDraft,
      queuedCount: pendingForGate === undefined
        ? 0
        : pendingForGate.items.filter(item => item.placement === 'queued').length,
      liveAgent: deps.currentAgent() !== undefined,
    })) {
      // A parked next-step steering occurrence is not a lost message — the
      // official contract leaves it in the inbox until the next wake — but an
      // empty Ctrl+S must not be a SILENT no-op: explain the official recovery.
      if (pendingForGate !== undefined && hasParkedSteering(pendingForGate)) {
        if (text !== '') deps.mergeDraftIntoEditor(text)
        deps.notify(PARKED_STEERING_NOTICE, 'info')
      }
      return
    }
  }
  // Local submit acknowledgement (plan D): the row appears NOW, before the
  // awaited prepare/admission work, so an accepted Ctrl+S is never a silent
  // editor clear.
  const steerAckToken = deps.acceptSubmitAck()
  // steerAll owns restoration for queue-level cancellation; keep the enclosing
  // submit flow from restoring that same draft a second time.
  let steerRestored = false
  // Capture the session identity before the first awaited preparation or
  // deferred-start operation.
  const submittedAgent = deps.currentAgent()
  const submittedGeneration = deps.currentGeneration()
  const submittedSubject = deps.captureOwnerToken()
  // The steered draft's correlation identity, minted before the first
  // asynchronous preparation await.
  const steerRequestId = randomUUID()
  // The delivery mode RESOLVED AT THE GESTURE for the draft prompt.
  let steerDelivery: 'queue' | 'steer' | undefined
  if ((draftHasPayload || onlyDraft) && submittedAgent !== undefined) {
    const running = submittedAgent.status === 'running'
    steerDelivery = running ? 'steer' : 'queue'
    if (draftHasPayload) {
      deps.beginLocalSteerEcho({
        requestId: steerRequestId,
        text,
        running,
        sessionId: submittedAgent.session.id,
        generation: submittedGeneration,
        ackToken: steerAckToken,
      })
    }
  }
  const submitTurn = deps.takeSubmitTurn()
  // An owned workflow: the send's outcome drives the draft restore and the
  // notices. Reserve the referenced drafts SYNCHRONOUSLY (same call stack that
  // left the editor): ensureSession() is async on a deferred start, and no
  // await may precede the reservation.
  runOwned('steer', () => runReservedSubmit({
    reserve: (t) => {
      try {
        const releasePin = deps.pinDraftAttachments(t)
        return () => {
          try {
            releasePin()
          } finally {
            submitTurn.release()
          }
        }
      } catch (error) {
        submitTurn.release()
        throw error
      }
    },
    run: async () => {
      await submitTurn.wait
      if (deps.isDisposed()) return
      // The deferred-start gate: the steered draft's history row is written
      // AFTER the session exists, with the FINAL session id.
      await deps.persistAfterSession(
        async () => {
          await deps.ensureSession()
          if (deps.isDisposed()) return undefined
          if (submittedAgent !== undefined && !deps.isOwnerTokenCurrent(submittedSubject)) return undefined
          return deps.currentAgent()?.session.id
        },
        (sessionId) => {
          if (deps.isDisposed()) return
          if (submittedAgent !== undefined && !deps.isOwnerTokenCurrent(submittedSubject)) return
          persistHistory?.(sessionId)
        },
      )
      if (deps.isDisposed()) return
      if (submittedAgent !== undefined && !deps.isOwnerTokenCurrent(submittedSubject)) {
        const verbatim = deps.mergeDraftIntoEditor(text)
        deps.settleLocalSubmission(steerRequestId)
        deps.settleSubmitAck('steer stale', { token: steerAckToken, terminal: true })
        deps.notify(verbatim
          ? 'the session changed while sending — try again'
          : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
        return
      }
      const steerAgent = deps.currentAgent()
      if (steerAgent === undefined) {
        // Nothing can be sent (degraded resolve after a successful creation):
        // the ack row must not outlive the submission.
        deps.settleLocalSubmission(steerRequestId)
        deps.settleSubmitAck('steer resolved without an agent', { token: steerAckToken, terminal: true })
        return
      }
      const agentForSteer = submittedAgent ?? steerAgent
      const generationForSteer = submittedAgent === undefined ? deps.currentGeneration() : submittedGeneration
      const steerSubject = submittedAgent === undefined ? deps.captureOwnerToken() : submittedSubject
      // A deferred start now has its session identity: resolve the gesture's
      // delivery mode and install the local echo before the async admission.
      if (submittedAgent === undefined && (draftHasPayload || onlyDraft)) {
        const running = agentForSteer.status === 'running'
        steerDelivery = running ? 'steer' : 'queue'
        if (draftHasPayload) {
          deps.beginLocalSteerEcho({
            requestId: steerRequestId,
            text,
            running,
            sessionId: agentForSteer.session.id,
            generation: generationForSteer,
            ackToken: steerAckToken,
          })
        }
      }
      // The draft message is prepared BEFORE the send: admission is async I/O.
      const admission = await deps.withPromptAdmission(
        agentForSteer,
        deps.draftHasImages(text),
        async (): Promise<
          | { readonly kind: 'stale' }
          | { readonly kind: 'delivered'; readonly outcome: Awaited<ReturnType<typeof steerAll>> }
        > => {
          const prepared = await deps.prepareMessage(text, steerRequestId)
          if (deps.isDisposed()) return { kind: 'stale' }
          // Re-check the identity after async admission, before entering the
          // writer barrier.
          if (!deps.isOwnerTokenCurrent(steerSubject)) {
            const verbatim = deps.mergeDraftIntoEditor(text)
            deps.settleLocalSubmission(steerRequestId)
            deps.settleSubmitAck('steer stale', { token: steerAckToken, terminal: true })
            deps.notify(verbatim
              ? 'the session changed while sending — try again'
              : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
            return { kind: 'stale' }
          }
          // T1 BEFORE the dispatch.
          deps.markDispatch(agentForSteer.session.id)
          const outcome = await steerAll({
            currentAgent: () => deps.isDisposed() ? undefined : agentForSteer,
            currentGeneration: () => generationForSteer,
            notify: (message, kind) => {
              if (deps.isDisposed()) return
              deps.notify(message, kind)
            },
            restoreDraft: (draft) => {
              if (deps.isDisposed()) return false
              const verbatim = deps.mergeDraftIntoEditor(draft)
              steerRestored = true
              return verbatim
            },
            // The admitted steer writer must never re-read the transition gate:
            // the writerSection holds the barrier, so a transition that arrives
            // while the sweep is in flight WAITS for the WHOLE writer.
            fence: () => deps.isDisposed(),
            writerSection: deps.writerSection,
            fenceNotice: () => 'a session transition is in progress — try again in a moment',
            createDraft: () => prepared,
            staleNotice: () => 'the queue or session changed while sending — try again',
            mergedNotice: () => 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)',
            pendingInputReader: deps.pendingInputReader,
            writer: deps.writer,
          },
          text,
          onlyDraft
            ? { onlyDraft: true, draftHasPayload, draftDelivery: steerDelivery }
            : { draftHasPayload, draftDelivery: steerDelivery },
          )
          return { kind: 'delivered', outcome }
        },
      )
      if (admission.kind === 'stale') return
      const outcome = admission.outcome
      if (deps.isDisposed()) return
      // Only a successful send consumes the drafts.
      if (outcome === 'ok') deps.consumeDraftAttachments(text)
      // Only a NON-delivered steer settles the ack row here: 'ok' waits for the
      // authoritative inbox event.
      if (outcome !== 'ok') {
        deps.settleLocalSubmission(steerRequestId)
        deps.settleSubmitAck(`steer ${outcome}`, { token: steerAckToken, terminal: true })
      }
    },
    restore: (t) => {
      if (!steerRestored) deps.restoreSubmissionDraft(t)
    },
  }, text), {
    diag: deps.diag,
    sessionId: () => deps.currentAgent()?.session.id,
    onError: (error) => {
      if (deps.isDisposed()) return
      deps.settleLocalSubmission(steerRequestId)
      deps.settleSubmitAck('failure', { token: steerAckToken, terminal: true })
      deps.notifySubmissionFailure(error)
    },
    onCancel: () => {
      if (deps.isDisposed()) return
      deps.settleLocalSubmission(steerRequestId)
      deps.settleSubmitAck('steer cancelled', { token: steerAckToken, terminal: true })
    },
  })
}

// ── HostCommandPort submission + agent-facing fallback ─────────────────────

/** One committed command execution as the runtime reads it (structural). */
export interface HostCommandExecutionLike {
  readonly commandId: string
  readonly result: { readonly kind: string }
}

/** The runner-supplied operations the HostCommand submission drives. */
export interface HostCommandSubmissionDeps {
  readonly isDisposed: () => boolean
  readonly notify: (message: string, kind: 'info' | 'error') => void
  readonly loggerError: (message: string) => void
  readonly readDraft: () => string
  readonly mergeDraftIntoEditor: (text: string) => boolean
  readonly restoreSubmissionDraft: (text: string) => void
  readonly consumeDraftAttachments: (text: string) => void
  readonly draftHasAttachments: (text: string) => boolean
  readonly pinDraftAttachments: (text: string) => () => void
  readonly settleLocalSubmission: (requestId: string) => void
  readonly settleSubmitAck: (reason: string, options: { readonly token: number; readonly terminal: true }) => void
  readonly notifySubmissionFailure: (error: unknown) => void
  readonly isScopeCurrent: (scope: LiveSessionScope) => boolean
  readonly isTransitionBusy: () => boolean
  readonly refuseByTransitionFence: (text: string) => void
  /** The FINAL-catalog attachment refusal for this line (`undefined` = allowed). */
  readonly lateAttachmentRefusal: () => string | undefined
  readonly commandSubmitAttachments: (text: string) => readonly unknown[]
  readonly isTuiOwnedCommand: () => boolean
  readonly commandPlaneOwnsLine: () => boolean
  readonly submittedHostClaim: () => { readonly claimed: boolean; readonly attachments?: unknown } | undefined
  readonly commandSignal: () => AbortSignal
  /** The command-plane invocation (the runner wraps it in `withCommandDelivery`). */
  readonly invokeCommandPlane: (input: {
    readonly toggled: string
    readonly commandPlaneLine: boolean
    readonly tuiOwnedCommand: boolean
    readonly submittedAttachments: readonly unknown[]
    readonly signal: AbortSignal
  }) => Promise<HostCommandOutcome>
  readonly beginCommandSettlement: () => void
  readonly abortCommandSettlement: () => void
  readonly settleCommandSettlement: () => void
  readonly trackSettlementWork: (work: Promise<unknown>) => void
  readonly captureCommandHealthRef: () => unknown
  readonly clearCommandHealthError: (ref: unknown) => void
  readonly recordCommandHealthError: (ref: unknown, error: unknown) => void
  readonly readCommandDraftDisposition: (commandId?: string) => 'restored' | 'suppressed' | undefined
  readonly shouldConsumeAdvertisedMiss: (execution: HostCommandExecutionLike | undefined, planeAdvertised: boolean) => boolean
  readonly isIndeterminateSkillWrite: (error: unknown) => boolean
  readonly startArtifactSave: (name: 'export' | 'transcript') => void
  readonly submitPrompt: (submission: PromptSubmission) => Promise<void>
  readonly commandSessionId: () => string
  readonly markTurnTransferred: () => void
  readonly diag: Diag
}

/** The per-gesture context the HostCommand submission needs. */
export interface HostCommandSubmissionInput {
  readonly text: string
  readonly toggled: string
  readonly scope: LiveSessionScope
  readonly submitRequestId: string
  readonly submitAckToken: number
  readonly generation: number
  readonly localEchoInstalled: boolean
  readonly wasAdvertisedAtSubmit: boolean
  readonly parsedName: string | undefined
  readonly submitTurn: { readonly wait: Promise<void>; readonly release: () => void }
}

/**
 * HostCommandPort submission + the agent-facing fallback: the command
 * invocation window, the `WriteOutcome` classification and the draft/ack/card
 * settlement. The runner supplies the command-plane hooks; this entrypoint
 * decides when the write is consumed, restored or falls back to a prompt.
 */
export function executeHostCommandSubmission(
  deps: HostCommandSubmissionDeps,
  input: HostCommandSubmissionInput,
): void {
  const { text, toggled, scope, submitRequestId, submitAckToken, generation, localEchoInstalled, submitTurn } = input
  // HANDSHAKE PIN: the outer task's pin releases when it returns, but the
  // nested fallback pin is only established inside onResult — acquire it HERE,
  // transfer it to the nested fallback, and release it on every other exit.
  const fallbackPin = deps.pinDraftAttachments(text)
  const lateRefusal = deps.lateAttachmentRefusal()
  if (lateRefusal !== undefined) {
    fallbackPin()
    if (deps.draftHasAttachments(text)) deps.restoreSubmissionDraft(text)
    deps.notify(lateRefusal, 'error')
    deps.settleLocalSubmission(submitRequestId)
    deps.settleSubmitAck('attachments refused by the command declaration', { token: submitAckToken, terminal: true })
    return
  }
  // The session-transition write fence: the identity check above can yield
  // across a concurrent /new, /fork, rewind or switch — once a transition is
  // in flight, executing the command would write an agent that is about to be
  // retired. Refuse and restore the draft instead.
  if (deps.isTransitionBusy()) {
    fallbackPin()
    deps.refuseByTransitionFence(text)
    deps.settleLocalSubmission(submitRequestId)
    deps.settleSubmitAck('submit refused by transition fence', { token: submitAckToken, terminal: true })
    return
  }
  deps.markTurnTransferred()
  // Assigned inside the runOwned factory (invocation-time capture) and read by
  // the settlement sinks below.
  let commandHealthRef: unknown
  let planeAdvertised = false
  runOwned('command execution', () => {
    commandHealthRef = deps.captureCommandHealthRef()
    const submittedClaim = deps.submittedHostClaim()
    const submittedAttachments = submittedClaim?.claimed === true && submittedClaim.attachments
      ? deps.commandSubmitAttachments(text)
      : []
    const commandPlaneLine = deps.commandPlaneOwnsLine()
    planeAdvertised = commandPlaneLine && input.wasAdvertisedAtSubmit
    const tuiOwnedCommand = deps.isTuiOwnedCommand()
    // The post-command-settlement window opens HERE.
    deps.beginCommandSettlement()
    let settled: Promise<HostCommandOutcome>
    try {
      settled = Promise.resolve(deps.invokeCommandPlane({
        toggled,
        commandPlaneLine,
        tuiOwnedCommand,
        submittedAttachments,
        signal: deps.commandSignal(),
      }))
    } catch (error) {
      // A SYNCHRONOUS throw means the handler never ran: close the window
      // synchronously and rethrow.
      deps.abortCommandSettlement()
      throw error
    }
    settled = settled.finally(deps.settleCommandSettlement)
    deps.trackSettlementWork(settled)
    return settled
  }, {
    diag: deps.diag,
    sessionId: () => deps.commandSessionId(),
    onResult: (outcome) => {
      if (deps.isDisposed()) {
        fallbackPin()
        submitTurn.release()
        return
      }
      if (outcome.kind !== 'committed') {
        // A known refusal did not settle a command: restore the complete
        // submitted line while the handoff pin is held. An indeterminate
        // result may have committed — never restore or retry automatically.
        if (outcome.kind !== 'indeterminate') deps.restoreSubmissionDraft(text)
        fallbackPin()
        submitTurn.release()
        if (outcome.kind === 'cancelled') {
          deps.settleLocalSubmission(submitRequestId)
          deps.settleSubmitAck('command execution cancelled', { token: submitAckToken, terminal: true })
          return
        }
        deps.settleLocalSubmission(submitRequestId)
        deps.settleSubmitAck(
          outcome.kind === 'indeterminate' ? 'command result indeterminate' : 'command execution refused',
          { token: submitAckToken, terminal: true },
        )
        if (outcome.kind === 'indeterminate') {
          deps.notify('command result is indeterminate — do not retry automatically', 'error')
          return
        }
        deps.notify(outcome.error.message, 'error')
        return
      }
      const execution = outcome.matched
        ? outcome.execution as unknown as HostCommandExecutionLike
        : undefined
      const draftDisposition = execution === undefined
        ? undefined
        : deps.readCommandDraftDisposition(execution.commandId)
      if (commandHealthRef !== undefined && execution !== undefined) {
        deps.clearCommandHealthError(commandHealthRef)
      }
      // A command that RAN owns its own feedback: the submit-ack row stands
      // down here — never before execute() resolved, so the fallback followup
      // keeps its pending row.
      if (execution !== undefined) {
        deps.settleLocalSubmission(submitRequestId)
        deps.settleSubmitAck('submit consumed by a command', { token: submitAckToken, terminal: true })
      }
      // An advertised command the real session's catalog lacks: consume the
      // slash input with an explicit error — never a plain model message.
      if (deps.shouldConsumeAdvertisedMiss(execution, planeAdvertised)) {
        if (deps.draftHasAttachments(text)) deps.restoreSubmissionDraft(text)
        deps.notify(`/${input.parsedName ?? '?'} is not available in the created session`, 'error')
        deps.settleLocalSubmission(submitRequestId)
        deps.settleSubmitAck('submit consumed by an unadvertised command', { token: submitAckToken, terminal: true })
        fallbackPin()
        submitTurn.release()
        return
      }
      // The fallback follow-up still targets the CAPTURED agent.
      if (execution === undefined) {
        if (deps.isScopeCurrent(scope)) {
          runOwned('image submit', () => {
            const task = runReservedSubmit({
              // TRANSFER the handoff reservation, never a second pin.
              reserve: () => fallbackPin,
              run: () => deps.submitPrompt({
                text,
                scope,
                requestId: submitRequestId,
                ackToken: submitAckToken,
                generation,
                echoInstalled: localEchoInstalled,
              }),
              restore: (t) => deps.restoreSubmissionDraft(t),
            }, text)
            // This nested submission starts one callback later, so teardown
            // must reach it explicitly.
            deps.trackSettlementWork(task)
            return task
          }, {
            diag: deps.diag,
            sessionId: () => deps.commandSessionId(),
            onResult: () => { submitTurn.release() },
            onError: (error) => {
              submitTurn.release()
              deps.settleLocalSubmission(submitRequestId)
              deps.settleSubmitAck('failure', { token: submitAckToken, terminal: true })
              deps.notifySubmissionFailure(error)
            },
            onCancel: () => {
              submitTurn.release()
              deps.settleLocalSubmission(submitRequestId)
              deps.settleSubmitAck('submit cancelled', { token: submitAckToken, terminal: true })
            },
          })
        } else {
          fallbackPin()
          submitTurn.release()
          const verbatim = deps.mergeDraftIntoEditor(text)
          deps.settleLocalSubmission(submitRequestId)
          deps.settleSubmitAck('submit stale', { token: submitAckToken, terminal: true })
          deps.notify(verbatim
            ? 'the session changed while sending — try again'
            : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
        }
      } else {
        // A command submission CONSUMES its attachments only after handler
        // success (an error outcome keeps the draft for correction).
        if (execution.result.kind === 'error'
          && draftDisposition !== 'restored'
          && draftDisposition !== 'suppressed') {
          deps.restoreSubmissionDraft(text)
        } else if (execution.result.kind !== 'error') {
          deps.consumeDraftAttachments(text)
        }
        fallbackPin()
        submitTurn.release()
        if (execution.result.kind === 'success') {
          const commandName = input.parsedName
          if (commandName === 'export' || commandName === 'transcript') deps.startArtifactSave(commandName)
        }
      }
    },
    onError: (error) => {
      fallbackPin()
      submitTurn.release()
      if (deps.isDisposed()) return
      const indeterminateSkill = deps.isIndeterminateSkillWrite(error)
      const draftDisposition = deps.readCommandDraftDisposition()
      if (!indeterminateSkill && draftDisposition !== 'restored' && draftDisposition !== 'suppressed') {
        deps.restoreSubmissionDraft(text)
      }
      deps.settleLocalSubmission(submitRequestId)
      deps.settleSubmitAck(
        indeterminateSkill ? 'skill write result indeterminate' : 'command execution failed',
        { token: submitAckToken, terminal: true },
      )
      if (indeterminateSkill) {
        deps.notify('skill write result is indeterminate — do not retry automatically', 'error')
        return
      }
      if (commandHealthRef !== undefined) deps.recordCommandHealthError(commandHealthRef, error)
      const message = safeErrorMessage(error)
      try {
        deps.loggerError(`tui-runner: command execution failed: ${message}`)
      } catch {
        // The cordis logger must not block the user notice.
      }
      deps.notify(message, 'error')
    },
    onCancel: () => {
      fallbackPin()
      submitTurn.release()
      if (deps.isDisposed()) return
      const draftDisposition = deps.readCommandDraftDisposition()
      if (draftDisposition !== 'restored' && draftDisposition !== 'suppressed') {
        deps.restoreSubmissionDraft(text)
      }
      deps.settleLocalSubmission(submitRequestId)
      deps.settleSubmitAck('command execution cancelled', { token: submitAckToken, terminal: true })
    },
  })
}
