/**
 * The shared path ranking (plan §7): ONE scoring model behind `@` and
 * `/image`. Exact basename > basename prefix > basename substring > full
 * path substring, with a directory bonus; empty queries order directories
 * first and shallowness first. PURE — paths in, numbers out.
 * @module @xmoon76/dsh-pi-tui/file-completion/ranking
 */

import { basenameOfPath, type PathCandidate } from './types.ts'

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
