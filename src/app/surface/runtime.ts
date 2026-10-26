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
  type ComposerSubmitRequest,
  type DisplaySubjectPresentation,
  type HistoryOpenScope,
  type StatusData,
  type TranscriptSearchCloseReason,
  type TranscriptSearchPresentation,
  type TranscriptSearchPresentationTarget,
  type TuiApp,
  type TuiAppEvents,
  type TuiAppOptions,
} from '../../tui-app.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import type { CompactionPhase } from './compaction-presentation.ts'
import type { SubmissionComposerPort } from '../submission/composer-port.ts'
import type { ModelPresentation } from '../command/model-presentation.ts'
import type { PresetPresentation } from '../command/preset-presentation.ts'
import type { SessionBrowserPresentation } from '../command/session-browser-presentation.ts'
import { pituiSurfaceInteractionPresenter, type SurfaceInteractionPresenter } from './interaction-presenter.ts'
import type { TaskBrowserDatasetScope } from './task-browser-runtime.ts'
import type { QuestionAttentionRow } from './question-controller.ts'
import type { InteractionPort } from '../../runtime/interaction-port.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import { ImageLoader } from '../../client/media/image/loader.ts'
import { selectDraftImageOccurrences } from '../../client/media/image/placeholder.ts'
import type { DraftImage } from '../../client/media/image/types.ts'
import { SvgRasterLoader } from '../../client/media/svg/raster-loader.ts'
import { isolatedSvgRasterSupported, rasterizeSvg } from '../../client/media/svg/rasterize.ts'
import type { ImageAttachmentRefLike } from '../../domain/media/types.ts'
import { StatusStore } from '../../domain/status/store.ts'
import type { StatusPatch } from '../../domain/status/types.ts'
import { initialStatusSnapshot } from '../../domain/status/snapshot.ts'
import { assistantPresentationRevision, assistantStepOf, type TranscriptFolder } from '../../domain/transcript/folder.ts'
import type { TranscriptMessage, TurnActivity } from '../../domain/transcript/types.ts'
import { eligibleFinalAssistant } from '../../domain/transcript/final-assistant.ts'
import { deliveredTurnsOf, type DeliveredFilesCapability, type DeliveredFilesSnapshot } from '../../domain/deliverables/catalog.ts'
import { collectPublishedVisuals, type PublishedVisual } from '../../domain/visual/publication.ts'
import {
  clearAssistantVisualPresentation,
  setAssistantVisualPresentation,
  type VisualEventSnapshot,
  type VisualPresentationKey,
} from '../../domain/visual/presentation.ts'
import type { TranscriptSearchMatch } from '../../domain/transcript/search.ts'
import type { TranscriptWindowController } from '../../domain/transcript/window.ts'
import { streamingToolPreviewSnapshot, type StreamingToolPreview } from './streaming-tool-preparing.ts'
import { buildPendingPresentation } from './pending-presentation.ts'
import { refreshedSearchState, steppedSearchOverlayState } from './search-overlay.ts'
import { createSearchProfiler, searchProfilingEnabled, type SearchProfile } from './search-profile.ts'
import { createOpeningJournal, type OpeningJournal } from './opening-journal.ts'
import { parseTerminalProgressMode, type TerminalProgressOutcome } from '../../domain/terminal-progress/settings.ts'
import { createTerminalProgressInterval, type IntervalProgress } from '../../domain/terminal-progress/interval.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
// TS3 §31-§36: the surface's independent application-level owners. Each is
// constructed exactly once here; none of them imports this aggregate's value
// implementation (only its cross-owner facade types).
import { createNotificationRuntime, type AgentLifecycleStatus, type TerminalNotificationPresentation } from './notification-runtime.ts'
import type { NotificationMethod, NotificationMode } from '../../domain/notification/settings.ts'
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
  type MainProgressAuthority,
  type RoutedSessionEvent,
  type SurfaceEventRoutingSource,
} from './event-routing.ts'
import type { SurfaceDisplaySeam } from './display-seam.ts'
import { pituiDisplaySeam } from './display-seam-pitui.ts'
import { pituiTaskCenterPresentation } from './task-presentation-pitui.ts'
import type { TaskCenterPresentationPort } from './task-presentation-port.ts'

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

/**
 * PR3-B §3.3 (the B1 slice): the renderer-facing input binding — a NARROW
 * structural projection of the existing `TuiAppEvents` (the lifecycle/user
 * activity members), constructed at the `SurfaceRuntime.start` composition
 * site from the exact already-built callbacks. B2 widens this with the
 * submission members (`submit`/`steer`/`cancel`); B1 binds editor-local +
 * lifecycle only, so no pre-bind key can act as an application gesture.
 */
export interface SurfaceInputBinding {
  /** The keyboard exit intent (the SAME orchestration as `/exit`). */
  exit(): void
  /**
   * The interrupt/cancel intent (the SAME orchestration as PiTui's
   * Ctrl+C/Esc: abort a running local shell and interrupt the live Agent —
   * never an unconditional exit; PR3-B §3.4 fixed keymap row 3).
   */
  cancel(): void
  /**
   * The submission entry (PR3-B B2): the EXISTING application submit path
   * (`ApplicationEvents.events.onSubmit`), so a TSP Enter rides the ONE
   * `SubmissionController` — never a renderer-owned writer. The renderer
   * clears the composer BEFORE this call (§3.4 ordering).
   */
  submit(text: string, request: ComposerSubmitRequest): void
  /** The draft-steer entry (B2): `ApplicationEvents.events.onSteer`. */
  steer(text: string): void
  /**
   * PR4: the paste-media intent — `ApplicationEvents.events.onClipboardPaste`,
   * the ONE application entry that owns the OS clipboard FIFO, the image
   * limits and the draft write. A TSP Ctrl+V forwards here exactly once; the
   * renderer never probes the clipboard itself.
   */
  pasteMedia(): void
  /** Real user input on the editor seat (editable/submit keys). */
  noteUserInput(): void
  /**
   * PR3-B B3 (§3.8): the FRESH authoritative continued-Question rows. A
   * PRESENTATION projection of the ONE `QuestionSurfaceController` — the
   * renderer filters `presentation === 'parked'` itself and never keeps a
   * second registry. An absent controller reads `[]`.
   */
  listContinuedQuestions(): readonly QuestionAttentionRow[]
  /**
   * PR3-B B3 (§3.8): reopen one continued Question through the ORIGINAL
   * controller (its own authoritative recheck decides). `false` means the
   * entry is no longer answerable; the renderer mounts nothing by itself and
   * never writes to a Host/port answer path.
   */
  reopenContinuedQuestion(sessionId: string, callId: string): boolean
}

/**
 * PR-C: the ONE Client-local image binding a mounted renderer receives.
 *
 * It is a PRESENTATION assembly contract, never a Host capability: the two
 * facts a renderer needs to present a durable image attachment are the loader
 * (the single read authority and the single cache) and the scope sampler (the
 * immutable display-subject identity the read is authorized under). The PiTui
 * branch consumes the SAME loader instance, so a mount has exactly ONE loader
 * and no application-wide image state.
 */
export interface SurfaceImageBinding {
  /** The ONE image loader of this mount. */
  readonly imageLoader: ImageLoader
  /**
   * The presentation-scope sampler. A renderer samples it ONCE per display
   * subject and keeps the returned identity object immutably: an async settle
   * must never re-resolve the subject, or a retired presentation could read
   * under a successor's authorization.
   */
  readonly imageScope: () => unknown
  /**
   * PR4: the READ-ONLY live draft projection the dock presents. It is a
   * DIFFERENT capability from the durable `imageLoader`/`imageScope` pair — a
   * staged draft is Client-local editor state, not a durable attachment — and
   * it exposes no mutation (`add`/`remove`/`clear`/`submit`/path read): the
   * draft lifecycle stays with the ONE `DraftImageStore` the application owner
   * writes. Each call re-reads the LIVE composer text, so the projection can
   * never serve a stale occurrence list.
   */
  readonly draftImages: SurfaceDraftImageProjection
}

/** One ordered staged-image occurrence of the LIVE composer draft. */
export interface SurfaceDraftImageOccurrence {
  /** The staged draft entry (its own bytes, media type and identity). */
  readonly image: DraftImage
  /** The occurrence's 0-based rank among ALL canonical occurrences. */
  readonly ordinal: number
  /** The exact `[image #N (W×H)]` token text this occurrence matched. */
  readonly placeholder: string
}

/**
 * PR4: the narrow read-only draft projection a mounted renderer receives.
 *
 * It answers exactly one question — "which staged images does the CURRENT
 * composer draft reference, in text order?" — through the ONE canonical
 * parser (`selectDraftImageOccurrences`), so the dock's preview and the
 * submission expansion can never disagree about WHICH images a draft holds.
 * It reads live state on every call and owns no cache, no list and no
 * subscription.
 */
