/**
 * Ctrl+R history search — the replaceable search-source seam (plan §10).
 *
 * Scope semantics:
 * - `'current'` — ONE file: `$DSH_HOME/user-history/<md5(cwd)>.jsonl`. Every
 *   row (v1 AND v2) is displayable: legacy rows inherit `request.cwd` (the
 *   file is keyed by that cwd, so the effective cwd is known — plan §6.1).
 * - `'all'` — every `*.jsonl` under `$DSH_HOME/user-history/` (`.tmp`/`.lock`
 *   and non-JSONL names ignored; corrupt or vanished files degrade to empty —
 *   plan §11.2/§40). cwd is resolved per file:
 *   1. a v2 row whose cwd VALIDATES against the file (`historyFilePath(home,
 *      cwd) === file`) proves the hash, and its cwd inherits to the file's v1
 *      rows (Rule 1);
 *   2. a known-cwd map (`md5(cwd) → cwd`, fed by the session browser) recovers
 *      the hash (Rule 2);
 *   3. rows whose cwd stays unknown are EXCLUDED (Rule 3) — never a
 *      fabricated cwd, and the detail pane would otherwise lie.
 *
 * Matching: case-insensitive literal substring over content; `''` matches
 * everything (an empty-query Ctrl+R is a recent-history browser).
 *
 * Ordering: newest-first by ts; legacy (v1) rows have NO timestamp (never
 * fabricated) and sort AFTER every timed row, then by file asc + newest row
 * first within the file (deterministic — plan §7/§12).
 *
 * Dedupe: current → by `content`; all → by `${cwd}\0${content}` (a prompt
 * in two directories stays two rows — plan §13). The NEWEST occurrence wins.
 *
 * Cancellation: the search observes the AbortSignal between files; the panel
 * ALSO guards by generation, so a stale response can never overwrite a
 * fresher query (plan §14).
 *
 * Future-proof: the panel consumes ONLY {@link HistorySearchSource} — a
 * SQLite/FTS backend may replace the file implementation without touching the
 * UI (plan §54).
 * @module @xmoon76/dsh-pi-tui/history-search
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { historyFilePath, parseHistoryRecords, type ParsedHistoryRecord } from './history.ts'

/** The two scope categories (`/sessions` vocabulary). */
export type HistoryScope = 'current' | 'all'

/** Search debounce (local filesystem — plan §15: 50–100ms). */
export const HISTORY_SEARCH_DEBOUNCE_MS = 75

/** Row cap handed to the source (plan §52: 100–200 results, never 5000). */
export const HISTORY_SEARCH_LIMIT = 200

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
  /** Stable identity (`${sourceFile}:${sourceIndex}`). */
  id: string
  content: string
  /** NULL only for rows excluded in the `all` scope — the panel never
   * displays "directory unknown" rows (Rule 3). */
  cwd: string | null
  /** NULL for legacy (v1) rows — never fabricated. */
  ts: number | null
  sessionId?: string
  sourceFile: string
  /** Row position within the parsed file (corrupt lines simply do not
   * appear, so positions are stable for a given file content). */
  sourceIndex: number
}

/** The search seam the panel consumes. */
export interface HistorySearchSource {
  search(request: HistorySearchRequest): Promise<HistorySearchResult[]>
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
  /** Concurrent file reads in the `all` scope (plan §16; default 8). */
  concurrency?: number
}

/**
 * The default search source over the canonical JSONL store
 * (`$DSH_HOME/user-history/<md5(cwd)>.jsonl`, history.ts layout).
 */
