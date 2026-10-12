/** Node construction for the native TSP `/model` presentation.
 *
 * Pure: state in, node tree out. Every interactive node binds a panel INTENT
 * through `deps.bind`, so a click lands on the same admission point as a key —
 * this module never mutates state, never writes and never reads the SDK.
 *
 * Layout contract (Owner-frozen):
 *  - the model LIST page at wide width (`lg` + a full side preview): provider
 *    scopes + model list + a Model Details card whose Reasoning Effort is a list
 *    of native radio rows. The details card opens the read-only Full details
 *    page; when the budget cannot hold the whole column, the SAME card becomes
 *    the bounded `Open model & effort ›` entry into the model's Overview;
 *  - everywhere else the same picker renders `preview: 'none'`: the compact
 *    layout opens the model's OVERVIEW (identity + details entry + every effort
 *    candidate in the native main list) and the read-only Full details page. No
 *    overlay, no `ui.el`, no self-drawn button, no global action menu.
 * @module tui/tsp/model-picker-view
 */
import { ui, span, type Node } from '@stencil-hq/tern'
import type { PickerAction, PickerGroup, PickerItem, PickerProps, PickerScope } from '@stencil-hq/tern'
import type { ModelPickerFailureRow, ModelPickerModelRow } from '../pickers/model-directory.ts'
import { wrapColumns } from './picker-text.ts'
import type { ModelPickerIntent } from './model-picker-intents.ts'
import {
  ALL_SCOPES_ID,
  OVERVIEW_ENTRY_HEAD,
  actionKeyboardLive,
  detailCursor,
  detailFactItems,
  overviewItems,
  overviewSelected,
  wideIdentityLines,
  widePreviewOptionalLine,
  wideSummaryLine,
  configuredFacts,
  draftedEffort,
  detailsCardHead,
  failureRowId,
  focusedAction,
  highlightedModel,
  modelChoices,
  modelRowId,
  pickerActions,
  scopeId,
  subjectLine,
  visibleModels,
  zoneHintText,
  type ModelPickerLayout,
  type ModelPickerPage,
  type ModelPickerPanel,
} from './model-picker-state.ts'

export interface ModelPickerViewDeps {
  /** True for the `lg` shell (`cols >= 120`): scopes + list + details column. */
  readonly wide: boolean
  /** True when the side preview presents the WHOLE details card and effort set. */
  readonly previewFull: boolean
  /** Bind one intent to THIS frame's revision (admission lives in the presenter). */
  readonly bind: (intent: ModelPickerIntent) => () => void
}

/** The layout facts the pure selectors need, derived from this frame's deps. */
function layoutOf(deps: ModelPickerViewDeps): ModelPickerLayout {
  return { wide: deps.wide, previewFull: deps.previewFull }
}

/** The inert row of a provider whose catalogue read failed (the paged layout
 *  reports the same failure as an error-dot provider scope at wide width). */
function failureItem(failure: ModelPickerFailureRow): PickerItem {
  return {
    id: failureRowId(failure.providerId),
    label: failure.providerName,
    detail: failure.message,
    disabled: failure.message,
  }
}

/** Provider-grouped order: a group header plus its visible row ids. */
function modelOrder(panel: ModelPickerPanel, paged: boolean): (string | PickerGroup)[] {
  const visible = visibleModels(panel)
  const order: (string | PickerGroup)[] = []
  for (const group of panel.directory?.directory.groups ?? []) {
    const rows = visible.filter((row) => row.providerId === group.id)
    if (rows.length === 0) continue
    order.push({ group: group.id, label: group.name, count: rows.length })
    for (const row of rows) order.push(modelRowId(row))
  }
  if (paged) for (const failure of panel.failures) order.push(failureRowId(failure.providerId))
  return order
}

