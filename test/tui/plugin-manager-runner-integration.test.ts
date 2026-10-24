/**
 * Real-runner dual-entry Plugin Manager integration (rc.2 P1-Z0, plan §12).
 *
 * Unlike the wiring-level host-registry tests, this drives the production
 * `src/index.ts` runner: the registered `/plugins` and `/settings` command
 * handlers, the real `PluginManagerHostRegistry`, the real controller/panel,
 * and the real overlay lifecycle. It proves the two entries share one host
 * owner, that a normal close returns where it came from, and that closing
 * releases the owner so a later open still mounts (no phantom host).
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager-runner-integration.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { Context, symbols } from '@deepseek-ai/cordis'
import { TuiApp } from '../../src/tui-app.ts'
import {
  disposeContext,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  settle,
} from '../support/runner-harness.ts'
import { packFixturePackage, startLocalNpmRegistry } from '../support/local-npm-registry.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** The official pluginManager Host surface, all empty/neutral: this test is
 *  about the entry/ownership lifecycle, not about inventory content. */
function fakePluginManager(): Record<string, unknown> {
  return {
    listBundles: async () => [],
    listPlugins: async () => [],
    registries: async () => ({ registry: null, fallbackRegistries: [], resolved: null }),
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
    inspect: async () => ({ status: 'refused', problem: 'unknown', reason: 'not used' }),
    setBundleEnabled: async () => ({ changed: false, application: 'applied', stage: 'enable', target: '' }),
    setPluginEnabled: async () => ({ changed: false, application: 'applied', stage: 'enable', target: '' }),
    removeBundle: async () => ({ changed: false, application: 'applied', stage: 'remove', target: '' }),
    installBundle: async () => ({ changed: false, application: 'applied', stage: 'install', target: '' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
  }
}

/** Record every TuiApp the production runner creates. */
function installAppProbe(): { apps: TuiApp[]; restore: () => void } {
  const apps: TuiApp[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function (this: TuiApp) {
    apps.push(this)
    return originalStart.apply(this)
  }
  return { apps, restore: () => { TuiApp.prototype.start = originalStart } }
}

function invokeCommand(harness: ReturnType<typeof makeHarness>, name: string): unknown {
  const handler = (harness.commands as { handler: (command: string) => ((invocation: unknown) => unknown) | undefined }).handler(name)
  assert.ok(handler !== undefined, `/${name} must be registered by the real runner`)
  return handler({
    commandId: `cmd-${name}`,
    agent: undefined,
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
}

function plain(view: readonly string[]): string {
  return view.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

async function mountPluginRunner(
  t: Parameters<typeof testLifecycle>[0],
  manager: Record<string, unknown> = fakePluginManager(),
): Promise<{
  vt: VirtualTerminal
  harness: ReturnType<typeof makeHarness>
  app: TuiApp
}> {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-plugin-runner-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const harness = makeHarness(home)
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('pluginManager', manager as never)
  const fiber = await mountRunner(ctx, home, harness, {}, { fullscreen: 'off' })
  await settle()
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  return { vt, harness, app }
}

test('the real /plugins entry opens the Settings page on the plugin List; two Escs close to the editor', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  const view = plain(vt.getViewport())
  assert.match(view, /Settings · Plugins/, 'the direct entry leases the ONE Settings workspace')
  assert.doesNotMatch(view, /Settings · Categories/, 'the deep link lands on Plugins, not on About')
  assert.match(view, /No plugins/, 'the empty inventory paints an honest empty state')
  // Esc yields to the Categories rail; a second Esc closes the ONE lease.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Categories/, 'the first Esc yields to the rail')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · /, 'the second Esc closes the workspace')
})

test('closing /plugins restores transcript-fullscreen mode and the live editor draft', async (t) => {
  const { vt, harness, app } = await mountPluginRunner(t)
  const draft = 'draft survives the plugin manager round trip'
  app.setDraft(draft)
  app.setFullscreen(true)
  await vt.waitForRender()

  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/)

  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true, 'the transcript-fullscreen mode is restored')
  assert.equal(app.getDraft(), draft, 'the live editor draft is untouched')
})

test('a second /plugins is refused by the live Settings lease, and a later open still mounts', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  const first = invokeCommand(harness, 'plugins') as { kind: string }
  assert.equal(first.kind, 'success')
  await vt.waitForRender()
  // A second open must not stack a second Settings screen or a second page: the
  // lease refusal is a REAL error result, never a phantom success.
  const second = await (invokeCommand(harness, 'plugins') as Promise<{ kind: string }> | { kind: string })
  assert.equal(second.kind, 'error', 'the live lease refuses the second open')
  await vt.waitForRender()
  assert.equal(plain(vt.getViewport()).split('Settings · ').length - 1, 1, 'exactly ONE Settings workspace is painted')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The owner was released: the direct entry mounts again.
  const third = invokeCommand(harness, 'plugins') as { kind: string }
  assert.equal(third.kind, 'success', 'a later /plugins mounts normally')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/, 'a later /plugins mounts normally')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('the real Settings → Plugins category hosts the same page in place and Back returns to Settings', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Categories/)
  // The workspace opens on its About home; the rail order is About, Models,
  // Account, Appearance, Display, Tools, Plugins, Other settings, so six Down
  // presses reach Plugins.
  for (let step = 0; step < 6; step += 1) vt.sendInput('\x1b[B')
  await vt.waitForRender()
  // The rail selection already previews the page; Enter only moves the keys.
  assert.match(plain(vt.getViewport()), /Settings · Categories/)
  assert.match(plain(vt.getViewport()), /No plugins/, 'the rail preview paints the real plugin page')
  vt.sendInput('\r')
  await vt.waitForRender()
  const pluginView = plain(vt.getViewport())
  assert.match(pluginView, /Settings · Plugins/, 'the Settings entry hosts the same page')
  // Back (Escape) returns to the SAME Settings surface, not to the editor.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const backView = plain(vt.getViewport())
  assert.match(backView, /Settings · Categories/)
  assert.match(backView, /> Plugins/, 'Plugins remains selected at L0')
  // Closing Settings returns to the editor.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · Categories/, 'closing Settings returns to the editor')
})

test('a blocking owner arriving over /plugins closes the workspace and releases its owner', async (t) => {
  const { vt, harness, app } = await mountPluginRunner(t)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/)

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'blocking-owner probe' })
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · Plugins/, 'the blocking owner pre-empts the workspace')
  vt.sendInput('\x1b')
  await approval.catch(() => {})

  // The owner was released with the pre-empted workspace: a later direct entry
  // mounts normally instead of reporting a phantom lease.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('an external surface teardown releases the Manager owner so a later /plugins still opens', async (t) => {
  const { vt, harness, app } = await mountPluginRunner(t)
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  for (let step = 0; step < 6; step += 1) vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/, 'the Settings entry hosts the shared page')

  // External teardown through the surface lifecycle: the whole screen (and the
  // hosted page) is released WITHOUT the page's normal close path.
  app.stop()
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · Plugins/, 'the external teardown hides the hosted page')
  app.start()
  await vt.waitForRender()

  // The owner was released with the parent: the direct entry opens normally
  // (no phantom active host) and closes cleanly.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/, 'a later /plugins opens after the external teardown')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Settings · Plugins/)
})

