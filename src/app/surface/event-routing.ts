/**
 * The application-level presentation event routing (TS3 §36).
 *
 * This owner holds the routing DECISIONS and fences for the application events
 * the composition zone subscribes to: `session/event` (opening journal, the
 * opening-viewer buffer, viewed-child vs main owner, every
 * same-session/exact-owner/cleanup fence and the per-target apply/paint calls),
 * the assistant-stream neutral input routing, the subagent lifecycle /
 * `agent/status` presentation triggers, the provider/settings refresh routing
 * and the routing-local compaction fold id.
 *
 * It owns NO presentation or application state: the runner-owned facts, the
 * Direct/domain bookkeeping and the presentation TARGETS (the
 * `TranscriptFolder` / `TranscriptWindowController` / stats folders / streaming
 * previews) arrive through the injected `SurfaceEventRoutingSource` bundle, and
 * every cross-owner effect is an injected callback (opening journal, main/child
 * presentation, status, pending input, Task Center refresh, completion
 * notification, repaint). It never owns a `TaskBrowserRuntime`, a `StatusStore`
 * or a `SubmissionController`.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/event-routing
 */

import type { TodoItem, TuiApp } from '../../tui-app.ts'
import type { StreamingToolPreview } from './streaming-tool-preparing.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { TranscriptFolder } from '../../domain/transcript/folder.ts'
import type { TranscriptWindowController } from '../../domain/transcript/window.ts'
import type { PendingInputSnapshot } from '../../runtime/pending-input-reader-port.ts'
import type { SubmissionPresentationItem } from '../submission/presentation.ts'
import type { SubmitLatencyPhase } from '../submission/latency.ts'
import type { ContextMeasureReason } from '../../domain/status/context-measurement.ts'
import {
  busyAfterTurnBoundary,
  contextRefreshKind,
  foldCompactionEvent,
  settleCompactionSurface,
} from './compaction-presentation.ts'
import type { OpeningJournal } from './opening-journal.ts'
import type { AgentLifecycleStatus } from './notification-runtime.ts'

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
  /** The main window controller (live accessor: a session commit swaps it). */
  readonly window: TranscriptWindowController
  /** The main transient streaming-preview map (live accessor). */
  readonly previews: Map<string, StreamingToolPreview>
  /** Apply one event to the main streaming tool-preview projection. */
  applyToolPreview(event: Event): void
  /**
   * F1 (PR5 §3.2): let the recent-performance availability bit follow the
   * SAME fold this sink just mutated. Called by the live ingress after the
   * stats append; the owner decides whether the predicate is now proven and
   * re-derives the status when it flips.
   */
  refreshRecentPerformanceAvailability(): void
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
  /** The child window controller (valid only while the viewer is mounted). */
  readonly window: TranscriptWindowController
  /** The child transient streaming-preview map. */
  readonly previews: Map<string, StreamingToolPreview>
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

/** The presentation intents one main-owner event observation reports (A4-7):
 *  the Direct bookkeeping stays with the runner; the surface routing performs
 *  the refresh calls. */
