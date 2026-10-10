/**
 * The ONE mutable transcript fold authority (TS7 move from
 * \`src/transcript.ts\`): \`TranscriptFolder\`, the one-shot \`foldTranscript\`
 * wrapper, \`childOwnEvents\`, and the fold-maintained row sidecars
 * (timing evidence, assistant step/presentation identity) and assistant
 * stream projections.
 *
 * Everything here is maintained incrementally from the SAME session-event fold:
 * items/turn/step lifecycle, assistant and thinking entry maps, pending calls
 * and PTC topology, workflow indexes, command lifecycle, compaction fusion,
 * deliverables, read-group metadata, the search entries/revision, TurnActivity,
 * usage accumulation and the post-turn replay/timing/assistant sidecars. They
 * are deliberately NOT split into mutually synchronized stores; the pure
 * sibling modules under this directory carry the shared facts.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/folder
 */

import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { isReplacementSurfaceEvent, TOOL_NOT_STARTED } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expandAssistantStream, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
// Load the official command/subagent/retry/workflow event declarations the
// fold switches on.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type { ToolWorkflowAgentStartData, ToolWorkflowRunStartData } from '@deepseek-ai/dsh-tool-workflow/types'
import {
  textWithAttachmentMarkers,
  userBlocksVisibleNow,
} from './content-blocks.ts'
import { displayFailure, displayFailureText } from './failure.ts'
import { latestLine } from './text.ts'
import {
  StepUsageAccumulator,
  totalTokens,
  type TokenUsageTotals,
  type UsageLike,
} from './usage.ts'
import type {
  AssistantLiveChunk,
  AssistantLiveContentBlock,
  AssistantLiveInput,
} from '../../runtime/assistant-stream-port.ts'
import { contextIconSemantic, contextPresentation, contextProvenance, contextSummary } from './context-semantics.ts'
import { isGroupableRead } from './grouping.ts'
import {
  isSurfacedInteractionToolName,
  markPostTurnReplayEvidence,
} from './semantics.ts'
import {
  resolveSearchSource,
  transcriptSearchCorpus,
  type TranscriptSearchCorpusSpan,
  type TranscriptSearchMatch,
  type TranscriptSearchSource,
} from './search.ts'
import {
  PTC_MAX_DEPTH,
  THINKING_TAIL_CAP,
  TURN_END_REASON_KINDS,
  type AssistantDisplayBlock,
  type CommandId,
  type FoldOptions,
  type MutableTurnActivity,
  type PresentedFilePresentation,
  type SessionEventSeq,
  type TranscriptCommandMessage,
  type TranscriptCommandOutcome,
  type TranscriptContextPresentation,
  type TranscriptItemId,
  type TranscriptMessage,
  type TranscriptSystemOrigin,
  type TranscriptTiming,
  type TranscriptToolMessage,
  type TranscriptToolOrigin,
  type TurnActivity,
  type TurnEndReason,
} from './types.ts'
import {
  WorkflowProjection,
  workflowPhaseKey,
  workflowReadablePhase,
  type TranscriptWorkflowMessage,
  type WorkflowChildSessionId,
  type WorkflowMemberView,
  type WorkflowOwner,
  type WorkflowRunId,
  type WorkflowRunStatus,
} from './workflow-projection.ts'
import { windowMessages, type TranscriptWindow } from './window.ts'

/** The presentation-only sidecar store: keyed by row object identity, so a
 * merged read group's fresh card object simply gets its own entry. */
const transcriptTimings = new WeakMap<TranscriptMessage, TranscriptTiming>()

/**
 * The timing sidecar of one transcript row, if the fold recorded any
 * (post-F6 plan §12.4). Absent means NO reliable timing evidence —
 * consumers omit the duration (never fabricate `0s`).
 */
export function transcriptTimingOf(message: TranscriptMessage): TranscriptTiming | undefined {
  return transcriptTimings.get(message)
}

/** Record/replace one row's timing sidecar (fold-internal authority). */
function setTranscriptTiming(message: TranscriptMessage, timing: TranscriptTiming): void {
  transcriptTimings.set(message, timing)
}

/** The last ACCEPTED reasoning-evidence time per thinking row (live fold):
 * the fallback end when a settlement carries no authoritative lane end (a
 * legacy `assistant/message` without the embedded stream). Without it the
 * known reasoning end would be lost and the row would settle end-less.
 * Weakly held — the fallback dies with its row. */
const thinkingLastEvidence = new WeakMap<TranscriptMessage, number>()

/** A point-evidence timing: the row proves presence at one instant only
 * (post-F6 plan §12.9) — never an invented duration. */
function pointTiming(at: number): TranscriptTiming {
  return { startedAt: at, endedAt: at, running: false }
}

/** The fold-internal fallback identity of a streamed tool-call delta whose
 * formal call id has not arrived yet: the SAME (turn, step, block index)
 * identity the live preview projection uses, so Preparing timing survives
 * the delayed-id handoff (post-F6 plan §12.14). */
function preparingFallbackKey(turn: number, step: number, index: number): string {
  return `\u0000tool-call-preparing:${turn}:${step}:${index}`
}

/** Record a running row's authoritative end (post-F6 plan §12.7). A row the
 * fold never started (a missing-call fragment) degrades to point evidence
 * at the end time instead of inventing a start. */
function settleToolTiming(message: TranscriptMessage, endedAt: number): void {
  const previous = transcriptTimings.get(message)
  transcriptTimings.set(message, previous === undefined
    ? { startedAt: endedAt, endedAt, running: false }
    : { startedAt: previous.startedAt, endedAt: Math.max(previous.startedAt, endedAt), running: false })
}

const assistantPresentationRevisions = new WeakMap<Extract<TranscriptMessage, { kind: 'assistant' }>, number>()
const assistantStepIdentities = new WeakMap<Extract<TranscriptMessage, { kind: 'assistant' }>, number>()

/** Return the mutation revision of an Assistant's live indexed projection. */
export function assistantPresentationRevision(message: TranscriptMessage): number {
  return message.kind === 'assistant' ? assistantPresentationRevisions.get(message) ?? 0 : 0
}

/** Return the internal step identity used to protect Focus final ownership. */
export function assistantStepOf(message: TranscriptMessage): number | undefined {
  return message.kind === 'assistant' ? assistantStepIdentities.get(message) : undefined
}

/** Read the private latest-step fence without exposing it on the public
 * TurnActivity shape. Focus uses this only to select the structural owner. */
export function assistantLatestStepOf(activity: TurnActivity): number | undefined {
  return (activity as MutableTurnActivity).lastAssistantStep
}

/** Whether an Assistant crossed an admitted human-steer boundary and is
 * therefore a persistent conversation answer rather than Focus process. */
export function assistantCommittedBeforeSteer(
  activity: TurnActivity,
  message: TranscriptMessage,
): boolean {
  if (message.kind !== 'assistant') return false
  const step = assistantStepOf(message)
  return step !== undefined
    && (activity as MutableTurnActivity).committedAnswerSteps.has(step)
}

function rememberAssistantStep(message: Extract<TranscriptMessage, { kind: 'assistant' }>, step: number): void {
  assistantStepIdentities.set(message, step)
}

function bumpAssistantPresentationRevision(message: Extract<TranscriptMessage, { kind: 'assistant' }>): void {
  assistantPresentationRevisions.set(message, assistantPresentationRevision(message) + 1)
}

/** Text of a message's content blocks, joined; empty when there is no text. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Whether the alpha.2 terminal result tail marker marks a failure: the
 * official `parseExitStatus` recovers the terminal exit code or signal
 * from the LAST marker line (a preceding truncation notice does not affect
 * parsing). A nonzero exit or a signal is a terminal failure even when the
 * tool call itself settled with `isError: false`; a missing marker is
 * NOT a failure — the status is never invented from text. */


export function terminalFailureFromResult(result: string): boolean {
  const parsed = parseExitStatus(result)
  if ('signal' in parsed) return true
  if ('exitCode' in parsed) return parsed.exitCode !== 0
  return false
}

/** The DISPLAY status of one PTC sub-call: the durable lifecycle status
 * (`isError` only) PLUS the alpha.2 terminal contract for bash/pwsh — a
 * trailing `[exit code: N]` / `[killed by signal: ...]` marker (parsed by
 * the official `parseExitStatus`; a preceding truncation notice does not
 * affect it) renders the child failed even when the tool call settled
 * normally. Spilled/generic content without a marker never invents a
 * status. */
export function subCallDisplayStatus(child: {
  name: string
  status: 'ok' | 'error' | 'running'
  result: string
}): 'ok' | 'error' | 'running' {
  if (child.status !== 'ok') return child.status
  if ((child.name === 'bash' || child.name === 'pwsh') && terminalFailureFromResult(child.result)) return 'error'
  return 'ok'
}

/**
 * The RUNNING PTC descendants of one root card, aggregated by tool name in
 * durable dispatch order — the SAME projection the Focus Tool slot consumes
 * (post-F6 plan §9.1: an Activity member card must not drop what Focus
 * shows). Presentation metadata ONLY: never part of the tool stats.
 */
export function activeSubCallsOf(
  root: TranscriptToolMessage,
): { readonly name: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  const order: string[] = []
  const visit = (card: TranscriptToolMessage, depth: number): void => {
    if (depth >= PTC_MAX_DEPTH) return
    for (const sub of card.subCalls ?? []) {
      if (sub.status === 'running') {
        if (!counts.has(sub.name)) order.push(sub.name)
        counts.set(sub.name, (counts.get(sub.name) ?? 0) + 1)
      }
      visit(sub, depth + 1)
    }
  }
  visit(root, 0)
  return order.map(name => ({ name, count: counts.get(name)! }))
}

/** Reconstruct the logical blocks used by any Assistant entry. */
function assistantEntryBlocks(entry: Extract<TranscriptMessage, { kind: 'assistant' }>): readonly ContentBlock[] {
  if (entry.content !== undefined) return entry.content
  return entry.text === '' ? [] : [{ type: 'text', text: entry.text }]
}

interface AssistantVisibilityChunk {
  readonly type: string
  readonly text?: string
  readonly block?: { readonly type: string; readonly text?: string }
}

/** Whether one Assistant stream chunk produces Focus-visible reply content.
 * Reasoning, tool-call protocol, and open block starts are process evidence;
 * text deltas and finalized visible blocks are the answer boundary. */
function assistantChunkHasVisibleReply(chunk: AssistantVisibilityChunk): boolean {
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type !== 'block-end') return false
  const block = chunk.block
  if (block === undefined) return false
  if (block.type === 'text') return typeof block.text === 'string' && block.text.trim() !== ''
  if (block.type === 'reasoning' || block.type === 'tool-call') return false
  return true
}

/** The concatenated reasoning text of an assembled content-block list
 * (`undefined` input yields ''). Used for durable Thinking lane restore. */
function reasoningBlockText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let text = ''
  for (const block of blocks) {
    if (block.type === 'reasoning') text += block.text
  }
  return text
}

/** The lane order the durable `message.content` block order proves for one
 * settled assistant step: the FIRST lane-visible block decides the result —
 * a single-lane content still proves the order (the step's other lane row is
 * hidden or absent, so no visible misorder is possible); `undefined` only
 * when no block carries lane-visible evidence. Visibility matches the stream
 * projection's rule (`assistantBlockProjection` — empty reasoning text is not
 * Thinking evidence), so this stays ordered durable evidence, never a text
 * heuristic. Used only when the step's embedded stream yields no lane
 * evidence. */
function contentLaneOrder(blocks: readonly ContentBlock[]): 'thinking' | 'assistant' | undefined {
  for (const block of blocks) {
    if (block.type === 'reasoning') {
      if (block.text !== '') return 'thinking'
      continue
    }
    if (assistantBlocksVisibleNow([block])) return 'assistant'
  }
  return undefined
}

/** Whether Assistant content is visible before an interruption override. */
export function assistantBlocksVisibleNow(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.trim() !== '') return true
      continue
    }
    if (block.type === 'reasoning' || block.type === 'tool-call') continue
    // Any finalized non-text block is visible content, including future
    // ContentBlock extensions the TUI does not name yet.
    return true
  }
  return false
}

/** Whether Assistant blocks retain evidence at a closed attempt boundary. */
function assistantBlocksHaveInterruptionEvidence(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.trim() !== '') return true
      continue
    }
    if (block.type === 'reasoning') continue
    // Tool calls are hidden while running but become evidence at closure;
    // every other finalized block is evidence as well.
    return true
  }
  return false
}

/**
 * Flat text with known attachment positions preserved. The structured
 * `content` blocks remain canonical for rich rendering; this lightweight
 * projection feeds transcript search and loader-less user rendering. Unknown
 * finalized blocks stay in `content` so their explicit fallback can render
 * without polluting ordinary text previews.
 */
export { textWithAttachmentMarkers }

/** Whether a user message has human-visible finalized content. */
export { userBlocksVisibleNow }

/** Key identifying one step's model output (turn + step). */
/** Durable identity of one Tool call inside its OWN step: never the tool name,
 *  never a pending-call entry, and never a bare call id (ids can be reused by
 *  another step or turn). */
function toolCallKey(turn: number, step: number, callId: string): string {
  return `${stepKey(turn, step)}\u0000${callId}`
}

function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

type AssistantBlockState =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; id: string; name: string; arguments: string }
  | { kind: 'complete'; block: AssistantLiveContentBlock | ContentBlock }
  | { kind: 'opaque'; blockType: string }

type AssistantBlockChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: AssistantLiveContentBlock | ContentBlock }

interface AssistantStreamProjection {
  states: Map<number, AssistantBlockState>
  blocks: ContentBlock[]
  displayBlocks: AssistantDisplayBlock[]
  firstLane: 'thinking' | 'assistant' | undefined
  /** First chunk time carrying Focus-visible reply content (the old
   * single-purpose stream scan), `undefined` when none. */
  firstVisibleAt: number | undefined
  /** The last usage sample in the stream, `undefined` when none. */
  usage: UsageLike | undefined
  /** Lane timing from the SAME single decode (post-F6 plan §12.5): the
   * first/last chunk time at which the Thinking lane was visible, so the
   * durable Thinking row's sidecar timing costs no second pass. (The
   * Assistant lane needs no sidecar: assistant rows are Conversation
   * evidence and never Activity members.) */
  thinkingStartedAt: number | undefined
  thinkingEndedAt: number | undefined
  /** First tool-call-delta time per call id, for the Preparing → durable
   * elapsed continuity (post-F6 plan §12.14). */
  toolCallStarts: Map<string, number>
}

/**
 * The live arrays are intentionally retained and updated in place: streaming
 * projection must not copy the complete pending row for every indexed chunk.
 * TranscriptFolder already mutates its message objects in place; the separate
 * presentation revision is the cache identity for this live-only optimization.
 * Durable stream projections remain fresh arrays.
 */
interface LiveAssistantProjection {
  states: Map<number, AssistantBlockState>
  /** First-seen stream order of every block index (append-only; the
   * canonical BlockAssembler order — never numeric index order). */
  order: number[]
  /** index → position in `order`. */
  orderPos: Map<number, number>
  blockIndexes: number[]
  blocks: ContentBlock[]
  displayIndexes: number[]
  displayBlocks: AssistantDisplayBlock[]
  assistantVisibleCount: number
  thinkingVisibleCount: number
  openOpaqueCount: number
}

/** Start one typed partial block without pretending it is a finalized block. */
function emptyAssistantBlockState(blockType: string): AssistantBlockState {
  switch (blockType) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'tool-call': return { kind: 'tool-call', id: '', name: '', arguments: '' }
    default: return { kind: 'opaque', blockType }
  }
}

/**
 * Apply the shared block-folding semantics used by both transient live input
 * and durable embedded assistant streams. A numeric upstream index owns one
 * state at a time; its first block-end replaces the partial state
 * authoritatively and then freezes the completed block.
 */
function applyAssistantBlockChunk(blocks: Map<number, AssistantBlockState>, chunk: AssistantBlockChunk): boolean {
  switch (chunk.type) {
    case 'block-start':
      // The first block-start owns the index; duplicate starts must not erase
      // deltas already accepted for that block.
      if (blocks.has(chunk.index)) return false
      blocks.set(chunk.index, emptyAssistantBlockState(chunk.blockType))
      return true
    case 'text-delta': {
      const previous = blocks.get(chunk.index)
      if (previous?.kind === 'complete') return false
      if (previous?.kind === 'text' && chunk.text === '') return false
      blocks.set(chunk.index, {
        kind: 'text',
        text: previous?.kind === 'text' ? previous.text + chunk.text : chunk.text,
      })
      return true
    }
    case 'reasoning-delta': {
      const previous = blocks.get(chunk.index)
      if (previous?.kind === 'complete') return false
      if (previous?.kind === 'reasoning' && chunk.text === '') return false
      blocks.set(chunk.index, {
        kind: 'reasoning',
        text: previous?.kind === 'reasoning' ? previous.text + chunk.text : chunk.text,
      })
      return true
    }
    case 'tool-call-delta': {
      const previous = blocks.get(chunk.index)
      if (previous?.kind === 'complete') return false
      const base = previous?.kind === 'tool-call'
        ? previous
        : { kind: 'tool-call' as const, id: '', name: '', arguments: '' }
      const id = base.id || chunk.id
      const name = chunk.name ?? base.name
      const args = base.arguments + chunk.argumentsDelta
      if (previous?.kind === 'tool-call'
        && previous.id === id && previous.name === name && previous.arguments === args) return false
      blocks.set(chunk.index, {
        kind: 'tool-call',
        id,
        name,
        arguments: args,
      })
      return true
    }
    case 'block-end':
      if (blocks.get(chunk.index)?.kind === 'complete') return false
      blocks.set(chunk.index, { kind: 'complete', block: chunk.block })
      return true
  }
}

/** Preserve an already-authoritative block-end payload without using a
 * finalized ContentBlock shape for incomplete block-start state. The live port
 * is intentionally structural and the adapter guarantees block-end payloads
 * are complete official blocks. */
function authoritativeContentBlock(block: AssistantLiveContentBlock | ContentBlock): ContentBlock {
  return block as unknown as ContentBlock
}

function assistantContentFromBlockState(state: AssistantBlockState): ContentBlock | undefined {
  switch (state.kind) {
    case 'text': return { type: 'text', text: state.text }
    case 'reasoning': return { type: 'reasoning', text: state.text }
    case 'tool-call':
      return state.id === ''
        ? undefined
        : { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.arguments }
    case 'complete': return authoritativeContentBlock(state.block)
    case 'opaque': return undefined
  }
}

/** Project indexed block state in FIRST-SEEN stream order — the canonical
 * DSH BlockAssembler order (the numeric block index is a protocol handle,
 * never a content ordering key; the Map's insertion order is the first-seen
 * order, and re-setting an existing key keeps its position). */
function assistantContentFromBlocks(blocks: Map<number, AssistantBlockState>): ContentBlock[] {
  return [...blocks.entries()]
    .map(([, state]) => assistantContentFromBlockState(state))
    .filter((block): block is ContentBlock => block !== undefined)
}

/** Project one block state for rendering without promoting open opaque state to content. */
function assistantDisplayBlockFromState(state: AssistantBlockState): AssistantDisplayBlock | undefined {
  switch (state.kind) {
    case 'text': return { kind: 'content', block: { type: 'text', text: state.text } }
    case 'reasoning': return { kind: 'content', block: { type: 'reasoning', text: state.text } }
    case 'tool-call':
      return state.id === ''
        ? undefined
        : { kind: 'content', block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.arguments } }
    case 'complete': return { kind: 'content', block: authoritativeContentBlock(state.block) }
    case 'opaque': return { kind: 'open-opaque', blockType: state.blockType }
  }
}

/** Project all indexed states in FIRST-SEEN stream order for Assistant
 * display (the canonical BlockAssembler order — see
 * {@link assistantContentFromBlocks}). */
function assistantDisplayBlocksFromStates(blocks: Map<number, AssistantBlockState>): AssistantDisplayBlock[] {
  return [...blocks.entries()]
    .map(([, state]) => assistantDisplayBlockFromState(state))
    .filter((block): block is AssistantDisplayBlock => block !== undefined)
}

interface AssistantBlockProjection {
  content: ContentBlock | undefined
  display: AssistantDisplayBlock | undefined
  assistantVisible: boolean
  thinkingVisible: boolean
  opaque: boolean
}

function assistantBlockProjection(state: AssistantBlockState): AssistantBlockProjection {
  const content = assistantContentFromBlockState(state)
  const display = assistantDisplayBlockFromState(state)
  return {
    content,
    display,
    assistantVisible: state.kind === 'opaque'
      || (content !== undefined && assistantBlocksVisibleNow([content])),
    thinkingVisible: content !== undefined && content.type === 'reasoning' && content.text !== '',
    opaque: state.kind === 'opaque',
  }
}

/** Replace one indexed projection without rescanning the other indexes.
 * The projection arrays follow FIRST-SEEN stream order (the canonical DSH
 * BlockAssembler order), never numeric index order: `order` records each
 * block's first-seen position (append-only), and a block that gains a
 * projection after later blocks first-seen is inserted at its first-seen
 * rank — so the live order always matches the durable settlement, and an
 * occurrence identity derived from the projection never renumbers. */
function updateIndexedProjection<T>(
  order: number[],
  orderPos: Map<number, number>,
  indexes: number[],
  values: T[],
  index: number,
  value: T | undefined,
): void {
  let rank = orderPos.get(index)
  if (rank === undefined) {
    rank = order.length
    orderPos.set(index, rank)
    order.push(index)
  }
  // The block's position in the projection = its rank among the order
  // entries before it that are currently in the projection. Both arrays
  // are in first-seen order, so a lockstep walk counts the members.
  let position = 0
  let j = 0
  for (let i = 0; i < rank; i += 1) {
    if (j < indexes.length && indexes[j] === order[i]) {
      position += 1
      j += 1
    }
  }
  const present = j < indexes.length && indexes[j] === index
  if (value === undefined) {
    if (!present) return
    indexes.splice(position, 1)
    values.splice(position, 1)
    return
  }
  if (present) {
    values[position] = value
    return
  }
  indexes.splice(position, 0, index)
  values.splice(position, 0, value)
}

/** Whether a display projection contains user-visible Assistant output. */
function assistantDisplayBlocksVisibleNow(blocks: readonly AssistantDisplayBlock[]): boolean {
  for (const block of blocks) {
    if (block.kind === 'open-opaque') return true
    if (assistantBlocksVisibleNow([block.block])) return true
  }
  return false
}

/** Whether a display projection retains evidence at a closed attempt boundary. */
function assistantDisplayBlocksHaveInterruptionEvidence(blocks: readonly AssistantDisplayBlock[]): boolean {
  for (const block of blocks) {
    if (block.kind === 'open-opaque') return true
    if (assistantBlocksHaveInterruptionEvidence([block.block])) return true
  }
  return false
}

/** Use the semantic or display-only projection for entry visibility. */
export function assistantEntryVisibleNow(entry: Extract<TranscriptMessage, { kind: 'assistant' }>): boolean {
  if (entry.deliverables !== undefined && entry.deliverables.length > 0) return true
  return entry.displayBlocks === undefined
    ? assistantBlocksVisibleNow(assistantEntryBlocks(entry))
    : assistantDisplayBlocksVisibleNow(entry.displayBlocks)
}

/** Use the semantic or display-only projection for attempt evidence. */
function assistantEntryHasInterruptionEvidence(entry: Extract<TranscriptMessage, { kind: 'assistant' }>): boolean {
  return entry.displayBlocks === undefined
    ? assistantBlocksHaveInterruptionEvidence(assistantEntryBlocks(entry))
    : assistantDisplayBlocksHaveInterruptionEvidence(entry.displayBlocks)
}

/**
 * Stateful transcript folding: apply appended events incrementally and read
 * the message list. Objects are mutated in place across applies, so a caller
 * that rebuilds its view from `messages()` stays consistent at every step.
 */
type ReadGroupCard = Extract<TranscriptMessage, { kind: 'tool' }>

interface ReadGroupMeta {
  firstTurn: number
  spansTurns: boolean
}

/** One lightweight searchable entry, index-aligned with `items` (the raw
 * item index IS the stable {@link TranscriptItemId}). `normalizedText` is
 * lowercased as a WHOLE string, lazily: a mutation only marks the entry
 * dirty (O(1) bookkeeping on the live hot path — streaming chunks and
 * read-group expansions never pay per-chunk/per-member lowercase), and the
 * next query re-normalizes exactly the dirty entries. A merged read
 * group's searchable text lives ONLY on its representative entry;
 * non-representative members are skipped at scan time, so a group
 * expansion marks exactly one entry. */
interface TranscriptSearchEntry {
  /** The CURRENT visible turn of the card this entry mirrors (refreshed
   * when the entry is normalized). */
  turn: number
  /** The normalized searchable text of the CURRENT visible card. For a
   * merged read group this is the group's text on the representative entry
   * only; non-representative members keep their own raw text and are
   * skipped at scan time. */
  normalizedText: string
  /** The source spans of `normalizedText` (occurrence → semantic origin). */
  spans: readonly TranscriptSearchCorpusSpan[]
}

interface NextStepInboxIdentity {
  id: string
  /** The turn that was open when this identity entered next-step, if any. */
  insertionTurn: number | undefined
  /** The Session timestamp when this identity entered next-step. */
  insertionTime: number
}

/** The raw item index of each active run's card (search dirty marking);
 * the shared {@link WorkflowProjection} owns the projection itself. */

