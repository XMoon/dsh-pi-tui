/**
 * The Remote session-archive adapter (M3-3B) — the official
 * `GET/HEAD /api/session.export` mapping of `SessionArchivePort` through the
 * COMPOSITION-OWNED fetch (never `document.baseURI`, never a server URL, and
 * never the Client filesystem).
 *
 * The port is unchanged: `ready {filename, stream}` / `unavailable` / `none`
 * / reject a real failure or caller abort. The upstream route is the
 * authority for BOTH the archive bytes and the filename
 * (`content-disposition`), so this adapter never invents a save path and never
 * buffers the archive: the returned `ReadableStream` is the live HTTP body and
 * the existing Client save UX (`src/app/command/artifacts.ts`) remains the sole
 * owner of the destination picker, the local output path and the
 * stream-to-file write.
 *
 * Why GET and not the reference HEAD-then-download: a browser hands the URL to
 * its download manager, so it needs a cheap readiness probe. A terminal client
 * must consume the body itself, so one GET is the single round trip and the
 * body doubles as the readiness evidence.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-archive-remote
 */

import type { SessionArchiveOpenResult, SessionArchivePort } from '../session-archive-port.ts'

/** The official absolute export path (`dsh-session-log-export` routes). */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/** The official browser-relative form the composition carrier resolves. */
export const SESSION_LOG_EXPORT_ROUTE = SESSION_LOG_EXPORT_PATH.slice(1)

/** The composition-owned Fetch port (the M3-1 in-process carrier's `fetch`). */
export interface RemoteArchiveFetch {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
}

/** Read the upstream-authoritative filename out of `content-disposition`. */
function filenameOfDisposition(disposition: string | null): string | undefined {
  if (disposition === null) return undefined
  // `attachment; filename="dsh-session-<id>.zip"` — the Host owns the
  // convention; this adapter only reads it back.
  const match = /filename="([^"]+)"/u.exec(disposition)
  if (match === null || match[1] === undefined || match[1] === '') return undefined
  return match[1]
}

/** The Remote `SessionArchivePort` over the composition-owned fetch. */
export class RemoteSessionArchive implements SessionArchivePort {
  private readonly fetchPort: RemoteArchiveFetch

  constructor(fetchPort: RemoteArchiveFetch) {
    this.fetchPort = fetchPort
  }

  async open(sessionId: string, signal?: AbortSignal): Promise<SessionArchiveOpenResult> {
    signal?.throwIfAborted()
    const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
    // The ABSOLUTE path, not the browser-relative route: the composition
    // carrier resolves the input against its own origin, and a leading slash
    // keeps that resolution independent of any base path.
    const route = `${SESSION_LOG_EXPORT_PATH}?${query.toString()}`
    const response = await this.fetchPort.fetch(route, { method: 'GET', ...signal === undefined ? {} : { signal } })
    // The official route classifies its own refusals: 404 = the root Session
    // is absent; 500 with the missing-services diagnostic = unavailable. Any
    // other non-OK status is a real failure, never collapsed to `none`.
    if (response.status === 404) {
      await response.body?.cancel()
      return { kind: 'none' }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const message = `session export failed: HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail.trim()}`}`
      if (response.status === 500 && /unavailable/u.test(detail)) return { kind: 'unavailable' }
      throw new Error(message)
    }
    const filename = filenameOfDisposition(response.headers.get('content-disposition'))
    if (filename === undefined || response.body === null) {
      // A ready response MUST carry both the upstream filename and the byte
      // stream; anything else is a wire-contract violation, and inventing a
      // name or an empty archive would falsify the save result.
      await response.body?.cancel()
      throw new Error('the session export response carried no filename or no body')
    }
    // The live body — never buffered Client-side. The caller's abort travels
    // through the same fetch signal, so an aborted stream errors instead of
    // producing a fake successful artifact.
    return { kind: 'ready', artifact: { filename, stream: response.body } }
  }
}
