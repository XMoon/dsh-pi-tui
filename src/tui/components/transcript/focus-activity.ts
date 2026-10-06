/**
 * PiTui Focus Mode presentation: the FocusActivityComponent (the live Thought
 * disclosure) and its formatting helpers.
 *
 * The component only RENDERS — expansion state lives in TuiApp, session data in
 * the TranscriptFolder, the system-prompt policy in focus.ts and the pure
 * projection policy in `tui/transcript/focus-projection.ts`. The collapsed card
 * shows a status header (disclosure glyph + duration + per-turn token +
 * responsive tool stats) and the shared compact process slots — Think / Action
 * / Message — plus the Error line, all muted. The Action slot is the
 * presentation-only latest meaningful non-Thinking Process evidence hidden
 * under the collapsed root, selected by the shared chronology authority in
 * `tui/transcript/process-summary.ts`.
 *
 * The whale icon encodes ONLY the disclosure state; the execution state is
 * carried by the header label (`Working` / `Waiting for approval` / `Waiting
 * for input` / `Turn complete` / `Failed after` / ...), never merged into one
 * symbol (plan §2.2). The chrome shares the transcript left edge (addendum v2
 * §28): no outer indent.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/focus-activity
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { color } from '../../../theme.ts'
import { formatTokens } from '../../../token-usage.ts'
import { iconFor, type IconSemantic, type IconStyle } from '../../../icons.ts'
import {
  COMPACT_SLOT_LABEL_WIDTH,
  compactActionSlotLine,
  compactSlotLine,
  compactThinkSlotLine,
  type CompactActionPresentation,
} from './compact-process-preview.ts'
import { compactActionStatParts, formatCompactDuration, type CompactActionStats } from '../../transcript/process-summary.ts'
import { displayFailureText } from '../../../failure-presentation.ts'
import { focusTiming, type FocusTimingStore } from '../../../focus-timing.ts'
import type { RunPhase } from '../../../domain/status/types.ts'
import type { TurnActivity } from '../../../transcript.ts'

/**
 * The Focus-facing names of the SHARED compact process-preview authority
 * (`tui/components/transcript/compact-process-preview.ts`, post-F6 plan §7): the
 * Preparing summary and the duration format have exactly one
 * implementation served to Focus and Activity alike — these aliases keep
 * the historical Focus import surface stable.
 */
export { compactPreparingSummary as focusPreparingSummary } from './compact-process-preview.ts'
export type { CompactPreparingPreview as FocusPreparingPreview } from './compact-process-preview.ts'

/** Human duration from millis: seconds under a minute, `m s` above (the
 * elapsed TURN time — plan §14.2: the user waited the whole turn). The
 * FORMAT is the shared compact duration authority; the Focus policy (WHICH
 * span it measures) lives in {@link focusDurationText}. */
export function formatFocusDuration(ms: number | undefined): string | undefined {
  return formatCompactDuration(ms)
}

/** The max action-subtype names the header stats show before the `+N`
 * tail lives in the shared compact preview authority
 * (`COMPACT_ACTION_SUMMARY_MAX_TYPES`, addendum v2 §15). */

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

/** The header's base label WITHOUT the stats tail (plan §14.1): an open
 * turn names its REAL phase (`Working` / `Waiting for approval` /
 * `Waiting for input`), so a turn parked on the user never reads as
 * progress; a settled failure names its reason instead of "Turn complete". The
 * duration is omitted entirely when the turn has no reliable start
 * (plan §10.2 — never a fake `0s`). The phase comes from the authoritative
 * unified status — this formatter never re-derives approval/question state. */
export function focusStatusLabel(activity: TurnActivity, phase: RunPhase, duration: string | undefined): string {
  const time = duration === undefined ? '' : ` ${duration}`
  if (!activity.completed) {
    switch (phase) {
      case 'waiting-approval':
        return duration === undefined ? 'Waiting for approval' : `Waiting for approval · ${duration}`
      case 'waiting-question':
        return duration === undefined ? 'Waiting for input' : `Waiting for input · ${duration}`
      default:
        return `Working${time}`
    }
  }
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
      return `Turn complete${time}`
  }
}