export class TranscriptFolder {
  private readonly items: TranscriptMessage[] = []
  /** Durable next-step identities awaiting a claim or replacement. */
  private readonly pendingNextSteps: NextStepInboxIdentity[] = []
  /** Claimed next-step identities, including their insertion time. */
  private readonly claimedNextStepTurns = new Map<string, NextStepInboxIdentity>()
  /** The assistant message object per (turn, step); streaming text lands in place. */
  private readonly assistantEntries = new Map<string, Extract<TranscriptMessage, { kind: 'assistant' }>>()
  /** Durable delivery declarations retained with their event sequence until
   * the turn's closing assistant selects the valid prefix. */
  private readonly deliverableDeclarationsByTurn = new Map<number, Array<PresentedFilePresentation & { readonly seq: number }>>()
  /** Durable assistant/message sequence per step, used as the closing boundary. */
  private readonly assistantSettlementSeqs = new Map<string, number>()
  /** The durable lane chronology authority per assistant step (post-F6 plan
   * §4.3): the first lane of the step's LATEST authoritative durable
   * evidence — stored at every `assistant/message` / `assistant/attempt`
   * settlement that carries lane evidence. Settlement materialization and
   * late diagnostic reasoning place the Thinking/Assistant lanes by THIS
   * stored authority, never by row existence (a row's presence proves
   * nothing about the step's chronology). */
  private readonly stepLaneOrders = new Map<string, 'thinking' | 'assistant'>()
  /** Display-order displacements for lane rows whose physical append order
   * contradicts the step's stored authority (`convergeStepLaneOrder`):
   * displaced raw index → its anchor Assistant row. `items` itself stays
   * strictly append-only (the `TranscriptItemId` contract), so these maps
   * are pure presentation order — every raw-index-keyed structure (search
   * ids, turn boundaries, read groups, compaction/workflow cards) keeps its
   * physical meaning and needs no remap. Mutate ONLY through
   * `setLaneDisplay`/`dropLaneDisplacement`/`dropLaneAnchor` (they keep the two inverse maps
   * in sync and bump the search revision). */
  private readonly laneDisplayByDisplaced = new Map<number, { anchor: number; position: 'before' | 'after' }>()
  /** Inverse of {@link laneDisplayByDisplaced}: one anchor row (the settled
   * Assistant row of a step) → the rows emitted around it during
   * `displayOrderedRawIds`. `before`/`after` keep the displaced raw indexes in
   * RAW order, so the emitted sequence is deterministic and evidence-backed
   * rather than dependent on the order relations were recorded in. One anchor
   * owns at most one Thinking lane row (the existing lane authority) plus the
   * step's Tool rows whose own materialization time proves they belong on the
   * other side of the Conversation. */
  private readonly laneDisplayByAnchor = new Map<number, { before: number[]; after: number[] }>()
  /** Raw item index of each GENUINE `tool/call` card, keyed by its durable
   * `(turn, step, callId)` identity (never the tool name). The index is recorded
   * once at append and the card's object identity is re-verified before use, so
   * a stale index can never displace another row — including a call id reused by
   * another step or turn. This is NOT a replacement for `pendingCalls` (that one
   * is deleted when the call settles and never owns a long-lived identity). */
  private readonly toolCardIndexOf = new Map<string, number>()
  /** In-flight live block state keyed by logical step. This is required for
   * authoritative block-end replacement: deltas may be partial, while a
   * completed block replaces the entire indexed state without duplication. */
  private readonly liveAssistantBlocks = new Map<string, LiveAssistantProjection>()
  /** Assistant entries created by the LIVE stream path and not yet taken
   * over by a durable settlement. Attempt evidence remains transient until
   * retry or turn end; abandoned attempts have no durable surface and are
   * tombstoned so live and reopen agree. */
  private readonly transientAssistantEntries = new WeakSet<Extract<TranscriptMessage, { kind: 'assistant' }>>()
  /** Entries reconstructed from a durable `assistant/attempt`. They remain
   * diagnostic evidence until a retry resets them or turn/end marks them as
   * interrupted; they never become a normal settled message. */
  private readonly attemptAssistantEntries = new WeakSet<Extract<TranscriptMessage, { kind: 'assistant' }>>()
  /** Assistant entries REMOVED by a failed-attempt settlement. They stay in
   * the raw item list so every index-keyed projection (turn starts, search
   * entries, groups) keeps its stable indexes, but every visible projection
   * skips them — a tombstone, never a mid-array splice. */
  private readonly hiddenAssistantEntries = new WeakSet<Extract<TranscriptMessage, { kind: 'assistant' }>>()
  /** Reasoning entries from a live-abandoned attempt are transient too. Keep
   * their raw indexes stable, but tombstone them so abandoned live and cold
   * replay projections agree. */
  private readonly hiddenThinkingEntries = new WeakSet<Extract<TranscriptMessage, { kind: 'thinking' }>>()
  /** The thinking entry object per (turn, step), for in-place text updates. */
  private readonly thinkingEntries = new Map<string, Extract<TranscriptMessage, { kind: 'thinking' }>>()
  /** Thinking entries that still need a lifecycle boundary to settle. The
   * complete entry map above is retained for replay updates; this index keeps
   * turn/end from revisiting settled history. */
  private readonly openThinkingByTurn = new Map<number, Set<Extract<TranscriptMessage, { kind: 'thinking' }>>>()
  /** Tool calls awaiting their result, keyed by callId with their running card. */
  private readonly pendingCalls = new Map<string, { name: string; args: string; turn: number; card: Extract<TranscriptMessage, { kind: 'tool' }>; index: number }>()
  /** Nested PTC sub-dispatches awaiting their settle, keyed by subCallId
   * (`tool/ptc-dispatch-start` → `tool/ptc-dispatch`). The child
   * card lives INSIDE its parent's `subCalls` tree, never in `items`. */
  private readonly pendingSubCalls = new Map<string, TranscriptToolMessage>()
  /** Every mounted PTC sub-call card by subCallId, for parent lookup of
   * deeper nesting (a sub-call's parent may itself be a sub-call). */
  private readonly subCallIndex = new Map<string, TranscriptToolMessage>()
  /** The depth of every mounted PTC sub-call (root = 1): the ingestion-side
   * topology gate keeps the tree within {@link PTC_MAX_DEPTH} so the
   * recursive consumers only need a defensive fallback. */
  private readonly subCallDepth = new Map<string, number>()
  /** PTC sub-call events whose parent is not yet mounted (an incomplete
   * replay fragment): start/settle facts are parked here and connected
   * when the parent appears — never promoted to top-level surface rows. */
  private readonly orphanSubCalls = new Map<string, {
    start?: { rootCallId: string; parentCallId: string; name: string; arguments: unknown }
    settle?: { rootCallId: string; parentCallId: string; name: string; arguments: unknown; isError: boolean; content: readonly ContentBlock[] }
  }>()
  /** Tool names by callId, for result pairing. */
  private readonly callNames = new Map<string, string>()
  /** Unresolved assistant tool REQUESTS by call id (TOOL_NOT_STARTED
   * compat): the durable `assistant/message` tool-call block identity of a
   * request that has not reached a durable `tool/call` yet. A `tool/call`
   * consumes its entry (the request started); any `tool/result` for the id
   * consumes it too (the request settled). Never a transcript row — only
   * identity evidence for a not-started recovery diagnostic. */
  /** Durable tool-call REQUESTS (TOOL_NOT_STARTED compat), keyed by the same
   *  `(turn, step, callId)` identity as the tool index: two steps that request
   *  the same call id own separate entries, and one step can never consume or
   *  overwrite another's request. */
  private readonly requestedToolCalls = new Map<string, { turn: number; step: number; name: string }>()
  /** The real command lifecycle index (post-PR166 plan §5): commandId → the
   * ONE `kind: 'command'` row plus its raw item index. Entries survive
   * settlement — the bounded manual-compaction correlation resolves by
   * commandId in O(1) even when the compaction evidence lands later. */
  private readonly commands = new Map<CommandId, { index: number; message: TranscriptCommandMessage }>()
  /** Search entries of turn-less rows appended before the first ACCEPTED
   * turn/start: they re-anchor to that turn when it arrives. */
  private readonly pendingAnchorEntries: number[] = []
  /** Whether an ACCEPTED `turn/start` has been seen. The leading-prefix
   * re-anchor decision is keyed on THIS — never on `anchor === 0`, because
   * turn 0 itself is a perfectly legal first turn (an in-turn-0 command
   * anchored to 0 must NOT be re-anchored away by turn 1). */
  private seenAcceptedTurnStart = false
  /** The placement-anchor AUTHORITY for turn-less standalone rows (plan
   * §8.1/§9): one anchor per command object, written at append time and
   * re-anchored with the leading prefix. Search navigation, the fast
   * indexed window's physical ranges and the non-monotonic defensive window
   * all derive placement from this ONE sidecar — never a semantic `turn` on
   * the row. */
  private readonly commandPlacementTurns = new WeakMap<TranscriptCommandMessage, number>()
  /** The placement anchor a fused command HANDS OVER to its combined
   * manual-compaction owner: the visible representative of a manual
   * `/compact` is the compaction card, so its window/search placement must
   * inherit the command's anchor (a pre-turn or replayed manual compaction
   * would otherwise keep the legacy `currentTurn` and anchor the wrong
   * bounded window). Written at fuse time; re-anchored with the leading
   * prefix exactly like the command sidecar. */
  private readonly manualCompactionPlacementTurns = new WeakMap<Extract<TranscriptMessage, { kind: 'compaction' }>, number>()
  /** Manual-compaction correlation legs (post-PR166 plan §7): bounded direct
   * lookups so `command/done.sourceEventSeq` and compaction
   * `sourceCommandId` never scan history. */
  private readonly compactionBySummarySeq = new Map<SessionEventSeq, number>()
  private readonly compactionBySourceCommandId = new Map<CommandId, number>()
  /** The ESTABLISHED combined owner per command (commandId → the owning
   * compaction card's raw index): once leg 1 proves the relationship the
   * ownership is fixed, and the command's settlement refreshes the owner's
   * search corpus through this relation. */
  private readonly compactionOwnerByCommandId = new Map<CommandId, number>()
  /** Commands fused into their compaction card: hidden from every visible
   * projection (the card is the one visible owner) while the row itself and
   * its relationship stay inspectable. */
  private readonly fusedCommands = new WeakSet<TranscriptCommandMessage>()
  /** First streamed tool-call-delta time per call identity, from BOTH the
   * live chunks and the durable embedded streams: the earliest authoritative
   * start of a call, so a Preparing → durable handoff never resets its
   * elapsed time (post-F6 plan §12.14). Keyed by the formal call id OR the
   * (turn, step, index) fallback identity, and each entry carries its
   * OWNING step so a retry/boundary clears BOTH key shapes — a reused call
   * id in a later attempt must never inherit a dead attempt's timer. */
  private readonly toolCallPreparingStarts = new Map<string, { at: number; owner: string }>()
  /** Active Workflow runs: the shared semantic projection (owner tracking,
   * interruption projection, member/run settlement) plus the raw item index
   * of each active run's card for search dirty marking. */
  private readonly workflow = new WorkflowProjection(runId => {
    const index = this.workflowIndexes.get(runId)
    if (index !== undefined) this.markSearchEntryDirty(index)
  })
  private readonly workflowIndexes = new Map<string, number>()
  /** Compaction lifecycle: compactionId → items index (start/summary/end). */
  private readonly compacting = new Map<string, number>()
  /** The turn most recently opened by turn/start. */
  private currentTurn = 0
  /** The turn currently between its turn/start and turn/end boundaries. */
  private openTurn: number | undefined
  /**
   * Incremental consecutive-read grouping (stage J): `groupOf` maps an item
   * index to its merged group card (only the FIRST member emits it in the
   * output); `groupMembers` maps a group card to its member indices. Live
   * tail appends extend a run from its boundary, while non-tail settlements
   * use the defensive reflow path. `messages()` never re-walks the history to
   * group — only the output list is built.
   */
  private readonly groupOf = new Map<number, ReadGroupCard>()
  private readonly groupMembers = new Map<ReadGroupCard, number[]>()
  /** Constant-time turn-span facts for the live append path. */
  private readonly groupMeta = new Map<ReadGroupCard, ReadGroupMeta>()
  /** During cold replay, read cards settle in log order but must not rebuild
   * their entire adjacent run after every result. The finalizer installs all
   * groups in one linear pass once the event fold is complete. */
  private hydrating = false
  private groupingDirty = false

  /** The incremental full-history search projection (stage D1): one entry
   * per raw item, index-aligned with {@link items}. Query-time cost is a
   * lightweight scan of normalized strings — never `messages()`, never a
   * per-query lowercase pass over the whole history. */
  private readonly searchEntries: TranscriptSearchEntry[] = []
  /** The dirty search entries (raw item indices): the discovery structure
   * for query-time lazy normalization — a query normalizes exactly these,
   * never a full-history scan. */
  private readonly dirtySearchEntries = new Set<number>()
  /** Bumped on EVERY search-projection change — entry mutation (append,
   * settlement, group reflow) AND display-order change (lane displacement
   * via `setLaneDisplay`/`dropLaneDisplacement`/`dropLaneAnchor`): the projection's content
   * and its ORDER are both part of the revision, so query refinement must
   * not reuse previous candidates across one. */
  private searchRevisionCounter = 0
  /** Step key → raw item index, for in-place streaming text updates.
   * Namespaced by entry kind (`assistant:` / `thinking:`): a step streams
   * BOTH reasoning and text, and the two entries share the same
   * stepKey(turn, step) — an un-namespaced map would let one kind's deltas
   * land on the other kind's searchable entry. */
  private readonly searchIndexByStepKey = new Map<string, number>()
  // Test-only counters exposed by searchDiagnosticsForTest().
  private searchRefreshCount = 0
  /** Test-only: the number of dirty entries scanned by lazy normalization
   * (proves the query path is O(#dirty), never O(history)). */
  private searchDirtyScanCount = 0
  private searchFullScanCount = 0
  /** Test-only: the row count of the LAST regroup envelope. It bounds the
   * normal serial case (a display-order change re-groups its affected relation
   * neighborhood); a late/distant settlement may legitimately require a wide
   * envelope spanning the rows between the displaced row and its anchor. */
  private lastRegroupSpanRows = 0
  /** Seeds accumulated while a convergence coalesces its relation changes. */
  private pendingRegroupSeeds: number[] | undefined = undefined
  /** Test-only: how many regroup operations actually ran. */
  private regroupOperationCount = 0
  /** Test-only: how many group members the LAST envelope closure visited. A
   *  deterministic guard that a late-result regroup is linear in the affected
   *  run, never quadratic. */
  private lastRegroupMemberVisits = 0
  private searchRefineCount = 0
  /** Test-only: the number of CANDIDATE CARDS re-scanned by refinement
   * (proves refinement is O(candidate cards), never O(previous occurrences)). */
  private searchRefineCandidates = 0
  private groupingRebuildCount = 0

  /**
   * Turn index for the display window (stage J): the first item index of
   * every distinct turn, in log order. The bounded `window()` projection derives
   * its start and summary counts from these indexes, so ordinary repainting
   * never rescans the pre-window history. Turn
   * values are expected to be monotonic in log order; a non-monotonic log
   * (corrupt data) disables the fast path and falls back to the full scan.
   */
  private readonly turnStarts: number[] = []
  /** The turn value at each corresponding {@link turnStarts} entry. Kept as
   * a separate scalar index so window navigation never reads an old item just
   * to discover its turn. The array itself is exposed read-only to the
   * presentation-only TranscriptWindowController without copying it. */
  private readonly turnValues: number[] = []
  /** Distinct raw turns, including values discovered after monotonicity breaks. */
  private readonly turnValueSet = new Set<number>()
  /** The grouped tool-card count (what `messages()` emits), maintained
   * incrementally for the window summary ("N tool calls" of the collapsed
   * history). */
  private groupedToolCount = 0
  /** Merged read groups whose members span MORE THAN ONE turn: their output
   * card carries only the max turn, so the raw-item turn index over-counts
   * the window summary. While any exist, the window path defers to the full
   * grouped-turn index below for exact summary facts. The item projection stays
    * bounded even when any exist. */
  private crossTurnGroups = 0
  /** Distinct turns represented by grouped output cards, kept monotonic for
    * binary-searchable older/newer counts. A defensive middle reflow marks it
    * dirty and rebuilds it once before the next bounded projection. */
  private readonly groupedTurnCounts = new Map<number, number>()
  private groupedTurnValues: number[] = []
  private groupedTurnIndexDirty = false
  private turnsMonotonic = true
  /** Per-turn Focus activity, maintained incrementally in {@link applyEvent}
   * (plan §20.1) — a plain map is enough for the ≤ WINDOW_TURNS view. */
  private readonly activityByTurn = new Map<number, MutableTurnActivity>()
  /** The shared per-step usage accounting (the same class the session
   * stats fold uses — the footer and the Focus per-turn token can never
   * drift). */
  private readonly usage = new StepUsageAccumulator()
  /** The bounded reasoning tail cap: previews never buffer the full stream. */
  private static readonly THINKING_TAIL_CAP = THINKING_TAIL_CAP
  /** The bounded message candidate tail cap (streaming assistant text). */
  private static readonly MESSAGE_TAIL_CAP = 400

  /** One turn's Focus activity, created on its first event (defensive:
   * a turn/start-less log fragment still aggregates). */
  private activityFor(turn: number): MutableTurnActivity {
    let activity = this.activityByTurn.get(turn)
    if (activity === undefined) {
      activity = {
        turn,
        completed: false,
        assistantMessages: 0,
        toolCalls: 0,
        tools: new Map(),
        thinkingTail: '',
        confirmedSteps: new Set(),
        settledSteps: new Set(),
        firstVisibleAssistantTimes: new Map(),
        committedAnswerSteps: new Set(),
        revision: 0,
      }
      this.activityByTurn.set(turn, activity)
    }
    return activity
  }

  /** Attach one PTC sub-call to its real parent card (never the top-level
   * surface flow), then connect any parked orphans waiting for it and apply
   * a parked settle for the same subCallId (a settle may arrive before its
   * start when the parent is already mounted). This method is the topology
   * gate for the whole sub-call tree: every edge is validated here (root
   * collision, ancestry, depth cap), so the mounted tree always satisfies
   * the alpha.2 cap and a corrupted/replayed input can never overflow the
   * stack during ingestion. A duplicate subCallId with a conflicting
   * identity is impossible on a valid alpha.2 durable stream — fail fast
   * instead of silently keeping one. */
  private attachSubCall(
    parent: TranscriptToolMessage,
    parentId: string,
    data: { rootCallId: string; parentCallId: string; subCallId: string; name: string; arguments: unknown },
  ): void {
    // Cross-root coherence: a sub-call's parent must belong to the same
    // root the event claims (a run_code parent has no rootCallId — its own
    // callId IS the root).
    if (parent.rootCallId !== undefined && parent.rootCallId !== data.rootCallId) {
      throw new Error(`cross-root PTC sub-call ${data.subCallId}: parent ${parentId} belongs to root ${parent.rootCallId}, event claims root ${data.rootCallId}`)
    }
    if (parent.rootCallId === undefined && data.rootCallId !== parentId) {
      throw new Error(`cross-root PTC sub-call ${data.subCallId}: parent ${parentId} is the root call, event claims root ${data.rootCallId}`)
    }
    if (parent.rootCallId === undefined && parent.name !== 'run_code') {
      throw new Error(`PTC sub-call ${data.subCallId}: top-level parent ${parentId} is ${parent.name}, expected run_code`)
    }
    const existing = this.subCallIndex.get(data.subCallId)
    if (existing !== undefined) {
      if (existing.rootCallId !== data.rootCallId
        || existing.parentCallId !== data.parentCallId
        || existing.name !== data.name
        || existing.args !== JSON.stringify(data.arguments)) {
        throw new Error(`conflicting PTC sub-call identity for ${data.subCallId}: start root=${data.rootCallId} parent=${data.parentCallId} name=${data.name}, mounted root=${existing.rootCallId} parent=${existing.parentCallId} name=${existing.name}`)
      }
      return
    }
    // A parked start for the same subCallId (its parent was unknown when it
    // arrived) must agree with this one — a conflict is impossible on a
    // valid alpha.2 stream and fails fast.
    const parked = this.orphanSubCalls.get(data.subCallId)
    if (parked?.start !== undefined
      && (parked.start.rootCallId !== data.rootCallId
        || parked.start.parentCallId !== data.parentCallId
        || parked.start.name !== data.name
        || JSON.stringify(parked.start.arguments) !== JSON.stringify(data.arguments))) {
      throw new Error(`conflicting PTC sub-call start identity for ${data.subCallId}: parked root=${parked.start.rootCallId} parent=${parked.start.parentCallId} name=${parked.start.name}, duplicate root=${data.rootCallId} parent=${data.parentCallId} name=${data.name}`)
    }
    // Topology gate: a sub-call must never collide with its root callId
    // (the root is not in subCallIndex, so this malformed edge would
    // otherwise be accepted), repeat a subCallId already on its parent
    // chain, or exceed the alpha.2 depth cap (root = depth 1, so at most
    // 255 child levels).
    if (data.subCallId === data.rootCallId) {
      throw new Error(`PTC sub-call ${data.subCallId} collides with its root callId`)
    }
    let ancestor: TranscriptToolMessage | undefined = parent
    while (ancestor !== undefined && ancestor.subCallId !== undefined) {
      if (ancestor.subCallId === data.subCallId) {
        throw new Error(`PTC sub-call ${data.subCallId} repeats an ancestor subCallId`)
      }
      ancestor = ancestor.parentCallId === undefined ? undefined : this.subCallIndex.get(ancestor.parentCallId)
    }
    const parentDepth = parent.subCallId === undefined ? 1 : this.subCallDepth.get(parent.subCallId)!
    const depth = parentDepth + 1
    if (depth > PTC_MAX_DEPTH) {
      throw new Error(`PTC sub-call ${data.subCallId} exceeds the depth cap ${PTC_MAX_DEPTH}: parent ${parentId} is at depth ${parentDepth}`)
    }
    const child: TranscriptToolMessage = {
      kind: 'tool',
      turn: parent.turn,
      name: data.name,
      args: JSON.stringify(data.arguments),
      result: '',
      status: 'running',
      subCallId: data.subCallId,
      parentCallId: data.parentCallId,
      rootCallId: data.rootCallId,
    }
    if (parent.subCalls === undefined) parent.subCalls = []
    parent.subCalls.push(child)
    this.pendingSubCalls.set(data.subCallId, child)
    this.subCallIndex.set(data.subCallId, child)
    this.subCallDepth.set(data.subCallId, depth)
    this.attachPendingOrphans(child, data.subCallId)
    this.consumeParkedSettle(data.subCallId)
    this.refreshActiveSubCallsFor(child)
  }

  /** Connect parked PTC orphans whose parent just became available. The
   * orphan entry itself (including a parked settle) is consumed inside
   * {@link attachSubCall} — one attach semantics for every path. */
  private attachPendingOrphans(parent: TranscriptToolMessage, parentId: string): void {
    for (const [id, orphan] of [...this.orphanSubCalls]) {
      if (orphan.start !== undefined && orphan.start.parentCallId === parentId) {
        this.attachSubCall(parent, parentId, { ...orphan.start, subCallId: id })
      }
    }
  }

  /** Apply a parked settle for a just-attached sub-call (a settle may
   * arrive before its start when the parent is already mounted) and drop
   * the consumed orphan entry. */
  private consumeParkedSettle(subCallId: string): void {
    const parked = this.orphanSubCalls.get(subCallId)
    if (parked === undefined) return
    this.orphanSubCalls.delete(subCallId)
    if (parked.settle !== undefined) this.settleSubCall(subCallId, parked.settle)
  }

  /** Settle one PTC sub-call by subCallId; a settle without a mounted child
   * is parked and applied when its start/parent appears. The lifecycle
   * status is the durable `isError` flag ONLY — the alpha.2 terminal
   * contract (a nonzero `[exit code: N]` / `[killed by signal: ...]` tail
   * marker) is a PRESENTATION concern applied by
   * {@link subCallDisplayStatus} at render time, never baked into the
   * durable card. The settle's durable identity (root/parent/name/
   * arguments) is cross-checked against the mounted child — a mismatch is
   * impossible on a valid alpha.2 stream and fails fast. */
  private settleSubCall(subCallId: string, data: {
    rootCallId: string
    parentCallId: string
    name: string
    arguments: unknown
    isError: boolean
    content: readonly ContentBlock[]
  }): void {
    const child = this.pendingSubCalls.get(subCallId)
    if (child !== undefined) {
      if (child.rootCallId !== data.rootCallId
        || child.parentCallId !== data.parentCallId
        || child.name !== data.name
        || child.args !== JSON.stringify(data.arguments)) {
        throw new Error(`conflicting PTC sub-call settle identity for ${subCallId}: settle root=${data.rootCallId} parent=${data.parentCallId} name=${data.name}, mounted root=${child.rootCallId} parent=${child.parentCallId} name=${child.name}`)
      }
      const text = textOf(data.content ?? [])
      child.status = data.isError === true ? 'error' : 'ok'
      child.result = text
      child.resultBlocks = data.content
      this.pendingSubCalls.delete(subCallId)
      this.refreshActiveSubCallsFor(child)
      return
    }
    const orphan = this.orphanSubCalls.get(subCallId)
    if (orphan !== undefined) {
      // A second parked settle with a conflicting durable identity is
      // impossible on a valid alpha.2 stream — fail fast instead of
      // silently overwriting the first (last-write-wins).
      if (orphan.settle !== undefined
        && (orphan.settle.rootCallId !== data.rootCallId
          || orphan.settle.parentCallId !== data.parentCallId
          || orphan.settle.name !== data.name
          || JSON.stringify(orphan.settle.arguments) !== JSON.stringify(data.arguments))) {
        throw new Error(`conflicting PTC sub-call settle identity for ${subCallId}: first settle root=${orphan.settle.rootCallId} parent=${orphan.settle.parentCallId} name=${orphan.settle.name}, duplicate root=${data.rootCallId} parent=${data.parentCallId} name=${data.name}`)
      }
      orphan.settle = data
    } else {
      this.orphanSubCalls.set(subCallId, { settle: data })
    }
  }

  /** Recompute the Focus active-descendant projection for the root card of
   * one PTC sub-call, bump the root's subtree revision (render-cache
   * invalidation for the in-place child mutations) and mark the root's
   * search entry dirty (the recursive corpus changed). Tool stats are
   * NEVER touched. */
  private refreshActiveSubCallsFor(child: TranscriptToolMessage): void {
    const root = child.rootCallId === undefined
      ? undefined
      : this.pendingCalls.get(child.rootCallId)?.card ?? this.subCallIndex.get(child.rootCallId)
    if (root === undefined) return
    root.subtreeRevision = (root.subtreeRevision ?? 0) + 1
    const rootEntry = child.rootCallId === undefined ? undefined : this.pendingCalls.get(child.rootCallId)
    if (rootEntry !== undefined) this.markSearchEntryDirty(rootEntry.index)
    const activity = this.activityFor(root.turn)
    if (activity.tool === undefined) return
    const active = activeSubCallsOf(root)
    if (active.length === 0) {
      activity.tool.activeSubCalls = undefined
    } else {
      activity.tool.activeSubCalls = active
    }
    activity.revision += 1
  }

  /** The Focus activity of one turn (read-only view; the same object the
   * map holds — the narrative slot is materialized eagerly). */
  turnActivity(turn: number): TurnActivity | undefined {
    return this.activityByTurn.get(turn)
  }

  /** The Focus activities of every known turn (read-only views). Returned
   * BY REFERENCE — no per-repaint copy, so the cost stays O(1) no matter
   * how long the session is (the projection only touches the windowed
   * turns, plan §37). */
  turnActivities(): ReadonlyMap<number, TurnActivity> {
    return this.activityByTurn as ReadonlyMap<number, TurnActivity>
  }

  /** Restore one authoritative reasoning body into the bounded Focus preview. */
  private restoreThinkingPreview(activity: MutableTurnActivity, step: number, text: string): void {
    if (step < (activity.lastAssistantStep ?? step)) return
    activity.thinkingStep = step
    activity.thinkingTail = text.slice(-TranscriptFolder.THINKING_TAIL_CAP)
    // The preview keeps the tail's latest line in full: width clipping is
    // the renderer's job (a head cap here would drop the true tail before
    // the follow-end window ever sees it).
    const line = latestLine(activity.thinkingTail)
    activity.think = line === '' ? undefined : { text: line, running: this.thinkRunningFor(activity, step) }
    activity.revision += 1
  }

  /** The authoritative reasoning-running fact for one activity's Think
   * slot: true only while that step's reasoning entry still streams and the
   * step has not settled. This is the follow-end gate — a turn can keep
   * running after reasoning settled. */
  private thinkRunningFor(activity: MutableTurnActivity, step: number): boolean {
    if (activity.settledSteps.has(step)) return false
    return this.thinkingEntries.get(stepKey(activity.turn, step))?.running === true
  }

  /** Mirror a reasoning entry's settlement onto an ALREADY materialized
   * Think preview (the live attempt/turn ends without re-materializing the
   * line). */
  private markThinkSettled(activity: MutableTurnActivity, step: number): void {
    if (activity.thinkingStep !== step || activity.think === undefined || activity.think.running === false) return
    activity.think = { text: activity.think.text, running: false }
    activity.revision += 1
  }

  /** Clear the Focus reasoning preview owned by one authoritative step. */
  private clearThinkingPreview(activity: MutableTurnActivity, step: number): void {
    if (step < (activity.lastAssistantStep ?? step)) return
    if (activity.thinkingStep !== step) return
    activity.thinkingStep = undefined
    if (activity.thinkingTail === '' && activity.think === undefined) return
    activity.thinkingTail = ''
    activity.think = undefined
    activity.revision += 1
  }

  /** Fold one reasoning delta into the activity's Think slot: the rolling
   * tail keeps the LAST fragment (bounded), and the preview is the tail's
   * latest non-empty line — never the whole stream (plan §10.6). */
  private foldThinking(activity: MutableTurnActivity, step: number, delta: string): void {
    // After turn/end the Think slot was settled: a late reasoning delta
    // (replay artifact) must not mutate it (review finding). The thinking
    // transcript entry still accumulates the delta.
    if (activity.completed || step < (activity.lastAssistantStep ?? step)) return
    activity.thinkingStep = step
    activity.thinkingTail = (activity.thinkingTail + delta).slice(-TranscriptFolder.THINKING_TAIL_CAP)
    // Keep the latest line in full (see restoreThinkingPreview): the
    // renderer's follow-end window owns width clipping.
    const line = latestLine(activity.thinkingTail)
    activity.think = line === '' ? undefined : { text: line, running: this.thinkRunningFor(activity, step) }
    activity.revision += 1
  }

  /** Fold one text delta into the activity's Message candidate: the
   * candidate belongs to ONE step (a later step's output confirms the
   * earlier candidate first — plan §5.3 C), and its tail is bounded. */
  private foldMessageCandidate(activity: MutableTurnActivity, step: number, delta: string): void {
    if (delta === '') return
    // After turn/end the final was already resolved: a late text delta
    // (replay artifact) must never resurrect a Message candidate — the
    // final would render both as the transcript final AND the Thought
    // Message preview (review finding). The transcript entry still
    // accumulates the delta; only the Focus projection ignores it.
    if (activity.completed) return
    // A delta for a step whose candidate was ALREADY confirmed is stale:
    // it must never resurrect a candidate (nor confirm a newer one that
    // is still streaming) — review finding.
    if (activity.confirmedSteps.has(step)) return
    // A delta for a step whose output was already authoritatively settled
    // by a message is a replay artifact: it must never corrupt the settled
    // preview (review finding).
    if (activity.settledSteps.has(step)) return
    // A delta for a step OLDER than the latest seen is stale: it must
    // never roll back the candidate or the final-answer dedup (review
    // finding).
    if (step < (activity.lastAssistantStep ?? step)) return
    const candidate = activity.messageCandidate
    if (candidate !== undefined && candidate.step !== step) {
      this.confirmMessageCandidate(activity)
    }
    if (candidate === undefined || candidate.step !== step) {
      activity.messageCandidate = { step, tail: delta.slice(-TranscriptFolder.MESSAGE_TAIL_CAP) }
    } else {
      candidate.tail = (candidate.tail + delta).slice(-TranscriptFolder.MESSAGE_TAIL_CAP)
    }
    // Monotonic: a late event for an older step never regresses the last
    // assistant step (review finding).
    activity.lastAssistantStep = Math.max(activity.lastAssistantStep ?? -1, step)
    this.syncMessage(activity)
    activity.revision += 1
  }

  /** Confirm the current message candidate as an intermediate message
   * (a later tool/call, a later step, or later output proves the turn
   * continues — plan §5.3). The confirmed text is bounded; the full
   * message stays in the transcript entry. */
  private confirmMessageCandidate(activity: MutableTurnActivity): void {
    const candidate = activity.messageCandidate
    if (candidate === undefined) return
    const text = candidate.tail
    // The bounded TAIL (never the head): the preview shows the message's
    // LATEST content, so a long intermediate message confirmed by a
    // later tool/step must not freeze its stale leading text (review
    // finding). An EMPTY candidate clears the confirmed text — the stale
    // earlier preview must not survive (review finding).
    activity.messageConfirmed = text === ''
      ? undefined
      : text.slice(-TranscriptFolder.MESSAGE_TAIL_CAP)
    activity.messageConfirmedStep = candidate.step
    activity.confirmedSteps.add(candidate.step)
    activity.messageCandidate = undefined
  }

  /** Commit the exact previous text-only answer once its next step admits a
   * same-turn human steer. It leaves the replay fences intact and only moves
   * that step out of the transient Message slot. */
  private commitPreSteerAnswer(activity: MutableTurnActivity): void {
    const step = activity.pendingPreSteerAnswerStep
    if (step === undefined) return
    activity.pendingPreSteerAnswerStep = undefined
    activity.committedAnswerSteps.add(step)
    if (activity.messageCandidate?.step === step) activity.messageCandidate = undefined
    if (activity.messageConfirmedStep === step) {
      activity.messageConfirmed = undefined
      activity.messageConfirmedStep = undefined
    }
    this.syncMessage(activity)
    activity.revision += 1
  }

