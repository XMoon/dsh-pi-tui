#!/usr/bin/env node
/**
 * D1.1 integration smoke over the published 0.1.7-alpha.2 official Client
 * faces.
 *
 * The browser-facing Client packages are module-loader chunks rather than
 * Node modules, so this harness installs the same tiny loader boundary that a
 * web page provides. 0.1.6 removed the production query-selected fixture
 * transport from `dsh-client-connection`; the carrier is now an explicit
 * `ClientTransportHooks` (or the page's `__DSH_TRANSPORT__` global). This smoke
 * installs the official `@deepseek-ai/dsh-remote-mock` carrier face as
 * `__DSH_TRANSPORT__.rpc`, so Connection, API Gateway, the generated Remote
 * contributions, the Session Controller Client and the TUI RemoteSessionReader
 * are all REAL package implementations over a mock Host carrier. No TUI
 * production runner or Remote write path is mounted.
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
import { RemoteMock, ok, openStream } from '@deepseek-ai/dsh-remote-mock'
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

const SESSION_ID = 'fx-alpha'
const SESSION_TITLE = 'Fixture 历史会话'
const SESSION_PRESET = 'fixture-preset'
const SESSION_CWD = '/tmp/dsh-d1-1-fixture'
const SESSION_FORMAT_VERSION = 4
/** The second list row: a `sequenced` projection-hint fixture (attached-registry
 * sequence space) that stays list-only — never retained or opened. */
const SEQUENCED_ID = 'fx-sequenced-hint'

/** One fixture turn cycle: turn/start, user/message, assistant/message, turn/end. */
const TURN_EVENTS = 4
/** Durable events in the fixture log. The alpha.2 Client pages history with
 * `maxMessages: 500` (plus a turn window), so the log must stay deep enough
 * that one `loadOlder`/jump page never exhausts it. */
const LOG_EVENTS = 1200
/** Records in the opening `session/follow` window (the log tail). */
const TAIL_RECORDS = 20

/** One history record as the Host wire carries it. */
function record(seq, type, data, surfaceOp) {
  return {
    type: 'event',
    event: {
      type,
      seq,
      time: 1_700_000_000_000 + seq,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    },
  }
}

