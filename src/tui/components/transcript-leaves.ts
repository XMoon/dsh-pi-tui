/**
 * Transcript leaf presentation (TS4 plan §22): the blank row spacer, the
 * right-gutter width contract and its wrapper, the live focus padding row, the
 * bulleted / compact-thinking / user-bubble blocks, and the delivered-files
 * tail. They own RENDERING only.
 *
 * Moved verbatim out of `tui-app.ts`. Transcript folder/window ownership,
 * search matches and target, viewport position, disclosure owner state, the
 * pending-input ledger and the message cache stay where they were; the leaves
 * may consume semantic/transcript types but create no semantic state.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript-leaves
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { iconLead } from '../icons.ts'
import type { IconStyle } from '../../domain/display/icons.ts'
import { longMessageDisclosureWindow } from '../../long-message-disclosure.ts'
import { latestLine } from '../../domain/transcript/text.ts'
import { relativizeToCwd } from '../transcript/tool-presentation.ts'
import { color } from '../theme/runtime.ts'
import { thinkingPreviewTail } from '../../thinking-preview.ts'
import type { PresentedFilePresentation, TranscriptMessage } from '../../transcript.ts'

/** The assistant delivered-files tail folds after this many files. */
export const DELIVERED_FILES_FOLDED_LIMIT = 4

/** One blank row between consecutive transcript blocks (kimi/pi Spacer(1) parity). */
export class Spacer implements Component {
  invalidate(): void {}
  render(): string[] {
    return ['']
  }
}

/**
 * The transcript surface's RIGHT GUTTER (the transcript right-gutter width contract):
 * every transcript block renders this many cells short of the terminal
 * edge, so content never visually collides with the right boundary. The
 * gutter is a property of the TRANSCRIPT surface only — the editor,
 * footer, welcome card, overlays and other chrome keep the full terminal
 * width. Fixed at 2 (1 only solves "touching the wall", 3+ wastes space
 * on narrow terminals); deliberately not a user setting.
 */
export const TRANSCRIPT_RIGHT_GUTTER = 2

/** The usable width for transcript content at a given terminal width: the
 * full width minus the right gutter, never 0/negative (a 1-3 cell
 * terminal still yields 1 cell). EVERY transcript geometry measurement
 * and the actual frame paint must go through this single contract — a
 * drift between them shifts the fullscreen click hit-map. */
export function transcriptContentWidth(width: number): number {
  return Math.max(1, Math.floor(width) - TRANSCRIPT_RIGHT_GUTTER)
}

/**
 * The thin host-owned transcript boundary: renders the child at the
 * transcript content width (terminal width minus the right gutter), so
 * EVERY transcript block — host cards AND plugin-rendered components —
 * inherits the gutter without any renderer knowing about it.
 *
 * The wrapper is deliberately NON-OWNING: `dispose()` does NOT forward to
 * the child. The message/focus component CACHES own the child's lifecycle
 * (`pruneMessageComponents` / stale-rebuild / session-switch dispose
 * them), while `messagesView` is only a projection / mount point — the
 * fork's `Container.clear()` disposes every child on every
 * `rebuildMessages`, and forwarding the dispose would kill a CACHED
 * component the cache then reuses (an `ImageThumbnail` drops its loader
 * subscription and never repaints on the settle). `invalidate()`/input
 * forwarding stays (non-destructive, the fork calls them on the mounted
 * tree).
 */
export class TranscriptGutterComponent implements Component {
  private child: Component

  constructor(child: Component) {
    this.child = child
  }

  /** Replace the mounted presentation child without taking ownership of either
   * the old or new component. The message/focus caches own disposal. */
  replace(child: Component): void {
    this.child = child
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  /** Deliberately non-owning: the component caches own the child's
   * lifecycle — a projection clear (every rebuildMessages) must never
   * dispose a cached component that is reused right after. */
  dispose(): void {}

  handleInput(data: string): void {
    this.child.handleInput?.(data)
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.child.wantsKeyRelease
  }

  render(width: number): string[] {
    return this.child.render(transcriptContentWidth(width))
  }
}

/**
 * Layout-only rows that keep a running Focus turn's live height from
 * shrinking after a transient presentation reflow. It owns no semantic row;
 * its height is supplied by TuiApp's current render measurement and it is
 * hidden outside the fullscreen Focus presentation epoch.
 */
export class FocusLivePaddingComponent implements Component {
  private readonly rows: () => number
  private readonly enabled: () => boolean

  constructor(rows: () => number, enabled: () => boolean) {
    this.rows = rows
    this.enabled = enabled
  }

