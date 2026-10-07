/**
 * PiTui compact process-preview mechanics: the physical Think / Action /
 * Preparing slot lines, the presenter bridge and the component cache
 * signatures.
 *
 * Focus (`tui/components/transcript/focus-activity.ts`) and Activity
 * (`tui/components/transcript/compact-work.ts`) render the SAME geometry
 * through this ONE module, so the two surfaces cannot drift. The
 * renderer-neutral half of the former shared authority — the Action source
 * classifier, the chronology winner and the action-stats cardinality — lives
 * in `tui/transcript/process-summary.ts`; this module only turns those facts
 * into one physical terminal row and into bounded cache keys.
 *
 * Every returned string is exactly ONE physical terminal row: embedded line
 * breaks never escape a slot (the fullscreen row hit-map depends on that).
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/compact-process-preview
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { focusToolDisplay, toolTitle, type ToolPresenter } from '../../transcript/tool-presentation.ts'
import { thinkingPreviewTail } from '../../../thinking-preview.ts'
import { activeSubCallsOf, THINKING_TAIL_CAP, type TranscriptMessage, type TranscriptToolMessage } from '../../../transcript.ts'
import type { CompactActionSource, CompactActionStats } from '../../transcript/process-summary.ts'

/** The fixed label column width of the collapsed body slots: the widest
 * label (`Message: `) — every slot's text starts at the same column
 * (aligned by visible width). */
export const COMPACT_SLOT_LABEL_WIDTH = 9

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
 * The shared compact Action slot line (post-F6 presentation-convergence addendum v2 §10/
 * §11): status prefix (ok → `✓ `, error → `✗ `, absent → none) + the
 * display + the active PTC sub-call suffix + the width-degradation ladder —
 * full root display + suffix → root title + suffix → root title alone (the
 * active child is never silently truncated away by a long root
 * description). Every result is one physical terminal row under the
 * `Action:` label; the synthetic kinds never carry active sub-calls, so
 * they take the plain one-line path.
 */
