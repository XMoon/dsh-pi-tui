/**
 * A small live, width-aware preview for folded cards.
 *
 * The component deliberately derives its rows in render(width), rather than
 * baking a terminal width into the transcript message cache. A resize can
 * therefore reveal more text after a narrow preview without rebuilding the
 * host card or rerunning a tool presenter.
 * @module @xmoon76/dsh-pi-tui/compact-text-preview
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@xmoon76/pi-tui'

export interface CompactTextPreviewOptions {
  /** The text to preview. Newlines remain logical breaks during wrapping. */
  readonly text: string
  /** Maximum number of physical rows returned by the preview. */
  readonly maxVisualRows: number
  /** Prefix applied to every returned row, normally two spaces. */
  readonly indent?: string
}

/**
 * Append an overflow marker while keeping the complete row within `width`.
 * `truncateToWidth` owns Unicode/ANSI slicing; reserving the marker cell here
 * also handles a source row that already consumes the whole available width.
 */
function appendEllipsis(text: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const markerWidth = Math.max(1, visibleWidth('…'))
  if (visibleWidth(text) + markerWidth <= safeWidth) return `${text}…`
  return `${truncateToWidth(text, Math.max(0, safeWidth - markerWidth), '')}…`
}

/**
 * Folded text preview whose wrapping and truncation are derived at render
 * time. The per-width cache keeps steady frames reference-stable while still
 * making narrow → wide → narrow resize sequences lossless.
 */
export class CompactTextPreview implements Component {
  private readonly text: string
  private readonly maxVisualRows: number
  private readonly indent: string
  private readonly cached = new Map<number, string[]>()

  constructor(options: CompactTextPreviewOptions)
  constructor(text: string, maxVisualRows: number, indent?: string)
  constructor(optionsOrText: CompactTextPreviewOptions | string, maxVisualRows?: number, indent = '  ') {
    if (typeof optionsOrText === 'string') {
      this.text = optionsOrText
      this.maxVisualRows = maxVisualRows ?? 0
      this.indent = indent
    } else {
      this.text = optionsOrText.text
      this.maxVisualRows = optionsOrText.maxVisualRows
      this.indent = optionsOrText.indent ?? '  '
    }
  }

  invalidate(): void {
    this.cached.clear()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const existing = this.cached.get(safeWidth)
    if (existing !== undefined) return existing
    if (this.text === '' || this.maxVisualRows <= 0) {
      const empty: string[] = []
      this.cached.set(safeWidth, empty)
      return empty
    }

    // Reserve one cell for content when the requested indent is wider than a
    // tiny terminal. The final truncate is still a defensive boundary for
    // ANSI and unusual Unicode-width implementations.
    const requestedIndentWidth = visibleWidth(this.indent)
    const indentWidth = Math.min(requestedIndentWidth, Math.max(0, safeWidth - 1))
    const prefix = indentWidth === requestedIndentWidth
      ? this.indent
      : truncateToWidth(this.indent, indentWidth, '')
    const bodyWidth = Math.max(1, safeWidth - visibleWidth(prefix))
    // Drop visually empty wrapped rows: a first grapheme wider than the body
    // width would otherwise emit a leading blank row at tiny terminal widths
    // — as plain text or as a row carrying only style codes.
    const wrapped = wrapTextWithAnsi(this.text, bodyWidth).filter(row => visibleWidth(row) > 0)
    const truncated = wrapped.length > this.maxVisualRows
    const shown = wrapped.slice(0, this.maxVisualRows)
    if (truncated && shown.length > 0) {
      const last = shown.length - 1
      shown[last] = appendEllipsis(shown[last] ?? '', bodyWidth)
    }
    const lines = shown.map(line => truncateToWidth(`${prefix}${line}`, safeWidth, '…'))
    this.cached.set(safeWidth, lines)
    return lines
  }
}

/** Pure convenience form for callers that do not need a retained component. */
export function compactTextPreviewLines(
  text: string,
  width: number,
  maxVisualRows: number,
  indent = '  ',
): string[] {
  return new CompactTextPreview({ text, maxVisualRows, indent }).render(width)
}
