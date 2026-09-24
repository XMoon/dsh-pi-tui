#!/usr/bin/env node
/**
 * B3 same-Host fork parity smoke over the pinned official DSH 0.1.7-rc.1
 * Host and Client contracts.
 *
 * This is a SELF-CONTAINED harness (it deliberately does not import the
 * retired D2.3 parity smoke, whose 0.1.6-era harness still encodes the
 * retired packages and the old completed-turn flooring semantics; the alpha.2
 * line is only the historical contract provenance of this fork parity
 * scenario). One real Host
 * Context owns the Session store, the production AgentLoop with an in-process
 * stub LLM route, the declarative agent preset registry, projections, the
 * SQLite session query engine, the local fs service, the real workspace stack,
 * the Session Controller, the Gateway and the forwarded-event source. An
 * independent official Client Context reaches the same Host through the
 * official Connection/Gateway carrier.
 *
 * Every scenario owns ONE Host-path source and ONE Direct-path source (two
 * INDEPENDENT writers) with structurally identical logs. The official Host
 * fork runs through `ClientSessions.fork()`; the Direct fork runs through
 * `DirectSessionLifecycle.fork()`. The children are then compared on semantic
 * output only — event structure, inherited prefix length, fork marker and
 * repair shape, lineage metadata, workspace membership, preset and activation
 * default — never on ids or timestamps.
 *
 * Covered parity cases (plan §26):
 * - P1 exact mid-turn cut with a dispatched result-less tool call (repair);
 * - P2 exact turn/end cut;
 * - P3 nonexistent explicit seq rejects on both paths (no flooring/fallback);
 * - P4 omitted cut includes a standalone stable tail event;
 * - P5 omitted cut excludes queued input, and continuing both children with
 *   "C" never executes the parent's queued future input;
 * - P6 child lineage (parentSession + isSeeded, compared by shape);
 * - P7 subagent source nearest-ancestor workspace with an ordinary child
 *   header (origin/delegationDepth not copied);
 * - P8 child activation stays the Host current default.
 *
 * @module dsh-remote-d2.4-fork-parity-smoke
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { DirectSessionLifecycle } from '../src/runtime/direct/session-lifecycle-direct.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

const PROVIDER = 'smoke'
const MODEL = 'smoke'
const PRESET = 'parity-preset'

// Per scenario: ONE Host-path source and ONE Direct-path source. Driving both
// fork paths against one source would create two writers for the same Session.
const SOURCES = {
  p1Host: 'b3-p1-host-source',
  p1Direct: 'b3-p1-direct-source',
  p2Host: 'b3-p2-host-source',
  p2Direct: 'b3-p2-direct-source',
  p4Host: 'b3-p4-host-source',
  p4Direct: 'b3-p4-direct-source',
  p5Host: 'b3-p5-host-source',
  p5Direct: 'b3-p5-direct-source',
  p7HostParent: 'b3-p7-host-parent',
  p7DirectParent: 'b3-p7-direct-parent',
  p7Host: 'b3-p7-host-source',
  p7Direct: 'b3-p7-direct-source',
}

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png']),
})

/** In-process stub LLM route: advertises one routable model and completes
 * every turn with one plain text block so a continued child can settle. */
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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-b3-parity.local', search: '' }
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
    // The official declarative preset registry: one mountable fixture preset
    // with an empty composition, registered through the official API. Its
    // constructor registers the agentPreset projection definition.
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: PRESET })
    await ctx.get('agentPresets').register({ id: PRESET, name: 'B3 parity preset', plugins: [] })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    // The fs service the alpha.2 Session Controller injects.
    await ctx.plugin(LocalFileSystem)
    // The REAL official workspace stack: both fork paths must observe one
    // genuine `ctx.workspaceRegistry`, not a stub that can only say "none".
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
    return { ctx, loop, persistenceRoot: join(workRoot, 'persistence'), persistenceFiber }
  } catch (error) {
    if (persistenceFiber !== undefined) await persistenceFiber.dispose()
    throw error
  }
}

