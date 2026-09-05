/**
 * Focus Mode presentation: the FocusActivityComponent (the live Thought
 * disclosure) and its pure formatting helpers. The component only RENDERS —
 * expansion state lives in TuiApp, session data in the TranscriptFolder,
 * and the system-prompt policy in focus.ts (plan §14).
 *
 * The collapsed card shows: a status header (whale disclosure icon +
 * duration + per-turn token + responsive tool stats) and the three compact
 * process slots — Think / Tool / Message (Message shows the latest up to
 * three visual rows) — plus the Error line, all muted,
 * never competing with the final assistant. The expanded card renders ONLY
 * the header: the hidden process rows render below as ordinary transcript
 * messages (plan §15 — no second renderer family), and inside an open
 * Thought the foldable process cards default COMPACT with their own
 * per-card disclosure (the secondary-disclosure supplement).
 *
 * The whale icon encodes ONLY the disclosure state (🐋 collapsed / 🐳
 * expanded); the execution outcome is carried by the header label
 * (Thought / Failed after / Interrupted / Blocked / Max tokens) — two
 * orthogonal dimensions, never merged into one symbol (plan §2.2).
 * @module @xmoon76/dsh-pi-tui/focus-activity
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { color } from './theme.ts'
import { formatTokens } from './token-usage.ts'
import { iconFor, type IconSemantic, type IconStyle } from './icons.ts'
import { toolTitle } from './present.ts'
import type { TurnActivity } from './transcript.ts'
import type { TranscriptMessage } from './transcript.ts'

/** The max tool-type names the header stats show before the `+N` tail
 * (plan §10.4). */
export const FOCUS_TOOL_SUMMARY_MAX_TYPES = 3

/** The disclosure icon SEMANTIC: collapsed / expanded — disclosure state
 * ONLY (plan §2.1/§2.2). The execution outcome lives in the header label.
 * The glyph resolves through iconFor(..., iconStyle) at render time. */
export function focusDisclosureSemantic(expanded: boolean): IconSemantic {
  return expanded ? 'disclosure-expanded' : 'disclosure-collapsed'
}

/**
 * The disclosure icon in the LEGACY emoji style: 🐋 collapsed, 🐳 expanded.
 * @deprecated internal compatibility — resolve through
 * `focusDisclosureSemantic` + `iconFor(..., iconStyle)`.
 */
export function focusDisclosureIcon(expanded: boolean): '🐋' | '🐳' {
  return expanded ? '🐳' : '🐋'
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
  const parts = [`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`]
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

/** The presentation-only shape needed to summarize one live Preparing row.
 * It deliberately excludes the call id, turn and arguments: Focus owns no
 * lifecycle state and only needs the stable visual order plus an optional
 * display name. */
export interface FocusPreparingPreview {
  readonly index: number
  readonly name?: string
}

/** The compact Focus-collapsed Tool-slot text for live Preparing rows.
 * Names that do not map to a known tool title remain generic, so model-facing
 * names never make the compact Thought card noisy. The input is copied and
 * sorted so the summary is deterministic even when a caller supplies a fresh
 * order. */
export function focusPreparingSummary(
  previews: readonly FocusPreparingPreview[],
): string | undefined {
  if (previews.length === 0) return undefined
  const ordered = [...previews].sort((left, right) => left.index - right.index)
  const known = ordered
    .map(preview => preview.name === undefined || preview.name === '' ? undefined : toolTitle(preview.name))
    .find(title => title !== undefined && title !== 'Tool' && title !== 'tool')
  if (known === undefined) {
    return ordered.length === 1 ? 'Preparing tool…' : `Preparing ${ordered.length} tools…`
  }
  return ordered.length === 1 ? `Preparing ${known}…` : `Preparing ${known} +${ordered.length - 1}`
}

/** Assemble the one-line header, dropping the stat tail progressively so
 * the header NEVER breaks the terminal (plan §14/§46): full tail → token +
 * tool count → token → bare label (then a hard truncate as the last
 * resort). The per-turn token segment is hidden entirely when the turn has
 * no usage fact (never a fake `0 tok` — plan §13.3). The disclosure glyph
 * resolves against the CURRENT icon style (the disclosure is an
 * interaction affordance and is never hidden — not even under minimal,
 * plan §34.7); the single-space lead keeps the historical `🐋 Thought`
 * layout. */
export function formatFocusHeaderLine(
  activity: TurnActivity,
  expanded: boolean,
  now: () => number,
  width: number,
  iconStyle: IconStyle = 'emoji',
): string {
  const label = focusStatusLabel(activity, focusDurationText(activity, now))
  const head = `${iconFor(focusDisclosureSemantic(expanded), iconStyle)} ${label}`
  const token = activity.totalTokens === undefined ? undefined : `${formatTokens(activity.totalTokens)} tok`
  const tail = focusToolStatParts(activity.tools, activity.toolCalls)
  const candidates: string[] = []
  if (token !== undefined) {
    candidates.push(`${head} · ${token}${tail.length > 0 ? ` · ${tail.join(' · ')}` : ''}`)
    candidates.push(`${head} · ${token}${tail.length > 0 ? ` · ${tail[0]}` : ''}`)
    candidates.push(`${head} · ${token}`)
  } else if (tail.length > 0) {
    candidates.push(`${head} · ${tail.join(' · ')}`)
    candidates.push(`${head} · ${tail[0]}`)
  }
  candidates.push(head)
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= width) return candidate
  }
  return truncateToWidth(head, width, '…')
}

