/**
 * Footer formatters (plan §4.9/§7): the DISPLAY words for the structured
 * status facts. The StatusSnapshot never carries preformatted strings —
 * every presentation lives here, so a custom layout can pick a finite
 * formatter per item.
 * @module @xmoon76/dsh-pi-tui/footer/formatters
 */

import { formatTokens } from '../token-usage.ts'
import type { UsageStatus } from '../status/types.ts'

/** Whether cwd uses Windows path syntax rather than a POSIX filename with
 * a literal backslash. Drive paths and UNC paths are unambiguous; every other
 * path keeps POSIX's slash-only separator semantics. */
function isWindowsStyleCwd(cwd: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(cwd) || /^\\\\/u.test(cwd)
}

/** Split cwd using only the separators valid for its detected path syntax. */
function cwdParts(cwd: string): string[] {
  const separator = isWindowsStyleCwd(cwd) ? /[\\/]+/u : '/'
  return cwd.split(separator).filter(Boolean)
}

/** Whether a path is a filesystem root whose separator must be retained. */
function isRootCwd(cwd: string): boolean {
  if (/^\/+$/u.test(cwd) || /^[A-Za-z]:[\\/]+$/u.test(cwd)) return true
  return /^\\\\/u.test(cwd) && cwdParts(cwd).length === 2
}

