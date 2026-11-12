/**
 * The private `piTuiAuthorization` Remote contract (M6-1 F7A): FOUR
 * handwritten invocation descriptors that BOTH the Host service and the Client
 * contribution derive from, so a namespace/method/parameter/frame drift is
 * impossible by construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiAuthorization/list
 * endpoint   @xmoon76/dsh-pi-tui#piTuiAuthorization/run
 * endpoint   @xmoon76/dsh-pi-tui#piTuiAuthorization/respond
 * endpoint   @xmoon76/dsh-pi-tui#piTuiAuthorization/cancel
 * service    piTuiAuthorization   (Host Cordis service key)
 * namespace  piTuiAuthorization   (wire namespace)
 * method     list(signal)                    -> AuthorizationTargetsSnapshot
 * method     run(key, method, signal)        -> stream of AuthorizationWireFrame
 * method     respond(attemptId, promptId, answer, signal) -> void
 * method     cancel(attemptId, signal)       -> void
 * ```
 *
 * The descriptors are registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * DOWNLINK CODEC HONESTY: the Client stream handle yields every downlink item
 * RAW (the `result` codec is not applied to stream items), so the Client-side
 * adapter MUST call {@link parsePiTuiAuthorizationFrame} on every frame before
 * trusting it. The same validator backs the descriptor's `result` codec.
 *
 * SECRET BOUNDARY: no frame carries a token, credential record or Host object.
 * {@link parsePiTuiAuthorizationFrame} refuses any extra field, so a frame that
 * tries to add one is rejected instead of silently forwarded. The `respond`
 * answer is the ONLY secret-bearing direction (a user-typed secret prompt
 * answer, once, over the authenticated carrier) and it is never echoed back in
 * an event.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-authorization-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  RemoteStreamHandle,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationFlowEvent,
  AuthorizationFlowTarget,
  AuthorizationNoticeEvent,
  AuthorizationPromptEvent,
} from '../config-port.ts'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_AUTHORIZATION_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private service. */
export const PI_TUI_AUTHORIZATION_NAMESPACE = 'piTuiAuthorization'

/** The roster read's stable endpoint identity. */
export const PI_TUI_AUTHORIZATION_LIST_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiAuthorization/list'

/** The one-attempt stream's stable endpoint identity. */
export const PI_TUI_AUTHORIZATION_RUN_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiAuthorization/run'

/** The prompt answer's stable endpoint identity. */
export const PI_TUI_AUTHORIZATION_RESPOND_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiAuthorization/respond'

/** The attempt cancellation request's stable endpoint identity. */
export const PI_TUI_AUTHORIZATION_CANCEL_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiAuthorization/cancel'

/**
 * The bound on one attempt's frame queue. A host flow that produces more
 * frames than this before the Client drains them is a bridge fault: the Host
 * aborts the attempt and publishes one `failed` terminal instead of silently
 * dropping a prompt or the settlement. There is no cross-Client replay buffer.
 */
export const MAX_PI_TUI_AUTHORIZATION_ATTEMPT_FRAMES = 64

/** The first frame of one `run` stream. `started` names the Host bridge
 *  attempt; it is NOT an official admission acknowledgement (the official
 *  `authorization.begin` may still refuse with NO_FLOW/UNKNOWN_METHOD/
 *  ALREADY_IN_FLIGHT and settle the attempt as `failed`). */
export interface PiTuiAuthorizationStartedFrame {
  readonly kind: 'started'
  readonly attemptId: string
}

/**
 * One frame of the private attempt stream, in the Host's yield order:
 * `started` first, then notices/prompts/withdrawals, then exactly one terminal
 * (`settled` or — never from the Direct path — a transport `unconfirmed`).
 */
export type AuthorizationWireFrame = PiTuiAuthorizationStartedFrame | AuthorizationFlowEvent

/** The roster read's detached result: a definite unavailable Host service is
 *  distinct from an ordinary empty roster. */
