/**
 * The OverlayBroker (M8, plan §13): the overlay stacking graph extracted
 * from TuiApp. It owns the RULES — which overlays are hidden beneath a
 * newer capturing overlay, how the question-flow suspension set interacts
 * with the modal stack, reverse-restore order, and per-handle close — while
 * the TuiApp keeps the physical screen mount/unmount (the broker calls the
 * screen through a narrow seam, so rendering stays host-owned).
 *
 * Contract (plan §13.1):
 * - the FIRST extraction is behavior-identical: the existing headless
 *   overlay tests (approval-over-settings modal hiding, question
 *   suspension graph, fullscreen migration) must pass unchanged;
 * - a capturing overlay hides every other visible capturing overlay and
 *   records them as its dependents (restored in reverse arrival order on
 *   close);
 * - while a question owns the editor seat, a NEW overlay joins the
 *   question's suspension set instead of appearing on top; the question's
 *   directly suspended handles become the new overlay's dependents; the
 *   overlay itself becomes the question's frontmost suspended handle;
 * - close is question-aware: a handle leaving the suspension set keeps its
 *   still-mounted dependents hidden and re-owns them directly under the
 *   question (they must not flash back while the question is up);
 * - close/fullscreen teardown is idempotent (a disposed handle is inert).
 * @module @xmoon76/dsh-pi-tui/overlay-broker
 */

import type { OverlayHandle } from '@xmoon76/pi-tui'

/** The broker's view of the active question suspension (owned by TuiApp's
 * QuestionFlow). The broker reads/writes it through this seam. */
export interface QuestionSuspension {
  readonly suspendedOverlays: Set<OverlayHandle>
}

/** The broker's dependencies (the host's live state it reads). */
export interface OverlayBrokerDeps {
  /** The currently active question flow, or undefined. */
  question?: () => QuestionSuspension | undefined
  /** Report the focused seat (the host's setFocusSeat — broker reports
   * 'overlay' on capturing mounts). */
  setFocusSeat?: (seat: 'editor' | 'overlay' | 'editor-panel' | 'none') => void
}

/**
 * The overlay stacking graph (M8). One instance per TuiApp; the host
 * delegates show/close through it. The broker NEVER renders — it only
 * tracks handles and their modal relationships.
 */
export class OverlayBroker {
  private readonly tracked = new Set<OverlayHandle>()
  /** Capturing overlay → the overlays it hid (restored on its close). */
  private readonly dependents = new Map<OverlayHandle, Set<OverlayHandle>>()
  private readonly deps: OverlayBrokerDeps

  constructor(deps: OverlayBrokerDeps = {}) {
    this.deps = deps
  }

  /**
   * Register a NEWLY MOUNTED overlay handle and apply the stacking rules.
   * The host mounts the overlay on the active screen FIRST, then calls
   * this with the handle; the broker returns a question-aware close
   * wrapper.
   * @param handle - the screen-mounted handle.
   * @param options - the mount options (nonCapturing skips the modal
   *   stacking).
   * @returns the tracked close wrapper.
   */
  track(handle: OverlayHandle, options: { nonCapturing?: boolean } = {}): OverlayHandle {
    this.tracked.add(handle)
    if (options.nonCapturing !== true) {
      this.deps.setFocusSeat?.('overlay')
    }
    const question = this.deps.question?.()
    if (question !== undefined) {
      // Sweep: any tracked overlay still visible joins the suspension.
      for (const other of this.tracked) {
        if (other !== handle && !other.isHidden()) {
          other.setHidden(true)
          question.suspendedOverlays.add(other)
        }
      }
      if (options.nonCapturing !== true) {
        // The new capturing overlay takes the modal front: the question's
        // directly suspended handles become its dependents (kept hidden).
        const dependents = new Set<OverlayHandle>()
        for (const other of question.suspendedOverlays) dependents.add(other)
        if (dependents.size > 0) {
          for (const other of dependents) question.suspendedOverlays.delete(other)
          this.dependents.set(handle, dependents)
        }
      }
      handle.setHidden(true)
      question.suspendedOverlays.add(handle)
      return this.wrapClose(handle)
    }
    if (options.nonCapturing !== true) {
      const hidden = new Set<OverlayHandle>()
      for (const other of this.tracked) {
        if (other !== handle && !other.isHidden()) {
          other.setHidden(true)
          hidden.add(other)
        }
      }
      if (hidden.size > 0) this.dependents.set(handle, hidden)
    }
    return this.wrapClose(handle)
  }

