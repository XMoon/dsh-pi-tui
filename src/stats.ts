/**
 * Session performance statistics folded from the event log, mirroring pi's
 * footer usage line: turns/steps, LLM wall time, first-token latency,
 * output tokens per second, cache hit rate, and token totals.
 * Pure and deterministic for headless tests.
 *
 * Accounting follows the Web's sessionStats/tokenUsage projections:
 * - the FIRST TOKEN is any non-empty token delta — text, reasoning, or a
 *   tool-call delta (the Web's isTokenDelta). Stamping only text-delta made
 *   the decode window start at the first VISIBLE token, which is much later
 *   than the first model token on reasoning models — tok/s came out
 *   systematically high and TTFB too. The whole step's timing (LLM wall,
 *   TTFT, decode window) settles at assistant/message, exactly like the
 *   projection; a step that never produced a message (cancelled/failed)
 *   contributes no timing at all;
 * - usage is counted ONCE per step at step/end — the assistant/message
 *   usage replaces the streaming `usage` chunk (both carry the same
 *   assembler value; adding both would double the totals), and a step with
 *   only a usage chunk still counts (the projection's tokenUsage is
 *   step-keyed, not message-gated);
 * - turns/steps count at step/end (unique turns), like the projection;
 * - decode throughput samples only steps that carry BOTH a decode window
 *   (first token delta → assistant/message) and usage, so reasoning-only or
 *   tool-only steps never inflate the rate;
 * - billed input = uncached + cache-read + cache-write (the Web's
 *   billedInputTokens), and the cache-hit share divides by that sum.
 * @module @xmoon76/dsh-pi-tui/stats
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatTokens, StepUsageAccumulator, type UsageLike } from './token-usage.ts'

/** Aggregated session statistics. */
export interface SessionStats {
  /** Completed turns. */
  turns: number
  /** Model requests (steps). */
  steps: number
  /** Total model wall time (step/start → assistant/message), ms. */
  llmMs: number
  /** Average time from step/start to the first text delta, ms. */
  firstTokenMsAvg: number
  /** Output tokens per second over the sampled decode phases. */
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

/** Key identifying one step's model output (turn + step). */
function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

/** One step's timing accumulation, resolved at its boundaries. The usage
 * field feeds the decode-throughput sampling (settleStep); the token
 * ACCOUNTING itself lives in the shared {@link StepUsageAccumulator}, so
 * the footer and the Focus per-turn projection can never drift. */
interface StepTiming {
  start?: number
  firstDelta?: number
  completed?: number
  usage?: UsageLike
}

/**
 * The Web's first-token predicate (dsh-llm `isTokenDelta`): any non-empty
 * text or reasoning delta, or a tool-call delta carrying content. The TUI
 * must stamp the SAME boundary or its decode window starts at the first
 * visible token and tok/s inflates on reasoning models.
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

/** Timing/throughput accumulators shared by the fold and the folder. */
interface Throughput {
  /** Decode windows (ms) of steps sampled for tok/s. */
  outputMs: number[]
  /** Output tokens over the same sampled steps. */
  decodeTokens: number
  /** Summed TTFT over first-token steps. */
  firstTokenTotal: number
  /** Steps carrying a recorded first token. */
  firstTokenCount: number
}

/**
 * Fold the session log into performance statistics.
 * @param events - the session log.
 * @returns aggregated statistics.
 */
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  const stats: SessionStats = { ...EMPTY }
  const perStep = new Map<string, StepTiming>()
  const throughput: Throughput = { outputMs: [], decodeTokens: 0, firstTokenTotal: 0, firstTokenCount: 0 }
  const usage = new StepUsageAccumulator()
  let lastTurn: number | undefined

