#!/usr/bin/env node
/**
 * D1.2 same-Host command/skill authority parity smoke over the pinned DSH
 * Source Mode contracts.
 *
 * One Host Context owns a real Session, Agent scope, command/skill registries,
 * Session Controller, Gateway, and official Connection. An independent Client
 * Context reaches that Host through generated Remotes. The Remote result is
 * compared with the Direct collector; no command or skill is executed.
 *
 * @module dsh-remote-surface-authority-parity-smoke
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { DirectSurfaceAuthorityReader } from '../src/runtime/direct/surface-authority-direct.ts'
import { RemoteSurfaceAuthorityReader } from '../src/runtime/remote/surface-authority-remote.ts'
import { RemoteSurfaceAuthorityShadow } from '../src/runtime/remote/surface-authority-shadow.ts'

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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-authority.local', search: '' }
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
  ctx.provide('webServer', {
    registerUpgrade: () => () => {},
  })
}

async function createHost() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
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
  await ctx.plugin(hostCtx => {
    new HostConnectionService(hostCtx, [], {})
  })
  await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
    new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
  })
  await ctx.plugin({ inject: apiRemotesInject, apply: applyApiRemotes })

  const session = ctx.get('sessions').create(SessionId('authority-session'), {
    meta: {
      cwd: '/tmp/dsh-d1-2-authority',
      createdAt: 2_000,
      agentPreset: 'fixture-preset',
    },
  })
  const agent = {
    id: session.id,
    session,
  }
  const agentScope = createScope(ctx, agent)
  agent.ctx = agentScope.ctx
  ctx.get('agents').register(agent)

  ctx.get('commands').register({
    definitionId: CommandDefinitionId('fixture/execute'),
    name: 'fixture-execute',
    description: 'Execute-kind fixture command',
    handler: async () => ({ kind: 'success' }),
  })
  ctx.get('commands').register({
    definitionId: CommandDefinitionId('fixture/leading'),
    name: 'fixture-leading',
    description: 'Leading-input fixture command',
    input: { hint: '<objective>', attachments: true },
    handler: async () => ({ kind: 'success' }),
  })
  // A same-name scoped shadow proves that the Remote command view uses the
  // exact live Agent scope and selects the scoped winner over the global one.
  ctx.get('commands').register({
    definitionId: CommandDefinitionId('fixture/shadow-global'),
    name: 'fixture-shadow',
    description: 'Global shadow fixture command',
    input: { hint: '<global>' },
    handler: async () => ({ kind: 'success' }),
  })
  agentScope.ctx.get('commands').register({
    definitionId: CommandDefinitionId('fixture/shadow-scoped'),
    name: 'fixture-shadow',
    description: 'Scoped shadow fixture command',
    input: { hint: '<scoped>', attachments: true },
    handler: async () => ({ kind: 'success' }),
  })

  ctx.get('skills').register({
    name: 'fixture-human-model',
    description: 'Human and model fixture skill',
    content: 'human model fixture body',
    invocation: { modelInvocable: true, userInvocable: true },
  })
  ctx.get('skills').register({
    name: 'fixture-human-only',
    description: 'Human-only fixture skill',
    content: 'human-only fixture body',
    invocation: { modelInvocable: false, userInvocable: true },
  })
  ctx.get('skills').register({
    name: 'fixture-model-only',
    description: 'Model-only fixture skill',
    content: 'model-only fixture body',
    invocation: { modelInvocable: true, userInvocable: false },
  })
  agentScope.ctx.get('skills').register({
    name: 'fixture-scoped-human-only',
    description: 'Scoped human-only fixture skill',
    content: 'scoped human-only fixture body',
    invocation: { modelInvocable: false, userInvocable: true },
  })

  return { ctx, session, agent, agentScope }
}

async function waitFor(description, predicate, timeoutMs = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function hostTransport(host) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-authority.local'), init)
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
    for (const contribution of [commandsRemote, sessionRemote]) {
      await client.remote.$mount(contribution)
    }
    client.provide('fileUpload', { available: false })
    await client.plugin(sessionClient)

    const started = Date.now()
    const connection = client.get('connection')
    while (connection.generation.getSnapshot() === undefined) {
      if (Date.now() - started > 5_000) throw new Error('timed out waiting for authority Client readiness')
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const direct = new DirectSurfaceAuthorityReader(
      host.ctx,
      sessionId => String(host.agent.id) === sessionId ? host.agent : undefined,
    )
    const remote = new RemoteSurfaceAuthorityReader(
      {
        commands: client.remote.commands,
        skills: client.remote.skills,
      },
      connection.generation,
    )
    shadow = new RemoteSurfaceAuthorityShadow(direct, remote, connection.generation)
    const outcome = await shadow.compare({ sessionId: 'authority-session' })
    assert.equal(outcome.status, 'compared')
    assert.ok(outcome.status === 'compared')
    assert.equal(outcome.report.comparable, true)
    assert.deepEqual(outcome.report.mismatches, [])

    const directSnapshot = await direct.read('authority-session')
    const remoteSnapshot = await remote.read('authority-session')
    assert.deepEqual(remoteSnapshot, directSnapshot)
    assert.ok((remoteSnapshot?.commands.length ?? 0) >= 3, 'Remote command authority must be non-empty')
    assert.equal(remoteSnapshot?.commands.find(command => command.name === 'fixture-execute')?.definitionId, 'fixture/execute')
    assert.equal(remoteSnapshot?.commands.find(command => command.name === 'fixture-leading')?.input?.hint, '<objective>')
    assert.equal(remoteSnapshot?.commands.find(command => command.name === 'fixture-leading')?.input?.attachments, true)
    const shadowCommands = remoteSnapshot?.commands.filter(command => command.name === 'fixture-shadow') ?? []
    assert.equal(shadowCommands.length, 1, 'same-name shadow must expose one effective command')
    assert.equal(shadowCommands[0]?.definitionId, 'fixture/shadow-scoped')
    assert.equal(shadowCommands[0]?.description, 'Scoped shadow fixture command')
    assert.equal(shadowCommands[0]?.input?.hint, '<scoped>')
    assert.equal(shadowCommands[0]?.input?.attachments, true)
    assert.ok((remoteSnapshot?.skills.length ?? 0) >= 3, 'Remote human skill authority must be non-empty')
    assert.equal(remoteSnapshot?.skills.find(skill => skill.name === 'fixture-human-only')?.modelInvocable, false)
    assert.equal(remoteSnapshot?.skills.find(skill => skill.name === 'fixture-scoped-human-only')?.modelInvocable, false)
    assert.equal(remoteSnapshot?.skills.find(skill => skill.name === 'fixture-model-only'), undefined)
    assert.ok(remoteSnapshot?.skills.every(skill => !('path' in skill)), 'Host-local skill paths must stay out of the semantic snapshot')

    const directClaims = outcome.report.commandClaims.direct
    assert.deepEqual(directClaims.find(claim => claim.name === 'fixture-execute')?.claim, { bare: true, withArguments: false })
    assert.deepEqual(directClaims.find(claim => claim.name === 'fixture-leading')?.claim, { bare: true, withArguments: true })
    assert.deepEqual(directClaims.find(claim => claim.name === 'fixture-shadow')?.claim, { bare: true, withArguments: true })
    assert.deepEqual(outcome.report.commandClaims.remote, directClaims)

    const addedCommandDispose = host.ctx.get('commands').register({
      definitionId: CommandDefinitionId('fixture/added-command'),
      name: 'fixture-added',
      description: 'Added fixture command',
      handler: async () => ({ kind: 'success' }),
    })
    const addedSkillDispose = host.ctx.get('skills').register({
      name: 'fixture-added-skill',
      description: 'Added fixture skill',
      content: 'added fixture body',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    const afterAdd = await shadow.compare({ sessionId: 'authority-session' })
    assert.equal(afterAdd.status, 'compared')
    assert.ok(afterAdd.status === 'compared')
    assert.equal(afterAdd.report.comparable, true)
    const addedDirect = await direct.read('authority-session')
    const addedRemote = await remote.read('authority-session')
    assert.ok(addedDirect?.commands.some(command => command.name === 'fixture-added'))
    assert.ok(addedRemote?.commands.some(command => command.name === 'fixture-added'))
    assert.ok(addedDirect?.skills.some(skill => skill.name === 'fixture-added-skill'))
    assert.ok(addedRemote?.skills.some(skill => skill.name === 'fixture-added-skill'))
    addedCommandDispose()
    addedSkillDispose()
    const afterDispose = await shadow.compare({ sessionId: 'authority-session' })
    assert.equal(afterDispose.status, 'compared')
    assert.ok(afterDispose.status === 'compared')
    assert.equal(afterDispose.report.comparable, true)
    const disposedRemote = await remote.read('authority-session')
    assert.equal(disposedRemote?.commands.some(command => command.name === 'fixture-added'), false)
    assert.equal(disposedRemote?.skills.some(skill => skill.name === 'fixture-added-skill'), false)

    // Delay a real Remote reader, then let the official Connection replace its
    // generation. The old operation must be discarded, not committed.
    const oldGeneration = connection.generation.getSnapshot()
    assert.ok(oldGeneration !== undefined)
    const releaseSuccess = Promise.withResolvers()
    const delayedRemote = {
      read: async (sessionId, signal) => {
        await releaseSuccess.promise
        return remote.read(sessionId, signal)
      },
    }
    const generationShadow = new RemoteSurfaceAuthorityShadow(direct, delayedRemote, connection.generation)
    const delayedSuccess = generationShadow.compare({ sessionId: 'authority-session' })
    await Promise.resolve()
    connection.reconnect()
    await waitFor('official Connection generation loss', () => connection.generation.getSnapshot() === undefined)
    releaseSuccess.resolve()
    assert.deepEqual(await delayedSuccess, { status: 'discarded', reason: 'stale-generation' })
    await waitFor(
      'official Connection generation replacement',
      () => {
        const generation = connection.generation.getSnapshot()
        return generation !== undefined && generation.id !== oldGeneration.id
      },
    )
    generationShadow.dispose()

    const failureGeneration = connection.generation.getSnapshot()
    assert.ok(failureGeneration !== undefined)
    const releaseFailure = Promise.withResolvers()
    const delayedFailureRemote = {
      read: async () => {
        await releaseFailure.promise
        throw new Error('late stale authority failure')
      },
    }
    const failureShadow = new RemoteSurfaceAuthorityShadow(direct, delayedFailureRemote, connection.generation)
    const delayedFailure = failureShadow.compare({ sessionId: 'authority-session' })
    await Promise.resolve()
    connection.reconnect()
    await waitFor('second official Connection generation loss', () => connection.generation.getSnapshot() === undefined)
    releaseFailure.resolve()
    assert.deepEqual(await delayedFailure, { status: 'discarded', reason: 'stale-generation' })
    await waitFor(
      'second official Connection generation replacement',
      () => {
        const generation = connection.generation.getSnapshot()
        return generation !== undefined && generation.id !== failureGeneration.id
      },
    )
    failureShadow.dispose()

    console.log('dsh same-Host surface authority parity smoke passed — live commands/list and skills/list matched Direct metadata and claim policy')
  } finally {
    shadow?.dispose()
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) {
      await host.agentScope.dispose()
      await host.ctx.fiber.dispose()
    }
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_SURFACE_AUTHORITY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
