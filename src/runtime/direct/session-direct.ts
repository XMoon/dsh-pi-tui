/**
 * The Direct session reader (M1.3) — the in-process implementation of
 * `SessionReader` over the dsh `sessionPersistence` / `sessionQuery` /
 * `sessionTitle` services. This is the ONLY module in the session-read
 * path that touches `ctx`; the consumer (commands.ts) depends on the port,
 * and a Remote adapter will implement the same interface in a later
 * milestone.
 *
 * The domain semantics live here: live-preferred listing with the
 * persistence fallback, the bounded content search, and the cached title
 * batches (the pure helpers in src/sessions.ts stay the shared core).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-direct
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { dshHome } from '../../diag.ts'
import { isUnsupportedSessionFormatError, loadSessionTitleBatch, type SessionEventSearchDocumentLike, type SessionPickerPersistence, type SessionQueryLike, type TitleDiagLike } from '../../sessions.ts'
import { recordedSessionPreset, sessionPresetOf } from './session-preset-direct.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { ExportReadResult, SessionSearchHit, SessionReader, SessionSummary } from '../session-reader-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The structural `sessionPersistence` surface the reader needs. */
export interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<Array<{ id: string; createdAt: number; version: number; cwd?: string; agentPreset?: string; parentSession?: string; origin?: 'subagent' }>>
  readRaw(id: string): Promise<{ content: string; filename?: string } | undefined>
  /** The fallback title path's per-session event inspection. */
  inspect: SessionPickerPersistence['inspect']
}

/** The structural `tokenMeter` surface the reader needs. */
export interface TokenMeterLike {
  measure(session: unknown): { totalTokens: number }
}

/** A live agent as the reader resolves it (structural projection). */
export interface LiveAgentLike {
  readonly session: Session
}

/** Keep cold-session projection reads below the persistence engine's own small
 * inspection batch size. This bounds log replay/FD/memory pressure when the
 * picker contains many historical sessions. */
export const SESSION_PRESET_READ_CONCURRENCY = 4

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      // Claiming the next item is synchronous after this check, so a worker
      // that observes cancellation never starts another cold projection read.
      signal?.throwIfAborted()
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index]!, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()),
  )
  return results
}

/** Read a typed query-service error without depending on its package surface. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Make one semantic event document suitable for the existing search port. */
function semanticSnippet(document: SessionEventSearchDocumentLike, query: string): string {
  const text = document.text.replace(/\s+/g, ' ').trim()
  const needle = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const index = text.toLowerCase().indexOf(needle)
  if (index < 0) return text.slice(0, 120)
  const start = Math.max(0, index - 40)
  return text.slice(start, index + needle.length + 40).trim()
}

/** The Direct backend's session reader: `ctx` services behind the semantic
 * `SessionReader` interface. */
export class DirectSessionReader implements SessionReader {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined
  private readonly diag: TitleDiagLike | undefined

  constructor(
    ctx: HostContextLike,
    agentFor?: (sessionId: string) => unknown | undefined,
    diag?: TitleDiagLike,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor ?? (() => undefined)
    this.diag = diag
  }

  private liveAgent(sessionId: string): LiveAgentLike | undefined {
    return this.agentFor(sessionId) as LiveAgentLike | undefined
  }

  /**
   * Resolve the effective preset for a row through DSH's projection. A
   * projectionless deployment cannot claim that creation metadata is the
   * current composition, so it reports no effective preset instead.
   */
  private async presetFor(header: SessionHeader, signal?: AbortSignal): Promise<string | undefined> {
    const projections = this.ctx.get('sessionProjections')
    if (projections === undefined) return undefined

    const sessionId = String(header.id)
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return sessionPresetOf(this.ctx, live.session)

    if (this.ctx.get('sessionPersistence') !== undefined) {
      return recordedSessionPreset(this.ctx, sessionId, header, signal)
    }
    return undefined
  }

  async list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    signal?.throwIfAborted()
    let rows: SessionSummary[]
    if (query !== undefined) {
      // Live-preferred listing: the session-query engine marks sessions
      // currently loaded in the store. Resolve each row's effective preset
      // separately because listSessions exposes the creation header, not the
      // latest `agent-preset/selected` projection state.
      const records = await query.listSessions(signal)
      signal?.throwIfAborted()
      rows = await mapConcurrent(records, SESSION_PRESET_READ_CONCURRENCY, async record => ({
        id: record.header.id,
        createdAt: record.header.createdAt,
        cwd: record.header.cwd,
        preset: await this.presetFor(record.header, signal),
        parentSession: record.header.parentSession,
        origin: record.header.origin,
        live: record.live,
      }), signal)
    } else {
      if (persistence === undefined) return undefined
      // Persistence fallback: the plain list; the current session is the
      // only live marker. The known header is passed into presetFor so the
      // projection path does not repeat the list query.
      const headers = await persistence.list(signal)
      signal?.throwIfAborted()
      rows = await mapConcurrent(headers, SESSION_PRESET_READ_CONCURRENCY, async header => ({
        id: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd,
        preset: await this.presetFor(header as SessionHeader, signal),
        parentSession: header.parentSession,
        origin: header.origin,
        live: header.id === currentSessionId,
      }), signal)
    }
    signal?.throwIfAborted()
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }

  async search(query: string): Promise<SessionSearchHit[] | undefined> {
    const searchText = query.trim()
    if (searchText === '') return []

    const sessionQuery = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (sessionQuery?.filterEvents !== undefined) {
      // `searchSessions` is intentionally disabled by the shipped SQLite
      // composition (`openAt: never`). `filterEvents` remains the public,
      // backend-independent semantic text seam, so use it over the query
      // engine's live-preferred corpus rather than scanning raw JSONL.
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

  titles(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, string>> {
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    return loadSessionTitleBatch(query, persistence, dshHome(process.env), rows, signal, this.diag)
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
