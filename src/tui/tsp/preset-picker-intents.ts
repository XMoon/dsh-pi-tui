/** The native `/preset` interaction vocabulary: how one real key or one SDK
 * event maps onto a panel intent.
 *
 * The map is PURE — it reads the panel and returns an intent; it never mutates
 * state and never writes. Admission (scope/phase/revision/zone) and the state
 * transition itself belong to the presenter, so this module is the whole two-zone
 * K2 keyboard contract in one testable place.
 * @module tui/tsp/preset-picker-intents
 */
import type { Key } from '@stencil-hq/tern'
import {
  presetRowId,
  stepRow,
  visibleRows,
  type PresetPickerPage,
  type PresetPickerPanel,
  type PresetPickerZone,
} from './preset-picker-state.ts'

export type PresetPickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'page'; readonly page: PresetPickerPage }
  | { readonly kind: 'zone'; readonly zone: PresetPickerZone }
  | { readonly kind: 'browse-row'; readonly rowId: string }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number }
  | { readonly kind: 'fact-cursor'; readonly delta: -1 | 1 }
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

/** The next caret/text state for one editing key on the preset list page. */
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

/** The search-box keys of the preset list page (also live while the read runs). */
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

/** The frozen Tab/Shift+Tab cycle across the two K2 zones. A failed read has
 *  exactly ONE operable region — its Retry/Close bar — so both directions stay
 *  in the bar instead of moving the keyboard onto an inert list. */
function tabZone(panel: PresetPickerPanel): PresetPickerZone {
  if (panel.phase === 'error') return 'actions'
  return panel.zone === 'list' ? 'actions' : 'list'
}

/**
 * K2: the frozen key contract. The list only ever browses (Enter commits
 * nothing); only the action bar's FOCUSED action can write.
 *
 * Returns `undefined` for a key the panel does not consume — the orchestrator
 * then leaves it to the original composer owner.
 */
export function keyIntent(panel: PresetPickerPanel, key: Key): PresetPickerIntent | undefined {
  // The original application cancel owner keeps Ctrl+C in every state.
  if (key.ctrl === true && key.name === 'c') return undefined
  if (key.name === 'escape') {
    // Esc is NEVER swallowed. An admitted write, a running (re-)read and a failed
    // read all leave Close as the only reachable action, so all three close
    // instead of parking the keyboard where no key acts.
    if (panel.phase === 'pending' || panel.phase === 'loading' || panel.phase === 'error') {
      return { kind: 'close' }
    }
    // The action bar returns to the zone it was entered FROM, so Esc from a
    // Details page's bar stays on that page.
    if (panel.zone === 'actions') return { kind: 'zone', zone: panel.previousZone ?? 'list' }
    if (panel.page === 'details') return { kind: 'page', page: 'presets' }
    return { kind: 'close' }
  }
  // While the read runs the query stays editable and every other key is refused;
  // an admitted write refuses everything but Esc/Ctrl+C.
  if (panel.phase === 'loading') {
    return panel.page === 'presets' ? queryIntent(panel, key) : undefined
  }
  if (panel.phase === 'pending') return undefined
  if (key.name === 'tab') return { kind: 'zone', zone: tabZone(panel) }
  // The action bar owns Enter and the bar-internal focus movement. Enter only
  // ever activates the FOCUSED action.
  if (panel.zone === 'actions') {
    if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
      return { kind: 'action-focus', delta: key.name === 'up' || key.name === 'left' ? -1 : 1 }
    }
    return key.name === 'enter' ? { kind: 'activate-action' } : undefined
  }
  // A failed read owns no browsable list: only the action bar (Tab) is live.
  if (panel.phase === 'error') return undefined
  // The Details page's rows are inert FACTS: its arrows only keep the native list
  // scrolled to the row being read, and Enter never writes.
  if (panel.page === 'details') {
    if (key.name === 'up' || key.name === 'down') {
      return { kind: 'fact-cursor', delta: key.name === 'up' ? -1 : 1 }
    }
    return undefined
  }
  if (key.name === 'up' || key.name === 'down') {
    const next = stepRow(panel, key.name === 'up' ? -1 : 1)
    return next === undefined ? undefined : { kind: 'browse-row', rowId: next }
  }
  // Enter on the list is browse-only: the write action must be focused first.
  if (key.name === 'enter') return undefined
  return queryIntent(panel, key)
}

/** One SDK action event as an intent (the action bar path). */
export function actionIntent(act: string): PresetPickerIntent | undefined {
  switch (act) {
    case 'close':
      return { kind: 'close' }
    case 'details':
      return { kind: 'page', page: 'details' }
    case 'back':
      // Back leaves the read-only page for the list AND returns the keyboard
      // there, exactly like its Esc.
      return { kind: 'page', page: 'presets' }
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

/**
 * One SDK row activation. Only a row of the {@link presetItemId} namespace can
 * ever browse: a Details fact row and an action id are both inert here, so no
 * real preset id (any text, `:` and Unicode included) can be mistaken for a
 * control entry.
 */
export function rowIntent(panel: PresetPickerPanel, item: string): PresetPickerIntent | undefined {
  const id = presetRowId(item)
  if (id === undefined) return undefined
  // Only a row the CURRENT query makes visible may become the browse target.
  return visibleRows(panel).some((row) => row.id === id)
    ? { kind: 'browse-row', rowId: id }
    : undefined
}
