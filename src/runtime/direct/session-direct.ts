/**
 * The Direct session reader (M1.3) — the in-process implementation of
 * `SessionReader` over the dsh `sessionPersistence` / `sessionQuery` /
 * projection services. This is the ONLY module in the session-read
 * path that touches `ctx`; the consumer (commands.ts) depends on the port,
 * and a Remote adapter will implement the same interface in a later
 * milestone.
 *
 * The domain semantics live here: semantic session-query listing with
 * capability-aware activity ordering and bounded content search; the combined
 * `title`+`agentPreset` projection batch delegates to
 * `session-projection-direct.ts` (the official projection/cache ladder).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-direct
 */

import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  projectionBatch,
  type SessionProjectionCacheLike,
  type SessionProjectionReaderLike,
} from './session-projection-direct.ts'
import {
  errorCodeOf,
  normalizeSessionSearchQuery,
  searchSessionContentPage,
  type SessionSearchProviderLike,
} from './session-search-direct.ts'
import { cancellationError } from '../../detached.ts'
import type { SessionContentSearchPage, SessionProjectionSummary, SessionReader, SessionSummary } from '../session-reader-port.ts'

/**
 * The narrow session-query surface the reader's listing and semantic search
 * use. Declared structurally instead of imported from
 * `@deepseek-ai/dsh-session-query`: pulling that package's type graph into
 * the program introduces a second physical copy of `dsh-session` that
 * shadows the `session/title` event-map augmentation. The service itself is
 * read off the live context at runtime.
 */
export interface SessionQueryLike {
  /** Returns the semantic live-preferred Session corpus from sessionQuery.
   * ApiSessionList-compatible visibility policy is applied by this adapter:
   * live rows remain visible; cold rows require cwd. */
  listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; live: boolean }>>
  /** One exact live or prepared logical Session observation for explicit
   * viewer/resume paths: header + complete validated event log, caller-owned.
   * NOT the canonical export plane — a cold observation synthesizes
   * interrupted-turn closers for read-only balance, which an export must
   * never contain. */
  observeSession?(
    sessionId: SessionId,
    options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' },
  ): Promise<{
    readonly header: SessionHeader
    readonly events: readonly SessionEvent[]
    [Symbol.dispose](): void
  }>
  /**
   * Official cross-session full-text search (master `ApiSessionList.search`
   * parity). The method is optional so deployments without the semantic
   * search capability can report an explicit unavailable result; the reader
   * never falls back to raw persistence search.
   */
  searchSessions?: SessionSearchProviderLike['searchSessions']
}

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The structural `tokenMeter` surface the reader needs. */
export interface TokenMeterLike {
  measure(session: unknown): { totalTokens: number }
}

/** A live agent as the reader resolves it (structural projection). */
export interface LiveAgentLike {
  readonly session: Session
  /** Agent scope context used by DSH's composedPreset() projection. */
  readonly ctx?: unknown
}

/** Narrow live-registry lookups supplied by the Direct composition root. */
export interface DirectSessionLiveResolvers {
  sessionOf(id: SessionId): unknown | undefined
  agentOf(id: SessionId): unknown | undefined
  flushSession?(session: unknown): Promise<void>
}

/** Read the optional activity projection without activating a cold Session.
 * Missing projection capability, seeded headers without an exact cut, and
 * derived-cache failures all safely fall back to header creation time. */
function activityTimestamp(
  header: SessionHeader,
  liveRow: boolean,
  live: Session | undefined,
  projections: SessionProjectionReaderLike | undefined,
  cache: SessionProjectionCacheLike | undefined,
): number {
  let lastPromptAt: number | undefined
  try {
    if (liveRow && live !== undefined && projections !== undefined) {
      const metadata = projections.cachedSnapshot(live, ['sessionListMetadata'])?.values?.sessionListMetadata
      if (typeof metadata?.lastPromptAt === 'number') lastPromptAt = metadata.lastPromptAt
    } else if (!liveRow && live === undefined && header.isSeeded === false && cache !== undefined) {
      const metadata = cache.cachedSnapshot(header, SessionLogOffset(0), ['sessionListMetadata'])?.values?.sessionListMetadata
      if (typeof metadata?.lastPromptAt === 'number') lastPromptAt = metadata.lastPromptAt
    }
  } catch {
    // Activity is an optional list capability; a stale/broken derived value
    // must never make the semantic session roster unavailable.
  }
  return Math.max(header.createdAt, lastPromptAt ?? 0)
}

