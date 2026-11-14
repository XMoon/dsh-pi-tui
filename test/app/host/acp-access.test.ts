/**
 * UNIT: the private `piTuiAcpAccess` Host service facade (PO-1B).
 *
 * The service owns NO socket, scope or enabled flag: it forwards strictly to the
 * CURRENT entry-owned controller read from the root Host Context
 * (`piTuiAcpOwner`). A Host without an installed owner answers a truthful
 * `unavailable` and never starts a listener; a rejected mutation propagates
 * instead of being swallowed; and each call re-reads the live controller rather
 * than caching a composition snapshot.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/acp-access.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PiTuiAcpAccessHostService } from '../../../src/app/host/features/acp-access.ts'
import type { PiTuiAcpAccessStatus } from '../../../src/runtime/remote/pi-tui-acp-access-contract.ts'

/** Build a real Host Context with a structural typert and (optionally) the owner. */
async function makeService(owner?: unknown): Promise<{
  service: PiTuiAcpAccessHostService
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  ctx.provide('typert', { register: async () => undefined })
  if (owner !== undefined) ctx.provide('piTuiAcpOwner', owner)
  const fiber = ctx.inject(PiTuiAcpAccessHostService.inject, pluginCtx => {
    new PiTuiAcpAccessHostService(pluginCtx)
  })
  await fiber
  const service = ctx.reflect.get('piTuiAcpAccess') as PiTuiAcpAccessHostService
  return {
    service,
    dispose: async () => { await fiber.dispose() },
  }
}

test('UNIT: with no installed owner the service answers a truthful unavailable', async () => {
  const { service, dispose } = await makeService(undefined)
  try {
    const status = await service.getStatus()
    assert.equal(status.state, 'unavailable')
    assert.match((status as { reason: string }).reason, /not available/u)
    const toggled = await service.setEnabled(true)
    assert.equal(toggled.state, 'unavailable')
  } finally {
    await dispose()
  }
})

test('UNIT: the service forwards getStatus/setEnabled to the live controller', async () => {
  const calls: boolean[] = []
  let state: PiTuiAcpAccessStatus = { state: 'disabled' }
  const owner = {
    getStatus: async () => state,
    setEnabled: async (enabled: boolean) => {
      calls.push(enabled)
      state = enabled ? { state: 'enabled' } : { state: 'disabled' }
      return state
    },
  }
  const { service, dispose } = await makeService(owner)
  try {
    assert.deepEqual(await service.getStatus(), { state: 'disabled' })
    assert.deepEqual(await service.setEnabled(true), { state: 'enabled' })
    assert.deepEqual(await service.setEnabled(false), { state: 'disabled' })
    assert.deepEqual(calls, [true, false])
  } finally {
    await dispose()
  }
})

test('UNIT: each call re-reads the current owner (no cached composition snapshot)', async () => {
  let reads = 0
  const owner = {
    getStatus: async () => { reads += 1; return { state: 'enabled' } as PiTuiAcpAccessStatus },
    setEnabled: async () => ({ state: 'enabled' } as PiTuiAcpAccessStatus),
  }
  const { service, dispose } = await makeService(owner)
  try {
    await service.getStatus()
    await service.getStatus()
    assert.equal(reads, 2)
  } finally {
    await dispose()
  }
})

test('UNIT: a rejected mutation propagates (never swallowed into a fabricated state)', async () => {
  const owner = {
    getStatus: async () => ({ state: 'disabled' } as PiTuiAcpAccessStatus),
    setEnabled: async () => { throw new Error('socket in use') },
  }
  const { service, dispose } = await makeService(owner)
  try {
    await assert.rejects(service.setEnabled(true), /socket in use/u)
    // A later status read is still truthful.
    assert.deepEqual(await service.getStatus(), { state: 'disabled' })
  } finally {
    await dispose()
  }
})
