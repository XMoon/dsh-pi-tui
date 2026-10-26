/**
 * The ONE ordered Assistant body for published visuals.
 *
 * It renders the planner's single `text | visual` sequence inside the existing
 * `BulletedComponent` owner: Markdown segments keep live width-aware PiTui
 * `Markdown` instances, charts use the existing `ChartBody`, SVGs use the
 * existing admission facts + `SvgThumbnail`, and every non-text ContentBlock is
 * materialized at its original position through the host's existing renderer.
 * It never paints its own Agent bullet, never creates a second transcript row
 * and never re-derives publication authority.
 *
 * Empty text pieces are skipped as paint nodes but their position in the
 * sequence is preserved because the visual components are appended from the
 * ordered plan, not paired by compressed text indexes.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/visual-assistant-body
 */

import {
  Text,
  type Component,
  type MarkdownOptions,
  type MarkdownTheme,
} from '@xmoon76/pi-tui'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PlacementPiece,
  SharedDefinitionsContext,
  VisualPiece,
} from '../../../domain/visual/placement.ts'
import { svgDetailRows } from '../../../domain/visual/svg.ts'
import type { SvgRasterLoader } from '../../../client/media/svg/raster-loader.ts'
import { ChartBody } from './chart-body.ts'
import { SvgThumbnail, type SvgThumbnailTheme } from '../media/svg-thumbnail.ts'
import { SharedDefinitionsMarkdown } from './shared-definitions-markdown.ts'
import { sanitizeDisplayText } from '../../presentation/terminal-text.ts'

/** Rendering dependencies supplied by the host renderer. */
export interface VisualAssistantBodyOptions {
  readonly pieces: readonly PlacementPiece[]
  readonly definitions: readonly SharedDefinitionsContext[]
  readonly blocks: readonly ContentBlock[]
  readonly theme: MarkdownTheme
  readonly markdownOptions: MarkdownOptions
  /** Paint function for chart/SVG body text (the existing tool-card convention). */
  readonly paint: (text: string) => string
  /** Existing Client-local raster path; absent means the explicit text fallback. */
  readonly svgLoader?: SvgRasterLoader
  readonly svgTheme?: SvgThumbnailTheme
  /** Repaint when an SVG raster settles. */
  readonly requestRender: () => void
  /**
   * Materialize one non-text ContentBlock at its original position through the
   * host's EXISTING renderer (image/file/fallback and occurrence bookkeeping).
   * Returning undefined means the block has no Assistant-body presentation
   * (reasoning / tool-call).
   */
  readonly nonText: (block: ContentBlock, blockIndex: number) => Component | undefined
}

/** The ordered Assistant body: no bullet, no row identity of its own. */
export class VisualAssistantBody implements Component {
  private readonly children: Component[] = []

  constructor(options: VisualAssistantBodyOptions) {
    const prefixByBlock = new Map<number, string>()
    for (const definition of options.definitions) {
      for (const blockIndex of definition.blockIndexes) prefixByBlock.set(blockIndex, definition.prefix)
    }
    const piecesByBlock = new Map<number, PlacementPiece[]>()
    const tail: VisualPiece[] = []
    for (const piece of options.pieces) {
      if (piece.kind === 'visual' && piece.blockIndex === null) {
        tail.push(piece)
        continue
      }
      if (piece.blockIndex === null) continue
      const existing = piecesByBlock.get(piece.blockIndex)
      if (existing === undefined) piecesByBlock.set(piece.blockIndex, [piece])
      else existing.push(piece)
    }
    // Adjacent text blocks are ONE Markdown document in the original
    // renderAssistantDisplaySequence (a bold span or a fenced code block may
    // cross a ContentBlock boundary). Merge every text piece until a real
    // Visual or a visible non-text component breaks the run; skipped
    // reasoning/tool-call blocks do not break it. The planner's blockIndex and
    // source spans stay authoritative; only the PAINT document is merged.
    let textBuffer = ''
    let textPrefix = ''
    const flushText = (): void => {
      if (textBuffer === '') return
      this.children.push(new SharedDefinitionsMarkdown({
        body: textBuffer,
        definitions: textPrefix,
        theme: options.theme,
        markdownOptions: options.markdownOptions,
      }))
      textBuffer = ''
      textPrefix = ''
    }
    const appendText = (source: string, blockIndex: number): void => {
      if (textBuffer === '') textPrefix = prefixByBlock.get(blockIndex) ?? ''
      textBuffer += source
    }
    for (const [blockIndex, block] of options.blocks.entries()) {
      if (block.type === 'text') {
        const pieces = piecesByBlock.get(blockIndex)
        if (pieces === undefined || pieces.length === 0) {
          appendText(block.text, blockIndex)
          continue
        }
        for (const piece of pieces) {
          if (piece.kind === 'text') {
            appendText(piece.source, blockIndex)
            continue
          }
          flushText()
          this.children.push(...this.visualComponents(piece, options))
        }
        continue
      }
      const component = options.nonText(block, blockIndex)
      if (component !== undefined) {
        flushText()
        this.children.push(component)
      }
    }
    flushText()
    for (const piece of tail) this.children.push(...this.visualComponents(piece, options))
  }

  private visualComponents(piece: VisualPiece, options: VisualAssistantBodyOptions): Component[] {
    const source = piece.publication.source
    if (source.chart !== undefined) return [new ChartBody(source.chart, options.paint)]
    if (source.svg !== undefined && source.svgSource !== undefined) {
      // The tool card's SVG convention: the readable description is ALWAYS
      // visible; the raster is an enhancement on top of it.
      const components: Component[] = [
        new Text(options.paint(sanitizeDisplayText(svgDetailRows(source.svg).join('\n'))), 0, 0),
      ]
      if (options.svgLoader !== undefined && options.svgTheme !== undefined && source.svgAdmissionWidth !== undefined) {
        components.push(new SvgThumbnail(
          source.svg.digest,
          source.svgSource,
          source.svgAdmissionWidth,
          options.svgLoader,
          options.svgTheme,
          options.requestRender,
        ))
      }
      return components
    }
    return [new Text(options.paint(sanitizeDisplayText('Drawing unavailable — the visual fact is missing')), 0, 0)]
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.()
  }

  dispose(): void {
    for (const child of this.children) child.dispose?.()
  }

  render(width: number): string[] {
    const lines: string[] = []
    for (const child of this.children) lines.push(...child.render(width))
    return lines
  }
}

/**
 * The outer frame of one visual Assistant message. The Host's existing
 * interrupted / delivered-files wrappers are plain Containers without disposal,
 * so the frame keeps the owned visual body reachable and releases its SVG
 * listener when the message component cache replaces or drops the row.
 */
export class VisualAssistantDisposalFrame implements Component {
  private readonly content: Component
  private readonly owned: Component

  constructor(content: Component, owned: Component) {
    this.content = content
    this.owned = owned
  }

  invalidate(): void {
    this.content.invalidate?.()
  }

  dispose(): void {
    this.owned.dispose?.()
  }

  render(width: number): string[] {
    return this.content.render(width)
  }
}
