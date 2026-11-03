/**
 * M4-B2-S §9 — the split-Client surface composition contracts that do not need
 * a physical terminal.
 *
 * This suite pins:
 *
 * - the `SurfaceReady` / `SurfaceStop` bridge semantics (one-shot readiness,
 *   first-failure wins, exactly-once stop latch) used by the real TUI exit
 *   path;
 * - the surface-mode composition's fail-closed input contract: without the
 *   ONE authenticated transport, the installed DSH anchor, the authenticated
 *   fetch or the process runner mount, startup rejects loudly instead of
 *   fabricating a Domain/UI/runner graph;
 * - the runner's startup-settlement split: Direct keeps its frozen
 *   pending-startup behavior, while a split-Client override missing the
 *   Client-local `tuiStartup` service fails instead of returning a fake ready.
 *
 * EVIDENCE LEVEL: unit / composition contract. The real tty mount, renderer,
 * Session open and prompt round trip are proven by the split-process smoke
 * (`scripts/split-process-smoke.mjs`, T27+) and the PTY integration suite; a
 * structural fake here never claims a real wire.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-client-surface.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import { Config as TuiConfigSchema } from '../../src/app/config/schema.ts'
import { startLocalClient, observeHandoffOpen, SurfaceRevisionTasks } from '../../src/app/remote-process/client-bootstrap.ts'
import { createLocalClientSurfaceBridge } from '../../src/app/remote-process/local-client-surface.ts'
import type { LocalClientTransport } from '../../src/app/remote-process/local-transport.ts'
import type { LocalInstanceRecord } from '../../src/app/remote-process/local-discovery.ts'

const HOST_RECORD = {
  scopeId: 'scope',
  profileRealpath: '/profile',
  instanceId: 'instance',
  hostPid: 1,
  hostStarttime: '1',
  origin: 'http://127.0.0.1:1',
  protocol: 'dsh-pi-tui/local/1',
  bundleVersion: '0.5.4',
  dshVersion: '0.2.1-rc.4',
  buildId: 'build',
} as LocalInstanceRecord

/** A structural transport; the surface input checks only its presence. */
const TRANSPORT = {
  status: () => ({ transport: 'connected' as const, activeWrappers: 1, liveSockets: 1 }),
  authenticatedFetch: async () => new Response(null, { status: 204 }),
  dropWebSocketsForQualification: () => {},
  dispose: async () => {},
} as unknown as LocalClientTransport

const RUNNER = {
  ready: Promise.resolve(),
  stopped: new Promise<number>(() => {}),
  dispose: async () => {},
}

test('the surface bridge settles readiness once, keeps the first failure, and stops once', async () => {
  {
    const codes: number[] = []
    const bridge = createLocalClientSurfaceBridge(code => { codes.push(code) })
    bridge.markMounted()
    bridge.markMounted()
    bridge.fail(new Error('late failure must not resurrect or reject a mounted surface'))
    await bridge.ready
    assert.deepEqual(codes, [], 'a mounted surface never requests a stop by itself')
  }
  {
    const bridge = createLocalClientSurfaceBridge(() => {})
    const failure = new Error('startup failure')
    bridge.fail(failure)
    bridge.markMounted()
    await assert.rejects(bridge.ready, error => error === failure,
      'the FIRST startup failure must surface by identity')
  }
  {
    const codes: number[] = []
    const bridge = createLocalClientSurfaceBridge(code => { codes.push(code) })
    bridge.requestStop(0)
    bridge.requestStop(130)
    assert.deepEqual(codes, [0], 'the SurfaceStop latch runs exactly once for the FIRST exit request')
    assert.equal(await bridge.stopped, 0, 'the stopped latch reports the first exit code')
  }
})

