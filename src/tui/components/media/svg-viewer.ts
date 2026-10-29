/**
 * The SVG viewer: ONE read-only content panel inside the EXISTING leased
 * image workspace screen.
 *
 * This panel is deliberately NOT a screen owner. `ImageWorkspacePanel` keeps
 * the physical `TuiAltScreen` lease, `preserveScreen` return stack, focus and
 * close lifecycle; this component owns only its local Preview/Source state,
 * its bounded Source read position and its painted hit geometry. It never
 * creates an overlay, a second alt screen, a clipboard service, a raster cache
 * or a second loader lane.
 *
 * Pages:
 * - PREVIEW (the default) places the Viewer's OWN width variant of the admitted
 *   SVG. The width target is derived from the real content grant by the frozen
 *   PR2.5 formula (never a fixed size, never an upscaled thumbnail); the
 *   renderer's safety remains `admitSvg` + the rasterizer's own budget checks.
 * - SOURCE shows a bounded, terminal-sanitized read-only projection of the raw
 *   XML with a local `scrollTop`; the ORIGINAL string is never rewritten, and
 *   `Copy` sends it unchanged.
 *
 * Preview pixels are Kitty-only. Without a usable protocol the page says
 * `Preview unavailable` and Source/Copy stay fully usable.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/svg-viewer
 */

