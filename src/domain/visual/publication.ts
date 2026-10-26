/**
 * The ONE read-only publication authority over a committed Session log.
 *
 * Two layers answer the two questions a visual publication needs, from the same
 * authoritative event set and WITHOUT any Host handle:
 *
 * - {@link collectVisualSources} builds the generating chart/SVG occurrences a
 *   caller may publish: a real model `tool/call` for a generating tool, its
 *   paired successful `tool/result`, the FINAL `visual-v1:` fact, the stable
 *   reference block the generating tool projects, and (for SVG) the admitted
 *   durable source.
 * - {@link collectPublishedVisuals} replays real `present_visual` call/result
 *   pairs and returns the references that were actually published, in durable
 *   order, first-wins.
 *
 * Both layers fail closed on every identity question: a bare `callId` is never
 * an identity (it may be reused in a later turn/step), a tool NAME read from
 * result text is never provenance (only the durable `tool/call` is), a policy
 * replacement of either the source result or the publish result removes the
 * qualification, and a source produced in the publisher's own step is refused
 * even when it happened to commit first.
 *
 * This module is UI/Host-neutral: it holds no mutable state, imports only the
 * official session event types plus the visual fact parsers, and never writes.
 * @module @xmoon76/dsh-pi-tui/domain/visual/publication
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { authorizeSvg, type SvgFact } from './svg.ts'
import type { ChartFact } from './chart.ts'
import { visualParts } from './visual-facts.ts'
import { parseVisualReferenceLine, VISUAL_REFERENCE_PREFIX, visualReference } from './reference.ts'
import {
  CHART_TOOL_NAME,
  humanFacingVisualResult,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
  VISUAL_PUBLISHED_PREFIX,
} from '../transcript/visual-text.ts'

/**
 * The only session events this authority reads, declared structurally.
 *
 * `@deepseek-ai/dsh-session` is deliberately NOT imported: pulling its type
 * graph in here would add a second physical copy of the package (the same
 * shadowing problem `runtime/direct/session-direct.ts` documents) and would
 * register new Client-boundary coupling. The shapes below are the official
 * field sets of the six event types involved; a real `SessionEvent` satisfies
 * them, and {@link asVisualSessionEvents} narrows a raw log without widening
 * the accepted shapes.
 */
export type VisualSessionEvent =
  | { readonly type: 'turn/start'; readonly seq: number; readonly data: { readonly turn: number } }
  | { readonly type: 'turn/end'; readonly seq: number; readonly data: { readonly turn: number } }
  | {
    readonly type: 'step/start' | 'step/end'
    readonly seq: number
    readonly data: { readonly turn: number; readonly step: number }
  }
  | {
    /**
     * The complete model response of one step: it is committed BEFORE that
     * step's `tool/call` events, so it is the only durable place that already
     * knows every call id the step will request. Its `content` carries the
     * `tool-call` blocks, which is what makes duplicate-id detection complete.
     */
    readonly type: 'assistant/message'
    readonly seq: number
    readonly data: {
      readonly turn: number
      readonly step: number
      readonly message: {
        readonly content: readonly {
          readonly type: string
          readonly id?: string
          readonly name?: string
        }[]
      }
    }
  }
  | {
    readonly type: 'tool/call'
    readonly seq: number
    readonly surfaceOp?: unknown
    readonly data: {
      readonly turn: number
      readonly step: number
      readonly callId: string
      readonly name: string
      readonly arguments: string
    }
  }
  | {
    readonly type: 'tool/result'
    readonly seq: number
    /**
     * The official surface placement intent. A message-producing event must
     * carry one; `{ op: 'replace', … }` marks a MODEL-ONLY rewrite (the
     * compaction pruner's shadowed copy), never a second durable result.
     */
    readonly surfaceOp?: { readonly op: 'append' } | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
    readonly data: {
      readonly turn: number
      readonly step: number
      readonly message: {
        readonly toolCallId: string
        readonly content: readonly ContentBlock[]
        readonly isError?: boolean
      }
    }
  }

