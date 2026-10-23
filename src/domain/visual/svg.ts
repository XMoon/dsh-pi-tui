/**
 * The canonical SVG fact, its digest credential, and the render-time
 * authorization shared by the TSP and PiTui paths.
 *
 * The SVG SOURCE lives in the durable `tool/call.arguments` (the model wrote
 * it); the tool result carries only a short credential: title, description,
 * source digest and byte count. A renderer may draw the source only when the
 * FINAL result content still carries a well-formed credential whose digest
 * matches the call arguments AND the source passes the admission gate. A
 * content-only policy replacement therefore removes the drawing; a value
 * replacement that changes the digest degrades to text. This never restores a
 * graphic from `meta` (the tool declares none).
 * @module @xmoon76/dsh-pi-tui/domain/visual/svg
 */

import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  SVG_MAX_DESCRIPTION_CODE_POINTS,
  SVG_MAX_SOURCE_BYTES,
  SVG_MAX_TITLE_CODE_POINTS,
  VISUAL_FACT_PREFIX,
} from './constants.ts'
import { codePointLength } from './chart.ts'
import { admitSvg, type SvgAdmission, type SvgAdmissionOk } from './svg-admission.ts'

/** The canonical SVG fact carried by the tool result's machine line. */
export interface SvgFact {
  readonly version: 1
  readonly type: 'svg'
  readonly title: string
  readonly description: string
  /** Lowercase hex SHA-256 of the admitted source's UTF-8 bytes. */
  readonly digest: string
  readonly bytes: number
}

/** The raw SVG tool arguments. */
export interface SvgArgs {
  readonly title: string
  readonly description: string
  readonly svg: string
}

const SVG_ARGS_KEYS = ['title', 'description', 'svg'] as const
const SVG_FACT_KEYS = ['version', 'type', 'title', 'description', 'digest', 'bytes'] as const
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

/** Lowercase hex SHA-256 of one source string's UTF-8 bytes. */
export function svgDigest(source: string): string {
  return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')
}

/** Validate the shape and field budgets of SVG arguments (no admission). */
export function svgArgsShapeProblem(args: unknown): string | undefined {
  if (!isRecord(args) || !hasOnlyKeys(args, SVG_ARGS_KEYS)) return 'arguments must contain only title, description and svg'
  const { title, description, svg } = args
  if (typeof title !== 'string' || title.trim() === '' || codePointLength(title) > SVG_MAX_TITLE_CODE_POINTS) {
    return `title must be a non-empty string of at most ${SVG_MAX_TITLE_CODE_POINTS} Unicode code points`
  }
  if (typeof description !== 'string' || description.trim() === '' || codePointLength(description) > SVG_MAX_DESCRIPTION_CODE_POINTS) {
    return `description must be a non-empty string of at most ${SVG_MAX_DESCRIPTION_CODE_POINTS} Unicode code points`
  }
  if (typeof svg !== 'string' || svg.trim() === '') return 'svg must be a non-empty standalone SVG document'
  return undefined
}

/** Validate SVG arguments including the admission gate (the tool boundary). */
export function svgArgsProblem(args: unknown): string | undefined {
  const shape = svgArgsShapeProblem(args)
  if (shape !== undefined) return shape
  const { svg } = args as SvgArgs
  const admission = admitSvg(svg)
  return admission.ok ? undefined : `SVG rejected: ${admission.reason}`
}

/** Build the canonical fact from already-admitted arguments. */
export function svgFactFromArgs(args: SvgArgs): SvgFact {
  const bytes = Buffer.byteLength(args.svg, 'utf8')
  return {
    version: 1,
    type: 'svg',
    title: args.title,
    description: args.description,
    digest: svgDigest(args.svg),
    bytes,
  }
}

/** Strict parse of one durable machine-line fact. */
export function parseSvgFact(value: unknown): SvgFact | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, SVG_FACT_KEYS)) return undefined
  if (value.version !== 1 || value.type !== 'svg') return undefined
  const { title, description, digest, bytes } = value
  if (typeof title !== 'string' || title.trim() === '' || codePointLength(title) > SVG_MAX_TITLE_CODE_POINTS) return undefined
  if (typeof description !== 'string' || description.trim() === '' || codePointLength(description) > SVG_MAX_DESCRIPTION_CODE_POINTS) return undefined
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) return undefined
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > SVG_MAX_SOURCE_BYTES) return undefined
  return { version: 1, type: 'svg', title, description, digest, bytes }
}

/** Parse the raw call arguments for the renderers. */
export function parseSvgArgs(argsRaw: string): SvgArgs | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return undefined
  }
  if (svgArgsShapeProblem(parsed) !== undefined) return undefined
  const { title, description, svg } = parsed as SvgArgs
  return { title, description, svg }
}

/** The durable, self-contained human text. */
export function svgHumanText(fact: SvgFact): string {
  return [fact.title, fact.description, 'SVG source available in the expanded tool call'].join('\n')
}

/** The card-body detail rows (the card header already shows the title). */
export function svgDetailRows(fact: SvgFact): string[] {
  return [fact.description, 'SVG source available in the expanded tool call']
}

/** The durable content blocks: readable text plus the credential line. */
export function svgContentBlocks(fact: SvgFact): ContentBlock[] {
  return [
    { type: 'text', text: svgHumanText(fact) },
    { type: 'text', text: `${VISUAL_FACT_PREFIX}${JSON.stringify(fact)}` },
  ]
}

/** The render-time authorization verdict. */
export type SvgAuthorization =
  | { readonly state: 'ready'; readonly source: string; readonly fact: SvgFact; readonly admission: SvgAdmissionOk }
  | { readonly state: 'text'; readonly reason: string }

/**
 * Authorize one SVG drawing from the FINAL result blocks plus the call args.
 * @param argsRaw - the durable raw call arguments.
 * @param resultBlocks - the final result content blocks (after policy).
 * @param admit - the admission implementation (callers may pass a cached one).
 * @returns ready with the admitted source, or a text-fallback reason.
 */
export function authorizeSvg(
  argsRaw: string,
  resultBlocks: readonly ContentBlock[] | undefined,
  admit: (source: string) => SvgAdmission = admitSvg,
): SvgAuthorization {
  const args = parseSvgArgs(argsRaw)
  if (args === undefined) return { state: 'text', reason: 'SVG call arguments are not readable' }
  const fact = resultFact(resultBlocks)
  if (fact === undefined) return { state: 'text', reason: 'SVG result credential is missing' }
  if (fact.digest !== svgDigest(args.svg) || fact.bytes !== Buffer.byteLength(args.svg, 'utf8')) {
    return { state: 'text', reason: 'SVG result credential does not match the call source' }
  }
  const admission = admit(args.svg)
  if (!admission.ok) return { state: 'text', reason: `SVG source is not admissible: ${admission.reason}` }
  return { state: 'ready', source: args.svg, fact, admission }
}

/** The valid SVG credential among the final content blocks (if exactly one). */
function resultFact(blocks: readonly ContentBlock[] | undefined): SvgFact | undefined {
  if (blocks === undefined) return undefined
  let fact: SvgFact | undefined
  let seen = false
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text.startsWith(VISUAL_FACT_PREFIX)) continue
    if (seen) return undefined
    seen = true
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text.slice(VISUAL_FACT_PREFIX.length))
    } catch {
      return undefined
    }
    fact = parseSvgFact(parsed)
  }
  return fact
}
