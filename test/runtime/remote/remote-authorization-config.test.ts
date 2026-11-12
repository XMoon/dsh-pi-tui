/**
 * REAL_WIRE + UNIT: the Remote provider-native authorization adapter (M6-1
 * F7A).
 *
 * REAL_WIRE cases run the PRODUCTION Host bridge and the PRODUCTION Remote
 * adapter over the real generated Client namespace and the real Typert
 * carrier (the in-process carrier, never a fake Gateway). UNIT cases drive the
 * adapter's own currentness/failure taxonomy with a scripted namespace: a lost
 * acknowledgement, a generation replacement, an invalid frame and a stream
 * that disappears are transport facts the adapter must never translate into a
 * business outcome.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/remote-authorization-config.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationService, { type AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime, type InProcessHostCarrier, type RemoteHostRuntime } from '../../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture, waitFor } from '../../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../../support/temp-lifecycle.ts'
import {
  AuthorizationDispatchUnknownError,
  RemoteAuthorizationConfig,
} from '../../../src/runtime/remote/authorization-remote.ts'
import {
  PI_TUI_AUTHORIZATION_NAMESPACE,
  type PiTuiAuthorizationNamespace,
  type PiTuiAuthorizationRunStream,
} from '../../../src/runtime/remote/pi-tui-authorization-contract.ts'
import type { AuthorizationFlowEvent, AuthorizationFlowTarget } from '../../../src/runtime/config-port.ts'
import type { RemoteConnectionGenerationSource } from '../../../src/runtime/remote/session-reader-remote.ts'

/** One bounded failure guard: a hung stream read fails the case, not the lane. */
function within<T>(promise: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer !== undefined) clearTimeout(timer) }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs)
    }),
  ])
}

interface Wire {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  readonly adapter: RemoteAuthorizationConfig
  readonly events: AuthorizationFlowEvent[]
  registerFlow(flow: Parameters<AuthorizationService['registerFlow']>[0]): () => void
  dispose(): Promise<void>
}

async function mountWire(life: TestLifecycle, presetId: string): Promise<Wire> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  await host.ctx.plugin(AuthorizationService)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const adapter = new RemoteAuthorizationConfig(
    client.remote.piTuiAuthorization,
    client.connection.generation,
  )
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    adapter,
    events,
    registerFlow: flow => (host.ctx.reflect.get('authorization') as AuthorizationService).registerFlow(flow),
    dispose: async () => {
      if (disposed) return
      disposed = true
      adapter.dispose()
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** One registered flow that answers prompts and commits a grant. */
function registerCommitFlow(wire: Wire, id: string, onSecret?: (value: string) => void): string {
  const key = `llm-pi-ai/${id}`
  wire.registerFlow({
    key: credentialKey('llm-pi-ai', id),
    label: `F7A ${id}`,
    methods: [{ id: 'device', label: 'Device code' }],
    run: async (session: AuthorizationSession) => {
      session.notify({ message: `Open ${id}`, url: `https://example.test/${id}`, code: 'DE-1' })
      const secret = await session.prompt({ kind: 'secret', message: 'Secret code' })
      onSecret?.(secret)
      await session.commit({ kind: 'grant', payload: { token: secret } } as never)
    },
  })
  return key
}

async function waitForEvent(
  events: readonly AuthorizationFlowEvent[],
  predicate: (event: AuthorizationFlowEvent) => boolean,
  label: string,
): Promise<AuthorizationFlowEvent> {
  await waitFor(label, () => events.some(predicate), 15_000)
  return events.find(predicate) as AuthorizationFlowEvent
}

test('REAL_WIRE: the generated prototype publishes the ONE private namespace without an own copied property', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-namespace')
  try {
    const remote = wire.client.remote as unknown as Record<string, unknown>
    assert.notEqual(remote.piTuiAuthorization, undefined)
    // The namespace is a live generated member, not an own copy/spread.
    assert.equal(Object.hasOwn(remote, 'piTuiAuthorization'), false)
    // The mounted namespace exposes the four strict methods of the ONE
    // contribution (the Client registry refuses a second package contribution).
    const namespace = remote.piTuiAuthorization as Record<string, unknown>
    for (const method of ['list', 'run', 'respond', 'cancel']) {
      assert.equal(typeof namespace[method], 'function', method)
    }
  } finally {
    await wire.dispose()
  }
})

