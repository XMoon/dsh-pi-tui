/**
 * PiTui Compact Activity card: the collapsed `Activity` header, its Think /
 * Action preview body and the component wrapper.
 *
 * The span's aggregate facts are derived by the renderer-neutral
 * `tui/transcript/work-summary.ts`; this module only decides how they are
 * painted at the CURRENT width (the header's degradation ladder, the shared
 * compact process slots, the live duration re-read and the `Thought` identity
 * for the historical think-only span). The expanded member rows are composed by
 * the existing message renderers after the header — the Activity root is never
 * a replacement renderer for its children. The chrome shares the transcript
 * left edge (addendum v2 §28): no outer indent.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/compact-work
 */

import { truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import {
  compactActionSlotLine,
  compactSlotLine,
  compactThinkSlotLine,
  type CompactActionPresentation,
} from './compact-process-preview.ts'
import { compactActionStatParts, formatCompactDuration } from '../../transcript/process-summary.ts'
import { summarizeWorkSpan, type CompactWorkSummary } from '../../transcript/work-summary.ts'
import type { TranscriptWorkSpan } from '../../transcript/structure.ts'
import { iconLead, sectionDisclosureSemantic, type IconStyle } from '../../../icons.ts'
import { color } from '../../../theme.ts'

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
