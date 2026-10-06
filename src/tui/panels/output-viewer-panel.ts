/**
 * The live job-output viewer panel (TS4 plan §27): the overlay width/height
 * constants and the title/body/hint panel that owns its own refresh timer.
 *
 * Moved verbatim out of `tui-app.ts`. The `openOutputViewer` lifecycle, the
 * overlay broker and close/back ownership stay in `TuiApp`/the application
 * surface; the job semantic stop action is untouched.
 * @module @xmoon76/dsh-pi-tui/tui/panels/output-viewer-panel
 */

import { Text } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'

/** The job-output viewer overlay width (cells) and max height (rows); the
 * responsive shell and the fork overlay share these so the body row budget
 * always matches the physically granted box. */
export const OUTPUT_VIEWER_WIDTH = 88
export const OUTPUT_VIEWER_MAX_HEIGHT = 24
/** The chrome rows around the viewer body: one blank separator above and
 * one below (the hint row itself is counted separately). */
const OUTPUT_VIEWER_SEPARATOR_ROWS = 2
// Supported-height floor (documented, not a fallback): the bordered viewer
// needs one row above and one below its content, so the action-hint contract
// holds while the terminal grants at least TWO rows (top border + the hint).
// A ONE-row terminal cannot render any bordered-overlay content at all — the
// fork keeps only the first `maxHeight` lines and the frame's top border is
// always first. The panel still degrades to the hint alone (never overflows).

/**
 * The live job-output viewer: a title line, a refreshable body, and a
 * fixed BOTTOM action hint. The hint is panel chrome (never appended to
 * the body string). The fork keeps only the FIRST `maxHeight` rendered
 * lines (`overlayLines.slice(0, maxHeight)`), dropping the tail, so the
 * layout reserves the hint and title BEFORE the body: on a long body or a
 * short terminal the body shrinks (to zero) rather than the hint vanishing.
 * The chrome also has a HORIZONTAL priority: the close/back verb outranks
 * Stop, so a wrapped `S stop · Esc back` degrades to `Esc back` instead of
 * leaving the first wrapped line (all Stop) on screen.
 */
export class OutputViewerPanel implements Component {
  private readonly title: Text
  private readonly body: Text
  private readonly hint: Text
  /** The close-only hint used when the full hint does not fit one row. */
  private readonly hintFallback: Text
  /** The granted CONTENT row budget (set by the responsive shell: the
   * overlay's clamped max height minus its top/bottom border rows). */
  private maxRows = OUTPUT_VIEWER_MAX_HEIGHT - 2
  /** Key routing installed by openOutputViewer (Esc closes, the stop
   * semantic stops). */
  handleInput?: (data: string) => void
  /** The refresh interval. The PANEL owns it (X007 ownership): final
   * teardown (overlay disposeOnHide → FocusForwardingFrame.dispose →
   * this.dispose) clears it even when the caller never invokes the
   * closer — a ref'd interval must not outlive the surface. */
  private timer: NodeJS.Timeout | undefined
  private refresh: (() => string) | undefined
  private liveHint: (() => { hint: string; fallback: string }) | undefined
  private requestRender: (() => void) | undefined
  /** Latched by dispose(): an in-flight tick must not render. */
  private disposed = false

  constructor(title: string, initial: string, hint: string, hintFallback: string) {
    this.title = new Text(title, 0, 0)
    this.body = new Text(initial, 0, 0)
    this.hint = new Text(hint, 0, 0)
    this.hintFallback = new Text(hintFallback, 0, 0)
  }

  invalidate(): void {
    this.title.invalidate()
    this.body.invalidate()
    this.hint.invalidate()
    this.hintFallback.invalidate()
  }

  /** Replace the output body (the caller refreshes it on a timer). */
  setBody(text: string): void {
    this.body.setText(text)
    this.body.invalidate()
  }

  /** Adopt the granted overlay row budget (resize-aware). */
  setMaxRows(maxRows: number): void {
    this.maxRows = Math.max(1, Math.floor(maxRows))
  }

  /** Start the refresh timer (openOutputViewer wires the live callbacks).
   * The interval is unref'd so a viewer left open never blocks process
   * exit by itself, and owned by THIS panel so the dispose chain stops
   * it exactly once. The optional `liveHint` re-evaluates BOTH hint forms
   * on every tick, so a stop capability that expires while the viewer is
   * open updates the chrome with the body. */
  startRefreshing(
    refresh: () => string,
    requestRender: () => void,
    intervalMs: number,
    liveHint?: () => { hint: string; fallback: string },
  ): void {
    this.refresh = refresh
    this.requestRender = requestRender
    this.liveHint = liveHint
    this.timer = setInterval(() => {
      if (this.disposed) return
      this.body.setText(this.refresh!())
      this.body.invalidate()
      if (this.liveHint !== undefined) {
        const next = this.liveHint()
        this.hint.setText(next.hint)
        this.hint.invalidate()
        this.hintFallback.setText(next.fallback)
        this.hintFallback.invalidate()
      }
      this.requestRender!()
    }, intervalMs)
    this.timer.unref()
  }

  /** Stop the refresh timer (the overlay is closing / the surface dies). */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  render(width: number): string[] {
    const maxRows = Math.max(1, this.maxRows)
    // HORIZONTAL priority: the close/back verb must survive even when the
    // combined hint word-wraps (a wrapped first line could be all Stop).
    const fullHintLines = this.hint.render(width)
    const hintLines = fullHintLines.length > 1 ? this.hintFallback.render(width) : fullHintLines
    // VERTICAL priority: the (chosen) hint is mandatory chrome, then the
    // title, then the separators, then the body. The body absorbs the
    // remainder (0 rows on a genuinely short box). Output length is <=
    // maxRows in every branch, so the fork's first-`maxHeight`-lines clip can
    // never reach the bottom hint.
    const hint = hintLines.slice(0, maxRows)
    let remaining = maxRows - hint.length
    const titleLines = this.title.render(width)
    const title = titleLines.slice(0, remaining)
    remaining -= title.length
    const bodyLines = this.body.render(width)
    if (remaining <= 0) return [...title, ...hint]
    if (remaining === 1) return [...title, ...bodyLines.slice(0, 1), ...hint]
    if (remaining === 2) return [...title, '', ...bodyLines.slice(0, 1), ...hint]
    return [
      ...title,
      '',
      ...bodyLines.slice(0, remaining - OUTPUT_VIEWER_SEPARATOR_ROWS),
      '',
      ...hint,
    ]
  }
}
