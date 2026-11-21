/**
 * The ONE private Owner-only HTTP adapter for the headless Web CLI (M6 Web CLI).
 *
 * The Host already owns the ONLY Web business authority: the live
 * `PiTuiWebAccessHostService` (`getStatus` / `setEnabled` / `getAuthenticatedUrl`).
 * This module adds a short-lived transport entry beside the existing identity,
 * workspace-object and ACP-status routes, not a second Web state machine, not a
 * cache and not a second Host service. The route is registered through the
 * official `connection.fetch.register`, so an unauthenticated/non-Owner request
 * is refused by the official Connection admission BEFORE this handler runs.
 *
 * ```text
 * CLI: GET/POST /api/pi-tui.web-control -> PiTuiWebAccessHostService
 * ```
 *
 * The response never carries an `unavailable` reason, a Cookie, a profile path
 * or an exception message. `web url` is the ONE explicit action allowed to
 * receive the authenticated URL; the value is produced by the existing Host
 * method and is never stored here.
 *
 * @module app/remote-process/local-web-control-route
 */

import type {
  PiTuiWebAccessAuthenticatedUrl,
  PiTuiWebAccessStatus,
} from '../../runtime/remote/pi-tui-web-access-contract.ts'

/** The one Owner-only authenticated route of the headless Web CLI. */
export const LOCAL_WEB_CONTROL_ROUTE = '/api/pi-tui.web-control'

/** Hard request-body bound; the POST body is a few dozen bytes. */
export const LOCAL_WEB_CONTROL_MAX_REQUEST_BYTES = 512

/** Hard response-body bound the CLI accepts. */
export const LOCAL_WEB_CONTROL_MAX_RESPONSE_BYTES = 4 * 1024

/** Bound on one CLI request after authentication has completed. */
export const LOCAL_WEB_CONTROL_TIMEOUT_MS = 10_000

/** The five public verbs share exactly three wire operations (`open` is local). */
export type LocalWebControlOp = 'enable' | 'disable' | 'url'

/** The exact status vocabulary the route and the CLI share. */
export type LocalWebControlState = 'enabled' | 'disabled' | 'changing' | 'unavailable'

/** Stable application error codes the route returns; never a Host message. */
export type LocalWebControlErrorCode =
  | 'WEB_INVALID_REQUEST'
  | 'WEB_INSTANCE_MISMATCH'
  | 'WEB_DISABLED'
  | 'WEB_CHANGING'
  | 'WEB_CLI_UNAVAILABLE'

/** The narrow Web service view this transport adapter borrows. */
export interface LocalWebControlService {
  getStatus(): Promise<PiTuiWebAccessStatus>
  setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus>
  getAuthenticatedUrl(): Promise<PiTuiWebAccessAuthenticatedUrl>
}

/** One strictly parsed response body from the route. */
export type LocalWebControlReply =
  | { readonly kind: 'state'; readonly instanceId: string; readonly state: LocalWebControlState }
  | { readonly kind: 'url'; readonly instanceId: string; readonly url: string }
  | { readonly kind: 'error'; readonly error: LocalWebControlErrorCode }

/** The exact POST request body. */
interface LocalWebControlRequestBody {
  readonly schema: 1
  readonly instanceId: string
  readonly op: LocalWebControlOp
}

const STATE_VALUES: ReadonlySet<string> = new Set(['enabled', 'disabled', 'changing', 'unavailable'])
const ERROR_CODES: ReadonlySet<string> = new Set([
  'WEB_INVALID_REQUEST',
  'WEB_INSTANCE_MISMATCH',
  'WEB_DISABLED',
  'WEB_CHANGING',
  'WEB_CLI_UNAVAILABLE',
])
const OP_VALUES: ReadonlySet<string> = new Set(['enable', 'disable', 'url'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isErrorCode(value: unknown): value is LocalWebControlErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value)
}

function isState(value: unknown): value is LocalWebControlState {
  return typeof value === 'string' && STATE_VALUES.has(value)
}

/** Read at most `maxBytes`; an oversize or unreadable body is `undefined`. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) return undefined
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
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

/** The fixed response headers for every route reply, success or failure. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

function errorResponse(error: LocalWebControlErrorCode, status: number): Response {
  return jsonResponse({ schema: 1, error }, status)
}

/**
 * Parse one strict route response body. Both the route tests and the CLI use
 * this ONE validator, so the wire shape cannot drift into two implementations.
 * @param text - the raw UTF-8 response body.
 * @returns the discriminated reply.
 */
