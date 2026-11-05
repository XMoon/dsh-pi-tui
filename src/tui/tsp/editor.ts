/**
 * TspComposer (PR3-B §3.4): the TSP renderer's ONE program-owned composer.
 *
 * State is `{ text, cursor, focused }`; `cursor` is in **UTF-16 code units**
 * (the SDK `ui.editor` contract) and is kept at a **grapheme-cluster
 * boundary** at all times (the B1 review F1 invariant): a numeric replacement
 * clamps AND normalizes the caret to a boundary (forward affinity — the caret
 * lands at the containing cluster's END, matching the editor convention for
 * text inserted before it); an insertion normalizes the caret after any merge
 * the inserted fragment caused with the following combining/ZWJ cluster; both
 * deletion endpoints are cluster-aligned. This holds for every entry — the
 * reducer, the composer-port mutators, and the clamp — so a legal key/paste
 * sequence (e.g. paste a combining mark, Home, type a letter merging into one
 * cluster) can never strand a lone surrogate or a partial cluster.
 *
 * Every authoritative state mutation (the reducer's accepted edits AND the
 * composer-port mutators `setDraft`/`setEditorText`/`insertIntoEditor`)
 * notifies the `onChanged` sink exactly once, so the owning renderer commits a
 * new controlled-editor frame (the B1 review F2 invariant — a restored draft
 * must reach the wire, never only `getDraft()`).
 *
 * This object owns NO Host dependencies: it is Client-local editor state. The
 * dock rendering that presents it and the `SubmissionComposerPort` adapter
 * live in `session.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/editor
 */

import type { Key } from '@stencil-hq/tern'
import type { SubmitPendingDetail } from '../../app/submission/ack.ts'
import { PasteRangeTracker, type PasteRangeSpan } from '../interaction/pasted-path-range.ts'
import type { InlineAttachmentSpan } from '../interaction/autocomplete/inline-attachment.ts'

/** The composer's editor state snapshot (cursor in UTF-16 code units). */
export interface TspComposerState {
  readonly text: string
  readonly cursor: number
  readonly focused: boolean
}

/**
 * What applying one key produced, so the caller renders a new controlled
 * editor state ONLY after an accepted edit (coalesced into its frame), marks
 * user activity only on real editable/submit keys, and performs the
 * application-side gesture itself (B1 refuses submits locally; B2 binds the
 * real onSubmit through the input handlers).
 */
export type TspComposerEdit =
  | { readonly kind: 'none' }
  | { readonly kind: 'edited' }
  | { readonly kind: 'submit'; readonly gesture: 'enter' | 'accelerated' }
  | { readonly kind: 'exit-empty' }

/** The grapheme segmenter (`Intl.Segmenter` on Node 24; one shared instance). */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** The boundaries (start offsets) of every grapheme cluster in `text`. */
function clusterBoundaries(text: string): number[] {
  const starts: number[] = []
  for (const { index } of segmenter.segment(text)) starts.push(index)
  return starts
}

/**
 * Normalize a caret candidate onto a grapheme-cluster boundary (the F1
 * invariant). A candidate inside a cluster moves FORWARD to that cluster's
 * end (editor affinity: text replaced shorter than the old caret keeps the
 * caret after the cluster it was reading); candidates at/beyond the text end
 * clamp to the end.
 */
function boundaryCursor(text: string, cursor: number): number {
  const clamped = Math.max(0, Math.min(text.length, cursor))
  let end = 0
  let lastClusterEnd = 0
  for (const { index, segment } of segmenter.segment(text)) {
    const clusterEnd = index + segment.length
    if (index < clamped && clusterEnd > clamped) return clusterEnd
    if (clusterEnd <= clamped) end = clusterEnd
    lastClusterEnd = clusterEnd
  }
  // A candidate at/after the final cluster's end IS a boundary (the text
  // end) — the loop's `end` only tracks clusters strictly before it.
  return clamped >= lastClusterEnd ? text.length : end
}

/**
 * The UTF-16 offset where the grapheme cluster immediately LEFT of `cursor`
 * begins — the destination of a caret-left / the cut start of a backspace.
 * `cursor` must already be boundary-aligned (the reducer maintains that).
 */
function previousGraphemeStart(text: string, cursor: number): number {
  let result = 0
  for (const { index } of segmenter.segment(text)) {
    if (index < cursor) result = index
    else break
  }
  return result
}

/**
 * The UTF-16 offset where the grapheme cluster at/RIGHT of `cursor` ends —
 * the destination of a caret-right / the cut end of a delete.
 */
