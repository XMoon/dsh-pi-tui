/**
 * The ONE pure placement planner for Assistant-owned published visuals.
 *
 * A published chart/SVG becomes part of an eligible final Assistant only
 * through an explicit Markdown reference definition
 * (`[dsh-visual-sv1_…]: <#>`). This module turns the Assistant's original
 * ContentBlock text plus the PR1-qualified `PublishedVisual[]` into ONE
 * ordered source-span projection: text slices and visual occurrences, in the
 * exact original UTF-16 coordinates, with the marker text consumed and every
 * other byte preserved. It also collects the ordinary link definitions of each
 * continuous text run so a display-only definitions prefix can keep
 * cross-segment reference links resolvable without rewriting the source.
 *
 * The parser is deliberately layered and fail-closed:
 *
 * 1. the original text is scanned ONLY to propose strict marker lines;
 * 2. marked (the renderer's own dependency version) lexes the normalized run;
 * 3. every proposal must match a top-level `def` token by label, exact `<#>`
 *    destination and normalized source position;
 * 4. text pieces are built from `source.slice()` and independently verified by
 *    byte recovery before they leave this module.
 *
 * No renderer state (width, theme, focus, TSP, TUI canvas) enters the plan.
 * @module @xmoon76/dsh-pi-tui/domain/visual/placement
 */

import { Marked, type Token } from 'marked'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PublishedVisual } from './publication.ts'

/** The strict marker label prefix. */
const MARKER_LABEL_PREFIX = 'dsh-visual-'

/** The strict marker line: column 0, exact label, exact `<#>` destination. */
const MARKER_LINE_PATTERN = /^\[dsh-visual-(sv1_[0-9a-f]{20})\]: <#>$/u

/**
 * The block-level visual label shape. A definition with this shape is NEVER
 * injected into the display-only shared-definition prefix, whether or not it
 * is published: the marker line must keep its own Markdown definition
 * semantics in the source.
 */
const VISUAL_LABEL_PATTERN = /^dsh-visual-sv1_[0-9a-f]{20}$/u

/**
 * One text slice of the original answer. `start`/`end` are UTF-16 offsets
 * inside `ContentBlock.text` at `blockIndex` (end exclusive) and `source` is
 * exactly `originalText.slice(start, end)`.
 */
export interface TextPiece {
  readonly kind: 'text'
  readonly blockIndex: number
  readonly start: number
  readonly end: number
  readonly source: string
}

/** One published visual inserted at its marker or appended to the answer tail. */
export interface VisualPiece {
  readonly kind: 'visual'
  readonly ref: string
  readonly publication: PublishedVisual
  /** The owning text block for an inline marker; null for a tail visual. */
  readonly blockIndex: number | null
  /** Original block-local marker span (text only — no line terminator). */
  readonly markerStart?: number
  readonly markerEnd?: number
  readonly placement: 'inline' | 'tail'
}

/** The single ordered source projection consumed by the renderer. */
export type PlacementPiece = TextPiece | VisualPiece

/**
 * The display-only shared-definition context of ONE continuous text run.
 *
 * `prefix` is prepended only when the run is rendered; it never enters the
 * session, the transcript corpus, search or any export. The block indexes let
 * the renderer map every TextPiece back to its run without a second partition.
 */
export interface SharedDefinitionsContext {
  readonly runIndex: number
  readonly blockIndexes: readonly number[]
  readonly prefix: string
}

/** The planner output: the ordered pieces plus the per-run definition context. */
export interface VisualPlacement {
  readonly pieces: readonly PlacementPiece[]
  readonly definitions: readonly SharedDefinitionsContext[]
}

/** Planner input: the eligible Assistant's raw body and its published refs. */
export interface PlanVisualPlacementInput {
  /** The Assistant's flat text (already the authoritative fallback body). */
  readonly text: string
  /** The ordered ContentBlocks when the settled message carried any. */
  readonly content?: readonly ContentBlock[]
  /** PR1-qualified publications for this Assistant's turn, in durable order. */
  readonly publications: readonly PublishedVisual[]
}

