/**
 * The MCP server management port (FR3) — the transport-neutral semantic
 * contract between the TUI and the ONE official Host MCP manager
 * (`ctx.mcpManager`, `@deepseek-ai/dsh-mcp-manager`), implemented by
 * `src/runtime/direct/mcp-server-direct.ts` (Direct, in-process) and by
 * `src/runtime/remote/mcp-server-remote.ts` (the authenticated generated
 * `mcpManager` Remote namespace).
 *
 * Authority: the official Host manager is the ONLY business truth for the
 * managed server roster, its runtime status, probe results and restarts. This
 * port keeps no fleet, no second registry and no cached status: it projects
 * the official views as DETACHED, read-only copies and forwards exactly two
 * intents (`probe`, `restart`) plus one observation stream (`watch`).
 *
 * Deliberate limits:
 *
 * - `McpManagedServerView.configured` means only "a configured or registered
 *   entry still exists in the manager". It NEVER identifies the config source:
 *   configured and plugin-registered entries are both `configured: true` while
 *   they live, and `false` marks a retained cleanup record after removal. The
 *   config SOURCE verdict is owned by `ConfigPort.mcpServerSources`.
 * - `restart` never returns "connected": it returns only that the Host
 *   accepted and settled the request. The new status arrives through `watch`.
 * - Every observation and operation result is bound to one opaque Host
 *   generation identity. A consumer must discard anything from a generation
 *   that is no longer current instead of presenting it as a fact.
 *
 * Error vocabulary (independent of the operation family): `unavailable` means
 * no Host manager / no connection to ask; `rejected` is a PROVEN Host refusal
 * (the request did not take effect); `superseded` means the caller's generation
 * or page is no longer current and the result must be discarded; and
 * `outcome-unconfirmed` means a request was dispatched but its settlement can
 * no longer be observed — it is never retried and never reported as success or
 * refusal.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/mcp-server-port
 */

import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/types'

/**
 * Opaque, process-local identity of one Host MCP-manager generation. Direct
 * uses the live adapter epoch; Remote uses the authenticated Connection
 * generation the request was dispatched under. It is never serialized and
 * carries no inspectable state: only `Object.is` comparison is meaningful.
 */
export type McpServerGeneration = object

/** One managed server project as a management surface lists it. */
export interface McpServerView {
  /** The configured `servers` key or plugin-registered name. */
  readonly name: string
  /** Whether an entry still exists; NEVER the config-source verdict. */
  readonly configured: boolean
  /** The official runtime status, detached from the Host value. */
  readonly status: McpManagedServerStatus
}

/** One authoritative roster read, bound to the generation that produced it. */
export interface McpServerRoster {
  readonly generation: McpServerGeneration
  /** The official list in the manager's own order (never re-sorted). */
  readonly servers: readonly McpServerView[]
}

/** Why an observation stream can no longer speak for the live Host. */
export type McpServerWatchInvalidationReason =
  | 'unavailable'
  | 'service-changed'
  | 'connection-changed'
  | 'watch-failed'
  | 'watch-ended'

/**
 * One observation frame. A `current` frame carries the complete roster for its
 * generation; an `invalidated` frame is terminal and makes the last roster
 * last-known only. A consumer re-subscribes after invalidation (never keeps a
 * listener on the replaced authority).
 */
export type McpServerWatchEvent =
  | { readonly kind: 'current'; readonly roster: McpServerRoster }
  | { readonly kind: 'invalidated'; readonly reason: McpServerWatchInvalidationReason }

/** Why an operation did not produce a current, trustworthy result. */
export type McpServerOperationFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'superseded'; readonly reason: string }
  | { readonly kind: 'outcome-unconfirmed'; readonly reason: string }

/** One operation settlement, bound to the generation it was dispatched under. */
export type McpServerOperationOutcome<T> =
  | { readonly kind: 'settled'; readonly generation: McpServerGeneration; readonly value: T }
  | { readonly kind: 'failed'; readonly generation: McpServerGeneration; readonly failure: McpServerOperationFailure }