function modelItems(panel: ModelPickerPanel, paged: boolean): PickerItem[] {
  const items: PickerItem[] = visibleModels(panel).map((row) => {
    const id = modelRowId(row)
    // The ONE write targets the HIGHLIGHTED model together with its drafted
    // effort, so its own row states that effort: the client can drop other
    // regions at the narrowest panes, and the target must stay identifiable.
    const effort = modelChoices(row).find((choice) => choice.value === draftedEffort(panel, row))?.label
    return {
      id,
      label: row.modelName,
      detail: id === panel.selected && effort !== undefined ? `${row.providerName} · ${effort}` : row.providerName,
      title: row.modelId,
      // The `Default` badge is the directory fact; `current` is the live Session
      // fact. A sessionless subject projects NO current row, so it can never be
      // painted from the directory default.
      badges: [
        ...(row.isDefault ? [{ text: 'Default' }] : []),
        ...(row.isCurrent ? [{ text: 'current' }] : []),
      ],
    }
  })
  if (paged) items.push(...panel.failures.map(failureItem))
  return items
}

/** The provider scope column (wide model list only; it filters, it is never
 *  authority). */
function scopes(panel: ModelPickerPanel): PickerScope[] {
  const entries: PickerScope[] = [
    { id: ALL_SCOPES_ID, label: 'All models', icon: 'list', count: panel.rows.length },
  ]
  for (const group of panel.directory?.directory.groups ?? []) {
    const count = panel.rows.filter((row) => row.providerId === group.id).length
    if (count === 0) continue
    entries.push({ id: scopeId(group.id), label: group.name, group: 'Providers', count })
  }
  // A failed provider is visible as an inert error scope: it never filters into
  // an empty list, and the Retry action re-reads the whole directory.
  for (const failure of panel.failures) {
    entries.push({
      id: scopeId(failure.providerId),
      label: failure.providerName,
      group: 'Providers',
      dot: 'error',
      disabled: failure.message,
    })
  }
  return entries
}

/**
 * The rendered action bar: the state module owns WHICH actions exist (and which
 * the current phase admits), and the focused one — only while the action zone
 * owns the keyboard — carries the app-rendered shape cue, because the SDK has
 * no focus affordance for a button. A phase whose bar no key can run (an
 * admitted write, a running re-read) marks nothing: the cue promises Enter.
 */
function renderedActions(panel: ModelPickerPanel, layout: ModelPickerLayout): PickerAction[] {
  const focused = panel.zone === 'primary-action' && actionKeyboardLive(panel)
    ? focusedAction(panel, layout).id
    : undefined
  return pickerActions(panel, layout).map((action) =>
    // A DISABLED action owns no Enter, so it must not carry the focus cue.
    action.id === focused && action.label !== undefined && action.disabled !== true
      ? { ...action, label: `▸ ${action.label}` }
      : action,
  )
}

/** Which picker region the SDK should show as focused, by logical zone. The
 *  primary action has no native region: the action bar shape change carries it.
 *  The wide Model Details card and its inline effort selector are both the side
 *  preview's regions; the content pages have no side region at all, so they take
 *  the list focus. */