function nextGraphemeEnd(text: string, cursor: number): number {
  for (const { index, segment } of segmenter.segment(text)) {
    const end = index + segment.length
    if (end > cursor) return end
  }
  return text.length
}

/** One logical (hard-newline) line of the draft. */
interface LogicalLine {
  readonly start: number
  readonly end: number
}

/** The line end sits BEFORE a complete CRLF pair — the same line model `end`
 *  uses, because that pair is ONE grapheme cluster. */
function trimCarriageReturn(text: string, start: number, end: number): number {
  return end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end
}

/** The `\n`-delimited logical lines of `text` (always at least one). */
function logicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue
    lines.push({ start, end: trimCarriageReturn(text, start, index) })
    start = index + 1
  }
  lines.push({ start, end: trimCarriageReturn(text, start, text.length) })
  return lines
}

/** The line that holds `cursor` (a caret at a line's end belongs to that line). */
function lineIndexOf(lines: readonly LogicalLine[], cursor: number): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (cursor >= lines[index]!.start) return index
  }
  return 0
}

/** The caret's column inside `line`, counted in GRAPHEMES (never UTF-16 units). */
function graphemeColumn(text: string, line: LogicalLine, caret: number): number {
  let column = 0
  for (const { index } of segmenter.segment(text.slice(line.start, line.end))) {
    if (line.start + index >= caret) break
    column += 1
  }
  return column
}

/** The UTF-16 boundary `column` graphemes into `line`, clamped to its end. */
function offsetAtColumn(text: string, line: LogicalLine, column: number): number {
  let seen = 0
  for (const { index } of segmenter.segment(text.slice(line.start, line.end))) {
    if (seen === column) return line.start + index
    seen += 1
  }
  return line.end
}

/** The sinks the composer notifies: the owning renderer renders ONE frame per
 *  authoritative mutation, plus the application-facing presentation facts. */
export interface TspComposerSinks {
  /** ONE authoritative editor state changed (reducer edit or port mutator). */
  readonly onChanged: () => void
  /** The sink for the pending-row fact ('submit'/'queued'/undefined clears). */
  readonly setSubmitPending: (detail: SubmitPendingDetail | undefined) => void
  /** The sink for transient notices. */
  readonly notify: (text: string, kind?: 'info' | 'error') => void
}

/**
 * The mount's history recall, as the composer is allowed to see it (TSP I-B):
 * a read of the ONE `HistoryRecallScope` snapshot plus the application's
 * EXISTING draft admission. The composer owns no history store, no filter and
 * no second Session identity.
 */
export interface TspComposerRecallPort {
  /** I-A kernel's defensive latest-first snapshot. No IO. */
  entries(): readonly string[]
  /**
   * The existing application paste and plain-history eligibility for a draft
   * about to be replaced by a recalled row. It may notify; it never submits.
   */
  admitDraft(text: string): boolean
}

/** The draft and caret ↑/↓ browsing gives back when it leaves index 0. */
interface RecallDraftBookmark {
  readonly text: string
  /** A UTF-16 boundary — the caret the user was editing at. */
  readonly cursor: number
}

/**
 * Create the TSP composer. The sinks surface both the render trigger and the
 * application's composer-port facts onto the renderer's own presentation, and
 * the recall port is the mount's history scope read through the ONE kernel.
 */
