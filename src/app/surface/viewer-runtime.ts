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
 * - the exact child writer-subject token of the viewed child (opaque here —
 *   the selected child-view source supplies the Direct Agent identity, the
 *   Remote branch its own viewer-owned token);
 * - the child's semantic pending-input subject (the queue pane's read);
 * - the auto-pop call map (which pending subagent call opened which child);
 * - the follow-up settlement (restore/fence/notify decision) and the abort
 *   fence that cancels a follow-up which has not reached inbox acceptance;
 * - the child live ingress handle (Remote), disposed BEFORE the child view
 *   handle is released.
 *
 * The module is deliberately neutral: it never imports a Host session/agent
 * package and never performs a Host lookup. Everything backend-specific — the
 * child view acquisition/hydration, its live updates, its paging and its
 * durable image reads — arrives through the injected {@link ViewerChildSource},
 * whose Direct and Remote implementations are the only places that map the
 * official semantics onto a backend.
 * @module @xmoon76/dsh-pi-tui/app/surface/viewer-runtime
 */

import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import { runSyncDisposalSteps } from '../../disposal.ts'
import { StatsFolder } from '../../stats.ts'
import { childOwnEvents, TranscriptFolder } from '../../domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../domain/transcript/window.ts'
import { applyStreamingToolPreviewEvent } from '../../streaming-tool-preparing.ts'
import { createViewerOpenToken, matchPendingSubagentCall, teardownViewerForSessionSwap } from '../../subagent-viewer.ts'
import {
  resolveSubagentSettleTarget,
  subagentPromptDisposition,
  type SubagentPromptOutcome,
  type SubagentPromptReject,
  type SubagentViewerSubmitRequest,
} from '../../subagent-viewer-submit.ts'
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

/**
 * One child view's hydrated snapshot as the viewer folds it. `durableEvents`
 * is the child's OWN durable cut at read time; `liveInputs` are the transient
 * assistant frames that were already reflected in that read (the Remote
 * read-side partition baseline) and must be replayed after the durable fold.
 */
export interface ViewerChildSnapshot<Event> {
  readonly durableEvents: readonly Event[]
  readonly liveInputs: readonly AssistantLiveInput[]
  readonly activity: 'running' | 'inactive'
  readonly cwd: string
  readonly revision: number | undefined
}

/** The live sinks one child view publishes into the mounted viewer. */
export interface ViewerChildLiveSinks<Event> {
  onDurableEvent(event: Event): void
  onLiveInput(input: AssistantLiveInput): void
  onWindowReplaced(): void
  onWindowPrepended(): void
  onSessionSnapshotChanged(): void
  onProjectionsChanged(): void
}

/**
 * The exact writer-subject identity that admitted a queue gesture: its only
 * contract is the Session identity the write addresses. Direct supplies the
 * exact child Agent object (identity comparison against the live registry);
 * Remote supplies its own viewer-owned token — never a fabricated Agent.
 */
export interface ViewerQueueSubject {
  readonly session: { readonly id: string }
}

/**
 * One acquired child view. The handle owns the child's Client generation (or
 * its Direct live/cold session read) until {@link release}, which is
 * idempotent; the viewer disposes any live subscription BEFORE releasing it.
 */
export interface ViewerChildView<Event> {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly snapshot: ViewerChildSnapshot<Event>
  /** The exact Direct child Agent identity for the assistant-stream fence;
   *  absent on a backend without an Agent identity (Remote). */
  readonly viewAgent?: object
  /** Re-read the authoritative window (window replace / older-history prepend). */
  rehydrate(): Promise<ViewerChildSnapshot<Event> | undefined>
  /** Extend the window with one official older page. */
  loadOlder(): Promise<void>
  /** The child's CURRENT activity as the selected backend reads it (Direct: the
   *  Agent registry; Remote: the retained binding's official `running` bit). */
  currentActivity(): 'running' | 'inactive'
  /** Subscribe this exact child generation's live updates (Direct: undefined —
   *  the Host firehose already routes the viewed child). */
  subscribe(sinks: ViewerChildLiveSinks<Event>): { dispose(): void } | undefined
  /** Release the child's lifetime exactly once; idempotent. */
  release(): void
}

