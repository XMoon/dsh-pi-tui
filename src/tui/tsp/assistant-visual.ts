/**
 * PR3: the ONE pure TSP projector for an Assistant's published visuals.
 *
 * It consumes only the PR1-authorized `PublishedVisual[]` and the PR2
 * `planVisualPlacement()` projection — it never re-derives publication
 * authority, never parses a marker itself, never reads a Tool card, a blob id
 * or a cache, and never awaits. The output is the ordered body of the SAME
 * Assistant `ui.card`: continuous Markdown runs (with the display-only shared
 * definition prefix), the figure of every inline/tail visual, and every
 * non-text ContentBlock at its original position through the mapper's own
 * `nonText` callback.
 *
 * A figure is one `ui.col(role='dsh.visual.figure')` inside that card, never a
 * second top-level card. Its Copy control is a real `html.button` carrying the
 * ONE pointer action value and NO SDK auto handler: the session owner admits
 * `event.act === VISUAL_COPY_ACTION` against the copy button node ids of the
 * current committed frame, so a stale action from an older frame can never be
 * matched by a ref substring or a bare call id.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/assistant-visual
 */

import { html, ui } from '@stencil-hq/tern'
import type { Node } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { planVisualPlacement, type PlacementPiece, type VisualPiece } from '../../domain/visual/placement.ts'
import type { PublishedVisual, VisualSource } from '../../domain/visual/publication.ts'
import { chartDisplayTitle, chartHumanText, chartProjection, chartValueRows } from '../../domain/visual/chart.ts'
import type { ChartFact } from '../../domain/visual/chart.ts'
import { svgDetailRows, type SvgFact } from '../../domain/visual/svg.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

/** The ONE pointer action value a figure's Copy button emits. */
export const VISUAL_COPY_ACTION = 'dsh-visual-copy'

/** The figure wrapper's stylesheet role (the scope-local sheet's selector). */
export const VISUAL_FIGURE_ROLE = 'dsh.visual.figure'

/** The Copy button's stylesheet role. */
export const VISUAL_COPY_ROLE = 'dsh.visual.copy'

/** The figure wrapper key prefix; the published ref completes it. */
export const VISUAL_FIGURE_KEY_PREFIX = 'body-visual-'

/** The Copy button's key inside one figure. */
export const VISUAL_COPY_KEY = 'visual-copy'

/** The native SVG image's key inside one figure. */
export const VISUAL_IMAGE_KEY = 'visual-image'

/**
 * The current-window selection, in the frame's own figure paint order. The
 * session owner computes it from the committed node tree; the mapper only
 * paints it on the matching figure.
 */
export interface SelectedVisualState {
  readonly ref: string
  /** 1-based position in the current window's figure order. */
  readonly index: number
  /** The current window's figure count. */
  readonly count: number
}

/** The explicit inputs the pure projector needs beyond the message itself. */
export interface AssistantVisualProjectionOptions {
  /** Whether the pane negotiated the native `chart` kind. */
  readonly chartKindsSupported: boolean
  /** Whether the pane negotiated the `image` kind AND the `blobs` feature. */
  readonly nativeImagesSupported: boolean
  /** The current selection, when it names one of this row's figures. */
  readonly selected?: SelectedVisualState
  /**
   * The session owner's synchronous display-demand sender for an admitted SVG
   * publication. It is called ONLY when the image node is actually projected
   * and only when the pane carries `image` + `blobs`; an absent sender or an
   * absent blob id draws no image node.
   */
  readonly requestPublishedSvgBlob?: (publication: PublishedVisual) => string | undefined
  /**
   * Materialize one non-text ContentBlock at its original position through
   * the mapper's existing body renderer (image/file/opaque fallbacks and the
   * shared attachment state). `undefined` means the block has no Assistant-body
   * presentation (reasoning / tool-call).
   */
  readonly nonText?: (block: ContentBlock, blockIndex: number) => Node[] | undefined
}

/** One visual occurrence of the ordered body. */
interface FigurePiece {
  readonly ref: string
  readonly publication: PublishedVisual
}

