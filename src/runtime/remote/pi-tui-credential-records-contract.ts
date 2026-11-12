/**
 * The private `piTuiCredentialRecords` Remote contract (M6-1 F7B): TWO
 * handwritten unary invocation descriptors that BOTH the Host service and the
 * Client contribution derive from, so a namespace/method/parameter/frame drift
 * is impossible by construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiCredentialRecords/list
 * endpoint   @xmoon76/dsh-pi-tui#piTuiCredentialRecords/delete
 * service    piTuiCredentialRecords   (Host Cordis service key)
 * namespace  piTuiCredentialRecords   (wire namespace)
 * method     list(signal)            -> readonly CredentialRecordMetadata[]
 * method     delete(key, signal)     -> void
 * ```
 *
 * The installed official `ctx.credentials` store remains the ONLY credential
 * record authority: this namespace is a metadata-only transport bridge. It
 * never carries a token, a grant payload, an api-key value/env mapping or a Host
 * record object, and it has no `readRecord`/`modifyRecord`/`describeRecord`/
 * `deleteAll`/`revoke`/`watch` method.
 *
 * The two key spaces stay disjoint: `credentials/describe|set|unset` address
 * REFERENCE names (environment-variable grammar), while `list`/`delete` here
 * address stored `<scope>/<id>` RECORD keys. A record delete is therefore never
 * an `unset(ref)`.
 *
 * The descriptors are registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-credential-records-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_CREDENTIAL_RECORDS_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private service. */
export const PI_TUI_CREDENTIAL_RECORDS_NAMESPACE = 'piTuiCredentialRecords'

/** The metadata enumeration's stable endpoint identity. */
export const PI_TUI_CREDENTIAL_RECORDS_LIST_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiCredentialRecords/list'

/** The exact-key delete's stable endpoint identity. */
export const PI_TUI_CREDENTIAL_RECORDS_DELETE_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiCredentialRecords/delete'

/**
 * The official `<scope>/<id>` segment grammar (the same rule as the official
 * `parseCredentialKey()`): two lowercase hyphenated identifiers separated by
 * exactly one `/`. This is an ADDRESS grammar only — it never says a key exists
 * or which provider it belongs to; the Host store decides that.
 */
export const CREDENTIAL_RECORD_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/

/** The two official stored-record discriminants (never an arbitrary string). */
export type PiTuiCredentialRecordKind = 'api-key' | 'grant'

/** ONE stored record's metadata: its address and discriminant, never a value. */
export interface CredentialRecordMetadata {
  readonly key: string
  readonly kind: PiTuiCredentialRecordKind
}

const RECORD_LABEL = 'piTuiCredentialRecords record'
const LIST_LABEL = 'piTuiCredentialRecords/list result'
const KEY_LABEL = 'piTuiCredentialRecords key'

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

/**
 * Validate one exact `<scope>/<id>` record key as wire text and return it. A
 * key outside the official grammar (non-ASCII, extra `/`, an empty segment, an
 * environment-variable name) is refused; a VALID other plugin's scope is not.
 */
export function parsePiTuiCredentialRecordKey(value: unknown): string {
  if (typeof value !== 'string' || !CREDENTIAL_RECORD_KEY_PATTERN.test(value)) {
    throw new TypeError(`${KEY_LABEL}: expected an exact <scope>/<id> credential key`)
  }
  return value
}

/** Validate and detach ONE stored-record metadata row (exactly `key`+`kind`). */
export function parsePiTuiCredentialRecordMetadata(value: unknown): CredentialRecordMetadata {
  const record = recordOf(value, RECORD_LABEL)
  exactKeys(record, ['key', 'kind'], RECORD_LABEL)
  requiredKeys(record, ['key', 'kind'], RECORD_LABEL)
  const kind = record.kind
  if (kind !== 'api-key' && kind !== 'grant') {
    throw new TypeError(`${RECORD_LABEL}: the kind must be api-key or grant`)
  }
  return { key: parsePiTuiCredentialRecordKey(record.key), kind }
}

