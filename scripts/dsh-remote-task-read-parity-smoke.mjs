#!/usr/bin/env node
/**
 * D1.3 same-Host direct-child catalog/job parity smoke over the pinned DSH
 * Source Mode contracts. The fixture uses the real Host subagent/job services,
 * Session Controller, Gateway, Connection, and official ClientSessions.
 *
 * @module dsh-remote-task-read-parity-smoke
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
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { DirectTaskReader } from '../src/runtime/direct/task-read-direct.ts'
import { RemoteTaskReader } from '../src/runtime/remote/task-read-remote.ts'
import { RemoteTaskReadShadow } from '../src/runtime/remote/task-read-shadow.ts'

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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-task-parity.local', search: '' }
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

async function createHost() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  provideHostPeripheralServices(ctx)
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

  const sessions = ctx.get('sessions')
  const parent = sessions.create(SessionId('task-parent'), {
    meta: { cwd: '/tmp/dsh-d1-3-task', createdAt: 3_000 },
  })
  const childContinuable = sessions.create(SessionId('task-child-continuable'), {
    meta: {
      cwd: '/tmp/dsh-d1-3-task',
      parentSession: parent.id,
      origin: 'subagent',
      createdAt: 3_001,
    },
  })
  childContinuable.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'continuable',
    provider: 'fixture',
    label: 'task continuable child',
  }))
  const childOneShot = sessions.create(SessionId('task-child-one-shot'), {
    meta: {
      cwd: '/tmp/dsh-d1-3-task',
      parentSession: parent.id,
      origin: 'subagent',
      createdAt: 3_002,
    },
  })
  childOneShot.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'one-shot',
    provider: 'fixture',
    label: 'task one-shot child',
  }))

  const parentFiber = ctx.plugin(() => {})
  const emptyInbox = { nextTurn: [], nextStep: [] }
  const parentAgent = { id: parent.id, session: parent, status: 'running', ctx: parentFiber.ctx, inbox: emptyInbox }
  const childContinuableAgent = { id: childContinuable.id, session: childContinuable, status: 'running', ctx: parentFiber.ctx, inbox: emptyInbox }
  const childOneShotAgent = { id: childOneShot.id, session: childOneShot, status: 'running', ctx: parentFiber.ctx, inbox: emptyInbox }
  ctx.get('agents').register(parentAgent)
  ctx.get('agents').register(childContinuableAgent)
  ctx.get('agents').register(childOneShotAgent)

  let settleJob
  const done = new Promise(resolve => { settleJob = resolve })
  await ctx.plugin({
    inject: ['jobs'],
    apply(jobCtx) {
      jobCtx.jobs.attachController('task-parity')
      jobCtx.jobs.start({
        kind: 'bash',
        label: 'task parity job',
        owner: parentAgent,
        run: () => ({ done, cancel: () => {} }),
      })
    },
  })

  return { ctx, parent, parentAgent, childOneShotAgent, settleJob }
}

function hostTransport(host) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-task-parity.local'), init)
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

    const direct = new DirectTaskReader({
      agentFor: id => host.ctx.get('agents').get(SessionId(id)),
      subagents: {
        listChildren: (id, signal) => host.ctx.get('subagents').listChildren(SessionId(id), signal),
      },
      jobs: {
        list: agent => host.ctx.get('jobs').list(agent),
      },
    })
    const remote = new RemoteTaskReader(sessions, connection.generation)
    shadow = new RemoteTaskReadShadow(direct, remote, connection.generation)
    const outcome = await shadow.compare({ parentSessionId: 'task-parent' })
    assert.equal(outcome.status, 'compared')
    assert.equal(outcome.report.comparable, true)
    assert.deepEqual(outcome.report.mismatches, [])
    assert.deepEqual(outcome.report.skipped.map(field => field.field), ['subagent.descendantTree'])

    const directSnapshot = await direct.readDirectChildren('task-parent')
    const remoteSnapshot = await remote.readDirectChildren('task-parent')
    assert.ok(directSnapshot !== undefined)
    assert.ok(remoteSnapshot !== undefined)
    assert.deepEqual(directSnapshot.children.map(entry => entry.id), [
      'task-child-continuable',
      'task-child-one-shot',
    ])
    assert.deepEqual(remoteSnapshot.children.map(entry => entry.id), [
      'task-child-continuable',
      'task-child-one-shot',
    ])
    assert.equal(directSnapshot.jobs.length, 1)
    assert.equal(remoteSnapshot.jobs.length, 1)

    host.childOneShotAgent.status = 'idle'
    host.settleJob({ status: 'completed', detail: 'fixture complete' })
    await waitFor('remote job settlement', () => sessions.list.getSnapshot().jobsBySession['task-parent']?.[0]?.status === 'completed')
    const updated = await shadow.compare({ parentSessionId: 'task-parent' })
    assert.equal(updated.status, 'compared')
    assert.equal(updated.report.comparable, true)
    assert.deepEqual(updated.report.mismatches, [])
    const updatedSnapshot = await remote.readDirectChildren('task-parent')
    assert.ok(updatedSnapshot !== undefined)
    const updatedChild = updatedSnapshot.children.find(entry => entry.id === 'task-child-one-shot')
    assert.equal(updatedChild?.kind === 'child' && updatedChild.activity, 'inactive')
    assert.equal(updatedSnapshot.jobs[0]?.status, 'completed')

    console.log(JSON.stringify({
      status: 'passed',
      comparable: true,
      mismatchCount: 0,
      skipped: ['subagent.descendantTree'],
      mutationVerified: true,
    }))
  } finally {
    shadow?.dispose()
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) {
      host.settleJob?.({ status: 'completed' })
      await host.ctx.fiber.dispose()
    }
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_TASK_READ_PARITY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
