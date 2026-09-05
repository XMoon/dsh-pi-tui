/**
 * Session performance statistics folded from the event log, mirroring pi's
 * footer usage line: turns/steps, LLM wall time, recent first-token
 * latency, recent effective output throughput, cache hit rate, and token
 * totals. Pure and deterministic for headless tests.
 *
 * Accounting follows the Web's sessionStats/tokenUsage projections:
 * - the FIRST TOKEN is any non-empty token delta — text, reasoning, or a
 *   tool-call delta (the Web's isTokenDelta). The whole step's timing (LLM
 *   wall, TTFT) settles at assistant/message, exactly like the projection;
 *   a step that never produced a message (cancelled/failed) contributes no
 *   timing at all;
 * - usage is counted ONCE per step at step/end — the assistant/message
 *   usage replaces the streaming `usage` chunk (both carry the same
 *   assembler value; adding both would double the totals), and a step with
 *   only a usage chunk still counts (the projection's tokenUsage is
 *   step-keyed, not message-gated);
 * - turns/steps count at step/end (unique turns), like the projection;
 * - the STATUS performance metrics (firstTokenMsAvg / tokensPerSec) are
 *   RECENT-window figures over the last {@link RECENT_PERFORMANCE_SAMPLE_LIMIT}
 *   valid completed steps, not session-lifetime averages. A throughput
 *   sample is Σ output / Σ FULL LLM wall (step/start → assistant/message),
 *   so CPA burst tool-call delivery (hundreds of tokens delivered within
 *   milliseconds after a multi-second request) counts as
 *   `400 tokens / 10s whole request = 40 tok/s` instead of ratcheting a
 *   lifetime "observable decode window" rate into the hundreds. A route
 *   (provider + model) change clears both recent windows;
 * - `llmMs` remains the session LIFETIME LLM wall — kept for debug,
 *   /stats and session analysis, no longer shown in the default footer;
 * - billed input = uncached + cache-read + cache-write (the Web's
 *   billedInputTokens), and the cache-hit share divides by that sum.
 * @module @xmoon76/dsh-pi-tui/stats
 */

import { isReplacementSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { formatTokens, StepUsageAccumulator, type UsageLike } from './token-usage.ts'
import type { AssistantLiveChunk, AssistantLiveInput } from './runtime/assistant-stream-port.ts'

/** Aggregated session statistics. */
export interface SessionStats {
  /** Completed turns. */
  turns: number
  /** Model requests (steps). */
  steps: number
  /** Total model wall time (step/start → assistant/message), ms — the
   * session LIFETIME total (debug/stats surfaces; the default footer no
   * longer shows it). */
  llmMs: number
  /** Average time from step/start to the first token over the RECENT
   * window (the last {@link RECENT_PERFORMANCE_SAMPLE_LIMIT} completed
   * first-token steps), ms. */
  firstTokenMsAvg: number
  /** Recent effective output throughput: Σ outputTokens / Σ full LLM wall
   * over the RECENT window (the last {@link RECENT_PERFORMANCE_SAMPLE_LIMIT}
   * valid completed steps), tok/s. */
  tokensPerSec: number
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

const EMPTY: SessionStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  firstTokenMsAvg: 0,
  tokensPerSec: 0,
  cacheHitPct: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** The recent performance window's step count (plan §2.3): last-1 is too
 * jittery across tool-call / reasoning / short-text steps; a session
 * lifetime mixes in stale history; wall-clock windows go empty across
 * long tool gaps. Five completed steps smooth the agent tool loop while
 * staying responsive. */
export const RECENT_PERFORMANCE_SAMPLE_LIMIT = 5

/** How many throughput CANDIDATES the window physically retains (the
 * derived metric still pools only {@link RECENT_PERFORMANCE_SAMPLE_LIMIT}
 * of them — derive takes the latest five VALID samples). The extra
 * candidates exist so an authoritative invalidation of one of the latest
 * five BACKFILLS correctly: the window's contract is "the latest 5 valid
 * samples", and a sample invalidated by a late duplicate stops being
 * valid, letting the next-older retained candidate rejoin. Twice the
 * window covers the worst case of every derived sample being
 * invalidated; a duplicate older than the candidate buffer is a replay
 * artifact beyond the recent contract. TTFT needs no candidates — its
 * samples have no invalidation path. */
const RECENT_PERFORMANCE_CANDIDATE_LIMIT = RECENT_PERFORMANCE_SAMPLE_LIMIT * 2

/** Key identifying one step's model output (turn + step). */
function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

/** The turn number encoded in a step key. */
function turnOfStepKey(key: string): number {
  const slash = key.indexOf('/')
  return slash === -1 ? -1 : Number(key.slice(0, slash))
}

/** One step's timing accumulation, resolved at its boundaries. The usage
 * field feeds the recent performance sampling (settleStep); the token
 * ACCOUNTING itself lives in the shared {@link StepUsageAccumulator}, so
 * the footer and the Focus per-turn projection can never drift. */
interface StepTiming {
  start?: number
  firstDelta?: number
  completed?: number
  usage?: UsageLike
  /** One step may have at most one timing settlement. */
  settled?: boolean
  /** The completion's position in the recent window (assigned at the
   * FIRST settlement; a late usage replacement reuses it). */
  completionOrdinal?: number
  /** The performance route the step's samples joined (provider + model)
   * — a late replacement must not cross back into a reset window. */
  routeKey?: string
  /** The route LIFECYCLE epoch at settlement. The route STRING alone
   * cannot gate a late replacement: A → B → A returns to an equal string
   * while the window's samples belong to the SECOND A lifecycle — only
   * an epoch match proves the same route generation. */
  routeEpoch?: number
}

/** One recent effective-throughput sample: the step's FULL LLM wall
 * (step/start → assistant/message) against its authoritative output
 * tokens — never a burst-delivery "observable decode window". */
interface RecentThroughputSample {
  key: string
  ordinal: number
  wallMs: number
  outputTokens: number
}

/** One recent TTFT sample (step/start → first token delta). */
interface RecentTtftSample {
  key: string
  ordinal: number
  ttftMs: number
}

/**
 * The bounded recent performance window shared by both folds (plan §6.1):
 * the latest {@link RECENT_PERFORMANCE_SAMPLE_LIMIT} VALID samples per
 * metric, keyed by step, ordered by completion ordinal (throughput keeps
 * {@link RECENT_PERFORMANCE_CANDIDATE_LIMIT} candidates so an
 * invalidation backfills). A late authoritative usage replacement UPSERTS
 * its step's sample (same ordinal) instead of appending a fake "newest"
 * one — or REMOVES it when the replacement invalidates the sample. The
 * window is route-scoped: the first settled message that clearly
 * identifies a new provider + model clears both windows (bumping the
 * route epoch) before its own samples join.
 */
class RecentPerformanceWindow {
  /** The route (provider + model) the current window belongs to. */
  routeKey: string | undefined
  /** The current route LIFECYCLE generation — bumped on every REAL route
   * change (A → B → A bumps twice). Samples and settled steps carry the
   * epoch they joined, so a late replacement can only mutate the window
   * of its own generation, never a later one with an equal route string. */
  routeEpoch = 0
  private nextOrdinal = 0
  private throughput: RecentThroughputSample[] = []
  private ttft: RecentTtftSample[] = []

  /** Claim the next completion ordinal (exactly once per step, at its
   * first settlement). */
  claimOrdinal(): number {
    return this.nextOrdinal++
  }

  /** Observe a settled message's route key. The FIRST observation adopts
   * it; a CHANGE clears both windows (and bumps the route epoch) so the
   * new route's metrics start clean. A MISSING key never resets anything
   * (fail-soft). */
  observeRoute(routeKey: string | undefined): void {
    if (routeKey !== undefined) {
      if (this.routeKey === undefined) this.routeKey = routeKey
      else if (this.routeKey !== routeKey) {
        this.throughput = []
        this.ttft = []
        this.routeKey = routeKey
        this.routeEpoch += 1
      }
    }
  }

  /** Upsert the step's TTFT sample (a replacement keeps its ordinal). */
  upsertTtft(key: string, ordinal: number, ttftMs: number): void {
    upsertSample(this.ttft, { key, ordinal, ttftMs }, RECENT_PERFORMANCE_SAMPLE_LIMIT)
  }

  /** Upsert the step's effective-throughput sample. */
  upsertThroughput(key: string, ordinal: number, wallMs: number, outputTokens: number): void {
    upsertSample(this.throughput, { key, ordinal, wallMs, outputTokens }, RECENT_PERFORMANCE_CANDIDATE_LIMIT)
  }

  /** Drop the step's throughput sample (an authoritative replacement that
   * invalidates the sample — e.g. outputTokens corrected to 0 — must not
   * leave the superseded value in the window). No-op when absent. */
  removeThroughput(key: string): void {
    this.throughput = this.throughput.filter(sample => sample.key !== key)
  }

  /** The derived recent metrics (the ONE helper both folds share — plan
   * §6.4). No samples → 0, the established compat behavior. */
  derive(): { firstTokenMsAvg: number; tokensPerSec: number } {
    const ttft = latestSamples(this.ttft)
    const firstTokenMsAvg = ttft.length > 0
      ? ttft.reduce((sum, sample) => sum + sample.ttftMs, 0) / ttft.length
      : 0
    const throughput = latestSamples(this.throughput)
    const wallMs = throughput.reduce((sum, sample) => sum + sample.wallMs, 0)
    const outputTokens = throughput.reduce((sum, sample) => sum + sample.outputTokens, 0)
    const tokensPerSec = wallMs > 0 ? Math.round((outputTokens * 1000) / wallMs) : 0
    return { firstTokenMsAvg, tokensPerSec }
  }
}

/** Insert-or-replace by step key, then trim to the LATEST ordinals within
 * the caller's retention limit (a late-valid old step joins at its
 * ORIGINAL ordinal and may immediately fall out of the derived window —
 * it is an old step, not a newest one). */
function upsertSample<T extends { key: string; ordinal: number }>(samples: T[], sample: T, limit: number): void {
  const index = samples.findIndex(existing => existing.key === sample.key)
  if (index >= 0) samples[index] = sample
  else samples.push(sample)
  if (samples.length > limit) {
    samples.sort((a, b) => a.ordinal - b.ordinal)
    samples.splice(0, samples.length - limit)
  }
}

/** The window's latest-N samples in completion order. */
function latestSamples<T extends { ordinal: number }>(samples: readonly T[]): T[] {
  return [...samples].sort((a, b) => a.ordinal - b.ordinal).slice(-RECENT_PERFORMANCE_SAMPLE_LIMIT)
}

/** The performance route key of a settled message: the (provider, model)
 * TUPLE, encoded unambiguously — plain '/' concatenation would collide
 * `("a/b", "c")` with `("a", "b/c")` and miss a real route change. A
 * message without a clear model-source identity yields undefined — the
 * window never resets on a missing key (fail-soft). */
function routeKeyOf(message: { source?: unknown }): string | undefined {
  const source = (message as { source?: { kind?: unknown; provider?: unknown; model?: unknown } }).source
  if (source?.kind !== 'model') return undefined
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined
  return JSON.stringify([source.provider, source.model])
}

/** Advance the late-replay fence and clear the previous turn once. */
function advanceTimingTurn(
  open: Map<string, StepTiming>,
  settled: Map<string, StepTiming>,
  ended: Set<string>,
  current: number | undefined,
  turn: number,
): number | undefined {
  // Event logs are normally monotonic. Keeping a monotonic fence also makes
  // an out-of-order older replay unable to mutate the current turn's timing.
  if (current === undefined || turn > current) {
    open.clear()
    settled.clear()
    ended.clear()
    return turn
  }
  return current
}

/**
 * The Web's first-token predicate (dsh-llm `isTokenDelta`): any non-empty
 * text or reasoning delta, or a tool-call delta carrying content. The TUI
 * must stamp the SAME boundary or its TTFT starts at the first
 * visible token and inflates on reasoning models.
 */
function isTokenDelta(chunk: { type: string; text?: string; argumentsDelta?: string; name?: unknown }): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== undefined && chunk.text !== ''
    case 'tool-call-delta':
      return (chunk.argumentsDelta ?? '') !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * Fold the session log into performance statistics.
 * @param events - the session log.
 * @returns aggregated statistics.
 */
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  const stats: SessionStats = { ...EMPTY }
  const perStep = new Map<string, StepTiming>()
  // Keep settled samples only until their turn closes, so a late duplicate
  // assistant/message can replace its output-token sample without retaining
  // timing state for the full session.
  const settledPerStep = new Map<string, StepTiming>()
  // Step boundaries are idempotent within the active turn; older boundaries
  // are stale once the timing fence advances.
  const endedSteps = new Set<string>()
  const recent = new RecentPerformanceWindow()
  const usage = new StepUsageAccumulator()
  let completedTurnFence: number | undefined
  let lastTurn: number | undefined
  let settledTurn: number | undefined
  const enterSettledTurn = (turn: number): void => {
    settledTurn = advanceTimingTurn(perStep, settledPerStep, endedSteps, settledTurn, turn)
  }

  for (const event of events) {
    // Replacement surface events belong to the model-visible compaction view,
    // not the human transcript or its performance totals.
    if (isReplacementSurfaceEvent(event)) continue
    // The same lifecycle policy as the Focus fold: after turn/end a late
    // step/usage/message event of that turn is a replay artifact and is
    // ignored, so the footer and the Focus per-turn totals can never
    // diverge (review finding).
    if (event.type !== 'turn/end' && event.type !== 'request/context') {
      const eventTurn = (event.data as { turn?: unknown }).turn
      if (typeof eventTurn === 'number' && completedTurnFence !== undefined && eventTurn <= completedTurnFence) continue
    }
    // `assistant/attempt` (Session v2, typed STRUCTURALLY): the attempt
    // committed NO surface message — discard its provisional live usage
    // and open timing (parity with the class fold and with cold replay).
    if ((event.type as string) === 'assistant/attempt') {
      const failed = event.data as { turn: number; step: number }
      usage.discardStep(failed.turn, failed.step)
      const failedKey = stepKey(failed.turn, failed.step)
      const failedTiming = settledTurn === failed.turn ? perStep.get(failedKey) : undefined
      if (failedTiming !== undefined && failedTiming.settled !== true) perStep.delete(failedKey)
      continue
    }
    switch (event.type) {
      case 'turn/start': {
        // Advance the shared usage accounting (review finding).
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
        // the Focus per-turn total (review finding).
        usage.onTurnEnd(event.data.turn)
        // Drop all timing state of the ended turn (interrupted steps never
        // see their step/end; late events are replay artifacts).
        enterSettledTurn(event.data.turn)
        if (settledTurn === event.data.turn) {
          perStep.clear()
          settledPerStep.clear()
          endedSteps.clear()
        }
        break
      }
      case 'step/start': {
        const key = stepKey(event.data.turn, event.data.step)
        enterSettledTurn(event.data.turn)
        usage.onStepStart(event.data.turn, event.data.step)
        if (settledTurn !== event.data.turn || endedSteps.has(key) || perStep.has(key)) break
        settledPerStep.delete(key)
        perStep.set(key, { start: event.time })
        break
      }
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        enterSettledTurn(event.data.turn)
        const currentTimingTurn = settledTurn === event.data.turn
        const firstEnd = currentTimingTurn && !endedSteps.has(key)
        // The projection counts turns/steps at one unique step/end and
        // discards older-turn boundaries after the timing fence advances.
        if (firstEnd) {
          endedSteps.add(key)
          if (lastTurn !== event.data.turn) {
            stats.turns += 1
            lastTurn = event.data.turn
          }
          stats.steps += 1
        }
        usage.onStepEnd(event.data.turn, event.data.step)
        // The open timing entry is dropped at step/end, but retain its small
        // settled sample until turn/end so a late authoritative message can
        // replace output tokens without losing throughput parity.
        const timing = currentTimingTurn ? perStep.get(key) : undefined
        if (timing?.settled === true) settledPerStep.set(key, timing)
        if (currentTimingTurn) perStep.delete(key)
        break
      }
      case 'assistant/message': {
        enterSettledTurn(event.data.turn)
        const key = stepKey(event.data.turn, event.data.step)
        const timing = settledTurn === event.data.turn
          ? perStep.get(key) ?? settledPerStep.get(key)
          : undefined
        if (timing !== undefined) {
          // The message time is the step's LLM wall end and its usage is the
          // authoritative one; the whole step settles HERE (projection
          // semantics) — step/end only counts turns/steps and the usage.
          // A duplicate authoritative message may replace token usage, but it
          // must never add a second wall-time or performance sample.
          if (timing.settled !== true) {
            timing.completed = event.time
            if (event.data.usage !== undefined) timing.usage = event.data.usage
            settleStep(stats, key, timing, recent, routeKeyOf(event.data.message))
            timing.settled = true
          } else if (event.data.usage !== undefined) {
            timing.usage = event.data.usage
            replaceRecentThroughput(key, timing, event.data.usage, recent)
          }
        }
        usage.onAssistantMessage(event.data.turn, event.data.step, event.data.usage)
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

  applyDerivedPerformance(stats, recent)
  const totals = usage.sessionTotals()
  stats.inputTokens = totals.inputTokens
  stats.outputTokens = totals.outputTokens
  stats.cacheReadTokens = totals.cacheReadTokens
  stats.cacheWriteTokens = totals.cacheWriteTokens
  const billedInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  if (billedInput > 0) stats.cacheHitPct = (stats.cacheReadTokens * 100) / billedInput
  return stats
}

/** Write the recent window's derived metrics onto the stats (the ONE
 * shared derive path for both folds — plan §6.4). */
function applyDerivedPerformance(stats: SessionStats, recent: RecentPerformanceWindow): void {
  const derived = recent.derive()
  stats.firstTokenMsAvg = derived.firstTokenMsAvg
  stats.tokensPerSec = derived.tokensPerSec
}

/** Settle one step's TIMING at its assistant/message boundary: the
 * lifetime LLM wall, its completion ordinal, the route observation, and
 * the recent TTFB / effective-throughput samples. A step with no message
 * (cancelled/failed) never reaches here. Usage is NOT settled here;
 * step/end adds it once. */
function settleStep(
  stats: SessionStats,
  key: string,
  timing: StepTiming,
  recent: RecentPerformanceWindow,
  routeKey: string | undefined,
): void {
  const completed = timing.completed
  if (completed === undefined) return
  const start = timing.start
  if (start !== undefined) stats.llmMs += Math.max(0, completed - start)
  // One completion ordinal per step; the route check runs BEFORE the
  // samples join, so a model/provider switch starts a clean window.
  const ordinal = recent.claimOrdinal()
  timing.completionOrdinal = ordinal
  recent.observeRoute(routeKey)
  timing.routeKey = recent.routeKey
  timing.routeEpoch = recent.routeEpoch
  const first = timing.firstDelta
  if (first !== undefined && start !== undefined) {
    // TTFT: step/start → first token (the projection's ttftMs). A latency
    // sample — never token-weighted.
    recent.upsertTtft(key, ordinal, Math.max(0, first - start))
  }
  const usage = timing.usage
  if (usage !== undefined && start !== undefined) {
    // Effective throughput: Σ output / Σ FULL LLM wall. The sample
    // conditions (valid usage, a wall to divide by) need no multi-delta
    // streaming — a burst-delivered tool-call step samples on its whole
    // request wall (plan §2.2).
    const wallMs = Math.max(0, completed - start)
    if (usage.outputTokens > 0 && wallMs > 0) {
      recent.upsertThroughput(key, ordinal, wallMs, usage.outputTokens)
    }
  }
}

/** Replace the throughput sample of an already-settled step from a late
 * authoritative usage (assistant/message duplicate). The sample keeps its
 * original completion ordinal — it replaces, never appends; llmMs and
 * TTFB are never re-added; and a message belonging to a route the window
 * has moved past must not resurrect its sample into the current window.
 * The EPOCH is the authoritative gate: A → B → A returns to an equal
 * route STRING while the window belongs to the second A lifecycle, so
 * only `timing.routeEpoch === recent.routeEpoch` admits the replacement.
 * A replacement that turns the sample INVALID (outputTokens corrected to
 * 0) removes it: the superseded tokens must not keep feeding the recent
 * rate. */
function replaceRecentThroughput(
  key: string,
  timing: StepTiming,
  usage: UsageLike,
  recent: RecentPerformanceWindow,
): void {
  if (timing.routeKey !== undefined && recent.routeKey !== undefined && timing.routeKey !== recent.routeKey) return
  if (timing.routeEpoch !== undefined && timing.routeEpoch !== recent.routeEpoch) return
  if (timing.completionOrdinal === undefined) return
  const start = timing.start
  const completed = timing.completed
  if (start === undefined || completed === undefined) return
  const wallMs = Math.max(0, completed - start)
  if (usage.outputTokens <= 0 || wallMs <= 0) {
    recent.removeThroughput(key)
    return
  }
  recent.upsertThroughput(key, timing.completionOrdinal, wallMs, usage.outputTokens)
}

/** Token totals from one usage record (cache fields counted separately). */
function addUsage(stats: SessionStats, usage: UsageLike): void {
  stats.inputTokens += usage.inputTokens
  stats.outputTokens += usage.outputTokens
  stats.cacheReadTokens += usage.cacheReadTokens ?? 0
  stats.cacheWriteTokens += usage.cacheWriteTokens ?? 0
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
  // Retain only the current turn's settled samples for late message replay.
  private readonly settledPerStep = new Map<string, StepTiming>()
  // Step boundaries are idempotent within the active turn; older boundaries
  // are stale once the timing fence advances.
  private readonly endedSteps = new Set<string>()
  private settledTurn: number | undefined
  private readonly recent = new RecentPerformanceWindow()
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
   * from live suffixes; stats already has no secondary projection to defer.
   */
  hydrate(events: readonly SessionEvent[]): void {
    this.apply(events)
  }

  /**
   * Apply one live assistant stream input (Session v2 TRANSIENT plane).
   * Live performance metrics (TTFT, recent throughput samples) come from
   * the transient stream's timestamps/content; the durable plane carries
   * no per-chunk accounting anymore. Chunk frames carry the performance
   * content; the timing settles at the durable `assistant/message` on the
   * `session/event` plane. A FAILED attempt (abandoned end, or a
   * committed end whose durable settlement is `assistant/attempt`) leaves
   * no durable usage or timing — its provisional live accounting is
   * discarded so live and reopen agree.
   */
  applyLiveInput(input: AssistantLiveInput): void {
    if (input.kind === 'end' && (input.status === 'abandoned' || input.settlement === 'attempt')) {
      this.settleFailedAttempt(input.turn, input.step)
      return
    }
    if (input.kind !== 'chunk') return
    this.applyAssistantChunk(input.turn, input.step, input.time, input.chunk)
  }

  /** A failed-attempt settlement (Session v2): discard the step's
   * provisional live usage and open timing — the durable log carries
   * neither (an `assistant/attempt` embeds no usage; an abandoned attempt
   * has no durable fact at all), so cold replay shows the same numbers. */
  private settleFailedAttempt(turn: number, step: number): void {
    if (this.completedTurnFence !== undefined && turn <= this.completedTurnFence) return
    this.usage.discardStep(turn, step)
    const key = stepKey(turn, step)
    const timing = this.perStep.get(key)
    if (timing !== undefined && timing.settled !== true) {
      // Drop the open timing entry: a late step/end must commit nothing
      // for the failed step (its provisional usage is already gone).
      this.perStep.delete(key)
    }
  }

  /** Fold one live assistant chunk (Session v2 transient plane) into the
   * per-step timing: streaming usage (provisional — the durable
   * `assistant/message` replaces it at settle) and the first-token TTFT
   * stamp. */
  private applyAssistantChunk(turn: number, step: number, time: number, chunk: AssistantLiveChunk): void {
    // After turn/end a late live chunk is a replay artifact: it must not
    // mutate the per-step timing/usage — the same completed-turn gate as
    // the durable fold (mirrors TranscriptFolder's activity.completed).
    if (this.completedTurnFence !== undefined && turn <= this.completedTurnFence) return
    this.enterSettledTurn(turn)
    if (chunk.type === 'usage') {
      this.usage.onUsageChunk(turn, step, chunk.usage)
      const key = stepKey(turn, step)
      const timing = this.settledTurn === turn ? this.perStep.get(key) : undefined
      if (timing !== undefined) {
        // The LATEST chunk wins (the assembler value is cumulative) —
        // the same replace rule as the shared accumulator.
        timing.usage = chunk.usage
      }
    } else if (isTokenDelta(chunk)) {
      const timing = this.settledTurn === turn
        ? this.perStep.get(stepKey(turn, step))
        : undefined
      if (timing !== undefined && timing.settled !== true && timing.firstDelta === undefined) {
        timing.firstDelta = time
      }
    }
  }

  /** The derived stats as of the last applied event. */
  snapshot(): SessionStats {
    const derived: SessionStats = { ...this.stats }
    applyDerivedPerformance(derived, this.recent)
    const totals = this.usage.sessionTotals()
    derived.inputTokens = totals.inputTokens
    derived.outputTokens = totals.outputTokens
    derived.cacheReadTokens = totals.cacheReadTokens
    derived.cacheWriteTokens = totals.cacheWriteTokens
    const billedInput = derived.inputTokens + derived.cacheReadTokens + derived.cacheWriteTokens
    if (billedInput > 0) derived.cacheHitPct = (derived.cacheReadTokens * 100) / billedInput
    return derived
  }

  /** Advance the replay fence; a turn's settled samples are cleared once. */
  private enterSettledTurn(turn: number): void {
    this.settledTurn = advanceTimingTurn(this.perStep, this.settledPerStep, this.endedSteps, this.settledTurn, turn)
  }

  private applyEvent(event: SessionEvent): void {
    // Keep incremental stats on the same append-origin event stream as the
    // transcript and Focus folds; compaction replacements are model-only.
    if (isReplacementSurfaceEvent(event)) return
    if (event.type !== 'turn/end' && event.type !== 'request/context') {
      const eventTurn = (event.data as { turn?: unknown }).turn
      if (typeof eventTurn === 'number' && this.completedTurnFence !== undefined && eventTurn <= this.completedTurnFence) return
    }
    // `assistant/attempt` is a Session v2 durable settlement (master
    // vocabulary — typed STRUCTURALLY like the transcript fold): the
    // attempt committed NO surface message, so its provisional live usage
    // and timing are discarded (a cold replay of the same log shows the
    // same numbers).
    if ((event.type as string) === 'assistant/attempt') {
      const data = event.data as { turn: number; step: number }
      this.settleFailedAttempt(data.turn, data.step)
      return
    }
    switch (event.type) {
      case 'turn/start': {
        // Advance the shared usage accounting (review finding).
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
        // the Focus per-turn total (review finding).
        this.usage.onTurnEnd(event.data.turn)
        // Drop all timing state of the ended turn (interrupted steps never
        // see their step/end; late events are replay artifacts).
        this.enterSettledTurn(event.data.turn)
        if (this.settledTurn === event.data.turn) {
          this.perStep.clear()
          this.settledPerStep.clear()
          this.endedSteps.clear()
        }
        break
      }
      case 'step/start': {
        const key = stepKey(event.data.turn, event.data.step)
        this.enterSettledTurn(event.data.turn)
        this.usage.onStepStart(event.data.turn, event.data.step)
        if (this.settledTurn !== event.data.turn || this.endedSteps.has(key) || this.perStep.has(key)) break
        this.settledPerStep.delete(key)
        this.perStep.set(key, { start: event.time })
        break
      }
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        this.enterSettledTurn(event.data.turn)
        const currentTimingTurn = this.settledTurn === event.data.turn
        const firstEnd = currentTimingTurn && !this.endedSteps.has(key)
        // The projection counts turns/steps at one unique step/end and
        // discards older-turn boundaries after the timing fence advances.
        if (firstEnd) {
          this.endedSteps.add(key)
          if (this.lastTurn !== event.data.turn) {
            this.stats.turns += 1
            this.lastTurn = event.data.turn
          }
          this.stats.steps += 1
        }
        this.usage.onStepEnd(event.data.turn, event.data.step)
        // Drop the open entry, retaining only its small settled sample until
        // turn/end so a late authoritative message can preserve throughput
        // parity with the replacement token totals.
        const timing = currentTimingTurn ? this.perStep.get(key) : undefined
        if (timing?.settled === true) this.settledPerStep.set(key, timing)
        if (currentTimingTurn) this.perStep.delete(key)
        break
      }
      case 'assistant/message': {
        this.enterSettledTurn(event.data.turn)
        const key = stepKey(event.data.turn, event.data.step)
        const timing = this.settledTurn === event.data.turn
          ? this.perStep.get(key) ?? this.settledPerStep.get(key)
          : undefined
        if (timing !== undefined) {
          // Keep timing and performance sampling idempotent if a
          // malformed/replayed log carries the same authoritative message
          // more than once. The shared usage accumulator still applies
          // replacement semantics below.
          if (timing.settled !== true) {
            timing.completed = event.time
            if (event.data.usage !== undefined) timing.usage = event.data.usage
            settleStep(this.stats, key, timing, this.recent, routeKeyOf(event.data.message))
            timing.settled = true
          } else if (event.data.usage !== undefined) {
            timing.usage = event.data.usage
            replaceRecentThroughput(key, timing, event.data.usage, this.recent)
          }
        }
        this.usage.onAssistantMessage(event.data.turn, event.data.step, event.data.usage)
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

/** One decimal place, dropping a redundant ".0". */
function trimDecimal(value: number): string {
  const text = value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** Format seconds with one decimal ("8.1s"). */
function formatSeconds(ms: number): string {
  return `${trimDecimal(ms / 1000)}s`
}

/** Format a DURATION for the detail stats surface: `8.1s` under a minute,
 * `27m54s` under an hour, `1h06m05s` beyond — the lifetime LLM wall grows
 * into minutes and hours, where plain seconds stop being readable. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return formatSeconds(ms)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

/**
 * Render the DETAILED stats line (the /status Stats row and the
 * statusLine payload) in pi abbreviation vocabulary:
 * `↑34k ↓8.1k R520k CH93.9% | LLM 27m54s · TTFB 2.6s · 51 tok/s`
 * Cost (`$0.164`) is omitted: dsh's TokenUsage carries no price data.
 * The performance tail keeps BOTH windows, each labeled: the LIFETIME
 * `LLM ...` wall (this is the detail surface that still shows it — the
 * footer's stats row dropped it) beside the RECENT TTFB and throughput.
 * Context pressure lives in the footer's first line (progress bar), so it
 * is not repeated here. Turn/step counters live there too.
 * @param stats - the folded statistics.
 * @returns the display line.
 */
export function formatStats(stats: SessionStats): string {
  const piParts = [
    `↑${formatTokens(stats.inputTokens)}`,
    `↓${formatTokens(stats.outputTokens)}`,
    stats.cacheReadTokens > 0 ? `R${formatTokens(stats.cacheReadTokens)}` : '',
    stats.cacheWriteTokens > 0 ? `W${formatTokens(stats.cacheWriteTokens)}` : '',
    stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0 ? `CH${stats.cacheHitPct.toFixed(1)}%` : '',
  ].filter(part => part !== '')
  const ownParts = [
    `LLM ${formatDuration(stats.llmMs)}`,
    `TTFB ${formatSeconds(stats.firstTokenMsAvg)}`,
    `${stats.tokensPerSec} tok/s`,
  ]
  return `${piParts.join(' ')} | ${ownParts.join(' · ')}`
}
