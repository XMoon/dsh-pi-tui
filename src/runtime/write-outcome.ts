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
 */
export function isRemoteBusinessRefusalCode(code: string | undefined): boolean {
  if (code === undefined) return false
  if (code === 'gateway/bad-request') return true
  if (code.startsWith('gateway/')) return GATEWAY_PRE_INVOCATION_CODES.has(code)
  // Domain codes (any other prefix) are the owner's own refusal vocabulary.
  return true
}
