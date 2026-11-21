/**
 * The Direct MCP server port: the semantic `McpServerPort` over the ONE
 * official in-process Host manager (`ctx.mcpManager`).
 *
 * It owns no fleet, no status cache and no MCP protocol: `watch` forwards the
 * official manager stream, `probe` calls the official `probe(name, { signal })`
 * (which owns cancellation and cleanup) and `restart` calls the official
 * `restart(name)` exactly once. The official manager's own `internal/service`
 * replacement is a generation change: every stream ends and every in-flight
 * settlement becomes `superseded`, so a replaced Host authority can never be
 * presented as the current one.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/mcp-server-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  detachMcpProbeResult,
  detachMcpServerRoster,
  type McpServerGeneration,
  type McpServerPort,
  type McpServerProbeOutcome,
  type McpServerRestartOutcome,
  type McpServerWatchEvent,
} from '../mcp-server-port.ts'

/** The narrow Host context surface this adapter needs. */
export interface DirectMcpHostContextLike {
  get(name: string): unknown
  on?: Context['on']
}

/**
 * The structural official manager face consumed here. Only the management
 * surface is named; no manager entry/config type crosses this adapter.
 */
export interface McpManagerServiceLike {
  watch(signal: AbortSignal): AsyncIterable<unknown>
  probe(name: string, options?: { readonly signal?: AbortSignal }): Promise<unknown>
  restart(name: string): Promise<unknown>
}

/** The one fixed diagnostic for a Host failure (never a secret/URL/command). */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

/** The Direct MCP manager adapter. One instance per Direct Host composition. */
export class DirectMcpServerPort implements McpServerPort {
  private readonly ctx: DirectMcpHostContextLike
  /** Bumped when the official manager service is replaced (HMR/reload). */
  private epoch = 0
  /** The opaque generation identity of the current manager authority. */
  private generation: McpServerGeneration = Object.freeze({})
  private readonly serviceInvalidationListeners = new Set<() => void>()

  constructor(ctx: DirectMcpHostContextLike) {
    this.ctx = ctx
    ctx.on?.('internal/service', name => {
      if (name !== 'mcpManager') return
      this.epoch += 1
      this.generation = Object.freeze({})
      for (const listener of [...this.serviceInvalidationListeners]) listener()
    })
  }

  /** The live official manager, or undefined when this Host mounts none. */
  private manager(): McpManagerServiceLike | undefined {
    return this.ctx.get('mcpManager') as McpManagerServiceLike | undefined
  }

  /**
   * The opaque generation identity of the CURRENT manager authority. The
   * config-source read shares it, so a source verdict and a roster can be
   * proven to belong to the same Host generation.
   */
  currentGeneration(): McpServerGeneration {
    return this.generation
  }

  watch(signal: AbortSignal): AsyncIterable<McpServerWatchEvent> {
    const owner = this
    return (async function* directMcpWatch(): AsyncGenerator<McpServerWatchEvent> {
      const watchEpoch = owner.epoch
      const generation = owner.currentGeneration()
      const manager = owner.manager()
      if (manager === undefined) {
        yield { kind: 'invalidated', reason: 'unavailable' }
        return
      }
      let resolveServiceChanged!: () => void
      const serviceChanged = new Promise<void>(resolve => { resolveServiceChanged = resolve })
      const onServiceChanged = (): void => { resolveServiceChanged() }
      owner.serviceInvalidationListeners.add(onServiceChanged)
      try {
        const source = manager.watch(signal)
        const iterator = source[Symbol.asyncIterator]()
        try {
          while (!signal.aborted) {
            const nextResult = iterator.next().then(
              result => ({ kind: 'next' as const, result }),
              error => ({ kind: 'error' as const, error }),
            )
            const winner = await Promise.race([
              nextResult,
              serviceChanged.then(() => ({ kind: 'service-changed' as const })),
            ])
            if (winner.kind === 'service-changed' || owner.epoch !== watchEpoch) {
              yield { kind: 'invalidated', reason: 'service-changed' }
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
              // A status/entry shape this surface cannot classify refuses the
              // whole frame: never paint a partial or guessed roster.
              yield { kind: 'invalidated', reason: 'watch-failed' }
              return
            }
            yield { kind: 'current', roster: { generation, servers } }
          }
        } finally {
          await iterator.return?.(undefined)
        }
      } catch {
        if (!signal.aborted) yield { kind: 'invalidated', reason: 'watch-failed' }
      } finally {
        owner.serviceInvalidationListeners.delete(onServiceChanged)
      }
    })()
  }

  async probe(name: string, signal: AbortSignal): Promise<McpServerProbeOutcome> {
    const generation = this.currentGeneration()
    if (signal.aborted) {
      return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the probe was cancelled before it was dispatched' } }
    }
    const manager = this.manager()
    if (manager === undefined) {
      return { kind: 'failed', generation, failure: { kind: 'unavailable', reason: 'Host MCP Manager is not mounted' } }
    }
    let raw: unknown
    try {
      raw = await manager.probe(name, { signal })
    } catch (error) {
      if (this.generation !== generation) {
        return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the Host MCP manager changed during the probe' } }
      }
      // The official in-process probe throws only its documented
      // preconditions (unknown entry, changing config, incomplete cleanup,
      // disposed manager) — a PROVEN refusal that ran no probe.
      return { kind: 'failed', generation, failure: { kind: 'rejected', reason: reasonOf(error) } }
    }
    if (this.generation !== generation) {
      return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the Host MCP manager changed during the probe' } }
    }
    const value = detachMcpProbeResult(raw)
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
    const generation = this.currentGeneration()
    if (signal.aborted) {
      return { kind: 'failed', generation, failure: { kind: 'superseded', reason: 'the restart was cancelled before it was dispatched' } }
    }
    const manager = this.manager()
    if (manager === undefined) {
      return { kind: 'failed', generation, failure: { kind: 'unavailable', reason: 'Host MCP Manager is not mounted' } }
    }
    try {
      // The official restart takes no cancellation signal: after dispatch this
      // adapter never claims the operation was cancelled.
      await manager.restart(name)
    } catch (error) {
      if (this.generation !== generation) {
        return {
          kind: 'failed',
          generation,
          failure: { kind: 'superseded', reason: 'the Host MCP manager changed during the restart' },
        }
      }
      // A thrown official restart is its documented refusal (unknown entry,
      // incomplete cleanup, disposed manager): the request did not run.
      return { kind: 'failed', generation, failure: { kind: 'rejected', reason: reasonOf(error) } }
    }
    if (this.generation !== generation) {
      return {
        kind: 'failed',
        generation,
        failure: { kind: 'superseded', reason: 'the Host MCP manager changed during the restart' },
      }
    }
    return { kind: 'settled', generation, value: undefined }
  }
}
