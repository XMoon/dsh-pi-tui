/**
 * The production TSP transcript mapper (PR3-A): the pure
 * `TranscriptStructureBlock[] -> TSP view` mapper and its one
 * presentation-local identity allocator, moved verbatim from the PR1 spike
 * (`scripts/support/tern-tsp-transcript-view.ts`, which now re-exports this
 * module so the spike and its tests keep the SAME oracle).
 *
 * It reads the canonical transcript structure produced by the production
 * projector and emits official `@stencil-hq/tern` nodes. It owns no event
 * application, no turn/tool-result pairing and no durable identity — it never
 * re-segments Work/Context membership, never classifies a row from its display
 * text, and never writes transport bytes (the SDK's `View`/`Surface` own the
 * wire).
 *
 * Node keys are presentation identities only: the SDK derives wire ids from a
 * parent id plus the child's `key`, so a stable `key` keeps an unchanged row
 * in place across renders. The allocator is scoped to ONE renderer
 * presentation scope (see `TranscriptNodeKeys`; the renderer re-scopes on a
 * `sourceIdentity` change); it is not a persistence identity.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/transcript-view
 */

import { ui } from '@stencil-hq/tern'
import type { Node, Spans, Status } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SettledQuestionAnswersLookup } from '../../app/surface/interaction-presenter.ts'
import type { StreamingToolPreview } from '../../app/surface/streaming-tool-preparing.ts'
import { contextFormOf } from '../../domain/transcript/context-semantics.ts'
import { subCallDisplayStatus } from '../../domain/transcript/folder.ts'
import { formatBytes } from '../../domain/media/format.ts'
import type { ImageAttachmentRefLike } from '../../domain/media/types.ts'
import type { TranscriptMessage, TranscriptToolMessage } from '../../domain/transcript/types.ts'
import { contextPresentationKind } from '../transcript/context-structure.ts'
import type { ContextCluster } from '../transcript/context-structure.ts'
import { contextClusterSummaryParts } from '../transcript/context-summary.ts'
import type { TranscriptStructureBlock, TranscriptWorkSpan } from '../transcript/structure.ts'
import { systemContextBody, toolCardHeader, toolTitle, relativizeToCwd } from '../transcript/tool-presentation.ts'
import type { ToolPresenter } from '../transcript/tool-presentation.ts'
import { toolTargetFactsOf, toolTargetKind } from '../transcript/tool-target-semantics.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { chartHumanText, chartProjection, chartValueRows, type ChartFact } from '../../domain/visual/chart.ts'
import { svgDetailRows, type SvgFact } from '../../domain/visual/svg.ts'
import { visualParts, visualPartsFromText } from '../../domain/visual/visual-facts.ts'

/**
 * One replay-local allocator of presentation keys, scoped to a single
 * `TranscriptFolder`/`Surface` lifetime. It maps a `TranscriptMessage` object
 * to `<namespace>-<n>` on first sight, so a retained carrier object keeps its
 * key through ordinary live updates. A replaced carrier (a merged read group,
 * a cold re-hydration) legitimately gets a fresh key: this is presentation
 * identity, never a domain or wire identity.
 */
export class TranscriptNodeKeys {
  #byMessage = new WeakMap<TranscriptMessage, string>()
  #next = 0

  /** The stable per-lifetime key of one message, allocated on first sight. */
  keyFor(message: TranscriptMessage): string {
    const known = this.#byMessage.get(message)
    if (known !== undefined) return known
    this.#next += 1
    const key = `msg-${this.#next}`
    this.#byMessage.set(message, key)
    return key
  }
}

