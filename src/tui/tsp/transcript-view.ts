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
import type { DisplayPreset } from '../../domain/display/preset.ts'
import type { SettledQuestionAnswersLookup } from '../../app/surface/interaction-presenter.ts'
import type { StreamingToolPreview } from '../../app/surface/streaming-tool-preparing.ts'
import { contextFormOf } from '../../domain/transcript/context-semantics.ts'
import { eligibleFinalAssistant } from '../../domain/transcript/final-assistant.ts'
import { displayFailureText } from '../../domain/transcript/failure.ts'
import {
  assistantPresentationRevision,
  subCallDisplay,
  transcriptDisplayRevisionOf,
  transcriptTimingOf,
  type SubCallTerminalFailure,
} from '../../domain/transcript/folder.ts'
import { formatBytes } from '../../domain/media/format.ts'
import type { ImageAttachmentRefLike } from '../../domain/media/types.ts'
import type { RunPhase } from '../../domain/status/types.ts'
import { THINKING_TAIL_CAP, type AssistantDisplayBlock, type TranscriptMessage, type TranscriptToolMessage, type TurnActivity } from '../../domain/transcript/types.ts'
import type { TranscriptWindowState } from '../../domain/transcript/window.ts'
import { contextPresentationKind } from '../transcript/context-structure.ts'
import type { ContextCluster } from '../transcript/context-structure.ts'
import { contextClusterSummaryParts } from '../transcript/context-summary.ts'
import { projectCompact, type CompactProjectedBlock } from '../transcript/compact-projection.ts'
import type { TranscriptContainerPath } from '../transcript/container-owner.ts'
import { resolveWorkLifetimes, type WorkLifetime } from '../transcript/activity-clock.ts'
import { compactActionBody, compactActionPresentation, compactPreparingSummary, latestReasoningLine } from '../components/transcript/compact-process-preview.ts'
import { focusStatusLabel } from '../components/transcript/focus-activity.ts'
import { compactActionStatParts, formatCompactDuration, type CompactActionSource, type CompactActionStats } from '../transcript/process-summary.ts'
import { projectFocus, type FocusProjectedBlock } from '../transcript/focus-projection.ts'
import type { TranscriptStructureBlock, TranscriptWorkSpan } from '../transcript/structure.ts'
import { projectTranscriptStructure } from '../transcript/structure.ts'
import { summarizeWorkSpan } from '../transcript/work-summary.ts'
import { systemContextBody, toolCardHeader, toolTitle, relativizeToCwd } from '../transcript/tool-presentation.ts'
import type { ToolPresenter } from '../transcript/tool-presentation.ts'
import { toolTargetFactsOf, toolTargetKind } from '../transcript/tool-target-semantics.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { formatTokens } from '../token-format.ts'
import { chartHumanText, chartProjection, chartValueRows, type ChartFact } from '../../domain/visual/chart.ts'
import { svgDetailRows, type SvgFact } from '../../domain/visual/svg.ts'
import { visualParts, visualPartsFromText } from '../../domain/visual/visual-facts.ts'
import { humanFacingVisualResult, type PublishedVisual } from '../../domain/visual/publication.ts'
import { assistantVisualPresentation, assistantVisualPresentationRevision } from '../../domain/visual/presentation.ts'
import { CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME } from '../../domain/visual/tools.ts'
import {
  assistantPublishedVisualNodes,
  type SelectedVisualState,
} from './assistant-visual.ts'
import { TRANSCRIPT_COPY_ACTION, transcriptCopyPayload } from './transcript-copy.ts'

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
   * The renderer-local revision of the settled-answer lookup above. A settled
   * Question repaints a row whose canonical message did not change, so the
   * lookup's own version joins that row's display stamp.
   */
  readonly settledQuestionAnswersRevision?: number
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
   *
   * Every row kind shares this ONE map: a User/Assistant body image, a Tool
   * result image and a recalled draft all name a durable attachment of the
   * same display subject, so a per-role image state would be a second truth.
   */
  readonly imageStates?: ReadonlyMap<string, ToolImageState>
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
  /**
   * PR-D RFL-016: the tool-card keys the user has EXPANDED. Present (even as
   * an empty set) means the Tern disclosure contract is active: a ready SVG
   * card starts collapsed, and its blob/image is only requested after the
   * user's `toggle` expansion. Absent keeps the mapper's former expanded
   * default for pure projections/tests.
   */
  readonly expandedToolKeys?: ReadonlySet<string>
  /** Renderer-local inner disclosure owners. Absent preserves legacy fail-open mapping. */
  readonly innerDisclosure?: {
    readonly expandedThinkingOwners: ReadonlySet<TranscriptMessage>
    readonly expandedContextRowOwners: ReadonlySet<TranscriptMessage>
    readonly expandedClusterOwners: ReadonlySet<TranscriptMessage>
  }
  /**
   * PR3: whether the pane negotiated the `image` kind AND the `blobs` feature.
   * An Assistant-published SVG draws its native image only when this is true;
   * its readable description is drawn in every case.
   */
  readonly nativeImagesSupported?: boolean
  /**
   * PR3: the session owner's synchronous display-demand sender for one
   * admitted Assistant-published SVG. The mapper calls it only while
   * projecting the image node it belongs to; an absent sender draws no image.
   */
  readonly requestPublishedSvgBlob?: (publication: PublishedVisual) => string | undefined
  /**
   * PR3: the current window's selected figure (session-owned state). It is
   * painted only on the matching published figure.
   */
  readonly selectedVisual?: SelectedVisualState
  /** Native transcript Copy is opt-in for the production mount. */
  readonly transcriptCopy?: { readonly action: 'dsh-transcript-copy' }
  /** The same frame-local raw payloads indexed by the Session event owner. */
  readonly transcriptCopyPayloads?: ReadonlyMap<TranscriptMessage, string>
  /** Settled final-Assistant metadata derived once from the current turn snapshot. */
  readonly transcriptStats?: ReadonlyMap<Extract<TranscriptMessage, { kind: 'assistant' }>, readonly string[]>
}

/** Explicit inputs for the typed Full/Compact entry. It keeps the old
 *  `transcriptView` structural contract unchanged for standalone pure mounts
 *  and takes the RAW window so Compact consumes the same canonical projection
 *  input as Full, never a flattened/re-derived row sequence. */
export interface TranscriptPresetViewOptions extends TranscriptViewOptions {
  readonly preset: DisplayPreset
  /** The renderer-local Compact Work-span disclosure owners (object identity). */
  readonly expandedWorkOwners?: ReadonlySet<TranscriptMessage>
  /** The renderer-local Focus semantic disclosure owners (turn identity). */
  readonly expandedFocusTurns?: ReadonlySet<number>
  /** The formally committed run phase; absent means no status claim is made. */
  readonly focusPhase?: RunPhase
  /** Active elapsed values sampled by the session at its formal commit point. */
  readonly focusElapsedMs?: ReadonlyMap<TurnActivity, number>
  /** The current committed turn-boundary facts from the same transcript
   *  snapshot. Used only to resolve proven Activity close times; never as a
   *  Work stats or preview authority. */
  readonly turnActivities?: ReadonlyMap<number, TurnActivity>
  /** The current committed transcript window, read only for the tail/latest
   *  preview admission. */
  readonly window?: (TranscriptWindowState & { readonly hasNewer?: boolean }) | undefined
}

/** PR-D: one SVG row's prepared display state. */
export type ToolSvgState =
  /** The pane carries `image` + `blobs` and the source was admitted. The
   *  blob is sent lazily by the actual projection (`request`), not by the
   *  pre-projection authorization pass; `blobId` is an optional already-sent
   *  fast path used by tests. */
  | {
    readonly state: 'ready'
    readonly fact: SvgFact
    readonly source: string
    readonly blobId?: string
    readonly request: () => string | undefined
  }
  /** The pane negotiated no native image/blob capability; the admitted
   *  source is still available for the readable top-level/child card. */
  | { readonly state: 'unsupported'; readonly fact: SvgFact; readonly source: string }
  /** The final content did not authorize a drawing (or admission refused it). */
  | { readonly state: 'invalid'; readonly reason: string }

function normalizeTopLevelDisclosure(segment: string, scopePrefix: string): string | undefined {
  if (segment.startsWith(`${scopePrefix}msg-`)) return segment.slice(scopePrefix.length)
  if (segment.startsWith('msg-')) return segment
  return undefined
}

/** PR-D RFL-018/RFL-019: validate a Tern toggle against the CURRENT source
 * scope and derive the parent-scoped disclosure identity. It handles Work
 * cards (`...s1-work-msg-1.msg-2`), standalone cards (the key itself is
 * `s1-msg-2`), and children whose `subCallId` may contain dots (the Folder
 * does not restrict them): the SDK node key is a KNOWN suffix, so it is
 * stripped instead of split. A late event from an older `s0-` projection is
 * ignored before any disclosure state changes. SDK node keys stay untouched. */
export function disclosureKeyForToggle(
  eventId: string,
  key: string | undefined,
  scopePrefix: string,
): string | undefined {
  if (scopePrefix === '' || !eventId.includes(`.${scopePrefix}`)) return undefined
  const nodeKey = key !== undefined && key !== '' ? key : eventId.slice(eventId.lastIndexOf('.') + 1)
  if (nodeKey === '' || !eventId.endsWith(`.${nodeKey}`)) return undefined
  const own = normalizeTopLevelDisclosure(nodeKey, scopePrefix)
  if (own !== undefined) return own
  const parentId = eventId.slice(0, eventId.length - nodeKey.length - 1)
  const parentSegments = parentId.split('.')
  const topIndex = parentSegments.findIndex(segment => normalizeTopLevelDisclosure(segment, scopePrefix) !== undefined)
  if (topIndex < 0) return undefined
  const top = normalizeTopLevelDisclosure(parentSegments[topIndex]!, scopePrefix)!
  return [top, ...parentSegments.slice(topIndex + 1), nodeKey].join('/')
}

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
  /** The user disabled image preview through PI_IMAGE_PROTOCOL. */
  | { readonly state: 'disabled' }
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
 *
 * Exported for the dock's draft projection, so a staged image and a durable
 * attachment cannot disagree about their display identity.
 */
