/**
 * Directory-only completion adapter for the Save Location prompt (Pre-Stage-D
 * export convergence): reuses the shared path engine — query resolution,
 * LocalFileSource discovery, bounded scans, ranking, `~`/`../`/Windows
 * dialect handling — and filters the candidate facts to directories. The
 * Save Location field is a path directly, not a slash-command token, so the
 * presented value is the raw path in the user's dialect with the trailing
 * separator (no `@` prefix, no command-token quoting); directories with
 * spaces are accepted verbatim.
 * @module @xmoon76/dsh-pi-tui/file-completion/directory-completion
 */

import { MAX_SUGGESTIONS, reattachDisplayBase } from './engine.ts'
import { discoverForQuery, type DiscoverySource } from './discovery.ts'
import { resolvePathQuery, separatorOfRaw } from './query.ts'
import { compareScoredPaths, scorePathCandidate } from './ranking.ts'
import type { PathCandidate } from './types.ts'

/** One directory suggestion: the accepted value (user dialect, trailing
 * separator) plus the display label. */
export interface DirectoryCompletionItem {
  /** The accepted directory path in the user's dialect, WITH the trailing
   * separator (`./foo/`, `~/Downloads/`, `../other/`). */
  readonly value: string
  /** The display label (directory marker). */
  readonly label: string
}

/**
 * Complete one raw directory field through the shared path pipeline and
 * filter the candidates to directories. Throws never — discovery failures
 * degrade to null.
 * @param raw - the raw directory field as typed.
 * @param cwd - the Client process cwd (relative forms resolve against it).
 * @param source - the discovery seam (the Client-local file source).
 * @param signal - the prompt's request abort.
 * @returns the ranked directory suggestions, or null when nothing matches.
 */
export async function completeDirectory(
  raw: string,
  cwd: string,
  source: DiscoverySource,
  signal: AbortSignal,
): Promise<DirectoryCompletionItem[] | null> {
  const query = resolvePathQuery(raw, cwd)
  let candidates: readonly PathCandidate[]
  try {
    candidates = await discoverForQuery(query, source, signal)
  } catch {
    return null
  }
  if (signal.aborted || candidates.length === 0) return null
  const sep = separatorOfRaw(raw, query.winAbsolute || raw.includes('\\'))
  const lowerQuery = query.searchTerm.toLowerCase()
  const items = candidates
    .filter(candidate => candidate.kind === 'directory')
    .map(candidate => reattachDisplayBase(candidate, query))
    .map(candidate => ({ candidate, score: scorePathCandidate(candidate, lowerQuery) }))
    .filter(entry => entry.score > 0)
    .sort(compareScoredPaths)
    .slice(0, MAX_SUGGESTIONS)
    .map(entry => ({
      value: `${entry.candidate.path}${sep}`,
      label: `${entry.candidate.path}/`,
    }))
  return items.length === 0 ? null : items
}
