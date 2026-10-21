/** Panel state and pure selectors for the native TSP `/model` presentation.
 *
 * This module answers only "what is the panel currently browsing / offering":
 * its state, the pure selectors over it, the strip's items and the action bar's
 * contents. It renders nothing, mutates nothing and writes nothing, so the view
 * builder and the key map stay pure functions over one explicit state object.
 * @module tui/tsp/model-picker-state
 */
import type { PickerAction, PickerItem } from '@stencil-hq/tern'
import type {
  ModelPickerDirectory,
  ModelPickerRequest,
} from '../../app/command/model-presentation.ts'
import {
  effortChoicesOf,
  initialEffortOf,
  type InlineEffortChoice,
  type ModelPickerFailureRow,
  type ModelPickerModelRow,
} from '../pickers/model-directory.ts'
import { clampMiddle } from './picker-text.ts'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
export type ModelPickerPhase = 'loading' | 'ready' | 'error' | 'pending'

/**
 * One local notice: its text plus the role ink it must be painted in.
 *
 * The design language gives a notice its own role — `textMuted` when it reports
 * information, `error` when it reports a failure — so the tone follows the NOTICE,
 * never the page's read phase: a refused write leaves the panel `ready` and is still
 * a failure, while a cancellation is information.
 */
export interface ModelPickerNotice {
  readonly text: string
  readonly tone: 'muted' | 'error'
}

/**
 * The visible page: the model catalogue (the working page, with the Reasoning
 * Effort strip and the ONE write) or the model's read-only Full details. There is no
 * intermediate page: a row activation opens the details DIRECTLY, and the effort is
 * edited in the catalogue's own strip, so no second-level effort menu exists.
 */
export type ModelPickerPage = 'models' | 'details'

/**
 * K2: the logical regions Tab moves between. `models` is the catalogue's native
 * main list, `strip` is the catalogue's own Reasoning Effort editor (the
 * native Picker `strip` between the list and the action bar, painted only while the
 * phase can really draft AND the highlighted model advertises efforts), and
 * `primary-action` is the action bar,
 * the ONE region that can commit the write. The read-only Reader is not a picker
 * and has no second region at all.
 */
export type ModelPickerZone = 'models' | 'strip' | 'primary-action'

export interface ModelPickerPanel {
  /** The presenter serial: an event bound to another panel can never act here. */
  readonly serial: number
  readonly request: ModelPickerRequest
  revision: number
  disposed: boolean
  phase: ModelPickerPhase
  page: ModelPickerPage
  zone: ModelPickerZone
  query: string
  /** The search caret, in graphemes. */
  cursor: number
  /** The highlighted model's stable row id. */
  selected: string | undefined
  /**
   * Which action bar entry owns Enter while the keyboard is in the action zone.
   * `undefined` (and any id the current page no longer offers) resolves to the
   * last enabled action, so entering the zone always lands on a live entry.
   */
  actionFocus: string | undefined
  /** How many times the read-only Reader has been OPENED on this panel. One identity per
   *  READING: a re-render must not move the Reader's node ids (a per-frame key made the
   *  client remount its scroll container), but a NEW reading gets fresh ones, so a `scroll`
   *  op queued while an earlier Reader was open can never address the next one's body. */
  readerEpoch: number
  /** The single local notice (a read error or the last write outcome), with the
   *  role ink its OWN semantics demand. */
  notice: ModelPickerNotice | undefined
  directory: ModelPickerDirectory | undefined
  rows: readonly ModelPickerModelRow[]
  failures: readonly ModelPickerFailureRow[]
  /** Per-(provider, model) local effort draft, keyed by {@link modelRowId}. */
  efforts: Map<string, string>
}

/* --------------------------------------------------------------------- rows */

/** The stable wire/local id of one model row. JSON keeps provider and model
 *  distinct (model ids are not globally unique) in a printable identifier. */
export function modelRowId(row: ModelPickerModelRow): string {
  return JSON.stringify([row.providerId, row.modelId])
}

