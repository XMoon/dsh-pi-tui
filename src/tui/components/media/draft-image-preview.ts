/**
 * The live composer draft-image preview band (image UX plan PR1, Owner
 * revision 2026-10-23).
 *
 * The band is a bounded projection of the EXPANDED composer draft (paste
 * markers expanded, the same text submission uses), so its occurrence count
 * and identities always agree with what would be sent. It shows ONE real
 * thumbnail: the LAST referenced occurrence in the draft, so a newly pasted
 * image is immediately visible. The identity row carries `#id/total`, the
 * dimensions/bytes, the remaining-occurrence count and (fullscreen only) the
 * width-safe ASCII `x` removal control; the image itself is at most three
 * rows. The whole band never exceeds four rows.
 *
 * The wide card is 44×3 (>=70 columns); split widths use 22×3; under 50
 * columns or a 1–3 row grant the band degrades to a one-line count/identity
 * summary with no pixel card and no removal control.
 *
 * Occurrences that only exist inside an expanded paste marker are shown with
 * their identity but WITHOUT the `x` control: the editor text cannot address
 * them safely. A visible occurrence's removal edits the raw editor text
 * (preserving paste markers and mode); the store keeps the removed draft
 * exactly while the host editor's real undo history can restore it, so undo
 * never restores a dead placeholder.
 *
 * KITTY JPEG/WEBP (Image-6B): Kitty places PNG payloads only, so a local
 * JPEG/WebP card is projected through ONE asynchronous, component-local PNG
 * derivative (the SAME 6A `convertKittyThumbnail` decoder). The derived state
 * belongs to the ONE last-visible card of THIS mounted component: it never
 * enters the durable `ImageLoader`, never reads a recalled durable ref, and
 * holds at most one running conversion. The identity row keeps the ORIGINAL
 * draft id/dimensions/bytes; only the painted card consumes the PNG and its
 * derived dimensions. The staged bytes stay the store's submission authority.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/draft-image-preview
 */

