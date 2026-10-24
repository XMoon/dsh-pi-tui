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
 * @module @xmoon76/dsh-pi-tui/tui/components/media/draft-image-preview
 */

import { Image, getCapabilities, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { formatBytes } from '../../../domain/media/format.ts'
import { color } from '../../theme/runtime.ts'
import { sanitizedPhysicalLine } from '../../presentation/lines.ts'
import {
  selectDraftImageOccurrences,
  type DraftImageOccurrence,
} from '../../../client/media/image/placeholder.ts'
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
   * Whether the previewed occurrence can be removed from the VISIBLE editor
   * text. Hidden-only paste occurrences return false; absent means all are
   * removable.
   */
  removable?: (occurrence: DraftImageOccurrence) => boolean
}

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
  /** Per-display-instance cache: id + occurrence + mime + width + protocol. */
  private readonly imageCache = new Map<string, Image>()
  /** Encoded bytes are immutable per draft; keyed by id + byte length. */
  private readonly base64Cache = new Map<string, string>()
  private occurrenceCache: { text: string; occurrences: readonly DraftImageOccurrence[] } | undefined
  private lastHitMap: DraftPreviewHitMap | undefined

  constructor(options: DraftImagePreviewOptions, theme: DraftImagePreviewTheme) {
    this.getDraftText = options.getDraftText
    this.source = options.source
    this.maxRows = options.maxRows
    this.fullscreenMouse = options.fullscreenMouse
    this.removable = options.removable
    this.theme = theme
  }

  /** The last-painted geometry, or undefined before the first render. */
  hitMap(): DraftPreviewHitMap | undefined {
    return this.lastHitMap
  }

  invalidate(): void {
    this.clearPixelCaches()
    this.occurrenceCache = undefined
    this.lastHitMap = undefined
  }

  dispose(): void {
    this.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const limit = Math.max(0, Math.floor(this.maxRows(safeWidth)))
    if (limit === 0) {
      this.clearPixelCaches()
      this.lastHitMap = undefined
      return []
    }
    const text = this.getDraftText()
    const occurrences = this.occurrencesFor(text)
    if (occurrences.length === 0) {
      this.clearPixelCaches()
      this.lastHitMap = undefined
      return []
    }
    if (limit < DRAFT_PREVIEW_MAX_ROWS || safeWidth < DRAFT_PREVIEW_COMPACT_WIDTH) {
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
    const imageLines = imageRows === 0
      ? []
      : this.renderImage(last, Math.min(cardWidth, width), imageRows, usedImageKeys, usedImageIds)
    const unavailable = !this.canRenderPixels(last.image)
    const control = this.fullscreenMouse()
      && width >= 3
      && (this.removable === undefined || this.removable(last))
    const identity = this.buildIdentityLine(width, last, occurrences.length, control, unavailable)
    this.lastHitMap = {
      height: 1 + imageLines.length,
      removes: control ? [this.removeHit(0, width, last, text)] : [],
    }
    this.prunePixelCaches(usedImageKeys, usedImageIds)
    return [identity, ...imageLines]
  }

  /** The one-line identity/action row. */
  private buildIdentityLine(
    width: number,
    occurrence: DraftImageOccurrence,
    total: number,
    control: boolean,
    unavailable: boolean,
  ): string {
    const image = occurrence.image
    const name = this.displayName(image)
    const prefix = `🖼️ #${image.id}/${total}`
    const left = unavailable
      ? `${prefix} · Preview unavailable${name === '' ? '' : ` · ${name}`} · ${image.mediaType} · ${image.width}×${image.height} · ${formatBytes(image.byteLength)}`
      : `${prefix} · ${image.width}×${image.height} · ${formatBytes(image.byteLength)}`
    const remaining = total > 1 ? `+${total - 1}` : ''
    const rightPlain = [remaining, control ? REMOVE_CONTROL : ''].filter(part => part !== '').join(' ')
    if (rightPlain === '') return color.textDim(truncateToWidth(left, width, '…'))
    const leftBudget = Math.max(1, width - visibleWidth(rightPlain) - 1)
    const visibleLeft = truncateToWidth(left, leftBudget, '…')
    const gap = Math.max(1, width - visibleWidth(visibleLeft) - visibleWidth(rightPlain))
    const right = [
      remaining === '' ? '' : color.textMuted(remaining),
      control ? color.primary(REMOVE_CONTROL) : '',
    ].filter(part => part !== '').join(' ')
    return `${color.textDim(visibleLeft)}${' '.repeat(gap)}${right}`
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

  /** Render the LAST occurrence's pixel card, or [] when no safe preview
   * exists (no image protocol, empty/oversized bytes, or a Kitty non-PNG
   * that the fork has no transcoder for). */
  private renderImage(
    occurrence: DraftImageOccurrence,
    cardWidth: number,
    maxRows: number,
    usedKeys: Set<string>,
    usedIds: Set<number>,
  ): string[] {
    const image = occurrence.image
    if (!this.canRenderPixels(image)) return []
    const protocol = getCapabilities().images ?? 'none'
    const key = `${image.id}:${occurrence.ordinal}:${image.mediaType}:${cardWidth}:${maxRows}:${protocol}:${image.byteLength}`
    usedKeys.add(key)
    usedIds.add(image.id)
    let cached = this.imageCache.get(key)
    if (cached === undefined) {
      const name = this.displayName(image)
      cached = new Image(
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
      this.imageCache.set(key, cached)
    }
    // The fork clamps to `width - 2`; pass two extra cells so the rendered
    // card width is exactly cardWidth (22/44).
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

  private canRenderPixels(image: DraftImage): boolean {
    const capabilities = getCapabilities()
    if (capabilities.images === null) return false
    if (image.bytes.byteLength === 0 || image.byteLength > DRAFT_PREVIEW_MAX_PIXEL_BYTES) return false
    // Kitty only accepts PNG without a registered transcoder; the fork has no
    // production transcoder, so non-PNG drafts stay metadata-only.
    if (capabilities.images === 'kitty' && image.mediaType !== 'image/png') return false
    return true
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
    for (const image of this.imageCache.values()) image.invalidate()
    this.imageCache.clear()
    this.base64Cache.clear()
  }

  /** Keep only the currently displayed card's caches. */
  private prunePixelCaches(usedKeys: ReadonlySet<string>, usedIds: ReadonlySet<number>): void {
    for (const [key, image] of this.imageCache) {
      if (usedKeys.has(key)) continue
      image.invalidate()
      this.imageCache.delete(key)
    }
    for (const key of [...this.base64Cache.keys()]) {
      const separator = key.indexOf(':')
      const id = Number.parseInt(separator === -1 ? key : key.slice(0, separator), 10)
      if (!usedIds.has(id)) this.base64Cache.delete(key)
    }
  }
}
