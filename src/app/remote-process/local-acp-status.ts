/**
 * M6 Daemon × ACP (PO-5D): the ONE read-only, authenticated observation of the
 * running Host's local ACP v1 listener.
 *
 * The Host entry already owns the single runtime ACP controller and the
 * authenticated loopback carrier. This module adds NO second ACP service and no
 * second owner: the Host registers ONE additional Owner-only GET route beside
 * the identity echo / workspace-object observation, and the existing headless
 * `daemon status` reader consumes it with its own signed Cookie.
 *
 * ```text
 * Controller.getStatus() → GET /api/pi-tui.acp-status → daemon status
 * ```
 *
 * The route answers exactly one live read per request and never mutates, caches,
 * or reflects a path/token. The observer treats every unprovable outcome
 * (non-200, wrong media type, oversized body, instance mismatch, malformed DTO,
 * timeout, transport failure) as `undefined` so the CLI can report the truthful
 * `unavailable` — never a guessed `disabled`.
 *
 * @module app/remote-process/local-acp-status
 */

import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'
import {
  parsePiTuiAcpAccessStatus,
  type PiTuiAcpAccessStatus,
} from '../../runtime/remote/pi-tui-acp-access-contract.ts'
import type { VerifiedLocalHost } from './local-discovery.ts'

/** The one Owner-only authenticated route of the live ACP status observation. */
export const LOCAL_ACP_STATUS_ROUTE = '/api/pi-tui.acp-status'

/** Hard cap on the status response body; the DTO is a few hundred bytes. */
const LOCAL_ACP_STATUS_MAX_BYTES = 1024
/** Bound on the one observation request. */
const LOCAL_ACP_STATUS_TIMEOUT_MS = 3_000

/** The small structural controller view the route serves (never the entry type). */
export interface LocalAcpStatusSource {
  getStatus(): Promise<AcpAccessStatus>
}

/** The exact JSON body the route returns; the state rides the existing DTO. */
export interface LocalAcpStatusPayload {
  readonly schema: 1
  readonly instanceId: string
  readonly status: PiTuiAcpAccessStatus
}

/**
 * The route handler. It is registered under the official Connection Owner's
 * authenticated admission (the SAME owner as the identity echo), so an
 * unauthenticated request is refused BEFORE this handler. It reads the live
 * controller ONCE and performs no mutation.
 *
 * @param instanceId - this Host's published instance id (the observer's echo).
 * @param controller - the Host-entry-owned runtime ACP controller.
 * @returns the registered route's `fetch` callback.
 */
export function createLocalAcpStatusHandler(
  instanceId: string,
  controller: LocalAcpStatusSource,
): (request: Request) => Promise<Response> {
  return async () => {
    const status = await controller.getStatus()
    const payload: LocalAcpStatusPayload = { schema: 1, instanceId, status }
    return Response.json(payload, {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    })
  }
}

/** Drain the body within the byte cap; an oversized/unreadable body is absent. */
async function readBoundedBody(response: Response): Promise<string | undefined> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > LOCAL_ACP_STATUS_MAX_BYTES) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

/** Cancel an unread body without observing it. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A body that cannot be cancelled owns no decision.
  }
}

/** Node's `RequestInit` omits the cache mode; the authenticated read is no-store. */
type LocalRequestInit = RequestInit & { readonly cache?: 'no-store' }

/**
 * Observe the running Host's live ACP listener status through the authenticated
 * read-only route. This is the ONLY headless observation; it never creates a
 * controller, never calls `setEnabled`, and never caches the result.
 *
 * Every external-boundary failure category is `undefined` (the caller's
 * `unavailable`), including an instance id that does not match the Host the
 * Cookie was issued for: a response from a replaced/foreign Host can never be
 * attributed to this observation.
 *
 * @param verified - the already authenticated Host record and in-memory cookie.
 * @returns the validated live listener status, or `undefined` when unprovable.
 */
export async function observeAuthenticatedLocalAcpStatus(
  verified: VerifiedLocalHost,
): Promise<PiTuiAcpAccessStatus | undefined> {
  const request: LocalRequestInit = {
    method: 'GET',
    headers: { cookie: verified.cookie },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(LOCAL_ACP_STATUS_TIMEOUT_MS),
  }
  let response: Response
  try {
    response = await fetch(`${verified.record.origin}${LOCAL_ACP_STATUS_ROUTE}`, request)
  } catch {
    return undefined
  }
  if (response.status !== 200) {
    await discard(response)
    return undefined
  }
  const contentType = response.headers.get('content-type') ?? ''
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (!/^application\/json\b/iu.test(contentType) || !/\bno-store\b/iu.test(cacheControl)) {
    await discard(response)
    return undefined
  }
  const text = await readBoundedBody(response)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.length !== 3
    || record.schema !== 1
    || typeof record.instanceId !== 'string'
    || record.instanceId !== verified.identity.instanceId
  ) {
    return undefined
  }
  try {
    return parsePiTuiAcpAccessStatus(record.status)
  } catch {
    return undefined
  }
}
