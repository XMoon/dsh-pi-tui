/**
 * FR3 — the Direct MCP server port over the official in-process manager.
 *
 * Evidence level: unit/contract (L2) with a controlled manager fixture. The
 * REAL official manager composition and its wire are qualified by the Host
 * loader probes and the split-process lane; this file pins the port semantics
 * the controller relies on: detachment, generation binding, the failure
 * taxonomy and the "restart is never claimed cancelled after dispatch" rule.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/mcp-server-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectMcpServerPort,
  type DirectMcpHostContextLike,
  type McpManagerServiceLike,
} from '../../../src/runtime/direct/mcp-server-direct.ts'
import type { McpServerWatchEvent } from '../../../src/runtime/mcp-server-port.ts'

/** A controllable in-process manager: one queued list per `push` + probe/restart hooks. */
class FakeManager implements McpManagerServiceLike {
  probes: Array<{ readonly name: string; readonly signal?: AbortSignal }> = []
  restarts: string[] = []
  probeResult: (name: string) => Promise<unknown> = async name => ({
    ok: true,
    serverInfo: { name, version: '1.0.0' },
    toolNames: ['echo'],
    truncated: false,
    durationMs: 5,
    closeConfirmed: true,
  })
  restartResult: (name: string) => Promise<unknown> = async () => undefined
  private readonly frames: unknown[][] = []
  private waiting: Array<() => void> = []
  private closed = false

  push(frame: unknown[]): void {
    this.frames.push(frame)
    const wake = this.waiting
    this.waiting = []
    for (const resolve of wake) resolve()
  }

  async *watch(signal: AbortSignal): AsyncIterable<unknown> {
    while (!signal.aborted && !this.closed) {
      if (this.frames.length === 0) {
        await new Promise<void>(resolve => {
          this.waiting.push(resolve)
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        continue
      }
      yield this.frames.shift()
    }
    if (this.closed) throw new Error('manager closed')
  }

  async probe(name: string, options?: { readonly signal?: AbortSignal }): Promise<unknown> {
    this.probes.push({ name, ...options === undefined ? {} : { signal: options.signal } })
    return await this.probeResult(name)
  }

  async restart(name: string): Promise<unknown> {
    this.restarts.push(name)
    return await this.restartResult(name)
  }
}

/** One controllable Host context: `get` reads the current manager; `on` records
 *  the `internal/service` listeners the adapter subscribes to. */
function createContext(initial?: McpManagerServiceLike): {
  readonly ctx: DirectMcpHostContextLike
  setManager(manager: McpManagerServiceLike | undefined): void
} {
  let manager: McpManagerServiceLike | undefined = initial
  const listeners = new Set<(name: string) => void>()
  return {
    ctx: {
      get: name => (name === 'mcpManager' ? manager : undefined),
      on: ((event: string, listener: (name: string) => void) => {
        if (event === 'internal/service') listeners.add(listener)
        return () => listeners.delete(listener)
      }) as unknown as DirectMcpHostContextLike['on'],
    },
    setManager(next) {
      manager = next
      for (const listener of [...listeners]) listener('mcpManager')
    },
  }
}

/** One valid official view. */
function view(name: string, status: unknown = { state: 'connected', toolCount: 1, connectedAt: 1 }): unknown {
  return { name, configured: true, status }
}

/** Read frames until `predicate` matches (bounded: a hung fixture fails loudly). */
async function nextEvent(
  iterator: AsyncIterator<McpServerWatchEvent>,
  predicate: (event: McpServerWatchEvent) => boolean = () => true,
): Promise<McpServerWatchEvent | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await iterator.next()
    if (result.done === true) return undefined
    if (predicate(result.value)) return result.value
  }
  throw new Error('the watch stream never produced the expected frame')
}

