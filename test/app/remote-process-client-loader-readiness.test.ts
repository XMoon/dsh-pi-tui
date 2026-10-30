/**
 * Split-Client Loader readiness gate.
 *
 * Evidence level: L5 composition over the REAL Cordis Loader, the official
 * Connection client and the official API Gateway client, with the real
 * in-process Host runtime and the official Session Client mounted as domain
 * prerequisites. The two-OS-process PTY proof lives in the split-process smoke.
 *
 * The contract pinned here is the startup order the split Client must have:
 * the official Gateway may not start its event pump until the official Session
 * Agent resolver and the root interaction listeners exist. A pending Loader
 * builtin entry is the real upstream gate; an abort/failure must leave the
 * pump unstarted.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-client-loader-readiness.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as connectionClient from '@deepseek-ai/dsh-client-connection/client'
import * as gatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import * as typertClient from '@deepseek-ai/dsh-typert-registry/client'
import { createRemoteHostRuntime, type InProcessHostCarrier } from '../../src/app/remote/host-runtime.ts'
import { mountRemoteClientDomainPrerequisites } from '../../src/app/remote/client-runtime.ts'
import { createSplitClientInteractionDelivery } from '../../src/app/remote-process/client-interaction-delivery.ts'
import {
  createInteractionStartupGate,
  INTERACTION_STARTUP_GATE,
} from '../../src/app/remote-process/local-client-entry.ts'
import { createRemoteApplicationHostFixture, testLifecycle } from '../support/remote-application-fixture.ts'

const PROCEED = { answers: [{ id: 'q1', selected: ['Proceed'] }] }

/** Install typert -> Connection -> Gateway over one in-process Host carrier. */
async function installClientTransport(
  ctx: Context,
  carrier: InProcessHostCarrier,
  onOpenStream: () => void,
): Promise<{ gatewayFiber: Awaited<ReturnType<Context['plugin']>> }> {
  await ctx.plugin(typertClient)
  await ctx.plugin(connectionCtx => {
    connectionClient.installConnection(connectionCtx, {
      interactions: 'answer',
      transport: {
        ownsHost: true,
        fetch: carrier.fetch,
        openStream: (...args: Parameters<InProcessHostCarrier['openStream']>) => {
          onOpenStream()
          return carrier.openStream(...args)
        },
      },
    })
  })
  const gatewayFiber = await ctx.plugin(gatewayClient)
  return { gatewayFiber }
}

/** The production gate helper over a real Loader service. */
async function installGate(ctx: Context): Promise<ReturnType<typeof createInteractionStartupGate>> {
  await ctx.plugin(Loader)
  const loader = ctx.get('loader') as Loader
  const gate = createInteractionStartupGate()
  loader.builtins[INTERACTION_STARTUP_GATE] = gate.plugin as never
  await loader.create({ name: `cordis:${INTERACTION_STARTUP_GATE}` })
  return gate
}

test('the official Gateway does not start until the Loader gate, Session resolver and root listeners are ready', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'preset')
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  let openStreams = 0
  const gate = await installGate(ctx)
  await installClientTransport(ctx, hostRuntime.carrier, () => { openStreams += 1 })
  assert.equal(openStreams, 0, 'the official Gateway must not open its event stream while the Loader gate is pending')
  assert.equal((ctx.get('loader') as Loader).getTasks().length, 1, 'the gate entry must remain a pending Loader task')

  // Domain prerequisites install the official Session Client (the Agent scope
  // resolver) before the event pump is allowed to start.
  const prerequisites = await mountRemoteClientDomainPrerequisites({ context: ctx })
  const typert = ctx.get('typert') as unknown as {
    contexts: { getClient(name: string): unknown }
  }
  assert.notEqual(typert.contexts.getClient('agent'), undefined, 'the official Session Agent resolver must exist before the gate opens')

  // The root delivery owner registers its two `$on` listeners exactly once
  // before the official pump can consume a Host-pending forwarded event.
  const delivery = createSplitClientInteractionDelivery({
    remote: ctx.get('remote') as never,
    sessions: prerequisites.sessions,
  })
  delivery.attachSurface(1, {
    onQuestion: async () => PROCEED,
    onApproval: () => 'rejected',
  })
  gate.release()
  const domains = await prerequisites.complete()
  assert.ok(openStreams > 0, 'the official Gateway must start its event stream after the gate opens')
  assert.ok(domains.connection.generation.getSnapshot() !== undefined, 'the first real Connection generation must exist after readiness')
  assert.equal(domains.sessions.list.getSnapshot().phase, 'ready')
  delivery.dispose()
  await domains.dispose()
  await hostRuntime.dispose()
})

test('a cancelled startup disposes the Gateway before the Loader barrier settles', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'preset')
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  let openStreams = 0
  const gate = await installGate(ctx)
  const { gatewayFiber } = await installClientTransport(ctx, hostRuntime.carrier, () => { openStreams += 1 })
  // Production stop order: the official Gateway/Connection is disposed
  // BEFORE the cancelled gate settles, so the pending upstream `loader.await`
  // can never call a live `connection.start()` afterwards.
  await gatewayFiber.dispose()
  gate.cancel(new Error('stop before gate'))
  await (ctx.get('loader') as Loader).await()
  assert.equal(openStreams, 0, 'a cancelled startup must never call connection.start()')
  await hostRuntime.dispose()
})

test('a gate that fails before the Gateway is installed never starts it', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'preset')
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const gate = await installGate(ctx)
  gate.cancel(new Error('gate activation failed'))
  assert.equal(gate.pending, false)
  // The production entry checks the gate state before installing the Gateway;
  // a failed gate therefore leaves no official pump to start.
  const { gatewayFiber } = await (async () => {
    assert.throws(() => {
      if (!gate.pending) throw new Error('local client entry: the interaction startup gate failed before the transport install')
    }, /gate failed before the transport install/u)
    return { gatewayFiber: undefined }
  })()
  assert.equal(gatewayFiber, undefined)
  await (ctx.get('loader') as Loader).await()
  await hostRuntime.dispose()
})
