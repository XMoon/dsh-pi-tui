/**
 * The private `piTuiHistorySearch` Remote contract: the ONE semantic owner of
 * the Host accepted-input history search wire surface.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiHistorySearch/search
 * endpoint   @xmoon76/dsh-pi-tui#piTuiHistorySearch/readText
 * service    piTuiHistorySearch   (Host Cordis service key)
 * namespace  piTuiHistorySearch   (wire namespace)
 * method     search(request, signal)    -> ready | loading | incomplete | unavailable | stale
 * method     readText(request, signal)  -> ready | loading | incomplete | unavailable
 * ```
 *
 * The wire is deliberately small and strict: three exact scopes, a literal
 * substring query, a keyset cursor, and a chunked exact-text read keyed by the
 * immutable content hash. It never carries a profile path, a raw Session
 * event, an official object, a principal or a replay credential.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-history-search-contract
 */

import { createHash } from 'node:crypto'
import type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchIncompleteReason,
  HistorySearchItem,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchScope,
  HistorySearchUnavailableReason,
  HistoryReadTextUnavailableReason,
} from '../history-search-dto.ts'

export type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchIncompleteReason,
  HistorySearchItem,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchScope,
  HistorySearchUnavailableReason,
  HistoryReadTextUnavailableReason,
} from '../history-search-dto.ts'
import {
  HISTORY_SEARCH_LIMIT_MAX,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  HISTORY_SEARCH_READ_TEXT_LIMIT_MAX,
} from '../history-search-limits.ts'

export {
  HISTORY_SEARCH_LIMIT_MAX,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  HISTORY_SEARCH_READ_TEXT_LIMIT_MAX,
} from '../history-search-limits.ts'
import { isAbsolute } from 'node:path'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_HISTORY_SEARCH_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private service. */
export const PI_TUI_HISTORY_SEARCH_NAMESPACE = 'piTuiHistorySearch'

/** The search endpoint's stable identity. */
export const PI_TUI_HISTORY_SEARCH_SEARCH_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiHistorySearch/search'

/** The exact-text read endpoint's stable identity. */
export const PI_TUI_HISTORY_SEARCH_READ_TEXT_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiHistorySearch/readText'

/** The literal query bound (UTF-16 code units, never trimmed). */

/** Inclusive page-size bound of one search request. */
export const HISTORY_SEARCH_LIMIT_MIN = 1

/** The preview is a bounded prefix, never recoverable full content. */
export const HISTORY_SEARCH_PREVIEW_MAX_CHARS = 4096

/** Inclusive chunk-size bound of one readText request. */

/** The encoded keyset cursor bound in bytes. */
export const HISTORY_SEARCH_CURSOR_MAX_BYTES = 2048

/**
 * The decoded keyset-position cursor. It carries the Host's SQLite row anchor
 * (a signed 64-bit primary key rendered as canonical decimal) instead of raw
 * Session/Message ids, so no legal query, directory or official id can push the
 * token past {@link HISTORY_SEARCH_CURSOR_MAX_BYTES}. The request context is
 * bound by {@link historySearchRequestHash}, never by copied fields.
 */
export interface HistorySearchCursor {
  readonly v: 2
  readonly incarnation: string
  readonly revision: number
  readonly requestHash: string
  /** SQLite `INTEGER PRIMARY KEY`, canonical signed 64-bit decimal string. */
  readonly afterRowId: string
}

const REQUEST_LABEL = 'piTuiHistorySearch/search request'
const READ_REQUEST_LABEL = 'piTuiHistorySearch/readText request'
const ITEM_LABEL = 'piTuiHistorySearch item'
const ANSWER_LABEL = 'piTuiHistorySearch/search result'
const READ_ANSWER_LABEL = 'piTuiHistorySearch/readText result'
const CURSOR_LABEL = 'piTuiHistorySearch cursor'

