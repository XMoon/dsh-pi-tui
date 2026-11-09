/**
 * M3-5 PR4 Remote Plugin Manager L6 qualification (plan §14/§15).
 *
 * The REAL Remote application composition (`createRemoteApplicationRuntime`)
 * drives the REAL production runner (`applyRunnerWithRuntime`) over the real
 * in-process official wire, with the base-owned Host prerequisites reproduced:
 * a real managed profile directory (`profileContext`) and the real
 * `@deepseek-ai/dsh-plugin-manager` Host service. Every scenario observes the
 * rendered panel (or a durable Host truth file) rather than an internal flag.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - real rc.2 Host services (the shared remote-application fixture) + the real
 *   managed profile directory + the real `@deepseek-ai/dsh-plugin-manager`
 *   Host service (the base-owned prerequisite: `loader` + `profileContext`)
 * - the official in-process Client/Gateway path over the real carrier
 * - the generated `pluginManager` Remote (methods + forwarded
 *   `plugin-manager/changed` / `install-state` / `install-log`)
 * - the real Remote application runtime, runner, SurfaceRuntime,
 *   PluginManagerController/Panel and HostRegistry
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - VirtualTerminal
 * - a deterministic local fixture profile: one disposable bundle package
 *   listed while disabled (the official toggle target) and a
 *   `@xmoon76/dsh-pi-tui`-named stand-in (the exact-name Current-TUI
 *   negative-control target). Both are manifests only; no package process runs.
 *
 * - the S5-PR2 update path: one real registry install of 1.0.0 seeded through
 *   the Host, then the official `listVersions`/`updateBundle` and forwarded
 *   `plugin-manager/update-state` over the generated Remote, driven from the
 *   real `/plugins` page to the durable 1.1.0 profile dependency
 *
 * DELIBERATELY ABSENT
 * - public npm credentials/endpoints (the registry is loopback and test-owned)
 * - Task Center / child viewer, Job viewer, public Remote selector, global
 *   reconnect/HMR closure outside the Plugin Manager invalidation
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-plugin-manager.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../../support/app-lifecycle-guard.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { Config as TuiConfigSchema } from '../../../src/index.ts'
import { TuiApp } from '../../../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../../../src/app/bootstrap.ts'
import { createRemoteApplicationRuntime } from '../../support/m3-inprocess/application-runtime.ts'
import type { RemoteApplicationOverride } from '../../../src/app/application-runtime.ts'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../../src/extensions.ts'
import { RemotePluginManagerPort } from '../../../src/runtime/remote/plugin-manager-remote.ts'
import type { PluginInstallEvent } from '../../../src/runtime/plugin-manager-port.ts'
import { waitFor } from '../../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../../support/temp-lifecycle.ts'
import { installVirtualProcessTerminal } from '../../support/runner-harness.ts'
import { VirtualTerminal } from '../../support/virtual-terminal.ts'
import { packFixturePackage, startLocalNpmRegistry } from '../../support/local-npm-registry.ts'
import type { PluginUpdateProgressFact } from '../../../src/runtime/plugin-manager-port.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function plain(lines: readonly string[]): string {
  return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

/** The content of the one selected (`> `-marked) list row. */
function selectedRow(viewport: readonly string[]): string | undefined {
  const line = plain(viewport).split('\n').find(candidate => candidate.includes('> '))
  if (line === undefined) return undefined
  return line.slice(line.indexOf('> ') + '> '.length).trim()
}

/** The rendered list/detail line carrying one bundle name. */
function bundleLine(viewport: readonly string[], bundleName: string): string | undefined {
  return plain(viewport).split('\n').find(line => line.includes(bundleName))
}

/** The rendered line carrying one bundle name AND its status chip: in the
 *  dual List|Details frame the Detail title also names the bundle, so the chip
 *  row is the list row, not the first name match. */
function bundleChipLine(viewport: readonly string[], bundleName: string): string | undefined {
  return plain(viewport).split('\n')
    .find(line => line.includes(bundleName) && /\[(?:enabled|disabled)\]/u.test(line))
}

