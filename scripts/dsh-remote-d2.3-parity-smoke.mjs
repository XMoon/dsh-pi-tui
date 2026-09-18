#!/usr/bin/env node
/**
 * D2.3/D2.4 same-Host model / preset / session-lifecycle/fork parity smoke
 * over the official Host and Client contracts.
 *
 * One Host Context owns a real live Agent (production AgentLoop + an
 * in-process stub LLM route), the real `AgentPresets` service over a fixture
 * preset root, Session projections, Session Controller, Gateway, and the
 * forwarded-event source. An independent official Client Context reaches the
 * same Host through the official Connection/Gateway carrier and mounts the
 * generated `session` and `agentPresets` Remote namespaces.
 *
 * The three D2.3 Remote adapters are then driven from the real official
 * Client objects:
 * - `RemoteModelCatalog` reads the official `session.modelCatalog` directory
 *   and commits through `session.selectModel`, proving the durable
 *   `modelSelection` projection carries the accepted pair;
 * - `RemotePresetCatalog` reads the official `agentPresets.list` roster and
 *   commits a blank-Session switch through `agentPresets.select`, while a
 *   started Session settles as `agent-preset/locked`;
 * - `RemoteSessionLifecycle` maps ordinary create to `ClientSessions.create`,
 *   an explicit-preset fresh create to the generated `session.create`, open to
 *   `ClientSessions.open`/`binding`, and fork to one `ClientSessions.fork()`
 *   call with no Host Agent resume.
 *
 * No external network and no real provider: the only model route is the
 * in-process `SmokeAdapter` registered on the Host LlmRuntime.
 *
 * @module dsh-remote-d2.3-parity-smoke
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import SessionTitleService, { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import AgentPresets, { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import agentPresetsRemote from '@deepseek-ai/dsh-agent-presets/remote'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { DirectSessionLifecycle } from '../src/runtime/direct/session-lifecycle-direct.ts'
import { RemoteModelCatalog } from '../src/runtime/remote/model-remote.ts'
import { RemotePresetCatalog } from '../src/runtime/remote/preset-remote.ts'
import { RemoteSessionLifecycle } from '../src/runtime/remote/session-lifecycle-remote.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

const ANCHOR_SESSION_ID = 'd2-3-anchor-session'
/** The Direct adapter's independent source: driving Direct and Remote against
 * one source Session would create two writers for it. */
const DIRECT_SOURCE_SESSION_ID = 'd2-4-direct-source-session'
const ORDINARY_SESSION_ID = 'd2-3-ordinary-session'
const FRESH_SESSION_ID = 'd2-3-fresh-session'
const BLANK_SESSION_ID = 'd2-3-blank-session'
const PROVIDER = 'smoke'
const MODEL = 'smoke'
const PRESET_A = 'probe-a'
const PRESET_B = 'probe-b'
const OFFICIAL_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis']

// F5 model parity (case A): a CONSUMED pre-cut selection (its matching
// request/header clears the pending intent into `lastUsed`) and a DIFFERENT
// unconsumed selection appended after the last closed turn. The child prefix
// must stop before the post-cut event, so the projection resolves to the
// consumed pre-cut selection rather than the post-cut one.
const CONSUMED_PRE_CUT_SELECTION = { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' }
const POST_CUT_SELECTION = { provider: PROVIDER, model: 'smoke-post-cut', reasoningEffort: 'minimal' }
const A_HOST_SOURCE_SESSION_ID = 'd2-4-selection-host-source'
const A_DIRECT_SOURCE_SESSION_ID = 'd2-4-selection-direct-source'
// F5 default fallback (case B): sources with NO model/selection and NO
// request/header, so the child projection carries no session-local intent.
const B_HOST_SOURCE_SESSION_ID = 'd2-4-default-host-source'
const B_DIRECT_SOURCE_SESSION_ID = 'd2-4-default-direct-source'
// F5 stopped boundary (case C): a completed turn followed by a LATER aborted
// turn; fork-latest must choose the aborted turn/end, not the completed one.
const C_HOST_SOURCE_SESSION_ID = 'd2-4-aborted-host-source'
const C_DIRECT_SOURCE_SESSION_ID = 'd2-4-aborted-direct-source'
// F8 subagent lineage (case D): subagent-origin sources whose parent Session
// owns a workspace; the child must inherit that ANCESTOR workspace while its
// own header stays an ordinary (non-subagent) session header.
const D_HOST_PARENT_SESSION_ID = 'd2-4-subagent-host-parent'
const D_DIRECT_PARENT_SESSION_ID = 'd2-4-subagent-direct-parent'
const D_HOST_SOURCE_SESSION_ID = 'd2-4-subagent-host-source'
const D_DIRECT_SOURCE_SESSION_ID = 'd2-4-subagent-direct-source'
// F7 cwd/meta (case E): a source header WITHOUT cwd must fork a child that
// still has no cwd (never an invented one).
const E_HOST_SOURCE_SESSION_ID = 'd2-4-nocwd-host-source'
const E_DIRECT_SOURCE_SESSION_ID = 'd2-4-nocwd-direct-source'

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png']),
})

/** In-process stub LLM route: advertises one routable model and completes
 * every turn with one plain text block so a Session can become "started". */
class SmokeAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: MODEL, name: MODEL }])
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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-d2-3-parity.local', search: '' }
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
    currentSelection: () => ({ provider: PROVIDER, model: MODEL }),
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

/** Write one intentionally-empty fixture preset (no composition rows, so the
 * standing mount needs no plugin outside the bundle dependency tree). */
function writeFixturePreset(root, id) {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'preset.yml'), `id: ${id}\nname: ${id} preset\ndescription: D2.3 parity smoke fixture\ntrust: system\n`)
  writeFileSync(join(root, id, 'agent.cordis.yml'), '[]\n')
}