/** The header's responsive action-stat tail parts (`7 actions`, `read ×3`,
 * …, `+1`) come from the SHARED authority (`compactActionStatParts`,
 * addendum v2 §15) — types sorted count-desc / name-asc, capped at
 * `COMPACT_ACTION_SUMMARY_MAX_TYPES`, with a `+N` remainder counting the
 * OTHER action SUBTYPES (not occurrences); an empty aggregate yields no
 * parts. There is deliberately no Focus-local alias: Focus and Activity
 * consume the one formatter. */

/** The effective duration text for one activity at `now`: the ACTIVE elapsed
 * time (user-blocked waits excluded — see focus-timing.ts), formatted. */
export function focusDurationText(
  activity: TurnActivity,
  phase: RunPhase,
  now: () => number,
  timing: FocusTimingStore = focusTiming,
): string | undefined {
  return formatFocusDuration(timing.activeMillis(activity, phase, now()))
}

/** Assemble the one-line header, dropping the stat tail progressively so
 * the header NEVER breaks the terminal (plan §14/§46; addendum v2 §21):
 * full tail → token + action total → token → bare label (then a hard
 * truncate as the last resort). The stat tail is the SHARED action-stats
 * parts — `N actions · subtype ×count` — derived turn-level by the
 * projection (never from a synthetic `TurnActivity` store). The per-turn
 * token segment is hidden entirely when the turn has no usage fact (never
 * a fake `0 tok` — plan §13.3) and remains Focus-only: Activity has no
 * trustworthy span-level token authority and never fabricates one
 * (addendum v2 §25). The disclosure glyph resolves against the CURRENT
 * icon style (the disclosure is an interaction affordance and is never
 * hidden — not even under minimal, plan §34.7); the single-space lead
 * keeps the historical `🐋 Working` layout. */
