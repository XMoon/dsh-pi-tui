/**
 * Form-aware standalone Context rows: notice, relay and session recall.
 *
 * A producer-declared Context form decides how one injected row is presented
 * (see `context-presentation.ts`). `notice` is a one-off account whose
 * producer-authored `summary` is shown below the header at NORMAL brightness
 * and wrapped naturally — the TUI never invents a head/row preview from the
 * payload. `relay` is another Agent's authored message: its sender is named
 * and its body is visible by default at normal brightness. `recall` is
 * material lifted from another session and names its labels.
 *
 * Every row stays semantic Context: only presentation primitives are reused.
 * All three wrap/truncate at RENDER time (a resize re-wraps), so no width is
 * baked into the cached component.
 * @module @xmoon76/dsh-pi-tui/context-row
 */

import { truncateToWidth, wrapTextWithAnsi, type Component } from '@xmoon76/pi-tui'
import { iconPrefix, type IconStyle } from './icons.ts'
import { longMessageDisclosureWindow, type LongMessageDisclosureGeometry } from './long-message-disclosure.ts'
import { systemContextBody } from './present.ts'
import { color } from './theme.ts'
import type { TranscriptMessage } from './transcript.ts'

/** One surfaced `system` Context row narrowed for presentation. */
type ContextSystemRow = Extract<TranscriptMessage, { kind: 'system' }>

/** Wrap one logical text at the current width and paint every physical row.
 * Never truncates to a single row: the caller's contract decides how many
 * rows are shown. */
function wrappedRows(text: string, width: number, paint: (row: string) => string): string[] {
  if (text === '') return []
  const safeWidth = Math.max(1, width)
  // `wrapTextWithAnsi` cannot split a wide grapheme: an over-wide token (CJK,
  // an emoji) comes back as a row WIDER than the requested width (and a
  // zero-width row beside it). Truncate every wrapped row at the current
  // width so each returned element is exactly one physical row — the same
  // defensive rule CompactTextPreview applies.
  return wrapTextWithAnsi(text, safeWidth).map(row => paint(truncateToWidth(row, safeWidth, '…')))
}

/** The existing Context body rules for an expanded payload (parsed skill /
 * system envelopes render their content, never raw XML); plain text keeps its
 * raw body. */
function payloadRows(text: string, width: number): string[] {
  const body = systemContextBody(text)
  const lines = body ?? text.split('\n')
  const rows: string[] = []
  for (const line of lines) rows.push(...wrappedRows(line, width, color.textDim))
  return rows
}

/** Options shared by the standalone Context row components. */
interface ContextRowOptions {
  readonly message: ContextSystemRow
  readonly expanded: boolean
  readonly expandHint: string
  readonly iconStyle: IconStyle
}

/** The disclosure affordance appended to a muted header when the row is
 * collapsed and has hidden content. */
function expandAffordance(hint: string): string {
  return `  (${hint} to expand)`
}

/** One muted header row, truncated to the current width: the header is
 * chrome (the summary/body carries the content), and every rendered element
 * must stay exactly one physical row. */
function headerRow(text: string, width: number): string {
  return color.textMuted(truncateToWidth(text, Math.max(1, width), '…'))
}

/**
 * `form: 'notice'` — a standalone producer notice. Collapsed shows the
 * producer title plus the producer-authored summary at normal brightness
 * (naturally wrapped, never truncated to one row); expanded adds the complete
 * payload. A legacy notice without a summary fabricates nothing.
 */
export class NoticeContextRow implements Component {
  private readonly options: ContextRowOptions

  constructor(options: ContextRowOptions) {
    this.options = options
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { message, expanded, expandHint, iconStyle } = this.options
    const icon = iconPrefix(message.icon ?? 'context-notice', iconStyle)
    const title = message.label === undefined || message.label === '' ? 'Notice' : message.label
    const head = `${icon}${title}${expanded ? '' : expandAffordance(expandHint)}`
    const rows = [headerRow(head, width)]
    if (message.summary !== undefined && message.summary !== '') {
      rows.push(...wrappedRows(message.summary, width, color.text))
    }
    if (expanded) rows.push(...payloadRows(message.text, width))
    return rows
  }
}

/**
 * `form: 'relay'` — a message another Agent addressed to this one. The sender
 * is named, the body is visible by default at normal brightness, and a long
 * body reuses the SHARED long-message disclosure geometry (the same
 * threshold/head/tail window the user bubble uses), so another Agent's
 * concluding lines stay visible while collapsed.
 */
export class RelayContextRow implements Component {
  private readonly options: ContextRowOptions
  private readonly geometry: LongMessageDisclosureGeometry

  constructor(options: ContextRowOptions & { geometry: LongMessageDisclosureGeometry }) {
    this.options = options
    this.geometry = options.geometry
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { message, expanded, expandHint, iconStyle } = this.options
    const sender = message.contextPresentation?.senderSessionId
    const icon = iconPrefix(message.icon ?? 'context-generic', iconStyle)
    const title = sender === undefined || sender === '' ? 'Agent message' : `Agent message · ${sender}`
    const bodyRows = wrappedRows(message.text, Math.max(1, width), color.text)
    // The marker is chrome: clip it to the current width so every returned
    // element stays exactly one physical row even on a very narrow terminal.
    const marker = color.textMuted(truncateToWidth('  …', Math.max(1, width), '…'))
    const window = longMessageDisclosureWindow(bodyRows, this.geometry, { expanded, marker: () => marker })
    const collapsed = window.markerRow !== undefined
    const rows = [headerRow(`${icon}${title}${collapsed ? expandAffordance(expandHint) : ''}`, width)]
    rows.push(...window.rows)
    return rows
  }
}

/**
 * `form: 'recall'` — material lifted out of another session's log. The row
 * names the structured recalled labels; the payload stays behind the ordinary
 * disclosure. No summary is invented when the metadata is absent.
 */
export class RecallContextRow implements Component {
  private readonly options: ContextRowOptions

  constructor(options: ContextRowOptions) {
    this.options = options
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { message, expanded, expandHint, iconStyle } = this.options
    const icon = iconPrefix(message.icon ?? 'context-recall', iconStyle)
    const title = message.label === undefined || message.label === ''
      ? 'Session recall'
      : `Session recall · ${message.label}`
    const rows = [headerRow(`${icon}${title}${expanded ? '' : expandAffordance(expandHint)}`, width)]
    if (expanded) rows.push(...payloadRows(message.text, width))
    return rows
  }
}
