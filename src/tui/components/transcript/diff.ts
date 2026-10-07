/**
 * Concrete diff RENDERING for tool results and diff cards: `+` lines green,
 * `-` lines red, structural lines dimmed, an optional absolute line-number
 * gutter and the folded-body cap with its "N more changes hidden" footer.
 *
 * The derivation lives in the backend-neutral core
 * (`tui/transcript/diff-projection.ts`) and the theme/relative-path mechanics
 * come from the TUI layers, so this component holds presentation only — it
 * never re-derives a hunk.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/diff
 */

import { color } from '../../theme/runtime.ts'
import { relativizeToCwd } from '../../transcript/tool-presentation.ts'
import {
  isAnchoredFileDiff,
  localHunkRows,
  type DiffInput,
  type DiffLine,
} from '../../transcript/diff-projection.ts'

/**
 * Colorize one unified-diff line.
 * @param line - one line of a unified diff.
 * @returns the colorized line (unchanged when not diff content).
 */
export function renderDiffLine(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return color.diffAdded(line)
  if (line.startsWith('-') && !line.startsWith('---')) return color.diffRemoved(line)
  if (
    line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')
    || line.startsWith('---') || line.startsWith('+++')
  ) {
    return color.diffMeta(line)
  }
  return line
}

/**
 * Colorize a whole diff document, one entry per line.
 * @param text - the diff document.
 * @returns the colorized lines.
 */
export function renderDiffLines(text: string): string[] {
  return text.split('\n').map(renderDiffLine)
}

/** One diff body row: dim line-number gutter plus the colored/plain code.
 * The gutter renders ONLY when the hunk carries a provable absolute anchor
 * (`oldStart`/`newStart`) — without one the relative hunk line numbers would
 * masquerade as file line numbers (plan: never guess a gutter). */
function formatDiffRow(line: DiffLine, showLineNumber: boolean): string {
  const gutter = showLineNumber ? color.diffGutter(`${String(line.lineNum).padStart(4)} `) : ''
  if (line.kind === 'add') return gutter + color.diffAdded(`+ ${line.code}`)
  if (line.kind === 'delete') return gutter + color.diffRemoved(`- ${line.code}`)
  return gutter + `  ${line.code}`
}

/** Options for {@link renderDiffView}. */
export interface DiffViewOptions {
  /** Cap on rendered body rows across all hunks; absent or negative renders everything. */
  maxLines?: number
  /** Hint text for the truncation footer (default 'click to expand'). */
  expandHint?: string
  /** Whether each hunk header includes its path and/or aggregate stats. */
  headerMode?: 'full' | 'stats-only' | 'none'
}

/**
 * Render a result-side diff view (a `card: 'diff'` presentResult intent) as
 * colored lines: by default (`headerMode: 'full'`), one `+N -M path` header per
 * hunk (kimi parity; counts in add/remove colors, path workspace-relative);
 * `stats-only` keeps only `+N -M`, and `none` omits hunk headers. The body uses
 * the bounded contextual patch derivation (official 0.1.6 `DiffBlock` parity):
 * shared context is not a change, distant changes are separate hunks elided as
 * `… N unchanged lines …`, and `maxLines` caps the body across all hunks at a
 * hunk/row boundary with a `… N more changes hidden (hint)` footer. A hunk
 * with `oldText: null` (create) shows only new lines; an empty newText
 * (pure deletion) shows only old lines. Beyond the bounded edit search the
 * complete old/new fragments render as a coarse replacement. The body renders
 * a line-number gutter ONLY when the hunk carries provable absolute anchors
 * (`oldStart`/`newStart` — an optional additive capability); without them no
 * gutter renders (never a fake 1..N gutter).
 * @param diffs - the diff view's hunks.
 * @param cwd - workspace root for path relativization; optional.
 * @param options - cap/hint/header-mode tuning.
 * @returns the colored render lines.
 */
export function renderDiffView(diffs: readonly DiffInput[], cwd?: string, options: DiffViewOptions = {}): string[] {
  const cap = options.maxLines !== undefined && options.maxLines >= 0
    ? options.maxLines
    : Number.POSITIVE_INFINITY
  const headerMode = options.headerMode ?? 'full'
  const hunkViews = diffs.map(hunk => {
    // The absolute hunk anchors are an OPTIONAL additive capability: only
    // a provable anchor renders the gutter — without one the body shows
    // no line numbers at all (never a fake 1..N gutter; plan: hide the
    // gutter, never guess it).
    const anchored = isAnchoredFileDiff(hunk)
    const locals = localHunkRows(hunk)
    let addedCount = 0
    let removedCount = 0
    for (const local of locals) {
      for (const line of local.lines) {
        if (line.kind === 'add') addedCount++
        else if (line.kind === 'delete') removedCount++
      }
    }
    return { hunk, anchored, locals, addedCount, removedCount }
  })
  const totalChanged = hunkViews.reduce((total, view) => total + view.addedCount + view.removedCount, 0)
  const out: string[] = []
  let body = 0
  let truncated = false
  let shownChanges = 0
  let lastElideIndent = ''
  let sawHunk = false

  outer: for (const { hunk, anchored, locals, addedCount, removedCount } of hunkViews) {
    const stats: string[] = []
    if (addedCount > 0) stats.push(color.diffAdded(`+${addedCount}`))
    if (removedCount > 0) stats.push(color.diffRemoved(`-${removedCount}`))
    const header = headerMode === 'full'
      ? `${stats.join(' ')}${stats.length === 0 ? '' : ' '}${relativizeToCwd(hunk.path, cwd)}`
      : stats.join(' ')
    // A no-op hunk has no body rows to consume or hide, so it must not turn
    // an exactly-full budget into a false truncation marker.
    if (locals.length === 0) {
      if (headerMode !== 'none') out.push(header)
      continue
    }
    // Keep later hunk headers from defeating the global folded body budget.
    // The first header remains visible even when maxLines is zero, matching
    // the single-hunk behavior and preserving the card's identity.
    if (body >= cap && sawHunk) {
      truncated = true
      break
    }
    const elideIndent = anchored ? '     ' : ''
    lastElideIndent = elideIndent
    sawHunk = true
    if (headerMode !== 'none') out.push(header)

    for (const [index, local] of locals.entries()) {
      if (index > 0 && local.gapBefore > 0) {
        if (body >= cap) {
          truncated = true
          break outer
        }
        const gap = local.gapBefore
        out.push(color.diffMeta(`${elideIndent}… ${gap} unchanged line${gap > 1 ? 's' : ''} …`))
        body++
      }
      // Emit rows one at a time; allow mid-hunk truncation so a single huge
      // hunk (e.g. the whole file replaced inline) still shows its leading
      // lines instead of degenerating to "N changes hidden" with no body.
      for (const line of local.lines) {
        if (body >= cap) {
          truncated = true
          break outer
        }
        out.push(formatDiffRow(line, anchored))
        body++
        if (line.kind !== 'context') shownChanges++
      }
    }
  }
  if (truncated) {
    const hidden = totalChanged - shownChanges
    const hint = options.expandHint ?? 'click to expand'
    out.push(color.diffMeta(
      hidden > 0
        ? `${lastElideIndent}… ${hidden} more change${hidden > 1 ? 's' : ''} hidden (${hint})`
        : `${lastElideIndent}… more diff lines hidden (${hint})`,
    ))
  }
  return out
}
