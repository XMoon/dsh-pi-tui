/**
 * SessionPresentation (A5b-1, plan §A5b-1): the ONE application owner of the
 * live-session presentation state and its cold hydration.
 *
 * Ownership:
 *
 * - the main transcript fold, its stats fold and the transcript window
 *   controller (the session's own presentation instances, replaced on every
 *   live-session commit);
 * - the main presentation target the surface event routing mutates, and the
 *   main ephemeral streaming-tool-preview map;
 * - the approval-preview tool-arguments cache fed by the Direct/domain
 *   bookkeeping;
 * - the session-generation reset (the synchronous A2 seam: presentation state,
 *   the viewer teardown and the local submission echoes all drop before the
 *   new owner is published);
 * - `initLiveSession`: the ONE cold-hydration path of a live session (the
 *   transcript/stats folds, the goal/working/plan/title/todo folds, the
 *   resumed compaction projection, the footer/status refresh, the per-session
 *   editor recall and the late-bound command registration).
 *
 * The module is deliberately neutral: it never imports a Host session/agent
 * package and never performs a Host lookup. The official DSH session
 * semantics this owner needs (the Session log, the session-title fold, the
 * session-projection plan read, the in-process model-selection install, the
 * live assistant-stream baseline) arrive through narrow injected capabilities,
 * so the Direct adapter stays the only place that maps official semantics onto
 * the current in-process implementation.
 * @module @xmoon76/dsh-pi-tui/app/surface/session-presentation
 */

import { compactingFromLog, workingFromLog } from '../../compaction-presentation.ts'
import { foldGoal, goalTextOf } from '../../status/derive-goal.ts'
import { recallHistoryForSession, type ParsedHistoryRecord } from '../../history.ts'
import { hydrateSessionUi } from '../../session-ui-hydrate.ts'
import { StatsFolder, hasEnoughRecentPerformanceSamples } from '../../stats.ts'
import { applyStreamingToolPreviewEvent, applyStreamingToolPreviewInput, clearStreamingToolPreviewsForStep } from '../../streaming-tool-preparing.ts'
import { TranscriptFolder } from '../../transcript.ts'
import { TranscriptWindowController } from '../../transcript-window.ts'
import type { Diag } from '../../diag.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { PresentationReadSnapshot } from '../../runtime/presentation-read-port.ts'
import type { StreamingToolPreview, TuiApp } from '../../tui-app.ts'
import type { RoutedSessionEvent, SurfaceMainPresentation, SurfaceRuntime } from './runtime.ts'

/**
 * The official CURRENT-VALUE facts of a session (M3-4 PR2) that a bounded
 * event window cannot own, because their source event may precede the window:
 * the title, the goal, the todo list and the workspace cwd. Each field is
 * present only when its official projection ANSWERED, and this object is
 * supplied on the Remote branch ALWAYS (an empty one means "the projections
 * cannot answer right now"): an absent field is therefore OMITTED — the
 * bounded window NEVER stands in for it (a recent window is not a session's
 * current value). A legal `null` (no goal / no todo write yet) hides the fact
 * the same way. Only the DIRECT branch folds these facts from its COMPLETE log
 * (there the object is absent altogether).
 */
export interface PresentationCurrentFacts {
  readonly cwd?: string
  readonly title?: string
  readonly goal?: { readonly objective: string; readonly phase: 'active' | 'paused' | 'blocked' | 'complete' } | null
  readonly todos?: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] | null
}

/** Apply the projection-owned current facts to the surface. ONE rule for the
 *  cold hydrate, the window replacement and the projection store's own change
 *  channel: an absent field means the projection cannot answer, so the fact is
 *  OMITTED (never the bounded window's guess); a legal `null` goal / todos
 *  means "no goal" / "no write yet" and hides the fact the same way. */
function applyCurrentFacts(
  facts: PresentationCurrentFacts,
  status: { setGoalText: (text: string | undefined) => void },
  app: TuiApp,
): void {
  status.setGoalText(facts.goal === undefined || facts.goal === null ? undefined : goalTextOf(facts.goal))
  app.setSessionTitle(facts.title)
  app.setTodoSummary(facts.todos ?? [])
}

/**
 * The committed Remote hydration outcome (M3-4 PR2): the window revision (the
 * live-ingress gap baseline), the proven working fold (the compaction-cache
 * seed) and the TRANSPORT TOKEN the read was fenced under — the token
 * travels with the fold so no consumer can re-stamp it with a newer
 * Connection/binding identity.
 */
export interface RemoteHydrationOutcome {
  readonly revision: number
  readonly working: boolean
  readonly proven: boolean
  readonly transportToken: unknown
}

/** The presentation event shape: exactly the event the transcript fold accepts,
 *  narrowed to the routing discriminant. The Host `SessionEvent` satisfies it,
 *  so the composition root instantiates the owner with the official type. */
