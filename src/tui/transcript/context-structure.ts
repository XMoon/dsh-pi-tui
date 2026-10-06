/**
 * Renderer-neutral ambient Context presentation structure.
 *
 * The semantic question "is this row an ambient Context fact?" belongs to the
 * transitional semantic source (`context-presentation.ts`, TS7:
 * `domain/transcript/**`). THIS module owns the presentation question: "which
 * presentation role does one surfaced Context row take, and where do adjacent
 * ambient facts form ONE presentation container with ONE owner?".
 *
 * Clustering is computed from RAW transcript chronology. Hiding Process rows in
 * a projection must never merge two Context rows that were not adjacent in the
 * raw transcript. The module is deliberately renderer-free: it never reads
 * width, theme, icons, preset, disclosure state, search state or a component.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/context-structure
 */

import { isAmbientContext, contextFormOf } from '../../domain/transcript/context-semantics.ts'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import { isSurfacedContext } from '../../domain/transcript/semantics.ts'

/** The presentation role one surfaced Context row takes. */
export type ContextPresentationKind = 'ambient' | 'notice' | 'relay' | 'recall' | 'generic'

/** Whether one row is a standalone producer notice. */
export function isNoticeContext(message: TranscriptMessage): boolean {
  return isSurfacedContext(message) && contextFormOf(message) === 'notice'
}

/** Whether one row is another Agent's relayed message. */
export function isRelayContext(message: TranscriptMessage): boolean {
  return isSurfacedContext(message) && contextFormOf(message) === 'relay'
}

/** Whether one row is recalled material from another session. The legacy
 * session-reference role counts even when its producer did not declare the
 * form, so a recalled row is never clustered as ambient. The A-layer provenance
 * accessor is private to the transitional semantic source, so the legacy role
 * is read from the row's own field here. */
export function isRecallContext(message: TranscriptMessage): boolean {
  if (!isSurfacedContext(message)) return false
  if (contextFormOf(message) === 'recall') return true
  return message.kind === 'system' && message.contextPresentation?.role === 'recall'
}

/** The presentation role of one injected Context row; undefined when the row
 * is not surfaced Context. Unknown/missing forms fail open to `generic`
 * (standalone), never to ambient. */
export function contextPresentationKind(message: TranscriptMessage): ContextPresentationKind | undefined {
  if (!isSurfacedContext(message)) return undefined
  if (isAmbientContext(message)) return 'ambient'
  if (isNoticeContext(message)) return 'notice'
  if (isRelayContext(message)) return 'relay'
  if (isRecallContext(message)) return 'recall'
  return 'generic'
}

/**
 * One raw-adjacent same-turn ambient Context run of 2+ rows.
 *
 * `owner` is the first member TranscriptMessage — the stable presentation
 * identity of the cluster (never an index or a display string). Members keep
 * their raw order; no original row is mutated.
 */
export interface ContextCluster {
  readonly kind: 'context-cluster'
  readonly turn: number
  readonly members: readonly TranscriptMessage[]
  readonly owner: TranscriptMessage
}

/** The raw-adjacency result over one transcript window. */
export interface ContextClustering {
  /** Every multi-row cluster, in raw order. */
  readonly clusters: readonly ContextCluster[]
  /** Every cluster member (owners included), mapped to its cluster. */
  readonly byMember: ReadonlyMap<TranscriptMessage, ContextCluster>
}

/**
 * Group raw-adjacent same-turn ambient Context rows into clusters.
 *
 * A cluster forms ONLY when every requirement holds: same turn, raw-adjacent
 * TranscriptMessage rows, each row surfaced Context, each row ambient form.
 * A single eligible row stays an ordinary ambient row (no cluster). Every
 * non-ambient boundary (Conversation, Process, Attention, notice, relay,
 * recall, unknown Context, workflow, compaction, window summary, turn
 * boundary) ends the current run.
 * @param messages - the transcript window in raw chronology.
 */
export function clusterAdjacentAmbientContext(messages: readonly TranscriptMessage[]): ContextClustering {
  const clusters: ContextCluster[] = []
  let run: (Extract<TranscriptMessage, { kind: 'system' }> & { context: true })[] = []
  const flush = (): void => {
    const first = run[0]
    if (first !== undefined && run.length >= 2) {
      clusters.push({ kind: 'context-cluster', turn: first.turn, members: run, owner: first })
    }
    run = []
  }
  for (const message of messages) {
    if (isAmbientContext(message)) {
      const first = run[0]
      if (first !== undefined && first.turn !== message.turn) flush()
      run.push(message)
      continue
    }
    flush()
  }
  flush()
  const byMember = new Map<TranscriptMessage, ContextCluster>()
  for (const cluster of clusters) {
    for (const member of cluster.members) byMember.set(member, cluster)
  }
  return { clusters, byMember }
}