/** Explicit mapper inputs the projection itself does not own. */
export interface TranscriptViewOptions {
  /** Workspace root for the shared tool-args path relativization; optional. */
  readonly cwd?: string
  /**
   * A renderer-local scope prefix applied to the TOP-LEVEL block keys. The
   * SDK derives every node id from its parent's id plus the child key, so
   * prefixing the top level re-namespaces the WHOLE subtree — the mechanism
   * by which a replaced projection source (session commit, cold rehydrate,
   * viewer switch) can never inherit another fold's SDK node ids or
   * terminal-local state. Presentation identity only, NOT a durable or
   * domain identity; the default (`''`) keeps the PR1 oracle's key shapes.
   */
  readonly scopePrefix?: string
  /**
   * PR3-B B3 (§3.9): the authoritative settled-answer lookup the interaction
   * owner installs (an official `userQuestions` projection read). It is
   * consulted ONLY for an `ask_user_question` tool row carrying an official
   * `callId`, and only to render that row's result body — the canonical
   * transcript message is never rewritten.
   */
  readonly settledQuestionAnswersLookup?: SettledQuestionAnswersLookup
  /**
   * PR-B1: the presentation bridge over the REGISTERED tool definitions
   * (the SAME bridge the PiTui renderer consumes). It is consulted ONLY to
   * decide whether a tool row's displayed target is PROVEN to be a command, a
   * single path or a pattern, so the native client can draw it with the
   * matching syntax. It never changes the displayed string, the body, the
   * card's identity or its status — an absent bridge leaves every row's
   * target plain `text`, exactly as before.
   */
  readonly toolPresenter?: ToolPresenter
  /**
   * PR-B3: the LIVE tool-call Preparing projection — the read-only snapshot
   * the application owner already derived from the official assistant stream
   * (`StreamingToolPreview`). It is presentation input only: the mapper never
   * owns a preview, never subscribes to a delta, never decides when a
   * Preparing row disappears (the owner clears the preview and the NEXT
   * snapshot says so) and never re-parses a partial argument payload.
   *
   * The rows are placed on the SAME canonical structure: only the TRAILING
   * open Work span may adopt the rows of its own turn, every other turn fails
   * open as standalone rows after the transcript. An absent option (or an
   * empty array) renders exactly the tree the mapper rendered before.
   */
  readonly preparingPreviews?: readonly StreamingToolPreview[]
  /**
   * PR-C: the per-attachment render state of the CURRENT display subject,
   * keyed by attachment id. The TSP session layer fills it BEFORE every
   * projection (it is the only owner of the loader and of the blob sender);
   * an absent map means the renderer has no image capability at all, so an
   * image block renders its identity line and no native image.
   */
  readonly toolImageStates?: ReadonlyMap<string, ToolImageState>
  /**
   * PR-D: whether the current pane actually negotiated the native `chart`
   * kind. The Host tool is registered regardless; this flag is the CLIENT
   * renderer's admission decision. Without it the chart renders its exact
   * text rows only (never a native chart node).
   */
  readonly chartKindsSupported?: boolean
  /**
   * PR-D: the per-row SVG authorization/blob state prepared by the TSP
   * session layer (the only owner of the admission gate and the blob sender).
   * Keyed by the ROW OBJECT, never by its bare call/sub-call id: the fold
   * contract permits id reuse across turns/steps, and a string key would let
   * one row's credential authorize another row. Absent means no native SVG
   * state was prepared (the row keeps its readable text).
   */
  readonly toolSvgStates?: ReadonlyMap<TranscriptToolMessage, ToolSvgState>
}

/** PR-D: one SVG row's prepared display state. */
export type ToolSvgState =
  /** The pane carries `image` + `blobs` and the source was admitted. */
  | { readonly state: 'ready'; readonly blobId: string; readonly fact: SvgFact; readonly source: string }
  /** The pane negotiated no native image/blob capability; the admitted
   *  source is still available for the readable top-level/child card. */
  | { readonly state: 'unsupported'; readonly fact: SvgFact; readonly source: string }
  /** The final content did not authorize a drawing (or admission refused it). */
  | { readonly state: 'invalid'; readonly reason: string }

/** `ok|error|running` -> the SDK's card/tool `status` vocabulary. */
function toolStatus(status: 'ok' | 'error' | 'running'): Status {
  return status === 'ok' ? 'done' : status
}

/**
 * Whether one settled tool card has no genuine `tool/call` behind it: an
 * orphan result (`callCount === 0`, no origin) or the official
 * `tool-not-started` crash-recovery diagnostic. Such a row must never present
 * a completed execution status.
 */
function isUnmatchedToolRow(message: Extract<TranscriptMessage, { kind: 'tool' }>): boolean {
  return message.origin === 'tool-not-started' || (message.origin === undefined && message.callCount === 0)
}

/**
 * PR-C: the raster media types the project presents as a NATIVE image
 * attachment. The set is the project's own media vocabulary, never a
 * negotiated client capability.
 */
const NATIVE_IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * PR-C: the blob id of an image that is NOT ready yet — 64 lowercase hex
 * zeros. It has the SHAPE of a real blob id, so the pane draws its own
 * native placeholder for it. The renderer NEVER sends it: no `b` frame names
 * it, and the real blob id replaces it under the SAME node key when the
 * authorized read settles.
 */
export const PENDING_IMAGE_BLOB_ID = '0'.repeat(64)

/**
 * PR-C: the 16 MiB single-blob gate. It is the wire's own limit, checked
 * against the READY bytes before anything is sent.
 */
export const MAX_IMAGE_BLOB_BYTES = 16 * 1024 * 1024

/** PR-C: why one image attachment reference cannot be presented. */
export type ImageRefProblem = 'invalid' | 'unsupported-format'

/**
 * PR-C: the external-input check on ONE image attachment reference. The
 * reference crosses a Host boundary, so its identity and its media type are
 * validated here — the mapper never trusts them because "the tool produced
 * it".
 * @param ref - the block's attachment reference (untrusted).
 * @returns the problem, or `undefined` when the reference is presentable.
 */