  invalidate(): void {}

  render(_width: number): string[] {
    if (!this.enabled()) return []
    return Array.from({ length: Math.max(0, Math.floor(this.rows())) }, () => '')
  }
}

/**
 * Bullet + continuation-indent wrapper that keeps its child LIVE, so a
 * terminal resize re-renders the child at the new width instead of
 * re-wrapping a frozen render (the 5a76526 regression: assistant/user
 * messages were flattened to a static Text at build time, so markdown
 * tables could never reflow and border lines wrapped as plain text on
 * narrow windows). The bullet leads the FIRST line; wrapped continuation
 * lines indent under it (kimi prefix+indent parity).
 *
 * The prefixed output keeps a REFERENCE-STABLE cache: when the child
 * returns the same array instance (its own text+width cache hit) at the
 * same width, the wrapper returns the same prefixed array — so the fork's
 * per-frame processed-line reuse (packages/pi-tui/DIVERGENCES.md X035)
 * keeps hitting on steady frames instead of re-normalizing every line.
 */
export class BulletedComponent implements Component {
  private readonly child: Component
  private readonly prefix: string
  private readonly prefixWidth: number
  private readonly indent: string
  private lastChild: string[] | undefined
  private lastWidth = -1
  private cached: string[] | undefined

  constructor(child: Component, prefix: string) {
    this.child = child
    this.prefix = prefix
    this.prefixWidth = visibleWidth(prefix)
    this.indent = ' '.repeat(this.prefixWidth)
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  dispose(): void {
    this.child.dispose?.()
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - this.prefixWidth)
    const child = this.child.render(inner)
    if (child === this.lastChild && width === this.lastWidth && this.cached !== undefined) {
      return this.cached
    }
    this.lastChild = child
    this.lastWidth = width
    this.cached = child.map((line, index) => (index === 0 ? this.prefix : this.indent) + line)
    return this.cached
  }
}

/**
 * The COMPACT Thinking disclosure card, WIDTH-AWARE (the unified
 * disclosure model, plan §4/§13): the `🌊 Thinking` title, the latest
 * reasoning line as the preview and the owner hint are truncated AT
 * RENDER TIME to the CURRENT terminal width. The message component cache
 * deliberately does NOT key on width — a terminal resize keeps the same
 * component, and this card re-derives its rows per render (the same
 * live-child pattern as BulletedComponent), so:
 *   - a wide → narrow resize truncates every row to the new width and
 *     the fixed three-row geometry never wraps (the stale-build trap:
 *     Text wraps its pre-truncated text at the new width and inflates
 *     the block);
 *   - a narrow → wide resize restores the full-width preview instead of
 *     freezing the old narrow truncation.
 * The EMPTY entry renders the bare title — never a fake "No reasoning"
 * row (plan §13.3). While the entry is RUNNING its preview is windowed at
 * the reasoning tail (the newest token stays visible); a settled entry
 * reads from the start of its latest line. The output is
 * REFERENCE-STABLE per width: the same
 * component + same width returns the same array instance, so steady
 * frames keep the fork's per-frame processed-line reuse (DIVERGENCES.md
 * X035).
 */
export class ThinkingCompactComponent implements Component {
  private readonly message: Extract<TranscriptMessage, { kind: 'thinking' }>
  /** The rendered fold-hint verb ('alt+t' → the EFFECTIVE thinking key,
   * 'ctrl+o' → the EFFECTIVE expand key, 'click' for the click-owned
   * fullscreen secondaries): resolved by the host at build time so a user
   * remap updates the copy without invalidating the per-width cache. */
  private readonly hint: string
  private readonly iconStyle: IconStyle
  /** TRUE per-width cache: the same component + same width returns the
   * same array instance even after intermediate widths (a single
   * last-width slot would re-create the array on a width A → B → A
   * sequence and break the reference-stable contract). */
  private readonly cached = new Map<number, string[]>()

  constructor(message: Extract<TranscriptMessage, { kind: 'thinking' }>, hint: string, iconStyle: IconStyle = 'emoji') {
    this.message = message
    this.hint = hint
    this.iconStyle = iconStyle
  }

  invalidate(): void {
    this.cached.clear()
  }

