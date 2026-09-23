#!/usr/bin/env node
/**
 * D2.2 same-Host ordinary-write smoke over the pinned official DSH
 * 0.1.6-alpha.2 Host and Client contracts.
 *
 * One Host Context owns a real live Agent (production AgentLoop + an in-process
 * stub LLM route), Session projections, session-title, commands, subagents,
 * Session Controller, Gateway, and forwarded-event source. An independent
 * official Client Context reaches the same Host through the official
 * Connection/Gateway carrier. Every ordinary write is then driven through
 * `ClientSessions.binding(id).session` (the official SessionFace) by the D2.2
 * Remote adapters, and the Host-authoritative effect is asserted through the
 * Remote readers and the official snapshots.
 *
 * No external network and no real provider: the only model route is the
 * in-process `SmokeAdapter` registered on the Host LlmRuntime.
 *
 * @module dsh-remote-d2-write-smoke
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import SessionTitleService, { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { RemoteHostCommandPort } from '../src/runtime/remote/host-command-remote.ts'
import { RemotePendingInputReader } from '../src/runtime/remote/pending-input-reader-remote.ts'
import { RemoteSessionWriter } from '../src/runtime/remote/session-writer-remote.ts'
import { RemoteSubagentPort } from '../src/runtime/remote/subagent-remote.ts'
import { RemoteSubmissionPresentation } from '../src/submission-presentation.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

const SESSION_ID = 'd2-2-write-session'
const PROVIDER = 'smoke'
const MODEL = 'smoke'

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png']),
})

/**
 * In-process stub LLM route. Parent turns hang until cancelled so queue/steer
 * admission is observable; every other session streams one plain text turn.
 *
 * `parentCalls` counts ACTUAL parent `stream()` entries. That is the only
 * reliable "the current turn reached its hanging model call" signal: an Agent's
 * `running` status spans the whole driver drain interval across consecutive
 * queued turns, so it can still be true while a turn boundary is claiming
 * inbox rows.
 */