export function imageRefProblem(ref: unknown): ImageRefProblem | undefined {
  if (ref === null || typeof ref !== 'object') return 'invalid'
  const candidate = ref as Partial<ImageAttachmentRefLike>
  if (typeof candidate.attachmentId !== 'string' || candidate.attachmentId === '') return 'invalid'
  if (typeof candidate.width !== 'number' || !Number.isSafeInteger(candidate.width) || candidate.width <= 0) return 'invalid'
  if (typeof candidate.height !== 'number' || !Number.isSafeInteger(candidate.height) || candidate.height <= 0) return 'invalid'
  if (typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0) return 'invalid'
  if (typeof candidate.mediaType !== 'string' || !NATIVE_IMAGE_MEDIA_TYPES.includes(candidate.mediaType)) return 'unsupported-format'
  return undefined
}

/** PR-C: whether one attachment reference is a presentable native image. */
function isPresentableImageRef(ref: unknown): ref is ImageAttachmentRefLike {
  return imageRefProblem(ref) === undefined
}

/**
 * PR-C: the synchronous render state of ONE projected image attachment.
 *
 * The TSP session layer owns the loader and the blob sender, so IT supplies
 * this fact; the mapper only decides how to present it. The mapper never
 * reads bytes, never awaits and never talks to the SDK.
 */
export type ToolImageState =
  /** The pane negotiated neither the `image` kind nor the `blobs` feature. */
  | { readonly state: 'unsupported' }
  /** The display subject has no immutable image scope: nothing may be read. */
  | { readonly state: 'no-scope' }
  /** The authorized read has not produced bytes yet. */
  | { readonly state: 'loading' }
  /** The authorized read failed (denied, missing or unreadable). */
  | { readonly state: 'error' }
  /** The ready bytes exceed the 16 MiB blob gate and are never sent. */
  | { readonly state: 'too-large' }
  /** The bytes are ready and within the gate; the real blob id is carried. */
  | { readonly state: 'ready'; readonly blobId: string }

/**
 * PR-C: one projected image block: its index inside the row's result blocks
 * (the key material) and its attachment reference.
 */
export interface ProjectedImageBlock {
  /** The block's index inside the row's result blocks. */
  readonly index: number
  /** The block's attachment reference (untrusted external input). */
  readonly attachment: unknown
}

/**
 * PR-C: whether ONE tool row renders its result BLOCK-WISE (the image path).
 *
 * The rule is the single owner of the row-level decision, so the mapper and
 * the renderer's read path can never disagree about which attachment a row
 * shows:
 *
 * - an `ask_user_question` row keeps its ORIGINAL node structure: the
 *   settled-answer lookup stays the authority of its result, whatever the
 *   row's blocks carry;
 * - a MERGED read group keeps the flat text result: its `resultBlocks` are
 *   the FIRST member's blocks and never describe the aggregate, so an image
 *   would be attributed to the wrong member. The group's genuine-call
 *   cardinality (`callCount > 1`) is the folder's own aggregation fact — a
 *   single ordinary `read` is never blocked by it;
 * - every other row projects its images only when its result really carries
 *   an image block.
 */
export function toolRowProjectsImages(message: TranscriptToolMessage): boolean {
  if (message.name === 'ask_user_question') return false
  if ((message.callCount ?? 1) > 1) return false
  const blocks = message.resultBlocks
  if (blocks === undefined) return false
  return blocks.some(block => block.type === 'image')
}

/**
 * PR-C: the image blocks ONE tool row projects, in block order. The
 * eligibility rule is {@link toolRowProjectsImages}; the blocks are returned
 * with their index so the mapper and the reader agree on the node keys.
 */
export function toolRowImageBlocks(message: TranscriptToolMessage): readonly ProjectedImageBlock[] {
  if (!toolRowProjectsImages(message)) return []
  const blocks = message.resultBlocks ?? []
  const out: ProjectedImageBlock[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'image') out.push({ index, attachment: block.attachment })
  })
  return out
}

/**
 * PR-C: the display name of one image attachment: the attachment's own name
 * when it has one, else `image`. The identity line and the native image's
 * accessible name are the SAME name — one attachment, one name.
 */
function imageDisplayName(ref: unknown): string {
  const candidate = (ref === null || typeof ref !== 'object' ? undefined : ref) as Partial<ImageAttachmentRefLike> | undefined
  return candidate !== undefined && typeof candidate.name === 'string' && candidate.name !== ''
    ? candidate.name
    : 'image'
}

/**
 * PR-C: the identity segment of one image attachment: the display name (the
 * attachment's own name, or `image`), its SOURCE pixel size and its SOURCE
 * byte count. A malformed reference contributes only the parts that are well
 * formed — the status phrase still says what is wrong.
 */
function imageIdentityText(ref: unknown): string {
  const candidate = (ref === null || typeof ref !== 'object' ? undefined : ref) as Partial<ImageAttachmentRefLike> | undefined
  const parts: string[] = [imageDisplayName(ref)]
  if (candidate !== undefined
    && typeof candidate.width === 'number' && Number.isSafeInteger(candidate.width) && candidate.width > 0
    && typeof candidate.height === 'number' && Number.isSafeInteger(candidate.height) && candidate.height > 0) {
    parts.push(`${candidate.width}×${candidate.height}`)
  }
  if (candidate !== undefined && typeof candidate.bytes === 'number' && Number.isSafeInteger(candidate.bytes) && candidate.bytes >= 0) {
    parts.push(formatBytes(candidate.bytes))
  }
  return `[IMAGE] ${parts.join(' · ')}`
}

