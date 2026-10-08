/**
 * R2 L5 real-wire suite for the private `piTuiTerminalProgress` stream: the
 * PRODUCTION Host row (`app/remote/terminal-progress-host.ts`), the PRODUCTION
 * Client source (`app/remote/terminal-progress-source.ts`) and the real
 * in-process carrier — no test-local stream endpoint, no fake Gateway.
 *
 * ```text
 * real AgentLoop turn
 *   -> PiTuiTerminalProgressHostService.watch()    (production Host row)
 *   -> gateway.wireStream.open()                   (production carrier)
 *   -> ClientStreamHandle.iterate()                (rc.2 Gateway Client)
 *   -> createRemoteTerminalProgressSource().open() (production Client source)
 *   -> RemoteMainProgressFact[]
 * ```
 *
 * FIXTURE MANIFEST (plan §9.2)
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the real rc.2 Host Context of `createRemoteApplicationHostFixture` (real
 *   AgentLoop harness, Typert registry, Gateway, AgentRegistry, sessions, jobs)
 * - `createRemoteHostRuntime(host.ctx)` (the package's ONE private contribution
 *   plus the production terminal-progress Host row) and
 *   `createRemoteClientRuntime({ carrier })`
 * - the production `createRemoteTerminalProgressSource` over the real client
 *   `remote` face + `connection.generation` + retained-binding accessor
 * - the production AgentLoop of the harness: `turn/start`, `turn/end` and
 *   `agent/status` are REAL emissions
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the LLM adapter (scripted Completed/Failing/Abortable): the model endpoint
 *   is synthetic, the loop and its events are real
 * - the fixture's ordinary readiness stand-ins (webServer, fileReferences)
 *   carry no terminal-progress state
 * - PROOF 6 (the Client source's own validation/fence rules) stands in a fake
 *   `RemoteStreamHandle` for the wire so the deterministic rules can be driven
 *   directly; the PRODUCTION source is the unit under test
 *
 * DELIBERATELY ABSENT
 * - any real WebSocket TCP server/client (asserted: zero WebSocket
 *   constructions and the private endpoint travelled through `carrier.openStream`)
 *
 * @module @xmoon76/dsh-pi-tui/remote-terminal-progress-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { symbols, type Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteMainProgressFact } from '../src/app/application-runtime.ts'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../src/app/remote/host-runtime.ts'
import {
  consumeRemoteTerminalProgress,
  createRemoteTerminalProgressSource,
  type RemoteTerminalProgressSource,
} from '../src/app/remote/terminal-progress-source.ts'
import {
  PI_TUI_TERMINAL_PROGRESS_WATCH,
  type PiTuiTerminalProgressFrame,
} from '../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import { createRemoteApplicationHostFixture, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

// ── scripted LLM endpoints (the loop and its events stay real) ─────────────

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One completed text turn. */
class CompletedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    for (const chunk of textResponse('ok')) yield chunk
  }
}

/** One failing request (the `error` settlement). */
class FailingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('r2 probe failure', 'UNKNOWN')
  }
}

/** Blocks until cancelled (the `aborted` settlement and the held-open turn). */
class AbortableAdapter extends LlmAdapter {
  readonly started: Promise<void>
  private signalStarted!: () => void
  constructor() {
    super()
    this.started = new Promise(resolve => { this.signalStarted = resolve })
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.signalStarted()
    await new Promise<never>((_resolve, reject) => {
      const signal = options.signal
      if (signal === undefined) {
        reject(new Error('the loop must pass an abort signal'))
        return
      }
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
    })
  }
}

// ── the mounted production wire graph ──────────────────────────────────────

/** The diagnostics channel `createRemoteHostRuntime` reports unknown kinds through. */
interface DiagProbe {
  readonly warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }>
  readonly diag: { warn(message: string, fields?: Record<string, unknown>): void }
}

function diagProbe(): DiagProbe {
  const warnings: DiagProbe['warnings'] = []
  return { warnings, diag: { warn: (message, fields) => { warnings.push({ message, fields }) } } }
}

