/**
 * Ctrl+R history search — the replaceable search-source seam (plan §10).
 *
 * Scope semantics:
 * - `'current'` — ONE file: `$DSH_HOME/user-history/<md5(cwd)>.jsonl`. Every
 *   row (v1 AND v2) is displayable: legacy rows inherit `request.cwd` (the
 *   file is keyed by that cwd, so the effective cwd is known — plan §6.1).
 * - `'all'` — every `*.jsonl` under `$DSH_HOME/user-history/` (`.tmp`/`.lock`
 *   and non-JSONL names ignored; corrupt or vanished files degrade to empty —
 *   plan §11.2/§40). Files are scanned in mtime-DESC order (the most recently
 *   active workspace first — plan §7/§8); cwd is resolved per file:
 *   1. a v2 row whose cwd VALIDATES against the file (`historyFilePath(home,
 *      cwd) === file`) proves the hash, and its cwd inherits to the file's v1
 *      rows (Rule 1);
 *   2. a known-cwd map (`md5(cwd) → cwd`, fed by the session browser) recovers
 *      the hash (Rule 2);
 *   3. rows whose cwd stays unknown are EXCLUDED (Rule 3) — never a
 *      fabricated cwd, and the detail pane would otherwise lie.
 *
 * Bounded recent-first scanning (the perf contract):
 * - Every call scans at most `scanLimit` PHYSICAL lines across all files
 *   (a GLOBAL budget, never per-file), reading each file from EOF backwards
 *   through the reverse JSONL reader (history-reverse-reader.ts) — the
 *   canonical file is never read whole.
 * - The result is a {@link HistorySearchPage}: the matches NEW to this call's
 *   window, plus a {@link HistorySearchContinuation} when older history
 *   remains. A continuation resumes exactly where the call stopped (no
 *   re-scan of the covered suffix) and carries the dedupe state, so pages
 *   never duplicate rows. Reaching `scanLimit` does NOT mean exhausted.
 *   The panel currently renders only `page.results`; "Search older" is a
 *   later UI phase on this contract.
 * - Legacy cwd coverage may degrade with the window: the file proof comes
 *   from `knownCwds` (upfront) or a validating v2 row observed INSIDE the
 *   scanned window. Rows whose proof lies outside the window are omitted
 *   from `All directories` — an intentional coverage trade-off; v2 cwd hash
 *   validation itself stays strict and unchanged.
 *
 * Matching: case-insensitive literal substring over content; `''` matches
 * everything (an empty-query Ctrl+R is a recent-history browser, and may
 * stop early once this call has collected `limit` new unique results).
 *
 * Ordering: newest-first by ts; legacy (v1) rows have NO timestamp (never
 * fabricated) and sort AFTER every timed row, then by file asc + newest row
 * first within the file (deterministic — plan §7/§12).
 *
 * Dedupe: current → by `content`; all → by `${cwd}\0${content}` (a prompt
 * in two directories stays two rows — plan §13). The NEWEST occurrence wins
 * (compareResults is the beats predicate, applied incrementally).
 *
 * Cancellation: the search observes the AbortSignal between files, per
 * batch and inside the reader; an abort returns an empty page. The panel
 * ALSO guards by generation, so a stale response can never overwrite a
 * fresher query (plan §14).
 *
 * Future-proof: the panel consumes ONLY {@link HistorySearchSource} — a
 * SQLite/FTS backend may replace the file implementation without touching
 * the UI (plan §54).
 * @module @xmoon76/dsh-pi-tui/history-search
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { historyFilePath, parseHistoryRecordLine, type ParsedHistoryRecord } from './history.ts'
import { readJsonlReverseBatch, type ReverseJsonlCursor } from './history-reverse-reader.ts'

/** The two scope categories (`/sessions` vocabulary). */
export type HistoryScope = 'current' | 'all'

/** Search debounce (local filesystem — plan §15: 50–100ms). */
export const HISTORY_SEARCH_DEBOUNCE_MS = 75

/** Row cap handed to the source (plan §52: 100–200 results, never 5000). */
export const HISTORY_SEARCH_RESULT_LIMIT = 200

/** Global per-call scan budget in physical JSONL lines (plan §4.2: 5000).
 * A call stops scanning once this many lines were materialized across ALL
 * files — the default window, not a permanent search boundary (a
 * continuation can keep going). */
export const HISTORY_SEARCH_SCAN_LIMIT = 5000

/** Reverse-reader chunk size in bytes (plan §5: 64KiB). */
export const HISTORY_SEARCH_READ_CHUNK_BYTES = 64 * 1024

