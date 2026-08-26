/**
 * Contribution health records (M1): per-registration lifecycle state and the
 * first error of each failure generation. Records are diagnostic-only — the
 * /status extension listing (M11) will surface them; nothing in M1–M3
 * renders them.
 *
 * Error policy (plan §18): the FIRST error of a failure generation records
 * full diagnostics; repeated errors in the same generation are deduplicated;
 * no stack traces ever reach the footer or the health record.
 * @module @xmoon76/dsh-pi-tui/extension/health
 */

import type { ContributionHealth, ContributionState } from '../public-types.ts'

/** Mutable health bookkeeping; snapshots are immutable records. Records
 * are keyed by (slot, owner, id) — the SAME identity the ledger uses
 * since the owner-scoped change: two plugins may legally share a local
 * id, and their diagnostics must never conflate (the review's P2). */
export class ExtensionHealth {
  private readonly records = new Map<string, ContributionHealth>()
  /** The failure generation counter (bumped on every new error cycle). */
  private generation = 0

  /** Register a contribution's health slot. */
  track(slot: string, id: string, owner: string): void {
    const key = healthKey(slot, owner, id)
    // Tracking is idempotent for the same live contribution. A repeated
    // bridge call must not erase an already-recorded failure or replace the
    // owner metadata with a stale callback.
    if (this.records.has(key)) return
    this.records.set(key, {
      id,
      owner,
      extensionPoint: slot,
      state: 'active',
    })
  }

  /** Transition one contribution's lifecycle state. */
  setState(slot: string, id: string, owner: string, state: ContributionState): void {
    const key = healthKey(slot, owner, id)
    const record = this.records.get(key)
    if (record === undefined) return
    this.records.set(key, { ...record, state })
  }

  /**
   * Record a contribution error. The first error of each failure generation
   * carries the message; repeats are deduplicated (the generation only
   * advances when the contribution recovers and fails again).
   */
  recordError(slot: string, id: string, owner: string, message: string): void {
    const key = healthKey(slot, owner, id)
    const record = this.records.get(key)
    if (record === undefined) return
    if (record.errorGeneration !== undefined && record.state === 'failed') {
      // Same failure cycle: deduplicate (keep the first message).
      return
    }
    this.generation += 1
    this.records.set(key, {
      ...record,
      state: 'failed',
      errorGeneration: this.generation,
      lastError: message,
    })
  }

  /** Mark a contribution recovered (next failure starts a new generation). */
  clearError(slot: string, id: string, owner: string): void {
    const key = healthKey(slot, owner, id)
    const record = this.records.get(key)
    if (record === undefined) return
    const { errorGeneration: _dropped, lastError: _droppedMessage, ...rest } = record
    this.records.set(key, { ...rest, state: 'active' })
  }

  /** Drop a contribution's health record (registration disposed). */
  untrack(slot: string, id: string, owner: string): void {
    this.records.delete(healthKey(slot, owner, id))
  }

  /** Snapshot of every tracked contribution (immutable). */
  snapshot(): readonly ContributionHealth[] {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  /** Reset every record (host restart). */
  clear(): void {
    this.records.clear()
    this.generation = 0
  }
}

/** Registry key: slot + owner + id — the same owner-scoped identity the
 * extension ledger uses (a local id under two owners is two records). */
function healthKey(slot: string, owner: string, id: string): string {
  return `${slot}\u0000${owner}\u0000${id}`
}