interface ProductionWire {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  readonly source: RemoteTerminalProgressSource
  readonly carrierOpenEndpoints: string[]
  /** The raw production Host row (unwrapped from the Cordis traceable proxy). */
  readonly progressHost: { records: Map<string, { subscribers: Set<unknown> }> }
  dispose(): Promise<void>
}

/** Wrap the exact in-process carrier the Client is told to install (before the
 *  Client captures `carrier.openStream`). */
function watchCarrier(hostRuntime: RemoteHostRuntime): string[] {
  const endpoints: string[] = []
  const original = hostRuntime.carrier.openStream
  hostRuntime.carrier.openStream = (endpoint, payload, signal, uplink) => {
    endpoints.push(endpoint)
    return original(endpoint, payload, signal, uplink)
  }
  return endpoints
}

async function mountProductionWire(
  life: TestLifecycle,
  presetId: string,
  options: { readonly llmAdapter?: LlmAdapter; readonly diag?: DiagProbe } = {},
): Promise<ProductionWire> {
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    ...(options.llmAdapter === undefined ? {} : { llmAdapter: options.llmAdapter }),
  })
  const hostRuntime = await createRemoteHostRuntime(host.ctx, {
    ...(options.diag === undefined ? {} : { diag: options.diag.diag }),
  })
  const carrierOpenEndpoints = watchCarrier(hostRuntime)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const source = createRemoteTerminalProgressSource({
    remote: client.remote,
    generation: client.connection.generation,
    binding: sessionId => client.sessions.binding(sessionId as never) as object | undefined,
  })
  const proxied = host.ctx.reflect.get('piTuiTerminalProgress') as { readonly [symbols.original]?: unknown }
  const progressHost = (proxied[symbols.original] ?? proxied) as ProductionWire['progressHost']
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    source,
    carrierOpenEndpoints,
    progressHost,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** Retain one Host-created session on the Client so the source has a binding. */
async function retainSession(wire: ProductionWire, sessionId: string): Promise<() => void> {
  const reference = wire.client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
  await reference.ready
  return () => { reference.release() }
}

/** Open one production source watch; `settled` resolves when the terminal update lands. */
function collectUntilTerminal(
  source: RemoteTerminalProgressSource,
  sessionId: string,
  controller: AbortController,
): { readonly facts: RemoteMainProgressFact[]; readonly settled: Promise<void> } {
  const facts: RemoteMainProgressFact[] = []
  const settled = (async (): Promise<void> => {
    for await (const fact of source.open(sessionId, controller.signal)) {
      facts.push(fact)
      if (fact.kind === 'update' && !fact.running) return
    }
  })()
  return { facts, settled }
}

function factLabels(facts: readonly RemoteMainProgressFact[]): string[] {
  return facts.map(fact => `${fact.kind}:${fact.running}:${fact.outcome}`)
}

// ── PROOF 1 ────────────────────────────────────────────────────────────────

test('L5: a real completed turn reaches the production source as snapshot -> working -> done', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountProductionWire(life, 'r2-wire-completed', { llmAdapter: new CompletedAdapter() })
  const sessionId = 'r2-wire-completed-session'
  try {
    const agent = await wire.host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    const release = await retainSession(wire, sessionId)
    try {
      const controller = new AbortController()
      const { facts, settled } = collectUntilTerminal(wire.source, sessionId, controller)
      await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)
      assert.equal(facts[0]!.kind, 'snapshot', 'the watch opens with a snapshot')

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await settled
      controller.abort()

      assert.deepEqual(factLabels(facts), ['snapshot:false:idle', 'update:true:idle', 'update:false:done'],
        `the completed turn settles exactly one done through the production source: ${JSON.stringify(facts)}`)
    } finally {
      release()
    }
  } finally {
    await wire.dispose()
  }
})

// ── PROOF 2 ────────────────────────────────────────────────────────────────

