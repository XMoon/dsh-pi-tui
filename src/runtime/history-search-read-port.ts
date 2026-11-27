/**
 * The narrow Remote accepted-history read seam.
 *
 * It is the transport-neutral shape the application presentation bundle exposes
 * to the Client-local search owner: two strict wire requests and the Host's own
 * typed answer unions. It names no Client object, no transport and no Host
 * service, so `app/**` can carry the capability without importing the Remote
 * implementation.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/history-search-read-port
 */

import type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySessionRecallRequest,
  HistorySessionRecallResponse,
} from './history-search-dto.ts'

export interface HistorySearchReadPort {
  search(request: HistorySearchRequest, signal: AbortSignal): Promise<HistorySearchResponse>
  readText(request: HistoryReadTextRequest, signal: AbortSignal): Promise<HistoryReadTextResponse>
  /** ONE bounded session-scoped recall read; no query, cursor or caller limit. */
  readSessionRecall(
    request: HistorySessionRecallRequest,
    signal: AbortSignal,
  ): Promise<HistorySessionRecallResponse>
}
