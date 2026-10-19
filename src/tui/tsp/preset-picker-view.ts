/** Node construction for the native TSP `/preset` presentation.
 *
 * Pure: state in, node tree out. Every interactive node binds a panel INTENT
 * through `deps.bind`, so a click lands on the same admission point as a key —
 * this module never mutates state, never writes and never reads the SDK.
 *
 * Layout contract (Owner-frozen v4, TWO pages in ONE layer):
 *  - the CATALOGUE is ONE native `ui.picker` at the client's `md` dialog size with
 *    `layout:'cards'`, `preview:'none'` and no scopes: one column of preset cards
 *    grouped `Built-in` then `Custom`, each card carrying the preset's name, its
 *    real classification, a ONE-line summary and its real state badges. The
 *    footer is the client's own action bar with the THREE native entries —
 *    `Use next`/`Use session`, `Set default`, `Close` — the only writer on the
 *    panel. There is no provider sidebar, no second fact-row picker, no grid and
 *    no status row: the committed facts are the cards' own badges (MEASURED:
 *    `lead`/`message` stay unpainted in the ready phase and a sibling line is
 *    clipped behind the modal sheet);
 *  - a card ACTIVATION (`activate` — the client's own click on the already-selected
 *    card — or `Enter`) REPLACES the picker with the selected preset's DETAILS: a
 *    native `overlay` at `lg` whose body is ONE continuous read — identity,
 *    relationship facts, the complete description, the failure reason and, for a
 *    SHIPPED preset, the official Mode guide inline (`ui.md`). Strictly read-only:
 *    no write row, no footer, no second page. The way back is the #301-proven
 *    native navigation row (`ui.row({onClick})`, `← Back to presets · Esc`) at the
 *    TOP of the reading body — Owner A4 amendment, 2026-10-14, final form: the
 *    measured client scrolls every overlay child in the ONE body scroller (no
 *    app-controllable pinned slot exists and an `el` button paints no stylesheet
 *    border/background), so the ROW is the pointer path at the page top and the
 *    ALWAYS-available fixed path is the keyboard twin `Esc`, admitted at any
 *    scroll position through the same ONE intent. No overlay ON TOP of a picker.
 *
 * The picker and the layer keep ONE identity for a PANEL's life (their keys carry
 * the panel serial, never the frame revision: a key that changes per frame makes
 * the client remount its scroll container); the Details page takes ONE identity
 * per READING, so a `scroll` op queued by a previous reading cannot address the
 * next one's body. The layer root is ALWAYS a `ui.col`: MEASURED (Gate A round
 * 0), a bare page node as the region root is ACKed but paints NOTHING.
 * @module tui/tsp/preset-picker-view
 */
import { span, ui, type Node } from '@stencil-hq/tern'
import type { PickerAction, PickerItem, PickerProps } from '@stencil-hq/tern'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import type { PresetPickerIntent } from './preset-picker-intents.ts'
import {
  FRAME_FREE_ACTION,
  actionBase,
  actionKeyboardLive,
  catalogueActions,
  currentId,
  detailsHead,
  focusedAction,
  guideMarkdown,
  highlightedRow,
  pendingId,
  pickerSubtitle,
  presetItemId,
  presetItems,
  presetOrder,
  statusMessage,
  statusRelations,
  zoneHintText,
  type PresetPickerPanel,
} from './preset-picker-state.ts'

export interface PresetPickerViewDeps {
  /** Bind one intent to THIS frame's revision (admission lives in the presenter). */
  readonly bind: (intent: PresetPickerIntent) => () => void
}

/**
 * The key PREFIX of the Details page's scrollable content column.
 *
 * The presenter resolves a frame's body id by THIS prefix from the tree the SDK
 * really built (never a guessed path), so a `scroll` op can only ever address a body
 * that frame contains.
 */
export const PRESET_READING_BODY_KEY_PREFIX = 'preset-reading-body-'

/** The panel-lifetime identity of the picker and of the layer itself. */
const pickerKey = (panel: PresetPickerPanel): string => `preset-${panel.serial}`
const layerKey = (panel: PresetPickerPanel): string => `preset-layer-${panel.serial}`

/** The ONE identity of the reading currently open: the panel serial plus the
 *  reading's epoch. It never carries the frame revision. */
const readingScope = (panel: PresetPickerPanel): string => `${panel.serial}-${panel.readerEpoch}`
const bodyKey = (panel: PresetPickerPanel): string => `${PRESET_READING_BODY_KEY_PREFIX}${readingScope(panel)}`

