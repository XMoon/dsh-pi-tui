/**
 * The PiTui SVG thumbnail: one admitted, Client-local raster inside the
 * EXISTING tool card. It reuses the PR-C `Image` component and image budget;
 * it never writes a durable attachment or a second protocol stack.
 *
 * The component never awaits: it consults the raster loader synchronously and
 * asks it to fire the isolated conversion on first render; the loader's settle
 * notification invalidates the component, which repaints with the PNG. When
 * the terminal has no inline-image protocol (or the card is narrower than the
 * existing threshold) it emits NO rows — the card body's description and source
 * availability remain the whole presentation.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/svg-thumbnail
 */

import { Image, getCapabilities, type Component } from '@xmoon76/pi-tui'
import type { ImageThumbnailTheme } from './image-thumbnail.ts'
import { MAX_IMAGE_ROWS, MAX_IMAGE_WIDTH, NARROW_WIDTH_THRESHOLD } from './image-thumbnail.ts'
import type { SvgRasterLoader } from '../../../client/media/svg/raster-loader.ts'

/** The image theme surface reused from the PR-C thumbnail. */
export type SvgThumbnailTheme = ImageThumbnailTheme

/** Render one admitted SVG source through the asynchronous raster cache. */
export class SvgThumbnail implements Component {
  private readonly digest: string
  private readonly source: string
  private readonly targetWidth: number
  private readonly loader: SvgRasterLoader
  private readonly theme: SvgThumbnailTheme
  private readonly requestRender: () => void
  private unsubscribe: (() => void) | undefined
  private instance: Image | undefined
  private cachedLines: string[] | undefined
  private cachedKey: string | undefined

  constructor(
    digest: string,
    source: string,
    targetWidth: number,
    loader: SvgRasterLoader,
    theme: SvgThumbnailTheme,
    requestRender: () => void,
  ) {
    this.digest = digest
    this.source = source
    this.targetWidth = targetWidth
    this.loader = loader
    this.theme = theme
    this.requestRender = requestRender
    this.unsubscribe = loader.subscribe(digest, () => {
      this.invalidate()
      this.requestRender()
    })
  }

  /** Release the loader subscription (transcript trim / renderer retirement). */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.invalidate()
  }

  invalidate(): void {
    this.instance = undefined
    this.cachedLines = undefined
    this.cachedKey = undefined
  }

  render(width: number): string[] {
    const capabilities = getCapabilities().images ?? 'none'
    const key = `${width}:${capabilities}`
    if (this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines
    const lines = this.renderLines(width)
    this.cachedLines = lines
    this.cachedKey = key
    return lines
  }

  private renderLines(width: number): string[] {
    if (width < NARROW_WIDTH_THRESHOLD) return []
    if (getCapabilities().images === null) return []
    const state = this.loader.get(this.digest)
    if (state.state === 'idle') {
      this.loader.load(this.digest, this.source, this.targetWidth)
      return [this.theme.fallbackColor('  Rendering SVG image…')]
    }
    if (state.state === 'loading') return [this.theme.fallbackColor('  Rendering SVG image…')]
    if (state.state === 'error') return [this.theme.fallbackColor('  SVG image rendering failed')]
    if (this.instance === undefined) {
      this.instance = new Image(
        state.base64,
        'image/png',
        { fallbackColor: this.theme.fallbackColor },
        {
          maxHeightCells: MAX_IMAGE_ROWS,
          maxWidthCells: Math.min(MAX_IMAGE_WIDTH, Math.max(1, width - 2)),
          filename: 'svg',
        },
        { widthPx: state.widthPx, heightPx: state.heightPx },
      )
    }
    return ['', ...this.instance.render(width)]
  }
}
