/**
 * L3 Remote-adapter regression for the stored-credential RECORD namespace
 * (M6-1 F7B).
 *
 * The REAL `RemoteConfigPort` runs over a structural fake of the mounted
 * private `piTuiCredentialRecords` namespace: the adapter's generation fence,
 * accepted-write lifetime, strict key/result validation, definite-refusal
 * classification and unknown-ACK vocabulary are the production code under
 * test. The REAL generated Client Remote + actual Gateway + official store
 * proof lives in `test/app/pi-tui-credential-records-wire.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/remote-credential-records.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RECORD_DELETE_UNCONFIRMED_CODE,
  RemoteConfigPort,
  RecordDeleteUnconfirmedError,
  type RemoteConfigRuntimeSource,
} from '../../../src/runtime/remote/config-remote.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import { RemoteError, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteSettingsNamespaceView } from '../../../src/runtime/remote/config-remote.ts'
import type {
  CredentialRecordMetadata,
  PiTuiCredentialRecordsDeleteCall,
  PiTuiCredentialRecordsListCall,
  PiTuiCredentialRecordsNamespace,
} from '../../../src/runtime/remote/pi-tui-credential-records-contract.ts'

const GENERATION_ONE = {}
const NO_ACKNOWLEDGING = (): void => {}

/** One official Remote failure (the Client face rebuilds this class per call). */
function fail(code: string, message: string): { readonly ok: false; readonly error: RemoteFailure } {
  return { ok: false, error: new RemoteError(code as never, message, undefined as never) as unknown as RemoteFailure }
}

function namespaceView(ns: string, revision: number): RemoteSettingsNamespaceView {
  return { ns, value: {}, user: {}, revision }
}

interface RecordsFake {
  readonly namespace: PiTuiCredentialRecordsNamespace
  listCalls: number
  deleteCalls: string[]
  /** The result the next list call settles with (a Promise lets a test hold it). */
  listResult: () => Promise<PiTuiCredentialRecordsListCall>
  deleteResult: (key: string) => Promise<PiTuiCredentialRecordsDeleteCall>
}

function recordsFake(): RecordsFake {
  const fake: RecordsFake = {
    listCalls: 0,
    deleteCalls: [],
    listResult: async () => ({ ok: true, value: [] }),
    deleteResult: async () => ({ ok: true, value: undefined }),
    namespace: {
      list: async () => {
        fake.listCalls += 1
        return fake.listResult()
      },
      delete: async (key: string) => {
        fake.deleteCalls.push(key)
        return fake.deleteResult(key)
      },
    },
  }
  return fake
}

interface Harness {
  readonly port: RemoteConfigPort
  readonly records: RecordsFake
  /** Replace the current Connection generation. */
  replaceGeneration(): void
}

function startHarness(options: { readonly records?: RecordsFake | null; readonly generation?: boolean } = {}): Harness {
  const records = options.records === undefined ? recordsFake() : options.records
  let generation: object | undefined = options.generation === false ? undefined : GENERATION_ONE
  const source = {
    remote: {
      settings: {
        describe: async () => ({
          ok: true as const,
          value: { writable: true, hasDocument: true, namespaces: [namespaceView('tui-app', 1)] },
        }),
        update: async () => ({ ok: true as const, value: namespaceView('x', 1) }),
        replace: async () => ({ ok: true as const, value: namespaceView('x', 1) }),
        mutate: async (ns: string) => ({ ok: true as const, value: namespaceView(ns, 2) }),
      },
      credentials: {
        describe: async () => ({ ok: true as const, value: {} }),
        set: async () => ({ ok: true as const, value: undefined }),
        unset: async () => ({ ok: true as const, value: undefined }),
      },
      ...records === null ? {} : { piTuiCredentialRecords: records.namespace },
      commands: { execute: async () => ({ ok: false as const, error: { code: 'unsupported', message: 'not used' } }) },
      permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
      agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
      llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
      $on: () => NO_ACKNOWLEDGING,
    },
    connection: {
      generation: {
        getSnapshot: () => generation,
        subscribe: () => NO_ACKNOWLEDGING,
      },
    },
  } as unknown as RemoteConfigRuntimeSource
  return {
    port: new RemoteConfigPort(source),
    records: records as RecordsFake,
    replaceGeneration: () => { generation = {} },
  }
}

