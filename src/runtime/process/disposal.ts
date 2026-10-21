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
 * @module @xmoon76/dsh-pi-tui/runtime/process/disposal
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

/**
 * The same non-truncating attempt, for a batch that rolls back a PRIMARY failure:
 * every rollback step is attempted in caller-provided order, then the PRIMARY
 * value is thrown — aggregated by IDENTITY with the collected rollback failures,
 * the primary first and the rollback values FLAT, in step order
 * (`AggregateError([primary, r1, r2])`). One rollback obligation must never be
 * skipped because an earlier one threw, and every value a step threw stays ONE
 * entry — a user `AggregateError` is never flattened into its `.errors`. The step
 * loop is inlined (not delegated to {@link runSyncDisposalSteps}, which would
 * nest its own aggregate one level down).
 */
export function runSyncDisposalStepsWithPrimary(
  label: string,
  primary: unknown,
  steps: readonly (() => void)[],
): never {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) throw primary
  throw new AggregateError([primary, ...failures], label)
}