  render(width: number): string[] {
    const existing = this.cached.get(width)
    if (existing !== undefined) return existing
    const previewLine = latestLine(this.message.text)
    const title = color.textDim(`${iconLead('thinking', this.iconStyle)}Thinking`)
    let lines: string[]
    if (previewLine === '') {
      // An existing block with no text yet (a very short streaming /
      // replay edge): the bare title — never a fake "No reasoning" row.
      lines = [truncateToWidth(title, Math.max(1, width), '…')]
    } else {
      const hintVerb = this.hint || 'the expand key'
      // The body budget excludes the fixed two-cell indent. While the row
      // is RUNNING the reasoning body is windowed at its right edge (the
      // latest token stays visible — dsh-web running collapsed parity); a
      // settled row keeps head truncation.
      const bodyBudget = Math.max(1, width - visibleWidth('  '))
      const body = this.message.running === true
        ? thinkingPreviewTail(previewLine, bodyBudget)
        : truncateToWidth(previewLine, bodyBudget, '…')
      lines = [
        truncateToWidth(title, Math.max(1, width), '…'),
        truncateToWidth(color.textDimItalic(`  ${body}`), Math.max(1, width), '…'),
        truncateToWidth(color.textDim(`  (${hintVerb} to expand)`), Math.max(1, width), '…'),
      ]
    }
    this.cached.set(width, lines)
    return lines
  }
}

/** The collapsed long user bubble's marker builder. It receives the hidden
 * visual-row count and the available inner width so a narrow bubble can fall
 * back to the short form instead of wrapping the marker. */
export type UserBubbleCompactMarker = (hiddenRows: number, availableWidth: number) => string

/** Options for the render-time visual-row compaction of one user bubble.
 * Absent = render the full content (short messages, mixed-content bubbles and
 * the ephemeral pending echo). */
export interface UserBubbleCompactOptions {
  readonly thresholdRows: number
  readonly headRows: number
  readonly tailRows: number
  readonly compactMarker: UserBubbleCompactMarker
  /** Whether this bubble currently renders EXPANDED (full content) while
   * still being compact-capable: the caller then owns the tail collapse
   * control row. */
  readonly expanded: boolean
}

/**
 * User-message bubble: the whole row is painted with the role background
 * (dsh-web `--dsw-specific-bubble` parity — user input is a floating
 * block, NOT a text colour, so it never collides with the assistant's
 * brand-blue whale or kimi's amber), the ❯ marker leads the FIRST line in
 * the role colour, and wrapped continuation lines indent under it with the
 * background kept across the row.
 *
 * The child stays LIVE (a resize re-wraps at the new width — the 5a76526
 * rule) and the prefixed output is REFERENCE-STABLE like BulletedComponent:
 * same child array + same width → same prefixed array, so the fork's
 * per-frame processed-line reuse keeps hitting on steady frames.
 */
export class UserBubbleComponent implements Component {
  private readonly child: Component
  private readonly marker: string
  private readonly markerWidth: number
  private readonly bg: (text: string) => string
  private readonly compactOptions: UserBubbleCompactOptions | undefined
  private lastChild: string[] | undefined
  private lastWidth = -1
  private cached: string[] | undefined
  private lastCompactMarkerRow: number | undefined
  private lastCollapseEligible = false

  constructor(
    child: Component,
    marker: string,
    bg: (text: string) => string,
    compactOptions?: UserBubbleCompactOptions,
  ) {
    this.child = child
    this.marker = marker
    this.markerWidth = visibleWidth(marker)
    this.bg = bg
    this.compactOptions = compactOptions
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  dispose(): void {
    this.child.dispose?.()
  }

  /** The row offset (within this component's rendered rows) of the collapsed
   * compact marker, or undefined when the current render is not compacted.
   * Set during the last render, so it always matches the painted rows at the
   * current width (the fullscreen marker hit target). */
  compactMarkerRow(): number | undefined {
    return this.lastCompactMarkerRow
  }

  /** Whether the current render is an EXPANDED compact-capable bubble: the
   * visual rows exceed the threshold, so the caller must place a tail
   * collapse control after the body (the spacer row when one follows, or one
   * dedicated presentation row for the final block). */
  showsCollapseControl(): boolean {
    return this.lastCollapseEligible
  }

  /** The rendered row count of the user-text bubble at the last render — the
   * fullscreen bubble hit range in EITHER disclosure state (collapsed or
   * expanded). For the durable bubble this is the whole component; the
   * pending wrapper delegates so its appended status row is excluded without
   * structural guessing (`rendered.length - 1`). */
  disclosureBodyRowCount(): number {
    return this.cached?.length ?? 0
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - this.markerWidth)
    const child = this.child.render(inner)
    if (child === this.lastChild && width === this.lastWidth && this.cached !== undefined) {
      return this.cached
    }
    this.lastChild = child
    this.lastWidth = width
    const indent = ' '.repeat(this.markerWidth)
    const rows = this.compactRows(child, inner)
    this.cached = rows.map((line, index) => {
      const prefix = index === 0 ? this.marker : indent
      // Pad to the full row so the bubble background covers the whole
      // line, wrapped continuation rows included.
      const pad = ' '.repeat(Math.max(0, inner - visibleWidth(line)))
      return this.bg(prefix + line + pad)
    })
    return this.cached
  }

