/**
 * The ONE renderer-neutral final-Assistant qualification.
 *
 * Focus presentation and the visual Assistant-body projection must agree on
 * WHICH transcript row owns the answer of a settled turn. Keeping the
 * predicate here — over the existing `TurnActivity` plus the window's turn
 * rows — prevents a second "latest assistant" algorithm from drifting: only
 * the authoritative `turn/end` with a completed/max-tokens reason, only the
 * structural latest assistant step, and only a row that still has renderable
 * content or explicit deliverables qualify. An earlier non-empty answer is
 * never a fallback.
 *
 * Presentation-only: this module reads the existing fold carriers and the
 * private step sidecars, holds no state and writes nothing.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/final-assistant
 */

import {
  assistantBlocksVisibleNow,
  assistantLatestStepOf,
  assistantStepOf,
} from './folder.ts'
import type { TranscriptMessage, TurnActivity } from './types.ts'

/** The qualified final Assistant row plus its max-tokens presentation flag. */
export interface EligibleFinalAssistant {
  readonly message: Extract<TranscriptMessage, { kind: 'assistant' }>
  readonly truncated: boolean
}

/** Find the Assistant entry that owns the structural latest step. A late
 * durable message can append after newer process evidence, so physical array
 * order is not a reliable final-answer identity. */
function assistantForStep(
  group: readonly TranscriptMessage[],
  step: number,
): Extract<TranscriptMessage, { kind: 'assistant' }> | undefined {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const member = group[index]
    if (member?.kind === 'assistant' && assistantStepOf(member) === step) return member
  }
  return undefined
}

/** Whether one Assistant entry has semantic/finalized content or an explicit
 * delivered-file tail. Pending display-only open-opaque rows remain transcript
 * evidence but cannot become a completed/max-token final; finalized generic
 * blocks stay eligible. */
function assistantRenderable(assistant: Extract<TranscriptMessage, { kind: 'assistant' }>): boolean {
  if (assistant.displayBlocks?.some(block => block.kind === 'open-opaque') === true) return false
  if (assistant.deliverables !== undefined && assistant.deliverables.length > 0) return true
  if (assistant.content !== undefined) return assistantBlocksVisibleNow(assistant.content)
  return assistant.text.trim() !== ''
}

/**
 * The turn's final assistant selection: only after the authoritative
 * turn/end, only for a reason the system presents output (completed /
 * max-tokens), and only when the Assistant owning the structural latest step
 * has semantic/finalized content or explicit delivered files. An empty or
 * pending latest step without either yields NO final — never an earlier
 * assistant. The max-tokens final carries the truncated marker.
 * @param activity - the folder's per-turn activity for this group's turn.
 * @param group - the window's rows belonging to that turn, in log order.
 * @returns the eligible row and truncation flag, or undefined.
 */
export function eligibleFinalAssistant(
  activity: TurnActivity | undefined,
  group: readonly TranscriptMessage[],
): EligibleFinalAssistant | undefined {
  if (activity === undefined || !activity.completed) return undefined
  const reason = activity.reason?.kind
  if (reason !== 'completed' && reason !== 'max-tokens') return undefined
  // The exact authoritative assistant may be retained internally but hidden
  // from the normal transcript projection; never fall back to an earlier row.
  const latestStep = assistantLatestStepOf(activity)
  if (activity.lastAssistantVisible === false || latestStep === undefined) return undefined
  const last = assistantForStep(group, latestStep)
  // Interrupted prefixes and display-only pending rows are process evidence,
  // never a completed/max-token final answer, even when a malformed log reports
  // a successful reason.
  if (last === undefined || last.interrupted === true || !assistantRenderable(last)) return undefined
  return { message: last, truncated: reason === 'max-tokens' }
}