const SCOPES: readonly HistorySearchScope[] = ['all', 'session', 'directory']
const INCOMPLETE_REASONS: readonly HistorySearchIncompleteReason[] = [
  'source-uncertain',
  'reconciling',
  'resource-limit',
  'source-read-failed',
]
const UNAVAILABLE_REASONS: readonly HistorySearchUnavailableReason[] = ['index-unavailable', 'service-missing']
const READ_UNAVAILABLE_REASONS: readonly HistoryReadTextUnavailableReason[] = [
  'not-found',
  'stale-content',
  'index-unavailable',
  'service-missing',
]

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}: the value must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new TypeError(`${label}: unexpected field ${JSON.stringify(key)}`)
  }
}

function requiredKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${label}: missing field ${JSON.stringify(key)}`)
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${label}: expected a non-empty string`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label}: expected a non-negative safe integer`)
  }
  return value
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const parsed = nonNegativeInteger(value, label)
  if (parsed < min || parsed > max) throw new TypeError(`${label}: expected an integer within ${min}..${max}`)
  return parsed
}

function parseContentSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label}: expected a lowercase hex SHA-256`)
  }
  return value
}

function parseQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > HISTORY_SEARCH_QUERY_MAX_CHARS) {
    throw new TypeError(`${REQUEST_LABEL}: query must be a string of at most ${HISTORY_SEARCH_QUERY_MAX_CHARS} characters`)
  }
  return value
}

/** Validate one exact wire request and return a detached copy. */
export function parseHistorySearchRequest(value: unknown): HistorySearchRequest {
  const record = recordOf(value, REQUEST_LABEL)
  if (typeof record.scope !== 'string' || !(SCOPES as readonly string[]).includes(record.scope)) {
    throw new TypeError(`${REQUEST_LABEL}: scope must be one of ${SCOPES.join('|')}`)
  }
  const scope = record.scope as HistorySearchScope
  const query = parseQuery(record.query)
  const limit = boundedInteger(record.limit, HISTORY_SEARCH_LIMIT_MIN, HISTORY_SEARCH_LIMIT_MAX, `${REQUEST_LABEL} limit`)
  const cursor = record.cursor === undefined
    ? undefined
    : nonEmptyString(record.cursor, `${REQUEST_LABEL} cursor`)
  if (cursor !== undefined && Buffer.byteLength(cursor, 'utf8') > HISTORY_SEARCH_CURSOR_MAX_BYTES) {
    throw new TypeError(`${REQUEST_LABEL}: cursor exceeds ${HISTORY_SEARCH_CURSOR_MAX_BYTES} bytes`)
  }
  if (scope === 'session') {
    exactKeys(record, ['scope', 'sessionId', 'query', 'limit', 'cursor'], REQUEST_LABEL)
    const sessionId = nonEmptyString(record.sessionId, `${REQUEST_LABEL} sessionId`)
    return { scope, sessionId, query, limit, ...(cursor === undefined ? {} : { cursor }) }
  }
  if (scope === 'directory') {
    exactKeys(record, ['scope', 'cwd', 'query', 'limit', 'cursor'], REQUEST_LABEL)
    const cwd = nonEmptyString(record.cwd, `${REQUEST_LABEL} cwd`)
    if (!isAbsolute(cwd)) throw new TypeError(`${REQUEST_LABEL}: cwd must be an absolute Host path`)
    if (cwd.includes('\0')) throw new TypeError(`${REQUEST_LABEL}: cwd must not contain NUL`)
    return { scope, cwd, query, limit, ...(cursor === undefined ? {} : { cursor }) }
  }
  exactKeys(record, ['scope', 'query', 'limit', 'cursor'], REQUEST_LABEL)
  return { scope, query, limit, ...(cursor === undefined ? {} : { cursor }) }
}

/** Validate one exact readText request and return a detached copy. */
export function parseHistoryReadTextRequest(value: unknown): HistoryReadTextRequest {
  const record = recordOf(value, READ_REQUEST_LABEL)
  exactKeys(record, ['sessionId', 'messageId', 'contentSha256', 'offset', 'limit'], READ_REQUEST_LABEL)
  requiredKeys(record, ['sessionId', 'messageId', 'contentSha256', 'offset', 'limit'], READ_REQUEST_LABEL)
  return {
    sessionId: nonEmptyString(record.sessionId, `${READ_REQUEST_LABEL} sessionId`),
    messageId: nonEmptyString(record.messageId, `${READ_REQUEST_LABEL} messageId`),
    contentSha256: parseContentSha256(record.contentSha256, `${READ_REQUEST_LABEL} contentSha256`),
    offset: nonNegativeInteger(record.offset, `${READ_REQUEST_LABEL} offset`),
    limit: boundedInteger(record.limit, 1, HISTORY_SEARCH_READ_TEXT_LIMIT_MAX, `${READ_REQUEST_LABEL} limit`),
  }
}

