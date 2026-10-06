/**
 * Compact Activity span presentation: the collapsed `Activity` card (header
 * + Think / Action previews) and its pure summary model.
 *
 * One Activity span is the user-visible identity of a presentation-only
 * contiguous Process run (see `compact-projection.ts`): the INTERNAL owner
 * kind stays `work` (`TranscriptWorkSpan`), while the USER-VISIBLE container
 * name is `Activity` (post-F6 plan §3.3/§6.1 — no internal rename). This
 * module derives the span's OWN aggregate facts — the shared Action stats,
 * the latest reasoning tail, the latest meaningful Action and the span-local
 * wall-clock timing — never the whole turn's `TurnActivity` counts (the span
 * is not the turn). The collapsed card consumes the SHARED compact process
 * preview (`compact-process-preview.ts`) and the existing presenter-first
 * tool display; it has NO Message slot because Assistant intermediate
 * narration stays visible outside Activity. The Action slot is
 * presentation-only (post-F6 presentation-convergence addendum v2): the
 * latest eligible non-Thinking TURN-OWNED Process evidence — genuine Tool,
 * Preparing, Retry or an orphan-result diagnostic — selected purely by
 * chronology, while a command row (session-level standalone evidence) and a
 * subagent descriptor (child identity metadata) are never members and never
 * join an Activity. The header's `N actions · subtype`
 * stats use the SAME shared cardinality rules as the Focus header. Activity
 * carries NO identity icon (the disclosure marker + name identify it) and
 * its chrome shares the transcript left edge (no outer indent).
 * @module @xmoon76/dsh-pi-tui/compact-work
 */

import { truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { TranscriptWorkSpan } from './tui/transcript/structure.ts'
import {
  addCompactActionStats,
  compactActionSlotLine,
  compactActionSourceOf,
  compactActionStatParts,
  compactSlotLine,
  compactThinkSlotLine,
  formatCompactDuration,
  newCompactActionStats,
  type CompactActionPresentation,
  type CompactActionSource,
  type CompactActionStats,
} from './compact-process-preview.ts'
import { iconLead, sectionDisclosureSemantic, type IconStyle } from './icons.ts'
import { color } from './theme.ts'
import { THINKING_TAIL_CAP, transcriptTimingOf, type TranscriptTiming } from './transcript.ts'

/** The span-local aggregate facts the collapsed Activity card renders. */
export interface CompactWorkSummary {
  /** The span's shared Action stats (addendum v2 §22/§23): genuine
   * `tool/call` cardinality by `callCount`, plus one per retry occurrence —
   * aggregated in the SAME single member walk, with the same authority the
   * Focus header uses. An orphan result adds nothing, and neither a command
   * row nor a subagent descriptor (child identity metadata) is ever a
   * member. */
  readonly actionStats: CompactActionStats
  /** The latest reasoning member's bounded tail + live lifecycle fact. */
  readonly think?: { readonly text: string; readonly running: boolean }
  /** The LATEST eligible non-Thinking Process evidence of the span — the
   * presentation-only collapsed Action source (addendum v2 §23).
   * Chronology owns selection: a chronologically-later retry overwrites an
   * earlier genuine tool without touching the stats. */
  readonly action?: CompactActionSource
  /** The span-local wall-clock span of the members' OWN timed Process
   * evidence (post-F6 plan §12.12) — absent when no member carries
   * reliable timing (unknown is omitted, never `0s`). */
  readonly timing?: TranscriptTiming
}

/**
 * Derive one Activity span's aggregate facts from its own members, in raw
 * order. The LAST reasoning member owns the Think slot; the LAST eligible
 * non-Thinking Process member owns the presentation-only Action slot
 * (addendum v2 §23 — chronology decides, never a per-type
 * priority). The Action stats and the Action winner come from the ONE
 * shared classifier in the SAME single walk (addendum v2 §23): a genuine
 * tool contributes its `callCount` (a merged read group of two reads is
 * TWO actions), a retry row contributes one action of its own subtype, an
 * orphan result contributes nothing, and
 * a surfaced-interaction tool (question / Plan review) contributes and
 * presents nothing (its interaction surface owns it). Timing aggregates the
 * members' OWN sidecar evidence in the same walk — earliest start, latest
 * end, any running — never a second scan (post-F6 plan §12.12).
 * @param span - the presentation-only Activity (Work) span.
 */
export function summarizeWorkSpan(span: TranscriptWorkSpan): CompactWorkSummary {
  const actionStats = newCompactActionStats()
  let think: CompactWorkSummary['think']
  let action: CompactActionSource | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  let running = false
  for (const member of span.members) {
    // Span-local wall timing from the member's OWN sidecar evidence
    // (post-F6 plan §12.2/§12.12): point rows simply have
    // start === end; members without evidence contribute nothing.
    const memberTiming = transcriptTimingOf(member)
    if (memberTiming !== undefined) {
      startedAt = startedAt === undefined ? memberTiming.startedAt : Math.min(startedAt, memberTiming.startedAt)
      if (memberTiming.endedAt !== undefined) {
        endedAt = endedAt === undefined ? memberTiming.endedAt : Math.max(endedAt, memberTiming.endedAt)
      }
      running = running || memberTiming.running
    }
    if (member.kind === 'thinking') {
      // The preview carries the BOUNDED tail only (post-F6 plan §8.3/§20):
      // the summary — and therefore the component-cache signature — must
      // never hold (or re-hash) the full ever-growing reasoning body.
      think = {
        text: member.text.length > THINKING_TAIL_CAP ? member.text.slice(-THINKING_TAIL_CAP) : member.text,
        running: member.running === true,
      }
      continue
    }
    // One shared classifier serves the stats cardinality AND the Action
    // slot (addendum v2 §8/§23): `tool` kinds are exactly the
    // genuine-call rows, and every other eligible kind (retry / orphan)
    // carries its own subtype. A subagent descriptor and a command row are
    // excluded by the classifier entirely.
    const source = compactActionSourceOf(member)
    if (source === undefined) continue
    addCompactActionStats(actionStats, source)
    action = source
  }
  return {
    actionStats,
    ...think === undefined ? {} : { think },
    ...action === undefined ? {} : { action },
    ...(startedAt === undefined ? {} : {
      timing: {
        startedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
        running,
      },
    }),
  }
}

/**
 * The one-line Activity header (post-F6 plan §6.3; addendum v2 §22): the
 * Focus information hierarchy `<identity> <duration> · <stats>` — the
 * duration sits directly beside the identity (never `· 18s`), the stat tail
 * follows the `·` separator, and zero facts are omitted (never a fake `0
 * actions`). The identity is the disclosure marker + the name ONLY —
 * Activity carries no style-resolved identity icon (addendum v2 §26/§27),
 * so every icon style reads `▸ Activity`. The stats are the SHARED action
 * parts (`3 actions · read ×2 · bash ×1`), never a token segment (the
 * span has no trustworthy token authority — addendum v2 §25). Degradation
 * drops the LAST stat first and keeps the duration with the identity to
 * the end, so the header NEVER wraps.
 *
 * The identity is `Thought` ONLY for the historical think-only span (the
 * 2026-09-29 compact historical compaction plan §2.2): a settled Work with
 * reasoning and NO Action evidence at all — neither an Action presentation
 * source (an orphan tool result owns the collapsed Action slot while
 * counting zero actions) nor a counted action — whose collapsed preview is
 * hidden renders `Thought <duration>` instead of a semantically empty
 * `Activity` — a presentation-only identity over the SAME
 * `TranscriptWorkSpan`, reusing the exact Activity width-degradation ladder
 * (§5.1D: no second algorithm).
 */
export type CompactWorkHeaderIdentity = 'activity' | 'thought'

export function formatWorkHeaderLine(
  summary: CompactWorkSummary,
  expanded: boolean,
  width: number,
  iconStyle: IconStyle = 'emoji',
  durationText?: string,
  identity: CompactWorkHeaderIdentity = 'activity',
): string {
  const head = `${iconLead(sectionDisclosureSemantic(expanded), iconStyle)}${identity === 'thought' ? 'Thought' : 'Activity'}`
  const parts = compactActionStatParts(summary.actionStats)
  // The degradation ladder: full → … → action total → identity + duration
  // → identity.
  const candidates: string[] = []
  for (let keep = parts.length; keep >= 1; keep -= 1) {
    const stats = parts.slice(0, keep).join(' · ')
    candidates.push(durationText === undefined
      ? `${head} · ${stats}`
      : `${head} ${durationText} · ${stats}`)
  }
  candidates.push(durationText === undefined ? head : `${head} ${durationText}`)
  candidates.push(head)
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= width) return candidate
  }
  return truncateToWidth(head, Math.max(1, width), '…')
}

/**
 * The collapsed Activity body: the Think slot (latest reasoning line, one
 * visual row) then the Action slot (latest meaningful non-Thinking Process
 * evidence, one visual row). Only existing slots render — a span with
 * neither reasoning nor an Action source renders no body rows and no empty
 * placeholder. A live Preparing summary, when supplied, temporarily owns the
 * Action slot over the durable source (the streaming call is the current
 * fact — addendum v2 §34).
 */
