/**
 * UNIT: the strict `piTuiAuthorization` wire codec (M6-1 F7A).
 *
 * The Host is the only producer of these frames, but they still cross the wire
 * and the Client stream path does NOT decode them through the descriptor
 * codec, so the validator is a real boundary: unknown fields, wrong kinds,
 * secrets/tokens and malformed unions must be refused. Structural tests only —
 * they are NOT real-wire evidence (the real carrier suite lives in
 * `test/app/pi-tui-authorization-wire.test.ts`).
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-authorization-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_PI_TUI_AUTHORIZATION_ATTEMPT_FRAMES,
  PI_TUI_AUTHORIZATION_CANCEL,
  PI_TUI_AUTHORIZATION_LIST,
  PI_TUI_AUTHORIZATION_NAMESPACE,
  PI_TUI_AUTHORIZATION_RESPOND,
  PI_TUI_AUTHORIZATION_RUN,
  parsePiTuiAuthorizationFrame,
  parsePiTuiAuthorizationTarget,
  parsePiTuiAuthorizationTargetsSnapshot,
} from '../../../src/runtime/remote/pi-tui-authorization-contract.ts'

test('UNIT: the four descriptors share ONE private namespace and strict endpoint ids', () => {
  assert.equal(PI_TUI_AUTHORIZATION_NAMESPACE, 'piTuiAuthorization')
  for (const descriptor of [
    PI_TUI_AUTHORIZATION_LIST,
    PI_TUI_AUTHORIZATION_RUN,
    PI_TUI_AUTHORIZATION_RESPOND,
    PI_TUI_AUTHORIZATION_CANCEL,
  ]) {
    assert.equal(descriptor.service, PI_TUI_AUTHORIZATION_NAMESPACE)
    assert.equal(descriptor.namespace, PI_TUI_AUTHORIZATION_NAMESPACE)
    assert.equal(descriptor.id, `@xmoon76/dsh-pi-tui#${PI_TUI_AUTHORIZATION_NAMESPACE}/${descriptor.method}`)
    assert.equal(descriptor.cancellation?.parameter, 'signal')
  }
  assert.equal(PI_TUI_AUTHORIZATION_RUN.mode, 'stream')
  assert.equal(PI_TUI_AUTHORIZATION_LIST.mode, undefined)
  assert.equal(PI_TUI_AUTHORIZATION_RESPOND.mode, undefined)
  assert.equal(PI_TUI_AUTHORIZATION_CANCEL.mode, undefined)
  // `method` is the one optional business parameter (undefined = the flow's
  // declared first method).
  const method = PI_TUI_AUTHORIZATION_RUN.parameters[1]
  assert.equal(method.acceptsUndefined, true)
  assert.equal(method.wire, 'method')
  assert.equal(MAX_PI_TUI_AUTHORIZATION_ATTEMPT_FRAMES, 64)
})

test('UNIT: every legal frame shape parses into a detached object', () => {
  const started = parsePiTuiAuthorizationFrame({ kind: 'started', attemptId: 'a-1' })
  assert.deepEqual(started, { kind: 'started', attemptId: 'a-1' })

  assert.deepEqual(
    parsePiTuiAuthorizationFrame({
      kind: 'notice',
      attemptId: 'a-1',
      notice: { message: 'Open the page', url: 'https://example.test/device', code: 'ABCD-1234' },
    }),
    {
      kind: 'notice',
      attemptId: 'a-1',
      notice: { message: 'Open the page', url: 'https://example.test/device', code: 'ABCD-1234' },
    },
  )

  assert.deepEqual(
    parsePiTuiAuthorizationFrame({
      kind: 'prompt',
      attemptId: 'a-1',
      promptId: 'p-1',
      prompt: { kind: 'secret', message: 'Paste the token', placeholder: 'token' },
    }),
    {
      kind: 'prompt',
      attemptId: 'a-1',
      promptId: 'p-1',
      prompt: { kind: 'secret', message: 'Paste the token', placeholder: 'token' },
    },
  )

  assert.deepEqual(
    parsePiTuiAuthorizationFrame({
      kind: 'prompt',
      attemptId: 'a-1',
      promptId: 'p-2',
      prompt: {
        kind: 'select',
        message: 'Pick an account',
        options: [{ id: 'one', label: 'One', description: 'First' }, { id: 'two', label: 'Two' }],
      },
    }),
    {
      kind: 'prompt',
      attemptId: 'a-1',
      promptId: 'p-2',
      prompt: {
        kind: 'select',
        message: 'Pick an account',
        options: [{ id: 'one', label: 'One', description: 'First' }, { id: 'two', label: 'Two' }],
      },
    },
  )

  assert.deepEqual(
    parsePiTuiAuthorizationFrame({ kind: 'prompt-withdrawn', attemptId: 'a-1', promptId: 'p-1' }),
    { kind: 'prompt-withdrawn', attemptId: 'a-1', promptId: 'p-1' },
  )

  assert.deepEqual(
    parsePiTuiAuthorizationFrame({ kind: 'settled', attemptId: 'a-1', status: 'authorized' }),
    { kind: 'settled', attemptId: 'a-1', status: 'authorized' },
  )
  assert.deepEqual(
    parsePiTuiAuthorizationFrame({ kind: 'settled', attemptId: 'a-1', status: 'failed', code: 'NOT_COMMITTED', message: 'no commit' }),
    { kind: 'settled', attemptId: 'a-1', status: 'failed', code: 'NOT_COMMITTED', message: 'no commit' },
  )
  assert.deepEqual(
    parsePiTuiAuthorizationFrame({ kind: 'unconfirmed', attemptId: 'a-1', reason: 'stream lost' }),
    { kind: 'unconfirmed', attemptId: 'a-1', reason: 'stream lost' },
  )
})

test('UNIT: an unknown frame kind or a malformed identity is refused', () => {
  assert.throws(() => parsePiTuiAuthorizationFrame({ kind: 'progress', attemptId: 'a' }), /kind is unknown/)
  assert.throws(() => parsePiTuiAuthorizationFrame({ kind: 'started' }), /attemptId/)
  assert.throws(() => parsePiTuiAuthorizationFrame({ kind: 'started', attemptId: '' }), /attemptId/)
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'notice', attemptId: 'a', notice: {} }),
    /message/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'settled', attemptId: 'a', status: 'success' }),
    /status/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'prompt', attemptId: 'a', promptId: 'p', prompt: { kind: 'confirm', message: 'x' } }),
    /prompt kind/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'prompt', attemptId: 'a', promptId: 'p', prompt: { kind: 'select', message: 'x', options: [] } }),
    /options/,
  )
})

test('UNIT: extra or secret-bearing frame fields are refused instead of forwarded', () => {
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'notice', attemptId: 'a', notice: { message: 'x' }, token: 'secret' }),
    /unexpected field/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'settled', attemptId: 'a', status: 'authorized', credentialRecord: { kind: 'grant' } }),
    /unexpected field/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'prompt', attemptId: 'a', promptId: 'p', prompt: { kind: 'secret', message: 'x', value: 'typed' } }),
    /unexpected field/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationFrame({ kind: 'notice', attemptId: 'a', notice: { message: 'x', secret: 's' } }),
    /unexpected field/,
  )
})

test('UNIT: a forged error object is not a frame', () => {
  assert.throws(() => parsePiTuiAuthorizationFrame({ ok: false, error: { code: 'NOT_COMMITTED' } }), /attemptId/)
  assert.throws(() => parsePiTuiAuthorizationFrame(new Error('boom')), /attemptId/)
  assert.throws(() => parsePiTuiAuthorizationFrame(null), /must be an object/)
})

test('UNIT: the roster target and snapshot are exact detached shapes', () => {
  assert.deepEqual(
    parsePiTuiAuthorizationTarget({
      kind: 'authorization',
      route: 'openai-codex',
      key: 'llm-pi-ai/openai-codex',
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      inFlight: false,
    }),
    {
      kind: 'authorization',
      route: 'openai-codex',
      key: 'llm-pi-ai/openai-codex',
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      inFlight: false,
    },
  )
  assert.throws(
    () => parsePiTuiAuthorizationTarget({ kind: 'authorization', key: 'k', label: 'l', methods: [], inFlight: false, record: {} }),
    /unexpected field/,
  )
  assert.throws(
    () => parsePiTuiAuthorizationTarget({ kind: 'provider', key: 'k', label: 'l', methods: [], inFlight: false }),
    /kind/,
  )
  assert.deepEqual(parsePiTuiAuthorizationTargetsSnapshot({ kind: 'ready', targets: [] }), { kind: 'ready', targets: [] })
  assert.deepEqual(
    parsePiTuiAuthorizationTargetsSnapshot({ kind: 'unavailable', reason: 'not installed' }),
    { kind: 'unavailable', reason: 'not installed' },
  )
  assert.throws(
    () => parsePiTuiAuthorizationTargetsSnapshot({ kind: 'ready', targets: [], extra: true }),
    /unexpected field/,
  )
})
