/**
 * The OverlayBroker (M8, plan §13): the managed-overlay model extracted from
 * TuiApp. It owns the LOGICAL authority for every managed overlay — identity,
 * suppression forest, explicit visibility intent, restore-focus intent and the
 * logical front order — while the host owns the physical screen mount. The
 * broker calls the screen through a narrow seam, so rendering stays
 * host-owned.
 *
 * MODEL (2026-09 revision). A raw pi-tui handle is only a PHYSICAL projection
 * of a stable logical node:
 *
 * - one {@link ManagedOverlayNode} per managed overlay, returned to the host /
 *   lease as a STABLE handle whose methods read the node's current raw binding
 *   (so a fullscreen screen swap can replace the raw handle without the public
 *   lease noticing);
 * - a node has AT MOST ONE suppressor: another managed node (`parent`), the
 *   active Question suspension, the active Save Location suspension, or none
 *   (a logical root);
 * - `explicitHidden` is the caller's temporary-hide intent and is independent
 *   of suppression (I3): closing a suppressor must never reveal a node the
 *   caller explicitly hid;
 * - `resumeFocus` is the node's OWN keyboard intent — re-applied when the node
 *   is revealed — never a snapshot frozen on a dependency edge; `focus()` /
 *   `blur()` / an explicit `show()` update it live;
 * - `zOrder` is the CURRENT logical front order (bumped only when the fork
 *   actually promotes the node's visual order: mount, capturing show, focus),
 *   never the original creation order;
 * - `nonCapturing` is a MOUNT POLICY (no auto-focus, no modal suppression of
 *   siblings). It is NOT a keyboard-capability fact: an explicit `focus()`
 *   from a focus-capable lease can make a nonCapturing node the physical
 *   keyboard owner.
 *
 * The two facts the host derives are therefore distinct:
 * - {@link hasVisibleModalOverlay} — a visible auto-capturing overlay exists
 *   (pointer / background-modal suppression);
 * - {@link hasFocusedOverlay} — a managed node currently holds PHYSICAL
 *   keyboard focus (keyboard routing, Host shortcut ladder, focused seat,
 *   editor-seat handoff, task affordance).
 *
 * A fullscreen screen swap never rebuilds the graph: {@link detachPhysical}
 * drops the raw bindings, the host re-creates them in {@link remountOrder},
 * and {@link rebind} attaches each fresh projection; logical topology,
 * visibility intent, focus intent and z-order all survive.
 *
 * @module @xmoon76/dsh-pi-tui/overlay-broker
 */

import type { OverlayHandle } from '@xmoon76/pi-tui'

/** The broker's view of the active question suspension (owned by TuiApp's
 * QuestionFlow). The broker reads/writes it through this seam. */
export interface QuestionSuspension {
  readonly suspendedOverlays: Set<OverlayHandle>
}

/** The broker's view of the active Save Location prompt suspension (owned
 * by TuiApp). Same shape as the question suspension. */
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
   * 'overlay' on capturing mounts). Coarse mount-time signal; the host
   * re-derives the final seat from physical focus. */
  setFocusSeat?: (seat: 'editor' | 'overlay' | 'editor-panel' | 'none') => void
  /** Re-derive the host's final focused seat from the LIVE surface. */
  reconcileFocusSeat?: () => void
  /** Restore PHYSICAL keyboard focus to the host's CURRENT seat owner (used
   * when no managed overlay should own the keyboard; never the fork's stale
   * per-overlay `preFocus` snapshot). */
  focusSeatOwner?: () => void
}

/** A stable logical overlay node. */
interface ManagedOverlayNode {
  readonly id: number
  /** The current physical projection (undefined while detached for a screen
   * swap, or after close). */
  raw: OverlayHandle | undefined
  /** The stable handle returned to the host / lease. */
  wrapper: OverlayHandle
  readonly nonCapturing: boolean
  readonly remountable: boolean
  /** The overlay currently suppressing this node, if any. */
  parent: ManagedOverlayNode | undefined
  readonly children: ManagedOverlayNode[]
  /** Caller temporary-hide intent (independent of suppression). */
  explicitHidden: boolean
  /** Whether this node should own the keyboard when revealed. */
  resumeFocus: boolean
  /** A caller-supplied unfocus target was forwarded during the current
   * explicit focus(); the post-check must not override it. */
  explicitTargetForwarded: boolean
  /** Current logical front order (higher = nearer the front). */
  zOrder: number
  closed: boolean
}

