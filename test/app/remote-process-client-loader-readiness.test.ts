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
import { SessionId } from '@deepseek-ai/dsh-session'
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
  onOpenStream: (endpoint: string) => void,
): Promise<{ gatewayFiber: Awaited<ReturnType<Context['plugin']>> }> {
  await ctx.plugin(typertClient)
  await ctx.plugin(connectionCtx => {
    connectionClient.installConnection(connectionCtx, {
      interactions: 'answer',
      transport: {
        ownsHost: true,
        fetch: carrier.fetch,
        openStream: (endpoint, ...args) => {
          onOpenStream(endpoint)
          return carrier.openStream(endpoint, ...args)
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
  await installClientTransport(ctx, hostRuntime.carrier, endpoint => { if (endpoint === '$events') openStreams += 1 })
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
  let observedQuestion = false
  const delivery = createSplitClientInteractionDelivery({
    remote: ctx.get('remote') as never,
    sessions: prerequisites.sessions,
  })
  delivery.attachSurface(1, {
    onQuestion: async () => {
      observedQuestion = true
      return PROCEED
    },
    onApproval: () => 'rejected',
  })
  gate.release()
  const domains = await prerequisites.complete()
  assert.equal(openStreams, 1, 'the official Gateway must start exactly one event stream after the gate opens')
  assert.ok(domains.connection.generation.getSnapshot() !== undefined, 'the first real Connection generation must exist after readiness')
  assert.equal(domains.sessions.list.getSnapshot().phase, 'ready')

  // REAL producer -> official resolver -> root listener -> official result:
  // a pending Host question is forwarded to the mounted dispatcher and the
  // answer settles the Host waterfall. A missing `next` fallback would reject
  // this ask with NO_PROVIDER instead.
  const userQuestions = host.ctx.get('userQuestions') as unknown as {
    ask(request: unknown): Promise<{ readonly answers: readonly { readonly id: string; readonly selected: readonly string[] }[] }>
  }
  const agent = await host.harness.create(SessionId('m4-c1b-loader-answer'))
  const answer = await userQuestions.ask({
    agent,
    questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Proceed' }] }],
  })
  assert.equal(observedQuestion, true, 'the real Host pending question was not forwarded to the root listener')
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['Proceed'] }])

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
  const { gatewayFiber } = await installClientTransport(ctx, hostRuntime.carrier, endpoint => { if (endpoint === '$events') openStreams += 1 })
  // Production stop order: the official Gateway/Connection is disposed
  // BEFORE the cancelled gate settles, so the pending upstream `loader.await`
  // can never call a live `connection.start()` afterwards.
  await gatewayFiber.dispose()
  gate.cancel(new Error('stop before gate'))
  await (ctx.get('loader') as Loader).await()
  assert.equal(openStreams, 0, 'a cancelled startup must never call connection.start()')
  await hostRuntime.dispose()
})

test('a forwarded Host question without the Session resolver fails closed instead of delegating', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'preset')
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  let openStreams = 0
  const gate = await installGate(ctx)
  await installClientTransport(ctx, hostRuntime.carrier, endpoint => { if (endpoint === '$events') openStreams += 1 })
  gate.release()
  const deadline = Date.now() + 15_000
  const connection = ctx.get('connection') as unknown as {
    generation: { getSnapshot(): unknown }
  }
  while (connection.generation.getSnapshot() === undefined) {
    if (Date.now() > deadline) throw new Error('the Gateway never reached its first generation')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const userQuestions = host.ctx.get('userQuestions') as unknown as {
    ask(request: unknown): Promise<unknown>
  }
  const agent = await host.harness.create(SessionId('m4-c1b-loader-no-resolver'))
  await assert.rejects(
    userQuestions.ask({ agent, questions: [{ id: 'q1', question: 'Continue?' }] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NO_PROVIDER')
      return true
    },
    'a missing official Session resolver must fail closed with NO_PROVIDER',
  )
  assert.equal(openStreams, 1, 'the missing-resolver negative must still start the real Gateway once')
  await hostRuntime.dispose()
})
