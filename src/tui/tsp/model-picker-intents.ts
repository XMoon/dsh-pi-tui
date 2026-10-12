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
  pickerActions,
  highlightedModel,
  modelChoices,
  modelRowId,
  moreRowAction,
  secondaryActions,
  MORE_CHIP_ID,
  effortValue,
  scopeProviderId,
  stripChips,
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
  | { readonly kind: 'more-cursor'; readonly delta: -1 | 1 }
  | { readonly kind: 'activate-more' }
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

/** The frozen Tab/Shift+Tab cycle across the zones this page really paints. */
function tabZone(panel: ModelPickerPanel, direction: -1 | 1): ModelPickerZone {
  // A failed read has exactly ONE operable region — its action bar (Retry /
  // Cancel). The stale model list keeps its rows on screen for context, but the
  // phase browses neither the list nor the search box and refuses Enter, so
  // Tab/Shift+Tab must never move the keyboard there: both stay in the bar,
  // where ←→ switches between Retry and the always-enabled Cancel.
  if (panel.phase === 'error') return 'primary-action'
  // The effort selector exists only while the phase admits BROWSING. A failed (or
  // running) read keeps the previous rows and their effort metadata for context, but
  // its bar offers nothing but Retry/Cancel, so Tab must reach that bar instead of
  // parking the keyboard in an inert effort zone the phase cannot operate.
  const browsable = panel.phase === 'ready'
  const hasChoices = browsable && modelChoices(highlightedModel(panel)).length > 0
  // The static content pages have exactly two regions: their list and the bar.
  if (panel.page === 'details' || panel.page === 'more') {
    return panel.zone === 'primary-action' ? 'models' : 'primary-action'
  }
  // Every other page cycles the zones it really renders. The strip comes FIRST
  // after the list because it exists only on the model list page: leaving the
  // list for the effort zone can move the panel onto the effort PAGE, where the
  // strip has no chip at all, so a later stop would be unreachable. The inline
  // effort selector follows, and only while the highlighted model advertises
  // efforts.
  const ring: ModelPickerZone[] = ['models']
  if (browsable && stripChips(panel).length > 0) ring.push('strip')
  if (hasChoices) ring.push('effort')
  ring.push('primary-action')
  const at = Math.max(ring.indexOf(panel.zone), 0)
  return ring[(at + direction + ring.length) % ring.length]!
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
    // read all leave the close action as the only reachable one, and in the failed
    // read the
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
    // The strip is a side region of the model list: Esc leaves it for the list.
    if (panel.zone === 'strip') return { kind: 'zone', zone: 'models' }
    if (panel.page === 'details' || panel.page === 'more') return { kind: 'page', page: 'models' }
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
  // The strip carries exactly one chip: Enter opens it, its arrows do nothing.
  if (panel.zone === 'strip') {
    return key.name === 'enter' ? { kind: 'page', page: 'more' } : undefined
  }
  // A failed read owns no browsable list: only the action bar (Tab) is live.
  if (panel.phase === 'error') return undefined
  // The More page is a menu of secondary operations: its arrows move the
  // presentation cursor and Enter runs the selected one — never a write.
  if (panel.page === 'more') {
    if (key.name === 'up' || key.name === 'down') {
      return { kind: 'more-cursor', delta: key.name === 'up' ? -1 : 1 }
    }
    return key.name === 'enter' ? { kind: 'activate-more' } : undefined
  }
  if (key.name === 'enter') {
    if (panel.zone === 'models') {
      // Static detail fields never commit; the model list moves to the effort
      // selector, or straight to the explicit Confirm when there is none.
      if (panel.page === 'details') return undefined
      return {
        kind: 'zone',
        zone: modelChoices(highlightedModel(panel)).length === 0 ? 'primary-action' : 'effort',
      }
    }
    // Confirming a draft moves to the explicit Confirm; it never writes.
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

/** One SDK action event as an intent (the action bar AND the scope column). The
 *  panel decides where a page-relative action returns, so Back and Esc can never
 *  disagree. */
/**
 * The action ids the CURRENT page really offers on the SDK's action channel: the
 * bar's own entries plus, on the More page, the secondary operations its list
 * renders. An id outside this set is not merely absent from the screen — it must
 * be refused ON THE WIRE too, or a stale or forged receiver could reach the one
 * writer (or the close and paging actions) from a page whose bar never offered
 * them. The scope column and the strip have their own namespaces and their own
 * live checks instead.
 */
function offeredActionIds(panel: ModelPickerPanel): Set<string> {
  const ids = new Set(pickerActions(panel).map((action) => action.id))
  if (panel.page === 'more') {
    for (const action of secondaryActions(panel)) ids.add(action.id)
  }
  return ids
}

export function actionIntent(
  panel: ModelPickerPanel,
  act: string,
  value: string | undefined,
): ModelPickerIntent | undefined {
  if (act !== 'scope' && act !== 'strip' && !offeredActionIds(panel).has(act)) return undefined
  switch (act) {
    case 'close':
      return { kind: 'close' }
    case 'scope': {
      // The scope COLUMN speaks on this channel: a provider click is
      // `action { act:'scope', value:<scope id> }` (never a row `select`). A
      // value that names no scope at all is refused here; a real provider id is
      // still only a REQUEST — the presenter re-checks it against the current
      // read's own membership before it changes the browse filter.
      if (value === undefined) return undefined
      const provider = scopeProviderId(value)
      if (provider === undefined) return undefined
      // `null` is the every-provider entry.
      return { kind: 'scope', scope: provider ?? undefined }
    }
    case 'strip':
      // The strip's chips arrive on this same channel with their own ids, so a
      // strip click can never be mistaken for a bar action or a scope — and, like
      // the bar, only a chip the CURRENT page really renders is admitted.
      return value !== undefined && stripChips(panel).some((chip) => chip.id === value)
        ? { kind: 'page', page: 'more' }
        : undefined
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
 * One SDK ROW activation (a model row, an effort candidate row, or a row of the
 * More page).
 *
 * A candidate row carries its OWN wire namespace ({@link effortValue}), and that is
 * the only place a candidate value is read: the SDK delivers the scope column's ids
 * and the page's row ids on the same channel, so a candidate whose value looks like a
 * scope id (or IS the every-provider id) still changes the draft.
 *
 * A scope id arriving here is NOT a filter request: the scope column speaks on the
 * `action` channel ({@link actionIntent}), so accepting its shape here as well would
 * leave a second, unfrozen way into the browse filter. Only the model list browses a
 * model; the More page's rows are the secondary operations it lists.
 */
export function rowIntent(panel: ModelPickerPanel, item: string): ModelPickerIntent | undefined {
  if (panel.page === 'more') {
    // A More page row runs a SECONDARY operation, so it must be one the page
    // really offers RIGHT NOW: the ids are just strings on the wire, and an
    // unoffered one (`more:apply`, `more:close`) would otherwise resolve into the
    // one writer or the close action from a page whose bar has neither.
    const action = moreRowAction(item)
    if (action === undefined) return undefined
    return secondaryActions(panel).some((entry) => entry.id === action)
      ? actionIntent(panel, action, undefined)
      : undefined
  }
  if (panel.page === 'effort') {
    const value = effortValue(item)
    if (value !== undefined) {
      const choices = modelChoices(highlightedModel(panel))
      return choices.some((choice) => choice.value === value)
        ? { kind: 'browse-effort', value }
        : undefined
    }
  }
  if (panel.page !== 'models') return undefined
  return visibleModels(panel).some((row) => modelRowId(row) === item)
    ? { kind: 'browse-model', rowId: item }
    : undefined
}
