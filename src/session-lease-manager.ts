/**
 * Process-global session lease manager: the OWNERSHIP POLICY layer.
 *
 * `OpenLockHolder` stays the low-level collection of physical lock handles;
 * this manager owns the business state machine that decides when a physical
 * lock may be taken, kept, or released. The lifecycle follows the rewind
 * convergence plan (temp/rewind_ref.md):
 *
 * ```text
 * UNOWNED → reserve / reserveForActivation → RESERVED (lifecycleEpoch=1)
 *   ├─ preflight failure → releaseUntouched → UNOWNED
 *   └─ markTouched (before the DSH boundary) → TOUCHED
 *        ├─ create/resume success → ACTIVE
 *        └─ ambiguous/failure → PINNED
 * ACTIVE → switch away → beginCooling → COOLING(epoch=N)
 *   ├─ verified stable (cooling coordinator) → releaseAfterVerifiedCooling → RELEASED
 *   ├─ uncertainty / timeout / mismatch → PINNED
 *   └─ same-process reactivation (reserveForActivation) → RESERVED(epoch=N+1)
 * RELEASED → must RE-ACQUIRE the physical lock (requiresReacquire)
 * PINNED → STICKY QUARANTINE: this process could not prove the session
 *          has no hidden writer (failed dispose / detach gate / resume /
 *          unsettled cooling). The lock stays with this process for its
 *          LIFETIME; reserveForActivation REFUSES it (a new resume does
 *          not clear the uncertainty); only process exit — and the next
 *          opener's stale takeover — ends the quarantine.
 * ```
 *
 * **Lifecycle epochs (the reactivation rule).** Every lease carries a
 * monotonically increasing `lifecycleEpoch`; every operation that abandons
 * prior async lifecycle work bumps it (`beginCooling`, same-process
 * reactivation, re-acquire of a released lease). A cooling retirement is
 * bound to the epoch it started with (`coolingEpoch`), and the cooling
 * verifier may only RELEASE or PIN the lease when `state === 'cooling'`
 * AND `coolingEpoch === epoch` at that instant. Any verifier whose epoch
 * is no longer current can only observe a STALE result — it can never
 * release or pin a later lifecycle (the ABA hazard: cooling #1 →
 * reactivate → ACTIVE → cooling #2 must be immune to the old verifier
 * #1 waking up late).
 *
 * Core invariants (the review first line of defense):
 *
 * - A session that crossed the DSH boundary (`markTouched`) can NEVER be
 *   released by a business failure path: `releaseUntouched` throws on a
 *   touched lease; only `releaseAfterVerifiedCooling` (with the CURRENT
 *   cooling epoch) or the process's own lifetime for PINNED may release
 *   it.
 * - PINNED is a process-lifetime quarantine, NOT a cooling state: it
 *   means this process could not prove the session has no hidden writer
 *   (a failed dispose, a failed detach gate, a failed resume/create, an
 *   unsettled cooling). A same-process re-open must be REFUSED — a new
 *   resume does not clear the uncertainty, and a later normal cooling
 *   release would hand the lock to another process while the hidden
 *   lifecycle could still write (the cross-process writer window).
 * - A RELEASED lease must be RE-ACQUIRED physically before it can become
 *   active again (another process may own it now).
 * - The manager is process-global (mounted on `globalThis` under a
 *   Symbol.for key): an HMR/plugin remount reuses the same lease records,
 *   so this process never forgets the owner.lock files it physically
 *   holds.
 * @module @xmoon76/dsh-pi-tui/session-lease-manager
 */

import type { OpenLockResult } from './transition.ts'

/** One lease's business state. */
export type SessionLeaseState =
  | 'reserved'
  | 'touched'
  | 'active'
  | 'cooling'
  | 'released'
  | 'pinned'

/** The final pre-switch snapshot of a retiring session (captured AFTER the
 * old agent's `whenIdle` + final flush — the cooling verifier compares the
 * durable state against this). */
export interface RetiredSessionSnapshot {
  sessionId: string
  eventCount: number
  lastSeq?: number
  tailFingerprint: string
  empty: boolean
  capturedAt: number
}

