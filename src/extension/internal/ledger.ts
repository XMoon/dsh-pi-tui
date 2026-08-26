/**
 * The extension ledger: per-slot contribution registries with deterministic
 * ordering and explicit conflict errors (M1). Registration happens BEFORE
 * any surface exists; the SurfaceHost (M2) attaches later and reads the
 * ledger's current snapshot.
 *
 * Rules (plan §5.2–5.3, M1):
 * - `list` slots: deterministic order `order ASC, id ASC, owner ASC`;
 *   duplicate (slot, OWNER, id) is an ERROR — load order never decides.
 *   The SAME id may register under DIFFERENT owners simultaneously (the
 *   M4 canonical keys `ext:<owner>/<id>` stay distinct — the public
 *   RegistrationSpec contract says id is unique per (slot, owner), and
 *   the ledger enforces exactly that).
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
import { isSlotName, slotNames, slotSemantic } from '../slot-map.ts'
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
  /** Monotonic revision; bumped on every content change (structural: register/dispose; in-place: invalidate/replace). */
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
  /**
   * Invalidation sink, invoked on every content change (register/replace/
   * dispose). The service wires the batcher; the SurfaceHost re-sinks it to
   * "refresh outlets + repaint" when it attaches (F-17 — an invalidation
   * must reach the screen, not just the batcher).
   */
  private onInvalidate: () => void
  /**
   * The CURRENT attachment token owning the sink (P1: generation-scoped
   * isolation). Only the current owner may restore a no-op sink on dispose;
   * a stale old-generation dispose leaves the NEWER host's sink intact.
   * Registrations are NOT tied to attachments: the ledger is the
   * service-lifetime registry (P1-2) — a surface dispose only stops
   * CONSUMING it, never removes still-live caller-owned registrations.
   */
  private attachmentToken: object | undefined
  /**
   * Test-only semantic overrides (P2-2): lets a test declare a slot as
   * `single` even though the shipped slot map is all-`list` today, so the
   * single-winner branch (priority tie error + priority-ASC winner sort)
   * is exercised instead of being dead code. Never used in production.
   */
  private readonly semanticsOverrides: ReadonlyMap<string, 'single'>

  constructor(onInvalidate: () => void = () => {}, semanticsOverrides: ReadonlyMap<string, 'single'> = new Map()) {
    this.onInvalidate = onInvalidate
    this.semanticsOverrides = semanticsOverrides
  }

  /** The semantic of one slot: the test override when present, else the
   * shipped slot map. */
  private semanticOf(slot: string): 'list' | 'single' {
    return this.semanticsOverrides.get(slot) ?? slotSemantic(slot as PiTuiSlotName)
  }

  /** Replace the invalidation sink (the SurfaceHost re-sinks on attach). */
  setInvalidateSink(sink: () => void): void {
    this.onInvalidate = sink
  }

  /**
   * Record the current attachment token that owns the sink (P1). Called by
   * the SurfaceHost's attach AFTER re-sinking, so a later
   * {@link restoreSinkIfCurrent} from a STALE generation is a no-op.
   * Attachments do NOT own registrations: the ledger is the service-
   * lifetime registry (P1-2), so no generation is stamped here anymore.
   * @param token - the attaching host's lease token.
   */
  markAttachment(token: object): void {
    this.attachmentToken = token
  }

  /**
   * Restore a no-op sink, but ONLY when `token` is still the current
   * attachment (P1: the review's attach-A/attach-B/dispose-A repro — the
   * old host's dispose must not disable the NEW host's invalidation).
   * @param token - the disposing host's lease token.
   */
  restoreSinkIfCurrent(token: object): void {
    if (this.attachmentToken !== token) return
    this.attachmentToken = undefined
    this.onInvalidate = () => {}
  }

  /** Whether a (slot, owner, id) registration exists. */
  has(slot: string, owner: string, id: string): boolean {
    return this.registrations.has(registryKey(slot, owner, id))
  }

  /** Register one contribution under a slot. Throws on unknown slots,
   * duplicate (slot, owner, id), and single-slot priority ties. */
  register<T>(
    slot: string,
    spec: RegistrationSpec,
    value: T,
    owner: string,
  ): RegistrationHandle<T> {
    if (!isSlotName(slot)) {
      throw new Error(`unknown extension slot "${slot}" (known: ${slotNames().join(', ')})`)
    }
    const key = registryKey(slot, owner, spec.id)
    if (this.registrations.has(key)) {
      throw new Error(
        `duplicate extension registration: slot "${slot}" id "${spec.id}" ` +
        `(owner "${owner}" already holds it)`,
      )
    }
    const semantic = this.semanticOf(slot)
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
    // A registration is a content change: notify the sink so the surface
    // re-bakes (F-17 — a post-attach register must reach the screen).
    this.onInvalidate()
    return this.handleFor(registration)
  }

  /** The ordered records of one slot (list: order ASC, id ASC; single:
   * the winner only — selected by priority ASC per plan §5.3, never by
   * registration time). Snapshot is immutable; read after every change. */
  snapshot<T>(slot: string): LedgerSlotSnapshot<T> {
    if (!isSlotName(slot)) {
      throw new Error(`unknown extension slot "${slot}"`)
    }
    const semantic = this.semanticOf(slot)
    const live = [...this.registrations.values()]
      .filter(registration => registration.slot === slot && !registration.disposed)
    // list: order ASC then id ASC (deterministic, load-order independent).
    // single: priority ASC (the winner); a tie is rejected at register time.
    const records = live
      .sort(semantic === 'single'
        ? (left, right) => left.priority - right.priority
        : (left, right) => left.order - right.order
          || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
          || (left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0))
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

  /** Track a NON-ledger contribution's health slot (P1-08: renderers and
   * editors live in their own registries, not the ledger — their health
   * must still be observable via /status). Idempotent per (slot, id). */
  trackHealth(slot: string, id: string, owner: string): void {
    this.health.track(slot, id, owner)
  }

  /** Drop a NON-ledger contribution's health record (registry disposal). */
  untrackHealth(slot: string, id: string): void {
    this.health.untrack(slot, id)
  }

  /** Record a contribution failure (render errors in M2+). */
  recordError(slot: string, id: string, message: string): void {
    this.health.recordError(slot, id, message)
  }

  /** Clear a contribution's failure record after a SUCCESSFUL render (P2:
   * a contribution that threw once and then renders fine is active again —
   * the next failure starts a NEW error generation). */
  clearError(slot: string, id: string): void {
    this.health.clearError(slot, id)
  }

  /** Record a callback failure from an external registry. */
  recordExternalError(slot: string, id: string, message: string): void {
    this.health.recordError(slot, id, message)
  }

  /** Clear a recovered callback failure from an external registry. */
  clearExternalError(slot: string, id: string): void {
    this.health.clearError(slot, id)
  }

  private handleFor<T>(registration: Registration<T>): RegistrationHandle<T> {
    const ledger = this
    return {
      get id() {
        return registration.id
      },
      invalidate(): void {
        if (registration.disposed) return
        // An invalidate is a "content changed in place" signal: bump the
        // revision so the outlets re-bake even though the ledger's record
        // is structurally unchanged (round-4 finding 2 — a plugin that
        // mutates its contribution and calls invalidate() must reach the
        // screen).
        ledger.revision += 1
        ledger.onInvalidate()
      },
      replace(next: T): void {
        if (registration.disposed) return
        registration.value = next
        // A replacement IS a content change: bump the revision so the
        // outlets re-bake (F-16 — a replace must reach the screen even
        // when the theme revision is unchanged). `ledger`, not `this`:
        // method shorthand binds `this` to the handle object.
        ledger.revision += 1
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
    // Remove from the map so the (slot, owner, id) triple is free again: a
    // disposed registration must not block a fresh registration of the
    // same id by the SAME owner (owner unload → reload must be able to
    // re-register). A same-id registration under a DIFFERENT owner is a
    // separate key and stays.
    this.registrations.delete(registryKey(registration.slot, registration.owner, registration.id))
    // Drop the health record ONLY when no OTHER live registration shares
    // this (slot, id): with owner-scoped keys a same-id sibling from a
    // different owner must keep its diagnostics (the health ledger is
    // (slot, id)-keyed — diagnostic-only).
    const stillLive = [...this.registrations.values()].some(other =>
      other.slot === registration.slot && other.id === registration.id && !other.disposed)
    if (!stillLive) this.health.untrack(registration.slot, registration.id)
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

/** Registry key: slot + owner + id (owner-scoped — the public contract
 * says an id is unique per (slot, owner), and the M4 canonical config
 * keys embed the owner). */
function registryKey(slot: string, owner: string, id: string): string {
  return `${slot}\u0000${owner}\u0000${id}`
}