/** Validate and detach one result item. */
export function parseHistorySearchItem(value: unknown): HistorySearchItem {
  const record = recordOf(value, ITEM_LABEL)
  const keys = [
    'sessionId', 'messageId', 'firstEventSeq', 'acceptedAt', 'effectiveCwd',
    'preview', 'contentLength', 'contentSha256', 'hasNonText',
  ] as const
  exactKeys(record, keys, ITEM_LABEL)
  requiredKeys(record, keys, ITEM_LABEL)
  if (typeof record.preview !== 'string' || record.preview.length > HISTORY_SEARCH_PREVIEW_MAX_CHARS) {
    throw new TypeError(`${ITEM_LABEL}: preview must be a string of at most ${HISTORY_SEARCH_PREVIEW_MAX_CHARS} characters`)
  }
  if (record.effectiveCwd !== null && typeof record.effectiveCwd !== 'string') {
    throw new TypeError(`${ITEM_LABEL}: effectiveCwd must be a string or null`)
  }
  if (typeof record.hasNonText !== 'boolean') throw new TypeError(`${ITEM_LABEL}: hasNonText must be a boolean`)
  return {
    sessionId: nonEmptyString(record.sessionId, `${ITEM_LABEL} sessionId`),
    messageId: nonEmptyString(record.messageId, `${ITEM_LABEL} messageId`),
    firstEventSeq: nonNegativeInteger(record.firstEventSeq, `${ITEM_LABEL} firstEventSeq`),
    acceptedAt: nonNegativeInteger(record.acceptedAt, `${ITEM_LABEL} acceptedAt`),
    effectiveCwd: record.effectiveCwd,
    preview: record.preview,
    contentLength: nonNegativeInteger(record.contentLength, `${ITEM_LABEL} contentLength`),
    contentSha256: parseContentSha256(record.contentSha256, `${ITEM_LABEL} contentSha256`),
    hasNonText: record.hasNonText,
  }
}