/** One session's lease record (kept as a RELEASED tombstone after release). */
export interface SessionLeaseRecord {
  sessionId: string
  state: SessionLeaseState
  physicalLockHeld: boolean
  touchedByDsh: boolean
  /** Monotonic ownership-lifecycle version. ANY operation that abandons
   * prior async lifecycle work bumps it (beginCooling, reactivation,
   * re-acquire of a released lease); a cooling verifier is bound to the
   * epoch it started with and can never affect a later lifecycle. */
  lifecycleEpoch: number
  /** The lifecycle epoch of the CURRENT cooling retirement (set by
   *  beginCooling; cleared by reactivation / verified release). */
  coolingEpoch?: number
  snapshot?: RetiredSessionSnapshot
  coolingStartedAt?: number
  releasedAt?: number
  pinReason?: string
  /** The per-lease physical release binding (captured at acquire time; a
   * remount that swaps the deps must not release through a stale holder). */
  release?: () => void
}

/** The physical-lock surface the manager drives (the `index.ts` closure
 *  owns the persistence/fs/proc wiring). `acquire` returns the settled
 *  result PLUS the per-lease release binding (MANDATORY): the binding is
 *  captured at acquire time so a HMR/remount that swaps the physical deps
 *  can never release a lease through a stale holder (review rounds
 *  34/36). */
export interface LeasePhysicalDeps {
  acquire(target: { id: string; header?: { cwd?: string } }): {
    result: OpenLockResult
    /** The per-lease release binding (no-op for a non-acquired result). */
    release: () => void
  }
}

/** The physical target a reservation applies to. */
export type PhysicalTarget = { id: string; header?: { cwd?: string } }

/** The process-global lease registry (HMR-safe, Symbol.for key). The
 *  registry lives on `globalThis`, which is ALREADY per-OS-process — a
 *  fresh process can never inherit the previous process's registry, so
 *  the pid is only a defensive check and no platform-specific process
 *  identity file is read (a Linux-only identity broke macOS mounts). */
export interface GlobalLeaseRegistry {
  pid: number
  manager: ProcessSessionLeaseManager
  refCount: number
}

const LEASE_MANAGER_SYMBOL: symbol = Symbol.for(
  '@xmoon76/dsh-pi-tui/process-session-lease-manager',
)

/** The per-process session lease manager (one instance per OS process). */
export class ProcessSessionLeaseManager {
  private readonly leases = new Map<string, SessionLeaseRecord>()
  private deps: LeasePhysicalDeps

  constructor(deps: LeasePhysicalDeps) {
    this.deps = deps
  }

  /** PHYSICAL-LAYER reserve: acquire the target's lock when this process
   * does not already hold it; idempotent for held RESERVED / TOUCHED /
   * ACTIVE leases. NOT an activation API — activating a session must go
   * through {@link reserveForActivation} (which invalidates the previous
   * lifecycle epoch). Calling this on a held COOLING / PINNED lease is a
   * misuse and THROWS (the old silent `acquired` was the reactivation
   * P1: the session stayed COOLING while a new resume ran beside the old
   * verifier). A RELEASED lease MUST re-acquire (another process may own
   * the session now). */
  reserve(target: PhysicalTarget): OpenLockResult {
    const existing = this.leases.get(target.id)
    if (existing !== undefined && existing.physicalLockHeld) {
      if (existing.state === 'cooling' || existing.state === 'pinned') {
        throw new Error(
          `BUG: reserve() on a ${existing.state} lease — use reserveForActivation() to activate it`,
        )
      }
      return { kind: 'acquired' }
    }
    return this.acquirePhysical(target, existing)
  }

