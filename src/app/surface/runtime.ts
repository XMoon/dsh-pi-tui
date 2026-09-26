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
 * - the runner still owns the application input contract: it hands the
 *   `TuiAppEvents` table in at `start()`, because that table is the
 *   session/submission/command owners' contract with the surface (A5 moves the
 *   composition into `app/bootstrap.ts`).
 *
 * The mount is TWO-PHASE by lifecycle necessity: the status store and the
 * opening journal exist long before the surface mounts (startup derives
 * status, the first transition opens a journal), while the mount needs
 * capabilities that only resolve later in startup. `createSurfaceRuntime`
 * therefore owns the early state and `start()` performs the mount once the
 * capabilities exist.
 *
 * Host coupling: this module reads NO Host business service and imports NO
 * Direct wiring (plan §4.3). Everything it needs arrives as a narrow injected
 * capability or a semantic port.
 *
 * @module app/surface/runtime
 */

import { startProcessTui, type TuiApp, type TuiAppEvents, type TuiAppOptions } from '../../tui-app.ts'
import { color } from '../../theme.ts'
import { ImageLoader } from '../../image/loader.ts'
import type { ImageAttachmentRefLike } from '../../image/admission.ts'
import { StatusStore } from '../../status/store.ts'
import { initialStatusSnapshot } from '../../status/snapshot.ts'
import { createOpeningJournal, type OpeningJournal } from './opening-journal.ts'

/** One non-optional capability borrowed from the TuiApp option contract. */
type OptionCapability<Key extends keyof TuiAppOptions> = NonNullable<TuiAppOptions[Key]>

/**
 * The extension surface service as the surface consumes it: the registries
 * that render/route chrome content and the advanced/unstable input seams. The
 * member types are DERIVED from the TuiApp option contract, so this narrow
 * view can never drift from what the app actually accepts. The runner resolves
 * the concrete service; `app/surface` never becomes a Host service locator.
 */
export interface SurfaceExtensionService {
  readonly renderers: OptionCapability<'renderers'>
  readonly editors: OptionCapability<'editorRegistry'>
  readonly keybindings: {
    readonly actionFor: OptionCapability<'pluginActionFor'>
    readonly idFor: OptionCapability<'pluginActionIdFor'>
  }
  readonly _advancedInputRoute: OptionCapability<'advancedInputRoute'>
  readonly _unstableInputRoute: OptionCapability<'unstableInputRoute'>
  readonly _unstableInputsLive: OptionCapability<'unstableInputsLive'>
  readonly _unstableInputsRevision: OptionCapability<'unstableInputsRevision'>
  readonly _unstableEmergencyRelease: OptionCapability<'unstableFailSafeRelease'>
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
  /** Live known-cwd resolver for the all-scope history search. */
  readonly knownHistoryCwds: () => Map<string, string>
  /** The live session cwd the history search's `current` scope resolves against. */
  readonly sessionCwd: () => string
  /** The live session identity the history panel captures at open time. */
  readonly sessionId: () => string | undefined
  /** Material terminal-width change (the command surface coalesces its refresh). */
  readonly onTerminalResize: OptionCapability<'onTerminalResize'>
  /** Semantic Workflow card actions (member open / scoped agent browse). */
  readonly handleWorkflowAction: (action: Parameters<OptionCapability<'onWorkflowAction'>>[0]) => void
  /** The resolved extension surface service, when the deployment provides one. */
  readonly extensionService: SurfaceExtensionService | undefined
  /** The extension surface host attached to this surface (M2), when present. */
  readonly extensionHost: import('../../extension/internal/surface-host.ts').SurfaceHost | undefined
  /** Fullscreen drag-selection copy (the runner owns the clipboard policy). */
  readonly copySelection: OptionCapability<'copySelection'>
  /** OSC 8 link activation (the runner owns the platform opener). */
  readonly openExternalUrl: OptionCapability<'openExternalUrl'>
  /** Right-click clipboard read (the runner owns the platform policy). */
  readonly readClipboardText: OptionCapability<'readClipboardText'>
}

/** The surface owner the runner/bootstrap consumes. */
export interface SurfaceRuntime<Event> {
  /** The mounted TuiApp. Throws if read before {@link SurfaceRuntime.start}. */
  readonly app: TuiApp
  /** The unified status projection store (surface-owned instance). */
  readonly status: StatusStore
  /** The opening-session journal (surface-owned instance). */
  readonly openingJournal: OpeningJournal<Event>
  /** Mount the process TUI. Runs at most once. */
  start(deps: SurfaceMountDeps): void
  /** Idempotent release of every surface-owned resource. Safe before `start`. */
  dispose(): void
}

/** Create the surface owner; the status store and journal exist immediately. */
export function createSurfaceRuntime<Event>(options: { readonly tuiVersion: string }): SurfaceRuntime<Event> {
  const status = new StatusStore(initialStatusSnapshot(options.tuiVersion))
  const openingJournal = createOpeningJournal<Event>()
  let app: TuiApp | undefined
  let disposed = false

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
    extensionHost: deps.extensionHost,
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
    renderers: deps.extensionService?.renderers,
    editorRegistry: deps.extensionService?.editors,
    // M6: non-capturing plugin keybindings. The resolver reads the service
    // LAZILY and normalizes through the InputRouter — a plugin binding
    // resolves against normalized keys only, never raw terminal data.
    pluginActionFor: (normalized) => deps.extensionService?.keybindings.actionFor(normalized),
    pluginActionIdFor: (normalized) => deps.extensionService?.keybindings.idFor(normalized),
    // Phase 2: the ADVANCED normalized input capture route (consulted after
    // the host's own capturing flows, before the editor and Stable keys).
    advancedInputRoute: (data) => deps.extensionService?._advancedInputRoute(data) ?? 'passed',
    // Phase 3: the UNSTABLE raw input route, consulted before terminal
    // protocol decoding; the emergency fail-safe is Host-recovery only.
    unstableInputRoute: (data, surfaceId) => deps.extensionService?._unstableInputRoute(data, surfaceId) ?? { action: 'pass' },
    unstableInputsLive: () => deps.extensionService?._unstableInputsLive() ?? false,
    unstableInputsRevision: () => deps.extensionService?._unstableInputsRevision() ?? 0,
    unstableFailSafeRelease: () => deps.extensionService?._unstableEmergencyRelease(),
    // PR2: the semantic Workflow card actions (member open / scoped agent
    // browse). The handler is declared by the runner (it needs the task
    // browser + viewer openers); the closure only runs on a user click.
    onWorkflowAction: (action) => deps.handleWorkflowAction(action),
  })

  return {
    get app(): TuiApp {
      if (app === undefined) throw new Error('the surface is not mounted')
      return app
    },
    status,
    openingJournal,
    start(deps) {
      if (disposed) throw new Error('the surface is already disposed')
      if (app !== undefined) throw new Error('the surface is already mounted')
      // The TUI is about to mount: the app takes over the terminal now, and
      // the same instance is what dispose() releases.
      app = startProcessTui(deps.events, buildOptions(deps))
    },
    dispose() {
      if (disposed) return
      disposed = true
      app?.dispose()
      app = undefined
    },
  }
}
