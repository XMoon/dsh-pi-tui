/**
 * The PiTui SVG thumbnail: one admitted, Client-local raster inside the
 * EXISTING tool card or published Visual figure. It reuses the PR-C `Image`
 * component and image budget; it never writes a durable attachment or a second
 * protocol stack.
 *
 * The raster cache is keyed by `(digest, targetWidth)`, so this component owns
 * exactly ONE display variant — its admitted target width. A viewer's
 * high-resolution variant is a different cache entry and never replaces it.
 *
 * The component never awaits: it consults the raster loader synchronously and
 * asks it to fire the isolated conversion on first render; the loader's settle
 * notification invalidates the component, which repaints with the PNG. Inline
 * pixels are shown for Kitty and for Direct SIXEL (Image-8 / I8-2B); iTerm2 and
 * every other surface emit NO rows — the figure's description and source
 * availability remain the whole presentation.
 *
 * `paintedImageBody()` reports the REAL pixel rows the last COMMITTED frame
 * painted, so a click can only open the viewer from pixels the user actually
 * saw: a loading, failed or text-fallback render registers no body. For Kitty
 * that footprint is synchronous with the render; for SIXEL it is the owner's
 * last-committed answer, read live at query time (the Screen materializes the
 * raster after the component renders).
 * @module @xmoon76/dsh-pi-tui/tui/components/media/svg-thumbnail
 */

import { Image, imageFallback, type Component } from '@xmoon76/pi-tui'
import type { ImageGraphics, PixelBody } from '../../graphics/native-image.ts'
import { effectiveImageProtocol, type EffectiveImageProtocol } from '../../graphics/image-capability.ts'
import type { ImageProtocolPreference } from '../../graphics/image-protocol-preference.ts'
import type { ImageThumbnailTheme } from './image-thumbnail.ts'
import { MAX_IMAGE_ROWS, MAX_IMAGE_WIDTH, NARROW_WIDTH_THRESHOLD } from './image-thumbnail.ts'
import type { SvgRasterLoader } from '../../../client/media/svg/raster-loader.ts'

/** The image theme surface reused from the PR-C thumbnail. */
export type SvgThumbnailTheme = ImageThumbnailTheme

/** The painted pixel rows of the last render at one width. */
export interface SvgThumbnailBody {
  readonly rows: number
  readonly endCol: number
  /** Rows cropped from the top of the source by the Screen's visible window. */
  readonly cropTopRows?: number
}

/**
 * The columns one Kitty placement sequence actually occupies, read from the
 * sequence the fork just rendered (`c=` in the APC). The anchor at the START of
 * the row is required — the fork's text fallback is never a pixel body.
 * @param body - the fork `Image` output rows.
 * @returns the placement width, or undefined when no anchored sequence exists.
 */
function paintedImageColumns(body: readonly string[]): number | undefined {
  const anchored = /^\x1b_G([^;\x1b]*)[;\x1b]/.exec(body[0] ?? '')
  if (anchored === null) return undefined
  const columns = /(?:^|,)c=(\d+)/.exec(anchored[1]!)
  return columns === null ? undefined : Number(columns[1])
}

/** Render one admitted SVG source through the asynchronous raster cache. */
export class SvgThumbnail implements Component {
  private readonly digest: string
  private readonly source: string
  private readonly targetWidth: number
  private readonly loader: SvgRasterLoader
  private readonly theme: SvgThumbnailTheme
  private readonly requestRender: () => void
  /** When set, the component always occupies exactly this many rows. */
  private readonly fixedRows: number | undefined
  private unsubscribe: (() => void) | undefined
  /** The last successfully decoded derivative for this variant. A loader-cache
   *  eviction must not erase an image the component already painted. */
  private lastReady: { readonly base64: string; readonly widthPx: number; readonly heightPx: number } | undefined
  private instance: PixelBody | undefined
  /** Whether `instance` is a managed component (it owns a Core handle). */
  private instanceManaged = false
  /** The ONE managed graphics owner of this physical terminal, when admitted. */
  private readonly graphics: ImageGraphics | undefined
  /** The app's ONE startup image-protocol preference. */
  private readonly imageProtocolPreference: ImageProtocolPreference | undefined
  private cachedLines: string[] | undefined
  private cachedKey: string | undefined
  /** The real pixel rows and placement width the LAST render at `width`
   * painted. `undefined` whenever that render carried no pixels. */
  private paintedBody: (SvgThumbnailBody & { readonly width: number }) | undefined
  /** The actual raster dimensions of the derivative painted at `width`. */
  private paintedPixel: { readonly width: number; readonly widthPx: number; readonly heightPx: number } | undefined