/** The Direct backend's session reader: Host query/persistence services plus
 * injected live-registry capabilities behind the semantic `SessionReader` interface. */
export class DirectSessionReader implements SessionReader {
  private readonly ctx: HostContextLike
  private readonly liveResolvers: DirectSessionLiveResolvers | undefined
  /**
   * The most recent listing's complete `SessionHeader` values, keyed by
   * session id. `projectionBatch` reads the projection-cache hint from these
   * instead of re-listing the corpus (the port rows stay lightweight
   * `SessionSummary` DTOs — raw headers never leak into the presentation
   * surface). Refreshed on every `list()`; a batch caller that never listed
   * simply gets cache-miss enrichment.
   */
  private headerSnapshot = new Map<string, SessionHeader>()

  constructor(ctx: HostContextLike, liveResolvers?: DirectSessionLiveResolvers) {
    this.ctx = ctx
    this.liveResolvers = liveResolvers
  }

  private liveAgent(sessionId: string): LiveAgentLike | undefined {
    return this.liveResolvers?.agentOf(SessionId(sessionId)) as LiveAgentLike | undefined
  }

  /** Resolve the attached Session independently from the current TUI owner. */
  private liveSession(sessionId: string): Session | undefined {
    return this.liveResolvers?.sessionOf(SessionId(sessionId)) as Session | undefined
  }

  /** Resolve the actual preset of a currently loaded agent, when DSH exposes
   * its composed roster entry. Cached projection fallback is handled by the
   * live projection branch without materializing the Session. */
  private livePreset(sessionId: string): string | undefined {
    const live = this.liveAgent(sessionId)
    if (live === undefined) return undefined
    const presets = this.ctx.get('agentPresets') as {
      composedPreset?: (agentCtx: unknown) => unknown
    } | undefined
    if (live.ctx !== undefined && typeof presets?.composedPreset === 'function') {
      try {
        const composed = presets.composedPreset(live.ctx)
        if (typeof composed === 'string') return composed
      } catch {
        // A live composition that is being torn down is not a picker error.
      }
    }
    return undefined
  }

  /** List the master-visible semantic session roster: live rows are retained
   * even without cwd; cold rows require cwd before ordering/enrichment. */
  async list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined> {
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    signal?.throwIfAborted()
    // The semantic corpus is the ONLY listing plane (master contract): the
    // reader never falls back to raw persistence artifacts. An unmounted
    // session-query service is an explicit unavailable, not a JSONL scan.
    if (query === undefined) return undefined
    // Listing is deliberately header/live-only. Cold projection replay is a
    // separate projectionBatch() operation so /sessions can open its first
    // picker frame without waiting on every historical session log.
    const records = await query.listSessions(signal)
    signal?.throwIfAborted()
    // Match DSH master ApiSessionList.list(): re-read attachment after the
    // semantic query await, then keep live rows visible even without cwd.
    // An unmounted cold header still needs cwd to be a resolvable picker row.
    const currentRecords = records.map(record => {
      const live = this.liveSession(record.header.id)
      return {
        session: live,
        header: live?.header ?? record.header,
        live: live !== undefined,
      }
    })
    // Keep filtered headers out of the enrichment snapshot so projectionBatch
    // cannot resurrect them later.
    const visibleRecords = currentRecords.filter(record => record.live || record.header.cwd !== undefined)
    this.headerSnapshot = new Map(visibleRecords.map(record => [String(record.header.id), record.header]))
    const projections = this.ctx.get('sessionProjections') as SessionProjectionReaderLike | undefined
    const cache = this.ctx.get('sessionProjectionCache') as SessionProjectionCacheLike | undefined
    const rows = visibleRecords.map(record => ({
      row: {
        id: record.header.id,
        createdAt: record.header.createdAt,
        cwd: record.header.cwd,
        parentSession: record.header.parentSession,
        origin: record.header.origin,
        live: record.live,
      },
      activity: activityTimestamp(record.header, record.live, record.session, projections, cache),
    }))
    signal?.throwIfAborted()
    rows.sort((a, b) => b.activity - a.activity)
    return rows.map(({ row }) => row)
  }

