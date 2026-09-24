/**
 * Diff rendering for tool results and diff cards: `+` lines green, `-` lines
 * red, structural lines dimmed; plus a real line-level diff engine with the
 * DSH 0.1.6 bounded contextual semantics (`structuredPatch` with
 * `context: 3, maxEditLength: 256`) and fold capping for diff-card bodies.
 * Pure functions so the headless tests can drive them without a TUI.
 * @module @xmoon76/dsh-pi-tui/diff
 */

import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { color } from './theme.ts'
import { relativizeToCwd } from './present.ts'

/**
 * Whether a tool result should render as a diff: edit-class tools always,
 * anything else only when the text carries diff structure.
 * @param name - the tool name.
 * @param result - the tool result text.
 * @returns whether to colorize the result as a diff.
 */
export function isDiffResult(name: string, result: string): boolean {
  if (name === 'edit' || name === 'apply_patch' || name === 'apply-patch') return true
  return result.startsWith('diff --git') || result.includes('\ndiff --git') || result.includes('\n@@ ')
}

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

/** One row of a computed line diff. */
export interface DiffLine {
  /** context (unchanged), add (new side) or delete (old side). */
  kind: 'context' | 'add' | 'delete'
  /** 1-based source line number (new side for add/context, old side for delete). */
  lineNum: number
  /** The line's code, without any diff marker. */
  code: string
}

/**
 * Bound on the synchronous edit-graph search (official 0.1.6 `DiffBlock`):
 * one replacement consumes two edits. Beyond it the complete old/new
 * fragments render as a coarse replacement. Deterministic — never a
 * wall-clock timeout, and never a function of the total input size.
 */
export const MAX_DIFF_EDIT_LENGTH = 256

/** Context lines kept on each side of an exact change (official 0.1.6). */
export const DIFF_CONTEXT_LINES = 3

/**
 * Split a side's text into its content lines. Empty text is ZERO lines (a
 * full deletion's new side or a create's absent old side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line.
 * An interior blank line (a genuine `\n\n`) survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** One local patch hunk (`structuredPatch`), or the coarse whole-fragment fallback. */
interface LocalHunk {
  /** Marker-prefixed rows (`' '` context, `'-'` delete, `'+'` add). */
  readonly lines: readonly string[]
  /** 1-based old-side start within the fragment (absent for the coarse fallback). */
  readonly oldStart?: number
  /** 1-based new-side start within the fragment (absent for the coarse fallback). */
  readonly newStart?: number
}

/**
 * The ONE diff derivation for a hunk: an exact bounded `structuredPatch`
 * (`context: 3`, `maxEditLength: 256`), or — when the edit-graph search bound
 * is exceeded — a coarse whole-fragment `old all delete + new all add`
 * replacement that keeps every input line.
 * @param hunk - the file fragment to compare.
 * @returns the local hunks (never empty for a changed fragment).
 */
function localHunks(hunk: FileDiff): LocalHunk[] {
  const oldLines = contentLines(hunk.oldText ?? '')
  const newLines = contentLines(hunk.newText)
  // `structuredPatch` compares newline-terminated lines, so normalize first;
  // the content-line rule above already removed any terminal newline.
  const normalize = (lines: readonly string[]): string => lines.map(line => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines), undefined, undefined, {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: MAX_DIFF_EDIT_LENGTH,
  })?.hunks ?? [{
    lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)],
  }]
}

/** One local hunk's render rows plus the unchanged gap that precedes it. */
interface LocalHunkRows {
  readonly lines: DiffLine[]
  /** Unchanged old-side lines between this hunk and the previous one (0 for the first). */
  readonly gapBefore: number
}

/**
 * A diff hunk that MAY carry the absolute hunk anchors the DSH public
 * `FileDiff` contract does not expose yet. Presentation-side structural
 * type ONLY: additive / optional runtime capability, never assumed to be
 * present, never sourced from a private API. Upstream follow-up (plan
 * 2026-09-02 §2.5, tracked in the plan doc): add `oldStart`/`newStart`
 * as optional fields to `FileDiff` in `@deepseek-ai/dsh-tools`
 * (`packages/fs/tool-fs/src/diff.ts` — keep the hunk anchors when
 * converting unified-diff output). When that lands, this type resolves
 * to the same shape and the real absolute line numbers render again.
 */