test('watch forwards the official roster as frozen detached copies', async t => {
  const manager = new FakeManager()
  const { ctx } = createContext(manager)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())

  const iterator = port.watch(controller.signal)[Symbol.asyncIterator]()
  const mutable = [{ name: 'alpha', configured: true, status: { state: 'connected', toolCount: 2, connectedAt: 7 } }]
  manager.push(mutable)
  const event = await nextEvent(iterator, candidate => candidate.kind === 'current')
  assert.ok(event !== undefined && event.kind === 'current')
  assert.equal(event.roster.servers.length, 1)
  assert.equal(event.roster.servers[0].name, 'alpha')
  assert.equal(event.roster.servers[0].configured, true)
  assert.deepEqual(event.roster.servers[0].status, { state: 'connected', toolCount: 2, connectedAt: 7 })
  // The port returned a detached copy, not the fixture's live object.
  assert.notEqual(event.roster.servers[0], mutable[0])
  assert.ok(Object.isFrozen(event.roster.servers[0]))
  assert.ok(Object.isFrozen(event.roster.servers))
  // A later mutation of the official value cannot rewrite the published frame.
  ;(mutable[0] as { name: string }).name = 'mutated'
  assert.equal(event.roster.servers[0].name, 'alpha')
})

test('an unclassifiable status refuses the whole frame instead of guessing', async t => {
  const manager = new FakeManager()
  const { ctx } = createContext(manager)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = port.watch(controller.signal)[Symbol.asyncIterator]()
  manager.push([{ name: 'alpha', configured: true, status: { state: 'future-state' } }])
  const event = await nextEvent(iterator)
  assert.deepEqual(event, { kind: 'invalidated', reason: 'watch-failed' })
})

test('a Host without the manager reports unavailable instead of an empty roster', async t => {
  const { ctx } = createContext()
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = port.watch(controller.signal)[Symbol.asyncIterator]()
  assert.deepEqual(await nextEvent(iterator), { kind: 'invalidated', reason: 'unavailable' })
  const probe = await port.probe('alpha', controller.signal)
  assert.equal(probe.kind, 'failed')
  if (probe.kind !== 'failed') return
  assert.equal(probe.failure.kind, 'unavailable')
  const restart = await port.restart('alpha', controller.signal)
  assert.equal(restart.kind, 'failed')
  if (restart.kind !== 'failed') return
  assert.equal(restart.failure.kind, 'unavailable')
})

test('probe forwards the official cancellation signal and keeps closure facts separate', async t => {
  const manager = new FakeManager()
  manager.probeResult = async () => ({
    ok: true,
    toolNames: ['echo'],
    truncated: true,
    durationMs: 12,
    closeConfirmed: false,
    cleanupError: 'close timeout',
  })
  const { ctx } = createContext()
  ;(ctx as unknown as { get(name: string): unknown }).get = name => (name === 'mcpManager' ? manager : undefined)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = await port.probe('alpha', controller.signal)
  assert.equal(outcome.kind, 'settled')
  if (outcome.kind !== 'settled') return
  assert.equal(manager.probes.length, 1)
  assert.equal(manager.probes[0].name, 'alpha')
  assert.equal(manager.probes[0].signal, controller.signal, 'the official probe receives the caller signal')
  assert.equal(outcome.value.ok, true)
  assert.equal(outcome.value.closeConfirmed, false)
  assert.equal(outcome.value.cleanupError, 'close timeout')
  assert.equal(outcome.value.truncated, true)
})

test('a documented probe refusal is rejected, never settled', async t => {
  const manager = new FakeManager()
  manager.probeResult = async () => { throw new Error('mcp-manager: unknown server "alpha"') }
  const { ctx } = createContext()
  ;(ctx as unknown as { get(name: string): unknown }).get = name => (name === 'mcpManager' ? manager : undefined)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = await port.probe('alpha', controller.signal)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
  assert.match(outcome.failure.reason, /unknown server/u)
})

test('an unreadable probe result is outcome-unconfirmed, never a success', async t => {
  const manager = new FakeManager()
  manager.probeResult = async () => ({ ok: true })
  const { ctx } = createContext()
  ;(ctx as unknown as { get(name: string): unknown }).get = name => (name === 'mcpManager' ? manager : undefined)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = await port.probe('alpha', controller.signal)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'outcome-unconfirmed')
})

