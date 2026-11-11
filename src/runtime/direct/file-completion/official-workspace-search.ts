/**
 * The OFFICIAL Host Workspace file search the sessionless `@file` surface uses
 * (M6-1/F5-B): a thin wrapper around the published
 * `@deepseek-ai/dsh-file-reference-local/search` primitive. It performs no
 * matching, ranking, traversal, path normalization or exclusion policy of its
 * own — the official `WorkspaceFileSearch` owns all of that, with the SAME
 * published defaults the official Host provider runs with:
 *
 * ```text
 * maxResults            DEFAULT_FILE_SEARCH_MAX_RESULTS (20)
 * maxEntries            DEFAULT_FILE_SEARCH_MAX_ENTRIES (50_000)
 * excludedDirectories   DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES
 * ```
 *
 * The Direct in-process adapter and the Remote Host bridge both use this ONE
 * helper, so the two backends share the same discovery semantics. It is NOT
 * the retired Direct `fd`/`fdfind` scanner: no finder process, no custom
 * ranking, no broadened path syntax.
 *
 * CACHE BUDGET (plan §4.4): at most FOUR resident official indexes, evicted
 * least-recently-read while idle. When all four are in use, the fifth query
 * runs one temporary official search and disposes it in its own `finally` —
 * a live index is never interrupted and the map never grows past the budget.
 * Every entry is released on {@link OfficialWorkspaceSearchPool.dispose}.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/file-completion/official-workspace-search
 */

import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
  type FileSearchConfig,
} from '@deepseek-ai/dsh-file-reference-local/search'
import type { HostFileCandidate } from '../../host-file-port.ts'

/** The fixed search configuration (the published official defaults). */
const OFFICIAL_FILE_SEARCH_CONFIG: FileSearchConfig = {
  maxResults: DEFAULT_FILE_SEARCH_MAX_RESULTS,
  maxEntries: DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
}

/** The resident-index budget the plan fixes. */
const MAX_RESIDENT_INDEXES = 4

/** One Workspace identity plus the canonical root the registry resolved. */
export interface OfficialWorkspaceSearchRoot {
  readonly workspaceId: string
  readonly path: string
}

interface ResidentIndex {
  readonly canonicalPath: string
  readonly search: WorkspaceFileSearch
  active: number
}

function mapCandidates(candidates: readonly { readonly path: string; readonly kind: 'file' | 'directory' }[]): HostFileCandidate[] {
  return candidates.map(candidate => ({ path: candidate.path, kind: candidate.kind }))
}

/**
 * The bounded official-search cache shared by the Direct adapter and the
 * Remote Host bridge. One instance per owning Host row (or Direct runner);
 * {@link dispose} releases every resident official index.
 */
export class OfficialWorkspaceSearchPool {
  private readonly entries = new Map<string, ResidentIndex>()
  private disposed = false

  /**
   * Run ONE official workspace query against the registry-resolved root.
   * `signal` cancels only this caller's wait, exactly like the official
   * primitive. A disposed pool fails fast: no search is started for a row that
   * is already gone.
   */
  async list(
    root: OfficialWorkspaceSearchRoot,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly HostFileCandidate[]> {
    if (this.disposed) throw new Error('the official workspace search pool is disposed')
    signal.throwIfAborted()
    const key = root.workspaceId
    let resident = this.entries.get(key)
    if (resident !== undefined && resident.canonicalPath !== root.path) {
      // The registry resolved a different canonical root for the same id: the
      // old index belongs to another tree.
      resident.search.dispose()
      this.entries.delete(key)
      resident = undefined
    }
    if (resident === undefined) {
      if (!this.hasIdleSlot()) {
        const temporary = new WorkspaceFileSearch(root.path, OFFICIAL_FILE_SEARCH_CONFIG)
        try {
          const candidates = await temporary.list(query, signal)
          signal.throwIfAborted()
          return mapCandidates(candidates)
        } finally {
          temporary.dispose()
        }
      }
      resident = { canonicalPath: root.path, search: new WorkspaceFileSearch(root.path, OFFICIAL_FILE_SEARCH_CONFIG), active: 0 }
      this.entries.set(key, resident)
      this.evictBeyondBudget()
    } else {
      // Refresh recency: Map insertion order is the LRU order.
      this.entries.delete(key)
      this.entries.set(key, resident)
    }
    resident.active += 1
    try {
      const candidates = await resident.search.list(query, signal)
      signal.throwIfAborted()
      return mapCandidates(candidates)
    } finally {
      resident.active -= 1
    }
  }

  /**
   * Mark every resident official index stale (the Host `tool/result`
   * invalidation hook). The official primitive keeps answering from its stale
   * entries while the rebuild happens behind the caret — that advisory
   * freshness policy stays with the primitive.
   */
  invalidateAll(): void {
    for (const resident of this.entries.values()) resident.search.invalidate()
  }

  /** Abort traversal, release every resident index (service/Host disposal). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resident of this.entries.values()) resident.search.dispose()
    this.entries.clear()
  }

  /** The number of resident indexes (cache-budget probes). */
  get residentIndexes(): number {
    return this.entries.size
  }

  private hasIdleSlot(): boolean {
    if (this.entries.size < MAX_RESIDENT_INDEXES) return true
    for (const resident of this.entries.values()) {
      if (resident.active === 0) return true
    }
    return false
  }

  private evictBeyondBudget(): void {
    while (this.entries.size > MAX_RESIDENT_INDEXES) {
      let victimKey: string | undefined
      for (const [key, resident] of this.entries) {
        if (resident.active === 0) {
          victimKey = key
          break
        }
      }
      if (victimKey === undefined) return
      const victim = this.entries.get(victimKey)
      this.entries.delete(victimKey)
      victim?.search.dispose()
    }
  }
}