/** The inert failure row's id. It is deliberately not a model row id, so no
 *  browse path can ever mistake it for a selectable model. */
export function failureRowId(providerId: string): string {
  return `failure:${providerId}`
}

/**
 * The wire id of the ONE read-only operation row a PARTIAL catalogue failure
 * adds to the end of the list. It is not a model row id, so it can never be
 * confused with a selectable model, and it routes to the command's existing read
 * owner — never to the writer.
 */
export const FAILURE_RETRY_ID = 'retry-failed'

/* -------------------------------------------------------------- candidates */

/**
 * The wire id of one effort CANDIDATE (the catalogue strip's own items). The
 * namespace keeps a candidate value that happened to look like a model row id
 * distinguishable from it; a candidate is only ever read from this prefix.
 */
const EFFORT_PREFIX = 'effort:'

/**
 * The wire id of one strip item: the MODEL it was built for, then the candidate value.
 *
 * The model half is what keeps a strip click honest. A click is delivered
 * asynchronously: the user can click another model, the highlight moves, and only then
 * does the strip event of the frame that showed the PREVIOUS model's candidates arrive.
 * With a value-only id that event would pass a membership check whenever the newly
 * highlighted model happens to advertise the same value, and the draft of a model the
 * user never touched would move. Both halves are therefore validated on arrival.
 */
export function stripItemId(rowId: string, value: string): string {
  return `${EFFORT_PREFIX}${rowId}\u0000${value}`
}

/**
 * The model and value one strip item id names, or `undefined` when the id is not one this
 * code built.
 *
 * `modelRowId` is a JSON string, so a RAW NUL can never occur inside the model half: the
 * FIRST NUL separates it from the value exactly. An effort VALUE may itself contain a NUL
 * (the synthetic provider default does), which is why the split cannot be done the other
 * way round.
 */
export function stripItemParts(id: string): { readonly rowId: string; readonly value: string } | undefined {
  if (!id.startsWith(EFFORT_PREFIX)) return undefined
  const rest = id.slice(EFFORT_PREFIX.length)
  const at = rest.indexOf('\u0000')
  return at <= 0 ? undefined : { rowId: rest.slice(0, at), value: rest.slice(at + 1) }
}

/**
 * Whether the catalogue's READ-ONLY retry ROW is part of the list right now.
 *
 * A partial read leaves failed providers behind, and that row is how the user asks for them
 * again. It belongs to a catalogue that is really showing its content (`ready`): when a read
 * fails as a WHOLE the panel is in `error`, where the action bar is the only operable region —
 * leaving the row painted, and its event admissible, would offer a SECOND Retry beside the
 * footer's, reachable with the mouse while the keyboard is refused. The failed providers
 * themselves stay on screen as read-only context.
 */
export function retryRowOffered(panel: ModelPickerPanel): boolean {
  return panel.phase === 'ready' && panel.failures.length > 0
}

/** Every row id the catalogue offers, in display order (the group heads are the view's
 *  own insertion into this sequence, so the window counts ROWS). */
export function catalogueRowIds(panel: ModelPickerPanel): readonly string[] {
  return [
    ...visibleModels(panel).map(modelRowId),
    ...(retryRowOffered(panel) ? [FAILURE_RETRY_ID] : []),
  ]
}

/* ---------------------------------------------------------------- selectors */

/** The rows the current query makes visible, in directory order. */
export function visibleModels(panel: ModelPickerPanel): readonly ModelPickerModelRow[] {
  const query = panel.query.toLowerCase()
  return panel.rows.filter((row) =>
    `${row.providerName} ${row.providerId} ${row.modelName} ${row.modelId}`.toLowerCase().includes(query),
  )
}

/** The highlighted row, or `undefined` when nothing visible is selected. */
export function highlightedModel(panel: ModelPickerPanel): ModelPickerModelRow | undefined {
  return visibleModels(panel).find((row) => modelRowId(row) === panel.selected)
}

