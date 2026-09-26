/**
 * The Ctrl+S steer-all orchestration with re-validation. Extracted
 * from the runner so the TOCTOU races — a queue splice or a session switch
 * while the send is in flight — are testable headless:
 *
 * - The queue snapshot and the agent/generation identity are captured
 *   BEFORE the awaited write window.
 * - Before the delivery, the agent object and session generation are
 *   re-validated. Queue changes are handled per occurrence by the writer:
 *   missing or unavailable rows converge without replay, while a newly added
 *   row is not included because it was outside the initial snapshot.
 * - A payload-bearing draft takes precedence over the queue and is sent as
 *   one ordinary prompt. With no draft payload, queued occurrences are
 *   steered one at a time through the official occurrence-level writer
 *   operation, matching the dsh-web client; the gesture is FIFO best-effort,
 *   not an atomic batch.
 * @module @xmoon76/dsh-pi-tui/steer
 */

import { TransitionInProgressError } from './session-operation-barrier.ts'
import { SessionScopeSupersededError } from './app/session/scope.ts'
import { cancellationError } from './detached.ts'
import type { SessionWriter, WriteError, WriteOutcome } from './runtime/session-writer-port.ts'
import type { PendingInputReader, PendingInputSnapshot } from './runtime/pending-input-reader-port.ts'

/** The minimal agent surface the steer needs (the runner's live agent).
 * Pending queue state belongs to {@link PendingInputReader}, not this
 * identity/dispatch handle. */
export interface SteerAgentLike {
  session: { id: string }
}

export type SteerOutcome = 'ok' | 'stale' | 'indeterminate'

/** Injectable dependencies of {@link steerAll}. */
export interface SteerDeps {
  /** Current live agent, re-read on every access (TOCTOU detection). */
  currentAgent(): SteerAgentLike | undefined
  /** Current session generation, re-read (session switch detection). */
  currentGeneration(): number
  notify(message: string, kind: 'info' | 'error'): void
  /**
   * Restore the draft after an abort (the editor keeps the text). Returns
   * true when the draft came back VERBATIM; false when it was MERGED with
   * newer input — then the notice must not promise a plain retry.
   */
  restoreDraft(text: string): boolean
  /** Build the draft message (runner-side creation, keeps this module dsh-free). */
  createDraft(text: string): unknown
  /** The stale-state (retry) notice text. */
  staleNotice(): string
  /** The notice when the draft had to be MERGED with newer input: the
   * submission changed, so no verbatim-retry promise can be made. */
  mergedNotice(): string
  /**
   * A post-admission LOCAL VALIDITY fence (surface lifetime / disposed). It runs
   * only after the writer section was entered, so it MUST NOT read the session
   * transition gate: an admitted writer is never truncated by a waiting
   * transition — that admission belongs to `SessionRuntime.withWriter` alone.
   * Optional; absent keeps the historical behavior.
   */
  fence?: () => boolean
  /** The fence refusal notice (defaults to {@link staleNotice}). */
  fenceNotice?: () => string
  /** The semantic pending-input read projection. Queue placement and running
   * state are read here; the runner never reads Direct inbox collections. */
  pendingInputReader: PendingInputReader
  /** The session WRITE delivery seam. Ordinary prompts and occurrence-level
   * queue mutations always go through the semantic SessionWriter. */
  writer: Pick<SessionWriter, 'prompt' | 'updateQueue'>
  /**
   * The submission writer admission (convergence plan phase 3): the whole
   * steer write runs inside this section, so a transition started while
   * this steer awaits drains it first — the `fence` quick-refusal alone
   * cannot stop a writer that started BEFORE the transition. The runner binds
   * it to the captured live scope through `SubmissionRuntime.withWriter`, so
   * the operation barrier has exactly ONE admission owner. Optional; absent
   * keeps the direct/unit-call behavior.
   */
  writerSection?: <T>(task: () => Promise<T>) => Promise<T>
  /**
   * The proven pre-dispatch refusal settlement (`rejected` only). The
   * submission owner (`app/submission/runtime.ts`, the M3 `session/writer-held`
   * insertion point) reads `error.code`/`error.message` and owns the
   * user-facing settlement. When present, the helper invokes this INSTEAD of
   * its historical stale restore/notice, so a proven refusal never becomes a
   * blind "try again". Optional; absent keeps the direct/unit-call behavior.
   */
  onRejected?: (error: WriteError, steeredCount: number) => void
}

