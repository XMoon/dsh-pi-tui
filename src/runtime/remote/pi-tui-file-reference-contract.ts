/**
 * The private `piTuiFileReferences` Remote contract (TS8-HF1; M6-1/F5-B adds
 * the sessionless Workspace verb): handwritten invocation descriptors that BOTH
 * the Host service and the Client contribution derive from, so a
 * namespace/method/parameter drift is impossible by construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiFileReferences/list
 * service    piTuiFileReferences      (Host Cordis service key)
 * namespace  piTuiFileReferences      (wire namespace)
 * method     list(sessionId, query, signal)
 * result     HostFileListResult       (the Host router's own answer)
 *
 * endpoint   @xmoon76/dsh-pi-tui#piTuiFileReferences/listWorkspace
 * method     listWorkspace(workspaceId, query, signal)
 * result     HostFileListResult       (the official Workspace search answer)
 * ```
 *
 * The descriptors are registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * `list` is a Session-scoped AUGMENTATION of the official `fileReferences`
 * namespace (which stays mounted and authoritative for bare queries).
 * `listWorkspace` is the sessionless Host Workspace discovery: it carries only
 * the Host-issued `workspaceId` and the OFFICIAL query form. The Client-local
 * `selectionRevision` and every cwd/client-fs fact stay out of both DTOs.
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

/** The Session-scoped private method's stable endpoint identity. */
export const PI_TUI_FILE_REFERENCES_LIST_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiFileReferences/list'

/** The sessionless Workspace method's stable endpoint identity. */
export const PI_TUI_FILE_REFERENCES_LIST_WORKSPACE_ENDPOINT =
  '@xmoon76/dsh-pi-tui#piTuiFileReferences/listWorkspace'

/** The exact wire arguments of the Session-scoped method. */
export interface PiTuiFileReferencesListArguments {
  readonly sessionId: string
  readonly query: string
  readonly signal?: AbortSignal
}

/** The exact wire arguments of the sessionless Workspace method. */
export interface PiTuiFileReferencesListWorkspaceArguments {
  readonly workspaceId: string
  readonly query: string
  readonly signal?: AbortSignal
}

/** The business result the private Remote methods resolve to. */
export type PiTuiFileReferencesListResult = RemoteResult<HostFileListResult>

/** The business result of the sessionless Workspace method. */
export type PiTuiFileReferencesListWorkspaceResult = RemoteResult<HostFileListResult>

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
function decodeHostFileListResult(value: unknown, method: string): HostFileListResult {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${method}: the result must be an object`)
  }
  const record = value as { readonly kind?: unknown; readonly items?: unknown; readonly reason?: unknown }
  if (record.kind === 'unavailable') {
    if (typeof record.reason !== 'string') {
      throw new TypeError(`${method}: an unavailable result needs a reason`)
    }
    return { kind: 'unavailable', reason: record.reason }
  }
  if (record.kind !== 'ok' || !Array.isArray(record.items)) {
    throw new TypeError(`${method}: the result must be ok(items) or unavailable(reason)`)
  }
  const items = record.items.map((entry): { path: string; kind: 'file' | 'directory' } => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`${method}: every candidate must be an object`)
    }
    const candidate = entry as { readonly path?: unknown; readonly kind?: unknown }
    if (typeof candidate.path !== 'string' || (candidate.kind !== 'file' && candidate.kind !== 'directory')) {
      throw new TypeError(`${method}: every candidate needs a string path and a file/directory kind`)
    }
    return { path: candidate.path, kind: candidate.kind }
  })
  return { kind: 'ok', items }
}

/** The strict result codec shared by both private methods (one decoder). */
function hostFileListResultCodec(method: string, typeSymbol: string): TypertCodec {
  const decode = (value: unknown): HostFileListResult => decodeHostFileListResult(value, method)
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse: decode }),
    decode,
  }
}

const HOST_FILE_LIST_RESULT_CODEC = hostFileListResultCodec(
  'piTuiFileReferences/list',
  '@xmoon76/dsh-pi-tui#piTuiFileReferences/list:result',
)

const HOST_FILE_LIST_WORKSPACE_RESULT_CODEC = hostFileListResultCodec(
  'piTuiFileReferences/listWorkspace',
  '@xmoon76/dsh-pi-tui#piTuiFileReferences/listWorkspace:result',
)

/**
 * The ONE shared Session-scoped invocation descriptor both contributions derive
 * from. The Host registers this exact object; the Client mounts this exact
 * object.
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

/**
 * The ONE shared sessionless Workspace invocation descriptor both contributions
 * derive from. The Host registers this exact object; the Client mounts this
 * exact object. Only the Host-issued `workspaceId` and the official query form
 * cross the wire.
 */
export const PI_TUI_FILE_REFERENCES_LIST_WORKSPACE: InvocationDescriptor = {
  id: PI_TUI_FILE_REFERENCES_LIST_WORKSPACE_ENDPOINT,
  service: PI_TUI_FILE_REFERENCES_NAMESPACE,
  namespace: PI_TUI_FILE_REFERENCES_NAMESPACE,
  method: 'listWorkspace',
  invocation: { kind: 'direct' },
  parameters: [
    {
      name: 'workspaceId',
      wire: 'workspaceId',
      source: 'json',
      codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiFileReferences/listWorkspace:workspaceId'),
    },
    {
      name: 'query',
      wire: 'query',
      source: 'json',
      codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiFileReferences/listWorkspace:query'),
    },
  ],
  cancellation: { parameter: 'signal' },
  result: HOST_FILE_LIST_WORKSPACE_RESULT_CODEC,
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * these descriptors together with the terminal-progress ones — lives in
 * `pi-tui-remote-contribution.ts`.
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiFileReferences/list': (sessionId: string, query: string, signal?: AbortSignal) => Promise<PiTuiFileReferencesListResult>
    'piTuiFileReferences/listWorkspace': (workspaceId: string, query: string, signal?: AbortSignal) => Promise<PiTuiFileReferencesListWorkspaceResult>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiFileReferences': {
      list: (sessionId: string, query: string, signal?: AbortSignal) => Promise<PiTuiFileReferencesListResult>
      listWorkspace: (workspaceId: string, query: string, signal?: AbortSignal) => Promise<PiTuiFileReferencesListWorkspaceResult>
    }
  }
}
