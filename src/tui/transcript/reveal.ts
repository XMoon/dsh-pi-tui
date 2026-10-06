/**
 * Renderer-neutral transcript search-reveal resolution.
 *
 * This module answers exactly two questions for one transcript row on the
 * current preset/surface:
 *
 * 1. which canonical Work span / Context cluster containers COULD hide it
 *    ({@link transcriptRevealAncestryFor}); and
 * 2. which of those containers actually hide it RIGHT NOW
 *    ({@link transcriptRevealPathFor}).
 *
 * The split is deliberate: the stable ancestry depends only on the canonical
 * structure and the surface's disclosure capability, while the current
 * open/hidden state is mutable TuiApp state, so a disclosure toggle can never
 * be served a stale path.
 *
 * It owns no search state: the search target, the reveal grant, the memo
 * lifetime, the Focus-root reveal (`searchTargetTurn()`), the dismissal
 * promotion, the scroll position and the highlight all stay in TuiApp. The
 * Focus root is still represented separately by the TuiApp seam and is not a
 * node here.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/reveal
 */

import type { TranscriptMessage } from '../../transcript.ts'
import type { ContextCluster } from './context-structure.ts'
import type { TranscriptContainerOwner, TranscriptContainerPath } from './container-owner.ts'
import type { TranscriptWorkSpan } from './structure.ts'

/**
 * The STABLE ancestry of one search target on the current preset/surface: the
 * canonical Work span and/or Context cluster that could hide it. The current
 * open/hidden state is deliberately NOT part of this value (plan §30).
 */
export interface TranscriptRevealAncestry {
  readonly work?: TranscriptWorkSpan
  readonly cluster?: ContextCluster
}

/**
 * The canonical membership maps plus the surface capabilities that decide
 * whether a container can hide anything at all. `workIsContainer` is false on a
 * flat fail-open Work presentation (no header, no operable disclosure) and
 * `clusterIsContainer` is false on a flat fail-open cluster presentation; a
 * flat container hides nothing, so it must mint no reveal node.
 */
export interface TranscriptRevealAncestryInputs {
  readonly workByMember: ReadonlyMap<TranscriptMessage, TranscriptWorkSpan>
  readonly clusterByMember: ReadonlyMap<TranscriptMessage, ContextCluster>
  readonly workIsContainer: boolean
  readonly clusterIsContainer: boolean
}

/**
 * Resolve the stable reveal ancestry of one row from the canonical structure.
 * Only containers the current surface actually materializes as collapsible
 * headers are resolved; the semantic clustering/Work membership is untouched.
 */
export function transcriptRevealAncestryFor(
  message: TranscriptMessage,
  inputs: TranscriptRevealAncestryInputs,
): TranscriptRevealAncestry {
  const ancestry: { work?: TranscriptWorkSpan; cluster?: ContextCluster } = {}
  if (inputs.workIsContainer) {
    const span = inputs.workByMember.get(message)
    if (span !== undefined) ancestry.work = span
  }
  if (inputs.clusterIsContainer) {
    const cluster = inputs.clusterByMember.get(message)
    if (cluster !== undefined) ancestry.cluster = cluster
  }
  return ancestry
}

/**
 * The CURRENT openness of the resolved ancestors. Both predicates answer the
 * same question — "is this container open right now?" — for the caller's own
 * mutable state (manual disclosure sets, the regular bulk master, search
 * reveals the caller already granted).
 */
export interface TranscriptRevealOpenness {
  readonly workOpen: (span: TranscriptWorkSpan) => boolean
  readonly clusterOpen: (cluster: ContextCluster) => boolean
}

/**
 * Evaluate the CURRENT reveal path from stable ancestry: only ancestors that
 * actually hide the row right now become nodes, outer-to-inner (Work, then
 * cluster). An empty path means the row is not hidden by a disclosure
 * container — the caller must not promote or reveal anything.
 */
export function transcriptRevealPathFor(
  ancestry: TranscriptRevealAncestry,
  openness: TranscriptRevealOpenness,
): TranscriptContainerPath | undefined {
  const path: TranscriptContainerOwner[] = []
  if (ancestry.work !== undefined && !openness.workOpen(ancestry.work)) {
    path.push({ kind: 'work', owner: ancestry.work.owner })
  }
  if (ancestry.cluster !== undefined && !openness.clusterOpen(ancestry.cluster)) {
    path.push({ kind: 'context-cluster', owner: ancestry.cluster.owner })
  }
  return path.length === 0 ? undefined : path
}
