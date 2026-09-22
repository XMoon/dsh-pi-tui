/**
 * Focus Mode presentation: the FocusActivityComponent (the live Thought
 * disclosure) and its pure formatting helpers. The component only RENDERS —
 * expansion state lives in TuiApp, session data in the TranscriptFolder,
 * and the system-prompt policy in focus.ts (plan §14).
 *
 * The collapsed card shows: a status header (whale disclosure icon +
 * duration + per-turn token + responsive tool stats) and the compact
 * process slots — Think / Action / Message (Message shows the latest up to
 * three visual rows) — plus the Error line, all muted, never competing
 * with the final assistant. The Action slot is the presentation-only
 * latest meaningful non-Thinking Process evidence hidden under the
 * collapsed root (post-F6 presentation-convergence addendum v2): a genuine
 * Tool, Preparing, Retry or an orphan-result diagnostic,
 * selected by chronology from the SAME transcript rows the projection
 * hides — never a second `TurnActivity` chronology store. The expanded
 * card renders ONLY the header: the hidden process rows render below as
 * ordinary transcript messages (plan §15 — no second renderer family), and
 * inside an open Thought the foldable process cards default COMPACT with
 * their own per-card disclosure (the secondary-disclosure supplement).
 *
 * The whale icon encodes ONLY the disclosure state (🐋 collapsed / 🐳
 * expanded); the execution state is carried by the header label — an open
 * turn reads `Working` or, while parked on the user, `Waiting for
 * approval` / `Waiting for input`; a settled turn reads `Turn complete` /
 * `Failed after` / `Interrupted` / `Blocked` / `Max tokens` — two
 * orthogonal dimensions, never merged into one symbol (plan §2.2).
 * @module @xmoon76/dsh-pi-tui/focus-activity
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { color } from './theme.ts'
import { formatTokens } from './token-usage.ts'
import { iconFor, type IconSemantic, type IconStyle } from './icons.ts'
import {
  COMPACT_SLOT_LABEL_WIDTH,
  addCompactActionStats,
  compactActionSlotLine,
  compactActionSourceOf,
  compactActionStatParts,
  compactSlotLine,
  compactThinkSlotLine,
  formatCompactDuration,
  latestCompactAction,
  newCompactActionStats,
  type CompactActionPresentation,
  type CompactActionSource,
  type CompactActionStats,
  type CompactActionStatsAccumulator,
} from './compact-process-preview.ts'
import { assistantBlocksVisibleNow, assistantCommittedBeforeSteer, assistantLatestStepOf, assistantStepOf, type TurnActivity, type TranscriptMessage } from './transcript.ts'
import { isSurfacedInteractionTool, isSurfacedContext } from './transcript-semantics.ts'
import { isNoticeContext } from './context-presentation.ts'
import { projectTranscriptStructure, type TranscriptStructureBlock, type TranscriptWorkSpan } from './transcript-projection.ts'
import type { TranscriptContainerPath } from './transcript-disclosure.ts'
import { displayFailureText } from './failure-presentation.ts'
import { focusTiming, type FocusTimingStore } from './focus-timing.ts'
import type { RunPhase } from './status/types.ts'

/**
 * The Focus-facing names of the SHARED compact process-preview authority
 * (`compact-process-preview.ts`, post-F6 plan §7): the slot geometry, the
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

/**
 * The Focus presentation projection over one windowed transcript (plan
 * §12/§33): a turn with an initial prompt is grouped as
 * `user(s) → FocusActivity`; a turn with only same-turn steers starts with
 * `FocusActivity` and keeps those steers in process order. A turn woken by
 * injected-context keeps that LEADING prefix at its original foundation
 * position before the Thought. Expanded process/final and compaction rows
 * follow, so the raw TranscriptMessage union is never polluted with a fake
 * `focus-activity` kind and the session data stays lossless.
 *
 * Collapsed turns HIDE process rows — thinking, tool, ordinary system/process
 * rows and ordinary intermediate-assistant — so they cannot leak through
 * Ctrl+O/Alt+T (plan §15.2). A committed pre-steer answer is the explicit
 * persistent-row exception. Human user rows and injected context marked
 * `context:true` are persistent input/context rows and remain visible before
 * the Thought in their raw relative order. The final assistant only appears
 * after the authoritative `turn/end` (plan §13.1) and never duplicates in the
 * expanded view (it stays at its chronological position).
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
     * The outer-to-inner semantic container ancestry of this row, generated by
     * the projection that produced it (never inferred from screen geometry). A
     * row revealed by an expanded Thought carries `[focus-root]`; a row inside
     * a nested canonical Work span carries `[focus-root, work]`. Persistent
     * input rows (user / surfaced context / settled interaction) and the held
     * back final carry NO path — they are not owned by the Thought.
     */
    containerPath?: TranscriptContainerPath
  }
  | {
    kind: 'activity'
    activity: TurnActivity
    /**
     * The presentation OCCURRENCE identity of this Thought block: the first
     * `TranscriptMessage` of the consecutive same-turn run it summarizes.
     * A turn is NOT a sufficient identity — a turn-less window entry can
     * split one turn into several runs, each with its own hidden rows, Action
     * winner and component. This is the same stable occurrence-owner pattern
     * the Work span and Context cluster already use; the SEMANTIC disclosure
     * identity (Ctrl+O, click ownership, `focusExpandedTurns`,
     * `containerPath`) stays the turn number.
     */
    owner: TranscriptMessage
    /**
     * The turn-level Action aggregate the Focus header renders (addendum v2
     * §17/§18): derived ONCE from the turn group's canonical Process
     * evidence — independent of collapsed/expanded state, search reveals
     * and forced-visible rows (a temporary reveal must not change `7
     * actions`). Presentation-only: never stored on `TurnActivity`, never
     * persisted.
     */
    actionStats: CompactActionStats
    /**
     * The presentation-only collapsed Action source (addendum v2
     * §19): derived from the SAME transcript rows this projection hides
     * under the collapsed Thought root — never stored on `TurnActivity`
     * (§14). Absent when no eligible hidden Process evidence exists (or
     * the Thought is expanded, where no preview body renders).
     */
    action?: CompactActionSource
  }
  | {
    /**
     * A canonical Work span materialized inside the expanded Thought. F6 keeps
     * the span as a container (instead of flattening its members) so the owner
     * is preset-neutral and the Work header can be disclosed independently.
     */
    kind: 'work'
    span: TranscriptWorkSpan
    focusOwnerTurn: number
    /** The outer-to-inner ancestor of the Work container (set when TuiApp
     * materializes the nested header). */
    containerPath?: TranscriptContainerPath
  }

