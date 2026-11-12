/**
 * L5 REAL_WIRE: the private `piTuiCredentialRecords` namespace through the
 * PRODUCTION Host row, the REAL rc.2 Gateway Client remote and the real
 * in-process carrier.
 *
 * ```text
 * official ctx.credentials (dsh-credentials-local, isolated fixture store)
 *   -> PiTuiCredentialRecordsHostService (production Host row)
 *   -> gateway carrier (production generated Client Remote)
 *   -> RemoteConfigPort credentials adapter (production Client code)
 *   -> typed metadata / exact-key delete
 * ```
 *
 * The records are seeded through the official `modifyRecord()` write path, so
 * the durable store mutation and its `credentials/record-updated` event are
 * real, not a fake namespace result. Evidence level: REAL_WIRE (in-process
 * carrier, real Gateway/Client remote). The two real OS-process Clients are the
 * split-process `provider-credential-records` suite.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-credential-records-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { RemoteConfigPort, RecordDeleteUnconfirmedError } from '../../src/runtime/remote/config-remote.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

const GRANT_TOKEN = 'f7b-wire-grant-token-sentinel'
const API_KEY_VALUE = 'f7b-wire-api-key-sentinel'
const FOREIGN_TOKEN = 'f7b-wire-foreign-token-sentinel'

const GRANT_KEY = credentialKey('llm-pi-ai', 'f7b-wire-grant')
const API_KEY_KEY = credentialKey('llm-pi-ai', 'f7b-wire-api-key')
const FOREIGN_KEY = credentialKey('other-plugin', 'f7b-wire-orphan')

interface Wire {
  readonly host: Host
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  readonly port: RemoteConfigPort
  dispose(): Promise<void>
}

async function mountWire(
  life: TestLifecycle,
  presetId: string,
  fault: { readonly match: (url: string) => boolean } | undefined = undefined,
): Promise<Wire> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  if (fault !== undefined) {
    // ONE-SHOT carrier fault: the request still reaches the Host (the official
    // store really commits), but the answer never returns to the Client.
    const originalFetch = hostRuntime.carrier.fetch
    let injected = false
    hostRuntime.carrier.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const response = await originalFetch(input, init)
      if (!injected && fault.match(url)) {
        injected = true
        throw new Error('simulated carrier loss after the Host committed the call')
      }
      return response
    }
  }
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const port = new RemoteConfigPort({
    remote: client.remote,
    connection: { generation: client.connection.generation },
  })
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    port,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

async function seedRecords(wire: Wire): Promise<void> {
  const credentials = wire.host.ctx.credentials
  await credentials.modifyRecord(GRANT_KEY, async () => ({ kind: 'grant', payload: { token: GRANT_TOKEN } }))
  await credentials.modifyRecord(API_KEY_KEY, async () => ({
    kind: 'api-key',
    key: API_KEY_VALUE,
    env: { F7B_WIRE_ENV: 'f7b-wire-env-value' },
  }))
  await credentials.modifyRecord(FOREIGN_KEY, async () => ({ kind: 'grant', payload: { token: FOREIGN_TOKEN } }))
}

function assertNoWireSecret(value: unknown, label: string): void {
  const text = JSON.stringify(value)
  for (const secret of [GRANT_TOKEN, API_KEY_VALUE, FOREIGN_TOKEN, 'f7b-wire-env-value']) {
    assert.equal(text.includes(secret), false, `${label} leaked ${JSON.stringify(secret)}`)
  }
}

test('L5 REAL_WIRE: the generated Client Remote lists the official store metadata and deletes one exact key', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7b-wire-records')
  try {
    await seedRecords(wire)
    // The mounted namespace comes from the package's ONE Client contribution:
    // it hangs off the generated remote as an accessor, never as an own field.
    assert.equal(Object.hasOwn(wire.client.remote, 'piTuiCredentialRecords'), false,
      'the namespace is an accessor on the generated Client remote')
    assert.equal(wire.port.credentials.recordsSupported(), true)

    const listed = await wire.port.credentials.listRecords()
    assert.deepEqual([...listed].sort((left, right) => left.key.localeCompare(right.key)), [
      { key: 'llm-pi-ai/f7b-wire-api-key', kind: 'api-key' },
      { key: 'llm-pi-ai/f7b-wire-grant', kind: 'grant' },
      { key: 'other-plugin/f7b-wire-orphan', kind: 'grant' },
    ], 'the Client receives the official store metadata through the real Gateway')
    assertNoWireSecret(listed, 'the real-wire list result')

    const updated: string[] = []
    wire.host.ctx.on('credentials/record-updated', key => { updated.push(key) })
    await wire.port.credentials.deleteRecord(GRANT_KEY)
    const remaining = (await wire.host.ctx.credentials.listRecords()).map(record => record.key).sort()
    assert.deepEqual(remaining, [API_KEY_KEY, FOREIGN_KEY].sort(),
      'the exact-key delete mutated the official Host store through the real wire')
    assert.equal(await wire.host.ctx.credentials.readRecord(GRANT_KEY), undefined)
    assert.ok(updated.includes(GRANT_KEY), 'the official record-updated event fired on the Host commit')
    // The Client's own re-read now reflects the new Host truth.
    assert.deepEqual((await wire.port.credentials.listRecords()).map(record => record.key).sort(),
      [API_KEY_KEY, FOREIGN_KEY].sort())
    // An absent key is the official no-op; a malformed key never leaves the Client.
    await wire.port.credentials.deleteRecord(GRANT_KEY)
    await assert.rejects(() => wire.port.credentials.deleteRecord('DEEPSEEK_API_KEY'), /<scope>\/<id>/u)
    assert.deepEqual((await wire.host.ctx.credentials.listRecords()).map(record => record.key).sort(),
      [API_KEY_KEY, FOREIGN_KEY].sort())
  } finally {
    await wire.dispose()
  }
})

test('L5 REAL_WIRE: a Host-committed delete whose ACK is lost is UNCONFIRMED and never replayed', async (t) => {
  const life = testLifecycle(t)
  let deleteRequests = 0
  const wire = await mountWire(life, 'f7b-wire-ack-loss', {
    match: url => {
      if (!url.includes('piTuiCredentialRecords/delete')) return false
      deleteRequests += 1
      return true
    },
  })
  try {
    await seedRecords(wire)
    await assert.rejects(wire.port.credentials.deleteRecord(GRANT_KEY),
      (error: unknown) => error instanceof RecordDeleteUnconfirmedError,
      'a lost ACK after dispatch must never be a definite failure or success')
    assert.equal(deleteRequests, 1, 'the delete crossed the carrier exactly once')
    // The Host really committed the delete before the answer was dropped.
    assert.equal(await wire.host.ctx.credentials.readRecord(GRANT_KEY), undefined)
    assert.deepEqual((await wire.host.ctx.credentials.listRecords()).map(record => record.key).sort(),
      [API_KEY_KEY, FOREIGN_KEY].sort(), 'only the exact key was removed')
    // The Client re-reads the CURRENT Host truth through a NEW call; the adapter
    // never replays the delete on its own.
    assert.deepEqual((await wire.port.credentials.listRecords()).map(record => record.key).sort(),
      [API_KEY_KEY, FOREIGN_KEY].sort())
    assert.equal(deleteRequests, 1, 'the readback did not replay the delete')
    assert.equal(wire.port.hasUnsettledWrites(), false, 'the unconfirmed settlement released the write lifetime')
  } finally {
    await wire.dispose()
  }
})

test('L5 REAL_WIRE: a failed Client read is a real failure, never a fake empty list', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7b-wire-records-failed')
  try {
    await seedRecords(wire)
    // No current Connection generation: the read is not sent and surfaces the
    // truthful currentness refusal instead of an empty result.
    const detached = new RemoteConfigPort({
      remote: wire.client.remote,
      connection: { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    })
    await assert.rejects(() => detached.credentials.listRecords(),
      (error: unknown) => error instanceof SupersededReadError)
    await assert.rejects(() => detached.credentials.deleteRecord(GRANT_KEY),
      (error: unknown) => error instanceof SupersededReadError)
    assert.equal((await wire.host.ctx.credentials.listRecords()).length, 3, 'a refused read must not touch the store')
  } finally {
    await wire.dispose()
  }
})