/** The contiguous fixture log: every seq carries a durable `event` record. */
function fixtureLog() {
  const records = []
  for (let seq = 0; seq < LOG_EVENTS; seq += 1) {
    const turn = Math.floor(seq / TURN_EVENTS)
    const phase = seq % TURN_EVENTS
    if (phase === 0) records.push(record(seq, 'turn/start', { turn }))
    else if (phase === 1) {
      records.push(record(seq, 'user/message', {
        id: `fx-user-${seq}`,
        role: 'user',
        content: [{ type: 'text', text: `fixture needle ${seq}` }],
        source: { kind: 'user' },
      }, 'append'))
    } else if (phase === 2) {
      records.push(record(seq, 'assistant/message', {
        turn,
        step: 0,
        message: {
          id: `fx-assistant-${seq}`,
          role: 'assistant',
          content: [{ type: 'text', text: `fixture reply ${seq}` }],
          source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        },
        stream: [],
      }, 'append'))
    } else records.push(record(seq, 'turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return records
}

const LOG = fixtureLog()
const TAIL = LOG.slice(-TAIL_RECORDS)
const TAIL_CURSOR = TAIL.at(-1).event.seq

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
  globalThis.location = { hostname: 'localhost', origin: 'http://dsh-fixture.local', search: '' }
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

/** The official mock carrier table for the D1 read surface. */
function fixtureMock() {
  const mock = RemoteMock.create({ host: { home: SESSION_CWD } })
  mock.unary('session/list', () => ok({
    items: [{
      sessionId: SESSION_ID,
      updatedAt: 1_700_000_000_000,
      running: false,
      blank: false,
      cwd: SESSION_CWD,
      projections: {
        // A cold/list-cache hint: the watermark belongs to the cache record's
        // own sequence space, so the official Client applies it as `cached`.
        kind: 'cached',
        asOfSeq: TAIL_CURSOR,
        values: { title: SESSION_TITLE, agentPreset: SESSION_PRESET },
      },
    }, {
      sessionId: SEQUENCED_ID,
      // Lower updatedAt keeps the primary fixture row first in the official
      // ids order, so the history/open path below is unchanged.
      updatedAt: 1_699_000_000_000,
      running: false,
      blank: false,
      cwd: SESSION_CWD,
      projections: {
        // The other official union member: a live projection registry block
        // in the attached Session's sequence space.
        kind: 'sequenced',
        asOfSeq: 0,
        values: { title: 'Sequenced projection hint', agentPreset: 'sequenced-preset' },
      },
    }],
  }))
  // The generated Remote proxy wraps a one-object request as `{ request }`.
  // Content search matches a whitespace-delimited token of a fixture message,
  // the way the Host's full-text index does (so a hyphenated non-token misses).
  mock.unary('session/search', (args) => {
    const request = args?.request ?? args
    const query = String((typeof request === 'string' ? request : request?.query) ?? '').trim().toLowerCase()
    const hit = query !== '' && LOG.some(entry => {
      const text = entry.event.data?.content?.[0]?.text
      return typeof text === 'string' && text.toLowerCase().split(/\s+/).includes(query)
    })
    return ok(hit
      ? { items: [{ sessionId: SESSION_ID, snippet: 'fixture needle' }], hasMore: false }
      : { items: [], hasMore: false })
  })
  // One contiguous backwards page: the newest `maxMessages` records strictly
  // before the requested cursor, with `hasMore` reporting any older remainder.
  mock.unary('session/page', (args) => {
    const request = args?.request ?? args
    const beforeSeq = request?.beforeSeq ?? request?.throughSeq ?? TAIL_CURSOR + 1
    const maxMessages = typeof request?.maxMessages === 'number' ? request.maxMessages : 50
    const before = LOG.filter(entry => entry.event.seq < beforeSeq)
    const page = before.slice(-maxMessages)
    return ok({ records: page, hasMore: before.length > page.length })
  })
  mock.unary('subagents/list', () => ok({ entries: [], parentAvailable: true }))
  mock.stream('session/control', openStream([{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }]))
  mock.stream('session/follow', (_args, stream) => {
    stream.push({
      type: 'snapshot',
      header: { version: SESSION_FORMAT_VERSION, id: SESSION_ID, createdAt: 0, cwd: SESSION_CWD, isSeeded: false },
      cursor: TAIL_CURSOR,
      records: TAIL,
      hasMore: true,
      projections: { asOfSeq: TAIL_CURSOR, values: {} },
      assistantStream: { revision: 0 },
    })
  })
  return mock
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
  const mock = fixtureMock()
  globalThis.__DSH_TRANSPORT__ = { rpc: mock.rpc }
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

    const reader = new RemoteSessionReader(context.sessions, context.connection.generation)
    const rows = await reader.list(undefined)
    assert.ok(rows !== undefined, 'official generation must produce a Remote list')
    const listedIds = context.sessions.list.getSnapshot().ids
    assert.deepEqual(rows.map(row => row.id), listedIds, 'Remote list must use official ids order')
    assert.ok(rows.length > 0, 'fixture must provide Session rows')
    assert.ok(rows.every(row => typeof row.updatedAt === 'number'))
    assert.ok(rows.every(row => !Object.hasOwn(row, 'createdAt')), 'Remote rows must not invent createdAt')

    const projections = await reader.projectionBatch(rows)
    assert.equal(projections.get(SESSION_ID)?.title, SESSION_TITLE)
    assert.equal(projections.get(SESSION_ID)?.preset, SESSION_PRESET)
    // Both official list-hint union members cross the real Client boundary:
    // the official Client merges cached and sequenced blocks itself, and the
    // TUI Remote adapter only reads the detached projection values.
    assert.equal(projections.get(SEQUENCED_ID)?.title, 'Sequenced projection hint')
    assert.equal(projections.get(SEQUENCED_ID)?.preset, 'sequenced-preset')
    const search = await reader.search('fixture')
    assert.ok(search !== undefined && search.items.length > 0, 'official Session search must return fixture hits')
    const emptySearch = await reader.search('definitely-not-in-fixture')
    assert.deepEqual(emptySearch, { items: [], hasMore: false })

    // Opening and paging the binding exercises the official Session object,
    // event window, and loadOlder contract without changing production state.
    const sessionId = listedIds[0]
    assert.ok(sessionId !== undefined)
    // alpha2: opening history is an explicit reference acquisition.
    context.sessions.retain(sessionId, { source: 'tuiMainView' })
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
    const followOpensBeforeReconnect = mock.log.streams('session/follow').length
    context.connection.reconnect()
    await waitFor(
      () => context.connection.generation.getSnapshot() === undefined,
      'official Connection generation loss',
    )
    // The journal stays open across reconnect (reconnect only repairs the
    // Connection generation), so close it to exercise the Gateway-owned
    // follow recovery that re-opens the stream for the new generation.
    mock.streams.end('session/follow')
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
      () => mock.log.streams('session/follow').length > followOpensBeforeReconnect,
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

    // Write-free guard over EVERYTHING the carrier saw: answered unary calls,
    // opened streams, AND requests that found no rule. A write attempt is a
    // failure whether or not the mock had a rule for it.
    const attempted = [
      ...mock.log.calls().map(call => call.endpoint),
      ...mock.log.streams().map(stream => stream.endpoint),
      ...mock.log.unmatched().map(miss => miss.endpoint),
    ]
    const writes = attempted.filter(endpoint => WRITE_ENDPOINTS.has(endpoint))
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