/** One viewer open request: the exact durable target + its cancellation. */
export interface ViewerChildOpenTarget {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'one-shot' | 'continuable'
  /** The catalog-projected activity the viewer opened from (the Direct
   *  fallback when no live child Agent can answer). */
  readonly activity: 'running' | 'inactive'
  /** Aborted when the open is superseded (viewer exit/switch/swap). */
  readonly signal: AbortSignal
}

/**
 * The selected backend's child-view source (plan D1): Direct acquires the
 * live/cold Session read, Remote retains the exact `SubagentAddress`
 * generation and hydrates through the shared presentation reader. It never
 * forks the viewer state machine.
 */
export interface ViewerChildSource<Event> {
  /** Acquire + hydrate one child view. Returns `undefined` only when the
   *  request was superseded (the caller commits nothing, silently); a real
   *  open/read failure THROWS. */
  open(target: ViewerChildOpenTarget): Promise<ViewerChildView<Event> | undefined>
  /** The EXACT live child writer-subject identity, or `undefined` when the
   *  backend has no Agent-bound subject for this child (Remote). Direct
   *  returns the exact live child Agent object. */
  childWriterSubject(childId: string): ViewerQueueSubject | undefined
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

/** The interactive continuable child's queue authority, published to the
 *  selected composition (the writer/admission owner). */
export interface ViewerQueueAuthority {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly subject: ViewerQueueSubject
}

/** The narrow capabilities the viewer consumes. Nothing here is a Host lookup:
 *  the composition root maps each one onto the selected backend owner. */
export interface ViewerRuntimeDeps<Event extends SessionPresentationEvent> {
  /** The mounted surface owner (its `app` is the live TuiApp once mounted). */
  readonly surface: SurfaceRuntime<Event>
  /** True once the runner is disposing: no new viewer work may start. */
  readonly isCleanedUp: () => boolean
  /** The live session that OWNS the surface (`undefined` before the first session). */
  readonly currentSessionId: () => string | undefined
  /** The live parent session id of the current owner (the follow-up's fence). */
  readonly liveParentSessionId: () => string | undefined
  /** The selected backend's child-view acquisition/hydration source. */
  readonly childView: ViewerChildSource<Event>
  /** Re-derive the footer/status projections after a viewer transition. */
  readonly refreshStatus: () => void
  /** Restore the main transcript's semantic latest/history anchor. */
  readonly restoreMainTranscriptAnchor: () => void
  /** Start one detached viewer-owned async flow (the runner's ownership
   *  model: a bare fire-and-forget promise is forbidden). */
  readonly runDetached: (label: string, task: () => Promise<void>) => void
}

/** The subagent viewer as the rest of the application consumes it. */
export interface ViewerRuntime<Event extends SessionPresentationEvent> {
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
  setViewedChildAgent(agent: object | undefined): void
  /** Drop the old session's auto-pop state at a generation bump. */
  resetAutoPop(): void
  /** Recompute the queue authority from the current viewer + exact subject. */
  setViewedQueueAgent(subject: object | undefined): void
  /** The currently published interactive-child queue authority: the
   *  composition root reads this late-bound for the queue resolver. */
  viewedQueueAuthority(): ViewerQueueAuthority | undefined
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
  /** Re-fold the viewed child from its authoritative window (window replace /
   *  older-history prepend / PageUp extension). No-op without a viewer. */
  rehydrateViewedChild(): Promise<void>
  /** Extend the viewed child's window with one official older page. */
  extendViewedChildHistory(): Promise<void>
  /** Tear the viewer down at a session-generation bump (unconditional). */
  teardownForSessionSwap(): void
  /**
   * Final teardown at surface/runner disposal (NO painting). Cancels an
   * in-flight open and drops a mounted viewer's live ingress + child
   * generation exactly once, so a dying surface never keeps a Client child
   * generation (or its ingress) alive past the adapter/Client disposal order.
   */
  dispose(): void
}

/** Create the subagent viewer owner (plan §A5b-1). */
export function createViewerRuntime<Event extends SessionPresentationEvent>(
  deps: ViewerRuntimeDeps<Event>,
): ViewerRuntime<Event> {
  // P7d: subagent viewer — while set, the transcript shows another live
  // session's log and Esc returns to the parent session. The target is
  // MODE-AWARE: a continuable child's viewer is INTERACTIVE (the editor
  // submits human prompts through the child prompt authority), a one-shot
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
    viewAgent?: object
  } | undefined

