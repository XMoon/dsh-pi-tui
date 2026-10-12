/** The native `/model` interaction vocabulary: how one real key or one SDK
 * event maps onto a panel intent.
 *
 * The map is PURE — it reads the panel and returns an intent; it never mutates
 * state and never writes. Admission (scope/phase/revision/zone) and the state
 * transition itself belong to the presenter, so this module is the whole K2
 * keyboard contract in one testable place.
 * @module tui/tsp/model-picker-intents
 */
import type { Key } from '@stencil-hq/tern'
import {
  draftedEffort,
  highlightedModel,
  modelChoices,
  modelRowId,
  effortValue,
  scopeProviderId,
  visibleModels,
  type ModelPickerPanel,
  type ModelPickerPage,
  type ModelPickerScope,
  type ModelPickerZone,
} from './model-picker-state.ts'

export type ModelPickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'page'; readonly page: ModelPickerPage }
  | { readonly kind: 'zone'; readonly zone: ModelPickerZone; readonly page?: ModelPickerPage }
  | { readonly kind: 'scope'; readonly scope: ModelPickerScope }
  | { readonly kind: 'browse-model'; readonly rowId: string }
  | { readonly kind: 'browse-effort'; readonly value: string }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
  | { readonly kind: 'fact-cursor'; readonly delta: -1 | 1 }
  | { readonly kind: 'action-focus'; readonly delta: -1 | 1 }
  | { readonly kind: 'activate-action' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'apply' }

/** The grapheme boundaries of the search text (CJK/emoji/combining safe). */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
function graphemes(text: string): number[] {
  return [...segmenter.segment(text)].map((segment) => segment.index).concat(text.length)
}

/** The next caret/text state for one editing key on the model list page. */
function editedQuery(
  panel: ModelPickerPanel,
  key: Key,
): { readonly query: string; readonly cursor: number } | undefined {
  const bounds = graphemes(panel.query)
  if (key.name === 'backspace') {
    const start = bounds.filter((index) => index < panel.cursor).at(-1) ?? 0
    return { query: panel.query.slice(0, start) + panel.query.slice(panel.cursor), cursor: start }
  }
  if (key.name === 'delete') {
    const end = bounds.find((index) => index > panel.cursor) ?? panel.query.length
    return { query: panel.query.slice(0, panel.cursor) + panel.query.slice(end), cursor: panel.cursor }
  }
  if (key.name === 'home') return { query: panel.query, cursor: 0 }
  if (key.name === 'end') return { query: panel.query, cursor: panel.query.length }
  if (key.text === undefined) return undefined
  const typed = panel.query.slice(0, panel.cursor) + key.text
  const raw = panel.cursor + key.text.length
  return {
    query: typed + panel.query.slice(panel.cursor),
    cursor: graphemes(typed).find((index) => index >= raw) ?? typed.length,
  }
}

/** Step the highlighted model, wrapping (browse only — never a write). */
function stepModel(panel: ModelPickerPanel, delta: -1 | 1): ModelPickerIntent | undefined {
  const ids = visibleModels(panel).map(modelRowId)
  if (ids.length === 0) return undefined
  const at = ids.findIndex((id) => id === panel.selected)
  const next = ids[(Math.max(at, 0) + delta + ids.length) % ids.length]
  return next === undefined ? undefined : { kind: 'browse-model', rowId: next }
}

/** Step the highlighted model's effort DRAFT (wide right pane / compact page). */
function stepEffort(panel: ModelPickerPanel, delta: -1 | 1): ModelPickerIntent | undefined {
  const row = highlightedModel(panel)
  const choices = modelChoices(row)
  if (choices.length === 0) return undefined
  const at = choices.findIndex((choice) => choice.value === draftedEffort(panel, row))
  const next = choices[(Math.max(at, 0) + delta + choices.length) % choices.length]
  return next === undefined ? undefined : { kind: 'browse-effort', value: next.value }
}

