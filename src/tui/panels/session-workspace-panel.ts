/**
 * M5-U-C — the fullscreen PiTUI Session Workspace panel.
 *
 * ONE client-local component owns the whole Session Workspace surface: the
 * browse list, the All/Current Workspace scope, the global content-search
 * editor and its result list, the per-open selection/scroll anchors and the
 * focus ring. It is the layout ROOT of the temporary workspace lease
 * (`TuiApp.openSessionWorkspace`), so every key arrives on its own
 * {@link SessionWorkspacePanel.handleInput}.
 *
 * The panel owns NO read authority. `SessionBrowserReadOwner` owns every list,
 * projection and search generation and publishes its detached
 * `SessionBrowserReadSnapshot`; the official Workspace facts arrive through
 * one per-open `WorkspaceFactsHandle` and are folded here ONLY into a
 * disposable membership projection used to filter the rows that snapshot
 * already carries. The panel never reads a backend, never opens a Session,
 * never writes a Workspace and never derives an activity/pending/attention
 * classification: U-C renders "Sessions / Recent sessions" only.
 *
 * `Enter` produces ONE `onResume(sessionId)` intent; the read owner re-proves
 * the same row/currentness and the command layer owns the real switch. The
 * panel is UI-only and is disposed with the physical lease.
 * @module @xmoon76/dsh-pi-tui/tui/panels/session-workspace-panel
 */

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@xmoon76/pi-tui'
import type {
  SessionBrowserReadSnapshot,
  SessionBrowserRow,
  SessionBrowserSearchResult,
} from '../../app/command/session-browser-presentation.ts'
import type {
  SessionWorkspaceFact,
  WorkspaceFactsFrame,
} from '../../runtime/session-workspace-facts-port.ts'
import { renderActionBarRow } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import { formatSessionAge, shortSessionId, workspaceKey } from '../pickers/sessions.ts'

/** The logical focus of one Session Workspace frame. `workspace` is the
 *  in-place header scope selector; `search` is the raw global query editor;
 *  `search-results` is the Host+metadata result list. */
export type SessionWorkspaceFocus = 'workspace' | 'search' | 'list' | 'search-results'

/** The browse scope. `pending` means the official baseline has not arrived:
 *  no membership judgment is made and every listed row is shown. */
export type SessionWorkspaceScope = 'pending' | 'current' | 'all'

/** What the ONE PiTUI Session Workspace Presentation needs from `TuiApp`.
 *  Everything is read live; the panel never receives the app object. */
export interface SessionWorkspacePanelHost {
  readonly rows: () => number
  readonly columns: () => number
  readonly requestRender: () => void
  /** The app's ONE transient notice (a workspace paints it, never owns it). */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** The ONE raw-editor change entry; only a real text change reaches it. */
  readonly onQueryChange: (raw: string) => void
  /** ONE logical resume intent for the selected listed non-current row. The
   *  read owner re-proves eligibility; the panel never switches a Session. */
  readonly onResume: (sessionId: string) => void
  /** The user's own close gesture (Esc at the root list). */
  readonly onClose: () => void
}

export interface SessionWorkspacePanelOptions {
  /** `/sessions <query>` and `/search <query>` open the global editor; the
   *  bare commands open the browse list. */
  readonly initialMode: 'browse' | 'search'
  /** The command edge's browse intent. `current` stays `pending` until the
   *  official Workspace baseline proves a unique membership, then falls back
   *  to `all` with a visible message. */
  readonly initialBrowseScope: 'current' | 'all'
  /** The atomically captured current Session id of THIS open; never a live
   *  re-read of the runner. */
  readonly currentSessionId: string | undefined
}

const EMPTY_SNAPSHOT: SessionBrowserReadSnapshot = {
  listState: 'loading',
  rows: [],
  query: '',
  resumePending: false,
  searchState: 'idle',
  searchResults: [],
  hasMore: false,
}

const LIST_TITLE = 'Recent sessions'

