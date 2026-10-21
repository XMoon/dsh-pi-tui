/** The native `/model` interaction vocabulary: how one real key or one SDK
 *  event maps onto a panel intent.
 *
 * The map is PURE — it reads the panel and returns an intent; it never mutates
 * state and never writes. Admission (phase/revision/zone) and the state
 * transition itself belong to the presenter, so this module is the whole K2
 * keyboard contract in one testable place.
 *
 * The two SDK row events are NOT the same intent: `select` is the client telling
 * the panel which row the user moved onto (browse only, zero write), while
 * `activate` is a deliberate activation of that row — it opens that model's
 * read-only Full details. Keeping them apart is what lets ONE click highlight a
 * model and the same click on the already-highlighted row enter it.
 * @module tui/tsp/model-picker-intents
 */
import type { Key, ScrollTo } from '@stencil-hq/tern'
import {
  FAILURE_RETRY_ID,
  retryRowOffered,
  applyOffered,
  draftedEffort,
  actionBase,
  catalogueRowIds,
  stripItemParts,
  highlightedModel,
  modelChoices,
  modelRowId,
  pickerActions,
  stripOffered,
  visibleModels,
  type ModelPickerPanel,
  type ModelPickerZone,
} from './model-picker-state.ts'

export type ModelPickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'zone'; readonly zone: ModelPickerZone }
  | { readonly kind: 'back' }
  | { readonly kind: 'browse-model'; readonly rowId: string }
  | { readonly kind: 'browse-effort'; readonly value: string }
  | { readonly kind: 'open-details'; readonly rowId?: string }
  | { readonly kind: 'reader-scroll'; readonly step: ScrollTo }
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

/** The next caret/text state for one editing key on the catalogue page. */
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

/**
 * The rows the catalogue's keyboard cursor really walks: every visible model,
 * plus — only while the current read reports failed providers — the ONE read-only
 * `Retry failed providers` row. The client does NOT own list navigation (measured:
 * arrow keys move nothing without the app driving `selected`), so this walk is
 * the app's own and it is what makes every visible row keyboard reachable.
 */
function catalogueCursorIds(panel: ModelPickerPanel): readonly string[] {
  return catalogueRowIds(panel)
}

/** Step the catalogue cursor, wrapping (browse only — never a write). */
function stepModel(panel: ModelPickerPanel, delta: -1 | 1): ModelPickerIntent | undefined {
  const ids = catalogueCursorIds(panel)
  if (ids.length === 0) return undefined
  const at = ids.findIndex((id) => id === panel.selected)
  const next = ids[(Math.max(at, 0) + delta + ids.length) % ids.length]
  return next === undefined ? undefined : { kind: 'browse-model', rowId: next }
}

/**
 * Step the HIGHLIGHTED model's draft by one candidate (the strip's own arrows). It
 * changes local browse state only: no write, no page change.
 */
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
  // Cancel). The stale catalogue keeps its rows on screen for context, but the
  // phase browses neither the list nor the search box and refuses Enter, so
  // Tab/Shift+Tab must never move the keyboard there: both stay in the bar,
  // where ←→ switches between Retry and the always-enabled Cancel.
  if (panel.phase === 'error') return 'primary-action'
  // The catalogue paints its own effort strip between the list and the bar; a phase
  // that cannot draft and a model without effort metadata both have no strip to
  // reach.
  const ring: ModelPickerZone[] = ['models']
  if (stripOffered(panel)) ring.push('strip')
  ring.push('primary-action')
  const at = Math.max(ring.indexOf(panel.zone), 0)
  return ring[(at + direction + ring.length) % ring.length]!
}

