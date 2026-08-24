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

import { dshHome } from '../../diag.ts'
import { loadSessionTitleBatch, type SessionPickerPersistence, type SessionQueryLike } from '../../sessions.ts'
import type { SessionSearchHit, SessionReader, SessionSummary } from '../session-reader-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The structural `sessionPersistence` surface the reader needs. */
export interface SessionPersistenceLike {
  list(): Promise<Array<{ id: string; createdAt: number; version: number; cwd?: string; agentPreset?: string; parentSession?: string; origin?: 'subagent' }>>
  readRaw(id: string): Promise<{ content: string } | undefined>
  /** The fallback title path's per-session event inspection. */
  inspect: SessionPickerPersistence['inspect']
}

/** The Direct backend's session reader: `ctx` services behind the semantic
 * `SessionReader` interface. */
export class DirectSessionReader implements SessionReader {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  async list(currentSessionId: string | undefined): Promise<SessionSummary[] | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) return undefined
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    let rows: SessionSummary[]
    if (query !== undefined) {
      // Live-preferred listing: the session-query engine marks sessions
      // currently loaded in the store.
      rows = (await query.listSessions()).map(record => ({
        id: record.header.id,
        createdAt: record.header.createdAt,
        cwd: record.header.cwd,
        preset: record.header.agentPreset,
        parentSession: record.header.parentSession,
        origin: record.header.origin,
        live: record.live,
      }))
    } else {
      // Persistence fallback: the plain list; the current session is the
      // only live marker.
      rows = (await persistence.list()).map(header => ({
        id: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd,
        preset: header.agentPreset,
        parentSession: header.parentSession,
        origin: header.origin,
        live: header.id === currentSessionId,
      }))
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }

  async search(query: string): Promise<SessionSearchHit[] | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) return undefined
    const needle = query.toLowerCase()
    const headers = (await persistence.list())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
    const hits: SessionSearchHit[] = []
    for (const header of headers) {
      let raw: { content: string } | undefined
      try {
        raw = await persistence.readRaw(header.id)
      } catch {
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
    return loadSessionTitleBatch(query, persistence, dshHome(process.env), rows, signal)
  }
}