/**
 * The Focus projection TURN of one row — the ONE authority `projectFocus` and
 * its grouping helpers share. A COMMAND row has NO projection turn: it is a
 * turn-less control-plane row (`kind: 'command'` carries no `turn` field at
 * all). A CORRELATED manual compaction is turn-less too: once its combined
 * `/compact` owner is established it is a standalone control boundary, so the
 * projection must not re-absorb the card into the preceding turn group — the
 * collapsed Focus reorder would otherwise lift it above the turn's held-back
 * final and invert the real chronology (`assistant final` → `Context
 * compacted`). Treating turn-less rows as BOUNDARIES makes the projection
 * agree with the fold: `process A -> Thought A`, `command -> standalone`,
 * `process B -> Thought B`. Both runs may still belong to one model turn (the
 * run-owner component cache supports that), and the semantic disclosure
 * identity stays the turn number.
 */
function focusProjectionTurnOf(message: TranscriptMessage): number | undefined {
  if (message.kind === 'command') return undefined
  if (message.kind === 'compaction' && message.sourceCommand !== undefined) return undefined
  return 'turn' in message ? message.turn : undefined
}

/**
 * The Thought block for one turn: the caller-resolved TURN-LEVEL Action
 * stats (addendum v2 §18) plus — collapsed only (`hidden !== undefined`) —
 * the presentation-only Action source. `latestCompactAction` picks the
 * latest eligible candidate among EXACTLY the rows the collapsed projection
 * hides under the root, so nothing already visible outside (a
 * forced-visible search row, a committed answer, the held-back final) can
 * duplicate itself in the Action slot.
 */
function focusActivityBlock(
  activity: TurnActivity | undefined,
  owner: TranscriptMessage,
  actionStats: CompactActionStats,
  hidden: readonly TranscriptMessage[] | undefined,
): FocusProjectedBlock[] {
  if (activity === undefined) return []
  const action = hidden === undefined ? undefined : latestCompactAction(hidden)
  return [action === undefined
    ? { kind: 'activity', activity, owner, actionStats }
    : { kind: 'activity', activity, owner, actionStats, action }]
}

