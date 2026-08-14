/**
 * Session performance statistics folded from the event log, mirroring pi's
 * footer usage line: turns/steps, LLM wall time, first-token latency,
 * output tokens per second, cache hit rate, and token totals.
 * Pure and deterministic for headless tests.
 *
 * Accounting follows the Web's turn-metrics fold (StatsLine.tsx):
 * - usage is counted ONCE per step — the `assistant/message` usage wins over
 *   the streaming `usage` chunk (both carry the same assembler value; adding
 *   both would double the totals);
 * - decode throughput samples only steps that carry BOTH a decode window
 *   (first text delta → assistant/message) and usage, so reasoning-only or
 *   tool-only steps never inflate the rate;
 * - billed input = uncached + cache-read + cache-write (the Web's
 *   billedInputTokens), and the cache-hit share divides by that sum.
 * @module @xmoon76/dsh-pi-tui/stats
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

/** Usage shape the fold accepts (the dsh TokenUsage's accounting fields). */
interface UsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One step's timing/usage accumulation, resolved at step/end. */
interface StepTiming {
  start?: number
  firstDelta?: number
  completed?: number
  usage?: UsageLike
}

/**
 * Fold the session log into performance statistics.
 * @param events - the session log.
 * @returns aggregated statistics.
 */
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  const stats: SessionStats = { ...EMPTY }
  const perStep = new Map<string, StepTiming>()
  const outputMs: number[] = []
  let decodeTokens = 0
  let firstTokenTotal = 0
  let firstTokenCount = 0

  for (const event of events) {
    switch (event.type) {
      case 'turn/end':
        stats.turns += 1
        break
      case 'step/start':
        stats.steps += 1
        perStep.set(stepKey(event.data.turn, event.data.step), { start: event.time })
        break
      case 'step/end': {
        const timing = perStep.get(stepKey(event.data.turn, event.data.step))
        if (timing === undefined) break
        settleStep(stats, timing, event.time, outputMs, (ms) => { decodeTokens += ms })
        perStep.delete(stepKey(event.data.turn, event.data.step))
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type === 'text-delta') {
          const timing = perStep.get(stepKey(event.data.turn, event.data.step))
          if (timing !== undefined && timing.firstDelta === undefined) {
            timing.firstDelta = event.time
            const start = timing.start
            if (start !== undefined) {
              firstTokenTotal += event.time - start
              firstTokenCount += 1
            }
          }
        } else if (chunk.type === 'usage') {
          // Streaming usage is provisional: assistant/message carries the same
          // value and overwrites it at settle, so it is counted exactly once.
          const key = stepKey(event.data.turn, event.data.step)
          const timing = perStep.get(key)
          if (timing !== undefined) {
            if (timing.usage === undefined) timing.usage = chunk.usage
          } else {
            // A usage chunk without a step boundary (replay edge): count once.
            addUsage(stats, chunk.usage)
          }
        }
        break
      }
      case 'assistant/message': {
        const timing = perStep.get(stepKey(event.data.turn, event.data.step))
        if (timing !== undefined) {
          // The message time is the step's decode end (the Web's
          // completedTime); the message usage is the authoritative one.
          timing.completed = event.time
          if (event.data.usage !== undefined) timing.usage = event.data.usage
        } else if (event.data.usage !== undefined) {
          // A message without a step boundary (replay edge): count once.
          addUsage(stats, event.data.usage)
        }
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

  if (firstTokenCount > 0) stats.firstTokenMsAvg = firstTokenTotal / firstTokenCount
  const streamMs = outputMs.reduce((sum, ms) => sum + ms, 0)
  if (streamMs > 0) stats.tokensPerSec = Math.round((decodeTokens * 1000) / streamMs)
  const billedInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  if (billedInput > 0) stats.cacheHitPct = (stats.cacheReadTokens * 100) / billedInput
  return stats
}

/** Settle one step at its end boundary: wall time, decode window, usage. */
function settleStep(
  stats: SessionStats,
  timing: StepTiming,
  endTime: number,
  outputMs: number[],
  addDecodeTokens: (tokens: number) => void,
): void {
  // Decode end prefers the assistant/message time (Web completedTime); a step
  // with no message event falls back to its step/end time.
  const completed = timing.completed ?? endTime
  const start = timing.start
  if (start !== undefined) stats.llmMs += Math.max(0, completed - start)
  const usage = timing.usage
  if (usage !== undefined) {
    addUsage(stats, usage)
    // Sampled throughput: the decode window enters the denominator only when
    // the step also reported usage, and vice versa (Web turn-metrics sampled
    // semantics) — a reasoning-only or usage-less step skews neither side.
    const first = timing.firstDelta
    if (first !== undefined) {
      outputMs.push(Math.max(0, completed - first))
      addDecodeTokens(usage.outputTokens)
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
  private readonly outputMs: number[] = []
  private decodeTokens = 0
  private firstTokenTotal = 0
  private firstTokenCount = 0

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
    if (this.firstTokenCount > 0) derived.firstTokenMsAvg = this.firstTokenTotal / this.firstTokenCount
    const streamMs = this.outputMs.reduce((sum, ms) => sum + ms, 0)
    if (streamMs > 0) derived.tokensPerSec = Math.round((this.decodeTokens * 1000) / streamMs)
    const billedInput = derived.inputTokens + derived.cacheReadTokens + derived.cacheWriteTokens
    if (billedInput > 0) derived.cacheHitPct = (derived.cacheReadTokens * 100) / billedInput
    return derived
  }

  private applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/end':
        this.stats.turns += 1
        break
      case 'step/start':
        this.stats.steps += 1
        this.perStep.set(stepKey(event.data.turn, event.data.step), { start: event.time })
        break
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        const timing = this.perStep.get(key)
        if (timing === undefined) break
        settleStep(this.stats, timing, event.time, this.outputMs, (tokens) => { this.decodeTokens += tokens })
        this.perStep.delete(key)
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type === 'text-delta') {
          const key = stepKey(event.data.turn, event.data.step)
          const timing = this.perStep.get(key)
          if (timing !== undefined && timing.firstDelta === undefined) {
            timing.firstDelta = event.time
            const start = timing.start
            if (start !== undefined) {
              this.firstTokenTotal += event.time - start
              this.firstTokenCount += 1
            }
          }
        } else if (chunk.type === 'usage') {
          const key = stepKey(event.data.turn, event.data.step)
          const timing = this.perStep.get(key)
          if (timing !== undefined) {
            if (timing.usage === undefined) timing.usage = chunk.usage
          } else {
            addUsage(this.stats, chunk.usage)
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
        } else if (event.data.usage !== undefined) {
          addUsage(this.stats, event.data.usage)
        }
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

/** Format a token count with pi.s footer rules: 1.5k, 190k, 1.0M, 86M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
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
