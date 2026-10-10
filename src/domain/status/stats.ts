/**
 * Session lifetime statistics folded from the event log: turns/steps, LLM
 * wall time, token totals, cache hit rate and the advertised context window.
 * Pure and deterministic for headless tests.
 *
 * TPS plan PR-2 (scope reduction): the RECENT/LIFETIME performance rates no
 * longer live here. The bundle's own Host `piTuiPerformance` projection is the
 * single authority for the R5 and All rates and the recent first-token
 * average (see `domain/status/performance-view.ts`), so this fold owns only
 * the facts it genuinely answers:
 *
 * - turns/steps count at `step/end` (unique turns), like the official
 *   projection;
 * - `llmMs` is the session LIFETIME model wall (`step/start` →
 *   `assistant/message`), kept for `/status` and analysis;
 * - usage is counted ONCE per attempt by the shared {@link StepUsageAccumulator}
 *   (an `assistant/message`/`assistant/attempt` replaces the provisional
 *   streaming value; `llm/retry-started` opens a new same-step attempt);
 *   reasoning tokens are already inside `outputTokens`;
 * - billed input = uncached + cache-read + cache-write, and the cache-hit
 *   share divides by that sum;
 * - `request/context` supplies the route's advertised context window.
 *
 * The late-replay protections stay exactly as they were: replacement-surface
 * events are skipped, a completed turn fences late events of that turn, and a
 * duplicate authoritative message never adds a second wall-time.
 *
 * TS8-D moved this semantic/fact authority out of the legacy root
 * `src/stats.ts`. Presentation formatting lives elsewhere: the `/status` Stats
 * row formatter is `src/tui/commands/status.ts` and the compact token-count
 * formatter is `src/tui/token-format.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/status/stats
 */

import { isReplacementSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { StepUsageAccumulator, usageFromAssistantSettlement } from '../transcript/usage.ts'
import type { AssistantLiveChunk, AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { DerivedPerformance } from './performance-view.ts'

/** Aggregated session statistics. */
export interface SessionStats {
  /** Completed turns. */
  turns: number
  /** Model requests (steps). */
  steps: number
  /** Total model wall time (step/start → assistant/message), ms — the
   * session LIFETIME total (the /status row and session analysis read it; the
   * default footer does not). */
  llmMs: number
  /** Cache-read share of billed input tokens, 0–100. */
  cacheHitPct: number
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Context window advertised by the model route, when known. */
  contextWindow?: number
  /** Cache-read tokens (input share), accumulated while folding. */
  cacheReadTokens: number
  /** Cache-write tokens (input share), accumulated while folding. */
  cacheWriteTokens: number
}

/**
 * The authority-grouped facts of one session's stats. Every group can be
 * ABSENT — an absent group means its authoritative source cannot answer (a
 * Remote projection gap), never a zero stand-in. An authoritative zero stays
 * a visible zero.
 */
export interface SessionStatsFacts {
  /** Lifetime counters (the official `sessionStats` projection). */
  readonly lifetime?: {
    readonly turns?: number
    readonly steps?: number
    readonly llmMs?: number
  }
  /** Cumulative token totals (the official `tokenUsage` projection). */
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly cacheHitPct: number
  }
  /**
   * The Host projection's RECENT (R5) figures. Each field is present only
   * when the Host `piTuiPerformance` projection can answer it: a scope with no
   * eligible sample omits its field instead of reporting a fabricated zero,
   * and TTFB is independent of the rate.
   */
  readonly recent?: {
    readonly firstTokenMsAvg?: number
    readonly tokensPerSec?: number
  }
  /** The Host projection's whole-Session ("All") weighted rate. */
  readonly sessionPerformance?: {
    readonly tokensPerSec: number
  }
  /** The route's advertised context window, when known. */
  readonly contextWindow?: number
}

/**
 * Project a COMPLETE fold onto the facts type, taking the measured
 * performance values from the Host projection's derived figures
 * (`derivePerformance`, the ONE authority — never re-folded from events or
 * paged out of a bounded window).
 */
export function sessionStatsFactsOf(stats: SessionStats, performance: DerivedPerformance = {}): SessionStatsFacts {
  return {
    lifetime: { turns: stats.turns, steps: stats.steps, llmMs: stats.llmMs },
    tokens: {
      input: stats.inputTokens,
      output: stats.outputTokens,
      cacheRead: stats.cacheReadTokens,
      cacheWrite: stats.cacheWriteTokens,
      cacheHitPct: stats.cacheHitPct,
    },
    ...(performance.firstTokenMs === undefined && performance.tokensPerSec === undefined
      ? {}
      : {
          recent: {
            ...(performance.firstTokenMs === undefined ? {} : { firstTokenMsAvg: performance.firstTokenMs }),
            ...(performance.tokensPerSec === undefined ? {} : { tokensPerSec: performance.tokensPerSec }),
          },
        }),
    ...(performance.sessionTokensPerSec === undefined
      ? {}
      : { sessionPerformance: { tokensPerSec: performance.sessionTokensPerSec } }),
    ...(stats.contextWindow === undefined ? {} : { contextWindow: stats.contextWindow }),
  }
}

const EMPTY: SessionStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  cacheHitPct: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** Key identifying one step (turn + step). */
function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

/** One step's TIMING accumulation: the model wall settles once, at its first
 *  authoritative `assistant/message`. */
interface StepTiming {
  start?: number
  completed?: number
  /** One step may have at most one wall-time settlement. */
  settled?: boolean
}

/** Advance the late-replay fence and clear the previous turn once. */
function advanceTimingTurn(
  open: Map<string, StepTiming>,
  ended: Set<string>,
  current: number | undefined,
  turn: number,
): number | undefined {
  // Event logs are normally monotonic. Keeping a monotonic fence also makes
  // an out-of-order older replay unable to mutate the current turn's timing.
  if (current === undefined || turn > current) {
    open.clear()
    ended.clear()
    return turn
  }
  return current
}

/** Settle one step's LIFETIME model wall at its `assistant/message` boundary.
 * A step with no message (cancelled/failed) never reaches here. */
function settleStep(stats: SessionStats, timing: StepTiming): void {
  const completed = timing.completed
  if (completed === undefined) return
  const start = timing.start
  if (start !== undefined) stats.llmMs += Math.max(0, completed - start)
}

/** Write the accumulated usage totals onto the stats. */
function applyUsageTotals(stats: SessionStats, usage: StepUsageAccumulator): void {
  const totals = usage.sessionTotals()
  stats.inputTokens = totals.inputTokens
  stats.outputTokens = totals.outputTokens
  stats.cacheReadTokens = totals.cacheReadTokens
  stats.cacheWriteTokens = totals.cacheWriteTokens
  const billedInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  if (billedInput > 0) stats.cacheHitPct = (stats.cacheReadTokens * 100) / billedInput
}

/**
 * Fold the session log into the lifetime statistics.
 * @param events - the session log.
 * @returns aggregated statistics.
 */
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  const stats: SessionStats = { ...EMPTY }
  const perStep = new Map<string, StepTiming>()
  // Step boundaries are idempotent within the active turn; older boundaries
  // are stale once the timing fence advances.
  const endedSteps = new Set<string>()
  const usage = new StepUsageAccumulator()
  let completedTurnFence: number | undefined
  let lastTurn: number | undefined
  let settledTurn: number | undefined
  const enterSettledTurn = (turn: number): void => {
    settledTurn = advanceTimingTurn(perStep, endedSteps, settledTurn, turn)
  }

  for (const event of events) {
    // Replacement surface events belong to the model-visible compaction view,
    // not the human transcript or its totals.
    if (isReplacementSurfaceEvent(event)) continue
    // After turn/end a late step/usage/message event of that turn is a replay
    // artifact and is ignored (the same lifecycle policy as the Focus fold).
    if (event.type !== 'turn/end' && event.type !== 'request/context') {
      const eventTurn = (event.data as { turn?: unknown }).turn
      if (typeof eventTurn === 'number' && completedTurnFence !== undefined && eventTurn <= completedTurnFence) continue
    }
    const kind = event.type as string
    // `llm/retry-started` closes the failed attempt's replacement slot while
    // preserving its committed usage; the next attempt reuses the same step.
    if (kind === 'llm/retry-started') {
      const retry = event.data as { turn: number; step: number }
      usage.onRetryStarted(retry.turn, retry.step)
      continue
    }
    // `assistant/attempt` (Session v2, typed STRUCTURALLY): the attempt
    // committed NO surface message, but its embedded stream carries the
    // attempt's authoritative provider usage. Its logical-step timing stays
    // open for a possible retry and eventual assistant/message settlement.
    if (kind === 'assistant/attempt') {
      const failed = event.data as { turn: number; step: number; stream?: readonly unknown[] }
      usage.onAssistantAttempt(
        failed.turn,
        failed.step,
        usageFromAssistantSettlement('attempt', undefined, failed.stream ?? []),
      )
      continue
    }
    switch (event.type) {
      case 'turn/start': {
        usage.onTurnStart(event.data.turn)
        enterSettledTurn(event.data.turn)
        break
      }
      case 'turn/end': {
        if (completedTurnFence === undefined || event.data.turn > completedTurnFence) completedTurnFence = event.data.turn
        // Turn/end can arrive out of order in replayed logs. Advance the shared
        // usage fence before finalizing so older open steps settle only once.
        usage.onTurnStart(event.data.turn)
        // Finalize any still-open steps so the session total agrees with
        // the Focus per-turn total.
        usage.onTurnEnd(event.data.turn)
        // Drop all timing state of the ended turn (interrupted steps never
        // see their step/end; late events are replay artifacts).
        enterSettledTurn(event.data.turn)
        if (settledTurn === event.data.turn) {
          perStep.clear()
          endedSteps.clear()
        }
        break
      }
      case 'step/start': {
        const key = stepKey(event.data.turn, event.data.step)
        enterSettledTurn(event.data.turn)
        usage.onStepStart(event.data.turn, event.data.step)
        if (settledTurn !== event.data.turn || endedSteps.has(key) || perStep.has(key)) break
        perStep.set(key, { start: event.time })
        break
      }
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        enterSettledTurn(event.data.turn)
        const currentTimingTurn = settledTurn === event.data.turn
        // The projection counts turns/steps at one unique step/end and
        // discards older-turn boundaries after the timing fence advances.
        if (currentTimingTurn && !endedSteps.has(key)) {
          endedSteps.add(key)
          if (lastTurn !== event.data.turn) {
            stats.turns += 1
            lastTurn = event.data.turn
          }
          stats.steps += 1
        }
        usage.onStepEnd(event.data.turn, event.data.step)
        if (currentTimingTurn) perStep.delete(key)
        break
      }
      case 'assistant/message': {
        enterSettledTurn(event.data.turn)
        const key = stepKey(event.data.turn, event.data.step)
        const messageUsage = usageFromAssistantSettlement('message', event.data.usage, event.data.stream)
        const timing = settledTurn === event.data.turn ? perStep.get(key) : undefined
        if (timing !== undefined && timing.settled !== true) {
          // The message time is the step's LLM wall end; the whole step
          // settles HERE (projection semantics). A duplicate authoritative
          // message may replace token usage, but it must never add a second
          // wall time.
          timing.completed = event.time
          settleStep(stats, timing)
          timing.settled = true
        }
        usage.onAssistantMessage(event.data.turn, event.data.step, messageUsage)
        break
      }
      case 'request/context': {
        if (event.data.contextWindow !== undefined) stats.contextWindow = event.data.contextWindow
        break
      }
      default:
        break
    }
  }

  applyUsageTotals(stats, usage)
  return stats
}