/** The effort candidates a model advertises; empty means "no selector at all". */
export function modelChoices(row: ModelPickerModelRow | undefined): readonly InlineEffortChoice[] {
  return row === undefined ? [] : effortChoicesOf(row)
}

/** The local draft effort of one model (undefined when it has no metadata). */
export function draftedEffort(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow | undefined,
): string | undefined {
  return row === undefined ? undefined : panel.efforts.get(modelRowId(row))
}

const markSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const graphemesOf = (text: string): string[] =>
  [...markSegmenter.segment(text)].map((segment) => segment.segment)

/**
 * The stable 1–2 character Provider MARK of a catalogue row: the initials of the
 * provider's advertised display name (a single word contributes its first two
 * characters). It is a deterministic abbreviation of a REAL name — never a
 * fabricated logo — and the seed keeps the client's own colour assignment stable
 * per provider.
 */
export function providerMark(row: ModelPickerModelRow): { text: string; seed: string } {
  const words = row.providerName.match(/[\p{L}\p{N}]+/gu) ?? []
  const first = graphemesOf(words[0] ?? row.providerId)
  const text = words.length >= 2
    ? first.slice(0, 1).concat(graphemesOf(words[1]!).slice(0, 1)).join('')
    : first.slice(0, 2).join('')
  return { text: text.toUpperCase(), seed: row.providerId }
}

/** The advertised description of one model, from the authoritative directory. */
export function advertisedDescription(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow,
): string | undefined {
  return panel.directory?.directory.groups
    .find((group) => group.id === row.providerId)
    ?.models.find((model) => model.id === row.modelId)?.description
}

/** One inert fact of the panel's configured selection state. */
export interface ModelPickerFact {
  readonly id: string
  readonly label: string
  readonly detail: string
}

/** The compact one-token value of a configured selection (`provider/model/
 *  effort`), used where the configured facts are read as single values. */
const factValue = (selection: { provider: string; model: string; reasoningEffort?: string }): string =>
  [selection.provider, selection.model, ...(selection.reasoningEffort === undefined ? [] : [selection.reasoningEffort])]
    .join(' · ')

/**
 * The configured-selection facts: `Current` only for a live Session (never for a
 * sessionless subject) and `Default` from `directory.default` — including its own
 * effort, which the row-level projection cannot carry when the default is not the
 * current model.
 */
export function configuredFacts(panel: ModelPickerPanel): readonly ModelPickerFact[] {
  const directory = panel.directory
  if (directory === undefined) return []
  return [
    ...(panel.request.subject.sessionless || directory.current === undefined
      ? []
      : [{ id: 'fact-current', label: 'Current', detail: factValue(directory.current) }]),
    { id: 'fact-default', label: 'Default', detail: factValue(directory.directory.default) },
  ]
}

/**
 * Whether the current phase lets the KEYBOARD run the action bar at all.
 *
 * The bar is rendered in every phase, but an admitted write (`pending`) and a
 * running (re-)read (`loading`) refuse every key except Esc — plus the search box
 * on the catalogue — so no action there can be activated from the keyboard. The
 * `[Enter]` badge is a promise about Enter and `focusedAction`'s fallback is a statement
 * about which action Enter runs, so BOTH are meaningful only where this holds:
 * everywhere else the bar must read as having no keyboard focus instead of
 * marking `Cancel` and then swallowing the Enter that cue announced.
 */
export function actionKeyboardLive(panel: ModelPickerPanel): boolean {
  return panel.phase === 'ready' || panel.phase === 'error'
}

/* ------------------------------------------------------------------- strip */

/**
 * Whether the catalogue paints its Reasoning Effort strip: the page must be the
 * catalogue, a model must be highlighted, and that model must advertise at least
 * one candidate. A model without effort metadata therefore shows NO strip row at
 * all (never an empty or invented one).
 */