  /** LIFECYCLE-layer activation: reserve a session that is about to be
   *  activated (agents.create/resume) — fresh ids AND existing sessions.
   *  This is the ONLY reservation that may precede the DSH boundary on an
   *  existing lease:
   *
   * - held COOLING / ACTIVE / TOUCHED / RESERVED lease: the previous
   *   lifecycle epoch is invalidated SYNCHRONOUSLY (epoch++, cooling
   *   fields cleared, state → RESERVED, untouched) BEFORE any DSH call —
   *   from this instant every older cooling verifier is stale and can
   *   neither release nor pin this lease. The physical lock never leaves
   *   this process.
   * - held PINNED lease: REFUSED. PINNED is a process-lifetime
   *   quarantine, not a cooling state: it means this process could NOT
   *   prove the session has no hidden writer (a failed dispose, a failed
   *   detach gate, a failed resume/create, an unsettled cooling). A new
   *   resume does NOT clear that uncertainty — the hidden lifecycle may
   *   still be alive inside this process and could write the session
   *   after a later normal cooling released the lock (the cross-process
   *   writer window). Only process exit (and the next opener's stale
   *   takeover) may end the quarantine.
   * - lockless PINNED record (pin() without a held lease): REFUSED by
   *   acquirePhysical for the SAME reason — re-acquiring the physical
   *   lock does not clear the quarantine, so the record is never demoted.
   * - RELEASED tombstone (physical lock gone): a REAL physical acquire is
   *   required (another process may own the session now); success starts
   *   a new lifecycle on the tombstone.
   * - no record: a fresh physical acquire (lifecycle epoch 1).
   */
  reserveForActivation(target: PhysicalTarget): OpenLockResult {
    const existing = this.leases.get(target.id)
    if (existing !== undefined && existing.physicalLockHeld) {
      if (existing.state === 'pinned') {
        // Sticky quarantine (the reactivation P1): a PINNED lease must
        // never be demoted to a normal lifecycle. The pin reason is kept
        // for diagnostics; the lock stays with this process until exit.
        return {
          kind: 'refused',
          message: `session ${target.id} entered a safety quarantine after an unresolved lifecycle failure; it will remain locked by this TUI until the process exits — restart this TUI before reopening it`,
        }
      }
      // Same-process reactivation (COOLING / ACTIVE / TOUCHED / RESERVED):
      // the previous lifecycle epoch is invalidated synchronously; a new
      // resume establishes a brand-new live lifecycle.
      existing.lifecycleEpoch += 1
      existing.coolingEpoch = undefined
      existing.snapshot = undefined
      existing.coolingStartedAt = undefined
      existing.touchedByDsh = false
      existing.releasedAt = undefined
      existing.pinReason = undefined
      existing.state = 'reserved'
      return { kind: 'acquired' }
    }
    return this.acquirePhysical(target, existing)
  }

  private acquirePhysical(
    target: PhysicalTarget,
    existing: SessionLeaseRecord | undefined,
  ): OpenLockResult {
    if (existing !== undefined && existing.state === 'pinned') {
      // A PINNED lease is a process-lifetime quarantine REGARDLESS of
      // whether the physical lock is still held (a lockless PINNED record
      // exists when pin() ran without a held lease). The pin records "this
      // process cannot prove the session has no hidden writer", and
      // re-acquiring the physical lock does NOT clear that uncertainty —
      // demoting the record here would re-open the cross-process writer
      // window the quarantine exists to close.
      return {
        kind: 'refused',
        message: `session ${target.id} entered a safety quarantine after an unresolved lifecycle failure; it will remain locked by this TUI until the process exits — restart this TUI before reopening it`,
      }
    }
    const { result, release } = this.deps.acquire(target)
    if (result.kind === 'acquired') {
      if (existing !== undefined) {
        // Only a RELEASED tombstone reaches this branch (the lockless
        // PINNED case is refused above): re-activate with a NEW lifecycle
        // epoch, keeping the record.
        existing.lifecycleEpoch += 1
        existing.coolingEpoch = undefined
        existing.snapshot = undefined
        existing.coolingStartedAt = undefined
        existing.touchedByDsh = false
        existing.releasedAt = undefined
        existing.pinReason = undefined
        existing.state = 'reserved'
        existing.physicalLockHeld = true
        existing.release = release
      } else {
        this.leases.set(target.id, {
          sessionId: target.id,
          state: 'reserved',
          physicalLockHeld: true,
          touchedByDsh: false,
          lifecycleEpoch: 1,
          release,
        })
      }
    }
    return result
  }

  /** HMR/remount: swap the physical deps so NEW acquires route through the
   * current mount's closures, while per-lease release bindings stay with
   * their original holder (review round 34). */
  updatePhysicalDeps(deps: LeasePhysicalDeps): void {
    this.deps = deps
  }

