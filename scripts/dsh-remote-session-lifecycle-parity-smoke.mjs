#!/usr/bin/env node
/**
 *
 * Focused same-Host Session lifecycle/model/preset integration smoke over the
 * pinned official DSH 0.1.7-rc.2 Host and Client contracts. One real Host
 * Context owns the Session store, the production AgentLoop with an in-process
 * stub LLM route, the declarative agent preset registry, projections, the
 * SQLite session query engine, the local fs service, the real workspace stack,
 * the Session Controller, the Gateway and the forwarded-event source. An
 * independent official Client Context reaches that Host through the official
 * Connection/Gateway carrier, and the TUI's experimental Remote adapters drive
 * it (never a mock): `RemoteSessionLifecycle`, `RemoteModelCatalog` and
 * `RemotePresetCatalog`.
 *
 * Covered flows (sub-plan §8):
 * - A ordinary create            (ClientSessions.create -> Host Session Controller)
 * - B explicit-preset create     (atomic generated session.create({agentPreset}))
 * - C open / retain              (ClientSessions.retain, no invented resume RPC)
 * - D model select               (session.modelCatalog / session.selectModel)
 * - E preset select + locked     (agentPresets.select normal + refusal)
 *
 * @module dsh-remote-session-lifecycle-parity-smoke
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import presetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { RemoteSessionLifecycle } from '../src/runtime/remote/session-lifecycle-remote.ts'
import { RemoteModelCatalog } from '../src/runtime/remote/model-remote.ts'
import { RemotePresetCatalog } from '../src/runtime/remote/preset-remote.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

const PROVIDER = 'smoke'
const MODEL = 'smoke'
const ALT_MODEL = 'smoke-alt'
const DEFAULT_SELECTION = Object.freeze({ provider: PROVIDER, model: MODEL })
const PRESET = 'lifecycle-preset'
const ALT_PRESET = 'lifecycle-preset-2'

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png']),
})

/** In-process stub LLM route: advertises two routable models and completes
 * every turn with one plain text block so a continued session can settle. */
class SmokeAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    if (model !== MODEL && model !== ALT_MODEL) return Promise.reject(new Error(`unknown model ${model}`))
    return Promise.resolve({ provider, id: model, name: model })
  }

  listModels(provider) {
    return Promise.resolve([
      { provider, id: MODEL, name: MODEL },
      { provider, id: ALT_MODEL, name: ALT_MODEL },
    ])
  }

  async * stream() {
    const text = 'stub response'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-prem3-lifecycle.local', search: '' }
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
    currentSelection: () => ({ ...DEFAULT_SELECTION }),
    // Deliberate: this lane does not persist the best-effort global-default
    // save, so the deployment default stays fixed and the Session-local
    // projection is observable. The Host save itself is a Session-Controller
    // behavior, not a TUI one.
    saveSelection: async () => {},
  })
  ctx.provide('attachments', {
    imageLimits: IMAGE_LIMITS,
    admitPromptContent: async content => content,
  })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  })
  ctx.provide('webServer', {
    registerUpgrade: () => () => {},
  })
}

async function createHost(workRoot) {
  const ctx = new Context()
  let persistenceFiber
  try {
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
    const loop = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(CommandRuntime)
    provideHostPeripheralServices(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: PRESET })
    const presets = ctx.get('agentPresets')
    await presets.register({ id: PRESET, name: 'Lifecycle preset', plugins: [] })
    await presets.register({ id: ALT_PRESET, name: 'Lifecycle preset 2', plugins: [] })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    let sessionController
    await ctx.inject(SessionController.inject, controllerCtx => {
      sessionController = new SessionController(controllerCtx, { nativeOpen: false })
    })
    // Count every Host-side create dispatch: the pinned controller create is
    // "create or idempotently adopt", so mere Session presence cannot prove the
    // TUI dispatched exactly one Host create.
    const hostCreateCalls = []
    const originalCreate = sessionController.create.bind(sessionController)
    sessionController.create = (request) => {
      hostCreateCalls.push(String(request?.sessionId))
      return originalCreate(request)
    }
    await ctx.plugin(hostCtx => {
      new HostConnectionService(hostCtx, [], {})
    })
    await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
      new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
    })
    await ctx.plugin({ inject: apiRemotesInject, apply: applyApiRemotes })

    ctx.llm.registerAdapter([PROVIDER], new SmokeAdapter())
    return { ctx, loop, persistenceRoot: join(workRoot, 'persistence'), persistenceFiber, hostCreateCalls }
  } catch (error) {
    if (persistenceFiber !== undefined) await persistenceFiber.dispose()
    throw error
  }
}

