/**
 * Diff rendering for tool results and diff cards: `+` lines green, `-` lines
 * red, structural lines dimmed; plus a real line-level diff engine (kimi
 * computeDiffLines parity) with context clustering and fold capping for
 * diff-card bodies. Pure functions so the headless tests can drive them
 * without a TUI.
 * @module @xmoon76/dsh-pi-tui/diff
 */

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
 * Above this combined input size the O(n·m) LCS table is skipped and the
 * diff degrades to a naive all-delete/all-add listing (still correct, just
 * without alignment).
 */
const DIFF_LCS_MAX_LINES = 2000

/**
 * Compute a line-level diff by DP longest-common-subsequence (kimi
 * `computeDiffLines` parity): context rows for identical lines, add/delete
 * rows for the differing runs, each carrying its source-side line number.
 * @param oldText - the before side.
 * @param newText - the after side.
 * @param oldStart - first line number of the old side (default 1).
 * @param newStart - first line number of the new side (default 1).
 * @returns the diff rows in document order.
 */
export function computeDiffLines(oldText: string, newText: string, oldStart = 1, newStart = 1): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const m = oldLines.length
  const n = newLines.length
  if (m + n > DIFF_LCS_MAX_LINES) {
    // Large input: a naive listing keeps the render bounded (no alignment).
    const out: DiffLine[] = []
    for (let i = 0; i < m; i++) out.push({ kind: 'delete', lineNum: oldStart + i, code: oldLines[i]! })
    for (let j = 0; j < n; j++) out.push({ kind: 'add', lineNum: newStart + j, code: newLines[j]! })
    return out
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  const reversed: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ kind: 'context', lineNum: newStart + j - 1, code: newLines[j - 1]! })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      reversed.push({ kind: 'add', lineNum: newStart + j - 1, code: newLines[j - 1]! })
      j--
    } else {
      reversed.push({ kind: 'delete', lineNum: oldStart + i - 1, code: oldLines[i - 1]! })
      i--
    }
  }
  return reversed.reverse()
}

/** One contiguous run of the clustered diff body. */
interface DiffCluster {
  start: number
  end: number
}

/**
 * Group change rows into clusters with `contextLines` of context on each
 * side, merging clusters whose unchanged gap is ≤ 2·contextLines.
 * @returns the clusters plus add/delete/change counts over all diff rows.
 */
function buildDiffClusters(diffLines: readonly DiffLine[], contextLines: number): {
  clusters: DiffCluster[]
  changedCount: number
  addedCount: number
  removedCount: number
} {
  const changeIndices: number[] = []
  let added = 0
  let removed = 0
  for (const [i, line] of diffLines.entries()) {
    if (line.kind === 'add') {
      added++
      changeIndices.push(i)
    } else if (line.kind === 'delete') {
      removed++
      changeIndices.push(i)
    }
  }
  if (changeIndices.length === 0) {
    return { clusters: [], changedCount: 0, addedCount: added, removedCount: removed }
  }
  const clusters: DiffCluster[] = []
  const mergeGap = 2 * contextLines
  let groupStart = changeIndices[0]!
  let groupEnd = changeIndices[0]!
  for (let k = 1; k < changeIndices.length; k++) {
    const idx = changeIndices[k]!
    if (idx - groupEnd <= mergeGap) {
      groupEnd = idx
    } else {
      clusters.push({
        start: Math.max(0, groupStart - contextLines),
        end: Math.min(diffLines.length - 1, groupEnd + contextLines),
      })
      groupStart = idx
      groupEnd = idx
    }
  }
  clusters.push({
    start: Math.max(0, groupStart - contextLines),
    end: Math.min(diffLines.length - 1, groupEnd + contextLines),
  })
  return { clusters, changedCount: changeIndices.length, addedCount: added, removedCount: removed }
}

/** One diff body row: dim line-number gutter plus the colored/plain code.
 * The gutter renders ONLY when the hunk carries a provable absolute
 * anchor (`oldStart`/`newStart`) — without one the relative hunk line
 * numbers would masquerade as file line numbers (plan: never guess a
 * gutter). */
