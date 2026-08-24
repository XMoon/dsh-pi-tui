/**
 * Selected-row marquee (the 2026-08-24 UX plan, item 4): when a picker's
 * selected row overflows its label budget, the label scrolls horizontally
 * cell by cell instead of sitting truncated — only the MAIN LABEL moves,
 * never the tree connector, suffix, status, or elapsed (those are fixed
 * layout regions of the row).
 *
 * The motion is a deterministic function of a per-row timeline, so tests
 * drive it with a fake clock (no real timers): each row identity (key +
 * text + width) anchors a cycle —
 *
 * ```text
 * initial pause (800ms) → step every 250ms until the tail → end pause
 * (700ms) → back to the start
 * ```
 *
 * A timer is armed ONLY while a selected overflowing row is on screen
 * (one marquee timer per panel, never per row), it is unref()'d, and it
 * is cleared on dispose. The window is sliced by VISIBLE CELLS (never
 * raw `string.slice`) so CJK/emoji/ZWJ never split mid-grapheme.
 * @module @xmoon76/dsh-pi-tui/marquee
 */

import { sliceByColumn, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'

/** Pause before the label starts moving (ms). */
export const MARQUEE_INITIAL_PAUSE_MS = 800
/** One cell per step (ms). */
export const MARQUEE_STEP_MS = 250
/** Pause at the tail before looping (ms). */
export const MARQUEE_END_PAUSE_MS = 700

/** The timeline phase of one marquee cycle. */
export type MarqueePhase = 'initial-pause' | 'stepping' | 'end-pause'

/** The resolved marquee state at one instant (pure timeline math). */
export interface MarqueeStateAt {
  /** The current cell offset into the label (0 = the label start). */
  readonly offset: number
  /** The phase the instant falls in. */
  readonly phase: MarqueePhase
  /** The number of ms until the NEXT phase transition (0 = already at
   * the cycle boundary; the caller re-resolves on the next tick). */
  readonly msToNext: number
}

/**
 * Pure timeline resolution: where a marquee is at `elapsed` ms into its
 * cycle. The cycle is deterministic — initial pause, one step per
 * `stepMs` cell, end pause, loop — so tests can assert exact offsets at
 * exact fake-clock times (plan §14.3) without any real timer.
 * @param elapsed - ms since the cycle's anchor (0 = cycle start).
 * @param maxOffset - the farthest offset (label width - window width);
 *   0 means the label fits (caller should not marquee at all).
 * @param initialPauseMs - wait before the first step.
 * @param stepMs - one cell per this many ms.
 * @param endPauseMs - hold at the tail.
 */
export function marqueeStateAt(
  elapsed: number,
  maxOffset: number,
  initialPauseMs = MARQUEE_INITIAL_PAUSE_MS,
  stepMs = MARQUEE_STEP_MS,
  endPauseMs = MARQUEE_END_PAUSE_MS,
): MarqueeStateAt {
  const max = Math.max(0, Math.floor(maxOffset))
  if (max === 0) return { offset: 0, phase: 'initial-pause', msToNext: Number.POSITIVE_INFINITY }
  const stepSpan = stepMs * max
  const cycle = initialPauseMs + stepSpan + endPauseMs
  const t = ((elapsed % cycle) + cycle) % cycle
  if (t < initialPauseMs) {
    return { offset: 0, phase: 'initial-pause', msToNext: initialPauseMs - t }
  }
  if (t < initialPauseMs + stepSpan) {
    const into = t - initialPauseMs
    const offset = Math.floor(into / stepMs)
    return { offset, phase: 'stepping', msToNext: stepMs - (into % stepMs) }
  }
  return { offset: max, phase: 'end-pause', msToNext: cycle - t }
}

/** One selected row's marquee driver. At most ONE instance per panel. */
export class SelectedMarquee {
  private readonly requestRender: () => void
  private readonly initialPauseMs: number
  private readonly stepMs: number
  private readonly endPauseMs: number
  /** Injectable clock (tests use a fake; production defaults to Date.now). */
  private readonly now: () => number
  /** The identity the current cycle is anchored to: key + text + width.
   * ANY change resets the cycle to its start (plan §7.3: selection
   * change → reset; search/type/resize changes flow through here). */
  private anchor = ''
  private anchorMs = 0
  private timer: NodeJS.Timeout | undefined
  /** The ABSOLUTE deadline (ms) the armed timer targets. Render re-arms
   * only when the deadline CHANGES — a high-frequency repaint (a 1s
   * panel tick, streaming repaints) must not keep resetting the timer and
   * pushing the transition ever later (review finding). */
  private timerDeadline = -1
  private disposed = false

  constructor(options: {
    requestRender: () => void
    initialPauseMs?: number
    stepMs?: number
    endPauseMs?: number
    now?: () => number
  }) {
    this.requestRender = options.requestRender
    this.initialPauseMs = options.initialPauseMs ?? MARQUEE_INITIAL_PAUSE_MS
    this.stepMs = options.stepMs ?? MARQUEE_STEP_MS
    this.endPauseMs = options.endPauseMs ?? MARQUEE_END_PAUSE_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Render one row's label window:
   * - not selected → ordinary ellipsis truncation;
   * - selected but fitting → the label verbatim (no animation, no timer);
   * - selected and overflowing → the marquee window at the current fake
   *   time, padded to the budget (the fixed regions never move), with the
   *   next-phase timer armed.
   * @param input - the row's identity, label text, window width, and
   *   whether it is the selected row.
   */
  render(input: { key: string; text: string; maxWidth: number; selected: boolean }): string {
    const width = Math.max(0, Math.floor(input.maxWidth))
    // An UNSELECTED row (or a zero budget) must NOT touch the marquee
    // state: a panel renders every row through this driver, and an
    // unselected row resetting the anchor (or clearing the timer) would
    // restart the selected row's cycle on EVERY repaint — it would never
    // move (review finding). Unselected rows are plain ellipsis rows; only
    // the selected row owns the anchor and the timer.
    if (!input.selected || width <= 0) {
      return truncateToWidth(input.text, Math.max(0, width), '…')
    }
    const identity = `${input.key}\u0000${input.text}\u0000${width}`
    if (identity !== this.anchor) {
      this.anchor = identity
      this.anchorMs = this.now()
    }
    const totalWidth = visibleWidth(input.text)
    if (totalWidth <= width) {
      // Fits: no marquee, no timer (the timer contract — only overflow
      // arms it, plan §7.8).
      this.clearTimer()
      return input.text
    }
    const state = marqueeStateAt(this.now() - this.anchorMs, totalWidth - width,
      this.initialPauseMs, this.stepMs, this.endPauseMs)
    const window = sliceByColumn(input.text, state.offset, width)
    const windowWidth = visibleWidth(window)
    const padded = window + ' '.repeat(Math.max(0, width - windowWidth))
    // Re-arm the timer for the NEXT phase transition (or the cycle wrap).
    this.armTimer(state.msToNext)
    return padded
  }

  /** Reset the cycle anchor to NOW (selection/search/type/resize changed
   * and the caller wants an explicit re-pause, not a mid-cycle jump). The
   * armed timer is CLEARED too: a stale repaint targeting the OLD cycle
   * must never fire after the selection moved (review round 2). The next
   * render of the newly selected row re-arms a fresh deadline. */
  reset(): void {
    this.anchor = ''
    this.clearTimer()
  }

  /** Clear the timer and mark the driver disposed (the overlay closed).
   * No render is ever requested after disposal. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.timerDeadline = -1
  }

  private armTimer(msToNext: number): void {
    if (this.disposed || !Number.isFinite(msToNext) || msToNext <= 0) {
      // 0 or already-past: the next render reads the new phase directly;
      // a finite positive delay arms the repaint.
      if (this.disposed) return
      this.clearTimer()
      return
    }
    // The deadline is ABSOLUTE (now + msToNext): while the selected row's
    // cycle is unchanged, every render resolves to the SAME deadline, so
    // the armed timer is kept instead of being cleared and re-set — a
    // repaint storm (elapsed tick, streaming) can never push the next
    // transition indefinitely into the future (review finding). Only an
    // anchor/phase change moves the deadline and re-arms.
    const deadline = this.now() + msToNext
    if (this.timer !== undefined && this.timerDeadline === deadline) return
    this.clearTimer()
    this.timerDeadline = deadline
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerDeadline = -1
      if (this.disposed) return
      this.requestRender()
    }, msToNext)
    this.timer.unref()
  }

  /** Test hook: the absolute deadline the armed timer targets (-1 when no
   * timer is armed). Asserts the re-arm-on-deadline-change contract. */
  pendingTimerDeadlineForTest(): number {
    return this.timerDeadline
  }
}

/** Create a marquee for one panel. */
export function createSelectedMarquee(
  requestRender: () => void,
  now?: () => number,
): SelectedMarquee {
  return new SelectedMarquee({ requestRender, now })
}
