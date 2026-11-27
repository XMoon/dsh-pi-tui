/**
 * The Host-owned `piTuiHistorySearch` service over the REAL rc.5 official
 * Session/Inbox path, the REAL Typert Gateway and the REAL Host persistence.
 *
 * The fixture mounts the production built-in Host Runtime (which mounts the
 * service as ONE private child fiber), the production SessionController and a
 * real profile directory. Prompts enter through `sessionController.prompt()` —
 * the official durable `agent/inbox/spliced` path — never a hand-injected
 * "accepted" flag.
 *
 * Pinned here: the Owner answer identity, exact text recovery by hash, same-text
 * distinct occurrences, event-time cwd, fork inheritance, the explicit
 * loading/unavailable answers, non-Owner/aborted refusal BEFORE any official
 * query, the bounded live buffer and dispose teardown.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-history-search-host.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context, symbols } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import {
  HISTORY_SEARCH_CURSOR_MAX_BYTES,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  PI_TUI_HISTORY_SEARCH_NAMESPACE,
  parseHistoryReadTextResponse,
  parseHistorySearchResponse,
  parseHistorySessionRecallResponse,
  type HistoryReadTextRequest,
  type HistoryReadTextResponse,
  type HistorySearchRequest,
  type HistorySearchResponse,
  type HistorySessionRecallRequest,
  type HistorySessionRecallResponse,
} from '../../src/runtime/remote/pi-tui-history-search-contract.ts'
import {
  HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION,
  HistorySearchIndex,
  historyCheckpointHash,
  sessionEventHash,
  sessionHeaderHash,
  type HistoryOccurrenceInput,
} from '../../src/app/host/features/history-search-index.ts'
import {
  sourceProofBasis,
  type HistoryRevisionAuthority,
} from '../../src/app/host/features/history-search-revision-authority.ts'
import * as piTuiHostRuntime from '../../src/app/host/pi-tui-host-runtime.ts'
import {
  HISTORY_SEARCH_MAX_PENDING_EVENTS,
  HISTORY_SEARCH_READ_BATCH,
  PiTuiHistorySearchHostService,
  type HistorySearchLiveSessionLike,
  type HistorySearchPersistenceLike,
  type HistorySearchProfileContextLike,
  type HistorySearchQueryLike,
  type HistorySearchSessionsLike,
} from '../../src/app/host/features/history-search.ts'
import { normalizeHistoryCwd } from '../../src/domain/history/host-admission.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

interface HistoryHost {
  readonly host: Host
  readonly owner: PeerScope
  readonly nonOwner: PeerScope
  search(request: HistorySearchRequest, peer?: PeerScope, signal?: AbortSignal): Promise<HistorySearchResponse>
  readText(request: HistoryReadTextRequest, peer?: PeerScope, signal?: AbortSignal): Promise<HistoryReadTextResponse>
  readSessionRecall(
    request: HistorySessionRecallRequest,
    peer?: PeerScope,
    signal?: AbortSignal,
  ): Promise<HistorySessionRecallResponse>
  service(): PiTuiHistorySearchHostService
  dispose(): Promise<void>
}

async function historyHost(
  life: TestLifecycle,
  presetId: string,
  beforeHostRuntime?: (ctx: Context) => Promise<void>,
): Promise<HistoryHost> {
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    pluginManagerProfile: true,
    ...(beforeHostRuntime === undefined ? {} : { beforeHostRuntime }),
  })
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const connection = host.ctx.connection
  const owner = connection.browserPeer
  const nonOwner = connection.createPeer({ principal: { kind: 'viewer' } } as never)
  const gateway = host.ctx.typertGateway
  const invoke = async (
    method: 'search' | 'readText' | 'readSessionRecall',
    request: unknown,
    peer: PeerScope,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const result = await gateway.invoke({
      namespace: PI_TUI_HISTORY_SEARCH_NAMESPACE,
      method,
      args: { request },
      peer,
      signal,
    })
    return result
  }
  return {
    host,
    owner,
    nonOwner,
    search: async (request, peer = owner, signal = new AbortController().signal) => (
      parseHistorySearchResponse(await invoke('search', request, peer, signal))
    ),
    readText: async (request, peer = owner, signal = new AbortController().signal) => (
      parseHistoryReadTextResponse(await invoke('readText', request, peer, signal))
    ),
    readSessionRecall: async (request, peer = owner, signal = new AbortController().signal) => (
      parseHistorySessionRecallResponse(await invoke('readSessionRecall', request, peer, signal))
    ),
    service: () => host.ctx.reflect.get(PI_TUI_HISTORY_SEARCH_NAMESPACE) as PiTuiHistorySearchHostService,
    dispose: async () => {
      await nonOwner.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** Wait for the asynchronous index to leave `loading` (bounded). */
