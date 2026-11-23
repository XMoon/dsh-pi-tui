/**
 * The ONE private Owner-only HTTP adapter for the headless ACP CLI (PR-C).
 *
 * The Host already owns the ONLY local ACP runtime authority: the Host-entry
 * `AcpControlController` (`getStatus` / `setEnabled`) that owns the single
 * socket lifecycle. This module adds a short-lived transport entry beside the
 * existing identity, workspace-object, ACP-status and Web-control routes, not a
 * second ACP state machine, not a cache and not a second Host service. The
 * route is registered through the official `connection.fetch.register`, so an
 * unauthenticated/non-Owner request is refused by the official Connection
 * admission BEFORE this handler runs.
 *
 * ```text
 * CLI: POST /api/pi-tui.acp-control -> AcpControlController.setEnabled
 * ```
 *
 * The response never carries an `unavailable` reason, a socket path, a Cookie,
 * a profile path or an exception message: only the four-state vocabulary the
 * existing controller reports. The read-only observation keeps its own route
 * (`GET /api/pi-tui.acp-status`); this route exists only for the ONE explicit
 * management write.
 *
 * @module app/remote-process/local-acp-control-route
 */

import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'

/** The one Owner-only authenticated management route of the headless ACP CLI. */
export const LOCAL_ACP_CONTROL_ROUTE = '/api/pi-tui.acp-control'

/** Hard request-body bound; the POST body is a few dozen bytes. */
export const LOCAL_ACP_CONTROL_MAX_REQUEST_BYTES = 512

/** Hard response-body bound the CLI accepts. */
export const LOCAL_ACP_CONTROL_MAX_RESPONSE_BYTES = 4 * 1024

/** Bound on one CLI request after authentication has completed. */
export const LOCAL_ACP_CONTROL_TIMEOUT_MS = 10_000

/** The three public management verbs: `status` is the existing GET, these write. */
export type LocalAcpControlOp = 'enable' | 'disable'

/** The exact status vocabulary the route and the CLI share. */
export type LocalAcpControlState = 'enabled' | 'disabled' | 'changing' | 'unavailable'

/** Stable application error codes the route returns; never a Host message. */
export type LocalAcpControlRouteErrorCode =
  | 'ACP_INVALID_REQUEST'
  | 'ACP_INSTANCE_MISMATCH'
  | 'ACP_CLI_UNAVAILABLE'

/** The narrow ACP controller view this transport adapter borrows. */
export interface LocalAcpControlService {
  getStatus(): Promise<AcpAccessStatus>
  setEnabled(enabled: boolean): Promise<AcpAccessStatus>
}

/** One strictly parsed response body from the route. */
export type LocalAcpControlReply =
  | { readonly kind: 'state'; readonly instanceId: string; readonly state: LocalAcpControlState }
  | { readonly kind: 'error'; readonly error: LocalAcpControlRouteErrorCode }

/** The exact POST request body. */
interface LocalAcpControlRequestBody {
  readonly schema: 1
  readonly instanceId: string
  readonly op: LocalAcpControlOp
}

const STATE_VALUES: ReadonlySet<string> = new Set(['enabled', 'disabled', 'changing', 'unavailable'])
const ERROR_CODES: ReadonlySet<string> = new Set([
  'ACP_INVALID_REQUEST',
  'ACP_INSTANCE_MISMATCH',
  'ACP_CLI_UNAVAILABLE',
])
const OP_VALUES: ReadonlySet<string> = new Set(['enable', 'disable'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isErrorCode(value: unknown): value is LocalAcpControlRouteErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value)
}

function isState(value: unknown): value is LocalAcpControlState {
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

function errorResponse(error: LocalAcpControlRouteErrorCode, status: number): Response {
  return jsonResponse({ schema: 1, error }, status)
}

/**
 * Parse one strict route response body. Both the route tests and the CLI use
 * this ONE validator, so the wire shape cannot drift into two implementations.
 * @param text - the raw UTF-8 response body.
 * @returns the discriminated reply.
 */
export function parseLocalAcpControlReply(text: string): LocalAcpControlReply {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new TypeError('local acp control: the reply is not JSON')
  }
  if (!isRecord(value) || value.schema !== 1) {
    throw new TypeError('local acp control: the reply must be a schema-1 object')
  }
  if (hasExactKeys(value, ['schema', 'error'])) {
    if (!isErrorCode(value.error)) throw new TypeError('local acp control: unknown error code')
    return { kind: 'error', error: value.error }
  }
  if (hasExactKeys(value, ['schema', 'instanceId', 'state'])) {
    if (typeof value.instanceId !== 'string' || value.instanceId === '') {
      throw new TypeError('local acp control: the reply has no instance id')
    }
    if (!isState(value.state)) throw new TypeError('local acp control: unknown ACP state')
    return { kind: 'state', instanceId: value.instanceId, state: value.state }
  }
  throw new TypeError('local acp control: unexpected reply shape')
}

/** Parse the exact POST body; `undefined` means invalid input. */
function parseRequestBody(text: string): LocalAcpControlRequestBody | undefined {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'instanceId', 'op'])) return undefined
  if (value.schema !== 1 || typeof value.instanceId !== 'string' || value.instanceId === '') return undefined
  if (typeof value.op !== 'string' || !OP_VALUES.has(value.op)) return undefined
  return { schema: 1, instanceId: value.instanceId, op: value.op as LocalAcpControlOp }
}

/**
 * Build the ONE Host route handler. It answers only for the CURRENT Host
 * instance and calls the existing ACP runtime controller once per request.
 * @param instanceId - this Host's published instance id.
 * @param controller - the Host-entry-owned ACP runtime controller.
 * @returns the registered route's `fetch` callback.
 */
export function createLocalAcpControlHandler(
  instanceId: string,
  controller: LocalAcpControlService,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    // This route exists for ONE write. The read-only observation stays on the
    // existing GET /api/pi-tui.acp-status route.
    if (request.method !== 'POST') return errorResponse('ACP_INVALID_REQUEST', 405)

    const contentType = request.headers.get('content-type') ?? ''
    if (!/^application\/json\b/iu.test(contentType)) return errorResponse('ACP_INVALID_REQUEST', 415)
    const text = await readBoundedBody(request, LOCAL_ACP_CONTROL_MAX_REQUEST_BYTES)
    if (text === undefined) return errorResponse('ACP_INVALID_REQUEST', 400)
    const body = parseRequestBody(text)
    if (body === undefined) return errorResponse('ACP_INVALID_REQUEST', 400)
    // The instance check runs BEFORE any business side effect.
    if (body.instanceId !== instanceId) return errorResponse('ACP_INSTANCE_MISMATCH', 409)

    let status: AcpAccessStatus
    try {
      status = await controller.setEnabled(body.op === 'enable')
    } catch {
      // The mutation may have partially committed; the CLI reports UNKNOWN and
      // never retries. No exception text or state guess crosses the wire.
      return errorResponse('ACP_CLI_UNAVAILABLE', 503)
    }
    // The Host's `unavailable` reason is dropped; only the four-state
    // vocabulary crosses the wire.
    return jsonResponse({ schema: 1, instanceId, state: status.state })
  }
}
