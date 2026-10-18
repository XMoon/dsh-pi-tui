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
import { buildSessionTree, sameWorkspace, sanitizeSessionSearchInput } from '../../domain/session/browser.ts'
import { formatSessionAge, sanitizeTerminalText, shortSessionId, workspaceKey } from '../pickers/sessions.ts'

const DETAILS_BODY_KEY_PREFIX = 'session-browser-details-body-'
const BROWSE_ACTIONS = ['close', 'details', 'resume'] as const

type BrowseAction = typeof BROWSE_ACTIONS[number]
type BrowseScope = 'workspace' | 'all'
type BrowserPage = 'browse' | 'details'
type BrowserZone = 'list' | 'scopes' | 'actions'
type BrowserIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'scope'; readonly scope: BrowseScope }
  | { readonly kind: 'browse-row'; readonly sessionId: string }
  | { readonly kind: 'resume'; readonly sessionId: string; readonly source: 'enter' | 'activate' | 'footer' }
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
  revision: number
  disposed: boolean
  page: BrowserPage
  zone: BrowserZone
  scope: BrowseScope
  selected: string | undefined
  actionFocus: BrowseAction
  query: string
  cursor: number
  queryEdited: boolean
  initialQueryApplied: boolean
  readerEpoch: number
  snapshot: SessionBrowserReadSnapshot
  previousBrowse: { readonly scope: BrowseScope; readonly selected: string | undefined } | undefined
}

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

