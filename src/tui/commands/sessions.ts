/**
 * Session-domain command definitions: /sessions (+ /resume), /new, /search,
 * /title (+ /rename), /fork and /rewind, plus the ONE shared Session Browser
 * lifecycle (displaySessionId, sessionPickerCategories, sessionSearchCategory,
 * openSessionPicker) that all of them consume.
 *
 * Registration is explicit: the coordinator (src/commands.ts) calls each
 * registrar at its frozen position and owns catalog/provenance/disposal state.
 * @module @xmoon76/dsh-pi-tui/commands/sessions
 */

import { scheduler } from 'node:timers/promises'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PickerCategory, TuiApp } from '../../tui-app.ts'
import { TransitionInProgressError } from '../../app/session/operation-barrier.ts'
import { SessionScopeSupersededError } from '../../app/session/scope.ts'
import { cancellationError, isCancellation, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { LifecycleError } from '../../runtime/session-lifecycle-port.ts'
import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  PROJECTION_BATCH_SIZE,
  PROJECTION_FIRST_BATCH,
  buildSessionTree,
  findSessionMatch,
  sameWorkspace,
  sanitizeSessionSearchInput,
  sanitizeTerminalText,
  sessionLabelParts,
  sessionRowMatchesQuery,
  sessionSearchItem,
  sessionPickerItem,
  type SessionContentHit,
  type SessionPickerItem,
  type SessionPickerRow,
} from '../../sessions.ts'
import type { SessionSummary } from '../../runtime/session-reader-port.ts'
import type {
  DetachTask,
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
  | 'sessionWriter'
  | 'signal'
  | 'switchSession'
  | 'transitionTo'
  | 'withSessionTransition'
  | 'withWriter'
>

export interface SessionCommandDeps {
  runner: SessionCommandRunner
  app: TuiApp
  registerOne: RegisterOne
  registerTuiCommand: RegisterTuiCommand
  detach: DetachTask
  recordCommandDraftDisposition: (commandId: string | undefined, disposition: 'restored' | 'suppressed') => void
  newSessionId: NewSessionId
}

export interface SessionCommandRegistrars {
  registerSessions(): void
  registerNew(): void
  registerSearch(): void
  registerTitle(): void
  registerFork(): void
  registerRewind(): void
}

/** Shorten a session id for read-only display rows, capped at 28 characters. */
export function displaySessionId(id: string): string {
  return id.length > 28 ? `${id.slice(0, 28)}…` : id
}

export function sessionPickerCategories(
  rows: readonly SessionPickerRow[],
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
      // The same lineage tree as "All directories", built over the CURRENT
      // workspace's subset: a fork/rewind branch whose parent lives in
      // another workspace (or outside the window) degrades to a root at depth
      // 0 — never lost, never mis-nested under an unrelated root.
      items: () => {
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
      // The lineage tree (plan §20): fork/rewind children and subagents
      // hang under their parentSession chain with a └─ prefix. Missing-parent
      // or cycle members degrade to flat roots; the tree's `placed` guard
      // keeps corrupt metadata from looping.
      items: () => {
        const mainRows = rows.filter(row => row.origin !== 'subagent')
        if (rows.length === 0 && placeholder !== undefined) return [placeholder()]
        return buildSessionTree(mainRows).map(entry => itemFor(entry.row, entry.depth))
      },
    },
  ]
}

/**
 * The Session Browser's SEARCH projection category (review P1/P2): with a
 * non-empty query the picker enters a GLOBAL search view whose membership is
 * the explicit union of local metadata matches and Host content hits —
 * never a workspace-scoped post-filter of the bounded Host page (the Host
 * returns a global top-20; scoping it afterwards would hide a real
 * current-workspace match ranked beyond the window), and never a fake query
 * append in the description (membership and presentation stay separate).
 * The category is EXTERNALLY filtered (review P1): the SelectList renders
 * without its internal substring filter, so the projection's items ARE the
 * membership — a Host-authoritative hit is never dropped by a substring
 * re-filter, regardless of snippet length or query normalization. The
 * category is non-cyclable: Tab never leaves it while a query is active,
 * and browse mode skips it.
 */
