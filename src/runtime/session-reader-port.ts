/**
 * The session READ domain port (M1.3) — the semantic contract between the
 * TUI and persisted-session reads (list / projection / search), implemented
 * by `src/runtime/direct/` (Direct) and the experimental D1.1 Remote adapter. The port owns the domain semantics (semantic lightweight listing,
 * the combined `title`+`agentPreset` projection batch with zero-I/O cold cache
 * hints and unknown-on-miss semantics, bounded content search); the consumer
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
  /** Host-authoritative activity/order timestamp. */
  updatedAt: number
  /** Source-specific creation hint; Remote list rows may not provide it. */
  createdAt?: number
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

/** One authorized content-search hit: the visible Session identity plus the
 * Host-selected bounded plain-text excerpt. Session metadata (createdAt,
 * cwd, …) is NOT duplicated here — `list()` is the authoritative metadata
 * source and the picker merges hits onto already-listed rows. */
export interface SessionContentSearchItem {
  /** Authorized visible Session identity. */
  readonly sessionId: string
  /** Host-selected bounded plain-text excerpt. */
  readonly snippet: string
}

/** One bounded page of authorized Session content-search hits. `hasMore`
 * means the Host search found more matches than this page carries — the
 * consumer shows a refine hint, it never auto-paginates. */
export interface SessionContentSearchPage {
  readonly items: readonly SessionContentSearchItem[]
  readonly hasMore: boolean
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

/** The session READ domain port. */
export interface SessionReader {
  /** List semantic session-query rows newest-first: live rows remain visible,
   * while cold rows require cwd. `undefined` = that listing capability is
   * unavailable. `signal` cancels optional cache inspection without changing
   * the row contract. */
  list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined>
  /** Read the Host-owned DSH session projections (`title` + `agentPreset`)
   * for a batch of already-listed rows: one combined semantic read per
   * batch — live projection snapshot for live rows and the zero-I/O
   * projection-cache checkpoint for eligible cold rows. Cold cache misses
   * remain unknown; this port never activates a historical Session merely to
   * fill picker labels. Implementations omit a field for a
   * corrupt/unsupported session (the row keeps its short-id presentation)
   * and must honor signal cancellation; an aborted signal rejects the whole
   * batch. */
  projectionBatch(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, SessionProjectionSummary>>
  /**
   * Search Host-owned visible Session message content.
   *
   * `undefined` means the content-search capability is unavailable or
   * explicitly disabled in this deployment. It does NOT mean session
   * persistence/listing is unavailable — the picker keeps its local
   * metadata filtering either way.
   *
   * Implementations must honor caller cancellation: an aborted signal
   * rejects with an abort-shaped error, never a normal empty result.
   */
  search(query: string, signal?: AbortSignal): Promise<SessionContentSearchPage | undefined>
  /** Best-effort context-pressure measurement for one session (the
   * /status context row). `undefined` = unmeasurable (service absent,
   * session unknown, or a measurement failure — never a crash). */
  measureContext(sessionId: string): number | undefined
}