class SmokeAdapter extends LlmAdapter {
  constructor(parentSessionId) {
    super()
    this.parentSessionId = parentSessionId
    this.parentCalls = 0
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    if (options.sessionId === this.parentSessionId) {
      this.parentCalls += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'working' }
      await new Promise((_resolve, reject) => {
        const signal = options.signal
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return
    }
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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-d2-2-write.local', search: '' }
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
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('webServer', {
    registerUpgrade: () => () => {},
  })
}

/** Register the fixture Host command and its staged-file receipt resolver. */
function registerFixtureCommands(ctx, observed) {
  ctx.get('commands').register({
    name: 'smoke-echo',
    description: 'Echoes the full invocation line and its admitted attachments',
    input: { hint: '<text>', attachments: true },
    handler: invocation => {
      observed.invocations.push({
        rawInput: invocation.rawInput,
        attachments: invocation.attachments,
        signalAborted: invocation.signal.aborted,
      })
      return { kind: 'success', text: 'ok' }
    },
  })
  ctx.get('commands').registerFileReceiptResolver((_agent, receiptId) => {
    if (receiptId !== FIXTURE_RECEIPT_ID) return undefined
    return {
      attachmentId: FIXTURE_RECEIPT_ID,
      name: 'notes.txt',
      bytes: 5,
    }
  })
}

const FIXTURE_RECEIPT_ID = 'receipt-notes-txt'

async function createHost() {
  const ctx = new Context()
  const observed = { invocations: [] }
  const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-d2-2-write-'))
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

    const adapter = new SmokeAdapter(SessionId(SESSION_ID))
    ctx.llm.registerAdapter([PROVIDER], adapter)
    registerFixtureCommands(ctx, observed)

    const agent = await loop.create(SessionId(SESSION_ID), { provider: PROVIDER, model: MODEL }, { cwd: '/tmp/dsh-d2-2-write' })
    return { ctx, agent, adapter, observed, persistenceRoot, persistenceFiber }
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
        : new Request(new URL(String(input), 'http://dsh-d2-2-write.local'), init)
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

/** Two-phase serializer for the smoke's plain `{ text }` prepared value:
 * cheap preflight before the official echo, content serialization after. */
const promptSerializer = {
  preflight: prepared => ({ kind: 'ok', echo: { text: prepared.text, attachments: [] } }),
  serialize: async prepared => ({
    kind: 'ok',
    content: [{ type: 'text', text: prepared.text }],
  }),
}

async function main() {
  const scenarios = {}
  const loader = installModuleLoader()
  const fetchLog = []
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
    globalThis.__DSH_TRANSPORT__ = hostTransport(host, fetchLog)

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
    await waitFor('the fixture session to be listed', () => sessions.list.getSnapshot().ids.includes(SESSION_ID))

    // alpha2: a binding exists only while a reference is retained, so the
    // TUI's visible owner holds the fixture Session explicitly. There is no
    // Client-global selection slot to move.
    const owner = sessions.retain(SESSION_ID, { source: 'tuiMainView' })
    const binding = sessions.binding(SESSION_ID)
    assert.ok(binding !== undefined, 'the retained fixture session has no official Client binding')
    assert.equal(binding, owner.binding, 'the visible owner must hold the exact borrowed generation')

    // Every later acquisition by the D2.2 write path must be a bounded
    // `tuiOperation` pin — never a visible-surface acquisition, and never a
    // cold materialization for a different Session.
    const writeAcquisitions = []
    const realRetain = sessions.retain.bind(sessions)
    sessions.retain = (target, options) => {
      writeAcquisitions.push({ id: String(target), source: options.source })
      return realRetain(target, options)
    }

    // Capture the official requestId each beginSubmission mints by shadowing
    // the one verb on the real face, so the writer keeps using the EXACT
    // official binding generation (alpha2 fences on binding identity).
    const mintedRequestIds = []
    const realBeginSubmission = binding.session.beginSubmission.bind(binding.session)
    binding.session.beginSubmission = (input) => {
      const handle = realBeginSubmission(input)
      mintedRequestIds.push(handle.requestId)
      return handle
    }
    const writer = new RemoteSessionWriter(sessions, connection.generation, promptSerializer)
    const pendingInput = new RemotePendingInputReader(sessions, connection.generation)
    const presentation = new RemoteSubmissionPresentation(sessions, connection.generation)
    const commandPort = new RemoteHostCommandPort(client.remote.commands)
    const subagentPort = new RemoteSubagentPort(client.remote.subagents)

    const queueSnapshot = () => pendingInput.snapshot(SESSION_ID)
    const queueItemByRpc = rpcId => queueSnapshot()?.items.find(item => item.rpcId === rpcId)
    const echoByRpc = rpcId => presentation.snapshot(SESSION_ID)?.find(item => item.requestId === rpcId)
    const lastRequestId = () => mintedRequestIds.at(-1)

    // A live, hanging turn is the precondition for both queued and steering
    // admission. The anchor is fixture setup on the Host, not a write under test.
    host.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'anchoring turn' }],
      source: { kind: 'user' },
    }))
    await waitFor('the fixture Agent to start its anchoring turn', () => host.agent.status === 'running')

    // Scenario 1: queue prompt while running -> authoritative queued occurrence
    // carrying the official beginSubmission requestId, and the echo retires.
    {
      const outcome = await writer.prompt(SESSION_ID, { text: 'queued one' }, 'queue')
      assert.deepEqual(outcome, { kind: 'committed', value: undefined })
      const requestId = lastRequestId()
      assert.ok(typeof requestId === 'string' && requestId !== '', 'beginSubmission minted no requestId')
      const item = await waitFor('the queued occurrence to reach the pending-input projection', () => queueItemByRpc(requestId))
      assert.equal(item.placement, 'queued')
      assert.equal(queueSnapshot().running, true)
      assert.equal(item.content[0].text, 'queued one')
      await waitFor('the official submission echo to retire', () => echoByRpc(requestId) === undefined)
      assert.equal(host.agent.inbox.nextTurn.some(message => message.id === item.id), true)
      scenarios.queuePrompt = { status: 'covered', requestId, placement: item.placement }
    }

    // Scenario 2: steer prompt while running -> next-step steering, never queued.
    {
      const outcome = await writer.prompt(SESSION_ID, { text: 'steer two' }, 'steer')
      assert.deepEqual(outcome, { kind: 'committed', value: undefined })
      const requestId = lastRequestId()
      const item = await waitFor('the steering occurrence to reach the pending-input projection', () => queueItemByRpc(requestId))
      assert.equal(item.placement, 'steering')
      const snapshot = queueSnapshot()
      assert.equal(snapshot.items.some(candidate => candidate.rpcId === requestId && candidate.placement === 'queued'), false)
      assert.equal(host.agent.inbox.nextStep.some(message => message.id === item.id), true)
      scenarios.steerPrompt = { status: 'covered', placement: item.placement }
    }

    // Scenario 3: remove one queued occurrence.
    {
      const promptOutcome = await writer.prompt(SESSION_ID, { text: 'remove three' }, 'queue')
      assert.equal(promptOutcome.kind, 'committed')
      const requestId = lastRequestId()
      const item = await waitFor('the removable occurrence to reach the queue', () => queueItemByRpc(requestId))
      const outcome = await writer.updateQueue(SESSION_ID, item.id, { kind: 'remove' })
      assert.deepEqual(outcome, { kind: 'committed', value: undefined })
      await waitFor('the removed occurrence to leave the queue', () => queueItemByRpc(requestId) === undefined)
      assert.equal(host.agent.inbox.nextTurn.some(message => message.id === item.id), false)
      scenarios.queueRemove = { status: 'covered', itemId: item.id }
    }

    // Scenario 4: steer one queued occurrence -> the Host moves it to next-step.
    {
      const promptOutcome = await writer.prompt(SESSION_ID, { text: 'steer four' }, 'queue')
      assert.equal(promptOutcome.kind, 'committed')
      const requestId = lastRequestId()
      const item = await waitFor('the steerable occurrence to reach the queue', () => queueItemByRpc(requestId))
      assert.equal(item.placement, 'queued')
      const outcome = await writer.updateQueue(SESSION_ID, item.id, { kind: 'steer' })
      assert.deepEqual(outcome, { kind: 'committed', value: undefined })
      const steered = await waitFor('the queue item to settle on steering placement', () => {
        const candidate = queueItemByRpc(requestId)
        return candidate?.placement === 'steering' ? candidate : undefined
      })
      assert.equal(steered.placement, 'steering')
      assert.equal(host.agent.inbox.nextStep.some(message => message.id === item.id), true)
      scenarios.queueSteer = { status: 'covered', placement: steered.placement }
    }

    // Scenario 5: edit one queued occurrence -> authoritative content changes.
    {
      const promptOutcome = await writer.prompt(SESSION_ID, { text: 'edit five' }, 'queue')
      assert.equal(promptOutcome.kind, 'committed')
      const requestId = lastRequestId()
      const item = await waitFor('the editable occurrence to reach the queue', () => queueItemByRpc(requestId))
      const outcome = await writer.updateQueue(SESSION_ID, item.id, {
        kind: 'edit',
        content: [{ type: 'text', text: 'fixed' }],
      })
      assert.deepEqual(outcome, { kind: 'committed', value: undefined })
      const edited = await waitFor('the authoritative queue content to change', () => {
        const candidate = queueItemByRpc(requestId)
        return candidate?.content?.[0]?.text === 'fixed' ? candidate : undefined
      })
      assert.equal(edited.content[0].text, 'fixed')
      const hostMessage = host.agent.inbox.nextTurn.find(message => message.id === item.id)
      assert.ok(hostMessage !== undefined, 'edited message left the Host inbox')
      assert.equal(hostMessage.content[0].text, 'fixed')

      // An edit of an occurrence that is not pending is an expected business
      // refusal, not a crash, and leaves the authoritative queue untouched.
      const missing = await writer.updateQueue(SESSION_ID, 'missing-occurrence-id', {
        kind: 'edit',
        content: [{ type: 'text', text: 'nope' }],
      })
      assert.equal(missing.kind, 'rejected')
      assert.equal(missing.error.code, 'session/queue-item-not-found')
      assert.equal(queueItemByRpc(requestId)?.content?.[0]?.text, 'fixed', 'a refused edit must not touch the queue')
      scenarios.queueEdit = { status: 'covered', itemId: item.id }
    }

    // Recorded by Scenario 6 and consumed by the recovery proof.
    let parentCallsAtCancel = 0

    // Scenario 6: cancel settles committed while queued work is preserved.
    {
      const promptOutcome = await writer.prompt(SESSION_ID, { text: 'preserve six' }, 'queue')
      assert.equal(promptOutcome.kind, 'committed')
      const requestId = lastRequestId()
      const item = await waitFor('the preserved occurrence to reach the queue', () => queueItemByRpc(requestId))
      // Latch for the recovery proof below: the resumed turn has really entered
      // its model call only once `parentCalls` advances past this value.
      parentCallsAtCancel = host.adapter.parentCalls
      const outcome = await writer.cancel(SESSION_ID)
      assert.deepEqual(outcome, { kind: 'committed', value: undefined })
      // `keepInbox: true` preserves pending work: it stays pending, or it is
      // claimed into the post-cancel turn and lands durably with its rpcId.
      const preserved = await waitFor('the queued occurrence to survive cancellation', () => {
        if (host.agent.inbox.nextTurn.some(message => message.id === item.id)) return 'pending'
        const durable = host.agent.session.snapshotEvents().some(event => event.type === 'user/message'
          && event.data.id === item.id
          && event.data.source.kind === 'user'
          && event.data.source.rpcId === requestId)
        return durable ? 'durable' : undefined
      })
      await waitFor('the cancelled turn to settle as aborted', () => host.agent.session.snapshotEvents()
        .some(event => event.type === 'turn/end' && event.data.reason?.kind === 'aborted'))
      scenarios.cancel = { status: 'covered', itemId: item.id, preserved }
    }

    // Scenario 7: rename returns the normalized title and the Session projection
    // carries the same official value.
    {
      const outcome = await writer.rename(SESSION_ID, '  spaced   title  ')
      assert.equal(outcome.kind, 'committed')
      assert.equal(outcome.value.title, 'spaced title')
      const projection = host.ctx.get('sessionProjections').snapshot(host.agent.session, ['title'])
      assert.equal(projection.values.title, outcome.value.title)
      const folded = host.ctx.get('sessionTitle').get(host.agent.session)
      assert.equal(folded.title, outcome.value.title)
      scenarios.rename = { status: 'covered', title: outcome.value.title }
    }

    // Scenario 8: Host command execution preserves the full line and the
    // admitted attachment payload; an unknown line is an unmatched admission.
    {
      const attachments = [{ type: 'file', receiptId: FIXTURE_RECEIPT_ID }]
      const outcome = await commandPort.execute({
        sessionId: SESSION_ID,
        line: '/smoke-echo full line payload',
        attachments,
        signal: new AbortController().signal,
      })
      assert.equal(outcome.kind, 'committed')
      assert.equal(outcome.matched, true)
      // `outcome.execution` IS the official `CommandExecution`; its `result`
      // slot is the normalized handler outcome and its `commandId` is the
      // lifecycle pairing id the runner consumes.
      const execution = outcome.execution
      assert.equal(typeof execution.commandId, 'string')
      assert.equal(execution.result.kind, 'success')
      assert.equal(execution.result.text, 'ok')
      assert.equal(host.observed.invocations.length, 1)
      const invocation = host.observed.invocations[0]
      assert.equal(invocation.rawInput, ' full line payload')
      assert.equal(invocation.signalAborted, false, 'the caller-owned signal was not forwarded')
      assert.equal(invocation.attachments.length, 1)
      assert.equal(invocation.attachments[0].type, 'file')
      assert.equal(invocation.attachments[0].attachment.attachmentId, FIXTURE_RECEIPT_ID)
      assert.equal(invocation.attachments[0].attachment.name, 'notes.txt')

      const unknown = await commandPort.execute({
        sessionId: SESSION_ID,
        line: '/not-a-fixture-command nope',
        attachments: [],
        signal: new AbortController().signal,
      })
      assert.deepEqual(unknown, { kind: 'committed', matched: false })
      assert.equal(host.observed.invocations.length, 1, 'unknown line reached a command handler')
      scenarios.hostCommand = { status: 'covered', matched: true, unknownMatched: false }
    }

    // Scenario 9: continuable subagent prompt + interrupt through the official
    // control Remote.
    {
      const started = await host.ctx.get('subagents').startContinuable({
        provider: 'spawn',
        label: 'd2.2 child',
        request: {
          prompt: [{ type: 'text', text: 'child seed' }],
          parent: host.agent,
        },
        signal: new AbortController().signal,
      })
      assert.ok(started.childId !== undefined, 'startContinuable returned no childId')
      const childId = String(started.childId)
      assert.notEqual(childId, SESSION_ID)
      await waitFor('the child session to be live', () => host.ctx.get('sessions').get(childId) !== undefined)

      const outcome = await subagentPort.prompt(
        {
          parentSessionId: SESSION_ID,
          childSessionId: childId,
          delivery: 'queue',
          content: [{ type: 'text', text: 'continuation prompt' }],
        },
        { makeSignal: () => new AbortController().signal },
      )
      assert.equal(outcome.kind, 'ok')
      assert.ok(outcome.messageId !== undefined, 'subagent prompt returned no messageId')

      const interrupted = await subagentPort.interrupt({
        parentSessionId: SESSION_ID,
        childSessionId: childId,
        mode: 'continuable',
      })
      assert.deepEqual(interrupted, { kind: 'committed' })
      scenarios.subagent = { status: 'covered', childId, prompt: outcome.kind, interrupt: interrupted.kind }
    }

    // Read-only gate: every ordinary write above travelled through the one
    // official carrier under the three mounted remote domains; no other domain
    // and no raw filesystem/shell endpoint was reached.
    {
      const paths = fetchLog.map(entry => entry.slice(entry.indexOf(' ') + 1))
      assert.deepEqual(
        paths.filter(path => !/^\/api\/(session|commands|subagents)\//.test(path)),
        [],
        'a request left the mounted official remote domains',
      )
      assert.deepEqual(
        paths.filter(path => /(^|\/)(fs|shell|exec|raw|upload)(\/|$)/.test(path)),
        [],
        'a raw write endpoint was called outside the official carrier',
      )
      for (const expected of [
        '/api/session/prompt',
        '/api/session/updateQueue',
        '/api/session/cancel',
        '/api/session/rename',
        '/api/commands/execute',
        '/api/subagents/prompt',
        '/api/subagents/interruptByParent',
      ]) {
        assert.ok(paths.includes(expected), `the smoke never used the official ${expected} endpoint`)
      }
      scenarios.readOnlyGate = {
        status: 'covered',
        requests: fetchLog.length,
        rawCalls: 0,
        paths: [...new Set(paths)].sort(),
      }
    }

    // Everything above was the D2.2 write path; freeze that audit before the
    // recovery proof below acquires the visible surface again.
    const writePathAcquisitions = [...writeAcquisitions]
    assert.ok(writePathAcquisitions.length > 0, 'the write path never pinned its addressed generation')
    assert.deepEqual([...new Set(writePathAcquisitions.map(entry => entry.source))], ['tuiOperation'],
      'the D2.2 write path must never acquire the visible main surface')
    assert.deepEqual([...new Set(writePathAcquisitions.map(entry => entry.id))], [SESSION_ID],
      'the D2.2 write path must never materialize another Session')
    // Pins are released: the visible owner is the only reference left.
    assert.equal(sessions.retainInfo(SESSION_ID).getSnapshot().referenceCount, 1)
    assert.deepEqual({ ...sessions.retainInfo(SESSION_ID).getSnapshot().retainedBy }, { tuiMainView: 1 })
    assert.equal(sessions.binding(SESSION_ID) !== undefined, true)
    scenarios.writeAcquisition = {
      status: 'covered',
      pins: writePathAcquisitions.length,
      retainedBy: sessions.retainInfo(SESSION_ID).getSnapshot().retainedBy,
    }

    // Durable-inbox recovery (alpha.2): the pending rows live in the official
    // DURABLE inbox projection, not in a per-generation Client cache.
    //
    // The proof needs a STABLE Host inbox first. Scenario 6 cancelled the
    // running turn with `keepInbox: true`, so the Host legitimately claims its
    // queued work while it resumes -- a `before`-count snapshot taken there is
    // NOT part of the alpha2 contract and races the Host. Wait for the resumed
    // turn to actually ENTER its model call instead (`parentCalls`, since the
    // Agent's `running` status spans consecutive queued turns): no turn/step
    // boundary can then claim anything, so the pending set is stable. Queue one fresh row so
    // that stable set is non-empty, and take the Host-authoritative pending ids
    // as the baseline.
    {
      await waitFor('the resumed post-cancel turn to enter its hanging model call', () => (
        host.adapter.parentCalls > parentCallsAtCancel ? true : undefined
      ))
      const queuedOutcome = await writer.prompt(SESSION_ID, { text: 'recover seven' }, 'queue')
      assert.equal(queuedOutcome.kind, 'committed')
      const requestId = lastRequestId()
      await waitFor('the recovery row to reach the stable Host inbox', () => (
        host.agent.inbox.nextTurn.some(message => message.source?.rpcId === requestId) ? true : undefined
      ))

      // The Host is the authority. It cannot make progress between these two
      // synchronous reads (same process, same task), so the expected id set is
      // exact -- and it stays exact because the running turn only hangs.
      const hostPendingIds = [
        ...host.agent.inbox.nextTurn.map(message => String(message.id)),
        ...host.agent.inbox.nextStep.map(message => String(message.id)),
      ].sort()
      assert.ok(hostPendingIds.length > 0, 'the stable Host inbox must carry pending rows to recover')

      const oldBinding = sessions.binding(SESSION_ID)
      assert.ok(oldBinding !== undefined, 'the fixture Session lost its visible owner before the recovery proof')
      owner.release()
      const rematerialized = sessions.retain(SESSION_ID, { source: 'tuiMainView' })
      try {
        // alpha2: the same id re-retained after a full release is a NEW generation.
        assert.notEqual(rematerialized.binding, oldBinding,
          'a same-id re-retain after release must produce a new Client generation')
        await waitFor('the re-materialized binding to open', () => (
          sessions.binding(SESSION_ID)?.session.getSnapshot().openState === 'open' ? true : undefined
        ))
        const recovered = await waitFor('the durable inbox rows to recover after re-materialization', () => {
          const snapshot = pendingInput.snapshot(SESSION_ID)
          if (snapshot === undefined) return undefined
          const ids = snapshot.items.map(item => item.id).sort()
          return ids.length === hostPendingIds.length && ids.every((id, index) => id === hostPendingIds[index])
            ? snapshot
            : undefined
        })
        assert.deepEqual(recovered.items.map(item => item.id).sort(), hostPendingIds,
          'the re-materialized generation must expose exactly the durable pending rows the Host still holds')
        scenarios.inboxRecovery = {
          status: 'covered',
          rows: recovered.items.length,
          placements: [...new Set(recovered.items.map(item => item.placement))].sort(),
          generationReplaced: rematerialized.binding !== oldBinding,
        }
      } finally {
        rematerialized.release()
      }
    }
    console.log(JSON.stringify({ ok: true, scenarios }))
  } finally {
    if (client !== undefined) await client.fiber.dispose()
    if (host !== undefined) {
      await host.ctx.fiber.dispose()
      rmSync(host.persistenceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_D2_WRITE_FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
