/**
 * The ONE display-only visible-text projection consumed by `/copy`.
 *
 * A published chart/SVG is placed in the Assistant body by consuming its exact
 * Markdown marker line (`planVisualPlacement`). The model-facing transcript and
 * the raw `/transcript` export keep that marker byte for byte; `/copy` is a
 * DISPLAY sink, so it copies what the user actually reads — the original text
 * spans with the consumed marker lines removed and no visual glyph or raster
 * reconstructed as text.
 *
 * This module reuses the SAME planner the renderer uses; it never parses the
 * marker grammar a second time and never rewrites the source. Every emitted
 * byte is a slice of the original `ContentBlock.text`: line terminators,
 * whitespace, CJK, emoji, tabs, ordinary definitions and code samples survive
 * untouched, and the display-only shared-definition prefix is never injected.
 *
 * Pure derivation: no Session, no Host, no I/O, no state.
 * @module @xmoon76/dsh-pi-tui/domain/visual/display-copy
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { planVisualPlacement } from './placement.ts'
import type { PublishedVisual } from './publication.ts'

/** One Assistant answer and the publications already qualified for its turn. */
export interface VisibleAssistantTextInput {
  /** The Assistant's flat text (the authoritative no-content fallback). */
  readonly text: string
  /** The ordered settled ContentBlocks when the message carried any. */
  readonly content?: readonly ContentBlock[]
  /** PR1-qualified publications of this Assistant's turn, in durable order. */
  readonly publications: readonly PublishedVisual[]
}

/**
 * Project the Assistant's visible text for the clipboard.
 *
 * With no publications the original flat text is returned unchanged — the
 * planner is not consulted, so a marker-shaped string that was never published
 * can never be removed. With publications the planner's ordered pieces are
 * joined: only text-piece `source` spans enter the result, so consumed markers
 * disappear while every other byte keeps its original position.
 * @param input - the answer text/content and its qualified publications.
 * @returns the exact display-only copy payload.
 */
export function visibleAssistantTextForCopy(input: VisibleAssistantTextInput): string {
  if (input.publications.length === 0) return input.text
  const plan = planVisualPlacement({
    text: input.text,
    ...(input.content === undefined ? {} : { content: input.content }),
    publications: input.publications,
  })
  let visible = ''
  for (const piece of plan.pieces) {
    if (piece.kind === 'text') visible += piece.source
  }
  return visible
}