/** PR-C: the fixed status phrase of one image state (the frozen table). */
function imageStatusText(state: ToolImageState): string | undefined {
  switch (state.state) {
    case 'unsupported': return 'Native image display unavailable in this Tern pane'
    case 'no-scope': return 'Image unavailable for this session'
    case 'loading': return 'Loading image…'
    case 'error': return 'Image read failed'
    case 'too-large': return 'Image exceeds 16 MiB Blob limit'
    case 'ready': return undefined
  }
}

/**
 * PR-C: the nodes of ONE image block: the identity line and — when the pane
 * supports a native image and the read produced bytes — the native image
 * node. The identity line is ALWAYS drawn: it is the only place the reader
 * learns WHICH attachment the row carries and what happened to it.
 *
 * The image node's key is the SAME for the pending and the ready state, so
 * the pane replaces the placeholder in place instead of adding a second row.
 */
function imageBlockNodes(
  block: ProjectedImageBlock,
  state: ToolImageState | undefined,
): Node[] {
  const problem = imageRefProblem(block.attachment)
  const identity = imageIdentityText(block.attachment)
  if (problem !== undefined) {
    const phrase = problem === 'invalid' ? 'Invalid image attachment' : 'Unsupported image format'
    return [ui.text({ key: `result-b${block.index}-info`, text: sanitizeDisplayText(`${identity} · ${phrase}`) })]
  }
  const alt = sanitizeDisplayText(imageDisplayName(block.attachment))
  const status = state === undefined ? 'Native image display unavailable in this Tern pane' : imageStatusText(state)
  const info = status === undefined ? identity : `${identity} · ${status}`
  const nodes: Node[] = [ui.text({ key: `result-b${block.index}-info`, text: sanitizeDisplayText(info) })]
  if (state === undefined || state.state === 'unsupported' || state.state === 'no-scope') return nodes
  const blob = state.state === 'ready' ? state.blobId : PENDING_IMAGE_BLOB_ID
  nodes.push(ui.image({ key: `result-b${block.index}-image`, blob, alt }))
  return nodes
}

/**
 * PR-C: the block-wise result of one tool row: every non-empty text block
 * stays a `ui.code`, every image block becomes its identity line plus the
 * native image node. The flat result is NOT drawn again — it would
 * duplicate the text blocks.
 */
function imageResultNodes(
  blocks: readonly ContentBlock[],
  options: TranscriptViewOptions,
  wrap: boolean,
): Node[] {
  const nodes: Node[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      if (block.text === '') return
      nodes.push(ui.code({ key: `result-b${index}-text`, text: sanitizeDisplayText(block.text), ...(wrap ? { wrap: true } : {}) }))
      return
    }
    if (block.type !== 'image') return
    const projected: ProjectedImageBlock = { index, attachment: block.attachment }
    // A malformed reference is NEVER read and never looked up: it renders its
    // own failure line, not a state the reader has to interpret.
    const state = isPresentableImageRef(block.attachment)
      ? options.toolImageStates?.get(block.attachment.attachmentId)
      : undefined
    nodes.push(...imageBlockNodes(projected, state))
  })
  return nodes
}

/**
 * PR-D: the chart row's result segment. The FINAL durable content is the
 * admission source: a valid chart machine line draws as a native chart only
 * when the pane negotiated the `chart` kind, and the exact values stay a
 * `ui.code` row in every renderer. A malformed/missing line falls back to the
 * human blocks (the machine line is never displayed).
 */
function chartResultNodes(
  message: TranscriptToolMessage,
  options: TranscriptViewOptions,
  wrap: boolean,
  flatText: string,
): Node[] {
  const base = message.resultBlocks === undefined ? visualPartsFromText(flatText) : visualParts(message.resultBlocks)
  const parts = message.status === 'ok' ? base : { ...base, fact: undefined }
  const fact: ChartFact | undefined = parts.fact?.type === 'chart' ? parts.fact : undefined
  if (fact === undefined) {
    const text = parts.humanText === '' ? base.humanText === '' ? flatText : base.humanText : parts.humanText
    return text === '' ? [] : [ui.code({ key: 'result', text: sanitizeDisplayText(text), ...(wrap ? { wrap: true } : {}) })]
  }
  const nodes: Node[] = []
  if (options.chartKindsSupported === true) {
    const projection = chartProjection(fact)
    nodes.push(ui.chart({
      key: 'result-chart',
      kind: projection.kind,
      summary: sanitizeDisplayText(projection.summary),
      series: projection.series,
    }))
    nodes.push(ui.code({ key: 'result', text: sanitizeDisplayText(chartValueRows(fact).join('\n')), ...(wrap ? { wrap: true } : {}) }))
  } else {
    // No native chart node: the readable body must carry the FINAL fact title
    // as well as the values; the header only knows the original call args.
    nodes.push(ui.code({ key: 'result', text: sanitizeDisplayText(chartHumanText(fact)), ...(wrap ? { wrap: true } : {}) }))
  }
  return nodes
}

