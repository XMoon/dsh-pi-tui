/**
 * TSP I-E: the pure node projection of the ONE `Ctrl+R` History search seat.
 *
 * It paints the seat's already-decided render state as ONE Dock card — Header,
 * the single Scope button, `F2` expand, `×` close, ONE official `ui.input` query,
 * a scrollable results list, an independently scrollable full Preview, and the
 * `Copy all` / `Restore to draft` action row — and installs ONE scoped
 * stylesheet. It owns no state, no timer, no SDK session, no history read and no
 * business authority: every cell's meaning comes from
 * {@link TspHistorySearchRenderState}, and every click is handed to the seat as
 * the same intent a key produces.
 *
 * Untrusted text discipline: only the projection's sanitized display forms ever
 * reach a node's painted text, `title` or `aria`. The raw stored content stays
 * inside the seat for Copy and Restore.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/history-search-view
 */

import { html, ui } from '@stencil-hq/tern'
import type { Node } from '@stencil-hq/tern'
import type {
  TspHistorySearchIntent,
  TspHistorySearchRenderState,
  TspHistorySearchRow,
} from './history-search.ts'

/** The ONE surface-scoped stylesheet the History card installs. */
export const HISTORY_SEARCH_SHEET = 'dsh-history-search'

/** The product role hooks the card and its stylesheet share. Every selector is
 *  scoped under a `dsh.history.*` role, so nothing here can restyle the
 *  Composer shell, the Footer, the Transcript or another TSP panel. */
export const HISTORY_SEARCH_ROLES = {
  card: 'dsh.history.card',
  head: 'dsh.history.head',
  headEnd: 'dsh.history.head-end',
  title: 'dsh.history.title',
  scope: 'dsh.history.scope',
  expand: 'dsh.history.expand',
  close: 'dsh.history.close',
  query: 'dsh.history.query',
  body: 'dsh.history.body',
  results: 'dsh.history.results',
  resultsHead: 'dsh.history.results-head',
  resultsScroll: 'dsh.history.results-scroll',
  row: 'dsh.history.row',
  rowText: 'dsh.history.row-text',
  rowMeta: 'dsh.history.row-meta',
  status: 'dsh.history.status',
  preview: 'dsh.history.preview',
  previewHead: 'dsh.history.preview-head',
  previewScroll: 'dsh.history.preview-scroll',
  previewText: 'dsh.history.preview-text',
  previewMeta: 'dsh.history.preview-meta',
  actions: 'dsh.history.actions',
  actionsEnd: 'dsh.history.actions-end',
  hint: 'dsh.history.hint',
  copy: 'dsh.history.copy',
  restore: 'dsh.history.restore',
  retry: 'dsh.history.retry',
} as const

/** One clickable cell of the card. */
export interface TspHistorySearchViewInput {
  readonly state: TspHistorySearchRenderState
  /** The ONE route every pointer action takes: the seat's admitted intent, the
   *  same shape a keyboard gesture produces. */
  readonly onIntent: (intent: TspHistorySearchIntent) => void
  /** Whether the pane is wide enough for the side-by-side body. Decided from the
   *  ACTUAL pane width by the mount, never the desktop window width. */
  readonly wide: boolean
}

/** One results row: a real button, so a click is a client-recognized control
 *  and never blue text pretending to be one. A row click SELECTS; only the
 *  explicit `Restore to draft` cell writes the Composer. */
function resultRow(
  row: TspHistorySearchRow,
  onIntent: (intent: TspHistorySearchIntent) => void,
  revision: number,
  serial: number,
): Node {
  const marks = [row.time, row.directory].filter((mark) => mark !== '')
  const title = marks.length === 0 ? row.summary : `${row.summary} · ${marks.join(' · ')}`
  return html.button({
    key: row.key,
    role: HISTORY_SEARCH_ROLES.row,
    title,
    aria: title,
    ...(row.selected ? { attrs: { 'data-selected': 'true' } as Readonly<Record<string, string>> } : {}),
    onClick: () => onIntent({ kind: 'select', rowId: row.id, serial, revision }),
  },
    html.span({ role: HISTORY_SEARCH_ROLES.rowText }, `${row.selected ? '›' : ' '}${row.summary}`),
    ...(marks.length === 0
      ? []
      : [html.span({ role: HISTORY_SEARCH_ROLES.rowMeta }, marks.join(' · '))]),
  )
}

