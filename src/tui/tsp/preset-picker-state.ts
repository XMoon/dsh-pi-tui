/** Panel state and pure selectors for the native TSP `/preset` presentation.
 *
 * This module answers only "what is the panel currently browsing / offering":
 * its state, the pure selectors over it, the list/status projection of one
 * roster read, the action bar's contents and the Details page's complete fact
 * rows. It renders nothing, mutates nothing and writes nothing, so the view
 * builder and the key map stay pure functions over one explicit state object.
 * @module tui/tsp/preset-picker-state
 */
import type { PickerAction, PickerItem } from '@stencil-hq/tern'
import type {
  PresetPickerRequest,
  PresetPickerRoster,
} from '../../app/command/preset-presentation.ts'
import { factRowItems, oneLine } from './picker-text.ts'
import { isBuiltInPresetRow, presetDisplayText } from '../pickers/preset-display.ts'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
export type PresetPickerPhase = 'loading' | 'ready' | 'error' | 'pending'

/** The visible page. Both are the SAME native picker list. */
export type PresetPickerPage = 'presets' | 'details'

/** K2: the two logical regions Tab moves between. Only `actions` may ever
 *  commit a write, and only while the focused action is enabled. */
export type PresetPickerZone = 'list' | 'actions'

/** Which explicit write owns the `pending` phase (the visible label). */
export type PresetPickerPending = 'use' | 'default'

export interface PresetPickerPanel {
  /** The presenter serial: an event bound to another panel can never act here. */
  readonly serial: number
  readonly request: PresetPickerRequest
  revision: number
  disposed: boolean
  phase: PresetPickerPhase
  page: PresetPickerPage
  zone: PresetPickerZone
  pending: PresetPickerPending | undefined
  /** The browse target: the row the explicit actions would act on. It is local
   *  browse state — moving it never writes anything. */
  selected: string | undefined
  /**
   * Which action bar entry owns Enter while the keyboard is in the action zone.
   * A missing id (and any id the current page no longer offers) falls back to
   * the page's preferred first ENABLED write action.
   */
  actionFocus: string | undefined
  /** The zone the keyboard came from when it entered the action bar (Esc returns
   *  there instead of re-deriving one). */
  previousZone: PresetPickerZone | undefined
  /** The single local notice (a read error or the last write outcome). */
  notice: string
  /** The adopted roster read plus the display facts captured with it. */
  roster: PresetPickerRoster | undefined
  query: string
  cursor: number
  /**
   * The Details page's presentation cursor (an index into its inert fact rows).
   * It only keeps the native list scrolled to the row the user is reading, so a
   * long description's tail stays reachable from the keyboard.
   */
  factCursor: number
}

/* --------------------------------------------------------------- namespaces */

const ROW_PREFIX = 'preset:'

/**
 * The wire id of one preset row. A preset's real id is arbitrary user text, so
 * the namespace prefix is the ONLY thing the wire id adds: the raw id is kept
 * verbatim after it (`preset:fact:x` is still a preset row). Rows are the only
 * ids that reach the SDK's row channel, so no real preset id can collide with
 * an action id (`close`, `details`, `back`, `use`, `set-default`, `retry`) or
 * with a Details fact-row id (`fact:…`).
 */
export function presetItemId(id: string): string {
  return ROW_PREFIX + id
}

/** The preset id of one wire row id, or `undefined` when the id is not a row. */
export function presetRowId(item: string): string | undefined {
  return item.startsWith(ROW_PREFIX) ? item.slice(ROW_PREFIX.length) : undefined
}

/* ---------------------------------------------------------------- selectors */

/** One display row of the roster: the row's own metadata plus the shipped-copy
 *  classification. Derived on every read — never a second durable store. */
export interface PresetPickerRow {
  readonly id: string
  readonly name: string
  readonly description: string | undefined
  readonly builtIn: boolean
  readonly broken: string | undefined
}

/** Every roster row in BUILT-IN then CUSTOM order; each group keeps the roster's
 *  own order (the SDK declares no group node, so the grouping is a row-order
 *  fact and every row's own `detail` names its kind). */