/**
 * Incremental stats folding: apply appended events and read `snapshot()`
 * anytime. The footer refreshes on every step/turn boundary, so a per-event
 * fold keeps a long session's status line O(1) instead of re-scanning the
 * whole log (computeStats) per refresh.
 */
export class StatsFolder {
  private readonly stats: SessionStats = { ...EMPTY }
  private readonly perStep = new Map<string, StepTiming>()
  // Step boundaries are idempotent within the active turn; older boundaries
  // are stale once the timing fence advances.
  private readonly endedSteps = new Set<string>()
  private settledTurn: number | undefined
  /** The shared per-step usage accounting (same class as the Focus fold). */
  private readonly usage = new StepUsageAccumulator()
  /** Highest turn finalized by turn/end; older events are replay artifacts.
   * A monotonic fence keeps lifecycle memory bounded across long sessions. */
  private completedTurnFence: number | undefined
  private lastTurn: number | undefined

  /**
   * Apply appended events in log order (a full log on resume, suffixes after).
   * @param events - the appended session events.
   */
  apply(events: readonly SessionEvent[]): void {
    for (const event of events) this.applyEvent(event)
  }

  /**
   * Hydrate a cold session log through the same ordered fold as {@link apply}.
   * The explicit entry point lets session bootstrap distinguish a full log
   * from live suffixes.
   */
  hydrate(events: readonly SessionEvent[]): void {
    this.apply(events)
  }