async function settle(ms = 80): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Fixture {
  host: Awaited<ReturnType<typeof import('../../support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>
  vt: VirtualTerminal
  aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  app(): { setDraft(text: string): void; submitDraft(): void }
}

async function mountPluginManagerRunner(
  life: TestLifecycle,
  options: {
    /** Register one CLIENT-CONTEXT extension contribution (M3-6 PR1): a
     * real Client plugin fiber on `aggregate.wire.client.context` using the
     * public extension service — the SELECTED Remote TUI extension
     * authority. */
    readonly clientExtensionBadge?: { readonly id: string; readonly text: string }
    /** Register one HOST-CONTEXT extension contribution of the same shape —
     * the negative-control authority (present on the Host Context, never
     * reported by the selected Remote TUI extension runtime). */
    readonly hostExtensionBadge?: { readonly id: string; readonly text: string }
    /** Replace the default installed fixture profile (the S5-PR2 update test
     *  seeds its own real registry install into an EMPTY profile). */
    readonly pluginManagerProfile?: boolean | { readonly emptyProfile?: boolean }
    /** Isolate HOME/XDG/npm caches for a real registry `pnpm` operation. */
    readonly isolateHome?: boolean
    /** Run REAL Host setup (for example a registry install) before the Remote
     *  application runtime and the runner mount. */
    readonly seed?: (host: Awaited<ReturnType<typeof import('../../support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>) => Promise<void>
  } = {},
): Promise<Fixture> {
  const { createRemoteApplicationHostFixture, PLUGIN_MANAGER_FIXTURE_BUNDLE } =
    await import('../../support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, 'm3-5-pr4-plugin-preset', {
    pluginManagerProfile: options.pluginManagerProfile ?? true,
    ...(options.isolateHome === true ? { isolateHome: true } : {}),
  })
  assert.ok(host.pluginManager !== undefined)
  assert.equal(host.pluginManager.bundleName, PLUGIN_MANAGER_FIXTURE_BUNDLE)

  if (options.seed !== undefined) await options.seed(host)

  const runnerCtx = host.ctx
  const { TUI_STARTUP_SERVICE } = await import('../../../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: undefined, shippedPresetRoot: host.workRoot })

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    // No startup subject on this fixture (M3-6 PR1): the Client UI subtree
    // mounts under empty detached facts.
    clientUiStartup: {},
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  // The CLIENT-CONTEXT contribution (the selected authority): a real Client
  // plugin fiber reads the service through its OWN plugin context and
  // registers through the same public API a third-party plugin uses.
  if (options.clientExtensionBadge !== undefined) {
    const badge = options.clientExtensionBadge
    const fiber = aggregate.wire.client.context.plugin(clientPluginCtx => {
      const service = clientPluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as {
        register(slot: string, spec: { id: string; order?: number }, value: { text: string; tone: string }): unknown
      } | undefined
      if (service === undefined) throw new Error('the Client plugin context did not see piTuiExtensions')
      service.register('chrome.header.badge', { id: badge.id }, { text: badge.text, tone: 'info' })
    })
    await fiber
    life.defer(() => fiber.dispose())
  }

  // The HOST-CONTEXT twin (the negative control): a separate extension
  // service on the ordinary Host Context, present but never the selected
  // Remote TUI extension authority.
  if (options.hostExtensionBadge !== undefined) {
    const badge = options.hostExtensionBadge
    const extensionHostModule = await import('../../../src/extensions.ts')
    await runnerCtx.plugin(extensionHostModule)
    const hostService = runnerCtx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      register(slot: string, spec: { id: string; order?: number }, value: { text: string; tone: string }): unknown
    } | undefined
    if (hostService === undefined) throw new Error('the Host-context extension service did not mount')
    hostService.register('chrome.header.badge', { id: badge.id }, { text: badge.text, tone: 'info' })
  }

  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  runnerCtx.provide('appExit', () => {})
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
  }
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off' } as never), override)
  })
  await runnerFiber
  life.defer(() => { runnerFiber.dispose() })
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)

  const appOf = async () => {
    for (let i = 0; i < 600; i += 1) {
      const candidate = apps.at(-1) as unknown as { setDraft?: unknown } | undefined
      if (candidate !== undefined && typeof candidate.setDraft === 'function') return candidate as never
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the draft surface')
  }
  const app = await appOf()
  startedApps.add(app as unknown as TuiApp)
  return { host, vt, aggregate, app: () => app as never }
}

function submit(fixture: Fixture, text: string): void {
  const app = fixture.app()
  app.setDraft(text)
  app.submitDraft()
}

/** Rewrite the profile manifest the way a hand/CLI edit would: NO Host event is
 *  emitted for this path (the official `changed` event covers manager
 *  operations; an external generation change is the other invalidation). */
function writeProfileBundles(profileDir: string, bundles: readonly string[]): void {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh: { profile: Record<string, unknown> }
  }
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Walk the list until the selected row carries `name` (the panel marks it ▸). */
async function selectListRow(vt: VirtualTerminal, name: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const row = selectedRow(vt.getViewport())
    if (row !== undefined && row.includes(name)) return
    vt.sendInput('\x1b[B')
    await vt.waitForRender()
  }
  throw new Error(`no selectable row for ${name}: ${plain(vt.getViewport())}`)
}

/**
 * The real user mutation path over the ALREADY-OPEN list: select the fixture
 * bundle, open its detail and activate the official Enable action, then wait
 * for the authoritative reread to repaint the enabled truth. The reread keeps
 * the list `busy` until it commits (the controller clears `busyValue` only
 * after the authoritative read returns), so the Detail `Disable` alone is NOT
 * a settled frame: the list chip is waited for too. Returns with the panel in
 * DETAIL mode.
 */
