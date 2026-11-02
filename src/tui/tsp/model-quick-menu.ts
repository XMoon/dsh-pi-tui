/** The TSP Quiet Composer's anchored Model / Reasoning Effort quick menu.
 *
 * ONE temporary presentation panel of the mounted renderer, beside the full
 * `/model` picker and never a fifth business Presenter: it holds only this
 * frame's browse state (page, query, highlight, zone, phase) and turns a click
 * or a key into ONE intent that runs through the request the registered
 * `/model` command handed it. Every read, write, default-intent, scope and
 * currentness owner stays inside that command: this module calls
 * `request.apply` / `request.retry` / `request.runOwned` and nothing else, and
 * it never reads a catalog, never derives a provider/model from a display
 * label, and never persists anything.
 *
 * The node tree is the composer view's job (`quiet-composer-view`): this module
 * produces the render-time state it paints, and resolves the real wire ids back
 * out of the frame the SDK actually assigned (never a guessed path), so focus
 * and reveal can only ever name a node this frame built.
 * @module tui/tsp/model-quick-menu
 */
import { View, type Key, type Node } from '@stencil-hq/tern'
import type {
  ModelPickerDirectory,
  ModelPickerHandle,
  ModelPickerRequest,
} from '../../app/command/model-presentation.ts'
import type { ModelSelectionDto } from '../../runtime/catalog-port.ts'
import {
  PROVIDER_DEFAULT,
  effortChoicesOf,
  initialEffortOf,
  projectModelDirectory,
  type InlineEffortChoice,
  type ModelPickerFailureRow,
  type ModelPickerModelRow,
} from '../pickers/model-directory.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { modelRowId, selectionOf } from './model-picker-state.ts'

/** The pages one panel walks: the root, the searchable model list and the
 *  current model's real effort candidates. */
export type QuickMenuPage = 'root' | 'models' | 'effort'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
export type QuickMenuPhase = 'loading' | 'ready' | 'error' | 'pending'

/** The menu-local region `Tab` moves between. `search` is the only region the
 *  hardware caret enters (a real `ui.input`); the others are app-routed, so a
 *  menu keystroke can never reach the Composer reducer. */
export type QuickMenuZone = 'back' | 'search' | 'rows' | 'footer'

/** One panel's whole local state. Nothing here survives a `retire()`, and none
 *  of it is a business fact: the committed selection stays the Session's own. */
interface QuickPanel {
  readonly serial: number
  readonly request: ModelPickerRequest
  revision: number
  disposed: boolean
  phase: QuickMenuPhase
  page: QuickMenuPage
  zone: QuickMenuZone
  query: string
  /** The search caret: a UTF-16 index snapped to a grapheme boundary, the same
   *  unit the `ui.input` caret is counted in. */
  cursor: number
  /** The menu-local highlight — a `modelRowId`, an effort candidate value, or a
   *  root token. NEVER an identity the panel persisted or a display guess. */
  highlighted: string | undefined
  directory: ModelPickerDirectory | undefined
  rows: readonly ModelPickerModelRow[]
  failures: readonly ModelPickerFailureRow[]
  notice: QuickMenuNotice | undefined
}

export interface QuickMenuNotice {
  readonly text: string
  readonly tone: 'muted' | 'error'
}

/** One selectable row of the current frame. `selected` is the authoritative
 *  current value (the view paints it as a `✓` in WORDS, never a colour alone);
 *  `highlighted` is the menu-local cursor; `intent` is what a click really
 *  does, minted with THIS frame's revision. */
export interface QuickMenuRow {
  readonly key: string
  readonly label: string
  readonly value: string | undefined
  /** A disclosure row: the view paints the `›` affordance from this fact
   *  alone, never by guessing from a label. */
  readonly chevron: boolean
  readonly selected: boolean
  readonly highlighted: boolean
  readonly intent: QuickMenuIntent
}

/** One provider group of the model page, in the directory's own order.
 *  An empty `head` paints no group line (the root and effort pages). */
