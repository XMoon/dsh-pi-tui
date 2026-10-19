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
 * Create the TSP composer. The sinks surface both the render trigger and the
 * application's composer-port facts onto the renderer's own presentation.
 */
export function createTspComposer(sinks: TspComposerSinks): TspComposer {
  let text = ''
  let cursor = 0
  let focused = false

  const state = (): TspComposerState => ({ text, cursor, focused })
  const setFocused = (next: boolean): void => { focused = next }

  /**
   * Replace the text (port mutator): the caret moves to the END of the new
   * text (boundary-aligned) and the change is committed. A replacement is not
   * an in-place edit, so keeping a stale caret would leave the restored text
   * with the caret at the OLD position — e.g. a rolled-back submission would
   * land with the caret at 0, where Backspace does nothing.
   */
  const replaceText = (next: string): void => {
    text = next
    cursor = boundaryCursor(next, next.length)
    sinks.onChanged()
  }
  /** Insert at the caret (reducer/port): normalize after any cluster merge. */
  const insert = (fragment: string): void => {
    text = text.slice(0, cursor) + fragment + text.slice(cursor)
    // The fragment may MERGE with the following cluster (a combining mark or
    // ZWJ suffix): the caret lands at the END of the cluster it now sits in.
    cursor = boundaryCursor(text, cursor + fragment.length)
    sinks.onChanged()
  }

  return {
    state,
    setFocused,
    getDraft: () => text,
    setDraft: replaceText,
    setEditorText: replaceText,
    insertIntoEditor: insert,
    clearDraftStateOnly: () => {
      // PR3-B §7.3 (B2 F1): PURE STATE — no `onChanged`, no render. See the
      // interface doc; the next committed frame carries the emptied editor.
      text = ''
      cursor = 0
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
          text = text.slice(0, start) + text.slice(cursor)
          // The deletion may MERGE the clusters on both sides of the cut
          // (removing a separator between two regional indicators fuses them
          // into ONE flag cluster): re-normalize the caret onto the new
          // boundary so it can never sit inside the merged cluster.
          cursor = boundaryCursor(text, start)
          sinks.onChanged()
          return { kind: 'edited' }
        }
        case 'delete': {
          if (cursor >= text.length) return { kind: 'none' }
          const end = nextGraphemeEnd(text, cursor)
          text = text.slice(0, cursor) + text.slice(end)
          // Same merge-after-cut hazard as backspace (the clusters around the
          // removed one may fuse): keep the caret boundary-aligned.
          cursor = boundaryCursor(text, cursor)
          sinks.onChanged()
          return { kind: 'edited' }
        }
        case 'left': {
          if (cursor === 0) return { kind: 'none' }
          cursor = previousGraphemeStart(text, cursor)
          sinks.onChanged()
          return { kind: 'edited' }
        }
        case 'right': {
          if (cursor >= text.length) return { kind: 'none' }
          cursor = nextGraphemeEnd(text, cursor)
          sinks.onChanged()
          return { kind: 'edited' }
        }
        case 'home': {
          if (cursor === 0) return { kind: 'none' }
          // The start of the line containing the caret (multi-line draft).
          // Normalize the result: a CRLF pair is ONE grapheme cluster, and
          // the line start must never sit between its CR and LF.
          const rawStart = text.lastIndexOf('\n', cursor - 1) + 1
          const next = boundaryCursor(text, rawStart)
          if (next === cursor) return { kind: 'none' }
          cursor = next
          sinks.onChanged()
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
          const next = boundaryCursor(text, lineEnd)
          if (next === cursor) return { kind: 'none' }
          cursor = next
          sinks.onChanged()
          return { kind: 'edited' }
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
  /** Apply ONE decoded SDK key through the fixed editor-local reducer. */
  applyKey(key: Key): TspComposerEdit
}
