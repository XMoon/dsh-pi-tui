/**
 * UNIT: the Remote ACP listener control adapter's CURRENTNESS policy.
 *
 * The Host is the only authority for the live listener state; this adapter owns
 * no truth and no cache. Its ONE policy is the Connection generation fence: a
 * reply (success OR refusal) carried by a superseded generation must be reported
 * as superseded, never presented as the new generation's definite outcome, and a
 * side-effecting `setEnabled` is dispatched at most once and NEVER replayed.
 *
 * @module @xmoon76/dsh-pi-tui/remote-acp-access.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteAcpAccessPort, type RemoteAcpAccessNamespace } from '../../src/runtime/remote/acp-access-remote.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../../src/runtime/remote/session-reader-remote.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'

/** A mutable one-generation source (a real Connection generation is opaque). */
function generationSource(): RemoteConnectionGenerationSource & { set(next: RemoteConnectionGeneration | undefined): void } {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  return {
    getSnapshot: () => current,
    subscribe: () => () => {},
    set: next => { current = next },
  }
}

test('UNIT: getStatus returns the current generation\'s Host state', async () => {
  const generation = generationSource()
  let calls = 0
  const namespace: RemoteAcpAccessNamespace = {
    getStatus: async () => { calls += 1; return { ok: true, value: { state: 'disabled' } } },
    setEnabled: async () => ({ ok: true, value: { state: 'enabled' } }),
  }
  const port = new RemoteAcpAccessPort(namespace, generation)
  assert.deepEqual(await port.getStatus(), { state: 'disabled' })
  assert.equal(calls, 1)
})

test('UNIT: a result that lands after a generation change is a superseded read', async () => {
  const generation = generationSource()
  const namespace: RemoteAcpAccessNamespace = {
    getStatus: async () => {
      // The connection rolls over while this read is in flight.
      generation.set({ id: 2 })
      return { ok: true, value: { state: 'enabled' } }
    },
    setEnabled: async () => ({ ok: true, value: { state: 'enabled' } }),
  }
  const port = new RemoteAcpAccessPort(namespace, generation)
  await assert.rejects(port.getStatus(), SupersededReadError)
})

test('UNIT: a refusal landing after a generation change is superseded, not the new state', async () => {
  const generation = generationSource()
  const namespace: RemoteAcpAccessNamespace = {
    getStatus: async () => { throw new Error('host disappeared') },
    setEnabled: async () => { throw new Error('host disappeared') },
  }
  const port = new RemoteAcpAccessPort(namespace, generation)
  // Still current: a real failure propagates unchanged.
  await assert.rejects(port.getStatus(), /host disappeared/u)
  // A failure carried by a superseded generation is a superseded read.
  const flip: RemoteAcpAccessNamespace = {
    getStatus: async () => { generation.set({ id: 9 }); throw new Error('stale failure') },
    setEnabled: async () => ({ ok: true, value: { state: 'enabled' } }),
  }
  const port2 = new RemoteAcpAccessPort(flip, generation)
  await assert.rejects(port2.getStatus(), SupersededReadError)
})

test('UNIT: a dispatched setEnabled is never replayed when its reply is superseded', async () => {
  const generation = generationSource()
  let dispatched = 0
  const namespace: RemoteAcpAccessNamespace = {
    getStatus: async () => ({ ok: true, value: { state: 'disabled' } }),
    setEnabled: async () => {
      dispatched += 1
      generation.set({ id: 2 })
      return { ok: true, value: { state: 'enabled' } }
    },
  }
  const port = new RemoteAcpAccessPort(namespace, generation)
  await assert.rejects(port.setEnabled(true), SupersededReadError)
  // Exactly one dispatch: the adapter does not blind-retry an unknown write.
  assert.equal(dispatched, 1)
})

test('UNIT: an unmounted namespace or a disconnected Client fails closed', async () => {
  await assert.rejects(new RemoteAcpAccessPort(undefined, generationSource()).getStatus(),
    /Remote namespace is not mounted/u)
  const disconnected = generationSource()
  disconnected.set(undefined)
  const port = new RemoteAcpAccessPort({
    getStatus: async () => ({ ok: true, value: { state: 'enabled' } }),
    setEnabled: async () => ({ ok: true, value: { state: 'enabled' } }),
  }, disconnected)
  await assert.rejects(port.getStatus(), /not connected to a Host/u)
})

test('UNIT: setEnabled refuses BEFORE dispatch when the expected generation is stale', async () => {
  const generation = generationSource()
  let dispatched = 0
  const namespace: RemoteAcpAccessNamespace = {
    getStatus: async () => ({ ok: true, value: { state: 'enabled' } }),
    setEnabled: async () => { dispatched += 1; return { ok: true, value: { state: 'disabled' } } },
  }
  const port = new RemoteAcpAccessPort(namespace, generation)
  const hostA = generation.getSnapshot()
  // The Client reconnects to Host B before the user's Host-A choice is dispatched.
  generation.set({ id: 2 })
  await assert.rejects(port.setEnabled(false, hostA), /generation changed before dispatch/u)
  assert.equal(dispatched, 0, 'a stale-Host choice must never reach the newly connected Host')
})

test('UNIT: currentGeneration exposes the live generation identity for observation binding', async () => {
  const generation = generationSource()
  const port = new RemoteAcpAccessPort({
    getStatus: async () => ({ ok: true, value: { state: 'disabled' } }),
    setEnabled: async () => ({ ok: true, value: { state: 'enabled' } }),
  }, generation)
  const first = port.currentGeneration()
  assert.equal(first, generation.getSnapshot())
  generation.set({ id: 2 })
  assert.notEqual(port.currentGeneration(), first, 'a reconnect changes the observed generation identity')
})
