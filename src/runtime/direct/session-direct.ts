/**
 * The Direct session reader (M1.3) — the in-process implementation of
 * `SessionReader` over the dsh `sessionPersistence` / `sessionQuery` /
 * projection services. This is the ONLY module in the session-read
 * path that touches `ctx`; the consumer (commands.ts) depends on the port,
 * and a Remote adapter will implement the same interface in a later
 * milestone.
 *
 * The domain semantics live here: live-preferred listing with the
 * persistence fallback and the bounded content search; the combined
 * `title`+`agentPreset` projection batch delegates to
 * `session-projection-direct.ts` (the official projection/cache/observation
 * ladder).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-direct
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { isUnsupportedSessionFormatError, type SessionEventSearchDocumentLike } from '../../sessions.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { projectionBatch, type SessionQueryObservationLike, type SessionReaderDiagLike } from './session-projection-direct.ts'
import { sessionPresetOf } from './session-preset-direct.ts'
import type { ExportReadResult, SessionProjectionSummary, SessionSearchHit, SessionReader, SessionSummary } from '../session-reader-port.ts'

/**
 * The narrow session-query surface the reader's listing and semantic search
 * use. Declared structurally instead of imported from
 * `@deepseek-ai/dsh-session-query`: pulling that package's type graph into
 * the program introduces a second physical copy of `dsh-session` that
 * shadows the `session/title` event-map augmentation. The service itself is
 * read off the live context at runtime.
 */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; live: boolean }>>
  /**
   * Provider-independent semantic text filtering. The method is optional so
   * older test doubles and intentionally rosterless deployments can still use
   * the persistence capability fallback; it is not a DSH runtime fallback.
   */
  filterEvents?: (
    sessionId: SessionId,
    filters: readonly SessionEventResultFilterLike[],
  ) => Promise<readonly SessionEventSearchDocumentLike[]>
}

/** The public session-query text filter used by the semantic search. */
export interface SessionEventResultFilterLike {
  readonly kind: 'text'
  readonly text: string
}

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The structural `sessionPersistence` surface the reader needs. */
export interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<Array<{ id: string; createdAt: number; version: number; cwd?: string; agentPreset?: string; parentSession?: string; origin?: 'subagent' }>>
  readRaw(id: string): Promise<{ content: string; filename?: string } | undefined>
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

/** The diagnostics sink for isolated per-row projection failures. */
export type SessionReaderDiag = SessionReaderDiagLike

/** Make one semantic event document suitable for the existing search port. */
function semanticSnippet(document: SessionEventSearchDocumentLike, query: string): string {
  const text = document.text.replace(/\s+/g, ' ').trim()
  const needle = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const index = text.toLowerCase().indexOf(needle)
  if (index < 0) return text.slice(0, 120)
  const start = Math.max(0, index - 40)
  return text.slice(start, index + needle.length + 40).trim()
}

/** Read a typed query-service error without depending on its package surface. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The Direct backend's session reader: `ctx` services behind the semantic
 * `SessionReader` interface. */
export class DirectSessionReader implements SessionReader {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined
  private readonly diag: SessionReaderDiagLike | undefined
  /**
   * The most recent listing's complete `SessionHeader` values, keyed by
   * session id. `projectionBatch` reads the projection-cache hint from these
   * instead of re-listing the corpus (the port rows stay lightweight
   * `SessionSummary` DTOs — raw headers never leak into the presentation
   * surface). Refreshed on every `list()`; a batch caller that never listed
   * simply gets cache-miss enrichment.
   */
  private headerSnapshot = new Map<string, SessionHeader>()

  constructor(
    ctx: HostContextLike,
    agentFor?: (sessionId: string) => unknown | undefined,
    diag?: SessionReaderDiagLike,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor ?? (() => undefined)
    this.diag = diag
  }

  private liveAgent(sessionId: string): LiveAgentLike | undefined {
    return this.agentFor(sessionId) as LiveAgentLike | undefined
  }