export interface QuickMenuSection {
  readonly key: string
  readonly head: string
  readonly rows: readonly QuickMenuRow[]
}

/** One inert provider whose catalog read failed: read-only context that keeps
 *  every other group operable. */
export interface QuickMenuFailureLine {
  readonly key: string
  readonly label: string
  readonly detail: string
}

/** The render-time state the composer view paints. */
export interface QuickMenuRenderState {
  readonly serial: number
  readonly revision: number
  readonly page: QuickMenuPage
  readonly phase: QuickMenuPhase
  readonly query: string
  readonly cursor: number
  /** The search field's node key, so the view and the focus resolver name the
   *  same node. Stable for one panel (a per-frame key remounts the client). */
  readonly searchKey: string
  /** Whether the hardware caret belongs on the search field this frame. */
  readonly searching: boolean
  readonly back: QuickMenuRow | undefined
  readonly sections: readonly QuickMenuSection[]
  readonly failures: readonly QuickMenuFailureLine[]
  readonly notice: QuickMenuNotice | undefined
  readonly empty: string | undefined
  readonly footer: QuickMenuRow
}

/** One admitted interaction. A pointer intent carries the revision of the frame
 *  that minted it, so a delayed click can only act on the options the user
 *  actually saw; the identity it names is then re-checked against the rows the
 *  CURRENT frame offers — never a prefix, a label or a position. */
export type QuickMenuIntent =
  | { readonly kind: 'open-models'; readonly revision: number }
  | { readonly kind: 'open-effort'; readonly revision: number }
  | { readonly kind: 'back'; readonly revision: number }
  | { readonly kind: 'full'; readonly revision: number }
  | { readonly kind: 'retry'; readonly revision: number }
  | { readonly kind: 'choose-model'; readonly rowId: string; readonly revision: number }
  | { readonly kind: 'choose-effort'; readonly value: string; readonly revision: number }
  | { readonly kind: 'activate'; readonly revision: number }
  | { readonly kind: 'browse'; readonly delta: -1 | 1; readonly revision: number }
  | { readonly kind: 'tab'; readonly delta: -1 | 1; readonly revision: number }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number; readonly revision: number }
  | { readonly kind: 'close'; readonly revision: number }

/** The root page's two highlight tokens (they name neither a model nor a
 *  candidate, so no row identity can collide with them). */
const ROOT_MODEL_ROW = 'root:models'
const ROOT_EFFORT_ROW = 'root:effort'
/** The single operation row a failed read offers, in the same body ring. */
const RETRY_ROW = 'retry'
const BACK_ROW = 'back'
const FOOTER_ROW = 'full'

/* ------------------------------------------------------------ node key rules */

/**
 * The CONTAINER and search-field keys carry the panel serial only. A key that
 * changes per frame makes the SDK diff `del` + `add`, and measured on the real
 * client that remounts the subtree — which for the scroller would drop the list
 * scroll and for the search field the caret, on every repaint.
 */
const searchKeyOf = (panel: QuickPanel): string => `q${panel.serial}-search`
/**
 * The key of one OPERABLE row: panel serial + frame revision + paint token.
 *
 * The revision is what rejects a lagging pointer before the app ever sees it:
 * the SDK dispatches an event by the id of the view it LAST rendered, so an id
 * from an older frame is simply not in the current view and is dropped. A raw
 * provider/model identity never enters an HTML key — the paint token identifies
 * the row, and the intent the click carries is re-checked against the rows the
 * current frame really offers (see {@link act}), so a same-id model under a
 * different provider can never be resolved by position alone.
 */
const actionKeyOf = (panel: QuickPanel, token: string): string => `q${panel.serial}-r${panel.revision}-${token}`
const bodyKeyOf = (panel: QuickPanel, index: number): string => actionKeyOf(panel, `o${index}`)

/* ------------------------------------------------------------- local editing */

/** The grapheme boundaries of the search text (CJK/emoji/combining safe). The
 *  offsets are UTF-16 code units, the same unit the field's caret uses. */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const graphemeBounds = (text: string): number[] =>
  [...segmenter.segment(text)].map((segment) => segment.index).concat(text.length)

