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
 * - The confirmed queue occurrences are steered one at a time through the
 *   official occurrence-level writer operation, matching the dsh-web client;
 *   the gesture is FIFO best-effort, not an atomic batch.
 * @module @xmoon76/dsh-pi-tui/steer
 */

import { SessionOperationBarrier, TransitionInProgressError } from './session-operation-barrier.ts'
import { cancellationError } from './detached.ts'
import type { SessionWriter, WriteOutcome } from './runtime/session-writer-port.ts'

/** The minimal agent surface the steer needs (the runner's live agent). */
export interface SteerAgentLike {
  session: { id: string }
  inbox: {
    nextTurn: readonly { id: string }[]
    nextStep: readonly { id: string }[]
    remove(id: string): void
  }
  status: string
  steer(message: unknown): void
  followup(message: unknown): void
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
   * The session-transition write fence: returns true while a session
   * transition is in flight (quiesce → commit). The old agent may be
   * woken again between whenIdle and the lock release, so a write in that
   * window would target a session whose lock is about to be handed over —
   * the two-writers race. Optional; absent keeps the historical behavior.
   */
  fence?: () => boolean
  /** The fence refusal notice (defaults to {@link staleNotice}). */
  fenceNotice?: () => string
  /**
   * The session WRITE delivery seam (optional): when provided, ordinary
   * prompts and occurrence-level queue steering go through SessionWriter.
   * Absent keeps the Direct-shaped headless fallback (the runner provides
   * the writer in production).
   */
  writer?: Pick<SessionWriter, 'prompt' | 'steerQueued' | 'removeQueued'>
  /**
   * The session operation barrier (convergence plan phase 3): the whole
   * steer write runs inside `runWriter`, so a transition started while
   * this steer awaits drains it first — the `fence` quick-refusal alone
   * cannot stop a writer that started BEFORE the transition.
   */
  barrier?: SessionOperationBarrier
}

