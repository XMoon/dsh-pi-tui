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
import { mkdirSync } from 'node:fs'
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
  events: readonly { type: string; seq: number; time: number; data: unknown }[]
  revision: number
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
      return [{ header: source.header, eventCount: source.events.length, revision: source.revision }]
    },
    async open() {
      return {
        header: source.header,
        inheritedEventCount: 0,
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          return { events: source.events.slice(offset, offset + length) }
        },
        async close() {},
      }
    },
  }
  const query: HistorySearchQueryLike = {
    async listSessions() {
      return source.present ? [{ header: source.header, live: false, persisted: true }] : []
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