/** The notice for a submission refused by the session-transition fence. */
export const TRANSITION_FENCE_NOTICE = 'a session transition is in progress — try again in a moment'
/** The notice when the fence refusal had to MERGE the draft with newer input. */
export const TRANSITION_FENCE_MERGED_NOTICE = 'the draft changed while transitioning — review it before submitting again'
/** The empty-Ctrl+S recovery notice when a next-step steering occurrence is
 * PARKED because its turn is no longer running (the official contract leaves
 * it in the inbox until the next wake). The TUI explains the official
 * recovery — the next ordinary prompt — and never synthesizes that wake. */
export const PARKED_STEERING_NOTICE = 'pending steering is waiting for the next turn — send a message to continue'

/** Whether a coherent pending snapshot holds a PARKED next-step steering
 * occurrence: `placement: 'steering'` while the subject is not running. Only
 * this semantic state is consulted — never session history. A parked
 * occurrence is not lost: the next ordinary prompt wakes the Agent and the
 * occurrence is consumed then. */
export function hasParkedSteering(pending: PendingInputSnapshot): boolean {
  return !pending.running && pending.items.some(item => item.placement === 'steering')
}

/**
 * The refusal action for the session-transition write fence: restore the
 * draft (nothing is lost) and notify. The caller decides WHEN to refuse —
 * normally by checking the transition gate's `busy` — and calls this to
 * perform the refusal consistently across every write entry point. Pure
 * and headless-testable.
 * @param text - the submission that was refused.
 * @param getDraft - read the current editor draft (may hold newer input).
 * @param setEditorText - restore the merged draft.
 * @param notify - the runner's notify sink.
 */
export function refuseByTransitionFence(
  text: string,
  getDraft: () => string,
  setEditorText: (text: string) => void,
  notify: (message: string, kind: 'info' | 'error') => void,
): void {
  const merged = mergeDraft(getDraft(), text)
  setEditorText(merged)
  notify(merged === text ? TRANSITION_FENCE_NOTICE : TRANSITION_FENCE_MERGED_NOTICE, 'info')
}

/** The steers' fence notice source (the runner wires it to the gate). */
export const transitionFenceNotice = (): string => TRANSITION_FENCE_NOTICE

/**
 * Merge a draft back after an aborted send so NOTHING is lost.
 *
 * NO text-level dedup — including the `current === submitted` case. Every
 * restore corresponds to exactly ONE operation (steerAll/submit hit exactly
 * one terminal branch and return, so no operation ever restores twice), and
 * two INDEPENDENT operations may legitimately carry the SAME text: A and B
 * submit `same` on an empty editor, both fail, A restores `same` first, B
 * restores second — an equality shortcut would collapse B into A and the
 * user silently loses one unsent submission. Text equality therefore never
 * means "already restored"; each failed operation preserves its submission,
 * even when the editor already holds an identical-looking string (that
 * string is either an independent operation's restore or the user's own
 * re-typed input — text cannot tell, so nothing is deduped).
 * - nothing was submitted: the editor stays exactly as it is;
 * - editor strictly empty: the submitted (unsent) text comes back;
 * - otherwise: the existing text stays on top and the unsent submission is
 *   preserved visibly beneath it (it was never delivered, so silently
 *   dropping it would lose the input). A whitespace-only editor is real
 *   input and is never swallowed.
 */
export function mergeDraft(current: string, submitted: string): string {
  if (submitted === '') return current
  if (current === '') return submitted
  return current + '\n\n' + submitted
}

/**
 * Whether a session identity captured before an async operation is still
 * current: the SAME agent object and the SAME generation. Used by the
 * Enter-submit path too, so every capture-then-write flow re-checks what
 * the captured identity actually verified.
 */
