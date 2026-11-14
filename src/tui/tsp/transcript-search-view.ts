/**
 * T3-B1: the pure node projection of the ONE Session Search card.
 *
 * It paints the seat's already-decided render state as ONE Dock card — a title
 * line with the coverage label, the ONE official `ui.input` query field, the
 * `N/M targets` count, the three real `html.button` actions (`Prev`/`Next`/
 * `Close`) and the static `Source-only` line — and installs ONE scoped
 * stylesheet. It owns no state, no search, no SDK session and no business
 * authority: every cell's meaning comes from
 * {@link TspTranscriptSearchRenderState}, and every click is handed to the seat
 * as the same intent a key produces.
 *
 * Untrusted-text discipline: the ONLY content this view paints is the user's
 * own query (a one-line sanitized filter) and the seat's CLOSED-VOCABULARY
 * labels. A match's text, a tool body, a path, a URL or a token never reaches a
 * painted cell, a `title` or an `aria`.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/transcript-search-view
 */

import { html, ui } from '@stencil-hq/tern'
import type { Node } from '@stencil-hq/tern'
import type { TspTranscriptSearchIntent, TspTranscriptSearchRenderState } from './transcript-search.ts'

/** The ONE surface-scoped stylesheet the Search card installs. */
export const TRANSCRIPT_SEARCH_SHEET = 'dsh-transcript-search'

/** The product role hooks the card and its stylesheet share. Every selector is
 *  scoped under a `dsh.search.*` role, so nothing here can restyle the Composer
 *  shell, the Footer, the Transcript or another TSP panel. */
export const TRANSCRIPT_SEARCH_ROLES = {
  card: 'dsh.search.card',
  head: 'dsh.search.head',
  title: 'dsh.search.title',
  count: 'dsh.search.count',
  query: 'dsh.search.query',
  actions: 'dsh.search.actions',
  prev: 'dsh.search.prev',
  next: 'dsh.search.next',
  close: 'dsh.search.close',
  source: 'dsh.search.source',
  empty: 'dsh.search.empty',
} as const

export interface TspTranscriptSearchViewInput {
  readonly state: TspTranscriptSearchRenderState
  /** The ONE route every pointer action takes: the seat's admitted intent. */
  readonly onIntent: (intent: TspTranscriptSearchIntent) => void
}

/** One chrome button. `disabled` is stated BOTH visually and in the seat's own
 *  admission (a stale frame never acts). */
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

/** Build the ONE Session Search card node for this frame. */
export function transcriptSearchView(input: TspTranscriptSearchViewInput): Node {
  const { state, onIntent } = input
  const serial = state.serial
  const revision = state.revision
  return ui.col(
    { key: `search-card-${serial}`, role: TRANSCRIPT_SEARCH_ROLES.card, gap: 'none' },
    ui.row(
      { key: `ss${serial}-head`, role: TRANSCRIPT_SEARCH_ROLES.head, gap: 'sm', align: 'center' },
      ui.text({ key: `ss${serial}-title`, role: TRANSCRIPT_SEARCH_ROLES.title, wrap: 'none', text: state.header }),
      ui.row(
        { key: `ss${serial}-head-end`, role: TRANSCRIPT_SEARCH_ROLES.actions, gap: 'sm', align: 'center' },
        chromeButton(state.prevKey, TRANSCRIPT_SEARCH_ROLES.prev, 'Prev', 'Previous search target',
          state.navigable, () => onIntent({ kind: 'previous', serial, revision })),
        chromeButton(state.nextKey, TRANSCRIPT_SEARCH_ROLES.next, 'Next', 'Next search target',
          state.navigable, () => onIntent({ kind: 'next', serial, revision })),
        chromeButton(state.closeKey, TRANSCRIPT_SEARCH_ROLES.close, 'Close', 'Close session search',
          true, () => onIntent({ kind: 'close', serial, revision })),
      ),
    ),
    ui.row(
      { key: `ss${serial}-query-row`, gap: 'sm', align: 'center' },
      // The ONE field the card owns. The seat's key route edits it (the pinned
      // client delivers no native EditEvent), so this node is a controlled
      // display of `{text, cursor}` plus a real caret target; `onFocus` is the
      // pointer route back into the same seat.
      ui.input({
        key: state.queryKey,
        role: TRANSCRIPT_SEARCH_ROLES.query,
        text: state.query,
        cursor: state.queryCursor,
        placeholder: 'Search this session…',
        aria: 'Search this session',
        onFocus: () => onIntent({ kind: 'focus-query', serial, revision }),
      }),
      ui.text({ key: `ss${serial}-count`, role: TRANSCRIPT_SEARCH_ROLES.count, wrap: 'none', text: state.countLabel }),
    ),
    ui.text({
      key: `ss${serial}-source`,
      role: TRANSCRIPT_SEARCH_ROLES.source,
      wrap: 'none',
      text: state.sourceLabel,
    }),
    ...(state.empty === undefined
      ? []
      : [ui.text({ key: `ss${serial}-empty`, role: TRANSCRIPT_SEARCH_ROLES.empty, wrap: 'none', text: state.empty })]),
  )
}

/** The ONE scoped sheet. Every selector starts from a `dsh.search.*` role, so no
 *  rule can reach another TSP panel or Tern chrome. The card is a flex-shrink:0
 *  Dock child: it never pushes the Footer out, and it asks for no fixed height,
 *  so the Main above keeps the rest of the pane. */
export const TRANSCRIPT_SEARCH_STYLES = `
  [data-role='dsh.search.card'] {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
    padding: 10px 12px;
    border: 1px solid var(--l2);
    border-radius: 12px;
    background: var(--card);
    margin-bottom: 4px;
  }
  [data-role='dsh.search.head'],
  [data-role='dsh.search.actions'] {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    flex-shrink: 0;
  }
  [data-role='dsh.search.actions'] {
    margin-left: auto;
  }
  [data-role='dsh.search.title'] {
    color: var(--t1);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-role='dsh.search.count'] {
    color: var(--t3);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
    flex-shrink: 0;
    white-space: nowrap;
  }
  [data-role='dsh.search.query'] {
    margin: 0;
    min-width: 0;
    flex: 1 1 auto;
  }
  [data-role='dsh.search.prev'],
  [data-role='dsh.search.next'],
  [data-role='dsh.search.close'] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
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
  [data-role='dsh.search.prev']:hover,
  [data-role='dsh.search.next']:hover,
  [data-role='dsh.search.close']:hover {
    background: var(--l1);
    color: var(--t1);
  }
  [data-role='dsh.search.prev'][aria-disabled='true'],
  [data-role='dsh.search.next'][aria-disabled='true'] {
    color: var(--t4);
    border-color: var(--l1);
    cursor: not-allowed;
  }
  [data-role='dsh.search.source'] {
    color: var(--t3);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-role='dsh.search.empty'] {
    color: var(--t4);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
    flex-shrink: 0;
  }
  /* Short pane: the secondary lines tighten first; the query, the count and all
     three real buttons always stay. */
  @media (max-height: 460px) {
    [data-role='dsh.search.card'] { gap: 4px; padding: 6px 10px; }
    [data-role='dsh.search.empty'] { display: none; }
  }
  /* Narrow pane: the count moves under the field so no button is squeezed out
     of the row. */
  @media (max-width: 460px) {
    [data-role='dsh.search.card'] { padding: 8px 10px; }
    [data-role='dsh.search.prev'],
    [data-role='dsh.search.next'],
    [data-role='dsh.search.close'] { padding: 3px 8px; }
  }
`
