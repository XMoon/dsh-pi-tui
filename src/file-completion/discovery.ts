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
import { delimiter, join } from 'node:path'
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
 * exist and be X_OK. The platform PATH delimiter and PATHEXT suffixes keep
 * the same probe correct on Windows hosts too. */
export function resolveFdPath(): string | null {
  const pathEntries = process.env.PATH?.split(delimiter) ?? []
  const pathExt = process.env.PATHEXT || (process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : '')
  const suffixes = pathExt
    .split(';')
    .map(suffix => suffix.trim())
    .filter(suffix => suffix !== '')
    .flatMap(suffix => suffix.toLowerCase() === suffix ? [suffix] : [suffix, suffix.toLowerCase()])
  for (const name of ['fd', 'fdfind']) {
    for (const entry of pathEntries) {
      // An empty POSIX PATH component means the current directory. Keep it
      // rather than silently changing the shell's lookup semantics.
      const dir = entry === '' ? '.' : entry
      for (const suffix of ['', ...suffixes]) {
        const candidate = join(dir, `${name}${suffix}`)
        try {
          // X_OK alone also succeeds for a directory on POSIX. Only return a
          // regular file that is executable; a directory named `fd` must not
          // poison discovery before the fallback gets a chance to run.
          if (statSync(candidate).isFile() && accessSync(candidate, fsConstants.X_OK) === undefined) {
            return candidate
          }
        } catch {
          // Not here; keep scanning.
        }
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
 * bare entry names. `.git` is skipped (consistent with fd and the
 * recursive scan — a `@` or `/image` listing never presents VCS
 * internals). A missing/unreadable directory yields [] (never a crash). */
export function listDirectChildren(baseDir: string, signal?: AbortSignal): RawDiscoveryEntry[] {
  if (signal?.aborted ?? false) return []
  let entries
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: RawDiscoveryEntry[] = []
  for (const entry of entries) {
    if (signal?.aborted ?? false) return []
    if (entry.name === '.git') continue
    out.push({ path: entry.name, isDirectory: entryIsDirectory(baseDir, entry.name, entry) })
  }
  return (signal?.aborted ?? false) ? [] : out
}

/** The bounded recursive scan of one directory's SUBTREE: the root's
 * direct children are always complete (a root-level `src/` must be found),
 * deeper entries are capped at MAX_FALLBACK_SCAN. Paths are relative to
 * baseDir (`sub/deep.ts`); `.git` is skipped (kimi parity); symlinked
 * directories are NOT descended (cycle safety).
 *
 * ASYNC (plan §25): the `/image` fuzzy fallback runs on the EDITOR path,
 * so a synchronous whole-tree traversal would block the editor's event
 * loop per keystroke. The scan yields to the event loop between directory
 * levels and checks the AbortSignal inside the loop — the editor stays
 * responsive and a cancelled request stops the traversal promptly. */
export async function scanSubtree(baseDir: string, signal?: AbortSignal): Promise<RawDiscoveryEntry[]> {
  const candidates: RawDiscoveryEntry[] = []
  let firstEntries
  try {
    firstEntries = readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return []
  }
  if (signal?.aborted ?? false) return []
  // Depth 0: complete, uncapped.
  const stack: string[] = []
  for (const entry of firstEntries) {
    if (entry.name === '.git') continue
    const path = entry.name
    candidates.push({ path, isDirectory: entryIsDirectory(baseDir, entry.name, entry) })
    if (entry.isDirectory()) stack.push(path)
  }
  // Deeper levels: bounded, async, abort-aware.
  let scanned = 0
  while (stack.length > 0 && scanned < MAX_FALLBACK_SCAN) {
    if ((signal?.aborted ?? false)) break
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
    // Yield to the event loop between directory levels: the editor stays
    // responsive during a large-tree fallback (plan §25 — never a
    // synchronous full-tree traversal on the editor path).
    if (stack.length > 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return candidates
}

/** Run one fd whole-tree/scoped search. fd prints paths RELATIVE to
 * `--base-directory`; directories are classified against the fs (fd's
 * default print format does not guarantee a trailing `/` — the fork's
 * rule: statSync follows symlinks, so a symlink dir still completes with
 * `/`). Returns NULL on fd FAILURE (non-zero exit, spawn error — NOT a
 * valid empty result: the caller falls back to the bounded scan), `[]` on
 * a genuine no-match or an abort. */
export function discoverWithFd(
  fdPath: string,
  baseDir: string,
  term: string,
  signal: AbortSignal,
): Promise<RawDiscoveryEntry[] | null> {
  const args = [
    '--base-directory', baseDir,
    '--max-results', String(MAX_FD_RESULTS),
    // fd's DEFAULT is smart-case (case-insensitive for a lowercase query,
    // case-SENSITIVE when the query contains uppercase) — but the shared
    // ranking contract is case-INSENSITIVE (scorePathCandidate lowercases
    // both sides). Forced --ignore-case keeps the fd discovery semantics
    // aligned with the ranking model: @FOO finds foo.txt, exactly like the
    // bounded-scan fallback path.
    '-i',
    '--full-path',
    '--print0',
    '--type', 'f',
    '--type', 'd',
    // Include symlinks as candidates but do not follow them during descent;
    // the bounded fallback exposes symlink entries and classifies a symlink
    // to a directory as a directory without traversing it.
    '--type', 'l',
    '--hidden',
    '--exclude', '.git',
    '--exclude', '.git/*',
    '--exclude', '.git/**',
  ]
  // fd matches the query against the FULL relative path. This is important
  // for parity with the fallback scorer: an unscoped `@src` must also see a
  // candidate such as `src/readme`, not only an entry whose basename is
  // `src`. A scoped query still runs inside its own baseDir, so the term is
  // normally a basename substring. fd's pattern is a REGEX — a user's literal
  // term containing regex
  // metacharacters (`foo[1].ts`, `a+b.ts`) would silently match nothing,
  // so the term is escaped to its literal form (the completion contract
  // is substring matching of the literal text, not regex). The filenames
  // themselves (candidate paths fd prints) are taken VERBATIM.
  if (term !== '') args.push(escapeFdRegex(term))
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve([])
      return
    }
    let child
    try {
      // stderr is intentionally ignored: discovery treats every non-zero exit
      // as a fallback signal, and a pipe that is never drained can deadlock a
      // noisy finder before it reaches its close event.
      child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    let settled = false
    const settle = (results: RawDiscoveryEntry[] | null): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(results)
    }
    const onAbort = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL')
      // Do not wait for a misbehaving child to acknowledge SIGKILL before the
      // editor request settles. The close handler is idempotent and will only
      // discard the eventual process event.
      settle([])
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => settle(null))
    child.on('close', (code) => {
      if (signal.aborted) {
        settle([])
        return
      }
      if (code !== 0) {
        // fd FAILED (missing binary race, malformed invocation, cwd
        // permission): NOT a valid empty result — the bounded scan
        // fallback must answer (plan §6.2 fd-first-fallback).
        settle(null)
        return
      }
      // Prefer NUL records (the real fd invocation uses --print0) so legal
      // filenames containing newlines survive. Fake/older finders that ignore
      // --print0 are accepted through the newline fallback; unlike trim(), it
      // preserves meaningful leading/trailing spaces in a filename.
      const records = stdout.includes('\0')
        ? stdout.split('\0').filter((record) => record !== '')
        : (() => {
            const lines = stdout.split(/\r?\n/)
            if (lines.at(-1) === '') lines.pop()
            return lines.filter((line) => line !== '')
          })()
      const results: RawDiscoveryEntry[] = []
      for (const line of records) {
        // fd/fdfind commonly prefixes paths emitted with --base-directory by
        // `./`; the discovery contract is relative paths without a leading
        // current-directory component (the fallback has the same shape).
        const relative = line.startsWith('./') ? line.slice(2) : line
        if (relative === '.git' || relative.startsWith('.git/') || relative.includes('/.git/')) continue
        const normalized = relative.endsWith('/') ? relative.slice(0, -1) : relative
        let isDirectory = relative.endsWith('/')
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
    if (signal.aborted) return []
    const direct = listDirectChildren(query.searchBase, signal)
    return signal.aborted ? [] : direct.map(toCandidate)
  }
  // Fuzzy (scoped or whole-tree): fd first, bounded scan fallback. A
  // Windows-dialect token stays on the scan path (fd's POSIX matcher does
  // not speak `\`).
  if (source.fdPath !== null && !query.winAbsolute && !query.raw.includes('\\')) {
    const entries = await discoverWithFd(source.fdPath, query.searchBase, query.searchTerm, signal)
    if (signal.aborted) return []
    // fd can omit a filesystem mount-point entry even when it is a direct
    // child of the search root (for example `/tmp` in containerized Linux).
    // Merge matching direct children back in so fd and the fallback expose the
    // same root-level candidates; de-duplicate by the relative path.
    if (entries !== null) {
      const seen = new Set(entries.map(entry => entry.path))
      const lowerTerm = query.searchTerm.toLowerCase()
      const direct = listDirectChildren(query.searchBase, signal)
        .filter(entry => lowerTerm === '' || entry.path.toLowerCase().includes(lowerTerm))
        .filter(entry => !seen.has(entry.path))
      if (signal.aborted) return []
      return [...entries, ...direct].map(toCandidate)
    }
  }
  // The bounded fallback is ASYNC + abort-aware (plan §25): the scan
  // yields between directory levels and stops on abort, so a large-tree
  // `/image` fuzzy query never blocks the editor event loop.
  const entries = await scanSubtree(query.searchBase, signal)
  if (signal.aborted === true) return []
  return entries.map(toCandidate)
}

/** Escape regex metacharacters for fd's default regex pattern: the
 * completion term is a LITERAL substring (the scoring model's input), so
 * a filename containing `[`, `+`, `.` etc. must match as literal text. */
function escapeFdRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Map one raw discovery fact onto the detached candidate DTO. */
function toCandidate(entry: RawDiscoveryEntry): PathCandidate {
  return {
    path: entry.path,
    kind: entry.isDirectory ? 'directory' : 'file',
  }
}
