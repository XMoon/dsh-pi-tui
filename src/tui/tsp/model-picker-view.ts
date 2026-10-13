/** Node construction for the native TSP `/model` presentation.
 *
 * Pure: state in, node tree out. Every interactive node binds a panel INTENT
 * through `deps.bind`, so a click lands on the same admission point as a key —
 * this module never mutates state, never writes and never reads the SDK.
 *
 * Layout contract (Owner-frozen, list-first):
 *  - the catalogue (`models`) is ONE native picker at every pane width: a single
 *    column of model rows carrying the model name, a deterministic provider mark,
 *    its real `current`/`Default` badges, grouped as `Current / Default` first and
 *    then by provider. There is no provider sidebar and no side column; a model is
 *    entered with `activate`/`Enter` and the ONE write is an explicit footer
 *    action at every width. A wide pane adds only a compact READ-ONLY summary
 *    under the list — never a required operation;
 *  - the model's OVERVIEW is the same picker, showing the model's every advertised
 *    effort candidate first (or the explicit `Not available`) and the read-only
 *    Full details entry;
 *  - the read-only Full details page is a native `overlay` Reader (`ui.text` with
 *    the client's own wrapping and a native scroll container) grouped into
 *    Identity / Configuration / Description: a picker row is ONE ellipsized line
 *    and cannot carry a long value. No overlay ON TOP of a picker, no `ui.el`, no
 *    self-drawn button, no global action menu.
 * @module tui/tsp/model-picker-view
 */
import { ui, span, type Node } from '@stencil-hq/tern'
import type { PickerAction, PickerColumn, PickerGroup, PickerItem, PickerProps } from '@stencil-hq/tern'
import type { ModelPickerFailureRow, ModelPickerModelRow } from '../pickers/model-directory.ts'
import type { ModelPickerIntent } from './model-picker-intents.ts'
import {
  FAILURE_RETRY_ID,
  actionKeyboardLive,
  detailReaderGroups,
  draftedEffort,
  failureRowId,
  focusedAction,
  highlightedModel,
  modelChoices,
  modelRowId,
  overviewItems,
  overviewSelected,
  pickerActions,
  pickerSubtitle,
  pickerTitle,
  providerMark,
  readerHead,
  summaryFacts,
  visibleModels,
  type ModelPickerPanel,
} from './model-picker-state.ts'

export interface ModelPickerViewDeps {
  /** True when the pane paints the `lg` catalogue sheet and its compact
   *  selected-model summary (the MEASURED {@link wideCatalog} rule). Informational
   *  chrome only: it never decides what can be reached or written. */
  readonly wide: boolean
  /** Bind one intent to THIS frame's revision (admission lives in the presenter). */
  readonly bind: (intent: ModelPickerIntent) => () => void
}

/**
 * The inert row of a provider whose catalogue read failed. The client shows a
 * disabled row's REASON only as its title (measured: the `detail` of a disabled
 * row is not painted), so the row states the provider and carries the message
 * where the client really can surface it; the group head above it says why.
 */
function failureItem(failure: ModelPickerFailureRow): PickerItem {
  return {
    id: failureRowId(failure.providerId),
    label: failure.providerName,
    detail: failure.message,
    title: failure.message,
    disabled: failure.message,
    dot: 'error',
  }
}

/**
 * The RESERVED group ids of the two groups that are not a provider's own
 * catalogue. They use the module's NUL-prefixed convention so a provider whose id
 * happens to read like one of them cannot merge its own group with a pinned one.
 */
const PINNED_GROUP_ID = '\u0000current-default'
const UNAVAILABLE_GROUP_ID = '\u0000unavailable'

/** The pinned group head: the rows that are really the configured selection. */
const PINNED_GROUP_LABEL = 'Current / Default'
/** The partial-failure group head: the providers whose read failed, plus the one
 *  read-only operation row that re-reads them. */
const UNAVAILABLE_GROUP_LABEL = 'Unavailable providers'

