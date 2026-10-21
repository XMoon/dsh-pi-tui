/**
 * M3-6 PR3 — Remote shutdown / HMR / mounted-fatal teardown qualification (L6).
 *
 * The decisive same-process teardown proofs over the REAL Remote runner
 * composition (the same production-equivalent graph the other `runner-remote-*`
 * suites mount): a clean unload + same-process remount, a partial surface
 * disposer failure that must not truncate the root teardown, and a mounted
 * startup fatal that must enter the SAME surface cleanup authority before
 * retirement/transport.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - ordinary Host Context / existing base composition
 * - one canonical Remote application aggregate
 * - official generated Client / Connection / Remote namespaces
 * - real selected Remote Backend / owner pair
 * - real SurfaceRuntime + TuiApp runner composition
 * - real Session retirement owner
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - headless terminal/output seams already used by runner harness
 * - deterministic diagnostics/exit capture where necessary
 * - explicit fault injection into one existing production callback
 *
 * DELIBERATELY ABSENT
 * - no public Remote selector
 * - no second Client/Host graph
 * - no fake shutdown manager
 * @module @xmoon76/dsh-pi-tui/runner-remote-shutdown.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../../src/index.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../../src/app/application-runtime.ts'
import type { SessionOwnerRetirement } from '../../src/app/session/owner-access.ts'
import { createRemoteApplicationRuntime } from '../../src/app/remote/runtime.ts'
import { CatalogRefreshCoordinator } from '../../src/app/command/catalog-refresh.ts'
import { liveTuiCountForTest } from '../../src/tui/process-slot.ts'
import { waitFor } from '../support/remote-application-fixture.ts'
import { assertTransportTeardownOnce, observeTransportDisposal, type TransportDisposalObserver } from '../support/transport-disposal-observer.ts'
import { ownTransportTeardown } from '../support/transport-teardown-ownership.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/**
 * A scripted streaming LLM adapter (the proven M3-4 PR3 shape): the Host emits
 * REAL agent events, the wire forwards them, only the model itself is synthetic.
 */