/** One search invocation. */
export interface HistorySearchRequest {
  scope: HistoryScope
  /** The live working directory (the current-scope file key). */
  cwd: string
  /** The filter; `''` matches every row (recent-history browse). */
  query: string
  /** Row cap. */
  limit: number
  signal?: AbortSignal
}

/** One matched row the panel renders. */
export interface HistorySearchResult {
  /** Stable identity (`${sourceFile}:${sourceByteOffset}` — the byte
   * offset of the row's first content byte, stable for append-only files
   * without any forward scan). */
  id: string
  content: string
  /** NULL only for rows excluded in the `all` scope — the panel never
   * displays "directory unknown" rows (Rule 3). */
  cwd: string | null
  /** NULL for legacy (v1) rows — never fabricated. */
  ts: number | null
  sessionId?: string
  sourceFile: string
  /** The row's first content byte in the file (the reverse reader's
   * identity — no forward scan is ever needed for it). */
  sourceByteOffset: number
}

/** One bounded search page: the matches NEW to this call's window, plus the
 * resume state when older history remains. */
export interface HistorySearchPage {
  /** The matches found in this call's window that were not already in the
   * dedupe state, sorted by {@link compareResults} and sliced to the
   * request limit. */
  results: HistorySearchResult[]
  /** Present iff `exhausted` is false: pass it back to `search()` to
   * continue into older history without re-scanning the covered suffix. */
  continuation?: HistorySearchContinuation
  /** True when every candidate file was scanned to EOF — no older history
   * remains. Reaching the scan budget is NOT exhausted. */
  exhausted: boolean
}

/** The opaque resume state of a bounded search. Owned by the source: the
 * caller stores it and hands it back verbatim. */
export interface HistorySearchContinuation {
  /** The request context this continuation belongs to (a mismatched
   * continuation is a typed error, never silently reused). */
  readonly scope: HistoryScope
  readonly cwd: string
  readonly query: string
  readonly limit: number
  /** The files not yet fully scanned, in scan order (the first one is the
   * partially-scanned current file; fully-scanned files are never kept). */
  readonly files: readonly HistoryFileCandidate[]
  /** The reverse-reader cursor for the first file, when it was partially
   * scanned (undefined when the next file starts fresh). */
  readonly cursor: ReverseJsonlCursor | undefined
  /** The dedupe state accumulated so far (key → newest occurrence). */
  readonly seen: ReadonlyMap<string, HistorySearchResult>
  /** The current file's cwd proof (Rule 1/2), carried so a proof formed in
   * an earlier page still applies to older rows of the same file. */
  readonly fileProof: string | null
  /** The current file's rows held pending (all scope, unresolved cwd),
   * carried so a proof found on a LATER page still recovers them. */
  readonly pending: readonly HistorySearchPendingRow[]
  /** Matches found in the covered window beyond the page's result limit —
   * the next page reports them before scanning further, so no match is
   * ever lost across pages. */
  readonly overflow: readonly HistorySearchResult[]
}

/** One all-scope row held pending while its file's cwd proof is unknown. */
export interface HistorySearchPendingRow {
  record: ParsedHistoryRecord
  byteStart: number
}

/** The search seam the panel consumes. */
export interface HistorySearchSource {
  search(
    request: HistorySearchRequest,
    continuation?: HistorySearchContinuation,
  ): Promise<HistorySearchPage>
}

/** One candidate history file with its stat metadata (mtime drives the
 * scan order; the final result order never uses it). */
export interface HistoryFileCandidate {
  path: string
  mtimeMs: number
  size: number
}

/** Per-call work accounting (test-only instrumentation — proves the scan
 * is bounded without wall-clock benchmarks). */
export interface HistorySearchDebugStats {
  /** Files whose content scan was entered. */
  filesVisited: number
  /** Physical JSONL lines materialized (blank/corrupt/valid alike). */
  physicalLinesScanned: number
  /** Bytes actually read from disk. */
  bytesRead: number
}

/** Thrown when a continuation is reused with a different request context —
 * the dedupe state and scan position would silently produce wrong results. */
export class HistorySearchContinuationError extends Error {
  constructor() {
    super('history search continuation does not match the request (scope/cwd/query/limit)')
    this.name = 'HistorySearchContinuationError'
  }
}