/** The empty action aggregate for a turn with no eligible Process evidence:
 * shared so the absent case allocates nothing per block. */
const EMPTY_ACTION_STATS: CompactActionStats = { total: 0, types: new Map() }

/**
 * One linear pass over the window: each turn's WHOLE-TURN action aggregate
 * (addendum v2 §18). Focus stats describe the turn, not the row run: a
 * turn-less entry can split one turn into separate consecutive runs
 * ({@link consecutiveTurnGroup}), and every Thought block of that turn must
 * still report the same turn-level number — never merely its own run's.
 * A search reveal / forced-visible row / disclosure state cannot change it
 * because none of them participate here. O(n) once per projection, never a
 * per-frame rescan of an unchanged window.
 */
function focusActionStatsByTurn(messages: readonly TranscriptMessage[]): Map<number, CompactActionStats> {
  const accumulators = new Map<number, CompactActionStatsAccumulator>()
  for (const message of messages) {
    if (!('turn' in message)) continue
    const source = compactActionSourceOf(message)
    if (source === undefined) continue
    let accumulator = accumulators.get(message.turn)
    if (accumulator === undefined) {
      accumulator = newCompactActionStats()
      accumulators.set(message.turn, accumulator)
    }
    addCompactActionStats(accumulator, source)
  }
  const byTurn = new Map<number, CompactActionStats>()
  for (const [turn, accumulator] of accumulators) byTurn.set(turn, accumulator)
  return byTurn
}

/**
 * Project one transcript window into Focus presentation blocks. Collapsed
 * Focus summarizes causal input and opening foundation around the Thought;
 * `forcedVisible` carries the temporary search reveal for a row the collapsed
 * view would otherwise hide (a mid-turn notice) — it surfaces that exact row
 * without opening the Thought and without becoming a disclosure owner.
 */
