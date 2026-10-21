/**
 * Canonical transcript window semantics (TS7): the latest/history navigation
 * state machine, the bounded turn-window projection and the projected-window
 * carrier.
 *
 * The folder remains the source of history truth. This controller only remembers
 * whether a surface follows the live tail or browses a turn-anchored window, so
 * the same state machine serves the main session and a subagent viewer without
 * knowing anything about DSH or the renderer. It is the ONE authority for
 * whether navigation changed semantic state: a no-op boundary move returns
 * false and mutates nothing, so the surface can decide the movement BEFORE
 * capturing any viewport anchor.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/window
 */

import { recentTurnThreshold } from './grouping.ts'
import type { TranscriptMessage } from './types.ts'

/** The semantic state of the transcript presentation window. */
export interface TranscriptWindowState {
  readonly mode: 'latest' | 'history'
  /** The inclusive end turn while browsing history. */
  readonly endTurn?: number
}

/** The state plus the bounds of the currently projected turn window. */
export interface TranscriptWindowSnapshot extends TranscriptWindowState {
  readonly firstTurn?: number
  readonly lastTurn?: number
  readonly hasOlder: boolean
  readonly hasNewer: boolean
}

/** Options for {@link TranscriptWindowController}. */
export interface TranscriptWindowControllerOptions {
  /** Number of distinct turns to project (default: 20). */
  readonly windowTurns?: number
  /** Number of turns by which an older/newer page moves (default: 10). */
  readonly stepTurns?: number
  /** The folder's live grouped-output turn index. The reference is retained. */
  readonly turns?: readonly number[]
}

/** A small binary-search helper for the monotonic turn index. */
function upperBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((values[middle] ?? Number.NEGATIVE_INFINITY) <= target) low = middle + 1
    else high = middle
  }
  return low
}

/** Return the exact index of a turn, or -1 when the anchor is unknown. */
function indexOfTurn(values: readonly number[], turn: number, monotonic: boolean): number {
  if (!monotonic) {
    // Corrupt/non-monotonic logs are rare and already use the folder's
    // defensive projection path; keep navigation correct with a linear lookup.
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (values[index] === turn) return index
    }
    return -1
  }
  const index = upperBound(values, turn) - 1
  return index >= 0 && values[index] === turn ? index : -1
}

/**
 * Owns latest/history navigation without materializing transcript messages.
 * The folder supplies the turn index and performs the actual projection.
 */
export class TranscriptWindowController {
  readonly windowTurns: number
  readonly stepTurns: number
  private turns: readonly number[]
  private current: TranscriptWindowState = { mode: 'latest' }
  private validatedTurns: readonly number[] | undefined
  private validatedLength = 0
  private turnsMonotonic = true

  constructor(options: TranscriptWindowControllerOptions = {}) {
    this.windowTurns = Math.max(1, Math.trunc(options.windowTurns ?? 20))
    this.stepTurns = Math.max(1, Math.trunc(options.stepTurns ?? 10))
    this.turns = options.turns ?? []
  }

  /** Validate only the newly appended suffix of the retained turn index. */
  private refreshTurnOrder(): void {
    if (this.validatedTurns !== this.turns || this.validatedLength > this.turns.length) {
      this.validatedTurns = this.turns
      this.validatedLength = 0
      this.turnsMonotonic = true
    }
    for (let index = Math.max(1, this.validatedLength); index < this.turns.length; index += 1) {
      if (this.turns[index]! < this.turns[index - 1]!) this.turnsMonotonic = false
    }
    this.validatedLength = this.turns.length
  }

  private turnIndex(turn: number): number {
    return indexOfTurn(this.turns, turn, this.turnsMonotonic)
  }

  /** Attach the current folder index without copying its history. */
  setTurns(turns: readonly number[]): void {
    this.turns = turns
    this.refreshTurnOrder()
    // A session never removes turns, but a reused controller must still fail
    // soft if a caller swaps in a shorter or otherwise different index.
    if (turns.length === 0) {
      this.current = { mode: 'latest' }
      return
    }
    if (this.current.mode === 'history' && this.current.endTurn !== undefined
      && this.turnIndex(this.current.endTurn) < 0) {
      this.current = { mode: 'latest' }
    }
  }

  /** Return the current semantic state. */
  state(): TranscriptWindowState {
    return this.current
  }

  /** Whether the controller follows the live tail. */
  isLatest(): boolean {
    return this.current.mode === 'latest'
  }

  /** The end-turn option to pass to the folder projection. */
  endTurn(): number | undefined {
    return this.current.mode === 'history' ? this.current.endTurn : undefined
  }

  /** Clear every history anchor and resume live-tail semantics. */
  latest(): boolean {
    if (this.current.mode === 'latest' && this.current.endTurn === undefined) return false
    this.current = { mode: 'latest' }
    return true
  }

