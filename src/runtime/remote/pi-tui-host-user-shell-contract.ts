/**
 * The private Host one-shot Shell and Host completion wire contract. One shared
 * descriptor table serves both the Host registration and Client mount.
 *
 * Shell execution is ONE authenticated unary invocation: the Host runs the
 * command to settlement and returns one bounded semantic result. There is no
 * raw-byte frame stream, no consumption acknowledgement and no request-scoped
 * stream lifecycle on this endpoint.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-host-user-shell-contract
 */

import { constants as osConstants } from 'node:os'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import type { HostShellCompletionOutcome, HostShellCompletionRequest } from '../host-shell-completion-port.ts'
import {
  MAX_HOST_USER_SHELL_MESSAGE_BYTES,
  MAX_HOST_USER_SHELL_RESULT_BYTES,
  MAX_HOST_USER_SHELL_SPILL_PATH_BYTES,
  MAX_HOST_USER_SHELL_STREAM_BYTES,
  type HostUserShellExit,
  type HostUserShellOutput,
  type HostUserShellPolicy,
  type HostUserShellResult,
} from '../host-user-shell-port.ts'

export const PI_TUI_HOST_USER_SHELL_NAMESPACE = 'piTuiHostUserShell'
export const PI_TUI_HOST_USER_SHELL_RUN_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run'
export const PI_TUI_HOST_USER_SHELL_COMPLETE_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiHostUserShell/complete'
export const MAX_HOST_SHELL_COMPLETION_ITEMS = 50
export const MAX_HOST_SHELL_COMPLETION_ITEM_BYTES = 4 * 1024
export const MAX_HOST_SHELL_COMPLETION_RESULT_BYTES = 64 * 1024
export { MAX_HOST_USER_SHELL_MESSAGE_BYTES, MAX_HOST_USER_SHELL_RESULT_BYTES, MAX_HOST_USER_SHELL_SPILL_PATH_BYTES, MAX_HOST_USER_SHELL_STREAM_BYTES }

/**
 * One Shell run's wire outcome. `settled` carries the complete bounded
 * semantic result; `refused` proves nothing executed; `failed` is a Host-side
 * execution failure after admission (the card must not claim a clean result).
 */
export type HostUserShellRunOutcome =
  | { readonly kind: 'settled'; readonly result: HostUserShellResult }
  | {
    readonly kind: 'refused'
    readonly reason: 'scope-unavailable' | 'policy-unavailable' | 'invalid-request'
    readonly message: string
  }
  | {
    readonly kind: 'failed'
    readonly phase: 'sandbox-runner' | 'infrastructure'
    readonly message: string
  }

export interface HostUserShellRunArguments {
  readonly sessionId: string
  readonly expectedCwd: string
  readonly command: string
  readonly policy: HostUserShellPolicy
}

export type HostUserShellCallResult = RemoteResult<HostUserShellRunOutcome>
export type HostShellCompletionCallResult = RemoteResult<HostShellCompletionOutcome>
export type PiTuiHostUserShellNamespace = TypertRemoteNamespace<'piTuiHostUserShell'>

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

function boundedStringOf(value: unknown, label: string, maxBytes: number): string {
  const text = stringOf(value, label, { empty: true })
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TypeError(`${label}: exceeds ${maxBytes} bytes`)
  if (text.includes('\0')) throw new TypeError(`${label}: must not contain NUL`)
  return text
}