export function createTspComposer(sinks: TspComposerSinks, recall: TspComposerRecallPort): TspComposer {
  let text = ''
  let cursor = 0
  let focused = false
  // The short-lived paste-range leases of THIS composer: the only identity
  // an asynchronous read may replace. Every real text mutation feeds it
  // BEFORE the render/application sink observes the frame.
  const pasteRanges = new PasteRangeTracker()
  /**
   * The editor-local recall navigation state (TSP I-B) — UI state, never a
   * second history authority: `-1` = editing the user's own draft, `>= 0` =
   * the index into the CURRENT `recall.entries()` snapshot the editor shows.
   * The bookmark is the draft `↑` replaced; it is dropped the moment a real
   * edit makes the recalled text ordinary content. Nothing here is persisted
   * and nothing here survives a formal scope `begin`/`reset`.
   */
  let historyIndex = -1
  let historyDraft: RecallDraftBookmark | undefined
  /** The column a consecutive ↑/↓ run wants to keep, in GRAPHEMES. */
  let preferredGraphemeColumn: number | undefined
  /** Counts every committed draft mutation, clear, programmatic replacement,
   *  scope invalidation and history-navigation commit. The admission callback
   *  below is a reentrancy boundary: a callback that moved the draft wins and
   *  this gesture is dropped. */
  let editEpoch = 0

  const state = (): TspComposerState => ({ text, cursor, focused })
  const setFocused = (next: boolean): void => { focused = next }

  /** ONE committed mutation: the epoch first, then the render trigger, so a
   *  callback the sink runs already observes the new state. */
  const commitChange = (): void => {
    editEpoch += 1
    sinks.onChanged()
  }

  /** Leave browse mode: the recalled row is now ordinary editable content. */
  const forgetRecallBookmark = (): void => {
    historyIndex = -1
    historyDraft = undefined
    preferredGraphemeColumn = undefined
  }

  /** A deliberate Left/Right/Home/End placement invalidates a bookmark no
   *  browse has claimed yet; during a browse it belongs to the browse. */
  const forgetPendingBookmark = (): void => {
    if (historyIndex < 0) historyDraft = undefined
  }

  /** A caret move to a computed boundary of the CURRENT text. */
  const setCaret = (next: number): void => {
    cursor = boundaryCursor(text, next)
    preferredGraphemeColumn = undefined
    commitChange()
  }

  /** A vertical move onto `line`, keeping the desired grapheme column. */
  const moveToColumn = (line: LogicalLine, column: number): void => {
    cursor = boundaryCursor(text, offsetAtColumn(text, line, column))
    preferredGraphemeColumn = column
    commitChange()
  }

  /** Replace the whole document with one recalled row (or the bookmark). */
  const replaceForRecall = (next: string, caret: number): void => {
    // A whole-document replacement is not the paste that made the old text:
    // the previous draft's leases retire and never come back.
    pasteRanges.reset(next)
    text = next
    cursor = boundaryCursor(next, caret)
    commitChange()
  }

  /** Apply one entry of the mount's snapshot, keeping the browse position. */
  const recallRow = (index: number, caretAtEnd: boolean): void => {
    const row = recall.entries()[index]!
    historyIndex = index
    preferredGraphemeColumn = undefined
    // The state is committed BEFORE the render the sink triggers (F2).
    replaceForRecall(row, caretAtEnd ? row.length : 0)
  }

  /** The recallable boundary reached from the user's own draft. */
  const recallEnter = (): TspComposerEdit => {
    const entries = recall.entries()
    if (entries.length === 0) {
      // No candidate was entered, so this walk's pending bookmark is already
      // stale: a later attempt records where the user is THEN.
      historyDraft = undefined
      return { kind: 'none' }
    }
    const draft = text
    const caret = cursor
    const epoch = editEpoch
    // Only the step FROM an un-browsed draft INTO the first row consults the
    // application; an empty scope consults nothing at all.
    if (!recall.admitDraft(draft)) {
      historyDraft = undefined
      return { kind: 'none' }
    }
    if (editEpoch !== epoch || text !== draft || cursor !== caret) {
      // The admission callback rewrote the draft: this gesture is dropped, and
      // the bookmark it carried describes a draft that no longer exists.
      // Keeping it would let a LATER entry restore that stale text/caret.
      historyDraft = undefined
      return { kind: 'none' }
    }
    // The bookmark was taken by the ↑ walk that began this browse (or, for a
    // caret already on the boundary, by this very key).
    historyDraft ??= { text: draft, cursor: caret }
    recallRow(0, false)
    return { kind: 'edited' }
  }

  const recallOlder = (): TspComposerEdit => {
    const next = historyIndex + 1
    if (next >= recall.entries().length) return { kind: 'none' }
    recallRow(next, false)
    return { kind: 'edited' }
  }

  const recallNewer = (): TspComposerEdit => {
    if (historyIndex > 0) {
      recallRow(historyIndex - 1, true)
      return { kind: 'edited' }
    }
    // Leaving index 0 gives back the EXACT draft and caret browsing replaced.
    // (A browse always has its bookmark: `>= 0` is set only by `recallEnter`.)
    const bookmark = historyDraft as RecallDraftBookmark
    historyIndex = -1
    historyDraft = undefined
    preferredGraphemeColumn = undefined
    replaceForRecall(bookmark.text, bookmark.cursor)
    return { kind: 'edited' }
  }

  /** One unmodified ↑/↓: the vertical caret move first, then the recall. */
  const applyArrow = (direction: 'up' | 'down'): TspComposerEdit => {
    const lines = logicalLines(text)
    const index = lineIndexOf(lines, cursor)
    const line = lines[index]!
    const wanted = preferredGraphemeColumn ?? graphemeColumn(text, line, cursor)
    if (direction === 'up') {
      // The first ↑ of an un-browsed walk owns the bookmark, so a browse that
      // began with a Home/line-up sequence gives back where the user actually
      // was — not the boundary position the walk moved them to.
      if (historyIndex < 0 && historyDraft === undefined) historyDraft = { text, cursor }
      if (index > 0) {
        moveToColumn(lines[index - 1]!, wanted)
        return { kind: 'edited' }
      }
      if (historyIndex >= 0) return recallOlder()
      if (cursor !== line.start) {
        setCaret(line.start)
        return { kind: 'edited' }
      }
      return recallEnter()
    }
    if (index < lines.length - 1) {
      moveToColumn(lines[index + 1]!, wanted)
      return { kind: 'edited' }
    }
    if (historyIndex >= 0) return recallNewer()
    if (cursor !== line.end) {
      setCaret(line.end)
      return { kind: 'edited' }
    }
    return { kind: 'none' }
  }

  /**
   * Replace the text (port mutator): the caret moves to the END of the new
   * text (boundary-aligned) and the change is committed. A replacement is not
   * an in-place edit, so keeping a stale caret would leave the restored text
   * with the caret at the OLD position — e.g. a rolled-back submission would
   * land with the caret at 0, where Backspace does nothing.
   */
  const replaceText = (next: string): void => {
    // A programmatic whole-document replacement is NOT the paste that made
    // the old text: retire every lease even when the same path bytes reappear.
    pasteRanges.reset(next)
    // An external draft write is a real write: the browse it interrupted ends
    // with it (the bookmark would restore text that no longer exists).
    forgetRecallBookmark()
    text = next
    cursor = boundaryCursor(next, next.length)
    commitChange()
  }
  /** Insert at the caret (reducer/port): normalize after any cluster merge. */
  const insert = (fragment: string): void => {
    const insertionPoint = cursor
    forgetRecallBookmark()
    text = text.slice(0, cursor) + fragment + text.slice(cursor)
    // The fragment may MERGE with the following cluster (a combining mark or
    // ZWJ suffix): the caret lands at the END of the cluster it now sits in.
    cursor = boundaryCursor(text, cursor + fragment.length)
    // The EXACT splice the composer just performed — never an inferred one.
    pasteRanges.applyEdit(
      { start: insertionPoint, oldEnd: insertionPoint, newEnd: insertionPoint + fragment.length },
      text,
    )
    commitChange()
  }

  /**
   * TSP I-C/I-D: the ONE conditional write an admitted completion is allowed to
   * make. A completion replaces a token, so neither `setDraft` (which moves the
   * caret to the END of the whole document) nor `insertIntoEditor` (which only
   * inserts) describes it. WHICH token (a command name, an `@` reference, a local
   * path argument, an inline action) is decided by the candidate seat through the
   * original classifier BEFORE it calls here — this method never re-parses the
   * draft. Every check below is a REJECTION, never a repair: on `false` the text,
   * the caret, the paste leases and the render stay exactly as they were, so a
   * stale completion is dropped without touching what the user is typing.
   */
  const applyCompletionEdit = (
    expected: { text: string; cursor: number },
    next: { text: string; cursor: number },
  ): boolean => {
    // The live document must still be the one the Provider computed its
    // replacement against — re-checked SYNCHRONOUSLY, never from a snapshot the
    // caller kept across an await.
    if (text !== expected.text || cursor !== expected.cursor) return false
    // A completion never leaves the caret inside a grapheme cluster.
    if (boundaryCursor(next.text, next.cursor) !== next.cursor) return false
    // The ONE changed span, derived from the common prefix/suffix: every byte
    // outside it is identical by construction, which is what proves no text
    // beyond the command token was rewritten.
    const shared = Math.min(expected.text.length, next.text.length)
    let start = 0
    while (start < shared && expected.text.charCodeAt(start) === next.text.charCodeAt(start)) start += 1
    let oldEnd = expected.text.length
    let newEnd = next.text.length
    while (oldEnd > start && newEnd > start
      && expected.text.charCodeAt(oldEnd - 1) === next.text.charCodeAt(newEnd - 1)) {
      oldEnd -= 1
      newEnd -= 1
    }
    // The span must stay INSIDE one logical line and must never split a CRLF
    // cluster: a completion replaces a command name, not the document's shape.
    const spanCrossesLine = (source: string, from: number, to: number): boolean => {
      if (source.slice(from, to).includes('\n')) return true
      if (source.charCodeAt(from) === 0x0a && source.charCodeAt(from - 1) === 0x0d) return true
      return source.charCodeAt(to - 1) === 0x0d && source.charCodeAt(to) === 0x0a
    }
    if (spanCrossesLine(expected.text, start, oldEnd) || spanCrossesLine(next.text, start, newEnd)) return false
    // The caret the Provider asked for must belong to the COMPLETED LINE. It is
    // not confined to the minimal diff span: the command-name rule appends one
    // separator space, and when the document already held a space there the
    // minimal span shrinks past it — the Provider's own landing spot is then one
    // unit beyond `newEnd`. Requiring the minimal span would silently swallow
    // those accepts; requiring the line keeps the real invariant (a completion
    // never parks the caret on another line or outside the token it wrote).
    let lineEnd = start
    while (lineEnd < next.text.length && next.text.charCodeAt(lineEnd) !== 0x0a) lineEnd += 1
    if (next.cursor < start || next.cursor > lineEnd) return false
    // The splice is EXACTLY known, so every OTHER paste lease follows it through
    // the tracker (never a re-derivation from path text), and the ↑/↓ browse this
    // draft may have come from is retired with it: a recalled row is ordinary
    // content now.
    forgetRecallBookmark()
    pasteRanges.applyEdit({ start, oldEnd, newEnd }, next.text)
    text = next.text
    cursor = next.cursor
    commitChange()
    return true
  }

  /**
   * TSP I-D: the current edit revision — the SAME counter `commitChange` bumps
   * for every committed mutation, `clearDraftStateOnly` and
   * `invalidateRecallNavigation` (every formal scope invalidation). An async
   * intake compares it to prove that NOTHING has moved the draft since its
   * accept; text equality alone cannot tell "the user kept the draft" from
   * "edit → backspace → retype" (an A→B→A walk over the same bytes).
   */
  const editRevision = (): number => editEpoch

  /**
   * TSP I-D: replace ONE accepted inline attachment fragment with its canonical
   * placeholder — the atomic in-place edit the inline intake commits through.
   * It is deliberately NOT `applyCompletionEdit` (whose minimal-diff model
   * cannot express a caret the user already moved on) and NOT `setDraft` (which
   * rebuilds the whole document and would retire every unrelated paste lease).
   * Every check below is a REJECTION: on `false` the text, the caret, the paste
   * leases, the browse state and the render stay exactly as they were.
   */
  const replaceInlineAttachmentFragment = (
    expected: { text: string; cursor: number; editRevision: number },
    span: InlineAttachmentSpan,
    placeholder: string,
  ): boolean => {
    // The document, the caret AND the revision must still be the accepted ones,
    // re-read SYNCHRONOUSLY here (the intake may have taken any amount of time).
    if (text !== expected.text || cursor !== expected.cursor || editEpoch !== expected.editRevision) return false
    // The span is the acceptance's own half-open range in the `\n`-split line
    // model, so the flat offsets accumulate every earlier line PLUS its one
    // newline — never the composer's CR-trimmed display-line model.
    const lines = text.split('\n')
    const line = lines[span.line]
    if (line === undefined) return false
    if (span.start < 0 || span.end <= span.start || span.end > line.length) return false
    let lineStart = 0
    for (let index = 0; index < span.line; index += 1) lineStart += (lines[index]?.length ?? 0) + 1
    const flatStart = lineStart + span.start
    const flatEnd = lineStart + span.end
    const fragment = text.slice(flatStart, flatEnd)
    // The fragment lives inside ONE `\n`-split line (the bounds above already
    // reject anything past that line), so it can only carry a line break as the
    // lone CR of a CRLF-terminated line — and half a CRLF cluster is never
    // replaced.
    if (fragment.includes('\r')) return false
    // Neither endpoint may sit inside a grapheme cluster (an emoji or a combined
    // name is one unit; cutting it would strand a lone surrogate).
    if (boundaryCursor(text, flatStart) !== flatStart || boundaryCursor(text, flatEnd) !== flatEnd) return false
    const next = `${text.slice(0, flatStart)}${placeholder}${text.slice(flatEnd)}`
    // The caret lands right AFTER the placeholder (normalized like every other
    // mutation here, so the invariant holds even when the fragment's following
    // cluster merged with what replaced it).
    const nextCursor = boundaryCursor(next, flatStart + placeholder.length)
    // The splice is EXACTLY known: every OTHER paste lease follows it through
    // the tracker, and the ↑/↓ browse this draft may have come from retires.
    pasteRanges.applyEdit(
      { start: flatStart, oldEnd: flatEnd, newEnd: flatStart + placeholder.length },
      next,
    )
    forgetRecallBookmark()
    text = next
    cursor = nextCursor
    commitChange()
    return true
  }

  return {
    state,
    setFocused,
    getDraft: () => text,
    setDraft: replaceText,
    setEditorText: replaceText,
    insertIntoEditor: insert,
    applyCompletionEdit,
    editRevision,
    replaceInlineAttachmentFragment,
    clearDraftStateOnly: () => {
      // PR3-B §7.3 (B2 F1): PURE STATE — no `onChanged`, no render. See the
      // interface doc; the next committed frame carries the emptied editor.
      pasteRanges.reset('')
      // A cleared draft has no browse to return to: the bookmark dies with it
      // (restoring a recalled row into a session that no longer owns the
      // draft would be a cross-owner write).
      forgetRecallBookmark()
      text = ''
      cursor = 0
      editEpoch += 1
    },
    invalidateRecallNavigation: () => {
      // TSP I-B: a formal scope `begin`/`reset` retires THIS browse and only
      // this browse. Pure state: the text and caret stay exactly as the mount
      // shows them, and the frame the caller commits anyway carries the right
      // content — a second repaint here would flicker the seat.
      historyIndex = -1
      historyDraft = undefined
      preferredGraphemeColumn = undefined
      editEpoch += 1
    },
    registerPastedPathSpan: (span) => pasteRanges.add(span),
    hasLivePath: (id, path) => pasteRanges.live(id)?.expected === path,
    replacePastedPathOccurrence: (id, path, placeholder) => {
      const span = pasteRanges.live(id)
      if (span === undefined || span.expected !== path) return false
      if (text.slice(span.start, span.end) !== path) {
        pasteRanges.retire(id)
        return false
      }
      // The caret keeps its position RELATIVE to the surrounding text; a
      // caret inside the token lands after the placeholder.
      let nextCursor = cursor
      if (cursor >= span.end) nextCursor += placeholder.length - path.length
      else if (cursor > span.start) nextCursor = span.start + placeholder.length
      const next = text.slice(0, span.start) + placeholder + text.slice(span.end)
      // The replacement is ONE known splice: apply it to every lease, then
      // retire this one (a replacement never keeps its own identity).
      pasteRanges.applyEdit(
        { start: span.start, oldEnd: span.end, newEnd: span.start + placeholder.length },
        next,
      )
      pasteRanges.retire(id)
      text = next
      cursor = boundaryCursor(next, nextCursor)
      commitChange()
      return true
    },
    notify: (message, kind) => sinks.notify(message, kind),
    setSubmitPending: detail => sinks.setSubmitPending(detail),
    clearSettledLocalMessages() {
      // B1: the TSP renderer has no local-card set yet. The dock's transient
      // notices are a DIFFERENT state (the B0 external-review P3-1 ruling),
      // so this is a deliberate no-op rather than clearing them; the real
      // settled-card semantics arrive with the B1+/PR4 local-card surface.
    },
    applyKey(key) {
      // ── The fixed §3.4 editor-local reducer order ──
      // (The caller owns the higher precedence: disposal and modal ownership
      // are checked BEFORE the key reaches this reducer.)
      // Ctrl+D: exit ONLY on an empty draft; with text it is an editor no-op
      // (never a quit — the PR3-A read-only `q` quit retired with the editor).
      if (key.ctrl === true && key.name === 'd') {
        return text === '' ? { kind: 'exit-empty' } : { kind: 'none' }
      }
      // Enter family: Shift inserts a newline; Ctrl is the accelerated
      // gesture; bare Enter is the plain submit gesture. Alt/Meta Enter is
      // not a submission gesture in B (ignored like other unknown chords).
      if (key.name === 'enter') {
        if (key.shift === true) {
          insert('\n')
          return { kind: 'edited' }
        }
        if (key.ctrl === true) return { kind: 'submit', gesture: 'accelerated' }
        if (key.alt === true || key.meta === true) return { kind: 'none' }
        return { kind: 'submit', gesture: 'enter' }
      }
      // Bracketed paste: ONE atomic edit; embedded newlines, slashes and
      // Enter bytes are CONTENT — never separate dispatches.
      if (key.name === 'paste') {
        const fragment = key.text ?? ''
        if (fragment === '') return { kind: 'none' }
        insert(fragment)
        return { kind: 'edited' }
      }
      // Movement/deletion at grapheme boundaries (never a surrogate split).
      switch (key.name) {
        case 'backspace': {
          if (cursor === 0) return { kind: 'none' }
          // Both endpoints cluster-aligned: the cut start is the previous
          // cluster's start; the cut end is the (aligned) caret itself.
          const start = previousGraphemeStart(text, cursor)
          const caret = cursor
          forgetRecallBookmark()
          text = text.slice(0, start) + text.slice(cursor)
          // The deletion may MERGE the clusters on both sides of the cut
          // (removing a separator between two regional indicators fuses them
          // into ONE flag cluster): re-normalize the caret onto the new
          // boundary so it can never sit inside the merged cluster.
          cursor = boundaryCursor(text, start)
          pasteRanges.applyEdit({ start, oldEnd: caret, newEnd: start }, text)
          commitChange()
          return { kind: 'edited' }
        }
        case 'delete': {
          if (cursor >= text.length) return { kind: 'none' }
          const cutStart = cursor
          const end = nextGraphemeEnd(text, cursor)
          forgetRecallBookmark()
          text = text.slice(0, cursor) + text.slice(end)
          // Same merge-after-cut hazard as backspace (the clusters around the
          // removed one may fuse): keep the caret boundary-aligned.
          cursor = boundaryCursor(text, cursor)
          pasteRanges.applyEdit({ start: cutStart, oldEnd: end, newEnd: cutStart }, text)
          commitChange()
          return { kind: 'edited' }
        }
        case 'left': {
          if (cursor === 0) return { kind: 'none' }
          forgetPendingBookmark()
          setCaret(previousGraphemeStart(text, cursor))
          return { kind: 'edited' }
        }
        case 'right': {
          if (cursor >= text.length) return { kind: 'none' }
          forgetPendingBookmark()
          setCaret(nextGraphemeEnd(text, cursor))
          return { kind: 'edited' }
        }
        case 'home': {
          if (cursor === 0) return { kind: 'none' }
          // The start of the line containing the caret (multi-line draft).
          // Normalize the result: a CRLF pair is ONE grapheme cluster, and
          // the line start must never sit between its CR and LF.
          const rawStart = text.lastIndexOf('\n', cursor - 1) + 1
          if (boundaryCursor(text, rawStart) === cursor) return { kind: 'none' }
          forgetPendingBookmark()
          setCaret(rawStart)
          return { kind: 'edited' }
        }
        case 'end': {
          // The end of the line containing the caret — BEFORE a complete
          // CRLF pair: the pair is ONE grapheme cluster, so the line end is
          // at the CR, never at the LF position indexOf('\n') reports
          // (that would sit INSIDE the cluster and let a backspace split
          // it). Normalize the computed end onto a cluster boundary.
          const nextNewline = text.indexOf('\n', cursor)
          let lineEnd = nextNewline === -1 ? text.length : nextNewline
          if (lineEnd > 0 && text.charCodeAt(lineEnd - 1) === 0x0d) lineEnd -= 1
          if (boundaryCursor(text, lineEnd) === cursor) return { kind: 'none' }
          forgetPendingBookmark()
          setCaret(lineEnd)
          return { kind: 'edited' }
        }
        case 'up':
        case 'down': {
          // TSP I-B: unmodified ↑/↓ only. A modified arrow keeps whatever it
          // means today (the existing app/plugin gesture, or a no-op) and is
          // never routed through the recall.
          if (key.ctrl === true || key.alt === true || key.shift === true || key.meta === true) break
          return applyArrow(key.name === 'up' ? 'up' : 'down')
        }
        default:
          break
      }
      // Printable text inserts at the caret (the SDK already decoded CJK,
      // emoji and composed characters into `key.text`).
      if (key.text !== undefined && key.text !== '' && key.ctrl === false && key.alt === false && key.meta === false) {
        insert(key.text)
        return { kind: 'edited' }
      }
      // Unknown control keys are ignored, never emitted as literal escapes.
      return { kind: 'none' }
    },
  }
}