/** One original text block of the Assistant body. */
interface RawTextBlock {
  readonly blockIndex: number
  readonly text: string
}

/** One continuous Markdown run: adjacent text blocks not separated by a
 * rendered non-text block. */
interface TextRun {
  readonly runIndex: number
  readonly blocks: readonly RawTextBlock[]
  readonly raw: string
  readonly blockStarts: readonly { readonly blockIndex: number; readonly start: number; readonly end: number }[]
}

/** Normalized text plus its exact raw-boundary mapping. */
interface NormalizedText {
  readonly normalized: string
  /** normalized boundary -> raw boundary. */
  readonly rawBoundaryOf: readonly number[]
  /** Whether the normalized boundary corresponds to a real raw boundary
   * (false inside a tab expansion). */
  readonly exactBoundary: readonly boolean[]
}

/** One lexer token located in the normalized source. */
interface LocatedToken {
  readonly token: Token
  readonly start: number
  readonly end: number
}

/** One top-level definition located in the normalized source. */
interface LocatedDefinition {
  readonly token: Token & { readonly type: 'def' }
  /** Trimmed raw definition text (no trailing line terminator). */
  readonly rawText: string
  /** Raw line-start boundary, present only when the token was fully located. */
  readonly rawStart: number | undefined
  /** Raw marker-text end boundary (same as rawStart when unavailable). */
  readonly rawEnd: number | undefined
}

/** One strict marker-line proposal from the original text. */
interface MarkerCandidate {
  readonly runIndex: number
  readonly ref: string
  readonly blockIndex: number
  readonly start: number
  readonly end: number
  /** The same line's start offset inside the run document. */
  readonly runStart: number
}

/** The renderer's own Marked version. Block `def` grammar is the default
 * grammar; the vendored inline extensions never change a top-level
 * definition's recognition. */
const LEXER = new Marked()

/** The ordered ContentBlocks of one Assistant body. */
function blocksOf(input: PlanVisualPlacementInput): readonly ContentBlock[] {
  if (input.content !== undefined && input.content.length > 0) return input.content
  return input.text === '' ? [] : [{ type: 'text', text: input.text }]
}

/** Partition the Assistant body into continuous Markdown text runs. */
function textRunsOf(blocks: readonly ContentBlock[]): TextRun[] {
  const runs: TextRun[] = []
  let current: RawTextBlock[] = []
  const finish = (): void => {
    if (current.length === 0) return
    const raw = current.map(block => block.text).join('')
    const blockStarts: { blockIndex: number; start: number; end: number }[] = []
    let offset = 0
    for (const block of current) {
      blockStarts.push({ blockIndex: block.blockIndex, start: offset, end: offset + block.text.length })
      offset += block.text.length
    }
    runs.push({ runIndex: runs.length, blocks: current, raw, blockStarts })
    current = []
  }
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type === 'text') {
      current.push({ blockIndex, text: block.text })
      continue
    }
    if (block.type === 'reasoning' || block.type === 'tool-call') {
      // The existing Assistant body never paints these and does not flush a
      // Markdown run around them.
      continue
    }
    // A rendered non-text block ends the Markdown document; the next text
    // block starts a new run with its own definition context.
    finish()
  }
  finish()
  return runs
}

/**
 * Normalize one run exactly the way the vendored PiTui Markdown does before
 * parsing (`\t` → three spaces) while recording every boundary. CRLF is kept
 * as-is: the lexer normalizes it internally, and the raw text remains the only
 * source of the emitted pieces.
 */
