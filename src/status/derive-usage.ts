/**
 * Usage status derivation (plan §4.9): the structured projection of the
 * StatsFolder snapshot. The footer consumes THIS structure — never a
 * preformatted `statsLine` (which remains a display-only formatter output
 * for /status and legacy surfaces).
 * @module @xmoon76/dsh-pi-tui/status/derive-usage
 */

import type { SessionStats } from '../stats.ts'
import type { SessionStatusUsageProjection } from '../runtime/session-reader-port.ts'
import type { UsageStatus } from './types.ts'

/** The official cumulative facts that outrank a BOUNDED window's fold. */
export interface OfficialUsageFacts {
  readonly tokens: SessionStatusUsageProjection
  /** The official context-window capacity, when the route reports one. */
  readonly contextWindow?: number
}

/** Project a StatsFolder snapshot onto the structured usage section.
 * @param stats - the folded statistics.
 * @param contextTokens - the tokenMeter's live context measurement (the
 *   legacy footer's context source); falls back to the billed input sum.
 * @param official - the official cumulative `tokenUsage`/context capacity of
 *   a session whose event window is BOUNDED (the Remote branch): a partial
 *   fold cannot count the session's lifetime tokens, so the projection owns
 *   them here. The recent-window performance metrics and the turn/step
 *   counters stay the fold's own (they are window-scoped facts).
 */
export function usageFromStats(
  stats: SessionStats,
  contextTokens?: number,
  official?: OfficialUsageFacts,
): UsageStatus {
  const inputTokens = official === undefined ? stats.inputTokens : official.tokens.uncachedInputTokens
  const outputTokens = official === undefined ? stats.outputTokens : official.tokens.outputTokens
  const cacheReadTokens = official === undefined ? stats.cacheReadTokens : official.tokens.cacheReadTokens
  const cacheWriteTokens = official === undefined ? stats.cacheWriteTokens : official.tokens.cacheWriteTokens
  const contextWindow = official?.contextWindow ?? stats.contextWindow
  // When the OFFICIAL cumulative counters own the buckets, their billing rate
  // must be derived from the SAME buckets (the fold's rate may be a recent-
  // window figure). Without an override the fold's own rate passes through
  // untouched (Direct is unchanged).
  const billedInput = inputTokens + cacheReadTokens + cacheWriteTokens
  const cacheHitPct = official !== undefined && billedInput > 0
    ? (cacheReadTokens * 100) / billedInput
    : stats.cacheHitPct
  const used = contextTokens ?? billedInput
  const context = contextWindow === undefined || contextWindow <= 0
    ? undefined
    : {
        usedTokens: used,
        windowTokens: contextWindow,
        percent: Math.min(100, Math.max(0, Math.round((used * 100) / contextWindow))),
      }
  return {
    ...context === undefined ? {} : { context },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
    },
    ...cacheReadTokens > 0 || cacheWriteTokens > 0 ? { cacheHitPct } : {},
    performance: {
      // llmMs stays the session LIFETIME wall; the two status performance
      // metrics are the RECENT (last-5) averages folded by StatsFolder.
      llmMs: stats.llmMs,
      firstTokenMs: stats.firstTokenMsAvg,
      tokensPerSec: stats.tokensPerSec,
    },
    turns: stats.turns,
    steps: stats.steps,
  }
}
