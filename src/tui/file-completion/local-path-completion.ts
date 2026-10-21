/**
 * The local path completion pipeline (TS8-A, retiring the historical
 * `src/file-completion/engine.ts`): resolve the query → discover through the
 * caller's locality driver → reattach the display base → rank → slice →
 * present.
 *
 * It serves the COMMAND path arguments (`/attach`, `/image` — Client-local
 * discovery, Client cwd) and, through the Direct adapter, the sessionless
 * WORKSPACE compatibility scan. It is NOT the live Session `@` path: those
 * candidates come from the official Host `fileReferences` authority already
 * filtered, ranked and bounded, and are presented without a local ranking
 * pass.
 *
 * Throws never — discovery failures degrade to null.
 * @module @xmoon76/dsh-pi-tui/tui/file-completion/local-path-completion
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'
import { discoverForQuery, type LocalDiscoveryDriver } from '../../domain/file-completion/discovery-policy.ts'
import { reattachDisplayBase, resolvePathQuery, separatorOfRaw, type PathQueryEnvironment } from '../../domain/file-completion/query.ts'
import { rankPathCandidates } from '../../domain/file-completion/ranking.ts'
import type { PathCandidate } from '../../domain/file-completion/types.ts'
import { presentPathCandidate } from './presentation.ts'

/**
 * Complete one raw token through the local pipeline.
 * @param raw - the raw token (quotes stripped; leading separator whitespace
 *   stripped by the caller).
 * @param cwd - the completion base (the Client cwd for the Client-local
 *   command paths; the Direct workspace cwd for the compatibility scan).
 * @param driver - the locality's discovery boundary (the Client-local driver
 *   for `/attach` + `/image`; the Direct workspace driver is used by that
 *   adapter directly, never here).
 * @param environment - the locality owner's explicit path-query facts.
 * @param signal - the editor's request abort.
 * @param context - `{ at: false }` for a bare path argument; an `at: true`
 *   context delegates the value to the official mention grammar.
 * @returns the ranked+presented items, or null when nothing matches.
 */
export async function completePath(
  raw: string,
  cwd: string,
  driver: LocalDiscoveryDriver,
  environment: PathQueryEnvironment,
  signal: AbortSignal,
  context: { at: boolean; quoted: boolean },
): Promise<AutocompleteItem[] | null> {
  const query = resolvePathQuery(raw, cwd, environment)
  let candidates: readonly PathCandidate[]
  try {
    candidates = await discoverForQuery(query, driver, signal)
  } catch {
    return null
  }
  if (signal.aborted || candidates.length === 0) return null
  // The candidates ALREADY carry their final user-facing paths (the source
  // reattached the display base); this layer owns the local ranking, the
  // argument quoting, labels and directory continuation — an `at: true`
  // context delegates the value to the official `formatFileMention` (refused
  // paths are filtered, never coerced).
  const items = rankPathCandidates(
    candidates.map(candidate => reattachDisplayBase(candidate, query)),
    query.searchTerm,
  )
    .map(candidate => presentPathCandidate(candidate, {
      ...context,
      sep: separatorOfRaw(raw, query.winAbsolute || raw.includes('\\')),
    }))
    .filter((item): item is AutocompleteItem => item !== undefined)
  return items.length === 0 ? null : items
}
