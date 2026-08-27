/**
 * The shared file discovery: how a resolved path query is answered by the
 * local filesystem — fd/fdfind first (fast, respects ignore rules), the
 * bounded recursive scan as fallback, a direct listing for directory
 * scopes. Used by BOTH sources: the Direct Host-file adapter (`@`) and the
 * Client-local `/image` source. The discovery answers "which files exist"
 * as path-only facts (relative to the search base); ranking, quoting and
 * presentation are client policy in the engine.
 * @module @xmoon76/dsh-pi-tui/file-completion/discovery
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { PathCandidate, PathCompletionQuery } from './types.ts'

/** The recursive scan bound (kimi MAX_FALLBACK_SCAN): counts DESCENDED
 * (non-root) entries. The search root's DIRECT children are always
 * complete — a whole-tree fuzzy query like `@src` must find a root-level
 * `src/` even when the workspace holds >2000 deeper entries (plan §3.4:
 * the old global cap made scoped continuation randomly fail). */
export const MAX_FALLBACK_SCAN = 2000

/** fd's per-request result cap (the fork's own --max-results). */
const MAX_FD_RESULTS = 100

/** Locate an executable file-finder on PATH: `fd` preferred, `fdfind`
 * (Debian/Ubuntu's fd-find) second (plan §12 — kimi parity). Bare command
 * names resolve through PATH at spawn time; absolute/relative entries must
 * exist and be X_OK. POSIX PATH separators only (this deployment targets
 * POSIX hosts; a Windows Host would need a platform-aware probe, recorded
 * as a portability note, not a behavior change). */
export function resolveFdPath(): string | null {
  const pathEntries = process.env.PATH?.split(':').filter(entry => entry !== '') ?? []
  for (const name of ['fd', 'fdfind']) {
    for (const dir of pathEntries) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Not here; keep scanning.
      }
    }
  }
  return null
}

/** One raw discovery fact (path relative to the search base + fs facts). */
export interface RawDiscoveryEntry {
  readonly path: string
  readonly isDirectory: boolean
}

/** The discovery seam one source answers with: fdPath (null = no fd) and
 * the fs procedures the fallback uses. */
export interface DiscoverySource {
  /** The resolved fd/fdfind executable, or null (fallback scan only). */
  readonly fdPath: string | null
}

/** Whether one Dirent is a directory (symlinks followed; a broken link is
 * a file candidate — the fork's rule). */
function entryIsDirectory(
  baseDir: string,
  name: string,
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      return statSync(join(baseDir, name)).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

/** The DIRECT children of one directory (a scoped listing): paths are
 * bare entry names. A missing/unreadable directory yields [] (the caller
 * shows nothing — never a crash). */
export function listDirectChildren(baseDir: string): RawDiscoveryEntry[] {
  let entries
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: RawDiscoveryEntry[] = []
  for (const entry of entries) {
    out.push({ path: entry.name, isDirectory: entryIsDirectory(baseDir, entry.name, entry) })
  }
  return out
}

/** The bounded recursive scan of one directory's SUBTREE: the root's
 * direct children are always complete (a root-level `src/` must be found),
 * deeper entries are capped at MAX_FALLBACK_SCAN. Paths are relative to
 * baseDir (`sub/deep.ts`); `.git` is skipped (kimi parity); symlinked
 * directories are NOT descended (cycle safety). */
export function scanSubtree(baseDir: string, signal?: AbortSignal): RawDiscoveryEntry[] {
  const candidates: RawDiscoveryEntry[] = []
  let firstEntries
  try {
    firstEntries = readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return []
  }
  // Depth 0: complete, uncapped.
  const stack: string[] = []
  for (const entry of firstEntries) {
    if (entry.name === '.git') continue
    const path = entry.name
    candidates.push({ path, isDirectory: entryIsDirectory(baseDir, entry.name, entry) })
    if (entry.isDirectory()) stack.push(path)
  }
  // Deeper levels: bounded.
  let scanned = 0
  while (stack.length > 0 && scanned < MAX_FALLBACK_SCAN) {
    if (signal?.aborted === true) break
    const relativeDir = stack.pop() ?? ''
    let entries
    try {
      entries = readdirSync(join(baseDir, relativeDir), { withFileTypes: true })
    } catch {
      continue
    }
    // `signal` is possibly-undefined (the fallback scan accepts an optional
    // signal); `aborted` is `false | undefined` — the comparison to `true`
    // is the intent (a never-aborted scan runs to completion).
    for (const entry of entries) {
      if ((signal?.aborted ?? false) || scanned >= MAX_FALLBACK_SCAN) break
      if (entry.name === '.git') continue
      const path = `${relativeDir}/${entry.name}`
      scanned += 1
      candidates.push({ path, isDirectory: entryIsDirectory(join(baseDir, relativeDir), entry.name, entry) })
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path)
    }
  }
  return candidates
}