export type AnchoredFileDiff = FileDiff & {
  oldStart?: number
  newStart?: number
}

/** Whether a hunk carries PROVABLE absolute anchors: both sides must be
 * positive integers (a missing or malformed anchor is NOT provable — the
 * hunk then renders without a gutter). */
export function isAnchoredFileDiff(hunk: FileDiff): hunk is AnchoredFileDiff {
  const anchored = hunk as AnchoredFileDiff
  return Number.isInteger(anchored.oldStart) && (anchored.oldStart as number) >= 1
    && Number.isInteger(anchored.newStart) && (anchored.newStart as number) >= 1
}

/**
 * Derive one fragment's render rows, grouped per local hunk. Line numbers
 * advance from the fragment's optional absolute anchors: DELETES use the
 * old-side counter, adds and context the new-side counter (a context row
 * advances BOTH). Without a provable anchor the counters are relative and the
 * renderer shows no gutter — never a fake absolute line number.
 * @param hunk - the file fragment.
 * @returns the per-hunk rows and the unchanged gap preceding each.
 */
function localHunkRows(hunk: FileDiff): LocalHunkRows[] {
  const anchored = isAnchoredFileDiff(hunk)
  const fragmentOld = anchored ? hunk.oldStart! : 1
  const fragmentNew = anchored ? hunk.newStart! : 1
  const rows: LocalHunkRows[] = []
  let previousOldEnd: number | undefined
  for (const local of localHunks(hunk)) {
    // A local hunk's start is relative to the fragment; offset it by the
    // fragment's absolute anchor when the caller proved one.
    const baseOld = fragmentOld + (local.oldStart ?? 1) - 1
    const baseNew = fragmentNew + (local.newStart ?? 1) - 1
    const lines: DiffLine[] = []
    let oldLine = baseOld
    let newLine = baseNew
    let oldCount = 0
    for (const line of local.lines) {
      if (line.startsWith('-')) {
        lines.push({ kind: 'delete', lineNum: oldLine, code: line.slice(1) })
        oldLine++
        oldCount++
      } else if (line.startsWith('+')) {
        lines.push({ kind: 'add', lineNum: newLine, code: line.slice(1) })
        newLine++
      } else {
        lines.push({ kind: 'context', lineNum: newLine, code: line.slice(1) })
        oldLine++
        newLine++
        oldCount++
      }
    }
    // The gap between two exact hunks is the unchanged run they skip; the
    // coarse fallback (no starts) has no provable gap.
    const gapBefore = previousOldEnd === undefined || local.oldStart === undefined
      ? 0
      : Math.max(0, baseOld - previousOldEnd)
    rows.push({ lines, gapBefore })
    previousOldEnd = baseOld + oldCount
  }
  return rows
}

/** Compute the exact render rows for one hunk (flattened across local hunks). */
function diffLinesForHunk(hunk: FileDiff): DiffLine[] {
  return localHunkRows(hunk).flatMap(row => row.lines)
}

/** Aggregate add/delete counts from the same rows rendered in a diff body. */
export interface DiffStats {
  added: number
  removed: number
}

/**
 * Count displayed additions and deletions from the SAME derivation the body
 * renders: exact patches exclude shared context; a comparison past the bounded
 * edit search counts both complete fragments as replaced.
 * @param diffs - the hunks to count.
 * @returns the `+/-` totals for summaries and the card footer.
 */
export function summarizeDiffs(diffs: readonly FileDiff[]): DiffStats {
  let added = 0
  let removed = 0
  for (const hunk of diffs) {
    for (const line of diffLinesForHunk(hunk)) {
      if (line.kind === 'add') added++
      else if (line.kind === 'delete') removed++
    }
  }
  return { added, removed }
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
export function renderDiffView(diffs: readonly FileDiff[], cwd?: string, options: DiffViewOptions = {}): string[] {
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
