/**
 * The private `piTuiAcpAccess` Remote contract: TWO handwritten invocation
 * descriptors that BOTH the Host service and the Client contribution derive
 * from, so a namespace/method/parameter drift is impossible by construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiAcpAccess/getStatus
 * endpoint   @xmoon76/dsh-pi-tui#piTuiAcpAccess/setEnabled
 * service    piTuiAcpAccess      (Host Cordis service key)
 * namespace  piTuiAcpAccess      (wire namespace)
 * method     getStatus()
 * method     setEnabled(enabled)
 * result     PiTuiAcpAccessStatus
 * ```
 *
 * The descriptors are registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * The STATUS result carries NO socket pathname, launch token, cookie or profile
 * path: it is the small availability vocabulary of the local ACP listener, and an
 * `unavailable` reason is a fixed, redacted category.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-acp-access-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_ACP_ACCESS_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the listener control. */
export const PI_TUI_ACP_ACCESS_NAMESPACE = 'piTuiAcpAccess'

/** The status method's stable endpoint identity. */
export const PI_TUI_ACP_ACCESS_GET_STATUS_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiAcpAccess/getStatus'

/** The mutation method's stable endpoint identity. */
export const PI_TUI_ACP_ACCESS_SET_ENABLED_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiAcpAccess/setEnabled'

/**
 * The availability of the local ACP listener on THIS Host.
 *
 * Structurally identical to the semantic `AcpAccessStatus` of the runtime port,
 * but declared here as the wire fact the codecs validate. `reason` on an
 * `unavailable` result is a fixed, redacted category, never a secret.
 */
export type PiTuiAcpAccessStatus =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled' }
  | { readonly state: 'changing' }
  | { readonly state: 'unavailable'; readonly reason: string }

/** The business result the private Remote methods resolve to on the wire. */
export type PiTuiAcpAccessCallResult = RemoteResult<PiTuiAcpAccessStatus>

/** One strict JSON codec that validates a wire boolean. */
const BOOLEAN_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiAcpAccess/setEnabled:enabled',
  create: () => ({
    parse: (value: unknown): boolean => {
      if (typeof value !== 'boolean') {
        throw new TypeError('piTuiAcpAccess/setEnabled: the wire value must be a boolean')
      }
      return value
    },
  }),
}

/**
 * Validate and detach one wire `PiTuiAcpAccessStatus`. The status is produced by
 * this package's own Host service, but it is still a wire boundary on the Client
 * and the ONLY place the shape crosses.
 */
export function parsePiTuiAcpAccessStatus(value: unknown): PiTuiAcpAccessStatus {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('piTuiAcpAccess: the result must be an object')
  }
  const record = value as { readonly state?: unknown; readonly reason?: unknown }
  const field = record.state === 'unavailable' ? 'reason' : undefined
  // The status has EXACTLY one field per state: a stray field is a different
  // wire shape, so it is refused instead of being silently dropped.
  for (const key of Object.keys(record)) {
    if (key !== 'state' && key !== field) {
      throw new TypeError(`piTuiAcpAccess: unexpected result field ${JSON.stringify(key)}`)
    }
  }
  if (record.state === 'disabled' || record.state === 'enabled' || record.state === 'changing') {
    return { state: record.state }
  }
  if (record.state !== 'unavailable') {
    throw new TypeError('piTuiAcpAccess: the result state must be disabled, enabled, changing or unavailable')
  }
  if (typeof record.reason !== 'string' || record.reason === '') {
    throw new TypeError('piTuiAcpAccess: an unavailable result needs a non-empty reason')
  }
  return { state: 'unavailable', reason: record.reason }
}

const PI_TUI_ACP_ACCESS_STATUS_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiAcpAccess:status',
  create: () => ({ parse: parsePiTuiAcpAccessStatus }),
  decode: parsePiTuiAcpAccessStatus,
}

/**
 * The `getStatus` invocation both contributions derive from. The Host registers
 * this exact object; the Client mounts this exact object.
 */
export const PI_TUI_ACP_ACCESS_GET_STATUS: InvocationDescriptor = {
  id: PI_TUI_ACP_ACCESS_GET_STATUS_ENDPOINT,
  service: PI_TUI_ACP_ACCESS_NAMESPACE,
  namespace: PI_TUI_ACP_ACCESS_NAMESPACE,
  method: 'getStatus',
  invocation: { kind: 'direct' },
  parameters: [],
  result: PI_TUI_ACP_ACCESS_STATUS_CODEC,
}

/**
 * The `setEnabled` invocation both contributions derive from. `enabled` is one
 * required boolean: the Host Gateway decodes it through {@link BOOLEAN_CODEC}, so
 * a malformed value is refused at the wire boundary and never reaches the
 * listener.
 */
export const PI_TUI_ACP_ACCESS_SET_ENABLED: InvocationDescriptor = {
  id: PI_TUI_ACP_ACCESS_SET_ENABLED_ENDPOINT,
  service: PI_TUI_ACP_ACCESS_NAMESPACE,
  namespace: PI_TUI_ACP_ACCESS_NAMESPACE,
  method: 'setEnabled',
  invocation: { kind: 'direct' },
  parameters: [
    {
      name: 'enabled',
      wire: 'enabled',
      source: 'json',
      codec: BOOLEAN_CODEC,
    },
  ],
  result: PI_TUI_ACP_ACCESS_STATUS_CODEC,
}

/** The exact wire arguments both contributions agree on. */
export interface PiTuiAcpAccessSetEnabledArguments {
  readonly enabled: boolean
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * these descriptors together with the file-reference and terminal-progress
 * ones — lives in `pi-tui-remote-contribution.ts`.
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiAcpAccess/getStatus': () => Promise<PiTuiAcpAccessCallResult>
    'piTuiAcpAccess/setEnabled': (enabled: boolean) => Promise<PiTuiAcpAccessCallResult>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiAcpAccess': {
      getStatus: () => Promise<PiTuiAcpAccessCallResult>
      setEnabled: (enabled: boolean) => Promise<PiTuiAcpAccessCallResult>
    }
  }
}
