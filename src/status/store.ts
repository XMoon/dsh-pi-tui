/**
 * The StatusStore (plan §12.3): a synchronous, I/O-free projection store
 * holding the current {@link StatusSnapshot}. The runner derives DSH facts
 * and the TuiApp projects its own surface state into the SAME store; the
 * footer composer and the extension snapshot derivations read it.
 *
 * Notify discipline: a section is replaced as a whole, and a patch that
 * leaves every section reference unchanged does not notify — so a
 * same-value refresh never triggers a render storm. The revision counter
 * supports footer/command caches.
 * @module @xmoon76/dsh-pi-tui/status/store
 */

import { emptyStatusSnapshot, type StatusPatch, type StatusSnapshot } from './types.ts'

/** A listener receiving the new snapshot after a change. */
export type StatusListener = (snapshot: StatusSnapshot) => void

/** The synchronous status projection store. */
export class StatusStore {
  private current: StatusSnapshot
  private rev = 0
  private readonly listeners = new Set<StatusListener>()

  constructor(initial: StatusSnapshot = emptyStatusSnapshot()) {
    this.current = initial
  }

  /** The current snapshot (the same object until the next change). */
  snapshot(): StatusSnapshot {
    return this.current
  }

  /** The monotonic revision; bumped on every accepted change. */
  revision(): number {
    return this.rev
  }

  /** Replace the whole snapshot. Notifies only when a section changed
   * (the same section-identity discipline as update — an identical
   * replace is a no-op, never a render storm). */
  replace(next: StatusSnapshot): void {
    let changed = false
    for (const key of Object.keys(next) as (keyof StatusSnapshot)[]) {
      if (this.current[key] !== next[key]) {
        changed = true
        break
      }
    }
    if (changed) this.commit(next)
  }

  /** Merge a section-level patch. Sections keep their identity when the
   * patch does not touch them. */
  update(patch: StatusPatch): void {
    const keys = (Object.keys(patch) as (keyof StatusSnapshot)[])
      .filter(key => patch[key] !== undefined)
    if (keys.length === 0) return
    let changed = false
    for (const key of keys) {
      if (this.current[key] !== patch[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    const next: Record<string, unknown> = { ...this.current }
    for (const key of keys) next[key] = patch[key]
    this.commit(next as unknown as StatusSnapshot)
  }

  /** Subscribe to snapshot changes; returns the disposer. */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private commit(next: StatusSnapshot): void {
    this.current = next
    this.rev += 1
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch {
        // A throwing listener must never break the store or other
        // listeners (the footer/command surfaces are best-effort).
      }
    }
  }
}