test('hostile plugin metadata never reaches the mounted panel TTY raw', async (t) => {
  const hostile = 'evil\u001b]52;c;YXR0YWNr\u0007\u001b[2J\u009b2Jname'
  const manager = {
    ...fakePluginManager(),
    // The Host bundle projection and its Loader row identity are external
    // package metadata; the row entryId reaches the Detail action label.
    listBundles: async () => [{
      name: hostile, version: hostile, enabled: true, installed: true,
      optional: false, removable: true,
      rows: [{ rowId: 'evil-row', moduleName: 'evil', entryId: hostile }],
      overrides: [],
    }],
    // A live PluginInfo + matching patchId is what makes the row addressable
    // and therefore produces the dynamic `Enable/Disable row <entryId>` label.
    listPlugins: async () => [{
      entryId: hostile, moduleName: 'evil', enabled: true, fiberPhase: 'active', patchId: 'evil-row',
    }],
  }
  const { vt, harness } = await mountPluginRunner(t, manager)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  vt.resize(120, 60)
  await vt.waitForRender()
  vt.sendInput('\r') // open Details; the row action label carries entryId
  await vt.waitForRender()
  const raw = vt.writes.join('')
  assert.ok(!raw.includes('YXR0YWNr'), `no OSC 52 payload from plugin metadata reaches the TTY:\n${plain(vt.getViewport())}`)
  assert.ok(!raw.includes('\u009b'), 'no raw C1 byte from plugin metadata reaches the TTY')
  assert.match(plain(vt.getViewport()), /Disable row evilname/,
    'the live row action label is painted with the projected entryId')
})