import {
  Image,
  imageFallback,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { SVG_MAX_RASTER_PIXELS, SVG_MAX_RASTER_SIDE } from '../../../domain/visual/constants.ts'
import { admitSvg, type SvgAdmission } from '../../../domain/visual/svg-admission.ts'
import { isolatedSvgRasterSupported } from '../../../client/media/svg/rasterize.ts'
import type { SvgRasterLoader, SvgRasterState } from '../../../client/media/svg/raster-loader.ts'
import type { ImageGraphics, PixelBody } from '../../graphics/native-image.ts'
import { effectiveImageProtocol } from '../../graphics/image-capability.ts'
import { SVG_VIEWER_CHORDS, SVG_VIEWER_SCROLL_LABEL } from '../../keybindings/hints.ts'
import { renderActionBarRow, type ActionBarSegment } from '../../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../../presentation/lines.ts'
import { sanitizeDisplayText } from '../../presentation/terminal-text.ts'
import { color } from '../../theme/runtime.ts'

/** A safe finite row budget before the owning workspace grants the real one. */
const DEFAULT_MAX_ROWS = 18

/** The immutable SVG source one Viewer displays. */
export interface SvgViewerSource {
  readonly title: string
  /** The admitted raw SVG document: the Source body and the copy payload. */
  readonly svgSource: string
  readonly digest: string
  /** Copy the RAW source through the ONE Client-local clipboard owner. */
  readonly onCopy: () => void
}

/** Everything the Viewer needs from the leased workspace that owns it. */
export interface SvgViewerInput {
  readonly source: SvgViewerSource
  readonly rows: () => number
  readonly columns: () => number
  readonly requestRender: () => void
  /** The shared Client-local raster path; absent means the text fallback. */
  readonly loader?: SvgRasterLoader
  readonly theme: { fallbackColor(text: string): string }
  readonly onClose: () => void
  /**
   * The ONE managed graphics owner of this physical terminal (Image-7A). The
   * Preview page paints through the Core when it is admitted; the legacy
   * `Image` path stays for every other surface.
   */
  readonly graphics?: ImageGraphics
}

/** The two Viewer pages. */
type SvgViewerPage = 'preview' | 'source'

/** One painted pointer target of the last rendered frame. */
type SvgViewerHit =
  | { readonly kind: 'page'; readonly page: SvgViewerPage; readonly id: string; readonly startCol: number; readonly endCol: number }
  | { readonly kind: 'copy'; readonly id: string; readonly startCol: number; readonly endCol: number }

/** The geometry of the last frame: what a press may actually resolve. */
interface SvgViewerPainted {
  readonly width: number
  readonly termRows: number
  readonly hits: readonly SvgViewerHit[]
}

/** The press-time identity a release must still resolve. */
interface SvgViewerPress {
  readonly id: string
  readonly kind: SvgViewerHit['kind']
  readonly page: SvgViewerPage
  readonly startCol: number
  readonly endCol: number
  readonly width: number
  readonly termRows: number
}

/** The local pixel placement keyed by its exact inputs. */
interface SvgPreviewImage {
  readonly instance: PixelBody
  readonly width: number
  readonly bodyRows: number
  readonly base64: string
  readonly widthPx: number
  readonly heightPx: number
}

/** Render one published SVG in the leased image workspace. */
export class SvgViewerPanel implements Component {
  private readonly input: SvgViewerInput
  /** The immutable admission verdict of the source (safe viewport ratio). */
  private readonly admission: SvgAdmission
  /** The current page (Preview is the open default). */
  private page: SvgViewerPage = 'preview'
  /** The granted terminal row budget (the workspace sets it each paint). */
  private maxRows = DEFAULT_MAX_ROWS
  /** The Source page's ONE bounded read position (display rows). */
  private scrollTop = 0
  /** The derived, terminal-safe Source rows cached for the width they wrapped at. */
  private sourceRowsCache: { readonly width: number; readonly rows: readonly string[] } | undefined
  /** The exact variant this Viewer currently subscribes to. */
  private subscribedWidth: number | undefined
  private unsubscribe: (() => void) | undefined
  private previewImage: SvgPreviewImage | undefined
  /** Whether the current `previewImage` is a managed Core occurrence. */
  private previewImageManaged = false
  /** The last painted frame's hit geometry (never re-derived on a press). */
  private painted: SvgViewerPainted | undefined
  private press: SvgViewerPress | undefined

  constructor(input: SvgViewerInput) {
    this.input = input
    this.admission = admitSvg(input.source.svgSource)
  }

  /** Adopt the granted terminal row budget (the workspace re-reads it). */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
  }

  /** Esc closes, Tab switches pages, C copies; Source scroll keys are local. */
  handleInput(data: string): void {
    const chords = SVG_VIEWER_CHORDS
    if (chords.close.keys.some(key => matchesKey(data, key))) {
      this.input.onClose()
      return
    }
    if (chords.copy.keys.some(key => matchesKey(data, key))) {
      this.input.source.onCopy()
      return
    }
    if (chords.switchPage.keys.some(key => matchesKey(data, key))) {
      this.page = this.page === 'preview' ? 'source' : 'preview'
      this.input.requestRender()
      return
    }
    if (this.page !== 'source') return
    const bodyRows = this.bodyGrant()
    if (bodyRows <= 0) return
    const scroll = (delta: number): void => {
      this.scrollTop = Math.max(0, this.scrollTop + delta)
      this.input.requestRender()
    }
    if (chords.scrollUp.keys.some(key => matchesKey(data, key))) {
      scroll(-1)
      return
    }
    if (chords.scrollDown.keys.some(key => matchesKey(data, key))) {
      scroll(1)
      return
    }
    if (chords.pageUp.keys.some(key => matchesKey(data, key))) {
      scroll(-bodyRows)
      return
    }
    if (chords.pageDown.keys.some(key => matchesKey(data, key))) {
      scroll(bodyRows)
      return
    }
    if (chords.first.keys.some(key => matchesKey(data, key))) {
      this.scrollTop = 0
      this.input.requestRender()
      return
    }
    if (chords.last.keys.some(key => matchesKey(data, key))) {
      // The exact row count is known by the CURRENT width; clamp there.
      const total = this.sourceRows(this.renderWidth()).length
      this.scrollTop = Math.max(0, total - bodyRows)
      this.input.requestRender()
    }
  }

  /** Record one pointer press against the last painted frame (no re-render). */
  onCellPress(x: number, y: number): void {
    this.press = undefined
    const painted = this.painted
    if (painted === undefined) return
    if (this.input.rows() !== painted.termRows || this.input.columns() !== painted.width) return
    const hit = this.hitAt(painted, x, y)
    if (hit === undefined) return
    this.press = {
      id: hit.id,
      kind: hit.kind,
      page: this.page,
      startCol: hit.startCol,
      endCol: hit.endCol,
      width: painted.width,
      termRows: painted.termRows,
    }
  }

  /** Complete the press only if the SAME painted target is still under it. */
  onCellClick(x: number, y: number): void {
    const press = this.press
    this.press = undefined
    const painted = this.painted
    if (press === undefined || painted === undefined) return
    if (this.input.rows() !== press.termRows || this.input.columns() !== press.width) return
    if (painted.width !== press.width || painted.termRows !== press.termRows) return
    if (this.page !== press.page) return
    const hit = this.hitAt(painted, x, y)
    if (hit === undefined || hit.id !== press.id || hit.kind !== press.kind) return
    if (hit.startCol !== press.startCol || hit.endCol !== press.endCol) return
    if (hit.kind === 'copy') {
      this.input.source.onCopy()
      return
    }
    this.page = hit.page
    this.input.requestRender()
  }

  /** Drop the local image placement and painted geometry (not the source). */
  invalidate(): void {
    this.previewImage?.instance.dispose?.()
    this.previewImage = undefined
    this.painted = undefined
    this.press = undefined
  }

  /** Release this Viewer's subscription and its exact unused raster variant. */
  dispose(): void {
    this.releaseVariant()
    this.previewImage?.instance.dispose?.()
    this.previewImage = undefined
    this.painted = undefined
    this.press = undefined
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const rows = Math.max(1, Math.floor(this.maxRows))
    const bar = this.barRow(safeWidth)
    if (rows === 1) {
      this.painted = { width: safeWidth, termRows: rows, hits: this.barHits(bar.plain) }
      return [bar.painted]
    }
    const title = this.titleRow(safeWidth)
    if (rows === 2) {
      this.painted = { width: safeWidth, termRows: rows, hits: [...title.hits, ...this.barHits(bar.plain)] }
      return [title.painted, bar.painted]
    }
    const bodyRows = rows - 2
    let body: readonly string[]
    if (this.page === 'preview') {
      body = this.previewRows(safeWidth, bodyRows)
    } else {
      const source = this.sourceRows(safeWidth)
      // Resize keeps the Source read position inside the new legal range.
      this.scrollTop = Math.min(this.scrollTop, Math.max(0, source.length - bodyRows))
      body = source.slice(this.scrollTop)
    }
    const clipped = body.slice(0, bodyRows)
    const padded = clipped.length >= bodyRows
      ? clipped
      : [...clipped, ...Array.from({ length: bodyRows - clipped.length }, () => '')]
    this.painted = {
      width: safeWidth,
      termRows: rows,
      hits: [...title.hits, ...this.barHits(bar.plain)],
    }
    return [title.painted, ...padded, bar.painted]
  }

  /** The CONTENT rows between the title and the pinned bar. */
  private bodyGrant(): number {
    return Math.max(0, Math.floor(this.maxRows) - 2)
  }

  /** The width the last frame was painted at (the last render grant). */
  private renderWidth(): number {
    return this.painted?.width ?? 1
  }

  /** The top identity row: `SVG · <title>` plus the ONE active page device. */
  private titleRow(width: number): { readonly painted: string; readonly hits: readonly SvgViewerHit[] } {
    const previewActive = this.page === 'preview'
    const previewPlain = previewActive ? '[Preview]' : 'Preview'
    const sourcePlain = previewActive ? 'Source' : '[Source]'
    const devicePlain = `${previewPlain} · ${sourcePlain}`
    const deviceWidth = visibleWidth(devicePlain)
    // The title is MODEL-SUPPLIED: project it to ONE safe physical row BEFORE
    // either width branch. `sanitizeDisplayText` alone keeps LF (a second
    // painted row) and the narrow branch must never paint the raw bytes.
    const titlePlain = `SVG · ${sanitizedPhysicalLine(this.input.source.title)}`
    if (width < deviceWidth) {
      // Below the device's own width there is no truthful page device to paint.
      return { painted: truncateToWidth(color.textStrong(titlePlain), width, '…'), hits: [] }
    }
    const leftRoom = Math.max(0, width - deviceWidth - 1)
    const left = leftRoom === 0 ? '' : truncateToWidth(color.textStrong(titlePlain), leftRoom, '…')
    const pad = ' '.repeat(Math.max(0, width - visibleWidth(left) - deviceWidth))
    const deviceStart = width - deviceWidth
    const previewStart = deviceStart + (previewActive ? 1 : 0)
    const sourceStart = deviceStart + visibleWidth(previewPlain) + 3 + (previewActive ? 0 : 1)
    const paintedDevice = previewActive
      ? `${color.primary('[Preview]')}${color.textMuted(' · ')}${color.textDim('Source')}`
      : `${color.textDim('Preview')}${color.textMuted(' · ')}${color.primary('[Source]')}`
    return {
      painted: `${left}${pad}${paintedDevice}`,
      hits: [
        { kind: 'page', page: 'preview', id: 'svg-viewer:page:preview', startCol: previewStart, endCol: previewStart + 7 },
        { kind: 'page', page: 'source', id: 'svg-viewer:page:source', startCol: sourceStart, endCol: sourceStart + 6 },
      ],
    }
  }

  /** The pinned bottom bar: whole-segment degradation keeps Esc last. */
  private barRow(width: number): { readonly painted: string; readonly plain: string } {
    const chords = SVG_VIEWER_CHORDS
    const segments: ActionBarSegment[] = []
    // design-language §7.2 order: navigation, secondary verb, browsing hint,
    // then Esc last. The browsing hint is the FIRST whole segment dropped.
    segments.push({ text: `${chords.switchPage.label} view`, short: chords.switchPage.label, priority: 4 })
    segments.push({ text: `${chords.copy.label} copy source`, short: `${chords.copy.label} copy`, priority: 6 })
    if (this.page === 'source') {
      segments.push({
        text: `${SVG_VIEWER_SCROLL_LABEL} scroll`,
        short: SVG_VIEWER_SCROLL_LABEL,
        priority: 2,
      })
    }
    segments.push({ text: `${chords.close.label} close`, short: chords.close.label, priority: 8 })
    const plain = renderActionBarRow(segments, Math.max(1, width))
    return { painted: color.textDim(plain), plain }
  }

  /** The REAL bottom-bar copy segment cells of one painted bar (the full
   * label, or its whole-segment short form when the bar degraded). */
  private barHits(plain: string): readonly SvgViewerHit[] {
    const key = SVG_VIEWER_CHORDS.copy.label
    const label = plain.includes(`${key} copy source`)
      ? `${key} copy source`
      : plain.includes(`${key} copy`) ? `${key} copy` : undefined
    if (label === undefined) return []
    const index = plain.indexOf(label)
    return [{
      kind: 'copy',
      id: 'svg-viewer:copy',
      startCol: index,
      endCol: index + visibleWidth(label),
    }]
  }

  /** Resolve one cell of the last painted frame. */
  private hitAt(painted: SvgViewerPainted, x: number, y: number): SvgViewerHit | undefined {
    if (y === 0) {
      return painted.hits.find(hit => hit.kind === 'page' && x >= hit.startCol && x < hit.endCol)
    }
    if (y === painted.termRows - 1) {
      return painted.hits.find(hit => hit.kind === 'copy' && x >= hit.startCol && x < hit.endCol)
    }
    return undefined
  }

  /** The derived, terminal-safe Source projection (cached by wrap width). */
  private sourceRows(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    if (this.sourceRowsCache !== undefined && this.sourceRowsCache.width === safeWidth) {
      return this.sourceRowsCache.rows
    }
    const rows = wrapTextWithAnsi(sanitizeDisplayText(this.input.source.svgSource), safeWidth)
    this.sourceRowsCache = { width: safeWidth, rows }
    return rows
  }

  /** Whether this surface may paint real SVG pixels at all. */
  private previewSupported(): boolean {
    return this.input.loader !== undefined
      && this.admission.ok
      && effectiveImageProtocol(this.input.graphics) === 'kitty'
      && isolatedSvgRasterSupported()
  }

  /** The Viewer's OWN width variant from the real content grant (§4.2). */
  private targetWidthFor(contentCols: number, contentRows: number): number {
    if (!this.admission.ok) return 1
    const ratio = this.admission.viewportHeight / this.admission.viewportWidth
    const columnsBudget = Math.max(1, Math.floor(contentCols) * 16)
    const rowsBudget = Math.max(1, Math.floor(contentRows) * 32 / ratio)
    const sideBudget = Math.floor(SVG_MAX_RASTER_SIDE / Math.max(1, ratio))
    const pixelBudget = Math.floor(Math.sqrt(SVG_MAX_RASTER_PIXELS / ratio))
    return Math.max(1, Math.min(SVG_MAX_RASTER_SIDE, columnsBudget, rowsBudget, sideBudget, pixelBudget))
  }

  /** Subscribe to (and start) the exact grant-derived variant when it changes. */
  private ensureVariant(width: number, bodyRows: number): void {
    const loader = this.input.loader
    if (loader === undefined || !this.admission.ok) return
    const target = this.targetWidthFor(width, bodyRows)
    if (this.subscribedWidth === target) return
    this.releaseVariant()
    this.subscribedWidth = target
    this.unsubscribe = loader.subscribe(this.input.source.digest, target, () => {
      this.invalidate()
      this.input.requestRender()
    })
    loader.load(this.input.source.digest, this.input.source.svgSource, target)
  }

  /** Unsubscribe and cancel ONLY this Viewer's exact unused variant. */
  private releaseVariant(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
    if (this.subscribedWidth !== undefined) {
      this.input.loader?.releaseUnused(this.input.source.digest, this.subscribedWidth)
      this.subscribedWidth = undefined
    }
  }

  /** The Preview page body: the Viewer variant, or one truthful status row. */
  private previewRows(width: number, bodyRows: number): string[] {
    if (bodyRows <= 0) return []
    if (!this.previewSupported()) return [truncateToWidth(color.textDim('Preview unavailable'), width, '…')]
    this.ensureVariant(width, bodyRows)
    const target = this.subscribedWidth
    if (target === undefined) return [truncateToWidth(color.textDim('Preview unavailable'), width, '…')]
    const state = (this.input.loader as SvgRasterLoader).get(this.input.source.digest, target)
    if (state.state === 'idle' || state.state === 'loading') {
      return [truncateToWidth(color.textDim('Rendering preview…'), width, '…')]
    }
    if (state.state === 'error') {
      return [truncateToWidth(color.error('Preview unavailable'), width, '…')]
    }
    return this.imageLines(width, bodyRows, state)
  }

  /** Render the ready PNG at the body grant, rebuilding only on exact input change. */
  private imageLines(width: number, bodyRows: number, state: Extract<SvgRasterState, { state: 'ready' }>): string[] {
    const native = this.input.graphics
    if (this.previewImage === undefined
      || this.previewImage.width !== width
      || this.previewImage.bodyRows !== bodyRows
      || this.previewImage.base64 !== state.base64
      || this.previewImage.widthPx !== state.widthPx
      || this.previewImage.heightPx !== state.heightPx
      || this.previewImageManaged !== (native !== undefined)) {
      this.previewImage?.instance.dispose?.()
      // The fork's text fallback interpolates this name into a painted row and
      // does NOT strip terminal controls; project it to one safe physical row
      // at this boundary like every other external label.
      const label = sanitizedPhysicalLine(this.input.source.title)
      this.previewImage = {
        instance: native === undefined
          ? new Image(
            state.base64,
            'image/png',
            { fallbackColor: this.input.theme.fallbackColor },
            {
              maxWidthCells: Math.max(1, width),
              maxHeightCells: Math.max(1, bodyRows),
              filename: label,
            },
            { widthPx: state.widthPx, heightPx: state.heightPx },
          )
          : native.image(
            { pngBase64: state.base64, widthPx: state.widthPx, heightPx: state.heightPx },
            {
              maxWidthCells: Math.max(1, width),
              maxHeightCells: Math.max(1, bodyRows),
              fallback: this.input.theme.fallbackColor(imageFallback(
                'image/png',
                { widthPx: state.widthPx, heightPx: state.heightPx },
                label,
              )),
            },
          ),
        width,
        bodyRows,
        base64: state.base64,
        widthPx: state.widthPx,
        heightPx: state.heightPx,
      }
      this.previewImageManaged = native !== undefined
    }
    return this.previewImage.instance.render(width).slice(0, bodyRows)
  }
}