async function enableFixtureBundleThroughPanel(fixture: Fixture, bundle: string): Promise<void> {
  await selectListRow(fixture.vt, bundle)
  fixture.vt.sendInput('\r')
  // The list preview already paints the Detail action; wait for the REAL
  // Details focus frame before pressing Enter, otherwise the first Enter only
  // reveals/focuses and the action admission gate correctly refuses the write.
  await waitFor('the fixture bundle detail owns the Details focus', () =>
    /\[Details\]/.test(plain(fixture.vt.getViewport())), 20_000)
  await waitFor('the fixture bundle detail offers the official Enable action', () =>
    /\bEnable\b/.test(plain(fixture.vt.getViewport())), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the panel repaints the enabled truth from the authoritative reread', () =>
    /\bDisable\b/.test(plain(fixture.vt.getViewport())), 20_000)
  await waitFor('the authoritative reread paints the settled enabled chip', () =>
    (bundleChipLine(fixture.vt.getViewport(), bundle) ?? '').includes('[enabled]'), 20_000)
}

test('the real Remote /plugins reads the real Host PluginManager through the generated Remote', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const bundle = fixture.host.pluginManager!.bundleName

  // Source-to-sink control: the application backend port is the REMOTE adapter
  // (the Direct adapter is never constructed in the Remote backend graph).
  assert.ok(
    fixture.aggregate.selected.backend.pluginManager instanceof RemotePluginManagerPort,
    'the selected backend exposes the Remote Plugin Manager adapter',
  )

  submit(fixture, '/plugins')
  await waitFor('the Remote Plugin Manager panel lists the fixture bundle', () =>
    plain(fixture.vt.getViewport()).includes(bundle), 20_000)

  const view = plain(fixture.vt.getViewport())
  assert.match(view, /Settings · Plugins/)
  assert.match(view, /Current TUI/)
  assert.match(view, /@xmoon76\/dsh-pi-tui/)
  // A distinctive bundle that exists ONLY in the fixture's managed profile:
  // its presence proves the read traversed Host manifest -> generated Remote ->
  // adapter -> controller -> panel.
  const line = bundleLine(fixture.vt.getViewport(), bundle)
  assert.ok(line !== undefined, 'the fixture bundle row is visible')
  assert.match(line, /\[disabled\]/, 'the fixture bundle starts disabled (Host truth)')
})