export function presetRows(panel: PresetPickerPanel): readonly PresetPickerRow[] {
  const view = panel.roster
  if (view === undefined) return []
  const rows = view.roster.presets.map((preset): PresetPickerRow => {
    const display = presetDisplayText(preset)
    return {
      id: preset.id,
      name: display.name,
      description: display.description,
      builtIn: isBuiltInPresetRow(preset),
      broken: preset.broken,
    }
  })
  return [...rows.filter((row) => row.builtIn), ...rows.filter((row) => !row.builtIn)]
}

/** The rows the current query makes visible, in roster order. */
export function visibleRows(panel: PresetPickerPanel): readonly PresetPickerRow[] {
  const query = panel.query.toLowerCase()
  return presetRows(panel).filter((row) =>
    `${row.name} ${row.id} ${row.description ?? ''}`.toLowerCase().includes(query),
  )
}

/** The browse target, or `undefined` when nothing visible is selected. */
export function highlightedRow(panel: PresetPickerPanel): PresetPickerRow | undefined {
  return visibleRows(panel).find((row) => row.id === panel.selected)
}

/** The live Session's preset (`Current session`), for a live subject. */
export function currentId(panel: PresetPickerPanel): string | undefined {
  return panel.request.subject.sessionless ? undefined : panel.roster?.currentId
}

/** The run-local pending preset (`Next session`), for a sessionless subject. */
export function pendingId(panel: PresetPickerPanel): string | undefined {
  return panel.request.subject.sessionless ? panel.roster?.pendingId : undefined
}

/** The effective new-session default (`New-session default`). */
export function defaultId(panel: PresetPickerPanel): string | undefined {
  return panel.roster?.defaultId
}

/**
 * The `Draft` marker: the browse target whenever it is NOT one of the committed
 * facts. It exists to keep "the row the actions would use" visually separate
 * from "what is already committed" (a row that IS current/default/next needs no
 * third marker), and it never writes anything by itself.
 */
export function draftId(panel: PresetPickerPanel): string | undefined {
  const row = highlightedRow(panel)
  if (row === undefined) return undefined
  const committed = [currentId(panel), pendingId(panel), defaultId(panel)]
  return committed.includes(row.id) ? undefined : row.id
}

/** One row's second line: its classification plus a ONE-line description (the
 *  complete text lives on the Details page). A broken row carries its reason
 *  instead, because that is the fact the user must be able to read before
 *  choosing anything. */
export function rowDetail(row: PresetPickerRow): string {
  const kind = row.builtIn ? 'Built-in' : 'Custom'
  const published = row.description === undefined || row.description.trim() === ''
    ? 'No description.'
    : oneLine(row.description)
  return row.broken === undefined
    ? `${kind} · ${published}`
    : `${kind} · Failed to load: ${oneLine(row.broken)}`
}

function rowBadges(panel: PresetPickerPanel, row: PresetPickerRow): PickerItem['badges'] {
  const badges: { text: string; tone?: 'error' }[] = []
  if (row.id === currentId(panel)) badges.push({ text: 'Current' })
  if (row.id === pendingId(panel)) badges.push({ text: 'Next session' })
  if (row.id === defaultId(panel)) badges.push({ text: 'Default' })
  if (row.id === draftId(panel)) badges.push({ text: 'Draft' })
  if (row.broken !== undefined) badges.push({ text: 'Failed to load', tone: 'error' })
  return badges
}

/** The list page's rows. Identity is the NAME (the shipped English copy for a
 *  shipped preset, the declaration's own metadata otherwise); the raw id rides
 *  in the item's `title` and is complete on the Details page. */
export function presetItems(panel: PresetPickerPanel): PickerItem[] {
  return visibleRows(panel).map((row) => ({
    id: presetItemId(row.id),
    label: row.name,
    detail: rowDetail(row),
    title: row.id,
    ...(row.broken === undefined ? {} : { dot: 'error' as const }),
    badges: rowBadges(panel, row),
  }))
}

/* ------------------------------------------------------------ status facts */

