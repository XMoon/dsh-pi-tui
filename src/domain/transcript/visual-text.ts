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

/**
 * The official serializers' own value bounds.
 *
 * These mirror `domain/visual/constants.ts`. They are duplicated here rather
 * than imported because `domain/transcript/**` may only import its own subtree
 * (the architecture gate is closed-world there). They serve ONE purpose: the
 * readable projection must refuse a machine-SHAPED line that the official
 * serializer could not have produced. Drawing semantics and every budget that
 * governs admission stay owned by `domain/visual/**`.
 */
const FACT_LIMITS = {
  chartMaxPoints: 12,
  chartMaxTitleCodePoints: 100,
  chartMaxUnitCodePoints: 32,
  chartMaxLabelCodePoints: 48,
  svgMaxSourceBytes: 128 * 1024,
  svgMaxTitleCodePoints: 100,
  svgMaxDescriptionCodePoints: 500,
} as const

const CHART_KINDS: ReadonlySet<string> = new Set(['bars', 'spark'])
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * Whether one string is a NON-EMPTY string within the official code-point
 * budget.
 *
 * This deliberately mirrors the official serializers' rule EXACTLY: they reject
 * the empty string, never a whitespace-only one (`chartCoreProblem` accepts
 * `unit: " "` and `label: " "`, and `svgArgsShapeProblem` uses `trim()` only for
 * the title/description it requires to be meaningful). A filter that were
 * stricter than the serializer would fail to recognise a fact the tool really
 * produced and leak the machine line into human-facing output.
 */
/**
 * Whether one string is a MEANINGFUL bounded text.
 *
 * The chart title and the SVG title/description are the official serializers'
 * `trim() !== ''` fields, so they keep the stricter rule.
 */
function isOfficialMeaningfulText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim() !== '' && codePointLength(value) <= max
}

function isOfficialNonEmptyText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value !== '' && codePointLength(value) <= max
}

/**
 * Parse exactly `<fact block>` down to a fully valid official fact.
 *
 * The line must satisfy the official serializer's own value rules — the chart
 * kind enum, the ordered series of finite numbered points with non-empty
 * bounded labels, the bounded title/unit, the SVG's 64-hex digest and bounded
 * credential — so ordinary prose that merely carries the right KEY SETS is not
 * mistaken for a machine block.
 * @param text - one result block's text.
 * @returns the fact type when the line is a valid official fact.
 */
