/**
 * The extension ledger: per-slot contribution registries with deterministic
 * ordering and explicit conflict errors (M1). Registration happens BEFORE
 * any surface exists; the SurfaceHost (M2) attaches later and reads the
 * ledger's current snapshot.
 *
 * Rules (plan §5.2–5.3, M1):
 * - `list` slots: deterministic order `order ASC, id ASC`; duplicate
 *   (slot, id) is an ERROR — load order never decides.
 * - `single` slots: lowest `priority` wins; a priority TIE is an ERROR
 *   (never a registration-time guess).
 * - owner: the Cordis fiber name that registered. Owner unload disposes
 *   every registration of that owner (see service.ts).
 * - dispose idempotent; a disposed handle is inert (replace/invalidate
 *   become no-ops); replacement keeps owner/id/lifetime.
 * @module @xmoon76/dsh-pi-tui/extension/ledger
 */

import type {
  ContributionRecord,
  PiTuiSlotName,
  PiTuiSlotSemantic,
  RegistrationHandle,
  RegistrationSpec,
} from '../public-types.ts'
import { isSlotName, slotSemantic } from '../slot-map.ts'
import { ExtensionHealth } from './health.ts'

/** A registration's live bookkeeping. */
interface Registration<T> {
  readonly slot: PiTuiSlotName
  readonly id: string
  readonly order: number
  readonly priority: number
  readonly description: string | undefined
  /** The owning Cordis fiber name (diagnostics + owner-scoped disposal). */
  readonly owner: string
  value: T
  /** Latched by dispose(); a disposed registration is inert. */
  disposed: boolean
}

/** The ledger's observable snapshot of one slot (M2 attaches to this). */
export interface LedgerSlotSnapshot<T> {
  readonly slot: PiTuiSlotName
  readonly semantic: PiTuiSlotSemantic
  /** Ordered contributions; `single` slots carry the winner only. */
  readonly records: readonly ContributionRecord<T>[]
  /** The winning record for `single` slots (undefined for `list`). */
  readonly winner: ContributionRecord<T> | undefined
  /** Monotonic revision; bumped on every structural change. */
  readonly revision: number
}

/**
 * The extension registry core. One ledger instance backs the whole host;
 * slots are isolated registries inside it.
 */
export class ExtensionLedger {
  private readonly registrations = new Map<string, Registration<unknown>>()
  private readonly health = new ExtensionHealth()
  private revision = 0
  /** Batched-invalidation sink, wired by the SurfaceHost in M2. Until then
   * invalidate() just coalesces (batcher without a sink is a no-op flush). */
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /** Whether a (slot, id) pair is already registered. */
  has(slot: string, id: string): boolean {
    return this.registrations.has(registryKey(slot, id))
  }

  /** Register one contribution under a slot. Throws on unknown slots,
   * duplicate (slot, id), and single-slot priority ties. */
  register<T>(
    slot: string,
    spec: RegistrationSpec,
    value: T,
    owner: string,
  ): RegistrationHandle<T> {
    if (!isSlotName(slot)) {
      throw new Error(`unknown extension slot "${slot}" (known: chrome.header.badge, input.dock.item, chrome.footer.status)`)
    }
    const key = registryKey(slot, spec.id)
    if (this.registrations.has(key)) {
      throw new Error(
        `duplicate extension registration: slot "${slot}" id "${spec.id}" ` +
        `(owner "${this.registrations.get(key)?.owner ?? 'unknown'}" already holds it)`,
      )
    }
    const semantic = slotSemantic(slot)
    const registration: Registration<T> = {
      slot,
      id: spec.id,
      order: spec.order ?? 0,
      priority: spec.priority ?? 0,
      description: spec.description,
      owner,
      value,
      disposed: false,
    }
    if (semantic === 'single') {
      // A priority TIE is an explicit error: never guess the winner by
      // registration time (plan §5.3).
      for (const existing of this.registrations.values()) {
        if (existing.slot !== slot || existing.disposed) continue
        if (existing.priority === registration.priority) {
          throw new Error(
            `single-slot priority tie on "${slot}": "${existing.id}" and "${spec.id}" both have priority ${registration.priority} — resolve the conflict before registering`,
          )
        }
      }
    }
    this.registrations.set(key, registration as Registration<unknown>)
    this.health.track(slot, spec.id, owner)
    this.revision += 1
    return this.handleFor(registration)
  }