/** A node suppressed by the new mount, with its pre-mount focus state. */
interface PreparedSuppression {
  readonly node: ManagedOverlayNode
  readonly resumeFocus: boolean
}

/** The two-phase mount token returned by {@link OverlayBroker.prepareMount}. */
export interface PreparedMount {
  readonly node: ManagedOverlayNode
  readonly suppress: readonly PreparedSuppression[]
}

export class OverlayBroker {
  private readonly nodes = new Map<OverlayHandle, ManagedOverlayNode>()
  private readonly roots = new Set<ManagedOverlayNode>()
  /** The node that owned the keyboard before a screen swap. */
  private swapFocusOwner: ManagedOverlayNode | undefined
  private zSequence = 0
  private idSequence = 0
  private readonly deps: OverlayBrokerDeps

  constructor(deps: OverlayBrokerDeps = {}) {
    this.deps = deps
  }

  /**
   * Phase 1 of a mount: allocate the logical node and snapshot the CURRENT
   * visible roots that a capturing overlay will suppress. The focus snapshot
   * MUST happen here — the fork focuses the new overlay the moment it is
   * mounted, so a post-mount read would always see the dependents unfocused.
   */
  prepareMount(options: { nonCapturing?: boolean; remountable?: boolean } = {}): PreparedMount {
    const nonCapturing = options.nonCapturing === true
    const suppress: PreparedSuppression[] = []
    if (!nonCapturing) {
      for (const node of this.roots) {
        if (node.closed || !this.isVisible(node) || this.isSuppressed(node)) continue
        suppress.push({ node, resumeFocus: node.raw?.isFocused() === true })
      }
    }
    const node: ManagedOverlayNode = {
      id: ++this.idSequence,
      raw: undefined,
      wrapper: undefined as unknown as OverlayHandle,
      nonCapturing,
      remountable: options.remountable === true,
      parent: undefined,
      children: [],
      explicitHidden: false,
      resumeFocus: false,
      explicitTargetForwarded: false,
      zOrder: 0,
      closed: false,
    }
    node.wrapper = this.wrap(node)
    return { node, suppress }
  }

  /**
   * Phase 2 of a mount: bind the freshly mounted raw handle and apply the
   * stacking rules.
   *
   * ORDER MATTERS: the host mounts every overlay with `initialFocus:false`, so
   * the fork fires NO focus callback here. The LOGICAL graph (registration,
   * roots, parent/children, resumeFocus, zOrder) commits FIRST; only then does
   * the physical transition run (hide the suppressed children, focus the new
   * owner exactly once). A plugin that mounts another overlay inside its
   * `onFocus` therefore sees the COMPLETE committed graph — it can never
   * re-adopt a child whose ownership this commit has already assigned.
   */
  commitMount(prepared: PreparedMount, raw: OverlayHandle): OverlayHandle {
    const node = prepared.node
    node.raw = raw
    node.zOrder = ++this.zSequence
    this.nodes.set(node.wrapper, node)
    // A logical modal (question / save location) owns the seat: the new
    // overlay joins the modal's DIRECT suspension set instead of appearing on
    // top. Existing suspension topology is untouched.
    const suspension = this.activeSuspension()
    if (suspension !== undefined) {
      // A capturing overlay suspended under a modal is the modal's frontmost
      // handle and reclaims the keyboard when the modal settles; a
      // nonCapturing notice never does. It is still a logical ROOT (only
      // hidden), so it must join `roots`.
      node.resumeFocus = !node.nonCapturing
      this.roots.add(node)
      suspension.suspendedOverlays.add(node.wrapper)
      // Physical transition (no focus involved: the raw was never focused).
      raw.setHidden(true)
      return node.wrapper
    }
    if (node.nonCapturing) {
      // Mount policy: no auto-focus and no suppression of siblings.
      this.roots.add(node)
      return node.wrapper
    }
    // Capturing: adopt the prepared VISIBLE ROOTS as this node's children
    // (only roots — never every visible handle, which would allow a node to
    // acquire a second suppressor). The new node owns the keyboard intent as
    // a logical root.
    node.resumeFocus = true
    for (const entry of prepared.suppress) {
      const child = entry.node
      this.roots.delete(child)
      child.parent = node
      child.resumeFocus = entry.resumeFocus
      node.children.push(child)
    }
    this.roots.add(node)
    // LOGICAL COMMIT COMPLETE. Physical transition: take the keyboard first
    // (this may re-enter through a plugin onFocus, which now sees the full
    // graph), then hide the suppressed children (no longer focused → the
    // fork's hide fallback cannot fire).
    this.focusPhysical(node)
    for (const child of node.children) child.raw?.setHidden(true)
    this.deps.setFocusSeat?.('overlay')
    return node.wrapper
  }