test('L3: the mounted private namespace IS the record capability; an empty host list is a real answer', async () => {
  const harness = startHarness()
  assert.equal(harness.port.credentials.recordsSupported(), true)
  assert.deepEqual(await harness.port.credentials.listRecords(), [])
  harness.records.listResult = async () => ({
    ok: true,
    value: [
      { key: 'llm-pi-ai/f7b-grant', kind: 'grant' },
      { key: 'other-plugin/orphan', kind: 'api-key' },
    ],
  })
  assert.deepEqual(await harness.port.credentials.listRecords(), [
    { key: 'llm-pi-ai/f7b-grant', kind: 'grant' },
    { key: 'other-plugin/orphan', kind: 'api-key' },
  ])
  assert.equal(harness.records.listCalls, 2, 'one wire read per list call (never a cached list)')
})

test('L3: an absent namespace is a truthful capability gap, never an empty list or a fake success', async () => {
  const harness = startHarness({ records: null })
  assert.equal(harness.port.credentials.recordsSupported(), false)
  await assert.rejects(() => harness.port.credentials.listRecords(), /private record namespace is not mounted/u)
  await assert.rejects(() => harness.port.credentials.deleteRecord('llm-pi-ai/f7b-grant'),
    /private record namespace is not mounted/u)
})

test('L3: a mounted namespace whose Host read fails stays SUPPORTED with a failed read', async () => {
  const harness = startHarness()
  harness.records.listResult = async () => fail('gateway/service-unavailable', 'the Host credentials service is not installed')
  assert.equal(harness.port.credentials.recordsSupported(), true,
    'a Host store failure must never be reported as a capability gap')
  await assert.rejects(() => harness.port.credentials.listRecords(), /piTuiCredentialRecords\.list failed/u)
})

test('L3: an OLD list answer (even an empty one) never lands after a generation replacement', async () => {
  const harness = startHarness()
  let release!: (value: PiTuiCredentialRecordsListCall) => void
  harness.records.listResult = () => new Promise(resolve => { release = resolve })
  const read = harness.port.credentials.listRecords()
  await Promise.resolve()
  harness.replaceGeneration()
  release({ ok: true, value: [] })
  await assert.rejects(read, (error: unknown) => error instanceof SupersededReadError)
  // An OLD failure is superseded too, not surfaced as the new Host's failure.
  let releaseFailure!: (value: PiTuiCredentialRecordsListCall) => void
  harness.records.listResult = () => new Promise(resolve => { releaseFailure = resolve })
  const failedRead = harness.port.credentials.listRecords()
  await Promise.resolve()
  harness.replaceGeneration()
  releaseFailure(fail('gateway/internal', 'old host failed'))
  await assert.rejects(failedRead, (error: unknown) => error instanceof SupersededReadError)
})

test('L3: a record delete is dispatched EXACTLY once inside the accepted-write lifetime', async () => {
  const harness = startHarness()
  let release!: (value: PiTuiCredentialRecordsDeleteCall) => void
  harness.records.deleteResult = () => new Promise(resolve => { release = resolve })
  const write = harness.port.credentials.deleteRecord('llm-pi-ai/f7b-grant')
  await Promise.resolve()
  assert.equal(harness.port.hasUnsettledWrites(), true,
    'the dispatched delete keeps the Client reload gate closed until it settles')
  release({ ok: true, value: undefined })
  await write
  assert.equal(harness.port.hasUnsettledWrites(), false, 'the settled delete releases the lifetime')
  assert.deepEqual(harness.records.deleteCalls, ['llm-pi-ai/f7b-grant'],
    'the exact key crosses the wire once and is never replayed')
})