/** The ordered text|visual body split by its text block. */
interface ProjectedBody {
  readonly piecesByBlock: ReadonlyMap<number, readonly PlacementPiece[]>
  readonly tail: readonly FigurePiece[]
  readonly prefixByBlock: ReadonlyMap<number, string>
}

/** Partition the plan into its per-block pieces, tail figures and run prefixes. */
function projectBody(publications: readonly PublishedVisual[], message: { readonly text: string; readonly content?: readonly ContentBlock[] }): ProjectedBody {
  const plan = planVisualPlacement({
    text: message.text,
    ...(message.content === undefined ? {} : { content: message.content }),
    publications,
  })
  const piecesByBlock = new Map<number, PlacementPiece[]>()
  const tail: FigurePiece[] = []
  for (const piece of plan.pieces) {
    if (piece.kind === 'visual' && piece.blockIndex === null) {
      tail.push({ ref: piece.ref, publication: piece.publication })
      continue
    }
    if (piece.blockIndex === null) continue
    const existing = piecesByBlock.get(piece.blockIndex)
    if (existing === undefined) piecesByBlock.set(piece.blockIndex, [piece])
    else existing.push(piece)
  }
  const prefixByBlock = new Map<number, string>()
  for (const definition of plan.definitions) {
    for (const blockIndex of definition.blockIndexes) prefixByBlock.set(blockIndex, definition.prefix)
  }
  return { piecesByBlock, tail, prefixByBlock }
}

/** The kind label of one figure head. */
function figureKindLabel(source: VisualSource): 'Chart' | 'SVG' {
  return source.chart !== undefined ? 'Chart' : 'SVG'
}

/** The committed display title of one published source (the same text the
 *  figure head and the dock's selection summary use). */
export function publishedVisualTitle(publication: PublishedVisual): string {
  const source = publication.source
  if (source.chart !== undefined) return sanitizedPhysicalLine(chartDisplayTitle(source.chart))
  if (source.svg !== undefined) return sanitizedPhysicalLine(source.svg.title)
  return 'Visual'
}

/** The Copy control: a real button with the ONE session-admitted action value. */
function copyButton(source: VisualSource): Node {
  const chart = source.chart !== undefined
  return html.button({
    key: VISUAL_COPY_KEY,
    role: VISUAL_COPY_ROLE,
    aria: chart ? 'Copy chart data' : 'Copy SVG',
    actions: { click: VISUAL_COPY_ACTION },
  }, chart ? 'Copy Data' : 'Copy SVG')
}

/** The native/fallback body of one chart figure. */
function chartNodes(fact: ChartFact, supported: boolean): Node[] {
  if (!supported) {
    // No native chart: the exact FINAL title and values remain readable.
    return [ui.code({ key: 'visual-values', text: sanitizeDisplayText(chartHumanText(fact)), wrap: true })]
  }
  const projection = chartProjection(fact)
  return [
    ui.chart({
      key: 'visual-chart',
      kind: projection.kind,
      summary: sanitizeDisplayText(projection.summary),
      series: projection.series,
    }),
    ui.code({ key: 'visual-values', text: sanitizeDisplayText(chartValueRows(fact).join('\n')), wrap: true }),
  ]
}

/** The readable/native body of one SVG figure. */
function svgNodes(
  piece: FigurePiece,
  fact: SvgFact,
  options: AssistantVisualProjectionOptions,
): Node[] {
  // The readable description is ALWAYS drawn; the image is an enhancement.
  const nodes: Node[] = [
    ui.code({ key: 'visual-description', text: sanitizeDisplayText(svgDetailRows(fact).join('\n')), wrap: true }),
  ]
  if (!options.nativeImagesSupported) return nodes
  const blob = options.requestPublishedSvgBlob?.(piece.publication)
  if (blob === undefined) return nodes
  nodes.push(ui.image({
    key: VISUAL_IMAGE_KEY,
    blob,
    alt: sanitizedPhysicalLine(fact.title),
    actions: { click: 'zoom' },
  }))
  return nodes
}

