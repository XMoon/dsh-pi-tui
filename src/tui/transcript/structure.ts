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
 * A Work span may CARRY a foldable Context row as a structural part without
 * making it Process: the row keeps its Context semantics, its source bytes and
 * its own disclosure, but no longer splits one turn's Activity/Thought. Two
 * narrow forms qualify: a `form:'snapshot'` singleton / snapshot-only raw
 * cluster, and a `tool-jobs` Notice with durable same-turn `next-step`
 * delivery evidence. A mixed `instructions`/`catalog`/`snapshot` cluster and
 * every other Notice form stay independent Context boundaries.
 *
 * The projector is a single forward pass plus the linear ambient-clustering
 * pass (O(n)); wrappers are freshly allocated each call, but their
 * `owner`/`members` always reference the original `TranscriptMessage`
 * objects, so presentation caches can compare owner + member identity/order.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/structure
 */

import { clusterAdjacentAmbientContext, type ContextCluster } from './context-structure.ts'
import { contextFormOf } from '../../domain/transcript/context-semantics.ts'
import { classifyTranscriptMessage, isPostTurnReplayEvidence, isSurfacedContext, isSurfacedInteractionTool } from '../../domain/transcript/semantics.ts'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'

/**
 * One ordered structural part of a Work span: a raw message row, or a nested
 * raw-adjacent Context cluster carried inside the span. `members` remains the
 * flat raw row sequence, so aggregation consumers keep one member walk while
 * materializers preserve the cluster container the same projector decided.
 */
export type TranscriptWorkPart =
  | { readonly kind: 'message'; readonly message: TranscriptMessage }
  | { readonly kind: 'context-cluster'; readonly cluster: ContextCluster }

/**
 * One presentation-only contiguous Process run. `members` preserve raw
 * order (Snapshot Context rows included as carried parts), `owner` (the
 * first member TranscriptMessage) is the stable presentation identity, and no
 * original message is mutated. The span carries no durable state — its
 * aggregate facts are derived at render time.
 */
export interface TranscriptWorkSpan {
  readonly kind: 'work'
  readonly turn: number
  readonly members: readonly TranscriptMessage[]
  readonly owner: TranscriptMessage
  /** The same raw chronology grouped for materialization: single message rows
   * and nested snapshot-only Context clusters. */
  readonly parts: readonly TranscriptWorkPart[]
}

/** One canonical structural block, in raw visual order. */
export type TranscriptStructureBlock =
  | { readonly kind: 'message'; readonly message: TranscriptMessage }
  | { readonly kind: 'work'; readonly span: TranscriptWorkSpan }
  | { readonly kind: 'context-cluster'; readonly cluster: ContextCluster }

/**
 * Whether one row continues the current Work run. Process rows with a turn
 * number extend the run only while the turn is unchanged; turn-less rows
 * (window summaries, standalone control-plane commands) never enter Work by
 * construction — a `kind: 'command'` row has no turn and a `control` class.
 * A settled surfaced-interaction card (question / Plan review) is
 * human-decision evidence, not Process work — it never joins a span (and so
 * never counts toward its tool count/preview); it flushes the run and
 * renders standalone. Exported so the live Preparing ownership consumes the
 * SAME boundary authority as every projection: a settled interaction closes
 * the trailing run.
 *
 * This predicate deliberately does NOT admit Snapshot Context: it also answers
 * Process/live-Preparing eligibility. Work PRESENTATION carriage is decided by
 * {@link isFoldableSnapshotContext} inside {@link projectTranscriptStructure}.
 */
export function isTranscriptWorkMember(message: TranscriptMessage): message is TranscriptMessage & { turn: number } {
  return 'turn' in message
    && classifyTranscriptMessage(message).class === 'process'
    && !isSurfacedInteractionTool(message)
    // Post-turn replay evidence stays in the transcript but is never Process
    // aggregation evidence for the settled turn: it must not join a Work
    // span (and so must not feed its Action stats/preview).
    && !isPostTurnReplayEvidence(message)
}

/** Whether one row is a producer-declared Snapshot Context row (the ONE
 * ambient form whose disclosure follows the surrounding Work/Thought). */
