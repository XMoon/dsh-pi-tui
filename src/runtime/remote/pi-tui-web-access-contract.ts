/**
 * The private `piTuiWebAccess` Remote contract (M5-W PR-B): TWO handwritten
 * invocation descriptors that BOTH the Host service and the Client
 * contribution derive from, so a namespace/method/parameter drift is
 * impossible by construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiWebAccess/getStatus
 * endpoint   @xmoon76/dsh-pi-tui#piTuiWebAccess/setEnabled
 * service    piTuiWebAccess      (Host Cordis service key)
 * namespace  piTuiWebAccess      (wire namespace)
 * method     getStatus()
 * method     setEnabled(enabled)
 * result     PiTuiWebAccessStatus
 * ```
 *
 * The descriptors are registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * The result carries NO token, URL, cookie or profile path: the status is the
 * small availability vocabulary of the official Web frontend, and an
 * `unavailable` reason is a fixed, redacted diagnostic.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-web-access-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_WEB_ACCESS_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the toggle. */
export const PI_TUI_WEB_ACCESS_NAMESPACE = 'piTuiWebAccess'

/** The status method's stable endpoint identity. */
export const PI_TUI_WEB_ACCESS_GET_STATUS_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiWebAccess/getStatus'

/** The mutation method's stable endpoint identity. */
export const PI_TUI_WEB_ACCESS_SET_ENABLED_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiWebAccess/setEnabled'

/**
 * The availability of the official Web frontend on THIS Host.
 *
 * `disabled` — every Web-only Loader row is effectively disabled and the Web
 * services are released. `enabled` — every Web row is enabled, the essential
 * Web fibers/services are live and no mutation is in flight. `changing` — one
 * serialized mutation is still running. `unavailable` — the roster or a core
 * Web fiber is in a state the toggle cannot truthfully describe; `reason` is a
 * fixed, redacted diagnostic, never a token/URL/cookie/profile path.
 */
export type PiTuiWebAccessStatus =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled' }
  | { readonly state: 'changing' }
  | { readonly state: 'unavailable'; readonly reason: string }

/** The business result the private Remote methods resolve to on the wire. */
export type PiTuiWebAccessCallResult = RemoteResult<PiTuiWebAccessStatus>

/** One strict JSON codec that validates a wire boolean. */
const BOOLEAN_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiWebAccess/setEnabled:enabled',
  create: () => ({
    parse: (value: unknown): boolean => {
      if (typeof value !== 'boolean') {
        throw new TypeError('piTuiWebAccess/setEnabled: the wire value must be a boolean')
      }
      return value
    },
  }),
}

/**
 * Validate and detach one wire `PiTuiWebAccessStatus`. The status is produced by
 * this package's own Host service, but it is still a wire boundary on the
 * Client and the ONLY place the shape crosses.
 */
export function parsePiTuiWebAccessStatus(value: unknown): PiTuiWebAccessStatus {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('piTuiWebAccess: the result must be an object')
  }
  const record = value as { readonly state?: unknown; readonly reason?: unknown }
  const field = record.state === 'unavailable' ? 'reason' : undefined
  // The status has EXACTLY one field per state: a stray field is a different
  // wire shape, so it is refused instead of being silently dropped.
  for (const key of Object.keys(record)) {
    if (key !== 'state' && key !== field) {
      throw new TypeError(`piTuiWebAccess: unexpected result field ${JSON.stringify(key)}`)
    }
  }
  if (record.state === 'disabled' || record.state === 'enabled' || record.state === 'changing') {
    return { state: record.state }
  }
  if (record.state !== 'unavailable') {
    throw new TypeError('piTuiWebAccess: the result state must be disabled, enabled, changing or unavailable')
  }
  if (typeof record.reason !== 'string' || record.reason === '') {
    throw new TypeError('piTuiWebAccess: an unavailable result needs a non-empty reason')
  }
  return { state: 'unavailable', reason: record.reason }
}

const PI_TUI_WEB_ACCESS_STATUS_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiWebAccess:status',
  create: () => ({ parse: parsePiTuiWebAccessStatus }),
  decode: parsePiTuiWebAccessStatus,
}

/**
 * The `getStatus` invocation both contributions derive from. The Host
 * registers this exact object; the Client mounts this exact object.
 */
export const PI_TUI_WEB_ACCESS_GET_STATUS: InvocationDescriptor = {
  id: PI_TUI_WEB_ACCESS_GET_STATUS_ENDPOINT,
  service: PI_TUI_WEB_ACCESS_NAMESPACE,
  namespace: PI_TUI_WEB_ACCESS_NAMESPACE,
  method: 'getStatus',
  invocation: { kind: 'direct' },
  parameters: [],
  result: PI_TUI_WEB_ACCESS_STATUS_CODEC,
}

/**
 * The `setEnabled` invocation both contributions derive from. `enabled` is one
 * required boolean: the Host Gateway decodes it through {@link BOOLEAN_CODEC},
 * so a malformed value is refused at the wire boundary and never reaches the
 * toggle.
 */
export const PI_TUI_WEB_ACCESS_SET_ENABLED: InvocationDescriptor = {
  id: PI_TUI_WEB_ACCESS_SET_ENABLED_ENDPOINT,
  service: PI_TUI_WEB_ACCESS_NAMESPACE,
  namespace: PI_TUI_WEB_ACCESS_NAMESPACE,
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
  result: PI_TUI_WEB_ACCESS_STATUS_CODEC,
}

/** The exact wire arguments both contributions agree on. */
export interface PiTuiWebAccessSetEnabledArguments {
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
    'piTuiWebAccess/getStatus': () => Promise<PiTuiWebAccessCallResult>
    'piTuiWebAccess/setEnabled': (enabled: boolean) => Promise<PiTuiWebAccessCallResult>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiWebAccess': {
      getStatus: () => Promise<PiTuiWebAccessCallResult>
      setEnabled: (enabled: boolean) => Promise<PiTuiWebAccessCallResult>
    }
  }
}