test('a hostile Host installTarget spec is projected before the install Input renders it', async (t) => {
  const hostile = 'evil\u001b]52;c;YXR0YWNr\u0007\u001b[2J\u009b2Jname'
  const manager = {
    ...fakePluginManager(),
    listBundles: async () => [{
      name: 'missing-official', official: true, availability: 'missing',
      version: '1.0.0', enabled: false, installed: false, optional: true,
      removable: false, rows: [], overrides: [],
      installTarget: { spec: hostile, version: '1.0.0' },
    }],
    // The refused/errored inspect sends the editor back with the target seeded.
    inspect: async () => { throw new Error('inspect unavailable') },
  }
  const { vt, harness } = await mountPluginRunner(t, manager)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  vt.sendInput('\r') // Details
  await vt.waitForRender()
  vt.sendInput('\r') // Install… -> official inspect (fails back to the editor)
  for (let round = 0; round < 40 && !plain(vt.getViewport()).includes('Inspect'); round += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    await vt.waitForRender()
  }
  assert.match(plain(vt.getViewport()), /Inspect/, 'the errored inspect reached the seeded editor')
  const raw = vt.writes.join('')
  assert.ok(!raw.includes('YXR0YWNr'), `no OSC 52 payload from installTarget.spec reaches the TTY:\n${plain(vt.getViewport())}`)
  assert.ok(!raw.includes('\u009b'), 'no raw C1 byte from installTarget.spec reaches the TTY')
  assert.match(plain(vt.getViewport()), /evilname/, 'the readable target survives the projection')
})

// ── D1-A09/A10 mounted-TuiApp L6 (real Host + real pnpm) ────────────────────
//
// PRODUCTION PREREQUISITES REPRODUCED
//   The official `@deepseek-ai/dsh-plugin-manager` Host over a real managed
//   profile, the production runner/TuiApp/Alt-Screen workspace, the real
//   controller/panel, and a real pnpm child against a loopback registry.
// TEST STAND-INS
//   The loopback registry and the tiny audit package/tarball created under the
//   test lifecycle; a minimal managed profile with no installed bundles.
// DELIBERATELY ABSENT
//   The public npm registry, the developer's real HOME/DSH_HOME/credentials,
//   and any paid/native provider.

const MOUNTED_PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'] as const

function mountedProfileFiles(dir: string): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const name of MOUNTED_PROFILE_FILES) {
    const path = join(dir, name)
    snapshot[name] = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }
  return snapshot
}

function serviceImplementation<T>(value: unknown): T {
  const original = (value as Record<symbol, unknown>)[symbols.original]
  return (original ?? value) as T
}

