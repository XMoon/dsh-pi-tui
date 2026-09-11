/**
 * The session ARCHIVE domain port (Pre-Stage-D export convergence): the
 * narrow semantic contract for one complete Session-tree archive stream.
 * The port is deliberately small — no descendants/compression options (the
 * TUI always exports the full tree), no output path, no Client cwd, no save
 * callbacks, no progress, no TUI objects, no Connection/URL. A future
 * Remote adapter maps the SAME port onto the official DSH Connection
 * `GET/HEAD /api/session.export` stream; the Client save UX never changes.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-archive-port
 */

/** One complete archive artifact: the fixed filename plus the byte stream. */
export interface SessionArchiveArtifact {
  /** The fixed archive filename (upstream-authoritative naming). */
  readonly filename: string
  /** The complete archive byte stream (never buffered Client-side). */
  readonly stream: ReadableStream<Uint8Array>
}

/** The outcome of opening one archive, or WHY it cannot be opened (the
 * failure kinds are distinct — the Host archive services may be absent, the
 * root Session may be absent, or the open may fail with a real error). */
export type SessionArchiveOpenResult =
  | { readonly kind: 'ready'; readonly artifact: SessionArchiveArtifact }
  /** The required Host archive services are not mounted. */
  | { readonly kind: 'unavailable' }
  /** The root Session is absent. */
  | { readonly kind: 'none' }

/** The session ARCHIVE domain port: one complete Session-tree archive for
 * the requested root Session (descendants + attachments included — the TUI
 * contract is full tree, so `includeDescendants` is not configurable here). */
export interface SessionArchivePort {
  /**
   * Open the complete archive stream for one root Session.
   *
   * Contract:
   * - `ready` — a complete archive stream for the requested root Session;
   * - `unavailable` — the required Host archive services are not mounted;
   * - `none` — the root Session is absent;
   * - reject — cancellation, corruption, I/O, lineage, attachment,
   *   compressor, or other real failure (never collapsed to `none`).
   *
   * Implementations must honor caller cancellation: an aborted signal
   * rejects with an abort-shaped error.
   */
  open(sessionId: string, signal?: AbortSignal): Promise<SessionArchiveOpenResult>
}
