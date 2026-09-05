/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
 *
 * Thinking (`reasoning-delta` chunks) and tool calls fold into collapsible
 * entries carrying their owning turn, so the view can expand only the most
 * recent turns (pi's Ctrl+O semantics).
 *
 * `TranscriptFolder` is the stateful engine: call `apply` with live appended
 * events or `hydrate` with a cold log, then read the message list;
 * `foldTranscript` is the one-shot wrapper. Both support an optional display window (`maxTurns`): turns older
 * than the window collapse into one summary entry, bounding the rendered
 * component tree on long sessions.
 * @module @xmoon76/dsh-pi-tui/transcript
 */

import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expandAssistantStream, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { contextIconSemantic, contextProvenance, contextSummary } from './context.ts'
import type { IconSemantic } from './icons.ts'
import { firstLine, latestLine, type JsonValue } from './present.ts'
import {
  StepUsageAccumulator,
  totalTokens,
  usageFromAssistantSettlement,
  type TokenUsageTotals,
} from './token-usage.ts'
import type {
  AssistantLiveChunk,
  AssistantLiveContentBlock,
  AssistantLiveInput,
} from './runtime/assistant-stream-port.ts'
// Load the official command event declarations.
import type {} from '@deepseek-ai/dsh-commands'
// Load the official subagent event declarations.
import type {} from '@deepseek-ai/dsh-subagent'
// Load the official workflow event declarations.
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
// Load the official retry event declarations.
import type {} from '@deepseek-ai/dsh-llm-retry'

/** One renderable message in the TUI transcript. */
export type TranscriptMessage =
  /**
   * A direct human prompt. `text` is the flat text (search/title/queue
   * recall); `content` carries the FULL ordered blocks when the message had
   * images — the image pipeline renders them in order (plan §15).
   */
  | { kind: 'user'; turn: number; text: string; content?: readonly ContentBlock[] }
  /**
   * One step's model output. `text` is the flat markdown; `content` is the
   * settled message's full blocks when the step carried any (role-neutral
   * `ImageBlock`s render rather than crash, plan §15.3).
   */
  | {
    kind: 'assistant'
    turn: number
    text: string
    content?: readonly ContentBlock[]
    /** Durable interruption evidence; presentation metadata, not body text. */
    interrupted?: true
  }
  | { kind: 'thinking'; turn: number; text: string; /** Still streaming reasoning deltas for its step. */ running?: boolean }
  /**
   * Injected context (system reminders, skill content) from non-user sources.
   * Labeled entries carry the Web-provenance producer name (e.g. AGENTS.md,
   * @deepseek-ai/dsh-system-prompt, skill-catalog), a source-kind icon
   * SEMANTIC (never a concrete glyph — the renderer resolves the palette),
   * and, for notice forms, the producer's one-line summary.
   */
  | { kind: 'system'; turn: number; text: string; label?: string; summary?: string; icon?: IconSemantic }
  | {
    kind: 'tool'
    turn: number
    name: string
    args: string
    result: string
    status: 'ok' | 'error' | 'running'
    /** The completed result's content blocks, for tool-owned presentation. */
    resultBlocks?: readonly ContentBlock[]
    /** The tool-private presentation payload from the tool/result event. */
    meta?: JsonValue
    /** The structured internal failure identity (`{name, code}`), when the
     * tool/result event carried one (e.g. `UserQuestionError` with
     * `ASK_CANCELLED` / `ASK_ABORTED` for a cancelled question flow). */
    error?: { name: string; code: string }
    /**
     * Workflow run cards only: the run's member rows, folded into the card
     * (Web WorkflowRunPanel parity) instead of standalone member cards.
     */
    members?: WorkflowMemberView[]
  }
  /** Older-than-window turns collapsed into one line (windowing). */
  | { kind: 'summary'; text: string }
  /**
   * A context-compaction card: created at `compaction/start` (running),
   * filled by `compaction/summary` (shadowed item/token counts + the
   * summary body), settled by `compaction/end` (error on failure). The
   * collapsed card shows the title + the counts; expanding reveals the
   * summary markdown.
   */
  | {
    kind: 'compaction'
    turn: number
    /** The summary body (markdown), filled when compaction/summary lands. */
    text: string
    /** Shadowed history items (the shadowedSeqs count). */
    items: number
    /** Shadowed token estimate. */
    tokens: number
    /** In-progress until compaction/end settles it. */
    running?: boolean
    /** Non-empty when compaction/end carried an error. */
    error?: string
  }

/** One member row of a workflow run card. */
export interface WorkflowMemberView {
  /** The member agent's label. */
  label: string
  /** The run phase the member ran under, when the event carried one. */
  phase?: string
  /** The member's settled state (running until agent-end). */
  status: 'ok' | 'error' | 'running'
}

/** Stable identity of one raw transcript item within ONE TranscriptFolder
 * lifetime. The raw item's index doubles as its id: `items` is strictly
 * append-only, so an id keeps pointing at the same logical source through
 * streaming, settlement and read-group reflow — the visible card OBJECT may
 * be replaced (or merged into a group), the id never is. Ids are
 * session-local by construction: a new folder starts a fresh namespace.
 * @see TranscriptSearchMatch
 */
export type TranscriptItemId = number

/** One full-history search hit: the CURRENT visible representative of the
 * matched logical card plus its visible turn. Matches deliberately never
 * carry `TranscriptMessage` objects: live settlement replaces items and
 * grouping reflow replaces merged cards, so an object-based match would
 * pin stale state and break Next/Prev navigation. */
export interface TranscriptSearchMatch {
  readonly id: TranscriptItemId
  readonly turn: number
}

/** The searchable text of one message — the SINGLE source of truth for the
 * search corpus (the legacy full-history search semantics: tools search
 * `name args result`, every other kind searches `text`). `summary` rows
 * never reach `items`, so the projection never indexes them. */
export function transcriptSearchText(message: TranscriptMessage): string {
  if (message.kind === 'tool') return `${message.name} ${message.args} ${message.result}`
  return message.text ?? ''
}

/** Normalize search text exactly like the legacy query path did (JS String
 * `toLowerCase`, no locale options). Applied ONCE per entry at build/refresh
 * time — never per query. */
function normalizeSearchText(text: string): string {
  return text.toLowerCase()
}

/** The turn-end reason surface Focus reads (structural — never a full
 * dsh type import; the official kind names are kept verbatim). */
export interface TurnEndReason {
  readonly kind: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** The official turn-end reason kinds (Harness TurnEndReason): Focus maps
 * them for presentation but NEVER invents names of its own (plan §13.2). */
export const TURN_END_REASON_KINDS = [
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted',
] as const

/**
 * One turn's aggregated activity for the Focus projection (plan §10):
 * timing from `SessionEvent.time` (never a second clock), tool statistics
 * counted on `tool/call` ONLY (a call/result pair is one call), and the
 * three compact process slots — Think / Message / Tool — plus the per-turn
 * token usage. Maintained incrementally by {@link TranscriptFolder.apply}
 * alongside the message fold — never a rescan of the session log.
 *
 * The slots are SEMANTIC, decided by the event stream (plan §57):
 * `reasoning-delta` → Think, assistant text → Message, `tool/call` → Tool.
 * Presentation (whale icons, titles, truncation) lives in the Focus
 * presentation layer, never here.
 */
export interface TurnActivity {
  /** The owning turn number. */
  readonly turn: number
  /** `turn/start.time` (Unix epoch ms). Absent for legacy/corrupt logs. */
  readonly startedAt?: number
  /** `turn/end.time`; absent while the turn is still open. */
  readonly endedAt?: number
  /** Settled by the authoritative `turn/end` event. */
  readonly completed: boolean
  /** The OFFICIAL harness reason kind (completed/aborted/blocked/error/
   * max-tokens/interrupted) — never an invented name. */
  readonly reason?: TurnEndReason
  /** The Think slot: the latest meaningful line of the bounded reasoning
   * tail (compact preview only — never the raw reasoning stream). */
  readonly think?: { readonly text: string }
  /** The Message slot: the bounded LATEST TAIL of the current candidate /
   * confirmed intermediate assistant text, kept MULTILINE (the Focus
   * renderer wraps it to the current width and shows the last three
   * visual rows — a single-line flatten would destroy that). The FINAL
   * answer never enters this slot (it renders outside the Thought). */
  readonly message?: { readonly text: string }
  /** The Tool slot: the LATEST real `tool/call` (any name — event-first
   * classification), settled by its own `tool/result` only. */
  readonly tool?: {
    readonly callId: string
    readonly name: string
    readonly args: string
    readonly status: 'running' | 'ok' | 'error'
  }
  /** The per-turn token totals (committed steps + open steps' current
   * usage); absent when the turn has no usage fact at all. */
  readonly usage?: TokenUsageTotals
  /** The display total (input + cache read + cache write + output). */
  readonly totalTokens?: number
  /** Whether the exact last assistant has a visible Assistant projection.
   * This remains separate from the visible row list so an empty authoritative
   * settlement cannot make final selection fall back to an earlier answer. */
  readonly lastAssistantVisible?: boolean
  /** Settled assistant/message count for the turn. */
  readonly assistantMessages: number
  /** tool/call count (never double-counted on tool/result). */
  readonly toolCalls: number
  /** Per-tool call counts, for the `read ×4 · search ×3` header stats. */
  readonly tools: ReadonlyMap<string, number>
  /** Monotonic revision, bumped on every visible change — the Focus
   * render-cache key (plan §39). */
  readonly revision: number
}

/** The internal mutable activity; exposed snapshots are read-only views. */
interface MutableTurnActivity {
  turn: number
  startedAt?: number
  endedAt?: number
  completed: boolean
  reason?: TurnEndReason
  /** The rolling reasoning tail (preview only, bounded). */
  thinkingTail: string
  /** The materialized Think slot (latest meaningful line). */
  think?: { text: string }
  /** The step that currently owns the Focus reasoning preview. */
  thinkingStep?: number
  /** The streaming assistant text of the CURRENT step (bounded tail —
   * the authoritative settled text replaces the tail once
   * assistant/message lands; never a second full copy of the output,
   * plan §34). */
  messageCandidate?: {
    step: number
    tail: string
  }
  /** An earlier candidate confirmed as an intermediate message (by a
   * later tool/call, a later step, or later output). */
  messageConfirmed?: string
  /** The step of the LATEST confirmed intermediate message: a late
   * authoritative message for THAT step updates the confirmed text in
   * place (never a stale streamed fragment). */
  messageConfirmedStep?: number
  /** Every step whose candidate was confirmed: a late message for an
   * OLDER confirmed step is ignored (the slot shows the latest
   * intermediate) and never resurrects a candidate (review finding). */
  confirmedSteps: Set<number>
  /** Every step whose output was AUTHORITATIVELY settled by an
   * assistant/message: a later text-delta for it is a replay artifact and
   * is ignored — it must never corrupt the settled preview (review
   * finding). */
  settledSteps: Set<number>
  /** The step of the turn's LAST assistant output (streaming or settled)
   * — the turn/end final-answer check compares the candidate's step
   * against this. */
  lastAssistantStep?: number
  /** Whether the exact last assistant has a visible Assistant projection. */
  lastAssistantVisible?: boolean
  /** The materialized Message slot (candidate ?? confirmed, bounded
   * multiline tail). */
  message?: { text: string }
  /** The Tool slot: the latest real tool/call, settled by its own result. */
  tool?: {
    callId: string
    name: string
    args: string
    status: 'running' | 'ok' | 'error'
  }
  /** The per-turn token totals (committed + open steps' current usage). */
  usage?: TokenUsageTotals
  /** The display total (input + cache read + cache write + output). */
  totalTokens?: number
  assistantMessages: number
  toolCalls: number
  tools: Map<string, number>
  revision: number
}

/** Fold options: the display window in turns. */
export interface FoldOptions {
  /** Keep this many most-recent turns; older turns collapse into a summary entry. */
  maxTurns?: number
  /**
   * Window ENDS at this turn instead of the newest (pairs with `maxTurns`):
   * the kept turns are `[endTurn - maxTurns + 1 .. endTurn]`. Used by the
   * transcript search to jump the view to a match deep in history.
   */
  endTurn?: number
}

/** A bounded transcript projection plus navigation facts. */
export interface TranscriptWindow {
  /** The materialized messages for the selected turn range. */
  messages: TranscriptMessage[]
  /** First/last actual turns in the selected range (summary rows excluded). */
  firstTurn?: number
  lastTurn?: number
  /** Whether another turn page exists on either side of this projection. */
  hasOlder: boolean
  hasNewer: boolean
}

/** Text of a message's content blocks, joined; empty when there is no text. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reconstruct the logical blocks used by any Assistant entry. */
function assistantEntryBlocks(entry: Extract<TranscriptMessage, { kind: 'assistant' }>): readonly ContentBlock[] {
  if (entry.content !== undefined) return entry.content
  return entry.text === '' ? [] : [{ type: 'text', text: entry.text }]
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

/** Flat text with image positions preserved: text blocks verbatim, image
 * blocks as an inline `🖼️ name` marker AT their position (the queue-preview
 * format; U+FE0F keeps the marker 2 cells wide in emoji fonts). A marker
 * boundary always carries a single separating space — the /image insertion
 * leaves NO space before the placeholder, so `what is this [image…]` must
 * not read as `what is this 🖼️ shot.png` — while a space the user already
 * typed is never doubled. The structured `content` blocks stay the canonical form
 * for thumbnail rendering; this projection feeds the flat-text consumers
 * (transcript search, loader-less fallback rendering, the user bubble's
 * inline marker) so a mixed message never reads as if the image was not
 * there, and an image-only message is not empty. Identical to
 * {@link textOf} for text-only content. */
export function textWithImageMarkers(blocks: readonly ContentBlock[]): string {
  let text = ''
  // A marker boundary: the previous block was an image and the next text
  // block needs a separator unless it brings its own whitespace.
  let boundary = false
  for (const block of blocks) {
    if (block.type === 'text') {
      if (boundary && text !== '' && !/\s$/.test(text) && !/^\s/.test(block.text)) text += ' '
      boundary = false
      text += block.text
    } else if (block.type === 'image') {
      if (text !== '' && !/\s$/.test(text)) text += ' '
      text += `🖼️ ${block.attachment.name ?? 'image'}`
      boundary = true
    }
  }
  return text
}

/** Key identifying one step's model output (turn + step). */
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
 * state at a time; block-end replaces that state authoritatively.
 */
function applyAssistantBlockChunk(blocks: Map<number, AssistantBlockState>, chunk: AssistantBlockChunk): void {
  switch (chunk.type) {
    case 'block-start':
      blocks.set(chunk.index, emptyAssistantBlockState(chunk.blockType))
      break
    case 'text-delta': {
      const previous = blocks.get(chunk.index)
      blocks.set(chunk.index, {
        kind: 'text',
        text: previous?.kind === 'text' ? previous.text + chunk.text : chunk.text,
      })
      break
    }
    case 'reasoning-delta': {
      const previous = blocks.get(chunk.index)
      blocks.set(chunk.index, {
        kind: 'reasoning',
        text: previous?.kind === 'reasoning' ? previous.text + chunk.text : chunk.text,
      })
      break
    }
    case 'tool-call-delta': {
      const previous = blocks.get(chunk.index)
      const base = previous?.kind === 'tool-call'
        ? previous
        : { kind: 'tool-call' as const, id: '', name: '', arguments: '' }
      blocks.set(chunk.index, {
        kind: 'tool-call',
        id: base.id || chunk.id,
        name: chunk.name ?? base.name,
        arguments: base.arguments + chunk.argumentsDelta,
      })
      break
    }
    case 'block-end':
      blocks.set(chunk.index, { kind: 'complete', block: chunk.block })
      break
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

/** Project indexed block state in stable upstream index order. */
function assistantContentFromBlocks(blocks: Map<number, AssistantBlockState>): ContentBlock[] {
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, state]) => assistantContentFromBlockState(state))
    .filter((block): block is ContentBlock => block !== undefined)
}

/**
 * The turn threshold at or above which entries count as "recent": the
 * `recentTurns` most recent distinct turns among the given message kinds.
 * Shared by the display window (all kinds), the markdown view, and the
 * Ctrl+O expansion boundary (foldable kinds only).
 * @param messages - the folded transcript.
 * @param recentTurns - how many most-recent turns survive; <= 0 keeps nothing.
 * @param kinds - kinds whose turns count; undefined counts every kind.
 * @returns the oldest recent turn number; 0 when everything is recent;
 *   `Infinity` when nothing is (every entry folds).
 */
export function recentTurnThreshold(
  messages: readonly TranscriptMessage[],
  recentTurns: number,
  kinds?: readonly TranscriptMessage['kind'][],
): number {
  if (recentTurns <= 0) return Number.POSITIVE_INFINITY
  const turns = new Set<number>()
  for (const message of messages) {
    if (message.kind === 'summary') continue
    if (kinds === undefined || kinds.includes(message.kind)) turns.add(message.turn)
  }
  const sorted = [...turns].sort((a, b) => b - a)
  if (sorted.length <= recentTurns) return 0
  return sorted[recentTurns - 1] ?? 0
}

/**
 * Collapse turns older than the display window into one leading summary
 * entry with aggregate counts. Entries at/after the boundary survive; the
 * result is a fresh array when anything collapses.
 * @param messages - the folded transcript.
 * @param maxTurns - window size in turns; entries of older turns collapse.
 * @param endTurn - window end turn (newest when absent), see {@link FoldOptions}.
 * @returns the windowed transcript.
 */
export function windowMessages(messages: readonly TranscriptMessage[], maxTurns: number, endTurn?: number): TranscriptMessage[] {
  if (maxTurns <= 0) return [...messages]
  if (endTurn !== undefined) {
    // Anchored window (transcript search): keep exactly the maxTurns distinct
    // turns ENDING at endTurn and collapse the older turns above them; turns
    // newer than the anchor are hidden (the search jumped back in history).
    const turns = new Set<number>()
    for (const message of messages) {
      if ('turn' in message) turns.add(message.turn)
    }
    const sorted = [...turns].sort((a, b) => b - a)
    const anchor = sorted.indexOf(endTurn)
    if (anchor === -1) return windowMessages(messages, maxTurns)
    const windowTurns = new Set(sorted.slice(anchor, anchor + maxTurns))
    const kept = messages.filter(message => !('turn' in message) || windowTurns.has(message.turn))
    const newerTurns = new Set(sorted.slice(0, anchor))
    const oldTurns = new Set(sorted.slice(anchor + maxTurns))
    if (newerTurns.size === 0 && oldTurns.size === 0) return kept
    const parts: string[] = []
    if (newerTurns.size > 0) parts.push(`${newerTurns.size} newer turn${newerTurns.size === 1 ? '' : 's'}`)
    if (oldTurns.size > 0) parts.push(`${oldTurns.size} earlier turn${oldTurns.size === 1 ? '' : 's'}`)
    kept.unshift({ kind: 'summary', text: `… ${parts.join(' · ')} — window ${maxTurns} turns` })
    return kept
  }
  const boundary = recentTurnThreshold(messages, maxTurns)
  if (boundary === 0) return [...messages]
  const oldTurns = new Set<number>()
  const kept: TranscriptMessage[] = []
  let oldTools = 0
  let oldCount = 0
  for (const message of messages) {
    if ('turn' in message && message.turn < boundary) {
      oldCount += 1
      if (message.kind === 'tool') oldTools += 1
      oldTurns.add(message.turn)
      continue
    }
    kept.push(message)
  }
  if (oldCount === 0) return [...messages]
  const turnsText = `${oldTurns.size} earlier turn${oldTurns.size === 1 ? '' : 's'}`
  const toolsText = `${oldTools} tool call${oldTools === 1 ? '' : 's'}`
  kept.unshift({ kind: 'summary', text: `… ${turnsText} · ${toolsText} — window ${maxTurns} turns` })
  return kept
}

/**
 * Merge consecutive completed `read` tool cards into one card ("N files").
 * A single read stays untouched; groups break on any other kind or status.
 * @param messages - the folded transcript.
 * @returns a new list with grouped read cards (same object references).
 */
export function groupConsecutiveReads(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  let group: Extract<TranscriptMessage, { kind: 'tool' }> | undefined
  let count = 0
  for (const message of messages) {
    if (message.kind === 'tool' && message.name === 'read' && message.status === 'ok') {
      if (group !== undefined) {
        count += 1
        group.args = `${count} files`
        group.result = group.result === '' ? message.result : `${group.result}\n\n${message.result}`
        group.turn = Math.max(group.turn, message.turn)
        continue
      }
      group = { ...message }
      count = 1
      out.push(group)
      continue
    }
    group = undefined
    out.push(message)
  }
  return out
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
}

export class TranscriptFolder {
  private readonly items: TranscriptMessage[] = []
  /** The assistant message object per (turn, step); streaming text lands in place. */
  private readonly assistantEntries = new Map<string, Extract<TranscriptMessage, { kind: 'assistant' }>>()
  /** In-flight live block state keyed by logical step. This is required for
   * authoritative block-end replacement: deltas may be partial, while a
   * completed block replaces the entire indexed state without duplication. */
  private readonly liveAssistantBlocks = new Map<string, Map<number, AssistantBlockState>>()
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
  /** Tool names by callId, for result pairing. */
  private readonly callNames = new Map<string, string>()
  /** Command names by commandId, from command/run events. */
  private readonly commandNames = new Map<string, string>()
  /** Workflow run cards by runId, for member/run settlement. */
  private readonly workflowRuns = new Map<string, Extract<TranscriptMessage, { kind: 'tool' }>>()
  /** Workflow member rows by `${runId}/${seq}`, for agent-end settlement. */
  private readonly workflowMembers = new Map<string, WorkflowMemberView>()
  /** Compaction lifecycle: compactionId → items index (start/summary/end). */
  private readonly compacting = new Map<string, number>()
  /** The turn most recently opened by turn/start. */
  private currentTurn = 0
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
  /** Bumped on EVERY entry mutation (append, settlement, group reflow):
   * query refinement must not reuse previous candidates across a revision. */
  private searchRevisionCounter = 0
  /** Step key → raw item index, for in-place streaming text updates.
   * Namespaced by entry kind (`assistant:` / `thinking:`): a step streams
   * BOTH reasoning and text, and the two entries share the same
   * stepKey(turn, step) — an un-namespaced map would let one kind's deltas
   * land on the other kind's searchable entry. */
  private readonly searchIndexByStepKey = new Map<string, number>()
  /** Workflow run card indices by runId (run-end fills the result text). */
  private readonly workflowRunIndex = new Map<string, number>()
  // Test-only counters exposed by searchDiagnosticsForTest().
  private searchRefreshCount = 0
  /** Test-only: the number of dirty entries scanned by lazy normalization
   * (proves the query path is O(#dirty), never O(history)). */
  private searchDirtyScanCount = 0
  private searchFullScanCount = 0
  private searchRefineCount = 0
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
  private static readonly THINKING_TAIL_CAP = 400
  /** The bounded message candidate tail cap (streaming assistant text). */
  private static readonly MESSAGE_TAIL_CAP = 400
  /** The bounded preview cap (the card truncates to width too). */
  private static readonly NARRATIVE_PREVIEW_CAP = 200

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
        revision: 0,
      }
      this.activityByTurn.set(turn, activity)
    }
    return activity
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
    activity.thinkingStep = step
    activity.thinkingTail = text.slice(-TranscriptFolder.THINKING_TAIL_CAP)
    const line = latestLine(activity.thinkingTail).slice(0, TranscriptFolder.NARRATIVE_PREVIEW_CAP)
    activity.think = line === '' ? undefined : { text: line }
    activity.revision += 1
  }

  /** Clear the Focus reasoning preview owned by one authoritative step. */
  private clearThinkingPreview(activity: MutableTurnActivity, step: number): void {
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
    if (activity.completed) return
    activity.thinkingStep = step
    activity.thinkingTail = (activity.thinkingTail + delta).slice(-TranscriptFolder.THINKING_TAIL_CAP)
    const line = latestLine(activity.thinkingTail).slice(0, TranscriptFolder.NARRATIVE_PREVIEW_CAP)
    activity.think = line === '' ? undefined : { text: line }
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

  /** Append one folded message, maintaining the window projections. Returns
   * the raw item index (the stable search identity). */
  private appendItem(message: TranscriptMessage): number {
    this.items.push(message)
    const index = this.items.length - 1
    // The searchable projection mirrors the item's own text (eager at
    // append — the cold path); later mutations mark the entry dirty and
    // re-normalize lazily at the next search.
    this.searchEntries.push({
      turn: 'turn' in message ? message.turn : 0,
      normalizedText: normalizeSearchText(transcriptSearchText(message)),
    })
    this.searchRevisionCounter += 1
    const turn = 'turn' in message ? message.turn : undefined
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
    if (turn !== undefined) this.addGroupedTurn(turn)
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
      entry.turn = 'turn' in card ? card.turn : 0
      entry.normalizedText = normalizeSearchText(transcriptSearchText(card))
      this.searchRefreshCount += 1
    }
    this.dirtySearchEntries.clear()
  }

  /** The CURRENT output representative of one raw item id: the first member
   * of its merged read group when grouped, else the item itself. Search
   * results are deduplicated by representative so a merged read card yields
   * exactly ONE visible match no matter how many members hit. */
  private representativeOf(id: number): number {
    const group = this.groupOf.get(id)
    if (group === undefined) return id
    const members = this.groupMembers.get(group)
    const first = members === undefined ? undefined : members[0]
    return first === undefined ? id : first
  }

  /** Whether an item is groupable as a consecutive read (settled ok). */
  private static groupable(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'tool' }> {
    return message.kind === 'tool' && message.name === 'read' && message.status === 'ok'
  }

  /** Build one merged read card without repeatedly concatenating its result. */
  private makeReadGroup(start: number, end: number): {
    group: ReadGroupCard
    members: number[]
    firstTurn: number
    spansTurns: boolean
  } | undefined {
    const first = this.items[start]
    if (first === undefined || !TranscriptFolder.groupable(first)) return undefined
    const members: number[] = []
    const results: string[] = []
    const turns = new Set<number>()
    let firstResult: string | undefined
    let maxTurn = first.turn
    for (let index = start; index <= end; index += 1) {
      const member = this.items[index]
      if (member === undefined || !TranscriptFolder.groupable(member)) continue
      members.push(index)
      turns.add(member.turn)
      maxTurn = Math.max(maxTurn, member.turn)
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
    }
    return { group, members, firstTurn: first.turn, spansTurns: turns.size > 1 }
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
      return assistantBlocksVisibleNow(assistantEntryBlocks(item))
    }
    if (item.kind === 'thinking') return !this.hiddenThinkingEntries.has(item)
    return true
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
    for (let start = 0; start < this.items.length;) {
      const item = this.items[start]!
      // Tombstoned failed-attempt text is never visible output and never
      // separates an adjacent read run.
      if (!this.isVisible(item)) {
        start += 1
        continue
      }
      if (item.kind !== 'tool' || item.name !== 'read' || item.status !== 'ok') {
        if (item.kind === 'tool') this.groupedToolCount += 1
         if ('turn' in item) this.addGroupedTurn(item.turn)
        start += 1
        continue
      }
      let end = start + 1
      while (end < this.items.length && TranscriptFolder.groupable(this.items[end]!)) end += 1
      if (end - start === 1) {
         this.addGroupedTurn(item.turn)
         // The single read has no merged card yet.
        this.groupedToolCount += 1
        start = end
        continue
      }
      const built = this.makeReadGroup(start, end - 1)
      if (built === undefined) {
        for (let memberIndex = start; memberIndex < end; memberIndex += 1) {
          const member = this.items[memberIndex]
          if (member !== undefined && 'turn' in member) this.addGroupedTurn(member.turn)
        }
        // The run was checked above; keep a defensive fallback that preserves
        // the output count if a future item shape invalidates that invariant.
        this.groupedToolCount += 1
        start = end
        continue
      }
      for (const member of built.members) this.groupOf.set(member, built.group)
      this.groupMembers.set(built.group, built.members)
      this.groupMeta.set(built.group, { firstTurn: built.firstTurn, spansTurns: built.spansTurns })
       this.addGroupedTurn(built.group.turn)
      this.groupedToolCount += 1
      if (built.spansTurns) this.crossTurnGroups += 1
      start = end
    }
    // The cold finalize rebuilds every group: eagerly normalize each
    // merged card's REPRESENTATIVE entry to the shared group text (one
    // normalize per group — the allowed one-time O(history) cost).
    // Non-representative members keep their own raw entries and are
    // skipped at scan time.
    this.groupingRebuildCount += 1
    for (const [group, members] of this.groupMembers) {
      const first = members[0]
      if (first === undefined) continue
      const entry = this.searchEntries[first]
      if (entry === undefined) continue
      entry.turn = group.turn
      entry.normalizedText = normalizeSearchText(transcriptSearchText(group))
      this.dirtySearchEntries.delete(first)
      this.searchRefreshCount += 1
    }
  }



   /**
    * Extend a groupable card that was just settled at the item-list tail.
   * Normal live delivery follows this path, so an adjacent read run does not
   * scan its history on every result. A non-tail settlement still falls back
   * to the defensive reflow path below because it may bridge two runs.
   */
  private appendTailGrouping(index: number): boolean {
    if (index !== this.items.length - 1) return false
    const item = this.items[index]
    if (item === undefined || !TranscriptFolder.groupable(item)) return false
    const previousIndex = index - 1
    const previous = this.items[previousIndex]
    if (previous === undefined || !TranscriptFolder.groupable(previous)) return true

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
       this.addGroupedTurn(previousGroup.turn)
      const spansTurns = wasCross || item.turn !== firstTurn
      this.groupMeta.set(previousGroup, { firstTurn, spansTurns })
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
    this.groupOf.set(previousIndex, group)
    this.groupOf.set(index, group)
    this.groupMembers.set(group, [previousIndex, index])
    this.groupMeta.set(group, { firstTurn: previous.turn, spansTurns: previous.turn !== item.turn })
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
    if (this.appendTailGrouping(index)) return
    this.reflowGrouping(index)
  }

  /**
   * Rebuild the grouping of the groupable run containing `index` (bounded
   * by non-groupable items). Called when an item BECOMES groupable (a read
   * settles ok) or a groupable item is appended; the run is re-flowed into
   * one merged card and any superseded group card is dropped.
   */
  private reflowGrouping(index: number): void {
    const item = this.items[index]
    if (item === undefined || !TranscriptFolder.groupable(item)) return
    this.groupedTurnIndexDirty = true
     let start = index
    while (start > 0 && TranscriptFolder.groupable(this.items[start - 1]!)) start -= 1
    let end = index
    while (end + 1 < this.items.length && TranscriptFolder.groupable(this.items[end + 1]!)) end += 1
    // Detach the run's items from any existing groups (a settle can splice
    // a previously-running item into the middle of the run).
    for (let i = start; i <= end; i += 1) {
      const group = this.groupOf.get(i)
      if (group !== undefined) {
        const members = this.groupMembers.get(group)
        if (members !== undefined) {
          const remaining = members.filter(member => member < start || member > end)
          if (remaining.length === 0) {
            // The whole group lives inside the run: its output card becomes
            // `members.length` independent read cards, then the rebuild
            // merges them into one card again — keep the counters in sync.
            this.groupMembers.delete(group)
            const spansTurns = this.groupMeta.get(group)?.spansTurns ?? this.crossTurn(members)
            this.groupMeta.delete(group)
            this.groupedToolCount += members.length - 1
            if (spansTurns) this.crossTurnGroups -= 1
          } else {
            this.groupMembers.set(group, remaining)
            const first = this.items[remaining[0]!]
            if (first !== undefined && TranscriptFolder.groupable(first)) {
              this.groupMeta.set(group, { firstTurn: first.turn, spansTurns: this.crossTurn(remaining) })
            }
          }
        }
        this.groupOf.delete(i)
      }
    }
    // After the detach, the run's items stand alone: mark their search
    // entries dirty (the rebuilt group below re-marks the representative
    // when the run still merges). The defensive reflow path is O(run) —
    // rare, correctness-first.
    this.markSearchRangeDirty(start, end)
    if (start === end) return
    // Rebuild the whole run as one group. The result is assembled with one
    // final join so a long adjacent-read run stays linear in the cold path.
    const built = this.makeReadGroup(start, end)
    if (built === undefined) return
    for (const member of built.members) this.groupOf.set(member, built.group)
    this.groupMembers.set(built.group, built.members)
    this.groupMeta.set(built.group, { firstTurn: built.firstTurn, spansTurns: built.spansTurns })
       this.addGroupedTurn(built.group.turn)
    // The whole run collapsed into one output card.
    this.groupedToolCount -= built.members.length - 1
    if (built.spansTurns) this.crossTurnGroups += 1
    // The rebuilt group's representative may have MOVED (a late settle can
    // extend the run backwards): mark the whole run dirty so the lazy
    // normalization re-derives every entry from its current card.
    this.markSearchRangeDirty(start, end)
  }

  /** Whether the members at these indices span more than one turn. */
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
        this.liveAssistantBlocks.set(key, new Map())
        const thinking = this.thinkingEntries.get(key)
        if (thinking !== undefined && thinking.running === false) {
          thinking.text = ''
          thinking.running = true
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
        this.applyAssistantChunk(input.turn, input.step, input.chunk)
        break
      case 'end':
        // An abandoned attempt has no durable settlement and is tombstoned.
        // A committed `assistant/attempt` keeps its durable evidence visible
        // as transient until `llm/retry` or `turn/end`; `assistant/message`
        // owns the normal settled surface entry.
        this.liveAssistantBlocks.delete(stepKey(input.turn, input.step))
        if (input.status === 'abandoned') {
          this.settleFailedAttempt(input.turn, input.step, true, true)
        }
        // Any remaining open reasoning entries stop animating at settlement.
        {
          const open = this.openThinkingByTurn.get(input.turn)
          if (open !== undefined) {
            for (const entry of open) entry.running = false
            this.openThinkingByTurn.delete(input.turn)
          }
        }
        break
    }
  }

  /** Tombstone one transient assistant entry at a retry boundary. The
   * first-token timing and usage live in their separate folds and are not
   * touched here; only the presentation state is reset. */
  private hideTransientAssistantEntry(turn: number, step: number): void {
    const key = stepKey(turn, step)
    const entry = this.assistantEntries.get(key)
    if (entry === undefined || !this.transientAssistantEntries.has(entry)) return
    this.assistantEntries.delete(key)
    entry.text = ''
    entry.content = undefined
    entry.interrupted = undefined
    this.transientAssistantEntries.delete(entry)
    this.attemptAssistantEntries.delete(entry)
    this.hiddenAssistantEntries.add(entry)
    this.markStreamingEntryDirty(`assistant:${key}`)
    this.removeGroupedTurn(entry.turn)
  }

  /** A failed live attempt has no durable evidence and is therefore
   * tombstoned. A committed `assistant/attempt` is restored separately and
   * remains available as interruption evidence until retry/turn end. */
  private settleFailedAttempt(turn: number, step: number, abandoned = false, discardUsage = true): void {
    if (abandoned) this.hideTransientAssistantEntry(turn, step)
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
      const candidate = activity.messageCandidate
      if (candidate !== undefined && candidate.step === step
        && !activity.settledSteps.has(step) && !activity.confirmedSteps.has(step)) {
        activity.messageCandidate = undefined
        this.syncMessage(activity)
        activity.revision += 1
      }
    }
    this.syncUsage(activity)
  }

  /** Fold one live assistant chunk (Session v2 transient plane) into the
   * streaming entries and Focus aggregation. Live block state is retained per
   * logical step so a completed block can replace earlier deltas exactly. */
  private applyAssistantChunk(turn: number, step: number, chunk: AssistantLiveChunk): void {
    // After turn/end a late assistant event is a replay artifact: it
    // must not mutate the finalized surface entry — the final-answer
    // selection reads the exact last assistant (review finding).
    const activity = this.activityFor(turn)
    const key = stepKey(turn, step)
    if (activity.completed) return
    // A late reasoning replay remains diagnostic transcript evidence, but a
    // late text/block surface frame must never overwrite the durable message.
    if (activity.settledSteps.has(step)) {
      if (chunk.type === 'reasoning-delta') {
        const thinking = this.thinkingEntry(turn, step)
        thinking.text += chunk.text
        thinking.running = false
        this.closeThinking(thinking)
        this.markStreamingEntryDirty(`thinking:${key}`)
        this.foldThinking(activity, step, chunk.text)
      } else if (chunk.type === 'block-end' && chunk.block.type === 'reasoning' && 'text' in chunk.block && typeof chunk.block.text === 'string') {
        const thinking = this.thinkingEntry(turn, step)
        thinking.text = chunk.block.text
        thinking.running = false
        this.closeThinking(thinking)
        this.markStreamingEntryDirty(`thinking:${key}`)
        this.restoreThinkingPreview(activity, step, chunk.block.text)
      } else if (chunk.type === 'usage') {
        this.usage.onUsageChunk(turn, step, chunk.usage)
        this.syncUsage(activity)
      }
      return
    }
    const existing = this.assistantEntries.get(key)
    if (existing !== undefined && this.attemptAssistantEntries.has(existing)) return
    const blocks = this.liveBlocksFor(turn, step)
    switch (chunk.type) {
      case 'block-start':
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta':
      case 'block-end':
        applyAssistantBlockChunk(blocks, chunk)
        this.syncLiveAssistantPresentation(turn, step)
        break
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

  /** Return the current live block state in stable upstream index order. */
  private liveBlocksFor(turn: number, step: number): Map<number, AssistantBlockState> {
    const key = stepKey(turn, step)
    let blocks = this.liveAssistantBlocks.get(key)
    if (blocks === undefined) {
      blocks = new Map()
      this.liveAssistantBlocks.set(key, blocks)
    }
    return blocks
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

  /** Project the current live block map without duplicating block-end text. */
  private syncLiveAssistantPresentation(turn: number, step: number): void {
    const key = stepKey(turn, step)
    const blocks = assistantContentFromBlocks(this.liveBlocksFor(turn, step))
    const text = textOf(blocks)
    const activity = this.activityFor(turn)
    const visibleNow = assistantBlocksVisibleNow(blocks)
    if (step >= (activity.lastAssistantStep ?? -1)) activity.lastAssistantVisible = visibleNow
    const entry = this.assistantEntries.get(key)
    if (!visibleNow) {
      if (entry !== undefined && this.transientAssistantEntries.has(entry)) this.hideTransientAssistantEntry(turn, step)
      this.replaceMessageCandidate(activity, step, '')
    } else {
      const target = entry ?? this.assistantEntry(turn, step)
      this.transientAssistantEntries.add(target)
      this.attemptAssistantEntries.delete(target)
      this.hiddenAssistantEntries.delete(target)
      target.text = text
      target.content = blocks.some(block => block.type !== 'text') ? blocks : undefined
      target.interrupted = undefined
      this.markStreamingEntryDirty(`assistant:${key}`)
      this.replaceMessageCandidate(activity, step, text)
    }

    const reasoning = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
      .map(block => block.text)
      .join('')
    const thinkingKey = `thinking:${key}`
    if (reasoning === '') {
      this.hideThinkingEntry(turn, step)
      this.clearThinkingPreview(this.activityFor(turn), step)
      return
    }
    const thinking = this.thinkingEntry(turn, step)
    this.hiddenThinkingEntries.delete(thinking)
    thinking.text = reasoning
    thinking.running = true
    this.markStreamingEntryDirty(thinkingKey)
    this.restoreThinkingPreview(this.activityFor(turn), step, reasoning)
  }

  /** Reconstruct the authoritative assistant blocks from one compact stream.
   * The durable path intentionally uses the same indexed state accumulator as
   * live input, so partial attempt evidence and block-end replacement cannot
   * drift between live and cold replay. */
  private assistantBlocksFromStream(stream: readonly unknown[]): ContentBlock[] {
    const blocks = new Map<number, AssistantBlockState>()
    for (const member of expandAssistantStream(stream as Parameters<typeof expandAssistantStream>[0])) {
      const chunk = member.chunk
      switch (chunk.type) {
        case 'block-start':
        case 'text-delta':
        case 'reasoning-delta':
        case 'tool-call-delta':
        case 'block-end':
          applyAssistantBlockChunk(blocks, chunk)
          break
        case 'usage':
        case 'finish':
          break
      }
    }
    return assistantContentFromBlocks(blocks)
  }

  /** Restore a SETTLED thinking entry from a durable embedded stream
   * (Session v2 cold replay — `assistant/message.stream` /
   * `assistant/attempt.stream`). The canonical DSH decoder expands every
   * compact representation, and block-end remains authoritative. */
  private restoreThinkingFromStream(turn: number, step: number, stream: readonly unknown[]): void {
    const text = this.assistantBlocksFromStream(stream)
      .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
      .map(block => block.text)
      .join('')
    const key = stepKey(turn, step)
    if (text === '') {
      this.hideThinkingEntry(turn, step)
      const activity = this.activityByTurn.get(turn)
      if (activity !== undefined) this.clearThinkingPreview(activity, step)
      return
    }
    const entry = this.thinkingEntry(turn, step)
    this.hiddenThinkingEntries.delete(entry)
    entry.text = text
    this.markStreamingEntryDirty(`thinking:${key}`)
    this.closeThinking(entry)
    this.restoreThinkingPreview(this.activityFor(turn), step, text)
  }

  /** Restore assistant interruption evidence from a durable attempt. Text and
   * finalized non-text blocks are retained; reasoning remains in the Think
   * entry. Tool-call-only content is retained as hidden evidence until the
   * closed boundary. The attempt entry is still transient so `llm/retry` can
   * reset it. */
  private restoreAssistantAttempt(turn: number, step: number, stream: readonly unknown[]): void {
    const blocks = this.assistantBlocksFromStream(stream)
    const visibleNow = assistantBlocksVisibleNow(blocks)
    const hasEvidence = assistantBlocksHaveInterruptionEvidence(blocks)
    const text = textOf(blocks)
    const key = stepKey(turn, step)
    const existing = this.assistantEntries.get(key)
    if (!visibleNow && !hasEvidence) {
      // A live prefix may be the only evidence when the compact settlement
      // carries no visible blocks. Keep that prefix as attempt evidence
      // instead of promoting it to a normal settled message.
      if (existing !== undefined && this.transientAssistantEntries.has(existing)) {
        this.attemptAssistantEntries.add(existing)
      }
      return
    }
    const entry = existing ?? this.assistantEntry(turn, step)
    this.hiddenAssistantEntries.delete(entry)
    this.transientAssistantEntries.add(entry)
    this.attemptAssistantEntries.add(entry)
    entry.text = text
    entry.content = blocks.some(block => block.type !== 'text') ? blocks : undefined
    entry.interrupted = undefined
    this.markStreamingEntryDirty(`assistant:${key}`)
    // Assistant block visibility can change independently of entry ownership;
    // defer the grouped-turn projection to its next bounded rebuild.
    this.groupedTurnIndexDirty = true
  }

  /** Mark durable attempt evidence visible at the closed boundary. Empty and
   * reasoning-only attempts remain hidden; tool-call and generic finalized
   * blocks become interrupted assistant evidence here, not while running. */
  private markAttemptEvidenceInterrupted(turn: number): void {
    for (const item of this.items) {
      if (item.kind !== 'assistant' || item.turn !== turn || !this.attemptAssistantEntries.has(item)) continue
      if (!assistantBlocksHaveInterruptionEvidence(assistantEntryBlocks(item))) continue
      if (this.hiddenAssistantEntries.has(item)) continue
      item.interrupted = true
       this.groupedTurnIndexDirty = true
    }
  }

  /** Restore a SETTLED thinking entry from the reasoning blocks of a
   * durable assistant message (Session v2 cold replay — the assembled
   * `message.content` carries `reasoning` blocks the live plane streamed
   * as deltas). The durable message is authoritative: it replaces any
   * earlier same-step reasoning, including replacing it with no entry. */
  private restoreThinkingFromMessage(turn: number, step: number, blocks: readonly ContentBlock[]): void {
    const key = stepKey(turn, step)
    let text = ''
    for (const block of blocks) {
      if (block.type === 'reasoning') text += block.text
    }
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
    const entry = this.thinkingEntry(turn, step)
    this.hiddenThinkingEntries.delete(entry)
    entry.text = text
    this.markStreamingEntryDirty(`thinking:${key}`)
    this.closeThinking(entry)
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
    for (let index = 0; index < this.items.length; index += 1) {
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
    for (let index = itemStart; index <= itemEnd; index += 1) {
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

     if (range === undefined) return { messages: [], hasOlder: false, hasNewer: false }
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
       const allTurns = [...new Set(full.filter(message => 'turn' in message).map(message => message.turn))]
         .sort((a, b) => a - b)

      const messages = windowMessages(full, maxTurns, options.endTurn)
       const visibleSet = new Set(messages.filter(message => 'turn' in message).map(message => message.turn))
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

  /** The search-projection revision: bumped on EVERY entry mutation
   * (append, settlement, group reflow). The runner's query refinement must
   * never reuse previous candidates across a revision — the projection may
   * hold new matches the old candidate list cannot see. */
  searchRevision(): number {
    return this.searchRevisionCounter
  }

  /** Full-history transcript search over the lightweight projection — same
   * corpus and ORDER as the legacy full search (`messages()` + filter +
   * per-message lowercase), but never materializes the grouped transcript
   * and never re-lowercases history per query. Results are deduplicated by
   * CURRENT group representative: a merged read card yields exactly ONE
   * visible match no matter how many members hit, and Next/Prev never loop
   * on one card. `refinement` (optional) narrows a previous result set when
   * the new query extends it AND the projection revision is unchanged —
   * otherwise the full lightweight scan runs.
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
      if (!entry.normalizedText.includes(needle)) return
      if (seen.has(representative)) return
      seen.add(representative)
      matches.push({ id: representative, turn: entry.turn })
    }
    if (canRefine) {
      for (const match of refinement.previousMatches) consider(match.id)
      this.searchRefineCount += 1
    } else {
      for (let id = 0; id < this.searchEntries.length; id += 1) consider(id)
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
  } {
    return {
      entries: this.searchEntries.length,
      groupingRebuilds: this.groupingRebuildCount,
      normalizedRefreshes: this.searchRefreshCount,
      dirtyScans: this.searchDirtyScanCount,
      fullScans: this.searchFullScanCount,
      refinedScans: this.searchRefineCount,
    }
  }

  /** Remove one thinking entry from the open-lifecycle index. */
  private closeThinking(entry: Extract<TranscriptMessage, { kind: 'thinking' }>): void {
    entry.running = false
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
    entry.text = ''
    this.closeThinking(entry)
    this.thinkingEntries.delete(key)
    if (!this.hiddenThinkingEntries.has(entry)) {
      this.hiddenThinkingEntries.add(entry)
      this.markStreamingEntryDirty(`thinking:${key}`)
      this.removeGroupedTurn(entry.turn)
    }
  }

  /** Reset same-step presentation at the scheduled retry boundary. The
   * separate usage fold intentionally remains untouched so first-token timing
   * and committed usage span the retry wait. */
  private resetThinkingForRetry(turn: number, step: number): void {
    this.liveAssistantBlocks.delete(stepKey(turn, step))
    this.hideTransientAssistantEntry(turn, step)
    this.hideThinkingEntry(turn, step)
    const activity = this.activityByTurn.get(turn)
    if (activity === undefined) return
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

  /** Settle only the thinking entries owned by one ended turn. */
  private closeThinkingForTurn(turn: number): void {
    const open = this.openThinkingByTurn.get(turn)
    if (open === undefined) return
    for (const entry of open) entry.running = false
    this.openThinkingByTurn.delete(turn)
  }

  /** The thinking entry object for one (turn, step), created on first reasoning. */
  private thinkingEntry(turn: number, step: number): Extract<TranscriptMessage, { kind: 'thinking' }> {
    const key = stepKey(turn, step)
    let entry = this.thinkingEntries.get(key)
    if (entry === undefined) {
      entry = { kind: 'thinking', turn, text: '', running: true }
      this.thinkingEntries.set(key, entry)
      this.searchIndexByStepKey.set(`thinking:${key}`, this.appendItem(entry))
      let open = this.openThinkingByTurn.get(turn)
      if (open === undefined) {
        open = new Set()
        this.openThinkingByTurn.set(turn, open)
      }
      open.add(entry)
    }
    return entry
  }

  /** The assistant entry object for one (turn, step), created on first text. */
  private assistantEntry(turn: number, step: number): Extract<TranscriptMessage, { kind: 'assistant' }> {
    const key = stepKey(turn, step)
    let entry = this.assistantEntries.get(key)
    if (entry === undefined) {
      entry = { kind: 'assistant', turn, text: '' }
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
    event: { type: string; data: Record<string, unknown> },
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
      this.appendItem({ kind: 'compaction', turn: this.currentTurn, text: '', items: 0, tokens: 0, running: true })
      index = this.items.length - 1
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
    if (isReplacementSurfaceEvent(event)) return
    // Compaction lifecycle events are typed STRUCTURALLY: dsh-compaction
    // is not a peer dependency, so its session-event augmentation never
    // enters our type graph (the same pattern as the structural service
    // types). An unknown event type is otherwise skipped by the switch.
    const kind = event.type as string
    if (kind === 'compaction/start' || kind === 'compaction/summary' || kind === 'compaction/end' || kind === 'session/end-seed') {
      this.applyCompactionEvent(event as { type: string; data: Record<string, unknown> }, kind)
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
      if (this.activityByTurn.get(data.turn)?.completed === true) return
      const stream = data.stream ?? []
      this.liveAssistantBlocks.delete(stepKey(data.turn, data.step))
      this.restoreAssistantAttempt(data.turn, data.step, stream)
      this.usage.onAssistantAttempt(data.turn, data.step, usageFromAssistantSettlement('attempt', undefined, stream))
      const activity = this.activityFor(data.turn)
      const key = stepKey(data.turn, data.step)
      // The durable embedded stream is COMPLETE and authoritative for
      // reasoning; overwrite any live partial so cold replay matches the
      // settled attempt. A later retry resets this evidence at llm/retry.
      this.restoreThinkingFromStream(data.turn, data.step, stream)
      this.syncUsage(activity)
      const thinking = this.thinkingEntries.get(key)
      if (thinking !== undefined && thinking.running) this.closeThinking(thinking)
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
        this.usage.onStepStart(event.data.turn, event.data.step)
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
        this.usage.onStepEnd(event.data.turn, event.data.step)
        this.syncUsage(activity)
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
        activity.completed = false
        activity.reason = undefined
        activity.revision += 1
        break
      }
      case 'user/message': {
        const blocks = event.data.content
        // User messages keep an inline `🖼️ name` marker at every image's
        // position in the FLAT text too (textWithImageMarkers): the search
        // and loader-less rendering paths consume `text`, and a mixed
        // message must never read as if the image was not there. The
        // ordered `content` blocks stay the canonical form for thumbnails.
        const text = textWithImageMarkers(blocks)
        if (text === '' && !blocks.some(block => block.type === 'image')) break
        // Only direct human prompts are user messages; plugin-injected
        // context (system reminders, skill content) folds into a collapsible
        // system entry.
        if (event.data.source.kind === 'user') {
          this.appendItem({ kind: 'user', turn: this.currentTurn, text, content: blocks })
        } else {
          // Injected context: name the producer the way the Web row does
          // (contextProvenance), plus a notice form's one-line account. The
          // fold stores the icon SEMANTIC (never the concrete glyph), so a
          // live icon-style switch repaints already-folded cards.
          const provenance = contextProvenance(event.data.source)
          const summary = contextSummary(event.data.source)
          this.appendItem({
            kind: 'system',
            turn: this.currentTurn,
            text,
            ...provenance.label === null ? {} : { label: provenance.label },
            ...summary === null ? {} : { summary },
            icon: contextIconSemantic(event.data.source),
          })
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
        this.liveAssistantBlocks.delete(key)
        const messageUsage = usageFromAssistantSettlement('message', event.data.usage, event.data.stream)
        const alreadySettled = activity.settledSteps.has(event.data.step)
        const messageBlocks = event.data.message.content
        const text = textOf(messageBlocks)
        const entry = this.assistantEntries.get(key)
        if (entry !== undefined) {
          entry.text = text
          // The durable message takes over the live/attempt entry: it is no
          // longer transient, so retry cleanup can never remove settled text.
          this.transientAssistantEntries.delete(entry)
          this.attemptAssistantEntries.delete(entry)
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
          // ALWAYS preserve the entry — an empty settled message with no
          // preceding chunk (replay edge) must still own the exact-last
          // assistant slot, so the final selection never falls back to an
          // earlier answer (review finding).
          const created: TranscriptMessage = {
            kind: 'assistant',
            turn: event.data.turn,
            text,
            ...(messageBlocks.some(block => block.type !== 'text') ? { content: messageBlocks } : {}),
            ...(event.data.interrupted === true ? { interrupted: true as const } : {}),
          }
          this.assistantEntries.set(key, created)
          // The created entry must register its search index too: a later
          // replay replacement or text delta mutates this entry in place
          // and must be able to refresh its searchable entry (review
          // finding — the streaming-created path already registers).
          this.searchIndexByStepKey.set(`assistant:${key}`, this.appendItem(created))
        }
        // The step is complete: its thinking entry stops streaming and leaves
        // the open-lifecycle index, so a later turn/end never revisits it.
        // On a COLD replay no live reasoning deltas ever arrived — the
        // assembled `reasoning` blocks in the durable message restore the
        // settled thinking entry (Session v2 embedded-stream parity).
        this.restoreThinkingFromMessage(event.data.turn, event.data.step, messageBlocks)
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
        // A message of a DIFFERENT step than the open candidate proves the
        // earlier step's output was intermediate: confirm it first (plan
        // §5.3 C — a later step's output confirms the earlier candidate).
        const priorLast = activity.lastAssistantStep ?? -1
        if (event.data.step >= priorLast) {
          activity.lastAssistantVisible = event.data.interrupted === true || assistantBlocksVisibleNow(messageBlocks)
        }
        const prior = activity.messageCandidate
        // Only a message for a NEWER step confirms the open candidate
        // (plan §5.3 C); a message for an older step is stale and must
        // never confirm a still-streaming candidate (review finding).
        if (prior !== undefined && prior.step < event.data.step) {
          this.confirmMessageCandidate(activity)
        }
        // Monotonic: a late event for an older step never regresses the
        // last assistant step — the final-answer dedup depends on it
        // (review finding).
        activity.lastAssistantStep = Math.max(priorLast, event.data.step)
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
        } else if (event.data.step < priorLast) {
          // A late message for an older step that was never a candidate:
          // stale — ignore it entirely (review finding).
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
        this.syncMessage(activity)
        this.usage.onAssistantMessage(event.data.turn, event.data.step, messageUsage)
        // Settled Assistant content can become hidden without deleting its
        // authoritative entry; rebuild bounded turn projections lazily.
        this.groupedTurnIndexDirty = true
        this.syncUsage(activity)
        activity.revision += 1
        break
      }
      case 'tool/call': {
        const key = event.data.callId
        this.callNames.set(key, event.data.name)
        // The call's OWN turn (event.data.turn) — never this.currentTurn:
        // a turn-start-less replay fragment must still attribute the call
        // to the right turn (review finding).
        const callTurn = event.data.turn
        const card: TranscriptMessage = {
          kind: 'tool',
          turn: callTurn,
          name: event.data.name,
          args: event.data.arguments,
          result: '',
          status: 'running',
        }
        this.appendItem(card)
        this.pendingCalls.set(key, {
          name: event.data.name,
          args: event.data.arguments,
          turn: callTurn,
          card,
          index: this.items.length - 1,
        })
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
          activity.toolCalls += 1
          activity.tools.set(event.data.name, (activity.tools.get(event.data.name) ?? 0) + 1)
          this.confirmMessageCandidate(activity)
          this.syncMessage(activity)
          activity.tool = {
            callId: event.data.callId,
            name: event.data.name,
            args: event.data.arguments,
            status: 'running',
          }
          activity.revision += 1
        }
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const key = block?.toolCallId
        const pending = key !== undefined ? this.pendingCalls.get(key) : undefined
        const name = key === undefined ? 'tool' : (this.callNames.get(key) ?? 'tool')
        const text = textOf(block?.content ?? [])
        const status = event.data.error !== undefined || block?.isError === true ? 'error' : 'ok'
        // The result's OWN turn (event.data.turn) when no pending call
        // pairs it — never this.currentTurn: an orphan result of a replay
        // fragment must not land in the stale current turn (review
        // finding).
        const turn = pending?.turn ?? event.data.turn
        this.pendingCalls.delete(key ?? '')
        if (key !== undefined) this.callNames.delete(key)
        if (pending !== undefined) {
          // The call's own running card: parallel same-name calls pair
          // correctly because the card is keyed by callId, not by name.
          const card = pending.card
          card.status = status
          card.result = text
          card.args = pending.args
          card.turn = turn
          // Raw result data for the tool-owned presentation (presentResult).
          card.resultBlocks = block?.content
          card.meta = event.data.meta
          card.error = event.data.error
          // The result text landed: mark the search entry dirty (lazy
          // normalization; the grouping hooks below mark the merged
          // representative when the read joins a group).
          this.markSearchEntryDirty(pending.index)
          // A settled read may now be groupable: reflow the run it belongs
          // to (bounded by the nearest non-read cards).
          this.scheduleGrouping(pending.index)
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
              running.resultBlocks = block?.content
              running.meta = event.data.meta
              running.error = event.data.error
              this.markSearchEntryDirty(runningIndex)
              this.scheduleGrouping(runningIndex)
            }
          } else {
            this.appendItem({ kind: 'tool', turn, name, args: '', result: text, status, resultBlocks: block?.content, meta: event.data.meta, error: event.data.error })
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
      case 'turn/end': {
        // Idempotent: a replayed turn/end must not re-append the
        // synthetic cards or re-settle the activity (review finding).
        const endActivity = this.activityFor(event.data.turn)
        if (endActivity.completed) break
        // Every still-open thinking entry of THIS turn stops streaming when
        // the turn closes (interrupted steps never see their
        // assistant/message). Settled entries were removed when their
        // assistant/message arrived, so this is proportional to the open
        // work rather than to the full history.
        // The synthetic cards carry the EVENT's own turn — never
        // this.currentTurn: a turn-start-less fragment's end must land in
        // its own turn (review finding).
        const endTurn = event.data.turn
        for (const key of this.liveAssistantBlocks.keys()) {
          if (key.startsWith(`${endTurn}/`)) this.liveAssistantBlocks.delete(key)
        }
        this.markAttemptEvidenceInterrupted(endTurn)
        this.closeThinkingForTurn(endTurn)
        if (event.data.reason.kind === 'error') {
          // Defensive: a malformed/legacy reason without the error detail
          // degrades to the bare marker instead of crashing the fold
          // (plan §10.2 — Focus aggregates the same events).
          const error = event.data.reason.error
          this.appendItem({ kind: 'tool', turn: endTurn, name: 'error', args: '', result: error === undefined ? 'error' : `${error.code}: ${error.message}`, status: 'error' })
        } else if (event.data.reason.kind === 'aborted') {
          this.appendItem({ kind: 'tool', turn: endTurn, name: 'interrupted', args: '', result: 'cancelled by user', status: 'error' })
        } else if (event.data.reason.kind === 'max-tokens') {
          this.appendItem({ kind: 'system', turn: endTurn, text: 'max tokens reached — output truncated' })
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
              message: typeof reasonError.message === 'string' ? reasonError.message : String(reasonError.message ?? ''),
            },
          }),
        }
        // Focus aggregation: turn/end resolves the Message slot (final
        // answer dedup — plan §5.5/§22), finalizes any still-open steps'
        // usage (so the per-turn total and the session total agree even
        // when turn/end arrives with open steps — review finding), and
        // settles the token display.
        this.resolveMessageAtTurnEnd(activity)
        this.usage.onTurnEnd(event.data.turn)
        this.syncUsage(activity)
        activity.revision += 1
        break
      }
      case 'tool-workflow/run-start': {
        const card: Extract<TranscriptMessage, { kind: 'tool' }> = {
          kind: 'tool',
          turn: this.currentTurn,
          name: 'workflow',
          args: event.data.name,
          result: '',
          status: 'running',
          members: [],
        }
        this.workflowRuns.set(event.data.runId, card)
        this.workflowRunIndex.set(event.data.runId, this.appendItem(card))
        // Focus aggregation: a workflow run is a durable lifecycle event,
        // NOT a model tool/call — it never touches the Tool slot or the
        // tool count (plan §17).
        break
      }
      case 'tool-workflow/agent-start': {
        const { runId, seq, label, phase } = event.data
        const run = this.workflowRuns.get(runId)
        // The member folds INTO the run card (Web WorkflowRunPanel parity):
        // phase grouping happens at render time over the arrival-ordered rows.
        const member: WorkflowMemberView = {
          label,
          ...phase === undefined ? {} : { phase },
          status: 'running',
        }
        this.workflowMembers.set(`${runId}/${seq}`, member)
        run?.members?.push(member)
        break
      }
      case 'tool-workflow/agent-end': {
        const member = this.workflowMembers.get(`${event.data.runId}/${event.data.seq}`)
        const outcome = event.data.outcome
        if (member !== undefined) {
          member.status = outcome === 'completed' ? 'ok' : 'error'
        }
        break
      }
      case 'tool-workflow/run-end': {
        const card = this.workflowRuns.get(event.data.runId)
        if (card !== undefined) {
          card.status = event.data.stopReason === 'completed' ? 'ok' : 'error'
          card.result = `stop: ${event.data.stopReason}`
          // The run result became searchable: mark the entry dirty (lazy).
          const index = this.workflowRunIndex.get(event.data.runId)
          if (index !== undefined) this.markSearchEntryDirty(index)
        }
        // The run's bookkeeping is done: drop the run card and every member
        // card keyed under it so long sessions do not accumulate stale maps.
        this.workflowRuns.delete(event.data.runId)
        this.workflowRunIndex.delete(event.data.runId)
        for (const memberKey of this.workflowMembers.keys()) {
          if (memberKey.startsWith(`${event.data.runId}/`)) this.workflowMembers.delete(memberKey)
        }
        break
      }
      case 'llm/retry': {
        const { retry, delayMs, failure, turn, step } = event.data
        if (this.activityByTurn.get(turn)?.completed === true) break
        // The scheduled retry is the presentation reset boundary. It hides
        // the failed attempt immediately, while the later retry-started event
        // only opens the next usage replacement slot.
        this.resetThinkingForRetry(turn, step)
        const maxRetries = 'maxRetries' in event.data ? event.data.maxRetries : undefined
        const label = maxRetries === undefined
          ? `llm retry ${retry} in ${Math.round(delayMs / 1000)}s`
          : `llm retry ${retry}/${maxRetries} in ${Math.round(delayMs / 1000)}s`
        this.appendItem({ kind: 'system', turn, text: `${label} — ${failure.code}: ${failure.message}` })
        // Focus aggregation: retries are orchestration, not a Tool — they
        // stay in the expanded process and never touch the Tool slot
        // (plan §16.2).
        break
      }
      case 'command/run': {
        this.commandNames.set(event.data.commandId, event.data.name)
        break
      }
      case 'command/done': {
        const name = this.commandNames.get(event.data.commandId) ?? 'command'
        this.commandNames.delete(event.data.commandId)
        // Success text (e.g. "title set: x") carries the command's settlement
        // message; errors prefix it with the failure marker.
        const outcome = event.data.kind === 'error'
          ? ` — error: ${event.data.text ?? 'failed'}`
          : event.data.text === undefined || event.data.text === ''
            ? ''
            : ` — ${event.data.text}`
        this.appendItem({ kind: 'tool', turn: this.currentTurn, name: `/${name}`, args: '', result: `executed${outcome}`, status: event.data.kind === 'error' ? 'error' : 'ok' })
        break
      }
      case 'subagent/descriptor': {
        // Durable delegation record: one card per subagent launch.
        const { label, mode, provider } = event.data
        const model = 'agentModel' in event.data ? event.data.agentModel : undefined
        const result = [
          mode !== undefined ? `mode: ${mode}` : '',
          provider !== undefined ? `provider: ${provider}` : '',
          model !== undefined ? `model: ${model}` : '',
        ].filter(part => part !== '').join(' · ')
        this.appendItem({
          kind: 'tool',
          turn: this.currentTurn,
          name: 'subagent',
          args: label ?? 'subagent',
          result,
          status: 'ok',
        })
        // Focus aggregation: a delegation record is a durable lifecycle
        // event, NOT a model tool/call — it never touches the Tool slot or
        // the tool count (plan §17).
        break
      }
      default:
        break
    }
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
 * A child session's OWN events: everything after the LAST
 * `session/end-seed` marker. The fork provider seeds a child with the
 * PARENT's completed-turn prefix (upstream: "a fork seed replays the
 * parent's log"), so the child log's pre-marker events are the parent's
 * history — parent completion notices included. The subagent viewer must
 * never render them as the child's transcript. Spawned children have no
 * seed and no marker: everything is their own. A resumed child carries a
 * second marker (its stored log becomes the new seed), so the LAST marker
 * is the boundary.
 */
export function childOwnEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  let cut = 0
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.type === 'session/end-seed') cut = index + 1
  }
  return cut === 0 ? events : events.slice(cut)
}

/** Render one session's log as a readable markdown transcript for `/export md`. */
/** The markdown projection of content blocks (review finding 4): text
 * blocks verbatim, image blocks as a compact `🖼️` line (U+FE0F marker,
 * same convention as the transcript and queue summaries) with the durable
 * attachment id — the binary is NEVER embedded, and an image-only message
 * still renders a User/Assistant section. */
function markdownContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      parts.push(buffer)
      buffer = ''
    }
  }
  for (const block of blocks) {
    if (block.type === 'text') {
      buffer += block.text
    } else if (block.type === 'image') {
      flush()
      const attachment = block.attachment
      parts.push(`> 🖼️ ${attachment.name ?? 'image'} · ${attachment.width}×${attachment.height} · attachment \`${attachment.attachmentId}\``)
    }
  }
  flush()
  return parts.join('\n\n')
}

