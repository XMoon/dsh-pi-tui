/**
 * Footer formatters (plan §4.9/§7): the DISPLAY words for the structured
 * status facts. The StatusSnapshot never carries preformatted strings —
 * every presentation lives here, so a custom layout can pick a finite
 * formatter per item.
 * @module @xmoon76/dsh-pi-tui/footer/formatters
 */

import { formatTokens } from '../stats.ts'
import type { UsageStatus } from '../status/types.ts'

/** Short cwd for the footer: last two path segments (idempotent). */
export function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}

/** One decimal place, dropping a redundant ".0". */
function trimDecimal(value: number): string {
  const text = value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** Format milliseconds as seconds with one decimal ("8.1s"). */
export function formatSeconds(ms: number): string {
  return `${trimDecimal(ms / 1000)}s`
}

/** Context pressure, full form: `160.0K/1.0M (16%)`. */
export function formatContextFull(used: number, window: number, percent: number): string {
  return `${formatTokens(used)}/${formatTokens(window)} (${percent}%)`
}

/** Cache-hit share: `C 91.9%`. */
export function formatCacheHit(pct: number): string {
  return `C ${pct.toFixed(1)}%`
}

/** Token usage, io form: `2579/5507` (input/output). */
export function formatTokenUsageIo(input: number, output: number): string {
  return `${input}/${output}`
}

/** Performance, full form: `2.0s 40 tok/s`. */
export function formatPerformanceFull(llmMs: number, tokensPerSec: number): string {
  return `${formatSeconds(llmMs)} ${tokensPerSec} tok/s`
}

/** Turn/step counters: `t3/s7`. */
export function formatTurnsSteps(turns: number, steps: number): string {
  return `t${turns}/s${steps}`
}

/** The pi-vocabulary stats line (the legacy line-2 format), derived from
 * the STRUCTURED usage facts: `↑34k ↓8.1k R520k CH93.9% | LLM 138.8s ·
 * TTFB 2.6s · 659 tok/s`. Mirrors formatStats exactly (guarded by a
 * source-consistency test). */
export function formatStatsLine(usage: UsageStatus): string {
  const piParts = [
    `↑${formatTokens(usage.tokens.input)}`,
    `↓${formatTokens(usage.tokens.output)}`,
    usage.tokens.cacheRead > 0 ? `R${formatTokens(usage.tokens.cacheRead)}` : '',
    usage.tokens.cacheWrite > 0 ? `W${formatTokens(usage.tokens.cacheWrite)}` : '',
    usage.tokens.cacheRead > 0 || usage.tokens.cacheWrite > 0 ? `CH${(usage.cacheHitPct ?? 0).toFixed(1)}%` : '',
  ].filter(part => part !== '')
  const ownParts = [
    `LLM ${formatSeconds(usage.performance.llmMs)}`,
    `TTFB ${formatSeconds(usage.performance.firstTokenMs)}`,
    `${usage.performance.tokensPerSec} tok/s`,
  ]
  return `${piParts.join(' ')} | ${ownParts.join(' · ')}`
}

/** Version formatters: `tui` → `v0.3.3`, `dsh` → `dsh-0.1.1-rc.1`,
 * `both` → `dsh-0.1.1-rc.1/tui-0.3.3`. */
export function formatVersion(dshVersion: string | undefined, tuiVersion: string, format: string): string {
  switch (format) {
    case 'dsh':
      return dshVersion === undefined ? '' : `dsh-${dshVersion}`
    case 'both':
      return dshVersion === undefined ? `tui-${tuiVersion}` : `dsh-${dshVersion}/tui-${tuiVersion}`
    case 'tui':
    default:
      return `v${tuiVersion}`
  }
}
