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
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../src/tui-app.ts'
import {
  disposeContext,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  settle,
} from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
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

function invokeCommand(harness: ReturnType<typeof makeHarness>, name: string): void {
  const handler = (harness.commands as { handler: (command: string) => ((invocation: unknown) => unknown) | undefined }).handler(name)
  assert.ok(handler !== undefined, `/${name} must be registered by the real runner`)
  handler({
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

test('the real /plugins entry opens the fullscreen page and Escape closes back to the editor', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  const view = plain(vt.getViewport())
  assert.match(view, /Plugins · All/, 'the direct entry mounts the fullscreen page')
  assert.match(view, /No plugins/, 'the empty inventory paints an honest empty state')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugins · All/, 'Escape closes the page')
})

test('closing /plugins restores transcript-fullscreen mode and the live editor draft', async (t) => {
  const { vt, harness, app } = await mountPluginRunner(t)
  const draft = 'draft survives the plugin manager round trip'
  app.setDraft(draft)
  app.setFullscreen(true)
  await vt.waitForRender()

  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugins · All/)

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true, 'the transcript-fullscreen mode is restored')
  assert.equal(app.getDraft(), draft, 'the live editor draft is untouched')
})

test('a second /plugins while open is a no-op, and a later open still mounts (owner released)', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  // A second open must not stack a second page/owner.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugins · All/)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The owner was released: the direct entry mounts again.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugins · All/, 'a later /plugins mounts normally')
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('the real Settings → Plugins category hosts the same page in place and Back returns to Settings', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Settings · Categories/)
  // L0 starts on Appearance; move to Plugins (third category) and open it.
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  const pluginView = plain(vt.getViewport())
  assert.match(pluginView, /Plugins · All/, 'the Settings entry hosts the same fullscreen page')
  // Back (Escape) returns to the SAME Settings surface, not to the editor.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const backView = plain(vt.getViewport())
  assert.doesNotMatch(backView, /Plugins · All/)
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
  assert.match(plain(vt.getViewport()), /Plugins · All/)

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'blocking-owner probe' })
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugins · All/, 'the blocking owner pre-empts the workspace')
  vt.sendInput('\x1b')
  await approval.catch(() => {})

  // The owner was released with the pre-empted workspace: a later direct entry
  // mounts normally instead of reporting a phantom lease.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugins · All/)
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('an external surface teardown releases the Manager owner so a later /plugins still opens', async (t) => {
  const { vt, harness, app } = await mountPluginRunner(t)
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugins · All/, 'the Settings entry hosts the shared page')

  // External teardown through the surface lifecycle: the whole screen (and the
  // hosted page) is released WITHOUT the page's normal close path.
  app.stop()
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugins · All/, 'the external teardown hides the hosted page')
  app.start()
  await vt.waitForRender()

  // The owner was released with the parent: the direct entry opens normally
  // (no phantom active host) and closes cleanly.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugins · All/, 'a later /plugins opens after the external teardown')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugins · All/)
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
  }
  const { vt, harness } = await mountPluginRunner(t, manager)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  vt.sendInput('\r') // open Details; the row action label carries entryId
  await vt.waitForRender()
  const raw = vt.writes.join('')
  assert.ok(!raw.includes('YXR0YWNr'), `no OSC 52 payload from plugin metadata reaches the TTY:\n${plain(vt.getViewport())}`)
  assert.ok(!raw.includes('\u009b'), 'no raw C1 byte from plugin metadata reaches the TTY')
  assert.match(plain(vt.getViewport()), /evil/, 'the readable plugin metadata survives the projection')
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
  vt.sendInput('\r') // Install… -> official inspect
  await vt.waitForRender()
  const raw = vt.writes.join('')
  assert.ok(!raw.includes('YXR0YWNr'), `no OSC 52 payload from installTarget.spec reaches the TTY:\n${plain(vt.getViewport())}`)
  assert.ok(!raw.includes('\u009b'), 'no raw C1 byte from installTarget.spec reaches the TTY')
  assert.match(plain(vt.getViewport()), /evilname/, 'the readable target survives the projection')
})