  /** Materialize the Message slot from the candidate (running) or the
   * resolved candidate/confirmed pair (settled): the bounded MULTILINE
   * tail — never a single-line flatten. Both sources are already bounded
   * to MESSAGE_TAIL_CAP, so the slot stays bounded without a second
   * copy; terminal-width wrapping is the renderer's job (plan: the fold
   * never wraps, the renderer re-wraps per frame). */
  private syncMessage(activity: MutableTurnActivity): void {
    const candidate = activity.messageCandidate
    const candidateText = candidate?.tail
    const text = candidateText ?? activity.messageConfirmed
    activity.message = text === undefined || text === '' ? undefined : { text }
  }

  /** Resolve the Message slot at turn/end (plan §5.5): for a completed /
   * max-tokens turn whose candidate IS the exact final assistant, the
   * candidate is the final answer — it stays OUTSIDE the Thought and the
   * slot falls back to the confirmed intermediate message (or disappears).
   * For every other end reason the unfinished candidate is still process
   * information and survives. */
  private resolveMessageAtTurnEnd(activity: MutableTurnActivity): void {
    const reason = activity.reason?.kind
    const candidate = activity.messageCandidate
    if ((reason === 'completed' || reason === 'max-tokens')
      && candidate !== undefined && candidate.step === activity.lastAssistantStep) {
      activity.messageCandidate = undefined
    }
    this.syncMessage(activity)
  }

  /** Sync the activity's per-turn token facts from the shared usage
   * accumulator; the revision moves only when the VISIBLE total changed
   * (plan §33 — usage facts are far rarer than text deltas). */
  private syncUsage(activity: MutableTurnActivity): void {
    const usage = this.usage.turnUsageWithPending(activity.turn)
    const before = activity.usage === undefined ? undefined : totalTokens(activity.usage)
    const after = usage === undefined ? undefined : totalTokens(usage)
    activity.usage = usage
    activity.totalTokens = after
    if (before !== after) activity.revision += 1
  }

  /** Append one distinct raw turn to the retained index. */
  private appendTurnIndex(turn: number): void {
    this.turnStarts.push(this.items.length - 1)
    this.turnValues.push(turn)
    this.turnValueSet.add(turn)
  }

  /** The FIRST REAL model turn (turn/start) adopts the leading standalone
   * prefix (pre-turn commands): their anchors — 0 until now — re-anchor to
   * the first turn value, so an anchored search window that contains the
   * first turn reveals them (the raw prefix itself renders from index 0).
   * Only turn/start adopts the prefix: a GHOST legacy turn (a pre-turn
   * manual compaction registering the initial currentTurn) is not a real
   * turn and must not consume it. */
  private adoptLeadingAnchors(turn: number): void {
    if (this.seenAcceptedTurnStart) return
    this.seenAcceptedTurnStart = true
    if (this.pendingAnchorEntries.length === 0) return
    for (const index of this.pendingAnchorEntries) {
      const item = this.items[index]
      if (item !== undefined && item.kind === 'command') this.setPlacementAnchor(item, index, turn)
    }
    this.pendingAnchorEntries.length = 0
  }

  /** The PRESENTATION placement anchor of one turn-less standalone row: the
   * turn currently open, else the latest known turn, else 0 while the log
   * still has no turn (re-anchored by {@link appendTurnIndex}). This anchor
   * drives window/search navigation ONLY — it is never stored on the row as
   * a semantic `turn` (post-PR166 plan §8.1). */
  private placementAnchorTurn(): number {
    if (this.openTurn !== undefined) return this.openTurn
    return this.turnValues.length > 0 ? this.turnValues[this.turnValues.length - 1]! : 0
  }

  /** Write one command's placement anchor and hand it over to an already
   * fused manual-compaction owner: the owner is the VISIBLE representative,
   * so its sidecar and search entry must follow the same anchor. */
  private setPlacementAnchor(message: TranscriptCommandMessage, index: number, turn: number): void {
    this.commandPlacementTurns.set(message, turn)
    const entry = this.searchEntries[index]
    if (entry !== undefined) entry.turn = turn
    const owner = this.compactionOwnerByCommandId.get(message.commandId)
    if (owner === undefined) return
    const compaction = this.items[owner]
    if (compaction !== undefined && compaction.kind === 'compaction') {
      this.manualCompactionPlacementTurns.set(compaction, turn)
      const ownerEntry = this.searchEntries[owner]
      if (ownerEntry !== undefined) ownerEntry.turn = turn
    }
  }

  /** The placement anchor of one turn-less standalone row from the shared
   * authority sidecar (undefined for turn-owned rows): a plain command, or
   * the COMBINED manual-compaction owner inheriting its fused command's
   * anchor. */
  private placementAnchorOf(message: TranscriptMessage): number | undefined {
    if (message.kind === 'command') return this.commandPlacementTurns.get(message)
    if (message.kind === 'compaction' && message.sourceCommand !== undefined) {
      return this.manualCompactionPlacementTurns.get(message)
    }
    return undefined
  }

  /** Append one folded message, maintaining the window projections. Returns
   * the raw item index (the stable search identity). */
  private appendItem(message: TranscriptMessage): number {
    this.items.push(message)
    const index = this.items.length - 1
    // The searchable projection mirrors the item's own text (eager at
    // append — the cold path); later mutations mark the entry dirty and
    // re-normalize lazily at the next search.
    const corpus = transcriptSearchCorpus(message)
    const ownsTurn = 'turn' in message
    const anchorTurn = ownsTurn ? message.turn : this.placementAnchorTurn()
    if (!ownsTurn && message.kind === 'command') this.commandPlacementTurns.set(message, anchorTurn)
    this.searchEntries.push({
      turn: anchorTurn,
      normalizedText: corpus.normalizedText,
      spans: corpus.spans,
    })
    if (!ownsTurn && !this.seenAcceptedTurnStart) this.pendingAnchorEntries.push(index)
    this.searchRevisionCounter += 1
    const turn = ownsTurn ? message.turn : undefined
    if (turn !== undefined) {
      if (this.turnValues.length === 0) {
        this.appendTurnIndex(turn)
      } else if (this.turnsMonotonic) {
        const lastTurn = this.turnValues[this.turnValues.length - 1]!
        if (turn > lastTurn) {
          this.appendTurnIndex(turn)
        } else if (turn < lastTurn) {
          this.turnsMonotonic = false
          if (!this.turnValueSet.has(turn)) this.appendTurnIndex(turn)
        }
      } else if (!this.turnValueSet.has(turn)) {
        // Keep the log-order index complete after the fast path is disabled;
        // the non-monotonic projection and controller use linear lookup.
        this.appendTurnIndex(turn)
      }
    }
    if (turn !== undefined && message.kind !== 'assistant') this.addGroupedTurn(turn)
    if (message.kind === 'tool') this.groupedToolCount += 1
    return index
  }

  /** Mark ONE search entry dirty (O(1) — the live hot path): the
   * authoritative text changed; the entry is re-normalized lazily at the
   * next search. The dirty SET is the discovery structure — a query
   * normalizes exactly the dirty entries, never a full-history scan. */
  private markSearchEntryDirty(index: number): void {
    const entry = this.searchEntries[index]
    if (entry === undefined) return
    this.dirtySearchEntries.add(index)
    this.searchRevisionCounter += 1
  }

  /** Mark a raw-item range dirty (the DEFENSIVE reflow path — O(run), rare;
   * the live tail-append path marks only the group representative). */
  private markSearchRangeDirty(start: number, end: number): void {
    for (let index = start; index <= end; index += 1) this.markSearchEntryDirty(index)
  }

  /** Mark the streaming entry of one step key dirty (O(1) per chunk). */
  private markStreamingEntryDirty(key: string): void {
    const index = this.searchIndexByStepKey.get(key)
    if (index !== undefined) this.markSearchEntryDirty(index)
  }

  /** Query-time lazy normalization: every DIRTY entry is re-normalized as a
   * WHOLE string from its CURRENT authoritative card (Unicode whole-string
   * semantics — never per-chunk lowercase, never history). The dirty SET
   * bounds the work to O(#dirty) — a query with no mutations normalizes
   * nothing and never scans the history. Non-representative group members
   * are skipped: the merged group's text lives ONLY on the representative
   * entry, so a group expansion marks exactly one entry. */
  private normalizeDirtySearchEntries(): void {
    for (const index of this.dirtySearchEntries) {
      this.searchDirtyScanCount += 1
      const entry = this.searchEntries[index]
      if (entry === undefined) continue
      const group = this.groupOf.get(index)
      if (group !== undefined && this.representativeOf(index) !== index) continue
      const card = group ?? this.items[index]
      if (card === undefined) continue
      // A TURN-OWNED card refreshes its navigation turn from the card (a
      // merged read group may move it). A turn-less row (a real command)
      // KEEPS its presentation anchor: the appendItem/appendTurnIndex sidecar
      // is the authority (post-PR166 plan §8.1/§9), and resetting it to 0
      // would point an inter-turn search match at the wrong bounded window.
      // A fused manual compaction keeps its HANDED-OVER anchor for the same
      // reason — its legacy `turn` is not the placement authority.
      if ('turn' in card && !(card.kind === 'compaction' && card.sourceCommand !== undefined)) {
        entry.turn = card.turn
      }
      const corpus = transcriptSearchCorpus(card)
      entry.normalizedText = corpus.normalizedText
      entry.spans = corpus.spans
      this.searchRefreshCount += 1
    }
    this.dirtySearchEntries.clear()
  }

  /** The CURRENT output representative of one raw item id: the first member
   * of its merged read group when grouped, else the item itself. Search
   * deduplicates by representative: a merged read card emits ONE result per
   * OCCURRENCE in the representative corpus, never a separate result per
   * hidden member. */
  private representativeOf(id: number): number {
    const group = this.groupOf.get(id)
    if (group === undefined) return id
    const members = this.groupMembers.get(group)
    const first = members === undefined ? undefined : members[0]
    return first === undefined ? id : first
  }

  /** Whether an item is groupable as a consecutive read (settled ok, never
   * post-turn replay evidence). Nested PTC sub-calls never reach the
   * top-level items (they live in their parent card's `subCalls` tree), so no
   * exclusion is needed here. Delegates to the module-level
   * {@link isGroupableRead} so the folder and the exported mirror share ONE
   * eligibility contract. */
  private static groupable(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'tool' }> {
    return isGroupableRead(message)
  }

  /** Whether the item at this position CONTINUES a read-group run: groupable
   * AND the same turn as the run's anchor (post-F6 plan §10.2/§12.11 — a
   * group never crosses turns, so every Activity span's own facts — count,
   * timing, slot — stay attributable to the turn that renders the card). */
  private static continuesReadRun(message: TranscriptMessage, turn: number): message is Extract<TranscriptMessage, { kind: 'tool' }> {
    return TranscriptFolder.groupable(message) && message.turn === turn
  }

  /** Build one merged read card without repeatedly concatenating its result.
   * Runs are TURN-BOUND by the walks above (`continuesReadRun`), so all
   * members share one turn; the cross-turn drop paths downstream stay as
   * defensive guards for that invariant. */
  private makeReadGroup(memberIndexes: readonly number[]): {
    group: ReadGroupCard
    members: number[]
    firstTurn: number
    spansTurns: boolean
  } | undefined {
    const firstIndex = memberIndexes[0]
    const first = firstIndex === undefined ? undefined : this.items[firstIndex]
    if (first === undefined || !TranscriptFolder.groupable(first)) return undefined
    const members: number[] = []
    const results: string[] = []
    const turns = new Set<number>()
    let firstResult: string | undefined
    let maxTurn = first.turn
    let callCount = 0
    // The members arrive in FINAL DISPLAY order (plan §7.2): the caller owns the
    // adjacency decision, this builder owns only the aggregate facts.
    for (const index of memberIndexes) {
      const member = this.items[index]
      if (member === undefined || !TranscriptFolder.groupable(member)) continue
      members.push(index)
      turns.add(member.turn)
      maxTurn = Math.max(maxTurn, member.turn)
      if (member.kind === 'tool') callCount += member.callCount ?? 1
      // Match the existing projection's empty-result behavior: leading empty
      // results are omitted, but an empty result after the first non-empty one
      // remains a real (separator-delimited) member.
      if (firstResult === undefined) {
        if (member.result !== '') firstResult = member.result
      } else {
        results.push(member.result)
      }
    }
    const group: Extract<TranscriptMessage, { kind: 'tool' }> = {
      ...first,
      args: `${members.length} files`,
      result: firstResult === undefined ? '' : [firstResult, ...results].join('\n\n'),
      turn: maxTurn,
      // The group's genuine-call cardinality is the SUM of its members:
      // two grouped reads are still two model tool calls, never
      // `"2 files" → 1` (post-F6 plan §10.2).
      ...(callCount > 0 ? { callCount } : {}),
    }
    this.mergedReadGroupTiming(group, members, turns.size > 1)
    return { group, members, firstTurn: first.turn, spansTurns: turns.size > 1 }
  }

  /** Attach the merged read group's OWN timing, aggregated from its member
   * cards WITH turn attribution (post-F6 plan §12.11). Runs are TURN-BOUND
   * (`continuesReadRun`), so `spansTurns` is an invariant guard here — a
   * defensive SET-OR-CLEAR: if a group ever carried members of more than
   * one turn, its timing would be DROPPED (never a cross-turn leak), and a
   * recomputation with no evidence clears a stale span too. A same-turn
   * group aggregates its members' evidence (earliest start, latest end);
   * members without sidecar evidence contribute nothing. */
  private mergedReadGroupTiming(
    group: Extract<TranscriptMessage, { kind: 'tool' }>,
    memberIndexes: readonly number[],
    spansTurns: boolean,
  ): void {
    if (spansTurns) {
      transcriptTimings.delete(group)
      return
    }
    let startedAt: number | undefined
    let endedAt: number | undefined
    let running = false
    for (const index of memberIndexes) {
      const member = this.items[index]
      if (member === undefined) continue
      const timing = transcriptTimingOf(member)
      if (timing === undefined) continue
      startedAt = startedAt === undefined ? timing.startedAt : Math.min(startedAt, timing.startedAt)
      if (timing.endedAt !== undefined) endedAt = endedAt === undefined ? timing.endedAt : Math.max(endedAt, timing.endedAt)
      running = running || timing.running
    }
    if (startedAt === undefined) {
      transcriptTimings.delete(group)
      return
    }
    setTranscriptTiming(group, {
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      running,
    })
  }

