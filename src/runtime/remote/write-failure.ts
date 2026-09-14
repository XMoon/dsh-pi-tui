/**
 * Remote write settlement classification (D2.2): map one official Client
 * `RemoteResult` failure into the shared `WriteOutcome` vocabulary without
 * inventing a second Remote-only taxonomy.
 *
 * The official failure vocabulary is code-discriminated. Business refusals
 * carry their domain code (`session/*`, `subagent/*`, `agent-preset/*`, ...),
 * the gateway's own admission code (`gateway/bad-request`), or one of the
 * pinned Gateway's infrastructure codes that are raised BEFORE the addressed
 * business method runs (descriptor/argument/receiver/endpoint resolution and
 * context/lookup provider resolution), so the operation definitely did not
 * commit. `gateway/cancelled` is a caller cancellation; `gateway/internal` and
 * `gateway/result-invalid` (which the Gateway raises AFTER the method returned)
 * leave the commit state unproven. A failure this classifier cannot prove was a
 * refusal must never be reported as `rejected` — it stays `indeterminate`,
 * because the write may still have committed.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/write-failure
 */

import { isCancellation } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { isRemoteBusinessRefusalCode, type WriteError, type WriteOutcome } from '../write-outcome.ts'

/** Structural official Remote failure: the stable `code` is the discriminator. */
export interface RemoteFailureLike {
  readonly code: string
  readonly message?: string
}

/** One non-committed settlement produced by a failed official write. */
export type RemoteWriteFailure =
  | { readonly kind: 'rejected'; readonly error: WriteError }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'indeterminate'; readonly error: WriteError }

/** Read the stable code off a structural official failure. */
export function remoteFailureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * The official Client carrier rebuilds a failure as a plain `{code, message,
 * details}` value across the wire, not necessarily an `Error` instance.
 * `safeErrorMessage` would `String()` such an object to `[object Object]`, so
 * prefer the structural `message` string before falling back.
 */
export function remoteFailureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return safeErrorMessage(error)
}

/** A caller/backend cancellation proved by the official code or the error name. */
function isRemoteCancellation(error: unknown): boolean {
  if (isCancellation(error)) return true
  const code = remoteFailureCode(error)
  return code === 'gateway/cancelled'
}

/**
 * Classify one failed official write (a `RemoteResult` error branch) into the
 * shared non-committed outcome vocabulary.
 */
export function classifyRemoteWriteFailure(error: unknown): RemoteWriteFailure {
  if (isRemoteCancellation(error)) return { kind: 'cancelled' }
  const code = remoteFailureCode(error)
  if (isRemoteBusinessRefusalCode(code)) {
    return {
      kind: 'rejected',
      error: {
        code: code as string,
        message: remoteFailureMessage(error),
      },
    }
  }
  return {
    kind: 'indeterminate',
    error: {
      code: code ?? 'session/write-indeterminate',
      message: remoteFailureMessage(error),
    },
  }
}

/** A rejection the adapter itself proved before any Host dispatch. */
export function remoteRejected<T>(code: string, message: string): WriteOutcome<T> {
  return { kind: 'rejected', error: { code, message } }
}

/** A pre-dispatch fence refusal: the operation is known not to have been sent. */
export function remoteNotDispatched<T>(): WriteOutcome<T> {
  return { kind: 'cancelled' }
}
