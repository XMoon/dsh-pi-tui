/**
 * Session-domain command definitions: /sessions (+ /resume), /new, /search,
 * /title (+ /rename), /fork and /rewind, plus the ONE shared Session Browser
 * lifecycle (the `SessionBrowserReadOwner` plus the PiTui Picker Presentation
 * that renders its snapshot) that /sessions, /resume and /search consume.
 *
 * Registration is explicit: the coordinator (src/commands.ts) calls each
 * registrar at its frozen position and owns catalog/provenance/disposal state.
 * @module @xmoon76/dsh-pi-tui/commands/sessions
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionWorkspaceHandle, TuiApp } from '../../tui-app.ts'
import { createSessionBrowserReadOwner, type SessionBrowserReadOwner, type SessionBrowserReadSettlement, type SessionBrowserResumeSettlement } from '../../app/command/session-browser-read.ts'
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
  SessionBrowserDirectorySettlement,
} from '../../app/command/session-browser-presentation.ts'
import { TransitionInProgressError } from '../../app/session/operation-barrier.ts'
import { SessionScopeSupersededError, type SessionScope } from '../../app/session/scope.ts'
import { SessionNavigationStopError, type NavigationIntent } from '../../app/session/transition.ts'
import type { SessionSwitchOutcome } from '../../app/session/runtime.ts'
import { cancellationError, isCancellation, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { createWorkspaceNextIntentOwner } from '../../app/session/workspace-next-intent.ts'
import { recoverableWorkspaceSelection } from '../../app/session/workspace-selection-recovery.ts'
import { LifecycleError, WorkspaceSelectionError, type ResolvedWorkspaceSelection, type WorkspaceSelectionIntent } from '../../runtime/session-lifecycle-port.ts'
import {
  findSessionMatch,
  sanitizeTerminalText,
  sessionBrowserErrorNotice,
  type SessionPickerRow,
} from '../pickers/sessions.ts'
import type {
  NewSessionId,
  RegisterOne,
  RegisterTuiCommand,
  TuiCommandRunner,
} from '../../commands.ts'

/** The runner operations the session commands consume. */
type SessionCommandRunner = Pick<
  TuiCommandRunner,
  | 'agents'
  | 'awaitPendingDefaultWrite'
  | 'awaitWorkspacePreflight'
  | 'captureSessionScope'
  | 'catalog'
  | 'currentSessionId'
  | 'cwd'
  | 'diag'
  | 'effectivePresetId'
  | 'fileStore'
  | 'forkSession'
  | 'forwardedAnswerEligibility'
  | 'subscribeForwardedAnswerEligibility'
  | 'imageStore'
  | 'isSessionScopeCurrent'
  | 'openRewindPicker'
  | 'requireLiveSessionScope'
  | 'refreshStandingCatalog'
  | 'sessionCwd'
  | 'sessionReader'
  | 'sessionWorkspaceFacts'
  | 'hostDirectoryBrowse'
  | 'sessionBrowserPresentation'
  | 'sessionWriter'
  | 'signal'
  | 'switchSession'
  | 'switchSessionOutcome'
  | 'transitionTo'
  | 'withSessionTransition'
  | 'withWriter'
  | 'workspaceNextIntent'
  | 'updateWelcomeCard'
>

export interface SessionCommandDeps {
  runner: SessionCommandRunner
  app: TuiApp
  registerOne: RegisterOne
  registerTuiCommand: RegisterTuiCommand
  recordCommandDraftDisposition: (commandId: string | undefined, disposition: 'restored' | 'suppressed') => void
  newSessionId: NewSessionId
  /**
   * PR4-B2-A: the renderer-neutral notice entry (see `registerTuiCommands`).
   * It replaces the direct `app.notify` calls in the title handler, which
   * would dereference a `TuiApp` that does not exist on the TSP renderer.
   */
  notify: (text: string, kind?: 'info' | 'error') => void
  /**
   * PR4-B2-A: the `/title`/`/rename` refusal notice. It publishes only where the
   * handler is that refusal's visible owner (the PiTui surface beside the Direct
   * command-result card); the card owns the TSP Direct text, and the submission
   * settlement owns the card-less Client-command text.
   */
  notifyTitleRefusal: (text: string) => void
  /**
   * PR4-B2-A: the `/title`/`/rename` CONFIRMED-success notice — a new line the
   * base handler never emitted. It publishes only on the card-less TSP path, so
   * PiTui behavior is unchanged and every other mount has a single owner.
   */
  notifyTitleSuccess: (text: string) => void
}

export interface SessionCommandRegistrars {
  registerSessions(): void
  registerNew(): void
  registerSearch(): void
  registerTitle(): void
  registerFork(): void
  registerRewind(): void
  /**
   * TSP-7 Welcome D: the argument-free UI entry into the SAME `/sessions`
   * Session Browser lifecycle the typed command runs — one shared
   * `openSessionPicker`, one picker generation, one read owner, one switch
   * route. It carries no query (the Welcome offers no filter affordance);
   * the typed handler keeps passing its own invocation, so a
   * `/sessions <query>` argument still seeds the Browser.
   *
   * The optional scope is the internal initial BROWSE scope the PiTUI Host
   * Editor gesture passes (`'all'`); every pre-existing caller omits it and
   * keeps the Current default. The TSP native presentation ignores it — the
   * SDK owns that list's scope.
   */
  openSessions(scope?: 'current' | 'all' | { readonly scope?: 'current' | 'all'; readonly addDirectory?: boolean }): Promise<CommandResult>
}

/** Shorten a session id for read-only display rows, capped at 28 characters. */
export function displaySessionId(id: string): string {
  return id.length > 28 ? `${id.slice(0, 28)}…` : id
}

/**
 * Create the session-command registrars over the coordinator's primitives.
 * The factory only closes over its dependencies; it registers nothing until
 * one of the returned registrars is called at its frozen position. Exactly
 * ONE Session Browser lifecycle exists per factory instance.
 */
