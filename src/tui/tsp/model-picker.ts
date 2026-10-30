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
  retryRowOffered,
  applyOffered,
  draftedEffort,
  focusedAction,
  highlightedModel,
  modelChoices,
  modelRowId,
  seedDrafts,
  selectionOf,
  stepActionFocus,
  stripOffered,
  visibleModels,
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
      notice: undefined,
      readerEpoch: 0,
      directory: undefined,
      rows: [],
      failures: [],
      efforts: new Map(),
    }
    this.panel = panel
    this.change(panel)
    return {
      isDisposed: () => panel.disposed,
      setLoading: () => {
        if (this.current() !== panel) return
        panel.phase = 'loading'
        panel.notice = undefined
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
        panel.notice = { text: message, tone: 'error' }
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
    const firstHydration = panel.directory === undefined
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
    panel.notice = undefined
    // PR-C (TSP-7): an `effort` opener lands the FIRST hydrated catalogue on
    // its Reasoning Effort strip — the same editor the `models` entry reaches
    // through Tab, never a second page or a second writer. It happens only on
    // the FIRST successful read (a Retry/re-read never repeats it), and only
    // when the configured/current row really advertises candidates: a model
    // without effort metadata keeps the catalogue and states the reason in a
    // notice instead of guessing a value. The panel's `normalize` (below)
    // re-checks `stripOffered`, so a first read whose highlight carries no
    // candidates simply stays on the list.
    if (firstHydration && panel.request.entry === 'effort') {
      const row = highlightedModel(panel)
      if (row !== undefined && modelChoices(row).length > 0 && stripOffered(panel)) {
        panel.zone = 'strip'
      } else {
        panel.notice = { text: 'Reasoning effort is unavailable for this model', tone: 'muted' }
      }
    }
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
   * Keep the visible page and the keyboard zone in agreement with what the
   * current read really offers.
   *
   * A model that vanished from the read leaves the Full details page meaningless
   * (it describes ONE model), so the panel falls back to the catalogue. The action bar is the only other zone and
   * is painted in every phase, so it never has to be left.
   */
  private normalize(panel: ModelPickerPanel): void {
    const row = highlightedModel(panel)
    if (row === undefined) {
      panel.page = 'models'
      if (panel.zone !== 'primary-action') panel.zone = 'models'
      return
    }
    // The strip exists only while the CATALOGUE really paints it: a page change, a
    // phase that can no longer draft (an admitted write, a running re-read, a failed
    // one), a re-read that dropped the model's effort metadata, or a highlight that
    // moved to such a model must never leave the keyboard on a region that is not on
    // screen.
    if (panel.zone === 'strip' && !stripOffered(panel)) panel.zone = 'models'
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
        // A catalogue row activation is the Reader's ONLY origin, so its `Back`
        // (and the `Esc` that is the same intent) returns to the catalogue.
        panel.page = 'models'
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
        return
      }
      // `Esc`'s ladder still applies in a failed read: the ONE query operation this phase
      // admits is the CLEAR that `Esc` performs, so the key is never swallowed (a filter typed
      // while the read ran survives the failure and must be clearable). Opening the search box
      // for arbitrary edits is NOT part of it — an ordinary key never reaches the query case
      // below in this phase.
      if (intent.kind !== 'query' || intent.query !== '') return
      panel.query = ''
      panel.cursor = 0
      this.change(panel)
      return
    }
    switch (intent.kind) {
      case 'open-details': {
        panel.readerEpoch += 1
        // A catalogue row activation (`activate`, a double click, or `Enter`) opens
        // that model's read-only Full details DIRECTLY: there is no intermediate
        // page. The row it names must be a REAL visible one — the selection is
        // committed atomically with the page change, so the Reader can never
        // describe the previously highlighted model.
        if (panel.page !== 'models') return
        if (intent.rowId !== undefined) {
          if (!visibleModels(panel).some((row) => modelRowId(row) === intent.rowId)) return
          panel.selected = intent.rowId
        }
        if (highlightedModel(panel) === undefined) return
        panel.page = 'details'
        panel.zone = 'models'
        this.change(panel)
        return
      }
      case 'retry':
        this.retry(panel)
        return
      case 'zone': {
        // The frozen third zone always starts on the Primary Action.
        if (intent.zone === 'primary-action') panel.actionFocus = 'apply'
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
          || (intent.rowId === FAILURE_RETRY_ID && retryRowOffered(panel))
        if (!known) return
        panel.selected = intent.rowId
        // Selecting a row is a LIST interaction, so the keyboard follows it: otherwise the
        // zone that was live before the click keeps owning the keys — the user highlights a
        // model with the mouse while their next ↑/↓ edits the PREVIOUS model's effort draft
        // (or walks the action bar) without ever seeing the highlight move.
        panel.zone = 'models'
        this.change(panel)
        return
      }
      case 'browse-effort': {
        // The catalogue's strip: a candidate only ever moves the LOCAL draft of the
        // model it belongs to, and acting on the strip makes it the keyboard zone as
        // well, so the visible state and the K2 zone can never disagree.
        const row = highlightedModel(panel)
        if (row === undefined) return
        if (!modelChoices(row).some((choice) => choice.value === intent.value)) return
        panel.efforts.set(modelRowId(row), intent.value)
        if (panel.page === 'models' && stripOffered(panel)) panel.zone = 'strip'
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
    panel.notice = undefined
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
    panel.notice = undefined
    panel.phase = 'pending'
    // Keep the visible Primary Action highlighted while the write settles.
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
        // catalogue still shows the model the user was working on) and parks the
        // keyboard back on the list, so a second Enter cannot repeat the write.
        panel.phase = 'ready'
        panel.zone = 'models'
        // A cancellation is information; a refusal (or an unsupported write) is a
        // failure. The notice says which, so the Reader can ink it correctly.
        panel.notice = {
          text: `${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}.`,
          tone: outcome === 'cancelled' ? 'muted' : 'error',
        }
        this.change(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        panel.phase = 'ready'
        panel.zone = 'models'
        panel.notice = { text: 'Failed.', tone: 'error' }
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
    const intent = actionIntent(target.panel, event.act, event.value)
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
      paneWidth: this.cols * this.cellWidth,
      bind: (intent) => () => this.act(panel, revision, intent),
    })
    // Every node in the model layer belongs to this panel, so an event whose
    // `id` is ANY node of the frame (the picker, a row, an action) is routed
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
