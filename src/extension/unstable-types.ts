/**
 * Public UNSTABLE extension contracts for the dsh-pi-tui extension platform.
 *
 * These types are the ONLY surface a third-party plugin may import through
 * `@xmoon76/dsh-pi-tui/extensions/unstable`. Everything here must stay free
 * of private pi-tui types, `TuiApp`, terminal types and repository paths —
 * the packed `.d.mts` leak gate enforces that.
 *
 * Phase-3 scope (plan §1–§15): the first usable Unstable tier — raw input
 * interception (observe/consume/rewrite, exclusive raw ownership), the
 * Host emergency fail-safe, and a selected low-level surface seam. The
 * Unstable tier carries NO compatibility guarantee: implementation may
 * change at any time, and a broken plugin can disrupt Host behavior. The
 * ONLY Host-owned recovery is the emergency fail-safe.
 *
 * Unstable plugins still never import repository-private paths and never
 * mutate Cordis runtime internals; low-level access is exposed through
 * this supported package entry. See docs/extension-unstable.md.
 * @module @xmoon76/dsh-pi-tui/extensions/unstable
 */

import type { TuiOverlayOptions } from './public-types.ts'

/** API level of the unstable tier. Bumped only on unstable breaking changes. */
export const UNSTABLE_API_LEVEL = 1 as const

/**
 * One normalized terminal input sequence (plan §5). The plugin receives
 * the input AFTER the terminal pipeline has reassembled and normalized it
 * — NOT the raw OS byte stream. The Host's input path is:
 *
 * ```text
 * OS stdin
 *   → ProcessTerminal / StdinBuffer (batched chunks split into individual
 *     sequences; bracketed-paste content re-wrapped in its markers)
 *   → keyboard-protocol negotiation (Kitty flags / DA replies filtered)
 *   → native modifier normalization (Windows / Apple Terminal Return →
 *     CSI-u Shift+Enter)
 *   → TUI-owned query replies filtered (OSC11 background, color-scheme
 *     reports, cell-size responses)
 *   → TUI input listeners
 *   → THIS capture (BEFORE Host semantic routing)
 * ```
 *
 * So the sequence is a `preHostInput` event: it can see, consume or
 * rewrite anything the Host router would otherwise decode — Enter, Esc,
 * Ctrl+C, bracketed paste (markers preserved), CSI-u sequences — but it
 * CANNOT see the terminal-negotiation replies the TUI itself consumes
 * (Kitty/DA, OSC11, color-scheme, cell-size), and it never sees raw
 * multi-byte chunks mid-sequence. `surfaceId` identifies the surface
 * generation the sequence arrived on.
 */
export interface UnstableRawInputEvent {
  /** The normalized terminal input sequence (a sequence, not a raw chunk). */
  readonly data: string
  /** The surface generation the sequence arrived on. */
  readonly surfaceId: string
}

/** The outcome of one raw interception (plan §5). */
export type UnstableRawInputResult =
  /** Pass the chunk through unchanged (the Host continues processing). */
  | { readonly action: 'pass' }
  /** Consume the chunk (the Host does nothing further with it). */
  | { readonly action: 'consume' }
  /** Rewrite the chunk: the Host decodes the REPLACEMENT data instead.
   * Each terminal chunk passes the interception chain at most once — the
   * replacement goes straight to the Host decoder, never re-entering the
   * chain (no recursion). */
  | { readonly action: 'rewrite'; readonly data: string }

/** The raw capture modes (plan §5). */
export type UnstableRawCaptureMode = 'observe' | 'capture' | 'exclusive'

/**
 * One raw input capture registration (plan §5/§8). The capture is
 * consulted by the Host BEFORE semantic routing — after the terminal
 * pipeline has reassembled and normalized the input (see
 * {@link UnstableRawInputEvent}): it can see, consume or rewrite any
 * sequence that would otherwise reach the Host router, including Enter,
 * Esc, Ctrl+C, paste and CSI-u sequences. It is NOT consulted before
 * terminal protocol decoding: the TUI's own negotiation replies (Kitty
 * flags, DA, OSC11, color-scheme, cell-size) never reach a capture, and
 * a capture cannot break the terminal negotiation. This is the Unstable
 * contract: a broken capture can still make Host shortcuts stop working.
 * The ONLY Host-owned recovery is the emergency fail-safe (triple-Esc),
 * which the Unstable API cannot rewrite.
 *
 * Modes:
 * - `observe` — never consumes or rewrites; a pure observer.
 * - `capture` — may consume or rewrite.
 * - `exclusive` — the SOLE capture consumer while live: capture-mode
 *   captures are not consulted (observers still run). A second exclusive
 *   registration is an explicit error, never a load-order winner.
 *
 * Ordering is deterministic: `priority` ASC, then `id` ASC. A throwing
 * handler is isolated (health ledger) and FAILS OPEN — the sequence
 * passes through, so a broken capture can never stall the TUI.
 */
