/**
 * The Client-local DIRECTORY completion capability (TS8-A, split out of the
 * historical `src/file-completion/directory-completion.ts`): the Save Location
 * prompt's directory-only chooser. It reuses the neutral path query, discovery
 * policy and ranking over the CLIENT filesystem and filters the candidate facts
 * to directories.
 *
 * It returns a presentation-neutral DTO: `value` is the accepted path in the
 * user's own dialect WITH the trailing separator (so accept continues), and
 * `displayPath` is the bare path text. The TUI Save Location component owns the
 * directory marker/label it renders. No PiTui type crosses this module.
 * @module @xmoon76/dsh-pi-tui/client/file-completion/directory-completion
 */

import type { PathQueryEnvironment } from '../../domain/file-completion/query.ts'
import { reattachDisplayBase, resolvePathQuery, separatorOfRaw } from '../../domain/file-completion/query.ts'
import { discoverForQuery, type LocalDiscoveryDriver } from '../../domain/file-completion/discovery-policy.ts'
import { rankPathCandidates } from '../../domain/file-completion/ranking.ts'
import type { PathCandidate } from '../../domain/file-completion/types.ts'

/** One directory suggestion: the accepted value (user dialect, trailing
 * separator) plus the bare display path. */
export interface DirectoryCompletionCandidate {
  /** The accepted directory path in the user's dialect, WITH the trailing
   * separator (`./foo/`, `~/Downloads/`, `../other/`). */
  readonly value: string
  /** The path text to display, without a TUI-specific marker (`./foo`). */
  readonly displayPath: string
}

/**
 * Complete one raw directory field through the neutral path pipeline and
 * filter the candidates to directories. Throws never — discovery failures
 * degrade to null.
 * @param raw - the raw directory field as typed.
 * @param cwd - the Client process cwd (relative forms resolve against it).
 * @param driver - the Client-local discovery boundary.
 * @param environment - the Client process's explicit path-query facts.
 * @param signal - the prompt's request abort.
 * @returns the ranked directory suggestions, or null when nothing matches.
 */
export async function completeDirectory(
  raw: string,
  cwd: string,
  driver: LocalDiscoveryDriver,
  environment: PathQueryEnvironment,
  signal: AbortSignal,
): Promise<DirectoryCompletionCandidate[] | null> {
  const query = resolvePathQuery(raw, cwd, environment)
  let candidates: readonly PathCandidate[]
  try {
    candidates = await discoverForQuery(query, driver, signal)
  } catch {
    return null
  }
  if (signal.aborted || candidates.length === 0) return null
  const sep = separatorOfRaw(raw, query.winAbsolute || raw.includes('\\'))
  const ranked = rankPathCandidates(
    candidates
      .filter(candidate => candidate.kind === 'directory')
      .map(candidate => reattachDisplayBase(candidate, query)),
    query.searchTerm,
  )
  const items = ranked.map(candidate => ({
    value: `${candidate.path}${sep}`,
    displayPath: candidate.path,
  }))
  return items.length === 0 ? null : items
}
