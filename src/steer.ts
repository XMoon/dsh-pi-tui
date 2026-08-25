/**
 * The Ctrl+S steer-all orchestration with guard re-validation. Extracted
 * from the runner so the TOCTOU races — a queue splice or a session switch
 * while the async divergence guard reads the file — are testable headless:
 *
 * - The queue snapshot and the agent/generation identity are captured
 *   BEFORE the guard runs.
 * - AFTER the guard returns, everything is re-validated: same agent object,
 *   same session generation, same queue (same ids, same order). Anything
 *   changed aborts the send (`stale`) — the user retries against the new
 *   state, so a message spliced in during the guard is never lost and a
 *   payload can never be written to a session the guard did not check.
 * - Only the CONFIRMED message ids are removed (never `clear()`), so
 *   messages that arrived while the guard was in flight survive.
 * @module @xmoon76/dsh-pi-tui/steer
 */

import { savePayloadIdentity } from './guard.ts'
import { SessionOperationBarrier, TransitionInProgressError } from './session-operation-barrier.ts'

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

/** The guard surface: run the divergence check for one write action. */
export interface SteerGuard {
  /** Run the divergence guard; `blocked` carries the divergence kind. */
  run(identity: string): Promise<
    | { kind: 'ok' | 'forced' }
    | { kind: 'blocked'; reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed' }
  >
}

export type SteerOutcome = 'ok' | 'blocked' | 'stale'

/** Injectable dependencies of {@link steerAll}. */
export interface SteerDeps {
  /** Current live agent, re-read on every access (TOCTOU detection). */
  currentAgent(): SteerAgentLike | undefined
  /** Current session generation, re-read (session switch detection). */
  currentGeneration(): number
  guard: SteerGuard
  notify(message: string, kind: 'info' | 'error'): void
  /**
   * Restore the draft after a block (the editor keeps the text). Returns
   * true when the draft came back VERBATIM (a second identical submit can
   * force); false when it was MERGED with newer input — then the notice
   * must not promise that the next press forces.
   */
  restoreDraft(text: string): boolean
  /** Build the draft message (runner-side creation, keeps this module dsh-free). */
  createDraft(text: string): unknown
  /** The block notice text for a divergence kind. */
  blockedNotice(reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed'): string
  /** The forced-through notice text. */
  forcedNotice(): string
  /** The stale-state (retry) notice text. */
  staleNotice(): string
  /** The notice when the draft had to be MERGED with newer input: the
   * submission changed, so no force promise can be made. */
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
   * The session WRITE delivery seam (optional): when provided, the FINAL
   * delivery (steer batch / followup / queue removal) goes through it —
   * the Direct SessionWriter implements it; a Remote adapter would too.
   * Absent keeps the historical direct-agent delivery (the runner always
   * provides it).
   */
  writer?: {
    steer(sessionId: string, messages: readonly unknown[]): void
    followup(sessionId: string, message: unknown): void
    dequeue(sessionId: string, messageId: string): void
  }
  /**
   * The session operation barrier (convergence plan phase 3): the WHOLE
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
 * Enter-submit path too, so every guard-then-write flow re-checks what the
 * guard actually verified.
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
   * stay queued until Ctrl+S or the /queue actions — already-steered input
   * cannot be pulled back, so Enter must never sweep the queue along.
   */
  onlyDraft?: boolean
}

/**
 * Run one Ctrl+S send end to end: snapshot → guard → re-validate →
 * confirm-and-send. The send itself removes ONLY the confirmed message ids
 * (a queue splice during the guard survives) and steers them with the
 * draft. Any state change — agent switch, generation bump, queue change —
 * aborts with `stale` and a retry notice; nothing is written and nothing
 * is lost. With `onlyDraft` the queue is neither read nor removed: the
 * draft alone is steered (or followed up when the agent is idle).
 */
export async function steerAll(deps: SteerDeps, text: string, options: SteerAllOptions = {}): Promise<SteerOutcome> {
  // The WHOLE steer write runs inside the operation barrier (convergence
  // plan phase 3): a transition that starts while this steer awaits
  // (guard, identity checks) drains it before quiescing the old agent —
  // the `fence` quick-refusal below only covers writers that START during
  // a transition, not writers already in flight.
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


/** Deliver one message through the writer seam when present, else directly
 * on the agent (the historical Direct delivery). Runs inside steerAllCore
 * AFTER the guard confirmed the session — the writer resolves the live
 * agent by session id, so a switch that could not have happened (guarded)
 * still resolves to the same agent. */
const deliverSteer = (deps: SteerDeps, message: unknown): void => {
  const writer = deps.writer
  const agent = deps.currentAgent()
  const sessionId = agent?.session.id
  if (writer !== undefined && sessionId !== undefined) {
    writer.steer(sessionId, [message])
    return
  }
  agent?.steer(message)
}

const deliverFollowup = (deps: SteerDeps, message: unknown): void => {
  const writer = deps.writer
  const agent = deps.currentAgent()
  const sessionId = agent?.session.id
  if (writer !== undefined && sessionId !== undefined) {
    writer.followup(sessionId, message)
    return
  }
  agent?.followup(message)
}

async function steerAllCore(deps: SteerDeps, text: string, options: SteerAllOptions = {}): Promise<SteerOutcome> {
  const onlyDraft = options.onlyDraft === true
  const agent = deps.currentAgent()
  if (agent === undefined) return 'ok'
  const generation = deps.currentGeneration()
  const snapshot = onlyDraft ? [] : [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
  const verdict = await deps.guard.run(savePayloadIdentity(snapshot, text))
  if (verdict.kind === 'blocked') {
    const verbatim = deps.restoreDraft(text)
    // A merged draft is no longer the token's fingerprint: the next press
    // would NOT force. Say so instead of promising a force.
    deps.notify(verbatim ? deps.blockedNotice(verdict.reason) : deps.mergedNotice(), 'error')
    return 'blocked'
  }
  // Re-validate AFTER the guard: the agent object, the session generation
  // and the queue must all still be exactly what the guard checked. A stale
  // send restores the draft — the editor already cleared it before onSteer
  // fired, so the user must not lose their text.
  const now = deps.currentAgent()
  if (now === undefined || !sessionUnchanged({ agent, generation }, now, deps.currentGeneration())) {
    const verbatim = deps.restoreDraft(text)
    deps.notify(verbatim ? deps.staleNotice() : deps.mergedNotice(), 'error')
    return 'stale'
  }
  // The session-transition write fence: while a transition is in flight
  // (quiesce → commit) the old agent may be woken again by a followup or
  // steer — writing would target a session whose lock is about to be
  // released (the two-writers race). Refuse with a retry notice; the
  // draft is restored, nothing is lost.
  if (deps.fence?.() === true) {
    deps.restoreDraft(text)
    deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
    return 'stale'
  }
  if (onlyDraft) {
    // Busy-Enter steer: the DRAFT only — the queue (explicitly queued via
    // Ctrl+Enter or notices) is never swept along; steered input cannot be
    // pulled back, so a queued message must not be dragged into the turn
    // behind the user's back.
    if (verdict.kind === 'forced') deps.notify(deps.forcedNotice(), 'error')
    const message = deps.createDraft(text)
    if (now.status === 'running') deliverSteer(deps, message)
    else deliverFollowup(deps, message)
    return 'ok'
  }
  const current = [...now.inbox.nextTurn, ...now.inbox.nextStep]
  const unchanged = current.length === snapshot.length
    && current.every((message, index) => message.id === snapshot[index]!.id)
  if (!unchanged) {
    const verbatim = deps.restoreDraft(text)
    deps.notify(verbatim ? deps.staleNotice() : deps.mergedNotice(), 'error')
    return 'stale'
  }
  const forced = verdict.kind === 'forced'
  if (forced) deps.notify(deps.forcedNotice(), 'error')
  if (current.length === 0) {
    // Classic single-draft steer: a running turn takes it now; an idle
    // agent starts a regular turn with it.
    const message = deps.createDraft(text)
    if (now.status === 'running') now.steer(message)
    else now.followup(message)
    return 'ok'
  }
  const draft = text.trim()
  const messages = [
    ...current,
    // The draft message is built from the ORIGINAL text (never the trim):
    // the runner prepares one message whose content must match the guarded
    // payload identity exactly (round-4 finding 2). The trim only decides
    // whether a whitespace-only draft rides along.
    ...(draft === '' ? [] : [deps.createDraft(text)]),
  ]
  // Remove ONLY the confirmed messages — never clear() — so anything
  // spliced in DURING the guard survives untouched.
  for (const message of current) {
    if (deps.writer !== undefined) deps.writer.dequeue(now.session.id, message.id)
    else now.inbox.remove(message.id)
  }
  for (const message of messages) deliverSteer(deps, message)
  if (!forced) {
    deps.notify(messages.length === 1 ? 'steering 1 message' : `steering ${messages.length} messages`, 'info')
  }
  return 'ok'
}