/** The durable event types this authority reads. */
const RELEVANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/**
 * Narrow one raw session event log to the shapes this authority reads.
 *
 * The events come from a persisted/observed log — a real external boundary — so
 * unrelated event types are simply not handed to the authority; every relevant
 * type still carries its official field set by construction of that log.
 * @param events - a committed session event log.
 * @returns the relevant events, unchanged and in order.
 */
export function asVisualSessionEvents<T extends { readonly type: string }>(
  events: readonly T[],
): readonly (T & VisualSessionEvent)[] {
  return events.filter((event): event is T & VisualSessionEvent => RELEVANT_EVENT_TYPES.has(event.type))
}

/**
 * Whether one event is a MODEL-ONLY surface replacement.
 *
 * The compaction `ToolResultPruner` appends a second `tool/result` that repeats
 * the original's turn, step and `callId` and is marked
 * `surfaceOp: { op: 'replace', … }`. Such a copy rewrites only the model-facing
 * projection: the append-origin result stays the human-visible history, and
 * treating the rewrite as a second durable result would mark the generating
 * source ambiguous and retract an already-accepted publication. The same rule
 * is applied by the transcript fold and the `/transcript` export. An unmarked
 * legacy event is never a replacement — absence of the marker is not a rewrite.
 * @param event - one log event.
 * @returns true only for an explicit replacement.
 */
export function isModelOnlyReplacement(event: object): boolean {
  const surfaceOp = (event as { readonly surfaceOp?: unknown }).surfaceOp
  if (surfaceOp === undefined) return false
  return (surfaceOp as { readonly op?: unknown }).op === 'replace'
}

/**
 * The event log this authority indexes: the given events WITHOUT the model-only
 * surface replacements, in log order.
 * @param events - the observed committed events.
 * @returns the append-origin events the visual facts live on.
 */
export function visualAuthorityEvents(events: readonly VisualSessionEvent[]): readonly VisualSessionEvent[] {
  return events.filter(event => !isModelOnlyReplacement(event))
}

/** The maximum number of references one publication may carry. */
export const MAX_PUBLISHED_VISUALS = 8

/** The generating result kinds a publication accepts. */
export type VisualSourceType = 'chart' | 'svg'

/**
 * One qualified generating occurrence: a committed top-level model call whose
 * final result is a valid visual fact carrying its own projected reference.
 */
export interface VisualSource {
  /** The reference derived from this occurrence's own identity tuple. */
  readonly ref: string
  readonly type: VisualSourceType
  /** The FINAL fact title (a policy value replacement may change it). */
  readonly title: string
  readonly turn: number
  readonly step: number
  /** Seq of the `step/start` that opened this occurrence's step. */
  readonly stepStartSeq: number
  /** Seq of the durable `tool/call`. */
  readonly callSeq: number
  /** Seq of the durable `tool/result`. */
  readonly resultSeq: number
  readonly callId: string
  /** The final chart fact, never reconstructed from call arguments. */
  readonly chart: ChartFact | undefined
  /** The final SVG credential. */
  readonly svg: SvgFact | undefined
  /** The admitted SVG source, present only for a `ready` authorization. */
  readonly svgSource: string | undefined
}

/** The parsed and structurally validated publication receipt. */
export interface PublishedReceipt {
  readonly version: 1
  readonly published: readonly { readonly ref: string }[]
}

/** One successful publication occurrence, in durable order. */
export interface PublishedVisual {
  readonly ref: string
  /** The publishing call identity. */
  readonly turn: number
  readonly step: number
  readonly stepStartSeq: number
  readonly callSeq: number
  readonly resultSeq: number
  readonly callId: string
  /** The generating occurrence this publication accepted. */
  readonly source: VisualSource
}

/** One call occurrence as the durable log records it. */
interface IndexedCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly turn: number
  readonly step: number
  readonly stepStartSeq: number
  readonly callSeq: number
  readonly ref: string
  /** Present once exactly one well-ordered result paired with this call. */
  result: IndexedResult | undefined
  /** Set when the composite identity or its result pairing is duplicated. */
  ambiguous: boolean
}

