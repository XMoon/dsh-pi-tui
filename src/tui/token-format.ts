/**
 * Compact terminal token-count FORMATTING (TS8-D): the pi.s footer
 * abbreviation vocabulary shared by the footer stats line, the Focus per-turn
 * token segment and the /status Stats row. This is presentation-only — the
 * token semantic/accounting authority is
 * `src/domain/transcript/usage.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/token-format
 */

/** Format a token count with pi.s footer rules: 1.5k, 190k, 1.0M, 86M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}
