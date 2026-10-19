/** The native TSP `/preset` presentation: panel lifecycle, interaction admission
 *  and coordination.
 *
 * It owns NO business authority: every read, write and default-config owner stays in
 * the existing command. This class owns one panel's local browse state (query,
 * highlight, page, reading epoch, footer zone, revision) and the admission that
 * decides whether a key/click may touch it.
 *
 * The pure parts live beside it: `preset-picker-state` (state + selectors + action
 * availability), `preset-picker-intents` (key/event -> intent) and
 * `preset-picker-view` (intent-bound node construction).
 * @module tui/tsp/preset-picker
 */
import { View, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import type {
  PresetPresentation,
  PresetPickerHandle,
  PresetPickerRequest,
  PresetPickerRoster,
} from '../../app/command/preset-presentation.ts'
import {
  actionIntent,
  focusedIntent,
  keyIntent,
  rowIntent,
  type PresetPickerIntent,
} from './preset-picker-intents.ts'
import {
  actionEnabled,
  highlightedRow,
  stepActionFocus,
  visibleRows,
  type PresetPickerPanel,
} from './preset-picker-state.ts'
import { PRESET_READING_BODY_KEY_PREFIX, presetPickerLayer } from './preset-picker-view.ts'

export class TspPresetPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: PresetPresentation['notify']
  /** The ONE Surface owner's native scroll op, addressed by a wire id of the frame
   *  this presenter built. The presenter never owns a Surface. */
  private readonly nativeScroll: (id: string, to: ScrollTo) => void
  private panel: PresetPickerPanel | undefined
  private serial = 0
  /** The current frame's event targets: node id -> the revision it was built for. An
   *  event whose id is absent (a retired frame) is never routed. */
  private targets = new Map<string, { panel: PresetPickerPanel; revision: number }>()
  /** The wire id of the Details page's scrollable body in the frame last built, when
   *  that frame carries one: resolved from the SDK's OWN id assignment (never a guessed
   *  path) while the frame is indexed for event routing. Its key carries the panel
   *  serial and the reading's epoch, so a retired reading's id is never reused. */
  private readerBodyId: string | undefined
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: PresetPresentation['notify']
    nativeScroll(id: string, to: ScrollTo): void
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
    this.nativeScroll = deps.nativeScroll
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
      page: 'catalog',
      zone: 'list',
      pending: undefined,
      selected: undefined,
      actionFocus: undefined,
      readerEpoch: 0,
      notice: '',
      roster: undefined,
      query: '',
      cursor: 0,
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

  /** Adopt one authoritative roster read: re-project the cards, keep the browse target
   *  only while the new read can still reach it and never keep a reading page the new
   *  read can no longer fill. */
  private hydrate(panel: PresetPickerPanel, roster: PresetPickerRoster): void {
    panel.roster = roster
    // The browse target is initialized from the REAL committed facts (the live
    // Session first, then the run-local pending, then the effective default) — never
    // from a Web-shaped "selected" flag.
    if (panel.selected === undefined) {
      panel.selected = roster.currentId ?? roster.pendingId ?? roster.defaultId
    }
    panel.phase = 'ready'
    panel.notice = ''
    this.align(panel)
    this.change(panel)
  }

  /** Synchronous local retirement: no write cancellation and no render IO. The
   *  renderer's hydration/disposal frame owns the next repaint. */
  retire(): void {
    if (this.panel !== undefined) this.panel.disposed = true
    this.panel = undefined
    this.targets.clear()
  }

  isOpen(): boolean {
    return this.current() !== undefined
  }

  /** A modal seat took the layer: the next committed frame invalidates every receiver
   *  bound to the current one (the preset layer is not even rendered). */
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

  /** Keep the browse target on a card the current query can actually reach. */
  private align(panel: PresetPickerPanel): void {
    if (highlightedRow(panel) !== undefined) return
    panel.selected = visibleRows(panel)[0]?.id
  }

  /**
   * Keep the visible page coherent with what the current read really offers.
   *
   * The Details page describes ONE preset: once that preset is gone from the read the
   * page is meaningless, so the panel falls back to the catalogue (which keeps the
   * query and re-aligns the browse target on the next frame).
   */
  private normalize(panel: PresetPickerPanel): void {
    if (panel.page === 'catalog') return
    if (highlightedRow(panel) !== undefined) return
    panel.page = 'catalog'
    panel.zone = 'list'
  }

  private change(panel: PresetPickerPanel): void {
    this.normalize(panel)
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

  /** Enter the Details page. Every entry is a NEW reading, so it gets its own
   *  epoch: a `scroll` op queued by the previous one can never address this
   *  page's body. The page paints no footer and no zone: it is read-only. */
  private enterReading(panel: PresetPickerPanel): void {
    panel.readerEpoch += 1
    panel.page = 'details'
    panel.zone = 'list'
    this.change(panel)
  }

  /** Leave the Details page for the catalogue, keeping the query and the browse
   *  target: one Back, one Esc, one return. */
  private back(panel: PresetPickerPanel): void {
    panel.page = 'catalog'
    panel.zone = 'list'
    this.change(panel)
  }

  /**
   * The ONE admission point for every key and click. It runs BEFORE any mutation: a
   * stale frame, another panel, a modal seat, a superseded subject or an admitted write
   * can never change this panel's state.
   */
  private act(panel: PresetPickerPanel, revision: number, intent: PresetPickerIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    if (intent.kind === 'close') {
      this.close(panel)
      return
    }
    // An admitted write owns the panel: nothing navigates, scrolls or re-writes it.
    if (panel.phase === 'pending') return
    // The Details page's own operations: `Back` and the body scroll are pure VIEW
    // navigation/reading (they change no draft, start no read and write nothing), so a
    // merely running or failed read never leaves them dead.
    if (panel.page === 'details') {
      switch (intent.kind) {
        case 'back':
          this.back(panel)
          return
        case 'reader-scroll':
          // The op names the body the CURRENT frame really built; a queued op from
          // an earlier reading addresses a retired id and is refused by its epoch.
          if (this.readerBodyId !== undefined) this.nativeScroll(this.readerBodyId, intent.step)
          return
        case 'action-focus':
        case 'activate-action':
        case 'apply':
        case 'save-default':
          // The reading page paints no footer: any write-shaped intent that reaches
          // this page's admission is refused here (its ids were never rendered).
          if (intent.kind === 'activate-action') this.back(panel)
          return
        default:
          return
      }
    }
    // A running (re-)read still admits the search box and this panel's close (handled
    // above); nothing else, and in particular no write.
    if (panel.phase === 'loading') {
      if (intent.kind !== 'query') return
      panel.query = intent.query
      panel.cursor = intent.cursor
      this.change(panel)
      return
    }
    // The footer's own mechanics are phase-agnostic: it is rendered in every
    // catalogue phase and the FOCUSED entry decides what Enter runs.
    if (intent.kind === 'action-focus') {
      panel.actionFocus = stepActionFocus(panel, intent.delta)
      this.change(panel)
      return
    }
    if (intent.kind === 'activate-action') {
      const activated = focusedIntent(panel)
      if (activated !== undefined) this.act(panel, panel.revision, activated)
      return
    }
    if (panel.phase === 'error') {
      // The visible primary entry IS Retry while the roster read failed. The
      // search box STAYS live (its editing intent and the Esc ladder — F1: an
      // error phase must be able to clear a non-empty query before closing).
      if (intent.kind === 'apply' || intent.kind === 'save-default') return
      if (intent.kind === 'retry') {
        this.retry(panel)
        return
      }
      if (intent.kind === 'query') {
        panel.query = intent.query
        panel.cursor = intent.cursor
        this.change(panel)
        return
      }
      // K2 still has to reach that entry from the keyboard: Tab (zone) only.
      if (intent.kind === 'zone') {
        panel.zone = intent.zone
        this.change(panel)
      }
      return
    }
    switch (intent.kind) {
      case 'open-details': {
        if (panel.page !== 'catalog') return
        // A card event names the row it really belongs to: committing it ATOMICALLY
        // with the page change is what stops the Details page from describing the
        // previously highlighted preset.
        if (intent.rowId !== undefined) {
          if (!visibleRows(panel).some((row) => row.id === intent.rowId)) return
          panel.selected = intent.rowId
        }
        if (highlightedRow(panel) === undefined) return
        this.enterReading(panel)
        return
      }
      case 'retry':
        if (actionEnabled(panel, 'retry')) this.retry(panel)
        return
      case 'zone':
        panel.zone = intent.zone
        this.change(panel)
        return
      case 'browse-row': {
        if (!visibleRows(panel).some((row) => row.id === intent.rowId)) return
        panel.selected = intent.rowId
        // Selecting a card is a LIST interaction, so the keyboard follows it
        // (sibling fix from the Model picker): otherwise the footer entry that was
        // focused before the click keeps owning Enter — the user highlights a card
        // with the mouse, presses Enter to open its Details, and the PREVIOUS
        // focus (`Use`/`Set default`) writes instead. Browse can never stay in the
        // `actions` zone.
        panel.zone = 'list'
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
        // A synthetic/pointer event can name any action id; the ONE admission consumes
        // the SAME enabled decision the footer renders, so a disabled entry can never
        // write even when its id reaches this entry point.
        if (actionEnabled(panel, 'use')) this.apply(panel)
        return
      case 'save-default':
        if (actionEnabled(panel, 'set-default')) this.saveDefault(panel)
        return
      default:
        return
    }
  }

  /** Re-enter loading and ask the command's ONE read owner for the roster again. The
   *  loading frame is committed BEFORE the re-entrant callback. */
  private retry(panel: PresetPickerPanel): void {
    panel.phase = 'loading'
    panel.notice = ''
    this.change(panel)
    panel.request.retry()
  }

  /**
   * Restore the panel after a KNOWN refusal or an unexpected raise.
   *
   * The page the operation was admitted FROM is preserved — always the catalogue,
   * whose footer is the only writer — with its target intact, so the user can read
   * the reason and choose again; the Host stays the final authority on every retry.
   */
  private restoreAfterRefusal(panel: PresetPickerPanel, notice: string): void {
    panel.phase = 'ready'
    panel.pending = undefined
    panel.page = 'catalog'
    panel.zone = 'list'
    panel.notice = notice
    this.change(panel)
  }

  /** Commit the browse target through the ORIGINAL session-preset write. */
  private apply(panel: PresetPickerPanel): void {
    const row = highlightedRow(panel)
    if (row === undefined || row.broken !== undefined) return
    panel.notice = ''
    panel.pending = 'use'
    panel.phase = 'pending'
    panel.zone = 'actions'
    panel.actionFocus = 'use'
    this.change(panel)
    panel.request.runOwned('preset selection', () => panel.request.apply(row.id), {
      isCancellation: () => panel.disposed,
      onResult: (outcome) => {
        if (this.current() !== panel || outcome.kind === 'superseded') return
        // A staged/committed switch and a true indeterminate settle all dismiss the
        // panel: the authoritative display reconciles from the Host, and the command
        // has already notified the outcome.
        if (outcome.kind === 'pending' || outcome.kind === 'switched' || outcome.kind === 'indeterminate') {
          this.close(panel)
          return
        }
        this.restoreAfterRefusal(
          panel,
          outcome.kind === 'locked'
            ? 'Locked: this session has already started.'
            : outcome.message,
        )
      },
      onError: () => {
        if (this.current() !== panel) return
        this.restoreAfterRefusal(panel, 'Failed.')
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
    panel.zone = 'actions'
    panel.actionFocus = 'set-default'
    this.change(panel)
    panel.request.runOwned('preset default', () => panel.request.setDefault(row.id), {
      isCancellation: () => panel.disposed,
      onResult: (outcome) => {
        if (this.current() !== panel || outcome.kind === 'superseded') return
        // `saved` AND `unconfirmed` both dismiss the panel: a settings write that raised
        // proves neither commit nor rollback, so the next read — not this panel's
        // snapshot — is authoritative. The command already notified.
        this.close(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        this.restoreAfterRefusal(panel, 'Failed.')
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
    const layer = presetPickerLayer(panel, {
      bind: (intent) => () => this.act(panel, revision, intent),
    })
    // Every node in the preset layer belongs to this panel, so an event whose `id` is ANY
    // node of the frame (the picker, a card, a footer entry, the Back row) is routed
    // here; a node from an earlier frame is absent and never routed. The SAME walk
    // records the reading body's real wire id — the id the SDK assigned this frame — so a
    // native scroll op can only ever address a node this frame really built.
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        this.targets.set(node.id, { panel, revision })
        const key = node.props['key']
        if (typeof key === 'string' && key.startsWith(PRESET_READING_BODY_KEY_PREFIX)) {
          this.readerBodyId = node.id
        }
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }
}