/** One successful probe: negotiation and tool listing completed. */
export interface McpServerProbeSuccess {
  readonly ok: true
  /** The server-reported identity from `initialize`, when captured. */
  readonly serverInfo?: { readonly name: string; readonly version: string }
  /** The advertised tool names, capped by the official probe budget. */
  readonly toolNames: readonly string[]
  /** Whether the advertised list was longer than the returned names. */
  readonly truncated: boolean
  /** Wall-clock negotiation + listing duration, excluding cleanup. */
  readonly durationMs: number
}

/** One failed probe, attributed to the stage that raised it. */
export interface McpServerProbeFailure {
  readonly ok: false
  readonly stage: 'connect' | 'list'
  /** Diagnostic text of the failure (safe to display sanitized). */
  readonly message: string
  /** Wall-clock duration until the failure. */
  readonly durationMs: number
}

/**
 * The detached official probe outcome: the staged result PLUS its INDEPENDENT
 * transport-closure/cleanup facts. `ok: true` never implies a clean close —
 * a consumer must report an unconfirmed/failed cleanup as its own problem.
 */
export type McpServerProbeValue = (McpServerProbeSuccess | McpServerProbeFailure)
  & { readonly closeConfirmed: boolean; readonly cleanupError?: string }

/** One probe settlement: the official staged result plus its independent cleanup facts. */
export type McpServerProbeOutcome = McpServerOperationOutcome<McpServerProbeValue>

/** One restart settlement: whether the Host accepted/settled the request. */
export type McpServerRestartOutcome = McpServerOperationOutcome<undefined>

/**
 * The ONE MCP server management surface. Implementations adapt the official
 * Host manager only: they never spawn a server, never speak MCP themselves and
 * never keep a second status registry.
 */
export interface McpServerPort {
  /**
   * Observe the official roster: the current list on subscription, then the
   * complete list after every status/entry change, until `signal` aborts, the
   * manager disappears or the connection generation changes.
   */
  watch(signal: AbortSignal): AsyncIterable<McpServerWatchEvent>
  /**
   * Probe ONE server without touching its live instance. `signal` cancels the
   * caller's interest; the Host probe is cancelled where the official API
   * supports it.
   */
  probe(name: string, signal: AbortSignal): Promise<McpServerProbeOutcome>
  /**
   * Rebuild ONE server from its current entry. Dispatched AT MOST ONCE: there
   * is no automatic retry and a lost settlement stays `outcome-unconfirmed`.
   */
  restart(name: string, signal: AbortSignal): Promise<McpServerRestartOutcome>
}

/* ------------------------------------------------------------------------- *
 * Boundary detachment / validation.
 *
 * The Remote contribution crosses a real wire, so every view/result is
 * validated structurally and copied into a frozen plain object. Direct calls
 * the same helpers: the official value is already in process, but the port's
 * DTO contract stays identical for both transports and a consumer can never
 * observe a live Host object.
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** One detached cleanup result. */
function detachCloseResult(value: unknown): { closeConfirmed: boolean; cleanupError?: string } | undefined {
  if (!isRecord(value) || typeof value.closeConfirmed !== 'boolean') return undefined
  if (value.cleanupError !== undefined && typeof value.cleanupError !== 'string') return undefined
  return {
    closeConfirmed: value.closeConfirmed,
    ...value.cleanupError === undefined ? {} : { cleanupError: value.cleanupError },
  }
}

/**
 * Detach one official status value. An unrecognized status is `undefined` (the
 * whole frame is refused): a management surface must never paint a state it
 * cannot classify, and an unknown future state is NOT silently coerced to
 * `disabled`/`connected`.
 */
