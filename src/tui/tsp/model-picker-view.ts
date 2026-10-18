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
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import type { ModelPickerIntent } from './model-picker-intents.ts'
import {
  FAILURE_RETRY_ID,
  retryRowOffered,
  STRIP_LABEL,
  actionBase,
  actionKeyboardLive,
  detailReaderGroups,
  draftedEffort,
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
    label: `${sanitizeDisplayText(failure.providerName)} · unavailable`,
    detail: sanitizeDisplayText(failure.message),
    title: sanitizeDisplayText(failure.message),
    disabled: sanitizeDisplayText(failure.message),
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
    order.push({ group: group.id, label: sanitizeDisplayText(group.name), count: rows.length })
    for (const row of rows) order.push(modelRowId(row))
  }
  if (panel.failures.length > 0) {
    // The group counts the rows it really carries: the failed providers, plus the retry row
    // only while that row is part of the page (`retryRowOffered`, the same predicate the row
    // set, the router and the admission read).
    const count = panel.failures.length + (retryRowOffered(panel) ? 1 : 0)
    order.push({ group: UNAVAILABLE_GROUP_ID, label: UNAVAILABLE_GROUP_LABEL, count })
    for (const failure of panel.failures) order.push(failureRowId(failure.providerId))
    if (retryRowOffered(panel)) order.push(FAILURE_RETRY_ID)
  }
  return order
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
function modelItems(panel: ModelPickerPanel): PickerItem[] {
  const items: PickerItem[] = visibleModels(panel).map((row) => {
    const mark = providerMark(row)
    return {
      id: modelRowId(row),
      label: sanitizeDisplayText(row.modelName),
      mark: { text: sanitizeDisplayText(mark.text), seed: mark.seed },
      detail: sanitizeDisplayText(row.providerName),
      title: sanitizeDisplayText(row.modelId),
      badges: [
        ...(row.isCurrent ? [{ text: 'current' }] : []),
        ...(row.isDefault ? [{ text: 'default' }] : []),
      ],
    }
  })
  items.push(...panel.failures.map(failureItem))
  if (retryRowOffered(panel)) items.push({ id: FAILURE_RETRY_ID, label: 'Retry failed providers' })
  return items
}

/** How many rows the catalogue really lists: the models, the failed providers, and the ONE
 *  retry row while it is part of the page (`retryRowOffered`). */
function catalogueTotal(panel: ModelPickerPanel): number {
  return panel.rows.length + panel.failures.length + (retryRowOffered(panel) ? 1 : 0)
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
  // The focus state is a BASE id; the actions carry the frame token.
  const focused = panel.zone === 'primary-action' && actionKeyboardLive(panel)
    ? actionBase(panel, focusedAction(panel).id)
    : undefined
  return pickerActions(panel).map((action) =>
    // A DISABLED action owns no Enter, so it must not carry the key badge.
    // The badge is the design language's `Verb [Key]` affordance form: `Enter` is a
    // real key of the focused action, so the badge states a fact instead of
    // inventing a focus glyph (`▸` is the DISCLOSURE glyph and never means
    // "selected"; `[Switch]` would give a verb label brackets).
    actionBase(panel, action.id) === focused && action.label !== undefined && action.disabled !== true
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
    ...(panel.notice === undefined ? {} : { message: sanitizeDisplayText(panel.notice.text) }),
    // The client is what paints this (if it paints it at all): MEASURED on the real client, a
    // search that matches nothing empties the list and draws NO copy, so one honest sentence
    // covers the state the string can describe.
    empty: 'No model is advertised by the configured providers.',
  }
}

/**
 * The key PREFIX of the Reader's scrollable content column.
 *
 * The key carries the panel SERIAL and the READING's epoch, never the frame revision:
 * MEASURED on the real client, a key that changes per frame makes the SDK diff `del + add`
 * and REMOUNT the node — for the Reader that also means its scroll container is recreated,
 * so the app's own `scroll` op could name a body the client never received. One identity per
 * reading keeps the id (and the scroll target) the same while the page is open, and a NEW
 * reading takes a new epoch, so an op queued by the previous one cannot address it. A later
 * PANEL still gets its own serial, so a retired panel's ids are never reused either.
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
  // One identity per READING: the frame revision never reaches a node key (a per-frame key
  // made the client remount the container), but a NEW reading gets its own, so a `scroll` op
  // queued while an earlier Reader was open can never address this one's body.
  const scope = `${panel.serial}-${panel.readerEpoch}`
  return ui.overlay(
    { key: `${MODEL_DETAILS_READER_KEY}-${scope}`, head: sanitizeDisplayText(readerHead(panel)), size: 'lg', modal: true },
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
              : [ui.text({ wrap: 'word' }, span(sanitizeDisplayText(panel.notice.text), panel.notice.tone))]),
            ...groups.flatMap((group, index) => [
              ui.col(
                { key: `reader-group-${group.id}`, gap: 'xs' },
                ui.text(span(sanitizeDisplayText(group.head), 'muted')),
                ...group.facts.flatMap((fact) => [
                  ...(fact.label === undefined ? [] : [ui.text(span(sanitizeDisplayText(fact.label), 'muted'))]),
                  ui.text({ key: fact.id, text: sanitizeDisplayText(fact.value), wrap: fact.wrap }),
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
          strip: {
            label: STRIP_LABEL,
            items: stripItems(panel, stripLabelColumns(deps.paneWidth))
              .map((item) => ({ ...item, label: sanitizeDisplayText(item.label) })),
          },
        }
      : {}),
    selected: panel.selected,
    current: panel.rows.filter((item) => item.isCurrent).map(modelRowId),
    subtitle: sanitizeDisplayText(pickerSubtitle(panel)),
    focus: nativeFocus(panel),
    ...pickerState(panel),
    actions: renderedActions(panel),
  }
  return ui.picker(props)
}

/**
 * The whole layer for one PANEL. The node id carries the panel serial and NOT the frame
 * revision: MEASURED on the real client, a key that changes per frame makes the SDK diff
 * `del + add`, and a remounted picker re-anchors its selected row — a click then moves
 * the whole list. Stale events are fenced by what the current frame really offers: an
 * action event carries the revision token of the bar that rendered it (see
 * {@link actionId}), and a row event is validated against the rows the panel currently
 * paints.
 *
 * The read-only `details` page REPLACES the picker with the native Reader (the
 * page is the SAME logical page and the same layer; it is not a second
 * simultaneously-active surface), so the layer region never carries a picker
 * whose rows could be operated behind the reader.
 */
export function modelPickerLayer(panel: ModelPickerPanel, deps: ModelPickerViewDeps): Node {
  const key = `model-${panel.serial}`
  return ui.col(
    { key: `model-layer-${panel.serial}` },
    panel.page === 'details' ? detailsReader(panel, deps) : modelListPicker(panel, deps, key),
  )
}