function normalizeForMarkedWithOffsets(raw: string): NormalizedText {
  let normalized = ''
  const rawBoundaryOf: number[] = [0]
  const exactBoundary: boolean[] = [true]
  for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
    const character = raw[rawIndex] as string
    const replacement = character === '\t' ? '   ' : character
    for (let index = 0; index < replacement.length; index += 1) {
      normalized += replacement[index]
      const last = index === replacement.length - 1
      rawBoundaryOf.push(last ? rawIndex + 1 : rawIndex)
      exactBoundary.push(last || character !== '\t')
    }
  }
  return { normalized, rawBoundaryOf, exactBoundary }
}

/** Match one lexer raw string at a normalized source index. Marked strips CR
 * from `\r\n`, so a raw `\n` may consume a normalized `\r\n`. */
function matchTokenRawAt(source: string, index: number, raw: string): number | undefined {
  let cursor = index
  for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
    const expected = raw[rawIndex] as string
    if (expected === '\n') {
      if (source[cursor] === '\r' && source[cursor + 1] === '\n') {
        cursor += 2
      } else if (source[cursor] === '\n') {
        cursor += 1
      } else {
        return undefined
      }
      continue
    }
    if (source[cursor] !== expected) return undefined
    cursor += 1
  }
  return cursor
}

/** Locate every token in source order. A token that cannot be found in order
 * marks the whole location pass unreliable (`undefined`); markers then fail
 * closed while ordinary definitions may still be used for display context. */
function locateTokens(normalized: string, tokens: readonly Token[]): LocatedToken[] | undefined {
  const located: LocatedToken[] = []
  let cursor = 0
  for (const token of tokens) {
    let match: { start: number; end: number } | undefined
    for (let index = cursor; index <= normalized.length; index += 1) {
      const end = matchTokenRawAt(normalized, index, token.raw)
      if (end !== undefined) {
        match = { start: index, end }
        break
      }
    }
    if (match === undefined) return undefined
    located.push({ token, start: match.start, end: match.end })
    cursor = match.end
  }
  return located
}

/** The definition raw text without the line terminator the lexer may have
 * included when the definition was followed immediately by another block. */
function trimmedDefinitionRaw(raw: string): string {
  if (raw.endsWith('\r\n')) return raw.slice(0, -2)
  if (raw.endsWith('\n')) return raw.slice(0, -1)
  return raw
}

/** Collect the top-level definition tokens of one run. */
function locatedDefinitions(tokens: readonly Token[], located: readonly LocatedToken[] | undefined): LocatedDefinition[] {
  const byToken = new Map<Token, LocatedToken>()
  if (located !== undefined) for (const entry of located) byToken.set(entry.token, entry)
  const definitions: LocatedDefinition[] = []
  for (const token of tokens) {
    if (token.type !== 'def') continue
    const definition = token as Token & { readonly type: 'def' }
    const position = byToken.get(token)
    definitions.push({
      token: definition,
      rawText: trimmedDefinitionRaw(definition.raw),
      rawStart: position === undefined ? undefined : position.start,
      rawEnd: position === undefined ? undefined : position.end,
    })
  }
  return definitions
}

/** Map one normalized boundary to its exact raw boundary, or undefined when
 * the boundary falls inside a tab expansion. */
function exactRawBoundary(normalization: NormalizedText, normalizedIndex: number): number | undefined {
  if (normalization.exactBoundary[normalizedIndex] !== true) return undefined
  return normalization.rawBoundaryOf[normalizedIndex]
}

