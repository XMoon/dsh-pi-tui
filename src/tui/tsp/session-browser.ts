/** The internal native TSP Session Browser: read-only panel state and admission. */
import { View, span, ui, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import type { PickerAction, PickerGroup, PickerItem, PickerProps } from '@stencil-hq/tern'
import type {
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
  SessionBrowserRow,
  SessionBrowserSearchResult,
} from '../../app/command/session-browser-presentation.ts'
import { sanitizeSessionSearchInput } from '../../domain/session/browser.ts'
import {
  buildSessionWorkspaceView,
  SESSION_PENDING_LABEL,
  SESSION_SOURCE_LABEL,
  visibleWorkspaceBrowserRows,
  workspaceRowStatusLabel,
  type SessionWorkspaceRowFact,
  type WorkspaceBrowserRow,
} from '../presentation/session-workspace-view.ts'
import { formatSessionAge, sanitizeTerminalText, shortSessionId, workspaceKey } from '../pickers/sessions.ts'

const DETAILS_BODY_KEY_PREFIX = 'session-browser-details-body-'
const BROWSE_ACTIONS = ['close', 'details', 'use-directory', 'new-session', 'add-directory', 'resume'] as const

type BrowseAction = typeof BROWSE_ACTIONS[number] | 'confirm-directory'
type BrowserPage = 'browse' | 'details'
type BrowserZone = 'list' | 'actions'
type BrowserIntent =
  | { readonly kind: 'directory-edit'; readonly text: string; readonly cursor: number }
  | { readonly kind: 'directory-submit' }
  | { readonly kind: 'directory-cancel' }
  | { readonly kind: 'close' }
  | { readonly kind: 'browse-workspace'; readonly workspaceId: string; readonly toggle: boolean }
  | { readonly kind: 'browse-more'; readonly workspaceId: string; readonly reveal: boolean }
  | { readonly kind: 'workspace-toggle'; readonly workspaceId: string }
  | { readonly kind: 'browse-row'; readonly sessionId: string }
  | { readonly kind: 'resume'; readonly sessionId: string; readonly source: 'enter' | 'activate' | 'footer' }
  | { readonly kind: 'use-directory'; readonly workspaceId: string }
  | { readonly kind: 'new-session' }
  | { readonly kind: 'add-directory' }
  | { readonly kind: 'details' }
  | { readonly kind: 'back' }
  | { readonly kind: 'reader-scroll'; readonly step: ScrollTo }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
  | { readonly kind: 'zone'; readonly zone: BrowserZone }
  | { readonly kind: 'action-focus'; readonly delta: -1 | 1 }
  | { readonly kind: 'activate-action' }

interface SessionBrowserPanel {
  readonly serial: number
  readonly request: SessionBrowserPanelRequest
  nextCreateWorkspaceId: string | undefined
  revision: number
  disposed: boolean
  page: BrowserPage
  zone: BrowserZone
  selected: string | undefined
  selectedItem: string | undefined
  actionFocus: BrowseAction
  query: string
  cursor: number
  queryEdited: boolean
  initialQueryApplied: boolean
  readerEpoch: number
  snapshot: SessionBrowserReadSnapshot
  previousBrowse: { readonly selected: string | undefined; readonly selectedItem: string | undefined } | undefined
  directoryEntry: boolean
  directoryPath: string
  directoryCursor: number
  directorySubmitting: boolean
  readonly expandedWorkspaces: Map<string, boolean>
  readonly historyLimits: Map<string, number>}

type TargetKind = 'picker' | 'back' | 'other'
interface EventTarget {
  readonly panel: SessionBrowserPanel
  readonly revision: number
  readonly page: BrowserPage
  readonly readerEpoch: number
  readonly kind: TargetKind
}

const EMPTY_SNAPSHOT: SessionBrowserReadSnapshot = {
  listState: 'loading',
  rows: [],
  query: '',
  resumePending: false,
  searchState: 'idle',
  searchResults: [],
  hasMore: false,
  listRevision: 0,
}

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
function graphemeBounds(text: string): number[] {
  return [...graphemeSegmenter.segment(text)].map((segment) => segment.index).concat(text.length)
}

function editQuery(panel: SessionBrowserPanel, key: Key): { readonly query: string; readonly cursor: number } | undefined {
  if (key.ctrl === true || key.alt === true || key.meta === true) return undefined
  const bounds = graphemeBounds(panel.query)
  if (key.name === 'backspace') {
    const start = bounds.filter((index) => index < panel.cursor).at(-1) ?? 0
    return { query: panel.query.slice(0, start) + panel.query.slice(panel.cursor), cursor: start }
  }
  if (key.name === 'delete') {
    const end = bounds.find((index) => index > panel.cursor) ?? panel.query.length
    return { query: panel.query.slice(0, panel.cursor) + panel.query.slice(end), cursor: panel.cursor }
  }
  if (key.name === 'left') {
    return { query: panel.query, cursor: bounds.filter((index) => index < panel.cursor).at(-1) ?? 0 }
  }
  if (key.name === 'right') {
    return { query: panel.query, cursor: bounds.find((index) => index > panel.cursor) ?? panel.query.length }
  }
  if (key.name === 'home') return { query: panel.query, cursor: 0 }
  if (key.name === 'end') return { query: panel.query, cursor: panel.query.length }
  if (key.text === undefined) return undefined
  const prefix = panel.query.slice(0, panel.cursor) + key.text
  const rawCursor = panel.cursor + key.text.length
  return {
    query: prefix + panel.query.slice(panel.cursor),
    cursor: graphemeBounds(prefix).find((index) => index >= rawCursor) ?? prefix.length,
  }
}

function queryMode(panel: SessionBrowserPanel): boolean {
  return panel.snapshot.query !== ''
}

function workspaceModel(panel: SessionBrowserPanel) {
  const snapshot = panel.snapshot.workspace
  if (snapshot === undefined) return undefined
  return buildSessionWorkspaceView({
    rows: panel.snapshot.rows,
    activity: snapshot.activity,
    answerEligibility: snapshot.answerEligibility,
    workspaces: snapshot.facts,
    workspaceBaselineProven: snapshot.baselineProven,
    scope: { kind: 'all' },
    currentSessionId: panel.request.subject.currentSessionId,
    ...(panel.request.subject.currentSessionId === undefined && panel.nextCreateWorkspaceId !== undefined
      ? { nextCreateWorkspaceId: panel.nextCreateWorkspaceId }
      : {}),
  })
}

function priorityWorkspaceId(panel: SessionBrowserPanel): string | undefined {
  const model = workspaceModel(panel)
  return model?.nextCreateWorkspaceId ?? model?.currentWorkspaceId
}

function browseRows(panel: SessionBrowserPanel): readonly { readonly row: SessionBrowserRow; readonly depth: number }[] {
  if (panel.snapshot.workspace === undefined) {
    return panel.snapshot.rows.map(row => ({ row, depth: 0 }))
  }
  const model = workspaceModel(panel)
  if (model === undefined || !model.workspaceBaselineProven) {
    return panel.snapshot.rows.map(row => ({ row, depth: 0 }))
  }
  const visible = visibleWorkspaceBrowserRows(model, {
    expanded: panel.expandedWorkspaces,
    historyLimit: panel.historyLimits,
  }, panel.selected, panel.request.subject.currentSessionId)
  return visible.flatMap(item => item.kind !== 'session' ? [] : (() => {
    const row = panel.snapshot.rows.find(candidate => candidate.id === item.sessionId)
    return row === undefined ? [] : [{ row, depth: 1 }]
  })())
}

function workspaceGroups(panel: SessionBrowserPanel): readonly {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly rows: readonly SessionBrowserRow[]
  readonly needs: number
  readonly working: number
}[] {
  const model = workspaceModel(panel)
  if (model === undefined || !model.workspaceBaselineProven) return []
  return model.groups.map(group => {
    const rows = group.ids.flatMap(id => {
      const row = panel.snapshot.rows.find(candidate => candidate.id === id)
      return row === undefined ? [] : [row]
    })
    return {
      id: `workspace:${group.workspaceId}`,
      workspaceId: group.workspaceId,
      title: group.title,
      path: group.path,
      rows,
      needs: group.ids.filter(id => model.rowsById.get(id)?.priority === 'needs').length,
      working: group.ids.filter(id => model.rowsById.get(id)?.priority === 'working').length,
    }
  })
}

function visibleSearchResults(panel: SessionBrowserPanel): readonly SessionBrowserSearchResult[] {
  return queryMode(panel) ? panel.snapshot.searchResults : []
}

function visibleRows(panel: SessionBrowserPanel): readonly SessionBrowserRow[] {
  return queryMode(panel)
    ? visibleSearchResults(panel).map((result) => result.row)
    : browseRows(panel).map((entry) => entry.row)
}

function rowFor(panel: SessionBrowserPanel, id: string | undefined): SessionBrowserRow | undefined {
  return id === undefined ? undefined : visibleRows(panel).find((row) => row.id === id)
}

function firstBrowseId(panel: SessionBrowserPanel): string | undefined {
  const current = panel.request.subject.currentSessionId
  const rows = visibleRows(panel)
  return rows.some((row) => row.id === current) ? current : rows[0]?.id
}

/** The selected Folder is an OFFICIAL Host Workspace, not the synthetic
 *  Unassigned/Membership-ambiguous projection group. */
function officialWorkspaceSelected(panel: SessionBrowserPanel): boolean {
  const item = panel.selectedItem
  if (item === undefined || !item.startsWith('workspace:')) return false
  const workspaceId = item.slice('workspace:'.length)
  return panel.snapshot.workspace?.facts.some(fact => fact.workspaceId === workspaceId) === true
}

/** The typed selection is EXACTLY one Session row: a Folder/Show-more item may
 *  keep a browse cursor anchor, but it never owns a Session action. */
function selectedSessionRow(panel: SessionBrowserPanel): SessionBrowserRow | undefined {
  if (panel.selected === undefined) return undefined
  // Flat fallback has no typed item identity; the selected row itself is the
  // target. A Folder/Show-more item is never a Session action target.
  if (panel.selectedItem !== undefined && panel.selectedItem !== `session:${panel.selected}`) return undefined
  return rowFor(panel, panel.selected)
}

function actionDisabledReason(panel: SessionBrowserPanel, base: BrowseAction): string | undefined {
  if (base === 'confirm-directory') {
    if (panel.directorySubmitting) return 'Directory verification is in progress.'
    if (panel.request.onAddDirectory === undefined) return 'Directory verification is unavailable.'
    if (!panel.directoryPath.trim().startsWith('/')) return 'Enter an absolute Host path.'
    return undefined
  }
  if (base === 'close' && panel.directoryEntry && panel.directorySubmitting) return 'Wait for directory verification to finish.'
  if (base === 'use-directory') {
    return panel.request.subject.currentSessionId === undefined && officialWorkspaceSelected(panel)
      ? undefined
      : 'Select an official Workspace while sessionless.'
  }
  if (base === 'new-session') {
    return officialWorkspaceSelected(panel) ? undefined : 'Select an official Workspace folder first.'
  }
  if (base === 'add-directory') return panel.request.onAddDirectory === undefined ? 'Directory entry is unavailable.' : undefined
  if (base === 'details' && selectedSessionRow(panel) === undefined) return 'Select a session to read its details.'
  if (base === 'resume') {
    if (panel.snapshot.resumePending) return 'Switching sessions…'
    const row = selectedSessionRow(panel)
    if (row === undefined) return panel.snapshot.listState === 'loading' ? 'Sessions are still loading.' : 'Select a session to resume.'
    if (row.id === panel.request.subject.currentSessionId) return 'The current session is already active.'
  }
  return undefined
}

function browseActions(panel: SessionBrowserPanel): readonly BrowseAction[] {
  if (panel.directoryEntry) return ['confirm-directory', 'close']
  // Add directory is a directory operation that never needs a Workspace
  // baseline; every unavailable action carries its own disabled reason.
  return BROWSE_ACTIONS
}

function enabledActions(panel: SessionBrowserPanel): BrowseAction[] {
  return browseActions(panel).filter((base) => actionDisabledReason(panel, base) === undefined)
}

function focusedAction(panel: SessionBrowserPanel): BrowseAction {
  const enabled = enabledActions(panel)
  return enabled.includes(panel.actionFocus) ? panel.actionFocus : enabled[0]!
}

function stepActionFocus(panel: SessionBrowserPanel, delta: -1 | 1): BrowseAction {
  const enabled = enabledActions(panel)
  if (enabled.length === 0) return panel.actionFocus
  const at = enabled.indexOf(focusedAction(panel))
  return enabled[(at + delta + enabled.length) % enabled.length]!
}

function normalize(panel: SessionBrowserPanel): void {
  if (panel.page === 'details') {
    if (rowFor(panel, panel.selected) === undefined) {
      panel.page = 'browse'
      panel.readerEpoch++
      panel.zone = 'list'
      panel.selected = firstBrowseId(panel)
    } else {
      return
    }
  }
  const folderOrMore = panel.selectedItem?.startsWith('workspace:') === true || panel.selectedItem?.startsWith('more:') === true
  if (folderOrMore) {
    panel.selected = undefined
  } else if (panel.selected === undefined || rowFor(panel, panel.selected) === undefined) {
    panel.selected = firstBrowseId(panel)
  }
  if (panel.zone === 'actions') panel.actionFocus = focusedAction(panel)
}

function actionId(panel: SessionBrowserPanel, action: BrowseAction): string {
  return `${action}#${panel.revision}`
}

function actionLabel(action: BrowseAction): string {
  switch (action) {
    case 'close': return 'Close'
    case 'details': return 'Details'
    case 'use-directory': return 'Use directory'
    case 'new-session': return 'New session'
    case 'add-directory': return 'Add directory'
    case 'confirm-directory': return 'Use directory'
    case 'resume': return 'Resume'
  }
}

function actionList(panel: SessionBrowserPanel): PickerAction[] {
  const focus = panel.zone === 'actions' ? focusedAction(panel) : undefined
  const folderSelected = panel.selectedItem?.startsWith('workspace:') === true
  // A Folder-only action is offered only while a Folder is selected: the
  // native bar has no whole-segment drop of its own, and an inapplicable
  // button is what pushes the enabled primary action out of a narrow pane.
  return browseActions(panel).filter((base) => {
    if (base === 'use-directory') return panel.request.subject.currentSessionId === undefined && folderSelected
    if (base === 'new-session') return folderSelected
    return true
  }).map((base) => {
    const disabled = actionDisabledReason(panel, base)
    const focused = base === focus
    return {
      id: base === 'close' ? base : actionId(panel, base),
      label: `${panel.directoryEntry && base === 'close' ? 'Cancel' : actionLabel(base)}${focused ? ' [Enter]' : ''}`,
      ...(base === 'resume' ? { primary: true } : {}),
      ...(disabled === undefined ? {} : { disabled }),
    }
  })
}

function rowItem(
  row: SessionBrowserRow,
  depth: number | undefined,
  result?: SessionBrowserSearchResult,
  fact?: SessionWorkspaceRowFact,
): PickerItem {
  const title = row.title === undefined || row.title.trim() === '' ? shortSessionId(row.id) : row.title
  // Host-authoritative on-disk format state: a read-only label with no new
  // control. `current` and absent add nothing.
  const migration = row.formatStatus === 'migration-required' ? 'Migration required' : undefined
  const workspaceText = row.workspace === undefined
    ? workspaceKey(row.cwd)
    : `${row.workspace.title} · ${row.workspace.path}`
  const status = fact === undefined ? undefined : workspaceRowStatusLabel(fact)
  const detail = [
    workspaceText,
    status,
    `Updated ${formatSessionAge(row.updatedAt)}`,
    migration,
    row.preset === undefined ? undefined : `Preset ${row.preset}`,
    row.live ? 'Live' : 'Persisted',
    shortSessionId(row.id),
  ].filter((part): part is string => part !== undefined).map(sanitizeTerminalText).join(' · ')
  const badges: NonNullable<PickerItem['badges']>[number][] = []
  if (row.parentSession !== undefined) badges.push({ text: 'Fork', tone: 'muted' })
  if (result !== undefined) badges.push({
    text: sanitizeTerminalText(result.source),
    tone: result.source === 'Content' ? 'info' : 'muted',
  })
  return {
    id: `session:${row.id}`,
    label: sanitizeTerminalText(title),
    // The search-excerpt branch keeps the SAME state label: a Host content
    // match must never hide that the row needs migration.
    detail: result?.snippet === undefined
      ? detail
      : [
          `${row.workspace?.title ?? workspaceKey(row.cwd)} · ${row.workspace?.path ?? ''}`,
          `Updated ${formatSessionAge(row.updatedAt)}`,
          migration,
          sanitizeTerminalText(result.snippet),
        ].filter((part): part is string => part !== undefined).join(' · '),
    title: sanitizeTerminalText(row.id),
    ...(depth === undefined ? {} : { depth }),
    ...(badges.length === 0 ? {} : { badges }),
  }
}

function statusText(panel: SessionBrowserPanel): string | undefined {
  const snapshot = panel.snapshot
  const workspaceMessage = snapshot.workspace?.state === 'unavailable'
    ? `Workspace information unavailable${snapshot.workspace.error === undefined ? '' : `: ${sanitizeTerminalText(snapshot.workspace.error)}`}`
    : undefined
  if (snapshot.listState === 'loading') return 'Loading persisted sessions…'
  if (snapshot.listState === 'unavailable') return 'Session listing is unavailable.'
  if (snapshot.listState === 'error') return `Session listing failed: ${sanitizeTerminalText(snapshot.listError ?? 'unknown error')}`
  const projectionMessage = snapshot.projectionError === undefined
    ? undefined
    : `Some session details are unavailable: ${sanitizeTerminalText(snapshot.projectionError)}`
  if (!queryMode(panel)) {
    return [workspaceMessage, projectionMessage].filter((part): part is string => part !== undefined).join(' ') || undefined
  }
  const searchMessage = snapshot.searchState === 'loading' ? 'Searching session content…'
    : snapshot.searchState === 'unavailable' ? 'Content search is unavailable; metadata matches remain visible.'
      : snapshot.searchState === 'error'
        ? `Content search failed: ${sanitizeTerminalText(snapshot.searchError ?? 'unknown error')}; metadata matches remain visible.`
        : snapshot.hasMore ? 'More matches are available; refine the query.' : undefined
  const browseMessage = [workspaceMessage, projectionMessage].filter((part): part is string => part !== undefined).join(' ')
  if (searchMessage === undefined) return browseMessage === '' ? undefined : browseMessage
  return browseMessage === '' ? searchMessage : `${searchMessage} ${browseMessage}`
}

function emptyText(panel: SessionBrowserPanel): string {
  const snapshot = panel.snapshot
  if (snapshot.listState === 'loading') return 'Loading persisted sessions…'
  if (snapshot.listState === 'unavailable') return 'No session listing capability is available.'
  if (snapshot.listState === 'error') return 'The session list could not be loaded.'
  if (!queryMode(panel)) return snapshot.listState === 'empty' ? 'No persisted sessions are available.' : 'No sessions are available.'
  if (snapshot.searchState === 'loading') return 'Searching…'
  if (snapshot.searchState === 'unavailable') return 'No metadata matches; content search is unavailable.'
  if (snapshot.searchState === 'error') return 'No metadata matches; content search failed.'
  return 'No sessions match this search.'
}

function pickerSubtitle(panel: SessionBrowserPanel): string {
  const currentId = panel.request.subject.currentSessionId
  const current = currentId === undefined ? 'No current session' : `Current ${sanitizeTerminalText(shortSessionId(currentId))}`
  return queryMode(panel)
    ? `${panel.snapshot.searchResults.length} global matches · ${current}`
    : `All workspaces · ${current}`
}

function workspaceItem(group: {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly rows: readonly SessionBrowserRow[]
  readonly total?: number
  readonly needs?: number
  readonly working?: number
  readonly expanded: boolean
  readonly current?: boolean
  readonly next?: boolean
}): PickerItem {
  const activity = (group.needs ?? 0) + (group.working ?? 0) > 0
    ? ` · ${group.needs ?? 0} Needs · ${group.working ?? 0} Working`
    : ''
  return {
    id: group.id,
    label: `${group.current ? 'Current · ' : group.next ? 'Next · ' : ''}${sanitizeTerminalText(group.title)}`,
    detail: `${group.total ?? group.rows.length} sessions${activity} · ${sanitizeTerminalText(group.path)}`,
    title: sanitizeTerminalText(group.workspaceId),
    depth: 0,
    open: group.expanded,
  }
}
function showMoreItem(group: { readonly workspaceId: string; readonly remaining: number }): PickerItem {
  return {
    id: `more:${group.workspaceId}`,
    label: 'Show more sessions',
    detail: `${group.remaining} remaining`,
    title: `more:${group.workspaceId}`,
    depth: 1,
  }
}

function visibleBrowseItems(panel: SessionBrowserPanel): PickerItem[] {
  const model = workspaceModel(panel)
  if (model === undefined || !model.workspaceBaselineProven) return panel.snapshot.rows.map(row => rowItem(row, 0))
  const display = {
    expanded: new Map([...panel.expandedWorkspaces].map(([id, value]) => [id, value] as const)),
    historyLimit: panel.historyLimits,
  }
  const projected = visibleWorkspaceBrowserRows(model, display, panel.selected, panel.request.subject.currentSessionId)
  return projected.flatMap((row): PickerItem[] => {
    if (row.kind === 'folder') return [workspaceItem({ id: row.id, workspaceId: row.workspaceId, title: row.title, path: row.path, rows: [], total: row.total, needs: row.needs, working: row.working, expanded: row.expanded, current: row.current, next: row.next })]
    if (row.kind === 'showMore') return [showMoreItem({ workspaceId: row.workspaceId, remaining: row.remaining })]
    if (row.kind === 'session') {
      const session = panel.snapshot.rows.find(candidate => candidate.id === row.sessionId)
      return session === undefined ? [] : [rowItem(session, 1, undefined, model.rowsById.get(row.sessionId))]
    }
    return []
  })
}
function pickerLayerItems(panel: SessionBrowserPanel): readonly PickerItem[] {
  if (panel.snapshot.workspace?.baselineProven === true) return visibleBrowseItems(panel)
  return panel.snapshot.rows.map(row => rowItem(row, 0))
}

function pickerLayer(panel: SessionBrowserPanel): Node {
  const pathEntry = panel.directoryEntry
  const searching = !pathEntry && queryMode(panel)
  const searchResults = searching ? visibleSearchResults(panel) : []
  const rows: readonly PickerItem[] = pathEntry ? [] : searching
    ? searchResults.map((result) => rowItem(result.row, undefined, result))
    : pickerLayerItems(panel)
  const selected = pathEntry ? undefined : panel.selectedItem ?? (panel.selected === undefined ? undefined : `session:${panel.selected}`)
  const currentId = panel.request.subject.currentSessionId
  const currentItem = currentId === undefined ? undefined : `session:${currentId}`
  const current = currentItem !== undefined && rows.some((item) => item.id === currentItem) ? [currentItem] : []
  const order: Array<string | PickerGroup> = rows.map(item => item.id)
  const pickerKey = `session-browser-picker-${panel.serial}`
  const actions = actionList(panel)
  const props: PickerProps & { readonly key: string } = {
    key: pickerKey,
    title: pathEntry ? 'Add directory' : 'Sessions',
    subtitle: pathEntry ? 'Host absolute path · Enter validate · Esc cancel' : pickerSubtitle(panel),
    layout: searching ? 'cards' : 'tree',
    size: 'lg',
    preview: 'none',
    query: pathEntry ? panel.directoryPath : panel.query,
    cursor: pathEntry ? panel.directoryCursor : panel.cursor,
    placeholder: pathEntry ? '/path/to/project' : 'Search sessions and messages…',
    noun: 'sessions',
    focus: pathEntry ? panel.zone === 'actions' ? undefined : 'list' : panel.zone === 'list' ? 'list' : undefined,
    state: pathEntry ? 'ready' : panel.snapshot.listState === 'error' || panel.snapshot.listState === 'unavailable'
      ? 'error'
      : panel.snapshot.listState === 'loading' || (searching && panel.snapshot.searchState === 'loading')
        ? 'loading'
        : searching && (panel.snapshot.searchState === 'error' || panel.snapshot.searchState === 'unavailable')
          ? 'error'
          : 'ready',
    ...(pathEntry ? { message: 'Enter an absolute Host path to add a directory.' } : statusText(panel) === undefined ? {} : { message: statusText(panel) }),
    empty: pathEntry ? 'Enter the Host absolute path, then press Enter.' : emptyText(panel),
    total: rows.length,
    items: rows,
    order,
    ...(selected === undefined || !rows.some((item) => item.id === selected) ? {} : { selected }),
    current,
    actions,
  }
  return ui.col({ key: `session-browser-layer-${panel.serial}` }, ui.picker(props))
}

function detailResult(panel: SessionBrowserPanel, row: SessionBrowserRow): SessionBrowserSearchResult | undefined {
  return panel.snapshot.searchResults.find((result) => result.row.id === row.id)
}

/** The existing Identity `State` value, extended with the Host-authoritative
 * on-disk format state when the Client reported one. `current` and absent add
 * nothing; no new fact group or control is introduced. */
function rowStateText(panel: SessionBrowserPanel, row: SessionBrowserRow): string {
  const base = row.id === panel.request.subject.currentSessionId
    ? 'Current session'
    : row.live ? 'Live session' : 'Persisted session'
  return row.formatStatus === 'migration-required' ? `${base} · Migration required` : base
}

/** The excerpt group's id: the ONE group whose body is Host content the user reads
 *  as prose, so it is never a grid row (see `detailReader`). */
const EXCERPT_GROUP_ID = 'excerpt'

/**
 * The read-only Session Details Reader.
 *
 * The four fact groups (Identity / Activity / Lineage / Configuration) are labelled
 * short facts, so on a pane that negotiated `kv` each paints as ONE native grid: the
 * client aligns every label with its value instead of paying a separate line per
 * label, which is what lets a narrow pane show more of the same facts at once. The
 * values are the SAME complete strings the text branch sends and the client owns any
 * wrapping (`KvItem` has no `wrap`), so an unbroken ID or a long cwd stays whole.
 *
 * The Host search excerpt is a different shape: its value is matched CONTENT read as
 * prose, so it keeps its own `Matching content` label plus one complete wrapped
 * `ui.text` at EVERY capability. A pane without `kv` keeps the original per-fact text
 * rows verbatim, in the same order, with the same scroll body and the same Back row.
 */
function detailReader(
  panel: SessionBrowserPanel,
  bind: (intent: BrowserIntent) => () => void,
  nativeKv: boolean,
): Node {
  const row = rowFor(panel, panel.selected)
  const scope = `${panel.serial}-${panel.readerEpoch}`
  const bodyKey = `${DETAILS_BODY_KEY_PREFIX}${scope}`
  const title = row?.title === undefined || row.title.trim() === '' ? row === undefined ? 'Session details' : shortSessionId(row.id) : row.title
  const result = row === undefined ? undefined : detailResult(panel, row)
  const activity = row === undefined ? undefined : workspaceModel(panel)?.rowsById.get(row.id)
  const groups = row === undefined ? [] : [
    {
      id: 'identity',
      head: 'Identity',
      facts: [
        ['Session ID', row.id],
        ['Title', title],
        ['State', rowStateText(panel, row)],
        ['Workspace', row.cwd === undefined ? 'Unknown workspace' : row.cwd],
      ],
    },
    {
      id: 'activity',
      head: 'Activity',
      facts: [
        ['Created', row.createdAt === undefined ? 'Unknown' : new Date(row.createdAt).toISOString()],
        ['Updated', new Date(row.updatedAt).toISOString()],
        ['Running', activity?.running === true ? 'Yes' : activity?.running === false ? 'No' : 'Unknown'],
        ['Pending', activity === undefined ? 'Unknown' : SESSION_PENDING_LABEL[activity.pending]],
        ['Source', activity === undefined ? 'unknown' : SESSION_SOURCE_LABEL[activity.source]],
      ],
    },
    {
      id: 'relationship',
      head: 'Lineage',
      facts: [['Parent session', row.parentSession ?? 'No parent session']],
    },
    {
      id: 'configuration',
      head: 'Configuration',
      facts: [['Agent preset', row.preset ?? 'Unknown preset']],
    },
    ...(result?.snippet === undefined ? [] : [{
      id: EXCERPT_GROUP_ID,
      head: `Host search excerpt · ${result.source}`,
      facts: [['Matching content', result.snippet]],
    }]),
  ]
  return ui.col(
    { key: `session-browser-reader-layer-${panel.serial}` },
    ui.overlay(
      { key: `session-browser-reader-${scope}`, head: 'Session details', size: 'lg', modal: true },
      ui.row(
        { key: `session-browser-back-${scope}`, onClick: bind({ kind: 'back' }) },
        ui.text(span('← Back to sessions · Esc', 'accent')),
      ),
      ui.col(
        { key: bodyKey, gap: 'xs' },
        ...(row === undefined
          ? [ui.text(span('The selected session is no longer available.', 'muted'))]
          : groups.map((group) => ui.col(
              { key: `session-browser-group-${group.id}`, gap: 'xs' },
              ui.text(span(sanitizeTerminalText(group.head), 'muted')),
              ...(nativeKv && group.id !== EXCERPT_GROUP_ID
                ? [ui.kv({
                    key: `session-browser-kv-${group.id}`,
                    layout: 'grid',
                    items: group.facts.map(([label, value]) => ({
                      k: sanitizeTerminalText(label),
                      v: sanitizeTerminalText(value),
                    })),
                  })]
                : group.facts.flatMap(([label, value]) => [
                    ui.text(span(label, 'muted')),
                    ui.text({ wrap: 'word' }, sanitizeTerminalText(value)),
                  ])),
            )))
      ),
    ),
  )
}

function layer(
  panel: SessionBrowserPanel,
  bind: (intent: BrowserIntent) => () => void,
  nativeKv: boolean,
): Node {
  return panel.page === 'details' ? detailReader(panel, bind, nativeKv) : pickerLayer(panel)
}

export class TspSessionBrowser {
  private readonly surfaceId: string
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: SessionBrowserPresentation['notify']
  private readonly nativeScroll: (id: string, to: ScrollTo) => void
  private readonly scrollSupported: boolean
  /** Whether the pane negotiated the read-only `kv` kind. Like `scrollSupported`
   *  it is a fixed mount-time capability of the pane, NOT panel state: it is never
   *  part of a snapshot or a draft a re-read can rewrite. */
  private readonly nativeKv: boolean
  private panel: SessionBrowserPanel | undefined
  private serial = 0
  private suspended = false
  private targets = new Map<string, EventTarget>()
  private readerBodyId: string | undefined

  constructor(deps: {
    surfaceId: string
    render(): void
    canInteract(): boolean
    notify: SessionBrowserPresentation['notify']
    nativeScroll(id: string, to: ScrollTo): void
    scrollSupported: boolean
    nativeKv: boolean
  }) {
    this.surfaceId = deps.surfaceId
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
    this.nativeScroll = deps.nativeScroll
    this.scrollSupported = deps.scrollSupported
    this.nativeKv = deps.nativeKv
  }

  readonly presentation: SessionBrowserPresentation = {
    open: (request) => this.open(request),
    notify: (message, kind) => this.notify(message, kind),
  }

  private current(): SessionBrowserPanel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.disposed) return undefined
    if (!panel.request.subject.isCurrent()) {
      this.retire()
      return undefined
    }
    return panel
  }

  private open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle {
    this.retire()
    const panel: SessionBrowserPanel = {
      serial: ++this.serial,
      request,
      nextCreateWorkspaceId: request.subject.currentWorkspaceId,
      revision: 0,
      disposed: false,
      page: 'browse',
      zone: 'list',
      selected: undefined,
      selectedItem: undefined,
      directoryEntry: request.initialDirectoryEntry === true,
      directoryPath: request.initialDirectoryPath ?? '',
      directoryCursor: request.initialDirectoryPath?.length ?? 0,
      directorySubmitting: false,
      actionFocus: 'details',
      query: '',
      cursor: 0,
      queryEdited: false,
      initialQueryApplied: false,
      readerEpoch: 0,
      snapshot: EMPTY_SNAPSHOT,
      previousBrowse: undefined,
       expandedWorkspaces: new Map(),
       historyLimits: new Map(),
    }
    this.panel = panel
    this.change(panel)
    return {
      isDisposed: () => panel.disposed,
      setSnapshot: (snapshot, options) => {
        if (this.current() !== panel) return
        if (options?.initialQuery !== undefined && !panel.initialQueryApplied) {
          panel.initialQueryApplied = true
          if (!panel.queryEdited) {
            panel.query = options.initialQuery
            panel.cursor = options.initialQuery.length
          }
        }
        panel.snapshot = snapshot
        normalize(panel)
        this.change(panel)
      },
      close: () => this.close(panel, false),
    }
  }

  private release(panel: SessionBrowserPanel, notifyOwner: boolean): void {
    if (panel.disposed) return
    panel.disposed = true
    panel.snapshot = EMPTY_SNAPSHOT
    panel.query = ''
    panel.selected = undefined
    if (this.panel === panel) {
      this.panel = undefined
      this.targets.clear()
      this.readerBodyId = undefined
    }
    if (notifyOwner) panel.request.onClose()
  }

  private close(panel: SessionBrowserPanel, notifyOwner: boolean): void {
    this.release(panel, notifyOwner)
    this.render()
  }

  retire(): void {
    const panel = this.panel
    if (panel === undefined) return
    this.release(panel, true)
  }

  isOpen(): boolean {
    return this.current() !== undefined
  }

  suspend(): void {
    if (!this.suspended) {
      this.suspended = true
      if (this.panel !== undefined) this.panel.revision++
      this.targets.clear()
      this.readerBodyId = undefined
    }
  }

  desiredFocusId(): string | undefined {
    return this.targets.keys().next().value
  }

  private change(panel: SessionBrowserPanel): void {
    normalize(panel)
    panel.revision++
    if (this.panel === panel && !panel.disposed) this.render()
  }

  private updateQuery(panel: SessionBrowserPanel, query: string, cursor: number): void {
    const textChanged = query !== panel.query
    const wasSearching = queryMode(panel)
    const willSearch = sanitizeSessionSearchInput(query) !== ''
    if (!wasSearching && willSearch) {
      panel.previousBrowse = { selected: panel.selected, selectedItem: panel.selectedItem }
    } else if (wasSearching && !willSearch) {
      const previous = panel.previousBrowse
      panel.selected = previous?.selected
      panel.selectedItem = previous?.selectedItem
      panel.previousBrowse = undefined
    }
    panel.query = query
    panel.cursor = cursor
    panel.zone = 'list'
    const revision = panel.revision
    if (textChanged) {
      panel.queryEdited = true
      panel.request.onQueryChange(query)
    }
    if (this.panel !== panel || panel.disposed) return
    if (panel.revision === revision) this.change(panel)
  }

  private visibleActionIntent(panel: SessionBrowserPanel, base: string): BrowserIntent | undefined {
    if (panel.page !== 'browse') return undefined
    if (base === 'close') return panel.directoryEntry
      ? panel.directorySubmitting ? undefined : { kind: 'directory-cancel' }
      : { kind: 'close' }
    if (base === 'confirm-directory' && actionDisabledReason(panel, base) === undefined) return { kind: 'directory-submit' }
    if (base === 'add-directory' && actionDisabledReason(panel, base) === undefined) return { kind: 'add-directory' }
    if (base === 'use-directory' && actionDisabledReason(panel, base) === undefined && panel.selectedItem?.startsWith('workspace:')) {
      return { kind: 'use-directory', workspaceId: panel.selectedItem.slice('workspace:'.length) }
    }
    if (base === 'new-session' && actionDisabledReason(panel, base) === undefined) return { kind: 'new-session' }
    if (base === 'details' && rowFor(panel, panel.selected) !== undefined) return { kind: 'details' }
    if (base === 'resume' && actionDisabledReason(panel, 'resume') === undefined && panel.selected !== undefined) {
      return { kind: 'resume', sessionId: panel.selected, source: 'footer' }
    }
    return undefined
  }

  private act(panel: SessionBrowserPanel, revision: number, intent: BrowserIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    if (intent.kind === 'close') {
      this.close(panel, true)
      return
    }
    if (panel.page === 'details') {
      if (intent.kind === 'back') {
        panel.page = 'browse'
        panel.zone = 'list'
        this.change(panel)
      } else if (intent.kind === 'reader-scroll' && this.scrollSupported && this.readerBodyId !== undefined) {
        this.nativeScroll(this.readerBodyId, intent.step)
      }
      return
    }
    switch (intent.kind) {
      case 'browse-workspace':
        panel.selectedItem = `workspace:${intent.workspaceId}`
        panel.selected = undefined
        if (intent.toggle) {
          const expanded = panel.expandedWorkspaces.get(intent.workspaceId)
            ?? (intent.workspaceId === priorityWorkspaceId(panel) || (workspaceGroups(panel).find(group => group.workspaceId === intent.workspaceId)?.needs ?? 0) > 0 || (workspaceGroups(panel).find(group => group.workspaceId === intent.workspaceId)?.working ?? 0) > 0)
          if (!expanded) {
            if (!panel.historyLimits.has(intent.workspaceId)) {
              panel.historyLimits.set(intent.workspaceId, intent.workspaceId === priorityWorkspaceId(panel) ? 8 : 5)
            }
            panel.expandedWorkspaces.set(intent.workspaceId, true)
          } else {
            panel.expandedWorkspaces.set(intent.workspaceId, false)
          }
        }
        this.change(panel)
        return
      case 'browse-more':
        panel.selectedItem = `more:${intent.workspaceId}`
        panel.selected = undefined
        if (intent.reveal) {
          const expanded = panel.expandedWorkspaces.get(intent.workspaceId)
            ?? (intent.workspaceId === priorityWorkspaceId(panel) || (workspaceGroups(panel).find(group => group.workspaceId === intent.workspaceId)?.needs ?? 0) > 0 || (workspaceGroups(panel).find(group => group.workspaceId === intent.workspaceId)?.working ?? 0) > 0)
          if (expanded) {
            const current = panel.historyLimits.get(intent.workspaceId)
              ?? (intent.workspaceId === priorityWorkspaceId(panel) ? 8 : 0)
            panel.historyLimits.set(intent.workspaceId, current + 5)
          } else {
            panel.historyLimits.set(intent.workspaceId, 5)
          }
          panel.expandedWorkspaces.set(intent.workspaceId, true)
        }
        this.change(panel)
        return
      case 'use-directory': {
        const workspace = panel.snapshot.workspace?.facts.find(fact => fact.workspaceId === intent.workspaceId)
        if (workspace === undefined) return
        panel.request.onUseDirectory?.(intent.workspaceId, workspace.path)
        this.close(panel, true)
        return
      }
      case 'directory-edit':
        panel.directoryPath = intent.text
        panel.directoryCursor = intent.cursor
        this.change(panel)
        return
      case 'directory-cancel':
        if (panel.directorySubmitting) return
        panel.directoryEntry = false
        panel.directoryPath = ''
        panel.directoryCursor = 0
        panel.zone = 'list'
        this.change(panel)
        return
      case 'directory-submit': {
        if (panel.directorySubmitting) return
        const path = panel.directoryPath.trim()
        if (!path.startsWith('/')) {
          this.notify('Enter an absolute Host path beginning with /.', 'error')
          return
        }
        panel.directorySubmitting = true
        this.change(panel)
        panel.request.onAddDirectory?.(path, outcome => {
          if (this.current() !== panel) return
          panel.directorySubmitting = false
          if (outcome.kind === 'registered') {
            panel.nextCreateWorkspaceId = outcome.workspaceId
            if (panel.request.initialDirectoryChooser === true) {
              this.close(panel, true)
              return
            }
            panel.directoryEntry = false
            panel.snapshot = { ...panel.snapshot, refreshError: undefined }
            this.notify(`Directory added: ${outcome.path}`, 'info')
          } else {
            this.notify(outcome.message, 'error')
          }
          this.change(panel)
        })
        return
      }
      case 'new-session': {
        const item = panel.selectedItem
        if (item?.startsWith('workspace:')) panel.request.onNewSession?.(item.slice('workspace:'.length))
        return
      }
      case 'add-directory':
        panel.directoryEntry = true
        panel.directoryPath = ''
        panel.directoryCursor = 0
        this.change(panel)
        return
      case 'workspace-toggle': {
        const workspaceId = intent.workspaceId.slice('workspace:'.length)
        const group = workspaceGroups(panel).find(candidate => candidate.workspaceId === workspaceId)
        const expanded = panel.expandedWorkspaces.get(workspaceId)
          ?? (workspaceId === priorityWorkspaceId(panel) || (group?.needs ?? 0) > 0 || (group?.working ?? 0) > 0)
        panel.expandedWorkspaces.set(workspaceId, !expanded)
        this.change(panel)
        return
      }
      case 'browse-row':
        if (!visibleRows(panel).some((row) => row.id === intent.sessionId)) return
        panel.selected = intent.sessionId
        panel.selectedItem = `session:${intent.sessionId}`
        panel.zone = 'list'
        this.change(panel)
        return
      case 'resume': {
        if (panel.snapshot.resumePending || !visibleRows(panel).some((row) => row.id === intent.sessionId)) return
        if (intent.sessionId === panel.request.subject.currentSessionId) {
          this.notify('The current session is already active.', 'info')
          return
        }
        panel.selected = intent.sessionId
        panel.zone = 'list'
        const revisionBeforeIntent = panel.revision
        panel.request.onResumeIntent({
          sessionId: intent.sessionId,
          currentSessionId: panel.request.subject.currentSessionId,
          source: intent.source,
        })
        if (this.current() === panel && panel.revision === revisionBeforeIntent) this.change(panel)
        return
      }
      case 'details':
        if (rowFor(panel, panel.selected) === undefined) return
        panel.page = 'details'
        panel.readerEpoch++
        panel.zone = 'list'
        this.change(panel)
        return
      case 'query':
        this.updateQuery(panel, intent.query, intent.cursor)
        return
      case 'zone':
        panel.zone = intent.zone
        this.change(panel)
        return
      case 'action-focus':
        panel.actionFocus = stepActionFocus(panel, intent.delta)
        this.change(panel)
        return
       case 'activate-action': {
         if (panel.actionFocus === 'use-directory') {
          this.act(panel, panel.revision, { kind: 'use-directory', workspaceId: panel.selectedItem!.slice('workspace:'.length) })
          return
        }
        if (panel.actionFocus === 'new-session') {
           if (panel.selectedItem?.startsWith('workspace:')) this.act(panel, panel.revision, { kind: 'new-session' })
           return
         }
         if (panel.actionFocus === 'add-directory') {
           this.act(panel, panel.revision, { kind: 'add-directory' })
           return
         }
         const next = this.visibleActionIntent(panel, panel.actionFocus)
         if (next !== undefined) this.act(panel, panel.revision, next)
         return
       }
      default:
        return
    }
  }

  private directoryKeyIntent(panel: SessionBrowserPanel, key: Key): BrowserIntent | undefined {
    if (!panel.directoryEntry || panel.directorySubmitting) return undefined
    if (key.name === 'escape') return { kind: 'directory-cancel' }
    if (key.name === 'enter' || key.name === 'return') return { kind: 'directory-submit' }
    if (key.name === 'backspace') {
      const next = panel.directoryPath.slice(0, Math.max(0, panel.directoryCursor - 1)) + panel.directoryPath.slice(panel.directoryCursor)
      return { kind: 'directory-edit', text: next, cursor: Math.max(0, panel.directoryCursor - 1) }
    }
    if (key.name === 'left') return { kind: 'directory-edit', text: panel.directoryPath, cursor: Math.max(0, panel.directoryCursor - 1) }
    if (key.name === 'right') return { kind: 'directory-edit', text: panel.directoryPath, cursor: Math.min(panel.directoryPath.length, panel.directoryCursor + 1) }
    if (key.text !== undefined && !key.ctrl && !key.alt && !key.meta) {
      const text = panel.directoryPath.slice(0, panel.directoryCursor) + key.text + panel.directoryPath.slice(panel.directoryCursor)
      return { kind: 'directory-edit', text, cursor: panel.directoryCursor + key.text.length }
    }
    return undefined
  }
  private keyIntent(panel: SessionBrowserPanel, key: Key): BrowserIntent | undefined {
    if (panel.directoryEntry) {
      // The Host path submode owns its keys: Cancel always leaves the submode
      // (never the whole Browser), Tab moves between its editor and its
      // Use directory/Cancel actions, and verification fences every key.
      if (panel.directorySubmitting) return undefined
      if (key.name === 'escape') return { kind: 'directory-cancel' }
      if (key.name === 'tab') return { kind: 'zone', zone: panel.zone === 'actions' ? 'list' : 'actions' }
      if (panel.zone === 'actions') {
        if (key.name === 'left' || key.name === 'right' || key.name === 'up' || key.name === 'down') {
          return { kind: 'action-focus', delta: key.name === 'left' || key.name === 'up' ? -1 : 1 }
        }
        if (key.name === 'enter' || key.name === 'return') return { kind: 'activate-action' }
        return undefined
      }
      return this.directoryKeyIntent(panel, key)
    }
    if (key.ctrl === true && key.name === 'c') return undefined
    if (panel.page === 'details') {
      if (key.name === 'escape' || key.name === 'enter') return { kind: 'back' }
      const scroll: ScrollTo | undefined = key.name === 'up' ? 'line-up'
        : key.name === 'down' ? 'line-down'
          : key.name === 'page_up' ? 'page-up'
            : key.name === 'page_down' ? 'page-down'
              : key.name === 'home' ? 'start'
                : key.name === 'end' ? 'end'
                  : undefined
      return scroll === undefined ? undefined : { kind: 'reader-scroll', step: scroll }
    }
    if (key.name === 'escape') {
      if (panel.query !== '') return { kind: 'query', query: '', cursor: 0 }
      return { kind: 'close' }
    }
    if (key.name === 'tab') {
      const searching = queryMode(panel)
      const ring: readonly BrowserZone[] = ['list', 'actions']
      const at = Math.max(ring.indexOf(panel.zone), 0)
      return { kind: 'zone', zone: ring[(at + (key.shift === true ? -1 : 1) + ring.length) % ring.length]! }
    }
    if (panel.zone === 'actions') {
      if (key.name === 'left' || key.name === 'right' || key.name === 'up' || key.name === 'down') {
        return { kind: 'action-focus', delta: key.name === 'left' || key.name === 'up' ? -1 : 1 }
      }
      if (key.name === 'enter') return { kind: 'activate-action' }
      const edited = editQuery(panel, key)
      return edited === undefined ? undefined : { kind: 'query', ...edited }
    }
    const selectedId = panel.selectedItem ?? (panel.selected === undefined ? undefined : `session:${panel.selected}`)
    if (selectedId?.startsWith('workspace:') && (key.name === 'left' || key.name === 'right')) {
      const workspaceId = selectedId.slice('workspace:'.length)
      const group = workspaceGroups(panel).find(candidate => candidate.workspaceId === workspaceId)
      const expanded = panel.expandedWorkspaces.get(workspaceId)
        ?? (workspaceId === priorityWorkspaceId(panel) || (group?.needs ?? 0) > 0 || (group?.working ?? 0) > 0)
      if (key.name === 'right' && !expanded) return { kind: 'browse-workspace', workspaceId, toggle: true }
      if (key.name === 'left' && expanded) return { kind: 'browse-workspace', workspaceId, toggle: true }
    }
    if (key.name === 'enter') {
      if (selectedId?.startsWith('workspace:')) return { kind: 'browse-workspace', workspaceId: selectedId.slice('workspace:'.length), toggle: true }
      if (selectedId?.startsWith('more:')) return { kind: 'browse-more', workspaceId: selectedId.slice('more:'.length), reveal: true }
      return panel.selected === undefined ? undefined : { kind: 'resume', sessionId: panel.selected, source: 'enter' }
    }
    const items = pickerLayerItems(panel)
    const index = Math.max(0, items.findIndex(item => item.id === selectedId))
    const targetIndex = key.name === 'home' ? 0
      : key.name === 'end' ? items.length - 1
        : key.name === 'up' ? Math.max(0, index - 1)
          : key.name === 'down' ? Math.min(items.length - 1, index + 1)
            : key.name === 'page_up' ? Math.max(0, index - 5)
              : key.name === 'page_down' ? Math.min(items.length - 1, index + 5)
                : undefined
    const target = targetIndex === undefined ? undefined : items[targetIndex]
    if (target !== undefined && target.id !== selectedId) {
      if (target.id.startsWith('workspace:')) return { kind: 'browse-workspace', workspaceId: target.id.slice('workspace:'.length), toggle: false }
      if (target.id.startsWith('more:')) return { kind: 'browse-more', workspaceId: target.id.slice('more:'.length), reveal: false }
      if (target.id.startsWith('session:')) return { kind: 'browse-row', sessionId: target.id.slice('session:'.length) }
    }

    const edited = editQuery(panel, key)
    return edited === undefined ? undefined : { kind: 'query', ...edited }
  }

  handleKey(key: Key): boolean {
    const panel = this.current()
    if (panel === undefined) return false
    if (key.ctrl === true && key.name === 'c') return false
    if (!this.canInteract()) return true
    const intent = this.keyIntent(panel, key)
    if (intent !== undefined) this.act(panel, panel.revision, intent)
    return true
  }

  private rowIntent(panel: SessionBrowserPanel, item: string, kind: 'select' | 'activate'): BrowserIntent | undefined {
    if (item.startsWith('workspace:')) return kind === 'select'
      ? { kind: 'browse-workspace', workspaceId: item.slice('workspace:'.length), toggle: false }
      : { kind: 'browse-workspace', workspaceId: item.slice('workspace:'.length), toggle: true }
    if (item.startsWith('more:')) return kind === 'select'
      ? { kind: 'browse-more', workspaceId: item.slice('more:'.length), reveal: false }
      : { kind: 'browse-more', workspaceId: item.slice('more:'.length), reveal: true }
    const id = item.startsWith('session:') ? item.slice('session:'.length) : undefined
    if (id === undefined) return undefined
    return kind === 'select'
      ? { kind: 'browse-row', sessionId: id }
      : { kind: 'resume', sessionId: id, source: 'activate' }
  }

  private eventIntent(panel: SessionBrowserPanel, event: TspEvent, target: EventTarget): BrowserIntent | undefined {
    if (panel.directorySubmitting) return undefined
    if (event.ev === 'edit') {
      if (target.kind !== 'picker' || !panel.directoryEntry) return undefined
      const text = panel.directoryPath.slice(0, event.from) + event.text + panel.directoryPath.slice(event.to)
      return { kind: 'directory-edit', text, cursor: event.cursor }
    }
    if (event.ev === 'toggle') {
      if (target.kind !== 'picker' || event.item === undefined || !event.item.startsWith('workspace:')) return undefined
      return { kind: 'workspace-toggle', workspaceId: event.item }
    }
    if (event.ev === 'select' || event.ev === 'activate') {
      if (target.kind !== 'picker' || event.item === undefined) return undefined
      if (event.item.startsWith('workspace:') || event.item.startsWith('more:')) {
        return this.rowIntent(panel, event.item, event.ev)
      }
      return this.rowIntent(panel, event.item, event.ev)
    }
    if (event.ev !== 'action') return undefined
    if (target.kind === 'back') {
      if (event.act === 'click' && panel.page === 'details' && target.readerEpoch === panel.readerEpoch) return { kind: 'back' }
      return undefined
    }
    if (target.kind !== 'picker' || panel.page !== 'browse') return undefined
    if (event.act === 'close') return panel.directoryEntry ? { kind: 'directory-cancel' } : { kind: 'close' }
    const match = /^(details|resume|use-directory|new-session|add-directory|confirm-directory)#(\d+)$/u.exec(event.act)
    if (match === null || Number(match[2]) !== panel.revision) return undefined
    return this.visibleActionIntent(panel, match[1]!)
  }

  handleEvent(event: TspEvent): boolean {
    if (event.ev !== 'select' && event.ev !== 'activate' && event.ev !== 'toggle' && event.ev !== 'edit' && event.ev !== 'action') return false
    if (!('sf' in event) || event.sf !== this.surfaceId || !('id' in event) || typeof event.id !== 'string') return false
    const target = this.targets.get(event.id)
    if (target === undefined) return false
    const panel = this.current()
    if (panel === undefined || target.panel !== panel || target.revision !== panel.revision || target.page !== panel.page) return false
    if (!this.canInteract()) return false
    const intent = this.eventIntent(panel, event, target)
    if (intent !== undefined) this.act(panel, target.revision, intent)
    return true
  }

  renderLayer(): Node | undefined {
    this.targets.clear()
    this.readerBodyId = undefined
    const panel = this.current()
    if (panel === undefined) return undefined
    if (this.suspended) {
      this.suspended = false
      panel.revision++
    }
    const revision = panel.revision
    const node = layer(panel, (intent) => () => this.act(panel, revision, intent), this.nativeKv)
    const pickerKey = `session-browser-picker-${panel.serial}`
    const backKey = `session-browser-back-${panel.serial}-${panel.readerEpoch}`
    for (const root of View.from({ layer: node }).regions) {
      const visit = (candidate: typeof root): void => {
        if (candidate === undefined) return
        const key = candidate.props['key']
        const kind: TargetKind = key === pickerKey ? 'picker' : key === backKey ? 'back' : 'other'
        this.targets.set(candidate.id, { panel, revision, page: panel.page, readerEpoch: panel.readerEpoch, kind })
        if (typeof key === 'string' && key.startsWith(DETAILS_BODY_KEY_PREFIX)) this.readerBodyId = candidate.id
        for (const child of candidate.children) visit(child)
      }
      visit(root)
    }
    return node
  }
}
