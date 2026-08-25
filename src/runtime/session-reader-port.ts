/**
 * The session READ domain port (M1.3) — the semantic contract between the
 * TUI and persisted-session reads (list / search / titles), implemented by
 * `src/runtime/direct/` (Direct) today and by a Remote adapter in a later
 * milestone. The port owns the domain semantics (live-preferred listing
 * with persistence fallback, bounded content search, cached title
 * batches); the consumer keeps the picker presentation.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-reader-port
 */

/** One persisted session summary (the picker's row shape, minus the
 * enriched title). */
export interface SessionSummary {
  /** Full session id (the picker's value). */
  id: string
  /** Creation epoch-ms, for the relative age. */
  createdAt: number
  /** Absolute working directory, for the workspace group. */
  cwd?: string
  /** Agent preset id the session runs on, when the deployment composes one. */
  preset?: string
  /** The session this one was forked from, when it has lineage. */
  parentSession?: string
  /** Subagent children carry the `sub` marker. */
  origin?: 'subagent'
  /** Whether the session is currently loaded in the session store. */
  live: boolean
}

/** One content-search hit (bounded snippet around the first match). */
export interface SessionSearchHit {
  id: string
  createdAt: number
  snippet: string
}

/** The raw materialized session log (the /export artifact). */
export interface SessionExportData {
  /** The physical log filename. */
  filename: string
  /** The verbatim JSONL content (decoded from its physical encoding). */
  content: string
}

/** The outcome of one export read (/export): the raw log, or WHY it cannot
 * be exported (the failure kinds are distinct — the persistence service
 * may be absent, the log simply not materialized, or the read itself
 * failed with a real diagnostic). */
export type ExportReadResult =
  | { readonly kind: 'found'; readonly data: SessionExportData }
  /** The persistence service is unavailable in this deployment. */
  | { readonly kind: 'unavailable' }
  /** The persistence service exists but holds no materialized log. */
  | { readonly kind: 'none' }
  /** The log READ failed (corrupt/validation/I-O): the error text is
   * preserved for the user, never misclassified as 'no log'. */
  | { readonly kind: 'error'; readonly message: string }

/** The session READ domain port. */
export interface SessionReader {
  /** List persisted sessions newest-first, live-preferred (the session
   * query engine when available, the persistence fallback otherwise).
   * `undefined` = the persistence service is unavailable. */
  list(currentSessionId: string | undefined): Promise<SessionSummary[] | undefined>
  /** Search persisted session content for a query (bounded: newest 100
   * sessions, first 20 hits). `undefined` = persistence unavailable. */
  search(query: string): Promise<SessionSearchHit[] | undefined>
  /** Load the latest titles for a batch of sessions, newest-first order
   * preserved (bounded, cached under the TUI home). */
  titles(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, string>>
  /** Best-effort context-pressure measurement for one session (the
   * /status context row). `undefined` = unmeasurable (service absent,
   * session unknown, or a measurement failure — never a crash). */
  measureContext(sessionId: string): number | undefined
  /** The raw materialized session log for export (/export). The FILE WRITE
   * stays a client-local export behavior — only the log READ is Host-owned
   * (migration M1.11). */
  readExportData(sessionId: string): Promise<ExportReadResult>
}
