/**
 * The Ctrl+S steer-all orchestration with re-validation. Extracted
 * from the runner so the TOCTOU races — a queue splice or a session switch
 * while the send is in flight — are testable headless:
 *
 * - The queue snapshot and the agent/generation identity are captured
 *   BEFORE the awaited write window.
 * - Before the delivery, everything is re-validated: same agent object,
 *   same session generation, same queue (same ids, same order). Anything
 *   changed aborts the send (`stale`) — the user retries against the new
 *   state, so a message spliced in while the send was in flight is never
 *   lost.
 * - Only the CONFIRMED message ids are removed (never `clear()`), so
 *   messages that arrived mid-send survive.
 * @module @xmoon76/dsh-pi-tui/steer
 */

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

export type SteerOutcome = 'ok' | 'stale'

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
   * stay queued until Ctrl+S or the /queue actions — already-steered input
   * cannot be pulled back, so Enter must never sweep the queue along.
   */
  onlyDraft?: boolean
  /**
   * Whether the draft text carries a real payload (the serialized wire
   * form — `!` / `!!` shell mode makes a bare prefix payload, an
   * image-bearing draft is payload, whitespace-only is not). The RUNNER
   * decides (it owns the shell-mode / image semantics); `steer.ts` never
   * guesses. `undefined` keeps the historical behavior: any text is
   * treated as payload (the runner's empty-payload gate covers it).
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
 * Run one Ctrl+S send end to end: snapshot → re-validate →
 * confirm-and-send. The send itself removes ONLY the confirmed message ids
 * (a queue splice mid-send survives) and steers them with the
 * draft. Any state change — agent switch, generation bump, queue change —
 * aborts with `stale` and a retry notice; nothing is written and nothing
 * is lost. With `onlyDraft` the queue is neither read nor removed: the
 * draft alone is steered (or followed up when the agent is idle).
 */
export async function steerAll(deps: SteerDeps, text: string, options: SteerAllOptions = {}): Promise<SteerOutcome> {
  // The WHOLE steer write runs inside the operation barrier (convergence
  // plan phase 3): a transition that starts while this steer awaits
  // (identity checks) drains it before quiescing the old agent —
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
 * AFTER the identity check confirmed the session — the writer resolves the
 * live agent by session id, so a switch that could not have happened
 * (checked) still resolves to the same agent. */
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
   // Gate B (empty-payload no-op): when the caller told us the draft
   // carries NO payload, nothing to send is a clean no-op — for BOTH the
   // onlyDraft branch (busy-Enter steer of an empty draft) and the full
   // Ctrl+S branch (empty draft + empty queue). The queue is checked
   // BEFORE any identity work so no session-side work is ever wasted and
   // no empty followup/steer can be produced. `draftHasPayload: undefined`
   // keeps the historical semantics (the text is a payload).
  if (options.draftHasPayload === false && snapshot.length === 0) return 'ok'
  // Re-validate BEFORE the delivery: the agent object, the session
  // generation and the queue must all still be exactly what was
  // snapshotted. A stale send restores the draft — the editor already
  // cleared it before onSteer fired, so the user must not lose their text.
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
  if (current.length === 0) {
    // Classic single-draft steer: a running turn takes it now; an idle
    // agent starts a regular turn with it. The delivery goes through the
    // writer seam (SessionWriter) like every other path — never a direct
    // agent call that would bypass the semantic port.
    const message = deps.createDraft(text)
    if (now.status === 'running') deliverSteer(deps, message)
    else deliverFollowup(deps, message)
    return 'ok'
  }
  // Whether the draft rides along: the caller's explicit payload verdict
  // is AUTHORITATIVE (the runner — the only owner of shell/image
  // semantics — computed it on the wire form before calling steerAll);
  // `undefined` keeps the historical text-based behavior for callers
  // that never adopted the new contract (e.g. extension callers).
  const includeDraft = options.draftHasPayload ?? text.trim() !== ''
  const messages = [
    ...current,
    // The draft message is built from the ORIGINAL text (never the trim):
    // the runner prepares one message whose content matches the payload it
    // vetted before calling steerAll. The flag only
    // decides whether the draft rides along.
    ...(includeDraft ? [deps.createDraft(text)] : []),
  ]
  // Remove ONLY the confirmed messages — never clear() — so anything
  // spliced in mid-send survives untouched.
  for (const message of current) {
    if (deps.writer !== undefined) deps.writer.dequeue(now.session.id, message.id)
    else now.inbox.remove(message.id)
  }
  for (const message of messages) deliverSteer(deps, message)
  deps.notify(messages.length === 1 ? 'steering 1 message' : `steering ${messages.length} messages`, 'info')
  return 'ok'
}
