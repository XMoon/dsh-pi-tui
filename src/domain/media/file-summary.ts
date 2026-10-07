/**
 * Transport/UI-neutral textual summary of a durable file attachment (TS8-D
 * move out of the legacy root `src/content-block-presentation.ts`).
 *
 * The summary is media vocabulary, not transcript semantics, so it lives in
 * `domain/media/**` — that keeps `domain/transcript/**` from importing another
 * domain subtree while preserving ONE file-summary formatter for the PiTui
 * attachment card, pending presentation, tool presentation and the Markdown
 * exporter.
 * @module @xmoon76/dsh-pi-tui/domain/media/file-summary
 */

import { formatBytes } from './format.ts'

/** The durable metadata needed for a file's human-facing summary. */
export interface FileAttachmentPresentationRef {
  readonly name: string
  readonly bytes: number
}

/** Render a FileBlock attachment without exposing its opaque storage id. */
export function fileAttachmentSummary(attachment: FileAttachmentPresentationRef): string {
  return `📄 ${attachment.name} · ${formatBytes(attachment.bytes)}`
}