export function createSessionCommands(deps: SessionCommandDeps): SessionCommandRegistrars {
  const {
    runner,
    app,
    registerOne,
    registerTuiCommand,
    recordCommandDraftDisposition,
    newSessionId,
    notify,
    notifyTitleRefusal,
    notifyTitleSuccess,
  } = deps
  const { signal } = runner
  const workspaceNextIntent = runner.workspaceNextIntent ?? createWorkspaceNextIntentOwner(runner.cwd ?? process.cwd())

  /** The tracked switch settlement used by `/resume` and by an interactive
   * Picker selection: `matched`/accepted is not success; only a committed
   * target counts. Legacy narrow fakes without the tracked entry keep the old
   * string result (undefined = committed). */
  const switchSessionOutcome = (id: string, scope?: SessionScope): Promise<SessionSwitchOutcome> => {
    if (runner.switchSessionOutcome !== undefined) return runner.switchSessionOutcome(id, scope)
    return runner.switchSession(id, scope).then(
      error => error === undefined
        ? { kind: 'committed', sessionId: id } as const
        : { kind: 'failed', message: error } as const,
      error => ({ kind: 'failed', message: `session switch failed: ${safeErrorMessage(error)}` }) as const,
    )
  }

  /** The Session Browser command edge under which the ONE PiTUI fullscreen
   *  Workspace opens. It is written synchronously immediately before the
   *  shared read owner opens the panel and consumed-and-reset by the
   *  presenter's `open()`, so a re-entrant open never inherits a stale intent. */
  interface PiTuiOpenIntent {
    readonly header: 'sessions' | 'resume' | 'search'
    readonly scope: 'current' | 'all'
    readonly searchRequested: boolean
  }
  let piTuiOpenIntent: PiTuiOpenIntent | undefined

  /** One open PiTui fullscreen lease whose listing and Host reads are owned by the shared SessionBrowserReadOwner. */
  interface PiTuiWorkspaceOpen {
    readonly request: SessionBrowserPanelRequest
    handle: SessionWorkspaceHandle | undefined
    readonly controller: AbortController
    workspaceRevision: number
    disposed: boolean
    /** Per-open dedupe of the one notice each snapshot fact may surface. */
    lastNotice: string | undefined
  }

  /** The ONE PiTUI Session Workspace presentation (M5-U-C). It owns the
   *  physical fullscreen lease through `app.openSessionWorkspace` and the ONE
   *  per-open official Workspace follow; it owns no list, projection, query
   *  generation or switch (those stay in the shared read owner). */
  const createPiTuiSessionWorkspacePresentation = (): SessionBrowserPresentation => {
    let active: PiTuiWorkspaceOpen | undefined

    /** Release this open ONCE: token first, then the follow generation, then
     *  (only for an owner-origin close) the physical lease. */
    const release = (open: PiTuiWorkspaceOpen, closeLease: boolean): void => {
      if (open.disposed) return
      open.disposed = true
      if (active === open) active = undefined
      open.controller.abort()








      if (closeLease) open.handle?.close()
    }

    /** Start the ONE per-open Workspace follow AFTER the lease exists. Every
     *  frame re-proves this open's token and the captured subject; a failed
     *  stream degrades to All with one visible message and never closes the
     *  Session list/search. */
    /** The ONE Activity sample of ONE accepted roster revision. The roster is
     *  the read owner's ORIGINAL array (never a copy and never a re-listing),
     *  and the sample is fenced by this open's token, the captured Session
     *  subject, the accepted revision and its own AbortController. A sample the
     *  current frame did not ask for is inert. */
    /** Reproject the SAME last sample against the newest Client-root
     *  eligibility (no Host read) and request ONE early roster refresh through
     *  the read owner's single generation, so the next sample's `attention` is
     *  fresh too. An official request that another Client settled must drop the
     *  Needs row NOW, not at the next refresh tick. */
    /** Surface this open's Host/search/projection facts as ONE deduped notice
     *  (Host result first, the secondary projection failure second). The panel
     *  ALSO paints the same status; the notice is the transient companion the
     *  U-B contract already promised, never a second authority. */
    const emitNotice = (open: PiTuiWorkspaceOpen, snapshot: SessionBrowserReadSnapshot): void => {
      let key: string
      let text: string
      let kind: 'info' | 'error' = 'info'
      if (snapshot.searchState === 'unavailable') {
        key = 'search-unavailable'
        text = 'content search unavailable'
      } else if (snapshot.searchState === 'error') {
        key = `search-error:${snapshot.searchError ?? ''}`
        text = sessionBrowserErrorNotice('search', snapshot.searchError ?? 'unknown error')
        kind = 'error'
      } else if (snapshot.hasMore) {
        key = `search-more:${snapshot.query}`
        text = 'More content matches exist — refine the search.'
      } else if (snapshot.projectionError !== undefined) {
        key = 'projection-error'
        text = sessionBrowserErrorNotice('projection', snapshot.projectionError)
      } else {
        return
      }
      if (open.lastNotice === key) return
      open.lastNotice = key
      app.notify(text, kind)
    }

    const open = (request: SessionBrowserPanelRequest): SessionBrowserPanelHandle => {
      const previous = active
      if (previous !== undefined) release(previous, true)
      const intent = piTuiOpenIntent
      piTuiOpenIntent = undefined
      const subject = request.subject
      const closeAfterCommit = request.onClose

      const state: PiTuiWorkspaceOpen = {
        request,
        handle: undefined,
        controller: new AbortController(),
        workspaceRevision: -1,
        disposed: false,
        lastNotice: undefined,
      }
      // The lease is the ONLY physical owner. A refused lease throws here,
      // BEFORE any Workspace follow or Host list starts; the read owner retires
      // its just-created panel and the command reports one error.
      const handle = app.openSessionWorkspace({
        subject,
        onQueryChange: (raw) => {
          if (!state.disposed) request.onQueryChange(raw)
        },
        onResume: (sessionId) => {
          if (state.disposed) return
          request.onResumeIntent({
            sessionId,
            currentSessionId: subject.currentSessionId,
            source: 'enter',
          })
        },
        onClose: () => {
          if (state.disposed) return
          release(state, false)
          closeAfterCommit()
        },
        // The capability crossing keeps its OPTIONALITY: a missing owner must
        // never become a wrapper the panel can paint but nobody can settle.
        ...(request.onUseDirectory === undefined ? {} : {
          onUseDirectory: (workspaceId: string, canonicalPath: string) => {
            if (!state.disposed) request.onUseDirectory?.(workspaceId, canonicalPath)
          },
        }),
        ...(request.onNewSession === undefined ? {} : {
          onNewSession: (workspaceId: string, settle?: (outcome: import('../../app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void) => {
            // The shared ReadOwner owns ONE folder-New transaction for both
            // renderers: it invokes the existing /new body and retires this
            // lease only after the transition commits. The optional ack is the
            // ONE per-operation settlement (a notice is never a settlement).
            if (!state.disposed) request.onNewSession?.(workspaceId, settle)
          },
        }),
        ...(request.onAddDirectory === undefined ? {} : {
          onAddDirectory: (path: string, settle: (outcome: import('../../app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void) => {
            if (!state.disposed) request.onAddDirectory?.(path, settle)
          },
        }),
        // PR3: the optional Host browse read crosses only when this request
        // really carries it; a missing capability stays missing.
        ...(request.onListDirectory === undefined ? {} : { onListDirectory: request.onListDirectory }),
        initialMode: intent?.searchRequested === true ? 'search' : 'browse',
        initialBrowseScope: intent?.scope === 'all' || subject.currentSessionId === undefined ? 'all' : 'current',
       initialDirectoryChooser: request.initialDirectoryChooser,
        currentWorkspaceId: subject.currentWorkspaceId,
        initialDirectoryEntry: request.initialDirectoryEntry,
        initialDirectoryPath: request.initialDirectoryPath,
      })
      state.handle = handle
      active = state


      return {
        isDisposed: () => state.disposed || handle.isDisposed(),
        setSnapshot: (snapshot, snapshotOptions) => {
          if (state.disposed) return
          handle.setSnapshot(snapshot, snapshotOptions?.initialQuery)
          const workspace = snapshot.workspace
          if (workspace?.state === 'unavailable' && workspace.revision !== state.workspaceRevision) {
            state.workspaceRevision = workspace.revision
            handle.workspaceUnavailable(workspace.error ?? 'Workspace membership unavailable')
          }
          emitNotice(state, snapshot)
        },
        close: () => { release(state, true) },
      }
    }

    return {
      open,
      notify: (message, kind) => { app.notify(message, kind) },
    }
  }

  let nativeReadOwner: SessionBrowserReadOwner | undefined
  let nativePresentation: SessionBrowserPresentation | undefined

  /** PiTUI-only roster refresh cadence. TSP keeps its historical single read. */
  const SESSION_WORKSPACE_REFRESH_MS = 20_000

  const piTuiPresentation = createPiTuiSessionWorkspacePresentation()

  // The runner lifetime owns the ONE read owner: a quit/HMR aborts it so no
  // pending list, projection batch or debounced search outlives the surface.
  if (!signal.aborted) {
    signal.addEventListener('abort', () => {
      nativeReadOwner?.dispose()
      nativeReadOwner = undefined
      nativePresentation = undefined
    }, { once: true })
  }

  /** The ONE Reader-owner factory: a stable presentation keeps its owner; a
   * different renderer presentation retires the previous owner outright. */
  const nativeReadOwnerFor = (presentation: SessionBrowserPresentation): SessionBrowserReadOwner => {
    if (nativeReadOwner !== undefined && nativePresentation === presentation) return nativeReadOwner
    nativeReadOwner?.dispose()
    nativePresentation = presentation
    nativeReadOwner = createSessionBrowserReadOwner({
      reader: runner.sessionReader,
      presentation,
      ...(presentation === piTuiPresentation ? { autoRefreshMs: SESSION_WORKSPACE_REFRESH_MS } : {}),
      // PR3: ONLY the PiTUI presentation receives the Host directory browse
      // seam. The TSP native picker keeps its own read owner and must never
      // grow a second directory reader or suggestion layer.
      ...(presentation === piTuiPresentation
        ? { onListDirectory: (path: string | undefined, signal: AbortSignal) => runner.hostDirectoryBrowse.list(path, signal) }
        : {}),
      captureSubject: () => {
        const scope = runner.captureSessionScope()
        const nextIntent = scope.sessionId === undefined ? workspaceNextIntent.snapshot() : undefined
        return {
          scope,
          subject: {
            currentSessionId: scope.sessionId,
            currentCwd: runner.sessionCwd(),
            ...(nextIntent?.status === 'confirmed' && nextIntent.workspaceId !== undefined
              ? { currentWorkspaceId: nextIntent.workspaceId }
              : {}),
            isCurrent: () => !signal.aborted && runner.isSessionScopeCurrent(scope),
          },
        }
      },
      diag: runner.diag,
      sessionId: () => runner.currentSessionId,
      sessionWorkspaceFacts: runner.sessionWorkspaceFacts,
       forwardedAnswerEligibility: runner.forwardedAnswerEligibility,
       subscribeForwardedAnswerEligibility: runner.subscribeForwardedAnswerEligibility,
       onWorkspaceNewSession: (workspaceId, closeAfterCommit, settle) => {
         // ONE operation-local commit marker: a silent superseded success is
         // NOT a commit, so CommandResult.kind alone cannot classify this.
         let committed = false
         let settled = false
         const finish = (outcome: import('../../app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement): void => {
           if (settled) return
           settled = true
           settle?.(outcome)
         }
         const notifyFailure = (message: string): void => {
           const text = sanitizeTerminalText(message)
           if (nativePresentation !== undefined) nativePresentation.notify(text, 'error')
           else app.notify(text, 'error')
         }
         runOwned('workspace new session', () => startNewSession({
           source: 'folder',
           workspaceIntent: { kind: 'workspace-id', workspaceId },
           onCommitted: () => { committed = true },
         }), {
           diag: runner.diag,
           sessionId: () => runner.currentSessionId,
           isCancellation: () => runner.signal.aborted,
           onResult: (settlement) => {
             // The Folder row never consumes the recovery settlement: it keeps
             // this Browser, reports the refusal here and releases its pending
             // operation. A second Browser would be a second screen owner.
             const result = settlement.result
             if (committed) {
               // The create really committed; a post-commit cleanup error keeps
               // its truthful error notice but never fabricates a pre-commit
               // failure or blocks the committed retirement.
               if (result.kind === 'error') notifyFailure(result.text ?? 'fresh session cleanup failed')
               finish({ kind: 'committed' })
               closeAfterCommit()
               return
             }
             if (result.kind === 'error') {
               const message = sanitizeTerminalText(result.text ?? 'fresh session creation failed')
               notifyFailure(message)
               finish({ kind: 'failed', message })
               return
             }
             // A silent superseded/success result created no Session: no close,
             // no success, and the pending operation is released for a retry.
             finish({ kind: 'not-committed' })
           },
           onError: (error) => {
             const message = sanitizeTerminalText(safeErrorMessage(error))
             notifyFailure(message)
             finish({ kind: 'failed', message })
           },
           onCancel: () => finish({ kind: 'cancelled' }),
         })
       },
       onUseDirectory: (workspaceId, canonicalPath) => {
         workspaceNextIntent.setResolvedWorkspace(workspaceId, canonicalPath)
         runner.updateWelcomeCard()
         if (runner.currentSessionId !== undefined) return
         runOwned(
           'workspace standing catalog refresh',
           () => runner.refreshStandingCatalog(runner.effectivePresetId, 'invalidation'),
           {
             diag: runner.diag,
             sessionId: () => runner.currentSessionId,
             onResult: (outcome) => {
               if (outcome.kind === 'applied' && outcome.notice !== undefined) notify(outcome.notice, 'error')
             },
             onError: (error) => notify(`workspace skill refresh failed: ${safeErrorMessage(error)}`, 'error'),
           },
         )
       },
       onAddDirectory: (path, settle) => {
         const token = workspaceNextIntent.beginPathVerification(path)
         let settled = false
         const finish = (outcome: import('../../app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement): void => {
           if (settled) return
           settled = true
           settle(outcome)
         }
         runOwned('workspace directory verification', () => runner.agents.resolveWorkspace(token.intent, runner.signal), {
           diag: runner.diag,
           sessionId: () => runner.currentSessionId,
           isCancellation: () => runner.signal.aborted || !token.isCurrent(),
           onResult: (resolved) => {
             if (!token.isCurrent()) return
             workspaceNextIntent.commitVerifiedPath(token, resolved.workspaceId, resolved.path)
             runner.updateWelcomeCard()
             finish({ kind: 'registered', workspaceId: resolved.workspaceId, path: resolved.path })
             if (runner.currentSessionId !== undefined) return
             runOwned(
               'workspace standing catalog refresh',
               () => runner.refreshStandingCatalog(runner.effectivePresetId, 'invalidation'),
               {
                 diag: runner.diag,
                 sessionId: () => runner.currentSessionId,
                 onResult: (outcome) => {
                   if (outcome.kind === 'applied' && outcome.notice !== undefined) notify(outcome.notice, 'error')
                 },
                 onError: (error) => notify(`workspace skill refresh failed: ${safeErrorMessage(error)}`, 'error'),
               },
             )
           },
           onCancel: () => finish({ kind: 'failed', message: 'Directory verification was superseded.' }),
           onError: (error) => {
             const message = safeErrorMessage(error)
             workspaceNextIntent.rejectPathVerification(token, message)
              runner.updateWelcomeCard()
             finish({ kind: 'failed', message })
           },
         })
       },
       onResumeIntent: (intent, scope, settle, isCurrent) => {
         if (signal.aborted
          || !runner.isSessionScopeCurrent(scope)
          || intent.currentSessionId !== scope.sessionId
          || intent.sessionId === scope.sessionId) {
          settle({ kind: 'cancelled' })
          return
        }
        const direct = intent.source === 'direct'
        const fail = (text: string): void => {
          // A closed/replaced INTERACTIVE panel must never paint its late
          // failure into a new Browser context. A DIRECT /resume is a
          // command-owned settlement (no global notice): its real outcome is
          // returned to the originating command card even though the picker
          // has already closed.
          if (!direct && !isCurrent()) {
            settle({ kind: 'cancelled' })
            return
          }
          if (!direct) presentation.notify(sanitizeTerminalText(text), 'error')
          settle({ kind: 'failed', text })
        }
        // The Browser's `resumePending` is the non-terminal indicator; the
        // command owner receives the real outcome below. Do not paint a
        // transient notice from inside the read-owner callback: a presentation
        // may already be closed/replaced.
        runOwned('session browser resume', () => switchSessionOutcome(intent.sessionId, scope), {
          diag: runner.diag,
          sessionId: () => intent.sessionId,
          isCancellation: () => runner.signal.aborted,
          onResult: (outcome) => {
            switch (outcome.kind) {
              case 'committed':
                settle({ kind: 'switched', sessionId: intent.sessionId })
                break
              case 'already-current':
              case 'failed':
                fail(outcome.message)
                break
              case 'indeterminate':
                if (direct) settle({ kind: 'indeterminate', text: outcome.message })
                else fail(outcome.message)
                break
              case 'superseded':
                if (direct) settle({ kind: 'failed', text: outcome.message })
                else settle({ kind: 'cancelled' })
                break
              case 'cancelled':
                settle({ kind: 'cancelled' })
                break
            }
          },
          onCancel: () => settle({ kind: 'cancelled' }),
          onError: (error) => {
            fail(`session switch failed: ${sanitizeTerminalText(safeErrorMessage(error))}`)
          },
        })
      },
    })
    return nativeReadOwner
  }

  /** The narrow open options the three Session Browser entries really need
   * (plan §8.2) — not a controller/framework abstraction. */
  interface SessionPickerOpenOptions {
    readonly header: PiTuiOpenIntent['header']
    /** The PiTUI Host Editor gesture asks for the All-workspaces initial
     * browse scope; every typed/pre-existing caller omits it (Current). */
    readonly browseScope?: 'current' | 'all'
    readonly addDirectory?: boolean
    readonly initialDirectoryEntry?: boolean
    readonly initialDirectoryPath?: string
    /** `/resume <arg>` direct id/prefix lookup query. */
    readonly directMatchQuery?: string
    /** `/search` only: the query is required — an empty argument is
     * rejected BEFORE the overlay opens. */
    readonly requireQuery?: boolean
  }
  const openNativeSessionBrowser = (
    invocation: { rawInput: string; commandId?: string },
    options: SessionPickerOpenOptions,
    presentation: SessionBrowserPresentation,
  ): Promise<{ kind: 'success' } | { kind: 'error'; text: string }> => {
    const initialQuery = options.header === 'sessions' || options.header === 'search'
      ? invocation.rawInput.trim()
      : undefined
    const directMatch = options.directMatchQuery === undefined
      ? undefined
      : {
          query: options.directMatchQuery,
          find: (rows: readonly SessionPickerRow[], query: string) => findSessionMatch(rows, query),
        }
    // `open()` captures the typed `/resume` scope SYNCHRONOUSLY (before any
    // listing await), so a navigation that wins during the listing leaves this
    // intent superseded instead of falling back to an unscoped gate capture.
    const handle = nativeReadOwnerFor(presentation).open({
      ...(initialQuery === undefined ? {} : { initialQuery }),
      ...(directMatch === undefined ? {} : { directMatch }),
      initialDirectoryChooser: options.addDirectory === true,
      ...(options.initialDirectoryEntry ? { initialDirectoryEntry: true } : {}),
      ...(options.initialDirectoryPath === undefined ? {} : { initialDirectoryPath: options.initialDirectoryPath }),
    })
    if (directMatch === undefined) return Promise.resolve({ kind: 'success' })
    return handle.settlement.then(async (result: SessionBrowserReadSettlement) => {
      if (result.kind === 'matched') {
        const resume: SessionBrowserResumeSettlement = await handle.resumeSettlement
        if (resume.kind === 'switched') return { kind: 'success' }
        if (resume.kind === 'indeterminate') {
          // A Host-side open may already have happened; the draft must not be
          // restored as a plain retry intent.
          recordCommandDraftDisposition(invocation.commandId, 'suppressed')
          return { kind: 'error', text: resume.text }
        }
        return { kind: 'error', text: resume.kind === 'failed' ? resume.text : 'resume cancelled' }
      }
      if (result.kind === 'ready') return { kind: 'success' }
      if (result.kind === 'refused') return { kind: 'error', text: result.text }
      return { kind: 'error', text: 'resume cancelled' }
    })
  }

  /** Open the ONE Session Browser: the native TSP Presenter when the renderer
   * provides one, otherwise the PiTui Picker Presentation. Both consume the
   * same `SessionBrowserReadOwner` snapshot and the same resume settlement. */
  const openSessionPicker = (
    invocation: { rawInput: string; commandId?: string },
    options: SessionPickerOpenOptions,
  ): Promise<{ kind: 'success' } | { kind: 'error'; text: string }> => {
    if (options.requireQuery === true && invocation.rawInput.trim() === '') {
      return Promise.resolve({ kind: 'error', text: 'search needs a query' })
    }
    const presentation = runner.sessionBrowserPresentation
    if (presentation !== undefined) return openNativeSessionBrowser(invocation, options, presentation)
    // The ONE PiTUI fullscreen Workspace renders the same read owner. The
    // per-open intent is captured synchronously before the read owner can open
    // the panel; the presenter consumes and resets it inside `open()`.
    const raw = invocation.rawInput.trim()
    piTuiOpenIntent = {
      header: options.header,
      scope: options.browseScope ?? 'current',
      // `/sessions <query>` and `/search <query>` open the global editor; the
      // bare commands open the browse list. A typed `/resume` still tries its
      // direct match first and only falls back to the editor through the read
      // owner's one-shot seed.
      searchRequested: options.header === 'search' || (options.header === 'sessions' && raw !== ''),
    }
    try {
      return openNativeSessionBrowser(invocation, options, piTuiPresentation)
    } catch (error) {
      // A synchronous fullscreen-lease refusal (blocking modal, another
      // workspace, a transition freeze) is ONE real command error; the read
      // owner already retired its panel and started no Host read.
      piTuiOpenIntent = undefined
      return Promise.resolve({
        kind: 'error',
        text: `session workspace unavailable: ${sanitizeTerminalText(safeErrorMessage(error))}`,
      })
    }
  }

  // Shared by /title and its /rename alias. With an argument, pins the
  // session title (explicit user rename). WITHOUT an argument, regenerates
  // it from the conversation through the sessionTitle service's explicit
  // refresh — the deliberate unpin: regeneration OVERWRITES the current
  // title, including one the user pinned earlier. A blank session (no user
  // message yet) leaves the title untouched and informs the user.
  const titleHandler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const scope = await runner.requireLiveSessionScope()
    const current = (): boolean => !runner.signal.aborted && runner.isSessionScopeCurrent(scope)
    // NOTE (PR4-B2-A): these terminal error outcomes deliberately get NO extra
    // notice. Their existing owners are the Direct command card and — on the
    // sessionless local-command path — the controller's own error notice; a
    // third line from here would be a duplicate on the same Dock.
    const stale = (): CommandResult => ({
      kind: 'error',
      text: 'the session changed while updating the title — try again',
    })
    const transitioning = (): CommandResult => ({
      kind: 'error',
      text: 'a session transition is in progress — try again in a moment',
    })
    const name = invocation.rawInput.trim()
    let acceptedTitle = name
    if (name !== '') {
      // The complete title write runs through the session barrier and the
      // semantic writer. Both checks fence a delayed command result from a
      // session that has already been replaced.
      try {
        const outcome = await runner.withWriter(scope, async () => {
          if (!current()) return undefined
          return runner.sessionWriter.rename(scope.sessionId, name)
        })
        if (!current() || outcome === undefined) return stale()
        if (outcome.kind === 'committed') acceptedTitle = outcome.value.title
        if (outcome.kind !== 'committed') {
          if (outcome.kind === 'cancelled') throw cancellationError('session title write cancelled')
          if (outcome.kind === 'indeterminate') {
            recordCommandDraftDisposition(invocation.commandId, 'suppressed')
            const message = 'session title result is indeterminate — do not retry automatically'
            // PR5 (external review F5): the suppressed draft must NOT be the
            // only outcome — on the Remote Client-owned command path there is
            // no official command card either, so the indeterminate no-retry
            // notice is emitted with the same inline pattern as the rejected
            // branch below and the `/preset`/`/model` handlers. PR4-B2-A: the
            // entry is the title-scoped result sink, so the TSP Dock receives it
            // ONLY where the command-result card does not already carry the same
            // text (RFL-001), and the PiTui notice is unchanged.
            notifyTitleRefusal(message)
            return { kind: 'error', text: message }
          }
          const message = outcome.kind === 'rejected' ? outcome.error.message : outcome.reason
          // PR5 (Slice C1): the Remote Client-owned command path renders no
          // official command card (the Host executor's `command/run` row does
          // not exist there), so the handler surfaces its own refusal — the
          // same inline notice the `/preset` and `/model` handlers already
          // emit. On Direct this is a transient notice beside the command card
          // on PiTui, and is suppressed on the TSP renderer where that card is
          // the single owner of the same text. The rejected branch is the
          // writer-held (`session/writer-held`) proven pre-commit refusal: its
          // message is the centralized guidance.
          notifyTitleRefusal(message)
          return { kind: 'error', text: message }
        }
      } catch (error) {
        if (error instanceof TransitionInProgressError) return transitioning()
        if (error instanceof SessionScopeSupersededError) return stale()
        if (isCancellation(error)) throw error
        return { kind: 'error', text: safeErrorMessage(error) }
      }
      // PR4-B2-A: the confirmed authoritative title write. The notice is the
      // text-bearing result's fallback where the official command-result card
      // does not carry it; on the TSP Direct mount the card IS the single owner.
      notifyTitleSuccess(`title set: ${acceptedTitle}`)
      return { kind: 'success', text: `title set: ${acceptedTitle}` }
    }
    try {
      const outcome = await runner.withWriter(scope, async () => {
        if (!current()) return undefined
        return runner.sessionWriter.refreshTitle(scope.sessionId, invocation.signal)
      })
      if (!current() || outcome === undefined) return stale()
      if (outcome.kind === 'unsupported') {
        return { kind: 'error', text: outcome.reason }
      }
      if (outcome.title === undefined) {
        notify('no conversation yet — title left as-is', 'info')
        return { kind: 'success' }
      }
      notify(`title regenerated: ${outcome.title}`, 'info')
      return { kind: 'success' }
    } catch (error) {
      if (error instanceof TransitionInProgressError) return transitioning()
      if (error instanceof SessionScopeSupersededError) return stale()
      if (isCancellation(error)) throw error
      return { kind: 'error', text: safeErrorMessage(error) }
    }
  }

  /**
   * TSP-7 Welcome D: the ONE `/sessions` open body. The typed command passes
   * its own invocation (so a `/sessions <query>` argument still seeds the
   * Browser); the Welcome's UI entry passes an empty one. Both are the SAME
   * shared lifecycle — one picker generation, one read owner, one query and
   * one switch route — never a second listing or a copied presenter. The
   * PiTUI Host Editor `←←` gesture is the ONE caller that passes `'all'`
   * (its frozen initial scope); the typed and Welcome entries keep Current.
   */
  const openSessionsBody = async (
    invocation: { rawInput: string; commandId?: string },
    options: 'current' | 'all' | {
      readonly scope?: 'current' | 'all'
      readonly addDirectory?: boolean
      readonly initialDirectoryEntry?: boolean
      readonly initialDirectoryPath?: string
    } = 'current',
  ): Promise<CommandResult> => {
    // A sessionless Browser's subject may name the launch Workspace only after
    // the mount preflight commits; open the ONE owner with that confirmed
    // destination instead of a transient "no current Workspace" state.
    if (runner.captureSessionScope().sessionId === undefined) await runner.awaitWorkspacePreflight?.()
    return openSessionPicker(invocation, {
      header: 'sessions',
      browseScope: typeof options === 'string' ? options : options.scope,
      addDirectory: typeof options === 'string' ? false : options.addDirectory,
      initialDirectoryEntry: typeof options === 'string' ? false : options.initialDirectoryEntry,
      initialDirectoryPath: typeof options === 'string' ? undefined : options.initialDirectoryPath,
    })
  }

  const registerSessions = (): void => {
    registerTuiCommand({
      name: 'sessions',
      description: 'List, search, and switch persisted sessions',
      input: { hint: '[query]' },
      handler: (invocation) => openSessionsBody(invocation),
      aliases: ['resume'],
      // /resume keeps its direct-resume fast path (exact id, a session-
      // prefixed prefix, or the short id prefix) — resolved against the ONE
      // input-first listing inside the shared picker lifecycle: the overlay
      // opens immediately, and a unique match switches as soon as `list()`
      // lands. No match leaves the filtered picker with the argument as the
      // live search query (content search included). Never a second listing.
      aliasHandlers: {
        resume: async (invocation) => {
          const raw = invocation.rawInput.trim()
          // The ARGUMENT-FREE `/resume` is the same sessionless Browser entry
          // as `/sessions`: it must not capture a transient no-Current subject
          // before the mount preflight commits. An explicit argument keeps its
          // direct match path.
          if (raw === '' && runner.captureSessionScope().sessionId === undefined) await runner.awaitWorkspacePreflight?.()
          return openSessionPicker(invocation, {
            header: 'resume',
            directMatchQuery: raw === '' ? undefined : raw,
          })
        },
      },
    })
  }

  /**
   * The SYNCHRONOUS `/new` single-flight marker. It is set in the handler's
   * first synchronous step — BEFORE the scope capture's first await and
   * before the transition gate — and released at the transaction's true
   * terminal settlement (success, failure or supersession), so a failed
   * `/new` can always be retried and a later settled `/new` starts normally.
   * A second intent that arrives while one is in flight is refused BEFORE any
   * Host dispatch: it never reuses the first result, never creates a second
   * Session and never consumes the old drafts.
   *
   * This is deliberately NOT `gate.busy`: the transition gate also serializes
   * `/preset`, session switches and fork adoption, which are legitimate
   * concurrent operations and must not refuse a `/new` that is merely queued.
   */
  let freshSessionInFlight = false

  /**
   * The internal `/new` settlement. Every ordinary branch keeps its exact
   * `CommandResult`; a proven pre-create Host Workspace refusal additionally
   * carries the typed failure and the captured subject, so ONLY the `/new`
   * entry can decide whether that refusal may open recovery navigation.
   * Folder `New session` consumes the same settlement but never navigates.
   */
  type NewSessionSettlement =
    | { readonly kind: 'done'; readonly result: CommandResult }
    | {
        readonly kind: 'workspace-refused'
        readonly result: CommandResult
        readonly failure: WorkspaceSelectionError
        readonly subject: SessionScope
      }

  const startNewSession = async (options: {
    readonly workspaceIntent?: WorkspaceSelectionIntent
    readonly source: 'command' | 'folder'
    /** Called ONLY after `transitionTo` confirmed a real commit. It observes
     *  the one genuine commit checkpoint without changing the transaction. */
    readonly onCommitted?: () => void
  }): Promise<NewSessionSettlement> => {
        const done = (result: CommandResult): NewSessionSettlement => ({ kind: 'done', result })
        if (freshSessionInFlight) {
          return done({ kind: 'error', text: 'a fresh session is already starting' })
        }
        freshSessionInFlight = true
        // The ORIGINAL session generation/navigation identity, captured
        // SYNCHRONOUSLY: a Direct (`stop-and-quiesce`) navigation stop must
        // address exactly the owner the user chose to leave, never a
        // replacement published while this intent waited behind another
        // transition; a Remote (`detach-client`) navigation uses the same
        // capture only for its stale/superseded fence. The runtime fills in
        // `admission.oldStopAccepted` before the transaction body runs (false
        // when no Host stop is dispatched).
        const navigation: NavigationIntent = {
          scope: runner.captureSessionScope(),
          admission: { oldStopAccepted: false },
        }
        // The quiesce callback is the ONLY proof that the old Turn reached
        // idle. An accepted stop is just a REQUEST until then.
        let oldOwnerQuiesced = false
        const stopNote = (): string => {
          if (!navigation.admission.oldStopAccepted) return ''
          return oldOwnerQuiesced
            ? '; old turn stopped (cannot resume)'
            : '; turn stop requested (not yet confirmed)'
        }
        try {
          // WS-2 Workspace pre-selection BEFORE the navigation transition: a
          // refused directory, an unknown Workspace or an offline Host must not
          // stop the old owner, flush/consume drafts or dispatch a Session.
          // `source-session` asks for the captured Session's official Host
          // membership (never the Client launch/effective cwd); a sessionless
          // `/new` offers the Client launch directory as a Host path proposal.
          let nextIntentCapture: ReturnType<typeof workspaceNextIntent.capture> | undefined
          let intent: WorkspaceSelectionIntent
          // The sessionless mount may still be verifying the launch directory:
          // wait for that ONE request before capturing, so its committed
          // revision is the one this create revalidates (never a stale token).
          if (navigation.scope.sessionId === undefined) {
            // EVERY sessionless start (including an explicit Folder
            // workspace-id) consumes the next-intent capture, so all of them
            // must wait for the mount preflight's committed revision.
            await runner.awaitWorkspacePreflight?.()
          }
          if (options.workspaceIntent !== undefined) {
            if (navigation.scope.sessionId === undefined) nextIntentCapture = workspaceNextIntent.capture()
            intent = options.workspaceIntent
          } else if (navigation.scope.sessionId === undefined) {
            nextIntentCapture = workspaceNextIntent.capture()
            if (nextIntentCapture === undefined) {
              // UNSELECTED: there is no Host Workspace to create in. Refuse
              // BEFORE any transition/stop/flush; the Welcome's existing
              // Browser entry is the one place to choose one.
              return { kind: 'error', text: 'Choose a Host workspace before starting a session' }
            }
            intent = nextIntentCapture.intent
          } else {
            intent = { kind: 'source-session', sessionId: navigation.scope.sessionId }
          }
          let workspace: ResolvedWorkspaceSelection
          try {
            workspace = await runner.agents.resolveWorkspace(intent, signal)
          } catch (error) {
            // A cancellation-shaped resolution rejection is NOT a user-visible
            // failure: it propagates to the owned task's cancellation
            // settlement. The Direct/Remote adapters map an abort of a
            // pre-commit selection to WorkspaceSelectionError('superseded'),
            // which stays the documented silent/no-ownership path below.
            if (isCancellation(error)) throw error
            if (!runner.isSessionScopeCurrent(navigation.scope)
              || (nextIntentCapture !== undefined && !nextIntentCapture.isCurrent())
              || (error instanceof WorkspaceSelectionError && error.kind === 'superseded')) {
              // A stale/superseded selection owns nothing: silent, exactly like
              // a superseded create. Nothing was stopped, flushed or created.
              return done({ kind: 'success' })
            }
            if (error instanceof WorkspaceSelectionError
              && recoverableWorkspaceSelection(error).kind === 'select-workspace') {
              // The Host proved a PRE-CREATE refusal the user can fix by
              // choosing another Workspace. Only `registerNew` may act on it.
              return {
                kind: 'workspace-refused',
                result: { kind: 'error', text: `fresh session creation failed: ${safeErrorMessage(error)}` },
                failure: error,
                subject: navigation.scope,
              }
            }
            return done({ kind: 'error', text: `fresh session creation failed: ${safeErrorMessage(error)}` })
          }
          if (nextIntentCapture !== undefined && !nextIntentCapture.isCurrent()) {
            return done({ kind: 'error', text: 'workspace selection changed before fresh session creation' })
          }
          if (!runner.isSessionScopeCurrent(navigation.scope)) return done({ kind: 'success' })
          return done(await runner.withSessionTransition(async () => {
            // The unified transaction: the old session is flushed BEFORE the
            // fresh session is created, the commit is synchronous, and a failure
            // anywhere before the create leaves the current session untouched
            // (no published child to roll back).
            const sessionId = newSessionId()
            // The concrete preset id is resolved ONCE and rides the create (a
            // rejected create is NEVER retried — the old session stays current).
            // The preset COMPOSITION (setup callback) is resolved inside the
            // Direct session lifecycle from this id — the command surface only
            // ever sees the identity (migration M1.11).
            let resolved
            try {
              resolved = await runner.catalog.presets.resolve(runner.effectivePresetId, runner.signal)
            } catch (error) {
              // A lifecycle cancellation (exit/HMR) during the read aborts it: no
              // create is dispatched, and the owned task settles it AS a
              // cancellation. Any OTHER failure keeps its real diagnostic — never
              // mislabeled as a cancellation.
              if (isCancellation(error) || runner.signal.aborted) throw error
              return { kind: 'error', text: `fresh session creation failed: ${safeErrorMessage(error)}${stopNote()}` }
            }
            // Coordinate with the newest sessionless `/model` global-default write
            // BEFORE dispatching the create (v2 §0.8.3/§0.8.4): quiesce EVERY
            // in-flight default write/correction so the Direct adapter captures the
            // settled Host default. A failed latest intent is NOT seeded into the
            // create — the fresh Session uses the actual Host default.
            try {
              await runner.awaitPendingDefaultWrite(signal)
            } catch (error) {
              // The lifetime signal aborted while waiting for the default write:
              // no create is dispatched (the old session stays current) and the
              // owned task settles the abort as a cancellation.
              if (isCancellation(error) || runner.signal.aborted) throw error
              return { kind: 'error', text: `fresh session creation failed: ${safeErrorMessage(error)}${stopNote()}` }
            }
            const result = await runner.transitionTo({
              // The Host-verified canonical Workspace directory is a display
              // hint only; the durable header cwd is resolved by the Host from
              // the Workspace id below.
              target: { id: String(sessionId), header: { cwd: workspace.path } },
              onOldOwnerQuiesced: () => { oldOwnerQuiesced = true },
              create: async () => {
                // Re-wait immediately before dispatch: a newer sessionless /model may
                // have started between the first wait and here, and the Direct
                // adapter activates the Agent from the persisted Host default.
                await runner.awaitPendingDefaultWrite(signal)
                if (nextIntentCapture !== undefined && !nextIntentCapture.isCurrent()) {
                  throw new WorkspaceSelectionError('superseded', 'workspace selection changed before fresh session creation')
                }
                return runner.agents.create({
                  sessionId: String(sessionId),
                  // The official Host Workspace identity is the ONE directory
                  // authority; no cwd crosses this request. The Host resolves
                  // the durable directory from its own registry.
                  workspaceId: workspace.workspaceId,
                  // The semantic `agentPreset` is the SINGLE preset authority; the
                  // Direct adapter persists the actually composed preset into the
                  // durable header. Never duplicate it into generic meta.
                  agentPreset: resolved.id,
                })
              },
            })
            if (!result.ok) {
              if (result.error instanceof LifecycleError) {
                // Preserve the machine-readable cause (incl. a published identity for
                // D2.4 reconciliation) even on the UI-silent superseded path.
                runner.diag.warn('fresh session create did not own the surface', {
                  settlement: result.error.settlement,
                  ownership: result.error.ownership,
                  publishedSessionId: result.error.publishedSessionId,
                  requestedSessionId: result.error.requestedSessionId,
                })
                // A locally SUPERSEDED create emits no error notice and NO
                // user-visible success text (§0.2.1): the surface moved, so this
                // result owns nothing. The machine-readable cause (incl. any
                // published id) is already recorded in the diagnostic above.
                if (result.error.ownership === 'superseded') return { kind: 'success' }
              }
              return { kind: 'error', text: `${result.message}${stopNote()}` }
            }
            // The ONE genuine commit checkpoint: the transition really
            // published the fresh Session. A later local cleanup failure must
            // not turn this into a pre-commit failure.
            options.onCommitted?.()
            if (nextIntentCapture !== undefined) {
              workspaceNextIntent.consumeAfterCommittedCreate(nextIntentCapture)
            }
            // The transaction COMMITTED: staged drafts are per-TUI-run UI state —
            // drop the unpinned ones now, never before (a failed create keeps
            // the current session and its drafts intact; in-flight submissions
            // keep their pinned drafts — review finding 2).
            runner.imageStore.clearUnpinned()
            runner.fileStore?.clearUnpinned()
            return { kind: 'success', text: 'started a fresh session' }
          }, navigation))
        } catch (error) {
          if (error instanceof SessionNavigationStopError) {
            // A stale capture is a locally SUPERSEDED navigation (another
            // navigation already published): the surface moved, so this result
            // owns nothing — silent, exactly like the superseded create path.
            // A refused/unproven stop aborts BEFORE any child work; the message
            // already states whether the old Turn may have been stopped.
            if (error.settlement === 'stale') return done({ kind: 'success' })
            return done({ kind: 'error', text: `fresh session creation failed: ${error.message}` })
          }
          if (isCancellation(error) || runner.signal.aborted) throw error
          // The transition can THROW after the quiesce (a synchronous commit
          // seam): keep the phase fact in the user-visible failure instead of
          // letting the generic command path drop it.
          return done({ kind: 'error', text: `${safeErrorMessage(error)}${stopNote()}` })
        } finally {
          freshSessionInFlight = false
        }
  }

  /**
   * The ONLY `/new` auto-recovery entry. A proven pre-create Host refusal may
   * open the SAME full Workspace Browser read-only; the user must then choose a
   * Folder and explicitly activate its `New session` (no create is dispatched
   * here). The single-flight is already released by `startNewSession`'s own
   * `finally` before this opens anything.
   */
  const runNewCommandWithRecovery = async (): Promise<CommandResult> => {
    const settled = await startNewSession({ source: 'command' })
    if (settled.kind === 'done') return settled.result
    // A refusal whose captured subject is no longer current owns nothing: no
    // error card and no Browser for a Session the user already left.
    if (!runner.isSessionScopeCurrent(settled.subject) || runner.signal.aborted) return { kind: 'success' }
    if (recoverableWorkspaceSelection(settled.failure).kind !== 'select-workspace') return settled.result
    // A native renderer without a Session Browser presenter has no fallback:
    // the original error text stays with the command's existing owner.
    const piTuiMounted = (app as TuiApp | undefined) !== undefined
    if (!piTuiMounted && runner.sessionBrowserPresentation === undefined) return settled.result
    // This is the ONLY /new auto-Browse entry. No `addDirectory` and no
    // initial-directory options: the sessionless chooser must keep its Folder
    // click meaning, and the recovery is always the full tree.
    const opened = await openSessionsBody({ rawInput: '' }, 'all')
    if (opened.kind === 'error') {
      // The Browser never opened: the command result stays the ONE visible
      // owner, and it keeps BOTH facts (the recovery could not be presented and
      // the original Host refusal) instead of silently dropping either.
      const refusal = settled.result.kind === 'error' ? settled.result.text : ''
      return refusal === undefined || refusal === ''
        ? opened
        : { kind: 'error', text: `${opened.text} — ${refusal}` }
    }
    const message = settled.result.kind === 'error' ? settled.result.text : undefined
    if (message !== undefined && message !== '') notify(message, 'error')
    return { kind: 'success' }
  }

  const registerNew = (): void => {
    registerOne({
      name: 'new',
      description: 'Start a fresh session in this workspace',
      handler: () => runNewCommandWithRecovery(),
    })
  }

  const registerSearch = (): void => {
    registerOne({
      name: 'search',
      description: 'Search persisted sessions for text and switch to a hit',
      input: { hint: '<query>' },
      // /search is a compatibility entry into the SAME Session Browser as
      // /sessions and /resume (plan §8): the query is required (rejected
      // before the overlay opens), then becomes the picker's live filter and
      // feeds the debounced Host content search. There is no second picker.
      handler: (invocation) => openSessionPicker(invocation, { header: 'search', requireQuery: true }),
    })
  }

  const registerTitle = (): void => {
    registerTuiCommand({
      name: 'title',
      description: 'Set the session title; without an argument, regenerate it from the conversation when supported (overwrites the current title)',
      input: { hint: '<title>' },
      aliases: ['rename'],
      handler: titleHandler,
    })
  }

  const registerFork = (): void => {
    registerOne({
      name: 'fork',
      description: 'Fork this session at the Host-selected latest completed prefix',
      handler: async () => {
        // A sessionless-capable capture that never creates a Session: /fork
        // without a conversation refuses instead of starting one.
        const scope = runner.captureSessionScope()
        const sourceSessionId = scope.sessionId
        if (sourceSessionId === undefined) return { kind: 'error', text: 'no conversation to fork from' }
        if (runner.forkSession === undefined) {
          return { kind: 'error', text: 'session fork is unavailable in this backend' }
        }
        // The command captures only the source identity. Host fork owns the
        // boundary, child identity, lineage, workspace and model/preset policy;
        // runner.forkSession owns the independently supersedable navigation.
        return runner.forkSession(sourceSessionId)
      },
    })
  }

  const registerRewind = (): void => {
    registerOne({
      name: 'rewind',
      description: 'Fork this conversation from an earlier user turn (the workspace is not reverted)',
      handler: () => {
        // The SAME surface as the idle empty-editor double-Esc — one
        // implementation, two entries (plan §22). Sessionless it notifies
        // "no conversation to rewind" and never creates a session.
        runner.openRewindPicker()
        return { kind: 'success' }
      },
    })
  }

  return {
    registerSessions,
    registerNew,
    registerSearch,
    registerTitle,
    registerFork,
    registerRewind,
    // TSP-7 Welcome D: the argument-free UI entry over the SAME body.
    openSessions: (scope: 'current' | 'all' | {
      readonly scope?: 'current' | 'all'
      readonly addDirectory?: boolean
      readonly initialDirectoryEntry?: boolean
      readonly initialDirectoryPath?: string
    }) => openSessionsBody({ rawInput: '' }, scope),
  }
}
