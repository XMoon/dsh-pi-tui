/**
 * One inline published Visual inside the Assistant body.
 *
 * The figure OWNS the row layout and nothing else: it composes the existing
 * `ChartBody` (exact values/ASCII) or the existing SVG description + admitted
 * `SvgThumbnail`, appends its real, visible action row and reports the action
 * cells it actually painted. It holds no Session, no transcript row identity,
 * no global keymap and no clipboard: Copy/`View` are intent callbacks supplied
 * by the host renderer, and the current selection is read through a live
 * predicate so a selection change only repaints (it never rebuilds the row).
 *
 * Action targets are the cells of the LAST painted action row. The host's
 * fullscreen press/release owner records those cells into its frame snapshot
 * and re-proves them on release, so a reflow that moved a control can never
 * transfer a click to whatever moved onto the cell.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/visual-figure
 */

import { Text, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { PublishedVisual } from '../../../domain/visual/publication.ts'
import { svgDetailRows } from '../../../domain/visual/svg.ts'
import type { SvgRasterLoader } from '../../../client/media/svg/raster-loader.ts'
import { ChartBody } from './chart-body.ts'
import { SvgThumbnail, type SvgThumbnailTheme } from '../media/svg-thumbnail.ts'
import type { NativeKittyGraphics } from '../../graphics/native-image.ts'
import { sanitizeDisplayText } from '../../presentation/terminal-text.ts'
import { color } from '../../theme/runtime.ts'

/** The two inline figure intents. */
export type VisualFigureAction = 'copy' | 'view'

/** One painted action cell range (figure-relative row). */
export interface VisualFigureActionHit {
  readonly action: VisualFigureAction
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

/** The figure-relative hit geometry of the LAST render at one width. */
export interface VisualFigurePaintedHits {
  /** Total painted rows of the figure (body + actions). */
  readonly height: number
  readonly actions: readonly VisualFigureActionHit[]
  /** The SVG thumbnail's REAL pixel body, figure-relative rows/columns. */
  readonly thumbnailBody?: {
    readonly startRow: number
    readonly endRow: number
    readonly endCol: number
  }
}

/** Everything the figure paints from and reports to; no Session, no keymap. */
export interface VisualFigureOptions {
  /** The exact qualified publication this figure renders. */
  readonly publication: PublishedVisual
  /** Live selection predicate (read at render; never cached). */
  readonly selected: () => boolean
  /** Paint function for chart/SVG body text (the existing tool-card convention). */
  readonly paint: (text: string) => string
  /** Repaint after an SVG raster settle. */
  readonly requestRender: () => void
  /** Copy this publication's exact display payload. */
  readonly onCopy: () => void
  /** Open this SVG in the leased viewer (absent for charts). */
  readonly onView?: () => void
  readonly svgLoader?: SvgRasterLoader
  readonly svgTheme?: SvgThumbnailTheme
  /** The already-admitted SVG display target width (reused, not re-derived). */
  readonly svgAdmissionWidth?: number
  /** The ONE managed graphics owner of this physical terminal (Image-7A). */
  readonly nativeGraphics?: NativeKittyGraphics
}

/** The selected device's textual label (colour is never the only signal). */
const SELECTED_LABEL = '[Selected]'
/** One-cell spacing after the selected device. */
const SELECTED_GAP = 1
/** The action-row separator (design language §4.2: one ` · ` per job). */
const ACTION_SEPARATOR = ' · '

/** One action row segment before layout: a semantic intent and its verb. */
interface ActionSpec {
  readonly action: VisualFigureAction
  readonly label: string
}

/** One laid-out action row: the painted string and the exact painted cells. */
interface ActionRowLayout {
  readonly painted: string
  readonly actions: readonly VisualFigureActionHit[]
}

/**
 * Lay out the action row at one width.
 *
 * Degradation is whole-label: the selected device is dropped first (the
 * status line still names the selection), then the lower-priority copy verb
 * (opening the viewer stays reachable), and only a label wider than the whole
 * row is truncated. A surviving verb therefore always has a complete, real hit
 * area — never a half-painted button.
 * @param specs - the figure's verbs in display order.
 * @param width - the figure's content width in cells.
 * @param selected - whether this figure currently carries the selection.
 * @returns the painted row and its exact per-verb cell ranges.
 */
function layoutActionRow(specs: readonly ActionSpec[], width: number, selected: boolean): ActionRowLayout {
  const compose = (kept: readonly ActionSpec[], withSelected: boolean): ActionRowLayout => {
    let painted = ''
    const actions: VisualFigureActionHit[] = []
    if (withSelected) {
      painted += color.primary(SELECTED_LABEL) + ' '.repeat(SELECTED_GAP)
    }
    for (const [index, spec] of kept.entries()) {
      if (index > 0) painted += color.textMuted(ACTION_SEPARATOR)
      const startCol = visibleWidth(painted)
      painted += color.primary(spec.label)
      actions.push({ action: spec.action, row: 0, startCol, endCol: startCol + visibleWidth(spec.label) })
    }
    return { painted, actions }
  }
  const safeWidth = Math.max(1, Math.floor(width))
  const candidates: Array<{ kept: readonly ActionSpec[]; withSelected: boolean }> = [
    { kept: specs, withSelected: selected },
    { kept: specs, withSelected: false },
    ...(specs.length > 1 ? [{ kept: specs.slice(0, 1), withSelected: false }] : []),
  ]
  for (const candidate of candidates) {
    const layout = compose(candidate.kept, candidate.withSelected)
    if (visibleWidth(layout.painted) <= safeWidth) return layout
  }
  const last = specs[0]
  if (last === undefined) return { painted: '', actions: [] }
  const painted = color.primary(truncateToWidth(last.label, safeWidth, '…'))
  return {
    painted,
    actions: [{
      action: last.action,
      row: 0,
      startCol: 0,
      endCol: visibleWidth(painted),
    }],
  }
}

/** One published chart/SVG figure inside the existing Assistant body. */
export class VisualFigureComponent implements Component {
  private readonly options: VisualFigureOptions
  /** The chart body, the SVG description text, or the explicit fallback row. */
  private readonly body: Component
  private readonly thumbnail: SvgThumbnail | undefined
  /** The hit geometry of the LAST render, keyed by the width it painted at. */
  private painted: (VisualFigurePaintedHits & { readonly width: number }) | undefined
  /** Whether this figure carries an action row at all. */
  private readonly actions: readonly ActionSpec[]

  constructor(options: VisualFigureOptions) {
    this.options = options
    const source = options.publication.source
    if (source.chart !== undefined) {
      this.body = new ChartBody(source.chart, options.paint)
      this.thumbnail = undefined
      this.actions = [{ action: 'copy', label: 'Copy Data' }]
    } else if (source.svg !== undefined && source.svgSource !== undefined) {
      // The tool card's SVG convention: the readable description is ALWAYS
      // visible; the raster is an enhancement on top of it.
      this.body = new Text(options.paint(sanitizeDisplayText(svgDetailRows(source.svg).join('\n'))), 0, 0)
      this.thumbnail = options.svgLoader !== undefined
        && options.svgTheme !== undefined
        && options.svgAdmissionWidth !== undefined
        ? new SvgThumbnail(
            source.svg.digest,
            source.svgSource,
            options.svgAdmissionWidth,
            options.svgLoader,
            options.svgTheme,
            options.requestRender,
            undefined,
            options.nativeGraphics,
          )
        : undefined
      this.actions = [
        ...(options.onView === undefined ? [] : [{ action: 'view' as const, label: 'View' }]),
        { action: 'copy', label: 'Copy SVG' },
      ]
    } else {
      this.body = new Text(options.paint(sanitizeDisplayText('Drawing unavailable — the visual fact is missing')), 0, 0)
      this.thumbnail = undefined
      this.actions = []
    }
  }

  /** The publication ref this figure paints (the occurrence identity). */
  get ref(): string {
    return this.options.publication.ref
  }

  /** The exact publication object this figure was built for. */
  get publication(): PublishedVisual {
    return this.options.publication
  }

  /**
   * The hit geometry this figure PAINTED at `width`, or undefined when it has
   * not rendered at that width yet (the frame the user sees is the only one a
   * click may resolve against).
   * @param width - the content width the figure was last rendered at.
   * @returns the relative action/thumbnail cells of that exact render.
   */
  paintedHitMap(width: number): VisualFigurePaintedHits | undefined {
    if (this.painted === undefined || this.painted.width !== width) return undefined
    return {
      height: this.painted.height,
      actions: this.painted.actions,
      ...(this.painted.thumbnailBody === undefined ? {} : { thumbnailBody: this.painted.thumbnailBody }),
    }
  }

  invalidate(): void {
    this.body.invalidate?.()
    this.thumbnail?.invalidate()
    this.painted = undefined
  }

  dispose(): void {
    this.thumbnail?.dispose()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const lines = this.body.render(safeWidth)
    const bodyRows = lines.length
    let thumbnailRows: string[] = []
    let thumbnailBody: VisualFigurePaintedHits['thumbnailBody']
    if (this.thumbnail !== undefined) {
      thumbnailRows = this.thumbnail.render(safeWidth)
      const painted = this.thumbnail.paintedImageBody(safeWidth)
      // The thumbnail's first row is its own spacer, so its first REAL pixel
      // row is bodyRows + 1. A loading/error/text-fallback render reports no
      // body, and the rows stay inert.
      if (painted !== undefined) {
        thumbnailBody = {
          startRow: bodyRows + 1,
          endRow: bodyRows + 1 + painted.rows,
          endCol: painted.endCol,
        }
      }
    }
    let actionRow: ActionRowLayout | undefined
    if (this.actions.length > 0) {
      actionRow = layoutActionRow(this.actions, safeWidth, this.options.selected())
    }
    const height = bodyRows + thumbnailRows.length + (actionRow === undefined ? 0 : 1)
    const actions = (actionRow?.actions ?? []).map(hit => ({ ...hit, row: bodyRows + thumbnailRows.length }))
    this.painted = {
      width: safeWidth,
      height,
      actions,
      ...(thumbnailBody === undefined ? {} : { thumbnailBody }),
    }
    return actionRow === undefined
      ? [...lines, ...thumbnailRows]
      : [...lines, ...thumbnailRows, actionRow.painted]
  }
}