function browseRows(panel: SessionBrowserPanel): readonly { readonly row: SessionBrowserRow; readonly depth: number }[] {
  const scoped = panel.scope === 'all'
    ? panel.snapshot.rows
    : panel.snapshot.rows.filter((row) => sameWorkspace(row.cwd, panel.request.subject.currentCwd))
  return buildSessionTree(scoped)
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

function actionDisabledReason(panel: SessionBrowserPanel, base: BrowseAction): string | undefined {
  if (base === 'details' && rowFor(panel, panel.selected) === undefined) return 'Select a session to read its details.'
  if (base === 'resume') {
    if (panel.snapshot.resumePending) return 'Switching sessions…'
    const row = rowFor(panel, panel.selected)
    if (row === undefined) return panel.snapshot.listState === 'loading' ? 'Sessions are still loading.' : 'Select a session to resume.'
    if (row.id === panel.request.subject.currentSessionId) return 'The current session is already active.'
  }
  return undefined
}

function enabledActions(panel: SessionBrowserPanel): BrowseAction[] {
  return BROWSE_ACTIONS.filter((base) => actionDisabledReason(panel, base) === undefined)
}

function focusedAction(panel: SessionBrowserPanel): BrowseAction {
  const enabled = enabledActions(panel)
  return enabled.includes(panel.actionFocus) ? panel.actionFocus : enabled[0]!
}

function stepActionFocus(panel: SessionBrowserPanel, delta: -1 | 1): BrowseAction {
  const enabled = enabledActions(panel)
  const at = enabled.indexOf(focusedAction(panel))
  return enabled[(at + delta + enabled.length) % enabled.length]!
}

function normalize(panel: SessionBrowserPanel): void {
  if (queryMode(panel)) panel.scope = 'all'
  if (panel.zone === 'scopes' && queryMode(panel)) panel.zone = 'list'
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
  if (panel.selected === undefined || rowFor(panel, panel.selected) === undefined) {
    panel.selected = firstBrowseId(panel)
  }
  if (panel.zone === 'actions') panel.actionFocus = focusedAction(panel)
}

function actionId(panel: SessionBrowserPanel, action: BrowseAction): string {
  return `${action}#${panel.revision}`
}

function actionLabel(action: BrowseAction): string {
  return action === 'close' ? 'Close' : action === 'details' ? 'Details' : 'Resume'
}

function actionList(panel: SessionBrowserPanel): PickerAction[] {
  const focus = panel.zone === 'actions' ? focusedAction(panel) : undefined
  return BROWSE_ACTIONS.map((base) => {
    const disabled = actionDisabledReason(panel, base)
    const focused = base === focus
    return {
      id: base === 'close' ? base : actionId(panel, base),
      label: `${actionLabel(base)}${focused ? ' [Enter]' : ''}`,
      ...(base === 'resume' ? { primary: true } : {}),
      ...(disabled === undefined ? {} : { disabled }),
    }
  })
}

function rowItem(
  row: SessionBrowserRow,
  depth: number | undefined,
  result?: SessionBrowserSearchResult,
): PickerItem {
  const title = row.title === undefined || row.title.trim() === '' ? shortSessionId(row.id) : row.title
  const detail = [
    workspaceKey(row.cwd),
    `Updated ${formatSessionAge(row.updatedAt)}`,
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
    detail: result?.snippet === undefined
      ? detail
      : `${workspaceKey(row.cwd)} · Updated ${formatSessionAge(row.updatedAt)} · ${sanitizeTerminalText(result.snippet)}`,
    title: sanitizeTerminalText(row.id),
    ...(depth === undefined ? {} : { depth }),
    ...(badges.length === 0 ? {} : { badges }),
  }
}

function statusText(panel: SessionBrowserPanel): string | undefined {
  const snapshot = panel.snapshot
  if (snapshot.listState === 'loading') return 'Loading persisted sessions…'
  if (snapshot.listState === 'unavailable') return 'Session listing is unavailable.'
  if (snapshot.listState === 'error') return `Session listing failed: ${sanitizeTerminalText(snapshot.listError ?? 'unknown error')}`
  const projectionMessage = snapshot.projectionError === undefined
    ? undefined
    : `Some session details are unavailable: ${sanitizeTerminalText(snapshot.projectionError)}`
  if (!queryMode(panel)) return projectionMessage
  const searchMessage = snapshot.searchState === 'loading' ? 'Searching session content…'
    : snapshot.searchState === 'unavailable' ? 'Content search is unavailable; metadata matches remain visible.'
      : snapshot.searchState === 'error'
        ? `Content search failed: ${sanitizeTerminalText(snapshot.searchError ?? 'unknown error')}; metadata matches remain visible.`
        : snapshot.hasMore ? 'More matches are available; refine the query.' : undefined
  if (searchMessage === undefined) return projectionMessage
  return projectionMessage === undefined ? searchMessage : `${searchMessage} ${projectionMessage}`
}

function emptyText(panel: SessionBrowserPanel): string {
  const snapshot = panel.snapshot
  if (snapshot.listState === 'loading') return 'Loading persisted sessions…'
  if (snapshot.listState === 'unavailable') return 'No session listing capability is available.'
  if (snapshot.listState === 'error') return 'The session list could not be loaded.'
  if (!queryMode(panel)) return snapshot.listState === 'empty' ? 'No persisted sessions are available.' : 'No sessions are available in this scope.'
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
    : `${panel.scope === 'workspace' ? 'This workspace' : 'All workspaces'} · ${current}`
}

function pickerLayer(panel: SessionBrowserPanel): Node {
  const searching = queryMode(panel)
  const tree = searching ? [] : browseRows(panel)
  const searchResults = searching ? visibleSearchResults(panel) : []
  const rows = searching ? searchResults.map((result) => rowItem(result.row, undefined, result))
    : tree.map(({ row, depth }) => rowItem(row, depth))
  const selected = panel.selected === undefined ? undefined : `session:${panel.selected}`
  const currentId = panel.request.subject.currentSessionId
  const currentItem = currentId === undefined ? undefined : `session:${currentId}`
  const current = currentItem !== undefined && rows.some((item) => item.id === currentItem) ? [currentItem] : []
  const workspaceRows = panel.snapshot.rows.filter((row) => sameWorkspace(row.cwd, panel.request.subject.currentCwd))
  const scopes = searching ? [] : [
    { id: 'workspace', label: 'This workspace', count: workspaceRows.length },
    { id: 'all', label: 'All workspaces', count: panel.snapshot.rows.length },
  ] satisfies NonNullable<PickerProps['scopes']>
  const order: Array<string | PickerGroup> = []
  if (searching) {
    order.push(...rows.map((item) => item.id))
  } else {
    let start = 0
    let run = 0
    while (start < tree.length) {
      const first = tree[start]!
      let end = start + 1
      while (end < tree.length && sameWorkspace(first.row.cwd, tree[end]!.row.cwd)) end += 1
      order.push({
        group: `workspace-run:${run}`,
        label: workspaceKey(first.row.cwd),
        count: end - start,
      })
      for (let index = start; index < end; index += 1) {
        order.push(`session:${tree[index]!.row.id}`)
      }
      start = end
      run += 1
    }
  }
  const pickerKey = `session-browser-picker-${panel.serial}`
  const actions = actionList(panel)
  const props: PickerProps & { readonly key: string } = {
    key: pickerKey,
    title: 'Sessions',
    subtitle: pickerSubtitle(panel),
    layout: searching ? 'cards' : 'tree',
    size: 'lg',
    preview: 'none',
    query: panel.query,
    cursor: panel.cursor,
    placeholder: 'Search sessions and messages…',
    noun: 'sessions',
    focus: panel.zone === 'scopes' ? 'scopes' : panel.zone === 'list' ? 'list' : undefined,
    state: panel.snapshot.listState === 'error' || panel.snapshot.listState === 'unavailable'
      ? 'error'
      : panel.snapshot.listState === 'loading' || (searching && panel.snapshot.searchState === 'loading')
        ? 'loading'
        : searching && (panel.snapshot.searchState === 'error' || panel.snapshot.searchState === 'unavailable')
          ? 'error'
          : 'ready',
    ...(statusText(panel) === undefined ? {} : { message: statusText(panel) }),
    empty: emptyText(panel),
    total: rows.length,
    items: rows,
    order,
    ...(selected === undefined || !rows.some((item) => item.id === selected) ? {} : { selected }),
    current,
    scopes,
    ...(searching ? {} : { scope: panel.scope }),
    actions,
  }
  return ui.col({ key: `session-browser-layer-${panel.serial}` }, ui.picker(props))
}

function detailResult(panel: SessionBrowserPanel, row: SessionBrowserRow): SessionBrowserSearchResult | undefined {
  return panel.snapshot.searchResults.find((result) => result.row.id === row.id)
}

function detailReader(panel: SessionBrowserPanel, bind: (intent: BrowserIntent) => () => void): Node {
  const row = rowFor(panel, panel.selected)
  const scope = `${panel.serial}-${panel.readerEpoch}`
  const bodyKey = `${DETAILS_BODY_KEY_PREFIX}${scope}`
  const title = row?.title === undefined || row.title.trim() === '' ? row === undefined ? 'Session details' : shortSessionId(row.id) : row.title
  const result = row === undefined ? undefined : detailResult(panel, row)
  const groups = row === undefined ? [] : [
    {
      id: 'identity',
      head: 'Identity',
      facts: [
        ['Session ID', row.id],
        ['Title', title],
        ['State', row.id === panel.request.subject.currentSessionId ? 'Current session' : row.live ? 'Live session' : 'Persisted session'],
        ['Workspace', row.cwd === undefined ? 'Unknown workspace' : row.cwd],
      ],
    },
    {
      id: 'activity',
      head: 'Activity',
      facts: [
        ['Created', row.createdAt === undefined ? 'Unknown' : new Date(row.createdAt).toISOString()],
        ['Updated', new Date(row.updatedAt).toISOString()],
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
      id: 'excerpt',
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
              ...group.facts.flatMap(([label, value]) => [
                ui.text(span(label, 'muted')),
                ui.text({ wrap: 'word' }, sanitizeTerminalText(value)),
              ]),
            )))
      ),
    ),
  )
}