export interface SurfaceMainEventObservation {
  /** The settled viewed-child id for a `tool/result` (`viewCallToChild`). */
  readonly settledViewChildId?: string
  /** A `subagent*` `tool/call` was observed: the surface routing refreshes the
   *  subagent catalog — the same presentation trigger as `subagent/start|end`. */
  readonly refreshAgents: boolean
}
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
   *  pending-subagent feed and the viewed-child settle map) and REPORT the
   *  presentation intents; the surface routing performs the refresh calls. */
  observeMainEvent(sessionId: string, event: Event): SurfaceMainEventObservation
  /** Append to the opening viewer's child-event buffer when the event belongs
   *  to the open viewer child (the token fence + child match); true when
   *  consumed. */
  appendOpeningViewerEvent(sessionId: string, event: Event): boolean

  // ── presentation targets (runner-owned instances) ───────────────────────
  main(): SurfaceMainPresentation<Event>
  viewedChildId(): string | undefined
  viewedChild(): SurfaceViewedChildPresentation<Event>
  /** The concrete main transcript folder the repaint/search glue reads (the
   *  event APPLICATION stays on the structural sink above). */
  mainFolder(): TranscriptFolder
  /** The concrete viewed-child transcript folder while its viewer is mounted. */
  viewedChildFolder(): TranscriptFolder

  // ── A4-8 pending-input presentation (plan §13.2) ────────────────────────
  /** The active pending subject: the interactive continuable child while its
   *  viewer is mounted, else the live main session; undefined when the surface
   *  has no queue subject. */
  pendingSubjectId(): string | undefined
  /** The semantic pending-input read (`backend.pendingInputReader.snapshot`). */
  pendingSnapshot(sessionId: string): PendingInputSnapshot | undefined
  /** The client-local submission echoes (`submissionPresentation.snapshot`). */
  submissionEchoes(sessionId: string | undefined): readonly SubmissionPresentationItem[] | undefined
  /** One occurrence's content projection as the pane's single-line text. */
  queueTextOf(content: readonly unknown[]): string

  // ── projection/refresh coordination ─────────────────────────────────────
  /** Leave the viewed-child transcript back to the main surface. */
  exitView(): void
  refreshStatusCheap(): void
  refreshStatusAndWelcome(): void
  /** Fold one `goal/change` into the runner's status goal text. */
  applyGoalChange(event: Event): void
  /** The session title one `session/title` event implies. */
  sessionTitleOf(event: Event): string | undefined
  /**
   * M3-4 PR2: extend the LOADED history by one official older page
   * (`PresentationReader.loadOlder`) when the active window has more
   * (bounded reader windows). Returns whether an extension was dispatched;
   * Direct always returns false (the fold already holds the full log).
   */
  extendLoadedHistory(): boolean
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
 * The narrow cross-owner effects the routing bodies invoke; one routing
 * lifetime. Every field is an already-owned callback — the router owns none of
 * the targets behind them.
 */
export interface EventRoutingDeps<Event extends RoutedSessionEvent> {
  /** The injected routing source; throws while routing is not attached. */
  readonly source: () => SurfaceEventRoutingSource<Event>
  readonly mounted: () => TuiApp
  readonly openingJournal: OpeningJournal<Event>
  /** Any current-Session activity re-derives continued-question answerability. */
  readonly reconcileQuestions: () => void
  /** The coalesced Task Center catalog refresh (single-flight + dirty trailing). */
  readonly refreshAgents: () => void
  /** The Task Center runtime-only refresh (never re-lists). */
  readonly refreshAgentRuntimeOnly: () => void
  /** Whether one child id is a member of the cached descendant catalog. */
  readonly hasTaskChild: (childId: string) => boolean
  /** The ONLY completion-controller status feed (the `agent/status` main branch). */
  readonly feedCompletionStatus: (agentId: string, status: AgentLifecycleStatus) => void
  /**
   * The main-Agent pane-progress transition (plan §4.3): a narrow presentation
   * hint, called ONLY for the current main Agent. The surface evidence owner
   * resets the interval's turn evidence on the rising edge and settles the
   * already-captured outcome on the falling edge, then makes ONE terminal
   * commit. The routing emits no terminal bytes and never learns which
   * terminal consumes it.
   */
  readonly setMainAgentProgress: (active: boolean) => void
  /**
   * Open one LIVE main-session turn in the running interval's evidence fold
   * (plan §4.3). Only the routing's structural read arrives here; the interval
   * scope, the turn matching and the outcome classification stay with the
   * surface evidence owner.
   */
  readonly observeMainTurnStart: (turn: number) => void
  /**
   * Close one LIVE main-session turn in the running interval's evidence fold.
   * The `reason.kind` is forwarded verbatim; classification stays with the
   * surface evidence owner.
   */
  readonly observeMainTurnEnd: (turn: number, reasonKind: string) => void
  /**
   * Which adapter OWNS the main-Agent terminal outcome (R1 §5.3, the
   * mutual-exclusion gate): the Direct local durable events, or the Remote
   * Host evidence stream. Exactly ONE of them may write the interval, so the
   * Remote durable ingress keeps feeding the transcript WITHOUT racing the
   * Host evidence for the same terminal fact (STOP-DOUBLE). The value is
   * decided once by the composition root and is immutable for the routing
   * owner's lifetime — never a per-event guess.
   */
  readonly mainProgressAuthority: MainProgressAuthority
  /** The surface pending-input presentation refresh. */
  readonly refreshPendingInput: () => void
  readonly schedulePaint: () => void
  readonly paintNow: () => void
}

