/**
 * The UnstableInputRegistry (Phase 3, plan §5): the Host-owned registry of
 * RAW input captures. Registrations are caller-fiber-owned (the service
 * binds them to the calling fiber); the registry itself is
 * service-lifetime — captures survive surface recreate and are consulted
 * by the CURRENT surface's input path.
 *
 * Routing contract (plan §4/§5/§8):
 * - the registry is consulted by the Host BEFORE terminal protocol
 *   decoding — a capture can see, consume or rewrite ANY raw chunk
 *   (Enter, Esc, Ctrl+C, paste, CSI-u, terminal-specific protocols);
 * - `observe` captures never consume or rewrite; they run first, in
 *   deterministic order;
 * - while an `exclusive` capture is live it is the SOLE capture consumer:
 *   capture-mode captures are not consulted (observers still run). A
 *   second exclusive registration is an explicit error — never a
 *   load-order winner;
 * - ordering is deterministic: priority ASC, then id ASC (the ledger's
 *   rule — load order never decides);
 * - a rewrite replaces the chunk for the Host decoder; the replacement
 *   NEVER re-enters the chain (each terminal chunk passes the chain at
 *   most once — the Host applies the result and continues);
 * - a throwing handler (or `when` gate) is isolated and FAILS OPEN: the
 *   chunk passes through, and the failure is recorded in the extension
 *   health ledger (`unstable.input.raw` slot).
 * @module @xmoon76/dsh-pi-tui/extension/unstable-input
 */

import type {
  UnstableRawInputEvent,
  UnstableRawInputHandle,
  UnstableRawInputResult,
  UnstableRawInputSpec,
} from '../unstable-types.ts'

/** A live capture record. */
interface CaptureRecord {
  readonly id: string
  readonly priority: number
  readonly mode: 'observe' | 'capture' | 'exclusive'
  readonly when: (() => boolean) | undefined
  readonly handle: (event: UnstableRawInputEvent) => UnstableRawInputResult | void
  readonly owner: string
  disposed: boolean
}

/** The registry's observable snapshot (diagnostics + /status). */
export interface UnstableInputRegistrySnapshot {
  readonly captures: readonly {
    readonly id: string
    readonly priority: number
    readonly mode: 'observe' | 'capture' | 'exclusive'
    readonly owner: string
  }[]
  readonly revision: number
}

/** The registry's health hooks (wired by the service to the ledger). */
export interface UnstableInputHealth {
  track(id: string, owner: string): void
  untrack(id: string): void
  recordError(id: string, message: string): void
  clearError(id: string): void
}

/** The raw routing outcome for one chunk. */
export type UnstableRawRouteResult =
  | { readonly action: 'pass' }
  | { readonly action: 'consume' }
  | { readonly action: 'rewrite'; readonly data: string }

/**
 * The raw input capture registry. One instance per service; the runner
 * wires the CURRENT surface's input path to {@link route}.
 */
export class UnstableInputRegistry {
  private readonly records = new Map<string, CaptureRecord>()
  private revision = 0
  private readonly onInvalidate: () => void
  private readonly health: UnstableInputHealth | undefined

  constructor(onInvalidate: () => void = () => {}, health?: UnstableInputHealth) {
    this.onInvalidate = onInvalidate
    this.health = health
  }

  /**
   * Register one raw capture. A duplicate id OR a second live exclusive
   * capture is an explicit error (never a load-order winner).
   * @param spec - the capture spec.
   * @param owner - the Cordis fiber identity (diagnostics + owner unload).
   */
  register(spec: UnstableRawInputSpec, owner: string): UnstableRawInputHandle {
    if (this.records.has(spec.id)) {
      throw new Error(
        `duplicate unstable raw capture id "${spec.id}" (owner "${this.records.get(spec.id)?.owner ?? 'unknown'}" already holds it)`,
      )
    }
    const mode = spec.mode ?? 'capture'
    if (mode === 'exclusive') {
      for (const record of this.records.values()) {
        if (record.disposed) continue
        if (record.mode === 'exclusive') {
          throw new Error(
            `exclusive unstable raw capture conflict: "${record.id}" (owner "${record.owner}") already holds exclusive raw input — resolve the conflict before registering "${spec.id}"`,
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
    this.health?.untrack(record.id)
  }

  /** Dispose every capture owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /** Dispose every capture (host teardown / emergency fail-safe). */
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
  snapshot(): UnstableInputRegistrySnapshot {
    const captures = [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .map(record => ({ id: record.id, priority: record.priority, mode: record.mode, owner: record.owner }))
    return { captures, revision: this.revision }
  }

  /**
   * Consult the captures for one raw chunk. The Host calls this from its
   * input path BEFORE terminal protocol decoding; the returned outcome is
   * applied exactly once (a rewrite goes straight to the Host decoder —
   * it never re-enters this chain).
   * @param event - the raw chunk + the surface generation it arrived on.
   * @returns the routing outcome.
   */
  route(event: UnstableRawInputEvent): UnstableRawRouteResult {
    // Observers run FIRST, in deterministic order; they never consume or
    // rewrite.
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
      return this.invoke(exclusive, event)
    }
    // Capture-mode captures in deterministic order until one decides.
    for (const record of this.ordered()) {
      if (record.mode !== 'capture') continue
      const outcome = this.invoke(record, event)
      if (outcome.action !== 'pass') return outcome
    }
    return { action: 'pass' }
  }

  /** The live records in deterministic order (priority ASC, id ASC). */
  private ordered(): CaptureRecord[] {
    return [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.priority - right.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  /** Invoke one capture's gate + handler with full isolation (fail-open). */
  private invoke(record: CaptureRecord, event: UnstableRawInputEvent): UnstableRawRouteResult {
    try {
      if (record.when !== undefined && record.when() !== true) return { action: 'pass' }
    } catch (error) {
      // A throwing gate is treated as false (the capture is skipped) and
      // recorded — it can never stall the Host input path.
      this.health?.recordError(record.id, safeMessage(error))
      return { action: 'pass' }
    }
    try {
      const outcome = record.handle(event)
      if (outcome === undefined || outcome === null) return { action: 'pass' }
      if (outcome.action === 'consume' || outcome.action === 'rewrite') {
        this.health?.clearError(record.id)
      }
      return outcome
    } catch (error) {
      // Fail-open: a throwing handler never consumes or rewrites; the
      // chunk passes through. Recorded for /status diagnostics.
      this.health?.recordError(record.id, safeMessage(error))
      return { action: 'pass' }
    }
  }
}

/** A bounded, whitespace-collapsed error message (the plan's error policy:
 * no stack traces ever reach diagnostics). */
function safeMessage(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown raw capture error'
  }
}
