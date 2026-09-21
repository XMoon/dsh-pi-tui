/**
 * Compact Work span presentation: the collapsed `Work` card (header + Think
 * / Tool previews) and its pure summary model.
 *
 * One Work span is a presentation-only contiguous Process run (see
 * `compact-projection.ts`). This module derives the span's OWN aggregate
 * facts — tool count, subagent count, latest reasoning tail and latest
 * meaningful tool — never the whole turn's `TurnActivity` counts (the span
 * is not the turn). The collapsed card reuses the existing Focus preview
 * geometry ({@link compactSlotLine} / {@link compactThinkSlotLine}) and the
 * existing presenter-first tool display; it has NO Message slot because
 * Assistant intermediate narration stays visible outside Work.
 *
 * Span-local duration is deliberately omitted: the durable transcript rows
 * carry no per-row timestamps, and presenting the whole-turn Focus duration
 * as a span duration would be a lie.
 * @module @xmoon76/dsh-pi-tui/compact-work
 */

import { truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { CompactWorkSpan } from './compact-projection.ts'
import { compactSlotLine, compactThinkSlotLine } from './focus-activity.ts'
import { iconLead, sectionDisclosureSemantic, type IconStyle } from './icons.ts'
import { color } from './theme.ts'
import type { TranscriptToolMessage } from './transcript.ts'

/** The span-local aggregate facts the collapsed Work card renders. */
export interface CompactWorkSummary {
  /** tool rows in THIS span (never the whole turn). */
  readonly toolCount: number
  /** subagent-delegation tool rows in THIS span. */
  readonly subagentCount: number
  /** The latest reasoning member's bounded tail + live lifecycle fact. */
  readonly think?: { readonly text: string; readonly running: boolean }
  /** The latest tool/activity member, for the presenter-first Tool slot. */
  readonly tool?: TranscriptToolMessage
}

/**
 * Derive one Work span's aggregate facts from its own members, in raw order.
 * The LAST reasoning member owns the Think slot; the LAST tool member owns
 * the Tool slot. `llm-retry` process rows contribute neither count.
 * @param span - the presentation-only Work span.
 */
export function summarizeWorkSpan(span: CompactWorkSpan): CompactWorkSummary {
  let toolCount = 0
  let subagentCount = 0
  let think: CompactWorkSummary['think']
  let tool: TranscriptToolMessage | undefined
  for (const member of span.members) {
    if (member.kind === 'thinking') {
      think = { text: member.text, running: member.running === true }
    } else if (member.kind === 'tool') {
      toolCount += 1
      if (member.origin === 'subagent-delegation') subagentCount += 1
      tool = member
    }
  }
  return {
    toolCount,
    subagentCount,
    ...think === undefined ? {} : { think },
    ...tool === undefined ? {} : { tool },
  }
}

/** The one-line Work header, degrading the stat tail so it never wraps
 * (plan §11): `▸ Work · 5 tools · 2 subagents · thinking`. Counts and the
 * thinking marker describe the SPAN only; zero facts are omitted (never a
 * fake `0 tools`). */
export function formatWorkHeaderLine(
  summary: CompactWorkSummary,
  expanded: boolean,
  width: number,
  iconStyle: IconStyle = 'emoji',
): string {
  const head = `${iconLead(sectionDisclosureSemantic(expanded), iconStyle)}Work`
  const parts: string[] = []
  if (summary.toolCount > 0) parts.push(`${summary.toolCount} tool${summary.toolCount === 1 ? '' : 's'}`)
  if (summary.subagentCount > 0) parts.push(`${summary.subagentCount} subagent${summary.subagentCount === 1 ? '' : 's'}`)
  if (summary.think !== undefined) parts.push('thinking')
  if (parts.length === 0) return truncateToWidth(head, Math.max(1, width), '…')
  const full = `${head} · ${parts.join(' · ')}`
  if (visibleWidth(full) <= width) return full
  const reduced = `${head} · ${parts[0]}`
  if (visibleWidth(reduced) <= width) return reduced
  return truncateToWidth(head, Math.max(1, width), '…')
}

/**
 * The collapsed Work body: the Think slot (latest reasoning tail, one
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
    lines.push(summary.think.running
      ? compactThinkSlotLine(summary.think.text, width)
      : compactSlotLine('Think:', summary.think.text, width))
  }
  if (preparingSummary !== undefined) {
    lines.push(compactSlotLine('Tool:', preparingSummary, width))
  } else if (summary.tool !== undefined && toolDisplay !== undefined) {
    const prefix = summary.tool.status === 'ok' ? '✓ ' : summary.tool.status === 'error' ? '✗ ' : ''
    lines.push(compactSlotLine('Tool:', `${prefix}${toolDisplay}`, width))
  }
  return lines
}

/**
 * The collapsed/expanded Work disclosure header. The component only RENDERS:
 * expansion state and the precomputed tool display live in TuiApp, and the
 * expanded member rows are composed by the existing message renderers after
 * the header (the Work root is never a replacement renderer for its
 * children).
 */
export class CompactWorkComponent implements Component {
  private readonly summary: CompactWorkSummary
  private readonly expanded: boolean
  private readonly toolDisplay: string | undefined
  private readonly preparingSummary: string | undefined
  private readonly iconStyle: IconStyle

  constructor(options: {
    span: CompactWorkSpan
    expanded: boolean
    summary?: CompactWorkSummary
    toolDisplay?: string
    preparingSummary?: string
    iconStyle?: IconStyle
  }) {
    this.summary = options.summary ?? summarizeWorkSpan(options.span)
    this.expanded = options.expanded
    this.toolDisplay = options.toolDisplay
    this.preparingSummary = options.preparingSummary
    this.iconStyle = options.iconStyle ?? 'emoji'
  }

  invalidate(): void {}

  render(width: number): string[] {
    const indent = width >= 4 ? '  ' : ''
    const contentWidth = Math.max(1, width - visibleWidth(indent))
    const lines = [`${indent}${color.textDim(formatWorkHeaderLine(this.summary, this.expanded, contentWidth, this.iconStyle))}`]
    if (!this.expanded) {
      for (const line of compactWorkBody(this.summary, contentWidth, this.toolDisplay, this.preparingSummary)) {
        lines.push(`${indent}${color.textDim(line)}`)
      }
    }
    return lines
  }
}
