/**
 * The search-overlay refresh/stepping policy (PR D1 P1): while the overlay
 * is open the transcript keeps changing under it (settlements, read-group
 * reflow, new messages), so Next/Prev must never jump with a stale
 * candidate list or a stale turn.
 *
 * This is an INTERNAL module on purpose: the runner and the headless tests
 * are its only consumers, and its signatures reference `TranscriptFolder`
 * — exporting it from the runner's public entry (src/index.ts) would drag
 * the private transcript declaration into the published `.d.mts` and fail
 * the tarball-smoke "no private pi-tui / internal path leaks" gate.
 * @module @xmoon76/dsh-pi-tui/app/surface/search-overlay
 */

import {
  TranscriptFolder,
  transcriptSearchMatchKey,
  transcriptSearchSourceKey,
  type TranscriptSearchMatch,
} from '../../transcript.ts'

/** The runner's authoritative raw search state (the input of
 * {@link refreshedSearchState}). */
export interface SearchOverlayState {
  readonly matches: readonly TranscriptSearchMatch[]
  readonly current: number
  readonly query: string
  readonly revision: number
  /** The folder the query ran on (identity guard: another folder's
   * revision must never be considered current). */
  readonly folder: TranscriptFolder | undefined
}

/** Temporary Full Find navigation unit. Raw semantic occurrences remain owned
 * by TranscriptFolder; these targets only project what Next/Prev can currently
 * address in the mounted Search overlay. */
export type FullFindNavigationTarget =
  | {
      readonly kind: 'occurrence'
      readonly representativeId: number
      /** Raw semantic index of `match` (the Folder search result position). */
      readonly matchIndex: number
      readonly match: TranscriptSearchMatch
      readonly matchKey: string
    }
  | {
      readonly kind: 'card'
      readonly representativeId: number
      /** Raw semantic index of the card's first grouped occurrence. */
      readonly matchIndex: number
      readonly match: TranscriptSearchMatch
      readonly groupedMatchKeys: readonly string[]
    }

/** Current-frame-only TuiApp qualification. It is keyed by the stable semantic
 * match identity and expires with query/folder/render identity. */
export interface FullFindNavigationQualification {
  readonly semanticMatchKey: string
  readonly representativeId: number
  readonly currentnessEpoch: number
  readonly verdict: 'exact' | 'auxiliary' | 'card'
  readonly groupScope: 'occurrence' | 'source-run' | 'whole-card'
}

/** Build one light O(matches) projection without rendering or proving any
 * off-window card. Read-group membership comes from the live Folder authority;
 * unvisited ordinary messages remain occurrence candidates until their first
 * current-frame qualification is committed. */
export function projectFullFindNavigationTargets(
  matches: readonly TranscriptSearchMatch[],
  representativeMemberCount: (id: number) => number,
  qualifications: ReadonlyMap<string, FullFindNavigationQualification> = new Map(),
): FullFindNavigationTarget[] {
  const targets: FullFindNavigationTarget[] = []
  for (let index = 0; index < matches.length;) {
    const match = matches[index]!
    const key = transcriptSearchMatchKey(match)
    const qualification = qualifications.get(key)
    if (qualification?.verdict === 'exact' || qualification?.groupScope === 'occurrence') {
      targets.push({ kind: 'occurrence', representativeId: match.id, matchIndex: index, match, matchKey: key })
      index += 1
      continue
    }

    const groupedRead = representativeMemberCount(match.id) > 1
    const scope = qualification?.groupScope
    if (!groupedRead && scope === undefined) {
      targets.push({ kind: 'occurrence', representativeId: match.id, matchIndex: index, match, matchKey: key })
      index += 1
      continue
    }

    const sourceKey = transcriptSearchSourceKey(match.source)
    const grouped: TranscriptSearchMatch[] = [match]
    let next = index + 1
    while (next < matches.length) {
      const candidate = matches[next]!
      if (candidate.id !== match.id) break
      const candidateKey = transcriptSearchMatchKey(candidate)
      const candidateQualification = qualifications.get(candidateKey)
      if (candidateQualification?.verdict === 'exact' || candidateQualification?.groupScope === 'occurrence') break
      if (!groupedRead && scope === 'source-run') {
        // A source-local unresolved run may only absorb occurrences this frame
        // already proved equally unlocatable. An UNVISITED occurrence can still
        // turn out exact; swallowing it would hide a real target.
        if (candidateQualification?.groupScope !== 'source-run') break
        if (candidateQualification.verdict !== 'card' && candidateQualification.verdict !== 'auxiliary') break
        if (transcriptSearchSourceKey(candidate.source) !== sourceKey) break
      }
      grouped.push(candidate)
      next += 1
    }
    if (grouped.length === 1 && !groupedRead && scope === undefined) {
      targets.push({ kind: 'occurrence', representativeId: match.id, matchIndex: index, match, matchKey: key })
    } else {
      targets.push({
        kind: 'card',
        representativeId: match.id,
        matchIndex: index,
        match,
        groupedMatchKeys: grouped.map(transcriptSearchMatchKey),
      })
    }
    index = next
  }
  return targets
}

