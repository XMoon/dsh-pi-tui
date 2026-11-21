/**
 * The internal native TSP Work Hub (PR4 B3-A1).
 *
 * ONE native `ui.picker` in the base inline surface's `layer`, with an
 * optional side Inspector on wide panes. It is a LOCAL presenter: every row
 * comes from the ONE `TaskRuntime` projection through the
 * `TaskCenterPresentationPort`, and this class owns only the discardable
 * panel state (selection, query, refresh state, targets).
 *
 * A2 adds the ONE local Read intent: `Enter` on the current row and the native
 * `View details` action ask the SESSION RENDERER to open a read-only Work
 * Details Reader. This presenter never opens a surface, never keeps a second
 * row catalog and never calls the business `onSelect` — the Reader's resource,
 * identity and lifecycle belong to `tsp/session.ts`. A3 opens the real command
 * path: the registered `/tasks` (`/subagents`) handler reaches this presenter
 * through the ONE `TaskRuntime`, and the TSP display seam advertises
 * `supportsTaskCenter` only for a pane that negotiated the kinds this Hub and
 * its Reader really emit.
 *
 * Not owned here: catalog reads, Job observation/Stop, subagent viewer,
 * Question answering, a second Session or a second surface. The native
 * picker/Inspector only route SELECT/ACTIVATE/ACTION into local panel state.
 *
 * @module @xmoon76/dsh-pi-tui/tui/tsp/work-hub
 */