test('L5: a real error turn settles error and a real cancelled turn settles idle', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountProductionWire(life, 'r2-wire-outcomes', { llmAdapter: new FailingAdapter() })
  const abortAdapter = new AbortableAdapter()
  wire.host.ctx.llm.registerAdapter(['r2-abort'], abortAdapter)
  try {
    // error: the fixture's smoke adapter fails every request.
    const errorId = 'r2-wire-error-session'
    const errorAgent = await wire.host.harness.create(SessionId(errorId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    const releaseError = await retainSession(wire, errorId)
    try {
      const controller = new AbortController()
      const { facts, settled } = collectUntilTerminal(wire.source, errorId, controller)
      await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)
      errorAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'fail' }], source: { kind: 'user' } }))
      await errorAgent.whenIdle()
      await settled
      controller.abort()
      assert.deepEqual(factLabels(facts), ['snapshot:false:idle', 'update:true:idle', 'update:false:error'],
        `the error reason settles error: ${JSON.stringify(facts)}`)
    } finally {
      releaseError()
    }

    // aborted: a cancelled turn is honestly idle, never a fabricated done.
    const abortId = 'r2-wire-aborted-session'
    const abortAgent = await wire.host.harness.create(SessionId(abortId), { provider: 'r2-abort', model: 'smoke' }, { cwd: wire.host.anchorDir })
    const releaseAbort = await retainSession(wire, abortId)
    try {
      const controller = new AbortController()
      const { facts, settled } = collectUntilTerminal(wire.source, abortId, controller)
      await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)
      abortAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel' }], source: { kind: 'user' } }))
      await abortAdapter.started
      abortAgent.cancel({ kind: 'user' })
      await abortAgent.whenIdle()
      await settled
      controller.abort()
      assert.deepEqual(factLabels(facts), ['snapshot:false:idle', 'update:true:idle', 'update:false:idle'],
        `the aborted reason settles idle: ${JSON.stringify(facts)}`)
    } finally {
      releaseAbort()
    }
  } finally {
    await wire.dispose()
  }
})

// ── PROOF 3 ────────────────────────────────────────────────────────────────

test('L5: break cancellation reaches the production Host row and releases its subscriber', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountProductionWire(life, 'r2-wire-cancel', { llmAdapter: new AbortableAdapter() })
  const sessionId = 'r2-wire-cancel-session'
  try {
    const agent = await wire.host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    const release = await retainSession(wire, sessionId)
    try {
      const controller = new AbortController()
      const facts: RemoteMainProgressFact[] = []
      // Open the watch BEFORE the turn so the snapshot is the idle baseline and
      // the running edge is a real update; `return` at the second frame is the
      // consumer break under test.
      const consume = (async (): Promise<void> => {
        for await (const fact of wire.source.open(sessionId, controller.signal)) {
          facts.push(fact)
          if (facts.length === 2) return
        }
      })()
      await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold' }], source: { kind: 'user' } }))
      await consume
      assert.equal(facts.length, 2, `the cancellation probe read the running update: ${JSON.stringify(facts)}`)
      assert.equal(facts[1]!.kind, 'update', 'the second frame is the running update')
      // The Host-row `watch` generator `finally` removes the subscriber: the
      // authoritative Host-side fact is the record's subscriber set returning to
      // empty. The break above awaited the whole client->carrier->Host unwind.
      await waitFor('the Host subscriber released by the break',
        () => (wire.progressHost.records.get(sessionId)?.subscribers.size ?? 0) === 0, 10_000)
      assert.equal(wire.progressHost.records.get(sessionId)!.subscribers.size, 0,
        'breaking out of the iteration removed the Host subscriber (the generator finally ran)')
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    } finally {
      release()
    }
  } finally {
    await wire.dispose()
  }
})

// ── PROOFS 4 + 5 ───────────────────────────────────────────────────────────

/** Installed only for the disposal proof: any real WebSocket construction is a failure. */
let webSocketConstructions = 0

