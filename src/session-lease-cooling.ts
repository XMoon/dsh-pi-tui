/**
 * The retired-session cooling verifier: decides when an old session's
 * physical owner lock may be released cross-process.
 *
 * The transition's job ends at the COMMIT + old-handle dispose. This
 * coordinator independently verifies that the old session is truly quiet
 * before the lock is handed back:
 *
 * ```text
 * dispose succeeded
 * + writer barrier drained (the transition waited for TUI writers)
 * + final flush succeeded (the snapshot was captured after it)
 * + quiet window (1s)
 * + durable state == final in-memory snapshot (event count, last seq,
 *   SHA-256 tail fingerprint) — every 500ms
 * + stable across 3 samples
 *     → releaseAfterVerifiedCooling(sessionId, epoch)
 * any uncertainty / mismatch that never resolves / read error / corruption
 *     → pinCooling(sessionId, epoch, reason)
 * ```
 *
 * **Epoch binding (the reactivation rule).** Every retirement runs under
 * the lifecycle epoch its `beginCooling` returned. The verifier re-checks
 * `isCoolingCurrent(sessionId, epoch)` at EVERY await boundary and its
 * release/pin go through the manager's epoch-atomic methods: a verifier
 * whose epoch is no longer current (the session was reactivated in this
 * process, or a newer retirement superseded it) observes only a STALE
 * result and becomes a silent no-op — it can never release or pin a
 * later lifecycle.
 *
 * An EMPTY (never-materialized) session has a fast path: the coordinator
 * accepts repeated authoritative `session "<id>" not found` inspections as
 * its stable state and releases (with the empty dir best-effort removed by
 * the physical lock layer).
 *
 * Parameters are hard-coded (not user-configurable); the whole verifier can
 * be disabled by `DSH_PI_TUI_SESSION_COOLING_RELEASE=0`, in which case
 * every touched lease stays with this process (the emergency fallback).
 * @module @xmoon76/dsh-pi-tui/session-lease-cooling
 */

import { createHash } from 'node:crypto'
import { runDetached } from './detached.ts'
import type { ProcessSessionLeaseManager, RetiredSessionSnapshot } from './session-lease-manager.ts'

/** The hard-coded cooling parameters (first version). */
export const COOLING_INITIAL_QUIET_MS = 1000
export const COOLING_SAMPLE_INTERVAL_MS = 500
export const COOLING_REQUIRED_STABLE_SAMPLES = 3
export const COOLING_MAX_MS = 5000
export const COOLING_TAIL_EVENTS = 16

/** The minimal event surface the fingerprint needs (a structural slice of
 *  the dsh session events). */
export interface FingerprintEventLike {
  seq: number
  type: string
  time?: number | string
  data?: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[]
}

/** SHA-256 tail fingerprint over the LAST `tail` events' stable fields. */
export function tailFingerprintOf(events: readonly FingerprintEventLike[], tail = COOLING_TAIL_EVENTS): string {
  const hash = createHash('sha256')
  for (const event of events.slice(-tail)) {
    hash.update(String(event.seq))
    hash.update('\u0000')
    hash.update(event.type)
    hash.update('\u0000')
    hash.update(event.time === undefined ? '' : String(event.time))
    hash.update('\u0000')
    hash.update(JSON.stringify(event.data ?? {}))
    hash.update('\u0000')
    hash.update(String(event.surfaceOp ?? ''))
    hash.update('\u0000')
    hash.update(JSON.stringify(event.sourceEventSeqs ?? []))
    hash.update('\u0001')
  }
  return hash.digest('hex')
}

/** The final pre-switch snapshot of a session (after whenIdle + flush). */
export function snapshotSession(session: {
  id: string
  events: readonly FingerprintEventLike[]
}): RetiredSessionSnapshot {
  const events = session.events
  return {
    sessionId: session.id,
    eventCount: events.length,
    lastSeq: events.length > 0 ? events[events.length - 1]!.seq : undefined,
    tailFingerprint: tailFingerprintOf(events),
    empty: events.length === 0,
    capturedAt: Date.now(),
  }
}

/** The persistence surface the verifier needs (inspect is the retirement
 *  barrier and the durable read). */
export interface CoolingPersistenceLike {
  inspect?(id: string, signal?: AbortSignal): Promise<{ events: readonly FingerprintEventLike[] }>
}

/** The diagnostics sink the verifier reports through. */
export interface CoolingDiagLike {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** One verification outcome. */
export type CoolingOutcome =
  | { kind: 'released'; elapsedMs: number; samples: number }
  | { kind: 'pinned'; reason: string }

/** The per-runner cooling coordinator. */
export class SessionLeaseCoolingCoordinator {
  private readonly deps: {
    leaseManager: ProcessSessionLeaseManager
    persistence: () => CoolingPersistenceLike | undefined
    diag: CoolingDiagLike
    /** Process-lifetime abort (cleanup). */
    signal?: AbortSignal
    /** Parameter override (TESTS ONLY — production uses the constants). */
    params?: { quietMs?: number; intervalMs?: number; requiredStable?: number; maxMs?: number }
  }
  private readonly params: {
    quietMs: number
    intervalMs: number
    requiredStable: number
    maxMs: number
  }

