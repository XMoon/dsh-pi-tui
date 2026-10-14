/** Node construction for the native TSP `/model` presentation.
 *
 * Pure: state in, node tree out. Every interactive node binds a panel INTENT
 * through `deps.bind`, so a click lands on the same admission point as a key —
 * this module never mutates state, never writes and never reads the SDK.
 *
 * Layout contract (Owner-frozen, TWO pages):
 *  - the catalogue (`models`) is ONE native picker, the client's `md` dialog at
 *    EVERY pane width: a single column of model rows carrying the model name, a
 *    deterministic provider mark and its real lowercase `current` / `default` state
 *    chips, grouped as `Current · Default` first and then by provider. There is no
 *    provider sidebar, no side column, no preview region and no fact column; the
 *    Reasoning Effort is edited in the catalogue's own native `strip` (one chip per
 *    candidate of the highlighted model, the local draft marked `on`) and the ONE
 *    write is an explicit footer action at every width;
 *  - a row activation (`activate` — the client's own click on the already-highlighted
 *    row — or `Enter`) opens the read-only Full details page DIRECTLY: there is no
 *    intermediate page and no second-level effort menu;
 *  - that read-only page is a native `overlay` Reader (`ui.text` with the client's
 *    own wrapping and a native scroll container) grouped into Identity /
 *    Configuration / Description: a picker row is ONE ellipsized line and cannot
 *    carry a long value. No overlay ON TOP of a picker, no `ui.el`, no self-drawn
 *    button, no global action menu.
 * @module tui/tsp/model-picker-view
 */
import { ui, span, type Node } from '@stencil-hq/tern'
import type { PickerAction, PickerGroup, PickerItem, PickerProps } from '@stencil-hq/tern'
import type { ModelPickerFailureRow } from '../pickers/model-directory.ts'
import type { ModelPickerIntent } from './model-picker-intents.ts'
import {
  CATALOGUE_WINDOW_ROWS,
  FAILURE_RETRY_ID,
  STRIP_LABEL,
  actionKeyboardLive,
  catalogueRowIds,
  detailReaderGroups,
  draftedEffort,
  effortItemId,
  failureRowId,
  focusedAction,
  highlightedModel,
  modelRowId,
  pickerActions,
  pickerSubtitle,
  pickerTitle,
  providerMark,
  readerHead,
  stripItems,
  stripLabelColumns,
  stripOffered,
  visibleModels,
  type ModelPickerPanel,
} from './model-picker-state.ts'

export interface ModelPickerViewDeps {
  /** The pane width the client's geometry was reconstructed from (`cols *
   *  cell.w`), which prices the strip's own chip capacity. */
  readonly paneWidth: number
  /** Bind one intent to THIS frame's revision (admission lives in the presenter). */
  readonly bind: (intent: ModelPickerIntent) => () => void
}

/**
 * The inert row of a provider whose catalogue read failed. The client shows a
 * disabled row's REASON only as its title (measured: the `detail` of a disabled
 * row is not painted), so the row carries the message where the client really can
 * surface it AND states its state in WORDS: the design language forbids signalling
 * a disabled row by colour alone, so the label ends with the `unavailable` word
 * (`unavailable` is also the state-chip word its bracket classes use).
 */
