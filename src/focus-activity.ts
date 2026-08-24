/**
 * Focus Mode presentation: the FocusActivityComponent (the live Thought
 * disclosure) and its pure formatting helpers. The component only RENDERS —
 * expansion state lives in TuiApp, session data in the TranscriptFolder,
 * and the system-prompt policy in focus.ts (plan §14).
 *
 * The collapsed card shows: a status header (symbol + duration + responsive
 * tool stats), the latest narrative line, and the latest operation line —
 * all muted, never competing with the final assistant. The expanded card
 * renders ONLY the header: the hidden process rows render below as ordinary
 * transcript messages (plan §15 — no second renderer family).
 * @module @xmoon76/dsh-pi-tui/focus-activity
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { color } from './theme.ts'
import type { TurnActivity } from './transcript.ts'
import type { TranscriptMessage } from './transcript.ts'

/** The max tool-type names the header stats show before the `+N` tail
 * (plan §10.4). */
export const FOCUS_TOOL_SUMMARY_MAX_TYPES = 3

/** The header symbol per turn state (plan §2.7): expanded always reads ▾;
 * a collapsed failure carries its semantic mark, never a fake arrow. */
export function focusStatusSymbol(activity: TurnActivity, expanded: boolean): string {
  if (expanded) return '▾'
  if (!activity.completed) return '◐'
  switch (activity.reason?.kind) {
    case 'error':
    case 'blocked':
    case 'max-tokens':
      return '⚠'
    case 'aborted':
    case 'interrupted':
      return '⨯'
    default:
      return '▸'
  }
}

/** The header's base label WITHOUT the stats tail (plan §14.1): a failure
 * names its reason instead of "Thought". The duration is omitted entirely
 * when the turn has no reliable start (plan §10.2 — never a fake `0s`). */
export function focusStatusLabel(activity: TurnActivity, duration: string | undefined): string {
  const time = duration === undefined ? '' : ` ${duration}`
  if (!activity.completed) return `Thought${time}`
  switch (activity.reason?.kind) {
    case 'error':
      // A legacy/corrupt log without turn/start must not read
      // "Failed after" with nothing after it (review fix).
      return duration === undefined ? 'Failed' : `Failed after ${duration}`
    case 'aborted':
    case 'interrupted':
      return `Interrupted${time}`
    case 'blocked':
      return `Blocked${time}`
    case 'max-tokens':
      return `Max tokens${time}`
    default:
      return `Thought${time}`
  }
}

/** Human duration from millis: seconds under a minute, `m s` above (the
 * elapsed TURN time — plan §14.2: the user waited the whole turn). */
export function formatFocusDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** The responsive tool-stats tail parts (`14 tools`, `read ×7`, …, `+2`):
 * types sorted count-desc / name-asc, capped at
 * {@link FOCUS_TOOL_SUMMARY_MAX_TYPES}, with a `+N` remainder counting the
 * OTHER tool TYPES (not calls). Empty when the turn called no tools. */
export function focusToolStatParts(tools: ReadonlyMap<string, number>, toolCalls: number): string[] {
  if (toolCalls <= 0) return []
  const parts = [`${toolCalls} tools`]
  const types = [...tools.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  for (const [name, count] of types.slice(0, FOCUS_TOOL_SUMMARY_MAX_TYPES)) {
    parts.push(`${name} ×${count}`)
  }
  if (types.length > FOCUS_TOOL_SUMMARY_MAX_TYPES) {
    parts.push(`+${types.length - FOCUS_TOOL_SUMMARY_MAX_TYPES}`)
  }
  return parts
}

/** The effective duration text for one activity at `now`. */
export function focusDurationText(activity: TurnActivity, now: () => number): string | undefined {
  if (activity.startedAt === undefined) return undefined
  const end = activity.completed ? (activity.endedAt ?? now()) : now()
  return formatFocusDuration(Math.max(0, end - activity.startedAt))
}

/** Assemble the one-line header, dropping the stat tail progressively so
 * the header NEVER breaks the terminal: full tail → no `+N` → fewer types
 * → bare label (then a hard truncate as the last resort — plan §14.3). */
export function formatFocusHeaderLine(
  activity: TurnActivity,
  expanded: boolean,
  now: () => number,
  width: number,
): string {
  const label = focusStatusLabel(activity, focusDurationText(activity, now))
  const head = `${focusStatusSymbol(activity, expanded)} ${label}`
  const tail = focusToolStatParts(activity.tools, activity.toolCalls)
  if (tail.length === 0) return truncateToWidth(head, width, '…')
  const candidates: string[] = []
  candidates.push(`${head} · ${tail.join(' · ')}`)
  // Drop the remainder marker first, then the type parts from the end.
  const typeCount = Math.min(tail.length - 1, FOCUS_TOOL_SUMMARY_MAX_TYPES)
  for (let count = typeCount; count >= 1; count -= 1) {
    candidates.push(`${head} · ${tail.slice(0, count).join(' · ')}`)
  }
  candidates.push(head)
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= width) return candidate
  }
  return truncateToWidth(head, width, '…')
}