/** Constructor options for the file-backed source. */
export interface FileHistorySearchSourceOptions {
  /** `$DSH_HOME`. */
  dshHome: string
  /**
   * Rule 2 legacy recovery: `md5(cwd) → cwd` for cwds known elsewhere.
   * May be a RESOLVER — the all-scope search calls it on EVERY search, so
   * cwds learned after construction (a session created/switched later) are
   * immediately recoverable, never a startup snapshot.
   */
  knownCwds?: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>)
  /** Bounded concurrency for the all-scope STAT phase (plan §12: 8/16;
   * default 8). The content scan itself is SERIAL — recent-first with one
   * global budget, so concurrency can never overscan it. */
  concurrency?: number
  /** Global per-call scan budget in physical lines (default
   * {@link HISTORY_SEARCH_SCAN_LIMIT}). */
  scanLimit?: number
  /** Reverse-reader chunk size in bytes (default
   * {@link HISTORY_SEARCH_READ_CHUNK_BYTES}). */
  readChunkBytes?: number
  /** Optional mutable stats sink, reset and filled on every search call
   * (test-only instrumentation). */
  stats?: HistorySearchDebugStats
}

/**
 * The default search source over the canonical JSONL store
 * (`$DSH_HOME/user-history/<md5(cwd)>.jsonl`, history.ts layout).
 */