/** Truncate one rendered line to the pane width and pad it with plain spaces. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Right-align a trailing fact on one already-composed left label. */
function withTrailing(left: string, trailing: string, width: number): string {
  const room = width - visibleWidth(trailing)
  if (room <= 0) return truncateToWidth(left, width, '…', false)
  const clipped = truncateToWidth(left, room, '…', false)
  return `${clipped}${' '.repeat(Math.max(0, room - visibleWidth(clipped)))}${trailing}`
}

/** Keep the selected index inside its viewport with the smallest rebase. */
function rebaseOffset(offset: number, selected: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  let next = offset
  if (selected < next) next = selected
  if (selected >= next + viewport) next = selected - viewport + 1
  return Math.min(Math.max(0, next), Math.max(0, count - viewport))
}

/** The disposable per-open Workspace membership projection. It is never
 *  persisted and never crosses an open; `order` only decides the label order
 *  of KNOWN workspaces and never creates a member from `order` alone. */
interface WorkspaceProjection {
  readonly order: readonly string[]
  readonly byId: ReadonlyMap<string, SessionWorkspaceFact>
}

const EMPTY_PROJECTION: WorkspaceProjection = { order: [], byId: new Map() }

/** Fold ONE official follow frame. Unknown `order` ids are ignored; an
 *  `upsert` appends a genuinely new WorkspaceId. */
function foldWorkspaceFrame(projection: WorkspaceProjection, frame: WorkspaceFactsFrame): WorkspaceProjection {
  switch (frame.type) {
    case 'baseline':
    case 'replace': {
      const byId = new Map<string, SessionWorkspaceFact>()
      const order: string[] = []
      for (const item of frame.items) {
        if (!byId.has(item.workspaceId)) order.push(item.workspaceId)
        byId.set(item.workspaceId, item)
      }
      return { order, byId }
    }
    case 'upsert': {
      const byId = new Map(projection.byId)
      byId.set(frame.workspace.workspaceId, frame.workspace)
      const order = projection.byId.has(frame.workspace.workspaceId)
        ? projection.order
        : [...projection.order, frame.workspace.workspaceId]
      return { order, byId }
    }
    case 'remove': {
      if (!projection.byId.has(frame.workspaceId)) return projection
      const byId = new Map(projection.byId)
      byId.delete(frame.workspaceId)
      return { order: projection.order.filter((id) => id !== frame.workspaceId), byId }
    }
    case 'order': {
      const known = frame.workspaceIds.filter((id) => projection.byId.has(id))
      const listed = new Set(known)
      return {
        order: [...known, ...projection.order.filter((id) => !listed.has(id))],
        byId: projection.byId,
      }
    }
  }
}

/** Resolve the ONE Workspace whose official `sessionIds` contains the current
 *  Session. `undefined` for a sessionless/absent/ambiguous membership: the
 *  caller must fall back to All instead of guessing from a cwd. */
function uniqueCurrentWorkspace(projection: WorkspaceProjection, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  let found: string | undefined
  for (const workspaceId of projection.order) {
    const fact = projection.byId.get(workspaceId)
    if (fact === undefined || !fact.sessionIds.includes(sessionId)) continue
    if (found !== undefined) return undefined
    found = workspaceId
  }
  return found
}

export class SessionWorkspacePanel implements Component {
  private readonly host: SessionWorkspacePanelHost
  private readonly options: SessionWorkspacePanelOptions
  private snapshot: SessionBrowserReadSnapshot = EMPTY_SNAPSHOT
  /** The one per-open Workspace membership projection (never persisted). */
  private workspaces: WorkspaceProjection = EMPTY_PROJECTION
  private workspaceError: string | undefined
  private currentWorkspaceId: string | undefined
  private scope: SessionWorkspaceScope
  private defaultScope: 'current' | 'all'
  private focus: SessionWorkspaceFocus
  private searchMode: boolean
  private selectorIndex = 0
  private helpVisible = false
  private selectedSessionId: string | undefined
  private browseScroll = 0
  private lastBrowseSelection: string | undefined
  private lastBrowseScroll = 0
  private lastPaintedListRows = 1
  /** The one raw search editor. Programmatic seeds are fenced by
   *  `applyingSeed`, so only a real text change reaches the read owner. */
  private readonly searchInput = new Input({ prompt: 'Search: ' })
  private seedApplied = false
  private userEdited = false
  private applyingSeed = false
  private disposed = false
  /** Per-open dedupe for the one status message this panel owns. */
  private lastNotice: string | undefined
  private statusMessage: string | undefined
  /** The transient result-list scroll of THIS search, never a stored anchor. */
  private resultScroll = 0

