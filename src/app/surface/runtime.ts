/**
 * SurfaceRuntime (A4): the ONE application owner of the mounted TUI surface.
 *
 * TS3 split the independent surface lifetimes into explicit application-level
 * owners NEXT TO this aggregate (each constructed exactly once by
 * `createSurfaceRuntime()`, each owning its own state and disposal hook):
 *
 * ```text
 * notification-runtime.ts     completion notification + terminal focus (§31)
 * extension-runtime.ts        extension host/hook/keybinding/attachment seams (§32)
 * plugin-manager-runtime.ts   the ONE PluginManagerController + both entries (§33)
 * task-runtime.ts             Task Center + Job viewer state machine (§34)
 * interaction-runtime.ts      approval/question attachment + attention (§35)
 * event-routing.ts            application-level presentation event routing (§36)
 * ```
 *
 * The aggregate keeps the cross-sub-owner wiring and the ordered teardown, and it
 * stays the mounted-app owner.
 *
 * Ownership kept here (plan §7/§11/§12/§37):
 *
 * - the mounted `TuiApp` is CREATED here (`startProcessTui`) and disposed here;
 * - the opening-session journal instance and the status projection store are
 *   surface-owned concrete state;
 * - the surface-local TuiApp OPTION wiring lives here (image loader, history
 *   search binding, clipboard/link capabilities, extension registries and
 *   input routes, resize/workflow hooks);
 * - the status COMMIT coordination (`commitStatus`: `status.update` then the
 *   legacy `setStatus`) and the pending-input presentation (the semantic read +
 *   submission-echo join, the own-input viewport policy and the atomic
 *   publication) live here (A4-4, plan §13). The runner keeps the semantic
 *   status derivation and injects only the pending subject/snapshot, the
 *   submission echoes and the text projection;
 * - the active presentation TARGET selection (main vs viewed child), the
 *   repaint SCHEDULING (the coalescing flush timer and the projection glue) and
 *   the transcript-navigation / Ctrl+R search presentation callback wiring live
 *   here (A4-8, plan §17). The runner keeps the transcript/search/viewport
 *   ALGORITHMS (`domain/transcript/**`, `search-overlay.ts`)
 *   and the state INSTANCES, injected through the routing source; moving that
 *   view ownership to `tui/**` is TS6;
 * - the Task Center / Job viewer state machine is delegated to `task-runtime.ts`
 *   (§34) and the presentation event ROUTING to `event-routing.ts` (§36): the
 *   aggregate forwards the attach/acquire calls and the routing entries, and
 *   wires each sub-owner's cross-owner callbacks. The runner still keeps the
 *   Cordis registrations as thin delegations, the Direct assistant-stream
 *   INSTALL, the Direct/domain bookkeeping and the presentation-target
 *   instances, injected through the narrow `SurfaceEventRoutingSource` bundle;
 * - the runner still owns the application input contract: it hands the
 *   `TuiAppEvents` table in at `start()`, because that table is the
 *   session/submission/command owners' contract with the surface (A5 moves the
 *   composition into `app/bootstrap.ts`).
 *
 * The mount is TWO-PHASE by lifecycle necessity: the status store, the opening
 * journal and the notification presentation exist long before the surface
 * mounts (startup derives status, the first transition opens a journal and the
 * resume commit resets the completion owner), while the mount needs
 * capabilities that only resolve later in startup. `createSurfaceRuntime`
 * therefore owns the early state, the `attach*`/`bind*` methods acquire the
 * surface resources at their ORIGINAL startup positions (startup order is
 * behavior), and `start()` performs the mount once the capabilities exist.
 *
 * Resource lifetime (plan §12.2/§38/§40) — one acquire point and one release
 * owner per resource; the runner only ORCHESTRATES the release order, and the
 * aggregate coordinates the cross-sub-owner disposal:
 *
 * | Resource | Acquired by | Released by |
 * |---|---|---|
 * | status store, journal, notification presentation | `createSurfaceRuntime` | process end (no release step) |
 * | extension host + theme-unload hook | `attachExtensionHost()` | `extension.dispose()` |
 * | Plugin Manager controller + subscription | `attachPluginManager()` | `disposePluginManager()` (early position) |
 * | plugin keybinding sync | `bindPluginKeybinds()` | `extension.dispose()` |
 * | question controller + attention subscription | `attachInteraction()` | `interaction.dispose()` |
 * | mounted `TuiApp` | `start()` | `dispose()` |
 * | jobs-event subscription | `attachTasks()` | `task.disposeJobEvents()` |
 * | Job observer + viewer | `openJobView()`/`openJobStatusViewer()` | `task.disposeJobObservation()` |
 * | task browser handle/token/rows/scope | `openTasksBrowser()` | `task.disposeTaskBrowser()` |
 *
 * `disposePluginManager()` and `dispose()` are idempotent, and every release
 * hook is safe before its acquire ran (the slots are optional). Teardown order
 * is behavior too: `dispose()` runs `interaction.dispose()` → the mounted app →
 * `extension.dispose()` (question attachment and answer lookup, app, plugin
 * keybinding sync, theme-unload hook, extension surface detach — the runner's
 * original order) while `disposePluginManager()` releases the Plugin Manager
 * subscription at its original EARLY position, and the Task Center hooks run in
 * the original `jobsEvents -> jobObservation -> taskBrowser` order (each one
 * releasing only its own slot). The remaining interleaved runner-owned steps stay
 * with their owners and the runner orchestrates them around these hooks. There is
 * deliberately NO partial-acquire rollback beyond that: `start()` is the last
 * acquire and a throwing mount leaves the process on the runner's fatal path,
 * which runs the same ordered cleanup.
 *
 * Host coupling: this module reads NO Host business service and imports NO
 * Direct wiring (plan §4.3). Everything it needs arrives as a narrow injected
 * capability or a semantic port.
 *
 * @module app/surface/runtime
 */

import {
  startProcessTui,
  type DisplaySubjectPresentation,
  type StatusData,
  type StreamingToolPreview,
  type TranscriptSearchCloseReason,
  type TranscriptSearchPresentation,
  type TranscriptSearchPresentationTarget,
  type TuiApp,
  type TuiAppEvents,
  type TuiAppOptions,
} from '../../tui-app.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import type { TaskBrowserDatasetScope } from './task-browser-runtime.ts'
import type { TaskBrowserViewState } from './task-runtime.ts'
import type { InteractionPort } from '../../runtime/interaction-port.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import { ImageLoader } from '../../client/media/image/loader.ts'
import type { ImageAttachmentRefLike } from '../../domain/media/types.ts'
import { StatusStore } from '../../domain/status/store.ts'
import type { StatusPatch } from '../../domain/status/types.ts'
import { initialStatusSnapshot } from '../../domain/status/snapshot.ts'
import type { TranscriptFolder } from '../../domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import type { TranscriptSearchMatch } from '../../domain/transcript/search.ts'
import type { TranscriptWindowController } from '../../domain/transcript/window.ts'
import { streamingToolPreviewSnapshot } from '../../streaming-tool-preparing.ts'
import { buildPendingPresentation } from './pending-presentation.ts'
import { refreshedSearchState, steppedSearchOverlayState } from '../../search-overlay.ts'
import { createSearchProfiler, searchProfilingEnabled, type SearchProfile } from '../../search-profile.ts'
import { createOpeningJournal, type OpeningJournal } from './opening-journal.ts'
import { parseTerminalProgressMode } from '../../domain/terminal-progress/settings.ts'
// TS3 §31-§36: the surface's independent application-level owners. Each is
// constructed exactly once here; none of them imports this aggregate's value
// implementation (only its cross-owner facade types).
import { createNotificationRuntime, type AgentLifecycleStatus, type TerminalNotificationPresentation } from './notification-runtime.ts'
import {
  createExtensionRuntime,
  type OptionCapability,
  type SurfaceExtensionService,
  type SurfaceSeamDeps,
} from './extension-runtime.ts'
import { createPluginManagerRuntime, type PluginManagerAttachDeps, type PluginManagerPanelFactory, type SurfacePluginManager } from './plugin-manager-runtime.ts'
import { createInteractionRuntime, type SurfaceInteractionDeps } from './interaction-runtime.ts'
import {
  createTaskRuntime,
  type TaskSurfaceDeps,
  type TaskSurfaceRead,
  type TaskSurfaceSource,
} from './task-runtime.ts'
import {
  createEventRouting,
  type RoutedSessionEvent,
  type SurfaceEventRoutingSource,
} from './event-routing.ts'