  /** The target is about to enter the DSH boundary (agents.create/resume).
   * From here on NO business path may release this lease. */
  markTouched(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    lease.touchedByDsh = true
    if (lease.state === 'reserved') lease.state = 'touched'
  }

  /** The committed session is now the live surface. A PINNED lease can
   *  NEVER become active: the quarantine is process-lifetime (a new resume
   *  does not clear the unresolved-lifecycle uncertainty), so reaching
   *  this state is a state-machine violation and throws. */
  markActive(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    if (lease.state === 'pinned') {
      throw new Error('BUG: a pinned session cannot become active')
    }
    lease.state = 'active'
  }

  /** The session was switched away: it enters COOLING with the final
   *  pre-switch snapshot; the cooling coordinator verifies before any
   *  release. Returns the NEW lifecycle epoch (the verifier is bound to
   *  it), or undefined when there is nothing to cool (unknown session —
   *  the caller then skips the coordinator). A PINNED lease can NEVER
   *  re-enter cooling: the quarantine is process-lifetime, so attempting
   *  it is a state-machine violation and throws (review round 37 made it
   *  a silent no-op; the sticky-quarantine model makes it a hard
   *  invariant). */
  beginCooling(sessionId: string, snapshot: RetiredSessionSnapshot): number | undefined {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return undefined
    if (lease.state === 'pinned') {
      throw new Error('BUG: a pinned session must never re-enter cooling')
    }
    // A NEW retirement: bump the lifecycle epoch so every verifier of an
    // EARLIER retirement becomes stale (the ABA rule).
    lease.lifecycleEpoch += 1
    const epoch = lease.lifecycleEpoch
    lease.state = 'cooling'
    lease.coolingEpoch = epoch
    lease.snapshot = snapshot
    lease.coolingStartedAt = Date.now()
    return epoch
  }

  /** Release a lease that NEVER crossed the DSH boundary. HARD assertion:
   *  releasing a touched lease is a bug — only the verified cooling path
   *  may release a touched session. A PINNED lease (held OR lockless) is
   *  a process-lifetime quarantine and must NEVER be released either. */
  releaseUntouched(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    if (lease.touchedByDsh) {
      throw new Error(
        'BUG: attempted to release a session lease after the DSH boundary',
      )
    }
    if (lease.state === 'pinned') {
      throw new Error('BUG: a pinned session lease must never be released')
    }
    lease.physicalLockHeld = false
    // Every held lease carries its acquire-time binding (review
    // round 36 P2: no fallback through the mutable deps).
    lease.release!()
    this.leases.delete(sessionId)
  }

  /** Release a lease whose cooling verification succeeded: physical lock
   *  released, record kept as a RELEASED tombstone (mandatory re-acquire).
   *  EPOCH-ATOMIC: the release happens ONLY when the lease is still
   *  COOLING with the verifier's own epoch (a verifier of an earlier
   *  retirement must never release a later lifecycle). Returns:
   *  - 'released' — this verifier's cooling epoch released the lease;
   *  - 'stale' — the lease is no longer this epoch's COOLING (reactivated,
   *    re-cooled with a newer epoch, released, or gone): NO-OP;
   *  - 'pinned' — the lease was pinned by another path: NO-OP. */
  releaseAfterVerifiedCooling(
    sessionId: string,
    epoch: number,
  ): 'released' | 'stale' | 'pinned' {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return 'stale'
    if (lease.state === 'pinned') return 'pinned'
    if (lease.state !== 'cooling' || lease.coolingEpoch !== epoch) {
      // The old code threw on a non-cooling release; the epoch model
      // makes a stale verifier a legitimate arrival (reactivation or a
      // newer retirement superseded it), so the ONLY correct outcome is
      // a silent stale no-op.
      return 'stale'
    }
    lease.state = 'released'
    lease.physicalLockHeld = false
    lease.releasedAt = Date.now()
    lease.coolingEpoch = undefined
    // Every acquire carries its per-lease release binding (round 36).
    lease.release!()
    return 'released'
  }