export type AuthorizationTargetsSnapshot =
  | { readonly kind: 'ready'; readonly targets: readonly AuthorizationFlowTarget[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The business result of the two unary write methods (void on success). */
export type PiTuiAuthorizationVoidResult = RemoteResult<void>

const STARTED_FRAME_LABEL = 'piTuiAuthorization/run frame (started)'
const NOTICE_FRAME_LABEL = 'piTuiAuthorization/run frame (notice)'
const PROMPT_FRAME_LABEL = 'piTuiAuthorization/run frame (prompt)'
const WITHDRAWN_FRAME_LABEL = 'piTuiAuthorization/run frame (prompt-withdrawn)'
const SETTLED_FRAME_LABEL = 'piTuiAuthorization/run frame (settled)'
const UNCONFIRMED_FRAME_LABEL = 'piTuiAuthorization/run frame (unconfirmed)'
const TARGET_LABEL = 'piTuiAuthorization/list target'

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
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label}: expected a non-empty string`)
  }
  return value
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return nonEmptyString(value, label)
}

function assertOnlyOptional(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new TypeError(`${label}: unexpected field ${JSON.stringify(key)}`)
  }
}

function parseNotice(value: unknown): AuthorizationNoticeEvent {
  const record = recordOf(value, NOTICE_FRAME_LABEL)
  assertOnlyOptional(record, ['message', 'url', 'code'], NOTICE_FRAME_LABEL)
  requiredKeys(record, ['message'], NOTICE_FRAME_LABEL)
  return {
    message: nonEmptyString(record.message, `${NOTICE_FRAME_LABEL} message`),
    ...(record.url === undefined ? {} : { url: nonEmptyString(record.url, `${NOTICE_FRAME_LABEL} url`) }),
    ...(record.code === undefined ? {} : { code: nonEmptyString(record.code, `${NOTICE_FRAME_LABEL} code`) }),
  }
}

function parsePromptOptions(value: unknown): readonly { id: string; label: string; description?: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${PROMPT_FRAME_LABEL}: a select prompt needs a non-empty options array`)
  }
  return value.map((entry) => {
    const option = recordOf(entry, `${PROMPT_FRAME_LABEL} option`)
    assertOnlyOptional(option, ['id', 'label', 'description'], `${PROMPT_FRAME_LABEL} option`)
    requiredKeys(option, ['id', 'label'], `${PROMPT_FRAME_LABEL} option`)
    return {
      id: nonEmptyString(option.id, `${PROMPT_FRAME_LABEL} option id`),
      label: nonEmptyString(option.label, `${PROMPT_FRAME_LABEL} option label`),
      ...(option.description === undefined
        ? {}
        : { description: nonEmptyString(option.description, `${PROMPT_FRAME_LABEL} option description`) }),
    }
  })
}

function parsePrompt(value: unknown): AuthorizationPromptEvent {
  const record = recordOf(value, PROMPT_FRAME_LABEL)
  const kind = record.kind
  if (kind !== 'text' && kind !== 'secret' && kind !== 'select') {
    throw new TypeError(`${PROMPT_FRAME_LABEL}: the prompt kind must be text, secret or select`)
  }
  if (kind === 'select') {
    assertOnlyOptional(record, ['kind', 'message', 'options'], PROMPT_FRAME_LABEL)
    requiredKeys(record, ['message', 'options'], PROMPT_FRAME_LABEL)
    return {
      kind: 'select',
      message: nonEmptyString(record.message, `${PROMPT_FRAME_LABEL} message`),
      options: parsePromptOptions(record.options),
    }
  }
  assertOnlyOptional(record, ['kind', 'message', 'placeholder'], PROMPT_FRAME_LABEL)
  requiredKeys(record, ['message'], PROMPT_FRAME_LABEL)
  return {
    kind,
    message: nonEmptyString(record.message, `${PROMPT_FRAME_LABEL} message`),
    ...(record.placeholder === undefined
      ? {}
      : { placeholder: nonEmptyString(record.placeholder, `${PROMPT_FRAME_LABEL} placeholder`) }),
  }
}

/**
 * Validate and detach ONE `piTuiAuthorization/run` frame. This is the ONE
 * structural validator of the frame union: the descriptor's `result` codec uses
 * it, and the Client adapter must call it on every downlink item because the
 * framework does not decode stream items (see the module JSDoc).
 *
 * The validation is exact: an undeclared field (a token, a credential record, a
 * Host identifier) makes the frame invalid instead of passing it through.
 */
