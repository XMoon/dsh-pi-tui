/**
 * Compact projection: contiguous Process runs become `Work` spans.
 *
 * Compact collapses CONTIGUOUS Process runs, never whole turns. Starting
 * from the raw transcript order, a maximal run of Process-classified rows
 * becomes one presentation-only {@link CompactWorkSpan}; every other
 * semantic boundary (Conversation, Attention, surfaced Context, workflow,
 * compaction, window summary, turn boundary) ends the run. Assistant
 * intermediate narration and the final answer stay outside Work at their
 * chronological positions, so the session data is never reordered or
 * duplicated.
 *
 * Surfaced Context rows are grouped by raw adjacency FIRST (see
 * `context-presentation.ts`); a cluster is a Work boundary exactly like a
 * standalone Context row, and hidden Process rows can never create a false
 * cluster.
 * @module @xmoon76/dsh-pi-tui/compact-projection
 */

import { classifyTranscriptMessage } from './transcript-semantics.ts'
import { clusterAdjacentAmbientContext, type ContextCluster } from './context-presentation.ts'
import type { TranscriptMessage } from './transcript.ts'

/**
 * One presentation-only contiguous Process run. `members` preserve raw
 * order, `owner` (the first member TranscriptMessage) is the stable
 * presentation identity, and no original message is mutated. The span
 * carries no durable state — its aggregate facts are derived at render time.
 */
export interface CompactWorkSpan {
  readonly kind: 'work'
  readonly turn: number
  readonly members: readonly TranscriptMessage[]
  readonly owner: TranscriptMessage
}

/** One Compact projection block, in visual order. */
export type CompactProjectedBlock =
  | { readonly kind: 'message'; readonly message: TranscriptMessage }
  | { readonly kind: 'work'; readonly span: CompactWorkSpan }
  | { readonly kind: 'context-cluster'; readonly cluster: ContextCluster; readonly expanded: boolean }

/** Projection inputs shared by every preset's cluster substitution. */
export interface CompactProjectionOptions {
  /** Work spans the user (or a search reveal) opened. */
  readonly expandedWorkOwners: ReadonlySet<TranscriptMessage>
  /** Ambient clusters the user (or a search reveal) opened. */
  readonly expandedClusters: ReadonlySet<TranscriptMessage>
  /** Messages a temporary search reveal must surface (the target row). */
  readonly forcedExpanded: ReadonlySet<TranscriptMessage>
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

/** Whether one row continues the current Work run. Process rows with a turn
 * number extend the run only while the turn is unchanged; turn-less rows
 * (window summaries) never enter Work. */
function isWorkMember(message: TranscriptMessage): message is TranscriptMessage & { turn: number } {
  return 'turn' in message && classifyTranscriptMessage(message).class === 'process'
}

/**
 * Project one transcript window into Compact presentation blocks.
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
  const clustering = clusterAdjacentAmbientContext(messages)
  const out: CompactProjectedBlock[] = []
  let run: TranscriptMessage[] = []
  let runTurn: number | undefined
  const flush = (): void => {
    const owner = run[0]
    if (owner !== undefined && runTurn !== undefined) {
      const span: CompactWorkSpan = { kind: 'work', turn: runTurn, members: run, owner }
      out.push({ kind: 'work', span })
      if (workExpanded(span, options)) {
        for (const member of run) out.push({ kind: 'message', message: member })
      }
    }
    run = []
    runTurn = undefined
  }
  for (const message of messages) {
    const cluster = clustering.byMember.get(message)
    if (cluster !== undefined) {
      flush()
      // The first member is the cluster header; expanding re-emits EVERY
      // member (owner included) as an ordinary Context row. Other members
      // contribute nothing on their own.
      if (message === cluster.owner) {
        const expanded = clusterExpanded(cluster, options)
        out.push({ kind: 'context-cluster', cluster, expanded })
        if (expanded) for (const member of cluster.members) out.push({ kind: 'message', message: member })
      }
      continue
    }
    if (isWorkMember(message)) {
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
