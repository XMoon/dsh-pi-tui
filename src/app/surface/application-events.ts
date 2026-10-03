/**
 * ApplicationEvents (A5b-5, plan §A5b-5): the ONE owner of the TuiApp
 * application-event adapter. The composition root no longer implements
 * `TuiAppEvents`; it constructs this owner and hands the produced adapter to
 * `surface.start(...)`.
 *
 * Ownership (the plan's delegation shape):
 *
 * - `onSubmit` / `onSteer` / `onDequeue` / `onCancel` → the A5b-4
 *   {@link SubmissionController};
 * - `onSubagentSubmit` / `onSingleEscape` → the A5b-1 viewer owner (this module
 *   owns the prompt dispatch body because it spans the viewer state and the
 *   subagent Host ports);
 * - `onRewind` + the shared `/rewind` entry (`openRewindPicker`) → the
 *   session presentation/action owner;
 * - search/navigation, focus/input reports and the task browser → the
 *   {@link SurfaceRuntime} owner;
 * - settings/theme actions and extension health → the A5b-2
 *   {@link SettingsRuntime} owner;
 * - permission cycling → the A5b-2 {@link StatusRuntime} owner;
 * - the clipboard/external-editor policy → the A5b-5
 *   {@link ClientActions} owner.
 *
 * Dependency shape: a handful of OWNER OBJECTS (submission, viewer, surface,
 * status, settings, client) plus the few runner lifetime/identity callbacks and
 * the rewind/subagent Host-port groups that have no narrower owner today. It is
 * deliberately NOT a 40-field flattened reproduction of the old lexical scope.
 *
 * The module imports no Host session/agent package and performs no Host
 * service lookup; every late-rebound slot is read through `deps.*` at call
 * time.
 * @module @xmoon76/dsh-pi-tui/app/surface/application-events
 */

import type { DraftFileStore } from '../../attachment/file-draft.ts'
import type { OwnedTaskOptions } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { DraftImageStore } from '../../image/draft-store.ts'
import { checkImageLimits } from '../../image/intake.ts'
import { draftHasAttachments, draftHasImages, pruneUnreferencedDraftAttachments } from '../../image/submit.ts'
import { resolveComposerDelivery } from '../../commands.ts'
import { rewindCandidateOfLoadedWindow, rewindOutlineRows } from '../../rewind.ts'
import type { HostFilePort } from '../../runtime/host-file-port.ts'
import type { PendingInputReader } from '../../runtime/pending-input-reader-port.ts'
import type { SessionWriter } from '../../runtime/session-writer-port.ts'
import type { SubagentPort } from '../../runtime/subagent-port.ts'
import type { RewindNavigationIdentity } from '../../session-fork.ts'
import { mergeDraft, steerAll, type SteerAgentLike } from '../../steer.ts'
import {
  isEmptyAcceleratedViewerSubmit,
  type TuiApp,
  type TuiAppEvents,
} from '../../tui-app.ts'
import { viewerActionCapability } from '../../subagent-viewer.ts'
import {
  viewerCanonicalizeScope,
  type SubagentPromptOutcome,
  type SubagentViewerSubmitRequest,
} from '../../subagent-viewer-submit.ts'
import type { SessionForkOutcome } from '../session/runtime.ts'
import type { SubmissionController } from '../submission/controller.ts'
import type { ClientActions } from './client-actions.ts'
import type { SettingsRuntime } from './settings-runtime.ts'
import type { StatusRuntime } from './status-runtime.ts'

/** The live-agent surface the event adapter reads (identity only; the
 *  whole-log rewind authorities live in the injected rewind reads). */
export interface ApplicationEventsAgent {
  readonly session: {
    readonly id: string
  }
}

/**
 * The subagent viewer STATE owner (the A5b-1 `ViewerRuntime`, narrowed to the
 * reads/writes this adapter performs so it never depends on the event generic).
 */
