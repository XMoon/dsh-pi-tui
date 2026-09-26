/**
 * SurfaceRuntime (A4): the ONE application owner of the mounted TUI surface.
 *
 * Ownership (plan §7/§11/§12):
 *
 * - the mounted `TuiApp` is CREATED here (`startProcessTui`) and disposed here;
 * - the opening-session journal instance and the status projection store are
 *   surface-owned concrete state;
 * - the surface-local TuiApp OPTION wiring lives here (image loader, history
 *   search binding, clipboard/link capabilities, extension registries and
 *   input routes, resize/workflow hooks);
 * - the extension surface host, its theme-unload hook, the plugin keybinding
 *   sync and the Plugin Manager controller/panel wiring live here (A4-5);
 * - the runner still owns the application input contract: it hands the
 *   `TuiAppEvents` table in at `start()`, because that table is the
 *   session/submission/command owners' contract with the surface (A5 moves the
 *   composition into `app/bootstrap.ts`).
 *
 * The mount is TWO-PHASE by lifecycle necessity: the status store and the
 * opening journal exist long before the surface mounts (startup derives
 * status, the first transition opens a journal), while the mount needs
 * capabilities that only resolve later in startup. `createSurfaceRuntime`
 * therefore owns the early state, the `attach*` methods acquire the surface
 * resources at their ORIGINAL startup positions (startup order is behavior),
 * and `start()` performs the mount once the capabilities exist.
 *
 * Teardown order is behavior too (plan §12.2): `dispose()` releases exactly the
 * surface-owned resources that the runner's cleanup used to release AFTER the
 * mounted app (app, plugin keybinding sync, theme-unload hook, extension
 * surface detach), and `disposePluginManager()` releases the Plugin Manager
 * subscription at its original EARLY position. The remaining interleaved
 * runner-owned steps stay with their owners and the runner orchestrates them
 * around these hooks.
 *
 * Host coupling: this module reads NO Host business service and imports NO
 * Direct wiring (plan §4.3). Everything it needs arrives as a narrow injected
 * capability or a semantic port.
 *
 * @module app/surface/runtime
 */