function hostTransport(host) {
  const shared = host.ctx.get('connection').createSharedFetchHandler('/api')
  /** The alpha.2 client stream carrier contract passes an optional uplink;
   * the Host wire face always takes one, so an absent uplink is an empty one. */
  async function* emptyUplink() {}
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'http://dsh-b3-parity.local'), init)
      return shared.fetch(request)
    },
    openStream(endpoint, payload, signal, uplink) {
      return (async function* () {
        // alpha.2 wire face: (endpoint, payload, uplink, peer, signal) — the
        // operator's in-process carrier has no peer scope.
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

/** ---- source fixture builders (event shapes follow the official upstream
 * session-controller fork spec) ------------------------------------------- */

function createSource(host, sessionId, meta = {}) {
  return host.ctx.get('sessions').create(SessionId(sessionId), {
    meta: { cwd: meta.cwd, agentPreset: PRESET, ...meta },
  })
}

function appendClosedTurn(session, turn, text) {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return Number(session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq)
}

/** Open a second turn whose dispatched tool call never reaches a result. */
function appendOpenTurnWithDispatchedCall(session, turn, callId) {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `open ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  return Number(session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' }).seq)
}

/** ---- semantic child comparison ----------------------------------------- */

/** Normalize one event for cross-path comparison by stripping ONLY the fields
 * expected to differ between the two structurally identical sources: the
 * event `time` (each source appends at its own wall-clock moments) and
 * generated message `id`s (each source's createUserMessage/createMessage call
 * mints its own). EVERYTHING else — type, seq, surfaceOp, message role and
 * full content, tool-call name/arguments, sources, turn/step/reason payload,
 * unknown-event data — stays in the comparison, so a semantic divergence in
 * any inherited or synthesized record fails the parity assertion. */
function normalizeEvent(event) {
  const out = JSON.parse(JSON.stringify(event))
  delete out.time
  // `user/message` data IS the message; `assistant/message` / `tool/result`
  // nest it under `message`. Only objects shaped like a message carry a
  // generated id; tool-call block ids are fixture-pinned call ids and stay.
  if (out.data?.role !== undefined) delete out.data.id
  if (out.data?.message?.role !== undefined) delete out.data.message.id
  return out
}

function childSnapshot(host, childId) {
  const session = host.ctx.sessions.get(SessionId(childId))
  assert.ok(session !== undefined, `fork child ${String(childId)} is not in the Host Session registry`)
  return session
}

/** Compare two children from structurally identical sources on semantic
 * output only (never ids/times), including lineage-by-shape and preset. */
function assertChildrenParity(host, hostChild, directChild, hostSourceId, directSourceId, expectations = {}) {
  const hostEvents = hostChild.snapshotEvents()
  const directEvents = directChild.snapshotEvents()
  assert.deepEqual(directEvents.map(normalizeEvent), hostEvents.map(normalizeEvent),
    'Direct and Host fork children must agree on the full normalized event structure')
  assert.equal(Number(directChild.inheritedEventCount), Number(hostChild.inheritedEventCount),
    'Direct and Host fork children must agree on the inherited prefix length')
  const inheritedEventCount = Number(hostChild.inheritedEventCount)
  const hostMarker = hostEvents[inheritedEventCount]
  const directMarker = directEvents[inheritedEventCount]
  assert.equal(hostMarker?.type, 'session/end-seed', 'the Host child must carry the end-seed marker at the cut')
  assert.equal(directMarker?.type, 'session/end-seed', 'the Direct child must carry the end-seed marker at the cut')
  assert.equal(hostMarker?.data.inherited, true)
  assert.equal(directMarker?.data.inherited, true)
  for (const [child, sourceId, label] of [
    [hostChild, hostSourceId, 'Host'],
    [directChild, directSourceId, 'Direct'],
  ]) {
    assert.equal(child.header.parentSession, sourceId, `${label} child parentSession must name its own source`)
    assert.equal(child.header.isSeeded, true, `${label} child must be seeded`)
    assert.equal(child.header.origin, undefined, `${label} child must not copy origin`)
    assert.equal(child.header.delegationDepth, undefined, `${label} child must not copy delegationDepth`)
  }
  const presetOf = session =>
    host.ctx.get('sessionProjections').snapshot(session, ['agentPreset']).values.agentPreset
  assert.equal(presetOf(hostChild), PRESET, 'Host child must preserve the observed source preset')
  assert.equal(presetOf(directChild), PRESET, 'Direct child must preserve the observed source preset')
  if (expectations.cwd !== undefined) {
    assert.equal(hostChild.header.cwd, expectations.cwd)
    assert.equal(directChild.header.cwd, expectations.cwd)
  }
  if (expectations.inheritedEventCount !== undefined) {
    assert.equal(inheritedEventCount, expectations.inheritedEventCount)
  }
  if (expectations.childEventCount !== undefined) {
    assert.equal(hostEvents.length, expectations.childEventCount)
    assert.equal(directEvents.length, expectations.childEventCount)
  }
  return { hostEvents, directEvents, inheritedEventCount }
}

async function main() {
  const scenarios = {}
  const loader = installModuleLoader()
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-b3-fork-parity-'))
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
    const workspace = await host.ctx.get('workspaceRegistry').create(anchorDir, 'B3 parity workspace')
    const workspaceMembership = () => host.ctx.get('workspaceRegistry').list()
      .find(candidate => candidate.id === workspace.id)?.sessionIds ?? []

    // ---- structurally identical source fixtures ---------------------------
    const fixture = {
      p1: source => {
        appendClosedTurn(source, 1, 'prompt 1')
        return appendOpenTurnWithDispatchedCall(source, 2, 'call-p1')
      },
      p2: source => appendClosedTurn(source, 1, 'prompt 1'),
      p4: source => {
        const end = appendClosedTurn(source, 1, 'prompt 1')
        source.append('session/title', { title: 'After the turn', messageSeqs: [], source: { kind: 'user' } })
        return end
      },
      p5: source => {
        const end = appendClosedTurn(source, 1, 'prompt 1')
        source.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'queued future input' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        return end
      },
    }
    const sourceIds = {
      p1: [SOURCES.p1Host, SOURCES.p1Direct],
      p2: [SOURCES.p2Host, SOURCES.p2Direct],
      p4: [SOURCES.p4Host, SOURCES.p4Direct],
      p5: [SOURCES.p5Host, SOURCES.p5Direct],
    }
    const boundarySeq = {}
    for (const [name, [hostId, directId]] of Object.entries(sourceIds)) {
      boundarySeq[name] = {
        host: fixture[name](createSource(host, hostId, { cwd: anchorDir })),
        direct: fixture[name](createSource(host, directId, { cwd: anchorDir })),
      }
      await workspace.attachSession(SessionId(hostId))
      await workspace.attachSession(SessionId(directId))
    }
    // P7: subagent-origin sources whose PARENT owns the workspace membership.
    const subagentDir = join(workRoot, 'subagent-parent')
    mkdirSync(subagentDir, { recursive: true })
    const subagentWorkspace = await host.ctx.get('workspaceRegistry').create(subagentDir, 'B3 subagent workspace')
    const subagentMembership = () => host.ctx.get('workspaceRegistry').list()
      .find(candidate => candidate.id === subagentWorkspace.id)?.sessionIds ?? []
    for (const parentId of [SOURCES.p7HostParent, SOURCES.p7DirectParent]) {
      createSource(host, parentId, { cwd: subagentDir })
      await subagentWorkspace.attachSession(SessionId(parentId))
    }
    for (const [sourceId, parentId] of [
      [SOURCES.p7Host, SOURCES.p7HostParent],
      [SOURCES.p7Direct, SOURCES.p7DirectParent],
    ]) {
      const source = createSource(host, sourceId, {
        cwd: subagentDir,
        parentSession: SessionId(parentId),
        origin: 'subagent',
        delegationDepth: 1,
      })
      appendClosedTurn(source, 1, 'subagent prompt')
    }
    // -----------------------------------------------------------------------

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
    await waitFor('same-Host Client readiness', () => (
      connection.generation.getSnapshot() !== undefined
        && sessions.list.getSnapshot().phase === 'ready'
    ))

    // The Direct composition mirrors the official controller: resolve the
    // preset id through the same registry, then mount the resolved preset in
    // the child's setup.
    const presets = host.ctx.get('agentPresets')
    const direct = new DirectSessionLifecycle(host.ctx, async (presetId) => {
      const resolved = await presets.resolve(presetId)
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id) },
      }
    })

    // The official Host fork face for every Host-path scenario.
    const hostFork = async (sourceId, atSeq) => {
      try {
        const childId = await sessions.fork({
          sessionId: SessionId(sourceId),
          ...(atSeq === undefined ? {} : { atSeq }),
        })
        return { ok: true, childId: String(childId) }
      } catch (error) {
        return { ok: false, code: String(error?.rpcError?.code ?? error?.code ?? error?.message) }
      }
    }
    const directFork = async (sourceId, atSeq) => {
      const result = await direct.fork({ sourceSessionId: sourceId, ...(atSeq === undefined ? {} : { atSeq }) })
      return result.outcome
    }

    // P1 — exact mid-turn cut over a dispatched result-less tool call.
    {
      const anchor = boundarySeq.p1.direct
      assert.equal(boundarySeq.p1.host, anchor, 'P1 sources must be structurally identical')
      const hostOutcome = await hostFork(SOURCES.p1Host, anchor)
      const directOutcome = await directFork(SOURCES.p1Direct, anchor)
      assert.equal(hostOutcome.ok, true, `Host P1 fork failed: ${JSON.stringify(hostOutcome)}`)
      assert.equal(directOutcome.kind, 'forked', `Direct P1 fork settled as ${directOutcome.kind}`)
      const hostChild = childSnapshot(host, hostOutcome.ok ? hostOutcome.childId : '')
      const directChild = childSnapshot(host, directOutcome.kind === 'forked' ? directOutcome.handle.session.id : '')
      const { hostEvents, inheritedEventCount } = assertChildrenParity(
        host, hostChild, directChild, SOURCES.p1Host, SOURCES.p1Direct,
        { cwd: anchorDir, inheritedEventCount: anchor + 1 },
      )
      assert.ok(hostEvents.length > inheritedEventCount + 1,
        'the mid-turn cut must receive child-owned repair beyond the marker')
      const repair = hostEvents.slice(inheritedEventCount + 1)
      assert.deepEqual(repair.map(event => event.type), ['tool/result', 'step/end', 'turn/end'],
        'the official fork repair shape diverged')
      assert.equal(repair[0]?.data.message.toolCallId, 'call-p1')
      assert.equal(repair[0]?.data.message.isError, true)
      assert.equal(repair[0]?.data.error.code, 'TOOL_OUTCOME_UNKNOWN')
      assert.deepEqual(repair[2]?.data.reason, { kind: 'forked' })
      assert.ok(workspaceMembership().includes(String(hostChild.header.id)), 'Host P1 child missed the workspace')
      assert.ok(workspaceMembership().includes(String(directChild.header.id)), 'Direct P1 child missed the workspace')
      scenarios.p1ExactMidTurn = { status: 'covered', boundarySeq: anchor }
    }

    // P2 — exact turn/end cut.
    {
      const anchor = boundarySeq.p2.direct
      assert.equal(boundarySeq.p2.host, anchor, 'P2 sources must be structurally identical')
      const hostOutcome = await hostFork(SOURCES.p2Host, anchor)
      const directOutcome = await directFork(SOURCES.p2Direct, anchor)
      assert.equal(hostOutcome.ok, true, `Host P2 fork failed: ${JSON.stringify(hostOutcome)}`)
      assert.equal(directOutcome.kind, 'forked')
      const hostChild = childSnapshot(host, hostOutcome.ok ? hostOutcome.childId : '')
      const directChild = childSnapshot(host, directOutcome.kind === 'forked' ? directOutcome.handle.session.id : '')
      assertChildrenParity(host, hostChild, directChild, SOURCES.p2Host, SOURCES.p2Direct,
        { cwd: anchorDir, inheritedEventCount: anchor + 1, childEventCount: anchor + 2 })
      scenarios.p2ExactTurnEnd = { status: 'covered', boundarySeq: anchor }
    }

    // P3 — nonexistent explicit seq rejects on both paths, no fallback.
    {
      const hostOutcome = await hostFork(SOURCES.p2Host, 999)
      const directOutcome = await directFork(SOURCES.p2Direct, 999)
      assert.equal(hostOutcome.ok, false)
      if (!hostOutcome.ok) assert.equal(hostOutcome.code, 'session/fork-unavailable')
      assert.equal(directOutcome.kind, 'rejected', 'Direct must reject a nonexistent explicit seq')
      if (directOutcome.kind === 'rejected') {
        assert.equal(directOutcome.error.code, 'session/fork-unavailable')
      }
      scenarios.p3NonexistentSeq = { status: 'covered', code: 'session/fork-unavailable' }
    }

    // P4 — omitted cut includes the standalone stable tail event.
    {
      const hostOutcome = await hostFork(SOURCES.p4Host)
      const directOutcome = await directFork(SOURCES.p4Direct)
      assert.equal(hostOutcome.ok, true, `Host P4 fork failed: ${JSON.stringify(hostOutcome)}`)
      assert.equal(directOutcome.kind, 'forked')
      const hostChild = childSnapshot(host, hostOutcome.ok ? hostOutcome.childId : '')
      const directChild = childSnapshot(host, directOutcome.kind === 'forked' ? directOutcome.handle.session.id : '')
      const { hostEvents } = assertChildrenParity(host, hostChild, directChild, SOURCES.p4Host, SOURCES.p4Direct,
        { cwd: anchorDir })
      assert.equal(hostEvents.at(-2)?.type, 'session/title',
        'the omitted cut must include the standalone post-turn title event')
      assert.equal(Number(hostChild.inheritedEventCount), boundarySeq.p4.host + 2,
        'the omitted boundary extends through the standalone tail event')
      scenarios.p4StandaloneTail = { status: 'covered' }
    }

    // P5 — omitted cut excludes queued input; continuation never executes it.
    // P8 — both children activate the Host current default (no session-local
    // selection exists in these sources).
    {
      const hostOutcome = await hostFork(SOURCES.p5Host)
      const directOutcome = await directFork(SOURCES.p5Direct)
      assert.equal(hostOutcome.ok, true, `Host P5 fork failed: ${JSON.stringify(hostOutcome)}`)
      assert.equal(directOutcome.kind, 'forked')
      const hostChildId = hostOutcome.ok ? hostOutcome.childId : ''
      const directChildId = directOutcome.kind === 'forked' ? directOutcome.handle.session.id : ''
      const hostChild = childSnapshot(host, hostChildId)
      const directChild = childSnapshot(host, directChildId)
      const { hostEvents, directEvents } = assertChildrenParity(host, hostChild, directChild,
        SOURCES.p5Host, SOURCES.p5Direct, { cwd: anchorDir })
      assert.equal(Number(hostChild.inheritedEventCount), boundarySeq.p5.host + 1,
        'the omitted boundary must stop at the turn/end before the queued input')
      for (const [label, events] of [['Host', hostEvents], ['Direct', directEvents]]) {
        assert.equal(events.at(-1)?.type, 'session/end-seed',
          `${label} child must end at the marker with no queued input inherited`)
        assert.equal(events.some(event => event.type === 'user/message'
          && event.data.content.some(block => block.type === 'text' && block.text === 'queued future input')), false,
          `${label} child must not inherit the parent's queued future input`)
      }

      // Continue BOTH children with "C" through their live Agents.
      const hostAgent = host.ctx.agents.get(SessionId(hostChildId))
      const directAgent = directOutcome.kind === 'forked' ? directOutcome.handle.direct.agent : undefined
      assert.ok(hostAgent !== undefined, 'the Host fork child has no live Agent to prompt')
      assert.ok(directAgent !== undefined, 'the Direct fork child has no live Agent to prompt')
      const probe = () => createUserMessage({
        content: [{ type: 'text', text: 'C' }],
        source: { kind: 'user' },
      })
      const hostEndsBefore = hostChild.snapshotEvents().filter(event => event.type === 'turn/end').length
      const directEndsBefore = directChild.snapshotEvents().filter(event => event.type === 'turn/end').length
      hostAgent.followup(probe())
      directAgent.followup(probe())
      await waitFor('the Host P5 child turn to complete', () =>
        hostChild.snapshotEvents().filter(event => event.type === 'turn/end').length > hostEndsBefore ? true : undefined)
      await waitFor('the Direct P5 child turn to complete', () =>
        directChild.snapshotEvents().filter(event => event.type === 'turn/end').length > directEndsBefore ? true : undefined)

      for (const [label, child] of [['Host', hostChild], ['Direct', directChild]]) {
        const events = child.snapshotEvents()
        const userTexts = events.filter(event => event.type === 'user/message')
          .map(event => event.data.content.filter(block => block.type === 'text').map(block => block.text).join(''))
        assert.deepEqual(userTexts, ['prompt 1', 'C'],
          `${label} child model-visible user history must be the inherited prompt plus "C", never the queued input`)
        const header = events.find(event => event.type === 'request/header')?.data.header.config
        assert.ok(header !== undefined, `${label} child assembled no first request header`)
        assert.deepEqual({ provider: header.provider, model: header.model }, { provider: PROVIDER, model: MODEL },
          `${label} child must activate the Host current default`)
      }
      scenarios.p5QueuedInputExcluded = { status: 'covered' }
      scenarios.p8ActivationDefault = { status: 'covered', default: { provider: PROVIDER, model: MODEL } }
    }

    // P7 — subagent source: nearest-ancestor workspace, ordinary child header.
    {
      assert.equal(subagentMembership().includes(SOURCES.p7Host), false)
      assert.equal(subagentMembership().includes(SOURCES.p7Direct), false)
      const hostOutcome = await hostFork(SOURCES.p7Host)
      const directOutcome = await directFork(SOURCES.p7Direct)
      assert.equal(hostOutcome.ok, true, `Host P7 fork failed: ${JSON.stringify(hostOutcome)}`)
      assert.equal(directOutcome.kind, 'forked')
      const hostChildId = hostOutcome.ok ? hostOutcome.childId : ''
      const directChildId = directOutcome.kind === 'forked' ? directOutcome.handle.session.id : ''
      const hostChild = childSnapshot(host, hostChildId)
      const directChild = childSnapshot(host, directChildId)
      assertChildrenParity(host, hostChild, directChild, SOURCES.p7Host, SOURCES.p7Direct, { cwd: subagentDir })
      assert.equal(subagentMembership().includes(hostChildId), true,
        'Host child must inherit the nearest ancestor workspace')
      assert.equal(subagentMembership().includes(directChildId), true,
        'Direct child must inherit the nearest ancestor workspace')
      scenarios.p7SubagentWorkspace = { status: 'covered', workspaceId: subagentWorkspace.id }
    }

    console.log(JSON.stringify({ ok: true, scenarios }))
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
  console.error(`DSH_REMOTE_D2_4_FORK_PARITY_FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