test('surface mode rejects every missing composition input before mounting any graph', async () => {
  const context = new Context()
  try {
    await assert.rejects(
      startLocalClient(context, {}, undefined, { mode: 'surface' }),
      /surface mode requires the official transport and the authenticated Host/u,
    )
    await assert.rejects(
      startLocalClient(context, {}, undefined, {
        mode: 'surface',
        transport: TRANSPORT,
        host: HOST_RECORD,
      }),
      /surface mode requires the installed DSH anchor/u,
    )
    await assert.rejects(
      startLocalClient(context, {}, undefined, {
        mode: 'surface',
        transport: TRANSPORT,
        host: HOST_RECORD,
        dshAnchor: '/installed/dsh/package.json',
      }),
      /surface mode requires the authenticated Host fetch/u,
    )
    await assert.rejects(
      startLocalClient(context, {}, undefined, {
        mode: 'surface',
        transport: TRANSPORT,
        host: HOST_RECORD,
        dshAnchor: '/installed/dsh/package.json',
        authenticatedFetch: async () => new Response(null, { status: 204 }),
      }),
      /surface mode requires the process composition runner mount/u,
    )
    await assert.rejects(
      startLocalClient(context, {}, undefined, {
        mode: 'bogus' as never,
        transport: TRANSPORT,
        host: HOST_RECORD,
      }),
      /unknown Client mode/u,
    )
    // None of the rejected calls mounted a Domain or Client UI service.
    assert.equal(context.reflect.get('sessions'), undefined)
    assert.equal(context.reflect.get('tuiStartup'), undefined)
  } finally {
    await context.fiber.dispose()
  }
})

test('the runner startup-settlement split keeps Direct pending but fails a split-Client override without tuiStartup', () => {
  const context = new Context()
  context.provide('appExit', () => {})
  try {
    const config = TuiConfigSchema({} as never)
    const override = {
      selected: { kind: 'remote', backend: { kind: 'remote' } },
      presentation: {},
      extensionService: {},
    } as never
    // Direct: the loader row keeps ownership of the pending startup service.
    assert.doesNotThrow(() => applyRunnerWithRuntime(context, config, undefined))
    // Split Client: a missing Client-local tuiStartup is a composition break,
    // never a fabricated ready surface.
    assert.throws(
      () => applyRunnerWithRuntime(context, config, override),
      /requires the Client-local tuiStartup service/u,
    )
    // The missing appExit precondition stays loud on both branches.
    const withoutExit = new Context()
    try {
      assert.throws(
        () => applyRunnerWithRuntime(withoutExit, config, override),
        /must provide ctx.appExit/u,
      )
    } finally {
      void withoutExit.fiber.dispose()
    }
  } finally {
    void context.fiber.dispose()
  }
})

test('the process composition entry owns exactly one lazy bootstrap import after PluginPackages', async () => {
  const source = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../../src/app/remote-process/local-client-entry.ts', import.meta.url), 'utf8'))
  const dynamicImports = [...source.matchAll(/await import\('([^']+)'\)/gu)].map(match => match[1])
  const bootstrapImports = dynamicImports.filter(specifier => specifier === '../bootstrap.ts')
  assert.equal(bootstrapImports.length, 1, 'the split process must carry exactly ONE dynamic bootstrap import')
  assert.ok(source.indexOf('await import(\'../bootstrap.ts\')') > source.indexOf('PluginPackages'),
    'the lazy bootstrap import must execute after the official PluginPackages mount')
  assert.doesNotMatch(source.replace(/await import\('\.\.\/bootstrap\.ts'\)/u, ''),
    /import\s*\{[^}]*\}\s*from\s*'\.\.\/bootstrap\.ts'/u,
    'the bootstrap facade must never become a static import of the process entry')
})