export interface ApplicationEventsViewer {
  isViewing(): boolean
  read(): {
    readonly id: string
    readonly parentSessionId: string
    readonly mode: 'one-shot' | 'continuable'
    readonly access: string
    readonly activity: string
    readonly cwd: string
  } | undefined
  exitView(): boolean
  followUpSignal(): AbortSignal | undefined
  settleSubmit(
    request: SubagentViewerSubmitRequest,
    text: string,
    outcome: SubagentPromptOutcome,
    viewerGeneration: number,
  ): void
}

/** The mounted-surface capabilities the event adapter drives. */
export interface ApplicationEventsSurface {
  readonly app: TuiApp
  handleTerminalFocus(focused: boolean): void
  noteUserInput(): void
  openTasksBrowser(viewMode: 'quick' | 'full'): void
}

/**
 * The subagent viewer's Host delivery ports. The viewer owner owns the viewer
 * STATE, but delivering a child-inbox prompt needs the exact Direct parent
 * resolution plus the Backend prompt/writer/host-file ports, which have no
 * narrower owner today. Injected as ONE domain group, never a flat bag.
 */
export interface ApplicationEventsSubagentDelivery {
  /** The exact live queue Agent of the viewed child (the steer-all target). */
  queueAgentFor(childId: string): SteerAgentLike | undefined
  /** The semantic pending-input read (the queue placement/running state). */
  readonly pendingInputReader: PendingInputReader
  /** The session WRITE delivery seams (ordinary prompt + queue mutation). */
  readonly writer: Pick<SessionWriter, 'prompt' | 'updateQueue'>
  /** The submission writer admission section (captures a fresh live scope). */
  writerSection<T>(task: () => Promise<T>): Promise<T>
  /** The official child-inbox human prompt port. */
  readonly subagent: Pick<SubagentPort, 'prompt'>
  /** The Host `@`-mention canonicalization port. */
  readonly hostFile: Pick<HostFilePort, 'canonicalizeMentions'>
}

/**
 * The runner lifetime/identity callbacks the composition root owns. These are
 * the "few lifetime callbacks" the plan allows; none is a business-domain
 * capability.
 */
export interface ApplicationEventsLifecycle {
  /** Run one owned task with the runner diag pre-attached (sessionId defaults
   *  to the live agent; the caller may override it). */
  runOwned<T>(label: string, task: () => T | Promise<T>, options?: Omit<OwnedTaskOptions<T>, 'diag'>): void
  isCleanedUp(): boolean
  requestExit(): void
  /** The live agent of the current owner, or undefined. */
  liveAgent(): ApplicationEventsAgent | undefined
  /** The current ownership generation. */
  generation(): number
  /** The current owner session id. */
  currentSessionId(): string | undefined
  /** The current navigation epoch (the rewind picker fence). */
  navigationEpoch(): number
  /** The runner lifetime signal (viewer prompt cancellation). */
  signal(): AbortSignal
}

/** The A5b-5 application-event owner. */
export interface ApplicationEventsOwner {
  /** The complete TuiApp event adapter (`surface.start` consumes it). */
  readonly events: TuiAppEvents
  /** The conversation rewind picker (the idle double-Esc AND `/rewind` entry). */
  openRewindPicker(): void
}

