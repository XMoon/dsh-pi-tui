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
import { View, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import type {
  ModelPresentation,
  ModelPickerDirectory,
  ModelPickerHandle,
  ModelPickerRequest,
} from '../../app/command/model-presentation.ts'
import { PROVIDER_DEFAULT, projectModelDirectory } from '../pickers/model-directory.ts'
import { actionIntent, keyIntent, rowIntent, type ModelPickerIntent } from './model-picker-intents.ts'
import {
  detailCursor,
  detailFactItems,
  draftedEffort,
  focusedAction,
  highlightedModel,
  modelChoices,
  modelRowId,
  moreCursor,
  secondaryActions,
  seedDrafts,
  selectionOf,
  stripChips,
  stepActionFocus,
  visibleModels,
  widePreviewFits,
  type ModelPickerPanel,
} from './model-picker-state.ts'
import { modelPickerLayer } from './model-picker-view.ts'

export class TspModelPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: ModelPresentation['notify']
  private panel: ModelPickerPanel | undefined
  private serial = 0
  /** The current frame's event targets: node id -> the revision it was built
   *  for. An event whose id is absent (a retired frame) is never routed. */
  private targets = new Map<string, { panel: ModelPickerPanel; revision: number }>()
  private cols = 120
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: ModelPresentation['notify']
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
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
      scope: undefined,
      query: '',
      cursor: 0,
      selected: undefined,
      factCursor: 0,
      moreCursor: 0,
      actionFocus: undefined,
      previousZone: undefined,
      previousPage: undefined,
      notice: '',
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
    // A scope whose provider vanished from the new read must not filter every
    // row away: fall back to the every-provider scope (`undefined`).
    if (panel.scope !== undefined
      && !projection.models.some((row) => row.providerId === panel.scope)) {
      panel.scope = undefined
    }
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

  resize(cols: number): void {
    this.cols = cols
    // A width flip re-lays the SAME panel (the browse state and every draft
    // survive it); `change` keeps the page coherent with the new layout.
    if (this.panel !== undefined) this.change(this.panel)
  }

  /**
   * Whether the side preview presents the WHOLE details card and every effort.
   * When it cannot, the wide SHELL is kept and only the current model's full
   * details/effort move into the drill-down pages (`paged`).
   */
  private previewFull(panel: ModelPickerPanel): boolean {
    return this.wide() && widePreviewFits(panel, highlightedModel(panel))
  }

  /** True whenever the details/effort live in the drill-down pages: always at
   *  compact width, and at wide width when the preview cannot hold them. */
  private paged(panel: ModelPickerPanel): boolean {
    return !this.previewFull(panel)
  }

  /** The frozen `cols >= 120` rule for the wide shell (scopes + list + details). */
  private wide(): boolean {
    return this.cols >= 120
  }

  /**
   * Keep the visible page and the keyboard zone in agreement.
   *
   * The wide layout's effort selector is the preview pane (the inline radio
   * rows) while the compact layout renders exactly the zone the keyboard is in;
   * on top of that the effort PAGE is reachable in every layout, because the
   * environment's font/zoom can change what the wide column really shows (the
   * Owner's drill-down path). Without the compact direction a width flip would
   * leave the keyboard in an invisible effort zone, so ↑↓ would change a draft
   * the user cannot see.
   */
  private normalize(panel: ModelPickerPanel): void {
    // The effort SELECTOR exists only while the highlighted model advertises
    // efforts: a re-read that drops the metadata (or a vanished selection) leaves
    // no selector, so the ZONE, the visible PAGE and every return target fall
    // back to the model list instead of pointing at a missing preview pane or an
    // empty effort page.
    if (modelChoices(highlightedModel(panel)).length === 0) {
      if (panel.zone === 'effort') panel.zone = 'models'
      if (panel.page === 'effort') panel.page = 'models'
      if (panel.previousZone === 'effort') panel.previousZone = 'models'
      if (panel.previousPage === 'effort') panel.previousPage = undefined
    }
    // The details page is ALWAYS reachable (the action-first column shows a
    // clamped identity; the complete content is the page) and so is the effort
    // page (the same picker list, the same draft) — see `pickerActions`.
    //
    // The page follows the keyboard ZONE for the effort page in EVERY layout: it
    // is the same picker list everywhere and the Owner's always-available
    // drill-down, so leaving the effort zone for the model list (Shift+Tab, or
    // Tab from the action bar) must leave the page too — otherwise the keyboard
    // sits in the model zone while an effort page is painted, its arrows do
    // nothing and Esc closes instead of going back. Only the DERIVED entry (Enter
    // on the model list) depends on the paged layout: with the rows inline the
    // wide column IS the selector and Enter must not flip the page.
    if (panel.zone === 'models' && panel.page === 'effort') panel.page = 'models'
    // The strip zone exists only while the model list's strip really carries its
    // chip: a phase that drops the chip (loading, an admitted write, a failed
    // read) must not leave the keyboard focused on a region that is not painted.
    if (panel.zone === 'strip' && stripChips(panel).length === 0) panel.zone = 'models'
    if (!this.paged(panel)) return
    if (panel.zone === 'effort' && panel.page !== 'effort') panel.page = 'effort'
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

  /** Keep the highlight on a row the current query/scope can actually reach. */
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
      const activated = actionIntent(panel, focused, undefined)
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
      case 'fact-cursor': {
        // The details page's inert fact rows: the cursor only keeps the native
        // list scrolled to the row being read. It never writes.
        const cursorRow = highlightedModel(panel)
        if (cursorRow === undefined || panel.page !== 'details') return
        const wide = this.wide()
        const count = detailFactItems(panel, cursorRow, wide).length
        if (count === 0) return
        panel.factCursor = (detailCursor(panel, cursorRow, wide) + intent.delta + count) % count
        this.change(panel)
        return
      }
      case 'more-cursor': {
        // The More page's rows are actions, not facts: the cursor only decides
        // which secondary operation Enter will run. It never writes.
        const count = secondaryActions(panel).length
        if (count === 0 || panel.page !== 'more') return
        panel.moreCursor = (moreCursor(panel) + intent.delta + count) % count
        this.change(panel)
        return
      }
      case 'activate-more': {
        // Enter on the More page runs the SELECTED secondary operation through
        // the same admission as its own row/bar activation — and, since none of
        // them is the `apply` action, it can never write.
        if (panel.page !== 'more') return
        const action = secondaryActions(panel)[moreCursor(panel)]
        if (action === undefined) return
        const activated = actionIntent(panel, action.id, undefined)
        if (activated !== undefined) this.act(panel, panel.revision, activated)
        return
      }
      case 'retry':
        this.retry(panel)
        return
      case 'zone':
        // Remember where the action bar was entered FROM: Esc must return there
        // rather than re-deriving a zone (a details page's Primary would
        // otherwise teleport the user into the effort selector).
        if (intent.zone === 'primary-action') {
          panel.previousZone = panel.zone
          // The frozen third zone always starts on the Primary Action.
          panel.actionFocus = 'apply'
        }
        // Remember the PAGE the effort selector was opened from (its compact Esc
        // returns there), and let an explicit return page win over the derived one.
        if (intent.zone === 'effort' && panel.page !== 'effort') panel.previousPage = panel.page
        panel.zone = intent.zone
        // An EXPLICIT page always wins: the details page's `All effort levels…`
        // action opens the effort page, which is the drill-down path that keeps
        // every candidate reachable and selectable when the environment's
        // font/zoom makes the wide column's own fit unsure. The DERIVED
        // zone/page agreement below only runs where the pages are what carries
        // the details/effort at all (compact width, or a wide column the budget
        // cannot fill). The wide shell itself (scopes + list + details column)
        // never collapses because of its content.
        if (intent.page !== undefined) panel.page = intent.page
        else if (this.paged(panel)) {
          if (intent.zone === 'effort') panel.page = 'effort'
          else if (intent.zone === 'models') panel.page = 'models'
        }
        this.change(panel)
        return
      case 'page':
        panel.page = intent.page
        panel.zone = 'models'
        this.change(panel)
        return
      case 'scope': {
        // A provider filter changes BROWSE only: it never touches authority and
        // never discards another model's draft. `undefined` is the every-provider
        // scope entry (it filters nothing); any other value must be a provider the
        // current read actually advertises. Only the model LIST page carries a
        // scope column, so a scope action arriving on a drill-down page (a stale
        // or hostile receiver) fails closed instead of filtering a page that has
        // no way to show or clear it.
        if (panel.page !== 'models') return
        const providerIds = new Set(panel.rows.map((row) => row.providerId))
        if (intent.scope !== undefined && !providerIds.has(intent.scope)) return
        panel.scope = intent.scope
        this.align(panel)
        this.change(panel)
        return
      }
      case 'browse-model': {
        if (!visibleModels(panel).some((row) => modelRowId(row) === intent.rowId)) return
        panel.selected = intent.rowId
        this.change(panel)
        return
      }
      case 'browse-effort': {
        const row = highlightedModel(panel)
        if (row === undefined) return
        if (!modelChoices(row).some((choice) => choice.value === intent.value)) return
        panel.efforts.set(modelRowId(row), intent.value)
        // Acting in the effort area makes it the keyboard zone as well: the
        // visible focus and the K2 zone must never disagree.
        panel.zone = 'effort'
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
        panel.phase = 'ready'
        panel.page = 'models'
        panel.zone = 'models'
        panel.notice = `${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}.`
        this.change(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        panel.phase = 'ready'
        panel.page = 'models'
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
        const intent = rowIntent(target.panel, event.item)
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
    const panel = this.current()
    if (panel === undefined) return undefined
    if (this.suspended) {
      this.suspended = false
      panel.revision++
    }
    const revision = panel.revision
    const layer = modelPickerLayer(panel, {
      wide: this.wide(),
      preview: this.previewFull(panel),
      bind: (intent) => () => this.act(panel, revision, intent),
    })
    // Every node in the model layer belongs to this panel, so an event whose
    // `id` is ANY node of the frame (the picker, its scope column, a row) is
    // routed here; a node from an earlier frame is absent and never routed.
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