export function sessionUnchanged(
  locked: { agent: object; generation: number },
  agent: object | undefined,
  generation: number,
): boolean {
  return agent !== undefined && agent === locked.agent && generation === locked.generation
}

/** Options for {@link steerAll}. */
export interface SteerAllOptions {
  /**
   * Steer the DRAFT ONLY, leaving the queue untouched (the busy-Enter
   * preference, web busyEnter parity): messages the user queued explicitly
   * stay queued until Ctrl+S — already-steered input
   * cannot be pulled back, so Enter must never sweep the queue along.
   */
  onlyDraft?: boolean
  /**
   * Whether the draft text carries a real payload (the serialized wire
   * form — `!` / `!!` shell mode makes a bare prefix payload, an
   * image-bearing draft is payload, whitespace-only is not). The RUNNER
   * decides (it owns the shell-mode / image semantics); `steer.ts` never
   * guesses. `undefined` derives the verdict from `text.trim()` for direct
   * callers; production passes the runner's explicit shell/image verdict.
   */
  draftHasPayload?: boolean
  /**
   * The delivery mode RESOLVED AT THE GESTURE for the draft prompt. The
   * runner captures it with the local submission echo (official
   * `beginSubmission` placement), so the written mode and the pending
   * presentation can never disagree when the agent's running state flips
   * while this gesture waits on the submit FIFO. `undefined` falls back to
   * the live snapshot's running state (direct/unit callers).
   */
  draftDelivery?: 'queue' | 'steer'
}

/**
 * The empty-Ctrl+S GATE (the runner's Gate A, kept here so it is
 * headless-testable and so a reordering can never sneak `ensureSession`
 * in front of it): whether there is ANYTHING to steer, judged on the
 * draft-payload verdict plus the live queue.
 *
 * ```text
 * onlyDraft            → the draft verdict alone decides (busy-Enter steer)
 * liveAgent + queue    → queue non-empty OR draft payload
 * no live agent        → draft payload alone (deferred start: an empty
 *                        Ctrl+S must NOT create a session)
 * ```
 *
 * `undefined` is a VERBATIM pass-through: the caller wants no filtering.
 */
export function steerHasPayload(
  draftHasPayload: boolean | undefined,
  options: { onlyDraft: boolean; queuedCount: number; liveAgent: boolean },
): boolean {
  if (draftHasPayload === undefined) return true
  if (options.onlyDraft) return draftHasPayload
  if (options.liveAgent) return options.queuedCount > 0 || draftHasPayload
  return draftHasPayload
}

/**
 * Run one steer gesture end to end: snapshot → re-validate → one delivery
 * path. A payload-bearing draft is delivered alone; only an empty draft may
 * sweep the snapshot's `queued` occurrences. The queue phase follows the
 * dsh-web client: it addresses occurrences in FIFO order, never replays a
 * copied message, and makes no atomic/same-step claim. With `onlyDraft` the
 * queue is neither read nor mutated. A non-empty whitespace string explicitly
 * marked `draftHasPayload: false` is never prompted, but is restored when no
 * queue write commits.
 */
export async function steerAll(deps: SteerDeps, text: string, options: SteerAllOptions = {}): Promise<SteerOutcome> {
  // The whole steer write runs inside the writer section: a transition
  // that starts while this steer awaits drains it first. The fence quick
  // refusal below only covers writers that START during a transition.
  const writerSection = deps.writerSection
  const sessionId = deps.currentAgent()?.session.id
  if (writerSection !== undefined && sessionId !== undefined) {
    try {
      return await writerSection(() => steerAllCore(deps, text, options))
    } catch (error) {
      // A frozen transition and a superseded capture are DIFFERENT refusals
      // (both mean "this gesture did not send"): restore the draft and report the
      // refusal that actually happened — never the transition notice for a stale
      // capture.
      if (error instanceof TransitionInProgressError) {
        deps.restoreDraft(text)
        deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
        return 'stale'
      }
      if (error instanceof SessionScopeSupersededError) {
        deps.restoreDraft(text)
        deps.notify(deps.staleNotice(), 'info')
        return 'stale'
      }
      throw error
    }
  }
  return steerAllCore(deps, text, options)
}

