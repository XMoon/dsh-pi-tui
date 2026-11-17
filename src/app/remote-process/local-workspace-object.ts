/**
 * The Host-owned read-only directory-object observation route.
 *
 * The automatic Workspace proposal must prove that the authenticated Host
 * process sees the SAME directory object `(dev, ino)` the Client launched in.
 * Same path spelling is never evidence: only the Host's own `stat` proves the
 * Host filesystem view, and the route is reachable only through the official
 * Connection Owner admission (the exact Fetch route is registered with
 * `connection.fetch.register`, so a non-Owner request is refused before this
 * handler runs).
 *
 * The route is deliberately READ-ONLY: it never registers a Workspace, never
 * lists a directory, never creates a Session and never returns file content or
 * a path. It is not a general-purpose filesystem probe: the path is echoed
 * nowhere, and every failure is one stable HTTP status.
 *
 * @module app/remote-process/local-workspace-object
 */

import { statSync } from 'node:fs'

/** The exact Owner-only route path on the official local Connection. */
export const LOCAL_WORKSPACE_OBJECT_ROUTE = '/api/pi-tui.workspace-object'

/** Hard request-body bound (plan §7). */
export const MAX_WORKSPACE_OBJECT_REQUEST_BYTES = 8 * 1024
/** Hard absolute-path bound in UTF-8 bytes. */
export const MAX_WORKSPACE_OBJECT_PATH_BYTES = 4096
/** Hard response-body bound the Client accepts. */
export const MAX_WORKSPACE_OBJECT_RESPONSE_BYTES = 1024

/** One directory object as exact decimal strings (never JS `number`). */
export interface WorkspaceDirectoryObject {
  readonly device: string
  readonly inode: string
}

/** The strict positive response body. */
export interface WorkspaceObjectResponse extends WorkspaceDirectoryObject {
  readonly schema: 1
  readonly instanceId: string
}

/** The exact request keys. */
const REQUEST_KEYS = ['instanceId', 'path'] as const
/** The exact response keys. */
const RESPONSE_KEYS = ['schema', 'instanceId', 'device', 'inode'] as const

const DECIMAL = /^\d+$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Read at most `maxBytes` of a request body; an oversize body is rejected. */
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

/** The status-only failure: no path, host detail or system error crosses it. */
function failure(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } })
}

/** Validate one absolute path against the route's hard limits. */
function isBoundedAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return false
  if (!value.startsWith('/')) return false
  return Buffer.byteLength(value, 'utf8') <= MAX_WORKSPACE_OBJECT_PATH_BYTES
}

/**
 * Build the ONE Host route handler. It answers only for the CURRENT Host
 * instance and only for a directory the Host itself can `stat`; the returned
 * `(dev, ino)` are exact decimal strings, so a 64-bit inode is never truncated
 * by JS number precision.
 */
export function createWorkspaceObjectHandler(
  currentInstanceId: string,
  statDirectory: (path: string) => { isDirectory(): boolean; readonly dev: string; readonly ino: string } = defaultStatDirectory,
): (request: Request) => Promise<Response> {
  return async request => {
    if (request.method !== 'POST') return failure(405)
    const contentType = request.headers.get('content-type') ?? ''
    if (!/^application\/json\b/iu.test(contentType)) return failure(400)
    const text = await readBoundedBody(request, MAX_WORKSPACE_OBJECT_REQUEST_BYTES)
    if (text === undefined) return failure(413)
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      return failure(400)
    }
    if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return failure(400)
    if (value.instanceId !== currentInstanceId || !UUID_PATTERN.test(currentInstanceId)) return failure(409)
    if (!isBoundedAbsolutePath(value.path)) return failure(400)
    let directory: ReturnType<typeof statDirectory>
    try {
      directory = statDirectory(value.path)
    } catch {
      // An unreadable/nonexistent/replaced path is "no observation", never a
      // fabricated default directory.
      return failure(404)
    }
    if (!directory.isDirectory()) return failure(404)
    return jsonResponse({
      schema: 1,
      instanceId: currentInstanceId,
      device: directory.dev,
      inode: directory.ino,
    } satisfies WorkspaceObjectResponse)
  }
}

/** The production directory observation: exact `bigint` stat converted to
 *  decimal strings. `realpath` is deliberately NOT used: the object identity
 *  is the one the Host sees at the requested absolute path. */
function defaultStatDirectory(path: string): { isDirectory(): boolean; readonly dev: string; readonly ino: string } {
  const stat = statSync(path, { bigint: true })
  return {
    isDirectory: () => stat.isDirectory(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  }
}

/**
 * Ask the authenticated Host for its view of one absolute directory path.
 * Every failure — transport, non-200, malformed/oversized body, wrong instance
 * or non-decimal object — is an explicit `unverified`; a successful response is
 * only an observation, never a WorkspaceId or permission.
 */
export async function observeHostWorkspaceObject(
  fetchAuthenticated: (input: string | URL, init?: RequestInit) => Promise<Response>,
  origin: string,
  instanceId: string,
  path: string,
): Promise<{ readonly kind: 'observed'; readonly device: string; readonly inode: string } | { readonly kind: 'unverified'; readonly reason: string }> {
  let response: Response
  try {
    response = await fetchAuthenticated(`${origin}${LOCAL_WORKSPACE_OBJECT_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId, path }),
    })
  } catch {
    return { kind: 'unverified', reason: 'the Host workspace object route is unreachable' }
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    return { kind: 'unverified', reason: `the Host workspace object route answered HTTP ${String(response.status)}` }
  }
  const contentType = response.headers.get('content-type') ?? ''
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (!/^application\/json\b/iu.test(contentType) || !/\bno-store\b/iu.test(cacheControl)) {
    await response.body?.cancel()
    return { kind: 'unverified', reason: 'the Host workspace object response has the wrong shape' }
  }
  let text: string
  try {
    text = await readResponseText(response, MAX_WORKSPACE_OBJECT_RESPONSE_BYTES)
  } catch {
    return { kind: 'unverified', reason: 'the Host workspace object response exceeds its bound' }
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { kind: 'unverified', reason: 'the Host workspace object response is not JSON' }
  }
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    return { kind: 'unverified', reason: 'the Host workspace object response has unexpected fields' }
  }
  if (value.schema !== 1 || value.instanceId !== instanceId) {
    return { kind: 'unverified', reason: 'the Host workspace object response names another instance or schema' }
  }
  if (typeof value.device !== 'string' || !DECIMAL.test(value.device)
    || typeof value.inode !== 'string' || !DECIMAL.test(value.inode)) {
    return { kind: 'unverified', reason: 'the Host workspace object response is not an exact decimal object' }
  }
  return { kind: 'observed', device: value.device, inode: value.inode }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('local workspace object: response exceeds its bound')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}
