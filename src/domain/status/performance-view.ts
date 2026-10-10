/**
 * The `piTuiPerformance` wire view and its display derivation.
 *
 * ONE formula, two scopes (plan §1.1), for one eligible completed model step
 * `s`:
 *
 * ```text
 * modelMs(s) = assistant/message.time - step/start.time
 * output(s)  = assistant/message usage.outputTokens
 * TPS        = (1000 * Σoutput(s)) / ΣmodelMs(s)
 * ```
 *
 * `modelMs` covers the whole model request — first-token wait, invisible
 * reasoning, generation, and same-step retries — but never tool execution
 * outside the step. `reasoningTokens` are already part of DSH's
 * `outputTokens`, so they are never added twice.
 *
 * `recent` is the last {@link RECENT_PERFORMANCE_SAMPLE_LIMIT} eligible
 * samples of the CURRENT `(provider, model)` route generation (an A→B→A route
 * change starts a clean window); `all` is every eligible sample of the Session.
 * TTFB is the arithmetic mean of the recent observable first-token latencies
 * (its own sample list, independent of `outputTokens > 0`).
 *
 * The module is transport/UI neutral and owns ONLY the view shape, the
 * weighted rate, and the display precision policy: it never selects a route,
 * folds an event, reads a Session, or holds a sample ring. The Host reducer
 * (`src/app/host/performance-projection.ts`) owns every sample; the Direct /
 * Remote carriers, `/status`, and the footer all read this one contract.
 *
 * @module @xmoon76/dsh-pi-tui/domain/status/performance-view
 */

/** The projection key registered on the official session-projection seam. */
export const PI_TUI_PERFORMANCE_KEY = 'piTuiPerformance'

/** How many eligible completed steps one scope keeps (plan §1.1 "last 5"). */
export const RECENT_PERFORMANCE_SAMPLE_LIMIT = 5

/** Weighted totals of one scope: raw sums only, never a rounded rate. */
export interface PerformanceCounter {
  /** Σ eligible output tokens (raw). */
  readonly outputTokens: number
  /** Σ eligible model request wall time, ms (raw). */
  readonly modelMs: number
  /** Eligible completed steps folded into this scope. */
  readonly samples: number
}

/** The recent scope also carries its own first-token evidence. */
export interface PerformanceRecentCounter extends PerformanceCounter {
  /** Σ observable first-token latencies, ms (raw). */
  readonly firstTokenMs: number
  /** First-token samples; independent of `samples`. */
  readonly firstTokenSamples: number
}

/**
 * The `piTuiPerformance` wire value: both scopes are ALWAYS present. An empty
 * Session is two zero counters — `derivePerformance()` is what turns "no
 * samples" into an absent value, never `0 tok/s`.
 */
export interface PiTuiPerformanceProjection {
  readonly recent: PerformanceRecentCounter
  readonly all: PerformanceCounter
}

/** The empty view (fresh objects: state is never aliased). */
export function emptyPerformanceView(): PiTuiPerformanceProjection {
  return {
    recent: { outputTokens: 0, modelMs: 0, samples: 0, firstTokenMs: 0, firstTokenSamples: 0 },
    all: { outputTokens: 0, modelMs: 0, samples: 0 },
  }
}

/**
 * The weighted average model-request output rate of one scope. `undefined`
 * when the paired totals cannot answer (no positive output or no positive
 * wall time) — never a zero stand-in for unknown.
 * @param outputTokens - Σ eligible output tokens.
 * @param modelMs - Σ eligible model request wall time, ms.
 * @returns tok/s at full precision, or `undefined`.
 */
export function rateFromTotals(outputTokens: number, modelMs: number): number | undefined {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined
  if (!Number.isFinite(modelMs) || modelMs <= 0) return undefined
  return (1000 * outputTokens) / modelMs
}

/**
 * The ONE display precision policy (plan §1.1): below 100 tok/s one decimal
 * place, at or above it an integer. The projection itself keeps raw sums, so
 * the same policy applies to every surface that renders a rate.
 * @param rate - a rate at full precision.
 * @returns the display number (a `number`, so trailing `.0` never appears).
 */
export function displayRate(rate: number): number {
  return rate < 100 ? Number(rate.toFixed(1)) : Math.round(rate)
}

/**
 * The display facts derived from one Session's own Host projection. Every
 * field is ABSENT when its authoritative source cannot answer — an absent
 * projection, a sample-less scope, or an unpaired total (plan §1.2).
 */
export interface DerivedPerformance {
  /** Recent (R5) average time from step/start to the first visible token, ms. */
  readonly firstTokenMs?: number
  /** Recent (R5) weighted model-request output rate, tok/s. */
  readonly tokensPerSec?: number
  /** Session-lifetime ("All") weighted model-request output rate, tok/s. */
  readonly sessionTokensPerSec?: number
}

/**
 * Derive the display facts of one Session's `piTuiPerformance` view. This is
 * pure arithmetic over the Host's raw counters: no route, event, or Session
 * selection happens here, and no value is inferred from local history.
 *
 * A rate requires BOTH a paired total and at least one eligible sample
 * (plan §3.2): a zero-sample scope is unknown, so stray counters in such a
 * scope never become a rate. The TTFB average carries its own sample gate.
 * @param projection - the Session's own Host projection, or `undefined` when
 *   the Host cannot serve that key.
 * @returns the present display facts (an empty object when nothing answers).
 */
export function derivePerformance(projection: PiTuiPerformanceProjection | undefined): DerivedPerformance {
  if (projection === undefined) return {}
  const tokensPerSec = projection.recent.samples > 0
    ? rateFromTotals(projection.recent.outputTokens, projection.recent.modelMs)
    : undefined
  const sessionTokensPerSec = projection.all.samples > 0
    ? rateFromTotals(projection.all.outputTokens, projection.all.modelMs)
    : undefined
  const firstTokenMs = projection.recent.firstTokenSamples > 0
    ? projection.recent.firstTokenMs / projection.recent.firstTokenSamples
    : undefined
  return {
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(tokensPerSec === undefined ? {} : { tokensPerSec: displayRate(tokensPerSec) }),
    ...(sessionTokensPerSec === undefined ? {} : { sessionTokensPerSec: displayRate(sessionTokensPerSec) }),
  }
}