  /** Alias used by Host handlers whose intent is explicit reset-to-latest. */
  resetToLatest(): boolean {
    return this.latest()
  }

  /** Anchor the window at a known turn. */
  anchorAt(turn: number): boolean {
    this.refreshTurnOrder()
    if (!Number.isFinite(turn)) return false
    const next = Math.trunc(turn)
    if (this.turns.length === 0 || this.turnIndex(next) < 0) return false
    if (this.current.mode === 'history' && this.current.endTurn === next) return false
    this.current = { mode: 'history', endTurn: next }
    return true
  }

  /** Move one overlapping page toward older turns. The move is a no-op
   * when the CURRENT projected window already reaches the oldest retained
   * turn: the window's start index is derived from the current anchor, and
   * at 0 there is no older page to show — the controller state stays
   * untouched (hasOlder=false ⇒ moveOlder=false + no mutation), so a short
   * session can never be paged into a bogus history state that hides its
   * content. */
  moveOlder(): boolean {
    this.refreshTurnOrder()
    if (this.turns.length === 0) return false
    const latestIndex = this.turns.length - 1
    const currentIndex = this.current.mode === 'latest'
      ? latestIndex
      : this.turnIndex(this.current.endTurn ?? this.turns[latestIndex]!)
    if (currentIndex < 0) return false
    // The current projected window already reaches the oldest retained
    // turn: no older page exists — never switch latest → history and never
    // move an existing history anchor.
    const startIndex = Math.max(0, currentIndex - this.windowTurns + 1)
    if (startIndex === 0) return false
    const nextIndex = Math.max(0, currentIndex - this.stepTurns)
    if (nextIndex === currentIndex) return false
    const endTurn = this.turns[nextIndex]
    if (endTurn === undefined) return false
    this.current = { mode: 'history', endTurn }
    return true
  }

  /**
   * Move exactly ONE turn toward older (Ctrl+Up prompt navigation — a
   * single-turn variant of {@link moveOlder}'s page step). From live-tail
   * this anchors history at the previous turn's end.
   */
  turnOlder(): boolean {
    this.refreshTurnOrder()
    if (this.turns.length === 0) return false
    const latestIndex = this.turns.length - 1
    const currentIndex = this.current.mode === 'latest'
      ? latestIndex
      : this.turnIndex(this.current.endTurn ?? this.turns[latestIndex]!)
    if (currentIndex <= 0) return false
    const endTurn = this.turns[currentIndex - 1]
    if (endTurn === undefined) return false
    this.current = { mode: 'history', endTurn }
    return true
  }

  /**
   * Move exactly ONE turn toward newer, resuming live-tail at the newest
   * (Ctrl+Down prompt navigation — single-turn variant of {@link moveNewer}).
   */
  turnNewer(): boolean {
    this.refreshTurnOrder()
    if (this.current.mode !== 'history' || this.turns.length === 0) return false
    const currentIndex = this.turnIndex(this.current.endTurn ?? this.turns[0]!)
    if (currentIndex < 0) return false
    if (currentIndex >= this.turns.length - 1) return this.latest()
    const endTurn = this.turns[currentIndex + 1]
    if (endTurn === undefined) return false
    this.current = { mode: 'history', endTurn }
    return true
  }

  /** Move one overlapping page toward newer turns, resuming live-tail at end. */
  moveNewer(): boolean {
    this.refreshTurnOrder()
    if (this.current.mode !== 'history' || this.turns.length === 0) return false
    const currentIndex = this.turnIndex(this.current.endTurn ?? this.turns[0]!)
    if (currentIndex < 0) return false
    const nextIndex = Math.min(this.turns.length - 1, currentIndex + this.stepTurns)
    if (nextIndex >= this.turns.length - 1) return this.latest()
    const endTurn = this.turns[nextIndex]
    if (endTurn === undefined) return false
    this.current = { mode: 'history', endTurn }
    return true
  }

  /**
   * Describe the current window using only the turn index. The folder's
   * projection adds the message list and authoritative group boundaries.
   */
  snapshot(): TranscriptWindowSnapshot {
    this.refreshTurnOrder()
    if (this.turns.length === 0) {
      return { ...this.current, hasOlder: false, hasNewer: false }
    }
    const latestIndex = this.turns.length - 1
    const anchoredIndex = this.current.mode === 'history' && this.current.endTurn !== undefined
      ? this.turnIndex(this.current.endTurn)
      : latestIndex
    const endIndex = this.current.mode === 'latest' || anchoredIndex < 0
      ? latestIndex
      : anchoredIndex
    const startIndex = Math.max(0, endIndex - this.windowTurns + 1)
    return {
      ...this.current,
      firstTurn: this.turns[startIndex],
      lastTurn: this.turns[endIndex],
      hasOlder: startIndex > 0,
      hasNewer: this.current.mode === 'history' && endIndex < latestIndex,
    }
  }
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
