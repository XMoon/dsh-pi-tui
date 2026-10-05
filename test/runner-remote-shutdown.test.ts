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
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import type { SessionOwnerRetirement } from '../src/app/session/owner-access.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import { CatalogRefreshCoordinator } from '../src/skill-catalog-refresh.ts'
import { liveTuiCountForTest } from '../src/process-tui-slot.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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

type HostFixture = Awaited<ReturnType<typeof import('./support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>
type RemoteAggregate = Awaited<ReturnType<typeof createRemoteApplicationRuntime>>

async function mountHost(life: TestLifecycle, presetId: string): Promise<HostFixture> {
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
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
 */
function instrumentAggregate(aggregate: RemoteAggregate, observed: string[]): { readonly transport: { disposals: number } } {
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
  const transport = { disposals: 0 }
  const originalDispose = aggregate.selected.disposeTransport.bind(aggregate.selected)
  aggregate.selected.disposeTransport = async (): Promise<void> => {
    transport.disposals += 1
    observed.push('transport-dispose')
    await originalDispose()
  }
  return { transport }
}

/** Observed exactly-once releases of the Remote aggregate's sub-owners. */
interface TeardownCounts {
  clientUi: number
  taskWatch: number
  adapters: number
  client: number
  host: number
}

/**
 * Wrap the aggregate's REAL sub-owner disposers (Client UI subtree, Remote
 * task watch, semantic/config adapters, official Client runtime, Host additive
 * runtime) with call-through observers, so the L6 teardown proves each
 * production owner was actually released — not merely that the transport entry
 * was called.
 */
function instrumentTeardownOwners(aggregate: RemoteAggregate): TeardownCounts {
  const counts: TeardownCounts = { clientUi: 0, taskWatch: 0, adapters: 0, client: 0, host: 0 }
  const wrap = (owner: object, key: string, onDispose: () => void): void => {
    const record = owner as unknown as Record<string, unknown>
    const original = record[key] as (...args: unknown[]) => Promise<void> | void
    record[key] = (...args: unknown[]): Promise<void> | void => {
      onDispose()
      return original.apply(owner, args)
    }
  }
  wrap(aggregate.clientUi, 'dispose', () => { counts.clientUi += 1 })
  wrap(aggregate.presentation.task, 'dispose', () => { counts.taskWatch += 1 })
  wrap(aggregate.backendRuntime, 'dispose', () => { counts.adapters += 1 })
  wrap(aggregate.wire.client, 'dispose', () => { counts.client += 1 })
  wrap(aggregate.wire.host, 'dispose', () => { counts.host += 1 })
  return counts
}

interface ShutdownFixture {
  readonly host: HostFixture
  readonly aggregate: RemoteAggregate
  app(): { stop(): void; setDraft(text: string): void; submitDraft(request?: string): void; getDraft(): string }
  runnerFiberDispose(): Promise<void>
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
  },
): Promise<ShutdownFixture> {
  const { host } = options
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: options.resumeSessionId },
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))
  options.beforeMount?.(aggregate)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  host.ctx.provide('appExit', options.appExit ?? ((): void => {}))
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  host.ctx.provide(TUI_STARTUP_SERVICE, {
    sessionId: options.resumeSessionId,
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
  }
  const runnerFiber = host.ctx.plugin(pluginCtx => {
    applyRunnerWithRuntime(
      pluginCtx,
      TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never),
      override,
    )
  })
  await runnerFiber
  life.defer(() => { void runnerFiber.dispose() })
  return {
    host,
    aggregate,
    app: () => apps.at(-1) as never,
    runnerFiberDispose: async () => { await runnerFiber.dispose() },
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

test('L6-A: a mounted Remote runner unloads totally and a fresh runner mounts in the same process', async (t) => {
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
  let transportA: { disposals: number } | undefined
  let teardownA: TeardownCounts | undefined
  const fixtureA = await mountShutdownRunner(life, apps, {
    host: hostA,
    presetId,
    resumeSessionId: mainA,
    beforeMount: (aggregate) => {
      transportA = instrumentAggregate(aggregate, observed).transport
      teardownA = instrumentTeardownOwners(aggregate)
    },
  })
  await waitFor('runner A paint', () => vt.getViewport().join('').length > 0, 20_000)
  assert.equal(liveTuiCountForTest(), 1, 'runner A mounted and owns the process TUI slot')

  await fixtureA.runnerFiberDispose()
  assert.equal(transportA?.disposals, 1, 'the selected Remote transport disposes exactly once')
  assert.deepEqual(teardownA, { clientUi: 1, taskWatch: 1, adapters: 1, client: 1, host: 1 },
    'every Remote owner released exactly once: Client UI subtree, task watch, adapters, official Client, Host additive runtime')
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
  let transportB: { disposals: number } | undefined
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
  assert.equal(transportB?.disposals, 1, 'runner B disposes its transport exactly once')
  assert.equal(liveTuiCountForTest(), 0, 'runner B unloads cleanly too')
})

/* ── L6-B ──────────────────────────────────────────────────────────────── */

test('L6-B: a throwing real generation unsubscribe cannot truncate the root teardown', async (t) => {
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
  let transport: { disposals: number } | undefined
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
  assert.equal(transport?.disposals, 1, 'the selected transport disposed exactly once')
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

test('L6-C: a mounted startup fatal uses the same surface cleanup authority before retirement/transport', async (t) => {
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

  let transport: { disposals: number } | undefined
  const fixture = await mountShutdownRunner(life, apps, {
    host,
    presetId,
    resumeSessionId: mainId,
    appExit: (code) => { exitCodes.push(code) },
    beforeMount: (aggregate) => { transport = instrumentAggregate(aggregate, observed).transport },
  })

  await waitFor('the fatal path exits once', () => exitCodes.length === 1, 20_000)
  assert.deepEqual(exitCodes, [1], 'the fatal startup path exits exactly once with code 1')
  assert.equal(transport?.disposals, 1, 'when retirement settles, the Remote transport disposes exactly once')
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

test('L6-D: a throwing TuiApp-owned aggregate cleanup does not strand the later plugin/theme/extension releases', async (t) => {
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
  const mainId = 'm3-6-pr3-shutdown-d-appowned'
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  let transport: { disposals: number } | undefined
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

  // A REAL TuiApp-owned cleanup step in the aggregate batch. Patched AFTER the
  // mount (the mount itself calls it through attachInteraction), so only the
  // teardown call throws.
  const failure = new Error('m3-6-pr3 app-owned cleanup failed')
  t.mock.method(TuiApp.prototype, 'setSettledQuestionAnswersLookup', () => { throw failure })

  await fixture.runnerFiberDispose()

  assert.equal(keybindingSyncReleases, 1,
    'the plugin-keybinding sync lease was still released after the app-owned cleanup threw')
  assert.equal(themeHookReleases, 1,
    'the theme-unload hook lease was still released after the app-owned cleanup threw')
  assert.equal(detachCalls, 1, 'the extension bridge detach still ran after the app-owned cleanup threw')
  assert.equal(transport?.disposals, 1, 'the selected transport still disposed exactly once')
  assert.ok(observed.includes('surface-stop'), 'the mounted TuiApp still completed its final disposal')
  assert.equal(liveTuiCountForTest(), 0,
    'the process TUI slot was released because TuiApp.dispose itself completed')

  // A second runner disposal is inert: none of the three surface leases re-run.
  await fixture.runnerFiberDispose()
  assert.deepEqual({ keybindingSyncReleases, themeHookReleases, detachCalls },
    { keybindingSyncReleases: 1, themeHookReleases: 1, detachCalls: 1 })
})
