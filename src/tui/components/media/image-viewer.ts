/**
 * The read-only large-image viewer panel for one transcript attachment.
 *
 * The overlay owner (`tui-app.ts`) mounts this behind a
 * `ResponsiveOverlayFrame` and grants it the CONTENT row budget each time the
 * terminal geometry changes; `render(width)` therefore receives the frame's
 * INNER width and must never paint more rows than the current grant.
 *
 * Layout priority is frozen: the `Esc close` chrome is mandatory and must
 * never be lost while it fits, the identity title is row 1, the metadata and
 * `Esc close` share the bottom row, and the image/status body absorbs the
 * remainder (`maxRows - 2`, possibly zero).
 *
 * The panel never awaits: it consults the shared {@link ImageLoader}
 * synchronously, asks it to start the async read on the first render, and the
 * loader's settle notification invalidates the local paint and requests one
 * frame. The loader's cache stays owned by the loader — `dispose()` only
 * releases this panel's subscription and its local `Image` instance.
 *
 * KITTY JPEG/WEBP (Image-6B): a Kitty surface cannot place JPEG/WebP bytes
 * directly, so this panel paints the SAME scoped 6A derived PNG the transcript
 * thumbnail already uses — one loader, one derivative, no second decoder or
 * cache. A READY derivative is used immediately even when the raw read has
 * been evicted; otherwise the panel requests the raw read first and then the
 * derivative. The identity title, metadata and every close route keep the
 * ORIGINAL attachment ref and its original dimensions/bytes.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/image-viewer
 */