  constructor(host: SessionWorkspacePanelHost, options: SessionWorkspacePanelOptions) {
    this.host = host
    this.options = options
    this.scope = options.initialBrowseScope === 'all' ? 'all' : 'pending'
    this.defaultScope = options.initialBrowseScope
    this.searchMode = options.initialMode === 'search'
    this.focus = this.searchMode ? 'search' : 'list'
  }

  /** Whether this panel has been released. The lease handle checks its own
   *  record as well; this flag only stops local reactions after dispose. */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Ordinary snapshots refresh results and the roster. Only the one-shot
   *  `initialQuery` option may write the editor, and never after a real edit. */
  setSnapshot(snapshot: SessionBrowserReadSnapshot, options?: { readonly initialQuery?: string }): void {
    if (this.disposed) return
    this.snapshot = snapshot
    // An EMPTY seed is not a search: the bare `/sessions` command carries one
    // only because its command edge always passes a trimmed argument.
    if (options?.initialQuery !== undefined && options.initialQuery !== '' && !this.seedApplied && !this.userEdited) {
      this.seedApplied = true
      this.applyingSeed = true
      try {
        this.searchInput.setValue(options.initialQuery)
      } finally {
        this.applyingSeed = false
      }
      this.enterSearch('search')
    }
    this.ensureSelection()
    this.host.requestRender()
  }

  /** Apply ONE official Workspace follow frame. Only the membership projection
   *  and the scope label change; Session rows stay the read owner's. */
  updateWorkspaces(frame: WorkspaceFactsFrame): void {
    if (this.disposed) return
    this.workspaces = foldWorkspaceFrame(this.workspaces, frame)
    this.recomputeWorkspaceScope()
    this.ensureSelection()
    this.host.requestRender()
  }

  /** A failed/closed Workspace stream is ONE visible state; the Session list
   *  and search stay usable in All. */
  workspaceUnavailable(message: string): void {
    if (this.disposed) return
    this.workspaceError = message
    this.currentWorkspaceId = undefined
    this.scope = 'all'
    this.defaultScope = 'all'
    // `workspaceError` IS the one visible status line; a second `notifyOnce`
    // copy would paint the same fact twice on the next frame.
    this.host.requestRender()
  }

  invalidate(): void {
    this.searchInput.invalidate()
  }

  dispose(): void {
    this.disposed = true
  }

  // ── Workspace scope ──────────────────────────────────────────────────────

  /** Re-derive the unique Current Workspace after every official frame. A
   *  membership that was proven and is now missing falls back to All once. */
  private recomputeWorkspaceScope(): void {
    const proven = uniqueCurrentWorkspace(this.workspaces, this.options.currentSessionId)
    this.currentWorkspaceId = proven
    if (proven !== undefined) {
      if (this.scope === 'pending') this.scope = this.defaultScope
      return
    }
    if (this.scope === 'current') {
      this.scope = 'all'
      this.defaultScope = 'all'
      this.notifyOnce('current-workspace-lost', 'Current workspace unavailable — showing all workspaces')
      return
    }
    if (this.scope === 'pending') {
      this.scope = 'all'
      // An explicit All open never announces a scope it did not ask for; a bare
      // /sessions or /resume opened with the current-if-proven intent does.
      if (this.defaultScope === 'current') {
        this.notifyOnce('current-workspace-unavailable', 'Current workspace unavailable — showing all workspaces')
      }
    }
    this.defaultScope = 'all'
  }

  /** The rows the current browse scope really lists. `pending` filters
   *  nothing (no membership evidence exists yet). */
  private browseRows(): readonly SessionBrowserRow[] {
    if (this.scope !== 'current' || this.currentWorkspaceId === undefined) return this.snapshot.rows
    const fact = this.workspaces.byId.get(this.currentWorkspaceId)
    if (fact === undefined) return this.snapshot.rows
    const members = new Set(fact.sessionIds)
    return this.snapshot.rows.filter((row) => members.has(row.id))
  }

