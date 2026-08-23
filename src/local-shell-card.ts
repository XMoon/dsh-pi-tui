/**
 * Local-shell card display policy (the 2026-08-24 UX plan, item 2): the
 * `!`/`!!` shell card renders COLLAPSED by default so a long log cannot
 * fill the TUI — a running card shows the last 5 source lines, a settled
 * card shows at most 20 VISUAL rows — and Ctrl+O (the existing global
 * tool-output master switch) expands it to the retained buffer.
 *
 * Two layers stay separate (plan §2.1): the CAPTURE layer (bounded-output.ts
 * caps bytes/lines/disk) is untouched; this module only decides what the
 * card PRESENTS. The helpers are pure and injectable so the preview math
 * (visual rows, hidden counts, Unicode safety) is unit-testable without a
 * terminal.
 * @module @xmoon76/dsh-pi-tui/local-shell-card
 */

import { wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { TranscriptMessage } from './transcript.ts'

/** Running cards collapse to this many newest SOURCE lines (kimi
 * semantics: the running tail stays small while the log streams). */
export const RUNNING_PREVIEW_LINES = 5
/** Settled cards collapse to this many VISUAL rows (pi semantics: a long
 * logical line wraps and counts as several terminal rows, so the budget is
 * in display rows, never raw `split('\n').slice()`). */
export const SETTLED_PREVIEW_VISUAL_ROWS = 20

/** Whether a message is a LOCAL `!`/`!!` shell card (the runner pushes
 * these with the unbounded turn marker; a session tool card never carries
 * it). Local cards are the ONLY message kind the shell display policy
 * applies to — session shell tools keep their own folding rules. */
export function isLocalShellCard(message: TranscriptMessage): boolean {
  return message.kind === 'tool' && message.name === 'shell' && message.turn === Number.POSITIVE_INFINITY
}

/** Whether the budget is a source-LINE budget (running) or a VISUAL-row
 * budget (settled). Running previews keep the log's own line identity
 * (kimi `RUNNING_PREVIEW_LINES`); settled previews bound the DISPLAYED
 * rows so wrapping can never blow the card up. */
export type LocalShellPreviewBudget = 'lines' | 'visual'

/**
 * The newest content of `text` that fits the budget, plus the number of
 * hidden source lines above it.
 *
 * - `'lines'` (running): at most `budget` SOURCE lines are kept, each
 *   wrapped to `width` afterwards — the log's own line count is the unit.
 * - `'visual'` (settled): lines are wrapped and accumulated until the
 *   DISPLAY rows reach `budget` — a single gigantic line shows only its
 *   own visual tail.
 *
 * Both modes walk BACKWARDS so the newest content wins, slice CJK/emoji/
 * ZWJ safely (wrapTextWithAnsi), keep ANSI intact, and report the hidden
 * SOURCE lines honestly (a partially-visible last line is hidden too —
 * the marker never claims more is shown than is).
 * @param text - the card's result text ('' while running with no output).
 * @param width - the terminal width the rows render at (wrap target).
 * @param budget - the row budget (5 for running, 20 for settled).
 * @param mode - which unit the budget is in.
 * @returns the preview rows (each already wrapped to `width`) and the
 *   hidden source-line count (0 when everything fits).
 */
export function localShellPreview(
  text: string,
  width: number,
  budget: number,
  mode: LocalShellPreviewBudget,
): { rows: string[]; hidden: number } {
  const safeWidth = Math.max(1, Math.floor(width))
  const cap = Math.max(1, Math.floor(budget))
  if (text === '') return { rows: [], hidden: 0 }
  const logical = text.split('\n')
  if (mode === 'lines') {
    // Keep the newest `cap` SOURCE lines; every older line is hidden.
    const kept = logical.slice(-cap)
    const rows: string[] = []
    for (const line of kept) rows.push(...wrapTextWithAnsi(line, safeWidth))
    return { rows, hidden: Math.max(0, logical.length - kept.length) }
  }
  // Visual mode: accumulate wrapped rows backwards until the budget.
  const rows: string[] = []
  let hidden = 0
  for (let index = logical.length - 1; index >= 0; index -= 1) {
    const wrapped = wrapTextWithAnsi(logical[index]!, safeWidth)
    if (rows.length + wrapped.length > cap) {
      const room = cap - rows.length
      if (room > 0) rows.unshift(...wrapped.slice(-room))
      hidden = index + 1
      break
    }
    rows.unshift(...wrapped)
  }
  return { rows, hidden }
}

/**
 * The collapse marker for a local-shell card: what is NOT shown, rendered
 * as one dim hint row. Both phases carry the standard expand hint (the
 * user can open the retained buffer while the log still streams).
 * @param hidden - the hidden source-line count from {@link localShellPreview}.
 * @param running - whether the card is still streaming (keeps the marker
 *   live; a settled card's hint is identical in wording).
 */
export function localShellHiddenMarker(hidden: number, _running: boolean): string {
  if (hidden <= 0) return ''
  return `${hidden} more lines (ctrl+o to expand)`
}