/**
 * Validate and detach the WHOLE `list` result. A non-array, or ANY invalid row
 * (an extra field such as a payload/token/env, an invalid key, an unknown
 * kind), fails the whole result: the adapter must never filter an unusable
 * official projection out and then claim the remaining rows are the complete
 * Host truth.
 */
export function parsePiTuiCredentialRecordList(value: unknown): readonly CredentialRecordMetadata[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${LIST_LABEL}: the result must be an array`)
  }
  return value.map(parsePiTuiCredentialRecordMetadata)
}

function codecOf<T>(label: string, parse: (value: unknown) => T): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol: `@xmoon76/dsh-pi-tui#${label}`,
    create: () => ({ parse }),
    decode: parse,
  }
}

const LIST_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_CREDENTIAL_RECORDS_LIST_ENDPOINT}:result`,
  create: () => ({ parse: parsePiTuiCredentialRecordList }),
  decode: parsePiTuiCredentialRecordList,
}

const KEY_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_CREDENTIAL_RECORDS_DELETE_ENDPOINT}:key`,
  create: () => ({ parse: parsePiTuiCredentialRecordKey }),
  decode: parsePiTuiCredentialRecordKey,
}

/** The success shape of a delete: the official empty result, nothing else. */
const VOID_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiCredentialRecords:void',
  create: () => ({
    parse: (value: unknown): void => {
      if (value !== undefined && value !== null) {
        throw new TypeError('piTuiCredentialRecords: the result must be empty')
      }
      return undefined
    },
  }),
  decode: (value: unknown): unknown => {
    if (value !== undefined && value !== null) {
      throw new TypeError('piTuiCredentialRecords: the result must be empty')
    }
    return undefined
  },
}

/** The metadata enumeration invocation both contributions derive from. */
export const PI_TUI_CREDENTIAL_RECORDS_LIST: InvocationDescriptor = {
  id: PI_TUI_CREDENTIAL_RECORDS_LIST_ENDPOINT,
  service: PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  namespace: PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  method: 'list',
  invocation: { kind: 'direct' },
  parameters: [],
  cancellation: { parameter: 'signal' },
  result: LIST_CODEC,
}

/** The exact-key delete invocation both contributions derive from. */
export const PI_TUI_CREDENTIAL_RECORDS_DELETE: InvocationDescriptor = {
  id: PI_TUI_CREDENTIAL_RECORDS_DELETE_ENDPOINT,
  service: PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  namespace: PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  method: 'delete',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'key', wire: 'key', source: 'json', codec: KEY_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: VOID_CODEC,
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * these descriptors together with the file-reference, terminal-progress,
 * Web-access, Shell, Skills and Authorization ones — lives in
 * `pi-tui-remote-contribution.ts`.
 */

/** The `list` call result as the Client receives it. */
export type PiTuiCredentialRecordsListCall = RemoteResult<readonly CredentialRecordMetadata[]>

/** The `delete` call result as the Client receives it. */
export type PiTuiCredentialRecordsDeleteCall = RemoteResult<void>

/** The mounted Client namespace slice this adapter consumes. */
export interface PiTuiCredentialRecordsNamespace {
  list(signal?: AbortSignal): Promise<PiTuiCredentialRecordsListCall>
  delete(key: string, signal?: AbortSignal): Promise<PiTuiCredentialRecordsDeleteCall>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiCredentialRecords/list': (signal?: AbortSignal) => Promise<PiTuiCredentialRecordsListCall>
    'piTuiCredentialRecords/delete': (key: string, signal?: AbortSignal) => Promise<PiTuiCredentialRecordsDeleteCall>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiCredentialRecords': {
      list: (signal?: AbortSignal) => Promise<PiTuiCredentialRecordsListCall>
      delete: (key: string, signal?: AbortSignal) => Promise<PiTuiCredentialRecordsDeleteCall>
    }
  }
}
