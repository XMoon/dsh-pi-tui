/** The native `/model` interaction vocabulary: how one real key or one SDK
 * event maps onto a panel intent.
 *
 * The map is PURE — it reads the panel and returns an intent; it never mutates
 * state and never writes. Admission (scope/phase/revision/zone) and the state
 * transition itself belong to the presenter, so this module is the whole K2
 * keyboard contract in one testable place.
 *
 * The layout is an explicit INPUT ({@link ModelPickerLayout}) instead of a
 * hidden guess: which regions are painted decides which regions Tab may reach
 * and what `Enter` on the model list does, never what may be written.
 * @module tui/tsp/model-picker-intents
 */
import type { Key } from '@stencil-hq/tern'
import {
  applyOffered,
  detailCardOffered,
  detailFactItems,
  draftedEffort,
  inlineEffortOffered,
  overviewItems,
  pickerActions,
  highlightedModel,
  modelChoices,
  modelRowId,
  scopeProviderId,
  visibleModels,
  type ModelPickerLayout,
  type ModelPickerPanel,
  type ModelPickerScope,
  type ModelPickerZone,
} from './model-picker-state.ts'

export type ModelPickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'zone'; readonly zone: ModelPickerZone }
  | { readonly kind: 'back' }
  | { readonly kind: 'scope'; readonly scope: ModelPickerScope }
  | { readonly kind: 'browse-model'; readonly rowId: string }
  | { readonly kind: 'open-overview'; readonly rowId?: string }
  | { readonly kind: 'open-details' }
  | { readonly kind: 'browse-effort'; readonly value: string }
  | { readonly kind: 'overview-cursor'; readonly delta: -1 | 1 }
  | { readonly kind: 'overview-select'; readonly item: string }
  | { readonly kind: 'activate-overview' }
  | { readonly kind: 'fact-cursor'; readonly delta: -1 | 1 }
  | { readonly kind: 'fact-select'; readonly item: string }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
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

/** Step the highlighted model's effort DRAFT (the wide inline selector). */
function stepEffort(panel: ModelPickerPanel, delta: -1 | 1): ModelPickerIntent | undefined {
  const row = highlightedModel(panel)
  const choices = modelChoices(row)
  if (choices.length === 0) return undefined
  const at = choices.findIndex((choice) => choice.value === draftedEffort(panel, row))
  const next = choices[(Math.max(at, 0) + delta + choices.length) % choices.length]
  return next === undefined ? undefined : { kind: 'browse-effort', value: next.value }
}