  /** The acquired child view handle: the ONE lifetime owner of the child's
   *  Client generation (Remote) or live/cold session read (Direct). */
  let viewHandle: ViewerChildView<Event> | undefined
  /** The child live-ingress handle (Remote); Direct needs none. */
  let viewLiveDispose: { dispose(): void } | undefined
  /**
   * The IN-FLIGHT open's cancellation: a Remote open has already retained its
   * `tuiChildView` generation while it awaits the reference's open/read, so
   * every supersession/end path MUST abort it instead of only invalidating the
   * request token — otherwise an unsettled stale open keeps the child
   * generation alive (the source releases on abort).
   */
  let openingAbort: AbortController | undefined

  /** The interactive continuable child's queue authority: the viewer owns the
   *  published slot; the selected composition reads it late-bound. */
  let queueAuthority: ViewerQueueAuthority | undefined

  /** Publish (or clear) the child queue authority from one exact subject: only
   *  an interactive direct child of the CURRENT main owner exposes a queue. */
  const publishQueueSubject = (subject: ViewerQueueSubject | undefined): void => {
    const current = viewing
    if (subject === undefined
      || current === undefined
      || current.mode !== 'continuable'
      || current.access !== 'interactive-direct-child'
      || current.parentSessionId !== deps.currentSessionId()
      || subject.session.id !== current.id) {
      queueAuthority = undefined
      return
    }
    queueAuthority = { parentSessionId: current.parentSessionId, childSessionId: current.id, subject }
  }

