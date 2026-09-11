#!/usr/bin/env node
/**
 * D1.1 integration smoke over the published rc1 official Client faces.
 *
 * The browser-facing Client packages are module-loader chunks rather than
 * Node modules, so this harness installs the same tiny loader boundary that a
 * web page provides. The fixture RPC is still the official Connection fixture;
 * Connection, API Gateway, generated Remote contributions, and Session
 * Controller Client are all real package implementations. No TUI production
 * runner or Remote write path is mounted.
 *
 * @module dsh-remote-session-read-smoke
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import { RemoteSessionReader } from '../src/runtime/remote/session-reader-remote.ts'

const PACKAGE_IDS = {
  connection: '@deepseek-ai/dsh-client-connection',
  gateway: '@deepseek-ai/dsh-api-gateway',
  session: '@deepseek-ai/dsh-api-session-controller',
}

const WRITE_ENDPOINTS = new Set([
  'session/create',
  'session/prompt',
  'session/fork',
  'session/rename',
  'session/selectModel',
  'session/selectPreset',
  'session/setPreset',
  'session/updateQueue',
  'session/cancel',
  'session/command',
  'session/steer',
  'session/followUp',
  'session/attachment',
  'session/open',
  'session/openWorkspacePath',
  'command/execute',
  'commands/execute',
  'subagent/prompt',
  'subagents/prompt',
  'subagents/interruptByParent',
  'approval/respond',
  'question/respond',
  'interaction/respond',
  'interaction/cancel',
  '$events/result',
  'directoryPicker/createDirectory',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'goals/complete',
  'goals/clear',
  'agentPresets/select',
  'agentPresets/copy',
  'agentPresets/deletePreset',
  'credentials/set',
  'credentials/unset',
  'settings/openSettingsDocument',
  'settings/openAgentPresetDirectory',
  'settings/update',
  'settings/replace',
  'settings/mutate',
  'workspace/create',
  'workspace/rename',
  'workspace/delete',
  'workspace/insertBefore',
  'workspace/insertSessionBefore',
  'workspace/archiveSession',
])

function installModuleLoader() {
  const nodeRequire = createRequire(import.meta.url)
  const modules = new Map()
  const previousWindow = globalThis.window
  const previousLocation = globalThis.location
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
  globalThis.location = { hostname: 'localhost', search: '?fixture' }
  return {
    modules,
    restore() {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
      if (previousLocation === undefined) delete globalThis.location
      else globalThis.location = previousLocation
    },
  }
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function durableSeqsFromWindow(window) {
  return window.entries
    .filter(entry => entry.type === 'event')
    .map(entry => entry.event.seq)
}

function durableSeqs(eventSource) {
  return durableSeqsFromWindow(eventSource.getSnapshot())
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains a duplicate durable event`)
}

function assertContiguous(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    assert.equal(values[index], values[index - 1] + 1, `${label} has a durable history gap`)
  }
}

async function main() {
  const loader = installModuleLoader()
  let context
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

    context = new Context()
    await context.plugin(TypertRegistry)
    await context.plugin(connectionClient)
    await context.plugin(gatewayClient)
    for (const contribution of [commandsRemote, subagentsRemote, sessionRemote]) {
      await context.remote.$mount(contribution)
    }
    // D1.1 deliberately does not mount a Client file-write capability.
    context.provide('fileUpload', { available: false })
    await context.plugin(sessionClient)

    await waitFor(
      () => context.connection.generation.getSnapshot() !== undefined
        && context.sessions.list.getSnapshot().phase === 'ready',
      'official Connection generation and Session list readiness',
    )

    const rpc = context.connection.rpc
    const writes = []
    let followOpens = 0
    const recordMutation = endpoint => {
      if (WRITE_ENDPOINTS.has(endpoint)) writes.push(endpoint)
    }
    const originalCall = rpc.call
    rpc.call = function (...args) {
      recordMutation(args[1])
      return originalCall.apply(rpc, args)
    }
    const originalOpen = rpc.open
    if (typeof originalOpen === 'function') {
      rpc.open = function (...args) {
        if (args[1] === 'session/follow') followOpens += 1
        recordMutation(args[1])
        return originalOpen.apply(rpc, args)
      }
    }

    const reader = new RemoteSessionReader(context.sessions, context.connection.generation)
    const rows = await reader.list(undefined)
    assert.ok(rows !== undefined, 'official generation must produce a Remote list')
    const listedIds = context.sessions.list.getSnapshot().ids
    assert.deepEqual(rows.map(row => row.id), listedIds, 'Remote list must use official ids order')
    assert.ok(rows.length > 0, 'fixture must provide Session rows')
    assert.ok(rows.every(row => typeof row.updatedAt === 'number'))
    assert.ok(rows.every(row => !Object.hasOwn(row, 'createdAt')), 'Remote rows must not invent createdAt')

    const projections = await reader.projectionBatch(rows)
    assert.equal(projections.get('fx-alpha')?.title, 'Fixture 历史会话')
    const search = await reader.search('fixture')
    assert.ok(search !== undefined && search.items.length > 0, 'official Session search must return fixture hits')
    const emptySearch = await reader.search('definitely-not-in-fixture')
    assert.deepEqual(emptySearch, { items: [], hasMore: false })

    // Opening and paging the binding exercises the official Session object,
    // event window, and loadOlder contract without changing production state.
    const sessionId = listedIds[0]
    assert.ok(sessionId !== undefined)
    context.sessions.open(sessionId)
    const binding = context.sessions.binding(sessionId)
    assert.ok(binding !== undefined, 'official Session binding missing')
    await waitFor(() => binding.session.getSnapshot().openState === 'open', 'initial official Session history window')
    const initialSeqs = durableSeqs(binding.eventSource)
    assert.ok(initialSeqs.length > 0)
    assert.ok(binding.eventSource.getSnapshot().hasMore, 'fixture history must expose an older page')
    await binding.session.loadThrough(initialSeqs.at(-1))
    assert.deepEqual(durableSeqs(binding.eventSource), initialSeqs, 'loadThrough must preserve an already-covered window')
    await binding.session.loadOlder()
    const pagedSeqs = durableSeqs(binding.eventSource)
    assert.ok(pagedSeqs.length > initialSeqs.length, 'loadOlder must extend the official durable window')
    assertUnique(pagedSeqs, 'paged history')
    assertContiguous(pagedSeqs, 'paged history')

    // A real Connection reconnect replaces the generation. The Session Client
    // owns stream recovery and baseline repair; this smoke only observes it.
    const oldGeneration = context.connection.generation.getSnapshot()
    assert.ok(oldGeneration !== undefined)
    const listBeforeReconnect = context.sessions.list.getSnapshot()
    const historyBeforeReconnect = binding.eventSource.getSnapshot()
    const followOpensBeforeReconnect = followOpens
    const fixtureTiming = globalThis.__fxTiming
    assert.ok(typeof fixtureTiming?.breakStreams === 'function', 'fixture stream timing hook missing')
    context.connection.reconnect()
    await waitFor(
      () => context.connection.generation.getSnapshot() === undefined,
      'official Connection generation loss',
    )
    // The fixture's stream-break hook is the documented way to exercise the
    // Gateway-owned follow recovery path; reconnect alone only repairs the
    // Connection generation and does not close an already-open journal.
    fixtureTiming.breakStreams()
    await waitFor(
      () => {
        const nextGeneration = context.connection.generation.getSnapshot()
        return nextGeneration !== undefined && nextGeneration.id !== oldGeneration.id
      },
      'official Connection generation replacement',
    )
    await waitFor(
      () => {
        const snapshot = context.sessions.list.getSnapshot()
        return snapshot !== listBeforeReconnect && snapshot.phase === 'ready'
      },
      'replaced Session list snapshot after reconnect',
    )
    await waitFor(
      () => followOpens > followOpensBeforeReconnect,
      'reopened official session/follow stream after reconnect',
    )
    await waitFor(
      () => {
        const snapshot = binding.eventSource.getSnapshot()
        return snapshot !== historyBeforeReconnect
          && snapshot.revision !== historyBeforeReconnect.revision
          && snapshot.entries.length > 0
      },
      'replaced Session history baseline after reconnect',
    )
    const historyAtGeneration = binding.eventSource.getSnapshot()
    assert.ok(historyAtGeneration.hasMore, 'reconnected Session must retain an older page')
    const recoveredTailSeqs = durableSeqsFromWindow(historyAtGeneration)
    assert.deepEqual(recoveredTailSeqs, initialSeqs, 'reconnect must publish the official tail baseline without gaps')
    assertUnique(recoveredTailSeqs, 'reconnected history tail')
    assertContiguous(recoveredTailSeqs, 'reconnected history tail')

    const historyBeforeReconnectLoadOlder = binding.eventSource.getSnapshot()
    await binding.session.loadOlder()
    await waitFor(
      () => {
        const snapshot = binding.eventSource.getSnapshot()
        return snapshot !== historyBeforeReconnectLoadOlder
          && snapshot.revision !== historyBeforeReconnectLoadOlder.revision
      },
      'post-reconnect loadOlder history snapshot',
    )
    const historyAfterReconnectRead = binding.eventSource.getSnapshot()
    const reconnectedPagedSeqs = durableSeqsFromWindow(historyAfterReconnectRead)
    assert.ok(reconnectedPagedSeqs.length > recoveredTailSeqs.length, 'loadOlder must remain usable after reconnect')
    assert.deepEqual(reconnectedPagedSeqs, pagedSeqs, 'post-reconnect paging must restore every previously loaded durable event')
    assertUnique(reconnectedPagedSeqs, 'post-reconnect paged history')
    assertContiguous(reconnectedPagedSeqs, 'post-reconnect paged history')

    // Exercise the official jump loader with a target outside the current
    // window. This may exhaust the fixture history; no later paging assertion
    // depends on `hasMore` remaining true.
    const jumpTarget = reconnectedPagedSeqs[0] - 1
    assert.ok(jumpTarget >= 0)
    const historyBeforeLoadThrough = binding.eventSource.getSnapshot()
    await binding.session.loadThrough(jumpTarget)
    await waitFor(
      () => {
        const snapshot = binding.eventSource.getSnapshot()
        return snapshot !== historyBeforeLoadThrough
          && snapshot.revision !== historyBeforeLoadThrough.revision
      },
      'official loadThrough history snapshot',
    )
    const historyAfterLoadThrough = binding.eventSource.getSnapshot()
    const jumpedSeqs = durableSeqsFromWindow(historyAfterLoadThrough)
    assert.ok(jumpedSeqs.length > reconnectedPagedSeqs.length, 'loadThrough must extend the official durable window')
    assert.deepEqual(jumpedSeqs.slice(-reconnectedPagedSeqs.length), reconnectedPagedSeqs, 'loadThrough must preserve the paged durable suffix')
    assert.ok(jumpedSeqs.includes(jumpTarget), 'loadThrough must include its requested target')
    assertUnique(jumpedSeqs, 'loadThrough history')
    assertContiguous(jumpedSeqs, 'loadThrough history')

    assert.deepEqual(writes, [], 'RemoteSessionReader must not call an official Session write endpoint')
    console.log(`dsh remote session read smoke passed: ${String(rows.length)} rows, ${String(pagedSeqs.length)} paged events, generation ${String(oldGeneration.id)} -> ${String(context.connection.generation.getSnapshot()?.id)}`)
  } finally {
    if (context !== undefined) await context.fiber.dispose()
    loader.restore()
  }
}

main().catch(error => {
  console.error(`DSH_REMOTE_SESSION_READ_SMOKE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
