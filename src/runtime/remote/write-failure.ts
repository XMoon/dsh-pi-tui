/**
 * Remote write settlement classification (D2.2): map one official Client
 * `RemoteResult` failure (or an assembly throw) into the shared `WriteOutcome`
 * vocabulary without inventing a second Remote-only taxonomy.
 *
 * The official failure vocabulary is code-discriminated. Business refusals
 * carry their domain code (`session/*`, `subagent/*`, `agent-preset/*`, ...)
 * or the gateway's own admission code (`gateway/bad-request`); the universal
 * carrier codes (`gateway/cancelled`, `gateway/internal`) are the only ones
 * that describe transport/lifecycle rather than a proven Host refusal. A
 * failure this classifier cannot prove was a refusal must never be reported as
 * `rejected` — it stays `indeterminate`, because the write may still have
 * committed.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/write-failure
 */

import { isCancellation } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { WriteError, WriteOutcome } from '../write-outcome.ts'

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

/** A proven Host business refusal. Its code is preserved for diagnostics. */
function isRemoteBusinessRefusal(code: string | undefined): boolean {
  if (code === undefined) return false
  if (code === 'gateway/bad-request') return true
  // Every other `gateway/*` code is carrier infrastructure, never a business
  // refusal; domain codes (any other prefix) are the owner's own vocabulary.
  return !code.startsWith('gateway/')
}

/**
 * Classify one failed official write (a `RemoteResult` error branch, or a
 * thrown assembly fault) into the shared non-committed outcome vocabulary.
 */
export function classifyRemoteWriteFailure(error: unknown): RemoteWriteFailure {
  if (isRemoteCancellation(error)) return { kind: 'cancelled' }
  const code = remoteFailureCode(error)
  if (isRemoteBusinessRefusal(code)) {
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
