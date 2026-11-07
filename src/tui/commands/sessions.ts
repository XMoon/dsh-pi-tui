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
import type { PickerCategory, PickerHandle, TuiApp } from '../../tui-app.ts'
import { createSessionBrowserReadOwner, type SessionBrowserReadOwner, type SessionBrowserReadSettlement, type SessionBrowserResumeSettlement } from '../../app/command/session-browser-read.ts'
import type {
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
  SessionBrowserSearchResult,
  SessionBrowserSubject,
} from '../../app/command/session-browser-presentation.ts'
import { TransitionInProgressError } from '../../app/session/operation-barrier.ts'
import { SessionScopeSupersededError, type SessionScope } from '../../app/session/scope.ts'
import { SessionNavigationStopError, type NavigationIntent } from '../../app/session/transition.ts'
import type { SessionSwitchOutcome } from '../../app/session/runtime.ts'
import { cancellationError, isCancellation, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { LifecycleError, WorkspaceSelectionError, type ResolvedWorkspaceSelection } from '../../runtime/session-lifecycle-port.ts'
import {
  buildSessionTree,
  findSessionMatch,
  sameWorkspace,
  sanitizeTerminalText,
  sessionLabelParts,
  sessionSearchItem,
  sessionPickerItem,
  type SessionPickerItem,
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
  | 'captureSessionScope'
  | 'catalog'
  | 'currentSessionId'
  | 'cwd'
  | 'diag'
  | 'effectivePresetId'
  | 'fileStore'
  | 'forkSession'
  | 'imageStore'
  | 'isSessionScopeCurrent'
  | 'openRewindPicker'
  | 'requireLiveSessionScope'
  | 'sessionCwd'
  | 'sessionReader'
  | 'sessionBrowserPresentation'
  | 'sessionWriter'
  | 'signal'
  | 'switchSession'
  | 'switchSessionOutcome'
  | 'transitionTo'
  | 'withSessionTransition'
  | 'withWriter'
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
   */
  openSessions(): Promise<CommandResult>
}

/** Shorten a session id for read-only display rows, capped at 28 characters. */
export function displaySessionId(id: string): string {
  return id.length > 28 ? `${id.slice(0, 28)}…` : id
}

export function sessionPickerCategories(
  rowsOf: () => readonly SessionPickerRow[],
  currentCwd: string,
  header: string,
  itemFor: (row: SessionPickerRow, indent?: number) => SessionPickerItem,
  placeholder?: () => SessionPickerItem,
): PickerCategory[] {
  return [
    {
      id: 'current',
      label: 'Current directory',
      header: `${header} · Current directory`,
      // The same flat list as "All directories", built over the CURRENT
      // workspace's subset. This category excludes subagent rows, and an rc.1
      // ordinary fork has no parent edge (legacy ordinary-fork parentSession
      // metadata is flat too), so every row stays at depth 0 — never lost,
      // never mis-nested under an unrelated root.
      items: () => {
        const rows = rowsOf()
        const mainRows = rows.filter(row => row.origin !== 'subagent')
        if (rows.length === 0 && placeholder !== undefined) return [placeholder()]
        return buildSessionTree(
          mainRows.filter(row => sameWorkspace(row.cwd, currentCwd)),
        ).map(entry => itemFor(entry.row, entry.depth))
      },
    },
    {
      id: 'all',
      label: 'All directories',
      header: `${header} · All directories`,
      // This category lists only non-subagent rows: rc.1 ordinary forks carry
      // no parent edge, and legacy ordinary-fork parentSession metadata never
      // fabricates one, so the list is flat. The shared `buildSessionTree`
      // contract (and its `placed` cycle guard) still owns real subagent
      // lineage wherever that tree is used.
      items: () => {
        const rows = rowsOf()
        const mainRows = rows.filter(row => row.origin !== 'subagent')
        if (rows.length === 0 && placeholder !== undefined) return [placeholder()]
        return buildSessionTree(mainRows).map(entry => itemFor(entry.row, entry.depth))
      },
    },
  ]
}

/**
 * The Session Browser's SEARCH projection category: a PURE presentation of the
 * shared read owner's already-merged `SessionBrowserSearchResult[]` (M5-U-B).
 * The owner owns the membership — the global union of metadata matches and the
 * bounded Host content page in Host page order — so this projection never
 * re-filters, never re-merges and never appends the query to a description.
 * The category is EXTERNALLY filtered: the SelectList renders without its
 * internal substring filter, because this projection's items ARE the
 * membership (a Host-authoritative hit is never dropped by a substring
 * re-filter, regardless of snippet length or query normalization). The
 * category is non-cyclable: Tab never leaves it while a query is active, and
 * browse mode skips it.
 */
export function sessionSearchCategory(options: {
  header: string
  /** The owner-merged results (Host page order), read at activation time. */
  results: () => readonly SessionBrowserSearchResult[]
  /** Whether the browse roster itself is non-empty. Only an empty roster is
   * replaced by the status/loading row: an empty RESULT set is a real "no
   * matches" state, not a status phase. */
  hasRoster: () => boolean
  /** The SEARCH item builder (the cwd joins the searchable description). */
  itemFor: (result: SessionBrowserSearchResult) => SessionPickerItem
  placeholder?: () => SessionPickerItem
}): PickerCategory {
  return {
    id: 'search',
    label: 'Search results',
    header: `${options.header} · Search results`,
    cyclable: false,
    externalFilter: true,
    items: () => {
      if (!options.hasRoster() && options.placeholder !== undefined) return [options.placeholder()]
      return options.results().map(result => options.itemFor(result))
    },
  }
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
  const { cwd, signal } = runner

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

  /** The Session Browser command edge under which the PiTui Picker opened. It
   * is written synchronously immediately before the shared read owner opens
   * the panel, so the presenter labels THIS open and nothing else. */
  type SessionBrowserHeader = 'sessions' | 'resume' | 'search'
  let piTuiBrowserHeader: SessionBrowserHeader = 'sessions'

  /** One PiTui Session Browser view: the physical Picker plus the per-open
   * presentation state. Every row, snippet and status comes from the shared
   * read owner's snapshot; this view owns no list, projection or search
   * lifecycle of its own (M5-U-B). */
  interface PiTuiBrowserPanel {
    readonly request: SessionBrowserPanelRequest
    readonly subject: SessionBrowserSubject
    picker: PickerHandle | undefined
    snapshot: SessionBrowserReadSnapshot
    disposed: boolean
    /** The Picker physically closed itself (select/Esc); the logical command
     * operation may still be pending. */
    physicalClosed: boolean
    /** The owner's one-shot editor seed has been consumed. */
    seedApplied: boolean
    /** The presenter is writing the seed itself: that filter change is NOT a
     * user edit and must not reach the read owner. */
    applyingSeed: boolean
    /** A real edit happened; the seed must never overwrite it. */
    userEdited: boolean
    /** Browse tab to restore when the query is cleared. */
    lastBrowseCategory: 'current' | 'all'
    /** A selection started a command-level resume operation. */
    selectionPending: boolean
    /** The last notice emitted for this snapshot stream (dedupe only). */
    lastNotice: string | undefined
  }

  const EMPTY_BROWSER_SNAPSHOT: SessionBrowserReadSnapshot = {
    listState: 'loading',
    rows: [],
    query: '',
    resumePending: false,
    searchState: 'idle',
    searchResults: [],
    hasMore: false,
  }

  /** The ONE PiTui Session Browser presentation. It renders the shared read
   * owner's snapshot through the existing Picker; the owner keeps the single
   * list/projection/search lifecycle (M5-U-B). */
  const createPiTuiSessionBrowser = (): SessionBrowserPresentation => {
    let active: PiTuiBrowserPanel | undefined

    /** The status row a category renders while its roster is still empty. */
    const statusRow = (panel: PiTuiBrowserPanel): SessionPickerItem => {
      const snapshot = panel.snapshot
      if (snapshot.listState === 'error') {
        return {
          value: '',
          label: `session listing failed: ${sanitizeTerminalText(snapshot.listError ?? 'unknown error')}`,
          description: '',
          group: '',
        }
      }
      if (snapshot.listState === 'unavailable') {
        // The store may hold logs the reader refuses: never claim there are
        // no persisted sessions (the S2 limited contract).
        return { value: '', label: 'session persistence unavailable', description: '', group: '' }
      }
      if (snapshot.listState === 'empty') {
        return { value: '', label: 'No readable sessions', description: '', group: '' }
      }
      return { value: '', label: 'Loading sessions…', description: '', group: '' }
    }

    /** Release this view ONCE. The owner-notification path must never call
     * back into the presenter's own `close()`; the physical Picker is closed
     * here regardless of which side retired it. */
    const release = (panel: PiTuiBrowserPanel, notifyOwner: boolean): void => {
      if (panel.disposed) return
      panel.disposed = true
      panel.physicalClosed = true
      panel.selectionPending = false
      if (active === panel) active = undefined
      panel.picker?.close()
      if (notifyOwner) panel.request.onClose()
    }

    /** Surface this open's Host/search/projection facts as ONE deduped notice
     * (the Host result first, the secondary projection failure second). */
    const emitNotice = (panel: PiTuiBrowserPanel): void => {
      const snapshot = panel.snapshot
      let key: string
      let text: string
      let kind: 'info' | 'error' = 'info'
      if (snapshot.searchState === 'unavailable') {
        key = 'search-unavailable'
        text = 'content search unavailable'
      } else if (snapshot.searchState === 'error') {
        key = `search-error:${snapshot.searchError ?? ''}`
        text = `session content search failed: ${sanitizeTerminalText(snapshot.searchError ?? 'unknown error')}`
        kind = 'error'
      } else if (snapshot.hasMore) {
        key = `search-more:${snapshot.query}`
        text = 'More content matches exist — refine the search.'
      } else if (snapshot.projectionError !== undefined) {
        // One notice per open: a persistent enrichment failure must not repeat
        // on every later snapshot (the Host/search result stays the primary).
        key = 'projection-error'
        text = `Some session details are unavailable: ${sanitizeTerminalText(snapshot.projectionError)}`
      } else {
        return
      }
      if (key === panel.lastNotice) return
      panel.lastNotice = key
      app.notify(text, kind)
    }

    /** Project the current snapshot onto the Picker: the search projection is
     * entered/left from the snapshot's canonical query, and a cleared query
     * restores the browse tab the user was last on. */
    const paint = (panel: PiTuiBrowserPanel): void => {
      if (panel.disposed || panel.physicalClosed) return
      const category = panel.picker?.getCategory?.()
      if (panel.snapshot.query !== '') {
        if (category === 'search') {
          panel.picker?.refresh?.()
        } else {
          if (category === 'current' || category === 'all') panel.lastBrowseCategory = category
          panel.picker?.setCategory?.('search')
        }
      } else if (category === 'search') {
        panel.picker?.setCategory?.(panel.lastBrowseCategory)
      } else {
        if (category === 'current' || category === 'all') panel.lastBrowseCategory = category
        panel.picker?.refresh?.()
      }
      emitNotice(panel)
    }

    const applySnapshot = (
      panel: PiTuiBrowserPanel,
      snapshot: SessionBrowserReadSnapshot,
      options?: { readonly initialQuery?: string },
    ): void => {
      if (panel.disposed) return
      panel.snapshot = snapshot
      if (panel.physicalClosed) {
        // The Picker is gone. Only an ACCEPTED resume handoff (the owner
        // published `resumePending` synchronously BEFORE dispatching the real
        // switch) may keep this command operation alive; its terminal
        // settlement releases the view exactly once. A stale subject is left
        // to the owner's own retirement, never re-entered from here.
        if (panel.selectionPending && snapshot.resumePending) return
        release(panel, panel.request.subject.isCurrent())
        return
      }
      paint(panel)
      // The one-shot initial seed: the owner's canonical query becomes the
      // editor text only while this panel has never been edited. The resulting
      // programmatic filter change is suppressed, so it can neither be mistaken
      // for a user edit nor mint another query generation.
      if (options?.initialQuery !== undefined && !panel.seedApplied && !panel.userEdited && !panel.disposed) {
        panel.seedApplied = true
        panel.applyingSeed = true
        try {
          panel.picker?.setFilter?.(options.initialQuery)
        } finally {
          panel.applyingSeed = false
        }
      }
    }

    const open = (request: SessionBrowserPanelRequest): SessionBrowserPanelHandle => {
      const previous = active
      if (previous !== undefined) release(previous, false)
      const header = piTuiBrowserHeader
      piTuiBrowserHeader = 'sessions'
      const panel: PiTuiBrowserPanel = {
        request,
        subject: request.subject,
        picker: undefined,
        snapshot: EMPTY_BROWSER_SNAPSHOT,
        disposed: false,
        physicalClosed: false,
        seedApplied: false,
        applyingSeed: false,
        userEdited: false,
        lastBrowseCategory: 'current',
        selectionPending: false,
        lastNotice: undefined,
      }
      active = panel
      const currentId = request.subject.currentSessionId ?? ''
      const browseItem = (row: SessionPickerRow, indent = 0): SessionPickerItem =>
        sessionPickerItem(row, currentId, indent)
      const searchItem = (result: SessionBrowserSearchResult): SessionPickerItem =>
        sessionSearchItem(
          result.row,
          currentId,
          0,
          result.snippet === undefined ? undefined : { snippet: result.snippet },
        )
      const categories = [
        ...sessionPickerCategories(
          () => panel.snapshot.rows,
          request.subject.currentCwd,
          header,
          browseItem,
          () => statusRow(panel),
        ),
        sessionSearchCategory({
          header,
          results: () => panel.snapshot.searchResults,
          hasRoster: () => panel.snapshot.rows.length > 0,
          itemFor: searchItem,
          placeholder: () => statusRow(panel),
        }),
      ]
      const picker = app.openPicker(
        categories[0]!.items(),
        (id) => {
          if (panel.disposed) return
          panel.physicalClosed = true
          // The loading/status placeholder and the current Session row end the
          // view; neither ever resumes.
          if (id === '' || id === currentId) {
            release(panel, true)
            return
          }
          panel.selectionPending = true
          request.onResumeIntent({
            sessionId: id,
            currentSessionId: request.subject.currentSessionId,
            source: 'enter',
          })
          // The owner accepts an intent ONLY by publishing `resumePending`
          // synchronously before it dispatches the real switch. Anything else
          // (stale subject, unlisted row, duplicate pending) ends this hidden
          // view immediately — no invisible active reader survives it.
          if (!panel.disposed && panel.snapshot.resumePending) return
          release(panel, panel.request.subject.isCurrent())
        },
        () => {
          release(panel, true)
        },
        {
          enableSearch: true,
          header: categories[0]!.header,
          noMatchText: '  no matching sessions',
          initialQuery: '',
          width: 76,
          maxHeight: 26,
          showHint: true,
          categories,
          signal,
          // The selected session's long title marquees; the row prefix (when
          // present) and the `●` current marker stay fixed (plan §7.6/§7.7).
          marquee: { labelPartsOf: sessionLabelParts },
          // Raw editor text is the Presenter's ONLY query input: the read owner
          // canonicalizes it (NUL → trim → cap) as the one search identity. The
          // one-shot programmatic seed is not a user edit.
          onFilterChange: (raw) => {
            if (panel.disposed || panel.applyingSeed) return
            panel.userEdited = true
            request.onQueryChange(raw)
          },
        },
      )
      panel.picker = picker
      return {
        isDisposed: () => panel.disposed,
        setSnapshot: (snapshot, options) => applySnapshot(panel, snapshot, options),
        close: () => release(panel, false),
      }
    }

    return {
      open,
      notify: (message, kind) => { app.notify(message, kind) },
    }
  }

  const piTuiPresentation = createPiTuiSessionBrowser()

  let nativeReadOwner: SessionBrowserReadOwner | undefined
  let nativePresentation: SessionBrowserPresentation | undefined

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
      captureSubject: () => {
        const scope = runner.captureSessionScope()
        return {
          scope,
          subject: {
            currentSessionId: scope.sessionId,
            currentCwd: runner.sessionCwd(),
            isCurrent: () => !signal.aborted && runner.isSessionScopeCurrent(scope),
          },
        }
      },
      diag: runner.diag,
      sessionId: () => runner.currentSessionId,
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
    readonly header: SessionBrowserHeader
    /** `/resume <arg>`: after the ONE shared listing lands, resolve the
     * argument as a direct id/prefix match — the first listed MAIN match closes
     * the picker and switches; no match falls through to the filtered picker
     * (the argument stays as the live search query). */
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
    // The PiTui Picker renders the same read owner; its per-open command label
    // is captured synchronously, before the read owner can open the panel.
    piTuiBrowserHeader = options.header
    return openNativeSessionBrowser(invocation, options, piTuiPresentation)
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
   * one switch route — never a second listing or a copied presenter.
   */
  const openSessionsBody = (
    invocation: { rawInput: string; commandId?: string },
  ): Promise<CommandResult> => openSessionPicker(invocation, { header: 'sessions' })

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
        resume: (invocation) => {
          const raw = invocation.rawInput.trim()
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

  const registerNew = (): void => {
    registerOne({
      name: 'new',
      description: 'Start a fresh session in this workspace',
      handler: async () => {
        if (freshSessionInFlight) {
          return { kind: 'error', text: 'a fresh session is already starting' }
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
          const intent = navigation.scope.sessionId === undefined
            ? { kind: 'host-path' as const, path: cwd }
            : { kind: 'source-session' as const, sessionId: navigation.scope.sessionId }
          let workspace: ResolvedWorkspaceSelection
          try {
            workspace = await runner.agents.resolveWorkspace(intent, signal)
          } catch (error) {
            if (!runner.isSessionScopeCurrent(navigation.scope)
              || (error instanceof WorkspaceSelectionError && error.kind === 'superseded')) {
              // A stale/superseded selection owns nothing: silent, exactly like
              // a superseded create. Nothing was stopped, flushed or created.
              return { kind: 'success' }
            }
            return { kind: 'error', text: `fresh session creation failed: ${safeErrorMessage(error)}` }
          }
          if (!runner.isSessionScopeCurrent(navigation.scope)) return { kind: 'success' }
          return await runner.withSessionTransition(async () => {
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
              // create is dispatched, and the abort must not surface as an unhandled
              // rejection. Any OTHER failure keeps its real diagnostic — never
              // mislabeled as a cancellation.
              if (runner.signal.aborted) {
                return { kind: 'error', text: `fresh session creation cancelled: ${safeErrorMessage(error)}${stopNote()}` }
              }
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
              // no create is dispatched (the old session stays current).
              return { kind: 'error', text: `fresh session creation cancelled: ${safeErrorMessage(error)}${stopNote()}` }
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
            // The transaction COMMITTED: staged drafts are per-TUI-run UI state —
            // drop the unpinned ones now, never before (a failed create keeps
            // the current session and its drafts intact; in-flight submissions
            // keep their pinned drafts — review finding 2).
            runner.imageStore.clearUnpinned()
            runner.fileStore?.clearUnpinned()
            return { kind: 'success', text: 'started a fresh session' }
          }, navigation)
        } catch (error) {
          if (error instanceof SessionNavigationStopError) {
            // A stale capture is a locally SUPERSEDED navigation (another
            // navigation already published): the surface moved, so this result
            // owns nothing — silent, exactly like the superseded create path.
            // A refused/unproven stop aborts BEFORE any child work; the message
            // already states whether the old Turn may have been stopped.
            if (error.settlement === 'stale') return { kind: 'success' }
            return { kind: 'error', text: `fresh session creation failed: ${error.message}` }
          }
          if (isCancellation(error)) throw error
          // The transition can THROW after the quiesce (a synchronous commit
          // seam): keep the phase fact in the user-visible failure instead of
          // letting the generic command path drop it.
          return { kind: 'error', text: `${safeErrorMessage(error)}${stopNote()}` }
        } finally {
          freshSessionInFlight = false
        }
      },
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
    openSessions: () => openSessionsBody({ rawInput: '' }),
  }
}