  /** Collapse the child's FULL visual rows to head + marker + tail when the
   * row-count threshold is exceeded. The decision and the slice both run on
   * the rows the current width actually produces, so a resize re-decides
   * (no baked compact count/marker position). An EXPANDED bubble keeps the
   * full rows and only records that it is collapse-eligible. */
  private compactRows(child: string[], inner: number): string[] {
    this.lastCompactMarkerRow = undefined
    this.lastCollapseEligible = false
    const options = this.compactOptions
    if (options === undefined) return child
    // The SAME shared window the relay Context row uses: decide and slice on
    // the visual rows the current width produced.
    const window = longMessageDisclosureWindow(child, options, {
      expanded: options.expanded,
      marker: (hidden) => {
        const raw = options.compactMarker(hidden, inner)
        // Final single-row guard: a narrow bubble never lets the marker wrap or
        // overflow — it truncates instead (the builder may already have
        // dropped its verb, but an extreme width still needs clipping).
        return visibleWidth(raw) <= inner ? raw : truncateToWidth(raw, inner, '…')
      },
    })
    if (options.expanded) {
      this.lastCollapseEligible = window.long
      return child
    }
    this.lastCompactMarkerRow = window.markerRow
    return [...window.rows]
  }
}

/** Host-owned tail for explicit files delivered by the present tool. Paths
 * are always shown first; the folded view caps entries while an expanded
 * transcript view re-renders the complete declaration list. */
export class DeliveredFilesComponent implements Component {
  private readonly files: readonly PresentedFilePresentation[]
  private readonly workspaceRoot: string | undefined
  private readonly expanded: boolean
  private readonly cached = new Map<number, string[]>()
  /** The visible row/column spans of every rendered path/description field,
   * relative to THIS component's rows (render output, refreshed on every
   * width). Consumed by the search source-geometry walker. */
  lastFieldSpans: ReadonlyArray<{
    readonly index: number
    readonly pathRow: number
    readonly pathStart: number
    readonly pathEnd: number
    readonly descriptionRows: ReadonlyArray<{ readonly row: number; readonly start: number; readonly end: number }>
  }> = []

  constructor(
    files: readonly PresentedFilePresentation[],
    workspaceRoot: string | undefined,
    expanded: boolean,
  ) {
    this.files = files
    this.workspaceRoot = workspaceRoot
    this.expanded = expanded
  }

  invalidate(): void {
    this.cached.clear()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const previous = this.cached.get(safeWidth)
    if (previous !== undefined) return previous

    const shown = this.expanded ? this.files : this.files.slice(0, DELIVERED_FILES_FOLDED_LIMIT)
    const rows = [truncateToWidth(color.textDim(`Delivered files · ${this.files.length}`), safeWidth, '…')]
    const spans: Array<{
      index: number
      pathRow: number
      pathStart: number
      pathEnd: number
      descriptionRows: Array<{ row: number; start: number; end: number }>
    }> = []
    for (const [index, file] of shown.entries()) {
      const path = relativizeToCwd(file.path, this.workspaceRoot).replace(/\r\n|\r|\n/g, ' ')
      const pathRow = rows.length
      const pathStart = visibleWidth('  ')
      rows.push(truncateToWidth(color.textDim(`  ${path}`), safeWidth, '…'))
      const descriptionRows: Array<{ row: number; start: number; end: number }> = []
      if (file.description !== undefined && file.description !== '') {
        const descriptionWidth = Math.max(1, safeWidth - 4)
        for (const line of wrapTextWithAnsi(file.description, descriptionWidth)) {
          const descriptionRow = rows.length
          const start = visibleWidth('    ')
          rows.push(truncateToWidth(color.textDim(`    ${line}`), safeWidth, '…'))
          descriptionRows.push({ row: descriptionRow, start, end: start + visibleWidth(line) })
        }
      }
      spans.push({ index, pathRow, pathStart, pathEnd: pathStart + visibleWidth(path), descriptionRows })
    }
    if (!this.expanded && this.files.length > shown.length) {
      rows.push(truncateToWidth(color.textDim(`  … +${this.files.length - shown.length}`), safeWidth, '…'))
    }
    this.lastFieldSpans = spans
    this.cached.set(safeWidth, rows)
    return rows
  }
}
