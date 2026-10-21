/** Shared semantic settlement vocabulary for runtime operation ports. */

/** Stable details for an expected operation refusal. */
export interface WriteError {
  readonly code: string
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** Settlement vocabulary shared by Direct and future wire operations. */
export type WriteOutcome<T = undefined> =
  | { readonly kind: 'committed'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: WriteError }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'indeterminate'; readonly error: WriteError }
  | { readonly kind: 'unsupported'; readonly reason: string }

/**
 * Local operation OWNERSHIP — a SECOND, INDEPENDENT axis from the business
 * settlement (D2.3 v2 §0.2.1). `superseded` says only that this async
 * operation no longer owns the current TUI/cache surface; it says NOTHING
 * about whether the Host mutation committed. Never fold it into
 * `WriteOutcome` as a synonym for `cancelled`/`rejected`: a committed but
 * locally superseded result stays a real Host commit (UI-silent, non-retryable).
 */
export type OperationOwnership = 'current' | 'superseded'

/** A settlement result paired with its local ownership. */
export interface OperationResult<T = undefined> {
  readonly ownership: OperationOwnership
  readonly outcome: WriteOutcome<T>
}

/** Wrap a settlement that still owns the current surface. */
export function currentResult<T>(outcome: WriteOutcome<T>): OperationResult<T> {
  return { ownership: 'current', outcome }
}

/**
 * Pinned Gateway infrastructure codes raised strictly BEFORE the addressed
 * business method is invoked (descriptor/argument/receiver/endpoint resolution
 * and context/lookup provider resolution — all inside `prepareInvocation` and
 * boundary decoding): such a failure proves the operation did not commit. The
 * only Gateway code raised AFTER invocation is `gateway/result-invalid`, so it
 * is deliberately absent.
 */
export const GATEWAY_PRE_INVOCATION_CODES: ReadonlySet<string> = new Set([
  'gateway/ambiguous-endpoint',
  'gateway/arguments-invalid',
  'gateway/binding-invalid',
  'gateway/context-failed',
  'gateway/context-not-found',
  'gateway/context-unavailable',
  'gateway/definition-unavailable',
  'gateway/input-invalid',
  'gateway/invocation-unavailable',
  'gateway/lookup-failed',
  'gateway/lookup-not-found',
  'gateway/lookup-unavailable',
  'gateway/method-unavailable',
  'gateway/provider-mismatch',
  'gateway/service-unavailable',
  'gateway/signature-invalid',
])

/**
 * Whether a failure code PROVES the addressed operation was refused: domain
 * codes, `gateway/bad-request`, and the pinned pre-invocation Gateway
 * infrastructure codes qualify. `gateway/cancelled`, `gateway/internal`,
 * `gateway/result-invalid`, an unknown `gateway/*` code, or a code-less failure
 * do NOT (the commit state stays unproven).
 *
 * SCOPE: this predicate expresses ONLY the D2.2-verified write vocabulary plus
 * the pinned Gateway pre-invocation codes. It is NOT a general
 * idempotency/commit judgement: a domain code does not universally prove that
 * no mutation happened (e.g. `session/workspace-attach-failed` can follow a
 * successful Session create/fork). Later operation families (D2.3/D2.4) must
 * use their own operation-specific settlement table rather than extending this
 * helper.
 */
export function isRemoteBusinessRefusalCode(code: string | undefined): boolean {
  if (code === undefined) return false
  if (code === 'gateway/bad-request') return true
  if (code.startsWith('gateway/')) return GATEWAY_PRE_INVOCATION_CODES.has(code)
  // Domain codes (any other prefix) are the owner's own refusal vocabulary.
  return true
}
