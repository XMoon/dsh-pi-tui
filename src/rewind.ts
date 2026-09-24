/**
 * Conversation rewind: session events → safe Host fork anchors.
 *
 * Rewind is a Client-local picker over completed user turns. The selected row
 * carries the predecessor `turn/end` sequence and the editor text; the Host
 * owns the actual fork cut, inherited prefix and child metadata through
 * `SessionLifecycle.fork({ sourceSessionId, atSeq })`.
 *
 * This module is pure: it only maps the event log onto the rewind model. It
 * never constructs a seed, reads persistence or creates an Agent.
 * @module @xmoon76/dsh-pi-tui/rewind
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { userBlocksVisibleNow } from './content-block-presentation.ts'
import { textOf } from './transcript.ts'
import type { PickerItem } from './tui-app.ts'

/** One rewindable user turn. */
export interface RewindCandidate {
  /** The selected turn's `turn/start` event sequence. */
  turnStartSeq: number
  /** The predecessor completed `turn/end` sequence sent to Host fork. */
  forkAtSeq: number
  /** The turn number (`turn/start` data), for the picker row. */
  turn: number
  /** The primary human message's seq (first non-empty direct user input). */
  messageSeq: number
  /** The text restored into the editor after a committed rewind. */
  editorText: string
  /** One-line, width-bounded preview for the picker row. */
  preview: string
  /** Whether the selected prompt contains non-text content. */
  hasNonTextContent: boolean
}

/** Whether one user/message event is a DIRECT human prompt. Injected context,
 * skill bodies, system reminders and goal continuations answer false. */
export function isHumanTurnMessage(event: SessionEvent<'user/message'>): boolean {
  return event.data.source.kind === 'user'
}

/** Whether a message is empty for rewind purposes: mirror the transcript's
 * finalized user-content visibility rule. */
function isEmptyMessage(blocks: readonly ContentBlock[]): boolean {
  return !userBlocksVisibleNow(blocks)
}

/** One-line, width-bounded preview of a prompt (whitespace collapsed). */
function singleLinePreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat
}

/**
 * Derive rewind candidates from a session event log.
 *
 * Only a completed human turn after a valid completed predecessor is
 * rewindable. A non-human closed turn still becomes a legal predecessor; an
 * open or malformed span never does. The first human turn therefore has no
 * candidate because official fork omission would mean "latest boundary", not
 * an empty prefix.
 */
export function collectRewindCandidates(events: readonly SessionEvent[]): readonly RewindCandidate[] {
  const candidates: RewindCandidate[] = []
  let lastValidClosedTurnEndSeq: number | undefined
  let open: {
    turn: number
    startSeq: number
    predecessorEndSeq: number | undefined
    primary?: { seq: number; blocks: readonly ContentBlock[] }
  } | undefined

  for (const event of events) {
    if (event.type === 'turn/start') {
      // A new turn while one is open invalidates the previous span. Do not
      // invent a predecessor from a malformed boundary.
      open = {
        turn: event.data.turn,
        startSeq: Number(event.seq),
        predecessorEndSeq: lastValidClosedTurnEndSeq,
      }
      continue
    }
    if (event.type === 'turn/end') {
      if (open !== undefined && event.data.turn !== open.turn) continue
      if (open !== undefined) {
        const primary = open.primary
        if (primary !== undefined && open.predecessorEndSeq !== undefined) {
          const editorText = textOf(primary.blocks)
          candidates.push({
            turnStartSeq: open.startSeq,
            forkAtSeq: open.predecessorEndSeq,
            turn: open.turn,
            messageSeq: primary.seq,
            editorText,
            preview: singleLinePreview(editorText),
            hasNonTextContent: primary.blocks.some(block => block.type !== 'text'),
          })
        }
        // Every valid closed turn, including an injected/non-human turn, is a
        // possible predecessor for the next human turn.
        lastValidClosedTurnEndSeq = Number(event.seq)
      }
      open = undefined
      continue
    }
    if (event.type === 'user/message' && open !== undefined && open.primary === undefined) {
      const blocks = event.data.content
      if (isHumanTurnMessage(event) && !isEmptyMessage(blocks)) {
        open.primary = { seq: Number(event.seq), blocks }
      }
    }
  }

  return candidates.reverse()
}

/** One picker row for a candidate. The value remains the selected turn-start
 * identity; the workflow resolves the captured row before dispatch. */
export function rewindPickerItem(candidate: RewindCandidate): PickerItem {
  const tag = candidate.hasNonTextContent ? '[attachment] ' : ''
  const preview = candidate.preview === '' && candidate.hasNonTextContent ? '(attachment only)' : candidate.preview
  return {
    value: String(candidate.turnStartSeq),
    label: `turn ${candidate.turn} · ${tag}${preview}`,
    ...(candidate.hasNonTextContent
      ? { description: 'non-text content is not re-staged on rewind' }
      : {}),
  }
}