test('a cancelled probe is superseded before dispatch and after dispatch', async t => {
  const manager = new FakeManager()
  const { ctx } = createContext(manager)
  const port = new DirectMcpServerPort(ctx)
  const aborted = new AbortController()
  aborted.abort()
  const before = await port.probe('alpha', aborted.signal)
  assert.equal(before.kind, 'failed')
  if (before.kind === 'failed') assert.equal(before.failure.kind, 'superseded')
  assert.equal(manager.probes.length, 0, 'a pre-dispatch cancellation sends nothing')

  const during = new AbortController()
  manager.probeResult = async () => {
    during.abort()
    return { ok: false, stage: 'connect', message: 'aborted', durationMs: 1, closeConfirmed: true }
  }
  const after = await port.probe('alpha', during.signal)
  // The official probe reported an aborted attempt: its failure is a real
  // settled outcome, and the adapter never converts it into a success.
  assert.equal(after.kind, 'settled')
  if (after.kind === 'settled') assert.equal(after.value.ok, false)
})

test('a manager replacement invalidates the stream and supersedes in-flight work', async t => {
  const first = new FakeManager()
  const { ctx, setManager } = createContext(first)
  let current: McpManagerServiceLike | undefined = first
  ;(ctx as unknown as { get(name: string): unknown }).get = name => (name === 'mcpManager' ? current : undefined)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = port.watch(controller.signal)[Symbol.asyncIterator]()
  first.push([view('alpha')])
  const frame = await nextEvent(iterator, candidate => candidate.kind === 'current')
  assert.ok(frame !== undefined && frame.kind === 'current')

  let resolveProbe!: (value: unknown) => void
  first.probeResult = async () => await new Promise(resolve => { resolveProbe = resolve })
  const pending = port.probe('alpha', controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  current = new FakeManager()
  setManager(current)
  assert.deepEqual(await nextEvent(iterator), { kind: 'invalidated', reason: 'service-changed' })
  resolveProbe({ ok: true, toolNames: [], truncated: false, durationMs: 1, closeConfirmed: true })
  const outcome = await pending
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.failure.kind, 'superseded')
})

test('restart settles once and a documented refusal is rejected', async t => {
  const manager = new FakeManager()
  const { ctx } = createContext(manager)
  const port = new DirectMcpServerPort(ctx)
  const controller = new AbortController()
  t.after(() => controller.abort())

  const settled = await port.restart('alpha', controller.signal)
  assert.equal(settled.kind, 'settled')
  assert.equal(manager.restarts.length, 1, 'exactly one official restart call')

  manager.restartResult = async () => { throw new Error('mcp-manager: cleanup for "alpha" is incomplete') }
  const refused = await port.restart('alpha', controller.signal)
  assert.equal(refused.kind, 'failed')
  if (refused.kind === 'failed') {
    assert.equal(refused.failure.kind, 'rejected')
    assert.match(refused.failure.reason, /cleanup/u)
  }
})

test('a restart cancelled before dispatch sends nothing', async () => {
  const manager = new FakeManager()
  const { ctx } = createContext(manager)
  const port = new DirectMcpServerPort(ctx)
  const aborted = new AbortController()
  aborted.abort()
  const outcome = await port.restart('alpha', aborted.signal)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.failure.kind, 'superseded')
  assert.equal(manager.restarts.length, 0)
})

test('the manager replacement during a restart supersedes its settlement', async () => {
  const first = new FakeManager()
  const { ctx, setManager } = createContext(first)
  let current: McpManagerServiceLike | undefined = first
  ;(ctx as unknown as { get(name: string): unknown }).get = name => (name === 'mcpManager' ? current : undefined)
  const port = new DirectMcpServerPort(ctx)
  let resolveRestart!: () => void
  first.restartResult = async () => await new Promise<void>(resolve => { resolveRestart = resolve })
  const pending = port.restart('alpha', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  current = new FakeManager()
  setManager(current)
  resolveRestart()
  const outcome = await pending
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.failure.kind, 'superseded')
})
