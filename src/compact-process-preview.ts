/**
 * The shared compact process-preview authority (post-F6 plan §7): the ONE
 * place the compact Think / Tool / Preparing slot lines are formatted, served
 * to BOTH Focus (`focus-activity.ts`) and Compact/Activity
 * (`compact-work.ts`). Extracting it ends the drift that already happened
 * while the same geometry lived in Focus only.
 *
 * Scope boundary (plan §7.2): this module owns ONLY the truly shared slot
 * presentation — label geometry, reasoning-line selection, tool status
 * prefix + active-sub-call suffix + width degradation, the Preparing summary
 * text and the elapsed duration format. Focus-only turn/header/error/message
 * logic and Compact-only span aggregation stay in their owners.
 *
 * Every returned string is exactly ONE physical terminal row: embedded line
 * breaks never escape a slot (the fullscreen row hit-map depends on that).
 * @module @xmoon76/dsh-pi-tui/compact-process-preview
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { toolTitle } from './present.ts'
import { thinkingPreviewTail } from './thinking-preview.ts'
import { THINKING_TAIL_CAP } from './transcript.ts'

/** The fixed label column width of the collapsed body slots: the widest
 * label (`Message: `) — every slot's text starts at the same column
 * (aligned by visible width). */
export const COMPACT_SLOT_LABEL_WIDTH = 9

/**
 * Human elapsed duration from millis: seconds under a minute, `m s` above.
 * The Focus turn timer and the Activity wall-span timer share one format so
 * the same label never means two shapes.
 */
export function formatCompactDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** Collapse arbitrary slot text to ONE physical terminal row: CR/LF
 * sequences (LF, CRLF, lone CR) are normalized to the FIRST line. The
 * first line is kept rather than joining the lines with spaces: the
 * compact preview must not smuggle later lines' content into the row, and
 * width truncation would keep the leading lines anyway. */
function compactSingleLine(text: string): string {
  return text.split(/\r\n|\r|\n/)[0] ?? ''
}

/** The padded slot lead (`Think:   `): the label extended to the shared
 * label column, so every slot's body starts at the same visual column. */
function slotLead(label: string): string {
  return `${label}${' '.repeat(Math.max(0, COMPACT_SLOT_LABEL_WIDTH - visibleWidth(label)))}`
}

/**
 * One collapsed body slot line, truncated to the content width: the body
 * budget is the width MINUS the lead (`Think:   ` / `Error:   `), and a
 * lead that alone exceeds the width truncates too — a preview line can
 * never wrap. CR/LF are normalized to the FIRST line before width
 * truncation (the latest-line selection for reasoning lives in
 * {@link compactThinkSlotLine}, never here).
 */
export function compactSlotLine(label: string, text: string, width: number): string {
  const singleLine = compactSingleLine(text)
  const lead = slotLead(label)
  const bodyBudget = width - visibleWidth(lead)
  const body = bodyBudget > 0 ? truncateToWidth(singleLine, bodyBudget, '…') : ''
  return truncateToWidth(`${lead}${body}`, Math.max(1, width), '…')
}

/** The latest NON-EMPTY logical line of a (possibly multiline) reasoning
 * body, after bounding it to its tail: the collapsed Think row follows the
 * reasoning tail (post-F6 plan §8.2) — a streaming body whose later lines
 * grow must never keep rendering its first line. Blank lines carry no
 * reasoning evidence, so a blank latest line falls back to the previous
 * one and an all-blank body yields '' (never a fake placeholder). */
function latestReasoningLine(text: string): string {
  const tail = text.length > THINKING_TAIL_CAP ? text.slice(-THINKING_TAIL_CAP) : text
  const lines = tail.split(/\r\n|\r|\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (line !== '') return line
  }
  return ''
}

/**
 * The collapsed Think slot line (post-F6 plan §8.2/§8.4). The helper owns
 * the WHOLE rule so Focus and Activity cannot drift:
 *
 * 1. bound the reasoning body to its tail ({@link THINKING_TAIL_CAP}) —
 *    never a per-render scan of the whole ever-growing body;
 * 2. select the latest non-empty logical line;
 * 3. `running` — window the line at its RIGHT edge so the latest token
 *    stays visible; settled — head-truncate the same line (a finished
 *    thought reads from its beginning).
 *
 * The input is the raw reasoning text in BOTH callers: Focus passes its
 * bounded latest-line preview (a no-op re-selection), Activity passes the
 * full thinking row. Every result is one physical terminal row.
 */
