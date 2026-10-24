/**
 * The transcript image thumbnail (plan M9, §17).
 *
 * Renders a durable attachment through the pi-tui `Image` component when
 * the terminal supports inline graphics (Kitty / iTerm2), and falls back to
 * a one-line text summary otherwise (unsupported terminal, tmux, narrow
 * terminal, still-loading, or a failed read — §17.1-§17.3).
 *
 * The INFO BAR (`🖼️ name · W×H · bytes`) is CONSTANT: it renders above the
 * image in every state, so an attachment is always identifiable. The image
 * rows themselves collapse on demand — the fullscreen click toggle passes a
 * live `collapsedRef` (read at render time, so a toggle only repaints; the
 * render cache key carries the bit).
 *
 * FULLSCREEN INFO CONTROL (Image UX PR2): when the host renderer enables it
 * and this occurrence owns a `collapsedRef`, the info bar carries a 3-cell
 * ASCII control at its RIGHT EDGE — `[-]` while expanded, `[+]` while
 * collapsed. Only that right-edge span is operable; the identity text to its
 * left is read-only. `collapseControlRange(width)` reports the span the LAST
 * render at that width actually painted (the host row mapper reads it right
 * after measuring the same render), so a click can only ever hit a control
 * the user actually saw. The control is never painted on the regular surface.
 *
 * The component never awaits: it consults the loader synchronously and
 * asks the loader to fire the async read on first render; the loader's
 * subscriber notification invalidates the component, which repaints with
 * the resolved bytes (plan §16.1 + the fork's dynamic-load contract).
 * @module @xmoon76/dsh-pi-tui/tui/components/media/image-thumbnail
 */