  /**
   * The tracked close wrapper for one handle. An EXPLICIT proxy (round-1
   * finding 3 — never a spread: the raw handle's methods are closures over
   * private state and may gain non-enumerable members; the wrapper must
   * forward every API surface verbatim). The ONLY difference from the raw
   * handle: hide() becomes the tracked close (question-aware, graph-
   * cleaning), while setHidden/isHidden/focus/unfocus/isFocused forward.
   */
  private wrapClose(handle: OverlayHandle): OverlayHandle {
    const broker = this
    return {
      hide: () => broker.closeForHost(handle),
      setHidden: (hidden: boolean) => handle.setHidden(hidden),
      isHidden: () => handle.isHidden(),
      focus: () => handle.focus(),
      unfocus: (options?: Parameters<OverlayHandle['unfocus']>[0]) => handle.unfocus(options),
      isFocused: () => handle.isFocused(),
    }
  }

  /**
   * Question-aware close for one tracked handle. Without an active
   * question this matches the historical behavior: the handle's dependents
   * are unhidden, the graph is cleaned, the overlay is removed. While a
   * question owns the seat, the handle leaves the suspension set, every
   * dependency set drops it, and its still-mounted dependents remain
   * hidden and become DIRECTLY owned by the question.
   */
  closeForHost(handle: OverlayHandle): void {
    const question = this.deps.question?.()
    if (question !== undefined) question.suspendedOverlays.delete(handle)
    for (const dependents of this.dependents.values()) dependents.delete(handle)
    const owned = this.dependents.get(handle)
    if (owned !== undefined) {
      this.dependents.delete(handle)
      if (question !== undefined) {
        for (const dependent of owned) question.suspendedOverlays.add(dependent)
      } else {
        for (const dependent of owned) dependent.setHidden(false)
      }
    }
    this.tracked.delete(handle)
    handle.hide()
    // The seat may have returned to the editor (or to another capturing
    // overlay restored underneath); the host recomputes from live state.
    this.deps.setFocusSeat?.('editor')
  }

  /** Hide every tracked overlay (fullscreen migration — the host stops
   * the old screen). Idempotent. */
  hideAll(): void {
    for (const handle of this.tracked) {
      if (!handle.isHidden()) handle.setHidden(true)
    }
  }

  /** Forget every handle WITHOUT unmounting (surface teardown — the
   * screen is going away; the handles die with it). Idempotent. */
  clear(): void {
    this.tracked.clear()
    this.dependents.clear()
  }

  /**
   * FINAL surface teardown: physically unmount every tracked overlay
   * (running disposeOnHide) WITHOUT restoring dependents — the whole
   * surface is dying, nothing may flash back. Unlike closeForHost this
   * bypasses the question-aware graph cleanup and the focus-seat report:
   * the tracked set holds the RAW screen handles, so hide() runs the
   * fork's physical unmount + disposeOnHide chain (the owning frame
   * disposes the panel, which stops its timers exactly once). Idempotent.
   */
  disposeAll(): void {
    for (const handle of this.tracked) handle.hide()
    this.tracked.clear()
    this.dependents.clear()
  }

  /** The current graph sizes (headless assertions — the graph is
   * behaviorally invisible; stale entries only leak memory). */
  graphState(): { handles: number; dependents: number } {
    return { handles: this.tracked.size, dependents: this.dependents.size }
  }

  /** Every tracked handle (the host iterates for fullscreen migration and
   * question suspension sweeps). */
  handles(): ReadonlySet<OverlayHandle> {
    return this.tracked
  }

  /** Whether a handle is still tracked (a stale handle from a previous
   * generation must not be revived by the question settle). */
  isTracked(handle: OverlayHandle): boolean {
    return this.tracked.has(handle)
  }
}