class StubStreamingLlmAdapter extends (await import('@deepseek-ai/dsh-llm')).LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'remote reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'remote reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type HostFixture = Awaited<ReturnType<typeof import('../support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>
type RemoteAggregate = Awaited<ReturnType<typeof createRemoteApplicationRuntime>>

async function mountHost(life: TestLifecycle, presetId: string): Promise<HostFixture> {
  const { createRemoteApplicationHostFixture } = await import('../support/remote-application-fixture.ts')
  return createRemoteApplicationHostFixture(life, presetId, { llmAdapter: new StubStreamingLlmAdapter() })
}

/** Route production ProcessTerminal instances into the shared xterm. */
function virtualTerminal(life: TestLifecycle): VirtualTerminal {
  const vt = new VirtualTerminal(110, 32)
  life.defer(installVirtualProcessTerminal(vt))
  return vt
}

/** Collect every TuiApp the runner mounts (the latest is the live one). */
function instrumentTuiApps(life: TestLifecycle): { readonly apps: unknown[] } {
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  return { apps }
}

/**
 * Wrap the aggregate's OWN retirement + transport disposal BEFORE the runner
 * adopts it, so the observed order is the production path's, not a timing guess.
 *
 * The transport's teardown is observed by the SHARED observer
 * (`test/support/transport-disposal-observer.ts`): it records, per downstream
 * owner, the CALLS of that owner's disposer and the RELEASES that COMPLETED.
 * A total cannot tell "one owner twice, one owner never" from "every owner
 * once", so the counts are kept per owner.
 */
function instrumentAggregate(
  aggregate: RemoteAggregate,
  observed: string[],
): { readonly transport: TransportDisposalObserver } {
  const retirement: SessionOwnerRetirement = aggregate.selected.retirement
  const originalRetire = retirement.retire.bind(retirement)
  retirement.retire = async (owner, mode) => {
    const report = await originalRetire(owner, mode)
    observed.push('retirement-settled')
    return report
  }
  const originalRetireParked = retirement.retireParked.bind(retirement)
  retirement.retireParked = async () => {
    const report = await originalRetireParked()
    observed.push('retirement-settled')
    return report
  }
  return { transport: observeTransportDisposal(aggregate, observed) }
}

interface ShutdownFixture {
  readonly host: HostFixture
  readonly aggregate: RemoteAggregate
  app(): {
    stop(): void
    setDraft(text: string): void
    submitDraft(request?: string): void
    getDraft(): string
    getSurfaceGeneration(): number
  }
  runnerFiberDispose(): Promise<void>
  /**
   * The transport fallback, as the lifecycle cleanup runs it: it disposes the
   * transport ONLY when the runner never released it, and it does NOT swallow
   * a failure — the lifecycle collects the failure and reports it.
   *
   * It is exposed so a case can prove the fallback's failure handling
   * directly, instead of inferring it from a teardown that happened to fail.
   */
  runTransportFallback(): Promise<void>
}

/** Mount the production-equivalent Remote runner over an aggregate. */
async function mountShutdownRunner(
  life: TestLifecycle,
  apps: unknown[],
  options: {
    readonly host: HostFixture
    readonly presetId: string
    readonly resumeSessionId: string
    readonly appExit?: (code: number) => void
    readonly beforeMount?: (aggregate: RemoteAggregate) => void
    /** Runs after the runner fiber has mounted — the seam for a case that
     *  must change the aggregate only once the mount is complete. */
    readonly afterMount?: (aggregate: RemoteAggregate) => void
  },
): Promise<ShutdownFixture> {
  const { host } = options
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: options.resumeSessionId },
  })
  // The transport ownership: the RUNNER FIBER's teardown effect disposes the
  // transport, and the aggregate fallback covers the case where the runner
  // never mounted. See `test/support/transport-teardown-ownership.ts`.
  //
  // The fallback is registered right after the aggregate exists and BEFORE any
  // setup step that can reject, so a mount that never completed is still
  // covered. It is AWAITED: a fire-and-forget teardown would let the
  // lifecycle remove the temp directories while the transport was still being
  // disposed, and a FAILED fallback is NOT swallowed — the lifecycle collects
  // the failure and reports it.
  const ownership = ownTransportTeardown(aggregate.selected)
  life.defer(ownership.runFallback)
  options.beforeMount?.(aggregate)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  host.ctx.provide('appExit', options.appExit ?? ((): void => {}))
  const { TUI_STARTUP_SERVICE } = await import('../../src/startup.ts')
  host.ctx.provide(TUI_STARTUP_SERVICE, {
    sessionId: options.resumeSessionId,
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
  }
  const fiber = host.ctx.plugin(pluginCtx => {
    applyRunnerWithRuntime(
      pluginCtx,
      TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never),
      override,
    )
  })
  // The RUNNER cleanup, registered here — after the fiber exists and BEFORE
  // the mount await that can reject — so a mount that never completed is
  // still torn down. It is AWAITED, so the runner's own teardown (the surface
  // stop, the Session retirement and the transport disposal) settles before
  // the lifecycle moves on to the environment restoration: the cleanup runs
  // FIRST under the lifecycle's reverse registration order, which is the
  // acquisition/release order the runner had.
  life.defer(async (): Promise<void> => {
    await fiber.dispose()
  })
  await fiber
  options.afterMount?.(aggregate)
  return {
    host,
    aggregate,
    app: () => apps.at(-1) as never,
    runnerFiberDispose: async () => { await fiber.dispose() },
    runTransportFallback: ownership.runFallback,
  }
}

function submitDraft(fixture: ShutdownFixture, text: string): void {
  const app = fixture.app()
  app.setDraft(text)
  app.submitDraft()
}

