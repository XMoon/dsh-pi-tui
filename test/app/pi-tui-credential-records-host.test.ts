/**
 * L2 IN_PROCESS: the private `piTuiCredentialRecords` Host bridge over the REAL
 * official `ctx.credentials` store (`@deepseek-ai/dsh-credentials-local`),
 * dispatched through the REAL Typert Gateway with explicit peers.
 *
 * The records are seeded with the OFFICIAL `modifyRecord()` write path on an
 * isolated fixture store (never a hand-edited YAML file), so the whole chain
 * `official store -> private bridge -> Gateway` is the production one. The
 * two-Client OS-process proof is the split-process
 * `provider-credential-records` suite.
 *
 * Evidence level: IN_PROCESS. It pins the metadata-only boundary (no token,
 * grant payload or api-key/env value can cross), the exact-key durable delete
 * (absent = official no-op), the Owner ACL and the missing-store refusal.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-credential-records-host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import {
  PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  parsePiTuiCredentialRecordList,
  type CredentialRecordMetadata,
} from '../../src/runtime/remote/pi-tui-credential-records-contract.ts'
import { PiTuiCredentialRecordsHostService } from '../../src/app/host/features/credential-records.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

/**
 * The seeded record sentinels. They are the SECRETS the wire must never carry:
 * every assertion below looks for their absence in the transport result.
 */
const GRANT_TOKEN = 'f7b-grant-token-sentinel'
const API_KEY_VALUE = 'f7b-api-key-value-sentinel'
const API_ENV_VALUE = 'f7b-env-value-sentinel'
const FOREIGN_TOKEN = 'f7b-foreign-token-sentinel'
const ACCOUNT_TOKEN = 'f7b-account-token-sentinel'

const GRANT_KEY = credentialKey('llm-pi-ai', 'f7b-grant')
const API_KEY_KEY = credentialKey('llm-pi-ai', 'f7b-api-key')
const FOREIGN_KEY = credentialKey('other-plugin', 'f7b-orphan')
const ACCOUNT_KEY = credentialKey('deepseek-account-platform', 'default')

interface HostFixture {
  readonly ctx: Host['ctx']
  readonly peerA: PeerScope
  readonly peerB: PeerScope
  readonly nonOwner: PeerScope
  readonly invoke: (method: string, args: Record<string, unknown>, peer: PeerScope) => Promise<unknown>
  dispose(): Promise<void>
}

