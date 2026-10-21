/**
 * The AdvancedInputRegistry (Phase 2, plan §5): the Host-owned registry of
 * normalized input captures. Registrations are caller-fiber-owned (the
 * service binds them to the calling fiber); the registry itself is
 * service-lifetime — captures survive surface recreate and are consulted
 * by the CURRENT surface's input path.
 *
 * Routing contract (plan §5/§11, Phase-2 decision):
 * - the registry is consulted AFTER the Host's own capturing flows
 *   (questions, approvals, overlays) and reserved lifecycle keys, and
 *   BEFORE the editor and the Stable keybindings — an advanced plugin can
 *   preempt ordinary editor/panel input, but never a Host question,
 *   approval, overlay, or fatal-recovery shortcut (session safety stays
 *   Host-owned);
 * - `observe` captures never consume; they run first, in deterministic
 *   order;
 * - while an `exclusive` capture is live it is the SOLE capture consumer:
 *   capture-mode captures are not consulted (observers still run). A
 *   second exclusive registration is an explicit error — never a
 *   load-order winner;
 * - ordering is deterministic: priority ASC, then id ASC (the ledger's
 *   rule — load order never decides);
 * - a throwing handler (or `when` gate) is isolated and FAILS OPEN: the
 *   event continues down the Host ladder, and the failure is recorded in
 *   the extension health ledger.
 * @module @xmoon76/dsh-pi-tui/extension/advanced-input
 */

import type { AdvancedInputCaptureHandle, AdvancedInputCaptureSpec, AdvancedInputEvent } from '../advanced-types.ts'

/** A live capture record. */
interface CaptureRecord {
  readonly id: string
  readonly priority: number
  readonly mode: 'observe' | 'capture' | 'exclusive'
  readonly when: (() => boolean) | undefined
  readonly handle: (event: AdvancedInputEvent) => boolean | void
  readonly owner: string
  disposed: boolean
}

/** The registry's observable snapshot (diagnostics + /status). */
export interface AdvancedInputRegistrySnapshot {
  readonly captures: readonly {
    readonly id: string
    readonly priority: number
    readonly mode: 'observe' | 'capture' | 'exclusive'
    readonly owner: string
  }[]
  readonly revision: number
}

/** The registry's health hooks (wired by the service to the ledger). */
export interface AdvancedInputHealth {
  track(id: string, owner: string): void
  untrack(id: string, owner: string): void
  recordError(id: string, owner: string, message: string): void
  clearError(id: string, owner: string): void
}

/**
 * The normalized input capture registry. One instance per service; the
 * runner wires the CURRENT surface's input path to {@link route}.
 */
export class AdvancedInputRegistry {
  private readonly records = new Map<string, CaptureRecord>()
  private revision = 0
  private readonly onInvalidate: () => void
  private readonly health: AdvancedInputHealth | undefined

  constructor(onInvalidate: () => void = () => {}, health?: AdvancedInputHealth) {
    this.onInvalidate = onInvalidate
    this.health = health
  }

  /**
   * Register one capture. A duplicate id OR a second live exclusive
   * capture is an explicit error (never a load-order winner).
   * @param spec - the capture spec.
   * @param owner - the Cordis fiber identity (diagnostics + owner unload).
   */
  register(spec: AdvancedInputCaptureSpec, owner: string): AdvancedInputCaptureHandle {
    if (this.records.has(spec.id)) {
      throw new Error(
        `duplicate advanced input capture id "${spec.id}" (owner "${this.records.get(spec.id)?.owner ?? 'unknown'}" already holds it)`,
      )
    }
    const mode = spec.mode ?? 'capture'
    if (mode === 'exclusive') {
      for (const record of this.records.values()) {
        if (record.disposed) continue
        if (record.mode === 'exclusive') {
          throw new Error(
            `exclusive advanced input capture conflict: "${record.id}" (owner "${record.owner}") already holds exclusive input — resolve the conflict before registering "${spec.id}"`,
          )
        }
      }
    }
    const record: CaptureRecord = {
      id: spec.id,
      priority: spec.priority ?? 0,
      mode,
      when: spec.when,
      handle: spec.handle,
      owner,
      disposed: false,
    }
    this.records.set(spec.id, record)
    this.revision += 1
    this.onInvalidate()
    this.health?.track(spec.id, owner)
    return {
      id: spec.id,
      dispose: () => this.disposeRecord(record),
    }
  }

