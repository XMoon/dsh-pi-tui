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

/** The broker's view of the active Save Location prompt suspension (owned
 * by TuiApp). Same shape as the question suspension: a new overlay mounting
 * while the prompt is active joins the prompt's suspension set instead of
 * appearing on top. */
export interface SaveLocationSuspension {
  readonly suspendedOverlays: Set<OverlayHandle>
}

/** The broker's dependencies (the host's live state it reads). */
export interface OverlayBrokerDeps {
  /** The currently active question flow, or undefined. */
  question?: () => QuestionSuspension | undefined
  /** The currently active Save Location prompt, or undefined. */
  saveLocation?: () => SaveLocationSuspension | undefined
  /** Report the focused seat (the host's setFocusSeat — broker reports
   * 'overlay' on capturing mounts). Mount-time coarse signal only; the
   * CLOSE path re-derives the final seat through {@link reconcileFocusSeat}
   * because a restored dependent capturing overlay — not the editor — may
   * own the seat. */
  setFocusSeat?: (seat: 'editor' | 'overlay' | 'editor-panel' | 'none') => void
  /** Re-derive the host's final focused seat from the LIVE surface after a
   * tracked close (the host's publishFocusSeat). The broker must never
   * assume the close returns the seat to the editor: closing overlay B can
   * restore dependent overlay A, which owns physical focus. */
  reconcileFocusSeat?: () => void
  /** Restore PHYSICAL keyboard focus to the host's CURRENT seat owner. Used
   * when a closed capturing overlay reveals dependents but NONE of them held
   * the keyboard: the broker must not fall back to the fork's per-overlay
   * `preFocus` snapshot, which a mid-life editor-seat handoff leaves pointing
   * at the replaced editor component. */
  focusSeatOwner?: () => void
}

/** One overlay hidden beneath a newer capturing overlay: the handle plus
 * the KEYBOARD intent it had when it was hidden. Restoring visibility must
 * not silently restore focus — pi-tui re-focuses a capturing overlay on
 * setHidden(false), which would undo an explicit `blur()`. */
interface HiddenDependent {
  readonly handle: OverlayHandle
  readonly wasFocused: boolean
}

/**
 * The overlay stacking graph (M8). One instance per TuiApp; the host
 * delegates show/close through it. The broker NEVER renders — it only
 * tracks handles and their modal relationships.
 */