/** The next caret/text state for one editing key on the search field, or
 *  `undefined` when the key is not an edit. ONE source of truth for the local
 *  query: the Composer draft and its caret never enter it. */
function editQuery(
  panel: QuickPanel,
  key: Key,
): { readonly query: string; readonly cursor: number } | undefined {
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
  const typed = panel.query.slice(0, panel.cursor) + key.text
  const raw = panel.cursor + key.text.length
  return {
    query: typed + panel.query.slice(panel.cursor),
    cursor: graphemeBounds(typed).find((index) => index >= raw) ?? typed.length,
  }
}

/* ------------------------------------------------------------ pure selectors */

/** The rows the current query makes visible, in directory order. The filter is
 *  a display rule over the authoritative rows only: it never changes the
 *  offered set, its identity or its order. */
function visibleModels(panel: QuickPanel): readonly ModelPickerModelRow[] {
  const query = panel.query.toLowerCase()
  if (query === '') return panel.rows
  return panel.rows.filter((row) =>
    `${row.providerName} ${row.providerId} ${row.modelName} ${row.modelId}`.toLowerCase().includes(query),
  )
}

/** The directory row that IS the committed selection, by full (provider, model). */
function currentRow(panel: QuickPanel): ModelPickerModelRow | undefined {
  return panel.rows.find((row) => row.isCurrent)
}

/** The effort candidates of the committed model; empty means the root offers no
 *  Effort row at all (never an invented cycle). */
function currentChoices(panel: QuickPanel): readonly InlineEffortChoice[] {
  const row = currentRow(panel)
  return row === undefined ? [] : effortChoicesOf(row)
}

/** The effort the committed selection really carries: the explicit one, or the
 *  provider default when the Session names none. */
function currentEffortValue(panel: QuickPanel): string {
  const explicit = panel.directory?.current?.reasoningEffort
  return explicit === undefined ? PROVIDER_DEFAULT : explicit
}

/** The ↑/↓ ring of the CURRENT page, in paint order: the body rows, or — while
 *  the directory read failed — exactly the ONE Retry operation row. */
function bodyTokens(panel: QuickPanel): string[] {
  if (panel.phase === 'error') return [RETRY_ROW]
  if (panel.page === 'root') {
    return [ROOT_MODEL_ROW, ...(currentChoices(panel).length > 0 ? [ROOT_EFFORT_ROW] : [])]
  }
  if (panel.page === 'effort') return currentChoices(panel).map((choice) => choice.value)
  return visibleModels(panel).map(modelRowId)
}

/** Whether the current frame really offers a body row a click or Enter may act
 *  on. A running read and an admitted write offer none. */
function bodyOffered(panel: QuickPanel): boolean {
  return (panel.phase === 'ready' || panel.phase === 'error') && bodyTokens(panel).length > 0
}

/** Keep the highlight on a token the current page really offers. */
function alignHighlight(panel: QuickPanel): void {
  const tokens = bodyTokens(panel)
  if (panel.highlighted !== undefined && tokens.includes(panel.highlighted)) return
  panel.highlighted = tokens[0]
}

/** The `Tab` ring of the CURRENT page, in the order a user expects to walk it. */
function zoneRing(panel: QuickPanel): QuickMenuZone[] {
  const ring: QuickMenuZone[] = []
  if (panel.page !== 'root') ring.push('back')
  if (panel.page === 'models') ring.push('search')
  ring.push('rows', 'footer')
  return ring
}

/* ------------------------------------------------------------- the presenter */

/**
 * The renderer-local quick selector. One instance per TSP mount, at most one
 * live panel: `open()` retires any previous panel synchronously, so no older
 * read, click or write settlement can ever paint or act on the newer one.
 */
