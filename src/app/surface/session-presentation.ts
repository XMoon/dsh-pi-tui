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
import { foldGoal } from '../../status/derive-goal.ts'
import { recallHistoryForSession, type ParsedHistoryRecord } from '../../history.ts'
import { hydrateSessionUi } from '../../session-ui-hydrate.ts'
import { StatsFolder } from '../../stats.ts'
import { applyStreamingToolPreviewEvent, applyStreamingToolPreviewInput, clearStreamingToolPreviewsForStep } from '../../streaming-tool-preparing.ts'
import { TranscriptFolder } from '../../transcript.ts'
import { TranscriptWindowController } from '../../transcript-window.ts'
import type { Diag } from '../../diag.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { StreamingToolPreview, TuiApp } from '../../tui-app.ts'
import type { RoutedSessionEvent, SurfaceMainPresentation, SurfaceRuntime } from './runtime.ts'

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
    readonly scheduleInitialMeasurement: (agent: LiveSessionAgent<Event>) => void
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
  
  const initLiveSession = async (agent: LiveSessionAgent<Event>): Promise<void> => {
    if (deps.isCleanedUp()) return
    // Session transitions invalidate transient keyboard confirmation before
    // any asynchronous hydration or bootstrap work begins.
    deps.surface.app.clearExitConfirmation()
    // Setup installs this before publication; the idempotent call also
    // covers test/direct adapters that hand an already-live Agent back to
    // the runner. Its fold is the resume source of truth.
    deps.direct.installModelSelection(agent)
    // The session's own workspace joins the known-cwd set (Rule 2 for
    // the all-directory search): a legacy-only history file in this cwd
    // becomes recoverable immediately, even if it predates this process.
    deps.history.rememberCwd(agent.session.header.cwd ?? '')
    const opening = deps.surface.openingJournal.cut(agent.session.id)
     const events = opening === undefined
       ? agent.session.snapshotEvents()
       : mergeSessionEventCut(agent.session.snapshotEvents(), opening.events)
    // This is the single cold-hydration path for a live session. Do not
    // pre-apply the same event log during runner wiring: a resumed session
    // otherwise pays for two full transcript and stats replays before its
    // first usable frame.
    const hydrated = hydrateSessionUi(events)
    folder = hydrated.folder
     windowController.setTurns(folder.groupedTurns())
    statsFolder = hydrated.statsFolder
     for (const input of deps.direct.assistantStreamBaselineFor(agent)) {
       applyAssistantLiveInput(folder, statsFolder, mainStreamingToolPreviews, input)
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
    deps.status.setGoalText(timedBootstrapScan(deps.diag, 'goal', events.length, () => foldGoal(events)))
    const working = timedBootstrapScan(deps.diag, 'working', events.length, () => workingFromLog(events))
    const planMode = timedBootstrapScan(deps.diag, 'plan', events.length, () => deps.direct.planActive(agent))
    const title = timedBootstrapScan(deps.diag, 'title', events.length, () => deps.folds.title(events))
    deps.surface.app.setPlanMode(planMode)
    deps.surface.app.setWorking(working)
    deps.surface.app.setBusy(working)
    deps.surface.app.setSessionTitle(title)
    // Session-local bootstrap state must not leak across a switch. Fold the
    // latest todo snapshot once from the same log (an empty log clears it).
    const todos = timedBootstrapScan(deps.diag, 'todo', events.length, () => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'todo/write') return (event.data as { readonly todos: Parameters<TuiApp['setTodoSummary']>[0] }).todos
      }
      return []
    })
    deps.surface.app.setTodoSummary(todos)
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
    deps.status.scheduleInitialMeasurement(agent)
    // Repaint both task channels (the JobRegistry roster + the subagent
    // catalog): the dock/badge are owner-fenced,
    // and a session switch must not leave the previous session's tasks
    // or subagents on screen until the next registry event.
    deps.surface.refreshTasks()
    deps.surface.refreshAgents()
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
    const sessionRecall = recallHistoryForSession(historyRecords, agent.session.id)
    deps.surface.app.resetInputHistory([...sessionRecall].reverse())
    deps.status.refreshTerminalTitle()
    deps.status.updateWelcomeCard()
    deps.commands.register()
  }


  const mainFolder = (): TranscriptFolder => folder
  const mainStats = (): StatsFolder => statsFolder
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
    mainWindow,
    applyAssistantInput,
    setToolArgs,
    deleteToolArgs,
    toolArgs,
    restoreMainTranscriptAnchor,
    initLiveSession,
    resetForGeneration,
  }
}