/** The frozen Tab/Shift+Tab cycle across the three K2 zones. */
function tabZone(panel: ModelPickerPanel, direction: -1 | 1): ModelPickerZone {
  // A failed read has exactly ONE operable region — its action bar (Retry /
  // Close). The stale model list keeps its rows on screen for context, but the
  // phase browses neither the list nor the search box and refuses Enter, so
  // Tab/Shift+Tab must never move the keyboard there: both stay in the bar,
  // where ←→ switches between Retry and the always-enabled Close.
  if (panel.phase === 'error') return 'primary-action'
  // The effort selector exists only while the phase admits BROWSING. A failed (or
  // running) read keeps the previous rows and their effort metadata for context, but
  // its bar offers nothing but Retry/Close, so Tab must reach that bar instead of
  // parking the keyboard in an inert effort zone the phase cannot operate.
  const browsable = panel.phase === 'ready'
  const hasChoices = browsable && modelChoices(highlightedModel(panel)).length > 0
  // The compact details page is static fact: its only reachable region is the
  // explicit action bar (Back / Choose effort / Primary).
  if (panel.page === 'details' && panel.zone !== 'effort') {
    return panel.zone === 'primary-action' ? 'models' : 'primary-action'
  }
  if (panel.zone === 'models') {
    if (direction === 1) return hasChoices ? 'effort' : 'primary-action'
    return 'primary-action'
  }
  if (panel.zone === 'effort') return direction === 1 ? 'primary-action' : 'models'
  return direction === 1 ? 'models' : hasChoices ? 'effort' : 'models'
}

/** The search-box keys of the model list page (also live while the read runs). */
function queryIntent(panel: ModelPickerPanel, key: Key): ModelPickerIntent | undefined {
  if (key.ctrl === true || key.alt === true || key.meta === true) return undefined
  if (key.name === 'left' || key.name === 'right') {
    const bounds = graphemes(panel.query)
    return {
      kind: 'query',
      query: panel.query,
      cursor: key.name === 'left'
        ? (bounds.filter((index) => index < panel.cursor).at(-1) ?? 0)
        : (bounds.find((index) => index > panel.cursor) ?? panel.query.length),
    }
  }
  const edited = editedQuery(panel, key)
  return edited === undefined ? undefined : { kind: 'query', ...edited }
}

/**
 * K2: the frozen key contract.
 *
 * Returns `undefined` for a key the panel does not consume — the orchestrator
 * then leaves it to the original composer owner.
 */
export function keyIntent(panel: ModelPickerPanel, key: Key): ModelPickerIntent | undefined {
  // The original application cancel owner keeps Ctrl+C in every state.
  if (key.ctrl === true && key.name === 'c') return undefined
  if (key.name === 'escape') {
    // Esc is NEVER swallowed. An admitted write, a running (re-)read and a failed
    // read all leave Close as the only reachable action, and in the failed read the
    // zone/page Esc would return to is inert (`tabZone` keeps the keyboard in the
    // bar for exactly that reason), so all three close instead of parking the
    // keyboard where no key acts.
    if (panel.phase === 'pending' || panel.phase === 'loading' || panel.phase === 'error') {
      return { kind: 'close' }
    }
    // The action bar returns to the zone it was entered FROM (a details page's
    // Primary must not teleport the user into the effort selector).
    if (panel.zone === 'primary-action') {
      // Esc keeps the page the bar was used on (a details page stays a details
      // page) and returns to the zone the bar was entered from.
      return { kind: 'zone', zone: panel.previousZone ?? 'models', page: panel.page }
    }
    if (panel.zone === 'effort') {
      return { kind: 'zone', zone: 'models', page: panel.previousPage ?? 'models' }
    }
    if (panel.page === 'details') return { kind: 'page', page: 'models' }
    return { kind: 'close' }
  }
  // While the read runs the query stays editable (frozen §4.5) and every other
  // key is refused; an admitted write refuses everything but Esc/Ctrl+C.
  if (panel.phase === 'loading') {
    return panel.page === 'models' ? queryIntent(panel, key) : undefined
  }
  if (panel.phase === 'pending') return undefined
  if (key.name === 'tab') return { kind: 'zone', zone: tabZone(panel, key.shift === true ? -1 : 1) }
  // The action bar owns Enter and the bar-internal focus movement. Enter only
  // ever activates the FOCUSED action; the Primary Action remains the sole write.
  if (panel.zone === 'primary-action') {
    if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
      return { kind: 'action-focus', delta: key.name === 'up' || key.name === 'left' ? -1 : 1 }
    }
    return key.name === 'enter' ? { kind: 'activate-action' } : undefined
  }
  // A failed read owns no browsable list: only the action bar (Tab) is live.
  if (panel.phase === 'error') return undefined
  if (key.name === 'enter') {
    if (panel.zone === 'models') {
      // Static detail fields never commit; the model list moves to the effort
      // selector, or straight to the explicit Apply when there is none.
      if (panel.page === 'details') return undefined
      return {
        kind: 'zone',
        zone: modelChoices(highlightedModel(panel)).length === 0 ? 'primary-action' : 'effort',
      }
    }
    // Confirming a draft moves to the explicit Apply; it never writes.
    return { kind: 'zone', zone: 'primary-action' }
  }
  if (panel.zone === 'effort' && (key.name === 'up' || key.name === 'down')) {
    // The effort page lists the candidates, so its arrows browse them.
    return stepEffort(panel, key.name === 'up' ? -1 : 1)
  }
  // The details page's rows are inert FACTS, so its arrows only keep the native
  // list scrolled to the row being read (a long description must stay
  // reachable); they never change the browsed model.
  if (panel.page === 'details' && key.name === 'up' || panel.page === 'details' && key.name === 'down') {
    return { kind: 'fact-cursor', delta: key.name === 'up' ? -1 : 1 }
  }
  // Only the model list page browses the model list or edits the search box.
  if (panel.zone !== 'models' || panel.page !== 'models') return undefined
  if (key.name === 'up' || key.name === 'down') return stepModel(panel, key.name === 'up' ? -1 : 1)
  return queryIntent(panel, key)
}

