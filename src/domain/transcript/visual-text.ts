/**
 * The one visible-text projection of the visual tool family.
 *
 * The three official visual tools (`dsh_pi_tui_chart`, `dsh_pi_tui_svg`,
 * `present_visual`) put versioned machine blocks in their final result beside
 * the human text. Every human-facing reader — the transcript search corpus, the
 * Tool Card bodies, the TSP result nodes and the `/transcript` readable export —
 * needs the SAME answer to "what may a human see here?", so that answer lives in
 * exactly one place.
 *
 * The module lives under `domain/transcript/**` because the readable projection
 * of a transcript row IS a transcript semantic: it needs no renderer, no Host
 * handle and no Session identity, and both the neutral transcript fold and the
 * visual domain may import it (the reverse edge would make the transcript fold
 * depend on a visual product surface).
 * @module @xmoon76/dsh-pi-tui/domain/transcript/visual-text
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** The generating chart tool. */
export const CHART_TOOL_NAME = 'dsh_pi_tui_chart'

/** The generating SVG tool. */
export const SVG_TOOL_NAME = 'dsh_pi_tui_svg'

/** The publication tool (deliberately NOT namespaced). */
export const PRESENT_VISUAL_TOOL_NAME = 'present_visual'

/** Whether one model tool name is one of the three official visual tools. */
export function isVisualToolName(name: string): boolean {
  return name === CHART_TOOL_NAME || name === SVG_TOOL_NAME || name === PRESENT_VISUAL_TOOL_NAME
}

/** Prefix of the versioned durable visual fact line. */
export const VISUAL_FACT_PREFIX = 'visual-v1:'

/** Prefix of the model-visible stable reference block. */
export const VISUAL_REFERENCE_PREFIX = 'visual-ref-v1:'

/** Prefix of the durable publication receipt block. */
export const VISUAL_PUBLISHED_PREFIX = 'visual-published-v1:'

/** Whether one text starts with any official visual machine prefix. */
export function isVisualMachineText(text: string): boolean {
  return text.startsWith(VISUAL_FACT_PREFIX)
    || text.startsWith(VISUAL_REFERENCE_PREFIX)
    || text.startsWith(VISUAL_PUBLISHED_PREFIX)
}

/**
 * The human-readable projection of one visual tool's final result.
 *
 * Only the three official tools lose their OFFICIAL TAIL machine blocks; block
 * POSITION plus the controlled tool name decide identity, never a global string
 * replace, so another tool whose text merely mentions a machine prefix keeps its
 * full text. Everything before the machine tail (values, description, a failure
 * reason) is preserved verbatim.
 * @param input - the tool name, the final result blocks (when the row has them)
 *   or its flat text, and the durable status.
 * @returns the human blocks and their joined text.
 */
export function humanFacingVisualResult(input: {
  readonly toolName: string
  readonly blocks: readonly ContentBlock[] | undefined
  readonly text: string
  readonly status: 'ok' | 'error' | 'running'
}): { readonly blocks: ContentBlock[]; readonly text: string } {
  const { toolName, blocks, text } = input
  if (!isVisualToolName(toolName)) {
    return { blocks: blocks === undefined ? [{ type: 'text', text }] : [...blocks], text }
  }
  if (blocks === undefined) {
    const lines = text.split('\n')
    let end = lines.length
    while (end > 0 && isVisualMachineText(lines[end - 1] as string)) end -= 1
    const human = lines.slice(0, end).join('\n')
    return { blocks: human === '' ? [] : [{ type: 'text', text: human }], text: human }
  }
  let end = blocks.length
  while (end > 0) {
    const block = blocks[end - 1]
    if (block === undefined || block.type !== 'text' || !isVisualMachineText(block.text)) break
    end -= 1
  }
  const human = blocks.slice(0, end)
  const humanText = human.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { blocks: [...human], text: humanText }
}