export interface SurfaceDraftImageProjection {
  occurrences(): readonly SurfaceDraftImageOccurrence[]
}

/**
 * PR4: the ONE construction of the read-only draft projection the dock
 * consumes. It reads the LIVE composer text and the ONE preview source on
 * every call, through the canonical `selectDraftImageOccurrences` parser — so
 * the dock's previews and the submission expansion can never disagree about
 * which staged images a draft references, and no caller has to re-implement
 * that scan.
 *
 * An absent composer (before the mount returns) or an absent preview source
 * answers `[]`: the truthful "no live composer yet" state, never a fabricated
 * occurrence.
 */
export function createSurfaceDraftImageProjection(
  composer: () => SubmissionComposerPort | undefined,
  preview: import('../../client/media/image/types.ts').DraftImagePreviewSource | undefined,
): SurfaceDraftImageProjection {
  return {
    occurrences: () => {
      const live = composer()
      if (live === undefined || preview === undefined) return []
      return selectDraftImageOccurrences(live.getDraft(), preview).map(occurrence => ({
        image: occurrence.image,
        ordinal: occurrence.ordinal,
        placeholder: occurrence.image.placeholder,
      }))
    },
  }
}

/**
 * PR3-A: one already-connected renderer mount the composition root hands to
 * {@link SurfaceRuntime.start} instead of the default PiTui process mount.
 * The mount owns its own terminal (the TSP SDK session); the surface never
 * constructs a `TuiApp` on this branch, and the returned disposer is invoked
 * ONCE inside the surface's own ordered disposal.
 */
export interface SurfaceRendererMount {
  /**
   * Mount the renderer. Runs at the exact original `startProcessTui` position;
   * a throw is the runner's fatal path (never a silent PiTui fallback).
   *
   * PR-C: the mount receives the ONE image binding of this surface BEFORE the
   * renderer's first projection, so the renderer can present a durable image
   * attachment through the SAME loader and scope authority the PiTui branch
   * uses. A renderer that ignores the binding has no image capability.
   */
  mount(binding: SurfaceImageBinding): {
    /** The renderer-facing display seam implementation. */
    readonly display: SurfaceDisplaySeam
    /**
     * B3-A1: the renderer's Task Center presentation sink. The ONE Task
     * Runtime keeps every business fact; this port only carries the rows and
     * chrome it already decided. A renderer without a Task Center still
     * supplies the port (its capability flag is the reachability truth).
     */
    readonly taskPresentation: TaskCenterPresentationPort
    /**
     * PR3-B §3.1: the renderer's composer projection (B1: the TSP
     * renderer's ONE program-owned composer; the PiTui branch is the live
     * `TuiApp` itself).
     */
    readonly composer: SubmissionComposerPort
    readonly modelPresentation?: ModelPresentation | undefined
    /** The native `/preset` presenter, beside the Model one. */
    readonly presetPresentation?: PresetPresentation | undefined
    /** Internal read-only Session Browser presenter; no production command opens it in B1-A. */
    readonly sessionBrowserPresentation?: SessionBrowserPresentation | undefined
    /**
     * PR3-B §3.2: the renderer's modal presenter. B1 keeps the INERT
     * implementation (no TSP form exists; every ask rejects — fail-closed,
     * consistent with `supportsModals === false`); B3 replaces it with the
     * real TSP interaction presenter.
     */
    readonly interaction: SurfaceInteractionPresenter
    /**
     * PR3-B §3.3 (the B1 review F4 contract): bind the application input
     * handlers ONCE. The renderer holds pre-bind keys in a bounded
     * renderer-local queue and consumes them exactly once here; a dispose
     * before the bind discards the queue unconsumed. B1 binds the
     * editor-local/lifecycle projection; B2 widens it with submissions.
     */
    readonly bindInput: (handlers: SurfaceInputBinding) => void
    /**
     * Stop the renderer and release its terminal ONCE (the TSP branch closes
     * the SDK surface then the session). May be async; the surface disposal
     * awaits it inside its ordered batch after the interaction owner dies.
     */
    readonly dispose: () => Promise<void>
  }
  /**
   * PR3-A ownership handshake: release a renderer that was CONNECTED but
   * NEVER mounted — the surface was already disposed, or the mount was
   * rejected (a handshake that outlived its HMR'd runner, a startup abort).
   * Without it the connected SDK session would keep owning raw-mode stdin
   * with no registered disposer. Idempotent, and a no-op once {@link mount}
   * transferred ownership to the surface's own disposal.
   */
  releaseUnmounted(): Promise<void>
}
/**
 * Phase 3B / B3-B: `SurfaceMountDeps.captureHistoryScope` reuses the ONE
 * `HistoryOpenScope` declaration owned by `src/tui-app.ts` (type-only import in
 * the same direction as `TuiAppOptions`). Keeping the declaration on the TUI
 * side is what stops the DOM-less bench program (`scripts/bench.mts` imports
 * `src/tui-app.ts`) from pulling this whole surface/extension graph in.
 */

/** The capabilities the mount needs; each is resolved by the runner/bootstrap. */
export interface SurfaceMountDeps {
  /** The application input contract (session/submission/command owners). */
  readonly events: TuiAppEvents
  /**
   * PR3-A (experimental): an already-connected renderer mount that owns the
   * terminal instead of the default PiTui process mount. When present, no
   * `TuiApp` is constructed (`surface.app` throws); the surface commits
   * through the mount's display seam and disposes it in its ordered teardown.
   */
  readonly renderer?: SurfaceRendererMount
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
  /** The ONE atomic History currentness capture (Phase 3B / B3-B): the
   *  application composition reads the runtime's single `SessionScopeAuthority`
   *  ONCE per Ctrl+R open and hands the TUI a `{ sessionId, isCurrent }` pair.
   *  The UI never sees an owner subject or re-derives an identity from separate
   *  reads; `isCurrent` answers the exact-owner/generation question the whole
   *  surface already uses. */
  readonly captureHistoryScope: () => HistoryOpenScope
  /** Material terminal-width change (the command surface coalesces its refresh). */
  readonly onTerminalResize: OptionCapability<'onTerminalResize'>
  /** Fullscreen drag-selection copy (the runner owns the clipboard policy). */
  readonly copySelection: OptionCapability<'copySelection'>
  /**
   * Delivered files (PR1): the narrow read capability the transcript tail and
   * the browser consume. The composition root binds it to THIS surface's own
   * display-subject decision ({@link SurfaceRuntime.deliveredFilesSnapshot}),
   * so the mounted renderer can never re-derive "the current session" itself.
   */
  readonly deliveredFiles: DeliveredFilesCapability
  /** Headless-test seam (M3-4 PR3 image L6): the runner's live image draft
   * store, forwarded to TuiAppOptions.draftImageStoreForTest. Production
   * paths never read it. */
  readonly draftImageStoreForTest?: import('../../client/media/image/draft-store.ts').DraftImageStore
  /** The READ-ONLY composer preview projection (image UX PR1): the live
   *  draft store's staged values. The TUI never stages or reorders through
   *  it; absent means no preview band. */
  readonly draftImagePreviewSource?: import('../../client/media/image/types.ts').DraftImagePreviewSource
  /** Register the LIVE composer draft reader (expanded text) so the store can
   *  tell an active attachment from an undo-retention-only entry. */
  readonly draftImagePreviewLiveDraft?: (read: () => string) => void
  /** Reserve the submitted text's images for the SCOPED synchronous submit
   *  bridge (acquired before the draft clear, released after the synchronous
   *  dispatch). */
  readonly draftImagePreviewReserve?: (text: string) => (() => void) | undefined
  /** The Client-local undo-lease capability: the Store owns the bytes and the
   *  bounded retention budget, the host Editor owns the real Undo history. */
  readonly draftImagePreviewUndo?: import('../../client/media/image/draft-store.ts').DraftImageUndoLeasePort
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
  /** The persisted native-terminal-progress preference at startup (dual
   *  protocol by default), parsed through the shared terminal-progress parser. */
  readonly terminalProgress: string | undefined
  /**
   * Which adapter OWNS the main-Agent terminal outcome (R1 §5.3): the Direct
   * local durable events, or the Remote Host evidence stream. Decided once by
   * the composition root from the selected backend — the durable `session/event`
   * ingress feeds the transcript on both branches, but on the Remote branch it
   * must NEVER feed the local interval, because the Host evidence owns it
   * (STOP-DOUBLE).
   */
  readonly mainProgressAuthority: MainProgressAuthority
  /** The runner's diagnostics channel: the terminal-progress evidence fold
   *  reports an UNKNOWN upstream `turn/end.reason.kind` here instead of
   *  guessing an outcome. Optional for headless fixtures. */
  readonly diag?: Diag
  /**
   * The concrete Plugin Manager terminal panel factory (TS4 §8/§10): the
   * composition zone selects the TUI implementation and injects it here, so no
   * application owner imports a `tui/**` path.
   */
  readonly createPluginManagerPanel: PluginManagerPanelFactory
  /**
   * PR2 (experimental, absent on the production path): a READ-ONLY observer of
   * the active transcript projection the surface has ALREADY selected and
   * committed. It is not an event/fold/window owner and must not drive the
   * application: it only reads the frame the mounted app just received. The
   * production composition root does not inject it, so `dsh --profile pi-tui`
   * keeps its exact behaviour and no TSP code enters the product build graph.
   */
  readonly onTranscriptProjected?: (frame: TranscriptProjectionFrame) => void
  /**
   * The ONE read-only visual-event supply the transcript projection consults.
   *
   * The composition root implements it from the exact live Direct Session
   * (`agentNow()` / the mounted viewed child's Agent): it returns the complete
   * committed log plus the exact Session instance and its current `seq`, or
   * `undefined` when no trustworthy same-Session read exists (Remote, no
   * session, a stale subject). This surface neither creates a Host service nor
   * keeps a second publication index: every changed identity re-runs PR1's
   * `collectPublishedVisuals` over the official events.
   */
  readonly visualEventSnapshotFor?: (subject: {
    readonly subjectKind: 'main' | 'viewed-child'
    readonly subjectId: string | undefined
  }) => VisualEventSnapshot | undefined
}

