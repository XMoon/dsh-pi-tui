/**
 * UNIT: the strict `piTuiCredentialRecords` wire contract (M6-1 F7B).
 *
 * The Host is the only producer of these rows, but they still cross the wire,
 * so the metadata boundary is a real one: an extra field (a token, an api-key
 * value, an env mapping), a malformed key, an unknown kind or a non-array must
 * be refused instead of forwarded. Structural tests only — the real wire and
 * two-Client OS-process proofs live in the dedicated suites.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-credential-records-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREDENTIAL_RECORD_KEY_PATTERN,
  PI_TUI_CREDENTIAL_RECORDS_DELETE,
  PI_TUI_CREDENTIAL_RECORDS_LIST,
  PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  PI_TUI_CREDENTIAL_RECORDS_PACKAGE,
  parsePiTuiCredentialRecordKey,
  parsePiTuiCredentialRecordList,
  parsePiTuiCredentialRecordMetadata,
} from '../../../src/runtime/remote/pi-tui-credential-records-contract.ts'
import {
  PI_TUI_CLIENT_CONTRIBUTION,
  PI_TUI_HOST_CONTRIBUTION,
  PI_TUI_REMOTE_PACKAGE,
} from '../../../src/runtime/remote/pi-tui-remote-contribution.ts'

const GRANT_KEY = 'llm-pi-ai/f7b-grant'
const API_KEY_KEY = 'llm-pi-ai/f7b-api-key'
const FOREIGN_KEY = 'other-plugin/foreign-orphan'

test('UNIT: the two descriptors share ONE private namespace and strict endpoint ids', () => {
  assert.equal(PI_TUI_CREDENTIAL_RECORDS_NAMESPACE, 'piTuiCredentialRecords')
  assert.equal(PI_TUI_CREDENTIAL_RECORDS_PACKAGE, PI_TUI_REMOTE_PACKAGE)
  for (const descriptor of [PI_TUI_CREDENTIAL_RECORDS_LIST, PI_TUI_CREDENTIAL_RECORDS_DELETE]) {
    assert.equal(descriptor.service, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE)
    assert.equal(descriptor.namespace, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE)
    assert.equal(descriptor.id, `@xmoon76/dsh-pi-tui#${PI_TUI_CREDENTIAL_RECORDS_NAMESPACE}/${descriptor.method}`)
    assert.equal(descriptor.cancellation?.parameter, 'signal')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    assert.equal(descriptor.mode, undefined, 'both methods are direct unary invocations')
  }
  assert.deepEqual(PI_TUI_CREDENTIAL_RECORDS_LIST.parameters, [])
  assert.equal(PI_TUI_CREDENTIAL_RECORDS_DELETE.parameters.length, 1)
  assert.equal(PI_TUI_CREDENTIAL_RECORDS_DELETE.parameters[0]?.name, 'key')
  assert.equal(PI_TUI_CREDENTIAL_RECORDS_DELETE.parameters[0]?.wire, 'key')
  // The key grammar is the OFFICIAL two-segment grammar, never a scope allowlist.
  assert.equal(CREDENTIAL_RECORD_KEY_PATTERN.source, '^[a-z][a-z0-9-]*\\/[a-z][a-z0-9-]*$')
})

test('UNIT: the ONE Host and Client contributions carry the SAME two descriptors', () => {
  assert.ok(PI_TUI_HOST_CONTRIBUTION.invocations.includes(PI_TUI_CREDENTIAL_RECORDS_LIST))
  assert.ok(PI_TUI_HOST_CONTRIBUTION.invocations.includes(PI_TUI_CREDENTIAL_RECORDS_DELETE))
  assert.ok(PI_TUI_CLIENT_CONTRIBUTION.descriptors.includes(PI_TUI_CREDENTIAL_RECORDS_LIST))
  assert.ok(PI_TUI_CLIENT_CONTRIBUTION.descriptors.includes(PI_TUI_CREDENTIAL_RECORDS_DELETE))
  assert.equal(PI_TUI_HOST_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
})

test('UNIT: list metadata round-trips as a detached key+kind array', () => {
  const parsed = parsePiTuiCredentialRecordList([
    { key: GRANT_KEY, kind: 'grant' },
    { key: API_KEY_KEY, kind: 'api-key' },
    { key: FOREIGN_KEY, kind: 'grant' },
  ])
  assert.deepEqual(parsed, [
    { key: GRANT_KEY, kind: 'grant' },
    { key: API_KEY_KEY, kind: 'api-key' },
    { key: FOREIGN_KEY, kind: 'grant' },
  ])
  // An authoritative empty array is a real answer, not a failure.
  assert.deepEqual(parsePiTuiCredentialRecordList([]), [])
})

test('UNIT: a legal OTHER plugin scope passes (the bridge is not llm-pi-ai-only)', () => {
  assert.equal(parsePiTuiCredentialRecordKey(FOREIGN_KEY), FOREIGN_KEY)
  assert.deepEqual(
    parsePiTuiCredentialRecordList([{ key: FOREIGN_KEY, kind: 'api-key' }]),
    [{ key: FOREIGN_KEY, kind: 'api-key' }],
  )
})

test('UNIT: malformed keys are refused without narrowing to one scope', () => {
  for (const invalid of [
    'LLM-PI-AI/x',
    'llm-pi-ai/Extra',
    'llm-pi-ai/x/y',
    'llm-pi-ai/',
    '/x',
    'llm_pi_ai/x',
    'llm-pi-ai/a b',
    'DEEPSEEK_API_KEY',
    'llm-pi-ai/-leading-dash',
    'llm-pi-ai/9leading-digit',
    '',
  ]) {
    assert.throws(() => parsePiTuiCredentialRecordKey(invalid), /<scope>\/<id>/u, invalid)
  }
})

test('UNIT: a row can never smuggle a value, payload or extra field', () => {
  assert.throws(
    () => parsePiTuiCredentialRecordMetadata({ key: GRANT_KEY, kind: 'grant', payload: { token: 'secret' } }),
    /unexpected field/u,
  )
  assert.throws(
    () => parsePiTuiCredentialRecordMetadata({ key: API_KEY_KEY, kind: 'api-key', keyValue: 'sk-secret' }),
    /unexpected field/u,
  )
  assert.throws(
    () => parsePiTuiCredentialRecordMetadata({ key: API_KEY_KEY, kind: 'api-key', env: { AWS_PROFILE: 'secret' } }),
    /unexpected field/u,
  )
  assert.throws(
    () => parsePiTuiCredentialRecordMetadata({ key: API_KEY_KEY, kind: 'api-key', value: 'sk-secret' }),
    /unexpected field/u,
  )
  assert.throws(() => parsePiTuiCredentialRecordList('not-an-array'), /must be an array/u)
  assert.throws(() => parsePiTuiCredentialRecordList(null), /must be an array/u)
})

test('UNIT: unknown kinds, missing fields and one bad row fail the WHOLE list', () => {
  assert.throws(
    () => parsePiTuiCredentialRecordMetadata({ key: GRANT_KEY, kind: 'oauth' }),
    /api-key or grant/u,
  )
  assert.throws(
    () => parsePiTuiCredentialRecordMetadata({ key: GRANT_KEY, kind: 'grant', payload: {} }),
    /unexpected field/u,
  )
  assert.throws(() => parsePiTuiCredentialRecordMetadata({ key: GRANT_KEY }), /missing field "kind"/u)
  assert.throws(() => parsePiTuiCredentialRecordMetadata({ kind: 'grant' }), /missing field "key"/u)
  // A partially valid official projection must not be filtered into a false
  // "complete" answer: one invalid row fails the whole result.
  assert.throws(
    () => parsePiTuiCredentialRecordList([
      { key: GRANT_KEY, kind: 'grant' },
      { key: 'not a key', kind: 'grant' },
    ]),
    /<scope>\/<id>/u,
  )
})

test('UNIT: the delete result codec accepts ONLY the official empty result', () => {
  const result = PI_TUI_CREDENTIAL_RECORDS_DELETE.result as unknown as {
    mode: string
    create(): { parse(value: unknown): unknown }
  }
  assert.equal(result.mode, 'strict')
  const parser = result.create().parse
  assert.equal(parser(undefined), undefined)
  assert.equal(parser(null), undefined)
  assert.throws(() => parser({ key: GRANT_KEY, kind: 'grant' }), /must be empty/u)
  assert.throws(() => parser('deleted'), /must be empty/u)
  // The key parameter codec validates the wire text before the Host store.
  const keyCodec = PI_TUI_CREDENTIAL_RECORDS_DELETE.parameters[0]?.codec as unknown as {
    create(): { parse(value: unknown): unknown }
  }
  const keyParser = keyCodec.create().parse
  assert.equal(keyParser(FOREIGN_KEY), FOREIGN_KEY)
  assert.throws(() => keyParser('DEEPSEEK_API_KEY'), /<scope>\/<id>/u)
  // The list result codec is the strict array validator.
  const listParser = (PI_TUI_CREDENTIAL_RECORDS_LIST.result as unknown as {
    create(): { parse(value: unknown): unknown }
  }).create().parse
  assert.deepEqual(listParser([{ key: GRANT_KEY, kind: 'grant' }]), [{ key: GRANT_KEY, kind: 'grant' }])
  assert.throws(() => listParser({ key: GRANT_KEY, kind: 'grant' }), /must be an array/u)
})