/** The state/notice surface: one message, in one place. An admitted write states
 *  itself here, because that phase's bar carries no entry able to say it. */
function pickerState(panel: PresetPickerPanel): Pick<PickerProps, 'state' | 'message' | 'empty'> {
  const message = statusMessage(panel)
  return {
    state: panel.phase === 'loading' ? 'loading' : panel.phase === 'error' ? 'error' : 'ready',
    ...(message === '' ? {} : { message: sanitizedPhysicalLine(message) }),
    // The empty roster is a real, readable state and never a silent fallback to
    // "take the first card".
    empty: 'No agent presets configured.',
  }
}

/**
 * The rendered footer: the state module owns WHICH operations exist (and which the
 * current phase admits) and which one the keyboard has focused; the focused entry
 * carries the app-rendered `Verb [Enter]` badge, because the SDK paints no focused
 * button state. A DISABLED entry owns no Enter and therefore never carries the
 * badge, and neither does a phase whose bar no key can run.
 */
function renderedActions(panel: PresetPickerPanel): PickerAction[] {
  const focused = panel.zone === 'actions' && actionKeyboardLive(panel)
    ? focusedAction(panel).id
    : undefined
  return catalogueActions(panel).map((action) =>
    actionBase(panel, action.id) === focused && action.disabled !== true
      ? { ...action, label: `${action.label} [Enter]` }
      : action,
  )
}

/** The ONE native picker of the catalogue page. */
function cataloguePicker(panel: PresetPickerPanel): Node {
  const row = highlightedRow(panel)
  const current = currentId(panel)
  const items: PickerItem[] = presetItems(panel).map((item) => ({
    ...item,
    label: typeof item.label === 'string' ? sanitizedPhysicalLine(item.label) : item.label,
    ...(typeof item.detail === 'string' ? { detail: sanitizedPhysicalLine(item.detail) } : {}),
    ...(item.title === undefined ? {} : { title: sanitizedPhysicalLine(item.title) }),
  }))
  const props: PickerProps & { readonly key: string } = {
    key: pickerKey(panel),
    title: 'Agent presets',
    noun: 'preset',
    // The client's own card layout: ONE column at EVERY pane width, each card's
    // detail on its own line. It is never a two-column grid, so no breakpoint, no
    // stylesheet and no second keyboard contract exist.
    layout: 'cards',
    size: 'md',
    preview: 'none',
    query: panel.query,
    cursor: panel.cursor,
    placeholder: 'Search presets…',
    items,
    order: presetOrder(panel),
    total: items.length,
    // MEASURED: the subtitle is the header's title TOOLTIP, and the ready-phase
    // `message`/`lead` slots paint nothing — so this line is a discoverable
    // extra; the load-bearing statements are the cards' badges and the Details
    // page's relationship facts.
    subtitle: pickerSubtitle(panel),
    selected: row === undefined ? undefined : presetItemId(row.id),
    // The live Session's own marker, native where the SDK offers one; the
    // Default/Next-session/Draft facts ride the cards' own badges.
    current: current === undefined ? [] : [presetItemId(current)],
    focus: 'list',
    ...pickerState(panel),
    actions: renderedActions(panel),
  }
  return ui.picker(props)
}

/**
 * The Details page's way back (Owner A4 amendment, final form): the native
 * NAVIGATION row `ui.row({onClick})` at the TOP of the reading body — `← Back to
 * presets · Esc`. MEASURED: the client puts every overlay child into the ONE
 * `sf-ov-body` scroller, so the row scrolls with the content; the ALWAYS-available
 * fixed path is the keyboard twin (`Esc`, admitted at any scroll position), and
 * the row is the pointer path at the page top where every reading starts. It must
 * read as NAVIGATION, never as a business write (the page is read-only), and
 * pointer and keyboard converge: the `onClick` closure and the key map both send
 * the SAME `back` intent through the ONE admission.
 */
function detailsBackRow(panel: PresetPickerPanel, deps: PresetPickerViewDeps): Node {
  return ui.row(
    {
      key: `preset-details-back-${readingScope(panel)}`,
      onClick: deps.bind({ kind: 'back' }),
    },
    ui.text({
      key: `preset-details-back-label-${readingScope(panel)}`,
      spans: [span('← Back to presets', 'accent'), span(' · Esc', 'muted')],
    }),
  )
}