/** One figure: head row (kind/title, selection, Copy button) then its body. */
function figureNode(piece: FigurePiece, options: AssistantVisualProjectionOptions): Node {
  const source = piece.publication.source
  const head: Node[] = [
    ui.text({
      key: 'visual-title',
      text: sanitizeDisplayText(`${figureKindLabel(source)} · ${publishedVisualTitle(piece.publication)}`),
      wrap: 'word',
    }),
  ]
  const selected = options.selected
  if (selected !== undefined && selected.ref === piece.ref) {
    head.push(ui.badge({ key: 'visual-selected', text: `Selected · ${selected.index}/${selected.count}` }))
  }
  // A Copy control exists only when the qualified source really has a copyable
  // payload (the final ChartFact or the admitted SVG source). A malformed
  // publication never becomes a dead button.
  if (source.chart !== undefined || source.svgSource !== undefined) head.push(copyButton(source))
  const children: Node[] = [
    // `wrap` keeps the Copy control inside the reading flow on a narrow pane
    // instead of clipping it: the client moves the trailing child onto its own
    // line, and the control keeps its own intact node.
    ui.row({ key: 'visual-head', wrap: true, gap: 'sm' }, ...head),
  ]
  if (source.chart !== undefined) {
    children.push(...chartNodes(source.chart, options.chartKindsSupported))
  } else if (source.svg !== undefined && source.svgSource !== undefined) {
    children.push(...svgNodes(piece, source.svg, options))
  } else {
    children.push(ui.text({ key: 'visual-unavailable', text: 'Drawing unavailable — the visual fact is missing' }))
  }
  return ui.col({ key: `${VISUAL_FIGURE_KEY_PREFIX}${piece.ref}`, role: VISUAL_FIGURE_ROLE, gap: 'sm' }, ...children)
}

/**
 * The ordered body nodes of one eligible final Assistant that owns published
 * visuals.
 *
 * Adjacent text blocks are ONE Markdown document (a bold span or a fence may
 * cross a ContentBlock boundary); only an inserted figure or a VISIBLE
 * non-text block flushes the buffer. Reasoning/tool-call blocks have no
 * Assistant body and therefore never interrupt a Markdown run. The
 * display-only shared-definition prefix rides each truly independent `ui.md`
 * run and never enters the source text, search or copy payloads.
 * @param message - the eligible final Assistant row (its own text/content).
 * @param publications - the PR1-qualified publications of the row's turn.
 * @param options - the pane's negotiated capabilities and the mapper's
 *   existing non-text body renderer.
 * @returns the ordered card children (no card of its own).
 */
export function assistantPublishedVisualNodes(
  message: { readonly text: string; readonly content?: readonly ContentBlock[] },
  publications: readonly PublishedVisual[],
  options: AssistantVisualProjectionOptions,
): Node[] {
  const body = projectBody(publications, message)
  const blocks: readonly ContentBlock[] = message.content !== undefined && message.content.length > 0
    ? message.content
    : message.text === '' ? [] : [{ type: 'text', text: message.text }]
  const nodes: Node[] = []
  let textBuffer = ''
  let textPrefix = ''
  let runOrdinal = 0
  const flushText = (): void => {
    if (textBuffer === '') return
    nodes.push(ui.md({
      key: `body-run-${runOrdinal}`,
      text: sanitizeDisplayText(`${textPrefix}${textBuffer}`),
    }))
    runOrdinal += 1
    textBuffer = ''
    textPrefix = ''
  }
  const appendText = (source: string, blockIndex: number): void => {
    if (textBuffer === '') textPrefix = body.prefixByBlock.get(blockIndex) ?? ''
    textBuffer += source
  }
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type === 'text') {
      const pieces = body.piecesByBlock.get(blockIndex)
      if (pieces === undefined) {
        // planVisualPlacement emits at least one piece per text block; a block
        // outside that guarantee still keeps its own text.
        appendText(block.text, blockIndex)
        continue
      }
      for (const piece of pieces) {
        if (piece.kind === 'text') {
          appendText(piece.source, blockIndex)
          continue
        }
        flushText()
        nodes.push(figureNode({ ref: piece.ref, publication: piece.publication }, options))
      }
      continue
    }
    const child = options.nonText?.(block, blockIndex)
    if (child === undefined || child.length === 0) continue
    flushText()
    nodes.push(...child)
  }
  flushText()
  for (const piece of body.tail) nodes.push(figureNode(piece, options))
  return nodes
}