/** The narrow capabilities the A5b-5 application-event owner consumes. */
export interface ApplicationEventsDeps {
  /** A5b-4: the user-input workflow owner. */
  readonly submission: SubmissionController
  /** A5b-1: the interactive subagent viewer owner. */
  readonly viewer: ApplicationEventsViewer
  /** The mounted surface owner (app + focus/input reports + task browser). */
  readonly surface: ApplicationEventsSurface
  /** A5b-2: the status owner (footer/title refresh + permission cycle). */
  readonly status: StatusRuntime
  /** A5b-2: the settings/extension owner (fullscreen + advanced theme + health). */
  readonly settings: SettingsRuntime
  /** A5b-5: the client-local clipboard/external-editor policy. */
  readonly client: ClientActions
  /** The per-TUI draft stores (the image/file draft emptiness gates). */
  readonly drafts: {
    readonly images: DraftImageStore
    readonly files: DraftFileStore
  }
  /** The deployment image policy (the Host attachments service `imageLimits`),
   *  re-read per paste. */
  readonly imageLimits: () => Parameters<typeof checkImageLimits>[2] | undefined
  /** The rewind whole-log reads + the fork action (idle double-Esc /
   *  `/rewind`). M3-4 PR4 §4: the picker enumerates the official
   *  `turnOutline` projection (whole-log — old turns outside the bounded
   *  presentation window included); the selection jumps the window with
   *  `loadThrough(seq)` and derives the EXACT material from the loaded
   *  durable events. Both branches share this owner. */
  readonly rewind: {
    /** The whole-log turn outline (the picker authority). */
    turnOutline(sessionId: string): readonly import('../../runtime/presentation-read-port.ts').TurnOutlineEntryDto[] | undefined
    /** Jump the window backwards through the OFFICIAL loadThrough loop and
     *  return the loaded durable events (undefined = no materialized
     *  binding / superseded settle — never a guessed boundary). */
    loadThrough(sessionId: string, seq: number, signal?: AbortSignal): Promise<readonly import('../../runtime/presentation-read-port.ts').PresentationDurableEvent[] | undefined>
    /** Capture the transport identity the selection was admitted under
     *  (Remote: Connection generation + exact binding; Direct reads
     *  `undefined`). Captured ONCE at picker open — the check below only
     *  ever COMPARES this frozen identity. */
    captureSelectionIdentity(sessionId: string): unknown
    /** Whether the captured selection identity is still the live transport
     *  for this session (the §6.5 re-check after every await; a
     *  same-session-id binding rollover reads stale). `identity ===
     *  undefined` (the Direct branch) is always current. */
    isSelectionCurrent(sessionId: string, identity: unknown): boolean
    forkSession(
      sourceSessionId: string,
      atSeq: number,
      onAdopted: () => void,
      pickerIdentity: RewindNavigationIdentity,
    ): Promise<SessionForkOutcome>
    /** PR5 v2 §3C: whether one navigation identity (the picker's, or the
     *  runtime-minted post-adoption identity carried on a success outcome)
     *  is still the live navigation subject. */
    isNavigationCurrent(expected: RewindNavigationIdentity): boolean
  }
  /** The subagent viewer's Host delivery ports. */
  readonly subagentDelivery: ApplicationEventsSubagentDelivery
  /** The runner lifetime/identity callbacks. */
  readonly lifecycle: ApplicationEventsLifecycle
}