import { Image, getCapabilities, matchesKey, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { formatBytes } from '../../../domain/media/format.ts'
import { imagePixelsSupported, type ImageAttachmentRefLike } from '../../../domain/media/types.ts'
import { MAX_KITTY_THUMBNAIL_SOURCE_BYTES } from '../../../client/media/image/kitty-thumbnail.ts'
import type { ImageLoader } from '../../../client/media/image/loader.ts'
import { sanitizedPhysicalLine } from '../../presentation/lines.ts'
import { color } from '../../theme/runtime.ts'

/** A safe finite row budget before the owning frame grants the real one. */
const DEFAULT_MAX_ROWS = 22
/** The mandatory close hint; right-aligned on the bottom row. `back` is used
 * when the Viewer is stacked over the `/view-image` list (Esc returns there),
 * `close` when it was opened directly from the transcript (Esc leaves). */
type ImageViewerCloseHint = 'back' | 'close'

/** One resolved pixel payload the body can place: a raw read (PNG only) or
 * the loader's scoped JPEG/WebP derivative. Both arrive as PNG base64; the
 * KIND keeps the local `Image` from being reused across a source switch. */
interface ResolvedPixelSource {
  readonly base64: string
  readonly kind: 'raw' | 'derived'
  readonly widthPx: number
  readonly heightPx: number
}

/** Everything the panel needs from its overlay owner. */
export interface ImageViewerInput {
  readonly ref: ImageAttachmentRefLike
  readonly scope: unknown
  readonly loader?: ImageLoader
  readonly theme: { fallbackColor(text: string): string }
  readonly requestRender: () => void
  readonly onClose: () => void
  /** What Esc actually does on this surface (design-language D13): `back`
   * returns to the image list, `close` leaves the Viewer. Default `close`. */
  readonly closeHint?: ImageViewerCloseHint
}

/** One read-only rendered attachment, sized to the frame's content grant. */
export class ImageViewerPanel implements Component {
  private readonly ref: ImageAttachmentRefLike
  /** The IMMUTABLE presentation scope: every get/load/subscribe uses THIS
   * value, never a freshly resolved subject. */
  private readonly scope: unknown
  private readonly loader: ImageLoader | undefined
  private readonly theme: { fallbackColor(text: string): string }
  private readonly requestRender: () => void
  private readonly onClose: () => void
  /** `Esc back` / `Esc close` — names the REAL effect of Esc (D13). */
  private readonly closeHint: string
  private unsubscribe: (() => void) | undefined
  /** The granted CONTENT row budget (overlay maxHeight minus border rows). */
  private maxRows = DEFAULT_MAX_ROWS
  /** The local placement instance; never a cache of loaded bytes. */
  private instance: Image | undefined
  /** The exact inputs the local instance was built for. */
  private instanceAttachmentId: string | undefined
  private instanceProtocol: 'kitty' | 'iterm2' | undefined
  private instanceKind: 'raw' | 'derived' | undefined
  private instanceWidth: number | undefined
  private instanceBodyRows: number | undefined
  private instanceBase64: string | undefined
  private instanceWidthPx: number | undefined
  private instanceHeightPx: number | undefined

  constructor(input: ImageViewerInput) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.ref = input.ref
    this.scope = input.scope
    this.loader = input.loader
    this.theme = input.theme
    this.requestRender = input.requestRender
    this.onClose = input.onClose
    this.closeHint = input.closeHint === 'back' ? 'Esc back' : 'Esc close'
    // Subscribe ONCE to THIS (scope, attachment)'s settles only: another
    // presentation's settle for the same content id must not wake this panel.
    // The callback only invalidates the local paint and schedules one frame.
    if (this.loader !== undefined) {
      this.unsubscribe = this.loader.subscribe(input.ref.attachmentId, () => {
        this.invalidate()
        this.requestRender()
      }, this.scope)
    }
  }

  /** Adopt the granted CONTENT row budget (overlay maxHeight minus frame borders). */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
  }

  /** Esc closes; every other key is consumed locally and never forwarded. */
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.onClose()
  }

  /** Drop the local placement so the next paint rebuilds from current state. */
  invalidate(): void {
    this.instance = undefined
    this.instanceAttachmentId = undefined
    this.instanceProtocol = undefined
    this.instanceKind = undefined
    this.instanceWidth = undefined
    this.instanceBodyRows = undefined
    this.instanceBase64 = undefined
    this.instanceWidthPx = undefined
    this.instanceHeightPx = undefined
  }

  /** Idempotent teardown: release the ONE subscription and the local image
   * instance. The loader cache is deliberately untouched. */
  dispose(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
    this.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width))
    const titleText = this.titleText()
    if (this.maxRows === 1) {
      // Short-window priority: one row keeps the identity title on the left
      // and the mandatory close hint right-aligned; metadata is dropped.
      return [this.withCloseHint(titleText, safeWidth)]
    }
    const title = truncateToWidth(titleText, safeWidth, '…')
    const bottom = this.withCloseHint(this.metadataText(), safeWidth)
    if (this.maxRows === 2) return [title, bottom]
    const bodyRows = this.maxRows - 2
    // The pane FILLS its grant: title on row 1, the metadata + `Esc close` bar
    // pinned to the LAST granted row, and the body absorbing every row between
    // (blank rows are the image's surrounding space, never trailing dead space
    // that would leave the bar floating under a short image).
    const body = this.bodyLines(safeWidth, bodyRows)
    const padded = body.length >= bodyRows
      ? body.slice(0, bodyRows)
      : [...body, ...Array.from({ length: bodyRows - body.length }, () => '')]
    return [title, ...padded, bottom]
  }

  /** `Image · <name>` (the attachment's presentation name, never a path). */
  private titleText(): string {
    return sanitizedPhysicalLine(`Image · ${this.ref.name ?? 'image'}`)
  }

  /** Attachment facts: pixel dimensions, media type and byte size. */
  private metadataText(): string {
    return `${this.ref.width}×${this.ref.height} · ${this.ref.mediaType} · ${formatBytes(this.ref.bytes)}`
  }

  /**
   * Compose the bottom/short row: the left fact text is truncated first, so
   * the right-aligned `Esc close` always survives while the row can hold it.
   * A row narrower than the literal hint paints only the widest prefix that
   * fits instead of overflowing.
   */
  private withCloseHint(left: string, width: number): string {
    const hint = this.closeHint
    if (width < hint.length) {
      // A row narrower than the literal hint paints its widest ASCII prefix.
      return hint.slice(0, width)
    }
    const leftRoom = width - hint.length
    const fitted = truncateToWidth(left, leftRoom, '…')
    const pad = Math.max(0, width - visibleWidth(fitted) - hint.length)
    return `${fitted}${' '.repeat(pad)}${hint}`
  }

  /** The body area: exactly one status row, or the clipped image rows. */
  private bodyLines(width: number, bodyRows: number): string[] {
    if (bodyRows <= 0) return []
    if (this.loader === undefined) return [this.status(width, 'Preview unavailable')]
    const protocol = getCapabilities().images
    if (protocol === null || protocol === undefined) {
      // No inline graphics: never start a pointless full-bytes read.
      return [this.status(width, 'Preview unavailable')]
    }
    if (protocol !== 'kitty') {
      // Image UX PR2 Owner decision: the leased workspace shows real pixels
      // through the Kitty protocol only. The pinned AltScreen deliberately
      // disables the iTerm2 capability (its inline framing uses CSI `A`,
      // which the fork's ANSI width layer does not parse); native iTerm2
      // pixels are deferred to separate fork/protocol work. Metadata stays
      // visible and the state is truthful.
      return [this.status(width, 'Preview unavailable')]
    }
    if (this.ref.mediaType === 'image/jpeg' || this.ref.mediaType === 'image/webp') {
      // Image-6B: Kitty places PNG payloads only, so JPEG/WebP reuse the SAME
      // scoped 6A derivative the transcript thumbnail already derives. Never a
      // second decoder, cache or re-read of the original bytes.
      return this.derivedBodyLines(width, bodyRows)
    }
    if (!imagePixelsSupported(protocol, this.ref.mediaType)) {
      // The shared protocol/MIME admission still rejects every other raster
      // (GIF): Kitty accepts PNG only and this repo installs no transcoder, so
      // any other format would build an Image that silently degrades to a text
      // fallback. JPEG/WebP never reach this check (they take the 6A branch).
      return [this.status(width, 'Preview unavailable')]
    }
    const state = this.loader.get(this.ref, this.scope)
    if (state.state === 'idle') {
      // Fire the async read; its settle notification repaints this panel.
      this.loader.load(this.ref, this.scope)
      return [this.status(width, 'Loading…')]
    }
    if (state.state === 'loading') return [this.status(width, 'Loading…')]
    if (state.state === 'error') {
      // Read failures are single physical rows: the projection folds any
      // embedded CR/LF/TAB (and drops terminal control bytes) before the
      // width clamp.
      return [this.status(width, `Read failed: ${sanitizedPhysicalLine(state.error.message)}`)]
    }
    if (state.bytes.byteLength === 0) return [this.status(width, 'Preview unavailable')]
    return this.imageLines(width, bodyRows, {
      base64: state.base64,
      kind: 'raw',
      widthPx: this.ref.width,
      heightPx: this.ref.height,
    })
  }

  /**
   * The Kitty JPEG/WebP body (Image-6B): consume the loader's derived-PNG state
   * for THIS immutable (scope, attachment) and never start a second path.
   *
   * A READY derivative is painted immediately — even when the raw read has
   * already been evicted from the cache. Only an idle derivative asks for the
   * raw read first; the derivative itself never re-downloads. The source-byte
   * preflight runs BEFORE any read so an over-budget JPEG/WebP can never spend
   * a full-bytes read it cannot convert.
   *
   * The native conversion error never reaches the terminal: every failure is
   * the one bounded `Preview unavailable` status row.
   */
  private derivedBodyLines(width: number, bodyRows: number): string[] {
    if (this.loader === undefined) return [this.status(width, 'Preview unavailable')]
    // Same 20 MiB source ceiling as the 6A thumbnail; checked from the durable
    // metadata before the raw read so the Viewer never reads bytes it cannot
    // preview.
    if (this.ref.bytes > MAX_KITTY_THUMBNAIL_SOURCE_BYTES) {
      return [this.status(width, 'Preview unavailable')]
    }
    const preview = this.loader.getKittyThumbnail(this.ref, this.scope)
    if (preview.state === 'ready') {
      return this.imageLines(width, bodyRows, {
        base64: preview.base64,
        kind: 'derived',
        widthPx: preview.width,
        heightPx: preview.height,
      })
    }
    if (preview.state === 'loading') return [this.status(width, 'Loading…')]
    if (preview.state === 'error') return [this.status(width, 'Preview unavailable')]
    const state = this.loader.get(this.ref, this.scope)
    if (state.state === 'idle') {
      this.loader.load(this.ref, this.scope)
      return [this.status(width, 'Loading…')]
    }
    if (state.state === 'loading') return [this.status(width, 'Loading…')]
    if (state.state === 'error') {
      return [this.status(width, `Read failed: ${sanitizedPhysicalLine(state.error.message)}`)]
    }
    if (state.bytes.byteLength === 0 || state.bytes.byteLength > MAX_KITTY_THUMBNAIL_SOURCE_BYTES) {
      return [this.status(width, 'Preview unavailable')]
    }
    // Schedule the ONE conversion for this (scope, attachment); its settle
    // notifies the panel's existing subscription, which repaints with pixels.
    this.loader.loadKittyThumbnail(this.ref, this.scope)
    return [this.status(width, 'Loading…')]
  }

  /** Paint one dim status row, width-clamped before the paint. */
  private status(width: number, text: string): string {
    return color.textDim(truncateToWidth(text, width, '…'))
  }

  /** Render one resolved PNG payload at `width` and clip the rows to the grant. */
  private imageLines(width: number, bodyRows: number, pixel: ResolvedPixelSource): string[] {
    const image = this.imageFor(width, bodyRows, pixel)
    return image.render(width).slice(0, bodyRows)
  }

  /**
   * Reuse the local `Image` only while the exact inputs are unchanged: the
   * attachment, the graphics protocol, the pixel-source KIND (raw PNG vs the
   * scoped 6A derivative), the render width, the body row grant, the current
   * base64 string and the payload's pixel dimensions. Any change rebuilds
   * instead of rendering stale cached lines from the wrong protocol/source.
   */
  private imageFor(width: number, bodyRows: number, pixel: ResolvedPixelSource): Image {
    if (this.instance === undefined
      || this.instanceAttachmentId !== this.ref.attachmentId
      || this.instanceProtocol !== 'kitty'
      || this.instanceKind !== pixel.kind
      || this.instanceWidth !== width
      || this.instanceBodyRows !== bodyRows
      || this.instanceBase64 !== pixel.base64
      || this.instanceWidthPx !== pixel.widthPx
      || this.instanceHeightPx !== pixel.heightPx) {
      this.instance = new Image(
        pixel.base64,
        'image/png',
        { fallbackColor: this.theme.fallbackColor },
        {
          maxWidthCells: Math.max(1, width),
          maxHeightCells: Math.max(1, bodyRows),
          // The fork's text fallback interpolates this name into a painted row
          // (`[Image: <name> [mime] WxH]`) and does NOT strip terminal controls.
          // Project it at this boundary like every other external label, so a
          // hostile name can never reach the terminal through the fallback path.
          filename: sanitizedPhysicalLine(this.ref.name ?? 'image'),
        },
        { widthPx: pixel.widthPx, heightPx: pixel.heightPx },
      )
      this.instanceAttachmentId = this.ref.attachmentId
      this.instanceProtocol = 'kitty'
      this.instanceKind = pixel.kind
      this.instanceWidth = width
      this.instanceBodyRows = bodyRows
      this.instanceBase64 = pixel.base64
      this.instanceWidthPx = pixel.widthPx
      this.instanceHeightPx = pixel.heightPx
    }
    return this.instance
  }
}
