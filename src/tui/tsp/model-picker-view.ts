/** Node construction for the native TSP `/model` presentation.
 *
 * Pure: state in, node tree out. Every interactive node binds a panel INTENT
 * through `deps.bind`, so a click lands on the same admission point as a key —
 * this module never mutates state, never writes and never reads the SDK.
 *
 * Layout contract (Owner-frozen):
 *  - `wide`  (`lg` + side preview): provider scopes + model list + a details
 *    card whose Reasoning Effort is a list of native radio rows.
 *  - `compact` (`md`, no preview): the same picker drills through the model
 *    list, a details page and an effort page; no overlay, no `ui.el`, no strip.
 * @module tui/tsp/model-picker-view
 */
import { ui, span, type Node } from '@stencil-hq/tern'
import type { PickerAction, PickerGroup, PickerItem, PickerProps, PickerScope } from '@stencil-hq/tern'
import type { ModelPickerFailureRow, ModelPickerModelRow } from '../pickers/model-directory.ts'
import { wrapColumns } from './picker-text.ts'
import type { ModelPickerIntent } from './model-picker-intents.ts'
import {
  ALL_SCOPES_ID,
  actionKeyboardLive,
  detailCursor,
  detailFactItems,
  effortItemId,
  wideIdentityLines,
  widePreviewOptionalLine,
  wideSummaryLine,
  configuredFacts,
  draftedEffort,
  failureRowId,
  focusedAction,
  highlightedModel,
  modelChoices,
  modelHeadLine,
  modelRowId,
  pickerActions,
  scopeId,
  subjectLine,
  visibleModels,
  zoneHintText,
  type ModelPickerPanel,
} from './model-picker-state.ts'

export interface ModelPickerViewDeps {
  /** True for the `lg` shell (`cols >= 120`): scopes + list + details column. */
  readonly wide: boolean
  /** True when the side preview presents the WHOLE details card and effort set. */
  readonly preview: boolean
  /** Bind one intent to THIS frame's revision (admission lives in the presenter). */
  readonly bind: (intent: ModelPickerIntent) => () => void
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
  const items: PickerItem[] = visibleModels(panel).map((row) => ({
    id: modelRowId(row),
    label: row.modelName,
    detail: row.providerName,
    title: row.modelId,
    // The `Default` badge is the directory fact; `current` is the live Session
    // fact. A sessionless subject projects NO current row, so it can never be
    // painted from the directory default.
    badges: [
      ...(row.isDefault ? [{ text: 'Default' }] : []),
      ...(row.isCurrent ? [{ text: 'current' }] : []),
    ],
  }))
  if (paged) items.push(...panel.failures.map(failureItem))
  return items
}

/** The provider scope column (wide only; it filters, it is never authority). */
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

/** Which picker region the SDK should show as focused, by logical zone. The
 *  primary action has no native region: the action bar shape change carries it.
 *  An EXPLICIT effort page is the picker's own LIST in every layout — the wide
 *  column's inline radio rows are a different surface and the keyboard is not on
 *  them — so the page takes the list focus even while the column stays inline. */
function nativeFocus(panel: ModelPickerPanel, preview: boolean): PickerProps['focus'] {
  if (panel.phase === 'error' || panel.zone === 'primary-action') return undefined
  if (panel.page === 'effort') return 'list'
  if (panel.zone === 'effort' && preview) return 'preview'
  return 'list'
}

/** The state/notice surface: one message, in one place, per size. */
function pickerState(panel: ModelPickerPanel): Pick<
  PickerProps,
  'state' | 'message' | 'empty'
