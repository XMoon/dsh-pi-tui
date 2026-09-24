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

async function mountPluginRunner(t: Parameters<typeof testLifecycle>[0]): Promise<{
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
  ctx.provide('pluginManager', fakePluginManager() as never)
  const fiber = await mountRunner(ctx, home, harness, {}, { fullscreen: 'off' })
  await settle()
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  return { vt, harness, app }
}

test('the real /plugins entry opens the shared panel and Escape closes it back to the editor', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugin Manager/, 'the direct entry mounts the shared panel')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugin Manager/, 'Escape closes the panel')
})

test('a second /plugins while open is a no-op, and a later open still mounts (owner released)', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  // A second open must not stack a second panel/owner.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugin Manager/)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The owner was released: the direct entry mounts again.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugin Manager/, 'a later /plugins mounts normally')
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('the real /settings → Plugins Manage… row hosts the same panel and Back returns to Settings', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  // Filter the settings list down to the Plugins row, then activate it.
  for (const character of 'plugins') vt.sendInput(character)
  await vt.waitForRender()
  const settingsView = plain(vt.getViewport())
  assert.match(settingsView, /Plugins/)
  assert.match(settingsView, /Manage…/)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugin Manager/, 'the Settings entry hosts the shared panel')
  // Back (Escape) returns to the SAME Settings surface, not to the editor.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const backView = plain(vt.getViewport())
  assert.doesNotMatch(backView, /Plugin Manager/)
  assert.match(backView, /Manage…/, 'Back returns to the Settings list')
  assert.match(backView, /Type to search/, 'the Settings search surface is back')
  // Closing Settings returns to the editor.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const editorView = plain(vt.getViewport())
  assert.doesNotMatch(editorView, /Type to search/, 'closing Settings returns to the editor')
})

test('an external Settings parent teardown releases the Manager owner so a later /plugins still opens', async (t) => {
  const { vt, harness } = await mountPluginRunner(t)
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  for (const character of 'plugins') vt.sendInput(character)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugin Manager/, 'the Settings entry hosts the shared panel')

  // External parent teardown: re-open Settings, which replaces the parent
  // overlay WITHOUT a user Back (the submenu's own close path never runs).
  invokeCommand(harness, 'settings')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugin Manager/, 'the external teardown hides the hosted panel')
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // The owner was released with the parent: the direct entry opens normally
  // (no phantom active host) and closes cleanly.
  invokeCommand(harness, 'plugins')
  await vt.waitForRender()
  assert.match(plain(vt.getViewport()), /Plugin Manager/, 'a later /plugins opens after the external teardown')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(plain(vt.getViewport()), /Plugin Manager/)
})