  private currentRows(): readonly (SessionBrowserRow | SessionBrowserSearchResult)[] {
    return this.searchMode ? this.snapshot.searchResults : this.browseRows()
  }

  private rowIdOf(row: SessionBrowserRow | SessionBrowserSearchResult): string {
    return 'row' in row ? row.row.id : row.id
  }

  private rowOf(row: SessionBrowserRow | SessionBrowserSearchResult): SessionBrowserRow {
    return 'row' in row ? row.row : row
  }

  /** Keep a surviving selection; only a selection that left the visible set
   *  is re-anchored (a late projection never resets the cursor). */
  private ensureSelection(): void {
    const rows = this.currentRows()
    if (rows.length === 0) {
      this.selectedSessionId = undefined
      this.browseScroll = 0
      return
    }
    if (this.selectedSessionId !== undefined && rows.some((row) => this.rowIdOf(row) === this.selectedSessionId)) return
    if (this.searchMode) {
      this.selectedSessionId = this.rowIdOf(rows[0]!)
      return
    }
    const index = Math.min(this.browseScroll, rows.length - 1)
    this.selectedSessionId = this.rowIdOf(rows[index]!)
    this.browseScroll = rebaseOffset(this.browseScroll, index, rows.length, this.lastPaintedListRows)
  }

  private notifyOnce(key: string, message: string): void {
    if (this.lastNotice === key) return
    this.lastNotice = key
    this.statusMessage = message
  }

