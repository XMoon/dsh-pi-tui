/** The native `/preset` interaction vocabulary: how one real key or one SDK event
 *  maps onto a panel intent.
 *
 * The map is PURE — it reads the panel and returns an intent; it never mutates state
 * and never writes. Admission (scope/phase/revision/zone) and the state transition
 * itself belong to the presenter, so this module is the whole two-page keyboard
 * contract in one testable place.
 *
 * The two SDK row events are NOT the same intent: `select` is the client telling the
 * panel which card the user moved onto (browse only, zero write), while `activate` is
 * a deliberate activation of that card — it opens that preset's read-only Details
 * page over the event's OWN row. Keeping them apart is what lets ONE click highlight
 * a card and the next click on the already-highlighted card enter it.
 * @module tui/tsp/preset-picker-intents
 */
import type { Key, ScrollTo } from '@stencil-hq/tern'
import {
  FRAME_FREE_ACTION,
  actionBase,
  actionEnabled,
  focusedAction,
  presetRowId,
  stepRow,
  visibleRows,
  type PresetPickerPanel,
  type PresetPickerZone,
} from './preset-picker-state.ts'

export type PresetPickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'zone'; readonly zone: PresetPickerZone }
  | { readonly kind: 'browse-row'; readonly rowId: string }
  | { readonly kind: 'open-details'; readonly rowId?: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'reader-scroll'; readonly step: ScrollTo }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
  | { readonly kind: 'action-focus'; readonly delta: -1 | 1 }
  | { readonly kind: 'activate-action' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'apply' }
  | { readonly kind: 'save-default' }

/** The grapheme boundaries of the search text (CJK/emoji/combining safe). */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
function graphemes(text: string): number[] {
  return [...segmenter.segment(text)].map((segment) => segment.index).concat(text.length)
}

