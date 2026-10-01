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

import type { TurnOutlineEntryDto } from './presentation-read-port.ts'

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
  /** Host-authoritative blankness for one Session (v2 §0.6): whether the
   *  Session has no started turn — the /preset affordance authority. `undefined`
   *  means the Host authority is unavailable; it is NEVER inferred from the
   *  transcript, rendered rows, running state, or a live Agent object. */
  blank(sessionId: string): boolean | undefined
  /** Best-effort context occupancy for one session (the /status context
   * row): the official `contextPressure` projection's numerator
   * `projectedTokens ?? pressureTokens` (the same field dsh-web's
   * ContextMeter reads). `undefined` = the projection capability or value
   * is unavailable for the session (never a second measurement authority —
   * both backends read this one semantic). */
  measureContext(sessionId: string): number | undefined
  /** The official whole-log `turnOutline` projection entries for one
   *  session, in ascending turn order — the M3-4 `/rewind` navigation
   *  boundary source. `undefined` = the projection capability or session
   *  is unavailable. This is a projection read only: it never pages
   *  history and never folds a second outline client-side. */
  turnOutline(sessionId: string): readonly TurnOutlineEntryDto[] | undefined
  /** The subject-neutral Session-scoped official facts one footer/status
   *  surface needs (M3-4/M3-5 foundation): model selection, context
   *  pressure/breakdown, usage, todos and the cwd fact — read from the
   *  OFFICIAL projections of that exact session (main or viewed child
   *  alike). `undefined` = the session is not materialized/retained. An
   *  absent FIELD means "this projection/capability is not available for
   *  the session" — never a parent/main-session fallback, never a
   *  zero-filled guess. */
  sessionStatus(sessionId: string): SessionStatusProjection | undefined
}

/** One detached todo entry of the official `todos` projection (the
 *  `todo/write` whole-list snapshot fields, statuses verbatim). */
export interface SessionStatusTodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The durable cumulative provider usage of the official `tokenUsage`
 * projection (four disjoint buckets; reasoning tokens are already inside
 * `outputTokens`). */
export interface SessionStatusUsageProjection {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** The official context facts: the pressure numerator fields (either may be
 * absent until a provider reports usage), the newest route capacity, and
 * the heuristic composition breakdown. */
export interface SessionStatusContextProjection {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
  readonly breakdown?: {
    readonly systemTokens: number
    readonly toolsTokens: number
    readonly messageTokens: number
  }
}

/** The official Session-scoped status projection snapshot (M3-4/M3-5). */
export interface SessionStatusProjection {
  readonly sessionId: string
  /** The official workspace fact of THIS session (absent when the source
   *  supplies none — never another session's cwd). */
  readonly cwd?: string
  /** The effective model selection (`next ?? lastUsed` of the official
   *  `modelSelection` projection). */
  readonly model?: ModelSelectionFact
  /** The recorded agent preset of THIS session (the official `agentPreset`
   *  projection's string value; `null` normalizes to absent here). */
  readonly preset?: string
  readonly context?: SessionStatusContextProjection
  /** The official `todos` projection value: the whole list snapshot, or
   *  `null` = the projection exists but no `todo/write` has landed yet (a
   *  LEGAL business value, distinct from the field being ABSENT = the
   *  projection/capability is unavailable). Presentation decides how to
   *  render the null state (the official Web shows an empty panel). */
  readonly todos?: readonly SessionStatusTodoItem[] | null
  readonly usage?: SessionStatusUsageProjection
}

/** A detached provider/model/effort selection value (the official
 *  `ModelSelection` fields the status surface reads). */
export interface ModelSelectionFact {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The official context-pressure occupancy numerator shared by both
 * backends: `projectedTokens ?? pressureTokens` over the raw projection
 * value (an absent/foreign-shaped field is not coerced; a projection with
 * neither field reads unmeasured). */
export function contextPressureOccupancy(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const pressure = value as { readonly projectedTokens?: unknown; readonly pressureTokens?: unknown }
  if (typeof pressure.projectedTokens === 'number') return pressure.projectedTokens
  if (typeof pressure.pressureTokens === 'number') return pressure.pressureTokens
  return undefined
}