export function compactThinkSlotLine(options: { text: string; running: boolean; width: number }): string {
  const { running, width } = options
  const line = latestReasoningLine(options.text)
  const lead = slotLead('Think:')
  const bodyBudget = width - visibleWidth(lead)
  if (bodyBudget <= 0 || line === '') return truncateToWidth(`${lead}`, Math.max(1, width), '…')
  const body = running ? thinkingPreviewTail(line, bodyBudget) : truncateToWidth(line, bodyBudget, '…')
  return truncateToWidth(`${lead}${body}`, Math.max(1, width), '…')
}

/** The compact active-sub-call summary: one running child → `Bash running`;
 * several of the same type → `Bash ×2 running`; mixed types → the first
 * type (durable dispatch order) with its own count plus the remaining
 * running count (`Bash ×2 +1 running`). Titles go through the existing
 * tool-title mapping. */
function activeSubCallSuffix(active: readonly { name: string; count: number }[]): string {
  if (active.length === 1) {
    const { name, count } = active[0]!
    return `${toolTitle(name)}${count > 1 ? ` ×${count}` : ''} running`
  }
  const first = active[0]!
  const rest = active.slice(1).reduce((sum, entry) => sum + entry.count, 0)
  const firstCount = first.count > 1 ? ` ×${first.count}` : ''
  return `${toolTitle(first.name)}${firstCount} +${rest} running`
}

/**
 * The shared compact Tool slot line (post-F6 plan §9.2/§9.3): status prefix
 * (`running` → none, ok → `✓ `, error → `✗ `) + presenter-first root
 * display + the active PTC sub-call suffix + the width-degradation ladder —
 * full root display + suffix → root title + suffix → root title alone (the
 * active child is never silently truncated away by a long root
 * description). Every result is one physical terminal row.
 */
export function compactToolSlotLine(options: {
  status: 'running' | 'ok' | 'error'
  /** The presenter-first root display (precomputed by the app). */
  display: string
  /** The root call's raw tool name, for the degradation ladder's title. */
  rootName: string
  /** Active PTC descendants, aggregated by name in dispatch order. */
  activeSubCalls?: readonly { readonly name: string; readonly count: number }[]
  width: number
}): string {
  const { status, display, rootName, width } = options
  const active = options.activeSubCalls ?? []
  const prefix = status === 'ok' ? '✓ ' : status === 'error' ? '✗ ' : ''
  if (active.length === 0) return compactSlotLine('Tool:', `${prefix}${display}`, width)
  const suffix = activeSubCallSuffix(active)
  const lead = slotLead('Tool:')
  const bodyBudget = width - visibleWidth(lead)
  const full = `${prefix}${display} · ${suffix}`
  if (bodyBudget > 0 && visibleWidth(full) <= bodyBudget) return compactSlotLine('Tool:', full, width)
  const degraded = `${prefix}${toolTitle(rootName)} · ${suffix}`
  if (bodyBudget > 0 && visibleWidth(degraded) <= bodyBudget) return compactSlotLine('Tool:', degraded, width)
  return compactSlotLine('Tool:', `${prefix}${toolTitle(rootName)}`, width)
}

/** The presentation-only shape needed to summarize one live Preparing row.
 * It deliberately excludes the call id, turn and arguments: the compact
 * preview owns no lifecycle state and only needs the stable visual order
 * plus an optional display name. */
export interface CompactPreparingPreview {
  readonly index: number
  readonly name?: string
}

/**
 * The compact Tool-slot text for live Preparing rows — the ONE summary
 * authority for Focus and Activity (post-F6 plan §11). Names that do not
 * map to a known tool title remain generic, so model-facing names never
 * make the compact card noisy. The input is copied and sorted so the
 * summary is deterministic even when a caller supplies a fresh order.
 */
export function compactPreparingSummary(
  previews: readonly CompactPreparingPreview[],
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