async function createHost(presetRoot, workRoot) {
  const ctx = new Context()
  const persistenceRoot = join(workRoot, 'persistence')
  let persistenceFiber
  try {
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
    const loop = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    provideHostPeripheralServices(ctx)
    ctx.get('sessionProjections').register(titleProjectionDefinition)
    ctx.get('sessionProjections').register(agentPresetProjectionDefinition)
    // The real official preset roster service. The fixture root supplies two
    // mountable presets; the shipped root supplies the official rows the
    // roster parity assertion observes.
    await ctx.plugin(Loader)
    ctx.baseUrl = pathToFileURL(`${process.cwd()}/`).href
    await ctx.plugin(AgentPresets, {
      default: PRESET_A,
      roots: [{ path: presetRoot, trust: 'system' }],
      includeShippedRoot: true,
      includeUserRoot: false,
    })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    // The REAL official workspace stack (the same rows the web bundle mounts):
    // Direct and Remote forks below must observe one genuine
    // `ctx.workspaceRegistry`, not a fixture that can only say "no workspace".
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
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

    ctx.llm.registerAdapter([PROVIDER], new SmokeAdapter())

    // Record every Host Agent resume. D2.3 open must never reach one.
    const resumeCalls = []
    const agents = ctx.agents
    const originalResume = agents.resume.bind(agents)
    agents.resume = (...args) => {
      resumeCalls.push(args[0]?.resumeSessionId)
      return originalResume(...args)
    }

    const agent = await loop.create(SessionId(ANCHOR_SESSION_ID), { provider: PROVIDER, model: MODEL }, { cwd: join(workRoot, 'anchor') })
    // The Direct comparison needs its OWN source session: driving both adapters
    // against one source would create two writers for the same Session. It
    // shares the anchor cwd so BOTH children must join one real workspace.
    const directAgent = await loop.create(SessionId(DIRECT_SOURCE_SESSION_ID), { provider: PROVIDER, model: MODEL }, { cwd: join(workRoot, 'anchor') })
    return { ctx, agent, directAgent, loop, resumeCalls, persistenceRoot, persistenceFiber }
  } catch (error) {
    if (persistenceFiber !== undefined) await persistenceFiber.dispose()
    rmSync(persistenceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    throw error
  }
}

function hostTransport(host, fetchLog) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-d2-3-parity.local'), init)
      fetchLog.push(`${request.method} ${new URL(request.url).pathname}`)
      return shared.fetch(request)
    },
    openStream(endpoint, payload, signal) {
      return (async function* () {
        yield* await host.ctx.get('typertGateway').wireStream.open(endpoint, payload, signal)
      })()
    },
  }
}

