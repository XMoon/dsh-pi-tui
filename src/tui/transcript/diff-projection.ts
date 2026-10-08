/**
 * Backend-neutral diff DERIVATION for tool results and diff cards: a real
 * line-level diff engine with the DSH 0.1.6 bounded contextual semantics
 * (`structuredPatch` with `context: 3, maxEditLength: 256`), the hunk row
 * projection with optional absolute anchors, and the diff-result predicate.
 * Pure functions with no renderer, theme or TuiApp dependency, so a headless
 * test drives them directly and the concrete renderer
 * (`tui/components/transcript/diff.ts`) consumes the rows it produces.
 *
 * The input is defined STRUCTURALLY from the fields the derivation needs, so
 * this module does not depend on `@deepseek-ai/dsh-tools` for its own shape;
 * the official `FileDiff` value is assignable to {@link DiffInput}.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/diff-projection
 */

import { structuredPatch } from 'diff'

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
 * The STRUCTURAL diff input the derivation needs: the file path plus the two
 * text fragments. The official `@deepseek-ai/dsh-tools FileDiff` (mutable,
 * same three fields) is assignable, but this module never imports that
 * package for its own contract.
 */
export interface DiffInput {
  /** The changed file's path (workspace-relative or absolute). */
  readonly path: string
  /** Prior content, or `null` for a new file / an unavailable prior side. */
  readonly oldText: string | null
  /** Content after the change. */
  readonly newText: string
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
function localHunks(hunk: DiffInput): LocalHunk[] {
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
export interface LocalHunkRows {
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
export type AnchoredFileDiff = DiffInput & {
  readonly oldStart?: number
  readonly newStart?: number
}

/** Whether a hunk carries PROVABLE absolute anchors: both sides must be
 * positive integers (a missing or malformed anchor is NOT provable — the
 * hunk then renders without a gutter). */
export function isAnchoredFileDiff(hunk: DiffInput): hunk is AnchoredFileDiff {
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
export function localHunkRows(hunk: DiffInput): LocalHunkRows[] {
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
function diffLinesForHunk(hunk: DiffInput): DiffLine[] {
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
export function summarizeDiffs(diffs: readonly DiffInput[]): DiffStats {
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
