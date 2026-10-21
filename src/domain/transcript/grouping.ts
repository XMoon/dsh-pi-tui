/**
 * Canonical read-grouping and recent-turn semantics (TS7).
 *
 * `isGroupableRead` is the ONE grouping eligibility authority: a settled-ok
 * `read` card that is not post-turn replay evidence. The stateful folder's
 * incremental grouping and the exported one-shot mirror
 * (`groupConsecutiveReads`) both delegate here, so a replay row can never be
 * laundered into an aggregate through a synthesized group card.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/grouping
 */

import { isPostTurnReplayEvidence } from './semantics.ts'
import type { TranscriptMessage } from './types.ts'

/**
 * The turn threshold at or above which entries count as "recent": the
 * `recentTurns` most recent distinct turns among the given message kinds.
 * Shared by the display window (all kinds), the markdown view, and the
 * Ctrl+O expansion boundary (foldable kinds only).
 * @param messages - the folded transcript.
 * @param recentTurns - how many most-recent turns survive; <= 0 keeps nothing.
 * @param kinds - kinds whose turns count; undefined counts every kind.
 * @returns the oldest recent turn number; 0 when everything is recent;
 *   `Infinity` when nothing is (every entry folds).
 */
export function recentTurnThreshold(
  messages: readonly TranscriptMessage[],
  recentTurns: number,
  kinds?: readonly TranscriptMessage['kind'][],
): number {
  if (recentTurns <= 0) return Number.POSITIVE_INFINITY
  const turns = new Set<number>()
  for (const message of messages) {
    if (message.kind === 'summary' || !('turn' in message)) continue
    if (kinds === undefined || kinds.includes(message.kind)) turns.add(message.turn)
  }
  const sorted = [...turns].sort((a, b) => b - a)
  if (sorted.length <= recentTurns) return 0
  return sorted[recentTurns - 1] ?? 0
}
/**
 * Whether one row may join a consecutive-read group: a settled-ok `read`
 * card that is NOT post-turn replay evidence. This is the ONE grouping
 * eligibility authority — the stateful folder (`TranscriptFolder.groupable`)
 * and the exported mirror (`groupConsecutiveReads`) both delegate here, so a
 * replay row can never be laundered into an aggregate through a synthesized
 * group card (which is a fresh object the replay sidecar does not cover).
 */
export function isGroupableRead(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'tool' }> {
  return message.kind === 'tool' && message.name === 'read' && message.status === 'ok'
    && !isPostTurnReplayEvidence(message)
}
/**
 * Merge consecutive completed `read` tool cards into one card ("N files").
 * A single read stays untouched; groups break on any other kind or status,
 * on post-turn replay evidence, AND on a turn boundary — a group never
 * crosses turns, so every Activity span's own facts (count, timing) stay
 * attributable to the turn that renders the card (post-F6 plan
 * §10.2/§12.11).
 * @param messages - the folded transcript.
 * @returns a new list with grouped read cards (same object references).
 */
export function groupConsecutiveReads(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  let group: Extract<TranscriptMessage, { kind: 'tool' }> | undefined
  let count = 0
  for (const message of messages) {
    const groupable = isGroupableRead(message)
      && (group === undefined || group.turn === message.turn)
    if (groupable) {
      if (group !== undefined) {
        count += 1
        group.args = `${count} files`
        group.result = group.result === '' ? message.result : `${group.result}\n\n${message.result}`
        // The mirror carries the same genuine-call cardinality as the
        // folder's makeReadGroup card: a merged group is still that many
        // model tool calls (a plain card is one by definition).
        group.callCount = (group.callCount ?? 1) + (message.callCount ?? 1)
        continue
      }
      group = { ...message }
      count = 1
      out.push(group)
      continue
    }
    group = undefined
    out.push(message)
  }
  return out
}
