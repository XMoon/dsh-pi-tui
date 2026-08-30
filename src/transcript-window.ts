/**
 * Presentation-only navigation state for a bounded transcript window.
 *
 * The transcript folder remains the source of history truth. This controller
 * only remembers whether the surface follows the live tail or is browsing a
 * turn-anchored window, so the same state machine can be used by the main
 * session and by a subagent viewer without knowing anything about DSH or the
 * renderer.
 * @module @xmoon76/dsh-pi-tui/transcript-window
 */

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

  /** Move one overlapping page toward older turns. */
  moveOlder(): boolean {
    this.refreshTurnOrder()
    if (this.turns.length === 0) return false
    const latestIndex = this.turns.length - 1
    const currentIndex = this.current.mode === 'latest'
      ? latestIndex
      : this.turnIndex(this.current.endTurn ?? this.turns[latestIndex]!)
    if (currentIndex < 0) return false
    const nextIndex = Math.max(0, currentIndex - this.stepTurns)
    if (nextIndex === currentIndex) return false
    const endTurn = this.turns[nextIndex]
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
