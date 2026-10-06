/**
 * Renderer-neutral structured summary of one ambient Context cluster.
 *
 * The collapsed cluster header summarizes its members from STRUCTURED
 * provenance only — each row's producer label or its declared form, never
 * arbitrary payload text. Duplicate labels compress to `label ×N` for display
 * only: the underlying transcript rows are never deduplicated, reordered or
 * removed.
 *
 * This module derives strings only; the header chrome (disclosure marker,
 * identity icon, theme, width) belongs to the PiTui component in
 * `tui/components/transcript/context-cluster.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/context-summary
 */

import { contextFormOf } from '../../domain/transcript/context-semantics.ts'
import type { TranscriptMessage } from '../../transcript.ts'
import type { ContextCluster } from './context-structure.ts'

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
