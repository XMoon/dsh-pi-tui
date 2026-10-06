/**
 * The surface-owned extension attachment lifetime (TS3 §32).
 *
 * This owner holds the ONE `SurfaceHost` over the attached extension service, the
 * generation-leased theme-unload hook, the plugin-keybinding sync subscription and
 * the surface-scoped attachment seams (stable overlay, advanced overlay/editor/UI/
 * host-state, unstable surface, render-error/recovery sinks and the render-sink
 * bridge). It owns the extension-surface ATTACHMENT LIFETIME only: the public
 * extension API and every registry stay in `src/extension/**`, untouched.
 *
 * Preserved rules:
 *
 * - every surface-scoped seam is bound to THIS attachment's `surfaceId`, so a
 *   stale older-generation detach can never unbind a newer surface's seam;
 * - the theme-unload hook release is generation-leased (the release returned by
 *   the service is stored per generation and released exactly once by THAT
 *   generation's `dispose()`);
 * - the attachment is acquired exactly once (`attachExtensionHost`) and released
 *   by the aggregate's ordered disposal (plugin keybinding sync, theme hook,
 *   surface detach — never truncated by a throwing sibling).
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/extension-runtime
 */

import { Text } from '@xmoon76/pi-tui'
import type { PiTuiExtensionService } from '../../extensions.ts'
import { SurfaceHost } from '../../extension/internal/surface-host.ts'
import { runSyncDisposalSteps } from '../../disposal.ts'
import type { KeybindingRegistry } from '../../keybinding-registry.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { TuiApp, TuiAppOptions } from '../../tui-app.ts'

/** One non-optional capability borrowed from the TuiApp option contract. */
export type OptionCapability<Key extends keyof TuiAppOptions> = NonNullable<TuiAppOptions[Key]>

/**
 * The extension surface service as the surface consumes it: the registries
 * that render/route chrome content, the surface-scoped extension seams, and
 * the advanced/unstable input seams. The option-shaped member types are
 * DERIVED from the TuiApp option contract, so this narrow view can never drift
 * from what the app actually accepts. The runner resolves the concrete
 * service; `app/surface` never becomes a Host service locator.
 */
