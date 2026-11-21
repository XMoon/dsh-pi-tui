/**
 * The native TSP `/web` presentation (M5-W PR-C): ONE `ui.picker` page plus one
 * read-only Details Reading, inside the renderer's ONE layer.
 *
 * It owns NO business authority: every Web status read, enable/disable call and
 * authenticated-URL request stays in the command. This class owns one panel's
 * local presentation state (phase, page, keyboard zone, highlight, reading
 * epoch, notice) and the admission that decides whether a key/click may touch
 * it.
 *
 * Page contract (frozen by the plan):
 *  - the MENU is ONE native `ui.picker` (`size:'md'`, `preview:'none'`) whose
 *    first row is the DISABLED fact row `Status: …` and whose second row is the
 *    `Details…` reader entry. The only business writes are the native footer
 *    actions: `disabled` → `Enable Web`; `enabled` → `Open Browser`,
 *    `Copy Link`, `Disable Web`; `changing`/`unavailable` → `Close`. The
 *    status row itself is inert, and nothing on the page writes without an
 *    explicit action activation.
 *  - `Details…` REPLACES the picker with a read-only native overlay in the same
 *    layer (never an overlay stacked on a picker). `Esc` and the first
 *    `← Back to Web · Esc` navigation row both go back.
 *
 * Every interactive id is the one the CURRENT committed frame really built:
 * rows and the reading body are indexed per frame, footer actions carry the
 * frame revision, and an event from a retired frame/panel is refused at the one
 * admission point below.
 *
 * @module tui/tsp/web-access-picker
 */

import { View, span, ui, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import type { PickerAction, PickerItem, PickerProps } from '@stencil-hq/tern'
import type {
  WebAccessActionId,
  WebAccessMenuHandle,
  WebAccessNotice,
  WebAccessPresentation,
  WebAccessReadOutcome,
  WebAccessRequest,
} from '../../app/command/web-access-presentation.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED action. */
type WebAccessPickerPhase = 'loading' | 'ready' | 'pending'

/** The visible page: the menu picker, or the read-only Details Reading. */
type WebAccessPickerPage = 'menu' | 'details'

export type WebAccessPickerZone = 'list' | 'actions'

interface WebAccessPickerPanel {
  readonly serial: number
  readonly request: WebAccessRequest
  revision: number
  disposed: boolean
  phase: WebAccessPickerPhase
  page: WebAccessPickerPage
  zone: WebAccessPickerZone
  /** The adopted read outcome; `undefined` only in the initial loading phase. */
  outcome: WebAccessReadOutcome | undefined
  /** The visible statement of the admitted action (the `pending` phase). */
  pending: string
  /** The settled action result, painted as an inert fact row while the menu is open. */
  notice: WebAccessNotice | undefined
  /** The highlight: the row id the keyboard/mouse last moved onto. */
  selected: string
  /** Which footer entry owns Enter, as a BASE id. */
  actionFocus: string | undefined
  /** The reading's identity (a `scroll` op from a previous reading is refused). */
  readerEpoch: number
}

type WebAccessPickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'zone'; readonly zone: WebAccessPickerZone }
  | { readonly kind: 'browse-row'; readonly rowId: string }
  | { readonly kind: 'open-details' }
  | { readonly kind: 'back' }
  | { readonly kind: 'reader-scroll'; readonly step: ScrollTo }
  | { readonly kind: 'action-focus'; readonly delta: -1 | 1 }
  | { readonly kind: 'activate-action' }
  | { readonly kind: 'run-action'; readonly base: string }

/** The row ids the menu really paints. */
const STATUS_ROW = 'web-status'
const NOTICE_ROW = 'web-notice'
const DETAILS_ROW = 'web-details'
/** The body key prefix the presenter resolves its scroll target from. */
export const WEB_READING_BODY_KEY_PREFIX = 'web-reading-body-'
/** The one action that is deliberately frame-independent: dismissal. */
const FRAME_FREE_ACTION = 'close'
/** The token a footer action id carries (the frame revision). */
const ACTION_TOKEN = '#'

