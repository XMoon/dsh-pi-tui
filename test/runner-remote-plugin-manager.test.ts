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
 * DELIBERATELY ABSENT
 * - real package installation (the network/pnpm install L6-F scenario is
 *   retained at the L5 Remote-event level, the `L5:` scenario below; this suite
 *   does not claim it as L6)
 * - Task Center / child viewer, Job viewer, public Remote selector, global
 *   reconnect/HMR closure outside the Plugin Manager invalidation
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-plugin-manager.test
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import { RemotePluginManagerPort } from '../src/runtime/remote/plugin-manager-remote.ts'
import type { PluginInstallEvent } from '../src/runtime/plugin-manager-port.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function plain(lines: readonly string[]): string {
  return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

/** The content of the one selected (▸-marked) row of the current viewport. */
function selectedRow(viewport: readonly string[]): string | undefined {
  const line = plain(viewport).split('\n').find(candidate => candidate.includes('▸ '))
  if (line === undefined) return undefined
  return line.slice(line.indexOf('▸ ') + '▸ '.length).trim()
}

/** The rendered list/detail line carrying one bundle name. */
function bundleLine(viewport: readonly string[], bundleName: string): string | undefined {
  return plain(viewport).split('\n').find(line => line.includes(bundleName))
}

async function settle(ms = 80): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Fixture {
  host: Awaited<ReturnType<typeof import('./support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>
  vt: VirtualTerminal
  aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  app(): { setDraft(text: string): void; submitDraft(): void }
}

async function mountPluginManagerRunner(life: TestLifecycle): Promise<Fixture> {
  const { createRemoteApplicationHostFixture, PLUGIN_MANAGER_FIXTURE_BUNDLE } =
    await import('./support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, 'm3-5-pr4-plugin-preset', {
    pluginManagerProfile: true,
  })
  assert.ok(host.pluginManager !== undefined)
  assert.equal(host.pluginManager.bundleName, PLUGIN_MANAGER_FIXTURE_BUNDLE)

  const runnerCtx = host.ctx
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: undefined, shippedPresetRoot: host.workRoot })

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

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
 * for the authoritative reread to repaint the enabled truth. Returns with the
 * panel in DETAIL mode.
 */
async function enableFixtureBundleThroughPanel(fixture: Fixture, bundle: string): Promise<void> {
  await selectListRow(fixture.vt, bundle)
  fixture.vt.sendInput('\r')
  await waitFor('the fixture bundle detail offers the official Enable action', () =>
    /\bEnable\b/.test(plain(fixture.vt.getViewport())), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the panel repaints the enabled truth from the authoritative reread', () =>
    /\bDisable\b/.test(plain(fixture.vt.getViewport())), 20_000)
}

test('L6-A: the real Remote /plugins reads the real Host PluginManager through the generated Remote', async (t) => {
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
  assert.match(view, /Plugin Manager/)
  assert.match(view, /Current TUI/)
  assert.match(view, /@xmoon76\/dsh-pi-tui/)
  // A distinctive bundle that exists ONLY in the fixture's managed profile:
  // its presence proves the read traversed Host manifest -> generated Remote ->
  // adapter -> controller -> panel.
  const line = bundleLine(fixture.vt.getViewport(), bundle)
  assert.ok(line !== undefined, 'the fixture bundle row is visible')
  assert.match(line, /disabled/, 'the fixture bundle starts disabled (Host truth)')
})

test('L6-B: the Settings → Plugins entry hosts the SAME Remote controller/panel and Back returns', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountPluginManagerRunner(life)

  submit(fixture, '/settings')
  await waitFor('the Settings surface opens', () => /Type to search/.test(plain(fixture.vt.getViewport())), 20_000)
  for (const character of 'plugins') fixture.vt.sendInput(character)
  await fixture.vt.waitForRender()
  assert.match(plain(fixture.vt.getViewport()), /Manage…/)
  fixture.vt.sendInput('\r')
  await waitFor('the Plugin Manager panel opens from Settings', () =>
    /Plugin Manager/.test(plain(fixture.vt.getViewport())), 20_000)
  // Same owner: the Remote inventory read is live on this entry too.
  await waitFor('the same Remote inventory renders', () =>
    plain(fixture.vt.getViewport()).includes(fixture.host.pluginManager!.bundleName), 20_000)

  fixture.vt.sendInput('\x1b')
  await waitFor('Back returns to the SAME Settings surface', () =>
    /Manage…/.test(plain(fixture.vt.getViewport())), 20_000)
  assert.doesNotMatch(plain(fixture.vt.getViewport()), /Plugin Manager/)

  fixture.vt.sendInput('\x1b')
  await waitFor('closing Settings returns to the editor', () =>
    !/Type to search/.test(plain(fixture.vt.getViewport())), 20_000)
})

test('L6-C: one real Remote mutation reaches Host authority and the authoritative reread repaints', async (t) => {
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
  const detail = plain(fixture.vt.getViewport())
  assert.match(detail, /enabled · DSH plugin/, 'the reread renders the enabled status')
  assert.doesNotMatch(detail, /disabled · DSH plugin/, 'the stale disabled truth is gone')

  // Truthful disposition: no hmr in this composition, so the Host reports
  // restart-required rather than pretending a live application.
  fixture.vt.sendInput('\x1b')
  await waitFor('the truthful restart-required disposition is shown', () =>
    /restart the profile to apply/.test(plain(fixture.vt.getViewport())), 20_000)
})

test('L6-D: an external Host change invalidates an open Remote panel with no manual refresh', async (t) => {
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
    (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('active'), 20_000)
})

test('L6-E: a new Connection generation rereads authoritative truth without replaying the prior mutation', async (t) => {
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
    && (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('active'), 20_000)

  // External hand edit: authoritative truth becomes DISABLED and NOTHING is
  // announced (the official manager only announces its own operations).
  writeProfileBundles(profile.profileDir, [])
  await settle(250)
  assert.match(bundleLine(fixture.vt.getViewport(), bundle) ?? '', /active/,
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
    (bundleLine(fixture.vt.getViewport(), bundle) ?? '').includes('disabled'), 20_000)

  // The REPLAY-NEGATIVE: the earlier Enable really happened, so a reconnect
  // that replayed it would flip the durable Host truth back to selected (and
  // the reread would repaint `active`). It must stay exactly the hand edit.
  assert.deepEqual([...profile.selectedBundles()], [],
    'reconnect rereads only; it never replays the earlier Enable mutation')
})

test('L5: the real forwarded install events reach the Remote adapter by exact request id', async (t) => {
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
  // test/plugin-manager-install.test.ts and test/plugin-manager-port.test.ts.)
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