  /**
   * Temporarily hide a node (the public lease's `hide()`): records the
   * caller's explicit intent and hides the physical projection. Suppression
   * topology is untouched, so closing a suppressor later must not reveal it.
   */
  setExplicitHidden(handle: OverlayHandle, hidden: boolean): void {
    const node = this.nodes.get(handle)
    if (node === undefined || node.closed) return
    if (hidden) {
      node.explicitHidden = true
      // Move the keyboard FIRST: the fork's own hide fallback would otherwise
      // pick another visible capturing overlay, ignoring the logical intent.
      this.releaseKeyboard(node)
      // `releaseKeyboard` focuses another root, whose synchronous onFocus may
      // have issued a NEWER focus()/show() on this node (clearing the hidden
      // intent). Only apply the physical hide while this release still stands.
      if (!node.closed && node.raw !== undefined && node.explicitHidden === true) {
        node.raw.setHidden(true)
      }
      this.deps.reconcileFocusSeat?.()
      return
    }
    // An explicit show is a SUPPRESSION OVERRIDE (I2): detach from the current
    // suppressor before revealing, so the graph stays a forest. The focus
    // INTENT commits before the physical show: `showPhysical` can synchronously
    // fire a plugin onFocus that mounts a nested overlay (which would hide this
    // node and make a post-callback `isFocused()` read its corrupted value).
    this.detach(node)
    node.explicitHidden = false
    node.resumeFocus = !node.nonCapturing
    this.showPhysical(node)
    this.deps.reconcileFocusSeat?.()
  }

  /** Explicit focus request (including for a nonCapturing node): detaches any
   * suppressor, reveals and promotes the node to the keyboard owner. The intent
   * commits before the physical calls, which may re-enter through onFocus. */
  focus(handle: OverlayHandle): void {
    const node = this.nodes.get(handle)
    if (node === undefined || node.closed) return
    this.detach(node)
    node.explicitHidden = false
    node.resumeFocus = true
    node.explicitTargetForwarded = false
    // Showing a HIDDEN capturing overlay already focuses and promotes it (the
    // fork's setHidden(false) contract), and its onFocus may have mounted a
    // newer overlay that must keep the higher z. Complete the explicit focus
    // only when the show did NOT already take it, and only while the node is
    // still live, visible and logically requesting focus (a nested capturing
    // owner hides it; a callback blur() clears the intent).
    const showWillTakeFocus = node.raw !== undefined && node.raw.isHidden() === true && !node.nonCapturing
    this.showPhysical(node)
    if (
      !showWillTakeFocus
      && !node.closed
      && node.raw !== undefined
      && !node.raw.isHidden()
      && node.resumeFocus === true
    ) {
      this.focusPhysical(node)
    }
    // The pending target's OWN intent may have been released by a callback
    // during focusPhysical (the previous owner's onBlur called blur()/hide()
    // on it). Re-derive the logical owner when the explicit intent no longer
    // stands instead of leaving it focused.
    if (node.explicitTargetForwarded) {
      node.explicitTargetForwarded = false
    } else if (!node.closed && node.raw !== undefined && (node.resumeFocus !== true || node.explicitHidden)) {
      const next = this.frontmostFocusable([...this.roots])
      if (next !== undefined && next !== node) {
        if (next.raw?.isFocused() !== true) this.focusPhysical(next, { preserveOrder: true })
      } else if (next === undefined) {
        this.deps.focusSeatOwner?.()
      }
    }
    this.deps.reconcileFocusSeat?.()
  }

