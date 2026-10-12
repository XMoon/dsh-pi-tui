/** Node construction for the native TSP `/preset` presentation.
 *
 * Pure: state in, node tree out. Every interaction goes through the native
 * picker's own row/action channels, which the presenter's ONE admission point
 * routes — this module never mutates state, never writes and never reads the
 * SDK.
 *
 * Layout contract (Owner-frozen): ONE native `ui.picker` at the fixed `md` size
 * with no preview, drilled into a read-only `Preset details` page. The
 * next/current, default and draft facts sit above it as their own complete
 * lines, and the keyboard hint below it; no overlay, no `ui.el`, no CSS, no
 * second geometry.
 * @module tui/tsp/preset-picker-view
 */
import { span, ui, type Node } from '@stencil-hq/tern'
import type { PickerAction, PickerItem, PickerProps } from '@stencil-hq/tern'
import {
  actionKeyboardLive,
  currentId,
  detailCursor,
  detailFactItems,
  focusedAction,
  highlightedRow,
  pickerActions,
  presetItemId,
  presetItems,
  statusLines,
  zoneHintText,
  type PresetPickerPanel,
} from './preset-picker-state.ts'

/**
 * The rendered action bar: the state module owns WHICH actions exist (and which
 * the current phase admits), and the focused one — only while the action zone
 * owns the keyboard — carries the app-rendered shape cue, because the SDK has
 * no focus affordance for a button. A phase whose bar no key can run (an
 * admitted write, a running re-read) marks nothing: the cue promises Enter.
 */
function renderedActions(panel: PresetPickerPanel): PickerAction[] {
  const focused = panel.zone === 'actions' && actionKeyboardLive(panel)
    ? focusedAction(panel).id
    : undefined
  return pickerActions(panel).map((action) =>
    // A DISABLED action owns no Enter, so it must not carry the focus cue.
    action.id === focused && action.label !== undefined && action.disabled !== true
      ? { ...action, label: `▸ ${action.label}` }
      : action,
  )
}

/** The state/notice surface: one message, in one place. */
function pickerState(panel: PresetPickerPanel): Pick<PickerProps, 'state' | 'message' | 'empty'> {
  return {
    state: panel.phase === 'loading' ? 'loading' : panel.phase === 'error' ? 'error' : 'ready',
    ...(panel.notice === '' ? {} : { message: panel.notice }),
    // The Owner-frozen empty copy: an empty roster is a real, readable state and
    // never a silent fallback to "pick the first row".
    empty: 'No agent presets configured.',
  }
}

/** The ONE picker of both pages: the same list and action bar; only its
 *  items/selected/query change. */
function presetListPicker(panel: PresetPickerPanel, key: string): Node {
  const details = panel.page === 'details'
  const row = highlightedRow(panel)
  const items: PickerItem[] = details
    ? (row === undefined ? [] : detailFactItems(panel, row))
    : presetItems(panel)
  const current = details ? undefined : currentId(panel)
  const props: PickerProps & { readonly key: string } = {
    key,
    title: details ? 'Preset details' : 'Agent presets',
    noun: 'preset',
    layout: 'rows',
    // The frozen size: ONE compact native picker, no preview column, no tabs.
    size: 'md',
    preview: 'none',
    query: details ? '' : panel.query,
    cursor: details ? 0 : panel.cursor,
    items,
    order: items.map((item) => item.id),
    total: items.length,
    selected: details
      // The Details page selects its presentation cursor, so the native list
      // scrolls to the fact row being read.
      ? (row === undefined ? undefined : items[detailCursor(panel, row)]?.id)
      : (row === undefined ? undefined : presetItemId(row.id)),
    // The live Session's own marker, native where the SDK offers one; the
    // Default/Draft/Failed-to-load facts ride the rows' badges.
    current: current === undefined ? [] : [presetItemId(current)],
    focus: 'list',
    ...pickerState(panel),
    actions: renderedActions(panel),
  }
  return ui.picker(props)
}

/**
 * The whole layer for one frame: the session/default/draft facts, the ONE picker
 * and the keyboard hint. The node id carries the panel serial AND the revision,
 * so an event from an earlier frame can only ever be refused by
 * `targets`/admission — never silently applied to the new one.
 */
export function presetPickerLayer(panel: PresetPickerPanel): Node {
  const live = panel.zone === 'actions' && actionKeyboardLive(panel)
  // Every node's id carries the panel serial AND the revision, so an event
  // addressed at a node of an EARLIER frame can never resolve to the current
  // revision through the presenter's target map.
  const frame = `${panel.serial}-rev-${panel.revision}`
  return ui.col(
    { key: `preset-layer-${frame}`, gap: 'xs' },
    // The session/default/draft facts: independent COMPLETE lines. Each is asked
    // for exactly one rendered line (`truncate`/`lines`), so a very long id can
    // never turn the header into a variable-height block that pushes the action
    // bar out of a short pane — the id's complete value is the Details page's
    // own fact row, and the row identity itself is never replaced by a chip.
    ...statusLines(panel).map((line, index) => headerLine(line, 'muted', `preset-fact-${index}-${frame}`)),
    presetListPicker(panel, `preset-${frame}`),
    headerLine(zoneHintText(panel), live ? 'accent' : 'muted', `preset-hint-${frame}`),
  )
}

/** One bounded header/hint line: exactly one rendered row, ellipsized by the
 *  pane when the value does not fit (never a wrapped block). */
function headerLine(text: string, tone: 'muted' | 'accent', key: string): Node {
  return ui.text({ key, spans: [span(text, tone)], truncate: 'end', lines: 1 })
}