async function waitForFrame(
  vt: VirtualTerminal,
  pattern: RegExp,
  label: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = plain(vt.getViewport())
    if (pattern.test(last)) return last
    await settle()
    // The REAL Host inventory read spawns pnpm's config lookup: its child
    // process events only run on a macrotask turn, so a microtask-only poll
    // would starve the read and never paint the page.
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}; last frame:\n${last}`)
}

/** Bounded wait for a real Host fact (async child-process/IO turns included). */
async function waitForCondition(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface RealMountedPluginFixture {
  readonly vt: VirtualTerminal
  readonly harness: ReturnType<typeof makeHarness>
  readonly app: TuiApp
  readonly profileDir: string
  readonly registryUrl: string
  readonly dispatches: () => number
  /** The request ids the mounted UI actually dispatched to the real Host. */
  readonly installRequestIds: () => readonly string[]
  readonly waitForInstall: (requestId: string) => Promise<unknown>
}

async function mountRealPluginRunner(
  t: Parameters<typeof testLifecycle>[0],
  registryUrl: string,
): Promise<RealMountedPluginFixture> {
  const life = testLifecycle(t)
  // The SAME official Host composition used by the Remote L6 suites: the real
  // base-owned profileContext, Loader and @deepseek-ai/dsh-plugin-manager over
  // an isolated managed profile. Only the Client-side runner is added here.
  const host = await createRemoteApplicationHostFixture(life, 's5-pr-e-mounted', {
    pluginManagerProfile: { emptyProfile: true },
    isolateHome: true,
  })
  assert.ok(host.pluginManager !== undefined, 'the official Host fixture must provide the managed profile')
  const profileDir = host.pluginManager.profileDir
  const service = host.ctx.get('pluginManager')
  const implementation = serviceImplementation<{
    installBundle(spec: string, options?: unknown): Promise<unknown>
    waitForInstall(requestId: unknown): Promise<unknown>
  }>(service)
  const originalInstall = implementation.installBundle
  let dispatches = 0
  const installRequestIds: string[] = []
  implementation.installBundle = function patchedInstall(this: unknown, spec: string, options?: unknown): Promise<unknown> {
    dispatches += 1
    const requestId = (options as { requestId?: unknown } | undefined)?.requestId
    if (typeof requestId === 'string') installRequestIds.push(requestId)
    return originalInstall.call(this, spec, options)
  }
  t.after(() => { implementation.installBundle = originalInstall })

  const runnerCtx = new Context()
  life.defer(() => disposeContext(runnerCtx))
  runnerCtx.provide('pluginManager', service as never)
  // The real manager emits on its OWN Context; the Direct port subscribes on
  // the runner Context, so forward only the public manager events.
  const offEvents = (['plugin-manager/changed', 'plugin-manager/install-state', 'plugin-manager/install-log'] as const)
    .map(event => host.ctx.on(event, (payload: unknown) => { (runnerCtx as unknown as { emit(name: string, value: unknown): void }).emit(event, payload) }))
  life.defer(() => { for (const off of offEvents) off() })

  const home = join(host.workRoot, 'home')
  const harness = makeHarness(home)
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(120, 40)
  life.defer(installVirtualProcessTerminal(vt))
  const fiber = await mountRunner(runnerCtx, home, harness, {}, { fullscreen: 'off' })
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  return {
    vt,
    harness,
    app,
    profileDir,
    registryUrl,
    dispatches: () => dispatches,
    installRequestIds: () => installRequestIds,
    waitForInstall: requestId => implementation.waitForInstall(requestId),
  }
}

/** Open /plugins, select the test-owned loopback registry in the real install
 *  editor, inspect, and confirm one local fixture install. */
async function startMountedInstall(
  fixture: RealMountedPluginFixture,
  spec: string,
): Promise<void> {
  invokeCommand(fixture.harness, 'plugins')
  await waitForFrame(fixture.vt, /Settings · Plugins/u, 'the Plugin Manager page')
  fixture.vt.sendInput('i')
  await waitForFrame(fixture.vt, /Spec\s+/u, 'the install spec editor')
  fixture.vt.sendInput(spec)
  await fixture.vt.waitForRender()
  // The official Host fixture mounts the real manager without a configured
  // registry; the loopback package exists only at the test-owned registry, so
  // the real editor's explicit custom-registry field is used.
  fixture.vt.sendInput('\t')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\x1b[B')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\x1b[B')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput(fixture.registryUrl)
  await waitForFrame(fixture.vt, /Reg\s+> custom https?:\/\/127\.0\.0\.1:\d+/u, 'the loopback registry input')
  fixture.vt.sendInput('\r')
  await waitForFrame(fixture.vt, /Activates the bundle/u, 'the accepted inspection')
  fixture.vt.sendInput('\r')
  await waitForFrame(fixture.vt, /Stop installation|installing|Approve and retry/u, 'the real install to reach the Host')
}

test('mounted TuiApp: hide while installing, re-enter the same attempt, Stop, and restore the real Host profile', async (t) => {
  const packed = packFixturePackage(testLifecycle(t).tempDir('dsh-plugin-real-pkg-'), {
    name: '@s5-fixture/mounted-cancel', version: '0.0.1',
    manifest: { name: '@s5-fixture/mounted-cancel', version: '0.0.1', dsh: { bundle: { patch: [] } } },
  })
  const registry = await startLocalNpmRegistry(packed, {
    slowTarball: true,
    manifest: { name: packed.name, version: packed.version, dsh: { bundle: { patch: [] } } },
  })
  t.after(() => registry.close())
  const fixture = await mountRealPluginRunner(t, registry.url)
  const before = mountedProfileFiles(fixture.profileDir)
  await startMountedInstall(fixture, packed.name)
  const requestIds = fixture.installRequestIds()
  assert.equal(requestIds.length, 1, 'the mounted editor dispatched exactly one real Host request')
  const requestId = requestIds[0]!
  await registry.waitForTarballRequest()
  fixture.vt.sendInput('\x1b') // hide the install view while the real install runs
  await waitForFrame(fixture.vt, /Settings · Plugins/u, 'the list after hide')
  fixture.vt.sendInput('i') // re-enter the SAME attempt
  const resumed = await waitForFrame(fixture.vt, /Stop installation|installing/u, 'the resumed install view')
  assert.match(resumed, /installing · @s5-fixture\/mounted-cancel/u, 'the resumed view keeps the same running attempt')
  assert.match(resumed, /installing from https?:\/\/127\.0\.0\.1:\d+\/ \(1\/1\)/u,
    'the resumed view keeps the live Host progress (no reset to a blank attempt)')
  assert.equal(fixture.dispatches(), 1, 'hide/re-enter never dispatches a second install')
  assert.deepEqual(fixture.installRequestIds(), [requestId], 'the re-entered view owns the same Host request id')
  fixture.vt.sendInput('s') // real Stop
  await waitForFrame(fixture.vt, /cancelled/u, 'the real cancelled settlement')
  registry.releaseTarball()
  await waitForCondition('the Host to forget the settled request',
    async () => await fixture.waitForInstall(requestId) === null)
  await waitForCondition('the Host to restore every profile-owned file',
    () => JSON.stringify(mountedProfileFiles(fixture.profileDir)) === JSON.stringify(before))
  const after = JSON.parse(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  assert.equal(after.dependencies?.[packed.name], undefined, 'the cancelled install never lands in the profile manifest')
  assert.deepEqual(mountedProfileFiles(fixture.profileDir), before, 'the cancelled install restores every profile-owned file')
  assert.equal(existsSync(join(fixture.profileDir, 'node_modules', '@s5-fixture', 'mounted-cancel')), false)
})

test('mounted TuiApp: real pendingBuilds risk prompt, explicit keyboard approval, and the real marker', async (t) => {
  const packed = packFixturePackage(testLifecycle(t).tempDir('dsh-plugin-real-pkg-'), {
    name: '@s5-fixture/mounted-build', version: '0.0.1',
    manifest: {
      name: '@s5-fixture/mounted-build', version: '0.0.1', dsh: { bundle: { patch: [] } },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('approved.marker','approved')\"" },
    },
  })
  const registry = await startLocalNpmRegistry(packed, {
    manifest: {
      name: packed.name, version: packed.version, dsh: { bundle: { patch: [] } },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('approved.marker','approved')\"" },
    },
  })
  t.after(() => registry.close())
  const fixture = await mountRealPluginRunner(t, registry.url)
  await startMountedInstall(fixture, packed.name)
  assert.equal(fixture.dispatches(), 1, 'the first real Host attempt started from the mounted editor')
  const marker = join(fixture.profileDir, 'node_modules', '@s5-fixture', 'mounted-build', 'approved.marker')
  assert.equal(existsSync(marker), false, 'a blocked build never runs its script before approval')
  const failed = await waitForFrame(fixture.vt, /Approve and retry/u, 'the real pending-build risk', 120_000)
  assert.match(failed, /execute scripts with your user privileges/u, 'the full risk is painted')

  // The 80x10 mounted frame cannot paint the full risk, so it never advertises
  // the approval action; the script stays unrun.
  fixture.vt.resize(80, 10)
  await fixture.vt.waitForRender()
  assert.doesNotMatch(plain(fixture.vt.getViewport()), /Approve and retry/u,
    '80x10 hides approval while the risk is not fully painted')
  assert.equal(existsSync(marker), false, 'the unapproved build script never ran')
  fixture.vt.resize(120, 40)
  const restored = await waitForFrame(fixture.vt, /Approve and retry/u, 'the restored approval frame', 120_000)
  assert.match(restored, /execute scripts with your user privileges/u, 'the full risk is painted again')
  assert.match(restored, /> Approve and retry/u, 'the restored frame selects the approval action')
  fixture.vt.sendInput('\r') // explicit keyboard approval
  await waitForCondition('the approval to dispatch a second Host request', () => fixture.dispatches() === 2)
  const requestIds = fixture.installRequestIds()
  assert.equal(requestIds.length, 2, 'the approval is a distinct Host request')
  await waitForCondition('the approved request to settle',
    async () => await fixture.waitForInstall(requestIds[1]!) === null, 120_000)
  await waitForCondition('the settled install view', () => {
    const frame = plain(fixture.vt.getViewport())
    return /New install/u.test(frame) && !/Approve and retry/u.test(frame) && !/installing|Stop installation/u.test(frame)
  }, 120_000)
  const settled = plain(fixture.vt.getViewport())
  assert.doesNotMatch(settled, /Approve and retry/u, 'the approval action is gone after the settlement')
  assert.equal(fixture.dispatches(), 2, 'the approval dispatches exactly one new Host attempt')
  assert.equal(existsSync(marker), true, 'the approved build script wrote its marker')
  assert.equal(readFileSync(marker, 'utf8'), 'approved')
  const profile = JSON.parse(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  assert.match(profile.dependencies?.[packed.name] ?? '', /^\^?0\.0\.1$/u)
  assert.ok(profile.dsh?.profile?.bundles?.includes(packed.name))
})
