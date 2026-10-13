/** The native TSP `/model` presentation: panel lifecycle, interaction
 * admission and coordination.
 *
 * It owns NO business authority: every read, write and default-intent owner
 * stays in the existing command. This class owns one panel's local browse
 * state (query, highlight, per-model effort drafts, page, K2 zone, revision)
 * and the admission that decides whether a key/click may touch it.
 *
 * The pure parts live beside it: `model-picker-state` (state + selectors),
 * `model-picker-intents` (key/event -> intent) and `model-picker-view`
 * (intent-bound node construction).
 * @module tui/tsp/model-picker
 */
import { View, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import type {
  ModelPresentation,
  ModelPickerDirectory,
  ModelPickerHandle,
  ModelPickerRequest,
} from '../../app/command/model-presentation.ts'
import { PROVIDER_DEFAULT, projectModelDirectory } from '../pickers/model-directory.ts'
import { actionIntent, keyIntent, rowIntent, type ModelPickerIntent } from './model-picker-intents.ts'
import {
  FAILURE_RETRY_ID,
  OVERVIEW_DETAILS_ID,
  applyOffered,
  draftedEffort,
  effortValue,
  focusedAction,
  highlightedModel,
  modelChoices,
  modelRowId,
  overviewCursorIndex,
  overviewItems,
  seedDrafts,
  selectionOf,
  stepActionFocus,
  visibleModels,
  wideCatalog,
  type ModelPickerPanel,
} from './model-picker-state.ts'
import { MODEL_DETAILS_BODY_KEY_PREFIX, modelPickerLayer } from './model-picker-view.ts'

export class TspModelPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: ModelPresentation['notify']
  /** The ONE Surface owner's native scroll op, addressed by a wire id of the
   *  frame this presenter built. The presenter never owns a Surface. */
  private readonly nativeScroll: (id: string, to: ScrollTo) => void
  private panel: ModelPickerPanel | undefined
  private serial = 0
  /** The current frame's event targets: node id -> the revision it was built
   *  for. An event whose id is absent (a retired frame) is never routed. */
  private targets = new Map<string, { panel: ModelPickerPanel; revision: number }>()
  /** The wire id of the Reader's scrollable body in the frame last built, when
   *  that frame carries one: resolved from the SDK's OWN id assignment (never a
   *  guessed path) while the frame is indexed for event routing. Its key carries
   *  the frame's serial/revision, so a retired frame's id is never reused. */
  private readerBodyId: string | undefined
  private cols = 120
  private cellWidth = 8
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: ModelPresentation['notify']
    nativeScroll(id: string, to: ScrollTo): void
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
    this.nativeScroll = deps.nativeScroll
  }

  readonly presentation: ModelPresentation = {
    open: (request) => this.open(request),
    notify: (message, kind) => {
      this.notify(message, kind)
    },
  }

  private current(): ModelPickerPanel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.disposed) return undefined
    if (!panel.request.isCurrent()) {
      this.retire()
      return undefined
    }
    return panel
  }

  private open(request: ModelPickerRequest): ModelPickerHandle {
    this.retire()
    const panel: ModelPickerPanel = {
      serial: ++this.serial,
      request,
      revision: 0,
      disposed: false,
      phase: 'loading',
      page: 'models',
      zone: 'models',
      query: '',
      cursor: 0,
      selected: undefined,
      actionFocus: undefined,
      previousZone: undefined,
      notice: '',
      directory: undefined,
      rows: [],
      failures: [],
      overviewCursor: 0,
      efforts: new Map(),
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
      setDirectory: (directory) => {
        if (this.current() !== panel) return
        this.hydrate(panel, directory)
      },
    }
  }

  /** Adopt one authoritative directory read: re-project the rows, keep every
   *  draft whose value is still advertised, and never keep a highlight the new
   *  catalogue cannot reach. */
  private hydrate(panel: ModelPickerPanel, directory: ModelPickerDirectory): void {
    const projection = projectModelDirectory(
      directory.directory,
      directory.current,
      panel.request.subject.sessionless,
    )
    panel.directory = directory
    panel.rows = projection.models
    panel.failures = projection.failures
    panel.efforts = seedDrafts(projection.models, panel.efforts)
    if (panel.selected === undefined) {
      const configured = panel.rows.find(
        (row) => (panel.request.subject.sessionless ? row.isDefault : row.isCurrent),
      )
      panel.selected = configured === undefined ? undefined : modelRowId(configured)
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

  resize(cols: number, cellWidth: number): void {
    this.cols = cols
    this.cellWidth = cellWidth
    // A width flip re-lays the SAME panel (the browse state, the page and every
    // draft survive it); `change` keeps the visible page and zone coherent with
    // the new layout.
    if (this.panel !== undefined) this.change(this.panel)
  }

  /**
   * Whether this pane paints the `lg` catalogue sheet and its compact read-only
   * summary ({@link wideCatalog}): the ONE layout threshold of this presenter,
   * reconstructed from the only geometry the SDK reports (`cols` + the cell
   * width). It decides informational chrome only — never what can be reached,
   * drafted or written.
   */
  private wide(): boolean {
    return wideCatalog(this.cols, this.cellWidth)
  }

  /**
   * Keep the visible page and the keyboard zone in agreement with what the
   * current read really offers.
   *
   * A model that vanished from the read leaves every content page meaningless
   * (the Overview and the Full details page both describe ONE model), so the
   * panel falls back to the catalogue. The action bar is the only other zone and
   * is painted in every phase, so it never has to be left.
   */
  private normalize(panel: ModelPickerPanel): void {
    const row = highlightedModel(panel)
    if (row === undefined) {
      panel.page = 'models'
      if (panel.zone !== 'primary-action') panel.zone = 'models'
      panel.overviewCursor = 0
      return
    }
  }

  /** A modal seat took the layer: the next committed frame invalidates every
   *  receiver bound to the current one (the model layer is not even rendered). */
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

  /** Keep the highlight on a row the current query can actually reach. */
  private align(panel: ModelPickerPanel): void {
    if (highlightedModel(panel) !== undefined) return
    const first = visibleModels(panel)[0]
    panel.selected = first === undefined ? undefined : modelRowId(first)
  }

  private change(panel: ModelPickerPanel): void {
    this.normalize(panel)
    panel.revision++
    if (this.panel === panel && !panel.disposed) this.render()
  }

  private close(panel: ModelPickerPanel): void {
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
  private act(panel: ModelPickerPanel, revision: number, intent: ModelPickerIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    if (intent.kind === 'close') {
      this.close(panel)
      return
    }
    // The READ-ONLY Reader's own view operations are pure VIEW navigation: its
    // visible `Back` row (and the `Esc` that is the same intent) and its scroll
    // keys change no draft, start no read and write nothing, so a merely running
    // or failed read must never leave the visible Back row dead. An ADMITTED
    // WRITE still owns the panel: nothing navigates or scrolls under it.
    if (panel.page === 'details' && panel.phase !== 'pending') {
      if (intent.kind === 'back') {
        // The Overview's own details entry is the Reader's ONLY origin, so its
        // `Back` (and the `Esc` that is the same intent) returns there.
        panel.page = 'overview'
        panel.zone = 'models'
        this.change(panel)
        return
      }
      if (intent.kind === 'reader-scroll') {
        if (this.readerBodyId !== undefined) this.nativeScroll(this.readerBodyId, intent.step)
        return
      }
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
    // The action bar's own mechanics are phase-agnostic: the bar is rendered in
    // every phase and the FOCUSED action decides what Enter runs.
    if (intent.kind === 'action-focus') {
      panel.actionFocus = stepActionFocus(panel, intent.delta)
      this.change(panel)
      return
    }
    if (intent.kind === 'activate-action') {
      const focused = focusedAction(panel).id
      const activated = actionIntent(panel, focused)
      if (activated !== undefined) this.act(panel, panel.revision, activated)
      return
    }
    if (panel.phase === 'error') {
      // The visible primary action IS Retry while the directory read failed.
      if (intent.kind === 'apply' || intent.kind === 'retry') {
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
      case 'back': {
        // Back and Esc are the same intent for a content page: the Overview
        // returns to the catalogue. (The read-only Reader's own Back was already
        // handled above, where it is exempt from the phase gates; reaching this
        // case with `page === 'details'` would mean an admitted write, which the
        // gate above has already refused.)
        if (panel.page === 'overview') {
          panel.page = 'models'
          panel.zone = 'models'
          this.change(panel)
          return
        }
        return
      }
      case 'open-overview': {
        // Only the catalogue opens an Overview, and the row it names must be a
        // REAL visible row: the selection is committed atomically with the page
        // change, so the page can never describe the previously highlighted
        // model.
        if (panel.page !== 'models') return
        if (intent.rowId !== undefined) {
          if (!visibleModels(panel).some((row) => modelRowId(row) === intent.rowId)) return
          panel.selected = intent.rowId
        }
        if (highlightedModel(panel) === undefined) return
        panel.page = 'overview'
        panel.zone = 'models'
        panel.overviewCursor = 0
        this.change(panel)
        return
      }
      case 'overview-cursor': {
        // The Overview's cursor is a ROW position over the page's real rows
        // (the effort section, its candidates and the details entry). Moving it
        // changes no draft and never writes.
        if (panel.page !== 'overview') return
        const count = overviewItems(panel).length
        if (count === 0) return
        panel.overviewCursor = (overviewCursorIndex(panel) + intent.delta + count) % count
        this.change(panel)
        return
      }
      case 'overview-select': {
        // A pointer row activation is validated against the page's REAL rows and
        // then acts by ROW ID, never by the previous cursor. The section head only
        // moves the cursor; an effort row drafts (and only a value the model
        // really advertises); the details row opens the read-only page.
        if (panel.page !== 'overview') return
        const index = overviewItems(panel).findIndex((row) => row.id === intent.item)
        if (index < 0) return
        panel.overviewCursor = index
        if (intent.item === OVERVIEW_DETAILS_ID) {
          panel.page = 'details'
          panel.zone = 'models'
        } else {
          const value = effortValue(intent.item)
          const row = highlightedModel(panel)
          if (value !== undefined && row !== undefined
            && modelChoices(row).some((choice) => choice.value === value)) {
            panel.efforts.set(modelRowId(row), value)
          }
        }
        this.change(panel)
        return
      }
      case 'activate-overview': {
        // Enter acts on the row the cursor is REALLY on — the same admission the
        // pointer uses, so the two can never resolve different rows.
        if (panel.page !== 'overview') return
        const item = overviewItems(panel)[overviewCursorIndex(panel)]?.id
        if (item === undefined) return
        this.act(panel, panel.revision, { kind: 'overview-select', item })
        return
      }
      case 'retry':
        this.retry(panel)
        return
      case 'zone': {
        // Remember where the action bar was entered FROM: Esc must return there
        // rather than re-deriving a region.
        if (intent.zone === 'primary-action') {
          panel.previousZone = panel.zone
          // The frozen third zone always starts on the Primary Action.
          panel.actionFocus = 'apply'
        }
        panel.zone = intent.zone
        this.change(panel)
        return
      }
      case 'browse-model': {
        // The cursor walks the rows the list really offers: every visible model,
        // plus the ONE partial-failure retry row (see `catalogueCursorIds`). The
        // client keeps a disabled row selectable, so the app is what refuses every
        // other shape here.
        const known = visibleModels(panel).some((row) => modelRowId(row) === intent.rowId)
          || (intent.rowId === FAILURE_RETRY_ID && panel.failures.length > 0)
        if (!known) return
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
        if (!applyOffered(panel)) return
        this.apply(panel)
        return
      default:
        return
    }
  }

  /** Re-enter loading and ask the command's ONE read owner for the directory
   *  again. The loading frame is committed BEFORE the re-entrant callback. */
  private retry(panel: ModelPickerPanel): void {
    panel.phase = 'loading'
    panel.notice = ''
    this.change(panel)
    panel.request.retry()
  }

  private apply(panel: ModelPickerPanel): void {
    const row = highlightedModel(panel)
    if (row === undefined) return
    const choices = modelChoices(row)
    const draft = draftedEffort(panel, row)
    // A stale/undrafted effort can never be submitted as if it were advertised.
    if (choices.length > 0 && !choices.some((choice) => choice.value === draft)) return
    const selection = selectionOf(row, draft, PROVIDER_DEFAULT)
    panel.notice = ''
    panel.phase = 'pending'
    // Keep the visible Primary Action highlighted while the write settles.
    panel.previousZone = panel.zone
    panel.zone = 'primary-action'
    panel.actionFocus = 'apply'
    this.change(panel)
    panel.request.runOwned('model selection', () => panel.request.apply(selection), {
      isCancellation: () => panel.disposed,
      onResult: (outcome) => {
        if (this.current() !== panel || outcome === 'superseded') return
        if (outcome === 'committed' || outcome === 'indeterminate') {
          this.close(panel)
          return
        }
        // A refusal leaves the SAME page usable with its draft intact (the
        // Overview still shows the model the user was working on) and parks the
        // keyboard back on the list, so a second Enter cannot repeat the write.
        panel.phase = 'ready'
        panel.zone = 'models'
        panel.notice = `${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}.`
        this.change(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        panel.phase = 'ready'
        panel.zone = 'models'
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
    const layer = modelPickerLayer(panel, {
      wide: this.wide(),
      bind: (intent) => () => this.act(panel, revision, intent),
    })
    // Every node in the model layer belongs to this panel, so an event whose
    // `id` is ANY node of the frame (the picker, its summary, a row) is routed
    // here; a node from an earlier frame is absent and never routed.
    // The SAME walk records the Reader body's real wire id — the id the SDK
    // assigned this frame — so the native scroll op can only ever address a node
    // this frame really built.
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        this.targets.set(node.id, { panel, revision })
        const key = node.props['key']
        if (typeof key === 'string' && key.startsWith(MODEL_DETAILS_BODY_KEY_PREFIX)) {
          this.readerBodyId = node.id
        }
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }
}
