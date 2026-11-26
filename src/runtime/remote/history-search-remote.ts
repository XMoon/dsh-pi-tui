/**
 * The narrow Remote read adapter for the private `piTuiHistorySearch` namespace.
 *
 * It owns only the transport boundary: the exact same mounted Client namespace,
 * the borrowed Connection generation, cancellation, and the typed failure
 * vocabulary the search owner consumes. It never creates a second Client, a
 * second contribution or a Host service; the Host's own `ready/loading/
 * incomplete/unavailable/stale` answers cross unchanged.
 *
 * A missing optional namespace is the truthful `unavailable/service-missing`
 * answer, never an empty success. A non-Owner refusal, a transport failure and a
 * replaced generation stay three distinct outcomes: the caller must not render
 * a permission refusal as "no matches", and must never present a superseded
 * generation's answer as the current one.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/history-search-remote
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchRequest,
  HistorySearchResponse,
} from './pi-tui-history-search-contract.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { HistorySearchReadPort } from '../history-search-read-port.ts'
import { remoteFailureCode, remoteFailureMessage } from './write-failure.ts'

export type { HistorySearchReadPort } from '../history-search-read-port.ts'

/** The mounted private namespace slice (a missing namespace is legal). */
export interface RemoteHistorySearchNamespace {
  search(request: HistorySearchRequest, signal?: AbortSignal): Promise<RemoteResult<HistorySearchResponse>>
  readText(request: HistoryReadTextRequest, signal?: AbortSignal): Promise<RemoteResult<HistoryReadTextResponse>>
}

/** The authenticated Owner peer refused the read before the Host service ran. */
export class RemoteHistorySearchDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteHistorySearchDeniedError'
  }
}

/** A dispatched read failed; `code` is the pinned Remote code when there was one. */
export class RemoteHistorySearchFailedError extends Error {
  readonly code: string | undefined

  constructor(code: string | undefined, message: string) {
    super(message)
    this.name = 'RemoteHistorySearchFailedError'
    this.code = code
  }
}

/** The read belonged to a connection/generation that is no longer current. */
export class RemoteHistorySearchSupersededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteHistorySearchSupersededError'
  }
}

/**
 * The ONE Remote implementation of the history read port. The Host's own typed
 * `unavailable` answer is preserved; only an unregistered namespace or the
 * official `gateway/invocation-unavailable` answer is synthesized as
 * `service-missing`.
 */
export class RemoteHistorySearchPort implements HistorySearchReadPort {
  private readonly namespaceOf: () => RemoteHistorySearchNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: RemoteHistorySearchNamespace | undefined | (() => RemoteHistorySearchNamespace | undefined),
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespaceOf = typeof namespace === 'function' ? namespace : () => namespace
    this.generation = generation
  }

  async search(request: HistorySearchRequest, signal: AbortSignal): Promise<HistorySearchResponse> {
    const namespace = this.namespaceOf()
    if (namespace === undefined) return { kind: 'unavailable', reason: 'service-missing' }
    return await this.settle(
      captured => namespace.search(request, captured),
      signal,
      { kind: 'unavailable', reason: 'service-missing' },
    )
  }

  async readText(request: HistoryReadTextRequest, signal: AbortSignal): Promise<HistoryReadTextResponse> {
    const namespace = this.namespaceOf()
    if (namespace === undefined) return { kind: 'unavailable', reason: 'service-missing' }
    return await this.settle(
      captured => namespace.readText(request, captured),
      signal,
      { kind: 'unavailable', reason: 'service-missing' },
    )
  }

  private async settle<T extends { readonly kind: string }>(
    dispatch: (signal: AbortSignal | undefined) => Promise<RemoteResult<T>>,
    signal: AbortSignal,
    missing: T,
  ): Promise<T> {
    signal.throwIfAborted()
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new RemoteHistorySearchSupersededError('the Remote connection is not connected')
    }
    let result: RemoteResult<T>
    try {
      result = await dispatch(signal)
      signal.throwIfAborted()
    } catch (error) {
      signal.throwIfAborted()
      if (!Object.is(captured, this.generation.getSnapshot())) {
        throw new RemoteHistorySearchSupersededError('the Remote connection was replaced during the history read')
      }
      const code = remoteFailureCode(error)
      if (code === 'remote-access/denied') throw new RemoteHistorySearchDeniedError(remoteFailureMessage(error))
      if (code === 'gateway/cancelled') {
        throw new RemoteHistorySearchSupersededError('the Remote history read was cancelled by the carrier')
      }
      throw new RemoteHistorySearchFailedError(code, remoteFailureMessage(error))
    }
    if (!Object.is(captured, this.generation.getSnapshot())) {
      throw new RemoteHistorySearchSupersededError('the Remote connection was replaced during the history read')
    }
    if (!result.ok) {
      const code = remoteFailureCode(result.error)
      if (code === 'gateway/invocation-unavailable') return missing
      if (code === 'remote-access/denied') throw new RemoteHistorySearchDeniedError(remoteFailureMessage(result.error))
      if (code === 'gateway/cancelled') {
        throw new RemoteHistorySearchSupersededError('the Remote history read was cancelled by the carrier')
      }
      throw new RemoteHistorySearchFailedError(code, remoteFailureMessage(result.error))
    }
    return result.value
  }
}
