/**
 * The private Host one-shot Shell and Host completion wire contract. One shared
 * descriptor table serves both the Host registration and Client mount.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-host-user-shell-contract
 */

import { constants as osConstants } from 'node:os'
import type {
  InvocationDescriptor,
  RemoteResult,
  RemoteStreamHandle,
  TypertCodec,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import type { HostShellCompletionOutcome, HostShellCompletionRequest } from '../host-shell-completion-port.ts'
import type { HostUserShellExit, HostUserShellPolicy } from '../host-user-shell-port.ts'

export const PI_TUI_HOST_USER_SHELL_NAMESPACE = 'piTuiHostUserShell'
export const PI_TUI_HOST_USER_SHELL_RUN_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run'
export const PI_TUI_HOST_USER_SHELL_COMPLETE_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiHostUserShell/complete'
export const MAX_HOST_USER_SHELL_FRAME_BYTES = 32 * 1024
export const MAX_HOST_SHELL_COMPLETION_ITEMS = 50
export const MAX_HOST_SHELL_COMPLETION_ITEM_BYTES = 4 * 1024
export const MAX_HOST_SHELL_COMPLETION_RESULT_BYTES = 64 * 1024

export interface HostUserShellAck {
  readonly kind: 'ack'
  readonly requestId: string
  readonly seq: number
}

export type HostUserShellFrame =
  | {
    readonly kind: 'refused'
    readonly requestId: string
    readonly reason: 'scope-unavailable' | 'policy-unavailable' | 'invalid-request'
    readonly message: string
  }
  | {
    readonly kind: 'started'
    readonly requestId: string
    readonly sessionId: string
    readonly policy: HostUserShellPolicy
  }
  | {
    readonly kind: 'output'
    readonly requestId: string
    readonly seq: number
    readonly stream: 'stdout' | 'stderr'
    readonly base64: string
  }
  | {
    readonly kind: 'settled'
    readonly requestId: string
    readonly exit: HostUserShellExit
    readonly aborted: boolean
    readonly sandboxDenied: boolean
  }
  | {
    readonly kind: 'failed'
    readonly requestId: string
    readonly phase: 'spawn' | 'sandbox-runner' | 'transport-internal'
    readonly message: string
  }

export interface HostUserShellRunArguments {
  readonly sessionId: string
  readonly requestId: string
  readonly expectedCwd: string
  readonly command: string
  readonly policy: HostUserShellPolicy
}

export type HostUserShellRunResult = RemoteStreamHandle<HostUserShellFrame, HostUserShellAck>
export type HostShellCompletionCallResult = RemoteResult<HostShellCompletionOutcome>
export type PiTuiHostUserShellNamespace = TypertRemoteNamespace<'piTuiHostUserShell'>

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const signalNames = new Set(Object.keys(osConstants.signals))

type WireRecord = Record<string, unknown>

function recordOf(value: unknown, label: string): WireRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}: expected an object`)
  }
  return value as WireRecord
}

function exactKeys(record: WireRecord, expected: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) throw new TypeError(`${label}: unexpected field ${JSON.stringify(key)}`)
  }
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${label}: missing field ${JSON.stringify(key)}`)
  }
}

function stringOf(value: unknown, label: string, options: { readonly empty?: boolean } = {}): string {
  if (typeof value !== 'string' || (options.empty !== true && value.length === 0)) {
    throw new TypeError(`${label}: expected a${options.empty === true ? '' : ' non-empty'} string`)
  }
  return value
}

function requestIdOf(value: unknown, label: string): string {
  const requestId = stringOf(value, label)
  if (!UUID_V4_PATTERN.test(requestId)) throw new TypeError(`${label}: expected a UUID v4`)
  return requestId
}

