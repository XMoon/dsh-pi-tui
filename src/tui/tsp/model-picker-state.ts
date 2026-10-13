/** Panel state and pure selectors for the native TSP `/model` presentation.
 *
 * This module answers only "what is the panel currently browsing / offering":
 * its state, the pure selectors over it, the action bar's contents and the ONE
 * measured layout threshold. It renders nothing, mutates nothing and writes
 * nothing, so the view builder and the key map stay pure functions over one
 * explicit state object.
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

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
export type ModelPickerPhase = 'loading' | 'ready' | 'error' | 'pending'

/** The visible page: the model catalogue, one model's Overview, or its read-only
 *  Full details. The Overview is the model's OWN page, never a global menu. */
export type ModelPickerPage = 'models' | 'overview' | 'details'

/**
 * K2: the logical regions Tab moves between. `models` is the CURRENT page's
 * native main list — the catalogue on the `models` page, the model's own rows on
 * the Overview — and `primary-action` is the picker's action bar, the ONE region
 * that can commit the write. The list-first shell paints exactly these two at
 * every pane width; the read-only Reader is not a picker and has no second
 * region at all.
 */
export type ModelPickerZone = 'models' | 'primary-action'

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
  /** The zone the keyboard came from when it entered the action bar (Esc returns
   *  there instead of guessing). */
  previousZone: ModelPickerZone | undefined
  /** The single local notice (a read error or the last write outcome). */
  notice: string
  directory: ModelPickerDirectory | undefined
  rows: readonly ModelPickerModelRow[]
  failures: readonly ModelPickerFailureRow[]
  /**
   * The Overview page's presentation cursor: an index into the MAIN LIST rows
   * (the effort section, its candidates and the details entry). It is the ROW the
   * keyboard/pointer is on and is never itself a business candidate: only
   * activating an effort row changes that model's draft.
   */
  overviewCursor: number
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
 * The wire id of one effort CANDIDATE row (the Overview's candidate rows). The
 * namespace keeps a candidate value that happened to look like a model row id
 * distinguishable from it; a candidate is only ever read from this prefix.
 */
const EFFORT_PREFIX = 'effort:'

/** The wire id of one effort candidate row (see {@link EFFORT_PREFIX}). */
export function effortItemId(value: string): string {
  return EFFORT_PREFIX + value
}

/** The candidate value of an effort row, or `undefined` when the id is not a
 *  candidate row at all (a model row, the effort section head, the details
 *  entry). */
export function effortValue(item: string): string | undefined {
  return item.startsWith(EFFORT_PREFIX) ? item.slice(EFFORT_PREFIX.length) : undefined
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
  `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : `/${selection.reasoningEffort}`}`

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
 * `▸` cue is a promise about Enter and `focusedAction`'s fallback is a statement
 * about which action Enter runs, so BOTH are meaningful only where this holds:
 * everywhere else the bar must read as having no keyboard focus instead of
 * marking `Cancel` and then swallowing the Enter that cue announced.
 */
export function actionKeyboardLive(panel: ModelPickerPanel): boolean {
  return panel.phase === 'ready' || panel.phase === 'error'
}

/* ------------------------------------------------------------- page caption */

/**
 * The picker's ONE-line title.
 *
 * The `models` page states what committing there really does (`Switch model` for
 * a live Session, `Choose default model` for a sessionless subject), which is the
 * whole subject of the panel in one short line — there is no separate subject
 * slot to keep in sync with it. The Overview names the model it belongs to, so
 * the page can never describe a different model than the rows below it.
 */
export function pickerTitle(panel: ModelPickerPanel): string {
  if (panel.page === 'models') {
    return panel.request.subject.sessionless ? 'Choose default model' : 'Switch model'
  }
  return 'Model overview'
}

/**
 * The picker's ONE-line subtitle: the single keyboard hint on the catalogue (the
 * plan allows exactly one such hint and no standing action strip), and the
 * model's own provider + configured state on the Overview.
 *
 * The Overview's identity does NOT depend on this line: a narrow pane paints no
 * subtitle at all (measured at 400 and 560px), which is why the model's name is
 * also the page's first ROW.
 *
 * The catalogue's hint is a promise about `Enter`, so it is painted only while
 * the phase really admits Enter: a running (re-)read and an admitted write refuse
 * every key but `Esc`, and a phase that refuses Enter must not promise it.
 */
export function pickerSubtitle(panel: ModelPickerPanel): string {
  if (panel.page === 'models') return panel.phase === 'ready' ? 'Enter: effort & details' : ''
  const row = highlightedModel(panel)
  if (row === undefined) return ''
  return [row.providerName, ...(row.isCurrent ? ['current'] : []), ...(row.isDefault ? ['Default'] : [])].join(' · ')
}

/** The Reader's own big title: the model it describes. */
export function readerHead(panel: ModelPickerPanel): string {
  return highlightedModel(panel)?.modelName ?? 'Full model details'
}

/* ------------------------------------------------------------ overview page */

/**
 * The wire id of the Overview's own model-identity row. The page's TITLE cannot
 * carry the identity on a narrow pane (the client ellipsizes a caption and paints
 * no subtitle at 400/560px — measured), and the Overview is where the effort is
 * chosen and the write is committed, so the model the page describes must be
 * visible as a ROW at every width. It is deliberately not an effort candidate id,
 * so the identity row and a candidate can never be confused.
 */
export const OVERVIEW_MODEL_ID = 'overview-model'

/** The wire id of the Overview's effort section head — the row that names what
 *  the candidates below it are. It is deliberately not an effort candidate id,
 *  so the section label and a candidate can never be confused; it routes
 *  nowhere, and activating it only moves the row cursor. */
export const OVERVIEW_EFFORT_ID = 'overview-effort'

/** The wire id of the Overview's single operation row (the read-only Full
 *  details entry). It is deliberately not an effort candidate id, so the two
 *  row kinds can never be confused. */
export const OVERVIEW_DETAILS_ID = 'overview-details'

/**
 * The Overview page's MAIN LIST rows, in the frozen priority order:
 *
 *  1. the model's OWN identity row — the name with its provider, and the complete
 *     model id as the row's `title`. It is first because the page's title cannot
 *     carry it on a narrow pane (a caption is ellipsized and 400/560px panes paint
 *     no subtitle at all, both measured), and a user choosing an effort and
 *     committing the write must be able to see WHICH model they are configuring at
 *     every width;
 *  2. the `Reasoning effort` section, carrying every advertised candidate (or the
 *     explicit `Not available` statement when the model advertises none) — the
 *     page's first-class operation, reachable at EVERY pane width;
 *  3. the single `View full model details ›` operation row.
 *
 * The configured Current/Default facts stay out of the list: the subtitle carries
 * that state where it fits and the COMPLETE values live in the read-only Reader. A
 * wall of inert fact rows would push the effort candidates off the first screen,
 * which is exactly what the page exists to show.
 */
export function overviewItems(panel: ModelPickerPanel): PickerItem[] {
  const row = highlightedModel(panel)
  if (row === undefined) return []
  const draft = draftedEffort(panel, row)
  const choices = modelChoices(row)
  return [
    { id: OVERVIEW_MODEL_ID, label: row.modelName, title: row.modelId },
    {
      id: OVERVIEW_EFFORT_ID,
      label: 'Reasoning effort',
      ...(choices.length === 0 ? { detail: 'Not available' } : {}),
    },
    ...choices.map((choice) => ({
      id: effortItemId(choice.value),
      label: choice.label,
      mark: { text: choice.value === draft ? '●' : '○' },
    })),
    { id: OVERVIEW_DETAILS_ID, label: 'View full model details ›' },
  ]
}

/** The Overview cursor, clamped to the rows the page currently offers. */
export function overviewCursorIndex(panel: ModelPickerPanel): number {
  const count = overviewItems(panel).length
  return Math.min(Math.max(panel.overviewCursor, 0), Math.max(0, count - 1))
}

/** The row the Overview's native list has selected: the REAL row at the cursor,
 *  never a fixed draft item, so the keyboard can read every row it offers. */
export function overviewSelected(panel: ModelPickerPanel): string | undefined {
  return overviewItems(panel)[overviewCursorIndex(panel)]?.id
}

/* --------------------------------------------------------------- action bar */

/**
 * Whether the CURRENT page carries the explicit write action. The catalogue and
 * the Overview both offer it — the catalogue on the model the user highlighted
 * with its already-seeded draft, the Overview on the model it describes — so the
 * ONE write is an explicitly labelled action at EVERY pane width. The read-only
 * Reader paints no action bar at all.
 */
export function applyOffered(panel: ModelPickerPanel): boolean {
  return panel.page === 'models' || panel.page === 'overview'
}

/** The short, explicit label of the one write: what it really does. */
function primaryLabel(panel: ModelPickerPanel): string {
  return panel.request.subject.sessionless ? 'Save default' : 'Switch'
}

/** The single visible Primary Action of the current page and phase. */
function primaryAction(panel: ModelPickerPanel): PickerAction {
  return {
    id: 'apply',
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
 * The catalogue is `Cancel` + the ONE write; the Overview is `Back` + the ONE
 * write; a failed read is `Cancel` + the read-only `Retry`, which is the only
 * operation that phase can run. `Cancel` is therefore NOT rendered on the
 * Overview — a user leaves it with `Back` (and `Esc`, which is the same intent)
 * and cancels from the catalogue. The panel's own dismissal authority
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
    actions.push({ id: 'close', label: panel.phase === 'pending' ? 'Close' : 'Cancel', end: true })
  }
  // A failed read admits exactly one operation — the read-only Retry — so the
  // bar never offers a browse or a write the phase would refuse.
  if (panel.phase === 'error') {
    actions.push({ id: 'retry', label: 'Retry', primary: true })
    return actions
  }
  // A content page's own `Back` is offered only while the phase really admits it:
  // a running (re-)read and an admitted write refuse every page operation, so
  // those phases render the way out (`Close`) and the disabled write instead of a
  // clickable `Back` that no key and no click could run.
  if (panel.page === 'overview' && panel.phase === 'ready') actions.push({ id: 'back', label: 'Back' })
  if (applyOffered(panel)) actions.push(primaryAction(panel))
  return actions
}

/** The action that owns Enter right now.
 *
 *  The frozen default is the last ENABLED entry, but a DISABLED action owns no
 *  Enter and shows no cue: when the Primary cannot act — a read that failed, a
 *  catalogue with no selectable model, a search with no match — focus falls back
 *  to an action that CAN act (`Cancel` is always enabled), instead of parking the
 *  keyboard on a dead entry that no `▸` marks and Enter does nothing with. */
export function focusedAction(panel: ModelPickerPanel): PickerAction {
  const actions = pickerActions(panel)
  const enabled = (action: PickerAction): boolean => action.disabled !== true
  const explicit = actions.find((action) => action.id === panel.actionFocus && enabled(action))
  return explicit ?? actions.filter(enabled).at(-1) ?? actions[actions.length - 1]!
}

/** The next ENABLED action in the bar, wrapping in `delta`'s direction. */
export function stepActionFocus(panel: ModelPickerPanel, delta: -1 | 1): string {
  const offered = pickerActions(panel).filter((action) => action.disabled !== true)
  const at = offered.findIndex((action) => action.id === focusedAction(panel).id)
  const next = offered[(Math.max(at, 0) + delta + offered.length) % offered.length]
  return next?.id ?? focusedAction(panel).id
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

/* ----------------------------------------------------- selected-model summary */

/** One read-only fact of the catalogue's selected-model summary. */
export interface ModelPickerSummaryFact {
  readonly label: string
  readonly value: string
}

/**
 * The compact read-only facts of the HIGHLIGHTED model, for the catalogue's
 * summary under the list: the provider, its drafted effort and its configured
 * state. Only real facts are returned — a model that advertises no effort gets no
 * effort entry — and the summary is never a place where a required operation
 * lives.
 */
export function summaryFacts(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow,
): readonly ModelPickerSummaryFact[] {
  const draft = draftedEffort(panel, row)
  const draftLabel = modelChoices(row).find((choice) => choice.value === draft)?.label
  const state = [...(row.isCurrent ? ['current'] : []), ...(row.isDefault ? ['default'] : [])].join(' · ')
  return [
    { label: 'Provider', value: row.providerName },
    ...(draftLabel === undefined ? [] : [{ label: 'Draft effort', value: draftLabel }]),
    ...(state === '' ? [] : [{ label: 'Selection', value: state }]),
  ]
}

/* ------------------------------------------------------------ layout budget */

/**
 * The RECONSTRUCTED pane width, in CSS px, at and above which the catalogue asks
 * for its `lg` sheet and paints the compact selected-model summary below the list
 * (`preview: 'below'`).
 *
 * MEASURED against the real client (Gate V1 of the Model Visual UX plan): with
 * `preview: 'below'` requested, an `888px` pane (900x400) really paints the
 * summary while a `544px` pane (560x640) is `pv-hide`d — the client's own
 * breakpoint lies between them and is NOT measured exactly. This presenter asks
 * for the summary from `900px` of its own reconstruction upwards, which is inside
 * the region the client was measured to paint, and which also keeps the ONE
 * measured case where the summary squeezed the list (an 888px pane in a 400px-tall
 * window leaves two model rows instead of three) on the `none` side of the line.
 * Panes below the line get `md` + `preview: 'none'`: the same rows and the same
 * ONE write, without any informational chrome.
 *
 * Only `SessionCaps.cols`/`cell` describe geometry (the SDK reports no sheet box
 * and no pane height), so the pane width is RECONSTRUCTED as `cols * cell.w`.
 */
export const SUMMARY_MIN_PANE_PX = 900

/**
 * Whether the current pane gets the `lg` catalogue sheet and the compact summary.
 * This is the ONE layout threshold of the `/model` presenter: it decides how much
 * INFORMATIONAL chrome the catalogue paints, and nothing about what can be
 * written, reached or read.
 */
export function wideCatalog(cols: number, cellWidth: number): boolean {
  return cols * cellWidth >= SUMMARY_MIN_PANE_PX
}

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