  /** Resolve the actual preset of a currently loaded agent, when DSH exposes
   * its composed roster entry. The projection fallback is intentionally raw:
   * without a roster it cannot distinguish a legal custom `code` id from old
   * pi-tui data. */
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
    return sessionPresetOf(this.ctx, live.session)
  }

  private async presetRosterIds(signal?: AbortSignal): Promise<readonly string[] | undefined> {
    const presets = this.ctx.get('agentPresets') as { list(): Promise<readonly { id: string }[]> } | undefined
    if (presets === undefined) return undefined
    signal?.throwIfAborted()
    try {
      const roster = await presets.list()
      signal?.throwIfAborted()
      return roster.map(preset => preset.id)
    } catch {
      signal?.throwIfAborted()
      // A failed roster read must not turn a lightweight picker into a hard
      // failure. Cold rows remain fail-closed if their projection cannot be
      // resolved; the batch caller can still show all session identities.
      return undefined
    }
  }

  async list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    signal?.throwIfAborted()
    let rows: SessionSummary[]
    if (query !== undefined) {
      // Listing is deliberately header/live-only. Cold projection replay is a
      // separate projectionBatch() operation so /sessions can open its first
      // picker frame without waiting on every historical session log.
      const records = await query.listSessions(signal)
      signal?.throwIfAborted()
      this.headerSnapshot = new Map(records.map(record => [String(record.header.id), record.header]))
      rows = records.map(record => ({
        id: record.header.id,
        createdAt: record.header.createdAt,
        cwd: record.header.cwd,
        parentSession: record.header.parentSession,
        origin: record.header.origin,
        live: record.live,
      }))
    } else {
      if (persistence === undefined) return undefined
      const headers = await persistence.list(signal)
      signal?.throwIfAborted()
      this.headerSnapshot = new Map(headers.map(header => [String(header.id), header as SessionHeader]))
      rows = headers.map(header => ({
        id: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd,
        parentSession: header.parentSession,
        origin: header.origin,
        live: header.id === currentSessionId,
      }))
    }
    signal?.throwIfAborted()
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }

  /**
   * Enrich already-listed rows with the combined DSH projections (`title` +
   * `agentPreset`) through the official ladder in
   * `session-projection-direct.ts`: live projection snapshot → zero-I/O
   * projection-cache checkpoint (`sessionProjectionCache.cachedSnapshot`,
   * keyed by the header identity captured by the preceding `list()` — no
   * second corpus listing) → at most ONE bounded, cancellable
   * `observeSession()` observation per cold cache miss, resolving BOTH
   * fields together. Corrupt or unsupported logs are omitted rather than
   * being treated as an empty value, and never trigger a second raw-log
   * read.
   */
  projectionBatch(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, SessionProjectionSummary>> {
    return projectionBatch({
      ctx: this.ctx,
      rows,
      headerOf: id => this.headerSnapshot.get(id),
      liveAgentOf: id => this.liveAgent(id),
      livePresetOf: id => this.livePreset(id),
      rosterIds: signal => this.presetRosterIds(signal),
      diag: this.diag,
    }, signal)
  }

  async search(query: string): Promise<SessionSearchHit[] | undefined> {
    const searchText = query.trim()
    if (searchText === '') return []

    const sessionQuery = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (sessionQuery?.filterEvents !== undefined) {
      // `searchSessions` is intentionally disabled by the shipped SQLite FTS
      // session-query provider (`openAt: never`). `filterEvents` remains the
      // public, backend-independent semantic text seam, so use it over the
      // query engine's live-preferred corpus rather than scanning raw JSONL.
      const records = [...await sessionQuery.listSessions()]
        .sort((a, b) => b.header.createdAt - a.header.createdAt)
        .slice(0, 100)
      const hits: SessionSearchHit[] = []
      for (const record of records) {
        let documents: readonly SessionEventSearchDocumentLike[]
        try {
          documents = await sessionQuery.filterEvents(SessionId(record.header.id), [{ kind: 'text', text: searchText }])
        } catch (error) {
          // An explicitly disabled query capability is the one case where the
          // old persistence path remains a deliberate deployment fallback.
          // It is not a DSH runtime compatibility branch.
          if (errorCodeOf(error) === 'SESSION_QUERY_SEARCH_DISABLED') return this.searchRaw(searchText)
          throw error
        }
        const document = documents[0]
        if (document === undefined) continue
        hits.push({
          id: String(record.header.id),
          createdAt: record.header.createdAt,
          snippet: semanticSnippet(document, searchText),
        })
        if (hits.length >= 20) break
      }
      return hits
    }

    // Test doubles and deployments without a query engine retain the old
    // capability fallback. The supported DSH runtime itself mounts the query
    // service; this branch is not API or runtime-version detection.
    return this.searchRaw(searchText)
  }

  private async searchRaw(query: string): Promise<SessionSearchHit[] | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) return undefined
    const needle = query.toLowerCase()
    // Copy before sorting: the persistence service's list() result is a
    // shared array — an in-place sort would reorder it for every other
    // consumer (review finding).
    const headers = [...(await persistence.list())]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
    const hits: SessionSearchHit[] = []
    for (const header of headers) {
      let raw: { content: string } | undefined
      try {
        raw = await persistence.readRaw(header.id)
      } catch (error) {
        if (isUnsupportedSessionFormatError(error)) throw error
        continue
      }
      if (raw === undefined) continue
      const index = raw.content.toLowerCase().indexOf(needle)
      if (index === -1) continue
      const start = Math.max(0, index - 40)
      const snippet = raw.content.slice(start, index + query.length + 40).replace(/\s+/g, ' ').trim()
      hits.push({ id: header.id, createdAt: header.createdAt, snippet })
      if (hits.length >= 20) break
    }
    return hits
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

  async readExportData(sessionId: string): Promise<ExportReadResult> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) return { kind: 'unavailable' }
    try {
      const raw = await persistence.readRaw(sessionId)
      if (raw === undefined) return { kind: 'none' }
      return { kind: 'found', data: { filename: raw.filename ?? sessionId, content: raw.content } }
    } catch (error) {
      // A REJECTED read (corrupt log, validation, I/O) is a real failure
      // with a diagnostic — never misclassified as 'no materialized log'.
      return { kind: 'error', message: safeErrorMessage(error) }
    }
  }
}