export class TspModelQuickMenu {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly setFocus: () => void
  private readonly openFull: () => void
  private readonly reveal: (id: string) => void
  private panel: QuickPanel | undefined
  private serial = 0
  /** The CURRENT frame's node-key → wire-id map, resolved from the SDK's own id
   *  assignment. A key the frame did not paint stays absent, so focus and
   *  reveal can never name a node that is not on the wire. */
  private frameIds = new Map<string, string>()
  /** Set when the highlight MOVED: only a real move may re-scroll the list. */
  private revealPending = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    /** Re-evaluate the ONE focus owner after a committed frame. */
    setFocus(): void
    /** The registered `/model` full entry (the composition root's own route). */
    openFull(): void
    /** The ONE Surface owner's reveal op, addressed by a wire id of the frame
     *  this presenter indexed. */
    reveal(id: string): void
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.setFocus = deps.setFocus
    this.openFull = deps.openFull
    this.reveal = deps.reveal
  }

  /** The live panel, or `undefined` once it is retired or its own command says
   *  it no longer owns the surface (a newer `/model`, or a moved Session). */
  private current(): QuickPanel | undefined {
    const panel = this.panel
    if (panel === undefined || panel.disposed) return undefined
    if (!panel.request.isCurrent()) {
      this.retire()
      return undefined
    }
    return panel
  }

  isOpen(): boolean {
    return this.current() !== undefined
  }

  /** Open (or replace) the panel over the request the registered command built.
   *  The previous panel's retirement and this loading frame are committed before
   *  the call returns, so a re-entrant open can never leave two panels holding
   *  the one composer seat. */
  open(request: ModelPickerRequest): ModelPickerHandle {
    this.retire()
    const panel: QuickPanel = {
      serial: ++this.serial,
      request,
      revision: 0,
      disposed: false,
      phase: 'loading',
      page: 'root',
      zone: 'rows',
      query: '',
      cursor: 0,
      highlighted: ROOT_MODEL_ROW,
      directory: undefined,
      rows: [],
      failures: [],
      notice: { text: 'Loading models…', tone: 'muted' },
    }
    this.panel = panel
    this.change(panel)
    return {
      isDisposed: () => panel.disposed,
      setLoading: () => {
        if (this.current() !== panel) return
        panel.phase = 'loading'
        panel.notice = { text: 'Loading models…', tone: 'muted' }
        this.change(panel)
      },
      setDirectory: (directory) => {
        if (this.current() !== panel) return
        this.hydrate(panel, directory)
      },
      setLoadError: (message) => {
        if (this.current() !== panel) return
        panel.phase = 'error'
        panel.notice = { text: message, tone: 'error' }
        panel.zone = 'rows'
        panel.highlighted = RETRY_ROW
        this.change(panel)
      },
      close: () => {
        this.close(panel)
      },
    }
  }

  /** Adopt one authoritative directory read. Rows keep the full (provider,
   *  model) identity, so one model id advertised by two providers stays two rows
   *  with two independent write payloads. */
  private hydrate(panel: QuickPanel, directory: ModelPickerDirectory): void {
    const projection = projectModelDirectory(
      directory.directory,
      directory.current,
      panel.request.subject.sessionless,
    )
    panel.directory = directory
    panel.rows = projection.models
    panel.failures = projection.failures
    panel.phase = 'ready'
    panel.notice = undefined
    const current = currentRow(panel)
    if (panel.page === 'effort') panel.highlighted = currentEffortValue(panel)
    else if (panel.page === 'models') panel.highlighted = current === undefined ? undefined : modelRowId(current)
    alignHighlight(panel)
    this.change(panel)
  }

  /** Synchronous local retirement: no write cancellation and no render IO — the
   *  caller's own frame owns the next repaint. */
  retire(): void {
    if (this.panel !== undefined) this.panel.disposed = true
    this.panel = undefined
    this.frameIds = new Map()
    this.revealPending = false
  }

  /** Index the frame that was just committed: map every menu node key this panel
   *  painted to the wire id the SDK assigned it, walking the same region the
   *  renderer rendered. Then reveal the followed row — but only when something
   *  really moved, so a background repaint never scrolls. */
  indexFrame(dockRoot: Node): void {
    this.frameIds = new Map()
    const panel = this.current()
    if (panel === undefined) return
    const root = View.from({ dock: dockRoot }).regions.find(region => region !== undefined)
    if (root === undefined) return
    const wanted = new Set<string>([searchKeyOf(panel), actionKeyOf(panel, FOOTER_ROW)])
    if (panel.page !== 'root') wanted.add(actionKeyOf(panel, BACK_ROW))
    bodyTokens(panel).forEach((_, index) => wanted.add(bodyKeyOf(panel, index)))
    const visit = (tree: NonNullable<typeof root>): void => {
      const key = tree.props['key']
      if (typeof key === 'string' && wanted.has(key)) this.frameIds.set(key, tree.id)
      for (const child of tree.children) visit(child)
    }
    visit(root)
    if (!this.revealPending) return
    this.revealPending = false
    const id = this.frameIds.get(this.followKey(panel))
    if (id !== undefined) this.reveal(id)
  }

  /** The node the caret or the scroll should follow on the CURRENT page. */
  private followKey(panel: QuickPanel): string {
    if (panel.zone === 'search' && panel.page === 'models') return searchKeyOf(panel)
    if (panel.zone === 'footer') return actionKeyOf(panel, FOOTER_ROW)
    if (panel.zone === 'back') return actionKeyOf(panel, BACK_ROW)
    const at = bodyTokens(panel).indexOf(panel.highlighted ?? '')
    return at < 0 ? actionKeyOf(panel, FOOTER_ROW) : bodyKeyOf(panel, at)
  }

  /** The wire id of the node that owns the hardware caret, or `undefined` when
   *  this menu owns no native caret (its keys are routed by the app). */
  desiredFocusId(): string | undefined {
    const panel = this.current()
    if (panel === undefined) return undefined
    if (panel.page !== 'models' || panel.zone !== 'search') return undefined
    return this.frameIds.get(searchKeyOf(panel))
  }

  /** The render-time state the composer view paints. Called on every frame: it
   *  reads the panel and mints intents, and mutates nothing. */
  renderState(): QuickMenuRenderState | undefined {
    const panel = this.current()
    if (panel === undefined) return undefined
    const revision = panel.revision
    const ready = panel.phase === 'ready'
    let bodyAt = -1
    const mint = (
      token: string,
      label: string,
      value: string | undefined,
      chevron: boolean,
      selected: boolean,
      intent: QuickMenuIntent,
    ): QuickMenuRow => {
      bodyAt += 1
      return {
        key: bodyKeyOf(panel, bodyAt),
        label: sanitizedPhysicalLine(label),
        value: value === undefined ? undefined : sanitizedPhysicalLine(value),
        chevron,
        selected,
        highlighted: panel.zone === 'rows' && panel.highlighted === token,
        intent,
      }
    }
    const row = (
      key: string,
      label: string,
      highlighted: boolean,
      intent: QuickMenuIntent,
    ): QuickMenuRow => ({
      key,
      label: sanitizedPhysicalLine(label),
      value: undefined,
      chevron: false,
      selected: false,
      highlighted,
      intent,
    })
    const back = panel.page === 'root'
      ? undefined
      : row(actionKeyOf(panel, BACK_ROW), '‹ Model & Effort', panel.zone === 'back', { kind: 'back', revision })
    const footer = row(actionKeyOf(panel, FOOTER_ROW), 'All models & details…', panel.zone === 'footer', { kind: 'full', revision })
    const sections: QuickMenuSection[] = []
    if (panel.phase === 'error') {
      // The failed read offers exactly ONE operation: the command's own re-read.
      sections.push({
        key: `q${panel.serial}-retry`,
        head: '',
        rows: [mint(RETRY_ROW, 'Retry', undefined, false, false, { kind: 'retry', revision })],
      })
    } else if (panel.page === 'root') {
      const current = currentRow(panel)
      const choices = currentChoices(panel)
      // The root rows are NAVIGATION, not options: they state the committed
      // values (read from the directory, never from a Composer label) and carry
      // the disclosure chevron, and a click on one opens its page.
      const rows: QuickMenuRow[] = [mint(
        ROOT_MODEL_ROW,
        'Model',
        ready ? current?.modelName : undefined,
        true,
        false,
        { kind: 'open-models', revision },
      )]
      if (choices.length > 0) {
        rows.push(mint(
          ROOT_EFFORT_ROW,
          'Reasoning Effort',
          ready ? choices.find((choice) => choice.value === currentEffortValue(panel))?.label : undefined,
          true,
          false,
          { kind: 'open-effort', revision },
        ))
      }
      sections.push({ key: `q${panel.serial}-root`, head: '', rows })
    } else if (panel.page === 'effort') {
      const rows = currentChoices(panel).map((choice) => mint(
        choice.value,
        choice.label,
        undefined,
        false,
        ready && choice.value === currentEffortValue(panel),
        { kind: 'choose-effort', value: choice.value, revision },
      ))
      sections.push({ key: `q${panel.serial}-efforts`, head: '', rows })
    } else {
      for (const group of panel.directory?.directory.groups ?? []) {
        const rows = visibleModels(panel)
          .filter((item) => item.providerId === group.id)
          .map((item) => mint(
            modelRowId(item),
            item.modelName,
            undefined,
            false,
            item.isCurrent,
            { kind: 'choose-model', rowId: modelRowId(item), revision },
          ))
        if (rows.length === 0) continue
        sections.push({ key: `q${panel.serial}-g-${group.id}`, head: sanitizedPhysicalLine(group.name), rows })
      }
    }
    return {
      serial: panel.serial,
      revision,
      page: panel.page,
      phase: panel.phase,
      query: panel.query,
      cursor: panel.cursor,
      searchKey: searchKeyOf(panel),
      searching: panel.page === 'models' && panel.zone === 'search',
      back,
      sections,
      failures: panel.failures.map((failure) => ({
        key: `${panel.serial}-failure-${failure.providerId}`,
        label: `${sanitizedPhysicalLine(failure.providerName)} · unavailable`,
        detail: sanitizedPhysicalLine(failure.message),
      })),
      notice: panel.notice,
      empty: panel.page === 'models' && ready && sections.length === 0
        ? panel.query === ''
          ? 'No models are advertised by the configured providers.'
          : 'No models match that search.'
        : undefined,
      footer,
    }
  }

  /** The ONE keyboard owner while this panel is the current composer seat.
   *  Returns whether the key was consumed — a consumed key NEVER reaches the
   *  Composer reducer, so a menu keystroke can neither edit the draft nor
   *  submit it. */
  handleKey(key: Key): boolean {
    const panel = this.current()
    if (panel === undefined) return false
    // Ctrl+C always belongs to the original application cancel owner; the caller
    // revokes this menu's interaction identity before routing the intent.
    if (key.ctrl === true && key.name === 'c') return false
    if (!this.canInteract()) return true
    const intent = this.keyIntent(panel, key)
    if (intent !== undefined) this.act(panel, panel.revision, intent)
    return true
  }

  private keyIntent(panel: QuickPanel, key: Key): QuickMenuIntent | undefined {
    const revision = panel.revision
    if (key.name === 'escape') {
      // While a write is admitted, Escape is a consumed dismissal only: it never
      // cancels the dispatched write and never restates an older result.
      if (panel.phase === 'pending') return { kind: 'close', revision }
      if (panel.query !== '') return { kind: 'query', query: '', cursor: 0, revision }
      if (panel.page !== 'root') return { kind: 'back', revision }
      return { kind: 'close', revision }
    }
    // Under an admitted write nothing else may browse or re-write.
    if (panel.phase === 'pending') return undefined
    if (key.ctrl === true || key.alt === true || key.meta === true) return undefined
    if (key.name === 'tab') return { kind: 'tab', delta: key.shift === true ? -1 : 1, revision }
    if (key.name === 'enter') return { kind: 'activate', revision }
    if (key.name === 'up') return { kind: 'browse', delta: -1, revision }
    if (key.name === 'down') return { kind: 'browse', delta: 1, revision }
    if (panel.page === 'models' && panel.zone === 'search') {
      const edited = editQuery(panel, key)
      return edited === undefined ? undefined : { kind: 'query', ...edited, revision }
    }
    return undefined
  }

  /** The ONE entry point for an intent the composer view minted (a click). */
  handleIntent(intent: QuickMenuIntent): void {
    const panel = this.current()
    if (panel === undefined) return
    this.act(panel, intent.revision, intent)
  }

  /** The ONE admission point for every intent, from any route. It runs BEFORE
   *  any mutation: a stale frame, another panel, a higher seat, a superseded
   *  subject or an already-admitted write can never change this panel. */
  private act(panel: QuickPanel, revision: number, intent: QuickMenuIntent): void {
    if (!this.canInteract() || this.current() !== panel || panel.revision !== revision) return
    // An ADMITTED write owns the panel: dismissal is the only thing left to do
    // there. Every browse, page, query, retry and second selection intent is
    // refused before it can reach the writer, so one click can never become two
    // Session writes (the plan's pending-row contract).
    if (panel.phase === 'pending' && intent.kind !== 'close') return
    switch (intent.kind) {
      case 'close':
        this.close(panel)
        return
      case 'full':
        // The handoff revokes this panel's interaction identity FIRST, then runs
        // the registered command's own full entry: the quick tree is gone before
        // the catalogue paints, and the command's surface token retires every
        // read or write this panel started.
        this.retire()
        this.openFull()
        this.render()
        return
      case 'retry':
        if (panel.phase !== 'error') return
        this.retry(panel)
        return
      case 'back':
        if (panel.page === 'root') return
        panel.page = 'root'
        panel.zone = 'rows'
        this.revealPending = true
        alignHighlight(panel)
        this.change(panel)
        this.setFocus()
        return
      case 'open-models':
        if (panel.page === 'effort') return
        panel.page = 'models'
        panel.zone = 'search'
        this.revealPending = true
        alignHighlight(panel)
        this.change(panel)
        this.setFocus()
        return
      case 'open-effort':
        if (currentChoices(panel).length === 0) return
        panel.page = 'effort'
        panel.zone = 'rows'
        panel.highlighted = currentEffortValue(panel)
        this.revealPending = true
        alignHighlight(panel)
        this.change(panel)
        return
      case 'browse': {
        if (!bodyOffered(panel)) return
        const tokens = bodyTokens(panel)
        const at = Math.max(0, tokens.indexOf(panel.highlighted ?? ''))
        panel.highlighted = tokens[(at + intent.delta + tokens.length) % tokens.length]
        panel.zone = 'rows'
        this.revealPending = true
        this.change(panel)
        return
      }
      case 'tab': {
        const ring = zoneRing(panel)
        const at = Math.max(0, ring.indexOf(panel.zone))
        panel.zone = ring[(at + intent.delta + ring.length) % ring.length]!
        if (panel.zone === 'rows') alignHighlight(panel)
        this.revealPending = true
        this.change(panel)
        this.setFocus()
        return
      }
      case 'activate': {
        if (panel.zone === 'footer') {
          this.act(panel, panel.revision, { kind: 'full', revision: panel.revision })
          return
        }
        if (panel.zone === 'back') {
          this.act(panel, panel.revision, { kind: 'back', revision: panel.revision })
          return
        }
        if (!bodyOffered(panel)) return
        const token = panel.highlighted
        if (token === undefined) return
        if (panel.phase === 'error') {
          this.act(panel, panel.revision, { kind: 'retry', revision: panel.revision })
          return
        }
        if (panel.page === 'root') {
          this.act(panel, panel.revision, token === ROOT_EFFORT_ROW
            ? { kind: 'open-effort', revision: panel.revision }
            : { kind: 'open-models', revision: panel.revision })
          return
        }
        if (panel.page === 'effort') {
          this.act(panel, panel.revision, { kind: 'choose-effort', value: token, revision: panel.revision })
          return
        }
        this.act(panel, panel.revision, { kind: 'choose-model', rowId: token, revision: panel.revision })
        return
      }
      case 'query':
        if (panel.page !== 'models' || panel.phase === 'error') return
        panel.query = intent.query
        panel.cursor = intent.cursor
        alignHighlight(panel)
        this.change(panel)
        return
      case 'choose-model': {
        // The row must be one the CURRENT frame really offers, by full identity.
        const row = visibleModels(panel).find((candidate) => modelRowId(candidate) === intent.rowId)
        if (row === undefined) return
        if (row.isCurrent) {
          // The committed model restated: a dismissal with ZERO writes. An effort
          // change is the Effort page's own job, never a side effect of this one.
          this.close(panel)
          return
        }
        // A different model never inherits the previous model's effort: the
        // payload comes from this row's own advertised candidates, and the
        // provider-default sentinel is omitted (never sent as a literal).
        const choices = effortChoicesOf(row)
        this.commit(panel, selectionOf(row, initialEffortOf(row, choices), PROVIDER_DEFAULT))
        return
      }
      case 'choose-effort': {
        const row = currentRow(panel)
        if (row === undefined) return
        const choice = effortChoicesOf(row).find((candidate) => candidate.value === intent.value)
        if (choice === undefined) return
        if (intent.value === currentEffortValue(panel)) {
          this.close(panel)
          return
        }
        this.commit(panel, selectionOf(row, choice.value, PROVIDER_DEFAULT))
        return
      }
      default:
        return
    }
  }

  /** Ask the command's ONE read owner for the directory again. The loading
   *  frame is committed BEFORE the re-entrant callback. */
  private retry(panel: QuickPanel): void {
    panel.phase = 'loading'
    panel.notice = { text: 'Loading models…', tone: 'muted' }
    panel.zone = 'rows'
    this.change(panel)
    panel.request.retry()
  }

  /** The ONE write of this presentation: the original command's `apply`, under
   *  the original command's `runOwned` owner and pending marker. */
  private commit(panel: QuickPanel, selection: ModelSelectionDto): void {
    // The pending state is VISIBLE and it is the only thing the panel states:
    // the body offers no row under an admitted write, and the authoritative
    // Session projection (not this notice) is what later relabels the Composer.
    panel.notice = { text: 'Selecting…', tone: 'muted' }
    panel.phase = 'pending'
    this.change(panel)
    panel.request.runOwned('model quick selection', () => panel.request.apply(selection), {
      isCancellation: () => panel.disposed,
      onResult: (outcome) => {
        // A retired panel, a moved subject or a newer surface owns nothing here:
        // no reopen, no backfill, no notice, no repaint.
        if (this.current() !== panel) return
        if (outcome === 'committed' || outcome === 'indeterminate') {
          // `committed` follows the authoritative Status projection; an
          // indeterminate settle already carries the command's own do-not-retry
          // notice, so this panel states no success of its own.
          this.close(panel)
          return
        }
        if (outcome === 'superseded') {
          // The subject or the surface moved while the write was in flight: this
          // panel owns no backfill, no notice and no second dispatch — but it
          // still leaves the frame, so a revoked menu is never left painted.
          this.retire()
          this.render()
          return
        }
        // A refusal, a cancellation or an unsupported write keeps the page the
        // user was on and restores it for another operation; the command's own
        // notice is the only statement about what happened, so this panel never
        // restates it (and never claims a success the Host refused).
        panel.phase = 'ready'
        panel.notice = undefined
        alignHighlight(panel)
        this.change(panel)
      },
      onError: () => {
        if (this.current() !== panel) return
        panel.phase = 'ready'
        panel.notice = undefined
        alignHighlight(panel)
        this.change(panel)
      },
    })
  }

  private close(panel: QuickPanel): void {
    panel.disposed = true
    if (this.panel === panel) {
      this.panel = undefined
      this.frameIds = new Map()
      this.revealPending = false
      this.render()
    }
  }

  /** Commit the local state FIRST, then repaint, so every re-entrant callback
   *  sees the frame that already reflects it. */
  private change(panel: QuickPanel): void {
    panel.revision += 1
    if (this.panel === panel && !panel.disposed) this.render()
  }
}