test('REAL_WIRE: the roster refresh is a ready detached snapshot and a foreign scope has no route', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-roster')
  try {
    registerCommitFlow(wire, 'f7a-roster')
    wire.registerFlow({
      key: credentialKey('other-plugin', 'grant'),
      label: 'Foreign flow',
      methods: [{ id: 'foreign', label: 'Foreign' }],
      run: async () => {},
    })
    assert.equal(wire.adapter.targetsState(), 'stale', 'the roster starts unread')
    await wire.adapter.refreshTargets()
    assert.equal(wire.adapter.targetsState(), 'ready')
    const targets = wire.adapter.listTargets()
    const flow = targets.find((target: AuthorizationFlowTarget) => target.key === 'llm-pi-ai/f7a-roster')
    assert.deepEqual(flow, {
      kind: 'authorization',
      route: 'f7a-roster',
      key: 'llm-pi-ai/f7a-roster',
      label: 'F7A f7a-roster',
      methods: [{ id: 'device', label: 'Device code' }],
      inFlight: false,
    })
    assert.equal(targets.find(target => target.key === 'other-plugin/grant')?.route, undefined)
    // A detached copy: mutating the returned rows cannot corrupt the cache.
    ;(flow as { label: string }).label = 'tampered'
    assert.equal(wire.adapter.listTargets().find(target => target.key === 'llm-pi-ai/f7a-roster')?.label, 'F7A f7a-roster')
  } finally {
    await wire.dispose()
  }
})

test('REAL_WIRE: begin resolves only on the started frame; notice, secret prompt and authorized arrive in order', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-flow')
  try {
    const secrets: string[] = []
    const key = registerCommitFlow(wire, 'f7a-wire-flow-provider', value => { secrets.push(value) })
    const started = await within(wire.adapter.begin({ key, method: 'device' }), 'begin')
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    const prompt = await waitForEvent(wire.events, event => event.kind === 'prompt', 'the secret prompt')
    assert.equal(prompt.kind, 'prompt')
    if (prompt.kind !== 'prompt') return
    assert.equal(prompt.prompt.kind, 'secret')
    // The secret is sent exactly once over the authenticated unary answer.
    await within(wire.adapter.respond(started.attemptId, prompt.promptId, 'TOP-SECRET'), 'respond')
    await waitForEvent(wire.events, event => event.kind === 'settled', 'the official settlement')
    const notice = wire.events.find(event => event.kind === 'notice')
    assert.ok(notice !== undefined && notice.kind === 'notice')
    assert.deepEqual(notice.notice, { message: 'Open f7a-wire-flow-provider', url: 'https://example.test/f7a-wire-flow-provider', code: 'DE-1' })
    const settled = wire.events.find(event => event.kind === 'settled')
    assert.ok(settled !== undefined && settled.kind === 'settled')
    assert.equal(settled.status, 'authorized')
    assert.deepEqual(secrets, ['TOP-SECRET'], 'the flow receives the secret exactly once')
    // The secret never rides an event (the only secret-bearing direction is the answer).
    assert.equal(JSON.stringify(wire.events).includes('TOP-SECRET'), false)
    // The final roster is re-read from the Host, not inferred from the local start.
    await wire.adapter.refreshTargets()
    assert.equal(wire.adapter.listTargets().find(target => target.key === key)?.inFlight, false)
    assert.equal((await wire.host.ctx.credentials.describeRecord(credentialKey('llm-pi-ai', 'f7a-wire-flow-provider'))).configured, true)
  } finally {
    await wire.dispose()
  }
})

