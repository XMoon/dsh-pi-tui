/**
 * The neutral local path ranking (TS8-A, split out of the historical
 * `src/file-completion/ranking.ts` + `engine.ts`): the scoring model for the
 * Client-local completion paths (`/attach`, `/image`) and the Direct
 * WORKSPACE compatibility scanner — NOT the live Session `@` mention path,
 * whose ranking is the official Host authority's. Exact basename > basename
 * prefix > basename substring > full path substring, with a directory bonus;
 * empty queries order directories first and shallowness first. PURE — paths
 * in, numbers out: no IO, no presentation types.
 * @module @xmoon76/dsh-pi-tui/domain/file-completion/ranking
 */

import { basenameOfPath } from './query.ts'
import type { PathCandidate } from './types.ts'

/** The local suggestion cap (kimi's MAX_FALLBACK_SUGGESTIONS): the discovery
 * driver returns the DISCOVERY set, the neutral policy ranks and slices it.
 * Deliberately locality-neutral and named so it cannot be confused with an
 * unrelated per-surface cap. */
export const MAX_LOCAL_COMPLETION_SUGGESTIONS = 50

/** Score one candidate against the query term (lowercased). */
export function scorePathCandidate(
  candidate: PathCandidate,
  lowerQuery: string,
): number {
  if (lowerQuery === '') {
    // Empty query (a listing): directories lead, shallow paths lead.
    const depthPenalty = candidate.path.split(/[\\/]/).length - 1
    return (candidate.kind === 'directory' ? 120 : 100) - depthPenalty
  }
  const lowerPath = candidate.path.toLowerCase()
  const lowerBase = basenameOfPath(candidate.path).toLowerCase()
  let score = 0
  if (lowerBase === lowerQuery) score = 100
  else if (lowerBase.startsWith(lowerQuery)) score = 80
  else if (lowerBase.includes(lowerQuery)) score = 50
  else if (lowerPath.includes(lowerQuery)) score = 30
  if (candidate.kind === 'directory' && score > 0) score += 10
  return score
}

/** Deterministic order: score desc, directories (kind) first, path asc. */
export function compareScoredPaths(
  left: { candidate: PathCandidate; score: number },
  right: { candidate: PathCandidate; score: number },
): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.candidate.kind !== right.candidate.kind) {
    return left.candidate.kind === 'directory' ? -1 : 1
  }
  return left.candidate.path.localeCompare(right.candidate.path)
}

/**
 * Rank, filter and bound one discovery set (the local scoring model — the
 * SOURCE's own order for its Client-fs / Direct-workspace-compat consumers,
 * NOT the live Session `@` mention path, whose ranking is the official Host
 * authority's). PURE: path candidates in, ranked path candidates out — no UI
 * DTOs, so a semantic adapter can own its ranking end-to-end.
 */
export function rankPathCandidates(
  candidates: readonly PathCandidate[],
  term: string,
): readonly PathCandidate[] {
  const lowerQuery = term.toLowerCase()
  return candidates
    .map(candidate => ({ candidate, score: scorePathCandidate(candidate, lowerQuery) }))
    .filter(entry => entry.score > 0)
    .sort(compareScoredPaths)
    .slice(0, MAX_LOCAL_COMPLETION_SUGGESTIONS)
    .map(entry => entry.candidate)
}

/** The incremental, bounded competition of one finder's candidate stream. */
export interface BoundedFinderCandidateCollector {
  /** Offer one candidate as the finder emitted it. */
  offer(candidate: PathCandidate): void
  /**
   * The FINDER result set: the exact union of the two top-50 competitions
   * (at most 100 distinct paths). The consumer's own ranking still decides the
   * final presentation cap — this union is what keeps a directory-only
   * consumer (Save Location) from losing directories that an all-types top 50
   * filled with files.
   */
  finish(): readonly PathCandidate[]
}

/**
 * Collect a finder's candidates under a FIXED memory bound: two independent
 * sorted competitions run in parallel — `bestAll` (every file and directory)
 * and `bestDirectories` (directories only) — each capped at
 * {@link MAX_LOCAL_COMPLETION_SUGGESTIONS}. The scoring and tie-break are
 * exactly {@link scorePathCandidate} / {@link compareScoredPaths}; this
 * collector never models a second relevance order.
 *
 * A directory competes in BOTH sets independently: entering the all-types top
 * 50 must not decide whether it also belongs to the directory top 50 (the old
 * "rank everything, then filter directories" order is precisely what dropped
 * the late Save Location candidates). Candidates scoring 0 for this term are
 * discarded, and a path offered more than once keeps exactly one entry per
 * competition.
 */
export function createBoundedFinderCandidateCollector(term: string): BoundedFinderCandidateCollector {
  const lowerQuery = term.toLowerCase()
  const bestAll: { candidate: PathCandidate; score: number }[] = []
  const bestDirectories: { candidate: PathCandidate; score: number }[] = []
  const offerInto = (entries: { candidate: PathCandidate; score: number }[], candidate: PathCandidate, score: number): void => {
    const existing = entries.findIndex(entry => entry.candidate.path === candidate.path)
    if (existing !== -1) entries.splice(existing, 1)
    entries.push({ candidate, score })
    entries.sort(compareScoredPaths)
    if (entries.length > MAX_LOCAL_COMPLETION_SUGGESTIONS) entries.length = MAX_LOCAL_COMPLETION_SUGGESTIONS
  }
  return {
    offer(candidate) {
      const score = scorePathCandidate(candidate, lowerQuery)
      if (score <= 0) return
      offerInto(bestAll, candidate, score)
      if (candidate.kind === 'directory') offerInto(bestDirectories, candidate, score)
    },
    finish() {
      // The union's ORDER is not an external result (every consumer re-ranks);
      // keeping the union deterministic is what the tests observe.
      const merged = new Map<string, PathCandidate>()
      for (const entry of bestAll) merged.set(entry.candidate.path, entry.candidate)
      for (const entry of bestDirectories) {
        if (!merged.has(entry.candidate.path)) merged.set(entry.candidate.path, entry.candidate)
      }
      return [...merged.values()]
    },
  }
}