/** The ONE operation the current page/phase really offers, by base id. */
interface WebAccessPickerAction {
  readonly id: string
  readonly label: string
  readonly primary?: boolean
}

/** The two fact/entry rows of the menu (the ONLY browsable rows). */
function menuRows(panel: WebAccessPickerPanel): string[] {
  return panel.notice === undefined
    ? [STATUS_ROW, DETAILS_ROW]
    : [STATUS_ROW, NOTICE_ROW, DETAILS_ROW]
}

/** The human label of the adopted status (the Host's own vocabulary). */
export function webAccessStatusLabel(outcome: WebAccessReadOutcome | undefined): string {
  if (outcome === undefined) return 'Status: loading…'
  if (outcome.kind === 'unavailable') return 'Status: unavailable (connection)'
  return `Status: ${outcome.status.state}`
}

/** The complete status sentence (the disabled fact row's detail). */
export function webAccessStatusDetail(outcome: WebAccessReadOutcome | undefined): string {
  if (outcome === undefined) return 'Reading the Host Web frontend state.'
  if (outcome.kind === 'unavailable') {
    return `The Host Web status could not be read: ${outcome.message}`
  }
  switch (outcome.status.state) {
    case 'disabled':
      return 'The official Web frontend is not being served by this Host.'
    case 'enabled':
      return 'The official Web frontend is being served by this Host on 127.0.0.1.'
    case 'changing':
      return 'A Web enable/disable request is still running; wait for it to settle.'
    case 'unavailable':
      return `The Host cannot report a serving Web frontend: ${outcome.status.reason}`
  }
}

/**
 * The footer operations the CURRENT state admits. A status the Host cannot
 * describe truthfully offers no write — only the dismissal (`Close`/`Esc`).
 */
function offeredActions(panel: WebAccessPickerPanel): readonly WebAccessPickerAction[] {
  if (panel.phase === 'pending') return [{ id: FRAME_FREE_ACTION, label: 'Close' }]
  if (panel.phase === 'loading') return [{ id: FRAME_FREE_ACTION, label: 'Close' }]
  if (panel.page === 'details') return []
  const outcome = panel.outcome
  if (outcome === undefined || outcome.kind === 'unavailable') {
    return [{ id: FRAME_FREE_ACTION, label: 'Close' }]
  }
  switch (outcome.status.state) {
    case 'disabled':
      return [{ id: 'enable', label: 'Enable Web', primary: true }]
    case 'enabled':
      return [
        { id: 'open-browser', label: 'Open Browser' },
        { id: 'copy-link', label: 'Copy Link' },
        { id: 'disable', label: 'Disable Web', primary: true },
      ]
    case 'changing':
    case 'unavailable':
      return [{ id: FRAME_FREE_ACTION, label: 'Close' }]
  }
}

/** The revision-scoped wire id the CURRENT frame paints for one action base. */
function actionId(panel: WebAccessPickerPanel, base: string): string {
  return base === FRAME_FREE_ACTION ? base : `${base}${ACTION_TOKEN}${panel.revision}`
}

/** The action base an id names, or `undefined` for a stale/foreign id. */
function actionBase(panel: WebAccessPickerPanel, id: string): string | undefined {
  if (id === FRAME_FREE_ACTION) return id
  const at = id.lastIndexOf(ACTION_TOKEN)
  if (at <= 0) return undefined
  return id.slice(at + 1) === String(panel.revision) ? id.slice(0, at) : undefined
}

/** Whether one BASE action may run right now (the SAME decision the bar paints). */
function actionEnabled(panel: WebAccessPickerPanel, base: string): boolean {
  if (base === FRAME_FREE_ACTION) return true
  return offeredActions(panel).some((action) => action.id === base)
}

/** The action Enter runs right now. */
function focusedAction(panel: WebAccessPickerPanel): WebAccessPickerAction | undefined {
  const explicit = offeredActions(panel).find((action) => action.id === panel.actionFocus)
  if (explicit !== undefined) return explicit
  return offeredActions(panel)[0]
}

