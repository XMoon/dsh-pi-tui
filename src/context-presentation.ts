/**
 * Form-aware surfaced-Context presentation roles and ambient clustering.
 *
 * The producer-declared `MessageSource.form` (recorded on the folded system
 * row as {@link TranscriptContextPresentation}) decides HOW one injected
 * Context row is presented: `instructions`/`catalog`/`snapshot` are ambient
 * foundation and may cluster when raw-adjacent; `notice`/`relay`/`recall`
 * are standalone accounts. The semantic class of every row stays `Context`
 * and `context:true` stays the surfaced authority — this module only reads
 * presentation provenance.
 *
 * Clustering is computed from RAW transcript chronology. Hiding Process rows
 * in a projection must never merge two Context rows that were not adjacent
 * in the raw transcript.
 * @module @xmoon76/dsh-pi-tui/context-presentation
 */

import type { TranscriptContextForm } from './context.ts'
import type { TranscriptMessage } from './transcript.ts'
import { isSurfacedContext } from './transcript-semantics.ts'

/** The ambient foundation forms: their adjacent rows may cluster. */
export const AMBIENT_CONTEXT_FORMS: readonly TranscriptContextForm[] = ['instructions', 'catalog', 'snapshot']

/** The presentation role one surfaced Context row takes. */
export type ContextPresentationKind = 'ambient' | 'notice' | 'relay' | 'recall' | 'generic'

/** One injected Context row's presentation provenance, or undefined. */
function presentationOf(message: TranscriptMessage): NonNullable<Extract<TranscriptMessage, { kind: 'system' }>['contextPresentation']> | undefined {
  return message.kind === 'system' ? message.contextPresentation : undefined
}

/** The producer-declared form of one row, when recorded. */
export function contextFormOf(message: TranscriptMessage): TranscriptContextForm | undefined {
  return presentationOf(message)?.form
}

/** Whether one row is ambient foundation (instructions/catalog/snapshot). */
export function isAmbientContext(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  const form = contextFormOf(message)
  return isSurfacedContext(message) && form !== undefined && AMBIENT_CONTEXT_FORMS.includes(form)
}

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
 * form, so a recalled row is never clustered as ambient. */
export function isRecallContext(message: TranscriptMessage): boolean {
  return isSurfacedContext(message) && (contextFormOf(message) === 'recall' || presentationOf(message)?.role === 'recall')
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