// The moved public/internal surface types stay importable from this exact path
// (the aggregate remains the stable entry for its consumers).
export { jobStopNotice } from './task-runtime.ts'
export type { AgentLifecycleStatus } from './notification-runtime.ts'
export type { OptionCapability, SurfaceExtensionService, SurfaceSeamDeps } from './extension-runtime.ts'
export type { PluginManagerAttachDeps, SurfacePluginManager } from './plugin-manager-runtime.ts'
export type { SurfaceInteractionDeps } from './interaction-runtime.ts'
export type { TaskBrowserViewState, TaskSurfaceDeps, TaskSurfaceJobs, TaskSurfaceRead, TaskSurfaceSource } from './task-runtime.ts'
export type {
  RoutedSessionEvent,
  SurfaceEventRoutingSource,
  SurfaceEventSink,
  SurfaceMainEventObservation,
  SurfaceMainPresentation,
  SurfaceViewedChildPresentation,
} from './event-routing.ts'

/** Coalesced repaint interval for streaming events, in ms (A4-8, plan §17). */
const REPAINT_FLUSH_MS = 50
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
  /** Durable-attachment read for the image loader (the runner owns Host access).
   *  The `context` is the OWNING presentation's scope, captured by the renderer
   *  ONCE when it constructs the thumbnail and kept immutably by that component —
   *  the loader merely forwards it — so the deferred read can never be re-routed to
   *  another Session by a viewer exit/switch (or a same-id reopen) in between. */
  readonly readImage: (
    ref: ImageAttachmentRefLike,
    context?: unknown,
  ) => Promise<{ ref: unknown; data: Uint8Array }>
  /** The presentation scope the image loader must key reads by. The renderer
   *  samples it ONCE when it constructs an `ImageThumbnail` (from the presentation
   *  being built) and the component keeps it immutably; the loader never resolves a
   *  subject itself. REQUIRED by this mount contract — a mount that cannot answer it
   *  could send a child ref to the parent Session. It may legitimately return
   *  `undefined` when no presentation owns the transcript yet. */
  readonly imageScope: () => unknown
  /** Tool-card presentation bridge (the runner resolves the live tool registry). */
  readonly present: OptionCapability<'present'>
  /** The live session cwd the history search's `current` scope resolves against. */
  readonly sessionCwd: () => string
  /** The live session identity the history panel captures at open time. */
  readonly sessionId: () => string | undefined
  /** Material terminal-width change (the command surface coalesces its refresh). */
  readonly onTerminalResize: OptionCapability<'onTerminalResize'>
  /** Fullscreen drag-selection copy (the runner owns the clipboard policy). */
  readonly copySelection: OptionCapability<'copySelection'>
  /** Headless-test seam (M3-4 PR3 image L6): the runner's live image draft
   * store, forwarded to TuiAppOptions.draftImageStoreForTest. Production
   * paths never read it. */
  readonly draftImageStoreForTest?: import('../../client/media/image/draft-store.ts').DraftImageStore
  /** OSC 8 link activation (the runner owns the platform opener). */
  readonly openExternalUrl: OptionCapability<'openExternalUrl'>
  /** Right-click clipboard read (the runner owns the platform policy). */
  readonly readClipboardText: OptionCapability<'readClipboardText'>
  /** The dim fallback colour for the transcript image theme (TS8-E): the
   * composition zone supplies it from `tui/theme/runtime.ts`, so no
   * application owner imports a `tui/**` path. */
  readonly imageFallbackColor: (text: string) => string
}

/** The creation options: the early surface state + the Client-local sinks. */
export interface SurfaceRuntimeOptions {
  /** The TUI package version rendered in the initial status snapshot. */
  readonly tuiVersion: string
  /**
   * The concrete terminal notification presentation (TS5 §14.3): the
   * composition zone selects the TUI implementation and injects it here, so no
   * application owner imports a `tui/**` path.
   */
  readonly notificationPresentation: TerminalNotificationPresentation
  /** The persisted notification settings at startup (parsed by the owner). */
  readonly notificationMode: string | undefined
  readonly notificationMethod: string | undefined
  /** The persisted native-terminal-progress preference at startup ('on'
   *  default | 'off'), parsed through the shared terminal-progress parser. */
  readonly terminalProgress: string | undefined
  /**
   * The concrete Plugin Manager terminal panel factory (TS4 §8/§10): the
   * composition zone selects the TUI implementation and injects it here, so no
   * application owner imports a `tui/**` path.
   */
  readonly createPluginManagerPanel: PluginManagerPanelFactory
}