function hostTransport(host) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  async function* emptyUplink() {}
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-prem3-lifecycle.local'), init)
      return shared.fetch(request)
    },
    openStream(endpoint, payload, signal, uplink) {
      return (async function* () {
        yield* await host.ctx.get('typertGateway').wireStream.open(endpoint, payload, uplink ?? emptyUplink(), undefined, signal)
      })()
    },
  }
}

async function waitFor(description, predicate, timeoutMs = 10_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function main() {
  const flows = {}
  const loader = installModuleLoader()
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-prem3-lifecycle-'))
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

    host = await createHost(workRoot)
    const anchorDir = join(workRoot, 'anchor')
    mkdirSync(anchorDir, { recursive: true })

    globalThis.__DSH_TRANSPORT__ = hostTransport(host)

    client = new Context()
    await client.plugin(TypertRegistry)
    await client.plugin(connectionClient)
    await client.plugin(gatewayClient)
    for (const contribution of [commandsRemote, presetsRemote, sessionRemote, subagentsRemote]) {
      await client.remote.$mount(contribution)
    }
    client.provide('fileUpload', { available: false })
    await client.plugin(sessionClient)

    const connection = client.get('connection')
    const sessions = client.get('sessions')
    const sessionRemoteFace = client.remote.session
    const presetRemoteFace = client.remote.agentPresets
    await waitFor('same-Host Client readiness', () => (
      connection.generation.getSnapshot() !== undefined
        && sessions.list.getSnapshot().phase === 'ready'
    ))

    const generation = connection.generation
    const lifecycle = new RemoteSessionLifecycle(sessions, sessionRemoteFace, generation)
    const models = new RemoteModelCatalog(sessionRemoteFace, sessions, generation)
    const presets = new RemotePresetCatalog(presetRemoteFace, generation)
    const hostSession = id => host.ctx.sessions.get(SessionId(id))
    const catalogIds = () => sessions.list.getSnapshot().ids.map(String)
    const presetOf = id => host.ctx.get('sessionProjections')
      .snapshot(hostSession(id), ['agentPreset']).values.agentPreset
    const appendedTypes = id => hostSession(id).snapshotEvents().map(event => event.type)

    // ---- Flow A: ordinary create -----------------------------------------
    {
      const requested = 'lifecycle-ordinary'
      const result = await lifecycle.create({ sessionId: requested, cwd: anchorDir })
      assert.equal(result.ownership, 'current', `Flow A ownership: ${result.ownership}/${result.outcome.kind}`)
      assert.equal(result.outcome.kind, 'created', `Flow A create failed: ${result.ownership}/${result.outcome.kind}`)
      const handle = result.outcome.handle
      assert.equal(handle.session.id, requested)
      assert.ok(handle.client !== undefined, 'Flow A must hand back the exact Client generation owner')
      assert.ok(hostSession(requested) !== undefined, 'Flow A must create the Host Session')
      assert.equal(host.hostCreateCalls.filter(id => id === requested).length, 1,
        'Flow A must dispatch exactly one Host Session create (create-or-adopt cannot prove it by presence)')
      assert.ok(catalogIds().includes(requested), 'Flow A result id must enter the Client catalog')
      assert.ok(sessions.binding(requested) !== undefined, 'Flow A must retain a Client generation')
      assert.notEqual(hostSession(requested).header.isSeeded, true, 'an ordinary create must not seed from a TUI resume')
      const referenceCount = sessions.retainInfo(SessionId(requested)).getSnapshot().referenceCount
      assert.ok(referenceCount > 0, 'Flow A retain must hold a reference')
      handle.client.release()
      assert.ok(sessions.retainInfo(SessionId(requested)).getSnapshot().referenceCount
        < referenceCount, 'Flow A release must return the reference')
      flows.ordinaryCreate = { status: 'covered', sessionId: requested }
    }

    // ---- Flow B: explicit-preset create ----------------------------------
    {
      const requested = 'lifecycle-preset'
      // The requested preset is deliberately NOT the Host default: if the
      // adapter dropped `agentPreset`, the Host default would land instead and
      // the assertion below would fail.
      const result = await lifecycle.create({ sessionId: requested, cwd: anchorDir, agentPreset: ALT_PRESET })
      assert.equal(result.ownership, 'current', `Flow B ownership: ${result.ownership}/${result.outcome.kind}`)
      assert.equal(result.outcome.kind, 'created', `Flow B create failed: ${result.ownership}/${result.outcome.kind}`)
      const handle = result.outcome.handle
      assert.equal(handle.session.id, requested)

      // The preset is an ATOMIC creation-time input: no create-then-select
      // (`agent-preset/selected`) step may have run.
      assert.equal(appendedTypes(requested).includes('agent-preset/selected'), false,
        'Flow B must pass the preset at creation time, never create + selectPreset')
      assert.equal(presetOf(requested), ALT_PRESET, 'Flow B published id must carry the REQUESTED creation-time preset')
      assert.equal(host.hostCreateCalls.filter(id => id === requested).length, 1,
        'Flow B must dispatch exactly one Host Session create')
      assert.ok(catalogIds().includes(requested), 'Flow B published id must be the catalog authority')
      handle.client?.release()
      flows.explicitPresetCreate = { status: 'covered', sessionId: requested, preset: ALT_PRESET }
    }

    // ---- Flow C: open / retain -------------------------------------------
    {
      const existing = 'lifecycle-preset'
      const opened = await lifecycle.open({ sessionId: existing })
      assert.equal(opened.ownership, 'current', `Flow C ownership: ${opened.ownership}/${opened.outcome.kind}`)
      assert.equal(opened.outcome.kind, 'opened', `Flow C open failed: ${opened.ownership}/${opened.outcome.kind}`)
      assert.equal(opened.outcome.handle.session.id, existing)
      assert.ok(opened.outcome.handle.client !== undefined, 'Flow C must hand back a Client generation owner')
      assert.ok(sessions.binding(existing) !== undefined, 'Flow C retain must produce a live binding')
      const before = sessions.retainInfo(SessionId(existing)).getSnapshot().referenceCount
      opened.outcome.handle.client.release()
      assert.ok(sessions.retainInfo(SessionId(existing)).getSnapshot().referenceCount < before,
        'Flow C release must return the reference')

      const unknown = 'lifecycle-unknown'
      const refused = await lifecycle.open({ sessionId: unknown })
      assert.equal(refused.outcome.kind, 'unavailable', `Flow C unknown id must fail closed: ${refused.ownership}/${refused.outcome.kind}`)
      assert.equal(hostSession(unknown), undefined, 'Flow C must never silently create an unknown Session')
      flows.openRetain = { status: 'covered', sessionId: existing, unknownOutcome: refused.outcome.kind }
    }

    // ---- Flow D: model select --------------------------------------------
    {
      const directory = await models.loadDirectory()
      assert.deepEqual(directory.default, DEFAULT_SELECTION,
        'Flow D directory default must come from the Host')
      assert.ok(directory.routableProviders.includes(PROVIDER), 'Flow D routable provider must include the stub route')

      const target = 'lifecycle-model-target'
      const other = 'lifecycle-model-other'
      const createdTarget = await lifecycle.create({ sessionId: target, cwd: anchorDir })
      const createdOther = await lifecycle.create({ sessionId: other, cwd: anchorDir })
      assert.equal(createdTarget.outcome.kind, 'created', `Flow D target create failed: ${createdTarget.ownership}/${createdTarget.outcome.kind}`)
      assert.equal(createdOther.outcome.kind, 'created', `Flow D other create failed: ${createdOther.ownership}/${createdOther.outcome.kind}`)
      try {
        const settled = await models.selectSessionModel(target, { provider: PROVIDER, model: ALT_MODEL })
        assert.equal(settled.ownership, 'current', `Flow D ownership: ${settled.ownership}/${settled.outcome.kind}`)
        assert.equal(settled.outcome.kind, 'committed', `Flow D select failed: ${settled.ownership}/${settled.outcome.kind}`)
        assert.deepEqual(settled.outcome.value, { provider: PROVIDER, model: ALT_MODEL })
        // The durable Client binding projection is the display authority.
        assert.deepEqual(models.sessionSelection(target), { provider: PROVIDER, model: ALT_MODEL },
          'Flow D final projection must match the selection')
        // A Session-local write invalidates the adapter's cached global default
        // (the Host may have saved it best-effort), so re-read it. This lane
        // pins that deployment default (the stub does not persist the save), so
        // the comparison is deterministic; it proves the OTHER Session follows
        // the Host-authoritative default instead of a TUI-owned truth.
        const refreshed = await models.loadDirectory()
        assert.deepEqual(refreshed.default, DEFAULT_SELECTION)
        assert.deepEqual(models.sessionSelection(other), refreshed.default,
          'Flow D must not write a second TUI model truth across Sessions')
      } finally {
        createdTarget.outcome.handle.client?.release()
        createdOther.outcome.handle.client?.release()
      }
      flows.modelSelect = { status: 'covered', sessionId: target, selection: { provider: PROVIDER, model: ALT_MODEL } }
    }

    // ---- Flow E: preset select + locked ----------------------------------
    {
      const roster = await presets.roster()
      assert.deepEqual(roster.presets.map(row => row.id).sort(), [ALT_PRESET, PRESET].sort(),
        'Flow E roster must list the Host presets')
      assert.equal(roster.defaultId, PRESET, 'Flow E roster must carry the Host-effective default')

      // Normal select on a BLANK Session.
      const blank = 'lifecycle-blank'
      const created = await lifecycle.create({ sessionId: blank, cwd: anchorDir, agentPreset: PRESET })
      assert.equal(created.outcome.kind, 'created', `Flow E blank create failed: ${created.ownership}/${created.outcome.kind}`)
      const selected = await presets.selectSessionPreset(blank, ALT_PRESET)
      assert.equal(selected.ownership, 'current', `Flow E ownership: ${selected.ownership}/${selected.outcome.kind}`)
      assert.equal(selected.outcome.kind, 'committed', `Flow E blank select failed: ${selected.ownership}/${selected.outcome.kind}`)
      assert.equal(presetOf(blank), ALT_PRESET, 'Flow E blank select must commit the Host preset projection')
      created.outcome.handle.client?.release()

      // Locked / refusal: a Session that has already run a turn refuses the switch.
      const locked = 'lifecycle-locked'
      const lockedCreated = await lifecycle.create({ sessionId: locked, cwd: anchorDir, agentPreset: PRESET })
      assert.equal(lockedCreated.outcome.kind, 'created', `Flow E locked create failed: ${lockedCreated.ownership}/${lockedCreated.outcome.kind}`)
      lockedCreated.outcome.handle.client?.release()
      const lockedSession = hostSession(locked)
      const lockedAgent = host.ctx.agents.get(SessionId(locked))
      assert.ok(lockedAgent !== undefined, 'Flow E locked Session has no live Agent to run its first turn')
      const endsBefore = lockedSession.snapshotEvents().filter(event => event.type === 'turn/end').length
      lockedAgent.followup(createUserMessage({
        content: [{ type: 'text', text: 'started' }],
        source: { kind: 'user' },
      }))
      await waitFor('the locked Session first turn to complete', () =>
        lockedSession.snapshotEvents().filter(event => event.type === 'turn/end').length > endsBefore ? true : undefined)
      const refusal = await presets.selectSessionPreset(locked, ALT_PRESET)
      assert.equal(refusal.outcome.kind, 'rejected', `Flow E locked select must refuse: ${refusal.ownership}/${refusal.outcome.kind}`)
      if (refusal.outcome.kind === 'rejected') {
        assert.equal(refusal.outcome.error.code, 'agent-preset/locked')
      }
      assert.equal(presetOf(locked), PRESET, 'Flow E refusal must not change the Host preset')
      flows.presetSelectLocked = { status: 'covered', normalPreset: ALT_PRESET, lockedCode: 'agent-preset/locked' }
    }

    console.log(JSON.stringify({ ok: true, flows }))
  } finally {
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) {
      if (host.persistenceFiber !== undefined) await host.persistenceFiber.dispose()
      await host.ctx.fiber.dispose()
    }
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_SESSION_LIFECYCLE_PARITY_FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