  /**
   * Apply one live assistant stream input (Session v2 TRANSIENT plane): the
   * provisional streaming usage. The measured performance values are NOT
   * tracked here — the Host projection owns them.
   *
   * An abandoned attempt has no durable usage, so its provisional accounting
   * is discarded; a committed `assistant/attempt` gets usage from its durable
   * embedded stream.
   */
  applyLiveInput(input: AssistantLiveInput): void {
    if (input.kind === 'end' && input.status === 'abandoned') {
      this.settleFailedAttempt(input.turn, input.step, true)
      return
    }
    if (input.kind === 'end' && input.settlement === 'attempt') {
      this.settleFailedAttempt(input.turn, input.step, false)
      return
    }
    if (input.kind !== 'chunk') return
    this.applyAssistantChunk(input.turn, input.step, input.chunk)
  }

  /** Settle failed-attempt state. An abandoned live attempt discards its
   * provisional usage and timing; a committed `assistant/attempt` keeps the
   * logical-step timing open for a retry and gets usage from its durable
   * embedded stream on the event plane. */
  private settleFailedAttempt(turn: number, step: number, discardUsage: boolean, discardTiming = discardUsage): void {
    if (this.completedTurnFence !== undefined && turn <= this.completedTurnFence) return
    if (discardUsage) this.usage.discardStep(turn, step)
    if (!discardTiming) return
    const key = stepKey(turn, step)
    const timing = this.perStep.get(key)
    if (timing !== undefined && timing.settled !== true) {
      // An abandoned attempt has no later assistant/message to settle its
      // timing. A durable assistant/attempt keeps this open for a retry.
      this.perStep.delete(key)
    }
  }

  /** Fold one live assistant chunk (Session v2 transient plane): the
   * provisional streaming usage only. */
  private applyAssistantChunk(turn: number, step: number, chunk: AssistantLiveChunk): void {
    // After turn/end a late live chunk is a replay artifact: it must not
    // mutate the per-step state — the same completed-turn gate as the durable
    // fold (mirrors TranscriptFolder's activity.completed).
    if (this.completedTurnFence !== undefined && turn <= this.completedTurnFence) return
    this.enterSettledTurn(turn)
    if (chunk.type === 'usage') this.usage.onUsageChunk(turn, step, chunk.usage)
  }

  /** The derived stats as of the last applied event. */
  snapshot(): SessionStats {
    const derived: SessionStats = { ...this.stats }
    const totals = this.usage.sessionTotals()
    derived.inputTokens = totals.inputTokens
    derived.outputTokens = totals.outputTokens
    derived.cacheReadTokens = totals.cacheReadTokens
    derived.cacheWriteTokens = totals.cacheWriteTokens
    const billedInput = derived.inputTokens + derived.cacheReadTokens + derived.cacheWriteTokens
    if (billedInput > 0) derived.cacheHitPct = (derived.cacheReadTokens * 100) / billedInput
    return derived
  }

  /** Advance the replay fence; a turn's timing state is cleared once. */
  private enterSettledTurn(turn: number): void {
    this.settledTurn = advanceTimingTurn(this.perStep, this.endedSteps, this.settledTurn, turn)
  }