/**
 * PR-D: the SVG row's result segment. The readable description is ALWAYS
 * drawn; the native image node appears only for a prepared `ready` state
 * (credential matches the durable call args, admission accepted, `image` +
 * `blobs` negotiated). The SVG source itself is the card's args row.
 */
function svgResultNodes(
  message: TranscriptToolMessage,
  options: TranscriptViewOptions,
  wrap: boolean,
  flatText: string,
): Node[] {
  const base = message.resultBlocks === undefined ? visualPartsFromText(flatText) : visualParts(message.resultBlocks)
  const parts = message.status === 'ok' ? base : { ...base, fact: undefined }
  const fact: SvgFact | undefined = parts.fact?.type === 'svg' ? parts.fact : undefined
  const detail = fact === undefined
    ? (parts.humanText === '' ? base.humanText === '' ? flatText : base.humanText : parts.humanText)
    : svgDetailRows(fact).join('\n')
  const nodes: Node[] = detail === ''
    ? []
    : [ui.code({ key: 'result', text: sanitizeDisplayText(detail), ...(wrap ? { wrap: true } : {}) })]
  // A successful result is required even when a prepared state exists (the
  // session already refuses to send its blob, this mapper must not draw it).
  // The lookup is by this exact row object, so a reused call/sub-call id
  // elsewhere in the transcript can never lend its credential to this card.
  const state = message.status === 'ok' ? options.toolSvgStates?.get(message) : undefined
  if (state?.state === 'ready') {
    nodes.push(ui.image({ key: 'result-svg', blob: state.blobId, alt: sanitizedPhysicalLine(state.fact.title) }))
  } else if (state?.state === 'unsupported') {
    nodes.push(ui.text({ key: 'result-svg-status', text: 'Native SVG display unavailable in this Tern pane' }))
  } else if (state?.state === 'invalid') {
    nodes.push(ui.text({ key: 'result-svg-status', text: sanitizeDisplayText(`Drawing unavailable — ${state.reason}`) }))
  }
  return nodes
}

/**
 * PR-C: the result segment of one tool row.
 *
 * A row WITHOUT an image block keeps its EXACT previous shape: ONE `ui.code`
 * with the flat shown result. A row WITH an image block renders block-wise,
 * in block order, so the text and the image interleave exactly as the tool
 * produced them.
 * @param message - the tool row (top level or PTC child).
 * @param options - the mapper inputs.
 * @param wrap - whether the parent wraps its body.
 * @param flatText - the flat result text (the settled-answer authority for a
 *   top-level `ask_user_question` row, the child's own result for a child).
 */
function toolResultNodes(
  message: TranscriptToolMessage,
  options: TranscriptViewOptions,
  wrap: boolean,
  flatText: string,
): Node[] {
  if (message.name === 'dsh_pi_tui_chart') return chartResultNodes(message, options, wrap, flatText)
  if (message.name === 'dsh_pi_tui_svg') return svgResultNodes(message, options, wrap, flatText)
  if (toolRowProjectsImages(message)) {
    return imageResultNodes(message.resultBlocks ?? [], options, wrap)
  }
  if (flatText === '') return []
  return [ui.code({ key: 'result', text: sanitizeDisplayText(flatText), ...(wrap ? { wrap: true } : {}) })]
}

/** The ordered body parts of one tool row: its args and its result segment. */
interface ToolBodyParts {
  readonly args: Node[]
  readonly result: Node[]
}

function toolBodyParts(
  message: Extract<TranscriptMessage, { kind: 'tool' }>,
  options: TranscriptViewOptions,
  wrap = false,
): ToolBodyParts {
  const args: Node[] = []
  if (message.args !== '') args.push(ui.code({ key: 'args', text: sanitizeDisplayText(message.args), ...(wrap ? { wrap: true } : {}) }))
  // The body is decided by the SHOWN result, never by the recorded payload: a
  // running `ask_user_question` row can carry an empty recorded result while
  // the official projection already settled it, and the settled batch is still
  // the authority. An absent lookup answers `''` and omits the body exactly as
  // before, so an ordinary tool row is unchanged.
  return { args, result: toolResultNodes(message, options, wrap, shownToolResult(message, options)) }
}

/**
 * The result body of one tool row. PR3-B B3 (§3.9): an `ask_user_question`
 * row carrying an official `callId` shows the AUTHORITATIVE settled answer
 * batch when the projection has one. An ABSENT settled entry falls back to the
 * call's own recorded result; an EMPTY batch is a real settled outcome (a late
 * reply settled the question without a readable batch) and must NOT fall back
 * to the timeout payload it replaced.
 */