test('REAL_WIRE: two Clients run different credential keys independently', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-two-clients')
  const second = await createRemoteClientRuntime({ carrier: wire.hostRuntime.carrier })
  const secondAdapter = new RemoteAuthorizationConfig(second.remote.piTuiAuthorization, second.connection.generation)
  const secondEvents: AuthorizationFlowEvent[] = []
  secondAdapter.onEvent(event => { secondEvents.push(event) })
  try {
    const keyA = registerCommitFlow(wire, 'f7a-wire-key-a')
    const keyB = registerCommitFlow(wire, 'f7a-wire-key-b')
    const beginA = await within(wire.adapter.begin({ key: keyA, method: 'device' }), 'client A begin')
    const beginB = await within(secondAdapter.begin({ key: keyB, method: 'device' }), 'client B begin')
    assert.equal(beginA.kind, 'started')
    assert.equal(beginB.kind, 'started')
    if (beginA.kind !== 'started' || beginB.kind !== 'started') return
    const promptA = await waitForEvent(wire.events, event => event.kind === 'prompt', 'client A prompt')
    const promptB = await waitForEvent(secondEvents, event => event.kind === 'prompt', 'client B prompt')
    assert.equal(promptA.kind, 'prompt')
    assert.equal(promptB.kind, 'prompt')
    if (promptA.kind !== 'prompt' || promptB.kind !== 'prompt') return
    await wire.adapter.respond(beginA.attemptId, promptA.promptId, 'secret-a')
    await secondAdapter.respond(beginB.attemptId, promptB.promptId, 'secret-b')
    await waitForEvent(wire.events, event => event.kind === 'settled', 'client A settlement')
    await waitForEvent(secondEvents, event => event.kind === 'settled', 'client B settlement')
    const settledA = wire.events.find(event => event.kind === 'settled')
    const settledB = secondEvents.find(event => event.kind === 'settled')
    assert.ok(settledA !== undefined && settledA.kind === 'settled' && settledA.status === 'authorized')
    assert.ok(settledB !== undefined && settledB.kind === 'settled' && settledB.status === 'authorized')
    assert.deepEqual(await wire.host.ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'f7a-wire-key-a')), { kind: 'grant', payload: { token: 'secret-a' } })
    assert.deepEqual(await wire.host.ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'f7a-wire-key-b')), { kind: 'grant', payload: { token: 'secret-b' } })
  } finally {
    secondAdapter.dispose()
    await second.dispose()
    await wire.dispose()
  }
})

/**
 * A REAL carrier that forwards every call to the in-process Host and then
 * DROPS the first `run` downlink frame. The Host really dispatches the attempt
 * (the fixture flow runs), so this is a transport fault on a real send/consume
 * chain — not a precomputed `connected=false` fake.
 */
function dropFirstRunFrame(carrier: InProcessHostCarrier): InProcessHostCarrier {
  return {
    ownsHost: true,
    fetch: carrier.fetch,
    openStream(endpoint, payload, signal, uplink) {
      const source = carrier.openStream(endpoint, payload, signal, uplink)
      if (endpoint !== 'piTuiAuthorization/run') return source
      return (async function* dropping(): AsyncGenerator<unknown> {
        let first = true
        for await (const item of source) {
          if (first) {
            first = false
            continue
          }
          yield item
        }
      })()
    },
  }
}

