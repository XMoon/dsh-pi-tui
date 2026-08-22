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
 * `TranscriptFolder` is the stateful engine: call `apply` with appended
 * events and read the message list; `foldTranscript` is the one-shot
 * wrapper. Both support an optional display window (`maxTurns`): turns older
 * than the window collapse into one summary entry, bounding the rendered
 * component tree on long sessions.
 * @module @xmoon76/dsh-pi-tui/transcript
 */

import type { SessionEvent, SessionHeader, JsonValue } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { contextEmoji, contextProvenance, contextSummary } from './context.ts'
// The command/run + command/done event merge (SessionEventMap extension).
import type {} from '@deepseek-ai/dsh-commands'
// The subagent/descriptor event merge (SessionEventMap extension).
import type {} from '@deepseek-ai/dsh-subagent'
// The workflow run/member event merges (SessionEventMap extension).
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
// The llm/retry + llm/retry-started event merges (SessionEventMap extension).
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
  | { kind: 'assistant'; turn: number; text: string; content?: readonly ContentBlock[] }
  | { kind: 'thinking'; turn: number; text: string; /** Still streaming reasoning deltas for its step. */ running?: boolean }
  /**
   * Injected context (system reminders, skill content) from non-user sources.
   * Labeled entries carry the Web-provenance producer name (e.g. AGENTS.md,
   * @deepseek-ai/dsh-system-prompt, skill-catalog), a source-kind emoji, and,
   * for notice forms, the producer's one-line summary.
   */
  | { kind: 'system'; turn: number; text: string; label?: string; summary?: string; emoji?: string }
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

/** Text of a message's content blocks, joined; empty when there is no text. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Flat text with image positions preserved: text blocks verbatim, image
 * blocks as an inline `🖼️ name` marker AT their position (the queue-preview
 * format; U+FE0F keeps the marker 2 cells wide in emoji fonts). The
 * structured `content` blocks stay the canonical form for thumbnail
 * rendering; this projection feeds the flat-text consumers (transcript
 * search, loader-less fallback rendering) so a mixed message never reads
 * as if the image was not there, and an image-only message is not empty.
 * Identical to {@link textOf} for text-only content. */
export function textWithImageMarkers(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'image') text += `🖼️ ${block.attachment.name ?? 'image'}`
  }
  return text
}