/** The fixed label column width of the collapsed body slots: the widest
 * label (`Message: `) — every slot's text starts at the same column
 * (plan §25, aligned by visible width). */
const FOCUS_SLOT_LABEL_WIDTH = 9

/** The max visual rows the collapsed Message slot renders: the LATEST
 * tail rows of the bounded message text (plan: Message is the third
 * process slot and shows up to three terminal rows, always the newest
 * tail — streaming appends naturally roll toward it). */
const FOCUS_MESSAGE_MAX_ROWS = 3

/** Collapse arbitrary slot text to ONE physical terminal row: CR/LF
 * sequences (LF, CRLF, lone CR) are normalized to the FIRST line. This is
 * the final boundary the fullscreen compositor depends on — every
 * string[] element a component renders is exactly one framebuffer row, so
 * no caller-provided multiline text (bash heredocs, multiline errors, …)
 * may ever escape a compact slot as embedded line breaks (ghost-row fix).
 * The first line is kept rather than joining the lines with spaces: the
 * compact preview must not smuggle later lines' content into the row, and
 * width truncation would keep the leading lines anyway. */
function compactSingleLine(text: string): string {
  return text.split(/\r\n|\r|\n/)[0] ?? ''
}

/** One collapsed body slot line, truncated to the content width: the body
 * budget is the width MINUS the lead ('Think:   ' / 'Error:   '), and a
 * lead that alone exceeds the width truncates too — a preview line can
 * never wrap (the fullscreen row hit-map depends on that). The returned
 * string is one PHYSICAL terminal row: CR/LF are normalized before width
 * truncation; no caller-provided multiline text may escape. */
function previewLine(label: string, text: string, width: number): string {
  const singleLine = compactSingleLine(text)
  const lead = `${label}${' '.repeat(Math.max(0, FOCUS_SLOT_LABEL_WIDTH - visibleWidth(label)))}`
  const bodyBudget = width - visibleWidth(lead)
  const body = bodyBudget > 0 ? truncateToWidth(singleLine, bodyBudget, '…') : ''
  return truncateToWidth(`${lead}${body}`, Math.max(1, width), '…')
}

/**
 * The collapsed Message slot: the bounded message tail wrapped to the
 * CURRENT width and cut to its LAST `maxRows` visual rows (plan: Message
 * is the third process slot, up to three rows, always the newest tail).
 * The wrap happens per render — a resize re-wraps, and streaming appends
 * roll the tail forward with no scroll index to maintain. Every returned
 * element is exactly one PHYSICAL framebuffer row: the first carries the
 * label lead (`Message: `), continuation rows carry a same-width blank
 * indent, and each row is hard-truncated to the width as the last resort
 * (the fullscreen row hit-map depends on one row per element).
 */