export function parsePiTuiAuthorizationFrame(value: unknown): AuthorizationWireFrame {
  const record = recordOf(value, 'piTuiAuthorization/run frame')
  const kind = record.kind
  const attemptId = nonEmptyString(record.attemptId, 'piTuiAuthorization/run frame attemptId')
  switch (kind) {
    case 'started': {
      exactKeys(record, ['kind', 'attemptId'], STARTED_FRAME_LABEL)
      return { kind: 'started', attemptId }
    }
    case 'notice': {
      exactKeys(record, ['kind', 'attemptId', 'notice'], NOTICE_FRAME_LABEL)
      requiredKeys(record, ['notice'], NOTICE_FRAME_LABEL)
      return { kind: 'notice', attemptId, notice: parseNotice(record.notice) }
    }
    case 'prompt': {
      exactKeys(record, ['kind', 'attemptId', 'promptId', 'prompt'], PROMPT_FRAME_LABEL)
      requiredKeys(record, ['promptId', 'prompt'], PROMPT_FRAME_LABEL)
      return {
        kind: 'prompt',
        attemptId,
        promptId: nonEmptyString(record.promptId, `${PROMPT_FRAME_LABEL} promptId`),
        prompt: parsePrompt(record.prompt),
      }
    }
    case 'prompt-withdrawn': {
      exactKeys(record, ['kind', 'attemptId', 'promptId'], WITHDRAWN_FRAME_LABEL)
      requiredKeys(record, ['promptId'], WITHDRAWN_FRAME_LABEL)
      return {
        kind: 'prompt-withdrawn',
        attemptId,
        promptId: nonEmptyString(record.promptId, `${WITHDRAWN_FRAME_LABEL} promptId`),
      }
    }
    case 'settled': {
      exactKeys(record, ['kind', 'attemptId', 'status', 'code', 'message'], SETTLED_FRAME_LABEL)
      requiredKeys(record, ['status'], SETTLED_FRAME_LABEL)
      const status = record.status
      if (status !== 'authorized' && status !== 'cancelled' && status !== 'failed') {
        throw new TypeError(`${SETTLED_FRAME_LABEL}: the status must be authorized, cancelled or failed`)
      }
      const code = optionalNonEmptyString(record.code, `${SETTLED_FRAME_LABEL} code`)
      const message = optionalNonEmptyString(record.message, `${SETTLED_FRAME_LABEL} message`)
      return {
        kind: 'settled',
        attemptId,
        status,
        ...(code === undefined ? {} : { code }),
        ...(message === undefined ? {} : { message }),
      }
    }
    case 'unconfirmed': {
      exactKeys(record, ['kind', 'attemptId', 'reason'], UNCONFIRMED_FRAME_LABEL)
      requiredKeys(record, ['reason'], UNCONFIRMED_FRAME_LABEL)
      return {
        kind: 'unconfirmed',
        attemptId,
        reason: nonEmptyString(record.reason, `${UNCONFIRMED_FRAME_LABEL} reason`),
      }
    }
    default:
      throw new TypeError('piTuiAuthorization/run frame: the kind is unknown')
  }
}

/**
 * Validate and detach ONE roster target. The Host is the only producer, but a
 * target still crosses the wire; exactly the declared fields are accepted so no
 * credential value, Host object or provider-internal path can ride along.
 */
export function parsePiTuiAuthorizationTarget(value: unknown): AuthorizationFlowTarget {
  const record = recordOf(value, TARGET_LABEL)
  assertOnlyOptional(record, ['kind', 'route', 'key', 'label', 'methods', 'inFlight'], TARGET_LABEL)
  requiredKeys(record, ['kind', 'key', 'label', 'methods', 'inFlight'], TARGET_LABEL)
  if (record.kind !== 'authorization') {
    throw new TypeError(`${TARGET_LABEL}: the kind must be authorization`)
  }
  if (!Array.isArray(record.methods)) {
    throw new TypeError(`${TARGET_LABEL}: methods must be an array`)
  }
  if (typeof record.inFlight !== 'boolean') {
    throw new TypeError(`${TARGET_LABEL}: inFlight must be a boolean`)
  }
  return {
    kind: 'authorization',
    ...(record.route === undefined ? {} : { route: nonEmptyString(record.route, `${TARGET_LABEL} route`) }),
    key: nonEmptyString(record.key, `${TARGET_LABEL} key`),
    label: nonEmptyString(record.label, `${TARGET_LABEL} label`),
    methods: record.methods.map((entry) => {
      const method = recordOf(entry, `${TARGET_LABEL} method`)
      exactKeys(method, ['id', 'label'], `${TARGET_LABEL} method`)
      requiredKeys(method, ['id', 'label'], `${TARGET_LABEL} method`)
      return {
        id: nonEmptyString(method.id, `${TARGET_LABEL} method id`),
        label: nonEmptyString(method.label, `${TARGET_LABEL} method label`),
      }
    }),
    inFlight: record.inFlight,
  }
}