/** The card's one chrome button. `disabled` is stated BOTH visually and in the
 *  seat's admission (a stale frame never acts), and a disabled cell never
 *  advertises a half button the user cannot use. */
function chromeButton(
  key: string,
  role: string,
  label: string,
  aria: string,
  enabled: boolean,
  onClick: () => void,
): Node {
  return html.button({
    key,
    role,
    title: aria,
    aria,
    ...(enabled ? {} : { attrs: { 'aria-disabled': 'true' } as Readonly<Record<string, string>> }),
    onClick,
  }, label)
}

/** Build the ONE History card node for this frame. */
export function historySearchView(input: TspHistorySearchViewInput): Node {
  const { state, onIntent } = input
  const revision = state.revision
  const serial = state.serial

  const resultsBody: Node[] = []
  for (const row of state.rows) resultsBody.push(resultRow(row, onIntent, revision, serial))
  if (state.empty !== undefined) {
    resultsBody.push(ui.text({ key: `h${serial}-empty`, role: HISTORY_SEARCH_ROLES.status, wrap: 'none', text: state.empty }))
  }
  if (state.failure !== undefined) {
    resultsBody.push(ui.text({ key: `h${serial}-failed`, role: HISTORY_SEARCH_ROLES.status, wrap: 'none', text: state.failure }))
  }

  const results = ui.col(
    { key: `h${serial}-results`, role: HISTORY_SEARCH_ROLES.results, gap: 'none' },
    ui.text({ key: `h${serial}-results-head`, role: HISTORY_SEARCH_ROLES.resultsHead, wrap: 'none', text: state.header }),
    ui.scroll(
      { key: state.resultsKey, role: HISTORY_SEARCH_ROLES.resultsScroll, variant: 'bar', gap: 'none' },
      ...resultsBody,
    ),
  )

  const previewBody: Node[] = []
  if (state.preview !== undefined) {
    previewBody.push(ui.text({
      key: `h${serial}-preview-text`,
      role: HISTORY_SEARCH_ROLES.previewText,
      wrap: 'word',
      text: state.preview.text,
    }))
    previewBody.push(ui.text({
      key: `h${serial}-preview-directory`,
      role: HISTORY_SEARCH_ROLES.previewMeta,
      wrap: 'none',
      text: state.preview.directory,
    }))
    previewBody.push(ui.text({
      key: `h${serial}-preview-time`,
      role: HISTORY_SEARCH_ROLES.previewMeta,
      wrap: 'none',
      text: state.preview.time,
    }))
    previewBody.push(ui.text({
      key: `h${serial}-preview-session`,
      role: HISTORY_SEARCH_ROLES.previewMeta,
      wrap: 'none',
      text: state.preview.session,
    }))
  } else {
    previewBody.push(ui.text({
      key: `h${serial}-preview-none`,
      role: HISTORY_SEARCH_ROLES.previewMeta,
      wrap: 'none',
      text: state.status === 'searching' ? 'Searching…' : 'No selected history entry.',
    }))
  }
  const preview = ui.col(
    { key: `h${serial}-preview`, role: HISTORY_SEARCH_ROLES.preview, gap: 'none' },
    ui.text({ key: `h${serial}-preview-head`, role: HISTORY_SEARCH_ROLES.previewHead, wrap: 'none', text: 'Preview' }),
    ui.scroll({ key: state.previewKey, role: HISTORY_SEARCH_ROLES.previewScroll, variant: 'bar', gap: 'none' }, ...previewBody),
  )

  const body = input.wide
    ? ui.row({ key: `h${serial}-body`, role: HISTORY_SEARCH_ROLES.body, gap: 'sm' },
        ui.col({ key: `h${serial}-body-l`, grow: 44, gap: 'none' }, results),
        ui.col({ key: `h${serial}-body-r`, grow: 56, gap: 'none' }, preview))
    : ui.col({ key: `h${serial}-body`, role: HISTORY_SEARCH_ROLES.body, gap: 'sm' }, results, preview)

  return ui.col(
    { key: `history-card-${serial}`, role: HISTORY_SEARCH_ROLES.card, gap: 'none' },
    ui.row(
      { key: `h${serial}-head`, role: HISTORY_SEARCH_ROLES.head, gap: 'sm', align: 'center' },
      ui.text({ key: `h${serial}-title`, role: HISTORY_SEARCH_ROLES.title, wrap: 'none', text: 'Input History' }),
      ui.row(
        { key: `h${serial}-head-end`, role: HISTORY_SEARCH_ROLES.headEnd, gap: 'sm', align: 'center' },
        chromeButton(state.scopeKey, HISTORY_SEARCH_ROLES.scope, `Scope: ${state.scope} ⌄`, 'Cycle the search scope', true,
          () => onIntent({ kind: 'scope', delta: 1, serial, revision })),
        chromeButton(state.expandKey, HISTORY_SEARCH_ROLES.expand, state.expanded ? 'Collapse' : 'Expand',
          state.expanded ? 'Collapse the history card' : 'Expand the history card', true,
          () => onIntent({ kind: 'expand', serial, revision })),
        chromeButton(state.closeKey, HISTORY_SEARCH_ROLES.close, '×', 'Close history search', true,
          () => onIntent({ kind: 'close', serial, revision })),
      ),
    ),
    ui.input({
      key: state.queryKey,
      role: HISTORY_SEARCH_ROLES.query,
      text: state.query,
      cursor: state.queryCursor,
      placeholder: 'Search input history…',
      aria: 'Search input history',
      // A pointer click on an unfocused field is a `focus` event, not a key. The
      // SDK dispatches it from the view it last rendered, so a stale frame's
      // click resolves to nothing in the seat.
      onFocus: () => onIntent({ kind: 'focus-query', serial, revision }),
    }),
    body,
    ui.row(
      { key: `h${serial}-actions`, role: HISTORY_SEARCH_ROLES.actions, gap: 'sm', align: 'center' },
      ui.text({ key: `h${serial}-hint`, role: HISTORY_SEARCH_ROLES.hint, wrap: 'none', text: state.hint }),
      ...(state.failure === undefined
        ? []
        : [chromeButton(state.retryKey, HISTORY_SEARCH_ROLES.retry, state.retryLabel,
            'Search this scope and query again', true, () => onIntent({ kind: 'retry', serial, revision }))]),
      ui.row(
        { key: `h${serial}-actions-end`, role: HISTORY_SEARCH_ROLES.actionsEnd, gap: 'sm', align: 'center' },
        chromeButton(state.copyKey, HISTORY_SEARCH_ROLES.copy, state.copyLabel,
          state.actionsEnabled ? 'Copy the selected entry exactly as stored' : 'Nothing selected to copy',
          state.actionsEnabled, () => onIntent({ kind: 'copy', serial, revision })),
        chromeButton(state.restoreKey, HISTORY_SEARCH_ROLES.restore, state.restoreLabel,
          state.actionsEnabled ? 'Restore the selected entry into the composer; it never sends it'
            : 'Select a settled history entry to restore it',
          state.actionsEnabled, () => onIntent({ kind: 'restore', serial, revision }))),
    ),
  )
}