  /** Add one grouped-output turn to the monotonic display index. */
  private addGroupedTurn(turn: number): void {
    if (this.groupedTurnIndexDirty) return
    const count = this.groupedTurnCounts.get(turn) ?? 0
    if (count === 0) {
      const last = this.groupedTurnValues[this.groupedTurnValues.length - 1]
      if (last === undefined || turn >= last) {
        this.groupedTurnValues.push(turn)
      } else {
        let low = 0
        let high = this.groupedTurnValues.length
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          if (this.groupedTurnValues[middle]! < turn) low = middle + 1
          else high = middle
        }
        this.groupedTurnValues.splice(low, 0, turn)
      }
    }
    this.groupedTurnCounts.set(turn, count + 1)
  }

  /** Remove one grouped-output turn, tolerating equal-turn contributions. */
  private removeGroupedTurn(turn: number): void {
    if (this.groupedTurnIndexDirty) return
    const count = this.groupedTurnCounts.get(turn)
    if (count === undefined) return
    if (count > 1) {
      this.groupedTurnCounts.set(turn, count - 1)
      return
    }
    this.groupedTurnCounts.delete(turn)
    const index = this.groupedTurnValues.indexOf(turn)
    if (index >= 0) this.groupedTurnValues.splice(index, 1)
  }

  /** Rebuild grouped-output turns after cold grouping or a defensive reflow. */
  private rebuildGroupedTurnIndex(): void {
   this.groupedTurnIndexDirty = false
     this.groupedTurnCounts.clear()
    this.groupedTurnValues = []
    for (let index = 0; index < this.items.length; index += 1) {
      const group = this.groupOf.get(index)
      if (group !== undefined) {
        const members = this.groupMembers.get(group)
        if (members !== undefined && members[0] === index) this.addGroupedTurn(group.turn)
        continue
      }
      const item = this.items[index]
      // Tombstoned failed-attempt text is never visible output.
      if (item !== undefined && 'turn' in item && this.isVisible(item)) this.addGroupedTurn(item.turn)
    }
   this.groupedTurnIndexDirty = false
  }

  /** Whether one raw item is still visible output. Every Assistant entry uses
   * the same DSH block predicate; an interruption flag overrides it, while
   * hidden entries remain internal for authoritative settlement/final choice.
   * Thinking and Tool rows own their corresponding non-visible Assistant
   * blocks. */
  private isVisible(item: TranscriptMessage): boolean {
    if (item.kind === 'assistant') {
      if (this.hiddenAssistantEntries.has(item)) return false
      if (item.interrupted === true) return true
      return assistantEntryVisibleNow(item)
    }
    if (item.kind === 'thinking') return !this.hiddenThinkingEntries.has(item)
    // A command fused into its compaction card is hidden: the card is the
    // one visible owner of the correlated manual compaction (post-PR166
    // plan §7.3) — the row itself stays in `items` for search identity.
    if (item.kind === 'command' && this.fusedCommands.has(item)) return false
    return true
  }

  /**
   * Apply one Assistant visibility transition to every derived projection.
   * Authoritative hidden entries stay in `items`, but their grouped-turn and
   * search memberships follow the same edge in one place.
   */
  private syncAssistantVisibility(
    turn: number,
    step: number,
    item: Extract<TranscriptMessage, { kind: 'assistant' }>,
    wasVisible: boolean,
    markSearchDirty = true,
  ): void {
    const visible = this.isVisible(item)
    if (visible === wasVisible) return
    if (markSearchDirty) this.markStreamingEntryDirty(`assistant:${stepKey(turn, step)}`)
    // Visibility IS display adjacency: a Conversation that becomes visible
    // between two reads must split them, and one that disappears must let them
    // merge. Re-group the neighborhood from the FINAL visibility state (this is
    // deliberately before the dirty-index early return below).
    const index = this.searchIndexByStepKey.get(`assistant:${stepKey(turn, step)}`)
    if (index !== undefined) {
      // A hidden anchor may not order anything: revoke the Tool relations it
      // owned, then re-derive the neighborhood from the FINAL visibility state.
      if (!visible) this.dropLaneAnchor(index)
      this.scheduleDisplayRegroup(index)
    }
    if (this.groupedTurnIndexDirty) return
    if (visible) this.addGroupedTurn(turn)
    else this.removeGroupedTurn(turn)
  }

  /** Ensure exact grouped-turn counts before a cross-turn projection. */
  private ensureGroupedTurnIndex(): void {
    if (this.groupedTurnIndexDirty) this.rebuildGroupedTurnIndex()
  }

  /** Select a bounded range by grouped output turns, then map it to raw items. */
  private groupedWindowRange(maxTurns: number, endTurn?: number): { start: number; end: number; anchored: boolean } | undefined {
    this.ensureGroupedTurnIndex()
    const values = this.groupedTurnValues
    if (values.length === 0) return undefined
    let end = values.length - 1
    let anchored = false
    if (endTurn !== undefined) {
      let low = 0
      let high = values.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (values[middle]! <= endTurn) low = middle + 1
        else high = middle
      }
      const candidate = low - 1
      // Keep the legacy anchored-window behavior: an unknown output anchor
      // falls back to the latest grouped window.
      if (candidate >= 0 && values[candidate] === endTurn) {
        end = candidate
        anchored = true
      }
    }
    const firstValue = values[Math.max(0, end - maxTurns + 1)]!
    const lastValue = values[end]!
    let low = 0
    let high = this.turnValues.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.turnValues[middle]! < firstValue) low = middle + 1
      else high = middle
    }
    const start = low
    low = 0
    high = this.turnValues.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.turnValues[middle]! <= lastValue) low = middle + 1
      else high = middle
    }
    return { start, end: Math.max(start, low - 1), anchored }
  }

  /** Binary-search output turns outside a raw bounded range. */
  private groupedTurnFacts(firstTurn: number, lastTurn: number): { older: number; newer: number } {
    this.ensureGroupedTurnIndex()
    let low = 0
    let high = this.groupedTurnValues.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.groupedTurnValues[middle]! < firstTurn) low = middle + 1
      else high = middle
    }
    const older = low
    low = 0
    high = this.groupedTurnValues.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.groupedTurnValues[middle]! <= lastTurn) low = middle + 1
      else high = middle
    }
    return { older, newer: this.groupedTurnValues.length - low }
  }

  /** Rebuild all read groups once after a cold event-log fold. */
  private rebuildGrouping(): void {
    this.groupOf.clear()
    this.groupMembers.clear()
    this.groupMeta.clear()
    this.groupedTurnIndexDirty = false
     this.groupedTurnCounts.clear()
     this.groupedTurnValues = []
     this.groupedToolCount = 0
    this.crossTurnGroups = 0
    this.groupingRebuildCount += 1
    // The ONE adjacency definition: the FINAL display order, visible rows only
    // (plan §7.1/§7.3). A displaced Tool or lane row therefore separates — or
    // joins — a read run exactly as the user sees it, and a hidden row never
    // fabricates a boundary.
    this.buildDisplayGroups(0, this.items.length - 1, true)
    // The cold finalize rebuilds every group: eagerly normalize each merged
    // card's REPRESENTATIVE entry to the shared group text (one normalize per
    // group — the allowed one-time O(history) cost). Non-representative members
    // keep their own raw entries and are skipped at scan time.
    for (const [group, members] of this.groupMembers) {
      const first = members[0]
      if (first === undefined) continue
      const entry = this.searchEntries[first]
      if (entry === undefined) continue
      entry.turn = group.turn
      const corpus = transcriptSearchCorpus(group)
      entry.normalizedText = corpus.normalizedText
      entry.spans = corpus.spans
      this.dirtySearchEntries.delete(first)
      this.searchRefreshCount += 1
    }
  }

  /** The VISIBLE raw ids of one raw range, in FINAL display order (plan §7.1:
   *  a hidden row is neither an output row nor a boundary). */
  private *visibleDisplayIds(start: number, end: number): Iterable<number> {
    for (const index of this.displayOrderedRawIds(start, end)) {
      const item = this.items[index]
      if (item === undefined || !this.isVisible(item)) continue
      yield index
    }
  }

  /** Build the read groups of one raw range from the FINAL display order: a run
   *  is a maximal sequence of groupable reads of the SAME turn with no VISIBLE
   *  non-read row between them. The caller owns detaching the range's previous
   *  groups and the search-dirty marking. */
  private buildDisplayGroups(start: number, end: number, absoluteCounts: boolean): void {
    let run: number[] = []
    let runTurn: number | undefined
    // `groupedToolCount` counts OUTPUT TOOL CARDS. The cold rebuild starts from
    // zero and therefore counts every card absolutely; a live re-group already
    // holds the per-row counts (appended with each tool item and split back by
    // `detachGroupsInRange`), so it applies only the MERGE delta.
    const flush = (): void => {
      if (run.length === 0) return
      const members = run
      run = []
      if (members.length === 1) {
        this.addGroupedTurn(runTurn!)
        if (absoluteCounts) this.groupedToolCount += 1
        return
      }
      const built = this.makeReadGroup(members)
      if (built === undefined) {
        // Defensive: every member was checked groupable above.
        if (absoluteCounts) this.groupedToolCount += 1
        return
      }
      for (const member of built.members) this.groupOf.set(member, built.group)
      this.groupMembers.set(built.group, built.members)
      this.groupMeta.set(built.group, { firstTurn: built.firstTurn, spansTurns: built.spansTurns })
      this.addGroupedTurn(built.group.turn)
      this.groupedToolCount += absoluteCounts ? 1 : -(built.members.length - 1)
      if (built.spansTurns) this.crossTurnGroups += 1
    }
    for (const index of this.visibleDisplayIds(start, end)) {
      const item = this.items[index]!
      if (TranscriptFolder.groupable(item)) {
        // Same turn → extend the run; a DIFFERENT turn closes the previous run
        // and STARTS a new one with this read (a turn/start emits no row, so
        // consecutive-turn reads are ordinary production input).
        if (runTurn !== undefined && item.turn !== runTurn) flush()
        run.push(index)
        runTurn = item.turn
        continue
      }
      flush()
      runTurn = undefined
      // A not-yet-settled read and a non-read Tool are each their own output
      // card. The `groupable` guard narrows the negative branch, so read the
      // kind structurally instead of through the narrowed union.
      if ((item as { kind: string }).kind === 'tool' && absoluteCounts) this.groupedToolCount += 1
      if ('turn' in item) this.addGroupedTurn(item.turn)
    }
    flush()
  }

  /** Detach every existing group whose members lie inside one raw range: the
   *  shared bookkeeping of a bounded re-group (counters, meta, member runs).
   *  A group partially inside keeps its surviving members' evidence only. */
  private detachGroupsInRange(start: number, end: number): void {
    for (let index = start; index <= end; index += 1) {
      const group = this.groupOf.get(index)
      if (group === undefined) continue
      const members = this.groupMembers.get(group)
      if (members !== undefined) {
        const remaining = members.filter(member => member < start || member > end)
        if (remaining.length === 0) {
          // The whole group lives inside the range: its merged card splits back
          // into `members.length` independent output rows, which the rebuild may
          // merge again — `groupedToolCount` counts OUTPUT CARDS, so the split is
          // exactly `members.length - 1` extra cards. The superseded card's
          // merged timing is dropped with it: a split must never keep an
          // aggregate spanning members that no longer share a card.
          transcriptTimings.delete(group)
          this.groupMembers.delete(group)
          const spansTurns = this.groupMeta.get(group)?.spansTurns ?? this.crossTurn(members)
          this.groupMeta.delete(group)
          this.groupedToolCount += members.length - 1
          if (spansTurns) this.crossTurnGroups -= 1
        } else {
          this.groupMembers.set(group, remaining)
          const first = this.items[remaining[0]!]
          if (first !== undefined && TranscriptFolder.groupable(first)) {
            const spansTurns = this.crossTurn(remaining)
            this.groupMeta.set(group, { firstTurn: first.turn, spansTurns })
            this.mergedReadGroupTiming(group, remaining, spansTurns)
          }
        }
      }
      this.groupOf.delete(index)
    }
  }

  /** The local raw span whose display adjacency and grouping can change around
   *  one row: the row itself, its anchor (and that anchor's other displaced rows)
   *  when it is displaced, the rows displayed immediately around it, and every
   *  group that contains one of them. Deliberately NOT derived from a turn's
   *  positional range: late/non-monotonic replay can append a turn's rows outside
   *  its `turnStarts` span, so the affected rows — not the turn — define the work. */
  private affectedSpanAround(seeds: number | readonly number[]): { start: number; end: number } {
    const list = typeof seeds === 'number' ? [seeds] : seeds
    const rows = new Set<number>(list)
    let low = Math.min(...list)
    let high = Math.max(...list)
    // Each involved GROUP is expanded once per operation: re-enumerating a big
    // read group's members for every covered row made a late-result regroup
    // quadratic in the run size.
    const expandedGroups = new Set<unknown>()
    let memberVisits = 0
    const extendTo = (candidate: number | undefined): boolean => {
      if (candidate === undefined) return false
      let changed = !rows.has(candidate)
      rows.add(candidate)
      if (candidate < low) {
        low = candidate
        changed = true
      }
      if (candidate > high) {
        high = candidate
        changed = true
      }
      return changed
    }
    const expandGroup = (row: number): boolean => {
      const group = this.groupOf.get(row)
      if (group === undefined || expandedGroups.has(group)) return false
      expandedGroups.add(group)
      const members = this.groupMembers.get(group)
      if (members === undefined) return false
      let changed = false
      for (const member of members) {
        memberVisits += 1
        changed = extendTo(member) || changed
      }
      return changed
    }
    // One hop of display adjacency for every SEED (the run boundary each moves
    // across); chaining adjacency transitively would swallow the whole turn.
    for (const seed of list) {
      extendTo(this.displayPredecessorOf(seed))
      extendTo(this.displaySuccessorOf(seed))
    }
    let grew = true
    while (grew) {
      grew = false
      // Every involved row pulls in its relations and its whole group.
      for (const row of [...rows]) {
        const anchor = this.laneDisplayByDisplaced.get(row)?.anchor
        if (anchor !== undefined) grew = extendTo(anchor) || grew
        for (const owner of anchor === undefined ? [row] : [row, anchor]) {
          const owned = this.laneDisplayByAnchor.get(owner)
          if (owned === undefined) continue
          for (const peer of owned.before) grew = extendTo(peer) || grew
          for (const peer of owned.after) grew = extendTo(peer) || grew
        }
        grew = expandGroup(row) || grew
      }
      // EVERY row INSIDE the (possibly unioned) envelope closes it too: an anchor
      // emits its lists there even when they sit outside the raw range, and a
      // grouped row brings its group.
      for (let row = low; row <= high; row += 1) {
        const owned = this.laneDisplayByAnchor.get(row)
        if (owned !== undefined) {
          for (const peer of owned.before) grew = extendTo(peer) || grew
          for (const peer of owned.after) grew = extendTo(peer) || grew
        }
        grew = expandGroup(row) || grew
      }
      // Every groupable read the envelope covers pulls in its DISPLAY run — the
      // next row the user actually SEES decides it, so an invisible row is not a
      // boundary and a departing non-read row does not stop the expansion.
      for (let row = low; row <= high; row += 1) {
        const item = this.items[row]
        if (item === undefined || !TranscriptFolder.groupable(item)) continue
        grew = this.extendDisplayRun(row, -1, extendTo) || grew
        grew = this.extendDisplayRun(row, 1, extendTo) || grew
      }
    }
    this.lastRegroupMemberVisits = memberVisits
    return { start: low, end: high }
  }

  /** Extend the envelope over the DISPLAY run of groupable reads leaving `from`
   *  in one direction: the next row the user actually SEES decides the run, so an
   *  invisible row never stops it. `extend` reports whether it added a row. */
  private extendDisplayRun(
    from: number,
    direction: -1 | 1,
    extend: (candidate: number | undefined) => boolean,
  ): boolean {
    const start = this.items[from]
    if (start === undefined || !TranscriptFolder.groupable(start) || !('turn' in start)) return false
    const turn = start.turn
    let grew = false
    let cursor = from
    for (;;) {
      const next = direction < 0 ? this.displayPredecessorOf(cursor) : this.displaySuccessorOf(cursor)
      if (next === undefined) return grew
      const item = this.items[next]
      if (item === undefined || !TranscriptFolder.groupable(item) || !('turn' in item) || item.turn !== turn) return grew
      // Also includes any relations/groups the newly added row brings in.
      if (!extend(next)) return grew
      grew = true
      cursor = next
    }
  }

  /** The turn value of one raw row, when it carries one. */
  private turnOfRaw(index: number): number | undefined {
    const item = this.items[index]
    return item !== undefined && 'turn' in item ? item.turn : undefined
  }

  /** Re-group one LOCAL span from the display order: detach its existing groups,
   *  then rebuild the runs over the final display order (bounded by the span). */
  private regroupDisplaySpan(span: { start: number; end: number }): void {
    this.regroupOperationCount += 1
    this.lastRegroupSpanRows = span.end - span.start + 1
    this.groupedTurnIndexDirty = true
    this.detachGroupsInRange(span.start, span.end)
    this.markSpanSearchDirty(span)
    this.buildDisplayGroups(span.start, span.end, false)
    // The rebuilt runs' representatives may have moved: the lazy normalization
    // re-derives every entry from its current card. Only the span's GROUPABLE
    // rows can change role (a merged card replaces its members, and a member
    // that becomes standalone needs its own corpus) — a Conversation/user row
    // that merely sits in the span keeps its own entry untouched.
    this.markSpanSearchDirty(span)
  }

  /** Re-derive the search corpus of the span's groupable rows only. */
  private markSpanSearchDirty(span: { start: number; end: number }): void {
    for (let row = span.start; row <= span.end; row += 1) {
      const item = this.items[row]
      if (item !== undefined && TranscriptFolder.groupable(item)) this.markSearchEntryDirty(row)
    }
  }

  /** The raw index displayed immediately BEFORE `index` (visible rows only): a
   *  displaced row is emitted at its anchor, and an anchor is followed by its
   *  `after` list. */
  /** The rows ONE raw slot emits, in order: an anchor emits its `before` list,
   *  itself, then its `after` list; a displaced row emits nothing at its own
   *  slot (it is emitted at its anchor). This is the same emission rule
   *  `displayOrderedRawIds` applies, so these helpers stay equivalent to it. */
  private emittedAt(index: number): number[] {
    if (this.laneDisplayByDisplaced.has(index)) return []
    const owned = this.laneDisplayByAnchor.get(index)
    if (owned === undefined) return [index]
    return [...owned.before, index, ...owned.after]
  }

  /** The last VISIBLE row of one emission sequence, when it has any. */
  private lastVisibleOf(rows: readonly number[]): number | undefined {
    for (let at = rows.length - 1; at >= 0; at -= 1) {
      const row = rows[at]!
      if (this.isVisible(this.items[row]!)) return row
    }
    return undefined
  }

  /** The first VISIBLE row of one emission sequence, when it has any. */
  private firstVisibleOf(rows: readonly number[]): number | undefined {
    for (const row of rows) {
      if (this.isVisible(this.items[row]!)) return row
    }
    return undefined
  }

  /** The raw index displayed immediately BEFORE `index` in the FINAL display
   *  order. A DISPLACED row is emitted inside its anchor's slot, so its
   *  predecessor is the previous visible row of that emission (its sibling in the
   *  before/after list) or, at the start of the emission, the slot before the
   *  anchor. */
  private displayPredecessorOf(index: number): number | undefined {
    const displaced = this.laneDisplayByDisplaced.get(index)
    if (displaced !== undefined) {
      const emission = this.emittedAt(displaced.anchor)
      const at = emission.indexOf(index)
      if (at > 0) {
        const sibling = this.lastVisibleOf(emission.slice(0, at))
        if (sibling !== undefined) return sibling
      }
      return this.slotPredecessorOf(displaced.anchor)
    }
    const own = this.laneDisplayByAnchor.get(index)
    if (own !== undefined && own.before.length > 0) {
      const visible = this.lastVisibleOf(own.before)
      if (visible !== undefined) return visible
    }
    return this.slotPredecessorOf(index)
  }

  /** The raw index displayed immediately AFTER `index` in the FINAL display
   *  order (see {@link displayPredecessorOf} for the displaced-row rule). */
  private displaySuccessorOf(index: number): number | undefined {
    const displaced = this.laneDisplayByDisplaced.get(index)
    if (displaced !== undefined) {
      const emission = this.emittedAt(displaced.anchor)
      const at = emission.indexOf(index)
      if (at >= 0 && at + 1 < emission.length) {
        const sibling = this.firstVisibleOf(emission.slice(at + 1))
        if (sibling !== undefined) return sibling
      }
      return this.slotSuccessorOf(displaced.anchor)
    }
    const own = this.laneDisplayByAnchor.get(index)
    if (own !== undefined && own.after.length > 0) {
      const visible = this.firstVisibleOf(own.after)
      if (visible !== undefined) return visible
    }
    return this.slotSuccessorOf(index)
  }

  /** The last VISIBLE row emitted by the raw slots before `index`. */
  private slotPredecessorOf(index: number): number | undefined {
    let candidate = index - 1
    while (candidate >= 0) {
      const visible = this.lastVisibleOf(this.emittedAt(candidate))
      if (visible !== undefined) return visible
      candidate -= 1
    }
    return undefined
  }

  /** The first VISIBLE row emitted by the raw slots after `index`. */
  private slotSuccessorOf(index: number): number | undefined {
    let candidate = index + 1
    while (candidate < this.items.length) {
      const visible = this.firstVisibleOf(this.emittedAt(candidate))
      if (visible !== undefined) return visible
      candidate += 1
    }
    return undefined
  }

  /** Re-sort the relation list owning `rawIndex` (a refreshed materialization
   *  key can move the row inside its side even when the relation is unchanged). */
  private resortAnchorSideOf(rawIndex: number): void {
    const current = this.laneDisplayByDisplaced.get(rawIndex)
    if (current === undefined) return
    this.resortAnchorSide(current.anchor, current.position)
  }

  /** Sort one side of an anchor by the rows' own materialization evidence,
   *  bumping the search revision only when the visible order really changed. */
  private resortAnchorSide(anchor: number, position: 'before' | 'after'): void {
    const owned = this.laneDisplayByAnchor.get(anchor)
    if (owned === undefined) return
    const list = position === 'before' ? owned.before : owned.after
    const before = [...list]
    list.sort((left, right) => {
      const a = this.displacedOrderOf(left)
      const b = this.displacedOrderOf(right)
      if (a.evidenced !== b.evidenced) return a.evidenced ? -1 : 1
      return a.key - b.key || left - right
    })
    if (!list.some((row, at) => row !== before[at])) return
    this.searchRevisionCounter += 1
    // The visible order of this side changed, and every derived read-group fact
    // follows the DISPLAY order: member order, representative, aggregated result
    // and search corpus must be rebuilt (a bare revision bump would leave the
    // group describing the OLD order).
    this.scheduleDisplayRegroup(anchor)
  }

  /** Route a display-relation or visibility change into the grouping: while
   *  hydrating the final rebuild covers it; live, only the LOCAL affected span is
   *  re-grouped. */
  private scheduleDisplayRegroup(rawIndex: number, alsoSeeds: number | readonly number[] = []): void {
    const item = this.items[rawIndex]
    if (item === undefined || !('turn' in item)) return
    if (this.hydrating) {
      // The final cold rebuild must run even when no read settled.
      this.groupingDirty = true
      return
    }
    const extra = typeof alsoSeeds === 'number' ? [alsoSeeds] : alsoSeeds
    // Inside a coalesced convergence the seeds accumulate and ONE joint closure
    // runs at the end, so a step with many Tool rows does not regroup N times.
    if (this.pendingRegroupSeeds !== undefined) {
      this.pendingRegroupSeeds.push(rawIndex, ...extra)
      return
    }
    // ONE joint closure over every seed and the resulting envelope: the union of
    // separately closed spans is not closed by itself.
    this.regroupDisplaySpan(this.affectedSpanAround([rawIndex, ...extra]))
  }

  /** Run `body` while coalescing every display regroup it triggers into ONE
   *  joint closure over all of the seeds. Nested calls keep the outer batch. */
  private coalescingRegroups<T>(body: () => T): T {
    if (this.pendingRegroupSeeds !== undefined) return body()
    const seeds: number[] = []
    this.pendingRegroupSeeds = seeds
    try {
      return body()
    } finally {
      this.pendingRegroupSeeds = undefined
      if (seeds.length > 0) this.regroupDisplaySpan(this.affectedSpanAround(seeds))
    }
  }

  private appendTailGrouping(index: number, previousIndex: number | undefined): boolean {
    if (index !== this.items.length - 1) return false
    const item = this.items[index]
    if (item === undefined || !TranscriptFolder.groupable(item)) return false
    const previous = previousIndex === undefined ? undefined : this.items[previousIndex]
    // No display predecessor: this read IS the first visible row of its run.
    if (previous === undefined || previousIndex === undefined) return true
    if (!TranscriptFolder.groupable(previous)) return true
    // A group never crosses turns (post-F6 plan §10.2/§12.11): a next-turn
    // read starts its OWN run instead of extending the previous turn's
    // group/singleton, so every span's count and timing stay attributable.
    if (previous.turn !== item.turn) return true

    const previousGroup = this.groupOf.get(previousIndex)
    if (previousGroup !== undefined) {
      const members = this.groupMembers.get(previousGroup)
      if (members === undefined) return false
      const meta = this.groupMeta.get(previousGroup)
      const firstMember = this.items[members[0]!]
      const firstTurn = meta?.firstTurn ?? (firstMember !== undefined && 'turn' in firstMember ? firstMember.turn : previous.turn)
      const wasCross = meta?.spansTurns ?? this.crossTurn(members)
      this.removeGroupedTurn(previousGroup.turn)
       this.removeGroupedTurn(item.turn)
       members.push(index)
       this.groupOf.set(index, previousGroup)
      previousGroup.args = `${members.length} files`
      previousGroup.result = previousGroup.result === '' ? item.result : `${previousGroup.result}\n\n${item.result}`
      previousGroup.turn = Math.max(previousGroup.turn, item.turn)
      // The extended group carries the merged genuine-call cardinality:
      // the grouped members are still that many model tool calls.
      const mergedCallCount = (previousGroup.callCount ?? 1) + (item.callCount ?? 1)
      if (mergedCallCount > 0) previousGroup.callCount = mergedCallCount
      else delete previousGroup.callCount
       this.addGroupedTurn(previousGroup.turn)
      const spansTurns = wasCross || item.turn !== firstTurn
      this.groupMeta.set(previousGroup, { firstTurn, spansTurns })
      this.mergedReadGroupTiming(previousGroup, members, spansTurns)
      if (!wasCross && spansTurns) this.crossTurnGroups += 1
      this.groupedToolCount -= 1
      // The merged card's text changed (args count + result): mark the
      // group REPRESENTATIVE dirty — O(1), never a per-member refresh
      // (the live tail-append hot path must stay near-constant; the
      // representative is the FIRST member and never changes on a tail
      // append, and non-representative members are skipped at scan time).
      // The lazy normalization reads the CURRENT group card, so the
      // earlier members' stale text/turn can never leak (round-4
      // finding).
      this.markSearchEntryDirty(members[0]!)
      return true
    }

    // The previous item is a singleton read: promote it without scanning the
    // run (there cannot be an older group across a non-groupable boundary).
    this.removeGroupedTurn(previous.turn)
     this.removeGroupedTurn(item.turn)
     const group: ReadGroupCard = {
      ...previous,
      args: '2 files',
      result: previous.result === '' ? item.result : `${previous.result}\n\n${item.result}`,
      turn: Math.max(previous.turn, item.turn),
    }
    // The promoted group carries the merged genuine-call cardinality.
    const promotedCallCount = (previous.callCount ?? 1) + (item.callCount ?? 1)
    if (promotedCallCount > 0) group.callCount = promotedCallCount
    this.groupOf.set(previousIndex, group)
    this.groupOf.set(index, group)
    this.groupMembers.set(group, [previousIndex, index])
    this.groupMeta.set(group, { firstTurn: previous.turn, spansTurns: previous.turn !== item.turn })
    this.mergedReadGroupTiming(group, [previousIndex, index], previous.turn !== item.turn)
      this.addGroupedTurn(group.turn)
    if (previous.turn !== item.turn) this.crossTurnGroups += 1
    this.groupedToolCount -= 1
    // The promoted singleton becomes the new group's representative: its
    // entry must carry the merged text (lazy — mark dirty, O(1)).
    this.markSearchEntryDirty(previousIndex)
    return true
  }

  /** Schedule grouping now, or mark the cold fold for one final grouping pass. */
  private scheduleGrouping(index: number): void {
    const item = this.items[index]
    if (item === undefined || !TranscriptFolder.groupable(item)) return
    if (this.hydrating) {
      this.groupingDirty = true
      return
    }
    // The cheap fast path is valid only when the settled read IS the display
    // tail: the last raw row, not itself displaced. Its display predecessor is
    // computed locally (displaced and invisible neighbours are skipped), so a
    // turn carrying displacements still settles in O(local) work instead of
    // re-walking the turn.
    if (index === this.items.length - 1 && !this.laneDisplayByDisplaced.has(index)) {
      if (this.appendTailGrouping(index, this.displayPredecessorOf(index))) return
    }
    this.regroupDisplaySpan(this.affectedSpanAround(index))
  }

  private crossTurn(members: readonly number[]): boolean {
    if (members.length <= 1) return false
    const first = this.items[members[0]!]!
    const turn = 'turn' in first ? first.turn : undefined
    for (let i = 1; i < members.length; i += 1) {
      const member = this.items[members[i]!]!
      if (('turn' in member ? member.turn : undefined) !== turn) return true
    }
    return false
  }

  /**
   * Apply appended events in log order. Safe to call repeatedly with new
   * suffixes of the log.
   * @param events - the appended session events.
   */
  apply(events: readonly SessionEvent[]): void {
    for (const event of events) this.applyEvent(event)
  }

  /** The number of active workflow run index entries (test hook): completed
   * runs drop their index at run-end so long sessions do not accumulate. */
  activeWorkflowIndexCount(): number {
    return this.workflowIndexes.size
  }

  /**
   * Apply one live assistant stream input (Session v2 TRANSIENT plane —
   * `agent/assistant-stream` mapped through the neutral port). Live model
   * output NEVER rides the durable log anymore: text/reasoning/usage
   * deltas accumulate here, and the authoritative settlement arrives
   * through the durable `assistant/message` / `assistant/attempt` events
   * on the `session/event` plane. The `end` frame is a notification only:
   * a committed attempt's durable event already settled the entries, and
   * an abandoned attempt (no durable settlement) closes the open thinking
   * entries so no live candidate stays "running" forever.
   */
  applyLiveInput(input: AssistantLiveInput): void {
    switch (input.kind) {
      case 'start': {
        // A RETRY reopens the same (turn, step) after a failed attempt:
        // the previous attempt's reasoning entry was CLOSED but kept as
        // diagnostic evidence — reset its text (and the Focus preview
        // tail) so the new attempt's reasoning never concatenates onto
        // the failed one's. Reopen parity: the durable log restores the
        // step's reasoning from its LATEST source.
        const key = stepKey(input.turn, input.step)
        const activity = this.activityByTurn.get(input.turn)
        if (activity !== undefined && !activity.settledSteps.has(input.step)) {
          activity.firstVisibleAssistantTimes.delete(input.step)
        }
        this.liveAssistantBlocks.set(key, {
          states: new Map(),
          order: [],
          orderPos: new Map(),
          blockIndexes: [],
          blocks: [],
          displayIndexes: [],
          displayBlocks: [],
          assistantVisibleCount: 0,
          thinkingVisibleCount: 0,
          openOpaqueCount: 0,
        })
        const thinking = this.thinkingEntries.get(key)
        if (thinking !== undefined && thinking.running === false) {
          thinking.text = ''
          thinking.running = true
          // The reopen starts a NEW reasoning span: the previous attempt's
          // sidecar timing AND its last-evidence fallback are stale
          // evidence and must not straddle the retry (the first chunk of
          // the new attempt re-records the start).
          transcriptTimings.delete(thinking)
          thinkingLastEvidence.delete(thinking)
          this.markStreamingEntryDirty(`thinking:${key}`)
          let open = this.openThinkingByTurn.get(input.turn)
          if (open === undefined) {
            open = new Set()
            this.openThinkingByTurn.set(input.turn, open)
          }
          open.add(thinking)
          const activity = this.activityByTurn.get(input.turn)
          if (activity !== undefined) this.clearThinkingPreview(activity, input.step)
        }
        break
      }
      case 'chunk':
        this.applyAssistantChunk(input.turn, input.step, input.chunk, input.time)
        break
      case 'end':
        // An abandoned attempt has no durable settlement and is tombstoned.
        // A committed `assistant/attempt` keeps its durable evidence visible
        // as transient until `llm/retry` or `turn/end`; `assistant/message`
        // owns the normal settled surface entry.
        this.liveAssistantBlocks.delete(stepKey(input.turn, input.step))
        if (input.status === 'abandoned') {
          this.settleFailedAttempt(input.turn, input.step, true, true)
          // The abandoned attempt's preparing starts are dead evidence: a
          // reused call id in a later attempt must not inherit its timer.
          this.clearPreparingStartsForStep(input.turn, input.step)
        }
        // Any remaining open reasoning entries stop animating at settlement.
        // The notification frame carries no time: there is no authoritative
        // end, so the sidecar keeps `endedAt` undefined (plan §12.16).
        {
          const open = this.openThinkingByTurn.get(input.turn)
          if (open !== undefined) {
            for (const entry of open) this.closeThinking(entry)
            this.openThinkingByTurn.delete(input.turn)
          }
          // The turn may continue (tool execution, later model output): the
          // Focus Think slot must return to a settled (head) preview now,
          // not at turn/end (review finding).
          const activity = this.activityByTurn.get(input.turn)
          if (activity !== undefined) this.markThinkSettled(activity, input.step)
        }
        break
    }
  }

  /** Tombstone one transient assistant entry at a retry boundary. The
   * first-token timing and usage live in their separate folds and are not
   * touched here; only the presentation state is reset. */
  private hideTransientAssistantEntry(turn: number, step: number): boolean {
    const key = stepKey(turn, step)
    const entry = this.assistantEntries.get(key)
    if (entry === undefined || !this.transientAssistantEntries.has(entry)) return false
    // A tombstoned anchor Assistant row can no longer honor a display
    // displacement — drop the mapping so the Thinking lane falls back to
    // its physical slot (the raw index stays the stable TranscriptItemId).
    this.dropLaneAnchor(this.searchIndexByStepKey.get(`assistant:${key}`) ?? -1)
    const activity = this.activityByTurn.get(turn)
    const clearLatestVisibility = activity !== undefined
      && activity.lastAssistantStep === step
      && activity.lastAssistantVisible === true
    if (clearLatestVisibility) activity.lastAssistantVisible = false
    const wasVisible = this.isVisible(entry)
    this.assistantEntries.delete(key)
    entry.text = ''
    entry.content = undefined
    entry.displayBlocks = undefined
    entry.interrupted = undefined
    this.transientAssistantEntries.delete(entry)
    this.attemptAssistantEntries.delete(entry)
    this.hiddenAssistantEntries.add(entry)
    this.markStreamingEntryDirty(`assistant:${key}`)
    this.syncAssistantVisibility(turn, step, entry, wasVisible, false)
    return clearLatestVisibility
  }

  /** A failed live attempt has no durable evidence and is therefore
   * tombstoned. A committed `assistant/attempt` is restored separately and
   * remains available as interruption evidence until retry/turn end. */
  private settleFailedAttempt(turn: number, step: number, abandoned = false, discardUsage = true): void {
    const visibilityReset = abandoned ? this.hideTransientAssistantEntry(turn, step) : false
    if (abandoned) {
      // Tombstone abandoned reasoning too: the raw item remains index-stable
      // while every visible/search/grouped projection skips it.
      this.hideThinkingEntry(turn, step)
    }
    if (discardUsage) this.usage.discardStep(turn, step)
    const activity = this.activityByTurn.get(turn)
    if (activity === undefined) return
    if (abandoned) this.clearThinkingPreview(activity, step)
    if (abandoned) {
      let changed = visibilityReset
      const candidate = activity.messageCandidate
      if (candidate !== undefined && candidate.step === step
        && !activity.settledSteps.has(step) && !activity.confirmedSteps.has(step)) {
        activity.messageCandidate = undefined
        this.syncMessage(activity)
        changed = true
      }
      if (changed) activity.revision += 1
    }
    this.syncUsage(activity)
  }

  /** Fold one live assistant chunk (Session v2 transient plane) into the
   * streaming entries and Focus aggregation. Live block state is retained per
   * logical step so a completed block can replace earlier deltas exactly. */
  private applyAssistantChunk(turn: number, step: number, chunk: AssistantLiveChunk, time: number): void {
    // After turn/end a late assistant event is a replay artifact: it
    // must not mutate the finalized surface entry — the final-answer
    // selection reads the exact last assistant (review finding).
    const activity = this.activityFor(turn)
    const key = stepKey(turn, step)
    if (activity.completed) return
    // A late reasoning replay remains diagnostic transcript evidence, but a
    // late text/block surface frame must never overwrite the durable message.
    if (activity.settledSteps.has(step)) {
      // Late reasoning is preserved as SETTLED diagnostic evidence (post-F6
      // plan §4.6): an existing Thinking row refreshes in place, and a step
      // without one keeps the row — created not-running and placed by the
      // step's stored lane authority below. It is never dropped just to
      // avoid a trailing row: for a thinking-first step the CREATED row
      // relocates BEFORE the Assistant row (no invalid trailing Activity),
      // while an assistant-first step keeps it after its Assistant row
      // (valid topology for that step). An EXISTING row's position was
      // already anchored (§4.5 live chronology or an earlier convergence) —
      // an in-place refresh never re-judges it.
      const existing = this.thinkingEntries.get(key)
      if (chunk.type === 'reasoning-delta') {
        // Empty reasoning is NOT Thinking lane evidence (the shared
        // `assistantBlockProjection` contract: `reasoning.text !== ''`): an
        // empty first delta must not CREATE a missing row — the visibility
        // check never hides an empty Thinking row, so it would leak a blank
        // process row into the Work span.
        if (existing === undefined && chunk.text === '') return
        const thinking = this.thinkingEntry(turn, step, time)
        thinking.text += chunk.text
        thinking.running = false
        this.closeThinking(thinking, time)
        this.markStreamingEntryDirty(`thinking:${key}`)
        this.foldThinking(activity, step, chunk.text)
        if (existing === undefined) this.convergeStepLaneOrder(turn, step)
      } else if (chunk.type === 'block-end' && chunk.block.type === 'reasoning' && 'text' in chunk.block && typeof chunk.block.text === 'string') {
        if (chunk.block.text === '') {
          // An authoritative EMPTY finalized reasoning replaces any existing
          // row — the same rule the non-settled restore path applies
          // (reasoning === '' hides Thinking) — and never creates one.
          if (existing !== undefined) {
            this.hideThinkingEntry(turn, step)
            this.clearThinkingPreview(activity, step)
          }
        } else {
          const thinking = this.thinkingEntry(turn, step, time)
          thinking.text = chunk.block.text
          thinking.running = false
          this.closeThinking(thinking, time)
          this.markStreamingEntryDirty(`thinking:${key}`)
          this.restoreThinkingPreview(activity, step, chunk.block.text)
          if (existing === undefined) this.convergeStepLaneOrder(turn, step)
        }
      } else if (chunk.type === 'usage') {
        this.usage.onUsageChunk(turn, step, chunk.usage)
        this.syncUsage(activity)
      }
      return
    }
    const existing = this.assistantEntries.get(key)
    if (existing !== undefined && this.attemptAssistantEntries.has(existing)) return
    const reasoningFrame = chunk.type === 'reasoning-delta'
      || (chunk.type === 'block-start' && chunk.blockType === 'reasoning')
      || (chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    // Usage facts deliberately bypass the presentation-only stale fence so
    // Focus accounting remains aligned with the independent stats fold.
    if (chunk.type !== 'usage'
      && existing === undefined && step < (activity.lastAssistantStep ?? -1) && !reasoningFrame) return
    // An existing older row may still receive an interleaved late chunk; keep
    // that semantic transcript evidence current. The no-entry fence above
    // prevents replay from resurrecting a removed surface, while candidate and
    // latest-step bookkeeping below keep Focus ownership on the newer step.
    const projection = this.liveAssistantProjectionFor(turn, step)
    switch (chunk.type) {
      case 'block-start':
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta':
      case 'block-end': {
        // Preparing continuity (post-F6 plan §12.14): the FIRST streamed
        // delta of a tool call is the call's earliest authoritative start —
        // keyed by the formal call id when it is known, else by the same
        // (turn, step, index) fallback identity the preview projection
        // uses, and migrated when the formal id arrives.
        if (chunk.type === 'tool-call-delta') {
          this.recordPreparingDelta(turn, step, chunk.id, chunk.index, time)
        }
        const previous = projection.states.get(chunk.index)
        if (applyAssistantBlockChunk(projection.states, chunk)) {
          this.updateLiveAssistantProjection(projection, chunk.index, previous)
          if (assistantChunkHasVisibleReply(chunk)) {
            const firstVisible = activity.firstVisibleAssistantTimes.get(step)
            if (firstVisible === undefined || time < firstVisible) {
              activity.firstVisibleAssistantTimes.set(step, time)
            }
          }
          this.syncLiveAssistantPresentation(turn, step, time)
          this.recordAssistantVisibleTime(turn, step)
          // Accepted reasoning evidence is the Thinking row's honest end
          // candidate: remember it so a streamless settlement can close the
          // row at its real reasoning end instead of end-less (post-F6 plan
          // §12.6).
          if (chunk.type === 'reasoning-delta'
            || (chunk.type === 'block-end' && chunk.block.type === 'reasoning')) {
            const thinkingRow = this.thinkingEntries.get(key)
            if (thinkingRow !== undefined) thinkingLastEvidence.set(thinkingRow, time)
          }
        }
        break
      }
      case 'usage':
        // Focus aggregation: per-turn token facts (the shared
        // accumulator — the footer and Focus can never drift).
        this.usage.onUsageChunk(turn, step, chunk.usage)
        this.syncUsage(activity)
        break
      case 'finish':
        break
    }
  }

  /** Return the mutable live projection for one logical step. */
  private liveAssistantProjectionFor(turn: number, step: number): LiveAssistantProjection {
    const key = stepKey(turn, step)
    let projection = this.liveAssistantBlocks.get(key)
    if (projection === undefined) {
      projection = {
        states: new Map(),
        order: [],
        orderPos: new Map(),
        blockIndexes: [],
        blocks: [],
        displayIndexes: [],
        displayBlocks: [],
        assistantVisibleCount: 0,
        thinkingVisibleCount: 0,
        openOpaqueCount: 0,
      }
      this.liveAssistantBlocks.set(key, projection)
    }
    return projection
  }

  /** Update only the indexed projection affected by one accepted chunk. */
  private updateLiveAssistantProjection(
    projection: LiveAssistantProjection,
    index: number,
    previous: AssistantBlockState | undefined,
  ): void {
    const previousProjection = previous === undefined ? undefined : assistantBlockProjection(previous)
    const current = projection.states.get(index)
    const currentProjection = current === undefined ? undefined : assistantBlockProjection(current)
    if (previousProjection?.assistantVisible === true) projection.assistantVisibleCount -= 1
    if (previousProjection?.thinkingVisible === true) projection.thinkingVisibleCount -= 1
    if (previousProjection?.opaque === true) projection.openOpaqueCount -= 1
    if (currentProjection?.assistantVisible === true) projection.assistantVisibleCount += 1
    if (currentProjection?.thinkingVisible === true) projection.thinkingVisibleCount += 1
    if (currentProjection?.opaque === true) projection.openOpaqueCount += 1
    updateIndexedProjection(projection.order, projection.orderPos, projection.blockIndexes, projection.blocks, index, currentProjection?.content)
    updateIndexedProjection(projection.order, projection.orderPos, projection.displayIndexes, projection.displayBlocks, index, currentProjection?.display)
  }

  /** Replace the Focus message candidate with authoritative assembled text. */
  private replaceMessageCandidate(activity: MutableTurnActivity, step: number, text: string): void {
    if (activity.completed || activity.confirmedSteps.has(step) || activity.settledSteps.has(step)) return
    if (step < (activity.lastAssistantStep ?? step)) return
    const candidate = activity.messageCandidate
    if (candidate !== undefined && candidate.step !== step) this.confirmMessageCandidate(activity)
    activity.messageCandidate = text === ''
      ? undefined
      : { step, tail: text.slice(-TranscriptFolder.MESSAGE_TAIL_CAP) }
    if (text !== '') activity.lastAssistantStep = Math.max(activity.lastAssistantStep ?? -1, step)
    this.syncMessage(activity)
    activity.revision += 1
  }

  /** Record (never regress) the EARLIEST proven first-visible Conversation
   * time on the step's assistant row. The sidecar is display-only: it tells a
   * Work Activity where the Conversation boundary actually appeared, so a late
   * durable settlement can never move that boundary later. `firstVisibleAt` is
   * reply-text evidence (reasoning/tool-call chunks are excluded by
   * `assistantChunkHasVisibleReply`), so no Thinking evidence is mistaken for
   * the Conversation lane.
   *
   * A settlement whose embedded stream proves no reply-text time (streamless,
   * or a stream without the Conversation lane) still proves ONE thing: a
   * VISIBLE durable message became visible by its own settlement — the caller
   * passes that `settlementTime` and it is used only when no earlier
   * first-visible evidence exists (plan §5.2: "streamless 只能使用实际可证明的
   * settlement 时间"). */
  private recordAssistantVisibleTime(turn: number, step: number, settlementTime?: number): void {
    const row = this.assistantEntries.get(stepKey(turn, step))
    if (row === undefined) return
    const at = this.activityByTurn.get(turn)?.firstVisibleAssistantTimes.get(step) ?? settlementTime
    if (at === undefined) return
    const known = transcriptTimingOf(row)
    if (known === undefined || at < known.startedAt) setTranscriptTiming(row, pointTiming(at))
  }

  /** Project the current live block map without duplicating block-end text. */
  private syncLiveAssistantPresentation(turn: number, step: number, time?: number): void {
    const key = stepKey(turn, step)
    const projection = this.liveAssistantProjectionFor(turn, step)
    const { blocks, displayBlocks } = projection
    const hasOpenOpaque = projection.openOpaqueCount > 0
    const displayProjection = hasOpenOpaque ? displayBlocks : undefined
    const text = textOf(blocks)
    const activity = this.activityFor(turn)
    const visibleNow = projection.assistantVisibleCount > 0
    const priorLastAssistantStep = activity.lastAssistantStep ?? -1
    const priorLastAssistantVisible = activity.lastAssistantVisible
    if (step >= priorLastAssistantStep) {
      activity.lastAssistantVisible = visibleNow
      // Any accepted indexed block state owns the latest-step fence, even
      // when its current projection is hidden (empty text/reasoning/tool-call).
      // This is structural state only; it never creates a Focus candidate.
      if (projection.states.size > 0) activity.lastAssistantStep = Math.max(priorLastAssistantStep, step)
    }
    if (activity.lastAssistantStep !== priorLastAssistantStep
      || activity.lastAssistantVisible !== priorLastAssistantVisible) {
      activity.revision += 1
    }
    const entry = this.assistantEntries.get(key)
    const wasVisible = entry !== undefined && this.isVisible(entry)
    const staleStep = step < priorLastAssistantStep
    if (!visibleNow) {
      // A late reasoning frame may reopen an empty block map after a committed
      // step was closed. Preserve that step's existing transcript rows; only
      // the diagnostic Thinking text below may be refreshed.
      if (!staleStep) {
        if (entry !== undefined && this.transientAssistantEntries.has(entry)) this.hideTransientAssistantEntry(turn, step)
        this.replaceMessageCandidate(activity, step, '')
      }
    } else {
      const target = entry ?? this.assistantEntry(turn, step)
      this.transientAssistantEntries.add(target)
      this.attemptAssistantEntries.delete(target)
      this.hiddenAssistantEntries.delete(target)
      target.text = text
      target.content = blocks.some(block => block.type !== 'text') ? blocks : undefined
      target.displayBlocks = displayProjection
      target.interrupted = undefined
      bumpAssistantPresentationRevision(target)
      this.markStreamingEntryDirty(`assistant:${key}`)
      if (text.trim() !== '') {
        this.replaceMessageCandidate(activity, step, text)
      } else if (!hasOpenOpaque) {
        this.replaceMessageCandidate(activity, step, '')
      } else {
        // A new opaque step confirms an older real-text candidate, but never
        // creates a candidate from the pending fallback itself. If this same
        // step's semantic text was replaced by an empty block, clear its old
        // candidate instead of leaving stale Focus text behind.
        const candidate = activity.messageCandidate
        if (candidate !== undefined && candidate.step === step) {
          this.replaceMessageCandidate(activity, step, '')
        } else if (candidate !== undefined && candidate.step < step) {
          this.confirmMessageCandidate(activity)
          this.syncMessage(activity)
          activity.revision += 1
        }
      }
      this.syncAssistantVisibility(turn, step, target, wasVisible, false)
    }

    const reasoning = projection.thinkingVisibleCount === 0
      ? ''
      : blocks
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)
        .join('')
    const thinkingKey = `thinking:${key}`
    if (reasoning === '') {
      if (!staleStep) {
        this.hideThinkingEntry(turn, step)
        this.clearThinkingPreview(this.activityFor(turn), step)
      }
      return
    }
    const thinking = this.thinkingEntry(turn, step, time)
    this.hiddenThinkingEntries.delete(thinking)
    thinking.text = reasoning
    thinking.running = true
    this.markStreamingEntryDirty(thinkingKey)
    this.restoreThinkingPreview(this.activityFor(turn), step, reasoning)
  }

  /** Fold one durable assistant stream once for both presentation order and
   * restored content. The indexed state is updated in O(1) per accepted chunk;
   * only the final projections sort the retained indexes. */
  private assistantStreamProjection(stream: readonly unknown[], turn: number, step: number): AssistantStreamProjection {
    const states = new Map<number, AssistantBlockState>()
    const rowOrder: Array<'thinking' | 'assistant'> = []
    let assistantVisibleCount = 0
    let thinkingVisibleCount = 0
    let assistantPresent = false
    let thinkingPresent = false
    let firstVisibleAt: number | undefined
    let usage: UsageLike | undefined
    let thinkingStartedAt: number | undefined
    let thinkingEndedAt: number | undefined
    const toolCallStarts = new Map<string, number>()

    const adjustVisibility = (state: AssistantBlockState, amount: number): void => {
      const projection = assistantBlockProjection(state)
      if (projection.assistantVisible) assistantVisibleCount += amount
      if (projection.thinkingVisible) thinkingVisibleCount += amount
    }

    for (const { time, chunk } of expandAssistantStream(stream as Parameters<typeof expandAssistantStream>[0])) {
      if (chunk.type === 'usage') {
        usage = chunk.usage
        continue
      }
      if (chunk.type === 'finish') continue
      if (firstVisibleAt === undefined && assistantChunkHasVisibleReply(chunk)) firstVisibleAt = time
      // Preparing evidence for the Preparing → durable elapsed continuity
      // (post-F6 plan §12.14): the FIRST streamed delta of a tool call is
      // the call's earliest authoritative start — keyed by the formal call
      // id when it is known (migrating the fallback identity's earlier
      // start and dropping the stale fallback key), else by the (turn,
      // step, index) fallback identity, exactly like the live fold.
      if (chunk.type === 'tool-call-delta') {
        if (chunk.id !== '') {
          const fallbackKey = preparingFallbackKey(turn, step, chunk.index)
          const fallback = toolCallStarts.get(fallbackKey)
          if (!toolCallStarts.has(chunk.id)) {
            toolCallStarts.set(chunk.id, fallback ?? time)
          }
          if (fallback !== undefined) toolCallStarts.delete(fallbackKey)
        } else {
          const fallbackKey = preparingFallbackKey(turn, step, chunk.index)
          if (!toolCallStarts.has(fallbackKey)) toolCallStarts.set(fallbackKey, time)
        }
      }
      const previous = states.get(chunk.index)
      if (!applyAssistantBlockChunk(states, chunk)) continue
      if (previous !== undefined) adjustVisibility(previous, -1)
      const current = states.get(chunk.index)
      if (current !== undefined) adjustVisibility(current, 1)

      const visibleNow = assistantVisibleCount > 0
      const nextThinking = thinkingVisibleCount > 0
      // The Thinking lane's TIMING evidence ends with its OWN reasoning
      // chunks: the reasoning block remains "visible" for the rest of the
      // decode, so updating on every visible chunk would stretch the
      // Thinking span to the end of the whole step stream (post-F6 plan
      // §12.6 — the reasoning block-end is the authoritative end; assistant
      // text is Conversation evidence, never Process).
      const reasoningEvidence = chunk.type === 'reasoning-delta'
        || (chunk.type === 'block-end' && chunk.block.type === 'reasoning')
      if (nextThinking) {
        thinkingStartedAt ??= time
        if (reasoningEvidence) thinkingEndedAt = time
      }
      // Match live step-level materialization: a hidden aggregate lane is
      // removed, and a later recreation is appended after surviving rows.
      if (visibleNow !== assistantPresent) {
        if (visibleNow) rowOrder.push('assistant')
        else {
          const index = rowOrder.indexOf('assistant')
          if (index >= 0) rowOrder.splice(index, 1)
        }
        assistantPresent = visibleNow
      }
      if (nextThinking !== thinkingPresent) {
        if (nextThinking) rowOrder.push('thinking')
        else {
          const index = rowOrder.indexOf('thinking')
          if (index >= 0) rowOrder.splice(index, 1)
        }
        thinkingPresent = nextThinking
      }
    }

    return {
      states,
      blocks: assistantContentFromBlocks(states),
      displayBlocks: assistantDisplayBlocksFromStates(states),
      firstLane: rowOrder[0],
      firstVisibleAt,
      usage,
      thinkingStartedAt,
      thinkingEndedAt,
      toolCallStarts,
    }
  }

  /** First-wins record of one streamed tool-call delta's time: keyed by the
   * formal call id once it arrives (migrating the fallback identity's
   * earlier start so the preparing seconds survive the delayed-id handoff),
   * else by the (turn, step, index) fallback identity. Every entry is
   * owned by its (turn, step) so lifecycle cleanup can clear BOTH key
   * shapes. */
  private recordPreparingDelta(turn: number, step: number, callId: string, index: number, time: number): void {
    const owner = `${turn}:${step}`
    if (callId !== '') {
      // Keyed by the durable (turn, step, callId) identity: a call id reused by
      // another step or turn must never occupy — or be blocked by — this step's
      // own entry.
      const key = toolCallKey(turn, step, callId)
      const fallbackKey = preparingFallbackKey(turn, step, index)
      const fallback = this.toolCallPreparingStarts.get(fallbackKey)
      if (!this.toolCallPreparingStarts.has(key)) {
        this.toolCallPreparingStarts.set(key, { at: fallback?.at ?? time, owner })
      }
      if (fallback !== undefined) this.toolCallPreparingStarts.delete(fallbackKey)
      return
    }
    const fallbackKey = preparingFallbackKey(turn, step, index)
    if (!this.toolCallPreparingStarts.has(fallbackKey)) {
      this.toolCallPreparingStarts.set(fallbackKey, { at: time, owner })
    }
  }

  /** Drop the preparing-start evidence of one step — BOTH the fallback
   * identities and the formal call ids it owns: a retry/step boundary
   * invalidates the dead attempt's starts, so a reused call id can never
   * inherit another attempt's timer (post-F6 plan §12.14). */
  private clearPreparingStartsForStep(turn: number, step: number): void {
    const owner = `${turn}:${step}`
    for (const [key, start] of this.toolCallPreparingStarts) {
      if (start.owner === owner) this.toolCallPreparingStarts.delete(key)
    }
  }

  /** Drop every preparing-start evidence of one turn (its `turn/end`). */
  private clearPreparingStartsForTurn(turn: number): void {
    const ownerPrefix = `${turn}:`
    for (const [key, start] of this.toolCallPreparingStarts) {
      if (start.owner.startsWith(ownerPrefix)) this.toolCallPreparingStarts.delete(key)
    }
  }

  /** First-wins merge of one durable stream's tool-call preparing starts
   * into the folder-wide map, owned by the stream's own (turn, step)
   * (post-F6 plan §12.14). */
  private absorbPreparingStarts(starts: ReadonlyMap<string, number>, turn: number, step: number): void {
    const owner = `${turn}:${step}`
    for (const [callId, at] of starts) {
      const key = toolCallKey(turn, step, callId)
      if (!this.toolCallPreparingStarts.has(key)) {
        this.toolCallPreparingStarts.set(key, { at, owner })
      }
      // The card may have materialized BEFORE its Preparing evidence became
      // visible (a durable `tool/call` whose streamed arguments delta only
      // arrives with the settlement). Its wall span must still start at its
      // earliest authoritative evidence — otherwise the displayed elapsed time
      // AND the display order disagree between live and cold.
      const index = this.toolCardIndexOf.get(key)
      const card = this.items[index ?? -1]
      if (index === undefined || card === undefined || card.kind !== 'tool' || card.callId !== callId) continue
      const timing = transcriptTimingOf(card)
      if (timing !== undefined && timing.startedAt > at) {
        setTranscriptTiming(card, { ...timing, startedAt: at })
        // A refreshed materialization key invalidates every derived fact: the
        // merged group's aggregated timing, and the row's place inside its
        // anchor's relation list.
        const group = this.groupOf.get(index)
        const members = group === undefined ? undefined : this.groupMembers.get(group)
        if (group !== undefined && members !== undefined) this.mergedReadGroupTiming(group, members, this.crossTurn(members))
        this.resortAnchorSideOf(index)
        this.convergeToolRowAgainstAnchor(turn, step, callId)
      }
    }
  }

  /** The durable lane-order authority for one settled assistant step: the
   * embedded stream's first visible lane — the same authority
   * `assistant/attempt` already consumes (`assistantStreamProjection`) —
   * and the durable `message.content` block order only when the stream
   * yields NO lane evidence (missing, empty, or lane-evidence-free such as
   * usage-only frames). Never a text heuristic; `undefined` means no order
   * evidence. */
  private durableLaneOrder(
    projection: AssistantStreamProjection | undefined,
    blocks: readonly ContentBlock[],
  ): 'thinking' | 'assistant' | undefined {
    return projection?.firstLane ?? contentLaneOrder(blocks)
  }

  /** Converge the step's TOOL rows around its Assistant anchor from each row's
   *  own materialization evidence.
   *
   * The durable settlement is appended at its own event index, while a Tool row
   * materializes when its earliest evidence arrived (a Preparing delta or the
   * durable `tool/call`). For a step whose first VISIBLE assistant text preceded
   * a later Tool call, the cold fold therefore showed `Work[c1, c2] → Assistant`
   * where the live fold showed `Work[c1] → Assistant → Work[c2]`.
   *
   * The evidence is per-step and identity-based: only the call ids the step's
   * OWN durable stream requested (`toolCallStarts`) are considered, resolved
   * through the recorded raw index and re-verified against the live card object.
   * A Tool whose own start is unknown, or equal to the first visible text, gets
   * NO displacement — an unprovable order is never guessed. Re-application is
   * idempotent (the relation is only recorded when it actually changes). */
  private convergeStepToolOrder(
    turn: number,
    step: number,
    projection: AssistantStreamProjection | undefined,
    messageBlocks: readonly ContentBlock[],
  ): void {
    // Candidate calls come from the step's OWN durable evidence: the ids its
    // embedded stream named AND the tool-call blocks of its durable message (a
    // block whose delta was not streamed still carries its step identity).
    const callIds = new Set<string>(projection?.toolCallStarts.keys() ?? [])
    for (const block of messageBlocks) {
      if (block.type === 'tool-call') callIds.add(block.id)
    }
    // A relation whose call this step's durable evidence no longer names has no
    // owner: drop it (never inherit it, never re-add it as a candidate).
    const anchorIndex = this.searchIndexByStepKey.get(`assistant:${stepKey(turn, step)}`)
    const anchored = anchorIndex === undefined ? undefined : this.laneDisplayByAnchor.get(anchorIndex)
    for (const displaced of anchored === undefined ? [] : [...anchored.before, ...anchored.after]) {
      const row = this.items[displaced]
      if (row === undefined || row.kind !== 'tool' || row.callId === undefined) continue
      if (!callIds.has(row.callId)) this.dropLaneDisplacement(displaced)
    }
    this.coalescingRegroups(() => {
      const sides: { before: number[]; after: number[] } = { before: [], after: [] }
      for (const callId of callIds) {
        const outcome = this.convergeToolRowAgainstAnchor(turn, step, callId)
        if (outcome !== undefined) sides[outcome.position].push(outcome.index)
      }
      // A side that owns TWO or more proven rows is ordered by evidence as a
      // WHOLE: a row already sitting on that side physically joins the relation
      // too, so live and cold cannot disagree when the durable arrival order
      // differs from the evidence order. A lone row keeps its physical slot, so
      // it never jumps across unrelated rows (see regression `F3`).
      const anchorIndex = this.searchIndexByStepKey.get(`assistant:${stepKey(turn, step)}`)
      if (anchorIndex === undefined) return
      for (const position of ['before', 'after'] as const) {
        if (sides[position].length < 2) continue
        for (const row of sides[position]) this.setLaneDisplay(row, anchorIndex, position)
      }
    })
    // The latest settlement is the step's authority: Preparing evidence for a
    // call it no longer names must not survive to qualify a LATER durable call
    // (a replacement that drops the call also drops its eligibility).
    const prefix = `${stepKey(turn, step)}\u0000`
    for (const cacheKey of [...this.toolCallPreparingStarts.keys()]) {
      if (!cacheKey.startsWith(prefix)) continue
      if (!callIds.has(cacheKey.slice(prefix.length))) this.toolCallPreparingStarts.delete(cacheKey)
    }
    // The durable REQUESTS (TOOL_NOT_STARTED compat) are the same authority: a
    // replacement that stops naming a call removes its request too, so a later
    // durable call cannot be qualified by the superseded block.
    for (const requestKey of [...this.requestedToolCalls.keys()]) {
      if (!requestKey.startsWith(prefix)) continue
      if (!callIds.has(requestKey.slice(prefix.length))) this.requestedToolCalls.delete(requestKey)
    }
  }

  /** Converge ONE Tool row against its step's Assistant anchor from the row's
   *  own materialization evidence. Called from BOTH directions, because either
   *  side can arrive last: the settlement converges the calls its own durable
   *  stream named, and a `tool/call` whose durable event carries the step
   *  converges itself against an Assistant row that already settled. */
  private convergeToolRowAgainstAnchor(
    turn: number,
    step: number,
    callId: string,
  ): { index: number; position: 'before' | 'after' } | undefined {
    const key = stepKey(turn, step)
    const assistantRow = this.assistantEntries.get(key)
    const assistantIndex = this.searchIndexByStepKey.get(`assistant:${key}`)
    const index = this.toolCardIndexOf.get(toolCallKey(turn, step, callId))
    const card = index === undefined ? undefined : this.items[index]
    const stale = index !== undefined && card !== undefined && card.kind === 'tool' && card.callId === callId
    // Only a PROVEN first-visible reply time is order evidence. The streamless
    // settlement fallback (which exists so the Activity can still close) is
    // deliberately NOT: without a stream there is no order authority, so no
    // relation may be created — and an inherited one is dropped here.
    const visibleAt = this.activityByTurn.get(turn)?.firstVisibleAssistantTimes.get(step)
    // The anchor must be the CURRENTLY visible Conversation: a stream that once
    // carried visible text does not make the settled row visible (an empty
    // authoritative replacement hides it), and a hidden anchor may not order
    // anything.
    if (assistantRow === undefined || assistantIndex === undefined || visibleAt === undefined
      || !this.isVisible(assistantRow)) {
      if (stale) this.dropLaneDisplacement(index!)
      return
    }
    if (index === undefined || card === undefined || card.kind !== 'tool' || card.callId !== callId) return
    const startedAt = transcriptTimingOf(card)?.startedAt
    if (startedAt === undefined || startedAt === visibleAt) {
      // Unknown or equal evidence cannot prove which side came first.
      this.dropLaneDisplacement(index)
      return undefined
    }
    const shouldFollow = startedAt > visibleAt
    const position: 'before' | 'after' = shouldFollow ? 'after' : 'before'
    if (shouldFollow === (index > assistantIndex)) {
      // Already in the physical position the evidence asks for: it keeps its own
      // slot (and any relation is dropped). The CALLER decides whether the whole
      // side must be evidence-ordered instead (two or more proven siblings).
      this.dropLaneDisplacement(index)
      return { index, position }
    }
    // A lane row the lane authority already finds physically conformant keeps its
    // physical slot and is therefore emitted AFTER the whole displaced list —
    // which would put this Tool on the wrong side of it (a later reasoning lane
    // row must follow a Tool that started before it). Adopt that row into the
    // SAME relation list so the evidence order decides between them.
    const thinkingIndex = this.searchIndexByStepKey.get(`thinking:${key}`)
    // Only a lane row WITHOUT a relation is adopted: one the lane authority
    // already placed (thinking-first) must keep that side.
    if (thinkingIndex !== undefined && this.thinkingEntries.get(key) !== undefined
      && !this.laneDisplayByDisplaced.has(thinkingIndex)) {
      if (shouldFollow && thinkingIndex > assistantIndex) this.setLaneDisplay(thinkingIndex, assistantIndex, 'after')
      if (!shouldFollow && thinkingIndex < assistantIndex) this.setLaneDisplay(thinkingIndex, assistantIndex, 'before')
    }
    this.setLaneDisplay(index, assistantIndex, position)
    return { index, position }
  }

  /** Converge one step's Thinking/Assistant rows to its stored lane
   * authority. When the physical append order contradicts the authority (a
   * lane materialized after the step already owned the other row — same-step
   * replacement or late diagnostic reasoning), the Thinking row is
   * DISPLAY-DISPLACED around the Assistant row: `items` stays strictly
   * append-only and the raw index keeps its `TranscriptItemId` stable-
   * identity meaning (the search overlay recovers hits by it). Steps with
   * fewer than two live lane rows, without stored authority, or already
   * conformant drop any stale mapping instead. */
  private convergeStepLaneOrder(turn: number, step: number): void {
    const key = stepKey(turn, step)
    const authority = this.stepLaneOrders.get(key)
    if (authority === undefined) return
    const thinkingRow = this.thinkingEntries.get(key)
    const assistantRow = this.assistantEntries.get(key)
    if (thinkingRow === undefined || assistantRow === undefined) return
    const thinkingIndex = this.searchIndexByStepKey.get(`thinking:${key}`)
    const assistantIndex = this.searchIndexByStepKey.get(`assistant:${key}`)
    if (thinkingIndex === undefined || assistantIndex === undefined) return
    if ((thinkingIndex < assistantIndex) === (authority === 'thinking')) {
      // Conformant: drop a stale mapping from an earlier flipped authority —
      // ONLY the Thinking relation, never the step's Tool displacements that
      // share this Assistant anchor.
      this.dropLaneDisplacement(thinkingIndex)
      return
    }
    // The Assistant row anchors the step; the Thinking row is displayed
    // immediately before (thinking-first) or after (assistant-first) it.
    this.setLaneDisplay(thinkingIndex, assistantIndex, authority === 'thinking' ? 'before' : 'after')
  }

  /** THE single display-order traversal of the raw items: raw physical
   * order, with lane rows displaced by `convergeStepLaneOrder` emitted at
   * their anchor (before/after per the stored authority). Every display
   * path — `groupedMessages()`, the window projection and `search()` —
   * consumes THIS traversal so display chronology has exactly one owner;
   * raw storage stays append-only and raw indexes stay stable
   * (`TranscriptItemId`).
   *
   * Ranged callers (the window) must supply COMPLETE turn ranges — lane
   * peers always share one turn, so a turn-bounded range always covers a
   * pair together; an arbitrary raw slice could split one. */
  private *displayOrderedRawIds(start = 0, end: number = this.items.length - 1): Iterable<number> {
    for (let index = start; index <= end; index += 1) {
      // A displaced row is emitted at its anchor below, never at its physical
      // slot (so every visible raw index is yielded exactly once).
      if (this.laneDisplayByDisplaced.has(index)) continue
      const owned = this.laneDisplayByAnchor.get(index)
      if (owned === undefined) {
        yield index
        continue
      }
      for (const displaced of owned.before) yield displaced
      yield index
      for (const displaced of owned.after) yield displaced
    }
  }

  /** The ordering key of one displaced row: its own proven materialization
   *  time when it has one (evidence), else its raw index as a stable proxy that
   *  never interleaves with evidenced rows. */
  private displacedOrderOf(rawIndex: number): { evidenced: boolean; key: number } {
    const item = this.items[rawIndex]
    const startedAt = item === undefined ? undefined : transcriptTimingOf(item)?.startedAt
    return startedAt === undefined ? { evidenced: false, key: rawIndex } : { evidenced: true, key: startedAt }
  }

  /** The only mutation entry for the lane display maps: records the pair
   * and bumps the search revision when the recorded relation actually
   * changes (an idempotent re-record of the same pair is revision-neutral).
   * The revision guards the search projection's CONTENT **and ORDER** — a
   * display-relation change alters the order matches are emitted in, so
   * refinement against previous matches must be invalidated even when no
   * searchable text changed. */
  private setLaneDisplay(displaced: number, anchor: number, position: 'before' | 'after'): void {
    const current = this.laneDisplayByDisplaced.get(displaced)
    if (current?.anchor === anchor && current.position === position) {
      // The relation is unchanged, but a refreshed materialization key can move
      // this row within its side: re-sort without recording a new relation.
      this.resortAnchorSide(anchor, position)
      return
    }
    const previousAnchor = current?.anchor
    if (current !== undefined) this.removeDisplacedRelation(displaced, current)
    this.laneDisplayByDisplaced.set(displaced, { anchor, position })
    const owned = this.laneDisplayByAnchor.get(anchor) ?? { before: [], after: [] }
    this.laneDisplayByAnchor.set(anchor, owned)
    const list = position === 'before' ? owned.before : owned.after
    list.push(displaced)
    // Two displaced rows on the SAME side are ordered by their own proven
    // materialization time (a Thinking lane row and a Tool row of one step have
    // no shared raw-order authority), with the raw index only as the stable
    // tie-break for rows that carry no evidence at all.
    list.sort((left, right) => {
      const a = this.displacedOrderOf(left)
      const b = this.displacedOrderOf(right)
      if (a.evidenced !== b.evidenced) return a.evidenced ? -1 : 1
      return a.key - b.key || left - right
    })
    this.searchRevisionCounter += 1
    // A real display-relation change can split or join a read run: the ONE
    // adjacency definition must follow it — at the NEW anchor AND at the old one
    // when the relation was replaced.
    this.scheduleDisplayRegroup(anchor)
    if (previousAnchor !== undefined && previousAnchor !== anchor) this.scheduleDisplayRegroup(previousAnchor)
  }

  /** Remove ONE displaced row's relation, leaving the anchor's OTHER displaced
   *  rows (its Thinking lane row, the step's other Tool rows) untouched. */
  private dropLaneDisplacement(displaced: number): void {
    const current = this.laneDisplayByDisplaced.get(displaced)
    if (current === undefined) return
    const anchor = current.anchor
    this.removeDisplacedRelation(displaced, current)
    // A departure changes the neighborhood of BOTH endpoints, and the relation
    // that used to link them is gone: seed the regroup with each of them.
    this.scheduleDisplayRegroup(displaced, anchor)
  }

  /** Remove EVERY relation anchored at `anchor` — its displaced rows fall back
   *  to their physical slots. Used when the anchor row itself is tombstoned. */
  private dropLaneAnchor(anchor: number): void {
    const owned = this.laneDisplayByAnchor.get(anchor)
    if (owned === undefined) return
    const departing = [...owned.before, ...owned.after]
    for (const displaced of departing) {
      this.laneDisplayByDisplaced.delete(displaced)
    }
    this.laneDisplayByAnchor.delete(anchor)
    this.searchRevisionCounter += 1
    // The anchor AND every row that left it all change neighborhood now.
    this.scheduleDisplayRegroup(anchor, departing)
  }

  /** The shared inverse-map removal: drop the forward record, the anchor's list
   *  entry and (when it was the last one) the anchor record itself. */
  private removeDisplacedRelation(displaced: number, current: { anchor: number; position: 'before' | 'after' }): void {
    this.laneDisplayByDisplaced.delete(displaced)
    const owned = this.laneDisplayByAnchor.get(current.anchor)
    if (owned !== undefined) {
      const list = current.position === 'before' ? owned.before : owned.after
      const at = list.indexOf(displaced)
      if (at !== -1) list.splice(at, 1)
      if (owned.before.length === 0 && owned.after.length === 0) this.laneDisplayByAnchor.delete(current.anchor)
    }
    this.searchRevisionCounter += 1
  }


  private restoreThinkingFromProjection(turn: number, step: number, projection: AssistantStreamProjection): void {
    const activity = this.activityByTurn.get(turn)
    const staleStep = activity !== undefined && step < (activity.lastAssistantStep ?? step)
    const key = stepKey(turn, step)
    // A late replay may supply the first diagnostic row for an older step, but
    // it must not replace reasoning already restored from that step's earlier
    // authoritative attempt.
    if (staleStep && this.thinkingEntries.has(key)) return
    const text = projection.blocks
      .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
      .map(block => block.text)
      .join('')
    if (text === '') {
      if (!staleStep) {
        this.hideThinkingEntry(turn, step)
        const activity = this.activityByTurn.get(turn)
        if (activity !== undefined) this.clearThinkingPreview(activity, step)
      }
      return
    }
    const entry = this.thinkingEntry(turn, step, projection.thinkingStartedAt)
    this.hiddenThinkingEntries.delete(entry)
    entry.text = text
    this.markStreamingEntryDirty(`thinking:${key}`)
    // The durable lane timing is AUTHORITY at settlement: a same-step
    // replacement re-anchors BOTH bounds (§12.6), never only the end.
    if (projection.thinkingStartedAt !== undefined) {
      setTranscriptTiming(entry, { startedAt: projection.thinkingStartedAt, running: true })
    }
    this.closeThinking(entry, projection.thinkingEndedAt)
    this.restoreThinkingPreview(this.activityFor(turn), step, text)
  }

  /** Restore assistant interruption evidence from a durable attempt. Text and
   * finalized non-text blocks are retained; reasoning remains in the Think
   * entry. Tool-call-only content is retained as hidden evidence until the
   * closed boundary. An open opaque block keeps display-only evidence while
   * the attempt is live. The attempt entry is still transient so `llm/retry`
   * can reset it. */
  private restoreAssistantAttempt(turn: number, step: number, projection: AssistantStreamProjection): void {
    const { states, blocks, displayBlocks } = projection
    const hasOpenOpaque = displayBlocks.some(block => block.kind === 'open-opaque')
    const displayProjection = hasOpenOpaque ? displayBlocks : undefined
    const visibleNow = displayProjection === undefined
      ? assistantBlocksVisibleNow(blocks)
      : assistantDisplayBlocksVisibleNow(displayProjection)
    const hasEvidence = displayProjection === undefined
      ? assistantBlocksHaveInterruptionEvidence(blocks)
      : assistantDisplayBlocksHaveInterruptionEvidence(displayProjection)
    // An explicitly decoded block state is authoritative even when it has no
    // visible Assistant row (reasoning/tool-call/empty text). Only an entirely
    // empty stream may preserve a live prefix as attempt evidence.
    const hasAuthoritativeBlockState = states.size > 0
    const text = textOf(blocks)
    const key = stepKey(turn, step)
    const activity = this.activityFor(turn)
    const existing = this.assistantEntries.get(key)
    if (existing === undefined && step < (activity.lastAssistantStep ?? -1)) return
    if (hasAuthoritativeBlockState && step >= (activity.lastAssistantStep ?? -1)) {
      // Durable attempt evidence owns the same structural stale-event fence
      // as live opaque presentation. Hidden authoritative state clears the
      // latest-visible bit while preserving the monotonic step fence.
      activity.lastAssistantVisible = visibleNow
      // Hidden authoritative state is still the latest structural output and
      // must fence late older steps without creating a Message candidate.
      activity.lastAssistantStep = Math.max(activity.lastAssistantStep ?? -1, step)
    }
    if (hasAuthoritativeBlockState && text.trim() === '' && activity.messageCandidate?.step === step) {
      // A hidden authoritative state replaces semantic text for this step; do
      // not leave the earlier live candidate visible in Focus.
      this.replaceMessageCandidate(activity, step, '')
    }
    const wasVisible = existing !== undefined && this.isVisible(existing)
    if (!visibleNow && !hasEvidence && !hasAuthoritativeBlockState) {
      // A live prefix may be the only evidence when the compact settlement
      // carries no block state. Keep that prefix as attempt evidence instead
      // of promoting it to a normal settled message.
      if (existing !== undefined && this.transientAssistantEntries.has(existing)) {
        const hasOpenOpaque = existing.displayBlocks?.some(block => block.kind === 'open-opaque') === true
        if (hasOpenOpaque) this.hideTransientAssistantEntry(turn, step)
        else this.attemptAssistantEntries.add(existing)
      }
      return
    }
    const entry = existing ?? this.assistantEntry(turn, step)
    this.hiddenAssistantEntries.delete(entry)
    this.transientAssistantEntries.add(entry)
    this.attemptAssistantEntries.add(entry)
    entry.text = text
    entry.content = blocks.some(block => block.type !== 'text') ? blocks : undefined
    entry.displayBlocks = displayProjection
    entry.interrupted = undefined
    this.markStreamingEntryDirty(`assistant:${key}`)
    this.syncAssistantVisibility(turn, step, entry, wasVisible, false)
  }

  /** Mark durable attempt evidence visible at the closed boundary. Empty and
   * reasoning-only attempts remain hidden; tool-call and generic finalized
   * blocks become interrupted assistant evidence here, not while running. */
  private markAttemptEvidenceInterrupted(turn: number, step?: number): void {
    for (const [key, item] of this.assistantEntries) {
      if (item.turn !== turn || !this.attemptAssistantEntries.has(item)) continue
      const itemStep = Number(key.slice(key.indexOf('/') + 1))
      if (step !== undefined && itemStep !== step) continue
      if (!assistantEntryHasInterruptionEvidence(item)) continue
      if (this.hiddenAssistantEntries.has(item)) continue
      const wasVisible = this.isVisible(item)
      item.interrupted = true
      this.syncAssistantVisibility(turn, itemStep, item, wasVisible)
    }
  }

  /** Restore a SETTLED thinking entry from one durable assistant message.
   * The embedded stream's reasoning is the PRIMARY source — the same
   * projection that owns lane order/usage (decode-once, plan §4.4/§12.5) —
   * and the assembled `message.content` blocks are the fallback when the
   * stream carries no reasoning. The durable message is authoritative: it
   * replaces any earlier same-step reasoning, including replacing it with
   * no entry. */
  private restoreThinkingFromMessage(
    turn: number,
    step: number,
    projection: AssistantStreamProjection | undefined,
    blocks: readonly ContentBlock[],
  ): void {
    const key = stepKey(turn, step)
    let text = reasoningBlockText(projection?.blocks)
    if (text === '') text = reasoningBlockText(blocks)
    if (text === '') {
      const existing = this.thinkingEntries.get(key)
      // Legacy/live messages may omit reasoning blocks even though the live
      // entry already has useful text; close that entry in place. A closed
      // retry entry (or an empty reset entry) is authoritative-empty and is
      // tombstoned instead.
      if (existing !== undefined && existing.running && existing.text !== '') {
        this.closeThinking(existing)
      } else {
        this.hideThinkingEntry(turn, step)
        const activity = this.activityByTurn.get(turn)
        if (activity !== undefined) this.clearThinkingPreview(activity, step)
      }
      return
    }
    const entry = this.thinkingEntry(turn, step, projection?.thinkingStartedAt)
    this.hiddenThinkingEntries.delete(entry)
    entry.text = text
    this.markStreamingEntryDirty(`thinking:${key}`)
    // The durable lane timing is AUTHORITY at settlement: a same-step
    // replacement re-anchors BOTH bounds (§12.6), never only the end. A
    // streamless settlement has no lane authority — closeThinking falls
    // back to the last accepted live reasoning evidence.
    if (projection?.thinkingStartedAt !== undefined) {
      setTranscriptTiming(entry, { startedAt: projection.thinkingStartedAt, running: true })
    }
    this.closeThinking(entry, projection?.thinkingEndedAt)
    this.restoreThinkingPreview(this.activityFor(turn), step, text)
  }

  /**
   * Hydrate a cold session log in one batch. Folding remains event-ordered,
   * but expensive read-run reflow is deferred until every event has settled;
   * live suffixes must continue to use {@link apply} for immediate grouping.
   */
  hydrate(events: readonly SessionEvent[]): void {
    if (this.hydrating) {
      this.apply(events)
      return
    }
    this.hydrating = true
    try {
      this.apply(events)
    } finally {
      this.hydrating = false
      if (this.groupingDirty) {
        this.rebuildGrouping()
        this.groupingDirty = false
      }
      // Seal the search projection: the cold fold marked settlements dirty
      // (tool results, assistant/message replacements, compaction
      // summaries) even when no read group formed. Normalize them once —
      // the COLD path may pay O(history), the live path never does.
      this.normalizeDirtySearchEntries()
    }
  }

  /** Build the grouped output list (the full projection). */
  private groupedMessages(): TranscriptMessage[] {
    const grouped: TranscriptMessage[] = []
    for (const index of this.displayOrderedRawIds()) {
      const group = this.groupOf.get(index)
      if (group !== undefined) {
        const members = this.groupMembers.get(group)
        if (members !== undefined && members[0] === index) grouped.push(group)
        continue
      }
      const item = this.items[index]
      if (item === undefined) continue
      // Tombstoned failed-attempt text never renders.
      if (!this.isVisible(item)) continue
      grouped.push(item)
    }
    return grouped
  }

  /**
   * The live turn index used by the presentation window controller. The
   * returned array is read-only by contract and intentionally shared: appending
   * a new turn extends the same index in O(1), so repainting does not copy the
   * full history.
   */
  turns(): readonly number[] {
    return this.turnValues
  }

  /** The distinct turn values represented by grouped output cards. */
  groupedTurns(): readonly number[] {
    this.ensureGroupedTurnIndex()
    return this.groupedTurnValues
  }

  /** Locate the inclusive turn range for a window without materializing rows. */
  private indexedWindowRange(maxTurns: number, endTurn?: number): { start: number; end: number; anchored: boolean } | undefined {
    const totalTurns = this.turnValues.length
    if (totalTurns === 0) return undefined
    let end = totalTurns - 1
    let anchored = false
    if (endTurn !== undefined) {
      let low = 0
      let high = totalTurns
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (this.turnValues[middle]! <= endTurn) low = middle + 1
        else high = middle
      }
      const candidate = low - 1
      // Keep the legacy anchored-window behavior: an unknown search anchor
      // falls back to the latest window rather than rendering an empty view.
      if (candidate < 0 || this.turnValues[candidate] !== endTurn) end = totalTurns - 1
      else {
         end = candidate
         anchored = true
       }
    }
    return { start: Math.max(0, end - maxTurns + 1), end, anchored }
  }

  /** Emit one indexed raw-item range, preserving complete same-turn groups. */
  private projectIndexedRange(startTurn: number, endTurn: number): { messages: TranscriptMessage[]; tools: number } {
    const itemStart = this.turnStarts[startTurn]
    const itemEnd = endTurn + 1 < this.turnStarts.length
      ? this.turnStarts[endTurn + 1]! - 1
      : this.items.length - 1
    const kept: TranscriptMessage[] = []
    const seenGroups = new Set<ReadGroupCard>()
    let tools = 0
    const firstTurnValue = this.turnValues[startTurn]
    const lastTurnValue = this.turnValues[endTurn]
    if (itemStart === undefined || itemEnd < itemStart || firstTurnValue === undefined || lastTurnValue === undefined) {
      return { messages: kept, tools }
    }
    for (const index of this.displayOrderedRawIds(itemStart, itemEnd)) {
      const group = this.groupOf.get(index)
      if (group !== undefined) {
        // A cross-turn group may begin before the selected raw range. Its
        // emitted card is owned by its max/output turn, so include the whole
        // card exactly once when that output turn belongs to the range.
        if (!seenGroups.has(group) && group.turn >= firstTurnValue && group.turn <= lastTurnValue) {
          seenGroups.add(group)
          kept.push(group)
          if (group.kind === 'tool') tools += 1
        }
        continue
      }
      const message = this.items[index]
      if (message === undefined) continue
      // Tombstoned failed-attempt text never renders.
      if (!this.isVisible(message)) continue
      kept.push(message)
      if (message.kind === 'tool') tools += 1
    }
    return { messages: kept, tools }
  }

  /** Add the same compact summary used by the legacy window projection. */
  private addWindowSummary(
    messages: TranscriptMessage[],
    maxTurns: number,
    startTurn: number,
    endTurn: number,
    windowTools: number,
     facts?: { older: number; newer: number },
     anchored = false,
  ): TranscriptMessage[] {
    const older = facts?.older ?? startTurn
    const newer = facts?.newer ?? this.turnValues.length - endTurn - 1
    if (older === 0 && newer === 0) return messages
    const parts: string[] = []
    if (newer > 0) parts.push(`${newer} newer turn${newer === 1 ? '' : 's'}`)
    if (older > 0) parts.push(`${older} earlier turn${older === 1 ? '' : 's'}`)
    if (newer === 0 && !anchored) {
      const oldTools = this.groupedToolCount - windowTools
      const turnsText = `${older} earlier turn${older === 1 ? '' : 's'}`
      const toolsText = `${oldTools} tool call${oldTools === 1 ? '' : 's'}`
      messages.unshift({ kind: 'summary', text: `… ${turnsText} · ${toolsText} — window ${maxTurns} turns` })
    } else {
      messages.unshift({ kind: 'summary', text: `… ${parts.join(' · ')} — window ${maxTurns} turns` })
    }
    return messages
  }

  /** Build one bounded projection and its navigation facts. */
  window(options: FoldOptions & { maxTurns: number }): TranscriptWindow {
    const maxTurns = Math.max(1, Math.trunc(options.maxTurns))
    let range = this.indexedWindowRange(maxTurns, options.endTurn)

    // A turn-less session is not an empty transcript: standalone-only rows
    // (commands, compaction cards) still project, with no turn navigation
    // facts (post-PR166 plan §8.2). No fake summary row is synthesized.
    if (range === undefined) {
      const standalone = this.groupedMessages()
      return standalone.length === 0
        ? { messages: [], hasOlder: false, hasNewer: false }
        : { messages: standalone, hasOlder: false, hasNewer: false }
    }
     if (this.turnsMonotonic && this.crossTurnGroups > 0) {
       const groupedRange = this.groupedWindowRange(maxTurns, options.endTurn)
       if (groupedRange !== undefined) {
         range = groupedRange

       }
     }
    if (range === undefined) return { messages: [], hasOlder: false, hasNewer: false }

    const anchored = range.anchored

     // Non-monotonic logs are the defensive slow path. Cross-turn read groups
    // remain bounded: projectIndexedRange sees a member in the selected range
    // and emits the complete group card by its output/max turn, so a single
    // long read run cannot make every navigation repaint rescan history.
    if (!this.turnsMonotonic) {
      const full = this.groupedMessages()
       // Turn-less standalone rows (commands AND fused manual-compaction owners)
       // follow the SHARED placement authority — never the turn predicates of the
       // pure `windowMessages` helper (which keeps every turn-less row
       // unconditionally and would fold a fused owner away by its legacy turn).
       // They are windowed separately here and merged back in raw order, so a
       // small window never drags every historical command/compaction in (the
       // bounded-window and anchored-search contracts, plan §8).
      const anchoredRows = new Map<TranscriptMessage, number>()
      const windowInput: TranscriptMessage[] = []
      for (const message of full) {
       const anchor = this.placementAnchorOf(message)
       if (anchor !== undefined) anchoredRows.set(message, anchor)
       else windowInput.push(message)
      }
      const allTurns = [...new Set(windowInput.filter(message => 'turn' in message).map(message => message.turn))]
       .sort((a, b) => a - b)

      const windowed = windowMessages(windowInput, maxTurns, options.endTurn)
      const sortedDesc = [...allTurns].sort((a, b) => b - a)
      const anchorIndex = options.endTurn === undefined ? -1 : sortedDesc.indexOf(options.endTurn)
      const windowTurnSet = new Set(anchorIndex >= 0
       ? sortedDesc.slice(anchorIndex, anchorIndex + maxTurns)
       : sortedDesc.slice(0, maxTurns))
      const summaryRows = windowed.filter(message => message.kind === 'summary')
      const windowedBody = new Set<TranscriptMessage>(windowed.filter(message => message.kind !== 'summary'))
      const messages: TranscriptMessage[] = [...summaryRows]
      for (const message of full) {
       const anchor = anchoredRows.get(message)
       if (anchor !== undefined) {
         if (windowTurnSet.has(anchor)) messages.push(message)
         continue
       }
       if (windowedBody.has(message)) messages.push(message)
      }
      const visibleSet = new Set<number>()
      for (const message of messages) {
        if ('turn' in message) visibleSet.add(message.turn)
      }
       const visibleTurnValues = [...visibleSet].sort((a, b) => a - b)
       const firstTurn = visibleTurnValues[0] ?? this.turnValues[range.start]
       const lastTurn = visibleTurnValues[visibleTurnValues.length - 1] ?? this.turnValues[range.end]
       const older = firstTurn === undefined
         ? allTurns.length
         : allTurns.filter(turn => turn < firstTurn && !visibleSet.has(turn)).length
       const newer = lastTurn === undefined
         ? 0
         : allTurns.filter(turn => turn > lastTurn && !visibleSet.has(turn)).length

      return {
         messages,
         firstTurn,
        lastTurn,
        hasOlder: older > 0,
        hasNewer: newer > 0,
      }
    }

    const projected = this.projectIndexedRange(range.start, range.end)
    // The LEADING standalone region (raw items before the first turn-owned
    // row) belongs to the first turn's window by PLACEMENT, not blindly: an
    // ANCHORED window (a search/navigation jump) keeps a leading row only
    // when its placement anchor is the first selected turn (a pre-turn row
    // adopted by it); a turn whose only standalone row anchored elsewhere
    // (e.g. an in-turn-0 command of a session whose turn 0 has no other rows)
    // stays out. The latest/fallback window shows the whole prefix.
    const firstTurnBoundary = this.turnStarts[0]
    if (range.start === 0 && firstTurnBoundary !== undefined && firstTurnBoundary > 0) {
     const firstTurnValue = this.turnValues[0]
     const leading: TranscriptMessage[] = []
     for (let index = 0; index < firstTurnBoundary; index += 1) {
       const item = this.items[index]
       if (item === undefined || !this.isVisible(item)) continue
       const anchor = this.placementAnchorOf(item)
       if (anchored && firstTurnValue !== undefined && anchor !== undefined && anchor !== firstTurnValue) continue
       leading.push(item)
     }
     if (leading.length > 0) projected.messages = [...leading, ...projected.messages]
    }

    const visibleTurns = projected.messages
      .filter(message => 'turn' in message)
      .map(message => message.turn)
    const firstTurn = visibleTurns[0] ?? this.turnValues[range.start]
     const lastTurn = visibleTurns[visibleTurns.length - 1] ?? this.turnValues[range.end]
     const facts = this.crossTurnGroups > 0
     ? this.groupedTurnFacts(this.turnValues[range.start]!, this.turnValues[range.end]!)
     : undefined
     const older = facts?.older ?? range.start
     const newer = facts?.newer ?? this.turnValues.length - range.end - 1
     const messages = this.addWindowSummary(projected.messages, maxTurns, range.start, range.end, projected.tools, facts, anchored)
    return {
      messages,
      firstTurn,
      lastTurn,
      hasOlder: older > 0,
      hasNewer: newer > 0,
    }
  }

  /** Build the grouped output list (the full projection or a bounded window). */
  messages(options?: FoldOptions): TranscriptMessage[] {
    const maxTurns = options?.maxTurns
    if (maxTurns === undefined || maxTurns <= 0) return this.groupedMessages()
    // The indexed path is group-aware, including cross-turn read cards, and
    // falls back only for genuinely non-monotonic/corrupt logs. Full history
    // remains available through the no-maxTurns call (search uses the
    // lightweight projection instead — it never materializes this list).
    return this.window({ maxTurns, ...options }).messages
  }

  /** The search-projection revision: bumped on EVERY projection change —
   * entry mutations (append, settlement, group reflow) and lane
   * display-order mutations (`setLaneDisplay`/`dropLaneDisplacement`/`dropLaneAnchor`). The
   * runner's query refinement must never reuse previous candidates across
   * a revision — the projection may hold new matches OR a new match order
   * the old candidate list cannot see. */
  searchRevision(): number {
    return this.searchRevisionCounter
  }

  /** Full-history transcript search over the lightweight projection — same
   * corpus and ORDER as the legacy full search (`messages()` + filter +
   * per-message lowercase), but never materializes the grouped transcript
   * and never re-lowercases history per query. Results are OCCURRENCE-level:
   * a card emits one match per non-overlapping occurrence in its
   * representative corpus (each with its semantic `source` + ordinal), and a
   * merged read card yields occurrences from its members' text rather than
   * hidden member-level results. `refinement` (optional) narrows a previous
   * result set when the new query extends it AND the projection revision is
   * unchanged — otherwise the full lightweight scan runs.
   * @param query - the raw query (trimmed + lowercased here, like legacy).
   * @param refinement - the previous query's matches for prefix refinement;
   * the folder validates the prefix AND the revision internally.
   */
  search(
    query: string,
    refinement?: {
      previousQuery: string
      previousMatches: readonly TranscriptSearchMatch[]
      revision: number
    },
  ): TranscriptSearchMatch[] {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    // Lazy normalization: only DIRTY entries are re-normalized (whole-
    // string Unicode semantics) — streaming chunks and read-group
    // expansions never pay per-chunk/per-member lowercase, and a query
    // after no mutations pays nothing.
    this.normalizeDirtySearchEntries()
    const previousNeedle = refinement?.previousQuery.trim().toLowerCase() ?? ''
    const canRefine = refinement !== undefined
      && previousNeedle !== ''
      && needle.startsWith(previousNeedle)
      && this.searchRevisionCounter === refinement.revision
    const matches: TranscriptSearchMatch[] = []
    const seen = new Set<number>()
    const consider = (id: number): void => {
      const entry = this.searchEntries[id]
      if (entry === undefined) return
      const representative = this.representativeOf(id)
      // Non-representative group members carry no searchable text: the
      // merged group's text lives ONLY on the representative entry (a
      // group expansion marks exactly that one entry dirty).
      if (representative !== id) return
      // Tombstoned failed-attempt text is not part of the corpus.
      const item = this.items[id]
      if (item !== undefined && !this.isVisible(item)) return
      if (seen.has(representative)) return
      if (!entry.normalizedText.includes(needle)) return
      seen.add(representative)
      // Enumerate every NON-OVERLAPPING occurrence in the representative
      // corpus: the overlay count is occurrence-level, and each occurrence
      // carries its semantic source for reveal/highlight.
      let start = 0
      let occurrence = 0
      const sourceOccurrences = new Map<string, number>()
      while (true) {
        const index = entry.normalizedText.indexOf(needle, start)
        if (index < 0) break
        const span = resolveSearchSource(entry.spans, index)
        const source: TranscriptSearchSource = span?.source ?? { kind: 'message' }
        const sourceKey = span?.sourceKey ?? 'message'
        const sourceOccurrence = sourceOccurrences.get(sourceKey) ?? 0
        sourceOccurrences.set(sourceKey, sourceOccurrence + 1)
        matches.push({ id: representative, turn: entry.turn, occurrence, source, sourceOccurrence })
        occurrence += 1
        start = index + Math.max(1, needle.length)
      }
    }
    if (canRefine) {
      // Dedupe the previous matches to their CURRENT representatives FIRST:
      // a card with 10k occurrences would otherwise re-run the same failing
      // `includes()` 10k times. Refinement cost is O(candidate CARDS).
      const representatives = new Set<number>()
      for (const match of refinement.previousMatches) representatives.add(this.representativeOf(match.id))
      for (const id of representatives) {
        this.searchRefineCandidates += 1
        consider(id)
      }
      this.searchRefineCount += 1
    } else {
      // The full lightweight scan walks DISPLAY order (the shared
      // `displayOrderedRawIds` traversal): match order mirrors the
      // transcript the user sees, while match ids stay the stable raw
      // indexes.
      for (const id of this.displayOrderedRawIds()) consider(id)
      this.searchFullScanCount += 1
    }
    return matches
  }

  /** Resolve one search match to its CURRENT visible card: the merged read
   * group when the matched item is a member now, else the raw item. A group
   * reflow AFTER the query may have replaced the representative card — the
   * id still resolves (fail-soft; never a throw or a stale object). */
  resolveSearchMatch(match: TranscriptSearchMatch): TranscriptMessage | undefined {
    const item = this.items[match.id]
    if (item === undefined) return undefined
    return this.groupOf.get(match.id) ?? item
  }

  /** Test-only structural counters: prove the query path never falls back
   * to full projection/lowercase work (the 10k-turn complexity gate). */
  searchDiagnosticsForTest(): {
    entries: number
    groupingRebuilds: number
    normalizedRefreshes: number
    dirtyScans: number
    fullScans: number
    refinedScans: number
    refinedCandidates: number
    lastRegroupSpanRows: number
    lastRegroupMemberVisits: number
    regroupOperations: number
  } {
    return {
      entries: this.searchEntries.length,
      groupingRebuilds: this.groupingRebuildCount,
      normalizedRefreshes: this.searchRefreshCount,
      dirtyScans: this.searchDirtyScanCount,
      fullScans: this.searchFullScanCount,
      refinedScans: this.searchRefineCount,
      refinedCandidates: this.searchRefineCandidates,
      lastRegroupSpanRows: this.lastRegroupSpanRows,
      lastRegroupMemberVisits: this.lastRegroupMemberVisits,
      regroupOperations: this.regroupOperationCount,
    }
  }

  /** Settle one thinking entry: it stops streaming and records its
   * authoritative end in the timing sidecar (post-F6 plan §12.6). An absent
   * `endedAt` (an abandoned attempt, a streamless legacy settlement) falls
   * back to the last ACCEPTED reasoning evidence — the honest end — never
   * the settlement's own late time; with neither, `endedAt` stays
   * undefined. Consumers treat unknown as UNKNOWN, never zero. */
  private closeThinking(entry: Extract<TranscriptMessage, { kind: 'thinking' }>, endedAt?: number): void {
    entry.running = false
    const evidenceEnd = endedAt ?? thinkingLastEvidence.get(entry)
    const startedAt = transcriptTimingOf(entry)?.startedAt ?? evidenceEnd
    if (startedAt !== undefined) {
      setTranscriptTiming(entry, {
        startedAt,
        ...(evidenceEnd === undefined ? {} : { endedAt: Math.max(startedAt, evidenceEnd) }),
        running: false,
      })
    }
    const open = this.openThinkingByTurn.get(entry.turn)
    if (open === undefined) return
    open.delete(entry)
    if (open.size === 0) this.openThinkingByTurn.delete(entry.turn)
  }

  /** Tombstone one thinking entry while preserving raw item indexes. */
  private hideThinkingEntry(turn: number, step: number): void {
    const key = stepKey(turn, step)
    const entry = this.thinkingEntries.get(key)
    if (entry === undefined) return
    const index = this.searchIndexByStepKey.get(`thinking:${key}`)
    // The row becomes invisible FIRST: visibility is display adjacency, so the
    // grouping must be re-derived from the FINAL state — a hidden row is not a
    // boundary, and the two reads it separated may merge.
    if (!this.hiddenThinkingEntries.has(entry)) {
      this.hiddenThinkingEntries.add(entry)
      this.markStreamingEntryDirty(`thinking:${key}`)
      this.removeGroupedTurn(entry.turn)
    }
    // A tombstoned lane row can no longer honor a display displacement —
    // drop the mapping so the surviving lane falls back to its physical
    // slot (the raw index stays the stable TranscriptItemId).
    this.dropLaneDisplacement(index ?? -1)
    entry.text = ''
    this.closeThinking(entry)
    this.thinkingEntries.delete(key)
    if (index !== undefined) this.scheduleDisplayRegroup(index)
  }

  /** Reset same-step presentation and first-visible boundary at the scheduled
   * retry boundary. The separate usage fold intentionally remains untouched so
   * first-token timing and committed usage span the retry wait. */
  private resetThinkingForRetry(turn: number, step: number): void {
    this.liveAssistantBlocks.delete(stepKey(turn, step))
    this.hideTransientAssistantEntry(turn, step)
    this.hideThinkingEntry(turn, step)
    const activity = this.activityByTurn.get(turn)
    if (activity === undefined) return
    if (!activity.settledSteps.has(step)) activity.firstVisibleAssistantTimes.delete(step)
    this.clearThinkingPreview(activity, step)
    const candidate = activity.messageCandidate
    if (candidate !== undefined && candidate.step === step
      && !activity.settledSteps.has(step) && !activity.confirmedSteps.has(step)) {
      activity.messageCandidate = undefined
      this.syncMessage(activity)
    }
    this.syncUsage(activity)
    activity.revision += 1
  }

  /** Settle only the thinking entries owned by one ended turn: the
   * authoritative `turn/end` time is their end (post-F6 plan §12.6). */
  private closeThinkingForTurn(turn: number, endedAt?: number): void {
    const open = this.openThinkingByTurn.get(turn)
    if (open === undefined) return
    for (const entry of open) this.closeThinking(entry, endedAt)
    this.openThinkingByTurn.delete(turn)
    const activity = this.activityByTurn.get(turn)
    if (activity?.thinkingStep !== undefined) this.markThinkSettled(activity, activity.thinkingStep)
  }

  /** The thinking entry object for one (turn, step), created on first
   * reasoning. The first accepted reasoning evidence's time is the row's
   * sidecar start (post-F6 plan §12.6). A retried REOPEN deletes the stale
   * sidecar and reuses the same entry object — the new attempt's first
   * chunk re-records the start here (first-wins: an entry that already has
   * timing keeps it). */
  private thinkingEntry(turn: number, step: number, startedAt?: number): Extract<TranscriptMessage, { kind: 'thinking' }> {
    const key = stepKey(turn, step)
    let entry = this.thinkingEntries.get(key)
    if (entry === undefined) {
      entry = { kind: 'thinking', turn, text: '', running: true }
      if (startedAt !== undefined) setTranscriptTiming(entry, { startedAt, running: true })
      this.thinkingEntries.set(key, entry)
      this.searchIndexByStepKey.set(`thinking:${key}`, this.appendItem(entry))
      let open = this.openThinkingByTurn.get(turn)
      if (open === undefined) {
        open = new Set()
        this.openThinkingByTurn.set(turn, open)
      }
      open.add(entry)
    } else if (startedAt !== undefined && transcriptTimingOf(entry) === undefined) {
      setTranscriptTiming(entry, { startedAt, running: true })
    }
    return entry
  }

  /** The assistant entry object for one (turn, step), created on first text. */
  private assistantEntry(turn: number, step: number): Extract<TranscriptMessage, { kind: 'assistant' }> {
    const key = stepKey(turn, step)
    let entry = this.assistantEntries.get(key)
    if (entry === undefined) {
      entry = { kind: 'assistant', turn, text: '' }
      rememberAssistantStep(entry, step)
      this.assistantEntries.set(key, entry)
      this.searchIndexByStepKey.set(`assistant:${key}`, this.appendItem(entry))
    }
    return entry
  }

  /**
   * Fold the compaction lifecycle (`compaction/start` → `compaction/summary`
   * → `compaction/end`) into ONE `kind: 'compaction'` card, paired by
   * compactionId. Start creates the running card; summary fills the body and
   * the shadowed item/token counts; end settles it (an `error` marks the
   * card failed). Events of an unknown compactionId (a summary/end without
   * a seen start — e.g. applied from a log fragment) create the card lazily
   * so a resumed session still shows its compaction records.
   */
  private applyCompactionEvent(
    event: { type: string; data: Record<string, unknown>; seq?: unknown; time: number },
    kind: string,
  ): void {
    const data = event.data as { compactionId?: unknown } & Record<string, unknown>
    // A seed boundary makes EVERY compaction/start still open at it STALE
    // (the upstream invariant — inheritedOrphanStartSeqs): all open cards
    // settle silently, never a forever-running "Compacting context…" on a
    // resumed session. Handled before the per-id lookup: an end-seed
    // carries no compactionId.
    if (kind === 'session/end-seed') {
      for (const [id, openIndex] of this.compacting) {
        const open = this.items[openIndex]
        if (open !== undefined && open.kind === 'compaction') open.running = false
        this.compacting.delete(id)
      }
      return
    }
    const compactionId = typeof data.compactionId === 'string' ? data.compactionId : undefined
    let index = compactionId === undefined ? undefined : this.compacting.get(compactionId)
    if (index === undefined) {
      const created: Extract<TranscriptMessage, { kind: 'compaction' }> = {
        kind: 'compaction', turn: this.currentTurn, text: '', items: 0, tokens: 0, running: true,
      }
      this.appendItem(created)
      index = this.items.length - 1
      // The compaction row's authoritative first-visible time closes any
      // preceding Activity at the moment the checkpoint appeared (the row is a
      // Context boundary; the point sidecar is display-only and never enters
      // the Process member walk).
      setTranscriptTiming(created, pointTiming(event.time))
      if (compactionId !== undefined) this.compacting.set(compactionId, index)
    }
    const entry = this.items[index]
    if (entry === undefined || entry.kind !== 'compaction') return
    if (kind === 'compaction/start') {
      entry.running = true
    } else if (kind === 'compaction/summary') {
      const summary = data.summary
      const seqs = data.shadowedSeqs
      const tokens = data.shadowedTokenCount
      if (Array.isArray(summary)) {
        entry.text = textOf(summary as readonly ContentBlock[])
        // The summary body became searchable: mark the entry dirty (lazy).
        this.markSearchEntryDirty(index)
      }
      if (Array.isArray(seqs)) entry.items = seqs.length
      if (typeof tokens === 'number') entry.tokens = tokens
    } else if (kind === 'compaction/end') {
      entry.running = false
      const error = data.error
      if (typeof error === 'string' && error !== '') entry.error = error
      if (compactionId !== undefined) this.compacting.delete(compactionId)
    }
    // Manual-compaction correlation evidence (post-PR166 plan §7): the
    // summary's event sequence is leg 2's direct lookup target, and a
    // lifecycle-carried `sourceCommandId` is leg 1. Both are recorded as
    // presentation metadata on the card, then any already-known command is
    // fused immediately — a lifecycle event may land after the command's own
    // `command/done`.
    const seq = Number(event.seq)
    if (kind === 'compaction/summary' && Number.isSafeInteger(seq) && seq >= 0) {
      entry.summaryEventSeq = seq as SessionEventSeq
      this.compactionBySummarySeq.set(seq as SessionEventSeq, index)
    }
    const sourceCommandId = data.sourceCommandId
    if (typeof sourceCommandId === 'string' && sourceCommandId !== '') {
      entry.sourceCommandId = sourceCommandId as CommandId
      this.compactionBySourceCommandId.set(entry.sourceCommandId, index)
    }
    if (entry.sourceCommandId !== undefined) {
      const command = this.commands.get(entry.sourceCommandId)
      if (command !== undefined) this.fuseCompactionCommand(command.message, command.index)
    }
  }

  /**
   * Fuse one command with its compaction card — establishing the ONE
   * combined manual-compaction owner (post-PR166 plan §7, official
   * `manual-compaction` node semantics). Leg 1 — the compaction lifecycle's
   * `sourceCommandId` — is the ownership AUTHORITY: the moment the official
   * event names the initiating command, the relationship is proven, so the
   * ownership is established immediately even while the command is still
   * running (never two visible cards for one manual compaction). Leg 2 — a
   * settled outcome's `sourceEventSeq` pointing at a `compaction/summary`
   * event — fuses only when no leg-1 declaration exists, and only when both
   * legs present must they agree: contradictions (including a leg-2 hit on a
   * card declaring a DIFFERENT command) fuse nothing, fail soft. An
   * established ownership is never re-decided or revoked by later evidence —
   * the fold never guesses a new winner — while the command's settlement
   * still refreshes the combined owner's search corpus (the command fields
   * live on the card's entry).
   */
  private fuseCompactionCommand(message: TranscriptCommandMessage, index: number): void {
    const ownedBy = this.compactionOwnerByCommandId.get(message.commandId)
    if (ownedBy !== undefined) {
      // Established combined owner: a settlement (outcome replaced) refreshes
      // the owner's corpus — the command name/args/outcome it now carries.
      this.markSearchEntryDirty(ownedBy)
      this.markSearchEntryDirty(index)
      return
    }
    const byCommandId = this.compactionBySourceCommandId.get(message.commandId)
    const bySourceEventSeq = message.outcome !== null && message.outcome.kind === 'success' && message.outcome.sourceEventSeq !== undefined
      ? this.compactionBySummarySeq.get(message.outcome.sourceEventSeq)
      : undefined
    if (byCommandId !== undefined && bySourceEventSeq !== undefined && byCommandId !== bySourceEventSeq) return
    const target = byCommandId ?? bySourceEventSeq
    if (target === undefined) return
    const compaction = this.items[target]
    if (compaction === undefined || compaction.kind !== 'compaction') return
    // Reverse-leg validation (plan §7.2): a leg-2 hit on a card that
    // EXPLICITLY declares a different initiating command contradicts the
    // official evidence — the card belongs to that command, not this one.
    // Fail soft: no fusion, no guess; both rows stay standalone.
    if (compaction.sourceCommandId !== undefined && compaction.sourceCommandId !== message.commandId) return
    compaction.sourceCommand = message
    this.fusedCommands.add(message)
    this.compactionOwnerByCommandId.set(message.commandId, target)
    // The combined owner INHERITS the command's placement anchor: the card is
    // the visible/searchable representative now, and its legacy `turn` (the
    // fold-time currentTurn, which never regresses for replays and is 0 for
    // a pre-turn manual compaction) must not steer the anchored window.
    const anchor = this.commandPlacementTurns.get(message)
    if (anchor !== undefined) this.setPlacementAnchor(message, index, anchor)
    // A fused owner whose legacy turn is a GHOST singleton (that turn's only
    // raw item is this very card — e.g. a pre-turn manual compaction
    // registering the initial currentTurn) drops the ghost turn
    // registration: the card is placement-anchored now, and the ghost would
    // otherwise claim the leading raw prefix and push the first REAL turn's
    // segment past it, hiding the card from the first-turn window.
    const ghostIndex = this.turnValues.indexOf(compaction.turn)
    if (ghostIndex >= 0 && this.turnStarts[ghostIndex] === target
      && this.activityByTurn.get(compaction.turn)?.startedAt === undefined
      && (ghostIndex + 1 >= this.turnStarts.length || this.turnStarts[ghostIndex + 1]! === target + 1)) {
      this.turnValues.splice(ghostIndex, 1)
      this.turnStarts.splice(ghostIndex, 1)
      this.turnValueSet.delete(compaction.turn)
      this.removeGroupedTurn(compaction.turn)
    }
    // The card's corpus now carries the command fields and the raw command
    // entry stops producing hits — both entries re-normalize lazily.
    this.markSearchEntryDirty(target)
    this.markSearchEntryDirty(index)
  }

  /** Fold the structural durable payload emitted by the present tool. The
   * event is the only source of delivery facts; tool-result text is never
   * reverse-parsed. Invalid file entries are ignored at this event boundary,
   * while valid entries retain their event sequence and source order. */
  private applyPresentedEvent(event: SessionEvent): void {
    const data = event.data as unknown
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return
    const value = data as Record<string, unknown>
    if (typeof value.turn !== 'number' || !Number.isSafeInteger(value.turn) || value.turn < 1) return
    if (typeof value.callId !== 'string' || value.callId.length === 0 || !Array.isArray(value.files)) return
    if (this.activityByTurn.get(value.turn)?.completed === true) return
    const declarations = this.deliverableDeclarationsByTurn.get(value.turn) ?? []
    const seq = Number(event.seq)
    if (!Number.isSafeInteger(seq) || seq < 0) return
    for (const file of value.files) {
      if (typeof file !== 'object' || file === null || Array.isArray(file)) continue
      const entry = file as Record<string, unknown>
      if (typeof entry.path !== 'string' || entry.path.trim() === '') continue
      if (entry.description !== undefined && typeof entry.description !== 'string') continue
      declarations.push({
        path: entry.path,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        seq,
      })
    }
    if (declarations.length > 0) this.deliverableDeclarationsByTurn.set(value.turn, declarations)
  }

  /** Attach declarations before the closing assistant's durable sequence,
   * preserving first-seen path order while letting the latest valid
   * declaration replace its description. */
  private attachDeliverablesToClosingAssistant(turn: number): void {
    const activity = this.activityByTurn.get(turn)
    const step = activity?.lastAssistantStep
    if (step === undefined) return
    const key = stepKey(turn, step)
    const assistant = this.assistantEntries.get(key)
    const closingSeq = this.assistantSettlementSeqs.get(key)
    if (assistant === undefined || closingSeq === undefined) return
    const declarations = this.deliverableDeclarationsByTurn.get(turn)
    if (declarations === undefined) return
    const files = new Map<string, PresentedFilePresentation>()
    for (const declaration of declarations) {
      if (declaration.seq >= closingSeq) continue
      files.set(declaration.path, {
        path: declaration.path,
        ...(declaration.description === undefined ? {} : { description: declaration.description }),
      })
    }
    if (files.size === 0) return
    const wasVisible = this.isVisible(assistant)
    assistant.deliverables = [...files.values()]
    bumpAssistantPresentationRevision(assistant)
    this.markStreamingEntryDirty(`assistant:${key}`)
    // Deliverables make an otherwise empty closing assistant a visible
    // transcript surface without inventing a second message. Keep the Focus
    // final-selection flag and grouped-turn index in sync with that transition.
    this.syncAssistantVisibility(turn, step, assistant, wasVisible, false)
    if (activity !== undefined) activity.lastAssistantVisible = true
  }

  private applyEvent(event: SessionEvent): void {
    // The human transcript keeps append-origin history. Surface
    // replacements are model-only rewrites (tool-result pruning,
    // compaction summary checkpoints) and must never be replayed as new
    // visible messages or mutate any projection (items, Focus activity,
    // tool counts, grouping, usage). Replaced history may ALSO arrive as
    // user/message or assistant/message, so this is a unified gate before
    // the compaction lifecycle and the switch — not a per-case guard.
    // Only an EXPLICIT replacement is filtered; unmarked legacy events
    // keep their current behavior (no surfaceOp = not a surface event at
    // all — the helper requires the event type AND the marker).
    if (isReplacementSurfaceEvent(event)) {
      if (event.type === 'user/message') this.claimedNextStepTurns.delete(event.data.id)
      return
    }
    // Compaction lifecycle events are typed STRUCTURALLY: dsh-compaction
    // is not a peer dependency, so its session-event augmentation never
    // enters our type graph (the same pattern as the structural service
    // types). An unknown event type is otherwise skipped by the switch.
    const kind = event.type as string
    if (kind === 'deliverables/presented') {
      this.applyPresentedEvent(event)
      return
    }
    if (kind === 'agent/inbox/spliced') {
      const data = event.data as {
        target: 'next-turn' | 'next-step'
        start: number
        removedCount?: number
        inserted: readonly { id: string }[]
        outcome?: 'canceled'
      }
      const inserted = data.inserted.map(message => ({ id: message.id, insertionTurn: this.openTurn, insertionTime: event.time }))
      let removed: NextStepInboxIdentity[] = []
      if (data.target === 'next-step') {
        removed = this.pendingNextSteps.splice(
          data.start,
          data.removedCount ?? 0,
          ...inserted,
        )
      }
      for (const { id } of inserted) this.claimedNextStepTurns.delete(id)
      if (data.target === 'next-step' && data.outcome !== 'canceled') {
        for (const identity of removed) this.claimedNextStepTurns.set(identity.id, identity)
      }
      return
    }
    if (kind === 'compaction/start' || kind === 'compaction/summary' || kind === 'compaction/end' || kind === 'session/end-seed') {
      this.applyCompactionEvent(event as { type: string; data: Record<string, unknown>; seq?: unknown; time: number }, kind)
      return
    }
    if (kind === 'llm/retry-started') {
      const data = event.data as { turn: number; step: number }
      if (this.activityByTurn.get(data.turn)?.completed === true) return
      // This event only closes the usage replacement slot. Presentation was
      // reset at the earlier scheduled `llm/retry` boundary. Keeping the two
      // boundaries separate preserves the first-token timing across the wait.
      this.usage.onRetryStarted(data.turn, data.step)
      return
    }
    // `assistant/attempt` is a Session v2 durable settlement (master
    // vocabulary — the installed dsh-session may lag, so it is typed
    // structurally). It has no settled surface message, but its complete
    // stream remains interruption evidence until a retry resets it or the
    // turn closes. Usage is folded independently from the stream.
    if (kind === 'assistant/attempt') {
      const data = event.data as { turn: number; step: number; stream?: readonly unknown[] }
      const existingActivity = this.activityByTurn.get(data.turn)
      if (existingActivity?.completed === true) return
      // An authoritative assistant/message owns this step permanently; a
      // later attempt replay must not turn the settled row back into a
      // transient/open presentation. Its usage is still folded independently
      // below so Focus and Stats keep the same late-fact policy.
      const alreadySettled = existingActivity?.settledSteps.has(data.step) === true
      const key = stepKey(data.turn, data.step)
      // Whether the step already had a stored durable lane authority: a
      // REPLACEMENT attempt (one existed) is newer authoritative evidence
      // and may converge the lane topology; a FIRST attempt preserves the
      // live chronology anchor (§4.5 — the message path's same rule).
      const hadLaneAuthority = this.stepLaneOrders.has(key)
      const stream = data.stream ?? []
      this.liveAssistantBlocks.delete(key)
      // One durable stream projection per settlement: lane order, restored
      // reasoning and usage come from the same pass (plan §4.4/§12.5).
      const projection = this.assistantStreamProjection(stream, data.turn, data.step)
      this.absorbPreparingStarts(projection.toolCallStarts, data.turn, data.step)
      if (!alreadySettled) {
        // Store/refresh the step's lane authority from the attempt; a later
        // message settlement (higher authority) overwrites it.
        if (projection.firstLane !== undefined) {
          this.stepLaneOrders.set(key, projection.firstLane)
        }
        // The durable embedded stream is COMPLETE and authoritative for
        // reasoning; restore the first lane before the other one so cold
        // replay preserves the live Thinking → Assistant / Assistant →
        // Thinking order.
        if (projection.firstLane === 'thinking') this.restoreThinkingFromProjection(data.turn, data.step, projection)
        this.restoreAssistantAttempt(data.turn, data.step, projection)
      }
      this.usage.onAssistantAttempt(data.turn, data.step, projection.usage)
      const activity = this.activityFor(data.turn)
      if (!alreadySettled && projection.firstLane !== 'thinking') {
        this.restoreThinkingFromProjection(data.turn, data.step, projection)
      }
      // A replacement durable attempt is newer authoritative evidence: after
      // both lanes are restored, converge their display order to the just-
      // stored authority (same model as the message path's replacement rule —
      // without this, attempt B's topology flip would never reach the rows
      // and would even survive into the final message settlement via the
      // §4.5 first-settlement gate).
      if (!alreadySettled && hadLaneAuthority && projection.firstLane !== undefined) {
        this.convergeStepLaneOrder(data.turn, data.step)
      }
      this.syncUsage(activity)
      const thinking = this.thinkingEntries.get(key)
      if (thinking !== undefined && thinking.running) this.closeThinking(thinking)
      this.markThinkSettled(activity, data.step)
      activity.revision += 1
      return
    }
    switch (event.type) {
      case 'step/start': {
        // Focus aggregation: a new step opens usage accounting, and a
        // still-open candidate of an EARLIER step is confirmed (the turn
        // continues — plan §5.3 B). After turn/end the turn's steps were
        // finalized: a late step/start (replay artifact) must not reopen
        // accumulator state (review finding).
        const activity = this.activityFor(event.data.turn)
        if (activity.completed) break
        activity.pendingPreSteerAnswerStep = undefined
        const previousStep = event.data.step - 1
        if (activity.lastAssistantStep === previousStep
          && activity.settledSteps.has(previousStep)) {
          const previous = this.assistantEntries.get(stepKey(event.data.turn, previousStep))
          if (previous !== undefined && previous.interrupted !== true) {
            const blocks = assistantEntryBlocks(previous)
            const visible = assistantBlocksVisibleNow(blocks)
            const hasToolCall = blocks.some(block => block.type === 'tool-call')
            if (visible && !hasToolCall) activity.pendingPreSteerAnswerStep = previousStep
          }
        }
        this.usage.onStepStart(event.data.turn, event.data.step)
        // Owner lifecycle: the step is now open (plan §5.1). Guarded by the
        // same replay fence as the usage accounting — a late step/start
        // after turn/end must not reopen the step for owner capture.
        this.workflow.onStepStart(event.data.turn, event.data.step)
        const candidate = activity.messageCandidate
        if (candidate !== undefined && candidate.step < event.data.step) {
          this.confirmMessageCandidate(activity)
          this.syncMessage(activity)
          activity.revision += 1
        }
        break
      }
      case 'step/end': {
        // Focus aggregation: commit the step's usage ONCE and drop the
        // open state (the accumulator's contract — a later chunk for the
        // closed step is a settled fact, never swallowed by
        // first-chunk-wins). The visible total is unchanged, so the
        // revision only moves when the display value actually changed.
        // After turn/end the turn's open steps were already finalized:
        // a late step/end (replay artifact) is a no-op (review finding).
        const activity = this.activityFor(event.data.turn)
        if (activity.completed) break
        // A failed attempt closes at step/end even when the turn continues;
        // expose its preserved evidence without waiting for turn/end.
        this.markAttemptEvidenceInterrupted(event.data.turn, event.data.step)
        // The step's preparing evidence is dead with the attempt: a later
        // attempt reusing the identity must not inherit its timer.
        this.clearPreparingStartsForStep(event.data.turn, event.data.step)
        this.usage.onStepEnd(event.data.turn, event.data.step)
        this.syncUsage(activity)
        // Owner lifecycle: the step closed — clear the matching open step
        // and project interrupted for step-owned Workflow runs without a
        // terminal fact (plan §5.1/§5.3).
        this.workflow.onStepEnd(event.data.turn, event.data.step)
        break
      }
      case 'turn/start': {
        // Monotonic: a replayed turn/start for an OLDER turn must never
        // regress the current turn (turn-less events would land in the
        // wrong turn — review finding).
        this.currentTurn = Math.max(this.currentTurn, event.data.turn)
        // Advance the shared usage accounting: a delayed fact for the
        // prior turn becomes stale once the next turn starts (review
        // finding).
        this.usage.onTurnStart(event.data.turn)
        // Focus aggregation: turn timing comes from `SessionEvent.time`
        // (plan §10.1) — never a second clock. Idempotent: a replayed
        // turn/start for an already-finalized (or already-started) turn
        // must not resurrect it (review finding).
        const activity = this.activityFor(event.data.turn)
        if (activity.completed || activity.startedAt !== undefined) break
        activity.startedAt = event.time
        // Only an ACCEPTED turn/start adopts the leading standalone prefix:
        // a replayed start for an already-finalized (or already-open) turn
        // breaks above and must not consume the pending anchors — the first
        // REAL turn owns the prefix (round-5 review finding).
        this.adoptLeadingAnchors(event.data.turn)
        activity.completed = false
        activity.reason = undefined
        if (event.data.turn === this.currentTurn) {
          this.openTurn = event.data.turn
          this.workflow.onTurnStart(event.data.turn)
        }
        activity.revision += 1
        break
      }
      case 'user/message': {
        const claimedIdentity = this.claimedNextStepTurns.get(event.data.id)
        const wasClaimedFromNextStep = this.claimedNextStepTurns.delete(event.data.id)
        // Only a next-step identity inserted during this admission turn is a
        // mid-turn steer; an idle wake or a claim carried across turns is an
        // ordinary opening/follow-up user message.
        const isMidTurnSteer = wasClaimedFromNextStep
          && claimedIdentity !== undefined
          && claimedIdentity.insertionTurn === this.currentTurn
        const blocks = event.data.content
        // User messages keep known attachment markers at their original
        // positions in the FLAT text; the ordered `content` blocks stay the
        // canonical form for rich rendering. A finalized non-text block is
        // human-visible content for a direct user prompt even when the
        // lightweight projection is empty, so a future block cannot disappear.
        const text = textWithAttachmentMarkers(blocks)
        // Only direct human prompts use the generalized finalized-content
        // predicate. Injected context keeps its text-only empty gate: a
        // process block must not turn into an empty system row. The source
        // kind is read through the SINGLE context parser, so a restored or
        // foreign log that records a null/undefined/non-object source folds
        // as standalone injected Context instead of crashing the whole fold.
        const sourcePresentation = contextPresentation(event.data.source)
        if (sourcePresentation.sourceKind === 'user') {
          if (!userBlocksVisibleNow(blocks)) break
          const activity = this.activityFor(this.currentTurn)
          if (activity.pendingPreSteerAnswerStep !== undefined) {
            const firstVisible = activity.firstVisibleAssistantTimes.get(activity.pendingPreSteerAnswerStep)
            // Keep an early same-turn steer pending for a later message in
            // the same admitted next-step batch.
            if (isMidTurnSteer
               && claimedIdentity !== undefined
               && firstVisible !== undefined
               && firstVisible < claimedIdentity.insertionTime) this.commitPreSteerAnswer(activity)
            else if (!isMidTurnSteer) activity.pendingPreSteerAnswerStep = undefined
          }
          const userRow: Extract<TranscriptMessage, { kind: 'user' }> = {
            kind: 'user',
            turn: this.currentTurn,
            text,
            content: blocks,
            ...(isMidTurnSteer ? { steer: true as const } : {}),
          }
          this.appendItem(userRow)
          // The Conversation boundary's OWN first-actually-visible time: the
          // authoritative event time, never a later settlement/arrival. It only
          // tells an Activity where to close — the row's semantic class is
          // untouched and the point sidecar never joins a Work span.
          setTranscriptTiming(userRow, pointTiming(event.time))
        } else {
          if (text === '') break
          // Injected context: name the producer the way the Web row does
          // (contextProvenance), plus a notice form's one-line account. The
          // fold stores the icon SEMANTIC (never the concrete glyph), so a
          // live icon-style switch repaints already-folded cards.
          const provenance = contextProvenance(event.data.source)
          const summary = contextSummary(event.data.source)
          const contextRow: Extract<TranscriptMessage, { kind: 'system' }> = {
            kind: 'system',
            turn: this.currentTurn,
            text,
            ...provenance.label === null ? {} : { label: provenance.label },
            ...summary === null ? {} : { summary },
            icon: contextIconSemantic(event.data.source),
            // The source-derived semantic marker: this row IS injected
            // context (never orchestration like llm/retry or max-tokens),
            // so Focus may treat it as turn foundation.
            context: true as const,
            // Presentation-only provenance (form/kind/sender) for the
            // form-aware Context roles Compact and Focus present. The
            // semantic marker above stays the surfaced authority.
            contextPresentation: sourcePresentation,
          }
          this.appendItem(contextRow)
          // The Context boundary's own first-visible time (the same
          // authoritative event time): Work B starts from its own members, so
          // this only freezes the preceding Activity.
          setTranscriptTiming(contextRow, pointTiming(event.time))
          // Focus aggregation: injected context (skill-invocation,
          // skill-catalog, system reminders) is orchestration, NOT one of
          // the three process slots — it never enters Think/Message/Tool
          // (plan §16).
        }
        break
      }
      case 'assistant/message': {
        // After turn/end a late message is a replay artifact: reject it
        // BEFORE mutating the transcript entries — the final-answer
        // selection reads the exact last assistant (review finding).
        const activity = this.activityFor(event.data.turn)
        if (activity.completed) break
        const key = stepKey(event.data.turn, event.data.step)
        this.assistantSettlementSeqs.set(key, Number(event.seq))
        const priorLast = activity.lastAssistantStep ?? -1
        const entry = this.assistantEntries.get(key)
        // A durable assistant/message is always a transcript surface fact.
        // A stale step may not own Focus final selection, but it must remain
        // available in the ordinary transcript and search projections.
        this.liveAssistantBlocks.delete(key)
        // Decode the durable embedded stream ONCE for this settlement: the
        // lane chronology authority, the restored Thinking text, the
        // first-visible reply time and the usage all come from the same
        // projection (post-F6 plan §4.4 — the one durable step projection
        // shared by message and attempt settlements).
        const projection = event.data.stream !== undefined && event.data.stream.length > 0
          ? this.assistantStreamProjection(event.data.stream, event.data.turn, event.data.step)
          : undefined
        if (projection !== undefined) this.absorbPreparingStarts(projection.toolCallStarts, event.data.turn, event.data.step)
        const messageUsage = event.data.usage ?? projection?.usage
        const alreadySettled = activity.settledSteps.has(event.data.step)
        const messageBlocks = event.data.message.content
        const text = textOf(messageBlocks)
        // Durable assistant tool-call blocks are REQUESTED tool identity
        // (TOOL_NOT_STARTED compat): remember each request so a later
        // not-started recovery result can name the tool without inventing
        // a call. The finalized durable blocks are the authority — never
        // display text, never the embedded stream.
        for (const block of messageBlocks) {
          if (block.type !== 'tool-call') continue
          this.requestedToolCalls.set(toolCallKey(event.data.turn, event.data.step, block.id), {
            turn: event.data.turn,
            step: event.data.step,
            name: block.name,
          })
        }
        const firstVisible = projection?.firstVisibleAt
        if (firstVisible === undefined) activity.firstVisibleAssistantTimes.delete(event.data.step)
        else activity.firstVisibleAssistantTimes.set(event.data.step, firstVisible)
        // The step's durable evidence owns its lane chronology (§4.3): store
        // it so this and later settlements (same-step replacement) and late
        // diagnostic reasoning place lanes by AUTHORITY — row existence
        // proves nothing about chronology ownership.
        const laneOrder = this.durableLaneOrder(projection, messageBlocks)
        if (laneOrder !== undefined) this.stepLaneOrders.set(key, laneOrder)
        const wasVisible = entry !== undefined && this.isVisible(entry)
        // Whether the Thinking row predates this settlement: a row that
        // already existed (live reasoning stream / earlier attempt restore)
        // anchors the live chronology — §4.5 keeps it in place on the FIRST
        // settlement. A REPLACEMENT settlement (alreadySettled) is newer
        // authoritative evidence and owns the topology.
        const thinkingRowPreExisting = this.thinkingEntries.get(key) !== undefined
        if (entry !== undefined) {
          rememberAssistantStep(entry, event.data.step)
          entry.text = text
          // The durable message takes over the live/attempt entry: it is no
          // longer transient, so retry cleanup can never remove settled text.
          this.transientAssistantEntries.delete(entry)
          this.attemptAssistantEntries.delete(entry)
          entry.displayBlocks = undefined
          entry.interrupted = event.data.interrupted === true ? true : undefined
          // The settled full blocks replace any earlier attempt evidence;
          // text-only messages must also clear stale non-text content.
          entry.content = messageBlocks.some(block => block.type !== 'text') ? messageBlocks : undefined
          // The settled text REPLACES the streamed tail: the search
          // projection must mirror the authoritative text, not the chunks
          // (lazy — mark dirty, O(1)).
          const searchIndex = this.searchIndexByStepKey.get(`assistant:${key}`)
          if (searchIndex !== undefined) this.markSearchEntryDirty(searchIndex)
        } else {
          // ALWAYS preserve the durable entry — including an empty message
          // and an older step with no preceding chunk. Focus ownership is
          // fenced separately below; it must never delete a real settlement.
          const created: Extract<TranscriptMessage, { kind: 'assistant' }> = {
            kind: 'assistant',
            turn: event.data.turn,
            text,
            ...(messageBlocks.some(block => block.type !== 'text') ? { content: messageBlocks } : {}),
            ...(event.data.interrupted === true ? { interrupted: true as const } : {}),
          }
          rememberAssistantStep(created, event.data.step)
          this.assistantEntries.set(key, created)
          // The created entry must register its search index too: a later
          // replay replacement or text delta mutates this entry in place
          // and must be able to refresh its searchable entry (review
          // finding — the streaming-created path already registers).
          this.searchIndexByStepKey.set(`assistant:${key}`, this.appendItem(created))
        }
        const settledEntry = this.assistantEntries.get(key)
        if (settledEntry !== undefined) this.syncAssistantVisibility(event.data.turn, event.data.step, settledEntry, wasVisible, false)
        // The durable settlement re-affirms the SAME boundary the live lane
        // recorded (a cold hydration has only this evidence); the earliest
        // proven time wins, so a replacement settlement never regresses it. A
        // VISIBLE streamless settlement contributes its own settlement time as
        // the last provable boundary — an invisible one proves no Conversation
        // row and contributes nothing.
        this.recordAssistantVisibleTime(
          event.data.turn,
          event.data.step,
          settledEntry !== undefined && this.isVisible(settledEntry) ? event.time : undefined,
        )
        // The step is complete: its thinking entry stops streaming and leaves
        // the open-lifecycle index, so a later turn/end never revisits it.
        // On a COLD replay no live reasoning deltas ever arrived — the
        // reasoning restored here comes from the step's durable evidence
        // (embedded stream primary, assembled content fallback; Session v2
        // embedded-stream parity).
        this.restoreThinkingFromMessage(event.data.turn, event.data.step, projection, messageBlocks)
        // Then converge the step's lanes to the stored authority: a lane row
        // materialized out of order (missing-lane replay, same-step
        // replacement flipping the topology) is relocated HERE at the
        // canonical owner — never in a preset projection (plan §4.7). A
        // pre-existing Thinking row on a first settlement anchored the live
        // chronology and is left in place (§4.5).
        if (alreadySettled || !thinkingRowPreExisting) {
          this.convergeStepLaneOrder(event.data.turn, event.data.step)
        }
        // Converge this step's Tool rows around the Assistant anchor from the
        // SAME durable stream evidence (idempotent on repeated settlements).
        this.convergeStepToolOrder(event.data.turn, event.data.step, projection, messageBlocks)
        // Focus aggregation: the settled assistant text OVERWRITES the
        // candidate's text (authoritative — plan §5.4) but does NOT decide
        // whether it is the final answer; the candidate keeps its step
        // identity and the turn/end resolution decides. The final answer
        // never enters the Message slot (plan §22).
        // Count one settled output per step; a late duplicate may replace the
        // transcript text but must not inflate Focus activity.
        if (!alreadySettled) activity.assistantMessages += 1
        // Every accepted authoritative message settles its step's output —
        // EMPTY and image-only messages included: a later text-delta for
        // it is a replay artifact and must never resurrect a preview
        // (review finding).
        activity.settledSteps.add(event.data.step)
        const staleForFocus = event.data.step < priorLast
        if (!staleForFocus) {
          // A message of a DIFFERENT step than the open candidate proves the
          // earlier step's output was intermediate: confirm it first (plan
          // §5.3 C — a later step's output confirms the earlier candidate).
          activity.lastAssistantVisible = event.data.interrupted === true || assistantBlocksVisibleNow(messageBlocks)
        }
        // Monotonic: a late event for an older step never regresses the
        // last assistant step — the final-answer dedup depends on it
        // (review finding).
        activity.lastAssistantStep = Math.max(priorLast, event.data.step)
        if (staleForFocus) {
          // A stale durable settlement cannot reclaim candidate or final
          // ownership. It may still update the confirmed slot when that exact
          // step already owns the displayed intermediate message: the
          // authoritative text must replace the streamed preview in place.
          if (activity.messageConfirmedStep === event.data.step) {
            activity.messageConfirmed = text === ''
              ? undefined
              : text.slice(-TranscriptFolder.MESSAGE_TAIL_CAP)
          }
        } else {
          const prior = activity.messageCandidate
          // Only a message for a NEWER step confirms the open candidate
          // (plan §5.3 C); a message for an older step is stale and must
          // never confirm a still-streaming candidate (review finding).
          if (prior !== undefined && prior.step < event.data.step) {
            this.confirmMessageCandidate(activity)
          }
          const candidate = activity.messageCandidate
          if (candidate !== undefined && candidate.step === event.data.step) {
            // The authoritative text replaces the streaming tail — bounded
            // to the tail cap, never a second full copy of the assistant
            // output (plan §34 — the transcript entry owns the full text).
            candidate.tail = text.slice(-TranscriptFolder.MESSAGE_TAIL_CAP)
          } else if (activity.messageConfirmedStep === event.data.step) {
            // The step's candidate was already confirmed (a tool/call
            // followed the text) and it is still the LATEST confirmed: the
            // authoritative message updates the confirmed text IN PLACE —
            // never a stale streamed fragment, never a resurrected
            // candidate (review finding). An EMPTY authoritative text
            // clears the confirmed text (the slot shows nothing — the stale
            // streamed fragment must not survive).
            activity.messageConfirmed = text === ''
              ? undefined
              : text.slice(-TranscriptFolder.MESSAGE_TAIL_CAP)
          } else if (activity.confirmedSteps.has(event.data.step)) {
            // A late message for an OLDER confirmed step: the slot already
            // shows a newer intermediate — ignore it entirely.
          } else if (text !== '' && !activity.completed) {
            // A settled message without a prior candidate (replay edge): the
            // authoritative text IS the step's output — it becomes the
            // candidate so a later continuation still confirms it as an
            // intermediate message (the LATEST intermediate wins, plan §5.6).
            // After turn/end the final was already resolved: a late message
            // must never resurrect a candidate (review finding).
            activity.messageCandidate = {
              step: event.data.step,
              tail: text.slice(-TranscriptFolder.MESSAGE_TAIL_CAP),
            }
          }
        }
        this.syncMessage(activity)
        this.usage.onAssistantMessage(event.data.turn, event.data.step, messageUsage)
        // Settled Assistant visibility was synchronized above without deleting its authoritative entry.
        this.syncUsage(activity)
        activity.revision += 1
        break
      }
      case 'tool/call': {
        const key = event.data.callId
        // Read the durable request identity BEFORE this branch consumes it: it is
        // this call's ownership proof for the reverse convergence direction.
        const requestKey = toolCallKey(event.data.turn, event.data.step, key)
        const requestedForStep = this.requestedToolCalls.get(requestKey)
        this.callNames.set(key, event.data.name)
        // The request started: its identity is no longer unresolved. A
        // later TOOL_NOT_STARTED-coded result for this id would be a
        // malformed contradiction, not a not-started request.
        this.requestedToolCalls.delete(requestKey)
        // The call's OWN turn (event.data.turn) — never this.currentTurn:
        // a turn-start-less replay fragment must still attribute the call
        // to the right turn (review finding).
        const callTurn = event.data.turn
        const card: TranscriptMessage = {
          kind: 'tool',
          turn: callTurn,
          callId: key,
          name: event.data.name,
          args: event.data.arguments,
          result: '',
          status: 'running',
          // Genuine model tool/call provenance (post-F6 plan §10.2): the
          // span `tools` stat and the Tool-slot ownership read THIS, never
          // the projected card shape.
          callCount: 1,
        }
        // The call's wall span starts at its earliest authoritative
        // evidence: the first streamed arguments delta when the call was
        // preparing, else the tool/call event (post-F6 plan §12.7/§12.14 —
        // never a Preparing → durable elapsed reset).
        // The cache key IS the durable (turn, step, callId) identity, so a call id
        // reused by another step or turn can neither supply nor block this card's
        // Preparing evidence.
        const preparingKey = toolCallKey(callTurn, event.data.step, key)
        const provedByStream = this.toolCallPreparingStarts.has(preparingKey)
        const preparingStart = this.toolCallPreparingStarts.get(preparingKey)
        if (preparingStart !== undefined) this.toolCallPreparingStarts.delete(preparingKey)
        setTranscriptTiming(card, {
          startedAt: preparingStart === undefined ? event.time : Math.min(preparingStart.at, event.time),
          running: true,
        })
        // Post-turn replay provenance: this card is NEWLY materialized, so if
        // its owning turn already ended it is transcript/diagnostic evidence
        // only (read the map BEFORE `activityFor` below can create a fresh,
        // non-completed activity for the turn).
        if (this.activityByTurn.get(callTurn)?.completed === true) markPostTurnReplayEvidence(card)
        this.appendItem(card)
        // Long-lived identity for the display-order convergence: the card's raw
        // index by call id (its object identity is re-verified before use).
        // `pendingCalls` cannot serve here — it is deleted once the call
        // settles.
        this.toolCardIndexOf.set(toolCallKey(callTurn, event.data.step, key), this.items.length - 1)
        // The durable payload carries this call's OWN step: converge the row
        // against a step Assistant row that settled BEFORE this call arrived —
        // the mirror direction of the settlement-side convergence (either side
        // can be the one that arrives last). Only a call this step's OWN evidence
        // owns may be reordered: a streamed Preparing delta for THIS (turn, step)
        // or a durable message block that requested it.
        if (provedByStream || requestedForStep !== undefined) {
          this.convergeToolRowAgainstAnchor(callTurn, event.data.step, key)
        }
        this.pendingCalls.set(key, {
          name: event.data.name,
          args: event.data.arguments,
          turn: callTurn,
          card,
          index: this.items.length - 1,
        })
        // PTC replay fragments may have parked sub-call starts/settles for
        // this call before its tool/call arrived; connect them now.
        this.attachPendingOrphans(card, key)
        // Focus aggregation: count calls ONLY here (a call/result pair is
        // ONE call — plan §10.4), confirm the current message candidate
        // (a tool call after text proves the text was intermediate — plan
        // §5.3 A), and set the Tool slot from the RAW call — ANY name,
        // known or custom, is a Tool (event-first classification, plan
        // §6.1 — never a name allowlist).
        const activity = this.activityFor(callTurn)
        // After turn/end the turn's summary was settled: a late tool/call
        // (replay artifact) must not mutate the Focus counts or the Tool
        // slot (review finding). The transcript card still folds.
        if (!activity.completed) {
          // A surfaced-interaction tool call (question / Plan review) is
          // human-decision evidence, not ordinary work: it never increments
          // the turn's tool count, never appears in the tool-type stats, and
          // never owns the latest-meaningful-Tool slot. It still confirms the
          // message candidate below (a real step boundary), so final answer
          // selection is unchanged.
          if (!isSurfacedInteractionToolName(event.data.name)) {
            activity.toolCalls += 1
            activity.tools.set(event.data.name, (activity.tools.get(event.data.name) ?? 0) + 1)
            activity.tool = {
              callId: event.data.callId,
              name: event.data.name,
              args: event.data.arguments,
              status: 'running',
            }
          }
          this.confirmMessageCandidate(activity)
          this.syncMessage(activity)
          activity.revision += 1
        }
        break
      }
      case 'tool/result': {
        // Session V4: the durable event carries a first-class tool-role
        // message. The call identity is `message.toolCallId` (the value
        // official admission keeps equal to `source.callId`), the content is
        // the direct structured result, and `message.isError` is the only
        // durable outcome authority (`event.data.error` remains optional
        // presentation detail).
        const message = event.data.message
        const key = message.toolCallId
        const pending = this.pendingCalls.get(key)
        // The unresolved assistant request identity, read BEFORE the
        // consumption deletions below: only a result with NO observed
        // tool/call can be a not-started recovery (the `pending ===
        // undefined` guard keeps a malformed contradictory log from
        // rewriting an actually observed call as not started).
        // The result's OWN step keys the request: a request another step made for
        // the same call id is never this result's authority.
        const notStartedRequest = pending === undefined
          ? this.requestedToolCalls.get(toolCallKey(event.data.turn, event.data.step, key))
          : undefined
        const name = this.callNames.get(key) ?? 'tool'
        const text = textOf(message.content)
        const status = message.isError === true ? 'error' : 'ok'
        // The result's OWN turn (event.data.turn) when no pending call
        // pairs it — never this.currentTurn: an orphan result of a replay
        // fragment must not land in the stale current turn (review
        // finding).
        const turn = pending?.turn ?? event.data.turn
        this.pendingCalls.delete(key)
        this.callNames.delete(key)
        this.requestedToolCalls.delete(toolCallKey(event.data.turn, event.data.step, key))
        if (pending !== undefined) {
          // The call's own running card: parallel same-name calls pair
          // correctly because the card is keyed by callId, not by name.
          const card = pending.card
          card.status = status
          card.result = text
          card.args = pending.args
          card.turn = turn
          // The paired result is the card's authoritative end (post-F6 plan
          // §12.7).
          settleToolTiming(card, event.time)
          // Raw result data for the tool-owned presentation (presentResult).
          card.resultBlocks = message.content
          card.meta = event.data.meta
          card.error = event.data.error
          // The result text landed: mark the search entry dirty (lazy
          // normalization; the grouping hooks below mark the merged
          // representative when the read joins a group).
          this.markSearchEntryDirty(pending.index)
          // A settled read may now be groupable: reflow the run it belongs
          // to (bounded by the nearest non-read cards).
          this.scheduleGrouping(pending.index)
        } else if (event.data.error?.code === TOOL_NOT_STARTED) {
          // The official crash-recovery/fork-seed closer for a request
          // that never reached a durable `tool/call`: standalone
          // not-started diagnostic evidence (attention), never an
          // executed Tool and never an orphan Action. The recovered name
          // is accepted ONLY under the full fence — call id + same turn +
          // same step — so a reused id from another step/turn cannot
          // donate an identity; anything less degrades to the generic
          // diagnostic, never a guess.
          const recovered = notStartedRequest !== undefined
            && notStartedRequest.turn === event.data.turn
            && notStartedRequest.step === event.data.step
            ? notStartedRequest.name : undefined
          const card: Extract<TranscriptMessage, { kind: 'tool' }> = {
            kind: 'tool',
            turn,
            name: recovered ?? 'tool',
            args: '',
            result: text,
            status: 'error',
            resultBlocks: message.content,
            meta: event.data.meta,
            error: event.data.error,
            origin: 'tool-not-started',
          }
          // No synthetic tool/call: explicit zero-call provenance.
          card.callCount = 0
          setTranscriptTiming(card, pointTiming(event.time))
          // This diagnostic card is NEWLY materialized: if its owning turn
          // already ended, it is post-turn replay evidence.
          if (this.activityByTurn.get(turn)?.completed === true) markPostTurnReplayEvidence(card)
          this.appendItem(card)
          this.scheduleGrouping(this.items.length - 1)
        } else {
          // Unknown call (e.g. post-compaction): fall back to the last
          // running card with this name IN THE RESULT'S OWN TURN — an
          // orphan result must never settle a running card of another
          // turn (review finding).
          const runningIndex = this.items.findLastIndex(message => message.kind === 'tool' && message.name === name && message.status === 'running' && message.turn === turn)
          if (runningIndex !== -1) {
            const running = this.items[runningIndex]!
            if (running.kind === 'tool') {
              running.status = status
              running.result = text
              running.args = ''
              running.turn = turn
              settleToolTiming(running, event.time)
              running.resultBlocks = message.content
              running.meta = event.data.meta
              running.error = event.data.error
              this.markSearchEntryDirty(runningIndex)
              this.scheduleGrouping(runningIndex)
            }
          } else {
            const card: Extract<TranscriptMessage, { kind: 'tool' }> = { kind: 'tool', turn, name, args: '', result: text, status, resultBlocks: message.content, meta: event.data.meta, error: event.data.error }
            // An orphan settle has NO seen tool/call: explicit zero-call
            // provenance — it must neither inflate `tools` nor own the Tool
            // slot (Focus counts only genuine tool/call events, §10.2).
            card.callCount = 0
            setTranscriptTiming(card, pointTiming(event.time))
            // This orphan card is NEWLY materialized (the branches above
            // settle an EXISTING card, which stays legal evidence): if its
            // owning turn already ended, it is post-turn replay evidence.
            if (this.activityByTurn.get(turn)?.completed === true) markPostTurnReplayEvidence(card)
            this.appendItem(card)
            this.scheduleGrouping(this.items.length - 1)
          }
        }
        // Focus aggregation: settle the Tool slot ONLY when the result
        // belongs to the LATEST call (plan §10/§44) — an older parallel
        // call's result must never yank the slot back from the newer call.
        const activity = this.activityFor(turn)
        // After turn/end the Tool slot was settled: a late result (replay
        // artifact) must not mutate it (review finding). The transcript
        // card still settles.
        const activeTool = activity.tool
        if (!activity.completed && activeTool !== undefined && activeTool.callId === key) {
          activeTool.status = status
          activity.revision += 1
        }
        break
      }
      // Nested PTC sub-dispatch STARTING inside a run_code program (alpha.2
      // log-only events; the outer curated result may not carry the nested
      // output, so the TUI folds each sub-call into its own tool card).
      // The events carry no turn: attribute the child card to the parent
      // call's turn (the parent stays in pendingCalls until its tool/result
      // lands), falling back to the current turn for fragments.
      // Nested PTC sub-dispatch STARTING inside a run_code program (alpha.2
      // log-only events; the outer curated result may not carry the nested
      // output). Sub-calls NEVER join the top-level surface flow: the child
      // card is attached to its parent card's `subCalls` tree (the parent is
      // the pending run_code call or a deeper pending sub-call). A start
      // without a known parent (an incomplete replay fragment) is parked in
      // the private orphan index and connected when the parent appears.
      case 'tool/ptc-dispatch-start': {
        const data = event.data as {
          rootCallId: string
          parentCallId: string
          subCallId: string
          name: string
          arguments: unknown
        }
        const parent = this.pendingCalls.get(data.parentCallId)?.card
          ?? this.subCallIndex.get(data.parentCallId)
        if (parent !== undefined) {
          this.attachSubCall(parent, data.parentCallId, data)
        } else {
          const orphan = this.orphanSubCalls.get(data.subCallId)
          if (orphan === undefined) this.orphanSubCalls.set(data.subCallId, { start: data })
          else if (orphan.start === undefined) orphan.start = data
          else if (orphan.start.rootCallId !== data.rootCallId
            || orphan.start.parentCallId !== data.parentCallId
            || orphan.start.name !== data.name
            || JSON.stringify(orphan.start.arguments) !== JSON.stringify(data.arguments)) {
            // A conflicting duplicate start is impossible on a valid
            // alpha.2 durable stream — fail fast instead of silently
            // keeping one.
            throw new Error(`conflicting PTC sub-call start identity for ${data.subCallId}: first root=${orphan.start.rootCallId} parent=${orphan.start.parentCallId} name=${orphan.start.name}, duplicate root=${data.rootCallId} parent=${data.parentCallId} name=${data.name}`)
          }
        }
        break
      }
      // One nested PTC sub-dispatch SETTLING: pair with the start by
      // subCallId; the status comes from the durable isError flag (never
      // invented from spilled/truncated content). An orphan settle is
      // parked and applied when its start/parent appears.
      case 'tool/ptc-dispatch': {
        const data = event.data as {
          rootCallId: string
          parentCallId: string
          subCallId: string
          name: string
          arguments: unknown
          isError: boolean
          content: readonly ContentBlock[]
        }
        this.settleSubCall(data.subCallId, {
          rootCallId: data.rootCallId,
          parentCallId: data.parentCallId,
          name: data.name,
          arguments: data.arguments,
          isError: data.isError,
          content: data.content,
        })
        break
      }
      case 'turn/end': {
        // Idempotent: a replayed turn/end must not re-append the
        // synthetic cards or re-settle the activity (review finding).
        const endTurn = event.data.turn
        if (this.openTurn === endTurn) this.openTurn = undefined
        // Owner lifecycle: the turn closed — a still-open step of this turn
        // must not leak into the next turn-less/session-level segment (plan
        // §5.1/§14.2). The shared projection clears its open step/turn and
        // projects interrupted on every turn-owned AND step-owned Workflow
        // run of this turn without a terminal fact (plan §5.3 — upstream
        // `locationClosed(step)` is `step closed OR owning turn closed`).
        // Called BEFORE the replay fence: a replayed turn/end must still not
        // leave a stale open step behind (re-projection is idempotent).
        this.workflow.onTurnEnd(endTurn)
        const endActivity = this.activityFor(endTurn)
        endActivity.pendingPreSteerAnswerStep = undefined
        if (endActivity.completed) break
        // Every still-open thinking entry of THIS turn stops streaming when
        // the turn closes (interrupted steps never see their
        // assistant/message). Settled entries were removed when their
        // assistant/message arrived, so this is proportional to the open
        // work rather than to the full history.
        // The synthetic cards carry the EVENT's own turn — never
        // this.currentTurn: a turn-start-less fragment's end must land in
        // its own turn (review finding).
        for (const key of this.liveAssistantBlocks.keys()) {
          if (key.startsWith(`${endTurn}/`)) this.liveAssistantBlocks.delete(key)
        }
        this.markAttemptEvidenceInterrupted(endTurn)
        this.closeThinkingForTurn(endTurn, event.time)
        // The turn closed: its preparing starts are dead evidence.
        this.clearPreparingStartsForTurn(endTurn)
        if (event.data.reason.kind === 'error') {
          // Defensive: a malformed/legacy reason without the error detail
          // degrades to the bare marker instead of crashing the fold
          // (plan §10.2 — Focus aggregates the same events).
          const error = event.data.reason.error
          this.appendItem({ kind: 'tool', turn: endTurn, name: 'error', args: '', result: displayFailureText(error), status: 'error', origin: 'turn-error' })
        } else if (event.data.reason.kind === 'aborted') {
          this.appendItem({ kind: 'tool', turn: endTurn, name: 'interrupted', args: '', result: 'cancelled by user', status: 'error', origin: 'turn-interrupted' })
        } else if (event.data.reason.kind === 'interrupted') {
          this.appendItem({ kind: 'tool', turn: endTurn, name: 'interrupted', args: '', result: 'interrupted', status: 'error', origin: 'turn-interrupted' })
        } else if (event.data.reason.kind === 'max-tokens') {
          this.appendItem({ kind: 'system', turn: endTurn, text: 'max tokens reached — output truncated', origin: 'turn-max-tokens' })
        }
        // Focus aggregation: turn/end is the authoritative finalization —
        // it settles timing, the end reason, and makes the final assistant
        // eligible (plan §10.3/§13.1). The error detail is read
        // structurally (not every reason kind carries it). The activity
        // keys on the EVENT's own turn (a turn/start-less fragment still
        // aggregates to the right turn).
        const activity = this.activityFor(event.data.turn)
        activity.endedAt = event.time
        activity.completed = true
        const reasonError = (event.data.reason as { error?: { code?: unknown; message?: unknown } }).error
        activity.reason = {
          kind: event.data.reason.kind,
          ...(reasonError === undefined ? {} : {
            error: {
              code: typeof reasonError.code === 'string' ? reasonError.code : String(reasonError.code ?? ''),
              message: displayFailure({
                code: typeof reasonError.code === 'string' ? reasonError.code : String(reasonError.code ?? ''),
                message: typeof reasonError.message === 'string' ? reasonError.message : String(reasonError.message ?? ''),
              }).message,
            },
          }),
        }
        // Focus aggregation: turn/end resolves the Message slot (final
        // answer dedup — plan §5.5/§22), finalizes any still-open steps'
        // usage (so the per-turn total and the session total agree even
        // when turn/end arrives with open steps — review finding), and
        // settles the token display.
        this.resolveMessageAtTurnEnd(activity)
        this.attachDeliverablesToClosingAssistant(event.data.turn)
        // All declarations for this completed turn have either been selected
        // or rejected by the closing-sequence boundary; no later event can
        // reuse them after the completed fence.
        this.deliverableDeclarationsByTurn.delete(event.data.turn)
        this.usage.onTurnEnd(event.data.turn)
        this.syncUsage(activity)
        activity.revision += 1
        break
      }
      case 'tool-workflow/run-start': {
        // The shared projection captures the authoritative owner (the open
        // step wins, then the open turn, else the session — plan §5.2) and
        // creates the durable message.
        const message = this.workflow.onRunStart(event.data.runId, event.data.name, this.currentTurn)
        const index = this.appendItem(message)
        this.workflowIndexes.set(event.data.runId, index)
        // The workflow card is a Context boundary row: its authoritative
        // first-visible time (the run-start event) closes a preceding Activity.
        setTranscriptTiming(message, pointTiming(event.time))
        // Focus aggregation: a workflow run is a durable lifecycle event,
        // NOT a model tool/call — it never touches the Tool slot or the
        // tool count (plan §17).
        break
      }
      case 'tool-workflow/agent-start': {
        const { runId, seq, label, phase, childId } = event.data
        // The member folds INTO the run card (Web WorkflowRunPanel parity):
        // phase grouping happens at render time over the arrival-ordered
        // rows. A member starting after its owner closed is interrupted
        // from birth (plan §6.2 — the projection comes from the current
        // fold facts, no invented recovery flow).
        this.workflow.onAgentStart(runId, seq, label, phase === undefined ? null : phase, childId)
        break
      }
      case 'tool-workflow/agent-end': {
        const { runId, seq, outcome } = event.data
        // Only the started member with the matching runId + seq settles
        // (plan §6.3 — never infer a member outcome from run-end).
        this.workflow.onAgentEnd(runId, seq, outcome)
        break
      }
      case 'tool-workflow/run-end': {
        // The run's bookkeeping is done: the projection drops its fold
        // state so long sessions do not accumulate stale maps. The
        // TranscriptWorkflowMessage itself stays in the transcript items.
        this.workflow.onRunEnd(event.data.runId, event.data.stopReason)
        // The index map must not retain completed runs either (the
        // onChange hook already read the index before the projection
        // dropped its state).
        this.workflowIndexes.delete(event.data.runId)
        break
      }
      case 'llm/retry': {
        const { retry, delayMs, failure, turn, step } = event.data
        if (this.activityByTurn.get(turn)?.completed === true) break
        // The scheduled retry is the presentation reset boundary. It hides
        // the failed attempt immediately, while the later retry-started event
        // only opens the next usage replacement slot.
        this.resetThinkingForRetry(turn, step)
        // The retry invalidates the failed attempt's preparing starts: a
        // reused call id must never inherit the old attempt's timer
        // (post-F6 plan §12.14).
        this.clearPreparingStartsForStep(turn, step)
        const maxRetries = 'maxRetries' in event.data ? event.data.maxRetries : undefined
        const label = maxRetries === undefined
          ? `llm retry ${retry} in ${Math.round(delayMs / 1000)}s`
          : `llm retry ${retry}/${maxRetries} in ${Math.round(delayMs / 1000)}s`
        const retryCard: Extract<TranscriptMessage, { kind: 'system' }> = { kind: 'system', turn, text: `${label} — ${displayFailureText(failure)}`, origin: 'llm-retry' }
        // A retry row has only its event time: it contributes point
        // evidence to the enclosing Activity wall span (post-F6 plan
        // §12.9) — never an invented retry duration.
        setTranscriptTiming(retryCard, pointTiming(event.time))
        this.appendItem(retryCard)
        // Focus aggregation: retries are orchestration, not a Tool — they
        // stay in the expanded process and never touch the Tool slot
        // (plan §16.2).
        break
      }
      case 'command/run': {
        // A duplicated/replayed run with a known id fails soft: the original
        // lifecycle identity wins and no duplicate visible row is created.
        if (this.commands.has(event.data.commandId)) break
        const message: TranscriptCommandMessage = {
          kind: 'command',
          commandId: event.data.commandId,
          seq: event.seq,
          time: event.time,
          name: event.data.name,
          args: typeof event.data.args === 'string' ? event.data.args : null,
          outcome: null,
        }
        const index = this.appendItem(message)
        this.commands.set(event.data.commandId, { index, message })
        // A compaction card may ALREADY have declared this command id (its
        // lifecycle events landed while the run fragment was unavailable, or
        // simply later in the same batch): leg 1 is proven the moment the
        // declaration exists, so resolve the combined ownership now — even
        // while the command is still running.
        this.fuseCompactionCommand(message, index)
        break
      }
      case 'command/done': {
        const outcome = commandOutcomeOf(event)
        const known = this.commands.get(event.data.commandId)
        if (known === undefined) {
          // A done fragment without its run (a folded log fragment): one
          // fail-soft fallback row at the done event's real position, never
          // an invented turn and never a fake `/command` Tool.
          const message: TranscriptCommandMessage = {
            kind: 'command',
            commandId: event.data.commandId,
            seq: event.seq,
            time: event.time,
            name: null,
            args: null,
            outcome,
          }
          const index = this.appendItem(message)
          this.commands.set(event.data.commandId, { index, message })
          this.fuseCompactionCommand(message, index)
          break
        }
        known.message.outcome = outcome
        this.markSearchEntryDirty(known.index)
        this.fuseCompactionCommand(known.message, known.index)
        break
      }
      case 'subagent/descriptor': {
        // Child identity metadata, NOT transcript content: the viewer holds
        // the authoritative child identity (id/label/mode/activity) through
        // its own catalog state, and the parent's genuine
        // `tool/call name=subagent` remains the delegation evidence. No
        // TranscriptMessage is materialized for the descriptor.
        break
      }
      default:
        break
    }
  }
}