export function parseOfficialFactBlock(text: string): { readonly type: 'chart' | 'svg' } | undefined {
  if (!text.startsWith(VISUAL_FACT_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(VISUAL_FACT_PREFIX.length))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined
  if (parsed.type === 'chart') {
    if (!hasOnlyKeys(parsed, ['version', 'type', 'kind', 'title', 'unit', 'series'])) return undefined
    if (typeof parsed.kind !== 'string' || !CHART_KINDS.has(parsed.kind)) return undefined
    if (!isOfficialMeaningfulText(parsed.title, FACT_LIMITS.chartMaxTitleCodePoints)) return undefined
    if (parsed.unit !== undefined && !isOfficialNonEmptyText(parsed.unit, FACT_LIMITS.chartMaxUnitCodePoints)) return undefined
    if (!Array.isArray(parsed.series)) return undefined
    const series = parsed.series as unknown[]
    if (series.length < 2 || series.length > FACT_LIMITS.chartMaxPoints) return undefined
    for (const point of series) {
      if (!isRecord(point) || !hasOnlyKeys(point, ['label', 'value'])) return undefined
      if (!isOfficialNonEmptyText(point.label, FACT_LIMITS.chartMaxLabelCodePoints)) return undefined
      if (typeof point.value !== 'number' || !Number.isFinite(point.value)) return undefined
    }
    return { type: 'chart' }
  }
  if (parsed.type === 'svg') {
    if (!hasOnlyKeys(parsed, ['version', 'type', 'title', 'description', 'digest', 'bytes'])) return undefined
    if (!isOfficialMeaningfulText(parsed.title, FACT_LIMITS.svgMaxTitleCodePoints)) return undefined
    if (!isOfficialMeaningfulText(parsed.description, FACT_LIMITS.svgMaxDescriptionCodePoints)) return undefined
    if (typeof parsed.digest !== 'string' || !DIGEST_PATTERN.test(parsed.digest)) return undefined
    if (typeof parsed.bytes !== 'number' || !Number.isSafeInteger(parsed.bytes)) return undefined
    if (parsed.bytes < 0 || parsed.bytes > FACT_LIMITS.svgMaxSourceBytes) return undefined
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
 * The length of the official machine-block SUFFIX this exact tool can produce.
 *
 * Each tool has one canonical tail composition, and a result carries at most
 * that composition:
 *
 * - a generator: optionally one `visual-ref-v1` block immediately followed by
 *   one `visual-v1` fact block of the MATCHING type, or the fact block alone
 *   (the reference is only projected for a root call inside an open step);
 * - the publication tool: one `visual-published-v1` receipt block.
 *
 * Suffix entries are validated as a SEQUENCE, not independently: a reference
 * after the fact, a second reference, a second fact, or a reference without a
 * fact is not something the official serializer can emit, so those blocks stay
 * human text.
 * @param toolName - the durable `tool/call` name.
 * @param texts - the result's text blocks, in order.
 * @returns how many TRAILING blocks are official machine blocks (0 when none).
 */
export function officialMachineSuffixLength(toolName: string, texts: readonly string[]): number {
  const last = texts[texts.length - 1]
  if (last === undefined) return 0
  if (toolName === PRESENT_VISUAL_TOOL_NAME) {
    if (parseOfficialReceiptBlock(last) === undefined) return 0
    // The publication tool emits exactly ONE receipt; a second one before it
    // means this is not the official tail.
    const before = texts[texts.length - 2]
    if (before !== undefined && parseOfficialReceiptBlock(before) !== undefined) return 0
    return 1
  }
  const expectedType = toolName === CHART_TOOL_NAME ? 'chart' : toolName === SVG_TOOL_NAME ? 'svg' : undefined
  if (expectedType === undefined) return 0
  if (parseOfficialFactBlock(last)?.type === expectedType) {
    const before = texts[texts.length - 2]
    if (before !== undefined && parseOfficialReferenceBlock(before) !== undefined) {
      // Exactly one reference may precede the fact; a SECOND machine-looking
      // block before it means this is not the projected composition.
      const beforeThat = texts[texts.length - 3]
      if (beforeThat !== undefined && parseOfficialReferenceBlock(beforeThat) !== undefined) return 0
      if (beforeThat !== undefined && parseOfficialFactBlock(beforeThat) !== undefined) return 0
      return 2
    }
    // A machine-looking block before a FACT-only tail means the fact is not the
    // single official fact of this result.
    if (before !== undefined && parseOfficialFactBlock(before) !== undefined) return 0
    return 1
  }
  return 0
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
    const trimmed = officialMachineSuffixLength(toolName, lines)
    const human = lines.slice(0, lines.length - trimmed).join('\n')
    return { blocks: human === '' ? [] : [{ type: 'text', text: human }], text: human }
  }
  const texts: string[] = []
  for (const block of blocks) if (block.type === 'text') texts.push(block.text)
  const trimmed = officialMachineSuffixLength(toolName, texts)
  // Map the text-level suffix back to block indices: only TRAILING text blocks
  // participate, so a machine block before another block is never stripped.
  let remaining = trimmed
  let end = blocks.length
  while (remaining > 0 && end > 0) {
    const block = blocks[end - 1]
    if (block === undefined) break
    end -= 1
    if (block.type === 'text') remaining -= 1
    else {
      // A trailing non-text block breaks the official suffix: give the text
      // blocks back as human content.
      end = blocks.length
      break
    }
  }
  const human = blocks.slice(0, end)
  const humanText = human.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { blocks: [...human], text: humanText }
}
