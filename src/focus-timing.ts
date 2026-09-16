/**
 * Presentation-only ephemeral timing for the live Focus turn.
 *
 * The Focus header reports how long the turn has ACTIVELY run, excluding
 * time the run spent waiting on the user (an approval prompt or a question).
 * That is not durable TurnActivity state: no Session event carries the wait
 * intervals, and the plan forbids inventing one. Instead the timer observes
 * the authoritative {@link RunPhase} transitions as they happen and freezes
 * while the phase is user-blocked. The transition also records the pause
 * WINDOWS and retains them after each pause resolves, so a live turn whose
 * map publication is delayed (one or more modals can open AND close before
 * the delayed transcript repaint publishes its activity) still subtracts
 * every wait and counts only the active spans.
 *
 * The store is keyed by the ACTIVITY OBJECT (a WeakMap), never by a bare
 * turn number: a session switch or a cold replay mints fresh activity
 * objects, so a new session can never inherit the previous one's segments.
 *
 * A completed activity that was first seen only after it ended still freezes
 * from the retained LIVE windows (the delayed-publication race); only a
 * replay with no live evidence at all falls back to its event elapsed
 * (`startedAt → endedAt`) — the plan explicitly allows that fallback and
 * forbids fabricating past waits. A live turn first observed while
 * user-blocked with no pause-boundary evidence reports an UNKNOWN duration
 * (never a fake `0s`).
 * @module @xmoon76/dsh-pi-tui/focus-timing
 */

import type { RunPhase } from './status/types.ts'
import type { TurnActivity } from './transcript.ts'

/** The user-blocked phases whose wait time is excluded from the live timer.
 * Every other phase (working, compacting, applying-compaction, idle gaps)
 * keeps accumulating — this revision only removes "waiting on the user". */
export function focusTimerPaused(phase: RunPhase): boolean {
  return phase === 'waiting-approval' || phase === 'waiting-question'
}

/** One live timing segment of an activity: `accumulated` counts finished
 * non-paused spans, `resumedAt` is the start of the currently running span
 * (undefined while paused). */
interface TimingSegment {
  /** Active millis, or undefined when the baseline is UNKNOWABLE (the turn
   * was first observed while user-blocked with no pause-boundary evidence):
   * the caller renders no duration rather than a fake `0s`. */
  accumulated: number | undefined
  resumedAt: number | undefined
}

/** One surface's Focus timer registry. */
export class FocusTimingStore {
  /** The retained-pause-window bound: unreachable in practice (the
   * delayed-publication gap is milliseconds), but keeps memory flat. */
  private static readonly MAX_PAUSE_WINDOWS = 32

  private readonly segments = new WeakMap<TurnActivity, TimingSegment>()
  /** The last authoritative phase seen, for pause-boundary tracking. */
  private phase: RunPhase | undefined
  /** User-blocked windows: `from` is when a KNOWN non-paused phase entered
   * the pause, `until` when it left (undefined while still paused). Windows
   * are RETAINED after a pause resolves: an activity whose map publication
   * is delayed can see one or more pauses open AND close before it is first
   * observed, and every wait must still be subtracted. The list is bounded
   * — only the recent windows can overlap an uninitialized activity. */
  private readonly pauseWindows: Array<{ from: number; until: number | undefined }> = []

  /**
   * Record the authoritative run phase at `now`, independent of any
   * activity. Entering a user-blocked phase from a KNOWN non-paused phase
   * opens a pause window; leaving it closes the window. With no earlier
   * phase evidence no window opens, so a cold resume can never fabricate an
   * active span.
   */
  notePhase(phase: RunPhase, now: number): void {
    const paused = focusTimerPaused(phase)
    const wasPaused = this.phase !== undefined && focusTimerPaused(this.phase)
    if (paused && !wasPaused) {
      if (this.phase !== undefined) {
        this.pauseWindows.push({ from: now, until: undefined })
        if (this.pauseWindows.length > FocusTimingStore.MAX_PAUSE_WINDOWS) this.pauseWindows.shift()
      }
    } else if (!paused && wasPaused) {
      const open = this.pauseWindows[this.pauseWindows.length - 1]
      if (open !== undefined && open.until === undefined) open.until = now
    }
    this.phase = phase
  }

  /** The user-blocked millis inside `[start, end]` across every retained
   * window. Sequential pauses never overlap, so the overlaps sum. */
  private pauseOverlap(start: number, end: number): number {
    let waited = 0
    for (const window of this.pauseWindows) {
      const pauseEnd = window.until ?? end
      waited += Math.max(0, Math.min(end, pauseEnd) - Math.max(start, window.from))
    }
    return waited
  }

  /** Drop the retained pause windows once a publication pass has seeded
   * EVERY activity that could overlap them. The owner calls this once after
   * the pass — never per activity, so all first-seen activities in one pass
   * share the same window snapshot. */
  clearPauseWindows(): void {
    this.pauseWindows.length = 0
  }