function hostUserRows(fixture: ShutdownFixture, sessionId: string): string[] {
  const session = fixture.host.ctx.sessions.get(SessionId(sessionId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => {
      const raw = event.data as {
        message?: { content?: Array<{ type: string; text?: string }> }
        content?: Array<{ type: string; text?: string }>
      }
      const content = raw.message?.content ?? raw.content ?? []
      return content.map(block => block.type === 'text' ? block.text ?? '' : '[image]').join('')
    })
}

function diagLogOf(host: HostFixture): string {
  return readFileSync(join(host.workRoot, 'logs', `pi-tui-${process.pid}.log`), 'utf8')
}

/* ── L6-A ──────────────────────────────────────────────────────────────── */

test('a mounted Remote runner unloads totally and a fresh runner mounts in the same process', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-6-pr3-shutdown-preset'
  const vt = virtualTerminal(life)
  const { apps } = instrumentTuiApps(life)
  const observed: string[] = []
  const originalStop = TuiApp.prototype.stop
  t.mock.method(TuiApp.prototype, 'stop', function (this: TuiApp) {
    observed.push('surface-stop')
    return originalStop.call(this)
  })

  // Runner A: a resumed Remote session with a live owner.
  const hostA = await mountHost(life, presetId)
  const mainA = 'm3-6-pr3-shutdown-a'
  await hostA.harness.create(SessionId(mainA), { provider: 'smoke', model: 'smoke' }, { cwd: hostA.anchorDir })
  let transportA: TransportDisposalObserver | undefined
  const fixtureA = await mountShutdownRunner(life, apps, {
    host: hostA,
    presetId,
    resumeSessionId: mainA,
    beforeMount: (aggregate) => {
      transportA = instrumentAggregate(aggregate, observed).transport
    },
  })
  await waitFor('runner A paint', () => vt.getViewport().join('').length > 0, 20_000)
  assert.equal(liveTuiCountForTest(), 1, 'runner A mounted and owns the process TUI slot')

  await fixtureA.runnerFiberDispose()
  assert.ok(transportA !== undefined, 'the transport observer was installed')
  assertTransportTeardownOnce(transportA,
    'every Remote owner was reached once and RELEASED once: Client UI subtree, task watch, adapters, official Client, Host additive runtime')
  assert.ok((transportA?.calls() ?? 0) >= 1,
    'the teardown really reached the transport disposer (the release was not inferred)')
  assert.ok(observed.includes('surface-stop'), 'the mounted surface terminal stop was observed')
  assert.ok(observed.includes('retirement-settled'), 'the Session retirement settled')
  assert.ok(observed.includes('transport-dispose'), 'the transport disposal was observed')
  assert.ok(observed.indexOf('surface-stop') < observed.indexOf('retirement-settled'),
    'observed order: surface terminal stop precedes the Session retirement settlement')
  assert.ok(observed.indexOf('retirement-settled') < observed.indexOf('transport-dispose'),
    'observed order: the Session retirement settlement precedes the transport disposal')
  assert.equal(liveTuiCountForTest(), 0, 'the completed teardown released the process TUI slot')

  // Runner B: a FRESH aggregate over a fresh Host context in the SAME process.
  const hostB = await mountHost(life, presetId)
  const mainB = 'm3-6-pr3-shutdown-b'
  await hostB.harness.create(SessionId(mainB), { provider: 'smoke', model: 'smoke' }, { cwd: hostB.anchorDir })
  let transportB: TransportDisposalObserver | undefined
  const fixtureB = await mountShutdownRunner(life, apps, {
    host: hostB,
    presetId,
    resumeSessionId: mainB,
    beforeMount: (aggregate) => { transportB = instrumentAggregate(aggregate, observed).transport },
  })
  await waitFor('runner B mounts', () => liveTuiCountForTest() === 1, 20_000)
  // One basic Remote read/presentation path: a submission reaches the Host
  // durably AND the optimistic echo is painted on the remounted surface.
  submitDraft(fixtureB, 'post-remount marker phi')
  await waitFor('runner B write commits on the Host', () => hostUserRows(fixtureB, mainB).some(row => row.includes('post-remount marker phi')), 20_000)
  await waitFor('runner B paints the submission', () => vt.getViewport().join('').includes('post-remount marker phi'), 20_000)
  // A genuine REMOTE READ on the remounted surface: the Host-produced model
  // reply reaches the Client transcript through the official wire.
  await waitFor('runner B renders the Host reply through the Remote read',
    () => vt.getViewport().join('').includes('remote reply'), 20_000)

  await fixtureB.runnerFiberDispose()
  assert.ok(transportB !== undefined, 'the transport observer was installed')
  assertTransportTeardownOnce(transportB, 'runner B released each of its five transport owners exactly once')
  assert.ok((transportB?.calls() ?? 0) >= 1,
    'the teardown really reached the transport disposer (the release was not inferred)')
  assert.equal(liveTuiCountForTest(), 0, 'runner B unloads cleanly too')
})

/* ── L6-B ──────────────────────────────────────────────────────────────── */

