/**
 * One Host-native Assistant Markdown body that can prove a SOURCE-LOCAL range
 * against the cells its OWN live renderer painted.
 *
 * The card is exactly the existing `BulletedComponent(new Markdown(...),
 * bullet)` construction: this subclass only keeps the SAME `Markdown` object
 * and the bullet's visible width so a proof request can reach the vendored
 * `Markdown.proveSourceSpan` (X076) and shift its component-local columns by
 * the bullet/continuation indent. It owns no second renderer, parser, cache or
 * paint path — `render()`, `invalidate()` and `dispose()` are inherited
 * unchanged, so a steady frame keeps the reference-stable output and the
 * Host's cached component identity keeps meaning the same thing.
 *
 * Plugin-owned cards, `VisualAssistantBody`, multi-ContentBlock sequences,
 * open-opaque streams and delivered-file/interrupted wrappers never construct
 * this class as their card root, so they can never borrow its proof.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/assistant-markdown-source-proof
 */

import { visibleWidth, type Markdown, type MarkdownSourceCellProof } from '@xmoon76/pi-tui'
import { BulletedComponent } from '../transcript-leaves.ts'

/** A single Host Assistant Markdown body, with the SAME live renderer as the
 * painted bullet card. */
export class AssistantMarkdownComponent extends BulletedComponent {
  private readonly markdown: Markdown
  private readonly bulletWidth: number

  constructor(markdown: Markdown, bullet: string) {
    super(markdown, bullet)
    this.markdown = markdown
    this.bulletWidth = visibleWidth(bullet)
  }

  /** F1 component-local source span -> THIS bullet card's rows/cells. No new
   * render owner: the columns gain exactly the bullet/continuation indent the
   * inherited `render()` prepends, and rows are unchanged. */
  proveSourceSpan(
    range: { readonly start: number; readonly end: number },
    cardWidth: number,
  ): MarkdownSourceCellProof {
    // The inherited `render(cardWidth)` hands the child `max(1, cardWidth -
    // prefixWidth)`, so the proof must ask for THAT same inner width.
    const proof = this.markdown.proveSourceSpan(range, Math.max(1, cardWidth - this.bulletWidth))
    if (proof.kind !== 'PROVEN') return proof
    return {
      kind: 'PROVEN',
      segments: proof.segments.map(({ row, startCol, endCol }) => ({
        row,
        startCol: startCol + this.bulletWidth,
        endCol: endCol + this.bulletWidth,
      })),
    }
  }
}