/** The notice for a submission refused by the session-transition fence. */
export const TRANSITION_FENCE_NOTICE = 'a session transition is in progress — try again in a moment'
/** The notice when the fence refusal had to MERGE the draft with newer input. */
export const TRANSITION_FENCE_MERGED_NOTICE = 'the draft changed while transitioning — review it before submitting again'

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
   * guesses. `undefined` keeps the historical behavior: any text is
   * treated as a payload (the runner's empty-payload gate covers it).
   */
  draftHasPayload?: boolean
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
 * Run one Ctrl+S send end to end: snapshot → re-validate → per-occurrence
 * queue steering → optional draft prompt. The queue phase follows the
 * dsh-web client: it addresses the snapshot's `nextTurn` occurrences in FIFO
 * order, never replays a copied message, and makes no atomic/same-step claim.
 * With `onlyDraft` the queue is neither read nor mutated.
 */
export async function steerAll(deps: SteerDeps, text: string, options: SteerAllOptions = {}): Promise<SteerOutcome> {
  // The whole steer write runs inside the operation barrier: a transition
  // that starts while this steer awaits drains it first. The fence quick
  // refusal below only covers writers that START during a transition.
  const barrier = deps.barrier
  const sessionId = deps.currentAgent()?.session.id
  if (barrier !== undefined && sessionId !== undefined) {
    try {
      return await barrier.runWriter(sessionId, () => steerAllCore(deps, text, options))
    } catch (error) {
      if (error instanceof TransitionInProgressError) {
        deps.restoreDraft(text)
        deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
        return 'stale'
      }
      throw error
    }
  }
  return steerAllCore(deps, text, options)
}

/** Deliver one ordinary message through the writer seam when present. */
const deliverPrompt = async (
  deps: SteerDeps,
  agent: SteerAgentLike,
  message: unknown,
  mode: 'queue' | 'steer',
): Promise<WriteOutcome> => {
  if (deps.writer !== undefined) return deps.writer.prompt(agent.session.id, message, mode)
  if (mode === 'queue') agent.followup(message)
  else agent.steer(message)
  return { kind: 'committed', value: undefined }
}

/** Deliver one exact queued occurrence, matching the official updateQueue
 * steer operation when the semantic writer is installed. */
const deliverQueued = async (
  deps: SteerDeps,
  agent: SteerAgentLike,
  messageId: string,
): Promise<WriteOutcome> => {
  if (deps.writer !== undefined) return deps.writer.steerQueued(agent.session.id, messageId)
  const message = agent.inbox.nextTurn.find(item => item.id === messageId)
  if (message === undefined) {
    return { kind: 'rejected', error: { code: 'session/queue-item-not-found', message: 'queued item is no longer pending' } }
  }
  if (agent.status !== 'running') {
    return { kind: 'rejected', error: { code: 'session/steer-unavailable', message: 'steering is unavailable while the session is not running' } }
  }
  try {
    agent.inbox.remove(messageId)
    agent.steer(message)
  } catch (error) {
    return {
      kind: 'indeterminate',
      error: {
        code: 'session/write-indeterminate',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  return { kind: 'committed', value: undefined }
}

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
  const agent = deps.currentAgent()
  if (agent === undefined) return 'ok'
  const generation = deps.currentGeneration()
  // dsh-web's `placement: 'queued'` is Direct's nextTurn. nextStep already
  // represents steering/context and must not be re-steered by this gesture.
  const snapshot = onlyDraft ? [] : [...agent.inbox.nextTurn]
  // Gate B: when the caller told us the draft carries NO payload, nothing to
  // send is a clean no-op for both onlyDraft and full Ctrl+S.
  if (options.draftHasPayload === false && snapshot.length === 0) return 'ok'
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
  if (onlyDraft) {
    // Busy-Enter steers the draft only; explicitly queued messages stay queued.
    const message = deps.createDraft(text)
    const outcome = await deliverPrompt(deps, now, message, now.status === 'running' ? 'steer' : 'queue')
    return handleWriteOutcome(deps, text, outcome)
  }
  if (snapshot.length === 0) {
    // Classic single-draft path: the writer decides how an idle/active
    // session treats the caller-selected steer mode.
    const message = deps.createDraft(text)
    const outcome = await deliverPrompt(deps, now, message, now.status === 'running' ? 'steer' : 'queue')
    return handleWriteOutcome(deps, text, outcome)
  }
  const includeDraft = options.draftHasPayload ?? text.trim() !== ''
  let steeredCount = 0
  let converged = false
  for (const message of snapshot) {
    const outcome = await deliverQueued(deps, now, message.id)
    if (outcome.kind === 'committed') {
      steeredCount += 1
      continue
    }
    if (isConvergentQueueSteer(outcome)) {
      // Match dsh-web: the snapshot is no longer authoritative, so end this
      // sweep quietly rather than replaying the stale message or racing ahead.
      converged = true
      break
    }
    if (outcome.kind === 'cancelled') throw cancellationError('queue steer cancelled')
    if (outcome.kind === 'indeterminate') {
      if (includeDraft) deps.restoreDraft(text) // the draft has not been tried
      deps.notify(`queue steering became indeterminate after ${steeredCount} message${steeredCount === 1 ? '' : 's'} — do not retry automatically`, 'error')
      return 'indeterminate'
    }
    // A known refusal did not attempt the draft. Restore only a draft that was
    // actually part of this gesture; queue progress remains visible in Host.
    if (includeDraft) {
      const verbatim = deps.restoreDraft(text)
      deps.notify(verbatim
        ? `queue steering stopped after ${steeredCount} message${steeredCount === 1 ? '' : 's'}: ${deps.staleNotice()}`
        : deps.mergedNotice(), 'error')
    } else {
      deps.notify(`queue steering stopped after ${steeredCount} message${steeredCount === 1 ? '' : 's'}`, 'error')
    }
    return 'stale'
  }
  // The draft is a separate official prompt, sent only after the queue phase
  // has reached a normal/convergent stop. It is never replayed from a queue
  // copy and it may be delivered even when the queue snapshot raced closed.
  if (includeDraft) {
    const message = deps.createDraft(text)
    const outcome = await deliverPrompt(deps, now, message, 'steer')
    const settlement = handleWriteOutcome(deps, text, outcome)
    if (settlement !== 'ok') return settlement
    steeredCount += 1
  }
  if (steeredCount > 0 && !converged) {
    deps.notify(`steering ${steeredCount} message${steeredCount === 1 ? '' : 's'}`, 'info')
  } else if (steeredCount > 0 && includeDraft) {
    deps.notify(`steering ${steeredCount} message${steeredCount === 1 ? '' : 's'} (queue changed during sweep)`, 'info')
  }
  return 'ok'
}