interface IndexedResult {
  readonly seq: number
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

function callKey(turn: number, step: number, callId: string): string {
  return `${turn}:${step}:${callId}`
}

/**
 * The tool-call ids ONE step's model response requested, with how often each id
 * appears.
 *
 * `assistant/message` is appended before any of that step's `tool/call` events,
 * so this count is complete even when a concurrency-safe publisher is already
 * running while the loop is still appending its siblings. A count above one
 * means the model repeated an id in a single response — a state the live gate
 * must refuse up front, because the replay of the finished log will necessarily
 * see the duplicate and treat the identity as ambiguous.
 * @param events - the authority events, in log order.
 * @returns per-step `(turn, step) -> callId -> count`.
 */
function stepCallIds(events: readonly VisualSessionEvent[]): Map<string, Map<string, number>> {
  const steps = new Map<string, Map<string, number>>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (isModelOnlyReplacement(event)) continue
    const key = `${event.data.turn}:${event.data.step}`
    let ids = steps.get(key)
    if (ids === undefined) {
      ids = new Map<string, number>()
      steps.set(key, ids)
    }
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-call' || typeof block.id !== 'string') continue
      ids.set(block.id, (ids.get(block.id) ?? 0) + 1)
    }
  }
  return steps
}

/**
 * The `(turn, step)` a `step/start` seq opened, from the assistant messages.
 *
 * The value is a plain `"turn:step"` key used by {@link stepCallIds}. A step
 * whose model response is not in the observed cut answers undefined, and the
 * caller then relies on the indexed occurrences alone.
 * @param events - the authority events.
 * @param turn - the executing turn.
 * @param stepStartSeq - the seq of the executing step's `step/start`.
 * @returns the step key, or undefined when no model response was observed.
 */
function assistantStepOf(
  events: readonly VisualSessionEvent[],
  turn: number,
  stepStartSeq: number,
): string | undefined {
  // The step's model response is the `assistant/message` of the same turn that
  // lands AFTER its `step/start` and BEFORE the next step boundary, so the seq
  // range identifies it exactly.
  let nextBoundary = Number.POSITIVE_INFINITY
  for (const event of events) {
    if (event.seq <= stepStartSeq) continue
    if (event.type !== 'step/start' && event.type !== 'step/end' && event.type !== 'turn/end') continue
    nextBoundary = Math.min(nextBoundary, event.seq)
  }
  for (const event of events) {
    if (event.type !== 'assistant/message' || isModelOnlyReplacement(event)) continue
    if (event.data.turn !== turn) continue
    if (event.seq <= stepStartSeq || event.seq >= nextBoundary) continue
    return `${event.data.turn}:${event.data.step}`
  }
  return undefined
}

/**
 * The committed calls of one session, with their paired results.
 *
 * Every call is recorded under its COMPOSITE identity `(turn, step, callId)`;
 * a duplicate composite identity or a second result marks the occurrence
 * ambiguous, and an ambiguous occurrence never authorizes a publication. A
 * `tool/call` outside an open `step/start` frame is not indexed at all: it has
 * no durable step identity, so nothing can be scoped to it. MODEL-ONLY surface
 * replacements are skipped: the compaction pruner appends a second `tool/result`
 * that repeats the original turn/step/`callId`, and counting it would make an
 * already-accepted publication look ambiguous.
 */
function indexCalls(sessionId: string, events: readonly VisualSessionEvent[]): IndexedCall[] {
  const calls: IndexedCall[] = []
  const byKey = new Map<string, IndexedCall>()
  let openStepStartSeq: number | undefined
  for (const event of events) {
    if (isModelOnlyReplacement(event)) continue
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        openStepStartSeq = undefined
        break
      case 'step/start':
        openStepStartSeq = event.seq
        break
      case 'tool/call': {
        if (openStepStartSeq === undefined) break
        const call: IndexedCall = {
          callId: event.data.callId,
          name: event.data.name,
          arguments: event.data.arguments,
          turn: event.data.turn,
          step: event.data.step,
          stepStartSeq: openStepStartSeq,
          callSeq: event.seq,
          ref: visualReference({
            sessionId,
            turn: event.data.turn,
            stepStartSeq: openStepStartSeq,
            callId: event.data.callId,
          }),
          result: undefined,
          ambiguous: false,
        }
        const key = callKey(call.turn, call.step, call.callId)
        const existing = byKey.get(key)
        if (existing !== undefined) {
          existing.ambiguous = true
          break
        }
        byKey.set(key, call)
        calls.push(call)
        break
      }
      case 'tool/result': {
        const key = callKey(event.data.turn, event.data.step, event.data.message.toolCallId)
        const call = byKey.get(key)
        if (call === undefined) break
        if (call.result !== undefined || event.seq <= call.callSeq) {
          call.ambiguous = true
          break
        }
        call.result = {
          seq: event.seq,
          content: event.data.message.content,
          isError: event.data.message.isError === true,
        }
        break
      }
      default:
        break
    }
  }
  return calls
}

