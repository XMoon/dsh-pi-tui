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
import type {
  AdvancedConfirmOptions,
  AdvancedCustomHost,
  AdvancedEditorControls,
  AdvancedHostState,
  AdvancedInputCaptureHandle,
  AdvancedInputCaptureSpec,
  AdvancedInputOptions,
  AdvancedInteractiveComponent,
  AdvancedNotifyOptions,
  AdvancedOverlayLease,
  AdvancedSelectOptions,
} from './advanced-types.ts'
import type {
  UnstableRawInputHandle,
  UnstableRawInputSpec,
  UnstableSurfaceHandle,
} from './unstable-types.ts'
import { AdvancedInputRegistry } from './internal/advanced-input.ts'
import { UnstableInputRegistry } from './internal/unstable-input.ts'
import { normalizeInputEvent } from './internal/input-events.ts'
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

/** An inert ADVANCED overlay lease (no surface / seam detached / surface
 * disposed). Every method is a safe no-op; `active` and `focused` are
 * false. */
function inertAdvancedOverlayLease(): AdvancedOverlayLease {
  return {
    id: 'inert',
    active: false,
    focused: false,
    focus: () => {},
    blur: () => {},
    invalidate: () => {},
    close: () => {},
    hide: () => {},
    show: () => {},
  }
}

/** An inert ADVANCED editor controls object (no surface attached / seam
 * detached / surface disposed). Every method is a safe no-op; the snapshot
 * is a fixed inert shape. */
function inertAdvancedEditorControls(): AdvancedEditorControls {
  const inertSnapshot: import('./public-types.ts').EditorSnapshot = {
    text: '',
    cursor: 0,
    focused: false,
    composing: false,
  }
  return {
    getEditorState: () => inertSnapshot,
    setEditorText: () => {},
    setEditorCursor: () => {},
    insertEditorText: () => {},
    pasteToEditor: () => {},
    requestEditorFocus: () => {},
  }
}

/** An inert UNSTABLE surface handle (no surface / seam detached / surface
 * disposed). Every method is a safe no-op; geometry is 0. */
function inertUnstableSurfaceHandle(): UnstableSurfaceHandle {
  return {
    surfaceId: 'inert',
    generation: 0,
    width: 0,
    height: 0,
    requestRender: () => {},
    mountComponent: () => ({
      id: 'inert',
      active: false,
      focused: false,
      focus: () => {},
      blur: () => {},
      invalidate: () => {},
      close: () => {},
      hide: () => {},
      show: () => {},
    }),
  }
}

/** An inert Phase-4 host-state facade (no surface / seam detached).
 * Every method is a safe no-op. */
function inertAdvancedHostState(): AdvancedHostState {
  return {
    getTheme: () => 'dark',
    setTheme: () => {},
    setTitle: () => {},
    setWorkingMessage: () => {},
    setToolsExpanded: () => {},
  }
}

/**
 * The internal ADVANCED seam the `extensions/advanced` facade consumes
 * (plan §4: `advanced(service)` — the Stable service interface is NOT
 * extended). These `_`-prefixed members are package-internal: the facade
 * entry is the supported boundary, plugins never call them directly.
 */