test('REAL_WIRE: a dispatched run whose started frame is lost is dispatch-unknown and never re-run', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-start-lost')
  let runs = 0
  wire.registerFlow({
    key: credentialKey('llm-pi-ai', 'f7a-wire-start-lost-provider'),
    label: 'F7A start lost',
    methods: [{ id: 'device', label: 'Device code' }],
    run: async (session: AuthorizationSession) => {
      runs += 1
      session.notify({ message: 'F7A start-lost attempt' })
      await new Promise<void>((_resolve, reject) => {
        session.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  const flaky = await createRemoteClientRuntime({ carrier: dropFirstRunFrame(wire.hostRuntime.carrier) })
  const adapter = new RemoteAuthorizationConfig(flaky.remote.piTuiAuthorization, flaky.connection.generation)
  try {
    await assert.rejects(
      adapter.begin({ key: 'llm-pi-ai/f7a-wire-start-lost-provider', method: 'device' }),
      (error: unknown) => error instanceof AuthorizationDispatchUnknownError && error.code === 'DISPATCH_UNKNOWN',
    )
    await waitFor('the Host actually dispatched the attempt', () => runs === 1, 5_000)
    await sleep(150)
    assert.equal(runs, 1, 'the Client must never open a second Host attempt after losing the started frame')
  } finally {
    adapter.dispose()
    await flaky.dispose()
    await wire.dispose()
  }
})

test('REAL_WIRE: a stream lost after the official commit is unconfirmed, never authorized', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-commit-lost')
  const events: AuthorizationFlowEvent[] = []
  wire.adapter.onEvent(event => { events.push(event) })
  let committed = false
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const key = 'llm-pi-ai/f7a-wire-commit-lost-provider'
  wire.registerFlow({
    key: credentialKey('llm-pi-ai', 'f7a-wire-commit-lost-provider'),
    label: 'F7A commit lost',
    methods: [{ id: 'device', label: 'Device code' }],
    run: async (session: AuthorizationSession) => {
      session.notify({ message: 'F7A committing' })
      await session.commit({ kind: 'grant', payload: { token: 'committed-but-unobserved' } } as never)
      committed = true
      await held
    },
  })
  try {
    const started = await within(wire.adapter.begin({ key, method: 'device' }), 'begin')
    assert.equal(started.kind, 'started')
    await waitFor('the official credential commit', () => committed, 10_000)
    const before = wire.client.connection.generation.getSnapshot()
    wire.client.connection.reconnect()
    await waitFor('the Connection generation replacement', () => !Object.is(before, wire.client.connection.generation.getSnapshot()), 10_000)
    release()
    await waitFor('the unconfirmed terminal', () => events.some(event => event.kind === 'unconfirmed'), 10_000)
    await sleep(150)
    assert.equal(events.some(event => event.kind === 'settled'), false,
      'a stream lost after the official commit must never be reported as authorized/cancelled/failed')
    assert.equal(events.filter(event => event.kind === 'unconfirmed').length, 1)
    // The Host commit is REAL and remains; the Client did not observe it.
    assert.equal((await wire.host.ctx.credentials.describeRecord(credentialKey('llm-pi-ai', 'f7a-wire-commit-lost-provider'))).configured, true)
  } finally {
    release()
    await wire.dispose()
  }
})

test('REAL_WIRE: a caller teardown of a running attempt closes the flow as unconfirmed instead of leaving it pending', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f7a-wire-page-teardown')
  let flowAborted = false
  wire.registerFlow({
    key: credentialKey('llm-pi-ai', 'f7a-wire-page-teardown-provider'),
    label: 'F7A page teardown',
    methods: [{ id: 'device', label: 'Device code' }],
    run: async (session: AuthorizationSession) => {
      try {
        session.notify({ message: 'F7A page-teardown attempt' })
        await session.prompt({ kind: 'text', message: 'F7A page-teardown prompt' })
      } catch (error) {
        flowAborted = session.signal.aborted
        throw error
      }
    },
  })
  const controller = new AbortController()
  const key = 'llm-pi-ai/f7a-wire-page-teardown-provider'
  try {
    const started = await within(wire.adapter.begin({ key, method: 'device', signal: controller.signal }), 'begin')
    assert.equal(started.kind, 'started')
    await waitForEvent(wire.events, event => event.kind === 'prompt', 'the page-teardown prompt')
    // The Models page disposes: it aborts its own signal first and only then
    // requests cancellation. The adapter still owns the flow listener, so the
    // official terminal is no longer observable through this stream.
    controller.abort()
    await waitForEvent(wire.events, event => event.kind === 'unconfirmed', 'the teardown unconfirmed terminal')
    const unconfirmed = wire.events.find(event => event.kind === 'unconfirmed')
    assert.ok(unconfirmed !== undefined && unconfirmed.kind === 'unconfirmed')
    assert.match(unconfirmed.reason, /page was closed/)
    assert.equal(wire.events.some(event => event.kind === 'settled'), false,
      'a caller teardown must not fabricate an official business outcome')
    await waitFor('the Host attempt withdrawal', () => flowAborted, 10_000)
    // The attempt is closed locally; a late answer/reply cannot resurrect it.
    await assert.rejects(wire.adapter.cancel(started.attemptId), /no longer active/)
  } finally {
    await wire.dispose()
  }
})

/* ------------------------------------------------------------------------- *
 * UNIT: currentness and transport-failure taxonomy (scripted namespace).
 * ------------------------------------------------------------------------- */

interface FakeGeneration {
  readonly source: RemoteConnectionGenerationSource
  replace(): void
}

function fakeGeneration(): FakeGeneration {
  let current: { readonly id: number } | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    replace: () => {
      current = { id: (current?.id ?? 1) + 1 }
      for (const listener of [...listeners]) listener()
    },
  }
}

function fakeStream(iterable: AsyncIterable<unknown>): PiTuiAuthorizationRunStream & { disposed: boolean } {
  const handle = {
    disposed: false,
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
    send(): void {},
    end(): void {},
    dispose(): void { handle.disposed = true },
  }
  return handle as unknown as PiTuiAuthorizationRunStream & { disposed: boolean }
}

function fakeNamespace(overrides: Partial<PiTuiAuthorizationNamespace>): PiTuiAuthorizationNamespace {
  return {
    list: async () => ({ ok: true, value: { kind: 'ready', targets: [] } }),
    run: () => fakeStream((async function* empty() {})()),
    respond: async () => ({ ok: true, value: undefined }),
    cancel: async () => ({ ok: true, value: undefined }),
    ...overrides,
  }
}

/** A stream that emits the given frames and then ends (or waits forever). */
function streamOf(
  frames: readonly unknown[],
  options: { readonly throwAfter?: Error; readonly holdOpen?: boolean } = {},
): PiTuiAuthorizationRunStream & { disposed: boolean } {
  return fakeStream((async function* framesThen(): AsyncGenerator<unknown> {
    for (const frame of frames) yield frame
    if (options.throwAfter !== undefined) throw options.throwAfter
    if (options.holdOpen === true) await new Promise(() => {})
  })())
}

test('UNIT: a namespace absence is a definite unavailable roster and begin; a failed read is stale', async () => {
  const generation = fakeGeneration()
  const absent = new RemoteAuthorizationConfig(undefined, generation.source)
  await absent.refreshTargets()
  assert.equal(absent.targetsState(), 'unavailable')
  assert.equal(absent.available(), false)
  assert.deepEqual(absent.listTargets(), [])
  assert.deepEqual(await absent.begin({ key: 'llm-pi-ai/x' }), { kind: 'unavailable' })
  absent.dispose()

  const failing = new RemoteAuthorizationConfig(fakeNamespace({
    list: async () => { throw new Error('carrier down') },
  }), generation.source)
  await assert.rejects(failing.refreshTargets(), /carrier down/)
  assert.equal(failing.targetsState(), 'stale')
  failing.dispose()
})

test('UNIT: begin before the started frame is a dispatch-unknown error, never unavailable and never replayed', async () => {
  const generation = fakeGeneration()
  let runCalls = 0
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => {
      runCalls += 1
      return streamOf([], { throwAfter: new Error('carrier lost') })
    },
  }), generation.source)
  try {
    await assert.rejects(
      adapter.begin({ key: 'llm-pi-ai/x', method: 'device' }),
      (error: unknown) => error instanceof AuthorizationDispatchUnknownError && error.code === 'DISPATCH_UNKNOWN',
    )
    assert.equal(runCalls, 1, 'a dispatch is never automatically retried')
  } finally {
    adapter.dispose()
  }
})