/**
 * PR2: one captured ACTIVE projection target: the subject identity AND the
 * exact source instances, sampled together before the commit.
 */
interface ProjectionTarget {
  readonly folder: TranscriptFolder
  readonly controller: TranscriptWindowController
  readonly subjectKind: 'main' | 'viewed-child'
  readonly subjectId: string | undefined
}

/**
 * PR2: one already-SELECTED, already-windowed transcript projection, published
 * to the optional {@link SurfaceRuntimeOptions.onTranscriptProjected} observer
 * AFTER the mounted app received it.
 *
 * The frame is a READ-ONLY snapshot of existing authorities: the messages are
 * the exact array `setTranscript()` was called with, `subjectId`/`subjectKind`
 * come from the SAME active-target selection the repaint used, and
 * `sourceIdentity` is an opaque per-source token, for `===` comparison only.
 * It carries no generation of its own and is never a Host/Session identity.
 */
export interface TranscriptProjectionFrame {
  /** The presentation subject the projection was selected for. */
  readonly subjectKind: 'main' | 'viewed-child'
  /**
   * The active display subject id: the mounted viewed child, else the live
   * main session. Undefined while the surface has no session yet — the frame's
   * key scope is {@link sourceIdentity}, not this id.
   */
  readonly subjectId: string | undefined
  /**
   * The OPAQUE identity of the projection source: the SAME bare object for
   * every frame projected from one `TranscriptFolder`, a DIFFERENT one once
   * that fold is replaced (session commit, cold rehydrate, viewer switch).
   * Compare with `===` only. It is deliberately not the fold instance — the
   * read-only observer can reach no application method through it — and it is
   * not a Host generation.
   */
  readonly sourceIdentity: object
  /** The windowed messages, exactly as committed to the mounted app. */
  readonly messages: readonly TranscriptMessage[]
}