/** The search-box keys of the catalogue page (also live while the read runs). */
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
 * The Reader's own keys: they move the native scroll container the app addresses
 * (the SDK's `scroll` op) and never change a draft, a page or a write. Returns
 * `undefined` for every other key, so the READ-ONLY page has no other keyboard
 * behaviour at all — not even `Tab`, which has no second region to reach.
 */
function readerScrollIntent(key: Key): ModelPickerIntent | undefined {
  const step: ScrollTo | undefined = key.name === 'up' ? 'line-up'
    : key.name === 'down' ? 'line-down'
      : key.name === 'page_up' ? 'page-up'
        : key.name === 'page_down' ? 'page-down'
          : key.name === 'home' ? 'start'
            : key.name === 'end' ? 'end'
              : undefined
  return step === undefined ? undefined : { kind: 'reader-scroll', step }
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
    // The read-only Reader's `Esc` IS its visible `Back` row, in every phase but
    // an admitted write: the row is on screen, so the key must not disagree with
    // it (and closing the whole panel there would drop the page context the
    // origin can restore).
    if (panel.page === 'details' && panel.phase !== 'pending') return { kind: 'back' }
    // An admitted write owns the panel: it is the one state whose only reachable
    // action is its dismissal, so Esc closes rather than editing anything.
    if (panel.phase === 'pending') return { kind: 'close' }
    // The Owner's ladder for the catalogue: `Esc` clears the SEARCH FILTER first and
    // closes the panel only once there is nothing left to clear. It is never swallowed
    // and needs no zone bookkeeping — the zone ring is how the keyboard moves between
    // the list, the strip and the bar, and it stays reachable while a read runs or has
    // failed for exactly that reason.
    if (panel.query !== '') return { kind: 'query', query: '', cursor: 0 }
    return { kind: 'close' }
  }
  // While the read runs the query stays editable (frozen §4.5) and every other
  // key is refused; an admitted write refuses everything but Esc/Ctrl+C. The
  // read-only Reader's own scroll keys are VIEW operations on the page the user is
  // looking at, so they follow the same rule as its visible Back and stay
  // available while the read merely runs or has failed.
  if (panel.phase === 'loading') {
    if (panel.page === 'details') return readerScrollIntent(key)
    return panel.page === 'models' ? queryIntent(panel, key) : undefined
  }
  if (panel.phase === 'pending') return undefined
  // The read-only Reader is ONE region: it has no selector and no action bar to
  // move to, so `Tab` is consumed as a no-op instead of re-emitting a zone the
  // page does not paint. `Esc`/`Back` (handled above) is its way out.
  if (panel.page === 'details') return readerScrollIntent(key)
  if (key.name === 'tab') return { kind: 'zone', zone: tabZone(panel, key.shift === true ? -1 : 1) }
  // The catalogue's effort strip: its arrows change the DRAFT and Enter hands the
  // keyboard to the action bar (never a write), exactly like the retired inline
  // effort zone did.
  if (panel.zone === 'strip') {
    if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
      return stepEffort(panel, key.name === 'up' || key.name === 'left' ? -1 : 1)
    }
    return key.name === 'enter' ? { kind: 'zone', zone: 'primary-action' } : undefined
  }
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
  // The catalogue's main list: Enter never writes. It opens the HIGHLIGHTED model's
  // read-only Full details DIRECTLY — there is no intermediate page — while the ONE
  // write stays on the explicit footer action. On the partial-failure row, Enter is
  // that row's own operation: the read-only re-read.
  if (key.name === 'enter') {
    if (panel.selected === undefined) return undefined
    return panel.selected === FAILURE_RETRY_ID
      ? { kind: 'retry' }
      : { kind: 'open-details', rowId: panel.selected }
  }
  if (key.name === 'up' || key.name === 'down') return stepModel(panel, key.name === 'up' ? -1 : 1)
  return queryIntent(panel, key)
}

/**
 * The action ids the CURRENT page really offers on the SDK's action channel: the
 * bar's own entries. An id outside this set is not merely absent from the
 * screen — it must be refused ON THE WIRE too, or a stale or forged receiver
 * could reach the one writer (or the close and read actions) from a page whose
 * bar never offered them.
 */
function offeredActionIds(panel: ModelPickerPanel): Set<string> {
  return new Set(pickerActions(panel).map((action) => action.id))
}

/**
 * Whether one action id this page may receive at all. `close` is the panel's
 * DISMISSAL authority — the same intent `Esc` uses and the one the client's own
 * backdrop gesture sends — so it is admitted on every page, including the read-only
 * Reader, where the frozen footer deliberately renders no `Cancel`. Every page OPERATION
 * (`back`, `retry`, `apply`) still has to be really rendered by the current bar,
 * so a stale or forged receiver cannot reach a write, a page change or a re-read
 * from a page that never offered it.
 */