import { Image, getCapabilities, imageFallback, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import type { NativeKittyGraphics, PixelBody } from '../../graphics/native-image.ts'
import { formatBytes } from '../../../domain/media/format.ts'
import { color } from '../../theme/runtime.ts'
import { sanitizedPhysicalLine } from '../../presentation/lines.ts'
import {
  selectDraftImageOccurrences,
  type DraftImageOccurrence,
} from '../../../client/media/image/placeholder.ts'
import {
  convertKittyThumbnail,
  type KittyThumbnailConverter,
  type KittyThumbnailPng,
} from '../../../client/media/image/kitty-thumbnail.ts'
import type { DraftImage, DraftImagePreviewSource } from '../../../client/media/image/types.ts'

/** Pixel-card widths below this fall back to the one-line summary. */
export const DRAFT_PREVIEW_COMPACT_WIDTH = 50
/** The 44-column wide card starts at this width. */
export const DRAFT_PREVIEW_WIDE_WIDTH = 70
/** The composer preview's maximum band height (identity row + image rows). */
export const DRAFT_PREVIEW_MAX_ROWS = 4
/** The card's image cell widths and maximum height (plan §3.1/§3.2). */
export const DRAFT_PREVIEW_CARD_WIDTH = 22
export const DRAFT_PREVIEW_WIDE_CARD_WIDTH = 44
export const DRAFT_PREVIEW_CARD_ROWS = 3
/** The Client-local preview cap; larger images stay metadata-only. */
export const DRAFT_PREVIEW_MAX_PIXEL_BYTES = 4 * 1024 * 1024

/** The width-safe removal affordance (ASCII; design-language §4.3). */
const REMOVE_CONTROL = 'x'

/** The `x` hit span from the last render (0-based preview rows/columns). */
export interface DraftPreviewRemoveHit {
  readonly row: number
  readonly startCol: number
  readonly endCol: number
  readonly imageId: number
  readonly ordinal: number
  readonly startOffset: number
  readonly endOffset: number
  /** The exact expanded draft text the geometry belongs to (fence). */
  readonly draftText: string
}

/** The last-painted preview geometry. */
export interface DraftPreviewHitMap {
  readonly height: number
  readonly removes: readonly DraftPreviewRemoveHit[]
}

export interface DraftImagePreviewOptions {
  /** The CURRENT expanded composer draft (the submission text). */
  getDraftText: () => string
  source: DraftImagePreviewSource
  /** The band's row grant for this frame (0 disables the band). */
  maxRows: (width: number) => number
  /** Whether the current surface draws the fullscreen mouse control. */
  fullscreenMouse: () => boolean
  /**
   * Only schedules a frame for the currently mounted TuiApp. A derived
   * JPEG/WebP card settles asynchronously, so the component must be able to
   * request the repaint that turns its pending/ready state visible.
   */
  requestRender: () => void
  /**
   * Whether the previewed occurrence can be removed from the VISIBLE editor
   * text. Hidden-only paste occurrences return false; absent means all are
   * removable.
   */
  removable?: (occurrence: DraftImageOccurrence) => boolean
  /**
   * The ONE managed graphics owner of this physical terminal (Image-7A). On a
   * native-admitted Kitty terminal the card's pixels come from the Core; every
   * other terminal keeps the legacy fork `Image` path.
   */
  nativeGraphics?: NativeKittyGraphics
}

/** The identity row's admission/derivation state for the current card. */
type DraftPreviewStatus = 'ready' | 'pending' | 'unavailable'

/** The card's pixel path for the current protocol/MIME/source admission. */
type DraftPreviewPixelMode = 'direct' | 'kitty-derived' | 'unavailable'

/** The theme surface the fork `Image` needs for its text fallback. */
export interface DraftImagePreviewTheme {
  fallbackColor(text: string): string
}

/**
 * Render one composer draft-image preview band.
 *
 * The component is stateless with respect to the draft: `render()` re-reads
 * the current expanded text and store projection. The only mutable state is
 * the short-lived `Image`/base64 cache for the one visible card (keyed by
 * draft identity + occurrence + width + protocol), the last-painted hit map,
 * and a per-text occurrence cache.
 */
export class DraftImagePreview implements Component {
  private readonly getDraftText: () => string
  private readonly source: DraftImagePreviewSource
  private readonly maxRows: (width: number) => number
  private readonly fullscreenMouse: () => boolean
  private readonly removable: ((occurrence: DraftImageOccurrence) => boolean) | undefined
  private readonly theme: DraftImagePreviewTheme
  private readonly requestRender: () => void
  /**
   * The decoder seam (the SAME 6A converter in production). Injectable so a
   * deterministic test can hold a conversion pending and prove the
   * single-flight/retirement rules; it is not a second decoding pipeline.
   */
  private readonly convertThumbnail: KittyThumbnailConverter
  /** Per-display-instance cache: id + occurrence + mime + width + protocol. */
  private readonly imageCache = new Map<string, PixelBody>()
  /** The ONE managed graphics owner of this physical terminal, when admitted. */
  private readonly nativeGraphics: NativeKittyGraphics | undefined
  /** Encoded bytes are immutable per draft; keyed by id + byte length. */
  private readonly base64Cache = new Map<string, string>()
  private occurrenceCache: { text: string; occurrences: readonly DraftImageOccurrence[] } | undefined
  private lastHitMap: DraftPreviewHitMap | undefined
  /** Bumped whenever the ONE derived presentation target retires. A late
   * decoder settle can only publish while its captured generation is current. */
  private draftGeneration = 0
  /** The ONE last-visible eligible draft image this component derives for. */
  private draftCandidate: DraftImage | undefined
  /** The ONE ready derivative for the current candidate. */
  private draftReady: { image: DraftImage; png: KittyThumbnailPng } | undefined
  /** The current candidate's terminal conversion failure (no retry UI). */
  private draftFailed: DraftImage | undefined
  /** The ONE running conversion slot; a second target waits for its settle. */
  private activeDraftConversion: {
    image: DraftImage
    generation: number
    pending: Promise<void>
  } | undefined
  private disposed = false

  constructor(
    options: DraftImagePreviewOptions,
    theme: DraftImagePreviewTheme,
    convertThumbnail: KittyThumbnailConverter = convertKittyThumbnail,
  ) {
    this.getDraftText = options.getDraftText
    this.source = options.source
    this.maxRows = options.maxRows
    this.fullscreenMouse = options.fullscreenMouse
    this.removable = options.removable
    this.theme = theme
    this.requestRender = options.requestRender
    this.convertThumbnail = convertThumbnail
    this.nativeGraphics = options.nativeGraphics
  }

  /** The last-painted geometry, or undefined before the first render. */
  hitMap(): DraftPreviewHitMap | undefined {
    return this.lastHitMap
  }

  /** Drop the current derived presentation (READY/failure/candidate). A
   * running native job cannot be cancelled; its settle is discarded. */
  invalidate(): void {
    this.retireDraftPresentation()
    this.clearPixelCaches()
    this.occurrenceCache = undefined
    this.lastHitMap = undefined
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const limit = Math.max(0, Math.floor(this.maxRows(safeWidth)))
    if (limit === 0) {
      this.retireDraftPresentation()
      this.clearPixelCaches()
      this.lastHitMap = undefined
      return []
    }
    const text = this.getDraftText()
    const occurrences = this.occurrencesFor(text)
    if (occurrences.length === 0) {
      this.retireDraftPresentation()
      this.clearPixelCaches()
      this.lastHitMap = undefined
      return []
    }
    if (limit < DRAFT_PREVIEW_MAX_ROWS || safeWidth < DRAFT_PREVIEW_COMPACT_WIDTH) {
      this.retireDraftPresentation()
      return this.renderSummary(safeWidth, occurrences)
    }
    return this.renderCard(safeWidth, occurrences, text, limit)
  }

  /** One-line count/identity summary (narrow or short viewport). No card,
   * no pixel escape and no removal control. */
  private renderSummary(
    width: number,
    occurrences: readonly DraftImageOccurrence[],
  ): string[] {
    this.clearPixelCaches()
    const last = occurrences[occurrences.length - 1]!
    const count = occurrences.length
    const noun = count === 1 ? 'image' : 'images'
    const full = `🖼️ ${count} ${noun} attached · #${last.image.id} ${last.image.width}×${last.image.height}`
    const countOnly = `🖼️ ${count} ${noun} attached`
    const line = visibleWidth(full) <= width
      ? full
      : visibleWidth(countOnly) <= width
        ? countOnly
        : truncateToWidth(countOnly, width, '…')
    this.lastHitMap = { height: 1, removes: [] }
    return [color.textDim(line)]
  }

  /** Identity row + one bounded pixel card for the LAST occurrence. */
  private renderCard(
    width: number,
    occurrences: readonly DraftImageOccurrence[],
    text: string,
    limit: number,
  ): string[] {
    const last = occurrences[occurrences.length - 1]!
    const imageRows = Math.max(0, Math.min(DRAFT_PREVIEW_CARD_ROWS, limit - 1))
    const cardWidth = width >= DRAFT_PREVIEW_WIDE_WIDTH
      ? DRAFT_PREVIEW_WIDE_CARD_WIDTH
      : DRAFT_PREVIEW_CARD_WIDTH
    const usedImageKeys = new Set<string>()
    const usedImageIds = new Set<number>()
    const mode = this.pixelMode(last.image)
    let status: DraftPreviewStatus
    let derivedPng: KittyThumbnailPng | undefined
    if (mode === 'direct') {
      // A raw PNG / iTerm2 card retires any previous derived presentation.
      this.retireDraftPresentation()
      status = 'ready'
    } else if (mode === 'kitty-derived') {
      const preview = this.advanceDerivedPreview(last.image)
      status = preview.status
      derivedPng = preview.png
    } else {
      this.retireDraftPresentation()
      status = 'unavailable'
    }
    let imageLines: string[] = []
    if (imageRows > 0) {
      if (mode === 'direct') {
        imageLines = this.renderImage(last, Math.min(cardWidth, width), imageRows, usedImageKeys, usedImageIds)
      } else if (status === 'ready' && derivedPng !== undefined) {
        imageLines = this.renderDerivedImage(
          last,
          derivedPng,
          Math.min(cardWidth, width),
          imageRows,
          usedImageKeys,
          usedImageIds,
        )
      }
    }
    const control = this.fullscreenMouse()
      && width >= 3
      && (this.removable === undefined || this.removable(last))
    const identity = this.buildIdentityLine(width, last, occurrences.length, control, status)
    this.lastHitMap = {
      height: 1 + imageLines.length,
      removes: control ? [this.removeHit(0, width, last, text)] : [],
    }
    this.prunePixelCaches(usedImageKeys, usedImageIds)
    return [identity, ...imageLines]
  }

  /** The one-line identity/action row. A pending derivation keeps the original
   * identity plus `…`; a real admission/decoder failure names the failure in
   * the `error` ink while the identity facts stay `textDim` (design-language
   * role 16). */
  private buildIdentityLine(
    width: number,
    occurrence: DraftImageOccurrence,
    total: number,
    control: boolean,
    status: DraftPreviewStatus,
  ): string {
    const image = occurrence.image
    const name = this.displayName(image)
    const prefix = `🖼️ #${image.id}/${total}`
    const facts = `${image.width}×${image.height} · ${formatBytes(image.byteLength)}`
    // Pre-paint the spans before width truncation: `truncateToWidth` is ANSI
    // aware and terminates an open span, so a narrow row can never leak the
    // error ink into the right-aligned count/control.
    const left = status === 'unavailable'
      ? `${color.textDim(`${prefix} · `)}${color.error('Preview unavailable')}${color.textDim(`${name === '' ? '' : ` · ${name}`} · ${image.mediaType} · ${facts}`)}`
      : color.textDim(`${prefix} · ${facts}${status === 'pending' ? ' · …' : ''}`)
    const remaining = total > 1 ? `+${total - 1}` : ''
    const rightPlain = [remaining, control ? REMOVE_CONTROL : ''].filter(part => part !== '').join(' ')
    if (rightPlain === '') return truncateToWidth(left, width, '…')
    const leftBudget = Math.max(1, width - visibleWidth(rightPlain) - 1)
    const visibleLeft = truncateToWidth(left, leftBudget, '…')
    const gap = Math.max(1, width - visibleWidth(visibleLeft) - visibleWidth(rightPlain))
    const right = [
      remaining === '' ? '' : color.textMuted(remaining),
      control ? color.primary(REMOVE_CONTROL) : '',
    ].filter(part => part !== '').join(' ')
    return `${visibleLeft}${' '.repeat(gap)}${right}`
  }

  /** One `x` hit at the far-right cell of the identity row. */
  private removeHit(
    row: number,
    width: number,
    occurrence: DraftImageOccurrence,
    text: string,
  ): DraftPreviewRemoveHit {
    return {
      row,
      startCol: width - 1,
      endCol: width,
      imageId: occurrence.image.id,
      ordinal: occurrence.ordinal,
      startOffset: occurrence.startOffset,
      endOffset: occurrence.endOffset,
      draftText: text,
    }
  }

  /** Render the LAST occurrence's DIRECT pixel card (raw PNG on Kitty, or the
   * original raster format through iTerm2's OSC 1337). The caller already
   * admitted this card through {@link pixelMode}. */
  private renderImage(
    occurrence: DraftImageOccurrence,
    cardWidth: number,
    maxRows: number,
    usedKeys: Set<string>,
    usedIds: Set<number>,
  ): string[] {
    const image = occurrence.image
    const protocol = getCapabilities().images ?? 'none'
    const native = this.nativeGraphics
    const key = `${image.id}:${occurrence.ordinal}:${image.mediaType}:${cardWidth}:${maxRows}:${protocol}:${image.byteLength}:direct:${native === undefined ? 'legacy' : 'managed'}`
    usedKeys.add(key)
    usedIds.add(image.id)
    let cached = this.imageCache.get(key)
    if (cached === undefined) {
      const name = this.displayName(image)
      cached = native === undefined
        ? new Image(
          this.base64For(image),
          image.mediaType,
          this.theme,
          {
            maxWidthCells: cardWidth,
            maxHeightCells: maxRows,
            ...(name === '' ? {} : { filename: name }),
          },
          { widthPx: image.width, heightPx: image.height },
        )
        : native.image(
          { pngBase64: this.base64For(image), widthPx: image.width, heightPx: image.height },
          {
            maxWidthCells: cardWidth,
            maxHeightCells: maxRows,
            fallback: this.theme.fallbackColor(imageFallback(
              image.mediaType,
              { widthPx: image.width, heightPx: image.height },
              name === '' ? undefined : name,
            )),
          },
        )
      this.imageCache.set(key, cached)
    }
    // The fork clamps to `width - 2`; pass two extra cells so the rendered
    // card width is exactly cardWidth (22/44).
    return cached.render(cardWidth + 2).slice(0, maxRows)
  }

  /** Render the current candidate's READY derived PNG. The placement uses the
   * PNG's own (EXIF-oriented, bounded) dimensions; the identity row keeps the
   * original draft dimensions. */
  private renderDerivedImage(
    occurrence: DraftImageOccurrence,
    png: KittyThumbnailPng,
    cardWidth: number,
    maxRows: number,
    usedKeys: Set<string>,
    usedIds: Set<number>,
  ): string[] {
    const image = occurrence.image
    const native = this.nativeGraphics
    const key = `${image.id}:${occurrence.ordinal}:derived-kitty:${this.draftGeneration}:${cardWidth}:${maxRows}:${png.width}:${png.height}:${png.byteLength}:${native === undefined ? 'legacy' : 'managed'}`
    usedKeys.add(key)
    usedIds.add(image.id)
    let cached = this.imageCache.get(key)
    if (cached === undefined) {
      const name = this.displayName(image)
      cached = native === undefined
        ? new Image(
          png.base64,
          'image/png',
          this.theme,
          {
            maxWidthCells: cardWidth,
            maxHeightCells: maxRows,
            ...(name === '' ? {} : { filename: name }),
          },
          { widthPx: png.width, heightPx: png.height },
        )
        : native.image(
          { pngBase64: png.base64, widthPx: png.width, heightPx: png.height },
          {
            maxWidthCells: cardWidth,
            maxHeightCells: maxRows,
            fallback: this.theme.fallbackColor(imageFallback(
              'image/png',
              { widthPx: png.width, heightPx: png.height },
              name === '' ? undefined : name,
            )),
          },
        )
      this.imageCache.set(key, cached)
    }
    return cached.render(cardWidth + 2).slice(0, maxRows)
  }

  /** Base64 bytes are immutable per draft; encode once per draft instance. */
  private base64For(image: DraftImage): string {
    const key = `${image.id}:${image.byteLength}`
    const cached = this.base64Cache.get(key)
    if (cached !== undefined) return cached
    const data = Buffer.from(image.bytes).toString('base64')
    this.base64Cache.set(key, data)
    return data
  }

  /**
   * Which pixel path THIS card may use, or `unavailable`.
   *
   * The 4 MiB cap and the empty/recalled admission are Client-local preview
   * rules (the store's submission cap is wider). Kitty gets PNG directly and
   * JPEG/WebP through the one 6A derivative; GIF and any other raster stay
   * metadata-only. iTerm2 keeps carrying the original format through OSC 1337.
   */
  private pixelMode(image: DraftImage): DraftPreviewPixelMode {
    const protocol = getCapabilities().images
    if (protocol === null || protocol === undefined) return 'unavailable'
    if (image.source.type === 'recalled') return 'unavailable'
    if (image.bytes.byteLength === 0 || image.bytes.byteLength > DRAFT_PREVIEW_MAX_PIXEL_BYTES) return 'unavailable'
    if (image.byteLength > DRAFT_PREVIEW_MAX_PIXEL_BYTES) return 'unavailable'
    if (protocol === 'kitty') {
      if (image.mediaType === 'image/png') return 'direct'
      if (image.mediaType === 'image/jpeg' || image.mediaType === 'image/webp') return 'kitty-derived'
      return 'unavailable'
    }
    return 'direct'
  }

  /**
   * Advance the ONE derived presentation for the current card.
   *
   * A card switch retires the previous candidate/READY/failure and bumps the
   * generation, then this card becomes the single-flight slot's target. A
   * conversion is only STARTED here (synchronously claiming the slot, with the
   * decoder deferred a microtask later); render never awaits and never runs a
   * decoder in its own stack. While another target's job is still in flight
   * this card stays pending — its own conversion starts on a later frame once
   * the slot settles.
   */
  private advanceDerivedPreview(
    image: DraftImage,
  ): { status: DraftPreviewStatus; png?: KittyThumbnailPng } {
    if (this.draftReady !== undefined && this.draftReady.image === image) {
      return { status: 'ready', png: this.draftReady.png }
    }
    if (this.draftFailed === image) return { status: 'unavailable' }
    if (this.draftCandidate !== image) {
      this.draftGeneration += 1
      this.draftCandidate = image
      this.draftReady = undefined
      this.draftFailed = undefined
      this.clearPixelCaches()
    }
    if (this.activeDraftConversion !== undefined) return { status: 'pending' }
    this.startDerivedConversion(image)
    return { status: 'pending' }
  }

  /** Claim the ONE conversion slot and defer the decoder outside render(). */
  private startDerivedConversion(image: DraftImage): void {
    const generation = this.draftGeneration
    const record: {
      image: DraftImage
      generation: number
      pending: Promise<void>
    } = { image, generation, pending: Promise.resolve() }
    this.activeDraftConversion = record
    record.pending = Promise.resolve().then(async () => {
      // EVERY path through this deferred task must release the claimed slot,
      // including the START-time currentness check: a target switch,
      // invalidation or dispose between the scheduling frame and this
      // microtask means the decoder never starts, but the slot is still ours.
      try {
        if (!this.isCurrentDerivedTarget(image, generation)) return
        const png = await this.convertThumbnail(
          image.bytes,
          image.mediaType as 'image/jpeg' | 'image/webp',
        )
        if (!this.isCurrentDerivedTarget(image, generation)) return
        this.draftReady = { image, png }
      } catch {
        // The bounded presentation failure; the native Error never reaches the
        // terminal. The rejection is HANDLED here (no unhandled rejection).
        if (!this.isCurrentDerivedTarget(image, generation)) return
        this.draftFailed = image
      } finally {
        // Release the slot, commit the state above, THEN ask for the frame that
        // shows it. A settled stale target still frees the slot for the
        // CURRENT candidate, so it gets its one chance on the next paint.
        if (this.activeDraftConversion === record) this.activeDraftConversion = undefined
        if (!this.disposed && this.draftCandidate !== undefined) this.requestRender()
      }
    })
  }

  /** Whether a deferred decoder result still belongs to the visible card. */
  private isCurrentDerivedTarget(image: DraftImage, generation: number): boolean {
    return !this.disposed
      && generation === this.draftGeneration
      && this.draftCandidate === image
  }

  /** Retire the current derived presentation. A running conversion keeps its
   * slot until it settles; every late result is discarded by the generation. */
  private retireDraftPresentation(): void {
    if (this.draftCandidate === undefined
      && this.draftReady === undefined
      && this.draftFailed === undefined) {
      return
    }
    this.draftGeneration += 1
    this.draftCandidate = undefined
    this.draftReady = undefined
    this.draftFailed = undefined
  }

  /** Sanitized display name; never a path, never a terminal control. */
  private displayName(image: DraftImage): string {
    return image.name === undefined || image.name === '' ? '' : sanitizedPhysicalLine(image.name)
  }

  private occurrencesFor(text: string): readonly DraftImageOccurrence[] {
    const cached = this.occurrenceCache
    if (cached !== undefined && cached.text === text) return cached.occurrences
    const occurrences = selectDraftImageOccurrences(text, this.source)
    this.occurrenceCache = { text, occurrences }
    return occurrences
  }

  /** Drop every per-instance pixel/base64 cache (no card is displayed). */
  private clearPixelCaches(): void {
    for (const image of this.imageCache.values()) image.dispose?.()
    this.imageCache.clear()
    this.base64Cache.clear()
  }

  /** Keep only the currently displayed card's caches. */
  private prunePixelCaches(usedKeys: ReadonlySet<string>, usedIds: ReadonlySet<number>): void {
    for (const [key, image] of this.imageCache) {
      if (usedKeys.has(key)) continue
      image.dispose?.()
      this.imageCache.delete(key)
    }
    for (const key of [...this.base64Cache.keys()]) {
      const separator = key.indexOf(':')
      const id = Number.parseInt(separator === -1 ? key : key.slice(0, separator), 10)
      if (!usedIds.has(id)) this.base64Cache.delete(key)
    }
  }
}