/** The application-level presentation event router `createSurfaceRuntime()` consumes. */
export interface EventRoutingRuntime<Event extends RoutedSessionEvent> {
  /** The `session/event` routing owner (plan §16.1). */
  routeSessionEvent(session: { readonly id: string }, event: Event): void
  /** The subagent lifecycle presentation trigger (`subagent/start` / `subagent/end`). */
  routeSubagentLifecycle(): void
  /** The `agent/status` presentation routing. */
  routeAgentStatus(agentId: string, status: AgentLifecycleStatus): void
  /** The provider-topology refresh routing (`llm/adapters-updated`). */
  routeProviderRefresh(): void
  /** The settings-document refresh routing (`settings/document-updated`). */
  routeSettingsRefresh(namespace: string): void
  /** The exact-Agent identity gate for the live assistant-stream ingress. */
  isCurrentAssistantAgent(agent: unknown): boolean
  /** The neutral live-input routing (main target vs the mounted viewed child). */
  applyAssistantInput(input: AssistantLiveInput): void
  /** The resumed-compaction routing (a startup/resume fact, not a session event). */
  applyResumedCompaction(id: string | undefined, active: boolean): void
}

/**
 * Which adapter OWNS the main-Agent terminal outcome (R1 §5.3): the Direct
 * local durable events, or the Remote Host evidence stream. Exactly one of
 * them may write the shared interval. Decided once by the composition root;
 * never a per-event guess.
 */
export type MainProgressAuthority = 'local-events' | 'host-snapshot'

/**
 * The official `turn/start` / `turn/end` payload carries the numeric turn the
 * event opens/closes. This is the structural boundary read; the internal
 * contract above it stays typed.
 */
function sessionTurnOf(data: unknown): number | undefined {
  const turn = (data as { readonly turn?: unknown } | null | undefined)?.turn
  return typeof turn === 'number' ? turn : undefined
}

/** `turn/end.reason.kind` is the merge-extensible turn-end discriminant. */
function sessionTurnEndReasonOf(data: unknown): string | undefined {
  const reason = (data as { readonly reason?: { readonly kind?: unknown } } | null | undefined)?.reason
  return typeof reason?.kind === 'string' ? reason.kind : undefined
}

/**
 * Create the application-level presentation event router. The bodies are the
 * aggregate's original routing bodies verbatim; only the free variables became
 * the injected `source`/callbacks.
 */
