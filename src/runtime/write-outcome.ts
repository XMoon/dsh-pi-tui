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
