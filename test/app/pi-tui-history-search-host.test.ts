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
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import {
  PI_TUI_HISTORY_SEARCH_NAMESPACE,
  parseHistoryReadTextResponse,
  parseHistorySearchResponse,
  type HistoryReadTextRequest,
  type HistoryReadTextResponse,
  type HistorySearchRequest,
  type HistorySearchResponse,
} from '../../src/runtime/remote/pi-tui-history-search-contract.ts'
import {
  HISTORY_SEARCH_MAX_PENDING_EVENTS,
  PiTuiHistorySearchHostService,
  type HistorySearchPersistenceLike,
  type HistorySearchProfileContextLike,
  type HistorySearchQueryLike,
} from '../../src/app/host/features/history-search.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

interface HistoryHost {
  readonly host: Host
  readonly owner: PeerScope
  readonly nonOwner: PeerScope
  search(request: HistorySearchRequest, peer?: PeerScope, signal?: AbortSignal): Promise<HistorySearchResponse>
  readText(request: HistoryReadTextRequest, peer?: PeerScope, signal?: AbortSignal): Promise<HistoryReadTextResponse>
  service(): PiTuiHistorySearchHostService
  dispose(): Promise<void>
}

async function historyHost(life: TestLifecycle, presetId: string): Promise<HistoryHost> {
  const host = await createRemoteApplicationHostFixture(life, presetId, { pluginManagerProfile: true })
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const connection = host.ctx.connection
  const owner = connection.browserPeer
  const nonOwner = connection.createPeer({ principal: { kind: 'viewer' } } as never)
  const gateway = host.ctx.typertGateway
  const invoke = async (
    method: 'search' | 'readText',
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
    if (answer.kind !== 'loading') return answer
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
  await wire.host.ctx.sessionController.prompt({
    requestId: requestId as never,
    sessionId: SessionId(sessionId),
    mode: 'queue',
    content: [{ type: 'text', text }] as never,
  }, new AbortController().signal)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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
    list: async () => [],
    open: async () => { throw new Error('unused') },
  }
  const query: HistorySearchQueryLike = {
    listSessions: async () => [],
    observeSession: async () => { throw new Error('unused') },
  }
  const service = new PiTuiHistorySearchHostService(invocationCtx, {
    profileContext: () => ({ dir: missingProfile }),
    sessionPersistence: () => persistence,
    sessionQuery: () => query,
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
    list: async () => {
      await gate
      return []
    },
    open: async () => { throw new Error('unused') },
  }
  const query: HistorySearchQueryLike = {
    listSessions: async () => [],
    observeSession: async () => { throw new Error('unused') },
  }
  const service = new PiTuiHistorySearchHostService(invocationCtx, {
    profileContext: () => ({ dir: profileDir }),
    sessionPersistence: () => persistence,
    sessionQuery: () => query,
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
/**
 * A mutable structural official source for the reconcile failure classes that
 * have no public trigger besides the periodic verification pass. `verifySources`
 * is invoked directly (a test probe of the SAME production pass) so the case is
 * deterministic instead of waiting the 30 s cadence.
 */
interface MutableOfficialSource {
  present: boolean
  header: { readonly id: unknown; readonly cwd?: string }
  events: { type: string; seq: number; time: number; data: unknown }[]
  revision: number
  /** Advertised durable count when it deliberately disagrees with `events`. */
  eventCount?: number
  /** rc.5 JSONL shape: `list()` provides no eventCount at all. */
  omitEventCount?: boolean
  /** The official read is only durable through this many events. */
  durableEventCount?: number
  /** The official sessionQuery reports this Session as live. */
  live?: boolean
}

function mutableSource(headerCwd: string): MutableOfficialSource {
  const message = (text: string, index: number) => ({
    id: `msg-${String(index)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${String(index)}` },
  })
  return {
    present: true,
    header: { id: 'mutable-session', cwd: headerCwd },
    events: [
      { type: 'agent/inbox/spliced', seq: 0, time: 1000, data: { target: 'next-turn', start: 0, inserted: [message('mutable first', 1)] } },
      { type: 'working-directory/change', seq: 1, time: 1001, data: { cwd: `${headerCwd}-two` } },
      { type: 'agent/inbox/spliced', seq: 2, time: 1002, data: { target: 'next-turn', start: 1, inserted: [message('mutable second', 2)] } },
    ],
    revision: 1,
  }
}

function mutableDeps(source: MutableOfficialSource): {
  readonly deps: {
    profileContext: () => { dir: string }
    sessionPersistence: () => HistorySearchPersistenceLike
    sessionQuery: () => HistorySearchQueryLike
  }
} {
  const persistence: HistorySearchPersistenceLike = {
    identity: Symbol('mutable-persistence'),
    async list() {
      if (!source.present) return []
      return [{
        header: source.header,
        ...(source.omitEventCount === true ? {} : { eventCount: source.eventCount ?? source.events.length }),
        revision: source.revision,
      }]
    },
    async open() {
      return {
        header: source.header,
        inheritedEventCount: 0,
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          const durable = source.durableEventCount ?? source.events.length
          return { events: source.events.slice(offset, Math.min(offset + length, durable)) }
        },
        async close() {},
      }
    },
  }
  const query: HistorySearchQueryLike = {
    async listSessions() {
      return source.present ? [{ header: source.header, live: source.live === true, persisted: true }] : []
    },
    async observeSession() {
      return {
        header: source.header,
        inheritedEventCount: 0,
        events: source.events,
        [Symbol.dispose]() {},
      }
    },
  }
  return {
    deps: {
      profileContext: () => ({ dir: '' }),
      sessionPersistence: () => persistence,
      sessionQuery: () => query,
    },
  }
}

interface DirectHistoryDeps {
  profileContext: () => HistorySearchProfileContextLike | undefined
  sessionPersistence: () => HistorySearchPersistenceLike | undefined
  sessionQuery: () => HistorySearchQueryLike | undefined
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
    source.header = { id: 'mutable-session', cwd: '/repo/replaced' }
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
    header: { id: 'big-session', cwd: '/repo/big' },
    events: [],
    revision: 1,
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
  const dbPath = join(profileDir, '.dsh-pi-tui', 'history-search', 'v1.sqlite')
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
    // ready; every write it attempts hits the same private-file refusal.
    await assert.rejects(
      (service as unknown as { verifySources(): Promise<void> }).verifySources(),
      (error: unknown) => error instanceof Error && /sidecar|private/u.test(error.message),
    )
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
      if (answer.kind === 'incomplete') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(answer?.kind, 'incomplete', JSON.stringify(answer))
    assert.equal(checkpoint()?.sourceState, 'live', 'the unproven rows must never be called persisted')
    assert.equal(checkpoint()?.dirty, true, 'the prefix proof failure must be retried')
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})

test('rebuilding a Session to zero events invalidates the previous cursor', async (t) => {
  const life = testLifecycle(t)
  const profileDir = life.tempDir('dsh-history-search-empty-rebuild-')
  const source = mutableSource('/repo/empty-rebuild')
  const { deps } = mutableDeps(source)
  const ctx = new Context()
  const service = directService(ctx, deps, profileDir)
  const verify = () => (service as unknown as { verifySources(): Promise<void> }).verifySources()
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
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
})