test('the REAL runner controller consumes the SELECTED Client service observations; a Host-context twin is never reported', async (t) => {
  const life = testLifecycle(t)
  // The observation evidence is captured at the controller's OWN consumption
  // point (R1 F2 / R2 review): the test patches the production
  // `PluginManagerController.prototype.buildModel` ONLY to wrap the REAL
  // instance's existing `observationSource` with a recorder (restored in
  // `finally`), then runs the ORIGINAL unbound buildModel with the instance
  // as receiver — the model build itself invokes the recorded source, so
  // the evidence below is the model's genuine consumption, never an extra
  // test-side source call. A controller wired to the wrong service (or no
  // observations at all) cannot pass the assertions below.
  const { PluginManagerController } = await import('../../../src/app/plugin-manager/controller.ts')
  type Observation = { owner: string; contributionKinds: readonly string[]; contributionCount: number }
  type BuildModel = (this: { observationSource?: () => readonly Observation[] }, snapshot: never) => unknown
  const prototype = PluginManagerController.prototype as unknown as Record<string, BuildModel>
  // NEVER bind: the original must keep receiving the real instance.
  const originalBuildModel: BuildModel = prototype.buildModel
  const consumedByBuilds: Observation[][] = []
  const buildReceivers: unknown[] = []
  const sourceCallsPerBuild: Array<{ modelCalls: number; sourceCalls: number }> = []
  prototype.buildModel = function patchedBuildModel(this: unknown, snapshot: never) {
    const instance = this as { observationSource?: () => readonly Observation[] }
    buildReceivers.push(this)
    const source = instance.observationSource
    if (source === undefined) {
      // A controller built without observations: record the empty truth and
      // let the original build run (its own `?? []` branch).
      consumedByBuilds.push([])
      return originalBuildModel.call(instance, snapshot)
    }
    let restoreSource = false
    const recorded: Observation[] = []
    consumedByBuilds.push(recorded)
    /** Transparency counters: the production build invokes the source ONCE
     * per build (`modelCalls`), and the recorder must forward to the real
     * underlying source EXACTLY that many times (`sourceCalls`) — a
     * recorder that reads the source twice (record one snapshot, return
     * another) fails the equality+one assertions below. */
    const calls = { modelCalls: 0, sourceCalls: 0 }
    sourceCallsPerBuild.push(calls)
    try {
      const countingSource = (receiver: unknown): readonly Observation[] => {
        calls.sourceCalls += 1
        return source.call(receiver)
      }
      instance.observationSource = function recordedSource(this: unknown) {
        calls.modelCalls += 1
        const observations = countingSource(this)
        recorded.push(...observations)
        return observations
      }
      restoreSource = true
      return originalBuildModel.call(instance, snapshot)
    } finally {
      if (restoreSource) instance.observationSource = source
    }
  }
  // Restore the exact original function identity (never a bound clone).
  life.defer(() => { prototype.buildModel = originalBuildModel })

  const fixture = await mountPluginManagerRunner(life, {
    clientExtensionBadge: { id: 'client-obs-badge', text: 'client-obs' },
    hostExtensionBadge: { id: 'host-twin-badge', text: 'host-twin' },
  })
  const bundle = fixture.host.pluginManager!.bundleName

  // Open the REAL panel: the runner-created controller performs its real
  // reads and buildModel calls with the observations it was wired to.
  submit(fixture, '/plugins')
  await waitFor('the Remote Plugin Manager panel lists the fixture bundle', () =>
    plain(fixture.vt.getViewport()).includes(bundle), 20_000)
  assert.match(plain(fixture.vt.getViewport()), /Current TUI/,
    'the Host PluginManager package inventory still renders (unchanged authority)')

  await waitFor('the controller built its model through the patched path', () => consumedByBuilds.length > 0, 20_000)
  // The patched build ran on REAL controller instances (the runner's), and
  // each build's OWN source invocation delivered non-empty observations.
  assert.ok(buildReceivers.length > 0, 'the production buildModel ran with a real receiver')
  for (const receiver of buildReceivers) {
    assert.equal(receiver instanceof PluginManagerController, true,
      'every patched build ran on a real PluginManagerController instance')
  }
  const allConsumed = consumedByBuilds.flat()
  assert.ok(allConsumed.length > 0,
    'the model builds genuinely invoked their observation source (non-empty results; a `[]` source fails here)')
  // Transparency lock: every model build invoked its source EXACTLY ONCE —
  // the recorder forwards one-to-one (modelCalls === sourceCalls === 1), so
  // the recorded snapshot IS the one the model consumed and the recorder
  // adds no second read.
  assert.equal(sourceCallsPerBuild.length, consumedByBuilds.length,
    'every recorded build carries its own source-call counters')
  for (const calls of sourceCallsPerBuild) {
    assert.equal(calls.modelCalls, 1,
      'the production buildModel invokes its observation source exactly once per build')
    assert.equal(calls.sourceCalls, calls.modelCalls,
      'the recorder forwards one-to-one to the real source (no extra read, no different snapshot)')
  }
  const badgeObservations = allConsumed.filter(observation =>
    observation.contributionKinds.includes('chrome.header.badge'))
  assert.ok(badgeObservations.length > 0,
    'the consumed observations include chrome.header.badge contributions')

  // POSITIVE (discriminating): the Client fiber's UNIQUE registration is
  // observable through the model's genuine consumption — its owner identity
  // is keyed on the unique `client-obs-badge` registration, which the
  // builtin badge cannot satisfy.
  const clientService = fixture.aggregate.wire.client.context.get(PI_TUI_EXTENSIONS_SERVICE) as {
    _ledger(): { snapshot(slot: string): { records: Array<{ id: string; owner: string }> } }
  }
  const clientBadgeRecords = clientService._ledger().snapshot('chrome.header.badge').records
  const uniqueClientOwners = new Set(clientBadgeRecords.filter(record => record.id === 'client-obs-badge').map(record => record.owner))
  assert.equal(uniqueClientOwners.size, 1,
    'the unique Client badge has exactly one owner on the Client service ledger')
  const uniqueClientOwner = [...uniqueClientOwners][0]!
  await waitFor('the model consumed the UNIQUE Client contribution owner', () =>
    badgeObservations.some(observation => observation.owner === uniqueClientOwner), 20_000)

  // NEGATIVE: the Host-context twin service verifiably carries its own
  // contribution with a DIFFERENT owner, and that owner NEVER appears in
  // anything the model consumed.
  const hostTwin = fixture.host.ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
    _ledger(): { snapshot(slot: string): { records: Array<{ id: string; owner: string }> } }
  } | undefined
  assert.notEqual(hostTwin, undefined, 'the negative-control Host extension service is mounted')
  const hostTwinRecords = hostTwin!._ledger().snapshot('chrome.header.badge').records
  assert.ok(hostTwinRecords.some(record => record.id === 'host-twin-badge'),
    `the Host twin service verifiably carries its own contribution: ${JSON.stringify(hostTwinRecords.map(record => record.id))}`)
  const hostTwinOwners = new Set(hostTwinRecords.map(record => record.owner))
  for (const hostOwner of hostTwinOwners) {
    assert.equal(allConsumed.some(observation => observation.owner === hostOwner), false,
      `the model never consumed the Host twin service's owner (${hostOwner})`)
  }

  // Prototype restoration identity: after the test lifecycle the exact
  // original function is back (verified here against the still-live value —
  // the defer restores it after this test's assertions).
  assert.equal(prototype.buildModel === originalBuildModel, false,
    'the patch is active during the test (restoration happens through the lifecycle defer)')
})