export function stripOffered(panel: ModelPickerPanel): boolean {
  // A draft can only change while the panel is READY: `pending` is an admitted
  // write, a running re-read is about to replace the whole directory, and a failed
  // one has no authoritative directory left. The strip is therefore not painted in
  // those phases at all (the client paints no disabled strip item), and its action
  // channel is refused at admission instead of by a later guard — display and
  // admission are the same fact.
  return panel.page === 'models'
    && panel.phase === 'ready'
    && modelChoices(highlightedModel(panel)).length > 0
}

/** One button of the catalogue's Reasoning Effort strip. */
export interface ModelPickerStripItem {
  readonly id: string
  readonly label: string
  /** The LOCAL draft is this candidate (the client's own "selected" item style). */
  readonly on?: boolean
}

/**
 * How many display columns a strip chip's label may use on a pane whose width is
 * `panePx`.
 *
 * The client caps its `md` sheet (measured: every pane from 888px up paints a
 * `680px`-wide sheet) and spends a fixed part of it on chrome, so the budget must
 * NOT grow with the pane past that cap — it is the SHEET that a chip competes with,
 * not the window.
 *
 * MEASURED against the real client: the sheet is `pane - 44px` wide below its cap
 * (a 400px pane paints a 340px sheet, a 560px pane a 500px one) and `680px` at every
 * wider pane; inside it the `Reasoning Effort` label column, the strip's
 * insets/gutters and the chip's own padding take `169px` (measured: a 400x600 chip
 * container of 213px against a 356px sheet, a 400px-pane container of 193px against
 * the 340px sheet). `12px` per column is the conservative advance for the strip's own
 * 12.5px `Geist` (its widest Latin glyph measured ~11.5px, a CJK glyph 12.5px), and
 * the budget is display-width aware, so a CJK glyph is charged two columns. The
 * ellipsis is the design language's content-truncation device, and the COMPLETE
 * label stays exactly where it came from — the directory and the Reader's own
 * configured facts.
 */
const SHEET_MAX_PX = 680
const SHEET_INSET_PX = 44
const STRIP_CHROME_PX = 169
const STRIP_GLYPH_PX = 12

export function stripLabelColumns(panePx: number): number {
  const sheet = Math.min(panePx - SHEET_INSET_PX, SHEET_MAX_PX)
  return Math.max(4, Math.floor((sheet - STRIP_CHROME_PX) / STRIP_GLYPH_PX))
}

/**
 * The strip's items: one native button per advertised candidate of the HIGHLIGHTED
 * model, in the directory's own order, with the local DRAFT marked `on`. A label is
 * clamped to the pane's own strip capacity ({@link stripLabelColumns}) because the
 * client cannot shrink a chip and would cut a too-wide label at the sheet's edge.
 */
export function stripItems(
  panel: ModelPickerPanel,
  columns: number,
): readonly ModelPickerStripItem[] {
  const row = highlightedModel(panel)
  const draft = draftedEffort(panel, row)
  const rowId = row === undefined ? '' : modelRowId(row)
  return modelChoices(row).map((choice) => ({
    id: stripItemId(rowId, choice.value),
    label: clampMiddle(choice.label, columns),
    ...(choice.value === draft ? { on: true } : {}),
  }))
}

/** The strip's own head. It names what the buttons below it do. */
export const STRIP_LABEL = 'Reasoning Effort'

/* ------------------------------------------------------------- page caption */

/**
 * The picker's ONE-line title.
 *
 * The `models` page states what committing there really does (`Switch model` for
 * a live Session, `Choose default model` for a sessionless subject), which is the
 * whole subject of the panel in one short line — there is no separate subject
 * slot to keep in sync with it. The READER names the model it describes, so that
 * page can never describe a different model than the row it was opened from.
 */
export function pickerTitle(panel: ModelPickerPanel): string {
  return panel.request.subject.sessionless ? 'Choose default model' : 'Switch model'
}

/**
 * The picker's ONE-line subtitle: the single keyboard hint on the catalogue (the
 * plan allows exactly one such hint and no standing action strip).
 *
 * The hint does NOT carry identity: a narrow pane paints no subtitle at all
 * (measured at 400 and 560px), which is why a model's name is its own ROW's label
 * and never a caption.
 *
 * The catalogue's hint is a promise about `Enter`/`Tab`, so it is painted only while
 * the phase really admits Enter: a running (re-)read and an admitted write refuse
 * every key but `Esc`, and a phase that refuses Enter must not promise it.
 */
