/**
 * The private `piTuiSessionPolicy` Remote contract (M6-1 F8): TWO handwritten
 * unary invocation descriptors that BOTH the Host service and the Client
 * contribution derive from, so a namespace/method/parameter/frame drift is
 * impossible by construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiSessionPolicy/read
 * endpoint   @xmoon76/dsh-pi-tui#piTuiSessionPolicy/setApproval
 * service    piTuiSessionPolicy   (Host Cordis service key)
 * namespace  piTuiSessionPolicy   (wire namespace)
 * method     read(sessionId, signal)          -> SessionPolicyRead
 * method     setApproval(sessionId, policy, signal)
 *                                        -> applied | refused
 * ```
 *
 * The official Host `ctx.approval` / `ctx.sandboxPolicy` services remain the
 * ONLY policy authorities: this namespace is a DTO transport bridge. It never
 * carries a Host Session or Agent object, a workspace path, a token or a
 * permission-preset table, and it has no `setSandboxMode`, `applyPreset`,
 * `watch` or `effectivePolicy` method. `unconfirmed` is a CLIENT-side
 * classification of a lost/dispatched write: the Host never fabricates it.
 *
 * The descriptors are registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) as part of the
 * package's ONE contribution — never discovered from source-mode decorators,
 * never generated, never a second literal.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-session-policy-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  ApprovalPolicy,
  PolicySide,
  SandboxMode,
  SessionPolicyRead,
  SessionPolicySetOutcome,
} from '../session-policy-port.ts'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_SESSION_POLICY_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private service. */
export const PI_TUI_SESSION_POLICY_NAMESPACE = 'piTuiSessionPolicy'

/** The read endpoint's stable identity. */
export const PI_TUI_SESSION_POLICY_READ_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiSessionPolicy/read'

/** The approval write endpoint's stable identity. */
export const PI_TUI_SESSION_POLICY_SET_APPROVAL_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiSessionPolicy/setApproval'

const READ_LABEL = 'piTuiSessionPolicy/read result'
const SET_LABEL = 'piTuiSessionPolicy/setApproval result'
const SESSION_ID_LABEL = 'piTuiSessionPolicy sessionId'
const POLICY_LABEL = 'piTuiSessionPolicy policy'

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

/** Validate one non-empty session id as wire text and return it. */
export function parseSessionPolicySessionId(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${SESSION_ID_LABEL}: expected a non-empty string`)
  }
  return value
}

/** Validate one approval policy against the closed official vocabulary. */
export function parseSessionApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value !== 'ask' && value !== 'never') {
    throw new TypeError(`${POLICY_LABEL}: expected ask or never`)
  }
  return value
}

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

function parseSandboxMode(value: unknown, label: string): SandboxMode {
  if (!SANDBOX_MODES.includes(value as SandboxMode)) {
    throw new TypeError(`${label}: unknown sandbox mode ${JSON.stringify(value)}`)
  }
  return value as SandboxMode
}

/** Validate and detach one knob's wire side (closed state union, exact keys). */
function parsePolicySide<T extends string>(
  value: unknown,
  parseValue: (candidate: unknown, label: string) => T,
  label: string,
): PolicySide<T> {
  const record = recordOf(value, label)
  if (record.state === 'unavailable') {
    exactKeys(record, ['state', 'reason'], label)
    if (record.reason !== 'service-not-installed') {
      throw new TypeError(`${label}: unknown unavailable reason ${JSON.stringify(record.reason)}`)
    }
    return { state: 'unavailable', reason: 'service-not-installed' }
  }
  if (record.state !== 'ready') {
    throw new TypeError(`${label}: unknown state ${JSON.stringify(record.state)}`)
  }
  if (Object.hasOwn(record, 'override')) {
    exactKeys(record, ['state', 'effective', 'override'], label)
    return { state: 'ready', effective: parseValue(record.effective, label), override: parseValue(record.override, label) }
  }
  exactKeys(record, ['state', 'effective'], label)
  return { state: 'ready', effective: parseValue(record.effective, label) }
}

/**
 * Validate and detach the WHOLE `read` result. An unusable frame (an extra
 * field, an unknown enum, a guessed default where the Host stated none) fails
 * the whole read: the adapter must never reshape a partially-valid frame into
 * an authoritative answer.
 */
export function parseSessionPolicyRead(value: unknown): SessionPolicyRead {
  const record = recordOf(value, READ_LABEL)
  if (record.kind === 'unavailable') {
    exactKeys(record, ['kind', 'sessionId', 'reason'], READ_LABEL)
    if (record.reason !== 'session-not-live') {
      throw new TypeError(`${READ_LABEL}: unknown unavailable reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'unavailable', sessionId: parseSessionPolicySessionId(record.sessionId), reason: 'session-not-live' }
  }
  if (record.kind !== 'ready') {
    throw new TypeError(`${READ_LABEL}: unknown kind ${JSON.stringify(record.kind)}`)
  }
  exactKeys(record, ['kind', 'sessionId', 'approval', 'sandbox'], READ_LABEL)
  requiredKeys(record, ['kind', 'sessionId', 'approval', 'sandbox'], READ_LABEL)
  return {
    kind: 'ready',
    sessionId: parseSessionPolicySessionId(record.sessionId),
    approval: parsePolicySide(record.approval, parseSessionApprovalPolicy, `${READ_LABEL} approval side`),
    sandbox: parsePolicySide(record.sandbox, parseSandboxMode, `${READ_LABEL} sandbox side`),
  }
}

