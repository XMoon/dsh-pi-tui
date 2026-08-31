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
 *   ↓ submit accepted (Enter / Ctrl+S / `!` submit) — epoch++
 * pending (detail: 'submit' → Submitting… / 'queued' → Queued…)
 *   ↓ authoritative event (inbox inserted / user message / turn start)
 *      or session switch or THIS gesture's failure/cancel
 * idle
 * ```
 *
 * Two settle flavors, deliberately different:
 *
 * - **Gesture-bound (token) settles** — a submission's OWN terminal exits
 *   (failure, stale, fence, cancel, command routing) carry the epoch
 *   token returned by their `accept`. The settle only applies while that
 *   token is still the CURRENT epoch: an older submission dying late must
 *   never clear the newer gesture's pending row (`!slow` cancelled after
 *   `!fast` was accepted is the canonical repro).
 * - **Coalescing (tokenless) settles** — authoritative session events
 *   settle whatever row is currently pending WITHOUT identity: same-
 *   session writes are serialized by the operation barrier (single
 *   writer), so any of them is a truthful "the write path is alive"
 *   signal for the row the user is looking at. A session switch settles
 *   tokenless too (the old session's row must die unconditionally).
 *
 * A settle on idle is a no-op, so callers can settle unconditionally from
 * every exit path. Accepting overwrites any older pending state (the
 * newest gesture decides what the row says) and bumps the epoch, which
 * invalidates every older token.
 * @module @xmoon76/dsh-pi-tui/submit-ack
 */

/** What the pending row advertises: a fresh submission (idle agent — the
 * next turn starts from it) or a queued one (running agent — the input
 * rides the inbox). */
export type SubmitPendingDetail = 'submit' | 'queued'

/** The mutable submit-ack state: what is pending, since when, and under
 * which gesture epoch. */
export interface SubmitAckState {
  /** Monotonic gesture counter: bumped by EVERY accept; the accept
   * returns the new value as the gesture's settle token. */
  epoch: number
  detail: SubmitPendingDetail | undefined
  /** The accept timestamp (ms), for settlement elapsed. */
  acceptedAt: number | undefined
}

/** Fresh idle state (epoch starts at 0; the first accept mints epoch 1). */
export function freshSubmitAckState(): SubmitAckState {
  return { epoch: 0, detail: undefined, acceptedAt: undefined }
}

/** Whether a pending state is alive (the working row shows its label). */
export function submitAckPending(state: SubmitAckState): boolean {
  return state.detail !== undefined
}

/**
 * Accept one submission: the pending state binds to this gesture (an
 * older pending state — a submission still waiting for its first event —
 * is superseded by the newest gesture, which the row reflects). Returns
 * the gesture's EPOCH TOKEN: the caller's terminal exits (failure /
 * stale / fence / cancel) must settle with THIS token, and the settle is
 * ignored once a newer gesture has superseded it.
 */
export function acceptSubmitAck(state: SubmitAckState, options: {
  detail: SubmitPendingDetail
  now: number
}): number {
  state.epoch += 1
  state.detail = options.detail
  state.acceptedAt = options.now
  return state.epoch
}

/**
 * Settle the pending state. Returns the accepted → settled elapsed (ms)
 * when a pending state was actually settled, otherwise undefined (already
 * idle, or a TOKEN settle superseded by a newer gesture — a stale token
 * never clears the newer row and never double-notifies).
 *
 * @param token - the gesture epoch returned by {@link acceptSubmitAck}.
 * When provided, the settle applies ONLY if that epoch is still current
 * (gesture-bound terminal exit). When omitted, the settle is COALESCING:
 * it applies to whatever row is pending (authoritative session events,
 * session switch — see the module doc).
 */
export function settleSubmitAck(state: SubmitAckState, options: {
  now: number
  token?: number
}): number | undefined {
  if (options.token !== undefined && options.token !== state.epoch) return undefined
  if (state.detail === undefined) return undefined
  const elapsed = state.acceptedAt === undefined ? undefined : Math.max(0, options.now - state.acceptedAt)
  state.detail = undefined
  state.acceptedAt = undefined
  return elapsed
}

/** The working-row label for a pending state ('Queued…' / 'Submitting…'). */
export function submitAckLabel(detail: SubmitPendingDetail): string {
  return detail === 'queued' ? 'Queued…' : 'Submitting…'
}