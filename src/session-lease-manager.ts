/**
 * Process-global session lease manager: the OWNERSHIP POLICY layer.
 *
 * `OpenLockHolder` stays the low-level collection of physical lock handles;
 * this manager owns the business state machine that decides when a physical
 * lock may be taken, kept, or released. The lifecycle follows the rewind
 * convergence plan (temp/rewind_ref.md):
 *
 * ```text
 * UNOWNED → reserve → RESERVED
 *   ├─ preflight failure → releaseUntouched → UNOWNED
 *   └─ markTouched (before the DSH boundary) → TOUCHED
 *        ├─ create/resume success → ACTIVE
 *        └─ ambiguous/failure → PINNED
 * ACTIVE → switch away → beginCooling → COOLING
 *   ├─ verified stable (cooling coordinator) → releaseAfterVerifiedCooling → RELEASED
 *   └─ uncertainty / timeout / mismatch → PINNED
 * RELEASED → must reacquire the physical lock (requiresReacquire)
 * PINNED → this process keeps the lock for its lifetime; never released
 *          cross-process
 * ```
 *
 * Core invariants (the review first line of defense):
 *
 * - A session that crossed the DSH boundary (`markTouched`) can NEVER be
 *   released by a business failure path: `releaseUntouched` throws on a
 *   touched lease; only `releaseAfterVerifiedCooling` (or the process's
 *   own lifetime for PINNED) may release it.
 * - A RELEASED lease must be RE-ACQUIRED physically before it can become
 *   active again (another process may own it now).
 * - The manager is process-global (mounted on `globalThis` under a
 *   Symbol.for key): an HMR/plugin remount reuses the same lease records,
 *   so this process never forgets the owner.lock files it physically
 *   holds.
 * @module @xmoon76/dsh-pi-tui/session-lease-manager
 */

import { readFileSync } from 'node:fs'
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
  snapshot?: RetiredSessionSnapshot
  coolingStartedAt?: number
  releasedAt?: number
  pinReason?: string
}

/** The physical-lock surface the manager drives (the index.ts closure owns
 *  the persistence/fs/proc wiring). */
export interface LeasePhysicalDeps {
  acquire(target: { id: string; header?: { cwd?: string } }): OpenLockResult
  release(sessionId: string): void
}

/** The process-global lease registry (HMR-safe, Symbol.for key). */
export interface GlobalLeaseRegistry {
  processIdentity: {
    pid: number
    startedAt: number
  }
  manager: ProcessSessionLeaseManager
  refCount: number
}

const LEASE_MANAGER_SYMBOL: symbol = Symbol.for(
  '@xmoon76/dsh-pi-tui/process-session-lease-manager',
)

/** The process start timestamp the registry identity binds to (pid-reuse
 *  guard across a process restart within the same OS pid). */
function processStartedAt(): number {
  const stat = readFileSync('/proc/self/stat', 'utf8')
  // Field 22 (starttime in ticks) after the comm field in parentheses.
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(after[19])
}

/** The per-process session lease manager (one instance per OS process). */
export class ProcessSessionLeaseManager {
  private readonly leases = new Map<string, SessionLeaseRecord>()
  private readonly deps: LeasePhysicalDeps

  constructor(deps: LeasePhysicalDeps) {
    this.deps = deps
  }

  /** Reserve a target's lease: acquire the physical lock when this process
   * does not already hold it. Idempotent for held leases (RESERVED /
   * TOUCHED / ACTIVE / COOLING / PINNED). A RELEASED lease MUST re-acquire
   * (another process may own the session now). */
  reserve(target: { id: string; header?: { cwd?: string } }): OpenLockResult {
    const existing = this.leases.get(target.id)
    if (existing !== undefined && existing.physicalLockHeld) {
      return { kind: 'acquired' }
    }
    const result = this.deps.acquire(target)
    if (result.kind === 'acquired') {
      this.leases.set(target.id, {
        sessionId: target.id,
        state: 'reserved',
        physicalLockHeld: true,
        touchedByDsh: false,
      })
    }
    return result
  }

  /** The target is about to enter the DSH boundary (agents.create/resume).
   * From here on NO business path may release this lease. */
  markTouched(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    lease.touchedByDsh = true
    if (lease.state === 'reserved') lease.state = 'touched'
  }

  /** The committed session is now the live surface. */
  markActive(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    lease.state = 'active'
  }

  /** The session was switched away: it enters COOLING with the final
   *  pre-switch snapshot; the cooling coordinator verifies before any
   *  release. */
  beginCooling(sessionId: string, snapshot: RetiredSessionSnapshot): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    lease.state = 'cooling'
    lease.snapshot = snapshot
    lease.coolingStartedAt = Date.now()
  }

  /** Release a lease that NEVER crossed the DSH boundary. HARD assertion:
   *  releasing a touched lease is a bug — only the verified cooling path
   *  may release a touched session. */
  releaseUntouched(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    if (lease.touchedByDsh) {
      throw new Error(
        'BUG: attempted to release a session lease after the DSH boundary',
      )
    }
    lease.physicalLockHeld = false
    this.deps.release(sessionId)
    this.leases.delete(sessionId)
  }

  /** Release a lease whose cooling verification succeeded: physical lock
   *  released, record kept as a RELEASED tombstone (mandatory re-acquire).
   *  Only a COOLING lease may be released here — a PINNED lease stays
   *  (fail-closed), a RELEASED one is an idempotent no-op, and any other
   *  state is a verifier misuse and throws. */
  releaseAfterVerifiedCooling(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    if (lease.state === 'pinned') return
    if (lease.state === 'released') return
    if (lease.state !== 'cooling') {
      throw new Error(
        `BUG: verified-cooling release for a non-cooling lease (${lease.state})`,
      )
    }
    lease.state = 'released'
    lease.physicalLockHeld = false
    lease.releasedAt = Date.now()
    this.deps.release(sessionId)
  }

  /** Fail-closed: a touched/cooling/active/pinned session keeps its
   *  physical lock for this process's lifetime. */
  pin(sessionId: string, reason: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) {
      this.leases.set(sessionId, {
        sessionId,
        state: 'pinned',
        physicalLockHeld: false,
        touchedByDsh: false,
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

  /** Release every physical lock (EXIT path only — never a touched lease
   *  business release; the exit path deliberately keeps touched locks so
   *  the stale-takeover mechanism protects the session after exit). */
  releaseAllPhysical(): void {
    for (const lease of this.leases.values()) {
      if (lease.physicalLockHeld) {
        lease.physicalLockHeld = false
        this.deps.release(lease.sessionId)
      }
    }
    this.leases.clear()
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
  if (existing !== undefined
    && existing.processIdentity.pid === process.pid
    && existing.processIdentity.startedAt === processStartedAt()) {
    existing.refCount += 1
    return {
      manager: existing.manager,
      release: () => { existing.refCount -= 1 },
    }
  }
  const manager = new ProcessSessionLeaseManager(deps)
  g[LEASE_MANAGER_SYMBOL] = {
    processIdentity: { pid: process.pid, startedAt: processStartedAt() },
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