test('a throwing real generation unsubscribe cannot truncate the root teardown', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-6-pr3-shutdown-preset'
  const vt = virtualTerminal(life)
  const { apps } = instrumentTuiApps(life)
  const observed: string[] = []
  const originalStop = TuiApp.prototype.stop
  t.mock.method(TuiApp.prototype, 'stop', function (this: TuiApp) {
    observed.push('surface-stop')
    return originalStop.call(this)
  })

  const host = await mountHost(life, presetId)
  const mainId = 'm3-6-pr3-shutdown-b-partial'
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const failure = new Error('m3-6-pr3 generation unsubscribe exploded')
  let generationUnsubscribes = 0
  let transport: TransportDisposalObserver | undefined
  // Observe the PRODUCTION coordinator disposal directly (a call-through
  // prototype observer — no product hook). The old held-read signal abort was
  // NOT discriminating: bootstrap aborts the lifecycle BEFORE disposeCatalog,
  // and the reader's signal is AbortSignal.any([lifecycleSignal, controller]).
  const originalCoordinatorDispose = CatalogRefreshCoordinator.prototype.dispose
  const coordinatorDisposals: CatalogRefreshCoordinator[] = []
  t.mock.method(CatalogRefreshCoordinator.prototype, 'dispose', function (this: CatalogRefreshCoordinator) {
    coordinatorDisposals.push(this)
    return originalCoordinatorDispose.call(this)
  })
  const fixture = await mountShutdownRunner(life, apps, {
    host,
    presetId,
    resumeSessionId: mainId,
    beforeMount: (aggregate) => {
      transport = instrumentAggregate(aggregate, observed).transport
      // Install the REAL generation unsubscribe, then wrap it so it runs the
      // real release first, records it, and throws — the partial surface
      // disposer the root teardown must survive.
      const commandSource = aggregate.presentation.commandSource
      const originalSubscribe = commandSource.subscribeConnectionGeneration.bind(commandSource)
      commandSource.subscribeConnectionGeneration = (listener) => {
        const realUnsubscribe = originalSubscribe(listener)
        return () => {
          realUnsubscribe()
          generationUnsubscribes += 1
          throw failure
        }
      }
    },
  })
  await waitFor('runner paint', () => vt.getViewport().join('').length > 0, 20_000)

  await fixture.runnerFiberDispose()

  assert.equal(generationUnsubscribes, 1, 'the real generation unsubscribe executed exactly once')
  assert.equal(coordinatorDisposals.length, 1,
    'the production catalog coordinator disposed exactly once despite the throwing unsubscribe')
  assert.ok(transport !== undefined, 'the transport observer was installed')
  assertTransportTeardownOnce(transport, 'the selected transport released each of its five owners exactly once')
  assert.ok((transport?.calls() ?? 0) >= 1,
    'the teardown really reached the transport disposer (the release was not inferred)')
  assert.ok(observed.includes('surface-stop'), 'later surface/TuiApp cleanup executed')
  assert.ok(observed.includes('retirement-settled'), 'the Session retirement executed/settled')
  assert.ok(observed.indexOf('surface-stop') < observed.indexOf('retirement-settled'))
  assert.ok(observed.indexOf('retirement-settled') < observed.indexOf('transport-dispose'))
  assert.equal(liveTuiCountForTest(), 0,
    'TuiApp itself completed and released the process TUI slot despite the surface failure')
  assert.match(diagLogOf(host), /surface dispose failed/,
    'the surface disposal failure was observed/logged')

  // A same-process replacement runner can still mount.
  const hostB = await mountHost(life, presetId)
  const mainB = 'm3-6-pr3-shutdown-b-replacement'
  await hostB.harness.create(SessionId(mainB), { provider: 'smoke', model: 'smoke' }, { cwd: hostB.anchorDir })
  const fixtureB = await mountShutdownRunner(life, apps, { host: hostB, presetId, resumeSessionId: mainB })
  await waitFor('replacement runner mounts', () => liveTuiCountForTest() === 1, 20_000)
  await fixtureB.runnerFiberDispose()
  assert.equal(liveTuiCountForTest(), 0, 'the replacement runner unloads cleanly')
})

/* ── L6-C ──────────────────────────────────────────────────────────────── */