/**
 * The catalogue's order: the REAL configured rows first (`Current / Default`,
 * each model appearing exactly ONCE), then one group per provider for everything
 * else, then — only while part of the directory failed — the `Unavailable
 * providers` group with the inert failed rows and the ONE read-only
 * `Retry failed providers` row. No row is ever listed twice and no `Recent` group
 * is invented.
 */
function modelOrder(panel: ModelPickerPanel): (string | PickerGroup)[] {
  const visible = visibleModels(panel)
  const order: (string | PickerGroup)[] = []
  const pinned = visible.filter((row) => row.isCurrent || row.isDefault)
  if (pinned.length > 0) {
    order.push({ group: PINNED_GROUP_ID, label: PINNED_GROUP_LABEL, count: pinned.length })
    for (const row of pinned) order.push(modelRowId(row))
  }
  for (const group of panel.directory?.directory.groups ?? []) {
    const rows = visible.filter((row) => row.providerId === group.id && !pinned.includes(row))
    if (rows.length === 0) continue
    order.push({ group: group.id, label: group.name, count: rows.length })
    for (const row of rows) order.push(modelRowId(row))
  }
  if (panel.failures.length > 0) {
    order.push({ group: UNAVAILABLE_GROUP_ID, label: UNAVAILABLE_GROUP_LABEL, count: panel.failures.length + 1 })
    for (const failure of panel.failures) order.push(failureRowId(failure.providerId))
    order.push(FAILURE_RETRY_ID)
  }
  return order
}

/**
 * The catalogue's ONE optional fact column. The client gives it a FIXED 106px of
 * the row's text area (measured), and it hides it by itself on the narrowest
 * panes, so it buys the drafted effort at the first level without taking anything
 * from the model NAME — the label keeps its intrinsic width and the row's provider
 * detail is what yields. The Overview remains the place where a draft is CHANGED.
 */
const EFFORT_COLUMN: PickerColumn = { id: 'effort', head: 'Effort', format: 'text', priority: 1, min: 6 }

/**
 * The catalogue's rows: ONE row per model — the model name as the main
 * information, the provider as a deterministic MARK, its real `current`/`Default`
 * badges (never the browse highlight), its drafted effort in the ONE fact column
 * and its complete id available to the client as the row's `title`. An exhausted
 * or partially failed catalogue appends the inert failure rows and the one
 * read-only Retry row.
 */
function modelItems(panel: ModelPickerPanel): PickerItem[] {
  const items: PickerItem[] = visibleModels(panel).map((row) => {
    const draft = draftedEffort(panel, row)
    const effort = modelChoices(row).find((choice) => choice.value === draft)?.label
    return {
      id: modelRowId(row),
      label: row.modelName,
      mark: providerMark(row),
      detail: row.providerName,
      title: row.modelId,
      ...(effort === undefined ? {} : { facts: { effort } }),
      badges: [
        ...(row.isCurrent ? [{ text: 'current' }] : []),
        ...(row.isDefault ? [{ text: 'Default' }] : []),
      ],
    }
  })
  items.push(...panel.failures.map(failureItem))
  if (panel.failures.length > 0) items.push({ id: FAILURE_RETRY_ID, label: 'Retry failed providers' })
  return items
}

/** How many rows the catalogue really lists (it appends the failure rows and the
 *  one Retry row to the models). */
function catalogueTotal(panel: ModelPickerPanel): number {
  return panel.rows.length + panel.failures.length + (panel.failures.length === 0 ? 0 : 1)
}

/**
 * The rendered action bar: the state module owns WHICH actions exist (and which
 * the current phase admits), and the focused one — only while the action zone
 * owns the keyboard — carries the app-rendered shape cue, because the SDK has
 * no focus affordance for a button. A phase whose bar no key can run (an
 * admitted write, a running re-read) marks nothing: the cue promises Enter.
 */
