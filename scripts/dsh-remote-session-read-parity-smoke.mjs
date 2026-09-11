#!/usr/bin/env node
/**
 * D1.1 same-Host parity smoke over official rc1 Host and Client contracts.
 *
 * One Host Context owns the live Session, projections, SQLite query provider,
 * Session Controller, Gateway, and forwarded-event source. Direct reads that
 * Context; an independent official Client Context reaches the same Host through
 * the official Connection/Gateway carrier. The two semantic readers are then
 * compared through the generation-fenced shadow.
 *
 * @module dsh-remote-session-read-parity-smoke
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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DirectSessionReader } from '../src/runtime/direct/session-direct.ts'
import { RemoteSessionReader } from '../src/runtime/remote/session-reader-remote.ts'
import { RemoteSessionReadShadow } from '../src/runtime/remote/session-read-shadow.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png']),
})

function installModuleLoader() {
  const nodeRequire = createRequire(import.meta.url)
  const modules = new Map()
  const previousWindow = globalThis.window
  const previousLocation = globalThis.location
  const previousTransport = globalThis.__DSH_TRANSPORT__
  const requireModule = (specifier) => {
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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-parity.local', search: '' }
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
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'fixture' }],
  })
  ctx.provide('attachments', {
    imageLimits: IMAGE_LIMITS,
    admitPromptContent: async content => content.map(part => {
      if (part.type === 'image') throw new Error('parity smoke did not configure image persistence')
      return part
    }),
  })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  })
  ctx.provide('workspaceRegistry', {})
  ctx.provide('webServer', {
    registerUpgrade: () => () => {},
  })
}

async function createHost() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  provideHostPeripheralServices(ctx)
  ctx.get('sessionProjections').register(titleProjectionDefinition)
  await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })

  await ctx.inject(SessionController.inject, controllerCtx => {
    new SessionController(controllerCtx, { nativeOpen: false })
  })
  await ctx.plugin(hostCtx => {
    new HostConnectionService(hostCtx, [], {})
  })
  await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
    new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
  })
  await ctx.plugin({ inject: apiRemotesInject, apply: applyApiRemotes })

  const session = ctx.get('sessions').create(SessionId('parity-session'), {
    meta: {
      cwd: '/tmp/dsh-d1-1-parity',
      createdAt: 1_000,
      agentPreset: 'fixture-preset',
    },
  })
  const message = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'same host parity needle' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Same Host parity',
    messageSeqs: [message.seq],
    source: { kind: 'user' },
  })

  return { ctx, session }
}

async function assertExpectedReaderState(reader, searchQuery, expectedTitle) {
  const rows = await reader.list('parity-session')
  assert.ok(rows !== undefined, 'parity reader list is unavailable')
  assert.ok(rows.some(row => String(row.id) === 'parity-session'), 'parity reader list omitted the fixture session')
  const projections = await reader.projectionBatch(rows)
  assert.equal(projections.get('parity-session')?.title, expectedTitle, 'parity reader did not expose the expected title projection')
  const search = await reader.search(searchQuery)
  assert.ok(search !== undefined, 'parity reader search is unavailable')
  assert.ok(search.items.some(item => item.sessionId === 'parity-session'), 'parity reader search did not hit the fixture session')
}

function hostTransport(host) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-parity.local'), init)
      return shared.fetch(request)
    },
    openStream(endpoint, payload, signal) {
      return (async function* () {
        yield* await host.ctx.get('typertGateway').wireStream.open(endpoint, payload, signal)
      })()
    },
  }
}

async function main() {
  const loader = installModuleLoader()
  let client
  let host
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

    const started = Date.now()
    const connection = client.get('connection')
    const sessions = client.get('sessions')
    while (connection.generation.getSnapshot() === undefined
      || sessions.list.getSnapshot().phase !== 'ready') {
      if (Date.now() - started > 5_000) throw new Error('timed out waiting for same-Host Client readiness')
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const direct = new DirectSessionReader(host.ctx, {
      sessionOf: id => host.ctx.get('sessions').get(id),
      agentOf: () => undefined,
    })
    const remote = new RemoteSessionReader(sessions, connection.generation)
    const shadow = new RemoteSessionReadShadow(direct, remote, connection.generation)
    const outcome = await shadow.compare({ currentSessionId: 'parity-session', searchQuery: 'parity needle' })
    assert.equal(outcome.status, 'compared')
    assert.equal(outcome.report.comparable, true)
    assert.deepEqual(outcome.report.mismatches, [])
    assert.ok(outcome.report.skipped.some(field => field.field === 'createdAt'))
    assert.ok(outcome.report.skipped.some(field => field.field === 'live'))
    assert.ok(outcome.report.skipped.some(field => field.field === 'measureContext'))
    assert.equal(sessions.list.getSnapshot().ids.includes('parity-session'), true)
    await assertExpectedReaderState(direct, 'parity needle', 'Same Host parity')
    await assertExpectedReaderState(remote, 'parity needle', 'Same Host parity')

    const nextMessage = host.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'host update parity needle' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    host.session.append('session/title', {
      title: 'Same Host parity updated',
      messageSeqs: [nextMessage.seq],
      source: { kind: 'user' },
    })
    await sessions.refresh()
    const afterHostUpdate = await shadow.compare({ currentSessionId: 'parity-session', searchQuery: 'host update' })
    assert.equal(afterHostUpdate.status, 'compared')
    assert.equal(afterHostUpdate.report.comparable, true)
    assert.deepEqual(afterHostUpdate.report.mismatches, [])
    await assertExpectedReaderState(direct, 'host update', 'Same Host parity updated')
    await assertExpectedReaderState(remote, 'host update', 'Same Host parity updated')

    console.log('dsh same-Host remote session parity smoke passed: list/projection/search matched expected data before and after Host update')
  } finally {
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) await host.ctx.fiber.dispose()
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_SESSION_READ_PARITY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
