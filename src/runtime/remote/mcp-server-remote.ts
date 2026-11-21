/**
 * The Remote MCP server port: the semantic `McpServerPort` over the official
 * generated `mcpManager` Client namespace (`watch` stream, `probe`, `restart`)
 * on the ONE authenticated Connection.
 *
 * Currentness is generation-bound: every frame and every settlement is tagged
 * with the Connection generation it belongs to, and a generation change ends
 * the observation stream. A late reply from a replaced Host is therefore
 * `superseded`/`outcome-unconfirmed`, never a current fact. `restart` is
 * dispatched at most once; after dispatch a transport/cancel/reconnect loss is
 * `outcome-unconfirmed` and is never retried.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/mcp-server-remote
 */

import {
  detachMcpProbeResult,
  detachMcpServerRoster,
  type McpServerGeneration,
  type McpServerOperationFailure,
  type McpServerPort,
  type McpServerProbeOutcome,
  type McpServerRestartOutcome,
  type McpServerWatchEvent,
} from '../mcp-server-port.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import {
  isRemoteCancellation,
  remoteFailureMessage,
  remoteFailureCode,
} from './write-failure.ts'
import { isRemoteBusinessRefusalCode } from '../write-outcome.ts'

/** The official `RemoteStreamHandle` subset the roster stream consumes. */
export interface RemoteMcpWatchHandle extends AsyncIterable<unknown> {
  dispose(): void
}

/** The official generated `mcpManager` namespace subset. */
export interface RemoteMcpManagerNamespace {
  watch(signal?: AbortSignal): RemoteMcpWatchHandle
  probe(name: string, signal?: AbortSignal): Promise<RemoteResultLike<unknown>>
  restart(name: string): Promise<RemoteResultLike<unknown>>
}

/** The narrow Client runtime face this adapter consumes. */
export interface RemoteMcpServerRuntimeSource {
  readonly remote: {
    /** Absent until the generated `@deepseek-ai/dsh-mcp-manager/remote`
     *  contribution is mounted: absence is a truthful unavailable. */
    readonly mcpManager?: RemoteMcpManagerNamespace
  }
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
}