  private applyEvent(event: SessionEvent): void {
    // Keep incremental stats on the same append-origin event stream as the
    // transcript and Focus folds; compaction replacements are model-only.
    if (isReplacementSurfaceEvent(event)) return
    if (event.type !== 'turn/end' && event.type !== 'request/context') {
      const eventTurn = (event.data as { turn?: unknown }).turn
      if (typeof eventTurn === 'number' && this.completedTurnFence !== undefined && eventTurn <= this.completedTurnFence) return
    }
    const kind = event.type as string
    // `llm/retry-started` closes the failed attempt's replacement slot while
    // preserving its committed usage; the retried attempt reuses the step.
    if (kind === 'llm/retry-started') {
      const data = event.data as { turn: number; step: number }
      this.usage.onRetryStarted(data.turn, data.step)
      return
    }
    // `assistant/attempt` is a durable failed-attempt settlement. It has no
    // surface message, but its embedded stream carries authoritative usage;
    // keep logical-step timing open for a retry and final message.
    if (kind === 'assistant/attempt') {
      const data = event.data as { turn: number; step: number; stream?: readonly unknown[] }
      const attemptUsage = usageFromAssistantSettlement('attempt', undefined, data.stream ?? [])
      this.settleFailedAttempt(data.turn, data.step, true, false)
      this.usage.onAssistantAttempt(data.turn, data.step, attemptUsage)
      return
    }
    switch (event.type) {
      case 'turn/start': {
        this.usage.onTurnStart(event.data.turn)
        this.enterSettledTurn(event.data.turn)
        break
      }
      case 'turn/end': {
        if (this.completedTurnFence === undefined || event.data.turn > this.completedTurnFence) this.completedTurnFence = event.data.turn
        // Turn/end can arrive out of order in replayed logs. Advance the shared
        // usage fence before finalizing so older open steps settle only once.
        this.usage.onTurnStart(event.data.turn)
        // Finalize any still-open steps so the session total agrees with
        // the Focus per-turn total.
        this.usage.onTurnEnd(event.data.turn)
        // Drop all timing state of the ended turn (interrupted steps never
        // see their step/end; late events are replay artifacts).
        this.enterSettledTurn(event.data.turn)
        if (this.settledTurn === event.data.turn) {
          this.perStep.clear()
          this.endedSteps.clear()
        }
        break
      }
      case 'step/start': {
        const key = stepKey(event.data.turn, event.data.step)
        this.enterSettledTurn(event.data.turn)
        this.usage.onStepStart(event.data.turn, event.data.step)
        if (this.settledTurn !== event.data.turn || this.endedSteps.has(key) || this.perStep.has(key)) break
        this.perStep.set(key, { start: event.time })
        break
      }
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        this.enterSettledTurn(event.data.turn)
        const currentTimingTurn = this.settledTurn === event.data.turn
        // The projection counts turns/steps at one unique step/end and
        // discards older-turn boundaries after the timing fence advances.
        if (currentTimingTurn && !this.endedSteps.has(key)) {
          this.endedSteps.add(key)
          if (this.lastTurn !== event.data.turn) {
            this.stats.turns += 1
            this.lastTurn = event.data.turn
          }
          this.stats.steps += 1
        }
        this.usage.onStepEnd(event.data.turn, event.data.step)
        if (currentTimingTurn) this.perStep.delete(key)
        break
      }
      case 'assistant/message': {
        this.enterSettledTurn(event.data.turn)
        const key = stepKey(event.data.turn, event.data.step)
        const messageUsage = usageFromAssistantSettlement('message', event.data.usage, event.data.stream)
        const timing = this.settledTurn === event.data.turn ? this.perStep.get(key) : undefined
        if (timing !== undefined && timing.settled !== true) {
          // One wall-time settlement per step: a duplicate authoritative
          // message may replace token usage, never the LLM wall.
          timing.completed = event.time
          settleStep(this.stats, timing)
          timing.settled = true
        }
        this.usage.onAssistantMessage(event.data.turn, event.data.step, messageUsage)
        break
      }
      case 'request/context': {
        if (event.data.contextWindow !== undefined) this.stats.contextWindow = event.data.contextWindow
        break
      }
      default:
        break
    }
  }
}