function nativeFocus(
  panel: ModelPickerPanel,
  side: boolean,
  previewFull: boolean,
): PickerProps['focus'] {
  if (panel.phase === 'error' || panel.zone === 'primary-action') return undefined
  if (panel.zone === 'detail-card' && side) return 'preview'
  if (panel.zone === 'effort' && side && previewFull) return 'preview'
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
 * The page name. The SUBJECT is deliberately NOT concatenated here: the picker
 * header truncates a long single line (measured `Models · Default f…` at 560
 * columns), which would break the frozen "the subject is completely visible"
 * requirement. The subject therefore gets its own slot per layout: `subtitle`
 * at `lg`, the strip's own line at `md` — both complete, neither duplicated.
 */
function pageTitle(page: ModelPickerPage): string {
  if (page === 'models') return 'Models'
  if (page === 'overview') return 'Model overview'
  return 'Full model details'
}

function effortChoiceRows(
  panel: ModelPickerPanel,
  deps: ModelPickerViewDeps,
  row: ModelPickerModelRow,
): Node {
  const draft = draftedEffort(panel, row)
  return ui.col(
    { key: 'effort-choices', gap: 'xs' },
    ...modelChoices(row).map((choice) => {
      const on = choice.value === draft
      return ui.row(
        {
          key: `effort-${encodeURIComponent(choice.value)}`,
          gap: 'sm',
          tone: on ? 'accent' : undefined,
          mark: on ? 'pick' : undefined,
          onClick: deps.bind({ kind: 'browse-effort', value: choice.value }),
        },
        ui.text(span(on ? '●' : '○', on ? 'accent' : 'muted')),
        ui.text(span(choice.label, on ? 'strong accent' : 'muted')),
      )
    }),
  )
}

/** The columns the bounded summary pre-wraps to: the same widest-glyph bound the
 *  layout budget uses, so every summary line is provably one line. */
const WIDE_SUMMARY_COLUMNS = 12
/** The bounded summary never exceeds this many BODY lines (the card head and the
 *  `WIDE_GLYPH_PX`/`WIDE_LINE_PX` budget keep the whole card inside the measured
 *  preview: 11 lines cost 310px of the 374px minimum), so the column can never
 *  overflow it. The full content lives on the model's Overview and its Full
 *  details page. */
const WIDE_SUMMARY_MAX_LINES = 10

/**
 * The bounded details column used when the full card cannot fit the measured
 * preview. It is ACTION-FIRST exactly like the inline column: the bounded
 * identity and the keyboard hint always come first, then the single one-line
 * summary, and the configured facts fill whatever the fixed line budget still
 * allows.
 *
 * The whole card is ONE pointer/Enter target — `Open model & effort ›` — because
 * what the column can no longer present in full (every effort candidate, the
 * complete description and the extended facts) lives on the model's Overview.
 * The card carries no per-line handler, so a click can never run two callbacks.
 */
function boundedPreview(
  panel: ModelPickerPanel,
  deps: ModelPickerViewDeps,
  row: ModelPickerModelRow | undefined,
): Node[] {
  if (row === undefined) return [ui.text(span('No model matches the current search.', 'muted'))]
  const summary = wideSummaryLine(panel, row)
  const facts = configuredFacts(panel)
    .flatMap((fact) => wrapColumns(`${fact.label}: ${fact.detail}`, WIDE_SUMMARY_COLUMNS))
  const lines = [
    ...wideIdentityLines(row),
    zoneHintText(panel, layoutOf(deps)),
    ...(summary === undefined ? [] : [summary]),
    ...facts,
  ]
  const capped = lines.slice(0, WIDE_SUMMARY_MAX_LINES)
  const truncated = capped.length < lines.length
  return [
    ui.card(
      {
        key: 'model-details',
        head: OVERVIEW_ENTRY_HEAD,
        onClick: deps.bind({ kind: 'open-overview' }),
      },
      ...capped.map((line, index) =>
        ui.text(truncated && index === capped.length - 1 ? `${line}…` : line)),
    ),
  ]
}

/**
 * The wide right-hand Model Details card: the ACTION-FIRST column. It renders
 * the model identity on one clamped line each and the Reasoning Effort radio
 * rows, which own the vertical space; a single optional line carries the notice
 * or a one-line description summary when the budget still allows it. The
 * complete description and the extended facts live on the read-only Full details
 * page, which this card opens.
 *
 * Only the CARD carries the `open-details` handler (`›` marks it in the head);
 * the sibling effort rows keep their own independent `browse-effort` handler, so
 * neither target can run the other's callback.
 */
function widePreview(
  panel: ModelPickerPanel,
  deps: ModelPickerViewDeps,
  row: ModelPickerModelRow | undefined,
): Node[] {
  if (row === undefined) return [ui.text(span('No model matches the current search.', 'muted'))]
  const optional = widePreviewOptionalLine(panel, row)
  const card = ui.card(
    {
      key: 'model-details',
      head: detailsCardHead(row),
      onClick: deps.bind({ kind: 'open-details' }),
    },
    ...wideIdentityLines(row).map((line) => ui.text(line)),
    ui.text(span(
      zoneHintText(panel, layoutOf(deps)),
      panel.zone === 'primary-action' && actionKeyboardLive(panel) ? 'accent' : 'muted',
    )),
    ...(optional === undefined
      ? []
      : [ui.text(span(optional, panel.notice === '' ? 'muted' : 'error'))]),
  )
  if (modelChoices(row).length === 0) return [card]
  return [
    card,
    ui.card(
      { key: 'reasoning-effort', head: 'Reasoning Effort' },
      ...(panel.phase === 'pending'
        ? [ui.text(span('Selecting…', 'muted'))]
        : [effortChoiceRows(panel, deps, row)]),
    ),
  ]
}

function modelListPicker(
  panel: ModelPickerPanel,
  deps: ModelPickerViewDeps,
  key: string,
): Node {
  const layout = layoutOf(deps)
  const row = highlightedModel(panel)
  const page = panel.page
  // The three-column selector shell (provider scopes + model list + details
  // column) belongs to the model LIST page at wide width. The Overview and the
  // Full details page are CONTENT pages of the model itself: they show their own
  // rows and must not repeat a scope column or a side summary beside themselves.
  const side = page === 'models' && deps.wide
  const facts = page === 'details' && row !== undefined
    ? detailFactItems(panel, row, deps.wide)
    : undefined
  const items = page === 'models'
    ? modelItems(panel, !deps.wide)
    : page === 'overview'
      ? overviewItems(panel, deps.wide)
      : facts ?? []
  const selected = page === 'models'
    ? panel.selected
    : page === 'overview'
      ? overviewSelected(panel, deps.wide)
      // The details page selects its presentation cursor, so the native list
      // scrolls to the fact row being read.
      : facts?.[detailCursor(panel, row, deps.wide)]?.id
  const props: PickerProps & { readonly key: string } = {
    key,
    title: pageTitle(page),
    layout: 'rows',
    size: deps.wide ? 'lg' : 'md',
    // The preview region IS the wide model list's side column; every other page
    // is `none`, so no page depends on a region the client may hide.
    preview: side ? 'side' : 'none',
    query: page === 'models' ? panel.query : '',
    cursor: page === 'models' ? panel.cursor : 0,
    items,
    order: page === 'models' ? modelOrder(panel, !deps.wide) : items.map((item) => item.id),
    // The compact list also carries the inert failed-provider rows, so the
    // count must describe what is actually listed.
    total: page === 'models'
      ? panel.rows.length + (deps.wide ? 0 : panel.failures.length)
      : items.length,
    selected,
    current: page === 'models' ? panel.rows.filter((item) => item.isCurrent).map(modelRowId) : [],
    // The subject keeps ONE complete slot per layout and is never duplicated: the
    // wide picker puts it in its own `subtitle`, the compact one on the strip's
    // own line. Only the model list page carries a scope column; no page carries
    // a global action strip.
    ...(deps.wide
      ? {
          ...(side
            ? {
                scopes: scopes(panel),
                scope: panel.scope === undefined ? ALL_SCOPES_ID : scopeId(panel.scope),
              }
            : {}),
          subtitle: subjectLine(panel),
        }
      : { strip: { label: subjectLine(panel), items: [] } }),
    focus: nativeFocus(panel, side, deps.previewFull),
    ...pickerState(panel),
    actions: renderedActions(panel, layout),
  }
  // The model list page is the only one with a side column (the full preview or
  // its bounded entry into the Overview). The Overview and the Full details page
  // are `preview: 'none'` content pages of the SAME picker: everything they offer
  // is in their own native main list.
  if (page !== 'models') return ui.picker(props)
  if (deps.wide) {
    return ui.picker(
      props,
      ...(deps.previewFull ? widePreview(panel, deps, row) : boundedPreview(panel, deps, row)),
    )
  }
  return ui.picker(props)
}

/**
 * The whole layer for one frame. The node id carries the panel serial AND the
 * revision, so an event or `onClick` from an earlier frame can only ever be
 * refused by `targets`/admission — never silently applied to the new one.
 */
export function modelPickerLayer(panel: ModelPickerPanel, deps: ModelPickerViewDeps): Node {
  const key = `model-${panel.serial}-rev-${panel.revision}`
  return ui.col({ key: `model-layer-${panel.serial}-rev-${panel.revision}` }, modelListPicker(panel, deps, key))
}