/** Validate and detach the closed search answer union. */
export function parseHistorySearchResponse(value: unknown): HistorySearchResponse {
  const record = recordOf(value, ANSWER_LABEL)
  if (record.kind === 'ready') {
    exactKeys(record, ['kind', 'generation', 'items', 'nextCursor'], ANSWER_LABEL)
    if (!Array.isArray(record.items)) throw new TypeError(`${ANSWER_LABEL}: items must be an array`)
    if (record.nextCursor !== null && typeof record.nextCursor !== 'string') {
      throw new TypeError(`${ANSWER_LABEL}: nextCursor must be a string or null`)
    }
    if (typeof record.nextCursor === 'string'
      && Buffer.byteLength(record.nextCursor, 'utf8') > HISTORY_SEARCH_CURSOR_MAX_BYTES) {
      throw new TypeError(`${ANSWER_LABEL}: nextCursor exceeds ${HISTORY_SEARCH_CURSOR_MAX_BYTES} bytes`)
    }
    return {
      kind: 'ready',
      generation: nonEmptyString(record.generation, `${ANSWER_LABEL} generation`),
      items: record.items.map(parseHistorySearchItem),
      nextCursor: record.nextCursor,
    }
  }
  if (record.kind === 'loading') {
    exactKeys(record, ['kind'], ANSWER_LABEL)
    return { kind: 'loading' }
  }
  if (record.kind === 'incomplete') {
    exactKeys(record, ['kind', 'reason'], ANSWER_LABEL)
    if (!INCOMPLETE_REASONS.includes(record.reason as HistorySearchIncompleteReason)) {
      throw new TypeError(`${ANSWER_LABEL}: unknown incomplete reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'incomplete', reason: record.reason as HistorySearchIncompleteReason }
  }
  if (record.kind === 'unavailable') {
    exactKeys(record, ['kind', 'reason'], ANSWER_LABEL)
    if (!UNAVAILABLE_REASONS.includes(record.reason as HistorySearchUnavailableReason)) {
      throw new TypeError(`${ANSWER_LABEL}: unknown unavailable reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'unavailable', reason: record.reason as HistorySearchUnavailableReason }
  }
  if (record.kind === 'stale') {
    exactKeys(record, ['kind', 'reason'], ANSWER_LABEL)
    if (record.reason !== 'cursor-stale') {
      throw new TypeError(`${ANSWER_LABEL}: unknown stale reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'stale', reason: 'cursor-stale' }
  }
  throw new TypeError(`${ANSWER_LABEL}: unknown kind ${JSON.stringify(record.kind)}`)
}

/** Validate and detach the closed readText answer union. */
export function parseHistoryReadTextResponse(value: unknown): HistoryReadTextResponse {
  const record = recordOf(value, READ_ANSWER_LABEL)
  if (record.kind === 'ready') {
    exactKeys(record, ['kind', 'chunk', 'nextOffset', 'contentLength'], READ_ANSWER_LABEL)
    if (typeof record.chunk !== 'string') throw new TypeError(`${READ_ANSWER_LABEL}: chunk must be a string`)
    // The producer may exceed the requested limit by ONE UTF-16 unit only when
    // the requested cut would split a surrogate pair. A larger frame, or a
    // boundary +1 that does NOT complete a pair, is a contract violation.
    if (record.chunk.length > HISTORY_SEARCH_READ_TEXT_LIMIT_MAX + 1) {
      throw new TypeError(`${READ_ANSWER_LABEL}: chunk exceeds ${HISTORY_SEARCH_READ_TEXT_LIMIT_MAX + 1} UTF-16 code units`)
    }
    if (record.chunk.length === HISTORY_SEARCH_READ_TEXT_LIMIT_MAX + 1) {
      const high = record.chunk.charCodeAt(HISTORY_SEARCH_READ_TEXT_LIMIT_MAX - 1)
      const low = record.chunk.charCodeAt(HISTORY_SEARCH_READ_TEXT_LIMIT_MAX)
      const completesPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
      if (!completesPair) {
        throw new TypeError(`${READ_ANSWER_LABEL}: a chunk over ${HISTORY_SEARCH_READ_TEXT_LIMIT_MAX} code units must end with one complete surrogate pair`)
      }
    }
    if (record.nextOffset !== null) nonNegativeInteger(record.nextOffset, `${READ_ANSWER_LABEL} nextOffset`)
    return {
      kind: 'ready',
      chunk: record.chunk,
      nextOffset: record.nextOffset as number | null,
      contentLength: nonNegativeInteger(record.contentLength, `${READ_ANSWER_LABEL} contentLength`),
    }
  }
  if (record.kind === 'loading') {
    exactKeys(record, ['kind'], READ_ANSWER_LABEL)
    return { kind: 'loading' }
  }
  if (record.kind === 'incomplete') {
    exactKeys(record, ['kind', 'reason'], READ_ANSWER_LABEL)
    if (!INCOMPLETE_REASONS.includes(record.reason as HistorySearchIncompleteReason)) {
      throw new TypeError(`${READ_ANSWER_LABEL}: unknown incomplete reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'incomplete', reason: record.reason as HistorySearchIncompleteReason }
  }
  if (record.kind === 'unavailable') {
    exactKeys(record, ['kind', 'reason'], READ_ANSWER_LABEL)
    if (!READ_UNAVAILABLE_REASONS.includes(record.reason as HistoryReadTextUnavailableReason)) {
      throw new TypeError(`${READ_ANSWER_LABEL}: unknown unavailable reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'unavailable', reason: record.reason as HistoryReadTextUnavailableReason }
  }
  throw new TypeError(`${READ_ANSWER_LABEL}: unknown kind ${JSON.stringify(record.kind)}`)
}

const SIGNED_64_MIN = -(2n ** 63n)
const SIGNED_64_MAX = 2n ** 63n - 1n
const CANONICAL_SIGNED_64 = /^(?:0|-?[1-9][0-9]*)$/u

/**
 * Validate one SQLite row anchor as a canonical signed 64-bit decimal string.
 * SQLite's own `CAST` silently clamps out-of-range text and accepts `+1`/`012`,
 * so this check is load-bearing BEFORE the value reaches `CAST(? AS INTEGER)`.
 */
export function parseHistorySearchRowId(value: unknown, label = `${CURSOR_LABEL} afterRowId`): string {
  if (typeof value !== 'string' || !CANONICAL_SIGNED_64.test(value)) {
    throw new TypeError(`${label}: expected a canonical signed 64-bit decimal string`)
  }
  const parsed = BigInt(value)
  if (parsed < SIGNED_64_MIN || parsed > SIGNED_64_MAX) {
    throw new TypeError(`${label}: the value is outside the signed 64-bit range`)
  }
  return value
}

/**
 * The ONE request binding of a continuation: the exact scope, literal query and
 * normalized scope id. The cursor carries only this digest, so the request
 * context cannot be silently recombined from copied fields.
 */
export function historySearchRequestHash(
  scope: HistorySearchScope,
  query: string,
  normalizedScopeId: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([scope, query, normalizedScopeId]), 'utf8')
    .digest('hex')
}

function parseRequestHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${CURSOR_LABEL} requestHash: expected a lowercase hex SHA-256`)
  }
  return value
}

/** Encode one validated keyset cursor as base64url JSON. */
export function encodeHistorySearchCursor(cursor: HistorySearchCursor): string {
  if (cursor.v !== 2) throw new TypeError(`${CURSOR_LABEL}: v must be 2`)
  nonEmptyString(cursor.incarnation, `${CURSOR_LABEL} incarnation`)
  if (!Number.isSafeInteger(cursor.revision) || cursor.revision < 0) {
    throw new TypeError(`${CURSOR_LABEL}: revision must be a non-negative safe integer`)
  }
  parseRequestHash(cursor.requestHash)
  parseHistorySearchRowId(cursor.afterRowId)
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  if (Buffer.byteLength(encoded, 'utf8') > HISTORY_SEARCH_CURSOR_MAX_BYTES) {
    throw new TypeError(`${CURSOR_LABEL}: encoded cursor exceeds ${HISTORY_SEARCH_CURSOR_MAX_BYTES} bytes`)
  }
  return encoded
}

/** Decode and strictly validate one base64url keyset cursor. */
export function decodeHistorySearchCursor(value: string): HistorySearchCursor {
  if (Buffer.byteLength(value, 'utf8') > HISTORY_SEARCH_CURSOR_MAX_BYTES) {
    throw new TypeError(`${CURSOR_LABEL}: encoded cursor exceeds ${HISTORY_SEARCH_CURSOR_MAX_BYTES} bytes`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new TypeError(`${CURSOR_LABEL}: the value is not base64url JSON`)
  }
  const record = recordOf(decoded, CURSOR_LABEL)
  exactKeys(record, ['v', 'incarnation', 'revision', 'requestHash', 'afterRowId'], CURSOR_LABEL)
  requiredKeys(record, ['v', 'incarnation', 'revision', 'requestHash', 'afterRowId'], CURSOR_LABEL)
  if (record.v !== 2) throw new TypeError(`${CURSOR_LABEL}: unsupported version ${JSON.stringify(record.v)}`)
  return {
    v: 2,
    incarnation: nonEmptyString(record.incarnation, `${CURSOR_LABEL} incarnation`),
    revision: nonNegativeInteger(record.revision, `${CURSOR_LABEL} revision`),
    requestHash: parseRequestHash(record.requestHash),
    afterRowId: parseHistorySearchRowId(record.afterRowId),
  }
}

/**
 * The bounded search preview: at most {@link HISTORY_SEARCH_PREVIEW_MAX_CHARS}
 * UTF-16 code units without splitting a surrogate pair.
 */
export function historySearchPreview(content: string): string {
  if (content.length <= HISTORY_SEARCH_PREVIEW_MAX_CHARS) return content
  let end = HISTORY_SEARCH_PREVIEW_MAX_CHARS
  const code = content.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return content.slice(0, end)
}

/** Slice one exact-text chunk without splitting a surrogate pair. */
export function historyReadTextChunk(
  content: string,
  offset: number,
  limit: number,
): { readonly chunk: string; readonly nextOffset: number | null } {
  if (offset > content.length) {
    throw new RangeError('piTuiHistorySearch/readText: offset exceeds the content length')
  }
  // A caller-supplied offset that lands inside a surrogate pair is advanced to
  // the next code point: no returned chunk may start with a lone low surrogate.
  let start = offset
  if (start > 0 && start < content.length) {
    const previous = content.charCodeAt(start - 1)
    const current = content.charCodeAt(start)
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      start += 1
    }
  }
  let end = Math.min(content.length, start + limit)
  if (end < content.length && end > start) {
    const code = content.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
    if (end === start) end = Math.min(content.length, start + limit + 1)
  }
  return {
    chunk: content.slice(start, end),
    nextOffset: end >= content.length ? null : end,
  }
}

const SEARCH_REQUEST_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_HISTORY_SEARCH_SEARCH_ENDPOINT}:request`,
  create: () => ({ parse: parseHistorySearchRequest }),
  decode: parseHistorySearchRequest,
}

const SEARCH_RESULT_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_HISTORY_SEARCH_SEARCH_ENDPOINT}:result`,
  create: () => ({ parse: parseHistorySearchResponse }),
  decode: parseHistorySearchResponse,
}

const READ_TEXT_REQUEST_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_HISTORY_SEARCH_READ_TEXT_ENDPOINT}:request`,
  create: () => ({ parse: parseHistoryReadTextRequest }),
  decode: parseHistoryReadTextRequest,
}

const READ_TEXT_RESULT_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_HISTORY_SEARCH_READ_TEXT_ENDPOINT}:result`,
  create: () => ({ parse: parseHistoryReadTextResponse }),
  decode: parseHistoryReadTextResponse,
}

