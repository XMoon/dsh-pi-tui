/** The native TSP `/preset` presentation: panel lifecycle, interaction
 * admission and coordination.
 *
 * It owns NO business authority: every read, write and default-config owner
 * stays in the existing command. This class owns one panel's local browse state
 * (query, highlight, page, K2 zone, revision) and the admission that decides
 * whether a key/click may touch it.
 *
 * The pure parts live beside it: `preset-picker-state` (state + selectors),
 * `preset-picker-intents` (key/event -> intent) and `preset-picker-view`
 * (node construction).
 * @module tui/tsp/preset-picker
 */
import { View, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import type {
  PresetPresentation,
  PresetPickerHandle,
  PresetPickerRequest,
  PresetPickerRoster,
} from '../../app/command/preset-presentation.ts'
import { actionIntent, keyIntent, rowIntent, type PresetPickerIntent } from './preset-picker-intents.ts'
import {
  detailFactItems,
  focusedAction,
  highlightedRow,
  stepActionFocus,
  visibleRows,
  type PresetPickerPanel,
} from './preset-picker-state.ts'
import { presetPickerLayer } from './preset-picker-view.ts'

export class TspPresetPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: PresetPresentation['notify']
  private panel: PresetPickerPanel | undefined
  private serial = 0
  /** The current frame's event targets: node id -> the revision it was built
   *  for. An event whose id is absent (a retired frame) is never routed. */
  private targets = new Map<string, { panel: PresetPickerPanel; revision: number }>()
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: PresetPresentation['notify']
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
  }

  readonly presentation: PresetPresentation = {
    open: (request) => this.open(request),
    notify: (message, kind) => {
      this.notify(message, kind)
    },
  }

  private current(): PresetPickerPanel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.disposed) return undefined
    if (!panel.request.isCurrent()) {
      this.retire()
      return undefined
    }
    return panel
  }

  private open(request: PresetPickerRequest): PresetPickerHandle {
    this.retire()
    const panel: PresetPickerPanel = {
      serial: ++this.serial,
      request,
      revision: 0,
      disposed: false,
      phase: 'loading',
      page: 'presets',
      zone: 'list',
      pending: undefined,
      selected: undefined,
      actionFocus: undefined,
      previousZone: undefined,
      notice: '',
      roster: undefined,
      query: '',
      cursor: 0,
      factCursor: 0,
    }
    this.panel = panel
    this.change(panel)
    return {
      isDisposed: () => panel.disposed,
      setLoading: () => {
        if (this.current() !== panel) return
        panel.phase = 'loading'
        panel.notice = ''
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
      setLoadError: (message) => {
        if (this.current() !== panel) return
        panel.phase = 'error'
        panel.notice = message
        this.change(panel)
      },
      setRoster: (roster) => {
        if (this.current() !== panel) return
        this.hydrate(panel, roster)
      },
    }
  }

  /** Adopt one authoritative roster read: re-project the rows, keep the browse
   *  target only while the new read can still reach it, and never keep a page
   *  the new read cannot fill. */
  private hydrate(panel: PresetPickerPanel, roster: PresetPickerRoster): void {
    panel.roster = roster
    // The browse target is initialized from the REAL committed facts (the live
    // Session first, then the run-local pending, then the effective default) —
    // never from a Web-shaped "selected" flag.
    if (panel.selected === undefined) {
      panel.selected = roster.currentId ?? roster.pendingId ?? roster.defaultId
    }
    panel.phase = 'ready'
    panel.notice = ''
    this.align(panel)
    this.change(panel)
  }

  /** Synchronous local retirement: no write cancellation and no render IO.
   *  The renderer's hydration/disposal frame owns the next repaint. */
  retire(): void {
    if (this.panel !== undefined) this.panel.disposed = true
    this.panel = undefined
    this.targets.clear()
  }

  isOpen(): boolean {
    return this.current() !== undefined
  }

  /** A modal seat took the layer: the next committed frame invalidates every
   * receiver bound to the current one (the preset layer is not even rendered). */
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

  /** Keep the browse target on a row the current query can actually reach. */
  private align(panel: PresetPickerPanel): void {
    if (highlightedRow(panel) !== undefined) return
    panel.selected = visibleRows(panel)[0]?.id
  }

  private change(panel: PresetPickerPanel): void {
    panel.revision++
    if (this.panel === panel && !panel.disposed) this.render()
  }

  private close(panel: PresetPickerPanel): void {
    panel.disposed = true
    if (this.panel === panel) {
      this.panel = undefined
      this.targets.clear()
      this.render()
    }
  }

  /**
   * The ONE admission point for every key and click. It runs BEFORE any
   * mutation: a stale frame, another panel, a modal seat, a superseded subject
   * or an admitted write can never change this panel's state.
   */
  private act(panel: PresetPickerPanel, revision: number, intent: PresetPickerIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    if (intent.kind === 'close') {
      this.close(panel)
      return
    }
    // An admitted write owns the panel: nothing may browse or re-write it.
    if (panel.phase === 'pending') return
    // A running (re-)read still admits the search box and this panel's close
    // (handled above); nothing else, and in particular no write.
    if (panel.phase === 'loading') {
      if (intent.kind !== 'query') return
      panel.query = intent.query
      panel.cursor = intent.cursor
      this.change(panel)
      return
    }
    // The action bar's own mechanics are phase-agnostic.
    if (intent.kind === 'action-focus') {
      panel.actionFocus = stepActionFocus(panel, intent.delta)
      this.change(panel)
      return
    }
    if (intent.kind === 'activate-action') {
      const activated = actionIntent(focusedAction(panel).id)
      if (activated !== undefined) this.act(panel, panel.revision, activated)
      return
    }
    if (panel.phase === 'error') {
      // The visible primary action IS Retry while the roster read failed.
      if (intent.kind === 'apply' || intent.kind === 'save-default') return
      if (intent.kind === 'retry') {
        this.retry(panel)
        return
      }
      // K2 still has to reach that action from the keyboard: Tab (zone) only.
      if (intent.kind === 'zone') {
        panel.zone = intent.zone
        this.change(panel)
      }
      return
    }
    switch (intent.kind) {
      case 'fact-cursor': {
        // The details page's inert fact rows: the cursor only keeps the native
        // list scrolled to the row being read. It never writes.
        const row = highlightedRow(panel)
        if (row === undefined || panel.page !== 'details') return
        const count = detailFactItems(panel, row).length
        if (count === 0) return
        panel.factCursor = (panel.factCursor + intent.delta + count) % count
        this.change(panel)
        return
      }
      case 'retry':
        this.retry(panel)
        return
      case 'zone':
        // Remember where the action bar was entered FROM: Esc must return there
        // rather than re-deriving a zone.
        if (intent.zone === 'actions') panel.previousZone = panel.zone
        panel.zone = intent.zone
        this.change(panel)
        return
      case 'page':
        panel.page = intent.page
        panel.zone = 'list'
        this.change(panel)
        return
      case 'browse-row': {
        if (!visibleRows(panel).some((row) => row.id === intent.rowId)) return
        panel.selected = intent.rowId
        this.change(panel)
        return
      }
      case 'query':
        panel.query = intent.query
        panel.cursor = intent.cursor
        this.align(panel)
        this.change(panel)
        return
      case 'apply':
        this.apply(panel)
        return
      case 'save-default':
        this.saveDefault(panel)
        return
      default:
        return
    }
  }

  /** Re-enter loading and ask the command's ONE read owner for the roster
   *  again. The loading frame is committed BEFORE the re-entrant callback. */
  private retry(panel: PresetPickerPanel): void {
    panel.phase = 'loading'
    panel.notice = ''
    this.change(panel)
    panel.request.retry()
  }

  /** Commit the browse target through the ORIGINAL session-preset write. */
  private apply(panel: PresetPickerPanel): void {
    const row = highlightedRow(panel)
    if (row === undefined || row.broken !== undefined) return
    panel.notice = ''
    panel.pending = 'use'
    panel.phase = 'pending'
    panel.previousZone = panel.zone
    panel.zone = 'actions'
    panel.actionFocus = 'use'
    this.change(panel)
    panel.request.runOwned('preset selection', () => panel.request.apply(row.id), {
      isCancellation: () => panel.disposed,
      onResult: (outcome) => {
        if (this.current() !== panel || outcome.kind === 'superseded') return
        // A staged/committed switch and a true indeterminate settle all dismiss
        // the panel: the authoritative display reconciles from the Host, and the
        // command has already notified the outcome.
        if (outcome.kind === 'pending' || outcome.kind === 'switched' || outcome.kind === 'indeterminate') {
          this.close(panel)
          return
        }
        // A KNOWN refusal keeps the picker usable so the user can choose another
        // target (the Host stays the final authority on every retry).
        panel.phase = 'ready'
        panel.pending = undefined
        panel.page = 'presets'
        panel.zone = 'list'
        panel.notice = outcome.kind === 'locked'
          ? 'Locked: this session has already started.'
          : outcome.message
        this.change(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        panel.phase = 'ready'
        panel.pending = undefined
        panel.page = 'presets'
        panel.zone = 'list'
        panel.notice = 'Failed.'
        this.change(panel)
      },
    })
  }

  /** Commit a new-session default through the ORIGINAL config writer. */
  private saveDefault(panel: PresetPickerPanel): void {
    const row = highlightedRow(panel)
    if (row === undefined || row.broken !== undefined) return
    panel.notice = ''
    panel.pending = 'default'
    panel.phase = 'pending'
    panel.previousZone = panel.zone
    panel.zone = 'actions'
    panel.actionFocus = 'set-default'
    this.change(panel)
    panel.request.runOwned('preset default', () => panel.request.setDefault(row.id), {
      isCancellation: () => panel.disposed,
      onResult: (outcome) => {
        if (this.current() !== panel || outcome.kind === 'superseded') return
        // `saved` AND `unconfirmed` both dismiss the panel: a settings write that
        // raised proves neither commit nor rollback, so the next read — not this
        // panel's snapshot — is authoritative. The command already notified.
        this.close(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        panel.phase = 'ready'
        panel.pending = undefined
        panel.zone = 'list'
        panel.notice = 'Failed.'
        this.change(panel)
      },
    })
  }

  /** True when this owner consumed the key (the composer must not see it). */
  handleKey(key: Key): boolean {
    const panel = this.current()
    if (panel === undefined) return false
    // Ctrl+C always belongs to the original application cancel owner.
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
        const intent = rowIntent(target.panel, event.item)
        if (intent !== undefined) this.act(target.panel, target.revision, intent)
      }
      return true
    }
    if (event.ev !== 'action') return false
    const intent = actionIntent(event.act)
    if (intent !== undefined) this.act(target.panel, target.revision, intent)
    return true
  }

  renderLayer(): Node | undefined {
    this.targets.clear()
    const panel = this.current()
    if (panel === undefined) return undefined
    if (this.suspended) {
      this.suspended = false
      panel.revision++
    }
    const revision = panel.revision
    const layer = presetPickerLayer(panel)
    // Every node in the preset layer belongs to this panel, so an event whose
    // `id` is ANY node of the frame is routed here; a node from an earlier frame
    // is absent and never routed.
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        this.targets.set(node.id, { panel, revision })
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }
}