/** Deliver one ordinary message through the semantic writer seam. */
const deliverPrompt = async (
  deps: SteerDeps,
  agent: SteerAgentLike,
  message: unknown,
  mode: 'queue' | 'steer',
): Promise<WriteOutcome> => deps.writer.prompt(agent.session.id, message, mode)

/** Deliver one exact queued occurrence through the official updateQueue
 * steer operation. */
const deliverQueued = async (
  deps: SteerDeps,
  agent: SteerAgentLike,
  messageId: string,
): Promise<WriteOutcome> => deps.writer.updateQueue(agent.session.id, messageId, { kind: 'steer' })

/** Apply a writer settlement for the one-message draft prompt. Known
 * non-commits restore the draft; an indeterminate result may have delivered
 * it, so it stays absent and is reported without an automatic retry. */
const handleWriteOutcome = (deps: SteerDeps, text: string, outcome: WriteOutcome): SteerOutcome => {
  if (outcome.kind === 'committed') return 'ok'
  if (outcome.kind === 'cancelled') throw cancellationError('session write cancelled')
  if (outcome.kind === 'indeterminate') {
    deps.notify('the session write outcome is indeterminate — do not retry automatically', 'error')
    return 'indeterminate'
  }
  // A PROVEN pre-dispatch refusal (e.g. a future Remote `session/writer-held`):
  // hand the code/message to the submission owner BEFORE any user-facing
  // settlement — never the generic stale/retry notice.
  if (outcome.kind === 'rejected' && deps.onRejected !== undefined) {
    deps.onRejected(outcome.error, 0)
    return 'stale'
  }
  const verbatim = deps.restoreDraft(text)
  deps.notify(verbatim ? deps.staleNotice() : deps.mergedNotice(), 'error')
  return 'stale'
}

/** Whether an occurrence-level steer refusal is the expected dsh-web
 * convergence case for a stale snapshot or a turn that has closed. */
const isConvergentQueueSteer = (outcome: WriteOutcome): boolean =>
  outcome.kind === 'rejected'
  && (outcome.error.code === 'session/steer-unavailable' || outcome.error.code === 'session/queue-item-not-found')

