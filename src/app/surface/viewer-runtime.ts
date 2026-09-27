/**
 * ViewerRuntime (A5b-1, plan §A5b-1): the ONE application owner of the subagent
 * child-transcript viewing lifetime.
 *
 * Ownership:
 *
 * - the mounted viewer's presentation state (the viewed child's transcript
 *   folder, independent window controller, its own stats fold and its live
 *   streaming previews);
 * - the in-flight OPEN token + snapshot→live event buffer (a stale open can
 *   never commit an obsolete child over the current surface);
 * - the exact-Agent display/queue identity of the viewed child (opaque here —
 *   the composition root supplies the in-process Direct facts);
 * - the child's semantic pending-input subject (the queue pane's read);
 * - the auto-pop call map (which pending subagent call opened which child);
 * - the follow-up settlement (restore/fence/notify decision) and the abort
 *   fence that cancels a follow-up which has not reached inbox acceptance.
 *
 * The module is deliberately neutral: it never imports a Host session/agent
 * package and never performs a Host lookup. Every fact that belongs to the
 * official DSH client/session contract (the Session log, the live Agent
 * registry, the semantic `sessionQuery` observation, the official prompt
 * follow-up) arrives through a narrow injected capability, so the Direct
 * adapter stays the only place that maps official semantics onto the current
 * in-process implementation.
 * @module @xmoon76/dsh-pi-tui/app/surface/viewer-runtime
 */

import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import { formatStats, StatsFolder } from '../../stats.ts'
import { childOwnEvents, TranscriptFolder } from '../../transcript.ts'
import { TranscriptWindowController } from '../../transcript-window.ts'
import { applyStreamingToolPreviewEvent } from '../../streaming-tool-preparing.ts'
import { createViewerOpenToken, matchPendingSubagentCall, teardownViewerForSessionSwap } from '../../subagent-viewer.ts'
import {
  resolveSubagentSettleTarget,
  subagentPromptDisposition,
  type SubagentPromptOutcome,
  type SubagentPromptReject,
  type SubagentViewerSubmitRequest,
} from '../../subagent-viewer-submit.ts'
import { usageFromStats } from '../../status/derive-usage.ts'
import { mergeDraft } from '../../steer.ts'
import type { ViewerAccess } from '../../tasks-browser.ts'
import type { StreamingToolPreview } from '../../tui-app.ts'
import type { SurfaceRuntime, SurfaceViewedChildPresentation } from './runtime.ts'
import {
  applyAssistantLiveInput,
  mergeSessionEventCut,
  TRANSCRIPT_WINDOW_STEP,
  TRANSCRIPT_WINDOW_TURNS,
  type SessionPresentationEvent,
} from './session-presentation.ts'

/** The exact-Agent facts the viewer reads from the in-process implementation.
 *  The object stays opaque here: only its session identity and run status are
 *  part of the viewer's contract. */
export interface ViewerChildAgent {
  readonly status: string
  readonly session: {
    readonly id: string
    readonly header: { readonly parentSession?: string }
  }
}

/** One live/cold session snapshot as the viewer reads it (official Session log). */
export interface ViewerChildSession<Event> {
  readonly header: { readonly cwd?: unknown }
  snapshotEvents(): readonly Event[]
}

/** One semantic `sessionQuery` observation of a cold child, caller-owned. */
export interface ViewerChildObservation<Event> {
  readonly events: readonly Event[]
  readonly header: { readonly cwd?: unknown }
  [Symbol.dispose](): void
}

/** The interactive continuable child's queue authority, published to the
 *  Direct composition (the in-process writer/admission owner). */
export interface ViewerQueueAuthority<ChildAgent> {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly agent: ChildAgent
}

/** The viewer's read model: the semantic display subject plus the child's own
 *  presentation folds. Valid only while a viewer is mounted. */