/** The two independent session/default facts of the list page, plus the Draft
 *  marker when the browse target is not committed. Every line is the COMPLETE
 *  value: a caller that needs it to stay inside one rendered line must bound it
 *  itself (see the view's measured header bound). */
export function statusLines(panel: PresetPickerPanel): readonly string[] {
  const lines: string[] = []
  if (panel.request.subject.sessionless) lines.push(`Next session: ${pendingId(panel) ?? 'none'}`)
  else lines.push(`Current session: ${currentId(panel) ?? 'none'}`)
  lines.push(`New-session default: ${defaultId(panel) ?? 'none'}`)
  const draft = draftId(panel)
  if (draft !== undefined) lines.push(`Draft: ${draft}`)
  return lines
}

/* --------------------------------------------------------------- action bar */

function useActionLabel(panel: PresetPickerPanel): string {
  return panel.request.subject.sessionless ? 'Use for next session' : 'Use in this session'
}

function pendingLabel(panel: PresetPickerPanel): string {
  return panel.pending === 'default' ? 'Saving default…' : 'Applying preset…'
}

/**
 * The action bar for the current phase and page: the ONE owner of "which actions
 * exist". Order is frozen (Details/Back, Use, Set new-session default, Close)
 * and only the phase and the highlighted row's admissibility change it: an
 * admitted write, a running read and a failed read all replace the writes.
 */
export function pickerActions(panel: PresetPickerPanel): PickerAction[] {
  if (panel.phase === 'error') return [
    { id: 'retry', label: 'Retry', primary: true },
    { id: 'close', label: 'Close', end: true },
  ]
  if (panel.phase === 'pending') return [
    { id: panel.pending === 'default' ? 'set-default' : 'use', label: pendingLabel(panel), primary: true, disabled: true },
    { id: 'close', label: 'Close', end: true },
  ]
  if (panel.phase === 'loading') return [{ id: 'close', label: 'Close', end: true }]
  const row = highlightedRow(panel)
  const writable = row !== undefined && row.broken === undefined
  const canSetDefault = writable && panel.roster?.canSetDefault === true && row.id !== defaultId(panel)
  return [
    panel.page === 'details'
      ? { id: 'back', label: 'Back' }
      : { id: 'details', label: 'Details', ...(row === undefined ? { disabled: true } : {}) },
    { id: 'use', label: useActionLabel(panel), ...(writable ? {} : { disabled: true }) },
    { id: 'set-default', label: 'Set new-session default', ...(canSetDefault ? {} : { disabled: true }) },
    { id: 'close', label: 'Close', end: true },
  ] as PickerAction[]
}

/**
 * The actions that may own Enter in the CURRENT phase, in the order the user
 * should be offered them when the bar is entered: the explicit write first, then
 * the other write, then the read-only page action, then Close. In the phases
 * with a single operable region (a failed read's Retry, a running read's Close)
 * that region is the whole list.
 */
function focusPreference(panel: PresetPickerPanel): readonly string[] {
  if (panel.phase === 'error') return ['retry', 'close']
  if (panel.phase === 'loading' || panel.phase === 'pending') return ['close']
  return panel.page === 'details'
    ? ['use', 'set-default', 'back', 'close']
    : ['use', 'set-default', 'details', 'close']
}

/** The action that owns Enter right now. An explicit bar focus outside the
 *  current phase/page falls back to {@link focusPreference}, and a DISABLED
 *  action owns no Enter and shows no cue, so the fallback never parks the
 *  keyboard on a dead entry. */
export function focusedAction(panel: PresetPickerPanel): PickerAction {
  const actions = pickerActions(panel)
  const enabled = (action: PickerAction): boolean => action.disabled !== true
  const explicit = actions.find((action) => action.id === panel.actionFocus && enabled(action))
  if (explicit !== undefined) return explicit
  for (const id of focusPreference(panel)) {
    const action = actions.find((candidate) => candidate.id === id && enabled(candidate))
    if (action !== undefined) return action
  }
  return actions.filter(enabled).at(-1) ?? actions[actions.length - 1]!
}