/** The text blocks of one result's content, in order. */
function textBlocks(blocks: readonly ContentBlock[]): string[] {
  const texts: string[] = []
  for (const block of blocks) if (block.type === 'text') texts.push(block.text)
  return texts
}

/**
 * The reference block the generating tool projected into one FINAL result.
 *
 * The projected shape is `… <ref block>\n<visual-v1 fact>`: the fact is the
 * LAST text block and the reference block is the one immediately before it. A
 * human line that merely starts with the prefix is never a candidate, because
 * the position AND the exact machine-only spelling are both required.
 * @param blocks - the final result content blocks.
 * @returns the reference, or undefined when the tail shape does not hold.
 */
export function trailingVisualReference(blocks: readonly ContentBlock[]): string | undefined {
  const texts = textBlocks(blocks)
  if (texts.length < 2) return undefined
  const fact = texts[texts.length - 1] as string
  if (!fact.startsWith('visual-v1:')) return undefined
  return parseVisualReferenceLine(texts[texts.length - 2] as string)
}

/**
 * Qualify one indexed call as a publishable generating occurrence.
 * @param call - one indexed call occurrence.
 * @returns the source, or undefined when any qualifier is missing.
 */
function qualifySource(call: IndexedCall): VisualSource | undefined {
  if (call.ambiguous) return undefined
  if (call.name !== CHART_TOOL_NAME && call.name !== SVG_TOOL_NAME) return undefined
  const result = call.result
  if (result === undefined || result.isError) return undefined
  if (trailingVisualReference(result.content) !== call.ref) return undefined
  const fact = visualParts(result.content).fact
  if (fact === undefined) return undefined
  const base = {
    ref: call.ref,
    title: fact.title,
    turn: call.turn,
    step: call.step,
    stepStartSeq: call.stepStartSeq,
    callSeq: call.callSeq,
    resultSeq: result.seq,
    callId: call.callId,
  }
  if (call.name === CHART_TOOL_NAME) {
    return fact.type === 'chart'
      ? { ...base, type: 'chart', chart: fact, svg: undefined, svgSource: undefined }
      : undefined
  }
  if (fact.type !== 'svg') return undefined
  // The SVG credential must still match the durable call source and pass the
  // admission gate against the FINAL content; no cached blob, PNG or meta is read.
  const authorization = authorizeSvg(call.arguments, result.content, 'ok')
  if (authorization.state !== 'ready') return undefined
  return { ...base, type: 'svg', chart: undefined, svg: fact, svgSource: authorization.source }
}

/**
 * Build the qualified generating occurrences of one committed log.
 *
 * A source needs ALL of: an unambiguous top-level model `tool/call` for a
 * generating tool, exactly one well-ordered paired result, a successful result,
 * a final fact of the matching type, the exact reference block the generating
 * tool projects, and — for SVG — a credential that still matches the durable
 * call arguments and admits the source.
 * @param sessionId - the observed session identity.
 * @param events - the exact committed events, in `seq` order.
 * @returns the qualified sources in durable order.
 */
export function collectVisualSources(sessionId: string, events: readonly VisualSessionEvent[]): VisualSource[] {
  const sources: VisualSource[] = []
  for (const call of indexCalls(sessionId, events)) {
    const source = qualifySource(call)
    if (source !== undefined) sources.push(source)
  }
  return sources
}