function failureItem(failure: ModelPickerFailureRow): PickerItem {
  return {
    id: failureRowId(failure.providerId),
    label: `${failure.providerName} · unavailable`,
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

/** The pinned group head: the rows that are really the configured selection. The
 *  design language allows exactly ONE separator (` · `) for joined facts. */
const PINNED_GROUP_LABEL = 'Current · Default'
/** The partial-failure group head: the providers whose read failed, plus the one
 *  read-only operation row that re-reads them. */
const UNAVAILABLE_GROUP_LABEL = 'Unavailable providers'

/**
 * The catalogue's order: the REAL configured rows first (`Current · Default`,
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
  const window = windowIds(panel)
  if (window === undefined) return order
  // Keep the window's rows AND the group head that introduces the first of them, so a
  // windowed slice still shows which provider its rows belong to. A head is only kept
  // when a row of its own group follows it inside the window.
  const sliced: (string | PickerGroup)[] = []
  let pending: PickerGroup | undefined
  for (const entry of order) {
    if (typeof entry !== 'string') {
      pending = entry
      continue
    }
    if (!window.has(entry)) continue
    if (pending !== undefined) {
      sliced.push(pending)
      pending = undefined
    }
    sliced.push(entry)
  }
  return sliced
}

/**
 * The catalogue's rows: ONE row per model — the model name as the main
 * information, the provider as a deterministic MARK, its real `current`/`Default`
 * badges (never the browse highlight) and its complete id available to the client
 * as the row's `title`. The row deliberately carries NO per-row effort fact: the
 * effort is edited in the page's own `strip` below the list, where every candidate
 * of the HIGHLIGHTED model is visible at once (the previous right-hand fact column
 * cost 106px of the row's text area and read as a column detached from its model).
 * An exhausted or partially failed catalogue appends the inert failure rows and
 * the one read-only Retry row.
 */
/**
 * The row ids the catalogue really sends: the window `panel.windowStart` covers, or
 * `undefined` when the whole catalogue already fits. A short list is sent whole, so a
 * small fixture behaves exactly as it always did.
 *
 * The window exists because the client re-anchors the selected row on every `selected`
 * change while its list can scroll (see {@link CATALOGUE_WINDOW_ROWS}): a window that
 * fits the list box leaves it nothing to scroll, so a click cannot move the viewport.
 */
function windowIds(panel: ModelPickerPanel): ReadonlySet<string> | undefined {
  const ids = catalogueRowIds(panel)
  if (ids.length <= CATALOGUE_WINDOW_ROWS) return undefined
  const last = Math.max(ids.length - CATALOGUE_WINDOW_ROWS, 0)
  const start = Math.min(Math.max(panel.windowStart, 0), last)
  return new Set(ids.slice(start, start + CATALOGUE_WINDOW_ROWS))
}

function modelItems(panel: ModelPickerPanel): PickerItem[] {
  const items: PickerItem[] = visibleModels(panel).map((row) => ({
    id: modelRowId(row),
    label: row.modelName,
    mark: providerMark(row),
    detail: row.providerName,
    title: row.modelId,
    badges: [
      ...(row.isCurrent ? [{ text: 'current' }] : []),
      ...(row.isDefault ? [{ text: 'default' }] : []),
    ],
  }))
  items.push(...panel.failures.map(failureItem))
  if (panel.failures.length > 0) items.push({ id: FAILURE_RETRY_ID, label: 'Retry failed providers' })
  const window = windowIds(panel)
  return window === undefined ? items : items.filter((item) => window.has(item.id))
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
 * no focus affordance for a button. The cue is the `Verb [Enter]` key badge, which
 * states which key the focused action really owns. A phase whose bar no key can run
 * (an admitted write, a running re-read) marks nothing: the badge promises Enter.
 */
function renderedActions(panel: ModelPickerPanel): PickerAction[] {
  const focused = panel.zone === 'primary-action' && actionKeyboardLive(panel)
    ? focusedAction(panel).id
    : undefined
  return pickerActions(panel).map((action) =>
    // A DISABLED action owns no Enter, so it must not carry the key badge.
    // The badge is the design language's `Verb [Key]` affordance form: `Enter` is a
    // real key of the focused action, so the badge states a fact instead of
    // inventing a focus glyph (`▸` is the DISCLOSURE glyph and never means
    // "selected"; `[Switch]` would give a verb label brackets).
    action.id === focused && action.label !== undefined && action.disabled !== true
      ? { ...action, label: `${action.label} [Enter]` }
      : action,
  )
}

/** Which picker region the SDK should show as focused. The action bar has no native
 *  region (its focused entry carries the `[Enter]` badge instead), so everywhere else
 *  the focus follows the keyboard's own zone: the strip while it owns the keyboard,
 *  the list otherwise. */
function nativeFocus(panel: ModelPickerPanel): PickerProps['focus'] {
  if (panel.phase === 'error' || panel.zone === 'primary-action') return undefined
  // The client really paints a per-REGION focus class (`pk-sheet f-list` /
  // `f-strip`, measured), so asking for the region the keyboard is really in is a
  // fact the client can show. The action bar has no such value (its focused entry is
  // marked by the `[Enter]` badge).
  return panel.zone === 'strip' && stripOffered(panel) ? 'strip' : 'list'
}

/** The state/notice surface: one message, in one place, per size. */
function pickerState(panel: ModelPickerPanel): Pick<PickerProps, 'state' | 'message' | 'empty'> {
  return {
    state: panel.phase === 'loading' ? 'loading' : panel.phase === 'error' ? 'error' : 'ready',
    ...(panel.notice === undefined ? {} : { message: panel.notice.text }),
    empty: 'No model is advertised by the configured providers.',
  }
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
            // the facts below were read in. It carries its OWN role ink (information
            // is `textMuted`, a failure is `error`) — the page's phase cannot tell a
            // refused write, which leaves the panel `ready`, from a cancellation.
            ...(panel.notice === undefined
              ? []
              : [ui.text({ wrap: 'word' }, span(panel.notice.text, panel.notice.tone))]),
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
  const props: PickerProps & { readonly key: string } = {
    key,
    title: pickerTitle(panel),
    layout: 'rows',
    // The sheet is ALWAYS `md`, like the official product's own pickers: `lg` grows
    // to the pane (measured 1120x698 at a 1280x800 pane, 87% of both axes) and a
    // catalogue has no informational chrome that needs the room, so the sheet is a
    // dialog on a large screen instead of a fullscreen panel. The client shrinks an
    // `md` sheet by itself below its own cap, so narrow panes are unchanged.
    size: 'md',
    // The catalogue asks for NO preview region: the client reserves a fixed ~36%
    // of the sheet body for `preview: 'below'` (measured 214px of 594px at
    // 1280x800), and the read-only summary this page once painted there was a
    // single line, so the band read as dead space above the footer. Everything the
    // page offers lives in its own main list and its own strip instead.
    preview: 'none',
    query: panel.query,
    cursor: panel.cursor,
    placeholder: 'Search models…',
    items: modelItems(panel),
    order: modelOrder(panel),
    total: catalogueTotal(panel),
    // The catalogue's OWN Reasoning Effort editor: the native strip between the list
    // and the action bar, painting one button per candidate of the HIGHLIGHTED model
    // (the drafted one marked `on`). A model without effort metadata paints no strip
    // at all, and no page hides that editor behind a second page.
    ...(stripOffered(panel)
      ? {
          strip: { label: STRIP_LABEL, items: stripItems(panel, stripLabelColumns(deps.paneWidth)) },
        }
      : {}),
    selected: panel.selected,
    current: panel.rows.filter((item) => item.isCurrent).map(modelRowId),
    subtitle: pickerSubtitle(panel),
    focus: nativeFocus(panel),
    ...pickerState(panel),
    actions: renderedActions(panel),
  }
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