export class OverlayBroker {
  private readonly tracked = new Set<OverlayHandle>()
  /** The CAPTURING subset of {@link tracked}: the only handles that can own
   * the keyboard. A nonCapturing notice never takes focus and must not fence
   * an editor-seat handoff. */
  private readonly capturing = new Set<OverlayHandle>()
  /** Capturing overlay → the overlays it hid (restored on its close),
   * keeping each one's focus intent. */
  private readonly dependents = new Map<OverlayHandle, HiddenDependent[]>()
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
   *   stacking; previouslyFocused is the host's pre-mount keyboard-owner set,
   *   so a hidden dependent's focus intent survives the restore).
   * @returns the tracked close wrapper.
   */
  track(
    handle: OverlayHandle,
    options: { nonCapturing?: boolean; previouslyFocused?: ReadonlySet<OverlayHandle> } = {},
  ): OverlayHandle {
    this.tracked.add(handle)
    if (options.nonCapturing !== true) {
      this.capturing.add(handle)
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
        // Their focus intent comes from the broker's OWN capturing fact —
        // the modal suspends every visible overlay, nonCapturing notices
        // included, and a nonCapturing entry must never be selected as the
        // restored keyboard owner (its focus() would set physical focus
        // while the derived seat stays 'editor').
        const dependents: HiddenDependent[] = []
        for (const other of question.suspendedOverlays) {
          dependents.push({ handle: other, wasFocused: this.capturing.has(other) })
        }
        if (dependents.length > 0) {
          for (const dependent of dependents) question.suspendedOverlays.delete(dependent.handle)
          this.dependents.set(handle, dependents)
        }
      }
      handle.setHidden(true)
      question.suspendedOverlays.add(handle)
      return this.wrapClose(handle)
    }
    const saveLocation = this.deps.saveLocation?.()
    if (saveLocation !== undefined) {
      // A new overlay mounting while the Save Location prompt is active is
      // SUSPENDED (hidden, state intact) until the prompt settles — the
      // same stacking rule as the question flow. The prompt's settle
      // restores it (the broker's isTracked guard skips dead handles after
      // a fullscreen teardown). The prompt is never cancelled by a mount:
      // it survives fullscreen/programmatic screen swaps. An EXPLICIT
      // setHidden(false)/show() on a suspended handle is an ownership
      // override (the caller takes responsibility for the modal
      // consistency) — the same forwarding contract as the question
      // branch.
      if (options.nonCapturing !== true) {
        // Symmetric with the question branch: a CAPTURING overlay takes the
        // prompt's directly suspended handles as its OWN dependents (kept
        // hidden), so the graph survives a fullscreen remount (which clears
        // the broker graph and re-mounts every lease). Their focus intent is
        // the broker's capturing fact, never a blanket true: the modal
        // suspends nonCapturing notices too, and those must not be restored
        // as the keyboard owner.
        const dependents: HiddenDependent[] = []
        for (const other of saveLocation.suspendedOverlays) {
          dependents.push({ handle: other, wasFocused: this.capturing.has(other) })
        }
        if (dependents.length > 0) {
          for (const dependent of dependents) saveLocation.suspendedOverlays.delete(dependent.handle)
          this.dependents.set(handle, dependents)
        }
      }
      handle.setHidden(true)
      saveLocation.suspendedOverlays.add(handle)
      return this.wrapClose(handle)
    }
    if (options.nonCapturing !== true) {
      const hidden: HiddenDependent[] = []
      for (const other of this.tracked) {
        if (other !== handle && !other.isHidden()) {
          // Capture the keyboard intent from the PRE-MOUNT set: the fork
          // already focused the new overlay, so isFocused() here is always
          // false for the dependents. Absent the set (direct broker use),
          // preserve the historical restore-and-focus behavior.
          const wasFocused = options.previouslyFocused === undefined ? true : options.previouslyFocused.has(other)
          other.setHidden(true)
          hidden.push({ handle: other, wasFocused })
        }
      }
      if (hidden.length > 0) this.dependents.set(handle, hidden)
    }
    return this.wrapClose(handle)
  }

  /**
   * Update the recorded keyboard intent of a handle that is currently HIDDEN
   * as another overlay's dependent. A lease's later focus()/blur() (or an
   * explicit show()) must be reflected when that owner restores it — the
   * intent recorded at hide time is a snapshot and would otherwise go stale.
   */
  private setRestoreIntent(handle: OverlayHandle, focused: boolean): void {
    for (const [owner, dependents] of this.dependents) {
      const index = dependents.findIndex(dependent => dependent.handle === handle)
      if (index === -1) continue
      if (dependents[index]!.wasFocused === focused) continue
      const next = [...dependents]
      next[index] = { handle, wasFocused: focused }
      this.dependents.set(owner, next)
    }
  }

  /**
   * The tracked wrapper for one handle. An EXPLICIT proxy (round-1 finding
   * 3 — never a spread: the raw handle's methods are closures over private
   * state and may gain non-enumerable members; the wrapper must forward
   * every API surface verbatim). The differences from the raw handle:
   * hide() becomes the tracked close (question-aware, graph-cleaning); every
   * focus-changing operation (hide/setHidden/focus/unfocus) re-derives the
   * host's focused seat; and focus()/unfocus()/show() also refresh the
   * handle's LIVE restore intent while it is hidden beneath another overlay.
   * Internal caller-free restores use the RAW handles and reconcile once at
   * their own boundary.
   */
  private wrapClose(handle: OverlayHandle): OverlayHandle {
    const broker = this
    return {
      hide: () => broker.closeForHost(handle),
      setHidden: (hidden: boolean) => {
        handle.setHidden(hidden)
        // show() actively focuses a capturing overlay: record the intent.
        if (!hidden) broker.setRestoreIntent(handle, true)
        broker.deps.reconcileFocusSeat?.()
      },
      isHidden: () => handle.isHidden(),
      focus: () => {
        handle.focus()
        broker.setRestoreIntent(handle, true)
        broker.deps.reconcileFocusSeat?.()
      },
      unfocus: (options?: Parameters<OverlayHandle['unfocus']>[0]) => {
        handle.unfocus(options)
        broker.setRestoreIntent(handle, false)
        broker.deps.reconcileFocusSeat?.()
      },
      isFocused: () => handle.isFocused(),
      getBounds: () => handle.getBounds(),
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
    const saveLocation = this.deps.saveLocation?.()
    if (saveLocation !== undefined) saveLocation.suspendedOverlays.delete(handle)
    // The overlay that currently hides this one (if any): a handle closes
    // either as the VISIBLE front overlay or as a hidden dependent beneath a
    // still-visible overlay. Find it BEFORE the graph cleanup.
    let upperOwner: OverlayHandle | undefined
    for (const [owner, dependents] of this.dependents) {
      if (dependents.some(dependent => dependent.handle === handle)) {
        upperOwner = owner
        break
      }
    }
    for (const [owner, dependents] of this.dependents) {
      if (dependents.some(dependent => dependent.handle === handle)) {
        this.dependents.set(owner, dependents.filter(dependent => dependent.handle !== handle))
      }
    }
    const owned = this.dependents.get(handle)
    if (owned !== undefined) {
      this.dependents.delete(handle)
      // GRAPH OWNERSHIP OUTRANKS MODAL SUSPENSION: a handle closed while it
      // was hidden beneath a still-visible overlay reparents its own
      // dependents to that overlay, even while a question/save-location
      // suspension is active. Handing them to the modal would FLATTEN the
      // stack (the modal's settle reveals every suspended handle at once,
      // so a branch that belonged under the front overlay would pop up
      // beside it and steal its focus). Only a ROOT close lets the modal
      // adopt the released children.
      if (upperOwner !== undefined) {
        const upperDependents = this.dependents.get(upperOwner) ?? []
        this.dependents.set(upperOwner, [...upperDependents, ...owned])
      } else if (question !== undefined) {
        for (const dependent of owned) question.suspendedOverlays.add(dependent.handle)
      } else if (saveLocation !== undefined) {
        // The Save Location prompt owns the seat: the closed handle's
        // still-mounted dependents stay hidden and become DIRECTLY owned
        // by the prompt (they must not flash back over it — the same rule
        // as the question branch).
        for (const dependent of owned) saveLocation.suspendedOverlays.add(dependent.handle)
      }
    }
    const wasCapturing = this.capturing.has(handle)
    const wasTracked = this.tracked.delete(handle)
    this.capturing.delete(handle)
    handle.hide()
    // Reveal the dependents AFTER the closed overlay is gone (so the fork's
    // focus fallback never lands on the closing entry), then RE-APPLY the
    // focus intent captured when they were hidden: pi-tui focuses a
    // capturing overlay on setHidden(false), which would silently undo an
    // explicit blur() the plugin performed before the detail opened.
    //
    // The gate is STACK OWNERSHIP, never current visibility: a lease may be
    // temporarily hidden (`hide()`) and still be the stack root — its
    // permanent close must still release its dependents (or they become
    // hidden orphans). Conversely a hidden dependent explicitly `show()`n is
    // still owned by its upper overlay. Only a ROOT capturing close is a
    // keyboard-owner transition; a dependent's close must NOT steal the
    // keyboard from the overlay still on top (visibility override is not
    // dependency-ownership override).
    //
    // When NO dependent held the keyboard, the CURRENT seat owner must take
    // it back EXPLICITLY: the fork's own fallback is the per-overlay
    // `preFocus` snapshot, which a mid-life editor-seat handoff leaves
    // pointing at the replaced editor component. Only a CAPTURING close moves
    // focus at all (a nonCapturing notice never took it). The
    // question/save-location branches above own their own settle.
    if (wasCapturing && upperOwner === undefined && question === undefined && saveLocation === undefined) {
      if (owned !== undefined) {
        for (const dependent of owned) dependent.handle.setHidden(false)
      }
      const focusedDependent = owned?.find(dependent => dependent.wasFocused)
      if (focusedDependent !== undefined) {
        focusedDependent.handle.focus()
      } else {
        this.deps.focusSeatOwner?.()
      }
    }
    // The final seat belongs to the LIVE surface, not to the close event:
    // closing B restores dependent A (pi-tui re-focuses a restored capturing
    // overlay), so a coarse 'editor' here would be a stale/wrong seat. The
    // host re-derives it (see OverlayBrokerDeps.reconcileFocusSeat). A
    // STALE close (an already-untracked handle, e.g. after a fullscreen
    // teardown) must NOT republish the seat: the live state (an active
    // Save prompt, question, or approval) is authoritative, and a dead
    // handle's hide() requests no render to correct it later.
    if (wasTracked) this.deps.reconcileFocusSeat?.()
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
    this.capturing.clear()
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
    this.capturing.clear()
    this.dependents.clear()
  }

  /** Whether a VISIBLE capturing overlay is mounted (modal/pointer
   * presence). This is the STACKING/pointer fact, never the keyboard fact: a
   * blurred interactive overlay is still visible and still intercepts
   * pointer events in its own region. */
  hasVisibleCapturingOverlay(): boolean {
    for (const handle of this.capturing) {
      if (!handle.isHidden()) return true
    }
    return false
  }

  /** Whether a capturing overlay currently HOLDS keyboard focus (visible,
   * not hidden, and physically focused). This is the KEYBOARD-ownership
   * fact: a `blur()`ed (or hidden) capturing overlay is visible but the
   * editor owns the keyboard again, so the Host shortcut ladder must run. */
  hasFocusedCapturingOverlay(): boolean {
    for (const handle of this.capturing) {
      if (!handle.isHidden() && handle.isFocused()) return true
    }
    return false
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