/** The frozen Tab/Shift+Tab cycle across the zones this page really paints. */
function tabZone(panel: ModelPickerPanel, layout: ModelPickerLayout, direction: -1 | 1): ModelPickerZone {
  // A failed read has exactly ONE operable region — its action bar (Retry /
  // Cancel). The stale model list keeps its rows on screen for context, but the
  // phase browses neither the list nor the search box and refuses Enter, so
  // Tab/Shift+Tab must never move the keyboard there: both stay in the bar,
  // where ←→ switches between Retry and the always-enabled Cancel.
  if (panel.phase === 'error') return 'primary-action'
  // The read-only Full details page and the model's Overview are CONTENT pages:
  // their main list plus the action bar. Neither renders a side region.
  if (panel.page !== 'models') {
    return panel.zone === 'primary-action' ? 'models' : 'primary-action'
  }
  // The model list cycles the regions the wide shell really paints. The Model
  // Details card comes FIRST after the list because that is the ring's own
  // forward order; the inline effort selector follows it, and only while the
  // wide column provably shows every candidate.
  const ring: ModelPickerZone[] = ['models']
  // The wide column only paints an actionable Model Details card while a model
  // is really highlighted (otherwise it is the inert "no model matches" text),
  // so an empty search must not park the keyboard on a card that cannot act.
  if (detailCardOffered(layout) && highlightedModel(panel) !== undefined) {
    ring.push('detail-card')
    if (panel.phase === 'ready' && inlineEffortOffered(panel, layout)) ring.push('effort')
  }
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
export function keyIntent(
  panel: ModelPickerPanel,
  key: Key,
  layout: ModelPickerLayout,
): ModelPickerIntent | undefined {
  // The original application cancel owner keeps Ctrl+C in every state.
  if (key.ctrl === true && key.name === 'c') return undefined
  if (key.name === 'escape') {
    // Esc is NEVER swallowed. An admitted write, a running (re-)read and a failed
    // read all leave the close action as the only reachable one, and in the failed
    // read the zone/page Esc would return to is inert (`tabZone` keeps the keyboard
    // in the bar for exactly that reason), so all three close instead of parking
    // the keyboard where no key acts.
    if (panel.phase === 'pending' || panel.phase === 'loading' || panel.phase === 'error') {
      return { kind: 'close' }
    }
    // The action bar returns to the region it was entered FROM (a details page's
    // Primary must not teleport the user into the effort selector).
    if (panel.zone === 'primary-action') return { kind: 'zone', zone: panel.previousZone ?? 'models' }
    // The side regions belong to the model list: Esc leaves them for the list.
    if (panel.zone === 'detail-card' || panel.zone === 'effort') {
      return { kind: 'zone', zone: 'models' }
    }
    // A content page's Esc is its own `Back`, so the visible action and the key
    // can never disagree.
    if (panel.page === 'details' || panel.page === 'overview') return { kind: 'back' }
    return { kind: 'close' }
  }
  // While the read runs the query stays editable (frozen §4.5) and every other
  // key is refused; an admitted write refuses everything but Esc/Ctrl+C.
  if (panel.phase === 'loading') {
    return panel.page === 'models' ? queryIntent(panel, key) : undefined
  }
  if (panel.phase === 'pending') return undefined
  if (key.name === 'tab') return { kind: 'zone', zone: tabZone(panel, layout, key.shift === true ? -1 : 1) }
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
  // The Overview's main list is the model's own page: its arrows move the ROW
  // cursor (over every identity continuation line, the details entry and the
  // effort candidates) and Enter acts on the row it is really on. Enter on a
  // static identity row is inert; on an effort row it drafts; on the details
  // entry it opens the read-only page.
  if (panel.page === 'overview') {
    if (key.name === 'up' || key.name === 'down') {
      return { kind: 'overview-cursor', delta: key.name === 'up' ? -1 : 1 }
    }
    return key.name === 'enter' ? { kind: 'activate-overview' } : undefined
  }
  // The details page's rows are inert FACTS, so its arrows only keep the native
  // list scrolled to the row being read (a long description must stay
  // reachable); they never change the browsed model and never write.
  if (panel.page === 'details') {
    if (key.name === 'up' || key.name === 'down') {
      return { kind: 'fact-cursor', delta: key.name === 'up' ? -1 : 1 }
    }
    return undefined
  }
  // The wide Model Details card is the model list's `detail-card` zone, and its
  // Enter must open exactly what its own label and its own pointer target open:
  // the FULL card (head = the model name + `›`) opens the read-only Full details
  // page, while the BOUNDED card (head = `Open model & effort ›`) opens the
  // model's Overview — the page that carries every candidate the column could not
  // present. Its arrows do nothing (the card is a single region, not a list).
  if (panel.zone === 'detail-card') {
    if (key.name !== 'enter') return undefined
    return { kind: layout.previewFull ? 'open-details' : 'open-overview' }
  }
  // The wide inline effort selector: its arrows change the DRAFT and Enter
  // confirms it onto the explicit Primary Action — never a write.
  if (panel.zone === 'effort') {
    if (key.name === 'up' || key.name === 'down') return stepEffort(panel, key.name === 'up' ? -1 : 1)
    return key.name === 'enter' ? { kind: 'zone', zone: 'primary-action' } : undefined
  }
  // Zone `models` on the model list: Enter never writes. The full wide column IS
  // the selector, so Enter moves the keyboard onto the details card; a bounded
  // column (and every compact width) has no inline selector, so Enter opens the
  // model's Overview — the page that carries the identity, the details entry and
  // every effort candidate.
  if (key.name === 'enter') {
    if (layout.wide && layout.previewFull) return { kind: 'zone', zone: 'detail-card' }
    return panel.selected === undefined ? undefined : { kind: 'open-overview', rowId: panel.selected }
  }
  if (key.name === 'up' || key.name === 'down') return stepModel(panel, key.name === 'up' ? -1 : 1)
  return queryIntent(panel, key)
}

/**
 * The action ids the CURRENT page really offers on the SDK's action channel: the
 * bar's own entries. An id outside this set is not merely absent from the
 * screen — it must be refused ON THE WIRE too, or a stale or forged receiver
 * could reach the one writer (or the close, paging and read actions) from a page
 * whose bar never offered them. The scope column has its own namespace and its
 * own live check instead.
 */
function offeredActionIds(panel: ModelPickerPanel, layout: ModelPickerLayout): Set<string> {
  return new Set(pickerActions(panel, layout).map((action) => action.id))
}

/**
 * Whether one action id this page may receive at all. `scope` is the scope
 * column's own channel; `close` is the panel's DISMISSAL authority — the same
 * intent `Esc` uses and the one the client's own backdrop gesture sends — so it
 * is admitted on every page even where the frozen footer deliberately renders no
 * `Cancel` (the Overview and the read-only Full details page). Every page
 * OPERATION (`back`, `retry`, `apply`) still has to be really rendered by the
 * current bar, so a stale or forged receiver cannot reach a write, a page change
 * or a re-read from a page that never offered it.
 */
function admissibleAction(panel: ModelPickerPanel, layout: ModelPickerLayout, act: string): boolean {
  return act === 'scope' || act === 'close' || offeredActionIds(panel, layout).has(act)
}

/** One SDK action event as an intent (the action bar AND the scope column). */
export function actionIntent(
  panel: ModelPickerPanel,
  act: string,
  value: string | undefined,
  layout: ModelPickerLayout,
): ModelPickerIntent | undefined {
  if (!admissibleAction(panel, layout, act)) return undefined
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
    case 'back':
      // The visible Back and the page's own Esc are the same intent, so they can
      // never disagree about where a content page returns.
      return { kind: 'back' }
    case 'retry':
      return { kind: 'retry' }
    case 'apply':
      // Defense in depth behind `offeredActionIds`: the write exists only where
      // the CURRENT page really carries it.
      return applyOffered(panel, layout) ? { kind: 'apply' } : undefined
    default:
      return undefined
  }
}