/** The next ENABLED action in the bar, wrapping in `delta`'s direction. */
export function stepActionFocus(panel: PresetPickerPanel, delta: -1 | 1): string {
  const offered = pickerActions(panel).filter((action) => action.disabled !== true)
  const at = offered.findIndex((action) => action.id === focusedAction(panel).id)
  const next = offered[(Math.max(at, 0) + delta + offered.length) % offered.length]
  return next?.id ?? focusedAction(panel).id
}

/**
 * Whether the current phase lets the KEYBOARD run the action bar at all.
 *
 * The bar is rendered in every phase, but an admitted write (`pending`) and a
 * running (re-)read (`loading`) refuse every key except Esc, so no action there
 * can be activated from the keyboard. The `▸` cue is a promise about Enter, so
 * it is drawn only where this holds — everywhere else the bar must read as
 * having no keyboard focus instead of marking `Close` and then swallowing the
 * Enter that cue announced.
 */
export function actionKeyboardLive(panel: PresetPickerPanel): boolean {
  return panel.phase === 'ready' || panel.phase === 'error'
}

/** The single-line keyboard hint of the current zone (rendered by the view).
 *  It never names a BUSINESS action: in the action bar `Enter` runs whichever
 *  action that bar has FOCUSED — the `▸ label` cue says which. */
export function zoneHintText(panel: PresetPickerPanel): string {
  if (panel.phase === 'pending') return pendingLabel(panel)
  // The Owner-frozen loading copy: a running (re-)read answers the keyboard with
  // at most the search box, so the line names the READ instead of promising a
  // Tab/←→ the phase refuses.
  if (panel.phase === 'loading') return 'Loading agent presets…'
  if (panel.phase === 'error') return 'Retry first'
  return panel.zone === 'actions' ? '←→ · Enter' : 'Tab: actions'
}

/** Step the browse target, wrapping (browse only — never a write). */
export function stepRow(panel: PresetPickerPanel, delta: -1 | 1): string | undefined {
  const ids = visibleRows(panel).map((row) => row.id)
  if (ids.length === 0) return undefined
  const at = ids.findIndex((id) => id === panel.selected)
  return ids[(Math.max(at, 0) + delta + ids.length) % ids.length]
}

/* ------------------------------------------------------------- details page */

/**
 * The row's COMPLETE facts. Nothing here is truncated: every value is wrapped by
 * the shared measured fact-row algorithm, so a long description, a CJK/emoji
 * name, an unbroken id or an explicit newline stays readable to its last row
 * from the keyboard. `Current session` / `New-session default` / `Next session`
 * are stated only for a row that IS that subject — the raw value on the row's
 * own `ID` line is what makes every committed id completely readable.
 */
export function detailFactItems(panel: PresetPickerPanel, row: PresetPickerRow): PickerItem[] {
  return [
    // The `/preset` native picker is always the compact `md` shape (no preview),
    // so its fact rows use the compact measured slot.
    ...factRowItems('fact-name', 'Name', row.name, false),
    ...factRowItems('fact-id', 'ID', row.id, false),
    ...factRowItems('fact-type', 'Type', row.builtIn ? 'Built-in' : 'Custom', false),
    ...(row.description === undefined || row.description.trim() === ''
      ? []
      : factRowItems('fact-description', 'Description', row.description, false)),
    ...(row.id === currentId(panel) ? factRowItems('fact-current', 'Current session', row.id, false) : []),
    ...(row.id === pendingId(panel) ? factRowItems('fact-next', 'Next session', row.id, false) : []),
    ...(row.id === defaultId(panel) ? factRowItems('fact-default', 'New-session default', row.id, false) : []),
    ...(row.broken === undefined ? [] : factRowItems('fact-broken', 'Failed to load', row.broken, false)),
    ...(panel.notice === '' ? [] : factRowItems('fact-status', 'Status', panel.notice, false)),
  ]
}

/** The Details page's cursor, clamped to the rows it currently offers. */
export function detailCursor(panel: PresetPickerPanel, row: PresetPickerRow | undefined): number {
  if (row === undefined) return 0
  const count = detailFactItems(panel, row).length
  return Math.min(Math.max(panel.factCursor, 0), Math.max(0, count - 1))
}
