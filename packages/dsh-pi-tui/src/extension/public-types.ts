/**
 * Public extension contracts for the dsh-pi-tui extension platform.
 *
 * These types are the ONLY surface a third-party plugin may import (through
 * `@xmoon76/dsh-pi-tui/extensions`). Everything here must stay free of
 * private pi-tui types, `TuiApp`, terminal types, and repository paths — the
 * packed `.d.mts` leak gate enforces that.
 *
 * M1–M2 scope: registry primitives plus the first chrome slots and the
 * immutable surface/session/activity snapshots. Contributions are plain
 * data (rendered by the host); plugins never touch components, terminals,
 * or the TuiApp.
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

// ── M2: snapshots (immutable, deeply readonly) ─────────────────────────────

/** The live surface's geometry and mode (plan §7.1). */
export interface SurfaceSnapshot {
  readonly surfaceId: string
  /** The surface generation; stable across start/stop/fullscreen/editor
   * round-trips, bumped only by a final dispose (M0 contract). */
  readonly generation: number
  readonly width: number
  readonly height: number
  readonly fullscreen: boolean
  /** Which seat currently owns keyboard focus. */
  readonly focusedSeat: 'editor' | 'overlay' | 'editor-panel' | 'none'
  readonly themeId: string
  readonly themeRevision: number
}

/** The live session's identity and mode (plan §7.2). Secrets, credentials,
 * raw Context and live Agent objects are NEVER included. */
export interface SessionSnapshot {
  readonly sessionId?: string
  readonly title?: string
  readonly workspaceRoot: string
  readonly cwd: string
  readonly branch?: string
  readonly model?: string
  readonly permission?: string
  readonly planMode: boolean
  readonly busy: boolean
  readonly viewerMode: boolean
  /** Completed turns and steps (footer t/s counters). */
  readonly turns: number
  readonly steps: number
}

/** Background activity counts (plan §7.3). */
export interface ActivitySnapshot {
  readonly working: boolean
  readonly workingMessage?: string
  readonly queuedCount: number
  readonly taskCount: number
  readonly childAgentCount: number
  readonly todoCount: number
}

/** The store's three named slices (state subscriptions deliver these). */
export interface SurfaceStateValues {
  readonly surface: SurfaceSnapshot
  readonly session: SessionSnapshot
  readonly activity: ActivitySnapshot
}

// ── M2: the first chrome slots' contribution contracts ─────────────────────

/** A header badge: short text with a semantic tone (plan §8.1). */
export interface HeaderBadge {
  readonly text: string
  readonly tone?: 'info' | 'warning' | 'error' | 'success'
}

/** One dock item: a label with optional detail lines (plan §8.2). */
export interface DockItem {
  readonly label: readonly StyledSpan[]
  readonly detail?: readonly StyledSpan[]
  readonly importance?: number
}

/** One footer segment: styled spans with layout hints (plan §8.3). */
export interface FooterSegment {
  readonly spans: readonly StyledSpan[]
  readonly minWidth?: number
  readonly importance?: number
}

/** One styled run of text. The host owns ANSI compilation; plugins supply
 * semantic tokens only (no raw escapes, ever). */
export interface StyledSpan {
  readonly text: string
  readonly tone?: 'primary' | 'accent' | 'text' | 'textStrong' | 'textDim' | 'textMuted'
    | 'border' | 'success' | 'warning' | 'error' | 'roleUser' | 'shellMode'
  readonly emphasis?: 'normal' | 'strong' | 'dim' | 'italic'
}