test('the Settings → Plugins entry hosts the SAME Remote controller/panel and Back returns', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)

  submit(fixture, '/settings')
  await waitFor('the Settings workspace opens', () => /Settings · Categories/.test(plain(fixture.vt.getViewport())), 20_000)
  // The workspace opens on its About home; the rail order is About, Models,
  // Account, Agent, Appearance, Conversation, Input & Terminal, Tools, Plugins,
  // so eight Down presses reach Plugins.
  for (let step = 0; step < 8; step += 1) fixture.vt.sendInput('\x1b[B')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\r')
  await waitFor('the Plugin Manager page is hosted by Settings', () =>
    /Settings · Plugins/.test(plain(fixture.vt.getViewport())), 20_000)
  // Same owner: the Remote inventory read is live on this entry too.
  await waitFor('the same Remote inventory renders', () =>
    plain(fixture.vt.getViewport()).includes(fixture.host.pluginManager!.bundleName), 20_000)

  fixture.vt.sendInput('\x1b')
  await waitFor('Back returns to the SAME Settings surface', () =>
    /Settings · Categories/.test(plain(fixture.vt.getViewport())), 20_000)
  assert.doesNotMatch(plain(fixture.vt.getViewport()), /Settings · Plugins/)

  fixture.vt.sendInput('\x1b')
  await waitFor('closing Settings returns to the editor', () =>
    !/Settings · Categories/.test(plain(fixture.vt.getViewport())), 20_000)
})

test('one real Remote mutation reaches Host authority and the authoritative reread repaints', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const profile = fixture.host.pluginManager!
  const bundle = profile.bundleName
  assert.deepEqual([...profile.selectedBundles()], [], 'the durable profile starts with no selected bundle')

  submit(fixture, '/plugins')
  await waitFor('the fixture bundle is listed disabled', () =>
    (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('disabled'), 20_000)

  // Negative control FIRST: the Current TUI card offers no mutation affordance,
  // and navigating it never writes the durable Host truth.
  const manifestBefore = readFileSync(join(profile.profileDir, 'package.json'), 'utf8')
  await selectListRow(fixture.vt, '@xmoon76/dsh-pi-tui')
  fixture.vt.sendInput('\r')
  await fixture.vt.waitForRender()
  const selfDetail = plain(fixture.vt.getViewport())
  assert.match(selfDetail, /managed outside/)
  assert.doesNotMatch(selfDetail, /\bDisable\b/)
  assert.doesNotMatch(selfDetail, /\bEnable\b/)
  assert.equal(readFileSync(join(profile.profileDir, 'package.json'), 'utf8'), manifestBefore,
    'the self-protected target never mutates the Host truth')

  // Positive mutation: the real user path (select → detail → official Enable).
  fixture.vt.sendInput('\x1b') // back to the list
  await fixture.vt.waitForRender()
  await enableFixtureBundleThroughPanel(fixture, bundle)

  // Host authority: the durable profile manifest now selects the fixture
  // bundle (the ONLY truth), and the panel repainted from the authoritative
  // reread — not from the operation reply.
  await waitFor('the Host profile truth is written', () =>
    profile.selectedBundles().includes(bundle), 20_000)
  // The list row's status chip is the truthful reread projection; the Detail
  // label is `Selected in profile` (the Host selection, never a run claim).
  const rereadLine = bundleChipLine(fixture.vt.getViewport(), bundle) ?? ''
  assert.match(rereadLine, /\[enabled\]/u, 'the reread renders the enabled status')
  assert.doesNotMatch(rereadLine, /\[disabled\]/u, 'the stale disabled truth is gone')

  // Truthful disposition: no hmr in this composition, so the Host reports
  // restart-required rather than pretending a live application.
  fixture.vt.sendInput('\x1b')
  await waitFor('the truthful restart-required disposition is shown', () =>
    /restart required/i.test(plain(fixture.vt.getViewport())), 20_000)
})

test('an external Host change invalidates an open Remote panel with no manual refresh', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const bundle = fixture.host.pluginManager!.bundleName

  submit(fixture, '/plugins')
  await waitFor('the fixture bundle is listed disabled', () =>
    (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('disabled'), 20_000)

  // A SECOND Host-side actor, outside the TUI controller: the official manager
  // operation emits plugin-manager/changed, which the real forwarding loop
  // sends over the wire.
  await (fixture.host.ctx.pluginManager as unknown as {
    setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  }).setBundleEnabled(bundle, true)

  // No `R` key is ever sent: only the invalidation-driven authoritative reread
  // can repaint the already-open panel.
  await waitFor('the open panel repaints from the externally changed Host truth', () =>
    (bundleChipLine(fixture.vt.getViewport(), bundle) ?? '').includes('[enabled]'), 20_000)
})