/** The one symmetric Next/Prev step policy for the current target projection. */
export function stepFullNavigationTarget(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

/** The one symmetric Next/Prev step AFTER a stale refresh. `previousCurrent`
 * is the index BEFORE the refresh; it is the entry sentinel when the overlay
 * had no target (`< 0`). Passing the post-refresh index here would skip the
 * first newly discovered target, so the signature keeps both values explicit. */
export function steppedFullNavigationTarget(
  previousCurrent: number,
  refreshedCurrent: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count === 0) return -1
  return stepFullNavigationTarget(previousCurrent < 0 ? -1 : refreshedCurrent, count, direction)
}

/** Recover the current navigation unit after a target projection changes. A
 * stable raw match key wins, then an overlapping card group, then a same-card
 * target, finally the clamped old index. */
export function recoverFullNavigationTargetIndex(
  previous: FullFindNavigationTarget | undefined,
  next: readonly FullFindNavigationTarget[],
  previousIndex: number,
): number {
  if (next.length === 0) return -1
  if (previous !== undefined) {
    const keys = previous.kind === 'occurrence' ? [previous.matchKey] : previous.groupedMatchKeys
    const exact = next.findIndex(target => target.kind === 'occurrence'
      ? keys.includes(target.matchKey)
      : keys.some(key => target.groupedMatchKeys.includes(key)))
    if (exact >= 0) return exact
    const sameRepresentative = next.findIndex(target => target.representativeId === previous.representativeId)
    if (sameRepresentative >= 0) return sameRepresentative
  }
  return Math.min(Math.max(previousIndex, 0), next.length - 1)
}

/** PR D1 P1: the search-overlay refresh policy. `changed: false` means the
 * stored state is still current; otherwise the SAME query is re-run as a
 * lightweight scan (never the previous candidates — a foreign folder or a
 * moved revision must not refine against them), the previously current
 * OCCURRENCE is recovered by its match key (then the nearest same-source
 * occurrence in the same card) when it still matches, and the current index
 * is clamped otherwise (an EMPTIED result set clamps to -1 — the 0/0
 * counter, never 0). Returns the refreshed state the runner commits. */
export function refreshedSearchState(
  state: SearchOverlayState,
  activeFolder: TranscriptFolder,
): { matches: TranscriptSearchMatch[]; current: number; revision: number; changed: boolean } {
  if (state.folder === activeFolder && activeFolder.searchRevision() === state.revision) {
    return { matches: state.matches as TranscriptSearchMatch[], current: state.current, revision: state.revision, changed: false }
  }
  if (state.query === '') {
    return { matches: [], current: -1, revision: activeFolder.searchRevision(), changed: true }
  }
  const previous = state.current >= 0 ? state.matches[state.current] : undefined
  const matches = activeFolder.search(state.query)
  const revision = activeFolder.searchRevision()
  let current: number
  if (matches.length === 0) {
    // An emptied result set clamps to -1 (the 0/0 counter), never 0.
    current = -1
  } else if (previous !== undefined) {
    // Occurrence-aware recovery (plan §5): an exact occurrence key wins,
    // then the nearest occurrence of the same semantic source in the same
    // card, then any occurrence in the same card, then the old numeric
    // position clamped into the refreshed list.
    const previousKey = transcriptSearchMatchKey(previous)
    const previousSourceKey = transcriptSearchSourceKey(previous.source)
    let found = matches.findIndex(match => transcriptSearchMatchKey(match) === previousKey)
    if (found < 0) {
      let nearest = -1
      let nearestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index]!
        if (match.id !== previous.id) continue
        if (transcriptSearchSourceKey(match.source) !== previousSourceKey) continue
        const distance = Math.abs(match.sourceOccurrence - previous.sourceOccurrence)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = index
        }
      }
      found = nearest
    }
    if (found < 0) found = matches.findIndex(match => match.id === previous.id)
    current = found >= 0 ? found : Math.min(state.current, matches.length - 1)
  } else {
    current = 0
  }
  return { matches, current, revision, changed: true }
}