/** Step the footer ring. */
function stepActionFocus(panel: WebAccessPickerPanel, delta: -1 | 1): string | undefined {
  const offered = offeredActions(panel)
  if (offered.length === 0) return undefined
  const at = Math.max(offered.findIndex((action) => action.id === focusedAction(panel)?.id), 0)
  return offered[(at + delta + offered.length) % offered.length]?.id
}

/** The rendered footer: the current frame's token in every id. */
function renderedActions(panel: WebAccessPickerPanel): PickerAction[] {
  const focused = panel.zone === 'actions' ? focusedAction(panel)?.id : undefined
  return offeredActions(panel).map((action) => ({
    id: actionId(panel, action.id),
    label: action.id === focused ? `${action.label} [Enter]` : action.label,
    ...(action.primary === true ? { primary: true } : {}),
  }))
}

/** The ONE native picker of the menu page. */
function menuPicker(panel: WebAccessPickerPanel): Node {
  const items: PickerItem[] = [
    {
      id: STATUS_ROW,
      label: sanitizedPhysicalLine(webAccessStatusLabel(panel.outcome)),
      // The plan's frozen fact row: a disabled row the user reads, never acts on.
      disabled: true,
      detail: sanitizedPhysicalLine(webAccessStatusDetail(panel.outcome)),
    },
    ...(panel.notice === undefined ? [] : [{
      id: NOTICE_ROW,
      label: sanitizedPhysicalLine(panel.notice.message),
      // A settled action result: an inert fact the user reads, never an operation.
      disabled: true as const,
      ...(panel.notice.kind === 'error' ? { dot: 'error' as const } : {}),
      detail: panel.notice.kind === 'error' ? 'The action failed; the Host state below is the truth.' : 'Action result.',
    }]),
    {
      id: DETAILS_ROW,
      label: 'Details…',
      detail: 'Host, current state and the limits of the Web frontend.',
    },
  ]
  const message = panel.phase === 'pending' ? panel.pending : undefined
  const props: PickerProps & { readonly key: string } = {
    key: `web-picker-${panel.serial}`,
    title: 'Web frontend',
    noun: 'Web option',
    layout: 'rows',
    size: 'md',
    preview: 'none',
    items,
    order: [...menuRows(panel)],
    total: items.length,
    selected: panel.selected,
    focus: 'list',
    state: panel.phase === 'loading' ? 'loading' : 'ready',
    ...(message === undefined ? {} : { message: sanitizedPhysicalLine(message) }),
    actions: renderedActions(panel),
  }
  return ui.picker(props)
}

/* --------------------------------------------------------------- reading */

const readingScope = (panel: WebAccessPickerPanel): string => `${panel.serial}-${panel.readerEpoch}`
const bodyKey = (panel: WebAccessPickerPanel): string => `${WEB_READING_BODY_KEY_PREFIX}${readingScope(panel)}`

/** The Details Reading's way back (the native navigation row). */
function detailsBackRow(panel: WebAccessPickerPanel, bind: (intent: WebAccessPickerIntent) => () => void): Node {
  return ui.row(
    {
      key: `web-details-back-${readingScope(panel)}`,
      onClick: bind({ kind: 'back' }),
    },
    ui.text({
      key: `web-details-back-label-${readingScope(panel)}`,
      spans: [span('← Back to Web', 'accent'), span(' · Esc', 'muted')],
    }),
  )
}

/** One fact block of the read-only Reading. */
function fact(panel: WebAccessPickerPanel, label: string, value: string, wrap: 'word' | 'char' = 'word'): Node[] {
  return [
    ui.text(span(label, 'muted')),
    ui.text({
      key: `web-fact-${readingScope(panel)}-${label.toLowerCase().replace(/[^a-z]+/gu, '-')}`,
      text: sanitizeDisplayText(value),
      wrap,
    }),
  ]
}

/**
 * The Details Reading: the durable facts a user must know, with NO launch URL.
 * One continuous scrolling body; the first row is the pointer path back and
 * `Esc` (admitted at any scroll position) is the keyboard twin.
 */
