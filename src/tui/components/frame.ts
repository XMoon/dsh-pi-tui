/**
 * Generic overlay frame wrappers (TS4 plan §17): `Frame` is the rounded-frame
 * shell that sizes itself to its child, `FocusForwardingFrame` forwards the
 * focused flag to a Focusable child (fork X042 IME cursor marker), and
 * `ResponsiveOverlayFrame` is the root-owned responsive overlay shell that
 * re-derives its geometry from the live terminal each frame.
 *
 * Moved verbatim out of `tui-app.ts`. The question-flow and save-location
 * frames stay there: their editor seat is tied to those interaction flows
 * (plan §18).
 * @module @xmoon76/dsh-pi-tui/tui/components/frame
 */

import { dispatchMouseEvent, isFocusable, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseDispatchResult, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { color } from '../theme/runtime.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'

/**
 * Rounded-frame wrapper for overlay content: `╭─╮` border in the border
 * token, one cell of padding, width sized to the content. With `fillWidth`
 * the frame keeps the overlay's full width instead of hugging the widest
 * content row. Keyboard input forwards to the wrapped component.
 */
export class Frame implements Component {
  private readonly child: Component
  private readonly fillWidth: boolean
  /** Child content offset/width/height from the LAST render (mouse hit-testing). */
  protected childOffsetX = 2
  protected childOffsetY = 1
  protected childWidth = 0
  protected childHeight = 0

  constructor(child: Component, fillWidth = false) {
    this.child = child
    this.fillWidth = fillWidth
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data)
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.child.wantsKeyRelease
  }

  /**
   * Transparent mouse wrapper (v0.85.1 mouse integration): translate the
   * event into the child's content box (borders + one padding cell each
   * side) and forward. The gesture target is rewritten to THIS frame — the
   * child is a private field not reachable from the mounted tree, so the
   * fork's X018 gesture-liveness check tracks the frame (the mounted
   * unit), and drag/release re-enter through it with the same translation.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    const x = event.x - this.childOffsetX
    const y = event.y - this.childOffsetY
    // Reject clicks outside the child content box: the borders (and any
    // row below the rendered content) must never reach the child as a
    // valid row/column.
    if (this.childWidth === 0 || this.childHeight === 0 || x < 0 || y < 0 || x >= this.childWidth || y >= this.childHeight) {
      return undefined
    }
    const result = dispatchMouseEvent(this.child, {
      ...event,
      x,
      y,
      width: this.childWidth,
      height: this.childHeight,
    })
    if (!result) return undefined
    return {
      ...result,
      // A focus request from the child must land on THIS frame: the child
      // is a private field the focus resolver cannot see, and the overlay
      // focus state (isOverlayFocused) tracks the mounted root — otherwise
      // the alt-screen viewport listener preempts modal keyboard input.
      ...(result.focus ? { focusTarget: this } : {}),
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    }
  }

  render(width: number): string[] {
    const inner = Math.max(1, Math.floor(width) - 4)
    const lines = this.child.render(inner).map(line => truncateToWidth(line, inner, '…'))
    const contentWidth = this.fillWidth
      ? inner
      : Math.min(inner, Math.max(1, ...lines.map(line => visibleWidth(line))))
    const frameWidth = contentWidth + 4
    this.childOffsetX = 2
    this.childOffsetY = 1
    this.childWidth = contentWidth
    this.childHeight = lines.length
    const b = color.border
    const out = [b(`╭${'─'.repeat(frameWidth - 2)}╮`)]
    for (const line of lines) {
      const vis = visibleWidth(line)
      // Row shape is `│ line pad │`: borders and one padding cell each side
      // are fixed, so padding tops the content up to `contentWidth` — the row
      // is then exactly frameWidth cells, matching the border, and the right
      // border survives compositing. Padding to `inner` instead would stretch
      // rows past the border whenever the content is narrower than the panel.
      const pad = Math.max(0, contentWidth - vis)
      out.push(`${b('│')} ${line}${' '.repeat(pad)} ${b('│')}`)
    }
    out.push(b(`╰${'─'.repeat(frameWidth - 2)}╯`))
    return out
  }
}
/**
 * A Frame that forwards the focused flag to its child (fork X042 / the
 * IME cursor-marker contract): the fork sets `focused` only on the
 * component it focuses directly — a plain Frame SWALLOWS the flag, so an
 * Input-owning child behind it (HistoryPanel, the picker's search box,
 * SettingsList, TaskBrowserPanel) never emits the hardware CURSOR_MARKER
 * and the IME candidate window misplaces itself. Forwarding is a no-op
 * for non-Focusable children (plain dialogs).
 */
export class FocusForwardingFrame extends Frame implements Focusable {
  private readonly focusedChild: Component & Focusable | undefined
  /** The RAW child: the frame OWNS it regardless of Focusable-ness (round-5
   * review P2 — a non-Focusable panel behind the frame must still be
   * disposed on overlay removal). */
  private readonly ownedChild: Component
  private disposed = false

  constructor(child: Component, fillWidth = false) {
    super(child, fillWidth)
    this.ownedChild = child
    this.focusedChild = isFocusable(child) ? (child as Component & Focusable) : undefined
  }

  get focused(): boolean {
    return this.focusedChild?.focused ?? false
  }

  set focused(value: boolean) {
    if (this.focusedChild !== undefined) this.focusedChild.focused = value
  }

  /**
   * OWNING, idempotent dispose (X007): overlay removal (disposeOnHide)
   * releases the panel behind the frame — the frame is the overlay entry,
   * so the fork calls THIS, not the child. Idempotent so a close path
   * that already disposed the child can never double-fire.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ownedChild.dispose?.()
  }
}

/** Geometry passed to a live responsive overlay frame. */
export interface ResponsiveOverlayGeometry {
  width: number
  maxHeight: number
  key: string
}

/**
 * A root-owned responsive overlay shell. The fork re-resolves percentage
 * overlay options each frame, while this shell keeps a first-party frame's
 * content width and row budget derived from the same current geometry. It
 * centers a narrower design width inside the full-width overlay canvas, so
 * no modal handle needs to be replaced during a resize (and its broker graph
 * remains untouched).
 */
export class ResponsiveOverlayFrame extends FocusForwardingFrame {
  private readonly geometryOf: () => ResponsiveOverlayGeometry
  private readonly onGeometry: ((geometry: ResponsiveOverlayGeometry) => void) | undefined
  /** Teardown notification: fired exactly once when the overlay is hidden and
   *  this frame is disposed — the ONLY hide-independent signal (Esc, the
   *  returned closer, and a fullscreen screen swap all dispose the entry). */
  private readonly onDispose: (() => void) | undefined
  private disposeNotified = false
  private lastGeometryKey = ''
  /** Geometry key of the last PAINTED frame (empty before the first paint). */
  private lastPaintGeometryKey = ''

  constructor(
    child: Component,
    geometryOf: () => ResponsiveOverlayGeometry,
    onGeometry?: (geometry: ResponsiveOverlayGeometry) => void,
    onDispose?: () => void,
  ) {
    super(child, true)
    this.geometryOf = geometryOf
    this.onGeometry = onGeometry
    this.onDispose = onDispose
    this.syncGeometry()
  }

  /** Notify a teardown observer exactly once, whatever hide path removed the
   *  overlay (the frame is the owner disposed by disposeOnHide). M3-6 PR3: the
   *  owned child dispose and the one-shot notification are INDEPENDENT
   *  obligations — a throwing child dispose must not strand the notification
   *  (which removes the frame from its owner's bookkeeping). */
  dispose(): void {
    const notify = !this.disposeNotified
    this.disposeNotified = true
    runSyncDisposalSteps('responsive overlay frame disposal', [
      () => super.dispose(),
      ...notify ? [() => this.onDispose?.()] : [],
    ])
  }

  /** Re-run the geometry callback without scheduling a frame. */
  syncGeometry(): ResponsiveOverlayGeometry {
    const geometry = this.geometryOf()
    if (geometry.key !== this.lastGeometryKey) {
      this.lastGeometryKey = geometry.key
      this.onGeometry?.(geometry)
    }
    return geometry
  }

  /**
   * Last-painted-geometry fence (plan §16.7): a terminal resize changes the
   * overlay's clamped geometry and centering, but until the next frame the
   * frame's child offset/width and the child's hit map still describe the
   * PREVIOUS screen. A pointer event in that window must be rejected rather
   * than resolved against stale geometry.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    if (this.geometryOf().key !== this.lastPaintGeometryKey) return undefined
    return super.handleMouse(event)
  }

  render(width: number): string[] {
    const geometry = this.syncGeometry()
    const availableWidth = Math.max(1, Math.floor(width))
    const frameWidth = Math.max(1, Math.min(availableWidth, Math.floor(geometry.width)))
    const lines = super.render(frameWidth)
    // Only a COMPLETED composition counts as a paint: if the child render
    // throws, the offsets/hit map are still the previous frame's, so the key
    // must stay old and keep the fence closed.
    this.lastPaintGeometryKey = geometry.key
    if (frameWidth === availableWidth) return lines
    const left = Math.max(0, Math.floor((availableWidth - frameWidth) / 2))
    // The centered frame shifts the child content box right by `left`
    // (Frame.handleMouse hit-testing reads this offset).
    this.childOffsetX = left + 2
    return lines.map(line => `${' '.repeat(left)}${line}${' '.repeat(Math.max(0, availableWidth - left - visibleWidth(line)))}`)
  }
}
