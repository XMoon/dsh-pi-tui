/**
 * The Direct session-archive adapter (Pre-Stage-D export convergence): the
 * ONLY Direct Host archive adapter. It delegates to the public DSH Host
 * archive primitives (`@deepseek-ai/dsh-session-log-export`) — canonical
 * session-log serialization, lineage traversal, descendant flushing,
 * attachment reference scanning, image/file dedupe, generic-file streaming,
 * ZIP compression and backpressure — and never reproduces them. The upstream
 * plugin is NOT mounted (it requires `commands + connection`); only the
 * public primitives are consumed.
 *
 * Locality: the archive CONTENTS are Host-owned; the Client only streams the
 * produced bytes to a Client-selected destination. A future Remote adapter
 * maps the same port onto the official `GET/HEAD /api/session.export` stream.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-archive-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'
import type { SessionArchiveOpenResult, SessionArchivePort } from '../session-archive-port.ts'

/** The structural host context the archive adapter reads (only the export
 * deps resolver touches it — the same structural seam as the other Direct
 * adapters). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Direct `SessionArchivePort` adapter: public DSH Host archive
 * primitives over the composed host context. */
export class DirectSessionArchive implements SessionArchivePort {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  async open(sessionId: string, signal?: AbortSignal): Promise<SessionArchiveOpenResult> {
    signal?.throwIfAborted()
    // The upstream resolver reads only `ctx.get(...)`; the structural seam
    // keeps the adapter testable without a full Cordis Context.
    const deps = sessionLogExportDeps(this.ctx as unknown as Context)
    // The required composed services: session-query, persistence and
    // attachments. The live-session store stays optional (cold sessions
    // need no flush barrier).
    if (deps.sessionQuery === undefined
      || deps.sessionPersistence === undefined
      || deps.attachments === undefined) {
      return { kind: 'unavailable' }
    }
    const id = SessionId(sessionId)
    try {
      // Flush the live root through the store's durability barrier BEFORE
      // the committed read, so the archive includes the triggering command
      // lifecycle at the authoritative flushed cut.
      await flushLiveSessionLog(deps, id, signal)
      const rootContent = await readSessionLogText(deps.sessionPersistence, id, signal)
      signal?.throwIfAborted()
      // A missing root is `none`; a root read/flush failure is a real error
      // (the catch below rethrows — never collapsed to `none`).
      if (rootContent === undefined) return { kind: 'none' }
      const ready = {
        sessionQuery: deps.sessionQuery,
        sessionPersistence: deps.sessionPersistence,
        attachments: deps.attachments,
        sessions: deps.sessions,
      }
      return {
        kind: 'ready',
        artifact: {
          // The official DSH archive naming convention — never an invented
          // filename.
          filename: sessionLogZipFilename(sessionId),
          stream: streamSessionLogZip(
            ready,
            rootContent,
            id,
            true, // descendants: FIXED — the TUI contract is the full tree
            DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
            signal ?? new AbortController().signal,
          ),
        },
      }
    } catch (error) {
      // Cancellation, corruption, I/O, lineage, attachment, compressor or
      // other real failure: reject — never converted to `none`.
      throw error
    }
  }
}
