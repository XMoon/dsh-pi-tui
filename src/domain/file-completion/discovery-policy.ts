/**
 * The neutral local discovery policy (TS8-A, split out of the historical
 * `src/file-completion/discovery.ts`): how a resolved path query is answered
 * by a LOCAL filesystem — a scoped listing, a finder-first fuzzy search with
 * a bounded recursive fallback, the root direct-child completeness rule, the
 * `.git` exclusion, abort-awareness and the mapping into detached
 * {@link PathCandidate} facts.
 *
 * It is transport/UI/platform neutral: it NEVER imports `node:fs`,
 * `node:child_process`, `process.env` or `process.platform`. Every filesystem
 * fact arrives through the narrow, locality-specific {@link LocalDiscoveryDriver}
 * the Client (`client/file-completion/local-discovery.ts`) and the Direct Host
 * (`runtime/direct/file-completion/host-discovery.ts`) each own.
 * @module @xmoon76/dsh-pi-tui/domain/file-completion/discovery-policy
 */

import { scorePathCandidate } from './ranking.ts'
import type { PathCandidate, PathCompletionQuery } from './types.ts'

/** The recursive scan bound (kimi's MAX_FALLBACK_SCAN): counts DESCENDED
 * (non-root) entries. The search root's DIRECT children are always complete —
 * a whole-tree fuzzy query like `@src` must find a root-level `src/` even when
 * the workspace holds >2000 deeper entries. */
export const MAX_FALLBACK_SCAN = 2000

/**
 * The Finder wall-clock budget (Owner amendment D4, 2026-11-18): ONE spawn's
 * whole work — from spawn to the last record processed and the normal close —
 * must finish within this budget. An over-budget run is killed, settles as a
 * FINDER FAILURE (`null`) and the neutral policy answers through the existing
 * bounded fallback; a partial result is never presented as success. Both
 * locality adapters share this neutral constant, and no user configuration
 * exists for it. This is an initial product budget decision, not a measured
 * universal fact: the adapters also check the deadline between record batches
 * (a synchronous `statSync` burst cannot fire a timer), so an in-progress
 * syscall on a network mount can still exceed the wall clock end to end.
 */
export const MAX_FINDER_WALL_MS = 500

/** The bound on ONE not-yet-terminated finder record (or, for a finder that
 * ignored `--print0` and emitted only newline text, on its whole output while
 * the NUL dialect is still unknown). An external process must not be able to
 * make completion accumulate arbitrary memory before its output is classified;
 * exceeding the bound fails the finder (`null`) so the neutral policy runs the
 * bounded fallback scan. */
export const MAX_UNTERMINATED_FINDER_CODE_UNITS = 65_536

/** One raw direct-child fact of one directory, as the locality adapter
 * observed it on ITS filesystem. */
export interface LocalDirectoryEntry {
  readonly name: string
  /** Whether the adapter reports the FACT that the entry is a directory by
   * following a symlink (the fork's rule). A symlinked directory is exposed as
   * a DIRECTORY candidate. */
  readonly kind: 'file' | 'directory'
  /** Whether the neutral policy may DESCEND into this entry during a bounded
   * subtree scan. A symlinked directory is exposed as a candidate but never
   * traversed — at the search root and below it alike — so a link to a parent
   * directory, to the workspace's outside, or a cycle can neither widen the
   * scan nor consume the traversal budget. */
  readonly descendable: boolean
}

/**
 * The locality boundary one filesystem answers with. It is NOT a semantic
 * authority: it returns detached facts only (never a `Dirent`, `Stats`,
 * `ChildProcess`, fs handle, Agent, Context or TuiApp), and never receives
 * `fs`, `spawn`, `process` or arbitrary services back.
 */
export interface LocalDiscoveryDriver {
  /**
   * The DIRECT children of `baseDir`/`relativeDir` (a scoped listing).
   * `relativeDir` is '' for the base itself, so the domain layer never builds
   * a host-native absolute child path.
   * @returns `null` when the directory is unreadable/unavailable for this
   *   operation (never a throw).
   */
  listDirectory(
    baseDir: string,
    relativeDir: string,
    signal: AbortSignal,
  ): Promise<readonly LocalDirectoryEntry[] | null>