  /** EPOCH-ATOMIC fail-closed pin used by the COOLING VERIFIER: pins only
   *  when the lease is still COOLING with the verifier's own epoch. A
   *  stale verifier (reactivated / newer retirement) must never PIN a
   *  later lifecycle. Returns 'pinned' on a real pin, 'stale' otherwise. */
  pinCooling(sessionId: string, epoch: number, reason: string): 'pinned' | 'stale' {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return 'stale'
    if (lease.state !== 'cooling' || lease.coolingEpoch !== epoch) {
      return 'stale'
    }
    lease.state = 'pinned'
    lease.pinReason = reason
    return 'pinned'
  }

  /** Whether the cooling verifier for (sessionId, epoch) is still the
   *  CURRENT cooling lifecycle (the lease is COOLING, held, and cooling
   *  with exactly this epoch). The verifier must never assemble this
   *  check itself — the manager is the authoritative epoch source. */
  isCoolingCurrent(sessionId: string, epoch: number): boolean {
    const lease = this.leases.get(sessionId)
    return (
      lease !== undefined &&
      lease.state === 'cooling' &&
      lease.physicalLockHeld &&
      lease.coolingEpoch === epoch
    )
  }

  /** Fail-closed: a touched/cooling/active/pinned session keeps its
   *  physical lock for this process's lifetime. (Business paths only —
   *  DSH create/resume failure, dispose failure, detach gate failure. The
   *  cooling VERIFIER must use {@link pinCooling}, which is epoch-atomic.)
   *  A lockless record is possible when pinning a session that never
   *  acquired (diagnostics only — physicalLockHeld stays false). */
  pin(sessionId: string, reason: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) {
      this.leases.set(sessionId, {
        sessionId,
        state: 'pinned',
        physicalLockHeld: false,
        touchedByDsh: false,
        lifecycleEpoch: 1,
        pinReason: reason,
      })
      return
    }
    lease.state = 'pinned'
    lease.pinReason = reason
  }

  /** Whether this process may reuse a session locally without re-acquiring
   *  (it still holds the physical lock). */
  canReuseLocally(sessionId: string): boolean {
    return this.leases.get(sessionId)?.physicalLockHeld === true
  }

  /** Whether reusing a session requires a fresh physical acquire (a
   *  RELEASED tombstone — another process may own it now). */
  requiresReacquire(sessionId: string): boolean {
    return this.leases.get(sessionId)?.state === 'released'
  }

  /** One lease record (diagnostics / rewind surfaces). */
  state(sessionId: string): SessionLeaseRecord | undefined {
    return this.leases.get(sessionId)
  }

  /** All lease records (diagnostics / tests). */
  snapshot(): readonly SessionLeaseRecord[] {
    return [...this.leases.values()]
  }

}

/** TEST-ONLY: drop the process-global registry (headless suite isolation —
 *  each test file starts with a clean lease world). Never call in product
 *  code. */
export function resetProcessLeaseRegistryForTests(): void {
  const g = globalThis as Record<symbol, GlobalLeaseRegistry | undefined>
  delete g[LEASE_MANAGER_SYMBOL]
}

/** Get (or create) the process-global lease manager; increments the ref
 *  count. HMR/remount reuses the SAME manager so physical locks already
 *  held stay owned by this process. */
export function acquireProcessLeaseManager(
  deps: LeasePhysicalDeps,
): { manager: ProcessSessionLeaseManager; release: () => void } {
  const g = globalThis as Record<symbol, GlobalLeaseRegistry | undefined>
  const existing = g[LEASE_MANAGER_SYMBOL]
  if (existing !== undefined && existing.pid === process.pid) {
    // HMR/remount: NEW acquires must route through the current mount's
    // closures (ctx/persistence/holder); per-lease release bindings stay
    // with their original holder (review round 34).
    existing.manager.updatePhysicalDeps(deps)
    existing.refCount += 1
    return {
      manager: existing.manager,
      release: () => { existing.refCount -= 1 },
    }
  }
  const manager = new ProcessSessionLeaseManager(deps)
  g[LEASE_MANAGER_SYMBOL] = {
    pid: process.pid,
    manager,
    refCount: 1,
  }
  return {
    manager,
    release: () => {
      const current = g[LEASE_MANAGER_SYMBOL]
      if (current !== undefined) current.refCount -= 1
    },
  }
}
