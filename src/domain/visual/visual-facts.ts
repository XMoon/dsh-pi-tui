/**
 * The shared visual-fact machine line: one versioned, strictly parsed line in
 * its own durable TEXT content block. The chart and SVG parsers are the two
 * arms; a renderer parses the FINAL result blocks, never `meta`, arguments or
 * assistant text, so a policy replacement removes the drawing with the line.
 * @module @xmoon76/dsh-pi-tui/domain/visual/visual-facts
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { VISUAL_FACT_PREFIX } from './constants.ts'
import { parseChartFact, type ChartFact } from './chart.ts'
import { parseSvgFact, type SvgFact } from './svg.ts'

/** The two v1 visual facts. */
export type VisualFact = ChartFact | SvgFact

/** Serialize one fact as the durable machine line. */
export function visualFactLine(fact: VisualFact): string {
  return `${VISUAL_FACT_PREFIX}${JSON.stringify(fact)}`
}

/** Parse one machine line; unknown or malformed lines are not facts. */
export function parseVisualFactLine(text: string): VisualFact | undefined {
  if (!text.startsWith(VISUAL_FACT_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(VISUAL_FACT_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const type = (parsed as { type?: unknown }).type
  if (type === 'chart') return parseChartFact(parsed)
  if (type === 'svg') return parseSvgFact(parsed)
  return undefined
}

/** One result's human blocks and at most one visual fact. */
export interface VisualParts {
  /** Every non-machine block, in order (the readable result body). */
  readonly human: ContentBlock[]
  /** The parsed fact, or undefined when absent/duplicated/malformed. */
  readonly fact: VisualFact | undefined
  /** The joined human text (blank lines preserved). */
  readonly humanText: string
}

/** Split one final result's blocks into human blocks and the machine fact. */
export function visualParts(blocks: readonly ContentBlock[]): VisualParts {
  const human: ContentBlock[] = []
  let fact: VisualFact | undefined
  let machineSeen = false
  for (const block of blocks) {
    if (block.type === 'text' && block.text.startsWith(VISUAL_FACT_PREFIX)) {
      if (machineSeen) {
        // More than one machine line is not a fact its producer could emit;
        // refuse to pick one rather than draw a stale/ambiguous graphic.
        machineSeen = true
        fact = undefined
        continue
      }
      machineSeen = true
      fact = parseVisualFactLine(block.text)
      continue
    }
    human.push(block)
  }
  const text = human
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return { human, fact, humanText: text }
}

/**
 * The flat-text fallback: older/synthetic rows may carry the joined result
 * string instead of `resultBlocks`. Split the machine line(s) out line-wise so
 * a malformed fact can never leak its JSON into the card body.
 * @param result - the joined durable result text.
 * @returns the same parts shape as {@link visualParts}.
 */
export function visualPartsFromText(result: string): VisualParts {
  let fact: VisualFact | undefined
  let machineSeen = false
  const humanLines: string[] = []
  for (const line of result.split('\n')) {
    if (!line.startsWith(VISUAL_FACT_PREFIX)) {
      humanLines.push(line)
      continue
    }
    if (machineSeen) {
      machineSeen = true
      fact = undefined
      continue
    }
    machineSeen = true
    fact = parseVisualFactLine(line)
  }
  const humanText = humanLines.join('\n').replace(/\n+$/u, '')
  return {
    human: humanText === '' ? [] : [{ type: 'text', text: humanText }],
    fact,
    humanText,
  }
}