function renderedActions(panel: ModelPickerPanel): PickerAction[] {
  const focused = panel.zone === 'primary-action' && actionKeyboardLive(panel)
    ? focusedAction(panel).id
    : undefined
  return pickerActions(panel).map((action) =>
    // A DISABLED action owns no Enter, so it must not carry the focus cue.
    action.id === focused && action.label !== undefined && action.disabled !== true
      ? { ...action, label: `▸ ${action.label}` }
      : action,
  )
}

/** Which picker region the SDK should show as focused. The primary action has no
 *  native region (the action bar shape change carries it), so the list owns the
 *  focus everywhere else — including the read-only summary, which is never a
 *  keyboard region. */
function nativeFocus(panel: ModelPickerPanel): PickerProps['focus'] {
  if (panel.phase === 'error' || panel.zone === 'primary-action') return undefined
  return 'list'
}

/** The state/notice surface: one message, in one place, per size. */
function pickerState(panel: ModelPickerPanel): Pick<PickerProps, 'state' | 'message' | 'empty'> {
  return {
    state: panel.phase === 'loading' ? 'loading' : panel.phase === 'error' ? 'error' : 'ready',
    ...(panel.notice === '' ? {} : { message: panel.notice }),
    empty: 'No model is advertised by the configured providers.',
  }
}

/**
 * The catalogue's compact selected-model summary: the HIGHLIGHTED model's
 * read-only facts, in the picker's own below-list preview region. It carries no
 * handler, no candidate and no write, so hiding it (narrow pane) can never remove
 * a required operation.
 */
function summaryNode(panel: ModelPickerPanel, row: ModelPickerModelRow): Node {
  return ui.col(
    { key: 'model-summary' },
    ui.kv({
      key: 'model-summary-facts',
      layout: 'inline',
      items: summaryFacts(panel, row).map((fact) => ({ k: fact.label, v: fact.value })),
    }),
  )
}

/**
 * The key PREFIX of the Reader's scrollable content column.
 *
 * The FULL key carries the panel serial and the frame revision (exactly like the
 * picker's own key), so a node id of a RETIRED frame is never reused by a later
 * Reader: the layer region's root id is the fixed region name and the root's own
 * key never reaches its children, so a constant child key would make the Reader's
 * ids stable across revisions and panels. The presenter resolves the column by
 * this prefix from the very frame it built and hands its real wire id to the one
 * Surface owner, so the native scroll op addresses a node this frame really built
 * instead of a guessed id.
 */
export const MODEL_DETAILS_BODY_KEY_PREFIX = 'model-details-body-'
const MODEL_DETAILS_READER_KEY = 'model-details-reader'
const MODEL_DETAILS_BACK_KEY = 'model-details-back'

/**
 * The read-only Reader: the `details` page's ONE node tree, in the layer region,
 * as a native `overlay` instead of a picker.
 *
 * A picker row renders ONE measured line and ellipsizes the rest, so it cannot
 * be a reading surface for a long value; the overlay's body is a native scroll
 * container the app addresses with the SDK's `scroll` op, and `ui.text` wraps at
 * the width the client really has instead of at a pre-computed column budget.
 * The facts are grouped (Identity / Configuration / Description) so the page reads
 * as a product detail view rather than as a stack of unlabelled properties: each
 * group is a `ui.col` whose muted head line and following `ui.rule` separate it,
 * with a `lg` spacer between groups, because a bare `ui.section` head measures a
 * SMALLER gap between groups than inside one (measured: 2px against 8px, while
 * this structure measures 20px against 2px). The `Back` row is the page's one
 * interactive node (bound to the SAME `back` intent `Esc` uses, which is the only
 * way back from the tail); the page has no candidate, no writer and no second
 * action, so it can never write and never needs a second input authority.
 */
