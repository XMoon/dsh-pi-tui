/**
 * The Split/Daemon Client process's bounded input-recall memory (Feature
 * History PR2-A).
 *
 * ONE instance is created by `startSurfaceLocalClient` OUTSIDE its surface
 * revision loop and injected BY IDENTITY into every revision's PiTui and TSP
 * renderer, so ↑/↓ recalls the inputs of the CURRENT OS process across
 * Session/cwd/reconnect/same-PID HMR, and a fresh process starts empty.
 *
 * It is deliberately NOT a persistence, Session, cwd or acceptance owner: the
 * existing `InputHistory` writer still owns the JSONL rows and the old Ctrl+R
 * search, and each renderer keeps its own short-lived browse/draft state. This
 * module only answers "the most recent eligible inputs of this Client root".
 *
 * The normalization matches the editor mirror and the Direct kernel it
 * replaces for this backend: trim, skip an empty input, collapse CONSECUTIVE
 * duplicates (a non-consecutive repeat is legal history), newest first, and
 * the shared cap ({@link INPUT_RECALL_LIMIT}).
 *
 * @module @xmoon76/dsh-pi-tui/client/history/memory-recall
 */

import { INPUT_RECALL_LIMIT } from './recall-scope.ts'

/** The ONE process-lifetime recall capability injected into each renderer. */
export interface InputMemoryRecall {
  /** Newest-first defensive snapshot; callers cannot mutate the store. */
  snapshot(): readonly string[]
  /** Record one already-admitted main-Composer input (blank is ignored). */
  remember(text: string): void
}

/** Create ONE process-lifetime recall memory. */
export function createInputMemoryRecall(): InputMemoryRecall {
  /** Newest first — the projection each renderer mirrors or reads. */
  const entries: string[] = []
  return {
    snapshot: () => [...entries],
    remember: (text: string): void => {
      const trimmed = text.trim()
      if (trimmed === '') return
      // The editor's own `addToHistory` collapses consecutive duplicates; the
      // process owner must answer the same projection, so the same rule.
      if (entries[0] === trimmed) return
      entries.unshift(trimmed)
      if (entries.length > INPUT_RECALL_LIMIT) entries.pop()
    },
  }
}
