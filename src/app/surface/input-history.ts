/**
 * InputHistory (A5b-2, plan §A5b-2): the ONE client-local owner of the
 * session-scoped editor recall state and its persistence anchor.
 *
 * Ownership:
 *
 * - every cwd this process has ever known (the launch cwd + each live session's
 *   header cwd) — the identity set the all-directory history search resolves
 *   legacy files through (plan §6.2 Rule 2, an IDENTITY match, never a hash
 *   break);
 * - the known-cwd hash map, rebuilt on every call so a session created or
 *   switched after startup is immediately recoverable;
 * - the canonical "last row" persistence anchor and the per-session recall
 *   projection;
 * - the boot recall seed (a deferred start has no session yet).
 *
 * It is client-local: the history files live in the CLIENT's `$DSH_HOME` and
 * are read through the repository's own `history.ts`; no Host service is
 * consulted here.
 * @module @xmoon76/dsh-pi-tui/app/surface/input-history
 */

import { dshHome } from '../../diag.ts'
import { historyFilePath, loadHistoryFile, loadHistoryRecords, type ParsedHistoryRecord } from '../../history.ts'
import type { TuiApp } from '../../tui-app.ts'

/** The narrow capabilities the history owner consumes. */
export interface InputHistoryDeps {
  /** The mounted app (the editor recall API). */
  readonly surface: { readonly app: TuiApp }
  /** The resolved CLIENT working directory (a composition prerequisite). */
  readonly clientCwd: string
  /** The LIVE session's workspace (the status owner). */
  readonly sessionCwd: () => string
}

/** The client-local input-history owner. */
export interface InputHistory {
  /** Remember one workspace cwd (idempotent). */
  rememberCwd(dir: string): void
  /** The known-cwd identity map (`md5(cwd) → cwd`), rebuilt per call. */
  knownCwds(): Map<string, string>
  /** The canonical last history row (the persistence dedupe anchor). */
  lastContent(): string | undefined
  /** Record the new canonical last row. */
  setLastContent(content: string | undefined): void
  /** The per-cwd history records (the session recall projection reads them). */
  records(cwd: string): readonly ParsedHistoryRecord[]
  /** Seed the editor recall from the LAUNCH cwd (deferred start / boot). */
  activateBootRecall(): void
}

/** Create the client-local input-history owner (plan §A5b-2). */
export function createInputHistory(deps: InputHistoryDeps): InputHistory {
  /**
   * Every cwd this process has EVER known (launch cwd + every live
   * session's header cwd, accumulated across creates/resumes/swaps).
   * The Ctrl+R all-directory search resolves legacy files through this
   * set (plan §6.2 Rule 2 — an IDENTITY match, never a hash break).
   * A Set, not a Map, so the resolver below is rebuilt on every call:
   * the all-scope search must see the NEWEST known cwds, not a snapshot
   * from source construction.
   */
  
  const knownHistoryCwdSet = new Set<string>([deps.clientCwd])

  const rememberHistoryCwd = (dir: string): void => {
    if (dir === '' || dir === undefined) return
    knownHistoryCwdSet.add(dir)
  }

  /**
   * The known-cwd identity map for Ctrl+R all-directory history recovery
   * (plan §6.2 Rule 2): `md5(cwd) → cwd` for every workspace this process
   * knows. Resolved fresh on EVERY call — the search source keeps the
   * RESOLVER, so a session created/switched after startup is immediately
   * recoverable (a legacy-only file in that cwd shows up on the next
   * search, no restart needed).
   */
  
  const knownHistoryCwds = (): Map<string, string> => {
    const map = new Map<string, string>()
    const seed = (dir: string): void => {
      if (dir === '' || dir === undefined) return
      const hash = historyFilePath(dshHome(process.env), dir).split('/').pop()!.replace(/\.jsonl$/, '')
      map.set(hash, dir)
    }
    for (const dir of knownHistoryCwdSet) seed(dir)
    seed(deps.sessionCwd())
    return map
  }

  /**
   * The newest input-history entry this process persisted (kimi's
   * `lastHistoryContent` analogue): consecutive repeats are skipped per
   * window, exactly like shell history.
   */
  
  let lastHistoryContent: string | undefined


  const lastContent = (): string | undefined => lastHistoryContent
  const setLastContent = (content: string | undefined): void => { lastHistoryContent = content }
  const records = (cwd: string): readonly ParsedHistoryRecord[] =>
    loadHistoryRecords(historyFilePath(dshHome(process.env), cwd))
  const activateBootRecall = (): void => {
    const entries = loadHistoryFile(historyFilePath(dshHome(process.env), deps.clientCwd))
    lastHistoryContent = entries.at(-1)
    // File order is oldest-first; TuiApp's recall API takes newest-first.
    deps.surface.app.resetInputHistory([...entries].reverse())
  }

  return { rememberCwd: rememberHistoryCwd, knownCwds: knownHistoryCwds, lastContent, setLastContent, records, activateBootRecall }
}