export function renderTranscriptMarkdown(session: {
  header: SessionHeader
  snapshotEvents(): readonly SessionEvent[]
}): string {
  const lines: string[] = [
    `# Session ${session.header.id}`,
    `- cwd: ${session.header.cwd ?? 'unknown'}`,
    ...session.header.agentPreset === undefined
      ? []
      : [`- agent preset: ${session.header.agentPreset}`],
    '',
  ]
  // Alpha.4 Session shape: the event log arrives as a snapshot read, never a
  // live array — the markdown export is a full-log fold by definition.
  for (const event of session.snapshotEvents()) {
    // The same append-origin contract as the transcript fold: a surface
    // replacement is a model-only rewrite (pruned tool result, compaction
    // summary checkpoint) and must never be replayed in a human-facing
    // export — the append-origin original is already rendered at its log
    // position. Unmarked legacy events keep their current behavior.
    if (isReplacementSurfaceEvent(event)) continue
    switch (event.type) {
      case 'user/message': {
        const text = markdownContent(event.data.content)
        if (text !== '') lines.push(`## User\n\n${text}\n`)
        break
      }
      case 'assistant/message': {
        const text = markdownContent(event.data.message.content)
        if (text !== '') lines.push(`## Assistant\n\n${text}\n`)
        break
      }
      case 'tool/call': {
        const args = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments)
        lines.push(`### Tool ${event.data.name}\n\n\`\`\`json\n${args}\n\`\`\`\n`)
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const text = markdownContent(block?.content ?? [])
        if (text !== '') lines.push(`<details><summary>result</summary>\n\n${text}\n\n</details>\n`)
        break
      }
      case 'command/run': {
        lines.push(`> /${event.data.name}${event.data.args === '' ? '' : ` ${event.data.args}`}\n`)
        break
      }
      default:
        break
    }
  }
  return lines.join('\n')
}