test('surface revision tasks run strictly serially and a stop waits for the active task', async () => {
  const slot = new SurfaceRevisionTasks()
  const order: string[] = []
  let releaseFirst: (() => void) | undefined
  const first = slot.run(async () => {
    order.push('first:start')
    await new Promise<void>(resolve => { releaseFirst = resolve })
    order.push('first:end')
  })
  const second = slot.run(async () => {
    order.push('second:start')
    order.push('second:end')
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(order, ['first:start'], 'a second revision task overlapped the active one')
  releaseFirst?.()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end'])
  const settled = slot.drain()
  assert.equal(await Promise.resolve(settled).then(() => true), true, 'settle did not resolve after the tail')
})

test('a failed surface revision task does not poison the serial slot', async () => {
  const slot = new SurfaceRevisionTasks()
  const failure = new Error('revision mount failed')
  const failed = slot.run(async () => { throw failure })
  await assert.rejects(failed, error => error === failure)
  let ran = false
  await slot.run(async () => { ran = true })
  assert.equal(ran, true, 'a later revision task did not run after the failed one settled')
  await slot.drain()
})

/** Minimal live-source probe for ONE handoff restore proof. */
class HandoffProbe {
  transport: 'connected' | 'connecting' | 'disconnected' = 'connected'
  generationId: number | undefined = 1
  mounted = true
  openState: 'cold' | 'loading' | 'open' | 'error' = 'open'
  listed: string[] = []
  owned: string | undefined
  bindingObject: {
    session: { getSnapshot(): { openState: string }; subscribe(listener: () => void): () => void }
  } | undefined

  private readonly listListeners = new Set<() => void>()
  private readonly retainListeners = new Set<() => void>()
  private readonly sessionListeners = new Set<() => void>()
  private readonly generationListeners = new Set<() => void>()

  constructor(sessionId?: string) {
    if (sessionId !== undefined) {
      this.listed = [sessionId]
      this.owned = sessionId
      this.mountBinding()
    }
  }

  mountBinding(): void {
    this.bindingObject = {
      session: {
        getSnapshot: (): { openState: string } => ({ openState: this.openState }),
        subscribe: (listener: () => void): (() => void) => {
          this.sessionListeners.add(listener)
          return () => { this.sessionListeners.delete(listener) }
        },
      },
    }
  }

  notify(kind: 'list' | 'retain' | 'session' | 'generation'): void {
    const listeners = kind === 'list'
      ? this.listListeners
      : kind === 'retain'
        ? this.retainListeners
        : kind === 'session'
          ? this.sessionListeners
          : this.generationListeners
    for (const listener of [...listeners]) listener()
  }

  readonly sources = {
    sessions: {
      list: {
        getSnapshot: (): { ids: readonly string[] } => ({ ids: this.listed }),
        subscribe: (listener: () => void): (() => void) => {
          this.listListeners.add(listener)
          return () => { this.listListeners.delete(listener) }
        },
      },
      retainInfo: (id: string) => ({
        getSnapshot: (): { retainedBy: { tuiMainView?: number } } => ({ retainedBy: { tuiMainView: this.owned === id ? 1 : 0 } }),
        subscribe: (listener: () => void): (() => void) => {
          this.retainListeners.add(listener)
          return () => { this.retainListeners.delete(listener) }
        },
      }),
      binding: (id: string) => this.listed.includes(id) ? this.bindingObject : undefined,
    },
    transport: {
      status: () => ({
        transport: this.transport,
        ...(this.generationId === undefined ? {} : { generationId: this.generationId }),
      }),
      connection: {
        generation: {
          subscribe: (listener: () => void): (() => void) => {
            this.generationListeners.add(listener)
            return () => { this.generationListeners.delete(listener) }
          },
        },
      },
    },
    surfaceMounted: () => this.mounted,
  }
}

test('a handoff restore succeeds only from a current official Session history open', async () => {
  // Sessionless: nothing was open and the proof must not create one.
  {
    const probe = new HandoffProbe()
    await observeHandoffOpen(probe.sources)
    probe.listed = ['s-1']
    probe.owned = 's-1'
    probe.mountBinding()
    probe.notify('list')
    await assert.rejects(observeHandoffOpen(probe.sources), /sessionless Client handoff opened a new Session/u)
  }
  // Session: cold/loading are not success; the official 'open' settlement is.
  {
    const probe = new HandoffProbe('s-1')
    probe.openState = 'cold'
    const pending = observeHandoffOpen(probe.sources, 's-1')
    probe.openState = 'loading'
    probe.notify('session')
    probe.openState = 'open'
    probe.notify('session')
    await pending
  }
  // The official history open failure is terminal.
  {
    const probe = new HandoffProbe('s-1')
    probe.openState = 'error'
    await assert.rejects(observeHandoffOpen(probe.sources, 's-1'), /Session history open failed/u)
  }
  // Another Session becoming the visible owner is not the expected restore.
  {
    const probe = new HandoffProbe('s-1')
    probe.openState = 'cold'
    const pending = observeHandoffOpen(probe.sources, 's-1')
    probe.listed = ['s-1', 's-2']
    probe.owned = 's-2'
    probe.notify('list')
    await assert.rejects(pending, /opened a different Session/u)
  }
  // A transport generation rollover invalidates the proof.
  {
    const probe = new HandoffProbe('s-1')
    probe.openState = 'cold'
    const pending = observeHandoffOpen(probe.sources, 's-1')
    probe.generationId = 2
    probe.notify('generation')
    await assert.rejects(pending, /transport generation changed/u)
  }
  // A same-id generation replacement is not the retained binding.
  {
    const probe = new HandoffProbe('s-1')
    probe.openState = 'cold'
    const pending = observeHandoffOpen(probe.sources, 's-1')
    probe.mountBinding()
    probe.openState = 'open'
    probe.notify('session')
    await assert.rejects(pending, /Session ownership changed/u)
  }
  // Other official reference sources (gateway/controllerOperation/tuiChildView)
  // may legitimately retain a binding while the main TUI stays sessionless.
  // `tuiMainView` is the authority, not the mere existence of a binding.
  {
    const otherReference = new HandoffProbe()
    otherReference.listed = ['s-1']
    otherReference.mountBinding()
    assert.equal(otherReference.owned, undefined)
    const proof = await observeHandoffOpen(otherReference.sources)
    assert.equal(proof.sessionId, undefined)
    proof.verify()
  }
  // A sessionless proof needs a real mounted surface on a connected transport.
  {
    const unmounted = new HandoffProbe()
    unmounted.mounted = false
    await assert.rejects(observeHandoffOpen(unmounted.sources), /surface is not mounted/u)
    const disconnected = new HandoffProbe('s-1')
    disconnected.transport = 'connecting'
    disconnected.generationId = undefined
    await assert.rejects(observeHandoffOpen(disconnected.sources, 's-1'), /no connected official transport generation/u)
  }
  // Cancellation is never a success.
  {
    const probe = new HandoffProbe('s-1')
    probe.openState = 'cold'
    const controller = new AbortController()
    const pending = observeHandoffOpen(probe.sources, 's-1', controller.signal)
    controller.abort()
    await assert.rejects(pending, /aborted/u)
  }
})

test('a settled handoff proof is re-verified immediately before the success claim', async () => {
  // A Connection rollover after the proof settles but before the claim is a
  // refusal: the new generation has not proven the Session history itself.
  {
    const probe = new HandoffProbe('s-1')
    const proof = await observeHandoffOpen(probe.sources, 's-1')
    assert.equal(proof.generationId, 1)
    assert.equal(proof.sessionId, 's-1')
    proof.verify()
    probe.generationId = 2
    assert.throws(() => proof.verify(), /generation changed after the handoff restore proof/u)
  }
  // The same generation must still have the exact Session history open and
  // the same official owner/binding.
  {
    const probe = new HandoffProbe('s-1')
    const proof = await observeHandoffOpen(probe.sources, 's-1')
    probe.openState = 'cold'
    assert.throws(() => proof.verify(), /history is no longer open/u)
    probe.openState = 'open'
    probe.owned = undefined
    assert.throws(() => proof.verify(), /no longer owns the restored Session/u)
    probe.owned = 's-1'
    probe.bindingObject = undefined
    assert.throws(() => proof.verify(), /binding changed after the handoff restore proof/u)
  }
  // A replacement binding under the SAME id and transport generation is not
  // the generation this proof settled on, even when the new binding is open.
  {
    const probe = new HandoffProbe('s-1')
    const proof = await observeHandoffOpen(probe.sources, 's-1')
    probe.mountBinding()
    assert.throws(() => proof.verify(), /binding changed after the handoff restore proof/u)
  }
  // Sessionless: a Session that appears after the proof is a refusal.
  {
    const probe = new HandoffProbe()
    const proof = await observeHandoffOpen(probe.sources)
    assert.equal(proof.sessionId, undefined)
    probe.listed = ['s-1']
    probe.owned = 's-1'
    probe.mountBinding()
    assert.throws(() => proof.verify(), /Session opened after the sessionless handoff restore proof/u)
  }
  // A non-main-view binding appearing after a sessionless proof does not turn
  // the TUI into a session-owning surface: tuiMainView still owns nothing.
  {
    const probe = new HandoffProbe()
    const proof = await observeHandoffOpen(probe.sources)
    probe.listed = ['s-1']
    probe.mountBinding()
    assert.equal(probe.owned, undefined)
    proof.verify()
  }
  // A surface that retires after the proof is a refusal.
  {
    const probe = new HandoffProbe('s-1')
    const proof = await observeHandoffOpen(probe.sources, 's-1')
    probe.mounted = false
    assert.throws(() => proof.verify(), /surface is no longer mounted/u)
  }
})