export function compactActionSlotLine(options: {
  /** The status prefix authority: absent while running or for the
   * prefix-less synthetic kinds (subagent/retry/orphan). */
  status?: 'ok' | 'error'
  display: string
  /** The root call's raw tool name, for the degradation ladder's title. */
  rootName?: string
  /** Active PTC descendants, aggregated by name in dispatch order. */
  activeSubCalls?: readonly { readonly name: string; readonly count: number }[]
  width: number
}): string {
  const { display, width } = options
  const active = options.activeSubCalls ?? []
  const prefix = options.status === 'ok' ? '✓ ' : options.status === 'error' ? '✗ ' : ''
  if (active.length === 0) return compactSlotLine('Action:', `${prefix}${display}`, width)
  const suffix = activeSubCallSuffix(active)
  const lead = slotLead('Action:')
  const bodyBudget = width - visibleWidth(lead)
  const full = `${prefix}${display} · ${suffix}`
  if (bodyBudget > 0 && visibleWidth(full) <= bodyBudget) return compactSlotLine('Action:', full, width)
  const degraded = `${prefix}${toolTitle(options.rootName ?? '')} · ${suffix}`
  if (bodyBudget > 0 && visibleWidth(degraded) <= bodyBudget) return compactSlotLine('Action:', degraded, width)
  return compactSlotLine('Action:', `${prefix}${toolTitle(options.rootName ?? '')}`, width)
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
 * The compact Action-slot text for live Preparing rows — the ONE summary
 * authority for Focus and Activity (post-F6 plan §11; addendum v2
 * §11.2/§34). Names that do not map to a known tool title remain generic,
 * so model-facing names never make the compact card noisy. The input is copied
 * and sorted so the summary is deterministic even when a caller supplies a
 * fresh order.
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

/** The presenter-bridge options shared by the Action presentation and the
 * existing presenter-first tool display. */
export interface CompactActionPresentationOptions {
  presenter?: ToolPresenter
  cwd?: string
}

/**
 * The render-ready one-line facts of one Action source (addendum v2 §10/§35): the display text, the optional status prefix and — for a genuine
 * tool — the degradation-ladder root name and the active PTC sub-calls. A
 * genuine tool keeps the presenter-first display (`focusToolDisplay`, with
 * the static fallback for replay); the synthetic kinds use the pure labels
 * below and never route through the ToolPresenter registry as fake tools.
 */
export interface CompactActionPresentation {
  readonly kind: CompactActionSource['kind']
  /** Present only when the row settles with an outcome prefix. */
  readonly status?: 'ok' | 'error'
  readonly display: string
  /** The genuine root call's raw tool name (degradation ladder input). */
  readonly rootName?: string
  readonly activeSubCalls?: readonly { readonly name: string; readonly count: number }[]
}

/**
 * Derive one Action source's presentation. This is the ONE shared authority
 * both Focus and Activity consume (addendum v2 §6/§35): `compactActionSlotLine`
 * turns it into the physical row, and the component caches key on its
 * bounded signature. For `kind: 'tool'` the presenter bridge supplies the
 * root display; every other kind formats a pure label.
 */
export function compactActionPresentation(
  source: CompactActionSource,
  options: CompactActionPresentationOptions = {},
): CompactActionPresentation {
  switch (source.kind) {
    case 'tool': {
      const message = source.message
      const activeSubCalls = activeSubCallsOf(message)
      return {
        kind: 'tool',
        ...(message.status === 'running' ? {} : { status: message.status }),
        display: focusToolDisplay(message, options),
        rootName: message.name,
        ...(activeSubCalls.length === 0 ? {} : { activeSubCalls }),
      }
    }
    case 'retry':
      return { kind: 'retry', display: retryActionLabel(source.message) }
    case 'orphan-tool-result':
      // An honest diagnostic: never presented as a normal successful Tool
      // call (addendum v2 §11.6).
      return { kind: 'orphan-tool-result', display: orphanToolResultLabel(source.message) }
  }
}

/** The exact producer shape of the durable retry row's text (transcript.ts
 * `llm/retry` fold): `llm retry <n>[/<max>] in <s>s — <failure>`. */
const RETRY_ACTION_TEXT_PATTERN = /^llm retry (\d+(?:\/\d+)?) in (\d+)s — (.*)$/

/**
 * `Retry 2/6 in 3s · authentication failed`: a source-specific
 * transformation of the known `llm retry …` label (addendum v2 §11.5) — never a
 * generic content heuristic. A text that does not match the producer shape
 * (an upstream format change) renders verbatim rather than being parsed.
 */
function retryActionLabel(message: Extract<TranscriptMessage, { kind: 'system' }>): string {
  const match = RETRY_ACTION_TEXT_PATTERN.exec(message.text)
  if (match === null) return compactSingleLine(message.text)
  return `Retry ${match[1]} in ${match[2]}s · ${match[3]}`
}

/**
 * `Unpaired tool result` / `Unpaired Read result`: the orphan diagnostic,
 * identity-titled when the result event carried a stable tool name
 * (addendum v2 §11.6). The fold's own generic fallbacks (`''` and the literal
 * `'tool'` an unseen call id degrades to) carry NO stable identity, so they
 * render the generic form.
 */
function orphanToolResultLabel(message: TranscriptToolMessage): string {
  return message.name === '' || message.name === 'tool'
    ? 'Unpaired tool result'
    : `Unpaired ${toolTitle(message.name)} result`
}

/** The threshold above which one display joins the cache signature as a
 * bounded digest instead of verbatim (addendum v2 §40/§63). A delegation
 * label or sanitized retry failure is a single producer-authored line with
 * no contract length. */
const ACTION_SIGNATURE_DISPLAY_CAP = 120

/**
 * A bounded, WHOLE-STRING-sensitive digest of one over-cap display: FNV-1a
 * over the full text plus its length. The cache key stays bounded while a
 * change ANYWHERE in the display — including past the cap, where the slot
 * still renders on a wide terminal — invalidates the mounted component. A
 * truncated prefix would silently miss exactly that tail change.
 */
function actionDisplayDigest(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

/**
 * The bounded cache signature of one Action presentation (addendum v2
 * §39/§40): the component caches compare this string so a new synthetic
 * Action repaints a collapsed surface even when the turn's tool state is
 * unchanged. Every contribution is bounded — kind, status, root name, the
 * active PTC topology, and the display (verbatim up to the cap, a
 * whole-string digest above it) — never an unbounded payload, and never
 * blind to a tail-only change.
 */
export function compactActionSignature(presentation: CompactActionPresentation | undefined): string {
  if (presentation === undefined) return ''
  const display = presentation.display.length > ACTION_SIGNATURE_DISPLAY_CAP
    ? actionDisplayDigest(presentation.display)
    : presentation.display
  return [
    presentation.kind,
    presentation.status ?? '',
    display,
    presentation.rootName ?? '',
    (presentation.activeSubCalls ?? []).map(call => `${call.name}:${call.count}`).join('|'),
  ].join('\u0000')
}

/** The bounded cache signature of one Action stats aggregate: the totals
 * and per-subtype counts the header renders, never a payload (addendum v2
 * §40). */
export function compactActionStatsSignature(stats: CompactActionStats): string {
  return `${stats.total}\u0000${[...stats.types.entries()].map(([name, count]) => `${name}:${count}`).join('|')}`
}