test('L5: Host fiber disposal withdraws the descriptor and closes live watchers (in-process only)', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountProductionWire(life, 'r2-wire-dispose', { llmAdapter: new AbortableAdapter() })
  const disposedSession = 'r2-wire-dispose-live'
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof realWebSocket === 'function') {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: function countedWebSocket(): never {
        webSocketConstructions += 1
        throw new Error('physical WebSocket constructed on the in-process Remote path')
      },
    })
  }
  try {
    await wire.host.harness.create(SessionId(disposedSession), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    const release = await retainSession(wire, disposedSession)
    try {
      let liveFrames = 0
      const live = (async (): Promise<void> => {
        for await (const _fact of wire.source.open(disposedSession, new AbortController().signal)) liveFrames += 1
      })()
      await waitFor('the live watcher opened', () => liveFrames >= 1, 10_000)

      await wire.hostRuntime.dispose()
      // The row closed the live watcher (its subscriber queue ended) and the
      // iteration completed instead of hanging.
      await live
      assert.ok(liveFrames >= 1, 'the watcher received its opening frame')

      // A fresh watch now fails on the Host with the real withdrawn descriptor.
      // The raw typed client watch is used because the retained Binding itself
      // is released when the Host Connection composition goes away.
      let withdrawnError: unknown
      try {
        for await (const _frame of wire.client.remote.piTuiTerminalProgress.watch(disposedSession)) {
          assert.fail('a withdrawn descriptor must not yield frames')
        }
      } catch (error) {
        withdrawnError = error
      }
      assert.ok(withdrawnError instanceof Error, `the withdrawn descriptor must fail: ${String(withdrawnError)}`)
      assert.equal((withdrawnError as Error).message,
        'typert gateway: piTuiTerminalProgress/watch: its strict definition was withdrawn and SRC fallback is forbidden',
        'the real withdrawn-descriptor message')

      // PROOF 5: no physical socket; the private method travelled the in-process carrier.
      assert.equal(wire.hostRuntime.carrier.ownsHost, true, 'the transport is the in-process carrier')
      const transportEndpoint = `${PI_TUI_TERMINAL_PROGRESS_WATCH.namespace}/${PI_TUI_TERMINAL_PROGRESS_WATCH.method}`
      assert.ok(wire.carrierOpenEndpoints.includes(transportEndpoint),
        `the private endpoint travelled through carrier.openStream: ${JSON.stringify(wire.carrierOpenEndpoints)}`)
      assert.equal(webSocketConstructions, 0, 'no physical WebSocket client was constructed')
    } finally {
      release()
    }
  } finally {
    if (typeof realWebSocket === 'function') {
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: realWebSocket })
    }
    await wire.dispose()
  }
})

// ── PROOF 6 ────────────────────────────────────────────────────────────────

/** A minimal fake wire handle: `RemoteStreamHandle`-shaped, no Gateway. */
function fakeHandle(frames: readonly unknown[]): RemoteStreamHandle<PiTuiTerminalProgressFrame, never> {
  return {
    send: () => {},
    end: () => {},
    dispose: () => {},
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame
    },
  } as RemoteStreamHandle<PiTuiTerminalProgressFrame, never>
}

function frameOf(overrides: Partial<PiTuiTerminalProgressFrame> = {}): PiTuiTerminalProgressFrame {
  return {
    kind: 'snapshot',
    sessionId: 'r2-source-session',
    hostEpoch: 'host-1',
    agentEpoch: 1,
    revision: 1,
    running: false,
    outcome: 'idle',
    ...overrides,
  }
}

/** One source instance whose successive `watch()` calls return the given sequences. */
function sourceWithWatches(
  watches: ReadonlyArray<readonly unknown[]>,
  options: {
    readonly generation?: { current: unknown }
    readonly binding?: () => object | undefined
  } = {},
): { readonly source: RemoteTerminalProgressSource; readonly generation: { current: unknown } } {
  const generation = options.generation ?? { current: {} }
  // A retained binding is ONE stable object (the source compares it per frame by
  // identity); a fresh object per call would read as a re-retain.
  const stableBinding: object = { retained: true }
  const binding = options.binding ?? (() => stableBinding)
  let index = 0
  return {
    generation,
    source: createRemoteTerminalProgressSource({
      remote: { piTuiTerminalProgress: { watch: () => fakeHandle(watches[index++] ?? []) } },
      generation: { getSnapshot: () => generation.current },
      binding: () => binding(),
    }),
  }
}