  /**
   * An optional fd/fdfind-equivalent fast path over `baseDir`.
   * @returns `null` when the finder is unavailable or failed (the neutral
   *   policy then runs the bounded fallback scan), `[]` for a valid no-match.
   */
  find(
    baseDir: string,
    term: string,
    signal: AbortSignal,
  ): Promise<readonly PathCandidate[] | null>
}

/** One raw finder record, normalized to a detached fact: a relative path
 * (no leading `./`, no trailing separator) plus whether the finder marked it
 * as a directory. */
export interface FinderRecord {
  readonly path: string
  readonly directoryHint: boolean
}

/** Escape regex metacharacters for a finder's regex pattern: the completion
 * term is a LITERAL substring (the scoring model's input), so a filename
 * containing `[`, `+`, `.` etc. must match as literal text, never as a regex.
 * Both locality adapters pass the escaped term. */
export function escapeFinderRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalize ONE finder record (one `--print0` field, or one newline-dialect
 * line) into a detached fact: the `./` prefix strip, the `.git` exclusion and
 * the directory hint (a trailing `/`). PURE — the record stays a detached
 * string. Returns `undefined` for an empty or excluded record.
 */
export function normalizeFinderRecord(raw: string): FinderRecord | undefined {
  if (raw === '') return undefined
  // fd/fdfind commonly prefixes paths emitted with --base-directory by
  // `./`; the discovery contract is relative paths without a leading
  // current-directory component (the fallback has the same shape).
  const relative = raw.startsWith('./') ? raw.slice(2) : raw
  if (relative === '.git' || relative.startsWith('.git/') || relative.includes('/.git/')) return undefined
  return {
    path: relative.endsWith('/') ? relative.slice(0, -1) : relative,
    directoryHint: relative.endsWith('/'),
  }
}

/**
 * Normalize a finder's COMPLETE stdout into detached records: NUL records when
 * the finder honoured `--print0` (so legal filenames containing newlines
 * survive), the newline fallback for a fake/older finder (preserving
 * meaningful leading and trailing spaces in a filename). PURE — operates
 * solely on detached strings. The streaming adapter path parses incrementally
 * through {@link createFinderRecordStream} and only uses this whole-buffer
 * form for the NUL-free dialect at process close.
 */
export function normalizeFinderRecords(stdout: string): readonly FinderRecord[] {
  const records = stdout.includes('\0')
    ? stdout.split('\0')
    : (() => {
        const lines = stdout.split(/\r?\n/)
        if (lines.at(-1) === '') lines.pop()
        return lines
      })()
  const out: FinderRecord[] = []
  for (const record of records) {
    const normalized = normalizeFinderRecord(record)
    if (normalized !== undefined) out.push(normalized)
  }
  return out
}

/** The incremental record boundary of one finder stdout stream. */
export interface FinderRecordStream {
  /** Feed one decoded stdout chunk. Returns `false` when an unterminated
   * record exceeded {@link MAX_UNTERMINATED_FINDER_CODE_UNITS}: the caller must
   * stop consuming the process and treat this run as a finder failure. */
  push(chunk: string): boolean
  /**
   * Complete the stream when the process closes. Emits the buffered records of
   * a finder that ignored `--print0` (the whole output stayed NUL-free) and
   * returns `false` when a `--print0` run ended with an unterminated record —
   * truncated output is a finder FAILURE, never a partial success.
   */
  finish(): boolean
}

/**
 * Parse a finder's stdout INCREMENTALLY: each NUL-terminated record is
 * normalized and handed to `emit` as soon as it is complete, so neither the
 * complete stdout nor the complete record list is ever retained. The finder's
 * own record grammar is the one {@link normalizeFinderRecord} implements.
 *
 * A fake/older finder that ignored `--print0` is accepted through the newline
 * fallback ONLY when its complete output contains no NUL: while the dialect is
 * still unknown the bytes accumulate as one not-yet-terminated fragment (bounded
 * by {@link MAX_UNTERMINATED_FINDER_CODE_UNITS}), and the first NUL proves the
 * NUL dialect and commits that fragment as its first record.
 *
 * `shouldStop` is consulted before every record: when the consumer has
 * abandoned this run (a deadline, an abort or a failure settled first), the
 * stream stops consuming and reports `false` instead of continuing to feed a
 * discarded collector.
 */