function formatDiffRow(line: DiffLine, showLineNumber: boolean): string {
  const gutter = showLineNumber ? color.diffGutter(`${String(line.lineNum).padStart(4)} `) : ''
  if (line.kind === 'add') return gutter + color.diffAdded(`+ ${line.code}`)
  if (line.kind === 'delete') return gutter + color.diffRemoved(`- ${line.code}`)
  return gutter + `  ${line.code}`
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

/** Options for {@link renderDiffView}. */
export interface DiffViewOptions {
  /** Context rows around each change cluster (default 3). */
  contextLines?: number
  /** Cap on rendered body rows; absent or negative renders everything. */
  maxLines?: number
  /** Hint text for the truncation footer (default 'click to expand'). */
  expandHint?: string
}

/**
 * Render a result-side diff view (a `card: 'diff'` presentResult intent) as
 * colored lines: one `+N -M path` header per hunk (kimi parity; counts in
 * add/remove colors, path workspace-relative), then the LCS-aligned body
 * with context clustering — unchanged runs between clusters elide to a
 * `… N unchanged lines …` separator, and `maxLines` caps the body at a
 * cluster boundary with a `… N more changes hidden (hint)` footer. A hunk
 * with `oldText: null` (create) shows only new lines; an empty newText
 * (pure deletion) shows only old lines. The body renders a line-number
 * gutter ONLY when the hunk carries provable absolute anchors
 * (`oldStart`/`newStart` — an optional additive capability); without
 * them no gutter renders (never a fake 1..N gutter).
 * @param diffs - the diff view's hunks.
 * @param cwd - workspace root for path relativization; optional.
 * @param options - context/cap/hint tuning.
 * @returns the colored render lines.
 */
export function renderDiffView(diffs: readonly FileDiff[], cwd?: string, options: DiffViewOptions = {}): string[] {
  const contextLines = options.contextLines ?? 3
  const cap = options.maxLines !== undefined && options.maxLines >= 0
    ? options.maxLines
    : Number.POSITIVE_INFINITY
  const out: string[] = []
  for (const hunk of diffs) {
    // The absolute hunk anchors are an OPTIONAL additive capability: only
    // a provable anchor renders the gutter — without one the body shows
    // no line numbers at all (never a fake 1..N gutter; plan: hide the
    // gutter, never guess it).
    const anchored = isAnchoredFileDiff(hunk)
    const oldStart = anchored ? hunk.oldStart! : 1
    const newStart = anchored ? hunk.newStart! : 1
    const oldSide = hunk.oldText === null || hunk.oldText === '' ? [] : hunk.oldText.split('\n')
    const newSide = hunk.newText === '' ? [] : hunk.newText.split('\n')
    const diffLines: DiffLine[] = oldSide.length === 0
      ? newSide.map((code, index) => ({ kind: 'add', lineNum: newStart + index, code }))
      : newSide.length === 0
        ? oldSide.map((code, index) => ({ kind: 'delete', lineNum: oldStart + index, code }))
        : computeDiffLines(hunk.oldText!, hunk.newText, oldStart, newStart)
    const { clusters, changedCount, addedCount, removedCount } = buildDiffClusters(diffLines, contextLines)

    let header = ''
    if (addedCount > 0) header += color.diffAdded(`+${addedCount} `)
    if (removedCount > 0) header += color.diffRemoved(`-${removedCount} `)
    header += relativizeToCwd(hunk.path, cwd)
    out.push(header)
    if (clusters.length === 0) continue

    // The elision/footer indent mirrors the gutter column when the gutter
    // renders; without a gutter the body starts at column 0.
    const elideIndent = anchored ? '     ' : ''
    let body = 0
    let prevEnd = -1
    let truncated = false
    let shownChanges = 0
    outer: for (const cluster of clusters) {
      if (body >= cap) {
        truncated = true
        break
      }
      if (prevEnd >= 0) {
        const gap = cluster.start - prevEnd - 1
        if (gap > 0) {
          if (body + 1 > cap) {
            truncated = true
            break
          }
          out.push(color.diffMeta(`${elideIndent}… ${gap} unchanged line${gap > 1 ? 's' : ''} …`))
          body++
        }
      }
      // Emit cluster rows one at a time; allow mid-cluster truncation so a
      // single huge cluster (e.g. the whole file replaced inline) still
      // shows its leading lines instead of degenerating to "N changes
      // hidden" with no body at all.
      for (let i = cluster.start; i <= cluster.end; i++) {
        if (body >= cap) {
          truncated = true
          break outer
        }
        const line = diffLines[i]!
        out.push(formatDiffRow(line, anchored))
        body++
        if (line.kind !== 'context') shownChanges++
        prevEnd = i
      }
    }
    if (truncated) {
      const hidden = changedCount - shownChanges
      if (hidden > 0) {
        const hint = options.expandHint ?? 'click to expand'
        out.push(color.diffMeta(
          `${elideIndent}… ${hidden} more change${hidden > 1 ? 's' : ''} hidden (${hint})`,
        ))
      }
    }
  }
  return out
}
