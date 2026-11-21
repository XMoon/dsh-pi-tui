/**
 * The live job-output viewer panel (TS4 plan §27): the overlay width/height
 * constants and the title/body/hint panel that owns its own refresh timer.
 *
 * The `openOutputViewer` lifecycle, the overlay broker and close/back ownership
 * stay in `TuiApp`/the application surface; the job semantic stop action is
 * untouched.
 *
 * This panel also owns the ONE pointer-capable action bar of the fullscreen
 * surface: while the overlay's own mount screen is the active `TuiAltScreen`,
 * it paints the SAME live Stop/Close truth as complete `Verb [Key]` segments and
 * publishes their exact spans, and a same-cell press/release runs the existing
 * `onStop`/close intents. The Regular/Main surface keeps the historical
 * keyboard-only hint and never creates this route.
 * @module @xmoon76/dsh-pi-tui/tui/panels/output-viewer-panel
 */

import { Text, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { sanitizeDisplayLog, sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { color } from '../theme/runtime.ts'

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

/** One clickable action of the viewer's ONE bar. */
export interface OutputViewerAction {
  readonly action: 'stop' | 'close'
  /** The complete segment text, e.g. `Stop [S]` / `Close [Esc]`. */
  readonly text: string
  readonly priority: number
  readonly role: 'primary' | 'secondary'
}

/** The live chrome the owner supplies: the historical keyboard hint forms (the
 *  Regular/Main surface) plus the clickable fullscreen segments. Both are
 *  derived from the SAME live Stop capability. */
export interface OutputViewerBar {
  readonly legacy: { readonly hint: string; readonly fallback: string }
  readonly actions: readonly OutputViewerAction[]
}

/** The owner-injected pointer route. It exists only while the overlay's OWN
 *  mount screen is the CURRENT active `TuiAltScreen`; the live capability and
 *  the two existing sinks are read through it. */
export interface OutputViewerMouseRoute {
  readonly enabled: () => boolean
  /** The live Stop capability, re-proved at the release (never a cached bool). */
  readonly stopAvailable: () => boolean
  /** The ONE existing `tasks.stop` sink. */
  readonly onStop: () => void
  /** The existing close-once intent (`requestClose`). */
  readonly onClose: () => void
}

/** One fully painted action of the LAST frame, in the panel's own columns. */
interface PaintedBarAction {
  readonly action: 'stop' | 'close'
  readonly startCol: number
  readonly endCol: number
}

interface PressedBarAction extends PaintedBarAction {
  readonly row: number
  readonly width: number
  readonly height: number
}

/**
 * The live job-output viewer: a title line, a refreshable body, and a
 * fixed BOTTOM action bar. The bar is panel chrome (never appended to
 * the body string). The fork keeps only the FIRST `maxHeight` rendered
 * lines (`overlayLines.slice(0, maxHeight)`), dropping the tail, so the
 * layout reserves the bar and title BEFORE the body: on a long body or a
 * short terminal the body shrinks (to zero) rather than the bar vanishing.
 * The chrome also has a HORIZONTAL priority: the close/back verb outranks
 * Stop, so a row that cannot carry both degrades to the close verb instead of
 * leaving a half-drawn Stop on screen.
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
  /** The live chrome source (legacy hint forms + pointer segments). */
  private bar: (() => OutputViewerBar) | undefined
  /** The AltScreen-only pointer route, or undefined on the Regular surface. */
  private mouseRoute: OutputViewerMouseRoute | undefined
  /** The complete painted bar actions of the LAST frame (panel-local cells). */
  private paintedBar: readonly PaintedBarAction[] = []
  /** The ONE press-time action a same-cell release must re-prove. */
  private pressedBar: PressedBarAction | undefined
  /** The bar's content row in the LAST frame and that frame's geometry. */
  private barRow = -1
  private lastRenderWidth = -1
  private lastRenderHeight = -1
  /** The refresh interval. The PANEL owns it (X007 ownership): final
   * teardown (overlay disposeOnHide → FocusForwardingFrame.dispose →
   * this.dispose) clears it even when the caller never invokes the
   * closer — a ref'd interval must not outlive the surface. */
  private timer: NodeJS.Timeout | undefined
  private refresh: (() => string) | undefined
  private requestRender: (() => void) | undefined
  /** Latched by dispose(): an in-flight tick must not render. */
  private disposed = false

  constructor(title: string, initial: string, hint: string, hintFallback: string) {
    // The title/bar are app chrome over Host-supplied identity; the body is
    // the live Job log stream (whitelisted SGR only).
    this.title = new Text(sanitizeDisplayText(title), 0, 0)
    this.body = new Text(sanitizeDisplayLog(initial), 0, 0)
    this.hint = new Text(sanitizeDisplayText(hint), 0, 0)
    this.hintFallback = new Text(sanitizeDisplayText(hintFallback), 0, 0)
  }

  invalidate(): void {
    this.title.invalidate()
    this.body.invalidate()
    this.hint.invalidate()
    this.hintFallback.invalidate()
  }

  /** Install the live chrome source (legacy forms + fullscreen segments). */
  setBar(source: (() => OutputViewerBar) | undefined): void {
    this.bar = source
  }

  /** Install (or withdraw) the AltScreen-only pointer route. */
  setMouseRoute(route: OutputViewerMouseRoute | undefined): void {
    this.mouseRoute = route
    this.pressedBar = undefined
    this.paintedBar = []
  }

  /** Replace the output body (the caller refreshes it on a timer). */
  setBody(text: string): void {
    this.body.setText(sanitizeDisplayLog(text))
    this.body.invalidate()
  }

  /** Adopt the granted overlay row budget (resize-aware). */
  setMaxRows(maxRows: number): void {
    this.maxRows = Math.max(1, Math.floor(maxRows))
  }

  /**
   * Start the refresh timer (openOutputViewer wires the live callbacks).
   * The interval is unref'd so a viewer left open never blocks process
   * exit by itself, and owned by THIS panel so the dispose chain stops
   * it exactly once. Every tick repaints from the LIVE chrome source, so a
   * Stop capability that expires while the viewer is open updates the bar
   * with the body — and the release still re-proves the capability itself.
   */
  startRefreshing(
    refresh: () => string,
    requestRender: () => void,
    intervalMs: number,
  ): void {
    this.refresh = refresh
    this.requestRender = requestRender
    this.timer = setInterval(() => {
      if (this.disposed) return
      this.body.setText(sanitizeDisplayLog(this.refresh!()))
      this.body.invalidate()
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
    this.pressedBar = undefined
    this.paintedBar = []
    this.mouseRoute = undefined
  }

  /**
   * Mouse parity: the bar painted by the LAST render decides what a pointer
   * event may act on. A press records the exact action + cells; a synthesized
   * click only runs it when the same physical row still resolves to the same
   * action over the same width/height. The live Stop capability is re-proved
   * at the release, so a settle between press and click refuses the action.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const route = this.mouseRoute
    if (this.disposed || route === undefined || !route.enabled()) return undefined
    if (event.button !== 'left') return undefined
    if (event.type !== 'press' && event.type !== 'click') return undefined
    // A click ends any gesture, and every left press starts a fresh one: the
    // latch is released BEFORE the geometry/action lookup, so a press on stale
    // or inert geometry still replaces it (a later synthesized click must not
    // match a stale action).
    const pressed = this.pressedBar
    this.pressedBar = undefined
    if (event.type === 'press') {
      // The painted spans are only valid for the last painted content box: a
      // resize that has not repainted must not dispatch against stale geometry.
      if (event.width !== this.lastRenderWidth || event.height !== this.lastRenderHeight) return undefined
      const hit = this.paintedBar.find(action => this.barRow === event.y
        && event.x >= action.startCol && event.x < action.endCol)
      if (hit === undefined) return undefined
      this.pressedBar = { ...hit, row: event.y, width: event.width, height: event.height }
      return { handled: true }
    }
    if (pressed === undefined) return undefined
    if (pressed.width !== event.width || pressed.height !== event.height) return undefined
    if (pressed.row !== event.y || this.barRow !== event.y) return undefined
    const hit = this.paintedBar.find(action => event.x >= action.startCol && event.x < action.endCol)
    if (hit === undefined
      || hit.action !== pressed.action
      || hit.startCol !== pressed.startCol
      || hit.endCol !== pressed.endCol) return undefined
    if (hit.action === 'stop') {
      // Never a cached boolean: the capability is read NOW, so a Stop that
      // settled (or a Job that left the registry) between press and release
      // cannot run.
      if (!route.stopAvailable()) return undefined
      route.onStop()
      return { handled: true }
    }
    route.onClose()
    return { handled: true }
  }

  /** Paint the fullscreen bar: complete `Verb [Key]` segments through the
   *  shared row layout, the close verb surviving Stop, and only the FULLY
   *  painted spans becoming pointer targets. */
  private renderMouseBar(width: number): { readonly line: string; readonly actions: readonly PaintedBarAction[] } {
    const actions = this.bar?.().actions ?? []
    const layout = layoutActionBarRow(actions.map(action => ({ text: action.text, priority: action.priority })), width)
    if (actions.length === 0 || layout.truncated || layout.spans.length === 0) {
      return { line: color.textMuted(layout.text), actions: [] }
    }
    const paintedActions: PaintedBarAction[] = []
    const painted = layout.spans.map(span => {
      const action = actions[span.inputIndex]!
      paintedActions.push({ action: action.action, startCol: span.startCol, endCol: span.endCol })
      return paintActionSpan(span.text, action.role)
    })
    const segmentWidth = layout.spans.reduce((sum, span) => sum + visibleWidth(span.text), 0)
      + Math.max(0, layout.spans.length - 1) * visibleWidth(ACTION_BAR_SEPARATOR)
    const padding = Math.max(0, visibleWidth(layout.text) - segmentWidth)
    return {
      line: painted.join(color.textMuted(ACTION_BAR_SEPARATOR)) + ' '.repeat(padding),
      actions: paintedActions,
    }
  }

  /** The historical keyboard-only hint (Regular/Main keeps the established
   *  presentation byte for byte). */
  private renderLegacyBar(width: number): string[] {
    const live = this.bar?.()
    if (live !== undefined) {
      this.hint.setText(sanitizeDisplayText(live.legacy.hint))
      this.hint.invalidate()
      this.hintFallback.setText(sanitizeDisplayText(live.legacy.fallback))
      this.hintFallback.invalidate()
    }
    const fullHintLines = this.hint.render(width)
    return fullHintLines.length > 1 ? this.hintFallback.render(width) : fullHintLines
  }

  render(width: number): string[] {
    const maxRows = Math.max(1, this.maxRows)
    this.lastRenderWidth = width
    const mouseEnabled = this.mouseRoute?.enabled() === true
    const mouseBar = mouseEnabled ? this.renderMouseBar(width) : undefined
    const barLines = mouseBar === undefined ? this.renderLegacyBar(width) : [mouseBar.line]
    this.paintedBar = mouseBar?.actions ?? []
    // VERTICAL priority: the (chosen) bar is mandatory chrome, then the
    // title, then the separators, then the body. The body absorbs the
    // remainder (0 rows on a genuinely short box). Output length is <=
    // maxRows in every branch, so the fork's first-`maxHeight`-lines clip can
    // never reach the bottom bar.
    const hint = barLines.slice(0, maxRows)
    let remaining = maxRows - hint.length
    const titleLines = this.title.render(width)
    const title = titleLines.slice(0, remaining)
    remaining -= title.length
    const bodyLines = this.body.render(width)
    let lines: string[]
    if (remaining <= 0) lines = [...title, ...hint]
    else if (remaining === 1) lines = [...title, ...bodyLines.slice(0, 1), ...hint]
    else if (remaining === 2) lines = [...title, '', ...bodyLines.slice(0, 1), ...hint]
    else {
      lines = [
        ...title,
        '',
        ...bodyLines.slice(0, remaining - OUTPUT_VIEWER_SEPARATOR_ROWS),
        '',
        ...hint,
      ]
    }
    // The mouse bar is ONE row and is always the last content row; the pointer
    // row index and the gesture fence are THIS frame's real geometry (never the
    // terminal's row count).
    this.lastRenderHeight = lines.length
    this.barRow = mouseBar === undefined ? -1 : lines.length - 1
    return lines
  }
}