export function formatFocusHeaderLine(
  activity: TurnActivity,
  expanded: boolean,
  phase: RunPhase,
  duration: string | undefined,
  width: number,
  actionStats: CompactActionStats,
  iconStyle: IconStyle = 'emoji',
): string {
  const label = focusStatusLabel(activity, phase, duration)
  const head = `${iconFor(focusDisclosureSemantic(expanded), iconStyle)} ${label}`
  const token = activity.totalTokens === undefined ? undefined : `${formatTokens(activity.totalTokens)} tok`
  const tail = compactActionStatParts(actionStats)
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

/** The max visual rows the collapsed Message slot renders: the LATEST
 * tail rows of the bounded message text (plan: Message is the third
 * process slot and shows up to three terminal rows, always the newest
 * tail — streaming appends naturally roll toward it). */
const FOCUS_MESSAGE_MAX_ROWS = 3

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
  const lead = `${label}${' '.repeat(Math.max(0, COMPACT_SLOT_LABEL_WIDTH - visibleWidth(label)))}`
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

/** The collapsed card body: the process slots in FIXED order — Think,
 * Action, Message — then the error reason (plan §24; addendum v2 §20). Think and Action are at most ONE visual row (a RUNNING Think
 * follows its reasoning tail, a settled one reads from the start); Message
 * shows the latest up to {@link FOCUS_MESSAGE_MAX_ROWS} visual rows of its
 * bounded tail. Only existing slots render. A live Preparing display, when
 * supplied, temporarily owns the Action slot over the durable Action
 * presentation. The Action line's status prefix follows plan §10: none
 * while running, ✓ settled ok, ✗ settled error; the synthetic kinds carry
 * no prefix or their own honest one. */
export function focusCollapsedBody(
  activity: TurnActivity,
  width: number,
  action?: CompactActionPresentation,
  preparingDisplay?: string,
): string[] {
  const lines: string[] = []
  if (activity.think !== undefined) {
    // Only LIVE reasoning follows its tail (the latest token is visible);
    // once reasoning settles — even while the turn keeps running a tool or
    // later output — the preview reads from the start of its LATEST line.
    // The gate is the reasoning lifecycle fact, never `activity.completed`.
    // The line selection lives in the shared helper (post-F6 plan §8.2).
    lines.push(compactThinkSlotLine({ text: activity.think.text, running: activity.think.running, width }))
  }
  if (preparingDisplay !== undefined) {
    lines.push(compactSlotLine('Action:', preparingDisplay, width))
  } else if (action !== undefined) {
    // The shared Action slot (addendum v2 §10/§11): status prefix
    // + presenter-first tool display + active PTC sub-call suffix + width
    // degradation, or the pure synthetic labels — one authority with
    // Activity.
    lines.push(compactActionSlotLine({
      ...(action.status === undefined ? {} : { status: action.status }),
      display: action.display,
      ...(action.rootName === undefined ? {} : { rootName: action.rootName }),
      ...(action.activeSubCalls === undefined ? {} : { activeSubCalls: action.activeSubCalls }),
      width,
    }))
  }
  if (activity.message !== undefined) {
    lines.push(...previewTailLines('Message:', activity.message.text, width, FOCUS_MESSAGE_MAX_ROWS))
  }
  const reason = activity.reason
  if (reason?.kind === 'error' && reason.error !== undefined) {
    lines.push(compactSlotLine('Error:', displayFailureText(reason.error), width))
  }
  return lines
}

/**
 * The live Thought disclosure. render() re-reads `now()` on EVERY frame, so
 * the WorkingIndicator's 500ms repaint heartbeat refreshes the running
 * duration without a second timer (plan §3.2); the TuiApp component cache
 * (keyed on the activity revision + expansion + theme + the Action
 * presentation/stats signatures + icon style) keeps that cheap. The phase is
 * a LIVE provider over the authoritative unified status, never a value baked
 * at construction: an approval/question opens without minting a new
 * component, so a captured phase would freeze the header (and the timer) on
 * the old state. The component never mutates Focus state — clicks route
 * through the app's hit map to toggleFocusTurn (plan §17). The turn-level
 * Action stats and the Action line's presentation are PRECOMPUTED by the
 * app through the ONE shared bridge (addendum v2 §35) — the component stays
 * a pure renderer. The chrome shares the transcript left edge (addendum v2
 * §28): no outer indent. A collapsed Preparing summary is presentation
 * input only; expanded rows are composed by TuiApp after the projected
 * process tail.
 */
export class FocusActivityComponent {
  private readonly activity: TurnActivity
  private readonly expanded: boolean
  private readonly now: () => number
  private readonly action: CompactActionPresentation | undefined
  private readonly actionStats: CompactActionStats
  private readonly iconStyle: IconStyle
  private readonly preparingSummary: string | undefined
  private readonly phase: () => RunPhase
  private readonly timing: FocusTimingStore

  constructor(options: {
    activity: TurnActivity
    expanded: boolean
    phase?: () => RunPhase
    now?: () => number
    action?: CompactActionPresentation
    /** The turn-level action aggregate the header renders (addendum v2
     * §16) — projected once from the turn's canonical Process evidence. */
    actionStats: CompactActionStats
    iconStyle?: IconStyle
    preparingSummary?: string
    timing?: FocusTimingStore
  }) {
    this.activity = options.activity
    this.expanded = options.expanded
    this.phase = options.phase ?? (() => 'working')
    this.now = options.now ?? (() => Date.now())
    this.action = options.action
    this.actionStats = options.actionStats
    this.iconStyle = options.iconStyle ?? 'emoji'
    this.preparingSummary = options.preparingSummary
    this.timing = options.timing ?? focusTiming
  }

  /** The Component interface requires invalidate(); the component keeps no
   * render cache (duration is live per frame), so this is a no-op. */
  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = []
    const contentWidth = Math.max(1, width)
    const phase = this.phase()
    // The header formatter budgets the transcript CONTENT width (the host
    // gutter owns the horizontal geometry — addendum v2 §28), so a header
    // that fits never wraps past the terminal — the fullscreen row hit-map
    // depends on that.
    lines.push(color.textDim(formatFocusHeaderLine(
      this.activity,
      this.expanded,
      phase,
      focusDurationText(this.activity, phase, this.now, this.timing),
      contentWidth,
      this.actionStats,
      this.iconStyle,
    )))
    if (!this.expanded) {
      for (const line of focusCollapsedBody(this.activity, contentWidth, this.action, this.preparingSummary)) {
        lines.push(color.textDim(line))
      }
    }
    return lines
  }
}
