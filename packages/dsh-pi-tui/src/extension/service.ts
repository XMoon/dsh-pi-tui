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
import { RendererRegistry } from '../renderer-registry.ts'
import { EditorRegistry } from '../editor-registry.ts'
import type {
  AutocompleteHandle,
  EditorContribution,
  EditorHandle,
  ExtensionView,
  AutocompleteProviderContribution,
  MessagePresentationSnapshot,
  ToolPresentationSnapshot,
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
  TuiMessageRendererContribution,
  TuiOverlayHandle,
  TuiOverlayOptions,
  TuiRendererHandle,
  TuiRendererRegistryView,
  TuiThemeContribution,
  TuiThemeHandle,
  TuiThemeRegistryView,
  TuiToolRendererContribution,
} from './public-types.ts'

function safeHealthMessage(error: unknown): string {
  let text: string
  try {
    text = error instanceof Error ? error.message : String(error)
  } catch {
    text = 'unknown error'
  }
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

/** An inert overlay lease: no surface is mounted (registration-before-
 * surface, or the seam was detached). Every method is a safe no-op. */
function inertOverlayLease(): import('./public-types.ts').TuiOverlayHandle {
  return { close: () => {}, hide: () => {}, show: () => {} }
}

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
  /**
   * Register a transcript MESSAGE renderer (M7, chain slot): receives a
   * semantic snapshot; returns an ExtensionView or undefined (abdicate →
   * next renderer → host fallback). A throwing renderer is isolated.
   * Owned by the calling fiber.
   */
  registerMessageRenderer(contribution: TuiMessageRendererContribution): TuiRendererHandle
  /**
   * Register a TOOL renderer (M7, keyed slot): presents the tool card for
   * ONE tool name; undefined abdicates. Priority ties on the same tool
   * name are an explicit error. Owned by the calling fiber.
   */
  registerToolRenderer(contribution: TuiToolRendererContribution): TuiRendererHandle
  /**
   * Open a MANAGED OVERLAY (M8, plan §13.3): the plugin supplies an
   * ExtensionView + sizing hints; the host mounts it through its overlay
   * broker (modal stacking, focus, fullscreen migration, teardown). The
   * returned lease is generation-scoped (a stale surface's lease closes
   * with the surface) and its close() is idempotent. The overlay content
   * is the M4 component kit — a plugin can never mount a raw component
   * or steal focus.
   * @param view - the ExtensionView to present.
   * @param options - sizing/positioning hints.
   * @returns the overlay lease.
   */
  showOverlay(view: ExtensionView, options?: TuiOverlayOptions): TuiOverlayHandle
  /** M5 registries, exposed for the runner's dispatch/pickers (narrow
   * read-side views — the concrete classes are host-internal, so the
   * public declarations stay free of internal modules). */
  readonly commands: TuiCommandBridgeView
  readonly themes: TuiThemeRegistryView
  readonly autocomplete: TuiAutocompleteRegistryView
  readonly settings: TuiSettingsRegistryView
  readonly keybindings: TuiKeybindingRegistryView
  /** M7: the transcript/tool renderer registry (the runner wires it into
   * the surface's message cache; the narrow read-side view keeps the
   * public declarations free of internal modules). */
  readonly renderers: TuiRendererRegistryView
  /** Runner-only: wire the host's managed-overlay mount seam (M8). The
   * seam is SURFACE-scoped (P1-4): it binds to the CURRENT attachment's
   * surfaceId — a later attach replaces it, and a stale old-generation
   * detach never unbinds a newer surface's seam (the detachSurface lease). */
  setOverlayMount(surfaceId: string, mount: (view: ExtensionView, options?: TuiOverlayOptions) => TuiOverlayHandle): void
  /**
   * Register an EDITOR contribution (M9, plan §14): single-winner by
   * priority; a tie is an explicit error. The winner occupies the editor
   * seat through the host's atomic handoff; the host default editor is
   * the fallback (never a competing registration). Creation is atomic —
   * a throw keeps the current editor working. Owned by the calling fiber.
   */
  registerEditor(contribution: EditorContribution): EditorHandle
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
  /**
   * P1-1: the CURRENT surface's render sink (attached by the runner once
   * per surface generation). Registry invalidations (ledger, commands,
   * themes, autocomplete, settings, keybindings, renderers, editors) all
   * flush through THIS sink — never a no-op captured at construction. A
   * stale old-generation detach cannot tear down a newer surface's sink
   * (the surfaceId lease below).
   */
  private currentRenderSink: { surfaceId: string; requestRender(force?: boolean): void } | undefined
  /** M5 registries (command/themes/autocomplete/settings/keybindings).
   * Provided by the host; the runner wires them into dispatch/pickers. */
  readonly commands: CommandBridge
  readonly themes: ThemeRegistry
  readonly autocomplete: AutocompleteRegistry
  readonly settings: SettingsRegistry
  readonly keybindings: KeybindingRegistry
  /** M7: the transcript/tool renderer registry. */
  readonly renderers: RendererRegistry
  /** M8: the host's overlay mount seam (wired by the runner; the host
   * owns the screen + broker). SURFACE-scoped (P1-4): the seam is bound
   * per attachment through a surfaceId lease — detachSurface unbinds it,
   * and a stale old-generation detach never unbinds a NEWER surface's
   * seam. */
  private overlayMount: {
    surfaceId: string
    mount(view: ExtensionView, options?: TuiOverlayOptions): TuiOverlayHandle
  } | undefined
  /** M9: the editor registry (single-winner). */
  readonly editors: EditorRegistry
  /** Track health for one external registry contribution. */
  private trackRegistryHealth(slot: string, id: string, owner: string): void {
    this.ledger.trackHealth(slot, id, owner)
  }

  private untrackRegistryHealth(slot: string, id: string): void {
    this.ledger.untrackHealth(slot, id)
  }

  private recordRegistryError(slot: string, id: string, error: unknown): void {
    this.ledger.recordExternalError(slot, id, safeHealthMessage(error))
  }

  private clearRegistryError(slot: string, id: string): void {
    this.ledger.clearExternalError(slot, id)
  }

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
  /**
   * P1-3: state subscription RECORDS, keyed by the listener function
   * identity. A record's LIFETIME is caller-fiber-owned: it survives
   * surface detach/recreate and is deleted only by the caller fiber's
   * unload or an explicit release. The record's CURRENT BINDING is
   * surface-owned: `bridgeUnsubscribe` is present while the listener is
   * live on the attached bridge, and absent (pending) while no surface is
   * attached — attachSurface re-binds pending records, detachSurface
   * unbinds live ones without deleting the record.
   */
  private readonly stateSubscriptions = new Map<
    (state: SurfaceStateValues) => void,
    { bridgeUnsubscribe?: () => void }
  >()

  constructor(ctx: Context, hostVersion: string, requestRender: () => void, staticCommandCatalog?: ReadonlySet<string>) {
    super(ctx, PI_TUI_EXTENSIONS_SERVICE)
    this.hostVersion = hostVersion
    // P1-1: the batcher never captures a construction-time no-op — the
    // sink is INDIRECT (this.currentRenderSink), so a registry invalidation
    // always reaches the CURRENT surface's render path (or the no-op
    // fallback while no surface is attached). `attachSurface`/`detachSurface`
    // swap the sink; the batcher itself stays a pure coalescer.
    this.batcher = new InvalidateBatcher({
      requestRender: (force) => {
        const sink = this.currentRenderSink
        if (sink === undefined) return
        sink.requestRender(force)
      },
    })
    this.ledger = new ExtensionLedger(() => this.batcher.invalidate())
    // P1-04: the authoritative host command catalog (TUI commands +
    // LOCAL/SESSIONLESS ownership sets) rides into the bridge — a plugin
    // command can never shadow a built-in. Optional so tests can
    // construct a catalog-free bridge for dynamic-vs-dynamic rules only.
    this.commands = new CommandBridge(() => this.batcher.invalidate(), staticCommandCatalog)
    this.themes = new ThemeRegistry(() => this.batcher.invalidate())
    this.autocomplete = new AutocompleteRegistry(() => this.batcher.invalidate())
    this.settings = new SettingsRegistry(() => this.batcher.invalidate())
    this.keybindings = new KeybindingRegistry(() => this.batcher.invalidate())
    this.renderers = new RendererRegistry(() => this.batcher.invalidate())
    this.editors = new EditorRegistry(() => this.batcher.invalidate())
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
      // M11 deprecation policy (plan §16): currently nothing is
      // deprecated — the map stays empty. When a surface is deprecated,
      // its note lands here AND the capability/API is removed in API v2.
      deprecations: new Map(),
    }
  }

  /** Subscribe to the live surface state (first-party builtins). Like
   * register(), the subscription is owned by the CALLING fiber: it is torn
   * down automatically when that fiber unloads (F1 — no listener leak on
   * HMR/unload).
   *
   * P1-3 lifetime model: the RECORD (this map entry) is caller-owned and
   * survives surface detach/recreate — a detach only UNBINDS the bridge,
   * a later attach re-binds. The record is deleted only by the caller
   * fiber's unload or an explicit release.
   *
   * Follow-up gates kept from the previous implementation:
   * - ROLLBACK: the subscription is installed BEFORE the caller-fiber
   *   effect. When `fiber.effect()` throws INACTIVE_EFFECT (a stale service
   *   handle — the calling fiber already died), the just-installed
   *   subscription is released again, so a stale call can never leave a
   *   live listener or a map entry behind.
   * - IDEMPOTENT RELEASE: the public disposer AND the fiber disposer share
   *   ONE `teardown` guarded by a `released` flag. The first release
   *   resolves the CURRENT binding (attach/detach rebinding replaces the
   *   record's binding, so the map — not a captured closure — is the
   *   source of truth) and drops the record; every later release is a
   *   no-op and can never re-enter bindStateListener (which would
   *   transiently re-subscribe and synchronously re-invoke the listener).
   * - DUPLICATE REJECTION (round-4 finding): the listener map is keyed by
   *   the listener FUNCTION identity, so a second subscribeState() with the
   *   SAME listener would overwrite the first subscription's record and
   *   make the first one unreleasable. A duplicate listener is rejected
   *   loudly — a plugin must use distinct listener functions (or one
   *   subscription that fans out). */
  subscribeState(listener: (state: SurfaceStateValues) => void): () => void {
    const caller = this.ctx
    if (this.stateSubscriptions.has(listener)) {
      throw new Error(
        'piTuiExtensions.subscribeState(): this listener function is already subscribed — ' +
        'use a distinct listener per subscription (the listener map is keyed by function identity)',
      )
    }
    // The initial record: bound to the live bridge when one exists, else
    // pending (re-bound by the next attachSurface).
    this.bindStateListener(listener)
    let released = false
    const teardown = (): void => {
      if (released) return
      released = true
      // Resolve the CURRENT binding at release time: attach/detach may
      // have rebound the record, so the map entry — not a closure captured
      // at subscribe time — is the source of truth. The record is DELETED
      // (caller-owned lifetime ends with the owner fiber / explicit
      // release; P1-3).
      this.unbindStateListener(listener)
      this.stateSubscriptions.delete(listener)
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

  /** Bind one listener to the current bridge (or leave it pending).
   * Idempotent: an already-bound listener keeps its binding. */
  private bindStateListener(listener: (state: SurfaceStateValues) => void): void {
    const record = this.stateSubscriptions.get(listener)
    if (record !== undefined && record.bridgeUnsubscribe !== undefined) return
    const bridge = this.stateBridge
    if (bridge === undefined) {
      if (record === undefined) this.stateSubscriptions.set(listener, {})
      return
    }
    const unsubscribe = bridge.subscribe(listener)
    // The binding is the ONLY way the bridge subscription is released.
    // Callers (unbindStateListener / migrateStateListener / teardown)
    // detach the record's reference FIRST, so this runs at most once per
    // binding; the bridge unsubscribe itself is idempotent. No guard here
    // — a guard comparing `current.bridgeUnsubscribe !== binding` would
    // skip the unsubscribe after a caller cleared the reference, leaking
    // the live subscription (the P1-3 rebind leak).
    const binding = (): void => {
      unsubscribe()
    }
    if (record === undefined) {
      this.stateSubscriptions.set(listener, { bridgeUnsubscribe: binding })
    } else {
      record.bridgeUnsubscribe = binding
    }
  }

  /** Migrate one listener to the CURRENT bridge — used by attachSurface to
   * move a listener bound on a PREVIOUS generation's bridge to the NEW
   * bridge (attach-A/attach-B must leave B's listeners on B's bridge, P1).
   * Per-listener isolation: a throwing OLD-bridge unsubscribe must not
   * abort the migration AND must not leave the old subscription live —
   * the record's binding is dropped FIRST, the old teardown runs
   * best-effort, and the listener subscribes to the new bridge
   * regardless. */
  private migrateStateListener(listener: (state: SurfaceStateValues) => void): void {
    const record = this.stateSubscriptions.get(listener)
    if (record === undefined) return
    const oldBinding = record.bridgeUnsubscribe
    record.bridgeUnsubscribe = undefined
    if (oldBinding !== undefined) {
      try {
        oldBinding()
      } catch {
        // Best effort: the old teardown failed; the record is already
        // unbound so a later release is a no-op; the listener still
        // subscribes to the new bridge below.
      }
    }
    this.bindStateListener(listener)
  }

  /** Unbind one listener from the bridge WITHOUT deleting the record: the
   * record stays pending and is re-bound by the next attachSurface (P1-3).
   * When the record was already deleted (explicit release / owner unload),
   * this is a no-op. */
  private unbindStateListener(listener: (state: SurfaceStateValues) => void): void {
    const record = this.stateSubscriptions.get(listener)
    if (record === undefined) return
    const binding = record.bridgeUnsubscribe
    record.bridgeUnsubscribe = undefined
    if (binding !== undefined) {
      try {
        binding()
      } catch {
        // Best effort: the old teardown failed; the record is already
        // unbound so a later release is a no-op.
      }
    }
  }

  /** Runner-only: attach the live surface host's state bridge and capability
   * set (called once per surface generation). `surfaceId` is the attachment
   * lease (P1): a later attach replaces the lease, and a stale
   * detachSurface from an OLD generation is a no-op for the NEW one.
   * Every EXISTING subscription record re-binds to the new bridge (P1-3:
   * records survive surface recreation — detach only unbound them). */
  attachSurface(bridge: {
    subscribe(listener: (state: SurfaceStateValues) => void): () => void
  }, capabilities: ReadonlySet<PiTuiCapability>, surfaceId: string, requestRender?: (force?: boolean) => void): void {
    this.attachedSurfaceId = surfaceId
    this.stateBridge = bridge
    this.liveCapabilities = new Set(capabilities)
    // P1-1: bind the surface's render sink. Registry invalidations now
    // reach THIS surface's render path (the batcher flushes through the
    // indirect sink). A later attach replaces the sink; a stale
    // detachSurface from an OLD generation must not unbind the NEWER
    // surface's sink (the surfaceId lease below).
    this.currentRenderSink = requestRender === undefined
      ? undefined
      : { surfaceId, requestRender }
    // P1-3: re-bind every subscription record to the NEW bridge. Records
    // bound on a PREVIOUS generation's bridge MIGRATE (attach-A/attach-B
    // must leave B's listeners on B's bridge); pending records (subscribed
    // before any surface, or unbound by a detach) go live.
    for (const listener of [...this.stateSubscriptions.keys()]) {
      this.migrateStateListener(listener)
    }
  }

  /** Runner-only: detach the surface (final dispose). With no argument,
   * `detachSurface()` means the CURRENT attachment; an explicit `surfaceId`
   * is the detaching generation's lease. A STALE detach (a different id than
   * the current attachment) is a no-op, so an old generation's cleanup can
   * never tear down a newer surface's bridge (P1). */
  detachSurface(surfaceId?: string): void {
    // The unified detaching identity (P1): a no-arg detach means detach the
    // CURRENT generation — same lease as detach(currentSurfaceId), while a
    // stale-generation detach keeps its no-op for the NEWER surface.
    const detachingId = surfaceId ?? this.attachedSurfaceId

    // The generation-scoped lease (P1): a stale detach from an OLD surface
    // generation must not tear down the NEWER generation's bridge — the
    // runner's cleanup only detaches the generation it owns.
    if (detachingId !== undefined && this.attachedSurfaceId !== undefined
      && detachingId !== this.attachedSurfaceId) {
      return
    }
    this.attachedSurfaceId = undefined
    this.stateBridge = undefined
    this.liveCapabilities.clear()
    // P1-1: unbind the surface's render sink. The surfaceId lease makes a
    // stale old-generation detach a no-op (it never unbinds a NEWER
    // surface's sink).
    if (this.currentRenderSink !== undefined && this.currentRenderSink.surfaceId === detachingId) {
      this.currentRenderSink = undefined
    }
    // P1-4: unbind the overlay mount seam with the same lease — a stale
    // old-generation detach never unbinds a NEWER surface's seam, and the
    // service never mounts on a dead surface.
    if (this.overlayMount !== undefined && this.overlayMount.surfaceId === detachingId) {
      this.overlayMount = undefined
    }
    // P1-3: unbind every live bridge subscription — the RECORDS stay
    // (caller-fiber-owned); a later attachSurface re-binds them. A
    // throwing bridge unsubscribe must not abort the loop; the record is
    // unbound FIRST so no listener stays registered on the dead bridge.
    for (const listener of [...this.stateSubscriptions.keys()]) {
      this.unbindStateListener(listener)
    }
  }

  register<T>(slot: string, spec: RegistrationSpec, contribution: T): RegistrationHandle<T> {
    if (!isSlotName(slot)) {
      throw new Error(
        `unknown extension slot "${slot}" (known: ${['chrome.header.badge', 'input.dock.item', 'chrome.footer.status', 'input.widget.above', 'input.widget.below'].join(', ')})`,
      )
    }
    // P1-2 lifetime model: a registration is bound to the CALLER's fiber,
    // NEVER to the current surface attachment. A stale service handle's
    // register() is rejected by the fiber check below (INACTIVE_EFFECT);
    // a live fiber's registration survives surface dispose/recreate — the
    // ledger is the service-lifetime registry and the SurfaceHost merely
    // consumes it (a dispose stops consuming, never removes).
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
    this.trackRegistryHealth('command', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        outcome.handle.dispose()
        this.untrackRegistryHealth('command', contribution.id)
      }, 'piTuiExtensions.registerCommand()')
    } catch (error) {
      outcome.handle.dispose()
      this.untrackRegistryHealth('command', contribution.id)
      throw error
    }
    return {
      id: outcome.handle.id,
      dispose: () => {
        outcome.handle.dispose()
        this.untrackRegistryHealth('command', contribution.id)
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
    this.trackRegistryHealth('theme', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.untrackRegistryHealth('theme', contribution.id)
      }, 'piTuiExtensions.registerTheme()')
    } catch (error) {
      handle.dispose()
      this.untrackRegistryHealth('theme', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        this.untrackRegistryHealth('theme', contribution.id)
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
    this.trackRegistryHealth('autocomplete', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.untrackRegistryHealth('autocomplete', contribution.id)
      }, 'piTuiExtensions.registerAutocomplete()')
    } catch (error) {
      handle.dispose()
      this.untrackRegistryHealth('autocomplete', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        this.untrackRegistryHealth('autocomplete', contribution.id)
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
    this.trackRegistryHealth('setting', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.untrackRegistryHealth('setting', contribution.id)
      }, 'piTuiExtensions.registerSetting()')
    } catch (error) {
      handle.dispose()
      this.untrackRegistryHealth('setting', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      setValue: (value: string) => handle.setValue(value),
      dispose: () => {
        handle.dispose()
        this.untrackRegistryHealth('setting', contribution.id)
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
    this.trackRegistryHealth('keybinding', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.untrackRegistryHealth('keybinding', contribution.id)
      }, 'piTuiExtensions.registerKeybinding()')
    } catch (error) {
      handle.dispose()
      this.untrackRegistryHealth('keybinding', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        this.untrackRegistryHealth('keybinding', contribution.id)
        dispose()
      },
    }
  }

  /**
   * Register a message renderer (M7). Fiber-bound; owner unload removes
   * it and bumps the registry revision (the host's message cache
   * rebuilds the affected components — plan §12.1).
   */
  registerMessageRenderer(contribution: TuiMessageRendererContribution): TuiRendererHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.renderers.registerMessageRenderer(contribution, owner)
    // P1-08: the renderer registry is NOT the ledger — track its health
    // slot explicitly so /status can observe failed/recovered states.
    this.ledger.trackHealth('transcript.message.renderer', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.ledger.untrackHealth('transcript.message.renderer', contribution.id)
      }, 'piTuiExtensions.registerMessageRenderer()')
    } catch (error) {
      handle.dispose()
      this.ledger.untrackHealth('transcript.message.renderer', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        this.ledger.untrackHealth('transcript.message.renderer', contribution.id)
        dispose()
      },
    }
  }

  /**
   * Register a tool renderer (M7). Fiber-bound; owner unload removes it
   * and bumps the registry revision.
   */
  registerToolRenderer(contribution: TuiToolRendererContribution): TuiRendererHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.renderers.registerToolRenderer(contribution, owner)
    // P1-08: track the renderer's health slot (see registerMessageRenderer).
    this.ledger.trackHealth('transcript.tool.renderer', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.ledger.untrackHealth('transcript.tool.renderer', contribution.id)
      }, 'piTuiExtensions.registerToolRenderer()')
    } catch (error) {
      handle.dispose()
      this.ledger.untrackHealth('transcript.tool.renderer', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        this.ledger.untrackHealth('transcript.tool.renderer', contribution.id)
        dispose()
      },
    }
  }

  /** Runner-only: wire the host's overlay mount seam (M8). The seam is
   * SURFACE-scoped (P1-4): it binds to the CURRENT attachment's surfaceId
   * — a later attach replaces it, and a stale old-generation detach never
   * unbinds a newer surface's seam (the detachSurface lease). */
  setOverlayMount(surfaceId: string, mount: (view: ExtensionView, options?: TuiOverlayOptions) => TuiOverlayHandle): void {
    this.overlayMount = { surfaceId, mount }
  }

  /**
   * Open a managed overlay through the host seam (M8). The returned lease
   * is CALLER-FIBER-OWNED (P1-4): its physical mount is surface-owned, but
   * its LIFETIME is bound to the calling fiber — the fiber's unload/HMR/
   * disable closes the overlay automatically (never left hanging on the
   * TUI until the surface dies). A lease without a mounted host surface is
   * inert (close is a no-op) — the surface may not exist yet
   * (registration-before-surface).
   *
   * Three paths close the lease, all idempotent and never double-closing
   * or touching a dead surface:
   * - explicit `close()`;
   * - the caller fiber's unload (the fiber-bound effect disposer);
   * - the surface's own dispose (the host closes every still-owned lease).
   */
  showOverlay(view: ExtensionView, options?: TuiOverlayOptions): TuiOverlayHandle {
    const caller = this.ctx
    const seam = this.overlayMount
    if (seam === undefined) return inertOverlayLease()
    const mounted = seam.mount(view, options)
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      try {
        mounted.close()
      } catch {
        // The host's lease close is idempotent; a throwing close must
        // never escape into the fiber disposer or the public close path.
      }
    }
    let effectDispose: () => void
    try {
      // The fiber-bound disposer closes the overlay on unload (HMR,
      // disable). A failed effect creation (inactive caller — a stale
      // service handle) rolls the mount back.
      effectDispose = caller.fiber.effect(() => close, 'piTuiExtensions.showOverlay()')
    } catch (error) {
      close()
      throw error
    }
    return {
      close: () => {
        close()
        effectDispose()
      },
      hide: () => {
        if (closed) return
        try {
          mounted.hide()
        } catch {
          // Best effort: a dead surface's lease is inert.
        }
      },
      show: () => {
        if (closed) return
        try {
          mounted.show()
        } catch {
          // Best effort: a dead surface's lease is inert.
        }
      },
    }
  }

  /** Register an editor contribution (M9). Fiber-bound; owner unload
   * removes it (the host restores the next winner / the host default,
   * preserving the draft). */
  registerEditor(contribution: EditorContribution): EditorHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.editors.register(contribution, owner)
    this.trackRegistryHealth('editor', contribution.id, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
        this.untrackRegistryHealth('editor', contribution.id)
      }, 'piTuiExtensions.registerEditor()')
    } catch (error) {
      handle.dispose()
      this.untrackRegistryHealth('editor', contribution.id)
      throw error
    }
    return {
      id: handle.id,
      dispose: () => {
        handle.dispose()
        this.untrackRegistryHealth('editor', contribution.id)
        dispose()
      },
    }
  }

  /** The ledger behind the service (SurfaceHost access in M2). */
  _ledger(): ExtensionLedger {
    return this.ledger
  }

  /** Runner-only callback health bridges. */
  _recordRegistryError(slot: string, id: string, error: unknown): void {
    this.recordRegistryError(slot, id, error)
  }

  _clearRegistryError(slot: string, id: string): void {
    this.clearRegistryError(slot, id)
  }

  /** Test hook: the number of live subscription RECORDS (F1/F5 — an owner
   * unload or explicit release must leave this at 0; a surface detach
   * keeps the records pending, so this counts pending records too —
   * P1-3). */
  _listenerUnsubscribersSize(): number {
    return this.stateSubscriptions.size
  }
}
