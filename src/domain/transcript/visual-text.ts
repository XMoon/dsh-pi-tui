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
 * A block is removed only when ALL THREE hold: it is the tail of a result whose
 * durable `tool/call` names one of the three tools, and its text is the EXACT
 * official machine grammar for that prefix. A prefix alone is never enough —
 * ordinary human prose that happens to start with `visual-v1:` and friends is
 * preserved verbatim, which is what a policy-replaced result can contain.
 *
 * The durable status is deliberately NOT an input: a blocked/replaced result may
 * carry a byte-identical copy of the official content (the `tools/post-execute`
 * block shape), and a human-facing surface must still hide that copy. Status
 * governs whether the content may DRAW, which is a different question answered by
 * `domain/visual/**`.
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

/** The one accepted reference spelling (lowercase hex, exactly 20 digits). */
export const VISUAL_REFERENCE_PATTERN = /^sv1_[0-9a-f]{20}$/u

/** The maximum number of references one official receipt may carry. */
export const MAX_PUBLISHED_VISUALS = 8

/** One parsed official publication receipt. */
export interface OfficialPublicationReceipt {
  readonly version: 1
  readonly published: readonly { readonly ref: string }[]
}

/** Parse exactly `<ref block>`; anything else is human text. */
export function parseOfficialReferenceBlock(text: string): string | undefined {
  if (!text.startsWith(VISUAL_REFERENCE_PREFIX)) return undefined
  const ref = text.slice(VISUAL_REFERENCE_PREFIX.length)
  return VISUAL_REFERENCE_PATTERN.test(ref) ? ref : undefined
}

/** Parse exactly `<fact block>` down to its version/type and field set. */
export function parseOfficialFactBlock(text: string): { readonly type: 'chart' | 'svg' } | undefined {
  if (!text.startsWith(VISUAL_FACT_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(VISUAL_FACT_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return undefined
  const keys = Object.keys(record).sort()
  if (record.type === 'chart') {
    const allowed = ['kind', 'series', 'title', 'type', 'unit', 'version']
    if (!keys.every(key => allowed.includes(key))) return undefined
    if (!keys.includes('kind') || !keys.includes('series') || !keys.includes('title')) return undefined
    return { type: 'chart' }
  }
  if (record.type === 'svg') {
    const allowed = ['bytes', 'description', 'digest', 'title', 'type', 'version']
    if (!keys.every(key => allowed.includes(key))) return undefined
    if (!keys.includes('description') || !keys.includes('digest') || !keys.includes('bytes')) return undefined
    return { type: 'svg' }
  }
  return undefined
}

/** Parse exactly `<receipt block>` with its full official shape. */
export function parseOfficialReceiptBlock(text: string): OfficialPublicationReceipt | undefined {
  if (!text.startsWith(VISUAL_PUBLISHED_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(VISUAL_PUBLISHED_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.published)) return undefined
  if (record.published.length === 0 || record.published.length > MAX_PUBLISHED_VISUALS) return undefined
  const published: { ref: string }[] = []
  for (const entry of record.published) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).length !== 1 || typeof fields.ref !== 'string') return undefined
    if (!VISUAL_REFERENCE_PATTERN.test(fields.ref)) return undefined
    published.push({ ref: fields.ref })
  }
  if (new Set(published.map(entry => entry.ref)).size !== published.length) return undefined
  return { version: 1, published }
}

/**
 * Whether one text is an EXACT official machine block of any kind.
 *
 * Prose that merely starts with a recognized prefix fails this test, which is
 * why a human-facing projection can drop the official tails without risking
 * real content.
 */
export function isOfficialVisualMachineBlock(text: string): boolean {
  return parseOfficialReferenceBlock(text) !== undefined
    || parseOfficialFactBlock(text) !== undefined
    || parseOfficialReceiptBlock(text) !== undefined
}

/**
 * The human-readable projection of one result.
 *
 * Only the three official tools lose their official TAIL machine blocks, and
 * only blocks that pass the exact grammar above. Block POSITION plus the
 * controlled tool name plus that grammar decide identity — never a global
 * string replace — so another tool keeps its full text, and an official tool's
 * ordinary prose that resembles a machine line survives too.
 * @param input - the tool name, the final result blocks (when the row has them)
 *   or its flat text.
 * @returns the human blocks and their joined text.
 */
export function humanFacingVisualResult(input: {
  readonly toolName: string
  readonly blocks: readonly ContentBlock[] | undefined
  readonly text: string
}): { readonly blocks: ContentBlock[]; readonly text: string } {
  const { toolName, blocks, text } = input
  if (!isVisualToolName(toolName)) {
    return { blocks: blocks === undefined ? [{ type: 'text', text }] : [...blocks], text }
  }
  if (blocks === undefined) {
    const lines = text.split('\n')
    let end = lines.length
    while (end > 0 && isOfficialVisualMachineBlock(lines[end - 1] as string)) end -= 1
    const human = lines.slice(0, end).join('\n')
    return { blocks: human === '' ? [] : [{ type: 'text', text: human }], text: human }
  }
  let end = blocks.length
  while (end > 0) {
    const block = blocks[end - 1]
    if (block === undefined || block.type !== 'text' || !isOfficialVisualMachineBlock(block.text)) break
    end -= 1
  }
  const human = blocks.slice(0, end)
  const humanText = human.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { blocks: [...human], text: humanText }
}