test('a new Connection generation rereads authoritative truth without replaying the prior mutation', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const profile = fixture.host.pluginManager!
  const bundle = profile.bundleName

  submit(fixture, '/plugins')
  await waitFor('the fixture bundle is listed disabled', () =>
    (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('disabled'), 20_000)

  // A REAL prior mutation through the panel (this is the operation a buggy
  // reconnect could wrongly replay), then back to the list.
  await enableFixtureBundleThroughPanel(fixture, bundle)
  fixture.vt.sendInput('\x1b')
  await waitFor('the prior Enable reached both Host truth and the list render', () =>
    profile.selectedBundles().includes(bundle)
    && (selectedRow(fixture.vt.getViewport()) ?? '').includes(bundle)
    && plain(fixture.vt.getViewport()).includes('[enabled]'), 20_000)

  // External hand edit: authoritative truth becomes DISABLED and NOTHING is
  // announced (the official manager only announces its own operations).
  writeProfileBundles(profile.profileDir, [])
  await settle(250)
  assert.match(plain(fixture.vt.getViewport()), /\[enabled\]/,
    'without an invalidation the open panel keeps its cached truth')

  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const before = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== before
  }, 20_000)

  await waitFor('the generation invalidation rereads the authoritative inventory', () =>
    plain(fixture.vt.getViewport()).includes('[disabled]'), 20_000)

  // The REPLAY-NEGATIVE: the earlier Enable really happened, so a reconnect
  // that replayed it would flip the durable Host truth back to selected (and
  // the reread would repaint `active`). It must stay exactly the hand edit.
  assert.deepEqual([...profile.selectedBundles()], [],
    'reconnect rereads only; it never replays the earlier Enable mutation')
})

test('the real forwarded install events reach the Remote adapter by exact request id', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const port = fixture.aggregate.selected.backend.pluginManager
  const events: PluginInstallEvent[] = []
  const dispose = port.subscribeInstall(event => events.push(event))
  life.defer(dispose)

  // The real Host event source: the same `plugin-manager/install-state` /
  // `plugin-manager/install-log` declarations the official manager emits,
  // forwarded by the real api-remotes loop over the real in-process wire.
  // (This is L5 wire evidence for the install-event leg; the controller's
  // exact-request-id filtering and close/reopen-no-redispatch live in
  // test/app/plugin-manager-install.test.ts and test/app/plugin-manager-port.test.ts.)
  const emit = fixture.host.ctx.emit as unknown as (name: string, payload: unknown) => void
  emit('plugin-manager/install-state', {
    requestId: 'pr4-req-1',
    phase: 'installing',
    attempt: { registry: null, index: 1, total: 2 },
  })
  emit('plugin-manager/install-log', {
    requestId: 'pr4-req-1',
    jobId: 'job-1',
    argv: ['pnpm'],
    cwd: '/profile',
    stream: 'stdout',
    text: 'added 1 package',
  })

  await waitFor('the forwarded install events arrive over the real wire', () => events.length === 2, 20_000)
  assert.deepEqual(events, [
    {
      kind: 'phase',
      phase: { requestId: 'pr4-req-1', phase: 'installing', attempt: { registry: null, index: 1, total: 2 } },
    },
    {
      kind: 'log',
      log: { requestId: 'pr4-req-1', jobId: 'job-1', stream: 'stdout', text: 'added 1 package' },
    },
  ])
  dispose()
  emit('plugin-manager/install-state', { requestId: 'pr4-req-2', phase: 'applying' })
  await settle(150)
  assert.equal(events.length, 2, 'a disposed install subscription delivers nothing later')
})