/** The surface owner the runner/bootstrap consumes. */
export interface SurfaceRuntime<Event extends RoutedSessionEvent> {
  /**
   * The mounted TuiApp (the PiTui renderer). Throws if read before
   * {@link SurfaceRuntime.start} — and on the TSP renderer branch, where no
   * TuiApp exists; application owners that are renderer-neutral read
   * {@link display} instead.
   */
  readonly app: TuiApp
  /**
   * PR3-B §3.1: the live composer projection. On the PiTui branch this is the
   * mounted `TuiApp` (structurally compatible); on a TSP renderer branch it
   * is the renderer's own composer port. Throws if read before
   * {@link SurfaceRuntime.start}.
   */
  readonly composer: SubmissionComposerPort
  /** Native /model presentation, absent until a supported renderer mounts. */
  readonly modelPresentation?: ModelPresentation | undefined
  /** Native /preset presentation, absent until a supported renderer mounts. */
  readonly presetPresentation?: PresetPresentation | undefined
  /** Internal read-only Session Browser seam; absent on PiTui and unsupported TSP panes. */
  readonly sessionBrowserPresentation?: SessionBrowserPresentation | undefined
  /**
   * PR3-A: the renderer-facing display seam (PiTui adapter or the TSP
   * renderer). Throws if read before {@link SurfaceRuntime.start}.
   */
  readonly display: SurfaceDisplaySeam
  /**
   * PR3-A: the ONE renderer-release promise. Resolves immediately on the
   * PiTui branch (the app disposal is synchronous); on the TSP branch it
   * settles only after the SDK restored the tty (its input drain included).
   * The exit/fatal/fiber orchestrations AWAIT it before writing the resume
   * hint, starting the next renderer or finishing the unload — a rejection is
   * the renderer's own cleanup failure and is recorded by those callers
   * (never swallowed here).
   */
  whenRendererReleased(): Promise<void>
  /** The unified status projection store (surface-owned instance). */
  readonly status: StatusStore
  /** The opening-session journal (surface-owned instance). */
  readonly openingJournal: OpeningJournal<Event>
  /**
   * The completion-owner fence (A2 seam): the notification controller fences by
   * the EXACT Direct `Agent.id` — a late `agent/status` from a retired agent
   * must never notify. `undefined` on the teardown path.
   *
   * This is the REBIND operation (session switch, resume, fork adoption, first
   * session): the interval evidence is reset and the terminal root is retired
   * to `idle`, because a newly committed owner must prove its own result and
   * never inherit the previous owner's retained `done`/`error`.
   */
  setCompletionOwner(identity: string | undefined): void
  /**
   * The FINAL-TEARDOWN operation: withdraw the completion-notification owner
   * (a late `agent/status` must never notify into a dying surface) WITHOUT
   * discarding the proven terminal outcome. A still-live interval retires to
   * `idle`; an already-settled `done`/`error` is kept so the mounted app's own
   * disposal can retain it across process exit (plan §4.4). Distinct from
   * {@link setCompletionOwner}, which is a rebind and always clears.
   */
  retireCompletionOwner(): void
  /** The ONLY completion-controller status feed (the `agent/status` handler). */
  onAgentStatus(agentId: string, status: AgentLifecycleStatus): void
  /**
   * The ONE Remote Host terminal-progress feed (plan R2 §7.2/§7.3). On the
   * Remote branch the Host evidence stream owns the main outcome, so this is
   * the only entry that writes the interval there — with the SAME single
   * `(active, outcome)` commit the Direct path uses, never a second writer.
   *
   * `fact.kind` is the wire frame kind: `snapshot` is the opening authoritative
   * read (display truth only — it NEVER feeds the completion controller, so a
   * reconnect can neither notify nor revive a historical result), while
   * `update` is a real Host edge and feeds the controller exactly like a Direct
   * `agent/status` transition. `fact.restart` (a new interval lineage: Host
   * remount / Agent replacement / no provable continuity) re-baselines the
   * controller instead of feeding it, so an earlier running edge can never pair
   * with this frame's idle into a false completion. `identity` is the committed
   * main-session identity the controller must recognize.
   */
  applyRemoteMainProgress(
    fact: {
      readonly kind: 'snapshot' | 'update'
      readonly restart: boolean
      readonly running: boolean
      readonly outcome: TerminalProgressOutcome
    },
    identity: string,
  ): void
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
  /**
   * Delivered files (Delivered files PR1 / M2): derive the CURRENT display
   * subject's delivered Turns from its selected Folder's FULL grouped
   * projection.
   *
   * This is the business owner of "which session, which Fold" — the caller
   * never guesses a current session id or re-projects a bounded display
   * window. The derivation runs on demand (one explicit open of the browsing
   * surface), never per repaint. Returns `undefined` when no display subject is
   * selected, the surface is torn down, or the projection carries no delivery.
   */
  deliveredFilesSnapshot(): DeliveredFilesSnapshot | undefined
  /**
   * Whether a snapshot captured earlier still describes the CURRENT display
   * subject: the same subject kind/id AND the same projection source
   * (`sourceIdentity`), so a replaced Folder under the same session id is
   * stale. Never compares session ids alone.
   */
  isDeliveredFilesSnapshotCurrent(snapshot: DeliveredFilesSnapshot): boolean
  /** The notification settings write path (`/notify`, `agent/status` policy). */
  setNotificationMode(mode: string): void
  setNotificationMethod(method: string): void
  /** The mode the ONE completion controller currently applies (read-only). */
  currentNotificationMode(): NotificationMode
  /** The delivery method the ONE completion controller currently applies. */
  currentNotificationMethod(): NotificationMethod
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
  /** Open the Full Task Browser (`/tasks` and the scoped views). The
   *  `quick` modal is retired (Phase 3B/B4-B): the on-demand Task Quick
   *  accessory replaced it and `openQuickTaskItem` routes its selections. */
  openTasksBrowser(
    viewMode: 'full',
    scope?: TaskBrowserDatasetScope,
    header?: string,
  ): void
  /** Open one Job from the Task Browser (a subagent job may replace it). */
  openJobView(jobId: string): 'close' | 'keep-open'
  /** Register the approval/question presentation providers (A4-7, §13.3/§16). */
  attachInteraction(port: InteractionPort, deps: SurfaceInteractionDeps): void
  /**
   * PR3-B B3 (findings C/F6): a newly committed Session takes the surface, so
   * re-derive the WHOLE interaction presentation against it BEFORE the new
   * subject's first frame. A replaced subject's live foreground form (and a live
   * approval prompt) is withdrawn from the modal seat — PRESENTATION only: the
   * official request keeps its own lifetime and the Host's own cancellation still
   * settles it — and its continued entries leave the model, so no form, count,
   * prompt or input seat of the replaced subject can leak into the replacement.
   * Called from the runner's published `initLiveSession` seam; a no-op before the
   * interaction owner is attached.
   */
  reconcileInteractionPresentation(): void
  /**
   * PR3-B B3 (external review P2-B): the SYNCHRONOUS publication-commit half of
   * the same currentness policy. The runner calls it from the commit section,
   * immediately after the new owner is published and BEFORE any post-commit
   * await, so a replaced subject's modal can never keep the seat (or accept keys
   * through the modal-first input routing) while the new owner's initialization
   * is still pending. State-only and non-throwing: it performs no Host read, and
   * a renderer frame failure routes to that renderer's fatal sink.
   */
  withdrawReplacedPresentation(): void
  /**
   * Phase 3B / B3-B: retire a mounted History editor-seat tenant whose captured
   * Session scope is no longer current. It is the runner's publication-commit
   * half of the History currentness policy, called from the three `publishOwner`
   * seams (ordinary transition, fork adoption, first-session creation) right
   * after the new owner is published, and from the ownership core's single
   * generation-reset hook (a same-owner generation bump). It is STRICTLY
   * non-throwing: the commit section must never fail because UI cleanup did. It
   * performs no Host read and is a no-op when no PiTui app is mounted (TSP
   * renderer, pre-mount, disposed).
   */
  retireStaleHistorySeat(): void
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
  applyResumedCompaction(id: string | undefined, active: boolean, phase?: CompactionPhase): void
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
   * PR3-B §3.3: bind the renderer's input projection ONCE. Called by the
   * composition root AFTER it has settled the renderer capability and the
   * command catalog, so no held pre-bind key can act on stale facts, and so a
   * key cannot submit before the application handlers are ready. A no-op on the
   * PiTui branch (its events table is wired by the mount itself).
   */
  bindRendererInput(): void
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
  /**
   * PR-C: the ONE image loader of this mount, retained only for the PiTui
   * teardown hook (Image-6A owner decision). It is the SAME loader object the
   * mount injected; this is a lifecycle reference, never a second loader or
   * state authority. The TSP branch keeps its existing loader/renderer release
   * semantics and is not cleared here.
   */
  let mountedImageLoader: ImageLoader | undefined
  /** PR-D: the PiTui branch's Client-local SVG raster cache (created in `start()`). */
  let svgRasterLoader: SvgRasterLoader | undefined
  /**
   * PR3-A: the renderer-facing display seam. On the PiTui path this is the
   * pitui adapter over the mounted app (assigned in `start()`); a non-PiTui
   * renderer mount injects its own seam implementation instead of a TuiApp.
   * Application owners commit display facts through the seam; `app` stays the
   * PiTui-only surface.
   */
  let display: SurfaceDisplaySeam | undefined
  /**
   * B3-A1: the mounted renderer's Task Center presentation sink. Late-bound
   * exactly like {@link display}: the Task Runtime is constructed before the
   * renderer mounts and reads this through a closure. A read before the mount
   * is an internal wiring failure — there is no no-op fallback port.
   */
  let taskPresentation: TaskCenterPresentationPort | undefined
  /**
   * PR3-B §3.1: the live composer projection. PiTui assigns the mounted app
   * (structurally a `SubmissionComposerPort`); a renderer mount injects its
   * own composer port instead of a TuiApp.
   */
  let composerPort: SubmissionComposerPort | undefined
  let modelPresentation: ModelPresentation | undefined
  let presetPresentation: PresetPresentation | undefined
  let sessionBrowserPresentation: SessionBrowserPresentation | undefined
  /**
   * PR3-B §3.3: the renderer input projection constructed at `start()` and the
   * mount that will receive it. `bindRendererInput()` performs the ONE bind
   * once the application input facts are ready.
   */
  let pendingInputBinding: SurfaceInputBinding | undefined
  let inputBindTarget: { bindInput(handlers: SurfaceInputBinding): void } | undefined
  /**
   * PR3-B §3.2: the live modal presenter projection. PiTui assigns the
   * mounted app (structurally a `SurfaceInteractionPresenter`); a renderer
   * mount injects its own presenter.
   */
  let interactionPresenter: SurfaceInteractionPresenter | undefined
  /**
   * PR3-A: the non-PiTui renderer's disposer (assigned by `start()` on the
   * renderer branch; released once in `dispose()`).
   */
  let rendererDispose: (() => Promise<void>) | undefined
  /**
   * PR3-A: the ONE renderer-release promise (settles with the tty restored).
   * Awaitable through {@link SurfaceRuntime.whenRendererReleased}.
   */
  let rendererRelease: Promise<void> = Promise.resolve()
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
   * PR3-B §3.2: the live modal presenter projection (renderer-neutral read;
   * see {@link interactionPresenter}).
   */
  const presenterSeam = (): SurfaceInteractionPresenter => {
    if (interactionPresenter === undefined) throw new Error('the surface is not mounted')
    return interactionPresenter
  }

  /**
   * PR3-A: the live display seam. Sub-owners that only commit display facts
   * read this; PiTui-only owners keep {@link mounted}.
   */
  const displaySeam = (): SurfaceDisplaySeam => {
    if (display === undefined) throw new Error('the surface is not mounted')
    return display
  }

  /**
   * PR3-B §3.1: the live composer projection. PiTui-only before the renderer
   * branches exist, but the read is renderer-neutral by contract: a TSP
   * renderer's composer is the same port shape.
   */
  const composerSeam = (): SubmissionComposerPort => {
    if (composerPort === undefined) throw new Error('the surface is not mounted')
    return composerPort
  }

  /**
   * The main-Agent presentation evidence fold (plan §4.3, R1 §5.3): the ONE
   * shared interval semantics (`domain/terminal-progress/interval.ts`) is
   * instantiated HERE as the DIRECT local-evidence instance. The Remote Host
   * plugin instantiates the same fold for its own authority — one classifier,
   * two instances, never two evolved copies.
   *
   * Presentation state only — never a second Agent lifecycle authority. The
   * interval scope uses exclusively the already-existing running latch and the
   * main identity stays the routing's `completionOwnerId` fence; the turn
   * evidence exists so the ONE settle commit can carry a PROVEN `done`/`error`
   * instead of guessing it from an idle status.
   */
  const interval = createTerminalProgressInterval(
    kind => options.diag?.warn('terminal progress: unknown turn/end reason', { kind }),
  )

  /**
   * The single commit: the fold ALREADY latched the logical evidence inside the
   * command that returned `progress`, so a synchronous re-entrant read from the
   * app write below sees the post-command state, never the pre-command one.
   * `undefined` = that command changed nothing (a repeated status, an already
   * idle interval), so no physical commit is attempted at all.
   */
  const commitMainAgentProgress = (progress: IntervalProgress | undefined): void => {
    if (progress === undefined) return
    app?.setTerminalProgress(progress.active, progress.outcome)
  }

  /**
   * The `agent/status` transition (plan §4.3): the fold owns the semantics — a
   * rising edge opens a fresh idle interval, a falling edge settles from the
   * matched turn/end evidence (an unmatched open turn has NO completion
   * evidence and settles `idle`), and a repeated status is inert (an idle
   * notification must never re-settle).
   */
  const setMainAgentProgress = (active: boolean): void => {
    commitMainAgentProgress(interval.status(active))
  }