async function drain(source: RemoteTerminalProgressSource, sessionId: string): Promise<RemoteMainProgressFact[]> {
  const facts: RemoteMainProgressFact[] = []
  for await (const fact of source.open(sessionId, new AbortController().signal)) facts.push(fact)
  return facts
}

test('L5: the consumption fails closed on a silent Host and stops quietly on abort or an owner move', async () => {
  const sessionId = 'r2-source-session'
  // A Host row that retires every watch without ever delivering a frame: the
  // consumer must bound the re-establishments and report a failure, never spin.
  const silent: RemoteTerminalProgressSource = { async *open() {} }
  await assert.rejects(
    consumeRemoteTerminalProgress(silent, sessionId, new AbortController().signal, {
      isCurrent: () => true,
      onFact: () => {},
    }),
    /ended without a frame/,
    'a frame-less watch is a broken authority: bounded, then failed',
  )

  // The caller's own abort and an owner move are EXPECTED stops, not failures.
  const aborted = new AbortController()
  aborted.abort()
  await consumeRemoteTerminalProgress(silent, sessionId, aborted.signal, {
    isCurrent: () => true,
    onFact: () => {},
  })
  await consumeRemoteTerminalProgress(silent, sessionId, new AbortController().signal, {
    isCurrent: () => false,
    onFact: () => {},
  })
})