/** Run one fd whole-tree/scoped search. fd prints paths RELATIVE to
 * `--base-directory`; directories are classified against the fs (fd's
 * default print format does not guarantee a trailing `/` — the fork's
 * rule: statSync follows symlinks, so a symlink dir still completes with
 * `/`). A failed/aborted run yields [] (never a crash). */
export function discoverWithFd(
  fdPath: string,
  baseDir: string,
  term: string,
  signal: AbortSignal,
): Promise<RawDiscoveryEntry[]> {
  const args = [
    '--base-directory', baseDir,
    '--max-results', String(MAX_FD_RESULTS),
    '--type', 'f',
    '--type', 'd',
    '--follow',
    '--hidden',
    '--exclude', '.git',
    '--exclude', '.git/*',
    '--exclude', '.git/**',
  ]
  // fd matches the query against the basename by default (substring,
  // smart-case): for a basename term that is exactly the scoring model's
  // input. A scoped query runs inside its own baseDir, so the term never
  // contains a separator here — no --full-path needed.
  if (term !== '') args.push(term)
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve([])
      return
    }
    const child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let settled = false
    const settle = (results: RawDiscoveryEntry[]): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(results)
    }
    const onAbort = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => settle([]))
    child.on('close', (code) => {
      if (signal.aborted || code !== 0 || !stdout) {
        settle([])
        return
      }
      const lines = stdout.trim().split('\n').filter((line) => line !== '')
      const results: RawDiscoveryEntry[] = []
      for (const line of lines) {
        if (line === '.git' || line.startsWith('.git/') || line.includes('/.git/')) continue
        const normalized = line.endsWith('/') ? line.slice(0, -1) : line
        let isDirectory = line.endsWith('/')
        if (!isDirectory) {
          try {
            isDirectory = statSync(join(baseDir, normalized)).isDirectory()
          } catch {
            isDirectory = false
          }
        }
        results.push({ path: normalized, isDirectory })
      }
      settle(results)
    })
  })
}

/**
 * Answer one resolved query with discovery facts (plan §6): a scoped
 * LISTING (empty term) reads the target directory's direct children; a
 * scoped or whole-tree FUZZY query uses fd when available and the bounded
 * subtree scan otherwise. Paths are relative to the QUERY's search base.
 * @param query - the resolved path query (searchBase already absolute).
 * @param source - the discovery seam (fd detection per source).
 * @param signal - the editor's request abort.
 */
export async function discoverForQuery(
  query: PathCompletionQuery,
  source: DiscoverySource,
  signal: AbortSignal,
): Promise<readonly PathCandidate[]> {
  if (query.explicitScope && query.searchTerm === '') {
    // A scoped listing: the target directory's OWN content — always the
    // direct children (never a whole-tree scan filtered by string, plan
    // §6.1; and never fd's subtree listing — "show src children" semantics).
    return listDirectChildren(query.searchBase).map(toCandidate)
  }
  // Fuzzy (scoped or whole-tree): fd first, bounded scan fallback. A
  // Windows-dialect token stays on the scan path (fd's POSIX matcher does
  // not speak `\`).
  if (source.fdPath !== null && !query.winAbsolute) {
    const entries = await discoverWithFd(source.fdPath, query.searchBase, query.searchTerm, signal)
    if (signal.aborted) return []
    return entries.map(toCandidate)
  }
  const entries = scanSubtree(query.searchBase, signal)
  if (signal.aborted === true) return []
  return entries.map(toCandidate)
}

/** Map one raw discovery fact onto the detached candidate DTO. */
function toCandidate(entry: RawDiscoveryEntry): PathCandidate {
  return {
    path: entry.path,
    kind: entry.isDirectory ? 'directory' : 'file',
  }
}