/** Validate and retain the official `command/done` outcome (post-PR166 plan
 * §6): only a SUCCESS may carry the `sourceEventSeq` relationship, and the
 * sequence must be a safe non-negative integer — anything malformed is
 * dropped fail-soft (partial/migrated logs), never a throw and never a
 * re-parse of the result text. */
function commandOutcomeOf(event: SessionEvent): TranscriptCommandOutcome {
  const data = event.data as { kind?: unknown; text?: unknown; sourceEventSeq?: unknown }
  const kind = data.kind === 'error' ? 'error' : 'success'
  const text = typeof data.text === 'string' ? data.text : undefined
  const sourceEventSeq = kind === 'success' && typeof data.sourceEventSeq === 'number'
    && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0
    ? (data.sourceEventSeq as SessionEventSeq)
    : undefined
  return {
    kind,
    ...(text === undefined ? {} : { text }),
    ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
  }
}

/**
 * Fold a session event log into the transcript messages, in log order.
 * Live text deltas accumulate into the assistant message of their own
 * (turn, step); `reasoning-delta` chunks accumulate into a thinking entry.
 * A tool call and its result merge into one card; an unanswered call stays
 * `running`.
 * @param events - the session log.
 * @param options - optional display window (older turns collapse).
 * @returns ordered renderable messages.
 */
export function foldTranscript(events: readonly SessionEvent[], options?: FoldOptions): TranscriptMessage[] {
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  return folder.messages(options)
}

/**
 * A child session's OWN events: everything after the LAST tagged inherited
 * `session/end-seed` marker. The fork provider seeds a child with the
 * PARENT's inherited prefix — the exact cut may land mid-turn, and the
 * child-owned synthetic repair always follows the marker (upstream: "a fork
 * seed replays the parent's log"), so the child log's pre-marker events are
 * the parent's history — parent completion notices included. The subagent
 * viewer must never render them as the child's transcript. Ordinary untagged
 * markers delimit restore/replay lifecycles and do not change child ownership.
 * Supported seeded logs always carry the tagged marker; an unseeded child has
 * no ownership marker, so all of its events remain visible.
 */
export function childOwnEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  let cut = 0
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'session/end-seed' && event.data.inherited === true) cut = index + 1
  }
  return cut === 0 ? events : events.slice(cut)
}
