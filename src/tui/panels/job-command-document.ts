/**
 * The Job Command ORIGINAL-TEXT document (Phase 3B / B1-C): the thin Job-facing
 * wrapper over the neutral {@link module:@xmoon76/dsh-pi-tui/tui/components/source-text-layout}
 * mapping.
 *
 * The offset-preserving layout itself is NOT Job-specific: it turns any original
 * string into paintable visual rows WHILE retaining the exact UTF-16 range of
 * every displayed cell, so `label.slice(start, end)` is always exactly the text
 * the user pointed at. The neutral implementation lives in
 * `../components/source-text-layout.ts` and is shared with the History preview;
 * this module keeps the Job Command's historical export names (and the
 * `JobCommandDocument` component that caches one layout per source+width) as
 * aliases over it.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-command-document
 */

import type { Component } from '@xmoon76/pi-tui'
import {
  buildSourceTextVisualLayout,
  type SourceTextVisualLayout,
} from '../components/source-text-layout.ts'

export type {
  SourceTextVisualCellRun as CommandVisualCellRun,
  SourceTextVisualLayout as CommandVisualLayout,
  SourceTextPoint as CommandPoint,
  SourceTextVisualRow as CommandVisualRow,
} from '../components/source-text-layout.ts'
export {
  sourceTextPointOffset as commandPointOffset,
  sourceTextRowSelectionColumns as commandRowSelectionColumns,
  sourceTextSelectionRange as commandSelectionRange,
} from '../components/source-text-layout.ts'

/** The historical Job Command alias of the neutral layout builder. */
export const buildCommandVisualLayout = buildSourceTextVisualLayout

/**
 * The Command document as the exact `Component.render(width)` source the
 * ScrollView's child paints, with the layout cached per (source, width) so a
 * repaint or a snapshot push never rescans the label. The rendered strings are
 * ANSI-free safe text; the visual ROW COUNT and the cell width never depend on
 * the terminal state.
 */
export class JobCommandDocument implements Component {
  private sourceValue = ''
  private layoutValue: SourceTextVisualLayout | undefined
  private renderedLines: readonly string[] = []

  /** Replace the original command label. The layout is rebuilt lazily at the
   *  next render for the width that is actually painted. */
  setSource(source: string): void {
    if (source === this.sourceValue) return
    this.sourceValue = source
    this.layoutValue = undefined
    this.renderedLines = []
  }

  /** The original label currently laid out. */
  get source(): string {
    return this.sourceValue
  }

  /** The layout at one width, rebuilt only when the width or the source
   *  changed. */
  layoutAt(width: number): SourceTextVisualLayout {
    const safeWidth = Math.max(1, Math.floor(width))
    if (this.layoutValue === undefined || this.layoutValue.width !== safeWidth) {
      this.layoutValue = buildSourceTextVisualLayout(this.sourceValue, safeWidth)
      this.renderedLines = this.layoutValue.rows.map(row => row.rendered)
    }
    return this.layoutValue
  }

  render(width: number): string[] {
    this.layoutAt(width)
    return [...this.renderedLines]
  }

  invalidate(): void {
    this.layoutValue = undefined
    this.renderedLines = []
  }
}
