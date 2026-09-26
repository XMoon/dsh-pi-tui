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
 * - the completion-notification/terminal-focus presentation lives here (A4-4);
 * - the Task Center (`TaskBrowserRuntime` + the browser state/panels + the Job
 *   viewer/observer) and the approval/question providers live here (A4-6);
 * - the presentation event ROUTING lives here (A4-7): `session/event` (opening
 *   journal, opening-viewer buffer, viewed-child vs main owner, every
 *   same-session/exact-owner/cleanup fence and the per-target apply/paint
 *   calls), the assistant-stream neutral input routing, the subagent lifecycle
 *   / `agent/status` presentation triggers and the provider/settings/credential
 *   surface refresh routing. The runner keeps the Cordis registrations as thin
 *   delegations, the Direct assistant-stream INSTALL, the Direct/domain
 *   bookkeeping and the presentation-target instances, injected through the
 *   narrow `SurfaceEventRoutingSource` bundle;
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
 * Resource lifetime (plan §12.2/§38) — one acquire point and one release owner
 * per resource; the runner only ORCHESTRATES the release order:
 *
 * | Resource | Acquired by | Released by |
 * |---|---|---|
 * | status store, journal, notification presentation | `createSurfaceRuntime` | process end (no release step) |
 * | extension host + theme-unload hook | `attachExtensionHost()` | `dispose()` |
 * | Plugin Manager controller + subscription | `attachPluginManager()` | `disposePluginManager()` (early position) |
 * | plugin keybinding sync | `bindPluginKeybinds()` | `dispose()` |
 * | mounted `TuiApp` | `start()` | `dispose()` |
 * | jobs-event subscription | `attachTasks()` | `disposeJobEvents()` |
 * | Job observer + viewer | `openJobView()`/`openJobStatusViewer()` | `disposeJobObservation()` |
 * | task browser handle/token/rows/scope | `openTasksBrowser()` | `disposeTaskBrowser()` |
 *
 * `disposePluginManager()` and `dispose()` are idempotent, and every release
 * hook is safe before its acquire ran (the slots are optional). Teardown order
 * is behavior too: `dispose()` releases exactly the surface-owned resources the
 * runner's cleanup used to release AFTER the mounted app (app, plugin keybinding
 * sync, theme-unload hook, extension surface detach) while
 * `disposePluginManager()` releases the Plugin Manager subscription at its
 * original EARLY position, and the Task Center hooks run in the original
 * `jobsEvents -> jobObservation -> taskBrowser` order. The remaining
 * interleaved runner-owned steps stay with their owners and the runner
 * orchestrates them around these hooks. There is deliberately NO
 * partial-acquire rollback beyond that: `start()` is the last acquire and a
 * throwing mount leaves the process on the runner's fatal path, which runs the
 * same ordered cleanup.
 *
 * Host coupling: this module reads NO Host business service and imports NO
 * Direct wiring (plan §4.3). Everything it needs arrives as a narrow injected
 * capability or a semantic port.
 *
 * @module app/surface/runtime
 */

import { Text, type Component } from '@xmoon76/pi-tui'
import { startProcessTui, type TodoItem, type TuiApp, type TuiAppEvents, type TuiAppOptions } from '../../tui-app.ts'
import type { Diag } from '../../diag.ts'
import type { PiTuiExtensionService } from '../../extensions.ts'
import { color } from '../../theme.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { runOwned } from '../../detached.ts'
import {
  buildTaskRows,
  isActiveJobStatus,
  isSubagentRowInterruptible,
  rowGroup,
  subagentInterruptParent,
  taskRowLabel,
  taskTreePrefix,
  viewerAccessHint,
  viewerAccessOf,
  workflowMemberViewerTarget,
  type TaskBrowserJobInput,
  type TaskBrowserRow,
} from '../../tasks-browser.ts'
import { TaskBrowserRuntime, type TaskBrowserDatasetScope, type TaskBrowserRuntimeHooks, type TaskBrowserSummary } from '../../task-browser-runtime.ts'
import type { TaskBrowserViewState, TaskPanelItem } from '../../task-panel.ts'
import type { TaskBrowserHandle, WorkflowAction } from '../../tui-app.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { InteractionPort } from '../../runtime/interaction-port.ts'
import type { JobObservationPort, JobObservedSnapshot } from '../../runtime/job-observation-port.ts'
import type { SubagentInterruptOutcome } from '../../runtime/subagent-port.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { SubmitLatencyPhase } from '../../submit-latency.ts'
import type { ContextMeasureReason } from '../../status/context-measurement.ts'
import {
  busyAfterTurnBoundary,
  contextRefreshKind,
  foldCompactionEvent,
  settleCompactionSurface,
} from './presentation-folds.ts'
import type { SessionSubject } from '../session/subject.ts'
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

/**
 * The jobs-registry capability the Task Center consumes (A4-6, plan §15).
 * Optional: a composition without the jobs service has no dock roster feed and
 * no Job viewer. The runner keeps the concrete `ctx.jobs` read, the
 * `JobId`/`SessionId` casts and the retained-snapshot fence; the surface never
 * imports the Host service.
 */
export interface TaskSurfaceJobs {
  /** A FRESH registry read of the current root's roster (the public `list`
   *  contract; throws like the registry on a failed read). */
  list(sessionId: string | undefined): readonly TaskBrowserJobInput[]
  /** Subscribe to scope-owned roster/runtime events (the `owners: 'scope'`
   *  filter). */
  subscribe(listener: (event: { readonly type: string }) => void): () => void
  /** Read one current registry record through the public `get` contract. */
  get(jobId: string, sessionId: string): TaskBrowserJobInput
  /** Stop one active record through the public registry contract. */
  kill(jobId: string, sessionId: string, reason: string): 'requested' | 'already-finished'
}

/**
 * The subagent-registry half of {@link TaskSurfaceSource}, derived from the
 * EXISTING {@link TaskBrowserRuntimeHooks} reads (plan §15.2) — never a second
 * task model. The runner provides them because they need the Direct
 * Agent/Session identity it owns.
 */
export interface TaskSurfaceAgents {
  currentKey: TaskBrowserRuntimeHooks['currentKey']
  listDescendants: TaskBrowserRuntimeHooks['listDescendants']
  readJobs: TaskBrowserRuntimeHooks['readJobs']
  agentStatusOf: TaskBrowserRuntimeHooks['agentStatusOf']
}

/**
 * The narrow production capability the Task Browser / Job viewer need
 * (plan §15.2). Injected by the runner; no Backend port is added for
 * symmetry. The `jobs`/`agents` halves are independently optional (the
 * corresponding Host service), mirroring the runner's two original conditional
 * wiring blocks.
 */
export interface TaskSurfaceSource {
  /** The live root session id (undefined = no live agent). */
  sessionId(): string | undefined
  /** Capture the exact ownership subject for the destructive-intent fence. */
  captureSubject(): SessionSubject | undefined
  /** Whether a captured subject is still the current owner generation. */
  subjectMatches(subject: SessionSubject | undefined): boolean
  /** Open the child transcript viewer (session-owned, async hydration). */
  enterView(
    childId: string,
    label: string | undefined,
    mode: 'one-shot' | 'continuable',
    parentSessionId: string,
    activity: 'running' | 'inactive',
    depth?: number,
  ): Promise<void>
  /** Stop one continuable child through the session writer admission. */
  interruptSubagent(parentSessionId: string, childSessionId: string): Promise<SubagentInterruptOutcome>
  /** The root row-selection disposition helper (public root seam). */
  rowSelectionDisposition(
    row: { readonly kind: 'job' | 'subagent' } | undefined,
    jobDetail: 'close' | 'keep-open',
  ): 'close' | 'keep-open'
  /** The subagent-job child-session-id probe (public root seam). */
  subagentJobTranscriptId(snapshot: unknown): string | undefined
  /** The subagent-job viewer body hint (public root seam). */
  subagentJobViewHint(status: string, detail: string | undefined): string
  /** The selected-Job observation port (`backend.jobObservation`). */
  readonly jobObservation: JobObservationPort
  readonly jobs?: TaskSurfaceJobs
  readonly agents?: TaskSurfaceAgents
}