async function steerAllCore(deps: SteerDeps, text: string, options: SteerAllOptions = {}): Promise<SteerOutcome> {
  const onlyDraft = options.onlyDraft === true
  const draftHasPayload = options.draftHasPayload ?? text.trim() !== ''
  const draftOnly = onlyDraft || draftHasPayload
  const agent = deps.currentAgent()
  if (agent === undefined) {
    if (text !== '') deps.restoreDraft(text)
    return 'ok'
  }
  const generation = deps.currentGeneration()
  const pending = deps.pendingInputReader.snapshot(agent.session.id)
  if (pending === undefined) {
    // The identity was live but its semantic read projection disappeared
    // before the write window. Do not guess an empty queue or fall back to
    // Direct collections; treat the gesture as stale.
    const verbatim = draftHasPayload || text !== '' ? deps.restoreDraft(text) : true
    deps.notify(verbatim ? deps.staleNotice() : deps.mergedNotice(), 'error')
    return 'stale'
  }
  // An empty draft cannot steer a turn that is not running; do not issue an
  // occurrence write merely to receive the expected unavailable settlement.
  // A parked next-step steering occurrence is NOT lost — the official contract
  // leaves it in the inbox until the next wake — so the empty gesture must not
  // synthesize that wake (no prompt, no updateQueue, no agent.steer). It
  // explains the recovery instead; a plain idle no-op stays silent.
  if (!draftHasPayload && !pending.running) {
    if (hasParkedSteering(pending)) deps.notify(PARKED_STEERING_NOTICE, 'info')
    if (text !== '') deps.restoreDraft(text)
    return 'ok'
  }
  // dsh-web gives a payload-bearing draft priority over the queued snapshot.
  // With no draft payload, only `placement: 'queued'` occurrences participate;
  // `steering` and `context` are already outside the queue gesture.
  const snapshot = draftOnly ? [] : pending.items.filter(item => item.placement === 'queued')
  // Gate B: when there is no draft payload and no queue, nothing is sent for
  // either onlyDraft or full Ctrl+S; preserve any non-empty non-payload text.
  if (!draftHasPayload && snapshot.length === 0) {
    if (text !== '') deps.restoreDraft(text)
    return 'ok'
  }
  // Re-validate BEFORE delivery: agent identity and generation must still
  // match what was captured. Queue races are resolved per occurrence by the
  // writer below, so a changed queue does not invalidate the whole sweep.
  const now = deps.currentAgent()
  if (now === undefined || !sessionUnchanged({ agent, generation }, now, deps.currentGeneration())) {
    const verbatim = deps.restoreDraft(text)
    deps.notify(verbatim ? deps.staleNotice() : deps.mergedNotice(), 'error')
    return 'stale'
  }
  // The transition fence refuses new writes during quiesce → commit.
  if (deps.fence?.() === true) {
    deps.restoreDraft(text)
    deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
    return 'stale'
  }
  if (draftOnly) {
    // A payload-bearing draft, including an attachment-only draft, is the
    // whole gesture; explicitly queued messages stay queued. The delivery
    // mode is the one resolved at the gesture (the local echo's placement);
    // it is never re-derived from a status that may have flipped while this
    // gesture waited on the submit FIFO.
    const message = deps.createDraft(text)
    const mode = options.draftDelivery ?? (pending.running ? 'steer' : 'queue')
    const outcome = await deliverPrompt(deps, now, message, mode)
    return handleWriteOutcome(deps, text, outcome)
  }
  let steeredCount = 0
  for (const message of snapshot) {
    // Queue steering is one async occurrence at a time. Re-check the exact
    // viewer/session identity before every occurrence so closing, switching,
    // or replacing a same-id Agent stops an old sweep before its next write.
    const current = deps.currentAgent()
    if (current === undefined || !sessionUnchanged({ agent, generation }, current, deps.currentGeneration())) {
      deps.restoreDraft(text)
      deps.notify(deps.staleNotice(), 'info')
      return 'stale'
    }
    if (deps.fence?.() === true) {
      deps.restoreDraft(text)
      deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
      return 'stale'
    }
    const outcome = await deliverQueued(deps, current, message.id)
    if (outcome.kind === 'committed') {
      steeredCount += 1
      continue
    }
    if (isConvergentQueueSteer(outcome)) {
      // Match dsh-web: the snapshot is no longer authoritative, so end this
      // sweep quietly rather than replaying the stale message or racing ahead.
      if (text !== '') deps.restoreDraft(text)
      return 'ok'
    }
    if (outcome.kind === 'cancelled') {
      if (text !== '') deps.restoreDraft(text)
      throw cancellationError('queue steer cancelled')
    }
    if (outcome.kind === 'indeterminate') {
      if (text !== '') deps.restoreDraft(text)
      deps.notify(`queue steering became indeterminate after ${steeredCount} message${steeredCount === 1 ? '' : 's'} — do not retry automatically`, 'error')
      return 'indeterminate'
    }
    // A PROVEN occurrence refusal: the submission owner settles it (restore +
    // the refusal's own guidance); never the generic "queue steering stopped"
    // retry notice.
    if (outcome.kind === 'rejected' && deps.onRejected !== undefined) {
      deps.onRejected(outcome.error, steeredCount)
      return 'stale'
    }
    if (text !== '') deps.restoreDraft(text)
    deps.notify(`queue steering stopped after ${steeredCount} message${steeredCount === 1 ? '' : 's'}`, 'error')
    return 'stale'
  }
  if (steeredCount > 0) {
    deps.notify(`steering ${steeredCount} message${steeredCount === 1 ? '' : 's'}`, 'info')
  }
  return 'ok'
}