  // ── Input ───────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, Key.escape)) {
      this.handleEscape()
      return
    }
    if (this.focus === 'workspace') {
      this.handleSelectorInput(data)
      return
    }
    if (this.focus === 'search') {
      this.handleSearchInput(data)
      return
    }
    if (this.focus === 'search-results') {
      this.handleResultsInput(data)
      return
    }
    this.handleListInput(data)
  }

  private handleEscape(): void {
    if (this.focus === 'workspace') {
      this.closeSelector()
      return
    }
    if (this.focus === 'search-results') {
      this.focus = 'search'
      this.host.requestRender()
      return
    }
    if (this.searchMode) {
      this.leaveSearch()
      return
    }
    this.host.onClose()
  }

  private handleListInput(data: string): void {
    const rows = this.currentRows()
    if (matchesKey(data, Key.up)) return this.moveSelection(-1)
    if (matchesKey(data, Key.down)) return this.moveSelection(1)
    if (matchesKey(data, Key.pageUp)) return this.moveSelection(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.moveSelection(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) return this.selectIndex(0)
    if (matchesKey(data, Key.end)) return this.selectIndex(rows.length - 1)
    if (matchesKey(data, Key.tab)) {
      this.openSelector()
      return
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      this.enterSearch('search')
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.resumeSelected()
      return
    }
    if (data === 'w') {
      this.openSelector()
      return
    }
    if (data === '/') {
      this.enterSearch('search')
      return
    }
    if (data === '?') {
      this.helpVisible = !this.helpVisible
      this.host.requestRender()
    }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      // The safe two-Enter contract: the first Enter only moves focus to the
      // first REAL result; a second Enter from the result list is the resume.
      if (this.snapshot.searchResults.length > 0) {
        this.selectedSessionId = this.rowIdOf(this.snapshot.searchResults[0]!)
        this.focus = 'search-results'
        this.host.requestRender()
      }
      return
    }
    if (matchesKey(data, Key.down)) {
      if (this.snapshot.searchResults.length > 0) {
        this.selectedSessionId = this.rowIdOf(this.snapshot.searchResults[0]!)
        this.focus = 'search-results'
        this.host.requestRender()
      }
      return
    }
    if (matchesKey(data, Key.tab)) {
      // An active query keeps Tab INSIDE the global search (input → results):
      // a browse tab can never hide the Host's global hits. An empty query is
      // the plain browse focus ring, so Tab returns to the Session List.
      if (this.searchInput.getValue() !== '' && this.snapshot.searchResults.length > 0) {
        this.selectedSessionId = this.rowIdOf(this.snapshot.searchResults[0]!)
        this.focus = 'search-results'
        this.host.requestRender()
      } else if (this.searchInput.getValue() === '') {
        this.leaveSearch()
      }
      return
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      this.leaveSearch()
      return
    }
    const before = this.searchInput.getValue()
    this.searchInput.handleInput(data)
    const after = this.searchInput.getValue()
    if (after === before || this.applyingSeed) return
    this.userEdited = true
    this.host.onQueryChange(after)
  }

  private handleResultsInput(data: string): void {
    const rows = this.snapshot.searchResults
    if (matchesKey(data, Key.up)) return this.moveSelection(-1)
    if (matchesKey(data, Key.down)) return this.moveSelection(1)
    if (matchesKey(data, Key.pageUp)) return this.moveSelection(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.moveSelection(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) return this.selectIndex(0)
    if (matchesKey(data, Key.end)) return this.selectIndex(rows.length - 1)
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.resumeSelected()
      return
    }
    if (matchesKey(data, Key.backspace)) {
      this.focus = 'search'
      this.host.requestRender()
      return
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) {
      this.focus = 'search'
      this.host.requestRender()
    }
  }

  private moveSelection(delta: number): void {
    const rows = this.currentRows()
    if (rows.length === 0) return
    const current = rows.findIndex((row) => this.rowIdOf(row) === this.selectedSessionId)
    const next = Math.min(Math.max(0, (current < 0 ? 0 : current) + delta), rows.length - 1)
    this.selectIndex(next)
  }

  private selectIndex(index: number): void {
    const rows = this.currentRows()
    if (rows.length === 0) return
    const clamped = Math.min(Math.max(0, index), rows.length - 1)
    this.selectedSessionId = this.rowIdOf(rows[clamped]!)
    if (!this.searchMode) {
      this.browseScroll = rebaseOffset(this.browseScroll, clamped, rows.length, this.lastPaintedListRows)
    }
    this.host.requestRender()
  }

  private resumeSelected(): void {
    if (this.snapshot.resumePending || this.selectedSessionId === undefined) return
    if (this.selectedSessionId === this.options.currentSessionId) return
    // A scope/membership change can hide the previously selected row; the
    // visible projection (not the stale id) is the only resumable set.
    if (!this.currentRows().some((row) => this.rowIdOf(row) === this.selectedSessionId)) return
    this.host.onResume(this.selectedSessionId)
  }

  // ── Search / selector ───────────────────────────────────────────────────

  private enterSearch(focus: 'search' | 'search-results'): void {
    if (!this.searchMode) {
      this.lastBrowseSelection = this.selectedSessionId
      this.lastBrowseScroll = this.browseScroll
    }
    this.searchMode = true
    this.focus = focus
    this.ensureSelection()
    this.host.requestRender()
  }

  private leaveSearch(): void {
    this.searchMode = false
    this.focus = 'list'
    this.selectedSessionId = this.lastBrowseSelection
    this.browseScroll = this.lastBrowseScroll
    this.ensureSelection()
    this.host.requestRender()
  }

  private openSelector(): void {
    if (this.snapshot.resumePending) return
    this.selectorIndex = this.scope === 'current' ? 1 : 0
    this.focus = 'workspace'
    this.host.requestRender()
  }

  private closeSelector(): void {
    this.focus = this.searchMode ? 'search' : 'list'
    this.host.requestRender()
  }

  private currentScopeSelectable(): boolean {
    return this.currentWorkspaceId !== undefined
  }

  private handleSelectorInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.selectorIndex = this.selectorIndex === 0 ? 1 : 0
      this.host.requestRender()
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (this.selectorIndex === 1 && this.currentScopeSelectable()) {
        this.scope = 'current'
      } else if (this.selectorIndex === 0) {
        this.scope = 'all'
      }
      this.ensureSelection()
      this.closeSelector()
      return
    }
    if (matchesKey(data, Key.tab)) {
      this.enterSearch('search')
      return
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      this.focus = 'list'
      this.host.requestRender()
      return
    }
    if (data === 'w') {
      this.closeSelector()
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  render(width: number): string[] {
    const height = Math.max(0, this.host.rows())
    if (height === 0) return []
    const actionBar = this.renderActionBar(width)
    const header = this.renderHeader(width)
    const subHeader = this.renderSubHeader(width)
    if (height <= 3) {
      const status = this.renderStatus(width)
      return [header, subHeader === '' ? status : subHeader, actionBar].slice(0, height)
    }
    const lines: string[] = [header]
    // A 4/5-row terminal keeps ONE header line and ONE body row so the Esc row
    // never disappears; from 6 rows the two-line header and both rules fit.
    // The in-place Workspace selector always owns the second header row: its
    // choices must stay reachable even on a short terminal.
    if (height >= 6 || this.focus === 'workspace') lines.push(subHeader)
    lines.push(color.border('─'.repeat(Math.max(1, width))))
    const bottom = height >= 6
      ? [color.border('─'.repeat(Math.max(1, width))), actionBar]
      : [actionBar]
    const bodyBudget = Math.max(0, height - lines.length - bottom.length)
    const body = this.renderBody(width, bodyBudget)
    for (let index = 0; index < bodyBudget; index += 1) {
      lines.push(fit(body[index] ?? '', width))
    }
    lines.push(...bottom)
    return lines.slice(0, height)
  }

  private renderHeader(width: number): string {
    const left = color.textStrong('Sessions')
    const trailing = this.options.currentSessionId === undefined
      ? `${color.textDim('Current: ')}${color.textMuted('none')}`
      : `${color.textDim('Current: ')}${color.text(sanitizedPhysicalLine(shortSessionId(this.options.currentSessionId)))}`
    return withTrailing(left, trailing, width)
  }

  private renderSubHeader(width: number): string {
    if (this.focus === 'workspace') return this.renderSelectorHeader(width)
    if (this.searchMode) {
      const left = color.textDim('Search all workspaces')
      return withTrailing(left, color.textMuted('Esc back'), width)
    }
    const label = this.scope === 'pending'
      ? 'Checking current workspace…'
      : this.scope === 'current'
        ? 'Current workspace'
        : 'All workspaces'
    const left = `${color.textDim('Workspace: ')}${color.text(label)}${color.textMuted(' [w]')}`
    const trailing = color.textMuted('/ Search')
    return withTrailing(left, trailing, width)
  }

  private renderSelectorHeader(width: number): string {
    const marker = (selected: boolean): string => selected ? color.primary('> ') : '  '
    const options = [
      `${marker(this.selectorIndex === 0)}${color.text('All workspaces')}`,
      `${marker(this.selectorIndex === 1)}${this.currentScopeSelectable()
        ? color.text('Current workspace')
        : color.textMuted('Current workspace unavailable')}`,
    ]
    const line = `Workspace scope: ${options.join(color.textMuted(' · '))}`
    return fit(line, width)
  }

  private renderBody(width: number, budget: number): string[] {
    if (budget <= 0) return []
    if (this.focus === 'workspace') {
      return this.renderSelectorBody(width, budget)
    }
    if (this.searchMode) return this.renderSearchBody(width, budget)
    return this.renderBrowseBody(width, budget)
  }

  private renderSelectorBody(width: number, budget: number): string[] {
    const lines: string[] = []
    const total = this.browseRows().length
    lines.push(color.textDim(`${LIST_TITLE} · ${total}`))
    lines.push(...this.renderStatusLines(width))
    const rowBudget = budget - lines.length
    // The selector's own arrow is the ONLY active device while it is open; the
    // list underneath stops painting a second `>` selection marker.
    if (rowBudget > 0) lines.push(...this.renderBrowseRows(width, rowBudget, false))
    return lines.slice(0, budget)
  }

  private fitRow(line: string, width: number): string {
    return fit(line, width)
  }

  private renderBrowseBody(width: number, budget: number): string[] {
    const lines: string[] = []
    const total = this.browseRows().length
    lines.push(color.textDim(`${LIST_TITLE} · ${total}`))
    const statusRows = this.renderStatusLines(width)
    lines.push(...statusRows)
    if (this.helpVisible) lines.push(this.renderHelpLine(width))
    const rowBudget = budget - lines.length
    if (rowBudget > 0) lines.push(...this.renderBrowseRows(width, rowBudget))
    return lines.slice(0, budget)
  }

  private renderBrowseRows(width: number, budget: number, markSelected = true): string[] {
    this.lastPaintedListRows = Math.max(1, budget)
    const rows = this.browseRows()
    if (rows.length === 0) return []
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === this.selectedSessionId))
    this.browseScroll = rebaseOffset(this.browseScroll, selectedIndex, rows.length, budget)
    const visible = rows.slice(this.browseScroll, this.browseScroll + budget)
    return visible.map((row) => fit(this.browseRowLine(row, markSelected && row.id === this.selectedSessionId, width), width))
  }

  private renderSearchBody(width: number, budget: number): string[] {
    const lines: string[] = []
    this.searchInput.focused = this.focus === 'search'
    const inputLine = this.searchInput.render(width)[0] ?? ''
    lines.push(inputLine)
    const statusRows = this.renderStatusLines(width)
    lines.push(...statusRows)
    if (this.helpVisible) lines.push(this.renderHelpLine(width))
    const rowBudget = budget - lines.length
    if (rowBudget > 0) lines.push(...this.renderResultRows(width, rowBudget))
    return lines.slice(0, budget)
  }

  private renderResultRows(width: number, budget: number): string[] {
    this.lastPaintedListRows = Math.max(1, budget)
    const rows = this.snapshot.searchResults
    if (rows.length === 0) return []
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.row.id === this.selectedSessionId))
    this.resultScroll = rebaseOffset(this.resultScroll, selectedIndex, rows.length, budget)
    return rows
      .slice(this.resultScroll, this.resultScroll + budget)
      .map((result) => fit(this.searchRowLine(result, result.row.id === this.selectedSessionId, width), width))
  }

  private browseRowLine(row: SessionBrowserRow, selected: boolean, width: number): string {
    const current = row.id === this.options.currentSessionId
    const marker = selected ? color.primary('> ') : '  '
    const currentMark = current ? color.success('● ') : ''
    const title = row.title === undefined ? sanitizedPhysicalLine(shortSessionId(row.id)) : sanitizedPhysicalLine(row.title)
    const meta = [
      color.textMuted(formatSessionAge(row.updatedAt)),
      color.textDim(workspaceKey(row.cwd)),
    ].join(color.textMuted(' · '))
    const room = Math.max(1, width - 4 - visibleWidth(meta))
    const label = selected ? color.primary(truncateToWidth(title, room, '…', false)) : color.text(truncateToWidth(title, room, '…', false))
    return fit(`${marker}${currentMark}${label}  ${meta}`, width)
  }

  private searchRowLine(result: SessionBrowserSearchResult, selected: boolean, width: number): string {
    const row = result.row
    const current = row.id === this.options.currentSessionId
    const marker = selected ? color.primary('> ') : '  '
    const currentMark = current ? color.success('● ') : ''
    const title = row.title === undefined ? sanitizedPhysicalLine(shortSessionId(row.id)) : sanitizedPhysicalLine(row.title)
    const source = result.source === 'Both' ? 'metadata+content' : result.source.toLowerCase()
    const meta = [
      color.textMuted(`${source} · ${formatSessionAge(row.updatedAt)}`),
      color.textDim(workspaceKey(row.cwd)),
    ].join(color.textMuted(' · '))
    const snippet = result.snippet === undefined ? '' : ` · …${sanitizedPhysicalLine(result.snippet)}…`
    const room = Math.max(1, width - 4 - visibleWidth(meta) - visibleWidth(snippet))
    const label = selected ? color.primary(truncateToWidth(title, room, '…', false)) : color.text(truncateToWidth(title, room, '…', false))
    return fit(`${marker}${currentMark}${label}  ${meta}${snippet}`, width)
  }

  /** The ONE status projection shared by browse and search. Never a fabricated
   *  Session and never a false "no persisted sessions" claim. */
  private renderStatusLines(width: number): string[] {
    const lines: string[] = []
    const snapshot = this.snapshot
    const push = (text: string, kind: 'muted' | 'error' = 'muted'): void => {
      // A Host/extension notice is arbitrary bytes: it must cross the SAME
      // one-physical-row projection the title/cwd/snippet do before it paints.
      const line = sanitizedPhysicalLine(text)
      lines.push(kind === 'error'
        ? color.error(truncateToWidth(line, width, '…', false))
        : color.textMuted(truncateToWidth(line, width, '…', false)))
    }
    if (snapshot.resumePending) push('Opening session…')
    if (this.statusMessage !== undefined) push(this.statusMessage)
    // The app's ONE transient notice (a failed/indeterminate interactive switch,
    // a clipboard or settings notice). A leased workspace paints it because the
    // surface that normally does is paused underneath.
    const notice = this.host.notice()
    if (notice !== undefined) push(notice.text, notice.kind === 'error' ? 'error' : 'muted')
    if (snapshot.listState === 'error') {
      push(`session listing failed: ${sanitizedPhysicalLine(snapshot.listError ?? 'unknown error')}`, 'error')
    } else if (snapshot.listState === 'unavailable') {
      push('session persistence unavailable')
    } else if (snapshot.listState === 'empty') {
      push('No readable sessions')
    } else if (snapshot.listState === 'loading') {
      push('Loading sessions…')
    }
    if (this.workspaceError !== undefined) push(this.workspaceError)
    if (this.searchMode) {
      if (snapshot.searchState === 'loading') {
        push('Searching sessions…')
      } else if (snapshot.searchState === 'unavailable') {
        push('content search unavailable')
      } else if (snapshot.searchState === 'error') {
        push(`session content search failed: ${sanitizedPhysicalLine(snapshot.searchError ?? 'unknown error')}`, 'error')
      }
      if (snapshot.hasMore) push('More content matches exist — refine the search.')
    }
    if (snapshot.projectionError !== undefined) {
      push(`Some session details are unavailable: ${sanitizedPhysicalLine(snapshot.projectionError)}`)
    }
    return lines
  }

  private renderStatus(width: number): string {
    const lines = this.renderStatusLines(width)
    if (lines.length > 0) return lines[0]!
    const total = this.browseRows().length
    return color.textDim(truncateToWidth(`${LIST_TITLE} · ${total}`, width, '…', false))
  }

  private renderHelpLine(width: number): string {
    const text = this.searchMode
      ? 'Type to search · Enter results · Esc back'
      : 'Up/Down move · Enter open · / search · w workspace · ? help · Esc close'
    return color.textMuted(truncateToWidth(text, width, '…', false))
  }

  private renderActionBar(width: number): string {
    const segments = this.actionBarSegments()
    return color.textMuted(renderActionBarRow(segments, width))
  }

  private actionBarSegments(): { text: string; priority: number; short?: string }[] {
    if (this.focus === 'workspace') {
      return [
        { text: 'Up/Down choose', priority: 6, short: 'Choose' },
        { text: 'Enter apply', priority: 5, short: 'Apply' },
        { text: 'Esc cancel', priority: 9, short: 'Esc' },
      ]
    }
    if (this.focus === 'search-results') {
      return [
        { text: 'Up/Down move', priority: 6, short: 'Move' },
        { text: 'Enter open', priority: 7, short: 'Open' },
        { text: 'Esc back', priority: 9, short: 'Esc' },
      ]
    }
    if (this.focus === 'search') {
      return [
        { text: 'Enter results', priority: 5, short: 'Results' },
        { text: 'Esc back', priority: 9, short: 'Esc' },
      ]
    }
    return [
      { text: 'Up/Down move', priority: 6, short: 'Move' },
      { text: '/ search', priority: 5, short: '/' },
      { text: 'w workspace', priority: 4, short: 'w' },
      { text: '? help', priority: 3, short: '?' },
      { text: 'Enter open', priority: 7, short: 'Open' },
      { text: 'Esc close', priority: 9, short: 'Esc' },
    ]
  }
}