/** The task-center lifetime inputs the surface borrows from the runner. */
export interface TaskSurfaceDeps {
  /** The runner's diagnostics channel for the owned async flows. */
  readonly diag: Diag
  /** The runner's cleanup latch: the ORIGINAL `cleanedUp` fence. A late async
   *  result or a teardown-triggered refresh must stop touching the surface the
   *  moment the runner begins teardown, before `surface.dispose()`. */
  readonly isCleanedUp: () => boolean
}

/** The approval/question presentation inputs (A4-7, plan §13.3/§16). */
export interface SurfaceInteractionDeps {
  /** The paired tool-call arguments cache (the runner owns the session-event
   *  feed; this is a narrow read of the current call's args). */
  readonly lookupCallArgs: (callId: string) => string | undefined
  /** The dangerous-command predicate (a pure root helper in the runner). */
  readonly dangerCommand: (command: string) => boolean
}

/**
 * The structural session-event shape the A4-7 routing reads: the discriminant
 * and the per-type payload. The runner's Host `SessionEvent` satisfies it; the
 * surface never imports the Host session type. `data` stays `unknown` and the
 * routing mirrors the runner's own structural reads at the few call sites that
 * inspect it.
 */
export interface RoutedSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** One transcript/stats fold sink. The concrete `TranscriptFolder`/`StatsFolder`
 *  implementations stay runner-owned (plan §17); the surface only calls their
 *  `apply`. */
export interface SurfaceEventSink<Event> {
  apply(events: readonly Event[]): void
}

/**
 * The main-owner presentation target (plan §16.1): the live main folder/stats
 * and the transient main tool-preview projection. Read through a live accessor
 * because a session commit swaps the hydrated folder/stats instances.
 */
export interface SurfaceMainPresentation<Event> {
  readonly folder: SurfaceEventSink<Event>
  readonly stats: SurfaceEventSink<Event>
  /** Apply one event to the main streaming tool-preview projection. */
  applyToolPreview(event: Event): void
}

/**
 * The viewed-child presentation target (plan §16.1): the child folder/stats/
 * previews plus the viewer's own activity/footer state. Valid only while a
 * viewer is mounted (the routing checks {@link SurfaceEventRoutingSource.viewedChildId}).
 */
export interface SurfaceViewedChildPresentation<Event> {
  readonly id: string
  readonly folder: SurfaceEventSink<Event>
  readonly stats: SurfaceEventSink<Event>
  applyToolPreview(event: Event): void
  /** turn/start: the child is live again (rebinds the exact Agent + queue subject). */
  beginTurn(): void
  /** turn/end: the child parks. */
  endTurn(): void
  /** Push the child's own turns/steps/stats into the footer. */
  refreshFooter(): void
}

/**
 * The A4-7 presentation event routing source (plan §16/§4.3): the runner-owned
 * facts, Direct/domain bookkeeping and presentation targets the surface routing
 * consumes. A narrow injected capability bundle in the `TaskSurfaceSource`
 * style — never a Host service lookup and never a Direct import.
 *
 * The boundary (owner-refined): the runner owns Host registration, the Direct
 * assistant-stream INSTALL, and all Direct/domain bookkeeping (model-selection
 * observation, the request-header consume, the call-args / pending-subagent /
 * viewed-child maps, the exact Agent lookup); the surface owns every routing
 * decision, the transcript/stats/preview APPLICATION calls, and the repaint /
 * refresh coordination.
 */
export interface SurfaceEventRoutingSource<Event extends RoutedSessionEvent> {
  // ── fences + identity (Direct ownership + Host attachment) ──────────────
  /** The runner's cleanup latch (the ORIGINAL `cleanedUp` fence). */
  isCleanedUp(): boolean
  /** The attached-session fence: the runtime still owns the EXACT object for
   *  this session id (the original `sessions.get(session.id)` comparison). */
  isAttachedSession(session: { readonly id: string }): boolean
  /** The live owner session id (the ownership-core read). */
  currentSessionId(): string | undefined
  /** Whether a live Direct Agent exists (the original `agentNow()` guard). */
  hasLiveAgent(): boolean
  /** The exact completion-owner Agent id, or undefined (`agent/status` fence). */
  completionOwnerId(): string | undefined

  // ── Direct/domain bookkeeping (stays runner-owned) ──────────────────────
  /** Feed one main-owner event to the Direct bookkeeping (model-selection
   *  observation, request-header selection consume, the call-args cache, the
   *  pending-subagent feed and the viewed-child settle map). Returns the
   *  settled viewed-child id for a `tool/result`. */
  observeMainEvent(sessionId: string, event: Event): string | undefined
  /** Append to the opening viewer's child-event buffer when the event belongs
   *  to the open viewer child (the token fence + child match); true when
   *  consumed. */
  appendOpeningViewerEvent(sessionId: string, event: Event): boolean

  // ── presentation targets (runner-owned instances) ───────────────────────
  main(): SurfaceMainPresentation<Event>
  viewedChildId(): string | undefined
  viewedChild(): SurfaceViewedChildPresentation<Event>

  // ── repaint + projection/refresh coordination ───────────────────────────
  schedulePaint(): void
  paintNow(): void
  /** Leave the viewed-child transcript back to the main surface. */
  exitView(): void
  refreshPendingInput(): void
  refreshStatusCheap(): void
  refreshStatusAndWelcome(): void
  /** Fold one `goal/change` into the runner's status goal text. */
  applyGoalChange(event: Event): void
  /** The session title one `session/title` event implies. */
  sessionTitleOf(event: Event): string | undefined
  settleLocalSubmitAck(reason: string): void
  markSubmitLatency(sessionId: string | undefined, phase: SubmitLatencyPhase): void
  observeDurableSubmission(rpcId: string): void
  markContextDirty(): void
  refreshContextMeasurement(reason: ContextMeasureReason): void
  /** Whether the CURRENT live agent's log ends mid-turn (the compaction
   *  settle's working-from-log read over the live session log). */
  currentWorkingFromLog(): boolean
  /** Persist the completed turn (`runDetached('turn flush', …)`). */
  flushTurn(): void

  // ── assistant-stream identity facts + neutral input targets ─────────────
  /** The registry hosts EXACTLY this Agent object for the session id. */
  registeredAgentIs(sessionId: string, agent: object): boolean
  /** The exact current owner Agent object. */
  isCurrentOwnerAgent(agent: object): boolean
  viewedChildAgent(): object | undefined
  setViewedChildAgent(agent: object): void
  setViewedQueueAgent(agent: object): void
  /** The registry's live Agent for a session id (the rollover comparison). */
  agentForSession(sessionId: string): object | undefined
  applyViewedChildAssistantInput(input: AssistantLiveInput): void
  applyMainAssistantInput(input: AssistantLiveInput, sessionId: string): void
}

/**
 * The task-browser row → panel-item projection (moved with the Task Center
 * wiring, A4-6). JOB rows keep their status/detail; SUBAGENT rows carry the
 * projected runtime activity as the status word, the durable mode as the
 * non-truncatable suffix, and the tree connector from the catalog depth.
 * `canStop` is advertised ONLY for a continuable child with a LIVE running
 * driver — an idle continuable has no driver to stop.
 */
function taskPanelItems(target: readonly TaskBrowserRow[]): TaskPanelItem[] {
  const labels = new Map<string, string>()
  for (const row of target) {
    if (row.kind === 'subagent') labels.set(row.childId, row.label)
  }
  return target.map(row => row.kind === 'job'
    ? {
        value: row.value,
        // A `subagent`-kind job is the registry's reliable contract
        // for a background one-shot delegation: its `one-shot` mode
        // rides as the non-truncatable suffix, like the child rows.
        label: row.jobKind === 'subagent' ? `subagent job · ${row.label}` : taskRowLabel(row),
        suffix: row.jobKind === 'subagent' ? 'one-shot' : undefined,
        status: row.status,
        detail: row.detail,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        group: rowGroup(row),
        source: 'job' as const,
        active: isActiveJobStatus(row.status),
        attention: row.attention ?? (row.status === 'failed' || row.status === 'timed_out' || row.status === 'lost'),
        canOpen: true,
        canStop: isActiveJobStatus(row.status),
        // The Tab type filter: job rows filter by their job kind.
        type: row.jobKind,
      }
    : {
        value: row.value,
        // The mode rides as the panel's non-truncatable SUFFIX
        // (`subagent · <label> · continuable`): the label itself may
        // truncate on a narrow screen, the mode never silently does.
        label: `subagent · ${row.label}`,
        suffix: row.mode,
        status: row.activity,
        group: rowGroup(row),
        source: 'subagent' as const,
        type: 'subagent',
        active: row.activity === 'running',
        canOpen: true,
        // Only a continuable row with a LIVE running driver is Stop-capable
        // (one-shot ids are accepted no-ops for the interrupt transport; an
        // idle continuable has no driver to stop — the UI must not advertise
        // a dead stop verb).
        canStop: isSubagentRowInterruptible(row),
        parentId: row.parentId === '' ? undefined : `agent:${row.parentId}`,
        parentLabel: row.parentId === '' ? undefined : labels.get(row.parentId),
        depth: row.depth,
        hasChildren: row.hasChildren,
        mode: row.mode,
        access: viewerAccessHint(row.mode, viewerAccessOf(row)),
        // The durable descendant tree connector: indentation + branch
        // glyph from the catalog's `depth` (plan §6.7) — a fixed
        // region that never scrolls with the selected label.
        treePrefix: taskTreePrefix(row.depth),
      })
}

