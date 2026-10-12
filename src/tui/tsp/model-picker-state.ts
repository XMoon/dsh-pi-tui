/** Panel state and pure selectors for the native TSP `/model` presentation.
 *
 * This module answers only "what is the panel currently browsing / offering":
 * its state, the pure selectors over it, the action bar's contents, and the
 * measured layout budget. It renders nothing, mutates nothing and writes
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
import {
  clampColumns,
  displayWidth,
  factLineColumns,
  factRowItems,
  oneLine,
  PICKER_GLYPH_PX,
  wrapColumns,
} from './picker-text.ts'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
export type ModelPickerPhase = 'loading' | 'ready' | 'error' | 'pending'

/** The visible page. `lg` shows the wide page; `md` drills through all three. */
export type ModelPickerPage = 'models' | 'details' | 'effort'

/** K2: the three logical regions Tab moves between. Only `primary-action` may
 *  ever commit a write, and only when it is visible and enabled. */
export type ModelPickerZone = 'models' | 'effort' | 'primary-action'

export interface ModelPickerPanel {
  /** The presenter serial: an event bound to another panel can never act here. */
  readonly serial: number
  readonly request: ModelPickerRequest
  revision: number
  disposed: boolean
  phase: ModelPickerPhase
  page: ModelPickerPage
  zone: ModelPickerZone
  /** The scope filter (a provider id, or `undefined` for every provider) —
   *  browse state, never authority. */
  scope: ModelPickerScope
  query: string
  cursor: number
  /** The highlighted model's stable row id. */
  selected: string | undefined
  /**
   * Which action bar entry owns Enter while the keyboard is in the action zone.
   * `undefined` (and any id the current page no longer offers) resolves to the
   * Primary Action, so entering the zone always lands on the frozen default.
   */
  actionFocus: string | undefined
  /** The zone the keyboard came from when it entered the action bar (Esc returns
   *  there instead of guessing between the effort selector and the list). */
  previousZone: ModelPickerZone | undefined
  /** The page the effort selector was opened FROM (frozen §4.4: a compact Esc
   *  returns to the previous page, not always to the model list). */
  previousPage: ModelPickerPage | undefined
  /** The single local notice (a read error or the last write outcome). */
  notice: string
  directory: ModelPickerDirectory | undefined
  rows: readonly ModelPickerModelRow[]
  failures: readonly ModelPickerFailureRow[]
  /**
   * The details page's presentation cursor (an index into its inert fact rows).
   * It only keeps the native list scrolled to the row the user is reading, so a
   * long description's tail stays reachable from the keyboard.
   */
  factCursor: number
  /** Per-(provider, model) local effort draft, keyed by {@link modelRowId}. */
  efforts: Map<string, string>
}

/* ------------------------------------------------------------------- scope */

/**
 * The panel's provider-scope filter: the provider ID to filter, or `undefined`
 * for "every provider". The every-provider case is the ABSENCE of a provider
 * rather than a magic string, so a catalogue that advertises a provider literally
 * called `all` can never be confused with it — the wire ids below keep the two
 * namespaces separate as well.
 */
export type ModelPickerScope = string | undefined

const SCOPE_PREFIX = 'scope:'
/**
 * The wire id of the EVERY-PROVIDER scope entry. A provider scope is always
 * `scope:` plus the provider ID, so this colon-free id can never be produced for
 * any provider ID and the two ids can never collide.
 */
export const ALL_SCOPES_ID = 'scope-all'

/** The wire/local id of one provider scope. The prefix keeps a scope click
 *  distinguishable from a model-row click (a JSON array) on the same channel. */
export function scopeId(providerId: string): string {
  return SCOPE_PREFIX + providerId
}

/**
 * The provider a scope id filters: `null` for the every-provider scope, and
 * `undefined` when the id is not a scope id at all. Callers map `null` to the
 * every-provider filter, so no provider ID (not even `all`) is special.
 */
export function scopeProviderId(id: string): string | null | undefined {
  if (id === ALL_SCOPES_ID) return null
  return id.startsWith(SCOPE_PREFIX) ? id.slice(SCOPE_PREFIX.length) : undefined
}

/* -------------------------------------------------------------- candidates */

/**
 * The wire id of one effort CANDIDATE row on the effort page. Candidates get their
 * OWN namespace, because the SDK delivers the scope column's ids and the page's row
 * ids on the same channel: with a shared namespace a candidate value that happened
 * to look like a scope id (or WAS the every-provider id) could not be told apart from
 * the scope entry. The first token differs by construction, so the two directions
 * are independent — a candidate named like a scope still drafts, and the real scope
 * entry still filters, even side by side.
 */