/** The collapsed card's operation line: `Tool: bash pnpm test` while the
 * turn runs; once it settles the line reads `Last: …` with the transient
 * ✓/✗ settle marker stripped (plan §2.5/§10.7 — the ✓ is a running-state
 * hint, the settled card says what the turn ended on). */
export function focusOperationLine(operation: string, running: boolean): string {
  if (running) return operation
  const settled = operation.replace(/^(Tool: |✓ |✗ )/, '')
  return settled === operation ? operation : `Last: ${settled}`
}

/** One collapsed body line, truncated to the content width: the body
 * budget is the width MINUS the lead ('Thinking: ' / 'Error: '), and a
 * lead that alone exceeds the width truncates too — a preview line can
 * never wrap (the fullscreen row hit-map depends on that). */
function previewLine(prefix: string | undefined, text: string, width: number): string {
  const lead = prefix ?? ''
  const bodyBudget = width - visibleWidth(lead)
  const body = bodyBudget > 0 ? truncateToWidth(text, bodyBudget, '…') : ''
  return truncateToWidth(`${lead}${body}`, Math.max(1, width), '…')
}

/** The collapsed card body: narrative (Thinking: … when reasoning), the
 * latest operation, and the error reason (plan §13.6). */
export function focusCollapsedBody(activity: TurnActivity, width: number): string[] {
  const lines: string[] = []
  const narrative = activity.narrative
  if (narrative !== undefined) {
    const lead = narrative.kind === 'thinking' ? 'Thinking: ' : ''
    lines.push(previewLine(lead, narrative.text, width))
  }
  if (activity.latestOperation !== undefined) {
    lines.push(previewLine('', focusOperationLine(activity.latestOperation, !activity.completed), width))
  }
  const reason = activity.reason
  if (reason?.kind === 'error' && reason.error !== undefined) {
    lines.push(previewLine('Error: ', `${reason.error.code}: ${reason.error.message}`, width))
  }
  return lines
}

/**
 * The live Thought disclosure. render() re-reads `now()` on EVERY frame, so
 * the WorkingIndicator's 500ms repaint heartbeat refreshes the running
 * duration without a second timer (plan §3.2); the TuiApp component cache
 * (keyed on the activity revision + expansion + theme) keeps that cheap.
 * The component never mutates Focus state — clicks route through the
 * app's hit map to toggleFocusTurn (plan §17).
 */
export class FocusActivityComponent {
  private readonly activity: TurnActivity
  private readonly expanded: boolean
  private readonly now: () => number

  constructor(options: {
    activity: TurnActivity
    expanded: boolean
    now?: () => number
  }) {
    this.activity = options.activity
    this.expanded = options.expanded
    this.now = options.now ?? (() => Date.now())
  }

  /** The Component interface requires invalidate(); the component keeps no
   * render cache (duration is live per frame), so this is a no-op. */
  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = []
    const indent = '  '
    const contentWidth = Math.max(1, width - visibleWidth(indent))
    // The header formatter budgets the CONTENT width (the indent is added
    // after), so a header that fits never wraps past the terminal — the
    // fullscreen row hit-map depends on that (review fix).
    lines.push(`${indent}${color.textDim(formatFocusHeaderLine(this.activity, this.expanded, this.now, contentWidth))}`)
    if (!this.expanded) {
      for (const line of focusCollapsedBody(this.activity, contentWidth)) {
        lines.push(`${indent}${color.textDim(line)}`)
      }
    }
    return lines
  }
}

/**
 * The Focus presentation projection over one windowed transcript (plan
 * §12/§33): messages are grouped per turn into `user(s) → FocusActivity →
 * (process when expanded | final when settled) → compaction cards`, so the
 * raw TranscriptMessage union is never polluted with a fake `focus-activity`
 * kind and the session data stays lossless.
 *
 * Collapsed turns HIDE thinking/tool/system/intermediate-assistant rows
 * entirely — they cannot leak through Ctrl+O/Alt+T because they are not in
 * the rendered list at all (plan §15.2). The final assistant only appears
 * after the authoritative `turn/end` (plan §13.1) and never duplicates in
 * the expanded view (it stays at its chronological position).
 * @param messages - the windowed transcript.
 * @param activities - the folder's per-turn activities (same fold state).
 * @param expandedTurns - the user's expansion choices (live running turns
 *   included — plan §2.3).
 * @param focusMode - whether Focus is on (off = the normal projection).
 */
export type FocusProjectedBlock =
  | {
    kind: 'message'
    message: TranscriptMessage
    truncated?: boolean
    /**
     * Set ONLY on process rows that exist BECAUSE the owner Thought is
     * expanded (thinking / tool / system / intermediate-assistant /
     * compaction rows revealed by the disclosure). The fullscreen click
     * handler collapses the owner turn when this is set — the user's own
     * messages and the FINAL assistant are NOT marked, so clicking them
     * never collapses the Thought (plan §8.8, review P2: the
     * body-click-collapse scope is exactly the expanded process content,
     * never the turn's persistent rows).
     */
    collapseFocusOwnerOnClick?: number
  }
  | { kind: 'activity'; activity: TurnActivity }