function detailsReader(panel: ModelPickerPanel, deps: ModelPickerViewDeps): Node {
  const row = highlightedModel(panel)
  const groups = row === undefined ? [] : detailReaderGroups(panel, row)
  // The frame-scoped suffix is what keeps a retired Reader's node ids retired.
  const scope = `${panel.serial}-rev-${panel.revision}`
  return ui.overlay(
    { key: `${MODEL_DETAILS_READER_KEY}-${scope}`, head: readerHead(panel), size: 'lg', modal: true },
    ui.row(
      { key: `${MODEL_DETAILS_BACK_KEY}-${scope}`, onClick: deps.bind({ kind: 'back' }) },
      ui.text(span('Back', 'accent')),
    ),
    ui.col(
      { key: `${MODEL_DETAILS_BODY_KEY_PREFIX}${scope}` },
      ...(row === undefined
        ? [ui.text(span('No model is selected.', 'muted'))]
        : [
            // The transient read/write notice leads the page: it describes the state
            // the facts below were read in.
            ...(panel.notice === '' ? [] : [ui.text({ text: panel.notice, wrap: 'word' })]),
            ...groups.flatMap((group, index) => [
              ui.col(
                { key: `reader-group-${group.id}`, gap: 'xs' },
                ui.text(span(group.head, 'muted')),
                ...group.facts.flatMap((fact) => [
                  ...(fact.label === undefined ? [] : [ui.text(span(fact.label, 'muted'))]),
                  ui.text({ key: fact.id, text: fact.value, wrap: fact.wrap }),
                ]),
              ),
              // The rule closes the group, so it is never painted after the last one.
              ...(index === groups.length - 1 ? [] : [ui.rule(), ui.spacer({ size: 'lg' })]),
            ]),
          ]),
    ),
  )
}

function modelListPicker(
  panel: ModelPickerPanel,
  deps: ModelPickerViewDeps,
  key: string,
): Node {
  const row = highlightedModel(panel)
  const page = panel.page
  const items = page === 'models' ? modelItems(panel) : overviewItems(panel)
  const props: PickerProps & { readonly key: string } = {
    key,
    title: pickerTitle(panel),
    layout: 'rows',
    size: deps.wide ? 'lg' : 'md',
    // The ONLY preview region the catalogue has is its compact READ-ONLY summary;
    // every page's real operations live in its own main list at every width.
    preview: page === 'models' && deps.wide && row !== undefined ? 'below' : 'none',
    query: page === 'models' ? panel.query : '',
    cursor: page === 'models' ? panel.cursor : 0,
    ...(page === 'models' ? { placeholder: 'Search models…' } : {}),
    items,
    order: page === 'models' ? modelOrder(panel) : items.map((item) => item.id),
    total: page === 'models' ? catalogueTotal(panel) : items.length,
    ...(page === 'models' ? { columns: [EFFORT_COLUMN] } : {}),
    selected: page === 'models' ? panel.selected : overviewSelected(panel),
    current: page === 'models' ? panel.rows.filter((item) => item.isCurrent).map(modelRowId) : [],
    subtitle: pickerSubtitle(panel),
    focus: nativeFocus(panel),
    ...pickerState(panel),
    actions: renderedActions(panel),
  }
  if (page === 'models' && deps.wide && row !== undefined) return ui.picker(props, summaryNode(panel, row))
  return ui.picker(props)
}

/**
 * The whole layer for one frame. The node id carries the panel serial AND the
 * revision, so an event or `onClick` from an earlier frame can only ever be
 * refused by `targets`/admission — never silently applied to the new one.
 *
 * The read-only `details` page REPLACES the picker with the native Reader (the
 * page is the SAME logical page and the same layer; it is not a second
 * simultaneously-active surface), so the layer region never carries a picker
 * whose rows could be operated behind the reader.
 */
export function modelPickerLayer(panel: ModelPickerPanel, deps: ModelPickerViewDeps): Node {
  const key = `model-${panel.serial}-rev-${panel.revision}`
  return ui.col(
    { key: `model-layer-${panel.serial}-rev-${panel.revision}` },
    panel.page === 'details' ? detailsReader(panel, deps) : modelListPicker(panel, deps, key),
  )
}