  /** Release focus (the public `blur()`): the intent is stored on the node,
   * so it survives a suppression / fullscreen round-trip. */
  unfocus(handle: OverlayHandle, options?: Parameters<OverlayHandle['unfocus']>[0]): void {
    const node = this.nodes.get(handle)
    if (node === undefined || node.closed) return
    node.resumeFocus = false
    if (options?.target !== undefined) {
      // A caller-supplied target is explicit: forward it verbatim and make
      // sure an in-flight focus() post-check does not override it.
      node.explicitTargetForwarded = true
      node.raw?.unfocus(options)
      this.deps.reconcileFocusSeat?.()
      return
    }
    // Move the keyboard FIRST: the fork's unfocus fallback would otherwise
    // focus the topmost visible capturing overlay, even one the user blurred.
    this.releaseKeyboard(node)
    // The release focuses another root, whose synchronous onFocus may have
    // issued a NEWER focus() on this node (restoring the intent). Only apply
    // the physical unfocus while this release still stands.
    if (!node.closed && node.raw !== undefined && node.resumeFocus === false) {
      node.raw.unfocus()
    }
    this.deps.reconcileFocusSeat?.()
  }

  /** Close a node for good. The close contract is LOGICAL (ownership), never
   * current visibility or capture policy. */
  close(handle: OverlayHandle): void {
    const node = this.nodes.get(handle)
    if (node === undefined || node.closed) return
    // The keyboard owner BEFORE the close: a surviving overlay that held the
    // keyboard must keep it — revealing this node's children may change
    // visibility but must never steal ownership from an unrelated front
    // overlay.
    const priorFocus = this.currentlyFocused()
    node.closed = true
    this.nodes.delete(handle)
    this.roots.delete(node)
    const parent = node.parent
    const children = [...node.children]
    node.children.length = 0
    node.parent = undefined
    if (parent !== undefined) {
      const index = parent.children.indexOf(node)
      if (index !== -1) parent.children.splice(index, 1)
    }
    // The closing node leaves the modal suspensions it may belong to.
    this.deps.question?.()?.suspendedOverlays.delete(handle)
    this.deps.saveLocation?.()?.suspendedOverlays.delete(handle)
    // Re-home the children under the SINGLE remaining suppressor:
    // - an overlay parent (stay hidden, reparented);
    // - the active modal (join its direct suspension, stay hidden);
    // - otherwise they become logical roots (revealed below).
    const suspension = this.activeSuspension()
    for (const child of children) {
      child.parent = undefined
      if (parent !== undefined) {
        parent.children.push(child)
        child.parent = parent
        continue
      }
      if (suspension !== undefined) {
        // The child is still a logical ROOT, merely hidden by the modal: it
        // must join `roots` so a later resume/suppression sees it.
        this.roots.add(child)
        suspension.suspendedOverlays.add(child.wrapper)
        continue
      }
      this.roots.add(child)
    }
    const revealed = children.filter(child => child.parent === undefined && !this.isSuppressed(child))
    // 1. Visibility first, WITHOUT any keyboard side effect: a revealed child
    //    must not auto-focus (that would emit a spurious onFocus/onBlur on an
    //    overlay that was deliberately blurred). An explicitly hidden child
    //    stays hidden.
    for (const child of revealed) {
      if (child.explicitHidden) continue
      this.showPhysical(child, { preserveOrder: true, preserveFocus: true })
    }
    // 2. Decide the next logical keyboard owner BEFORE hiding the closing
    //    node: the fork's permanent hide() hands focus to another visible
    //    capturing overlay, which could wrongly re-activate a blurred sibling.
    const keepFocus = priorFocus !== undefined && priorFocus !== node && !priorFocus.closed
      && priorFocus.raw !== undefined && this.isVisible(priorFocus)
      ? priorFocus
      : undefined
    const nextOwner = keepFocus
      ?? this.frontmostFocusable(revealed)
      ?? this.frontmostFocusable([...this.roots])
    if (nextOwner !== undefined) {
      if (nextOwner.raw?.isFocused() !== true) this.focusPhysical(nextOwner, { preserveOrder: true })
    } else if (this.activeSuspension() === undefined) {
      // No overlay should own the keyboard. An active Question / Save Location
      // owns the seat through its editor-seat frame (not a managed node) and
      // must keep it (Case B); otherwise hand it to the current editor seat.
      // Retargeting BEFORE hide() stops the fork's own focus fallback.
      this.deps.focusSeatOwner?.()
    }
    // 3. Now hide the closing node: it no longer owns the keyboard, so the
    //    fork restores nobody.
    node.raw?.hide()
    node.raw = undefined
    this.deps.reconcileFocusSeat?.()
  }