/** One fixed, secret-free diagnostic of a failed Remote call. */
function reasonOf(error: unknown): string {
  const message = remoteFailureMessage(error)
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

/**
 * Classify one PER-DISPATCH Remote failure. A business refusal (a domain code,
 * `gateway/bad-request`, or a pinned pre-invocation Gateway code) proves the
 * Host refused the request; every other failure — cancellation, an unknown
 * Gateway code, `gateway/internal`, `gateway/result-invalid` or a code-less
 * failure — cannot prove the operation did not run.
 */
function classifyDispatchFailure(error: unknown): McpServerOperationFailure {
  if (isRemoteCancellation(error)) {
    return { kind: 'superseded', reason: reasonOf(error) }
  }
  if (isRemoteBusinessRefusalCode(remoteFailureCode(error))) {
    return { kind: 'rejected', reason: reasonOf(error) }
  }
  return { kind: 'outcome-unconfirmed', reason: reasonOf(error) }
}

/** The Remote MCP server management adapter. */
export class RemoteMcpServerPort implements McpServerPort {
  private readonly namespace: RemoteMcpManagerNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(runtime: RemoteMcpServerRuntimeSource) {
    this.namespace = runtime.remote.mcpManager
    this.generation = runtime.connection.generation
  }

  /** The opaque Host generation a request is dispatched under (never a Date). */
  private captureGeneration(): RemoteConnectionGeneration | undefined {
    return this.generation.getSnapshot()
  }

  /** Whether a captured generation is still the live Host generation. */
  private isCurrent(generation: RemoteConnectionGeneration | undefined): boolean {
    return generation !== undefined && Object.is(generation, this.generation.getSnapshot())
  }

  private unavailable(reason: string): McpServerOperationFailure {
    return { kind: 'unavailable', reason }
  }

  watch(signal: AbortSignal): AsyncIterable<McpServerWatchEvent> {
    const owner = this
    return (async function* remoteMcpWatch(): AsyncGenerator<McpServerWatchEvent> {
      const namespace = owner.namespace
      if (namespace === undefined) {
        yield { kind: 'invalidated', reason: 'unavailable' }
        return
      }
      const generation = owner.captureGeneration()
      if (generation === undefined) {
        yield { kind: 'invalidated', reason: 'unavailable' }
        return
      }
      let resolveGenerationChanged!: () => void
      const generationChanged = new Promise<void>(resolve => { resolveGenerationChanged = resolve })
      const unsubscribe = owner.generation.subscribe(() => { resolveGenerationChanged() })
      if (!owner.isCurrent(generation)) resolveGenerationChanged()
      let handle: RemoteMcpWatchHandle | undefined
      try {
        handle = namespace.watch(signal)
        const iterator = handle[Symbol.asyncIterator]()
        while (!signal.aborted) {
          const nextResult = iterator.next().then(
            result => ({ kind: 'next' as const, result }),
            error => ({ kind: 'error' as const, error }),
          )
          const winner = await Promise.race([
            nextResult,
            generationChanged.then(() => ({ kind: 'connection-changed' as const })),
          ])
          if (winner.kind === 'connection-changed' || !owner.isCurrent(generation)) {
            yield { kind: 'invalidated', reason: 'connection-changed' }
            return
          }
          if (winner.kind === 'error') {
            if (!signal.aborted) yield { kind: 'invalidated', reason: 'watch-failed' }
            return
          }
          if (winner.result.done === true) {
            if (!signal.aborted) yield { kind: 'invalidated', reason: 'watch-ended' }
            return
          }
          if (signal.aborted) return
          const servers = detachMcpServerRoster(winner.result.value)
          if (servers === undefined) {
            // An unclassifiable status/entry shape refuses the whole frame: a
            // partial roster would hide a server from the management surface.
            yield { kind: 'invalidated', reason: 'watch-failed' }
            return
          }
          yield {
            kind: 'current',
            roster: { generation: generation as McpServerGeneration, servers },
          }
        }
      } catch {
        if (!signal.aborted) yield { kind: 'invalidated', reason: 'watch-failed' }
      } finally {
        unsubscribe()
        handle?.dispose()
      }
    })()
  }

  async probe(name: string, signal: AbortSignal): Promise<McpServerProbeOutcome> {
    const namespace = this.namespace
    if (namespace === undefined) {
      return { kind: 'failed', generation: FROZEN_NO_GENERATION, failure: this.unavailable('the generated mcpManager Remote namespace is not mounted') }
    }
    const generation = this.captureGeneration()
    if (generation === undefined) {
      return { kind: 'failed', generation: FROZEN_NO_GENERATION, failure: this.unavailable('the Host connection is not ready') }
    }
    if (signal.aborted) {
      return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the probe was cancelled before it was dispatched' } }
    }
    const result = await namespace.probe(name, signal).catch((error: unknown): RemoteResultLike<unknown> => ({ ok: false, error }))
    if (!this.isCurrent(generation)) {
      return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the Host connection changed during the probe' } }
    }
    if (!result.ok) {
      return { kind: 'failed', generation, failure: classifyDispatchFailure(result.error) }
    }
    const value = detachMcpProbeResult(result.value)
    if (value === undefined) {
      return {
        kind: 'failed',
        generation,
        failure: { kind: 'outcome-unconfirmed', reason: 'the Host probe result was not a readable McpProbeResult' },
      }
    }
    return { kind: 'settled', generation, value }
  }

  async restart(name: string, signal: AbortSignal): Promise<McpServerRestartOutcome> {
    const namespace = this.namespace
    if (namespace === undefined) {
      return { kind: 'failed', generation: FROZEN_NO_GENERATION, failure: this.unavailable('the generated mcpManager Remote namespace is not mounted') }
    }
    const generation = this.captureGeneration()
    if (generation === undefined) {
      return { kind: 'failed', generation: FROZEN_NO_GENERATION, failure: this.unavailable('the Host connection is not ready') }
    }
    // Cancellation BEFORE dispatch is the only case that provably had no
    // effect. After the call is issued, nothing below may claim cancellation.
    if (signal.aborted) {
      return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the restart was cancelled before it was dispatched' } }
    }
    const result = await namespace.restart(name).catch((error: unknown): RemoteResultLike<unknown> => ({ ok: false, error }))
    if (!this.isCurrent(generation)) {
      // The request may have reached the previous Host; its settlement can no
      // longer be observed through this generation. Never replayed.
      return {
        kind: 'failed',
        generation,
        failure: { kind: 'outcome-unconfirmed', reason: 'the Host connection changed after the restart was dispatched' },
      }
    }
    if (!result.ok) {
      const code = remoteFailureCode(result.error)
      // A proven business refusal (unknown server, cleanup incomplete, an
      // admission refusal) is the Host's own answer; a cancellation or an
      // unproven carrier failure AFTER dispatch stays unconfirmed.
      if (!isRemoteCancellation(result.error) && isRemoteBusinessRefusalCode(code)) {
        return { kind: 'failed', generation, failure: { kind: 'rejected', reason: reasonOf(result.error) } }
      }
      return {
        kind: 'failed',
        generation,
        failure: { kind: 'outcome-unconfirmed', reason: reasonOf(result.error) },
      }
    }
    return { kind: 'settled', generation, value: undefined }
  }
}

/**
 * The generation identity used when no Host generation could be captured. It
 * is a fixed sentinel, never a claim: the outcome it tags is always a failure.
 */
const FROZEN_NO_GENERATION: McpServerGeneration = Object.freeze({ unavailable: true })