  /**
   * Enrich already-listed rows with the combined DSH projections (`title` +
   * `agentPreset`) through the official ladder in
   * `session-projection-direct.ts`: live cached projection → zero-I/O
   * projection-cache checkpoint (`sessionProjectionCache.cachedSnapshot`,
   * keyed by the header identity captured by the preceding `list()` — no
   * second corpus listing). Cold cache misses remain unknown; the picker
   * never activates a historical Session for labels.
   */
  projectionBatch(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, SessionProjectionSummary>> {
    return projectionBatch({
      ctx: this.ctx,
      rows,
      headerOf: id => this.headerSnapshot.get(id),
      liveSessionOf: id => this.liveSession(id),
      livePresetOf: id => this.livePreset(id),
    }, signal)
  }

  /**
   * Search only the cwd-bearing semantic session roster (master
   * `ApiSessionList.search()` parity): the official `searchSessions` seam
   * with user/assistant-message + current-surface filters, authorization
   * against the visible corpus, dedupe, cursor fill, and the official
   * 20-result window. `undefined` = the content-search capability is
   * unavailable or explicitly disabled — never a raw-persistence scan and
   * never a listing failure. Cancellation is honored through `listSessions`
   * and every provider call.
   */
  async search(query: string, signal?: AbortSignal): Promise<SessionContentSearchPage | undefined> {
    // Cancellation preflight comes FIRST: an aborted signal must reject
    // with an abort-shaped error even when the capability is missing —
    // `undefined` only ever means "capability unavailable", never "aborted".
    signal?.throwIfAborted()
    // Query validation comes BEFORE capability detection (plan §6.3, master
    // `ApiSessionList.search()` parity): an invalid query is a caller error
    // and rejects regardless of whether the capability exists.
    const normalizedQuery = normalizeSessionSearchQuery(query)
    const sessionQuery = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    // The official search seam is `searchSessions` (master parity). An
    // unmounted engine or a provider without the capability is an explicit
    // unavailable — never a JSONL scan and never a `filterEvents` fallback.
    if (sessionQuery === undefined || sessionQuery.searchSessions === undefined) return undefined
    try {
      // Search follows the master visibility contract: only cwd-bearing
      // persisted sessions participate (live cwd-less rows stay list-visible
      // but are outside the search contract).
      const records = await sessionQuery.listSessions(signal)
      signal?.throwIfAborted()
      const visibleIds = new Set(records
        .filter(record => record.header.cwd !== undefined)
        .map(record => String(record.header.id)))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      // The provider method is invoked AS A METHOD of the query service
      // (never extracted as a bare function): the real engine's
      // `searchSessions` is a class method that reads `this` (search
      // enablement, serialized execution, generation state).
      return await searchSessionContentPage({
        searchSessions: (request, exec) => sessionQuery.searchSessions!(request, exec),
      }, visibleIds, normalizedQuery, signal)
    } catch (error) {
      signal?.throwIfAborted()
      // An explicitly disabled search capability is an explicit unavailable
      // (the shipped SQLite FTS provider is `openAt: never` by default).
      if (errorCodeOf(error) === 'SESSION_QUERY_SEARCH_DISABLED') return undefined
      // A provider-side abort — from the listing OR the search provider —
      // stays an abort (the UI treats it as a cancellation, never as a
      // search failure).
      if (errorCodeOf(error) === 'SESSION_QUERY_ABORTED') throw cancellationError('session search was aborted')
      throw error
    }
  }

  measureContext(sessionId: string): number | undefined {
    const agent = this.liveAgent(sessionId)
    if (agent === undefined) return undefined
    const meter = this.ctx.get('tokenMeter') as TokenMeterLike | undefined
    if (meter === undefined) return undefined
    try {
      return meter.measure(agent.session).totalTokens
    } catch {
      // Measurement is best-effort; the /status row falls back to unmeasured.
      return undefined
    }
  }
}
