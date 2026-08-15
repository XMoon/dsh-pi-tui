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
}

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

/**
 * Run one Ctrl+S send end to end: snapshot → guard → re-validate →
 * confirm-and-send. The send itself removes ONLY the confirmed message ids
 * (a queue splice during the guard survives) and steers them with the
 * draft. Any state change — agent switch, generation bump, queue change —
 * aborts with `stale` and a retry notice; nothing is written and nothing
 * is lost.
 */
export async function steerAll(deps: SteerDeps, text: string): Promise<SteerOutcome> {
  const agent = deps.currentAgent()
  if (agent === undefined) return 'ok'
  const generation = deps.currentGeneration()
  const snapshot = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
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
    ...(draft === '' ? [] : [deps.createDraft(draft)]),
  ]
  // Remove ONLY the confirmed messages — never clear() — so anything
  // spliced in DURING the guard survives untouched.
  for (const message of current) now.inbox.remove(message.id)
  for (const message of messages) now.steer(message)
  if (!forced) {
    deps.notify(messages.length === 1 ? 'steering 1 message' : `steering ${messages.length} messages`, 'info')
  }
  return 'ok'
}