export interface UnstableRawInputSpec {
  /** Stable diagnostic identity, unique per owner. */
  readonly id: string
  /** Deterministic ordering: priority ASC, then id ASC. */
  readonly priority?: number
  /** observe | capture | exclusive (default: capture). */
  readonly mode?: UnstableRawCaptureMode
  /** Optional gate: the capture is consulted only while this returns true.
   * A throwing gate is treated as false (the capture is skipped). */
  readonly when?: () => boolean
  /**
   * The raw handler. Return {@link UnstableRawInputResult} to
   * pass/consume/rewrite; return void/undefined to pass. A throwing
   * handler is isolated and fails open.
   */
  handle(event: UnstableRawInputEvent): UnstableRawInputResult | void
}

/** A live handle on one raw input capture. */
export interface UnstableRawInputHandle {
  readonly id: string
  /** Remove the capture. Idempotent; owner unload also disposes it. */
  dispose(): void
}

/**
 * A low-level mounted component (plan §9, option A): the plugin renders RAW
 * lines (no Host sanitization — the Unstable contract) and receives RAW
 * input. The Host owns the physical mount, focus and teardown; the plugin
 * owns the rendering and input semantics.
 */
export interface UnstableMountedComponent {
  /** Render the current state as raw terminal lines at the given width. */
  render(width: number): string[]
  /** Receive one normalized terminal input sequence while this component
   * owns focus (the same preHostInput contract as
   * {@link UnstableRawInputEvent} — never raw OS bytes). */
  handleInput?(raw: string): void
  /** The component was disposed (mount closed / surface died). */
  dispose?(): void
}

/**
 * A live lease on one low-level mount (plan §9/§10). The lease is
 * caller-fiber-owned: owner unload closes the mount; a stale lease
 * (surface disposed) is inert.
 */
export interface UnstableMountLease {
  /** The lease identity (stable diagnostic id). */
  readonly id: string
  /** Whether the mount is still live (false after close/dispose). */
  readonly active: boolean
  /** Whether the mount currently owns keyboard focus. */
  readonly focused: boolean
  /** Request focus for the mount (also shows it if hidden). */
  focus(): void
  /** Release focus. */
  blur(): void
  /** Request a repaint of the mount. */
  invalidate(): void
  /** Close the mount (idempotent; the surface's dispose also closes it). */
  close(): void
  /** Temporarily hide (the lease stays live). */
  hide(): void
  /** Show again after hide(). */
  show(): void
}

/**
 * The low-level surface handle (plan §10): a SELECTED set of Host surface
 * capabilities for low-level plugins. It NEVER exposes `TuiApp`,
 * `TuiMainScreen`, `TuiAltScreen` or the terminal object — only the
 * capabilities a low-level plugin genuinely needs. A stale handle
 * (surface disposed) is inert.
 */
export interface UnstableSurfaceHandle {
  /** The attached surface generation's id. */
  readonly surfaceId: string
  /** The surface generation (stable across start/stop/fullscreen). */
  readonly generation: number
  /** The current terminal width in cells. */
  readonly width: number
  /** The current terminal height in rows. */
  readonly height: number
  /** Request a repaint of the active screen. */
  requestRender(): void
  /**
   * Mount a low-level component (plan §9 option A) as a capturing overlay.
   * The plugin renders RAW lines and receives RAW input; the Host owns
   * the physical mount, focus, stacking, fullscreen migration and
   * teardown. Caller-fiber-owned lease.
   */
  mountComponent(component: UnstableMountedComponent, options?: TuiOverlayOptions): UnstableMountLease
}

/** The unstable input facade (plan §5). */
export interface UnstableInputFacade {
  /**
   * Register a raw input capture. Caller-fiber-owned: owner unload
   * removes it. A duplicate id or a second exclusive capture is an
   * explicit error.
   */
  captureRaw(spec: UnstableRawInputSpec): UnstableRawInputHandle
}

/** The unstable surface facade (plan §10). */
export interface UnstableSurfaceFacade {
  /** The CURRENT surface's low-level handle (a getter — the handle
   * follows the live surface attachment; inert when no surface is
   * live). */
  readonly handle: UnstableSurfaceHandle
}

/** The full unstable facade (plan §4: `unstable(service)`). */
export interface UnstableFacade {
  /** Raw input interception. */
  readonly input: UnstableInputFacade
  /** The low-level surface seam. */
  readonly surface: UnstableSurfaceFacade
}

/**
 * The minimal service surface the unstable facade consumes (plan §4:
 * `unstable(service)`). STRUCTURAL and defined here so the packed
 * unstable declarations never reference the internal service module —
 * the concrete `piTuiExtensions` service implements these members, but
 * the public `PiTuiExtensionService` interface does not declare them.
 *
 * `api` is the structural anchor: a plain `PiTuiExtensionService` value
 * satisfies the facade's parameter (the seam members are optional in the
 * type), and the facade throws loudly when the host does not implement
 * the seam (a host/plugin version mismatch).
 */
export interface UnstableServiceHost {
  /** The public api() surface (the structural anchor — the facade does
   * not consume it; it makes a plain `PiTuiExtensionService` value
   * assignable to the parameter). */
  readonly api: () => import('./public-types.ts').PiTuiApiInfo
  /** The service's internal unstable seam: register a raw input capture
   * (caller-fiber-owned). */
  _unstableCaptureRaw?(spec: UnstableRawInputSpec): UnstableRawInputHandle
  /** The service's internal unstable seam: the current surface's
   * low-level handle (inert when stale). */
  _unstableSurfaceHandle?(): UnstableSurfaceHandle
}