/** The ONE shared search descriptor both contributions derive from. */
export const PI_TUI_HISTORY_SEARCH: InvocationDescriptor = {
  id: PI_TUI_HISTORY_SEARCH_SEARCH_ENDPOINT,
  service: PI_TUI_HISTORY_SEARCH_NAMESPACE,
  namespace: PI_TUI_HISTORY_SEARCH_NAMESPACE,
  method: 'search',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'request', wire: 'request', source: 'json', codec: SEARCH_REQUEST_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: SEARCH_RESULT_CODEC,
}

/** The ONE shared exact-text read descriptor both contributions derive from. */
export const PI_TUI_HISTORY_SEARCH_READ_TEXT: InvocationDescriptor = {
  id: PI_TUI_HISTORY_SEARCH_READ_TEXT_ENDPOINT,
  service: PI_TUI_HISTORY_SEARCH_NAMESPACE,
  namespace: PI_TUI_HISTORY_SEARCH_NAMESPACE,
  method: 'readText',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'request', wire: 'request', source: 'json', codec: READ_TEXT_REQUEST_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: READ_TEXT_RESULT_CODEC,
}

/** The `search` call result as the Client receives it. */
export type PiTuiHistorySearchCall = RemoteResult<HistorySearchResponse>

/** The `readText` call result as the Client receives it. */
export type PiTuiHistoryReadTextCall = RemoteResult<HistoryReadTextResponse>

/** The mounted Client namespace slice this contract owns. */
export interface PiTuiHistorySearchNamespace {
  search(request: HistorySearchRequest, signal?: AbortSignal): Promise<PiTuiHistorySearchCall>
  readText(request: HistoryReadTextRequest, signal?: AbortSignal): Promise<PiTuiHistoryReadTextCall>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiHistorySearch/search': (
      request: HistorySearchRequest,
      signal?: AbortSignal,
    ) => Promise<PiTuiHistorySearchCall>
    'piTuiHistorySearch/readText': (
      request: HistoryReadTextRequest,
      signal?: AbortSignal,
    ) => Promise<PiTuiHistoryReadTextCall>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiHistorySearch': {
      search: (request: HistorySearchRequest, signal?: AbortSignal) => Promise<PiTuiHistorySearchCall>
      readText: (request: HistoryReadTextRequest, signal?: AbortSignal) => Promise<PiTuiHistoryReadTextCall>
    }
  }
}
