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
      zOrder: 0,
      closed: false,
    }
    node.wrapper = this.wrap(node)
    return { node, suppress }
  }

  /**
   * Phase 2 of a mount: bind the freshly mounted raw handle and apply the
   * stacking rules. Called AFTER the host mounts the component on the active
   * screen (the fork has already focused it when capturing).
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
      // hidden), so it must join `roots` — resumeSuspendedRoots() reveals it
      // without re-registering, and a later capturing mount must suppress it.
      node.resumeFocus = !node.nonCapturing
      raw.setHidden(true)
      this.roots.add(node)
      suspension.suspendedOverlays.add(node.wrapper)
      return node.wrapper
    }
    if (node.nonCapturing) {
      // Mount policy: no auto-focus and no suppression of siblings.
      this.roots.add(node)
      return node.wrapper
    }
    // Capturing: adopt the prepared VISIBLE ROOTS as this node's children
    // (only roots — never every visible handle, which would allow a node to
    // acquire a second suppressor).
    for (const entry of prepared.suppress) {
      const child = entry.node
      this.roots.delete(child)
      child.parent = node
      child.resumeFocus = entry.resumeFocus
      child.raw?.setHidden(true)
      node.children.push(child)
    }
    this.roots.add(node)
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
      node.raw?.setHidden(true)
      this.deps.reconcileFocusSeat?.()
      return
    }
    // An explicit show is a SUPPRESSION OVERRIDE (I2): detach from the current
    // suppressor before revealing, so the graph stays a forest.
    this.detach(node)
    node.explicitHidden = false
    this.showPhysical(node)
    node.resumeFocus = node.raw?.isFocused() === true
    this.deps.reconcileFocusSeat?.()
  }

  /** Explicit focus request (including for a nonCapturing node): detaches any
   * suppressor, reveals and promotes the node to the keyboard owner. */
  focus(handle: OverlayHandle): void {
    const node = this.nodes.get(handle)
    if (node === undefined || node.closed) return
    this.detach(node)
    node.explicitHidden = false
    this.showPhysical(node)
    this.focusPhysical(node)
    node.resumeFocus = true
    this.deps.reconcileFocusSeat?.()
  }

  /** Release focus (the public `blur()`): the intent is stored on the node,
   * so it survives a suppression / fullscreen round-trip. */
  unfocus(handle: OverlayHandle, options?: Parameters<OverlayHandle['unfocus']>[0]): void {
    const node = this.nodes.get(handle)
    if (node === undefined || node.closed) return
    node.resumeFocus = false
    node.raw?.unfocus(options)
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
    node.raw?.hide()
    node.raw = undefined
    const revealed = children.filter(child => child.parent === undefined && !this.isSuppressed(child))
    if (revealed.length > 0) {
      const keepFocus = priorFocus !== undefined && priorFocus !== node && !priorFocus.closed
        && priorFocus.raw !== undefined && this.isVisible(priorFocus)
        ? priorFocus
        : undefined
      this.reveal(revealed, keepFocus)
    } else if (this.activeSuspension() === undefined && this.currentlyFocused() === undefined) {
      // An active Question / Save Location owns the seat through its editor-seat
      // frame (not a managed node): the fallback must not steal its physical
      // focus when a directly suspended overlay closes (Case B).
      this.deps.focusSeatOwner?.()
    }
    this.deps.reconcileFocusSeat?.()
  }

  /** Directly suspend every visible logical ROOT under the given modal (the
   * Question / Save Location primitive). Child topology is never copied. */
  suspendVisibleRoots(suspension: QuestionSuspension | SaveLocationSuspension): void {
    for (const node of [...this.roots]) {
      if (node.closed || !this.isVisible(node) || node.explicitHidden) continue
      node.resumeFocus = node.raw?.isFocused() === true
      node.raw?.setHidden(true)
      suspension.suspendedOverlays.add(node.wrapper)
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
    suspension.suspendedOverlays.clear()
    this.reveal(restored)
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
    this.swapFocusOwner = this.currentlyFocused()
    for (const node of [...this.nodes.values()]) {
      if (node.remountable) {
        // Remove the old projection from the OLD screen without disposing the
        // retained component (remountable overlays opt out of disposeOnHide);
        // the host re-creates it after the swap.
        node.raw?.hide()
        node.raw = undefined
        continue
      }
      this.close(node.wrapper)
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
      if (owner.raw.isFocused() !== true) this.focusPhysical(owner)
    } else {
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

  /** Assert the forest invariants (tests only): one parent per node, no
   * cycles, no closed node in the graph. */
  assertForest(): void {
    const seen = new Set<number>()
    for (const node of this.nodes.values()) {
      if (node.closed) throw new Error(`closed node ${node.id} is still in the graph`)
      if (seen.has(node.id)) throw new Error(`node ${node.id} has multiple parents`)
      seen.add(node.id)
      let current: ManagedOverlayNode | undefined = node
      const chain = new Set<number>()
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

  /** Show a node's physical projection, mirroring the fork's visual-order
   * mutation: showing a hidden CAPTURING overlay auto-focuses it and promotes
   * its focus order, so the logical z must follow. A nonCapturing show is a
   * pure visibility change. */
  private showPhysical(node: ManagedOverlayNode): void {
    if (node.raw === undefined) return
    const wasHidden = node.raw.isHidden() === true
    node.raw.setHidden(false)
    if (wasHidden && !node.nonCapturing) node.zOrder = ++this.zSequence
  }

  /** Focus a node's physical projection. The fork's focus() promotes the
   * overlay to the visual front, so the logical z must follow. */
  private focusPhysical(node: ManagedOverlayNode): void {
    if (node.raw === undefined) return
    node.raw.focus()
    node.zOrder = ++this.zSequence
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
   * Reveal a set of nodes (back → front). `keepFocus` is a SURVIVING overlay
   * that held the keyboard before the change: when present it must keep the
   * keyboard (and the logical front), whatever the revealed children's own
   * intents are. Otherwise the frontmost node that asked for focus reclaims
   * the keyboard; if none did, the CURRENT seat owner does.
   */
  private reveal(nodes: readonly ManagedOverlayNode[], keepFocus?: ManagedOverlayNode): void {
    const ordered = [...nodes].sort((a, b) => a.zOrder - b.zOrder)
    let promotedCapturing = false
    for (const node of ordered) {
      if (node.closed || node.explicitHidden || node.raw === undefined) continue
      const wasHidden = node.raw.isHidden() === true
      this.showPhysical(node)
      if (wasHidden && !node.nonCapturing) promotedCapturing = true
    }
    if (keepFocus !== undefined && !keepFocus.closed && keepFocus.raw !== undefined && this.isVisible(keepFocus)) {
      // A revealed capturing child auto-focused itself and promoted its visual
      // order; restoring the surviving owner also restores its logical z.
      if (promotedCapturing || keepFocus.raw.isFocused() !== true) this.focusPhysical(keepFocus)
      this.deps.reconcileFocusSeat?.()
      return
    }
    const candidates = ordered.filter(node =>
      !node.closed && node.raw !== undefined && !node.explicitHidden && this.isVisible(node))
    // `nonCapturing` is only a MOUNT policy (I4): it must NOT veto an explicit
    // focus() intent that was saved on the node, or a focus-capable lease that
    // focused a notice would silently lose the keyboard on reveal.
    const focusTarget = candidates
      .filter(node => node.resumeFocus)
      .sort((a, b) => b.zOrder - a.zOrder)[0]
    if (focusTarget !== undefined) {
      this.focusPhysical(focusTarget)
    } else if (this.activeSuspension() === undefined) {
      // The fork auto-focused the last revealed capturing node, but NONE of
      // them asked for the keyboard (they were blurred/nonCapturing): the
      // CURRENT seat owner must own it again (never the stale preFocus
      // snapshot). An active Question / Save Location frame keeps the seat.
      this.deps.focusSeatOwner?.()
    }
    this.deps.reconcileFocusSeat?.()
  }
}