export interface ViewerReadModel {
  readonly id: string
  readonly parentSessionId: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
  readonly activity: 'running' | 'inactive'
  readonly access: ViewerAccess
  readonly cwd: string
  readonly stats: StatsFolder
  readonly folder: TranscriptFolder
  readonly previews: Map<string, StreamingToolPreview>
}

/** The narrow capabilities the viewer consumes. Nothing here is a Host lookup:
 *  the composition root maps each one onto the current in-process owner. */
export interface ViewerRuntimeDeps<Event extends SessionPresentationEvent, ChildAgent extends ViewerChildAgent> {
  /** The mounted surface owner (its `app` is the live TuiApp once mounted). */
  readonly surface: SurfaceRuntime<Event>
  /** True once the runner is disposing: no new viewer work may start. */
  readonly isCleanedUp: () => boolean
  /** The live session that OWNS the surface (`undefined` before the first session). */
  readonly currentSessionId: () => string | undefined
  /** The live parent session id of the current owner (the follow-up's fence). */
  readonly liveParentSessionId: () => string | undefined
  /** The official Session snapshot of one child, or `undefined` when inactive. */
  readonly childSession: (childId: string) => ViewerChildSession<Event> | undefined
  /** The semantic cold-session observation; `undefined` when the seam is absent. */
  readonly observeChild: (childId: string) => Promise<ViewerChildObservation<Event>> | undefined
  /** The exact live Agent of one child, or `undefined` when not mounted. */
  readonly childAgent: (childId: string) => ChildAgent | undefined
  /** The live assistant-stream baseline of one exact Agent (official stream). */
  readonly assistantStreamBaselineFor: (agent: ChildAgent) => readonly AssistantLiveInput[]
  /** Re-derive the footer/status projections after a viewer transition. */
  readonly refreshStatus: () => void
  /** Restore the main transcript's semantic latest/history anchor. */
  readonly restoreMainTranscriptAnchor: () => void
}

/** The subagent viewer as the rest of the application consumes it. */
export interface ViewerRuntime<Event extends SessionPresentationEvent, ChildAgent extends ViewerChildAgent> {
  /** The mounted viewer's read model, or `undefined` when no viewer is open. */
  read(): ViewerReadModel | undefined
  /** Whether a viewer is currently mounted. */
  isViewing(): boolean
  /** The viewed child's presentation target for the surface event routing. */
  presentation(): SurfaceViewedChildPresentation<Event>
  /** Buffer one event for the in-flight open child (false = not its event). */
  appendOpeningEvent(sessionId: string, event: Event): boolean
  /** Enter (or switch to) one child transcript. */
  enterView(
    childId: string,
    label: string | undefined,
    mode: 'one-shot' | 'continuable',
    parentSessionId: string,
    activity: 'running' | 'inactive',
    depth?: number,
  ): Promise<void>
  /** Leave the viewer (single Esc); returns whether one was mounted. */
  exitView(): boolean
  /** The EXACT live Agent object currently owning the viewed session. */
  viewedChildAgent(): object | undefined
  /** Rebind the viewed child's exact Agent (same-session activation rollover). */
  setViewedChildAgent(agent: ChildAgent | undefined): void
  /** Drop the old session's auto-pop state at a generation bump. */
  resetAutoPop(): void
  /** Recompute the queue authority from the current viewer + exact Agent. */
  setViewedQueueAgent(agent: ChildAgent | undefined): void
  /** The currently published interactive-child queue authority (A5b-6): the
   *  composition root reads this late-bound for the Direct queue resolver. */
  viewedQueueAuthority(): ViewerQueueAuthority<ChildAgent> | undefined
  /** The abort fence of the CURRENT viewer session's follow-up (if any). */
  followUpSignal(): AbortSignal | undefined
  /** The semantic pending-input subject (queue pane), viewer-aware. */
  pendingSubjectId(): string | undefined
  /** Record one unsettled subagent delegation for the auto-pop match. */
  noteSubagentCall(callId: string, description: string): void
  /** Settle one subagent call; returns the child its open-viewer map pinned. */
  settleSubagentCall(callId: string): string | undefined
  /** Apply the outcome of one interactive viewer follow-up. */
  settleSubmit(
    request: SubagentViewerSubmitRequest,
    text: string,
    outcome: SubagentPromptOutcome,
    viewerGeneration: number,
  ): void
  /** Apply one transient assistant input to the viewed child's presentation. */
  applyAssistantInput(input: AssistantLiveInput): void
  /** Tear the viewer down at a session-generation bump (unconditional). */
  teardownForSessionSwap(): void
}

