/** Panel state and pure selectors for the native TSP `/preset` presentation.
 *
 * This module answers only "what is the panel currently browsing / offering":
 * its state, the pure selectors over it, the card projection of one roster read
 * and the action availability of every page. It renders nothing, mutates nothing
 * and writes nothing, so the view builder and the key map stay pure functions
 * over one explicit state object.
 *
 * The page contract is the v4 Owner-frozen TWO-page shape: the CATALOGUE (the
 * ONE native picker and its three-button footer — the only page that writes) and
 * the DETAILS reader (ONE `lg` overlay: identity, the complete description and a
 * SHIPPED preset's full official guide inline in the same scroll; strictly
 * read-only). The v3 `overview` and `guide` pages are retired, not merged.
 * @module tui/tsp/preset-picker-state
 */
import type { PickerAction, PickerGroup, PickerItem } from '@stencil-hq/tern'
import type {
  PresetPickerRequest,
  PresetPickerRoster,
} from '../../app/command/preset-presentation.ts'
import { oneLine } from './picker-text.ts'
import { isBuiltInPresetRow, presetDisplayText } from '../pickers/preset-display.ts'
import { builtInGuide } from './preset-guide-content.ts'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
export type PresetPickerPhase = 'loading' | 'ready' | 'error' | 'pending'

/**
 * The visible page. `catalog` is the ONE native picker; `details` REPLACES it in
 * the same layer with a native overlay, so the layer never carries a picker whose
 * cards could be operated behind a reading page.
 */
export type PresetPickerPage = 'catalog' | 'details'

/** K2: the two logical regions of the CATALOGUE. Only `actions` may ever commit
 *  a write. The DETAILS page has no zone: it reads, it never writes. */
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
  /** The browse target: the row the explicit operations would act on. It is
   *  local browse state — moving it never writes anything. */
  selected: string | undefined
  /**
   * Which footer entry owns Enter, as a BASE id (never a rendered, frame-tokened
   * one). A missing id resolves through {@link focusedAction}'s preference order.
   */
  actionFocus: string | undefined
  /**
   * How many times the DETAILS page has been entered on this panel. The page,
   * its `Back` button and its scrolling body carry ONE identity per reading, so
   * a re-render never remounts the scroll container, while a `scroll` op queued
   * by a PREVIOUS reading can never address the next one's body.
   */
  readerEpoch: number
  /** The single local notice (a read error or the last write outcome). */
  notice: string
  /** The adopted roster read plus the display facts captured with it. */
  roster: PresetPickerRoster | undefined
  query: string
  cursor: number
}

/* --------------------------------------------------------------- namespaces */

const ROW_PREFIX = 'preset:'

/**
 * The wire id of one preset row. A preset's real id is arbitrary user text, so
 * the namespace prefix is the ONLY thing the wire id adds: the raw id is kept
 * verbatim after it. Rows are the only ids that reach the SDK's row channel, so
 * no real preset id can collide with an action id (`close`, `use`,
 * `set-default`, `retry`).
 */
export function presetItemId(id: string): string {
  return ROW_PREFIX + id
}

/** The preset id of one wire row id, or `undefined` when the id is not a row. */
export function presetRowId(item: string): string | undefined {
  return item.startsWith(ROW_PREFIX) ? item.slice(ROW_PREFIX.length) : undefined
}

/**
 * The RESERVED ids of the catalogue's two groups.
 *
 * They use the module's NUL-prefixed convention (the one the Model catalogue also
 * uses) so a preset whose id happens to read like a group head cannot merge its
 * card into a pinned group.
 */
export const BUILT_IN_GROUP_ID = '\u0000built-in'
export const CUSTOM_GROUP_ID = '\u0000custom'
export const BUILT_IN_GROUP_LABEL = 'Built-in'
export const CUSTOM_GROUP_LABEL = 'Custom'

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
 *  own order. The classification is derived from the RAW roster DTO, so a
 *  declaration that reuses a shipped id but publishes its own copy stays Custom. */
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
 * facts. It exists to keep "the row the operations would act on" visually separate
 * from "what is already committed" (a row that IS current/default/next needs no
 * third marker), and it never writes anything by itself.
 */
