/**
 * The PiTuiExtensionService: the Cordis service third-party plugins inject
 * to register contributions. Provided by the `pi-tui-extension-host` row
 * (src/extensions.ts); owned by that provider's fiber, so provider unload
 * disposes every registration made through it.
 *
 * Owner binding (M1, plan §16): every registration is created inside the
 * CALLER's own `ctx.effect()` (the fiber that read the service). Cordis runs
 * that disposer when the caller's fiber unloads (HMR, plugin disable), so
 * owner-scoped cleanup is exact: unload plugin B removes only B's
 * contributions, and provider restart collapses dependents without manual
 * bookkeeping. Load order never decides conflicts — the ledger's rules do.
 *
 * The caller ctx is available through Cordis's Service tracing: a service
 * method's `this.ctx` is bound to the context that READ the service (the
 * getTraceable tracker, `property: 'ctx'`), so `this.ctx.fiber` inside
 * register() IS the calling plugin's fiber — the same mechanism the skill
 * registry's `layers.effect(ctx, ...)` relies on.
 * @module @xmoon76/dsh-pi-tui/extension/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { ExtensionLedger } from './internal/ledger.ts'
import { InvalidateBatcher } from './internal/batcher.ts'
import { isSlotName, slotSemantic } from './slot-map.ts'
import type { PiTuiApiInfo, PiTuiCapability, PiTuiSlotName, RegistrationHandle, RegistrationSpec, SurfaceStateValues } from './public-types.ts'

/** The service name plugins inject (`piTuiExtensions` in cordis.patch.yml). */
export const PI_TUI_EXTENSIONS_SERVICE = 'piTuiExtensions'

/** The public service surface plugins consume. */
export interface PiTuiExtensionService {
  /** Host identity: version + capability set (feature-detect, never parse versions). */
  readonly api: () => PiTuiApiInfo
  /**
   * Register one contribution under a slot. The registration is owned by the
   * CALLING fiber: it is disposed automatically when that fiber unloads.
   * @param slot - one of the known slot names.
   * @param spec - registration identity + ordering metadata.
   * @param contribution - the contribution value (typed per slot contract).
   */
  register<T>(slot: string, spec: RegistrationSpec, contribution: T): RegistrationHandle<T>
  /** The semantic of one slot ('list' | 'single'), or undefined when unknown. */
  slotSemantics(slot: string): string | undefined
  /**
   * Subscribe to the live surface state snapshots (first-party builtins and
   * state-driven contributions). Fires once synchronously with the current
   * state, then on every change (batched). Returns a disposer.
   * @param listener - receives the immutable snapshot values.
   */
  subscribeState(listener: (state: SurfaceStateValues) => void): () => void
}

/**
 * Concrete implementation bound to one surface host. The SurfaceHost (M2)
 * attaches a render sink; until then invalidations coalesce into a no-op
 * batch (nothing renders yet — M1 has no UI integration).
 */
export class PiTuiExtensionServiceImpl extends Service implements PiTuiExtensionService {
  private readonly ledger: ExtensionLedger
  private readonly batcher: InvalidateBatcher
  private readonly hostVersion: string
  /** The attached SurfaceHost's state bridge, wired by the runner (M3). */
  private stateBridge: {
    subscribe(listener: (state: SurfaceStateValues) => void): () => void
  } | undefined
  /** The capability set reported while a surface is attached (F-10). */
  private liveCapabilities = new Set<PiTuiCapability>()
  /** State listeners registered before any surface attached (builtins that
   * register during boot); delivered on attachSurface. */
  private readonly pendingStateListeners = new Set<(state: SurfaceStateValues) => void>()
  /** Listener → current teardown (pending removal or live bridge
   * subscription). Kept so a pending listener upgraded by attachSurface
   * releases the LIVE subscription on unload (F1). */
  private readonly listenerUnsubscribers = new Map<(state: SurfaceStateValues) => void, () => void>()

  constructor(ctx: Context, hostVersion: string, requestRender: () => void) {
    super(ctx, PI_TUI_EXTENSIONS_SERVICE)
    this.hostVersion = hostVersion
    this.batcher = new InvalidateBatcher({ requestRender })
    this.ledger = new ExtensionLedger(() => this.batcher.invalidate())
  }

  api(): PiTuiApiInfo {
    // The capability set is LIVE: populated when the SurfaceHost attaches
    // (F-10), empty before/after. Plugins must feature-detect.
    return {
      apiVersion: 1,
      hostVersion: this.hostVersion,
      capabilities: new Set(this.liveCapabilities),
    }
  }

  /** Subscribe to the live surface state (first-party builtins). Like
   * register(), the subscription is owned by the CALLING fiber: it is torn
   * down automatically when that fiber unloads (F1 — no listener leak on
   * HMR/unload). */
  subscribeState(listener: (state: SurfaceStateValues) => void): () => void {
    const caller = this.ctx
    // Re-resolve the teardown at call time: a pending listener may have
    // been upgraded to a live bridge subscription by attachSurface.
    const release = (): void => {
      this.bridgeUnsubscribeFor(listener)()
    }
    // The initial pending/bridge registration.
    this.bridgeUnsubscribeFor(listener)
    // Fiber-bound teardown (same pattern as register()): unload runs the
    // disposer, so a stale listener never survives its owner.
    const dispose = caller.fiber.effect(() => () => {
      release()
    }, 'piTuiExtensions.subscribeState()')
    return () => {
      release()
      dispose()
    }
  }