/** One SDK action event as an intent (the action bar path). The panel decides
 *  where a page-relative action returns, so Back and Esc can never disagree. */
export function actionIntent(
  panel: ModelPickerPanel,
  act: string,
  value: string | undefined,
): ModelPickerIntent | undefined {
  switch (act) {
    case 'close':
      return { kind: 'close' }
    case 'back':
      // The effort page was opened FROM a page, so its Back is that page (the
      // same target its Esc uses); every other page backs out to the model list.
      return panel.page === 'effort'
        ? { kind: 'zone', zone: 'models', page: panel.previousPage ?? 'models' }
        : { kind: 'page', page: 'models' }
    case 'details':
      return { kind: 'page', page: 'details' }
    case 'effort-page':
      // The drill-down effort page is reachable in EVERY layout (the Owner's
      // path that keeps every candidate readable/selectable when the
      // environment's font or zoom makes the wide column's own fit unsure), so
      // the page is explicit rather than derived from the paged layout.
      return { kind: 'zone', zone: 'effort', page: 'effort' }
    case 'retry':
      return { kind: 'retry' }
    case 'apply':
      return { kind: 'apply' }
    default:
      return undefined
  }
}

/**
 * One SDK row/scope activation.
 *
 * A candidate row carries its OWN wire namespace ({@link effortValue}), and that is
 * the only place a candidate value is read: the SDK delivers the scope column's ids
 * and the page's row ids on the same channel, so a candidate whose value looks like a
 * scope id (or IS the every-provider id) still changes the draft, and the scope
 * column's ids still filter — including ON the effort page, where the scopes stay
 * live. Only on the model/details pages is a row id a model highlight.
 */
export function rowIntent(panel: ModelPickerPanel, item: string): ModelPickerIntent | undefined {
  if (panel.page === 'effort') {
    const value = effortValue(item)
    if (value !== undefined) {
      const choices = modelChoices(highlightedModel(panel))
      return choices.some((choice) => choice.value === value)
        ? { kind: 'browse-effort', value }
        : undefined
    }
    // Not a candidate row: fall through, because the scope entries are live here.
  }
  const scope = scopeProviderId(item)
  // `null` is the every-provider entry: it maps to the absence of a provider.
  if (scope !== undefined) return { kind: 'scope', scope: scope ?? undefined }
  if (panel.page !== 'models') return undefined
  return visibleModels(panel).some((row) => modelRowId(row) === item)
    ? { kind: 'browse-model', rowId: item }
    : undefined
}