export function detachMcpServerStatus(value: unknown): McpManagedServerStatus | undefined {
  if (!isRecord(value)) return undefined
  switch (value.state) {
    case 'disabled':
      return Object.freeze({ state: 'disabled' as const })
    case 'closed': {
      const result = detachCloseResult(value.result)
      return result === undefined ? undefined : Object.freeze({ state: 'closed' as const, result: Object.freeze(result) })
    }
    case 'waiting-credentials':
      return typeof value.lastError === 'string'
        ? Object.freeze({ state: 'waiting-credentials' as const, lastError: value.lastError })
        : undefined
    case 'connecting':
      return isFiniteNumber(value.attempt) && value.attempt >= 0
        ? Object.freeze({ state: 'connecting' as const, attempt: value.attempt })
        : undefined
    case 'connected':
      return isFiniteNumber(value.toolCount) && value.toolCount >= 0
        && isFiniteNumber(value.connectedAt)
        ? Object.freeze({ state: 'connected' as const, toolCount: value.toolCount, connectedAt: value.connectedAt })
        : undefined
    case 'reconnecting':
      return isFiniteNumber(value.attempt) && isFiniteNumber(value.maxAttempts)
        && isFiniteNumber(value.nextRetryAtMs) && typeof value.lastError === 'string'
        ? Object.freeze({
            state: 'reconnecting' as const,
            attempt: value.attempt,
            maxAttempts: value.maxAttempts,
            nextRetryAtMs: value.nextRetryAtMs,
            lastError: value.lastError,
          })
        : undefined
    case 'failed': {
      if (value.reason === 'load') {
        return typeof value.lastError === 'string'
          ? Object.freeze({ state: 'failed' as const, reason: 'load' as const, lastError: value.lastError })
          : undefined
      }
      if (value.reason === 'cleanup') {
        const result = detachCloseResult(value.result)
        return result === undefined
          ? undefined
          : Object.freeze({ state: 'failed' as const, reason: 'cleanup' as const, result: Object.freeze(result) })
      }
      if (value.reason === 'gave-up' || value.reason === 'reconnect-disabled' || value.reason === 'unclosed-generation') {
        if (value.lastError !== undefined && typeof value.lastError !== 'string') return undefined
        return Object.freeze({
          state: 'failed' as const,
          reason: value.reason,
          ...value.lastError === undefined ? {} : { lastError: value.lastError },
        })
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** Detach one official `McpManagedServerView`; `undefined` = invalid wire value. */
export function detachMcpServerView(value: unknown): McpServerView | undefined {
  if (!isRecord(value)) return undefined
  const { name, configured } = value
  if (typeof name !== 'string' || typeof configured !== 'boolean') return undefined
  const status = detachMcpServerStatus(value.status)
  if (status === undefined) return undefined
  return Object.freeze({ name, configured, status })
}

/**
 * Detach one official roster (the `watch`/`list` frame). A single invalid
 * member refuses the WHOLE frame: a partial roster would silently hide a
 * server from the management surface.
 */
export function detachMcpServerRoster(value: unknown): readonly McpServerView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const servers: McpServerView[] = []
  for (const entry of value) {
    const view = detachMcpServerView(entry)
    if (view === undefined) return undefined
    servers.push(view)
  }
  return Object.freeze(servers)
}

/** Detach one official `McpProbeResult`; `undefined` = invalid wire value. */
export function detachMcpProbeResult(value: unknown): McpServerProbeValue | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.ok !== 'boolean') return undefined
  const closure = detachCloseResult(value)
  if (closure === undefined) return undefined
  if (value.ok) {
    if (!isStringArray(value.toolNames) || typeof value.truncated !== 'boolean' || !isFiniteNumber(value.durationMs)) {
      return undefined
    }
    if (value.serverInfo !== undefined) {
      if (!isRecord(value.serverInfo)
        || typeof value.serverInfo.name !== 'string'
        || typeof value.serverInfo.version !== 'string') return undefined
    }
    return Object.freeze({
      ok: true as const,
      toolNames: Object.freeze([...value.toolNames]),
      truncated: value.truncated,
      durationMs: value.durationMs,
      ...value.serverInfo === undefined
        ? {}
        : { serverInfo: Object.freeze({ name: value.serverInfo.name as string, version: value.serverInfo.version as string }) },
      closeConfirmed: closure.closeConfirmed,
      ...closure.cleanupError === undefined ? {} : { cleanupError: closure.cleanupError },
    })
  }
  if (value.stage !== 'connect' && value.stage !== 'list') return undefined
  if (typeof value.message !== 'string' || !isFiniteNumber(value.durationMs)) return undefined
  return Object.freeze({
    ok: false as const,
    stage: value.stage,
    message: value.message,
    durationMs: value.durationMs,
    closeConfirmed: closure.closeConfirmed,
    ...closure.cleanupError === undefined ? {} : { cleanupError: closure.cleanupError },
  })
}
