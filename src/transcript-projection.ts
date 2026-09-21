/**
 * Canonical preset-neutral transcript structure projection.
 *
 * This module owns the ONE semantic segmentation of a raw transcript window:
 * maximal contiguous same-turn Process runs become {@link TranscriptWorkSpan}s
 * and raw-adjacent same-turn ambient Context runs become
 * {@link ContextCluster}s (every other semantic boundary ends a run). It is
 * deliberately blind to the active preset, the surface, disclosure state,
 * search state, render width and the renderer registry: it answers only
 * "where does the raw chronology form Work, a Context cluster, or a
 * standalone row?".
 *
 * `projectCompact()` is the Compact materialization adapter over this
 * structure, Full materializes it with expanded-flat Work and the shared
 * cluster presentation, and expanded Focus consumes it for its process tail.
 * The same boundary identity is therefore never re-derived per preset.
 *
 * The projector is a single forward pass plus the linear ambient-clustering
 * pass (O(n)); wrappers are freshly allocated each call, but their
 * `owner`/`members` always reference the original `TranscriptMessage`
 * objects, so presentation caches can compare owner + member identity/order.
 * @module @xmoon76/dsh-pi-tui/transcript-projection
 */

import { clusterAdjacentAmbientContext, type ContextCluster } from './context-presentation.ts'
import { classifyTranscriptMessage, isSurfacedInteractionTool } from './transcript-semantics.ts'
import type { TranscriptMessage } from './transcript.ts'

/**
 * One presentation-only contiguous Process run. `members` preserve raw
 * order, `owner` (the first member TranscriptMessage) is the stable
 * presentation identity, and no original message is mutated. The span
 * carries no durable state — its aggregate facts are derived at render time.
 */
export interface TranscriptWorkSpan {
  readonly kind: 'work'
  readonly turn: number
  readonly members: readonly TranscriptMessage[]
  readonly owner: TranscriptMessage
}

/** One canonical structural block, in raw visual order. */
export type TranscriptStructureBlock =
  | { readonly kind: 'message'; readonly message: TranscriptMessage }
  | { readonly kind: 'work'; readonly span: TranscriptWorkSpan }
  | { readonly kind: 'context-cluster'; readonly cluster: ContextCluster }

/**
 * Whether one row continues the current Work run. Process rows with a turn
 * number extend the run only while the turn is unchanged; turn-less rows
 * (window summaries) never enter Work. A settled surfaced-interaction card
 * (question / Plan review) is human-decision evidence, not Process work — it
 * never joins a span (and so never counts toward its tool count/preview); it
 * flushes the run and renders standalone. Exported so the live Preparing
 * ownership consumes the SAME boundary authority as every projection: a
 * settled interaction closes the trailing run.
 */
export function isTranscriptWorkMember(message: TranscriptMessage): message is TranscriptMessage & { turn: number } {
  return 'turn' in message
    && classifyTranscriptMessage(message).class === 'process'
    && !isSurfacedInteractionTool(message)
}

/**
 * Segment one raw transcript window into canonical structural blocks.
 *
 * Ambient Context clusters are computed FIRST from raw adjacency, so a hidden
 * Process row can never merge two Context rows that were not adjacent, and a
 * cluster is a Work boundary exactly like a standalone Context row. A settled
 * surfaced-interaction card is its own boundary and belongs to neither the
 * preceding nor the following span. The result partitions `messages` exactly:
 * every input row appears once, in raw order, either as a `message` block, a
 * Work member, or a cluster member.
 * @param messages - the transcript window in raw chronology.
 */
export function projectTranscriptStructure(messages: readonly TranscriptMessage[]): TranscriptStructureBlock[] {
  const clustering = clusterAdjacentAmbientContext(messages)
  const out: TranscriptStructureBlock[] = []
  let run: TranscriptMessage[] = []
  let runTurn: number | undefined
  const flush = (): void => {
    const owner = run[0]
    if (owner !== undefined && runTurn !== undefined) {
      out.push({ kind: 'work', span: { kind: 'work', turn: runTurn, members: run, owner } })
    }
    run = []
    runTurn = undefined
  }
  for (const message of messages) {
    const cluster = clustering.byMember.get(message)
    if (cluster !== undefined) {
      flush()
      // The first member is the cluster header; other members contribute
      // nothing on their own.
      if (message === cluster.owner) out.push({ kind: 'context-cluster', cluster })
      continue
    }
    if (isSurfacedInteractionTool(message)) {
      flush()
      out.push({ kind: 'message', message })
      continue
    }
    if (isTranscriptWorkMember(message)) {
      if (run.length > 0 && runTurn !== message.turn) flush()
      run.push(message)
      runTurn = message.turn
      continue
    }
    flush()
    out.push({ kind: 'message', message })
  }
  flush()
  return out
}

/**
 * Map every Work member to its canonical span in one linear pass. Disclosure,
 * search and pruning read Work ownership through THIS index instead of
 * scanning a preset materialization (or re-projecting Compact) merely to ask
 * "which Work span owns this row?".
 * @param structure - the canonical structural blocks for one window.
 */
export function workByMemberOf(
  structure: readonly TranscriptStructureBlock[],
): ReadonlyMap<TranscriptMessage, TranscriptWorkSpan> {
  const byMember = new Map<TranscriptMessage, TranscriptWorkSpan>()
  for (const block of structure) {
    if (block.kind !== 'work') continue
    for (const member of block.span.members) byMember.set(member, block.span)
  }
  return byMember
}

/**
 * Map every Context-cluster member to its canonical cluster. Presentation
 * layers that reorder or hoist rows (collapsed/expanded Focus) consume THIS
 * identity instead of re-clustering the reordered sequence, so canonical
 * membership stays the only cluster authority.
 * @param structure - the canonical structural blocks for one window.
 */
export function clusterByMemberOf(
  structure: readonly TranscriptStructureBlock[],
): ReadonlyMap<TranscriptMessage, ContextCluster> {
  const byMember = new Map<TranscriptMessage, ContextCluster>()
  for (const block of structure) {
    if (block.kind !== 'context-cluster') continue
    for (const member of block.cluster.members) byMember.set(member, block.cluster)
  }
  return byMember
}