/** Validate and detach one roster snapshot. */
export function parsePiTuiAuthorizationTargetsSnapshot(value: unknown): AuthorizationTargetsSnapshot {
  const record = recordOf(value, 'piTuiAuthorization/list result')
  if (record.kind === 'unavailable') {
    exactKeys(record, ['kind', 'reason'], 'piTuiAuthorization/list result')
    return { kind: 'unavailable', reason: nonEmptyString(record.reason, 'piTuiAuthorization/list result reason') }
  }
  if (record.kind !== 'ready') {
    throw new TypeError('piTuiAuthorization/list result: the kind must be ready or unavailable')
  }
  exactKeys(record, ['kind', 'targets'], 'piTuiAuthorization/list result')
  if (!Array.isArray(record.targets)) {
    throw new TypeError('piTuiAuthorization/list result: targets must be an array')
  }
  return { kind: 'ready', targets: record.targets.map(parsePiTuiAuthorizationTarget) }
}

/** The `respond` answer: the typed text, or `null` for a human decline. */
export type PiTuiAuthorizationRespondAnswer = string | null

function parseRespondAnswer(value: unknown): PiTuiAuthorizationRespondAnswer {
  if (value === null) return null
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('piTuiAuthorization/respond answer: expected a non-empty string or null')
  }
  return value
}

function codecOf<T>(label: string, parse: (value: unknown) => T): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol: `@xmoon76/dsh-pi-tui#${label}`,
    create: () => ({ parse }),
    decode: parse,
  }
}

function stringCodec(label: string): TypertCodec {
  return codecOf(label, value => nonEmptyString(value, `piTuiAuthorization ${label}`))
}

const FRAME_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_AUTHORIZATION_RUN_ENDPOINT}:frame`,
  create: () => ({ parse: parsePiTuiAuthorizationFrame }),
  decode: parsePiTuiAuthorizationFrame,
}

const TARGETS_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_AUTHORIZATION_LIST_ENDPOINT}:result`,
  create: () => ({ parse: parsePiTuiAuthorizationTargetsSnapshot }),
  decode: parsePiTuiAuthorizationTargetsSnapshot,
}

const VOID_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiAuthorization:void',
  create: () => ({
    parse: (value: unknown): void => {
      if (value !== undefined && value !== null) {
        throw new TypeError('piTuiAuthorization: the result must be empty')
      }
      return undefined
    },
  }),
  decode: (value: unknown): unknown => {
    if (value !== undefined && value !== null) {
      throw new TypeError('piTuiAuthorization: the result must be empty')
    }
    return undefined
  },
}

/** The roster read invocation both contributions derive from. */
export const PI_TUI_AUTHORIZATION_LIST: InvocationDescriptor = {
  id: PI_TUI_AUTHORIZATION_LIST_ENDPOINT,
  service: PI_TUI_AUTHORIZATION_NAMESPACE,
  namespace: PI_TUI_AUTHORIZATION_NAMESPACE,
  method: 'list',
  invocation: { kind: 'direct' },
  parameters: [],
  cancellation: { parameter: 'signal' },
  result: TARGETS_CODEC,
}

/**
 * The one-attempt stream invocation. `method` is optional at the business
 * level (`acceptsUndefined`): an absent method lets the official service pick
 * the flow's first method.
 */