export function projectFocus(
  messages: readonly TranscriptMessage[],
  activities: ReadonlyMap<number, TurnActivity>,
  expandedTurns: ReadonlySet<number>,
  focusMode: boolean,
  forcedVisible?: ReadonlySet<TranscriptMessage>,
): FocusProjectedBlock[] {
  if (!focusMode) return messages.map(message => ({ kind: 'message', message }))
  const actionStatsByTurn = focusActionStatsByTurn(messages)
  const out: FocusProjectedBlock[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    const turn = focusProjectionTurnOf(message)
    if (turn === undefined) {
      // Window summaries, standalone command rows and other turn-less entries
      // pass through as standalone blocks (a command acts as a Process-run
      // boundary, so the surrounding Thought runs stay separate).
      out.push({ kind: 'message', message })
      index += 1
      continue
    }
    // One turn's consecutive message run.
    const group = consecutiveTurnGroup(messages, index, turn)
    index += group.length
    const activity = activities.get(turn)
    const actionStats = actionStatsByTurn.get(turn) ?? EMPTY_ACTION_STATS
    const expanded = expandedTurns.has(turn)
    // The final assistant is decided ONCE from the exact last assistant
    // row (shared by the expanded and collapsed branches — one semantic,
    // never two drifting copies).
    const final = finalAssistantSelection(activity, group)
    const isCommittedAnswer = (member: TranscriptMessage): boolean =>
      activity !== undefined && assistantCommittedBeforeSteer(activity, member)
    if (expanded) {
      // The open Thought reveals the FULL process in ORIGINAL order —
      // compaction cards included at their chronological position — with
      // the final assistant held back and appended LAST (a max-tokens
      // turn's `max tokens reached` system row must never land after the
      // final: the settled order is User → Thought → process → final).
      // The THOUGHT-LEAD boundary precedes the Thought: rows before the
      // turn's FIRST non-steer user (injected context) stay in place
      // and that initial user itself stays above the Thought; every later
      // user/steer or surfaced-context row returns to its chronological
      // position (plan: expanded chronology — the projection reorders, never
      // the session events). With a non-steer user, the first such row is the
      // compatibility boundary; when every user is a steer, the boundary
      // falls back to the end of the LEADING injected-context prefix, so an
      // inject-woken turn keeps its foundation before the Thought (never a
      // scan of mid-process system rows). Consecutive users after the
      // boundary stay in chronological order; they are not a multi-row
      // initial prompt (plan: no adjacency guessing). Every revealed
      // ordinary process row carries the owner-turn collapse mark; committed
      // pre-steer answers, user rows, surfaced context, lead foundation rows,
      // and the FINAL assistant stay unmarked (clicking them must not collapse
      // the Thought — review P2).
      const boundary = focusThoughtLeadBoundary(group)
      for (const member of group.slice(0, boundary)) {
        out.push({ kind: 'message', message: member })
      }
      if (activity !== undefined) out.push(...focusActivityBlock(activity, group[0]!, actionStats, undefined))
      const emitTailRow = (member: TranscriptMessage): void => {
        if (isFocusPersistentInputRow(member)) {
          out.push({ kind: 'message', message: member })
          return
        }
        if (final !== undefined && member === final.message) return
        if (isCommittedAnswer(member)) {
          out.push({ kind: 'message', message: member })
          return
        }
        out.push({ kind: 'message', message: member, containerPath: [{ kind: 'focus-root', turn }] })
      }
      // The tail consumes the SAME canonical segmentation as Compact/Full
      // (`transcript-projection.ts`), computed over the UNFILTERED tail so the
      // held-back final never changes raw adjacency. A canonical Work span is
      // emitted as a nested container block (F6) and materialized by TuiApp
      // according to the effective Work disclosure; the TuiApp cluster
      // substitution consumes the same canonical cluster identity at its
      // Focus-projected position.
      for (const block of focusExpandedTailStructure(group, boundary)) {
        if (block.kind === 'work') {
          out.push({ kind: 'work', span: block.span, focusOwnerTurn: turn })
        } else if (block.kind === 'context-cluster') {
          for (const member of block.cluster.members) emitTailRow(member)
        } else {
          emitTailRow(block.message)
        }
      }
      if (final !== undefined) {
        out.push(final.truncated ? { kind: 'message', message: final.message, truncated: true } : { kind: 'message', message: final.message })
      }
      continue
    }
    // Collapsed Focus summarizes persistent input/context rows before the
    // Thought in their raw relative order. Both human user/steer rows and
    // injected context marked `context:true` are persistent; all ordinary
    // process rows stay hidden inside the Thought. A committed pre-steer answer
    // is the one exception: from that exact raw boundary onward, preserve the
    // persistent rows and answer in chronology so the answer cannot be swallowed
    // by the Thought or move when the disclosure changes. A MID-TURN
    // `form:'notice'` is the other exception (see
    // {@link isCollapsedFocusVisibleRow}): it is process feedback and hides
    // inside the Thought, while an opening-foundation notice stays visible.
    //
    // The collapsed Action source (addendum v2 §19/§42) is selected
    // from EXACTLY the rows this projection hides under the Thought root —
    // the emit loops below record them — so a forced-visible search row, a
    // committed answer, the held-back final and every persistent boundary
    // can never duplicate themselves in the Action slot.
    const leadBoundary = focusThoughtLeadBoundary(group)
    const firstCommittedIndex = group.findIndex(isCommittedAnswer)
    const hidden: TranscriptMessage[] = []
    if (firstCommittedIndex < 0) {
      for (let index = 0; index < group.length; index += 1) {
        const member = group[index]!
        if (isCollapsedFocusVisibleRow(member, index, leadBoundary) || forcedVisible?.has(member) === true) {
          out.push({ kind: 'message', message: member })
        } else if (member.kind !== 'compaction' && member !== final?.message) {
          hidden.push(member)
        }
      }
      out.push(...focusActivityBlock(activity, group[0]!, actionStats, hidden))
      // Compaction cards keep their existing lifecycle in the collapsed
      // view (plan §12.3 v1 — never hidden into the Thought).
      for (const member of group) {
        if (member.kind === 'compaction') out.push({ kind: 'message', message: member })
      }
    } else {
      const beforeCommitted = group.slice(0, firstCommittedIndex)
      for (let index = 0; index < beforeCommitted.length; index += 1) {
        const member = beforeCommitted[index]!
        if (isCollapsedFocusVisibleRow(member, index, leadBoundary) || forcedVisible?.has(member) === true) {
          out.push({ kind: 'message', message: member })
        } else if (member.kind !== 'compaction') {
          hidden.push(member)
        }
      }
      // The post-boundary emission is decided FIRST (pure) so the Action
      // selection sees the whole hidden scope before the Thought renders.
      const postCommitted: TranscriptMessage[] = []
      for (let index = firstCommittedIndex; index < group.length; index += 1) {
        const member = group[index]!
        if (final !== undefined && member === final.message) continue
        if (isCollapsedFocusVisibleRow(member, index, leadBoundary)
          || forcedVisible?.has(member) === true
          || member.kind === 'compaction' || isCommittedAnswer(member)) {
          postCommitted.push(member)
        } else {
          hidden.push(member)
        }
      }
      out.push(...focusActivityBlock(activity, group[0]!, actionStats, hidden))
      for (const member of beforeCommitted) {
        if (member.kind === 'compaction') out.push({ kind: 'message', message: member })
      }
      for (const member of postCommitted) {
        out.push({ kind: 'message', message: member })
      }
    }
    // The collapsed final: only after the authoritative turn/end.
    if (final !== undefined) {
      out.push(final.truncated ? { kind: 'message', message: final.message, truncated: true } : { kind: 'message', message: final.message })
    }
  }
  return out
}

