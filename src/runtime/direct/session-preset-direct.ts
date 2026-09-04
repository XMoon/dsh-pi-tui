/**
 * Direct session-preset adapter for DSH 0.1.2+.
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
 * projection cut. The TUI only reads the `agentPreset` projection value and
 * applies roster-aware legacy normalization — it never reconstructs a detached
 * Session just to read a projection.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-preset-direct
 */

import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import {
  normalizePersistedSessionPresetId,
  resolvePersistedSessionPresetId,
} from '../session-preset.ts'

type AgentPresetProjectionKey = typeof agentPresetProjectionDefinition.key

/** The projection read surface supplied by DSH 0.1.2+. */
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

/** Read the raw current preset from the official DSH projection. */
export function sessionPresetOf(
  ctx: SessionPresetContext,
  session: Session,
  availablePresetIds?: readonly string[],
): string | undefined {
  const projections = ctx.get('sessionProjections') as SessionProjectionReader | undefined
  if (projections === undefined) return undefined
  return normalizePersistedSessionPresetId(projections.stateOf(session, 'agentPreset'), availablePresetIds)
}

/**
 * Resolve one persisted session's current preset before `agents.resume()`.
 * The official `sessionQuery.observeSession()` seam owns the whole cold read:
 * live/cold source selection, persistence borrow/preparation, projection-cache
 * hydration, tail replay, and the projection cut. The TUI only reads the
 * `agentPreset` projection value and applies roster-aware legacy
 * normalization. An absent observation seam returns no preset rather than
 * reconstructing DSH observation semantics in the TUI.
 * @param signal - cancellation for the cold observation.
 * @param availablePresetIds - one roster snapshot shared by a batch caller;
 *   omitting it performs the single-session resolver probe when needed.
 */
export async function recordedSessionPreset(
  ctx: SessionPresetContext,
  sessionId: string,
  signal?: AbortSignal,
  availablePresetIds?: readonly string[],
): Promise<string | undefined> {
  const query = ctx.get('sessionQuery') as SessionQueryObservationLike | undefined
  if (query === undefined) return undefined

  signal?.throwIfAborted()
  const observation = await query.observeSession(SessionId(sessionId), { signal, projectionMode: 'all' })
  try {
    const projected = observation.projections?.values?.agentPreset
    return resolvePersistedSessionPresetId(
      normalizePersistedSessionPresetId(projected, availablePresetIds),
      availablePresetIds,
      ctx.get('agentPresets') as { readonly defaultId?: string; resolve(id?: string): Promise<{ readonly id: string }> } | undefined,
    )
  } finally {
    observation[Symbol.dispose]()
  }
}

/**
 * Resolve a raw `agentPreset` projection value (from an observation cut or a
 * projection-cache snapshot) to an effective preset id: roster-aware legacy
 * `code` normalization first, then the persisted-session resolver. Shared by
 * the single-session observation path and the picker's cache-hit path so both
 * apply exactly the same identity rules.
 */
export async function resolveProjectedPresetId(
  value: string | null | undefined,
  availablePresetIds: readonly string[] | undefined,
  presets: { readonly defaultId?: string; resolve(id?: string): Promise<{ readonly id: string }> } | undefined,
): Promise<string | undefined> {
  return resolvePersistedSessionPresetId(
    normalizePersistedSessionPresetId(value, availablePresetIds),
    availablePresetIds,
    presets,
  )
}
