/**
 * The animated busy indicator shown on the row directly above the editor
 * while the agent works (a turn is streaming or a tool is running): two
 * frames alternate before a dim Working label, mirroring pi's
 * WorkingStatusIndicator placement. A Text subclass whose idle text renders
 * zero rows, so the row disappears entirely when idle.
 *
 * The repaint target is INJECTED as a callback, never a concrete screen:
 * the main screen stops rendering while the alt screen (fullscreen) is
 * active, so a captured `TuiMainScreen` would freeze the animation at the
 * first frame. The callback routes to whichever screen is active.
 *
 * Frames follow the icon style through {@link workingFramesFor}: the whale
 * pair under `emoji`, the `• / ◦` pair under `symbols` AND `minimal`
 * (minimal removes static icons — it does not change animation semantics).
 * An EXPLICIT `frames` option (an extension/advanced custom indicator) is
 * never overwritten by an icon-style change.
 * @module @xmoon76/dsh-pi-tui/working
 */

import { Text } from '@xmoon76/pi-tui'
import type { IconStyle } from './icons.ts'
import { color } from './theme.ts'

/** The DEFAULT animation frames for one icon style. `symbols` and
 * `minimal` share the low-noise pair — a reduced-motion preference would
 * be its own setting, never smuggled into the icon style. */
export function workingFramesFor(style: IconStyle): readonly string[] {
  return style === 'emoji' ? ['🐋', '🐳'] : ['•', '◦']
}

export interface WorkingIndicatorOptions {
  /** Animation frames, alternated in order; defaults to the icon-style
   * pair. An EXPLICIT value is a custom indicator and is preserved across
   * icon-style switches (setIconStyleFrames never overwrites it). */
  frames?: string[]
  /** Frame interval in milliseconds; injectable so tests stay fast. */
  intervalMs?: number
  /** The label after the animated frame. */
  message?: string
}

/** An animated suffix attached to the working row (e.g. an indeterminate
 * progress bar): its frames cycle on the indicator's OWN frame tick —
 * never a second timer. */
export interface WorkingIndicatorAnimation {
  /** The suffix frames, cycled in order on every indicator tick. */
  frames: readonly string[]
}

/**
 * A single-row busy indicator. start() shows the first frame and animates;
 * stop() halts the timer (the text stays until the caller clears it); an
 * idle instance renders nothing at all.
 */
export class WorkingIndicator extends Text {
  private readonly requestRender: () => void
  private frames: string[]
  /** An EXPLICIT caller-provided frame set — icon-style switches must never
   * overwrite a custom indicator (plan §13.2). */
  private readonly customFrames: readonly string[] | undefined
  private readonly intervalMs: number
  private message: string
  private currentFrame = 0
  private suffixFrames: readonly string[] = []
  private suffixFrame = 0
  private intervalId: NodeJS.Timeout | undefined
  private active = false

  constructor(requestRender: () => void, options: WorkingIndicatorOptions = {}) {
    super('', 0, 0)
    this.requestRender = requestRender
    this.customFrames = options.frames
    this.frames = [...(options.frames ?? workingFramesFor('emoji'))]
    this.intervalMs = options.intervalMs ?? 500
    this.message = options.message ?? 'Working...'
  }

  /** Replace the animation frames at runtime (an active indicator repaints
   * with the new set immediately; the frame position is clamped). This is
   * the generic setter — extension/advanced custom indicators can keep
   * swapping frames through it. A frame-COUNT change re-arms the timer:
   * shrinking to ≤1 frame clears the interval, growing re-arms it — an
   * active indicator never keeps ticking a stale interval (and never
   * modulo-zeros on an empty set). */
  setFrames(frames: readonly string[]): void {
    this.frames = [...frames]
    if (this.currentFrame >= this.frames.length) this.currentFrame = 0
    if (!this.active) return
    // restartAnimation clears the old interval and re-arms (or clears)
    // per the NEW length; updateDisplay paints the first frame.
    this.restartAnimation()
    this.updateDisplay()
  }

  /** Follow an icon-style frame set ONLY when no explicit custom frames
   * were provided — the user's iconStyle must never overwrite a
   * third-party/explicit custom working indicator (plan §13.2). */
  setIconStyleFrames(frames: readonly string[]): void {
    if (this.customFrames !== undefined) return
    this.setFrames(frames)
  }

  /** Override the label after the animated frame (Phase 4: the advanced
   * host-state working override). An active indicator repaints with the
   * new label immediately. */
  setMessage(message: string): void {
    this.message = message
    if (this.active) this.updateDisplay()
  }

  /** The current label (Phase 4 test hook — probes the override). */
  messageText(): string {
    return this.message
  }

  /** Attach an animated suffix (e.g. an indeterminate progress bar) that
   * advances on the indicator's OWN frame tick — never a second timer.
   * undefined clears the suffix. An active indicator repaints with the
   * new suffix immediately; the suffix frame position is kept so a
   * phase change (summarizing → applying) continues the motion smoothly. */
  setSuffixAnimation(animation?: WorkingIndicatorAnimation): void {
    this.suffixFrames = animation?.frames ?? []
    if (this.suffixFrames.length === 0) this.suffixFrame = 0
    if (this.active) this.updateDisplay()
  }

  /** Show the indicator and start alternating frames. Idempotent: a second
   * start while already active repaints but does not reset the timer. */
  start(): void {
    const wasActive = this.active
    this.active = true
    this.updateDisplay()
    if (!wasActive) this.restartAnimation()
  }

  /** Stop the animation; the text stays until the caller clears it. */
  stop(): void {
    this.active = false
    this.clearTimer()
  }

  /** Whether the indicator is currently animating (extension activity state). */
  isActive(): boolean {
    return this.active
  }

  /** Re-render the current frame with the LIVE palette (theme switches). */
  refresh(): void {
    if (this.active) this.updateDisplay()
  }

  /** Stop the animation and release the timer (containers call this on removal). */
  dispose(): void {
    this.stop()
  }

  /** Clear the interval WITHOUT touching the active state (restart keeps
   * the indicator live while swapping timers). */
  private clearTimer(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  private restartAnimation(): void {
    this.clearTimer()
    if (this.frames.length <= 1) return
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length
      if (this.suffixFrames.length > 0) {
        this.suffixFrame = (this.suffixFrame + 1) % this.suffixFrames.length
      }
      this.updateDisplay()
    }, this.intervalMs)
  }

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame] ?? ''
    const indicator = frame === '' ? '' : frame + '  '
    const suffix = this.suffixFrames.length > 0 ? `  ${this.suffixFrames[this.suffixFrame] ?? ''}` : ''
    this.setText(indicator + color.textDim(this.message) + suffix)
    this.requestRender()
  }
}