test('UNIT: a stream lost after started becomes unconfirmed (never failed/cancelled/authorized) and is not replayed', async () => {
  const generation = fakeGeneration()
  let runCalls = 0
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => {
      runCalls += 1
      return streamOf([
        { kind: 'started', attemptId: 'attempt-1' },
        { kind: 'notice', attemptId: 'attempt-1', notice: { message: 'opening' } },
      ], { throwAfter: new Error('socket closed') })
    },
  }), generation.source)
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  try {
    const started = await adapter.begin({ key: 'llm-pi-ai/x' })
    assert.equal(started.kind, 'started')
    await waitFor('the unconfirmed terminal', () => events.some(event => event.kind === 'unconfirmed'), 5_000)
    const terminal = events[events.length - 1]
    assert.equal(terminal?.kind, 'unconfirmed')
    if (terminal?.kind !== 'unconfirmed') return
    assert.match(terminal.reason, /lost/)
    assert.equal(events.some(event => event.kind === 'settled'), false)
    assert.equal(runCalls, 1)
  } finally {
    adapter.dispose()
  }
})

test('UNIT: a generation replacement turns an in-flight attempt into unconfirmed and drops later frames', async () => {
  const generation = fakeGeneration()
  let release: () => void = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => fakeStream((async function* framesThen(): AsyncGenerator<unknown> {
      yield { kind: 'started', attemptId: 'attempt-gen' }
      yield { kind: 'notice', attemptId: 'attempt-gen', notice: { message: 'opening' } }
      await blocked
      yield { kind: 'settled', attemptId: 'attempt-gen', status: 'authorized' }
    })()),
  }), generation.source)
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  try {
    await adapter.begin({ key: 'llm-pi-ai/x' })
    assert.equal(adapter.targetsState(), 'stale')
    generation.replace()
    assert.equal(adapter.targetsState(), 'stale')
    await waitFor('the unconfirmed terminal', () => events.some(event => event.kind === 'unconfirmed'), 5_000)
    release()
    await sleep(50)
    // The late `authorized` frame of the old generation never reaches the page.
    assert.equal(events.some(event => event.kind === 'settled'), false)
    assert.equal(events.filter(event => event.kind === 'unconfirmed').length, 1)
  } finally {
    adapter.dispose()
  }
})