export const PI_TUI_AUTHORIZATION_RUN: InvocationDescriptor = {
  id: PI_TUI_AUTHORIZATION_RUN_ENDPOINT,
  service: PI_TUI_AUTHORIZATION_NAMESPACE,
  namespace: PI_TUI_AUTHORIZATION_NAMESPACE,
  method: 'run',
  mode: 'stream',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'key', wire: 'key', source: 'json', codec: stringCodec('run key') },
    {
      name: 'method',
      wire: 'method',
      source: 'json',
      acceptsUndefined: true,
      codec: stringCodec('run method'),
    },
  ],
  cancellation: { parameter: 'signal' },
  result: FRAME_CODEC,
}

/** The exact pending-prompt answer invocation. */
export const PI_TUI_AUTHORIZATION_RESPOND: InvocationDescriptor = {
  id: PI_TUI_AUTHORIZATION_RESPOND_ENDPOINT,
  service: PI_TUI_AUTHORIZATION_NAMESPACE,
  namespace: PI_TUI_AUTHORIZATION_NAMESPACE,
  method: 'respond',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'attemptId', wire: 'attemptId', source: 'json', codec: stringCodec('respond attemptId') },
    { name: 'promptId', wire: 'promptId', source: 'json', codec: stringCodec('respond promptId') },
    {
      name: 'answer',
      wire: 'answer',
      source: 'json',
      codec: codecOf('respond answer', parseRespondAnswer),
    },
  ],
  cancellation: { parameter: 'signal' },
  result: VOID_CODEC,
}

/** The exact-attempt cancellation request invocation. */
export const PI_TUI_AUTHORIZATION_CANCEL: InvocationDescriptor = {
  id: PI_TUI_AUTHORIZATION_CANCEL_ENDPOINT,
  service: PI_TUI_AUTHORIZATION_NAMESPACE,
  namespace: PI_TUI_AUTHORIZATION_NAMESPACE,
  method: 'cancel',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'attemptId', wire: 'attemptId', source: 'json', codec: stringCodec('cancel attemptId') },
  ],
  cancellation: { parameter: 'signal' },
  result: VOID_CODEC,
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * these descriptors together with the file-reference, terminal-progress,
 * Web-access, Shell and Skills ones — lives in `pi-tui-remote-contribution.ts`.
 */

/** The one-attempt stream a Client opens (downlink only; no uplink). */
export type PiTuiAuthorizationRunStream = RemoteStreamHandle<AuthorizationWireFrame, never>

/** The `list` call result as the Client receives it. */
export type PiTuiAuthorizationTargetsCall = RemoteResult<AuthorizationTargetsSnapshot>

/** The mounted Client namespace slice this adapter consumes. */
export interface PiTuiAuthorizationNamespace {
  list(signal?: AbortSignal): Promise<PiTuiAuthorizationTargetsCall>
  run(key: string, method: string | undefined, signal?: AbortSignal): PiTuiAuthorizationRunStream
  respond(
    attemptId: string,
    promptId: string,
    answer: PiTuiAuthorizationRespondAnswer,
    signal?: AbortSignal,
  ): Promise<PiTuiAuthorizationVoidResult>
  cancel(attemptId: string, signal?: AbortSignal): Promise<PiTuiAuthorizationVoidResult>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiAuthorization/list': (signal?: AbortSignal) => Promise<PiTuiAuthorizationTargetsCall>
    'piTuiAuthorization/run': (
      key: string,
      method: string | undefined,
      signal?: AbortSignal,
    ) => PiTuiAuthorizationRunStream
    'piTuiAuthorization/respond': (
      attemptId: string,
      promptId: string,
      answer: PiTuiAuthorizationRespondAnswer,
      signal?: AbortSignal,
    ) => Promise<PiTuiAuthorizationVoidResult>
    'piTuiAuthorization/cancel': (
      attemptId: string,
      signal?: AbortSignal,
    ) => Promise<PiTuiAuthorizationVoidResult>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiAuthorization': {
      list: (signal?: AbortSignal) => Promise<PiTuiAuthorizationTargetsCall>
      run: (
        key: string,
        method: string | undefined,
        signal?: AbortSignal,
      ) => PiTuiAuthorizationRunStream
      respond: (
        attemptId: string,
        promptId: string,
        answer: PiTuiAuthorizationRespondAnswer,
        signal?: AbortSignal,
      ) => Promise<PiTuiAuthorizationVoidResult>
      cancel: (
        attemptId: string,
        signal?: AbortSignal,
      ) => Promise<PiTuiAuthorizationVoidResult>
    }
  }
}