export function pickerSubtitle(panel: ModelPickerPanel): string {
  if (panel.page === 'models') {
    if (panel.phase !== 'ready') return ''
    // The ONE hint is the design language's `<Key> <object>` form and it names the
    // zone `Tab` reaches NEXT — exactly the ring `tabZone` walks: the catalogue's
    // effort strip, the action bar, and then the model list again. It is a promise
    // about the KEYBOARD, so it is painted only while the phase really admits keys.
    if (panel.zone === 'strip') return 'Tab actions'
    if (panel.zone === 'primary-action') return 'Tab list'
    return stripOffered(panel) ? 'Tab effort' : 'Tab actions'
  }
  const row = highlightedModel(panel)
  if (row === undefined) return ''
  return [row.providerName, ...(row.isCurrent ? ['current'] : []), ...(row.isDefault ? ['Default'] : [])].join(' · ')
}

/** The Reader's own big title: the model it describes. */
export function readerHead(panel: ModelPickerPanel): string {
  return highlightedModel(panel)?.modelName ?? 'Full model details'
}

/* --------------------------------------------------------------- action bar */

/**
 * The frame token an ACTION id carries.
 *
 * The picker, its layer and the Reader keep ONE node identity for as long as the panel
 * lives (their keys carry the panel SERIAL, never the frame revision — MEASURED on the
 * real client: a key that changes per frame makes the SDK diff `del + add`, and a
 * remounted list re-anchors its selected row, which moves the whole viewport under a
 * click). With a long-lived id, `targets` can no longer tell an event from an earlier
 * frame by the id it addresses, so the ACTIONS carry the revision themselves: the bar is
 * rebuilt every frame, and an event whose `act` names any other revision is refused at
 * admission exactly like an id that was never rendered.
 *
 * The panel's dismissal is the ONE untokened action: `close` is the same intent `Esc`
 * and the client's own backdrop gesture send, so it must keep working from any frame.
 */
export const ACTION_TOKEN = '#'
/** The one action that is deliberately frame-independent. */
export const FRAME_FREE_ACTION = 'close'

/** The revision-scoped id the CURRENT frame renders for one action base. */
export function actionId(panel: ModelPickerPanel, base: string): string {
  return base === FRAME_FREE_ACTION ? base : `${base}${ACTION_TOKEN}${panel.revision}`
}

/**
 * The action base an id names, or `undefined` when the id is not one THIS frame renders:
 * an unknown shape, a missing token, or a token from a revision that is no longer the
 * panel's. That is what keeps a stale action from acting on a later frame.
 */
export function actionBase(panel: ModelPickerPanel, id: string): string | undefined {
  if (id === FRAME_FREE_ACTION) return id
  const at = id.lastIndexOf(ACTION_TOKEN)
  if (at <= 0) return undefined
  return id.slice(at + 1) === String(panel.revision) ? id.slice(0, at) : undefined
}

/**
 * Whether the CURRENT page carries the explicit write action. The catalogue and
 * the catalogue offers it on the model the user highlighted, with its
 * already-seeded (or strip-drafted) effort — so the ONE write is an explicitly
 * labelled action at EVERY pane width. The read-only Reader paints no action bar at
 * all.
 */
export function applyOffered(panel: ModelPickerPanel): boolean {
  return panel.page === 'models'
}

/** The short, explicit label of the one write: what it really does. */
function primaryLabel(panel: ModelPickerPanel): string {
  return panel.request.subject.sessionless ? 'Save default' : 'Switch'
}

