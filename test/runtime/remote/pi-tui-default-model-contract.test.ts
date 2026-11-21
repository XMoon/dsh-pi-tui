/**
 * Contract tests for the private `piTuiDefaultModel` Remote contract
 * (runtime/remote/pi-tui-default-model-contract.ts): ONE descriptor both
 * contributions derive from, the strict input/result codecs, and the private
 * contribution wiring. The wire carries ONLY the three selection fields — no
 * Session id, cwd, path or secret — and a `refused` is a closed reason union.
 * @module @xmoon76/dsh-pi-tui/pi-tui-default-model-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PI_TUI_DEFAULT_MODEL_PACKAGE,
  PI_TUI_DEFAULT_MODEL_SAVE_SELECTION,
  PI_TUI_DEFAULT_MODEL_SAVE_SELECTION_ENDPOINT,
  PI_TUI_DEFAULT_MODEL_NAMESPACE,
  parseDefaultModelSaveResult,
  parseDefaultModelSelection,
} from '../../../src/runtime/remote/pi-tui-default-model-contract.ts'
import {
  PI_TUI_CLIENT_CONTRIBUTION,
  PI_TUI_HOST_CONTRIBUTION,
  PI_TUI_REMOTE_PACKAGE,
} from '../../../src/runtime/remote/pi-tui-remote-contribution.ts'

test('the default-model descriptor is the ONE shared object both contributions derive from', () => {
  assert.equal(PI_TUI_DEFAULT_MODEL_PACKAGE, PI_TUI_REMOTE_PACKAGE)
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.id, PI_TUI_DEFAULT_MODEL_SAVE_SELECTION_ENDPOINT)
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.id, '@xmoon76/dsh-pi-tui#piTuiDefaultModel/saveSelection')
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.service, PI_TUI_DEFAULT_MODEL_NAMESPACE)
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.namespace, PI_TUI_DEFAULT_MODEL_NAMESPACE)
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.namespace, 'piTuiDefaultModel')
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.method, 'saveSelection')
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.invocation.kind, 'direct')
  assert.deepEqual(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.parameters.map(parameter => parameter.wire), ['selection'])
  assert.ok(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.parameters.every(parameter => parameter.codec.mode === 'strict'),
    'the selection input codec must be strict')
  assert.deepEqual(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.cancellation, { parameter: 'signal' })
  assert.equal(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.result.mode, 'strict')
  // The Host registration and the Client mount share the EXACT descriptor.
  assert.ok(PI_TUI_HOST_CONTRIBUTION.invocations.includes(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION),
    'the Host contribution registers the default-model descriptor')
  assert.ok(PI_TUI_CLIENT_CONTRIBUTION.descriptors.includes(PI_TUI_DEFAULT_MODEL_SAVE_SELECTION),
    'the Client contribution mounts the default-model descriptor')
})

test('the selection codec accepts ONLY the three model fields (no sessionId/cwd/path/secret)', () => {
  assert.deepEqual(parseDefaultModelSelection({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.deepEqual(parseDefaultModelSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    { provider: 'p', model: 'm', reasoningEffort: 'high' })
  // provider/model identifiers are NOT trimmed (whitespace is significant).
  assert.deepEqual(parseDefaultModelSelection({ provider: ' ', model: 'm' }), { provider: ' ', model: 'm' })
  // Rejections at the wire boundary.
  assert.throws(() => parseDefaultModelSelection({ provider: 'p' }), /missing field "model"/u)
  assert.throws(() => parseDefaultModelSelection({ model: 'm' }), /missing field "provider"/u)
  assert.throws(() => parseDefaultModelSelection({ provider: '', model: 'm' }), /non-empty string/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 'p', model: '' }), /non-empty string/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 'p', model: 'm', reasoningEffort: '' }), /non-empty string/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 'p', model: 'm', reasoningEffort: null }), /non-empty string/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 'p', model: 'm', sessionId: 's' }), /unexpected field "sessionId"/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 'p', model: 'm', cwd: '/x' }), /unexpected field "cwd"/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 'p', model: 'm', apiKey: 'secret' }), /unexpected field "apiKey"/u)
  assert.throws(() => parseDefaultModelSelection({ provider: 1, model: 'm' }), /non-empty string/u)
  assert.throws(() => parseDefaultModelSelection(null), /must be an object/u)
  assert.throws(() => parseDefaultModelSelection(['p', 'm']), /must be an object/u)
})

test('the result codec is a closed saved/refused union with exact keys', () => {
  assert.deepEqual(parseDefaultModelSaveResult({ kind: 'saved' }), { kind: 'saved' })
  for (const reason of [
    'owner-required',
    'default-model-service-unavailable',
    'profile-persistence-unavailable',
    'profile-entry-unavailable',
  ] as const) {
    assert.deepEqual(parseDefaultModelSaveResult({ kind: 'refused', reason }), { kind: 'refused', reason })
  }
  assert.throws(() => parseDefaultModelSaveResult({ kind: 'refused', reason: 'what' }), /unknown refusal reason/u)
  assert.throws(() => parseDefaultModelSaveResult({ kind: 'refused' }), /missing field|unknown refusal/u)
  assert.throws(() => parseDefaultModelSaveResult({ kind: 'saved', extra: 1 }), /unexpected field "extra"/u)
  assert.throws(() => parseDefaultModelSaveResult({ kind: 'applied' }), /unknown kind/u)
  assert.throws(() => parseDefaultModelSaveResult({ kind: 'saved', reason: 'owner-required' }), /unexpected field "reason"/u)
  assert.throws(() => parseDefaultModelSaveResult(undefined), /must be an object/u)
})

test('the registered parameter and result codecs (create().parse) enforce the same contract', () => {
  interface StrictCodec { create(): { parse(value: unknown): unknown } }
  const selectionCodec = (PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.parameters[0]!.codec as unknown as StrictCodec)
    .create().parse
  assert.deepEqual(selectionCodec({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.throws(() => selectionCodec({ provider: 'p', model: 'm', cwd: '/x' }), /unexpected field/u)
  const resultCodec = (PI_TUI_DEFAULT_MODEL_SAVE_SELECTION.result as unknown as StrictCodec).create().parse
  assert.deepEqual(resultCodec({ kind: 'saved' }), { kind: 'saved' })
  assert.throws(() => resultCodec({ kind: 'refused', reason: 'nope' }), /unknown refusal reason/u)
})
