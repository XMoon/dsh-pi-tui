/**
 * Compact Activity span presentation: the collapsed `Activity` card (header
 * + Think / Tool previews) and its pure summary model.
 *
 * One Activity span is the user-visible identity of a presentation-only
 * contiguous Process run (see `compact-projection.ts`): the INTERNAL owner
 * kind stays `work` (`TranscriptWorkSpan`), while the USER-VISIBLE container
 * name is `Activity` (post-F6 plan §3.3/§6.1 — no internal rename). This
 * module derives the span's OWN aggregate facts — tool count, subagent
 * count, latest reasoning tail, latest meaningful tool, active PTC children
 * and the span-local wall-clock timing — never the whole turn's
 * `TurnActivity` counts (the span is not the turn). The collapsed card
 * consumes the SHARED compact process preview (`compact-process-preview.ts`)
 * and the existing presenter-first tool display; it has NO Message slot
 * because Assistant intermediate narration stays visible outside Activity.
 * @module @xmoon76/dsh-pi-tui/compact-work
 */

import { truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { TranscriptWorkSpan } from './transcript-projection.ts'
import {
  compactSlotLine,
  compactThinkSlotLine,
  compactToolSlotLine,
  formatCompactDuration,
} from './compact-process-preview.ts'
import { iconLead, sectionDisclosureSemantic, type IconStyle } from './icons.ts'
import { color } from './theme.ts'
import { activeSubCallsOf, THINKING_TAIL_CAP, transcriptTimingOf, type TranscriptToolMessage, type TranscriptTiming } from './transcript.ts'
import { isSurfacedInteractionToolName } from './transcript-semantics.ts'

/** The span-local aggregate facts the collapsed Activity card renders. */
export interface CompactWorkSummary {
  /** GENUINE model `tool/call` cardinality in THIS span (never the whole
   * turn, never a synthetic command/delegation row; a merged read group
   * contributes its merged callCount — post-F6 plan §10.2/§10.3). */
  readonly toolCount: number
  /** Durable subagent delegation rows in THIS span, counted SEPARATELY so a
   * delegation never inflates `tools` (post-F6 plan §10.3). */
  readonly subagentCount: number
  /** The latest reasoning member's bounded tail + live lifecycle fact. */
  readonly think?: { readonly text: string; readonly running: boolean }
  /** The latest GENUINE model tool-call member, for the presenter-first
   * Tool slot (synthetic rows never own the slot — the Focus rule). */
  readonly tool?: TranscriptToolMessage
  /** The tool member's RUNNING PTC descendants — the same active-child
   * semantics the Focus Tool slot shows (post-F6 plan §9.1). */
  readonly activeSubCalls?: readonly { readonly name: string; readonly count: number }[]
  /** The span-local wall-clock span of the members' OWN timed Process
   * evidence (post-F6 plan §12.12) — absent when no member carries
   * reliable timing (unknown is omitted, never `0s`). */
  readonly timing?: TranscriptTiming
}

/** The one display stat part for a count: `5 tools` / `1 subagent`. */
function countPart(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Derive one Activity span's aggregate facts from its own members, in raw
 * order. The LAST reasoning member owns the Think slot; the LAST GENUINE
 * model tool-call member owns the Tool slot. Counting is PROVENANCE-based
 * (post-F6 plan §10.2/§10.3): a member's `callCount` carries the genuine
 * `tool/call` cardinality (a merged read group of two reads is TWO calls,
 * never `"2 files" → 1`, so Focus and Activity always share one counting
 * unit); a `subagent-delegation` row counts ONLY as a subagent; a synthetic
 * `command` row counts as neither, and neither ever owns the Tool slot —
 * exactly like the Focus Tool slot, which only genuine `tool/call` events
 * can own. `llm-retry` process rows contribute point timing evidence but no
 * count. Timing aggregates the members' OWN sidecar evidence in the same
 * walk — earliest start, latest end, any running — never a second scan
 * (post-F6 plan §12.12).
 * @param span - the presentation-only Activity (Work) span.
 */
export function summarizeWorkSpan(span: TranscriptWorkSpan): CompactWorkSummary {
  let toolCount = 0
  let subagentCount = 0
  let think: CompactWorkSummary['think']
  let tool: TranscriptToolMessage | undefined
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
    } else if (member.kind === 'tool') {
      // A surfaced-interaction tool (question / Plan review) is human-decision
      // evidence, never ordinary work: it contributes no tool count and never
      // owns the Tool preview. While RUNNING it is still a member (its active
      // panel owns the interaction), but it must not skew the span either —
      // this keeps Compact and the Focus turn accounting in agreement.
      if (isSurfacedInteractionToolName(member.name)) continue
      // Genuine-call provenance: `origin` marks SYNTHETIC rows, and
      // `callCount` carries the explicit genuine-call cardinality — a
      // plain tool/call card is one call, a merged read group carries its
      // merged sum, and an orphan result (a result without a seen call)
      // explicitly carries ZERO. So `tools` keeps the same counting unit
      // as the Focus header (genuine tool/call events only), and a zero
      // or synthetic row can never own the Tool slot the Focus slot owns.
      if (member.origin === undefined) {
        const calls = member.callCount ?? 1
        if (calls > 0) {
          toolCount += calls
          tool = member
        }
      } else if (member.origin === 'subagent-delegation') {
        subagentCount += 1
      }
      // origin 'command' (and any other synthetic) counts as neither.
    }
  }
  const activeSubCalls = tool === undefined ? [] : activeSubCallsOf(tool)
  return {
    toolCount,
    subagentCount,
    ...think === undefined ? {} : { think },
    ...tool === undefined ? {} : { tool },
    ...(activeSubCalls.length === 0 ? {} : { activeSubCalls }),
    ...(startedAt === undefined ? {} : {
      timing: {
        startedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
        running,
      },
    }),
  }
}