import { Image, getCapabilities, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { formatBytes } from '../../../domain/media/format.ts'
import { imagePixelsSupported, type ImageAttachmentRefLike } from '../../../domain/media/types.ts'
import type { ImageLoader } from '../../../client/media/image/loader.ts'
import { color } from '../../theme/runtime.ts'

/** The thumbnail sizing constants (kimi parity, §17). */
export const MAX_IMAGE_ROWS = 12
export const MAX_IMAGE_WIDTH = 40
/** Widths below this many cells fall back to text (§17.2). */
export const NARROW_WIDTH_THRESHOLD = 42
/** The fullscreen info control's painted width: ASCII `[-]` / `[+]`. */
const COLLAPSE_CONTROL_WIDTH = 3
/** The gap between the identity text and the right-aligned control. */
const CONTROL_GAP = 1

/** The pi-tui `Image` theme surface (fallback coloring). */
export interface ImageThumbnailTheme {
  fallbackColor(text: string): string
}

/** The immutable presentation source one rendered occurrence reads through. */
export interface ImageViewerSource {
  readonly ref: ImageAttachmentRefLike
  readonly scope: unknown
}

/** A component rendering one durable attachment ref as an inline image. */
export class ImageThumbnail implements Component {
  private readonly loader: ImageLoader
  private readonly theme: ImageThumbnailTheme
  private readonly ref: ImageAttachmentRefLike
  private readonly collapsedRef: (() => boolean) | undefined
  private readonly requestRender: () => void
  /**
   * The IMMUTABLE presentation scope this ref belongs to (M3-5 PR2 review, P1):
   * the renderer stamps it from the presentation being constructed, and every
   * `get`/`load`/`subscribe` uses THIS value — never a freshly resolved "current"
   * subject. A stale component of a replaced presentation therefore keeps asking
   * through its OWN (possibly released) authorization and fails closed, instead of
   * sending its ref to whoever is displayed by then.
   */
  private readonly scope: unknown
  /**
   * Whether the HOST surface currently wants the fullscreen collapse control
   * painted on the info row (Image UX PR2): true only on the fullscreen
   * surface. Absent in regular mode / loader-less constructions (where the
   * component is not used at all). The control additionally requires a
   * `collapsedRef` — only Host-wired occurrences participate in the fold.
   */
  private readonly fullscreenCollapseControl: (() => boolean) | undefined
  private unsubscribe: (() => void) | undefined
  private instance: Image | undefined
  private cachedLines: string[] | undefined
  private cachedKey: string | undefined
  /** The control span the LAST painted info row actually carried, keyed by
   * the render width it was painted at. */
  private paintedControl: { width: number; startCol: number; endCol: number } | undefined
  /** The REAL PIXEL body the LAST render at each width painted, or undefined
   * when this render carried no pixels (loading, error, collapsed, narrow,
   * no graphics protocol, or a raster format the protocol cannot display —
   * whose text fallback is NOT a pixel body). The host row mapper reads this
   * right after measuring the same render, so a click can only target pixels
   * the user actually saw. */
  private paintedBody: {
    width: number
    rows: number
    /** The widest cell this painted body can occupy (the component's own
     * painted-width ceiling). A body hit never claims cells beyond it. */
    endCol: number
  } | undefined

  constructor(
    ref: ImageAttachmentRefLike,
    loader: ImageLoader,
    theme: ImageThumbnailTheme,
    requestRender: () => void,
    collapsedRef?: () => boolean,
    scope?: unknown,
    fullscreenCollapseControl?: () => boolean,
  ) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.ref = ref
    this.loader = loader
    this.theme = theme
    this.requestRender = requestRender
    this.collapsedRef = collapsedRef
    this.scope = scope
    this.fullscreenCollapseControl = fullscreenCollapseControl
    // Subscribe to THIS (scope, attachment)'s settles only: N thumbnails loading
    // in parallel never invalidate each other, and another presentation's settle
    // for the same content id never wakes this component (review finding 8 — no
    // O(N²) repaint churn, no kitty image-id churn). A settle clears the render
    // cache AND schedules the next frame: an async load that resolves
    // between frames must repaint with the resolved bytes (the loader
    // itself never schedules a frame).
    this.unsubscribe = loader.subscribe(ref.attachmentId, () => {
      this.invalidate()
      this.requestRender()
    }, scope)
  }

  /** Whether this thumbnail participates in the fullscreen collapse
   * toggle: only instances the host wired a `collapsedRef` for. Tool-card
   * images participate too (Image UX PR2) — their own info control folds
   * just the image body, while the card header keeps the card disclosure. */
  get collapsible(): boolean {
    return this.collapsedRef !== undefined
  }

  /** The immutable read source captured at construction (Image UX PR2): the
   * exact durable ref and presentation scope this occurrence renders through.
   * Never re-samples the scope and never exposes the loader or bytes. */
  get viewerSource(): ImageViewerSource {
    return { ref: this.ref, scope: this.scope }
  }

  /** Whether the image rows are collapsed (the info line stays constant). */
  private collapsed(): boolean {
    return this.collapsedRef?.() === true
  }

  /** Fallback display name (never a path). */
  private label(): string {
    return this.ref.name ?? 'image'
  }

  /** Release the loader subscription (transcript trim / cache eviction).
   * Idempotent; a disposed thumbnail stops repainting with loader settles
   * (round-1 finding 7). */
  dispose(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
    this.invalidate()
  }

  /** The constant info line (§17.1): the attachment's identity — name +
   * dimensions + size — visible in EVERY state. The marker is `🖼️` WITH
   * the U+FE0F variation selector: U+1F5BC alone has no default emoji
   * presentation, so the width math measures it as ONE cell while fonts
   * with an emoji face render it TWO cells wide — the glyph overhang then
   * eats the space and overlaps the name (font-dependent). VS16 forces the
   * wide 2-cell rendering the measurement expects. */
  private infoLine(): string {
    return `🖼️ ${this.label()} · ${this.ref.width}×${this.ref.height} · ${formatBytes(this.ref.bytes)}`
  }

  /** Whether the fullscreen info control applies to THIS occurrence. */
  private controlWanted(): boolean {
    return this.collapsedRef !== undefined && this.fullscreenCollapseControl?.() === true
  }

  /**
   * Compose one info row for the given width. When the fullscreen control
   * applies, the 3-cell `[-]`/`[+]` is right-aligned at `width - 3` and the
   * identity text is truncated to leave one gap cell, so the action can never
   * be pushed off the terminal. Records the painted span (read back through
   * {@link collapseControlRange}) only for the row actually returned.
   */
  private infoRow(width: number, text: string): string {
    const wanted = this.controlWanted()
      && width >= COLLAPSE_CONTROL_WIDTH + CONTROL_GAP + 1
    if (!wanted) {
      this.paintedControl = undefined
      return this.theme.fallbackColor(text)
    }
    const startCol = width - COLLAPSE_CONTROL_WIDTH
    const endCol = width
    const control = this.collapsed() ? '[+]' : '[-]'
    const left = truncateToWidth(text, startCol - CONTROL_GAP, '…')
    const pad = ' '.repeat(Math.max(1, width - COLLAPSE_CONTROL_WIDTH - visibleWidth(left)))
    this.paintedControl = { width, startCol, endCol }
    return this.theme.fallbackColor(left) + pad + color.primary(control)
  }

  /**
   * The column span of the fullscreen info control the LAST render at `width`
   * actually painted (the host row mapper reads this right after measuring the
   * same render). `undefined` when no control was painted — regular mode, a
   * non-collapsible occurrence, or no render at that width. Loading / error /
   * narrow states still paint the control (the fold only affects body rows);
   * their lack of a body is reported by the hit map instead.
   */
  collapseControlRange(width: number): { startCol: number; endCol: number } | undefined {
    const painted = this.paintedControl
    if (painted === undefined || painted.width !== width) return undefined
    return { startCol: painted.startCol, endCol: painted.endCol }
  }

  /**
   * The REAL PIXEL body rows the LAST render at `width` painted, or undefined
   * when that render carried no pixels at all.
   *
   * This is the authoritative answer to "may a click on these rows open the
   * Viewer?" — deliberately NOT "the component is taller than one row". A
   * raster format the current protocol cannot display still paints the fork's
   * `imageFallback` TEXT row, and that row is information, not an image body;
   * treating it as pixels would open a Viewer from a line of plain text.
   */
  paintedImageBody(width: number): { rows: number; endCol: number } | undefined {
    const painted = this.paintedBody
    if (painted === undefined || painted.width !== width) return undefined
    return { rows: painted.rows, endCol: painted.endCol }
  }

  invalidate(): void {
    this.instance = undefined
    this.cachedLines = undefined
    this.cachedKey = undefined
    this.paintedControl = undefined
    this.paintedBody = undefined
  }

  render(width: number): string[] {
    // Width + capability-stable cache: the fork's per-frame processed-line
    // reuse keeps hitting when the same lines come back, while a terminal
    // capability flip (kitty → unsupported) invalidates the cache so a
    // stale inline sequence never survives (round-3 finding 2). The
    // collapse bit and the fullscreen-control bit ride the key too: a
    // fullscreen click only repaints — no rebuild, no invalidate — and the
    // flipped bit misses the cache.
    const capabilities = getCapabilities().images ?? 'none'
    const control = this.controlWanted() ? 'ctl' : 'noctl'
    const key = `${width}:${capabilities}:${this.collapsed() ? 'collapsed' : 'expanded'}:${control}`
    if (this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines
    const lines = this.renderLines(width)
    this.cachedLines = lines
    this.cachedKey = key
    return lines
  }

  private renderLines(width: number): string[] {
    // Every non-pixel branch below returns an info-only row; clearing here
    // keeps a previous render's body from surviving a state change that reuses
    // the same width (collapse, protocol flip, read failure).
    this.paintedBody = undefined
    // Narrow terminals fall back BEFORE any load (round-2 finding 4).
    if (width < NARROW_WIDTH_THRESHOLD) {
      return [this.infoRow(width, this.infoLine())]
    }
    // Inline graphics only when the terminal reports them; tmux and other
    // unsupported terminals keep the text fallback AND never trigger a
    // pointless read of the full bytes (§17.3, round-2 finding 4).
    if (getCapabilities().images === null) {
      return [this.infoRow(width, this.infoLine())]
    }
    const state = this.loader.get(this.ref, this.scope)
    if (state.state === 'idle') {
      // Fire the read; the settle notification invalidates this component.
      this.loader.load(this.ref, this.scope)
      return [this.infoRow(width, this.infoLine())]
    }
    if (state.state === 'loading') {
      return [this.infoRow(width, `${this.infoLine()} …`)]
    }
    if (state.state === 'error') {
      return [this.infoRow(width, `${this.infoLine()} — ${state.error.message}`)]
    }
    // Ready: the info line stays constant — only the image rows collapse
    // (the fullscreen click toggle). A collapsed image needs no placement;
    // the fork's differential renderer deletes the vanished kitty tile of
    // the previous frame automatically.
    if (this.collapsed()) {
      return [this.infoRow(width, this.infoLine())]
    }
    if (this.instance === undefined) {
      this.instance = new Image(
        state.base64,
        this.ref.mediaType,
        { fallbackColor: this.theme.fallbackColor },
        {
          maxHeightCells: MAX_IMAGE_ROWS,
          maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
          filename: this.label(),
        },
        { widthPx: this.ref.width, heightPx: this.ref.height },
      )
    }
    const body = this.instance.render(width)
    // Whether those rows are REAL PIXELS is a property of the surface: a raster
    // format this protocol cannot display renders the fork's text fallback,
    // which keeps its informational row but must not become a clickable body.
    this.paintedBody = imagePixelsSupported(getCapabilities().images ?? null, this.ref.mediaType)
      ? {
          width,
          rows: body.length,
          // The thumbnail never paints wider than this ceiling (the same value
          // it hands the fork as `maxWidthCells`), so a body hit can never
          // claim cells the image does not occupy.
          endCol: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
        }
      : undefined
    return [this.infoRow(width, this.infoLine()), ...body]
  }
}
