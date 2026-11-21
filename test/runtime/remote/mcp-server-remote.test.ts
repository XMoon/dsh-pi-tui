/**
 * FR3 — the Remote MCP server port over the official generated `mcpManager`
 * namespace.
 *
 * Evidence level: unit/contract (L2) over a structural generated face. The
 * REAL authenticated wire is qualified by `remote-client-runtime` (the mounted
 * contribution) and the split-process lane; this file pins the port's
 * generation fencing and its failure taxonomy:
 *
 * - a generation change ends the watch and supersedes in-flight work;
 * - a proven Host refusal is `rejected`; a carrier loss is never a refusal;
 * - a dispatched restart is NEVER retried, and a cancellation after dispatch
 *   is `outcome-unconfirmed`, never `superseded`/`rejected`.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/mcp-server-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteMcpServerPort,
  type RemoteMcpManagerNamespace,
  type RemoteMcpWatchHandle,
} from '../../../src/runtime/remote/mcp-server-remote.ts'
import type { McpServerWatchEvent } from '../../../src/runtime/mcp-server-port.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../../../src/runtime/remote/session-reader-remote.ts'

/** A controllable Connection generation store (the official shape). */
class FakeGeneration implements RemoteConnectionGenerationSource {
  private current: RemoteConnectionGeneration | undefined = { id: 1 }
  private readonly listeners = new Set<() => void>()

  getSnapshot(): RemoteConnectionGeneration | undefined {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  advance(): void {
    const previous = this.current?.id
    this.current = { id: typeof previous === 'number' ? previous + 1 : 1 }
    for (const listener of [...this.listeners]) listener()
  }

  disconnect(): void {
    this.current = undefined
    for (const listener of [...this.listeners]) listener()
  }
}

/** A controllable generated watch handle fed by the test. */
class FakeWatch implements RemoteMcpWatchHandle {
  private readonly frames: unknown[] = []
  private waiting: Array<() => void> = []
  private ended = false
  disposed = 0

  push(frame: unknown): void {
    this.frames.push(frame)
    const wake = this.waiting
    this.waiting = []
    for (const resolve of wake) resolve()
  }

  end(): void {
    this.ended = true
    const wake = this.waiting
    this.waiting = []
    for (const resolve of wake) resolve()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (true) {
      if (this.frames.length > 0) {
        yield this.frames.shift()
        continue
      }
      if (this.ended) return
      await new Promise<void>(resolve => { this.waiting.push(resolve) })
    }
  }