function shownToolResult(message: Extract<TranscriptMessage, { kind: 'tool' }>, options: TranscriptViewOptions): string {
  if (message.name !== 'ask_user_question' || message.callId === undefined) return message.result
  const settled = options.settledQuestionAnswersLookup?.(message.callId)
  return settled === undefined ? message.result : JSON.stringify({ answers: settled })
}

/**
 * PR-B2: one native INLINE tool node for one PTC sub-call. Identity is the
 * child's own durable `subCallId` (never its name, its array position or the
 * parent's revision); header, target and status come from the same authorities
 * as the top-level row (`toolCardHeader`, `subCallDisplayStatus`). The body is
 * the complete child output, wrapped; a child with no header summary shows its
 * raw args instead of a headless empty card.
 */
function childToolNode(child: TranscriptToolMessage, options: TranscriptViewOptions): Node {
  const header = toolCardHeader(child.name, child.args, options.cwd)
  const body: Node[] = []
  if (header.summary === '' && child.args !== '') {
    body.push(ui.code({ key: 'args', text: sanitizeDisplayText(child.args), wrap: true }))
  }
  // A nested SVG's source lives in its call args, which this child card does
  // not otherwise display (the visual tools always have a title summary). The
  // admitted source is added here so the child has the SAME readable-source
  // path as the top-level card instead of only claiming it is available.
  if (child.name === 'dsh_pi_tui_svg') {
    const state = child.status === 'ok' ? options.toolSvgStates?.get(child) : undefined
    if (state?.state === 'ready' || state?.state === 'unsupported') {
      body.push(ui.code({ key: 'source', text: sanitizeDisplayText(state.source), wrap: true }))
    }
  }
  body.push(...toolChildNodes(child, options))
  // PR-C: the child projects ITS OWN result blocks (recursively, with the
  // same rule as a top-level row) — the parent's result never leaks into it.
  body.push(...toolResultNodes(child, options, true, child.result))
  return ui.tool(
    {
      key: `sub-${child.subCallId!}`,
      frame: 'inline',
      name: sanitizedPhysicalLine(child.name),
      title: sanitizedPhysicalLine(header.title),
      status: toolStatus(subCallDisplayStatus(child)),
      ...(header.summary === '' ? {} : {
        target: sanitizedPhysicalLine(header.summary),
        // A child target is presentation text only: no registered-tool
        // provenance is consulted, so no command/path/pattern kind is guessed.
        targetKind: 'text',
      }),
    },
    ...body,
  )
}

/**
 * The ordered nested-call block of one tool card: the direct-child count head,
 * then each child's own native inline tool in durable dispatch order. The
 * count is the DIRECT children of this card; a child with grandchildren runs
 * this same rule one level down (never a Work-level lookup).
 */
function toolChildNodes(parent: TranscriptToolMessage, options: TranscriptViewOptions): Node[] {
  const subCalls = parent.subCalls
  if (subCalls === undefined || subCalls.length === 0) return []
  return [
    ui.text({ key: 'child-head', text: `Child calls · ${subCalls.length}` }),
    ...subCalls.map(child => childToolNode(child, options)),
  ]
}

function toolNode(message: Extract<TranscriptMessage, { kind: 'tool' }>, key: string, options: TranscriptViewOptions): Node {
  const header = toolCardHeader(message.name, message.args, options.cwd)
  // PR-B2: only a parent that carries PTC children gets the wrapped parent
  // body and the nested block; every other tool row keeps its previous view
  // shape and SDK props byte-identically. The order is fixed:
  // parent args -> child block -> parent result.
  const hasChildren = (message.subCalls?.length ?? 0) > 0
  const body = toolBodyParts(message, options, hasChildren)
  if (isUnmatchedToolRow(message)) {
    const provenance = message.origin === 'tool-not-started' ? 'not started' : 'unmatched result'
    // PR-C: an unmatched row shows ITS OWN image blocks inside the existing
    // warning card; the provenance badge and the card's shape are unchanged.
    return ui.card(
      { key, head: sanitizedPhysicalLine(header.title), tone: 'warning' },
      ui.badge({ key: 'provenance', text: provenance }),
      ...body.args,
      ...body.result,
    )
  }
  return ui.tool(
    {
      key,
      name: sanitizedPhysicalLine(message.name),
      title: sanitizedPhysicalLine(header.title),
      status: toolStatus(message.status),
      // PR-B1: the target KIND is the ONLY thing that changes. The displayed
      // string, the body, the key and the status are byte-identical to the
      // plain row; a row whose target is not PROVEN by the registered tool's
      // own presentation view keeps the plain `text` kind.
      ...(header.summary === '' ? {} : {
        target: sanitizedPhysicalLine(header.summary),
        targetKind: toolTargetKind(
          header.summary,
          toolTargetFactsOf(options.toolPresenter, message),
          options.cwd,
        ),
      }),
    },
    ...body.args,
    ...toolChildNodes(message, options),
    ...body.result,
  )
}

/**
 * The safe body of one injected Context row through the existing
 * `systemContextBody` helper (never a raw `<system-reminder>` XML envelope);
 * a body that is not an envelope at all is shown verbatim.
 */