  /**
   * Retire the running truth WITHOUT fabricating a settlement (owner rebind,
   * teardown): the PROVEN outcome is preserved, so a final disposal can keep a
   * retainable `done`/`error` record while a live `working` interval still
   * retires to `idle`.
   */
  const retireMainAgentProgress = (): void => {
    commitMainAgentProgress(interval.retire())
  }

  /**
   * Record one LIVE main-session `turn/start` (plan §4.3, §5.2): only inside the
   * current running interval, and it immediately invalidates any older closed
   * candidate. Events outside the interval (replay/hydration before the
   * running status) are ignored.
   */
  const observeMainTurnStart = (turn: number): void => {
    interval.turnStart(turn)
  }

  /**
   * Record one LIVE main-session `turn/end` (plan §4.3, §5.2): only inside the
   * current running interval and only when it closes the turn this interval
   * actually opened. An UNKNOWN reason kind is reported (through the fold's
   * injected reporter) and settles `idle` rather than being guessed.
   */
  const observeMainTurnEnd = (turn: number, reasonKind: string): void => {
    interval.turnEnd(turn, reasonKind)
  }

  // The Task Center / Job viewer owner (TS3 §34) holds the ONE
  // `TaskBrowserRuntime`, the browser/viewer state and the catalog refresh gate.
  // Question attention crosses as an injected read/subscription only (the
  // controller stays with its own owner below).
  const task = createTaskRuntime({
    mounted: () => mounted(),
    display: () => displaySeam(),
    // B3-A1: the Task Center presentation sink is read LATE because this owner
    // is constructed before the renderer mount transfers the terminal. The
    // normal product always presents through a mounted sink; a read before
    // the mount is a wiring failure, not a silent no-op.
    presentation: () => {
      if (taskPresentation === undefined) throw new Error('task presentation not mounted')
      return taskPresentation
    },
    isCleanedUp: () => isCleanedUp(),
    attention: {
      rows: () => interaction.attentionRows(),
      reconcile: () => interaction.controller()?.reconcile(),
      publish: () => interaction.publishAttention(),
      reopen: (sessionId, callId) => interaction.controller()?.reopen(sessionId, callId) ?? false,
    },
  })

  /**
   * Whether the STARTED surface owns a renderer mount (the TSP branch) rather
   * than the default process TuiApp (F13). Set by `start()` BEFORE the
   * interaction owner is attached; the new admission/presentation currentness
   * policy is authorized for that branch only.
   */
  let rendererOwnedPresentation = false

  // The approval/question presentation owner (TS3 §35) holds the ONE
  // `QuestionSurfaceController` plus its attention subscription. The attention
  // publication stays a PRESENTATION-only refresh: the count goes to the
  // renderer's own presenter (the PiTui app chrome or the TSP dock line) and
  // the Task Center (commit 7 moves the latter into its own owner).
  // PR3-B §3.2: the modal presentation arrives through the narrow presenter
  // projection — the PiTui adapter over the mounted app, or a renderer's own
  // presenter. No owner reads a PiTui-only chrome member on the TSP branch.
  const interaction = createInteractionRuntime({
    presenter: () => presenterSeam(),
    livePresenter: () => interactionPresenter,
    display: () => displaySeam(),
    currentSessionId: () => routingSource?.currentSessionId(),
    // ADMISSION/PRESENTATION currentness (B3 findings F10/F12/F13): the surface's
    // OWN authority — the Session it shows, plus a Session it is currently
    // OPENING (a tentative opening is not an owner replacement, so its request is
    // still admitted and keeps its flow). A renderer-OWNED presentation (the TSP
    // modal seat) is the only branch this policy was authorized for: the PiTui
    // branch — the default and the SDK-declined fallback — answers `true`
    // unconditionally and keeps its original delegation semantics.
    isAdmissibleSession: sessionId => rendererOwnedPresentation
      ? sessionId === routingSource?.currentSessionId() || openingJournal.isOpening(sessionId)
      : true,
    schedulePaint: () => schedulePaint(),
    diag: () => task.diag(),
    isCleanedUp: () => isCleanedUp(),
    onAttentionChanged: () => task.refreshAttentionRows(),
  })