test('a Remote mutation reply carried by a superseded Connection generation never repaints success or re-dispatches', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const profile = fixture.host.pluginManager!
  const bundle = profile.bundleName

  // Count the REAL Host write on the unwrapped service implementation.
  const { symbols } = await import('@deepseek-ai/cordis')
  const hostProxy = fixture.host.ctx.get('pluginManager') as unknown as Record<symbol, unknown> & {
    setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  }
  const hostService = (hostProxy[symbols.original] ?? hostProxy) as typeof hostProxy
  const originalHostWrite = hostService.setBundleEnabled
  let hostWrites = 0
  let releaseReply!: () => void
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve })
  // Teardown fallback: release LIFO before the mounted Host/controller is
  // disposed, even when an assertion fails before the normal release.
  life.defer(() => { releaseReply() })
  let replyHeld!: () => void
  const replyReached = new Promise<void>(resolve => { replyHeld = resolve })
  hostService.setBundleEnabled = async function patchedHostWrite(
    this: unknown,
    name: string,
    enabled: boolean,
  ): Promise<unknown> {
    // The REAL Host write runs to completion first; then the Host-side answer
    // is withheld, so the generated Remote call (and the adapter awaiting it)
    // is still pending when the Connection generation switches.
    const reply = await originalHostWrite.call(this, name, enabled)
    hostWrites += 1
    replyHeld()
    await replyGate
    return reply
  }
  t.after(() => { hostService.setBundleEnabled = originalHostWrite })

  submit(fixture, '/plugins')
  await waitFor('the fixture bundle is listed disabled', () =>
    (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('disabled'), 20_000)
  await selectListRow(fixture.vt, bundle)
  fixture.vt.sendInput('\r')
  await waitFor('the fixture bundle detail owns the Details focus', () =>
    /\[Details\]/.test(plain(fixture.vt.getViewport())), 20_000)
  await waitFor('the fixture bundle detail offers the official Enable action', () =>
    /\bEnable\b/.test(plain(fixture.vt.getViewport())), 20_000)
  fixture.vt.sendInput('\r')
  await replyReached
  await waitFor('the real Host write is dispatched exactly once', () => hostWrites === 1, 20_000)
  // The Detail `Selected in profile` fact wraps onto the following physical
  // row in the dual frame, so it is matched with one bounded wildcard. The
  // chip can read `busy` while the Host reply is withheld.
  assert.match(plain(fixture.vt.getViewport()), /Selected in profile[\s\S]{0,160}?\bNo\b/u,
    'the pending operation has not repainted the Host truth')

  // Switch the official Connection generation while the operation is pending.
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const before = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== before
  }, 20_000)
  // The new generation's authoritative inventory reread is the only painter:
  // the real Host write really happened, so the truth is enabled.
  await waitFor('the new generation reread paints the authoritative enabled truth', () =>
    /Selected in profile[\s\S]{0,160}?\bYes\b/u.test(plain(fixture.vt.getViewport())), 20_000)

  // Now the old-generation reply lands on the new surface.
  releaseReply()
  await settle(500)
  const view = plain(fixture.vt.getViewport())
  assert.equal(hostWrites, 1, 'the stale reply never dispatches a second Host write')
  assert.doesNotMatch(view, /enable restart-required|enable applied/,
    'a stale generation reply never repaints an optimistic success summary')
  assert.match(view, /currentness context was superseded/,
    'the superseded reply is rendered as indeterminate')
  assert.match(view, /authoritative inventory/,
    'the notice names the authoritative reread as the decision owner')
  assert.doesNotMatch(view, /enable\/disable failed/,
    'the applied mutation is never presented as a definite failure')
  assert.match(plain(fixture.vt.getViewport()), /Selected in profile[\s\S]{0,160}?\bYes\b/u,
    'the authoritative inventory still paints the applied truth')
  assert.deepEqual([...profile.selectedBundles()], [bundle], 'the durable Host truth is exactly the one real write')
})

// ── S5-PR2: real Remote registry update L6 ──────────────────────────────────

const REMOTE_UPDATE_BUNDLE = 'dsh-s5-pr2-l6-update-bundle'

function remoteUpdatePackage(version: string, root: string): ReturnType<typeof packFixturePackage> {
  return packFixturePackage(root, {
    name: REMOTE_UPDATE_BUNDLE,
    version,
    manifest: {
      name: REMOTE_UPDATE_BUNDLE,
      version,
      main: 'index.js',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    },
    files: { 'cordis.patch.yml': '[]\n', 'index.js': `export default function v${version.replace(/\W/g, '')}() {}\n` },
  }, { directory: 'package', tarballDirectory: 'tarball' })
}