test('a mounted startup fatal uses the same surface cleanup authority before retirement/transport', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-6-pr3-shutdown-preset'
  const vt = virtualTerminal(life)
  const { apps } = instrumentTuiApps(life)
  const observed: string[] = []
  const exitCodes: number[] = []

  const host = await mountHost(life, presetId)
  const mainId = 'm3-6-pr3-shutdown-c-fatal'
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  // The injected fatal fires AFTER surface.start() mounted the real TuiApp and
  // enabled focus reporting: settings.applyBootDisplay() invokes it.
  const failure = new Error('m3-6-pr3 mounted fatal probe')
  t.mock.method(TuiApp.prototype, 'setWheelScrollLines', () => { throw failure })
  const originalStop = TuiApp.prototype.stop
  t.mock.method(TuiApp.prototype, 'stop', function (this: TuiApp) {
    observed.push('surface-stop')
    return originalStop.call(this)
  })

  let transport: TransportDisposalObserver | undefined
  const fixture = await mountShutdownRunner(life, apps, {
    host,
    presetId,
    resumeSessionId: mainId,
    appExit: (code) => { exitCodes.push(code) },
    beforeMount: (aggregate) => { transport = instrumentAggregate(aggregate, observed).transport },
  })

  await waitFor('the fatal path exits once', () => exitCodes.length === 1, 20_000)
  assert.deepEqual(exitCodes, [1], 'the fatal startup path exits exactly once with code 1')
  assert.ok(transport !== undefined, 'the transport observer was installed')
  assertTransportTeardownOnce(transport, 'when retirement settles, the Remote transport released each of its five owners exactly once')
  assert.ok((transport?.calls() ?? 0) >= 1,
    'the teardown really reached the transport disposer (the release was not inferred)')
  assert.ok(observed.includes('surface-stop'), 'the shared cleanup authority disposed the mounted TuiApp')
  assert.ok(observed.indexOf('surface-stop') < observed.indexOf('retirement-settled'),
    'observed order: surface cleanup precedes the Session retirement')
  assert.ok(observed.indexOf('retirement-settled') < observed.indexOf('transport-dispose'),
    'observed order: the Session retirement settles before the transport disposal')
  assert.equal(liveTuiCountForTest(), 0, 'the shared cleanup released the process TUI slot')

  // The ORIGINAL injected fatal error is the reported reason.
  const log = diagLogOf(host)
  assert.match(log, /m3-6-pr3 mounted fatal probe/, 'the injected fatal is the reported reason')
  assert.match(log, /fatal/, 'the fatal observation was logged')

  // No duplicate surface cleanup from the later fiber disposal (the `cleanedUp`
  // latch): the shared authority ran once. (The aggregate's own
  // `disposeTransport` is latched/idempotent, so a later call is a no-op
  // effect; the observed CALL above is the fatal path's exactly-once
  // disposal.)
  const stopsAfterFatal = observed.filter(entry => entry === 'surface-stop').length
  await fixture.runnerFiberDispose()
  assert.equal(observed.filter(entry => entry === 'surface-stop').length, stopsAfterFatal,
    'a later fiber disposal does not re-run the surface cleanup')
})

/* ── L6-D ──────────────────────────────────────────────────────────────── */

/**
 * TERMINAL fail-closed L6 (LAST test in this file): a REAL `TuiApp.dispose()`
 * failure must not strand the later SurfaceRuntime releases, and the process
 * TUI slot must stay CLAIMED. node:test runs each file in its own process, so
 * leaving the slot claimed here cannot poison another test file; nothing after
 * this test in this file may start a TUI.
 */