function contextBodyNodes(message: Extract<TranscriptMessage, { kind: 'system' }>): Node[] {
  const body = systemContextBody(message.text)
  if (body === undefined) return [ui.md({ key: 'body', text: sanitizeDisplayText(message.text) })]
  if (body.length === 0) return []
  return [ui.code({ key: 'body', text: sanitizeDisplayText(body.join('\n')) })]
}

function systemNode(message: Extract<TranscriptMessage, { kind: 'system' }>, key: string): Node {
  if (message.context === true) {
    const kind = contextPresentationKind(message)
    const head = sanitizedPhysicalLine(message.label ?? contextFormOf(message) ?? 'Context')
    return ui.card(
      { key, head },
      ui.badge({ key: 'kind', text: kind ?? 'generic' }),
      ...contextBodyNodes(message),
    )
  }
  // Non-context system rows are orchestration evidence (llm-retry /
  // turn-max-tokens); they are never turn-foundation Context.
  return ui.card({ key, head: message.origin ?? 'System' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
}

function commandNode(message: Extract<TranscriptMessage, { kind: 'command' }>, key: string): Node {
  const name = message.name ?? 'command'
  const head = sanitizedPhysicalLine(message.args === null || message.args === '' ? `/${name}` : `/${name} ${message.args}`)
  const outcome = message.outcome
  // The official `command/done` kind is the only status authority: a run
  // without a done is running, and a fragment-only fallback invents nothing.
  const status: Status = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'done'
  const body = outcome?.text === undefined || outcome.text === '' ? [] : [ui.md({ key: 'body', text: sanitizeDisplayText(outcome.text) })]
  return ui.card({ key, head, status }, ...body)
}

function compactionNode(message: Extract<TranscriptMessage, { kind: 'compaction' }>, key: string): Node {
  const status: Status = message.error !== undefined && message.error !== ''
    ? 'error'
    : message.running === true ? 'running' : 'done'
  const body = message.text === '' ? [] : [ui.md({ key: 'body', text: sanitizeDisplayText(message.text) })]
  return ui.card(
    { key, head: 'Compaction', status },
    ui.badge({ key: 'counts', text: `${message.items} items · ${message.tokens} tokens` }),
    ...body,
  )
}

function workflowNode(message: Extract<TranscriptMessage, { kind: 'workflow' }>, key: string): Node {
  return ui.card(
    { key, head: sanitizedPhysicalLine(message.name) },
    ui.badge({ key: 'state', text: message.status }),
    ui.badge({ key: 'members', text: `${message.members.length} members` }),
  )
}

/** One native node for one non-structural transcript row. */
function messageNode(message: TranscriptMessage, key: string, options: TranscriptViewOptions): Node {
  switch (message.kind) {
    case 'user':
      return ui.card({ key, head: 'You' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
    case 'assistant':
      return ui.card({ key, head: 'Assistant' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
    case 'thinking':
      return ui.card(
        { key, head: 'Thinking', ...(message.running === true ? { status: 'running' } : {}) },
        ui.md({ key: 'body', text: sanitizeDisplayText(message.text), ...(message.running === true ? { stream: true } : {}) }),
      )
    case 'tool':
      return toolNode(message, key, options)
    case 'system':
      return systemNode(message, key)
    case 'command':
      return commandNode(message, key)
    case 'compaction':
      return compactionNode(message, key)
    case 'workflow':
      return workflowNode(message, key)
    case 'summary':
      return ui.card({ key, head: 'Earlier turns' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
  }
}

/**
 * PR-B3: ONE read-only Preparing row for one live tool call whose arguments
 * are still streaming. The row is plain TEXT on the native `row` kind: no
 * badge, no status, no icon, no timer, no action — a Preparing row states
 * that arguments are arriving, never that a tool is running or done.
 *
 * The content is read, never re-derived: the name is the stream's own tool
 * name (through the shared `toolTitle` table), the summary is the owner's
 * already-extracted field (sanitized and folded to one line, then
 * display-relativized against the workspace root) and the byte count is the
 * owner's exact UTF-8 count through the shared `formatBytes`. The partial
 * argument prefix and the start time never reach the view.
 *
 * The identity is the call's own id when it arrived, and the durable
 * turn/step/index position before that — never the summary, the name or the
 * byte count (a byte update must not re-key the row).
 * @param cwd - the workspace root for the display-only path relativization.
 * @param keyPrefix - the scope prefix of a STANDALONE row (a row inside a
 * Work section is already scoped by its section's own id).
 */
function preparingRow(
  preview: StreamingToolPreview,
  cwd: string | undefined,
  keyPrefix: string,
): Node {
  const key = `preparing-${preview.callId === ''
    ? `idx-${preview.turn}-${preview.step}-${preview.index}`
    : preview.callId}`
  const name = preview.name ?? ''
  const title = name === '' ? 'Preparing tool…' : `Preparing ${toolTitle(name)}…`
  const summary = preview.summary === undefined
    ? undefined
    : relativizeToCwd(sanitizeDisplayText(preview.summary).replace(/\r\n|\r|\n/g, ' '), cwd)
  return ui.row(
    { key: `${keyPrefix}${key}`, wrap: true },
    ui.text({ key: 'label', text: sanitizeDisplayText(title) }),
    ...(summary === undefined ? [] : [ui.text({ key: 'summary', text: ` · ${summary}` })]),
    ui.text({ key: 'bytes', text: ` · ${formatBytes(preview.argumentBytes)}` }),
  )
}

/**
 * PR-B3: the Preparing previews grouped by their durable turn — ascending
 * turn, and inside a group ascending index. A local, per-call projection: no
 * long-lived map, no second preview authority and no cached order.
 */
function groupPreparingPreviews(
  previews: readonly StreamingToolPreview[],
): [number, StreamingToolPreview[]][] {
  const groups = new Map<number, StreamingToolPreview[]>()
  for (const preview of previews) {
    const group = groups.get(preview.turn)
    if (group === undefined) groups.set(preview.turn, [preview])
    else group.push(preview)
  }
  for (const group of groups.values()) group.sort((left, right) => left.index - right.index)
  return [...groups.entries()].sort((left, right) => left[0] - right[0])
}

/** One native Work container keyed by its canonical span owner. Its ordered
 * structural parts place a carried snapshot-only Context cluster as a nested
 * `clusterNode` card; the flat member sequence is never re-derived here. The
 * optional Preparing rows are the LAST children of the section: they follow
 * every durable part of the open run. */
function workNode(
  span: TranscriptWorkSpan,
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
  prefix: string,
  previews: readonly StreamingToolPreview[] = [],
): Node {
  const head: Spans = ['Work', ` · turn ${span.turn}`]
  return ui.section(
    { key: `${prefix}work-${keys.keyFor(span.owner)}`, head },
    ...span.parts.map(part => part.kind === 'message'
      ? messageNode(part.message, keys.keyFor(part.message), options)
      : clusterNode(part.cluster, keys, options, prefix)),
    ...previews.map(preview => preparingRow(preview, options.cwd, '')),
  )
}

/** One native Context container keyed by its canonical cluster owner. */
function clusterNode(cluster: ContextCluster, keys: TranscriptNodeKeys, options: TranscriptViewOptions, prefix: string): Node {
  const parts = contextClusterSummaryParts(cluster)
  return ui.card(
    { key: `${prefix}ctx-${keys.keyFor(cluster.owner)}`, head: parts.length === 0 ? 'Context' : sanitizedPhysicalLine(parts.join(' · ')) },
    ...cluster.members.map(member => messageNode(member, keys.keyFor(member), options)),
  )
}

/**
 * Map the canonical structural blocks of one transcript window onto a native
 * TSP view: the whole structure as ONE `col` root, in raw visual order.
 * @param structure - `projectTranscriptStructure()` output; the mapper never
 * re-derives a Work/Context boundary.
 * @param keys - the replay-local key allocator, one per surface lifetime.
 * @param options - explicit helper inputs (workspace root for tool summaries).
 */
export function transcriptView(
  structure: readonly TranscriptStructureBlock[],
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions = {},
): Node {
  // The scope prefix applies to the TOP-LEVEL block keys only: every nested
  // id derives from its parent's id, so the whole rendered subtree lands in
  // the new namespace without re-keying (or re-classifying) any row.
  const prefix = options.scopePrefix ?? ''
  // PR-B3: the Preparing placement is a PURE projection on the same canonical
  // structure — the mapper never re-groups a row, never opens an older Work
  // and never invents a Work owner. Only the TRAILING block may adopt
  // Preparing rows, and only for its OWN turn: that Work run is the one still
  // open at the end of the window. Every other turn fails open as standalone
  // rows after the transcript (ascending turn, then ascending index).
  const groups = groupPreparingPreviews(options.preparingPreviews ?? [])
  const trailing = structure.length === 0 ? undefined : structure[structure.length - 1]
  const openTurn = trailing?.kind === 'work' ? trailing.span.turn : undefined
  /** The rows the trailing open Work adopts (empty when it adopts none). */
  let adopted: readonly StreamingToolPreview[] = []
  /** The rows that stand alone after the transcript. */
  const standalone: Node[] = []
  for (const [turn, group] of groups) {
    if (turn === openTurn) {
      adopted = group
      continue
    }
    for (const preview of group) standalone.push(preparingRow(preview, options.cwd, prefix))
  }
  return ui.col(
    { key: 'transcript' },
    ...structure.map(block => {
      switch (block.kind) {
        case 'message':
          return messageNode(block.message, `${prefix}${keys.keyFor(block.message)}`, options)
        case 'work':
          return workNode(block.span, keys, options, prefix, block === trailing ? adopted : [])
        case 'context-cluster':
          return clusterNode(block.cluster, keys, options, prefix)
      }
    }),
    ...standalone,
  )
}
