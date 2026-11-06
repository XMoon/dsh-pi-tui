/**
 * The Remote Session Markdown adapter (S5-PR3 official Markdown export): the
 * official authenticated `GET /api/session.markdown` mapping of
 * `SessionMarkdownPort` through the COMPOSITION-OWNED fetch (never
 * `document.baseURI`, never a server URL, never a hand-built auth token, and
 * never the Client filesystem).
 *
 * The port is unchanged: `ready {markdown}` / `unavailable` / `none` / reject
 * a real failure or caller abort. The upstream route is the authority for the
 * bytes and for its own refusal vocabulary, so this adapter never rewrites,
 * trims, recodes or fabricates Markdown and never turns an untrusted response
 * into a business result:
 *
 * - 200 with the official `text/markdown` type and a non-empty body → `ready`;
 * - 404 carrying the official `session not found` body → `none`;
 * - any other 404 (unknown route / non-official body) → `unavailable`;
 * - 500 carrying the official missing-session-query body → `unavailable`;
 * - 401/403 → reject (permission/auth, never "Session missing");
 * - any other status, a wrong content type, or an empty 200 body → reject.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-markdown-remote
 */

import type { SessionMarkdownReadResult, SessionMarkdownPort } from '../session-markdown-port.ts'

/** The official absolute Markdown export path (`dsh-session-log-export` routes;
 * the package root does not re-export this constant). */
export const SESSION_MARKDOWN_EXPORT_PATH = '/api/session.markdown'

/** The official stable "Session absent" refusal body. */
const SESSION_NOT_FOUND_BODY = 'session not found'

/** The official stable "capability absent" refusal body. */
const MISSING_SERVICE_BODY = 'session markdown export is unavailable: missing session-query service'

/** The official success media type (a charset parameter is allowed). */
const MARKDOWN_CONTENT_TYPE = /^text\/markdown(?:\s*;\s*charset=[^;]+)?$/iu

/** The composition-owned Fetch port (the M3-1 in-process carrier's `fetch` or
 * the B1 authenticated Cookie carrier — the SAME carrier every Remote
 * adapter consumes). */
export interface RemoteMarkdownFetch {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
}

/** The Remote `SessionMarkdownPort` over the composition-owned fetch. */
export class RemoteSessionMarkdown implements SessionMarkdownPort {
  private readonly fetchPort: RemoteMarkdownFetch

  constructor(fetchPort: RemoteMarkdownFetch) {
    this.fetchPort = fetchPort
  }

  async read(sessionId: string, signal?: AbortSignal): Promise<SessionMarkdownReadResult> {
    signal?.throwIfAborted()
    const query = new URLSearchParams({ sessionId })
    // The ABSOLUTE path, like the archive adapter: the composition carrier
    // resolves it against its own origin, never a caller-supplied base.
    const route = `${SESSION_MARKDOWN_EXPORT_PATH}?${query.toString()}`
    const response = await this.fetchPort.fetch(route, {
      method: 'GET',
      ...signal === undefined ? {} : { signal },
    })
    if (response.status === 200) {
      const contentType = response.headers.get('content-type')
      if (contentType === null || !MARKDOWN_CONTENT_TYPE.test(contentType.trim())) {
        await response.body?.cancel()
        throw new Error(`session markdown export returned an unexpected content type: ${contentType ?? '(none)'}`)
      }
      const markdown = await response.text()
      if (markdown === '') {
        throw new Error('session markdown export returned an empty body')
      }
      return { kind: 'ready', markdown }
    }
    if (response.status === 404) {
      // The official route answers a missing Session with one stable body; an
      // unregistered/unknown 404 is the route being unavailable, never the
      // Session missing.
      const body = await response.text()
      return body.trim() === SESSION_NOT_FOUND_BODY ? { kind: 'none' } : { kind: 'unavailable' }
    }
    if (response.status === 401 || response.status === 403) {
      // Auth/permission is a real failure — never `none`, never `unavailable`.
      await response.body?.cancel()
      throw new Error(`session markdown export was refused: HTTP ${String(response.status)}`)
    }
    if (response.status === 500) {
      const body = await response.text()
      if (body.trim() === MISSING_SERVICE_BODY) return { kind: 'unavailable' }
      throw new Error(`session markdown export failed: HTTP 500 ${body.trim()}`)
    }
    await response.body?.cancel()
    throw new Error(`session markdown export failed: HTTP ${String(response.status)}`)
  }
}