/** The one-line Activity header (post-F6 plan §6.3): the Focus information
 * hierarchy `<identity> <duration> · <stats>` — the duration sits directly
 * beside the identity (never `· 18s`), the stat tail follows the `·`
 * separator, and zero facts are omitted (never a fake `0 tools`). The
 * `· thinking` marker is gone (§6.4): thinking presence is not a lifecycle
 * state, and its content already owns the Think slot. Degradation (§6.5)
 * drops the LAST stat first and keeps the duration with the identity to
 * the end, so the header NEVER wraps. */
export function formatWorkHeaderLine(
  summary: CompactWorkSummary,
  expanded: boolean,
  width: number,
  iconStyle: IconStyle = 'emoji',
  durationText?: string,
): string {
  // Identity: disclosure state + the registry-resolved work identity icon
  // + the user-visible name. The icon is identity ONLY — never a
  // running/completed state (post-F6 plan §6.2).
  const head = `${iconLead(sectionDisclosureSemantic(expanded), iconStyle)}${iconLead('work', iconStyle)}Activity`
  const parts: string[] = []
  if (summary.toolCount > 0) parts.push(countPart(summary.toolCount, 'tool'))
  if (summary.subagentCount > 0) parts.push(countPart(summary.subagentCount, 'subagent'))
  // The degradation ladder: full → … → identity + duration → identity.
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
 * visual row) then the Tool slot (latest meaningful activity, one visual
 * row). Only existing slots render — a span with neither reasoning nor a
 * tool renders no body rows and no empty placeholder. A live Preparing
 * summary, when supplied, owns the Tool slot over the formal display (the
 * streaming call is the current fact).
 */
