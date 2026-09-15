/**
 * The run-local sessionless `/model` default-intent state machine (D2.3).
 *
 * The TUI records the newest explicit global-default choice as a Client-local
 * intent so the footer can show it and a fresh create can coordinate with it.
 * An optimistic intent is NOT a committed save: the intent is optimistic for
 * DISPLAY only, and the semantic settlement still awaits the Host write.
 *
 * The record is the SETTLE AUTHORITY: an older operation settling after a newer
 * one must never clear or restore the newer pending intent, and a failed newer
 * operation walks the operation ancestry back NEWEST-first to the nearest
 * non-failed ancestor: a still-PENDING ancestor restores settle authority, an
 * UNRESOLVED ancestor keeps its explicit indeterminate state for a later Host
 * read (v2 §0.3.2), and a committed ancestor means the persisted default
 * carries the choice. A failed ancestor is walked back for PRESENTATION only —
 * v2 §0.8.4 forbids seeding a failed choice into create.
 *
 * Pure and Host-free: the selection is the structural `ModelSelectionValue`
 * (or any caller-supplied selection type), never a DSH Host type.
 * @module @xmoon76/dsh-pi-tui/default-intent
 */

import type { ModelSelectionValue } from './model-selection.ts'

/** One default-intent operation (the settle-authority record the command
 *  surface reads to settle a specific operation). */
export interface DefaultIntentRecord<TSelection = ModelSelectionValue> {
  readonly id: number
  readonly selection: TSelection
}

interface Operation<TSelection> extends DefaultIntentRecord<TSelection> {
  readonly previous: Operation<TSelection> | undefined
  status: 'pending' | 'committed' | 'failed' | 'unresolved'
}

/** The newest settle result:
 *  - 'committed': the persisted default carries the choice;
 *  - 'failed': the UI walks back (the failed choice is NEVER seeded into a
 *    create, v2 §0.8.4);
 *  - 'unresolved': the write was dispatched but the durable result is not
 *    provable — keep an explicit unresolved state until a Host read/reconnect
 *    establishes truth (v2 §0.3.2/§0.8.1);
 *  - undefined while an operation is still pending. */
export type DefaultIntentOutcome = 'committed' | 'failed' | 'unresolved' | undefined

/** The default-intent state machine (generic over the caller's selection type;
 *  defaults to the structural `ModelSelectionValue`). */
export class DefaultIntentTracker<TSelection = ModelSelectionValue> {
  private nextId = 0
  private active: Operation<TSelection> | undefined
  private settledOutcome: DefaultIntentOutcome

  /** Record a NEW operation (fresh ownership id + ancestry link). Undefined
   *  clears the intent without allocating an operation. */
  set(next: TSelection | undefined): void {
    if (next === undefined) {
      this.active = undefined
    } else {
      this.nextId += 1
      this.active = { id: this.nextId, selection: next, previous: this.active, status: 'pending' }
    }
    this.settledOutcome = undefined
  }

  /** Report one operation's outcome. The machine decides whether the intent
   *  clears (committed), keeps an explicit unresolved operation active for a
   *  later Host reconciliation (unresolved), walks the ancestry back to the
   *  nearest still-pending ancestor (failed), or stays with a newer operation. */
  settle(id: number, outcome: 'committed' | 'failed' | 'unresolved'): void {
    let op: Operation<TSelection> | undefined = this.active
    while (op !== undefined && op.id !== id) op = op.previous
    if (op === undefined) return
    op.status = outcome
    if (op !== this.active) return // a newer operation owns the intent
    if (outcome === 'committed') {
      this.active = undefined
      this.settledOutcome = 'committed'
      return
    }
    if (outcome === 'unresolved') {
      // Keep the operation active so the UI can show an EXPLICIT unresolved
      // state until a Host read/reconnect establishes truth (v2 §0.3.2). It is
      // never treated as a failed choice, and it is never seeded into create.
      this.settledOutcome = 'unresolved'
      return
    }
    // Walk the ancestry NEWEST-first: the nearest ancestor that is not itself
    // failed decides. `pending` restores settle authority; `unresolved` keeps
    // the explicit unresolved state (v2 §0.3.2/§0.8.1 — a newer failure must
    // never erase an indeterminate intent that still needs a Host read); a
    // nearer `committed` means the persisted default already carries the choice.
    let cursor = op.previous
    while (cursor !== undefined) {
      if (cursor.status === 'committed') {
        this.active = undefined
        this.settledOutcome = 'committed'
        return
      }
      if (cursor.status === 'unresolved') {
        this.active = cursor
        this.settledOutcome = 'unresolved'
        return
      }
      if (cursor.status === 'pending') {
        this.active = cursor
        this.settledOutcome = undefined
        return
      }
      cursor = cursor.previous
    }
    this.active = undefined
    this.settledOutcome = 'failed'
  }

  /** The active intent (latest PENDING or an UNRESOLVED operation awaiting a
   *  Host read), or undefined. */
  get intent(): TSelection | undefined {
    return this.active?.selection
  }

  /** The active operation record (id + selection), or undefined. */
  get record(): DefaultIntentRecord<TSelection> | undefined {
    return this.active
  }

  /** The newest settle result. */
  get outcome(): DefaultIntentOutcome {
    return this.settledOutcome
  }
}