  /**
   * Directly suspend every visible logical ROOT under the given modal (the
   * Question / Save Location primitive). Child topology is never copied.
   * TWO-PHASE: snapshot every root's focus intent BEFORE any mutation, then
   * release the keyboard to the modal frame (the seat) before hiding, so the
   * fork's hide fallback can never focus (and thereby re-intent) a sibling.
   */
  suspendVisibleRoots(suspension: QuestionSuspension | SaveLocationSuspension): void {
    const targets = [...this.roots].filter(node =>
      !node.closed && this.isVisible(node) && !node.explicitHidden)
    // Phase 1: commit the logical suspension (intent + ownership) BEFORE any
    // physical call that can fire a callback.
    for (const node of targets) {
      node.resumeFocus = node.raw?.isFocused() === true
      suspension.suspendedOverlays.add(node.wrapper)
    }
    // Phase 2: hand the keyboard to the seat owner BEFORE hiding any root.
    if (this.currentlyFocused() !== undefined) this.deps.focusSeatOwner?.()
    // Phase 3: hide only the nodes this suspension STILL owns. A callback in
    // Phase 2 may have explicitly re-shown one (which detaches it from the
    // suspension set) — that newer operation must win.
    for (const node of targets) {
      if (node.closed || !suspension.suspendedOverlays.has(node.wrapper)) continue
      node.raw?.setHidden(true)
    }
    this.deps.reconcileFocusSeat?.()
  }

  /** Restore the modal's directly suspended roots (Question / Save Location
   * settle). Each root keeps its own focus intent; the previously focused one
   * (frontmost) reclaims the keyboard, otherwise the current seat owner does. */
  resumeSuspendedRoots(suspension: QuestionSuspension | SaveLocationSuspension): void {
    const restored: ManagedOverlayNode[] = []
    for (const handle of [...suspension.suspendedOverlays]) {
      const node = this.nodes.get(handle)
      if (node === undefined || node.closed) continue
      restored.push(node)
    }
    // The suspension release may have let a callback issue a NEWER explicit
    // focus()/show() on a sibling it detached from this suspension; that newer
    // intent wins on settle. A root can only be absent from the suspension set
    // through such an operation (explicitHidden / non-focusable roots are
    // filtered by frontmostFocusable).
    const newerOwner = this.frontmostFocusable(
      [...this.roots].filter(node => !suspension.suspendedOverlays.has(node.wrapper)),
    )
    suspension.suspendedOverlays.clear()
    this.reveal(restored, newerOwner)
  }

  /** Whether a visible auto-capturing (modal) overlay exists — the POINTER /
   * background-modal fact, not the keyboard fact. */
  hasVisibleModalOverlay(): boolean {
    for (const node of this.nodes.values()) {
      if (!node.nonCapturing && this.isVisible(node) && !node.explicitHidden) return true
    }
    return false
  }

  /** Whether a managed overlay currently holds PHYSICAL keyboard focus — the
   * keyboard-ownership fact (any policy). */
  hasFocusedOverlay(): boolean {
    return this.currentlyFocused() !== undefined
  }

  /**
   * Prepare for a screen swap. REMOUNTABLE nodes keep their whole logical
   * state (topology, visibility intent, focus intent, z-order, modal
   * suspensions) and merely drop their raw binding — the host re-creates it.
   * A non-remountable node cannot survive the swap, so it is closed logically
   * (its raw handle dies with the old screen).
   */
  detachPhysical(): void {
    // 1. Close the non-remountable nodes FIRST, on the old screen, while the
    //    retained children still have live raw projections: the close's normal
    //    reveal / focus transition then completes (a doomed owner must never
    //    be snapshotted as the surviving keyboard owner).
    for (const node of [...this.nodes.values()]) {
      if (node.remountable || node.closed) continue
      this.close(node.wrapper)
    }
    // 2. Release the overlays to the seat owner BEFORE detaching any raw, so
    //    the fork's per-hide fallback cannot transiently focus a blurred
    //    sibling on the old screen. That release synchronously blurs the old
    //    owner, whose onBlur may issue a NEWER focus() — but the outer
    //    `setFocus(editor)` resumes after the callback and can overwrite that
    //    PHYSICAL focus, so derive the pre-swap owner from LOGICAL intent
    //    instead: a callback B.focus() promotes B's z/intent, so B wins; with
    //    no callback the prior owner stays frontmost; a callback blur() clears
    //    the prior intent and the seat owner wins.
    const prior = this.currentlyFocused()
    if (prior !== undefined) this.deps.focusSeatOwner?.()
    let releases = 0
    while (this.currentlyFocused() !== undefined && releases < 4) {
      this.deps.focusSeatOwner?.()
      releases += 1
    }
    this.swapFocusOwner = this.frontmostFocusable([...this.roots])
      ?? (prior !== undefined && !prior.closed && prior.resumeFocus === true && !prior.explicitHidden
        ? prior
        : undefined)
    // 3. Detach every retained raw projection (the component survives; the
    //    host re-creates it after the swap).
    for (const node of [...this.nodes.values()]) {
      if (!node.remountable || node.closed) continue
      node.raw?.hide()
      node.raw = undefined
    }
  }

