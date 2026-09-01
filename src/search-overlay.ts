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
 * @module @xmoon76/dsh-pi-tui/search-overlay
 */

import { TranscriptFolder, type TranscriptSearchMatch } from './transcript.ts'

/** The runner's search-overlay state (the input of
 * {@link refreshedSearchState} / {@link steppedSearchOverlayState}). */
export interface SearchOverlayState {
  readonly matches: readonly TranscriptSearchMatch[]
  readonly current: number
  readonly query: string
  readonly revision: number
  /** The folder the query ran on (identity guard: another folder's
   * revision must never be considered current). */
  readonly folder: TranscriptFolder | undefined
}

/** PR D1 P1: the search-overlay refresh policy. `changed: false` means the
 * stored state is still current; otherwise the SAME query is re-run as a
 * lightweight scan (never the previous candidates — a foreign folder or a
 * moved revision must not refine against them), the previously current
 * match is recovered by stable id when it still matches, and the current
 * index is clamped otherwise (an EMPTIED result set clamps to -1 — the
 * 0/0 counter, never 0). Returns the refreshed state the runner commits. */
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
  const previousId = state.current >= 0 ? state.matches[state.current]?.id : undefined
  const matches = activeFolder.search(state.query)
  const revision = activeFolder.searchRevision()
  let current: number
  if (matches.length === 0) {
    // An emptied result set clamps to -1 (the 0/0 counter), never 0.
    current = -1
  } else if (previousId !== undefined) {
    const found = matches.findIndex(match => match.id === previousId)
    current = found >= 0 ? found : Math.min(state.current, matches.length - 1)
  } else {
    current = 0
  }
  return { matches, current, revision, changed: true }
}

/** PR D1 P1: the Next/Prev stepping policy — the search overlay state MUST
 * be refreshed BEFORE stepping (an empty candidate list still refreshes,
 * so a match that arrived while the overlay stayed open is discoverable),
 * then steps by one. An EMPTY refreshed list steps to -1 (the 0/0
 * counter). The runner's onSearchNext/onSearchPrev handlers call exactly
 * this seam. */
export function steppedSearchOverlayState(
  state: SearchOverlayState,
  activeFolder: TranscriptFolder,
  direction: 1 | -1,
): { matches: TranscriptSearchMatch[]; current: number; revision: number; changed: boolean } {
  const refreshed = refreshedSearchState(state, activeFolder)
  if (refreshed.matches.length === 0) {
    return { matches: refreshed.matches, current: -1, revision: refreshed.revision, changed: refreshed.changed }
  }
  const count = refreshed.matches.length
  // A fresh list with no current item starts stepping from the first
  // match (Next) / last match (Prev), mirroring the query-flow semantics.
  const base = refreshed.current < 0 ? 0 : refreshed.current
  const current = (base + direction + count) % count
  return { matches: refreshed.matches, current, revision: refreshed.revision, changed: refreshed.changed }
}