async function waitFor(description, predicate, timeoutMs = 5_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Wait until one Client Session projection face carries a value. */
function waitForProjection(binding, key, predicate, description) {
  return waitFor(description, () => {
    const value = binding.session.projections.faceOf(key).getSnapshot()
    return predicate(value) ? value : undefined
  })
}

/** Append one syntactically-closed turn without running the model loop; the
 * fork boundary selector only depends on the `turn/end` event and its reason,
 * so this keeps the fixture independent of adapter-driven turn timing. */
function appendSyntheticClosedTurn(session, turn, reason) {
  session.append('turn/start', { turn })
  return Number(session.append('turn/end', { turn, reason }).seq)
}

/** Read the wire-visible model-selection projection of one live Session. */
function modelSelectionOf(ctx, session) {
  return ctx.get('sessionProjections').snapshot(session, ['modelSelection']).values.modelSelection
}

async function main() {
  const scenarios = {}
  const loader = installModuleLoader()
  const fetchLog = []
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-d2-3-parity-'))
  const presetRoot = join(workRoot, 'presets')
  writeFixturePreset(presetRoot, PRESET_A)
  writeFixturePreset(presetRoot, PRESET_B)
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

    host = await createHost(presetRoot, workRoot)
    // One REAL workspace whose membership BOTH fork sources already hold, set up
    // BEFORE any fork. Attaching it later would leave the Host-side child out of
    // the workspace while the Direct child joined it — the earlier fixture did
    // exactly that and the one-sided membership assertion still passed.
    const anchorDir = join(workRoot, 'anchor')
    mkdirSync(anchorDir, { recursive: true })
    const workspace = await host.ctx.get('workspaceRegistry').create(anchorDir, 'D2.4 parity workspace')
    await workspace.attachSession(SessionId(ANCHOR_SESSION_ID))
    await workspace.attachSession(SessionId(DIRECT_SOURCE_SESSION_ID))
    const workspaceMembership = () => host.ctx.get('workspaceRegistry').list()
      .find(candidate => candidate.id === workspace.id)?.sessionIds ?? []
    // A concrete non-default selection WITH `reasoningEffort` on BOTH sources:
    // the inherited model projection is then pinned by expected value, so a
    // SYMMETRIC inheritance regression fails instead of passing a cross-equal.
    const HISTORICAL_SELECTION = { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' }
    host.agent.session.append('model/selection', HISTORICAL_SELECTION)
    host.directAgent.session.append('model/selection', HISTORICAL_SELECTION)

    // ---- D2.4 parity fixtures -------------------------------------------------
    // Every case below owns ONE Host-path source and ONE Direct-path source (two
    // INDEPENDENT writers). Sources are created before the Client connects so the
    // official Session list already carries them.
    const createForkSource = (sessionId, meta) =>
      host.loop.create(SessionId(sessionId), { provider: PROVIDER, model: MODEL }, meta)

    // Case A: consumed pre-cut selection + different unconsumed post-cut one.
    const selectionHeader = selection => ({
      header: { config: { ...selection } },
      reason: 'change',
      startsSeries: true,
    })
    const aHostSource = await createForkSource(A_HOST_SOURCE_SESSION_ID, { cwd: anchorDir })
    const aDirectSource = await createForkSource(A_DIRECT_SOURCE_SESSION_ID, { cwd: anchorDir })
    for (const source of [aHostSource, aDirectSource]) {
      const session = source.session
      session.append('model/selection', CONSUMED_PRE_CUT_SELECTION)
      session.append('request/header', selectionHeader(CONSUMED_PRE_CUT_SELECTION))
      appendSyntheticClosedTurn(session, 1, { kind: 'completed' })
      session.append('model/selection', POST_CUT_SELECTION)
    }
    await workspace.attachSession(SessionId(A_HOST_SOURCE_SESSION_ID))
    await workspace.attachSession(SessionId(A_DIRECT_SOURCE_SESSION_ID))

    // Case B: no explicit selection and no request/header at all.
    await createForkSource(B_HOST_SOURCE_SESSION_ID, { cwd: anchorDir })
    await createForkSource(B_DIRECT_SOURCE_SESSION_ID, { cwd: anchorDir })
    for (const sessionId of [B_HOST_SOURCE_SESSION_ID, B_DIRECT_SOURCE_SESSION_ID]) {
      appendSyntheticClosedTurn(host.ctx.sessions.get(SessionId(sessionId)), 1, { kind: 'completed' })
      await workspace.attachSession(SessionId(sessionId))
    }

    // Case C: an earlier completed turn and a LATER aborted turn. Fork-latest
    // must pick the aborted boundary, not the earlier completed one.
    const abortReason = { kind: 'aborted', reason: { kind: 'user' } }
    const abortedBoundarySeq = {}
    for (const [key, sessionId] of [['host', C_HOST_SOURCE_SESSION_ID], ['direct', C_DIRECT_SOURCE_SESSION_ID]]) {
      const source = await createForkSource(sessionId, { cwd: anchorDir })
      appendSyntheticClosedTurn(source.session, 1, { kind: 'completed' })
      abortedBoundarySeq[key] = appendSyntheticClosedTurn(source.session, 2, abortReason)
      await workspace.attachSession(SessionId(sessionId))
    }

    // Case D: subagent-origin sources whose parent is the workspace member. The
    // workspace `attachSession` validates the stored cwd against the workspace
    // path, so the subagent source shares the parent's cwd; its workspace still
    // comes from ANCESTOR lineage, never its own (absent) membership.
    const subagentParentDir = join(workRoot, 'subagent-parent')
    mkdirSync(subagentParentDir, { recursive: true })
    const subagentWorkspace = await host.ctx.get('workspaceRegistry').create(subagentParentDir, 'D2.4 subagent workspace')
    for (const parentId of [D_HOST_PARENT_SESSION_ID, D_DIRECT_PARENT_SESSION_ID]) {
      await createForkSource(parentId, { cwd: subagentParentDir })
      await subagentWorkspace.attachSession(SessionId(parentId))
    }
    const subagentMembership = () => host.ctx.get('workspaceRegistry').list()
      .find(candidate => candidate.id === subagentWorkspace.id)?.sessionIds ?? []
    for (const [sessionId, parentId] of [
      [D_HOST_SOURCE_SESSION_ID, D_HOST_PARENT_SESSION_ID],
      [D_DIRECT_SOURCE_SESSION_ID, D_DIRECT_PARENT_SESSION_ID],
    ]) {
      const source = await createForkSource(sessionId, {
        cwd: subagentParentDir,
        parentSession: SessionId(parentId),
        origin: 'subagent',
        delegationDepth: 1,
      })
      appendSyntheticClosedTurn(source.session, 1, { kind: 'completed' })
    }

    // Case E: sources whose header carries no cwd.
    for (const sessionId of [E_HOST_SOURCE_SESSION_ID, E_DIRECT_SOURCE_SESSION_ID]) {
      const source = await createForkSource(sessionId, {})
      appendSyntheticClosedTurn(source.session, 1, { kind: 'completed' })
    }
    // --------------------------------------------------------------------------

    globalThis.__DSH_TRANSPORT__ = hostTransport(host, fetchLog)

    client = new Context()
    await client.plugin(TypertRegistry)
    await client.plugin(connectionClient)
    await client.plugin(gatewayClient)
    for (const contribution of [commandsRemote, subagentsRemote, sessionRemote, agentPresetsRemote]) {
      await client.remote.$mount(contribution)
    }
    client.provide('fileUpload', { available: false })
    await client.plugin(sessionClient)

    const connection = client.get('connection')
    const sessions = client.get('sessions')
    await waitFor('same-Host Client readiness', () => (
      connection.generation.getSnapshot() !== undefined
        && sessions.list.getSnapshot().phase === 'ready'
    ))
    await waitFor('the anchor session to be listed', () => sessions.list.getSnapshot().ids.includes(ANCHOR_SESSION_ID))

    // Record every official Client open so the lifecycle mapping is observable.
    const openCalls = []
    const realOpen = sessions.open.bind(sessions)
    sessions.open = (id) => {
      openCalls.push(String(id))
      realOpen(id)
    }

    const modelCatalog = new RemoteModelCatalog(client.remote.session, sessions, connection.generation)
    const presetCatalog = new RemotePresetCatalog(client.remote.agentPresets, connection.generation)
    const lifecycle = new RemoteSessionLifecycle(sessions, client.remote.session, connection.generation)
    // The Direct composition mirrors the official controller: resolve the preset
    // id, then mount that resolved preset in the child's setup.
    const directPresets = host.ctx.get('agentPresets')
    const direct = new DirectSessionLifecycle(host.ctx, async (presetId) => {
      const resolved = await directPresets.resolve(presetId)
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx) => { await directPresets.mount(agentCtx, resolved.id) },
      }
    })

    // CREATE (a): ordinary create with no explicit preset routes through the
    // official ClientSessions.create and is addressable on resolution.
    {
      const ordinaryResult = await lifecycle.create({ sessionId: ORDINARY_SESSION_ID, cwd: join(workRoot, 'ordinary') })
      assert.equal(ordinaryResult.ownership, 'current')
      assert.deepEqual(ordinaryResult.outcome, { kind: 'created', handle: { session: { id: ORDINARY_SESSION_ID } } })
      assert.ok(sessions.binding(ORDINARY_SESSION_ID) !== undefined, 'ordinary create left no Client binding')
      assert.equal(sessions.list.getSnapshot().ids.includes(ORDINARY_SESSION_ID), true)
      assert.ok(host.ctx.sessions.get(SessionId(ORDINARY_SESSION_ID)) !== undefined, 'ordinary create reached no Host Session')
      scenarios.createOrdinary = { status: 'covered', sessionId: ORDINARY_SESSION_ID }
    }

    // CREATE (b): a guaranteed-fresh create WITH an explicit preset uses the
    // generated `session.create` and reconciles Client state.
    {
      const freshResult = await lifecycle.create({
        sessionId: FRESH_SESSION_ID,
        cwd: join(workRoot, 'fresh'),
        agentPreset: PRESET_B,
      })
      assert.equal(freshResult.ownership, 'current')
      assert.deepEqual(freshResult.outcome, { kind: 'created', handle: { session: { id: FRESH_SESSION_ID } } })
      assert.ok(sessions.binding(FRESH_SESSION_ID) !== undefined, 'explicit-preset create left no Client binding')
      const hostSession = host.ctx.sessions.get(SessionId(FRESH_SESSION_ID))
      assert.ok(hostSession !== undefined, 'explicit-preset create reached no Host Session')
      const hostPreset = host.ctx.get('sessionProjections').snapshot(hostSession, ['agentPreset']).values.agentPreset
      assert.equal(hostPreset, PRESET_B, 'the Host durable agentPreset projection did not carry the requested preset')
      scenarios.createWithPreset = { status: 'covered', sessionId: FRESH_SESSION_ID, preset: hostPreset }
    }

    // A dedicated blank Session for the committed preset switch.
    const blankResult = await lifecycle.create({ sessionId: BLANK_SESSION_ID, cwd: join(workRoot, 'blank') })
    assert.equal(blankResult.outcome.kind, 'created')

    // MODEL: the official directory read, the normalized commit, and the
    // durable `modelSelection` projection for the same Session.
    {
      await sessions.open(ORDINARY_SESSION_ID)
      const binding = sessions.binding(ORDINARY_SESSION_ID)
      assert.ok(binding !== undefined, 'the ordinary Session binding disappeared before the model scenario')
      await waitForProjection(binding, 'modelSelection', value => value !== undefined, 'the modelSelection projection baseline')

      const directory = await modelCatalog.loadDirectory()
      assert.deepEqual(directory.default, { provider: PROVIDER, model: MODEL })
      assert.ok(directory.routableProviders.includes(PROVIDER), 'the stub provider is not routable')
      const group = directory.groups.find(candidate => candidate.id === PROVIDER)
      assert.ok(group !== undefined, 'the stub provider group is missing from the model directory')
      assert.deepEqual(group.models.map(model => model.id), [MODEL])
      assert.deepEqual(directory.failures, [])
      // Provider ENDPOINT discovery has no official Remote capability in D2.3:
      // it is UNAVAILABLE, never faked from the model-directory cache.
      assert.deepEqual(modelCatalog.listProviders(), [], 'Remote provider discovery must be unavailable')
      assert.deepEqual(await modelCatalog.listModels(PROVIDER), [], 'Remote per-provider discovery must be unavailable')

      const selected = { provider: PROVIDER, model: MODEL }
      const result = await modelCatalog.selectSessionModel(ORDINARY_SESSION_ID, selected)
      assert.equal(result.ownership, 'current', `selectSessionModel lost local ownership: ${JSON.stringify(result)}`)
      const outcome = result.outcome
      assert.equal(outcome.kind, 'committed', `selectSessionModel did not commit: ${JSON.stringify(result)}`)
      assert.deepEqual(outcome.value, selected)

      const projected = await waitForProjection(
        binding,
        'modelSelection',
        value => value?.next?.provider === PROVIDER && value.next.model === MODEL,
        'the durable modelSelection projection to carry the selected pair',
      )
      assert.deepEqual(projected.next, selected)
      const hostSelection = host.ctx.get('sessionProjections')
        .snapshot(host.ctx.sessions.get(SessionId(ORDINARY_SESSION_ID)), ['modelSelection']).values.modelSelection
      assert.deepEqual(hostSelection.next, selected, 'the Host durable modelSelection projection diverged from the commit')
      scenarios.model = { status: 'covered', sessionId: ORDINARY_SESSION_ID, selected: outcome.value }
    }

    // PRESET: the official roster and a committed blank-Session switch.
    {
      const roster = await presetCatalog.roster()
      assert.equal(roster.modeSelectionEnabled, true)
      assert.equal(roster.defaultId, PRESET_A)
      assert.equal(presetCatalog.defaultId(), PRESET_A)
      for (const id of OFFICIAL_PRESET_IDS) {
        const row = roster.presets.find(candidate => candidate.id === id)
        assert.ok(row !== undefined, `official preset "${id}" is missing from the roster`)
        assert.equal(row.trust, 'system')
      }

      await sessions.open(BLANK_SESSION_ID)
      const binding = sessions.binding(BLANK_SESSION_ID)
      assert.ok(binding !== undefined, 'the blank Session binding disappeared before the preset scenario')
      const initial = await waitForProjection(binding, 'agentPreset', value => value !== undefined, 'the agentPreset projection baseline')
      assert.equal(initial, PRESET_A, 'a blank Session did not adopt the deployment default preset')

      const result = await presetCatalog.selectSessionPreset(BLANK_SESSION_ID, PRESET_B)
      assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'committed', value: { preset: PRESET_B } } })
      const committed = await waitForProjection(binding, 'agentPreset', value => value === PRESET_B, 'the committed agentPreset projection')
      assert.equal(committed, PRESET_B)
      const hostPreset = host.ctx.get('sessionProjections')
        .snapshot(host.ctx.sessions.get(SessionId(BLANK_SESSION_ID)), ['agentPreset']).values.agentPreset
      assert.equal(hostPreset, PRESET_B, 'the Host durable agentPreset projection diverged from the commit')
      scenarios.preset = { status: 'covered', defaultId: roster.defaultId, committed: PRESET_B }
    }

    // PRESET (locked): a Session with completed turns refuses the switch
    // through the adapter as a proven `agent-preset/locked` rejection.
    {
      host.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'starting first turn' }],
        source: { kind: 'user' },
      }))
      await waitFor('the first anchor turn to complete', () => {
        const ends = host.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
        return ends.length >= 1 ? true : undefined
      })
      host.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'starting second turn' }],
        source: { kind: 'user' },
      }))
      await waitFor('the second anchor turn to complete', () => {
        const ends = host.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
        return ends.length >= 2 ? true : undefined
      })
      const anchorEnds = host.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
      const firstEnd = Number(anchorEnds[0].seq)
      const secondEnd = Number(anchorEnds[1].seq)

      // F1 latest boundary: ClientSessions.fork owns the completed-turn cut,
      // child identity and reconciliation. The adapter sends one call and
      // never creates a child through the ordinary create path.
      {
        const forkResult = await lifecycle.fork({ sourceSessionId: ANCHOR_SESSION_ID })
        assert.equal(forkResult.ownership, 'current')
        assert.equal(forkResult.outcome.kind, 'forked', `latest fork did not settle as published: ${JSON.stringify(forkResult)}`)
        const childId = forkResult.outcome.kind === 'forked' ? forkResult.outcome.handle.session.id : undefined
        assert.ok(childId !== undefined && childId !== ANCHOR_SESSION_ID, 'Host fork did not generate a distinct child id')
        assert.ok(sessions.binding(childId) !== undefined, 'fork child is not addressable in Client state')
        const child = host.ctx.sessions.get(SessionId(childId))
        assert.ok(child !== undefined, 'fork child did not reach the Host Session registry')
        assert.equal(child.header.parentSession, ANCHOR_SESSION_ID, 'Host fork did not preserve the parent lineage')
        assert.equal(child.header.cwd, join(workRoot, 'anchor'), 'Host fork did not preserve the source cwd')
        assert.equal(child.header.isSeeded, true, 'Host fork did not publish a seeded child')
        assert.equal(Number(child.inheritedEventCount), secondEnd + 1,
          'Host fork must record the exact inherited prefix length (through the selected turn/end)')
        assert.ok(workspaceMembership().includes(childId),
          'Host fork child was not attached to the source workspace')
        const childPreset = host.ctx.get('sessionProjections')
          .snapshot(child, ['agentPreset']).values.agentPreset
        assert.equal(childPreset, PRESET_A, 'Host fork did not preserve the observed source preset')
        assert.equal(Number(child.snapshotEvents().findLast(event => event.type === 'turn/end')?.seq), secondEnd,
          'omitted anchor must inherit through the latest closed turn')
        scenarios.forkLatest = { status: 'covered', sourceSessionId: ANCHOR_SESSION_ID, childSessionId: childId, boundarySeq: secondEnd }
      }

      // F2 historical boundary: the official first turn/end at or after the
      // anchor wins; no TUI-side historical seed is constructed.
      {
        const forkResult = await lifecycle.fork({ sourceSessionId: ANCHOR_SESSION_ID, atSeq: firstEnd - 1 })
        assert.equal(forkResult.outcome.kind, 'forked', `historical fork did not settle: ${JSON.stringify(forkResult)}`)
        const childId = forkResult.outcome.kind === 'forked' ? forkResult.outcome.handle.session.id : undefined
        assert.ok(childId !== undefined)
        const child = host.ctx.sessions.get(SessionId(childId))
        assert.ok(child !== undefined)
        assert.equal(Number(child.snapshotEvents().findLast(event => event.type === 'turn/end')?.seq), firstEnd,
          'historical anchor must stop at the first completed turn at or after the anchor')
        assert.equal(Number(child.inheritedEventCount), firstEnd + 1,
          'historical Host fork must record the exact inherited prefix length')
        scenarios.forkHistorical = { status: 'covered', sourceSessionId: ANCHOR_SESSION_ID, childSessionId: childId, anchorSeq: firstEnd - 1, boundarySeq: firstEnd }
      }

      // F4 future anchor: the official Host falls back to the latest closed
      // turn rather than inventing a future boundary.
      {
        const forkResult = await lifecycle.fork({ sourceSessionId: ANCHOR_SESSION_ID, atSeq: secondEnd + 100 })
        assert.equal(forkResult.outcome.kind, 'forked', `future-anchor fork did not settle: ${JSON.stringify(forkResult)}`)
        const childId = forkResult.outcome.kind === 'forked' ? forkResult.outcome.handle.session.id : undefined
        assert.ok(childId !== undefined)
        const child = host.ctx.sessions.get(SessionId(childId))
        assert.ok(child !== undefined)
        assert.equal(Number(child.snapshotEvents().findLast(event => event.type === 'turn/end')?.seq), secondEnd,
          'a future anchor must fall back to the latest completed turn')
        scenarios.forkFuture = { status: 'covered', sourceSessionId: ANCHOR_SESSION_ID, childSessionId: childId, anchorSeq: secondEnd + 100, boundarySeq: secondEnd }
      }

      // F3 open-tail rejection: append a turn/start without a matching end;
      // an anchor inside that tail has no legal completed boundary.
      {
        const openStart = host.agent.session.append('turn/start', { turn: 99 })
        const forkResult = await lifecycle.fork({ sourceSessionId: ANCHOR_SESSION_ID, atSeq: Number(openStart.seq) })
        assert.equal(forkResult.outcome.kind, 'rejected', `open-tail fork was not rejected: ${JSON.stringify(forkResult)}`)
        if (forkResult.outcome.kind === 'rejected') assert.equal(forkResult.outcome.error.code, 'session/fork-unavailable')
        scenarios.forkOpenTail = { status: 'covered', sourceSessionId: ANCHOR_SESSION_ID, anchorSeq: Number(openStart.seq) }
      }

      const result = await presetCatalog.selectSessionPreset(ANCHOR_SESSION_ID, PRESET_B)
      const outcome = result.outcome
      assert.equal(outcome.kind, 'rejected', `a started Session preset switch was not rejected: ${JSON.stringify(result)}`)
      assert.equal(outcome.error.code, 'agent-preset/locked')
      scenarios.presetLocked = { status: 'covered', sessionId: ANCHOR_SESSION_ID, code: outcome.error.code }
    }

    // DIRECT vs HOST (D2.4): the same fork scenarios against an INDEPENDENT
    // source Session on the SAME real Host, so the two adapters are compared
    // directly and no Session ever has two writers. Both sources carry
    // structurally identical logs, and both are members of ONE real workspace
    // created through the official registry (never a fake that can only say
    // "no workspace").
    {
      host.directAgent.followup(createUserMessage({
        content: [{ type: 'text', text: 'starting first turn' }],
        source: { kind: 'user' },
      }))
      await waitFor('the Direct source first turn to complete', () => {
        const ends = host.directAgent.session.snapshotEvents().filter(event => event.type === 'turn/end')
        return ends.length >= 1 ? true : undefined
      })
      host.directAgent.followup(createUserMessage({
        content: [{ type: 'text', text: 'starting second turn' }],
        source: { kind: 'user' },
      }))
      await waitFor('the Direct source second turn to complete', () => {
        const ends = host.directAgent.session.snapshotEvents().filter(event => event.type === 'turn/end')
        return ends.length >= 2 ? true : undefined
      })
      const directEnds = host.directAgent.session.snapshotEvents().filter(event => event.type === 'turn/end')
      const directFirstEnd = Number(directEnds[0].seq)
      const directSecondEnd = Number(directEnds[1].seq)

      // The two sources carry structurally identical logs, so their cut
      // sequences MUST match; the children's own-seq checks below are not
      // evidence of parity without this cross-equality.
      assert.equal(directSecondEnd, scenarios.forkLatest?.boundarySeq,
        'Direct and Host sources must agree on the latest completed-turn boundary')
      assert.equal(directFirstEnd, scenarios.forkHistorical?.boundarySeq,
        'Direct and Host sources must agree on the historical completed-turn boundary')

      const childSession = (outcome) => outcome.kind === 'forked'
        ? host.ctx.sessions.get(SessionId(outcome.handle.session.id))
        : undefined

      // F1: Direct latest boundary, child metadata and workspace inheritance
      // must equal the Host's.
      const latest = await direct.fork({ sourceSessionId: DIRECT_SOURCE_SESSION_ID })
      assert.equal(latest.outcome.kind, 'forked', `Direct latest fork did not settle as ${latest.outcome.kind}`)
      const latestChildId = latest.outcome.kind === 'forked' ? latest.outcome.handle.session.id : undefined
      assert.ok(latestChildId !== undefined && latestChildId !== DIRECT_SOURCE_SESSION_ID, 'Direct fork did not generate a distinct child id')
      const latestChild = childSession(latest.outcome)
      assert.ok(latestChild !== undefined, 'Direct fork child did not reach the Host Session registry')
      assert.equal(latestChild.header.parentSession, DIRECT_SOURCE_SESSION_ID, 'Direct fork must preserve the parent lineage')
      assert.equal(latestChild.header.cwd, anchorDir, 'Direct fork must preserve the source cwd')
      assert.equal(latestChild.header.isSeeded, true, 'Direct fork must publish a seeded child')
      assert.equal(Number(latestChild.inheritedEventCount), directSecondEnd + 1,
        'Direct latest fork must record the exact inherited prefix length')
      assert.equal(Number(latestChild.snapshotEvents().findLast(event => event.type === 'turn/end')?.seq), directSecondEnd,
        'Direct latest fork must stop at the same completed-turn boundary the Host chooses')
      const latestPreset = host.ctx.get('sessionProjections').snapshot(latestChild, ['agentPreset']).values.agentPreset
      assert.equal(latestPreset, PRESET_A, 'Direct fork must preserve the observed source preset')
      assert.ok(workspaceMembership().includes(latestChildId), 'Direct fork child was not attached to the source workspace')
      // Direct child model state must match the Host child's for the equivalent
      // source. Pin the EXPECTED selection (non-default, with reasoningEffort)
      // instead of only cross-comparing: a symmetric inheritance regression
      // would otherwise pass.
      const hostChildId = scenarios.forkLatest?.childSessionId
      const hostChild = hostChildId === undefined ? undefined : host.ctx.sessions.get(SessionId(hostChildId))
      const selectionOf = session => host.ctx.get('sessionProjections')
        .snapshot(session, ['modelSelection']).values.modelSelection
      assert.ok(hostChild !== undefined, 'the Remote fork child from the same-Host block is missing')
      const directSelection = selectionOf(latestChild)
      const hostSelection = selectionOf(hostChild)
      assert.deepEqual(directSelection?.next, HISTORICAL_SELECTION,
        'Direct fork must inherit the concrete historical selection (including reasoningEffort)')
      assert.deepEqual(hostSelection?.next, HISTORICAL_SELECTION,
        'Host fork must inherit the concrete historical selection (including reasoningEffort)')
      assert.deepEqual(directSelection, hostSelection,
        'Direct and Host fork children must agree on the inherited model selection')
      assert.equal(Number(latestChild.inheritedEventCount), Number(hostChild.inheritedEventCount),
        'Direct and Host fork children must agree on the inherited prefix length')

      // F2/F4/F3: historical anchor, future anchor and open-tail rejection must
      // settle exactly like the Host.
      const historical = await direct.fork({ sourceSessionId: DIRECT_SOURCE_SESSION_ID, atSeq: directFirstEnd - 1 })
      assert.equal(historical.outcome.kind, 'forked', `Direct historical fork did not settle as ${historical.outcome.kind}`)
      assert.equal(Number(childSession(historical.outcome)?.snapshotEvents().findLast(event => event.type === 'turn/end')?.seq), directFirstEnd,
        'Direct historical anchor must stop at the first completed turn at or after it')
      assert.equal(Number(childSession(historical.outcome)?.inheritedEventCount), directFirstEnd + 1,
        'Direct historical fork must record the exact inherited prefix length')

      const future = await direct.fork({ sourceSessionId: DIRECT_SOURCE_SESSION_ID, atSeq: directSecondEnd + 100 })
      assert.equal(future.outcome.kind, 'forked', `Direct future-anchor fork did not settle as ${future.outcome.kind}`)
      assert.equal(Number(childSession(future.outcome)?.snapshotEvents().findLast(event => event.type === 'turn/end')?.seq), directSecondEnd,
        'Direct future anchor must fall back to the latest completed turn')

      const directOpenStart = host.directAgent.session.append('turn/start', { turn: 99 })
      const openTail = await direct.fork({ sourceSessionId: DIRECT_SOURCE_SESSION_ID, atSeq: Number(directOpenStart.seq) })
      assert.equal(openTail.outcome.kind, 'rejected', `Direct open-tail fork did not settle as ${openTail.outcome.kind}`)
      if (openTail.outcome.kind === 'rejected') assert.equal(openTail.outcome.error.code, 'session/fork-unavailable')

      const missing = await direct.fork({ sourceSessionId: 'session-does-not-exist' })
      assert.equal(missing.outcome.kind, 'rejected', `Direct missing-source fork did not settle as ${missing.outcome.kind}`)
      if (missing.outcome.kind === 'rejected') assert.equal(missing.outcome.error.code, 'session/not-found')

      scenarios.directHostForkParity = {
        status: 'covered',
        sourceSessionId: DIRECT_SOURCE_SESSION_ID,
        childSessionId: latestChildId,
        boundarySeq: directSecondEnd,
        workspaceId: workspace.id,
        openTailCode: openTail.outcome.kind === 'rejected' ? openTail.outcome.error.code : undefined,
        notFoundCode: missing.outcome.kind === 'rejected' ? missing.outcome.error.code : undefined,
      }
    }

    // ---- D2.4 F5/F7/F8 parity scenarios --------------------------------------
    // Each pair forks an INDEPENDENT Host-path source and Direct-path source on
    // the same real Host. No Direct result is ever JSON-stringified.
    {
      const forkPair = async (hostSourceId, directSourceId) => {
        const hostResult = await lifecycle.fork({ sourceSessionId: hostSourceId })
        const directResult = await direct.fork({ sourceSessionId: directSourceId })
        assert.equal(hostResult.outcome.kind, 'forked', `Host fork of ${hostSourceId} settled as ${hostResult.outcome.kind}`)
        assert.equal(directResult.outcome.kind, 'forked', `Direct fork of ${directSourceId} settled as ${directResult.outcome.kind}`)
        const hostChildId = hostResult.outcome.handle.session.id
        const directChildId = directResult.outcome.handle.session.id
        const hostChild = host.ctx.sessions.get(SessionId(hostChildId))
        const directChild = host.ctx.sessions.get(SessionId(directChildId))
        assert.ok(hostChild !== undefined, `Host fork child ${hostChildId} is not in the Session registry`)
        assert.ok(directChild !== undefined, `Direct fork child ${directChildId} is not in the Session registry`)
        return { hostResult, directResult, hostChildId, directChildId, hostChild, directChild }
      }

      // F5 (A): a consumed pre-cut selection followed by a DIFFERENT unconsumed
      // selection after the last closed turn. The cut must exclude the post-cut
      // event, so the projection resolves the consumed pre-cut selection.
      {
        const aHostSource = host.ctx.sessions.get(SessionId(A_HOST_SOURCE_SESSION_ID))
        const aDirectSource = host.ctx.sessions.get(SessionId(A_DIRECT_SOURCE_SESSION_ID))
        assert.ok(aHostSource !== undefined && aDirectSource !== undefined, 'the case A sources are missing')
        assert.deepEqual(modelSelectionOf(host.ctx, aHostSource).next, POST_CUT_SELECTION,
          'the Host source must carry the unconsumed post-cut selection before fork')
        assert.deepEqual(modelSelectionOf(host.ctx, aDirectSource).next, POST_CUT_SELECTION,
          'the Direct source must carry the unconsumed post-cut selection before fork')
        // The pre-cut selection must be CONSUMED (its request/header advanced
        // `lastUsed`), otherwise this fixture would not prove the cut excludes
        // the post-cut event rather than simply having no earlier intent.
        assert.deepEqual(modelSelectionOf(host.ctx, aHostSource).lastUsed, CONSUMED_PRE_CUT_SELECTION,
          'the Host source must show the pre-cut selection as consumed')
        assert.deepEqual(modelSelectionOf(host.ctx, aDirectSource).lastUsed, CONSUMED_PRE_CUT_SELECTION,
          'the Direct source must show the pre-cut selection as consumed')

        const { hostChildId, directChildId, hostChild, directChild } =
          await forkPair(A_HOST_SOURCE_SESSION_ID, A_DIRECT_SOURCE_SESSION_ID)
        const hostSelection = modelSelectionOf(host.ctx, hostChild)
        const directSelection = modelSelectionOf(host.ctx, directChild)
        assert.deepEqual(hostSelection.next, CONSUMED_PRE_CUT_SELECTION,
          'Host fork must resolve the consumed pre-cut selection, never the post-cut one')
        assert.deepEqual(directSelection.next, CONSUMED_PRE_CUT_SELECTION,
          'Direct fork must resolve the consumed pre-cut selection, never the post-cut one')
        assert.deepEqual(directSelection, hostSelection,
          'Direct and Host fork children must agree on the inherited selection projection')
        assert.equal(Number(hostChild.inheritedEventCount), Number(directChild.inheritedEventCount),
          'Direct and Host pre-cut selection children must agree on the inherited prefix length')
        scenarios.forkSelectionParity = {
          status: 'covered',
          hostSourceSessionId: A_HOST_SOURCE_SESSION_ID,
          directSourceSessionId: A_DIRECT_SOURCE_SESSION_ID,
          hostChildSessionId: hostChildId,
          directChildSessionId: directChildId,
          inheritedSelection: CONSUMED_PRE_CUT_SELECTION,
          excludedSelection: POST_CUT_SELECTION,
        }
      }

      // F5 (B): no session-local selection. The projection must have no intent,
      // and BOTH adapters must activate the Host default provider/model, which is
      // observable only once a request header is assembled.
      {
        const bHostSource = host.ctx.sessions.get(SessionId(B_HOST_SOURCE_SESSION_ID))
        const bDirectSource = host.ctx.sessions.get(SessionId(B_DIRECT_SOURCE_SESSION_ID))
        assert.ok(bHostSource !== undefined && bDirectSource !== undefined, 'the case B sources are missing')
        // Prove the fixture really has NO session-local intent before forking;
        // otherwise the child assertion below could pass for the wrong reason.
        assert.deepEqual(modelSelectionOf(host.ctx, bHostSource), { lastUsed: null, next: null },
          'the Host no-selection source must have no session-local intent')
        assert.deepEqual(modelSelectionOf(host.ctx, bDirectSource), { lastUsed: null, next: null },
          'the Direct no-selection source must have no session-local intent')

        const { hostResult, directResult, hostChildId, directChildId, hostChild, directChild } =
          await forkPair(B_HOST_SOURCE_SESSION_ID, B_DIRECT_SOURCE_SESSION_ID)
        assert.deepEqual(modelSelectionOf(host.ctx, hostChild), { lastUsed: null, next: null },
          'Host fork without session-local selection must project no intent')
        assert.deepEqual(modelSelectionOf(host.ctx, directChild), { lastUsed: null, next: null },
          'Direct fork without session-local selection must project no intent')

        const hostChildAgent = host.ctx.agents.get(SessionId(hostChildId))
        const directChildAgent = directResult.outcome.handle.direct.agent
        assert.ok(hostChildAgent !== undefined, 'the official Host fork child has no live Agent to prompt')
        assert.ok(directChildAgent !== undefined, 'the Direct fork child has no live Agent to prompt')
        const probe = () => createUserMessage({
          content: [{ type: 'text', text: 'default activation probe' }],
          source: { kind: 'user' },
        })
        const hostEndsBefore = hostChild.snapshotEvents().filter(event => event.type === 'turn/end').length
        const directEndsBefore = directChild.snapshotEvents().filter(event => event.type === 'turn/end').length
        hostChildAgent.followup(probe())
        directChildAgent.followup(probe())
        await waitFor('the Host default-activation child turn to complete', () =>
          hostChild.snapshotEvents().filter(event => event.type === 'turn/end').length > hostEndsBefore ? true : undefined)
        await waitFor('the Direct default-activation child turn to complete', () =>
          directChild.snapshotEvents().filter(event => event.type === 'turn/end').length > directEndsBefore ? true : undefined)

        const firstRequestConfig = session =>
          session.snapshotEvents().find(event => event.type === 'request/header')?.data.header.config
        const hostConfig = firstRequestConfig(hostChild)
        const directConfig = firstRequestConfig(directChild)
        assert.ok(hostConfig !== undefined, 'the Host child assembled no first request header')
        assert.ok(directConfig !== undefined, 'the Direct child assembled no first request header')
        assert.deepEqual({ provider: hostConfig.provider, model: hostConfig.model }, { provider: PROVIDER, model: MODEL },
          'the Host child must activate the Host default provider/model')
        assert.deepEqual({ provider: directConfig.provider, model: directConfig.model }, { provider: PROVIDER, model: MODEL },
          'the Direct child must activate the Host default provider/model')
        assert.deepEqual(directConfig, hostConfig,
          'Direct and Host default-fallback children must assemble the same activation config')
        scenarios.forkDefaultSelectionParity = {
          status: 'covered',
          hostSourceSessionId: B_HOST_SOURCE_SESSION_ID,
          directSourceSessionId: B_DIRECT_SOURCE_SESSION_ID,
          hostChildSessionId: hostChildId,
          directChildSessionId: directChildId,
          defaultActivation: { provider: PROVIDER, model: MODEL },
        }
      }

      // F5 (C): the latest closed turn ends `aborted`, after an earlier completed
      // turn; the fork boundary must be the aborted `turn/end`.
      {
        const { hostChildId, directChildId, hostChild, directChild } =
          await forkPair(C_HOST_SOURCE_SESSION_ID, C_DIRECT_SOURCE_SESSION_ID)
        assert.equal(abortedBoundarySeq.host, abortedBoundarySeq.direct,
          'structurally identical case C sources must agree on the aborted boundary seq')
        const lastEnd = session => session.snapshotEvents().findLast(event => event.type === 'turn/end')
        const hostEnd = lastEnd(hostChild)
        const directEnd = lastEnd(directChild)
        assert.equal(Number(hostEnd.seq), abortedBoundarySeq.host,
          'Host fork must stop at the aborted turn/end, not the earlier completed one')
        assert.equal(Number(directEnd.seq), abortedBoundarySeq.direct,
          'Direct fork must stop at the aborted turn/end, not the earlier completed one')
        assert.equal(hostEnd.data.reason.kind, 'aborted', 'Host fork must inherit the aborted turn/end reason')
        assert.equal(directEnd.data.reason.kind, 'aborted', 'Direct fork must inherit the aborted turn/end reason')
        assert.equal(Number(hostChild.inheritedEventCount), abortedBoundarySeq.host + 1,
          'Host aborted-boundary fork must record the exact prefix through the aborted turn/end')
        assert.equal(Number(directChild.inheritedEventCount), abortedBoundarySeq.direct + 1,
          'Direct aborted-boundary fork must record the exact prefix through the aborted turn/end')
        scenarios.forkAbortedBoundaryParity = {
          status: 'covered',
          hostSourceSessionId: C_HOST_SOURCE_SESSION_ID,
          directSourceSessionId: C_DIRECT_SOURCE_SESSION_ID,
          hostChildSessionId: hostChildId,
          directChildSessionId: directChildId,
          boundarySeq: abortedBoundarySeq.direct,
          boundaryReason: 'aborted',
        }
      }

      // F8 (D): a subagent-origin source is NOT a direct workspace member, but
      // its parent is. The child must join the nearest ancestor workspace while
      // its own header stays an ordinary (non-subagent) lineage header.
      {
        assert.equal(subagentMembership().includes(D_HOST_SOURCE_SESSION_ID), false,
          'the Host subagent source must not be a direct workspace member')
        assert.equal(subagentMembership().includes(D_DIRECT_SOURCE_SESSION_ID), false,
          'the Direct subagent source must not be a direct workspace member')
        // Pin the fixture preconditions: without them the "child does not copy
        // origin/delegationDepth" assertions could pass on a malformed source.
        const dHostSource = host.ctx.sessions.get(SessionId(D_HOST_SOURCE_SESSION_ID))
        const dDirectSource = host.ctx.sessions.get(SessionId(D_DIRECT_SOURCE_SESSION_ID))
        assert.ok(dHostSource !== undefined && dDirectSource !== undefined, 'the case D sources are missing')
        for (const [label, source, parentId] of [
          ['Host', dHostSource, D_HOST_PARENT_SESSION_ID],
          ['Direct', dDirectSource, D_DIRECT_PARENT_SESSION_ID],
        ]) {
          assert.equal(source.header.origin, 'subagent', `${label} subagent source fixture must carry origin: 'subagent'`)
          assert.equal(source.header.delegationDepth, 1, `${label} subagent source fixture must carry delegationDepth: 1`)
          assert.equal(source.header.parentSession, parentId, `${label} subagent source must name its immediate parent`)
        }
        const { hostChildId, directChildId, hostChild, directChild } =
          await forkPair(D_HOST_SOURCE_SESSION_ID, D_DIRECT_SOURCE_SESSION_ID)
        for (const [label, child, sourceId, childId] of [
          ['Host', hostChild, D_HOST_SOURCE_SESSION_ID, hostChildId],
          ['Direct', directChild, D_DIRECT_SOURCE_SESSION_ID, directChildId],
        ]) {
          assert.equal(child.header.parentSession, sourceId, `${label} subagent fork must preserve the immediate parent lineage`)
          assert.equal(child.header.origin, undefined, `${label} subagent fork child must not copy origin: 'subagent'`)
          assert.equal(child.header.delegationDepth, undefined, `${label} subagent fork child must not copy delegationDepth`)
          assert.equal(child.header.cwd, subagentParentDir, `${label} subagent fork child must keep the source cwd`)
          assert.equal(child.header.isSeeded, true, `${label} subagent fork must publish a seeded child`)
          assert.equal(subagentMembership().includes(childId), true,
            `${label} subagent fork child must inherit the nearest ancestor workspace`)
        }
        scenarios.forkSubagentWorkspaceParity = {
          status: 'covered',
          hostSourceSessionId: D_HOST_SOURCE_SESSION_ID,
          directSourceSessionId: D_DIRECT_SOURCE_SESSION_ID,
          hostChildSessionId: hostChildId,
          directChildSessionId: directChildId,
          ancestorWorkspaceId: subagentWorkspace.id,
        }
      }

      // F7 (E): a cwd-absent source must fork a cwd-absent child.
      {
        const eHostSource = host.ctx.sessions.get(SessionId(E_HOST_SOURCE_SESSION_ID))
        const eDirectSource = host.ctx.sessions.get(SessionId(E_DIRECT_SOURCE_SESSION_ID))
        assert.equal(eHostSource.header.cwd, undefined, 'the Host cwd-absent source must have no cwd')
        assert.equal(eDirectSource.header.cwd, undefined, 'the Direct cwd-absent source must have no cwd')
        const { hostChildId, directChildId, hostChild, directChild } =
          await forkPair(E_HOST_SOURCE_SESSION_ID, E_DIRECT_SOURCE_SESSION_ID)
        assert.equal(hostChild.header.cwd, undefined, 'Host fork of a cwd-absent source must not invent a cwd')
        assert.equal(directChild.header.cwd, undefined, 'Direct fork of a cwd-absent source must not invent a cwd')
        assert.equal(hostChild.header.parentSession, E_HOST_SOURCE_SESSION_ID, 'Host cwd-absent fork must preserve lineage')
        assert.equal(directChild.header.parentSession, E_DIRECT_SOURCE_SESSION_ID, 'Direct cwd-absent fork must preserve lineage')
        assert.equal(hostChild.header.isSeeded, true, 'Host cwd-absent fork must publish a seeded child')
        assert.equal(directChild.header.isSeeded, true, 'Direct cwd-absent fork must publish a seeded child')
        scenarios.forkCwdAbsentParity = {
          status: 'covered',
          hostSourceSessionId: E_HOST_SOURCE_SESSION_ID,
          directSourceSessionId: E_DIRECT_SOURCE_SESSION_ID,
          hostChildSessionId: hostChildId,
          directChildSessionId: directChildId,
        }
      }
    }
    // --------------------------------------------------------------------------

    // OPEN: official Client open/binding, the Client current identity moves,
    // and no Host resume is issued.
    {
      const resumeBefore = host.resumeCalls.length
      const opensBefore = openCalls.length
      const openResult = await lifecycle.open({ sessionId: FRESH_SESSION_ID })
      assert.equal(openResult.ownership, 'current')
      assert.equal(openResult.outcome.kind, 'opened')
      const handle = openResult.outcome.kind === 'opened' ? openResult.outcome.handle : undefined
      assert.deepEqual(handle, { session: { id: FRESH_SESSION_ID } })
      assert.equal(openCalls.length, opensBefore + 1, 'open did not route through ClientSessions.open')
      assert.equal(openCalls.at(-1), FRESH_SESSION_ID)
      await waitFor('the Client current selection to become the opened Session', () => (
        sessions.list.getSnapshot().current === FRESH_SESSION_ID ? true : undefined
      ))
      const binding = sessions.binding(FRESH_SESSION_ID)
      assert.ok(binding !== undefined, 'the opened Session lost its binding')
      await waitForProjection(binding, 'agentPreset', value => value === PRESET_B, 'the opened Session agentPreset projection')
      assert.equal(host.resumeCalls.length, resumeBefore, 'open issued a Host Agent resume')
      scenarios.open = { status: 'covered', sessionId: FRESH_SESSION_ID, current: String(sessions.list.getSnapshot().current) }
    }

    assert.equal(host.resumeCalls.length, 0, `no Host Agent resume may occur in this smoke, saw ${JSON.stringify(host.resumeCalls)}`)

    // Read-only gate: every request travelled through the mounted official
    // carrier (the session Client plugin itself refreshes the `subagents`
    // catalog from the mounted namespace, which is incidental to the D2.3
    // verbs), and each D2.3 semantic verb was actually exercised.
    {
      const paths = fetchLog.map(entry => entry.slice(entry.indexOf(' ') + 1))
      assert.deepEqual(
        paths.filter(path => !/^\/api\/(session|agentPresets|subagents|commands)\//.test(path)),
        [],
        'a request left the mounted official remote domains',
      )
      for (const expected of [
        '/api/session/create',
        '/api/session/modelCatalog',
        '/api/session/selectModel',
        '/api/session/fork',
        '/api/agentPresets/list',
        '/api/agentPresets/select',
      ]) {
        assert.ok(paths.includes(expected), `the smoke never used the official ${expected} endpoint`)
      }
      scenarios.readOnlyGate = {
        status: 'covered',
        requests: fetchLog.length,
        resumeCalls: host.resumeCalls.length,
        paths: [...new Set(paths)].sort(),
      }
    }

    console.log(JSON.stringify({ ok: true, scenarios }))
  } finally {
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) await host.ctx.fiber.dispose()
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_D2_3_PARITY_FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