export function createFinderRecordStream(
  emit: (record: FinderRecord) => void,
  options: { readonly shouldStop?: () => boolean } = {},
): FinderRecordStream {
  let pending = ''
  let nulDialect = false
  let overflowed = false
  const emitRecord = (raw: string): void => {
    const record = normalizeFinderRecord(raw)
    if (record !== undefined) emit(record)
  }
  return {
    push(chunk) {
      if (overflowed) return false
      pending += chunk
      let boundary = pending.indexOf('\0')
      while (boundary !== -1) {
        if (options.shouldStop?.() === true) return false
        nulDialect = true
        // The bound protects against ONE pathological record, however it
        // arrives: a record completing in this chunk is over the bound when
        // its length is, exactly like an unterminated fragment.
        if (boundary > MAX_UNTERMINATED_FINDER_CODE_UNITS) {
          overflowed = true
          return false
        }
        emitRecord(pending.slice(0, boundary))
        pending = pending.slice(boundary + 1)
        boundary = pending.indexOf('\0')
      }
      if (pending.length > MAX_UNTERMINATED_FINDER_CODE_UNITS) {
        overflowed = true
        return false
      }
      return true
    },
    finish() {
      if (overflowed) return false
      if (nulDialect) {
        // `--print0` terminates EVERY record; leftover bytes mean the output was
        // cut off mid-record, so this run produced no complete-result authority.
        return pending === ''
      }
      for (const record of normalizeFinderRecords(pending)) emit(record)
      pending = ''
      return true
    },
  }
}

/**
 * The bounded recursive scan of one directory's SUBTREE: the root's direct
 * children are always complete (a root-level `src/` must be found), deeper
 * entries are capped at {@link MAX_FALLBACK_SCAN}. Paths are relative to
 * `baseDir` (`sub/deep.ts`); `.git` is skipped (kimi parity); a symlinked
 * directory is NEVER descended — at the search root and below it alike
 * (cycle safety), so a link to a parent directory or to the workspace's
 * outside cannot widen the scan or consume the traversal budget.
 *
 * ASYNC: the fuzzy fallback runs on the EDITOR path, so a synchronous
 * whole-tree traversal would block the editor's event loop per keystroke. The
 * scan yields to the event loop between directory levels and checks the
 * AbortSignal inside the loop — the editor stays responsive and a cancelled
 * request stops the traversal promptly.
 */