test('L5: the Client source validates every frame and fences provenance/transport', async () => {
  const sessionId = 'r2-source-session'

  // The framework does not apply the descriptor codec to downlink items: the
  // source is the ONE boundary that rejects a violating frame.
  await assert.rejects(
    drain(sourceWithWatches([[{ ...frameOf(), outcome: 'bogus' }]]).source, sessionId),
    /outcome must be idle, done or error/,
    'a codec-violating frame must be rejected by the source',
  )
  await assert.rejects(
    drain(sourceWithWatches([[frameOf({ kind: 'update' })]]).source, sessionId),
    /did not open with a snapshot/,
  )
  await assert.rejects(
    drain(sourceWithWatches([[frameOf({ sessionId: 'other' })]]).source, sessionId),
    /delivered a frame of other/,
  )
  await assert.rejects(
    drain(sourceWithWatches([[
      frameOf({ revision: 5 }),
      frameOf({ kind: 'update', revision: 4, running: true }),
    ]]).source, sessionId),
    /moved its revision backwards/,
  )

  // A first snapshot never inherits a historical done (fresh binding) and it
  // IS the new lineage restart.
  assert.deepEqual(
    await drain(sourceWithWatches([[frameOf({ running: false, outcome: 'done' })]]).source, sessionId),
    [{ kind: 'snapshot', restart: true, running: false, outcome: 'idle' }],
    'a first snapshot is honestly idle',
  )

  // OWNER REVIEW P1: a NEW watch never inherits a terminal state, even when the
  // Host reports the SAME `hostEpoch` + `agentEpoch` (the TUI owner switched away
  // and re-adopted the session while the Host Agent stayed the same instance).
  // Provenance belongs to the interval ONE watch observed, so the re-adopted
  // owner opens on the Host's current running truth and `idle`.
  const reAdopted = sourceWithWatches([
    [frameOf({ running: true, outcome: 'idle', revision: 1 }),
      frameOf({ kind: 'update', running: false, outcome: 'done', revision: 2 })],
    [frameOf({ running: false, outcome: 'done', revision: 3 })],
  ]).source
  assert.deepEqual(await drain(reAdopted, sessionId), [
    { kind: 'snapshot', restart: true, running: true, outcome: 'idle' },
    { kind: 'update', restart: false, running: false, outcome: 'done' },
  ], 'the first watch proves its own done end to end')
  assert.deepEqual(await drain(reAdopted, sessionId),
    [{ kind: 'snapshot', restart: true, running: false, outcome: 'idle' }],
    'a re-adopted owner never inherits the previous owner terminal state')

  // A frame the consumer REJECTS (the owner moved mid-stream) leaves nothing
  // behind: the rejection ends the watch and the next watch still opens idle.
  const crossed = sourceWithWatches([
    [frameOf({ running: true, outcome: 'idle', revision: 1 }),
      frameOf({ kind: 'update', running: false, outcome: 'done', revision: 2 })],
    [frameOf({ running: false, outcome: 'done', revision: 3 })],
  ]).source
  const crossedSeen: RemoteMainProgressFact[] = []
  let stillCurrent = true
  await consumeRemoteTerminalProgress(crossed, sessionId, new AbortController().signal, {
    isCurrent: () => stillCurrent,
    onFact: (fact) => { crossedSeen.push(fact); stillCurrent = false },
  })
  assert.deepEqual(crossedSeen, [{ kind: 'snapshot', restart: true, running: true, outcome: 'idle' }],
    'a fact whose owner moved is never applied')
  assert.deepEqual(await drain(crossed, sessionId),
    [{ kind: 'snapshot', restart: true, running: false, outcome: 'idle' }],
    'a rejected frame leaves no provenance for the next watch')

  const replaced = sourceWithWatches([
    [frameOf({ running: true, outcome: 'idle', revision: 1 })],
    [frameOf({ hostEpoch: 'host-2', running: false, outcome: 'done', revision: 2 })],
  ]).source
  await drain(replaced, sessionId)
  assert.deepEqual(await drain(replaced, sessionId),
    [{ kind: 'snapshot', restart: true, running: false, outcome: 'idle' }],
    'a snapshot of a replaced host/agent epoch never inherits done')

  // A mid-stream hostEpoch change without a snapshot baseline is dropped.
  assert.deepEqual(
    await drain(sourceWithWatches([[
      frameOf({ running: true, outcome: 'idle', revision: 1 }),
      frameOf({ kind: 'update', hostEpoch: 'host-2', running: false, outcome: 'done', revision: 2 }),
    ]]).source, sessionId),
    [{ kind: 'snapshot', restart: true, running: true, outcome: 'idle' }],
    'an unanchored mid-stream hostEpoch change is dropped, not trusted',
  )

  // A new Agent lifetime (agentEpoch grows) is an accepted update that restarts
  // the lineage; a same-epoch accepted update does not.
  assert.deepEqual(
    await drain(sourceWithWatches([[
      frameOf({ running: true, outcome: 'idle', revision: 1 }),
      frameOf({ kind: 'update', agentEpoch: 2, running: true, outcome: 'idle', revision: 2 }),
    ]]).source, sessionId),
    [
      { kind: 'snapshot', restart: true, running: true, outcome: 'idle' },
      { kind: 'update', restart: true, running: true, outcome: 'idle' },
    ],
    'an Agent replacement update restarts the lineage',
  )

  // Transport identity: a generation rollover mid-stream rejects the watch.
  const rollover = { current: {} as unknown }
  await assert.rejects(
    (async () => {
      for await (const _fact of sourceWithWatches([[
        frameOf({ running: true, outcome: 'idle' }),
        frameOf({ kind: 'update', revision: 2, running: false, outcome: 'done' }),
      ]], { generation: rollover }).source.open(sessionId, new AbortController().signal)) {
        rollover.current = {} // the Connection generation rolls over after the first frame
      }
    })(),
    /lost its transport identity/,
  )

  // A missing retained binding refuses to open at all.
  await assert.rejects(
    drain(sourceWithWatches([[frameOf()]], { binding: () => undefined }).source, sessionId),
    /has no retained Session binding/,
  )
})