  /** The remountable stable handles, back → front by CURRENT logical order. */
  remountOrder(): OverlayHandle[] {
    return [...this.nodes.entries()]
      .filter(([, node]) => node.remountable && !node.closed)
      .sort((a, b) => a[1].zOrder - b[1].zOrder)
      .map(([handle]) => handle)
  }

  /** Attach a fresh physical projection to an existing logical node. */
  rebind(handle: OverlayHandle, raw: OverlayHandle): void {
    const node = this.nodes.get(handle)
    if (node === undefined) {
      // A lease that closed during the swap: the fresh projection is orphaned.
      raw.hide()
      return
    }
    node.raw = raw
    if (this.isSuppressed(node) || node.explicitHidden) raw.setHidden(true)
  }

  /** Re-apply the pre-swap keyboard owner (or the current seat owner) after
   * every rebind. The owner is only re-focused when the natural rebind order
   * did not already restore it — an extra `focus()` would promote it to the
   * visual front and break e.g. a nonCapturing HUD that legitimately sits
   * above the focused overlay. */
  restoreFocusAfterSwap(): void {
    const owner = this.swapFocusOwner
    this.swapFocusOwner = undefined
    if (owner !== undefined && !owner.closed && this.isVisible(owner) && owner.raw !== undefined) {
      // An internal rebind restore only takes the keyboard: the remount order
      // already restored the visual order, so an explicit focus() must not
      // promote the owner (a nonCapturing owner can legitimately sit behind a
      // later nonCapturing HUD).
      if (owner.raw.isFocused() !== true) this.focusPhysical(owner, { preserveOrder: true })
    } else if (owner === undefined) {
      // The editor (not a managed overlay) owned the keyboard before the swap:
      // the natural rebind order may have auto-focused a capturing overlay, so
      // release it back to the seat owner.
      this.deps.focusSeatOwner?.()
    } else if (this.currentlyFocused() === undefined) {
      // The owner did not survive the swap: keep a surviving replacement the
      // rebind already restored, otherwise hand the seat to the editor.
      this.deps.focusSeatOwner?.()
    }
    this.deps.reconcileFocusSeat?.()
  }

  /** Physically unmount every node (final surface teardown) without restoring
   * anything, then forget the graph. Idempotent. */
  disposeAll(): void {
    for (const node of this.nodes.values()) node.raw?.hide()
    this.nodes.clear()
    this.roots.clear()
  }

  /** Every stable managed handle (test / diagnostics). */
  handles(): ReadonlySet<OverlayHandle> {
    return new Set(this.nodes.keys())
  }

  /** The current graph sizes (headless assertions). `dependents` is the number
   * of suppression EDGES; `suspended` the number of modal-suspended roots. */
  graphState(): { handles: number; dependents: number; suspended: number } {
    let dependents = 0
    for (const node of this.nodes.values()) dependents += node.children.length
    const question = this.deps.question?.()
    const save = this.deps.saveLocation?.()
    const suspended = (question?.suspendedOverlays.size ?? 0) + (save?.suspendedOverlays.size ?? 0)
    return { handles: this.nodes.size, dependents, suspended }
  }

