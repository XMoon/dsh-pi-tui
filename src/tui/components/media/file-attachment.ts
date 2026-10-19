/**
 * Synchronous presentation of one durable FileBlock attachment.
 *
 * Only the sanitized name and byte count are rendered. The opaque attachment
 * id is not a path and is intentionally omitted from the ordinary TUI.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/file-attachment
 */

import { truncateToWidth, type Component } from '@xmoon76/pi-tui'
import { fileAttachmentSummary, type FileAttachmentPresentationRef } from '../../../domain/media/file-summary.ts'
import { sanitizedPhysicalLine } from '../../presentation/lines.ts'

/** The caller-owned color surface for attachment rows. */
export interface FileAttachmentTheme {
  fallbackColor(text: string): string
}

/** One width-aware, stateless FileBlock row. */
export class FileAttachmentComponent implements Component {
  private readonly attachment: FileAttachmentPresentationRef
  private readonly theme: FileAttachmentTheme
  private readonly cached = new Map<number, string[]>()

  constructor(attachment: FileAttachmentPresentationRef, theme: FileAttachmentTheme) {
    this.attachment = attachment
    this.theme = theme
  }

  invalidate(): void {
    this.cached.clear()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const existing = this.cached.get(safeWidth)
    if (existing !== undefined) return existing
    // The attachment name is external (a Host/tool file name): project it
    // before the theme colors the row.
    const lines = [this.theme.fallbackColor(truncateToWidth(
      sanitizedPhysicalLine(fileAttachmentSummary(this.attachment)),
      safeWidth,
      '…',
    ))]
    this.cached.set(safeWidth, lines)
    return lines
  }
}
