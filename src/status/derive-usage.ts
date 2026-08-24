/**
 * Usage status derivation (plan §4.9): the structured projection of the
 * StatsFolder snapshot. The footer consumes THIS structure — never a
 * preformatted `statsLine` (which remains a display-only formatter output
 * for /status and legacy surfaces).
 * @module @xmoon76/dsh-pi-tui/status/derive-usage
 */

import type { SessionStats } from '../stats.ts'
import type { UsageStatus } from './types.ts'

/** Project a StatsFolder snapshot onto the structured usage section.
 * @param stats - the folded statistics.
 * @param contextTokens - the tokenMeter's live context measurement (the
 *   legacy footer's context source); falls back to the billed input sum.
 */
export function usageFromStats(stats: SessionStats, contextTokens?: number): UsageStatus {
  const used = contextTokens ?? stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  const context = stats.contextWindow === undefined || stats.contextWindow <= 0
    ? undefined
    : {
        usedTokens: used,
        windowTokens: stats.contextWindow,
        percent: Math.min(100, Math.max(0, Math.round((used * 100) / stats.contextWindow))),
      }
  return {
    ...context === undefined ? {} : { context },
    tokens: {
      input: stats.inputTokens,
      output: stats.outputTokens,
      cacheRead: stats.cacheReadTokens,
      cacheWrite: stats.cacheWriteTokens,
    },
    ...stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0 ? { cacheHitPct: stats.cacheHitPct } : {},
    performance: {
      llmMs: stats.llmMs,
      firstTokenMs: stats.firstTokenMsAvg,
      tokensPerSec: stats.tokensPerSec,
    },
    turns: stats.turns,
    steps: stats.steps,
  }
}