export function imageDisplayName(ref: unknown): string {
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
 *
 * Exported (with {@link imageStatusText}) so the dock's draft rows reuse this
 * ONE identity/status vocabulary instead of formatting a second one.
 */
export function imageIdentityText(ref: unknown): string {
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
export function imageStatusText(state: ToolImageState): string | undefined {
  switch (state.state) {
    case 'unsupported': return 'Native image display unavailable in this Tern pane'
    case 'disabled': return 'Image preview disabled by PI_IMAGE_PROTOCOL'
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
 * `keyPrefix` is the row's OWN block namespace (`result-b` for a tool card
 * body, `body-b` for a User/Assistant message body): two rows under the same
 * parent card must never share a block key.
 */
function imageBlockNodes(
  block: ProjectedImageBlock,
  state: ToolImageState | undefined,
  keyPrefix: 'result-b' | 'body-b',
): Node[] {
  const problem = imageRefProblem(block.attachment)
  const identity = imageIdentityText(block.attachment)
  if (problem !== undefined) {
    const phrase = problem === 'invalid' ? 'Invalid image attachment' : 'Unsupported image format'
    return [ui.text({ key: `${keyPrefix}${block.index}-info`, text: sanitizeDisplayText(`${identity} · ${phrase}`) })]
  }
  const alt = sanitizeDisplayText(imageDisplayName(block.attachment))
  const status = state === undefined ? 'Native image display unavailable in this Tern pane' : imageStatusText(state)
  const info = status === undefined ? identity : `${identity} · ${status}`
  const nodes: Node[] = [ui.text({ key: `${keyPrefix}${block.index}-info`, text: sanitizeDisplayText(info) })]
  if (state === undefined || state.state === 'unsupported' || state.state === 'disabled' || state.state === 'no-scope') return nodes
  const blob = state.state === 'ready' ? state.blobId : PENDING_IMAGE_BLOB_ID
  nodes.push(ui.image({ key: `${keyPrefix}${block.index}-image`, blob, alt }))
  return nodes
}

/**
 * PR4: the frozen dock draft-preview width policy, in SDK `caps.cols` — the
 * ONLY width authority the protocol publishes (there is no pane-rows fact, so
 * no height rule can be inferred here):
 *
 * - `>= 100` columns: up to {@link DOCK_DRAFT_MAX_PREVIEWS} native previews;
 * - `72 … 99`: at most ONE;
 * - `< 72` (and any pane without `image`+`blobs`): none.
 */
export const DOCK_DRAFT_SINGLE_PREVIEW_COLS = 72
export const DOCK_DRAFT_TWO_PREVIEW_COLS = 100
export const DOCK_DRAFT_MAX_PREVIEWS = 2

/** PR4: one staged draft occurrence, already reduced to its display facts. */
export interface DockDraftImageEntry {
  /** The staged draft's own id (the `[image #N …]` token identity). */
  readonly id: number
  /** The occurrence's 0-based rank among the draft's canonical occurrences. */
  readonly ordinal: number
  /** The `#N · WxH` caption the chip shows (already sanitized by the caller). */
  readonly caption: string
  /** The native node's accessible name (the sanitized display identity). */
  readonly name: string
  /** The prepared render state, or `undefined` when none was prepared. */
  readonly state: ToolImageState | undefined
}

/**
 * The frozen per-preview node bounds (Owner amendendment, 2026-10-25): OMP's
 * `12ch × 4lines` cap on the native image node. This is a RESPONSIVE CEILING,
 * not a fixed pixel size — the image keeps its own aspect ratio inside it, and
 * it is the reason a split pane stays compact even where the window media query
 * cannot fire.
 */
export const DOCK_DRAFT_PREVIEW_MAX = { w: '12ch', h: '4lines' } as const

/** The stylesheet role the ONE preview row carries (the sheet's selector). */
export const DOCK_DRAFT_PREVIEW_ROLE = 'dsh.draft-preview'

/**
 * PR4: the dock's draft-preview band — a PURE projection of already-prepared
 * state, exactly like the transcript image nodes.
 *
 * The shape is fixed by the product contract: ONE `ui.row` holding up to
 * `previewLimit` chips side by side, each chip being its native image plus one
 * compact `#id · W×H` caption. There is deliberately no extra title line and no
 * per-image identity line outside the chip, because every extra row competes
 * with the controlled editor for the dock's height.
 *
 * The caller prepares the blob/read state and decides `previewLimit` from the
 * negotiated capabilities alone; this function never reads bytes, never calls
 * the SDK and never consults a store. It returns `undefined` when nothing may
 * be drawn, so a caller cannot wrap the result in a second preview container.
 */
export function dockDraftImageNodes(
  entries: readonly DockDraftImageEntry[],
  previewLimit: number,
): Node | undefined {
  if (entries.length === 0 || previewLimit <= 0) return undefined
  const shown = entries.slice(0, previewLimit)
  const chips: Node[] = []
  for (const entry of shown) {
    const children: Node[] = []
    const state = entry.state
    if (state?.state === 'ready') {
      // ONLY a READY blob produces a native image node. Every other state —
      // including `loading` — draws text, so a chip can never reference a blob
      // id that was not really sent.
      children.push(ui.image({
        key: 'image',
        blob: state.blobId,
        alt: sanitizeDisplayText(entry.name),
        max: DOCK_DRAFT_PREVIEW_MAX,
      }))
    } else {
      // `loading`, `error`, `no-scope`, `too-large`, `unsupported`, or no state
      // prepared: the chip states that truthfully. A pending read shows the
      // fixed `Preview unavailable` phrase rather than a placeholder bitmap,
      // because a bitmap would claim bytes the pane does not have yet.
      children.push(ui.text({
        key: 'unavailable',
        text: 'Preview unavailable',
        wrap: 'none',
        max: { w: DOCK_DRAFT_PREVIEW_MAX.w },
      }))
    }
    children.push(ui.text({
      key: 'caption',
      text: sanitizeDisplayText(entry.caption),
      wrap: 'none',
      max: { w: DOCK_DRAFT_PREVIEW_MAX.w },
    }))
    chips.push(ui.col({ key: `draft-chip-${entry.id}-${entry.ordinal}`, gap: 'none' }, ...children))
  }
  return ui.row(
    { key: 'draft-preview', role: DOCK_DRAFT_PREVIEW_ROLE, wrap: false, gap: 'sm' },
    ...chips,
  )
}

/**
 * PR4: a bounded, PAYLOAD-FREE type tag for one block the TSP mapper does not
 * present. The durable block object never reaches the terminal — no serialized
 * JSON, no bytes, no path — only its type name does, so an unknown future
 * block stays visible as a fact instead of being silently dropped.
 */
function typedBlockText(label: 'Unknown block' | 'Open block', type: unknown): string {
  const raw = typeof type === 'string' ? sanitizeDisplayText(type).replace(/[\t\r\n]+/g, ' ').trim() : ''
  const bounded = raw === '' ? 'unknown' : raw.length <= 60 ? raw : `${raw.slice(0, 59)}…`
  return `${label} · ${bounded}`
}

/**
 * PR4: the block-wise body of ONE User/Assistant message: every non-empty
 * text block stays its own `ui.md`, every image block becomes its identity
 * line plus the native image node, and every block type the mapper does not
 * present degrades to its payload-free type tag.
 *
 * The image state is looked up in the SAME {@link TranscriptViewOptions.imageStates}
 * map the Tool path consumes: all three roles present durable attachments of
 * the one display subject, so a per-role state would be a second truth.
 */
function bodyBlockNodes(block: ContentBlock, index: number, options: TranscriptViewOptions): Node[] {
  if (block.type === 'text') {
    if (block.text === '') return []
    return [ui.md({ key: `body-b${index}-text`, text: sanitizeDisplayText(block.text) })]
  }
  if (block.type === 'image') {
    // A malformed reference is NEVER read and never looked up: it renders its
    // own failure line, not a state the reader has to interpret.
    const state = isPresentableImageRef(block.attachment)
      ? options.imageStates?.get(block.attachment.attachmentId)
      : undefined
    return imageBlockNodes({ index, attachment: block.attachment }, state, 'body-b')
  }
  return [ui.text({ key: `body-b${index}-block`, text: sanitizeDisplayText(typedBlockText('Unknown block', block.type)) })]
}

/**
 * PR4: the ordered body of one User/Assistant message whose content really
 * carries non-text blocks. The flat `message.text` is NOT drawn beside it —
 * the blocks are the authority and joining them would duplicate the body.
 */
function bodyContentNodes(blocks: readonly ContentBlock[], options: TranscriptViewOptions): Node[] {
  return blocks.flatMap((block, index) => bodyBlockNodes(block, index, options))
}

/**
 * PR4: the ordered body of one Assistant message that carries
 * `displayBlocks` — the presentation-only evidence of an OPEN opaque block.
 * A `content` member renders exactly like the settled body; an `open-opaque`
 * member states its type and that it is still pending, and NEVER fabricates a
 * blob or an image node. The two lists are never mixed: the caller chooses
 * one authority, so no image can be drawn twice.
 */
function assistantDisplayNodes(
  blocks: readonly AssistantDisplayBlock[],
  options: TranscriptViewOptions,
): Node[] {
  return blocks.flatMap((displayBlock, index) => displayBlock.kind === 'open-opaque'
    ? [ui.text({ key: `body-b${index}-block`, text: sanitizeDisplayText(`${typedBlockText('Open block', displayBlock.blockType)} · pending`) })]
    : bodyBlockNodes(displayBlock.block, index, options))
}

/** Whether one chosen block list must render block-wise: it carries at least
 *  one image the reader has to see. A list without an image keeps the legacy
 *  single flat body and its stable `body` key. */
function bodyHasImage(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image')
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
      ? options.imageStates?.get(block.attachment.attachmentId)
      : undefined
    nodes.push(...imageBlockNodes(projected, state, 'result-b'))
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
  collapsed: boolean,
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
  if (state?.state === 'ready' && !collapsed) {
    // The blob sender runs HERE, when the image node is actually projected;
    // authorization alone no longer sends bytes before the Tool Card body.
    const blobId = state.blobId ?? state.request()
    if (blobId !== undefined) {
      nodes.push(ui.image({ key: 'result-svg', blob: blobId, alt: sanitizedPhysicalLine(state.fact.title) }))
    } else {
      nodes.push(ui.text({ key: 'result-svg-status', text: 'Native SVG display unavailable in this Tern pane' }))
    }
  } else if (state?.state === 'unsupported') {
    nodes.push(ui.text({ key: 'result-svg-status', text: 'Native SVG display unavailable in this Tern pane' }))
  } else if (state?.state === 'invalid') {
    nodes.push(ui.text({ key: 'result-svg-status', text: sanitizeDisplayText(`Drawing unavailable — ${state.reason}`) }))
  }
  return nodes
}

/**
 * The publication tool's result segment: its human summary as one `ui.code`
 * row. The `visual-published-v1:` receipt is a durable machine block that no
 * human-facing surface displays, so the SAME source-aware projection the PiTui
 * cards use strips it here; a failure keeps its own readable reason.
 */
function presentVisualResultNodes(
  message: TranscriptToolMessage,
  wrap: boolean,
  flatText: string,
): Node[] {
  const human = humanFacingVisualResult({
    toolName: PRESENT_VISUAL_TOOL_NAME,
    blocks: message.resultBlocks,
    text: flatText,
  })
  return human.text === ''
    ? []
    : [ui.code({ key: 'result', text: sanitizeDisplayText(human.text), ...(wrap ? { wrap: true } : {}) })]
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
  collapsed = false,
): Node[] {
  if (message.name === CHART_TOOL_NAME) return chartResultNodes(message, options, wrap, flatText)
  if (message.name === SVG_TOOL_NAME) return svgResultNodes(message, options, wrap, flatText, collapsed)
  if (message.name === PRESENT_VISUAL_TOOL_NAME) return presentVisualResultNodes(message, wrap, flatText)
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
  collapsed = false,
): ToolBodyParts {
  const args: Node[] = []
  if (message.args !== '') args.push(ui.code({ key: 'args', text: sanitizeDisplayText(message.args), ...(wrap ? { wrap: true } : {}) }))
  // The body is decided by the SHOWN result, never by the recorded payload: a
  // running `ask_user_question` row can carry an empty recorded result while
  // the official projection already settled it, and the settled batch is still
  // the authority. An absent lookup answers `''` and omits the body exactly as
  // before, so an ordinary tool row is unchanged.
  return { args, result: toolResultNodes(message, options, wrap, shownToolResult(message, options), collapsed) }
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
const TOOL_ERROR_NOTE_LIMIT = 180
const TOOL_ERROR_MARKER_LIMIT = 48

function boundedPhysicalPrefix(source: string, budget: number): string {
  const rawPrefix = source.slice(0, budget)
  const characters = Array.from(sanitizedPhysicalLine(rawPrefix).trim())
  const truncated = source.length > rawPrefix.length || characters.length > budget
  const visibleBudget = Math.max(0, budget - (truncated ? 1 : 0))
  return `${characters.slice(0, visibleBudget).join('')}${truncated ? '…' : ''}`
}

function terminalFailureMarker(failure: SubCallTerminalFailure): string {
  const raw = failure.kind === 'exit-code'
    ? `[exit code: ${failure.exitCode}]`
    : `[killed by signal: ${failure.signal}]`
  const rawPrefix = raw.slice(0, TOOL_ERROR_MARKER_LIMIT)
  const characters = Array.from(sanitizedPhysicalLine(rawPrefix))
  const truncated = raw.length > rawPrefix.length || characters.length > TOOL_ERROR_MARKER_LIMIT
  const visibleBudget = Math.max(0, TOOL_ERROR_MARKER_LIMIT - (truncated ? 1 : 0))
  return `${characters.slice(0, visibleBudget).join('')}${truncated ? '…' : ''}`
}

function toolErrorNote(
  message: TranscriptToolMessage,
  options: TranscriptViewOptions,
  displayStatus: TranscriptToolMessage['status'],
  terminalFailure?: SubCallTerminalFailure,
): string | undefined {
  if (displayStatus !== 'error') return undefined
  const marker = terminalFailure === undefined ? '' : terminalFailureMarker(terminalFailure)
  if (terminalFailure !== undefined) return marker
  const summary = boundedPhysicalPrefix(shownToolResult(message, options), TOOL_ERROR_NOTE_LIMIT)
  return summary === '' ? undefined : summary
}

function childToolNode(child: TranscriptToolMessage, options: TranscriptViewOptions, parentDisclosure: string): Node {
  const header = toolCardHeader(child.name, child.args, options.cwd)
  const childKey = `sub-${child.subCallId!}`
  const childDisclosure = `${parentDisclosure}/${childKey}`
  const display = subCallDisplay(child)
  const svgState = child.name === SVG_TOOL_NAME && child.status === 'ok'
    ? options.toolSvgStates?.get(child)
    : undefined
  const isSvg = child.name === SVG_TOOL_NAME
  const collapsible = options.expandedToolKeys !== undefined
    && !isUnmatchedToolRow(child)
    && (isSvg ? svgState?.state === 'ready' : options.innerDisclosure !== undefined)
  const collapsed = collapsible && !options.expandedToolKeys!.has(childDisclosure)
  const body: Node[] = []
  if (!collapsed) {
    if (header.summary === '' && child.args !== '') {
      body.push(ui.code({ key: 'args', text: sanitizeDisplayText(child.args), wrap: true }))
    }
    // The SDK child node key stays the existing B2 identity; disclosure state
    // remains parent-scoped so reused subCallIds never share an owner.
    if (svgState?.state === 'ready' || svgState?.state === 'unsupported') {
      body.push(ui.code({ key: 'source', text: sanitizeDisplayText(svgState.source), wrap: true }))
    }
    body.push(...toolChildNodes(child, options, childDisclosure))
    body.push(...toolResultNodes(child, options, true, child.result, false))
  }
  const note = toolErrorNote(child, options, display.status, display.terminalFailure)
  return ui.tool(
    {
      key: childKey,
      frame: 'inline',
      name: sanitizedPhysicalLine(child.name),
      title: sanitizedPhysicalLine(header.title),
      status: toolStatus(display.status),
      ...(collapsible ? { collapsible: true, collapsed } : {}),
      ...(note === undefined ? {} : { note }),
      ...(header.summary === '' ? {} : {
        target: sanitizedPhysicalLine(header.summary),
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
function toolChildNodes(parent: TranscriptToolMessage, options: TranscriptViewOptions, parentDisclosure: string): Node[] {
  const subCalls = parent.subCalls
  if (subCalls === undefined || subCalls.length === 0) return []
  return [
    ui.text({ key: 'child-head', text: `Child calls · ${subCalls.length}` }),
    ...subCalls.map(child => childToolNode(child, options, parentDisclosure)),
  ]
}

function toolNode(message: Extract<TranscriptMessage, { kind: 'tool' }>, key: string, options: TranscriptViewOptions): Node {
  const header = toolCardHeader(message.name, message.args, options.cwd)
  const hasChildren = (message.subCalls?.length ?? 0) > 0
  const svgState = message.name === SVG_TOOL_NAME && message.status === 'ok'
    ? options.toolSvgStates?.get(message)
    : undefined
  const isSvg = message.name === SVG_TOOL_NAME
  const disclosure = options.scopePrefix !== undefined && key.startsWith(options.scopePrefix)
    ? key.slice(options.scopePrefix.length)
    : key

  if (isUnmatchedToolRow(message)) {
    const body = toolBodyParts(message, options, hasChildren)
    const provenance = message.origin === 'tool-not-started' ? 'not started' : 'unmatched result'
    return ui.card(
      { key, head: sanitizedPhysicalLine(header.title), tone: 'warning' },
      ui.badge({ key: 'provenance', text: provenance }),
      ...body.args,
      ...body.result,
    )
  }

  const collapsible = options.expandedToolKeys !== undefined
    && (isSvg ? svgState?.state === 'ready' : options.innerDisclosure !== undefined)
  const collapsed = collapsible && !options.expandedToolKeys!.has(disclosure)
  const body = collapsed
    ? { args: [], result: [] }
    : toolBodyParts(message, options, hasChildren, false)
  const children = collapsed ? [] : toolChildNodes(message, options, disclosure)
  const note = toolErrorNote(message, options, message.status)
  return ui.tool(
    {
      key,
      name: sanitizedPhysicalLine(message.name),
      title: sanitizedPhysicalLine(header.title),
      status: toolStatus(message.status),
      ...(collapsible ? { collapsible: true, collapsed } : {}),
      ...(note === undefined ? {} : { note }),
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
    ...children,
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

function contextMemberNode(message: Extract<TranscriptMessage, { kind: 'system' }>, key: string): Node {
  const kind = contextPresentationKind(message)
  const head = sanitizedPhysicalLine(message.label ?? contextFormOf(message) ?? 'Context')
  return ui.card(
    { key, head },
    ui.badge({ key: 'kind', text: kind ?? 'generic' }),
    ...contextBodyNodes(message),
  )
}

function contextClusterMemberNode(
  message: Extract<TranscriptMessage, { kind: 'system' }>,
  key: string,
  options: TranscriptViewOptions,
): Node {
  const kind = contextPresentationKind(message)
  const identity = sanitizedPhysicalLine(message.label ?? contextFormOf(message) ?? 'Context')
  const head = sanitizedPhysicalLine(kind === undefined ? identity : `${identity} · ${kind}`)
  const disclosure = options.innerDisclosure
  // Historical / capability-less projection: preserve the readable original shape.
  if (disclosure === undefined || !canCollapseContextRow(message)) {
    return ui.col(
      { key, gap: 'sm' },
      ui.text({ key: 'identity', text: head, wrap: 'none' }),
      ...contextBodyNodes(message),
    )
  }
  // The member keeps its canonical message key: the Cluster owner never stands
  // in for one member's own disclosure. The native Section header is the ONLY
  // control; the Session iterator's exact-node toggle owns the state.
  const expanded = disclosure.expandedContextRowOwners.has(message)
  return ui.section(
    { key, head, collapsible: true, collapsed: !expanded },
    ...(expanded ? contextBodyNodes(message) : []),
  )
}

function canCollapseContextRow(message: Extract<TranscriptMessage, { kind: 'system' }>): boolean {
  const kind = contextPresentationKind(message)
  if (kind === 'notice') return message.summary !== undefined && message.summary !== ''
  return kind === 'ambient' || kind === 'recall'
}

function contextRowNode(
  message: Extract<TranscriptMessage, { kind: 'system' }>,
  key: string,
  options: TranscriptViewOptions,
  allowDisclosure = true,
): Node {
  const disclosure = options.innerDisclosure
  if (message.context !== true || !allowDisclosure || disclosure === undefined || !canCollapseContextRow(message)) {
    return contextMemberNode(message, key)
  }
  const kind = contextPresentationKind(message)
  const identity = kind === 'notice'
    ? 'Notice'
    : message.label ?? contextFormOf(message) ?? 'Context'
  const summary = kind === 'notice' ? message.summary : undefined
  const head = sanitizedPhysicalLine(summary === undefined ? identity : `${identity} · ${summary}`)
  const expanded = disclosure.expandedContextRowOwners.has(message)
  return ui.section(
    { key, head, collapsible: true, collapsed: !expanded },
    ...(expanded ? contextBodyNodes(message) : []),
  )
}

function systemNode(
  message: Extract<TranscriptMessage, { kind: 'system' }>,
  key: string,
  options: TranscriptViewOptions,
  allowDisclosure = true,
): Node {
  if (message.context === true) return contextRowNode(message, key, options, allowDisclosure)
  // Non-context system rows are orchestration evidence (llm-retry /
  // turn-max-tokens); they are never turn-foundation Context.
  return ui.card({ key, head: message.origin ?? 'System' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
}

function thinkingNode(
  message: Extract<TranscriptMessage, { kind: 'thinking' }>,
  key: string,
  options: TranscriptViewOptions,
): Node {
  const disclosure = options.innerDisclosure
  if (disclosure === undefined) {
    return ui.card(
      { key, head: 'Thinking', ...(message.running === true ? { status: 'running' } : {}) },
      ui.md({ key: 'body', text: sanitizeDisplayText(message.text), ...(message.running === true ? { stream: true } : {}) }),
    )
  }
  const expanded = disclosure.expandedThinkingOwners.has(message)
  const latest = latestReasoningLine(message.text)
  const head = ui.col({ key: 'head', gap: 'none' },
    ui.text({ key: 'title', text: 'Thinking', wrap: 'none' }),
    ...(latest === '' ? [] : [ui.text({
      key: 'preview', text: sanitizedPhysicalLine(latest), wrap: 'none',
      truncate: message.running === true ? 'start' : 'end',
    })]),
    ...(message.running === true ? [ui.text({ key: 'status', text: 'Running', wrap: 'none' })] : []),
  )
  return ui.section(
    { key, head, collapsible: true, collapsed: !expanded },
    ...(expanded ? [ui.md({ key: 'body', text: sanitizeDisplayText(message.text), ...(message.running === true ? { stream: true } : {}) })] : []),
  )
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

function userTimeUtc(message: TranscriptMessage): string | undefined {
  if (message.kind !== 'user') return undefined
  const at = transcriptTimingOf(message)?.startedAt
  if (at === undefined || !Number.isFinite(at)) return undefined
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return undefined
  return `${date.toISOString().slice(11, 16)} UTC`
}

function userMessageNode(message: Extract<TranscriptMessage, { kind: 'user' }>, key: string, options: TranscriptViewOptions): Node {
  const copyable = options.transcriptCopy !== undefined
    && (options.transcriptCopyPayloads === undefined
      ? transcriptCopyPayload(message) !== undefined
      : options.transcriptCopyPayloads.has(message))
  const time = userTimeUtc(message)
  const body = message.content !== undefined && bodyHasImage(message.content)
    ? bodyContentNodes(message.content, options)
    : [ui.md({ key: 'body', text: sanitizeDisplayText(message.text) })]
  return ui.message({
    key,
    role: 'dsh.transcript.user',
    variant: 'auto',
    side: 'end',
    ...(time === undefined ? {} : { time }),
    ...(copyable ? {
      actions: [{ act: TRANSCRIPT_COPY_ACTION, icon: 'copy', title: 'Copy user message' }],
      reveal: 'always' as const,
    } : {}),
  }, ...body)
}

function assistantMessageNode(
  message: Extract<TranscriptMessage, { kind: 'assistant' }>,
  key: string,
  options: TranscriptViewOptions,
  body: readonly Node[],
): Node {
  const payload = options.transcriptCopy === undefined
    ? undefined
    : options.transcriptCopyPayloads === undefined
      ? transcriptCopyPayload(message)
      : options.transcriptCopyPayloads.get(message)
  const stats = options.transcriptStats?.get(message) ?? []
  const footer: Node[] = []
  if (payload !== undefined) footer.push(ui.button({
    key: 'copy',
    role: 'dsh.transcript.copy',
    variant: 'quiet',
    size: 'sm',
    text: 'Copy',
    actions: { click: TRANSCRIPT_COPY_ACTION },
  }))
  stats.forEach((text, index) => {
    if (footer.length > 0) footer.push(ui.text({ key: `separator-${index}`, text: ' · ', tone: 'muted' }))
    footer.push(ui.text({ key: `stat-${index}`, text, tone: 'muted' }))
  })
  return ui.col(
    { key, role: 'dsh.transcript.assistant', gap: 'xs' },
    ...body,
    ...(footer.length === 0 ? [] : [ui.row({ key: 'message-actions', wrap: true, gap: 'xs' }, ...footer)]),
  )
}

/** One native node for one non-structural transcript row. */
function messageNode(message: TranscriptMessage, key: string, options: TranscriptViewOptions, truncated = false): Node {
  switch (message.kind) {
    case 'user':
      return userMessageNode(message, key, options)
    case 'assistant': {
      const truncatedNote = truncated
        ? [ui.text({ key: 'truncated', text: 'Output truncated (max tokens)' })]
        : []
      // `displayBlocks` outrank settled content while an opaque block is open.
      const display = message.displayBlocks
      if (display !== undefined) {
        return assistantMessageNode(message, key, options, [...assistantDisplayNodes(display, options), ...truncatedNote])
      }
      const presentation = assistantVisualPresentation(message)
      if (presentation !== undefined && presentation.publications.length > 0) {
        const body = assistantPublishedVisualNodes(
          {
            text: message.text,
            ...(message.content === undefined ? {} : { content: message.content }),
          },
          presentation.publications,
          {
            chartKindsSupported: options.chartKindsSupported === true,
            nativeImagesSupported: options.nativeImagesSupported === true,
            ...(options.selectedVisual === undefined ? {} : { selected: options.selectedVisual }),
            ...(options.requestPublishedSvgBlob === undefined ? {} : { requestPublishedSvgBlob: options.requestPublishedSvgBlob }),
            nonText: (block, blockIndex) => block.type === 'text'
              || block.type === 'reasoning'
              || block.type === 'tool-call'
              ? undefined
              : bodyBlockNodes(block, blockIndex, options),
          },
        )
        return assistantMessageNode(message, key, options, [...body, ...truncatedNote])
      }
      if (message.content !== undefined && bodyHasImage(message.content)) {
        return assistantMessageNode(message, key, options, [...bodyContentNodes(message.content, options), ...truncatedNote])
      }
      return assistantMessageNode(message, key, options, [
        ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }),
        ...truncatedNote,
      ])
    }
    case 'thinking':
      return thinkingNode(message, key, options)
    case 'tool':
      return toolNode(message, key, options)
    case 'system':
      return systemNode(message, key, options)
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
  const key = `${prefix}ctx-${keys.keyFor(cluster.owner)}`
  const head = parts.length === 0 ? 'Context' : sanitizedPhysicalLine(parts.join(' · '))
  const disclosure = options.innerDisclosure
  if (disclosure === undefined) {
    const members = cluster.members.map(member => member.kind === 'system'
      ? contextClusterMemberNode(member, keys.keyFor(member), options)
      : messageNode(member, keys.keyFor(member), options))
    return ui.card({ key, head }, ...members)
  }
  if (!disclosure.expandedClusterOwners.has(cluster.owner)) {
    return ui.section({ key, head, collapsible: true, collapsed: true })
  }
  const members = cluster.members.map(member => member.kind === 'system'
    ? contextClusterMemberNode(member, keys.keyFor(member), options)
    : messageNode(member, keys.keyFor(member), options))
  return ui.section({ key, head, collapsible: true, collapsed: false }, ...members)
}

/** The last non-empty logical line of the ALREADY-BOUNDED reasoning tail.
 *  Tern owns physical clipping; the preview never scans a full reasoning body
 *  and never adds a second row. */
function boundedThinkPreview(text: string): string | undefined {
  const lines = (text.length > THINKING_TAIL_CAP ? text.slice(-THINKING_TAIL_CAP) : text).split(/\r\n|\r|\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (line !== '') return line
  }
  return undefined
}

/** Whether a collapsed Work may show at most two bounded preview rows. The
 *  window must PROVE it is latest (`hasNewer === false`, never absent), and the
 *  owner must be the last canonical Work span. A true tail alone is not enough:
 *  the same-snapshot TurnActivity must still be incomplete, or this Work must
 *  have adopted its existing same-turn Preparing evidence. */
function workPreviewAdmitted(
  span: TranscriptWorkSpan,
  tailWork: boolean,
  hasPreparing: boolean,
  options: TranscriptPresetViewOptions,
): boolean {
  if (options.window?.hasNewer !== false || !tailWork) return false
  return options.turnActivities?.get(span.turn)?.completed === false || hasPreparing
}

/** The Compact Activity header + optional bounded preview, drawn as the
 *  section's native head. A collapsed Work owns no hidden member/tool/image
 *  nodes, so no Tool SVG blob or image demand can start from a header. */
function compactWorkHead(
  summary: ReturnType<typeof summarizeWorkSpan>,
  activityEndedAt: number | undefined,
  previewAdmitted: boolean,
  expanded: boolean,
  previews: readonly StreamingToolPreview[],
  options: TranscriptViewOptions,
): Node {
  const thought = !previewAdmitted
    && summary.think !== undefined
    && summary.action === undefined
    && summary.actionStats.total === 0
  // Member settlement is not an Activity boundary. Only the canonical
  // lifetime's proven structural/turn-end boundary can produce a duration.
  const startedAt = summary.timing?.startedAt
  const measured = startedAt !== undefined
    && activityEndedAt !== undefined
    && activityEndedAt > startedAt
    ? formatCompactDuration(activityEndedAt - startedAt)
    : undefined
  const duration = measured === '0s' ? undefined : measured
  const stats = compactActionStatParts(summary.actionStats).map(sanitizedPhysicalLine).join(' · ')
  const parts = [
    thought ? 'Thought' : 'Activity',
    ...(duration === undefined ? [] : [duration]),
    ...(stats === '' ? [] : [stats]),
  ].join(' · ')
  const rows: Node[] = [ui.text({ key: 'title', text: sanitizedPhysicalLine(parts), wrap: 'none' })]
  if (previewAdmitted && !expanded) {
    const think = summary.think === undefined ? undefined : boundedThinkPreview(summary.think.text)
    if (think !== undefined) rows.push(ui.text({ key: 'think', text: sanitizedPhysicalLine(`Think: ${think}`), wrap: 'none' }))
    const preparing = compactPreparingSummary(previews.map(entry => ({ index: entry.index, ...(entry.name === undefined ? {} : { name: entry.name }) })))
    const action = summary.action === undefined
      ? undefined
      : compactActionPresentation(summary.action, {
        ...(options.toolPresenter === undefined ? {} : { presenter: options.toolPresenter }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      })
    // The SHARED width-free Action body: the status prefix, the display and the
    // running PTC sub-call suffix. Tern owns the physical clipping, so the
    // PiTui width ladder is not reimplemented here — only the semantics are
    // shared, so a running sub-call is never dropped by one surface.
    const oneLine = preparing ?? (action === undefined ? undefined : compactActionBody(action))
    if (oneLine !== undefined) rows.push(ui.text({ key: 'action', text: sanitizedPhysicalLine(`Action: ${oneLine}`), wrap: 'none' }))
  }
  return ui.col({ key: 'head' }, ...rows)
}

/** One primitive a block descriptor's stamp is built from. */
export type TranscriptMainStampPart = string | number | boolean | undefined

/**
 * ONE top-level Main block of the TSP transcript, in real Main order.
 *
 * This is the lazy half of the SAME mapper: the key is exactly the key the
 * full `ui.col({key:'transcript'})` child carries, `materialize()` calls the
 * existing node builders (never a second classifier), and `stamp` is the exact
 * semantic input set that materialization reads. A renderer may keep an
 * already materialized block while its stamp is unchanged, and must
 * re-materialize when it differs.
 */
export interface TranscriptMainBlockDescriptor {
  /** The top-level child key, byte-identical to the full-view child key. */
  readonly key: string
  /** The display inputs this block's node was built from. */
  readonly stamp: readonly TranscriptMainStampPart[]
  /** The canonical messages the block is derived from (never display text). */
  readonly owners: readonly TranscriptMessage[]
  /** Builds the node for this block. Called only when the block is new or dirty. */
  materialize(): Node
}

/** The stable Preparing row key of one live tool-call preview. */
function preparingKeyOf(preview: StreamingToolPreview): string {
  return `preparing-${preview.callId === ''
    ? `idx-${preview.turn}-${preview.step}-${preview.index}`
    : preview.callId}`
}

/** The display stamp of one live Preparing row (its whole visible content). */
function preparingStampOf(preview: StreamingToolPreview): readonly TranscriptMainStampPart[] {
  return [preview.callId, preview.turn, preview.step, preview.index, preview.name, preview.summary, preview.argumentBytes]
}

/** The selected-figure state a published figure paints ('' when none). */
function selectedVisualStampOf(selected: SelectedVisualState | undefined): string {
  return selected === undefined ? '' : `${selected.ref}\u0001${selected.index}\u0001${selected.count}`
}

/**
 * One image state's stable token. The state MAP is rebuilt on every commit, so
 * the state OBJECT identity is never a change signal; the token is.
 */
function imageStateTokenOf(state: ToolImageState | undefined): string {
  if (state === undefined) return '-'
  return state.state === 'ready' ? `ready:${state.blobId}` : state.state
}

interface CachedImageRefIds {
  readonly display: number
  readonly assistant: number
  readonly subtree: number
  readonly ids: readonly string[]
}

const imageRefIdsCache = new WeakMap<TranscriptMessage, CachedImageRefIds>()

/**
 * The attachment ids one row's body/result projection reads, in the mapper's
 * own order. Memoized on the row's mutation revisions: a row that did not
 * change never re-scans its blocks, so the per-commit cost stays O(rows).
 */
function imageRefIdsOf(message: TranscriptMessage): readonly string[] {
  const display = transcriptDisplayRevisionOf(message)
  const assistant = message.kind === 'assistant' ? assistantPresentationRevision(message) : 0
  const subtree = message.kind === 'tool' ? message.subtreeRevision ?? 0 : 0
  const cached = imageRefIdsCache.get(message)
  if (cached !== undefined && cached.display === display && cached.assistant === assistant && cached.subtree === subtree) {
    return cached.ids
  }
  const ids: string[] = []
  const pushBlocks = (blocks: readonly ContentBlock[] | undefined): void => {
    if (blocks === undefined) return
    for (const block of blocks) {
      if (block.type !== 'image' || imageRefProblem(block.attachment) !== undefined) continue
      ids.push(block.attachment.attachmentId)
    }
  }
  const visitRow = (row: TranscriptToolMessage): void => {
    pushBlocks(row.resultBlocks)
    for (const child of row.subCalls ?? []) visitRow(child)
  }
  if (message.kind === 'user') pushBlocks(message.content)
  else if (message.kind === 'assistant') {
    if (message.displayBlocks !== undefined) {
      for (const display of message.displayBlocks) {
        if (display.kind === 'content') pushBlocks([display.block])
      }
    } else if (message.content !== undefined) pushBlocks(message.content)
  } else if (message.kind === 'tool') visitRow(message)
  imageRefIdsCache.set(message, { display, assistant, subtree, ids })
  return ids
}

/** The prepared image states one row's projection reads. */
function imageTokensOf(message: TranscriptMessage, options: TranscriptViewOptions): string {
  const states = options.imageStates
  if (states === undefined) return ''
  const ids = imageRefIdsOf(message)
  if (ids.length === 0) return ''
  let out = ''
  for (const id of ids) out += `${id}:${imageStateTokenOf(states.get(id))}\u0001`
  return out
}

/** The prepared SVG states of a tool row and its nested calls. */
function svgTokensOf(message: TranscriptMessage, options: TranscriptViewOptions): string {
  const states = options.toolSvgStates
  if (states === undefined) return ''
  const visit = (row: TranscriptMessage): string => {
    if (row.kind !== 'tool') return ''
    let out = ''
    if (row.name === SVG_TOOL_NAME) {
      const state = states.get(row)
      out = state === undefined
        ? '-'
        : state.state === 'ready' || state.state === 'unsupported'
          ? `${state.state}:${state.fact.digest}`
          : state.state
    }
    for (const child of row.subCalls ?? []) out += `|${visit(child)}`
    return out
  }
  return visit(message)
}

/** Whether this row's Copy affordance exists for the CURRENT frame. */
function copyTokenOf(message: TranscriptMessage, options: TranscriptViewOptions): number {
  if (options.transcriptCopy === undefined) return -1
  if (message.kind !== 'user' && message.kind !== 'assistant') return -1
  if (options.transcriptCopyPayloads === undefined) return transcriptCopyPayload(message) === undefined ? 0 : 1
  return options.transcriptCopyPayloads.has(message) ? 1 : 0
}

/**
 * The disclosure inputs one row reads. The identity is derived exactly like the
 * mapper derives it from the node key (the top-level key minus the scope
 * prefix; a nested child is `parent/sub-<id>`), never re-interpreted.
 */
function disclosureTokenOf(
  message: TranscriptMessage,
  key: string,
  options: TranscriptViewOptions,
): TranscriptMainStampPart {
  const inner = options.innerDisclosure
  if (message.kind === 'thinking') {
    return inner === undefined ? -1 : inner.expandedThinkingOwners.has(message) ? 1 : 0
  }
  if (message.kind === 'system' && message.context === true) {
    return inner === undefined || !canCollapseContextRow(message)
      ? -1
      : inner.expandedContextRowOwners.has(message) ? 1 : 0
  }
  if (message.kind !== 'tool') return -1
  const expanded = options.expandedToolKeys
  if (expanded === undefined) return -1
  const prefix = options.scopePrefix ?? ''
  const own = prefix !== '' && key.startsWith(prefix) ? key.slice(prefix.length) : key
  const subCalls = message.subCalls
  // The overwhelmingly common row has no nested call: one membership bit.
  if (subCalls === undefined || subCalls.length === 0) return expanded.has(own) ? 1 : 0
  const parts: string[] = [`${own}:${expanded.has(own) ? 1 : 0}`]
  const visit = (row: TranscriptToolMessage, path: string): void => {
    parts.push(`${path}:${expanded.has(path) ? 1 : 0}`)
    for (const child of row.subCalls ?? []) visit(child, `${path}/sub-${child.subCallId!}`)
  }
  for (const child of subCalls) visit(child, `${own}/sub-${child.subCallId!}`)
  return parts.join('\u0001')
}

/** Whether an Assistant row owns the selected published figure ref. */
function visualOwnerHits(message: Extract<TranscriptMessage, { kind: 'assistant' }>, ref: string | undefined): boolean {
  if (ref === undefined || message.displayBlocks !== undefined) return false
  const presentation = assistantVisualPresentation(message)
  return presentation?.publications.some(publication => publication.ref === ref) === true
}

/** The exact display inputs of ONE row (no content copy, no hashing). */
function messageStampOf(
  message: TranscriptMessage,
  key: string,
  options: TranscriptViewOptions,
): readonly TranscriptMainStampPart[] {
  const parts: TranscriptMainStampPart[] = [message.kind, transcriptDisplayRevisionOf(message)]
  switch (message.kind) {
    case 'assistant':
      parts.push(assistantPresentationRevision(message))
      // Published figures are a sidecar on the SAME message object; publishing
      // or withdrawing a figure changes what `messageNode` draws while the row
      // itself is untouched.
      parts.push(assistantVisualPresentationRevision(message))
      parts.push((options.transcriptStats?.get(message) ?? []).join('\u0001'))
      parts.push(copyTokenOf(message, options))
      parts.push(imageTokensOf(message, options))
      parts.push(options.nativeImagesSupported === true ? 1 : 0)
      parts.push(options.chartKindsSupported === true ? 1 : 0)
      // Only the Assistant row that OWNS the selected figure is affected.
      parts.push(visualOwnerHits(message, options.selectedVisual?.ref) ? selectedVisualStampOf(options.selectedVisual) : '')
      break
    case 'tool':
      parts.push(message.subtreeRevision ?? 0)
      parts.push(disclosureTokenOf(message, key, options))
      parts.push(svgTokensOf(message, options))
      parts.push(imageTokensOf(message, options))
      // The settled-answer lookup is a LIVE read keyed by callId: a late
      // official answer changes the rendered result body without mutating the
      // canonical tool row. Its current payload is therefore a display input,
      // not merely the revision at which the lookup was installed. The read is
      // scoped to EXACTLY the row that renders it (`shownToolResult` answers
      // `ask_user_question` rows only), so an ordinary tool's stamp never
      // costs a settled-questions lookup or a payload serialization.
      if (message.name === 'ask_user_question' && message.callId !== undefined) {
        parts.push(options.settledQuestionAnswersRevision ?? 0)
        const answers = options.settledQuestionAnswersLookup?.(message.callId)
        parts.push(answers === undefined ? -1 : JSON.stringify({ answers }))
      }
      break
    case 'thinking':
      parts.push(disclosureTokenOf(message, key, options))
      parts.push(message.running === true ? 1 : 0)
      break
    case 'user':
      parts.push(copyTokenOf(message, options))
      parts.push(imageTokensOf(message, options))
      break
    case 'system':
      parts.push(disclosureTokenOf(message, key, options))
      break
    default:
      break
  }
  return parts
}

/** The display inputs of one canonical Context cluster. */
function clusterStampOf(
  cluster: ContextCluster,
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
): readonly TranscriptMainStampPart[] {
  const parts: TranscriptMainStampPart[] = ['ctx', cluster.members.length]
  parts.push(options.innerDisclosure === undefined
    ? -1
    : options.innerDisclosure.expandedClusterOwners.has(cluster.owner) ? 1 : 0)
  for (const member of cluster.members) parts.push(...messageStampOf(member, keys.keyFor(member), options))
  return parts
}

function messageDescriptor(
  message: TranscriptMessage,
  key: string,
  options: TranscriptViewOptions,
  truncated = false,
): TranscriptMainBlockDescriptor {
  return {
    key,
    stamp: messageStampOf(message, key, options),
    owners: [message],
    materialize: () => messageNode(message, key, options, truncated),
  }
}

function clusterDescriptor(
  cluster: ContextCluster,
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
  prefix: string,
): TranscriptMainBlockDescriptor {
  return {
    key: `${prefix}ctx-${keys.keyFor(cluster.owner)}`,
    stamp: clusterStampOf(cluster, keys, options),
    owners: cluster.members,
    materialize: () => clusterNode(cluster, keys, options, prefix),
  }
}

function preparingDescriptor(
  preview: StreamingToolPreview,
  cwd: string | undefined,
  keyPrefix: string,
): TranscriptMainBlockDescriptor {
  return {
    key: `${keyPrefix}${preparingKeyOf(preview)}`,
    stamp: ['preparing', ...preparingStampOf(preview)],
    owners: [],
    materialize: () => preparingRow(preview, cwd, keyPrefix),
  }
}

/** Full materializes `projectTranscriptStructure` flat: canonical Work members
 *  keep their exact raw positions and no Work container is painted. */
function fullMainBlocks(
  structure: readonly TranscriptStructureBlock[],
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
  prefix: string,
  trailing: TranscriptStructureBlock | undefined,
  adopted: readonly StreamingToolPreview[],
  standalone: readonly TranscriptMainBlockDescriptor[],
): TranscriptMainBlockDescriptor[] {
  const rows: TranscriptMainBlockDescriptor[] = []
  for (const block of structure) {
    if (block.kind === 'message') {
      rows.push(messageDescriptor(block.message, `${prefix}${keys.keyFor(block.message)}`, options))
      continue
    }
    if (block.kind === 'context-cluster') {
      rows.push(clusterDescriptor(block.cluster, keys, options, prefix))
      continue
    }
    for (const part of block.span.parts) {
      rows.push(part.kind === 'message'
        ? messageDescriptor(part.message, `${prefix}${keys.keyFor(part.message)}`, options)
        : clusterDescriptor(part.cluster, keys, options, prefix))
    }
    if (block === trailing) for (const preview of adopted) rows.push(preparingDescriptor(preview, options.cwd, prefix))
  }
  rows.push(...standalone)
  return rows
}

/** The Work owner of one projected member, from its canonical containerPath
 *  only — never a turn number, a tool name or an adjacent visual row. */
function workOwnerOf(path: TranscriptContainerPath | undefined): TranscriptMessage | undefined {
  const entry = path?.find(owner => owner.kind === 'work')
  return entry?.kind === 'work' ? entry.owner : undefined
}

function focusMessageNode(
  block: Extract<FocusProjectedBlock, { kind: 'message' }>,
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
): Node {
  return messageNode(block.message, keys.keyFor(block.message), options, block.truncated === true)
}

interface FocusSlot {
  readonly owner: TranscriptMessage
  readonly activity: TurnActivity
  readonly actionStats: CompactActionStats
  readonly action: CompactActionSource | undefined
  readonly children: Node[]
  readonly expanded: boolean
  preparing: readonly StreamingToolPreview[]
}

function focusDuration(activity: TurnActivity, options: TranscriptPresetViewOptions): string | undefined {
  const duration = formatCompactDuration(options.focusElapsedMs?.get(activity))
  return duration === '0s' ? undefined : duration
}

function focusRootHead(slot: FocusSlot, options: TranscriptPresetViewOptions): Node {
  const phase = options.focusPhase ?? 'working'
  const duration = focusDuration(slot.activity, options)
  const title = focusStatusLabel(slot.activity, phase, duration)
  const stats = compactActionStatParts(slot.actionStats).map(sanitizedPhysicalLine)
  const tokens = slot.activity.totalTokens === undefined ? undefined : `${formatTokens(slot.activity.totalTokens)} tok`
  const titleParts = [title, ...(tokens === undefined ? [] : [tokens]), ...stats]
  const head: Node[] = [ui.text({
    key: 'title',
    text: sanitizedPhysicalLine(titleParts.join(' · ')),
    wrap: 'none',
  })]

  if (!slot.expanded) {
    const thinkState = slot.activity.think
    if (thinkState !== undefined) {
      const think = latestReasoningLine(thinkState.text)
      if (think !== '') {
        head.push(ui.text({
          key: 'think',
          text: sanitizedPhysicalLine(`Think: ${think}`),
          wrap: 'none',
          truncate: thinkState.running ? 'start' : 'end',
        }))
      }
    }
    const preparing = compactPreparingSummary(slot.preparing.map(preview => ({
      index: preview.index,
      ...(preview.name === undefined ? {} : { name: preview.name }),
    })))
    const action = slot.action === undefined ? undefined : compactActionBody(compactActionPresentation(slot.action, {
      ...(options.toolPresenter === undefined ? {} : { presenter: options.toolPresenter }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }))
    if (preparing !== undefined || action !== undefined) {
      head.push(ui.text({
        key: 'action',
        text: sanitizedPhysicalLine(`Action: ${preparing ?? action}`),
        wrap: 'none',
        truncate: 'start',
      }))
    }
    const messageLines = (slot.activity.message?.text ?? '')
      .split(/\r\n|\r|\n/u)
      .map(line => line.trim())
      .filter(line => line !== '')
      .slice(-3)
    messageLines.forEach((line, index) => head.push(ui.text({
      key: `message-${index}`,
      text: sanitizedPhysicalLine(`${index === 0 ? 'Message: ' : ''}${line}`),
      wrap: 'none',
      truncate: 'start',
    })))
    const reason = slot.activity.reason
    if (reason?.kind === 'error' && reason.error !== undefined) {
      head.push(ui.text({
        key: 'error',
        text: sanitizedPhysicalLine(`Error: ${displayFailureText(reason.error)}`),
        wrap: 'none',
      }))
    }
  }
  return ui.col({ key: 'head', gap: 'none' }, ...head)
}

function focusNestedWorkNode(
  span: TranscriptWorkSpan,
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
  prefix: string,
  lifetime: WorkLifetime | undefined,
  preparing: readonly StreamingToolPreview[],
): Node {
  const expanded = options.expandedWorkOwners?.has(span.owner) === true
  const summary = summarizeWorkSpan(span)
  const stats = compactActionStatParts(summary.actionStats).map(sanitizedPhysicalLine)
  const measuredDuration = lifetime?.endedAt === undefined
    ? undefined
    : formatCompactDuration(lifetime.endedAt - lifetime.startedAt)
  const duration = measuredDuration === '0s' ? undefined : measuredDuration
  const preparingSummary = compactPreparingSummary(preparing.map(preview => ({
    index: preview.index,
    ...(preview.name === undefined ? {} : { name: preview.name }),
  })))
  const titleParts = [
    'Activity',
    ...(duration === undefined ? [] : [duration]),
    ...stats,
  ]
  const head: Node[] = [ui.text({ key: 'title', text: sanitizedPhysicalLine(titleParts.join(' · ')), wrap: 'none' })]
  if (!expanded && preparingSummary !== undefined) {
    head.push(ui.text({ key: 'preparing', text: sanitizedPhysicalLine(`Action: ${preparingSummary}`), wrap: 'none' }))
  }
  const children = expanded
    ? [
        ...span.parts.map(part => part.kind === 'message'
          ? messageNode(part.message, keys.keyFor(part.message), options)
          : clusterNode(part.cluster, keys, options, prefix)),
        ...preparing.map(preview => preparingRow(preview, options.cwd, '')),
      ]
    : []
  return ui.section(
    {
      key: `${prefix}work-${keys.keyFor(span.owner)}`,
      head: ui.col({ key: 'head', gap: 'none' }, ...head),
      collapsible: true,
      collapsed: !expanded,
    },
    ...children,
  )
}

function focusNestedWorkDescriptor(
  span: TranscriptWorkSpan,
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
  prefix: string,
  lifetime: WorkLifetime | undefined,
  preparing: readonly StreamingToolPreview[],
): TranscriptMainBlockDescriptor {
  const key = `${prefix}work-${keys.keyFor(span.owner)}`
  const expanded = options.expandedWorkOwners?.has(span.owner) === true
  const stamp: TranscriptMainStampPart[] = ['work', key, expanded ? 1 : 0, lifetime?.startedAt, lifetime?.endedAt, span.parts.length]
  for (const preview of preparing) stamp.push(...preparingStampOf(preview))
  for (const part of span.parts) {
    stamp.push(...(part.kind === 'message'
      ? messageStampOf(part.message, keys.keyFor(part.message), options)
      : clusterStampOf(part.cluster, keys, options)))
  }
  return {
    key,
    stamp,
    owners: span.parts.flatMap(part => part.kind === 'message' ? [part.message] : part.cluster.members),
    materialize: () => focusNestedWorkNode(span, keys, options, prefix, lifetime, preparing),
  }
}

function focusMainBlocks(
  blocks: readonly FocusProjectedBlock[],
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
  prefix: string,
  preparingByRootOwner: ReadonlyMap<TranscriptMessage, readonly StreamingToolPreview[]>,
  preparingByWorkOwner: ReadonlyMap<TranscriptMessage, readonly StreamingToolPreview[]>,
  standalonePreparing: readonly StreamingToolPreview[],
  workLifetimes: ReadonlyMap<TranscriptMessage, WorkLifetime>,
): TranscriptMainBlockDescriptor[] {
  interface FocusRootSlot {
    readonly draft: 'focus'
    readonly owner: TranscriptMessage
    readonly activity: TurnActivity
    readonly actionStats: CompactActionStats
    readonly action: CompactActionSource | undefined
    readonly expanded: boolean
    readonly preparing: readonly StreamingToolPreview[]
    readonly children: TranscriptMainBlockDescriptor[]
    workPreparing: boolean
  }
  const slotsByOwner = new Map<TranscriptMessage, FocusRootSlot>()
  const rootsWithWorkPreparing = new Set<TranscriptMessage>()
  const rows: (FocusRootSlot | TranscriptMainBlockDescriptor)[] = []
  for (const block of blocks) {
    if (block.kind === 'activity') {
      const slot: FocusRootSlot = {
        draft: 'focus',
        owner: block.owner,
        activity: block.activity,
        actionStats: block.actionStats,
        action: block.action,
        expanded: options.expandedFocusTurns?.has(block.activity.turn) === true,
        preparing: preparingByRootOwner.get(block.owner) ?? [],
        children: [],
        workPreparing: false,
      }
      slotsByOwner.set(block.owner, slot)
      rows.push(slot)
      continue
    }
    if (block.kind === 'message') {
      const owner = block.focusPresentationOwner
      const slot = owner === undefined ? undefined : slotsByOwner.get(owner)
      const descriptor = messageDescriptor(block.message, keys.keyFor(block.message), options, block.truncated === true)
      if (slot !== undefined && slot.expanded) slot.children.push(descriptor)
      else if (owner === undefined || slot === undefined) rows.push(descriptor)
      continue
    }
    const owner = block.focusPresentationOwner
    const slot = owner === undefined ? undefined : slotsByOwner.get(owner)
    if (slot === undefined) {
      rows.push(...block.span.parts.map(part => part.kind === 'message'
        ? messageDescriptor(part.message, keys.keyFor(part.message), options)
        : clusterDescriptor(part.cluster, keys, options, prefix)))
      continue
    }
    if (slot.expanded) {
      if (preparingByWorkOwner.has(block.span.owner)) rootsWithWorkPreparing.add(slot.owner)
      slot.children.push(focusNestedWorkDescriptor(
        block.span,
        keys,
        options,
        prefix,
        workLifetimes.get(block.span.owner),
        preparingByWorkOwner.get(block.span.owner) ?? [],
      ))
    }
  }
  for (const slot of slotsByOwner.values()) {
    if (!slot.expanded || slot.preparing.length === 0 || rootsWithWorkPreparing.has(slot.owner)) continue
    slot.children.push(...slot.preparing.map(preview => preparingDescriptor(preview, options.cwd, '')))
  }
  const out = rows.map(row => 'draft' in row ? focusRootDescriptor(row, keys, options, prefix) : row)
  return [
    ...out,
    ...standalonePreparing.map(preview => preparingDescriptor(preview, options.cwd, prefix)),
  ]
}

/** The ONE Focus Activity root descriptor (canonical occurrence owner). */
function focusRootDescriptor(
  slot: {
    readonly owner: TranscriptMessage
    readonly activity: TurnActivity
    readonly actionStats: CompactActionStats
    readonly action: CompactActionSource | undefined
    readonly expanded: boolean
    readonly preparing: readonly StreamingToolPreview[]
    readonly children: readonly TranscriptMainBlockDescriptor[]
  },
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
  prefix: string,
): TranscriptMainBlockDescriptor {
  const key = `${prefix}focus-${keys.keyFor(slot.owner)}`
  const stamp: TranscriptMainStampPart[] = [
    'focus',
    key,
    slot.activity.turn,
    slot.activity.revision,
    slot.activity.totalTokens,
    slot.expanded ? 1 : 0,
    options.focusPhase ?? '',
    options.focusElapsedMs?.get(slot.activity),
  ]
  for (const preview of slot.preparing) stamp.push(...preparingStampOf(preview))
  for (const child of slot.children) stamp.push(...child.stamp)
  return {
    key,
    stamp,
    owners: [slot.owner, ...slot.children.flatMap(child => child.owners)],
    materialize: () => {
      const materialized: FocusSlot = {
        owner: slot.owner,
        activity: slot.activity,
        actionStats: slot.actionStats,
        action: slot.action,
        children: slot.children.map(child => child.materialize()),
        expanded: slot.expanded,
        preparing: slot.preparing,
      }
      return ui.section(
        {
          key,
          head: focusRootHead(materialized, options),
          collapsible: true,
          collapsed: !slot.expanded,
        },
        ...(slot.expanded ? materialized.children : []),
      )
    },
  }
}

/** Preparing belongs either to the exact canonical trailing Work owner, to a
 * root-only post-Assistant run in the same final occurrence, or stays standalone. */
function focusPreparingPlacement(
  messages: readonly TranscriptMessage[],
  blocks: readonly FocusProjectedBlock[],
  options: TranscriptPresetViewOptions,
): {
  readonly byRootOwner: ReadonlyMap<TranscriptMessage, readonly StreamingToolPreview[]>
  readonly byWorkOwner: ReadonlyMap<TranscriptMessage, readonly StreamingToolPreview[]>
  readonly standalone: readonly StreamingToolPreview[]
} {
  const groups = groupPreparingPreviews(options.preparingPreviews ?? [])
  if (groups.length === 0 || options.window?.hasNewer !== false) {
    return { byRootOwner: new Map(), byWorkOwner: new Map(), standalone: [] }
  }
  const activities = options.turnActivities ?? EMPTY_TURN_ACTIVITIES
  const expandedBlocks = projectFocus(messages, activities, new Set(activities.keys()), true)
  const structure = projectTranscriptStructure(messages)
  const trailing = structure.at(-1)
  let rootOwner: TranscriptMessage | undefined
  let workOwner: TranscriptMessage | undefined
  let turn: number | undefined
  if (trailing?.kind === 'work') {
    turn = trailing.span.turn
    if (activities.get(turn)?.completed === false) {
      const projected = expandedBlocks.findLast(block => block.kind === 'work' && block.span.owner === trailing.span.owner)
      if (projected?.kind === 'work') {
        rootOwner = projected.focusPresentationOwner
        workOwner = rootOwner === undefined ? undefined : trailing.span.owner
      }
    }
  } else {
    const lastMessage = trailing?.kind === 'message'
      ? trailing.message
      : trailing?.kind === 'context-cluster' ? trailing.cluster.members.at(-1) : undefined
    if (lastMessage !== undefined
      && 'turn' in lastMessage
      && !(lastMessage.kind === 'compaction' && lastMessage.sourceCommand !== undefined)
      && activities.get(lastMessage.turn)?.completed === false) {
      turn = lastMessage.turn
      const projected = expandedBlocks.findLast(block => block.kind === 'activity' && block.activity.turn === turn)
      rootOwner = projected?.kind === 'activity' ? projected.owner : undefined
    }
  }
  if (rootOwner === undefined || turn === undefined
    || !blocks.some(block => block.kind === 'activity' && block.owner === rootOwner)) {
    return { byRootOwner: new Map(), byWorkOwner: new Map(), standalone: groups.flatMap(([, previews]) => previews) }
  }
  const selected = groups.find(([groupTurn]) => groupTurn === turn)?.[1] ?? []
  const byRootOwner = selected.length === 0 ? new Map() : new Map([[rootOwner, selected]])
  const byWorkOwner = workOwner === undefined || selected.length === 0 ? new Map() : new Map([[workOwner, selected]])
  const standalone = groups.filter(([groupTurn]) => groupTurn !== turn).flatMap(([, previews]) => previews)
  return { byRootOwner, byWorkOwner, standalone }
}

/** The members whose current transcript body is actually materialized. */
export function visibleTranscriptMembers(
  messages: readonly TranscriptMessage[],
  options: TranscriptPresetViewOptions,
  keys: TranscriptNodeKeys,
): ReadonlySet<TranscriptMessage> {
  const visible = new Set<TranscriptMessage>()
  const structure = projectTranscriptStructure(messages)
  const expandedWorks = options.expandedWorkOwners ?? EMPTY_MESSAGE_SET
  const inner = options.innerDisclosure
  const expandedTools = options.expandedToolKeys

  const contextRowOpen = (message: Extract<TranscriptMessage, { kind: 'system' }>): boolean => {
    if (inner === undefined || !canCollapseContextRow(message)) return true
    return inner.expandedContextRowOwners.has(message)
  }

  const addMessage = (message: TranscriptMessage, toolPath?: string): void => {
    if (message.kind === 'thinking' && inner !== undefined && !inner.expandedThinkingOwners.has(message)) return
    if (message.kind === 'system' && message.context === true && !contextRowOpen(message)) return
    if (message.kind !== 'tool') {
      visible.add(message)
      return
    }

    const identity = toolPath ?? keys.keyFor(message)
    const svgState = message.name === SVG_TOOL_NAME && message.status === 'ok'
      ? options.toolSvgStates?.get(message)
      : undefined
    const collapsible = expandedTools !== undefined
      && !isUnmatchedToolRow(message)
      && (message.name === SVG_TOOL_NAME ? svgState?.state === 'ready' : inner !== undefined)
    if (collapsible && !expandedTools.has(identity)) return

    visible.add(message)
    for (const child of message.subCalls ?? []) {
      const childPath = `${identity}/sub-${child.subCallId!}`
      addMessage(child, childPath)
    }
  }

  const addCluster = (cluster: ContextCluster): void => {
    if (inner !== undefined && !inner.expandedClusterOwners.has(cluster.owner)) return
    // A member body is visible only when the member's OWN disclosure is open;
    // `Cluster open` never stands in for `member body visible`.
    for (const member of cluster.members) addMessage(member)
  }

  const addWorkParts = (span: TranscriptWorkSpan): void => {
    for (const part of span.parts) {
      if (part.kind === 'message') addMessage(part.message)
      else addCluster(part.cluster)
    }
  }

  if (options.preset === 'focus') {
    const focusBlocks = projectFocus(
      messages,
      options.turnActivities ?? EMPTY_TURN_ACTIVITIES,
      options.expandedFocusTurns ?? EMPTY_TURN_SET,
      true,
    )
    const rootByOwner = new Map<TranscriptMessage, number>()
    for (const block of focusBlocks) {
      if (block.kind === 'activity') rootByOwner.set(block.owner, block.activity.turn)
    }
    const expandedRoots = options.expandedFocusTurns ?? EMPTY_TURN_SET
    for (const block of focusBlocks) {
      if (block.kind === 'activity') continue
      const owner = block.focusPresentationOwner
      const turn = owner === undefined ? undefined : rootByOwner.get(owner)
      if (block.kind === 'message') {
        if (owner === undefined || turn === undefined || expandedRoots.has(turn)) addMessage(block.message)
        continue
      }
      if (turn === undefined) {
        addWorkParts(block.span)
        continue
      }
      if (expandedRoots.has(turn) && expandedWorks.has(block.span.owner)) addWorkParts(block.span)
    }
    return visible
  }

  if (options.preset === 'full') {
    for (const block of structure) {
      if (block.kind === 'message') addMessage(block.message)
      else if (block.kind === 'context-cluster') addCluster(block.cluster)
      else for (const part of block.span.parts) {
        if (part.kind === 'message') addMessage(part.message)
        else addCluster(part.cluster)
      }
    }
    return visible
  }

  for (const block of structure) {
    if (block.kind === 'message') {
      addMessage(block.message)
      continue
    }
    if (block.kind === 'context-cluster') {
      addCluster(block.cluster)
      continue
    }
    if (expandedWorks.has(block.span.owner)) addWorkParts(block.span)
  }
  return visible
}

/** Compact consumes `projectCompact`'s output order: every canonical Work span
 *  owns exactly one Activity section, and its FLAT member blocks (including a
 *  carried snapshot cluster's members under clusterHeader:false) become that
 *  section's children. Conversation/Attention/command/ambient Context stays in
 *  the main reading flow in raw order. */
function compactMainBlocks(
  blocks: readonly CompactProjectedBlock[],
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
  prefix: string,
  tailWorkOwner: TranscriptMessage | undefined,
  adoptedPreviews: readonly StreamingToolPreview[],
  workLifetimes: ReadonlyMap<TranscriptMessage, WorkLifetime>,
  standalone: readonly TranscriptMainBlockDescriptor[],
): TranscriptMainBlockDescriptor[] {
  /** One call-local assembly record per emitted Work header. Members arrive
   *  from the projection's own flat member blocks, then the section is built
   *  ONCE from the finished record — no node is rebuilt or mutated. */
  interface WorkSlot {
    readonly draft: 'work'
    readonly owner: TranscriptMessage
    readonly span: TranscriptWorkSpan
    readonly key: string
    readonly expanded: boolean
    readonly tail: boolean
    readonly previews: readonly StreamingToolPreview[]
    readonly members: TranscriptMainBlockDescriptor[]
    readonly preparing: TranscriptMainBlockDescriptor[]
    readonly activityCompleted: boolean | undefined
    readonly lifetimeStartedAt: number | undefined
    readonly lifetimeEndedAt: number | undefined
    readonly hasNewer: boolean | undefined
  }
  const slots = new Map<TranscriptMessage, WorkSlot>()
  const rows: (WorkSlot | TranscriptMainBlockDescriptor)[] = []
  const consumedClusterMembers = new Set<TranscriptMessage>()
  for (const block of blocks) {
    if (block.kind === 'work') {
      const owner = block.span.owner
      const expanded = options.expandedWorkOwners?.has(owner) === true
      // ONLY the projected TAIL Work may adopt the live Preparing rows: an
      // earlier Work of the same still-open turn is historical, and a turn key
      // is not an owner identity.
      const isTail = tailWorkOwner === owner
      const previews = isTail ? adoptedPreviews : []
      const slot: WorkSlot = {
        draft: 'work',
        owner,
        span: block.span,
        key: `${prefix}work-${keys.keyFor(owner)}`,
        expanded,
        tail: isTail,
        previews,
        members: [],
        preparing: expanded ? previews.map(preview => preparingDescriptor(preview, options.cwd, '')) : [],
        activityCompleted: options.turnActivities?.get(block.span.turn)?.completed,
        lifetimeStartedAt: workLifetimes.get(owner)?.startedAt,
        lifetimeEndedAt: workLifetimes.get(owner)?.endedAt,
        hasNewer: options.window?.hasNewer,
      }
      slots.set(owner, slot)
      rows.push(slot)
      continue
    }
    if (block.kind === 'context-cluster') {
      if (options.innerDisclosure === undefined) continue
      const descriptor = clusterDescriptor(block.cluster, keys, options, prefix)
      const owner = workOwnerOf(block.containerPath)
      const slot = owner === undefined ? undefined : slots.get(owner)
      if (slot === undefined) rows.push(descriptor)
      else slot.members.push(descriptor)
      for (const member of block.cluster.members) consumedClusterMembers.add(member)
      continue
    }
    if (consumedClusterMembers.has(block.message)) continue
    const owner = workOwnerOf(block.containerPath)
    const slot = owner === undefined ? undefined : slots.get(owner)
    if (slot === undefined) {
      rows.push(messageDescriptor(block.message, `${prefix}${keys.keyFor(block.message)}`, options))
      continue
    }
    // The member belongs to this Work by its canonical containerPath only.
    slot.members.push(messageDescriptor(block.message, keys.keyFor(block.message), options))
  }
  const out: TranscriptMainBlockDescriptor[] = rows.map(row => 'draft' in row
    ? compactWorkDescriptor(row, options)
    : row)
  out.push(...standalone)
  return out
}

/** The ONE Compact Activity section descriptor of one canonical Work span. */
function compactWorkDescriptor(slot: {
  readonly owner: TranscriptMessage
  readonly span: TranscriptWorkSpan
  readonly key: string
  readonly expanded: boolean
  readonly tail: boolean
  readonly previews: readonly StreamingToolPreview[]
  readonly members: readonly TranscriptMainBlockDescriptor[]
  readonly preparing: readonly TranscriptMainBlockDescriptor[]
  readonly activityCompleted: boolean | undefined
  readonly lifetimeStartedAt: number | undefined
  readonly lifetimeEndedAt: number | undefined
  readonly hasNewer: boolean | undefined
}, options: TranscriptPresetViewOptions): TranscriptMainBlockDescriptor {
  const stamp: TranscriptMainStampPart[] = [
    'work',
    slot.key,
    slot.expanded ? 1 : 0,
    slot.tail ? 1 : 0,
    slot.span.parts.length,
    slot.activityCompleted === true ? 1 : slot.activityCompleted === false ? 0 : -1,
    slot.hasNewer === false ? 1 : slot.hasNewer === true ? 0 : -1,
    // The header duration is `endedAt - startedAt`; a proven EARLIER start is
    // a real display change even when the end is unchanged.
    slot.lifetimeStartedAt,
    slot.lifetimeEndedAt,
  ]
  for (const preview of slot.previews) stamp.push(...preparingStampOf(preview))
  for (const member of slot.members) stamp.push(...member.stamp)
  return {
    key: slot.key,
    stamp,
    owners: [slot.owner, ...slot.members.flatMap(member => member.owners)],
    materialize: () => {
      const previewAdmitted = workPreviewAdmitted(slot.span, slot.tail, slot.previews.length > 0, options)
      const head = compactWorkHead(
        summarizeWorkSpan(slot.span),
        slot.lifetimeEndedAt,
        previewAdmitted,
        slot.expanded,
        slot.previews,
        options,
      )
      return ui.section(
        { key: slot.key, head, collapsible: true, collapsed: !slot.expanded },
        ...slot.members.map(member => member.materialize()),
        ...(slot.expanded ? slot.preparing.map(member => member.materialize()) : []),
      )
    },
  }
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
    { key: 'transcript', gap: 'none' },
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

function settledFinalAssistantStats(
  messages: readonly TranscriptMessage[],
  activities: ReadonlyMap<number, TurnActivity> | undefined,
): ReadonlyMap<Extract<TranscriptMessage, { kind: 'assistant' }>, readonly string[]> {
  if (activities === undefined) return EMPTY_ASSISTANT_STATS
  const rowsByTurn = new Map<number, TranscriptMessage[]>()
  for (const message of messages) {
    if (!('turn' in message)) continue
    const rows = rowsByTurn.get(message.turn)
    if (rows === undefined) rowsByTurn.set(message.turn, [message])
    else rows.push(message)
  }

  const result = new Map<Extract<TranscriptMessage, { kind: 'assistant' }>, readonly string[]>()
  for (const [turn, rows] of rowsByTurn) {
    const activity = activities.get(turn)
    const eligible = eligibleFinalAssistant(activity, rows)
    if (activity === undefined || eligible === undefined) continue
    const parts: string[] = []
    if (Number.isFinite(activity.startedAt) && Number.isFinite(activity.endedAt)
      && activity.startedAt !== undefined && activity.endedAt !== undefined
      && activity.endedAt >= activity.startedAt) {
      const duration = formatCompactDuration(activity.endedAt - activity.startedAt)
      if (duration !== undefined) parts.push(`Took ${duration === '0s' ? '<1s' : duration}`)
    }
    if (activity.usage !== undefined && activity.totalTokens !== undefined) {
      parts.push(`${formatTokens(activity.totalTokens)} tok`)
    }
    if (parts.length > 0) result.set(eligible.message, parts)
  }
  return result
}

/**
 * The typed Full/Compact entry the production session calls with the RAW
 * window. `projectTranscriptStructure` stays the ONE segmentation authority:
 * Full flattens its canonical parts, Compact materializes `projectCompact`
 * over the SAME raw messages. `focus` (and any future preset without a TSP
 * projection) keeps the historical Work-section layout unchanged.
 */
export function transcriptViewForPreset(
  messages: readonly TranscriptMessage[],
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
): Node {
  return ui.col(
    { key: 'transcript', gap: 'none' },
    ...describeTranscriptMainBlocksForPreset(messages, keys, options).map(block => block.materialize()),
  )
}

/**
 * The lazy per-top-level-block half of the preset-less historical layout
 * ({@link transcriptView}). Kept as the ONE production entry that layout's
 * renderer calls, so no second classifier exists for it either.
 */
export function describeTranscriptMainBlocks(
  messages: readonly TranscriptMessage[],
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions = {},
): TranscriptMainBlockDescriptor[] {
  for (const message of messages) keys.keyFor(message)
  const structure = projectTranscriptStructure(messages)
  const prefix = options.scopePrefix ?? ''
  const groups = groupPreparingPreviews(options.preparingPreviews ?? [])
  const trailing = structure.length === 0 ? undefined : structure[structure.length - 1]
  const openTurn = trailing?.kind === 'work' ? trailing.span.turn : undefined
  let adopted: readonly StreamingToolPreview[] = []
  const standalone: TranscriptMainBlockDescriptor[] = []
  for (const [turn, group] of groups) {
    if (turn === openTurn) {
      adopted = group
      continue
    }
    for (const preview of group) standalone.push(preparingDescriptor(preview, options.cwd, prefix))
  }
  return legacyMainBlocks(structure, keys, options, prefix, trailing, adopted, standalone)
}

/**
 * The lazy per-top-level-block half of {@link transcriptViewForPreset}: the
 * SAME keys, the SAME canonical projections and the SAME node builders, with
 * each top-level Main child described separately together with the exact
 * semantic stamp it was built from. A renderer can therefore keep a retained
 * block and materialize only the blocks whose stamp changed; the full view
 * above is the byte-for-byte oracle of this function's concatenation.
 */
export function describeTranscriptMainBlocksForPreset(
  messages: readonly TranscriptMessage[],
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
): TranscriptMainBlockDescriptor[] {
  // Allocate every row's presentation key in RAW order BEFORE materializing.
  // A collapsed Work builds no member nodes, so without this pass expanding it
  // would shift every later `msg-N` and remount unrelated rows: disclosure
  // state must never change a retained message's identity.
  for (const message of messages) keys.keyFor(message)
  const structure = projectTranscriptStructure(messages)
  const prefix = options.scopePrefix ?? ''
  const transcriptStats = options.preset === 'focus'
    ? EMPTY_ASSISTANT_STATS
    : settledFinalAssistantStats(messages, options.turnActivities)
  const renderOptions: TranscriptPresetViewOptions = { ...options, transcriptStats }
  const groups = groupPreparingPreviews(options.preparingPreviews ?? [])
  const trailing = structure.length === 0 ? undefined : structure[structure.length - 1]
  const openTurn = trailing?.kind === 'work' ? trailing.span.turn : undefined
  let adopted: readonly StreamingToolPreview[] = []
  const standalone: TranscriptMainBlockDescriptor[] = []
  for (const [turn, group] of groups) {
    if (turn === openTurn) {
      adopted = group
      continue
    }
    for (const preview of group) standalone.push(preparingDescriptor(preview, options.cwd, prefix))
  }
  if (options.preset === 'full') {
    return fullMainBlocks(structure, keys, renderOptions, prefix, trailing, adopted, standalone)
  }
  if (options.preset === 'compact') {
    const blocks = projectCompact(messages, {
      expandedWorkOwners: options.expandedWorkOwners ?? EMPTY_MESSAGE_SET,
      expandedClusters: EMPTY_MESSAGE_SET,
      forcedExpanded: EMPTY_MESSAGE_SET,
      clusterHeader: options.innerDisclosure !== undefined,
      workHeader: true,
    })
    // Only the actual canonical trailing block may own the tail preview. A
    // preceding Work followed by an Assistant is no longer the projected tail,
    // even when its TurnActivity remains incomplete.
    const tailWork = trailing?.kind === 'work' ? trailing : undefined
    const workLifetimes = resolveWorkLifetimes(structure, options.turnActivities ?? EMPTY_TURN_ACTIVITIES)
    // Only the TRAILING open Work adopts its own turn's Preparing rows; every
    // other turn already failed open as standalone rows above. The adopted rows
    // belong to the projected TAIL Work alone — a turn key is not an owner.
    return compactMainBlocks(
      blocks, keys, renderOptions, prefix,
      tailWork?.span.owner,
      adopted, workLifetimes, standalone,
    )
  }
  if (options.preset === 'focus') {
    const focusBlocks = projectFocus(
      messages,
      options.turnActivities ?? EMPTY_TURN_ACTIVITIES,
      options.expandedFocusTurns ?? EMPTY_TURN_SET,
      true,
    )
    const workLifetimes = resolveWorkLifetimes(structure, options.turnActivities ?? EMPTY_TURN_ACTIVITIES)
    const preparing = focusPreparingPlacement(messages, focusBlocks, options)
    return focusMainBlocks(
      focusBlocks,
      keys,
      renderOptions,
      prefix,
      preparing.byRootOwner,
      preparing.byWorkOwner,
      preparing.standalone,
      workLifetimes,
    )
  }
  return legacyMainBlocks(structure, keys, renderOptions, prefix, trailing, adopted, standalone)
}

/** The preset-less historical layout, described for the SAME renderer. */
function legacyMainBlocks(
  structure: readonly TranscriptStructureBlock[],
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
  prefix: string,
  trailing: TranscriptStructureBlock | undefined,
  adopted: readonly StreamingToolPreview[],
  standalone: readonly TranscriptMainBlockDescriptor[],
): TranscriptMainBlockDescriptor[] {
  const rows: TranscriptMainBlockDescriptor[] = structure.map(block => {
    switch (block.kind) {
      case 'message':
        return messageDescriptor(block.message, `${prefix}${keys.keyFor(block.message)}`, options)
      case 'work':
        return legacyWorkDescriptor(block.span, keys, options, prefix, block === trailing ? adopted : [])
      case 'context-cluster':
        return clusterDescriptor(block.cluster, keys, options, prefix)
    }
  })
  rows.push(...standalone)
  return rows
}

function legacyWorkDescriptor(
  span: TranscriptWorkSpan,
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
  prefix: string,
  previews: readonly StreamingToolPreview[],
): TranscriptMainBlockDescriptor {
  const key = `${prefix}work-${keys.keyFor(span.owner)}`
  const stamp: TranscriptMainStampPart[] = ['work', key, span.parts.length]
  for (const preview of previews) stamp.push(...preparingStampOf(preview))
  for (const part of span.parts) {
    stamp.push(...(part.kind === 'message'
      ? messageStampOf(part.message, keys.keyFor(part.message), options)
      : clusterStampOf(part.cluster, keys, options)))
  }
  return {
    key,
    stamp,
    owners: span.parts.flatMap(part => part.kind === 'message' ? [part.message] : part.cluster.members),
    materialize: () => workNode(span, keys, options, prefix, previews),
  }
}

/** A read-only empty disclosure set for this projection call (no search reveal
 *  or cluster disclosure owner exists in this build). */
const EMPTY_MESSAGE_SET: ReadonlySet<TranscriptMessage> = new Set<TranscriptMessage>()
const EMPTY_TURN_SET: ReadonlySet<number> = new Set<number>()
const EMPTY_TURN_ACTIVITIES: ReadonlyMap<number, TurnActivity> = new Map<number, TurnActivity>()
const EMPTY_ASSISTANT_STATS: ReadonlyMap<Extract<TranscriptMessage, { kind: 'assistant' }>, readonly string[]> = new Map()