export function parseLocalWebControlReply(text: string): LocalWebControlReply {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new TypeError('local web control: the reply is not JSON')
  }
  if (!isRecord(value) || value.schema !== 1) {
    throw new TypeError('local web control: the reply must be a schema-1 object')
  }
  if (hasExactKeys(value, ['schema', 'error'])) {
    if (!isErrorCode(value.error)) throw new TypeError('local web control: unknown error code')
    return { kind: 'error', error: value.error }
  }
  if (hasExactKeys(value, ['schema', 'instanceId', 'state'])) {
    if (typeof value.instanceId !== 'string' || value.instanceId === '') {
      throw new TypeError('local web control: the reply has no instance id')
    }
    if (!isState(value.state)) throw new TypeError('local web control: unknown Web state')
    return { kind: 'state', instanceId: value.instanceId, state: value.state }
  }
  if (hasExactKeys(value, ['schema', 'instanceId', 'url'])) {
    if (typeof value.instanceId !== 'string' || value.instanceId === '') {
      throw new TypeError('local web control: the reply has no instance id')
    }
    if (typeof value.url !== 'string' || value.url === '') {
      throw new TypeError('local web control: the reply has no URL')
    }
    return { kind: 'url', instanceId: value.instanceId, url: value.url }
  }
  throw new TypeError('local web control: unexpected reply shape')
}

/** Parse the exact POST body; `undefined` means invalid input. */
function parseRequestBody(text: string): LocalWebControlRequestBody | undefined {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'instanceId', 'op'])) return undefined
  if (value.schema !== 1 || typeof value.instanceId !== 'string' || value.instanceId === '') return undefined
  if (typeof value.op !== 'string' || !OP_VALUES.has(value.op)) return undefined
  return { schema: 1, instanceId: value.instanceId, op: value.op as LocalWebControlOp }
}

/**
 * Build the ONE Host route handler. It answers only for the CURRENT Host
 * instance and calls the existing Web authority once per request.
 * @param instanceId - this Host's published instance id.
 * @param webAccess - the Host-entry-owned Web access service.
 * @returns the registered route's `fetch` callback.
 */
export function createLocalWebControlHandler(
  instanceId: string,
  webAccess: LocalWebControlService,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') {
      let status: PiTuiWebAccessStatus
      try {
        status = await webAccess.getStatus()
      } catch {
        return errorResponse('WEB_CLI_UNAVAILABLE', 503)
      }
      return jsonResponse({ schema: 1, instanceId, state: status.state })
    }
    if (request.method !== 'POST') return errorResponse('WEB_INVALID_REQUEST', 405)

    const contentType = request.headers.get('content-type') ?? ''
    if (!/^application\/json\b/iu.test(contentType)) return errorResponse('WEB_INVALID_REQUEST', 415)
    const text = await readBoundedBody(request, LOCAL_WEB_CONTROL_MAX_REQUEST_BYTES)
    if (text === undefined) return errorResponse('WEB_INVALID_REQUEST', 400)
    const body = parseRequestBody(text)
    if (body === undefined) return errorResponse('WEB_INVALID_REQUEST', 400)
    // The instance check runs BEFORE any business side effect.
    if (body.instanceId !== instanceId) return errorResponse('WEB_INSTANCE_MISMATCH', 409)

    if (body.op === 'enable' || body.op === 'disable') {
      let status: PiTuiWebAccessStatus
      try {
        status = await webAccess.setEnabled(body.op === 'enable')
      } catch {
        // The mutation may have partially committed; the CLI reports UNKNOWN and
        // never retries. No exception text or state guess crosses the wire.
        return errorResponse('WEB_CLI_UNAVAILABLE', 503)
      }
      return jsonResponse({ schema: 1, instanceId, state: status.state })
    }

    // `url` is read-only. Read the live state first so a disabled/changing Host
    // answers with its exact fixed code instead of an opaque exception message.
    let status: PiTuiWebAccessStatus
    try {
      status = await webAccess.getStatus()
    } catch {
      return errorResponse('WEB_CLI_UNAVAILABLE', 503)
    }
    if (status.state === 'disabled') return jsonResponse({ schema: 1, error: 'WEB_DISABLED' })
    if (status.state === 'changing') return jsonResponse({ schema: 1, error: 'WEB_CHANGING' })
    if (status.state === 'unavailable') return errorResponse('WEB_CLI_UNAVAILABLE', 503)
    let result: PiTuiWebAccessAuthenticatedUrl
    try {
      result = await webAccess.getAuthenticatedUrl()
    } catch {
      return errorResponse('WEB_CLI_UNAVAILABLE', 503)
    }
    return jsonResponse({ schema: 1, instanceId, url: result.url })
  }
}
