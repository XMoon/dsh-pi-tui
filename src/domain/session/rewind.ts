/**
 * Conversation rewind semantics: session events → neutral rewind candidates.
 *
 * Rewind is a Client-local picker over completed user turns. The selected row
 * carries the predecessor `turn/end` sequence and the editor text; the Host
 * owns the actual fork cut, inherited prefix and child metadata through
 * `SessionLifecycle.fork({ sourceSessionId, atSeq })`.
 *
 * This module is pure and transport/UI-neutral: it only maps the event log
 * onto the rewind model. It never constructs a seed, reads persistence or
 * creates an Agent — the picker rows live in `tui/pickers/rewind.ts` and the
 * Direct compatibility outline fold in `runtime/direct/turn-outline-compat.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/session/rewind
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { textOf } from '../transcript/folder.ts'
import { userBlocksVisibleNow } from '../transcript/content-blocks.ts'

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
 * finalized user-content visibility rule. Consumed by the Direct compatibility
 * outline fold as well as the full-log candidate fold. */
export function isEmptyMessage(blocks: readonly ContentBlock[]): boolean {
  return !userBlocksVisibleNow(blocks)
}

/** One-line, width-bounded preview of a prompt (whitespace collapsed).
 * Consumed by the Direct compatibility outline fold as well as the candidate
 * folds. */
export function singleLinePreview(text: string): string {
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

/**
 * Derive the EXACT rewind material for one selected turn from the durable
 * events a `loadThrough(turnStartSeq)` window returned (§4.3): the
 * selected direct human message's FULL editor text (never the outline's
 * bounded preview), its non-text marker, and the predecessor valid
 * `turn/end` fork boundary — the SAME visibility rules as
 * `collectRewindCandidates`, scoped to the selected turn.
 * @param events - the loaded window's durable events (source order).
 * @param selectedTurnStartSeq - the selected row's `turn/start` seq.
 * @returns the exact candidate, or undefined when the window cannot derive
 *  it (a malformed span never invents a fork point).
 */
export function rewindCandidateOfLoadedWindow(
  events: readonly SessionEvent[],
  selectedTurnStartSeq: number,
): RewindCandidate | undefined {
  // Locate the selected turn's start; remember the latest turn/end before it.
  let selectedTurn: number | undefined
  for (const event of events) {
    if (event.type !== 'turn/start') continue
    if (Number(event.seq) === selectedTurnStartSeq) {
      selectedTurn = event.data.turn
      break
    }
  }
  if (selectedTurn === undefined) return undefined
  // The selected turn's primary direct human message (first non-empty).
  let primary: { seq: number; blocks: readonly ContentBlock[] } | undefined
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const seq = Number(event.seq)
    if (seq < selectedTurnStartSeq) continue
    if (primary !== undefined) break
    if (event.data.source.kind !== 'user') continue
    if (isEmptyMessage(event.data.content)) continue
    primary = { seq, blocks: event.data.content }
  }
  if (primary === undefined) return undefined
  // The predecessor boundary: the LAST valid turn/end BEFORE the selected
  // turn/start (a first turn therefore has none — the outline excludes it,
  // and a loaded window that cannot prove one never invents it).
  let forkAtSeq: number | undefined
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const seq = Number(event.seq)
    if (seq >= selectedTurnStartSeq) break
    forkAtSeq = seq
  }
  if (forkAtSeq === undefined) return undefined
  const editorText = textOf(primary.blocks)
  return {
    turnStartSeq: selectedTurnStartSeq,
    forkAtSeq,
    turn: selectedTurn,
    messageSeq: primary.seq,
    editorText,
    preview: singleLinePreview(editorText),
    hasNonTextContent: primary.blocks.some(block => block.type !== 'text'),
  }
}