export function projectFocus(
  messages: readonly TranscriptMessage[],
  activities: ReadonlyMap<number, TurnActivity>,
  expandedTurns: ReadonlySet<number>,
  focusMode: boolean,
): FocusProjectedBlock[] {
  if (!focusMode) return messages.map(message => ({ kind: 'message', message }))
  const out: FocusProjectedBlock[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    const turn = 'turn' in message ? message.turn : undefined
    if (turn === undefined) {
      // Window summaries and other turn-less entries pass through.
      out.push({ kind: 'message', message })
      index += 1
      continue
    }
    // One turn's consecutive message run.
    const group: TranscriptMessage[] = [message]
    while (index + 1 < messages.length) {
      const next = messages[index + 1]!
      if (!('turn' in next) || next.turn !== turn) break
      group.push(next)
      index += 1
    }
    index += 1
    const activity = activities.get(turn)
    const expanded = expandedTurns.has(turn)
    // 1. The user's own messages stay visible (steers included).
    for (const member of group) {
      if (member.kind === 'user') out.push({ kind: 'message', message: member })
    }
    // 2. The Thought disclosure follows the user rows.
    if (activity !== undefined) out.push({ kind: 'activity', activity })
    // The final assistant is decided ONCE from the exact last assistant
    // row (shared by the expanded and collapsed branches — one semantic,
    // never two drifting copies).
    const final = finalAssistantSelection(activity, group)
    if (expanded) {
      // The open Thought reveals the FULL process in ORIGINAL order —
      // compaction cards included at their chronological position — with
      // the final assistant held back and appended LAST (a max-tokens
      // turn's `max tokens reached` system row must never land after the
      // final: the settled order is User → Thought → process → final).
      // Every revealed process row carries the owner-turn collapse mark:
      // the user's rows and the FINAL assistant stay unmarked (clicking
      // them must not collapse the Thought — review P2).
      for (const member of group) {
        if (member.kind === 'user') continue
        if (final !== undefined && member === final.message) continue
        out.push({ kind: 'message', message: member, collapseFocusOwnerOnClick: turn })
      }
      if (final !== undefined) {
        out.push(final.truncated ? { kind: 'message', message: final.message, truncated: true } : { kind: 'message', message: final.message })
      }
      continue
    }
    // Compaction cards keep their existing lifecycle in the collapsed
    // view (plan §12.3 v1 — never hidden into the Thought).
    for (const member of group) {
      if (member.kind === 'compaction') out.push({ kind: 'message', message: member })
    }
    // The collapsed final: only after the authoritative turn/end.
    if (final !== undefined) {
      out.push(final.truncated ? { kind: 'message', message: final.message, truncated: true } : { kind: 'message', message: final.message })
    }
  }
  return out
}

/** The EXACT last assistant message of a turn (by position — an empty or
 * image-only step still owns the final slot; there is NEVER a fallback to
 * an earlier assistant, review fix). */
function lastAssistant(
  group: readonly TranscriptMessage[],
): Extract<TranscriptMessage, { kind: 'assistant' }> | undefined {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const member = group[index]
    if (member?.kind === 'assistant') return member
  }
  return undefined
}

/** Whether one assistant message truly renders visible rows. The flat
 * `text` already aggregates EVERY text block (textOf), so the only
 * non-text block the TUI's assistant renderer paints is an `image` —
 * `reasoning` / `tool-call` / `tool-result` content (and any future
 * merge-extended block) is SKIPPED by renderBlockSequence. A content
 * array made only of those renders zero rows and can never be presented
 * as a final answer: a max-tokens turn must not end in a bare
 * "(output may be truncated)" marker with no actual output (review
 * edge). Keep this in sync with the renderer's painted block types. */
function assistantRenderable(assistant: Extract<TranscriptMessage, { kind: 'assistant' }>): boolean {
  if (assistant.text !== '') return true
  return assistant.content?.some(block => block.type === 'image') === true
}

/** The turn's final assistant selection: only after the authoritative
 * turn/end, only for a reason the system presents output (completed /
 * max-tokens), and only when the EXACT last assistant renders rows. An
 * empty last step yields NO final — never an earlier assistant (review
 * fix). The max-tokens final carries the truncated marker (plan §13.8). */
function finalAssistantSelection(
  activity: TurnActivity | undefined,
  group: readonly TranscriptMessage[],
): { message: Extract<TranscriptMessage, { kind: 'assistant' }>; truncated: boolean } | undefined {
  if (activity === undefined || !activity.completed) return undefined
  const reason = activity.reason?.kind
  if (reason !== 'completed' && reason !== 'max-tokens') return undefined
  const last = lastAssistant(group)
  if (last === undefined || !assistantRenderable(last)) return undefined
  return { message: last, truncated: reason === 'max-tokens' }
}