export type SurfaceExtensionService = PiTuiExtensionService & {
  readonly renderers: OptionCapability<'renderers'>
  readonly editors: OptionCapability<'editorRegistry'>
  readonly keybindings: KeybindingRegistry
  readonly _advancedInputRoute: OptionCapability<'advancedInputRoute'>
  readonly _unstableInputRoute: OptionCapability<'unstableInputRoute'>
  readonly _unstableInputsLive: OptionCapability<'unstableInputsLive'>
  readonly _unstableInputsRevision: OptionCapability<'unstableInputsRevision'>
  readonly _unstableEmergencyRelease: OptionCapability<'unstableFailSafeRelease'>
  _ledger(): import('../../extension/internal/ledger.ts').ExtensionLedger
  /** INTERNAL owner → owning Loader entry id projection (P1-A1.4). */
  _ownerEntryIds(): ReadonlyMap<string, string>
  /** Theme-unload notification: called with the SOURCE-QUALIFIED selectable
   *  value of every theme that unloads. Returns the GENERATION-LEASED release
   *  (an old runner's cleanup must never clear a newer generation's hook). */
  setThemeUnloadedHook(hook: (unloaded: { selectableValue: string; name: string }) => void): () => void
  attachSurface(bridge: { subscribe(listener: (state: never) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string, requestRender?: (force?: boolean) => void): void
  detachSurface(surfaceId?: string): void
  // Phase 2: the ADVANCED seam (the interactive-overlay/editor-control seams).
  setAdvancedOverlayMount(
    surfaceId: string,
    mount: (component: import('../../extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('../../extension/public-types.ts').TuiOverlayOptions) => import('../../extension/advanced-types.ts').AdvancedOverlayLease,
  ): void
  setAdvancedEditorSeam(surfaceId: string, controls: import('../../extension/advanced-types.ts').AdvancedEditorControls): void
  // Phase 4: the ADVANCED imperative-UI + host-state seams.
  setAdvancedUiSeam(
    surfaceId: string,
    ui: {
      select(options: import('../../extension/advanced-types.ts').AdvancedSelectOptions): Promise<string | undefined>
      confirm(options: import('../../extension/advanced-types.ts').AdvancedConfirmOptions): Promise<boolean>
      input(options: import('../../extension/advanced-types.ts').AdvancedInputOptions): Promise<string | undefined>
      notify(message: string, options?: import('../../extension/advanced-types.ts').AdvancedNotifyOptions): void
      custom(factory: (host: import('../../extension/advanced-types.ts').AdvancedCustomHost) => import('../../extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('../../extension/public-types.ts').TuiOverlayOptions, signal?: AbortSignal): Promise<unknown>
    },
  ): void
  setAdvancedHostSeam(surfaceId: string, state: import('../../extension/advanced-types.ts').AdvancedHostState): void
  // Phase 3: the UNSTABLE low-level surface seam.
  setUnstableSurfaceSeam(surfaceId: string, handle: import('../../extension/unstable-types.ts').UnstableSurfaceHandle): void
}

/** The mounted-surface inputs the extension chrome attach needs. */
export interface SurfaceSeamDeps {
  /** The late-bound command-completion refresh (a client command contribution
   *  may join the `/` menu after mount). */
  readonly refreshCommandCompletions: () => void
}

/** The narrow inputs of the extension attachment owner; one cohesive lifetime. */
export interface ExtensionRuntimeOptions {
  /** The mounted app (throws before `start()`), read through the aggregate. */
  readonly mounted: () => TuiApp
}

/** The surface extension-attachment owner `createSurfaceRuntime()` consumes. */
export interface ExtensionRuntime {
  /** The attached extension service (undefined before `attachHost`). */
  service(): SurfaceExtensionService | undefined
  /** The extension surface host (undefined before `attachHost`). */
  host(): SurfaceHost | undefined
  /**
   * Acquire the extension surface host + theme-unload hook (M3 wiring). The
   * runner resolves the service (never this module) and calls this at the
   * original wiring position, before the mount.
   */
  attachHost(extensionService: SurfaceExtensionService): void
  /** Attach the extension host to the mounted surface chrome (M3/F-1). */
  attachSeams(deps: SurfaceSeamDeps): void
  /** Sync + subscribe the plugin keybindings from the attached service (M2). */
  bindPluginKeybinds(): void
  /** Release THIS generation's extension bridge, hook and keybinding sync. */
  dispose(): void
}

/** Create the surface extension-attachment owner. */
export function createExtensionRuntime(options: ExtensionRuntimeOptions): ExtensionRuntime {
  // The extension surface resources (A4-5); each has exactly one acquire point
  // (`attach*`/`bind*`) and one release owner (`dispose()`).
  let extensionService: SurfaceExtensionService | undefined
  let extensionHost: SurfaceHost | undefined
  let releaseThemeUnloadedHook: (() => void) | undefined
  let stopPluginKeybindingSync: (() => void) | undefined

  /** The mounted app for a callback that can only run while the surface is
   *  live (the original wiring read the runner's `app` binding directly). */
  const mounted = (): TuiApp => options.mounted()

  /**
   * M2: the plugin contributions compile into the effective keymap at the
   * LOWEST priority (a Host action always wins). The surface syncs the
   * registry snapshot on every invalidation (the manager skips unchanged
   * rules, so the rebuild is cheap).
   */
  const syncPluginKeybinds = (): void => {
    const registry = extensionService?.keybindings
    if (registry === undefined) return
    const snapshot = registry.snapshot()
    // The TUI key authority normalizes the public chord identity into the
    // fork's KeyId grammar (TS5 §12); app/surface never imports the keybinding
    // implementation.
    mounted().setPluginKeybindingRules(snapshot.bindings)
  }

  return {
    service: () => extensionService,
    host: () => extensionHost,
    attachHost(service) {
      extensionService = service
      // The TUI surface attaches a SurfaceHost over the service ledger —
      // extensions (including the first-party builtins) render into the chrome.
      extensionHost = new SurfaceHost(service._ledger(), () => mounted().requestRender())
      // Selected-plugin-theme fallback (the review's P2): when the theme
      // currently applied unloads (HMR), the host must restore the builtin dark
      // palette — the registry alone only removes the record and repaints,
      // leaving the dead plugin's palette on screen. The hook is keyed on the
      // SOURCE-QUALIFIED selectable value (the same identity
      // applyPluginPalette records). The GENERATION-LEASED release is stored so
      // THIS generation's cleanup releases only its own hook.
      releaseThemeUnloadedHook = service.setThemeUnloadedHook(({ selectableValue }) => {
        const live = mounted()
        if (live.activePluginTheme() === selectableValue) {
          live.clearActivePluginTheme()
          live.applyTheme('dark')
          live.trackTerminalTheme(false)
        }
      })
    },
    attachSeams(deps) {
      const service = extensionService
      const host = extensionHost
      if (host === undefined || service === undefined) return
      const live = mounted()
      // M7 (round-1 finding 3): renderer failures land in the extension health
      // ledger — observable via /status diagnostics, never swallowed. Safe
      // single-line message (no stack traces, hostile toString handled).
      live.setRendererErrorSink(({ id, error, slot, owner }) => {
        const message = safeErrorMessage(error).replace(/\s+/g, ' ').slice(0, 200)
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        service._ledger().recordError(healthSlot, id, owner, message)
      })
      // M7 (P1-08): a renderer that renders successfully after a failure
      // RECOVERS — clear its health record (the next failure starts a NEW
      // error generation).
      live.setRendererRecoveredSink(({ id, slot, owner }) => {
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        service._ledger().clearError(healthSlot, id, owner)
      })
      // M8: the managed-overlay mount seam — SURFACE-scoped (P1-4): bound to
      // THIS attachment's surfaceId so a stale old-generation detach never
      // unbinds a newer surface's seam.
      service.setOverlayMount(host.surfaceId, (view, overlayOptions) => live.showExtensionOverlay(view, overlayOptions))
      // Phase 2: the ADVANCED seams, both SURFACE-scoped like the stable one.
      service.setAdvancedOverlayMount(host.surfaceId, (component, overlayOptions) =>
        live.showAdvancedInteractiveOverlay(component, overlayOptions))
      service.setAdvancedEditorSeam(host.surfaceId, live.advancedEditorControls())
      // Phase 4: the ADVANCED imperative UI seam — the broker reuses the
      // host's own picker/question/notify infrastructure.
      service.setAdvancedUiSeam(host.surfaceId, live.advancedUiBroker())
      // Phase 4: the ADVANCED host-state seam DELEGATES to the app's host-state
      // facade (single source of truth).
      service.setAdvancedHostSeam(host.surfaceId, {
        getTheme: () => live.advancedHostState().getTheme(),
        setTheme: (name) => live.advancedHostState().setTheme(name),
        setTitle: (title) => live.advancedHostState().setTitle(title),
        setWorkingMessage: (message) => live.advancedHostState().setWorkingMessage(message),
        setTranscriptDetailExpanded: (expanded) => live.advancedHostState().setTranscriptDetailExpanded(expanded),
        setToolsExpanded: (expanded) => live.advancedHostState().setToolsExpanded(expanded),
      })
      // Phase 3: the UNSTABLE low-level surface seam — SURFACE-scoped.
      service.setUnstableSurfaceSeam(host.surfaceId, live.unstableSurfaceHandle())
      host.attach(
        { header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) },
        {
          surfaceId: host.surfaceId,
          generation: live.getSurfaceGeneration(),
          width: process.stdout.columns ?? 80,
          height: process.stdout.rows ?? 24,
          fullscreen: false,
          focusedSeat: 'editor',
          themeId: 'dark',
          themeRevision: 0,
        },
      )
      live.refreshChrome()
      // P1-1: attach the surface's RENDER SINK to the extension service —
      // registry invalidations flush through the service batcher into THIS
      // surface's render path, so a dynamic registration repaints without any
      // user input. The stale-detach lease protects a newer surface.
      service.attachSurface(
        { subscribe: (listener) => host.subscribeState(listener as never) },
        host.capabilitiesOf() as ReadonlySet<string>,
        // The attachment lease (P1): a stale detachSurface from an older
        // generation must not tear down THIS surface's bridge.
        host.surfaceId,
        (force) => {
          // M2: registry invalidations (including plugin keybinding
          // register/unload) flush through the batcher into this callback —
          // sync the plugin rules into the effective keymap (a no-op when
          // unchanged), re-synthesize the slash completions (a late client
          // command contribution joins the menu), then repaint.
          syncPluginKeybinds()
          deps.refreshCommandCompletions()
          live.requestRender(force)
        },
      )
    },
    bindPluginKeybinds() {
      syncPluginKeybinds()
      // M2 DYNAMIC LIFECYCLE (convergence finding): plugin bindings registered
      // AFTER mount — or unloaded — must resync the effective keymap (the
      // initial snapshot is not enough). Subscribe to the registry's change
      // notifications so every register/dispose re-syncs; the subscription is
      // disposed with the surface teardown.
      stopPluginKeybindingSync = extensionService?.keybindings.subscribe(() => syncPluginKeybinds())
    },
    dispose() {
      // Every one-shot slot is retired before its callback runs, so a throwing
      // app-owned cleanup can never strand the plugin keybinding sync, the
      // theme-unload hook release or the extension surface detach. The
      // extension SERVICE outlives the surface: only the bridge is detached.
      const pluginKeybindingSync = stopPluginKeybindingSync
      const themeUnloadedHook = releaseThemeUnloadedHook
      const service = extensionService
      const surfaceId = extensionHost?.surfaceId
      stopPluginKeybindingSync = undefined
      releaseThemeUnloadedHook = undefined
      extensionHost = undefined
      runSyncDisposalSteps('extension runtime disposal', [
        // M2: unsubscribe the plugin keybinding sync (the registry outlives the
        // surface — a stale listener must not resync into a dead app).
        () => pluginKeybindingSync?.(),
        // Release THIS generation's theme-unload hook: without the generation
        // lease, the old callback (capturing the disposed app) would stay
        // installed until the next runner installed its own.
        () => themeUnloadedHook?.(),
        // Detach the extension service's surface bridge (its capability set and
        // state listeners die with the surface). The surfaceId lease makes a
        // stale detach a no-op (P1).
        () => service?.detachSurface(surfaceId),
      ])
    },
  }
}
