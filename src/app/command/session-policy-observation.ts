/**
 * The ONE Client-local, per-runner session-policy observation owner
 * (M6-1 F8 §4.1). NOT a second business state machine: the Host's official
 * projections stay the only truth; this owner merely holds short-lived,
 * revocable read snapshots keyed by (Connection generation, sessionId,
 * observed subject ownership epoch) with latest-read-serial wins.
 *
 * Guarantees:
 *
 * - No cache beyond explicitly-keyed snapshots: a value from an older
 *   generation/subject/serial can never be presented as a newer answer.
 * - `refresh` performs exactly ONE `SessionPolicyPort.read`; the answer
 *   commits only when its serial is still the latest AND the subject and
 *   generation are unchanged. Disposal/invalidation cancels commits.
 * - `invalidate()` revokes truth (back to `checking`) without guessing; the
 *   caller decides whether to refresh.
 * - Disposal revokes every pending commit and releases every listener
 *   exactly once.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/session-policy-observation
 */

import type { PolicyObservationState } from './policy-observation-state.ts'
import type { SessionPolicyRead } from '../../runtime/session-policy-port.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runDetached } from '../../runtime/process/tasks.ts'

/** The narrow source face the observation owner reads. */
export interface SessionPolicyObservationSource {
  /** ONE authoritative read (the SessionPolicyPort). */
  read(sessionId: string, signal?: AbortSignal): Promise<SessionPolicyRead>
  /** The live Connection generation identity (object identity comparison). */
  generation(): object | undefined
  /** Whether the observed subject (owner generation + session id) is still
   *  the current display subject. */
  isSubjectCurrent(sessionId: string): boolean
  /** The runner diagnostics channel (dropped late reads and detached-read
   *  failures are recorded here; never a UI surface). */
  diag: Diag
}

export interface SessionPolicyObservation {
  /** The current committed state for one subject (checking when unknown). */
  readSnapshot(sessionId: string): PolicyObservationState
  /** Start one authoritative read; the returned promise settles with the
   *  COMMITTED state (latest-wins; a superseded read reports the newer one). */
  refresh(sessionId: string): Promise<PolicyObservationState>
  /** Revoke one subject's truth (or every subject's with no argument). */
  invalidate(sessionId?: string): void
  /** Client-local listeners (UI repaint); disposed with the owner. */
  subscribe(listener: () => void): () => void
  /** Cancel every pending commit and subscription; idempotent. */
  dispose(): void
}

interface SubjectEntry {
  state: PolicyObservationState
  serial: number
  generation: object | undefined
  /** The serial of the in-flight read, or undefined when none is running. A
   *  later `readSnapshot` may start a NEW read only while it is undefined. */
  inFlightSerial?: number
}

export function createSessionPolicyObservation(
  source: SessionPolicyObservationSource,
): SessionPolicyObservation {
  const subjects = new Map<string, SubjectEntry>()
  const listeners = new Set<() => void>()
  const controllers = new Set<AbortController>()
  let disposed = false

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const entryOf = (sessionId: string): SubjectEntry => {
    let entry = subjects.get(sessionId)
    if (entry === undefined) {
      entry = { state: { kind: 'checking' }, serial: 0, generation: source.generation() }
      subjects.set(sessionId, entry)
    }
    return entry
  }

  const stillLive = (entry: SubjectEntry): boolean =>
    !disposed && source.generation() === entry.generation

  /**
   * Start ONE controlled read for a subject. The returned promise never
   * rejects: every outcome is recorded as the subject's state, so a caller
   * may safely ignore it (the status/footer display path does exactly that).
   */
  const refresh = async (sessionId: string): Promise<PolicyObservationState> => {
      const entry = entryOf(sessionId)
      const serial = entry.serial + 1
      entry.serial = serial
      entry.generation = source.generation()
      // A NEW read starts from `checking`: the previous value is no longer an
      // authoritative currentness claim (a consumer may keep it visible as
      // clearly-marked last-known diagnostics, never as fresh Host truth).
      // The transition itself is NOT broadcast: only a COMMITTED read may
      // repaint consumers, so an invalidation/read-start never forces a
      // synchronous full status refresh inside an owner-commit callback.
      entry.state = { kind: 'checking' }
      if (disposed) return entry.state
      const controller = new AbortController()
      controllers.add(controller)
      entry.inFlightSerial = serial
      const settle = (state: PolicyObservationState): PolicyObservationState => {
        controllers.delete(controller)
        if (entry.inFlightSerial === serial) entry.inFlightSerial = undefined
        // A late settlement never downgrades a newer read: only the CURRENT
        // serial may commit, and disposal revokes everything.
        if (!disposed && entry.serial === serial) {
          entry.state = state
          notify()
        }
        return entry.state
      }
      let read: SessionPolicyRead
      try {
        read = await source.read(sessionId, controller.signal)
      } catch (error) {
        if (entry.serial !== serial) {
          source.diag.debug('session policy read superseded before failure', { session: sessionId })
          return entry.state
        }
        if (!stillLive(entry) || !source.isSubjectCurrent(sessionId)) {
          return settle({ kind: 'unavailable', reason: 'session-not-live' })
        }
        return settle({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
      }
      if (entry.serial !== serial) {
        source.diag.debug('session policy read superseded', { session: sessionId })
        return entry.state
      }
      if (read.kind === 'unavailable') {
        return settle({ kind: 'unavailable', reason: read.reason })
      }
      if (!stillLive(entry) || !source.isSubjectCurrent(sessionId)) {
        return settle({ kind: 'unavailable', reason: 'session-not-live' })
      }
      return settle({ kind: 'ready', read })
  }

  return {
    readSnapshot(sessionId) {
      // FIRST OBSERVATION of a subject, and a REVISITED subject whose truth
      // was invalidated (checking, no read running), each start exactly ONE
      // controlled read: the display/footer consumer asks synchronously, and
      // the answer lands through the same commit path (latest-wins,
      // subject/generation fenced).
      const entry = entryOf(sessionId)
      if (!disposed && entry.inFlightSerial === undefined && entry.state.kind === 'checking') {
        runDetached('session policy read', () => refresh(sessionId), { diag: source.diag, sessionId: () => sessionId })
      }
      return entry.state
    },
    refresh,
    invalidate(sessionId) {
      if (sessionId === undefined) {
        for (const entry of subjects.values()) {
          entry.serial += 1
          entry.state = { kind: 'checking' }
          entry.inFlightSerial = undefined
        }
      } else {
        const entry = subjects.get(sessionId)
        if (entry !== undefined) {
          entry.serial += 1
          entry.state = { kind: 'checking' }
          entry.inFlightSerial = undefined
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of subjects.values()) entry.serial += 1
      for (const controller of controllers) controller.abort()
      controllers.clear()
      listeners.clear()
    },
  }
}