  /** Assert the forest invariants (tests only): one suppressor per node, the
   * parent/children edges agree in BOTH directions, `roots` holds exactly the
   * unsuppressed nodes, and there are no cycles or closed nodes. */
  assertForest(): void {
    const incoming = new Map<number, number>()
    for (const node of this.nodes.values()) {
      if (node.closed) throw new Error(`closed node ${node.id} is still in the graph`)
      for (const child of node.children) {
        if (child.closed) throw new Error(`closed child ${child.id} is still a child of ${node.id}`)
        if (child.parent !== node) {
          throw new Error(`child ${child.id} does not point back to its parent ${node.id}`)
        }
        const count = (incoming.get(child.id) ?? 0) + 1
        if (count > 1) throw new Error(`node ${child.id} has multiple parents`)
        incoming.set(child.id, count)
      }
    }
    for (const node of this.nodes.values()) {
      if (node.parent === undefined) {
        if (!this.roots.has(node)) throw new Error(`unsuppressed node ${node.id} is missing from roots`)
        continue
      }
      if (this.roots.has(node)) throw new Error(`suppressed node ${node.id} is also a logical root`)
      if (!node.parent.children.includes(node)) {
        throw new Error(`node ${node.id} parent does not list it as a child`)
      }
    }
    // The other direction: `roots` must hold EXACTLY the registered,
    // unsuppressed, live nodes (no extraneous / closed / unregistered entry).
    for (const root of this.roots) {
      if (root.closed) throw new Error(`closed node ${root.id} is retained in roots`)
      if (!this.nodes.has(root.wrapper)) throw new Error(`unregistered node ${root.id} is retained in roots`)
      if (root.parent !== undefined) throw new Error(`suppressed node ${root.id} is retained in roots`)
    }
    for (const node of this.nodes.values()) {
      const chain = new Set<number>()
      let current: ManagedOverlayNode | undefined = node
      while (current !== undefined) {
        if (chain.has(current.id)) throw new Error(`cycle at node ${current.id}`)
        chain.add(current.id)
        current = current.parent
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The stable handle for a node: every method reads the node's CURRENT raw
   * binding, so a fullscreen rebind is invisible to the caller. */
  private wrap(node: ManagedOverlayNode): OverlayHandle {
    const broker = this
    return {
      hide: () => broker.close(node.wrapper),
      setHidden: (hidden: boolean) => broker.setExplicitHidden(node.wrapper, hidden),
      isHidden: () => node.raw === undefined || node.raw.isHidden(),
      focus: () => broker.focus(node.wrapper),
      unfocus: (options?: Parameters<OverlayHandle['unfocus']>[0]) => broker.unfocus(node.wrapper, options),
      isFocused: () => node.raw?.isFocused() === true,
      getBounds: () => node.raw?.getBounds(),
    }
  }

  private activeSuspension(): QuestionSuspension | SaveLocationSuspension | undefined {
    return this.deps.question?.() ?? this.deps.saveLocation?.()
  }

  private isSuppressed(node: ManagedOverlayNode): boolean {
    if (node.parent !== undefined) return true
    const question = this.deps.question?.()
    if (question?.suspendedOverlays.has(node.wrapper) === true) return true
    const save = this.deps.saveLocation?.()
    return save?.suspendedOverlays.has(node.wrapper) === true
  }

  private isVisible(node: ManagedOverlayNode): boolean {
    return !node.closed && node.raw !== undefined && !node.raw.isHidden()
  }

  /**
   * Show a node's physical projection. An EXPLICIT show mirrors the fork's
   * mutations (a hidden CAPTURING overlay auto-focuses and is promoted) so the
   * logical z follows; an INTERNAL restore passes `preserveOrder` /
   * `preserveFocus` and reproduces the pre-suppression stacking and keyboard
   * ownership instead (the caller then focuses exactly ONE owner).
   *
   * The logical promotion happens BEFORE the fork call: `setHidden(false)` can
   * synchronously focus and fire a plugin onFocus that mounts a nested
   * overlay, and that nested overlay must end up ahead of this one (it mounted
   * later) rather than being overtaken when this call returns.
   */
  private showPhysical(
    node: ManagedOverlayNode,
    options?: { preserveOrder?: boolean; preserveFocus?: boolean },
  ): void {
    if (node.raw === undefined) return
    const wasHidden = node.raw.isHidden() === true
    if (wasHidden && !node.nonCapturing && options?.preserveOrder !== true) {
      node.zOrder = ++this.zSequence
    }
    node.raw.setHidden(false, options)
  }

  /**
   * Focus a node's physical projection. An EXPLICIT focus mirrors the fork's
   * promotion; an INTERNAL restore passes `preserveOrder` and only takes the
   * keyboard.
   *
   * The logical promotion happens BEFORE `raw.focus()`: the fork fires the
   * plugin's onFocus synchronously, so a nested mount must be able to take a
   * HIGHER z than this node (matching its later physical mount) instead of
   * being overtaken when this call returns.
   */
  private focusPhysical(node: ManagedOverlayNode, options?: { preserveOrder?: boolean }): void {
    if (node.raw === undefined) return
    if (options?.preserveOrder !== true) node.zOrder = ++this.zSequence
    node.raw.focus(options)
  }

  /** The frontmost visible node that asked for the keyboard (`resumeFocus`).
   * `nonCapturing` is only a MOUNT policy (I4) and does not veto it. */
  private frontmostFocusable(nodes: readonly ManagedOverlayNode[]): ManagedOverlayNode | undefined {
    return nodes
      .filter(node =>
        !node.closed && node.raw !== undefined && !node.explicitHidden && node.resumeFocus && this.isVisible(node))
      .sort((a, b) => b.zOrder - a.zOrder)[0]
  }

  /**
   * Move the keyboard to the Broker's logical next owner BEFORE an operation
   * makes the current owner lose physical focus. The fork's own hide/unfocus
   * fallback picks the topmost VISIBLE capturing overlay and knows nothing
   * about `resumeFocus`, so it would re-activate a deliberately blurred
   * sibling. Only acts when `releasing` (or any node, when omitted) currently
   * owns the keyboard.
   */
  private releaseKeyboard(releasing?: ManagedOverlayNode): void {
    const current = this.currentlyFocused()
    if (current === undefined) return
    if (releasing !== undefined && current !== releasing) return
    const next = this.frontmostFocusable([...this.roots].filter(node => node !== releasing))
    if (next !== undefined) {
      if (next.raw?.isFocused() !== true) this.focusPhysical(next, { preserveOrder: true })
      return
    }
    this.deps.focusSeatOwner?.()
  }

  private currentlyFocused(): ManagedOverlayNode | undefined {
    for (const node of this.nodes.values()) {
      if (!node.closed && node.raw?.isFocused() === true) return node
    }
    return undefined
  }

  /** Remove a node from its current suppressor without revealing it: an
   * explicit show()/focus() takes ownership away from the suppressor so the
   * graph can never hold two owners for one node (I1/I2). */
  private detach(node: ManagedOverlayNode): void {
    if (node.parent !== undefined) {
      const index = node.parent.children.indexOf(node)
      if (index !== -1) node.parent.children.splice(index, 1)
      node.parent = undefined
      this.roots.add(node)
    }
    this.deps.question?.()?.suspendedOverlays.delete(node.wrapper)
    this.deps.saveLocation?.()?.suspendedOverlays.delete(node.wrapper)
  }

  /**
   * INTERNAL restore of a set of nodes (back → front) after a suppression
   * (a Question / Save Location settle). This is NOT an explicit user
   * show/focus: it reproduces the pre-suppression visibility, stacking and
   * keyboard ownership — no z promotion and NO implicit focus transition —
   * then focuses exactly ONE owner (see the fork's X056 seam).
   *
   * `keepFocus` is a SURVIVING overlay that held the keyboard before the
   * change: when present it must keep it, whatever the revealed nodes' own
   * intents are. Otherwise the frontmost node that asked for focus reclaims
   * the keyboard; if none did, the CURRENT seat owner does.
   */
  private reveal(nodes: readonly ManagedOverlayNode[], keepFocus?: ManagedOverlayNode): void {
    const ordered = [...nodes].sort((a, b) => a.zOrder - b.zOrder)
    const restore = { preserveOrder: true, preserveFocus: true } as const
    for (const node of ordered) {
      if (node.closed || node.explicitHidden || node.raw === undefined) continue
      this.showPhysical(node, restore)
    }
    const owner = keepFocus !== undefined && !keepFocus.closed && keepFocus.raw !== undefined && this.isVisible(keepFocus)
      ? keepFocus
      : this.frontmostFocusable(ordered)
    if (owner !== undefined) {
      if (owner.raw?.isFocused() !== true) this.focusPhysical(owner, { preserveOrder: true })
    } else if (this.activeSuspension() === undefined) {
      // NONE of the restored nodes asked for the keyboard (they were
      // blurred/nonCapturing): the CURRENT seat owner must own it again
      // (never the stale preFocus snapshot). An active Question / Save
      // Location frame keeps the seat.
      this.deps.focusSeatOwner?.()
    }
    this.deps.reconcileFocusSeat?.()
  }
}