  for (const event of events) {
    switch (event.type) {
      case 'step/start':
        perStep.set(stepKey(event.data.turn, event.data.step), { start: event.time })
        usage.onStepStart(event.data.turn, event.data.step)
        break
      case 'step/end': {
        // The projection counts turns/steps here (unique turns) and discards
        // steps that never produced an assistant message; usage is still
        // counted once per step (the projection's tokenUsage is step-keyed).
        if (lastTurn !== event.data.turn) {
          stats.turns += 1
          lastTurn = event.data.turn
        }
        stats.steps += 1
        usage.onStepEnd(event.data.turn, event.data.step)
        // The step's timing is settled at assistant/message; drop the
        // entry so a long session's map stays bounded (review finding).
        perStep.delete(stepKey(event.data.turn, event.data.step))
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type === 'usage') {
          // Streaming usage is provisional: assistant/message carries the same
          // value and replaces it at settle, so it is counted exactly once.
          usage.onUsageChunk(event.data.turn, event.data.step, chunk.usage)
          const key = stepKey(event.data.turn, event.data.step)
          const timing = perStep.get(key)
          if (timing !== undefined) {
            // The LATEST chunk wins (the assembler value is cumulative) —
            // the same replace rule as the shared accumulator.
            timing.usage = chunk.usage
          }
        } else if (isTokenDelta(chunk)) {
          // The FIRST token delta of the step stamps the decode-window start
          // (Web firstTokenTime). Reasoning and tool-call deltas count too.
          const timing = perStep.get(stepKey(event.data.turn, event.data.step))
          if (timing !== undefined && timing.firstDelta === undefined) {
            timing.firstDelta = event.time
          }
        }
        break
      }
      case 'assistant/message': {
        const key = stepKey(event.data.turn, event.data.step)
        const timing = perStep.get(key)
        if (timing !== undefined) {
          // The message time is the step's decode end and its usage is the
          // authoritative one; the whole step settles HERE (projection
          // semantics) — step/end only counts turns/steps and the usage.
          timing.completed = event.time
          if (event.data.usage !== undefined) timing.usage = event.data.usage
          settleStep(stats, timing, throughput)
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

  if (throughput.firstTokenCount > 0) stats.firstTokenMsAvg = throughput.firstTokenTotal / throughput.firstTokenCount
  const streamMs = throughput.outputMs.reduce((sum, ms) => sum + ms, 0)
  if (streamMs > 0) stats.tokensPerSec = Math.round((throughput.decodeTokens * 1000) / streamMs)
  const totals = usage.sessionTotals()
  stats.inputTokens = totals.inputTokens
  stats.outputTokens = totals.outputTokens
  stats.cacheReadTokens = totals.cacheReadTokens
  stats.cacheWriteTokens = totals.cacheWriteTokens
  const billedInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  if (billedInput > 0) stats.cacheHitPct = (stats.cacheReadTokens * 100) / billedInput
  return stats
}

/** Settle one step's TIMING at its assistant/message boundary. A step with
 * no message (cancelled/failed) never reaches here — the projection counts
 * no timing for it. Usage is NOT settled here; step/end adds it once. */
function settleStep(stats: SessionStats, timing: StepTiming, throughput: Throughput): void {
  const completed = timing.completed
  if (completed === undefined) return
  const start = timing.start
  if (start !== undefined) stats.llmMs += Math.max(0, completed - start)
  const first = timing.firstDelta
  if (first !== undefined) {
    // TTFT: step/start → first token (the projection's ttftMs).
    throughput.firstTokenTotal += Math.max(0, first - (start ?? completed))
    throughput.firstTokenCount += 1
    // Sampled throughput: the decode window enters the denominator only when
    // the step also reported usage, and vice versa (projection sampled
    // semantics) — a reasoning-only or usage-less step skews neither side.
    const usage = timing.usage
    if (usage !== undefined) {
      throughput.outputMs.push(Math.max(0, completed - first))
      throughput.decodeTokens += usage.outputTokens
    }
  }
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
  private readonly throughput: Throughput = { outputMs: [], decodeTokens: 0, firstTokenTotal: 0, firstTokenCount: 0 }
  /** The shared per-step usage accounting (same class as the Focus fold). */
  private readonly usage = new StepUsageAccumulator()
  private lastTurn: number | undefined

  /**
   * Apply appended events in log order (a full log on resume, suffixes after).
   * @param events - the appended session events.
   */
  apply(events: readonly SessionEvent[]): void {
    for (const event of events) this.applyEvent(event)
  }

  /** The derived stats as of the last applied event. */
  snapshot(): SessionStats {
    const derived: SessionStats = { ...this.stats }
    if (this.throughput.firstTokenCount > 0) derived.firstTokenMsAvg = this.throughput.firstTokenTotal / this.throughput.firstTokenCount
    const streamMs = this.throughput.outputMs.reduce((sum, ms) => sum + ms, 0)
    if (streamMs > 0) derived.tokensPerSec = Math.round((this.throughput.decodeTokens * 1000) / streamMs)
    const totals = this.usage.sessionTotals()
    derived.inputTokens = totals.inputTokens
    derived.outputTokens = totals.outputTokens
    derived.cacheReadTokens = totals.cacheReadTokens
    derived.cacheWriteTokens = totals.cacheWriteTokens
    const billedInput = derived.inputTokens + derived.cacheReadTokens + derived.cacheWriteTokens
    if (billedInput > 0) derived.cacheHitPct = (derived.cacheReadTokens * 100) / billedInput
    return derived
  }

  private applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'step/start':
        this.perStep.set(stepKey(event.data.turn, event.data.step), { start: event.time })
        this.usage.onStepStart(event.data.turn, event.data.step)
        break
      case 'step/end': {
        if (this.lastTurn !== event.data.turn) {
          this.stats.turns += 1
          this.lastTurn = event.data.turn
        }
        this.stats.steps += 1
        this.usage.onStepEnd(event.data.turn, event.data.step)
        // The step's timing is settled at assistant/message; drop the
        // entry so the long-lived folder's map stays bounded (review
        // finding — the old fold deleted it here too).
        this.perStep.delete(stepKey(event.data.turn, event.data.step))
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type === 'usage') {
          this.usage.onUsageChunk(event.data.turn, event.data.step, chunk.usage)
          const key = stepKey(event.data.turn, event.data.step)
          const timing = this.perStep.get(key)
          if (timing !== undefined) {
            // The LATEST chunk wins (the assembler value is cumulative) —
            // the same replace rule as the shared accumulator.
            timing.usage = chunk.usage
          }
        } else if (isTokenDelta(chunk)) {
          const timing = this.perStep.get(stepKey(event.data.turn, event.data.step))
          if (timing !== undefined && timing.firstDelta === undefined) {
            timing.firstDelta = event.time
          }
        }
        break
      }
      case 'assistant/message': {
        const key = stepKey(event.data.turn, event.data.step)
        const timing = this.perStep.get(key)
        if (timing !== undefined) {
          timing.completed = event.time
          if (event.data.usage !== undefined) timing.usage = event.data.usage
          settleStep(this.stats, timing, this.throughput)
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

/**
 * Render the stats line in pi abbreviation vocabulary:
 * `↑34k ↓8.1k R520k CH93.9% | LLM 138.8s · TTFB 2.6s · 659 tok/s`
 * Cost (`$0.164`) is omitted: dsh's TokenUsage carries no price data.
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
    `LLM ${formatSeconds(stats.llmMs)}`,
    `TTFB ${formatSeconds(stats.firstTokenMsAvg)}`,
    `${stats.tokensPerSec} tok/s`,
  ]
  return `${piParts.join(' ')} | ${ownParts.join(' · ')}`
}