const EFFORT_PREFIX = 'effort:'

/** The wire id of one effort candidate row (see {@link EFFORT_PREFIX}). */
export function effortItemId(value: string): string {
  return EFFORT_PREFIX + value
}

/** The candidate value of an effort page row, or `undefined` when the id is not a
 *  candidate row at all (a scope id, a model row, a fact row). */
export function effortValue(item: string): string | undefined {
  return item.startsWith(EFFORT_PREFIX) ? item.slice(EFFORT_PREFIX.length) : undefined
}

/* --------------------------------------------------------------------- rows */

/** The stable wire/local id of one model row. JSON keeps provider and model
 *  distinct (model ids are not globally unique) in a printable identifier. */
export function modelRowId(row: ModelPickerModelRow): string {
  return JSON.stringify([row.providerId, row.modelId])
}

/** The inert failure row's id. It is deliberately not a scope id and not a model
 *  row id, so no browse path can ever mistake it for a selectable model. */
export function failureRowId(providerId: string): string {
  return `failure:${providerId}`
}

/* ---------------------------------------------------------------- selectors */

/** The rows the current query and scope make visible, in directory order. */
export function visibleModels(panel: ModelPickerPanel): readonly ModelPickerModelRow[] {
  const query = panel.query.toLowerCase()
  return panel.rows.filter((row) =>
    (panel.scope === undefined || row.providerId === panel.scope) &&
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

/**
 * The single-line write subject, captured at open and never re-derived. The two
 * strings are kept SHORT on purpose: at the 400px minimum supported pane the
 * compact strip gives its label 40% of the sheet (a measured 120px), so a longer
 * sentence would be ellipsized there — the subject must stay completely visible
 * at every supported width (real-pane check: its rendered advance stays inside
 * the font's own band instead of stopping at the cap).
 */
export function subjectLine(panel: ModelPickerPanel): string {
  return panel.request.subject.sessionless ? 'Default model' : 'Session model'
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

/** One inert fact row of the panel's configured selection state. */
export interface ModelPickerFact {
  readonly id: string
  readonly label: string
  readonly detail: string
}

/** The compact one-token value of a configured selection. The details card is
 *  narrow, and the surround spaces of a `a / b / c` form cost a whole extra
 *  wrapped line under the worst-case width bound. */
const factValue = (selection: { provider: string; model: string; reasoningEffort?: string }): string =>
  `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : `/${selection.reasoningEffort}`}`

/**
 * The configured-selection facts shown in the details area, in ONE place each:
 * `Current` only for a live Session (never for a sessionless subject) and
 * `Default` from `directory.default` — including its own effort, which the
 * row-level projection cannot carry when the default is not the current model.
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
 * on the model list — so no action there can be activated from the keyboard. The
 * `▸` cue is a promise about Enter and `focusedAction`'s fallback is a statement
 * about which action Enter runs, so BOTH are meaningful only where this holds:
 * everywhere else the bar must read as having no keyboard focus instead of
 * marking `Cancel` and then swallowing the Enter that cue announced.
 */
export function actionKeyboardLive(panel: ModelPickerPanel): boolean {
  return panel.phase === 'ready' || panel.phase === 'error'
}

/**
 * The single-line keyboard hint of the current zone (rendered by the model list
 * page's details column only, and counted by the layout budget, so the two can
 * never disagree).
 *
 * It never names a BUSINESS action: in the action bar `Enter` runs whichever
 * action that bar has FOCUSED — the `▸ label` cue says which — so the hint only
 * explains how the bar is driven instead of claiming Enter applies. In the list
 * the hint names the zone `Tab` reaches NEXT, which is the effort selector
 * whenever the highlighted model advertises efforts (mirrors the frozen
 * `tabZone` cycle). The drill-down pages render no column, so they carry no hint
 * at all. Every hint stays inside one worst-case line so it never eats the
 * layout budget.
 */
export function zoneHintText(panel: ModelPickerPanel): string {
  if (panel.phase === 'pending') return 'Selecting…'
  // A running (re-)read answers the keyboard with at most the search box, so the
  // hint names the READ instead of promising a Tab/←→ the phase will refuse.
  if (panel.phase === 'loading') return 'Reading…'
  if (panel.phase === 'error') return 'Retry first'
  if (panel.zone === 'effort') return '↑↓ draft'
  if (panel.zone === 'primary-action') return '←→ · Enter'
  return modelChoices(highlightedModel(panel)).length > 0 ? 'Tab: effort' : 'Tab: actions'
}

/* --------------------------------------------------------------- action bar */

/** The single visible Primary Action of the current phase. Only this action may
 *  ever commit; while the directory read failed it IS the read-only Retry. The
 *  ready labels are Owner-frozen: a sessionless write confirms the model and saves
 *  it as the future default in ONE operation, a live write switches the Session's
 *  model. Naming the UI never changes what the one writer does. */
function primaryAction(panel: ModelPickerPanel): PickerAction {
  if (panel.phase === 'pending') {
    return { id: 'apply', label: 'Selecting…', primary: true, disabled: true }
  }
  const label = panel.phase === 'error'
    ? 'Retry'
    : panel.request.subject.sessionless ? 'Choose & Save as Default' : 'Switch Model'
  return {
    id: 'apply',
    label,
    primary: true,
    // Loading admits no write, so the action must LOOK unavailable rather than
    // silently refusing a click (a Retry keeps the previous rows selectable).
    disabled: panel.phase === 'loading'
      || (panel.phase !== 'error' && highlightedModel(panel) === undefined)
      ? true
      : undefined,
  }
}

/** The partial-read recovery action: the reached providers stay usable and this
 *  re-reads the whole directory through the command's one read owner. */
function retryAction(panel: ModelPickerPanel): PickerAction | undefined {
  return panel.phase === 'ready' && panel.failures.length > 0
    ? { id: 'retry', label: 'Retry failed providers' }
    : undefined
}

/**
 * The action bar for the CURRENT phase and page: the ONE owner of "which actions
 * exist".
 *
 * The MAIN page keeps only the three intuitive operations — `Cancel`, the reading
 * entry `Full details…` and the one Primary Action. The complete Effort list is a
 * DETAILS-page entry (`All effort levels…`), so the main footer never repeats an
 * effort shortcut next to the details drill-down. The details and effort pages are
 * content pages: each names the page it really returns to. A partial read's `Retry
 * failed providers` stays available wherever the phase is ready.
 *
 * The view renders exactly this list and the key map moves the keyboard focus
 * across it, so a visible action can never be unreachable or a no-op.
 */
export function pickerActions(panel: ModelPickerPanel): PickerAction[] {
  const actions: PickerAction[] = [{ id: 'close', label: 'Cancel', end: true }]
  // Only `ready` admits browsing: a loading panel admits the search box and
  // Cancel, an admitted write admits Cancel, and a failed read admits only the
  // action bar's Retry. Rendering a browse action the phase refuses would make
  // it a visible no-op (and a keyboard focus target that cannot act).
  if (panel.phase !== 'ready') {
    actions.push(primaryAction(panel))
    return actions
  }
  const retry = retryAction(panel)
  const row = highlightedModel(panel)
  if (panel.page === 'details') {
    actions.push({ id: 'back', label: 'Back to models' })
    // `All effort levels…` exists only when this model really advertises effort
    // options: an empty full list would be a dead entry.
    if (modelChoices(row).length > 0) {
      actions.push({ id: 'effort-page', label: 'All effort levels…' })
    }
  } else if (panel.page === 'effort') {
    // The effort page IS the selector, so its own bar offers no second,
    // contradictory entry; Back names the page it was opened FROM.
    actions.push({
      id: 'back',
      label: panel.previousPage === 'details' ? 'Back to details' : 'Back to models',
    })
  } else {
    actions.push({ id: 'details', label: 'Full details…', disabled: row === undefined ? true : undefined })
  }
  if (retry !== undefined) actions.push(retry)
  actions.push(primaryAction(panel))
  return actions
}

/** The action that owns Enter right now.
 *
 *  The frozen default is the Primary Action (an explicit bar focus outside the
 *  current phase or page falls back to it), but a DISABLED action owns no Enter and
 *  shows no cue: when the Primary cannot act — a read that failed, a directory with
 *  no selectable model, a search with no match — focus falls back to the last action
 *  that CAN act (`Cancel` is always enabled), instead of parking the keyboard on a dead
 *  entry that no `▸` marks and Enter does nothing with. */
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

/** The model-details page's inert fact rows (a compact or wide-list page).
 *
 *  EVERY fact value goes through {@link factRowItems}: a row renders ONE line and
 *  ellipsizes what does not fit, so a long name/provider/ID/configured value can
 *  only be read completely when its continuation rows exist AND each fragment
 *  fits the row's own measured one-line slot. `wide` selects the slot/bound of
 *  the layout the page is rendered in. The values are the directory's own — this
 *  page never rewrites or re-derives what the writer sends. */
export function detailFactItems(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow,
  wide: boolean,
): PickerItem[] {
  const description = advertisedDescription(panel, row)
  const draft = draftedEffort(panel, row)
  const draftLabel = modelChoices(row).find((choice) => choice.value === draft)?.label
  return [
    ...factRowItems('fact-model', 'Model', row.modelName, wide),
    ...factRowItems('fact-provider', 'Provider', `${row.providerName} (${row.providerId})`, wide),
    ...factRowItems('fact-id', 'ID', row.modelId, wide),
    // The configured facts come from the ONE directory DTO, so a Default effort
    // is never lost when the default is not the current model.
    ...configuredFacts(panel).flatMap((fact) => factRowItems(fact.id, fact.label, fact.detail, wide)),
    // A long description is wrapped into complete, readable rows.
    ...(description === undefined ? [] : factRowItems('fact-description', 'Description', description, wide)),
    ...(draftLabel === undefined ? [] : factRowItems('fact-draft', 'Draft effort', draftLabel, wide)),
    ...(panel.notice === '' ? [] : factRowItems('fact-notice', 'Status', panel.notice, wide)),
  ]
}

/** The details page's cursor, clamped to the rows it currently offers. */
export function detailCursor(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow | undefined,
  wide: boolean,
): number {
  if (row === undefined) return 0
  const count = detailFactItems(panel, row, wide).length
  return Math.min(Math.max(panel.factCursor, 0), Math.max(0, count - 1))
}

/* ------------------------------------------------------------ layout budget */

/**
 * The wide preview's own line budget: every rendered character is priced at the
 * shared worst-case glyph advance, so the resulting line count is an UPPER BOUND
 * for any glyph mix. The content width of the wide details card / radio row is
 * 340px of box, 296px of slot and 248px of text.
 */
const WIDE_TEXT_PX = 248
/** The columns one wide line may carry under that bound. */
const WIDE_TEXT_COLUMNS = Math.floor(WIDE_TEXT_PX / PICKER_GLYPH_PX)

/*
 * Measured vertical geometry of the wide side preview (real Tern 0.7.2,
 * production presenter): one details line 28.2px, one single-line radio row
 * 22.2px, ~20px more per extra LABEL line inside a row, ~16px between the two
 * cards and 10px of row-column padding. The box itself follows the pane height —
 * 594px at 1280x800, 494px at 1200x700, 434px at 1100x640, 394px at 1280x600
 * (pane height - 206, its content starting 20px lower) — and the SDK's resize
 * event carries only COLUMNS, so the budget is a FIXED floor
 * ({@link WIDE_USABLE_HEIGHT_PX}): a taller pane keeps the same conservative
 * decision, which is safe, and a shorter pane is outside the documented support
 * envelope described on that constant.
 */
const WIDE_LINE_PX = 28.2
const WIDE_ROW_PX = 22.2
const WIDE_LABEL_LINE_PX = 20
const WIDE_CARD_GAP_PX = 16
/** The measured bottom padding of a card body whose last child is a ROW COLUMN
 *  (`22.2px` per single-line row is a 20.2px line plus the column's 2px gap, so
 *  the body's 10px bottom padding is not yet covered). A card body whose last
 *  child is a text line already covers its padding with the per-line gap. */
const WIDE_CARD_PAD_PX = 10
/**
 * The usable content height the fit budget is priced against: the SHORTEST
 * supported wide pane, measured in the real Tern production presenter. One pane
 * height costs 226px of chrome (the sheet's head and the action bar), so
 * 1280x600 gives a 394px details box whose content starts 20px lower = 374px
 * (1100x640 = 414px, 1200x700 = 474px, 1280x800 = 574px).
 *
 * This is a LAYOUT BUDGET, not an SDK guarantee: `SessionCaps` carries only
 * `cols`/`cell` and the resize event only `cols`/`cell`/`visible`, so the
 * presenter cannot detect a shorter pane and cannot degrade further. Panes
 * below this floor are an explicitly accepted limitation, documented in
 * `docs/tern-tsp/model-selection.md` and never claimed as automatically safe.
 */
const WIDE_USABLE_HEIGHT_PX = 374

/** The identity fields the action-first column shows, each on at most this many
 *  pre-wrapped lines (the complete value stays readable in the Details page). */
const WIDE_IDENTITY_MAX_LINES = 2

/**
 * The wide details column is ACTION-FIRST: it shows the model identity
 * (name head, provider, ID) pre-wrapped to at most {@link WIDE_IDENTITY_MAX_LINES}
 * provable lines per field, and gives the vertical space to the Reasoning Effort
 * radio rows. The complete description and the extended facts live in the Details
 * page, so a long description can never decide whether the effort stays inline.
 */
export function wideIdentityLines(row: ModelPickerModelRow): readonly string[] {
  const field = (text: string): string[] => {
    const lines = wrapColumns(text, WIDE_TEXT_COLUMNS)
    if (lines.length <= WIDE_IDENTITY_MAX_LINES) return [...lines]
    return [
      ...lines.slice(0, WIDE_IDENTITY_MAX_LINES - 1),
      clampColumns(lines.slice(WIDE_IDENTITY_MAX_LINES - 1).join(' '), WIDE_TEXT_COLUMNS),
    ]
  }
  return [
    ...field(`Provider: ${row.providerName} (${row.providerId})`),
    ...field(`ID: ${row.modelId}`),
  ]
}

/**
 * Whether the wide side preview provably presents the WHOLE details card and
 * EVERY advertised effort. When it cannot, the wide shell is KEPT (provider
 * scopes + model list + the details column) and only the current model's full
 * details/effort move into the same picker's drill-down pages.
 *
 * It prices every rendered field and every effort LABEL at the measured
 * widest-glyph advance (an upper bound for any glyph mix, unlike a terminal
 * column count), then compares the resulting height against the fixed floor of
 * the shortest SUPPORTED wide pane. Anything that does not fit switches the same
 * picker to the bounded column + drill-down pages, so a candidate can never be
 * selected while it sits outside the preview.
 */
export function widePreviewFits(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow | undefined,
): boolean {
  // A missing selection or a model with NO effort still renders the identity,
  // which can overflow on its own at a short pane: the budget never skips it.
  if (row === undefined) return true
  return widePreviewNeededPx(panel, row) <= WIDE_USABLE_HEIGHT_PX
}

/**
 * The details card's head: the model name folded to ONE provable line. The
 * complete name stays readable in the model list row and on the Details page.
 */
export function modelHeadLine(row: ModelPickerModelRow): string {
  return clampColumns(oneLine(row.modelName), WIDE_TEXT_COLUMNS)
}

/**
 * The single one-line summary of the action-first column: the transient notice
 * when there is one (its complete text is the Details page's `Status` fact),
 * otherwise a one-line description summary. It is ALWAYS exactly one rendered
 * line, so a long description is never a reason to drill down.
 */
export function wideSummaryLine(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow | undefined,
): string | undefined {
  if (panel.notice !== '') return clampColumns(oneLine(panel.notice), WIDE_TEXT_COLUMNS)
  if (row === undefined) return undefined
  const description = advertisedDescription(panel, row)
  return description === undefined ? undefined : clampColumns(oneLine(description), WIDE_TEXT_COLUMNS)
}

/**
 * The single OPTIONAL line of the action-first column: shown only while the
 * budget still has room for exactly one more measured line.
 */
export function widePreviewOptionalLine(
  panel: ModelPickerPanel,
  row: ModelPickerModelRow | undefined,
): string | undefined {
  const summary = wideSummaryLine(panel, row)
  if (summary === undefined || row === undefined) return summary
  const roomForOneMore = widePreviewNeededPx(panel, row) + WIDE_LINE_PX <= WIDE_USABLE_HEIGHT_PX
  return roomForOneMore ? summary : undefined
}

/**
 * The vertical space the full details card + every effort radio row need, in
 * pixels. Exported so a metric or a probe can price a model without re-deriving
 * the rule; the production decision compares it against the fixed floor
 * ({@link WIDE_USABLE_HEIGHT_PX}), so pricing it against other pane heights is a
 * CAPACITY curve and not what the presenter does at those heights.
 */
export function widePreviewNeededPx(panel: ModelPickerPanel, row: ModelPickerModelRow): number {
  const choices = modelChoices(row)
  // The identity (two clamped lines) plus the keyboard hint; the description is
  // NOT part of the decision.
  const bodyLines = wideIdentityLines(row).length + 1
  const rowPx = choices.reduce(
    (total, choice) =>
      total + WIDE_ROW_PX
      + (Math.max(1, wrapColumns(choice.label, WIDE_TEXT_COLUMNS).length) - 1) * WIDE_LABEL_LINE_PX,
    0,
  )
  // One card head (details, clamped to one provable line) plus, when the model
  // advertises efforts, the effort head, the card gap, the radio rows and the
  // row column's own bottom padding.
  return WIDE_LINE_PX
    + bodyLines * WIDE_LINE_PX
    + (choices.length === 0 ? 0 : WIDE_LINE_PX + WIDE_CARD_GAP_PX + rowPx + WIDE_CARD_PAD_PX)
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