/** The last text block's text of one result. */
function lastText(blocks: readonly ContentBlock[]): string | undefined {
  const texts = textBlocks(blocks)
  return texts[texts.length - 1]
}

/** Whether one string is the accepted reference spelling. */
function isReferenceSpelling(value: string): boolean {
  return parseVisualReferenceLine(`${VISUAL_REFERENCE_PREFIX}${value}`) !== undefined
}

/** Structural validation of one receipt JSON body. */
function parseReceiptBody(value: unknown): PublishedReceipt | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.published)) return undefined
  if (record.published.length === 0 || record.published.length > MAX_PUBLISHED_VISUALS) return undefined
  const published: { ref: string }[] = []
  for (const entry of record.published) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).length !== 1 || typeof fields.ref !== 'string') return undefined
    published.push({ ref: fields.ref })
  }
  return { version: 1, published }
}

/**
 * Parse the durable publication receipt of one final result.
 *
 * The receipt is the LAST text block; the human summary precedes it. A failed
 * result never carries one, the JSON body must be exactly
 * `{version:1, published:[{ref}]}`, and the references must be unique and
 * well-formed.
 * @param blocks - the final result content blocks.
 * @param isError - the durable result failure flag.
 * @returns the parsed receipt and the preceding human text, or undefined.
 */
export function parsePublicationReceipt(
  blocks: readonly ContentBlock[],
  isError: boolean,
): { readonly receipt: PublishedReceipt; readonly humanText: string } | undefined {
  if (isError) return undefined
  const last = lastText(blocks)
  if (last === undefined || !last.startsWith(VISUAL_PUBLISHED_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(last.slice(VISUAL_PUBLISHED_PREFIX.length))
  } catch {
    return undefined
  }
  const receipt = parseReceiptBody(parsed)
  if (receipt === undefined) return undefined
  const refs = receipt.published.map(entry => entry.ref)
  if (new Set(refs).size !== refs.length) return undefined
  if (!refs.every(ref => isReferenceSpelling(ref))) return undefined
  const human: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== last) human.push(block.text)
  }
  return { receipt, humanText: human.join('\n') }
}

/** The references one `present_visual` call requested, or undefined when unreadable. */
function requestedReferences(rawArguments: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  const decision = parsePresentVisualArguments(parsed)
  return decision.ok ? [...decision.refs] : undefined
}

/** The refusal of one `present_visual` argument document. */
export type PresentVisualArgumentProblem = { readonly ok: false; readonly reason: string }

/** The accepted reference list of one `present_visual` argument document. */
export type PresentVisualArguments = { readonly ok: true; readonly refs: readonly string[] }

/**
 * The ONE `present_visual` argument contract, shared by live execution and cold
 * replay.
 *
 * The official ToolRuntime does NOT apply a full JSON-Schema pass to a tool's
 * arguments; the body receives them as-is. The live path therefore validates
 * with THIS function, and the replay path parses the durable
 * `tool/call.arguments` with the same one — so a successful receipt can always
 * be replay-verified, and a replay can never accept a document the live body
 * would have refused. The document is closed: only `visuals` at the root, only
 * `ref` per entry, 1–8 entries, well-formed `sv1_` references, no duplicates.
 * @param args - the model-supplied arguments (already JSON-parsed).
 * @returns the accepted references, or the verbatim refusal reason.
 */
export function parsePresentVisualArguments(args: unknown): PresentVisualArguments | PresentVisualArgumentProblem {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, reason: 'arguments must be an object with a `visuals` array' }
  }
  const record = args as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Array.isArray(record.visuals)) {
    return { ok: false, reason: 'arguments must contain only `visuals`' }
  }
  const visuals = record.visuals as unknown[]
  if (visuals.length === 0 || visuals.length > MAX_PUBLISHED_VISUALS) {
    return { ok: false, reason: `visuals must contain between 1 and ${MAX_PUBLISHED_VISUALS} items` }
  }
  const refs: string[] = []
  for (const entry of visuals) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: 'every visual must be an object' }
    }
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).length !== 1 || typeof fields.ref !== 'string') {
      return { ok: false, reason: 'every visual must contain only `ref`' }
    }
    if (!isReferenceSpelling(fields.ref)) {
      return { ok: false, reason: 'every visual ref must look like sv1_ followed by 20 lowercase hex digits' }
    }
    refs.push(fields.ref)
  }
  if (new Set(refs).size !== refs.length) {
    return { ok: false, reason: 'present_visual received the same visual ref twice' }
  }
  return { ok: true, refs }
}

