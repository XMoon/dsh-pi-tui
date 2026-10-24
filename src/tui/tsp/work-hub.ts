/**
 * The internal native TSP Work Hub (PR4 B3-A1).
 *
 * ONE native `ui.picker` in the base inline surface's `layer`, with an
 * optional side Inspector on wide panes. It is a LOCAL presenter: every row
 * comes from the ONE `TaskRuntime` projection through the
 * `TaskCenterPresentationPort`, and this class owns only the discardable
 * panel state (selection, query, refresh state, targets).
 *
 * A1 deliberately exposes ONE native action (`Close`): `View details` belongs
 * to A2's real Reader, so no placeholder button exists here. Production
 * `/tasks` stays unreachable — the TSP display seam advertises
 * `supportsTaskCenter: false`; this presenter is only reachable through the
 * internal presentation harness until A3 opens the real command path.
 *
 * Not owned here: catalog reads, Job observation/Stop, subagent viewer,
 * Question answering, a second Session or a second surface. The native
 * picker/Inspector only route SELECT/ACTIVATE/ACTION into local panel state.
 *
 * @module @xmoon76/dsh-pi-tui/tui/tsp/work-hub
 */

import { View, span, ui, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import type { PickerAction, PickerGroup, PickerItem, PickerProps } from '@stencil-hq/tern'
import type { TaskPanelItem } from '../../app/surface/task-presentation.ts'
import type {
  TaskBrowserPresentationHandle,
  TaskBrowserPresentationOpen,
  TaskCenterPresentationPort,
} from '../../app/surface/task-presentation-port.ts'
import { sanitizeTerminalText } from '../pickers/sessions.ts'

/** The side-Inspector request threshold (pane pixels). */
const WIDE_PANE_PIXELS = 1120
/**
 * The internal pane floor. Below ~40 terminal columns the native cards/action
 * bar cannot keep an actionable surface reachable, so A1 renders an explicit
 * unavailable line instead of a clipped picker. (The FINAL product gate is
 * A3's; this only keeps the internal presenter honest.)
 */
const MIN_PANE_PIXELS = 320
/** The native footer action id: the ONE executable action of A1. */
const CLOSE_ACTION_ID = 'close'

type WorkHubZone = 'list' | 'actions'
type WorkHubRefresh = 'loading' | 'ready' | 'stale'

/** A failed/timed-out/lost work status (attention marker, not a tone-only fact). */
const FAILURE_STATUSES = new Set(['failed', 'timed_out', 'lost'])

interface WorkHubPanel {
  readonly serial: number
  revision: number
  retired: boolean
  items: readonly TaskPanelItem[]
  selected: string | undefined
  query: string
  cursor: number
  zone: WorkHubZone
  refresh: WorkHubRefresh
  refreshError: string | undefined
  actionFocus: 'close'
  readonly onSelect: (value: string) => 'close' | 'keep-open'
  readonly onClose: () => void
  readonly options: TaskBrowserPresentationOpen
}

interface WorkHubTarget {
  readonly panel: WorkHubPanel
  readonly revision: number
  readonly kind: 'picker' | 'other'
}

interface WorkHubGroups {
  readonly attention: readonly TaskPanelItem[]
  readonly subagents: readonly TaskPanelItem[]
  readonly jobs: readonly TaskPanelItem[]
}

type WorkHubIntent =
  | { readonly kind: 'consume' }
  | { readonly kind: 'close' }
  | { readonly kind: 'zone'; readonly zone: WorkHubZone }
  | { readonly kind: 'select'; readonly value: string }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
  | { readonly kind: 'activate-action' }

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** The UTF-16 boundaries of the query's grapheme clusters. */
function graphemeBounds(text: string): number[] {
  return [...graphemeSegmenter.segment(text)].map(segment => segment.index).concat(text.length)
}

/**
 * The picker's local query editor (the same UTF-16/grapheme semantics as the
 * Session Browser's input). It only edits the panel's filter text; it never
 * sends a Host query or re-lists a catalog.
 */
function editQuery(
  panel: { readonly query: string; readonly cursor: number },
  key: Key,
): { readonly query: string; readonly cursor: number } | undefined {
  if (key.ctrl === true || key.alt === true || key.meta === true) return undefined
  const bounds = graphemeBounds(panel.query)
  if (key.name === 'backspace') {
    const start = bounds.filter(index => index < panel.cursor).at(-1) ?? 0
    return { query: panel.query.slice(0, start) + panel.query.slice(panel.cursor), cursor: start }
  }
  if (key.name === 'delete') {
    const end = bounds.find(index => index > panel.cursor) ?? panel.query.length
    return { query: panel.query.slice(0, panel.cursor) + panel.query.slice(end), cursor: panel.cursor }
  }
  if (key.name === 'left') {
    return { query: panel.query, cursor: bounds.filter(index => index < panel.cursor).at(-1) ?? 0 }
  }
  if (key.name === 'right') {
    return { query: panel.query, cursor: bounds.find(index => index > panel.cursor) ?? panel.query.length }
  }
  if (key.name === 'home') return { query: panel.query, cursor: 0 }
  if (key.name === 'end') return { query: panel.query, cursor: panel.query.length }
  if (key.text === undefined) return undefined
  const prefix = panel.query.slice(0, panel.cursor) + key.text
  const rawCursor = panel.cursor + key.text.length
  return {
    query: prefix + panel.query.slice(panel.cursor),
    cursor: graphemeBounds(prefix).find(index => index >= rawCursor) ?? prefix.length,
  }
}

/** A work row = a Subagent/external or Job row (a Question is NOT work). */
function isWorkRow(item: TaskPanelItem): boolean {
  return item.source === 'subagent' || item.source === 'job'
}

function isFailureStatus(status: string): boolean {
  return FAILURE_STATUSES.has(status)
}

/**
 * The panel-local row projection: the input order is preserved (the runtime
 * already committed the stable pre-order), a query filters only the local
 * rows, and the group derivation never re-sorts or duplicates a row.
 */
function visibleRows(panel: WorkHubPanel): readonly TaskPanelItem[] {
  const query = panel.query.trim().toLocaleLowerCase()
  if (query === '') return panel.items
  return panel.items.filter(item => [
    item.label,
    item.status,
    item.detail,
    item.suffix,
    item.mode,
    item.access,
    item.parentLabel,
    item.value,
  ].some(text => text !== undefined && text.toLocaleLowerCase().includes(query)))
}

/** The three fixed groups, in screen order; each keeps the input order. */
function groupsOf(rows: readonly TaskPanelItem[]): WorkHubGroups {
  const attention: TaskPanelItem[] = []
  const subagents: TaskPanelItem[] = []
  const jobs: TaskPanelItem[] = []
  for (const row of rows) {
    if (row.source === 'question') attention.push(row)
    else if (row.source === 'job') jobs.push(row)
    else subagents.push(row)
  }
  return { attention, subagents, jobs }
}

/**
 * The Owner-accepted attention-first initial selection. It is the TSP
 * presenter's own local choice; the runtime's `preferredValue` (active work
 * first) stays the PiTui cursor preference.
 */
function chooseInitial(rows: readonly TaskPanelItem[]): string | undefined {
  const question = rows.find(item => item.source === 'question')
  if (question !== undefined) return question.value
  const attention = rows.find(item => isWorkRow(item) && item.attention === true)
  if (attention !== undefined) return attention.value
  const failed = rows.find(item => isWorkRow(item) && isFailureStatus(item.status))
  if (failed !== undefined) return failed.value
  return rows.find(item => isWorkRow(item))?.value
}

/**
 * Keep the user's selection when it survives; otherwise take the next
 * surviving row after its old position and, only then, the previous one.
 * Never falls back to an index as an action target.
 */
function normalizeSelection(
  selected: string | undefined,
  oldVisible: readonly TaskPanelItem[],
  newVisible: readonly TaskPanelItem[],
): string | undefined {
  if (selected === undefined) return chooseInitial(newVisible)
  if (newVisible.some(item => item.value === selected)) return selected
  const at = oldVisible.findIndex(item => item.value === selected)
  if (at < 0) return chooseInitial(newVisible)
  for (let index = at + 1; index < oldVisible.length; index += 1) {
    const candidate = oldVisible[index]!
    if (newVisible.some(item => item.value === candidate.value)) return candidate.value
  }
  for (let index = at - 1; index >= 0; index -= 1) {
    const candidate = oldVisible[index]!
    if (newVisible.some(item => item.value === candidate.value)) return candidate.value
  }
  return undefined
}

function toneOf(item: TaskPanelItem): 'warning' | 'error' | 'accent' | 'muted' {
  if (item.source === 'question') return 'warning'
  if (isFailureStatus(item.status)) return 'error'
  if (item.active === true || item.status === 'running' || item.status === 'stopping') return 'accent'
  return 'muted'
}

/** The second line: real status + the durable kind/mode facts (never invented). */
function detailText(item: TaskPanelItem): string {
  if (item.source === 'question') return `Question · ${item.status}`
  if (item.mode === 'external') return 'External'
  if (item.source === 'job') {
    return [item.status, item.type ?? 'job', item.detail].filter((part): part is string => part !== undefined).join(' · ')
  }
  return [item.status, item.mode ?? item.suffix].filter((part): part is string => part !== undefined).join(' · ')
}

function pickerItem(item: TaskPanelItem): PickerItem {
  // The connector/prefix is a projected layout fact; the row ID stays the raw
  // stable value (never regenerated from display text).
  const label = `${item.treePrefix ?? ''}${item.label}`
  return {
    id: item.value,
    label: sanitizeTerminalText(label),
    detail: sanitizeTerminalText(detailText(item)),
    dot: toneOf(item),
    title: sanitizeTerminalText(`${item.label}\n${detailText(item)}\n${item.value}`),
  }
}

/** The Inspector's read-only fact rows, from the SAME `TaskPanelItem`. */
function inspectorFacts(item: TaskPanelItem): Array<readonly [string, string]> {
  const type = item.source === 'question'
    ? 'Question'
    : item.mode === 'external'
      ? 'External'
      : item.type ?? item.source ?? 'Work'
  const facts: Array<readonly [string, string]> = [['Type', type]]
  // A value already stated by the Type line is not repeated under a second
  // label (an external row's projected status word IS its classification).
  if (item.status !== '' && item.status !== type) facts.push(['Status', item.status])
  if (item.mode !== undefined && item.mode !== 'external') facts.push(['Mode', item.mode])
  if (item.access !== undefined) facts.push(['Access', item.access])
  const parent = item.parentLabel ?? item.parentId
  if (parent !== undefined && parent !== '') facts.push(['Parent', parent])
  if (item.depth !== undefined) facts.push(['Depth', String(item.depth)])
  facts.push(['Stable ID', item.value])
  return facts
}

/** The Inspector: selected work facts only, no actions, no invented values. */
function workHubInspector(row: TaskPanelItem | undefined): Node {
  if (row === undefined) {
    return ui.col({ key: 'work-hub-inspector' }, ui.text(span('Select a work item.', 'muted')))
  }
  return ui.col(
    { key: 'work-hub-inspector', gap: 'xs' },
    ui.text({ key: 'work-hub-inspector-title' }, span('Selected work', 'muted')),
    ui.text({ key: 'work-hub-inspector-label', wrap: 'word' }, span(sanitizeTerminalText(row.label), 'accent')),
    ...inspectorFacts(row).map(([label, value], index) => ui.text(
      { key: `work-hub-inspector-fact-${index}`, wrap: 'word' },
      [span(`${label.padEnd(10)}`, 'muted'), sanitizeTerminalText(value)],
    )),
  )
}

function subtitleText(groups: WorkHubGroups): string | undefined {
  const work = [...groups.subagents, ...groups.jobs]
  const running = work.filter(item => item.active === true || item.status === 'running' || item.status === 'stopping').length
  const failed = work.filter(item => isFailureStatus(item.status)).length
  const parts: string[] = []
  if (groups.attention.length > 0) parts.push(`${groups.attention.length} attention`)
  if (running > 0) parts.push(`${running} running`)
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** The ONE layer node: one native picker plus the optional Inspector child. */
function hubLayer(panel: WorkHubPanel, wide: boolean): Node {
  const rows = visibleRows(panel)
  const groups = groupsOf(rows)
  const selectedRow = panel.selected === undefined
    ? undefined
    : rows.find(row => row.value === panel.selected)
  const order: Array<string | PickerGroup> = []
  if (groups.attention.length > 0) {
    order.push({ group: 'work-attention', label: 'Needs attention', count: groups.attention.length })
    for (const row of groups.attention) order.push(row.value)
  }
  if (groups.subagents.length > 0) {
    order.push({ group: 'work-subagents', label: 'Work · Subagents', count: groups.subagents.length })
    for (const row of groups.subagents) order.push(row.value)
  }
  if (groups.jobs.length > 0) {
    order.push({ group: 'work-jobs', label: 'Work · Jobs', count: groups.jobs.length })
    for (const row of groups.jobs) order.push(row.value)
  }
  const message = panel.refresh === 'stale'
    ? `Could not refresh tasks; showing last known entries.${panel.refreshError === undefined ? '' : ` ${sanitizeTerminalText(panel.refreshError)}`}`
    : undefined
  const subtitle = subtitleText(groups)
  const actions: PickerAction[] = [{
    id: CLOSE_ACTION_ID,
    label: panel.zone === 'actions' && panel.actionFocus === 'close' ? 'Close [Enter]' : 'Close',
    keys: ['escape'],
  }]
  const props: PickerProps & { readonly key: string } = {
    key: `work-hub-picker-${panel.serial}`,
    title: 'Work Hub',
    ...(subtitle === undefined ? {} : { subtitle }),
    layout: 'cards',
    size: 'lg',
    preview: wide ? 'side' : 'none',
    query: panel.query,
    cursor: panel.cursor,
    placeholder: 'Search work…',
    noun: 'work',
    focus: panel.zone === 'list' ? 'list' : undefined,
    state: panel.refresh === 'loading' ? 'loading' : panel.refresh === 'stale' ? 'error' : 'ready',
    ...(message === undefined ? {} : { message }),
    empty: panel.query.trim() === '' ? 'No tasks are available for this session.' : 'No work matches this search.',
    total: rows.length,
    items: rows.map(pickerItem),
    order,
    ...(selectedRow === undefined ? {} : { selected: selectedRow.value }),
    actions,
  }
  // `preview:'none'` still passes the Inspector child: the pinned native
  // Picker owns whether/how it is shown, and the app never paints a second
  // frame or overlay around it.
  return ui.col({ key: `work-hub-layer-${panel.serial}` }, ui.picker(props, workHubInspector(selectedRow)))
}

/** The constructor inputs the session renderer owns. */
export interface TspWorkHubDeps {
  /** The base inline surface the presentation events are addressed to. */
  readonly surfaceId: string
  /** Commit one frame (the session renderer's ONE render entry). */
  render(): void
  /** Whether the hub may take input (mounted, bound, not hydrating, no modal). */
  canInteract(): boolean
  /** The live pane width in client pixels (`caps.cols * caps.cell.w`). */
  paneWidth(): number
}

/**
 * The internal TSP Work Hub presenter. Construction is owned by
 * `tsp/session.ts`; it is never instantiated by the application layer.
 */
export class TspWorkHub {
  private readonly surfaceId: string
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly paneWidth: () => number
  private panel: WorkHubPanel | undefined
  private serial = 0
  private suspended = false
  private targets = new Map<string, WorkHubTarget>()

  constructor(deps: TspWorkHubDeps) {
    this.surfaceId = deps.surfaceId
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.paneWidth = deps.paneWidth
  }

  /**
   * The Task Center presentation sink. Only `openBrowser` reaches a live
   * panel; the passive PiTui chrome sinks keep NO second business roster or
   * Quick projection (A1 renders none of them).
   */
  readonly taskPresentation: TaskCenterPresentationPort = {
    openBrowser: (items, onSelect, onClose, options) => this.open(items, onSelect, onClose, options),
    setQuickTaskItems: () => {},
    setAgents: () => {},
    setTasks: () => {},
    setQuestionAttention: () => {},
    setTaskSummary: () => {},
  }

  private current(): WorkHubPanel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.retired) return undefined
    return panel
  }

  private open(
    items: readonly TaskPanelItem[],
    onSelect: (value: string) => 'close' | 'keep-open',
    onClose: () => void,
    options: TaskBrowserPresentationOpen,
  ): TaskBrowserPresentationHandle {
    // A newer explicit open supersedes the displayed panel; the old owner is
    // notified after its identity is retired so its close tail cannot
    // overwrite this new panel.
    this.retire()
    const panel: WorkHubPanel = {
      serial: ++this.serial,
      revision: 0,
      retired: false,
      items: [...items],
      selected: undefined,
      query: '',
      cursor: 0,
      zone: 'list',
      refresh: options.loading ? 'loading' : 'ready',
      refreshError: undefined,
      actionFocus: 'close',
      onSelect,
      onClose,
      options,
    }
    panel.selected = chooseInitial(visibleRows(panel))
    this.panel = panel
    this.change(panel)
    return {
      close: () => this.closeHandle(panel),
      setItems: (next, _preferredValue) => this.setItems(panel, next),
      setRefreshState: (state, error) => this.setRefreshState(panel, state, error),
    }
  }

  private setItems(panel: WorkHubPanel, items: readonly TaskPanelItem[]): void {
    if (this.current() !== panel) return
    const oldVisible = visibleRows(panel)
    panel.items = [...items]
    // Rows arriving end the loading display, but NEVER clear a stale refresh
    // error: only the coordinator's own `setRefreshState('ready')` proves a
    // successful refresh (a runtime commit is not a catalog success).
    if (panel.refresh === 'loading') panel.refresh = 'ready'
    panel.selected = normalizeSelection(panel.selected, oldVisible, visibleRows(panel))
    this.change(panel)
  }

  private setRefreshState(panel: WorkHubPanel, state: WorkHubRefresh, error?: string): void {
    if (this.current() !== panel) return
    panel.refresh = state
    panel.refreshError = error
    this.change(panel)
  }

  private change(panel: WorkHubPanel): void {
    if (this.panel !== panel || panel.retired) return
    panel.revision += 1
    this.render()
  }

  /**
   * Programmatic retirement (a sibling presenter's open, a Session hydration,
   * renderer disposal): retire the panel identity BEFORE notifying its owner,
   * so a synchronous re-open from that callback owns the slot. No user-close
   * callback is implied.
   */
  retire(): void {
    const panel = this.panel
    if (panel === undefined) return
    if (panel.retired) return
    panel.retired = true
    this.panel = undefined
    this.targets.clear()
    panel.options.onRetired('external')
  }

  /** The returned handle's `close()`: the TuiApp handle's `external` closure. */
  private closeHandle(panel: WorkHubPanel): void {
    if (panel.retired) return
    panel.retired = true
    if (this.panel === panel) {
      this.panel = undefined
      this.targets.clear()
    }
    try {
      panel.options.onRetired('external')
    } finally {
      this.render()
    }
  }

  /** The user's Esc / native Close: retire, notify `onRetired` and `onClose`. */
  private userClose(panel: WorkHubPanel): void {
    if (panel.retired) return
    panel.retired = true
    if (this.panel === panel) {
      this.panel = undefined
      this.targets.clear()
    }
    try {
      try {
        panel.options.onRetired('cancel')
      } finally {
        panel.onClose()
      }
    } finally {
      this.render()
    }
  }

  isOpen(): boolean {
    return this.current() !== undefined
  }

  /**
   * Invalidate the current frame's targets while a Modal owns the keyboard.
   * The selection and query survive; the next real render rebuilds the
   * current targets.
   */
  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    if (this.panel !== undefined) this.panel.revision += 1
    this.targets.clear()
  }

  /** The real Picker node target the session renderer asks focus for. */
  desiredFocusId(): string | undefined {
    for (const [id, target] of this.targets) {
      if (target.kind === 'picker') return id
    }
    return undefined
  }

  private tooNarrow(): boolean {
    return this.paneWidth() < MIN_PANE_PIXELS
  }

  /**
   * The app-side key router. Any key while the hub is open belongs to the
   * hub (it never leaks to the composer), except the global Ctrl+C cancel,
   * which the session's existing precedence handles.
   */
  handleKey(key: Key): boolean {
    const panel = this.current()
    if (panel === undefined) return false
    if (key.ctrl === true && key.name === 'c') return false
    // A modal/hydration window keeps the hub visible but input-suspended: the
    // keys are consumed here and never reach the composer underneath.
    if (!this.canInteract()) return true
    const intent = this.keyIntent(panel, key)
    if (intent !== undefined) this.act(panel, panel.revision, intent)
    return true
  }

  private keyIntent(panel: WorkHubPanel, key: Key): WorkHubIntent | undefined {
    // The frozen Work Hub Esc returns to the composer even with a non-empty
    // query (it does NOT reuse the Session Browser's query-clear ladder).
    if (key.name === 'escape') return { kind: 'close' }
    // A pane too narrow for an honest pivot keeps only the close gesture.
    if (this.tooNarrow()) return { kind: 'consume' }
    if (key.name === 'tab') return { kind: 'zone', zone: panel.zone === 'list' ? 'actions' : 'list' }
    if (panel.zone === 'actions') {
      if (key.name === 'enter') return { kind: 'activate-action' }
      // One action: left/right/up/down have no focus to move.
      if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') return { kind: 'consume' }
      const edited = editQuery(panel, key)
      return edited === undefined ? { kind: 'consume' } : { kind: 'query', ...edited }
    }
    // A1: Enter/activate is consumed but opens nothing (the Reader is A2).
    if (key.name === 'enter') return { kind: 'consume' }
    const rows = visibleRows(panel)
    const index = rows.findIndex(row => row.value === panel.selected)
    const targetIndex = key.name === 'home' ? 0
      : key.name === 'end' ? rows.length - 1
        : key.name === 'up' ? Math.max(0, index - 1)
          : key.name === 'down' ? Math.min(rows.length - 1, Math.max(0, index) + 1)
            : key.name === 'page_up' ? Math.max(0, index - 5)
              : key.name === 'page_down' ? Math.min(rows.length - 1, Math.max(0, index) + 5)
                : undefined
    const target = targetIndex === undefined ? undefined : rows[targetIndex]
    if (target !== undefined && target.value !== panel.selected) return { kind: 'select', value: target.value }
    const edited = editQuery(panel, key)
    return edited === undefined ? { kind: 'consume' } : { kind: 'query', ...edited }
  }

  private act(panel: WorkHubPanel, revision: number, intent: WorkHubIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    switch (intent.kind) {
      case 'consume':
        return
      case 'close':
        this.userClose(panel)
        return
      case 'zone':
        panel.zone = intent.zone
        this.change(panel)
        return
      case 'select':
        if (!visibleRows(panel).some(row => row.value === intent.value)) return
        panel.selected = intent.value
        panel.zone = 'list'
        this.change(panel)
        return
      case 'query': {
        const oldVisible = visibleRows(panel)
        panel.query = intent.query
        panel.cursor = intent.cursor
        panel.zone = 'list'
        panel.selected = normalizeSelection(panel.selected, oldVisible, visibleRows(panel))
        this.change(panel)
        return
      }
      case 'activate-action':
        if (panel.zone === 'actions') this.userClose(panel)
        return
    }
  }

  private eventIntent(panel: WorkHubPanel, event: TspEvent, target: WorkHubTarget): WorkHubIntent | undefined {
    if (event.ev === 'select') {
      if (target.kind !== 'picker' || event.item === undefined) return undefined
      // A select can ONLY name a currently visible row: a stale/foreign ID is
      // ignored, never mapped to a row by index.
      return visibleRows(panel).some(row => row.value === event.item)
        ? { kind: 'select', value: event.item }
        : undefined
    }
    if (event.ev === 'activate') {
      if (target.kind !== 'picker' || event.item === undefined) return undefined
      // A1 consumes activation (no business router); only a current row is a
      // valid consume, so a stale activation changes nothing.
      return visibleRows(panel).some(row => row.value === event.item) ? { kind: 'consume' } : undefined
    }
    if (target.kind !== 'picker') return undefined
    if (event.ev !== 'action') return undefined
    // A1's ONLY executable action. Its id carries no revision because closing
    // is idempotent; any future action must carry its frame revision.
    if (event.act === CLOSE_ACTION_ID) return { kind: 'close' }
    return undefined
  }

  /**
   * The native event admission: only the surface's own, currently-registered
   * node of the CURRENT panel/revision may act. The target map is rebuilt
   * from each real frame, so a retired panel's node is never routable.
   */
  handleEvent(event: TspEvent): boolean {
    if (event.ev !== 'select' && event.ev !== 'activate' && event.ev !== 'action') return false
    if (!('sf' in event) || event.sf !== this.surfaceId || !('id' in event) || typeof event.id !== 'string') return false
    const target = this.targets.get(event.id)
    if (target === undefined) return false
    const panel = this.current()
    if (panel === undefined || target.panel !== panel || target.revision !== panel.revision) return false
    if (!this.canInteract()) return false
    const intent = this.eventIntent(panel, event, target)
    if (intent !== undefined) this.act(panel, target.revision, intent)
    return true
  }

  /**
   * Build the ONE layer node for the current frame and record its real node
   * IDs. `undefined` = no panel (the session renderer falls through to its
   * next presenter / the empty seat layer).
   */
  renderLayer(): Node | undefined {
    this.targets.clear()
    const panel = this.current()
    if (panel === undefined) return undefined
    if (this.suspended) {
      this.suspended = false
      panel.revision += 1
    }
    if (this.tooNarrow()) {
      // No picker, no footer: an unavailable line cannot be mistaken for a
      // clipped, actionable surface. The col is the region root; its keyed text
      // child carries the unmistakable `layer.work-hub-unavailable-<serial>` id.
      return ui.col(
        {},
        ui.text(
          { key: `work-hub-unavailable-${panel.serial}` },
          span('Work Hub unavailable at this pane width', 'muted'),
        ),
      )
    }
    const revision = panel.revision
    const node = hubLayer(panel, this.paneWidth() >= WIDE_PANE_PIXELS)
    const pickerKey = `work-hub-picker-${panel.serial}`
    for (const root of View.from({ layer: node }).regions) {
      const visit = (candidate: typeof root): void => {
        if (candidate === undefined) return
        const key = candidate.props['key']
        const kind: WorkHubTarget['kind'] = key === pickerKey ? 'picker' : 'other'
        this.targets.set(candidate.id, { panel, revision, kind })
        for (const child of candidate.children) visit(child)
      }
      visit(root)
    }
    return node
  }
}