function admissibleAction(panel: ModelPickerPanel, act: string): boolean {
  // `close` is the panel's DISMISSAL authority and is admitted on every page.
  if (act === 'close') return true
  // The strip's own channel exists only while the catalogue really paints it.
  if (act === 'strip') return stripOffered(panel)
  // The read-only Reader is not a picker and paints NO action bar at all, so only
  // that dismissal authority is admitted there: a stale or forged page operation
  // addressed to it (a `retry`, a `back`, an `apply`) must never start a read,
  // navigate or write from a page that offers none of them.
  if (panel.page === 'details') return false
  return offeredActionIds(panel).has(act)
}

/** One SDK action event as an intent (the action bar, or the catalogue's strip). */
export function actionIntent(
  panel: ModelPickerPanel,
  act: string,
  value?: string,
): ModelPickerIntent | undefined {
  if (!admissibleAction(panel, act)) return undefined
  if (act === 'strip') {
    // STRICT, in BOTH halves: the click must name the model the strip CURRENTLY shows
    // AND a candidate that model advertises. A strip event is delivered asynchronously, so
    // the user can click another model in between; a value-only check would then let the
    // PREVIOUS model's candidate draft into the newly highlighted model whenever both
    // happen to advertise the same value.
    if (value === undefined) return undefined
    const parts = stripItemParts(value)
    const row = highlightedModel(panel)
    if (parts === undefined || row === undefined) return undefined
    if (parts.rowId !== modelRowId(row)) return undefined
    return modelChoices(row).some((choice) => choice.value === parts.value)
      ? { kind: 'browse-effort', value: parts.value }
      : undefined
  }
  // The bar's own actions carry the frame token of the revision that rendered them, so
  // an action from an earlier frame is refused here even though its node id is long-lived.
  const base = actionBase(panel, act)
  if (base === undefined) return undefined
  switch (base) {
    case 'close':
      return { kind: 'close' }
    case 'back':
      // The visible Back and the page's own Esc are the same intent, so they can
      // never disagree about where a content page returns.
      return { kind: 'back' }
    case 'retry':
      return { kind: 'retry' }
    case 'apply':
      // Defense in depth behind `offeredActionIds`: the write exists only where
      // the CURRENT page really carries it.
      return applyOffered(panel) ? { kind: 'apply' } : undefined
    default:
      return undefined
  }
}

/**
 * One SDK ROW event (a model row, or the read-only Retry row).
 *
 * The event KIND carries a distinct intent on the catalogue: `select` moves the
 * highlight onto the row the client names — browse only, never a write and never a
 * page change — while `activate` (a click on the already-highlighted row, a double
 * click, or `Enter`) opens that model's read-only Full details DIRECTLY. The event's
 * `item` is the routing authority in every case, never the previous cursor.
 *
 * The catalogue's rows are the REAL rows of the page the user is looking at, so
 * only an id the row set currently carries may act; the read-only Reader has NO
 * selectable row of its own (its one interactive node is the `Back` row, which the
 * SDK dispatches as its own `onClick`), so a row event can never act on that page.
 */
export function rowIntent(
  panel: ModelPickerPanel,
  item: string,
  kind: 'select' | 'activate',
): ModelPickerIntent | undefined {
  if (panel.page !== 'models') return undefined
  // The partial-failure row is the ONE read-only operation row of the catalogue:
  // it routes to the command's existing read owner, never to the writer. It exists
  // only while the current read really reports failures.
  if (item === FAILURE_RETRY_ID) return retryRowOffered(panel) ? { kind: 'retry' } : undefined
  // A model row is validated against the VISIBLE rows, so a failure-shaped id can
  // never be read as a model (or the reverse).
  if (!visibleModels(panel).some((row) => modelRowId(row) === item)) return undefined
  // A `select` only ever moves the highlight; opening the model's read-only details
  // is the `activate` shape (a click on the already-highlighted row, a double
  // click, or `Enter`).
  return kind === 'activate' ? { kind: 'open-details', rowId: item } : { kind: 'browse-model', rowId: item }
}