function detailsOverlay(panel: WebAccessPickerPanel, bind: (intent: WebAccessPickerIntent) => () => void): Node {
  return ui.overlay(
    {
      key: `web-details-${readingScope(panel)}`,
      head: 'Web frontend · Details',
      size: 'lg',
      modal: true,
    },
    detailsBackRow(panel, bind),
    ui.col(
      { key: bodyKey(panel), gap: 'xs' },
      ...fact(panel, 'Host', '127.0.0.1 (this machine only; no LAN, proxy or SSH tunnel)'),
      ...fact(panel, 'Status', webAccessStatusDetail(panel.outcome)),
      ...fact(
        panel,
        'Enable / Disable',
        'Start or stop serving the official Web frontend. Disabling unloads the Web-only rows; it does not revoke browser cookies or terminate an already open page.',
      ),
      ...fact(
        panel,
        'Session',
        'Opens the Web home page; choose a session there. The TUI does not open or follow a specific session.',
      ),
      ...fact(panel, 'Auto-start', 'The Auto-start preference applies on the next Host launch.'),
    ),
  )
}

/** The whole layer for one frame (exactly ONE page). */
function webPickerLayer(
  panel: WebAccessPickerPanel,
  bind: (intent: WebAccessPickerIntent) => () => void,
): Node {
  return ui.col(
    { key: `web-layer-${panel.serial}` },
    panel.page === 'details' ? detailsOverlay(panel, bind) : menuPicker(panel),
  )
}

/* ---------------------------------------------------------------- intents */

/** The next zone Tab reaches. The action bar is reachable only when it has one. */
function tabZone(panel: WebAccessPickerPanel, direction: -1 | 1): WebAccessPickerZone {
  if (offeredActions(panel).length === 0) return 'list'
  return panel.zone === 'list' ? 'actions' : 'list'
}

/** One real key -> one intent (never a mutation; admission lives in the class). */
function keyIntent(panel: WebAccessPickerPanel, key: Key): WebAccessPickerIntent | undefined {
  if (key.ctrl === true && key.name === 'c') return undefined
  if (key.name === 'escape') {
    // The Details Reading's Esc is its always-available way back.
    if (panel.page === 'details') return { kind: 'back' }
    return { kind: 'close' }
  }
  if (panel.phase === 'pending' || panel.phase === 'loading') return undefined
  if (panel.page === 'details') {
    const step: ScrollTo | undefined = key.name === 'up' ? 'line-up'
      : key.name === 'down' ? 'line-down'
        : key.name === 'page_up' ? 'page-up'
          : key.name === 'page_down' ? 'page-down'
            : key.name === 'home' ? 'start'
              : key.name === 'end' ? 'end'
                : undefined
    if (step !== undefined) return { kind: 'reader-scroll', step }
    if (key.name === 'enter') return { kind: 'back' }
    return undefined
  }
  if (key.name === 'tab') return { kind: 'zone', zone: tabZone(panel, key.shift === true ? -1 : 1) }
  if (panel.zone === 'actions') {
    if (key.name === 'left' || key.name === 'up') return { kind: 'action-focus', delta: -1 }
    if (key.name === 'right' || key.name === 'down') return { kind: 'action-focus', delta: 1 }
    if (key.name === 'enter') return { kind: 'activate-action' }
    return undefined
  }
  if (key.name === 'up' || key.name === 'down') {
    // The status row is a DISABLED fact, so `Details…` is the only selectable
    // row: there is nothing to move onto (browse only, never a write).
    return undefined
  }
  if (key.name === 'enter') return panel.selected === DETAILS_ROW ? { kind: 'open-details' } : undefined
  return undefined
}

/** One row event (`select` browses, `activate` opens the Details Reading). */
function rowIntent(panel: WebAccessPickerPanel, item: string, kind: 'select' | 'activate'): WebAccessPickerIntent | undefined {
  if (panel.page !== 'menu') return undefined
  if (item !== STATUS_ROW && item !== DETAILS_ROW) return undefined
  if (kind === 'activate') return item === DETAILS_ROW ? { kind: 'open-details' } : undefined
  return { kind: 'browse-row', rowId: item }
}