  constructor(
    digest: string,
    source: string,
    targetWidth: number,
    loader: SvgRasterLoader,
    theme: SvgThumbnailTheme,
    requestRender: () => void,
    fixedRows?: number,
    graphics?: ImageGraphics,
    imageProtocolPreference?: ImageProtocolPreference,
  ) {
    this.digest = digest
    this.source = source
    this.targetWidth = targetWidth
    this.loader = loader
    this.theme = theme
    this.requestRender = requestRender
    this.fixedRows = fixedRows
    this.graphics = graphics
    this.imageProtocolPreference = imageProtocolPreference
    this.unsubscribe = loader.subscribe(digest, targetWidth, () => {
      this.invalidate()
      this.requestRender()
    })
  }

  /** Release the loader subscription (transcript trim / renderer retirement). */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.lastReady = undefined
    this.invalidate()
  }

  /**
   * The REAL pixel body rows the LAST COMMITTED frame at `width` painted, or
   * undefined when that render carried no pixels (not ready, failed, narrow,
   * no inline graphics protocol, or a non-pixel surface). This is the
   * authoritative "may a click on these rows open the Viewer?" answer —
   * deliberately not "the component emits rows".
   *
   * Kitty reports the footprint its synchronous render built. SIXEL must read
   * the owner's last-committed footprint at QUERY time: the component renders
   * before the Screen materializes the raster, so a render-time snapshot would
   * lag one frame (or clear on every repaint).
   * @param width - the transcript content width being hit-tested.
   * @returns the painted body row count and its widest occupied column.
   */
  paintedImageBody(width: number): SvgThumbnailBody | undefined {
    if (effectiveImageProtocol(this.graphics, this.imageProtocolPreference) === 'sixel') {
      const live = this.instance?.paintedBodyAt?.(width)
      if (live === undefined) return undefined
      return {
        rows: live.rows,
        endCol: live.columns,
        ...(live.cropTopRows === undefined ? {} : { cropTopRows: live.cropTopRows }),
      }
    }
    const painted = this.paintedBody
    if (painted === undefined || painted.width !== width) return undefined
    return { rows: painted.rows, endCol: painted.endCol }
  }

  /**
   * The actual raster dimensions of the derivative the LAST COMMITTED frame at
   * `width` painted (never the admitted target width, never the source's
   * declared width). `undefined` when that frame painted no pixels.
   * @param width - the transcript content width being inspected.
   * @returns the painted PNG's width/height in pixels.
   */
  paintedPixelSize(width: number): { readonly widthPx: number; readonly heightPx: number } | undefined {
    if (effectiveImageProtocol(this.graphics, this.imageProtocolPreference) === 'sixel') {
      if (this.instance?.paintedBodyAt?.(width) === undefined) return undefined
      const live = this.paintedPixel
      if (live === undefined || live.width !== width) return undefined
      return { widthPx: live.widthPx, heightPx: live.heightPx }
    }
    const painted = this.paintedPixel
    if (painted === undefined || painted.width !== width) return undefined
    return { widthPx: painted.widthPx, heightPx: painted.heightPx }
  }

  invalidate(): void {
    this.instance?.dispose?.()
    this.instance = undefined
    this.instanceManaged = false
    this.cachedLines = undefined
    this.cachedKey = undefined
    this.paintedBody = undefined
    this.paintedPixel = undefined
  }

  render(width: number): string[] {
    // The EFFECTIVE protocol (not the fork's process-wide detection) rides the
    // cache key: a live tmux admission may paint pixels where the fork reports
    // none, and its revocation must not reuse a cached PUA frame.
    const protocol = effectiveImageProtocol(this.graphics, this.imageProtocolPreference)
    const key = `${width}:${protocol ?? 'none'}`
    // Direct SIXEL readiness and the owner's bound occurrence are live facts:
    // caching the lines would leave a token row pointing at an occurrence the
    // owner already dropped. Re-derive the candidate on every paint, exactly
    // like ImageThumbnail's SIXEL branch.
    if (protocol !== 'sixel' && this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines
    const rendered = this.renderLines(width, protocol)
    // A nested card reserves a FIXED image row budget: a loading placeholder
    // and the settled image must not move later child headers/search rows.
    let lines = rendered
    if (this.fixedRows !== undefined && rendered.length > 0) {
      lines = rendered.slice(0, this.fixedRows)
      while (lines.length < this.fixedRows) lines.push('')
    }
    if (protocol === 'sixel') {
      this.cachedLines = undefined
      this.cachedKey = undefined
      return lines
    }
    this.cachedLines = lines
    this.cachedKey = key
    return lines
  }

  private renderLines(width: number, protocol: EffectiveImageProtocol): string[] {
    // Every non-pixel branch below clears the recorded body first: a previous
    // frame's geometry must never survive a state change at the same width.
    this.paintedBody = undefined
    this.paintedPixel = undefined
    if (width < NARROW_WIDTH_THRESHOLD) return []
    // SVG preview pixels are available through Kitty and Direct SIXEL
    // (Image-8 / I8-2B). iTerm2's inline framing is not understood by the
    // fork's ANSI width layer, and the other platforms have no verified native
    // raster bound: the figure keeps its description and source actions instead
    // of faking a pixel body. An admitted tmux virtual handle is a real Kitty
    // transport here.
    if (protocol !== 'kitty' && protocol !== 'sixel') return []
    // The FIXED row budget is a real PIXEL-height ceiling for SIXEL: slicing
    // the returned lines cannot crop the DCS the Screen encodes. One row is
    // the leading spacer, so N fixed rows grant at most N-1 image rows.
    const pixelRows = this.fixedRows === undefined
      ? MAX_IMAGE_ROWS
      : Math.min(MAX_IMAGE_ROWS, Math.max(0, this.fixedRows - 1))
    if (protocol === 'sixel' && this.fixedRows !== undefined && pixelRows === 0) {
      // No SIXEL body grant: paint the spacer (fixedRows === 1) or nothing
      // (fixedRows === 0) and start no raster read/encode at all. Kitty keeps
      // its existing fixed-row behavior (its loading/status row still paints).
      return this.fixedRows === 1 ? [''] : []
    }
    const state = this.loader.get(this.digest, this.targetWidth)
    if (state.state === 'ready') this.lastReady = state
    // The loader cache is bounded; an eviction (or a clear) must not turn an
    // already painted component back into a retrying placeholder. Use the
    // component's own last derivative, or a terminal error line for a digest
    // that never produced one.
    const effective = state.state === 'ready'
      ? state
      : this.lastReady
    if (effective !== undefined) {
      const managed = this.graphics !== undefined
      if (this.instance === undefined || this.instanceManaged !== managed) {
        this.instance?.dispose?.()
        this.instance = managed
          ? this.graphics!.image(
            { pngBase64: effective.base64, widthPx: effective.widthPx, heightPx: effective.heightPx },
            {
              maxHeightCells: protocol === 'sixel' ? pixelRows : MAX_IMAGE_ROWS,
              maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
              fallback: this.theme.fallbackColor(imageFallback(
                'image/png',
                { widthPx: effective.widthPx, heightPx: effective.heightPx },
                'svg',
              )),
            },
          )
          : new Image(
            effective.base64,
            'image/png',
            { fallbackColor: this.theme.fallbackColor },
            {
              maxHeightCells: protocol === 'sixel' ? pixelRows : MAX_IMAGE_ROWS,
              maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
              filename: 'svg',
            },
            { widthPx: effective.widthPx, heightPx: effective.heightPx },
          )
        this.instanceManaged = managed
      }
      const body = this.instance.render(width)
      if (protocol === 'sixel') {
        // The Screen materializes the DCS after this render, so the candidate
        // body is NOT pixel evidence yet. Keep only the derivative facts this
        // render bound; the getters still require the owner's committed
        // footprint before answering.
        this.paintedPixel = { width, widthPx: effective.widthPx, heightPx: effective.heightPx }
        return ['', ...body]
      }
      const columns = this.instance.paintedBodyAt?.(width)?.columns ?? paintedImageColumns(body)
      if (columns !== undefined) {
        this.paintedBody = { width, rows: body.length, endCol: columns }
        this.paintedPixel = { width, widthPx: effective.widthPx, heightPx: effective.heightPx }
      }
      return ['', ...body]
    }
    if (state.state === 'idle') {
      this.loader.load(this.digest, this.source, this.targetWidth)
      return [this.theme.fallbackColor('  Rendering SVG image…')]
    }
    if (state.state === 'loading') return [this.theme.fallbackColor('  Rendering SVG image…')]
    // A terminal loader state (a real failure or an evicted never-painted
    // digest): never re-request from this component; the figure keeps the
    // description and the source actions.
    return [this.theme.fallbackColor('  SVG image unavailable')]
  }
}