function booleanOf(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label}: expected a boolean`)
  return value
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

function parseOutput(value: unknown, stream: 'stdout' | 'stderr'): HostUserShellOutput {
  const label = `piTuiHostUserShell/run: ${stream}`
  const output = recordOf(value, label)
  for (const key of Object.keys(output)) {
    if (key !== 'text' && key !== 'truncated' && key !== 'spillPath') {
      throw new TypeError(`${label}: unexpected field ${JSON.stringify(key)}`)
    }
  }
  if (!Object.hasOwn(output, 'text')) throw new TypeError(`${label}: missing field "text"`)
  if (!Object.hasOwn(output, 'truncated')) throw new TypeError(`${label}: missing field "truncated"`)
  const text = boundedStringOf(output.text, `${label} text`, MAX_HOST_USER_SHELL_STREAM_BYTES)
  const truncated = booleanOf(output.truncated, `${label} truncated`)
  if (output.spillPath === undefined) return { text, truncated }
  const spillPath = boundedStringOf(output.spillPath, `${label} spillPath`, MAX_HOST_USER_SHELL_SPILL_PATH_BYTES)
  return { text, truncated, spillPath }
}

function parseResult(value: unknown): HostUserShellResult {
  const result = recordOf(value, 'piTuiHostUserShell/run: result')
  exactKeys(result, ['exit', 'stdout', 'stderr', 'sandboxDenied', 'aborted', 'timedOut'], 'piTuiHostUserShell/run: result')
  const stdout = parseOutput(result.stdout, 'stdout')
  const stderr = parseOutput(result.stderr, 'stderr')
  if (Buffer.byteLength(stdout.text, 'utf8') + Buffer.byteLength(stderr.text, 'utf8') > MAX_HOST_USER_SHELL_RESULT_BYTES) {
    throw new TypeError('piTuiHostUserShell/run: result exceeds the combined stdout+stderr bound')
  }
  return {
    exit: parseExit(result.exit),
    stdout,
    stderr,
    sandboxDenied: booleanOf(result.sandboxDenied, 'piTuiHostUserShell/run: result sandboxDenied'),
    aborted: booleanOf(result.aborted, 'piTuiHostUserShell/run: result aborted'),
    timedOut: booleanOf(result.timedOut, 'piTuiHostUserShell/run: result timedOut'),
  }
}

function boundedMessageOf(value: unknown, label: string): string {
  const message = stringOf(value, label)
  if (Buffer.byteLength(message, 'utf8') > MAX_HOST_USER_SHELL_MESSAGE_BYTES) {
    throw new TypeError(`${label}: exceeds ${MAX_HOST_USER_SHELL_MESSAGE_BYTES} bytes`)
  }
  return message
}

/** The single strict decoder for one unary Shell outcome. */
export function parseHostUserShellRunOutcome(value: unknown): HostUserShellRunOutcome {
  const outcome = recordOf(value, 'piTuiHostUserShell/run: outcome')
  if (outcome.kind === 'settled') {
    exactKeys(outcome, ['kind', 'result'], 'piTuiHostUserShell/run: settled outcome')
    return { kind: 'settled', result: parseResult(outcome.result) }
  }
  if (outcome.kind === 'refused') {
    exactKeys(outcome, ['kind', 'reason', 'message'], 'piTuiHostUserShell/run: refused outcome')
    if (outcome.reason !== 'scope-unavailable' && outcome.reason !== 'policy-unavailable' && outcome.reason !== 'invalid-request') {
      throw new TypeError('piTuiHostUserShell/run: refused reason is invalid')
    }
    return {
      kind: 'refused',
      reason: outcome.reason,
      message: boundedMessageOf(outcome.message, 'piTuiHostUserShell/run: refusal message'),
    }
  }
  if (outcome.kind === 'failed') {
    exactKeys(outcome, ['kind', 'phase', 'message'], 'piTuiHostUserShell/run: failed outcome')
    if (outcome.phase !== 'sandbox-runner' && outcome.phase !== 'infrastructure') {
      throw new TypeError('piTuiHostUserShell/run: failed phase is invalid')
    }
    return {
      kind: 'failed',
      phase: outcome.phase,
      message: boundedMessageOf(outcome.message, 'piTuiHostUserShell/run: failure message'),
    }
  }
  throw new TypeError('piTuiHostUserShell/run: outcome kind is invalid')
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

const RUN_OUTCOME_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:result',
  create: () => ({ parse: parseHostUserShellRunOutcome }),
  decode: parseHostUserShellRunOutcome,
}

export const PI_TUI_HOST_USER_SHELL_RUN: InvocationDescriptor = {
  id: PI_TUI_HOST_USER_SHELL_RUN_ENDPOINT,
  service: PI_TUI_HOST_USER_SHELL_NAMESPACE,
  namespace: PI_TUI_HOST_USER_SHELL_NAMESPACE,
  method: 'run',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'sessionId', wire: 'sessionId', source: 'json', codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiHostUserShell/run:sessionId') },
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
  cancellation: { parameter: 'signal' },
  result: RUN_OUTCOME_CODEC,
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
      expectedCwd: string,
      command: string,
      policy: HostUserShellPolicy,
      signal?: AbortSignal,
    ) => Promise<HostUserShellCallResult>
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
        expectedCwd: string,
        command: string,
        policy: HostUserShellPolicy,
        signal?: AbortSignal,
      ) => Promise<HostUserShellCallResult>
      complete: (
        sessionId: string,
        request: HostShellCompletionRequest,
        signal?: AbortSignal,
      ) => Promise<HostShellCompletionCallResult>
    }
  }
}