  const setViewedQueueAgent = (subject: object | undefined): void => {
    publishQueueSubject(subject as ViewerQueueSubject | undefined)
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
   * to. The open is ASYNC (the selected child-view source acquires and
   * hydrates the child); a viewer open/close/child switch — or a session
   * swap — that lands while the open is in flight invalidates this request
   * (the viewerOpen token + the open signal), so a slow open can never
   * commit an obsolete child over the current surface (round-4/5 findings). */

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

  /** Enter the subagent viewer for one session (live or persisted). M3-5 PR1
   * §9.7: the viewer publishes the viewed IDENTITY only — `StatusRuntime`
   * resolves the child's own `SessionStatus(childId)` and commits the whole
   * display-subject projection (view + Session-owned sections) in ONE
   * StatusStore update; the viewer fabricates no Session-owned status fact. */
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
    // A new open supersedes any previous in-flight one: its retained child
    // generation must be released NOW, not when (if ever) it settles.
    openingAbort?.abort()
    const openController = new AbortController()
    openingAbort = openController
    let acquired: ViewerChildView<Event> | undefined
    try {
      acquired = await deps.childView.open({
        parentSessionId,
        childSessionId: childId,
        mode,
        activity,
        signal: openController.signal,
      })
      // A superseded open commits nothing; nothing was acquired.
      if (acquired === undefined) return
      const view = acquired
      // Only the child's OWN events enter the viewer: a fork provider seeds
      // the child with the parent's inherited prefix (ending at the
      // session/end-seed boundary plus child-owned repair), and the parent's
      // records — its subagent completion notices included — must never render
      // as the child's transcript. The opening buffer closes the Direct
      // snapshot → live gap; on Remote the source's snapshot is already an
      // authoritative window and the buffer stays empty.
      const durableEvents = mergeSessionEventCut(view.snapshot.durableEvents, opening.events)
      const own = childOwnEvents(durableEvents)
      const childFolder = new TranscriptFolder()
      childFolder.hydrate(own)
      const childStats = new StatsFolder()
      childStats.hydrate(own)
      const childPreviews = new Map<string, StreamingToolPreview>()
      // A live child may already have emitted transient assistant frames before
      // the viewer existed. Replay the read-side transient baseline after
      // durable hydration and before the child surface is mounted.
      for (const input of view.snapshot.liveInputs) {
        applyAssistantLiveInput(childFolder, childStats, childPreviews, input)
      }
      const childWindow = new TranscriptWindowController({
        windowTurns: TRANSCRIPT_WINDOW_TURNS,
        stepTurns: TRANSCRIPT_WINDOW_STEP,
        turns: childFolder.groupedTurns(),
      })
      // STALE-OPEN GUARD: while the acquisition/hydration above was in flight
      // the user may have exited, switched children, or swapped sessions —
      // every one of those invalidates the viewerOpen token. A stale request
      // must not commit its child over the current surface (no viewing write,
      // no repaint, no viewer mount, no auto-pop match); the acquired handle is
      // released in the `finally` below.
      if (deps.isCleanedUp() || !viewerOpen.isCurrent(request)) return
      openingViewer = undefined
      // SWITCH GUARD: entering a child while another viewer is mounted replaces
      // it. The replaced viewer's retained child generation (Remote), its live
      // ingress and its in-flight follow-up must be released HERE — a stale open
      // returning early above never tears the mounted viewer down.
      if (viewing !== undefined) {
        viewerSessionAbort?.abort()
        viewerSessionAbort = undefined
        viewing = undefined
        queueAuthority = undefined
        releaseViewHandle()
      }
      // The user's deliberate look is the anchor for the auto-pop: match the
      // child's durable label (the delegation's description) against the
      // unsettled subagent calls so this child's tool/result can pop the
      // viewer back. Duplicate labels take the MOST RECENT call (the one the
      // user is most likely watching); an empty/absent label falls back to a
      // lone pending call, and no match simply disables the auto-pop (the
      // user exits with Esc as before).
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
        activity: view.snapshot.activity,
        access,
        cwd: view.snapshot.cwd,
        previews: childPreviews,
        ...(view.viewAgent === undefined ? {} : { viewAgent: view.viewAgent }),
      }
      // The child's turn numbers are its OWN namespace: the parent's Focus
      // disclosures must not leak into the child transcript (plan §26).
      viewHandle = view
      acquired = undefined
      publishQueueSubject(view.viewAgent === undefined
        // Remote: the viewer owns one stable writer-subject token for the whole
        // viewer session (no fabricated Agent object).
        ? Object.freeze({ session: Object.freeze({ id: childId }) })
        : (view.viewAgent as ViewerQueueSubject))
      // The child live ingress is installed AFTER the hydrated commit, fenced by
      // the exact child generation inside the source (Remote); Direct returns no
      // handle because the Host firehose already routes the viewed child.
      viewLiveDispose = view.subscribe({
        onDurableEvent: (event) => {
          if (viewing === undefined || viewing.id !== childId) return
          deps.surface.routeSessionEvent({ id: childId }, event)
        },
        onLiveInput: (input) => {
          if (viewing === undefined || viewing.id !== childId) return
          const target = viewing
          applyAssistantLiveInput(target.folder, target.stats, target.previews, input)
          deps.surface.repaint()
        },
        onWindowReplaced: () => {
          if (viewing === undefined || viewing.id !== childId) return
          runDetachedViewerRehydrate()
        },
        onWindowPrepended: () => {
          if (viewing === undefined || viewing.id !== childId) return
          runDetachedViewerRehydrate()
        },
        onSessionSnapshotChanged: () => {
          const target = viewing
          const handle = viewHandle
          if (target === undefined || target.id !== childId || handle === undefined) return
          // The official snapshot channel carries the child's `running` flip. The
          // viewer's own activity AND the committed display subject must both
          // follow the CURRENT fact: `read().activity` drives the composer's
          // queue-vs-steer decision, while the footer/status renders
          // `view.subject.activity` from the PR1 display-subject projection — so a
          // flip with no projection/durable event in between must still re-derive
          // the subject status, or the visible `running`/`inactive` line keeps the
          // stale value. The pending pane re-joins in the same step.
          target.activity = handle.currentActivity()
          deps.refreshStatus()
          deps.surface.refreshPendingInput()
        },
        onProjectionsChanged: () => {
          if (viewing === undefined || viewing.id !== childId) return
          deps.refreshStatus()
        },
      })
      deps.surface.app.enterFocusViewerScope()
      deps.surface.repaint()
      // The viewer bar covers the editor (a read-only placeholder for
      // one-shot, the child's own draft for continuable) and the header
      // badges the mode — the transient notify is no longer the only "you
      // are elsewhere" signal.
      deps.surface.app.setViewerMode({ parentSessionId, childSessionId: childId, label: label ?? childId, mode, activity: view.snapshot.activity, access })
      // M3-5 PR1 §9.7: the display-subject commit. StatusRuntime selects THIS
      // child as the display subject and publishes the child's own
      // SessionStatus facts (view/composition/access/workspace/usage) in ONE
      // StatusStore update — before the first frame of the new subject can be
      // painted (the enter is synchronous from `viewing =` onward).
      deps.refreshStatus()
      // The queue pane follows the child only after the viewer and its exact
      // queue authority are both published.
      deps.surface.refreshPendingInput()
    } finally {
      if (openingViewer === opening) openingViewer = undefined
      if (openingAbort === openController) openingAbort = undefined
      // A stale/failed open releases everything it acquired; the mounted
      // surface is untouched.
      acquired?.release()
    }
  }

  /**
   * Release the acquired child handle (idempotent) after its ingress is down.
   * BOTH slots are retired before either callback runs (the plan's D2 reentrancy
   * form), so a throwing ingress disposer can never skip the retained binding
   * release nor re-run on a second disposal; the collected failure is surfaced
   * after both attempts.
   */
  const releaseViewHandle = (): void => {
    const handle = viewHandle
    const live = viewLiveDispose
    viewHandle = undefined
    viewLiveDispose = undefined
    runSyncDisposalSteps('viewer child release', [
      () => live?.dispose(),
      () => handle?.release(),
    ])
  }

  /** Re-fold the viewed child from the current authoritative window. The
   * runner's detached ownership wrapper owns failure reporting; every commit
   * re-checks the exact viewer identity. */
  const runDetachedViewerRehydrate = (): void => {
    deps.runDetached('viewer child re-hydration', () => rehydrateViewedChild())
  }

  const rehydrateViewedChild = async (): Promise<void> => {
    const target = viewing
    const handle = viewHandle
    if (target === undefined || handle === undefined) return
    if (deps.isCleanedUp()) return
    const snapshot = await handle.rehydrate()
    if (snapshot === undefined) return
    // The viewer may have exited/switched while the re-read was in flight.
    if (deps.isCleanedUp() || viewing !== target || viewHandle !== handle) return
    const own = childOwnEvents(snapshot.durableEvents)
    const folder = new TranscriptFolder()
    folder.hydrate(own)
    const stats = new StatsFolder()
    stats.hydrate(own)
    target.folder = folder
    target.window.setTurns(folder.groupedTurns())
    target.stats = stats
    for (const input of snapshot.liveInputs) {
      applyAssistantLiveInput(target.folder, target.stats, target.previews, input)
    }
    target.cwd = snapshot.cwd
    target.activity = snapshot.activity
    deps.refreshStatus()
    deps.surface.repaint()
  }

  /** Page one official older window into the viewed child, then re-fold. */
  const extendViewedChildHistory = async (): Promise<void> => {
    const target = viewing
    const handle = viewHandle
    if (target === undefined || handle === undefined || deps.isCleanedUp()) return
    await handle.loadOlder()
    if (deps.isCleanedUp() || viewing !== target) return
    await rehydrateViewedChild()
  }

  /** Leave the subagent viewer (single Esc). Returns whether it exited.
   * Invalidates any in-flight viewer OPEN UNCONDITIONALLY — an Esc (or a
   * session swap, which routes through this) must prevent a slow
   * transcript inspection from reopening the viewer afterwards, even when
   * no viewer is currently mounted (the open is still in flight). */

  const exitView = (): boolean => {
    viewerOpen.invalidate()
    openingViewer = undefined
    // Cancel an in-flight open even when nothing is mounted: its retained
    // child generation must be released immediately.
    openingAbort?.abort()
    openingAbort = undefined
    if (viewing === undefined) {
      releaseViewHandle()
      return false
    }
    const previousViewing = viewing
    previousViewing.previews.clear()
    viewing = undefined
    queueAuthority = undefined
    viewerSessionAbort?.abort() // cancel an in-flight, not-yet-accepted follow-up
    viewerSessionAbort = undefined
    // Dispose the child ingress BEFORE releasing the child handle: a
    // synchronous teardown effect must not repaint the dead viewer.
    releaseViewHandle()
    deps.surface.app.clearLocalMessages()
    deps.surface.app.clearNotify() // a viewer notify (if any) is stale now
    deps.surface.app.setViewerMode(undefined)
    // M3-5 PR1 §9.7: the display subject returns to MAIN. StatusRuntime
    // re-derives the main Session's own facts and commits the whole
    // return-to-main projection (view + Session-owned sections) in ONE
    // synchronous StatusStore update, before the repaint below.
    deps.refreshStatus()
    // Restore the parent's Focus disclosures BEFORE the repaint so the
    // projection uses them (plan §26).
    deps.surface.app.exitFocusViewerScope()
    deps.surface.repaint()
    // The main transcript may have grown while the viewer covered it (the
    // child's result, the parent's streaming): restore the parent's semantic latest/history position
    // so the pop never loses an intentional history anchor.
    deps.restoreMainTranscriptAnchor()
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
      const current = deps.childView.childWriterSubject(target.id)
      if (current !== undefined) {
        target.viewAgent = current
        publishQueueSubject(current)
      }
    },
    endTurn: () => { viewing!.activity = 'inactive' },
    refreshFooter: () => deps.refreshStatus(),
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
    // UNCONDITIONAL pending-open cancellation: a FIRST open has ALREADY retained
    // its child generation before any viewer is mounted, and
    // `teardownViewerForSessionSwap` returns before its callback when nothing is
    // mounted — so this bookkeeping must run OUTSIDE that callback, or a session
    // swap would leave the pending open holding its retained child generation
    // until it happens to settle.
    openingViewer = undefined
    openingAbort?.abort()
    openingAbort = undefined
    teardownViewerForSessionSwap(viewerOpen, viewing !== undefined, () => {
      viewing = undefined
      queueAuthority = undefined
      viewerSessionAbort?.abort()
      viewerSessionAbort = undefined
      releaseViewHandle()
      deps.surface.app.clearLocalMessages()
      deps.surface.app.clearNotify()
      deps.surface.app.setViewerMode(undefined)
      // Session swap: the OLD parent session is gone — its parked Focus
      // disclosures must be DISCARDED, never restored into the new session
      // (clearSessionOverrides already dropped the stack; this keeps the
      // teardown's intent explicit and ordering-safe). The Esc path uses
      // exitFocusViewerScope instead (restore).
      deps.surface.app.discardFocusViewerScope()
      // M3-5 PR1 §9.7: the display subject returns to the NEW main session in
      // ONE atomic StatusStore update before the repaint.
      deps.refreshStatus()
      deps.surface.repaint()
      deps.restoreMainTranscriptAnchor()
    })
  }

  /**
   * Final teardown at surface/runner disposal. NO painting and NO surface
   * writes: the mounted app is already going away, and the adapter/Client
   * disposal follows. Cancels an in-flight open and drops the mounted viewer's
   * ingress + child generation exactly once.
   */
  const dispose = (): void => {
    viewerOpen.invalidate()
    openingViewer = undefined
    openingAbort?.abort()
    openingAbort = undefined
    viewing = undefined
    queueAuthority = undefined
    viewerSessionAbort?.abort()
    viewerSessionAbort = undefined
    // The ingress goes down BEFORE the child generation is released (the source
    // also enforces that order internally).
    releaseViewHandle()
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
    rehydrateViewedChild,
    extendViewedChildHistory,
    teardownForSessionSwap,
    dispose,
    isViewing,
  }
}