/**
 * Whether one generating source may be published by the given publisher.
 *
 * Stated once so the live tool body and cold replay cannot disagree: the same
 * turn, an EARLIER model step, and the source result committed before the
 * publishing call.
 */
function isPublishableBy(
  source: VisualSource,
  publisher: { readonly turn: number; readonly stepStartSeq: number; readonly callSeq: number },
): boolean {
  return source.turn === publisher.turn
    && source.stepStartSeq < publisher.stepStartSeq
    && source.resultSeq < publisher.callSeq
}

/**
 * Collect the successfully published visuals of one committed log.
 *
 * Cold replay applies the SAME rules as the Host tool body. A publication is
 * accepted only when the durable `present_visual` call and its successful
 * result pair exactly, the receipt is present in the FINAL content, and the
 * requested references equal the receipt's references position by position.
 * Repeated references keep only their FIRST successful publication.
 * @param sessionId - the observed session identity.
 * @param events - the exact committed events, in `seq` order.
 * @returns the published visuals in durable order, first-wins.
 */
export function collectPublishedVisuals(sessionId: string, events: readonly VisualSessionEvent[]): PublishedVisual[] {
  const sources = collectVisualSources(sessionId, events)
  const published: PublishedVisual[] = []
  for (const call of indexCalls(sessionId, events)) {
    if (call.ambiguous || call.name !== PRESENT_VISUAL_TOOL_NAME) continue
    const result = call.result
    if (result === undefined) continue
    const parsed = parsePublicationReceipt(result.content, result.isError)
    if (parsed === undefined) continue
    const requested = requestedReferences(call.arguments)
    if (requested === undefined) continue
    const receiptRefs = parsed.receipt.published.map(entry => entry.ref)
    if (requested.length !== receiptRefs.length) continue
    if (!requested.every((ref, position) => ref === receiptRefs[position])) continue
    const accepted: PublishedVisual[] = []
    let qualified = true
    for (const ref of requested) {
      const matched = sources.filter(source => source.ref === ref)
      if (matched.length !== 1 || !isPublishableBy(matched[0] as VisualSource, call)) {
        qualified = false
        break
      }
      accepted.push({
        ref,
        turn: call.turn,
        step: call.step,
        stepStartSeq: call.stepStartSeq,
        callSeq: call.callSeq,
        resultSeq: result.seq,
        callId: call.callId,
        source: matched[0] as VisualSource,
      })
    }
    if (!qualified) continue
    for (const entry of accepted) {
      if (published.some(existing => existing.ref === entry.ref)) continue
      published.push(entry)
    }
  }
  return published
}

/** The refusal of one publication request. */
export interface PublicationRefusal {
  readonly ok: false
  readonly reason: string
}

/** The accepted receipt to persist. */
export interface PublicationAcceptance {
  readonly ok: true
  readonly receipt: PublishedReceipt
  /** The human-readable summary line (singular/plural by count). */
  readonly summary: string
}

/** The outcome of deciding one `present_visual` request. */
export type PublicationDecision = PublicationAcceptance | PublicationRefusal

/**
 * Decide one `present_visual` request against the observed committed log.
 *
 * This is the SINGLE decision function the Host tool body calls, so the live
 * path and cold replay cannot diverge. The caller supplies the already-observed
 * committed events plus the executing call's own identity; the publisher's
 * durable `tool/call` is located here, never assumed.
 * @param input - the observed log, the requested references and the publisher
 *   identity.
 * @returns the receipt to persist, or the verbatim refusal reason.
 */
