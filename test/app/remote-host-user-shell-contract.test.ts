import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HostUserShellFrameSequence,
  MAX_HOST_USER_SHELL_FRAME_BYTES,
  parseHostShellCompletionOutcome,
  parseHostUserShellAck,
} from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'
import { HostUserShellOutcomeUnknownError } from '../../src/runtime/host-user-shell-port.ts'

const request = {
  requestId: '550e8400-e29b-41d4-a716-446655440000',
  sessionId: 'session-a',
  expectedCwd: '/workspace',
  command: 'echo ok',
  policy: 'sandbox' as const,
}

test('a started stream preserves raw bytes, shared sequence order, and one terminal fact', () => {
  const sequence = new HostUserShellFrameSequence(request)
  assert.deepEqual(sequence.accept({ kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy }), { kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy })
  const bytes = Buffer.from([0xff, 0xc3, 0x28])
  const output = sequence.accept({
    kind: 'output', requestId: request.requestId, seq: 0, stream: 'stderr', base64: bytes.toString('base64'),
  })
  assert.equal(output.kind, 'output')
  if (output.kind === 'output') assert.deepEqual(Buffer.from(output.base64, 'base64'), bytes)
  sequence.accept({ kind: 'settled', requestId: request.requestId, exit: { kind: 'exit', code: 7 }, aborted: false, sandboxDenied: false })
  sequence.finish()
})

test('a refused request is terminal without a started frame', () => {
  const sequence = new HostUserShellFrameSequence(request)
  sequence.accept({ kind: 'refused', requestId: request.requestId, reason: 'scope-unavailable', message: 'unavailable' })
  sequence.finish()
})

test('an output frame without a sequence number is rejected', () => {
  const sequence = new HostUserShellFrameSequence(request)
  sequence.accept({ kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy })
  assert.throws(() => sequence.accept({
    kind: 'output', requestId: request.requestId, stream: 'stdout', base64: 'eA==',
  }), /seq/)
})

test('duplicate output sequence numbers and a second terminal frame are rejected', () => {
  const sequence = new HostUserShellFrameSequence(request)
  sequence.accept({ kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy })
  const output = { kind: 'output', requestId: request.requestId, seq: 0, stream: 'stdout', base64: 'eA==' }
  sequence.accept(output)
  assert.throws(() => sequence.accept(output), /sequence/)
  sequence.accept({ kind: 'settled', requestId: request.requestId, exit: { kind: 'exit', code: 0 }, aborted: false, sandboxDenied: false })
  assert.throws(() => sequence.accept({ kind: 'settled', requestId: request.requestId, exit: { kind: 'exit', code: 0 }, aborted: false, sandboxDenied: false }), /terminal/)
})

test('frames for a different request and output before started are rejected', () => {
  const sequence = new HostUserShellFrameSequence(request)
  assert.throws(() => sequence.accept({ kind: 'started', requestId: '550e8400-e29b-41d4-a716-446655440001', sessionId: request.sessionId, policy: request.policy }), /requestId/)
  assert.throws(() => sequence.accept({
    kind: 'output', requestId: request.requestId, seq: 0, stream: 'stdout', base64: 'eA==',
  }), /started/)
})

test('malformed and oversized base64 output is rejected at the wire boundary', () => {
  const sequence = new HostUserShellFrameSequence(request)
  sequence.accept({ kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy })
  assert.throws(() => sequence.accept({
    kind: 'output', requestId: request.requestId, seq: 0, stream: 'stdout', base64: 'abc*',
  }), /base64/)
  const oversized = Buffer.alloc(MAX_HOST_USER_SHELL_FRAME_BYTES + 1).toString('base64')
  assert.throws(() => sequence.accept({
    kind: 'output', requestId: request.requestId, seq: 0, stream: 'stdout', base64: oversized,
  }), /32 KiB/)
})

test('EOF without a refusal or terminal fact and invalid exit facts are rejected', () => {
  const open = new HostUserShellFrameSequence(request)
  open.accept({ kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy })
  assert.throws(() => open.finish(), /terminal/)
  const invalid = new HostUserShellFrameSequence(request)
  invalid.accept({ kind: 'started', requestId: request.requestId, sessionId: request.sessionId, policy: request.policy })
  assert.throws(() => invalid.accept({
    kind: 'settled', requestId: request.requestId, exit: { kind: 'exit', code: 1.5 }, aborted: false, sandboxDenied: false,
  }), /exit code/)
})

test('completion result parsing enforces item and byte bounds', () => {
  assert.deepEqual(parseHostShellCompletionOutcome({ kind: 'ok', candidates: ['git'] }), {
    kind: 'ok', candidates: ['git'],
  })
  assert.throws(() => parseHostShellCompletionOutcome({ kind: 'ok', candidates: Array.from({ length: 51 }, () => 'git') }), /50/)
  assert.throws(() => parseHostShellCompletionOutcome({ kind: 'ok', candidates: ['x'.repeat(4097)] }), /4 KiB/)
  assert.throws(() => parseHostShellCompletionOutcome({ kind: 'ok', candidates: ['git'], extra: true }), /unexpected/)
})

test('uplink ACK frames have an exact request identity and safe sequence', () => {
  assert.deepEqual(parseHostUserShellAck({ kind: 'ack', requestId: '550e8400-e29b-41d4-a716-446655440000', seq: 0 }), {
    kind: 'ack', requestId: '550e8400-e29b-41d4-a716-446655440000', seq: 0,
  })
  assert.throws(() => parseHostUserShellAck({ kind: 'ack', requestId: '550e8400-e29b-41d4-a716-446655440000', seq: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/)
  assert.throws(() => parseHostUserShellAck({ kind: 'ack', requestId: '550e8400-e29b-41d4-a716-446655440000', seq: -1 }), />= 0/)
})

test('a started transport loss has a distinct unknown-outcome error', () => {
  const error = new HostUserShellOutcomeUnknownError('started stream disconnected')
  assert.equal(error.name, 'HostUserShellOutcomeUnknownError')
  assert.match(error.message, /disconnected/)
})