test('UNIT: an invalid or foreign frame closes the attempt as unconfirmed instead of trusting it', async () => {
  const generation = fakeGeneration()
  for (const [label, frame] of [
    ['extra secret field', { kind: 'notice', attemptId: 'attempt-bad', notice: { message: 'x' }, token: 'secret' }],
    ['unknown kind', { kind: 'progress', attemptId: 'attempt-bad' }],
    ['foreign attempt', {
      kind: 'prompt',
      attemptId: 'another-attempt',
      promptId: 'p-foreign',
      prompt: { kind: 'text', message: 'not this stream' },
    }],
  ] as const) {
    const adapter = new RemoteAuthorizationConfig(fakeNamespace({
      run: () => streamOf([{ kind: 'started', attemptId: 'attempt-bad' }, frame]),
    }), generation.source)
    const events: AuthorizationFlowEvent[] = []
    adapter.onEvent(event => { events.push(event) })
    const started = await adapter.begin({ key: 'llm-pi-ai/x' })
    assert.equal(started.kind, 'started', label)
    await waitFor(`the ${label} unconfirmed`, () => events.some(event => event.kind === 'unconfirmed'), 5_000)
    assert.equal(events.some(event => event.kind === 'notice'), false, label)
    adapter.dispose()
  }
})

test('UNIT: a lost respond acknowledgement becomes unconfirmed and the answer is never re-sent', async () => {
  const generation = fakeGeneration()
  let respondCalls = 0
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => streamOf([
      { kind: 'started', attemptId: 'attempt-ack' },
      { kind: 'prompt', attemptId: 'attempt-ack', promptId: 'p-1', prompt: { kind: 'secret', message: 'code' } },
    ], { holdOpen: true }),
    respond: async () => {
      respondCalls += 1
      throw new Error('carrier lost the answer')
    },
  }), generation.source)
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  try {
    const started = await adapter.begin({ key: 'llm-pi-ai/x' })
    assert.equal(started.kind, 'started')
    await waitFor('the prompt event', () => events.some(event => event.kind === 'prompt'), 5_000)
    await assert.rejects(adapter.respond('attempt-ack', 'p-1', 'secret'), /carrier lost the answer/)
    assert.equal(respondCalls, 1, 'the answer is never automatically re-sent')
    await waitFor('the unconfirmed terminal', () => events.some(event => event.kind === 'unconfirmed'), 5_000)
    assert.equal(events[events.length - 1]?.kind, 'unconfirmed')
  } finally {
    adapter.dispose()
  }
})

