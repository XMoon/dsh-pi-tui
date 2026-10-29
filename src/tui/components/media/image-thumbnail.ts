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
 *
 * KITTY JPEG/WEBP PREVIEW (Image-6A): Kitty only places PNG, so a readable
 * JPEG/WebP source is projected through the loader's bounded asynchronous PNG
 * derivative. The INFO BAR still reports the ORIGINAL ref (name, original
 * dimensions, original byte count) and `viewerSource` still returns the
 * ORIGINAL attachment; only the painted body consumes the derived PNG and its
 * derived dimensions. Idle/loading/error preview states paint informational
 * rows only — never a fake pixel body — and a collapsed occurrence never
 * starts a conversion. PNG, iTerm2 and GIF keep their existing paths.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/image-thumbnail
 */

import { Image, imageFallback, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import type { ImageGraphics, PixelBody } from '../../graphics/native-image.ts'
import { effectiveImageProtocol } from '../../graphics/image-capability.ts'
import { formatBytes } from '../../../domain/media/format.ts'
import { imagePixelsSupported, type ImageAttachmentRefLike } from '../../../domain/media/types.ts'
import type { ImageLoader } from '../../../client/media/image/loader.ts'
import { MAX_KITTY_THUMBNAIL_SOURCE_BYTES } from '../../../client/media/image/kitty-thumbnail.ts'
import { color } from '../../theme/runtime.ts'

/**
 * The COLUMNS an inline-image sequence actually occupies, read from the
 * sequence the fork just rendered.
 *
 * This is the only way to know the real footprint without re-deriving the
 * fork's fit math (aspect ratio, cell metrics, the height cap) or changing the
 * vendored fork: both encodings state their placement width explicitly. A
 * ceiling (`maxWidthCells`) is NOT the footprint — a square image granted 40
 * columns paints far fewer.
 *
 * `undefined` means the sequence did not carry a width, which for a real pixel
 * render should not happen; the caller then registers NO body so a missing
 * width can never widen a hit beyond the image.
 */
function paintedImageColumns(body: readonly string[], protocol: 'kitty' | 'iterm2'): number | undefined {
  // A pixel render STARTS with its placement sequence: the fork returns
  // `[sequence, ...blankRows]` for Kitty and allocates blank rows ABOVE the
  // sequence for iTerm2. The anchor is required — matching a sequence ANYWHERE
  // in the row would accept the fork's text fallback, whose `[Image: <name> …]`
  // body carries the attachment NAME, and an untrusted name containing a
  // crafted APC/OSC would then declare a pixel body over a line of text.
  if (protocol === 'kitty') {
    // Kitty APC: `\x1b_G<key=value,...>;<payload>\x1b\\` — `c=` is the column count.
    const anchored = /^\x1b_G([^;\x1b]*)[;\x1b]/.exec(body[0] ?? '')
    if (anchored === null) return undefined
    const columns = /(?:^|,)c=(\d+)/.exec(anchored[1]!)
    return columns === null ? undefined : Number(columns[1])
  }
  // iTerm2 OSC 1337: `\x1b]1337;File=<key=value;...>:<base64>\x07` — `width=`.
  // It is the LAST returned line (the fork pads blank rows above it), prefixed
  // by a cursor-up so its cursor accounting stays inside the scroll area.
  const anchored = /^(?:\x1b\[\d*A)?\x1b\]1337;File=([^:]*):/.exec(body[body.length - 1] ?? '')
  if (anchored === null) return undefined
  const columns = /(?:^|;)width=(\d+)/.exec(anchored[1]!)
  return columns === null ? undefined : Number(columns[1])
}

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
  /** The ONE managed graphics owner of this physical terminal (Image-7A/7B-A).
   *  When present, Kitty pixels are painted through the managed Core instead of
   *  the legacy fork `Image`; iTerm2 and every other terminal keep that path. */
  private readonly graphics: ImageGraphics | undefined
  /** True when `instance` is a managed component (it owns a Core handle). */
  private instanceManaged = false
  private instance: PixelBody | undefined
  /** Which source/protocol the local `Image` was built for. A terminal
   * capability flip (Kitty ↔ iTerm2) or a raw/derived source switch must
   * rebuild it; reusing an instance across those renders stale cached lines
   * from the WRONG protocol (the fork caches by width, not by capability). */
  private instanceKind: 'raw-kitty' | 'raw-iterm2' | 'preview-kitty' | 'raw-sixel' | 'preview-sixel' | undefined
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
    graphics?: ImageGraphics,
  ) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.ref = ref
    this.loader = loader
    this.theme = theme
    this.requestRender = requestRender
    this.collapsedRef = collapsedRef
    this.scope = scope
    this.fullscreenCollapseControl = fullscreenCollapseControl
    this.graphics = graphics
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

  /** Release the pixel body and, when it is a managed occurrence, its Core
   *  handle: the Core's next write emits the owned hard delete. */
  private releaseInstance(): void {
    this.instance?.dispose?.()
    this.instance = undefined
    this.instanceManaged = false
    this.instanceKind = undefined
  }

  invalidate(): void {
    this.releaseInstance()
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
    // The EFFECTIVE protocol (not the fork's process-wide detection) drives the
    // cache: an admitted tmux virtual handle paints pixels where the fork still
    // reports none, and its revocation must miss every cached APC/PUA frame.
    const protocol = effectiveImageProtocol(this.graphics)
    const control = this.controlWanted() ? 'ctl' : 'noctl'
    const key = `${width}:${protocol ?? 'none'}:${this.collapsed() ? 'collapsed' : 'expanded'}:${control}`
    if (this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines
    const lines = this.renderLines(width)
    this.cachedLines = lines
    this.cachedKey = key
    return lines
  }

  /**
   * One informational row with NO pixel body. It also drops the local
   * `Image`: a collapsed / narrow / capability-lost / not-ready occurrence
   * must not keep a derived-PNG payload alive after the loader's LRU dropped
   * it, and the next pixel render rebuilds from the CURRENT loader state.
   */
  private infoOnly(width: number, text: string): string[] {
    this.releaseInstance()
    return [this.infoRow(width, text)]
  }

  private renderLines(width: number): string[] {
    // Every non-pixel branch below returns an info-only row; clearing here
    // keeps a previous render's body from surviving a state change that reuses
    // the same width (collapse, protocol flip, read failure).
    this.paintedBody = undefined
    // Narrow terminals fall back BEFORE any load (round-2 finding 4).
    if (width < NARROW_WIDTH_THRESHOLD) {
      return this.infoOnly(width, this.infoLine())
    }
    // Inline graphics only when THIS surface may really paint them; an
    // unsupported terminal, a revoked tmux admission and every other fallback
    // keep the text row AND never trigger a pointless read of the full bytes
    // (§17.3, round-2 finding 4).
    const protocol = effectiveImageProtocol(this.graphics)
    if (protocol === null) {
      return this.infoOnly(width, this.infoLine())
    }
    // Kitty and Direct SIXEL both place PNG only, so a JPEG/WebP occurrence takes
    // the SAME existing derived-PNG path (`getKittyThumbnail`/`loadKittyThumbnail`,
    // EXIF-corrected). No second decode chain exists. (Image-8 / I8-2A.)
    const previewCandidate = (protocol === 'kitty' || protocol === 'sixel')
      && (this.ref.mediaType === 'image/jpeg' || this.ref.mediaType === 'image/webp')
    // Cheap source-byte preflight BEFORE the attachment read (Image-6A §5.3):
    // an over-budget JPEG/WebP can never produce a preview, so no full read is
    // spent on it. The loader re-checks the REAL byte length before decoding.
    if (previewCandidate && this.ref.bytes > MAX_KITTY_THUMBNAIL_SOURCE_BYTES) {
      return this.infoOnly(width, `${this.infoLine()} · Preview unavailable`)
    }
    // A COLLAPSED occurrence paints its constant info row and nothing else, so
    // it must not start (or keep) any attachment read: the fold is decided
    // BEFORE `loader.get`/`load`, exactly like the narrow and unadmitted
    // branches above. Deciding it after the read let a freshly mounted fold
    // spend a full durable read it could never display.
    if (this.collapsed()) {
      return this.infoOnly(width, this.infoLine())
    }
    const state = this.loader.get(this.ref, this.scope)
    if (state.state === 'idle') {
      // Fire the read; the settle notification invalidates this component.
      this.loader.load(this.ref, this.scope)
      return this.infoOnly(width, this.infoLine())
    }
    if (state.state === 'loading') {
      return this.infoOnly(width, `${this.infoLine()} …`)
    }
    if (state.state === 'error') {
      return this.infoOnly(width, `${this.infoLine()} — ${state.error.message}`)
    }
    // Ready: the info line stays constant — only the image rows collapse
    // (the fullscreen click toggle, decided before the read above).
    if (previewCandidate) return this.renderDerivedPreview(width)
    // A raster the protocol cannot display keeps its informational text row and
    // must never reach the Core: the managed component transmits the payload as
    // `f=100` (PNG), so handing it a GIF would paint a broken image instead of
    // the fallback the legacy `Image` produced.
    if (!imagePixelsSupported(protocol, this.ref.mediaType)) {
      // Exactly the row the legacy fork `Image` painted for an undecodable
      // raster: the constant identity line plus its styled text fallback.
      this.releaseInstance()
      this.paintedBody = undefined
      // The legacy path painted `truncateToWidth(fallbackColor(fallback), width)`
      // — style first, then clamp — and that width contract carries over
      // unchanged: a long attachment name must never exceed the granted columns.
      const fallback = this.theme.fallbackColor(imageFallback(
        this.ref.mediaType,
        { widthPx: this.ref.width, heightPx: this.ref.height },
        this.label(),
      ))
      return [this.infoRow(width, this.infoLine()), truncateToWidth(fallback, width)]
    }
    const instanceKind = protocol === 'kitty' ? 'raw-kitty' : protocol === 'sixel' ? 'raw-sixel' : 'raw-iterm2'
    const managed = this.graphics !== undefined
    if (this.instance === undefined || this.instanceKind !== instanceKind || this.instanceManaged !== managed) {
      this.releaseInstance()
      this.instance = managed
        ? this.graphics!.image(
          { pngBase64: state.base64, widthPx: this.ref.width, heightPx: this.ref.height },
          {
            maxHeightCells: MAX_IMAGE_ROWS,
            maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
            fallback: this.theme.fallbackColor(imageFallback(
              this.ref.mediaType,
              { widthPx: this.ref.width, heightPx: this.ref.height },
              this.label(),
            )),
          },
        )
        : new Image(
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
      this.instanceManaged = managed
      this.instanceKind = instanceKind
    }
    const body = this.instance.render(width)
    // Whether those rows are REAL PIXELS is a property of the surface: a raster
    // format this protocol cannot display renders a text fallback, which keeps
    // its informational row but must not become a clickable body.
    const managedBody = imagePixelsSupported(protocol, this.ref.mediaType)
      ? this.instance.paintedBodyAt?.(width)
      : undefined
    if (managedBody !== undefined) {
      // The managed component reports the exact placement it just built; the
      // same answer covers the budget fallback (no pixels, no hit).
      this.paintedBody = { width, rows: managedBody.rows, endCol: managedBody.columns }
    } else if (protocol === 'sixel') {
      // A SIXEL raster carries no cell-width control to parse and the encoder
      // reports its footprint through `paintedBodyAt` only. Without that answer
      // this render painted no pixels (pending, transparent, budget fallback),
      // so it must register NO body at all.
      this.paintedBody = undefined
    } else if (imagePixelsSupported(protocol, this.ref.mediaType)) {
      // The hit must cover exactly the cells the image OCCUPIES, which is the
      // protocol's own placement width — NOT the `maxWidthCells` ceiling this
      // component asked for. The fork shrinks a square or portrait image well
      // inside that ceiling (a 100x100 ref paints 24 columns of the 40 granted),
      // so a ceiling-based hit would open the Viewer over empty cells.
      const columns = paintedImageColumns(body, protocol)
      this.paintedBody = columns === undefined
        ? undefined
        : { width, rows: body.length, endCol: columns }
    } else {
      this.paintedBody = undefined
    }
    return [this.infoRow(width, this.infoLine()), ...body]
  }

  /**
   * The derived PNG body for a JPEG/WebP occurrence (Image-6A, extended to
   * Direct SIXEL by I8-2A): the loader's derived PNG is the only pixel source. The derived dimensions drive placement; the info row and the
   * viewer target stay the ORIGINAL ref. Idle/loading/error preview states are
   * informational only and register no pixel body, so a not-ready occurrence
   * can never open the Viewer from a text row.
   */
  private renderDerivedPreview(width: number): string[] {
    const preview = this.loader.getKittyThumbnail(this.ref, this.scope)
    if (preview.state === 'idle') {
      this.loader.loadKittyThumbnail(this.ref, this.scope)
      return this.infoOnly(width, `${this.infoLine()} …`)
    }
    if (preview.state === 'loading') {
      return this.infoOnly(width, `${this.infoLine()} …`)
    }
    if (preview.state === 'error') {
      // Bounded, sanitized reason only: the captured native Error stays inside
      // the loader and never reaches the terminal.
      const reason = preview.reason === 'busy' ? 'Preview unavailable (busy)' : 'Preview unavailable'
      return this.infoOnly(width, `${this.infoLine()} · ${reason}`)
    }
    const managed = this.graphics !== undefined
    const previewKind = effectiveImageProtocol(this.graphics) === 'sixel' ? 'preview-sixel' : 'preview-kitty'
    if (this.instance === undefined || this.instanceKind !== previewKind || this.instanceManaged !== managed) {
      this.releaseInstance()
      this.instance = managed
        ? this.graphics!.image(
          { pngBase64: preview.base64, widthPx: preview.width, heightPx: preview.height },
          {
            maxHeightCells: MAX_IMAGE_ROWS,
            maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
            fallback: this.theme.fallbackColor(imageFallback(
              'image/png',
              { widthPx: preview.width, heightPx: preview.height },
              this.label(),
            )),
          },
        )
        : new Image(
          preview.base64,
          'image/png',
          { fallbackColor: this.theme.fallbackColor },
          {
            maxHeightCells: MAX_IMAGE_ROWS,
            maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
            filename: this.label(),
          },
          { widthPx: preview.width, heightPx: preview.height },
        )
      this.instanceManaged = managed
      this.instanceKind = previewKind
    }
    const body = this.instance.render(width)
    const managedBody = this.instance.paintedBodyAt?.(width)
    if (managedBody !== undefined) {
      this.paintedBody = { width, rows: managedBody.rows, endCol: managedBody.columns }
    } else if (previewKind === 'preview-sixel') {
      this.paintedBody = undefined
    } else {
      // The derived body is a REAL Kitty placement only when this render emitted
      // an anchored APC; a missing `c=` registers no hit.
      const columns = paintedImageColumns(body, 'kitty')
      this.paintedBody = columns === undefined
        ? undefined
        : { width, rows: body.length, endCol: columns }
    }
    return [this.infoRow(width, this.infoLine()), ...body]
  }
}
