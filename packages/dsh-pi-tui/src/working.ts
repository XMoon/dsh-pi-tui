/**
 * The animated busy indicator shown on the row directly above the editor
 * while the agent works (a turn is streaming or a tool is running): two
 * whale emojis alternate before a dim Working label, mirroring pi's
 * WorkingStatusIndicator placement. A Text subclass whose idle text renders
 * zero rows, so the row disappears entirely when idle.
 *
 * The repaint target is INJECTED as a callback, never a concrete screen:
 * the main screen stops rendering while the alt screen (fullscreen) is
 * active, so a captured `TuiMainScreen` would freeze the animation at the
 * first frame. The callback routes to whichever screen is active.
 * @module @xmoon76/dsh-pi-tui/working
 */

import { Text } from '@xmoon76/pi-tui'
import { color } from './theme.ts'

export interface WorkingIndicatorOptions {
  /** Animation frames, alternated in order; defaults to the whale pair. */
  frames?: string[]
  /** Frame interval in milliseconds; injectable so tests stay fast. */
  intervalMs?: number
  /** The label after the animated frame. */
  message?: string
}

/**
 * A single-row busy indicator. start() shows the first frame and animates;
 * stop() halts the timer (the text stays until the caller clears it); an
 * idle instance renders nothing at all.
 */
export class WorkingIndicator extends Text {
  private readonly requestRender: () => void
  private readonly frames: string[]
  private readonly intervalMs: number
  private message: string
  private currentFrame = 0
  private intervalId: NodeJS.Timeout | undefined
  private active = false

  constructor(requestRender: () => void, options: WorkingIndicatorOptions = {}) {
    super('', 0, 0)
    this.requestRender = requestRender
    this.frames = options.frames ?? ['🐋', '🐳']
    this.intervalMs = options.intervalMs ?? 500
    this.message = options.message ?? 'Working'
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
      this.updateDisplay()
    }, this.intervalMs)
  }

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame] ?? ''
    const indicator = frame === '' ? '' : frame + '  '
    this.setText(indicator + color.textDim(this.message))
    this.requestRender()
  }
}
