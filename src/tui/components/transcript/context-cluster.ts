/**
 * PiTui ambient Context cluster presentation: the collapsed cluster header
 * chrome and the structured summary line.
 *
 * A cluster is a raw-adjacent same-turn run of ambient Context rows (see
 * `tui/transcript/context-structure.ts`). The collapsed header names the member
 * count and renders the cluster's summary parts, which are derived from
 * STRUCTURED provenance only by the renderer-neutral
 * `tui/transcript/context-summary.ts` — never from arbitrary payload text.
 *
 * The cluster block itself renders only the header (and the collapsed
 * summary); expanding it emits every member as an ordinary Context row that
 * the existing message renderer owns, so the cluster is never a second
 * context renderer.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/context-cluster
 */

import { truncateToWidth, type Component } from '@xmoon76/pi-tui'
import type { ContextCluster } from '../../transcript/context-structure.ts'
import { contextClusterSummaryParts } from '../../transcript/context-summary.ts'
import { iconLead, sectionDisclosureSemantic, type IconStyle } from '../../../icons.ts'
import { color } from '../../../theme.ts'

/** The cluster header: `▸ 📎 Context · 6 injections`.
 *
 * Two independent semantics compose here: the section disclosure state marker
 * (`sectionDisclosureSemantic`, which survives every icon style) and the
 * Context identity icon (`context-generic`, which `minimal` hides). Each part
 * carries its trailing separator only when its glyph exists (`iconLead`), so
 * `minimal` never leaves a dangling space and the emoji/symbols layouts read
 * `▸ 📎 Context · …` / `▸ ⋅ Context · …`. The marker is chrome whose glyphs
 * resolve through the icon registry, never a hard-coded string. */
export function formatContextClusterHeader(
  cluster: ContextCluster,
  expanded: boolean,
  iconStyle: IconStyle = 'emoji',
): string {
  const count = cluster.members.length
  const disclosure = iconLead(sectionDisclosureSemantic(expanded), iconStyle)
  const identity = iconLead('context-generic', iconStyle)
  return `${disclosure}${identity}Context · ${count} injection${count === 1 ? '' : 's'}`
}

/**
 * The collapsed ambient Context cluster header + structured summary. The
 * summary wraps naturally at the CURRENT width (render-time truncation, never
 * a width-baked one-line string); expanding hides the summary because the
 * member rows follow. The chrome shares the transcript left edge
 * (presentation-convergence addendum v2 §33): no outer indent, so the
 * expanded member rows and the cluster header align on one boundary.
 */
export class ContextClusterComponent implements Component {
  private readonly cluster: ContextCluster
  private readonly expanded: boolean
  private readonly iconStyle: IconStyle

  constructor(options: { cluster: ContextCluster; expanded: boolean; iconStyle?: IconStyle }) {
    this.cluster = options.cluster
    this.expanded = options.expanded
    this.iconStyle = options.iconStyle ?? 'emoji'
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width)
    // The header is chrome: truncate it to the CURRENT width at render time
    // (never bake a width), so every returned element stays exactly one
    // physical row even on a very narrow terminal.
    const header = truncateToWidth(
      formatContextClusterHeader(this.cluster, this.expanded, this.iconStyle),
      contentWidth,
      '…',
    )
    const lines = [color.textDim(header)]
    if (!this.expanded) {
      const summary = contextClusterSummaryParts(this.cluster).join(' · ')
      if (summary !== '') lines.push(color.textDim(truncateToWidth(summary, contentWidth, '…')))
    }
    return lines
  }
}
