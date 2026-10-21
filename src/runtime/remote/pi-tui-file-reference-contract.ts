/**
 * The private `piTuiFileReferences` Remote contract (TS8-HF1): ONE handwritten
 * invocation descriptor that BOTH the Host service and the Client contribution
 * derive from, so a namespace/method/parameter drift is impossible by
 * construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiFileReferences/list
 * service    piTuiFileReferences      (Host Cordis service key)
 * namespace  piTuiFileReferences      (wire namespace)
 * method     list(sessionId, query, signal)
 * result     HostFileListResult       (the Host router's own answer)
 * ```
 *
 * The descriptor is registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * This is an AUGMENTATION, not a replacement: the official `fileReferences`
 * namespace stays mounted and authoritative for bare workspace queries; the
 * private namespace adds explicit path navigation only.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-file-reference-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
import type { HostFileListResult } from '../host-file-port.ts'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_FILE_REFERENCE_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the augmentation. */
export const PI_TUI_FILE_REFERENCES_NAMESPACE = 'piTuiFileReferences'

/** The private method's stable endpoint identity. */
export const PI_TUI_FILE_REFERENCES_LIST_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiFileReferences/list'

/** The exact wire arguments the Host and Client contributions agree on. */
export interface PiTuiFileReferencesListArguments {
  readonly sessionId: string
  readonly query: string
  readonly signal?: AbortSignal
}

/** The business result the private Remote method resolves to. */
export type PiTuiFileReferencesListResult = RemoteResult<HostFileListResult>

/** One strict JSON codec that validates a wire string. */
function stringCodec(typeSymbol: string): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value: unknown): string => {
        if (typeof value !== 'string') throw new TypeError(`${typeSymbol}: the wire value must be a string`)
        return value
      },
    }),
  }
}

/**
 * Validate and detach one wire `HostFileListResult`. The result is produced by
 * this package's own Host router, but it is still a wire boundary on the Client
 * and the ONLY place the shape crosses.
 */
function decodeHostFileListResult(value: unknown): HostFileListResult {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('piTuiFileReferences/list: the result must be an object')
  }
  const record = value as { readonly kind?: unknown; readonly items?: unknown; readonly reason?: unknown }
  if (record.kind === 'unavailable') {
    if (typeof record.reason !== 'string') {
      throw new TypeError('piTuiFileReferences/list: an unavailable result needs a reason')
    }
    return { kind: 'unavailable', reason: record.reason }
  }
  if (record.kind !== 'ok' || !Array.isArray(record.items)) {
    throw new TypeError('piTuiFileReferences/list: the result must be ok(items) or unavailable(reason)')
  }
  const items = record.items.map((entry): { path: string; kind: 'file' | 'directory' } => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError('piTuiFileReferences/list: every candidate must be an object')
    }
    const candidate = entry as { readonly path?: unknown; readonly kind?: unknown }
    if (typeof candidate.path !== 'string' || (candidate.kind !== 'file' && candidate.kind !== 'directory')) {
      throw new TypeError('piTuiFileReferences/list: every candidate needs a string path and a file/directory kind')
    }
    return { path: candidate.path, kind: candidate.kind }
  })
  return { kind: 'ok', items }
}

const HOST_FILE_LIST_RESULT_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiFileReferences/list:result',
  create: () => ({ parse: decodeHostFileListResult }),
  decode: decodeHostFileListResult,
}

/**
 * The ONE shared invocation descriptor both contributions derive from. The
 * Host registers this exact object; the Client mounts this exact object.
 */
export const PI_TUI_FILE_REFERENCES_LIST: InvocationDescriptor = {
  id: PI_TUI_FILE_REFERENCES_LIST_ENDPOINT,
  service: PI_TUI_FILE_REFERENCES_NAMESPACE,
  namespace: PI_TUI_FILE_REFERENCES_NAMESPACE,
  method: 'list',
  invocation: { kind: 'direct' },
  parameters: [
    {
      name: 'sessionId',
      wire: 'sessionId',
      source: 'json',
      codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiFileReferences/list:sessionId'),
    },
    {
      name: 'query',
      wire: 'query',
      source: 'json',
      codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiFileReferences/list:query'),
    },
  ],
  cancellation: { parameter: 'signal' },
  result: HOST_FILE_LIST_RESULT_CODEC,
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * this descriptor together with the terminal-progress one — lives in
 * `pi-tui-remote-contribution.ts`.
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiFileReferences/list': (sessionId: string, query: string, signal?: AbortSignal) => Promise<PiTuiFileReferencesListResult>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiFileReferences': {
      list: (sessionId: string, query: string, signal?: AbortSignal) => Promise<PiTuiFileReferencesListResult>
    }
  }
}