  /** Remove one capture by id (owner unload / explicit dispose). */
  dispose(id: string): void {
    const record = this.records.get(id)
    if (record === undefined) return
    this.disposeRecord(record)
  }

  private disposeRecord(record: CaptureRecord): void {
    if (record.disposed) return
    record.disposed = true
    if (this.records.get(record.id) === record) this.records.delete(record.id)
    this.revision += 1
    this.onInvalidate()
    this.health?.untrack(record.id, record.owner)
  }

  /** Dispose every capture owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /** Dispose every capture (host teardown). */
  disposeAll(): void {
    for (const record of [...this.records.values()]) {
      if (!record.disposed) this.disposeRecord(record)
    }
  }

  /** Whether any capture is live (health /status). */
  hasAny(): boolean {
    for (const record of this.records.values()) {
      if (!record.disposed) return true
    }
    return false
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): AdvancedInputRegistrySnapshot {
    const captures = [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .map(record => ({ id: record.id, priority: record.priority, mode: record.mode, owner: record.owner }))
    return { captures, revision: this.revision }
  }

  /**
   * Consult the captures for one raw input chunk. The Host calls this from
   * its input path AFTER its own capturing flows and reserved lifecycle
   * keys; the registry normalizes the chunk itself (the Host's decoder).
   * @param data - the raw terminal data.
   * @param normalize - the shared normalization (injected so the Host's
   *   own event classification is the single source of truth).
   * @returns 'consumed' when a capture consumed the event, else 'passed'.
   */
  route(data: string, normalize: (data: string) => AdvancedInputEvent | undefined): 'consumed' | 'passed' {
    const event = normalize(data)
    if (event === undefined) return 'passed'
    // Observers run FIRST, in deterministic order; they never consume.
    for (const record of this.ordered()) {
      if (record.mode !== 'observe') continue
      this.invoke(record, event)
    }
    // The exclusive capture (if any) is the SOLE capture consumer.
    let exclusive: CaptureRecord | undefined
    for (const record of this.records.values()) {
      if (record.disposed || record.mode !== 'exclusive') continue
      exclusive = record
      break
    }
    if (exclusive !== undefined) {
      return this.invoke(exclusive, event) ? 'consumed' : 'passed'
    }
    // Capture-mode captures in deterministic order until one consumes.
    for (const record of this.ordered()) {
      if (record.mode !== 'capture') continue
      if (this.invoke(record, event)) return 'consumed'
    }
    return 'passed'
  }

  /** The live records in deterministic order (priority ASC, id ASC). */
  private ordered(): CaptureRecord[] {
    return [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.priority - right.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  /** Invoke one capture's gate + handler with full isolation (fail-open). */
  private invoke(record: CaptureRecord, event: AdvancedInputEvent): boolean {
    try {
      if (record.when !== undefined && record.when() !== true) return false
    } catch (error) {
      // A throwing gate is treated as false (the capture is skipped) and
      // recorded — it can never stall the Host input path.
      this.health?.recordError(record.id, record.owner, safeMessage(error))
      return false
    }
    try {
      const consumed = record.handle(event)
      if (consumed === true) {
        this.health?.clearError(record.id, record.owner)
        return true
      }
      return false
    } catch (error) {
      // Fail-open: a throwing handler never consumes; the event continues
      // down the Host ladder. Recorded for /status diagnostics.
      this.health?.recordError(record.id, record.owner, safeMessage(error))
      return false
    }
  }
}

/** A bounded, whitespace-collapsed error message (the plan's error policy:
 * no stack traces ever reach diagnostics). */
function safeMessage(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown capture error'
  }
}