export function sessionSearchCategory(options: {
  rows: readonly SessionPickerRow[]
  header: string
  /** The SEARCH item builder (the cwd joins the searchable description). */
  itemFor: (row: SessionPickerRow, indent?: number) => SessionPickerItem
  /** The LIVE CANONICAL filter text (read at activation time) — the one
   * semantic query that also drives the Host search. */
  queryOf: () => string
  /** The merged Host content hits (live map, Host page order). */
  contentHitsById: ReadonlyMap<string, SessionContentHit>
  /** The enriched metadata (title/preset) for the local match — the raw
   * list rows carry neither until the projection batch lands. */
  metadataOf: (id: string) => { title?: string; preset?: string }
  placeholder?: () => SessionPickerItem
}): PickerCategory {
  const { rows, header, itemFor, queryOf, contentHitsById, metadataOf, placeholder } = options
  return {
    id: 'search',
    label: 'Search results',
    header: `${header} · Search results`,
    cyclable: false,
    // The externally-filtered mode (review P1): the SelectList renders
    // WITHOUT its internal substring filter — this projection's items ARE
    // the membership, and a Host-authoritative hit is never dropped by a
    // substring re-filter.
    externalFilter: true,
    items: () => {
      if (rows.length === 0 && placeholder !== undefined) return [placeholder()]
      const mainRows = rows.filter(row => row.origin !== 'subagent')
      const query = queryOf()
      // Flat merged search projection (review P2): local metadata matches
      // keep the newest-first list order; content-only matches keep the
      // Host page order (the map's insertion order); a row that is both is
      // a local match with the snippet merged. No browse tree ordering.
      const localMatches = query === '' ? [] : mainRows.filter(row => {
        const meta = metadataOf(row.id)
        return sessionRowMatchesQuery({
          ...row,
          title: meta.title,
          preset: meta.preset ?? row.preset,
        }, query)
      })
      const localIds = new Set(localMatches.map(row => row.id))
      // Content-only matches keep the HOST PAGE order — iterate the hit
      // map (its insertion order IS the Host page order), never the
      // newest-first list order.
      const rowById = new Map(mainRows.map(row => [row.id, row]))
      const contentOnly = [...contentHitsById.keys()]
        .filter(id => !localIds.has(id))
        .map(id => rowById.get(id))
        .filter((row): row is SessionPickerRow => row !== undefined)
      return [...localMatches, ...contentOnly].map(row => itemFor(row, 0))
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
    detach,
    recordCommandDraftDisposition,
    newSessionId,
  } = deps
  const { cwd, signal } = runner

  /** Switch sessions with full rejection handling (the runner resolves an
   * error STRING for user-facing failures, but an unexpected rejection must
   * not become an unhandled rejection either). An owned workflow: the
   * outcome drives the notify — runOwned (AGENTS.md); the classification
   * diagnostics are recorded by runOwned itself. */
  const switchSession = (id: string): void => {
    runOwned('session switch', () => runner.switchSession(id), {
      diag: runner.diag,
      sessionId: () => id,
      onResult: (error) => {
        if (error !== undefined) app.notify(error, 'error')
      },
      onError: (error: unknown) => {
        const message = safeErrorMessage(error)
        app.notify(`session switch failed: ${message}`, 'error')
      },
    })
  }

  // Shared /sessions + /resume + /search body — input-first (the official
  // /resume fix): the picker overlay opens IMMEDIATELY on a loading
  // placeholder and owns the input (Esc, arrows, search) while the Host
  // listing and the combined projection enrichment land in the background.
  // The header option lets each entry present itself under its own name.
  /** Generation/staleness fence for the open picker load: a superseding
   * open bumps the generation and aborts the previous scan, and any late
   * settlement from a closed/superseded picker is dropped. */
  let sessionPickerGeneration = 0
  let activeSessionPickerScan: AbortController | undefined
  /** The debounced content-search timer/controller shared across picker
   * opens: a superseding open cancels the previous picker's pending or
   * in-flight content search exactly like its scan. */
  let activeContentSearchTimer: ReturnType<typeof setTimeout> | undefined
  let activeContentSearch: AbortController | undefined

  /** The narrow open options the three Session Browser entries really need
   * (plan §8.2) — not a controller/framework abstraction. */
  interface SessionPickerOpenOptions {
    readonly header: 'sessions' | 'resume' | 'search'
    /** `/resume <arg>`: after the ONE shared listing lands, resolve the
     * argument as a direct id/prefix match — a unique match closes the
     * picker and switches; no match falls through to the filtered picker
     * (the argument stays as the live search query). */
    readonly directMatchQuery?: string
    /** `/search` only: the query is required — an empty argument is
     * rejected BEFORE the overlay opens. */
    readonly requireQuery?: boolean
  }
  const openSessionPicker = async (
    invocation: { rawInput: string },
    options: SessionPickerOpenOptions,
  ): Promise<{ kind: 'success' } | { kind: 'error'; text: string }> => {
    if (options.requireQuery === true && invocation.rawInput.trim() === '') {
      return { kind: 'error', text: 'search needs a query' }
    }
    // The current marker is the live session's id; before the first session
    // (deferred start) no row is marked current, and the picker can still
    // browse and switch to a persisted session without creating one.
    const currentId = runner.currentSessionId
    // A NEW picker open supersedes the previous one outright: bump the
    // generation, cancel its scan AND its content search, and take over
    // as the active load.
    sessionPickerGeneration += 1
    const generation = sessionPickerGeneration
    activeSessionPickerScan?.abort()
    if (activeContentSearchTimer !== undefined) {
      clearTimeout(activeContentSearchTimer)
      activeContentSearchTimer = undefined
    }
    activeContentSearch?.abort()
    activeContentSearch = undefined
    const controller = new AbortController()
    activeSessionPickerScan = controller
    const scanSignal = AbortSignal.any([signal, controller.signal])
    /** True when this load's result may no longer touch the UI: the picker
     * closed (abort), the runner quit, or a newer open superseded it. */
    const stale = (): boolean => scanSignal.aborted || generation !== sessionPickerGeneration

    // The picker rows: EMPTY until `list()` lands. The category factories
    // read this shared array at activation time, so the loading placeholder
    // renders first and the late rows appear through the same factories.
    const rows: SessionPickerRow[] = []
    // Live enrichment maps: the background projection batch fills them, and
    // the category factories re-read them on every activation (Tab cycle,
    // refresh). The category scopes see the FULL row set, so "All
    // directories" really lists every main session (round-1 review finding:
    // the old code capped the rows themselves at MAX_PICKER_SESSIONS).
    const titlesById = new Map<string, string>()
    const presetsById = new Map<string, string>()
    // Content-search enrichment (plan §10.2): Host hits merge onto
    // already-listed rows — the list stays the row authority, the search
    // page only adds snippets. Cleared per query; the unavailable notice
    // fires at most once per picker lifecycle.
    const contentHitsById = new Map<string, SessionContentHit>()
    let contentHasMore = false
    let contentSearchNoticeShown = false
    const itemFor = (row: SessionPickerRow, indent = 0): SessionPickerItem =>
      sessionPickerItem({
        ...row,
        title: titlesById.get(row.id),
        preset: presetsById.get(row.id) ?? row.preset,
      }, runner.currentSessionId ?? '', indent, contentHitsById.get(row.id))
    // Category tabs (Tab cycles while the picker is open): the session
    // picker is a HUMAN surface, so subagent children never appear in
    // either scope — /tasks and the subagent viewer own that surface now
    // (the 2026-08-22 plan, item 3; kimi's directory-scope direction).
    // Current directory scopes to the live session's workspace (the
    // sessionCwd the whole surface follows); All directories lists every
    // main session, grouped by its workspace.
    const loadingItem: SessionPickerItem = {
      value: '',
      label: 'Loading sessions…',
      description: '',
      group: '',
    }
    // The status row the categories render while `rows` is still empty: the
    // loading label first, swapped for the refusal text when the listing
    // fails (the overlay is already open — an in-picker refusal beats a
    // dead loading frame; Esc still closes it).
    let statusRow = loadingItem
    const categories = [
      ...sessionPickerCategories(rows, runner.sessionCwd(), options.header, itemFor, () => statusRow),
      // The search projection (review P1/P2): with a non-empty query the
      // picker switches to this GLOBAL view — local metadata matches UNION
      // Host content hits, never scoped by the Current/All browse tabs.
      sessionSearchCategory({
        rows,
        header: options.header,
        // The search item builder: the cwd joins the searchable description
        // (the SelectList never searches the group header), and the
        // enriched title/preset are synthesized exactly like the browse rows.
        itemFor: (row, indent = 0) => sessionSearchItem({
          ...row,
          title: titlesById.get(row.id),
          preset: presetsById.get(row.id) ?? row.preset,
        }, runner.currentSessionId ?? '', indent, contentHitsById.get(row.id)),
        queryOf: () => pendingContentQuery,
        contentHitsById,
        metadataOf: id => ({ title: titlesById.get(id), preset: presetsById.get(id) }),
        placeholder: () => statusRow,
      }),
    ]
    /** The `/resume <arg>` outcome of the ONE shared listing, resolved by
     * the detached load task — the overlay stays interactive the whole
     * time, and the awaiting handler keeps the OLD synchronous semantics
     * (the switch has started before the handler returns). */
    type ListingOutcome =
      | { kind: 'switched' }
      | { kind: 'picker' }
      | { kind: 'refused'; text: string }
      | { kind: 'cancelled' }
    let settleListing: ((outcome: ListingOutcome) => void) | undefined
    const listing = options.directMatchQuery === undefined
      ? undefined
      : new Promise<ListingOutcome>(resolve => { settleListing = resolve })
    /** Idempotent outcome settle — later calls are no-ops (the abort
     * listener races the task's own settles). */
    const settleOnce = (outcome: ListingOutcome): void => {
      settleListing?.(outcome)
      settleListing = undefined
    }
    if (listing !== undefined) {
      // Esc / any close settles the awaiting /resume <arg> handler; a real
      // switch settles 'switched' BEFORE the abort so the listener cannot
      // overwrite it.
      controller.signal.addEventListener('abort', () => settleOnce({ kind: 'cancelled' }), { once: true })
    }
    // Content-search lifecycle (plan §9 + review P1/P2): local metadata
    // filtering is immediate; Host content search is a 250ms-debounced
    // async augmentation that must never block keyboard input. The query is
    // only recorded until the list baseline lands; clearing the filter drops
    // the content enrichment; close/supersede/quit cancels everything. A
    // non-empty query switches the picker into the GLOBAL search projection
    // (scope is browse state — it never wraps the bounded Host results);
    // clearing restores the browse category that was active before.
    let listLanded = false
    let pendingContentQuery = ''
    let browseCategory = 'current'
    /** Run one Host content search for a settled non-empty query. */
    const runContentSearch = (query: string): void => {
      if (stale()) return
      const controller = new AbortController()
      activeContentSearch = controller
      const searchSignal = AbortSignal.any([scanSignal, controller.signal])
      detach('session content search', async () => {
        try {
          const page = await runner.sessionReader.search(query, searchSignal)
          if (stale() || controller.signal.aborted) return
          if (page === undefined) {
            // Capability unavailable/disabled (e.g. the default
            // `openAt: never` FTS policy): the picker stays open with its
            // local metadata filtering; notice once per picker lifecycle.
            if (!contentSearchNoticeShown) {
              contentSearchNoticeShown = true
              app.notify('content search unavailable', 'info')
            }
            return
          }
          // Merge (plan §10.2 + review P2): only already-listed MAIN rows
          // accept hits — the search page never creates rows, and subagent
          // children stay out of the human Session Browser. Membership is
          // the explicit union in the search projection; the row carries
          // ONLY the real Host snippet (never a fake query append).
          contentHitsById.clear()
          contentHasMore = page.hasMore
          const knownIds = new Set(rows.filter(row => row.origin !== 'subagent').map(row => row.id))
          for (const item of page.items) {
            if (knownIds.has(item.sessionId)) {
              contentHitsById.set(item.sessionId, { snippet: item.snippet })
            }
          }
          picker.refresh?.()
          if (contentHasMore) app.notify('More content matches exist — refine the search.', 'info')
        } catch (error) {
          if (stale() || controller.signal.aborted) return
          // Non-fatal: local rows stay and the picker stays open. The
          // error text is a Host/provider boundary value — sanitize it
          // before the notify writes it to the terminal (a raw ESC/OSC in
          // an error message must never inject terminal sequences). The
          // rethrow records the real diagnostic through runDetached.
          app.notify(`session content search failed: ${sanitizeTerminalText(safeErrorMessage(error))}`, 'error')
          throw error
        }
      })
    }
    /** Debounce a non-empty query: 250ms of stability before the Host
     * content search runs (dsh-web parity). */
    const scheduleContentSearch = (query: string): void => {
      if (activeContentSearchTimer !== undefined) clearTimeout(activeContentSearchTimer)
      activeContentSearchTimer = setTimeout(() => {
        activeContentSearchTimer = undefined
        runContentSearch(query)
      }, CONTENT_SEARCH_DEBOUNCE_MS)
    }
    /** Cancel the pending debounce and any in-flight content search. */
    const cancelContentSearch = (): void => {
      if (activeContentSearchTimer !== undefined) {
        clearTimeout(activeContentSearchTimer)
        activeContentSearchTimer = undefined
      }
      activeContentSearch?.abort()
      activeContentSearch = undefined
    }
    const picker = app.openPicker(
      categories[0]!.items(),
      (id) => {
        // Any close — including the loading row's Enter — ends the scan
        // and the content search: the picker is gone, so late enrichment
        // may not touch the UI.
        if (id !== '' && id !== currentId) settleOnce({ kind: 'switched' })
        controller.abort()
        cancelContentSearch()
        // Enter on the loading placeholder (value '') must never resume.
        if (id === '' || id === currentId) return
        switchSession(id)
      },
      () => {
        controller.abort()
        cancelContentSearch()
      },
      {
        enableSearch: true,
        header: categories[0]!.header,
        noMatchText: '  no matching sessions',
        // The command argument is applied AFTER the rows land (below), not
        // as initialQuery: a prefilled filter would hide the STATUS rows
        // (loading / refusal / already-on) behind "no matching sessions"
        // while the scan is still running.
        initialQuery: '',
        width: 76,
        maxHeight: 26,
        showHint: true,
        categories,
        // A closed picker (select, Esc) aborts the background scan through
        // the same controller; a runner exit closes the overlay AND cancels
        // the scan through the shared signal.
        signal: scanSignal,
        // The selected session's long title marquees; the lineage tree
        // connector and the `●` current marker stay fixed (plan §7.6/§7.7).
        marquee: { labelPartsOf: sessionLabelParts },
        // The Session Browser's content-search hook: every filter change
        // (typed or programmatic) feeds the 250ms debounce; before the
        // list baseline lands the query is only recorded. ANY change drops
        // the previous query's enrichment — stale snippets must never
        // match the new filter (plan §18), and an unavailable/failed new
        // search must not leave the old query's hits behind.
        onFilterChange: (query) => {
          // ONE canonical client query (review P1): remove NUL → trim →
          // cap 500 UTF-16 units. The SAME canonical drives the local
          // metadata projection AND the Host search (whose authoritative
          // validation is then a no-op) — the input box keeps the raw
          // text the user typed, but membership never drifts from what
          // was searched.
          const canonical = sanitizeSessionSearchInput(query)
          // The canonical is the semantic identity: a raw edit that does
          // not change it (e.g. padding whitespace or NULs around the
          // same term) must not abort/restart the identical Host search.
          if (canonical === pendingContentQuery) return
          pendingContentQuery = canonical
          cancelContentSearch()
          contentHitsById.clear()
          contentHasMore = false
          // A whitespace-only filter is an empty query: no Host request
          // (the official contract rejects empty queries — a whitespace
          // filter must not surface as a search failure).
          if (canonical === '') {
            // Back to the browse state (the category that was active
            // before the query started).
            if (picker.getCategory?.() !== browseCategory) picker.setCategory?.(browseCategory)
            return
          }
          // Enter the GLOBAL search projection: scope is browse state and
          // never wraps the bounded Host results (review P1). The switch
          // happens once per query; further typing re-runs the active
          // factory through refresh.
          if (picker.getCategory?.() !== 'search') {
            browseCategory = picker.getCategory?.() ?? 'current'
            picker.setCategory?.('search')
          } else {
            picker.refresh?.()
          }
          if (listLanded) scheduleContentSearch(canonical)
        },
      },
    )
    // The listing + progressive enrichment run behind the open overlay.
    // Cancellations (picker close, TUI quit, a superseding open) are
    // debug-level through the unified entry; a real failure lands in
    // diagnostics instead of being swallowed. Every await re-checks the
    // staleness fence so a late settlement never refreshes a picker that
    // already closed or was replaced.
    detach('session picker load', async () => {
      // The FIRST thing the scan does is a real event-loop yield: the
      // overlay must be registered, focused, and repainted before any Host
      // work starts (a microtask yield would not guarantee the terminal
      // I/O phase a turn).
      await scheduler.yield()
      scanSignal.throwIfAborted()

      // The session READ port (migration M1.3): semantic listing with
      // capability-aware activity ordering lives in the Direct adapter, never here.
      let listed: readonly SessionSummary[] | undefined
      try {
        listed = await runner.sessionReader.list(currentId, scanSignal)
      } catch (error) {
        // A real listing failure surfaces in-picker (the overlay is already
        // open) and settles the awaiting /resume <arg> handler — never a
        // dead loading frame, never a hanging handler.
        if (stale()) return
        const message = safeErrorMessage(error)
        statusRow = { value: '', label: `session listing failed: ${message}`, description: '', group: '' }
        picker.refresh?.()
        settleOnce({ kind: 'refused', text: message })
        return
      }
      if (stale()) return
      if (listed === undefined || listed.length === 0) {
        // The overlay is already open — keep it open on the refusal row
        // (Esc closes as always) instead of leaving a dead loading frame.
        const text = listed === undefined ? 'session persistence unavailable' : 'no persisted sessions'
        statusRow = { value: '', label: text, description: '', group: '' }
        picker.refresh?.()
        settleOnce({ kind: 'refused', text })
        return
      }
      // `/resume <arg>` direct fast path, resolved against the ONE shared
      // listing (never a second one): a unique id/prefix match closes the
      // picker and switches (the switch has STARTED before the awaiting
      // handler returns — the old synchronous semantics); matching the
      // CURRENT session surfaces the already-on notice; no match falls
      // through to the filtered picker with the argument preserved as the
      // live search query.
      if (options.directMatchQuery !== undefined) {
        const match = findSessionMatch(listed, options.directMatchQuery)
        if (match !== undefined) {
          if (match.id === currentId) {
            // Nothing to switch and nothing to browse: close the overlay —
            // the error result is the whole feedback (a status row would
            // linger behind the argument filter).
            settleOnce({ kind: 'refused', text: 'already on this session' })
            controller.abort()
            picker.close()
            return
          }
          settleOnce({ kind: 'switched' })
          controller.abort()
          picker.close()
          switchSession(match.id)
          return
        }
        settleOnce({ kind: 'picker' })
      }
      // Mutate the shared row array in place: the category factories read
      // it at activation time, so this one splice swaps the loading
      // placeholder for the real rows on the next refresh.
      rows.push(...listed)
      picker.refresh?.()
      // The list baseline is in: content search may start now (plan §9.3).
      listLanded = true
      // NOW the command argument becomes the live filter — real rows are
      // in, so it narrows sessions instead of hiding the status phase. A
      // query the USER typed during the load is never clobbered.
      const pendingQuery = invocation.rawInput.trim()
      if (pendingQuery !== '' && picker.getFilter?.() === '') {
        picker.setFilter?.(pendingQuery)
      }
      // A filter that was only recorded during the load (or just applied
      // above) now enters the normal debounced content-search flow. The
      // query is canonicalized (trimmed) exactly like the interactive
      // path: trim BEFORE the client cap, so a whitespace-padded filter
      // never loses a character to the 500-unit window (official
      // semantics: trim, then cap).
      if (pendingContentQuery !== '' && activeContentSearchTimer === undefined && activeContentSearch === undefined) {
        scheduleContentSearch(pendingContentQuery)
      }

      // Progressive combined projection batches: the first
      // PROJECTION_FIRST_BATCH rows fill the visible window, then
      // PROJECTION_BATCH_SIZE chunks refresh behind it. Each row's title
      // and preset arrive TOGETHER from the one DSH projection batch (one
      // cache lookup per session, never one scan per field), and the yield
      // between batches keeps the event loop responsive to input while the
      // cache hints settle. Cold misses remain unknown. The batches cover MAIN
      // rows only (the categories never show subagents) and the FULL main-row set — NOT
      // the `shown` window: a session beyond MAX_PICKER_SESSIONS that IS
      // displayed (e.g. an old session in the "Current directory" scope)
      // would otherwise never be enriched and would show a bare short id
      // forever.
      const mainRows = listed.filter(row => row.origin !== 'subagent')
      const loadBatch = async (batch: readonly SessionSummary[]): Promise<void> => {
        const projections = await runner.sessionReader.projectionBatch(batch, scanSignal)
        if (stale()) return
        let enriched = false
        for (const [id, projection] of projections) {
          if (projection.title !== undefined) {
            titlesById.set(id, projection.title)
            enriched = true
          }
          if (projection.preset !== undefined) {
            presetsById.set(id, projection.preset)
            enriched = true
          }
        }
        if (enriched) picker.refresh?.()
      }
      await loadBatch(mainRows.slice(0, PROJECTION_FIRST_BATCH))
      if (stale()) return
      for (let offset = PROJECTION_FIRST_BATCH; offset < mainRows.length; offset += PROJECTION_BATCH_SIZE) {
        // Yield between batches so input/repaint keep their turns even when
        // every projection is a cold miss.
        await scheduler.yield()
        if (stale()) return
        await loadBatch(mainRows.slice(offset, offset + PROJECTION_BATCH_SIZE))
      }
    })
    if (listing === undefined) return { kind: 'success' }
    // `/resume <arg>` keeps the OLD synchronous command semantics — the
    // switch has started before the handler returns — while the overlay
    // stays interactive during the wait (Esc cancels). No match settles as
    // success with the filtered picker; a refusal returns the error text.
    const outcome = await listing
    if (outcome.kind === 'refused') return { kind: 'error', text: outcome.text }
    if (outcome.kind === 'cancelled') return { kind: 'error', text: 'resume cancelled' }
    return { kind: 'success' }
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
            // branch below and the `/preset`/`/model` handlers.
            app.notify(message, 'error')
            return { kind: 'error', text: message }
          }
          const message = outcome.kind === 'rejected' ? outcome.error.message : outcome.reason
          // PR5 (Slice C1): the Remote Client-owned command path renders no
          // official command card (the Host executor's `command/run` row does
          // not exist there), so the handler surfaces its own refusal — the
          // same inline notice the `/preset` and `/model` handlers already
          // emit. On Direct this is a transient notice beside the command card.
          // The rejected branch is the writer-held (`session/writer-held`)
          // proven pre-commit refusal: its message is the centralized guidance.
          app.notify(message, 'error')
          return { kind: 'error', text: message }
        }
      } catch (error) {
        if (error instanceof TransitionInProgressError) return transitioning()
        if (error instanceof SessionScopeSupersededError) return stale()
        if (isCancellation(error)) throw error
        return { kind: 'error', text: safeErrorMessage(error) }
      }
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
        app.notify('no conversation yet — title left as-is', 'info')
        return { kind: 'success' }
      }
      app.notify(`title regenerated: ${outcome.title}`, 'info')
      return { kind: 'success' }
    } catch (error) {
      if (error instanceof TransitionInProgressError) return transitioning()
      if (error instanceof SessionScopeSupersededError) return stale()
      if (isCancellation(error)) throw error
      return { kind: 'error', text: safeErrorMessage(error) }
    }
  }

  const registerSessions = (): void => {
    registerTuiCommand({
      name: 'sessions',
      description: 'List, search, and switch persisted sessions',
      input: { hint: '[query]' },
      handler: (invocation) => openSessionPicker(invocation, { header: 'sessions' }),
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

  const registerNew = (): void => {
    registerOne({
      name: 'new',
      description: 'Start a fresh session in this workspace',
      handler: () => runner.withSessionTransition(async () => {
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
            return { kind: 'error', text: `fresh session creation cancelled: ${safeErrorMessage(error)}` }
          }
          return { kind: 'error', text: `fresh session creation failed: ${safeErrorMessage(error)}` }
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
          return { kind: 'error', text: `fresh session creation cancelled: ${safeErrorMessage(error)}` }
        }
        const result = await runner.transitionTo({
          target: { id: String(sessionId), header: { cwd } },
          create: async () => {
            // Re-wait immediately before dispatch: a newer sessionless /model may
            // have started between the first wait and here, and the Direct
            // adapter activates the Agent from the persisted Host default.
            await runner.awaitPendingDefaultWrite(signal)
            return runner.agents.create({
              sessionId: String(sessionId),
              // The semantic `agentPreset` is the SINGLE preset authority; the
              // Direct adapter persists the actually composed preset into the
              // durable header. Never duplicate it into generic meta.
              cwd,
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
          return { kind: 'error', text: result.message }
        }
        // The transaction COMMITTED: staged drafts are per-TUI-run UI state —
        // drop the unpinned ones now, never before (a failed create keeps
        // the current session and its drafts intact; in-flight submissions
        // keep their pinned drafts — review finding 2).
        runner.imageStore.clearUnpinned()
        runner.fileStore?.clearUnpinned()
        return { kind: 'success', text: 'started a fresh session' }
      }),
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

  return { registerSessions, registerNew, registerSearch, registerTitle, registerFork, registerRewind }
}
