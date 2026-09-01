/**
 * The session READ domain port (M1.3) — the semantic contract between the
 * TUI and persisted-session reads (list / projection / search), implemented
 * by `src/runtime/direct/` (Direct) today and by a Remote adapter in a later
 * milestone. The port owns the domain semantics (live-preferred lightweight
 * listing, the combined `title`+`agentPreset` projection batch with at most
 * one cold observation per session, bounded content search); the consumer
 * keeps the picker presentation.
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
  /** Effective agent preset id, when a caller has already enriched this row.
   * Initial list results may omit it while projection replay is pending. */
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

/** The combined projection enrichment for one session row: the DSH `title`
 * and `agentPreset` projection values. An absent field means "not available
 * from the projection for this row" (corrupt log, unusable identity) — the
 * caller keeps the short-id / preset-less presentation. `title` is absent
 * both when the session has no title and when the read failed; the official
 * projection's `null` ("no title yet") normalizes to absent here. */
export interface SessionProjectionSummary {
  readonly title?: string
  readonly preset?: string
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
   * `undefined` = the persistence service is unavailable. `signal` cancels
   * cold-session projection inspection without changing the row contract. */
  list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined>
  /** Read the Host-owned DSH session projections (`title` + `agentPreset`)
   * for a batch of already-listed rows: one combined semantic read per
   * batch — live projection snapshot for live rows, the zero-I/O
   * projection-cache checkpoint for cold rows, and AT MOST ONE
   * `observeSession()` observation per cold cache miss, which resolves
   * BOTH title and agentPreset together. This is deliberate: the port
   * never exposes per-field read paths (a second corpus scan per field is
   * exactly the cost this port exists to remove), and a future Remote
   * adapter maps it onto the official DSH client projection contract.
   * Implementations omit a field for a corrupt/unsupported session (the
   * row keeps its short-id presentation) and must honor signal
   * cancellation with bounded concurrency; an aborted signal rejects the
   * whole batch. */
  projectionBatch(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, SessionProjectionSummary>>
  /** Search semantic session content for a query (bounded: newest 100
   * sessions, first 20 hits). The Direct adapter uses SessionQuery when its
   * semantic filter capability is available and only falls back to raw
   * persistence when that capability is absent/explicitly disabled. */
  search(query: string): Promise<SessionSearchHit[] | undefined>
  /** Best-effort context-pressure measurement for one session (the
   * /status context row). `undefined` = unmeasurable (service absent,
   * session unknown, or a measurement failure — never a crash). */
  measureContext(sessionId: string): number | undefined
  /** The raw materialized session log for export (/export). The FILE WRITE
   * stays a client-local export behavior — only the log READ is Host-owned
   * (migration M1.11). */
  readExportData(sessionId: string): Promise<ExportReadResult>
}