function layer(panel: SessionBrowserPanel, bind: (intent: BrowserIntent) => () => void): Node {
  return panel.page === 'details' ? detailReader(panel, bind) : pickerLayer(panel)
}

export class TspSessionBrowser {
  private readonly surfaceId: string
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: SessionBrowserPresentation['notify']
  private readonly nativeScroll: (id: string, to: ScrollTo) => void
  private readonly scrollSupported: boolean
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
  }) {
    this.surfaceId = deps.surfaceId
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
    this.nativeScroll = deps.nativeScroll
    this.scrollSupported = deps.scrollSupported
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
      revision: 0,
      disposed: false,
      page: 'browse',
      zone: 'list',
      scope: 'workspace',
      selected: undefined,
      actionFocus: 'details',
      query: '',
      cursor: 0,
      queryEdited: false,
      initialQueryApplied: false,
      readerEpoch: 0,
      snapshot: EMPTY_SNAPSHOT,
      previousBrowse: undefined,
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
      panel.previousBrowse = { scope: panel.scope, selected: panel.selected }
      panel.scope = 'all'
    } else if (wasSearching && !willSearch) {
      const previous = panel.previousBrowse
      panel.scope = previous?.scope ?? 'workspace'
      panel.selected = previous?.selected
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

  private changeScope(panel: SessionBrowserPanel, scope: BrowseScope): void {
    if (queryMode(panel) || panel.scope === scope) return
    panel.scope = scope
    if (rowFor(panel, panel.selected) === undefined) panel.selected = firstBrowseId(panel)
    panel.zone = 'list'
    this.change(panel)
  }

  private visibleActionIntent(panel: SessionBrowserPanel, base: string): BrowserIntent | undefined {
    if (panel.page !== 'browse') return undefined
    if (base === 'close') return { kind: 'close' }
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
      case 'scope':
        this.changeScope(panel, intent.scope)
        return
      case 'browse-row':
        if (!visibleRows(panel).some((row) => row.id === intent.sessionId)) return
        panel.selected = intent.sessionId
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
        const next = this.visibleActionIntent(panel, panel.actionFocus)
        if (next !== undefined) this.act(panel, panel.revision, next)
        return
      }
      default:
        return
    }
  }

  private keyIntent(panel: SessionBrowserPanel, key: Key): BrowserIntent | undefined {
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
      const ring: readonly BrowserZone[] = searching ? ['list', 'actions'] : ['list', 'scopes', 'actions']
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
    if (panel.zone === 'scopes' && !queryMode(panel)) {
      if (key.name === 'enter' || key.name === 'up' || key.name === 'down') {
        return { kind: 'scope', scope: panel.scope === 'workspace' ? 'all' : 'workspace' }
      }
      const edited = editQuery(panel, key)
      return edited === undefined ? undefined : { kind: 'query', ...edited }
    }
    if (key.name === 'enter') {
      return panel.selected === undefined ? undefined : { kind: 'resume', sessionId: panel.selected, source: 'enter' }
    }
    const rows = visibleRows(panel)
    const index = rows.findIndex((row) => row.id === panel.selected)
    const targetIndex = key.name === 'home' ? 0
      : key.name === 'end' ? rows.length - 1
        : key.name === 'up' ? Math.max(0, index - 1)
          : key.name === 'down' ? Math.min(rows.length - 1, Math.max(0, index) + 1)
            : key.name === 'page_up' ? Math.max(0, index - 5)
              : key.name === 'page_down' ? Math.min(rows.length - 1, Math.max(0, index) + 5)
                : undefined
    const target = targetIndex === undefined ? undefined : rows[targetIndex]
    if (target !== undefined && target.id !== panel.selected) return { kind: 'browse-row', sessionId: target.id }
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
    const id = item.startsWith('session:') ? item.slice('session:'.length) : undefined
    if (id === undefined || !visibleRows(panel).some((row) => row.id === id)) return undefined
    return kind === 'select'
      ? { kind: 'browse-row', sessionId: id }
      : { kind: 'resume', sessionId: id, source: 'activate' }
  }

  private eventIntent(panel: SessionBrowserPanel, event: TspEvent, target: EventTarget): BrowserIntent | undefined {
    if (event.ev === 'select' || event.ev === 'activate') {
      if (target.kind !== 'picker' || event.item === undefined) return undefined
      return this.rowIntent(panel, event.item, event.ev)
    }
    if (event.ev !== 'action') return undefined
    if (target.kind === 'back') {
      if (event.act === 'click' && panel.page === 'details' && target.readerEpoch === panel.readerEpoch) return { kind: 'back' }
      return undefined
    }
    if (target.kind !== 'picker' || panel.page !== 'browse') return undefined
    if (event.act === 'scope') {
      if (queryMode(panel) || (event.value !== 'workspace' && event.value !== 'all')) return undefined
      return { kind: 'scope', scope: event.value }
    }
    if (event.act === 'close') return { kind: 'close' }
    const match = /^(details|resume)#(\d+)$/u.exec(event.act)
    if (match === null || Number(match[2]) !== panel.revision) return undefined
    return this.visibleActionIntent(panel, match[1]!)
  }

  handleEvent(event: TspEvent): boolean {
    if (event.ev !== 'select' && event.ev !== 'activate' && event.ev !== 'action') return false
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
    const node = layer(panel, (intent) => () => this.act(panel, revision, intent))
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