export class FileHistorySearchSource implements HistorySearchSource {
  private readonly dshHome: string
  private readonly knownCwds: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>)
  private readonly concurrency: number

  constructor(options: FileHistorySearchSourceOptions) {
    this.dshHome = options.dshHome
    this.knownCwds = options.knownCwds ?? new Map<string, string>()
    this.concurrency = Math.max(1, options.concurrency ?? 8)
  }

  async search(request: HistorySearchRequest): Promise<HistorySearchResult[]> {
    const scope = request.scope
    const files = scope === 'current'
      ? [historyFilePath(this.dshHome, request.cwd)]
      : await this.listAllFiles()
    const results: HistorySearchResult[] = []
    // A REAL bounded worker pool over the file set: each worker awaits its
    // own async read and the pool keeps at most `concurrency` reads in
    // flight, so the event loop stays free between files (an all-scope
    // scan never blocks typing/rendering; plan §16). The abort signal is
    // checked by every worker between files. A per-file failure only drops
    // that file's rows (plan §40).
    const queue = [...files]
    const workers = Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, async () => {
      for (;;) {
        if (request.signal?.aborted) return
        const file = queue.shift()
        if (file === undefined) return
        const records = await this.readRows(file)
        // The file-level cwd proof, computed ONCE per file (Rules 1+2).
        const fileCwd = scope === 'all' ? this.resolveFileCwd(file, records) : null
        for (let rowIndex = 0; rowIndex < records.length; rowIndex += 1) {
          const row = records[rowIndex]!
          const cwd = this.effectiveCwd(request, file, row, fileCwd)
          if (cwd === null) continue
          if (!matchesQuery(row.content, request.query)) continue
          const result: HistorySearchResult = {
            id: `${file}:${rowIndex}`,
            content: row.content,
            cwd,
            ts: row.ts,
            sourceFile: file,
            sourceIndex: rowIndex,
          }
          if (row.sessionId !== undefined) result.sessionId = row.sessionId
          results.push(result)
        }
      }
    })
    await Promise.all(workers)
    if (request.signal?.aborted) return []
    return dedupeKeepNewest(results, scope).sort(compareResults).slice(0, request.limit)
  }

  /** Parse one file's live rows asynchronously; unreadable/corrupt files
   * (including a vanished file) degrade to `[]`. */
  private async readRows(file: string): Promise<ParsedHistoryRecord[]> {
    try {
      return parseHistoryRecords(await readFile(file, 'utf8'))
    } catch {
      return []
    }
  }

  /** Every candidate file in the `all` scope (sorted for determinism). */
  private async listAllFiles(): Promise<string[]> {
    try {
      const names = await readdir(join(this.dshHome, 'user-history'))
      return names
        .filter(name => name.endsWith('.jsonl') && !name.endsWith('.tmp') && !name.endsWith('.lock'))
        .map(name => join(this.dshHome, 'user-history', name))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Rule 1 + Rule 2 cwd proof for ONE file in the `all` scope:
   * - a v2 row whose cwd validates against the file itself
   *   (`historyFilePath(home, cwd) === file`) identifies the hash — that
   *   cwd inherits to the file's legacy rows;
   * - else the known-cwd map (`md5(cwd) → cwd`) proves it;
   * - else NULL (Rule 3: legacy rows of this file are excluded).
   */
  private resolveFileCwd(file: string, records: readonly ParsedHistoryRecord[]): string | null {
    for (const row of records) {
      if (row.version !== 2 || row.cwd === null) continue
      if (historyFilePath(this.dshHome, row.cwd) === file) return row.cwd
    }
    const hash = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
    const known = typeof this.knownCwds === 'function' ? this.knownCwds() : this.knownCwds
    const fromKnown = known.get(hash)
    if (fromKnown !== undefined && historyFilePath(this.dshHome, fromKnown) === file) return fromKnown
    return null
  }

  /** The display cwd of ONE row, or NULL when the row must be excluded.
   *
   * A v2 row's cwd is trusted ONLY when it validates against the file it
   * lives in (`historyFilePath(home, cwd) === file` — plan §40: an invalid
   * v2 cwd/hash mismatch is never trusted; it could be a moved directory or
   * a hand-edited row). Untrusted metadata degrades to the file-level proof:
   * - current scope: the file IS the current cwd's file, so every row
   *   (v1, valid v2, invalid v2) ends up at `request.cwd` — inherited, not
   *   fabricated (plan §6.1);
   * - all scope: the row falls back to the file proof (Rule 1/2), and a
   *   row whose file is still unresolved is EXCLUDED (Rule 3). */
  private effectiveCwd(request: HistorySearchRequest, file: string, row: ParsedHistoryRecord, fileCwd: string | null): string | null {
    if (row.version === 2 && row.cwd !== null && historyFilePath(this.dshHome, row.cwd) === file) {
      return row.cwd
    }
    if (request.scope === 'current') return request.cwd
    return fileCwd // v1 or untrusted v2: inherit the file proof; NULL → Rule 3 exclusion
  }
}

/** Case-insensitive literal substring (`''` matches everything). */
function matchesQuery(content: string, query: string): boolean {
  if (query === '') return true
  return content.toLowerCase().includes(query.toLowerCase())
}

/** Keep the NEWEST occurrence of each key (results are pre-sorted newest
 * first by ts — but legacy rows sort later, so dedupe must run on the
 * FINAL total order, which slice does after sorting: see search()). */
function dedupeKeepNewest(results: HistorySearchResult[], scope: HistoryScope): HistorySearchResult[] {
  // The caller sorts AFTER dedupe, so dedupe first by ts-DESC order to keep
  // the newest winner (v2 rows vs legacy duplicates of the same content).
  const ordered = [...results].sort(compareResults)
  const seen = new Set<string>()
  const kept: HistorySearchResult[] = []
  for (const row of ordered) {
    const key = scope === 'current' ? row.content : `${row.cwd ?? ''}\0${row.content}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(row)
  }
  return kept
}

/** Newest-first by ts (legacy rows — ts NULL — sort after every timed row),
 * then file ASC, then newest row first within the file (deterministic). */
function compareResults(left: HistorySearchResult, right: HistorySearchResult): number {
  const lt = left.ts ?? -1
  const rt = right.ts ?? -1
  if (rt !== lt) return rt - lt
  const byFile = left.sourceFile.localeCompare(right.sourceFile)
  if (byFile !== 0) return byFile
  return right.sourceIndex - left.sourceIndex
}