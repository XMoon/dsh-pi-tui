/**
 * The native TSP `/acp` presentation (PO-5E): ONE `ui.picker` page plus one
 * read-only Details Reading in the renderer's ONE layer.
 *
 * It owns NO business authority — every status read and enable/disable call
 * stays in the command. Only one panel's local presentation state (phase, page,
 * zone, highlight, reading epoch, notice) and its event admission live here.
 *
 * Frozen page contract: the menu is ONE `ui.picker` (`size:'md'`, `preview:'none'`)
 * whose first row is the DISABLED `Status: …` fact and whose second row is
 * `Details…`. The only write is the native footer action: `disabled` →
 * `Enable ACP`; `enabled` → `Disable ACP`; `changing`/`unavailable`/unreadable →
 * `Close`. `Details…` REPLACES the picker with a read-only native overlay in the
 * same layer; `Esc` and the first `← Back to ACP · Esc` row both return.
 *
 * Footer action ids carry the frame revision and every node is indexed per
 * committed frame, so an event from a retired frame or panel is refused at the
 * ONE admission point.
 *
 * @module tui/tsp/acp-access-picker
 */

import { View, span, ui, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import type { PickerAction, PickerItem, PickerProps } from '@stencil-hq/tern'
import type {
  AcpAccessActionId,
  AcpAccessMenuHandle,
  AcpAccessNotice,
  AcpAccessPresentation,
  AcpAccessReadOutcome,
  AcpAccessRequest,
} from '../../app/command/acp-access-presentation.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

type Phase = 'loading' | 'ready' | 'pending'
type Page = 'menu' | 'details'
type Zone = 'list' | 'actions'

interface Panel {
  readonly serial: number
  readonly request: AcpAccessRequest
  revision: number
  disposed: boolean
  phase: Phase
  page: Page
  zone: Zone
  outcome: AcpAccessReadOutcome | undefined
  pending: string
  notice: AcpAccessNotice | undefined
  selected: string
  actionFocus: string | undefined
  readerEpoch: number
}

/** The ONE admission point receives this, never a direct writer call. */
type Intent =
  | { readonly k: 'close' }
  | { readonly k: 'back' }
  | { readonly k: 'scroll'; readonly step: ScrollTo }
  | { readonly k: 'browse'; readonly row: string }
  | { readonly k: 'details' }
  | { readonly k: 'zone'; readonly zone: Zone }
  | { readonly k: 'focus'; readonly delta: -1 | 1 }
  | { readonly k: 'activate' }
  | { readonly k: 'run'; readonly base: string }

const STATUS_ROW = 'acp-status'
const NOTICE_ROW = 'acp-notice'
const DETAILS_ROW = 'acp-details'
const CLOSE = 'close'
const TOKEN = '#'
/** The reading body key the presenter resolves its scroll target from. */
export const ACP_READING_BODY_KEY_PREFIX = 'acp-reading-body-'

/** The menu's browsable rows (the status row is always a disabled fact). */
const menuRows = (panel: Panel): string[] => panel.notice === undefined
  ? [STATUS_ROW, DETAILS_ROW]
  : [STATUS_ROW, NOTICE_ROW, DETAILS_ROW]

export function acpAccessStatusLabel(outcome: AcpAccessReadOutcome | undefined): string {
  if (outcome === undefined) return 'Status: loading…'
  if (outcome.kind === 'unavailable') return 'Status: unavailable (connection)'
  return `Status: ${outcome.status.state}`
}

export function acpAccessStatusDetail(outcome: AcpAccessReadOutcome | undefined): string {
  if (outcome === undefined) return 'Reading the Host ACP listener state.'
  if (outcome.kind === 'unavailable') return `The Host ACP status could not be read: ${outcome.message}`
  switch (outcome.status.state) {
    case 'disabled':
      return 'The local ACP v1 listener is not bound on this Host.'
    case 'enabled':
      return "The local ACP v1 listener is bound on this Host's Unix socket."
    case 'changing':
      return 'An ACP enable/disable request is still running; wait for it to settle.'
    case 'unavailable':
      return `The Host cannot report a healthy ACP listener: ${outcome.status.reason}`
  }
}

/** The footer operations the CURRENT state admits: at most one write. */
function actions(panel: Panel): ReadonlyArray<readonly [string, string]> {
  if (panel.phase !== 'ready' || panel.page === 'details') return panel.page === 'details' ? [] : [[CLOSE, 'Close']]
  if (panel.outcome?.kind !== 'status') return [[CLOSE, 'Close']]
  switch (panel.outcome.status.state) {
    case 'disabled': return [['enable', 'Enable ACP']]
    case 'enabled': return [['disable', 'Disable ACP']]
    case 'changing':
    case 'unavailable': return [[CLOSE, 'Close']]
  }
}

/** The CURRENT frame's wire id for one action base. */
const wired = (panel: Panel, base: string): string => base === CLOSE ? base : `${base}${TOKEN}${panel.revision}`

/** The action base an id names, or `undefined` for a stale/foreign id. */
function baseOf(panel: Panel, id: string): string | undefined {
  if (id === CLOSE) return id
  const at = id.lastIndexOf(TOKEN)
  if (at <= 0) return undefined
  return id.slice(at + 1) === String(panel.revision) ? id.slice(0, at) : undefined
}

/** The index of the focused footer entry (first admitted one by default). */
function focusIndex(panel: Panel): number {
  const offered = actions(panel)
  const at = offered.findIndex(([base]) => base === panel.actionFocus)
  return at < 0 ? 0 : at
}

function menuPicker(panel: Panel): Node {
  const items: PickerItem[] = [
    {
      id: STATUS_ROW,
      label: sanitizedPhysicalLine(acpAccessStatusLabel(panel.outcome)),
      disabled: true,
      detail: sanitizedPhysicalLine(acpAccessStatusDetail(panel.outcome)),
    },
    ...(panel.notice === undefined ? [] : [{
      id: NOTICE_ROW,
      label: sanitizedPhysicalLine(panel.notice.message),
      disabled: true as const,
      ...(panel.notice.kind === 'error' ? { dot: 'error' as const } : {}),
      detail: panel.notice.kind === 'error' ? 'The action failed; the Host state below is the truth.' : 'Action result.',
    }]),
    { id: DETAILS_ROW, label: 'Details…', detail: 'Host, current state and the limits of the local ACP listener.' },
  ]
  const offered = actions(panel)
  const focused = panel.zone === 'actions' ? offered[focusIndex(panel)]?.[0] : undefined
  const rendered: PickerAction[] = offered.map(([base, label]) => ({
    id: wired(panel, base),
    label: base === focused ? `${label} [Enter]` : label,
    ...(base === CLOSE ? {} : { primary: true }),
  }))
  const props: PickerProps & { readonly key: string } = {
    key: `acp-picker-${panel.serial}`,
    title: 'ACP Server',
    noun: 'ACP option',
    layout: 'rows',
    size: 'md',
    preview: 'none',
    items,
    order: menuRows(panel),
    total: items.length,
    selected: panel.selected,
    focus: 'list',
    state: panel.phase === 'loading' ? 'loading' : 'ready',
    ...(panel.phase === 'pending' ? { message: sanitizedPhysicalLine(panel.pending) } : {}),
    actions: rendered,
  }
  return ui.picker(props)
}

/* --------------------------------------------------------------- reading */

const scopeOf = (panel: Panel): string => `${panel.serial}-${panel.readerEpoch}`
const bodyOf = (panel: Panel): string => `${ACP_READING_BODY_KEY_PREFIX}${scopeOf(panel)}`

function facts(panel: Panel): ReadonlyArray<readonly [string, string]> {
  return [
    ['Host', 'Local Split Host (same OS user; no TCP/HTTP)'],
    ['Status', acpAccessStatusDetail(panel.outcome)],
    ['Enable / Disable', "Serve or retire this Host's local ACP listener."],
    ['Auto-start', 'Settings → General → Start ACP automatically applies on the next Host start.'],
    ['Sessions', 'Closing an ACP View detaches it; it does not end Host sessions or TUI work.'],
  ]
}

function detailsLayer(panel: Panel, bind: (intent: Intent) => () => void): Node {
  const scope = scopeOf(panel)
  return ui.overlay(
    { key: `acp-details-${scope}`, head: 'ACP Server · Details', size: 'lg', modal: true },
    ui.row(
      { key: `acp-details-back-${scope}`, onClick: bind({ k: 'back' }) },
      ui.text({ key: `acp-details-back-label-${scope}`, spans: [span('← Back to ACP', 'accent'), span(' · Esc', 'muted')] }),
    ),
    ui.col(
      { key: bodyOf(panel), gap: 'xs' },
      ...facts(panel).flatMap(([label, value]) => [
        ui.text(span(label, 'muted')),
        ui.text({
          key: `acp-fact-${scope}-${label.toLowerCase().replace(/[^a-z]+/gu, '-')}`,
          text: sanitizeDisplayText(value),
          wrap: 'word',
        }),
      ]),
    ),
  )
}

/* ---------------------------------------------------------------- intents */

function keyIntent(panel: Panel, key: Key): Intent | undefined {
  if (key.ctrl === true && key.name === 'c') return undefined
  if (key.name === 'escape') return panel.page === 'details' ? { k: 'back' } : { k: 'close' }
  if (panel.phase !== 'ready') return undefined
  if (panel.page === 'details') {
    const step: ScrollTo | undefined = key.name === 'up' ? 'line-up'
      : key.name === 'down' ? 'line-down'
        : key.name === 'page_up' ? 'page-up'
          : key.name === 'page_down' ? 'page-down'
            : key.name === 'home' ? 'start'
              : key.name === 'end' ? 'end'
                : undefined
    if (step !== undefined) return { k: 'scroll', step }
    return key.name === 'enter' ? { k: 'back' } : undefined
  }
  if (key.name === 'tab') {
    const zone: Zone = actions(panel).length === 0 || panel.zone === 'actions' ? 'list' : 'actions'
    return { k: 'zone', zone }
  }
  if (panel.zone === 'actions') {
    if (key.name === 'left' || key.name === 'up') return { k: 'focus', delta: -1 }
    if (key.name === 'right' || key.name === 'down') return { k: 'focus', delta: 1 }
    return key.name === 'enter' ? { k: 'activate' } : undefined
  }
  // Only `Details…` is selectable; the status row is a disabled fact.
  if (key.name === 'enter' && panel.selected === DETAILS_ROW) return { k: 'details' }
  return undefined
}

function rowIntent(panel: Panel, item: string, kind: 'select' | 'activate'): Intent | undefined {
  if (panel.page !== 'menu') return undefined
  if (item === DETAILS_ROW) return kind === 'activate' ? { k: 'details' } : { k: 'browse', row: item }
  return item === STATUS_ROW && kind === 'select' ? { k: 'browse', row: item } : undefined
}

function actionIntent(panel: Panel, act: string): Intent | undefined {
  if (act === CLOSE) return { k: 'close' }
  if (panel.page !== 'menu') return undefined
  const base = baseOf(panel, act)
  if (base === undefined || !actions(panel).some(([offered]) => offered === base)) return undefined
  return { k: 'run', base }
}

/* --------------------------------------------------------------- presenter */

export class TspAcpAccessPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: AcpAccessPresentation['notify']
  private readonly nativeScroll: (id: string, to: ScrollTo) => void
  private panel: Panel | undefined
  private serial = 0
  /** The CURRENT frame's event targets (node id -> the revision it was built for). */
  private targets = new Map<string, { readonly panel: Panel; readonly revision: number }>()
  private readerBodyId: string | undefined
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: AcpAccessPresentation['notify']
    nativeScroll(id: string, to: ScrollTo): void
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
    this.nativeScroll = deps.nativeScroll
  }

  readonly presentation: AcpAccessPresentation = {
    open: request => this.open(request),
    notify: (message, kind) => { this.notify(message, kind) },
  }

  private current(): Panel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.disposed) return undefined
    if (!panel.request.isCurrent()) {
      this.retire()
      return undefined
    }
    return panel
  }

  private open(request: AcpAccessRequest): AcpAccessMenuHandle {
    this.retire()
    const panel: Panel = {
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
    request.runOwned('acp status', () => request.readStatus(), {
      isCancellation: () => panel.disposed || !request.isCurrent(),
      onResult: (outcome) => {
        if (this.current() !== panel) return
        panel.outcome = outcome
        panel.phase = 'ready'
        this.change(panel)
      },
    })
    const handle = (): AcpAccessMenuHandle => ({
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
    })
    return handle()
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

  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    if (this.panel !== undefined) this.panel.revision++
    this.targets.clear()
  }

  desiredFocusId(): string | undefined {
    return this.targets.keys().next().value
  }

  private change(panel: Panel): void {
    panel.revision++
    if (this.panel === panel && !panel.disposed) this.render()
  }

  private close(panel: Panel): void {
    panel.disposed = true
    if (this.panel === panel) {
      this.panel = undefined
      this.targets.clear()
      this.render()
    }
  }

  /**
   * The ONE admission point for keys/clicks: a stale frame, another panel, a
   * modal seat, a superseded request or an admitted action can never change
   * this panel's state or reach a writer.
   */
  private act(panel: Panel, revision: number, intent: Intent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    if (intent.k === 'close') {
      this.close(panel)
      return
    }
    if (panel.phase === 'pending') return
    if (panel.page === 'details') {
      if (intent.k === 'back') {
        panel.page = 'menu'
        panel.zone = 'list'
        this.change(panel)
      } else if (intent.k === 'scroll' && this.readerBodyId !== undefined) {
        this.nativeScroll(this.readerBodyId, intent.step)
      }
      return
    }
    if (panel.phase !== 'ready') return
    switch (intent.k) {
      case 'focus': {
        const offered = actions(panel)
        if (offered.length === 0) return
        panel.actionFocus = offered[(focusIndex(panel) + intent.delta + offered.length) % offered.length]![0]
        this.change(panel)
        return
      }
      case 'activate': {
        const base = actions(panel)[focusIndex(panel)]?.[0]
        if (base !== undefined) this.run(panel, base)
        return
      }
      case 'run':
        this.run(panel, intent.base)
        return
      case 'browse':
        if (intent.row !== DETAILS_ROW && intent.row !== STATUS_ROW) return
        panel.selected = intent.row
        panel.zone = 'list'
        this.change(panel)
        return
      case 'details':
        panel.readerEpoch += 1
        panel.page = 'details'
        panel.zone = 'list'
        this.change(panel)
        return
      case 'zone':
        panel.zone = actions(panel).length === 0 ? 'list' : intent.zone
        this.change(panel)
        return
      default:
        return
    }
  }

  private run(panel: Panel, base: string): void {
    if (base === CLOSE) {
      this.close(panel)
      return
    }
    if (!actions(panel).some(([offered]) => offered === base)) return
    panel.request.act(base as AcpAccessActionId)
  }

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
    const target = 'id' in event && typeof event.id === 'string' ? this.targets.get(event.id) : undefined
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
    const layer = ui.col(
      { key: `acp-layer-${panel.serial}` },
      panel.page === 'details' ? detailsLayer(panel, intent => () => this.act(panel, revision, intent)) : menuPicker(panel),
    )
    // Index EVERY node of the committed frame: an event naming a current-frame
    // node routes here, while an id from an earlier frame is absent. The SAME
    // walk records the reading body's real wire id for native scroll.
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        this.targets.set(node.id, { panel, revision })
        const key = node.props['key']
        if (typeof key === 'string' && key.startsWith(ACP_READING_BODY_KEY_PREFIX)) this.readerBodyId = node.id
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }
}
