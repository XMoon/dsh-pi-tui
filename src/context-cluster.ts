/**
 * Ambient Context cluster presentation: the collapsed cluster header and its
 * structured summary line.
 *
 * A cluster is a raw-adjacent same-turn run of ambient Context rows (see
 * `context-presentation.ts`). The collapsed header names the member count and
 * summarizes the members from STRUCTURED provenance only — each row's
 * producer label or its declared form, never arbitrary payload text.
 * Duplicate labels compress to `label ×N` for display only: the underlying
 * transcript rows are never deduplicated, reordered or removed.
 *
 * The cluster block itself renders only the header (and the collapsed
 * summary); expanding it emits every member as an ordinary Context row that
 * the existing message renderer owns, so the cluster is never a second
 * context renderer.
 * @module @xmoon76/dsh-pi-tui/context-cluster
 */

import { truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import type { ContextCluster } from './context-presentation.ts'
import { contextFormOf } from './context-presentation.ts'
import { iconLead, sectionDisclosureSemantic, type IconStyle } from './icons.ts'
import { color } from './theme.ts'
import type { TranscriptMessage } from './transcript.ts'

/** The structured display name of one ambient Context member: its producer
 * label, else its declared form, else the generic role name. Never payload
 * text. */
function memberDisplayName(member: TranscriptMessage): string {
  if (member.kind !== 'system') return 'Context'
  if (member.label !== undefined && member.label !== '') return member.label
  const form = contextFormOf(member)
  return form === undefined ? 'Context' : form
}

/**
 * The compressed summary parts of one cluster, in first-seen member order:
 * consecutive runs of the same display name become `name ×N`. Display-only —
 * the caller must not treat the parts as the member list.
 */
export function contextClusterSummaryParts(cluster: ContextCluster): string[] {
  const parts: string[] = []
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const member of cluster.members) {
    const name = memberDisplayName(member)
    const seen = counts.get(name)
    if (seen === undefined) {
      counts.set(name, 1)
      order.push(name)
    } else {
      counts.set(name, seen + 1)
    }
  }
  for (const name of order) {
    const count = counts.get(name) ?? 1
    parts.push(count > 1 ? `${name} ×${count}` : name)
  }
  return parts
}

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
 * member rows follow.
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
    const indent = width >= 4 ? '  ' : ''
    const contentWidth = Math.max(1, width - visibleWidth(indent))
    // The header is chrome: truncate it to the CURRENT width at render time
    // (never bake a width), so every returned element stays exactly one
    // physical row even on a very narrow terminal.
    const header = truncateToWidth(
      formatContextClusterHeader(this.cluster, this.expanded, this.iconStyle),
      contentWidth,
      '…',
    )
    const lines = [`${indent}${color.textDim(header)}`]
    if (!this.expanded) {
      const summary = contextClusterSummaryParts(this.cluster).join(' · ')
      if (summary !== '') lines.push(`${indent}${color.textDim(truncateToWidth(summary, contentWidth, '…'))}`)
    }
    return lines
  }
}