> {
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
function pageTitle(page: 'models' | 'details' | 'effort'): string {
  return page === 'models' ? 'Models' : page === 'details' ? 'Model details' : 'Reasoning Effort'
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
 *  overflow it. The full content lives on the Details page. */
const WIDE_SUMMARY_MAX_LINES = 10

/**
 * The bounded details column used when the full card cannot fit the measured
 * preview. It is ACTION-FIRST exactly like the inline column: the bounded
 * identity and the keyboard hint always come first, then the single one-line
 * summary, and the configured facts fill whatever the fixed line budget still
 * allows. The complete name, description and facts stay readable on the Details
 * page, which the action bar always offers.
 */
function boundedPreview(panel: ModelPickerPanel, row: ModelPickerModelRow | undefined): Node[] {
  if (row === undefined) return [ui.text(span('No model matches the current search.', 'muted'))]
  const summary = wideSummaryLine(panel, row)
  const facts = configuredFacts(panel)
    .flatMap((fact) => wrapColumns(`${fact.label}: ${fact.detail}`, WIDE_SUMMARY_COLUMNS))
  const lines = [
    ...wideIdentityLines(row),
    zoneHintText(panel),
    ...(summary === undefined ? [] : [summary]),
    ...facts,
  ]
  const capped = lines.slice(0, WIDE_SUMMARY_MAX_LINES)
  const truncated = capped.length < lines.length
  return [
    ui.card(
      { key: 'model-details', head: modelHeadLine(row) },
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
 * complete description and the extended facts live in the Details page.
 */
function widePreview(panel: ModelPickerPanel, deps: ModelPickerViewDeps, row: ModelPickerModelRow | undefined): Node[] {
  if (row === undefined) return [ui.text(span('No model matches the current search.', 'muted'))]
  const optional = widePreviewOptionalLine(panel, row)
  const card = ui.card(
    { key: 'model-details', head: modelHeadLine(row) },
    ...wideIdentityLines(row).map((line) => ui.text(line)),
    ui.text(span(
      zoneHintText(panel),
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
  const row = highlightedModel(panel)
  const page = panel.page
  const draft = draftedEffort(panel, row)
  const items = page === 'models'
    ? modelItems(panel, !deps.wide)
    : page === 'effort'
      ? modelChoices(row).map((choice) => ({
          // Candidates carry their OWN wire namespace, so a candidate value can
          // never be confused with a scope id (see `effortItemId`).
          id: effortItemId(choice.value),
          label: choice.label,
          detail: 'draft',
          mark: choice.value === draft ? { text: '●' } : { text: '○' },
        }))
      : row === undefined
        ? []
        : detailFactItems(panel, row, deps.wide)
  const selected = page === 'effort'
    ? (draft === undefined ? undefined : effortItemId(draft))
    : page === 'models'
      ? panel.selected
      : row === undefined
        ? undefined
        // The details page selects its presentation cursor, so the native list
        // scrolls to the fact row being read.
        : detailFactItems(panel, row, deps.wide)[detailCursor(panel, row, deps.wide)]?.id
  const props: PickerProps & { readonly key: string } = {
    key,
    title: pageTitle(page),
    layout: 'rows',
    size: deps.wide ? 'lg' : 'md',
    preview: deps.wide ? 'side' : 'none',
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
    ...(deps.wide
      ? {
          scopes: scopes(panel),
          scope: panel.scope === undefined ? ALL_SCOPES_ID : scopeId(panel.scope),
          subtitle: subjectLine(panel),
        }
      // The compact subject gets its own complete line instead of a truncated
      // title; the chips stay empty (the banned B2F form concatenated the
      // subject, current value and effort chips into one clipped line).
      : { strip: { label: subjectLine(panel), items: [] } }),
    focus: nativeFocus(panel, deps.preview),
    ...pickerState(panel),
    actions: renderedActions(panel),
  }
  if (!deps.wide) return ui.picker(props)
  // The wide SHELL always keeps its details column: the full card + radio rows
  // when the budget proves they fit, otherwise the action-first bounded summary.
  return ui.picker(
    props,
    ...(deps.preview ? widePreview(panel, deps, row) : boundedPreview(panel, row)),
  )
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