async function waitForSettled(
  wire: HistoryHost,
  request: HistorySearchRequest,
  label: string,
  timeoutMs = 20_000,
): Promise<HistorySearchResponse> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const answer = await wire.search(request)
    if (answer.kind !== 'loading' && answer.kind !== 'incomplete') return answer
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Wait for the scheduler's live/reconcile queue to settle into `ready`. */
async function waitForReady(wire: HistoryHost, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const answer = await wire.search({ scope: 'all', query: '', limit: 1 })
    if (answer.kind === 'ready') return
    if (answer.kind === 'unavailable') throw new Error(`${label}: index became unavailable: ${JSON.stringify(answer)}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Admit one prompt through the official SessionController prompt path. */
async function prompt(wire: HistoryHost, sessionId: string, requestId: string, text: string): Promise<void> {
  await promptHost(wire.host, sessionId, requestId, text)
}

/** The same official prompt path over a bare Host fixture (no Client wire). */
async function promptHost(host: Host, sessionId: string, requestId: string, text: string): Promise<void> {
  await host.ctx.sessionController.prompt({
    requestId: requestId as never,
    sessionId: SessionId(sessionId),
    mode: 'queue',
    content: [{ type: 'text', text }] as never,
  }, new AbortController().signal)
}

/** ONE authenticated Owner Gateway search over a bare Host fixture. */
async function realSearch(
  host: Host,
  owner: PeerScope,
  request: HistorySearchRequest,
): Promise<HistorySearchResponse> {
  return parseHistorySearchResponse(await host.ctx.typertGateway.invoke({
    namespace: PI_TUI_HISTORY_SEARCH_NAMESPACE,
    method: 'search',
    args: { request },
    peer: owner,
    signal: new AbortController().signal,
  }))
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A real rc.5 `SessionHeader` shape for the structural official fakes. */
function testHeader(id: string, cwd?: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_721_232_000_000,
    ...(cwd === undefined ? {} : { cwd }),
    isSeeded: false,
    ...overrides,
  }
}

/** A live registry fake that keeps ONE exact Session object per id. */
function liveRegistryMany(
  sources: readonly { live?: boolean; header: SessionHeader }[],
): HistorySearchSessionsLike {
  const cached = new Map<string, { header: SessionHeader; object: HistorySearchLiveSessionLike }>()
  const liveObject = (source: { live?: boolean; header: SessionHeader }): HistorySearchLiveSessionLike | undefined => {
    if (source.live !== true) return undefined
    const id = String(source.header.id)
    const entry = cached.get(id)
    if (entry !== undefined && entry.header === source.header) return entry.object
    const object = { id: source.header.id, header: source.header }
    cached.set(id, { header: source.header, object })
    return object
  }
  return {
    list: () => {
      const objects: HistorySearchLiveSessionLike[] = []
      for (const source of sources) {
        const object = liveObject(source)
        if (object !== undefined) objects.push(object)
      }
      return objects
    },
    get: (id) => {
      for (const source of sources) {
        const object = liveObject(source)
        if (object !== undefined && String(object.id) === id) return object
      }
      return undefined
    },
  }
}

function liveRegistry(source: { live?: boolean; header: SessionHeader }): HistorySearchSessionsLike {
  return liveRegistryMany([source])
}

test('an Owner search returns the exact accepted occurrence through the real Gateway', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-owner')
  try {
    await wire.host.harness.create(SessionId('history-s1'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-s1', 'req-1', 'hsp-owner-unique')
    const answer = await waitForSettled(wire, { scope: 'session', sessionId: 'history-s1', query: 'hsp-owner-unique', limit: 25 }, 'history occurrence')
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
    if (answer.kind !== 'ready') throw new Error('expected ready')
    assert.match(answer.generation, /^[0-9a-f-]+#\d+$/u, 'a ready answer names its index generation')
    assert.equal(answer.items.length, 1)
    const item = answer.items[0]!
    assert.equal(item.sessionId, 'history-s1')
    assert.equal(item.preview, 'hsp-owner-unique')
    assert.equal(item.contentLength, 'hsp-owner-unique'.length)
    assert.equal(item.contentSha256, sha256('hsp-owner-unique'))
    assert.equal(item.effectiveCwd, wire.host.anchorDir)
    assert.equal(item.hasNonText, false)
    // The private binding really exists on the mounted service.
    const binding = wire.service().typertRemote
    assert.equal(binding.serviceKey, PI_TUI_HISTORY_SEARCH_NAMESPACE)
    assert.equal(binding.namespace, PI_TUI_HISTORY_SEARCH_NAMESPACE)
  } finally {
    await wire.dispose()
  }
})

test('readText recovers the exact original text by content hash in bounded chunks', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-read-text')
  try {
    const content = `${'long '.repeat(40)}中文😀`
    await wire.host.harness.create(SessionId('history-read'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-read', 'req-read', content)
    const answer = await waitForSettled(wire, { scope: 'session', sessionId: 'history-read', query: 'long 中文', limit: 25 }, 'readText occurrence')
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
    if (answer.kind !== 'ready') throw new Error('expected ready')
    const item = answer.items[0]!
    assert.ok(item.preview.length <= 4096)
    assert.equal(item.contentLength, content.length)

    const parts: string[] = []
    let offset = 0
    for (let page = 0; page < 100; page += 1) {
      const chunk = await wire.readText({
        sessionId: item.sessionId,
        messageId: item.messageId,
        contentSha256: item.contentSha256,
        offset,
        limit: 7,
      })
      assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
      if (chunk.kind !== 'ready') throw new Error('expected ready')
      assert.equal(chunk.contentLength, content.length)
      parts.push(chunk.chunk)
      if (chunk.nextOffset === null) break
      assert.ok(chunk.nextOffset > offset)
      offset = chunk.nextOffset
    }
    assert.equal(parts.join(''), content)
  } finally {
    await wire.dispose()
  }
})

test('the Owner-only session-recall wire returns the bounded normalized window with official correlation', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-recall-wire')
  try {
    await wire.host.harness.create(SessionId('history-recall'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-recall', 'req-recall-1', '  hsp-recall-one 中文  ')
    await prompt(wire, 'history-recall', 'req-recall-shell', '!echo hsp-recall')
    await waitForReady(wire, 'recall wire')
    const answer = await wire.readSessionRecall({ sessionId: 'history-recall' })
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
    if (answer.kind !== 'ready') throw new Error('expected ready')
    assert.equal(answer.sessionId, 'history-recall')
    assert.deepEqual(answer.items.map(item => [item.text, item.rpcId]), [
      ['hsp-recall-one 中文', 'req-recall-1'],
    ], 'trimmed original text, shell-mode lines excluded, official rpcId preserved')
    await assert.rejects(
      wire.readSessionRecall({ sessionId: 'history-recall' }, wire.nonOwner),
      /access denied|restricted to the authenticated Owner peer/u,
    )
  } finally {
    await wire.dispose()
  }
})

test('a wrong content hash and an unknown message are distinct truthful refusals', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-read-negative')
  try {
    await wire.host.harness.create(SessionId('history-negative'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-negative', 'req-negative', 'hsp-negative-text')
    const answer = await waitForSettled(wire, { scope: 'session', sessionId: 'history-negative', query: 'hsp-negative', limit: 25 }, 'negative occurrence')
    assert.equal(answer.kind, 'ready')
    if (answer.kind !== 'ready') throw new Error('expected ready')
    const item = answer.items[0]!
    const stale = await wire.readText({
      sessionId: item.sessionId,
      messageId: item.messageId,
      contentSha256: sha256('a different body'),
      offset: 0,
      limit: 4,
    })
    assert.deepEqual(stale, { kind: 'unavailable', reason: 'stale-content' })
    const missing = await wire.readText({
      sessionId: item.sessionId,
      messageId: 'hsp-missing-message',
      contentSha256: item.contentSha256,
      offset: 0,
      limit: 4,
    })
    assert.deepEqual(missing, { kind: 'unavailable', reason: 'not-found' })
  } finally {
    await wire.dispose()
  }
})

test('the same text submitted twice is two occurrences with distinct message ids', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-duplicates')
  try {
    await wire.host.harness.create(SessionId('history-dup'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-dup', 'req-dup-1', 'hsp-duplicate-text')
    await prompt(wire, 'history-dup', 'req-dup-2', 'hsp-duplicate-text')
    const answer = await waitForSettled(wire, { scope: 'session', sessionId: 'history-dup', query: 'hsp-duplicate-text', limit: 25 }, 'duplicate occurrences')
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
    if (answer.kind !== 'ready') throw new Error('expected ready')
    assert.equal(answer.items.length, 2)
    assert.notEqual(answer.items[0]!.messageId, answer.items[1]!.messageId)
    assert.ok(answer.items.every(item => item.preview === 'hsp-duplicate-text'))
  } finally {
    await wire.dispose()
  }
})

test('a non-Owner is refused before any official sessionQuery read', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-non-owner')
  try {
    await waitForReady(wire, 'initial index')
    // Count official reads AFTER the index is built: the refusal must add none.
    const query = wire.host.ctx.sessionQuery as unknown as {
      listSessions(...args: never[]): Promise<unknown>
      observeSession(...args: never[]): Promise<unknown>
    }
    const originalList = query.listSessions
    const originalObserve = query.observeSession
    let readCalls = 0
    query.listSessions = function (...args: never[]) {
      readCalls += 1
      return originalList.apply(this, args)
    }
    query.observeSession = function (...args: never[]) {
      readCalls += 1
      return originalObserve.apply(this, args)
    }
    try {
      await assert.rejects(
        wire.search({ scope: 'all', query: 'anything', limit: 1 }, wire.nonOwner),
        /access denied|restricted to the authenticated Owner peer/u,
        'the Gateway must deny a non-Owner before the service body',
      )
      assert.equal(readCalls, 0, 'a non-Owner call must not read any Session')
    } finally {
      query.listSessions = originalList
      query.observeSession = originalObserve
    }
  } finally {
    await wire.dispose()
  }
})

test('an aborted Owner invocation never reaches the index', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-abort')
  try {
    await waitForReady(wire, 'initial index')
    const controller = new AbortController()
    controller.abort(new Error('history search cancelled'))
    await assert.rejects(
      wire.search({ scope: 'all', query: '', limit: 1 }, wire.owner, controller.signal),
      /abort|cancel/iu,
    )
    await assert.rejects(
      wire.readSessionRecall({ sessionId: 'aborted-target' }, wire.owner, controller.signal),
      /abort|cancel/iu,
    )
  } finally {
    await wire.dispose()
  }
})

test('a Host without the official history services answers explicit unavailable, never ok([])', async (t) => {
  const ctx = new Context()
  const signal = new AbortController()
  const invocationCtx = ctx.extend({
    invocation: {
      peer: { principal: { kind: 'owner' }, signal: signal.signal } as never,
      signal: signal.signal,
    } as never,
  })
  const service = new PiTuiHistorySearchHostService(invocationCtx, {
    profileContext: () => undefined,
    sessionPersistence: () => undefined,
    sessionQuery: () => undefined,
    sessions: () => undefined,
  })
  try {
    const answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    assert.deepEqual(answer, { kind: 'unavailable', reason: 'service-missing' })
    // A Host WITH the profile but WITHOUT the official persistence/query is the
    // same definite service-missing fact (never a fabricated empty index).
    await service.dispose()
    const secondLife = testLifecycle(t)
    const secondProfile = secondLife.tempDir('dsh-history-search-profile-only-')
    const secondCtx = new Context()
    const secondSignal = new AbortController()
    const secondInvocation = secondCtx.extend({
      invocation: {
        peer: { principal: { kind: 'owner' }, signal: secondSignal.signal } as never,
        signal: secondSignal.signal,
      } as never,
    })
    const second = new PiTuiHistorySearchHostService(secondInvocation, {
      profileContext: () => ({ dir: secondProfile }) as HistorySearchProfileContextLike,
      sessionPersistence: () => undefined,
      sessionQuery: () => undefined,
      sessions: () => undefined,
    })
    try {
      const secondAnswer = await second.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
      assert.deepEqual(secondAnswer, { kind: 'unavailable', reason: 'service-missing' })
    } finally {
      await second.dispose()
      await secondCtx.fiber.dispose()
    }
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an unreadable profile directory is an explicit index-unavailable, never ok([])', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-search-unsafe-')
  const missingProfile = join(root, 'not-a-real-profile')
  const ctx = new Context()
  const signal = new AbortController()
  const invocationCtx = ctx.extend({
    invocation: {
      peer: { principal: { kind: 'owner' }, signal: signal.signal } as never,
      signal: signal.signal,
    } as never,
  })
  const persistence: HistorySearchPersistenceLike = {
    stat: async () => undefined,
    list: async () => [],
    open: async () => { throw new Error('unused') },
  }
  const query: HistorySearchQueryLike = {
    observeSession: async () => { throw new Error('unused') },
  }
  const sessions: HistorySearchSessionsLike = { list: () => [], get: () => undefined }
  const service = new PiTuiHistorySearchHostService(invocationCtx, {
    profileContext: () => ({ dir: missingProfile }),
    sessionPersistence: () => persistence,
    sessionQuery: () => query,
    sessions: () => sessions,
  })
  try {
    const started = Date.now()
    let answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    while (answer.kind === 'loading' && Date.now() - started < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
      answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    }
    assert.deepEqual(answer, { kind: 'unavailable', reason: 'index-unavailable' })
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('queries answered during the asynchronous bootstrap are a truthful loading', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-loading-')
  const ctx = new Context()
  const signal = new AbortController()
  const invocationCtx = ctx.extend({
    invocation: {
      peer: { principal: { kind: 'owner' }, signal: signal.signal } as never,
      signal: signal.signal,
    } as never,
  })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const persistence: HistorySearchPersistenceLike = {
    stat: async () => undefined,
    list: async () => {
      await gate
      return []
    },
    open: async () => { throw new Error('unused') },
  }
  const query: HistorySearchQueryLike = {
    observeSession: async () => { throw new Error('unused') },
  }
  const sessions: HistorySearchSessionsLike = {
    list: () => [],
    get: () => undefined,
  }
  const service = new PiTuiHistorySearchHostService(invocationCtx, {
    profileContext: () => ({ dir: profileDir }),
    sessionPersistence: () => persistence,
    sessionQuery: () => query,
    sessions: () => sessions,
  })
  try {
    const loading = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    assert.deepEqual(loading, { kind: 'loading' })
    release()
    const started = Date.now()
    let answer = loading
    while (answer.kind === 'loading' && Date.now() - started < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
      answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    }
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('rc.5 working-directory/change keeps each accepted prompt at its own event-time directory', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-cwd')
  try {
    const dirOne = join(wire.host.workRoot, 'history-cwd-one')
    const dirTwo = join(wire.host.workRoot, 'history-cwd-two')
    mkdirSync(dirOne, { recursive: true })
    mkdirSync(dirTwo, { recursive: true })
    const agent = await wire.host.harness.create(SessionId('history-cwd'), { provider: 'smoke', model: 'smoke' }, { cwd: dirOne })
    await prompt(wire, 'history-cwd', 'req-cwd-1', 'hsp-cwd-one')
    await waitForSettled(wire, { scope: 'session', sessionId: 'history-cwd', query: 'hsp-cwd-one', limit: 25 }, 'first cwd occurrence')
    await wire.host.ctx.workingDirectory.set(agent, dirTwo)
    await prompt(wire, 'history-cwd', 'req-cwd-2', 'hsp-cwd-two')
    const all = await waitForSettled(wire, { scope: 'session', sessionId: 'history-cwd', query: 'hsp-cwd-', limit: 25 }, 'both cwd occurrences')
    assert.equal(all.kind, 'ready', JSON.stringify(all))
    if (all.kind !== 'ready') throw new Error('expected ready')
    assert.equal(all.items.length, 2)
    const one = await waitForSettled(wire, { scope: 'directory', cwd: dirOne, query: 'hsp-cwd-', limit: 25 }, 'dir one')
    const two = await waitForSettled(wire, { scope: 'directory', cwd: dirTwo, query: 'hsp-cwd-', limit: 25 }, 'dir two')
    assert.equal(one.kind, 'ready')
    assert.equal(two.kind, 'ready')
    if (one.kind !== 'ready' || two.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(one.items.map(item => item.preview), ['hsp-cwd-one'])
    assert.deepEqual(two.items.map(item => item.preview), ['hsp-cwd-two'])
  } finally {
    await wire.dispose()
  }
})

test('a fork child inherits the parent prefix but only its own new prompt counts', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-fork')
  try {
    const parent = await wire.host.harness.create(SessionId('history-fork-parent'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-fork-parent', 'req-fork-parent', 'hsp-fork-parent')
    await waitForSettled(wire, { scope: 'session', sessionId: 'history-fork-parent', query: 'hsp-fork-parent', limit: 25 }, 'parent occurrence')
    const seed = parent.session.snapshotEvents()
    const child = wire.host.ctx.sessions.create(SessionId('history-fork-child'), {
      seed,
      meta: { cwd: wire.host.anchorDir, isSeeded: true, parentSession: parent.session.id },
      inheritedEventCount: SessionLogOffset(seed.length),
    })
    const childMessage = createUserMessage({
      content: [{ type: 'text', text: 'hsp-fork-child' }],
      source: { kind: 'user', rpcId: 'req-fork-child' as never },
    })
    child.append([['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [childMessage] }]])
    const parentAnswer = await waitForSettled(wire, { scope: 'session', sessionId: 'history-fork-parent', query: 'hsp-fork-parent', limit: 25 }, 'fork parent query')
    const childAnswer = await waitForSettled(wire, { scope: 'session', sessionId: 'history-fork-child', query: 'hsp-fork-child', limit: 25 }, 'fork child query')
    assert.equal(parentAnswer.kind, 'ready', JSON.stringify(parentAnswer))
    assert.equal(childAnswer.kind, 'ready', JSON.stringify(childAnswer))
    if (parentAnswer.kind !== 'ready' || childAnswer.kind !== 'ready') throw new Error('expected ready')
    assert.equal(parentAnswer.items.length, 1, 'the child inherited copy must not create a second parent occurrence')
    assert.equal(childAnswer.items.length, 1, 'the child new prompt must create exactly one occurrence')
  } finally {
    await wire.dispose()
  }
})

test('root-only admission: a subagent Session contributes zero rows while root/fork stay eligible, live and cold/reopen', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-root-only-')
  const root = mutableSource('/repo/root', 'root-session')
  const childMessage = (id: string, text: string, rpcId?: string) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
  })
  const child: MutableOfficialSource = {
    present: true,
    header: testHeader('child-session', '/repo/root', { origin: 'subagent' }),
    events: [
      {
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 2000,
        data: { target: 'next-turn', start: 0, inserted: [childMessage('child-delegated', 'delegated child task')] },
      },
      {
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2001,
        data: { target: 'next-turn', start: 1, inserted: [childMessage('child-followup', 'child human follow-up', 'rpc-child')] },
      },
    ],
    revision: 1,
  }
  const fork: MutableOfficialSource = {
    present: true,
    header: testHeader('fork-session', '/repo/root', { isSeeded: true }),
    inheritedEventCount: 1,
    events: [
      {
        type: 'user/message',
        seq: 0,
        time: 1500,
        data: { ...childMessage('parent-inherited', 'inherited parent input', 'rpc-parent'), role: 'user' },
      },
      {
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 3001,
        data: { target: 'next-turn', start: 0, inserted: [childMessage('fork-own', 'fork own input')] },
      },
    ],
    revision: 1,
  }
  const deps = mutableDeps(root, [child, fork]).deps
  const indexOf = (service: PiTuiHistorySearchHostService) => indexOfService(service)
  const settle = async (service: PiTuiHistorySearchHostService): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await (service as unknown as { writeTail: Promise<void> }).writeTail
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  try {
    await waitDirectReady(service)
    const all = await service.search({ scope: 'all', query: '', limit: 25 }, new AbortController().signal)
    assert.equal(all.kind, 'ready', JSON.stringify(all))
    if (all.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(all.items.map(item => item.messageId).sort(), ['fork-own', 'msg-1', 'msg-2'],
      'exactly the root and the fork OWN input are in the corpus; no child row exists')
    const childSearch = await service.search({ scope: 'session', sessionId: 'child-session', query: '', limit: 25 }, new AbortController().signal)
    assert.equal(childSearch.kind, 'ready', JSON.stringify(childSearch))
    if (childSearch.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(childSearch.items, [], 'a verified child target answers an authoritative empty page')
    assert.equal(indexOf(service).checkpointOf('child-session')?.dirty, false, 'the child checkpoint is clean, not absent')
    assert.equal(indexOf(service).occurrenceCount(), 3)

    const rootRecall = await service.readSessionRecall({ sessionId: 'root-session' }, new AbortController().signal)
    assert.equal(rootRecall.kind, 'ready', JSON.stringify(rootRecall))
    if (rootRecall.kind !== 'ready') throw new Error('expected ready recall')
    assert.deepEqual(rootRecall.items.map(item => [item.messageId, item.rpcId, item.text]), [
      ['msg-2', 'rpc-2', 'mutable second'],
      ['msg-1', 'rpc-1', 'mutable first'],
    ])
    const childRecall = await service.readSessionRecall({ sessionId: 'child-session' }, new AbortController().signal)
    assert.deepEqual(childRecall, { kind: 'ready', sessionId: 'child-session', items: [] })
    const forkRecall = await service.readSessionRecall({ sessionId: 'fork-session' }, new AbortController().signal)
    assert.equal(forkRecall.kind, 'ready', JSON.stringify(forkRecall))
    if (forkRecall.kind !== 'ready') throw new Error('expected ready recall')
    assert.deepEqual(forkRecall.items.map(item => item.messageId), ['fork-own'], 'the inherited prefix is never a fork occurrence')
    const childText = await service.readText({
      sessionId: 'child-session',
      messageId: 'child-delegated',
      contentSha256: sha256('delegated child task'),
      offset: 0,
      limit: 8,
    }, new AbortController().signal)
    assert.deepEqual(childText, { kind: 'unavailable', reason: 'not-found' }, 'child content is not addressable through readText')

    // LIVE: a root acceptance is admitted; a child acceptance (including its
    // delegated user task shape) stays excluded before body parsing.
    const observe = (session: unknown, event: unknown): void => {
      ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
        .observeLiveEvent(session, event)
    }
    const rootLive = {
      type: 'agent/inbox/spliced', seq: 3, time: 5000,
      data: { target: 'next-turn', start: 2, inserted: [childMessage('root-live', 'root live accepted', 'rpc-live')] },
    }
    const childLive = {
      type: 'agent/inbox/spliced', seq: 2, time: 5001,
      data: { target: 'next-turn', start: 2, inserted: [childMessage('child-live', 'child live task')] },
    }
    // Production also appends the accepted live event to the durable official
    // log; the structural source mirrors that so the cold reopen can prove it.
    root.events.push(rootLive)
    child.events.push(childLive)
    observe({ id: 'root-session', header: root.header, inheritedEventCount: 0 }, rootLive)
    observe({ id: 'child-session', header: child.header, inheritedEventCount: 0 }, childLive)
    await settle(service)
    const liveRoot = await service.readSessionRecall({ sessionId: 'root-session' }, new AbortController().signal)
    assert.equal(liveRoot.kind, 'ready', JSON.stringify(liveRoot))
    if (liveRoot.kind !== 'ready') throw new Error('expected ready recall')
    assert.equal(liveRoot.items[0]?.messageId, 'root-live', 'the live root acceptance is recalled')
    const liveChild = await service.readSessionRecall({ sessionId: 'child-session' }, new AbortController().signal)
    assert.deepEqual(liveChild, { kind: 'ready', sessionId: 'child-session', items: [] })
    assert.equal(indexOf(service).occurrenceCount(), 4, 'only the live root row was added')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }

  // COLD/REOPEN: the same root-only facts survive a restarted service.
  const secondCtx = new Context()
  const restarted = directService(secondCtx, deps, profileDir)
  try {
    await waitDirectReady(restarted)
    const recall = await restarted.readSessionRecall({ sessionId: 'root-session' }, new AbortController().signal)
    assert.equal(recall.kind, 'ready', JSON.stringify(recall))
    if (recall.kind !== 'ready') throw new Error('expected ready recall')
    assert.equal(recall.items.filter(item => item.text === 'root live accepted').length, 1)
    const childSearch = await restarted.search({ scope: 'session', sessionId: 'child-session', query: '', limit: 25 }, new AbortController().signal)
    assert.equal(childSearch.kind, 'ready', JSON.stringify(childSearch))
    if (childSearch.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(childSearch.items, [])
    assert.equal(indexOfService(restarted).occurrenceCount(), 4)
  } finally {
    await restarted.dispose()
    await secondCtx.fiber.dispose()
  }
})

test('a REAL child Session created with origin=subagent contributes zero rows through cold and live admission', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-real-child')
  try {
    const parentId = 'history-real-parent'
    const childId = 'history-real-child'
    await wire.host.harness.create(SessionId(parentId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, parentId, 'req-real-parent', 'hsp-real-parent-input')
    // A REAL Host Session with the official child metadata (the same immutable
    // shape the production subagent spawn writes; the real spawn seam proved
    // that write in the entry gate).
    const child = wire.host.ctx.sessions.create(SessionId(childId), {
      meta: {
        cwd: wire.host.anchorDir,
        parentSession: SessionId(parentId),
        origin: 'subagent',
      },
    } as never)
    const delegated = createUserMessage({
      content: [{ type: 'text', text: 'hsp-real-child-delegated task' }],
      source: { kind: 'user' },
    })
    child.append([['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [delegated] }]])
    assert.equal(child.header.origin, 'subagent', 'the live Host Session carries the immutable child origin')

    await waitForReady(wire, 'real child corpus')
    const childSearch = await wire.search({ scope: 'session', sessionId: childId, query: '', limit: 25 })
    assert.equal(childSearch.kind, 'ready', JSON.stringify(childSearch))
    if (childSearch.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(childSearch.items, [], 'no child row is searchable even with its user-source task')
    const childRecall = await wire.readSessionRecall({ sessionId: childId })
    assert.deepEqual(childRecall, { kind: 'ready', sessionId: childId, items: [] })
    const childText = await wire.readText({
      sessionId: childId,
      messageId: delegated.id,
      contentSha256: sha256('hsp-real-child-delegated task'),
      offset: 0,
      limit: 8,
    })
    assert.deepEqual(childText, { kind: 'unavailable', reason: 'not-found' })

    // LIVE: a later human-style follow-up on the same real child is excluded
    // by the same fold, while the parent's own accepted row stays visible.
    const followup = createUserMessage({
      content: [{ type: 'text', text: 'hsp-real-child-followup' }],
      source: { kind: 'user', rpcId: 'rpc-real-child-followup' as never },
    })
    child.append([['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [followup] }]])
    await new Promise(resolve => setTimeout(resolve, 50))
    const liveChild = await wire.readSessionRecall({ sessionId: childId })
    assert.deepEqual(liveChild, { kind: 'ready', sessionId: childId, items: [] })
    const parentRecall = await wire.readSessionRecall({ sessionId: parentId })
    assert.equal(parentRecall.kind, 'ready', JSON.stringify(parentRecall))
    if (parentRecall.kind !== 'ready') throw new Error('expected ready recall')
    assert.deepEqual(parentRecall.items.map(item => item.text), ['hsp-real-parent-input'])
  } finally {
    await wire.dispose()
  }
})

test('a real Agent followup without rpcId is ONE accepted occurrence and non-user sources stay excluded', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-uncorrelated')
  try {
    const sessionId = 'history-uncorrelated'
    const agent = await wire.host.harness.create(
      SessionId(sessionId),
      { provider: 'smoke', model: 'smoke' },
      { cwd: wire.host.anchorDir },
    )
    const correlatedText = 'hsp-uncorrelated-correlated'
    await prompt(wire, sessionId, 'req-uncorrelated-correlated', correlatedText)

    // The official Agent followup accepts a createUserMessage with only
    // `source: {kind:'user'}`: no request correlation exists anywhere in this
    // producer path.
    const directText = 'hsp-uncorrelated-direct'
    const direct = createUserMessage({ content: [{ type: 'text', text: directText }], source: { kind: 'user' } })
    assert.equal('rpcId' in (direct.source as object), false, 'the real followup producer must carry no rpcId')
    agent.followup(direct)
    await agent.whenIdle()
    const directAnswer = await waitForSettled(
      wire,
      { scope: 'session', sessionId, query: directText, limit: 25 },
      'no-rpcId occurrence',
    )
    assert.equal(directAnswer.kind, 'ready', JSON.stringify(directAnswer))
    if (directAnswer.kind !== 'ready') throw new Error('expected ready')
    assert.equal(directAnswer.items.length, 1, 'the no-rpcId occurrence must be indexed exactly once')
    const item = directAnswer.items[0]!
    assert.equal(item.sessionId, sessionId)
    assert.equal(item.messageId, direct.id)
    assert.equal(item.preview, directText)
    assert.equal(item.effectiveCwd, wire.host.anchorDir)
    const chunk = await wire.readText({
      sessionId: item.sessionId,
      messageId: item.messageId,
      contentSha256: item.contentSha256,
      offset: 0,
      limit: 4096,
    })
    assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
    if (chunk.kind !== 'ready') throw new Error('expected ready')
    assert.equal(chunk.chunk, directText)

    // Prove the DURABLE official events carry the no-rpcId shape: the same-id
    // user/message consume keeps it ONE occurrence, never a second row.
    const events = agent.session.snapshotEvents() as readonly {
      readonly type: string
      readonly data: { readonly id?: unknown; readonly inserted?: readonly { readonly id?: unknown; readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown } }[] }
    }[]
    const inboxed = events
      .filter(event => event.type === 'agent/inbox/spliced' && Array.isArray(event.data.inserted))
      .flatMap(event => event.data.inserted!)
      .find(message => message.id === direct.id)
    assert.ok(inboxed !== undefined, 'the official inbox insertion must carry the followup message')
    assert.equal(inboxed.source?.kind, 'user')
    assert.equal(inboxed.source?.rpcId, undefined, 'the durable inbox message must carry no rpcId')
    const consumed = events.find(event => event.type === 'user/message' && event.data.id === direct.id)
    assert.ok(consumed !== undefined, 'the followup message must be consumed as a real user/message')
    const replayed = await wire.search({ scope: 'session', sessionId, query: directText, limit: 25 })
    assert.equal(replayed.kind, 'ready')
    if (replayed.kind !== 'ready') throw new Error('expected ready')
    assert.equal(replayed.items.length, 1, 'the same-id consume must not create a second occurrence')
    const correlated = await wire.search({ scope: 'session', sessionId, query: correlatedText, limit: 25 })
    assert.equal(correlated.kind, 'ready')
    if (correlated.kind !== 'ready') throw new Error('expected ready')
    assert.equal(correlated.items.length, 1, 'the normal correlated prompt stays accepted')

    // Every scope reaches both real inputs; a non-user producer notice never
    // enters the corpus even though it shares the same Session log.
    const noticeText = 'hsp-uncorrelated-notice'
    agent.session.append([['user/message', {
      id: 'hsp-uncorrelated-notice',
      role: 'user',
      content: [{ type: 'text', text: noticeText }],
      source: { kind: 'plan-mode' },
    } as never, { surfaceOp: 'append' }]])
    await waitForReady(wire, 'uncorrelated ready')
    const notice = await wire.search({ scope: 'all', query: noticeText, limit: 25 })
    assert.equal(notice.kind, 'ready')
    if (notice.kind !== 'ready') throw new Error('expected ready')
    assert.equal(notice.items.length, 0, 'a non-user source must never be admitted')
    const all = await wire.search({ scope: 'all', query: 'hsp-uncorrelated-', limit: 25 })
    assert.equal(all.kind, 'ready')
    if (all.kind !== 'ready') throw new Error('expected ready')
    assert.equal(all.items.length, 2)
    const directory = await wire.search({ scope: 'directory', cwd: wire.host.anchorDir, query: 'hsp-uncorrelated-', limit: 25 })
    assert.equal(directory.kind, 'ready')
    if (directory.kind !== 'ready') throw new Error('expected ready')
    assert.equal(directory.items.length, 2)
  } finally {
    await wire.dispose()
  }
})

/**
 * One accepted-input corpus whose explicit unknown directory sits exactly on an
 * official read-batch boundary: the first occurrence keeps the header cwd, the
 * second (first event of the NEXT batch) is explicitly unknown, and a later
 * valid change restores the directory for the third.
 */
function crossingUnknownCwdEvents(headerCwd: string): MutableOfficialSource['events'] {
  const message = (id: string, text: string) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const inserted = (seq: number, value: ReturnType<typeof message>) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 1000 + seq,
    data: { target: 'next-turn', start: seq, inserted: [value] },
  })
  const emptyInsertion = (seq: number) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 1000 + seq,
    data: { target: 'next-turn', start: seq, inserted: [] },
  })
  const events: MutableOfficialSource['events'] = [inserted(0, message('h2-first', 'hsp-h2-first'))]
  const boundary = HISTORY_SEARCH_READ_BATCH
  for (let seq = 1; seq < boundary - 1; seq += 1) events.push(emptyInsertion(seq))
  events.push({ type: 'working-directory/change', seq: boundary - 1, time: 1000 + boundary, data: { cwd: '' } })
  events.push(inserted(boundary, message('h2-unknown', 'hsp-h2-unknown')))
  for (let seq = boundary + 1; seq < boundary + 40; seq += 1) events.push(emptyInsertion(seq))
  events.push({ type: 'working-directory/change', seq: boundary + 40, time: 1000 + boundary + 40, data: { cwd: `${headerCwd}-b` } })
  events.push(inserted(boundary + 41, message('h2-second', 'hsp-h2-second')))
  return events
}

/** The complete all/session/directory/readText contract of the null-cwd corpus. */
async function assertUnknownCwdCorpus(
  service: PiTuiHistorySearchHostService,
  sessionId: string,
  headerCwd: string,
): Promise<void> {
  const signal = new AbortController().signal
  const all = await service.search({ scope: 'all', query: 'hsp-h2-', limit: 25 }, signal)
  assert.equal(all.kind, 'ready', JSON.stringify(all))
  if (all.kind !== 'ready') throw new Error('expected ready')
  assert.equal(all.items.length, 3)
  const byText = (text: string) => all.items.find(item => item.preview === text)
  assert.equal(byText('hsp-h2-first')?.effectiveCwd, headerCwd)
  assert.equal(byText('hsp-h2-unknown')?.effectiveCwd, null, 'the unknown segment must stay unknown, never the header')
  assert.equal(byText('hsp-h2-second')?.effectiveCwd, `${headerCwd}-b`)
  const session = await service.search({ scope: 'session', sessionId, query: 'hsp-h2-', limit: 25 }, signal)
  assert.equal(session.kind, 'ready')
  if (session.kind !== 'ready') throw new Error('expected ready')
  assert.equal(session.items.length, 3)
  const directoryA = await service.search({ scope: 'directory', cwd: headerCwd, query: 'hsp-h2-', limit: 25 }, signal)
  assert.equal(directoryA.kind, 'ready')
  if (directoryA.kind !== 'ready') throw new Error('expected ready')
  assert.deepEqual(directoryA.items.map(item => item.preview), ['hsp-h2-first'],
    'the unknown segment must not be attributed to the previous directory')
  const directoryB = await service.search({ scope: 'directory', cwd: `${headerCwd}-b`, query: 'hsp-h2-', limit: 25 }, signal)
  assert.equal(directoryB.kind, 'ready')
  if (directoryB.kind !== 'ready') throw new Error('expected ready')
  assert.deepEqual(directoryB.items.map(item => item.preview), ['hsp-h2-second'],
    'the restored directory must match only its own segment')
  const unknownRow = byText('hsp-h2-unknown')
  assert.ok(unknownRow !== undefined)
  const chunk = await service.readText({
    sessionId,
    messageId: unknownRow.messageId,
    contentSha256: unknownRow.contentSha256,
    offset: 0,
    limit: 4096,
  }, signal)
  assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
  if (chunk.kind !== 'ready') throw new Error('expected ready')
  assert.equal(chunk.chunk, 'hsp-h2-unknown')
}

test('an explicit unknown directory crosses official read batches without resurrecting the header', async (t) => {
  const life = testLifecycle(t)
  // (a) A complete cold official-handle read (batched replayHandle commits).
  const coldProfile = life.tempDir('dsh-history-search-null-cwd-cold-')
  const cold: MutableOfficialSource = {
    present: true,
    header: testHeader('h2-cold', '/repo/h2-a'),
    events: crossingUnknownCwdEvents('/repo/h2-a'),
    revision: 1,
  }
  const coldDeps = mutableDeps(cold)
  const coldCtx = new Context()
  const coldService = directService(coldCtx, coldDeps.deps, coldProfile)
  try {
    await waitDirectReady(coldService, 20_000)
    await assertUnknownCwdCorpus(coldService, 'h2-cold', '/repo/h2-a')
  } finally {
    await coldService.dispose()
    await coldCtx.fiber.dispose()
  }

  // (b) A live Session settled at seq 0 first, so the same corpus arrives
  // through the ordinary pending continuation (commitLiveBatch), not a re-read.
  const liveProfile = life.tempDir('dsh-history-search-null-cwd-live-')
  const live: MutableOfficialSource = {
    present: true,
    header: testHeader('h2-live', '/repo/h2-a'),
    events: [],
    revision: 1,
    live: true,
  }
  const liveDeps = mutableDeps(live)
  const liveCtx = new Context()
  const liveService = directService(liveCtx, liveDeps.deps, liveProfile)
  try {
    await waitDirectReady(liveService, 20_000)
    const observeBefore = liveDeps.calls.observeCalls()
    const internals = liveService as unknown as { observeLiveEvent(session: unknown, event: unknown): void }
    const liveSession = liveSessionOf(live)
    for (const event of crossingUnknownCwdEvents('/repo/h2-a')) internals.observeLiveEvent(liveSession, event)
    await waitDirectReady(liveService, 20_000)
    assert.equal(liveDeps.calls.observeCalls(), observeBefore,
      'the pending continuation must commit from the live buffer, not re-read the official source')
    await assertUnknownCwdCorpus(liveService, 'h2-live', '/repo/h2-a')
  } finally {
    await liveService.dispose()
    await liveCtx.fiber.dispose()
  }
})

test('the live buffer bound stops appending and re-reads the official source without losing rows', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-overflow')
  try {
    const agent = await wire.host.harness.create(SessionId('history-overflow'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await waitForReady(wire, 'initial index')
    const total = HISTORY_SEARCH_MAX_PENDING_EVENTS + 1
    // One synchronous batch larger than the buffer bound: the listener must
    // stop appending, mark the Session dirty and rebuild from the official log.
    for (let index = 0; index < total; index += 1) {
      const message = createUserMessage({
        content: [{ type: 'text', text: `hsp-overflow-${String(index)}` }],
        source: { kind: 'user', rpcId: `rpc-overflow-${String(index)}` as never },
      })
      agent.session.append([['agent/inbox/spliced', { target: 'next-turn', start: index, inserted: [message] }]])
    }
    await waitForReady(wire, 'overflow reconcile')
    const page = await wire.search({ scope: 'session', sessionId: 'history-overflow', query: 'hsp-overflow-', limit: 25 })
    assert.equal(page.kind, 'ready', JSON.stringify(page))
    if (page.kind !== 'ready') throw new Error('expected ready')
    assert.equal(page.items.length, 25)
    assert.notEqual(page.nextCursor, null, 'the overflow rebuild must keep more than one page of rows')
    const beforeOverflow = await wire.search({ scope: 'session', sessionId: 'history-overflow', query: 'hsp-overflow-0', limit: 25 })
    const afterOverflow = await wire.search({ scope: 'session', sessionId: 'history-overflow', query: `hsp-overflow-${String(total - 1)}`, limit: 25 })
    assert.equal(beforeOverflow.kind, 'ready')
    assert.equal(afterOverflow.kind, 'ready')
    if (beforeOverflow.kind !== 'ready' || afterOverflow.kind !== 'ready') throw new Error('expected ready')
    assert.equal(beforeOverflow.items.length, 1, 'a row before the overflow window was dropped')
    assert.equal(afterOverflow.items.length, 1, 'the row that triggered the overflow was dropped')
  } finally {
    await wire.dispose()
  }
})

test('dispose aborts the owned bootstrap, withdraws listeners and closes the database', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-dispose')
  try {
    await waitForReady(wire, 'initial index')
    const service = wire.service()
    await service.dispose()
    assert.equal((service as unknown as { disposed: boolean }).disposed, true)
    assert.equal((service as unknown as { listenerDisposers: unknown[] }).listenerDisposers.length, 0)
    assert.equal((service as unknown as { index: unknown }).index, undefined,
      'the ONE database handle must be closed on dispose')
  } finally {
    await wire.dispose()
  }
})

test('a real AgentHandle disposal settles the index through the official Session lifecycle', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-real-disposal')
  try {
    const sessionId = 'history-pr1-dispose'
    const handle = await wire.host.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: { provider: 'smoke', model: 'smoke' },
      meta: { cwd: wire.host.anchorDir },
    })
    await prompt(wire, sessionId, 'req-pr1-dispose', 'hsp-pr1-dispose-text')
    const before = await waitForSettled(
      wire,
      { scope: 'session', sessionId, query: 'hsp-pr1-dispose-text', limit: 25 },
      'pre-disposal occurrence',
    )
    assert.equal(before.kind, 'ready', JSON.stringify(before))
    if (before.kind !== 'ready') throw new Error('expected ready')
    assert.equal(before.items.length, 1)

    const service = wire.service() as unknown as {
      index: { checkpointOf(id: string): { sourceState: string; dirty: boolean } | undefined }
      disposalCounters: { seen: number; completed: number; statCalls: number }
      writeTail: Promise<void>
      verifySources(): Promise<void>
    }
    const statCallsBefore = service.disposalCounters.statCalls
    const disposed: string[] = []
    const off = wire.host.ctx.on('session/disposed', (session) => {
      disposed.push(String((session as { readonly id?: unknown }).id))
    }, { global: true })
    try {
      await handle.dispose()
    } finally {
      off()
    }
    assert.ok(disposed.includes(sessionId), `the official lifecycle must dispose the exact Session: ${JSON.stringify(disposed)}`)

    // Settle on THIS Session's official disposal verification: the point lookup
    // ran and the checkpoint reached a decision. Another fixture lifecycle event
    // may have bumped the aggregate counters earlier, so the per-Session
    // checkpoint is the real barrier.
    const checkpoint = () => service.index.checkpointOf(sessionId)
    const started = Date.now()
    while (
      (service.disposalCounters.statCalls <= statCallsBefore
        || (checkpoint()?.dirty !== true && checkpoint()?.sourceState !== 'persisted'))
      && Date.now() - started < 10_000
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await service.writeTail
    assert.ok(service.disposalCounters.statCalls > statCallsBefore, 'the disposal must read exactly one official snapshot')
    // The live checkpoint's header hash names the IN-MEMORY header (DSH adds
    // `delegationDepth` when the durable header materializes), so the disposal
    // must keep the accepted rows provisional instead of claiming a proof it
    // cannot make. The SAME periodic verification pass then reconciles it.
    assert.equal(checkpoint()?.sourceState, 'live')
    assert.equal(checkpoint()?.dirty, true)
    const uncertain = await wire.search({ scope: 'session', sessionId, query: 'hsp-pr1-dispose-text', limit: 25 })
    assert.equal(uncertain.kind, 'incomplete', JSON.stringify(uncertain))

    await service.verifySources()
    assert.equal(checkpoint()?.sourceState, 'persisted')
    assert.equal(checkpoint()?.dirty, false)
    const after = await waitForSettled(
      wire,
      { scope: 'session', sessionId, query: 'hsp-pr1-dispose-text', limit: 25 },
      'post-disposal occurrence',
    )
    assert.equal(after.kind, 'ready', JSON.stringify(after))
    if (after.kind !== 'ready') throw new Error('expected ready')
    assert.equal(after.items.length, 1, 'the proven accepted occurrence must survive disposal exactly once')
    assert.equal(after.items[0]?.messageId, before.items[0]?.messageId)
    assert.equal(after.items[0]?.contentSha256, before.items[0]?.contentSha256)
  } finally {
    await wire.dispose()
  }
})

/**
 * The isolated visible-diagnostics child: the SAME production service over a
 * minimal structural official source. Its ONLY purpose is to prove that the
 * debug metrics reach the standard Diag FILE sink (not a mocked logger) and
 * never carry Session content, ids or paths. The entry is generated by the
 * test in its own temporary directory; no production or shared test module
 * is added.
 */
function historyDebugProbeScript(historyModuleUrl: string): string {
  return `
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { PiTuiHistorySearchHostService } from ${JSON.stringify(historyModuleUrl)}

const root = process.env.DSH_HOME
if (root === undefined || root === '') throw new Error('DSH_HOME is required')
const profileDir = join(root, 'profile')
mkdirSync(profileDir, { recursive: true })

const header = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('history-pr1-debug-child'),
  createdAt: 1721232000000,
  cwd: '/repo/history-pr1-child',
  isSeeded: false,
}
const events = [{
  type: 'agent/inbox/spliced',
  seq: 0,
  time: 1000,
  data: {
    target: 'next-turn',
    start: 0,
    inserted: [{
      id: 'history-pr1-debug-message',
      role: 'user',
      content: [{ type: 'text', text: 'hsp-child-secret-text' }],
      source: { kind: 'user', rpcId: 'rpc-pr1-child' },
    }],
  },
}]
const persistence = {
  identity: Symbol('debug-probe-persistence'),
  async list() { return [{ header, eventCount: 1, revision: 1 }] },
  async stat(id) { return id === header.id ? { header, eventCount: 1, revision: 1 } : undefined },
  async open() {
    return {
      header,
      inheritedEventCount: 0,
      async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
        return { events: events.slice(offset, offset + length) }
      },
      async close() {},
    }
  },
}
const query = {
  async observeSession() { throw new Error('unused') },
}
const sessions = {
  list() { return [] },
  get() { return undefined },
}
const ctx = new Context()
const lifecycle = new AbortController()
const invocationCtx = ctx.extend({
  invocation: {
    peer: { principal: { kind: 'owner' }, signal: lifecycle.signal },
    signal: lifecycle.signal,
  },
})
const service = new PiTuiHistorySearchHostService(invocationCtx, {
  profileContext: () => ({ dir: profileDir }),
  sessionPersistence: () => persistence,
  sessionQuery: () => query,
  sessions: () => sessions,
})
const deadline = Date.now() + 20_000
for (;;) {
  const answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
  if (answer.kind === 'ready') break
  if (answer.kind === 'unavailable') throw new Error('index unavailable: ' + JSON.stringify(answer))
  if (Date.now() > deadline) throw new Error('history index readiness timeout')
  await new Promise(resolve => setTimeout(resolve, 10))
}
// ONE ordinary full verification pass over the now-stable source: this pass
// makes no official call of its own and must report a zero full phase.
await service.verifySources()
service.observeDisposedSession({ id: header.id })
await Promise.allSettled([...service.sessionRepairFlights.values()].map(entry => entry.promise))
await service.writeTail
await service.dispose()
await ctx.fiber.dispose()
`
}

test('explicit debug diagnostics reach the standard file sink without Session content', async (t) => {
  const life = testLifecycle(t)
  // Profile and log live in the run's isolated temp root; the generated probe
  // entry lives under the checkout's ignored `temp/` so Node resolves the
  // repository's own node_modules exactly like the test process does.
  const root = life.tempDir('dsh-history-search-debug-')
  const historyModuleUrl = new URL('../../src/app/host/features/history-search.ts', import.meta.url).href
  const scriptBase = join(fileURLToPath(new URL('../../', import.meta.url)), 'temp')
  mkdirSync(scriptBase, { recursive: true })
  const scriptPath = join(life.tempDir('dsh-history-search-debug-entry-', scriptBase), 'history-search-debug-probe.mjs')
  writeFileSync(scriptPath, historyDebugProbeScript(historyModuleUrl))
  const runProbe = (logPath: string, level: string) => spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: root, DSH_PI_TUI_LOG: logPath, DSH_PI_TUI_LOG_LEVEL: level },
    timeout: 60_000,
  })

  const debugLogPath = join(root, 'history-search-debug.log')
  const debugRun = runProbe(debugLogPath, 'debug')
  assert.equal(debugRun.status, 0, `debug probe failed: ${debugRun.stderr}`)
  const log = readFileSync(debugLogPath, 'utf8')
  assert.match(log, /history-search\.inventory\.start phase=cold_start directPersistenceListCalls=0 queryListSessionsCalls=0 liveSessionsObserved=0/u)
  assert.match(log, /history-search\.inventory\.end phase=cold_start outcome=ok elapsedMs=\d+(?:\.\d)? persistedRows=1 mergedRows=1 liveSessionsObserved=0 directPersistenceListCalls=1 queryListSessionsCalls=0/u)
  // Decisive counter facts are parsed by field, not by incidental log order.
  // The full cold phase owns exactly its own official calls: ONE open + ONE read
  // + ONE close + ONE final currentness stat for the single cold source.
  const bootstrap = diagnosticFields(log, 'history-search.bootstrap.end')
  assert.equal(bootstrap.outcome, 'ready')
  for (const [field, expected] of [
    ['sessionsVisited', '1'],
    ['replayAttempted', '1'],
    ['replayCompleted', '1'],
    ['directPersistenceStatCalls', '1'],
    ['directPersistenceOpenCalls', '1'],
    ['directPersistenceReadCalls', '1'],
    ['directPersistenceCloseCalls', '1'],
    ['directSessionObserveCalls', '0'],
    ['prefixProofAttempted', '0'],
    ['revisionAuthorityQualified', '0'],
    ['revisionAuthorityUnavailable', '0'],
    ['sourceProofHit', '0'],
    ['sourceProofMiss', '0'],
    ['sourceProofMinted', '0'],
    ['sourceProofRevoked', '0'],
  ] as const) {
    assert.equal(bootstrap[field], expected, `bootstrap.${field}`)
  }
  // An unchanged stable epoch: the periodic pass makes no direct official call.
  const verify = diagnosticFields(log, 'history-search.verify.end')
  assert.equal(verify.outcome, 'ready')
  for (const [field, expected] of [
    ['sessionsVisited', '1'],
    ['replayAttempted', '0'],
    ['replayCompleted', '0'],
    ['directPersistenceStatCalls', '0'],
    ['directPersistenceOpenCalls', '0'],
    ['directPersistenceReadCalls', '0'],
    ['directPersistenceCloseCalls', '0'],
    ['directSessionObserveCalls', '0'],
    ['prefixProofAttempted', '0'],
    ['sourceProofHit', '0'],
    ['sourceProofMinted', '0'],
    ['sourceProofRevoked', '0'],
  ] as const) {
    assert.equal(verify[field], expected, `verify.${field}`)
  }
  // The point scope is separate from every full phase and is reported on its
  // first completion: one stat + one prefix open/read/close, no replay.
  const point = diagnosticFields(log, 'history-search.point-repairs')
  for (const [field, expected] of [
    ['completed', '1'],
    ['directPersistenceStatCalls', '1'],
    ['directPersistenceOpenCalls', '1'],
    ['directPersistenceReadCalls', '1'],
    ['directPersistenceCloseCalls', '1'],
    ['directSessionObserveCalls', '0'],
    ['prefixProofAttempted', '1'],
    ['replayAttempted', '0'],
    ['replayCompleted', '0'],
    ['sourceProofHit', '0'],
    ['sourceProofMinted', '0'],
    ['sourceProofRevoked', '0'],
  ] as const) {
    assert.equal(point[field], expected, `point.${field}`)
  }
  assert.equal(log.match(/history-search\.point-repairs/gu)?.length, 1, 'one ended point task must emit exactly one bounded aggregate')
  assert.match(log, /history-search\.writer phase=cold_start writerCommitted=\d+ writerFailed=0/u)
  assert.match(log, /history-search\.disposals seen=1 statCalls=1 statNotFound=0 proofProven=1 proofInsufficient=0 proofRollback=0 proofUnreadable=0 statElapsedMsTotal=\d+(?:\.\d)? verifyElapsedMsTotal=\d+(?:\.\d)?/u)
  assert.equal(log.match(/history-search\.disposals/gu)?.length, 1, 'a single disposal must emit exactly one bounded aggregate')
  for (const secret of ['hsp-child-secret-text', 'history-pr1-debug-child', '/repo/history-pr1-child', root]) {
    assert.ok(!log.includes(secret), `the debug diagnostics must not carry ${secret}`)
  }

  // Control: without explicit debug no service-owned second sink is created.
  const offLogPath = join(root, 'history-search-off.log')
  const offRun = runProbe(offLogPath, 'info')
  assert.equal(offRun.status, 0, `control probe failed: ${offRun.stderr}`)
  assert.equal(existsSync(offLogPath), false, 'debug-off must not create the service diagnostic sink')
})

/**
 * A mutable structural official source for the reconcile failure classes that
 * have no public trigger besides the periodic verification pass. `verifySources`
 * is invoked directly (a test probe of the SAME production pass) so the case is
 * deterministic instead of waiting the 30 s cadence.
 */
interface MutableOfficialSource {
  present: boolean
  header: SessionHeader
  /** A deliberately different durable header observation (conflict cases). */
  persistedHeader?: SessionHeader
  events: { type: string; seq: number; time: number; data: unknown }[]
  revision: number
  /** Opaque durable revision token for the durable-proof cases. */
  revisionToken?: unknown
  /** Advertised durable count when it deliberately disagrees with `events`. */
  eventCount?: number
  /** rc.5 JSONL shape: `list()` provides no eventCount at all. */
  omitEventCount?: boolean
  /** The official read is only durable through this many events. */
  durableEventCount?: number
  /** The official fork-inherited prefix cut of this source. */
  inheritedEventCount?: number
  /** The official sessionQuery reports this Session as live. */
  live?: boolean
  /** Official source classification used by the durable-proof tests. */
  formatStatus?: 'current' | 'migration-required'
  location?: { readonly kind: string; readonly path: string }
}

function mutableSource(headerCwd: string, id = 'mutable-session'): MutableOfficialSource {
  const message = (text: string, index: number) => ({
    id: `msg-${String(index)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${String(index)}` },
  })
  return {
    present: true,
    header: testHeader(id, headerCwd),
    events: [
      { type: 'agent/inbox/spliced', seq: 0, time: 1000, data: { target: 'next-turn', start: 0, inserted: [message('mutable first', 1)] } },
      { type: 'working-directory/change', seq: 1, time: 1001, data: { cwd: `${headerCwd}-two` } },
      { type: 'agent/inbox/spliced', seq: 2, time: 1002, data: { target: 'next-turn', start: 1, inserted: [message('mutable second', 2)] } },
    ],
    revision: 1,
  }
}

function mutableDeps(
  source: MutableOfficialSource,
  extras: readonly MutableOfficialSource[] = [],
): {
  readonly deps: {
    profileContext: () => { dir: string }
    sessionPersistence: () => HistorySearchPersistenceLike
    sessionQuery: () => HistorySearchQueryLike
    sessions: () => HistorySearchSessionsLike
  }
  readonly calls: {
    listCalls: () => number
    statCalls: () => number
    statIds: () => readonly string[]
    openCalls: () => number
    observeCalls: () => number
    readCalls: () => number
    closeCalls: () => number
  }
} {
  const sources = [source, ...extras]
  const sourceOf = (id: string): MutableOfficialSource | undefined =>
    sources.find(candidate => String(candidate.header.id) === id)
  const snapshotOf = (candidate: MutableOfficialSource) => ({
    header: candidate.persistedHeader ?? candidate.header,
    ...(candidate.omitEventCount === true ? {} : { eventCount: candidate.eventCount ?? candidate.events.length }),
    revision: candidate.revisionToken ?? candidate.revision,
    ...(candidate.formatStatus === undefined ? {} : { formatStatus: candidate.formatStatus }),
    ...(candidate.location === undefined ? {} : { location: candidate.location }),
  })
  let listCalls = 0
  let statCalls = 0
  let openCalls = 0
  let observeCalls = 0
  let readCalls = 0
  let closeCalls = 0
  const statIds: string[] = []
  const persistence: HistorySearchPersistenceLike = {
    identity: Symbol('mutable-persistence'),
    async list() {
      listCalls += 1
      return sources.filter(candidate => candidate.present).map(snapshotOf)
    },
    async stat(id) {
      statCalls += 1
      statIds.push(id)
      const candidate = sourceOf(id)
      if (candidate === undefined || !candidate.present) return undefined
      return snapshotOf(candidate)
    },
    async open(id) {
      openCalls += 1
      const candidate = sourceOf(String(id))
      if (candidate === undefined) throw new Error(`mutable persistence: unknown Session ${String(id)}`)
      return {
        header: candidate.persistedHeader ?? candidate.header,
        inheritedEventCount: candidate.inheritedEventCount ?? 0,
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          readCalls += 1
          const durable = candidate.durableEventCount ?? candidate.events.length
          return { events: candidate.events.slice(offset, Math.min(offset + length, durable)) }
        },
        async close() { closeCalls += 1 },
      }
    },
  }
  const query: HistorySearchQueryLike = {
    async observeSession(id) {
      observeCalls += 1
      const candidate = sourceOf(String(id))
      if (candidate === undefined) throw new Error(`mutable query: unknown Session ${String(id)}`)
      return {
        header: candidate.header,
        inheritedEventCount: candidate.inheritedEventCount ?? 0,
        events: candidate.events,
        [Symbol.dispose]() {},
      }
    },
  }
  const sessions = liveRegistryMany(sources)
  return {
    deps: {
      profileContext: () => ({ dir: '' }),
      sessionPersistence: () => persistence,
      sessionQuery: () => query,
      sessions: () => sessions,
    },
    calls: {
      listCalls: () => listCalls,
      statCalls: () => statCalls,
      statIds: () => [...statIds],
      openCalls: () => openCalls,
      observeCalls: () => observeCalls,
      readCalls: () => readCalls,
      closeCalls: () => closeCalls,
    },
  }
}

/** The service-lifetime point scope a diagnostics test may inspect. */
interface PointCountersLike {
  directPersistenceStatCalls: number
  directPersistenceOpenCalls: number
  directSessionObserveCalls: number
  prefixProofAttempted: number
  replayAttempted: number
  replayCompleted: number
}

/** One comparable view of the point scope (field names are the production ones). */
function pointCountersOf(counters: PointCountersLike): {
  stat: number
  open: number
  observe: number
  prefix: number
  replayAttempted: number
  replayCompleted: number
} {
  return {
    stat: counters.directPersistenceStatCalls,
    open: counters.directPersistenceOpenCalls,
    observe: counters.directSessionObserveCalls,
    prefix: counters.prefixProofAttempted,
    replayAttempted: counters.replayAttempted,
    replayCompleted: counters.replayCompleted,
  }
}

interface DirectHistoryDeps {
  profileContext: () => HistorySearchProfileContextLike | undefined
  sessionPersistence: () => HistorySearchPersistenceLike | undefined
  sessionQuery: () => HistorySearchQueryLike | undefined
  sessions: () => HistorySearchSessionsLike | undefined
  revisionAuthority?: (persistence: HistorySearchPersistenceLike, signal: AbortSignal) => Promise<HistoryRevisionAuthority | undefined>
}

function directService(ctx: Context, deps: DirectHistoryDeps, profileDir: string): PiTuiHistorySearchHostService {
  const controller = new AbortController()
  const invocationCtx = ctx.extend({
    invocation: {
      peer: { principal: { kind: 'owner' }, signal: controller.signal } as never,
      signal: controller.signal,
    } as never,
  })
  return new PiTuiHistorySearchHostService(invocationCtx, {
    ...deps,
    profileContext: () => ({ dir: profileDir }) as HistorySearchProfileContextLike,
  })
}

async function waitDirectReady(service: PiTuiHistorySearchHostService, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    const answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    if (answer.kind === 'ready') return
    if (answer.kind === 'unavailable') throw new Error(`direct index unavailable: ${JSON.stringify(answer)}`)
    if (Date.now() - started > timeoutMs) throw new Error('direct index readiness timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('a replaced header, a durable tail shrink and a vanished Session are re-read instead of trusted', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-reconcile-')
  const source = mutableSource('/repo/original')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  try {
    await waitDirectReady(service)
    assert.equal((await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)).kind, 'ready')

    // A replaced Session header (same id, different cwd) forces a rebuild and
    // the occurrence follows the OFFICIAL event-time directories.
    source.header = testHeader('mutable-session', '/repo/replaced')
    source.revision += 1
    await verify()
    const replaced = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(replaced.kind, 'ready', JSON.stringify(replaced))
    if (replaced.kind !== 'ready') throw new Error('expected ready')
    assert.equal(replaced.items[0]?.effectiveCwd, '/repo/replaced')

    // A durable tail shrink drops the derived row that no longer has an
    // official event; the answer stays authoritative, never fabricated.
    source.events = source.events.slice(0, 1)
    source.revision += 1
    await verify()
    const shrunk = await service.search({ scope: 'all', query: 'mutable second', limit: 25 }, new AbortController().signal)
    assert.equal(shrunk.kind, 'ready', JSON.stringify(shrunk))
    if (shrunk.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(shrunk.items, [])

    // A Session that disappeared from the authoritative source removes its
    // derived rows instead of presenting rows it can no longer prove.
    source.present = false
    source.revision += 1
    await verify()
    const vanished = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(vanished.kind, 'ready', JSON.stringify(vanished))
    if (vanished.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(vanished.items, [])
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a disposed Session keeps its rows until the durable source proves them', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-disposed-')
  const source = mutableSource('/repo/disposed')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const disposeSession = (id: string) => (service as unknown as {
    observeDisposedSession(session: unknown): void
  }).observeDisposedSession({ id })
  try {
    await waitDirectReady(service)

    // The durable source still lists the Session: the rows stay and the
    // checkpoint becomes `persisted`.
    source.present = true
    source.revision += 1
    disposeSession('mutable-session')
    await new Promise(resolve => setTimeout(resolve, 25))
    await waitDirectReady(service)
    const durable = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(durable.kind, 'ready', JSON.stringify(durable))
    if (durable.kind !== 'ready') throw new Error('expected ready')
    assert.equal(durable.items.length, 1)

    // The durable source does NOT list it: the rows are never claimed as an
    // authoritative empty result — the index reports the honest uncertainty.
    source.present = false
    source.revision += 1
    disposeSession('mutable-session')
    let uncertain: HistorySearchResponse | undefined
    const started = Date.now()
    while (Date.now() - started < 5_000) {
      uncertain = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
      if (uncertain.kind === 'incomplete') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(uncertain?.kind, 'incomplete', JSON.stringify(uncertain))
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a disposed Session is verified by one point lookup, never a corpus scan', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-disposal-point-')
  const source = mutableSource('/repo/disposal-point')
  const { deps, calls } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const disposeSession = (id: string) => (service as unknown as {
    observeDisposedSession(session: unknown): void
  }).observeDisposedSession({ id })
  const checkpoint = () => (service as unknown as {
    index: { checkpointOf(sessionId: string): { sourceState: string; dirty: boolean } | undefined }
  }).index.checkpointOf('mutable-session')
  const settledWrites = async () => {
    await Promise.allSettled([...(service as unknown as {
      sessionRepairFlights: Map<string, { promise: Promise<void> }>
    }).sessionRepairFlights.values()].map(entry => entry.promise))
    await (service as unknown as { writeTail: Promise<void> }).writeTail
  }
  try {
    await waitDirectReady(service)

    const listCallsBefore = calls.listCalls()
    const statCallsBefore = calls.statCalls()
    const statIdsBefore = calls.statIds().length
    disposeSession('mutable-session')
    await settledWrites()

    assert.equal(calls.listCalls(), listCallsBefore, 'one Session disposal must not enumerate the whole corpus')
    assert.equal(calls.statCalls(), statCallsBefore + 1, 'the disposal must read exactly one official snapshot')
    assert.deepEqual(calls.statIds().slice(statIdsBefore), ['mutable-session'], 'the point lookup must receive the exact disposed id')
    assert.equal(checkpoint()?.sourceState, 'persisted')
    assert.equal(checkpoint()?.dirty, false)
    const found = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(found.kind, 'ready', JSON.stringify(found))
    if (found.kind !== 'ready') throw new Error('expected ready')
    assert.equal(found.items.length, 1, 'the proven occurrence must remain searchable exactly once')

    // Control: a disposed id this index never held performs NO official read
    // and never turns an existing Session into a fabricated empty history.
    disposeSession('mutable-session-without-checkpoint')
    await settledWrites()
    assert.equal(calls.statCalls(), statCallsBefore + 1, 'a checkpoint-less disposal must not call stat')
    assert.equal(calls.listCalls(), listCallsBefore)
    assert.deepEqual(calls.statIds().slice(statIdsBefore), ['mutable-session'])
    const stillThere = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(stillThere.kind, 'ready', JSON.stringify(stillThere))
    if (stillThere.kind !== 'ready') throw new Error('expected ready')
    assert.equal(stillThere.items.length, 1, 'an unknown disposal must not clear an existing occurrence')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

async function waitDirectSettled(
  service: PiTuiHistorySearchHostService,
  timeoutMs = 15_000,
): Promise<HistorySearchResponse> {
  const started = Date.now()
  for (;;) {
    const answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    if (answer.kind !== 'loading') return answer
    if (Date.now() - started > timeoutMs) throw new Error('direct index settle timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function liveSessionOf(source: MutableOfficialSource): { id: unknown; header: { cwd?: string }; inheritedEventCount: number } {
  return { id: source.header.id, header: source.header, inheritedEventCount: 0 }
}

test('a gapped, malformed or tail-truncated official batch is incomplete, never a silent success', async (t) => {
  const scenarios: ReadonlyArray<{
    readonly name: string
    readonly mutate: (source: MutableOfficialSource) => void
    /** A refused replay must not leave a fabricated empty checkpoint behind. */
    readonly expectNoCheckpoint?: boolean
  }> = [
    {
      name: 'sequence gap',
      mutate: (source) => {
        source.events = [source.events[0]!, source.events[2]!]
      },
    },
    {
      name: 'advertised tail truncation',
      mutate: (source) => {
        source.events = [source.events[0]!, source.events[1]!]
        source.eventCount = 3
      },
    },
    {
      name: 'malformed event',
      mutate: (source) => {
        source.events = [source.events[0]!, { type: 'user/message', seq: 1, time: Number.NaN, data: {} }]
      },
    },
    {
      name: 'empty source with an advertised count',
      mutate: (source) => {
        source.events = []
        source.eventCount = 1
      },
      expectNoCheckpoint: true,
    },
  ]
  for (const scenario of scenarios) {
    const life = testLifecycle(t)
    const profileDir = life.tempDir('dsh-history-search-broken-')
    const source = mutableSource(`/repo/${scenario.name.replaceAll(' ', '-')}`)
    scenario.mutate(source)
    const { deps } = mutableDeps(source)
    const ctx = new Context()
    const service = directService(ctx, deps, profileDir)
    try {
      const answer = await waitDirectSettled(service)
      assert.equal(answer.kind, 'incomplete', `${scenario.name}: ${JSON.stringify(answer)}`)
      if (answer.kind !== 'incomplete') throw new Error('expected incomplete')
      assert.ok(answer.reason === 'source-read-failed' || answer.reason === 'reconciling',
        `${scenario.name}: unexpected reason ${answer.reason}`)
      if (scenario.expectNoCheckpoint === true) {
        const checkpoint = (service as unknown as {
          index: { checkpointOf(id: string): unknown }
        }).index.checkpointOf(String(source.header.id))
        assert.equal(checkpoint, undefined,
          `${scenario.name}: a refused replay must not fabricate an empty checkpoint`)
      }
    } finally {
      await service.dispose()
      await ctx.fiber.dispose()
    }
  }
})

test('a conflicting duplicate live sequence discards the buffer and rebuilds from the official source', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-live-conflict-')
  const source = mutableSource('/repo/live-conflict')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const deliver = (event: unknown) => (service as unknown as {
    observeLiveEvent(session: unknown, event: unknown): void
  }).observeLiveEvent(liveSessionOf(source), event)
  try {
    await waitDirectReady(service)
    const official = source.events[0]!
    // The first delivery is the real official event; the second reuses its seq
    // with a DIFFERENT body (a re-delivery / replaced Session conflict).
    deliver(official)
    deliver({
      type: 'user/message',
      seq: official.seq,
      time: 9999,
      data: {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'conflict body must never be indexed' }],
        source: { kind: 'user', rpcId: 'rpc-1' },
      },
    })
    await waitDirectReady(service)
    const original = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    const conflict = await service.search({ scope: 'all', query: 'conflict body', limit: 25 }, new AbortController().signal)
    assert.equal(original.kind, 'ready', JSON.stringify(original))
    assert.equal(conflict.kind, 'ready', JSON.stringify(conflict))
    if (original.kind !== 'ready' || conflict.kind !== 'ready') throw new Error('expected ready')
    assert.equal(original.items.length, 1)
    assert.equal(original.items[0]?.acceptedAt, 1000, 'the official first acceptance must win')
    assert.deepEqual(conflict.items, [])
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('the live buffer counts real UTF-8 bytes and reconciles without losing entries', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-utf8-bound-')
  const source: MutableOfficialSource = {
    present: true,
    header: testHeader('big-session', '/repo/big'),
    events: [],
    revision: 1,
    live: true,
  }
  const bigEvent = (index: number) => ({
    type: 'agent/inbox/spliced',
    seq: index,
    time: 1000 + index,
    data: {
      target: 'next-turn',
      start: index,
      inserted: [{
        id: `big-msg-${String(index)}`,
        role: 'user',
        content: [{ type: 'text', text: `${'中'.repeat(3_000_000)} big-live-${String(index)}` }],
        source: { kind: 'user', rpcId: `rpc-big-${String(index)}` },
      }],
    },
  })
  source.events.push(bigEvent(0), bigEvent(1))
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const deliver = (event: unknown) => (service as unknown as {
    observeLiveEvent(session: unknown, event: unknown): void
  }).observeLiveEvent(liveSessionOf(source), event)
  try {
    await waitDirectReady(service, 60_000)
    // 2 x ~9 MiB UTF-8: the real byte budget MUST overflow, while a UTF-16
    // unit count (~6M) would not.
    source.events.push(bigEvent(2), bigEvent(3))
    source.revision += 1
    deliver(bigEvent(2))
    deliver(bigEvent(3))
    assert.ok((service as unknown as { bufferOverflows: number }).bufferOverflows >= 1,
      'the UTF-8 byte budget must trip the bounded buffer')
    await waitDirectReady(service, 60_000)
    const newest = await service.search({ scope: 'session', sessionId: 'big-session', query: 'big-live-3', limit: 25 }, new AbortController().signal)
    const first = await service.search({ scope: 'session', sessionId: 'big-session', query: 'big-live-0', limit: 25 }, new AbortController().signal)
    assert.equal(newest.kind, 'ready', JSON.stringify(newest))
    assert.equal(first.kind, 'ready', JSON.stringify(first))
    if (newest.kind !== 'ready' || first.kind !== 'ready') throw new Error('expected ready')
    assert.equal(newest.items.length, 1, 'the overflow reconcile dropped the triggering row')
    assert.equal(first.items.length, 1, 'the overflow reconcile dropped an earlier row')
    assert.ok(newest.items[0]!.contentLength > 3_000_000)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a failed index write answers incomplete instead of a silent success', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-write-failure-')
  const source = mutableSource('/repo/write-failure')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const deliver = (event: unknown) => (service as unknown as {
    observeLiveEvent(session: unknown, event: unknown): void
  }).observeLiveEvent(liveSessionOf(source), event)
  try {
    await waitDirectReady(service)
    // Simulate an unavailable writer (the same observable class as a full
    // disk): the next serial write fails, never a fabricated ready page.
    ;(service as unknown as { index: { close(): void } }).index.close()
    const nextEvent = {
      type: 'agent/inbox/spliced' as const,
      seq: 3,
      time: 4000,
      data: {
        target: 'next-turn',
        start: 2,
        inserted: [{
          id: 'msg-4',
          role: 'user',
          content: [{ type: 'text', text: 'write must fail' }],
          source: { kind: 'user', rpcId: 'rpc-4' },
        }],
      },
    }
    source.events.push(nextEvent)
    source.revision += 1
    deliver(nextEvent)
    const answer = await waitDirectSettled(service)
    assert.equal(answer.kind, 'incomplete', JSON.stringify(answer))
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an unsafe sidecar keeps the index closed until a later write proves it safe', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-sidecar-fault-')
  const source = mutableSource('/repo/sidecar-fault')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const deliver = (event: unknown) => (service as unknown as {
    observeLiveEvent(session: unknown, event: unknown): void
  }).observeLiveEvent(liveSessionOf(source), event)
  const dbPath = join(profileDir, '.dsh-pi-tui', 'history-search', 'v3.sqlite')
  const walPath = `${dbPath}-wal`
  try {
    await waitDirectReady(service)
    assert.ok(existsSync(walPath), 'the open WAL must exist so its mode can be tampered')
    chmodSync(walPath, 0o644)

    const tamperedEvent = {
      type: 'agent/inbox/spliced' as const,
      seq: 3,
      time: 4000,
      data: {
        target: 'next-turn',
        start: 2,
        inserted: [{
          id: 'msg-4',
          role: 'user',
          content: [{ type: 'text', text: 'must fail on the unsafe sidecar' }],
          source: { kind: 'user', rpcId: 'rpc-4' },
        }],
      },
    }
    source.events.push(tamperedEvent)
    source.revision += 1
    deliver(tamperedEvent)
    const faulted = await waitDirectSettled(service)
    assert.equal(faulted.kind, 'incomplete', JSON.stringify(faulted))

    // A read-only verification pass must NOT promote the unsafe store back to
    // ready; every short write it attempts hits the same private-file refusal.
    // The ONE writer classifies that failure and its `failed` receipt keeps the
    // index closed instead of claiming the pass completed.
    const writerCounters = () => (service as unknown as { writerCounters: { failed: number } }).writerCounters
    const writerFailedBefore = writerCounters().failed
    await (service as unknown as { verifySources(): Promise<void> }).verifySources()
    assert.ok(writerCounters().failed > writerFailedBefore,
      'the verification pass must report the refused short write through the writer receipt')
    const stillClosed = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(stillClosed.kind, 'incomplete', JSON.stringify(stillClosed))

    // Restoring the private mode lets a later successful write prove safety.
    chmodSync(walPath, 0o600)
    const recoveryEvent = {
      type: 'agent/inbox/spliced' as const,
      seq: 4,
      time: 5000,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'msg-5',
          role: 'user',
          content: [{ type: 'text', text: 'recovered sidecar write' }],
          source: { kind: 'user', rpcId: 'rpc-5' },
        }],
      },
    }
    source.events.push(recoveryEvent)
    source.revision += 1
    deliver(recoveryEvent)
    // The failed round's full traversal never completed. The successful live
    // write proves the store safe; a complete full pass is still the proof that
    // closes the round and publishes ready.
    await (service as unknown as { verifySources(): Promise<void> }).verifySources()
    await waitDirectReady(service)
    const recovered = await service.search({ scope: 'all', query: 'recovered sidecar', limit: 25 }, new AbortController().signal)
    assert.equal(recovered.kind, 'ready', JSON.stringify(recovered))
    if (recovered.kind !== 'ready') throw new Error('expected ready')
    assert.equal(recovered.items.length, 1)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a middle-body revision change rebuilds instead of trusting the unchanged tail', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-revision-repair-')
  const source = mutableSource('/repo/revision-repair')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  try {
    await waitDirectReady(service)
    const before = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(before.kind, 'ready')
    if (before.kind !== 'ready') throw new Error('expected ready')
    assert.equal(before.items.length, 1)

    // Same header, same seq/type/time/count; ONLY the FIRST accepted body and
    // the persistence revision changed. The LAST event is byte-identical, so a
    // replay that trusts the tail hash alone would keep the stale old body.
    source.events = [
      {
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1000,
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{
            id: 'msg-1',
            role: 'user',
            content: [{ type: 'text', text: 'repaired first body' }],
            source: { kind: 'user', rpcId: 'rpc-1' },
          }],
        },
      },
      source.events[1]!,
      source.events[2]!,
    ]
    source.revision += 1
    await verify()
    await waitDirectReady(service)

    const oldText = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    const newText = await service.search({ scope: 'all', query: 'repaired first', limit: 25 }, new AbortController().signal)
    assert.equal(oldText.kind, 'ready', JSON.stringify(oldText))
    assert.equal(newText.kind, 'ready', JSON.stringify(newText))
    if (oldText.kind !== 'ready' || newText.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(oldText.items, [], 'the stale derived body must disappear')
    assert.equal(newText.items.length, 1, 'the repaired official body must become searchable')
    assert.equal(newText.items[0]?.contentSha256, createHash('sha256').update('repaired first body', 'utf8').digest('hex'))
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a synchronous official burst coalesces into ONE drain and loses nothing', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-burst-')
  const source = mutableSource('/repo/burst')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const deliver = (event: unknown) => (service as unknown as {
    observeLiveEvent(session: unknown, event: unknown): void
  }).observeLiveEvent(liveSessionOf(source), event)
  try {
    await waitDirectReady(service)
    const schedulesBefore = (service as unknown as { drainSchedules: number }).drainSchedules
    // ONE synchronous burst (200 official events) publishes before any microtask
    // drains; the queue must coalesce to a single drain task.
    for (let index = 0; index < 200; index += 1) {
      const seq = source.events.length
      const event = {
        type: 'agent/inbox/spliced' as const,
        seq,
        time: 10_000 + index,
        data: {
          target: 'next-turn',
          start: index,
          inserted: [{
            id: `burst-msg-${String(index)}`,
            role: 'user',
            content: [{ type: 'text', text: `burst-text-${String(index)}` }],
            source: { kind: 'user', rpcId: `rpc-burst-${String(index)}` },
          }],
        },
      }
      source.events.push(event)
      source.revision += 1
      deliver(event)
    }
    const schedulesAfter = (service as unknown as { drainSchedules: number }).drainSchedules
    assert.equal(schedulesAfter - schedulesBefore, 1,
      `a synchronous burst must enqueue ONE drain, observed ${String(schedulesAfter - schedulesBefore)}`)
    await waitDirectReady(service)
    const first = await service.search({ scope: 'all', query: 'burst-text-0', limit: 25 }, new AbortController().signal)
    const last = await service.search({ scope: 'all', query: 'burst-text-199', limit: 25 }, new AbortController().signal)
    const page = await service.search({ scope: 'all', query: 'burst-text-', limit: 25 }, new AbortController().signal)
    assert.equal(first.kind, 'ready')
    assert.equal(last.kind, 'ready')
    assert.equal(page.kind, 'ready')
    if (first.kind !== 'ready' || last.kind !== 'ready' || page.kind !== 'ready') throw new Error('expected ready')
    assert.equal(first.items.length, 1, 'the first burst row was lost')
    assert.equal(last.items.length, 1, 'the last burst row was lost')
    assert.equal(page.items.length, 25)
    assert.notEqual(page.nextCursor, null, 'the burst page must have a continuation')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('deleting a derived Session invalidates its keyset cursor', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-delete-cursor-')
  const source = mutableSource('/repo/delete-cursor')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  try {
    await waitDirectReady(service)
    const firstPage = await service.search({ scope: 'session', sessionId: 'mutable-session', query: 'mutable', limit: 1 }, new AbortController().signal)
    assert.equal(firstPage.kind, 'ready', JSON.stringify(firstPage))
    if (firstPage.kind !== 'ready') throw new Error('expected ready')
    assert.equal(firstPage.items.length, 1)
    assert.equal(typeof firstPage.nextCursor, 'string')

    source.present = false
    source.revision += 1
    await verify()
    await waitDirectReady(service)

    const reused = await service.search({
      scope: 'session',
      sessionId: 'mutable-session',
      query: 'mutable',
      limit: 1,
      cursor: firstPage.nextCursor!,
    }, new AbortController().signal)
    assert.equal(reused.kind, 'stale', `a pre-deletion cursor must be stale: ${JSON.stringify(reused)}`)
    if (reused.kind !== 'stale') throw new Error('expected stale')
    assert.equal(reused.reason, 'cursor-stale')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a v2 row-anchor continuation walks every legal long-query match once and rejects a changed context', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-v2-anchor-')
  const longCwd = `/repo/${'d'.repeat(700)}`
  const longSessionId = `history-${'s'.repeat(280)}`
  const query = '长'.repeat(HISTORY_SEARCH_QUERY_MAX_CHARS)
  const source = mutableSource(longCwd, longSessionId)
  const acceptedAt = 1_700_000_000_000
  source.events = Array.from({ length: 30 }, (_, index) => ({
    type: 'agent/inbox/spliced',
    seq: index,
    time: acceptedAt,
    data: {
      target: 'next-turn',
      start: index,
      inserted: [{
        id: `msg-${'m'.repeat(200)}-${String(index)}`,
        role: 'user',
        content: [{ type: 'text', text: `${query} occurrence ${String(index)}` }],
        source: { kind: 'user', rpcId: `rpc-${'r'.repeat(200)}-${String(index)}` },
      }],
    },
  }))
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  try {
    await waitDirectReady(service)
    const request = { scope: 'directory' as const, cwd: longCwd, query, limit: 25 }
    const first = await service.search(request, new AbortController().signal)
    assert.equal(first.kind, 'ready', JSON.stringify(first))
    if (first.kind !== 'ready') throw new Error('expected ready')
    assert.equal(first.items.length, 25)
    assert.equal(typeof first.nextCursor, 'string')
    assert.ok(Buffer.byteLength(first.nextCursor!, 'utf8') < HISTORY_SEARCH_CURSOR_MAX_BYTES,
      'the legal maximum query and directory must fit the opaque cursor')
    const second = await service.search({ ...request, cursor: first.nextCursor! }, new AbortController().signal)
    assert.equal(second.kind, 'ready', JSON.stringify(second))
    if (second.kind !== 'ready') throw new Error('expected ready')
    assert.equal(second.items.length, 5)
    assert.equal(second.nextCursor, null)
    const combined = [...first.items, ...second.items]
    assert.equal(new Set(combined.map(item => item.messageId)).size, 30, 'pages must not lose or duplicate a row')
    assert.deepEqual(combined.map(item => item.firstEventSeq),
      Array.from({ length: 30 }, (_, index) => 29 - index), 'the v2 anchor must preserve the exact Host keyset order')
    assert.ok(combined.every(item => item.contentSha256.length === 64))

    // The request hash binds scope/query/scope id; the anchor is also re-read
    // against the live match set. A changed context or a Host content revision
    // is stale, never a silently re-ranked page.
    const staleContexts: Array<Record<string, unknown>> = [
      { ...request, query: `${query.slice(1)}短`, cursor: first.nextCursor! },
      { scope: 'all', query, limit: 25, cursor: first.nextCursor! },
      { ...request, cursor: Buffer.from(JSON.stringify({
        v: 1,
        incarnation: 'legacy',
        revision: 1,
        scope: 'directory',
        query: 'legacy',
        scopeId: null,
        after: { acceptedAt, sessionId: 'legacy', firstEventSeq: 0, messageId: 'legacy' },
      }), 'utf8').toString('base64url') },
      { ...request, cursor: Buffer.from(JSON.stringify({
        v: 2,
        incarnation: 'anchor',
        revision: 0,
        requestHash: 'a'.repeat(64),
        afterRowId: '9223372036854775808',
      }), 'utf8').toString('base64url') },
    ]
    for (const stale of staleContexts) {
      const answer = await service.search(stale, new AbortController().signal)
      assert.equal(answer.kind, 'stale', JSON.stringify(answer))
    }

    source.events.push({
      type: 'agent/inbox/spliced',
      seq: source.events.length,
      time: acceptedAt + 1,
      data: {
        target: 'next-turn',
        start: source.events.length,
        inserted: [{
          id: `msg-${'m'.repeat(200)}-new`,
          role: 'user',
          content: [{ type: 'text', text: `${query} newest` }],
          source: { kind: 'user', rpcId: `rpc-${'r'.repeat(200)}-new` },
        }],
      },
    })
    source.revision += 1
    await verify()
    const afterRevision = await service.search({ ...request, cursor: first.nextCursor! }, new AbortController().signal)
    assert.equal(afterRevision.kind, 'stale', JSON.stringify(afterRevision))
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a disposed Session without eventCount is not marked persisted without a durable prefix', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-disposed-prefix-')
  const source = mutableSource('/repo/disposed-prefix')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const checkpoint = () => (service as unknown as {
    index: { checkpointOf(sessionId: string): { sourceState: string; dirty: boolean } | undefined }
  }).index.checkpointOf('mutable-session')
  const disposeSession = (id: string) => (service as unknown as {
    observeDisposedSession(session: unknown): void
  }).observeDisposedSession({ id })
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  const occurrences = () => (service as unknown as {
    index: { occurrenceCount(): number }
  }).index.occurrenceCount()
  try {
    await waitDirectReady(service)
    assert.equal(checkpoint()?.sourceState, 'live')

    // rc.5 JSONL: no eventCount, and the official read is durable only through
    // the FIRST event while the live checkpoint already claims three. The
    // absent count must not be read as proof that the live rows are durable.
    source.omitEventCount = true
    source.durableEventCount = 1
    source.revision += 1
    disposeSession('mutable-session')

    let answer: HistorySearchResponse | undefined
    const started = Date.now()
    while (Date.now() - started < 5_000) {
      answer = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
      // The public `incomplete` answer and the retry marker are two short,
      // separately observed facts: wait for the dirty checkpoint too.
      if (answer.kind === 'incomplete' && checkpoint()?.dirty === true) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(answer?.kind, 'incomplete', JSON.stringify(answer))
    assert.equal(checkpoint()?.sourceState, 'live', 'the unproven rows must never be called persisted')
    assert.equal(checkpoint()?.dirty, true, 'the prefix proof failure must be retried')

    // The Session is no longer live, but the durable source is STILL short.
    // The retry must preserve the accepted rows/checkpoint and stay incomplete;
    // rebuilding the short prefix here would publish a false authoritative
    // history and drop the second occurrence.
    source.live = false
    source.revision += 1
    await verify()
    const stillShort = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(stillShort.kind, 'incomplete', JSON.stringify(stillShort))
    assert.equal(checkpoint()?.sourceState, 'live')
    assert.equal(checkpoint()?.dirty, true)
    assert.equal(occurrences(), 2, 'a short durable prefix must not discard accepted rows')

    // Only once the SAME official source exposes the full prefix may the
    // existing verification pass settle the checkpoint and recover ready.
    source.durableEventCount = undefined
    source.revision += 1
    await verify()
    await waitDirectReady(service)
    const recoveredFirst = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    const recoveredSecond = await service.search({ scope: 'all', query: 'mutable second', limit: 25 }, new AbortController().signal)
    assert.equal(recoveredFirst.kind, 'ready', JSON.stringify(recoveredFirst))
    assert.equal(recoveredSecond.kind, 'ready', JSON.stringify(recoveredSecond))
    if (recoveredFirst.kind !== 'ready' || recoveredSecond.kind !== 'ready') throw new Error('expected ready')
    assert.equal(recoveredFirst.items.length, 1, 'the recovered prefix must retain the first accepted occurrence')
    assert.equal(recoveredSecond.items.length, 1, 'the recovered prefix must retain the second accepted occurrence')
    assert.equal(checkpoint()?.dirty, false)
    assert.equal(checkpoint()?.sourceState, 'persisted')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('rebuilding a Session to zero events invalidates the previous cursor', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-empty-rebuild-')
  const source = mutableSource('/repo/empty-rebuild')
  const { deps, calls } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  const index = () => (service as unknown as {
    index: { checkpointOf(id: string): Record<string, unknown> | undefined }
  }).index
  try {
    await waitDirectReady(service)
    const page = await service.search({
      scope: 'session',
      sessionId: 'mutable-session',
      query: 'mutable',
      limit: 1,
    }, new AbortController().signal)
    assert.equal(page.kind, 'ready', JSON.stringify(page))
    if (page.kind !== 'ready') throw new Error('expected ready')
    assert.equal(typeof page.nextCursor, 'string')

    // The Session still exists officially but its event log is rebuilt empty:
    // a reset/rebuild that inserts no rows must still advance the generation.
    source.events = []
    source.revision += 1
    await verify()
    await waitDirectReady(service)

    // The completed empty replay now settles a REAL zero-event checkpoint from
    // the official Header/cut facts instead of leaving the Session row-less.
    assert.deepEqual(index().checkpointOf('mutable-session'), {
      sessionId: 'mutable-session',
      headerCwd: '/repo/empty-rebuild',
      inheritedCut: 0,
      nextSeq: 0,
      effectiveCwd: '/repo/empty-rebuild',
      lastEventHash: null,
      headerHash: sessionHeaderHash(source.header),
      sourceState: 'persisted',
      uncertainSources: 0,
      dirty: false,
    })

    const reused = await service.search({
      scope: 'session',
      sessionId: 'mutable-session',
      query: 'mutable',
      limit: 1,
      cursor: page.nextCursor!,
    }, new AbortController().signal)
    assert.equal(reused.kind, 'stale', `an empty rebuild must invalidate the old cursor: ${JSON.stringify(reused)}`)
    if (reused.kind !== 'stale') throw new Error('expected stale')
    assert.equal(reused.reason, 'cursor-stale')
    const gone = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(gone.kind, 'ready', JSON.stringify(gone))
    if (gone.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(gone.items, [], 'the rolled-back text must no longer be answerable')

    // The zero-event checkpoint is a settled fact: one unchanged verification
    // pass must not open/observe/replay this Session again.
    const openBefore = calls.openCalls()
    const observeBefore = calls.observeCalls()
    await verify()
    assert.equal(calls.openCalls(), openBefore, 'a stable empty checkpoint must not re-open the official source')
    assert.equal(calls.observeCalls(), observeBefore, 'a stable empty checkpoint must not re-observe a live source')
    assert.equal(index().checkpointOf('mutable-session')?.nextSeq, 0)
    assert.equal((await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)).kind, 'ready')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an empty cold source that changes during its final currentness proof writes no checkpoint and recovers later', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-empty-revision-')
  const source: MutableOfficialSource = {
    present: true,
    header: testHeader('empty-revision', '/repo/empty-revision'),
    events: [],
    revision: 1,
  }
  const { deps } = mutableDeps(source)
  const persistence = deps.sessionPersistence()
  const realStat = persistence.stat
  let changedDuringProof = false
  persistence.stat = async (id, options) => {
    // The official source advances between the completed handle read and the
    // final same-instance currentness re-check: the REAL production stat seam.
    if (!changedDuringProof && String(id) === 'empty-revision') {
      changedDuringProof = true
      source.revision += 1
    }
    return realStat.call(persistence, id, options)
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const index = () => (service as unknown as { index: { checkpointOf(id: string): unknown } }).index
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  try {
    const settled = await waitDirectSettled(service)
    assert.equal(changedDuringProof, true, 'the negative control must really change the source at the currentness seam')
    assert.equal(settled.kind, 'incomplete', JSON.stringify(settled))
    assert.equal(index().checkpointOf('empty-revision'), undefined,
      'a stale terminal must never publish an empty checkpoint for a source it did not prove current')

    // The stable next official pass creates the real zero-event checkpoint.
    await verify()
    await waitDirectReady(service)
    assert.deepEqual(index().checkpointOf('empty-revision'), {
      sessionId: 'empty-revision',
      headerCwd: '/repo/empty-revision',
      inheritedCut: 0,
      nextSeq: 0,
      effectiveCwd: '/repo/empty-revision',
      lastEventHash: null,
      headerHash: sessionHeaderHash(source.header),
      sourceState: 'persisted',
      uncertainSources: 0,
      dirty: false,
    })
    const answer = await service.search({ scope: 'all', query: 'empty', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
    if (answer.kind !== 'ready') throw new Error('expected ready')
    assert.deepEqual(answer.items, [])
  } finally {
    persistence.stat = realStat
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an empty terminal write failure keeps the barrier and recovers through the production writer', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-empty-write-failure-')
  const source: MutableOfficialSource = {
    present: true,
    header: testHeader('empty-write-failure', '/repo/empty-write-failure'),
    events: [],
    revision: 1,
  }
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: {
      checkpointOf(id: string): unknown
      commitBatch(input: unknown): void
    }
    writerCounters: { failed: number }
    verifySources(): Promise<void>
  }
  const realCommit = internals.index.commitBatch
  let armed = true
  internals.index.commitBatch = function (input: unknown) {
    if (armed) {
      armed = false
      throw new Error('injected empty terminal write failure')
    }
    realCommit.call(this, input)
  }
  const verify = () => internals.verifySources()
  try {
    const failedBefore = internals.writerCounters.failed
    const settled = await waitDirectSettled(service)
    assert.equal(settled.kind, 'incomplete', JSON.stringify(settled))
    assert.ok(internals.writerCounters.failed > failedBefore,
      'the empty terminal failure must be classified by the production writer receipt')
    assert.equal(internals.index.checkpointOf('empty-write-failure'), undefined,
      'a failed empty commit must not leave a checkpoint behind')
    const stillIncomplete = await service.search({ scope: 'all', query: 'empty', limit: 25 }, new AbortController().signal)
    assert.equal(stillIncomplete.kind, 'incomplete', 'an uncommitted empty source must never answer a ready empty list')

    await verify()
    await waitDirectReady(service)
    assert.deepEqual(internals.index.checkpointOf('empty-write-failure'), {
      sessionId: 'empty-write-failure',
      headerCwd: '/repo/empty-write-failure',
      inheritedCut: 0,
      nextSeq: 0,
      effectiveCwd: '/repo/empty-write-failure',
      lastEventHash: null,
      headerHash: sessionHeaderHash(source.header),
      sourceState: 'persisted',
      uncertainSources: 0,
      dirty: false,
    })
    const recovered = await service.search({ scope: 'all', query: 'empty', limit: 25 }, new AbortController().signal)
    assert.equal(recovered.kind, 'ready', JSON.stringify(recovered))
  } finally {
    internals.index.commitBatch = realCommit
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a disposal during the disposed-session prefix proof never mutates the closed index', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-proof-abort-')
  const source = mutableSource('/repo/proof-abort')
  source.live = true
  const { deps } = mutableDeps(source)
  let proofStarted!: () => void
  const started = new Promise<void>(resolve => { proofStarted = resolve })
  let releaseProof!: () => void
  const gate = new Promise<void>(resolve => { releaseProof = resolve })
  const persistence = deps.sessionPersistence()
  assert.ok(persistence !== undefined)
  const blockedPersistence = {
    ...persistence,
    async open(sessionId: string, mode: 'read', options?: { readonly signal?: AbortSignal }) {
      proofStarted()
      await gate
      options?.signal?.throwIfAborted()
      return persistence.open(sessionId, mode, options)
    },
  }
  const ctx = new Context()
  const service = directService(ctx, { ...deps, sessionPersistence: () => blockedPersistence }, profileDir)
  const proof = () => (service as unknown as {
    verifySessionAgainstPersistence(sessionId: string): Promise<void>
  }).verifySessionAgainstPersistence('mutable-session')
  try {
    await waitDirectReady(service)
    const pending = proof()
    await started
    await service.dispose()
    releaseProof()
    await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('one official enumeration merges the live registry without a second persisted listing', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-enumeration')
  try {
    await wire.host.harness.create(SessionId('history-enum-live'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-enum-live', 'req-enum-live', 'hsp-enum-live')
    // A live-only Session: announced but without a durable accepted prompt yet.
    await wire.host.harness.create(SessionId('history-enum-live-only'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    // A durable Session that is no longer live after its AgentHandle disposal.
    const durable = await wire.host.ctx.agents.create({
      sessionId: SessionId('history-enum-durable'),
      agentOptions: { provider: 'smoke', model: 'smoke' },
      meta: { cwd: wire.host.anchorDir },
    })
    await prompt(wire, 'history-enum-durable', 'req-enum-durable', 'hsp-enum-durable')
    await waitForReady(wire, 'enumeration index')
    await durable.dispose()
    // The disposal proof is a repair owned by the maintenance chain; run the
    // same production pass explicitly instead of waiting the 30 s cadence.
    await (wire.service() as unknown as { verifySources(): Promise<void> }).verifySources()
    await waitForReady(wire, 'enumeration after disposal')

    const ctx = wire.host.ctx
    const rawQuery = ctx.sessionQuery
    const rawSessions = ctx.sessions as unknown as HistorySearchSessionsLike
    const rawPersistence = ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
    let listCalls = 0
    const counting: HistorySearchPersistenceLike = {
      identity: rawPersistence.identity,
      list: (options) => {
        listCalls += 1
        return rawPersistence.list(options)
      },
      stat: (id, options) => rawPersistence.stat(id, options),
      open: (id, access, options) => rawPersistence.open(id, access, options),
    }
    const originalQueryList = rawQuery.listSessions
    let queryListCalls = 0
    rawQuery.listSessions = function (...args: never[]) {
      queryListCalls += 1
      return originalQueryList.apply(this, args as unknown as [AbortSignal?])
    }
    let merged: Map<string, { readonly header: SessionHeader; readonly live: boolean }>
    try {
      const service = wire.service() as unknown as {
        enumerateOfficialSessions(
          persistence: HistorySearchPersistenceLike,
          sessions: HistorySearchSessionsLike,
          signal: AbortSignal,
          phase: 'periodic_verify',
        ): Promise<Map<string, { readonly header: SessionHeader; readonly live: boolean }>>
      }
      merged = await service.enumerateOfficialSessions(counting, rawSessions, new AbortController().signal, 'periodic_verify')
      assert.equal(listCalls, 1, 'one PiTui enumeration must make exactly one persisted listing')
      assert.equal(queryListCalls, 0, 'the production enumeration must not call sessionQuery.listSessions')
    } finally {
      rawQuery.listSessions = originalQueryList
    }

    // The independent DSH `SessionCorpus` result is the oracle for ids, exact
    // headers and live precedence (its own extra listing is outside the count).
    const oracle = new Map<string, { header: SessionHeader; live: boolean }>()
    for (const record of await rawQuery.listSessions()) oracle.set(String(record.header.id), record)
    assert.deepEqual([...merged.keys()].sort(), [...oracle.keys()].sort(), 'the merged corpus must name the same Sessions')
    for (const [sessionId, record] of merged) {
      const expected = oracle.get(sessionId)
      assert.ok(expected !== undefined, `the oracle must know ${sessionId}`)
      assert.deepEqual(record.header, expected.header, `exact header equivalence for ${sessionId}`)
      assert.equal(record.live, expected.live, `live precedence equivalence for ${sessionId}`)
    }
    assert.equal(merged.get('history-enum-live')?.live, true)
    assert.equal(merged.get('history-enum-live-only')?.live, true)
    assert.equal(merged.get('history-enum-durable')?.live, false)
  } finally {
    await wire.dispose()
  }
})

test('a periodic full pass makes one persisted listing and no second query listing', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-periodic-count')
  try {
    await wire.host.harness.create(SessionId('history-count'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-count', 'req-count', 'hsp-periodic-count')
    await waitForReady(wire, 'count index')

    const ctx = wire.host.ctx
    const rawPersistence = ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
    let listCalls = 0
    const internals = wire.service() as unknown as {
      verifySources(): Promise<void>
    }
    // Patch the ACTUAL service instance in place: replacing the deps closure
    // would be a different raw service object and therefore a real binding
    // replacement (which correctly invalidates coverage).
    const originalList = rawPersistence.list
    const originalQueryList = ctx.sessionQuery.listSessions
    let queryListCalls = 0
    rawPersistence.list = function patchedList(options) {
      listCalls += 1
      return originalList.call(rawPersistence, options)
    }
    ctx.sessionQuery.listSessions = function (...args: never[]) {
      queryListCalls += 1
      return originalQueryList.apply(this, args as unknown as [AbortSignal?])
    }
    try {
      await internals.verifySources()
    } finally {
      rawPersistence.list = originalList
      ctx.sessionQuery.listSessions = originalQueryList
    }
    assert.equal(listCalls, 1, 'one full pass must make exactly one persisted listing')
    assert.equal(queryListCalls, 0, 'the full pass must not enumerate through sessionQuery.listSessions')
    assert.equal((await wire.search({ scope: 'all', query: 'hsp-periodic-count', limit: 5 })).kind, 'ready')
  } finally {
    await wire.dispose()
  }
})

test('an Owner search and exact readText complete while the periodic persisted listing is blocked', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-blocked-list')
  try {
    const text = 'hsp-blocked-list-still-searchable'
    await wire.host.harness.create(SessionId('history-blocked-list'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-blocked-list', 'req-blocked-list', text)
    // ONE unrelated live Session: it exists only so a CONCURRENT point repair
    // can be admitted inside the held full-pass window.
    await wire.host.harness.create(SessionId('history-blocked-list-other'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, 'history-blocked-list-other', 'req-blocked-list-other', 'hsp-blocked-concurrent-other')
    const ready = await waitForSettled(
      wire,
      { scope: 'session', sessionId: 'history-blocked-list', query: 'hsp-blocked-list', limit: 25 },
      'blocked-list readiness',
    )
    assert.equal(ready.kind, 'ready', JSON.stringify(ready))
    if (ready.kind !== 'ready') throw new Error('expected ready')
    const item = ready.items[0]!

    const ctx = wire.host.ctx
    const rawPersistence = ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
    let enteredList!: () => void
    const listEntered = new Promise<void>(resolve => { enteredList = resolve })
    let releaseList!: () => void
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    const internals = wire.service() as unknown as {
      verifySources(): Promise<void>
      pointCounters: PointCountersLike
      sessionRepairFlights: Map<string, { promise: Promise<void> }>
      scheduleSessionRepair(sessionId: string, kind: 'rebuild' | 'disposal'): void
    }
    // Patch the ACTUAL list method so the block cannot be mistaken for a
    // replaced service binding (which would legitimately invalidate coverage).
    const originalList = rawPersistence.list
    rawPersistence.list = async function blockedList(options) {
      enteredList()
      await listGate
      return originalList.call(rawPersistence, options)
    }
    let pointAfterConcurrentRepair: ReturnType<typeof pointCountersOf> | undefined
    const pass = internals.verifySources()
    await listEntered
    try {
      // The persisted list Promise is STILL blocked: both Owner reads must
      // complete from the already-complete SQLite epoch without waiting.
      const search = await wire.search({ scope: 'all', query: 'hsp-blocked-list', limit: 25 })
      assert.equal(search.kind, 'ready', JSON.stringify(search))
      if (search.kind !== 'ready') throw new Error('expected ready')
      assert.deepEqual(search.items.map(row => row.messageId), [item.messageId])
      const chunk = await wire.readText({
        sessionId: item.sessionId,
        messageId: item.messageId,
        contentSha256: item.contentSha256,
        offset: 0,
        limit: 4096,
      })
      assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
      if (chunk.kind !== 'ready') throw new Error('expected ready')
      assert.equal(chunk.chunk, text)

      // A concurrent point repair of an UNRELATED id, admitted while the full
      // pass is still held inside its persisted listing. Its direct calls must
      // land in the point scope only, exactly once each.
      const pointBefore = pointCountersOf(internals.pointCounters)
      internals.scheduleSessionRepair('history-blocked-list-other', 'rebuild')
      const pointFlights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      assert.ok(pointFlights.length > 0, 'the concurrent point repair must be registered')
      await Promise.allSettled(pointFlights)
      const pointAfter = pointCountersOf(internals.pointCounters)
      assert.deepEqual({
        stat: pointAfter.stat - pointBefore.stat,
        open: pointAfter.open - pointBefore.open,
        observe: pointAfter.observe - pointBefore.observe,
        prefix: pointAfter.prefix - pointBefore.prefix,
        replayAttempted: pointAfter.replayAttempted - pointBefore.replayAttempted,
        replayCompleted: pointAfter.replayCompleted - pointBefore.replayCompleted,
      }, {
        stat: 0,
        open: 0,
        observe: 1,
        prefix: 0,
        replayAttempted: 1,
        replayCompleted: 1,
      }, 'the concurrent point repair must own exactly its own live observation and replay')
      pointAfterConcurrentRepair = pointAfter
    } finally {
      rawPersistence.list = originalList
      releaseList()
      await pass
    }
    // The full pass's own post-release work never lands in the point scope.
    assert.deepEqual(pointCountersOf(internals.pointCounters), pointAfterConcurrentRepair,
      'the full phase must keep its own direct calls out of the point scope')
    assert.equal((await wire.search({ scope: 'all', query: 'hsp-blocked-concurrent-other', limit: 25 })).kind, 'ready')
  } finally {
    await wire.dispose()
  }
})

test('a live/persisted Header conflict fails closed with the official SOURCE_CONFLICT', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-header-conflict-')
  const source = mutableSource('/repo/header-conflict')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  try {
    await waitDirectReady(service)
    // Same id, conflicting immutable Header fact: the official compatibility
    // check must reject the whole enumeration, not silently prefer one side.
    source.persistedHeader = source.header
    source.header = testHeader('mutable-session', '/repo/header-conflict', { createdAt: source.header.createdAt + 1 })
    await assert.rejects(
      verify(),
      (error: unknown) => (error as { code?: string }).code === 'SESSION_QUERY_SOURCE_CONFLICT',
    )
    const answer = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'incomplete', JSON.stringify(answer))
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a stale roster deletion is refused while the Session is live again', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-stale-roster-')
  const source = mutableSource('/repo/stale-roster')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  const internals = service as unknown as {
    deps: { sessions(): HistorySearchSessionsLike | undefined }
    index: { occurrenceCount(): number; checkpointOf(id: string): { dirty: boolean } | undefined }
  }
  const occurrences = () => internals.index.occurrenceCount()
  try {
    await waitDirectReady(service)
    assert.equal(occurrences(), 2)

    // The roster goes stale (empty) while the same id is live again: the old
    // deletion candidate must be refused, keeping every accepted row.
    source.present = false
    source.live = true
    const liveObject: HistorySearchLiveSessionLike = { id: source.header.id, header: source.header }
    const staleRegistry: HistorySearchSessionsLike = {
      list: () => [],
      get: (id) => (String(source.header.id) === id ? liveObject : undefined),
    }
    const originalSessions = internals.deps.sessions
    internals.deps.sessions = () => staleRegistry
    try {
      await verify()
    } finally {
      internals.deps.sessions = originalSessions
    }
    const refused = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(refused.kind, 'incomplete', JSON.stringify(refused))
    assert.equal(occurrences(), 2, 'a refused deletion must keep the derived rows')
    assert.equal(internals.index.checkpointOf('mutable-session')?.dirty, false)

    // The consistent authoritative roster now exposes the live Session again;
    // the next pass rebuilds it and the messages survive exactly once.
    source.present = true
    source.revision += 1
    await verify()
    await waitDirectReady(service)
    const first = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    const second = await service.search({ scope: 'all', query: 'mutable second', limit: 25 }, new AbortController().signal)
    assert.equal(first.kind, 'ready', JSON.stringify(first))
    assert.equal(second.kind, 'ready', JSON.stringify(second))
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected ready')
    assert.equal(first.items.length, 1)
    assert.equal(second.items.length, 1)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a stale official read cannot reset or overwrite a replaced live Session source', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-stale-candidate-')
  const source = mutableSource('/repo/stale-candidate')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
  const internals = service as unknown as {
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    index: { occurrenceCount(): number; checkpointOf(id: string): { dirty: boolean } | undefined }
  }
  const occurrences = () => internals.index.occurrenceCount()
  const deliver = (event: unknown) => (service as unknown as {
    observeLiveEvent(session: unknown, event: unknown): void
  }).observeLiveEvent(liveSessionOf(source), event)
  const query = deps.sessionQuery()
  assert.ok(query !== undefined)
  const realObserve = query.observeSession
  let observeEntered!: () => void
  const entered = new Promise<void>(resolve => { observeEntered = resolve })
  let releaseObserve!: () => void
  const gate = new Promise<void>(resolve => { releaseObserve = resolve })
  try {
    await waitDirectReady(service)
    query.observeSession = async (id, options) => {
      // Read the real payload FIRST, then hold it: a later release must return
      // this exact stale snapshot, never a re-read.
      const observation = await realObserve.call(query, id, options)
      observeEntered()
      await gate
      return observation
    }
    // A conflicting duplicate live sequence schedules the official rebuild; it
    // then blocks inside its already-complete observation.
    deliver(source.events[0])
    deliver({
      type: 'user/message',
      seq: 0,
      time: 9999,
      data: { id: 'stale-candidate-conflict', role: 'user', content: [{ type: 'text', text: 'must not be indexed' }], source: { kind: 'user', rpcId: 'rpc-conflict' } },
    })
    await entered

    // The live Session object and its whole log are replaced while the old
    // candidate holds its snapshot.
    source.header = testHeader('mutable-session', '/repo/stale-replaced')
    source.events = [{
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 5000,
      data: {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: 'msg-replaced',
          role: 'user',
          content: [{ type: 'text', text: 'replaced source first' }],
          source: { kind: 'user', rpcId: 'rpc-replaced' },
        }],
      },
    }]
    source.revision += 1
    const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
    releaseObserve()
    await Promise.allSettled(flights)

    // The stale candidate wrote/deleted nothing; the old rows stay provisional
    // and the next official pass rebuilds from the replaced source.
    assert.equal(occurrences(), 2, 'a stale candidate must not reset the committed rows')
    assert.equal(internals.index.checkpointOf('mutable-session')?.dirty, true)
    await verify()
    await waitDirectReady(service)
    const replaced = await service.search({ scope: 'all', query: 'replaced source first', limit: 25 }, new AbortController().signal)
    const stale = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(replaced.kind, 'ready', JSON.stringify(replaced))
    assert.equal(stale.kind, 'ready', JSON.stringify(stale))
    if (replaced.kind !== 'ready' || stale.kind !== 'ready') throw new Error('expected ready')
    assert.equal(replaced.items.length, 1)
    assert.deepEqual(stale.items, [])
  } finally {
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an invalidated zero-event live candidate commits no empty row and the coalesced repair sees the new event', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-empty-live-stale-')
  const source: MutableOfficialSource = {
    present: true,
    header: testHeader('empty-live-stale', '/repo/empty-live-stale'),
    events: [],
    revision: 1,
    live: true,
  }
  const { deps } = mutableDeps(source)
  const query = deps.sessionQuery()
  const realObserve = query.observeSession
  let observeCalls = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  let firstHeld!: () => void
  const firstReached = new Promise<void>(resolve => { firstHeld = resolve })
  let releaseSecond!: () => void
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  let secondHeld!: () => void
  const secondReached = new Promise<void>(resolve => { secondHeld = resolve })
  // The FIRST observation belongs to the bootstrap's cold live replay and is
  // read-then-held, so its release must return the exact zero-event snapshot it
  // read. The SECOND belongs to the coalesced repair and holds the intermediate
  // state. The mutable fixture exposes its LIVE event array, so a held reference
  // would silently observe later source mutations and the released candidate
  // would fail at an ordinary batch fence instead of the empty terminal fence.
  // An official observation is a detached snapshot, so the seam hands the
  // candidate exactly the events it actually read.
  let firstObservedLength = -1
  let firstReleasedLength = -1
  query.observeSession = async (id, options) => {
    observeCalls += 1
    const observation = await realObserve.call(query, id, options)
    const snapshot = {
      header: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
      [Symbol.dispose]: () => observation[Symbol.dispose](),
    }
    if (observeCalls === 1) {
      firstObservedLength = snapshot.events.length
      firstHeld()
      await firstGate
      firstReleasedLength = snapshot.events.length
    } else if (observeCalls === 2) {
      secondHeld()
      await secondGate
    }
    return snapshot
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): unknown; occurrenceCount(): number }
    pending: Map<string, unknown>
    reconcilePending: Set<string>
  }
  // Every latch below is bounded: a candidate that never re-observes must FAIL
  // this case with diagnostics instead of hanging the suite.
  const withinWindow = async (reached: Promise<void>, windowMs = 5_000): Promise<boolean> => (
    Promise.race([
      reached.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), windowMs)),
    ])
  )
  try {
    assert.equal(await withinWindow(firstReached, 10_000), true,
      'the bootstrap zero-event observation must be reached')
    assert.equal(internals.index.checkpointOf('empty-live-stale'), undefined)

    // The official source accepts its FIRST event while the zero-event
    // observation is still held: the candidate must be invalidated in the same
    // synchronous listener stack.
    const accepted = {
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 40_000,
      data: {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: 'empty-live-stale-first',
          role: 'user',
          content: [{ type: 'text', text: 'hsp empty live first event' }],
          source: { kind: 'user', rpcId: 'rpc-empty-live-stale' },
        }],
      },
    }
    source.events.push(accepted)
    source.revision += 1
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), accepted)
    assert.equal(internals.pending.has('empty-live-stale'), true)

    // The candidate read a genuinely EMPTY official observation, the current
    // source has moved on, and the released snapshot is still empty: only the
    // empty terminal fence can reject this candidate (no batch fence runs).
    assert.equal(firstObservedLength, 0, 'the held observation really read zero official events')
    assert.equal(source.events.length, 1, 'the current official source has the new event')

    releaseFirst()
    const repairSeen = await withinWindow(secondReached, 2_000)
    assert.equal(firstReleasedLength, 0, 'the released candidate must replay the snapshot it read, not the mutated source')
    // The stale candidate settled NOTHING: no empty row, no released accepted
    // coverage, and the round keeps the Session outstanding. This must be the
    // FIRST failure of a bypassed empty-terminal fence — no batch fence runs for
    // a zero-event replay, so the empty commit is the only remaining gate.
    assert.equal(internals.index.checkpointOf('empty-live-stale'), undefined,
      'an invalidated zero-event candidate must never publish an empty checkpoint')
    assert.equal(repairSeen, true, 'the coalesced repair must re-observe the current official source')
    assert.equal(internals.index.occurrenceCount(), 0)
    assert.equal(internals.reconcilePending.has('empty-live-stale'), true)
    // The first pass is still the owner, so the truthful intermediate answer is
    // `loading`/`incomplete` — never a ready epoch built from the stale snapshot.
    const intermediate = await service.search({ scope: 'all', query: 'hsp empty live first', limit: 25 }, new AbortController().signal)
    assert.ok(intermediate.kind === 'loading' || intermediate.kind === 'incomplete', JSON.stringify(intermediate))

    releaseSecond()
    await waitDirectReady(service)
    const checkpoint = internals.index.checkpointOf('empty-live-stale') as {
      nextSeq: number
      lastEventHash: string | null
      sourceState: string
      dirty: boolean
      inheritedCut: number
      headerCwd: string | null
      effectiveCwd: string | null
      uncertainSources: number
    }
    assert.equal(checkpoint.nextSeq, 1, 'the repair must replay the CURRENT official source, not the stale snapshot')
    assert.equal(checkpoint.sourceState, 'live')
    assert.equal(checkpoint.dirty, false)
    assert.equal(checkpoint.inheritedCut, 0)
    assert.equal(checkpoint.headerCwd, '/repo/empty-live-stale')
    assert.equal(checkpoint.effectiveCwd, '/repo/empty-live-stale')
    assert.equal(checkpoint.uncertainSources, 0)
    assert.notEqual(checkpoint.lastEventHash, null)
    assert.equal(internals.pending.size, 0)
    const hit = await service.search({ scope: 'all', query: 'hsp empty live first', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
    assert.equal(hit.items[0]?.sessionId, 'empty-live-stale')
  } finally {
    releaseFirst()
    releaseSecond()
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a multi-batch first import stays a truthful loading until the final official batch settles', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-first-import-')
  const message = (index: number) => ({
    id: `import-msg-${String(index)}`,
    role: 'user',
    content: [{ type: 'text', text: `import-text-${String(index)}` }],
    source: { kind: 'user', rpcId: `import-rpc-${String(index)}` },
  })
  const events = Array.from({ length: 600 }, (_, index) => ({
    type: 'agent/inbox/spliced',
    seq: index,
    time: 1000 + index,
    data: { target: 'next-turn', start: index, inserted: [message(index)] },
  }))
  const source: MutableOfficialSource = {
    present: true,
    header: testHeader('import-session', '/repo/import'),
    events,
    revision: 1,
  }
  const { deps } = mutableDeps(source)
  const rawPersistence = deps.sessionPersistence()
  assert.ok(rawPersistence !== undefined)
  let reads = 0
  let secondReadEntered!: () => void
  const secondRead = new Promise<void>(resolve => { secondReadEntered = resolve })
  let releaseSecondRead!: () => void
  const secondReadGate = new Promise<void>(resolve => { releaseSecondRead = resolve })
  const blockedPersistence: HistorySearchPersistenceLike = {
    ...rawPersistence,
    async open(id, access, options) {
      const handle = await rawPersistence.open(id, access, options)
      return {
        ...handle,
        async read(offset, length, readOptions) {
          reads += 1
          if (reads === 2) {
            secondReadEntered()
            await secondReadGate
          }
          return handle.read(offset, length, readOptions)
        },
      }
    },
  }
  const ctx = new Context()
  const service = directService(ctx, { ...deps, sessionPersistence: () => blockedPersistence }, profileDir)
  try {
    // The first 256-event batch may already be committed, but the index is
    // still `loading` because the first complete official pass has not ended.
    await secondRead
    const loading = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    assert.equal(loading.kind, 'loading', JSON.stringify(loading))
    releaseSecondRead()
    await waitDirectReady(service, 30_000)
    const counted = (service as unknown as { index: { occurrenceCount(): number } }).index.occurrenceCount()
    assert.equal(counted, events.length, 'every imported official event must be committed before ready')
    const last = await service.search({ scope: 'all', query: 'import-text-599', limit: 25 }, new AbortController().signal)
    assert.equal(last.kind, 'ready', JSON.stringify(last))
    if (last.kind !== 'ready') throw new Error('expected ready')
    assert.equal(last.items.length, 1)
  } finally {
    releaseSecondRead()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('the cold-start pending drain is admitted by the ONE serial writer', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-cold-writer-')
  const source = mutableSource('/repo/cold-writer')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    enqueueWrite(task: () => void | Promise<void>): Promise<'committed' | 'failed'>
    drainPendingSession(sessionId: string): void
  }
  // Instrument the production writer admission: a drain call made from the
  // cold-start async owner (instead of a writeTail callback) records `false`.
  let insideWriter = false
  const drainAdmissions: boolean[] = []
  const realEnqueue = internals.enqueueWrite
  const realDrain = internals.drainPendingSession
  internals.enqueueWrite = function (task) {
    return realEnqueue.call(this, () => {
      const previous = insideWriter
      insideWriter = true
      try {
        return task()
      } finally {
        insideWriter = previous
      }
    })
  }
  internals.drainPendingSession = function (sessionId) {
    drainAdmissions.push(insideWriter)
    return realDrain.call(this, sessionId)
  }
  try {
    await waitDirectReady(service)
    assert.ok(drainAdmissions.length > 0, 'the cold pass must reach its buffered-batch drain')
    assert.ok(
      drainAdmissions.every(admitted => admitted === true),
      `every cold-start drain must be admitted by writeTail: ${JSON.stringify(drainAdmissions)}`,
    )
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a same-ID live replacement right after enumeration cannot inherit a stale ready epoch', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-post-enumeration-')
  const source = mutableSource('/repo/post-enumeration')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    deps: { sessions(): HistorySearchSessionsLike | undefined }
    index: { checkpointOf(id: string): { dirty: boolean; sourceState: string } | undefined }
    verifySources(): Promise<void>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    writeTail: Promise<void>
  }
  const checkpoint = () => internals.index.checkpointOf('mutable-session')
  try {
    await waitDirectReady(service)
    const liveObject: HistorySearchLiveSessionLike = { id: source.header.id, header: source.header }
    // Model the official registry replacement that happens immediately AFTER
    // the pass's live `sessions.list()` snapshot: the list stays stale (the
    // Session was not live then), while `get` already returns the new object.
    // No live event is delivered, so no drain/pending can mask the race.
    let enumerated = false
    const lateRegistry: HistorySearchSessionsLike = {
      list: () => {
        enumerated = true
        return []
      },
      get: (id) => (enumerated && String(source.header.id) === id ? liveObject : undefined),
    }
    const originalSessions = internals.deps.sessions
    internals.deps.sessions = () => lateRegistry
    try {
      await internals.verifySources()
    } finally {
      internals.deps.sessions = originalSessions
    }

    const stale = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(stale.kind, 'incomplete', JSON.stringify(stale))
    // The invalidated pass hands the ID to its coalesced official replay; wait
    // for that owner to settle before observing the rewritten checkpoint.
    while (internals.sessionRepairFlights.size > 0) {
      await Promise.allSettled([...internals.sessionRepairFlights.values()].map(entry => entry.promise))
    }
    await internals.writeTail
    const settled = checkpoint()
    assert.ok(settled !== undefined, 'the repaired Session must keep its derived checkpoint')
    assert.equal(settled.dirty, false, 'the repair must not leave a dirty checkpoint')

    // The next official pass sees the same live object; the verified rows stay
    // searchable and the index returns to ready only through that real check.
    source.live = true
    await internals.verifySources()
    await waitDirectReady(service)
    const first = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    const second = await service.search({ scope: 'all', query: 'mutable second', limit: 25 }, new AbortController().signal)
    assert.equal(first.kind, 'ready', JSON.stringify(first))
    assert.equal(second.kind, 'ready', JSON.stringify(second))
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected ready')
    assert.equal(first.items.length, 1)
    assert.equal(second.items.length, 1)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a dirty rebuild that becomes cold replays the complete durable source', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r201-')
  const source = mutableSource('/repo/r201')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    observeDisposedSession(session: unknown): void
    pointCounters: PointCountersLike
  }
  const query = deps.sessionQuery()
  assert.ok(query !== undefined)
  const realObserve = query.observeSession
  let observeEntered!: () => void
  const entered = new Promise<void>(resolve => { observeEntered = resolve })
  let releaseObserve!: () => void
  const gate = new Promise<void>(resolve => { releaseObserve = resolve })
  try {
    await waitDirectReady(service)
    query.observeSession = async (id, options) => {
      const observation = await realObserve.call(query, id, options)
      observeEntered()
      await gate
      return observation
    }
    // A live gap marks the checkpoint dirty and starts a rebuild that is held.
    const gapEvent = {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: 5000,
      data: {
        target: 'next-turn',
        start: 5,
        inserted: [{
          id: 'r201-gap-five',
          role: 'user',
          content: [{ type: 'text', text: 'r201 gap five' }],
          source: { kind: 'user', rpcId: 'rpc-r201-5' },
        }],
      },
    }
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), gapEvent)
    await entered

    // The Session is disposed BEFORE the held rebuild can commit, and the
    // durable log now contains accepted events beyond the old checkpoint.
    source.live = false
    source.events.push(
      {
        type: 'agent/inbox/spliced',
        seq: 3,
        time: 3000,
        data: { target: 'next-turn', start: 3, inserted: [{ id: 'r201-three', role: 'user', content: [{ type: 'text', text: 'r201 durable three' }], source: { kind: 'user', rpcId: 'rpc-r201-3' } }] },
      },
      {
        type: 'agent/inbox/spliced',
        seq: 4,
        time: 4000,
        data: { target: 'next-turn', start: 4, inserted: [{ id: 'r201-four', role: 'user', content: [{ type: 'text', text: 'r201 durable four' }], source: { kind: 'user', rpcId: 'rpc-r201-4' } }] },
      },
      gapEvent,
    )
    source.revision += 1
    internals.observeDisposedSession({ id: source.header.id })
    releaseObserve()

    await waitDirectReady(service, 10_000)
    const three = await service.search({ scope: 'all', query: 'r201 durable three', limit: 25 }, new AbortController().signal)
    const four = await service.search({ scope: 'all', query: 'r201 durable four', limit: 25 }, new AbortController().signal)
    assert.equal(three.kind, 'ready', JSON.stringify(three))
    assert.equal(four.kind, 'ready', JSON.stringify(four))
    if (three.kind !== 'ready' || four.kind !== 'ready') throw new Error('expected ready')
    assert.equal(three.items.length, 1)
    assert.equal(four.items.length, 1)
    assert.equal(internals.index.occurrenceCount(), 5, 'the rebuilt history must include every accepted durable message')
    // The point scope owns exactly the repair chain's own official calls: the
    // stale LIVE observation, then the coalesced disposal's cold rebuild and the
    // follow-up rebuild, each with its snapshot stat, replay open and final
    // currentness stat.
    assert.deepEqual(pointCountersOf(internals.pointCounters), {
      stat: 4,
      open: 2,
      observe: 1,
      prefix: 0,
      replayAttempted: 3,
      replayCompleted: 2,
    }, 'the cold point repair must attribute every direct call to the point scope')
  } finally {
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a rebuild requested during an active repair is coalesced and retried', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r202-')
  const source = mutableSource('/repo/r202')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const query = deps.sessionQuery()
  assert.ok(query !== undefined)
  const realObserve = query.observeSession
  let firstObserve = true
  let observeEntered!: () => void
  const entered = new Promise<void>(resolve => { observeEntered = resolve })
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const inbox = (seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 6000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{ id: `r202-${String(seq)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-r202-${String(seq)}` } }],
    },
  })
  try {
    await waitDirectReady(service)
    query.observeSession = async (id, options) => {
      if (firstObserve) {
        firstObserve = false
        const observation = await realObserve.call(query, id, options)
        observeEntered()
        await firstGate
        return observation
      }
      return realObserve.call(query, id, options)
    }
    // Gap => rebuild starts and holds inside observeSession.
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), inbox(5, 'r202 gap five'))
    await entered

    // The missing durable events exist, and a second live event invalidates the
    // held observation while the first repair flight is still active.
    source.events.push(inbox(3, 'r202 durable three'), inbox(4, 'r202 durable four'), inbox(5, 'r202 gap five'), inbox(6, 'r202 follow-up six'))
    source.revision += 1
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), inbox(6, 'r202 follow-up six'))
    // Let the queued drain observe the gap and coalesce its rebuild request.
    await new Promise(resolve => setTimeout(resolve, 25))
    releaseFirst()

    // The first observation is stale; the coalesced follow-up must repair now,
    // without any 30 s full pass.
    await waitDirectReady(service, 10_000)
    const six = await service.search({ scope: 'all', query: 'r202 follow-up six', limit: 25 }, new AbortController().signal)
    assert.equal(six.kind, 'ready', JSON.stringify(six))
    if (six.kind !== 'ready') throw new Error('expected ready')
    assert.equal(six.items.length, 1)
  } finally {
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a live burst larger than the read batch commits in bounded ordered chunks', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r203-')
  const source = mutableSource('/repo/r203')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    writeBatch(input: { readonly events: readonly unknown[] }, witness?: unknown): unknown
  }
  const realWriteBatch = internals.writeBatch
  const commitSizes: number[] = []
  internals.writeBatch = function (input, witness) {
    commitSizes.push(input.events.length)
    return realWriteBatch.call(this, input, witness)
  }
  const inbox = (seq: number) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 7000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `burst-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text: `r203 burst text ${String(seq)}` }],
        source: { kind: 'user', rpcId: `rpc-r203-${String(seq)}` },
      }],
    },
  })
  try {
    await waitDirectReady(service)
    const baseline = commitSizes.length
    for (let seq = 3; seq < 603; seq += 1) {
      ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
        .observeLiveEvent(liveSessionOf(source), inbox(seq))
    }
    await waitDirectReady(service, 10_000)
    const burstCommits = commitSizes.slice(baseline)
    assert.ok(burstCommits.length >= 3, `a 600-event burst needs bounded chunks: ${JSON.stringify(burstCommits)}`)
    assert.ok(burstCommits.every(size => size <= 256), `every live commit is at most 256 events: ${JSON.stringify(burstCommits)}`)
    assert.equal(burstCommits.reduce((sum, size) => sum + size, 0), 600)
    assert.equal(internals.index.occurrenceCount(), 602, 'every accepted burst message must be indexed')
    const last = await service.search({ scope: 'all', query: 'r203 burst text 602', limit: 25 }, new AbortController().signal)
    assert.equal(last.kind, 'ready', JSON.stringify(last))
    if (last.kind !== 'ready') throw new Error('expected ready')
    assert.equal(last.items.length, 1)
  } finally {
    internals.writeBatch = realWriteBatch
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a gapped accepted batch is retained until the official source covers it', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r204-')
  const source = mutableSource('/repo/r204')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    pendingEventCount: number
    heldPending: Set<string>
    verifySources(): Promise<void>
  }
  const inbox = (seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 8000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{ id: `r204-${String(seq)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-r204-${String(seq)}` } }],
    },
  })
  try {
    await waitDirectReady(service)
    const gap = inbox(5, 'r204 accepted gap five')
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), gap)
    // The Session is disposed BEFORE its accepted gap event is durable: the
    // durable source is still short (0..2). The accepted batch must survive.
    source.live = false
    const heldStarted = Date.now()
    while (!internals.heldPending.has('mutable-session') && Date.now() - heldStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // Wait for the short-source repair to settle before inspecting the index:
    // a rebuild may transiently reset rows while it remains incomplete.
    for (;;) {
      const flights = [...(service as unknown as {
        sessionRepairFlights: Map<string, { promise: Promise<void> }>
      }).sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) break
      await Promise.allSettled(flights)
    }
    const settled = await waitDirectSettled(service)
    assert.equal(settled.kind, 'incomplete', JSON.stringify(settled))
    assert.equal(internals.index.occurrenceCount(), 2, 'a short source must not fabricate accepted rows')
    assert.equal(internals.pendingEventCount, 1, 'the accepted batch must be retained, never dropped')
    assert.equal(internals.heldPending.has('mutable-session'), true)
    const hidden = await service.search({ scope: 'all', query: 'r204 accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(hidden.kind, 'incomplete', 'the unproven accepted row is never exposed as an authoritative hit')

    // The same official source now contains 3..5; the next pass replays it,
    // proves the held batch is covered, and only then returns ready.
    source.events.push(inbox(3, 'r204 durable three'), inbox(4, 'r204 durable four'), gap)
    source.revision += 1
    await internals.verifySources()
    await waitDirectReady(service)
    const five = await service.search({ scope: 'all', query: 'r204 accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(five.kind, 'ready', JSON.stringify(five))
    if (five.kind !== 'ready') throw new Error('expected ready')
    assert.equal(five.items.length, 1)
    assert.equal(internals.index.occurrenceCount(), 5)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.heldPending.size, 0)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an unrelated overflow preserves another Session held accepted batch', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r205-')
  const held = mutableSource('/repo/r205-a', 'r205-a')
  const overflowing = mutableSource('/repo/r205-b', 'r205-b')
  held.live = true
  overflowing.live = true
  const { deps } = mutableDeps(held, [overflowing])
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    pendingEventCount: number
    heldPending: Set<string>
    droppedAccepted: Map<string, number>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (sessionId: string, seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 9000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `${sessionId}-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-${sessionId}-${String(seq)}` },
      }],
    },
  })
  const deliver = (source: MutableOfficialSource, event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  try {
    await waitDirectReady(service)
    assert.equal(internals.index.occurrenceCount(), 4, 'both live Sessions are indexed')

    // A: accepted gap is not durable; the Session is disposed before repair.
    const gap = inbox('r205-a', 5, 'r205-a accepted gap five')
    deliver(held, gap)
    held.live = false
    const heldStarted = Date.now()
    while (!internals.heldPending.has('r205-a') && Date.now() - heldStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settleRepairs()
    const short = await waitDirectSettled(service)
    assert.equal(short.kind, 'incomplete', JSON.stringify(short))
    assert.equal(internals.heldPending.has('r205-a'), true)
    assert.equal(internals.pendingEventCount, 1)

    // An UNRELATED Session B overflows the shared live buffer. A's held batch
    // must not be cleared with B's ordinary batch; B's discarded tail must also
    // retain the same accepted-coverage obligation (R4-01).
    const burst: unknown[] = []
    for (let seq = 3; seq <= 4098; seq += 1) burst.push(inbox('r205-b', seq, `r205-b burst ${String(seq)}`))
    for (const event of burst) deliver(overflowing, event)
    assert.equal(internals.heldPending.has('r205-a'), true, 'the overflow must preserve the held Session')
    assert.equal(internals.droppedAccepted.has('r205-b'), true, 'the ordinary discarded tail is an obligation')
    await settleRepairs()
    const afterOverflow = await waitDirectSettled(service)
    assert.equal(afterOverflow.kind, 'incomplete', JSON.stringify(afterOverflow))
    assert.equal(internals.heldPending.has('r205-a'), true)
    assert.equal(internals.heldPending.has('r205-b'), false)
    assert.equal(internals.pendingEventCount, 1, "only the held Session's batch remains")
    assert.equal(internals.index.occurrenceCount(), 4)
    const hidden = await service.search({ scope: 'all', query: 'r205-a accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(hidden.kind, 'incomplete', 'the unproven held event is never exposed as a hit')

    // Both the held A batch and B's ordinary discarded tail must be covered by
    // their authoritative durable sources before the global state may be ready.
    overflowing.events.push(...burst as never[])
    overflowing.revision += 1
    held.events.push(inbox('r205-a', 3, 'r205-a durable three'), inbox('r205-a', 4, 'r205-a durable four'), gap)
    held.revision += 1
    await internals.verifySources()
    await waitDirectReady(service)
    const five = await service.search({ scope: 'all', query: 'r205-a accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(five.kind, 'ready', JSON.stringify(five))
    if (five.kind !== 'ready') throw new Error('expected ready')
    assert.equal(five.items.length, 1)
    assert.equal(internals.index.occurrenceCount(), 4103)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.heldPending.size, 0)
    assert.equal(internals.droppedAccepted.size, 0)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('the hard buffer bound evicts an over-cap held Session and keeps the barrier', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r301-')
  const a = mutableSource('/repo/r301-a', 'r301-a')
  const c = mutableSource('/repo/r301-c', 'r301-c')
  a.live = true
  c.live = true
  const { deps } = mutableDeps(a, [c])
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const query = deps.sessionQuery()
  assert.ok(query !== undefined)
  const realObserve = query.observeSession
  let observeEntered!: () => void
  const entered = new Promise<void>(resolve => { observeEntered = resolve })
  let releaseObserve!: () => void
  const observeGate = new Promise<void>(resolve => { releaseObserve = resolve })
  const internals = service as unknown as {
    index: { occurrenceCount(): number; checkpointOf(id: string): { nextSeq: number } | undefined }
    pendingEventCount: number
    heldPending: Set<string>
    droppedAccepted: Map<string, number>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (sessionId: string, seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 10_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `${sessionId}-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-${sessionId}-${String(seq)}` },
      }],
    },
  })
  const deliver = (source: MutableOfficialSource, event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const flush = async (): Promise<void> => {
    await new Promise(resolve => setImmediate(resolve))
  }
  const waitHeld = async (): Promise<void> => {
    const started = Date.now()
    while (!internals.heldPending.has('r301-a') && Date.now() - started < 250) await flush()
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  try {
    await waitDirectReady(service)
    assert.equal(internals.index.occurrenceCount(), 4)
    // A stalled official observation is the causal condition: the gap cannot be
    // resolved, so each new accepted event is re-held after the drain.
    query.observeSession = async (id, options) => {
      const observation = await realObserve.call(query, id, options)
      observeEntered()
      await observeGate
      return observation
    }
    const gap = inbox('r301-a', 4, 'r301-a accepted gap four')
    deliver(a, gap)
    await entered
    await waitHeld()
    assert.equal(internals.heldPending.has('r301-a'), true)

    // The SAME held Session keeps accepting events; the gap batch grows while
    // its official observation is blocked, then crosses the hard event cap.
    let lastBurstSeq = 0
    for (let seq = 5; seq <= 4100; seq += 1) {
      deliver(a, inbox('r301-a', seq, `r301-a burst ${String(seq)}`))
      lastBurstSeq = seq
      if (internals.droppedAccepted.has('r301-a')) break
      await waitHeld()
      assert.equal(internals.heldPending.has('r301-a'), true, 'the gap batch is re-held between accepted events')
    }
    assert.equal(lastBurstSeq, 4100)
    assert.equal(internals.pendingEventCount, 0, 'the hard bound must be restored')
    assert.equal(internals.heldPending.size, 0)
    assert.equal(internals.droppedAccepted.get('r301-a'), 4100)
    releaseObserve()
    await settleRepairs()
    const bounded = await waitDirectSettled(service)
    assert.equal(bounded.kind, 'incomplete', JSON.stringify(bounded))
    if (bounded.kind !== 'incomplete') throw new Error('expected incomplete')
    assert.equal(bounded.reason, 'resource-limit')
    assert.equal(internals.index.occurrenceCount(), 4, 'the evicted batch is not fabricated into rows')

    // An unrelated Session must still make progress: its ordinary batch commits
    // even while the evicted Session keeps the global barrier truthful.
    deliver(c, inbox('r301-c', 3, 'r301-c progress three'))
    const progressStarted = Date.now()
    while ((internals.index.checkpointOf('r301-c')?.nextSeq ?? 0) < 4 && Date.now() - progressStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.index.checkpointOf('r301-c')?.nextSeq, 4)
    assert.equal(internals.index.occurrenceCount(), 5)

    // R4-01(B): after eviction the watermark is the ONLY outstanding accepted
    // evidence. A temporary roster omission must not delete the checkpoint, the
    // rows or that obligation.
    a.live = false
    a.present = false
    await internals.verifySources()
    const rosterAbsent = await waitDirectSettled(service)
    assert.equal(rosterAbsent.kind, 'incomplete', JSON.stringify(rosterAbsent))
    if (rosterAbsent.kind !== 'incomplete') throw new Error('expected incomplete')
    assert.equal(rosterAbsent.reason, 'resource-limit')
    assert.equal(internals.droppedAccepted.get('r301-a'), 4100)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.index.checkpointOf('r301-a')?.nextSeq, 3)
    assert.equal(internals.index.occurrenceCount(), 5, 'the temporary omission must not delete the rows')
    const hiddenAfterRoster = await service.search({ scope: 'all', query: 'r301-a accepted gap four', limit: 25 }, new AbortController().signal)
    assert.equal(hiddenAfterRoster.kind, 'incomplete', 'the uncovered accepted tail is never a ready hit')

    // The official source eventually covers the evicted seqs; only then ready.
    a.present = true
    query.observeSession = realObserve
    const recovery: unknown[] = [inbox('r301-a', 3, 'r301-a missing three'), gap]
    for (let seq = 5; seq <= 4100; seq += 1) recovery.push(inbox('r301-a', seq, `r301-a burst ${String(seq)}`))
    a.events.push(...recovery as never[])
    a.revision += 1
    await internals.verifySources()
    await waitDirectReady(service)
    assert.equal(internals.droppedAccepted.size, 0)
    assert.equal(internals.index.occurrenceCount(), 4103)
    const last = await service.search({ scope: 'all', query: 'r301-a burst 4100', limit: 25 }, new AbortController().signal)
    assert.equal(last.kind, 'ready', JSON.stringify(last))
    if (last.kind !== 'ready') throw new Error('expected ready')
    assert.equal(last.items.length, 1)
  } finally {
    releaseObserve()
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('the hard buffer bound evicts an over-cap held Session on the byte cap', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r301b-')
  const source = mutableSource('/repo/r301b', 'r301b')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    pendingEventCount: number
    heldPending: Set<string>
    droppedAccepted: Map<string, number>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 11_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `r301b-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-r301b-${String(seq)}` },
      }],
    },
  })
  const deliver = (event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  try {
    await waitDirectReady(service)
    const gap = inbox(5, 'r301b accepted gap five')
    deliver(gap)
    source.live = false
    const heldStarted = Date.now()
    while (!internals.heldPending.has('r301b') && Date.now() - heldStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settleRepairs()
    assert.equal(internals.heldPending.has('r301b'), true)

    const huge = inbox(6, `r301b-huge-${'x'.repeat(17 * 1024 * 1024)}`)
    deliver(huge)
    assert.equal(internals.pendingEventCount, 0, 'the byte bound must be restored')
    assert.equal(internals.heldPending.size, 0)
    assert.equal(internals.droppedAccepted.get('r301b'), 6)
    await settleRepairs()
    const bounded = await waitDirectSettled(service)
    assert.equal(bounded.kind, 'incomplete', JSON.stringify(bounded))
    if (bounded.kind !== 'incomplete') throw new Error('expected incomplete')
    assert.equal(bounded.reason, 'resource-limit')
    assert.equal(internals.index.occurrenceCount(), 2)

    source.events.push(inbox(3, 'r301b durable three'), inbox(4, 'r301b durable four'), gap, huge)
    source.revision += 1
    await internals.verifySources()
    await waitDirectReady(service)
    assert.equal(internals.droppedAccepted.size, 0)
    assert.equal(internals.index.occurrenceCount(), 6)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('ordinary overflow keeps its coverage across a later burst and a short cold source', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r401-')
  const source = mutableSource('/repo/r401', 'r401')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    pendingEventCount: number
    droppedAccepted: Map<string, number>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 14_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `r401-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-r401-${String(seq)}` },
      }],
    },
  })
  const deliver = (event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  try {
    await waitDirectReady(service)
    assert.equal(internals.index.occurrenceCount(), 2)
    // The accepted bursts precede the disposal; the repair is now cold and the
    // durable source still exposes only 0..2.
    source.live = false
    const first: unknown[] = []
    for (let seq = 3; seq <= 4099; seq += 1) first.push(inbox(seq, `r401 first ${String(seq)}`))
    for (const event of first) deliver(event)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.droppedAccepted.get('r401'), 4099)

    // A later ordinary burst after the earlier watermark raises the same
    // unresolved coverage obligation; it never resets or bypasses it.
    const second: unknown[] = []
    for (let seq = 4100; seq <= 8196; seq += 1) second.push(inbox(seq, `r401 second ${String(seq)}`))
    for (const event of second) deliver(event)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.droppedAccepted.get('r401'), 8196)
    await settleRepairs()
    const bounded = await waitDirectSettled(service)
    assert.equal(bounded.kind, 'incomplete', JSON.stringify(bounded))
    if (bounded.kind !== 'incomplete') throw new Error('expected incomplete')
    assert.equal(bounded.reason, 'resource-limit')
    assert.equal(internals.index.occurrenceCount(), 2, 'a short durable prefix must not fabricate the discarded tail')

    // Only the authoritative durable source covering 3..8196 may clear it.
    source.events.push(...first as never[], ...second as never[])
    source.revision += 1
    await internals.verifySources()
    await waitDirectReady(service)
    assert.equal(internals.droppedAccepted.size, 0)
    assert.equal(internals.index.occurrenceCount(), 8196)
    const last = await service.search({ scope: 'all', query: 'r401 second 8196', limit: 25 }, new AbortController().signal)
    assert.equal(last.kind, 'ready', JSON.stringify(last))
    if (last.kind !== 'ready') throw new Error('expected ready')
    assert.equal(last.items.length, 1)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a coverage watermark survives a replay whose final currentness proof failed', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r4f-')
  const source = mutableSource('/repo/r4f', 'r4f')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const persistence = deps.sessionPersistence()
  const internals = service as unknown as {
    index: { occurrenceCount(): number; checkpointOf(id: string): { nextSeq: number } | undefined }
    pendingEventCount: number
    heldPending: Set<string>
    droppedAccepted: Map<string, number>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 15_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `r4f-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-r4f-${String(seq)}` },
      }],
    },
  })
  const deliver = (event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  const realStat = persistence.stat
  let statCalls = 0
  try {
    await waitDirectReady(service)
    // The official source is complete, but the accepted burst is also delivered
    // and then evicted by the ordinary overflow.
    const burst: unknown[] = []
    for (let seq = 3; seq <= 4099; seq += 1) burst.push(inbox(seq, `r4f burst ${String(seq)}`))
    source.events.push(...burst as never[])
    source.revision += 1
    source.live = false
    // The repair's own record stat passes; the FINAL proof stat reports a
    // different revision, so currentness fails after the full replay committed.
    persistence.stat = async (id, options) => {
      const snapshot = await realStat.call(persistence, id, options)
      if (String(id) === 'r4f' && snapshot !== undefined) {
        statCalls += 1
        if (statCalls === 2 && typeof snapshot.revision === 'number') {
          return { ...snapshot, revision: snapshot.revision + 1 }
        }
      }
      return snapshot
    }
    for (const event of burst) deliver(event)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.droppedAccepted.get('r4f'), 4099)
    await settleRepairs()
    // The full replay committed 3..4099 into SQLite, but its final same-instance
    // currentness proof failed. The watermark must NOT be cleared by checkpoint
    // coverage alone; only a later successful proof may settle it.
    assert.equal(internals.droppedAccepted.get('r4f'), 4099)
    assert.equal(internals.index.checkpointOf('r4f')?.nextSeq, 4100)
    const unproven = await waitDirectSettled(service)
    assert.equal(unproven.kind, 'incomplete', JSON.stringify(unproven))
    if (unproven.kind !== 'incomplete') throw new Error('expected incomplete')
    assert.equal(unproven.reason, 'resource-limit')

    // Restore the authentic source; a later complete replay proves currentness.
    persistence.stat = realStat
    await internals.verifySources()
    await waitDirectReady(service)
    assert.equal(internals.droppedAccepted.size, 0)
    const hit = await service.search({ scope: 'all', query: 'r4f burst 4099', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    persistence.stat = realStat
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a superseding same-ID write cannot let a stale replay settle a newer coverage obligation', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r4t-')
  const source = mutableSource('/repo/r4t', 'r4t')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const persistence = deps.sessionPersistence()
  const internals = service as unknown as {
    index: {
      occurrenceCount(): number
      checkpointOf(id: string): {
        headerHash: string
        inheritedCut: number
        headerCwd: string | null
        nextSeq: number
        effectiveCwd: string | null
        sourceState: 'persisted' | 'live'
      } | undefined
    }
    writeBatch(input: {
      sessionId: string
      headerHash: string
      inheritedEventCount: number
      headerCwd: string | null
      baseNextSeq: number
      effectiveCwd: string | null
      sourceState: 'persisted' | 'live'
      events: readonly unknown[]
    }): unknown
    droppedAccepted: Map<string, number>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 16_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `r4t-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-r4t-${String(seq)}` },
      }],
    },
  })
  const deliver = (event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const realStat = persistence.stat
  let statCalls = 0
  let proofEntered!: () => void
  let releaseProof!: () => void
  const proofGate = new Promise<void>(resolve => { releaseProof = resolve })
  const proofReached = new Promise<void>(resolve => { proofEntered = resolve })
  let followUpEntered!: () => void
  let releaseFollowUp!: () => void
  const followUpGate = new Promise<void>(resolve => { releaseFollowUp = resolve })
  const followUpReached = new Promise<void>(resolve => { followUpEntered = resolve })
  try {
    await waitDirectReady(service)
    // Prepare a source with one extra durable event beyond the replay A will
    // read. A's snapshot deliberately advertises 4100 events/durable while the
    // full source already holds seq 4100 for the superseding candidate.
    const burst: unknown[] = []
    for (let seq = 3; seq <= 4099; seq += 1) burst.push(inbox(seq, `r4t burst ${String(seq)}`))
    const extra = inbox(4100, 'r4t superseding 4100')
    source.events.push(...burst as never[], extra)
    source.eventCount = 4100
    source.durableEventCount = 4100
    source.revision += 1
    source.live = false
    persistence.stat = async (id, options) => {
      const snapshot = await realStat.call(persistence, id, options)
      if (String(id) === 'r4t') {
        statCalls += 1
        if (statCalls === 2) {
          proofEntered()
          await proofGate
        } else if (statCalls === 3) {
          followUpEntered()
          await followUpGate
        }
      }
      return snapshot
    }
    // The ordinary overflow records W1=4099 and starts cold replay A.
    for (const event of burst) deliver(event)
    assert.equal(internals.droppedAccepted.get('r4t'), 4099)
    await proofReached
    const replayCheckpoint = internals.index.checkpointOf('r4t')
    assert.ok(replayCheckpoint !== undefined)
    assert.equal(replayCheckpoint.nextSeq, 4100)
    // A superseding same-ID candidate writes seq 4100 and records a NEWER
    // obligation W2=4100 before A's final currentness result is consumed.
    internals.writeBatch({
      sessionId: 'r4t',
      headerHash: replayCheckpoint.headerHash,
      inheritedEventCount: replayCheckpoint.inheritedCut,
      headerCwd: replayCheckpoint.headerCwd,
      baseNextSeq: replayCheckpoint.nextSeq,
      effectiveCwd: replayCheckpoint.effectiveCwd,
      sourceState: replayCheckpoint.sourceState,
      events: [extra],
    })
    internals.droppedAccepted.set('r4t', 4100)
    assert.equal(internals.index.checkpointOf('r4t')?.nextSeq, 4101)
    const aFlight = internals.sessionRepairFlights.get('r4t')?.promise
    releaseProof()
    if (aFlight !== undefined) await aFlight
    await followUpReached
    // A's stale terminal must not clear the newer watermark/barrier before B's
    // final proof. The follow-up B is held at its record stat.
    assert.equal(internals.droppedAccepted.get('r4t'), 4100)
    const blocked = await waitDirectSettled(service)
    assert.equal(blocked.kind, 'incomplete', JSON.stringify(blocked))
    if (blocked.kind !== 'incomplete') throw new Error('expected incomplete')
    assert.ok(blocked.reason === 'resource-limit' || blocked.reason === 'reconciling', JSON.stringify(blocked))

    // B now sees the complete durable source and proves it; only then ready.
    source.eventCount = undefined
    source.durableEventCount = undefined
    releaseFollowUp()
    await internals.verifySources()
    await waitDirectReady(service)
    assert.equal(internals.droppedAccepted.size, 0)
    const hit = await service.search({ scope: 'all', query: 'r4t superseding 4100', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    releaseProof()
    releaseFollowUp()
    persistence.stat = realStat
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a held accepted batch vetoes a temporary official roster deletion', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r302-')
  const a = mutableSource('/repo/r302-a', 'r302-a')
  const c = mutableSource('/repo/r302-c', 'r302-c')
  a.live = true
  c.live = true
  const { deps } = mutableDeps(a, [c])
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    pendingEventCount: number
    heldPending: Set<string>
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
  }
  const inbox = (sessionId: string, seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 12_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `${sessionId}-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-${sessionId}-${String(seq)}` },
      }],
    },
  })
  const deliver = (source: MutableOfficialSource, event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  try {
    await waitDirectReady(service)
    const gap = inbox('r302-a', 5, 'r302-a accepted gap five')
    deliver(a, gap)
    a.live = false
    const heldStarted = Date.now()
    while (!internals.heldPending.has('r302-a') && Date.now() - heldStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settleRepairs()
    assert.equal(internals.heldPending.has('r302-a'), true)

    // The official roster temporarily omits A after its point repair settled.
    // The held batch is the only accepted copy and must veto the deletion.
    a.present = false
    await internals.verifySources()
    const during = await waitDirectSettled(service)
    assert.equal(during.kind, 'incomplete', JSON.stringify(during))
    assert.equal(internals.heldPending.has('r302-a'), true)
    assert.equal(internals.pendingEventCount, 1)
    assert.equal(internals.index.occurrenceCount(), 4, 'A rows must not be deleted')
    const hidden = await service.search({ scope: 'all', query: 'r302-a accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(hidden.kind, 'incomplete')

    // Restoring the official source lets the held batch and rows recover.
    a.present = true
    a.events.push(inbox('r302-a', 3, 'r302-a durable three'), inbox('r302-a', 4, 'r302-a durable four'), gap)
    a.revision += 1
    await internals.verifySources()
    await waitDirectReady(service)
    const five = await service.search({ scope: 'all', query: 'r302-a accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(five.kind, 'ready', JSON.stringify(five))
    if (five.kind !== 'ready') throw new Error('expected ready')
    assert.equal(five.items.length, 1)
    assert.equal(internals.index.occurrenceCount(), 7)
    assert.equal(internals.pendingEventCount, 0)
    assert.equal(internals.heldPending.size, 0)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a cold dirty repair completes from the rc.5 no-eventCount source shape', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r303-')
  const source = mutableSource('/repo/r303', 'r303')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number }
    pointCounters: PointCountersLike
  }
  const persistence = deps.sessionPersistence()
  const gap = {
    type: 'agent/inbox/spliced',
    seq: 5,
    time: 13_000,
    data: {
      target: 'next-turn',
      start: 5,
      inserted: [{
        id: 'r303-gap-five',
        role: 'user',
        content: [{ type: 'text', text: 'r303 accepted gap five' }],
        source: { kind: 'user', rpcId: 'rpc-r303-5' },
      }],
    },
  }
  let releaseList!: () => void
  const listGate = new Promise<void>(resolve => { releaseList = resolve })
  let listCalls = 0
  const realList = persistence.list
  try {
    await waitDirectReady(service)
    // The real rc.5 JSONL shape: stat()/list() carry no eventCount.
    source.omitEventCount = true
    persistence.list = async (options) => {
      listCalls += 1
      await listGate
      return realList.call(persistence, options)
    }
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), gap)
    source.live = false
    // Durable 3..5 (including the accepted gap) exists before the repair reads.
    source.events.push(
      { type: 'agent/inbox/spliced', seq: 3, time: 13_003, data: { target: 'next-turn', start: 3, inserted: [{ id: 'r303-three', role: 'user', content: [{ type: 'text', text: 'r303 durable three' }], source: { kind: 'user', rpcId: 'rpc-r303-3' } }] } },
      { type: 'agent/inbox/spliced', seq: 4, time: 13_004, data: { target: 'next-turn', start: 4, inserted: [{ id: 'r303-four', role: 'user', content: [{ type: 'text', text: 'r303 durable four' }], source: { kind: 'user', rpcId: 'rpc-r303-4' } }] } },
      gap,
    )
    source.revision += 1
    await waitDirectReady(service, 10_000)
    assert.equal(listCalls, 0, 'the per-ID repair must not wait for the full roster list')
    const five = await service.search({ scope: 'all', query: 'r303 accepted gap five', limit: 25 }, new AbortController().signal)
    assert.equal(five.kind, 'ready', JSON.stringify(five))
    if (five.kind !== 'ready') throw new Error('expected ready')
    assert.equal(five.items.length, 1)
    assert.equal(internals.index.occurrenceCount(), 5)
    // No advertised count: the cold point repair proves the durable prefix and
    // then replays, so the point scope owns ONE stat and TWO opens (proof + read).
    // The point scope owns the whole cold repair: the snapshot stat, the prefix
    // proof open, the replay open and the final same-instance currentness stat.
    assert.deepEqual(pointCountersOf(internals.pointCounters), {
      stat: 2,
      open: 2,
      observe: 0,
      prefix: 1,
      replayAttempted: 1,
      replayCompleted: 1,
    }, 'the no-eventCount cold repair must attribute the prefix proof to the point scope')
  } finally {
    releaseList()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an old roster cannot delete a Session created and retired during its scan', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r7-roster-cut-')
  const a = mutableSource('/repo/r7-a', 'r7-a')
  const b = mutableSource('/repo/r7-b', 'r7-b')
  a.live = true
  b.live = false
  b.present = false
  const { deps } = mutableDeps(a, [b])
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const persistence = deps.sessionPersistence()
  const internals = service as unknown as {
    index: { occurrenceCount(): number; checkpointOf(id: string): { nextSeq: number; sourceState: string; dirty: boolean } | undefined }
    sessionRepairFlights: Map<string, { promise: Promise<void> }>
    verifySources(): Promise<void>
    observeDisposedSession(session: unknown): void
  }
  const inbox = (sessionId: string, seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 17_000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `${sessionId}-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-${sessionId}-${String(seq)}` },
      }],
    },
  })
  const deliver = (source: MutableOfficialSource, event: unknown): void => {
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
  }
  const settleRepairs = async (): Promise<void> => {
    for (;;) {
      const flights = [...internals.sessionRepairFlights.values()].map(entry => entry.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }
  const realList = persistence.list
  let listEntered!: () => void
  const listReached = new Promise<void>(resolve => { listEntered = resolve })
  let releaseList!: () => void
  const listGate = new Promise<void>(resolve => { releaseList = resolve })
  try {
    await waitDirectReady(service)
    // Capture the OLD roster before B exists, then hold the pass at its list.
    const oldRoster = await realList.call(persistence)
    persistence.list = async () => {
      listEntered()
      await listGate
      return oldRoster
    }
    const pass = internals.verifySources()
    await listReached

    // B is created, indexed by a real live point repair, then normally retired
    // and durable-proofed while the old roster is still held.
    b.present = true
    b.live = true
    const accepted = inbox('r7-b', 3, 'r7-b accepted after the roster cut')
    b.events.push(accepted)
    deliver(b, accepted)
    const createdStarted = Date.now()
    while (internals.index.checkpointOf('r7-b')?.nextSeq !== 4 && Date.now() - createdStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.index.checkpointOf('r7-b')?.nextSeq, 4)
    await settleRepairs()
    b.live = false
    internals.observeDisposedSession({ id: 'r7-b' })
    const retiredStarted = Date.now()
    while (
      (internals.index.checkpointOf('r7-b')?.sourceState !== 'persisted' || internals.index.checkpointOf('r7-b')?.dirty === true)
      && Date.now() - retiredStarted < 5_000
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settleRepairs()

    // Release the pre-B roster. B is absent from it and from the live registry,
    // but was created after the round-local cut and must not be deleted.
    releaseList()
    await pass
    await waitDirectReady(service)
    assert.equal(internals.index.checkpointOf('r7-b')?.nextSeq, 4)
    const hit = await service.search({ scope: 'all', query: 'r7-b accepted after the roster cut', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
    assert.equal(internals.index.occurrenceCount(), 5, 'A keeps 2 and B keeps its 3 accepted messages')
  } finally {
    releaseList()
    persistence.list = realList
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a normal live drain uses the index status predicate, not a checkpoint scan', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r803-')
  const source = mutableSource('/repo/r803', 'r803')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { occurrenceCount(): number; listSessions(): unknown[] }
  }
  const event = {
    type: 'agent/inbox/spliced',
    seq: 3,
    time: 18_000,
    data: {
      target: 'next-turn',
      start: 3,
      inserted: [{
        id: 'r803-live',
        role: 'user',
        content: [{ type: 'text', text: 'r803 normal live event' }],
        source: { kind: 'user', rpcId: 'rpc-r803' },
      }],
    },
  }
  const realList = internals.index.listSessions.bind(internals.index)
  let listCalls = 0
  try {
    await waitDirectReady(service)
    internals.index.listSessions = () => {
      listCalls += 1
      return realList()
    }
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(source), event)
    await waitDirectReady(service)
    assert.equal(internals.index.occurrenceCount(), 3)
    assert.equal(listCalls, 0, 'the writer completeness path must not materialize all checkpoint rows')
    const hit = await service.search({ scope: 'all', query: 'r803 normal live event', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    internals.index.listSessions = realList
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a startup accepted event is handed to the bounded drain without waiting for a timer', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r802-')
  const a = mutableSource('/repo/r802-a', 'r802-a')
  const b = mutableSource('/repo/r802-b', 'r802-b')
  a.live = true
  b.live = false
  b.present = false
  const { deps } = mutableDeps(a, [b])
  const persistence = deps.sessionPersistence()
  const realList = persistence.list
  let listEntered!: () => void
  const listReached = new Promise<void>(resolve => { listEntered = resolve })
  let releaseList!: () => void
  const listGate = new Promise<void>(resolve => { releaseList = resolve })
  const ctx = new Context()
  let service: PiTuiHistorySearchHostService | undefined
  try {
    const oldRoster = await realList.call(persistence)
    persistence.list = async () => {
      listEntered()
      await listGate
      return oldRoster
    }
    service = directService(ctx, deps, profileDir)
    await listReached
    // B is born and its accepted event arrives while the initial roster is held.
    b.live = true
    b.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 19_000,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'r802-b-startup',
          role: 'user',
          content: [{ type: 'text', text: 'r802 startup accepted event' }],
          source: { kind: 'user', rpcId: 'rpc-r802-b' },
        }],
      },
    })
    ;(service as unknown as { observeLiveEvent(session: unknown, event: unknown): void })
      .observeLiveEvent(liveSessionOf(b), b.events[3])
    releaseList()
    await waitDirectReady(service, 10_000)
    const hit = await service.search({ scope: 'all', query: 'r802 startup accepted event', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    releaseList()
    persistence.list = realList
    if (service !== undefined) await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a destructive round barrier covers the interval between deletion commits', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r801b-')
  const a = mutableSource('/repo/r801b-a', 'r801b-a')
  const b = mutableSource('/repo/r801b-b', 'r801b-b')
  a.live = true
  b.live = true
  const { deps } = mutableDeps(a, [b])
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): unknown }
    enqueueWrite<T>(work: () => T): Promise<'committed' | 'failed' | 'stale'>
    verifySources(): Promise<void>
  }
  const realEnqueue = internals.enqueueWrite.bind(service)
  let writeCalls = 0
  let firstEntered!: () => void
  const firstReached = new Promise<void>(resolve => { firstEntered = resolve })
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  let secondEntered!: () => void
  const secondReached = new Promise<void>(resolve => { secondEntered = resolve })
  let releaseSecond!: () => void
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  try {
    await waitDirectReady(service)
    assert.notEqual(internals.index.checkpointOf('r801b-a'), undefined)
    assert.notEqual(internals.index.checkpointOf('r801b-b'), undefined)
    a.present = false
    a.live = false
    b.present = false
    b.live = false
    internals.enqueueWrite = async work => {
      writeCalls += 1
      if (writeCalls === 1) {
        firstEntered()
        await firstGate
      }
      if (writeCalls === 2) {
        secondEntered()
        await secondGate
      }
      return realEnqueue(work)
    }
    const pass = internals.verifySources()
    await firstReached
    // Deletion is the FIRST destructive publication of this proven round. The
    // barrier must already hold BEFORE the first deletion commits.
    const beforeFirst = await service.search({ scope: 'all', query: 'r801b', limit: 25 }, new AbortController().signal)
    assert.equal(beforeFirst.kind, 'incomplete', JSON.stringify(beforeFirst))
    releaseFirst()
    await secondReached
    // The first absent Session is already deleted; the second writer turn has
    // not committed. The Owner must not see the surviving stale row as ready.
    const interim = await service.search({ scope: 'all', query: 'r801b', limit: 25 }, new AbortController().signal)
    assert.equal(interim.kind, 'incomplete', JSON.stringify(interim))
    releaseSecond()
    await pass
    await waitDirectReady(service)
    assert.equal(internals.index.checkpointOf('r801b-a'), undefined)
    assert.equal(internals.index.checkpointOf('r801b-b'), undefined)
  } finally {
    releaseFirst()
    releaseSecond()
    internals.enqueueWrite = realEnqueue
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a failed/partial first pass cannot become ready through a point repair alone', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r801a-')
  const a = mutableSource('/repo/r801a-a', 'r801a-a')
  const b = mutableSource('/repo/r801a-b', 'r801a-b')
  a.live = true
  b.live = true
  const { deps } = mutableDeps(a, [b])
  const query = deps.sessionQuery()
  const realObserve = query.observeSession.bind(query)
  let failA = true
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    verifySources(): Promise<void>
    observeLiveEvent(session: unknown, event: unknown): void
  }
  const waitNotLoading = async (): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const answer = await service.search({ scope: 'all', query: 'r801a', limit: 25 }, new AbortController().signal)
      if (answer.kind !== 'loading') return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('first pass did not settle')
  }
  try {
    // The first A observation fails before B is visited. This is the
    // initial/full coverage failure, not a storage-health detail.
    query.observeSession = async (id, options) => {
      if (failA && String(id) === 'r801a-a') throw new Error('R8-01A injected first-pass observe failure')
      return realObserve(id, options)
    }
    await waitNotLoading()
    assert.equal(failA, true)
    assert.equal(internals.index.checkpointOf('r801a-a'), undefined)
    assert.equal(internals.index.checkpointOf('r801a-b'), undefined)
    let answer = await service.search({ scope: 'all', query: 'r801a-b', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'incomplete', JSON.stringify(answer))

    // A later successful A point repair clears A's obligation but cannot prove
    // the unvisited B or full coverage.
    failA = false
    a.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 21_000,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'r801a-a-live',
          role: 'user',
          content: [{ type: 'text', text: 'r801a A point repair' }],
          source: { kind: 'user', rpcId: 'rpc-r801a-a' },
        }],
      },
    })
    internals.observeLiveEvent(liveSessionOf(a), a.events[3])
    const repairStarted = Date.now()
    while (internals.index.checkpointOf('r801a-a')?.nextSeq !== 4 && Date.now() - repairStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.index.checkpointOf('r801a-a')?.nextSeq, 4)
    assert.equal(internals.index.checkpointOf('r801a-b'), undefined)
    answer = await service.search({ scope: 'all', query: 'r801a-b', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'incomplete', JSON.stringify(answer))

    // B gets a unique accepted fact; a complete later full pass visits it and
    // only then establishes coverage.
    b.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 20_500,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'r801a-b-unique',
          role: 'user',
          content: [{ type: 'text', text: 'r801a B unique' }],
          source: { kind: 'user', rpcId: 'rpc-r801a-b' },
        }],
      },
    })
    await internals.verifySources()
    await waitDirectReady(service)
    const hit = await service.search({ scope: 'all', query: 'r801a B unique', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a stale first pass continues the full traversal and repairs the stale identity', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r801a-stale-')
  const a = mutableSource('/repo/r801a-stale-a', 'r801a-stale-a')
  const b = mutableSource('/repo/r801a-stale-b', 'r801a-stale-b')
  a.live = true
  b.live = false
  b.present = true
  const { deps } = mutableDeps(a, [b])
  const query = deps.sessionQuery()
  const sessions = deps.sessions()
  const realObserve = query.observeSession.bind(query)
  const realSessionsList = sessions.list.bind(sessions)
  const realSessionsGet = sessions.get.bind(sessions)
  type LiveSession = NonNullable<ReturnType<typeof realSessionsGet>>
  const replacement = liveSessionOf(a) as unknown as LiveSession
  let replaced = false
  query.observeSession = async (id, options) => {
    if (!replaced && String(id) === 'r801a-stale-a') {
      // Replace A's live identity DURING its cold observation. The witness was
      // created against the enumerated object, so its terminal must go stale.
      replaced = true
      sessions.list = () => realSessionsList().map(session => (String(session.id) === 'r801a-stale-a' ? replacement : session))
      sessions.get = sessionId => (sessionId === 'r801a-stale-a' ? replacement : realSessionsGet(sessionId))
    }
    return realObserve(id, options)
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    verifySources(): Promise<void>
    observeLiveEvent(session: unknown, event: unknown): void
  }
  const waitNotLoading = async (): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const answer = await service.search({ scope: 'all', query: 'r801a-stale', limit: 25 }, new AbortController().signal)
      if (answer.kind !== 'loading') return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('first pass did not settle')
  }
  try {
    await waitNotLoading()
    assert.equal(replaced, true)
    // The stale A handoff does not abandon the remaining official traversal:
    // the persisted-only B was visited and indexed in the same cold round.
    assert.equal(internals.index.checkpointOf('r801a-stale-b')?.nextSeq, 3)

    // The stale A handoff stays pending; the next accepted event gives it the
    // bounded repair it needs. The round remains the ONE owner of both IDs and
    // can finish once both settle.
    a.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 23_000,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'r801a-stale-a-live',
          role: 'user',
          content: [{ type: 'text', text: 'r801a stale A repair' }],
          source: { kind: 'user', rpcId: 'rpc-r801a-stale-a' },
        }],
      },
    })
    internals.observeLiveEvent(replacement, a.events[3])
    const repairStarted = Date.now()
    while (internals.index.checkpointOf('r801a-stale-a')?.nextSeq !== 4 && Date.now() - repairStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.index.checkpointOf('r801a-stale-a')?.nextSeq, 4)
    assert.equal(internals.index.checkpointOf('r801a-stale-b')?.nextSeq, 3)

    // B's later content is picked up by the next complete pass.
    b.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 23_500,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'r801a-stale-b-unique',
          role: 'user',
          content: [{ type: 'text', text: 'r801a stale unvisited B' }],
          source: { kind: 'user', rpcId: 'rpc-r801a-stale-b' },
        }],
      },
    })
    await internals.verifySources()
    await waitDirectReady(service)
    const hit = await service.search({ scope: 'all', query: 'r801a stale unvisited B', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    query.observeSession = realObserve
    sessions.list = realSessionsList
    sessions.get = realSessionsGet
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a normal live writer turn does not materialize checkpoints at 100/1000/10000 rows', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r803-scale-')
  const source = mutableSource('/repo/r803-scale', 'r803-scale')
  source.live = true
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: {
      commitBatch(input: {
        sessionId: string
        headerHash: string
        inheritedCut: number
        baseNextSeq: number
        nextSeq: number
        headerCwd: string | null
        effectiveCwd: string | null
        lastEventHash: string | null
        sourceState: 'persisted' | 'live'
        uncertainSourcesDelta: number
        occurrences: readonly unknown[]
      }): void
      listSessions(): unknown[]
      occurrenceCount(): number
    }
    writerCounters: { busyMsMax: number; committed: number }
    observeLiveEvent(session: unknown, event: unknown): void
  }
  const realList = internals.index.listSessions.bind(internals.index)
  let listCalls = 0
  const percentile = (values: readonly number[], ratio: number): number => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
  }
  const seed = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      internals.index.commitBatch({
        sessionId: `r803-seed-${String(index)}`,
        headerHash: `r803-seed-header-${String(index)}`,
        inheritedCut: 0,
        baseNextSeq: 0,
        nextSeq: 1,
        headerCwd: '/seed',
        effectiveCwd: null,
        lastEventHash: null,
        sourceState: 'persisted',
        uncertainSourcesDelta: 0,
        occurrences: [],
      })
    }
  }
  const measure = async (tier: number, seq: number): Promise<{ writerBusyMsMax: number; searchP95: number; searchP99: number; readP95: number; readP99: number }> => {
    const text = `r803 scale ${String(tier)}`
    const messageId = `r803-scale-${String(tier)}`
    source.events.push({
      type: 'agent/inbox/spliced',
      seq,
      time: 30_000 + seq,
      data: {
        target: 'next-turn',
        start: seq,
        inserted: [{
          id: messageId,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: `rpc-r803-${String(tier)}` },
        }],
      },
    })
    internals.observeLiveEvent(liveSessionOf(source), source.events[source.events.length - 1])
    await waitDirectReady(service)
    const searchLatencies: number[] = []
    const readLatencies: number[] = []
    for (let sample = 0; sample < 20; sample += 1) {
      const searchStarted = performance.now()
      const search = await service.search({ scope: 'all', query: text, limit: 25 }, new AbortController().signal)
      searchLatencies.push(performance.now() - searchStarted)
      assert.equal(search.kind, 'ready', JSON.stringify(search))
      if (search.kind !== 'ready') throw new Error('expected ready')
      const item = search.items[0]
      if (item === undefined) throw new Error('expected one scale hit')
      const readStarted = performance.now()
      const chunk = await service.readText({
        sessionId: item.sessionId,
        messageId: item.messageId,
        contentSha256: item.contentSha256,
        offset: 0,
        limit: 64,
      }, new AbortController().signal)
      readLatencies.push(performance.now() - readStarted)
      assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
    }
    return {
      writerBusyMsMax: internals.writerCounters.busyMsMax,
      searchP95: percentile(searchLatencies, 0.95),
      searchP99: percentile(searchLatencies, 0.99),
      readP95: percentile(readLatencies, 0.95),
      readP99: percentile(readLatencies, 0.99),
    }
  }
  try {
    await waitDirectReady(service)
    internals.index.listSessions = () => {
      listCalls += 1
      return realList()
    }
    const results: Record<string, unknown> = {}
    seed(0, 100)
    results['100'] = await measure(100, 3)
    seed(100, 1_000)
    results['1000'] = await measure(1_000, 4)
    seed(1_000, 10_000)
    results['10000'] = await measure(10_000, 5)
    console.log('R8-03 SCALE', JSON.stringify({ sessions: 10_000, listCalls, occurrenceCount: internals.index.occurrenceCount(), results }))
    assert.equal(listCalls, 0, 'the completeness path must not materialize checkpoint rows in JavaScript')
    assert.equal(internals.index.occurrenceCount(), 5)
  } finally {
    internals.index.listSessions = realList
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a point repair completion cannot release the round before the full traversal finishes', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r9a-')
  const a = mutableSource('/repo/r9a-a', 'r9a-a')
  const b = mutableSource('/repo/r9a-b', 'r9a-b')
  const c = mutableSource('/repo/r9a-c', 'r9a-c')
  a.live = true
  b.live = true
  c.live = false
  const { deps } = mutableDeps(a, [b, c])
  const persistence = deps.sessionPersistence()
  const query = deps.sessionQuery()
  const realOpen = persistence.open.bind(persistence)
  const realObserve = query.observeSession.bind(query)
  let bEntered!: () => void
  const bReached = new Promise<void>(resolve => { bEntered = resolve })
  let releaseB!: () => void
  const bGate = new Promise<void>(resolve => { releaseB = resolve })
  let cEntered!: () => void
  const cReached = new Promise<void>(resolve => { cEntered = resolve })
  let releaseC!: () => void
  const cGate = new Promise<void>(resolve => { releaseC = resolve })
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): unknown }
    scheduleSessionRepair(sessionId: string, kind: 'rebuild' | 'disposal'): void
    verifySources(): Promise<void>
    coverageRound?: { deletionsSettled: boolean }
  }
  try {
    await waitDirectReady(service)
    a.present = false
    a.live = false
    c.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 24_000,
      data: {
        target: 'next-turn',
        start: 3,
        inserted: [{
          id: 'r9a-c-new',
          role: 'user',
          content: [{ type: 'text', text: 'r9a C changed during traversal' }],
          source: { kind: 'user', rpcId: 'rpc-r9a-c' },
        }],
      },
    })
    c.revision += 1
    query.observeSession = async (id, options) => {
      if (String(id) === 'r9a-b') {
        bEntered()
        await bGate
      }
      return realObserve(id, options)
    }
    persistence.open = async (id, mode, options) => {
      if (String(id) === 'r9a-c') {
        cEntered()
        await cGate
      }
      return realOpen(id, mode, options)
    }
    internals.scheduleSessionRepair('r9a-b', 'rebuild')
    await bReached
    const pass = internals.verifySources()
    for (let attempt = 0; attempt < 500 && internals.coverageRound?.deletionsSettled !== true; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    releaseB()
    await cReached
    // B's point repair has settled; C is still unvisited, so the round must
    // stay incomplete even though the deletion already settled. Exercise the
    // exact round-finish sink the point settlement calls (structural witness
    // for the scheduling interleaving).
    ;(service as unknown as { finishCoverageRound(): void }).finishCoverageRound()
    const interim = await service.search({ scope: 'all', query: 'r9a C changed', limit: 25 }, new AbortController().signal)
    assert.equal(interim.kind, 'incomplete', JSON.stringify(interim))
    releaseC()
    await pass
    await waitDirectReady(service)
    assert.equal(internals.index.checkpointOf('r9a-a'), undefined)
    const hit = await service.search({ scope: 'all', query: 'r9a C changed during traversal', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    releaseB()
    releaseC()
    persistence.open = realOpen
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('unproven coverage rebuilds a prior-incarnation live checkpoint instead of trusting the no-read path', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r9b-')
  const source = mutableSource('/repo/r9b', 'r9b')
  source.live = true
  const firstDeps = mutableDeps(source).deps
  const firstCtx = new Context()
  const first = directService(firstCtx, firstDeps, profileDir)
  try {
    await waitDirectReady(first)
    const old = await first.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(old.kind, 'ready', JSON.stringify(old))
  } finally {
    await first.dispose()
    await firstCtx.fiber.dispose()
  }

  // A new incarnation changes the accepted prefix without changing seq/header.
  source.events[0] = {
    type: 'agent/inbox/spliced',
    seq: 0,
    time: 1000,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{
        id: 'msg-r9b-new',
        role: 'user',
        content: [{ type: 'text', text: 'r9b new incarnation first' }],
        source: { kind: 'user', rpcId: 'rpc-r9b-new' },
      }],
    },
  }
  source.revision += 1
  const secondDeps = mutableDeps(source).deps
  const secondPersistence = secondDeps.sessionPersistence()
  const realList = secondPersistence.list.bind(secondPersistence)
  let aborted = false
  secondPersistence.list = async options => {
    if (!aborted) {
      aborted = true
      throw new Error('R9B injected first-pass list abort')
    }
    return realList(options)
  }
  const secondCtx = new Context()
  const second = directService(secondCtx, secondDeps, profileDir)
  const internals = second as unknown as {
    index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    verifySources(): Promise<void>
  }
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const answer = await second.search({ scope: 'all', query: 'r9b', limit: 25 }, new AbortController().signal)
      if (answer.kind !== 'loading') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(aborted, true)
    assert.equal(internals.index.checkpointOf('r9b')?.nextSeq, 3)
    let answer = await second.search({ scope: 'all', query: 'r9b new incarnation first', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'incomplete', JSON.stringify(answer))

    // Coverage is still unproven; the retained prior-incarnation checkpoint,
    // matching header and current live object are NOT a proof of this Host's
    // observed source. A complete pass must rebuild from the current source.
    await internals.verifySources()
    await waitDirectReady(second)
    const hit = await second.search({ scope: 'all', query: 'r9b new incarnation first', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    secondPersistence.list = realList
    await second.dispose()
    await secondCtx.fiber.dispose()
  }
})

test('a bounded startup burst completes the round on the final drain', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r9-burst-')
  const source = mutableSource('/repo/r9-burst', 'r9-burst')
  source.live = true
  const { deps } = mutableDeps(source)
  const persistence = deps.sessionPersistence()
  const query = deps.sessionQuery()
  const realList = persistence.list
  let listEntered!: () => void
  const listReached = new Promise<void>(resolve => { listEntered = resolve })
  let releaseList!: () => void
  const listGate = new Promise<void>(resolve => { releaseList = resolve })
  // The cold start calls list() synchronously while the service is still being
  // constructed, so this gate MUST be installed before directService().
  persistence.list = async () => {
    listEntered()
    await listGate
    return realList.call(persistence)
  }
  const realObserve = query.observeSession
  let burstDelivered = false
  const deliverBurst = (): void => {
    if (burstDelivered) return
    burstDelivered = true
    for (let seq = 3; seq < 603; seq += 1) {
      const event = {
        type: 'agent/inbox/spliced',
        seq,
        time: 25_000 + seq,
        data: {
          target: 'next-turn',
          start: seq,
          inserted: [{
            id: `r9-burst-${String(seq)}`,
            role: 'user',
            content: [{ type: 'text', text: `r9 burst ${String(seq)}` }],
            source: { kind: 'user', rpcId: `rpc-r9-burst-${String(seq)}` },
          }],
        },
      }
      source.events.push(event)
      internals.observeLiveEvent(liveSessionOf(source), event)
    }
  }
  query.observeSession = async (id, options) => {
    const observation = await realObserve.call(query, id, options)
    // The timer fires after the replay's synchronous short writes/terminal and
    // before the round can finish across the startup yield.
    if (!burstDelivered && String(id) === 'r9-burst') setTimeout(deliverBurst, 0)
    return observation
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    observeLiveEvent(session: unknown, event: unknown): void
  }
  try {
    await listReached
    releaseList()
    const readyStarted = Date.now()
    let ready = false
    while (Date.now() - readyStarted < 3_000) {
      const answer = await service.search({ scope: 'all', query: 'r9 burst 602', limit: 25 }, new AbortController().signal)
      if (answer.kind === 'ready') {
        ready = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const readyElapsed = Date.now() - readyStarted
    assert.equal(ready, true, 'the final drain must not wait for the 30 s timer')
    assert.ok(readyElapsed < 3_000, `startup ready took ${String(readyElapsed)}ms; the 30 s timer masked the drain`)
    console.log('R9 STARTUP READY', readyElapsed)
    assert.equal(burstDelivered, true)
    assert.equal(internals.index.checkpointOf('r9-burst')?.nextSeq, 603)
    const hit = await service.search({ scope: 'all', query: 'r9 burst 602', limit: 25 }, new AbortController().signal)
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
  } finally {
    releaseList()
    persistence.list = realList
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('the round finish requires the full traversal proof even with no outstanding payload', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r9-traversal-proof-')
  const source = mutableSource('/repo/r9-traversal-proof')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    coverageRound?: {
      basis: unknown
      expected: Set<string> | undefined
      settled: Map<string, { readonly liveObject: object | undefined }>
      deletionsSettled: boolean
      invalidating: boolean
      traversed: boolean
    }
    finishCoverageRound(): void
  }
  try {
    await waitDirectReady(service)
    internals.coverageRound = {
      basis: (service as unknown as { currentCoverageBasis(): unknown }).currentCoverageBasis(),
      expected: undefined,
      settled: new Map(),
      deletionsSettled: true,
      invalidating: true,
      traversed: false,
    }
    internals.finishCoverageRound()
    assert.notEqual(internals.coverageRound, undefined, 'a pending traversal cannot be released by an empty obligation set')
    if (internals.coverageRound === undefined) throw new Error('expected round')
    internals.coverageRound.traversed = true
    internals.finishCoverageRound()
    assert.equal(internals.coverageRound, undefined)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a real accepted event during retained-index startup reaches the point replay and the Gateway', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'history-search-r12-retained', {
    pluginManagerProfile: true,
    withoutHostRuntime: true,
  })
  let runtime1: { dispose(): Promise<void> } | undefined
  let runtime2: { dispose(): Promise<void> } | undefined
  let m3: Awaited<ReturnType<typeof createRemoteHostRuntime>> | undefined
  const persistence = host.ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
  const realList = persistence.list
  const query = host.ctx.sessionQuery as unknown as HistorySearchQueryLike
  const realObserve = query.observeSession
  let releaseList: () => void = () => {}
  let releasePoint: () => void = () => {}
  try {
    runtime1 = await host.ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
    m3 = await createRemoteHostRuntime(host.ctx)
    const peer = host.ctx.connection.browserPeer
    const sessionId = 'history-r12-retained'
    const waitGateway = async (label: string, request: HistorySearchRequest): Promise<HistorySearchResponse> => {
      const started = Date.now()
      for (;;) {
        const answer = await realSearch(host, peer, request)
        if (answer.kind === 'ready') return answer
        if (answer.kind === 'unavailable') throw new Error(`${label}: ${JSON.stringify(answer)}`)
        if (Date.now() - started > 15_000) throw new Error(`${label}: timeout (${answer.kind})`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
    await promptHost(host, sessionId, 'req-r12-first', 'hsp-r12-first')
    await waitGateway('retained first incarnation', { scope: 'all', query: '', limit: 1 })
    const service1 = host.ctx.reflect.get(PI_TUI_HISTORY_SEARCH_NAMESPACE) as unknown as {
      index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    }
    const retained = service1.index.checkpointOf(sessionId)
    assert.ok(retained !== undefined, 'the first incarnation must retain a real Session checkpoint')
    assert.ok(retained.nextSeq > 0)

    // Reopen the SAME real Host (official persistence/Session/gateway) with a
    // SECOND production runtime incarnation: only the service/index lifetime changes.
    await runtime1.dispose()
    runtime1 = undefined

    let listEntered!: () => void
    const listReached = new Promise<void>(resolve => { listEntered = resolve })
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    persistence.list = async (options) => {
      listEntered()
      await listGate
      return realList.call(persistence, options)
    }
    const pointGate = new Promise<void>(resolve => { releasePoint = resolve })
    let pointGated = false
    query.observeSession = async (id, options) => {
      if (!pointGated && String(id) === sessionId) {
        pointGated = true
        await pointGate
      }
      return realObserve.call(query, id, options)
    }
    runtime2 = await host.ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
    await listReached

    // A real accepted event arrives through the official SessionController while
    // the retained-index roster read is held: ordinary pending before the reset.
    await promptHost(host, sessionId, 'req-r12-second', 'hsp-r12-second')
    const service2Proxy = host.ctx.reflect.get(PI_TUI_HISTORY_SEARCH_NAMESPACE) as unknown as {
      index: { checkpointOf(id: string): { nextSeq: number } | undefined }
      pending: Map<string, unknown>
      sessionRepairFlights: Map<string, unknown>
      rebuildRequests: Set<string>
      reconcilePending: Set<string>
      state: { kind: string }
      coverage: string
    }
    const service2 = ((service2Proxy as unknown as Record<symbol, unknown>)[symbols.original] ?? service2Proxy) as typeof service2Proxy
    const pendingStarted = Date.now()
    while (!service2.pending.has(sessionId) && Date.now() - pendingStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(service2.pending.has(sessionId), true, 'the real accepted event must be buffered before the list is released')
    releaseList()
    const pointStarted = Date.now()
    while (!pointGated && Date.now() - pointStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(pointGated, true, JSON.stringify({
      state: service2.state,
      coverage: service2.coverage,
      checkpoint: service2.index.checkpointOf(sessionId),
      pending: service2.pending.size,
      flights: [...service2.sessionRepairFlights.keys()],
      rebuilds: [...service2.rebuildRequests],
      reconcile: [...service2.reconcilePending],
    }))
    const afterDrain = service2.index.checkpointOf(sessionId)
    assert.ok(afterDrain !== undefined)
    assert.equal(service2.pending.size, 0)
    assert.ok(afterDrain.nextSeq > retained.nextSeq, 'the ordinary drain must advance the retained checkpoint before the point observation')
    releasePoint()
    const readyStarted = Date.now()
    let replayed: HistorySearchResponse
    for (;;) {
      replayed = await realSearch(host, peer, { scope: 'all', query: 'hsp-r12-second', limit: 25 })
      if (replayed.kind === 'ready' || replayed.kind === 'unavailable') break
      if (Date.now() - readyStarted > 15_000) {
        assert.fail(JSON.stringify({
          kind: replayed.kind,
          state: service2.state,
          coverage: service2.coverage,
          pending: [...service2.pending.keys()],
          flights: [...service2.sessionRepairFlights.entries()].map(([id, flight]) => [id, (flight as { kind?: string }).kind]),
          rebuilds: [...service2.rebuildRequests],
          reconcile: [...service2.reconcilePending],
          checkpoint: service2.index.checkpointOf(sessionId),
        }))
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(replayed.kind, 'ready', JSON.stringify(replayed))
    if (replayed.kind !== 'ready') throw new Error('expected ready')
    const second = replayed
    assert.equal(second.items.length, 1)
    assert.equal(second.items[0]?.sessionId, sessionId)
    assert.equal(second.items[0]?.preview, 'hsp-r12-second')
    const first = await realSearch(host, peer, { scope: 'all', query: 'hsp-r12-first', limit: 25 })
    assert.equal(first.kind, 'ready', JSON.stringify(first))
    if (first.kind !== 'ready') throw new Error('expected ready')
    assert.equal(first.items.length, 1)
  } finally {
    releaseList()
    releasePoint()
    persistence.list = realList
    query.observeSession = realObserve
    await runtime1?.dispose()
    await runtime2?.dispose()
    await m3?.dispose()
    await host.dispose()
  }
})

test('a real Session born and retired during a held roster scan survives the old roster through the Gateway', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-r12-roster')
  const internals = wire.service() as unknown as {
    deps: { sessionPersistence(): HistorySearchPersistenceLike | undefined }
    verifySources(): Promise<void>
    index: {
      checkpointOf(id: string): { nextSeq: number; sourceState: string; dirty: boolean } | undefined
      occurrenceCount(): number
    }
    sessionRepairFlights: Map<string, { promise: Promise<unknown> }>
    pending: Map<string, unknown>
  }
  const ctx = wire.host.ctx
  const rawPersistence = ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
  const originalList = rawPersistence.list
  let releaseList: () => void = () => {}
  try {
    await wire.host.harness.create(SessionId('history-r12-roster-a'), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await promptHost(wire.host, 'history-r12-roster-a', 'req-r12-roster-a', 'hsp-r12-roster-a')
    await waitForSettled(wire, { scope: 'all', query: 'hsp-r12-roster-a', limit: 25 }, 'roster fixture readiness')

    // The OLD roster names A only; the pass is then latched before B is born.
    const oldRoster = await rawPersistence.list()
    let listEntered!: () => void
    const listReached = new Promise<void>(resolve => { listEntered = resolve })
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    // Block the ACTUAL list method: a replaced deps closure would be a real
    // service-binding replacement and correctly invalidate coverage.
    rawPersistence.list = async function blockedList() {
      listEntered()
      await listGate
      return oldRoster
    }
    const pass = internals.verifySources()
    await listReached

    // B is a REAL Session: official create, durable accepted prompt, then normal
    // AgentHandle retirement, all while the old roster is held.
    const b = await ctx.agents.create({
      sessionId: SessionId('history-r12-roster-b'),
      agentOptions: { provider: 'smoke', model: 'smoke' },
      meta: { cwd: wire.host.anchorDir },
    })
    await promptHost(wire.host, 'history-r12-roster-b', 'req-r12-roster-b', 'hsp-r12-roster-b')
    const createdStarted = Date.now()
    while (
      (internals.index.checkpointOf('history-r12-roster-b') === undefined || internals.pending.size > 0)
      && Date.now() - createdStarted < 10_000
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(internals.index.checkpointOf('history-r12-roster-b') !== undefined, 'the real accepted event must index B before retirement')
    await b.dispose()
    const retiredStarted = Date.now()
    while (internals.sessionRepairFlights.size > 0 && Date.now() - retiredStarted < 10_000) {
      await Promise.allSettled([...internals.sessionRepairFlights.values()].map(entry => entry.promise))
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    // Release the pre-B roster. B is absent from it, but was born after the
    // round-local cut and must keep its derived rows.
    releaseList()
    await pass
    assert.ok(internals.index.checkpointOf('history-r12-roster-b') !== undefined, 'the old roster must not delete a Session born after its cut')
    assert.ok(internals.index.occurrenceCount() >= 1)

    // Restore the current official source: its roster now names B's durable log,
    // so the next full pass reconciles B and the authenticated Owner search answers.
    rawPersistence.list = originalList
    await internals.verifySources()
    const hit = await waitForSettled(wire, { scope: 'all', query: 'hsp-r12-roster-b', limit: 25 }, 'retired B occurrence')
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
    assert.equal(hit.items[0]?.sessionId, 'history-r12-roster-b')
    const a = await wire.search({ scope: 'all', query: 'hsp-r12-roster-a', limit: 25 })
    assert.equal(a.kind, 'ready', JSON.stringify(a))
    if (a.kind !== 'ready') throw new Error('expected ready')
    assert.equal(a.items.length, 1)
  } finally {
    rawPersistence.list = originalList
    releaseList()
    await wire.dispose()
  }
})

test('a real retained-index startup replay owns a pre-reset ordinary backlog without spinning', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'history-search-r13-backlog', {
    pluginManagerProfile: true,
    withoutHostRuntime: true,
  })
  let runtime1: { dispose(): Promise<void> } | undefined
  let runtime2: { dispose(): Promise<void> } | undefined
  let m3: Awaited<ReturnType<typeof createRemoteHostRuntime>> | undefined
  const persistence = host.ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
  const realList = persistence.list
  const query = host.ctx.sessionQuery as unknown as HistorySearchQueryLike
  const realObserve = query.observeSession
  let releaseList: () => void = () => {}
  let releasePoint: () => void = () => {}
  try {
    runtime1 = await host.ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
    m3 = await createRemoteHostRuntime(host.ctx)
    const peer = host.ctx.connection.browserPeer
    const sessionId = 'history-r13-backlog'
    const waitGateway = async (label: string, request: HistorySearchRequest): Promise<HistorySearchResponse> => {
      const started = Date.now()
      for (;;) {
        const answer = await realSearch(host, peer, request)
        if (answer.kind === 'ready') return answer
        if (answer.kind === 'unavailable') throw new Error(`${label}: ${JSON.stringify(answer)}`)
        if (Date.now() - started > 20_000) throw new Error(`${label}: timeout (${answer.kind})`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    const agent = await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
    await promptHost(host, sessionId, 'req-r13-first', 'hsp-r13-first')
    await waitGateway('retained first incarnation', { scope: 'all', query: '', limit: 1 })
    const service1 = host.ctx.reflect.get(PI_TUI_HISTORY_SEARCH_NAMESPACE) as unknown as {
      index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    }
    const retained = service1.index.checkpointOf(sessionId)
    assert.ok(retained !== undefined, 'the first incarnation must retain a real Session checkpoint')
    await runtime1.dispose()
    runtime1 = undefined

    let listEntered!: () => void
    const listReached = new Promise<void>(resolve => { listEntered = resolve })
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    persistence.list = async (options) => {
      listEntered()
      await listGate
      return realList.call(persistence, options)
    }
    const pointGate = new Promise<void>(resolve => { releasePoint = resolve })
    let pointGated = false
    let observations = 0
    let observationError: Error | undefined
    query.observeSession = async (id, options) => {
      observations += 1
      if (observations > 6) {
        observationError = new Error(`unbounded live re-observation (${String(observations)}) on an unchanged backlog`)
        throw observationError
      }
      if (!pointGated && String(id) === sessionId) {
        pointGated = true
        await pointGate
      }
      return realObserve.call(query, id, options)
    }
    runtime2 = await host.ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
    await listReached

    // A finite contiguous accepted burst > one 256-event writer batch, all
    // before the required reset, while the retained roster read is held.
    const burst = 600
    for (let index = 0; index < burst; index += 1) {
      const message = createUserMessage({
        content: [{ type: 'text', text: `hsp-r13-backlog-${String(index)}` }],
        source: { kind: 'user', rpcId: `rpc-r13-backlog-${String(index)}` as never },
      })
      agent.session.append([['agent/inbox/spliced', { target: 'next-turn', start: index, inserted: [message] }]])
    }
    const service2Proxy = host.ctx.reflect.get(PI_TUI_HISTORY_SEARCH_NAMESPACE) as unknown as {
      index: { checkpointOf(id: string): { nextSeq: number } | undefined }
      pending: Map<string, { events: unknown[] }>
      heldPending: Set<string>
      sessionRepairFlights: Map<string, unknown>
      rebuildRequests: Set<string>
      reconcilePending: Set<string>
      state: { kind: string }
      coverage: string
      pointCounters: PointCountersLike
    }
    const service2 = ((service2Proxy as unknown as Record<symbol, unknown>)[symbols.original] ?? service2Proxy) as typeof service2Proxy
    const bufferedStarted = Date.now()
    while ((service2.pending.get(sessionId)?.events.length ?? 0) < burst && Date.now() - bufferedStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok((service2.pending.get(sessionId)?.events.length ?? 0) >= burst, 'the whole accepted burst must be buffered before release')
    releaseList()
    const pointStarted = Date.now()
    while (!pointGated && Date.now() - pointStarted < 5_000) {
      assert.equal(observationError, undefined, String(observationError))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observationError, undefined, String(observationError))
    assert.equal(pointGated, true, JSON.stringify({
      state: service2.state,
      coverage: service2.coverage,
      checkpoint: service2.index.checkpointOf(sessionId),
      pending: service2.pending.get(sessionId)?.events.length,
      held: service2.heldPending.has(sessionId),
      flights: [...service2.sessionRepairFlights.keys()],
      rebuilds: [...service2.rebuildRequests],
      observations,
    }))
    // The point owns the unchanged ordinary remainder; the reset/replay can
    // proceed instead of re-observing the same backlog forever.
    assert.equal(service2.heldPending.has(sessionId), true, 'the authoritative replay must take over the remaining accepted backlog')
    const remainder = service2.pending.get(sessionId)?.events.length ?? 0
    assert.ok(remainder > 0 && remainder < burst, JSON.stringify({ remainder, checkpoint: service2.index.checkpointOf(sessionId) }))
    const afterDrain = service2.index.checkpointOf(sessionId)
    assert.ok(afterDrain !== undefined)
    assert.ok(afterDrain.nextSeq > retained.nextSeq)
    releasePoint()
    const readyStarted = Date.now()
    let replayed: HistorySearchResponse
    for (;;) {
      replayed = await realSearch(host, peer, { scope: 'all', query: 'hsp-r13-backlog-599', limit: 25 })
      if (replayed.kind === 'ready' || replayed.kind === 'unavailable') break
      assert.equal(observationError, undefined, String(observationError))
      if (Date.now() - readyStarted > 20_000) {
        assert.fail(JSON.stringify({
          kind: replayed.kind,
          state: service2.state,
          coverage: service2.coverage,
          pending: service2.pending.get(sessionId)?.events.length,
          held: service2.heldPending.has(sessionId),
          flights: [...service2.sessionRepairFlights.keys()],
          rebuilds: [...service2.rebuildRequests],
          checkpoint: service2.index.checkpointOf(sessionId),
          observations,
        }))
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observationError, undefined, String(observationError))
    assert.equal(replayed.kind, 'ready', JSON.stringify(replayed))
    if (replayed.kind !== 'ready') throw new Error('expected ready')
    assert.equal(replayed.items.length, 1)
    assert.equal(replayed.items[0]?.sessionId, sessionId)
    assert.equal(replayed.items[0]?.preview, 'hsp-r13-backlog-599')
    assert.equal(service2.pending.has(sessionId), false, 'the replay terminal must settle the owned backlog')
    assert.equal(service2.heldPending.has(sessionId), false)
    const first = await realSearch(host, peer, { scope: 'all', query: 'hsp-r13-first', limit: 25 })
    assert.equal(first.kind, 'ready', JSON.stringify(first))
    if (first.kind !== 'ready') throw new Error('expected ready')
    assert.equal(first.items.length, 1)
    // The pre-reset backlog is a LIVE point replay: it observes the official
    // live source and completes a replay without any persistence read.
    const point = pointCountersOf(service2.pointCounters)
    assert.ok(point.observe >= 1, 'the point live replay must observe the official Session')
    assert.ok(point.replayAttempted >= 1, 'the point live replay must attempt a real replay')
    assert.ok(point.replayCompleted >= 1, 'the point replay terminal must be reported as completed')
    assert.equal(point.stat, 0, 'a live point replay performs no persistence stat')
    assert.equal(point.open, 0, 'a live point replay performs no persistence open')
    assert.equal(point.prefix, 0, 'a live point replay performs no durable-prefix proof')
  } finally {
    releaseList()
    releasePoint()
    persistence.list = realList
    query.observeSession = realObserve
    await runtime1?.dispose()
    await runtime2?.dispose()
    await m3?.dispose()
    await host.dispose()
  }
})

test('a required initial replay invalidated by ordinary pending is handed to the point repair owner', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r10-replay-handoff-')
  const source = mutableSource('/repo/r10-a', 'r10-a')
  source.live = true
  const firstCtx = new Context()
  const first = directService(firstCtx, mutableDeps(source).deps, profileDir)
  try {
    await waitDirectReady(first)
  } finally {
    await first.dispose()
    await firstCtx.fiber.dispose()
  }

  const { deps } = mutableDeps(source)
  const persistence = deps.sessionPersistence()
  const query = deps.sessionQuery()
  const realObserve = query.observeSession
  let pointEntered!: () => void
  const pointReached = new Promise<void>(resolve => { pointEntered = resolve })
  let releasePoint!: () => void
  const pointGate = new Promise<void>(resolve => { releasePoint = resolve })
  let pointGated = false
  query.observeSession = async (id, options) => {
    if (!pointGated && String(id) === 'r10-a') {
      pointGated = true
      pointEntered()
      await pointGate
    }
    return realObserve.call(query, id, options)
  }
  // The cold start calls list() synchronously while the service is still being
  // constructed, so this gate MUST be installed before directService().
  const realList = persistence.list
  let listEntered!: () => void
  const listReached = new Promise<void>(resolve => { listEntered = resolve })
  let releaseList!: () => void
  const listGate = new Promise<void>(resolve => { releaseList = resolve })
  persistence.list = async () => {
    listEntered()
    await listGate
    return realList.call(persistence)
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): { nextSeq: number } | undefined }
    observeLiveEvent(session: unknown, event: unknown): void
    pending: Map<string, unknown>
    sessionRepairFlights: Map<string, unknown>
    rebuildRequests: Set<string>
    reconcilePending: Set<string>
    state: { kind: string }
    coverage: string
  }
  const deliver = (seq: number, text: string): void => {
    const event = {
      type: 'agent/inbox/spliced',
      seq,
      time: 26_000 + seq,
      data: {
        target: 'next-turn',
        start: seq,
        inserted: [{
          id: `r10-a-${String(seq)}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: `rpc-r10-a-${String(seq)}` },
        }],
      },
    }
    source.events.push(event)
    internals.observeLiveEvent(liveSessionOf(source), event)
  }
  try {
    await listReached
    // Ordinary accepted work arrives BEFORE the required initial reset against
    // the retained clean prior-incarnation checkpoint.
    deliver(3, 'r10-a new three')
    deliver(4, 'r10-a new four')
    releaseList()
    // The point repair's authoritative observation is held AFTER the coldStart's
    // ordinary drain settles. The point must therefore capture the post-drain
    // checkpoint, not race the drain with an older candidate.
    const pointSeen = await Promise.race([
      pointReached.then(() => true),
      // Bounded failure window; the gate itself is the authoritative signal.
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
    ])
    assert.equal(pointSeen, true, JSON.stringify({
      pointGated,
      checkpoint: internals.index.checkpointOf('r10-a'),
      pending: internals.pending.size,
      flights: [...internals.sessionRepairFlights.keys()],
      rebuilds: [...internals.rebuildRequests],
      reconcile: [...internals.reconcilePending],
      state: internals.state,
      coverage: internals.coverage,
    }))
    // The point observation must already see the coldStart's OWN drain result.
    // Waiting here would let a separately scheduled drain mask the race.
    assert.equal(internals.index.checkpointOf('r10-a')?.nextSeq, 5)
    assert.equal(internals.pending.size, 0)
    releasePoint()
    const readyStarted = Date.now()
    let ready = false
    while (Date.now() - readyStarted < 3_000) {
      const answer = await service.search({ scope: 'all', query: 'r10-a new four', limit: 25 }, new AbortController().signal)
      if (answer.kind === 'ready') {
        ready = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(ready, true, 'the required replay owner must not wait for the 30 s timer')
    assert.equal(internals.index.checkpointOf('r10-a')?.nextSeq, 5)
    const old = await service.search({ scope: 'all', query: 'mutable first', limit: 25 }, new AbortController().signal)
    assert.equal(old.kind, 'ready', JSON.stringify(old))
    if (old.kind !== 'ready') throw new Error('expected ready')
    assert.equal(old.items.length, 1)
    const three = await service.search({ scope: 'all', query: 'r10-a new three', limit: 25 }, new AbortController().signal)
    assert.equal(three.kind, 'ready', JSON.stringify(three))
    if (three.kind !== 'ready') throw new Error('expected ready')
    assert.equal(three.items.length, 1)
    const four = await service.search({ scope: 'all', query: 'r10-a new four', limit: 25 }, new AbortController().signal)
    assert.equal(four.kind, 'ready', JSON.stringify(four))
    if (four.kind !== 'ready') throw new Error('expected ready')
    assert.equal(four.items.length, 1)
  } finally {
    releaseList()
    releasePoint()
    persistence.list = realList
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('unproven coverage never resets disposed-live accepted rows against a short durable source', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-r10-disposed-short-')
  const a = mutableSource('/repo/r10-disposed-a', 'r10-disposed-a')
  const b = mutableSource('/repo/r10-disposed-b', 'r10-disposed-b')
  a.live = true
  b.live = true
  const { deps } = mutableDeps(a, [b])
  const query = deps.sessionQuery()
  const realObserve = query.observeSession.bind(query)
  let bFailed = false
  query.observeSession = async (id, options) => {
    if (!bFailed && String(id) === 'r10-disposed-b') {
      bFailed = true
      throw new Error('R10-01 injected first-pass B failure')
    }
    return realObserve(id, options)
  }
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const internals = service as unknown as {
    index: { checkpointOf(id: string): { nextSeq: number; dirty: boolean; sourceState: string } | undefined; occurrenceCount(): number }
    verifySources(): Promise<void>
    observeLiveEvent(session: unknown, event: unknown): void
    observeDisposedSession(session: unknown): void
  }
  const waitNotLoading = async (): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const answer = await service.search({ scope: 'all', query: 'r10-disposed', limit: 25 }, new AbortController().signal)
      if (answer.kind !== 'loading') return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('first pass did not settle')
  }
  const accepted = {
    type: 'agent/inbox/spliced',
    seq: 3,
    time: 27_000,
    data: {
      target: 'next-turn',
      start: 3,
      inserted: [{
        id: 'r10-disposed-a-new',
        role: 'user',
        content: [{ type: 'text', text: 'r10 disposed accepted new' }],
        source: { kind: 'user', rpcId: 'rpc-r10-disposed-a' },
      }],
    },
  }
  try {
    await waitNotLoading()
    assert.equal(bFailed, true)
    assert.equal(internals.index.checkpointOf('r10-disposed-a')?.nextSeq, 3)
    // A current-incarnation accepted live row, while coverage is unproven (B).
    a.events.push(accepted)
    internals.observeLiveEvent(liveSessionOf(a), accepted)
    const acceptedStarted = Date.now()
    while (internals.index.checkpointOf('r10-disposed-a')?.nextSeq !== 4 && Date.now() - acceptedStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.index.checkpointOf('r10-disposed-a')?.nextSeq, 4)
    // A retires with a readable but SHORT durable source. The disposal proof
    // retains the accepted rows and marks dirty.
    a.live = false
    a.events = a.events.slice(0, 3)
    internals.observeDisposedSession({ id: 'r10-disposed-a' })
    const dirtyStarted = Date.now()
    while (internals.index.checkpointOf('r10-disposed-a')?.dirty !== true && Date.now() - dirtyStarted < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.index.checkpointOf('r10-disposed-a')?.dirty, true)
    assert.equal(internals.index.occurrenceCount(), 3)

    // B recovers; the next full pass sees A dirty/short under unproven coverage.
    // It must preserve A's accepted rows instead of resetting to the short log.
    await internals.verifySources()
    let answer = await service.search({ scope: 'all', query: 'r10 disposed accepted new', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'incomplete', JSON.stringify(answer))
    assert.equal(internals.index.checkpointOf('r10-disposed-a')?.nextSeq, 4)
    assert.equal(internals.index.occurrenceCount(), 5)

    // Restore the authoritative durable source; the current-incarnation replay
    // repairs A and the exact Owner hit is visible.
    a.events.push(accepted)
    await internals.verifySources()
    await waitDirectReady(service)
    answer = await service.search({ scope: 'all', query: 'r10 disposed accepted new', limit: 25 }, new AbortController().signal)
    assert.equal(answer.kind, 'ready', JSON.stringify(answer))
    if (answer.kind !== 'ready') throw new Error('expected ready')
    assert.equal(answer.items.length, 1)
    assert.equal(internals.index.checkpointOf('r10-disposed-a')?.nextSeq, 4)
  } finally {
    query.observeSession = realObserve
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a materialized empty cold Session and a real empty live Session settle a checkpoint and take the first accepted event', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'history-search-pr25-empty-settle', {
    pluginManagerProfile: true,
    withoutHostRuntime: true,
  })
  let runtime: { dispose(): Promise<void> } | undefined
  let m3: Awaited<ReturnType<typeof createRemoteHostRuntime>> | undefined
  const officialPersistence = host.ctx.sessionPersistence
  const persistence = host.ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
  const query = host.ctx.sessionQuery as unknown as HistorySearchQueryLike
  const coldId = 'history-pr25-cold-empty'
  const liveId = 'history-pr25-live-empty'
  const trackedIds = [coldId, liveId] as const
  // Test-owned timing seams: every wrapper calls the ORIGINAL method on the
  // original receiver and returns its value unchanged.
  const statIds: string[] = []
  const openIds: string[] = []
  const observeIds: string[] = []
  const realStat = persistence.stat
  const realOpen = persistence.open
  const realObserve = query.observeSession
  try {
    // 1. A REAL materialized header-only cold Session: the official write handle
    //    creates it, `flush()` is the durability barrier that materializes it.
    //    No append, no Agent seed, no hand-written JSONL.
    const writer = await officialPersistence.create(testHeader(coldId, host.anchorDir))
    try {
      await writer.flush()
    } finally {
      await writer.close()
    }
    const coldSnapshot = await officialPersistence.stat(SessionId(coldId))
    assert.ok(coldSnapshot !== undefined, 'the flushed header-only Session must be officially statable')
    assert.notEqual(coldSnapshot.location, undefined, 'the materialized header-only Session must have a real location')
    const coldRead = await officialPersistence.open(SessionId(coldId), 'read')
    let coldHeader: unknown
    try {
      coldHeader = coldRead.header
      assert.equal(coldRead.header.cwd, host.anchorDir)
      assert.equal(Number(coldRead.inheritedEventCount), 0)
      assert.deepEqual((await coldRead.read(0, 1)).events, [], 'a materialized empty Session has no official events')
    } finally {
      await coldRead.close()
    }

    // 2. A REAL registered zero-event live Session (official SessionStore, no
    //    Agent seed and therefore no persistence writer).
    const liveSession = host.ctx.sessions.create(SessionId(liveId), { meta: { cwd: host.anchorDir } })
    assert.equal(host.ctx.sessions.get(SessionId(liveId)), liveSession, 'the live registry must hold this exact object')
    const liveObservation = await host.ctx.sessionQuery.observeSession(SessionId(liveId), { projectionMode: 'none' })
    let liveHeader: unknown
    try {
      liveHeader = liveObservation.header
      assert.deepEqual([...liveObservation.events], [], 'the live Session really has no events')
      assert.equal(Number(liveObservation.inheritedEventCount), 0)
    } finally {
      liveObservation[Symbol.dispose]()
    }

    // Record the real official calls from here on; the setup reads above are
    // deliberately outside every measurement window.
    persistence.stat = async (id, options) => {
      statIds.push(String(id))
      return realStat.call(persistence, id, options)
    }
    persistence.open = async (id, access, options) => {
      openIds.push(String(id))
      return realOpen.call(persistence, id, access, options)
    }
    query.observeSession = async (id, options) => {
      observeIds.push(String(id))
      return realObserve.call(query, id, options)
    }
    const scopedCalls = (ids: readonly string[]): { stat: number; open: number; observe: number } => ({
      stat: statIds.filter(id => ids.includes(id)).length,
      open: openIds.filter(id => ids.includes(id)).length,
      observe: observeIds.filter(id => ids.includes(id)).length,
    })

    runtime = await host.ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
    m3 = await createRemoteHostRuntime(host.ctx)
    const peer = host.ctx.connection.browserPeer
    const waitGateway = async (request: HistorySearchRequest): Promise<HistorySearchResponse> => {
      const started = Date.now()
      for (;;) {
        const answer = await realSearch(host, peer, request)
        if (answer.kind === 'ready' || answer.kind === 'unavailable') return answer
        if (Date.now() - started > 15_000) throw new Error(`history readiness timeout (${answer.kind})`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    const readText = async (request: HistoryReadTextRequest): Promise<HistoryReadTextResponse> => (
      parseHistoryReadTextResponse(await host.ctx.typertGateway.invoke({
        namespace: PI_TUI_HISTORY_SEARCH_NAMESPACE,
        method: 'readText',
        args: { request },
        peer,
        signal: new AbortController().signal,
      }))
    )
    const ready = await waitGateway({ scope: 'all', query: '', limit: 1 })
    assert.equal(ready.kind, 'ready', JSON.stringify(ready))

    const serviceProxy = host.ctx.reflect.get(PI_TUI_HISTORY_SEARCH_NAMESPACE) as unknown as {
      index: {
        checkpointOf(id: string): unknown
        occurrenceCount(): number
        revision: number
      }
      verifySources(): Promise<void>
    }
    const service = ((serviceProxy as unknown as Record<symbol, unknown>)[symbols.original] ?? serviceProxy) as typeof serviceProxy
    const coldRow = service.index.checkpointOf(coldId)
    assert.deepEqual(coldRow, {
      sessionId: coldId,
      headerCwd: host.anchorDir,
      inheritedCut: 0,
      nextSeq: 0,
      effectiveCwd: host.anchorDir,
      lastEventHash: null,
      headerHash: sessionHeaderHash(coldHeader),
      sourceState: 'persisted',
      uncertainSources: 0,
      dirty: false,
    }, 'the materialized empty cold source must settle a real zero-event checkpoint')
    assert.deepEqual(service.index.checkpointOf(liveId), {
      sessionId: liveId,
      headerCwd: host.anchorDir,
      inheritedCut: 0,
      nextSeq: 0,
      effectiveCwd: host.anchorDir,
      lastEventHash: null,
      headerHash: sessionHeaderHash(liveHeader),
      sourceState: 'live',
      uncertainSources: 0,
      dirty: false,
    }, 'the real empty live source must settle a live zero-event checkpoint')
    assert.equal(service.index.occurrenceCount(), 0, 'an empty source must create no accepted occurrence')
    // A zero-event checkpoint is not a content mutation: no keyset cursor may be
    // invalidated by settling one (only occurrence insert/reset/delete moves it).
    assert.equal(service.index.revision, 0, 'settling an empty checkpoint must not advance the content generation')
    const revisionBeforePass = service.index.revision

    // 3. An explicit production verification pass over the unchanged sources:
    //    the settled zero-event checkpoints make the empty tail a no-read fact.
    const beforePass = scopedCalls(trackedIds)
    await service.verifySources()
    assert.deepEqual(scopedCalls(trackedIds), beforePass,
      'a stable zero-event checkpoint must not trigger another official stat/open/observe')
    assert.equal(service.index.revision, revisionBeforePass, 'a no-read pass must not rewrite content')
    assert.deepEqual(service.index.checkpointOf(coldId), coldRow)
    assert.equal((await waitGateway({ scope: 'all', query: '', limit: 1 })).kind, 'ready')

    // 4. The FIRST real accepted event of the zero-event live Session enters the
    //    ordinary bounded drain (seq 0 at the settled checkpoint), not a repair.
    const text = 'hsp-pr25-empty-live-first-event'
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'rpc-pr25-empty-live-first' as never },
    })
    const beforeAppend = scopedCalls(trackedIds)
    liveSession.append([['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] }]])
    const drainStarted = Date.now()
    for (;;) {
      const checkpoint = service.index.checkpointOf(liveId) as { nextSeq: number; dirty: boolean } | undefined
      if (checkpoint?.nextSeq === 1 && checkpoint.dirty === false) break
      if (Date.now() - drainStarted > 10_000) {
        throw new Error(`the first accepted event did not settle: ${JSON.stringify({
          checkpoint,
          pending: scopedCalls(trackedIds),
          state: (service as unknown as { state: unknown }).state,
        })}`)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.deepEqual(scopedCalls(trackedIds), beforeAppend,
      'the first accepted event must drain from the settled checkpoint, not from a missing-checkpoint repair')

    const hit = await waitGateway({ scope: 'session', sessionId: liveId, query: text, limit: 25 })
    assert.equal(hit.kind, 'ready', JSON.stringify(hit))
    if (hit.kind !== 'ready') throw new Error('expected ready')
    assert.equal(hit.items.length, 1)
    const item = hit.items[0]!
    assert.equal(item.sessionId, liveId)
    assert.equal(item.preview, text)
    assert.equal(item.contentSha256, sha256(text))
    const chunk = await readText({
      sessionId: item.sessionId,
      messageId: item.messageId,
      contentSha256: item.contentSha256,
      offset: 0,
      limit: 4096,
    })
    assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
    if (chunk.kind !== 'ready') throw new Error('expected ready')
    assert.equal(chunk.chunk, text)
    assert.equal(chunk.contentLength, text.length)
  } finally {
    persistence.stat = realStat
    persistence.open = realOpen
    query.observeSession = realObserve
    await runtime?.dispose()
    await m3?.dispose()
    await host.dispose()
  }
})

// ── durable cold source proof recovery ────────────────────────────────────

/** Parse the last named diagnostic record into its `key=value` fields. */
function diagnosticFields(log: string, message: string): Record<string, string> {
  const line = log.split('\n').filter(candidate => candidate.includes(message)).at(-1)
  assert.ok(line !== undefined, `missing ${message} diagnostic`)
  const fields: Record<string, string> = {}
  for (const part of line.split(' ')) {
    const match = /^([A-Za-z][A-Za-z]+)=(.+)$/u.exec(part)
    if (match !== null) fields[match[1]!] = match[2]!
  }
  return fields
}

/**
 * One structural pass authority equivalent to a qualified Q capture. The H
 * policy tests use it as a TEST STAND-IN for the real runtime classification;
 * the L3 authority suite exercises the real provider facts.
 */
function proofAuthority(root: string, scopeKey = 'a'.repeat(64)): {
  readonly authority: HistoryRevisionAuthority
  setCurrent(value: boolean): void
} {
  let current = true
  const authority: HistoryRevisionAuthority = {
    service: {},
    identity: Symbol('test-proof-authority'),
    scopeKey,
    root,
    codec: 'zstd',
    isCurrent: () => current,
  }
  return {
    authority,
    setCurrent: value => {
      current = value
    },
  }
}

function proofSnapshot(source: MutableOfficialSource): {
  formatStatus: 'current' | 'migration-required' | undefined
  location: { readonly kind: string; readonly path: string } | undefined
  revision: unknown
} {
  return { formatStatus: source.formatStatus, location: source.location, revision: source.revisionToken ?? source.revision }
}

/** A cold current official source with a stable absolute artifact path. */
function proofSource(root: string, overrides: Partial<MutableOfficialSource> = {}): MutableOfficialSource {
  const source = mutableSource('/repo/proof', 'proof-session')
  return {
    ...source,
    revisionToken: 'rev-1',
    formatStatus: 'current',
    location: { kind: 'jsonl', path: join(root, 'sessions', 'proof-session.jsonl.zstd') },
    ...overrides,
  }
}

/**
 * Seed the derived checkpoint (and, unless disabled, its exact durable proof)
 * a complete previous cold replay would have left behind.
 */
function seedColdProof(
  profileDir: string,
  source: MutableOfficialSource,
  authority: HistoryRevisionAuthority,
  options: {
    readonly nextSeq?: number
    readonly mint?: boolean
    readonly basisAuthority?: HistoryRevisionAuthority
    readonly occurrences?: readonly HistoryOccurrenceInput[]
  } = {},
): void {
  const sessionId = String(source.header.id)
  const index = HistorySearchIndex.open({ profileDir })
  try {
    const nextSeq = options.nextSeq ?? source.events.length
    const headerCwd = normalizeHistoryCwd(source.header.cwd)
    index.commitBatch({
      sessionId,
      headerHash: sessionHeaderHash(source.header),
      inheritedCut: 0,
      baseNextSeq: 0,
      nextSeq,
      headerCwd,
      effectiveCwd: headerCwd,
      lastEventHash: nextSeq === 0 ? null : sessionEventHash(source.events[nextSeq - 1]!),
      sourceState: 'persisted',
      uncertainSourcesDelta: 0,
      occurrences: options.occurrences ?? [],
    })
    if (options.mint === false) return
    const checkpoint = index.checkpointOf(sessionId)
    assert.ok(checkpoint !== undefined)
    const basis = sourceProofBasis(options.basisAuthority ?? authority, proofSnapshot(source))
    assert.ok(basis !== undefined, 'the seeded source must be proof-eligible')
    index.commitSourceProof(checkpoint, basis)
  } finally {
    index.close()
  }
}

function rewriteProofContractVersion(profileDir: string, version: number): void {
  const db = new DatabaseSync(join(profileDir, '.dsh-pi-tui', 'history-search', 'v3.sqlite'))
  try {
    db.prepare('UPDATE history_source_proofs SET contract_version = ?').run(version)
  } finally {
    db.close()
  }
}

async function verifyFullPass(service: PiTuiHistorySearchHostService): Promise<void> {
  await (service as unknown as { verifySources(): Promise<void> }).verifySources()
}

function indexOfService(service: PiTuiHistorySearchHostService): HistorySearchIndex {
  const index = (service as unknown as { index: HistorySearchIndex | undefined }).index
  assert.ok(index !== undefined)
  return index
}

test('an exact qualified cold proof is reused with zero official reads, and every ineligible fact replays', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-hit-root-')
  const profileDir = life.tempDir('dsh-history-proof-hit-profile-')
  const source = proofSource(root)
  const probe = proofAuthority(root)
  seedColdProof(profileDir, source, probe.authority)

  const { deps, calls } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, { ...deps, revisionAuthority: async () => probe.authority, sessionPersistence: () => deps.sessionPersistence() }, profileDir)
  try {
    await waitDirectReady(service)
    assert.equal(calls.openCalls(), 0, 'a proof hit must not open the official source')
    assert.equal(calls.statCalls(), 0, 'a proof hit must not stat the official source')
    assert.equal(calls.readCalls(), 0, 'a proof hit must not read the official source')
    // A stable proven epoch keeps its same-instance no-read fast path.
    await verifyFullPass(service)
    assert.equal(calls.openCalls(), 0)
    assert.equal(calls.statCalls(), 0)
    assert.equal(calls.readCalls(), 0)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }

  const negatives: Array<{
    readonly label: string
    readonly seed?: (profileDir: string, source: MutableOfficialSource, authority: HistoryRevisionAuthority) => void
    readonly mutate?: (source: MutableOfficialSource, probe: ReturnType<typeof proofAuthority>) => void
  }> = [
    { label: 'a missing proof', seed: (dir, candidate, authority) => seedColdProof(dir, candidate, authority, { mint: false }) },
    { label: 'a moved checkpoint count', seed: (dir, candidate, authority) => seedColdProof(dir, candidate, authority, { nextSeq: 2 }) },
    { label: 'a changed revision', mutate: candidate => { candidate.revisionToken = 'rev-2' } },
    { label: 'a changed header', mutate: candidate => { candidate.header = testHeader(String(candidate.header.id), '/repo/other') } },
    { label: 'a path outside the root', mutate: candidate => { candidate.location = { kind: 'jsonl', path: '/elsewhere/proof-session.jsonl.zstd' } } },
    { label: 'a wrong codec suffix', mutate: candidate => { candidate.location = { kind: 'jsonl', path: join(root, 'sessions', 'proof-session.jsonl') } } },
    {
      label: 'a different install scope',
      seed: (dir, candidate, authority) => {
        const other = proofAuthority(authority.root, 'b'.repeat(64))
        seedColdProof(dir, candidate, other.authority)
      },
    },
    {
      label: 'a stale pass authority',
      mutate: (_candidate, currentProbe) => { currentProbe.setCurrent(false) },
    },
    {
      label: 'an older proof contract',
      seed: (dir, candidate, authority) => {
        seedColdProof(dir, candidate, authority)
        rewriteProofContractVersion(dir, 1)
      },
    },
    { label: 'a live registration', mutate: candidate => { candidate.live = true } },
  ]
  for (const negative of negatives) {
    const caseRoot = life.tempDir('dsh-history-proof-miss-root-')
    const caseProfile = life.tempDir('dsh-history-proof-miss-profile-')
    const caseSource = proofSource(caseRoot)
    const caseProbe = proofAuthority(caseRoot)
    ;(negative.seed ?? ((dir, candidate, authority) => seedColdProof(dir, candidate, authority)))(
      caseProfile,
      caseSource,
      caseProbe.authority,
    )
    negative.mutate?.(caseSource, caseProbe)
    const caseDeps = mutableDeps(caseSource)
    const caseCtx = new Context()
    let caseService: PiTuiHistorySearchHostService | undefined
    caseService = directService(caseCtx, {
      ...caseDeps.deps,
      revisionAuthority: async () => caseProbe.authority,
    }, caseProfile)
    try {
      await waitDirectReady(caseService, 15_000)
      assert.ok(
        caseDeps.calls.openCalls() + caseDeps.calls.observeCalls() > 0,
        `${negative.label} must fall back to an official read, not a silent proof hit`,
      )
    } finally {
      await caseService.dispose()
      await caseCtx.fiber.dispose()
    }
  }
})

/**
 * Seed the derived checkpoint (and optional proof) a PRE-UPGRADE v2 index left
 * behind: the caller supplies the old classifier's rows explicitly, so the
 * fixture really reproduces the old projection instead of asking the new fold.
 */
function seedOldV2Session(
  profileDir: string,
  source: MutableOfficialSource,
  authority: HistoryRevisionAuthority | undefined,
  options: {
    readonly occurrences: readonly {
      readonly messageId: string
      readonly firstEventSeq: number
      readonly acceptedAt: number
      readonly effectiveCwd: string | null
      readonly content: string
      readonly hasNonText: boolean
    }[]
    readonly uncertainSources?: number
  },
): void {
  const sessionId = String(source.header.id)
  const index = HistorySearchIndex.open({ profileDir })
  try {
    const nextSeq = source.events.length
    const headerCwd = normalizeHistoryCwd(source.header.cwd)
    index.commitBatch({
      sessionId,
      headerHash: sessionHeaderHash(source.header),
      inheritedCut: 0,
      baseNextSeq: 0,
      nextSeq,
      headerCwd,
      effectiveCwd: headerCwd,
      lastEventHash: nextSeq === 0 ? null : sessionEventHash(source.events[nextSeq - 1]!),
      sourceState: 'persisted',
      uncertainSourcesDelta: options.uncertainSources ?? 0,
      occurrences: options.occurrences,
    })
    if (authority !== undefined) {
      const checkpoint = index.checkpointOf(sessionId)
      assert.ok(checkpoint !== undefined)
      const basis = sourceProofBasis(authority, proofSnapshot(source))
      assert.ok(basis !== undefined, 'the seeded old Session must be proof-eligible')
      index.commitSourceProof(checkpoint, basis)
    }
  } finally {
    index.close()
  }
}

test('a pre-upgrade v2 projection with a no-rpcId accepted input replays and mints the new contract', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-old-v2-root-')
  const profileDir = life.tempDir('dsh-history-old-v2-profile-')
  const probe = proofAuthority(root)
  const correlatedText = 'hsp-old-correlated'
  const uncorrelatedText = 'hsp-old-uncorrelated'
  // Session A: a CONTROLLED version-mismatch fixture (not a real old binary
  // run): one normally correlated accepted input, a clean checkpoint and a v1
  // proof. This is exactly the state the old admission would have produced.
  const proofSession = proofSource(root, {
    header: testHeader('old-proof-session', '/repo/old-a'),
    events: [
      {
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 1000,
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{
            id: 'old-correlated',
            role: 'user',
            content: [{ type: 'text', text: correlatedText }],
            source: { kind: 'user', rpcId: 'rpc-old-correlated' },
          }],
        },
      },
    ],
    location: { kind: 'jsonl', path: join(root, 'sessions', 'old-proof-session.jsonl.zstd') },
  })
  // Session B: a REAL pre-upgrade state. The uncorrelated message arrives in
  // both the inbox insertion and its later user/message consume; old admission
  // increments unknownSources twice and omits it, so the checkpoint carries
  // uncertainty=2 and can never own a proof.
  const markerSession = proofSource(root, {
    header: testHeader('old-marker-session', '/repo/old-b'),
    events: [
      {
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 2000,
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{
            id: 'old-marker-correlated',
            role: 'user',
            content: [{ type: 'text', text: 'hsp-old-marker' }],
            source: { kind: 'user', rpcId: 'rpc-old-marker' },
          }],
        },
      },
      {
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2001,
        data: {
          target: 'next-turn',
          start: 1,
          inserted: [{
            id: 'old-uncorrelated',
            role: 'user',
            content: [{ type: 'text', text: uncorrelatedText }],
            source: { kind: 'user' },
          }],
        },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 2002,
        data: {
          id: 'old-uncorrelated',
          role: 'user',
          content: [{ type: 'text', text: uncorrelatedText }],
          source: { kind: 'user' },
        },
      },
    ],
    location: { kind: 'jsonl', path: join(root, 'sessions', 'old-marker-session.jsonl.zstd') },
  })
  seedOldV2Session(profileDir, proofSession, probe.authority, {
    occurrences: [{
      messageId: 'old-correlated',
      firstEventSeq: 0,
      acceptedAt: 1000,
      effectiveCwd: '/repo/old-a',
      content: correlatedText,
      hasNonText: false,
    }],
  })
  seedOldV2Session(profileDir, markerSession, undefined, {
    occurrences: [{
      messageId: 'old-marker-correlated',
      firstEventSeq: 0,
      acceptedAt: 2000,
      effectiveCwd: '/repo/old-b',
      content: 'hsp-old-marker',
      hasNonText: false,
    }],
    uncertainSources: 2,
  })
  rewriteProofContractVersion(profileDir, 1)

  // The OLD projection really omitted the no-rpcId occurrence; B carried its
  // real positive marker and no proof, while A carried its clean v1 proof.
  {
    const index = HistorySearchIndex.open({ profileDir })
    try {
      assert.equal(index.sourceProofOf('old-proof-session')?.contractVersion, 1)
      assert.equal(index.checkpointOf('old-proof-session')?.uncertainSources, 0)
      assert.equal(index.sourceProofOf('old-marker-session'), undefined)
      assert.equal(index.checkpointOf('old-marker-session')?.uncertainSources, 2)
      assert.equal(index.search({ scope: 'all', query: uncorrelatedText, limit: 25 }).rows.length, 0,
        'the old projection must really omit the no-rpcId accepted input')
      assert.equal(index.search({ scope: 'all', query: correlatedText, limit: 25 }).rows.length, 1)
      assert.equal(index.search({ scope: 'all', query: 'hsp-old-marker', limit: 25 }).rows.length, 1)
      assert.equal(index.search({ scope: 'all', query: 'hsp-old-', limit: 25 }).rows.length, 2,
        'the old projection stored only the two correlated rows')
    } finally {
      index.close()
    }
  }

  const { deps, calls } = mutableDeps(proofSession, [markerSession])
  const basePersistence = deps.sessionPersistence()!
  let latched = false
  let release = (): void => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const gated: HistorySearchPersistenceLike = {
    identity: basePersistence.identity,
    list: options => basePersistence.list(options),
    stat: (id, options) => basePersistence.stat(id, options),
    open: async (id, access, options) => {
      if (String(id) === 'old-proof-session') {
        latched = true
        await gate
      }
      return basePersistence.open(id, access, options)
    },
  }
  const ctx = new Context()
  let service = directService(ctx, {
    ...deps,
    sessionPersistence: () => gated,
    revisionAuthority: async () => probe.authority,
  }, profileDir)
  try {
    const deadline = Date.now() + 20_000
    while (!latched && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(latched, true, 'the version1 proof must not hit: the official source must be reopened')
    const early = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    // The old marker Session's proof is still being replays; once its terminal
    // settles the healthy first round may answer a partial page, but it must
    // never claim full coverage or ready.
    assert.ok(early.kind === 'partial' || early.kind === 'loading' || early.kind === 'incomplete',
      `the first round is unproven: ${JSON.stringify(early)}`)
    if (early.kind === 'partial') {
      assert.equal(early.progress.total, 2)
      assert.ok(early.progress.settled >= 1 && early.progress.settled < early.progress.total)
    }
    release()
    await waitDirectReady(service, 20_000)
    const all = await service.search({ scope: 'all', query: 'hsp-old-', limit: 25 }, new AbortController().signal)
    assert.equal(all.kind, 'ready', JSON.stringify(all))
    if (all.kind !== 'ready') throw new Error('expected ready')
    assert.equal(all.items.length, 3, 'the replay must restore both old rows plus the omitted no-rpcId input')
    assert.deepEqual(
      all.items.map(candidate => candidate.messageId).sort(),
      ['old-correlated', 'old-marker-correlated', 'old-uncorrelated'],
      'the three accepted occurrences stay distinct',
    )
    const item = all.items.find(candidate => candidate.preview === uncorrelatedText)
    assert.ok(item !== undefined, 'the no-rpcId occurrence must be restored')
    assert.equal(item.sessionId, 'old-marker-session')
    assert.equal(item.effectiveCwd, '/repo/old-b')
    const chunk = await service.readText({
      sessionId: item.sessionId,
      messageId: item.messageId,
      contentSha256: item.contentSha256,
      offset: 0,
      limit: 4096,
    }, new AbortController().signal)
    assert.equal(chunk.kind, 'ready', JSON.stringify(chunk))
    if (chunk.kind !== 'ready') throw new Error('expected ready')
    assert.equal(chunk.chunk, uncorrelatedText)
    const index = indexOfService(service)
    assert.equal(index.sourceProofOf('old-proof-session')?.contractVersion, HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION)
    assert.equal(index.sourceProofOf('old-marker-session')?.contractVersion, HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION)
    assert.equal(index.checkpointOf('old-marker-session')?.uncertainSources, 0, 'the authoritative rebuild clears the old marker')
    assert.equal(index.checkpointOf('old-proof-session')?.uncertainSources, 0)

    const openBeforeRestart = calls.openCalls()
    const statBeforeRestart = calls.statCalls()
    const readBeforeRestart = calls.readCalls()
    await service.dispose()
    const restartedCtx = new Context()
    service = directService(restartedCtx, { ...deps, revisionAuthority: async () => probe.authority }, profileDir)
    try {
      await waitDirectReady(service, 20_000)
      assert.equal(calls.openCalls(), openBeforeRestart, 'the second start must reuse the new proof, not reopen the source')
      assert.equal(calls.statCalls(), statBeforeRestart, 'the second start must not stat a proven source')
      assert.equal(calls.readCalls(), readBeforeRestart, 'the second start must not read a proven source')
      const restored = await service.search({ scope: 'all', query: uncorrelatedText, limit: 25 }, new AbortController().signal)
      assert.equal(restored.kind, 'ready')
      if (restored.kind !== 'ready') throw new Error('expected ready')
      assert.equal(restored.items.length, 1, 'the proven projection keeps the restored no-rpcId occurrence')
      // The stable periodic round keeps the same no-read fast path.
      await verifyFullPass(service)
      assert.equal(calls.openCalls(), openBeforeRestart, 'a stable periodic round must not replay a proven source')
      assert.equal(calls.statCalls(), statBeforeRestart)
      assert.equal(calls.readCalls(), readBeforeRestart)
    } finally {
      await service.dispose()
      await restartedCtx.fiber.dispose()
    }
  } finally {
    release()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an early hit cannot publish ready while a later Session official read is still latched', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-latch-root-')
  const profileDir = life.tempDir('dsh-history-proof-latch-profile-')
  // The recent-first cold order must visit the hit source before the latched
  // replay source; creation time is the deterministic scheduling fact here.
  const hitSource = proofSource(root, {
    header: testHeader('proof-session', '/repo/proof', { createdAt: 1_721_232_000_010 }),
  })
  const replaySource = proofSource(root, { header: testHeader('late-session', '/repo/late') })
  const probe = proofAuthority(root)
  const hitRows: readonly HistoryOccurrenceInput[] = [
    { messageId: 'msg-1', firstEventSeq: 0, acceptedAt: 1000, effectiveCwd: '/repo/proof', content: 'mutable first', hasNonText: false },
    { messageId: 'msg-2', firstEventSeq: 2, acceptedAt: 1002, effectiveCwd: '/repo/proof-two', content: 'mutable second', hasNonText: false },
  ]
  const lateRows: readonly HistoryOccurrenceInput[] = [
    { messageId: 'msg-1', firstEventSeq: 0, acceptedAt: 1000, effectiveCwd: '/repo/late', content: 'mutable first', hasNonText: false },
    { messageId: 'msg-2', firstEventSeq: 2, acceptedAt: 1002, effectiveCwd: '/repo/late-two', content: 'mutable second', hasNonText: false },
  ]
  seedColdProof(profileDir, hitSource, probe.authority, { occurrences: hitRows })
  // A clean committed row from the previous incarnation exists for the
  // latched source too; it must stay unreadable until this round's terminal.
  seedColdProof(profileDir, replaySource, probe.authority, { mint: false, occurrences: lateRows })
  const { deps, calls } = mutableDeps(hitSource, [replaySource])
  const basePersistence = deps.sessionPersistence()!
  let latched = false
  let release = (): void => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const gated: HistorySearchPersistenceLike = {
    identity: basePersistence.identity,
    list: options => basePersistence.list(options),
    stat: (id, options) => basePersistence.stat(id, options),
    open: async (id, access, options) => {
      if (String(id) === 'late-session') {
        latched = true
        await gate
      }
      return basePersistence.open(id, access, options)
    },
  }
  const ctx = new Context()
  const service = directService(ctx, { ...deps, sessionPersistence: () => gated, revisionAuthority: async () => probe.authority }, profileDir)
  try {
    const deadline = Date.now() + 15_000
    while (!latched && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(latched, true, 'the later Session read must be latched')
    const early = await service.search({ scope: 'all', query: 'mutable', limit: 25 }, new AbortController().signal)
    assert.equal(early.kind, 'partial', `an early hit must not publish ready: ${JSON.stringify(early)}`)
    if (early.kind !== 'partial') throw new Error('expected partial')
    assert.deepEqual(early.progress, { settled: 1, total: 2 })
    assert.deepEqual(early.items.map(item => item.sessionId), ['proof-session', 'proof-session'])
    assert.equal(early.items.length, 2, 'only the proved terminal ID contributes rows')
    // Exact text is served from the same permit.
    const exact = await service.readText({
      sessionId: early.items[0]!.sessionId,
      messageId: early.items[0]!.messageId,
      contentSha256: early.items[0]!.contentSha256,
      offset: 0,
      limit: 4096,
    }, new AbortController().signal)
    assert.equal(exact.kind, 'ready')
    // The latched, previously clean row is NOT readable before its terminal.
    const lateBefore = await service.readText({
      sessionId: 'late-session',
      messageId: 'msg-1',
      contentSha256: sha256('mutable first'),
      offset: 0,
      limit: 4096,
    }, new AbortController().signal)
    assert.equal(lateBefore.kind, 'loading')
    // The session-recall read follows the SAME per-ID permit: the proved ID is
    // readable before global ready, the latched/unverified ID is not an empty.
    const earlyRecall = await service.readSessionRecall({ sessionId: 'proof-session' }, new AbortController().signal)
    assert.equal(earlyRecall.kind, 'ready', JSON.stringify(earlyRecall))
    if (earlyRecall.kind !== 'ready') throw new Error('expected ready recall')
    assert.deepEqual(earlyRecall.items.map(item => [item.messageId, item.text]), [
      ['msg-2', 'mutable second'],
      ['msg-1', 'mutable first'],
    ])
    const lateRecallBefore = await service.readSessionRecall({ sessionId: 'late-session' }, new AbortController().signal)
    assert.deepEqual(lateRecallBefore, { kind: 'loading' }, 'an unverified target is never an authoritative empty recall')
    const absentRecallBefore = await service.readSessionRecall({ sessionId: 'not-a-session' }, new AbortController().signal)
    assert.deepEqual(absentRecallBefore, { kind: 'loading' })
    // A cursor can never continue a partial page.
    const stale = await service.search({
      scope: 'all', query: '', limit: 1, cursor: 'not-a-real-cursor',
    }, new AbortController().signal)
    assert.deepEqual(stale, { kind: 'stale', reason: 'cursor-stale' })
    // A committed dirty row drops out of the same progress/permit set.
    indexOfService(service).markSession({ sessionId: 'proof-session', dirty: true })
    const dirty = await service.search({ scope: 'all', query: 'mutable', limit: 25 }, new AbortController().signal)
    assert.equal(dirty.kind, 'loading')
    indexOfService(service).markSession({ sessionId: 'proof-session', dirty: false })
    assert.equal(calls.openCalls(), 0, 'the latched read must be the only open and it has not started')
    release()
    await waitDirectReady(service)
    assert.equal(calls.openCalls(), 1)
    const late = await service.search({ scope: 'session', sessionId: 'late-session', query: 'mutable', limit: 10 }, new AbortController().signal)
    assert.equal(late.kind, 'ready')
    assert.ok(late.kind === 'ready' && late.items.length === 2)
    const lateRecall = await service.readSessionRecall({ sessionId: 'late-session' }, new AbortController().signal)
    assert.equal(lateRecall.kind, 'ready', JSON.stringify(lateRecall))
    if (lateRecall.kind !== 'ready') throw new Error('expected ready recall')
    assert.equal(lateRecall.items.length, 2)
    // A target with no verified checkpoint is NEVER a ready empty, even under
    // the (different) ready corpus.
    const absentRecall = await service.readSessionRecall({ sessionId: 'not-a-session' }, new AbortController().signal)
    assert.deepEqual(absentRecall, { kind: 'loading' })
  } finally {
    release()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})


test('a real source-read failure during the first cold round stops partial publication', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-fault-root-')
  const profileDir = life.tempDir('dsh-history-fault-profile-')
  const hitSource = proofSource(root, {
    header: testHeader('proof-session', '/repo/proof', { createdAt: 1_721_232_000_010 }),
  })
  const brokenSource = proofSource(root, {
    header: testHeader('broken-session', '/repo/broken'),
    location: { kind: 'jsonl', path: join(root, 'sessions', 'broken-session.jsonl.zstd') },
    revisionToken: 'rev-broken',
  })
  const probe = proofAuthority(root)
  seedColdProof(profileDir, hitSource, probe.authority, {
    occurrences: [
      { messageId: 'msg-1', firstEventSeq: 0, acceptedAt: 1000, effectiveCwd: '/repo/proof', content: 'mutable first', hasNonText: false },
      { messageId: 'msg-2', firstEventSeq: 2, acceptedAt: 1002, effectiveCwd: '/repo/proof-two', content: 'mutable second', hasNonText: false },
    ],
  })
  const { deps } = mutableDeps(hitSource, [brokenSource])
  const base = deps.sessionPersistence()!
  let latched = false
  let release = (): void => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const gated: HistorySearchPersistenceLike = {
    identity: base.identity,
    list: options => base.list(options),
    stat: (id, options) => base.stat(id, options),
    open: async (id, access, options) => {
      if (String(id) === 'broken-session') {
        latched = true
        await gate
        throw new Error('the official source could not be read')
      }
      return base.open(id, access, options)
    },
  }
  const ctx = new Context()
  const service = directService(ctx, {
    ...deps,
    sessionPersistence: () => gated,
    revisionAuthority: async () => probe.authority,
  }, profileDir)
  try {
    const deadline = Date.now() + 15_000
    while (!latched && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(latched, true)
    const partial = await service.search({ scope: 'all', query: 'mutable', limit: 25 }, new AbortController().signal)
    assert.equal(partial.kind, 'partial', 'a healthy ID can be partial before the fault is observed')
    if (partial.kind !== 'partial') throw new Error('expected partial')
    assert.equal(partial.progress.settled, 1)
    release()
    const started = Date.now()
    let answer: HistorySearchResponse | undefined
    while (Date.now() - started < 15_000) {
      answer = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
      if (answer.kind === 'incomplete') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(answer?.kind, 'incomplete', JSON.stringify(answer))
    if (answer?.kind === 'incomplete') assert.equal(answer.reason, 'source-read-failed')
    const after = await service.search({ scope: 'all', query: 'mutable', limit: 25 }, new AbortController().signal)
    assert.equal(after.kind, 'incomplete', 'a real source failure must not keep publishing a partial page')
    if (after.kind === 'incomplete') assert.equal(after.reason, 'source-read-failed')
    const body = await service.readText({
      sessionId: 'proof-session',
      messageId: 'msg-1',
      contentSha256: sha256('mutable first'),
      offset: 0,
      limit: 4096,
    }, new AbortController().signal)
    assert.equal(body.kind, 'incomplete')
  } finally {
    release()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a complete qualified cold replay mints the durable proof and a restarted service reuses it', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-mint-root-')
  const profileDir = life.tempDir('dsh-history-proof-mint-profile-')
  const source = proofSource(root)
  const probe = proofAuthority(root)
  const { deps, calls } = mutableDeps(source)
  const ctx = new Context()
  let service = directService(ctx, { ...deps, revisionAuthority: async () => probe.authority }, profileDir)
  try {
    await waitDirectReady(service)
    const index = indexOfService(service)
    const checkpoint = index.checkpointOf('proof-session')
    assert.ok(checkpoint !== undefined)
    const proof = index.sourceProofOf('proof-session')
    assert.ok(proof !== undefined, 'a complete qualified cold replay must mint its proof')
    assert.equal(proof.checkpointHash, historyCheckpointHash(checkpoint))
    assert.equal(proof.sourceRevision, 'rev-1')
    assert.equal(proof.contractVersion, HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION)
    assert.ok(calls.openCalls() > 0 && calls.readCalls() > 0)
    const openBefore = calls.openCalls()
    const statBefore = calls.statCalls()
    const readBefore = calls.readCalls()
    await service.dispose()
    // A second service in the SAME process (the test's structural stand-in for
    // a Host restart) must reuse the committed proof with zero official reads.
    const restartedCtx = new Context()
    try {
      service = directService(restartedCtx, { ...deps, revisionAuthority: async () => probe.authority }, profileDir)
      await waitDirectReady(service)
    assert.equal(calls.openCalls(), openBefore, 'the recovery pass must not open a proven cold source')
    assert.equal(calls.statCalls(), statBefore, 'the recovery pass must not stat a proven cold source')
    assert.equal(calls.readCalls(), readBefore, 'the recovery pass must not read a proven cold source')
    const answer = await service.search(
      { scope: 'session', sessionId: 'proof-session', query: 'mutable', limit: 10 },
      new AbortController().signal,
    )
    assert.equal(answer.kind, 'ready')
      assert.ok(answer.kind === 'ready' && answer.items.length >= 2, 'the reused projection must answer the exact accepted rows')
    } finally {
      await service.dispose()
      await restartedCtx.fiber.dispose()
    }
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an empty header-only cold source mints a seq0 proof that a restarted service reuses', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-empty-root-')
  const profileDir = life.tempDir('dsh-history-proof-empty-profile-')
  const source = proofSource(root, { events: [] })
  const probe = proofAuthority(root)
  const { deps, calls } = mutableDeps(source)
  const ctx = new Context()
  let service = directService(ctx, { ...deps, revisionAuthority: async () => probe.authority }, profileDir)
  try {
    await waitDirectReady(service)
    const checkpoint = indexOfService(service).checkpointOf('proof-session')
    assert.ok(checkpoint !== undefined)
    assert.equal(checkpoint.nextSeq, 0)
    assert.equal(checkpoint.lastEventHash, null)
    assert.ok(indexOfService(service).sourceProofOf('proof-session') !== undefined)
    const openBefore = calls.openCalls()
    const statBefore = calls.statCalls()
    await service.dispose()
    const restartedCtx = new Context()
    try {
      service = directService(restartedCtx, { ...deps, revisionAuthority: async () => probe.authority }, profileDir)
      await waitDirectReady(service)
      assert.equal(calls.openCalls(), openBefore)
      assert.equal(calls.statCalls(), statBefore)
    } finally {
      await service.dispose()
      await restartedCtx.fiber.dispose()
    }
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('an ordinary incremental replay revokes the old proof and never mints, while failed final proofs mint nothing', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-increment-root-')
  const profileDir = life.tempDir('dsh-history-proof-increment-profile-')
  const source = proofSource(root)
  const probe = proofAuthority(root)
  const { deps, calls } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, { ...deps, revisionAuthority: async () => probe.authority }, profileDir)
  try {
    await waitDirectReady(service)
    assert.ok(indexOfService(service).sourceProofOf('proof-session') !== undefined)
    // An ordinary append with an unchanged opaque revision is the ordinary
    // incremental path, not a full cold replay: it must never mint.
    source.events.push({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 1003,
      data: {
        target: 'next-turn',
        start: 2,
        inserted: [{ id: 'msg-3', role: 'user', content: [{ type: 'text', text: 'mutable third' }], source: { kind: 'user', rpcId: 'rpc-3' } }],
      },
    })
    const openBefore = calls.openCalls()
    await verifyFullPass(service)
    assert.equal(calls.openCalls(), openBefore + 1, 'the ordinary incremental path reads the official tail')
    assert.equal(indexOfService(service).sourceProofOf('proof-session'), undefined,
      'an incremental replay must revoke the old proof and must not mint a new one')
    await waitDirectReady(service)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }

  // A final currentness mismatch, a read failure and a close failure each keep
  // the index incomplete and mint no proof.
  const failures: Array<{ readonly label: string; readonly wrap: (base: HistorySearchPersistenceLike) => HistorySearchPersistenceLike }> = [
    {
      label: 'a changed final revision',
      wrap: base => {
        let statCalls = 0
        return {
          identity: base.identity,
          list: options => base.list(options),
          open: (id, access, options) => base.open(id, access, options),
          stat: async (id, options) => {
            statCalls += 1
            const snapshot = await base.stat(id, options)
            return statCalls === 1 && snapshot !== undefined ? { ...snapshot, revision: 'changed' } : snapshot
          },
        }
      },
    },
    {
      label: 'an official read failure',
      wrap: base => ({
        identity: base.identity,
        list: options => base.list(options),
        stat: (id, options) => base.stat(id, options),
        open: async (id, access, options) => {
          const handle = await base.open(id, access, options)
          return {
            header: handle.header,
            inheritedEventCount: handle.inheritedEventCount,
            read: async () => { throw new Error('official read failure') },
            close: () => handle.close(),
          }
        },
      }),
    },
    {
      label: 'an official close failure',
      wrap: base => ({
        identity: base.identity,
        list: options => base.list(options),
        stat: (id, options) => base.stat(id, options),
        open: async (id, access, options) => {
          const handle = await base.open(id, access, options)
          return {
            header: handle.header,
            inheritedEventCount: handle.inheritedEventCount,
            read: (offset, length, readOptions) => handle.read(offset, length, readOptions),
            close: async () => { throw new Error('official close failure') },
          }
        },
      }),
    },
  ]
  for (const failure of failures) {
    const caseRoot = life.tempDir('dsh-history-proof-failure-root-')
    const caseProfile = life.tempDir('dsh-history-proof-failure-profile-')
    const caseSource = proofSource(caseRoot)
    const caseProbe = proofAuthority(caseRoot)
    const caseDeps = mutableDeps(caseSource)
    const persistence = failure.wrap(caseDeps.deps.sessionPersistence()!)
    const caseCtx = new Context()
    const caseService = directService(caseCtx, {
      ...caseDeps.deps,
      sessionPersistence: () => persistence,
      revisionAuthority: async () => caseProbe.authority,
    }, caseProfile)
    try {
      const deadline = Date.now() + 15_000
      for (;;) {
        const answer = await caseService.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
        if (answer.kind === 'incomplete') break
        if (answer.kind === 'unavailable') break
        if (Date.now() > deadline) throw new Error(`${failure.label}: unexpected settled state ${JSON.stringify(answer)}`)
        assert.equal(answer.kind, 'loading')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const index = indexOfService(caseService)
      assert.equal(index.sourceProofOf('proof-session'), undefined, `${failure.label} must mint no proof`)
    } finally {
      await caseService.dispose()
      await caseCtx.fiber.dispose()
    }
  }
})

test('a replaced official persistence binding downgrades ready and the next full pass rebuilds', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-replace-root-')
  const profileDir = life.tempDir('dsh-history-proof-replace-profile-')
  const source = proofSource(root)
  const probe = proofAuthority(root)
  seedColdProof(profileDir, source, probe.authority)
  const { deps, calls } = mutableDeps(source)
  const first = deps.sessionPersistence()!
  const second: HistorySearchPersistenceLike = {
    identity: Symbol('replaced-persistence'),
    list: options => first.list(options),
    stat: (id, options) => first.stat(id, options),
    open: (id, access, options) => first.open(id, access, options),
  }
  let current = first
  const ctx = new Context()
  const service = directService(ctx, {
    ...deps,
    sessionPersistence: () => current,
    revisionAuthority: async () => probe.authority,
  }, profileDir)
  try {
    await waitDirectReady(service)
    current = second
    const downgraded = await service.search({ scope: 'all', query: '', limit: 1 }, new AbortController().signal)
    assert.equal(downgraded.kind, 'incomplete', `a replaced binding must not keep publishing ready: ${JSON.stringify(downgraded)}`)
    const openBefore = calls.openCalls()
    await verifyFullPass(service)
    assert.ok(calls.openCalls() > openBefore, 'the next full pass must rebuild from the replacement binding')
    await waitDirectReady(service)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a real accepted event during a held cold-proof hit refuses the hit and preserves the accepted input', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-proof-live-root-')
  const profileDir = life.tempDir('dsh-history-proof-live-profile-')
  const logDir = life.tempDir('dsh-history-proof-live-log-')
  const source = proofSource(root)
  const probe = proofAuthority(root)
  seedColdProof(profileDir, source, probe.authority)
  const { deps, calls } = mutableDeps(source)
  const liveObject = { id: source.header.id, header: source.header }
  let live = false
  // Before the accepted event the official registry is cold (the proof is
  // eligible); the created/event listeners below make it live in the same
  // stack, exactly like a real Session replacement.
  const sessions: HistorySearchSessionsLike = {
    list: () => (live ? [liveObject] : []),
    get: () => (live ? liveObject : undefined),
  }
  const acceptedEvent = {
    type: 'agent/inbox/spliced',
    seq: 3,
    time: 1003,
    data: {
      target: 'next-turn',
      start: 2,
      inserted: [{
        id: 'msg-live-3',
        role: 'user',
        content: [{ type: 'text', text: 'mutable live third' }],
        source: { kind: 'user', rpcId: 'rpc-live-3' },
      }],
    },
  }
  const previousLog = process.env.DSH_PI_TUI_LOG
  const previousLevel = process.env.DSH_PI_TUI_LOG_LEVEL
  const logPath = join(logDir, 'bootstrap.log')
  process.env.DSH_PI_TUI_LOG = logPath
  process.env.DSH_PI_TUI_LOG_LEVEL = 'debug'
  const ctx = new Context()
  const service = directService(ctx, {
    ...deps,
    sessions: () => sessions,
    revisionAuthority: async () => probe.authority,
  }, profileDir)
  const internals = service as unknown as {
    enqueueWrite(task: () => void | Promise<void>): Promise<unknown>
    commitWitness(witness: unknown, action: () => void): Promise<string>
    pointCounters: { replayAttempted: number }
    pending: Map<string, unknown>
  }
  let releaseHold!: () => void
  const holdGate = new Promise<void>(resolve => { releaseHold = resolve })
  const hold = internals.enqueueWrite(async () => { await holdGate })
  let admitted!: () => void
  const hitAdmitted = new Promise<void>(resolve => { admitted = resolve })
  const originalCommitWitness = internals.commitWitness
  internals.commitWitness = function observedCommitWitness(witness, action) {
    admitted()
    return originalCommitWitness.call(service, witness, action)
  }
  try {
    await Promise.race([
      hitAdmitted,
      new Promise<never>((_resolve, reject) => {
        // Bounded failure deadline only: the real hit signal is the authoritative wake-up.
        setTimeout(() => reject(new Error('the cold proof hit never reached its writer callback')), 10_000).unref()
      }),
    ])
    // The writer is held BEFORE the admitted hit's transaction. The visible
    // epoch must not publish the previous source generation while that source
    // work is unsettled. (Do not call Owner search here: its awaitWrites would
    // correctly wait for this held writer.)
    assert.equal((service as unknown as { state: { kind: string } }).state.kind, 'loading')

    // A REAL official session/created + accepted session/event arrives while
    // the hit is queued behind the writer hold. This is the production listener
    // path, not a precomputed decision: it invalidates the admitted candidate
    // and buffers the accepted payload in the same synchronous stack.
    live = true
    source.events.push(acceptedEvent)
    ctx.emit('session/created', liveObject as never)
    ctx.emit('session/event', liveObject as never, acceptedEvent as never)
    releaseHold()
    await hold
    await waitDirectReady(service)

    assert.equal(calls.openCalls(), 0, 'the refused hit must not open a persisted handle')
    assert.ok(calls.observeCalls() > 0, 'the live repair must own the authoritative observation')
    assert.equal(internals.pointCounters.replayAttempted, 1, 'exactly one live repair replay must settle the ID')
    assert.equal(indexOfService(service).occurrence('proof-session', 'msg-live-3')?.content, 'mutable live third',
      'the accepted event must survive the refused hit through the ordinary/live repair path')
    assert.equal(internals.pending.size, 0, 'the final drain must not leave an accepted payload behind')
    const answer = await service.search(
      { scope: 'session', sessionId: 'proof-session', query: 'mutable', limit: 10 },
      new AbortController().signal,
    )
    assert.equal(answer.kind, 'ready')
    assert.ok(answer.kind === 'ready' && answer.items.length === 3,
      'the repaired projection must contain the exact accepted rows')
    const fields = diagnosticFields(readFileSync(logPath, 'utf8'), 'history-search.bootstrap.end')
    assert.equal(fields.sourceProofHit, '0', 'a refused hit must never be counted as a hit')
    assert.ok(Number(fields.sourceProofStale) >= 1, 'the refused admission must be reported as stale')
  } finally {
    releaseHold()
    await hold.catch(() => {})
    process.env.DSH_PI_TUI_LOG = previousLog
    process.env.DSH_PI_TUI_LOG_LEVEL = previousLevel
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a source replacement during the OLD Owner writer wait cannot answer from the previous epoch', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-query-replace-')
  const source = mutableSource('/repo/query-replace')
  const { deps } = mutableDeps(source)
  const first = deps.sessionPersistence()!
  const second: HistorySearchPersistenceLike = {
    identity: Symbol('query-replace-second'),
    list: options => first.list(options),
    stat: (id, options) => first.stat(id, options),
    open: (id, access, options) => first.open(id, access, options),
  }
  const third: HistorySearchPersistenceLike = {
    identity: Symbol('query-replace-third'),
    list: options => first.list(options),
    stat: (id, options) => first.stat(id, options),
    open: (id, access, options) => first.open(id, access, options),
  }
  let current = first
  const ctx1 = new Context()
  const searchService = directService(ctx1, {
    ...deps,
    sessionPersistence: () => current,
  }, profileDir)
  const searchInternals = searchService as unknown as {
    awaitWrites(signal: AbortSignal): Promise<void>
  }
  const originalSearchAwait = searchInternals.awaitWrites
  try {
    await waitDirectReady(searchService)
    let replaced = false
    // The replacement lands while the Owner SEARCH is inside its writer wait,
    // AFTER admission and BEFORE the state answer.
    searchInternals.awaitWrites = async (signal: AbortSignal) => {
      await originalSearchAwait.call(searchService, signal)
      if (!replaced) {
        replaced = true
        current = second
      }
    }
    const search = await searchService.search({ scope: 'all', query: 'mutable', limit: 5 }, new AbortController().signal)
    assert.equal(search.kind, 'incomplete', JSON.stringify(search))
  } finally {
    searchInternals.awaitWrites = originalSearchAwait
    await searchService.dispose()
    await ctx1.fiber.dispose()
  }

  // Fresh ready state for readText's own post-await replacement boundary.
  current = second
  const ctx2 = new Context()
  const readService = directService(ctx2, {
    ...deps,
    sessionPersistence: () => current,
  }, profileDir)
  const readInternals = readService as unknown as {
    awaitWrites(signal: AbortSignal): Promise<void>
  }
  const originalReadAwait = readInternals.awaitWrites
  try {
    await waitDirectReady(readService)
    const ready = await readService.search({
      scope: 'session', sessionId: 'mutable-session', query: 'mutable first', limit: 5,
    }, new AbortController().signal)
    assert.equal(ready.kind, 'ready')
    if (ready.kind !== 'ready') throw new Error('expected ready')
    const item = ready.items[0]!
    let replaced = false
    readInternals.awaitWrites = async (signal: AbortSignal) => {
      await originalReadAwait.call(readService, signal)
      if (!replaced) {
        replaced = true
        current = third
      }
    }
    const read = await readService.readText({
      sessionId: item.sessionId,
      messageId: item.messageId,
      contentSha256: item.contentSha256,
      offset: 0,
      limit: 16,
    }, new AbortController().signal)
    assert.notEqual(read.kind, 'ready', JSON.stringify(read))
    assert.equal(read.kind, 'incomplete', JSON.stringify(read))
  } finally {
    readInternals.awaitWrites = originalReadAwait
    await readService.dispose()
    await ctx2.fiber.dispose()
  }
})

test('a temporary missing-service gap preserves accepted input and recovers through one full official pass', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-service-gap-root-')
  const profileDir = life.tempDir('dsh-history-service-gap-profile-')
  const source = proofSource(root)
  const probe = proofAuthority(root)
  seedColdProof(profileDir, source, probe.authority)
  const { deps, calls } = mutableDeps(source)
  const firstPersistence = deps.sessionPersistence()!
  const firstSessions = deps.sessions()!
  const firstQuery = deps.sessionQuery()!
  const replacementPersistence: HistorySearchPersistenceLike = {
    identity: Symbol('gap-replacement-persistence'),
    list: options => firstPersistence.list(options),
    stat: (id, options) => firstPersistence.stat(id, options),
    open: (id, access, options) => firstPersistence.open(id, access, options),
  }
  let persistenceCurrent: HistorySearchPersistenceLike | undefined = firstPersistence
  let sessionsCurrent: HistorySearchSessionsLike | undefined = firstSessions
  let queryCurrent: HistorySearchQueryLike | undefined = firstQuery
  const ctx = new Context()
  const service = directService(ctx, {
    ...deps,
    sessionPersistence: () => persistenceCurrent,
    sessions: () => sessionsCurrent,
    sessionQuery: () => queryCurrent,
    revisionAuthority: async () => probe.authority,
  }, profileDir)
  try {
    await waitDirectReady(service)
    const mounted = indexOfService(service)
    persistenceCurrent = undefined
    sessionsCurrent = undefined
    queryCurrent = undefined
    await verifyFullPass(service)
    const absent = await service.search({ scope: 'all', query: 'mutable', limit: 5 }, new AbortController().signal)
    assert.equal(absent.kind, 'unavailable', JSON.stringify(absent))
    if (absent.kind === 'unavailable') {
      assert.equal(absent.reason, 'service-missing', JSON.stringify(absent))
    }

    // A real accepted event arrives while the mounted index temporarily has no
    // official source service. The listener must preserve it (bounded buffer),
    // not discard it as if the index were permanently unavailable.
    const liveSession = { id: source.header.id, header: source.header }
    const acceptedEvent = {
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 1003,
      data: {
        target: 'next-turn',
        start: 2,
        inserted: [{
          id: 'msg-gap-3',
          role: 'user',
          content: [{ type: 'text', text: 'mutable gap third' }],
          source: { kind: 'user', rpcId: 'rpc-gap-3' },
        }],
      },
    }
    source.events.push(acceptedEvent)
    ctx.emit('session/created', liveSession as never)
    ctx.emit('session/event', liveSession as never, acceptedEvent as never)
    assert.equal((service as unknown as { pending: Map<string, unknown> }).pending.size, 1,
      'the recoverable gap must buffer the accepted event')
    // The bounded drain must not consume the payload while the source service
    // is absent; retaining it is the only safe responsibility.
    const drainInternals = service as unknown as {
      enqueueDrain(): void
      drainPendingStep(): void
      pending: Map<string, unknown>
    }
    drainInternals.enqueueDrain()
    drainInternals.drainPendingStep()
    await Promise.resolve()
    assert.equal(drainInternals.pending.size, 1,
      'a missing source must not consume the accepted payload')

    // The replacement official binding becomes available again on the SAME
    // mounted index. The OWNER read must observe presence first (search-first
    // recovery), downgrade to incomplete/unproven and never reuse the prior
    // proof; only the next full pass may prove coverage.
    persistenceCurrent = replacementPersistence
    sessionsCurrent = firstSessions
    queryCurrent = firstQuery
    const beforePass = await service.search({ scope: 'all', query: 'mutable', limit: 5 }, new AbortController().signal)
    assert.equal(beforePass.kind, 'incomplete', JSON.stringify(beforePass))
    const openBefore = calls.openCalls()
    await verifyFullPass(service)
    await waitDirectReady(service)
    assert.equal(indexOfService(service), mounted, 'the mounted index must not be reopened')
    assert.ok(calls.openCalls() > openBefore, 'the recovered pass must replay officially instead of reusing the prior proof')
    const recovered = await service.search(
      { scope: 'session', sessionId: 'proof-session', query: 'mutable', limit: 10 },
      new AbortController().signal,
    )
    assert.equal(recovered.kind, 'ready')
    assert.ok(recovered.kind === 'ready' && recovered.items.some(item => item.preview === 'mutable gap third'),
      'the accepted event must survive the temporary service gap')
    const internals = service as unknown as { priorProofReuseAllowed: boolean; pending: Map<string, unknown> }
    assert.equal(internals.priorProofReuseAllowed, false, 'proof reuse must stay retired for this Host lifetime')
    assert.equal(internals.pending.size, 0)

    // Query-only absence: the persisted/session services are unchanged, but a
    // required read service is gone. The mounted epoch must become unavailable
    // and must not answer from the old ready index.
    queryCurrent = undefined
    const queryGap = await service.search({ scope: 'all', query: 'mutable', limit: 5 }, new AbortController().signal)
    assert.equal(queryGap.kind, 'unavailable', JSON.stringify(queryGap))
    if (queryGap.kind === 'unavailable') assert.equal(queryGap.reason, 'service-missing')
    queryCurrent = firstQuery
    await verifyFullPass(service)
    await waitDirectReady(service)
    const afterQueryGap = await service.search(
      { scope: 'session', sessionId: 'proof-session', query: 'mutable gap third', limit: 5 },
      new AbortController().signal,
    )
    assert.equal(afterQueryGap.kind, 'ready')

    // Query-only disappearance DURING an awaited full pass: the round must not
    // publish ready from its already-captured query object.
    const originalList = replacementPersistence.list
    let releaseList: () => void = () => {}
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    let listStarted: () => void = () => {}
    const listStartedSignal = new Promise<void>(resolve => { listStarted = resolve })
    replacementPersistence.list = async (options) => {
      listStarted()
      await listGate
      return originalList(options)
    }
    const duringPass = (service as unknown as { verifySources(): Promise<void> }).verifySources()
    await listStartedSignal
    queryCurrent = undefined
    releaseList()
    await duringPass
    const midPassGap = await service.search({ scope: 'all', query: 'mutable', limit: 5 }, new AbortController().signal)
    assert.equal(midPassGap.kind, 'unavailable', JSON.stringify(midPassGap))
    if (midPassGap.kind === 'unavailable') assert.equal(midPassGap.reason, 'service-missing')
    replacementPersistence.list = originalList
    queryCurrent = firstQuery
    await verifyFullPass(service)
    await waitDirectReady(service)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a pending accepted event on an unchanged live Session never manufactures a reconcile repair', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-pending-only-')
  const early = mutableSource('/repo/early', 'early-live')
  early.live = true
  const late = mutableSource('/repo/late', 'late-cold')
  const { deps, calls } = mutableDeps(early, [late])
  const basePersistence = deps.sessionPersistence()!
  let latched: () => void = () => {}
  const latchedSignal = new Promise<void>(resolve => { latched = resolve })
  let release = (): void => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const gated: HistorySearchPersistenceLike = {
    identity: basePersistence.identity,
    list: options => basePersistence.list(options),
    stat: (id, options) => basePersistence.stat(id, options),
    open: async (id, access, options) => {
      if (String(id) === 'late-cold') {
        latched()
        await gate
      }
      return basePersistence.open(id, access, options)
    },
  }
  const ctx = new Context()
  const service = directService(ctx, { ...deps, sessionPersistence: () => gated }, profileDir)
  try {
    await latchedSignal
    const earlyLive = deps.sessions().get('early-live')
    assert.ok(earlyLive !== undefined)
    const acceptedEvent = {
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 1003,
      data: {
        target: 'next-turn',
        start: 2,
        inserted: [{
          id: 'early-live-3',
          role: 'user',
          content: [{ type: 'text', text: 'early live third' }],
          source: { kind: 'user', rpcId: 'rpc-early-3' },
        }],
      },
    }
    early.events.push(acceptedEvent)
    // The early live source object itself is UNCHANGED; only its accepted
    // pending payload arrives while the later cold read is held.
    ctx.emit('session/event', earlyLive as never, acceptedEvent as never)
    assert.equal((service as unknown as { pending: Map<string, unknown> }).pending.size, 1)
    release()
    // No periodic verification is invoked: the final ordinary drain must settle
    // this pass without an orphan reconcile/repair obligation.
    await waitDirectReady(service)
    const internals = service as unknown as {
      reconcilePending: Set<string>
      pointCounters: { replayAttempted: number }
      pending: Map<string, unknown>
    }
    assert.equal(internals.reconcilePending.size, 0, 'pending-only payload must not create a reconcile obligation')
    assert.equal(internals.pointCounters.replayAttempted, 0, 'no point repair may be manufactured for pending-only input')
    assert.equal(internals.pending.size, 0)
    assert.equal(indexOfService(service).occurrence('early-live', 'early-live-3')?.content, 'early live third')
    assert.equal(calls.openCalls(), 1, 'only the latched cold Session is opened')
    assert.equal(calls.observeCalls(), 1, 'only the early live Session is observed once')
    const answer = await service.search(
      { scope: 'session', sessionId: 'early-live', query: 'early live', limit: 10 },
      new AbortController().signal,
    )
    assert.equal(answer.kind, 'ready')
    assert.ok(answer.kind === 'ready' && answer.items.length === 1)
  } finally {
    release()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a restored cold Session with preexisting history cannot keep the early proof hit ready', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-history-restored-root-')
  const profileDir = life.tempDir('dsh-history-restored-profile-')
  const early = proofSource(root, {
    header: testHeader('proof-session', '/repo/proof', { createdAt: 1_721_232_000_010 }),
  })
  const late = proofSource(root, {
    header: testHeader('proof-late', '/repo/late'),
    location: { kind: 'jsonl', path: join(root, 'sessions', 'proof-late.jsonl.zstd') },
    revisionToken: 'rev-late',
  })
  const probe = proofAuthority(root)
  seedColdProof(profileDir, early, probe.authority, {
    occurrences: [
      { messageId: 'msg-1', firstEventSeq: 0, acceptedAt: 1000, effectiveCwd: '/repo/proof', content: 'mutable first', hasNonText: false },
      { messageId: 'msg-2', firstEventSeq: 2, acceptedAt: 1002, effectiveCwd: '/repo/proof-two', content: 'mutable second', hasNonText: false },
    ],
  })
  const { deps, calls } = mutableDeps(early, [late])
  const basePersistence = deps.sessionPersistence()!
  const lateName = String(late.header.id)
  let latched: () => void = () => {}
  const latchedSignal = new Promise<void>(resolve => { latched = resolve })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const gated: HistorySearchPersistenceLike = {
    identity: basePersistence.identity,
    list: options => basePersistence.list(options),
    stat: (id, options) => basePersistence.stat(id, options),
    open: async (id, access, options) => {
      if (String(id) === lateName) {
        latched()
        await gate
      }
      return basePersistence.open(id, access, options)
    },
  }
  const earlyId = String(early.header.id)
  const earlyLive = { id: early.header.id, header: early.header }
  let restored = false
  const sessions: HistorySearchSessionsLike = {
    list: () => (restored ? [earlyLive] : []),
    get: id => (restored && String(id) === earlyId ? earlyLive : undefined),
  }
  const ctx = new Context()
  const service = directService(ctx, {
    ...deps,
    sessionPersistence: () => gated,
    sessions: () => sessions,
    revisionAuthority: async () => probe.authority,
  }, profileDir)
  const internals = service as unknown as {
    pointCounters: { replayAttempted: number; replayCompleted: number }
    pending: Map<string, unknown>
    reconcilePending: Set<string>
    state: { kind: string }
  }
  try {
    // The early Session is a real cold proof hit; the later official read is
    // held so the restored registration can land after the hit but before the
    // round's final identity audit.
    await latchedSignal
    // The proof hit settles before the latched official read: the healthy first
    // round offers its exact rows while the second ID is still unproved.
    const partial = await service.search({ scope: 'all', query: 'mutable', limit: 25 }, new AbortController().signal)
    assert.equal(partial.kind, 'partial', JSON.stringify(partial))
    if (partial.kind !== 'partial') throw new Error('expected partial')
    assert.deepEqual(partial.progress, { settled: 1, total: 2 })
    assert.deepEqual(partial.items.map(item => item.messageId), ['msg-2', 'msg-1'])
    const acceptedThird = {
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 1003,
      data: {
        target: 'next-turn',
        start: 2,
        inserted: [{
          id: 'restored-third',
          role: 'user',
          content: [{ type: 'text', text: 'restored preexisting third' }],
          source: { kind: 'user', rpcId: 'rpc-restored-third' },
        }],
      },
    }
    early.events.push(acceptedThird)
    restored = true
    ctx.emit('session/created', earlyLive as never)
    assert.notEqual(internals.state.kind, 'ready', 'a restored Session must not publish the old ready epoch')
    // The restored identity revokes the exact-ID permit in the same stack: the
    // formerly partial row is no longer readable/queryable until its repair.
    const hidden = await service.search({ scope: 'all', query: 'mutable', limit: 25 }, new AbortController().signal)
    assert.equal(hidden.kind, 'loading', 'a replaced/restored identity hides the old partial row')
    const hiddenRead = await service.readText({
      sessionId: earlyId, messageId: 'msg-1', contentSha256: sha256('mutable first'), offset: 0, limit: 4096,
    }, new AbortController().signal)
    assert.equal(hiddenRead.kind, 'loading')
    // Let the existing per-ID repair prove the restored identity before the
    // late read releases; it must derive the new history without an event.
    const deadline = Date.now() + 15_000
    while (internals.pointCounters.replayCompleted < 1 && Date.now() < deadline) {
      // Bounded observation of the real point-repair settlement counter.
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(internals.pointCounters.replayCompleted, 1,
      'the restored identity should be proved by exactly one per-ID repair')
    const reproved = await service.search({ scope: 'all', query: 'restored preexisting third', limit: 5 }, new AbortController().signal)
    assert.equal(reproved.kind, 'partial', 'the repaired ID re-enters the partial permit before the round completes')
    if (reproved.kind !== 'partial') throw new Error('expected partial')
    assert.deepEqual(reproved.progress, { settled: 1, total: 2 })
    assert.equal(reproved.items.length, 1)
    release()
    await waitDirectReady(service)
    const answer = await service.search(
      { scope: 'session', sessionId: earlyId, query: 'restored preexisting third', limit: 5 },
      new AbortController().signal,
    )
    assert.equal(answer.kind, 'ready')
    assert.ok(answer.kind === 'ready' && answer.items.length === 1)
    assert.equal(internals.pending.size, 0)
    assert.equal(internals.reconcilePending.size, 0)
    assert.equal(internals.pointCounters.replayAttempted, 1, 'the restored registration must not duplicate its repair')
    assert.equal(calls.openCalls(), 1, 'only the later cold source is officially opened')
  } finally {
    release()
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('a real restored cold Session opened during a proven periodic round cannot keep it ready', async (t) => {
  const wire = await historyHost(testLifecycle(t), 'history-search-r3-periodic-restore')
  const A = 'history-r3-restored-a'
  const B = 'history-r3-restored-b'
  const C = 'history-r3-pending-c'
  const cwd = wire.host.anchorDir
  const service = wire.service() as unknown as {
    enqueueWrite(task: () => void | Promise<void>): Promise<unknown>
    verifySources(): Promise<void>
    index: { checkpointOf(id: string): { sourceState: string; dirty: boolean } | undefined }
    pointCounters: { replayAttempted: number; replayCompleted: number }
    writeTail: Promise<void>
  }
  const rawPersistence = wire.host.ctx.sessionPersistence
  const rawQuery = wire.host.ctx.sessionQuery
  const originalObserve = rawQuery.observeSession
  const originalEnqueue = service.enqueueWrite
  let releaseHold: () => void = () => {}
  let releaseB: () => void = () => {}
  let releaseA: () => void = () => {}
  const holdGate = new Promise<void>(resolve => { releaseHold = resolve })
  const bGate = new Promise<void>(resolve => { releaseB = resolve })
  const aGate = new Promise<void>(resolve => { releaseA = resolve })
  let bStarted: () => void = () => {}
  let aStarted: () => void = () => {}
  const bSignal = new Promise<void>(resolve => { bStarted = resolve })
  const aSignal = new Promise<void>(resolve => { aStarted = resolve })
  let bArmed = false
  let aArmed = false
  let bObserveCalls = 0
  let aObserveCalls = 0
  const coldEvent = (id: string, seq: number, text: string) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: 1000 + seq,
    data: {
      target: 'next-turn',
      start: seq,
      inserted: [{
        id: `${id}-${String(seq)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-${id}-${String(seq)}` },
      }],
    },
  })
  const seedCold = async (id: string, texts: readonly string[]): Promise<void> => {
    const handle = await wire.host.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: Date.now(),
      cwd,
      isSeeded: false,
    })
    await handle.append(texts.map((text, seq) => coldEvent(id, seq, text)) as never)
    await handle.flush()
    await handle.close()
  }
  try {
    await seedCold(A, ['r3 alpha'])
    await seedCold(B, ['r3 beta'])
    await service.verifySources()
    const imported = await waitForSettled(wire,
      { scope: 'all', query: 'r3 ', limit: 25 }, 'r3 cold import')
    assert.equal(imported.kind, 'ready', JSON.stringify(imported))

    // A real live pending event keeps the final drain queued behind the held
    // writer; the periodic round has already listed A/B cold before the drain.
    const pendingC = await wire.host.harness.create(
      SessionId(C), { provider: 'smoke', model: 'smoke' }, { cwd })
    const hold = service.enqueueWrite(async () => { await holdGate })
    pendingC.session.append([['agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [createUserMessage({
        content: [{ type: 'text', text: 'r3 pending c' }],
        source: { kind: 'user', rpcId: 'rpc-r3-pending-c' as never },
      })],
    }]])

    let drainStarted: () => void = () => {}
    const drainSignal = new Promise<void>(resolve => { drainStarted = resolve })
    let verifyStarted = false
    service.enqueueWrite = async (task) => {
      if (verifyStarted) drainStarted()
      return originalEnqueue.call(service, task)
    }
    rawQuery.observeSession = function (id, options) {
      if (bArmed && String(id) === B) {
        bArmed = false
        bObserveCalls += 1
        bStarted()
        return bGate.then(() => originalObserve.call(this, id, options))
      }
      if (aArmed && String(id) === A) {
        aArmed = false
        aObserveCalls += 1
        aStarted()
        return aGate.then(() => originalObserve.call(this, id, options))
      }
      return originalObserve.call(this, id, options)
    }

    bArmed = true
    verifyStarted = true
    const pass = service.verifySources()
    await drainSignal
    // B is registered while the round is blocked before its final audit; the
    // audit therefore sees a real cold→live mismatch and schedules B's repair.
    const restoredB = wire.host.ctx.sessions.prepare(SessionId(B), {
      seed: [coldEvent(B, 0, 'r3 beta')] as never,
      meta: { cwd },
    })
    wire.host.ctx.sessions.enter(restoredB)
    wire.host.ctx.sessions.announce(restoredB)
    releaseHold()
    await pass
    await hold
    await bSignal

    // A is registered only after traversal/audit, while B's repair is still
    // open. The proven round's identity evidence must revoke A and schedule its
    // ONE current repair instead of becoming ready when B settles.
    aArmed = true
    const restoredA = wire.host.ctx.sessions.prepare(SessionId(A), {
      seed: [coldEvent(A, 0, 'r3 alpha'), coldEvent(A, 1, 'r3 restored row')] as never,
      meta: { cwd },
    })
    wire.host.ctx.sessions.enter(restoredA)
    wire.host.ctx.sessions.announce(restoredA)
    const aRepairObserved = await Promise.race([
      aSignal.then(() => true),
      // Bounded observation: the real repair must start while this round is open.
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000)),
    ])
    assert.equal(aRepairObserved, true, 'the restored cold identity must schedule its own authoritative repair')
    releaseB()
    const bDeadline = Date.now() + 10_000
    while (service.index.checkpointOf(B)?.sourceState !== 'persisted' && Date.now() < bDeadline) {
      // Bounded observation of B's real checkpoint settlement.
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await service.writeTail
    const during = await wire.search({
      scope: 'session', sessionId: A, query: 'r3 restored row', limit: 5,
    })
    assert.equal(during.kind, 'incomplete',
      `the open round must not publish ready while A's current identity is unproved: ${JSON.stringify(during)}`)
    releaseA()
    const after = await waitForSettled(wire,
      { scope: 'session', sessionId: A, query: 'r3 restored row', limit: 5 }, 'r3 restored row')
    assert.equal(after.kind, 'ready', JSON.stringify(after))
    if (after.kind !== 'ready') throw new Error('expected ready')
    assert.equal(after.items.length, 1, 'the restored row must be projected exactly once')
    const old = await wire.search({ scope: 'session', sessionId: A, query: 'r3 alpha', limit: 5 })
    assert.equal(old.kind, 'ready')
    assert.ok(old.kind === 'ready' && old.items.length === 1)
    assert.equal(bObserveCalls, 1, 'B must have exactly one current live observation')
    assert.equal(aObserveCalls, 1, 'A must have exactly one current live observation')
  } finally {
    releaseHold()
    releaseB()
    releaseA()
    rawQuery.observeSession = originalObserve
    service.enqueueWrite = originalEnqueue
    await wire.dispose()
  }
})

test('a real post-roster Session born during the held cold prewarm reaches ready without a periodic pass', async (t) => {
  const rosterId = 'history-post-roster-real-a'
  const bornId = 'history-post-roster-real-b'
  let latched: () => void = () => {}
  const latchedSignal = new Promise<void>(resolve => { latched = resolve })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let rawPersistence: HistorySearchPersistenceLike | undefined
  let originalOpen: HistorySearchPersistenceLike['open'] | undefined
  const wire = await historyHost(testLifecycle(t), 'history-post-roster-real', async (ctx) => {
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(rosterId),
      createdAt: Date.now(),
      cwd: '/repo/post-roster-real',
      isSeeded: false,
    })
    await handle.append([{
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 1000,
      data: {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: 'post-roster-real-a-0',
          role: 'user',
          content: [{ type: 'text', text: 'post roster roster row' }],
          source: { kind: 'user', rpcId: 'rpc-post-roster-real-a' },
        }],
      },
    }] as never)
    await handle.flush()
    await handle.close()
    const raw = ctx.sessionPersistence as unknown as HistorySearchPersistenceLike
    rawPersistence = raw
    originalOpen = raw.open
    raw.open = async function (id, access, options) {
      if (String(id) === rosterId) {
        latched()
        await gate
      }
      return originalOpen!.call(this, id, access, options)
    }
  })
  try {
    await latchedSignal
    await wire.host.harness.create(
      SessionId(bornId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    await prompt(wire, bornId, 'req-post-roster-real-b', 'post roster born row')
    release()
    const born = await waitForSettled(wire, {
      scope: 'session', sessionId: bornId, query: 'post roster born row', limit: 10,
    }, 'post-roster born readiness')
    assert.equal(born.kind, 'ready', JSON.stringify(born))
    if (born.kind !== 'ready') throw new Error('expected ready')
    assert.equal(born.items.length, 1)
    const roster = await wire.search({
      scope: 'session', sessionId: rosterId, query: 'post roster roster row', limit: 10,
    })
    assert.equal(roster.kind, 'ready')
    assert.ok(roster.kind === 'ready' && roster.items.length === 1)
  } finally {
    release()
    if (rawPersistence !== undefined && originalOpen !== undefined) rawPersistence.open = originalOpen
    await wire.dispose()
  }
})