/** The next caret/text state for one editing key on the catalogue page. */
function editedQuery(
  panel: PresetPickerPanel,
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

/** The search-box keys of the catalogue page (also live while the read runs). */
function queryIntent(panel: PresetPickerPanel, key: Key): PresetPickerIntent | undefined {
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
 * The Details page's own keys: they move the native scroll container the app addresses
 * (the SDK's `scroll` op) and never change the page or write anything. Arrows,
 * PageUp/PageDown, Home and End are therefore pure reading.
 */
function readerScrollIntent(key: Key): PresetPickerIntent | undefined {
  const step: ScrollTo | undefined = key.name === 'up' ? 'line-up'
    : key.name === 'down' ? 'line-down'
      : key.name === 'page_up' ? 'page-up'
        : key.name === 'page_down' ? 'page-down'
          : key.name === 'home' ? 'start'
            : key.name === 'end' ? 'end'
              : undefined
  return step === undefined ? undefined : { kind: 'reader-scroll', step }
}

/** The frozen Tab/Shift+Tab cycle of the catalogue's two zones. A failed read has
 *  exactly ONE operable region — its Retry/Close footer — so both directions stay in
 *  the footer instead of moving the keyboard onto an inert list. */
function tabZone(panel: PresetPickerPanel, direction: -1 | 1): PresetPickerZone {
  if (panel.phase === 'error') return 'actions'
  const ring: readonly PresetPickerZone[] = ['list', 'actions']
  const at = Math.max(ring.indexOf(panel.zone), 0)
  return ring[(at + direction + ring.length) % ring.length]!
}

/**
 * The frozen key contract.
 *
 * The catalogue's cards only ever browse (`Enter` opens the Details page, it never
 * writes); only the footer's FOCUSED enabled action can write, and the footer's
 * arrows walk its own ring. The Details page reads: its arrows/PageUp/PageDown/
 * Home/End scroll the page's own body, `Esc` (and `Enter` while Back owns the
 * reading focus) goes back, and nothing else is mapped.
 *
 * Returns `undefined` for a key the panel does not consume.
 */
export function keyIntent(panel: PresetPickerPanel, key: Key): PresetPickerIntent | undefined {
  // The original application cancel owner keeps Ctrl+C in every state.
  if (key.ctrl === true && key.name === 'c') return undefined
  if (key.name === 'escape') {
    // An admitted write owns the panel: its only reachable entry is the dismissal,
    // so Esc closes instead of editing anything.
    if (panel.phase === 'pending') return { kind: 'close' }
    // The Details page's Esc IS the always-available fixed way back (the row is
    // the pointer path at the page top): leaving the page for the catalogue,
    // which keeps the query and the browse target. `Esc` works from any reading
    // position — including the tail of a long guide.
    if (panel.page === 'details') return { kind: 'back' }
    // The catalogue's ladder: Esc clears the SEARCH FILTER first and closes the panel
    // only once there is nothing left to clear. It is never swallowed, and it stays
    // reachable while the read runs or has failed.
    if (panel.query !== '') return { kind: 'query', query: '', cursor: 0 }
    return { kind: 'close' }
  }
  // While the read runs the catalogue's query stays editable and every other key is
  // refused; an admitted write refuses everything but Esc/Ctrl+C. The Details page's
  // own scroll keys are VIEW operations on the page the user is looking at, so they
  // stay available while the read merely runs.
  if (panel.phase === 'loading') {
    return panel.page === 'catalog' ? queryIntent(panel, key) : readerScrollIntent(key)
  }
  if (panel.phase === 'pending') return undefined
  // The Details page is ONE read-only region: arrows/PageUp/PageDown/Home/End read
  // the body; `Enter` runs the page's ONE registered control (its Back navigation row).
  // There is no footer, no second zone and no write anywhere on it.
  if (panel.page === 'details') {
    return key.name === 'enter' ? { kind: 'activate-action' } : readerScrollIntent(key)
  }
  if (key.name === 'tab') return { kind: 'zone', zone: tabZone(panel, key.shift === true ? -1 : 1) }
  // The footer owns Enter and the footer-internal focus movement. Enter only ever
  // activates the FOCUSED entry — and the search box stays live in the action zone
  // too (F1: the Esc ladder needs an editable query in EVERY catalogue phase, and
  // the footer's own keys never collide with printable text).
  if (panel.zone === 'actions') {
    if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
      return { kind: 'action-focus', delta: key.name === 'up' || key.name === 'left' ? -1 : 1 }
    }
    if (key.name === 'enter') return { kind: 'activate-action' }
    if (panel.phase === 'error') return queryIntent(panel, key)
    return undefined
  }
  // A failed read owns no browsable list: only the footer (Tab) is live.
  if (panel.phase === 'error') return undefined
  // The catalogue's cards: Enter opens the HIGHLIGHTED preset's read-only Details
  // page. It never writes — the writes stay on the explicit footer entries.
  if (key.name === 'enter') {
    return panel.selected === undefined ? undefined : { kind: 'open-details', rowId: panel.selected }
  }
  if (key.name === 'up' || key.name === 'down') {
    const next = stepRow(panel, key.name === 'up' ? -1 : 1)
    return next === undefined ? undefined : { kind: 'browse-row', rowId: next }
  }
  return queryIntent(panel, key)
}

/**
 * One SDK action event (the catalogue's footer).
 *
 * `close` is the panel's DISMISSAL authority — the same intent `Esc` uses and the
 * one the client's own backdrop gesture sends — so it is admitted on every page,
 * including the Details page, which deliberately paints no footer. Every other
 * entry must be one the CURRENT frame really rendered: its id carries the frame's
 * revision token, and the SAME availability decision the footer paints is consumed
 * again, so a stale or forged receiver can neither reach the writer from a page
 * that never offered it nor write with a disabled entry.
 */
export function actionIntent(panel: PresetPickerPanel, act: string): PresetPickerIntent | undefined {
  if (act === FRAME_FREE_ACTION) return { kind: 'close' }
  // The footer exists only on the catalogue page; anywhere else the id can only be a
  // stale one.
  if (panel.page !== 'catalog') return undefined
  const base = actionBase(panel, act)
  if (base === undefined) return undefined
  switch (base) {
    case 'retry':
      return actionEnabled(panel, 'retry') ? { kind: 'retry' } : undefined
    case 'use':
      return actionEnabled(panel, 'use') ? { kind: 'apply' } : undefined
    case 'set-default':
      return actionEnabled(panel, 'set-default') ? { kind: 'save-default' } : undefined
    default:
      return undefined
  }
}

/**
 * The intent one operation BASE id runs — the ONE mapping the keyboard's Enter and
 * every registered control share, so a bound `onClick` closure and the focused
 * entry can never disagree about what an operation does. The Details page
 * registers exactly one control (its Back navigation row); the panel's dismissal stays
 * frame-free.
 */
export function operationIntent(base: string): PresetPickerIntent | undefined {
  switch (base) {
    case FRAME_FREE_ACTION:
      return { kind: 'close' }
    case 'back':
      return { kind: 'back' }
    case 'retry':
      return { kind: 'retry' }
    case 'use':
      return { kind: 'apply' }
    case 'set-default':
      return { kind: 'save-default' }
    default:
      return undefined
  }
}

/** The intent the operation that owns Enter runs right now. The availability recheck
 *  happens in the admission, on the very same predicate the page rendered. On the
 *  Details page Enter means the way back (the page paints no footer). */
export function focusedIntent(panel: PresetPickerPanel): PresetPickerIntent | undefined {
  if (panel.page === 'details') return { kind: 'back' }
  return operationIntent(focusedAction(panel).id)
}

/**
 * One SDK card event (a preset card).
 *
 * The event KIND carries a distinct intent: `select` moves the browse target onto the
 * card the client names — browse only, never a write and never a page change — while
 * `activate` (a click on the already-selected card, a double click, or `Enter`) opens
 * that preset's read-only Details page. The event's `item` is the routing authority in
 * every case, never the previous browse target, so activating a card other than the
 * highlighted one opens the card the user really clicked.
 *
 * Only an id of the `preset:` row namespace that the CURRENT query makes visible may
 * act, so no real preset id (any text, `:` and Unicode included) can be mistaken for a
 * control entry, and no reading page can be opened from a card that is not on screen.
 */
export function rowIntent(
  panel: PresetPickerPanel,
  item: string,
  kind: 'select' | 'activate',
): PresetPickerIntent | undefined {
  if (panel.page !== 'catalog') return undefined
  const id = presetRowId(item)
  if (id === undefined) return undefined
  if (!visibleRows(panel).some((row) => row.id === id)) return undefined
  return kind === 'activate' ? { kind: 'open-details', rowId: id } : { kind: 'browse-row', rowId: id }
}
