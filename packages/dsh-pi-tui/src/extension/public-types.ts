/**
 * Public extension contracts for the dsh-pi-tui extension platform.
 *
 * These types are the ONLY surface a third-party plugin may import (through
 * `@xmoon76/dsh-pi-tui/extensions`). Everything here must stay free of
 * private pi-tui types, `TuiApp`, terminal types, and repository paths — the
 * packed `.d.mts` leak gate enforces that.
 *
 * M1 scope: registry primitives only (no UI integration yet). The slot names
 * below are declared now so the SurfaceHost (M2) can attach to a stable
 * identity, but no contribution can be RENDERED until M2.
 * @module @xmoon76/dsh-pi-tui/extensions
 */

/** API version of the extension surface (bumped only on breaking changes). */
export const API_VERSION = 1 as const

/** Capability identifiers, feature-detected via {@link PiTuiApiInfo}. */
export type PiTuiCapability =
  | 'slot.chrome.header.badge'
  | 'slot.input.dock.item'
  | 'slot.chrome.footer.status'
  | 'surface.snapshot'

/** Slot identities this package knows; unknown names are rejected at registration. */
export type PiTuiSlotName =
  | 'chrome.header.badge'
  | 'input.dock.item'
  | 'chrome.footer.status'

/** Slot semantics: how competing contributions resolve. */
export type PiTuiSlotSemantic = 'list' | 'single'

/** What a plugin may know about the host (M1: version + capabilities only). */
export interface PiTuiApiInfo {
  /** The extension API version; 1 for the M0–M3 foundation. */
  readonly apiVersion: typeof API_VERSION
  /** The `@xmoon76/dsh-pi-tui` package version (semver string). */
  readonly hostVersion: string
  /** Capabilities the host currently supports; feature-detect, never parse the version. */
  readonly capabilities: ReadonlySet<PiTuiCapability>
}

/** Common registration metadata every contribution carries. */
export interface RegistrationSpec {
  /** Stable diagnostic identity, unique per (slot, owner). */
  readonly id: string
  /**
   * Deterministic ordering for `list` slots: `order` ASC, then `id` ASC.
   * Load order NEVER decides conflicts.
   */
  readonly order?: number
  /** Winner selection for `single` slots: lowest `priority` wins. */
  readonly priority?: number
  /** Human-readable description for diagnostics and future /status output. */
  readonly description?: string
}

/** Live control of one registered contribution. */
export interface RegistrationHandle<T> {
  /** The registration id (stable diagnostic identity). */
  readonly id: string
  /**
   * Request a re-render of this contribution. Batched: N invalidates in one
   * tick produce ONE render request on the active screen.
   */
  invalidate(): void
  /**
   * Replace the contribution value in place. The handle keeps its identity:
   * owner, id and lifetime are unchanged by a replacement.
   */
  replace(next: T): void
  /** Remove the contribution. Idempotent; a disposed handle is inert. */
  dispose(): void
}

/** One contribution registered under a slot, with its owner identity. */
export interface ContributionRecord<T> {
  readonly slot: PiTuiSlotName
  readonly id: string
  readonly order: number
  readonly priority: number
  readonly description: string | undefined
  /** The Cordis fiber name that owns this registration (diagnostics). */
  readonly owner: string
  /** The live contribution value. */
  readonly value: T
}

/** Health state of one contribution (future /status extension listing). */
export type ContributionState = 'active' | 'shadowed' | 'failed' | 'disposed'

/** Diagnostic health record for one contribution (M1: recorded, surfaced later). */
export interface ContributionHealth {
  readonly id: string
  readonly owner: string
  readonly extensionPoint: string
  readonly state: ContributionState
  /** The error generation this record was produced under (0 = none yet). */
  readonly errorGeneration?: number
  /** The last error message, when the contribution failed (no stack traces). */
  readonly lastError?: string
}