export function decidePublication(input: {
  readonly sessionId: string
  readonly events: readonly VisualSessionEvent[]
  /**
   * The references the executing call was handed. They are CHECKED against the
   * durable `tool/call.arguments` below; the durable value is the authority, so
   * a caller cannot widen (or narrow) what the log actually recorded.
   */
  readonly refs: readonly string[]
  readonly turn: number
  readonly stepStartSeq: number
  readonly callId: string
}): PublicationDecision {
  const { sessionId, events, refs, turn, stepStartSeq, callId } = input
  // Complete-batch identity check FIRST: the step's own model response already
  // lists every call id it requested, so a repeated id is refused before any
  // publisher can win a race against its own sibling's `tool/call` append.
  const step = assistantStepOf(events, turn, stepStartSeq)
  if (step !== undefined) {
    const ids = stepCallIds(events).get(step)?.get(callId) ?? 0
    if (ids > 1) {
      return {
        ok: false,
        reason: `the model response for this step requested "${callId}" ${ids} times; a duplicated call id cannot publish`,
      }
    }
  }
  const calls = indexCalls(sessionId, events)
  const publishers = calls.filter(candidate =>
    candidate.name === PRESENT_VISUAL_TOOL_NAME
    && candidate.turn === turn
    && candidate.stepStartSeq === stepStartSeq
    && candidate.callId === callId)
  // A duplicated composite identity is ambiguous in BOTH directions: cold
  // replay skips such a call, so the live path must refuse it too — otherwise a
  // run could accept a publication that replay would never recognise.
  if (publishers.length !== 1 || (publishers[0] as IndexedCall).ambiguous) {
    return {
      ok: false,
      reason: `no unique committed ${PRESENT_VISUAL_TOOL_NAME} call "${callId}" in the current step`,
    }
  }
  const publisher = publishers[0] as IndexedCall
  // The DURABLE arguments are the authority for what was requested.
  const durable = requestedReferences(publisher.arguments)
  if (durable === undefined) {
    return { ok: false, reason: `the durable ${PRESENT_VISUAL_TOOL_NAME} arguments are not a valid request` }
  }
  if (durable.length !== refs.length || !durable.every((ref, position) => ref === refs[position])) {
    return {
      ok: false,
      reason: 'the executing call arguments disagree with the durable tool/call arguments',
    }
  }
  const sources = calls.map(call => qualifySource(call)).filter((source): source is VisualSource => source !== undefined)
  const accepted: { ref: string }[] = []
  for (const ref of refs) {
    const matched = sources.filter(source => source.ref === ref)
    if (matched.length > 1) {
      return { ok: false, reason: `visual ref ${ref} is ambiguous: more than one committed source owns it` }
    }
    const source = matched[0]
    if (source === undefined) {
      const pending = calls.find(candidate => candidate.ref === ref && candidate.result === undefined)
      if (pending !== undefined) {
        return {
          ok: false,
          reason: 'Source visual is not committed yet; call present_visual after the generating tool has finished.',
        }
      }
      return {
        ok: false,
        reason: `unknown visual ref ${ref}: no committed ${CHART_TOOL_NAME}/${SVG_TOOL_NAME} result owns it`,
      }
    }
    if (source.turn !== turn) {
      return { ok: false, reason: `visual ref ${ref} belongs to turn ${source.turn}, not the current turn ${turn}` }
    }
    if (source.stepStartSeq === stepStartSeq) {
      return { ok: false, reason: 'Call present_visual in a later model step.' }
    }
    if (source.stepStartSeq > stepStartSeq) {
      return { ok: false, reason: `visual ref ${ref} belongs to a later model step` }
    }
    if (!isPublishableBy(source, publisher)) {
      return {
        ok: false,
        reason: 'Source visual is not committed yet; call present_visual after the generating tool has finished.',
      }
    }
    accepted.push({ ref })
  }
  const count = accepted.length
  return {
    ok: true,
    receipt: { version: 1, published: accepted },
    summary: `Selected ${count} visual${count === 1 ? '' : 's'} for presentation.`,
  }
}

/** The one visible-text projection, re-exported for the visual feature's consumers. */
export { humanFacingVisualResult, VISUAL_PUBLISHED_PREFIX }

/** Whether one text starts with the publication receipt prefix. */
export function isPublicationReceiptLine(text: string): boolean {
  return text.startsWith(VISUAL_PUBLISHED_PREFIX)
}
