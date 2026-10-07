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
import { userBlocksVisibleNow } from './domain/transcript/content-blocks.ts'
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

/**
 * Build picker rows from the official whole-log \`turnOutline\` projection
 * (M3-4 PR4 §4.2): every STARTED turn is listed — old turns outside the
 * current presentation event window included — using the projection's own
 * bounded previews. The row value is the turn's \`turn/start\` seq (the
 * \`loadThrough\` jump target); the first outline entry is EXCLUDED exactly
 * like the full-log fold (a first human turn has no predecessor boundary to
 * fork at).
 * @param outline - the official turnOutline projection entries (ascending).
 * @returns the newest-first picker rows.
 */
export function rewindOutlineRows(outline: readonly {
  readonly turn: number
  readonly seq: number
  readonly prompt: string
  readonly response: string
}[]): Array<{ readonly value: string; readonly label: string }> {
  const rows: Array<{ readonly value: string; readonly label: string }> = []
  for (let index = outline.length - 1; index >= 1; index -= 1) {
    const entry = outline[index]!
    const prompt = entry.prompt === '' ? '(no text prompt)' : entry.prompt
    rows.push({ value: String(entry.seq), label: `turn ${entry.turn} · ${prompt}` })
  }
  return rows
}

/**
 * Derive the EXACT rewind material for one selected turn from the durable
 * events a \`loadThrough(turnStartSeq)\` window returned (§4.3): the
 * selected direct human message's FULL editor text (never the outline's
 * bounded preview), its non-text marker, and the predecessor valid
 * \`turn/end\` fork boundary — the SAME visibility rules as
 * \`collectRewindCandidates\`, scoped to the selected turn.
 * @param events - the loaded window's durable events (source order).
 * @param selectedTurnStartSeq - the selected row's \`turn/start\` seq.
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

/**
 * The DIRECT compatibility outline fold (M3-4 PR4 §18.4): map the exact
 * attached Direct Session's full in-process snapshot onto the official
 * \`turnOutline\` entry shape, so the shared rewind picker owner keeps ONE
 * contract (`SessionReader.turnOutline`) on minimal Direct compositions
 * that mount no \`session-turn-outline\` projection unit. The Remote branch
 * NEVER uses this fold (projection-only, fail-closed).
 *
 * The fold mirrors the official projection's shape rules: every STARTED
 * turn becomes an entry (a non-advancing \`turn/start\` is ignored),
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