/** One footer action event: only an id THIS frame painted may run. */
function actionIntent(panel: WebAccessPickerPanel, act: string): WebAccessPickerIntent | undefined {
  if (act === FRAME_FREE_ACTION) return { kind: 'close' }
  if (panel.page !== 'menu') return undefined
  const base = actionBase(panel, act)
  if (base === undefined || !actionEnabled(panel, base)) return undefined
  // The event names the row it really belongs to: the intent carries THAT base,
  // never the footer's current highlight, so a pointer click can never run a
  // different operation than the one it hit.
  return { kind: 'run-action', base }
}

/* --------------------------------------------------------------- presenter */

export class TspWebAccessPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: WebAccessPresentation['notify']
  /** The ONE Surface owner's native scroll op, addressed by a frame wire id. */
  private readonly nativeScroll: (id: string, to: ScrollTo) => void
  private panel: WebAccessPickerPanel | undefined
  private serial = 0
  /** The current frame's event targets (node id -> the revision it was built for). */
  private targets = new Map<string, { panel: WebAccessPickerPanel; revision: number }>()
  /** The Reading body's wire id in the frame last built. */
  private readerBodyId: string | undefined
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: WebAccessPresentation['notify']
    nativeScroll(id: string, to: ScrollTo): void
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
    this.nativeScroll = deps.nativeScroll
  }

  readonly presentation: WebAccessPresentation = {
    open: (request) => this.open(request),
    notify: (message, kind) => {
      this.notify(message, kind)
    },
  }

  private current(): WebAccessPickerPanel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.disposed) return undefined
    if (!panel.request.isCurrent()) {
      this.retire()
      return undefined
    }
    return panel
  }

  private open(request: WebAccessRequest): WebAccessMenuHandle {
    this.retire()
    const panel: WebAccessPickerPanel = {
      serial: ++this.serial,
      request,
      revision: 0,
      disposed: false,
      phase: 'loading',
      page: 'menu',
      zone: 'list',
      outcome: undefined,
      pending: '',
      notice: undefined,
      selected: DETAILS_ROW,
      actionFocus: undefined,
      readerEpoch: 0,
    }
    this.panel = panel
    this.change(panel)
    // The menu asks the Host for its status as soon as it is entered; the
    // command's read owner answers through `setStatus`.
    request.runOwned('web status', () => request.readStatus(), {
      isCancellation: () => panel.disposed || !request.isCurrent(),
      onResult: (outcome) => {
        if (this.current() !== panel) return
        panel.outcome = outcome
        panel.phase = 'ready'
        this.change(panel)
      },
    })
    return {
      isDisposed: () => panel.disposed,
      setLoading: () => {
        if (this.current() !== panel) return
        panel.phase = 'loading'
        panel.pending = ''
        panel.notice = undefined
        this.change(panel)
      },
      setPending: (message) => {
        if (this.current() !== panel) return
        panel.phase = 'pending'
        panel.pending = message
        panel.notice = undefined
        this.change(panel)
      },
      setStatus: (outcome, notice) => {
        if (this.current() !== panel) return
        panel.outcome = outcome
        panel.notice = notice
        panel.phase = 'ready'
        panel.pending = ''
        panel.page = 'menu'
        panel.zone = 'list'
        this.change(panel)
      },
      close: () => {
        if (panel.disposed) return
        panel.disposed = true
        if (this.panel === panel) {
          this.panel = undefined
          this.targets.clear()
          this.render()
        }
      },
    }
  }

  /** Synchronous local retirement: no write cancellation and no render IO. */
  retire(): void {
    if (this.panel !== undefined) this.panel.disposed = true
    this.panel = undefined
    this.targets.clear()
  }

  isOpen(): boolean {
    return this.current() !== undefined
  }

  /** A modal seat took the layer: the next committed frame invalidates receivers. */
  suspend(): void {
    if (!this.suspended) {
      this.suspended = true
      if (this.panel !== undefined) this.panel.revision++
      this.targets.clear()
    }
  }

  desiredFocusId(): string | undefined {
    return this.targets.keys().next().value
  }

  private change(panel: WebAccessPickerPanel): void {
    panel.revision++
    if (this.panel === panel && !panel.disposed) this.render()
  }

  private close(panel: WebAccessPickerPanel): void {
    panel.disposed = true
    if (this.panel === panel) {
      this.panel = undefined
      this.targets.clear()
      this.render()
    }
  }

  private enterReading(panel: WebAccessPickerPanel): void {
    panel.readerEpoch += 1
    panel.page = 'details'
    panel.zone = 'list'
    this.change(panel)
  }

  private back(panel: WebAccessPickerPanel): void {
    panel.page = 'menu'
    panel.zone = 'list'
    this.change(panel)
  }

  /**
   * The ONE admission point for every key and click: a stale frame, another
   * panel, a modal seat, a superseded request or an admitted action can never
   * change this panel's state or reach a writer.
   */
  private act(panel: WebAccessPickerPanel, revision: number, intent: WebAccessPickerIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    if (intent.kind === 'close') {
      this.close(panel)
      return
    }
    if (panel.phase === 'pending') return
    if (panel.page === 'details') {
      switch (intent.kind) {
        case 'back':
          this.back(panel)
          return
        case 'reader-scroll':
          if (this.readerBodyId !== undefined) this.nativeScroll(this.readerBodyId, intent.step)
          return
        default:
          return
      }
    }
    if (panel.phase === 'loading') return
    if (intent.kind === 'action-focus') {
      const next = stepActionFocus(panel, intent.delta)
      if (next === undefined) return
      panel.actionFocus = next
      this.change(panel)
      return
    }
    if (intent.kind === 'activate-action') {
      const focused = focusedAction(panel)
      if (focused === undefined) return
      this.runAction(panel, focused.id)
      return
    }
    if (intent.kind === 'run-action') {
      this.runAction(panel, intent.base)
      return
    }
    switch (intent.kind) {
      case 'browse-row':
        // ONLY the Details entry is selectable: the status row is a disabled
        // fact, never a target.
        if (intent.rowId !== DETAILS_ROW) return
        panel.selected = intent.rowId
        // A row click moves the keyboard back onto the list, so the footer's
        // previously focused entry can never own the next Enter.
        panel.zone = 'list'
        this.change(panel)
        return
      case 'open-details':
        this.enterReading(panel)
        return
      case 'zone':
        panel.zone = offeredActions(panel).length === 0 ? 'list' : intent.zone
        this.change(panel)
        return
      default:
        return
    }
  }

  /** Forward ONE explicit business intent to the command (never a direct write). */
  private runAction(panel: WebAccessPickerPanel, base: string): void {
    if (base === FRAME_FREE_ACTION) {
      this.close(panel)
      return
    }
    if (!actionEnabled(panel, base)) return
    panel.request.act(base as WebAccessActionId)
  }

  /** True when this owner consumed the key. */
  handleKey(key: Key): boolean {
    const panel = this.current()
    if (panel === undefined) return false
    if (key.ctrl === true && key.name === 'c') return false
    if (!this.canInteract()) return true
    const intent = keyIntent(panel, key)
    if (intent !== undefined) this.act(panel, panel.revision, intent)
    return true
  }

  handleEvent(event: TspEvent): boolean {
    const target = 'id' in event && typeof event.id === 'string'
      ? this.targets.get(event.id)
      : undefined
    if (target === undefined) return false
    if (event.ev === 'select' || event.ev === 'activate') {
      if (event.item !== undefined) {
        const intent = rowIntent(target.panel, event.item, event.ev)
        if (intent !== undefined) this.act(target.panel, target.revision, intent)
      }
      return true
    }
    if (event.ev !== 'action') return false
    const intent = actionIntent(target.panel, event.act)
    if (intent !== undefined) this.act(target.panel, target.revision, intent)
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
    const layer = webPickerLayer(panel, intent => () => this.act(panel, revision, intent))
    // Every node of the layer belongs to this panel, so an event naming ANY node
    // of the CURRENT frame is routed here; a node from an earlier frame is
    // absent and never routed. The SAME walk records the Reading body's real
    // wire id, so a native scroll can only address THIS frame's body.
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        this.targets.set(node.id, { panel, revision })
        const key = node.props['key']
        if (typeof key === 'string' && key.startsWith(WEB_READING_BODY_KEY_PREFIX)) this.readerBodyId = node.id
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }
}
