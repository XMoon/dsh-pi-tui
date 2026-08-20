/**
 * Public ADVANCED extension contracts for the dsh-pi-tui extension platform.
 *
 * These types are the ONLY surface a third-party plugin may import through
 * `@xmoon76/dsh-pi-tui/extensions/advanced`. Everything here must stay free
 * of private pi-tui types, `TuiApp`, terminal types and repository paths —
 * the packed `.d.mts` leak gate enforces that.
 *
 * Phase-2 scope (plan §4–§10): the first usable Advanced tier —
 * normalized input capture, focused interactive surfaces (delivered as
 * interactive managed overlays), and advanced editor control. Advanced
 * plugins still never touch raw terminal bytes, private screens, or
 * repository internals; the Host decodes the terminal protocol and owns
 * every physical mount, focus seat and teardown.
 *
 * Advanced is EXPERIMENTAL: minor releases may break; a migration note is
 * required; no long-term shims. See docs/extension-advanced.md.
 * @module @xmoon76/dsh-pi-tui/extensions/advanced
 */

import type { EditorSnapshot, NormalizedKey, TuiOverlayOptions } from './public-types.ts'

/** API level of the advanced tier. Bumped only on advanced breaking changes. */
export const ADVANCED_API_LEVEL = 1 as const

/**
 * A normalized input event — the ONLY input shape an advanced plugin ever
 * sees. The Host has already decoded the terminal protocol (legacy + Kitty
 * CSI-u + modifyOtherKeys encodings, bracketed paste, key release/repeat
 * filtering), so an advanced plugin behaves identically on every terminal.
 */
export type AdvancedInputEvent =
  /** One key press, normalized to the semantic identity. */
  | {
      readonly kind: 'key'
      readonly key: NormalizedKey
    }
  /** One plain printable character run (ordinary typing). */
  | {
      readonly kind: 'text'
      readonly text: string
    }
  /** A paste burst (bracketed-paste or the host's paste heuristic). */
  | {
      readonly kind: 'paste'
      readonly text: string
    }

/** The capture modes of a normalized input capture (plan §5). */
export type AdvancedInputCaptureMode = 'observe' | 'capture' | 'exclusive'

/**
 * One normalized input capture registration (plan §5). The capture is
 * consulted by the Host AFTER its own capturing flows (questions, approvals,
 * overlays) and reserved lifecycle keys, and BEFORE the editor and the
 * Stable keybindings — so an advanced plugin can preempt ordinary editor and
 * panel input, but never a Host question/approval, a Host overlay, or a
 * Host fatal-recovery shortcut (session safety stays Host-owned).
 *
 * Modes:
 * - `observe` — never consumes; the handler is a pure observer.
 * - `capture` — may consume the event (return true).
 * - `exclusive` — the SOLE capture consumer while live: capture-mode
 *   captures are not consulted (observers still run). A second exclusive
 *   registration is an explicit error, never a load-order winner.
 *
 * Ordering is deterministic: `priority` ASC, then `id` ASC. A throwing
 * handler is isolated (health ledger) and FAILS OPEN — the event continues
 * down the Host ladder, so a broken capture can never stall the TUI.
 */
export interface AdvancedInputCaptureSpec {
  /** Stable diagnostic identity, unique per owner. */
  readonly id: string
  /** Deterministic ordering: priority ASC, then id ASC. */
  readonly priority?: number
  /** observe | capture | exclusive (default: capture). */
  readonly mode?: AdvancedInputCaptureMode
  /** Optional gate: the capture is consulted only while this returns true.
   * A throwing gate is treated as false (the capture is skipped). */
  readonly when?: () => boolean
  /**
   * The event handler. Return true to CONSUME the event (the Host does
   * nothing further with it); return false/undefined to pass it on.
   * A throwing handler is isolated and fails open.
   */
  handle(event: AdvancedInputEvent): boolean | void
}

/** A live handle on one normalized input capture. */
export interface AdvancedInputCaptureHandle {
  readonly id: string
  /** Remove the capture. Idempotent; owner unload also disposes it. */
  dispose(): void
}

/**
 * The render context handed to an interactive component's render() (plan
 * §6). The plugin owns its state; the Host compiles the returned
 * ExtensionView and owns layout, ANSI, width/wrapping and error isolation.
 */
export interface AdvancedRenderContext {
  readonly surfaceId: string
  readonly generation: number
  /** The current terminal width in cells (re-read at every compile). */
  readonly width: number
  /** The current terminal height in rows. */
  readonly height: number
  /** Whether this component currently owns keyboard focus. */
  readonly focused: boolean
}

/**
 * A focused interactive component (plan §6): plugin-owned interactive
 * state rendered through the Host's component kit. The Host compiles
 * render() output, normalizes input, leases focus and isolates every
 * callback — the plugin never touches a private component, screen or
 * terminal.
 */
export interface AdvancedInteractiveComponent {
  /** Render the current state as a structured view (Host-compiled). */
  render(ctx: AdvancedRenderContext): import('./public-types.ts').ExtensionView
  /**
   * Receive a normalized input event while this component owns focus.
   * Return true to consume; false/undefined passes the event on (the Host
   * drops it — the focused component owns the seat). A throwing handler
   * is isolated.
   */
  handleInput?(event: AdvancedInputEvent): boolean | void
  /** The component gained keyboard focus. */
  onFocus?(): void
  /** The component lost keyboard focus. */
  onBlur?(): void
  /** The component was disposed (overlay closed / surface died). */
  dispose?(): void
}