test('the REAL runner /plugins drives one registry update through the generated Remote', async (t) => {
  const life = testLifecycle(t)
  const packRoot = life.tempDir('s5-pr2-l6-update-pack-')
  const from = remoteUpdatePackage('1.0.0', join(packRoot, 'from'))
  const to = remoteUpdatePackage('1.1.0', join(packRoot, 'to'))
  const fromManifest = { name: REMOTE_UPDATE_BUNDLE, version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }
  const toManifest = { name: REMOTE_UPDATE_BUNDLE, version: '1.1.0', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }
  const registry = await startLocalNpmRegistry(from, {
    manifest: fromManifest,
    additionalVersions: [{ packed: to, manifest: toManifest, tags: ['latest'] }],
  })
  life.defer(() => registry.close())

  let updateDispatches = 0
  const fixture = await mountPluginManagerRunner(life, {
    pluginManagerProfile: { emptyProfile: true },
    isolateHome: true,
    seed: async (host) => {
      const { symbols } = await import('@deepseek-ai/cordis')
      const proxy = host.ctx.get('pluginManager') as unknown as Record<symbol, unknown> & {
        installBundle(spec: string, options?: { registry?: string; enabled?: boolean }): Promise<{ version?: string }>
        updateBundle(name: string, version: string, options?: unknown): Promise<unknown>
      }
      const service = (proxy[symbols.original] ?? proxy) as typeof proxy
      const installed = await service.installBundle(`${REMOTE_UPDATE_BUNDLE}@1.0.0`, {
        registry: registry.url,
        enabled: true,
      })
      assert.equal(installed.version, '1.0.0', 'the fixture profile holds the real registry 1.0.0')
      const original = service.updateBundle
      service.updateBundle = function patchedUpdate(this: unknown, name: string, version: string, options?: unknown): Promise<unknown> {
        updateDispatches += 1
        return original.call(this, name, version, options)
      }
      life.defer(() => { service.updateBundle = original })
    },
  })
  const profile = fixture.host.pluginManager!
  const port = fixture.aggregate.selected.backend.pluginManager
  const progress: PluginUpdateProgressFact[] = []
  const disposeProgress = port.subscribeUpdate(update => progress.push(update))
  life.defer(disposeProgress)

  submit(fixture, '/plugins')
  await waitFor('the registry bundle is listed', () =>
    plain(fixture.vt.getViewport()).includes(REMOTE_UPDATE_BUNDLE), 20_000)
  // Explicit search keeps the long catalog out of the way.
  fixture.vt.sendInput('/')
  for (const character of REMOTE_UPDATE_BUNDLE) fixture.vt.sendInput(character)
  fixture.vt.sendInput('\r')
  await fixture.vt.waitForRender()
  await selectListRow(fixture.vt, REMOTE_UPDATE_BUNDLE)
  fixture.vt.sendInput('\r')
  await waitFor('the Details focus frame', () =>
    /\[Details\]/.test(plain(fixture.vt.getViewport())), 20_000)
  fixture.vt.sendInput('\x1b[B') // Disable… -> Check updates…
  await fixture.vt.waitForRender()
  // Enter either reveals the action or activates it; the selection never
  // moves off Check updates…, so every attempt names the same action.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (plain(fixture.vt.getViewport()).includes('Update bundle ·')) break
    fixture.vt.sendInput('\r')
    await fixture.vt.waitForRender()
  }
  await waitFor('the Update page identity', () =>
    plain(fixture.vt.getViewport()).includes(`Update bundle · ${REMOTE_UPDATE_BUNDLE}`), 30_000)
  await waitFor('the Host listVersions target over the wire', () =>
    /\b1\.1\.0\b/.test(plain(fixture.vt.getViewport())), 30_000)
  fixture.vt.sendInput('\r')
  await waitFor('the confirmation frame', () =>
    /From\s+1\.0\.0/.test(plain(fixture.vt.getViewport())), 20_000)
  fixture.vt.sendInput('\x1b[A') // Cancel -> Confirm update
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\r')

  // The durable Host profile now holds 1.1.0: the update write traversed the
  // generated Remote into the real Host.
  await waitFor('the Host profile dependency 1.1.0', () => {
    const manifest = JSON.parse(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return manifest.dependencies?.[REMOTE_UPDATE_BUNDLE] === '1.1.0'
  }, 90_000)
  await waitFor('the authoritative reread frame', () =>
    /Observed installed version\s+1\.1\.0/.test(plain(fixture.vt.getViewport())), 30_000)
  assert.equal(updateDispatches, 1, 'exactly one Host updateBundle dispatch')
  assert.ok(progress.every(update => update.requestId.length > 0))
  assert.ok(progress.some(update => update.step === 'checking'), 'the Host checking step crossed the wire')
  assert.ok(progress.some(update => update.step === 'installing'), 'the Host installing step crossed the wire')
})

test('the forwarded plugin-manager/update-state reaches the Remote adapter over the real wire', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)
  const port = fixture.aggregate.selected.backend.pluginManager
  const received: PluginUpdateProgressFact[] = []
  const dispose = port.subscribeUpdate(progress => received.push(progress))
  life.defer(dispose)
  // The CONTROL subscription is the delivery barrier: the same event that the
  // disposed subscription must not receive is proven to have crossed the real
  // wire because this live listener observes it. No arbitrary sleep is needed.
  const control: PluginUpdateProgressFact[] = []
  const disposeControl = port.subscribeUpdate(progress => control.push(progress))
  life.defer(disposeControl)

  const emit = fixture.host.ctx.emit as unknown as (name: string, payload: unknown) => void
  emit('plugin-manager/update-state', { requestId: 'pr6-update-1', step: 'checking' })
  emit('plugin-manager/update-state', { requestId: 'pr6-update-1', step: 'restoring' })
  await waitFor('the forwarded update events arrive over the real wire', () => received.length === 2 && control.length === 2, 20_000)
  assert.deepEqual(received, [
    { requestId: 'pr6-update-1', step: 'checking' },
    { requestId: 'pr6-update-1', step: 'restoring' },
  ])
  dispose()
  emit('plugin-manager/update-state', { requestId: 'pr6-update-2', step: 'installing' })
  await waitFor('the control listener receives the post-disposal event', () => control.length === 3, 20_000)
  assert.equal(received.length, 2, 'a disposed update subscription delivers nothing later')
  assert.deepEqual(control.at(-1), { requestId: 'pr6-update-2', step: 'installing' })
})
