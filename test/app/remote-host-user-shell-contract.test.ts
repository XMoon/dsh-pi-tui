import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_HOST_USER_SHELL_MESSAGE_BYTES,
  MAX_HOST_USER_SHELL_SPILL_PATH_BYTES,
  PI_TUI_HOST_USER_SHELL_RUN,
  parseHostShellCompletionOutcome,
  parseHostUserShellRunOutcome,
} from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'
import { MAX_HOST_USER_SHELL_STREAM_BYTES, HostUserShellOutcomeUnknownError } from '../../src/runtime/host-user-shell-port.ts'

const settled = {
  kind: 'settled',
  result: {
    exit: { kind: 'exit', code: 7 },
    stdout: { text: 'out', truncated: false },
    stderr: { text: '', truncated: true, spillPath: '/host/tmp/spill' },
    sandboxDenied: false,
    aborted: false,
    timedOut: false,
  },
} as const

test('the one-shot run descriptor is unary with cancellation and a strict result codec', () => {
  assert.equal(PI_TUI_HOST_USER_SHELL_RUN.mode, undefined)
  assert.equal(PI_TUI_HOST_USER_SHELL_RUN.uplink, undefined)
  assert.deepEqual(PI_TUI_HOST_USER_SHELL_RUN.cancellation, { parameter: 'signal' })
  assert.deepEqual(PI_TUI_HOST_USER_SHELL_RUN.parameters.map(parameter => parameter.name), [
    'sessionId', 'expectedCwd', 'command', 'policy',
  ])
})

test('a settled one-shot outcome carries both bounded streams, truncation and real exit facts', () => {
  const parsed = parseHostUserShellRunOutcome(settled)
  assert.deepEqual(parsed, settled)
})

test('a refused outcome is the only way to prove nothing executed', () => {
  assert.deepEqual(parseHostUserShellRunOutcome({
    kind: 'refused', reason: 'policy-unavailable', message: 'nothing ran',
  }), { kind: 'refused', reason: 'policy-unavailable', message: 'nothing ran' })
  assert.throws(() => parseHostUserShellRunOutcome({ kind: 'refused', reason: 'other', message: 'x' }), /reason/)
})

test('a failed outcome keeps the sandbox-runner and infrastructure phases distinct', () => {
  assert.deepEqual(parseHostUserShellRunOutcome({
    kind: 'failed', phase: 'sandbox-runner', message: 'runner failed',
  }), { kind: 'failed', phase: 'sandbox-runner', message: 'runner failed' })
  assert.deepEqual(parseHostUserShellRunOutcome({
    kind: 'failed', phase: 'infrastructure', message: 'lost',
  }), { kind: 'failed', phase: 'infrastructure', message: 'lost' })
  assert.throws(() => parseHostUserShellRunOutcome({ kind: 'failed', phase: 'other', message: 'x' }), /phase/)
})

test('settled results reject extra/missing fields, invalid exits and non-boolean flags', () => {
  const withResult = (result: object): object => ({ kind: 'settled', result })
  assert.throws(() => parseHostUserShellRunOutcome(withResult({ ...settled.result, extra: true })), /unexpected field/)
  assert.throws(() => parseHostUserShellRunOutcome(withResult({ ...settled.result, sandboxDenied: 'no' })), /boolean/)
  assert.throws(() => parseHostUserShellRunOutcome(withResult({ ...settled.result, exit: { kind: 'exit', code: 1.5 } })), /exit code/)
  assert.throws(() => parseHostUserShellRunOutcome(withResult({ ...settled.result, exit: { kind: 'exit', code: 256 } })), /exit code/)
  assert.throws(() => parseHostUserShellRunOutcome(withResult({ ...settled.result, exit: { kind: 'signal', signal: 'SIG_NOPE' } })), /signal is invalid/)
  assert.throws(() => parseHostUserShellRunOutcome({ kind: 'settled' }), /missing field/)
})

test('stream text is bounded by the shared semantic tail bound and output shapes are strict', () => {
  const withResult = (result: object): object => ({ kind: 'settled', result })
  assert.throws(() => parseHostUserShellRunOutcome(withResult({
    ...settled.result,
    stdout: { text: 'x'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES + 1), truncated: false },
  })), /exceeds 65536 bytes/)
  assert.throws(() => parseHostUserShellRunOutcome(withResult({
    ...settled.result,
    stdout: { text: 'x', truncated: false, extra: true },
  })), /unexpected field/)
  assert.throws(() => parseHostUserShellRunOutcome(withResult({
    ...settled.result,
    stdout: { text: 'x' },
  })), /missing field "truncated"/)
})

test('the combined stdout+stderr text is bounded across both streams', () => {
  assert.throws(() => parseHostUserShellRunOutcome({
    kind: 'settled',
    result: {
      ...settled.result,
      stdout: { text: 'a'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES), truncated: false },
      stderr: { text: 'b'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES), truncated: false },
    },
  }), /combined stdout\+stderr bound/)
})

test('the Host-local spill path is bounded and cannot smuggle NUL', () => {
  assert.throws(() => parseHostUserShellRunOutcome({
    kind: 'settled',
    result: {
      ...settled.result,
      stdout: { text: 'x', truncated: true, spillPath: 'p'.repeat(MAX_HOST_USER_SHELL_SPILL_PATH_BYTES + 1) },
    },
  }), /spillPath: exceeds 4096 bytes/)
  assert.throws(() => parseHostUserShellRunOutcome({
    kind: 'settled',
    result: {
      ...settled.result,
      stdout: { text: 'x', truncated: true, spillPath: '/tmp/\0spill' },
    },
  }), /NUL/)
})

test('refusal and failure messages are bounded', () => {
  assert.throws(() => parseHostUserShellRunOutcome({
    kind: 'refused', reason: 'scope-unavailable', message: 'x'.repeat(MAX_HOST_USER_SHELL_MESSAGE_BYTES + 1),
  }), /exceeds 2048 bytes/)
})

test('completion result parsing enforces item and byte bounds', () => {
  assert.deepEqual(parseHostShellCompletionOutcome({ kind: 'ok', candidates: ['git'] }), {
    kind: 'ok', candidates: ['git'],
  })
  assert.throws(() => parseHostShellCompletionOutcome({ kind: 'ok', candidates: Array.from({ length: 51 }, () => 'git') }), /50/)
  assert.throws(() => parseHostShellCompletionOutcome({ kind: 'ok', candidates: ['x'.repeat(4097)] }), /4 KiB/)
  assert.throws(() => parseHostShellCompletionOutcome({ kind: 'ok', candidates: ['git'], extra: true }), /unexpected/)
})

test('a lost started outcome has a distinct unknown-outcome error', () => {
  const error = new HostUserShellOutcomeUnknownError('one-shot result was lost')
  assert.equal(error.name, 'HostUserShellOutcomeUnknownError')
  assert.match(error.message, /lost/)
})