async function hostFixture(life: TestLifecycle, presetId: string): Promise<HostFixture> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const connection = host.ctx.connection
  const peerA = connection.browserPeer
  const peerB = connection.createPeer({ principal: { kind: 'owner' } })
  // The pinned protocol declares only the Owner principal; a synthetic peer is
  // the only way to prove the ACL refuses a NON-owner before the store is read.
  // This is the negative control, never a stand-in for a production identity.
  const nonOwner = connection.createPeer({ principal: { kind: 'viewer' } } as never)
  const gateway = host.ctx.typertGateway
  return {
    ctx: host.ctx,
    peerA,
    peerB,
    nonOwner,
    invoke: (method, args, peer) => gateway.invoke({
      namespace: PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
      method,
      args,
      peer,
      signal: new AbortController().signal,
    }),
    dispose: async () => {
      await Promise.all([peerB.dispose(), nonOwner.dispose()])
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** Seed every record through the OFFICIAL read-modify-write path. */
async function seedRecords(ctx: Host['ctx']): Promise<void> {
  const credentials = ctx.credentials
  await credentials.modifyRecord(GRANT_KEY, async () => ({
    kind: 'grant',
    payload: { token: GRANT_TOKEN },
  }))
  await credentials.modifyRecord(API_KEY_KEY, async () => ({
    kind: 'api-key',
    key: API_KEY_VALUE,
    env: { F7B_ENV: API_ENV_VALUE },
  }))
  await credentials.modifyRecord(FOREIGN_KEY, async () => ({
    kind: 'grant',
    payload: { token: FOREIGN_TOKEN },
  }))
  await credentials.modifyRecord(ACCOUNT_KEY, async () => ({
    kind: 'grant',
    payload: { token: ACCOUNT_TOKEN },
  }))
}

function metadataOf(result: unknown): readonly CredentialRecordMetadata[] {
  return parsePiTuiCredentialRecordList(result)
}

function sortedMetadata(records: readonly CredentialRecordMetadata[]): readonly CredentialRecordMetadata[] {
  return [...records].sort((left, right) => left.key.localeCompare(right.key))
}

function assertNoSecret(value: unknown, label: string): void {
  const text = JSON.stringify(value)
  for (const secret of [GRANT_TOKEN, API_KEY_VALUE, API_ENV_VALUE, FOREIGN_TOKEN, ACCOUNT_TOKEN]) {
    assert.equal(text.includes(secret), false, `${label} leaked ${JSON.stringify(secret)}`)
  }
}

test('IN_PROCESS: Owner list returns every stored record as exact key+kind metadata', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7b-host-list')
  try {
    await seedRecords(host.ctx)
    const listed = metadataOf(await host.invoke('list', {}, host.peerA))
    assert.deepEqual(sortedMetadata(listed), [
      { key: 'deepseek-account-platform/default', kind: 'grant' },
      { key: 'llm-pi-ai/f7b-api-key', kind: 'api-key' },
      { key: 'llm-pi-ai/f7b-grant', kind: 'grant' },
      { key: 'other-plugin/f7b-orphan', kind: 'grant' },
    ], 'the Host bridge lists the official store without inventing or dropping a row')
    assertNoSecret(listed, 'the list result')
    // A second Owner peer reads the SAME Host truth (no per-peer mirror).
    assert.deepEqual(sortedMetadata(metadataOf(await host.invoke('list', {}, host.peerB))), sortedMetadata(listed))
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: Owner delete removes EXACTLY one record, keeps the others and is a no-op when absent', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7b-host-delete')
  try {
    await seedRecords(host.ctx)
    const updated: string[] = []
    host.ctx.on('credentials/record-updated', key => { updated.push(key) })
    await host.invoke('delete', { key: GRANT_KEY }, host.peerA)
    const records = await host.ctx.credentials.listRecords()
    const keys = records.map(record => record.key)
    assert.deepEqual([...keys].sort(), [ACCOUNT_KEY, API_KEY_KEY, FOREIGN_KEY].sort(),
      'the exact-key delete removes only the named record')
    // The official commit event fired for the deleted key at least once.
    assert.ok(updated.includes(GRANT_KEY), `the official record-updated event must fire: ${JSON.stringify(updated)}`)
    // The absent-key delete is the official no-op, not an error and not an
    // `unset()` of some derived reference.
    await host.invoke('delete', { key: GRANT_KEY }, host.peerB)
    assert.deepEqual([...(await host.ctx.credentials.listRecords()).map(record => record.key)].sort(),
      [ACCOUNT_KEY, API_KEY_KEY, FOREIGN_KEY].sort(),
      'a repeated delete of an absent record must not touch another record')
    // A foreign scope's orphan record is a legal exact delete target.
    await host.invoke('delete', { key: FOREIGN_KEY }, host.peerA)
    assert.deepEqual([...(await host.ctx.credentials.listRecords()).map(record => record.key)].sort(),
      [ACCOUNT_KEY, API_KEY_KEY].sort(),
      'a valid other-plugin key must be deletable (no llm-pi-ai scope restriction)')
    assert.equal(await host.ctx.credentials.readRecord(GRANT_KEY), undefined)
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: malformed keys are refused BEFORE the official store and nothing is written', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7b-host-invalid')
  try {
    await seedRecords(host.ctx)
    for (const invalid of ['not a key', 'DEEPSEEK_API_KEY', 'llm-pi-ai/extra/slash', 'LLM-PI-AI/Upper', '']) {
      // The Gateway's strict key codec refuses the wire field BEFORE the Host
      // method runs — a definite refusal, never a dispatched store mutation.
      await assert.rejects(host.invoke('delete', { key: invalid }, host.peerA),
        /boundary validation|valid <scope>\/<id> credential key/u,
        `the Host must refuse ${JSON.stringify(invalid)}`)
    }
    // The service-level official grammar check is the second layer: reached only
    // if the wire codec were bypassed (a direct Host call).
    const peer = { principal: { kind: 'owner' } as const, signal: new AbortController().signal }
    const direct = host.ctx.extend({ invocation: { peer, signal: new AbortController().signal } })
      .get('piTuiCredentialRecords') as { delete(key: string, signal: AbortSignal): Promise<unknown> }
    await assert.rejects(direct.delete('not a key', new AbortController().signal),
      /valid <scope>\/<id> credential key/u)
    assert.deepEqual([...(await host.ctx.credentials.listRecords()).map(record => record.key)].sort(),
      [ACCOUNT_KEY, API_KEY_KEY, FOREIGN_KEY, GRANT_KEY].sort(),
      'a refused argument must never touch the store')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a non-Owner peer is refused at BOTH methods before the store is read or written', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7b-host-acl')
  try {
    await seedRecords(host.ctx)
    // The official RemoteAccess gate refuses the non-owner peer before the
    // bridge method itself runs (the production outer ACL).
    await assert.rejects(host.invoke('list', {}, host.nonOwner),
      /access denied|restricted to the authenticated Owner peer/u,
      'a non-owner peer must not read the record metadata')
    await assert.rejects(host.invoke('delete', { key: GRANT_KEY }, host.nonOwner),
      /access denied|restricted to the authenticated Owner peer/u,
      'a non-owner peer must not delete a record')
    // The bridge's OWN Owner check is the second layer (reached when the outer
    // decider is broader than the endpoint contract).
    const invocation = {
      peer: { principal: { kind: 'viewer' } as const, signal: new AbortController().signal },
      signal: new AbortController().signal,
    }
    const traced = host.ctx.extend({ invocation }).get('piTuiCredentialRecords') as {
      list(signal: AbortSignal): Promise<unknown>
      delete(key: string, signal: AbortSignal): Promise<unknown>
    }
    await assert.rejects(traced.list(new AbortController().signal), /restricted to the authenticated Owner peer/u)
    await assert.rejects(traced.delete(GRANT_KEY, new AbortController().signal), /restricted to the authenticated Owner peer/u)
    assert.deepEqual([...(await host.ctx.credentials.listRecords()).map(record => record.key)].sort(),
      [ACCOUNT_KEY, API_KEY_KEY, FOREIGN_KEY, GRANT_KEY].sort())
    assert.notEqual(await host.ctx.credentials.readRecord(GRANT_KEY), undefined)
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: an installed-but-empty store answers a REAL empty list (never a failure)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7b-host-empty')
  try {
    assert.deepEqual(metadataOf(await host.invoke('list', {}, host.peerA)), [])
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a Host without the credentials store still mounts the bridge and REFUSES (never empty)', async () => {
  // The bridge is constructed directly because the runtime's other rows are
  // irrelevant here; `inject` is only ['typert'], so a missing credentials
  // service cannot keep the runtime fiber from completing (asserted in
  // `test/app/pi-tui-host-runtime.test.ts`).
  assert.deepEqual(PiTuiCredentialRecordsHostService.inject, ['typert'])
  const ctx = new Context()
  new PiTuiCredentialRecordsHostService(ctx, { credentials: () => undefined })
  const peer = { principal: { kind: 'owner' } as const, signal: new AbortController().signal }
  const invocation = { peer, signal: new AbortController().signal }
  const service = ctx.extend({ invocation }).get('piTuiCredentialRecords') as {
    list(signal: AbortSignal): Promise<unknown>
    delete(key: string, signal: AbortSignal): Promise<unknown>
  }
  await assert.rejects(service.list(new AbortController().signal), /credentials service is not installed/u,
    'a missing Host store must be a definite failure, never an empty successful list')
  await assert.rejects(service.delete('llm-pi-ai/f7b-grant', new AbortController().signal),
    /credentials service is not installed/u)
  await ctx.fiber.dispose()
})