function previewTailLines(label: string, text: string, width: number, maxRows: number): string[] {
  const lead = `${label}${' '.repeat(Math.max(0, FOCUS_SLOT_LABEL_WIDTH - visibleWidth(label)))}`
  const bodyBudget = Math.max(1, width - visibleWidth(lead))
  // ANSI / Unicode-aware wrap (the fork's wrapTextWithAnsi): a single
  // logical line may wrap into several visual rows, so the tail cut
  // happens AFTER wrapping — never `text.split('\n').slice(-3)`.
  const wrapped = wrapTextWithAnsi(text, bodyBudget)
  const tail = wrapped.slice(-maxRows)
  const indent = ' '.repeat(visibleWidth(lead))
  return tail.map((row, index) => {
    const line = index === 0 ? `${lead}${row}` : `${indent}${row}`
    return truncateToWidth(line, Math.max(1, width), '…')
  })
}

/** The collapsed card body: the three process slots in FIXED order —
 * Think, Tool, Message — then the error reason (plan §24). Think and
 * Tool are at most ONE visual row; Message is the third process slot and
 * shows the latest up to {@link FOCUS_MESSAGE_MAX_ROWS} visual rows of
 * its bounded tail. Only existing slots render. A live Preparing display,
 * when supplied, temporarily owns the Tool slot over the formal Tool display.
 * The formal Tool line's status prefix follows plan §10: none while running,
 * ✓ settled ok, ✗ settled error. */
export function focusCollapsedBody(
  activity: TurnActivity,
  width: number,
  toolDisplay?: string,
  preparingDisplay?: string,
): string[] {
  const lines: string[] = []
  if (activity.think !== undefined) {
    lines.push(previewLine('Think:', activity.think.text, width))
  }
  if (preparingDisplay !== undefined) {
    lines.push(previewLine('Tool:', preparingDisplay, width))
  } else if (activity.tool !== undefined && toolDisplay !== undefined) {
    const prefix = activity.tool.status === 'ok' ? '✓ ' : activity.tool.status === 'error' ? '✗ ' : ''
    lines.push(previewLine('Tool:', `${prefix}${toolDisplay}`, width))
  }
  if (activity.message !== undefined) {
    lines.push(...previewTailLines('Message:', activity.message.text, width, FOCUS_MESSAGE_MAX_ROWS))
  }
  const reason = activity.reason
  if (reason?.kind === 'error' && reason.error !== undefined) {
    lines.push(previewLine('Error:', `${reason.error.code}: ${reason.error.message}`, width))
  }
  return lines
}

/**
 * The live Thought disclosure. render() re-reads `now()` on EVERY frame, so
 * the WorkingIndicator's 500ms repaint heartbeat refreshes the running
 * duration without a second timer (plan §3.2); the TuiApp component cache
 * (keyed on the activity revision + expansion + theme + tool display +
 * icon style) keeps that cheap. The component never mutates Focus state —
 * clicks route through the app's hit map to toggleFocusTurn (plan §17).
 * The Tool line's display text is PRECOMPUTED by the app (presenter-first,
 * plan §38) — the component stays a pure renderer. A collapsed Preparing
 * summary is presentation input only; expanded rows are composed by TuiApp
 * after the projected process tail.
 */
export class FocusActivityComponent {
  private readonly activity: TurnActivity
  private readonly expanded: boolean
  private readonly now: () => number
  private readonly toolDisplay: string | undefined
  private readonly iconStyle: IconStyle
  private readonly preparingSummary: string | undefined

  constructor(options: {
    activity: TurnActivity
    expanded: boolean
    now?: () => number
    toolDisplay?: string
    iconStyle?: IconStyle
    preparingSummary?: string
  }) {
    this.activity = options.activity
    this.expanded = options.expanded
    this.now = options.now ?? (() => Date.now())
    this.toolDisplay = options.toolDisplay
    this.iconStyle = options.iconStyle ?? 'emoji'
    this.preparingSummary = options.preparingSummary
  }

