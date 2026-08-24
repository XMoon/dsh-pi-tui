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
/** The HARD visual ceiling for a RUNNING preview. The line budget (5) is
 * not a display budget: the capture layer deliberately allows one
 * unterminated logical line to grow to ~256 KiB, and wrapping such a line
 * would produce thousands of visual rows. This ceiling bounds the
 * RENDERED rows even when a single source line is gigantic (plan §5.1:
 * the running preview must never flood the TUI). */
export const RUNNING_PREVIEW_VISUAL_CEILING = 20

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
 *   A HARD visual ceiling (RUNNING_PREVIEW_VISUAL_CEILING) still bounds
 *   the rendered rows: when the kept lines wrap to more than the ceiling
 *   (one gigantic unterminated line), the preview falls back to the newest
 *   visual rows and marks the cut `partial` — the hidden content is the
 *   EARLIER part of the same line, not whole lines.
 * - `'visual'` (settled): lines are wrapped and accumulated until the
 *   DISPLAY rows reach `budget` — a single gigantic line shows only its
 *   own visual tail.
 *
 * Both modes walk BACKWARDS so the newest content wins, slice CJK/emoji/
 * ZWJ safely (wrapTextWithAnsi), keep ANSI intact, and report the hidden
 * SOURCE lines honestly (`partial` flags a cut inside a line, so the
 * marker never claims "N more lines" when it is the front of one line).
 * @param text - the card's result text ('' while running with no output).
 * @param width - the terminal width the rows render at (wrap target).
 * @param budget - the row budget (5 for running, 20 for settled).
 * @param mode - which unit the budget is in.
 * @returns the preview rows (each already wrapped to `width`), the hidden
 *   source-line count, and whether any hidden content was cut mid-line.
 */
export function localShellPreview(
  text: string,
  width: number,
  budget: number,
  mode: LocalShellPreviewBudget,
): { rows: string[]; hidden: number; partial: boolean } {
  const safeWidth = Math.max(1, Math.floor(width))
  const cap = Math.max(1, Math.floor(budget))
  if (text === '') return { rows: [], hidden: 0, partial: false }
  const logical = text.split('\n')
  if (mode === 'lines') {
    // Keep the newest `cap` SOURCE lines; every older line is hidden.
    const kept = logical.slice(-cap)
    const rows: string[] = []
    for (const line of kept) rows.push(...wrapTextWithAnsi(line, safeWidth))
    if (rows.length <= RUNNING_PREVIEW_VISUAL_CEILING) {
      return { rows, hidden: Math.max(0, logical.length - kept.length), partial: false }
    }
    // The kept lines wrap beyond the visual ceiling (typically ONE
    // gigantic unterminated line — the capture layer's 256 KiB partial).
    // Fall back to the newest visual rows; the cut is partial (the hidden
    // content is the EARLIER part of the wrapped line(s), not whole lines
    // we can count).
    return visualTail(logical, safeWidth, RUNNING_PREVIEW_VISUAL_CEILING, true)
  }
  return visualTail(logical, safeWidth, cap, false)
}

/** The shared newest-visual-rows walk: accumulate wrapped lines backwards
 * until the budget, keeping the newest rows that fit. `forcePartial` marks
 * the cut as mid-line (used by the running fallback, where the hidden
 * content is the front of the same kept lines). */
function visualTail(
  logical: readonly string[],
  safeWidth: number,
  budget: number,
  forcePartial: boolean,
): { rows: string[]; hidden: number; partial: boolean } {
  const rows: string[] = []
  let hidden = 0
  let partial = forcePartial
  for (let index = logical.length - 1; index >= 0; index -= 1) {
    const wrapped = wrapTextWithAnsi(logical[index]!, safeWidth)
    if (rows.length + wrapped.length > budget) {
      const room = budget - rows.length
      if (room > 0) {
        rows.unshift(...wrapped.slice(-room))
        partial = true
      }
      hidden = index + 1
      break
    }
    rows.unshift(...wrapped)
  }
  return { rows, hidden, partial }
}

/**
 * The collapse marker for a local-shell card: what is NOT shown, rendered
 * as one dim hint row. Both phases carry the standard expand hint (the
 * user can open the retained buffer while the log still streams). When
 * the hidden content is the EARLIER part of one (or more) kept lines —
 * `partial` — the marker says so honestly: "1 more lines" would claim a
 * whole line is hidden when it is really the front of the same line.
 * @param hidden - the hidden source-line count from {@link localShellPreview}.
 * @param running - whether the card is still streaming (keeps the marker
 *   live; a settled card's hint is identical in wording).
 * @param partial - whether the cut happened inside a line (the hidden
 *   content is the earlier part of the kept line(s)).
 */
export function localShellHiddenMarker(hidden: number, _running: boolean, partial = false): string {
  if (hidden <= 0) return ''
  const what = partial ? 'earlier output hidden' : `${hidden} more lines`
  return `${what} (ctrl+o to expand)`
}

/** Whether a message is a LOCAL `!`/`!!` shell card (the runner pushes
 * these with the unbounded turn marker; a session tool card never carries
 * it). Local cards are the ONLY message kind the shell display policy
 * applies to — session shell tools keep their own folding rules. */
export function isLocalShellCard(message: TranscriptMessage): boolean {
  return message.kind === 'tool' && message.name === 'shell' && message.turn === Number.POSITIVE_INFINITY
}
