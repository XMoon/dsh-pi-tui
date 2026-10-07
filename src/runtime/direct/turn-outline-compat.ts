/**
 * The Direct compatibility turn-outline fold (M3-4 PR4 §18.4 / TS8-E): map the
 * exact attached Direct Session's full in-process snapshot onto the official
 * `turnOutline` entry shape, so the shared rewind picker owner keeps ONE
 * contract (`SessionReader.turnOutline`) on minimal Direct compositions that
 * mount no `session-turn-outline` projection unit.
 *
 * This is a Direct-only adapter: it consumes the neutral rewind helpers from
 * `domain/session/rewind.ts`. The Remote branch NEVER uses this fold
 * (projection-only, fail-closed) and must not import this module.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/turn-outline-compat
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isEmptyMessage, isHumanTurnMessage, singleLinePreview } from '../../domain/session/rewind.ts'
import { textOf } from '../../domain/transcript/folder.ts'

/**
 * The fold mirrors the official projection's shape rules: every STARTED
 * turn becomes an entry (a non-advancing `turn/start` is ignored),
 * each turn's prompt is its FIRST non-empty direct human message's preview,
 * and later human messages in the same turn keep the first preview. The
 * first entry is included so the shared row builder's position-based
 * "no predecessor boundary" exclusion sees the SAME data shape the
 * official projection produces.
 * @param events - the exact attachment's full session snapshot.
 * @returns the ascending outline entries (response previews stay empty —
 *  the picker never renders them).
 */
export function directTurnOutlineCompat(events: readonly SessionEvent[]): Array<{ turn: number; seq: number; prompt: string; response: string }> {
  const entries: Array<{ turn: number; seq: number; prompt: string; response: string }> = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      const last = entries.at(-1)
      if (last !== undefined && event.data.turn <= last.turn) continue
      entries.push({ turn: event.data.turn, seq: Number(event.seq), prompt: '', response: '' })
      continue
    }
    if (event.type === 'user/message') {
      const last = entries.at(-1)
      if (last === undefined || last.prompt !== '') continue
      if (!isHumanTurnMessage(event)) continue
      if (isEmptyMessage(event.data.content)) continue
      last.prompt = singleLinePreview(textOf(event.data.content))
    }
  }
  return entries
}