export function draftId(panel: PresetPickerPanel): string | undefined {
  const row = highlightedRow(panel)
  if (row === undefined) return undefined
  const committed = [currentId(panel), pendingId(panel), defaultId(panel)]
  return committed.includes(row.id) ? undefined : row.id
}

/**
 * One card's second line: its classification plus a ONE-line summary. The client
 * ellipsizes a card's detail (MEASURED), which is exactly why the complete value
 * has its own reading page; a broken row carries its reason there instead,
 * because that is the fact the user must read before choosing anything — the ONE
 * in-place reason the native footer cannot paint (Gate A: a disabled footer
 * entry's `disabled` string becomes a tooltip attribute, not painted text).
 */
export function rowDetail(row: PresetPickerRow): string {
  const kind = row.builtIn ? BUILT_IN_GROUP_LABEL : CUSTOM_GROUP_LABEL
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

/** The catalogue's cards. Identity is the NAME (the shipped English copy for a
 *  shipped preset, the declaration's own metadata otherwise); the raw id rides in
 *  the card's `title` and is complete on the Details page. */
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

/** The catalogue's order: the `Built-in` group first, then `Custom`, each with the
 *  rows the current query really makes visible. An empty group is never painted, so
 *  a group's count is always the number of cards below it. */
export function presetOrder(panel: PresetPickerPanel): (string | PickerGroup)[] {
  const visible = visibleRows(panel)
  const order: (string | PickerGroup)[] = []
  const groups: ReadonlyArray<readonly [id: string, label: string, rows: readonly PresetPickerRow[]]> = [
    [BUILT_IN_GROUP_ID, BUILT_IN_GROUP_LABEL, visible.filter((row) => row.builtIn)],
    [CUSTOM_GROUP_ID, CUSTOM_GROUP_LABEL, visible.filter((row) => !row.builtIn)],
  ]
  for (const [id, label, rows] of groups) {
    if (rows.length === 0) continue
    order.push({ group: id, label, count: rows.length })
    for (const row of rows) order.push(presetItemId(row.id))
  }
  return order
}

/* ------------------------------------------------------------ status facts */

/**
 * One relationship the highlighted preset really IS. A row that is not that
 * subject states nothing, so the page can never claim a relationship the roster
 * does not have. These are the Details page's status block — and, with the
 * cards' native badges, the visible statement of the committed facts (the
 * catalogue has NO paintable status slot: `lead`/`message` in the ready phase
 * and a sibling line are all unpainted or clipped — Gate A measurements).
 */
export interface PresetPickerRelation {
  readonly id: string
  readonly label: string
  readonly value: string
}

export function statusRelations(panel: PresetPickerPanel, row: PresetPickerRow): readonly PresetPickerRelation[] {
  return [
    ...(row.id === currentId(panel)
      ? [{ id: 'relation-current', label: 'Current session', value: row.id }]
      : []),
    ...(row.id === pendingId(panel)
      ? [{ id: 'relation-next', label: 'Next session', value: row.id }]
      : []),
    ...(row.id === defaultId(panel)
      ? [{ id: 'relation-default', label: 'New-session default', value: row.id }]
      : []),
  ]
}

/* ---------------------------------------------------------------- page text */

/**
 * The footer's write labels, Owner-frozen in v4 §2.1: what the write really does
 * to the captured subject. Short native-button forms — the complete scope
 * sentence lives on the Details page's status block and the cards' badges.
 */
export function useLabel(panel: PresetPickerPanel): string {
  return panel.request.subject.sessionless ? 'Use next' : 'Use session'
}

export const DEFAULT_LABEL = 'Set default'
/** The Details page's complete label for the same write. */
export const DEFAULT_LABEL_FULL = 'Set as default for new sessions'
export const BACK_LABEL = 'Back'
const PENDING_LABEL_USE = 'Applying preset…'
const PENDING_LABEL_DEFAULT = 'Saving default…'

/** The honest visible label of an admitted write. */
export function pendingLabel(panel: PresetPickerPanel): string {
  return panel.pending === 'default' ? PENDING_LABEL_DEFAULT : PENDING_LABEL_USE
}

/**
 * The page's ONE state message: the read failure the roster read reported, the last
 * write outcome, or — while a write is admitted — the honest word for it, because that
 * phase's footer carries no entry able to say it.
 */
export function statusMessage(panel: PresetPickerPanel): string {
  return panel.phase === 'pending' ? pendingLabel(panel) : panel.notice
}

/** The single-line keyboard hint of the catalogue. It never names a BUSINESS
 *  operation: in the action bar Enter runs whichever entry that bar has FOCUSED
 *  (the `Verb [Enter]` cue says which), so the hint names the region `Tab` reaches
 *  next. A phase that refuses Enter from the bar paints no promise at all — an
 *  admitted write states itself through {@link statusMessage} instead. */
export function zoneHintText(panel: PresetPickerPanel): string {
  if (panel.phase === 'pending') return ''
  if (panel.phase === 'loading') return 'Loading agent presets…'
  if (panel.phase === 'error') return 'Retry first'
  return panel.zone === 'actions' ? 'Tab list' : 'Tab actions'
}

/** The picker's ONE subtitle line — the header's native tooltip (MEASURED: the
 *  client paints `pk-title`'s `title` attribute, never the subtitle itself), so
 *  it is a discoverable extra and nothing load-bearing rides it. */
export function pickerSubtitle(panel: PresetPickerPanel): string {
  return zoneHintText(panel)
}

/** The Details page's own head: the preset it describes, so that page can never
 *  describe a different preset than the card it was opened from. */
export function detailsHead(panel: PresetPickerPanel): string {
  return highlightedRow(panel)?.name ?? 'Preset details'
}

/** The highlighted preset's complete official Mode guide, or `undefined` when
 *  this row must not have one (a Custom declaration never borrows an official
 *  Guide). It renders INLINE on the Details page — never behind a second page. */
export function guideMarkdown(panel: PresetPickerPanel): string | undefined {
  const row = highlightedRow(panel)
  return row === undefined ? undefined : builtInGuide(row)
}

/* --------------------------------------------------------------- operations */

/**
 * One operation the CURRENT page offers, by BASE id.
 *
 * `disabled` is the ONE availability decision: it drives whether the entry is
 * painted as operable, whether it carries the `[Enter]` cue, whether the Tab ring
 * stops on it and what the single admission point accepts. A disabled operation
 * carries its `reason` in words: on the footer it rides the entry's native
 * `disabled` string (the client's tooltip attribute — a secondary statement) and
 * the load-bearing statements stay the cards' own badges/details, because the
 * client paints NO in-place reason text beside a footer entry (Gate A).
 */
export interface PresetPickerAction {
  readonly id: string
  readonly label: string
  readonly disabled: boolean
  readonly reason?: string
}

/** The highlighted row when an explicit write may act on it at all. */
function writableRow(panel: PresetPickerPanel): PresetPickerRow | undefined {
  const row = highlightedRow(panel)
  return row === undefined || row.broken !== undefined ? undefined : row
}

/** The catalogue's availability: the reason each write is disabled right now. A
 *  BROKEN browse target refuses BOTH writes with the failure's own name — the
 *  same statement the card's detail line carries — never a misleading "no
 *  preset selected". */
function writeAvailability(panel: PresetPickerPanel): { use?: string; setDefault?: string } {
  const row = writableRow(panel)
  if (row === undefined) {
    const broken = highlightedRow(panel)?.broken !== undefined
    return {
      use: broken ? 'Preset failed to load' : 'No preset selected',
      setDefault: broken ? 'Preset failed to load' : 'No preset selected',
    }
  }
  return {
    setDefault: panel.roster?.canSetDefault === true
      ? (row.id === defaultId(panel) ? 'Already the default' : undefined)
      : 'Settings unavailable',
  }
}

/**
 * Every operation the CURRENT page and phase really offers.
 *
 * The catalogue's footer is the ONE explicit-write bar with the Owner-frozen
 * THREE entries in the Owner-approved VISUAL shape — `Close` alone on the left,
 * `Set default` beside `Use next`/`Use session` on the right:
 * `[Close]  [Set default] [Use next]` (Owner ruling "a", 2026-10-14). The client
 * paints this array with its own rule (MEASURED, Tern 0.8.3, gate-a-9/10:
 * non-primary entries pack LEFT in array order, `primary` entries pack RIGHT in
 * array order, one flexible gap between the groups), so `Close` unmarked and
 * BOTH writes `primary` render exactly that shape. `primary` is a VISUAL weight
 * only: admission consumes the SAME `actionEnabled` predicate for every entry,
 * and a disabled primary keeps the client's `off` greying (opacity .45) + its
 * reason tooltip, so the two writes never read as equally-committed. A running
 * read or an admitted write offers ONLY its dismissal; a failed read swaps the
 * writes for `Retry` (primary, rightmost) plus the dismissal. The Details page
 * paints no footer at all.
 *
 * The two §2.1 visibility obligations ride the Owner-approved substitutes ("a"):
 * the DISABLED REASON is the entry's tooltip plus the Details page's relationship
 * fact and the broken card's own `Failed to load: …` detail line, because this
 * client paints NO in-place reason text for a footer entry (MEASURED: the
 * `disabled` string becomes the button's `title` attribute); and the write-SCOPE
 * sentence (`Use: … · Default: future sessions`) lives on the Details page's
 * `Scope:` fact, because the ready-phase picker offers no paintable status slot
 * (`lead`/`message`/`subtitle` all unpainted or tooltip-only — Gate A).
 */
export function offeredActions(panel: PresetPickerPanel): readonly PresetPickerAction[] {
  if (panel.phase === 'pending' || panel.phase === 'loading') {
    return [{ id: FRAME_FREE_ACTION, label: 'Close', disabled: false }]
  }
  if (panel.page === 'details') return []
  if (panel.phase === 'error') {
    return [
      { id: FRAME_FREE_ACTION, label: 'Close', disabled: false },
      { id: 'retry', label: 'Retry', disabled: false },
    ]
  }
  const availability = writeAvailability(panel)
  return [
    { id: FRAME_FREE_ACTION, label: 'Close', disabled: false },
    { id: 'set-default', label: DEFAULT_LABEL, disabled: availability.setDefault !== undefined, ...(availability.setDefault === undefined ? {} : { reason: availability.setDefault }) },
    { id: 'use', label: useLabel(panel), disabled: availability.use !== undefined, ...(availability.use === undefined ? {} : { reason: availability.use }) },
  ]
}

/**
 * The frame token an ACTION id carries.
 *
 * The picker, its layer and the reading page keep ONE node identity for as long as
 * the panel lives (their keys carry the panel SERIAL, never the frame revision — a
 * key that changes per frame makes the client remount its scroll container). The
 * catalogue's footer, however, is rebuilt every frame, so its entries carry the
 * revision themselves and an event naming any other revision is refused at
 * admission exactly like an id that was never rendered. The reading page's Back
 * button needs no token: it is a frame-bound closure.
 *
 * The panel's dismissal is the ONE untokened action: it must keep working from any
 * frame.
 */
export const ACTION_TOKEN = '#'
/** The one action that is deliberately frame-independent. */
export const FRAME_FREE_ACTION = 'close'

/** The revision-scoped id the CURRENT frame renders for one action base. */
export function actionId(panel: PresetPickerPanel, base: string): string {
  return base === FRAME_FREE_ACTION ? base : `${base}${ACTION_TOKEN}${panel.revision}`
}

/**
 * The action base an id names, or `undefined` when the id is not one THIS frame
 * renders: an unknown shape, a missing token, or a token from a revision that is no
 * longer the panel's. That is what keeps a stale footer action from acting on a
 * later frame.
 */
export function actionBase(panel: PresetPickerPanel, id: string): string | undefined {
  if (id === FRAME_FREE_ACTION) return id
  const at = id.lastIndexOf(ACTION_TOKEN)
  if (at <= 0) return undefined
  return id.slice(at + 1) === String(panel.revision) ? id.slice(0, at) : undefined
}

/**
 * Whether one BASE action may run right now.
 *
 * It is the SAME `disabled` decision the page renders, so the write path and the
 * visible operations can never disagree: the admission consumes it instead of merely
 * rendering an inert entry, because a pointer or a synthetic SDK event reaches the
 * same entry point the keyboard uses.
 *
 * `close` is the panel's DISMISSAL authority — the same intent `Esc` sends and the
 * client's backdrop gesture — so it is admitted on every page and phase, including
 * the Details page, which deliberately paints no footer.
 */
export function actionEnabled(panel: PresetPickerPanel, base: string): boolean {
  if (base === FRAME_FREE_ACTION) return true
  const action = offeredActions(panel).find((candidate) => candidate.id === base)
  return action !== undefined && !action.disabled
}

/**
 * The order Enter should be offered the operations in when the keyboard enters
 * the footer: the ONE write first on the catalogue. The Details page has no
 * footer; its only Enter target is the way back.
 */
function focusPreference(panel: PresetPickerPanel): readonly string[] {
  if (panel.phase === 'error') return ['retry', FRAME_FREE_ACTION]
  if (panel.phase === 'loading' || panel.phase === 'pending') return [FRAME_FREE_ACTION]
  return ['use', 'set-default', FRAME_FREE_ACTION]
}

/**
 * The operation that owns Enter right now.
 *
 * A DISABLED action owns no Enter and shows no cue, so the fallback never parks the
 * keyboard on a dead entry.
 */
export function focusedAction(panel: PresetPickerPanel): PresetPickerAction {
  const actions = offeredActions(panel)
  const explicit = actions.find((action) => action.id === panel.actionFocus && !action.disabled)
  if (explicit !== undefined) return explicit
  for (const id of focusPreference(panel)) {
    const action = actions.find((candidate) => candidate.id === id && !candidate.disabled)
    if (action !== undefined) return action
  }
  return actions.filter((action) => !action.disabled).at(-1) ?? actions[actions.length - 1]!
}

/** The next ENABLED operation in the ring, wrapping in `delta`'s direction. A
 *  one-entry ring therefore stays on itself. */
export function stepActionFocus(panel: PresetPickerPanel, delta: -1 | 1): string {
  const offered = offeredActions(panel).filter((action) => !action.disabled)
  const at = offered.findIndex((action) => action.id === focusedAction(panel).id)
  const next = offered[(Math.max(at, 0) + delta + offered.length) % offered.length]
  return next?.id ?? focusedAction(panel).id
}

/** The footer the catalogue paints: the page's operations with the current frame's
 *  token in every id, plus the flags the native bar really understands. BOTH
 *  writes carry `primary` — that is the Owner-frozen VISUAL grouping (`Close`
 *  left, the two writes together right), not a semantic rank: admission consumes
 *  the same `actionEnabled` predicate for every entry. The disabled `reason`
 *  rides the entry's native `disabled` string — the client greys it (`off`,
 *  opacity .45) and turns the string into the button's tooltip attribute. */
export function catalogueActions(panel: PresetPickerPanel): PickerAction[] {
  return offeredActions(panel).map((action) => ({
    id: actionId(panel, action.id),
    label: action.label,
    ...(action.id === 'use' || action.id === 'retry' || action.id === 'set-default'
      ? { primary: true }
      : {}),
    ...(action.disabled
      ? { disabled: action.reason ?? true }
      : {}),
  }))
}

/**
 * Whether the current phase lets the KEYBOARD run the action bar at all.
 *
 * An admitted write (`pending`) and a running (re-)read (`loading`) refuse every key
 * except Esc, so no action there can be activated from the keyboard. The `[Enter]`
 * cue is a promise about Enter, so it is drawn only where this holds — everywhere
 * else the bar must read as having no keyboard focus instead of marking `Close` and
 * then swallowing the Enter that cue announced.
 */
export function actionKeyboardLive(panel: PresetPickerPanel): boolean {
  return (panel.phase === 'ready' || panel.phase === 'error') && panel.page === 'catalog'
}

/** Step the browse target, wrapping (browse only — never a write). */
export function stepRow(panel: PresetPickerPanel, delta: -1 | 1): string | undefined {
  const ids = visibleRows(panel).map((row) => row.id)
  if (ids.length === 0) return undefined
  const at = ids.findIndex((id) => id === panel.selected)
  return ids[(Math.max(at, 0) + delta + ids.length) % ids.length]
}
