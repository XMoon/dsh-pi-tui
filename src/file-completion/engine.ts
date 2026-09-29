/**
 * The file-completion engine (plan §5): the pipeline behind `/attach` and
 * `/image` path arguments — parse query → discover (through the injected
 * Client-local source) → rank → slice → present. Since the M3-3A
 * realignment the SESSION `@` mention path no longer flows through this
 * engine: its discovery/ranking is the OFFICIAL Host authority's (the
 * candidates arrive already filtered, ranked and bounded via
 * `HostFilePort`), its mention VALUE is the official grammar's, and only
 * the Direct WORKSPACE compatibility path keeps a local scanner. This
 * engine remains the Client-fs completion path (no Host authority) and
 * the workspace adapter's ranking helper.
 * @module @xmoon76/dsh-pi-tui/file-completion/engine
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'
import { compareScoredPaths, scorePathCandidate } from './ranking.ts'
import { resolvePathQuery, separatorOfRaw, stripAtQuotes } from './query.ts'
import { discoverForQuery, type DiscoverySource } from './discovery.ts'
import { presentPathCandidate } from './presentation.ts'
import type { PathCandidate, PathCompletionQuery } from './types.ts'

/** The client-side suggestion cap (kimi MAX_FALLBACK_SUGGESTIONS): the
 * source returns the DISCOVERY set, the client ranks and slices it. */
export const MAX_SUGGESTIONS = 50

/**
 * Reattach the query's display base onto one discovered candidate path.
 * Discovery returns paths RELATIVE to the query's search base; the
 * candidate the user accepts must read in the USER'S dialect
 * (`../sibling-file.ts`, `~/pics/a.png`, `src/deep.ts`, `/tmp/x`). The
 * SOURCE calls this before its candidates cross the port contract (the
 * port's paths are user-facing). PURE.
 */
export function reattachDisplayBase(candidate: PathCandidate, query: PathCompletionQuery): PathCandidate {
  if (query.displayBase === '') return candidate
  return { ...candidate, path: `${query.displayBase}${candidate.path}` }
}

/** Rank, filter and bound one discovery set (the local scoring model,
 * the SOURCE's own order for its Client-fs/workspace-compat consumers —
 * NOT the SESSION `@` mention path, whose ranking is the official Host
 * authority's). PURE: path candidates in, ranked path candidates out —
 * no UI DTOs, so a semantic adapter can own its ranking end-to-end. */
export function rankDiscovery(
  candidates: readonly PathCandidate[],
  term: string,
): readonly PathCandidate[] {
  const lowerQuery = term.toLowerCase()
  return candidates
    .map(candidate => ({ candidate, score: scorePathCandidate(candidate, lowerQuery) }))
    .filter(entry => entry.score > 0)
    .sort(compareScoredPaths)
    .slice(0, MAX_SUGGESTIONS)
    .map(entry => entry.candidate)
}

/** Rank, slice and present one discovery set for one query (the
 * Client-fs command paths and the Direct WORKSPACE compatibility
 * scanner; the SESSION `@` mention does NOT flow through here — its
 * discovery/ranking is the official Host authority's and its value is
 * the official grammar's). The candidates ALREADY carry their final
 * user-facing paths (the source reattached the display base); this
 * layer owns the local ranking, the argument quoting, labels and
 * directory continuation — an `at: true` context delegates the value to
 * the official `formatFileMention` (refused paths are filtered, never
 * coerced). PURE. */
export function presentDiscovery(
  candidates: readonly PathCandidate[],
  term: string,
  context: { at: boolean; quoted: boolean; sep?: string },
): AutocompleteItem[] {
  return rankDiscovery(candidates, term)
    // The official mention grammar may refuse a path it cannot represent
    // safely (`undefined`); such a candidate is filtered, never coerced.
    .map(candidate => presentPathCandidate(candidate, context))
    .filter((item): item is AutocompleteItem => item !== undefined)
}

/** Resolve one raw token to the pure query (exported so tests pin the
 * resolver directly). */
export function resolveQuery(raw: string, cwd: string): PathCompletionQuery {
  return resolvePathQuery(raw, cwd)
}

/** The stripped raw token + quoted flag of one `@` prefix. */
export function tokenOfAtPrefix(atPrefix: string): { raw: string; quoted: boolean } {
  return stripAtQuotes(atPrefix)
}

/**
 * Complete one raw token through the local pipeline (the Client-fs
 * command paths — `/attach`, `/image` — and the Direct WORKSPACE
 * compatibility scanner; the SESSION `@` mention path does not call
 * this, it reads the official Host candidates through the Host-file
 * port): resolve the query, discover through the injected source,
 * reattach the display base, rank, slice and present. Throws never —
 * discovery failures degrade to null.
 * @param raw - the raw token (quotes stripped; leading separator
 *   whitespace stripped by the caller).
 * @param cwd - the completion base (session workspace).
 * @param source - the discovery seam (the Client-fs local source for
 *   the command paths; the legacy scanner for the workspace compat).
 * @param signal - the editor's request abort.
 * @param context - `{ at: false }` for a bare path argument (the only
 *   production shape today); an `at: true` context delegates the value
 *   to the official mention grammar.
 * @returns the ranked+presented items, or null when nothing matches.
 */
export async function completePath(
  raw: string,
  cwd: string,
  source: DiscoverySource,
  signal: AbortSignal,
  context: { at: boolean; quoted: boolean },
): Promise<AutocompleteItem[] | null> {
  const query = resolveQuery(raw, cwd)
  let candidates: readonly PathCandidate[]
  try {
    candidates = await discoverForQuery(query, source, signal)
  } catch {
    return null
  }
  if (signal.aborted || candidates.length === 0) return null
  const items = presentDiscovery(
    candidates.map(candidate => reattachDisplayBase(candidate, query)),
    query.searchTerm,
    { ...context, sep: separatorOfRaw(raw, query.winAbsolute || raw.includes('\\')) },
  )
  return items.length === 0 ? null : items
}
