/**
 * Local submit acknowledgement (plan D): the TUI's own, immediate
 * "Submitting…" / "Queued…" feedback between the editor clearing and the
 * FIRST authoritative DSH event. The submission pipeline has a real
 * no-feedback window (session create, image admission, the host pre-step
 * before `user/message`); this local state covers it — a lightweight
 * status only, never a synthetic transcript row.
 *
 * State machine:
 *
 * ```text
 * idle
 *   ↓ submit accepted (Enter / Ctrl+S / `!` submit)
 * pending (detail: 'submit' → Submitting… / 'queued' → Queued…)
 *   ↓ authoritative event (inbox inserted / user message / turn start)
 *      or session switch or submission failure
 * idle
 * ```
 *
 * A settle on idle is a no-op, so callers can settle unconditionally from
 * every exit path. Accepting overwrites any older pending state (the
 * newest gesture decides what the row says).
 * @module @xmoon76/dsh-pi-tui/submit-ack
 */

/** What the pending row advertises: a fresh submission (idle agent — the
 * next turn starts from it) or a queued one (running agent — the input
 * rides the inbox). */
export type SubmitPendingDetail = 'submit' | 'queued'

/** The mutable submit-ack state: what is pending and since when. */
export interface SubmitAckState {
  detail: SubmitPendingDetail | undefined
  /** The accept timestamp (ms), for settlement elapsed. */
  acceptedAt: number | undefined
}

/** Fresh idle state. */
export function freshSubmitAckState(): SubmitAckState {
  return { detail: undefined, acceptedAt: undefined }
}

/** Whether a pending state is alive (the working row shows its label). */
export function submitAckPending(state: SubmitAckState): boolean {
  return state.detail !== undefined
}

/**
 * Accept one submission: the pending state binds to this gesture (an
 * older pending state — a submission still waiting for its first event —
 * is superseded by the newest gesture, which the row reflects).
 */
export function acceptSubmitAck(state: SubmitAckState, options: {
  detail: SubmitPendingDetail
  now: number
}): void {
  state.detail = options.detail
  state.acceptedAt = options.now
}

/**
 * Settle the pending state. Returns the accepted → settled elapsed (ms)
 * when a pending state was actually settled, otherwise undefined (already
 * idle — a double settle never double-notifies).
 *
 * COALESCING SEMANTICS (documented, deliberate): the pending state is a
 * SINGLE row (the working row is one line) and accepts OVERWRITE — the
 * newest gesture decides what it says. Any authoritative event settles
 * whatever row is currently pending WITHOUT identity correlation: same-
 * session writes are serialized by the operation barrier (single writer),
 * so a late event from an in-flight older submission is a truthful
 * "the write path is alive" signal for the row the user is looking at.
 * Per-submission latency timelines (submit-latency.ts) document their own
 * coalescing; bursts show approximate offsets, single submissions exact.
 */
export function settleSubmitAck(state: SubmitAckState, now: number): number | undefined {
  if (state.detail === undefined) return undefined
  const elapsed = state.acceptedAt === undefined ? undefined : Math.max(0, now - state.acceptedAt)
  state.detail = undefined
  state.acceptedAt = undefined
  return elapsed
}

/** The working-row label for a pending state ('Queued…' / 'Submitting…'). */
export function submitAckLabel(detail: SubmitPendingDetail): string {
  return detail === 'queued' ? 'Queued…' : 'Submitting…'
}