/** The TSP composer object (the §3.4 surface: state + editor port + reducer). */
export interface TspComposer {
  /** The controlled-editor state (read for each dock render). */
  state(): TspComposerState
  /** The terminal focus fact (set after the first dock render / modal close). */
  setFocused(focused: boolean): void
  // ── The SubmissionComposerPort-shaped members (the port adapter in
  //    session.ts delegates here) ──
  getDraft(): string
  setDraft(text: string): void
  setEditorText(text: string): void
  insertIntoEditor(text: string): void
  /**
   * TSP I-C/I-D: replace the document edit ONE accepted completion produced,
   * atomically and only while the document still matches `expected` exactly. The
   * caret lands where the Provider put it — inside the completed line, keeping
   * the indentation and the text after the caret — and is never forced to the end
   * of the draft the way `setDraft` does. Every other paste lease follows the exact
   * splice, the ↑/↓ browse bookmark is retired, and `onChanged` fires exactly
   * once on success.
   *
   * WHICH span a completion may rewrite is not this method's decision: the ONE
   * candidate seat (`tui/tsp/input-completion.ts`) admits the edit against the
   * original file-completion classifier before it ever calls here.
   *
   * Returns `false` — touching NOTHING, no text, no caret, no lease, no render —
   * when the live document/cursor moved, when the caret is not a grapheme
   * boundary, when the change is not confined to one logical line, or when the
   * requested caret does not sit inside the line the completion wrote. A
   * rejected completion is how a stale async result or a foreign edit is refused;
   * the caller never re-applies it and never submits anything because of it.
   */
  applyCompletionEdit(
    expected: { text: string; cursor: number },
    next: { text: string; cursor: number },
  ): boolean
  /**
   * TSP I-D: the current edit revision — the counter every committed mutation,
   * draft clear and formal scope invalidation bumps. An async inline intake
   * compares it to prove nothing moved the draft since its accept; text equality
   * alone cannot tell "nothing happened" from an A→B→A edit walk.
   */
  editRevision(): number
  /**
   * TSP I-D: replace ONE accepted inline attachment fragment (a half-open span in
   * the `\n`-split line model, imported from the attachment grammar that produced
   * it) with its canonical placeholder — ONE atomic edit, ONE `onChanged`, the
   * caret right after the placeholder, every OTHER paste lease carried through
   * the exact splice.
   *
   * Returns `false` and changes NOTHING when the live document, caret or revision
   * moved away from `expected`, when the span is not a legal non-empty range of
   * the current line, when the fragment carries a line break or a lone CR/LF (a
   * CRLF cluster is never split), or when an endpoint falls inside a grapheme
   * cluster. A refused fragment leaves the user's own path text editable — the
   * placeholder of a stale intake never lands in a newer draft.
   */
  replaceInlineAttachmentFragment(
    expected: { readonly text: string; readonly cursor: number; readonly editRevision: number },
    span: InlineAttachmentSpan,
    placeholder: string,
  ): boolean
  notify(message: string, kind?: 'info' | 'error'): void
  setSubmitPending(detail: SubmitPendingDetail | undefined): void
  clearSettledLocalMessages(): void
  /**
   * PR3-B §7.3 (B2 F1, publication atomicity): clear the draft's STATE
   * without rendering. The session-lifecycle authority calls this INSIDE
   * the synchronous publication block, where a throwing render IO would
   * turn a committed-adjacent clear into a pre-publication failure with the
   * draft already lost — so this path must be pure state assignment. The
   * emptied editor rides the NEXT frame the renderer commits anyway (B's
   * hydration repaint); the hydration input fence keeps the window
   * un-editable, so the outgoing text is never submittable meanwhile.
   */
  clearDraftStateOnly(): void
  /**
   * TSP I-B: retire the ↑/↓ browse state (the browse index, its draft
   * bookmark and the kept column) WITHOUT touching the text, the caret or the
   * render. The application's formal history-scope owners (`beginInputHistoryScope`
   * / `resetInputHistory`) call it at their synchronous commit, so a recalled
   * row of a Session that is no longer current can never be walked back into a
   * newer Session's composer. The frame those commits trigger anyway carries
   * the correct content.
   */
  invalidateRecallNavigation(): void
  /**
   * Register the proven raw span of ONE completed bracketed paste. Returns
   * the lease id, or undefined when the current document does not hold those
   * bytes (the caller must not claim the paste).
   */
  registerPastedPathSpan(span: PasteRangeSpan): number | undefined
  /** Whether lease `id` still holds exactly `path`. */
  hasLivePath(id: number, path: string): boolean
  /**
   * Replace ONE live pasted-path span with the canonical image placeholder —
   * ONE atomic edit, ONE `onChanged`. A retired/replaced span returns false
   * and never touches another occurrence of the same path.
   */
  replacePastedPathOccurrence(id: number, path: string, placeholder: string): boolean
  /** Apply ONE decoded SDK key through the fixed editor-local reducer. */
  applyKey(key: Key): TspComposerEdit
}
