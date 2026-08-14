/**
 * Session performance statistics folded from the event log, mirroring pi's
 * footer usage line: turns/steps, LLM wall time, first-token latency,
 * output tokens per second, cache hit rate, and token totals.
 * Pure and deterministic for headless tests.
 * @module @dsh-pi-tui/tui-app/stats
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Aggregated session statistics. */
export interface SessionStats {
  /** Completed turns. */
  turns: number
  /** Model requests (steps). */
  steps: number
  /** Total model wall time (step/start → step/end), ms. */
  llmMs: number
  /** Average time from step/start to the first text delta, ms. */
  firstTokenMsAvg: number
  /** Output tokens per second over the streaming phases. */
  tokensPerSec: number
  /** Cache-read share of input tokens, 0–100. */
  cacheHitPct: number
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Context window advertised by the model route, when known. */
  contextWindow?: number
  /** Cache-read tokens (input share), accumulated while folding. */
  cacheReadTokens: number
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
}

/** Key identifying one step's model output (turn + step). */
function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

/**
 * Fold the session log into performance statistics.
 * @param events - the session log.
 * @returns aggregated statistics.
 */
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  const stats: SessionStats = { ...EMPTY }
  const stepStart = new Map<string, number>()
  const firstDelta = new Map<string, number>()
  const lastDelta = new Map<string, number>()
  const outputMs: number[] = []
  let firstTokenTotal = 0
  let firstTokenCount = 0

  for (const event of events) {
    switch (event.type) {
      case 'turn/end':
        stats.turns += 1
        break
      case 'step/start':
        stats.steps += 1
        stepStart.set(stepKey(event.data.turn, event.data.step), event.time)
        break
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        const start = stepStart.get(key)
        if (start !== undefined) stats.llmMs += event.time - start
        const first = firstDelta.get(key)
        const last = lastDelta.get(key)
        if (first !== undefined && last !== undefined) outputMs.push(last - first)
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type === 'text-delta') {
          const key = stepKey(event.data.turn, event.data.step)
          if (!firstDelta.has(key)) {
            firstDelta.set(key, event.time)
            const start = stepStart.get(key)
            if (start !== undefined) {
              firstTokenTotal += event.time - start
              firstTokenCount += 1
            }
          }
          lastDelta.set(key, event.time)
        } else if (chunk.type === 'usage') {
          addUsage(stats, chunk.usage)
        }
        break
      }
      case 'assistant/message': {
        if (event.data.usage !== undefined) addUsage(stats, event.data.usage)
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
  if (streamMs > 0) stats.tokensPerSec = Math.round((stats.outputTokens * 1000) / streamMs)
  const totalInput = stats.inputTokens + stats.cacheReadTokens
  if (totalInput > 0) stats.cacheHitPct = (stats.cacheReadTokens * 100) / totalInput
  return stats
}

/** Token totals from one usage record (cache reads counted separately). */
function addUsage(stats: SessionStats, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }): void {
  stats.inputTokens += usage.inputTokens
  stats.outputTokens += usage.outputTokens
  stats.cacheReadTokens += usage.cacheReadTokens ?? 0
}

/**
 * Incremental stats folding: apply appended events and read `snapshot()`
 * anytime. The footer refreshes on every step/turn boundary, so a per-event
 * fold keeps a long session's status line O(1) instead of re-scanning the
 * whole log (computeStats) per refresh.
 */
export class StatsFolder {
  private readonly stats: SessionStats = { ...EMPTY }
  private readonly stepStart = new Map<string, number>()
  private readonly firstDelta = new Map<string, number>()
  private readonly lastDelta = new Map<string, number>()
  private readonly outputMs: number[] = []
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
    if (streamMs > 0) derived.tokensPerSec = Math.round((derived.outputTokens * 1000) / streamMs)
    const totalInput = derived.inputTokens + derived.cacheReadTokens
    if (totalInput > 0) derived.cacheHitPct = (derived.cacheReadTokens * 100) / totalInput
    return derived
  }

  private applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/end':
        this.stats.turns += 1
        break
      case 'step/start':
        this.stats.steps += 1
        this.stepStart.set(stepKey(event.data.turn, event.data.step), event.time)
        break
      case 'step/end': {
        const key = stepKey(event.data.turn, event.data.step)
        const start = this.stepStart.get(key)
        if (start !== undefined) this.stats.llmMs += event.time - start
        const first = this.firstDelta.get(key)
        const last = this.lastDelta.get(key)
        if (first !== undefined && last !== undefined) this.outputMs.push(last - first)
        break
      }
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type === 'text-delta') {
          const key = stepKey(event.data.turn, event.data.step)
          if (!this.firstDelta.has(key)) {
            this.firstDelta.set(key, event.time)
            const start = this.stepStart.get(key)
            if (start !== undefined) {
              this.firstTokenTotal += event.time - start
              this.firstTokenCount += 1
            }
          }
          this.lastDelta.set(key, event.time)
        } else if (chunk.type === 'usage') {
          addUsage(this.stats, chunk.usage)
        }
        break
      }
      case 'assistant/message': {
        if (event.data.usage !== undefined) addUsage(this.stats, event.data.usage)
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
    stats.cacheReadTokens > 0 ? `CH${stats.cacheHitPct.toFixed(1)}%` : '',
  ].filter(part => part !== '')
  const ownParts = [
    `LLM ${formatSeconds(stats.llmMs)}`,
    `TTFB ${formatSeconds(stats.firstTokenMsAvg)}`,
    `${stats.tokensPerSec} tok/s`,
  ]
  return `${piParts.join(' ')} | ${ownParts.join(' · ')}`
}