/**
 * One SDK ROW event (a model row, an Overview row, or a details fact row).
 *
 * The event KIND (`select` / `activate`) carries no distinct intent here: the
 * SDK sends `activate` for a click on the row that is already selected, and the
 * frozen contract makes both shapes idempotent on every page — highlighting at
 * the wide model list, entering the model's Overview at a compact width,
 * activating the Overview row it really names, and only moving the read cursor
 * on the details page. The event's `item` is the routing authority in every
 * case, never the previous cursor.
 *
 * A candidate row carries its OWN wire namespace ({@link
 * model-picker-state.effortItemId}), and that is the only place a candidate
 * value is read. A scope id arriving here is NOT a filter request: the scope
 * column speaks on the `action` channel, so accepting its shape here as well
 * would leave a second, unfrozen way into the browse filter.
 */
export function rowIntent(
  panel: ModelPickerPanel,
  item: string,
  layout: ModelPickerLayout,
): ModelPickerIntent | undefined {
  if (panel.page === 'overview') {
    // The Overview's rows are the REAL rows of the page the user is looking at:
    // only an id that row set currently carries may act, so a stale or forged
    // row can neither draft an effort nor open the details page.
    return overviewItems(panel, layout.wide).some((row) => row.id === item)
      ? { kind: 'overview-select', item }
      : undefined
  }
  if (panel.page === 'details') {
    const row = highlightedModel(panel)
    if (row === undefined) return undefined
    return detailFactItems(panel, row, layout.wide).some((fact) => fact.id === item)
      ? { kind: 'fact-select', item }
      : undefined
  }
  if (panel.page !== 'models') return undefined
  // A model row is validated against the VISIBLE rows, so a scope-shaped id can
  // never be read as a model (or the reverse).
  if (!visibleModels(panel).some((row) => modelRowId(row) === item)) return undefined
  // A compact model-list row opens THAT row's Overview; at the wide model list
  // the side column already describes the model, so the row only highlights it
  // (clicking an already-selected row must not page the surface away).
  return layout.wide ? { kind: 'browse-model', rowId: item } : { kind: 'open-overview', rowId: item }
}
