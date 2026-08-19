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
import { CommandBridge } from '../command-bridge.ts'
import { ThemeRegistry } from '../theme-registry.ts'
import { AutocompleteRegistry } from '../autocomplete-registry.ts'
import { SettingsRegistry } from '../settings-registry.ts'
import { KeybindingRegistry } from '../keybinding-registry.ts'
import type {
  AutocompleteHandle,
  AutocompleteProviderContribution,
  TuiAutocompleteRegistryView,
  TuiCommandBridgeView,
  TuiCommandContribution,
  TuiCommandHandle,
  TuiKeybindingContribution,
  TuiKeybindingHandle,
  TuiKeybindingRegistryView,
  TuiSettingContribution,
  TuiSettingHandle,
  TuiSettingsRegistryView,
  TuiThemeContribution,
  TuiThemeHandle,
  TuiThemeRegistryView,
} from './public-types.ts'

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
  /**
   * Register a TUI command contribution (M5): execution ownership metadata
   * over an existing command. The bridge does NOT execute — actual
   * execution stays in the commands service. Owned by the calling fiber.
   * @param contribution - the command contribution.
   */
  registerCommand(contribution: TuiCommandContribution): TuiCommandHandle
  /**
   * Register a named theme palette (M5): selectable from the host's theme
   * picker; owner unload removes it (a selected plugin theme falls back to
   * the built-in palette). Owned by the calling fiber.
   * @param contribution - the theme contribution.
   */
  registerTheme(contribution: TuiThemeContribution): TuiThemeHandle
  /**
   * Register an autocomplete provider (M5): consulted after the host's own
   * provider returns null, in registration order. Owned by the calling
   * fiber.
   * @param contribution - the provider contribution.
   */
  registerAutocomplete(contribution: AutocompleteProviderContribution): AutocompleteHandle
  /**
   * Register a settings row (M5): appended to the host's /settings panel.
   * Owned by the calling fiber.
   * @param contribution - the row contribution.
   */
  registerSetting(contribution: TuiSettingContribution): TuiSettingHandle
  /**
   * Register a keybinding (M5, metadata only): normalized key → semantic
   * action. Routing is Host-owned (the InputRouter lands in M6); until
   * then the binding is recorded and reported. Reserved host keys are
   * rejected. Owned by the calling fiber.
   * @param contribution - the binding contribution.
   */
  registerKeybinding(contribution: TuiKeybindingContribution): TuiKeybindingHandle
  /** M5 registries, exposed for the runner's dispatch/pickers (narrow
   * read-side views — the concrete classes are host-internal, so the
   * public declarations stay free of internal modules). */
  readonly commands: TuiCommandBridgeView
  readonly themes: TuiThemeRegistryView
  readonly autocomplete: TuiAutocompleteRegistryView
  readonly settings: TuiSettingsRegistryView
  readonly keybindings: TuiKeybindingRegistryView
}

/**
 * Concrete implementation bound to one surface host. The SurfaceHost (M2)
 * attaches a render sink; until then invalidations coalesce into a no-op
 * batch (nothing renders yet — M1 has no UI integration).
 */
export class PiTuiExtensionServiceImpl extends Service implements PiTuiExtensionService {
  /** Capabilities advertised from service-provide time (P0-1): the chrome
   * slots + widget slots work before any surface exists (registrations are
   * simply rendered once the surface attaches). */
  static readonly ADVERTISED_CAPABILITIES: readonly PiTuiCapability[] = [
    'slot.chrome.header.badge',
    'slot.input.dock.item',
    'slot.chrome.footer.status',
    'slot.input.widget',
  ]

