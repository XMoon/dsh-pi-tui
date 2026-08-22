/**
 * Conversation rewind: session events → safe rewind points.
 *
 * Rewind is implemented as a FORK (see temp/fork_rewind.md): the user picks
 * an earlier completed user turn, and a new child session is created whose
 * seed is the event prefix BEFORE that turn's `turn/start`. The original
 * session is never modified, truncated or deleted.
 *
 * This module is PURE: it only maps the event log onto the rewind model —
 * no persistence, no agent creation, no side effects — so the whole model
 * is unit-testable without a runner (R01–R09 in the plan).
 *
 * Human-turn identification reuses the SAME classification the transcript
 * uses (`source.kind === 'user'`): injected context, skill bodies, system
 * reminders and goal continuations never become rewind rows, and one turn
 * yields at most ONE candidate (its primary human prompt; steers inside the
 * same turn do not form separate rewind points).
 * @module @xmoon76/dsh-pi-tui/rewind
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { textOf } from './transcript.ts'
import type { PickerItem } from './tui-app.ts'

/** One rewindable user turn. */
export interface RewindCandidate {
  /** The `turn/start` event's seq — the rewind boundary marker. */
  turnStartSeq: number
  /** The turn number (`turn/start` data), for the picker row. */
  turn: number
  /** The primary human message's seq (first non-empty direct user input). */
  messageSeq: number
  /** The text restored into the editor after the rewind (text blocks
   * only — non-text content is never silently re-staged). */
  editorText: string
  /** One-line, width-bounded preview for the picker row. */
  preview: string
  /** Whether the selected prompt contains non-text content (image blocks):
   * the rewind still forks, the editor gets the text part only, and the UI
   * must warn that attachments were not re-staged. */
  hasNonTextContent: boolean
}

/** The stale-selection cancellation: the source session no longer owns the
 * surface, so the pending rewind must not commit (or must dispose its
 * already-created child). */
export class RewindStaleError extends Error {
  constructor() {
    super('session changed — rewind cancelled')
    this.name = 'RewindStaleError'
  }
}

/** Whether one user/message event is a DIRECT human prompt (the transcript's
 * classification: `source.kind === 'user'`). Injected context, skill bodies,
 * system reminders and goal continuations answer false. The single helper
 * every rewind consumer must use — never scatter source-kind checks. */
export function isHumanTurnMessage(event: SessionEvent<'user/message'>): boolean {
  return event.data.source.kind === 'user'
}

/** Whether a message is empty for rewind purposes: no text and no image —
 * mirror of the transcript's empty-user-message rule. */
function isEmptyMessage(blocks: readonly ContentBlock[]): boolean {
  return textOf(blocks) === '' && !blocks.some(block => block.type === 'image')
}

/** One-line, width-bounded preview of a prompt (whitespace collapsed). */
function singleLinePreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat
}

/**
 * Derive the rewind candidates from a session's event log.
 *
 * Guarantees (plan §6.1):
 * - only COMPLETED turns (a `turn/end` closed the span) are listed; the
 *   open turn is never a candidate;
 * - newest turn first;
 * - one candidate per turn (the turn's primary — first non-empty human
 *   `user/message`); injected/steer messages never form extra rows;
 * - a malformed span (a new `turn/start` while one is open, an end without
 *   a start) is skipped, never thrown to the UI;
 * - the first turn is a legal candidate (seed length 0);
 * - no persistence, no side effects, no agent creation.
 * @param events - the session log (chronological).
 * @returns candidates newest-first.
 */
export function collectRewindCandidates(events: readonly SessionEvent[]): readonly RewindCandidate[] {
  const candidates: RewindCandidate[] = []
  let open: { turn: number; startSeq: number; primary?: { seq: number; blocks: readonly ContentBlock[] } } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      // A new turn while one is open: the previous span never closed
      // (malformed log) — drop it and start fresh.
      open = { turn: event.data.turn, startSeq: event.seq }
    } else if (event.type === 'turn/end') {
      const primary = open?.primary
      if (primary !== undefined) {
        const blocks = primary.blocks
        candidates.push({
          turnStartSeq: open!.startSeq,
          turn: open!.turn,
          messageSeq: primary.seq,
          editorText: textOf(blocks),
          preview: singleLinePreview(textOf(blocks)),
          hasNonTextContent: blocks.some(block => block.type !== 'text'),
        })
      }
      open = undefined
    } else if (event.type === 'user/message' && open !== undefined && open.primary === undefined) {
      const blocks = event.data.content
      if (isHumanTurnMessage(event) && !isEmptyMessage(blocks)) {
        open.primary = { seq: event.seq, blocks }
      }
    }
  }
  return candidates.reverse()
}

/**
 * The seed for one candidate: EVERY event before the selected `turn/start`
 * — including log-only state events between turns (a `todo/write`, a
 * `permission/preset` record) — but never the `turn/start` itself.
 * @param events - the session log the candidate was collected from.
 * @param candidate - the selected rewind point.
 * @returns the child session's seed events.
 * @throws when the point no longer exists, or when the seed would end on
 *   an OPEN `turn/start` (malformed log — the fork boundary must be a
 *   completed turn).
 */
export function rewindSeed(events: readonly SessionEvent[], candidate: RewindCandidate): readonly SessionEvent[] {
  const index = events.findIndex(event => event.seq === candidate.turnStartSeq && event.type === 'turn/start')
  if (index < 0) throw new Error('rewind point no longer exists')
  const seed = events.slice(0, index)
  // Defensive invariant: the last turn boundary in the seed must be a
  // `turn/end` (or absent) — never a `turn/start` (the underlying fork
  // boundary validation rejects an open turn).
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    const type = seed[i]?.type
    if (type === 'turn/end') break
    if (type === 'turn/start') throw new Error('rewind point is inside an open turn')
  }
  return seed
}

/** One picker row for a candidate. The value is the `turnStartSeq` string;
 * the selection resolves against the candidate list captured at open time
 * (stale selections are rejected by the workflow's generation gates). */
export function rewindPickerItem(candidate: RewindCandidate): PickerItem {
  const tag = candidate.hasNonTextContent ? '[image] ' : ''
  const preview = candidate.preview === '' && candidate.hasNonTextContent ? '(image only)' : candidate.preview
  return {
    value: String(candidate.turnStartSeq),
    label: `turn ${candidate.turn} · ${tag}${preview}`,
    ...(candidate.hasNonTextContent
      ? { description: 'attachments are not re-staged on rewind' }
      : {}),
  }
}
