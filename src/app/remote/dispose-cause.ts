/**
 * Transport-neutral disposal failure chaining for the Remote composition.
 *
 * The helper is shared by the Host composition, the official Client runtime,
 * the Client UI subtree and the application aggregate. It deliberately lives
 * beside them (not inside `host-runtime.ts`) so a Client-only process entry can
 * reuse it without importing a Host-only value graph.
 *
 * @module app/remote/dispose-cause
 */

/**
 * Attach one secondary failure to `failure`'s cause chain without losing an
 * existing cause: when the failure already carries a cause, both aggregate
 * into a single `AggregateError`. A `undefined` secondary is a no-op.
 */
export function mergeCause(failure: Error, secondary: unknown): Error {
  if (secondary === undefined) return failure
  const existingCause = (failure as { cause?: unknown }).cause
  ;(failure as { cause?: unknown }).cause = existingCause === undefined
    ? secondary
    : new AggregateError([existingCause, secondary], 'remote composition: aggregated failure causes')
  return failure
}