/** Key identifying one step's model output (turn + step). */
function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
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
export class TranscriptFolder {
  private readonly items: TranscriptMessage[] = []
  /** The assistant message object per (turn, step); streaming text lands in place. */
  private readonly assistantEntries = new Map<string, Extract<TranscriptMessage, { kind: 'assistant' }>>()
  /** The thinking entry object per (turn, step), for in-place text updates. */
  private readonly thinkingEntries = new Map<string, Extract<TranscriptMessage, { kind: 'thinking' }>>()
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
   * output); `groupMembers` maps a group card to its member indices. The
   * projection is maintained on append and on settle, so `messages()` never
   * re-walks the history to group — only the output list is built.
   */
  private readonly groupOf = new Map<number, Extract<TranscriptMessage, { kind: 'tool' }>>()
  private readonly groupMembers = new Map<Extract<TranscriptMessage, { kind: 'tool' }>, number[]>()

  /**
   * Turn index for the display window (stage J): the first item index of
   * every distinct turn, in log order. The window projection derives its
   * start and its summary counts from this + `groupedToolCount`, so
   * `messages({maxTurns})` never rescans the pre-window history. Turn
   * values are expected to be monotonic in log order; a non-monotonic log
   * (corrupt data) disables the fast path and falls back to the full scan.
   */
  private readonly turnStarts: number[] = []
  /** The grouped tool-card count (what `messages()` emits), maintained
   * incrementally for the window summary ("N tool calls" of the collapsed
   * history). */
  private groupedToolCount = 0
  /** Merged read groups whose members span MORE THAN ONE turn: their output
   * card carries only the max turn, so the raw-item turn index over-counts
   * the window summary. While any exist, the window path defers to the full
   * scan (correctness first; cross-turn read runs are rare). */
  private crossTurnGroups = 0
  private turnsMonotonic = true

  /** Append one folded message, maintaining the window projections. */
  private appendItem(message: TranscriptMessage): void {
    this.items.push(message)
    const turn = 'turn' in message ? message.turn : undefined
    if (turn !== undefined) {
      if (this.turnStarts.length === 0) {
        this.turnStarts.push(this.items.length - 1)
      } else {
        const lastMessage = this.items[this.turnStarts[this.turnStarts.length - 1]!]!
        const lastTurn = 'turn' in lastMessage ? lastMessage.turn : undefined
        if (lastTurn === undefined || turn > lastTurn) {
          this.turnStarts.push(this.items.length - 1)
        } else if (turn < lastTurn) {
          this.turnsMonotonic = false
        }
      }
    }
    if (message.kind === 'tool') this.groupedToolCount += 1
  }

  /** Whether an item is groupable as a consecutive read (settled ok). */
  private static groupable(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'tool' }> {
    return message.kind === 'tool' && message.name === 'read' && message.status === 'ok'
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
            this.groupedToolCount += members.length - 1
            if (this.crossTurn(members)) this.crossTurnGroups -= 1
          } else {
            this.groupMembers.set(group, remaining)
          }
        }
        this.groupOf.delete(i)
      }
    }
    if (start === end) {
      // A single groupable item: join the PRECEDING group when adjacent
      // (append or settle at the tail of a run).
      const prev = start > 0 ? this.items[start - 1] : undefined
      if (prev !== undefined && TranscriptFolder.groupable(prev)) {
        const prevGroup = this.groupOf.get(start - 1)
        if (prevGroup !== undefined) {
          const members = this.groupMembers.get(prevGroup)!
          const wasCross = this.crossTurn(members)
          members.push(start)
          this.groupOf.set(start, prevGroup)
          prevGroup.args = `${members.length} files`
          prevGroup.result = prevGroup.result === '' ? item.result : `${prevGroup.result}\n\n${item.result}`
          prevGroup.turn = Math.max(prevGroup.turn, item.turn)
          // Joining a same-turn group with a different-turn read makes it
          // cross-turn (the emitted card now spans two turns).
          if (!wasCross && this.crossTurn(members)) this.crossTurnGroups += 1
          return
        }
        // The previous item is a singleton read: promote it to a group.
        const group: Extract<TranscriptMessage, { kind: 'tool' }> = { ...prev }
        this.groupOf.set(start - 1, group)
        this.groupOf.set(start, group)
        this.groupMembers.set(group, [start - 1, start])
        group.args = '2 files'
        group.result = group.result === '' ? item.result : `${group.result}\n\n${item.result}`
        group.turn = Math.max(group.turn, item.turn)
        if (prev.turn !== item.turn) this.crossTurnGroups += 1
      }
      return
    }
    // Rebuild the whole run as one group. (The index variables are mutable,
    // so the type guard is re-applied to locals rather than the array
    // accesses, which TS cannot keep narrowed.)
    const first = this.items[start]!
    if (!TranscriptFolder.groupable(first)) return
    const group: Extract<TranscriptMessage, { kind: 'tool' }> = { ...first }
    const members: number[] = []
    const memberTurns = new Set<number>()
    for (let i = start; i <= end; i += 1) {
      const member = this.items[i]!
      if (!TranscriptFolder.groupable(member)) continue
      this.groupOf.set(i, group)
      members.push(i)
      memberTurns.add(member.turn)
      if (i > start) {
        group.result = group.result === '' ? member.result : `${group.result}\n\n${member.result}`
        group.turn = Math.max(group.turn, member.turn)
      }
    }
    group.args = `${members.length} files`
    this.groupMembers.set(group, members)
    // The whole run collapsed into one output card.
    this.groupedToolCount -= members.length - 1
    if (memberTurns.size > 1) this.crossTurnGroups += 1
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
      grouped.push(this.items[index]!)
    }
    return grouped
  }

  /**
   * The windowed projection: only the LAST `maxTurns` turns are walked —
   * the window start comes from the maintained turn index, and the summary
   * counts come from the incremental projections (turn count, item count,
   * grouped tool cards), so the per-frame cost no longer grows with the
   * pre-window history. A merged read group whose first member sits BEFORE
   * the window (its output card spans the boundary) falls back to the full
   * scan — the group's turn is the max of its members, so the full-scan
   * windowing semantics must decide its fate. Anchored windows (search
   * jumps) always use the full scan.
   */
  private windowedMessages(maxTurns: number): TranscriptMessage[] {
    const totalTurns = this.turnStarts.length
    if (!this.turnsMonotonic || totalTurns <= maxTurns || this.crossTurnGroups > 0) {
      return windowMessages(this.groupedMessages(), maxTurns)
    }
    const windowStart = this.turnStarts[totalTurns - maxTurns]!
    const kept: TranscriptMessage[] = []
    let windowTools = 0
    for (let index = windowStart; index < this.items.length; index += 1) {
      const group = this.groupOf.get(index)
      if (group !== undefined) {
        const members = this.groupMembers.get(group)
        if (members !== undefined && members[0] === index) {
          kept.push(group)
          if (group.kind === 'tool') windowTools += 1
        } else if (members !== undefined && members[0]! < windowStart) {
          // A merged group whose output point predates the window: the
          // full-scan path may keep or collapse it by its (max) turn, so
          // the incremental path must defer to the full scan for parity.
          return windowMessages(this.groupedMessages(), maxTurns)
        }
        continue
      }
      const message = this.items[index]!
      kept.push(message)
      if (message.kind === 'tool') windowTools += 1
    }
    const oldTurns = totalTurns - maxTurns
    const oldTools = this.groupedToolCount - windowTools
    const turnsText = `${oldTurns} earlier turn${oldTurns === 1 ? '' : 's'}`
    const toolsText = `${oldTools} tool call${oldTools === 1 ? '' : 's'}`
    kept.unshift({ kind: 'summary', text: `… ${turnsText} · ${toolsText} — window ${maxTurns} turns` })
    return kept
  }

  messages(options?: FoldOptions): TranscriptMessage[] {
    const maxTurns = options?.maxTurns
    if (maxTurns === undefined || maxTurns <= 0) return this.groupedMessages()
    // Anchored windows (transcript search) jump into history: the full scan
    // is fine there — this is never the per-frame path.
    if (options?.endTurn !== undefined) {
      return windowMessages(this.groupedMessages(), maxTurns, options.endTurn)
    }
    return this.windowedMessages(maxTurns)
  }

  /** The thinking entry object for one (turn, step), created on first reasoning. */
  private thinkingEntry(turn: number, step: number): Extract<TranscriptMessage, { kind: 'thinking' }> {
    const key = stepKey(turn, step)
    let entry = this.thinkingEntries.get(key)
    if (entry === undefined) {
      entry = { kind: 'thinking', turn, text: '', running: true }
      this.thinkingEntries.set(key, entry)
      this.appendItem(entry)
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
      this.appendItem(entry)
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
    // Compaction lifecycle events are typed STRUCTURALLY: dsh-compaction
    // is not a peer dependency, so its session-event augmentation never
    // enters our type graph (the same pattern as the structural service
    // types). An unknown event type is otherwise skipped by the switch.
    const kind = event.type as string
    if (kind === 'compaction/start' || kind === 'compaction/summary' || kind === 'compaction/end' || kind === 'session/end-seed') {
      this.applyCompactionEvent(event as { type: string; data: Record<string, unknown> }, kind)
      return
    }
    switch (event.type) {
      case 'turn/start': {
        this.currentTurn = event.data.turn
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
          // (contextProvenance), plus a notice form's one-line account.
          const provenance = contextProvenance(event.data.source)
          const summary = contextSummary(event.data.source)
          const emoji = contextEmoji(event.data.source)
          this.appendItem({
            kind: 'system',
            turn: this.currentTurn,
            text,
            ...provenance.label === null ? {} : { label: provenance.label },
            ...summary === null ? {} : { summary },
            emoji,
          })
        }
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        const step = event.data.step
        // Streaming text accumulates in place on the entry itself; there is
        // no separate accumulator map, so a long session's text is stored
        // once, not twice.
        if (chunk.type === 'text-delta') {
          this.assistantEntry(event.data.turn, step).text += chunk.text
        } else if (chunk.type === 'reasoning-delta') {
          this.thinkingEntry(event.data.turn, step).text += chunk.text
        }
        break
      }
      case 'assistant/message': {
        const key = stepKey(event.data.turn, event.data.step)
        const messageBlocks = event.data.message.content
        const text = textOf(messageBlocks)
        const entry = this.assistantEntries.get(key)
        if (entry !== undefined) {
          entry.text = text
          // The settled full blocks (kept when the step carried images or
          // other non-text blocks — text-only steps stay on the text path).
          if (messageBlocks.some(block => block.type !== 'text')) entry.content = messageBlocks
        } else if (text !== '' || messageBlocks.some(block => block.type !== 'text')) {
          const created: TranscriptMessage = { kind: 'assistant', turn: event.data.turn, text, ...(messageBlocks.some(block => block.type !== 'text') ? { content: messageBlocks } : {}) }
          this.assistantEntries.set(key, created)
          this.appendItem(created)
        }
        // The step is complete: its thinking entry stops streaming.
        const thinking = this.thinkingEntries.get(key)
        if (thinking !== undefined) thinking.running = false
        break
      }
      case 'tool/call': {
        const key = event.data.callId
        this.callNames.set(key, event.data.name)
        const card: TranscriptMessage = {
          kind: 'tool',
          turn: this.currentTurn,
          name: event.data.name,
          args: event.data.arguments,
          result: '',
          status: 'running',
        }
        this.appendItem(card)
        this.pendingCalls.set(key, {
          name: event.data.name,
          args: event.data.arguments,
          turn: this.currentTurn,
          card,
          index: this.items.length - 1,
        })
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const key = block?.toolCallId
        const pending = key !== undefined ? this.pendingCalls.get(key) : undefined
        const name = key === undefined ? 'tool' : (this.callNames.get(key) ?? 'tool')
        const text = textOf(block?.content ?? [])
        const status = event.data.error !== undefined || block?.isError === true ? 'error' : 'ok'
        const turn = pending?.turn ?? this.currentTurn
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
          // A settled read may now be groupable: reflow the run it belongs
          // to (bounded by the nearest non-read cards).
          this.reflowGrouping(pending.index)
        } else {
          // Unknown call (e.g. post-compaction): fall back to the last
          // running card with this name, or append a completed one.
          const runningIndex = this.items.findLastIndex(message => message.kind === 'tool' && message.name === name && message.status === 'running')
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
              this.reflowGrouping(runningIndex)
            }
          } else {
            this.appendItem({ kind: 'tool', turn, name, args: '', result: text, status, resultBlocks: block?.content, meta: event.data.meta, error: event.data.error })
            this.reflowGrouping(this.items.length - 1)
          }
        }
        break
      }
      case 'turn/end': {
        // Every thinking entry stops streaming when the turn closes
        // (interrupted steps never see their assistant/message).
        for (const entry of this.thinkingEntries.values()) entry.running = false
        if (event.data.reason.kind === 'error') {
          const error = event.data.reason.error
          this.appendItem({ kind: 'tool', turn: this.currentTurn, name: 'error', args: '', result: `${error.code}: ${error.message}`, status: 'error' })
        } else if (event.data.reason.kind === 'aborted') {
          this.appendItem({ kind: 'tool', turn: this.currentTurn, name: 'interrupted', args: '', result: 'cancelled by user', status: 'error' })
        } else if (event.data.reason.kind === 'max-tokens') {
          this.appendItem({ kind: 'system', turn: this.currentTurn, text: 'max tokens reached — output truncated' })
        }
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
        this.appendItem(card)
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
        }
        // The run's bookkeeping is done: drop the run card and every member
        // card keyed under it so long sessions do not accumulate stale maps.
        this.workflowRuns.delete(event.data.runId)
        for (const memberKey of this.workflowMembers.keys()) {
          if (memberKey.startsWith(`${event.data.runId}/`)) this.workflowMembers.delete(memberKey)
        }
        break
      }
      case 'llm/retry': {
        const { retry, delayMs, failure } = event.data
        const maxRetries = 'maxRetries' in event.data ? event.data.maxRetries : undefined
        const label = maxRetries === undefined
          ? `llm retry ${retry} in ${Math.round(delayMs / 1000)}s`
          : `llm retry ${retry + 1}/${maxRetries} in ${Math.round(delayMs / 1000)}s`
        this.appendItem({ kind: 'system', turn: this.currentTurn, text: `${label} — ${failure.code}: ${failure.message}` })
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
        break
      }
      default:
        break
    }
  }
}

/**
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the assistant message of
 * their own (turn, step); `reasoning-delta` chunks accumulate into a
 * thinking entry. A tool call and its result merge into one card; an
 * unanswered call stays `running`.
 * @param events - the session log.
 * @param options - optional display window (older turns collapse).
 * @returns ordered renderable messages.
 */
export function foldTranscript(events: readonly SessionEvent[], options?: FoldOptions): TranscriptMessage[] {
  const folder = new TranscriptFolder()
  folder.apply(events)
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
  events: readonly SessionEvent[]
}): string {
  const lines: string[] = [
    `# Session ${session.header.id}`,
    `- cwd: ${session.header.cwd ?? 'unknown'}`,
    ...session.header.agentPreset === undefined ? [] : [`- agent preset: ${session.header.agentPreset}`],
    '',
  ]
  for (const event of session.events) {
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