export type SessionPresentationEvent = (Parameters<TranscriptFolder['apply']>[0] extends readonly (infer E)[] ? E : never) & RoutedSessionEvent

/** The structural live-session Agent facts this owner hydrates from. The
 *  object stays opaque: only the session id/header/log are its contract. */
export interface LiveSessionAgent<Event> {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    snapshotEvents(): readonly Event[]
  }
}

/** The narrow capabilities the presentation owner consumes. Nothing here is a
 *  Host lookup: the composition root maps each one onto the current in-process
 *  owner (Direct, status, history, command, submission, viewer). */
export interface SessionPresentationDeps<Event extends SessionPresentationEvent> {
  /** The mounted surface owner (its `app` is the live TuiApp once mounted). */
  readonly surface: SurfaceRuntime<Event>
  /** Process diagnostics for the cold-scan timings. */
  readonly diag: Diag
  /** True once the runner is disposing: no hydration may start. */
  readonly isCleanedUp: () => boolean
  /** F10 (round 4): re-derive the footer status from the CURRENT folds —
   *  the composition root's `refreshStatusCheap` (it owns the semantic
   *  derivation and the commit). The re-hydrate path calls it after
   *  replacing the stats fold, so the footer never keeps rendering the
   *  pre-page figures. */
  readonly refreshStatusCheap: () => void
  /** Official DSH log folds the composition root owns. */
  readonly folds: {
    readonly title: (events: readonly Event[]) => string | undefined
  }
  /** The in-process Direct facts (never a Direct import in this owner). */
  readonly direct: {
    /** Install the live session's model-selection projection. */
    readonly installModelSelection: (agent: LiveSessionAgent<Event>) => void
    /** The exact Agent's live assistant-stream baseline. */
    readonly assistantStreamBaselineFor: (agent: LiveSessionAgent<Event>) => readonly AssistantLiveInput[]
    /** Whether the live session is in plan mode (official session projection). */
    readonly planActive: (agent: LiveSessionAgent<Event>) => boolean
  }
  /** The footer/status projections owned by the surface status owner (A5b-2). */
  readonly status: {
    readonly setGoalText: (text: string | undefined) => void
    readonly refresh: () => void
    readonly refreshTerminalTitle: () => void
    readonly updateWelcomeCard: () => void
    readonly scheduleInitialMeasurement: (sessionId: string) => void
  }
  /** The per-session client-local input history (A5b-2 owns it). */
  readonly history: {
    readonly rememberCwd: (cwd: string) => void
    readonly currentCwd: () => string
    readonly records: (cwd: string) => readonly ParsedHistoryRecord[]
    readonly setLastContent: (content: string | undefined) => void
  }
  /** Late-bound command catalog registration (A5b-3 owns it). */
  readonly commands: {
    readonly register: () => void
  }
  /** The submission owner: the generation reset drops local echoes (A5b-4). */
  readonly submission: {
    readonly clearPending: () => void
  }
  /** The viewer owner: the generation reset tears the viewer down (A5b-1). */
  readonly viewer: {
    readonly resetAutoPop: () => void
    readonly teardownForSessionSwap: () => void
  }
  /**
   * The Remote-branch presentation reads (M3-4 PR2): absent on Direct. When
   * present, `initLiveSession` hydrates through the semantic reader (the
   * bounded official window + the live baseline) instead of a Direct Agent
   * full-log snapshot, and the working/busy fallback reads the official
   * `running` bit when the bounded window cannot prove a turn boundary.
   */
  readonly remote?: {
    /** Read the current official window snapshot for the session. */
    readonly read: (sessionId: string) => Promise<PresentationReadSnapshot | undefined>
    /** The official `running` bit of the exact retained binding. */
    readonly running: (sessionId: string) => boolean | undefined
    /** The official `plan` projection active bit of the exact retained
     *  binding (absent capability reads inactive). */
    readonly plan?: (sessionId: string) => boolean | undefined
    /** The official CURRENT-VALUE facts (title/goal/todos/cwd) of the exact
     *  retained session: their source events may precede the bounded window,
     *  so the projection — never the window — owns them. On the Remote branch
     *  this ALWAYS answers: an empty object means "the projections cannot
     *  answer right now", and the fact is then OMITTED rather than folded from
     *  a bounded window (a recent window is not a session's current value). */
    readonly facts: (sessionId: string) => PresentationCurrentFacts
    /** The ownership generation captured BEFORE the reader await (the
     *  §6.5 fence token; absent when the caller provides no generation). */
    readonly captureGeneration?: () => number
    /**
     * The §6.5 REMOTE TRANSPORT token capture (Connection generation +
     * exact binding object), taken before the reader await. Absent on a
     * Direct-shaped remote group.
     */
    readonly captureTransportToken?: (sessionId: string) => unknown
    /** Whether the captured transport token still matches the live identity
     *  (a Connection/binding rollover WITHOUT a TUI owner commit still
     *  invalidates the pending visible commit — plan §6.5). */
    readonly isTransportTokenCurrent?: (sessionId: string, token: unknown) => boolean
    /**
     * The VISIBLE-COMMIT fence token (plan §6.5/§7.5): the caller captures
     * the ownership GENERATION before starting the hydration; after the
     * reader await, the commit may run only while the CURRENT owner reads
     * the SAME session id AND the captured generation is still current.
     * The generation bumps on EVERY owner commit (ordinary/fork/first-
     * session/resume — including a same-id binding rollover), so this is
     * exact-generation currentness, never sessionId alone.
     */
    readonly isStillCurrent?: (sessionId: string, generation: number) => boolean
  }
}