/**
 * A Host-owned focus lease (plan §7). In Phase 2 the lease is delivered
 * through the interactive overlay lease (the overlay IS the focused
 * interactive surface); a stale lease (surface disposed, owner unloaded)
 * is inert.
 */
export interface AdvancedFocusHandle {
  /** Whether this lease currently holds focus. */
  readonly active: boolean
  /** Request focus for the leased surface. */
  focus(): void
  /** Release focus. */
  blur(): void
  /** Release the lease (idempotent; owner unload also releases it). */
  dispose(): void
}

/**
 * A live lease on one interactive managed overlay (plan §8). The plugin
 * owns the component's state; the Host owns the physical screen mount,
 * the overlay stack, focus, fullscreen migration and final teardown. The
 * lease is caller-fiber-owned: owner unload closes the overlay, and a
 * stale lease (surface disposed) is inert.
 */
export interface AdvancedOverlayLease {
  /** The lease identity (stable diagnostic id). */
  readonly id: string
  /** Whether the overlay is still mounted (false after close/dispose). */
  readonly active: boolean
  /** Whether the overlay currently owns keyboard focus. */
  readonly focused: boolean
  /** Request focus for the overlay (also shows it if hidden). */
  focus(): void
  /** Release focus. */
  blur(): void
  /** Recompile the component's render() output and repaint. */
  invalidate(): void
  /** Close the overlay (idempotent; the surface's dispose also closes it). */
  close(): void
  /** Temporarily hide (the lease stays live). */
  hide(): void
  /** Show again after hide(). */
  show(): void
}

/**
 * The advanced editor controls (plan §9): direct semantic editor actions
 * through the Host's editor seat. The Host owns submission/session safety
 * (dispatch('submit') stays the explicit action path); these controls only
 * carry text/cursor/focus. A stale controls object (surface disposed) is
 * inert.
 */
export interface AdvancedEditorControls {
  /** The current immutable editor snapshot (text/cursor/focus). */
  getEditorState(): EditorSnapshot
  /** Replace the draft wholesale. */
  setEditorText(text: string): void
  /** Move the cursor to a flat offset within the draft. */
  setEditorCursor(offset: number): void
  /** Insert text at the cursor (or at an explicit offset). */
  insertEditorText(text: string, at?: number): void
  /** Paste text at the cursor (same insertion semantics as
   * insertEditorText at the cursor — the Host owns paste protection). */
  pasteToEditor(text: string): void
  /** Request keyboard focus for the editor seat. */
  requestEditorFocus(): void
}

/** The advanced input facade (plan §5). */
export interface AdvancedInputFacade {
  /**
   * Register a normalized input capture. Caller-fiber-owned: owner unload
   * removes it. A duplicate id or a second exclusive capture is an explicit
   * error.
   */
  capture(spec: AdvancedInputCaptureSpec): AdvancedInputCaptureHandle
}

/** The advanced UI facade (plan §6/§8). */
export interface AdvancedUiFacade {
  /**
   * Open an interactive managed overlay hosting a focused interactive
   * component. The Host mounts it through its overlay broker (modal
   * stacking, focus, fullscreen migration, teardown) and returns a
   * caller-fiber-owned lease. A throwing render/input/focus callback is
   * isolated (health ledger).
   */
  showInteractiveOverlay(
    component: AdvancedInteractiveComponent,
    options?: TuiOverlayOptions,
  ): AdvancedOverlayLease
}

/** The full advanced facade (plan §4: `advanced(service)`). */
export interface AdvancedFacade {
  /** Normalized input capture. */
  readonly input: AdvancedInputFacade
  /** Focused interactive surfaces (interactive overlays). */
  readonly ui: AdvancedUiFacade
  /** The CURRENT surface's advanced editor controls (a getter — the
   * controls follow the live surface attachment). */
  readonly editor: AdvancedEditorControls
}

/**
 * The minimal service surface the advanced facade consumes (plan §4:
 * `advanced(service)`). STRUCTURAL and defined here so the packed
 * advanced declarations never reference the internal service module —
 * the concrete `piTuiExtensions` service implements these members, but
 * the public `PiTuiExtensionService` interface does not declare them.
 *
 * `api` is the structural anchor: a plain `PiTuiExtensionService` value
 * satisfies the facade's parameter (the seam members are optional in the
 * type), and the facade throws loudly when the host does not implement
 * the seam (a host/plugin version mismatch) instead of failing later
 * with an obscure "not a function".
 */
export interface AdvancedServiceHost {
  /** The public api() surface (the structural anchor — the facade does
   * not consume it; it makes a plain `PiTuiExtensionService` value
   * assignable to the parameter). */
  readonly api: () => import('./public-types.ts').PiTuiApiInfo
  /** The service's internal advanced seam: register a normalized input
   * capture (caller-fiber-owned). */
  _advancedCaptureInput?(spec: AdvancedInputCaptureSpec): AdvancedInputCaptureHandle
  /** The service's internal advanced seam: open an interactive managed
   * overlay (caller-fiber-owned lease). */
  _advancedShowInteractiveOverlay?(
    component: AdvancedInteractiveComponent,
    options?: TuiOverlayOptions,
  ): AdvancedOverlayLease
  /** The service's internal advanced seam: the current surface's advanced
   * editor controls (inert when stale). */
  _advancedEditorControls?(): AdvancedEditorControls
}