test('UNIT: a DEFINITE respond refusal closes the attempt as unconfirmed instead of leaving the flow pending', async () => {
  const generation = fakeGeneration()
  let respondCalls = 0
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => streamOf([
      { kind: 'started', attemptId: 'attempt-refused' },
      { kind: 'prompt', attemptId: 'attempt-refused', promptId: 'p-refused', prompt: { kind: 'secret', message: 'code' } },
    ], { holdOpen: true }),
    respond: async () => {
      respondCalls += 1
      return { ok: false as const, error: new RemoteError('gateway/invocation-unavailable', 'the prompt is no longer pending', { endpoint: 'piTuiAuthorization/respond' }) }
    },
  }), generation.source)
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  try {
    const started = await adapter.begin({ key: 'llm-pi-ai/x' })
    assert.equal(started.kind, 'started')
    await waitFor('the prompt event', () => events.some(event => event.kind === 'prompt'), 5_000)
    await assert.rejects(adapter.respond('attempt-refused', 'p-refused', 'secret'), /no longer pending/)
    assert.equal(respondCalls, 1, 'the refused answer is never re-sent')
    await waitFor('the unconfirmed terminal', () => events.some(event => event.kind === 'unconfirmed'), 5_000)
    assert.equal(events[events.length - 1]?.kind, 'unconfirmed')
    // The attempt is closed: no further prompt can be answered for it.
    await assert.rejects(adapter.respond('attempt-refused', 'p-refused', 'secret'), /no longer active/)
  } finally {
    adapter.dispose()
  }
})

test('UNIT: a lost cancel acknowledgement is a definite failure, never a forged terminal', async () => {
  const generation = fakeGeneration()
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => streamOf([
      { kind: 'started', attemptId: 'attempt-cancel' },
    ], { holdOpen: true }),
    cancel: async () => { throw new Error('cancel acknowledgement lost') },
  }), generation.source)
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  try {
    await adapter.begin({ key: 'llm-pi-ai/x' })
    await assert.rejects(adapter.cancel('attempt-cancel'), /cancel acknowledgement lost/)
    assert.equal(events.some(event => event.kind === 'settled' || event.kind === 'unconfirmed'), false)
  } finally {
    adapter.dispose()
  }
})

test('UNIT: dispose closes every attempt and releases the generation subscription and listeners', async () => {
  const generation = fakeGeneration()
  let disposedStreams = 0
  let runCalls = 0
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    run: () => {
      runCalls += 1
      const handle = fakeStream((async function* forever(): AsyncGenerator<unknown> {
        yield { kind: 'started', attemptId: `attempt-${runCalls}` }
        await new Promise(() => {})
      })())
      const dispose = handle.dispose.bind(handle)
      handle.dispose = () => { disposedStreams += 1; dispose() }
      return handle
    },
  }), generation.source)
  const events: AuthorizationFlowEvent[] = []
  adapter.onEvent(event => { events.push(event) })
  await adapter.begin({ key: 'llm-pi-ai/x' })
  await adapter.begin({ key: 'llm-pi-ai/y' })
  assert.equal(disposedStreams, 0)
  adapter.dispose()
  assert.equal(disposedStreams, 2, 'every live stream is disposed exactly once')
  assert.equal(events.some(event => event.kind === 'unconfirmed'), false, 'a deliberate teardown is not an unconfirmed result')
  // A generation replacement after dispose cannot reach the adapter's state.
  generation.replace()
  assert.equal(adapter.targetsState(), 'stale')
  // Re-dispose is idempotent.
  adapter.dispose()
})

test('UNIT: the adapters expose the private namespace only; a roster read never invents a flow', async () => {
  const generation = fakeGeneration()
  const adapter = new RemoteAuthorizationConfig(fakeNamespace({
    list: async () => ({
      ok: true,
      value: {
        kind: 'ready',
        targets: [
          {
            kind: 'authorization',
            key: 'llm-pi-ai/openai-codex',
            route: 'openai-codex',
            label: 'ChatGPT (Codex)',
            methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
            inFlight: true,
          },
        ],
      },
    }),
  }), generation.source)
  try {
    await adapter.refreshTargets()
    assert.deepEqual(adapter.listTargets(), [{
      kind: 'authorization',
      key: 'llm-pi-ai/openai-codex',
      route: 'openai-codex',
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      inFlight: true,
    }])
    assert.equal(PI_TUI_AUTHORIZATION_NAMESPACE, 'piTuiAuthorization')
  } finally {
    adapter.dispose()
  }
})
