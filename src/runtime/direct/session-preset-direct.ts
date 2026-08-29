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
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-preset-direct
 */

import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { normalizePersistedSessionPresetId } from '../session-preset.ts'

type AgentPresetProjectionKey = typeof agentPresetProjectionDefinition.key

/** The projection read surface supplied by DSH 0.1.2+. */
export interface SessionProjectionReader {
  stateOf(session: Session, key: AgentPresetProjectionKey): string | null | undefined
}

/** The persistence read surface needed to resolve a cold session. */
export interface SessionPersistenceReader {
  list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
}

/** The minimum context surface of the runner. */
export interface SessionPresetContext {
  get(name: string): unknown
}

/** Read the current preset from the official DSH projection. */
export function sessionPresetOf(
  ctx: SessionPresetContext,
  session: Session,
): string | undefined {
  const projections = ctx.get('sessionProjections') as SessionProjectionReader | undefined
  if (projections === undefined) return undefined
  return normalizePersistedSessionPresetId(projections.stateOf(session, 'agentPreset'))
}

/**
 * Resolve one persisted session's current preset before `agents.resume()`.
 * The inspected log is materialized as a detached Session solely so the DSH
 * projection registry can serve the same state it serves for a live Session.
 * A caller that already has the session header may pass it to avoid listing
 * the persistence backend a second time.
 */
export async function recordedSessionPreset(
  ctx: SessionPresetContext,
  sessionId: string,
  knownHeader?: SessionHeader,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceReader | undefined
  if (persistence === undefined) return undefined

  signal?.throwIfAborted()
  const known = knownHeader ?? (await persistence.list(signal)).find(candidate => String(candidate.id) === sessionId)
  signal?.throwIfAborted()
  if (known === undefined) return undefined

  const inspection = await persistence.inspect(SessionId(sessionId), signal)
  signal?.throwIfAborted()
  // Session.fromRestore and the persistence service retain DSH's fail-closed
  // unknown-event behavior. Do not turn an unsupported log into a header-only
  // session or silently compose the wrong preset.
  const session = Session.fromRestore(SessionId(sessionId), inspection.events, inspection.meta)
  return sessionPresetOf(ctx, session)
}
