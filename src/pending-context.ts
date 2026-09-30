/**
 * The ephemeral pending Context tail row: the generic non-user presentation
 * of one authoritative `placement === 'context'` occurrence (a background
 * job / subagent settlement / injected input parked in the Host's next-step
 * inbox before it materializes).
 *
 * Presentation-only and Host-free: the row carries only the occurrence id and
 * the runner-projected text. The visual identity is deliberately GENERIC —
 * `context-generic` chrome plus a bounded body preview (the shared
 * `CompactTextPreview`, the same hardened wrap/cap/ellipsis the folded cards
 * use) and a waiting-status line. Source-specific presentation stays the
 * durable transcript's job after materialization; the raw DSH `source` never
 * crosses the semantic port, so nothing here infers a producer from text.
 *
 * Like the pending-user lane this row is ephemeral: never durable, never
 * searchable, never inside TranscriptFolder, Work spans or Context clusters.
 * The Host inbox is the ONLY lifecycle authority — when the Host claims the
 * occurrence the row disappears (a brief claim gap before the durable
 * `user/message` lands is acceptable; no shadow ledger papers over it).
 *
 * @module @xmoon76/dsh-pi-tui/pending-context
 */

import { truncateToWidth, type Component } from '@xmoon76/pi-tui'
import { CompactTextPreview } from './compact-text-preview.ts'
import { iconPrefix, type IconStyle } from './icons.ts'
import { color } from './theme.ts'

/**
 * The waiting-status line. While the subject RUNS the occurrence waits for
 * the CURRENT turn's next step; once the subject is no longer running (an
 * interrupted turn parked it) it waits for the next turn.
 */
function statusText(running: boolean): string {
  return running ? 'waiting for next step…' : 'waiting for next turn…'
}

/**
 * The pending Context tail row component. Every rendered element stays
 * exactly one physical row at every width: the header truncates, and the
 * bounded body preview wraps/caps/ellipsizes through the shared
 * `CompactTextPreview` geometry.
 */
export class PendingContextComponent implements Component {
  private readonly preview: CompactTextPreview
  private readonly running: boolean
  private readonly iconStyle: IconStyle

  constructor(text: string, running: boolean, iconStyle: IconStyle) {
    // Newlines flatten to spaces: the preview is one bounded paragraph, not
    // a multi-line card body.
    this.preview = new CompactTextPreview(text.replace(/\r\n|\r|\n/g, ' '), 2, '  ')
    this.running = running
    this.iconStyle = iconStyle
  }

  invalidate(): void {
    this.preview.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const icon = iconPrefix('context-generic', this.iconStyle)
    const header = color.textMuted(truncateToWidth(`${icon}Context`, safeWidth, '…'))
    const status = color.textMuted(truncateToWidth(`  ${statusText(this.running)}`, safeWidth, '…'))
    return [header, ...this.preview.render(safeWidth).map(color.text), status]
  }
}