/** The live-session presentation owner as the composition root consumes it. */
export interface SessionPresentation<Event extends SessionPresentationEvent> {
  /** The main presentation target for the surface event routing. */
  readonly main: SurfaceMainPresentation<Event>
  /** The concrete main transcript fold (routing/status glue reads it directly). */
  mainFolder(): TranscriptFolder
  /** The main stats fold (the status projection snapshots it). */
  mainStats(): StatsFolder
  /** The main transcript window controller (the anchor decision reads it). */
  mainWindow(): TranscriptWindowController
  /** Apply one transient assistant input to the main presentation. */
  applyAssistantInput(input: AssistantLiveInput): void
  /** Cache one tool call's arguments for the approval preview. */
  setToolArgs(callId: string, args: string): void
  /** Drop one settled tool call's cached arguments. */
  deleteToolArgs(callId: string): void
  /** The cached arguments of one tool call, if any. */
  toolArgs(callId: string): string | undefined
  /** Restore the main transcript's semantic latest/history anchor. */
  restoreMainTranscriptAnchor(): void
  /** Rebuild every live-session surface after resume, create or swap. */
  initLiveSession(agent: LiveSessionAgent<Event>): Promise<void>
  /**
   * The Remote-branch cold hydration (M3-4 PR2): the same ONE cold-hydration
   * path over the semantic `PresentationReader` window (bounded coverage,
   * official hasMore/loadingOlder), the opening-journal merge, the live
   * baseline replay and the same presentation-only folds. Absent remote
   * deps make this a no-op (the Direct branch owns `initLiveSession`).
   */
  initLiveRemoteSession(sessionId: string): Promise<RemoteHydrationOutcome | undefined>
  /** Re-apply the OFFICIAL current-value facts (title/goal/todos) of one
   *  session — the projection store's own change channel. The cold hydrate,
   *  the window replacement and a live projection update therefore share ONE
   *  projection-authority rule (and never a bounded-window fold). */
  applySessionCurrentFacts(sessionId: string): void
  /**
   * Re-hydrate the main transcript from the CURRENT reader window after an
   * older-history extension (Remote `loadOlder`): the append-only fold cannot
   * take a front-joined page incrementally, so the bounded window re-folds
   * (the honest model for a bounded window; the fold stays cheap).
   */
  rehydrateFromWindow(sessionId: string): Promise<void>
  /**
   * PR5 truthfulness (plan §3.2): whether the main stats fold's
   * RECENT-performance figures are AUTHORITATIVE for presentation. `true`
   * on Direct (the fold reads the COMPLETE in-process session log) and on a
   * Remote window that proved its recent-sample evidence (the window
   * reached the history start, or the fold retained enough valid samples —
   * `hasEnoughRecentPerformanceSamples`). `false` while a bounded Remote
   * window cannot prove either: the footer/status must OMIT the recent
   * metrics (never a numeric `0s · 0 tok/s` stand-in). This is the ONE
   * presentation-owned availability authority beside the stats fold; it is
   * committed in the SAME fenced hydrate that commits the fold itself, so
   * a stale hydrate can never flip the replacement subject's bit.
   */
  mainRecentPerformanceAvailable(): boolean
  /**
   * F1 (PR5 §3.2): re-answer the availability bit off the SAME fold the live
   * ingress just mutated, so a bounded window that committed `false` can flip
   * on ordinary appended evidence without a `loadOlder`/rehydrate. Monotonic
   * within a generation (`false → true` only) and it re-derives the status when
   * the bit flips.
   */
  refreshRecentPerformanceAvailability(): void
  /** The synchronous surface reset that follows a generation bump (A2 seam). */
  resetForGeneration(): void
}

/** Create the live-session presentation owner (plan §A5b-1). */
/** The transcript window policy (turns kept live, turns per step). */
export const TRANSCRIPT_WINDOW_TURNS = 20
export const TRANSCRIPT_WINDOW_STEP = 10

/** Apply one transient input to a presentation owner and its independent stats. */
export function applyAssistantLiveInput(
  owner: TranscriptFolder,
  stats: StatsFolder,
  previews: Map<string, StreamingToolPreview>,
  input: AssistantLiveInput,
): void {
  if (input.kind === 'end' && (input.status === 'abandoned' || input.settlement === 'attempt')) {
    clearStreamingToolPreviewsForStep(previews, input.turn, input.step)
  } else if (!(input.kind === 'chunk' && owner.turnActivity(input.turn)?.completed === true)) {
    applyStreamingToolPreviewInput(previews, input)
  }
  owner.applyLiveInput(input)
  stats.applyLiveInput(input)
}