  /** Reset the SURFACE-scoped phase/window timeline at a session boundary.
   * Segments are keyed by the activity OBJECT, so a new session's freshly
   * minted activities cannot collide and need no reset; the shared phase and
   * pause windows would otherwise let the previous session's waits leak into
   * the next session's first live turn. */
  resetSessionScope(): void {
    this.phase = undefined
    this.pauseWindows.length = 0
  }

  /**
   * Observe one activity under the current authoritative phase at `now`.
   * Called from the phase projection and from every activity-map
   * publication, NOT from the renderer alone: the freeze must happen when
   * the approval/question opens, even if the surface is not repainted while
   * the modal owns the screen.
   */
  observe(activity: TurnActivity, phase: RunPhase, now: number): void {
    this.notePhase(phase, now)
    const startedAt = activity.startedAt
    if (startedAt === undefined) return
    const paused = focusTimerPaused(phase)
    const segment = this.segments.get(activity)
    if (segment !== undefined) {
      if (activity.completed) return
      if (paused) {
        if (segment.resumedAt !== undefined) {
          // An UNKNOWN baseline (accumulated === undefined) must stay
          // unknown: the pre-attach active span can never be recovered, so a
          // later wait must not turn it into a fabricated number.
          if (segment.accumulated !== undefined) {
            segment.accumulated += Math.max(0, now - segment.resumedAt)
          }
          segment.resumedAt = undefined
        }
      } else if (segment.resumedAt === undefined) {
        segment.resumedAt = now
      }
      return
    }
    if (activity.completed) {
      // A completed turn first published only after it ended still freezes
      // from the retained LIVE pause evidence; only a replay with NO live
      // windows falls back to the raw event elapsed (never re-count a wait
      // the surface actually observed — review finding).
      if (this.pauseWindows.length === 0) return
      const end = activity.endedAt ?? now
      this.segments.set(activity, {
        accumulated: Math.max(0, end - startedAt - this.pauseOverlap(startedAt, end)),
        resumedAt: undefined,
      })
      return
    }
    // First sighting of a LIVE turn.
    const openPause = this.pauseWindows[this.pauseWindows.length - 1]
    const pauseBoundary = openPause !== undefined && openPause.until === undefined ? openPause.from : undefined
    if (paused) {
      if (pauseBoundary === undefined) {
        // User-blocked with no known boundary: the active baseline is
        // UNKNOWABLE. Mark it unknown — never fabricate `0s` (the header
        // then renders `Waiting for approval` without a duration).
        this.segments.set(activity, { accumulated: undefined, resumedAt: undefined })
        return
      }
      const activeEnd = Math.min(pauseBoundary, now)
      this.segments.set(activity, {
        accumulated: Math.max(0, activeEnd - startedAt - this.pauseOverlap(startedAt, activeEnd)),
        resumedAt: undefined,
      })
      return
    }
    // Count the span from the turn's start to `now`, minus every retained
    // user-blocked window it overlaps — the waits are never counted, even
    // when a pause opened AND resolved before this activity was published.
    this.segments.set(activity, {
      accumulated: Math.max(0, now - startedAt - this.pauseOverlap(startedAt, now)),
      resumedAt: now,
    })
    // NOTE: the windows are NOT cleared here. Every activity first seen in
    // the same publication pass must be seeded from the SAME window
    // snapshot (clearing per activity would give the second one wall time
    // instead of overlap-subtracted time — review finding). The owner
    // clears once after the pass via {@link clearPauseWindows}.
  }

  /**
   * The active (non-user-blocked) elapsed millis of one activity, or
   * undefined when the turn has no reliable start OR its active baseline is
   * unknowable (never a fake `0s`). Running turns read the live segment; a
   * completed turn freezes at `endedAt`; a completed turn with no live
   * segment at all uses the event elapsed fallback. A render also observes
   * (idempotent — a paused segment stays frozen), so a surface repaint can
   * never double-count a wait.
   */
  activeMillis(activity: TurnActivity, phase: RunPhase, now: number): number | undefined {
    this.observe(activity, phase, now)
    const startedAt = activity.startedAt
    if (startedAt === undefined) return undefined
    const segment = this.segments.get(activity)
    if (segment === undefined) {
      if (activity.completed) return Math.max(0, (activity.endedAt ?? startedAt) - startedAt)
      return Math.max(0, now - startedAt)
    }
    if (segment.accumulated === undefined) return undefined
    const end = activity.completed ? (activity.endedAt ?? now) : now
    return segment.accumulated + (segment.resumedAt === undefined ? 0 : Math.max(0, end - segment.resumedAt))
  }
}

/** The default timer for a Focus component constructed outside a TuiApp
 * (tests, direct rendering). The TUI owns a per-surface store so a fresh
 * surface never inherits another run's pause windows. */
export const focusTiming = new FocusTimingStore()