  dispose(): void {
    this.disposed += 1
    this.end()
  }
}

/** One canned official view. */
function view(name: string, status: unknown = { state: 'connected', toolCount: 1, connectedAt: 1 }): unknown {
  return { name, configured: true, status }
}

interface Fixture {
  readonly port: RemoteMcpServerPort
  readonly generation: FakeGeneration
  readonly watchHandle: FakeWatch
  calls: { probes: Array<{ name: string; signal?: AbortSignal }>; restarts: string[] }
  probeResult: (name: string) => Promise<unknown>
  restartResult: (name: string) => Promise<unknown>
}

function createFixture(options: { readonly missingNamespace?: boolean } = {}): Fixture {
  const generation = new FakeGeneration()
  const watchHandle = new FakeWatch()
  const fixture = {
    generation,
    watchHandle,
    calls: { probes: [] as Array<{ name: string; signal?: AbortSignal }>, restarts: [] as string[] },
    probeResult: (async (): Promise<unknown> => ({
      ok: true,
      toolNames: ['echo'],
      truncated: false,
      durationMs: 3,
      closeConfirmed: true,
    })) as (name: string) => Promise<unknown>,
    restartResult: (async (): Promise<unknown> => undefined) as (name: string) => Promise<unknown>,
  }
  const namespace: RemoteMcpManagerNamespace = {
    watch: () => watchHandle,
    probe: async (name, signal) => {
      fixture.calls.probes.push({ name, ...signal === undefined ? {} : { signal } })
      return { ok: true, value: await fixture.probeResult(name) }
    },
    restart: async name => {
      fixture.calls.restarts.push(name)
      return { ok: true, value: await fixture.restartResult(name) }
    },
  }
  fixture.probeResult = async () => ({
    ok: true,
    toolNames: ['echo'],
    truncated: false,
    durationMs: 3,
    closeConfirmed: true,
  })
  const port = new RemoteMcpServerPort({
    remote: { ...options.missingNamespace === true ? {} : { mcpManager: namespace } },
    connection: { generation },
  })
  return Object.assign(fixture, { port })
}

/** Read frames until `predicate` matches (bounded). */
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

test('watch tags every roster with the Host generation and disposes its handle', async t => {
  const fixture = createFixture()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = fixture.port.watch(controller.signal)[Symbol.asyncIterator]()
  fixture.watchHandle.push([view('alpha')])
  const frame = await nextEvent(iterator, candidate => candidate.kind === 'current')
  assert.ok(frame !== undefined && frame.kind === 'current')
  assert.equal(frame.roster.generation, fixture.generation.getSnapshot(),
    'the frame is bound to the Connection generation that produced it')
  assert.equal(frame.roster.servers[0].name, 'alpha')
  assert.equal(controller.signal.aborted, false)
  controller.abort()
  // The provider's stream ends; the port releases the official handle once.
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.equal(fixture.watchHandle.disposed, 1)
})

test('a generation change invalidates the observation and is never merged', async t => {
  const fixture = createFixture()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = fixture.port.watch(controller.signal)[Symbol.asyncIterator]()
  fixture.watchHandle.push([view('alpha')])
  await nextEvent(iterator, candidate => candidate.kind === 'current')
  fixture.generation.advance()
  assert.deepEqual(await nextEvent(iterator), { kind: 'invalidated', reason: 'connection-changed' })
  assert.equal((await iterator.next()).done, true, 'the stream ends after the invalidation frame')
  assert.equal(fixture.watchHandle.disposed, 1)
})

test('an unclassifiable wire frame is a read failure, never a partial roster', async t => {
  const fixture = createFixture()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = fixture.port.watch(controller.signal)[Symbol.asyncIterator]()
  fixture.watchHandle.push([{ name: 'alpha', configured: true, status: { state: 'connected' } }])
  assert.deepEqual(await nextEvent(iterator), { kind: 'invalidated', reason: 'watch-failed' })
})

test('a missing generated namespace is unavailable for every operation', async t => {
  const fixture = createFixture({ missingNamespace: true })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const iterator = fixture.port.watch(controller.signal)[Symbol.asyncIterator]()
  assert.deepEqual(await nextEvent(iterator), { kind: 'invalidated', reason: 'unavailable' })
  const probe = await fixture.port.probe('alpha', controller.signal)
  assert.equal(probe.kind, 'failed')
  if (probe.kind === 'failed') assert.equal(probe.failure.kind, 'unavailable')
  const restart = await fixture.port.restart('alpha', controller.signal)
  assert.equal(restart.kind, 'failed')
  if (restart.kind === 'failed') assert.equal(restart.failure.kind, 'unavailable')
})

test('a disconnected Host is unavailable before dispatch', async t => {
  const fixture = createFixture()
  fixture.generation.disconnect()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const probe = await fixture.port.probe('alpha', controller.signal)
  assert.equal(probe.kind, 'failed')
  if (probe.kind === 'failed') assert.equal(probe.failure.kind, 'unavailable')
  assert.equal(fixture.calls.probes.length, 0, 'no request is dispatched without a Host generation')
})

test('probe settles a real result and rejects a proven business refusal', async t => {
  const fixture = createFixture()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const settled = await fixture.port.probe('alpha', controller.signal)
  assert.equal(settled.kind, 'settled')
  if (settled.kind === 'settled') {
    assert.equal(settled.generation, fixture.generation.getSnapshot())
    assert.equal(settled.value.ok, true)
    if (settled.value.ok) assert.deepEqual(settled.value.toolNames, ['echo'])
  }
  assert.equal(fixture.calls.probes.length, 1)

  const namespaceRefusal = createFixture()
  namespaceRefusal.probeResult = async () => { throw { code: 'mcp/unknown-server', message: 'unknown server "beta"' } }
  const refused = await namespaceRefusal.port.probe('beta', controller.signal)
  assert.equal(refused.kind, 'failed')
  if (refused.kind === 'failed') {
    assert.equal(refused.failure.kind, 'rejected')
    assert.match(refused.failure.reason, /unknown server/u)
  }
})

test('probe classifies cancellation and an unproven carrier loss', async t => {
  const cancelled = createFixture()
  cancelled.probeResult = async () => { throw { code: 'gateway/cancelled', message: 'cancelled' } }
  const cancelledOutcome = await cancelled.port.probe('alpha', new AbortController().signal)
  assert.equal(cancelledOutcome.kind, 'failed')
  if (cancelledOutcome.kind === 'failed') assert.equal(cancelledOutcome.failure.kind, 'superseded')

  const ambiguous = createFixture()
  ambiguous.probeResult = async () => { throw { code: 'gateway/internal', message: 'broker died' } }
  const ambiguousOutcome = await ambiguous.port.probe('alpha', new AbortController().signal)
  assert.equal(ambiguousOutcome.kind, 'failed')
  if (ambiguousOutcome.kind === 'failed') assert.equal(ambiguousOutcome.failure.kind, 'outcome-unconfirmed')
})

test('a generation change during a probe supersedes the late reply', async () => {
  const fixture = createFixture()
  let resolveProbe!: (value: unknown) => void
  fixture.probeResult = async () => await new Promise(resolve => { resolveProbe = resolve })
  const pending = fixture.port.probe('alpha', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  fixture.generation.advance()
  resolveProbe({ ok: true, toolNames: [], truncated: false, durationMs: 1, closeConfirmed: true })
  const outcome = await pending
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.failure.kind, 'superseded')
})

test('a pre-dispatch restart cancellation sends nothing; a post-dispatch loss is unconfirmed and never retried', async () => {
  const aborted = new AbortController()
  aborted.abort()
  const skipped = createFixture()
  const skippedOutcome = await skipped.port.restart('alpha', aborted.signal)
  assert.equal(skippedOutcome.kind, 'failed')
  if (skippedOutcome.kind === 'failed') assert.equal(skippedOutcome.failure.kind, 'superseded')
  assert.equal(skipped.calls.restarts.length, 0, 'a cancelled restart is never dispatched')

  const inFlight = createFixture()
  let rejectRestart!: (error: unknown) => void
  inFlight.restartResult = async () => await new Promise((_resolve, reject) => { rejectRestart = reject })
  const pending = inFlight.port.restart('alpha', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  rejectRestart({ code: 'gateway/cancelled', message: 'the transport was cancelled' })
  const lost = await pending
  assert.equal(lost.kind, 'failed')
  if (lost.kind === 'failed') assert.equal(lost.failure.kind, 'outcome-unconfirmed',
    'a cancellation AFTER dispatch cannot prove the restart did not run')
  assert.equal(inFlight.calls.restarts.length, 1, 'the restart is never replayed')
})

test('restart keeps a proven refusal distinct and treats a generation change as unconfirmed', async () => {
  const refused = createFixture()
  refused.restartResult = async () => { throw { code: 'mcp/cleanup-incomplete', message: 'cleanup for "alpha" is incomplete' } }
  const refusal = await refused.port.restart('alpha', new AbortController().signal)
  assert.equal(refusal.kind, 'failed')
  if (refusal.kind === 'failed') assert.equal(refusal.failure.kind, 'rejected')

  const changed = createFixture()
  let resolveRestart!: () => void
  changed.restartResult = async () => await new Promise<void>(resolve => { resolveRestart = resolve })
  const pending = changed.port.restart('alpha', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  changed.generation.advance()
  resolveRestart()
  const outcome = await pending
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.failure.kind, 'outcome-unconfirmed')
  assert.equal(changed.calls.restarts.length, 1)
})

test('restart settles only after the Host accepted it — never as "connected"', async () => {
  const fixture = createFixture()
  const outcome = await fixture.port.restart('alpha', new AbortController().signal)
  assert.equal(outcome.kind, 'settled')
  if (outcome.kind !== 'settled') return
  assert.equal(outcome.generation, fixture.generation.getSnapshot())
  assert.equal(outcome.value, undefined)
})
