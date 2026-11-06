/**
 * The Session Markdown domain port (S5-PR3 official Markdown export): the
 * narrow read-only semantic contract for ONE complete committed Session
 * transcript rendered by the official DSH formatter.
 *
 * The port is deliberately small — no formatter choice, descendants,
 * sourcePath, Client cwd, filename, progress or UI state. `sourcePath` is a
 * Host-internal formatter input, never a Client request parameter. The
 * `/export` ZIP Port stays a SEPARATE semantic capability; this port never
 * streams an archive and the archive port never renders Markdown.
 *
 * Direct resolves the official Host Session Query + persistence services
 * in-process; Remote maps the SAME port onto the official authenticated
 * `GET /api/session.markdown` route. The Client only writes the returned
 * bytes to a Client-selected file.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-markdown-port
 */

/** The outcome of reading one official Session Markdown transcript. */
export type SessionMarkdownReadResult =
  /** The complete official Markdown for the requested Session. */
  | { readonly kind: 'ready'; readonly markdown: string }
  /** The official Session Query proved the requested Session does not exist. */
  | { readonly kind: 'none' }
  /** The required official Markdown capability is not mounted/registered. */
  | { readonly kind: 'unavailable' }

/** The Session Markdown domain port: official complete committed Session
 * Markdown, read-only; never writes output. */
export interface SessionMarkdownPort {
  /**
   * Read one Session's complete official Markdown transcript.
   *
   * Contract:
   * - `ready` — the exact official Markdown text (never trimmed or
   *   re-serialized);
   * - `none` — the official Session Query explicitly proved the Session does
   *   not exist;
   * - `unavailable` — the necessary official service/route is explicitly
   *   absent;
   * - reject — cancellation, permission/auth, transport, untrusted or
   *   malformed response, or any other real failure (never collapsed to
   *   `none`/`unavailable`).
   *
   * Implementations honor caller cancellation: an aborted signal rejects
   * with an abort-shaped error.
   */
  read(sessionId: string, signal?: AbortSignal): Promise<SessionMarkdownReadResult>
}
