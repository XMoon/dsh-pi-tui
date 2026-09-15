/**
 * Direct session-preset adapter for DSH 0.1.6-alpha.1+.
 *
 * The Harness owns the `agentPreset` projection. TUI callers must not fold the
 * session log themselves: the projection initializes from the creation header
 * and applies the latest `agent-preset/selected` event, which is the same state
 * used by the Harness when it rebuilds a session. If the projection service is
 * absent, the seam returns no preset rather than inventing a second fold or
 * treating a header as the current effective composition.
 *
 * Cold sessions are read through the official `sessionQuery.observeSession()`
 * observation seam: the engine owns live/cold source selection, persistence
 * borrow/preparation, projection-cache hydration, tail replay, and the
 * projection cut. The TUI only reads the current DSH V3 `agentPreset` value —
 * it never reconstructs a detached Session or reinterprets the projection.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-preset-direct
 */

import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'

type AgentPresetProjectionKey = typeof agentPresetProjectionDefinition.key

/** The projection read surface supplied by DSH 0.1.6-alpha.1+. */
export interface SessionProjectionReader {
  stateOf(session: Session, key: AgentPresetProjectionKey): string | null | undefined
}

/** The official observation lease (structural subset of `SessionObservation`). */
export interface SessionObservationLike {
  readonly source: 'live' | 'prepared'
  readonly header: SessionHeader
  readonly projections?: { readonly values?: { readonly agentPreset?: string | null } }
  [Symbol.dispose](): void
}

/** The official observation seam (structural subset of `sessionQuery`). */
export interface SessionQueryObservationLike {
  observeSession(
    sessionId: SessionId,
    options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' },
  ): Promise<SessionObservationLike>
}

/** The zero-I/O projection-cache hint (structural subset of
 * `sessionProjectionCache`). A row is possibly stale but never wrong; the
 * caller's header is the identity witness, so no log read is needed. The
 * master contract completes the checkpoint identity with the EXACT
 * inherited prefix length. */
export interface SessionProjectionCacheLike {
  cachedSnapshot(
    meta: SessionHeader,
    inheritedEventCount: ReturnType<typeof SessionLogOffset>,
    keys?: readonly AgentPresetProjectionKey[],
  ): { readonly values?: { readonly agentPreset?: string | null } } | undefined
}

/** The minimum context surface of the runner. */
export interface SessionPresetContext {
  get(name: string): unknown
}

/** The official `turnBoundary` projection value (structural subset). */
export interface TurnBoundaryProjectionLike {
  readonly openTurnStartSeq?: number | null
  readonly lastTurn?: number
}

/**
 * Whether the official turn-boundary projection reports a still-blank Session
 * — the SAME authority the official `agentPresets.select` blank re-check uses.
 * An absent value means no turn boundary was recorded yet (blank); a malformed
 * value is unknown (`undefined`), so the Host stays the final authority.
 */
export function turnBoundaryBlank(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object') return undefined
  const boundary = value as TurnBoundaryProjectionLike
  const open = boundary.openTurnStartSeq
  if (open !== null && typeof open !== 'number') return undefined
  if (typeof boundary.lastTurn !== 'number') return undefined
  return open === null && boundary.lastTurn === 0
}

/** The official `agentPresets.select` capability (structural). */
export interface AgentPresetSelectLike {
  select?(agent: unknown, agentPreset: string): Promise<string>
}

/**
 * Select the preset of a still-blank Session through the official in-process
 * `agentPresets.select` service. The Host owns the serialized switch ordering,
 * the blank-session re-check, the recompose transaction and the durable
 * `agent-preset/selected` commit; the TUI never reimplements them. A started
 * Session is refused by the Host with `agent-preset/locked`.
 * @throws when the preset service is absent or the Host refuses the switch.
 */
export async function selectBlankSessionPreset(
  ctx: SessionPresetContext,
  agent: unknown,
  presetId: string,
): Promise<string> {
  const presets = ctx.get('agentPresets') as AgentPresetSelectLike | undefined
  if (presets === undefined || typeof presets.select !== 'function') {
    throw new Error('agent presets unavailable in this deployment')
  }
  return presets.select(agent, presetId)
}

/** Read the raw current preset from the official DSH projection. */
export function sessionPresetOf(
  ctx: SessionPresetContext,
  session: Session,
): string | undefined {
  const projections = ctx.get('sessionProjections') as SessionProjectionReader | undefined
  if (projections === undefined) return undefined
  try {
    return projections.stateOf(session, 'agentPreset') ?? undefined
  } catch {
    // A projection read during teardown/after a bad cut is best-effort: the
    // preset is simply unknown, never a crash (the Host stays the authority).
    return undefined
  }
}

/**
 * Resolve one persisted session's current preset before `agents.resume()`.
 * The official `sessionQuery.observeSession()` seam owns the whole cold read:
 * live/cold source selection, persistence borrow/preparation, projection-cache
 * hydration, tail replay, and the projection cut. The TUI only reads the
 * current DSH V3 `agentPreset` value and never reinterprets it. An absent
 * observation seam returns no preset rather than reconstructing DSH observation
 * semantics in the TUI.
 * @param signal - cancellation for the cold observation.
 */
export async function recordedSessionPreset(
  ctx: SessionPresetContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const query = ctx.get('sessionQuery') as SessionQueryObservationLike | undefined
  if (query === undefined) return undefined

  signal?.throwIfAborted()
  const observation = await query.observeSession(SessionId(sessionId), { signal, projectionMode: 'all' })
  // Fence AFTER the observation await: a cancellation mid-read must not let the
  // caller compose/resume on a cancelled open (v2 §0.2.4/§0.5).
  signal?.throwIfAborted()
  try {
    return observation.projections?.values?.agentPreset ?? undefined
  } finally {
    observation[Symbol.dispose]()
  }
}