test('a throwing mounted TuiApp.dispose() neither strands the later plugin/theme/extension releases nor releases the slot', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-6-pr3-shutdown-preset'
  const vt = virtualTerminal(life)
  const { apps } = instrumentTuiApps(life)
  const observed: string[] = []

  const host = await mountHost(life, presetId)
  const mainId = 'm3-6-pr3-shutdown-d-dispose-failure'
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  let transport: TransportDisposalObserver | undefined
  // Call-through observers on the THREE intermediate/terminal surface-owned
  // releases (plugin-keybinding sync lease, theme-unload hook lease, extension
  // bridge detach), wrapping each REAL returned release before the mount
  // acquires it. The final detach alone cannot prove the earlier two ran.
  let keybindingSyncReleases = 0
  let themeHookReleases = 0
  let detachCalls = 0
  const fixture = await mountShutdownRunner(life, apps, {
    host,
    presetId,
    resumeSessionId: mainId,
    beforeMount: (aggregate) => {
      transport = instrumentAggregate(aggregate, observed).transport
      const service = aggregate.clientUi.extensionService as unknown as {
        keybindings: { subscribe(listener: () => void): () => void }
        setThemeUnloadedHook(hook: (unloaded: { selectableValue: string; name: string }) => void): () => void
        detachSurface(surfaceId?: string): void
      }
      const registry = service.keybindings
      const originalSubscribe = registry.subscribe.bind(registry)
      registry.subscribe = (listener: () => void): (() => void) => {
        const release = originalSubscribe(listener)
        return () => { keybindingSyncReleases += 1; release() }
      }
      const originalSetHook = service.setThemeUnloadedHook.bind(service)
      service.setThemeUnloadedHook = (hook): (() => void) => {
        const release = originalSetHook(hook)
        return () => { themeHookReleases += 1; release() }
      }
      const originalDetach = service.detachSurface.bind(service)
      service.detachSurface = (surfaceId?: string): void => { detachCalls += 1; originalDetach(surfaceId) }
    },
  })
  await waitFor('runner paint', () => vt.getViewport().join('').length > 0, 20_000)

  const app = fixture.app()
  const generationBefore = app.getSurfaceGeneration()
  // Inject the failure at TuiApp.dispose() ITSELF: `stop()` runs its REAL
  // cleanup call-through and THEN throws, so the failure lands inside
  // `TuiApp.dispose()`'s own non-truncating batch (not at a pre-dispose
  // SurfaceRuntime step). Patched AFTER the mount so startup is unaffected.
  const failure = new Error('m3-6-pr3 TuiApp final dispose failed')
  const originalStop = TuiApp.prototype.stop
  t.mock.method(TuiApp.prototype, 'stop', function (this: TuiApp) {
    observed.push('surface-stop')
    originalStop.call(this)
    throw failure
  })

  await fixture.runnerFiberDispose()

  // Inner contract: TuiApp.dispose() attempted its remaining final steps (the
  // generation retirement runs AFTER the throwing stop in the batch).
  assert.ok(app.getSurfaceGeneration() > generationBefore,
    'TuiApp remaining final steps were still attempted after the throwing stop')
  // Outer contract: SurfaceRuntime released the two intermediate leases AND the
  // bridge detach despite the TuiApp final-dispose failure.
  assert.equal(keybindingSyncReleases, 1,
    'the plugin-keybinding sync lease was still released after TuiApp.dispose threw')
  assert.equal(themeHookReleases, 1,
    'the theme-unload hook lease was still released after TuiApp.dispose threw')
  assert.equal(detachCalls, 1, 'the extension bridge detach still ran after TuiApp.dispose threw')
  assert.ok(observed.includes('surface-stop'), 'the real TuiApp stop was entered')
  // Bootstrap orchestration: the failure is logged, retirement still settles,
  // and the transport only disposes AFTER the retirement settlement.
  assert.match(diagLogOf(host), /surface dispose failed/, 'the surfaced TuiApp failure was observed/logged')
  assert.ok(observed.includes('retirement-settled'), 'the Session retirement still settled')
  assert.ok(observed.indexOf('surface-stop') < observed.indexOf('retirement-settled'))
  assert.ok(observed.indexOf('retirement-settled') < observed.indexOf('transport-dispose'))
  assert.ok(transport !== undefined, 'the transport observer was installed')
  assertTransportTeardownOnce(transport, 'the selected transport released each of its five owners exactly once, after retirement')
  assert.ok((transport?.calls() ?? 0) >= 1,
    'the teardown really reached the transport disposer (the release was not inferred)')
  // Fail-closed process slot: the failed final TuiApp dispose keeps it claimed.
  assert.equal(liveTuiCountForTest(), 1,
    'a failed final TuiApp dispose keeps the process TUI slot claimed (fail-closed)')

  // A second runner disposal is inert: none of the three surface leases re-run
  // and the slot stays claimed.
  await fixture.runnerFiberDispose()
  assert.deepEqual({ keybindingSyncReleases, themeHookReleases, detachCalls },
    { keybindingSyncReleases: 1, themeHookReleases: 1, detachCalls: 1 })
  assert.ok(transport !== undefined, 'the transport observer was installed')
  assertTransportTeardownOnce(transport, 'the transport was torn down exactly once')
  assert.ok((transport?.calls() ?? 0) >= 1,
    'the teardown really reached the transport disposer (the release was not inferred)')
  assert.equal(liveTuiCountForTest(), 1)
})