/** The surface owner the runner/bootstrap consumes. */
export interface SurfaceRuntime<Event extends RoutedSessionEvent> {
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
  /**
   * A4-4 status COMMIT coordination (plan §13.1): the runner keeps the
   * semantic derivation; the surface commits the derived patch, the legacy
   * footer facts and the display-subject presentation projection of the SAME
   * subject in ONE atomic TuiApp commit (M3-5 PR1 §9.7).
   */
  commitStatus(
    patch: StatusPatch,
    /** The LIVE session's legacy display fields (see `StatusRuntimeDeps`). */
    legacyFacts: Partial<StatusData>,
    presentation: DisplaySubjectPresentation | undefined,
  ): void
  /** The notification settings write path (`/notify`, `agent/status` policy). */
  setNotificationMode(mode: string): void
  setNotificationMethod(method: string): void
  /** The native-terminal-progress preference write path (`/settings` row):
   *  parse the raw mode through the shared parser and gate the mounted app's
   *  physical OSC 9;4 projection. Never a persistence authority. */
  setTerminalProgressMode(mode: string): void
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
  attachPluginManager(deps: PluginManagerAttachDeps): SurfacePluginManager
  /** Sync + subscribe the plugin keybindings from the attached service (M2). */
  bindPluginKeybinds(): void
  /** Attach the extension host to the mounted surface chrome (M3/F-1). */
  attachSurfaceSeams(deps: SurfaceSeamDeps): void
  /**
   * Acquire the Task Browser + Job viewer wiring (A4-6, plan §15). Called at
   * the original jobs/subagents wiring position: the surface constructs the
   * `TaskBrowserRuntime` from the injected {@link TaskSurfaceSource} and owns
   * the browser handle, the row-identity source, the jobs-event subscription
   * and the selected-Job observation lifetime.
   */
  attachTasks(source: TaskSurfaceSource, deps: TaskSurfaceDeps): void
  /** The dock/roster feed (the original `refreshTasks`). */
  refreshTasks(): void
  /** A CATALOG refresh of the subagent half (re-lists descendants). */
  refreshAgents(): void
  /** A RUNTIME-only refresh of the subagent half (NEVER re-lists). */
  refreshAgentRuntimeOnly(): void
  /** Whether one child id is a member of the cached descendant catalog. */
  hasTask(childId: string): boolean
  /** Reset the whole Task Center on a session-generation bump. */
  resetTasks(): void
  /** Open the Task Browser (`quick` = the ↓ trigger, `full` = `/tasks`). */
  openTasksBrowser(
    viewMode: 'quick' | 'full',
    restoreState?: TaskBrowserViewState,
    scope?: TaskBrowserDatasetScope,
    header?: string,
  ): void
  /** Open one Job from the Task Browser (a subagent job may replace it). */
  openJobView(jobId: string): 'close' | 'keep-open'
  /** Register the approval/question presentation providers (A4-7, §13.3/§16). */
  attachInteraction(port: InteractionPort, deps: SurfaceInteractionDeps): void
  /**
   * Attach the A4-7 presentation event routing source (plan §16). The surface
   * owns every routing decision and the apply/paint calls; the runner keeps the
   * Cordis registrations as thin delegations. Called once before the
   * registrations are installed.
   */
  attachEventRouting(source: SurfaceEventRoutingSource<Event>): void
  /**
   * The `session/event` routing owner (plan §16.1): the opening-journal
   * decision/record, the opening-viewer buffer, the viewed-child vs main
   * selection, every same-session/exact-owner/cleanup fence, and the
   * per-target transcript/stats/preview APPLICATION.
   */
  routeSessionEvent(session: { readonly id: string }, event: Event): void
  /**
   * The subagent lifecycle presentation trigger (`subagent/start` /
   * `subagent/end`): a CATALOG refresh plus the pending-input microtask.
   */
  routeSubagentLifecycle(): void
  /**
   * The `agent/status` presentation routing: the completion-owner identity
   * branch (completion controller + pending-input microtask), then the
   * `hasTask` membership gate for children (runtime-only refresh, never a
   * re-listing), then the viewed-child pending-input microtask.
   */
  routeAgentStatus(agentId: string, status: AgentLifecycleStatus): void
  /** Provider-topology/credential refresh routing (footer model row + welcome). */
  routeProviderRefresh(): void
  /** Settings-document refresh routing (the llm namespace filter). */
  routeSettingsRefresh(namespace: string): void
  /**
   * The assistant-stream `isCurrentAgent` routing body: the exact Agent-identity
   * fence and the viewed-child Agent rollover. The Direct INSTALL stays in the
   * runner (`directRuntime.installAssistantStream`); this is the neutral
   * routing half it delegates to.
   */
  isCurrentAssistantAgent(agent: unknown): boolean
  /**
   * The assistant-stream `onInput` routing body: the opening-journal and
   * viewed-child fences, then the main/viewer fold + repaint. The Direct INSTALL
   * stays in the runner.
   */
  applyAssistantInput(input: AssistantLiveInput): void
  /**
   * Apply the resumed log's compaction bracket to the surface presentation
   * state (the cold-hydration path keeps the fold; the surface owns the
   * `compactingId` routing state and the phase/busy/working presentation).
   */
  applyResumedCompaction(id: string | undefined, active: boolean): void
  /**
   * A4-4 pending-input presentation refresh (plan §13.2): the semantic pending
   * read joined with the local submission echoes and the own-input viewport
   * policy.
   */
  refreshPendingInput(): void
  /**
   * A4-4: clear the pending-input presentation and the own-input memory at a
   * session-generation bump (the original `resetForGeneration` clearing).
   */
  resetPendingPresentation(): void
  /** A4-8: repaint the ACTIVE target through the coalescing flush timer. */
  schedulePaint(): void
  /** A4-8: cancel the flush timer and repaint the ACTIVE target now. */
  paintNow(): void
  /**
   * A4-8: repaint the ACTIVE target without touching the flush timer (the
   * original direct-`repaint` call sites on session/viewer transitions).
   */
  repaint(): void
  /** A4-8: clear the search presentation at a session-generation bump. */
  resetSearchPresentation(): void
  /**
   * M3-4 PR4 §6.4: clear the SUBJECT-OWNED status sections (access,
   * composition, collaboration) at a session-generation bump. This is the
   * session-lifecycle owner's explicit reset — the ONLY writer that may
   * clear a projection-owned permission preset (a legacy writer never
   * may). The new owner's own projections re-derive every section.
   */
  resetSubjectStatus(): void
  /**
   * Early teardown: release the jobs-event subscription at its original FIRST
   * cleanup position (before the Job observation and the browser handle), so
   * no Job listener can refresh a dying surface.
   */
  disposeJobEvents(): void
  /** Release the selected-Job observation + viewer (idempotent). */
  disposeJobObservation(): void
  /** Drop the Task Browser handle + delayed-action token (idempotent). */
  disposeTaskBrowser(): void
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
export function createSurfaceRuntime<Event extends RoutedSessionEvent>(options: SurfaceRuntimeOptions): SurfaceRuntime<Event> {
  const status = new StatusStore(initialStatusSnapshot(options.tuiVersion))
  const openingJournal = createOpeningJournal<Event>()
  let app: TuiApp | undefined
  let disposed = false
  // The surface-owned completion notification / focus presentation (A4-4) is
  // owned by its own module (TS3 §31); it exists from construction on and has
  // no teardown step (process-end state, exactly as before the split).
  const notification = createNotificationRuntime({
    presentation: options.notificationPresentation,
    notificationMode: options.notificationMode,
    notificationMethod: options.notificationMethod,
  })
  // The extension surface resources (A4-5) are owned by their own module
  // (TS3 §32): the extension host + theme-unload hook, the surface-scoped
  // attachment seams and the plugin-keybinding sync all live there now.
  const extension = createExtensionRuntime({ mounted: () => mounted() })
  // The surface <-> Plugin Manager glue (TS3 §33) owns the ONE controller per
  // surface plus both entries; the controller itself lives in
  // `app/plugin-manager/**`.
  const pluginManager = createPluginManagerRuntime({
    mounted: () => mounted(),
    service: () => extension.service(),
    createPanel: options.createPluginManagerPanel,
  })
  // A4-7 presentation event routing (plan §16): the injected routing source the
  // router and this aggregate's own pending-input/search coordination read. The
  // routing-local `compactingId` lives with the router.
  let routingSource: SurfaceEventRoutingSource<Event> | undefined

  /** The injected event-routing source; only reachable while attached. */
  const routing = (): SurfaceEventRoutingSource<Event> => {
    if (routingSource === undefined) throw new Error('the event routing source is not attached')
    return routingSource
  }

  /** The runner's cleanup latch for the aggregate's own moved bodies (the Task
   *  Center owner holds the SAME injected latch for its flows). */
  const isCleanedUp = (): boolean => task.isCleanedUp()

  /** The mounted app for a callback that can only run while the surface is
   *  live (the original wiring read the runner's `app` binding directly). */
  const mounted = (): TuiApp => {
    if (app === undefined) throw new Error('the surface is not mounted')
    return app
  }

  /**
   * The main-Agent pane-progress latch (plan §8.2): remembers the last
   * already-authorized main-Agent presentation state and projects it onto the
   * mounted app. Presentation state only — never a second Agent lifecycle
   * authority. It exists so an `agent/status` observed BEFORE the mount is not
   * lost; the routing layer above decides which statuses are eligible.
   */
  let mainAgentProgressActive = false
  const setMainAgentProgress = (active: boolean): void => {
    if (mainAgentProgressActive === active) return
    mainAgentProgressActive = active
    app?.setTerminalProgress(active)
  }

  // The approval/question presentation owner (TS3 §35) holds the ONE
  // `QuestionSurfaceController` plus its attention subscription. The attention
  // publication stays a PRESENTATION-only refresh: the count goes to the app
  // chrome and the Task Center (commit 7 moves the latter into its own owner).
  // The Task Center / Job viewer owner (TS3 §34) holds the ONE
  // `TaskBrowserRuntime`, the browser/viewer state and the catalog refresh gate.
  // Question attention crosses as an injected read/subscription only (the
  // controller stays with its own owner below).
  const task = createTaskRuntime({
    mounted: () => mounted(),
    isCleanedUp: () => isCleanedUp(),
    attention: {
      rows: () => interaction.attentionRows(),
      reconcile: () => interaction.controller()?.reconcile(),
      publish: () => interaction.publishAttention(),
      reopen: (sessionId, callId) => interaction.controller()?.reopen(sessionId, callId) ?? false,
    },
  })

  // The approval/question presentation owner (TS3 §35) holds the ONE
  // `QuestionSurfaceController` plus its attention subscription. The attention
  // publication stays a PRESENTATION-only refresh: the count goes to the app
  // chrome and the OPEN Task Center browser repaints through its own owner.
  const interaction = createInteractionRuntime({
    mounted: () => mounted(),
    liveApp: () => app,
    currentSessionId: () => routingSource?.currentSessionId(),
    schedulePaint: () => schedulePaint(),
    diag: () => task.diag(),
    isCleanedUp: () => isCleanedUp(),
    setQuestionAttention: (parkedCount) => mounted().setQuestionAttention(parkedCount),
    onAttentionChanged: () => task.refreshAttentionRows(),
  })

  // The application-level presentation event router (TS3 §36) owns the routing
  // decisions/fences and the routing-local compaction fold id; every target and
  // cross-owner effect arrives as an injected callback.
  const eventRouting = createEventRouting<Event>({
    source: () => routing(),
    mounted: () => mounted(),
    openingJournal,
    reconcileQuestions: () => interaction.controller()?.reconcile(),
    refreshAgents: () => task.refreshAgents(),
    refreshAgentRuntimeOnly: () => task.refreshAgentRuntimeOnly(),
    hasTaskChild: (childId) => task.hasTask(childId),
    feedCompletionStatus: (agentId, status) => notification.onAgentStatus(agentId, status),
    setMainAgentProgress: (active) => setMainAgentProgress(active),
    refreshPendingInput: () => refreshPendingInput(),
    schedulePaint: () => schedulePaint(),
    paintNow: () => paintNow(),
  })

  // ── A4-4/A4-8 presentation coordination (plan §13/§17) ──────────────────
  // The active-target SELECTION, the repaint SCHEDULING, the pending-input
  // presentation and the search/transcript presentation WIRING live here. The
  // runner-owned state instances (main/child folders, window controllers,
  // stats, streaming previews) arrive through the injected routing source; the
  // transcript/search/viewport ALGORITHMS stay in their own modules
  // (`domain/transcript/**`, `search-overlay.ts`).

  /** The main-vs-viewed-child presentation selection. */
  const viewedChildMounted = (): boolean => routing().viewedChildId() !== undefined
  const activeFolder = (): TranscriptFolder =>
    viewedChildMounted() ? routing().viewedChildFolder() : routing().mainFolder()
  const activeWindow = (): TranscriptWindowController =>
    viewedChildMounted() ? routing().viewedChild().window : routing().main().window
  const activeStreamingToolPreviews = (): readonly StreamingToolPreview[] => {
    if (!activeWindow().isLatest()) return []
    return streamingToolPreviewSnapshot(
      viewedChildMounted() ? routing().viewedChild().previews : routing().main().previews,
    )
  }

  // Coalesced repaint: streaming events fold into the folder immediately
  // (cheap) but the view rebuild flushes at most every REPAINT_FLUSH_MS, and
  // immediately on turn/end (`paintNow`).
  let repaintTimer: NodeJS.Timeout | undefined
  // Per-repaint search binding (perf plan S2 §5.2): assigned once the search
  // state below exists; undefined before that (and while no search is active
  // it returns undefined).
  let searchBindingForRepaint: (() => TranscriptSearchPresentation | undefined) | undefined

  /** Project one SELECTED target. The projection/geometry algorithms stay in
   *  `domain/transcript/**`; this is the repaint glue moved verbatim from the
   *  runner. */
  const repaintTarget = (
    folder: TranscriptFolder,
    controller: TranscriptWindowController,
    streamingToolPreviews: readonly StreamingToolPreview[],
    searchPresentation?: () => TranscriptSearchPresentation | undefined,
    onProjected?: () => void,
  ): void => {
    controller.setTurns(folder.groupedTurns())
    const endTurn = controller.endTurn()
    const projection = folder.window({
      maxTurns: controller.windowTurns,
      ...(endTurn === undefined ? {} : { endTurn }),
    })
    onProjected?.()
    mounted().setTranscript(projection.messages, folder.turnActivities(), {
      ...controller.state(),
      firstTurn: projection.firstTurn,
      lastTurn: projection.lastTurn,
      hasNewer: projection.hasNewer,
    }, streamingToolPreviews, (searchPresentation ?? searchBindingForRepaint)?.())
  }
  /** Repaint the ACTIVE target (main or the mounted viewed child). */
  const repaintActive = (
    searchPresentation?: () => TranscriptSearchPresentation | undefined,
    onProjected?: () => void,
  ): void => {
    repaintTarget(activeFolder(), activeWindow(), activeStreamingToolPreviews(), searchPresentation, onProjected)
  }
  const paintNow = (): void => {
    if (repaintTimer !== undefined) {
      clearTimeout(repaintTimer)
      repaintTimer = undefined
    }
    repaintActive()
  }
  const schedulePaint = (): void => {
    if (repaintTimer !== undefined) return
    repaintTimer = setTimeout(() => {
      repaintTimer = undefined
      repaintActive()
    }, REPAINT_FLUSH_MS)
  }

  // ── A4-4 pending-input presentation (plan §13.2) ────────────────────────
  /**
   * Own pending input must become VISIBLE even when the reader deliberately
   * browsed away from the live tail (official Web: an appended user node /
   * steering node / submission echo forces `toBottom`). Ownership is
   * EXPLICIT here — only a client-LOCAL submission echo is own input, so an
   * authoritative steering occurrence from another client, or a background
   * `context` occurrence, never steals the viewport. Keys are tracked per
   * SUBJECT, so entering/leaving the child viewer neither re-fires nor
   * forgets the parent's own input.
   */
  const pendingOwnInputBySubject = new Map<string, ReadonlySet<string>>()
  /**
   * Read one coherent pending-input projection and publish it to the app in
   * a SINGLE atomic presentation update: authoritative `queued` rows plus
   * local queued echoes (queue pane), and the ONE ordered conversation-tail
   * lane — authoritative `steering` rows, local user echoes and authoritative
   * non-user `context` occurrences in the join's projection order. Context
   * occurrences have a non-user visual identity and never correlate with a
   * local echo; correlation is by request/rpc identity only — never text.
   */
  const refreshPendingInput = (): void => {
    if (isCleanedUp()) return
    const source = routing()
    const sessionId = source.pendingSubjectId()
    const pending = sessionId === undefined
      ? undefined
      : source.pendingSnapshot(sessionId)
    // The client-local echoes are read from the submission-presentation seam
    // (Direct ledger today; the official pendingSubmissions source on the
    // experimental Remote path) so the two optimistic identities never run
    // together. The join below is the single authoritative rule.
    const subjectEchoes = source.submissionEchoes(sessionId) ?? []
    const { queued, tail, running } = buildPendingPresentation({
      pending,
      submissions: subjectEchoes,
      textOf: source.queueTextOf,
    })
    // Ownership: only a local echo bound for the TRANSCRIPT lane
    // (steering/transcript) is own input that may take the viewport. A local
    // QUEUED echo lives in the queue pane (chrome), and an authoritative
    // `context` occurrence is background/injected input — neither may move
    // the viewport. The key set is derived from the LEDGER (not the visible
    // rows), so an authoritative rpc-correlated replacement — or the Host
    // claim that re-presents the echo before the durable message — never
    // counts as a second new own input.
    const subjectKey = sessionId ?? ''
    const ownLaneKeys = new Set(
      subjectEchoes.filter(echo => echo.placement !== 'queued').map(echo => echo.requestId),
    )
    const previousOwnKeys = pendingOwnInputBySubject.get(subjectKey)
    const hasNewOwnInput = previousOwnKeys === undefined
      ? ownLaneKeys.size > 0
      : [...ownLaneKeys].some(key => !previousOwnKeys.has(key))
    // Keep only NON-EMPTY subject entries: an interactive child subject has
    // no local echo (echoes are main-session-only), so retaining an empty Set
    // per visited child would grow this map for the life of the parent
    // session. A non-empty parent entry must survive viewer round trips so
    // its existing own input does not re-fire as "new".
    if (ownLaneKeys.size === 0) pendingOwnInputBySubject.delete(subjectKey)
    else pendingOwnInputBySubject.set(subjectKey, ownLaneKeys)
    const live = mounted()
    if (hasNewOwnInput) {
      // The live tail may be outside the current virtual window (the reader
      // paged into history): move the subject's window back to latest BEFORE
      // presenting, so the local echo — and later its durable replacement —
      // are actually in the projection the viewport scrolls to.
      // A background `context` occurrence is NOT own input: it must never
      // trigger this branch, so a reader browsing history is never yanked
      // back to the live tail by background completion.
      const controller = activeWindow()
      if (!controller.isLatest()) {
        controller.latest()
        repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
      }
      live.setPendingInputPresentation({ queued, tail, running })
      live.scrollToBottom()
      return
    }
    live.setPendingInputPresentation({ queued, tail, running })
  }
  /** Clear the pending-input presentation + own-input memory (generation bump). */
  const resetPendingPresentation = (): void => {
    pendingOwnInputBySubject.clear()
    mounted().setPendingInputPresentation({ queued: [], tail: [], running: false })
  }

  // ── A4-8 search/transcript presentation wiring (plan §17) ───────────────
  // The match STATE lives here; the matching/index ALGORITHM stays in
  // transcript.ts (`folder.search`), and the overlay stepping/refresh POLICY
  // stays in search-overlay.ts. The runner owns the folder instances and
  // supplies them through the routing source.
  let searchMatches: TranscriptSearchMatch[] = []
  let searchCurrent = -1
  // Opt-in local wall-clock profiling of the Ctrl+F hot path (perf plan S1
  // §4.2). A no-op unless DSH_TUI_SEARCH_PROFILE=1.
  const searchProfiler: SearchProfile = createSearchProfiler(searchProfilingEnabled())
  // Query-refinement state (D1): the previous query's matches are reused
  // only when the new query PREFIX-extends the previous one on the SAME
  // folder with an UNCHANGED projection revision (the folder validates
  // both; the folder identity guard keeps a subagent viewer's matches
  // from ever being reused for the parent session or vice versa).
  let lastSearchQuery = ''
  let lastSearchRevision = 0
  let lastSearchFolder: TranscriptFolder | undefined
  /** The folder's search revision at the last COMMITTED projection epoch: the
   * same-window fast path is valid only while this still matches the live
   * folder (otherwise the projected bounds/objects are stale). */
  let searchBoundRevision = -1
  /** The unique representative card ids of the current result set, and the
   * published representative objects (weak-highlight scope). */
  let searchMatchRepresentativeIds: number[] = []
  let searchMatchMessages: ReadonlySet<TranscriptMessage> = new Set()
  const sameMessageSet = (left: ReadonlySet<TranscriptMessage>, right: ReadonlySet<TranscriptMessage>): boolean => {
    if (left.size !== right.size) return false
    for (const message of left) if (!right.has(message)) return false
    return true
  }
  /** Re-resolve the representative ids against the CURRENT folder projection.
   * The published SET keeps its identity when the resolved cards are
   * unchanged, so a passive projection does not bump the presentation
   * revision for nothing. */
  const resolveSearchMatchMessages = (): ReadonlySet<TranscriptMessage> => {
    const folder = activeFolder()
    const next = new Set<TranscriptMessage>()
    if (lastSearchQuery !== '' && lastSearchFolder === folder) {
      for (const id of searchMatchRepresentativeIds) {
        const message = folder.resolveSearchMatch({ id, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 })
        if (message !== undefined) next.add(message)
      }
    }
    if (sameMessageSet(next, searchMatchMessages)) return searchMatchMessages
    // Mirror the authoritative published set so the NEXT resolution keeps
    // object identity when the cards are unchanged (a fresh Set every
    // repaint would bump the presentation revision and clear the Focus
    // live-height floors for nothing).
    searchMatchMessages = next
    return next
  }
  /** The current target resolved against the LIVE folder (stable match →
   * current card object). Undefined while no match is current. */
  const resolveSearchTarget = (): TranscriptSearchPresentationTarget | undefined => {
    if (lastSearchQuery === '' || searchCurrent < 0 || lastSearchFolder === undefined) return undefined
    const folder = activeFolder()
    if (folder !== lastSearchFolder) return undefined
    const match = searchMatches[searchCurrent]
    if (match === undefined) return undefined
    const message = folder.resolveSearchMatch(match)
    if (message === undefined) return undefined
    return { query: lastSearchQuery, match, message }
  }
  const refreshSearchMatchMessages = (): void => {
    const folder = activeFolder()
    const ids: number[] = []
    if (lastSearchQuery !== '' && lastSearchFolder === folder) {
      const seen = new Set<number>()
      for (const match of searchMatches) {
        if (seen.has(match.id)) continue
        seen.add(match.id)
        ids.push(match.id)
      }
    }
    searchMatchRepresentativeIds = ids
    // The stage lives HERE, next to the pass it measures: a duplicate
    // representative pass can never hide behind a single stage emission.
    searchProfiler.stage('search.resolve-representatives')
  }
  const resetSubjectStatus = (): void => {
    status.update({ access: {}, composition: {}, collaboration: { plan: { effective: false } } })
  }

  const resetSearchPresentation = (options: { preserveCurrentReveal?: boolean; rebuild?: boolean } = {}): void => {
    // Only a runner that actually holds search state needs to publish the
    // atomic clear: an unconditional empty commit would force a pointless
    // message-tree rebuild on every Ctrl+End in regular fullscreen use.
    const hadState = lastSearchQuery !== '' || searchMatches.length > 0
      || searchMatchRepresentativeIds.length > 0 || searchMatchMessages.size > 0
    searchMatches = []
    searchCurrent = -1
    lastSearchQuery = ''
    lastSearchRevision = 0
    lastSearchFolder = undefined
    searchMatchRepresentativeIds = []
    searchMatchMessages = new Set()
    searchBoundRevision = -1
    // ONE atomic commit: an empty representative set AND no target, so a
    // session/surface reset can never leave the old card bound as
    // the search highlight or keep a temporary reveal alive.
    if (hadState && app !== undefined) {
      app.finishTranscriptSearchPresentation(searchMatchMessages, options)
    }
  }
  // After EVERY projection commit, resolve the presentation for THAT epoch:
  // a passive live reflow replaces the representative card object, and the
  // reveal/highlight must follow the stable match without a second rebuild.
  // `grantReveal` stays false so a user collapse is never resurrected.
  searchBindingForRepaint = (): TranscriptSearchPresentation | undefined => {
    // Record the committed projection epoch even with no search active: the
    // first query after opening the overlay must be able to take the
    // same-window fast path against the projection the user is looking at.
    const folder = activeFolder()
    searchBoundRevision = folder.searchRevision()
    if (lastSearchQuery === '' || lastSearchFolder === undefined || folder !== lastSearchFolder) return undefined
    return { matchMessages: resolveSearchMatchMessages(), target: resolveSearchTarget(), grantReveal: false }
  }
  // PR D1 P1: while the search overlay is open the transcript keeps
  // changing (settlements, read-group reflow, new messages), so Next/Prev
  // must never jump with a stale candidate list or a stale turn. This
  // re-runs the SAME lightweight query when the active folder's
  // projection revision moved (or the folder itself changed), recovers the
  // previously current OCCURRENCE by its match key, and clamps the index.
  const refreshSearchMatchesIfStale = (): void => {
    const folder = activeFolder()
    const refreshed = refreshedSearchState(
      { matches: searchMatches, current: searchCurrent, query: lastSearchQuery, revision: lastSearchRevision, folder: lastSearchFolder },
      folder,
    )
    if (!refreshed.changed) return
    searchMatches = refreshed.matches
    searchCurrent = refreshed.current
    lastSearchRevision = refreshed.revision
    lastSearchFolder = folder
    mounted().setSearchResult(searchCurrent + 1, searchMatches.length)
  }
  /** The search presentation for an EXPLICIT navigation: `grantReveal` so the
   * temporary reveal is (re-)granted, and the representative set / target
   * resolved against the live folder. */
  const navigationSearchPresentation = (match: TranscriptSearchMatch): TranscriptSearchPresentation => {
    const folder = activeFolder()
    const message = folder.resolveSearchMatch(match)
    return {
      matchMessages: resolveSearchMatchMessages(),
      ...(message === undefined ? {} : { target: { query: lastSearchQuery, match, message } }),
      grantReveal: true,
    }
  }
  const jumpToSearchMatch = (): void => {
    // `jumpToSearchMatch` is the ONLY caller of the stale refresh and the ONLY
    // place that derives the representative ids: one O(searchMatches) dedupe
    // pass per operation, over the FINAL result set (a 3000-result query must
    // not pay it two or three times per keystroke).
    refreshSearchMatchesIfStale()
    refreshSearchMatchMessages()
    const match = searchMatches[searchCurrent]
    if (match === undefined) {
      // Publish the current (empty) representative set AND the cleared target
      // in ONE atomic commit. A bare setTranscriptSearchTarget(undefined)
      // would carry the PREVIOUS published set, leaving the presentation's
      // representative half stale until the search closes.
      const presentation: TranscriptSearchPresentation = {
        matchMessages: resolveSearchMatchMessages(),
        target: undefined,
        grantReveal: false,
      }
      searchProfiler.stage('search.presentation-commit')
      // The setter reports whether it actually committed: a repeat no-match
      // step (same empty set, target already cleared) is a no-op and MUST NOT
      // be reported as a rebuild.
      if (mounted().setTranscriptSearchPresentation(presentation)) searchProfiler.stage('search.rebuild')
      mounted().setSearchResult(0, 0)
      return
    }
    const folder = activeFolder()
    const controller = activeWindow()
    // Same-window fast path (perf plan S2 §5.4): the match is already inside
    // the projected bounds AND the projection is the live epoch, so bind the
    // new presentation to it directly — one rebuild, no re-window, no
    // remeasure. The bounds come from the CURRENT projected window, never
    // from the controller mode alone.
    const snapshot = controller.snapshot()
    const sameWindow = lastSearchFolder === folder
      && searchBoundRevision === folder.searchRevision()
      && snapshot.firstTurn !== undefined && snapshot.lastTurn !== undefined
      && match.turn >= snapshot.firstTurn && match.turn <= snapshot.lastTurn
    if (sameWindow) {
      const presentation = navigationSearchPresentation(match)
      searchProfiler.stage('search.presentation-commit')
      if (mounted().setTranscriptSearchPresentation(presentation)) searchProfiler.stage('search.rebuild')
      mounted().scrollToSearchTarget()
      searchProfiler.stage('search.scroll')
      mounted().setSearchResult(searchCurrent + 1, searchMatches.length)
      return
    }
    // Off-window: ONE fold snapshot (plan §19) — the anchored message window
    // and the activities come from the same folder call. Order is the
    // contract (plan §22): anchor the window FIRST, then repaint with the
    // presentation bound to THAT projection epoch (the target/weak-match
    // objects are in place before the single rebuild), and only THEN anchor
    // the exact rendered occurrence.
    controller.anchorAt(match.turn)
    repaintTarget(
      folder,
      controller,
      activeStreamingToolPreviews(),
      () => {
        const presentation = navigationSearchPresentation(match)
        searchProfiler.stage('search.presentation-commit')
        return presentation
      },
      () => searchProfiler.stage('search.window'),
    )
    searchProfiler.stage('search.rebuild')
    searchBoundRevision = folder.searchRevision()
    mounted().scrollToSearchTarget()
    searchProfiler.stage('search.scroll')
    mounted().setSearchResult(searchCurrent + 1, searchMatches.length)
  }

  // Virtual history boundaries preserve the rendered overlap anchor;
  // paging changes only the presentation window, never the fold.
  const transcriptMoveOlder = (): boolean => {
    const controller = activeWindow()
    // M3-4 PR2: a bounded reader window (Remote) may still have OFFICIAL
    // older history (`hasMore`). When the virtual window reaches its loaded
    // floor, ask the routing source's extension seam to load one official
    // older page; the gesture is consumed and the repaint lands when the
    // page joins (web-parity `loadEarlier` behavior — never a sync lie).
    if (!controller.moveOlder()) {
      return routing().extendLoadedHistory()
    }
    // Perf: the movement is known to change the window BEFORE the expensive
    // anchor capture runs. The anchor belongs to the MOUNTED presentation, and
    // nothing has repainted yet, so this still captures the old projection.
    const live = mounted()
    const anchor = live.captureTranscriptViewportAnchor()
    repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
    // Preserve the old top edge at the same rendered row in the overlap.
    if (anchor === undefined) live.scrollToBottom({ disableFollow: true })
    else live.restoreTranscriptViewportAnchor(anchor, 'top')
    return true
  }
  // Ctrl+Up / Ctrl+Down in fullscreen: single-turn prompt navigation
  // over the virtual window (the fork's OSC 133 scan finds nothing in
  // DSH transcripts — the semantic turn list lives HERE).
  const transcriptTurnOlder = (): boolean => {
    const live = mounted()
    if (!live.isFullscreen()) return false
    const controller = activeWindow()
    if (!controller.turnOlder()) return false
    repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
    live.scrollToBottom({ disableFollow: true })
    return true
  }
  const transcriptTurnNewer = (): boolean => {
    const live = mounted()
    if (!live.isFullscreen()) return false
    const controller = activeWindow()
    if (!controller.turnNewer()) return false
    repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
    live.scrollToBottom({ disableFollow: true })
    return true
  }
  const transcriptMoveNewer = (): boolean => {
    const controller = activeWindow()
    if (!controller.moveNewer()) return false
    // Perf: capture the OLD mounted projection only after the movement is
    // known to be real (see transcriptMoveOlder).
    const live = mounted()
    const anchor = live.captureTranscriptViewportAnchor()
    repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
    if (controller.isLatest()) live.scrollToBottom()
    else if (anchor === undefined) live.scrollToTop({ disableFollow: true })
    else live.restoreTranscriptViewportAnchor(anchor, 'bottom')
    return true
  }
  const transcriptJumpLatest = (): boolean => {
    const live = mounted()
    // Ctrl+End is a fullscreen transcript action. In regular mode it must
    // fall through so the editor retains its own Ctrl+End behavior.
    if (!live.isFullscreen()) return false
    // Ctrl+End is a semantic reset, not merely a viewport scroll. With
    // search open, the explicit `jump-latest` close reason owns the reset
    // and latest projection so this path does not repaint twice.
    if (live.isSearching()) {
      live.closeTranscriptSearch('jump-latest')
      live.setSearchResult(0, 0)
      return true
    }
    resetSearchPresentation()
    live.setTranscriptSearchTarget(undefined)
    const controller = activeWindow()
    const changed = controller.latest()
    if (!changed && !live.isFullscreen()) return false
    repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
    live.scrollToBottom()
    live.setSearchResult(0, 0)
    return true
  }
  // Transcript search: matches run over the FULL folded transcript
  // (lightweight indexed projection — never a full materialization); each jump
  // re-windows the view so the matched turn is visible (older turns collapse
  // above it into the summary entry).
  const openSearch = (): void => {
    // A stale search presentation from a previous session must never
    // leak its reveal/highlight into the fresh overlay.
    mounted().setTranscriptSearchTarget(undefined)
  }
  const runSearchQuery = (query: string): void => {
    searchProfiler.start()
    const folder = activeFolder()
    // Prefix refinement reuses the previous candidate set only when the
    // query EXTENDS it on the SAME folder; the folder itself also
    // requires an unchanged projection revision (a live append or group
    // reflow between queries invalidates the candidates).
    searchMatches = folder.search(query, lastSearchQuery !== '' && folder === lastSearchFolder
      ? { previousQuery: lastSearchQuery, previousMatches: searchMatches, revision: lastSearchRevision }
      : undefined)
    searchProfiler.stage('search.semantic')
    lastSearchQuery = query
    lastSearchRevision = folder.searchRevision()
    lastSearchFolder = folder
    searchCurrent = searchMatches.length > 0 ? 0 : -1
    // The jump owns the single representative pass for this operation.
    // Always run the jump path: an empty/no-match query must CLEAR the
    // stale search presentation target (0/0), not leave the previous
    // reveal/highlight on screen.
    jumpToSearchMatch()
    searchProfiler.end()
  }
  const searchNext = (): void => {
    searchProfiler.start()
    // PR D1 P1: refresh BEFORE stepping — an empty candidate list
    // still refreshes (a match that arrived while the overlay stayed
    // open must be discoverable), and the step is computed on the
    // REFRESHED list. The policy lives in steppedSearchOverlayState,
    // shared by both handlers.
    const folder = activeFolder()
    const stepped = steppedSearchOverlayState(
      { matches: searchMatches, current: searchCurrent, query: lastSearchQuery, revision: lastSearchRevision, folder: lastSearchFolder },
      folder,
      1,
    )
    searchMatches = stepped.matches
    searchCurrent = stepped.current
    lastSearchRevision = stepped.revision
    lastSearchFolder = folder
    // The jump owns the single representative pass for this operation.
    // An emptied list steps to -1: the jump path still runs so the
    // stale target/highlight is cleared (0/0).
    jumpToSearchMatch()
    searchProfiler.end()
  }
  const searchPrev = (): void => {
    searchProfiler.start()
    const folder = activeFolder()
    const stepped = steppedSearchOverlayState(
      { matches: searchMatches, current: searchCurrent, query: lastSearchQuery, revision: lastSearchRevision, folder: lastSearchFolder },
      folder,
      -1,
    )
    searchMatches = stepped.matches
    searchCurrent = stepped.current
    lastSearchRevision = stepped.revision
    lastSearchFolder = folder
    // The jump owns the single representative pass for this operation.
    jumpToSearchMatch()
    searchProfiler.end()
  }
  const closeSearch = (reason: TranscriptSearchCloseReason): void => {
    const live = mounted()
    if (reason === 'dismiss') {
      const anchor = live.captureTranscriptViewportAnchor()
      resetSearchPresentation({ preserveCurrentReveal: true })
      if (anchor !== undefined) live.restoreTranscriptViewportAnchor(anchor, 'top')
      return
    }
    if (reason === 'jump-latest') {
      // Clear the presentation in memory; the latest-window repaint below
      // commits both changes in the single required message-tree rebuild.
      resetSearchPresentation({ rebuild: false })
      const controller = activeWindow()
      controller.latest()
      repaintTarget(activeFolder(), controller, activeStreamingToolPreviews(), searchBindingForRepaint)
      live.scrollToBottom()
      return
    }
    // A physical surface swap owns the next projection. Clear the search
    // state without rebuilding the old screen or promoting its reveal.
    resetSearchPresentation({ rebuild: false })
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
    imageLoader: new ImageLoader((ref, context) => deps.readImage(ref, context)),
    imageScope: deps.imageScope,
    imageTheme: { fallbackColor: deps.imageFallbackColor },
    present: deps.present,
    workspaceRoot: deps.workspaceRoot,
    // The structural icon palette: read ONCE at startup from the persisted
    // document; runtime switches go through app.setIconStyle (the /settings
    // write path) — never a deep settings read per render.
    iconStyle: deps.iconStyle,
    extensionHost: extension.host(),
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
    draftImageStoreForTest: deps.draftImageStoreForTest,
    // Fullscreen OSC 8 link clicks + the Windows right-click paste.
    openExternalUrl: deps.openExternalUrl,
    readClipboardText: deps.readClipboardText,
    // M7/M9: the transcript/tool renderer + editor registries.
    renderers: extension.service()?.renderers,
    editorRegistry: extension.service()?.editors,
    // M6: non-capturing plugin keybindings. The resolver reads the service
    // LAZILY and normalizes through the InputRouter — a plugin binding
    // resolves against normalized keys only, never raw terminal data.
    pluginActionFor: (normalized) => extension.service()?.keybindings.actionFor(normalized),
    pluginActionIdFor: (normalized) => extension.service()?.keybindings.idFor(normalized),
    // Phase 2: the ADVANCED normalized input capture route (consulted after
    // the host's own capturing flows, before the editor and Stable keys).
    advancedInputRoute: (data) => extension.service()?._advancedInputRoute(data) ?? 'passed',
    // Phase 3: the UNSTABLE raw input route, consulted before terminal
    // protocol decoding; the emergency fail-safe is Host-recovery only.
    unstableInputRoute: (data, surfaceId) => extension.service()?._unstableInputRoute(data, surfaceId) ?? { action: 'pass' },
    unstableInputsLive: () => extension.service()?._unstableInputsLive() ?? false,
    unstableInputsRevision: () => extension.service()?._unstableInputsRevision() ?? 0,
    unstableFailSafeRelease: () => extension.service()?._unstableEmergencyRelease(),
    // PR2: the semantic Workflow card actions (member open / scoped agent
    // browse). A4-6 moved the handler into the surface owner (it reads the
    // browser's row-identity source); the closure only runs on a user click.
    onWorkflowAction: action => task.handleWorkflowAction(action),
  })

