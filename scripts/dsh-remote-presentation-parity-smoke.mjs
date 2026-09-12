#!/usr/bin/env node
/**
 * D1.3 same-Host history/live presentation parity smoke over the official
 * SessionBinding.eventSource and SessionFace.loadOlder contracts.
 *
 * @module dsh-remote-presentation-parity-smoke
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { DirectPresentationReader } from '../src/runtime/direct/presentation-read-direct.ts'
import { RemotePresentationReader } from '../src/runtime/remote/presentation-read-remote.ts'
import { RemotePresentationReadShadow } from '../src/runtime/remote/presentation-read-shadow.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

function installModuleLoader() {
  const nodeRequire = createRequire(import.meta.url)
  const modules = new Map()
  const previousWindow = globalThis.window
  const previousLocation = globalThis.location
  const previousTransport = globalThis.__DSH_TRANSPORT__
  const requireModule = specifier => {
    if (specifier.endsWith('/client')) {
      const id = specifier.slice(0, -'/client'.length)
      const module = modules.get(id)
      if (module === undefined) throw new Error(`official Client module ${specifier} loaded before ${id}`)
      return module
    }
    return nodeRequire(specifier)
  }
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        if (modules.has(id)) throw new Error(`official Client module ${id} loaded twice`)
        modules.set(id, factory(requireModule))
      },
    },
  }
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-presentation-parity.local', search: '' }
  return {
    modules,
    restore() {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
      if (previousLocation === undefined) delete globalThis.location
      else globalThis.location = previousLocation
      if (previousTransport === undefined) delete globalThis.__DSH_TRANSPORT__
      else globalThis.__DSH_TRANSPORT__ = previousTransport
    },
  }
}

function provideHostPeripheralServices(ctx) {
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture' }),
    saveSelection: async () => {},
  })
  ctx.provide('llm', { listProviders: () => [{ id: 'fixture', name: 'fixture' }] })
  ctx.provide('attachments', {
    imageLimits: Object.freeze({
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2000,
      mediaTypes: Object.freeze(['image/png']),
    }),
    admitPromptContent: async content => content,
  })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  })
  ctx.provide('workspaceRegistry', {})
  ctx.provide('webServer', { registerUpgrade: () => () => {} })
}

function appendTurn(session, turn, text, context = false) {
  session.append('turn/start', { turn })
  if (context) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `fixture context ${turn}` }],
      source: { kind: 'plugin', plugin: 'fixture', form: 'notice', summary: 'fixture context' },
    }), { surfaceOp: 'append' })
  }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 0 })
  session.append('assistant/message', {
    turn,
    step: 0,
    message: {
      id: MessageId(`presentation-assistant-${turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: `answer ${turn}` }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function createHost() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  provideHostPeripheralServices(ctx)
  ctx.get('sessionProjections').register(titleProjectionDefinition)
  ctx.get('sessionProjections').register(agentPresetProjectionDefinition)
  await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  await ctx.inject(SessionController.inject, controllerCtx => {
    new SessionController(controllerCtx, { nativeOpen: false })
  })
  await ctx.plugin(hostCtx => { new HostConnectionService(hostCtx, [], {}) })
  await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
    new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
  })
  await ctx.plugin({ inject: apiRemotesInject, apply: applyApiRemotes })

  const session = ctx.get('sessions').create(SessionId('presentation-session'), {
    meta: { cwd: '/tmp/dsh-d1-3-presentation', createdAt: 4_000 },
  })
  for (let turn = 0; turn < 60; turn += 1) appendTurn(session, turn, `prompt ${turn}`, turn === 0)

  const agentFiber = ctx.plugin(() => {})
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx: agentFiber.ctx,
    inbox: { nextTurn: [], nextStep: [] },
  }
  ctx.get('agents').register(agent)
  return { ctx, session, agent }
}

function hostTransport(host) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-presentation-parity.local'), init)
      return shared.fetch(request)
    },
    openStream(endpoint, payload, signal) {
      return (async function* () {
        yield* await host.ctx.get('typertGateway').wireStream.open(endpoint, payload, signal)
      })()
    },
  }
}

async function waitFor(description, predicate) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function main() {
  const loader = installModuleLoader()
  let client
  let host
  let shadow
  try {
    await import('@deepseek-ai/dsh-client-connection/client')
    await import('@deepseek-ai/dsh-api-gateway/client')
    await import('@deepseek-ai/dsh-api-session-controller/client')
    const connectionClient = loader.modules.get(PACKAGE_IDS.connection)
    const gatewayClient = loader.modules.get(PACKAGE_IDS.gateway)
    const sessionClient = loader.modules.get(PACKAGE_IDS.session)
    assert.ok(connectionClient !== undefined, 'official Connection Client did not load')
    assert.ok(gatewayClient !== undefined, 'official API Gateway Client did not load')
    assert.ok(sessionClient !== undefined, 'official Session Controller Client did not load')

    host = await createHost()
    globalThis.__DSH_TRANSPORT__ = hostTransport(host)

    client = new Context()
    await client.plugin(TypertRegistry)
    await client.plugin(connectionClient)
    await client.plugin(gatewayClient)
    for (const contribution of [commandsRemote, subagentsRemote, sessionRemote]) {
      await client.remote.$mount(contribution)
    }
    client.provide('fileUpload', { available: false })
    await client.plugin(sessionClient)

    const connection = client.get('connection')
    const sessions = client.get('sessions')
    await waitFor('official Client readiness', () => connection.generation.getSnapshot() !== undefined && sessions.list.getSnapshot().phase === 'ready')
    sessions.open(SessionId('presentation-session'))
    await waitFor('presentation binding', () => {
      const binding = sessions.binding(SessionId('presentation-session'))
      return binding !== undefined && binding.session.getSnapshot().openState === 'open' && binding.eventSource.getSnapshot().entries.length > 0
    })

    const liveAttemptId = 'presentation-smoke-live-attempt'
    const liveTurn = 60
    const liveTime = 1_700_000_000_060
    const liveChunk = { type: 'text-delta', index: 0, text: 'live fixture chunk' }
    const liveInputs = [
      { kind: 'start', sessionId: 'presentation-session', attemptId: liveAttemptId, turn: liveTurn, step: 0 },
      { kind: 'chunk', sessionId: 'presentation-session', attemptId: liveAttemptId, turn: liveTurn, step: 0, time: liveTime, chunk: liveChunk },
    ]
    const emit = host.ctx.emit.bind(host.ctx)
    emit('agent/assistant-stream', {
      agent: host.agent,
      frame: { type: 'start', attemptId: liveAttemptId, revision: 1, turn: liveTurn, step: 0 },
    })
    emit('agent/assistant-stream', {
      agent: host.agent,
      frame: { type: 'chunk', attemptId: liveAttemptId, revision: 2, index: 0, time: liveTime, chunk: liveChunk },
    })
    await waitFor('official Client transient baseline', () => {
      const binding = sessions.binding(SessionId('presentation-session'))
      return binding?.eventSource.getSnapshot().entries.some(entry => entry.type === 'transient') === true
    })

    const direct = new DirectPresentationReader({
      agentFor: id => String(host.agent.id) === id ? host.agent : undefined,
      assistantStreamBaselineFor: () => liveInputs,
    })
    const remote = new RemotePresentationReader(sessions, connection.generation)
    shadow = new RemotePresentationReadShadow(direct, remote, connection.generation)

    let remoteSnapshot = await remote.read('presentation-session')
    assert.ok(remoteSnapshot !== undefined)
    assert.equal(remoteSnapshot.liveInputs.length, 2, 'fixture did not retain the live transient baseline')
    assert.equal(remoteSnapshot.hasMore, true, 'fixture did not produce a paged Client tail')
    let comparisons = 0
    while (true) {
      const outcome = await shadow.compare({
        sessionId: 'presentation-session',
        projection: { focusMode: true, windowTurns: 20 },
      })
      assert.equal(outcome.status, 'compared')
      assert.equal(outcome.report.comparable, true)
      assert.deepEqual(outcome.report.mismatches, [])
      comparisons += 1
      if (!remoteSnapshot.hasMore) break

      const before = remoteSnapshot.durableEvents.map(event => event.seq)
      remoteSnapshot = await remote.loadOlder('presentation-session')
      assert.ok(remoteSnapshot !== undefined)
      const after = remoteSnapshot.durableEvents.map(event => event.seq)
      assert.ok(after.length > before.length, 'loadOlder did not extend the durable window')
      assert.deepEqual(after.slice(-before.length), before, 'older paging changed the retained overlap')
    }

    const directSnapshot = await direct.read('presentation-session')
    assert.ok(directSnapshot !== undefined)
    assert.equal(remoteSnapshot.durableEvents.length, directSnapshot.durableEvents.length)
    assert.equal(remoteSnapshot.hasMore, false)
    assert.ok(comparisons >= 2)
    console.log(JSON.stringify({
      status: 'passed',
      comparable: true,
      mismatchCount: 0,
      skipped: [],
       liveInputs: liveInputs.length,
      pagesCompared: comparisons,
      durableEvents: remoteSnapshot.durableEvents.length,
    }))
  } finally {
    shadow?.dispose()
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) await host.ctx.fiber.dispose()
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_PRESENTATION_PARITY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
