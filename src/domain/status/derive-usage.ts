/**
 * Usage status derivation (plan §4.9): the structured projection of the
 * StatsFolder snapshot. The footer consumes THIS structure — never a
 * preformatted compatibility string; the /status Stats row is rendered by
 * `src/tui/commands/status.ts` from the authority-grouped facts.
 * @module @xmoon76/dsh-pi-tui/domain/status/derive-usage
 */

import type { SessionStats } from './stats.ts'
import type { SessionStatusUsageProjection } from '../../runtime/session-reader-port.ts'
import type { UsageStatus } from './types.ts'

/** The official cumulative facts that outrank a BOUNDED window's fold. Each
 *  field is OPTIONAL and an absent field means "the owning projection cannot
 *  answer": on the Remote branch such a fact is OMITTED from the section —
 *  never replaced by the bounded window's partial fold (a recent window's
 *  token count is not a session total, and a lifetime billed sum is not the
 *  current context occupancy). */
export interface OfficialUsageFacts {
  readonly tokens?: SessionStatusUsageProjection
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
 *   them here. When this override is present it is the ONLY authority for
 *   those facts — a piece it cannot supply is omitted, never folded. The
 *   turn/step counters stay the fold's own (they are window-scoped facts).
 *
 * TPS plan PR-2: the measured performance values are NOT derived here. The
 * bundle's own Host `piTuiPerformance` projection is their only authority, and
 * `StatusRuntime` injects the derived figures into the returned section (see
 * `domain/status/performance-view.ts`); this projection contributes only the
 * lifetime `llmMs` that the fold genuinely owns.
 */
export function usageFromStats(
  stats: SessionStats,
  contextTokens?: number,
  official?: OfficialUsageFacts,
): UsageStatus {
  if (official !== undefined) {
    // Projection-owned: an unavailable piece is ABSENT (unknown), never the
    // bounded window's guess.
    const officialTokens = official.tokens
    const tokens = officialTokens === undefined
      ? undefined
      : {
          input: officialTokens.uncachedInputTokens,
          output: officialTokens.outputTokens,
          cacheRead: officialTokens.cacheReadTokens,
          cacheWrite: officialTokens.cacheWriteTokens,
        }
    const billedInput = tokens === undefined ? 0 : tokens.input + tokens.cacheRead + tokens.cacheWrite
    // The occupancy numerator is the OFFICIAL context measurement only: a
    // lifetime billed sum would masquerade as the current context usage.
    const windowTokens = official.contextWindow
    const context = windowTokens === undefined || windowTokens <= 0 || contextTokens === undefined
      ? undefined
      : {
          usedTokens: contextTokens,
          windowTokens,
          percent: Math.min(100, Math.max(0, Math.round((contextTokens * 100) / windowTokens))),
        }
    return {
      ...context === undefined ? {} : { context },
      ...tokens === undefined ? {} : { tokens },
      ...tokens !== undefined && billedInput > 0 && (tokens.cacheRead > 0 || tokens.cacheWrite > 0)
        ? { cacheHitPct: (tokens.cacheRead * 100) / billedInput }
        : {},
      performance: {
        llmMs: stats.llmMs,
      },
      turns: stats.turns,
      steps: stats.steps,
    }
  }
  const inputTokens = stats.inputTokens
  const outputTokens = stats.outputTokens
  const cacheReadTokens = stats.cacheReadTokens
  const cacheWriteTokens = stats.cacheWriteTokens
  const contextWindow = stats.contextWindow
  const billedInput = inputTokens + cacheReadTokens + cacheWriteTokens
  const cacheHitPct = stats.cacheHitPct
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
      // llmMs stays the session LIFETIME wall. The measured performance
      // values are the Host projection's, injected by StatusRuntime.
      llmMs: stats.llmMs,
    },
    turns: stats.turns,
    steps: stats.steps,
  }
}