  return {
    get app(): TuiApp {
      if (app === undefined) throw new Error('the surface is not mounted')
      return app
    },
    status,
    openingJournal,
    setCompletionOwner(identity) {
      // Every completion-owner commit/reset drops the previous owner's pane
      // progress BEFORE the controller resets (plan §9): a newly committed
      // owner must prove `running` through its own authoritative
      // `agent/status`, never inherit the old owner's busy state.
      setMainAgentProgress(false)
      notification.setCompletionOwner(identity)
    },
    onAgentStatus(agentId, status) {
      notification.onAgentStatus(agentId, status)
    },
    commitStatus(patch, legacyFacts, presentation) {
      // A4-4 (plan §13.1): the semantic derivation stays with the runner; the
      // commit coordination is surface-owned. The three parts are ONE atomic
      // display-subject commit (M3-5 PR1 §9.7).
      mounted().commitDisplaySubject(patch, legacyFacts, presentation)
    },
    setNotificationMode(mode) {
      notification.setMode(mode)
    },
    setNotificationMethod(method) {
      notification.setMethod(method)
    },
    setTerminalProgressMode(mode) {
      app?.setTerminalProgressEnabled(parseTerminalProgressMode(mode) === 'on')
    },
    handleTerminalFocus(focused) {
      notification.handleTerminalFocus(focused)
    },
    noteUserInput() {
      notification.noteUserInput()
    },
    enableFocusReporting() {
      notification.enableFocusReporting()
    },
    disableFocusReporting() {
      notification.disableFocusReporting()
    },
    attachExtensionHost(service) {
      extension.attachHost(service)
    },
    attachPluginManager(deps) {
      return pluginManager.attach(deps)
    },
    bindPluginKeybinds() {
      extension.bindPluginKeybinds()
    },
    attachSurfaceSeams(deps: SurfaceSeamDeps) {
      extension.attachSeams(deps)
    },
    attachTasks(source, deps) {
      task.attachTasks(source, deps)
    },
    refreshTasks() {
      task.refreshTasks()
    },
    refreshAgents() {
      task.refreshAgents()
    },
    refreshAgentRuntimeOnly() {
      task.refreshAgentRuntimeOnly()
    },
    hasTask(childId) {
      return task.hasTask(childId)
    },
    resetTasks() {
      task.resetTasks()
    },
    openTasksBrowser(viewMode, restoreState, scope, header) {
      task.openTasksBrowser(viewMode, restoreState, scope, header)
    },
    openJobView(jobId) {
      return task.openJobView(jobId)
    },
    attachInteraction(port, deps) {
      interaction.attach(port, deps)
    },
    attachEventRouting(source) {
      routingSource = source
    },
    routeSessionEvent: (session, event) => eventRouting.routeSessionEvent(session, event),
    routeSubagentLifecycle: () => eventRouting.routeSubagentLifecycle(),
    routeAgentStatus: (agentId, status) => eventRouting.routeAgentStatus(agentId, status),
    routeProviderRefresh: () => eventRouting.routeProviderRefresh(),
    routeSettingsRefresh: (namespace) => eventRouting.routeSettingsRefresh(namespace),
    isCurrentAssistantAgent: (agent) => eventRouting.isCurrentAssistantAgent(agent),
    applyAssistantInput: (input) => eventRouting.applyAssistantInput(input),
    applyResumedCompaction: (id, active) => eventRouting.applyResumedCompaction(id, active),
    refreshPendingInput,
    resetPendingPresentation,
    schedulePaint,
    paintNow,
    repaint: () => repaintActive(),
    resetSearchPresentation,

    resetSubjectStatus,
    disposeJobEvents() {
      task.disposeJobEvents()
    },
    disposeJobObservation() {
      task.disposeJobObservation()
    },
    disposeTaskBrowser() {
      task.disposeTaskBrowser()
    },
    start(deps) {
      if (disposed) throw new Error('the surface is already disposed')
      if (app !== undefined) throw new Error('the surface is already mounted')
      // A4-8 (plan §17): the transcript-navigation and Ctrl+R search
      // presentation callbacks are surface-owned wiring. The runner's input
      // contract arrives as `deps.events` and the surface overlays exactly the
      // presentation-target callbacks it owns.
      const events: TuiAppEvents = {
        ...deps.events,
        onTranscriptMoveOlder: () => transcriptMoveOlder(),
        onTranscriptTurnOlder: () => transcriptTurnOlder(),
        onTranscriptTurnNewer: () => transcriptTurnNewer(),
        onTranscriptMoveNewer: () => transcriptMoveNewer(),
        onTranscriptJumpLatest: () => transcriptJumpLatest(),
        onSearchOpen: () => openSearch(),
        onSearchQuery: query => runSearchQuery(query),
        onSearchNext: () => searchNext(),
        onSearchPrev: () => searchPrev(),
        onSearchClose: reason => closeSearch(reason),
      }
      // The TUI is about to mount: the app takes over the terminal now, and
      // the same instance is what dispose() releases.
      //
      // A main-Agent `agent/status` observed BEFORE the mount (plan §8.2) is
      // handed INTO the construction (plan addendum §25): the FIRST terminal
      // acquisition already asserts the final state, instead of writing idle
      // and being corrected one write later (an idle -> working flash).
      app = startProcessTui(events, {
        ...buildOptions(deps),
        initialTerminalProgress: mainAgentProgressActive,
        terminalProgressEnabled: parseTerminalProgressMode(options.terminalProgress) === 'on',
      })
    },
    disposePluginManager() {
      // Release the Plugin Manager install-event subscription at its original
      // EARLY position. This never cancels a Host install: only the official
      // cancel action does that.
      pluginManager.dispose()
    },
    dispose() {
      if (disposed) return
      disposed = true
      // M3-6 PR3: the aggregate teardown is ONE ordered non-truncating batch
      // (the plan's frozen order) across the sub-owners. Each sub-owner retires
      // its own one-shot slots before its callbacks run, so a throwing
      // TuiApp/app-owned cleanup can never strand the question attachment, the
      // plugin keybinding sync, the theme-unload hook release or the extension
      // surface detach. The process slot is NOT released here — TuiApp remains
      // its sole owner.
      runSyncDisposalSteps('surface runtime disposal', [
        // Plan §10: retire the pane-progress hint BEFORE the mounted app dies.
        // ProcessTerminal.stop() in app.dispose() clears the physical
        // indicator independently — this is the surface-side semantic reset.
        () => setMainAgentProgress(false),
        // The question attachment first (its answer lookup is cleared before the
        // app dies), then the mounted app, then the extension surface resources
        // in the runner's original cleanup order.
        () => interaction.dispose(),
        () => app?.dispose(),
        () => extension.dispose(),
      ])
    },
  }
}