/** Scan one original text block for strict marker-line proposals. */
function markerCandidatesOf(
  runIndex: number,
  block: RawTextBlock,
  runStartOfBlock: number,
  out: MarkerCandidate[],
): void {
  const text = block.text
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline
    // A CRLF terminator is the only place a trailing CR is an EOL byte; a
    // lone CR at EOF is NOT an accepted line ending.
    const contentEnd = newline >= 0 && lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
    const line = text.slice(lineStart, contentEnd)
    const match = MARKER_LINE_PATTERN.exec(line)
    if (match !== null) {
      out.push({
        runIndex,
        ref: match[1] as string,
        blockIndex: block.blockIndex,
        start: lineStart,
        end: contentEnd,
        runStart: runStartOfBlock + lineStart,
      })
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
}

/** The ordinary top-level definitions of one run, serialized as the
 * display-only prefix. Visual marker labels never enter the prefix. Marked
 * already suppresses later duplicate labels (its first-wins grammar), so the
 * token order IS the source first-wins order. */
function sharedDefinitionsPrefix(definitions: readonly LocatedDefinition[]): string {
  const lines: string[] = []
  for (const definition of definitions) {
    const tag = definition.token.tag
    // Exclude ONLY an exact visual marker definition. A visual-label-shaped
    // definition with a different destination or title is an ordinary link
    // definition and must keep resolving across segments.
    const exactMarker = VISUAL_LABEL_PATTERN.test(tag)
      && definition.token.href === '#'
      && definition.rawText === `[${tag}]: <#>`
    if (exactMarker) continue
    lines.push(definition.rawText)
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`
}

/** Whether one definition token is the same semantic marker the candidate
 * proposed: exact label, exact `<#>` destination and exact original line. */
function isMarkerDefinition(
  definition: LocatedDefinition,
  candidate: MarkerCandidate,
  normalization: NormalizedText,
): boolean {
  if (definition.rawStart === undefined) return false
  const rawStart = exactRawBoundary(normalization, definition.rawStart)
  if (rawStart === undefined) return false
  if (rawStart !== candidate.runStart) return false
  if (definition.token.tag !== `${MARKER_LABEL_PREFIX}${candidate.ref}`) return false
  if (definition.token.href !== '#') return false
  return definition.rawText === `[dsh-visual-${candidate.ref}]: <#>`
}

/** A consumed marker span inside one text block. */
interface ConsumedMarker {
  readonly piece: VisualPiece
  readonly start: number
  readonly end: number
}

/** Build the text/visual pieces of one text block around its consumed markers. */
function piecesOfBlock(
  block: RawTextBlock,
  markers: readonly ConsumedMarker[],
): PlacementPiece[] {
  const pieces: PlacementPiece[] = []
  let cursor = 0
  for (const marker of markers) {
    pieces.push({
      kind: 'text',
      blockIndex: block.blockIndex,
      start: cursor,
      end: marker.start,
      source: block.text.slice(cursor, marker.start),
    })
    pieces.push(marker.piece)
    cursor = marker.end
  }
  pieces.push({
    kind: 'text',
    blockIndex: block.blockIndex,
    start: cursor,
    end: block.text.length,
    source: block.text.slice(cursor),
  })
  return pieces
}

/** Reconstruct every text block from the plan and compare it with the
 * independent "original text minus consumed markers" baseline. */
function verifyByteRecovery(
  blocks: readonly ContentBlock[],
  pieces: readonly PlacementPiece[],
): void {
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type !== 'text') continue
    const blockPieces = pieces.filter(piece => piece.blockIndex === blockIndex || piece.kind === 'text' && piece.blockIndex === blockIndex)
    let reconstructed = ''
    let expected = ''
    let expectedCursor = 0
    for (const piece of blockPieces) {
      if (piece.kind === 'text') {
        if (piece.source !== block.text.slice(piece.start, piece.end)) {
          throw new Error(`visual placement source recovery failed in block ${blockIndex}`)
        }
        reconstructed += piece.source
        continue
      }
      const start = piece.markerStart
      const end = piece.markerEnd
      if (start === undefined || end === undefined || start < expectedCursor || end < start) {
        throw new Error(`visual placement marker span recovery failed in block ${blockIndex}`)
      }
      expected += block.text.slice(expectedCursor, start)
      expectedCursor = end
    }
    expected += block.text.slice(expectedCursor)
    if (reconstructed !== expected) {
      throw new Error(`visual placement text recovery failed in block ${blockIndex}`)
    }
  }
}

/**
 * Plan the placement of one eligible Assistant's published visuals.
 *
 * The result is the single ordered `text | visual` sequence the renderer
 * consumes; every text piece is an exact slice of the original ContentBlock
 * text, every marker is consumed only when the full-document lexer recognized
 * it as an exact top-level definition, and every unconsumed published ref is
 * appended once at the tail in first-publication order.
 * @param input - the raw Assistant body and its qualified publications.
 * @returns the ordered pieces and per-run display-only definitions context.
 */
export function planVisualPlacement(input: PlanVisualPlacementInput): VisualPlacement {
  const blocks = blocksOf(input)
  const runs = textRunsOf(blocks)
  const publishedByRef = new Map<string, PublishedVisual>()
  for (const publication of input.publications) {
    if (!publishedByRef.has(publication.ref)) publishedByRef.set(publication.ref, publication)
  }
  const consumedRefs = new Set<string>()
  const tailRefs = new Set<string>()
  const markersByBlock = new Map<number, ConsumedMarker[]>()
  const definitions: SharedDefinitionsContext[] = []
  const candidates: MarkerCandidate[] = []

  for (const run of runs) {
    const normalization = normalizeForMarkedWithOffsets(run.raw)
    const tokens = LEXER.lexer(normalization.normalized) as Token[]
    const located = locateTokens(normalization.normalized, tokens)
    const definitionsOfRun = locatedDefinitions(tokens, located)
    definitions.push({
      runIndex: run.runIndex,
      blockIndexes: run.blocks.map(block => block.blockIndex),
      prefix: sharedDefinitionsPrefix(definitionsOfRun),
    })
    if (located === undefined) continue
    const runStartByBlock = new Map(run.blockStarts.map(entry => [entry.blockIndex, entry.start]))
    for (const block of run.blocks) {
      markerCandidatesOf(run.runIndex, block, runStartByBlock.get(block.blockIndex) ?? 0, candidates)
    }
    // Consume only proposals backed by a top-level definition token. The
    // candidate order over the whole answer is the original block/line order,
    // which also makes first-wins deterministic across runs.
    for (const definition of definitionsOfRun) {
      if (definition.rawStart === undefined) continue
      const definitionStart = exactRawBoundary(normalization, definition.rawStart)
      if (definitionStart === undefined) continue
      const candidate = candidates.find(entry =>
        entry.runIndex === run.runIndex
        && entry.runStart === definitionStart
        && !consumedRefs.has(entry.ref)
        && publishedByRef.has(entry.ref)
        && isMarkerDefinition(definition, entry, normalization))
      if (candidate === undefined) continue
      const publication = publishedByRef.get(candidate.ref)
      if (publication === undefined) continue
      consumedRefs.add(candidate.ref)
      const blockPieces = markersByBlock.get(candidate.blockIndex) ?? []
      blockPieces.push({
        piece: {
          kind: 'visual',
          ref: candidate.ref,
          publication,
          blockIndex: candidate.blockIndex,
          markerStart: candidate.start,
          markerEnd: candidate.end,
          placement: 'inline',
        },
        start: candidate.start,
        end: candidate.end,
      })
      markersByBlock.set(candidate.blockIndex, blockPieces)
    }
  }

  const pieces: PlacementPiece[] = []
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type !== 'text') continue
    const markers = (markersByBlock.get(blockIndex) ?? [])
      .slice()
      .sort((left, right) => left.start - right.start)
    pieces.push(...piecesOfBlock({ blockIndex, text: block.text }, markers))
  }
  for (const publication of input.publications) {
    if (consumedRefs.has(publication.ref) || tailRefs.has(publication.ref)) continue
    tailRefs.add(publication.ref)
    pieces.push({
      kind: 'visual',
      ref: publication.ref,
      publication,
      blockIndex: null,
      placement: 'tail',
    })
  }
  verifyByteRecovery(blocks, pieces)
  return { pieces, definitions }
}