import { Text, type Component } from '@xmoon76/pi-tui'
import { startProcessTui, type TuiApp, type TuiAppEvents, type TuiAppOptions } from '../../tui-app.ts'
import type { Diag } from '../../diag.ts'
import type { PiTuiExtensionService } from '../../extensions.ts'
import { color } from '../../theme.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { ImageLoader } from '../../image/loader.ts'
import type { ImageAttachmentRefLike } from '../../image/admission.ts'
import type { KeybindingRegistry } from '../../keybinding-registry.ts'
import { StatusStore } from '../../status/store.ts'
import { initialStatusSnapshot } from '../../status/snapshot.ts'
import { CompletionNotificationController } from '../../notification/controller.ts'
import { parseNotificationMethod, parseNotificationMode } from '../../notification/settings.ts'
import { DISABLE_FOCUS_REPORTING, ENABLE_FOCUS_REPORTING, FOCUS_IN_SEQUENCE, FOCUS_OUT_SEQUENCE, TerminalFocusTracker } from '../../notification/terminal-focus.ts'
import { TerminalNotifier, type TerminalNotifierWriter } from '../../notification/terminal-notifier.ts'
import { normalizedKeyToKeyId } from '../../keybindings/manager.ts'
import { SurfaceHost } from '../../extension/internal/surface-host.ts'
import { PluginManagerController } from '../../plugin-manager/controller.ts'
import { PluginManagerHostRegistry, type PluginManagerHostClaim } from '../../plugin-manager/host-registry.ts'
import { PluginManagerPanel } from '../../plugin-manager/panel.ts'
import { observeTuiExtensions } from '../../plugin-manager/extension-inventory.ts'
import type { PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import { createOpeningJournal, type OpeningJournal } from './opening-journal.ts'

/** One non-optional capability borrowed from the TuiApp option contract. */
type OptionCapability<Key extends keyof TuiAppOptions> = NonNullable<TuiAppOptions[Key]>

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

/** The capabilities the mount needs; each is resolved by the runner/bootstrap. */
export interface SurfaceMountDeps {
  /** The application input contract (session/submission/command owners). */
  readonly events: TuiAppEvents
  /** The surface workspace root (path summaries display relative to it). */
  readonly workspaceRoot: OptionCapability<'workspaceRoot'>
  /** The structural icon palette, read once from the persisted settings. */
  readonly iconStyle: OptionCapability<'iconStyle'>
  /** The shared canonical display authority. */
  readonly displayState: OptionCapability<'displayState'>
  /** Ctrl+R input-history source (the runner owns its filesystem IO). */
  readonly historySearchSource: OptionCapability<'historySearchSource'>
  /** Durable-attachment read for the image loader (the runner owns Host access). */
  readonly readImage: (ref: ImageAttachmentRefLike) => Promise<{ ref: unknown; data: Uint8Array }>
  /** Tool-card presentation bridge (the runner resolves the live tool registry). */
  readonly present: OptionCapability<'present'>
  /** The live session cwd the history search's `current` scope resolves against. */
  readonly sessionCwd: () => string
  /** The live session identity the history panel captures at open time. */
  readonly sessionId: () => string | undefined
  /** Material terminal-width change (the command surface coalesces its refresh). */
  readonly onTerminalResize: OptionCapability<'onTerminalResize'>
  /** Semantic Workflow card actions (member open / scoped agent browse). */
  readonly handleWorkflowAction: (action: Parameters<OptionCapability<'onWorkflowAction'>>[0]) => void
  /** Fullscreen drag-selection copy (the runner owns the clipboard policy). */
  readonly copySelection: OptionCapability<'copySelection'>
  /** OSC 8 link activation (the runner owns the platform opener). */
  readonly openExternalUrl: OptionCapability<'openExternalUrl'>
  /** Right-click clipboard read (the runner owns the platform policy). */
  readonly readClipboardText: OptionCapability<'readClipboardText'>
}

/** The Plugin Manager owner: the controller/panel wiring for both entries. */
export interface SurfacePluginManager {
  /** The `/plugins` entry (a second open is a no-op). */
  open(): void
  /** The `/settings → Plugins` entry: the SAME panel hosted as a submenu. */
  submenu(done: (selected?: string) => void): Component
}

/** The mounted-surface inputs the extension chrome attach needs. */
export interface SurfaceSeamDeps {
  /** The late-bound command-completion refresh (a client command contribution
   *  may join the `/` menu after mount). */
  readonly refreshCommandCompletions: () => void
}

/** The creation options: the early surface state + the Client-local sinks. */
export interface SurfaceRuntimeOptions {
  /** The TUI package version rendered in the initial status snapshot. */
  readonly tuiVersion: string
  /** The guarded terminal sink shared with the runner's fatal-path focus
   *  disable (the sink is stateless; both writers emit the same sequences). */
  readonly notificationWriter: TerminalNotifierWriter
  /** The persisted notification settings at startup (parsed by the owner). */
  readonly notificationMode: string | undefined
  readonly notificationMethod: string | undefined
}

/** One completion status fact (the controller's parameter type). */
type AgentLifecycleStatus = Parameters<CompletionNotificationController['onAgentStatus']>[1]

/** The surface owner the runner/bootstrap consumes. */
export interface SurfaceRuntime<Event> {
  /** The mounted TuiApp. Throws if read before {@link SurfaceRuntime.start}. */
  readonly app: TuiApp
  /** The unified status projection store (surface-owned instance). */
  readonly status: StatusStore
  /** The opening-session journal (surface-owned instance). */
  readonly openingJournal: OpeningJournal<Event>
  /**
   * The completion-owner fence (A2 seam): the notification controller fences by
   * the EXACT Direct `Agent.id` — a late `agent/status` from a retired agent
   * must never notify. `undefined` on the teardown path.
   */
  setCompletionOwner(identity: string | undefined): void
  /** The ONLY completion-controller status feed (the `agent/status` handler). */
  onAgentStatus(agentId: string, status: AgentLifecycleStatus): void
  /** The notification settings write path (`/notify`, `agent/status` policy). */
  setNotificationMode(mode: string): void
  setNotificationMethod(method: string): void
  /** A terminal focus report (CSI ? 1004): the tracker only records state. */
  handleTerminalFocus(focused: boolean): void
  /** Any REAL input proves the user is operating the terminal (restores
   *  'focused' so a missed FOCUS_IN never falsely notifies). */
  noteUserInput(): void
  /** Enable focus reporting at mount (CSI ? 1004). */
  enableFocusReporting(): void
  /** Disable focus reporting on every exit path (idempotent). */
  disableFocusReporting(): void
  /**
   * Acquire the extension surface host + theme-unload hook (M3 wiring). The
   * runner resolves the service (never this module) and calls this at the
   * original wiring position, before {@link SurfaceRuntime.start}.
   */
  attachExtensionHost(extensionService: SurfaceExtensionService): void
  /**
   * Acquire the Plugin Manager controller/panel owner (P1-A). Called at the
   * original controller-creation position, before the mount.
   */
  attachPluginManager(deps: { readonly port: PluginManagerPort; readonly diag: Diag }): SurfacePluginManager
  /** Sync + subscribe the plugin keybindings from the attached service (M2). */
  bindPluginKeybinds(): void
  /** Attach the extension host to the mounted surface chrome (M3/F-1). */
  attachSurfaceSeams(deps: SurfaceSeamDeps): void
  /** Mount the process TUI. Runs at most once. */
  start(deps: SurfaceMountDeps): void
  /**
   * Early teardown: release the Plugin Manager install-event subscription at
   * its original EARLY cleanup position (a late install event must never
   * notify/repaint a dying surface).
   */
  disposePluginManager(): void
  /** Idempotent release of every surface-owned resource. Safe before `start`. */
  dispose(): void
}

/** Create the surface owner; the status store and journal exist immediately. */
export function createSurfaceRuntime<Event>(options: SurfaceRuntimeOptions): SurfaceRuntime<Event> {
  const status = new StatusStore(initialStatusSnapshot(options.tuiVersion))
  const openingJournal = createOpeningJournal<Event>()
  // Completion notifications (A4-4): settled detection, focus detection,
  // terminal output and settings parsing stay separate modules, never a blob.
  // The controller consumes the AUTHORITATIVE `agent/status` runtime fact (same
  // live main agent, observed running -> idle) — never `turn/end`, timers or
  // debounces. The sink wrapper contains synchronous throws so a notification
  // failure can never crash the TUI.
  const terminalNotifier = new TerminalNotifier(options.notificationWriter)
  const completionController = new CompletionNotificationController((method, title, body) => {
    try {
      terminalNotifier.notify(method, title, body)
    } catch {
      // A notification failure is Client-local UX: never crash the TUI.
    }
  })
  const terminalFocusTracker = new TerminalFocusTracker()
  completionController.setMode(parseNotificationMode(options.notificationMode))
  completionController.setMethod(parseNotificationMethod(options.notificationMethod))
  let app: TuiApp | undefined
  let disposed = false
  // The extension surface resources (A4-5); each has exactly one acquire point
  // (`attach*`/`bind*`) and one release owner (`disposePluginManager`/`dispose`).
  let extensionService: SurfaceExtensionService | undefined
  let extensionHost: SurfaceHost | undefined
  let releaseThemeUnloadedHook: (() => void) | undefined
  let stopPluginKeybindingSync: (() => void) | undefined
  let pluginManagerController: PluginManagerController | undefined

  /** The mounted app for a callback that can only run while the surface is
   *  live (the original wiring read the runner's `app` binding directly). */
  const mounted = (): TuiApp => {
    if (app === undefined) throw new Error('the surface is not mounted')
    return app
  }

  const buildOptions = (deps: SurfaceMountDeps): TuiAppOptions => ({
    // Ctrl+R input-history search: the runner owns the IO (the file-backed
    // source + the known-cwd identity map), the surface owns the panel
    // lifecycle (plan §27 — TuiApp never touches the filesystem).
    historySearchSource: deps.historySearchSource,
    historySearchCwd: () => deps.sessionCwd(),
    // The session scope's identity — a GETTER like the cwd: a session switch
    // must make the next Ctrl+R search the NEW session (the panel captures it
    // once at open time).
    historySearchSessionId: () => deps.sessionId(),
    // The transcript image surface (plan M8/M9): the durable loader plus the
    // dim fallback coloring.
    imageLoader: new ImageLoader(deps.readImage),
    imageTheme: { fallbackColor: color.textDim },
    present: deps.present,
    workspaceRoot: deps.workspaceRoot,
    // The structural icon palette: read ONCE at startup from the persisted
    // document; runtime switches go through app.setIconStyle (the /settings
    // write path) — never a deep settings read per render.
    iconStyle: deps.iconStyle,
    extensionHost,
    // M0: the unified status projection store (the app projects its own
    // surface state into it; the runner derives the DSH-owned sections).
    statusStore: status,
    displayState: deps.displayState,
    // M5: a material width change refreshes the command surface (the runner
    // coalesces to its interval).
    onTerminalResize: deps.onTerminalResize,
    // Issue #7: the fullscreen drag selection and /copy are the SAME user copy
    // intent and share ONE clipboard policy owned by the runner.
    copySelection: deps.copySelection,
    // Fullscreen OSC 8 link clicks + the Windows right-click paste.
    openExternalUrl: deps.openExternalUrl,
    readClipboardText: deps.readClipboardText,
    // M7/M9: the transcript/tool renderer + editor registries.
    renderers: extensionService?.renderers,
    editorRegistry: extensionService?.editors,
    // M6: non-capturing plugin keybindings. The resolver reads the service
    // LAZILY and normalizes through the InputRouter — a plugin binding
    // resolves against normalized keys only, never raw terminal data.
    pluginActionFor: (normalized) => extensionService?.keybindings.actionFor(normalized),
    pluginActionIdFor: (normalized) => extensionService?.keybindings.idFor(normalized),
    // Phase 2: the ADVANCED normalized input capture route (consulted after
    // the host's own capturing flows, before the editor and Stable keys).
    advancedInputRoute: (data) => extensionService?._advancedInputRoute(data) ?? 'passed',
    // Phase 3: the UNSTABLE raw input route, consulted before terminal
    // protocol decoding; the emergency fail-safe is Host-recovery only.
    unstableInputRoute: (data, surfaceId) => extensionService?._unstableInputRoute(data, surfaceId) ?? { action: 'pass' },
    unstableInputsLive: () => extensionService?._unstableInputsLive() ?? false,
    unstableInputsRevision: () => extensionService?._unstableInputsRevision() ?? 0,
    unstableFailSafeRelease: () => extensionService?._unstableEmergencyRelease(),
    // PR2: the semantic Workflow card actions (member open / scoped agent
    // browse). The handler is declared by the runner (it needs the task
    // browser + viewer openers); the closure only runs on a user click.
    onWorkflowAction: (action) => deps.handleWorkflowAction(action),
  })

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
    mounted().keybindingsManager().setPluginRules(snapshot.bindings.map(binding => ({
      id: binding.id,
      action: binding.action,
      key: normalizedKeyToKeyId(binding.key),
    })))
  }

  return {
    get app(): TuiApp {
      if (app === undefined) throw new Error('the surface is not mounted')
      return app
    },
    status,
    openingJournal,
    setCompletionOwner(identity) {
      completionController.setLiveAgent(identity)
    },
    onAgentStatus(agentId, status) {
      completionController.onAgentStatus(agentId, status)
    },
    setNotificationMode(mode) {
      completionController.setMode(parseNotificationMode(mode))
    },
    setNotificationMethod(method) {
      completionController.setMethod(parseNotificationMethod(method))
    },
    handleTerminalFocus(focused) {
      terminalFocusTracker.handleFocusReport(focused ? FOCUS_IN_SEQUENCE : FOCUS_OUT_SEQUENCE)
      completionController.setFocus(terminalFocusTracker.state)
    },
    noteUserInput() {
      terminalFocusTracker.markFocused()
      completionController.setFocus(terminalFocusTracker.state)
    },
    enableFocusReporting() {
      // The guarded writer swallows a broken-stream error; a synchronous throw
      // is contained so a dead stdout can never fail the TUI mount.
      try {
        options.notificationWriter.write(ENABLE_FOCUS_REPORTING)
      } catch {
        // A broken stdout degrades the notification capability silently.
      }
    },
    disableFocusReporting() {
      // Disable terminal focus reporting on every exit path so the mode can
      // never leak into the shell; idempotent (a startup failure that never
      // enabled it writes a harmless no-op).
      try {
        options.notificationWriter.write(DISABLE_FOCUS_REPORTING)
      } catch {
        // The stream may already be gone during teardown; best effort.
      }
    },
    attachExtensionHost(service) {
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
    attachPluginManager(deps) {
      // ONE controller/panel for both entries (`/plugins` and
      // `/settings → Plugins`). The port is the narrow semantic adapter; the
      // presentation classification reads only the shared extension runtime's
      // own health records — never a second inventory or a second manager. The
      // token-owned registry distinguishes a normal close from an external
      // Settings teardown (see its module header).
      const hosts = new PluginManagerHostRegistry()
      const controller = new PluginManagerController(deps.port, {
        requestRender: () => { if (hosts.isOpen()) mounted().requestRender() },
        requestClose: () => hosts.closeActive(),
        notify: (message, kind) => mounted().notify(message, kind),
        isOpen: () => hosts.isOpen(),
        diag: deps.diag,
      }, {
        observations: () => extensionService === undefined ? [] : observeTuiExtensions({
          healthSnapshot: () => extensionService!._ledger().healthSnapshot(),
          ownerEntryIds: () => extensionService!._ownerEntryIds(),
        }),
      })
      pluginManagerController = controller
      const open = (): void => {
        // A second open is a no-op: the panel is already the active surface.
        if (hosts.isOpen()) return
        let close: () => void = () => {}
        const claim = hosts.claim(() => close())
        const panel = new PluginManagerPanel(controller, () => mounted().requestRender(), {
          // Any hide path that disposes the panel releases this owner exactly
          // once (a normal close and an external teardown are the same here).
          onDispose: () => claim.releaseExternally(),
        })
        close = mounted().openPluginManagerPanel(panel, () => claim.releaseExternally())
        controller.open('direct-command')
      }
      const submenu = (done: (selected?: string) => void): Component => {
        let claim: PluginManagerHostClaim | undefined
        const panel = new PluginManagerPanel(controller, () => mounted().requestRender(), {
          // The Settings parent may dispose this submenu WITHOUT calling
          // `done` (the fork's lifecycle contract): release only the OWNER.
          onDispose: () => claim?.releaseExternally(),
        })
        // The user close path returns to Settings; an external teardown must
        // not.
        claim = hosts.claim(() => claim?.closeNormally(), done)
        controller.open('settings-submenu')
        return panel
      }
      return { open, submenu }
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
    attachSurfaceSeams(deps: SurfaceSeamDeps) {
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
    start(deps) {
      if (disposed) throw new Error('the surface is already disposed')
      if (app !== undefined) throw new Error('the surface is already mounted')
      // The TUI is about to mount: the app takes over the terminal now, and
      // the same instance is what dispose() releases.
      app = startProcessTui(deps.events, buildOptions(deps))
    },
    disposePluginManager() {
      // Release the Plugin Manager install-event subscription. This never
      // cancels a Host install: only the official cancel action does that.
      pluginManagerController?.dispose()
    },
    dispose() {
      if (disposed) return
      disposed = true
      // The mounted app is released first (its options captured the extension
      // host), then the extension surface resources in the runner's original
      // cleanup order.
      app?.dispose()
      // M2: unsubscribe the plugin keybinding sync (the registry outlives the
      // surface — a stale listener must not resync into a dead app).
      stopPluginKeybindingSync?.()
      stopPluginKeybindingSync = undefined
      // Release THIS generation's theme-unload hook: without the generation
      // lease, the old callback (capturing the disposed app) would stay
      // installed until the next runner installed its own.
      releaseThemeUnloadedHook?.()
      releaseThemeUnloadedHook = undefined
      // Detach the extension service's surface bridge (its capability set and
      // state listeners die with the surface). The surfaceId lease makes a
      // stale detach a no-op (P1).
      extensionService?.detachSurface(extensionHost?.surfaceId)
      extensionHost = undefined
    },
  }
}