export function compactWorkBody(
  summary: CompactWorkSummary,
  width: number,
  toolDisplay?: string,
  preparingSummary?: string,
): string[] {
  const lines: string[] = []
  if (summary.think !== undefined) {
    lines.push(compactThinkSlotLine({ text: summary.think.text, running: summary.think.running, width }))
  }
  if (preparingSummary !== undefined) {
    lines.push(compactSlotLine('Tool:', preparingSummary, width))
  } else if (summary.tool !== undefined && toolDisplay !== undefined) {
    lines.push(compactToolSlotLine({
      status: summary.tool.status,
      display: toolDisplay,
      rootName: summary.tool.name,
      ...(summary.activeSubCalls === undefined ? {} : { activeSubCalls: summary.activeSubCalls }),
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
 * RENDERS: expansion state and the precomputed tool display live in TuiApp,
 * and the expanded member rows are composed by the existing message
 * renderers after the header (the Activity root is never a replacement
 * renderer for its children). The `now` provider is re-read on EVERY frame
 * so a running span's duration advances with the existing repaint
 * heartbeat — never a per-card timer (post-F6 plan §12.13).
 */
export class CompactWorkComponent implements Component {
  private readonly summary: CompactWorkSummary
  private readonly expanded: boolean
  private readonly toolDisplay: string | undefined
  private readonly preparingSummary: string | undefined
  private readonly iconStyle: IconStyle
  private readonly now: () => number

  constructor(options: {
    span: TranscriptWorkSpan
    expanded: boolean
    summary?: CompactWorkSummary
    toolDisplay?: string
    preparingSummary?: string
    iconStyle?: IconStyle
    now?: () => number
  }) {
    this.summary = options.summary ?? summarizeWorkSpan(options.span)
    this.expanded = options.expanded
    this.toolDisplay = options.toolDisplay
    this.preparingSummary = options.preparingSummary
    this.iconStyle = options.iconStyle ?? 'emoji'
    this.now = options.now ?? (() => Date.now())
  }

  invalidate(): void {}

  render(width: number): string[] {
    const indent = width >= 4 ? '  ' : ''
    const contentWidth = Math.max(1, width - visibleWidth(indent))
    const header = formatWorkHeaderLine(
      this.summary,
      this.expanded,
      contentWidth,
      this.iconStyle,
      activityDurationText(this.summary, this.now),
    )
    const lines = [`${indent}${color.textDim(header)}`]
    if (!this.expanded) {
      for (const line of compactWorkBody(this.summary, contentWidth, this.toolDisplay, this.preparingSummary)) {
        lines.push(`${indent}${color.textDim(line)}`)
      }
    }
    return lines
  }
}

/**
 * The EPHEMERAL pending Activity card: a live Preparing call that does not
 * belong to any durable Process run yet (the previous run was closed by a
 * Conversation / Context / Attention boundary, or the turn has no projected
 * Activity span at all).
 *
 * It renders the same Header + Tool-slot geometry as a collapsed Activity
 * span so the durable rows can replace it seamlessly — the header
 * deliberately carries no `preparing`/`pending` suffix (that is an internal
 * lifecycle fact, and naming it would add a visual jump when the durable
 * Activity span lands). The live state is expressed by the Tool slot alone.
 * `startedAt` is the live call's earliest authoritative start (the first
 * streamed arguments delta, post-F6 plan §12.14): the elapsed seconds keep
 * running across the Preparing → durable handoff instead of resetting.
 */
export class CompactPendingWorkComponent implements Component {
  private readonly preparingSummary: string
  private readonly iconStyle: IconStyle
  private readonly startedAt: number | undefined
  private readonly now: () => number

  constructor(options: { preparingSummary: string; iconStyle?: IconStyle; startedAt?: number; now?: () => number }) {
    this.preparingSummary = options.preparingSummary
    this.iconStyle = options.iconStyle ?? 'emoji'
    this.startedAt = options.startedAt
    this.now = options.now ?? (() => Date.now())
  }

  invalidate(): void {}

  render(width: number): string[] {
    const indent = width >= 4 ? '  ' : ''
    const contentWidth = Math.max(1, width - visibleWidth(indent))
    const duration = this.startedAt === undefined
      ? undefined
      : formatCompactDuration(Math.max(0, this.now() - this.startedAt))
    const summary: CompactWorkSummary = { toolCount: 0, subagentCount: 0 }
    const lines = [`${indent}${color.textDim(formatWorkHeaderLine(summary, false, contentWidth, this.iconStyle, duration))}`]
    if (this.preparingSummary !== '') {
      lines.push(`${indent}${color.textDim(compactSlotLine('Tool:', this.preparingSummary, contentWidth))}`)
    }
    return lines
  }
}
