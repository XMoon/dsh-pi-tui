/**
 * Shared per-step token usage accounting, used by BOTH the session stats
 * fold (footer) and the Focus per-turn token projection. One accounting
 * implementation, so the two surfaces can never drift:
 *
 * - usage is counted ONCE per step at step/end — the assistant/message
 *   usage replaces the streaming `usage` chunk (both carry the same
 *   assembler value; adding both would double the totals), and a step with
 *   only a usage chunk still counts (the projection's tokenUsage is
 *   step-keyed, not message-gated);
 * - a usage fact without a step boundary (replay edge) counts immediately;
 * - the per-turn DISPLAY total is committed completed steps PLUS the open
 *   steps' current usage (provisional or authoritative) — provisional
 *   values are never committed early, so an authoritative replacement
 *   cannot double-count.
 * @module @xmoon76/dsh-pi-tui/token-usage
 */

/** Usage shape the fold accepts (the dsh TokenUsage's accounting fields). */
export interface UsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** The four token totals of one turn or session. */
export interface TokenUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The billed total: uncached input + cache read + cache write + output. */
export function totalTokens(usage: TokenUsageTotals): number {
  return usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheWriteTokens
}

/** A zeroed totals record (the accumulation base). */
function emptyTotals(): TokenUsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** Add one usage record into a totals accumulator. */
function addTotals(target: TokenUsageTotals, usage: UsageLike): void {
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

/** Key identifying one step's model output (turn + step). */
function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

/**
 * Per-step usage accounting shared by the session stats fold and the Focus
 * per-turn token projection. Feed it the same events in the same order and
 * both surfaces read identical totals (the footer's session total is the
 * sum of the per-turn committed totals plus orphan usage — the invariant
 * that keeps `sum(per-turn) ≈ session` strict).
 *
 * Lifecycle: `onStepStart` opens a step; `onUsageChunk` records the LATEST
 * streaming usage (the assembler value is cumulative — later chunks
 * replace earlier ones); `onAssistantMessage` replaces it with the
 * authoritative usage; `onStepEnd` commits the step's usage once and drops
 * the open state. A usage fact with no open step counts immediately
 * (replay edge).
 */
/** One usage fact with its provenance: authoritative (assistant/message)
 * or provisional (streaming chunk). */
interface StepFact {
  usage: UsageLike
  authoritative: boolean
}

export class StepUsageAccumulator {
  /** Open steps: their current usage (undefined = no usage fact yet) and
   * whether an authoritative message settled it. */
  private readonly perStep = new Map<string, { usage?: UsageLike; authoritative?: boolean }>()
  /** Facts WITHOUT an open step per (turn, step) — orphan facts (the step
   * never opened) and closed steps' committed values alike. Each fact
   * carries its provenance: a PROVISIONAL chunk never replaces an
   * AUTHORITATIVE value (the message is the step's final usage; a later
   * chunk is stale), while a message replaces anything and a chunk
   * replaces a provisional value (the latest fact wins — review
   * findings). */
  private readonly settledByStep = new Map<string, StepFact>()
  /** Committed per-turn totals (completed steps + orphan facts). */
  private readonly turnTotals = new Map<number, TokenUsageTotals>()
  /** Open steps' current usage per turn (the running display share). */
  private readonly turnPending = new Map<number, TokenUsageTotals>()
  /** The session-wide total (every committed fact), kept O(1). */
  private readonly session: TokenUsageTotals = emptyTotals()
  /** The highest turn seen so far: when a NEW turn appears, the settled
   * records of all OLDER turns are dropped — their steps are closed and a
   * well-formed log never revisits them, so the map stays bounded by the
   * current turn's steps (review finding). A fact for an older turn's
   * step beyond that (corrupt log) commits as a new fact. */
  private currentTurn = -1

  /** Track the turn boundary: drop older turns' settled records when the
   * turn advances, and remember the current turn so a LATE fact for an
   * older turn (corrupt log) is ignored — never re-counted (review
   * finding). */
  private noteTurn(turn: number): void {
    if (turn <= this.currentTurn) return
    if (this.currentTurn >= 0 && this.settledByStep.size > 0) {
      for (const key of this.settledByStep.keys()) {
        const slash = key.indexOf('/')
        const keyTurn = slash === -1 ? -1 : Number(key.slice(0, slash))
        if (keyTurn < turn) this.settledByStep.delete(key)
      }
    }
    this.currentTurn = turn
  }

  /** Whether a fact for this turn is stale: the turn already advanced past
   * it (a well-formed log is monotonic; a late older-turn fact is a
   * corrupt-log artifact and is ignored entirely). */
  private staleTurn(turn: number): boolean {
    return turn < this.currentTurn
  }

  /** Open one step's accounting. A step that opens AFTER a settled fact of
   * the same (turn, step) (out-of-order replay) reconciles the fact: the
   * premature commit is reversed and the fact becomes the step's pending
   * usage — with its provenance preserved — to be committed once at
   * step/end, never twice (review findings). */
  onStepStart(turn: number, step: number): void {
    this.noteTurn(turn)
    if (this.staleTurn(turn)) return
    const key = stepKey(turn, step)
    // Idempotent: a duplicate step/start keeps the open entry — replacing
    // it would leak the pending usage (review finding).
    if (this.perStep.has(key)) return
    const settled = this.settledByStep.get(key)
    if (settled !== undefined) {
      this.settledByStep.delete(key)
      this.subtractTotals(this.turnTotalFor(turn), settled.usage)
      this.subtractTotals(this.session, settled.usage)
      this.perStep.set(key, { usage: settled.usage, authoritative: settled.authoritative })
      this.addPending(turn, settled.usage)
    } else {
      this.perStep.set(key, {})
    }
  }

  /** Record a streaming usage chunk: the LATEST chunk of an open step
   * replaces the previous one (the assembler value is cumulative — the
   * running display must show the latest provisional usage, plan §13.2),
   * but a provisional chunk NEVER replaces an authoritative value. A
   * chunk without an open step (replay edge) is a settled fact and
   * commits to the turn's totals immediately. */
  onUsageChunk(turn: number, step: number, usage: UsageLike): void {
    this.noteTurn(turn)
    if (this.staleTurn(turn)) return
    const entry = this.perStep.get(stepKey(turn, step))
    if (entry !== undefined) {
      if (entry.authoritative === true) return
      if (entry.usage !== undefined) this.subtractPending(turn, entry.usage)
      entry.usage = usage
      this.addPending(turn, usage)
    } else {
      this.commitSettled(turn, step, { usage, authoritative: false })
    }
  }

  /** The authoritative usage of a settled step replaces the provisional
   * one (never adds to it) — on the open-step path AND the settled path.
   * A message without an open step (replay edge) commits to the turn's
   * totals immediately. */
  onAssistantMessage(turn: number, step: number, usage?: UsageLike): void {
    this.noteTurn(turn)
    if (this.staleTurn(turn)) return
    const entry = this.perStep.get(stepKey(turn, step))
    if (entry !== undefined) {
      if (usage !== undefined) {
        if (entry.usage !== undefined) this.subtractPending(turn, entry.usage)
        entry.usage = usage
        entry.authoritative = true
        this.addPending(turn, usage)
      }
    } else if (usage !== undefined) {
      this.commitSettled(turn, step, { usage, authoritative: true })
    }
  }

  /** Commit one step's usage (once) and drop its open state. The step's
   * final fact stays in {@link settledByStep} (with its provenance) so a
   * late fact replaces or is ignored correctly; a step that never opened
   * keeps its settled fact unchanged. */
  onStepEnd(turn: number, step: number): void {
    this.noteTurn(turn)
    if (this.staleTurn(turn)) return
    const key = stepKey(turn, step)
    const entry = this.perStep.get(key)
    if (entry !== undefined) {
      if (entry.usage !== undefined) {
        this.subtractPending(turn, entry.usage)
        addTotals(this.turnTotalFor(turn), entry.usage)
        addTotals(this.session, entry.usage)
        this.settledByStep.set(key, { usage: entry.usage, authoritative: entry.authoritative === true })
      }
      this.perStep.delete(key)
    }
  }

  /** The committed per-turn totals (completed steps + orphan facts);
   * undefined when the turn has no committed usage fact. */
  turnUsage(turn: number): TokenUsageTotals | undefined {
    return this.turnTotals.get(turn)
  }

  /** The per-turn DISPLAY totals: committed steps plus the open steps'
   * current usage (provisional or authoritative) — never double-counted.
   * Undefined when the turn has no usage fact at all (the header then
   * hides the token segment instead of showing `0 tok`). */
  turnUsageWithPending(turn: number): TokenUsageTotals | undefined {
    const committed = this.turnTotals.get(turn)
    const pending = this.turnPending.get(turn)
    if (committed === undefined && pending === undefined) return undefined
    const totals = emptyTotals()
    if (committed !== undefined) addTotals(totals, committed)
    if (pending !== undefined) addTotals(totals, pending)
    return totals
  }

  /** The session-wide totals (every committed fact — the sum of the
   * per-turn committed totals by construction, so the footer and the
   * Focus per-turn projection can never drift). */
  sessionTotals(): TokenUsageTotals {
    return { ...this.session }
  }

  private turnTotalFor(turn: number): TokenUsageTotals {
    let totals = this.turnTotals.get(turn)
    if (totals === undefined) {
      totals = emptyTotals()
      this.turnTotals.set(turn, totals)
    }
    return totals
  }

  private addPending(turn: number, usage: UsageLike): void {
    let pending = this.turnPending.get(turn)
    if (pending === undefined) {
      pending = emptyTotals()
      this.turnPending.set(turn, pending)
    }
    addTotals(pending, usage)
  }

  private subtractPending(turn: number, usage: UsageLike): void {
    const pending = this.turnPending.get(turn)
    if (pending === undefined) return
    pending.inputTokens -= usage.inputTokens
    pending.outputTokens -= usage.outputTokens
    pending.cacheReadTokens -= usage.cacheReadTokens ?? 0
    pending.cacheWriteTokens -= usage.cacheWriteTokens ?? 0
  }

  /** A usage fact without an open step (replay edge) is a settled fact:
   * commit it to the turn's totals immediately, so
   * sum(per-turn committed) == session total stays strict. The latest
   * fact REPLACES the previous one of the same (turn, step) — the same
   * replace-never-add rule as the open-step path — EXCEPT a provisional
   * chunk never replaces an authoritative value (the message is the
   * step's final usage; the chunk is stale and is ignored entirely, so
   * the step is never double-counted). */
  private commitSettled(turn: number, step: number, fact: StepFact): void {
    const key = stepKey(turn, step)
    const existing = this.settledByStep.get(key)
    if (existing !== undefined) {
      if (existing.authoritative && !fact.authoritative) return
      this.subtractTotals(this.turnTotalFor(turn), existing.usage)
      this.subtractTotals(this.session, existing.usage)
    }
    this.settledByStep.set(key, fact)
    addTotals(this.turnTotalFor(turn), fact.usage)
    addTotals(this.session, fact.usage)
  }

  /** Subtract one usage record from a totals accumulator. */
  private subtractTotals(target: TokenUsageTotals, usage: UsageLike): void {
    target.inputTokens -= usage.inputTokens
    target.outputTokens -= usage.outputTokens
    target.cacheReadTokens -= usage.cacheReadTokens ?? 0
    target.cacheWriteTokens -= usage.cacheWriteTokens ?? 0
  }
}

/** Format a token count with pi.s footer rules: 1.5k, 190k, 1.0M, 86M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}