  constructor(deps: {
    leaseManager: ProcessSessionLeaseManager
    persistence: () => CoolingPersistenceLike | undefined
    diag: CoolingDiagLike
    /** Process-lifetime abort (cleanup). */
    signal?: AbortSignal
    /** Parameter override (TESTS ONLY — production uses the constants). */
    params?: { quietMs?: number; intervalMs?: number; requiredStable?: number; maxMs?: number }
  }) {
    this.deps = deps
    this.params = {
      quietMs: deps.params?.quietMs ?? COOLING_INITIAL_QUIET_MS,
      intervalMs: deps.params?.intervalMs ?? COOLING_SAMPLE_INTERVAL_MS,
      requiredStable: deps.params?.requiredStable ?? COOLING_REQUIRED_STABLE_SAMPLES,
      maxMs: deps.params?.maxMs ?? COOLING_MAX_MS,
    }
  }

  /** sessionId → the cooling epoch of the RUNNING verification. Keyed by
   *  epoch, NOT merely by session id: a newer retirement (epoch N+1) is
   *  accepted while an older one (epoch N) still runs — the old task
   *  naturally exits on its next epoch check, and its `finally` must not
   *  delete the newer epoch's entry. */
  private readonly inFlight = new Map<string, number>()

  /** Start verifying that a retired session (fire-and-forget; the outcome
   *  decides RELEASED vs PINNED). The verification runs as an owned
   *  detached task (never a bare void promise — the failure model). The
   *  epoch binds this task to ONE retirement: a start for an epoch that
   *  is ALREADY running is an idempotent no-op; a start for a DIFFERENT
   *  epoch supersedes the old task (it becomes stale at its next check). */
  start(sessionId: string, snapshot: RetiredSessionSnapshot, epoch: number): void {
    if (this.inFlight.get(sessionId) === epoch) return
    this.inFlight.set(sessionId, epoch)
    runDetached('session lease cooling', async () => {
      try {
        await this.verify(sessionId, snapshot, epoch)
      } finally {
        // Only the task holding the CURRENT epoch may clear the entry: a
        // stale task finishing late must never delete a newer epoch's
        // in-flight marker.
        if (this.inFlight.get(sessionId) === epoch) {
          this.inFlight.delete(sessionId)
        }
      }
    }, {
      diag: this.deps.diag as never,
      sessionId: () => sessionId,
    })
  }

  /** HMR/remount recovery: re-verify every lease the process-global
   *  manager still has in COOLING (a remounted runner's fresh coordinator
   *  takes over the pending verifications; the old tasks were aborted with
   *  the old lifecycle signal). */
  resumePending(): void {
    for (const record of this.deps.leaseManager.snapshot()) {
      if (
        record.state === 'cooling' &&
        record.physicalLockHeld &&
        record.snapshot !== undefined &&
        record.coolingEpoch !== undefined
      ) {
        this.start(record.sessionId, record.snapshot, record.coolingEpoch)
      }
    }
  }