export class FileHistorySearchSource implements HistorySearchSource {
  private readonly dshHome: string
  private readonly knownCwds: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>)
  private readonly concurrency: number
  private readonly scanLimit: number
  private readonly readChunkBytes: number
  private readonly stats: HistorySearchDebugStats | undefined

  constructor(options: FileHistorySearchSourceOptions) {
    this.dshHome = options.dshHome
    this.knownCwds = options.knownCwds ?? new Map<string, string>()
    this.concurrency = Math.max(1, options.concurrency ?? 8)
    this.scanLimit = Math.max(1, options.scanLimit ?? HISTORY_SEARCH_SCAN_LIMIT)
    this.readChunkBytes = Math.max(1, options.readChunkBytes ?? HISTORY_SEARCH_READ_CHUNK_BYTES)
    this.stats = options.stats
  }

  async search(
    request: HistorySearchRequest,
    continuation?: HistorySearchContinuation,
  ): Promise<HistorySearchPage> {
    if (continuation !== undefined) this.validateContinuation(request, continuation)
    const scope = request.scope
    const files = continuation !== undefined
      ? [...continuation.files]
      : scope === 'current'
        // The current-scope file is known by path; its stat happens inside
        // the reader (mtime/size are only used for all-scope ordering).
        ? [{ path: historyFilePath(this.dshHome, request.cwd), mtimeMs: 0, size: 0 }]
        : await this.listAllFiles()
    const stats = this.stats
    if (stats !== undefined) {
      stats.filesVisited = 0
      stats.physicalLinesScanned = 0
      stats.bytesRead = 0
    }
    // The dedupe state: restored from the continuation (so pages never
    // duplicate rows) or fresh. `newKeys` tracks the keys added by THIS
    // call; `carriedOverflow` are the matches a previous page sliced away
    // — this page reports them before its own new matches, so no match is
    // ever lost across pages.
    const map = continuation !== undefined
      ? new Map(continuation.seen)
      : new Map<string, HistorySearchResult>()
    const newKeys: string[] = []
    const carriedOverflow = continuation?.overflow ?? []
    let cursor: ReverseJsonlCursor | undefined = continuation?.cursor
    let scanned = 0
    let fileIndex = 0
    // Per-file cwd state, restored from the continuation for the partially
    // scanned file: the proof may have formed in an earlier page, and rows
    // held pending must survive until the proof forms or the file ends.
    let pending: HistorySearchPendingRow[] = continuation !== undefined ? [...continuation.pending] : []
    let fileProof: string | null = continuation !== undefined
      ? continuation.fileProof
      : scope === 'all' ? this.knownCwdFor(files[0]?.path ?? '') : null
    outer:
    while (fileIndex < files.length) {
      if (request.signal?.aborted) return emptyPage()
      // Empty-query early exit: this call already has enough reportable
      // results (carried overflow + new keys — per call, so a continuation
      // page never stalls on the already-full dedupe state).
      if (request.query === '' && carriedOverflow.length + newKeys.length >= request.limit) break
      const file = files[fileIndex]!
      if (fileIndex > 0) {
        // A fresh file: reset the per-file cwd state.
        pending = []
        fileProof = scope === 'all' ? this.knownCwdFor(file.path) : null
      }
      if (stats !== undefined) stats.filesVisited += 1
      // All-scope rows whose cwd is not yet provable are held pending:
      // the proof may form later in the window (Rule 1), and only rows
      // still unresolved at the file's end are excluded (Rule 3).
      let fileDone = false
      try {
        for (;;) {
          if (request.signal?.aborted) return emptyPage()
          const remaining = this.scanLimit - scanned
          if (remaining <= 0) break
          const batch = await readJsonlReverseBatch(file.path, {
            cursor,
            maxRows: Math.min(128, remaining),
            chunkBytes: this.readChunkBytes,
            signal: request.signal,
          })
          if (stats !== undefined) {
            stats.bytesRead += batch.bytesRead
            stats.physicalLinesScanned += batch.lines.length
          }
          for (const line of batch.lines) {
            // A physical line consumes the budget BEFORE parsing — blank
            // and corrupt lines can never cause unbounded scanning.
            scanned += 1
            const record = parseHistoryRecordLine(line.text)
            if (record === null) continue
            fileProof = this.consumeRecord(
              request, file.path, record, line.byteStart, fileProof, pending, map, newKeys,
            )
          }
          if (batch.eof) {
            cursor = undefined
            fileDone = true
            break
          }
          cursor = batch.nextCursor
          if (request.query === '' && carriedOverflow.length + newKeys.length >= request.limit) break outer
        }
      } catch (error) {
        if (isAbortError(error)) return emptyPage()
        // A per-file failure (vanished file, read error, or a
        // ReverseJsonlRevisionError when the file changed under a
        // continuation cursor) skips the rest of this file; rows already
        // collected stay.
        cursor = undefined
        fileDone = true
      }
      if (fileDone) {
        // The file is fully scanned (or skipped): the continuation must
        // not include it — a fresh scan would re-read it from EOF.
        fileIndex += 1
        pending = []
        fileProof = null
        if (scanned >= this.scanLimit) break
        continue
      }
      if (scanned >= this.scanLimit) break
      fileIndex += 1
    }
    if (request.signal?.aborted) return emptyPage()
    // The page reports the carried overflow plus this call's new matches,
    // sorted and sliced to the limit; the tail becomes the next page's
    // overflow (drained by ts, so "Search older" never skips a match).
    const combined = [...carriedOverflow, ...newKeys.map(key => map.get(key)!)]
      .sort(compareResults)
    const results = combined.slice(0, request.limit)
    const overflow = combined.slice(request.limit)
    const exhausted = fileIndex >= files.length && overflow.length === 0
    return {
      results,
      continuation: exhausted ? undefined : {
        scope: request.scope,
        cwd: request.cwd,
        query: request.query,
        limit: request.limit,
        files: files.slice(fileIndex),
        cursor,
        seen: map,
        fileProof,
        pending,
        overflow,
      },
      exhausted,
    }
  }

  /** Every candidate file in the `all` scope, stat'd with bounded
   * concurrency and ordered mtime DESC (most recently active first), then
   * path ASC as the deterministic tie-breaker. A file that fails to stat
   * (vanished) is dropped. */
  private async listAllFiles(): Promise<HistoryFileCandidate[]> {
    try {
      const names = await readdir(join(this.dshHome, 'user-history'))
      const candidates = names
        .filter(name => name.endsWith('.jsonl') && !name.endsWith('.tmp') && !name.endsWith('.lock'))
        .map(name => join(this.dshHome, 'user-history', name))
      const stats = await mapBounded(candidates, this.concurrency, async (path) => {
        try {
          const info = await stat(path)
          return { path, mtimeMs: info.mtimeMs, size: info.size }
        } catch {
          return null
        }
      })
      return stats
        .filter((candidate): candidate is HistoryFileCandidate => candidate !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    } catch {
      return []
    }
  }

  /** Rule 2 cwd proof from the known-cwd map, validated against the file
   * (a stale map entry never fabricates a cwd). */
  private knownCwdFor(file: string): string | null {
    const hash = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
    const known = typeof this.knownCwds === 'function' ? this.knownCwds() : this.knownCwds
    const fromKnown = known.get(hash)
    if (fromKnown !== undefined && historyFilePath(this.dshHome, fromKnown) === file) return fromKnown
    return null
  }

  /** Route ONE parsed row into the result state and return the (possibly
   * updated) file proof.
   *
   * A v2 row's cwd is trusted ONLY when it validates against the file it
   * lives in (`historyFilePath(home, cwd) === file` — plan §40: an invalid
   * v2 cwd/hash mismatch is never trusted; it could be a moved directory or
   * a hand-edited row). In the all scope, the FIRST validating v2 row also
   * forms the file proof (Rule 1) and flushes the rows held pending so far.
   * Untrusted metadata degrades to the file-level proof:
   * - current scope: the file IS the current cwd's file, so every row
   *   (v1, valid v2, invalid v2) ends up at `request.cwd` — inherited, not
   *   fabricated (plan §6.1);
   * - all scope: the row falls back to the file proof (Rule 1/2), and a
   *   row whose file is still unresolved is held pending — excluded only
   *   when the file ends without a proof (Rule 3). */
  private consumeRecord(
    request: HistorySearchRequest,
    file: string,
    record: ParsedHistoryRecord,
    byteStart: number,
    fileProof: string | null,
    pending: HistorySearchPendingRow[],
    map: Map<string, HistorySearchResult>,
    newKeys: string[],
  ): string | null {
    if (record.version === 2 && record.cwd !== null && historyFilePath(this.dshHome, record.cwd) === file) {
      if (request.scope === 'all' && fileProof === null) {
        // The proof forms NOW: flush the pending rows with it.
        fileProof = record.cwd
        for (const held of pending) {
          if (!matchesQuery(held.record.content, request.query)) continue
          this.mergeResult(map, newKeys, this.buildResult(file, held.record, fileProof, held.byteStart), request.scope)
        }
        pending.length = 0
      }
      if (!matchesQuery(record.content, request.query)) return fileProof
      this.mergeResult(map, newKeys, this.buildResult(file, record, record.cwd, byteStart), request.scope)
      return fileProof
    }
    if (request.scope === 'current') {
      if (!matchesQuery(record.content, request.query)) return fileProof
      this.mergeResult(map, newKeys, this.buildResult(file, record, request.cwd, byteStart), request.scope)
      return fileProof
    }
    // All scope: v1 or an untrusted v2 cwd.
    if (fileProof !== null) {
      if (!matchesQuery(record.content, request.query)) return fileProof
      this.mergeResult(map, newKeys, this.buildResult(file, record, fileProof, byteStart), request.scope)
      return fileProof
    }
    pending.push({ record, byteStart })
    return fileProof
  }

  private buildResult(file: string, record: ParsedHistoryRecord, cwd: string, byteStart: number): HistorySearchResult {
    const result: HistorySearchResult = {
      id: `${file}:${byteStart}`,
      content: record.content,
      cwd,
      ts: record.ts,
      sourceFile: file,
      sourceByteOffset: byteStart,
    }
    if (record.sessionId !== undefined) result.sessionId = record.sessionId
    return result
  }

  /** Incremental dedupe: keep the NEWEST occurrence per key (compareResults
   * is the beats predicate — the same winner the final sort would pick).
   * A key is reported as new only the first time it enters the map, so a
   * continuation page never re-reports rows a previous page already
   * returned. */
  private mergeResult(
    map: Map<string, HistorySearchResult>,
    newKeys: string[],
    result: HistorySearchResult,
    scope: HistoryScope,
  ): void {
    const key = scope === 'current' ? result.content : `${result.cwd ?? ''}\0${result.content}`
    const existing = map.get(key)
    if (existing === undefined) {
      map.set(key, result)
      newKeys.push(key)
    } else if (compareResults(result, existing) < 0) {
      map.set(key, result)
    }
  }

  /** A continuation belongs to exactly one request context: reusing it
   * with a different scope/cwd/query/limit would silently produce wrong
   * results (the dedupe state and scan position were built for the old
   * context). */
  private validateContinuation(request: HistorySearchRequest, continuation: HistorySearchContinuation): void {
    if (continuation.scope !== request.scope
      || continuation.cwd !== request.cwd
      || continuation.query !== request.query
      || continuation.limit !== request.limit) {
      throw new HistorySearchContinuationError()
    }
  }
}

/** Case-insensitive literal substring (`''` matches everything). */
function matchesQuery(content: string, query: string): boolean {
  if (query === '') return true
  return content.toLowerCase().includes(query.toLowerCase())
}

/** Newest-first by ts (legacy rows — ts NULL — sort after every timed row),
 * then file ASC, then newest row first within the file (deterministic). */
function compareResults(left: HistorySearchResult, right: HistorySearchResult): number {
  const lt = left.ts ?? -1
  const rt = right.ts ?? -1
  if (rt !== lt) return rt - lt
  const byFile = left.sourceFile.localeCompare(right.sourceFile)
  if (byFile !== 0) return byFile
  return right.sourceByteOffset - left.sourceByteOffset
}

/** The abort contract: an aborted search resolves an empty page (the panel
 * drops it by generation anyway). */
function emptyPage(): HistorySearchPage {
  return { results: [], exhausted: false }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Run `fn` over `items` with at most `concurrency` calls in flight,
 * preserving the input order of the results. */
async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
