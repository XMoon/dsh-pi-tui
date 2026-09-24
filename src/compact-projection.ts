/**
 * Compact materialization over the canonical transcript structure.
 *
 * The semantic segmentation is owned by `transcript-projection.ts`; this module
 * only decides how Compact PRESENTS it: a collapsed Work span emits its header
 * block, an expanded span emits the header followed by its raw member rows, and
 * an ambient Context cluster emits a header (or flat members on a surface with
 * no operable cluster owner) with its members revealed on expansion. Search
 * forces exactly the owning span/cluster open while content refresh keeps the
 * collapsed header in place.
 * @module @xmoon76/dsh-pi-tui/compact-projection
 */

import type { ContextCluster } from './context-presentation.ts'
import { projectTranscriptStructure, type TranscriptWorkSpan } from './transcript-projection.ts'
import type { TranscriptContainerPath } from './transcript-disclosure.ts'
import type { TranscriptMessage } from './transcript.ts'

/**
 * The Compact Work span is the canonical {@link TranscriptWorkSpan}. The alias
 * keeps the Compact presentation vocabulary while the shared semantic type
 * stays preset-neutral.
 */
export type CompactWorkSpan = TranscriptWorkSpan

/** One Compact projection block, in visual order. Message rows carry their
 * outer-to-inner semantic container ancestry so the renderer never infers
 * ownership from screen geometry. */
export type CompactProjectedBlock =
  | { readonly kind: 'message'; readonly message: TranscriptMessage; readonly containerPath?: TranscriptContainerPath }
  | { readonly kind: 'work'; readonly span: CompactWorkSpan; readonly containerPath?: TranscriptContainerPath }
  | { readonly kind: 'context-cluster'; readonly cluster: ContextCluster; readonly expanded: boolean; readonly containerPath?: TranscriptContainerPath }

/** Compact projection inputs: the manual Work/cluster disclosures and the
 * temporary search reveal. Full and Focus materialize their own presentation
 * from TuiApp state, so this options bag is Compact-only. */
export interface CompactProjectionOptions {
  /** Work spans the user (or a search reveal) opened. */
  readonly expandedWorkOwners: ReadonlySet<TranscriptMessage>
  /** Ambient clusters the user (or a search reveal) opened. */
  readonly expandedClusters: ReadonlySet<TranscriptMessage>
  /** Messages a temporary search reveal must surface (the target row). */
  readonly forcedExpanded: ReadonlySet<TranscriptMessage>
  /**
   * Whether a cluster emits its header block. `false` is the FLAT presentation
   * a surface without any manual cluster disclosure owner uses: the semantic
   * cluster still groups the rows (ownership/search), but the members render
   * directly instead of a header whose affordance nobody can operate.
   */
  readonly clusterHeader?: boolean
  /**
   * Whether a Work span emits its header block. `false` is the FLAT
   * fail-open presentation a surface without an operable Work disclosure action
   * uses: the canonical span still groups the rows (ownership/search), but its
   * members render directly instead of a header nobody can open.
   */
  readonly workHeader?: boolean
}

/** Whether one Work span is effectively expanded. */
function workExpanded(span: CompactWorkSpan, options: CompactProjectionOptions): boolean {
  if (options.expandedWorkOwners.has(span.owner)) return true
  return span.members.some(member => options.forcedExpanded.has(member))
}

/** Whether one ambient cluster is effectively expanded. */
function clusterExpanded(cluster: ContextCluster, options: CompactProjectionOptions): boolean {
  if (options.expandedClusters.has(cluster.owner)) return true
  return cluster.members.some(member => options.forcedExpanded.has(member))
}

/**
 * Materialize the canonical structure for Compact.
 *
 * A collapsed Work span emits only its header block; an expanded span emits
 * the header followed by its raw member rows (the existing message
 * renderers own each child). A collapsed ambient cluster emits only its
 * header block; an expanded cluster emits the header followed by every
 * member. Search-forced members open exactly the owning span/cluster.
 * @param messages - the transcript window in raw chronology.
 * @param options - manual disclosures and the temporary search reveal.
 */
export function projectCompact(
  messages: readonly TranscriptMessage[],
  options: CompactProjectionOptions,
): CompactProjectedBlock[] {
  const out: CompactProjectedBlock[] = []
  for (const block of projectTranscriptStructure(messages)) {
    if (block.kind === 'message') {
      out.push({ kind: 'message', message: block.message })
      continue
    }
    if (block.kind === 'work') {
      const span = block.span
      const containerPath: TranscriptContainerPath = [{ kind: 'work', owner: span.owner }]
      if (options.workHeader === false) {
        for (const member of span.members) out.push({ kind: 'message', message: member, containerPath })
        continue
      }
      out.push({ kind: 'work', span, containerPath })
      if (workExpanded(span, options)) {
        for (const member of span.members) out.push({ kind: 'message', message: member, containerPath })
      }
      continue
    }
    // The first member is the cluster header; expanding re-emits EVERY
    // member (owner included) as an ordinary Context row.
    const cluster = block.cluster
    const containerPath: TranscriptContainerPath = [{ kind: 'context-cluster', owner: cluster.owner }]
    if (options.clusterHeader === false) {
      for (const member of cluster.members) out.push({ kind: 'message', message: member, containerPath })
      continue
    }
    const expanded = clusterExpanded(cluster, options)
    out.push({ kind: 'context-cluster', cluster, expanded, containerPath })
    if (expanded) for (const member of cluster.members) out.push({ kind: 'message', message: member, containerPath })
  }
  return out
}