export function createEventRouting<Event extends RoutedSessionEvent>(
  options: EventRoutingDeps<Event>,
): EventRoutingRuntime<Event> {
  // The surface-owned compaction fold id (plan §16): which compaction bracket is
  // live for the presentation. Routing state only — the durable fold stays in
  // `compaction-presentation.ts`.
  let compactingId: string | undefined

  const routeSessionEvent = (session: { readonly id: string }, event: Event): void => {
    const source = options.source()
    if (source.isCleanedUp()) return
    if (!source.isAttachedSession(session)) return
    // Opening journals fence presentation only. Runtime bookkeeping must
    // continue to observe the target for selections, approvals, and cleanup.
    const openingTarget = options.openingJournal.isOpening(session.id)
    // The retiring committed Agent remains authoritative until quiesce
    // completes; the published opening target may also emit before commit.
    const mainEvent = session.id === source.currentSessionId() || openingTarget
    let settledViewChildId: string | undefined
    if (mainEvent) {
      const observed = source.observeMainEvent(session.id, event)
      settledViewChildId = observed.settledViewChildId
      // M3-3B continued-question reachability: any activity on the current
      // Session re-derives answerability from the authoritative projection
      // (never from a local timer or the transcript). Mounting only happens
      // when a continued call is actually awaiting an answer.
      options.reconcileQuestions()
      // The subagent tool/call refresh is a surface-owned presentation
      // decision; the runner only reports the intent (A4-7 P2).
      if (observed.refreshAgents) options.refreshAgents()
    }
    const viewedId = source.viewedChildId()
    if (openingTarget && (viewedId === undefined || viewedId !== session.id)) {
      options.openingJournal.record(session.id, event)
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
        options.schedulePaint()
        // The display subject's Session-owned facts all come from the official
        // Session projections, and ANY durable event of the viewed Session can
        // move one of them: `model/selection` + `request/header` (modelSelection),
        // `agent-preset/selected` (agentPreset), `request/context` (context
        // window), usage-bearing `assistant/message`/`assistant/attempt`
        // (tokenUsage/pressure), the `surfaceOp` message/tool-result family
        // (contextPressure/contextBreakdown), `todo/write`/`session/title`/
        // `goal/change`, the permission knobs, the turn/step counters and the
        // child's own compaction. Enumerating that family set proved fragile
        // (three separate projection-moving folds were missed), so the viewed
        // child re-derives its display subject on EVERY durable event — the
        // projections are cache reads, cheap beside the transcript fold applied
        // just above, and both stores keep their content-equality no-notify
        // discipline. Transient assistant-stream frames never reach this durable
        // path at all, so no per-token work is added.
        viewer.refreshFooter()
        if (event.type === 'turn/start' || event.type === 'agent/inbox/spliced') queueMicrotask(() => options.refreshPendingInput())
        if (event.type === 'turn/end') options.paintNow()
        return
      }
      // Any OTHER session's events (the live agent's) keep routing to the
      // main folder below — the viewer never starves the main transcript.
    }
    if (session.id !== ownerSessionId) return
    // Main-Agent turn evidence (plan §4.3, R1 §5.3): the surface owns the
    // interval fold and the outcome classification; the routing forwards ONLY
    // the LIVE main-session turn boundary, after every existing fence above. A
    // viewed child's events returned in the child branch, so viewing a child can
    // never pollute the main evidence — while main events still reach this point
    // while a child is displayed.
    //
    // The MUTUAL-EXCLUSION gate: on the Remote branch the Host evidence stream
    // owns the terminal outcome, so these durable events keep feeding the
    // transcript below WITHOUT touching the local fold — one interval, one
    // authority (STOP-DOUBLE).
    if (options.mainProgressAuthority === 'local-events') {
      if (event.type === 'turn/start') {
        const turn = sessionTurnOf(event.data)
        if (turn !== undefined) options.observeMainTurnStart(turn)
      } else if (event.type === 'turn/end') {
        const turn = sessionTurnOf(event.data)
        const reasonKind = sessionTurnEndReasonOf(event.data)
        if (turn !== undefined && reasonKind !== undefined) options.observeMainTurnEnd(turn, reasonKind)
      }
    }
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
        main.refreshRecentPerformanceAvailability()
        source.exitView()
        return
      }
    }
    main.folder.apply([event])
    main.stats.apply([event])
    // F1 (PR5 §3.2): the appended event may be exactly the sample that
    // completes the recent-performance window — re-answer the availability
    // predicate off the fold that append just updated, so the footer/`/status`
    // stop omitting the recent figures without waiting for a `loadOlder`.
    main.refreshRecentPerformanceAvailability()
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
    if (!isKnob) options.schedulePaint()
    if (event.type === 'todo/write') options.mounted().setTodoSummary((event.data as { readonly todos: readonly TodoItem[] }).todos)
    if (event.type === 'plan/mode') options.mounted().setPlanMode((event.data as { readonly active: boolean }).active)
    if (event.type === 'session/title') options.mounted().setSessionTitle(source.sessionTitleOf(event))
    // A permission switch (command, Shift+Tab, settings panel) lands as
    // knob events between turns: refresh the footer mode badge right away
    // instead of waiting for the next step/turn boundary.
    //
    // While a CHILD viewer is displayed, every durable LIVE-session event must
    // refresh the status too (M3-5 PR1 review R9): the extension's v2
    // live-session snapshot is derived from the same status refresh, and a cheap
    // event such as `step/end` advances the live fold without any other refresh
    // path. With a child mounted that refresh writes the child's store sections
    // (content-equal → no publish), the display-subject presentation and the LIVE
    // legacy slot — it never re-projects the live sections into the child store.
    // The store's content-equality discipline suppresses churn on the extra
    // derives (measure-kind events refresh again through the context path below).
    if (isKnob || viewedId !== undefined) {
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
      queueMicrotask(() => options.refreshPendingInput())
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
        options.paintNow()
        options.refreshPendingInput()
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
      options.mounted().setCompactionPhase('summarizing')
      // Busy while compacting: a single Esc cancels the compaction (pi
      // parity — compaction rides the turn signal).
      options.mounted().setBusy(true)
    }
    if (compacted.phase === 'applying') {
      options.mounted().setCompactionPhase('applying')
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
      settleCompactionSurface(options.mounted(), () => {
        source.markContextDirty()
        source.refreshContextMeasurement('compaction-end')
      }, source.currentWorkingFromLog())
    }
    if (compacted.notify !== undefined) options.mounted().notify(compacted.notify.text, compacted.notify.kind)
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
      options.mounted().setWorking(true)
      options.mounted().setBusy(true)
    } else if (event.type === 'turn/end') {
      options.mounted().setWorking(false)
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
      options.mounted().setBusy(busyAfterTurnBoundary('turn/end', compactingId !== undefined))
      options.paintNow()
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
    // Subagent lifecycle events drive the continuable-children half of the
    // dock badge (they never register jobs). These are CATALOG events:
    // membership/tree may have changed, so they re-list.
    options.refreshAgents()
    queueMicrotask(() => options.refreshPendingInput())
  }

  const routeAgentStatus = (agentId: string, status: AgentLifecycleStatus): void => {
    const source = options.source()
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
      // The main Agent's own running/idle is ALSO the pane-progress fact
      // (plan §4.3): project it BEFORE the completion feed, so a settled
      // transition clears the busy state before the controller may emit its
      // toast — never "busy + Turn complete" for the same transition. The
      // surface evidence owner turns this ONE transition into the single
      // settled commit; the child/stale branch below never calls it.
      options.setMainAgentProgress(status === 'running')
      options.feedCompletionStatus(agentId, status)
      queueMicrotask(() => options.refreshPendingInput())
      return
    }
    if (!options.hasTaskChild(agentId)) return
    options.refreshAgentRuntimeOnly()
    if (source.viewedChildId() === agentId) queueMicrotask(() => options.refreshPendingInput())
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
    const source = options.source()
    if (source.isCleanedUp()) return
    source.refreshStatusAndWelcome()
  }

  const routeSettingsRefresh = (namespace: string): void => {
    const source = options.source()
    if (source.isCleanedUp()) return
    if (namespace === 'llm-pi-ai' || namespace === 'llm-deepseek') {
      source.refreshStatusAndWelcome()
    }
  }

  const isCurrentAssistantAgent = (agent: unknown): boolean => {
    const source = options.source()
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
        queueMicrotask(() => options.refreshPendingInput())
        return true
      }
      return false
    }
    source.setViewedChildAgent(subject)
    source.setViewedQueueAgent(subject)
    queueMicrotask(() => options.refreshPendingInput())
    return true
  }

  const applyAssistantInput = (input: AssistantLiveInput): void => {
    const source = options.source()
    // The preview projection keeps the durable completed-turn guard:
    // a late live chunk for a completed turn is a replay artifact and must
    // not resurrect a preview. The folder/stats folds carry their own
    // gates. A FAILED attempt (abandoned end or a committed `assistant/attempt`
    // settlement) clears the step's tool previews — its deltas never
    // materialized into durable calls.
    const viewedId = source.viewedChildId()
    if (options.openingJournal.isOpening(input.sessionId) && (viewedId === undefined || viewedId !== input.sessionId)) return
    if (viewedId !== undefined && input.sessionId === viewedId) {
      source.applyViewedChildAssistantInput(input)
      options.schedulePaint()
      return
    }
    const sessionId = source.currentSessionId()
    if (sessionId === undefined || input.sessionId !== sessionId) return
    source.applyMainAssistantInput(input, sessionId)
    options.schedulePaint()
  }

  const applyResumedCompaction = (id: string | undefined, active: boolean): void => {
    compactingId = id
    options.mounted().setCompactionPhase(active ? 'summarizing' : 'idle')
    if (active) {
      options.mounted().setBusy(true)
      options.mounted().setWorking(true)
    }
  }

  return {
    routeSessionEvent,
    routeSubagentLifecycle,
    routeAgentStatus,
    routeProviderRefresh,
    routeSettingsRefresh,
    isCurrentAssistantAgent,
    applyAssistantInput,
    applyResumedCompaction,
  }
}