  private readonly ledger: ExtensionLedger
  private readonly batcher: InvalidateBatcher
  private readonly hostVersion: string
  /** M5 registries (command/themes/autocomplete/settings/keybindings).
   * Provided by the host; the runner wires them into dispatch/pickers. */
  readonly commands: CommandBridge
  readonly themes: ThemeRegistry
  readonly autocomplete: AutocompleteRegistry
  readonly settings: SettingsRegistry
  readonly keybindings: KeybindingRegistry
  /** The attached SurfaceHost's state bridge, wired by the runner (M3). */
  private stateBridge: {
    subscribe(listener: (state: SurfaceStateValues) => void): () => void
  } | undefined
  /** The CURRENT attachment's surface id (P1: generation-scoped isolation).
   * A stale detachSurface from an OLD generation (different id) is a
   * no-op — it must never tear down a NEWER surface's bridge. */
  private attachedSurfaceId: string | undefined
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
    this.commands = new CommandBridge(() => this.batcher.invalidate())
    this.themes = new ThemeRegistry(() => this.batcher.invalidate())
    this.autocomplete = new AutocompleteRegistry(() => this.batcher.invalidate())
    this.settings = new SettingsRegistry(() => this.batcher.invalidate())
    this.keybindings = new KeybindingRegistry(() => this.batcher.invalidate())
  }

  api(): PiTuiApiInfo {
    // ADVERTISED vs LIVE capabilities (P0-1): the three slot capabilities
    // are advertised as soon as the service is provided, so a plugin can
    // feature-detect and register BEFORE any surface exists (the plan's
    // registration-before-surface contract — the README example checks the
    // slot capability before register()). `surface.snapshot` stays
    // attachment-gated: the snapshot contract only holds while a surface
    // is attached. The runner's attachSurface() adds the live set.
    return {
      apiVersion: 1,
      hostVersion: this.hostVersion,
      capabilities: new Set([...PiTuiExtensionServiceImpl.ADVERTISED_CAPABILITIES, ...this.liveCapabilities]),
    }
  }

  /** Subscribe to the live surface state (first-party builtins). Like
   * register(), the subscription is owned by the CALLING fiber: it is torn
   * down automatically when that fiber unloads (F1 — no listener leak on
   * HMR/unload).
   *
   * Two follow-up gates:
   * - ROLLBACK: the subscription is installed BEFORE the caller-fiber
   *   effect. When `fiber.effect()` throws INACTIVE_EFFECT (a stale service
   *   handle — the calling fiber already died), the just-installed
   *   subscription is released again, so a stale call can never leave a
   *   live listener or a listener-map entry behind (the register() rollback
   *   sibling).
   * - IDEMPOTENT RELEASE: the public disposer AND the fiber disposer share
   *   ONE `teardown` guarded by a `released` flag. The first release
   *   resolves the CURRENT map entry (attachSurface migration replaces the
   *   entry, so the map — not a captured closure — is the source of truth)
   *   and drops it; every later release — the fiber disposer after an
   *   explicit unsubscribe, or the explicit unsubscribe after an unload —
   *   is a no-op and can never re-enter bridgeUnsubscribeFor (which would
   *   transiently re-subscribe and synchronously re-invoke the listener).
   * - DUPLICATE REJECTION (round-4 finding): the listener map is keyed by
   *   the listener FUNCTION identity, so a second subscribeState() with the
   *   SAME listener would overwrite the first subscription's teardown and
   *   make the first one unreleasable. A duplicate listener is rejected
   *   loudly — a plugin must use distinct listener functions (or one
   *   subscription that fans out). */
  subscribeState(listener: (state: SurfaceStateValues) => void): () => void {
    const caller = this.ctx
    if (this.listenerUnsubscribers.has(listener)) {
      throw new Error(
        'piTuiExtensions.subscribeState(): this listener function is already subscribed — ' +
        'use a distinct listener per subscription (the listener map is keyed by function identity)',
      )
    }
    // The initial pending/bridge registration.
    this.bridgeUnsubscribeFor(listener)
    let released = false
    const teardown = (): void => {
      if (released) return
      released = true
      // Resolve the CURRENT teardown at release time: a pending listener
      // may have been upgraded to a live bridge subscription (or migrated
      // to a newer bridge) by attachSurface, so the map entry — not a
      // closure captured at subscribe time — is the source of truth.
      this.bridgeUnsubscribeFor(listener)()
    }
    // Fiber-bound teardown (same pattern as register()): unload runs the
    // disposer, so a stale listener never survives its owner. A failed
    // effect creation (inactive caller) ROLLS BACK the subscription.
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => teardown, 'piTuiExtensions.subscribeState()')
    } catch (error) {
      teardown()
      throw error
    }
    return () => {
      teardown()
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
   * set (called once per surface generation). `surfaceId` is the attachment
   * lease (P1): a later attach replaces the lease, and a stale
   * detachSurface from an OLD generation is a no-op for the NEW one.
   * Existing LIVE listeners migrate to the new bridge (their old bridge
   * belongs to a previous generation). */
  attachSurface(bridge: {
    subscribe(listener: (state: SurfaceStateValues) => void): () => void
  }, capabilities: ReadonlySet<PiTuiCapability>, surfaceId: string): void {
    this.attachedSurfaceId = surfaceId
    this.stateBridge = bridge
    this.liveCapabilities = new Set(capabilities)
    // Migrate every EXISTING live listener to the new bridge: without the
    // migration, a listener subscribed on a PREVIOUS generation's bridge
    // would keep delivering from the dead bridge after the swap (P1 — the
    // attach-A/attach-B sequence must leave B's listeners on B's bridge).
    // Per-listener isolation (round-3 finding 1): a throwing OLD-bridge
    // unsubscribe must not abort the migration AND must not leak the old
    // subscription — the map entry is dropped FIRST (so a later release
    // cannot re-enter), the old teardown runs best-effort, and the
    // listener is subscribed to the new bridge regardless.
    for (const [listener, unsubscribe] of [...this.listenerUnsubscribers]) {
      this.listenerUnsubscribers.delete(listener)
      try {
        unsubscribe()
      } catch {
        // Best effort: the old teardown failed. The map entry is already
        // gone, so a later release is a no-op rather than a re-subscribe;
        // the listener still migrates to the new bridge below.
      }
      const next = bridge.subscribe(listener)
      const release = (): void => {
        next()
        this.listenerUnsubscribers.delete(listener)
      }
      this.listenerUnsubscribers.set(listener, release)
    }
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

  /** Runner-only: detach the surface (final dispose). `surfaceId` is the
   * detaching generation's lease: a STALE detach (a different id than the
   * current attachment) is a no-op, so an old generation's cleanup can
   * never tear down a newer surface's bridge (P1). */
  detachSurface(surfaceId?: string): void {
    // The generation-scoped lease (P1): a stale detach from an OLD surface
    // generation must not tear down the NEWER generation's bridge — the
    // runner's cleanup only detaches the generation it owns.
    if (surfaceId !== undefined && this.attachedSurfaceId !== undefined
      && surfaceId !== this.attachedSurfaceId) {
      return
    }
    this.attachedSurfaceId = undefined
    this.stateBridge = undefined
    this.liveCapabilities.clear()
    // Every live listener subscription dies with the surface: their
    // teardown falls back to a no-op (the bridge is gone; the fiber
    // disposer is idempotent). Per-listener isolation (round-3 finding 1):
    // a throwing unsubscribe must not abort the loop — the map entry is
    // dropped FIRST so no listener is left registered after the surface is
    // gone.
    for (const [listener, unsubscribe] of [...this.listenerUnsubscribers]) {
      this.listenerUnsubscribers.delete(listener)
      try {
        unsubscribe()
      } catch {
        // Best effort: the old teardown failed; the map entry is already
        // gone so a later release is a no-op.
      }
    }
  }

  register<T>(slot: string, spec: RegistrationSpec, contribution: T): RegistrationHandle<T> {
    if (!isSlotName(slot)) {
      throw new Error(
        `unknown extension slot "${slot}" (known: ${['chrome.header.badge', 'input.dock.item', 'chrome.footer.status', 'input.widget.above', 'input.widget.below'].join(', ')})`,
      )
    }
    // Generation-lease design (round-3 review finding 3, deliberately NOT
    // changed): a registration is bound to the CALLER's fiber, not to the
    // current surface attachment. A stale service handle's register() is
    // rejected by the fiber check below (INACTIVE_EFFECT), so the only
    // "stale surface" registration path is a LIVE fiber registering after
    // a surface swap — and that is a NEW registration belonging to the
    // NEW generation by construction (the ledger stamps the current
    // attachmentGeneration). Freezing old-generation HANDLES covers the
    // old surface's existing contributions; a live fiber's fresh
    // registration is intentionally current-generation.
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

  /**
   * Register a command contribution (M5). Fiber-bound: the calling
   * fiber's unload disposes the contribution. A name conflict returns an
   * outcome (never a silent override); a stale fiber (INACTIVE_EFFECT)
   * rolls the registration back.
   */
  registerCommand(contribution: TuiCommandContribution): TuiCommandHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const outcome = this.commands.register(contribution, owner)
    if (outcome.kind === 'conflict') {
      const detail = outcome.nearSynonym === undefined
        ? `owner "${outcome.existingOwner}" already holds it`
        : `a near-synonym of "${contribution.name}" (${outcome.nearSynonym}, owned by "${outcome.existingOwner}") — the AGENTS near-synonym rule forbids the ambiguity`
      throw new Error(`command contribution "${contribution.name}" conflicts: ${detail} — resolve the conflict before registering`)
    }
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        outcome.handle.dispose()
      }, 'piTuiExtensions.registerCommand()')
    } catch (error) {
      outcome.handle.dispose()
      throw error
    }
    return {
      id: outcome.handle.id,
      dispose: () => {
        outcome.handle.dispose()
        dispose()
      },
    }
  }

  /**
   * Register a theme (M5). Fiber-bound; owner unload removes the theme
   * (a selected plugin theme falls back to the built-in palette).
   */
  registerTheme(contribution: TuiThemeContribution): TuiThemeHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.themes.register(contribution, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.registerTheme()')
    } catch (error) {
      handle.dispose()
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        dispose()
      },
    }
  }

  /**
   * Register an autocomplete provider (M5). Fiber-bound; owner unload
   * removes the provider from the suggestion chain.
   */
  registerAutocomplete(contribution: AutocompleteProviderContribution): AutocompleteHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.autocomplete.register(contribution, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.registerAutocomplete()')
    } catch (error) {
      handle.dispose()
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        dispose()
      },
    }
  }

  /**
   * Register a settings row (M5). Fiber-bound; owner unload removes the
   * row from the /settings panel.
   */
  registerSetting(contribution: TuiSettingContribution): TuiSettingHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.settings.register(contribution, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.registerSetting()')
    } catch (error) {
      handle.dispose()
      throw error
    }
    return {
      id: handle.id,
      setValue: (value: string) => handle.setValue(value),
      dispose: () => {
        handle.dispose()
        dispose()
      },
    }
  }

  /**
   * Register a keybinding (M5, metadata only — routing lands in M6).
   * Fiber-bound; owner unload removes the binding. Reserved host keys are
   * rejected.
   */
  registerKeybinding(contribution: TuiKeybindingContribution): TuiKeybindingHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.keybindings.register(contribution, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.registerKeybinding()')
    } catch (error) {
      handle.dispose()
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        dispose()
      },
    }
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