/** The Host-reported wire outcome of a setApproval: never `unconfirmed`. */
export type SessionPolicySetWireOutcome = Extract<SessionPolicySetOutcome, { kind: 'applied' | 'refused' }>

const SET_REFUSAL_REASONS = ['session-not-live', 'agent-not-live', 'approval-unavailable'] as const

/** Validate and detach the `setApproval` result (closed union, exact keys). */
export function parseSessionPolicySetWireOutcome(value: unknown): SessionPolicySetWireOutcome {
  const record = recordOf(value, SET_LABEL)
  if (record.kind === 'applied') {
    exactKeys(record, ['kind', 'sessionId'], SET_LABEL)
    return { kind: 'applied', sessionId: parseSessionPolicySessionId(record.sessionId) }
  }
  if (record.kind === 'refused') {
    exactKeys(record, ['kind', 'reason'], SET_LABEL)
    if (!SET_REFUSAL_REASONS.includes(record.reason as (typeof SET_REFUSAL_REASONS)[number])) {
      throw new TypeError(`${SET_LABEL}: unknown refusal reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'refused', reason: record.reason as (typeof SET_REFUSAL_REASONS)[number] }
  }
  throw new TypeError(`${SET_LABEL}: unknown kind ${JSON.stringify(record.kind)}`)
}

const READ_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SESSION_POLICY_READ_ENDPOINT}:result`,
  create: () => ({ parse: parseSessionPolicyRead }),
  decode: parseSessionPolicyRead,
}

const SET_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SESSION_POLICY_SET_APPROVAL_ENDPOINT}:result`,
  create: () => ({ parse: parseSessionPolicySetWireOutcome }),
  decode: parseSessionPolicySetWireOutcome,
}

const SESSION_ID_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SESSION_POLICY_READ_ENDPOINT}:sessionId`,
  create: () => ({ parse: parseSessionPolicySessionId }),
  decode: parseSessionPolicySessionId,
}

const POLICY_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SESSION_POLICY_SET_APPROVAL_ENDPOINT}:policy`,
  create: () => ({ parse: parseSessionApprovalPolicy }),
  decode: parseSessionApprovalPolicy,
}

/** The exact-Session read invocation both contributions derive from. */
export const PI_TUI_SESSION_POLICY_READ: InvocationDescriptor = {
  id: PI_TUI_SESSION_POLICY_READ_ENDPOINT,
  service: PI_TUI_SESSION_POLICY_NAMESPACE,
  namespace: PI_TUI_SESSION_POLICY_NAMESPACE,
  method: 'read',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'sessionId', wire: 'sessionId', source: 'json', codec: SESSION_ID_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: READ_CODEC,
}

/** The exact-Session approval write invocation both contributions derive from. */
export const PI_TUI_SESSION_POLICY_SET_APPROVAL: InvocationDescriptor = {
  id: PI_TUI_SESSION_POLICY_SET_APPROVAL_ENDPOINT,
  service: PI_TUI_SESSION_POLICY_NAMESPACE,
  namespace: PI_TUI_SESSION_POLICY_NAMESPACE,
  method: 'setApproval',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'sessionId', wire: 'sessionId', source: 'json', codec: SESSION_ID_CODEC },
    { name: 'policy', wire: 'policy', source: 'json', codec: POLICY_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: SET_CODEC,
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * these descriptors together with the file-reference, terminal-progress,
 * Web-access, Shell, Skills, Authorization and CredentialRecords ones — lives
 * in `pi-tui-remote-contribution.ts`.
 */

/** The `read` call result as the Client receives it. */
export type PiTuiSessionPolicyReadCall = RemoteResult<SessionPolicyRead>

/** The `setApproval` call result as the Client receives it. */
export type PiTuiSessionPolicySetApprovalCall = RemoteResult<SessionPolicySetWireOutcome>

/** The mounted Client namespace slice this adapter consumes. */
export interface PiTuiSessionPolicyNamespace {
  read(sessionId: string, signal?: AbortSignal): Promise<PiTuiSessionPolicyReadCall>
  setApproval(sessionId: string, policy: ApprovalPolicy, signal?: AbortSignal): Promise<PiTuiSessionPolicySetApprovalCall>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiSessionPolicy/read': (sessionId: string, signal?: AbortSignal) => Promise<PiTuiSessionPolicyReadCall>
    'piTuiSessionPolicy/setApproval': (sessionId: string, policy: ApprovalPolicy, signal?: AbortSignal) => Promise<PiTuiSessionPolicySetApprovalCall>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiSessionPolicy': {
      read: (sessionId: string, signal?: AbortSignal) => Promise<PiTuiSessionPolicyReadCall>
      setApproval: (sessionId: string, policy: ApprovalPolicy, signal?: AbortSignal) => Promise<PiTuiSessionPolicySetApprovalCall>
    }
  }
}