import { View, span, ui, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import type { PickerAction, PickerGroup, PickerItem, PickerProps } from '@stencil-hq/tern'
import { isTaskItemActive, type TaskPanelItem } from '../../app/surface/task-presentation.ts'
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
 * A3's; this only keeps the internal presenter honest.) The Workflow scoped
 * browse entry consumes the SAME floor: a pane below it never paints a scoped
 * button, because the Hub it opens would refuse itself.
 */
export const WORK_HUB_MIN_PANE_PIXELS = 320

/** Whether the pane is wide enough for the Work Hub to present a usable Picker. */
export function workHubPaneWidthSupported(paneWidth: number): boolean {
  return paneWidth >= WORK_HUB_MIN_PANE_PIXELS
}
/** The native dismissal action id (idempotent, so it carries no revision). */
const CLOSE_ACTION_ID = 'close'
/**
 * The native read-only Reader action's BASE id. Its real id carries the frame
 * revision (`details#<rev>`), so an action painted by an older frame can never
 * open a newer row.
 */
const DETAILS_ACTION_ID = 'details'
/**
 * The native job-history disclosure action's BASE id. Like `details`, the real
 * id carries the frame revision (`jobs-history#<rev>`) so an action painted by an
 * older frame can never toggle a newer panel.
 */
const HISTORY_ACTION_ID = 'jobs-history'
/**
 * The native Picker `keys` tooltip token for the fixed local history chord.
 * TSP owns no keymap action for this chord (it is dispatched from the raw SDK
 * key stream, the same category as the TSP continued-inspection label), so the
 * token is composed here instead of copied from a remappable label.
 */
const HISTORY_ACTION_KEY = ['alt', 'j'].join('+')
/** The truthful Picker message when the pane lacks the Reader's capabilities. */
const DETAILS_UNAVAILABLE = 'Work details unavailable in this pane.'

type WorkHubZone = 'list' | 'actions'
type WorkHubRefresh = 'loading' | 'ready' | 'stale'
/** The native actions the action zone can hold. */
type WorkHubAction = 'close' | 'history' | 'details'
/**
 * Why the native Read action is (or is not) painted. The three states are
 * distinct FACTS, not one boolean: a pane that cannot present a Reader at all is
 * a durable pane limitation and states itself, while a Reader merely occupying
 * the renderer right now is a TEMPORARY state that must neither paint a dead
 * action nor claim the pane cannot read.
 */
export type WorkHubDetailsAdmission = 'available' | 'busy' | 'unsupported'

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
  /** The panel-local manual disclosure of retained terminal Jobs. */
  historyExpanded: boolean
  refresh: WorkHubRefresh
  refreshError: string | undefined
  /**
   * The user's explicit native action focus, or `undefined` while the current
   * default applies (details when readable, else history, else close).
   */
  actionFocus: WorkHubAction | undefined
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
  | { readonly kind: 'toggle-history' }
  | { readonly kind: 'details'; readonly targetValue: string }
  | { readonly kind: 'zone'; readonly zone: WorkHubZone }
  | { readonly kind: 'select'; readonly value: string }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
  | { readonly kind: 'action-focus'; readonly delta: -1 | 1 }
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

/** The panel's active Jobs (the SAME `isTaskItemActive` authority every renderer uses). */
function activeJobs(panel: WorkHubPanel): readonly TaskPanelItem[] {
  return panel.items.filter(item => item.source === 'job' && isTaskItemActive(item))
}

/** The panel's retained terminal Jobs (the ONE history candidate set). */
function historyJobs(panel: WorkHubPanel): readonly TaskPanelItem[] {
  return panel.items.filter(item => item.source === 'job' && !isTaskItemActive(item))
}

/** Whether the manual disclosure action has a real candidate on this frame. */
function historyAvailable(panel: WorkHubPanel): boolean {
  return panel.query.trim() === '' && historyJobs(panel).length > 0
}

/** The action label for the current history candidate set. */
function historyLabel(panel: WorkHubPanel): string {
  const count = historyJobs(panel).length
  if (panel.historyExpanded) return `Hide ${count} past jobs`
  return activeJobs(panel).length > 0 ? `Show ${count} past jobs` : `Show ${count} jobs`
}

/**
 * The panel-local row projection: the input order is preserved (the runtime
 * already committed the stable pre-order), a query filters only the local
 * rows, and the group derivation never re-sorts or duplicates a row.
 *
 * A non-empty query always searches the FULL current roster (including the
 * retained terminal Jobs the collapsed view hides); an empty query applies the
 * manual disclosure. The query itself never mutates the manual state.
 */
function visibleRows(panel: WorkHubPanel): readonly TaskPanelItem[] {
  const query = panel.query.trim().toLocaleLowerCase()
  const candidates = query === '' && !panel.historyExpanded
    ? panel.items.filter(item => item.source !== 'job' || isTaskItemActive(item))
    : panel.items
  if (query === '') return candidates
  return candidates.filter(item => [
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

/**
 * The status subtitle from the FULL committed roster, never from the locally
 * collapsed view: a retained failed Job stays a real status fact while hidden,
 * and the hidden count states only that the manual view is collapsed.
 */
function subtitleText(panel: WorkHubPanel): string | undefined {
  const groups = groupsOf(panel.items)
  const work = [...groups.subagents, ...groups.jobs]
  const running = work.filter(item => item.active === true || item.status === 'running' || item.status === 'stopping').length
  const failed = work.filter(item => isFailureStatus(item.status)).length
  const hidden = !panel.historyExpanded && panel.query.trim() === '' ? historyJobs(panel).length : 0
  const parts: string[] = []
  if (groups.attention.length > 0) parts.push(`${groups.attention.length} attention`)
  if (running > 0) parts.push(`${running} running`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (hidden > 0) parts.push(`${hidden} retained Jobs hidden`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * The action the action zone's Enter really runs, normalized to the actions
 * that currently exist. A stale preference never survives as a ghost.
 */
function normalizeActionFocus(
  focus: WorkHubAction,
  history: boolean,
  details: boolean,
): WorkHubAction {
  if (focus === 'close') return 'close'
  if (focus === 'history' && history) return 'history'
  if (focus === 'details' && details) return 'details'
  if (details) return 'details'
  if (history) return 'history'
  return 'close'
}

/** The initial action focus before the user has chosen one. */
function defaultActionFocus(history: boolean, details: boolean): WorkHubAction {
  if (details) return 'details'
  if (history) return 'history'
  return 'close'
}

/**
 * The ONE layer node: one native picker plus the optional Inspector child.
 *
 * The native actions are `Close`, the job-history `Show/Hide` disclosure
 * (only while the current empty-query roster has a retained terminal Job), and
 * — ONLY while a current visible row can be read and the renderer negotiated
 * the Reader's capabilities — the primary `View details`. Revision-tokened
 * action ids keep an older frame from acting on a newer one. A pane that cannot
 * present the Reader paints the truthful unavailability message instead of a
 * button that would do nothing.
 */
function hubLayer(panel: WorkHubPanel, wide: boolean, admission: WorkHubDetailsAdmission): Node {
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
  // The truthful unavailability line is a CAPABILITY fact, so it outranks a
  // stale refresh error but never appears merely because the list is empty —
  // and never because a Reader is temporarily open (`busy` is not a pane
  // limitation).
  const message = admission === 'unsupported'
    ? DETAILS_UNAVAILABLE
    : panel.refresh === 'stale'
      ? `Could not refresh tasks; showing last known entries.${panel.refreshError === undefined ? '' : ` ${sanitizeTerminalText(panel.refreshError)}`}`
      : undefined
  const subtitle = subtitleText(panel)
  const detailsAvailable = admission === 'available' && selectedRow !== undefined
  const history = historyAvailable(panel)
  // The focused action is the one a keyboard Enter would run: a stored
  // `details`/`history` preference falls back to the actions that really exist.
  const focused: WorkHubAction | undefined = panel.zone !== 'actions'
    ? undefined
    : panel.actionFocus === undefined
      ? defaultActionFocus(history, detailsAvailable)
      : normalizeActionFocus(panel.actionFocus, history, detailsAvailable)
  const actions: PickerAction[] = [{
    id: CLOSE_ACTION_ID,
    label: focused === 'close' ? 'Close [Enter]' : 'Close',
    keys: ['escape'],
  }]
  if (history) {
    actions.push({
      id: `${HISTORY_ACTION_ID}#${panel.revision}`,
      label: focused === 'history' ? `${historyLabel(panel)} [Enter]` : historyLabel(panel),
      keys: [HISTORY_ACTION_KEY],
      ...(detailsAvailable ? {} : { primary: true }),
      on: panel.historyExpanded,
    })
  }
  if (detailsAvailable) {
    actions.push({
      id: `${DETAILS_ACTION_ID}#${panel.revision}`,
      label: focused === 'details' ? 'View details [Enter]' : 'View details',
      primary: true,
    })
  }
  // A collapsed view with only retained terminal Jobs is a real history-only
  // frame: it states there is no ACTIVE Job instead of claiming the roster is
  // empty. Loading/stale keep their own truthful state/message above.
  const historyOnly = panel.query.trim() === '' && !panel.historyExpanded
    && rows.length === 0 && historyJobs(panel).length > 0
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
    empty: historyOnly
      ? 'No active Jobs in this view.'
      : panel.query.trim() === '' ? 'No tasks are available for this session.' : 'No work matches this search.',
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
  /**
   * Ask the SESSION RENDERER to open the read-only Work Details Reader for the
   * CURRENT selected row. This is a local Read intent — never the business
   * `onSelect` — and the hub keeps no Reader state afterwards.
   */
  onViewDetails(request: {
    readonly panelSerial: number
    readonly targetValue: string
  }): void
  /**
   * Why the Reader action may (not) be painted right now. `unsupported` is the
   * pane's own negotiated capability; `busy` means a reading is opening, open
   * or still closing. Only PAINTS the action; the renderer rechecks before
   * acquiring the Screen.
   */
  detailsAdmission(): WorkHubDetailsAdmission
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
  private readonly onViewDetails: TspWorkHubDeps['onViewDetails']
  private readonly detailsAdmissionOf: TspWorkHubDeps['detailsAdmission']
  private panel: WorkHubPanel | undefined
  private serial = 0
  private suspended = false
  private targets = new Map<string, WorkHubTarget>()

  constructor(deps: TspWorkHubDeps) {
    this.surfaceId = deps.surfaceId
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.paneWidth = deps.paneWidth
    this.onViewDetails = deps.onViewDetails
    this.detailsAdmissionOf = deps.detailsAdmission
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
    // A retirement callback may synchronously open — and even close again — a
    // NEWER panel while this earlier open retires the displayed one. The
    // monotonic `serial` is the operation-generation witness: an increment
    // during retirement proves that a newer presenter lifetime owns the seat,
    // so this earlier open stays inert. A plain `this.panel` check would miss
    // the newer open-then-close case (§9.8/§9.9). Sibling presenters are
    // retired by the seat wrapper before this call (plan §10.2).
    const serialBefore = this.serial
    this.retire()
    if (this.serial !== serialBefore) {
      return { close: () => {}, setItems: () => {}, setRefreshState: () => {} }
    }
    const panel: WorkHubPanel = {
      serial: ++this.serial,
      revision: 0,
      retired: false,
      items: [...items],
      selected: undefined,
      query: '',
      cursor: 0,
      zone: 'list',
      historyExpanded: false,
      refresh: options.loading ? 'loading' : 'ready',
      refreshError: undefined,
      actionFocus: undefined,
      onSelect,
      onClose,
      options,
    }
    panel.selected = chooseInitial(visibleRows(panel))
    // The action-zone focus starts as the CURRENT default (undefined is the
    // default sentinel, not a user choice): a loading -> ready commit may adopt
    // the real rows' default once they arrive.
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
    const oldSelected = panel.selected
    panel.items = [...items]
    // Rows arriving end the loading display, but NEVER clear a stale refresh
    // error: only the coordinator's own `setRefreshState('ready')` proves a
    // successful refresh (a runtime commit is not a catalog success).
    if (panel.refresh === 'loading') panel.refresh = 'ready'
    // The manual disclosure is per-open state: the last retained terminal Job
    // disappearing resets it, while a refresh that still has candidates keeps it.
    if (historyJobs(panel).length === 0) panel.historyExpanded = false
    const newVisible = visibleRows(panel)
    const oldRow = oldSelected === undefined ? undefined : oldVisible.find(row => row.value === oldSelected)
    if (oldSelected !== undefined && !newVisible.some(row => row.value === oldSelected)) {
      // An ACTIVE Job turning terminal while collapsed leaves the visible set.
      // Prefer another still-visible ACTIVE Job before the ordinary neighbour
      // normalization; an expanded frame keeps the row and enters no branch.
      const firstActive = newVisible.find(row => row.source === 'job' && isTaskItemActive(row))
      panel.selected = oldRow?.source === 'job' && firstActive !== undefined
        ? firstActive.value
        : normalizeSelection(oldSelected, oldVisible, newVisible)
    } else {
      panel.selected = normalizeSelection(oldSelected, oldVisible, newVisible)
    }
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
    // An untouched focus is the CURRENT default and follows the real action
    // set across loading -> ready. An explicit user choice is only normalized
    // away when its own action disappears; a later reappearance never
    // resurrects an action the user did not re-choose.
    const history = historyAvailable(panel)
    const details = this.detailsAvailable(panel)
    if (panel.actionFocus !== undefined) panel.actionFocus = normalizeActionFocus(panel.actionFocus, history, details)
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
   * Invalidate the current frame's targets while another owner takes this
   * pane's screen (a Modal, or the read-only Reader that covers it). The
   * selection and query survive; the next real render rebuilds the current
   * targets.
   *
   * The panel revision bump is what retires an ALREADY DELIVERED action id
   * across that handover. `details#<revision>` names the frame that painted it,
   * so once this panel is painted again its actions carry a different token. A
   * delayed `details#N` from before the Reader therefore cannot open a second
   * reading after the return — a panel whose selection and query are unchanged
   * would otherwise still match it, letting an old interactive stage run twice.
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
    return !workHubPaneWidthSupported(this.paneWidth())
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
    // `Alt+J` is the exact keyboard twin of the native disclosure action. A
    // plain `j` stays query text below; a non-matching chord never types.
    if (key.alt === true && key.name === 'j' && key.ctrl !== true && key.meta !== true && key.shift !== true) {
      return historyAvailable(panel) ? { kind: 'toggle-history' } : { kind: 'consume' }
    }
    // Two zones, one ring: Tab and Shift+Tab are the same inverse transition.
    if (key.name === 'tab') return { kind: 'zone', zone: panel.zone === 'list' ? 'actions' : 'list' }
    if (panel.zone === 'actions') {
      if (key.name === 'enter') return { kind: 'activate-action' }
      if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
        if (this.actionRing(panel).length <= 1) return { kind: 'consume' }
        return { kind: 'action-focus', delta: key.name === 'up' || key.name === 'left' ? -1 : 1 }
      }
      const edited = editQuery(panel, key)
      return edited === undefined ? { kind: 'consume' } : { kind: 'query', ...edited }
    }
    // Enter is the LOCAL Read intent for the current row only. Pointer
    // `activate` is not more permissive (see `eventIntent`).
    if (key.name === 'enter') {
      const current = this.resolveDetails(panel.serial, panel.selected)
      return current === undefined ? { kind: 'consume' } : { kind: 'details', targetValue: current.value }
    }
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

  /** Whether the current row can be read AND the renderer can present it. */
  private detailsAvailable(panel: WorkHubPanel): boolean {
    return this.detailsAdmissionOf() === 'available'
      && this.resolveDetails(panel.serial, panel.selected) !== undefined
  }

  private act(panel: WorkHubPanel, revision: number, intent: WorkHubIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    switch (intent.kind) {
      case 'consume':
        return
      case 'close':
        this.userClose(panel)
        return
      case 'toggle-history':
        this.toggleJobHistory(panel)
        return
      case 'details': {
        // Re-resolve through the ONE current-row resolver AND re-read the
        // renderer capability at admission: a resolution from an older
        // frame/revision can never open a newer row or a missing capability.
        if (this.detailsAdmissionOf() !== 'available') return
        const current = this.resolveDetails(panel.serial, intent.targetValue)
        if (current === undefined) return
        const request = { panelSerial: panel.serial, targetValue: current.value }
        // The renderer may synchronously open (and even retire) a sibling
        // presenter; after this call the captured `panel` is NOT authoritative.
        this.onViewDetails(request)
        return
      }
      case 'zone':
        // The stored focus survives a re-entry: returning from the Reader keeps
        // the exact zone/action focus. A stale `details` focus falls back to
        // `close` only at PAINT/activation time (`focusedAction`).
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
      case 'action-focus': {
        const ring = this.actionRing(panel)
        if (ring.length <= 1) return
        const current = ring.indexOf(this.focusedAction(panel))
        panel.actionFocus = ring[(current + intent.delta + ring.length) % ring.length]!
        this.change(panel)
        return
      }
      case 'activate-action': {
        if (panel.zone !== 'actions') return
        switch (this.focusedAction(panel)) {
          case 'history':
            this.toggleJobHistory(panel)
            return
          case 'details': {
            if (this.detailsAdmissionOf() !== 'available') return
            const current = this.resolveDetails(panel.serial, panel.selected)
            if (current === undefined) return
            this.onViewDetails({ panelSerial: panel.serial, targetValue: current.value })
            return
          }
          case 'close':
            this.userClose(panel)
            return
        }
      }
    }
  }

  /** The actions that really exist on this frame, in the fixed bar order. */
  private actionRing(panel: WorkHubPanel): WorkHubAction[] {
    const ring: WorkHubAction[] = ['close']
    if (historyAvailable(panel)) ring.push('history')
    if (this.detailsAvailable(panel)) ring.push('details')
    return ring
  }

  /** The action the action zone's Enter would run, normalized to what exists. */
  private focusedAction(panel: WorkHubPanel): WorkHubAction {
    const history = historyAvailable(panel)
    const details = this.detailsAvailable(panel)
    return panel.actionFocus === undefined
      ? defaultActionFocus(history, details)
      : normalizeActionFocus(panel.actionFocus, history, details)
  }

  /**
   * The ONE local disclosure transition. It changes only the panel's manual
   * boolean and the selection; it never reads a source, never touches the
   * business row router and never acknowledges failure attention.
   */
  private toggleJobHistory(panel: WorkHubPanel): void {
    if (!this.canInteract() || this.current() !== panel) return
    if (!historyAvailable(panel)) return
    const oldVisible = visibleRows(panel)
    const oldSelected = panel.selected
    panel.historyExpanded = !panel.historyExpanded
    const newVisible = visibleRows(panel)
    if (panel.historyExpanded) {
      // Open: select the first REAL retained Job, never a group or a type.
      panel.selected = newVisible.find(row => row.source === 'job' && !isTaskItemActive(row))?.value
    } else if (oldSelected !== undefined && newVisible.some(row => row.value === oldSelected)) {
      // Hide: a still-visible selection survives untouched.
      panel.selected = oldSelected
    } else {
      // Hide: a hidden history selection moves to the first visible ACTIVE Job,
      // then to the ordinary neighbour rule.
      const firstActive = newVisible.find(row => row.source === 'job' && isTaskItemActive(row))
      panel.selected = firstActive?.value ?? normalizeSelection(oldSelected, oldVisible, newVisible)
    }
    panel.zone = 'list'
    this.change(panel)
  }

  private eventIntent(panel: WorkHubPanel, event: TspEvent, target: WorkHubTarget): WorkHubIntent | undefined {
    if (event.ev === 'select') {
      if (target.kind !== 'picker' || event.item === undefined) return undefined
      // A select can ONLY name a currently visible row: a stale/foreign ID is
      // ignored, never mapped to a row by index. Selection alone never reads.
      return visibleRows(panel).some(row => row.value === event.item)
        ? { kind: 'select', value: event.item }
        : undefined
    }
    if (event.ev === 'activate') {
      if (target.kind !== 'picker' || event.item === undefined) return undefined
      // Activation reads ONLY the row it names AND only while that row is still
      // the CURRENT selection: a delayed activation of a row that is no longer
      // selected is consumed instead of silently switching and opening it.
      if (event.item !== panel.selected) return undefined
      const current = this.resolveDetails(panel.serial, event.item)
      return current === undefined ? undefined : { kind: 'details', targetValue: current.value }
    }
    if (target.kind !== 'picker') return undefined
    if (event.ev !== 'action') return undefined
    // `Close` is idempotent dismissal, so it carries no token.
    if (event.act === CLOSE_ACTION_ID) return { kind: 'close' }
    // The history toggle carries the frame revision that painted it and must
    // still have a real candidate on the current panel.
    if (event.act === `${HISTORY_ACTION_ID}#${target.revision}`) {
      return historyAvailable(panel) ? { kind: 'toggle-history' } : undefined
    }
    // `View details` carries the frame revision that painted it, and must name
    // the frame this event's registered picker target belongs to.
    if (event.act === `${DETAILS_ACTION_ID}#${target.revision}`) {
      const current = this.resolveDetails(panel.serial, panel.selected)
      return current === undefined ? undefined : { kind: 'details', targetValue: current.value }
    }
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
    const node = hubLayer(panel, this.paneWidth() >= WIDE_PANE_PIXELS, this.detailsAdmissionOf())
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

  isCurrentPanel(panelSerial: number): boolean {
    return this.current()?.serial === panelSerial
  }

  /**
   * The ONE current-row resolver used by the Read admission and by every
   * Reader rerender: the row must survive in the SAME current panel, stay in
   * the CURRENT visible filter and remain the CURRENT selection. It performs
   * no source read, no query change and no selection mutation.
   */
  resolveDetails(panelSerial: number, targetValue: string | undefined): TaskPanelItem | undefined {
    const panel = this.current()
    if (panel === undefined || panel.serial !== panelSerial) return undefined
    if (targetValue === undefined || panel.selected !== targetValue) return undefined
    return visibleRows(panel).find(row => row.value === targetValue)
  }
}