/** Create the TuiApp application-event owner (plan §A5b-5). */
export function createApplicationEvents(deps: ApplicationEventsDeps): ApplicationEventsOwner {
  /**
   * The conversation rewind picker (the ONE entry shared by the idle
   * empty-editor double-Esc and `/rewind` — plan §22). Lists the completed
   * user turns of the live session; a selection dispatches the semantic Host
   * fork with the candidate's predecessor boundary as an OWNED task with the
   * navigation identity gates. Sessionless (deferred start) it notifies and
   * never creates a session.
   */
  const openRewindPicker = (): void => {
    const app = deps.surface.app
    const source = deps.lifecycle.liveAgent()
    if (source === undefined) {
      app.notify('no conversation to rewind', 'info')
      return
    }
    // Rewind only from an EMPTY editor: the restored prompt must be a
    // deliberate, clean draft — never merged into (or over) the user's current
    // draft. The `/rewind` command gets the same guard, so both entries can
    // never drop staged input (plan §30).
    if (app.getDraft().trim() !== '') {
      app.notify('clear the current draft before rewinding', 'info')
      return
    }
    // Capture the picker-open identity, not only the Session id. A switch away
    // and back to the same id must still supersede the old candidate — and the
    // REMOTE transport identity (Connection generation + exact binding) is
    // captured here ONCE: a same-id binding rollover while the picker is open
    // must invalidate the pending selection (§2.2/§16).
    const sourceId = source.session.id
    const selectionIdentity = deps.rewind.captureSelectionIdentity(sourceId)
    const pickerIdentity: RewindNavigationIdentity = {
      sessionId: sourceId,
      navigationEpoch: deps.lifecycle.navigationEpoch(),
    }
    // §4.1/§4.2: the picker authority is the whole-log turnOutline
    // projection — never a full-log page scan, never the bounded window.
    const outline = deps.rewind.turnOutline(sourceId)
    const rows = outline === undefined ? [] : rewindOutlineRows(outline)
    if (rows.length === 0) {
      // Distinguish the two honest empties: an UNAVAILABLE outline (no
      // whole-log authority reachable for this session — a projection
      // capability gap on the Remote branch, or an unreadable one) never
      // masquerades as "history has no turns" (§19.3 truthful-unavailable).
      app.notify(outline === undefined
        ? 'rewind history is unavailable right now'
        : 'no completed user turn to rewind', 'info')
      return
    }
    app.openPicker(
      rows,
      (value) => {
        const selectedSeq = Number(value)
        let adopted = false
        deps.lifecycle.runOwned('conversation rewind', async () => {
          // §4.3: capture the identities, jump the window through the
          // OFFICIAL loadThrough loop, re-check, derive the EXACT material
          // from the loaded durable events (the full editor text, never the
          // outline's bounded preview), then dispatch the existing fork.
          const loaded = await deps.rewind.loadThrough(sourceId, selectedSeq, deps.lifecycle.signal())
          if (deps.lifecycle.isCleanedUp()) return
          if (loaded === undefined) {
            app.notify('the session changed while rewinding — try again', 'info')
            return
          }
          if (!deps.rewind.isSelectionCurrent(sourceId, selectionIdentity)) {
            app.notify('the session changed while rewinding — try again', 'info')
            return
          }
          const candidate = rewindCandidateOfLoadedWindow(loaded as never, selectedSeq)
          if (candidate === undefined) {
            app.notify('the selected turn could not be resolved — try again', 'error')
            return
          }
          return deps.rewind.forkSession(
            sourceId,
            candidate.forkAtSeq,
            () => {
              adopted = true
              app.setDraft(candidate.editorText)
            },
            pickerIdentity,
          ).then(outcome => ({ outcome, candidate }))
        }, {
          sessionId: () => sourceId,
          onResult: (result) => {
            // A pre-fork settle (a loadThrough drop / an unresolved
            // selection) already notified; nothing further here.
            if (result === undefined) return
            const { outcome, candidate } = result
            if (outcome.kind === 'success' && adopted) {
              // §3C: the success toast belongs to the identity THIS
              // operation's own adoption minted (the runtime's
              // post-adoption navigation). A later external navigation
              // (including A→B→A) must not receive the stale toast; the
              // operation's own adoption is not supersession.
              const owned = outcome.adoptedNavigation
              if (owned !== undefined && !deps.rewind.isNavigationCurrent(owned)) return
              if (candidate.hasNonTextContent) {
                app.notify(`rewound to turn ${candidate.turn}; original non-text content was not re-staged — review it before sending`, 'error')
              } else {
                app.notify(`rewound to turn ${candidate.turn}`, 'info')
              }
              return
            }
            if (outcome.kind === 'error') {
              // PR5 v2 §3C (plan-owner amendment): each error settles
              // against ITS OWN notification fence. A runtime-DETECTED
              // supersession carries the live identity observed at the
              // detection moment (`notificationNavigation`) — A → B → A
              // lands on A/N+2 and the cancellation is publishable while
              // THAT identity is current; any later advance suppresses it.
              // Every other pre-adoption failure belongs to the ORIGINAL
              // picker identity. No error-text string matching.
              if (!deps.rewind.isNavigationCurrent(outcome.notificationNavigation)) return
              if (outcome.reason === 'navigation-changed-before-dispatch') {
                app.notify('session changed — rewind cancelled', 'info')
              } else {
                app.notify(outcome.text, 'error')
              }
            }
          },
          onError: (error) => {
            // An operational failure escaped the outcome contract entirely
            // (a throw past forkSession's never-throws boundary). There is
            // no trustworthy identity to fence with — the picker-open
            // identity is necessarily stale after any admission (the
            // d529d464 lesson) — so the failure is shown: hiding a
            // contract-violating throw behind a stale fence would silence
            // a programming error.
            app.notify(safeErrorMessage(error), 'error')
          },
        })
      },
      () => {},
      {
        header: 'Rewind conversation · workspace unchanged',
        enableSearch: true,
        noMatchText: 'No matching turn',
        width: 72,
        maxHeight: 24,
        showHint: true,
      },
    )
  }

  const surfaceEvents: TuiAppEvents = {
    // ONE submission entry: the request (the Enter gesture, the accelerated
    // chord, or the explicit queue action) rides along — the boundary resolves
    // its delivery mode.
    onSubmit: (text, request) => deps.submission.submit(text, request),
    // The image-only submit gate (plan §11.1): an empty-text draft with staged
    // images is a real submission.
    isImageDraft: () => draftHasImages(deps.surface.app.getDraft(), deps.drafts.images),
    // The in-process EDITOR history must never recall a multimodal line after
    // its drafts were consumed — the placeholders would re-send as plain text
    // (the persisted JSONL history has the same guard; review finding: the
    // memory side was missing it).
    shouldRememberInput: (text) => !draftHasAttachments(text, deps.drafts.images, deps.drafts.files),
    // Ctrl+V (plan M3): probe the clipboard ONCE per paste — an image lands as
    // a draft placeholder, plain text as an editor insert, unsupported/empty
    // silently (a text paste must never error).
    onClipboardPaste: () => {
      // The clipboard probe is ASYNC: capture the session identity and discard
      // the result if the user switched sessions meanwhile — a late paste must
      // never stage into the NEW session's draft (round-5 finding 2).
      const pasteGeneration = deps.lifecycle.generation()
      deps.lifecycle.runOwned('clipboard paste', () => deps.client.readClipboardImage().then((result) => {
        if (deps.lifecycle.isCleanedUp() || deps.lifecycle.generation() !== pasteGeneration) return
        if (result.kind === 'image') {
          // Attach-time prune (review finding 2): placeholders deleted or
          // Ctrl+C-cleared since the last attach must not hold their bytes until
          // the store fills up.
          pruneUnreferencedDraftAttachments(deps.surface.app.getDraft(), deps.drafts.images, deps.drafts.files)
          const limits = deps.imageLimits()
          if (limits !== undefined) {
            checkImageLimits(
              { mediaType: result.mediaType, width: result.width, height: result.height },
              result.bytes.byteLength,
              limits,
            )
          }
          const draft = deps.drafts.images.add({
            bytes: result.bytes,
            mediaType: result.mediaType,
            width: result.width,
            height: result.height,
            source: { type: 'clipboard' },
          })
          deps.surface.app.insertIntoEditor(`${draft.placeholder} `)
          deps.surface.app.notify(`attached ${draft.placeholder} — Enter to send`)
        } else if (result.kind === 'text' && result.text !== '') {
          deps.surface.app.insertIntoEditor(result.text)
        }
      }), {
        sessionId: () => deps.lifecycle.liveAgent()?.session.id,
        onError: (error) => {
          if (deps.lifecycle.isCleanedUp()) return
          deps.surface.app.notify(safeErrorMessage(error), 'error')
        },
      })
    },
    // The owned-task entry for UI-layer one-shot flows (the external editor):
    // runOwned with the runner's diag pre-attached.
    runOwned: (label, task, options) => deps.lifecycle.runOwned(label, task, options),
    onExit: () => {
      // Keyboard exit requests route through the SAME exit orchestration as
      // /exit and /quit: latch once, dispose the Client surface, resume hint,
      // process exit.
      deps.lifecycle.requestExit()
    },
    onCancel: () => {
      // Esc cancel: abort a running `!` shell command. interruptAgent PRESERVES
      // the pending queue (web Stop parity) — an interrupt stops the current
      // thinking, never the queued input.
      deps.submission.abortLocalShell()
    },
    // Conversation rewind: the TuiApp fires this only when IDLE with an EMPTY
    // editor and a fast second Esc (busy stays a cancel; overlays, autocomplete
    // and replacement editors keep their own Esc). The SAME surface as
    // `/rewind` — one implementation, two entries.
    onRewind: () => openRewindPicker(),
    // M6: execute a plugin keybinding's SEMANTIC action through the host's own
    // paths (plan §2.2 — the host never lets a plugin bypass submission/session
    // safety).
    onExtensionAction: (action) => {
      if (deps.lifecycle.isCleanedUp()) return
      // VIEWER CAPABILITY GATE: while a subagent viewer is open (either mode),
      // semantic actions with PARENT-session side effects are blocked — the
      // viewer's input must never interrupt/steer/queue/reconfigure the parent
      // (a plugin keybinding reaching this runner is the ONLY path that could,
      // since the raw-key viewer guard already consumes the parent chords).
      // submit-draft/queue-draft route to the CHILD through the viewer-aware
      // submitDraft (a one-shot viewer hard-rejects them), toggle-fullscreen is
      // surface-local; every other action is consumed as a no-op.
      if (deps.viewer.isViewing() && !viewerActionCapability(action, { mode: deps.viewer.read()!.mode })) {
        return
      }
      switch (action) {
        case 'submit-draft': {
          // Host-owned submit path: history + notify clear + draft clear,
          // exactly like a normal Enter (round-1 P2).
          deps.surface.app.submitDraft('enter')
          break
        }
        case 'queue-draft': {
          // The PUBLIC queue action: an explicit delivery command, never a
          // gesture — it queues regardless of the busy-Enter preference (the
          // accelerated CHORD is the preference's opposite).
          deps.surface.app.submitDraft('explicit-queue')
          break
        }
        case 'steer-draft': {
          // The steered draft is an agent-facing submission: the OWNER snapshots
          // the persist facts (ts + image check) BEFORE consuming the draft, and
          // the row is written after the session exists (the deferred-start
          // gate) with the FINAL session id. This action hands the still-present
          // draft over, so the owner consumes it.
          deps.submission.steer(deps.surface.app.getDraft(), { consumeDraft: true })
          break
        }
        case 'cancel-activity': {
          deps.submission.abortLocalShell()
          break
        }
        case 'open-search': {
          deps.surface.app.startTranscriptSearch()
          break
        }
        case 'toggle-fullscreen': {
          deps.surface.app.setFullscreen(!deps.surface.app.isFullscreen())
          break
        }
        case 'cycle-permission': {
          deps.status.cyclePermission()
          break
        }
      }
    },
    onSteer: (text) => {
      // Ctrl+S: the steered draft is an agent-facing submission — TuiApp has
      // ALREADY cleared and notified the editor seat before this callback, so
      // the owner must not consume (clear) the draft a second time; the
      // snapshot happens now and the row is written inside steerNow AFTER the
      // session exists (the deferred-start gate) with the FINAL session id.
      deps.submission.steer(text)
    },
    onExtensionError: ({ slot, id, error }) => {
      deps.settings.recordExtensionError(slot, id, error)
    },
    onExtensionRecovered: ({ slot, id }) => {
      deps.settings.clearExtensionError(slot, id)
    },
    // The session presentation title changed (advanced ui.host.setTitle,
    // session/title events — the app fires it for EVERY setSessionTitle): the
    // terminal window title policy follows, so a rename/regenerate refreshes
    // the OSC title immediately.
    onTitleChanged: () => {
      if (deps.lifecycle.isCleanedUp()) return
      deps.status.refreshTerminalTitle()
    },
    // Terminal focus reports (CSI ? 1004): the completion-notification focus
    // tracker observes them. The report is consumed host-side in regular mode
    // and passes through in fullscreen (the viewport listener owns FOCUS_OUT's
    // selection cleanup), so the tracker only records state.
    onTerminalFocus: (focused) => {
      deps.surface.handleTerminalFocus(focused)
    },
    // Any REAL input (not a focus report) proves the user is operating the
    // terminal: restore the tracker to 'focused' (a missed FOCUS_IN must never
    // leave an 'unfocused' tracker that would falsely notify while the user
    // watches).
    onUserInput: () => {
      deps.surface.noteUserInput()
    },
    // Phase 4: the advanced host-state setTheme for a NON-built-in name (a
    // registered plugin theme). The settings owner resolves the palette through
    // the theme registry; unknown names are a no-op; a throwing palette is
    // recorded in the theme health slot.
    onAdvancedSetTheme: (name) => {
      deps.settings.applyAdvancedTheme(name)
    },
    openExternalEditor: (draft) => deps.client.openExternalEditor(draft),
    // The transcript navigation callbacks (MoveOlder/TurnOlder/TurnNewer/
    // MoveNewer/JumpLatest) are surface-owned wiring (A4-8, plan §17); the
    // surface overlays them in `SurfaceRuntime.start`.
    onFullscreenChange: (fullscreen) => {
      deps.settings.setFullscreen(fullscreen)
    },
    // The Ctrl+R search presentation callbacks (Open/Query/Next/Prev/Close) are
    // surface-owned wiring (A4-8, plan §17); the surface overlays them in
    // `SurfaceRuntime.start`. The matching/index algorithm stays in
    // transcript.ts and the stepping policy in search-overlay.ts.
    // P7d: a single Esc with no overlay up exits the subagent viewer instead of
    // arming the double-Esc cancel.
    onSingleEscape: () => deps.viewer.exitView(),
    // Shift+Tab: cycle the permission preset through the composed table
    // (read-only → workspace-write → danger-full-access); the status owner owns
    // the switch + footer refresh.
    onCyclePermission: () => {
      deps.status.cyclePermission()
    },
    // Alt+↑: on the main surface, run the TUI-only recall-all extension: remove
    // every semantic `queued` occurrence and pull its content back into the
    // editor draft. The gesture is disabled in every viewer so it cannot mutate
    // a hidden main or child queue.
    onDequeue: () => deps.submission.dequeue(),
    // ↓ with an empty editor: the Quick Tasks browser. Task Center merges the
    // JobRegistry roster with the subagent descendant catalog; the SAME browser
    // is the `/tasks` surface.
    onOpenTasks: () => deps.surface.openTasksBrowser('quick'),
    // A submit gesture in an INTERACTIVE (continuable) subagent viewer: resolve
    // queue/steer delivery, then deliver the human prompt through the OFFICIAL
    // `subagents.prompt` control API — the child inbox (a distinct FIFO turn:
    // enqueue while running, wake while waiting, cold resume when absent), with
    // Host authority over the exact live parent and official user
    // provenance/requestId. NEVER `subagents.sendMessage` (the Agent-authored
    // Steer path) and never the parent's submit/steer/queue path. The app
    // already cleared the child draft; a rejection restores it (merged) into
    // the child's own draft slot.
    onSubagentSubmit: (submit) => {
      if (deps.lifecycle.isCleanedUp()) return
      const app = deps.surface.app
      const viewerGeneration = app.getViewerGeneration()
      // The viewer editor's text becomes the prompt's content parts at the
      // client boundary (text today; image parts join with the viewer's image
      // intake). Resolve the Web composer policy against the CHILD's activity;
      // the parent status is irrelevant while viewing.
      const delivery = submit.gesture === 'explicit-queue'
        ? 'queue'
        : resolveComposerDelivery(
          deps.viewer.read()?.id === submit.childSessionId
            && deps.viewer.read()?.parentSessionId === submit.parentSessionId
            && deps.viewer.read()?.activity === 'running',
          submit.gesture,
          deps.settings.busyEnter(),
        )
      // Empty accelerated input is the child-scoped Ctrl+S steer-all gesture.
      // It must operate on the live child inbox, never call the ordinary human
      // prompt API, and never manufacture an empty prompt.
      const viewerTarget = deps.viewer.read()
      if (isEmptyAcceleratedViewerSubmit(submit.text, submit.gesture)) {
        if (viewerTarget === undefined
          || viewerTarget.id !== submit.childSessionId
          || viewerTarget.parentSessionId !== submit.parentSessionId
          || viewerTarget.mode !== 'continuable'
          || viewerTarget.access !== 'interactive-direct-child') return
        const childViewerGeneration = viewerGeneration
        let childDraftRestored = false
        const restoreChildDraft = (text: string): boolean => {
          if (text === '' || childDraftRestored) return true
          childDraftRestored = true
          const current = deps.viewer.read()
          if (!deps.lifecycle.isCleanedUp()
            && app.getViewerGeneration() === childViewerGeneration
            && current?.id === submit.childSessionId
            && current.parentSessionId === submit.parentSessionId
            && current.mode === 'continuable'
            && current.access === 'interactive-direct-child'
            && deps.lifecycle.currentSessionId() === submit.parentSessionId) {
            const merged = mergeDraft(app.getDraft(), text)
            app.setEditorText(merged)
            return merged === text
          }
          if (!deps.lifecycle.isCleanedUp()) app.restoreSubagentDraft(submit.childSessionId, text)
          return false
        }
        deps.lifecycle.runOwned('subagent queue steer', () => steerAll({
          currentAgent: () => deps.subagentDelivery.queueAgentFor(submit.childSessionId),
          currentGeneration: () => app.getViewerGeneration(),
          notify: (message, kind) => {
            if (deps.lifecycle.isCleanedUp() || app.getViewerGeneration() !== childViewerGeneration) return
            const read = deps.viewer.read()
            if (read?.id !== submit.childSessionId || read.parentSessionId !== submit.parentSessionId) return
            app.notify(message, kind)
          },
          restoreDraft: restoreChildDraft,
          createDraft: () => ({}),
          staleNotice: () => 'the child viewer changed while steering — try again',
          mergedNotice: () => 'the child viewer changed while steering — try again',
          fence: () => deps.lifecycle.isCleanedUp() || app.getViewerGeneration() !== childViewerGeneration,
          fenceNotice: () => 'the child viewer changed while steering — try again',
          pendingInputReader: deps.subagentDelivery.pendingInputReader,
          writer: deps.subagentDelivery.writer,
          writerSection: deps.subagentDelivery.writerSection,
        }, submit.text, { draftHasPayload: false }), {
          sessionId: () => deps.subagentDelivery.queueAgentFor(submit.childSessionId)?.session.id,
          onError: (error) => {
            restoreChildDraft(submit.text)
            if (deps.lifecycle.isCleanedUp() || app.getViewerGeneration() !== childViewerGeneration) return
            app.notify(safeErrorMessage(error), 'error')
          },
        })
        return
      }
      const request: SubagentViewerSubmitRequest = {
        parentSessionId: submit.parentSessionId,
        childSessionId: submit.childSessionId,
        delivery,
        content: [{ type: 'text', text: submit.text }],
      }
      const promptViewerAbort = deps.viewer.followUpSignal()
      const promptViewerCwd = deps.viewer.read()?.cwd
      deps.lifecycle.runOwned('subagent prompt', () => deps.subagentDelivery.subagent.prompt(request, {
        // The caller signal owns lookup/materialization/admission only until
        // inbox acceptance (the official prompt contract): a TUI cleanup / exit,
        // OR the viewer session ending (Esc / child switch / session swap —
        // viewerSessionAbort) cancels a send that has NOT been accepted yet;
        // once accepted the child owns the message and no restore happens.
        makeSignal: () => promptViewerAbort === undefined
          ? deps.lifecycle.signal()
          : AbortSignal.any([deps.lifecycle.signal(), promptViewerAbort]),
        // Same `@`-mention send seam as the main session's submissions
        // (the official semantics keep the text literal; the seam remains
        // the one routing point). The scope is the VIEWED CHILD's workspace
        // when the viewer knows it; an unknown cold-child cwd falls back to
        // the live parent.
        canonicalizeText: (text) => deps.subagentDelivery.hostFile.canonicalizeMentions(
          viewerCanonicalizeScope(promptViewerCwd, request.parentSessionId),
          text,
        ),
      }), {
        sessionId: () => deps.lifecycle.liveAgent()?.session.id,
        onResult: (outcome) => deps.viewer.settleSubmit(request, submit.text, outcome, viewerGeneration),
        onError: (error) => deps.viewer.settleSubmit(
          request,
          submit.text,
          { kind: 'rejected', reason: { kind: 'error', message: safeErrorMessage(error) } },
          viewerGeneration,
        ),
      })
    },
  }
  return { events: surfaceEvents, openRewindPicker }
}
