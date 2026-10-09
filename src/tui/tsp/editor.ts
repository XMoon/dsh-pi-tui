/**
 * TspComposer (PR3-B §3.4): the TSP renderer's ONE program-owned composer.
 *
 * State is `{ text, cursor, focused }`; `cursor` is in **UTF-16 code units**
 * (the SDK `ui.editor` contract). All edits move through {@link TspComposer.applyKey}
 * — the renderer's single input path — which never splits surrogate pairs or
 * grapheme clusters (movement/caret edits use `Intl.Segmenter`, available on
 * Node 24).
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

/**
 * The UTF-16 offset where the grapheme cluster immediately LEFT of `cursor`
 * begins — the destination of a caret-left / the cut start of a backspace.
 * A cursor inside a cluster (only possible via a bad clamp) still consumes
 * that whole cluster. Never splits a surrogate pair or a ZWJ sequence.
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
 * the destination of a caret-right / the cut end of a delete. A cursor
 * already at the text end stays there.
 */
function nextGraphemeEnd(text: string, cursor: number): number {
  for (const { index, segment } of segmenter.segment(text)) {
    const end = index + segment.length
    if (end > cursor) return end
  }
  return text.length
}

/** Clamp a caret candidate into `[0, text.length]`. */
function clampCursor(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor))
}

/**
 * Create the TSP composer. The sinks surface the application's composer-port
 * facts onto the renderer's own presentation (the dock); the composer derives
 * no queue/submit state of its own.
 */
export function createTspComposer(sinks: {
  /** The sink for the pending-row fact ('submit'/'queued'/undefined clears). */
  readonly setSubmitPending: (detail: SubmitPendingDetail | undefined) => void
  /** The sink for transient notices. */
  readonly notify: (text: string, kind?: 'info' | 'error') => void
}): TspComposer {
  let text = ''
  let cursor = 0
  let focused = false

  /** The controlled-editor props state (UTF-16 cursor, SDK contract). */
  const state = (): TspComposerState => ({ text, cursor, focused })
  const setFocused = (next: boolean): void => { focused = next }
  const insert = (fragment: string): void => {
    text = text.slice(0, cursor) + fragment + text.slice(cursor)
    cursor += fragment.length
  }

  return {
    state,
    setFocused,
    getDraft: () => text,
    setDraft(next) {
      text = next
      cursor = clampCursor(next, cursor)
    },
    setEditorText(next) {
      text = next
      cursor = clampCursor(next, cursor)
    },
    insertIntoEditor: insert,
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
          const start = previousGraphemeStart(text, cursor)
          text = text.slice(0, start) + text.slice(cursor)
          cursor = start
          return { kind: 'edited' }
        }
        case 'delete': {
          if (cursor >= text.length) return { kind: 'none' }
          const end = nextGraphemeEnd(text, cursor)
          text = text.slice(0, cursor) + text.slice(end)
          return { kind: 'edited' }
        }
        case 'left': {
          if (cursor === 0) return { kind: 'none' }
          cursor = previousGraphemeStart(text, cursor)
          return { kind: 'edited' }
        }
        case 'right': {
          if (cursor >= text.length) return { kind: 'none' }
          cursor = nextGraphemeEnd(text, cursor)
          return { kind: 'edited' }
        }
        case 'home': {
          if (cursor === 0) return { kind: 'none' }
          // The start of the line containing the caret (multi-line draft).
          const lineStart = text.lastIndexOf('\n', cursor - 1) + 1
          cursor = lineStart
          return { kind: 'edited' }
        }
        case 'end': {
          // The end of the line containing the caret (before a newline).
          const nextNewline = text.indexOf('\n', cursor)
          const lineEnd = nextNewline === -1 ? text.length : nextNewline
          if (cursor === lineEnd) return { kind: 'none' }
          cursor = lineEnd
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
  /** Apply ONE decoded SDK key through the fixed editor-local reducer. */
  applyKey(key: Key): TspComposerEdit
}