export function isSnapshotContext(
  message: TranscriptMessage,
): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  return isSurfacedContext(message) && contextFormOf(message) === 'snapshot'
}

/** Whether one raw-adjacent ambient cluster consists ONLY of Snapshot rows, so
 * the whole cluster may be carried inside a Work span without tearing a mixed
 * foundation cluster apart. */
export function isSnapshotOnlyCluster(cluster: ContextCluster): boolean {
  return cluster.members.every(isSnapshotContext)
}

/**
 * The narrow display-layer predicate: may this Snapshot row's presentation be
 * carried by the same-turn Work/Thought instead of ending it?
 *
 * The answer is source-derived (`form:'snapshot'`) and depends on the raw
 * adjacency result: a Snapshot that shares its raw-adjacent ambient cluster
 * with `instructions`/`catalog` is part of one indivisible mixed Context
 * cluster and stays a Work boundary. A singleton Snapshot or a snapshot-only
 * cluster is foldable.
 * @param message - one raw transcript row.
 * @param clusterByMember - raw-adjacency membership for the SAME window.
 */
export function isFoldableSnapshotContext(
  message: TranscriptMessage,
  clusterByMember: ReadonlyMap<TranscriptMessage, ContextCluster>,
): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  if (!isSnapshotContext(message)) return false
  const cluster = clusterByMember.get(message)
  return cluster === undefined || isSnapshotOnlyCluster(cluster)
}

/**
 * Whether one row is a Working `tool-jobs` completion Notice with durable
 * same-turn `next-step` delivery evidence.
 *
 * This is a NARROW exception, never a generic notice rule: the producer-declared
 * `sourceKind === 'tool-jobs'` AND `form === 'notice'` are both required, plus
 * the fold's presentation-only `sameTurnNextStep` flag derived from the durable
 * `agent/inbox/spliced` insert/claim identity chain. A `next-turn` wakeup, a
 * foreign/legacy log, a different producer (including `subagent-settled`) or a
 * missing claim carries no flag and therefore stays an independent Context
 * boundary.
 */
export function isWorkingToolJobsNotice(
  message: TranscriptMessage,
): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  if (!isSurfacedContext(message)) return false
  const presentation = message.contextPresentation
  return presentation !== undefined
    && presentation.sameTurnNextStep === true
    && presentation.form === 'notice'
    && presentation.sourceKind === 'tool-jobs'
}

/**
 * The complete narrow display-layer eligibility: may this Context row be
 * carried by the same-turn Work/Thought instead of ending it? Only a foldable
 * Snapshot or a proven Working `tool-jobs` Notice qualifies; every other
 * surfaced Context remains a boundary.
 */
export function isFoldableWorkContext(
  message: TranscriptMessage,
  clusterByMember: ReadonlyMap<TranscriptMessage, ContextCluster>,
): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  return isFoldableSnapshotContext(message, clusterByMember) || isWorkingToolJobsNotice(message)
}

/**
 * Segment one raw transcript window into canonical structural blocks.
 *
 * Ambient Context clusters are computed FIRST from raw adjacency, so a hidden
 * Process row can never merge two Context rows that were not adjacent, and a
 * cluster is a Work boundary exactly like a standalone Context row — except a
 * snapshot-only cluster, which is carried as a nested part of the surrounding
 * same-turn Work.
 *
 * Snapshot Context rows seen before the first Process of a same-turn run are
 * held in a CALL-LOCAL pending buffer: they join the run once a real Process
 * arrives, or materialize as their original Context block(s) when a hard
 * boundary or the window end arrives first. The buffer never persists across
 * calls and never invents a Process-free Work span.
 *
 * A settled surfaced-interaction card is its own boundary and belongs to
 * neither the preceding nor the following span. The result partitions
 * `messages` exactly: every input row appears once, in raw order, either as a
 * `message` block, a Work member, or a cluster member.
 * @param messages - the transcript window in raw chronology.
 */