/** Short cwd for the footer: last two path segments (idempotent). */
export function shortCwd(cwd: string): string {
  if (isRootCwd(cwd)) return cwd
  const parts = cwdParts(cwd)
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

/** Format a model according to the builtin style vocabulary. */
export function formatModel(
  provider: string | undefined,
  id: string,
  reasoningEffort: string | undefined,
  format: string,
): string {
  const label = `${provider === undefined ? '' : `${provider}/`}${id}`
    + (reasoningEffort === undefined ? '' : ` @${reasoningEffort}`)
  switch (format) {
    case 'plain':
      return label
    case 'compact':
      return id
    case 'badge':
    default:
      return `[${label}]`
  }
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'danger-full-access': 'yolo',
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  custom: 'custom',
}

/** Format the known permission preset ids. Unknown ids are unavailable to
 * the builtin item, preserving the legacy fail-soft behavior. */
export function formatPermissionPreset(id: string, format: string): string | undefined {
  const label = PERMISSION_LABELS[id]
  if (label === undefined) return undefined
  switch (format) {
    case 'plain':
      return label
    case 'compact':
      return id === 'read-only' ? 'ro' : id === 'workspace-write' ? 'ww' : label
    case 'badge':
    default:
      return `[${label}]`
  }
}

/** Format the plan state as a badge or a plain status label. */
export function formatPlanState(effective: boolean, pending: boolean | undefined, format: string): string | undefined {
  const state = pending !== undefined ? 'plan pending' : effective ? 'plan' : undefined
  if (state === undefined) return undefined
  return format === 'plain' ? state : `[${state}]`
}

/** Format a working directory using the finite builtin style vocabulary. */
export function formatWorkingDirectory(cwd: string, format: string): string {
  switch (format) {
    case 'basename': {
      if (isRootCwd(cwd)) return cwd
      return cwdParts(cwd).at(-1) ?? cwd
    }
    case 'full':
      return cwd
    case 'short':
    default:
      return shortCwd(cwd)
  }
}

/** Format a branch name either plainly or with a visible label. */
export function formatGitBranch(branch: string, format: string): string {
  return format === 'label' ? `branch: ${branch}` : branch
}

/** Context pressure, full form: `160.0K/1.0M (16%)`. */
export function formatContextFull(used: number, window: number, percent: number): string {
  return `${formatTokens(used)}/${formatTokens(window)} (${percent}%)`
}

/** Context pressure, percent form: `ctx 31%`. */
export function formatContextPercent(percent: number): string {
  return `ctx ${percent}%`
}

/** Cache-hit share, pi vocabulary: `CH93.9%`. */
export function formatCacheHitPi(pct: number): string {
  return `CH${pct.toFixed(1)}%`
}

/** Cache-hit share: `C 91.9%`. */
export function formatCacheHit(pct: number): string {
  return `C ${pct.toFixed(1)}%`
}

/** Cache-hit share without the item marker: `91.9%`. */
export function formatCacheHitCompact(pct: number): string {
  return `${pct.toFixed(1)}%`
}

/** Token usage, io form: `2579/5507` (input/output). */
export function formatTokenUsageIo(input: number, output: number): string {
  return `${input}/${output}`
}

/** Token usage, pi vocabulary: `↑34k ↓8.1k R520k W12k` — the session
 * cumulative usage; the cache-read/write terms hide while zero. */
export function formatTokenUsagePi(input: number, output: number, cacheRead: number, cacheWrite: number): string {
  return [
    `↑${formatTokens(input)}`,
    `↓${formatTokens(output)}`,
    cacheRead > 0 ? `R${formatTokens(cacheRead)}` : '',
    cacheWrite > 0 ? `W${formatTokens(cacheWrite)}` : '',
  ].filter(part => part !== '').join(' ')
}

/** Token usage, pi vocabulary under width pressure: `↑34k ↓8.1k` — the
 * cumulative input/output pair survives, the cache detail drops. */
export function formatTokenUsagePiCompact(input: number, output: number): string {
  return `↑${formatTokens(input)} ↓${formatTokens(output)}`
}

/** Token usage, total form: `8.1k tokens` (all billed token classes). */
export function formatTokenUsageTotal(input: number, output: number, cacheRead: number, cacheWrite: number): string {
  return `${formatTokens(input + output + cacheRead + cacheWrite)} tokens`
}

/** Token usage, compact total form: `8.1k` (all billed token classes). */
export function formatTokenUsageCompact(input: number, output: number, cacheRead: number, cacheWrite: number): string {
  return formatTokens(input + output + cacheRead + cacheWrite)
}

/** Performance, full form: `TTFB 2.6s · 51 tok/s` — the RECENT average
 * time-to-first-token and the RECENT effective throughput. The lifetime
 * `LLM` wall is no longer a footer fact (it still accumulates in
 * SessionStats.llmMs for /stats and session analysis). */
export function formatPerformanceFull(firstTokenMs: number, tokensPerSec: number): string {
  return `${formatPerformanceLatency(firstTokenMs)} · ${formatPerformanceSpeed(tokensPerSec)}`
}

/** Performance, compact pressure form: `2.6s 51t/s` — the full form's
 * facts with the shortened units (the composite item keeps BOTH facts; it
 * never degrades to a speed-only or latency-only style). */
export function formatPerformanceCompact(firstTokenMs: number, tokensPerSec: number): string {
  return `${formatPerformanceLatencyCompact(firstTokenMs)} ${formatPerformanceSpeedCompact(tokensPerSec)}`
}

/** Performance, speed-only form: `51 tok/s` — the recent effective
 * throughput. */
export function formatPerformanceSpeed(tokensPerSec: number): string {
  return `${tokensPerSec} tok/s`
}

/** Performance, speed-only compact form: `51t/s`. */
export function formatPerformanceSpeedCompact(tokensPerSec: number): string {
  return `${tokensPerSec}t/s`
}

/** Performance, latency-only form: `TTFB 2.6s` — the recent average
 * time-to-first-token. */
export function formatPerformanceLatency(firstTokenMs: number): string {
  return `TTFB ${formatSeconds(firstTokenMs)}`
}

/** Performance, latency-only compact form: `2.6s`. */
export function formatPerformanceLatencyCompact(firstTokenMs: number): string {
  return formatSeconds(firstTokenMs)
}

/** Turn/step counters: `t3/s7`, `t3`, or `s7`. */
export function formatTurnsSteps(turns: number, steps: number, format = 'both'): string {
  switch (format) {
    case 'turns':
      return `t${turns}`
    case 'steps':
      return `s${steps}`
    case 'both':
    default:
      return `t${turns}/s${steps}`
  }
}

/** The pi-vocabulary stats line (the legacy line-2 format), derived from
 * the STRUCTURED usage facts: `↑34k ↓8.1k R520k CH93.9% | TTFB 2.6s ·
 * 51 tok/s`. The performance tail carries the RECENT metrics only — the
 * lifetime `LLM` wall left the line so a legacy composite never mixes
 * lifetime and recent windows. Mirrors formatStats exactly (guarded by a
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
    `TTFB ${formatSeconds(usage.performance.firstTokenMs)}`,
    `${usage.performance.tokensPerSec} tok/s`,
  ]
  return `${piParts.join(' ')} | ${ownParts.join(' · ')}`
}

/** The pi-vocabulary stats line, compact pressure form:
 * `↑34k ↓8.1k · TTFB 2.6s · 659t/s` — input/output, ONE (recent) time
 * indicator and the (recent) throughput survive; the cache (R/W/CH)
 * facts are omitted under width pressure. The structured UsageStatus is
 * untouched and the legacy formatStatsLine contract is unchanged. */
export function formatStatsLineCompact(usage: UsageStatus): string {
  const piParts = [
    `↑${formatTokens(usage.tokens.input)}`,
    `↓${formatTokens(usage.tokens.output)}`,
  ]
  const ownParts = [
    `TTFB ${formatSeconds(usage.performance.firstTokenMs)}`,
    `${usage.performance.tokensPerSec}t/s`,
  ]
  return `${piParts.join(' ')} · ${ownParts.join(' · ')}`
}

/** The sandbox mode compact codes: `ro`, `ww`, `yolo`. An unknown future
 * mode keeps its original value (fail-soft — never an invented
 * abbreviation). */
export function formatSandboxModeCompact(mode: string): string {
  switch (mode) {
    case 'read-only': return 'ro'
    case 'workspace-write': return 'ww'
    case 'danger-full-access': return 'yolo'
    default: return mode
  }
}

/** The run-phase compact codes for the CURRENT RunPhase union (idle is
 * never rendered by the item). An unknown future phase keeps its original
 * value (fail-soft — never an invented abbreviation). */
export function formatRunPhaseCompact(phase: string): string {
  switch (phase) {
    case 'working': return 'work'
    case 'waiting-approval': return 'w-approval'
    case 'waiting-question': return 'w-question'
    case 'compacting': return 'compact'
    case 'applying-compaction': return 'apply-compact'
    default: return phase
  }
}

/** Version formatters: `tui` → `v0.4.0-alpha.1`, `dsh` → `dsh-0.1.2-alpha.2`,
 * `both` → `dsh-0.1.2-alpha.2/tui-0.4.0-alpha.1`. */
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
