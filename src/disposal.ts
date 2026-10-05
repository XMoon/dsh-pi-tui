/**
 * The ONE synchronous disposal primitive (M3-6 PR3 plan D1): attempt every
 * cleanup step in caller-provided order, then surface the collected failure.
 *
 * The helper answers exactly one question — "attempt every synchronous
 * cleanup step in this order, then surface collected failure(s)" — and owns
 * nothing else: no async support, no ownership state, no logging, no retries
 * and no fallback. Ownership slots stay inside the owning module; every
 * orchestrator (bootstrap, TuiApp, SurfaceRuntime, the per-owner dispose
 * methods) keeps its own order and passes it here.
 *
 * Failure contract:
 * - zero failures: return;
 * - exactly one failure: rethrow the EXACT original thrown value;
 * - two or more failures: throw `AggregateError(failures, label)`.
 *
 * A throwing step never truncates its siblings.
 * @module @xmoon76/dsh-pi-tui/disposal
 */

/** Attempt every synchronous disposal step in order, surfacing failures. */
export function runSyncDisposalSteps(label: string, steps: readonly (() => void)[]): void {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, label)
}