export interface AdvancedHostSeam {
  /** Register a normalized input capture (caller-fiber-owned). */
  _advancedCaptureInput(spec: AdvancedInputCaptureSpec): AdvancedInputCaptureHandle
  /** Open an interactive managed overlay (caller-fiber-owned lease). */
  _advancedShowInteractiveOverlay(
    component: AdvancedInteractiveComponent,
    options?: import('./public-types.ts').TuiOverlayOptions,
  ): AdvancedOverlayLease
  /** The CURRENT surface's advanced editor controls (inert when stale). */
  _advancedEditorControls(): AdvancedEditorControls
  /** Consult the advanced captures for one raw input chunk (the Host's
   * input path calls this after its own capturing flows and reserved
   * lifecycle keys). */
  _advancedInputRoute(data: string): 'consumed' | 'passed'
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
   * Register a keybinding (M5): normalized key → public semantic action.
   * The registry validates the contribution (public TuiAction whitelist,
   * reserved keys, text-producing keys, editor-owned keys, legacy C0 collisions) and its
   * records feed the LIVE InputRouter lookups + the runner's
   * effective-keymap plugin rules (M6); routing precedence stays
   * Host-owned. Rejections throw loudly; the binding is owned by the
   * calling fiber.
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
   * simply rendered once the surface attaches). Phase 2 adds the ADVANCED
   * capabilities; Phase 3 adds the UNSTABLE capabilities — the advanced/
   * unstable registries and seams are service-lifetime, so they are
   * feature-detectable before any surface exists (their physical mounts
   * attach later). */
  static readonly ADVERTISED_CAPABILITIES: readonly PiTuiCapability[] = [
    'slot.chrome.header.badge',
    'slot.input.dock.item',
    'slot.chrome.footer.status',
    'slot.input.widget',
    'advanced.input.capture',
    'advanced.ui.interactive',
    'advanced.editor.control',
    'unstable.input.raw',
    'unstable.surface.handle',
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
  /** Phase 2: the ADVANCED normalized input capture registry. The
   * registrations are caller-fiber-owned (the service binds them); the
   * registry itself is service-lifetime — captures survive surface
   * recreate and are consulted by the CURRENT surface's input path. */
  readonly advancedInputs: AdvancedInputRegistry
  /** Phase 2: the ADVANCED interactive-overlay mount seam (wired by the
   * runner; the host owns the screen + broker). SURFACE-scoped like the
   * stable overlay seam: bound per attachment through a surfaceId lease —
   * a stale old-generation detach never unbinds a newer surface's seam. */
  private advancedOverlayMount: {
    surfaceId: string
    mount(component: AdvancedInteractiveComponent, options?: import('./public-types.ts').TuiOverlayOptions): AdvancedOverlayLease
  } | undefined
  /** Phase 2: the ADVANCED editor-control seam (wired by the runner; the
   * host owns the editor seat). SURFACE-scoped like the overlay seam. */
  private advancedEditorSeam: {
    surfaceId: string
    controls: AdvancedEditorControls
  } | undefined
  /** Phase 4: the ADVANCED imperative UI seam (wired by the runner; the
   * host owns the picker/question/notify infrastructure). SURFACE-scoped
   * like the other seams. */
  private advancedUiSeam: {
    surfaceId: string
    select(options: AdvancedSelectOptions): Promise<string | undefined>
    confirm(options: AdvancedConfirmOptions): Promise<boolean>
    input(options: AdvancedInputOptions): Promise<string | undefined>
    notify(message: string, options?: AdvancedNotifyOptions): void
    custom(factory: (host: AdvancedCustomHost) => AdvancedInteractiveComponent, options?: import('./public-types.ts').TuiOverlayOptions, signal?: AbortSignal): Promise<unknown>
  } | undefined
  /** Phase 4: the ADVANCED host-state seam (wired by the runner; the host
   * owns theme/title/working/tools-expanded state). SURFACE-scoped. */
  private advancedHostSeam: {
    surfaceId: string
    state: AdvancedHostState
  } | undefined
  /** Phase 3: the UNSTABLE raw input capture registry. Registrations are
   * caller-fiber-owned; the registry is service-lifetime — captures
   * survive surface recreate and are consulted by the CURRENT surface's
   * input path BEFORE terminal protocol decoding. */
  readonly unstableInputs: UnstableInputRegistry
  /** Phase 3: the UNSTABLE low-level surface seam (wired by the runner;
   * the host owns the screens). SURFACE-scoped like the other seams. */
  private unstableSurfaceSeam: {
    surfaceId: string
    handle: UnstableSurfaceHandle
  } | undefined
  /** Phase 3: the still-open UNSTABLE mount close functions (closed by
   * the emergency fail-safe and by owner unload). */
  private readonly unstableMounts = new Set<() => void>()
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
    // Phase 2: the advanced input capture registry. Health rides the
    // ledger (the plan's "no new Advanced health system" rule): a
    // throwing capture handler/gate is recorded under
    // 'advanced.input.capture' and cleared on the next successful consume.
    this.advancedInputs = new AdvancedInputRegistry(
      () => this.batcher.invalidate(),
      {
        track: (id, owner) => this.ledger.trackHealth('advanced.input.capture', id, owner),
        untrack: (id) => this.ledger.untrackHealth('advanced.input.capture', id),
        recordError: (id, message) => this.ledger.recordExternalError('advanced.input.capture', id, message),
        clearError: (id) => this.ledger.clearExternalError('advanced.input.capture', id),
      },
    )
    // Phase 3: the unstable raw capture registry. Health rides the ledger
    // ('unstable.input.raw' slot) — a throwing raw handler is recorded and
    // cleared on the next successful decision.
    this.unstableInputs = new UnstableInputRegistry(
      () => this.batcher.invalidate(),
      {
        track: (id, owner) => this.ledger.trackHealth('unstable.input.raw', id, owner),
        untrack: (id) => this.ledger.untrackHealth('unstable.input.raw', id),
        recordError: (id, message) => this.ledger.recordExternalError('unstable.input.raw', id, message),
        clearError: (id) => this.ledger.clearExternalError('unstable.input.raw', id),
      },
    )
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
    // Phase 2: unbind the ADVANCED seams with the same lease — a stale
    // old-generation detach never unbinds a newer surface's advanced
    // overlay mount or editor controls.
    if (this.advancedOverlayMount !== undefined && this.advancedOverlayMount.surfaceId === detachingId) {
      this.advancedOverlayMount = undefined
    }
    if (this.advancedEditorSeam !== undefined && this.advancedEditorSeam.surfaceId === detachingId) {
      this.advancedEditorSeam = undefined
    }
    // Phase 4: unbind the ADVANCED imperative-UI and host-state seams with
    // the same lease.
    if (this.advancedUiSeam !== undefined && this.advancedUiSeam.surfaceId === detachingId) {
      this.advancedUiSeam = undefined
    }
    if (this.advancedHostSeam !== undefined && this.advancedHostSeam.surfaceId === detachingId) {
      this.advancedHostSeam = undefined
    }
    // Phase 3: unbind the UNSTABLE surface seam with the same lease.
    if (this.unstableSurfaceSeam !== undefined && this.unstableSurfaceSeam.surfaceId === detachingId) {
      this.unstableSurfaceSeam = undefined
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
   * Register a keybinding (M5): normalized key → public semantic action.
   * Fiber-bound; owner unload removes the binding. The registry rejects
   * loudly: non-public actions, reserved host keys, text-producing keys, editor-owned keys and
   * legacy C0 collisions. The records feed the live InputRouter lookups
   * and the runner's effective-keymap plugin rules (M6).
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

  // ── Phase 2: the ADVANCED seam (consumed by `extensions/advanced`) ──────

  /**
   * Register a normalized input capture (plan §5). Caller-fiber-owned:
   * owner unload removes the capture. A duplicate id or a second live
   * exclusive capture is an explicit error (the registry's rules — never
   * a load-order winner). A stale service handle's call is rejected by
   * the fiber check (INACTIVE_EFFECT) and rolled back.
   */
  _advancedCaptureInput(spec: AdvancedInputCaptureSpec): AdvancedInputCaptureHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.advancedInputs.register(spec, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.advanced.input.capture()')
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
   * Open an interactive managed overlay (plan §8). The returned lease is
   * CALLER-FIBER-OWNED: its physical mount is surface-owned, but its
   * LIFETIME is bound to the calling fiber — the fiber's unload/HMR/
   * disable closes the overlay automatically. A lease without a mounted
   * host surface is inert (registration-before-surface). Three paths
   * close the lease, all idempotent: explicit close(), the caller fiber's
   * unload, and the surface's own dispose.
   */
  _advancedShowInteractiveOverlay(
    component: AdvancedInteractiveComponent,
    options?: import('./public-types.ts').TuiOverlayOptions,
  ): AdvancedOverlayLease {
    const caller = this.ctx
    const seam = this.advancedOverlayMount
    if (seam === undefined) return inertAdvancedOverlayLease()
    const mounted = seam.mount(component, options)
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
      effectDispose = caller.fiber.effect(() => close, 'piTuiExtensions.advanced.ui.showInteractiveOverlay()')
    } catch (error) {
      close()
      throw error
    }
    return {
      id: mounted.id,
      get active() {
        return !closed && mounted.active
      },
      get focused() {
        return !closed && mounted.focused
      },
      focus: () => {
        if (closed) return
        try {
          mounted.focus()
        } catch {
          // Best effort: a dead surface's lease is inert.
        }
      },
      blur: () => {
        if (closed) return
        try {
          mounted.blur()
        } catch {
          // Best effort: a dead surface's lease is inert.
        }
      },
      invalidate: () => {
        if (closed) return
        try {
          mounted.invalidate()
        } catch {
          // Best effort: a dead surface's lease is inert.
        }
      },
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

  /** The CURRENT surface's advanced editor controls (plan §9), or an
   * inert object when no surface is attached / the seam is detached. The
   * controls follow the live attachment: a stale old-generation detach
   * never unbinds a newer surface's seam (the surfaceId lease). */
  _advancedEditorControls(): AdvancedEditorControls {
    return this.advancedEditorSeam?.controls ?? inertAdvancedEditorControls()
  }

  /** Consult the advanced captures for one raw input chunk. The Host's
   * input path calls this AFTER its own capturing flows (questions,
   * approvals, overlays) and reserved lifecycle keys, and BEFORE the
   * editor and the Stable keybindings (plan §5/§11 — the Phase-2
   * contract: advanced plugins preempt ordinary editor/panel input, never
   * Host questions/approvals/overlays or fatal-recovery shortcuts). */
  _advancedInputRoute(data: string): 'consumed' | 'passed' {
    return this.advancedInputs.route(data, normalizeInputEvent)
  }

  /** Runner-only: wire the ADVANCED interactive-overlay mount seam
   * (Phase 2). SURFACE-scoped like the stable overlay seam: bound to the
   * CURRENT attachment's surfaceId — a later attach replaces it, and a
   * stale old-generation detach never unbinds a newer surface's seam. */
  setAdvancedOverlayMount(
    surfaceId: string,
    mount: (component: AdvancedInteractiveComponent, options?: import('./public-types.ts').TuiOverlayOptions) => AdvancedOverlayLease,
  ): void {
    this.advancedOverlayMount = { surfaceId, mount }
  }

  /** Runner-only: wire the ADVANCED editor-control seam (Phase 2).
   * SURFACE-scoped like the overlay seam. */
  setAdvancedEditorSeam(surfaceId: string, controls: AdvancedEditorControls): void {
    this.advancedEditorSeam = { surfaceId, controls }
  }

  // ── Phase 4: the ADVANCED imperative UI + host-state seams ───────────────

  /**
   * Imperative selection (plan §4A). Caller-fiber-owned: owner unload
   * aborts the prompt (the promise resolves undefined). The caller's own
   * signal (if any) is combined with the fiber signal. Without a mounted
   * surface the prompt resolves undefined immediately.
   */
  _advancedUiSelect(options: AdvancedSelectOptions): Promise<string | undefined> {
    const seam = this.advancedUiSeam
    if (seam === undefined) return Promise.resolve(undefined)
    const caller = this.ctx
    const controller = new AbortController()
    let effectDispose: () => void
    try {
      effectDispose = caller.fiber.effect(() => () => controller.abort(), 'piTuiExtensions.advanced.ui.select()')
    } catch (error) {
      controller.abort()
      throw error
    }
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    return seam.select({ ...options, signal }).finally(() => effectDispose())
  }

  /** Imperative confirmation (plan §4A). Same ownership as select;
   * cancel/abort resolves false. */
  _advancedUiConfirm(options: AdvancedConfirmOptions): Promise<boolean> {
    const seam = this.advancedUiSeam
    if (seam === undefined) return Promise.resolve(false)
    const caller = this.ctx
    const controller = new AbortController()
    let effectDispose: () => void
    try {
      effectDispose = caller.fiber.effect(() => () => controller.abort(), 'piTuiExtensions.advanced.ui.confirm()')
    } catch (error) {
      controller.abort()
      throw error
    }
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    return seam.confirm({ ...options, signal }).finally(() => effectDispose())
  }

  /** Imperative free-text input (plan §4A). Same ownership as select;
   * cancel/abort resolves undefined. */
  _advancedUiInput(options: AdvancedInputOptions): Promise<string | undefined> {
    const seam = this.advancedUiSeam
    if (seam === undefined) return Promise.resolve(undefined)
    const caller = this.ctx
    const controller = new AbortController()
    let effectDispose: () => void
    try {
      effectDispose = caller.fiber.effect(() => () => controller.abort(), 'piTuiExtensions.advanced.ui.input()')
    } catch (error) {
      controller.abort()
      throw error
    }
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    return seam.input({ ...options, signal }).finally(() => effectDispose())
  }

  /** Imperative notification (plan §4A). Bounded, no raw ANSI, surface-
   * detach safe. */
  _advancedUiNotify(message: string, options?: AdvancedNotifyOptions): void {
    const seam = this.advancedUiSeam
    if (seam === undefined) return
    try {
      seam.notify(message, options)
    } catch {
      // Best effort: a dead surface's notify is inert.
    }
  }

  /**
   * Custom interactive UI (plan §4B). The factory receives ONLY the public
   * host facade; the promise resolves with the result reported through
   * done(), or undefined on close/cancel. Caller-fiber-owned: owner
   * unload aborts the prompt (the promise settles undefined and the
   * surface closes) — the fiber signal rides into the seam.
   */
  _advancedUiCustom(
    factory: (host: AdvancedCustomHost) => AdvancedInteractiveComponent,
    options?: import('./public-types.ts').TuiOverlayOptions,
  ): Promise<unknown> {
    const seam = this.advancedUiSeam
    if (seam === undefined) return Promise.resolve(undefined)
    const caller = this.ctx
    const controller = new AbortController()
    let effectDispose: () => void
    try {
      effectDispose = caller.fiber.effect(() => () => controller.abort(), 'piTuiExtensions.advanced.ui.custom()')
    } catch (error) {
      controller.abort()
      throw error
    }
    return seam.custom(factory, options, controller.signal).finally(() => effectDispose())
  }

  /** The Phase-4 host-state facade (plan §4D), or an inert object when no
   * surface is attached / the seam is detached. */
  _advancedHostState(): AdvancedHostState {
    return this.advancedHostSeam?.state ?? inertAdvancedHostState()
  }

  /** Runner-only: wire the ADVANCED imperative UI seam (Phase 4).
   * SURFACE-scoped like the other seams. */
  setAdvancedUiSeam(
    surfaceId: string,
    ui: {
      select(options: AdvancedSelectOptions): Promise<string | undefined>
      confirm(options: AdvancedConfirmOptions): Promise<boolean>
      input(options: AdvancedInputOptions): Promise<string | undefined>
      notify(message: string, options?: AdvancedNotifyOptions): void
      custom(factory: (host: AdvancedCustomHost) => AdvancedInteractiveComponent, options?: import('./public-types.ts').TuiOverlayOptions, signal?: AbortSignal): Promise<unknown>
    },
  ): void {
    this.advancedUiSeam = { surfaceId, ...ui }
  }

  /** Runner-only: wire the ADVANCED host-state seam (Phase 4).
   * SURFACE-scoped like the other seams. */
  setAdvancedHostSeam(surfaceId: string, state: AdvancedHostState): void {
    this.advancedHostSeam = { surfaceId, state }
  }

  // ── Phase 3: the UNSTABLE seam (consumed by `extensions/unstable`) ──────

  /**
   * Register a raw input capture (plan §5). Caller-fiber-owned: owner
   * unload removes the capture. A duplicate id or a second live exclusive
   * capture is an explicit error (the registry's rules — never a
   * load-order winner). A stale service handle's call is rejected by the
   * fiber check (INACTIVE_EFFECT) and rolled back.
   */
  _unstableCaptureRaw(spec: UnstableRawInputSpec): UnstableRawInputHandle {
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.unstableInputs.register(spec, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.unstable.input.captureRaw()')
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

  /** The CURRENT surface's low-level handle (plan §10), or an inert
   * handle when no surface is attached / the seam is detached. The
   * handle follows the live attachment (the surfaceId lease). Mounts
   * created through it are caller-fiber-owned AND tracked for the
   * emergency fail-safe. */
  _unstableSurfaceHandle(): UnstableSurfaceHandle {
    const seam = this.unstableSurfaceSeam
    if (seam === undefined) return inertUnstableSurfaceHandle()
    const caller = this.ctx
    const service = this
    return {
      surfaceId: seam.handle.surfaceId,
      generation: seam.handle.generation,
      get width() {
        return seam.handle.width
      },
      get height() {
        return seam.handle.height
      },
      requestRender: () => {
        try {
          seam.handle.requestRender()
        } catch {
          // Best effort: a dead surface's handle is inert.
        }
      },
      mountComponent: (component, options) => {
        const mounted = seam.handle.mountComponent(component, options)
        let closed = false
        const close = (): void => {
          if (closed) return
          closed = true
          service.unstableMounts.delete(close)
          try {
            mounted.close()
          } catch {
            // The host's lease close is idempotent; a throwing close must
            // never escape into the fiber disposer or the public close
            // path.
          }
        }
        let effectDispose: () => void
        try {
          effectDispose = caller.fiber.effect(() => close, 'piTuiExtensions.unstable.surface.mountComponent()')
        } catch (error) {
          close()
          throw error
        }
        service.unstableMounts.add(close)
        return {
          id: mounted.id,
          get active() {
            return !closed && mounted.active
          },
          get focused() {
            return !closed && mounted.focused
          },
          focus: () => {
            if (closed) return
            try {
              mounted.focus()
            } catch {
              // Best effort: a dead surface's lease is inert.
            }
          },
          blur: () => {
            if (closed) return
            try {
              mounted.blur()
            } catch {
              // Best effort: a dead surface's lease is inert.
            }
          },
          invalidate: () => {
            if (closed) return
            try {
              mounted.invalidate()
            } catch {
              // Best effort: a dead surface's lease is inert.
            }
          },
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
      },
    }
  }

  /** Consult the raw captures for one chunk. The Host's input path calls
   * this BEFORE terminal protocol decoding (plan §4) — a capture can see,
   * consume or rewrite ANY raw chunk. The returned outcome is applied
   * exactly once (a rewrite goes straight to the Host decoder). */
  _unstableInputRoute(data: string, surfaceId: string): import('./internal/unstable-input.ts').UnstableRawRouteResult {
    return this.unstableInputs.route({ data, surfaceId })
  }

  /** Whether any raw capture is live (the app arms the emergency
   * fail-safe only while captures exist). */
  _unstableInputsLive(): boolean {
    return this.unstableInputs.hasAny()
  }

  /** The raw capture registry revision (the app's fail-safe tracker
   * stamps each Esc press with it — presses from a previous capture
   * session never count toward a new session's triple-Esc). */
  _unstableInputsRevision(): number {
    return this.unstableInputs.revisionOf()
  }

  /**
   * The Host emergency fail-safe (plan §7): release every unstable raw
   * capture and close every unstable mount, restoring Host input. This is
   * Host recovery — it is NOT part of the Unstable plugin API and cannot
   * be rewritten or consumed by a capture (the Host detects the fail-safe
   * pattern before consulting the captures). Idempotent.
   */
  _unstableEmergencyRelease(): void {
    this.unstableInputs.disposeAll()
    for (const close of [...this.unstableMounts]) close()
    this.unstableMounts.clear()
  }

  /** Runner-only: wire the UNSTABLE low-level surface seam (Phase 3).
   * SURFACE-scoped like the other seams. */
  setUnstableSurfaceSeam(surfaceId: string, handle: UnstableSurfaceHandle): void {
    this.unstableSurfaceSeam = { surfaceId, handle }
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
