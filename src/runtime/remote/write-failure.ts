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
  readonly details?: Readonly<Record<string, unknown>>
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
export function isRemoteCancellation(error: unknown): boolean {
  if (isCancellation(error)) return true
  const code = remoteFailureCode(error)
  return code === 'gateway/cancelled'
}

/** Whether one value is a structurally-owned wire record (never an array, a
 * class instance, or a primitive). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Copy one wire-shaped value into an owned frozen plain tree.
 *
 * The official failure `details` crosses the wire as JSON — nested `issues`
 * arrays and objects included — so plain objects, arrays and scalars are the
 * only transferable shapes. A non-plain value (a Host class instance,
 * function, symbol or bigint) is not wire data: it is detached to `undefined`
 * rather than escaping as a live Host object.
 */
function detachWireValue(value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(detachWireValue))
  if (!isPlainRecord(value)) return undefined
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) copy[key] = detachWireValue(entry)
  return Object.freeze(copy)
}

/**
 * Copy the official failure `details` into an owned, deeply frozen plain tree
 * so no Host-owned object — nested arrays/objects included — escapes the
 * adapter. A non-record `details` value, and an empty one that carries no
 * structural payload, is dropped.
 */
export function copyFailureDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!isPlainRecord((error as { readonly details?: unknown }).details)) return undefined
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries((error as { readonly details: Record<string, unknown> }).details)) {
    copy[key] = detachWireValue(entry)
  }
  const detached = Object.freeze(copy)
  return Object.keys(detached).length === 0 ? undefined : detached
}

/** Actionable recovery guidance for `session/writer-held`.
 *
 * The official Host reports only that a Session writer handle is held; it
 * cannot tell which process or context owns it, and the TUI must never take
 * over, kill a holder, force a resume, or retry automatically. The guidance is
 * therefore a recovery action for the user, and it must not claim a specific
 * holder. */
export const SESSION_WRITER_HELD_GUIDANCE =
  'this Session is already in use, possibly by another running DSH instance or context; exit the instance or context holding it, then retry'

/** The user-facing message for one settled failure code. `session/writer-held`
 * replaces the Host's internal diagnostic with actionable recovery guidance —
 * the code and `details` keep the machine-readable facts. */
export function settledWriteMessage(code: string | undefined, error: unknown): string {
  return code === 'session/writer-held' ? SESSION_WRITER_HELD_GUIDANCE : remoteFailureMessage(error)
}

/**
 * Classify one failed official write (a `RemoteResult` error branch) into the
 * shared non-committed outcome vocabulary.
 */
export function classifyRemoteWriteFailure(error: unknown): RemoteWriteFailure {
  if (isRemoteCancellation(error)) return { kind: 'cancelled' }
  const code = remoteFailureCode(error)
  const details = copyFailureDetails(error)
  if (isRemoteBusinessRefusalCode(code)) {
    return {
      kind: 'rejected',
      error: {
        code: code as string,
        message: settledWriteMessage(code, error),
        ...details === undefined ? {} : { details },
      },
    }
  }
  return {
    kind: 'indeterminate',
    error: {
      code: code ?? 'session/write-indeterminate',
      message: settledWriteMessage(code, error),
      ...details === undefined ? {} : { details },
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
