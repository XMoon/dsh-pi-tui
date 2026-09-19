/**
 * Opt-in wall-clock profiling for the Ctrl+F search hot path (perf plan S1
 * §4.2). Disabled by default: with `DSH_TUI_SEARCH_PROFILE` unset every method
 * is a no-op, so the hot path pays nothing. Enabled, ONE line per operation is
 * written with the APPLICABLE stages of that operation:
 *
 * - `search.semantic` — the indexed scan / prefix refinement (query changes only)
 * - `search.resolve-representatives` — the single O(results) representative pass
 * - `search.window` — the anchored projection (off-window jumps only)
 * - `search.presentation-commit` — resolving / building the presentation
 * - `search.rebuild` — the app's atomic commit + message-tree rebuild
 * - `search.scroll` — the viewport anchor (match jumps only)
 * - `search.total` — always
 *
 * A no-match/cleared operation therefore reports semantic/resolve/commit/rebuild
 * (there is nothing to project or scroll), and a same-window jump omits
 * `window`. That is enough for a real long-session before/after comparison
 * without a machine-dependent CI threshold.
 * @module @xmoon76/dsh-pi-tui/search-profile
 */

/** A short-lived profiling window for ONE search operation. */
export interface SearchProfile {
  /** Begin a window. No-op when the profiler is disabled. */
  start(): void
  /** Record the time since the previous stage (or the start) under `name`. */
  stage(name: string): void
  /** Emit the single summary line and close the window. */
  end(): void
}

/** Whether the local search profiler is enabled for this process. */
export function searchProfilingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_TUI_SEARCH_PROFILE === '1'
}

/**
 * Create a search profiler. `enabled === false` returns a cheap no-op instance
 * (no timers, no allocation on the hot path).
 * @param enabled - whether to record timings.
 * @param now - the clock (injectable for tests).
 * @param write - the line sink (injectable for tests).
 */
export function createSearchProfiler(
  enabled: boolean,
  now: () => number = () => performance.now(),
  write: (line: string) => void = line => { process.stderr.write(line) },
): SearchProfile {
  if (!enabled) {
    return { start: () => {}, stage: () => {}, end: () => {} }
  }
  let startedAt = 0
  let last = 0
  let active = false
  const parts: string[] = []
  return {
    start(): void {
      startedAt = now()
      last = startedAt
      parts.length = 0
      active = true
    },
    stage(name: string): void {
      // A stage outside an operation window is DROPPED rather than appended to
      // a stale line: a duplicated pass then surfaces as a duplicated stage in
      // the operation that actually ran it.
      if (!active) return
      const at = now()
      parts.push(`${name}=${(at - last).toFixed(1)}ms`)
      last = at
    },
    end(): void {
      if (!active) return
      active = false
      const at = now()
      parts.push(`search.total=${(at - startedAt).toFixed(1)}ms`)
      write(`[search-profile] ${parts.join(' ')}\n`)
    },
  }
}