export function projectTranscriptStructure(messages: readonly TranscriptMessage[]): TranscriptStructureBlock[] {
  const clustering = clusterAdjacentAmbientContext(messages)
  const out: TranscriptStructureBlock[] = []
  let runParts: TranscriptWorkPart[] = []
  let runMembers: TranscriptMessage[] = []
  let runTurn: number | undefined
  // Snapshot-only rows waiting for the same turn's first real Process. It is
  // a local linear buffer, never long-lived projection state.
  let pendingParts: TranscriptWorkPart[] = []
  let pendingMembers: TranscriptMessage[] = []
  let pendingTurn: number | undefined
  const materializePending = (): void => {
    for (const part of pendingParts) {
      if (part.kind === 'message') {
        out.push({ kind: 'message', message: part.message })
      } else {
        out.push({ kind: 'context-cluster', cluster: part.cluster })
      }
    }
    pendingParts = []
    pendingMembers = []
    pendingTurn = undefined
  }
  const pushPending = (parts: TranscriptWorkPart[], members: readonly TranscriptMessage[], turn: number): void => {
    if (pendingMembers.length > 0 && pendingTurn !== turn) materializePending()
    pendingParts.push(...parts)
    pendingMembers.push(...members)
    pendingTurn = turn
  }
  const flush = (): void => {
    materializePending()
    const owner = runMembers[0]
    if (owner !== undefined && runTurn !== undefined) {
      out.push({ kind: 'work', span: { kind: 'work', turn: runTurn, members: runMembers, owner, parts: runParts } })
    }
    runParts = []
    runMembers = []
    runTurn = undefined
  }
  for (const message of messages) {
    const cluster = clustering.byMember.get(message)
    if (cluster !== undefined) {
      if (!isSnapshotOnlyCluster(cluster)) {
        flush()
        // The first member is the cluster header; other members contribute
        // nothing on their own.
        if (message === cluster.owner) out.push({ kind: 'context-cluster', cluster })
        continue
      }
      // A snapshot-only cluster is one transparent Work part: all its members
      // are appended together when its owner is reached.
      if (message !== cluster.owner) continue
      if (runMembers.length > 0) {
        if (runTurn === cluster.turn) {
          runParts.push({ kind: 'context-cluster', cluster })
          runMembers.push(...cluster.members)
          continue
        }
        flush()
      }
      pushPending([{ kind: 'context-cluster', cluster }], cluster.members, cluster.turn)
      continue
    }
    if (isFoldableWorkContext(message, clustering.byMember)) {
      if (runMembers.length > 0) {
        if (runTurn === message.turn) {
          runParts.push({ kind: 'message', message })
          runMembers.push(message)
          continue
        }
        flush()
      }
      pushPending([{ kind: 'message', message }], [message], message.turn)
      continue
    }
    if (isSurfacedInteractionTool(message)) {
      flush()
      out.push({ kind: 'message', message })
      continue
    }
    if (isTranscriptWorkMember(message)) {
      if (runMembers.length > 0 && runTurn !== message.turn) flush()
      if (runMembers.length === 0) {
        // The first real Process adopts the same-turn pending Snapshot rows, so
        // they land inside the Work instead of splitting it. A different-turn
        // pending row materializes at its original Context position.
        if (pendingMembers.length > 0 && pendingTurn !== message.turn) materializePending()
        runParts = pendingParts
        runMembers = pendingMembers
        pendingParts = []
        pendingMembers = []
        pendingTurn = undefined
      }
      runParts.push({ kind: 'message', message })
      runMembers.push(message)
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
 * membership stays the only cluster authority. Snapshot-only clusters nested
 * inside a Work span are included: their members must resolve to BOTH their
 * Work and cluster ancestors for disclosure/search.
 * @param structure - the canonical structural blocks for one window.
 */
export function clusterByMemberOf(
  structure: readonly TranscriptStructureBlock[],
): ReadonlyMap<TranscriptMessage, ContextCluster> {
  const byMember = new Map<TranscriptMessage, ContextCluster>()
  const add = (cluster: ContextCluster): void => {
    for (const member of cluster.members) byMember.set(member, cluster)
  }
  for (const block of structure) {
    if (block.kind === 'context-cluster') {
      add(block.cluster)
      continue
    }
    if (block.kind !== 'work') continue
    for (const part of block.span.parts) {
      if (part.kind === 'context-cluster') add(part.cluster)
    }
  }
  return byMember
}