/** The single visible Primary Action of the current page and phase. */
function primaryAction(panel: ModelPickerPanel): PickerAction {
  return {
    id: actionId(panel, 'apply'),
    label: panel.phase === 'pending' ? 'Selecting…' : primaryLabel(panel),
    primary: true,
    // A phase that admits no write (a running read, an admitted write) and a
    // page with no selectable model must LOOK unavailable rather than silently
    // refusing a click.
    disabled: panel.phase === 'loading' || panel.phase === 'pending' || highlightedModel(panel) === undefined
      ? true
      : undefined,
  }
}

/**
 * The ACTION BAR for the CURRENT page and phase: short, fixed, and never wider
 * than the page's own entries.
 *
 * The catalogue is `Cancel` + the ONE write; a failed read is `Cancel` + the
 * read-only `Retry`, which is the only operation that phase can run. The
 * read-only Reader paints no bar at all: a user leaves it with its own `Back` row
 * (and `Esc`, which is the same intent), and cancels from the catalogue. The
 * panel's own dismissal authority
 * (`close`) stays admitted on every page, so the client's backdrop/dismiss
 * gesture still closes the panel there; it is simply not a VISIBLE entry the
 * footer has to carry.
 *
 * `Switch` / `Save default` is the only write. The view renders exactly this list
 * and the key map moves the keyboard focus across it, so a visible action can
 * never be unreachable or a no-op.
 */
export function pickerActions(panel: ModelPickerPanel): PickerAction[] {
  const actions: PickerAction[] = []
  // The visible label follows what the action really does: while a write is
  // admitted, closing the panel does NOT cancel the operation that is already
  // with the Host, so that phase keeps the honest `Close` instead of the `Cancel`
  // a user would read as "undo the write".
  if (panel.page === 'models' || panel.phase !== 'ready') {
    actions.push({ id: actionId(panel, FRAME_FREE_ACTION), label: panel.phase === 'pending' ? 'Close' : 'Cancel', end: true })
  }
  // A failed read admits exactly one operation — the read-only Retry — so the
  // bar never offers a browse or a write the phase would refuse.
  if (panel.phase === 'error') {
    actions.push({ id: actionId(panel, 'retry'), label: 'Retry', primary: true })
    return actions
  }
  // Every page operation below belongs to the catalogue: a running (re-)read and an
  // admitted write refuse them, so those phases render the way out (`Close`) and the
  // disabled write instead of a clickable entry no key and no click could run.
  if (applyOffered(panel)) actions.push(primaryAction(panel))
  return actions
}

/** The action that owns Enter right now.
 *
 *  The frozen default is the last ENABLED entry, but a DISABLED action owns no
 *  Enter and shows no cue: when the Primary cannot act — a read that failed, a
 *  catalogue with no selectable model, a search with no match — focus falls back
 *  to an action that CAN act (`Cancel` is always enabled), instead of parking the
 *  keyboard on a dead entry that no `[Enter]` badge marks and Enter does nothing with. */
export function focusedAction(panel: ModelPickerPanel): PickerAction {
  const actions = pickerActions(panel)
  const enabled = (action: PickerAction): boolean => action.disabled !== true
  const explicit = actions.find((action) => actionBase(panel, action.id) === panel.actionFocus && enabled(action))
  return explicit ?? actions.filter(enabled).at(-1) ?? actions[actions.length - 1]!
}

/** The next ENABLED action in the bar, wrapping in `delta`'s direction. */
export function stepActionFocus(panel: ModelPickerPanel, delta: -1 | 1): string {
  const offered = pickerActions(panel).filter((action) => action.disabled !== true)
  const current = focusedAction(panel)
  const at = offered.findIndex((action) => actionBase(panel, action.id) === actionBase(panel, current.id))
  const next = offered[(Math.max(at, 0) + delta + offered.length) % offered.length] ?? current
  // The focus state is stored as a BASE id: the rendered actions carry the frame token,
  // and a token kept in the panel's own state would stop matching on the very next frame.
  return actionBase(panel, next.id) ?? next.id
}

/* ------------------------------------------------------------- details page */