  private async verify(sessionId: string, snapshot: RetiredSessionSnapshot, epoch: number): Promise<void> {
    const signal = this.deps.signal
    try {
      if (signal?.aborted === true) return
      // Authoritative entry check: this task may only act while it is the
      // CURRENT cooling lifecycle (the manager is the epoch source — the
      // verifier never assembles this check itself).
      if (!this.deps.leaseManager.isCoolingCurrent(sessionId, epoch)) return
      // Emergency fallback: never release touched leases.
      if (process.env.DSH_PI_TUI_SESSION_COOLING_RELEASE === '0') {
        this.pinCooling(sessionId, epoch, 'DSH_PI_TUI_SESSION_COOLING_RELEASE=0')
        return
      }
      // The observation window INCLUDES the initial quiet (review
      // round 32 P2: the 5s maximum covers quiet + sampling).
      const deadline = Date.now() + this.params.maxMs
      // Initial quiet window: any in-flight retirement settles. A
      // reactivation may supersede us WHILE we sleep — re-check.
      await sleep(this.params.quietMs, signal)
      if (!this.deps.leaseManager.isCoolingCurrent(sessionId, epoch)) return
      let stable = 0
      let previous: string | undefined
      let samples = 0
      while (Date.now() < deadline) {
        samples += 1
        let current: string
        try {
          const persistence = this.deps.persistence()
          if (persistence?.inspect === undefined) {
            // No reliable durable read: fail-closed.
            return this.pinCooling(sessionId, epoch, 'no persistence inspect for cooling verification')
          }
          // Called as a METHOD on the service object — the coordinator's
          // inspect uses `this` (retirement barrier); a detached call
          // would throw on this.coordinator (e2e round 39 finding).
          const inspection = await persistence.inspect(sessionId, signal)
          // HMR/cleanup abort may have fired while the durable read was in
          // flight (even an inspect that ignores the signal): NEUTRAL
          // return — never release or pin after a lifecycle cancellation.
          if (signal !== undefined && signal.aborted) return
          // The lease may have been reactivated while the durable read
          // was in flight: this task is then stale and must do nothing.
          if (!this.deps.leaseManager.isCoolingCurrent(sessionId, epoch)) return
          // The inspect may have overrun the observation deadline (it is
          // an awaited call, not a bounded sample): a release decision
          // past the deadline must not be made — pin instead (fail-closed).
          if (Date.now() >= deadline) {
            return this.pinCooling(sessionId, epoch, 'retirement did not become durably stable within the cooling window')
          }
          if (snapshot.empty && inspection.events.length > 0) {
            return this.pinCooling(sessionId, epoch, 'empty retired session became materialized during cooling')
          }
          current = snapshot.empty
            ? 'absent'
            : durableParityOf(inspection)
        } catch (error) {
          // HMR/remount abort is a lifecycle cancellation, NOT a
          // retirement failure: neutral return — the new mount's
          // resumePending() continues the SAME cooling epoch.
          if (signal !== undefined && signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          const absent = message === `session "${sessionId}" not found`
          if (snapshot.empty && absent) {
            current = 'absent'
          } else if (!snapshot.empty && absent) {
            return this.pinCooling(sessionId, epoch, 'durable artifact disappeared during cooling')
          } else {
            return this.pinCooling(sessionId, epoch, `persistence verification failed: ${message}`)
          }
        }
        if (!snapshot.empty && current === 'absent') {
          return this.pinCooling(sessionId, epoch, 'durable artifact disappeared during cooling')
        }
        if (snapshot.empty) {
          // Absence IS the stable empty state; any materialization pins.
          if (current !== 'absent') {
            return this.pinCooling(sessionId, epoch, 'empty retired session became materialized during cooling')
          }
        } else if (current !== snapshotParity(snapshot)) {
          // Persistence may still be catching up: reset and keep sampling
          // (a later sample may match the final snapshot).
          stable = 0
          previous = current
          await sleep(this.params.intervalMs, signal)
          if (!this.deps.leaseManager.isCoolingCurrent(sessionId, epoch)) return
          continue
        }
        stable = current === previous ? stable + 1 : 1
        previous = current
        if (stable >= this.params.requiredStable) {
          // Epoch-atomic release: only the CURRENT cooling lifecycle may
          // be released; a stale task gets 'stale' and logs nothing (a
          // no-op verifier must never print a release success).
          const outcome = this.deps.leaseManager.releaseAfterVerifiedCooling(sessionId, epoch)
          if (outcome === 'released') {
            this.deps.diag.info('session lease released after verified cooling', {
              session: sessionId,
              elapsedMs: Date.now() - snapshot.capturedAt,
              samples,
            })
          }
          return
        }
        await sleep(this.params.intervalMs, signal)
        if (this.deps.leaseManager.isCoolingCurrent(sessionId, epoch)) continue
        return
      }
      this.pinCooling(sessionId, epoch, 'retirement did not become durably stable within the cooling window')
    } catch (error) {
      // HMR/remount abort is NEUTRAL (never a PIN): the lifecycle signal
      // abort means the coordinator instance is being replaced, not that
      // the retirement failed. The new mount's resumePending() continues
      // the SAME cooling epoch.
      if (signal !== undefined && signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      this.pinCooling(sessionId, epoch, `unexpected cooling verifier exception: ${message}`)
    }
  }

  private pinCooling(sessionId: string, epoch: number, reason: string): void {
    // Epoch-atomic pin: only the CURRENT cooling lifecycle may be pinned;
    // a stale observer no-ops (it must never PIN a later lifecycle).
    if (this.deps.leaseManager.pinCooling(sessionId, epoch, reason) === 'pinned') {
      this.deps.diag.warn('session lease pinned', { session: sessionId, reason })
    }
  }
}

/** The durable parity triple (event count, last seq, tail fingerprint) —
 *  the cooling verifier requires ALL THREE to match the final snapshot
 *  (review round 32 P1: fingerprint alone could mask a truncated/altered
 *  history that kept the same tail). */
function snapshotParity(snapshot: RetiredSessionSnapshot): string {
  return `${snapshot.eventCount}|${snapshot.lastSeq ?? ''}|${snapshot.tailFingerprint}`
}

function durableParityOf(inspection: { events: readonly FingerprintEventLike[] }): string {
  const events = inspection.events
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : undefined
  return `${events.length}|${lastSeq ?? ''}|${tailFingerprintOf(events)}`
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new Error('cooling verification aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('cooling verification aborted'))
    })
  })
}