function safeIntegerOf(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label}: expected a safe integer >= ${minimum}`)
  }
  return value as number
}

function stringCodec(typeSymbol: string, options: { readonly allowEmpty?: boolean } = {}): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value: unknown): string => stringOf(value, typeSymbol, { empty: options.allowEmpty }),
    }),
  }
}

function requestIdCodec(typeSymbol: string): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse: value => requestIdOf(value, typeSymbol) }),
  }
}

function policyOf(value: unknown, label: string): HostUserShellPolicy {
  if (value !== 'bypass' && value !== 'sandbox') throw new TypeError(`${label}: expected bypass or sandbox`)
  return value
}

function parseExit(value: unknown): HostUserShellExit {
  const exit = recordOf(value, 'piTuiHostUserShell/run: exit')
  if (exit.kind === 'exit') {
    exactKeys(exit, ['kind', 'code'], 'piTuiHostUserShell/run: exit')
    if (!Number.isSafeInteger(exit.code) || (exit.code as number) < 0 || (exit.code as number) > 255) {
      throw new TypeError('piTuiHostUserShell/run: exit code must be an integer from 0 through 255')
    }
    return { kind: 'exit', code: exit.code as number }
  }
  if (exit.kind === 'signal') {
    exactKeys(exit, ['kind', 'signal'], 'piTuiHostUserShell/run: exit')
    const signal = stringOf(exit.signal, 'piTuiHostUserShell/run: exit signal')
    if (!signalNames.has(signal)) throw new TypeError('piTuiHostUserShell/run: exit signal is invalid')
    return { kind: 'signal', signal }
  }
  throw new TypeError('piTuiHostUserShell/run: exit kind must be exit or signal')
}

function parseBase64(value: unknown): string {
  const base64 = stringOf(value, 'piTuiHostUserShell/run: output base64')
  if (base64.length > Math.ceil(MAX_HOST_USER_SHELL_FRAME_BYTES / 3) * 4) {
    throw new TypeError('piTuiHostUserShell/run: output exceeds the 32 KiB raw frame limit')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_HOST_USER_SHELL_FRAME_BYTES || bytes.toString('base64') !== base64) {
    throw new TypeError('piTuiHostUserShell/run: output base64 is invalid or exceeds the 32 KiB raw frame limit')
  }
  return base64
}

/** The single strict decoder for every item received from the stream. */
export function parseHostUserShellFrame(value: unknown): HostUserShellFrame {
  const frame = recordOf(value, 'piTuiHostUserShell/run: frame')
  if (frame.kind === 'refused') {
    exactKeys(frame, ['kind', 'requestId', 'reason', 'message'], 'piTuiHostUserShell/run: refused frame')
    if (frame.reason !== 'scope-unavailable' && frame.reason !== 'policy-unavailable' && frame.reason !== 'invalid-request') {
      throw new TypeError('piTuiHostUserShell/run: refused reason is invalid')
    }
    return {
      kind: 'refused',
      requestId: requestIdOf(frame.requestId, 'piTuiHostUserShell/run: requestId'),
      reason: frame.reason,
      message: stringOf(frame.message, 'piTuiHostUserShell/run: refusal message'),
    }
  }
  if (frame.kind === 'started') {
    exactKeys(frame, ['kind', 'requestId', 'sessionId', 'policy'], 'piTuiHostUserShell/run: started frame')
    return {
      kind: 'started',
      requestId: requestIdOf(frame.requestId, 'piTuiHostUserShell/run: requestId'),
      sessionId: stringOf(frame.sessionId, 'piTuiHostUserShell/run: sessionId'),
      policy: policyOf(frame.policy, 'piTuiHostUserShell/run: policy'),
    }
  }
  if (frame.kind === 'output') {
    exactKeys(frame, ['kind', 'requestId', 'seq', 'stream', 'base64'], 'piTuiHostUserShell/run: output frame')
    if (frame.stream !== 'stdout' && frame.stream !== 'stderr') throw new TypeError('piTuiHostUserShell/run: output stream is invalid')
    return {
      kind: 'output',
      requestId: requestIdOf(frame.requestId, 'piTuiHostUserShell/run: requestId'),
      seq: safeIntegerOf(frame.seq, 'piTuiHostUserShell/run: output seq', 0),
      stream: frame.stream,
      base64: parseBase64(frame.base64),
    }
  }
  if (frame.kind === 'settled') {
    exactKeys(frame, ['kind', 'requestId', 'exit', 'aborted', 'sandboxDenied'], 'piTuiHostUserShell/run: settled frame')
    if (typeof frame.aborted !== 'boolean') throw new TypeError('piTuiHostUserShell/run: aborted must be a boolean')
    if (typeof frame.sandboxDenied !== 'boolean') throw new TypeError('piTuiHostUserShell/run: sandboxDenied must be a boolean')
    return {
      kind: 'settled',
      requestId: requestIdOf(frame.requestId, 'piTuiHostUserShell/run: requestId'),
      exit: parseExit(frame.exit),
      aborted: frame.aborted,
      sandboxDenied: frame.sandboxDenied,
    }
  }
  if (frame.kind === 'failed') {
    exactKeys(frame, ['kind', 'requestId', 'phase', 'message'], 'piTuiHostUserShell/run: failed frame')
    if (frame.phase !== 'spawn' && frame.phase !== 'sandbox-runner' && frame.phase !== 'transport-internal') {
      throw new TypeError('piTuiHostUserShell/run: failed phase is invalid')
    }
    return {
      kind: 'failed',
      requestId: requestIdOf(frame.requestId, 'piTuiHostUserShell/run: requestId'),
      phase: frame.phase,
      message: stringOf(frame.message, 'piTuiHostUserShell/run: failure message'),
    }
  }
  throw new TypeError('piTuiHostUserShell/run: frame kind is invalid')
}

/** Validate legal stream order and bind every frame to one gesture. */
export class HostUserShellFrameSequence {
  private state: 'before-start' | 'running' | 'terminal' = 'before-start'
  private nextSeq = 0
  private readonly request: HostUserShellRunArguments

  constructor(request: HostUserShellRunArguments) {
    this.request = request
  }

  accept(value: unknown): HostUserShellFrame {
    const frame = parseHostUserShellFrame(value)
    if (frame.requestId !== this.request.requestId) throw new TypeError('piTuiHostUserShell/run: frame requestId does not match')
    if (this.state === 'terminal') throw new TypeError('piTuiHostUserShell/run: frame arrived after terminal frame')
    if (this.state === 'before-start') {
      if (frame.kind === 'refused') {
        this.state = 'terminal'
        return frame
      }
      if (frame.kind !== 'started') throw new TypeError('piTuiHostUserShell/run: started frame must precede every other frame')
      if (frame.sessionId !== this.request.sessionId || frame.policy !== this.request.policy) {
        throw new TypeError('piTuiHostUserShell/run: started frame does not match the request scope')
      }
      this.state = 'running'
      return frame
    }
    if (frame.kind === 'started' || frame.kind === 'refused') {
      throw new TypeError('piTuiHostUserShell/run: duplicate admission frame')
    }
    if (frame.kind === 'output') {
      if (frame.seq !== this.nextSeq) throw new TypeError('piTuiHostUserShell/run: output sequence is missing or out of order')
      this.nextSeq += 1
      return frame
    }
    this.state = 'terminal'
    return frame
  }

  finish(): void {
    if (this.state !== 'terminal') throw new TypeError('piTuiHostUserShell/run: stream ended without a terminal frame')
  }
}

/** Strict decoder for the uplink consumption acknowledgement. */
export function parseHostUserShellAck(value: unknown): HostUserShellAck {
  const ack = recordOf(value, 'piTuiHostUserShell/run: ACK')
  exactKeys(ack, ['kind', 'requestId', 'seq'], 'piTuiHostUserShell/run: ACK')
  if (ack.kind !== 'ack') throw new TypeError('piTuiHostUserShell/run: ACK kind is invalid')
  return {
    kind: 'ack',
    requestId: requestIdOf(ack.requestId, 'piTuiHostUserShell/run: ACK requestId'),
    seq: safeIntegerOf(ack.seq, 'piTuiHostUserShell/run: ACK seq', 0),
  }
}

/** Strict decoder for Host completion arguments. */
export function parseHostShellCompletionRequest(value: unknown): HostShellCompletionRequest {
  const request = recordOf(value, 'piTuiHostUserShell/complete: request')
  if (request.kind === 'commands' || request.kind === 'variables') {
    exactKeys(request, ['kind', 'prefix'], 'piTuiHostUserShell/complete: request')
    return { kind: request.kind, prefix: stringOf(request.prefix, 'piTuiHostUserShell/complete: prefix', { empty: true }) }
  }
  if (request.kind === 'subcommands') {
    exactKeys(request, ['kind', 'command', 'prefix'], 'piTuiHostUserShell/complete: request')
    return {
      kind: 'subcommands',
      command: stringOf(request.command, 'piTuiHostUserShell/complete: command'),
      prefix: stringOf(request.prefix, 'piTuiHostUserShell/complete: prefix', { empty: true }),
    }
  }
  if (request.kind === 'paths') {
    exactKeys(request, ['kind', 'prefix'], 'piTuiHostUserShell/complete: request')
    return { kind: 'paths', prefix: stringOf(request.prefix, 'piTuiHostUserShell/complete: prefix', { empty: true }) }
  }
  throw new TypeError('piTuiHostUserShell/complete: request kind is invalid')
}

/** Strict bounded decoder for a unary completion result. */
export function parseHostShellCompletionOutcome(value: unknown): HostShellCompletionOutcome {
  const outcome = recordOf(value, 'piTuiHostUserShell/complete: result')
  if (outcome.kind === 'unavailable') {
    exactKeys(outcome, ['kind', 'reason'], 'piTuiHostUserShell/complete: unavailable result')
    return { kind: 'unavailable', reason: stringOf(outcome.reason, 'piTuiHostUserShell/complete: reason') }
  }
  if (outcome.kind !== 'ok') throw new TypeError('piTuiHostUserShell/complete: result kind is invalid')
  exactKeys(outcome, ['kind', 'candidates'], 'piTuiHostUserShell/complete: ok result')
  if (!Array.isArray(outcome.candidates)) throw new TypeError('piTuiHostUserShell/complete: candidates must be an array')
  if (outcome.candidates.length > MAX_HOST_SHELL_COMPLETION_ITEMS) {
    throw new TypeError('piTuiHostUserShell/complete: result exceeds 50 candidates')
  }
  const candidates = outcome.candidates.map((candidate, index) => {
    const text = stringOf(candidate, `piTuiHostUserShell/complete: candidate ${index}`)
    if (Buffer.byteLength(text, 'utf8') > MAX_HOST_SHELL_COMPLETION_ITEM_BYTES) {
      throw new TypeError('piTuiHostUserShell/complete: candidate exceeds 4 KiB')
    }
    return text
  })
  const detached = { kind: 'ok' as const, candidates }
  if (Buffer.byteLength(JSON.stringify(detached), 'utf8') > MAX_HOST_SHELL_COMPLETION_RESULT_BYTES) {
    throw new TypeError('piTuiHostUserShell/complete: result exceeds 64 KiB')
  }
  return detached
}

function completionRequestCodec(): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol: '@xmoon76/dsh-pi-tui#piTuiHostUserShell/complete:request',
    create: () => ({ parse: parseHostShellCompletionRequest }),
    decode: parseHostShellCompletionRequest,
  }
}

function completionResultCodec(): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol: '@xmoon76/dsh-pi-tui#piTuiHostUserShell/complete:result',
    create: () => ({ parse: parseHostShellCompletionOutcome }),
    decode: parseHostShellCompletionOutcome,
  }
}

const ACK_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:ack',
  create: () => ({ parse: parseHostUserShellAck }),
  decode: parseHostUserShellAck,
}

const FRAME_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:frame',
  create: () => ({ parse: parseHostUserShellFrame }),
  decode: parseHostUserShellFrame,
}

export const PI_TUI_HOST_USER_SHELL_RUN: InvocationDescriptor = {
  id: PI_TUI_HOST_USER_SHELL_RUN_ENDPOINT,
  service: PI_TUI_HOST_USER_SHELL_NAMESPACE,
  namespace: PI_TUI_HOST_USER_SHELL_NAMESPACE,
  method: 'run',
  mode: 'stream',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'sessionId', wire: 'sessionId', source: 'json', codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:sessionId') },
    { name: 'requestId', wire: 'requestId', source: 'json', codec: requestIdCodec('@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:requestId') },
    { name: 'expectedCwd', wire: 'expectedCwd', source: 'json', codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:expectedCwd') },
    { name: 'command', wire: 'command', source: 'json', codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:command') },
    {
      name: 'policy', wire: 'policy', source: 'json', codec: {
        mode: 'strict',
        typeSymbol: '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:policy',
        create: () => ({ parse: value => policyOf(value, 'piTuiHostUserShell/run:policy') }),
      },
    },
  ],
  uplink: { codec: ACK_CODEC },
  cancellation: { parameter: 'signal' },
  result: FRAME_CODEC,
}

export const PI_TUI_HOST_USER_SHELL_COMPLETE: InvocationDescriptor = {
  id: PI_TUI_HOST_USER_SHELL_COMPLETE_ENDPOINT,
  service: PI_TUI_HOST_USER_SHELL_NAMESPACE,
  namespace: PI_TUI_HOST_USER_SHELL_NAMESPACE,
  method: 'complete',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'sessionId', wire: 'sessionId', source: 'json', codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiHostUserShell/complete:sessionId') },
    { name: 'request', wire: 'request', source: 'json', codec: completionRequestCodec() },
  ],
  cancellation: { parameter: 'signal' },
  result: completionResultCodec(),
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiHostUserShell/run': (
      sessionId: string,
      requestId: string,
      expectedCwd: string,
      command: string,
      policy: HostUserShellPolicy,
      signal?: AbortSignal,
    ) => HostUserShellRunResult
    'piTuiHostUserShell/complete': (
      sessionId: string,
      request: HostShellCompletionRequest,
      signal?: AbortSignal,
    ) => Promise<HostShellCompletionCallResult>
  }

  interface TypertRemoteNamespaceMap {
    piTuiHostUserShell: {
      run: (
        sessionId: string,
        requestId: string,
        expectedCwd: string,
        command: string,
        policy: HostUserShellPolicy,
        signal?: AbortSignal,
      ) => HostUserShellRunResult
      complete: (
        sessionId: string,
        request: HostShellCompletionRequest,
        signal?: AbortSignal,
      ) => Promise<HostShellCompletionCallResult>
    }
  }
}