test('L3: a lost ACK / internal / cancelled failure is UNCONFIRMED and never retried', async () => {
  for (const [code, message] of [
    ['gateway/internal', 'the carrier dropped the answer'],
    ['gateway/cancelled', 'the caller cancelled'],
    ['gateway/result-invalid', 'the Host answer was invalid'],
    ['unknown/whatever', 'no stable code'],
  ] as const) {
    const harness = startHarness()
    harness.records.deleteResult = async () => fail(code, message)
    await assert.rejects(harness.port.credentials.deleteRecord('llm-pi-ai/f7b-grant'), (thrown: unknown) => {
      assert.ok(thrown instanceof RecordDeleteUnconfirmedError, `expected the unconfirmed error for ${code}`)
      assert.equal((thrown as { code?: unknown }).code, RECORD_DELETE_UNCONFIRMED_CODE)
      return true
    })
    assert.equal(harness.records.deleteCalls.length, 1, 'an unconfirmed delete must never be re-sent')
    assert.equal(harness.port.hasUnsettledWrites(), false, 'the unconfirmed settlement still releases the lifetime')
  }
  // A carrier THROW is the same unknown outcome, never a definite refusal.
  const throwing = startHarness()
  throwing.records.deleteResult = async () => { throw new Error('transport fault') }
  await assert.rejects(throwing.port.credentials.deleteRecord('llm-pi-ai/f7b-grant'),
    (thrown: unknown) => thrown instanceof RecordDeleteUnconfirmedError)
})

test('L3: an official gateway/bad-request refusal is a normal definite failure, not unconfirmed', async () => {
  const harness = startHarness()
  harness.records.deleteResult = async () => fail('gateway/bad-request', 'the wire field key was refused')
  await assert.rejects(harness.port.credentials.deleteRecord('llm-pi-ai/f7b-grant'), (thrown: unknown) => {
    assert.equal(thrown instanceof RecordDeleteUnconfirmedError, false,
      'a definite refusal must not be reported as an unknown outcome')
    assert.match((thrown as Error).message, /was rejected/u)
    return true
  })
  assert.equal(harness.port.hasUnsettledWrites(), false)
})

test('L3: the wire key grammar is enforced BEFORE dispatch (invalid keys never reach the Host)', async () => {
  const harness = startHarness()
  for (const invalid of ['DEEPSEEK_API_KEY', 'llm-pi-ai/extra/slash', 'LLM-PI-AI/Upper', 'not a key', '']) {
    await assert.rejects(harness.port.credentials.deleteRecord(invalid), /<scope>\/<id>/u)
  }
  assert.deepEqual(harness.records.deleteCalls, [], 'an invalid key is refused locally')
})

test('L3: no current Connection generation means the delete is NOT SENT (and the list is not read)', async () => {
  const harness = startHarness({ generation: false })
  await assert.rejects(harness.port.credentials.deleteRecord('llm-pi-ai/f7b-grant'),
    (thrown: unknown) => thrown instanceof SupersededReadError && /not dispatched/u.test((thrown as Error).message))
  await assert.rejects(harness.port.credentials.listRecords(),
    (thrown: unknown) => thrown instanceof SupersededReadError && /no current Connection generation/u.test((thrown as Error).message))
  assert.deepEqual(harness.records.deleteCalls, [])
  assert.equal(harness.records.listCalls, 0)
})

test('L3: a list answer carrying an extra secret-bearing field fails the WHOLE read', async () => {
  const harness = startHarness()
  harness.records.listResult = async () => ({
    ok: true,
    value: [{ key: 'llm-pi-ai/f7b-grant', kind: 'grant', payload: { token: 'secret' } }] as never,
  })
  await assert.rejects(() => harness.port.credentials.listRecords(), /unexpected field/u)
})