/**
 * The canonical structural blocks the expanded Focus TAIL consumes: one turn
 * group from its Thought-lead boundary onward. The held-back final is included,
 * so cluster membership is computed from exactly the raw adjacency the window
 * would give. `projectFocus` emits a canonical Work span as a nested `work`
 * block (F6); this exported seam lets the convergence oracle compare
 * Work/cluster boundary IDENTITY (owner and member objects) instead of display
 * strings (plan §25).
 * @param group - one turn's consecutive raw messages.
 * @param boundary - the group's Thought-lead boundary ({@link focusThoughtLeadBoundary}).
 *   Passed in so one expanded group computes the boundary once.
 */
export function focusExpandedTailStructure(group: readonly TranscriptMessage[], boundary: number): TranscriptStructureBlock[] {
  return projectTranscriptStructure(group.slice(boundary))
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

/** Rows that remain visible outside the collapsed Thought as persistent
 * input/context boundaries. The semantic class stays Context for injected
 * rows; this predicate only controls disclosure behavior. A SETTLED
 * surfaced-interaction card (question / Plan review) is human-decision
 * evidence, so it is hoisted out of the collapsed Working exactly like a
 * user/steer row; expanded Focus restores it at its raw chronology. */
function isFocusPersistentInputRow(message: TranscriptMessage): boolean {
  // A COMMAND is standalone `control` evidence, not Process: it is a
  // turn-less session-level lifecycle whose settled result is user feedback.
  // It must therefore stay VISIBLE outside the collapsed Thought — like a
  // user/steer row or a settled interaction — instead of being hidden as
  // process and/or claimed by the Thought's Action slot.
  return message.kind === 'user' || isSurfacedContext(message) || isSurfacedInteractionTool(message)
    || message.kind === 'command'
}

/**
 * Whether one row stays visible OUTSIDE the collapsed Thought. Position-aware:
 * a MID-TURN `form:'notice'` is process feedback (a background job settling
 * while the Agent already works), not causal input, so it is hidden inside the
 * collapsed Thought and restored in raw chronology when the Thought opens. A
 * notice inside the turn's OPENING foundation (`index < leadBoundary`) explains
 * why the turn started and stays visible, exactly like users/steers, opening
 * ambient Context and mid-turn relays. The decision is positional (raw
 * chronology) plus semantic (`form`), never a source-name heuristic; `Compact`
 * and `Full` do not route through here.
 * @param message - the raw transcript row.
 * @param index - its index in the raw turn group.
 * @param leadBoundary - the turn's Thought-lead boundary (see {@link focusThoughtLeadBoundary}).
 */
function isCollapsedFocusVisibleRow(message: TranscriptMessage, index: number, leadBoundary: number): boolean {
  if (!isFocusPersistentInputRow(message)) return false
  return !(index >= leadBoundary && isNoticeContext(message))
}

/**
 * One turn's maximal run of CONSECUTIVE same-turn rows starting at `start`.
 * A turn-less entry (window summary) may SPLIT a turn into separate runs, and
 * the projection folds each run independently — this helper is shared by the
 * projection and the collapsed visibility predicate so their index and
 * `focusThoughtLeadBoundary` math can never diverge on a non-monotonic window.
 * @param messages - the transcript window.
 * @param start - the run's first index.
 * @param turn - the run's turn number.
 */
function consecutiveTurnGroup(messages: readonly TranscriptMessage[], start: number, turn: number): TranscriptMessage[] {
  const group: TranscriptMessage[] = [messages[start]!]
  let index = start + 1
  while (index < messages.length) {
    const next = messages[index]!
    // `focusProjectionTurnOf` — never the raw `turn` — so a turn-less
    // standalone row cannot join (or split) the run it merely sits in.
    if (focusProjectionTurnOf(next) !== turn) break
    group.push(next)
    index += 1
  }
  return group
}

/**
 * Whether collapsed Focus hides one row inside the Thought (a mid-turn
 * `form:'notice'`). The temporary search reveal reads this to force EXACTLY
 * that row visible without opening the Thought and without minting a manual
 * disclosure owner; the positional decision uses the SAME consecutive-run
 * grouping as the projection ({@link consecutiveTurnGroup} +
 * {@link focusThoughtLeadBoundary}), never a source-name check.
 * @param messages - the current transcript window.
 * @param message - the row to test.
 */
export function isCollapsedFocusHiddenRow(messages: readonly TranscriptMessage[], message: TranscriptMessage): boolean {
  if (!isSurfacedContext(message) || !isNoticeContext(message) || !('turn' in message)) return false
  const position = messages.indexOf(message)
  if (position < 0) return false
  // Walk back to the start of the CONSECUTIVE run the projection would group,
  // with the SAME projection-turn authority (a command row is a boundary —
  // it is a real turn-less `kind: 'command'` node).
  let start = position
  while (start > 0) {
    const previous = messages[start - 1]!
    if (focusProjectionTurnOf(previous) !== focusProjectionTurnOf(message)) break
    start -= 1
  }
  const group = consecutiveTurnGroup(messages, start, message.turn)
  const index = position - start
  return !isCollapsedFocusVisibleRow(message, index, focusThoughtLeadBoundary(group))
}

/** The end of the turn's LEADING injected-context prefix used only for
 * expanded Thought insertion. Consecutive `kind === 'system'` rows carrying
 * the source-derived `context` marker at the very start of the group count as
 * the opening turn foundation. Other `kind: 'system'` rows (llm/retry,
 * max-tokens) are orchestration, not foundation — they must stay process
 * content, never lifted before the Thought. Mid-process system rows are never
 * included in this expanded lead boundary; collapsed visibility uses
 * isFocusPersistentInputRow instead. */
function leadingInjectedContextPrefixEnd(group: readonly TranscriptMessage[]): number {
  let end = 0
  while (true) {
    const member = group[end]
    if (member === undefined || member.kind !== 'system' || member.context !== true) break
    end += 1
  }
  return end
}

/** The Thought-lead boundary of one turn group: the index AFTER the
 * turn's FIRST unmarked user row AND the surfaced Context rows that
 * immediately follow it. Rows before it (injected context) and the opening
 * foundation (initial user plus its adjacent injected context) stay above the
 * Thought; every later row (same-turn steers included) returns to its
 * chronological position. A turn whose user rows are all marked same-turn
 * steers has no opening human prompt: the boundary falls back to the end of
 * the LEADING injected-context prefix, so an inject-woken turn keeps its
 * foundation before the Thought (never a scan of mid-process system rows, and
 * never orchestration rows like llm/retry). Without steer metadata, the first
 * user remains the initial-prompt fallback; consecutive users are queue/steer
 * input, not a multi-row initial prompt. */
export function focusThoughtLeadBoundary(group: readonly TranscriptMessage[]): number {
  const firstInitialUserIndex = group.findIndex(
    member => member.kind === 'user' && member.steer !== true,
  )
  let end = firstInitialUserIndex >= 0
    ? firstInitialUserIndex + 1
    : leadingInjectedContextPrefixEnd(group)
  // The opening foundation continues through immediately-following surfaced
  // Context rows (the provider's opening snapshot/catalog burst), so it never
  // lands below the Thought. A later Context row separated by Process rows is
  // mid-turn and keeps its chronological position.
  while (true) {
    const member = group[end]
    if (member === undefined || !isSurfacedContext(member)) break
    end += 1
  }
  return end
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

/** The turn's final assistant selection: only after the authoritative
 * turn/end, only for a reason the system presents output (completed /
 * max-tokens), and only when the Assistant owning the structural latest step
 * has semantic/finalized content or explicit delivered files. An empty or
 * pending latest step without either yields NO final — never an earlier assistant
 * (review fix). The max-tokens final carries
 * the truncated marker (plan §13.8). */
function finalAssistantSelection(
  activity: TurnActivity | undefined,
  group: readonly TranscriptMessage[],
): { message: Extract<TranscriptMessage, { kind: 'assistant' }>; truncated: boolean } | undefined {
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
