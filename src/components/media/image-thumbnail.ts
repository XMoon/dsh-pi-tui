/**
 * The transcript image thumbnail (plan M9, §17).
 *
 * Renders a durable attachment through the pi-tui `Image` component when
 * the terminal supports inline graphics (Kitty / iTerm2), and falls back to
 * a one-line text summary otherwise (unsupported terminal, tmux, narrow
 * terminal, still-loading, or a failed read — §17.1-§17.3).
 *
 * The component never awaits: it consults the loader synchronously and
 * asks the loader to fire the async read on first render; the loader's
 * subscriber notification invalidates the component, which repaints with
 * the resolved bytes (plan §16.1 + the fork's dynamic-load contract).
 * @module @xmoon76/dsh-pi-tui/components/media/image-thumbnail
 */

import { Image, getCapabilities } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { formatBytes } from '../../image/errors.ts'
import type { ImageLoader } from '../../image/loader.ts'
import type { ImageAttachmentRefLike } from '../../image/admission.ts'

/** The thumbnail sizing constants (kimi parity, §17). */
export const MAX_IMAGE_ROWS = 12
export const MAX_IMAGE_WIDTH = 40
/** Widths below this many cells fall back to text (§17.2). */
export const NARROW_WIDTH_THRESHOLD = 42

/** The pi-tui `Image` theme surface (fallback coloring). */
export interface ImageThumbnailTheme {
  fallbackColor(text: string): string
}

/** A component rendering one durable attachment ref as an inline image. */
export class ImageThumbnail implements Component {
  private readonly loader: ImageLoader
  private readonly theme: ImageThumbnailTheme
  private readonly ref: ImageAttachmentRefLike
  private unsubscribe: (() => void) | undefined
  private instance: Image | undefined
  private cachedLines: string[] | undefined
  private cachedKey: string | undefined

  constructor(ref: ImageAttachmentRefLike, loader: ImageLoader, theme: ImageThumbnailTheme) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.ref = ref
    this.loader = loader
    this.theme = theme
    // Subscribe to THIS attachment's settles only: N thumbnails loading in
    // parallel never invalidate each other (review finding 8 — no O(N²)
    // repaint churn, no kitty image-id churn).
    this.unsubscribe = loader.subscribe(ref.attachmentId, () => this.invalidate())
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

  /** The one-line text fallback (plan §17.1). */
  private fallbackText(): string {
    return `🖼 ${this.label()} · ${this.ref.width}×${this.ref.height} · ${formatBytes(this.ref.bytes)}`
  }

  invalidate(): void {
    this.instance = undefined
    this.cachedLines = undefined
    this.cachedKey = undefined
  }

  render(width: number): string[] {
    // Width + capability-stable cache: the fork's per-frame processed-line
    // reuse keeps hitting when the same lines come back, while a terminal
    // capability flip (kitty → unsupported) invalidates the cache so a
    // stale inline sequence never survives (round-3 finding 2).
    const capabilities = getCapabilities().images ?? 'none'
    const key = `${width}:${capabilities}`
    if (this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines
    const lines = this.renderLines(width)
    this.cachedLines = lines
    this.cachedKey = key
    return lines
  }

  private renderLines(width: number): string[] {
    // Narrow terminals fall back BEFORE any load (round-2 finding 4).
    if (width < NARROW_WIDTH_THRESHOLD) {
      return [this.theme.fallbackColor(this.fallbackText())]
    }
    // Inline graphics only when the terminal reports them; tmux and other
    // unsupported terminals keep the text fallback AND never trigger a
    // pointless read of the full bytes (§17.3, round-2 finding 4).
    if (getCapabilities().images === null) {
      return [this.theme.fallbackColor(this.fallbackText())]
    }
    const state = this.loader.get(this.ref)
    if (state.state === 'idle') {
      // Fire the read; the settle notification invalidates this component.
      this.loader.load(this.ref)
      return [this.theme.fallbackColor(this.fallbackText())]
    }
    if (state.state === 'loading') {
      return [this.theme.fallbackColor(`${this.fallbackText()} …`)]
    }
    if (state.state === 'error') {
      return [this.theme.fallbackColor(`${this.fallbackText()} — ${state.error.message}`)]
    }
    // Ready: inline render.
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
    return this.instance.render(width)
  }
}