/** One-line viewer hint for a job state (never touches the read cursor). */
function jobStatusHint(status: string, detail: string | undefined): string {
  const tail = status === 'running' || status === 'stopping'
    ? ' — opening the non-consuming retained-output stream…'
    : ` — final output is delivered to the agent via job_output${detail === undefined ? '' : ` (${detail})`}`
  return `${status}${tail}`
}

/** The Job detail body from the detached observation (never a Host read). */
function formatJobObservation(observed: JobObservedSnapshot): string {
  const lines: string[] = [observed.status]
  if (observed.progress !== undefined) lines.push(`progress: ${observed.progress}`)
  if (observed.detail !== undefined) lines.push(`detail: ${observed.detail}`)
  if (observed.gapBefore) lines.push('note: earlier output was evicted before this retained preview')
  if (observed.error !== undefined) lines.push(`follow error: ${observed.error}`)
  lines.push('', 'best-effort retained output preview (not a complete transcript):', '', observed.text)
  return lines.join('\n')
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
  // The Task Center / Job viewer resources (A4-6); each has exactly one
  // acquire point (`attachTasks`) and one release owner (`disposeJobEvents` /
  // `disposeJobObservation` / `disposeTaskBrowser` / `dispose`). The runner's
  // own `cleanedUp` latch stays the fence for the moved bodies (a teardown
  // that starts before `surface.dispose()` must already stop repainting).
  let taskSource: TaskSurfaceSource | undefined
  let taskDeps: TaskSurfaceDeps | undefined
  let refreshTasks: () => void = () => {}
  let refreshAgents: () => void = () => {}
  let refreshAgentRuntimeOnly: () => void = () => {}
  let taskBrowserRows: TaskBrowserRow[] = []
  let taskRuntime: TaskBrowserRuntime | undefined
  let taskBrowserScope: TaskBrowserDatasetScope = { kind: 'all' }
  let quickTaskState: TaskBrowserViewState | undefined
  let activeTaskBrowser: TaskBrowserHandle | undefined
  let activeTaskBrowserToken: object | undefined
  let activeJobViewerClose: (() => void) | undefined
  let jobsEventsDispose: (() => void) | undefined
  // A4-7 presentation event routing (plan §16): the injected routing source and
  // the surface-owned compaction fold id. The `compactingId` is routing state
  // (which compaction bracket is live for the presentation), not Direct state.
  let routingSource: SurfaceEventRoutingSource<Event> | undefined
  let compactingId: string | undefined

  /** The injected event-routing source; only reachable while attached. */
  const routing = (): SurfaceEventRoutingSource<Event> => {
    if (routingSource === undefined) throw new Error('the event routing source is not attached')
    return routingSource
  }

  /** The runner's cleanup latch for the moved bodies (see `TaskSurfaceDeps`). */
  const isCleanedUp = (): boolean => taskDeps?.isCleanedUp() === true

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
    // browse). A4-6 moved the handler into the surface owner (it reads the
    // browser's row-identity source); the closure only runs on a user click.
    onWorkflowAction: action => handleWorkflowAction(action),
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

  // A4-6: the Task Browser + Job viewer application wiring (plan §15). Every
  // body below moved VERBATIM from the runner's task/job closure; only the
  // Host/Direct facts (session id, jobs registry, Agent registry, ownership
  // subject, writer admission, child viewer, root helpers) arrive through the
  // injected `TaskSurfaceSource`, and the mounted app is reached through
  // `mounted()`.
  /** The injected task capability; only reachable while attached. */
  const taskCenter = (): TaskSurfaceSource => {
    if (taskSource === undefined) throw new Error('the task center is not attached')
    return taskSource
  }
  /** The runner diagnostics channel for the owned async flows. */
  const taskDiag = (): Diag => {
    if (taskDeps === undefined) throw new Error('the task center is not attached')
    return taskDeps.diag
  }
  /** Reset the task-browser dataset scope to the global dataset (PR2 plan
   *  §10.8): every close path (Esc, row selection) clears the scope so the
   *  next ordinary `/tasks` / ↓ Task Center sees `all` again. */
  const resetTaskBrowserScope = (): void => {
    taskBrowserScope = { kind: 'all' }
    taskRuntime?.setScope({ kind: 'all' })
  }
  // The four coordinator commits: the row-identity source for the open
  // browser's select path always reflects the latest commit, and the repaint
  // targets ONLY the open handle. Every commit keeps the runner's `cleanedUp`
  // fence.
  const commitRows = (rows: readonly TaskBrowserRow[], preferred?: string): void => {
    if (isCleanedUp()) return
    taskBrowserRows = [...rows]
    activeTaskBrowser?.setItems(taskPanelItems(rows), preferred)
  }
  const commitBadge = (running: ReadonlyArray<{ id: string; label: string }>): void => {
    if (isCleanedUp()) return
    mounted().setAgents(running.map(entry => ({
      id: entry.id,
      label: entry.label,
      activity: 'running',
    })))
  }
  const commitSummary = (summary: TaskBrowserSummary): void => {
    if (isCleanedUp()) return
    mounted().setTaskSummary(summary)
  }
  const commitRefreshState = (state: 'loading' | 'ready' | 'stale', error?: string): void => {
    if (isCleanedUp()) return
    activeTaskBrowser?.setRefreshState?.(state, error)
  }

  /**
   * Open the Job status viewer (selected-Job detail). It opens one official
   * non-consuming observation stream for exactly this Job and repaints the
   * latest local snapshot on the viewer's timer (the tick never reads Host
   * output).
   */
  const openJobStatusViewer = (
    jobId: string,
    title: string,
    snapshot: {
      readonly kind?: string
      readonly id: string
      readonly label: string
      readonly status: string
      readonly detail?: string
    },
  ): void => {
    const source = taskCenter()
    // One viewer at a time, and a fresh selection replaces the previous.
    activeJobViewerClose?.()
    const ownerSessionId = source.sessionId()
    if (ownerSessionId === undefined) return
    const fallbackText = snapshot.kind === 'subagent'
      ? source.subagentJobViewHint(snapshot.status, snapshot.detail)
      : jobStatusHint(snapshot.status, snapshot.detail)
    // The selected Job is the ONLY observed Job (P1-B1). The observer is
    // event-driven at its data source: the official follow stream updates
    // this local snapshot and the viewer's existing refresh timer merely
    // repaints it — the tick never reads Host output.
    let observed: JobObservedSnapshot | undefined
    let observationError: string | undefined
    let closeObserver: () => void = () => {}
    try {
      closeObserver = source.jobObservation.open(ownerSessionId, jobId, (next) => { observed = next })
    } catch (error) {
      // A composition without the official job-controller row (the injected
      // production row guarantees it) degrades to the status-only detail —
      // the documented P1-B safety valve — and says so explicitly.
      observationError = safeErrorMessage(error)
    }
    const refreshBody = (): string => {
      if (observed !== undefined) return formatJobObservation(observed)
      const jobs = taskCenter().jobs
      const current = jobs === undefined ? undefined : (() => {
        try {
          return jobs.get(jobId, ownerSessionId)
        } catch {
          // The job left the registry (or the session switched): freeze.
          return undefined
        }
      })()
      const base = current === undefined
        ? fallbackText
        : current.kind === 'subagent'
          ? taskCenter().subagentJobViewHint(current.status, current.detail)
          : jobStatusHint(current.status, current.detail)
      return observationError === undefined ? base : `${base}\nlive observation unavailable: ${observationError}`
    }
    activeJobViewerClose = mounted().openOutputViewer({
      title,
      initial: fallbackText,
      refresh: refreshBody,
      onStop: () => {
        const jobs = taskCenter().jobs
        if (jobs === undefined) return
        try {
          jobs.kill(jobId, ownerSessionId, 'stopped from the task browser')
        } catch {
          // Already finished: nothing to stop.
        }
        refreshTasks()
      },
      // Live capability: the Stop hint and the Stop key both read the
      // CURRENT registry record, so a job that settles while the viewer
      // is open stops advertising/handling Stop.
      canStop: () => {
        const jobs = taskCenter().jobs
        if (jobs === undefined) return false
        try {
          return isActiveJobStatus(jobs.get(jobId, ownerSessionId).status)
        } catch {
          // The job left the registry: nothing can be stopped.
          return false
        }
      },
      // The viewer was opened from the Task Center browser: Esc returns
      // to the parent browser, not to the editor.
      closeHint: 'back',
      onClose: () => {
        // Closing the viewer always releases the observer (Esc, the parent
        // browser closing, a session transition, or surface teardown).
        closeObserver()
        activeJobViewerClose = undefined
        refreshTasks()
      },
    })
  }

  /**
   * Open one job from the task browser: an ordinary Job opens the detail
   * viewer, which shows a NON-CONSUMING live output preview through the
   * official JobController.follow() stream (never `jobs.read()`); a subagent
   * job whose stable child session id is unknown shows the same Job detail
   * with a /tasks hint. Returns the navigation disposition for the selecting
   * browser: the transcript path REPLACES the Task Center (`'close'`); a Job
   * detail is a child overlay of it (`'keep-open'`).
   */
  const openJobView = (jobId: string): 'close' | 'keep-open' => {
    const source = taskCenter()
    const ownerSessionId = source.sessionId()
    const jobs = source.jobs
    if (jobs === undefined || ownerSessionId === undefined) return 'keep-open'
    let snapshot: TaskBrowserJobInput
    try {
      snapshot = jobs.get(jobId, ownerSessionId)
    } catch {
      return 'keep-open'
    }
    if (snapshot.kind === 'subagent') {
      const childSessionId = source.subagentJobTranscriptId(snapshot)
      if (childSessionId !== undefined) {
        // The jobs registry's `subagent` kind IS the reliable contract
        // for a background ONE-SHOT delegation (the registry never
        // records continuable children): the transcript viewer opens
        // read-only. The parent is the job owner.
        runOwned('subagent view from tasks', () => source.enterView(
          childSessionId, snapshot.label, 'one-shot', ownerSessionId, 'inactive',
        ), {
          diag: taskDiag(),
          sessionId: () => ownerSessionId,
          onError: (error) => {
            if (isCleanedUp()) return
            mounted().notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error')
          },
        })
        // The transcript viewer is a session surface, not a Job child
        // overlay: it keeps its own Esc semantics (browser closed).
        return 'close'
      }
      // Current JobSnapshot has no stable child id. Use the reliable status
      // fallback and let /tasks (which owns child identities through
      // the merged browser) perform transcript selection; never substitute
      // label/order/time matching.
      openJobStatusViewer(jobId, `subagent ${snapshot.id} · ${snapshot.label}`, snapshot)
      return 'keep-open'
    }
    openJobStatusViewer(jobId, `${snapshot.kind} ${snapshot.id} · ${snapshot.label}`, snapshot)
    return 'keep-open'
  }

  /**
   * Open the Task Browser. `quick` is the ↓ trigger, `full` is the `/tasks`
   * surface; the SAME browser serves both.
   */
  const openTasksBrowser = (
    viewMode: 'quick' | 'full',
    restoreState?: TaskBrowserViewState,
    scope?: TaskBrowserDatasetScope,
    header?: string,
  ): void => {
    const source = taskCenter()
    const browserSessionId = source.sessionId()
    if (isCleanedUp() || browserSessionId === undefined) return
    // PR2 plan §10.5/§10.8: an EXPLICIT scope (a Workflow phase/run
    // dataset) becomes the browser's dataset scope; a transition
    // (Quick→Full / Full→Quick) without one keeps the current scope; a
    // fresh ordinary open after a close always starts from `all` (the
    // close paths reset it). The scope applies at EVERY runtime commit.
    if (scope !== undefined) taskBrowserScope = scope
    taskRuntime?.setScope(taskBrowserScope)
    // The destructive-intent fence is captured at OPEN time: a Stop
    // confirmed later belongs to THIS surface's session. Comparing the
    // generation/session AT dispatch against values captured AT dispatch
    // (as in an earlier revision) could never fail — the intent must be
    // bound to the browser that hosted the confirmation (PR review P1).
    const browserSubject = source.captureSubject()
    const browserToken = {}
    activeTaskBrowserToken = browserToken
    let jobSnapshots: readonly TaskBrowserJobInput[] = []
    const jobs = source.jobs
    if (jobs !== undefined) {
      try {
        // Job ownership is the Session id (DSH 0.1.7 JobRegistry): the
        // live session id is only the id source here.
        jobSnapshots = jobs.list(browserSessionId)
      } catch {
        // The registry read is best-effort; the jobs half stays empty.
      }
    }
    // The trigger only fires while something is ACTIVE (jobs or live
    // children), so an empty jobs half is NOT an empty browser: the
    // children half enriches below. Never early-return on row count —
    // a children-only session would never open the browser. The row
    // identity source is the SURFACE-level `taskBrowserRows` (kept fresh
    // by every coordinator commit), so the select/action paths below
    // never contradict a runtime refresh that already repainted.
    //
    // FIRST FRAME: seed from the coordinator's CURRENT state instead of
    // flashing a jobs-only list — refreshRuntime() is synchronous, never
    // touches persistence, reuses the cached catalog and re-reads the
    // current jobs + registry statuses (activeTaskBrowser is not set
    // yet, so it only seeds taskBrowserRows + the badge). The badge and
    // the panel therefore agree from the first frame, and a FAILED fresh
    // listing below cannot leave a panel that contradicts the badge.
    // Without the runtime (no subagents service) the jobs-only fallback
    // applies.
    const runtime = taskRuntime
    if (runtime !== undefined) {
      runtime.refreshRuntime()
      taskBrowserRows = [...runtime.rows()]
    } else {
      taskBrowserRows = buildTaskRows(jobSnapshots, [])
    }
    const selectRow = (value: string): 'close' | 'keep-open' => {
      if (isCleanedUp()) return 'close'
      const row = taskBrowserRows.find(candidate => candidate.value === value)
      if (row === undefined) return source.rowSelectionDisposition(undefined, 'keep-open')
      if (row.kind === 'subagent') {
        // The viewer target carries the row's OWN parent (plan §6.10:
        // childId + parentId + depth + mode + activity — never just
        // childId + mode). A nested row's durable parent is the exact
        // direct parent recorded by DSH; only a direct child falls back
        // to the browser root (the live main session).
        const parentSessionId = row.parentId !== '' ? row.parentId : source.sessionId()
        if (parentSessionId === undefined) return 'close'
        // The row carries the catalog MODE + projected activity + DEPTH:
        // the viewer target is pinned to them (continuable → interactive
        // editor only at depth 1, one-shot → read-only, depth > 1 →
        // nested read-only), and the follow-up write path to the exact
        // parent.
        runOwned('subagent view from tasks', () => source.enterView(
          row.childId, row.label, row.mode, parentSessionId, row.activity, row.depth,
        ), {
          diag: taskDiag(),
          sessionId: () => source.sessionId(),
          onError: (error) => {
            if (isCleanedUp()) return
            mounted().notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error')
          },
        })
        // The subagent transcript is a session/viewer surface, not a
        // child overlay of the browser: it REPLACES the Task Center and
        // keeps its own Esc semantics.
        return source.rowSelectionDisposition(row, 'keep-open')
      }
      // A Job View is the selected row's DETAIL: it opens as a child
      // overlay (hiding this browser, not destroying it) and returns to
      // the exact browser state on Esc. A job that has already vanished
      // simply opens nothing — the parent stays usable either way.
      return source.rowSelectionDisposition(row, openJobView(row.jobId))
    }
    const stopRow = (value: string): void => {
      if (isCleanedUp()) return
      const row = taskBrowserRows.find(candidate => candidate.value === value)
      if (row === undefined) return
      const actionBrowserToken = activeTaskBrowserToken
      if (actionBrowserToken !== browserToken) return
      // The SURFACE fence: the user's destructive intent is bound to the
      // session that owned this browser when it opened. A session that
      // switched after the browser opened (or while a confirmation was
      // pending) must never be stopped by the stale confirmation — the
      // captured browser values, not the dispatch-time values, are the
      // comparison side that can actually fail.
      if (!source.subjectMatches(browserSubject)) return
      if (row.kind === 'subagent') {
        if (!isSubagentRowInterruptible(row)) return
        // Re-read the live driver at confirmation time; the panel row is
        // only a snapshot and may have become idle since it was rendered.
        if (source.agents?.agentStatusOf(row.childId) !== 'running') return
        // The interrupt authority names the child's DURABLE DIRECT parent;
        // deep descendants must not be addressed through the main root.
        const interruptParent = subagentInterruptParent(row, browserSessionId)
        // The scope-bound writer admission (A3-4): the Task-Center subagent
        // interrupt is NOT a submission write, so its business ownership
        // stays in the runner — only the admission moves through
        // SessionRuntime.withWriter. The surface calls the injected op.
        runOwned('subagent interrupt', function () {
          return source.interruptSubagent(interruptParent, row.childId)
        }, {
          diag: taskDiag(),
          sessionId: () => browserSessionId,
          onResult: (outcome) => {
            if (isCleanedUp() || activeTaskBrowserToken !== actionBrowserToken || !source.subjectMatches(browserSubject)) return
            if (outcome.kind === 'committed') {
              mounted().notify(`stopping ${row.label}`, 'info')
              return
            }
            if (outcome.kind === 'indeterminate') {
              // A dispatched interrupt whose settlement is unknown must not
              // be reported as "not stopped"; the authoritative task/read
              // state decides and no automatic replay happens.
              mounted().notify(`could not confirm stopping ${row.label} — the session state will decide`, 'error')
              return
            }
            const reason = outcome.reason.kind === 'error'
              ? outcome.reason.message
              : outcome.reason.message ?? (outcome.reason.kind === 'unauthorized'
                ? 'subagent interrupt unauthorized'
                : 'subagent service unavailable')
            mounted().notify(`could not stop ${row.label}: ${reason}`, 'error')
          },
          onError: (error) => {
            if (isCleanedUp() || activeTaskBrowserToken !== actionBrowserToken || !source.subjectMatches(browserSubject)) return
            mounted().notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
          },
        })
        return
      }
      // Job stop is capability-gated to an actually active current record.
      // The registry authorizes by the owning Session id (DSH 0.1.7
      // JobRegistry); no output/read cursor is touched by the UI.
      if (jobs === undefined || !isActiveJobStatus(row.status)) return
      try {
        const current = jobs.get(row.jobId, browserSessionId)
        if (current === undefined || !isActiveJobStatus(current.status)) return
        const result = jobs.kill(row.jobId, browserSessionId, 'stopped from Task Center')
        mounted().notify(result === 'already-finished' ? `${row.label} already finished` : `stopping ${row.label}`, 'info')
      } catch (error) {
        mounted().notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
      }
    }
    const initialScope = restoreState?.scope ?? (viewMode === 'quick' ? 'active' : 'all')
    const initialQuery = restoreState?.searchQuery ?? ''
    const initialSelected = restoreState?.selectedId === 'task:view-all' ? undefined : restoreState?.selectedId ?? undefined
    const initialPreferred = initialSelected
      ?? taskBrowserRows.find(row => row.kind === 'subagent' && row.activity === 'running')?.value
      ?? taskBrowserRows.find(row => row.kind === 'job' && isActiveJobStatus(row.status))?.value
    const handle = mounted().openTaskBrowser(
      taskPanelItems(taskBrowserRows),
      // Selection disposition decides whether the browser survives: a Job
      // detail keeps it MOUNTED underneath (the overlay stack hides and
      // restores the exact instance/state on Esc); a terminal navigation
      // (subagent transcript, row left the dataset) drops the
      // active-handle reference so a later runtime refresh cannot repaint
      // a closed browser, and resets the dataset scope (PR2 plan §10.8 —
      // the next ordinary Task Center must see the global dataset).
      (value) => {
        if (isCleanedUp()) return 'close'
        const disposition = selectRow(value)
        if (disposition === 'keep-open') return 'keep-open'
        activeTaskBrowser = undefined
        activeTaskBrowserToken = undefined
        resetTaskBrowserScope()
        return 'close'
      },
      () => {
        if (isCleanedUp()) return
        const current = activeTaskBrowser?.getViewState?.()
        activeTaskBrowser = undefined
        activeTaskBrowserToken = undefined
        resetTaskBrowserScope()
        if (viewMode === 'full' && restoreState !== undefined) {
          // Esc from a promoted full view returns to Quick with the latest
          // shared context, not the state from the promotion moment.
          const state = current ?? quickTaskState ?? restoreState
          openTasksBrowser('quick', state)
        }
      },
      {
        header: header ?? 'Tasks',
        enableSearch: true,
        mode: viewMode,
        openedFrom: viewMode === 'full' && restoreState !== undefined ? 'quick' : 'command',
        scope: initialScope,
        typeFilter: restoreState?.typeFilter,
        initialQuery,
        initialSearchMode: restoreState?.searchMode,
        expandedIds: [...(restoreState?.expandedIds ?? [])],
        collapsedIds: [...(restoreState?.collapsedIds ?? [])],
        selectedId: initialSelected,
        preferredValue: initialPreferred,
        maxVisible: viewMode === 'quick' ? 8 : 18,
        loading: runtime !== undefined && taskBrowserRows.length === 0,
        groupLabels: true,
        onRefresh: () => {
          if (isCleanedUp()) return
          if (runtime === undefined) {
            refreshTasks()
            return
          }
          // Refresh state is SINGLE-OWNER: only the coordinator's
          // commitRefreshState (fenced by session key + request epoch)
          // may set loading/ready/stale on the presentation. The surface
          // must never touch setRefreshState directly — an unfenced
          // onError here could mark a NEW session's browser as failed
          // when the OLD session's listing rejects (PR review P1).
          runOwned('task browser descendants', () => runtime.refreshCatalog(), {
            diag: taskDiag(),
            sessionId: () => source.sessionId(),
          })
        },
        onViewFull: state => {
          if (isCleanedUp()) return
          activeTaskBrowser = undefined
          activeTaskBrowserToken = undefined
          quickTaskState = state
          openTasksBrowser('full', state)
        },
        onStop: stopRow,
        onViewportExpose: ids => { if (!isCleanedUp()) runtime?.acknowledge(ids) },
      },
    )
    activeTaskBrowser = handle
    // Acknowledging failures is CONTINUOUS, not one-shot-at-open: the
    // panel reports each attention row the first time it enters the
    // open viewport (first frame AND every later scroll/page/jump), and
    // the runtime acknowledges exactly those ids (PR review P1/P2). Only
    // rows the user can actually see lose their footer attention;
    // Quick's Active scope leaves terminal failures pending while live
    // work is present, so its badge stays useful.
    // The open triggers a CATALOG refresh (membership may have drifted
    // since the last listing): the coordinator fences it against a
    // session switch and commits through the ACTIVE handle — a browser
    // closed while the listing is in flight is never repainted. The
    // body above is synchronous, so the `runtime` captured for the
    // first-frame seed is still the current coordinator. Refresh state
    // is single-owner: the coordinator's fenced commitRefreshState is
    // the ONLY path that sets loading/ready/stale (an unfenced onError
    // here could mark a new session's browser failed when an old
    // session's listing rejects — PR review P1).
    if (runtime !== undefined) {
      runOwned('task browser descendants', () => runtime.refreshCatalog(), {
        diag: taskDiag(),
        sessionId: () => source.sessionId(),
      })
    }
  }

  /** The Workflow card action sink (PR2 plan §9/§10/§14.5): the TUI emits
   *  semantic intents; THIS handler resolves them against the real Task Center
   *  / Subagent catalog and opens the existing surfaces — never a
   *  Workflow-specific viewer or browser. */
  const handleWorkflowAction = (action: WorkflowAction): void => {
    const source = taskCenter()
    const sessionId = source.sessionId()
    if (sessionId === undefined) return
    switch (action.kind) {
      case 'open-member': {
        // Direct member navigation (plan §9.2): the SINGLE authority
        // resolver checks the catalog facts (row exists, subagent,
        // direct child of the current session, driver running) — the
        // model-side `member.status === running` was already verified by
        // the app at click time. A missing catalog row (agent-start
        // before the listing) or any failed condition is a no-op — the
        // row simply does not open (plan §9.5).
        const row = taskBrowserRows.find(candidate =>
          candidate.kind === 'subagent' && candidate.childId === action.childId)
        const target = workflowMemberViewerTarget(
          { status: 'running', childId: action.childId },
          row,
          sessionId,
        )
        if (target === undefined) return
        runOwned('workflow member view', () => source.enterView(
          target.childSessionId,
          target.label,
          target.mode,
          target.parentSessionId,
          target.activity,
          target.depth,
        ), {
          diag: taskDiag(),
          sessionId: () => source.sessionId(),
          onError: (error) => {
            if (isCleanedUp()) return
            mounted().notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error')
          },
        })
        return
      }
      case 'open-phase-agents':
      case 'open-run-agents': {
        // Scoped Task Viewer (plan §10): the EXACT workflow child-id set
        // becomes the browser's dataset scope; the existing Task Center
        // provides search/filter/browse and the existing cold-view
        // semantics for terminal children (plan §10.7).
        if (taskRuntime === undefined) return
        const count = action.childIds.length
        const header = action.kind === 'open-phase-agents'
          ? `Workflow · ${action.name} · ${action.phaseLabel} · ${count} agent${count === 1 ? '' : 's'}`
          : `Workflow · ${action.name} · ${count} agent${count === 1 ? '' : 's'}`
        openTasksBrowser('full', undefined, { kind: 'subagents', childIds: action.childIds }, header)
        return
      }
    }
  }

  // ── A4-7 presentation event routing (plan §16) ─────────────────────────
  // The routing decisions and fences live here; the runner-owned facts,
  // Direct/domain bookkeeping and presentation targets arrive through the
  // injected `SurfaceEventRoutingSource` bundle. The bodies below are the
  // runner's original routing bodies with the apply/paint calls against the
  // injected targets.

  /** Whether one child id is a member of the cached descendant catalog. */
  const taskHasChild = (childId: string): boolean => taskRuntime?.has(childId) === true

  /** The completion-controller feed (`agent/status` main branch): the ONLY
   *  path to the controller, shared by the routing and the public entry. */
  const feedCompletionStatus = (agentId: string, status: AgentLifecycleStatus): void => {
    completionController.onAgentStatus(agentId, status)
  }

  const routeSessionEvent = (session: { readonly id: string }, event: Event): void => {
    const source = routing()
    if (source.isCleanedUp()) return
    if (!source.isAttachedSession(session)) return
    // Opening journals fence presentation only. Runtime bookkeeping must
    // continue to observe the target for selections, approvals, and cleanup.
    const openingTarget = openingJournal.isOpening(session.id)
    // The retiring committed Agent remains authoritative until quiesce
    // completes; the published opening target may also emit before commit.
    const mainEvent = session.id === source.currentSessionId() || openingTarget
    let settledViewChildId: string | undefined
    if (mainEvent) {
      settledViewChildId = source.observeMainEvent(session.id, event)
    }
    const viewedId = source.viewedChildId()
    if (openingTarget && (viewedId === undefined || viewedId !== session.id)) {
      openingJournal.record(session.id, event)
      return
    }
    if (source.appendOpeningViewerEvent(session.id, event)) return
    if (!source.hasLiveAgent()) return
    const ownerSessionId = source.currentSessionId()
    if (viewedId !== undefined) {
      if (session.id === viewedId) {
        const viewer = source.viewedChild()
        viewer.applyToolPreview(event)
        viewer.folder.apply([event])
        viewer.stats.apply([event])
        // The store-activity snapshot moves with the child's own
        // lifecycle: a turn starting means the child is live again
        // (cold resume), a turn ending parks it. The footer's activity
        // field follows, so an inactive child that cold-resumes shows
        // running while it streams.
        if (event.type === 'turn/start') {
          viewer.beginTurn()
        } else if (event.type === 'turn/end') viewer.endTurn()
        source.schedulePaint()
        // The child's turn/step/stats counters move at step boundaries
        // (the stats fold counts at step/end) — the footer follows then,
        // never on every streaming delta. A turn START also refreshes so
        // the activity flips to running the moment a cold resume begins.
        if (event.type === 'turn/start' || event.type === 'step/end' || event.type === 'turn/end') viewer.refreshFooter()
        if (event.type === 'turn/start' || event.type === 'agent/inbox/spliced') queueMicrotask(() => source.refreshPendingInput())
        if (event.type === 'turn/end') source.paintNow()
        return
      }
      // Any OTHER session's events (the live agent's) keep routing to the
      // main folder below — the viewer never starves the main transcript.
    }
    if (session.id !== ownerSessionId) return
    const main = source.main()
    main.applyToolPreview(event)

    if (event.type === 'tool/result') {
      const childId = settledViewChildId
      const popAfterApply = childId !== undefined && viewedId !== undefined && viewedId === childId
      if (popAfterApply) {
        // The event below lands in the main folder FIRST so the pop shows
        // the settled card, not the running one.
        main.folder.apply([event])
        main.stats.apply([event])
        source.exitView()
        return
      }
    }
    main.folder.apply([event])
    main.stats.apply([event])
    // The goal badge folds incrementally: the newest goal/change event
    // decides, so one event is enough (clear/completed hide the badge).
    if (event.type === 'goal/change') source.applyGoalChange(event)
    // Permission knob events (preset/policy/mode) carry no transcript
    // content, so they must not schedule a repaint: the repaint would call
    // setTranscript and wipe an in-flight notify (e.g. the
    // "permission: …" notice) ~REPAINT_FLUSH_MS after the switch, making
    // it flash. The footer badge refresh below repaints the status line
    // instead, and the next real session event repaints the transcript.
    const isKnob = event.type === 'permission/preset' || event.type === 'approval/policy' || event.type === 'sandbox/mode'
    if (!isKnob) source.schedulePaint()
    if (event.type === 'todo/write') mounted().setTodoSummary((event.data as { readonly todos: readonly TodoItem[] }).todos)
    if (event.type === 'plan/mode') mounted().setPlanMode((event.data as { readonly active: boolean }).active)
    if (event.type === 'session/title') mounted().setSessionTitle(source.sessionTitleOf(event))
    // A permission switch (command, Shift+Tab, settings panel) lands as
    // knob events between turns: refresh the footer mode badge right away
    // instead of waiting for the next step/turn boundary.
    if (isKnob) {
      // Knob events are UI-only: the permission badge repaints from
      // cached facts — never a context measurement.
      source.refreshStatusCheap()
    }
    // Every durable inbox mutation (followup, steer, splice) commits
    // an agent/inbox/spliced event. The upstream Inbox commits the event
    // BEFORE its live projection mutates (synchronous observers see the
    // pre-splice lists), so the pane must read the inbox on the next
    // microtask — after the splice has actually landed. This is also the
    // FIRST authoritative signal a submission reached the session: the
    // local ack row and the latency timeline settle here.
    if (event.type === 'agent/inbox/spliced') {
      source.settleLocalSubmitAck('inbox inserted')
      source.markSubmitLatency(ownerSessionId, 'inbox.inserted')
      queueMicrotask(() => source.refreshPendingInput())
    }
    // The user message committing to the session is the ack row's
    // AUTHORITATIVE clear (the host pre-step can delay it well past the
    // inbox insert); the first assistant chunk stamps the provider's
    // first-token latency once per turn.
    if (event.type === 'user/message') {
      source.settleLocalSubmitAck('user message')
      source.markSubmitLatency(ownerSessionId, 'user.message')
      // The durable human prompt is now applied to the transcript folder:
      // retire the matching local submission echo by identity. The `source`
      // is read structurally here and never routed into the shared
      // presentation port.
      const origin = (event.data as { readonly source?: unknown }).source as
        | { readonly kind?: unknown; readonly rpcId?: unknown }
        | undefined
      if (origin?.kind === 'user' && typeof origin.rpcId === 'string') {
        source.observeDurableSubmission(origin.rpcId)
        // Paint the durable replacement into the message tree FIRST, then
        // retire the local echo in the same frame: removing the lane before
        // the durable row is paintable would leave one blank frame.
        source.paintNow()
        source.refreshPendingInput()
      }
    }
    // Compaction lifecycle (dsh-compaction is not a peer — the event
    // data is read structurally): the working row advertises the
    // compaction phase (summarizing → applying), the busy flag covers
    // the single-Esc cancel (pi parity), and the settle notifies. The
    // compactionId pairs start/end so a stale end can never clear a
    // NEWER compaction's state (foldCompactionEvent).
    const compacted = foldCompactionEvent({ id: compactingId }, event as never)
    compactingId = compacted.id
    if (compacted.phase === 'summarizing') {
      mounted().setCompactionPhase('summarizing')
      // Busy while compacting: a single Esc cancels the compaction (pi
      // parity — compaction rides the turn signal).
      mounted().setBusy(true)
    }
    if (compacted.phase === 'applying') {
      mounted().setCompactionPhase('applying')
    }
    if (compacted.clear) {
      // The compacted replacement has committed to the live session
      // surface: re-measure context immediately so the footer reflects
      // the new surface without waiting for the next step/start or
      // turn/end. The working row hands back to the turn state: a
      // turn-enclosed compaction keeps the turn animation, a standalone
      // one clears.
      // Compaction rewrites the model-visible surface: re-measure NOW
      // (the footer would otherwise show stale pressure until the next
      // step/start or turn/end).
      settleCompactionSurface(mounted(), () => {
        source.markContextDirty()
        source.refreshContextMeasurement('compaction-end')
      }, source.currentWorkingFromLog())
    }
    if (compacted.notify !== undefined) mounted().notify(compacted.notify.text, compacted.notify.kind)
    // PR D2: route the context re-measure decision through the single
    // classifier (test seam). compaction/end is NOT routed here — its
    // re-measure is driven by the MATCHED compaction fold above (a stale
    // compaction/end must never re-measure).
    const eventType = String(event.type)
    if (eventType !== 'compaction/end' && contextRefreshKind(eventType) === 'measure') {
      source.markContextDirty()
      source.refreshContextMeasurement(eventType === 'turn/end' ? 'turn-end' : 'step-start')
    }
    // Persist each completed turn so a crash loses at most the live turn.
    // The busy indicator follows turn boundaries: on from the moment a
    // turn starts (model wait + tool calls), off when it ends.
    if (event.type === 'turn/start') {
      // The turn is live: the Working row takes over the feedback surface
      // and the submit timeline stamps the turn boundary.
      source.settleLocalSubmitAck('turn started')
      source.markSubmitLatency(ownerSessionId, 'turn.start')
      mounted().setWorking(true)
      mounted().setBusy(true)
    } else if (event.type === 'turn/end') {
      mounted().setWorking(false)
      // NOTE: the submit-latency timeline is deliberately NOT reset on
      // turn/end — a submission accepted while this turn was running
      // (busy/queue) is processed by the NEXT turn, and resetting here
      // would erase exactly the T1→T4/T4→T5 journey Phase E exists to
      // measure. The baseline ends only on: the next accept (rebase),
      // the assistant.first auto-complete, a terminal non-delivery exit
      // (token-scoped settle) or a session switch.
      // A turn end must not clear the busy flag while a compaction is
      // still in flight (an interrupted turn can close before its
      // compaction settles) — the single-Esc cancel stays armed.
      mounted().setBusy(busyAfterTurnBoundary('turn/end', compactingId !== undefined))
      source.paintNow()
      // Persist each completed turn so a crash loses at most the live
      // turn. Detached: a flush rejection must never surface as an
      // unhandled rejection in the event firehose. An ENOENT flush (the
      // log was removed externally) is user-recoverable: notify with the
      // actionable hint — the session keeps working in memory, but
      // persistence cannot resume until restart.
      source.flushTurn()
    }
  }

  const routeSubagentLifecycle = (): void => {
    const source = routing()
    // Subagent lifecycle events drive the continuable-children half of the
    // dock badge (they never register jobs). These are CATALOG events:
    // membership/tree may have changed, so they re-list.
    refreshAgents()
    queueMicrotask(() => source.refreshPendingInput())
  }

  const routeAgentStatus = (agentId: string, status: AgentLifecycleStatus): void => {
    const source = routing()
    if (source.isCleanedUp()) return
    const currentAgentId = source.completionOwnerId()
    // `agent/status` is the LIVE runtime channel: a child's driver
    // transition (running ↔ idle) must repaint the task browser and the
    // badge WITHOUT a re-listing — membership changes come only from the
    // lifecycle events, and `listDescendants().activity` is
    // store-presence, never execution state.
    // The membership gate keeps this cheap and safe: only flips of children
    // in the CACHED catalog refresh the task surface — the MAIN agent's own
    // per-turn flips (and any stale post-switch event) do not re-list it.
    if (currentAgentId !== undefined && agentId === currentAgentId) {
      feedCompletionStatus(agentId, status)
      queueMicrotask(() => source.refreshPendingInput())
      return
    }
    if (!taskHasChild(agentId)) return
    refreshAgentRuntimeOnly()
    if (source.viewedChildId() === agentId) queueMicrotask(() => source.refreshPendingInput())
  }

  // Provider-topology and credential events refresh the footer model row
  // and the welcome card: a /login /logout /add-provider (or an external
  // settings.yaml / .credentials.yaml edit) changes the live provider /
  // model surface, and the status line must not keep showing a stale
  // selection. Both are capability-optional: an absent llm / settings /
  // credentials service never mounts them, and a throwing listener is
  // contained by the event bus (the refresh is best-effort). The credential
  // update surface has reference and durable-record events; both change the
  // same footer/welcome state, so they share one refresh callback.
  const routeProviderRefresh = (): void => {
    const source = routing()
    if (source.isCleanedUp()) return
    source.refreshStatusAndWelcome()
  }

  const routeSettingsRefresh = (namespace: string): void => {
    const source = routing()
    if (source.isCleanedUp()) return
    if (namespace === 'llm-pi-ai' || namespace === 'llm-deepseek') {
      source.refreshStatusAndWelcome()
    }
  }

  const isCurrentAssistantAgent = (agent: unknown): boolean => {
    const source = routing()
    // EXACT Agent object identity (master's own headless consumer
    // compares `subject !== agent` the same way): a stale stream from
    // a retired agent must never reach the presentation, even when the
    // replacement agent drives the SAME session.
    if (typeof agent !== 'object' || agent === null) return false
    const subject = agent as object
    const candidateId = (subject as { session?: { id?: unknown } }).session?.id
    if (typeof candidateId !== 'string' || !source.registeredAgentIs(candidateId, subject)) return false
    if (source.isCurrentOwnerAgent(subject)) return true
    // The adapter accepts every registered live Agent so an unviewed child
    // can retain its transient baseline without entering the main surface.
    const viewedId = source.viewedChildId()
    if (viewedId === undefined) return true
    if (candidateId !== viewedId) return false
    // The viewed child follows one exact Agent object at a time. A same-session
    // cold-resume replaces a disposed Agent; the registry
    // identity change is the lifecycle rollover edge for this viewer.
    const viewedAgent = source.viewedChildAgent()
    if (viewedAgent !== undefined) {
      if (viewedAgent === subject) return true
      if (source.agentForSession(viewedId) !== viewedAgent) {
        source.setViewedChildAgent(subject)
        source.setViewedQueueAgent(subject)
        queueMicrotask(() => source.refreshPendingInput())
        return true
      }
      return false
    }
    source.setViewedChildAgent(subject)
    source.setViewedQueueAgent(subject)
    queueMicrotask(() => source.refreshPendingInput())
    return true
  }

  const applyAssistantInput = (input: AssistantLiveInput): void => {
    const source = routing()
    // The preview projection keeps the durable completed-turn guard:
    // a late live chunk for a completed turn is a replay artifact and must
    // not resurrect a preview. The folder/stats folds carry their own
    // gates. A FAILED attempt (abandoned end or a committed `assistant/attempt`
    // settlement) clears the step's tool previews — its deltas never
    // materialized into durable calls.
    const viewedId = source.viewedChildId()
    if (openingJournal.isOpening(input.sessionId) && (viewedId === undefined || viewedId !== input.sessionId)) return
    if (viewedId !== undefined && input.sessionId === viewedId) {
      source.applyViewedChildAssistantInput(input)
      source.schedulePaint()
      return
    }
    const sessionId = source.currentSessionId()
    if (sessionId === undefined || input.sessionId !== sessionId) return
    source.applyMainAssistantInput(input, sessionId)
    source.schedulePaint()
  }

  const applyResumedCompaction = (id: string | undefined, active: boolean): void => {
    compactingId = id
    mounted().setCompactionPhase(active ? 'summarizing' : 'idle')
    if (active) {
      mounted().setBusy(true)
      mounted().setWorking(true)
    }
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
      feedCompletionStatus(agentId, status)
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
    attachTasks(source, deps) {
      taskSource = source
      taskDeps = deps
      // The jobs half: the dock roster feed + the scope-owned event
      // subscription. Absent service = no jobs surface (the original two
      // conditional blocks are preserved).
      const jobs = source.jobs
      if (jobs !== undefined) {
        refreshTasks = (): void => {
          if (isCleanedUp()) return
          let snapshots: readonly TaskBrowserJobInput[]
          try {
            // Keep terminal records in the catalog — the registry IS the
            // membership authority, and TRACKED is its current roster.
            // Job ownership is the Session id; without a live agent the
            // registry read is the unowned-only view (caller omitted).
            snapshots = jobs.list(source.sessionId())
          } catch {
            // Best-effort: a failed registry read is NOT an authoritative
            // empty catalog. Keeping the previous snapshot matters most for
            // a Job detail's retained parent browser — the close-time
            // refresh must not blank the rows/selection it restores.
            return
          }
          const tasks = snapshots.map(job => ({
            id: job.id,
            label: job.label,
            status: job.status,
            kind: job.kind,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
          }))
          mounted().setTasks(tasks)
          // A jobs-only session has no catalog coordinator, so this is the
          // ONLY refresh channel for an OPEN browser. Keep it in step with
          // the registry, or a Job detail's hidden parent returns with stale
          // status (the subagents path commits through TaskBrowserRuntime).
          if (taskRuntime === undefined && activeTaskBrowser !== undefined) {
            taskBrowserRows = buildTaskRows(snapshots, [])
            activeTaskBrowser.setItems(taskPanelItems(taskBrowserRows))
          }
        }
        // Events route by SEMANTICS, mirroring the TaskBrowserRuntime's own
        // catalog/runtime split:
        // - `output` is a ring APPEND and changes no roster/status fact;
        // - `progress` / `stopping` change only JobView runtime facts (the
        //   runtime-only refresh re-projects from the cached catalog);
        // - everything else may move membership: the full catalog refresh.
        jobsEventsDispose = jobs.subscribe((event) => {
          switch (event.type) {
            case 'output':
              return
            case 'progress':
            case 'stopping':
              refreshTasks()
              refreshAgentRuntimeOnly()
              return
            default:
              refreshTasks()
              refreshAgents()
          }
        })
        refreshTasks()
      }
      // The subagent half: the TaskBrowserRuntime coordinator owns the
      // catalog-vs-runtime split (see task-browser-runtime.ts).
      const agents = source.agents
      if (agents !== undefined) {
        taskRuntime = new TaskBrowserRuntime({
          currentKey: agents.currentKey,
          listDescendants: agents.listDescendants,
          readJobs: agents.readJobs,
          agentStatusOf: agents.agentStatusOf,
          commitRows,
          commitBadge,
          commitSummary,
          commitRefreshState,
        })
        // Seed the summary synchronously from jobs before the durable
        // catalog listing lands; this prevents a terminal/jobs-only first
        // frame from claiming every record is still running.
        taskRuntime.refreshRuntime()
        refreshAgents = (): void => {
          if (isCleanedUp()) return
          if (source.sessionId() === undefined) {
            mounted().setAgents([])
            return
          }
          runOwned('task browser agents refresh', () => taskRuntime!.refreshCatalog(), {
            diag: taskDiag(),
            sessionId: () => source.sessionId(),
          })
        }
        refreshAgentRuntimeOnly = (): void => {
          if (isCleanedUp()) return
          if (source.sessionId() === undefined) {
            mounted().setAgents([])
            return
          }
          taskRuntime!.refreshRuntime()
        }
        refreshAgents()
      }
    },
    refreshTasks() {
      refreshTasks()
    },
    refreshAgents() {
      refreshAgents()
    },
    refreshAgentRuntimeOnly() {
      refreshAgentRuntimeOnly()
    },
    hasTask(childId) {
      return taskHasChild(childId)
    },
    resetTasks() {
      // A new session owns the surface: close the Job child overlay FIRST
      // (so closing the hidden parent cannot leave the child alive), then
      // the browser, then reset the coordinator + the synchronous
      // badge/summary/row mirrors (the new session's first listing is async
      // and the old session's state must not hang on screen).
      activeJobViewerClose?.()
      activeJobViewerClose = undefined
      activeTaskBrowser?.close()
      activeTaskBrowser = undefined
      activeTaskBrowserToken = undefined
      taskRuntime?.reset()
      // The dataset scope is session-scoped too: a switched-in session must
      // never inherit a Workflow-scoped browser (PR2 plan §10.8).
      taskBrowserScope = { kind: 'all' }
      mounted().setTaskSummary({ runningAgents: 0, totalAgents: 0, runningJobs: 0, totalJobs: 0, failedAttention: 0, failedTotal: 0 })
      mounted().setTasks([])
      mounted().setAgents([])
      taskBrowserRows = []
    },
    openTasksBrowser(viewMode, restoreState, scope, header) {
      openTasksBrowser(viewMode, restoreState, scope, header)
    },
    openJobView(jobId) {
      return openJobView(jobId)
    },
    attachInteraction(port, deps) {
      // The interactive answerer: every approval ask becomes a dialog. An
      // already-aborted request settles cancelled synchronously; otherwise
      // the prompt's own abort signal withdraws it (turn cancel). P7c: the
      // dialog previews the paired tool call's arguments and flags dangerous
      // commands.
      port.onApprovalRequest((req, next) => {
        if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
        const args = req.callId === undefined ? undefined : deps.lookupCallArgs(req.callId)
        return mounted().showApprovalPrompt({
          toolName: req.toolName,
          reason: req.reason,
          signal: req.signal,
          ...args === undefined ? {} : { arguments: args },
          ...args !== undefined && req.toolName === 'bash' && deps.dangerCommand(args) ? { danger: true } : {},
        })
      })
      // The interactive question answerer: ask_user_question tool calls
      // become dialog flows; the tool receives the structured answers.
      port.registerQuestionProvider(async (request) => {
        const answers = await mounted().askQuestions(request.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.detail !== undefined ? { detail: question.detail } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {},
          ...question.intent !== undefined ? { intent: question.intent } : {},
        })), request.signal)
        return {
          answers: answers.map(answer => ({
            id: answer.id,
            selected: answer.selected,
            ...answer.custom !== undefined ? { custom: answer.custom } : {},
          })),
        }
      })
    },
    attachEventRouting(source) {
      routingSource = source
    },
    routeSessionEvent,
    routeSubagentLifecycle,
    routeAgentStatus,
    routeProviderRefresh,
    routeSettingsRefresh,
    isCurrentAssistantAgent,
    applyAssistantInput,
    applyResumedCompaction,
    disposeJobEvents() {
      jobsEventsDispose?.()
      jobsEventsDispose = undefined
    },
    disposeJobObservation() {
      // Release the selected-Job follow stream explicitly: TuiApp.dispose()
      // does not invoke the viewer's onClose, so the observer would otherwise
      // outlive the surface.
      activeJobViewerClose?.()
      activeJobViewerClose = undefined
    },
    disposeTaskBrowser() {
      // TuiApp.dispose() hides overlays without invoking their user cancel
      // callbacks. Drop the browser handle and invalidate the token so an
      // action already waiting on Direct/Host work cannot notify or repaint
      // the dead surface after teardown.
      activeTaskBrowser = undefined
      activeTaskBrowserToken = undefined
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