/** One label/value pair of the read-only Reader. A group whose single fact IS the
 *  group's own subject (its Description) omits the label rather than repeating
 *  the head.
 *
 *  The value is the COMPLETE, untouched fact — never pre-split into rows: the
 *  native client wraps it at the width the layout really has, which is the only
 *  width the presenter cannot measure. `wrap` selects how a value with no usable
 *  break opportunity behaves: `char` for machine identifiers (`provider/model/
 *  effort` slugs and model IDs, which may carry no space at all) and `word` for
 *  prose (the description and the transient status), where breaking inside a
 *  word would be the wrong reading order. */
export interface ModelPickerReaderFact {
  readonly id: string
  readonly label?: string
  readonly value: string
  readonly wrap: 'word' | 'char'
}

/** One titled group of the Reader: the facts a user reads together. */
export interface ModelPickerReaderGroup {
  readonly id: string
  readonly head: string
  readonly facts: readonly ModelPickerReaderFact[]
}

/**
 * The Reader's groups, in the order a user reads them: the model's IDENTITY
 * (its complete name — the page's own title ellipsizes a long one — plus provider
 * and model ID), its CONFIGURATION (the configured Current/Default selections,
 * whose values carry their own effort from the ONE directory DTO, and the current
 * draft effort) and its advertised DESCRIPTION.
 *
 * The values are the directory's own — this page never rewrites, re-derives or
 * re-flows what the writer sends, and it never invents an effort a model does not
 * advertise.
 */
export function detailReaderGroups(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow,
): readonly ModelPickerReaderGroup[] {
  const description = advertisedDescription(panel, row)
  const draft = draftedEffort(panel, row)
  const draftLabel = modelChoices(row).find((choice) => choice.value === draft)?.label
  const configuration: ModelPickerReaderFact[] = [
    ...configuredFacts(panel).map((fact) => ({
      id: `reader-${fact.id}`,
      label: fact.label,
      value: fact.detail,
      wrap: 'char' as const,
    })),
    ...(draftLabel === undefined
      ? []
      : [{ id: 'reader-draft', label: 'Draft effort', value: draftLabel, wrap: 'char' as const }]),
  ]
  return [
    {
      id: 'identity',
      head: 'Identity',
      facts: [
        { id: 'reader-model', label: 'Model', value: row.modelName, wrap: 'char' },
        { id: 'reader-provider', label: 'Provider', value: `${row.providerName} (${row.providerId})`, wrap: 'char' },
        { id: 'reader-id', label: 'ID', value: row.modelId, wrap: 'char' },
      ],
    },
    ...(configuration.length === 0 ? [] : [{ id: 'configuration', head: 'Configuration', facts: configuration }]),
    ...(description === undefined
      ? []
      : [{ id: 'description', head: 'Description', facts: [{ id: 'reader-description', value: description, wrap: 'word' as const }] }]),
  ]
}

/* ------------------------------------------------------------ layout budget */

/* ------------------------------------------------------------ draft payload */

/**
 * Seed/re-seed every model's draft after a (re-)read: keep a surviving value
 * only while it is still advertised, otherwise fall back to the model's real
 * declared default. A model that lost its metadata loses its draft entry.
 */
export function seedDrafts(
  rows: readonly ModelPickerModelRow[],
  previous: ReadonlyMap<string, string>,
): Map<string, string> {
  const next = new Map<string, string>()
  for (const row of rows) {
    const id = modelRowId(row)
    const choices = effortChoicesOf(row)
    const kept = previous.get(id)
    const value = kept !== undefined && choices.some((choice) => choice.value === kept)
      ? kept
      : initialEffortOf(row, choices)
    if (value !== undefined) next.set(id, value)
  }
  return next
}

/** The write payload for one row + draft: the provider-default sentinel is
 *  OMITTED (never serialized as an effort literal). */
export function selectionOf(
  row: ModelPickerModelRow,
  draft: string | undefined,
  providerDefault: string,
): { provider: string; model: string; reasoningEffort?: string } {
  return draft === undefined || draft === providerDefault
    ? { provider: row.providerId, model: row.modelId }
    : { provider: row.providerId, model: row.modelId, reasoningEffort: draft }
}