export async function scanSubtree(
  baseDir: string,
  driver: LocalDiscoveryDriver,
  signal: AbortSignal,
): Promise<readonly PathCandidate[]> {
  const candidates: PathCandidate[] = []
  const firstEntries = await driver.listDirectory(baseDir, '', signal)
  if (signal.aborted || firstEntries === null) return []
  // Depth 0: complete, uncapped.
  const stack: string[] = []
  for (const entry of firstEntries) {
    if (entry.name === '.git') continue
    candidates.push({ path: entry.name, kind: entry.kind })
    if (entry.descendable) stack.push(entry.name)
  }
  // Deeper levels: bounded, async, abort-aware.
  let scanned = 0
  while (stack.length > 0 && scanned < MAX_FALLBACK_SCAN) {
    if (signal.aborted) break
    const relativeDir = stack.pop() ?? ''
    const entries = await driver.listDirectory(baseDir, relativeDir, signal)
    if (entries === null) continue
    for (const entry of entries) {
      if (signal.aborted || scanned >= MAX_FALLBACK_SCAN) break
      if (entry.name === '.git') continue
      const path = `${relativeDir}/${entry.name}`
      scanned += 1
      candidates.push({ path, kind: entry.kind })
      if (entry.kind === 'directory' && entry.descendable) stack.push(path)
    }
    // Yield to the event loop between directory levels: the editor stays
    // responsive during a large-tree fallback (never a synchronous
    // full-tree traversal on the editor path).
    if (stack.length > 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return signal.aborted ? [] : candidates
}

/** Map one driver listing into path candidates, dropping `.git` (a `@` or
 * `/image` listing never presents VCS internals). PURE. */
function listingCandidates(entries: readonly LocalDirectoryEntry[]): readonly PathCandidate[] {
  return entries
    .filter(entry => entry.name !== '.git')
    .map(entry => ({ path: entry.name, kind: entry.kind }))
}

/**
 * Answer one resolved query with discovery facts. The routes, in order:
 *
 * 1. A scoped LISTING (explicit scope, empty term) reads the target
 *    directory's direct children.
 * 2. An explicit scope with a NON-EMPTY term matches the named directory's
 *    DIRECT children first (Owner amendment D2): when any direct child scores
 *    on the term, exactly those candidates are returned — the user explicitly
 *    named this directory, so its own entries outrank a whole-subtree race and
 *    deeper candidates never run this round. Only with NO matching direct
 *    child (or an unreadable directory) does the query continue below.
 * 3. A scoped or whole-tree FUZZY query uses the locality finder when
 *    available and the bounded subtree scan otherwise. Paths are relative to
 *    the QUERY's search base.
 * @param query - the resolved path query (searchBase already absolute).
 * @param driver - the locality's discovery boundary.
 * @param signal - the editor's request abort.
 */
export async function discoverForQuery(
  query: PathCompletionQuery,
  driver: LocalDiscoveryDriver,
  signal: AbortSignal,
): Promise<readonly PathCandidate[]> {
  if (query.explicitScope && query.searchTerm === '') {
    // A scoped listing: the target directory's OWN content — always the
    // direct children (never a whole-tree scan filtered by string; and never
    // a finder's subtree listing — "show src children" semantics).
    if (signal.aborted) return []
    const direct = await driver.listDirectory(query.searchBase, '', signal)
    if (signal.aborted || direct === null) return []
    return listingCandidates(direct)
  }
  // Direct-child-first for an explicitly named scope (Owner amendment D2):
  // the user typed this directory, so its own matching entries answer before
  // any subtree work. An unreadable directory or a zero-score entry set keeps
  // the original finder/fallback routes below.
  if (query.explicitScope) {
    if (signal.aborted) return []
    const direct = await driver.listDirectory(query.searchBase, '', signal)
    if (signal.aborted) return []
    if (direct !== null) {
      const lowerTerm = query.searchTerm.toLowerCase()
      const matches = listingCandidates(direct)
        .filter(candidate => scorePathCandidate(candidate, lowerTerm) > 0)
      if (matches.length > 0) return matches
    }
  }
  // Fuzzy (scoped or whole-tree): finder first, bounded scan fallback. A
  // Windows-dialect token stays on the scan path (a POSIX finder does not
  // speak `\`).
  if (!query.winAbsolute && !query.raw.includes('\\')) {
    const found = await driver.find(query.searchBase, query.searchTerm, signal)
    if (signal.aborted) return []
    // A finder can omit a filesystem mount-point entry even when it is a
    // direct child of the search root (for example `/tmp` in containerized
    // Linux). Merge matching direct children back in so finder and fallback
    // expose the same root-level candidates; de-duplicate by relative path.
    if (found !== null) {
      const seen = new Set(found.map(candidate => candidate.path))
      const lowerTerm = query.searchTerm.toLowerCase()
      const direct = await driver.listDirectory(query.searchBase, '', signal)
      if (signal.aborted) return []
      const merged = (direct === null ? [] : listingCandidates(direct))
        .filter(candidate => lowerTerm === '' || candidate.path.toLowerCase().includes(lowerTerm))
        .filter(candidate => !seen.has(candidate.path))
      return [...found, ...merged]
    }
  }
  return scanSubtree(query.searchBase, driver, signal)
}