  // The application-level presentation event router (TS3 §36) owns the routing
  // decisions/fences and the routing-local compaction fold id; every target and
  // cross-owner effect arrives as an injected callback.
  const eventRouting = createEventRouting<Event>({
    source: () => routing(),
    mounted: () => displaySeam(),
    openingJournal,
    // The ordinary event-driven reconcile runs the WHOLE presentation pass, so a
    // presentation that stopped being admissible is retired by the same rule that
    // admitted it (F12) — never only at the next publication.
    reconcileQuestions: () => interaction.reconcilePresentation(),
    refreshAgents: () => task.refreshAgents(),
    refreshAgentRuntimeOnly: () => task.refreshAgentRuntimeOnly(),
    hasTaskChild: (childId) => task.hasTask(childId),
    feedCompletionStatus: (agentId, status) => notification.onAgentStatus(agentId, status),
    setMainAgentProgress: (active) => setMainAgentProgress(active),
    observeMainTurnStart: (turn) => observeMainTurnStart(turn),
    observeMainTurnEnd: (turn, reasonKind) => observeMainTurnEnd(turn, reasonKind),
    mainProgressAuthority: options.mainProgressAuthority,
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

  /**
   * PR2: the optional read-only projection observer. Absent on the production
   * path; released by {@link dispose} before the mounted app dies.
   */
  let projectionObserver = options.onTranscriptProjected
  /**
   * PR2: the opaque per-source identity tokens handed to the observer. One bare
   * object per projection source: the SAME fold always maps to the SAME token
   * (so the observer can re-scope its keys by `===`), and the weak map lets a
   * replaced fold's token be collected. This deliberately does NOT give the
   * read-only observer the mutable fold instance.
   */
  const projectionTokens = new WeakMap<object, object>()
  const projectionTokenFor = (source: object): object => {
    let token = projectionTokens.get(source)
    if (token === undefined) {
      token = {}
      projectionTokens.set(source, token)
    }
    return token
  }

  /**
   * PR2: capture the ACTIVE projection target — the selected subject AND the
   * exact source instances — at ONE synchronous instant, so a frame can never
   * mix one subject's messages with another subject's identity.
   */
  const captureProjectionTarget = (
    folder: TranscriptFolder,
    controller: TranscriptWindowController,
  ): ProjectionTarget => {
    const viewedChildId = routing().viewedChildId()
    return {
      folder,
      controller,
      subjectKind: viewedChildId === undefined ? 'main' : 'viewed-child',
      subjectId: viewedChildId ?? routing().currentSessionId(),
    }
  }

  /** Whether two captured projection targets are the SAME live selection in
   * all four identity parts (source instances + subject identity). */
  const sameProjectionTarget = (left: ProjectionTarget, right: ProjectionTarget): boolean =>
    left.folder === right.folder
    && left.controller === right.controller
    && left.subjectKind === right.subjectKind
    && left.subjectId === right.subjectId

  /**
   * PR2: publish ONE already-computed projection to the optional read-only
   * observer. It never re-windows, re-folds or re-reads the log: it hands over
   * the SAME messages the mounted app just received. The CAPTURED target must
   * still be the live one in ALL FOUR parts — the source instances AND the
   * subject identity: `setTranscript()` can synchronously run plugin/modal
   * callbacks that hand the session over to another owner while the previous
   * subject's fold/window are still mounted, and those messages must never be
   * relabelled with the new subject's id. The frame carries the CAPTURED
   * identity, never a re-read one; a torn-down surface publishes nothing.
   */
  const publishProjected = (target: ProjectionTarget, messages: readonly TranscriptMessage[]): void => {
    if (projectionObserver === undefined || isCleanedUp()) return
    const current = captureProjectionTarget(activeFolder(), activeWindow())
    if (current.folder !== target.folder || current.controller !== target.controller
      || current.subjectKind !== target.subjectKind || current.subjectId !== target.subjectId) return
    projectionObserver({
      subjectKind: target.subjectKind,
      subjectId: target.subjectId,
      sourceIdentity: projectionTokenFor(target.folder),
      messages,
    })
  }

  /**
   * Delivered files (Delivered files PR1 / M2): the ONE read-only derivation
   * of the selected display subject's delivered Turns.
   *
   * It reuses the SAME active-target decision the repaint uses (the selected
   * Folder + subject identity), so it can never disagree with the transcript
   * on screen. `folder.messages()` is deliberately called WITHOUT a
   * `maxTurns`: the bounded display window is NOT the history, and a delivery
   * from an older Turn stays reachable. The call is on-demand only (an explicit
   * open of the browsing surface), never from a repaint or scroll path.
   */
  const deliveredFilesSnapshot = (): DeliveredFilesSnapshot | undefined => {
    if (disposed || isCleanedUp() || routingSource === undefined) return undefined
    const viewedChildId = routing().viewedChildId()
    const sessionId = viewedChildId ?? routing().currentSessionId()
    // No selected display subject: an empty overlay would lie about "this
    // session" and a parent fallback would show another subject's files.
    if (sessionId === undefined) return undefined
    const folder = viewedChildId === undefined ? routing().mainFolder() : routing().viewedChildFolder()
    const turns = deliveredTurnsOf(folder.messages())
    if (turns.length === 0) return undefined
    return {
      subjectKind: viewedChildId === undefined ? 'main' : 'viewed-child',
      sessionId,
      sourceIdentity: projectionTokenFor(folder),
      turns,
    }
  }

  /**
   * Delivered files currentness: the captured snapshot must still describe the
   * CURRENT display subject. The opaque projection token is part of the
   * comparison, so a Folder replaced under the same session id (cold rehydrate,
   * session commit, viewer switch) makes an older snapshot stale instead of
   * silently re-labelling its Turns.
   */
  const isDeliveredFilesSnapshotCurrent = (snapshot: DeliveredFilesSnapshot): boolean => {
    if (disposed || isCleanedUp() || routingSource === undefined) return false
    const current = captureProjectionTarget(activeFolder(), activeWindow())
    return current.subjectKind === snapshot.subjectKind
      && current.subjectId === snapshot.sessionId
      && projectionTokenFor(current.folder) === snapshot.sourceIdentity
  }

  /**
   * The ONE derived-publication memo: a performance cache only. The authority
   * is always the complete official log re-read through
   * {@link collectPublishedVisuals}; the memo invalidates on the exact Session
   * instance or its committed `seq`, so a resume, a cold rehydrate or a
   * viewer switch can never reuse a previous subject's facts.
   */
  /** One immutable publication index per exact Session revision. `byTurn` is
   * the display-only turn lookup so one repaint never scans the whole history
   * of published visuals or the whole historical activity map. */
  interface VisualPublicationIndex {
    readonly publications: readonly PublishedVisual[]
    readonly byTurn: ReadonlyMap<number, readonly PublishedVisual[]>
  }
  let visualSnapshotMemo: {
    readonly session: object
    readonly sessionId: string
    readonly seq: number
    readonly index: VisualPublicationIndex
  } | undefined
  /** One-shot guard for the post-commit successor repaint. A re-entrant
   * setTranscript handover is not allowed to recurse without bound; the next
   * application repaint owns any further switch. */
  let visualSuccessorRepaint = false
  const publicationsOf = (snapshot: VisualEventSnapshot): VisualPublicationIndex => {
    const memo = visualSnapshotMemo
    if (memo !== undefined
      && memo.session === snapshot.session
      && memo.sessionId === snapshot.sessionId
      && memo.seq === snapshot.seq) return memo.index
    const publications = collectPublishedVisuals(snapshot.sessionId, snapshot.events)
    const byTurn = new Map<number, PublishedVisual[]>()
    for (const publication of publications) {
      const existing = byTurn.get(publication.turn)
      if (existing === undefined) byTurn.set(publication.turn, [publication])
      else existing.push(publication)
    }
    const index: VisualPublicationIndex = { publications, byTurn }
    visualSnapshotMemo = {
      session: snapshot.session,
      sessionId: snapshot.sessionId,
      seq: snapshot.seq,
      index,
    }
    return index
  }

  /**
   * PR2: attach the proven visual projection to the EXACT eligible final
   * Assistant objects of the window being committed. The derivation uses the
   * captured target's exact subject and source token. Rows that are not the
   * qualified final have their old sidecar cleared explicitly. The selected
   * rows are returned so the caller can discard them if the synchronous
   * `setTranscript` handover changed the live target.
   */
  const applyVisualPresentations = (
    target: ProjectionTarget,
    messages: readonly TranscriptMessage[],
    activities: ReadonlyMap<number, TurnActivity>,
  ): readonly Extract<TranscriptMessage, { kind: 'assistant' }>[] => {
    const assistantRows = messages.filter(
      (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
    )
    const supply = options.visualEventSnapshotFor
    if (supply === undefined) {
      for (const message of assistantRows) clearAssistantVisualPresentation(message)
      return []
    }
    const snapshot = supply({ subjectKind: target.subjectKind, subjectId: target.subjectId })
    if (snapshot === undefined
      || (target.subjectId !== undefined && snapshot.sessionId !== target.subjectId)) {
      for (const message of assistantRows) clearAssistantVisualPresentation(message)
      return []
    }
    const publicationIndex = publicationsOf(snapshot)
    const sourceIdentity = projectionTokenFor(target.folder)
    // Only the CURRENT WINDOW's turns participate. The folder activity map is
    // the whole Session history; iterating it (or filtering the window once
    // per historical turn) made repaint cost grow with session age.
    const groupsByTurn = new Map<number, TranscriptMessage[]>()
    for (const message of messages) {
      if (!('turn' in message)) continue
      const group = groupsByTurn.get(message.turn)
      if (group === undefined) groupsByTurn.set(message.turn, [message])
      else group.push(message)
    }
    const selected = new Set<Extract<TranscriptMessage, { kind: 'assistant' }>>()
    for (const [turn, group] of groupsByTurn) {
      const activity = activities.get(turn)
      if (activity === undefined) continue
      const final = eligibleFinalAssistant(activity, group)
      if (final === undefined) continue
      const turnPublications = publicationIndex.byTurn.get(turn) ?? []
      if (turnPublications.length === 0) continue
      const message = final.message
      const key: VisualPresentationKey = {
        subjectKind: target.subjectKind,
        subjectId: target.subjectId,
        sourceIdentity,
        session: snapshot.session,
        sessionId: snapshot.sessionId,
        seq: snapshot.seq,
        turn: message.turn,
        step: assistantStepOf(message),
        text: message.text,
        content: message.content,
        assistantRevision: assistantPresentationRevision(message),
      }
      setAssistantVisualPresentation(message, key, turnPublications)
      selected.add(message)
    }
    for (const message of assistantRows) {
      if (!selected.has(message)) clearAssistantVisualPresentation(message)
    }
    return [...selected]
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
    // Capture the subject identity and its source at ONE instant BEFORE the
    // commit; both the visual sidecars and the read-only observer are scoped to
    // this exact selection.
    const needsTarget = projectionObserver !== undefined || options.visualEventSnapshotFor !== undefined
    const target = needsTarget ? captureProjectionTarget(folder, controller) : undefined
    const activities = folder.turnActivities()
    const visualRows = target === undefined
      ? []
      : applyVisualPresentations(target, projection.messages, activities)
    displaySeam().setTranscript(projection.messages, activities, {
      ...controller.state(),
      firstTurn: projection.firstTurn,
      lastTurn: projection.lastTurn,
      hasNewer: projection.hasNewer,
    }, streamingToolPreviews, (searchPresentation ?? searchBindingForRepaint)?.(), projectionTokenFor(folder))
    if (target === undefined) return
    // setTranscript can SYNCHRONOUSLY run plugin/modal callbacks that hand the
    // session to another owner. The pre-commit derivation is then stale: clear
    // the exact rows it selected and commit the successor target NOW, so the
    // old visual cannot remain painted until some later frame.
    if (!isCleanedUp()) {
      const current = captureProjectionTarget(activeFolder(), activeWindow())
      if (!sameProjectionTarget(target, current)) {
        for (const message of visualRows) clearAssistantVisualPresentation(message)
        if (visualRows.length > 0 && !visualSuccessorRepaint) {
          visualSuccessorRepaint = true
          try {
            repaintActive(searchPresentation, onProjected)
          } finally {
            visualSuccessorRepaint = false
          }
          return
        }
      }
    } else {
      for (const message of visualRows) clearAssistantVisualPresentation(message)
    }
    publishProjected(target, projection.messages)
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
    }
    // PR3-A: the presentation commit is renderer-neutral (the seam). The
    // viewport scroll stays gated on NEW OWN INPUT exactly as before (a
    // background `context` occurrence or another client's steering must
    // never yank a reader out of history) and is PiTui-only chrome (the TSP
    // pane owns its scrolling).
    displaySeam().setPendingInputPresentation({ queued, tail, running })
    if (hasNewOwnInput) app?.scrollToBottom()
  }
  /** Clear the pending-input presentation + own-input memory (generation bump). */
  const resetPendingPresentation = (): void => {
    pendingOwnInputBySubject.clear()
    displaySeam().setPendingInputPresentation({ queued: [], tail: [], running: false })
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
    // A PASSIVE commit (a settlement, a read-group split) can replace the card a
    // stored match was resolved against: the old representative then no longer
    // contains the query, and binding it would highlight the wrong card until
    // the next explicit navigation. Re-run the same lightweight query and
    // re-derive the representative set BEFORE binding, so the highlight/target
    // always follows the occurrence (the refresh is inert when the revision did
    // not move).
    refreshSearchMatchesIfStale()
    refreshSearchMatchMessages()
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
    displaySeam().setSearchResult(searchCurrent + 1, searchMatches.length)
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
      displaySeam().setSearchResult(0, 0)
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
      displaySeam().setSearchResult(searchCurrent + 1, searchMatches.length)
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
    displaySeam().setSearchResult(searchCurrent + 1, searchMatches.length)
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

  const buildOptions = (deps: SurfaceMountDeps, imageLoader: ImageLoader, svgRasterLoader: SvgRasterLoader | undefined): TuiAppOptions => ({
    // Ctrl+R input-history search: the runner owns the IO (the file-backed
    // source + the known-cwd identity map), the surface owns the panel
    // lifecycle (plan §27 — TuiApp never touches the filesystem).
    historySearchSource: deps.historySearchSource,
    historySearchCwd: () => deps.sessionCwd(),
    // The Session currentness bridge (Phase 3B / B3-B): the application
    // composition captured ONE scope authority pair for this open; the TUI
    // stores the pair and never re-derives a session identity.
    captureHistoryScope: deps.captureHistoryScope,
    // The transcript image surface (plan M8/M9): the durable loader plus the
    // dim fallback coloring. PR-C: the loader is the ONE instance of THIS
    // mount (constructed in `start()`), so the PiTui branch and the renderer
    // branch share one cache and one read authority.
    imageLoader,
    ...(svgRasterLoader === undefined ? {} : { svgRasterLoader }),
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
    deliveredFiles: deps.deliveredFiles,
    draftImageStoreForTest: deps.draftImageStoreForTest,
    draftImagePreviewSource: deps.draftImagePreviewSource,
    draftImagePreviewLiveDraft: deps.draftImagePreviewLiveDraft,
    draftImagePreviewReserve: deps.draftImagePreviewReserve,
    draftImagePreviewUndo: deps.draftImagePreviewUndo,
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
    // B4-B: the on-demand Task Quick's typed selection route. The app calls
    // this AFTER the accessory has left Quick; the SAME TaskRuntime owner
    // resolves the row against its CURRENT global authority (the ONE open/
    // reopen path the Full browser uses — never a second registry).
    onQuickTaskSelect: value => task.openQuickTaskItem(value),
    // Post-B4-B: Quick's distinct navigation action opens the same Full Task
    // Center owner as `/tasks`, without manufacturing a TaskPanelItem value.
    onQuickTaskOpenFull: () => task.openTasksBrowser('full'),
  })

  return {
    get app(): TuiApp {
      if (app === undefined) throw new Error('the surface is not mounted')
      return app
    },
    get composer(): SubmissionComposerPort {
      return composerSeam()
    },
    get modelPresentation() { return modelPresentation },
    get presetPresentation() { return presetPresentation },
    get sessionBrowserPresentation() { return sessionBrowserPresentation },
    get display(): SurfaceDisplaySeam {
      return displaySeam()
    },
    whenRendererReleased: () => rendererRelease,
    status,
    openingJournal,
    setCompletionOwner(identity) {
      // Every completion-owner commit/reset retires the previous owner's pane
      // presentation BEFORE the controller resets (plan §4.3): the interval
      // evidence is reset, then a newly committed owner must prove `running`
      // through its own authoritative `agent/status` and never inherit the old
      // owner's `working` OR its retained `done`/`error`. The order is fixed:
      // evidence reset, controller owner, ONE atomic physical retire.
      const reset = interval.reset()
      notification.setCompletionOwner(identity)
      commitMainAgentProgress(reset)
    },
    onAgentStatus(agentId, status) {
      notification.onAgentStatus(agentId, status)
    },
    applyRemoteMainProgress(fact, identity) {
      // The Remote Host already classified this fact with the shared fold: the
      // interval ADOPTS it (no local turn evidence is fabricated) and publishes
      // it through the one commit. The progress commit lands BEFORE the
      // completion feed, so a settled transition clears the busy state before
      // the controller may emit its toast (the same order as Direct).
      commitMainAgentProgress(interval.apply({ active: fact.running, outcome: fact.outcome }))
      if (fact.restart) {
        // A new lineage re-baselines the controller (the same rebind the Direct
        // owner commit performs), so its `seenRunning` cannot survive from an
        // interval this frame does not continue.
        notification.setCompletionOwner(identity)
        // The restart frame is NOT completion evidence when it is an opening
        // snapshot (plan §7.3); a real Host `update` IS the first edge of the new
        // lineage and feeds the controller after the reset.
        if (fact.kind === 'update') notification.onAgentStatus(identity, fact.running ? 'running' : 'idle')
        return
      }
      if (fact.kind === 'update') notification.onAgentStatus(identity, fact.running ? 'running' : 'idle')
    },
    retireCompletionOwner() {
      // Final surface teardown (plan §4.4): the notification owner is withdrawn
      // FIRST so a late status can never notify a dying surface, but the
      // proven terminal outcome SURVIVES — a live interval retires to `idle`
      // (a running Agent must not leave a working record), while a settled
      // `done`/`error` is kept for the mounted app's disposal to retain across
      // process exit. Only the interval EVIDENCE (open turn / candidate) is
      // discarded by the fold's `retire()`, because no further turn can settle.
      notification.setCompletionOwner(undefined)
      retireMainAgentProgress()
    },
    // Delivered files (PR1 / M2): the on-demand catalog of the CURRENT display
    // subject and the identity fence an already-open panel re-checks.
    deliveredFilesSnapshot,
    isDeliveredFilesSnapshotCurrent,
    commitStatus(patch, legacyFacts, presentation) {
      // A4-4 (plan §13.1): the semantic derivation stays with the runner; the
      // commit coordination is surface-owned. The three parts are ONE atomic
      // display-subject commit (M3-5 PR1 §9.7).
      //
      // OWNERSHIP (R2-2): the PiTui branch's ONE atomic commit lives INSIDE
      // `TuiApp.commitDisplaySubject` (store patch + activity section + legacy
      // projection published together). Committing the patch here as well
      // would SPLIT that transaction into two publications (an observer would
      // see the child view beside the parent activity/presentation). So the
      // surface only supplies the store commit for a renderer that has no such
      // chrome projection — the TSP mount — keeping exactly ONE store update
      // per commit on BOTH branches.
      if (app === undefined) status.update(patch)
      displaySeam().commitDisplaySubject(patch, legacyFacts, presentation)
    },
    setNotificationMode(mode) {
      notification.setMode(mode)
    },
    setNotificationMethod(method) {
      notification.setMethod(method)
    },
    currentNotificationMode() {
      return notification.currentMode()
    },
    currentNotificationMethod() {
      return notification.currentMethod()
    },
    setTerminalProgressMode(mode) {
      app?.setTerminalProgressMode(parseTerminalProgressMode(mode))
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
    openTasksBrowser(viewMode, scope, header) {
      task.openTasksBrowser(viewMode, scope, header)
    },
    openJobView(jobId) {
      return task.openJobView(jobId)
    },
    attachInteraction(port, deps) {
      interaction.attach(port, deps)
    },
    reconcileInteractionPresentation() {
      interaction.reconcilePublishedPresentation()
    },
    withdrawReplacedPresentation() {
      interaction.withdrawReplacedPresentation()
    },
    retireStaleHistorySeat() {
      // The PiTui-only mounted app owns the optional seat; a TSP renderer mount
      // (no `app`) and a pre-mount/disposed surface are strict no-ops. The app's
      // own entry is state-only and non-throwing.
      if (app !== undefined) app.retireStaleHistorySeat()
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
    applyResumedCompaction: (id, active, phase) => eventRouting.applyResumedCompaction(id, active, phase),
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
      if (app !== undefined || display !== undefined) throw new Error('the surface is already mounted')
      // F13: only a renderer-OWNED presentation (the TSP mount) enables the new
      // admission/presentation currentness policy; the default PiTui branch keeps
      // its original delegation semantics. This is read by the interaction owner,
      // which is attached AFTER this call.
      rendererOwnedPresentation = deps.renderer !== undefined
      // PR-C: the ONE image loader of this mount. It is created HERE (the
      // single acquire point) and handed to the renderer branch as the mount
      // binding, so there is never a second loader, a second cache or a
      // second read authority in the application process.
      const imageLoader = new ImageLoader((ref, context) => deps.readImage(ref, context))
      mountedImageLoader = imageLoader
      // PR-D: the Client-local SVG raster cache of THIS mount. It is created
      // at the same single acquire point; TSP has its own native-SVG blob
      // path and never uses this PiTui-only derivative.
      const rasterLoader = isolatedSvgRasterSupported() ? new SvgRasterLoader(rasterizeSvg) : undefined
      svgRasterLoader = rasterLoader
      // PR3-A: the composition root already connected a non-PiTui renderer
      // (the experimental TSP mount). Mount it at the SAME position; no
      // TuiApp exists on this branch, so every PiTui-only owner below simply
      // never receives a mounted app (their entries are input-gated).
      if (deps.renderer !== undefined) {
        // PR4: the dock's draft projection. It reads the LIVE composer text and
        // the ONE preview source on every call — `composerPort` is assigned
        // from the mount result just below, so a read during the mount itself
        // answers `[]`, the truthful "no live composer yet" state. This closure
        // never stages, removes or uploads anything, and it names no second
        // store: the draft lifecycle stays with the application owner.
        const preview = deps.draftImagePreviewSource
        const draftImages = createSurfaceDraftImageProjection(() => composerPort, preview)
        const mounted = deps.renderer.mount({ imageLoader, imageScope: deps.imageScope, draftImages })
        display = mounted.display
        taskPresentation = mounted.taskPresentation
        composerPort = mounted.composer
        modelPresentation = mounted.modelPresentation
        presetPresentation = mounted.presetPresentation
        sessionBrowserPresentation = mounted.sessionBrowserPresentation
        interactionPresenter = mounted.interaction
        rendererDispose = mounted.dispose
        // PR3-B §3.3: the input projection is constructed HERE (from the EXACT
        // already-built callbacks, preserving their receiver/signature) but
        // BOUND LATER, through `bindRendererInput()`. Binding at this instant
        // would replay the renderer's held keys BEFORE the composition root has
        // settled the renderer capability and registered the command catalog —
        // a held `!` line would then pass the shell admission and a held
        // `/exit` would classify against an empty catalog (the B2 review's F2).
        pendingInputBinding = {
          exit: () => deps.events.onExit(),
          cancel: () => deps.events.onCancel?.(),
          submit: (text, request) => deps.events.onSubmit(text, request),
          // `onSteer` is optional on the events table (the capability is
          // guarded at construction): an absent one leaves the gesture a
          // committed no-op rather than a fabricated submission.
          steer: (text) => deps.events.onSteer?.(text),
          // PR4: the Ctrl+V media intent forwards to the ONE application
          // clipboard entry (`onClipboardPaste` is optional on the events
          // table, so an events object without it leaves the gesture a
          // committed no-op). The renderer never probes the OS clipboard.
          pasteMedia: () => deps.events.onClipboardPaste?.(),
          noteUserInput: () => deps.events.onUserInput?.(),
          // PR3-B B3 (§3.8): the Alt+Q continued-Question read/reopen cross
          // through the SAME interaction owner. They are bound here but can
          // only run on a real user key AFTER `attachInteraction()`; with no
          // controller yet they read empty / answer `false` — never a
          // fabricated fallback form.
          listContinuedQuestions: () => interaction.attentionRows(),
          reopenContinuedQuestion: (sessionId, callId) =>
            interaction.controller()?.reopen(sessionId, callId) ?? false,
        }
        inputBindTarget = mounted
        return
      }
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
        ...buildOptions(deps, imageLoader, rasterLoader),
        initialTerminalProgress: interval.snapshot().active,
        terminalProgressMode: parseTerminalProgressMode(options.terminalProgress),
      })
      display = pituiDisplaySeam(app)
      // B3-A1: the PiTui Task Center presentation sink is the ONE live app
      // itself, wrapped by the pure delegation adapter. It is installed
      // BEFORE the post-mount attention republish below, so that republish
      // reaches the real Quick window.
      taskPresentation = pituiTaskCenterPresentation(app)
      // PR3-B §3.1/§3.2: the PiTui branch's projections are the ONE live app
      // itself (structural compatibility is the contract). The modal presenter
      // is the narrow DELEGATING adapter over it (PR3-B B3): the app has no
      // `withdrawPending`, whose PiTui owner stays the app's own disposal.
      composerPort = app
      interactionPresenter = pituiSurfaceInteractionPresenter(app)
      // B4-B: any Task Center commit that ran BEFORE this mount (a cold
      // parked-Question discovery can publish before the terminal exists)
      // hit an unmounted display seam and skipped the below-editor Quick
      // projection. The mount is the ONE point where the seam becomes live:
      // republish the presentation-only projections so a quiet session (no
      // later churn) still paints its badge + Quick window.
      task.refreshAttentionRows()
    },
    bindRendererInput() {
      const target = inputBindTarget
      const handlers = pendingInputBinding
      inputBindTarget = undefined
      pendingInputBinding = undefined
      if (target === undefined || handlers === undefined) return
      target.bindInput(handlers)
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
      // PR2: drop the optional read-only projection observer BEFORE the mounted
      // app dies, so no synchronous teardown callback can publish another frame
      // to a sink that is about to be released.
      projectionObserver = undefined
      // PR3-A: retire the non-PiTui renderer's disposer slot (it is STARTED
      // below, after the interaction owner's logical cancellation); the seam
      // object itself stays readable so a late scheduled repaint after dispose
      // commits into the renderer's own dropped-frame path (the SDK surface is
      // closed) — the same contract the PiTui branch keeps via the
      // disposed-but-present TuiApp.
      const releaseRenderer = rendererDispose
      rendererDispose = undefined
      modelPresentation = undefined
      presetPresentation = undefined
      sessionBrowserPresentation = undefined
      // A disposed surface never binds its renderer input afterwards.
      pendingInputBinding = undefined
      inputBindTarget = undefined
      // M3-6 PR3: the aggregate teardown is ONE ordered non-truncating batch
      // (the plan's frozen order) across the sub-owners. Each sub-owner retires
      // its own one-shot slots before its callbacks run, so a throwing
      // TuiApp/app-owned cleanup can never strand the question attachment, the
      // plugin keybinding sync, the theme-unload hook release or the extension
      // surface detach. The process slot is NOT released here — TuiApp remains
      // its sole owner.
      runSyncDisposalSteps('surface runtime disposal', [
        // Retire the running truth BEFORE the mounted app dies, WITHOUT
        // fabricating a settlement: the proven outcome survives, so the app's
        // final disposal can retain a `done`/`error` OSC 7501 record while a
        // live interval still retires to `idle`. ProcessTerminal.stop() in
        // app.dispose() clears the OSC 9;4 indicator independently — this is
        // the surface-side semantic reset.
        () => retireMainAgentProgress(),
        // The question attachment first (its answer lookup is cleared before the
        // app dies), then the mounted app, then the extension surface resources
        // in the runner's original cleanup order. PR3-B B3: `interaction.dispose()`
        // itself retires the Question controller BEFORE withdrawing the
        // presenter's pending promises, so a teardown keeps the Host outcome
        // classification (ASK_ABORTED/ASK_CANCELLED) instead of manufacturing a
        // user cancellation.
        () => interaction.dispose(),
        () => app?.dispose(),
        // PR-C/Image-6A (Owner-approved minimal scope extension): retire the
        // PiTui mount's ONE image loader. `clear()` bumps the global epoch and
        // drops raw/derived caches, recorded failures and every QUEUED preview
        // conversion, so a disposed surface can never START another native
        // decode; a running conversion's late settle is discarded by the same
        // epoch. This is a SEPARATE non-truncating step after `app.dispose()`:
        // a throwing app cleanup still reaches it. The condition keeps the TSP
        // branch's loader/renderer release semantics untouched.
        () => { if (app !== undefined) mountedImageLoader?.clear() },
        // PR-D: abort in-flight SVG raster children and drop the display
        // derivative cache after the app has stopped painting.
        () => svgRasterLoader?.dispose(),
        // PR3-B B3 (§3.3.3): the renderer/SDK release STARTS here — after the
        // interaction owner's synchronous logical cancellation (every queued and
        // active modal promise is settled) and after the PiTui app's own
        // disposal, and before the extension resources. Starting it earlier
        // would close the terminal under a question/approval whose promises had
        // not been withdrawn yet; the non-truncating batch still starts it even
        // when an earlier synchronous step threw. The promise is OWNED by this
        // surface and awaited by the exit/fatal/fiber orchestrations: it is
        // deliberately NOT caught here, because a renderer cleanup failure must
        // reach those callers' error aggregation instead of being swallowed.
        () => {
          rendererRelease = releaseRenderer === undefined ? Promise.resolve() : releaseRenderer()
        },
        () => extension.dispose(),
      ])
    },
  }
}
