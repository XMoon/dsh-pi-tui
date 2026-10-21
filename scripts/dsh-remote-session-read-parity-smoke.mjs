#!/usr/bin/env node
/**
 * D1.1 same-Host parity smoke over the installed official DSH Host and Client
 * contracts at the checkout's declared target family.
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
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DirectSessionReader } from '../src/runtime/direct/session-direct.ts'
import { RemoteSessionReader } from '../src/runtime/remote/session-reader-remote.ts'
import { RemoteSessionReadShadow } from '../src/runtime/remote/session-read-shadow.ts'

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
  /**
   * Import one official Client bundle from whichever channel its published
   * `./client` entry selects. DSH 0.2.1-rc.1+ splits that entry into a
   * standalone Node ESM half (`node`, which never registers through
   * `__ModuleLoader__`) and a browser loader factory (`browser`/`default`).
   * A browser registration always wins; the Node namespace only fills a gap,
   * into the SAME table the registering factories resolve `/client`
   * dependencies from.
   */
  const importClient = async (specifier) => {
    const id = specifier.slice(0, -'/client'.length)
    const imported = await import(specifier)
    if (!modules.has(id)) modules.set(id, imported)
    return modules.get(id)
  }
  return {
    modules,
    importClient,
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
  // rc.2: the Gateway and the SessionController both inject the official
  // access decider, so the Host mounts it before either is injected.
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectory)
  provideHostPeripheralServices(ctx)
  ctx.get('sessionProjections').register(titleProjectionDefinition)
  ctx.get('sessionProjections').register(agentPresetProjectionDefinition)
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

async function assertExpectedReaderState(reader, searchQuery, expectedTitle, expectedAgentPreset) {
  const rows = await reader.list('parity-session')
  assert.ok(rows !== undefined, 'parity reader list is unavailable')
  assert.ok(rows.some(row => String(row.id) === 'parity-session'), 'parity reader list omitted the fixture session')
  const projections = await reader.projectionBatch(rows)
  const projection = projections.get('parity-session')
  assert.equal(projection?.title, expectedTitle, 'parity reader did not expose the expected title projection')
  assert.equal(projection?.preset, expectedAgentPreset, 'parity reader did not expose the expected agentPreset projection')
  const search = await reader.search(searchQuery)
  assert.ok(search !== undefined, 'parity reader search is unavailable')
  assert.ok(search.items.some(item => item.sessionId === 'parity-session'), 'parity reader search did not hit the fixture session')
}

function hostTransport(host) {
  const connection = host.ctx.get('connection')
  const shared = connection.createSharedFetchHandler('/api')
  // The official Gateway speaks for the Host Connection's own owner Peer on
  // both carrier paths (DSH 0.2.1-rc.2 requires an explicit Peer).
  const peer = connection.browserPeer
  /** The alpha.2 client stream carrier contract passes an optional uplink;
   * the Host wire face always takes one, so an absent uplink is an empty one. */
  async function* emptyUplink() {}
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-parity.local'), init)
      return shared.fetch(request, peer)
    },
    openStream(endpoint, payload, signal, uplink) {
      return (async function* () {
        // alpha.2 wire face: (endpoint, payload, uplink, peer, signal) — the
        // operator's in-process carrier has no peer scope.
        yield* await host.ctx.get('typertGateway').wireStream.open(endpoint, payload, uplink ?? emptyUplink(), peer, signal)
      })()
    },
  }
}

async function main() {
  const loader = installModuleLoader()
  let client
  let host
  try {
    const connectionClient = await loader.importClient('@deepseek-ai/dsh-client-connection/client')
    const gatewayClient = await loader.importClient('@deepseek-ai/dsh-api-gateway/client')
    const sessionClient = await loader.importClient('@deepseek-ai/dsh-api-session-controller/client')
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
    // M3-3A retired the measureContext skip: the official contextPressure
    // semantic now compares (both backends read unmeasured here — the
    // fixture reports no provider usage — and that EQUALITY is the parity).
    assert.ok(!outcome.report.skipped.some(field => field.field === 'measureContext'))
    assert.ok(!outcome.report.mismatches.some(mismatch => mismatch.field === 'measureContext'))
    assert.equal(sessions.list.getSnapshot().ids.includes('parity-session'), true)
    await assertExpectedReaderState(direct, 'parity needle', 'Same Host parity', 'fixture-preset')
    await assertExpectedReaderState(remote, 'parity needle', 'Same Host parity', 'fixture-preset')

    host.session.append('agent-preset/selected', { agentPreset: 'fixture-preset-updated' })
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
    await assertExpectedReaderState(direct, 'host update', 'Same Host parity updated', 'fixture-preset-updated')
    await assertExpectedReaderState(remote, 'host update', 'Same Host parity updated', 'fixture-preset-updated')

    console.log('dsh same-Host remote session parity smoke passed: list/title/agentPreset projection/search matched expected data before and after Host update')
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