/** Join a durable observation with the opening journal after its snapshot cut. */
export function mergeSessionEventCut<Event extends { readonly seq: number | string }>(
  snapshot: readonly Event[],
  opening: readonly Event[],
): Event[] {
  const cut = snapshot.length === 0 ? -1 : Number(snapshot[snapshot.length - 1]!.seq)
  return [...snapshot, ...opening.filter((event) => Number(event.seq) > cut)]
}

/** Time one cold-bootstrap fold without changing its authoritative semantics. */
function timedBootstrapScan<T>(diag: Diag, name: string, eventCount: number, scan: () => T): T {
  const started = performance.now()
  const result = scan()
  diag.debug('session bootstrap scan', {
    scan: name,
    eventCount,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  })
  return result
}

/** Create the live-session presentation owner (plan §A5b-1). */
export function createSessionPresentation<Event extends SessionPresentationEvent>(
  deps: SessionPresentationDeps<Event>,
): SessionPresentation<Event> {
  // Incremental fold state for the live session's log; reset on switch. A
  // resumed session is hydrated only by initLiveSession below, so startup
  // wiring never pre-folds the same event log a second time.
  
  let folder = new TranscriptFolder()

  let windowController = new TranscriptWindowController({
    windowTurns: TRANSCRIPT_WINDOW_TURNS,
    stepTurns: TRANSCRIPT_WINDOW_STEP,
    turns: folder.groupedTurns(),
  })

  let statsFolder = new StatsFolder()

  /**
   * PR5 (plan §3.2): the presentation-owned recent-performance availability
   * of the CURRENT main stats fold (see `mainRecentPerformanceAvailable`).
   * Starts `false` (no authoritative window is committed yet) and flips only
   * inside the SAME fenced hydrate commits that replace `statsFolder`.
   */
  let recentPerformanceAvailable = false

  // Coalesced repaint is surface-owned (A4-8): the runner no longer owns
  // the flush timer; the surface routing schedules its own repaint.
  // Ephemeral previews are isolated per presentation owner: the main live
  // session and a mounted child viewer never share call ids or rows.
  
  const mainStreamingToolPreviews = new Map<string, StreamingToolPreview>()

  // The TUI-owned slash commands are registered by registerCommands()
  // inside initLiveSession, exactly once after the first session exists.
  // The initial status projection is committed after session hydration (or
  // in the deferred branch below), so a resumed session never paints a
  // temporary empty stats projection.
  // A4-7 (plan §16): the presentation event routing is SURFACE-owned. The
  // runner keeps only the Cordis registrations (thin delegations) plus the
  // Direct assistant-stream INSTALL and the Direct/domain bookkeeping
  // supplied through this narrow capability bundle. A4-4/A4-8: the same
  // bundle also carries the pending-input capabilities, the presentation
  // targets (folder/window/previews) and the repaint/search refresh
  // coordination, so it is attached BEFORE the startup calls into
  // `surface.refreshPendingInput()`.
  
  const mainPresentation = {
    get folder() { return folder },
    get stats() { return statsFolder },
    get window() { return windowController },
    get previews() { return mainStreamingToolPreviews },
    applyToolPreview: (event: Event) => applyStreamingToolPreviewEvent(mainStreamingToolPreviews, event),
    // Forwarded to the owner's own live refresh (declared below the fold state
    // it reads); a live accessor so a session commit cannot capture a stale one.
    refreshRecentPerformanceAvailability: () => refreshRecentPerformanceAvailability(),
  }

  // Tool-call arguments by callId, for the approval-preview dialog.
  
  const callArgs = new Map<string, string>()

  /**
   * The synchronous surface reset that follows a generation bump (A2 seam).
   * MUST stay synchronous — no await, no microtask — and MUST run while the
   * OLD owner is still current: the session runtime publishes the new owner
   * only AFTER this returns (see the four commit shapes in the A2 plan §4).
   */
  
  const resetForGeneration = (): void => {
    callArgs.clear()
    mainStreamingToolPreviews.clear()
    // PR5 (plan §3.2): the replacement subject has NO authoritative window
    // yet — the recent-performance availability bit returns to `false` until
    // the new subject's own fenced hydrate proves otherwise (the old
    // subject's `true` must not leak into the hydrate-pending window).
    recentPerformanceAvailable = false
    // The new session's subagent delegations are a fresh namespace: stale
    // pending calls from the old session would consume viewer match slots,
    // and dead callId→child maps would silently disable the auto-pop.
    deps.viewer.resetAutoPop()
    // A4-8: the search presentation state is surface-owned.
    deps.surface.resetSearchPresentation()
    windowController.latest()
    windowController.setTurns(folder.groupedTurns())
    deps.surface.app.setSearchResult(0, 0)
    deps.surface.app.clearSessionOverrides()
    // A new session owns the surface: the whole Task Center (the Job child
    // overlay FIRST, then the browser, then the cached catalog + the
    // synchronous badge/summary/row mirrors) is reset by the surface owner
    // (A4-6). Its rows would otherwise go stale — the runtime refresh is
    // fenced to the old root — and the new session's first listing is async,
    // so the old session's running badge must not hang on the footer until
    // it lands (a failed listing must never leave a stale badge either).
    deps.surface.resetTasks()
    // The pending-input presentation is session-scoped too: clear old
    // semantic rows AND local submission echoes at the synchronous
    // generation boundary before the new subject is published. The
    // own-input memory is surface-owned (A4-4).
    deps.submission.clearPending()
    deps.surface.resetPendingPresentation()
    // A new session owns the surface: tear down the subagent viewer. The
    // old viewer's parent session is gone (the continuation contract
    // requires the EXACT live parent), so the child transcript, the
    // viewer editor and the per-child drafts must not leak into the new
    // session. The teardown is UNCONDITIONAL — an open may still be
    // loading when nothing is mounted, and the swap must still cancel
    // it — and closes the mounted viewer when there is one. The MAIN
    // draft (the user's unsent text) restores into the new session's
    // editor — cross-session draft retention is the existing behavior.
    deps.viewer.teardownForSessionSwap()
  }

  // The TUI-owned slash commands are registered as soon as the runner
  // surface exists — the commands service's GLOBAL layer needs no agent,
  // so the whole command surface (and the editor's tab completion) is
  // available before the first session (deferred start). Session-backed
  // handlers call runner.ensureSession() themselves (the facade delegates to
  // the session runtime); the runner surface re-reads the live agent on every
  // access, so a session swap mid-flight is always reflected.
  /**
   * Rebuild every live-session surface after resume, create, or swap.
   * The surface catalog is NOT touched here: the initial owner's catalog
   * came from the pre-mount prefetch/probe, and the first deferred create
   * plus every switch await the coordinator refresh themselves.
   */
  
  /**
   * The shared cold-hydrate body both branches converge on (M3-4 PR2): fold
   * the events into the transcript/stats folders, replay the live baseline,
   * derive the presentation-only folds (goal/working/plan/title/todo/
   * compaction) and commit/repaint. The CALLER owns the event-source
   * resolution (Direct: the full Agent log + its live baseline; Remote: the
   * bounded reader window + its live inputs) and the working/plan values.
   */
  const hydratePresentation = async (input: {
    readonly sessionId: string
    readonly cwd: string | undefined
    readonly events: readonly Event[]
    readonly liveBaseline: readonly AssistantLiveInput[]
    readonly planActive: boolean
    readonly working: boolean
    /**
     * PR5 (plan §3.2): whether `events` may PROVE the recent-performance
     * sample evidence. Present on the Remote branch: `false` while the
     * bounded window has neither reached the history start nor retained
     * enough valid recent samples (the footer then omits the recent
     * metrics). Absent on Direct, whose `events` is the COMPLETE log (the
     * fold's own figures are authoritative by construction).
     */
    readonly recentPerformanceAvailable?: boolean
    /**
     * The official CURRENT-VALUE facts (M3-4 PR2). Present on the Remote
     * branch, where `events` is only a BOUNDED window: the title/goal/todos of
     * a long session may have been written before the window and must come
     * from the projection, not from a fold that would read them as absent.
     * Absent on Direct, whose `events` is the complete log.
     */
    readonly facts?: PresentationCurrentFacts
  }): Promise<void> => {
    const events = input.events
    // This is the single cold-hydration path for a live session. Do not
    // pre-apply the same event log during runner wiring: a resumed session
    // otherwise pays for two full transcript and stats replays before its
    // first usable frame.
    const hydrated = hydrateSessionUi(events)
    folder = hydrated.folder
    windowController.setTurns(folder.groupedTurns())
    statsFolder = hydrated.statsFolder
    // PR5: the availability bit commits with the SAME fold it describes —
    // one fenced commit, one subject (a stale hydrate cannot flip the
    // replacement subject's bit because the §6.5 fences above already
    // dropped it before reaching this line).
    recentPerformanceAvailable = input.recentPerformanceAvailable ?? true
    for (const liveInput of input.liveBaseline) {
      applyAssistantLiveInput(folder, statsFolder, mainStreamingToolPreviews, liveInput)
    }
    deps.diag.debug('session bootstrap scan', {
      scan: 'transcript',
      eventCount: events.length,
      elapsedMs: Number(hydrated.scanTimings.transcriptMs.toFixed(3)),
    })
    deps.diag.debug('session bootstrap scan', {
      scan: 'stats',
      eventCount: events.length,
      elapsedMs: Number(hydrated.scanTimings.statsMs.toFixed(3)),
    })
    deps.surface.app.setPlanMode(input.planActive)
    deps.surface.app.setWorking(input.working)
    deps.surface.app.setBusy(input.working)
    if (input.facts !== undefined) {
      // REMOTE: the official projections ARE the current-value authority. An
      // unavailable one is OMITTED — the bounded window never stands in for a
      // session-global fact (a recent window is not a session's current title,
      // goal or standing todo list).
      applyCurrentFacts(input.facts, deps.status, deps.surface.app)
    } else {
      // DIRECT: the COMPLETE log is the fold authority for the same facts.
      deps.status.setGoalText(timedBootstrapScan(deps.diag, 'goal', events.length, () => foldGoal(events)))
      deps.surface.app.setSessionTitle(timedBootstrapScan(deps.diag, 'title', events.length, () => deps.folds.title(events)))
      deps.surface.app.setTodoSummary(timedBootstrapScan(deps.diag, 'todo', events.length, () => {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type === 'todo/write') return (event.data as { readonly todos: Parameters<TuiApp['setTodoSummary']>[0] }).todos
        }
        return []
      }))
    }
    // A resumed session may be mid-compaction. Reset the old phase first;
    // then re-arm only the newest live bracket, matching the log fold.
    const resumedCompaction = timedBootstrapScan(deps.diag, 'compaction', events.length, () => compactingFromLog(events))
    // A4-7: the `compactingId` routing state and the phase/busy/working
    // presentation are surface-owned (plan §16).
    deps.surface.applyResumedCompaction(resumedCompaction.id, resumedCompaction.active)
    deps.surface.app.clearLocalMessages()
    deps.surface.app.clearNotify() // a notice from the previous session is stale here
    // Issue #8: a stale keyboard exit confirmation must not exit the NEW
    // session.
    deps.surface.app.clearExitConfirmation()
    deps.surface.repaint()
    // PR D2: the first usable frame paints with the cached measurement
    // (or none); the context measure is deferred one event-loop turn so
    // cold resume never blocks first paint on a long-session scan.
    deps.status.refresh()
    deps.surface.refreshPendingInput()
    deps.status.scheduleInitialMeasurement(input.sessionId)
    // Repaint both task channels (the JobRegistry roster + the subagent
    // catalog): the dock/badge are owner-fenced,
    // and a session switch must not leave the previous session's tasks
    // or subagents on screen until the next registry event.
    deps.surface.refreshTasks()
    deps.surface.refreshAgents()
    // The session's own workspace joins the known-cwd set (Rule 2 for
    // the all-directory search): a legacy-only history file in this cwd
    // becomes recoverable immediately, even if it predates this process.
    if (input.cwd !== undefined && input.cwd !== '') deps.history.rememberCwd(input.cwd)
    // The recall history is per-workspace AND per-session: REPLACE it
    // with the live session's rows ONLY (the CWD file's rows filtered to
    // this sessionId — session-scoped editor recall), so ↑/↓ in a live
    // session never recalls another session's inputs from the same cwd.
    // The CANONICAL last row stays the cwd file's actual last row (the
    // persistence dedupe anchor stays cwd-scoped — docs/input-history.md);
    // only the EDITOR's recall is the session projection.
    const historyCwd = deps.history.currentCwd()
    const historyRecords = deps.history.records(historyCwd)
    deps.history.setLastContent(historyRecords.at(-1)?.content)
    // File order is oldest-first; TuiApp's recall API takes newest-first,
    // so the session-filtered projection is reversed at the seed.
    const sessionRecall = recallHistoryForSession(historyRecords, input.sessionId)
    deps.surface.app.resetInputHistory([...sessionRecall].reverse())
    deps.status.refreshTerminalTitle()
    deps.status.updateWelcomeCard()
    deps.commands.register()
  }

  const initLiveSession = async (agent: LiveSessionAgent<Event>): Promise<void> => {
    if (deps.isCleanedUp()) return
    // Session transitions invalidate transient keyboard confirmation before
    // any asynchronous hydration or bootstrap work begins.
    deps.surface.app.clearExitConfirmation()
    // Setup installs this before publication; the idempotent call also
    // covers test/direct adapters that hand an already-live Agent back to
    // the runner. Its fold is the resume source of truth.
    deps.direct.installModelSelection(agent)
    const opening = deps.surface.openingJournal.cut(agent.session.id)
    const events = opening === undefined
      ? agent.session.snapshotEvents()
      : mergeSessionEventCut(agent.session.snapshotEvents(), opening.events)
    await hydratePresentation({
      sessionId: agent.session.id,
      cwd: agent.session.header.cwd,
      events,
      liveBaseline: deps.direct.assistantStreamBaselineFor(agent),
      planActive: deps.direct.planActive(agent),
      working: workingFromLog(events),
    })
  }

  /**
   * The Remote-branch cold hydration (M3-4 PR2): capture-free by design —
   * the CALLER (the bootstrap seam) proves the owner current before and
   * after this call; this body only reads the semantic reader snapshot and
   * folds. The bounded window is honest: `hasMore` older history stays
   * unpaged until the user asks, and the working/busy fold falls back to
   * the official `running` bit when the window starts mid-turn and cannot
   * prove a boundary (an official fact, never a guess).
   */
  const initLiveRemoteSession = async (sessionId: string): Promise<RemoteHydrationOutcome | undefined> => {
    if (deps.isCleanedUp()) return undefined
    if (deps.remote === undefined) return undefined
    deps.surface.app.clearExitConfirmation()
    // The fence tokens are captured BEFORE the await (plan §7.5 order:
    // capture subject/generation/transport identity → read → verify →
    // hydrate): the TUI ownership generation AND the Remote transport
    // identity (Connection generation + exact binding object).
    const fenceGeneration = deps.remote.captureGeneration?.()
    const fenceTransport = deps.remote.captureTransportToken?.(sessionId)
    const snapshot = await deps.remote.read(sessionId)
    if (deps.isCleanedUp() || snapshot === undefined) return undefined
    // §6.5 visible-commit fence: an await elapsed; the owner may have been
    // replaced (switch/new/fork or a same-id generation rollover — the
    // generation bumps on every commit), or the Remote transport may have
    // rolled over (Connection/binding replacement WITHOUT a TUI owner
    // commit). Same id alone proves nothing; each token must still match.
    if (deps.remote.isStillCurrent?.(sessionId, fenceGeneration ?? 0) === false) return undefined
    if (fenceTransport !== undefined
      && deps.remote.isTransportTokenCurrent?.(sessionId, fenceTransport) === false) return undefined
    const opening = deps.surface.openingJournal.cut(sessionId)
    const events: Event[] = opening === undefined
      ? [...snapshot.durableEvents as readonly Event[]]
      : mergeSessionEventCut(snapshot.durableEvents as readonly Event[], opening.events as readonly Event[])
    // The working-fold proof hierarchy (M3-4 PR2 equivalence contract, see
    // test/remote-working-fold-equivalence.test.ts):
    // 1. A COMPLETE window (hasMore=false) proves the fold — the last visible
    //    boundary IS the global latest.
    // 2. A window with hasMore=true proves nothing about the LATEST boundary:
    //    its last visible boundary may be an old one (the running turn's
    //    turn/start may be beyond the window front or not yet durable), so
    //    the official `running` bit is the authoritative presentation fact.
    //    (running=false ⇒ every turn ended ⇒ fold-false agrees; running=true
    //    covers the wake window before turn/start lands — both directions
    //    are the UI working fact.)
    // A COMPLETE window (hasMore=false) ALWAYS proves the fold - including
    // the empty window (the fold is false by definition: no turn is open).
    // Only a TRUNCATED window (hasMore) defers to the official running bit.
    const foldProven = !snapshot.hasMore
    const working = foldProven ? workingFromLog(events) : (deps.remote.running(sessionId) ?? false)
    // PR5 (plan §3.2): the bounded window's recent-performance authority —
    // the window reaches the history start (its zero is a measured zero) OR
    // the fold retained enough valid samples for both recent windows. A
    // truncated window short of both keeps the footer's recent metrics
    // OMITTED (unknown), never a numeric zero stand-in.
    const recentPerformanceAvailable = foldProven
      || hasEnoughRecentPerformanceSamples(snapshot.durableEvents as never[])
    // The official CURRENT-VALUE facts (title/goal/todos/cwd) — their source
    // events may precede this bounded window, so the projection owns them.
    const facts = deps.remote.facts?.(sessionId)
    await hydratePresentation({
      sessionId,
      // The session's OWN workspace fact: the bounded window cannot carry it.
      cwd: facts?.cwd,
      events,
      liveBaseline: snapshot.liveInputs,
      ...(facts === undefined ? {} : { facts }),
      // The `plan` projection is the plan authority on the Remote branch;
      // its absence reads inactive (the projection capability is absent),
      // which hydratePresentation expresses through the injected value.
      planActive: planActiveRemote(sessionId),
      working,
      // PR5: the window's recent-performance proof travels with the fold.
      recentPerformanceAvailable,
    })
    // The committed window revision: the caller feeds it to the live ingress
    // so the hydrate→subscribe gap is detected and recovered (never lost).
    // The proven fold rides along so the caller seeds its compaction cache on
    // the FIRST hydrate (no first-use running window) — stamped with the
    // SAME transport token this read was fenced under, so a later caller can
    // never label an old window's fold with a newer transport identity.
    return { revision: snapshot.revision, working, proven: foldProven, transportToken: fenceTransport }
  }

  /** The Remote-branch plan fact: the official `plan` projection read is
   *  injected by the bootstrap (status facts bundle); absent deps read
   *  inactive. Kept as a late-bound read so the projection updates between
   *  hydration and commit are honored. */
  const planActiveRemote = (sessionId: string): boolean => deps.remote?.plan?.(sessionId) ?? false

  /**
   * Re-hydrate the main transcript from the CURRENT reader window after an
   * older-history extension (Remote `loadOlder`): the append-only fold
   * cannot take a front-joined page incrementally, so the bounded window
   * re-folds. Status/pending/goal folds keep their live state (the window
   * grew at the FRONT; the live tail is unchanged), so this path only
   * rebuilds the transcript/stats presentation and repaints.
   */
  const applySessionCurrentFacts = (sessionId: string): void => {
    if (deps.remote === undefined) return
    applyCurrentFacts(deps.remote.facts(sessionId), deps.status, deps.surface.app)
  }

  const rehydrateFromWindow = async (sessionId: string): Promise<void> => {
    if (deps.isCleanedUp()) return
    if (deps.remote === undefined) return
    const fenceGeneration = deps.remote.captureGeneration?.()
    const fenceTransport = deps.remote.captureTransportToken?.(sessionId)
    const snapshot = await deps.remote.read(sessionId)
    if (deps.isCleanedUp() || snapshot === undefined) return
    // §6.5 visible-commit fence (same double rule as the cold hydrate).
    if (deps.remote.isStillCurrent?.(sessionId, fenceGeneration ?? 0) === false) return
    if (fenceTransport !== undefined
      && deps.remote.isTransportTokenCurrent?.(sessionId, fenceTransport) === false) return
    const hydrated = hydrateSessionUi(snapshot.durableEvents as readonly Event[])
    folder = hydrated.folder
    windowController.setTurns(folder.groupedTurns())
    statsFolder = hydrated.statsFolder
    // PR5: the widened window re-proves (or disproves) its recent-sample
    // evidence in the SAME fenced commit that replaced the fold — a
    // `loadOlder` that reaches enough samples (or the history start) flips
    // the footer's omitted metrics on with the new fold, never after it.
    recentPerformanceAvailable = !snapshot.hasMore
      || hasEnoughRecentPerformanceSamples(snapshot.durableEvents as never[])
    for (const liveInput of snapshot.liveInputs) {
      applyAssistantLiveInput(folder, statsFolder, mainStreamingToolPreviews, liveInput)
    }
    // F10 (round 4): the stats fold was just REPLACED by the wider window —
    // the footer's status derivation still reads the pre-hydrate snapshot,
    // so a repaint alone would keep rendering the stale (often all-zero)
    // recent figures. Re-derive the status from the NEW fold in the same
    // step; the cheap refresh's own fences own the session/binding rules.
    deps.refreshStatusCheap()
    deps.surface.repaint()
  }

  const mainFolder = (): TranscriptFolder => folder
  const mainStats = (): StatsFolder => statsFolder
  const mainRecentPerformanceAvailable = (): boolean => recentPerformanceAvailable
  /**
   * F1 (PR5 §3.2): the availability bit must follow the SAME fold's LIVE
   * evidence. A bounded Remote window that committed `false` (truncated, not
   * enough valid samples yet) can cross the completeness threshold through
   * ordinary appended events — with no `loadOlder` and no rehydrate. Re-answer
   * the predicate off the fold the append already updated (never a second scan
   * or a second fold) and, when it flips, re-derive the status in the same step
   * so the footer and `/status` stop omitting the recent figures immediately.
   *
   * Monotonic within a generation: `false → true` only. A replacement subject
   * returns to `false` in `resetForGeneration`, and the next fenced hydrate
   * re-proves it (or disproves it) as before.
   */
  const refreshRecentPerformanceAvailability = (): void => {
    if (recentPerformanceAvailable) return
    if (!statsFolder.hasEnoughRecentEvidence()) return
    recentPerformanceAvailable = true
    deps.refreshStatusCheap()
  }
  const mainWindow = (): TranscriptWindowController => windowController
  const restoreMainTranscriptAnchor = (): void => {
    windowController.isLatest()
      ? deps.surface.app.scrollToBottom()
      : deps.surface.app.scrollToTop({ disableFollow: true })
  }
  const applyAssistantInput = (input: AssistantLiveInput): void => {
    applyAssistantLiveInput(folder, statsFolder, mainStreamingToolPreviews, input)
  }
  const setToolArgs = (callId: string, args: string): void => { callArgs.set(callId, args) }
  const deleteToolArgs = (callId: string): void => { callArgs.delete(callId) }
  const toolArgs = (callId: string): string | undefined => callArgs.get(callId)

  return {
    main: mainPresentation,
    mainFolder,
    mainStats,
    mainRecentPerformanceAvailable,
    refreshRecentPerformanceAvailability,
    mainWindow,
    applyAssistantInput,
    setToolArgs,
    deleteToolArgs,
    toolArgs,
    restoreMainTranscriptAnchor,
    initLiveSession,
    initLiveRemoteSession,
    applySessionCurrentFacts,
    rehydrateFromWindow,
    resetForGeneration,
  }
}
