/**
 * The file-completion engine (plan §5): the SHARED pipeline behind `@`
 * mentions and `/image` arguments. One call answers "what do I show for
 * this raw token?" — parse query → discover (through the injected source)
 * → rank → slice → present. The two contexts differ ONLY in their raw
 * input shape (an `@` prefix vs an argument) and their source (Host
 * filesystem vs Client-local) — the path math, ranking, quoting and
 * directory continuation are one implementation.
 *
 * The engine is pure policy: the discover step is injected (the Direct
 * Host adapter answers for the HOST fs; the local source for the Client
 * fs) and the presentation returns bare `AutocompleteItem`s (the client's
 * `MentionProvider` / `getArgumentCompletions` adapters own the fork's
 * value shapes).
 * @module @xmoon76/dsh-pi-tui/file-completion/engine
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'
import { compareScoredPaths, scorePathCandidate } from './ranking.ts'
import { resolvePathQuery, stripAtQuotes } from './query.ts'
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

/** Rank, slice and present one discovery set for one query. The
 * candidates ALREADY carry their final user-facing paths (the source
 * reattached the display base); this layer owns ranking, the `@`/quoting
 * shape, labels, descriptions and directory continuation. PURE. */
export function presentDiscovery(
  candidates: readonly PathCandidate[],
  term: string,
  context: { at: boolean; quoted: boolean },
): AutocompleteItem[] {
  const lowerQuery = term.toLowerCase()
  return candidates
    .map(candidate => ({ candidate, score: scorePathCandidate(candidate, lowerQuery) }))
    .filter(entry => entry.score > 0)
    .sort(compareScoredPaths)
    .slice(0, MAX_SUGGESTIONS)
    .map(entry => presentPathCandidate(entry.candidate, context))
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
 * Complete one raw token through the shared pipeline: resolve the query,
 * discover through the injected source, reattach the display base, rank,
 * slice and present. Throws never — discovery failures degrade to null.
 * @param raw - the raw token (quotes stripped; leading separator
 *   whitespace stripped by the caller).
 * @param cwd - the completion base (session workspace).
 * @param source - the discovery seam (Host fs for `@`, Client fs for
 *   `/image`).
 * @param signal - the editor's request abort.
 * @param context - `{ at: true }` for an `@` mention (the value carries
 *   the `@` + quoting), `{ at: false }` for a bare path argument.
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
    context,
  )
  return items.length === 0 ? null : items
}
