/**
 * Question attention -> Task Center row projection (M3-3B addendum
 * `dsh-pi-tui-m3-3b-question-park-task-center-addendum-20260930.md` §7/§10).
 *
 * Pure by construction: no Host reads, no TUI mutation, no
 * `TaskBrowserRuntime` access. The Question controller owns the authority
 * interpretation (`continued` / queued reply / settled / visible / parked) and
 * exposes its detached presentation model; Task Center only maps that model
 * onto panel rows.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/task-attention
 */

import type { QuestionAttentionRow } from './question-controller.ts'
import type { TaskPanelItem } from './task-presentation.ts'

/** The panel group label for human-required Question attention. */
export const QUESTION_ATTENTION_GROUP = 'Needs attention'

/** The value prefix that identifies a Question attention row. */
const QUESTION_VALUE_PREFIX = 'question:'

/**
 * Stable row identity — the exact authority identity, never a label, the first
 * question text, an order, a tool-result position or a timestamp (§7.3).
 */
export function questionTaskRowValue(sessionId: string, callId: string): string {
  return `${QUESTION_VALUE_PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(callId)}`
}

/** Decode a Question row value back to its authority identity. */
export function questionIdentityOf(value: string): { sessionId: string; callId: string } | undefined {
  if (!value.startsWith(QUESTION_VALUE_PREFIX)) return undefined
  const rest = value.slice(QUESTION_VALUE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || separator === rest.length - 1) return undefined
  return {
    sessionId: decodeURIComponent(rest.slice(0, separator)),
    callId: decodeURIComponent(rest.slice(separator + 1)),
  }
}

/** Collapse arbitrary question text onto ONE physical row. */
function singlePhysicalRow(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * The compact label (§7.4): the first question's header/text, or a count when
 * the call carries several questions. Raw arguments JSON is never dumped.
 */
export function questionAttentionLabel(questions: QuestionAttentionRow['questions']): string {
  if (questions.length > 1) return `${questions.length} questions awaiting answer`
  const first = questions[0]
  const text = first === undefined ? '' : singlePhysicalRow(first.header ?? first.question)
  return text === '' ? 'Question awaiting answer' : text
}

/** The status word: a visible panel is being answered, a parked one is not. */
export function questionAttentionStatus(row: QuestionAttentionRow): 'answering' | 'awaiting answer' {
  return row.presentation === 'visible' ? 'answering' : 'awaiting answer'
}

/**
 * Quick shows only PARKED actionable Questions (§4.3): a visible panel already
 * owns the editor seat, so listing it would duplicate active UI.
 */
export function quickQuestionRows(rows: readonly QuestionAttentionRow[]): TaskPanelItem[] {
  return rows.filter(row => row.presentation === 'parked').map(toPanelItem)
}

/**
 * Full shows EVERY actionable Question (§4.4): a visible one is `answering`,
 * a parked one is `awaiting answer`.
 */
export function fullQuestionRows(rows: readonly QuestionAttentionRow[]): TaskPanelItem[] {
  return rows.map(toPanelItem)
}

/**
 * One Question attention row as a panel row. It is deliberately NOT a Job: no
 * `canStop`, no `startedAt`, no Job type — and it never carries the work
 * `active`/`attention` flags, so the active-work count cannot silently absorb
 * human-required Questions (§7.2/§11). The panel's projection includes it by
 * its own explicit rule instead.
 */
function toPanelItem(row: QuestionAttentionRow): TaskPanelItem {
  return {
    value: questionTaskRowValue(row.sessionId, row.callId),
    label: questionAttentionLabel(row.questions),
    status: questionAttentionStatus(row),
    group: QUESTION_ATTENTION_GROUP,
    source: 'question',
    canOpen: true,
    canStop: false,
  }
}