  /** The ordered records of one slot (list: order ASC, id ASC; single:
   * the winner only — selected by priority ASC per plan §5.3, never by
   * registration time). Snapshot is immutable; read after every change. */
  snapshot<T>(slot: string): LedgerSlotSnapshot<T> {
    if (!isSlotName(slot)) {
      throw new Error(`unknown extension slot "${slot}"`)
    }
    const semantic = slotSemantic(slot)
    const live = [...this.registrations.values()]
      .filter(registration => registration.slot === slot && !registration.disposed)
    // list: order ASC then id ASC (deterministic, load-order independent).
    // single: priority ASC (the winner); a tie is rejected at register time.
    const records = live
      .sort(semantic === 'single'
        ? (left, right) => left.priority - right.priority
        : (left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(registration => contributionRecord(registration) as ContributionRecord<T>)
    let winner: ContributionRecord<T> | undefined
    if (semantic === 'single' && records.length > 0) {
      winner = records[0]
    }
    return {
      slot,
      semantic,
      records: semantic === 'single' && winner !== undefined ? [winner] : records,
      winner,
      revision: this.revision,
    }
  }

  /** Whether any registration exists under a slot. */
  hasAny(slot: string): boolean {
    for (const registration of this.registrations.values()) {
      if (registration.slot === slot && !registration.disposed) return true
    }
    return false
  }

  /** Dispose every registration owned by one fiber name (owner unload). */
  disposeOwner(owner: string): void {
    for (const registration of this.registrations.values()) {
      if (registration.owner === owner && !registration.disposed) {
        this.disposeRegistration(registration)
      }
    }
  }

  /** Dispose every registration (host teardown). */
  disposeAll(): void {
    for (const registration of [...this.registrations.values()]) {
      if (!registration.disposed) this.disposeRegistration(registration)
    }
  }

  /** The health snapshot (M11 /status surface; recorded since M1). */
  healthSnapshot() {
    return this.health.snapshot()
  }

  /** Record a contribution failure (render errors in M2+). */
  recordError(slot: string, id: string, message: string): void {
    this.health.recordError(slot, id, message)
  }

  private handleFor<T>(registration: Registration<T>): RegistrationHandle<T> {
    const ledger = this
    return {
      get id() {
        return registration.id
      },
      invalidate(): void {
        if (registration.disposed) return
        ledger.onInvalidate()
      },
      replace(next: T): void {
        if (registration.disposed) return
        registration.value = next
        ledger.onInvalidate()
      },
      dispose(): void {
        if (registration.disposed) return
        ledger.disposeRegistration(registration)
      },
    }
  }

  private disposeRegistration(registration: Registration<unknown>): void {
    registration.disposed = true
    // Remove from the map so the (slot, id) pair is free again: a disposed
    // registration must not block a fresh registration of the same id
    // (owner unload → reload must be able to re-register).
    this.registrations.delete(registryKey(registration.slot, registration.id))
    this.health.untrack(registration.slot, registration.id)
    this.revision += 1
    this.onInvalidate()
  }
}

/** Immutable record projection of one registration. */
function contributionRecord<T>(registration: Registration<T>): ContributionRecord<T> {
  return {
    slot: registration.slot,
    id: registration.id,
    order: registration.order,
    priority: registration.priority,
    description: registration.description,
    owner: registration.owner,
    value: registration.value,
  }
}

/** Registry key: slot + id. */
function registryKey(slot: string, id: string): string {
  return `${slot}\u0000${id}`
}