export function compactWorkBody(
  summary: CompactWorkSummary,
  width: number,
  action?: CompactActionPresentation,
  preparingSummary?: string,
): string[] {
  const lines: string[] = []
  if (summary.think !== undefined) {
    lines.push(compactThinkSlotLine({ text: summary.think.text, running: summary.think.running, width }))
  }
  if (preparingSummary !== undefined) {
    lines.push(compactSlotLine('Action:', preparingSummary, width))
  } else if (action !== undefined) {
    lines.push(compactActionSlotLine({
      ...(action.status === undefined ? {} : { status: action.status }),
      display: action.display,
      ...(action.rootName === undefined ? {} : { rootName: action.rootName }),
      ...(action.activeSubCalls === undefined ? {} : { activeSubCalls: action.activeSubCalls }),
      width,
    }))
  }
  return lines
}

/** The span's duration text at `now`: running spans read the wall clock at
 * RENDER time (the shared repaint heartbeat refreshes them — no per-card
 * timer, post-F6 plan §12.13); settled spans use their authoritative end.
 * Missing evidence omits the duration (never `0s`, §12.16) — a POINT-only
 * span (one instant of evidence, start === end) is not a span and omits it
 * too. */
function activityDurationText(summary: CompactWorkSummary, now: () => number): string | undefined {
  const timing = summary.timing
  if (timing === undefined) return undefined
  if (timing.running) return formatCompactDuration(Math.max(0, now() - timing.startedAt))
  if (timing.endedAt === undefined || timing.endedAt === timing.startedAt) return undefined
  return formatCompactDuration(Math.max(0, timing.endedAt - timing.startedAt))
}

/**
 * The collapsed/expanded Activity disclosure header. The component only
 * RENDERS: expansion state and the precomputed Action presentation live in
 * TuiApp, and the expanded member rows are composed by the existing message
 * renderers after the header (the Activity root is never a replacement
 * renderer for its children). The chrome shares the transcript left edge
 * (addendum v2 §28): no outer indent, so collapsed and expanded rows align
 * on one boundary. The `now` provider is re-read on EVERY frame so a
 * running span's duration advances with the existing repaint heartbeat —
 * never a per-card timer (post-F6 plan §12.13).
 */
export class CompactWorkComponent implements Component {
  private readonly summary: CompactWorkSummary
  private readonly expanded: boolean
  private readonly action: CompactActionPresentation | undefined
  private readonly preparingSummary: string | undefined
  private readonly showPreview: boolean
  private readonly iconStyle: IconStyle
  private readonly now: () => number

  constructor(options: {
    span: TranscriptWorkSpan
    expanded: boolean
    summary?: CompactWorkSummary
    action?: CompactActionPresentation
    preparingSummary?: string
    showPreview?: boolean
    iconStyle?: IconStyle
    now?: () => number
  }) {
    this.summary = options.summary ?? summarizeWorkSpan(options.span)
    this.expanded = options.expanded
    this.action = options.action
    this.preparingSummary = options.preparingSummary
    // The presentation authority (TuiApp) owns the latest/live policy; the
    // dumb renderer defaults to showing the preview so unit tests and
    // non-TuiApp callers keep the original contract.
    this.showPreview = options.showPreview ?? true
    this.iconStyle = options.iconStyle ?? 'emoji'
    this.now = options.now ?? (() => Date.now())
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width)
    // `Thought` is derived from the SAME facts that hide the preview (the
    // 2026-09-29 plan §2.2): historical + think present + no Action evidence
    // at all. The Action check reads the presentation source, not the stats:
    // an orphan tool result owns the collapsed Action slot
    // (`Action: Unpaired tool result`) while deliberately counting as zero
    // actions, so such a span is NOT think-only and stays `Activity`. It
    // never depends on `expanded` — a manually opened historical span keeps
    // the `Thought` identity (no Thought → Activity jump, §2.4).
    const historicalThinkOnly =
      !this.showPreview
      && this.summary.think !== undefined
      && this.summary.action === undefined
      && this.summary.actionStats.total === 0
    const header = formatWorkHeaderLine(
      this.summary,
      this.expanded,
      contentWidth,
      this.iconStyle,
      activityDurationText(this.summary, this.now),
      historicalThinkOnly ? 'thought' : 'activity',
    )
    const lines = [color.textDim(header)]
    if (!this.expanded && this.showPreview) {
      for (const line of compactWorkBody(this.summary, contentWidth, this.action, this.preparingSummary)) {
        lines.push(color.textDim(line))
      }
    }
    return lines
  }
}