/** Create the subagent viewer owner (plan §A5b-1). */
export function createViewerRuntime<Event extends SessionPresentationEvent, ChildAgent extends ViewerChildAgent>(
  deps: ViewerRuntimeDeps<Event, ChildAgent>,
): ViewerRuntime<Event, ChildAgent> {
  // P7d: subagent viewer — while set, the transcript shows another live
  // session's log and Esc returns to the parent session. The target is
  // MODE-AWARE: a continuable child's viewer is INTERACTIVE (the editor
  // submits human prompts through ctx.subagents.prompt), a one-shot
  // child's viewer stays read-only. The parent session id is pinned at
  // open time — follow-ups require the exact live direct parent, and
  // the viewer never guesses it from the current live agent.
  
  let viewing: {
    id: string
    folder: TranscriptFolder
    /** Independent presentation state while browsing the child. */
    window: TranscriptWindowController
    /** The child's OWN event stats (turns/steps/tokens) for the footer. */
    stats: StatsFolder
    parentSessionId: string
    label: string
    mode: 'one-shot' | 'continuable'
    activity: 'running' | 'inactive'
    /** The viewer's surface authority (plan §6.10): mode is the durable
     * semantic, access is what THIS surface may do — a nested descendant
     * is read-only even when continuable. */
    access: ViewerAccess
    /** The child session's workspace ('' when unknown, e.g. a cold child). */
    cwd: string
    /** Live-only preparing rows for this child presentation owner. */
    previews: Map<string, StreamingToolPreview>
    /** The EXACT current Agent object owning the viewed session, rebound on
     * same-session Activation rollover. The live seam's
     * identity fence compares Agent object identity (never a
     * re-derived session id), so a late frame from a retired child agent
     * can never reach the viewer after a replacement. */
    viewAgent?: ChildAgent
  } | undefined

  /** The interactive continuable child's queue authority (A5b-6): the viewer
   *  owns the published slot; the composition root reads it late-bound to
   *  connect the Direct queue resolver to this owner. */
  let queueAuthority: ViewerQueueAuthority<ChildAgent> | undefined

  const setViewedQueueAgent = (agent: ChildAgent | undefined): void => {
    const current = viewing
    if (agent !== undefined
      && current !== undefined
      && current.mode === 'continuable'
      && current.access === 'interactive-direct-child'
      && current.parentSessionId === deps.currentSessionId()
      && agent.session.id === current.id
      && agent.session.header.parentSession === current.parentSessionId) {
      queueAuthority = { parentSessionId: current.parentSessionId, childSessionId: current.id, agent }
      return
    }
    queueAuthority = undefined
  }

  // The queue pane consumes the same active semantic pending-input subject as
  // Ctrl+S: the live main session on the main surface, or the exact
  // interactive continuable child while its viewer is mounted. A child whose
  // authority is unavailable yields an empty pane; it never falls back to the
  // main session's queue. Non-interactive viewers expose no queue subject.
  
  const activePendingSessionId = (): string | undefined => {
    const viewer = viewing
    if (viewer !== undefined) {
      return viewer.mode === 'continuable' && viewer.access === 'interactive-direct-child'
        ? viewer.id
        : undefined
    }
    return deps.liveParentSessionId()
  }

  // Unsettled subagent delegations in the live session, in tool/call order.
  // The viewer matches one of these by description when the user opens a
  // child transcript, so the child's tool/result can pop the viewer back.
  
  const pendingSubagentCalls: { callId: string; description: string }[] = []

  // callId → child session id, established when the user opens a child's
  // transcript (see enterView). Consumed on the matching tool/result.
  
  const viewCallToChild = new Map<string, string>()

  // The search-overlay stale refresh, the navigation presentation and the
  // jump commit are surface-owned (A4-8, plan §17). The matching/stepping
  // algorithms stay in transcript.ts / search-overlay.ts.
  /** Enter the subagent viewer for one session (live or persisted). The
   * target carries the catalog MODE (continuable = interactive editor,
   * one-shot = read-only — never guessed from running/inactive) and the
   * exact direct-parent session id the follow-up write path is pinned
   * to. The open is ASYNC (a cold child's log is read from persistence);
   * a viewer open/close/child switch — or a session swap — that lands
   * while the inspection is in flight invalidates this request (the
   * viewerOpen token), so a slow open can never commit an obsolete child
   * over the current surface (round-4/5 findings). */
  
  const viewerOpen = createViewerOpenToken()

  /** Events for the child are buffered while its cold observation is in flight.
   * The buffer closes the snapshot → live opening gap; the request token fences
   * stale opens so an exited/superseded viewer never retains another child's events. */
  
  let openingViewer: { request: number; childId: string; events: Event[] } | undefined

  /** The CURRENT viewer session's abort source: aborted when the viewer
   * session ends (Esc / child switch / session swap), so an in-flight
   * follow-up that has NOT reached inbox acceptance is cancelled (the
   * rejected send restores the draft into the child's slot). Once a
   * follow-up is accepted the DSH continuation contract hands ownership
   * to the child — the signal no longer matters. */
  
  let viewerSessionAbort: AbortController | undefined

  /** Push the viewed child's OWN identity into the footer (label/mode/
   * activity/cwd + the child's own turns/steps/stats line) — the parent
   * session's status describes a session the user is not looking at.
   * M1: the unified status store follows the same display subject — the
   * view/workspace/usage sections switch to the child's facts. */
  
  const refreshViewerFooter = (): void => {
    if (deps.isCleanedUp() || viewing === undefined) return
    const stats = viewing.stats.snapshot()
    // setViewerFooter projects the display-subject sections (view/
    // workspace/usage) BEFORE its paint — the first frame after
    // entering (or leaving) the viewer already shows the new subject.
    deps.surface.app.setViewerFooter({
      label: viewing.label,
      childSessionId: viewing.id,
      mode: viewing.mode,
      activity: viewing.activity,
      cwd: viewing.cwd,
      turns: stats.turns,
      steps: stats.steps,
      statsLine: formatStats(stats),
      usage: usageFromStats(stats),
    })
  }

  const enterView = async (
    childId: string,
    label: string | undefined,
    mode: 'one-shot' | 'continuable',
    parentSessionId: string,
    activity: 'running' | 'inactive',
    depth = 1,
  ): Promise<void> => {
    if (deps.isCleanedUp()) return
    // Surface authority (plan §6.10): mode is the durable semantic, the
    // access is what THIS surface may do — only a direct (depth 1)
    // continuable child is interactive from the root.
    const access: ViewerAccess = depth > 1
      ? 'readonly-nested'
      : mode === 'one-shot' ? 'readonly-one-shot' : 'interactive-direct-child'
    const request = viewerOpen.open()
    const opening = { request, childId, events: [] as Event[] }
    openingViewer = opening
     try {
    const childFolder = new TranscriptFolder()
    const childWindow = new TranscriptWindowController({
      windowTurns: TRANSCRIPT_WINDOW_TURNS,
      stepTurns: TRANSCRIPT_WINDOW_STEP,
      turns: childFolder.groupedTurns(),
    })
    const childStats = new StatsFolder()
    const childPreviews = new Map<string, StreamingToolPreview>()
    let childCwd = ''
    // Only the child's OWN events enter the viewer: a fork provider seeds
    // the child with the parent's inherited prefix (ending at the
    // session/end-seed boundary plus child-owned repair), and the parent's
    // records — its subagent completion
    // notices included — must never render as the child's transcript.
    const initialChild = deps.childSession(childId)
    let observedEvents: readonly Event[] = initialChild?.snapshotEvents() ?? []
    let observedHeader: { cwd?: unknown } | undefined = initialChild?.header
    if (initialChild !== undefined) {
      observedHeader = initialChild.header
    } else {
      // An inactive child is no longer in the live store; load its log
      // through the semantic session-query seam (the raw persistence
      // fallback is removed legacy on the master baseline).
      const observation = await deps.observeChild(childId)
      if (observation !== undefined) {
        try {
          observedEvents = observation.events
          observedHeader = observation.header
        } finally {
          observation[Symbol.dispose]()
        }
      }
    }
    // If the child cold-resumed while observation was in flight, its live
    // Session snapshot is the authoritative durable cut. Otherwise append
    // only buffered events beyond the observation cut, never replaying a
    // duplicated seq from the snapshot.
    const currentChild = deps.childSession(childId)
    const durableEvents = mergeSessionEventCut(currentChild?.snapshotEvents() ?? observedEvents, opening.events)
    const own = childOwnEvents(durableEvents)
    childFolder.hydrate(own)
    childStats.hydrate(own)
    const header = currentChild?.header ?? observedHeader
    // The live/cold child's session header carries its workspace (the child
    // may have been born in another directory).
    childCwd = typeof header?.cwd === 'string' ? header.cwd : ''
    const childAgent = deps.childAgent(childId)
    let childActivity: 'running' | 'inactive' = childAgent === undefined
      ? activity
      : childAgent.status === 'running' ? 'running' : 'inactive'
    if (childAgent === undefined) {
      for (const event of own) {
        if (event.type === 'turn/start') childActivity = 'running'
        else if (event.type === 'turn/end') childActivity = 'inactive'
      }
    }
    // A live child may already have emitted transient assistant frames before
    // the viewer existed. Replay only the exact Agent's active baseline after
    // durable hydration and before the child surface is mounted.
    if (childAgent !== undefined) {
      for (const input of deps.assistantStreamBaselineFor(childAgent)) {
        applyAssistantLiveInput(childFolder, childStats, childPreviews, input)
      }
    }
    // The user's deliberate look is the anchor for the auto-pop: match the
    // child's durable label (the delegation's description) against the
    // unsettled subagent calls so this child's tool/result can pop the
    // viewer back. Duplicate labels take the MOST RECENT call (the one the
    // user is most likely watching); an empty/absent label falls back to a
    // lone pending call, and no match simply disables the auto-pop (the
    // user exits with Esc as before).
    //
    // STALE-OPEN GUARD: while the inspection above was in flight the user
    // may have exited, switched children, or swapped sessions — every one
    // of those invalidates the viewerOpen token. A stale request must not
    // commit its child over the current surface (no viewing write, no
    // repaint, no viewer mount, no auto-pop match).
    if (deps.isCleanedUp() || !viewerOpen.isCurrent(request)) {
      if (openingViewer === opening) openingViewer = undefined
      return
    }
    openingViewer = undefined
    // The viewer replaces the main transcript presentation owner, but the
    // main session's live preview state continues updating off-screen.
    const matched = matchPendingSubagentCall(pendingSubagentCalls, label)
    if (matched !== undefined) viewCallToChild.set(matched.callId, childId)
    viewerSessionAbort = new AbortController()
    viewing = {
      id: childId,
      folder: childFolder,
      window: childWindow,
      stats: childStats,
      parentSessionId,
      label: label ?? childId,
      mode,
      activity: childActivity,
      access,
      cwd: childCwd,
      previews: childPreviews,
      ...(childAgent === undefined ? {} : { viewAgent: childAgent }),
    }
    // The child's turn numbers are its OWN namespace: the parent's Focus
    // disclosures must not leak into the child transcript (plan §26).
    setViewedQueueAgent(childAgent)
    deps.surface.app.enterFocusViewerScope()
    deps.surface.repaint()
    // The viewer bar covers the editor (a read-only placeholder for
    // one-shot, the child's own draft for continuable) and the header
    // badges the mode — the transient notify is no longer the only "you
    // are elsewhere" signal. The FOOTER switches to the child's own
    // identity at the same time.
    deps.surface.app.setViewerMode({ parentSessionId, childSessionId: childId, label: label ?? childId, mode, activity: childActivity, access })
    // The queue pane follows the child only after the viewer and its exact
    // queue authority are both published.
    deps.surface.refreshPendingInput()

     } finally {
       if (openingViewer === opening) openingViewer = undefined
     }
    refreshViewerFooter()
  }

  /** Leave the subagent viewer (single Esc). Returns whether it exited.
   * Invalidates any in-flight viewer OPEN UNCONDITIONALLY — an Esc (or a
   * session swap, which routes through this) must prevent a slow
   * transcript inspection from reopening the viewer afterwards, even when
   * no viewer is currently mounted (the open is still in flight). */
  
  const exitView = (): boolean => {
    viewerOpen.invalidate()
    openingViewer = undefined
    if (viewing === undefined) return false
    const previousViewing = viewing
    previousViewing.previews.clear()
    viewing = undefined
    queueAuthority = undefined
    viewerSessionAbort?.abort() // cancel an in-flight, not-yet-accepted follow-up
    viewerSessionAbort = undefined
    deps.surface.app.clearLocalMessages()
    deps.surface.app.clearNotify() // a viewer notify (if any) is stale now
    deps.surface.app.setViewerMode(undefined)
    // setViewerFooter(undefined) returns the display subject to main
    // (projected BEFORE its paint); the parent's facts follow on the
    // refreshStatus below.
    deps.surface.app.setViewerFooter(undefined)
    // Restore the parent's Focus disclosures BEFORE the repaint so the
    // projection uses them (plan §26).
    deps.surface.app.exitFocusViewerScope()
    deps.surface.repaint()
    // The main transcript may have grown while the viewer covered it (the
    // child's result, the parent's streaming): restore the parent's semantic latest/history position
    // so the pop never loses an intentional history anchor.
    deps.restoreMainTranscriptAnchor()
    deps.refreshStatus()
    deps.surface.refreshPendingInput()
    return true
  }

  const viewedChildPresentation = {
    get id() { return viewing!.id },
    get folder() { return viewing!.folder },
    get stats() { return viewing!.stats },
    get window() { return viewing!.window },
    get previews() { return viewing!.previews },
    applyToolPreview: (event: Event) => applyStreamingToolPreviewEvent(viewing!.previews, event),
    beginTurn: () => {
      const target = viewing!
      target.activity = 'running'
      // A cold child or same-session rollover becomes queue-authorized
      // at its lifecycle boundary, before the first assistant frame.
      const current = deps.childAgent(target.id)
      target.viewAgent = current
      setViewedQueueAgent(current)
    },
    endTurn: () => { viewing!.activity = 'inactive' },
    refreshFooter: () => refreshViewerFooter(),
  }

  /**
   * One follow-up send settled (plan §10/§11/§12):
   * - ACCEPTED: the child inbox owns the message — never restore the
   *   draft, never insert a fake transcript row; the child's OWN session
   *   events update the viewer transcript through the normal folding.
   *   Only a transient `sent` notice is shown, and only while the SAME
   *   child is still being viewed.
   * - REJECTED: the user's text must NEVER be lost. It is restored into
   *   the CHILD's own draft slot, merged with whatever the user typed
   *   while the request was in flight. The current surface is touched
   *   ONLY while the same child is still being viewed — a viewer
   *   closed/switched during the send restores into the OLD child's
   *   slot and never pollutes the new surface (the generation guard).
   */
  
  const settleSubagentSubmit = (
    request: SubagentViewerSubmitRequest,
    text: string,
    outcome: SubagentPromptOutcome,
    viewerGeneration: number,
  ): void => {
    if (deps.isCleanedUp()) return
    // The viewer target is CURRENT only while the SAME child is still
    // being viewed AND the viewer generation is unchanged (a viewer
    // open/close/switch bumps it — a close → reopen of the SAME child
    // is therefore STALE) AND the parent session is still the one the
    // viewer was opened from. The shared pure decision keeps the
    // current/stale split unit-testable (test/subagent-viewer-submit).
    const settleTarget = resolveSubagentSettleTarget(request, {
      viewingChildId: viewing?.id,
      viewingLabel: viewing?.label,
      viewingParentSessionId: viewing?.parentSessionId,
      viewerGenerationAtSend: viewerGeneration,
      viewerGenerationNow: deps.surface.app.getViewerGeneration(),
      liveParentSessionId: deps.liveParentSessionId(),
    })
    const disposition = subagentPromptDisposition(outcome)
    if (disposition.kind === 'sent') {
      if (settleTarget.kind === 'current') {
        deps.surface.app.notify(request.delivery === 'steer'
          ? `sent to ${settleTarget.label} — steered into the current turn`
          : `sent to ${settleTarget.label} — queued for the next turn`, 'info')
      }
      return
    }
    if (disposition.kind === 'uncertain') {
      // The message may already own the child. Never restore it as an
      // unsent draft or claim it was not delivered; the child's
      // authoritative state decides. No automatic replay.
      if (settleTarget.kind === 'current') {
        deps.surface.app.notify(`send to ${settleTarget.label} is unconfirmed — do not retry automatically`, 'error')
      }
      return
    }
    if (disposition.kind === 'cancelled') {
      // Aborted before inbox acceptance: the message never entered the
      // child's inbox — restore. Current viewer session: visible merge;
      // stale viewer (closed/switched/reopened): map-only (never the
      // current surface).
      if (settleTarget.kind === 'current') {
        deps.surface.app.setEditorText(mergeDraft(deps.surface.app.getDraft(), text))
      } else {
        deps.surface.app.restoreSubagentDraft(request.childSessionId, text)
      }
      return
    }
    if (settleTarget.kind === 'stale') {
      deps.surface.app.restoreSubagentDraft(request.childSessionId, text)
      return
    }
    deps.surface.app.setEditorText(mergeDraft(deps.surface.app.getDraft(), text))
    deps.surface.app.notify(subagentPromptNotice(disposition.reason, settleTarget.label), 'error')
  }

  /** The user-facing reason for a rejected follow-up (plan §18). */
  
  const subagentPromptNotice = (reason: SubagentPromptReject, label: string): string => {
    switch (reason.kind) {
      case 'parent-unavailable': return 'Cannot send: parent session is no longer active'
      case 'stale-child': return 'Cannot continue this subagent'
      case 'unauthorized': return 'Cannot send: subagent ownership changed'
      case 'unavailable': return 'Subagent continuation is temporarily unavailable'
      case 'error': return `could not send to ${label}: ${reason.message}`
      case 'cancelled': return 'send cancelled — draft restored'
    }
  }


  /** Whether a viewer is currently mounted. */
  const isViewing = (): boolean => viewing !== undefined

  const read = (): ViewerReadModel | undefined => {
    const current = viewing
    if (current === undefined) return undefined
    return {
      id: current.id,
      parentSessionId: current.parentSessionId,
      label: current.label,
      mode: current.mode,
      activity: current.activity,
      access: current.access,
      cwd: current.cwd,
      stats: current.stats,
      folder: current.folder,
      previews: current.previews,
    }
  }

  const presentation = (): SurfaceViewedChildPresentation<Event> => viewedChildPresentation

  const appendOpeningEvent = (sessionId: string, event: Event): boolean => {
    const opening = openingViewer
    if (opening !== undefined && viewerOpen.isCurrent(opening.request) && sessionId === opening.childId) {
      opening.events.push(event)
      return true
    }
    return false
  }

  const viewedChildAgent = (): object | undefined => viewing?.viewAgent

  const resetAutoPop = (): void => {
    // The new session's subagent delegations are a fresh namespace: stale
    // pending calls from the old session would consume viewer match slots,
    // and dead callId→child maps would silently disable the auto-pop.
    pendingSubagentCalls.length = 0
    viewCallToChild.clear()
  }

  const followUpSignal = (): AbortSignal | undefined => viewerSessionAbort?.signal

  const pendingSubjectId = (): string | undefined => activePendingSessionId()

  const noteSubagentCall = (callId: string, description: string): void => {
    pendingSubagentCalls.push({ callId, description })
  }

  const settleSubagentCall = (callId: string): string | undefined => {
    const callIndex = pendingSubagentCalls.findIndex(call => call.callId === callId)
    if (callIndex !== -1) pendingSubagentCalls.splice(callIndex, 1)
    const settledViewChildId = viewCallToChild.get(callId)
    viewCallToChild.delete(callId)
    return settledViewChildId
  }

  const applyAssistantInput = (input: AssistantLiveInput): void => {
    const target = viewing
    if (target === undefined) return
    applyAssistantLiveInput(target.folder, target.stats, target.previews, input)
  }

  /**
   * Tear the subagent viewer down at a session swap. UNCONDITIONAL: an open may
   * still be loading when nothing is mounted, and the swap must still cancel it.
   * The old viewer's parent session is gone (the continuation contract requires
   * the EXACT live parent), so the child transcript, the viewer editor and the
   * per-child drafts must not leak into the new session. The MAIN draft (the
   * user's unsent text) restores into the new session's editor — cross-session
   * draft retention is the existing behavior.
   */
  const teardownForSessionSwap = (): void => {
    teardownViewerForSessionSwap(viewerOpen, viewing !== undefined, () => {
      openingViewer = undefined
      viewing = undefined
      queueAuthority = undefined
      viewerSessionAbort?.abort()
      viewerSessionAbort = undefined
      deps.surface.app.clearLocalMessages()
      deps.surface.app.clearNotify()
      deps.surface.app.setViewerMode(undefined)
      // setViewerFooter(undefined) returns the display subject to main
      // (projected BEFORE its paint).
      deps.surface.app.setViewerFooter(undefined)
      // Session swap: the OLD parent session is gone — its parked Focus
      // disclosures must be DISCARDED, never restored into the new session
      // (clearSessionOverrides already dropped the stack; this keeps the
      // teardown's intent explicit and ordering-safe). The Esc path uses
      // exitFocusViewerScope instead (restore).
      deps.surface.app.discardFocusViewerScope()
      deps.surface.repaint()
      deps.restoreMainTranscriptAnchor()
      // The new session's own measurement comes from its initLiveSession
      // deferred path — the teardown refresh is UI-only.
      deps.refreshStatus()
    })
  }

  return {
    read,
    presentation,
    appendOpeningEvent,
    enterView,
    exitView,
    viewedChildAgent,
    setViewedChildAgent: (agent) => { if (viewing !== undefined) viewing.viewAgent = agent },
    resetAutoPop,
    setViewedQueueAgent,
    viewedQueueAuthority: () => queueAuthority,
    followUpSignal,
    pendingSubjectId,
    noteSubagentCall,
    settleSubagentCall,
    settleSubmit: settleSubagentSubmit,
    applyAssistantInput,
    teardownForSessionSwap,
    isViewing,
  }
}