/** The Details page's identity block: the complete values, wrapped by the client
 *  at the layout's real width — never pre-split. */
function detailsIdentity(panel: PresetPickerPanel, row: NonNullable<ReturnType<typeof highlightedRow>>): Node[] {
  const relations = statusRelations(panel, row)
  return [
    ui.col(
      { key: `preset-details-identity-${readingScope(panel)}`, gap: 'xs' },
      ui.text(span('Name', 'muted')),
      ui.text({ key: 'details-name', text: sanitizeDisplayText(row.name), wrap: 'char' }),
      ui.text(span('ID', 'muted')),
      ui.text({ key: 'details-id', text: sanitizeDisplayText(row.id), wrap: 'char' }),
      ui.text(span('Type', 'muted')),
      ui.text({ key: 'details-type', text: row.builtIn ? 'Built-in' : 'Custom' }),
      ui.text(span('Scope', 'muted')),
      ui.text({
        key: 'details-scope',
        spans: [
          span('Use: ', 'muted'),
          span(panel.request.subject.sessionless ? 'next session only' : 'current blank session'),
          span(' · Default: ', 'muted'),
          span('future new sessions'),
        ],
      }),
      ...relations.flatMap((relation) => [
        ui.text({ key: relation.id, spans: [span(`${relation.label}: `, 'muted'), span(sanitizeDisplayText(relation.value))] }),
      ]),
      ...(row.broken === undefined
        ? []
        : [
            ui.text(span('Failed to load', 'muted')),
            ui.text({ key: 'details-broken', text: sanitizeDisplayText(row.broken), wrap: 'word' }),
          ]),
    ),
  ]
}

/**
 * The DETAILS page: the selected preset's complete, inert identity and status,
 * the full description / failure reason and — for a SHIPPED preset — the official
 * Mode guide inline, all in ONE continuous scrolling body (the client scrolls
 * every overlay child, the Back row included). NOTHING on the page writes, and
 * `Esc` is the way back from ANY scroll position.
 */
function detailsOverlay(panel: PresetPickerPanel, deps: PresetPickerViewDeps): Node {
  const row = highlightedRow(panel)
  const notice = statusMessage(panel)
  const markdown = guideMarkdown(panel)
  return ui.overlay(
    {
      key: `preset-details-${readingScope(panel)}`,
      head: sanitizedPhysicalLine(detailsHead(panel)),
      size: 'lg',
      modal: true,
    },
    detailsBackRow(panel, deps),
    ui.col(
      { key: bodyKey(panel), gap: 'xs' },
      // The transient read/write notice leads the page: it describes the state the facts
      // below were read in.
      ...(notice === '' ? [] : [ui.text({ key: 'details-notice', wrap: 'word' }, span(sanitizeDisplayText(notice), 'muted'))]),
      ...(row === undefined
        ? [ui.text(span('No preset is selected.', 'muted'))]
        : [
            ...detailsIdentity(panel, row),
            // ONE rule + spacer at the boundary between the INERT facts and the
            // long reading content: the design language's counted separation device
            // (one rule per boundary, never flanking a text line).
            ui.rule(),
            ui.spacer({ size: 'sm' }),
            ...(row.description === undefined || row.description.trim() === ''
              ? [ui.text(span('No description provided.', 'muted'))]
              : [
                  ui.text(span('Description', 'muted')),
                  ui.text({ key: 'details-description', text: sanitizeDisplayText(row.description), wrap: 'word' }),
                ]),
            // A SHIPPED preset's official guide follows INLINE — one scroll, no
            // `Read mode guide` jump, no third page. A Custom declaration stops
            // here: it must not borrow an official guide.
            ...(markdown === undefined ? [] : [ui.md({ key: `preset-details-guide-${readingScope(panel)}`, text: sanitizeDisplayText(markdown) })]),
          ]),
    ),
  )
}

/**
 * The whole layer for one frame: exactly ONE page. The catalogue is the native
 * picker; Details REPLACES it with a native overlay, so the layer can never
 * carry a picker whose cards could be operated behind a reading page. The root
 * is always a `ui.col` (MEASURED: a bare page node as the region root paints
 * nothing).
 */
export function presetPickerLayer(panel: PresetPickerPanel, deps: PresetPickerViewDeps): Node {
  return ui.col(
    { key: layerKey(panel) },
    panel.page === 'details' ? detailsOverlay(panel, deps) : cataloguePicker(panel),
  )
}