  /** The current teardown for one listener: the live bridge subscription
   * when one exists, else the pending-list removal. Idempotent: the first
   * invocation releases the subscription AND drops the map entry, so a
   * second release (fiber disposer after an explicit unsubscribe) is a
   * no-op. */
  private bridgeUnsubscribeFor(listener: (state: SurfaceStateValues) => void): () => void {
    const existing = this.listenerUnsubscribers.get(listener)
    if (existing !== undefined) return existing
    const bridge = this.stateBridge
    if (bridge === undefined) {
      this.pendingStateListeners.add(listener)
      const unsubscribe = (): void => {
        this.pendingStateListeners.delete(listener)
        this.listenerUnsubscribers.delete(listener)
      }
      this.listenerUnsubscribers.set(listener, unsubscribe)
      return unsubscribe
    }
    const unsubscribe = bridge.subscribe(listener)
    const release = (): void => {
      // Idempotence guard (round-3 P3): once released, the map entry is
      // gone; a second release must NOT re-enter bridgeUnsubscribeFor
      // (which would transiently re-subscribe). The has() check makes the
      // "idempotent release" contract exactly true.
      if (!this.listenerUnsubscribers.has(listener)) return
      unsubscribe()
      this.listenerUnsubscribers.delete(listener)
    }
    this.listenerUnsubscribers.set(listener, release)
    return release
  }

  /** Runner-only: attach the live surface host's state bridge and capability
   * set (called once per surface generation). */
  attachSurface(bridge: {
    subscribe(listener: (state: SurfaceStateValues) => void): () => void
  }, capabilities: ReadonlySet<PiTuiCapability>): void {
    this.stateBridge = bridge
    this.liveCapabilities = new Set(capabilities)
    // Upgrade every pending listener to a live bridge subscription; the
    // listener's teardown now unsubscribes from the BRIDGE (not just the
    // pending set) — F1: an unload after attach must release the live
    // subscription. The stored teardown is the SAME map-deleting wrapper
    // shape the direct path uses, so upgrade + unload + second release is
    // idempotent and never leaks the map entry (round-2 finding 1).
    for (const listener of [...this.pendingStateListeners]) {
      this.listenerUnsubscribers.delete(listener) // drop the pending-removal entry
      const unsubscribe = bridge.subscribe(listener)
      const release = (): void => {
        unsubscribe()
        this.listenerUnsubscribers.delete(listener)
      }
      this.listenerUnsubscribers.set(listener, release)
    }
    this.pendingStateListeners.clear()
  }

  /** Runner-only: detach the surface (final dispose). */
  detachSurface(): void {
    this.stateBridge = undefined
    this.liveCapabilities.clear()
    // Every live listener subscription dies with the surface: their
    // teardown falls back to a no-op (the bridge is gone; the fiber
    // disposer is idempotent).
    for (const [listener, unsubscribe] of [...this.listenerUnsubscribers]) {
      unsubscribe()
      this.listenerUnsubscribers.delete(listener)
    }
  }

  register<T>(slot: string, spec: RegistrationSpec, contribution: T): RegistrationHandle<T> {
    if (!isSlotName(slot)) {
      throw new Error(
        `unknown extension slot "${slot}" (known: ${['chrome.header.badge', 'input.dock.item', 'chrome.footer.status'].join(', ')})`,
      )
    }
    // `this.ctx` is the CALLER's context (Cordis Service tracing); its fiber
    // owns this registration's lifetime. The ledger keys ownership by the
    // fiber UID (unique per fiber — anonymous sibling plugins share the
    // inherited display name 'root', so the NAME would conflate them); the
    // display name rides along for diagnostics. The fiber-bound effect
    // disposer performs the cleanup on unload. `this.ctx.fiber.effect()`
    // throws INACTIVE_EFFECT when the caller fiber is already disposed —
    // the registration must then be rolled back so the (slot, id) pair is
    // not blocked by a ghost.
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.ledger.register<T>(slot, spec, contribution, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.register()')
    } catch (error) {
      handle.dispose()
      throw error
    }
    return {
      id: handle.id,
      invalidate: () => handle.invalidate(),
      replace: (next: T) => handle.replace(next),
      // Idempotent AND fiber-bound: an explicit dispose() disposes the
      // contribution immediately; the fiber disposer then no-ops.
      dispose: () => {
        handle.dispose()
        dispose()
      },
    }
  }

  slotSemantics(slot: string): string | undefined {
    if (!isSlotName(slot)) return undefined
    return slotSemantic(slot)
  }

  /** The ledger behind the service (SurfaceHost access in M2). */
  _ledger(): ExtensionLedger {
    return this.ledger
  }

  /** Test hook: the number of live listener subscriptions (F1/F5 — an
   * owner unload must leave this at 0). */
  _listenerUnsubscribersSize(): number {
    return this.listenerUnsubscribers.size
  }
}