/** The ONE scoped sheet. Layout budgets are the v3 Polish candidate figures
 *  mapped onto the client's own theme variables; the native Dock grant, not this
 *  sheet, is the authority on what finally fits. */
export const HISTORY_SEARCH_STYLES = `
  [data-role='dsh.history.card'] {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: min(390px, 55vh);
    padding: 10px 12px;
    border: 1px solid var(--l2);
    border-radius: 12px;
    background: var(--card);
    margin-bottom: 4px;
  }
  [data-role='dsh.history.head'] {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }
  [data-role='dsh.history.head-end'],
  [data-role='dsh.history.actions-end'] {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  [data-role='dsh.history.title'] {
    color: var(--t1);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
  }
  [data-role='dsh.history.scope'],
  [data-role='dsh.history.expand'],
  [data-role='dsh.history.close'],
  [data-role='dsh.history.copy'],
  [data-role='dsh.history.restore'],
  [data-role='dsh.history.retry'] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border: 1px solid var(--l2);
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    cursor: pointer;
    flex-shrink: 0;
  }
  [data-role='dsh.history.scope']:hover,
  [data-role='dsh.history.expand']:hover,
  [data-role='dsh.history.close']:hover,
  [data-role='dsh.history.retry']:hover {
    background: var(--l1);
    color: var(--t1);
  }
  [data-role='dsh.history.scope'][aria-disabled='true'],
  [data-role='dsh.history.copy'][aria-disabled='true'],
  [data-role='dsh.history.restore'][aria-disabled='true'] {
    color: var(--t4);
    border-color: var(--l1);
    cursor: not-allowed;
  }
  /* The primary verb is the filled one, and it is never called Send or Run. */
  [data-role='dsh.history.restore'] {
    border-color: var(--accent);
    background: var(--accent-fill);
    color: #fff;
    font-weight: 500;
  }
  [data-role='dsh.history.restore']:hover {
    filter: brightness(1.06);
  }
  [data-role='dsh.history.restore'][aria-disabled='true'] {
    background: var(--l1);
    border-color: var(--l2);
    color: var(--t4);
    filter: none;
  }
  [data-role='dsh.history.query'] {
    margin: 0;
  }
  [data-role='dsh.history.body'] {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 8px;
    min-height: 0;
    flex: 1 1 auto;
  }
  [data-role='dsh.history.results'],
  [data-role='dsh.history.preview'] {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 0;
  }
  [data-role='dsh.history.results-head'],
  [data-role='dsh.history.preview-head'] {
    color: var(--t3);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
    padding: 2px 0;
  }
  [data-role='dsh.history.results-scroll'],
  [data-role='dsh.history.preview-scroll'] {
    min-height: 0;
    overflow-y: auto;
  }
  [data-role='dsh.history.row'] {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 3px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  [data-role='dsh.history.row']:hover {
    background: rgb(from var(--t1) r g b / 4%);
    color: var(--t1);
  }
  /* The selected row carries a non-colour signal too (the leading marker glyph
     is painted from the same state), so selection is not ink-only. */
  [data-role='dsh.history.row'][data-selected='true'] {
    background: rgb(from var(--t1) r g b / 8%);
    color: var(--t1);
    font-weight: 500;
  }
  [data-role='dsh.history.row-text'] {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }
  [data-role='dsh.history.row-meta'] {
    color: var(--t3);
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  [data-role='dsh.history.status'] {
    padding: 3px 6px;
    color: var(--t4);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
  }
  [data-role='dsh.history.preview-text'] {
    color: var(--t1);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  [data-role='dsh.history.preview-meta'] {
    color: var(--t3);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
  }
  [data-role='dsh.history.actions'] {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    border-top: 1px solid var(--l1);
    padding-top: 6px;
  }
  [data-role='dsh.history.hint'] {
    color: var(--t4);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Short pane: the candidate budget tightens, and the secondary hint is the
     first thing to go — the query, at least one row and both verbs stay. */
  @media (max-height: 460px) {
    [data-role='dsh.history.card'] { max-height: min(224px, 66vh); gap: 4px; padding: 6px 10px; }
    [data-role='dsh.history.hint'] { display: none; }
  }
  /* Narrow pane: stack the body and let the preview keep its own scroll. */
  @media (max-width: 720px) {
    [data-role='dsh.history.body'] { flex-direction: column; }
  }
`