test('a runner that never mounted still releases the transport through the fallback', async (t) => {
  // The mount throws BEFORE the runner's teardown effect exists, so nothing
  // else would release the transport. The fixture's aggregate fallback is the
  // owner of that case, and it is registered before any setup step that can
  // reject — so the transport IS released.
  const life = testLifecycle(t)
  const presetId = 'm3-6-pr3-shutdown-preset'
  const host = await mountHost(life, presetId)
  const mainId = 'm3-6-pr3-shutdown-never-mounted'
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const vt = virtualTerminal(life)
  const { apps } = instrumentTuiApps(life)
  let released = 0
  await assert.rejects(
    async () => {
      await mountShutdownRunner(life, apps, {
        host,
        presetId,
        resumeSessionId: mainId,
        beforeMount: (aggregate) => {
          // The mount fails, and the transport release is observed.
          const original = aggregate.selected.disposeTransport.bind(aggregate.selected)
          aggregate.selected.disposeTransport = async (): Promise<void> => {
            released += 1
            await original()
          }
          throw new Error('the runner mount failed (injected)')
        },
      })
    },
    /the runner mount failed \(injected\)/,
    'the mount failure is the primary failure',
  )
  // The fallback is the lifecycle cleanup, so it runs when the test ends —
  // the release is observed there, not in the rejected mount.
  assert.equal(released, 0, 'the transport was not released by the failed mount')
  // The observer runs AFTER the fallback: the lifecycle executes the
  // deferred cleanups in reverse registration order, and this one is
  // registered before the fixture's fallback, so it runs later.
  t.after(() => {
    assert.equal(released, 1,
      'the fallback released the transport exactly once after the failed mount')
  })
})


test('an owner whose disposer FAILS is not counted as a release', async () => {
  // The teardown observation must separate "the owner's disposer was
  // REACHED" from "the owner's disposer COMPLETED". A disposer that rejects
  // released nothing, so the release count must stay at zero while the call
  // count is one — a count taken before the call would report a release that
  // never happened.
  const failingDispose = async (): Promise<void> => {
    throw new Error('the owner release failed (injected)')
  }
  const aggregate = {
    clientUi: { dispose: failingDispose },
    presentation: { task: { dispose: (): void => {} } },
    backendRuntime: { dispose: (): void => {} },
    wire: {
      client: { dispose: async (): Promise<void> => {} },
      host: { dispose: async (): Promise<void> => {} },
    },
    selected: { disposeTransport: async (): Promise<void> => {} },
  }
  const observed: string[] = []
  const observer = observeTransportDisposal(aggregate, observed)
  await assert.rejects(
    async () => { await aggregate.clientUi.dispose() },
    /the owner release failed \(injected\)/,
    'the owner failure travels to its caller (it is not swallowed by the observer)',
  )
  assert.equal(observer.ownerCalls.clientUi, 1, 'the owner disposer was REACHED')
  assert.equal(observer.ownerReleases.clientUi, 0,
    'the owner was NOT released: its disposer failed, so no release is counted')
  // The exactly-once assertion therefore fails: the teardown is not complete.
  assert.throws(
    () => assertTransportTeardownOnce(observer, 'the transport teardown'),
    /owner releases/,
    'a failed release makes the exactly-once assertion fail',
  )
})


test('the transport fallback does NOT swallow a failed teardown', async () => {
  // The fallback is the LAST cleanup of a runner that never released the
  // transport. If the transport teardown fails there, the failure must reach
  // the caller — the test lifecycle (`test/support/temp-lifecycle.ts`)
  // collects the cleanup failures and reports them. A swallowed failure would
  // leave a resource behind with no trace at all.
  const failing = {
    disposeTransport: async (): Promise<void> => {
      throw new Error('the fallback teardown failed (injected)')
    },
  }
  const ownership = ownTransportTeardown(failing)
  assert.equal(ownership.releasedByRunner(), false,
    'the runner never released the transport, so the fallback owns it')
  await assert.rejects(
    async () => { await ownership.runFallback() },
    /the fallback teardown failed \(injected\)/,
    'a failed fallback teardown is REPORTED, never swallowed',
  )

  // The runner's own teardown releases the transport: the fallback then adds
  // no second call, and a failure of that first teardown is still reported.
  const released = {
    disposeTransport: async (): Promise<void> => {
      throw new Error('the runner teardown failed (injected)')
    },
  }
  const second = ownTransportTeardown(released)
  await assert.rejects(
    async () => { await released.disposeTransport() },
    /the runner teardown failed \(injected\)/,
    'the runner teardown failure is reported to its own caller',
  )
  assert.equal(second.releasedByRunner(), true,
    'the runner reached the transport, so the fallback is inert')
  await second.runFallback()
})