  /** The Component interface requires invalidate(); the component keeps no
   * render cache (duration is live per frame), so this is a no-op. */
  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = []
    // At very narrow widths (1-3 cells) the unconditional two-cell indent
    // would make every row wider than the terminal — drop it (review
    // finding).
    const indent = width >= 4 ? '  ' : ''
    const contentWidth = Math.max(1, width - visibleWidth(indent))
    // The header formatter budgets the CONTENT width (the indent is added
    // after), so a header that fits never wraps past the terminal — the
    // fullscreen row hit-map depends on that (review fix).
    lines.push(`${indent}${color.textDim(formatFocusHeaderLine(
      this.activity,
      this.expanded,
      this.now,
      contentWidth,
      this.iconStyle,
    ))}`)
    if (!this.expanded) {
      for (const line of focusCollapsedBody(this.activity, contentWidth, this.toolDisplay, this.preparingSummary)) {
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
     * handler routes by the NEAREST owner: a SECONDARY card (thinking /
     * tool / system / compaction) toggles itself, and a NON-secondary
     * process row (intermediate assistant) collapses the owner Thought.
     * The user's own messages and the FINAL assistant are NOT marked, so
     * clicking them never collapses the Thought (plan §8.8, review P2:
     * the click scope is exactly the expanded process content, never the
     * turn's persistent rows).
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
      // The INITIAL-PROMPT boundary precedes the Thought: rows before the
      // turn's FIRST direct user (injected/system context) stay in place
      // and the initial user itself stays above the Thought; every later
      // user/steer returns to its chronological position in the process
      // (plan: expanded chronology — the projection reorders, never the
      // session events). Only the FIRST direct user is the initial
      // prompt — consecutive users are queue/steer input, never a
      // multi-row initial prompt (plan: no adjacency guessing). Every
      // revealed process row carries the owner-turn collapse mark; the
      // user's rows and the FINAL assistant stay unmarked (clicking them
      // must not collapse the Thought — review P2).
      const boundary = initialPromptBoundary(group)
      for (const member of group.slice(0, boundary)) {
        out.push({ kind: 'message', message: member })
      }
      if (activity !== undefined) out.push({ kind: 'activity', activity })
      for (const member of group.slice(boundary)) {
        if (member.kind === 'user') {
          out.push({ kind: 'message', message: member })
        } else {
          if (final !== undefined && member === final.message) continue
          out.push({ kind: 'message', message: member, collapseFocusOwnerOnClick: turn })
        }
      }
      if (final !== undefined) {
        out.push(final.truncated ? { kind: 'message', message: final.message, truncated: true } : { kind: 'message', message: final.message })
      }
      continue
    }
    // Collapsed: the user's own messages stay visible (steers included)
    // and ALL of them precede the Thought (summary semantics unchanged).
    for (const member of group) {
      if (member.kind === 'user') out.push({ kind: 'message', message: member })
    }
    // The Thought disclosure follows the user rows.
    if (activity !== undefined) out.push({ kind: 'activity', activity })
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

/** The initial-prompt boundary of one turn group: the index AFTER the
 * turn's FIRST direct user row. Rows before it (injected/system context)
 * and the initial user itself stay above the Thought; every later row
 * (steers included) returns to its chronological position. 0 when the
 * turn has no user row — the Thought then leads with chronology intact
 * (never a synthetic user, never a crash). Only the FIRST direct user is
 * the initial prompt: consecutive users are queue/steer input, not a
 * multi-row initial prompt (plan: no adjacency guessing). */
function initialPromptBoundary(group: readonly TranscriptMessage[]): number {
  const firstUserIndex = group.findIndex(member => member.kind === 'user')
  return firstUserIndex < 0 ? 0 : firstUserIndex + 1
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
  // Interrupted prefixes are process evidence, never a completed/max-token
  // final answer, even when a malformed log reports a successful reason.
  if (last === undefined || last.interrupted === true || !assistantRenderable(last)) return undefined
  return { message: last, truncated: reason === 'max-tokens' }
}
