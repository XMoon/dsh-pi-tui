/**
 * M3 contract gate: the first-party builtins dogfood the public extension
 * API. A real Cordis tree (startup + extension host + builtins) + a real
 * TuiApp + VirtualTerminal proves:
 * - the version header badge renders;
 * - the turn/step footer segment renders and TRACKS state changes
 *   (replacing the host's hardcoded path — the host fallback is off when
 *   an extension host is attached, so parity is exact);
 * - builtins use the SAME service API as third-party plugins (no special
 *   host bypass).
 * @module @xmoon76/dsh-pi-tui/builtins.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Text } from '@xmoon76/pi-tui'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import type { PiTuiExtensionService } from '../src/extensions.ts'
import { apply as applyBuiltins } from '../src/builtins.ts'
import type { HeaderBadge } from '../src/extension/public-types.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { TuiApp } from '../src/tui-app.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Mount startup + extension host + builtins; returns the builtins fiber. */
async function mountTree(ctx: Context): Promise<{ builtinsFiber: unknown }> {
  await ctx.plugin(Loader)
  const startupFiber = ctx.plugin((c) => {
    c.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
  })
  await startupFiber
  const hostFiber = ctx.plugin(applyExtensionHost)
  await hostFiber
  const builtinsFiber = ctx.plugin(applyBuiltins)
  await builtinsFiber
  return { builtinsFiber }
}

test('builtins register the version badge and the turn/step footer segment through the PUBLIC service API', async () => {
  const ctx = new Context()
  try {
    await mountTree(ctx)
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): { snapshot(slot: string): { records: Array<{ id: string }> } }
    }
    const badgeIds = service._ledger().snapshot('chrome.header.badge').records.map(record => record.id)
    assert.ok(badgeIds.includes('builtin-version'), `version badge missing: ${badgeIds.join(', ')}`)
    const footerIds = service._ledger().snapshot('chrome.footer.status').records.map(record => record.id)
    assert.ok(footerIds.includes('builtin-turns-steps'), `turn/step segment missing: ${footerIds.join(', ')}`)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the builtins render into a live TuiApp and the turn/step counter tracks state (host parity)', async () => {
  const ctx = new Context()
  try {
    await mountTree(ctx)
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
    }
    const vt = new VirtualTerminal(80, 24)
    const host = new SurfaceHost(service._ledger(), () => app.requestRender())
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    await vt.waitForRender()
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: 'tui', generation: 1, width: 80, height: 24, fullscreen: false,
      focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    // Simulate the runner's attachSurface wiring (F-10): the service's
    // state bridge + capability set go live so the builtins' pending state
    // subscription delivers.
    service.attachSurface(
      { subscribe: (listener) => host.subscribeState(listener as never) },
      host.capabilitiesOf() as ReadonlySet<string>,
      host.surfaceId,
    )
    // F-10 (F8): the capability set is LIVE after attachSurface.
    const apiService = service as unknown as { api(): { capabilities: Set<string> } }
    assert.ok(apiService.api().capabilities.has('slot.chrome.header.badge'), 'capabilities must be live after attach')
    app.refreshChrome()
    await settle()
    await vt.waitForRender()

    let view = vt.getViewport().join('\n')
    // Version badge after the host title; the footer shows t0/s0 from the
    // builtin segment (the host's hardcoded path is OFF with a host).
    assert.ok(view.includes('dsh-pi-tui'), `host title missing:\n${view}`)
    // Version badge: the installed dsh version first, then the bundle
    // version prefixed `tui-` (`[dsh-… · tui-vX.Y.Z]`); without a dsh
    // launcher (as in tests) it degrades to `[tui-vX.Y.Z]`.
    assert.ok(/\[tui-v\d+\.\d+\.\d+\]/.test(view), `version badge missing:\n${view}`)
    assert.ok(view.includes('t0/s0'), `initial turn/step counter missing:\n${view}`)

    // State change: the builtin segment re-bakes (async producer → replace).
    app.setStatus({ model: 'm', cwd: '/w', branch: '', turns: 3, steps: 7, statsLine: '' })
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('t3/s7'), `turn/step counter did not track state:\n${view}`)
    assert.ok(!view.includes('t0/s0'), `stale counter survived:\n${view}`)

    // P1-5: the todo summary flows through the builtin DOCK item (the host
    // renders it directly only WITHOUT an extension host). setTodoSummary
    // mirrors the summary text into the activity snapshot; the builtin
    // dock item renders it.
    app.setTodoSummary([
      { content: 'write tests', status: 'in_progress' },
      { content: 'ship', status: 'pending' },
    ])
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('2 active · write tests'), `todo summary dock item missing (P1-5):\n${view}`)
    // Clearing the list hides the dock item.
    app.setTodoSummary([])
    await settle()
    await vt.waitForRender()
    assert.ok(!vt.getViewport().join('\n').includes('write tests'), `cleared todo dock item survived (P1-5)`)

    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('builtins unload with their owner fiber (HMR parity)', async () => {
  const ctx = new Context()
  try {
    const { builtinsFiber } = await mountTree(ctx)
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): { snapshot(slot: string): { records: Array<{ id: string }> } }
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
    }
    // Attach a state bridge so the builtin's subscribeState calls go live;
    // their disposers must be fiber-bound (F1 — no listener leak on
    // unload). Two builtin subscriptions exist: turn/step counters and the
    // todo-summary dock item (P1-5).
    let subscribed = 0
    const fakeBridge = { subscribe: () => { subscribed += 1; return () => { subscribed -= 1 } } }
    service.attachSurface(fakeBridge as never, new Set(), 'fake-surface')
    assert.equal(subscribed, 2, 'both builtin state listeners must be live after attach')
    // Unload the builtins fiber: its registrations AND its state
    // subscription must disappear.
    await (builtinsFiber as { dispose(): Promise<void> }).dispose()
    await settle()
    const badgeIds = service._ledger().snapshot('chrome.header.badge').records.map(record => record.id)
    assert.ok(!badgeIds.includes('builtin-version'), `version badge survived builtins unload: ${badgeIds.join(', ')}`)
    assert.equal(subscribed, 0, `the state listener leaked after builtins unload (F1): ${subscribed}`)
    assert.equal(
      (service as unknown as { _listenerUnsubscribersSize(): number })._listenerUnsubscribersSize(),
      0,
      'the listenerUnsubscribers map must be empty after owner unload (round-2 finding 1)',
    )
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('P0-1: a plugin following the README example registers BEFORE any surface exists (advertised capabilities)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide('tuiStartup', { shippedPresetRoot: '/ws' })
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber

    // A THIRD-PARTY-shaped plugin exactly like the README example: it
    // feature-detects the slot capability and registers. It runs BEFORE
    // any surface is attached — the service is provided, the runner has
    // not created the TUI yet. The advertised capabilities (P0-1) make the
    // feature-detect succeed in this window.
    let registered = false
    const pluginFiber = ctx.plugin((c) => {
      const service = c.get('piTuiExtensions') as PiTuiExtensionService
      if (!service.api().capabilities.has('slot.chrome.header.badge')) return
      service.register<HeaderBadge>('chrome.header.badge', { id: 'pre-surface' }, { text: 'pre-surface' })
      registered = true
    })
    await pluginFiber

    // The plugin must have registered even though no surface exists yet.
    assert.equal(registered, true, 'the plugin must feature-detect the slot capability BEFORE any surface (P0-1)')

    // Attach a surface afterwards: the contribution renders.
    const service = ctx.get('piTuiExtensions') as {
      _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
    }
    const vt = new VirtualTerminal(80, 24)
    const host = new SurfaceHost(service._ledger(), () => app.requestRender())
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    await vt.waitForRender()
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: host.surfaceId, generation: 1, width: 80, height: 24, fullscreen: false,
      focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    app.refreshChrome()
    await settle()
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('pre-surface'), `pre-surface registration must render after attach (P0-1):\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the version badge shows the dsh version first, then the tui- bundle version', async () => {
  // Point the launcher at a fabricated @deepseek-ai/dsh package so the
  // shared dshVersion() resolves: bin → ../../package.json named dsh.
  const root = mkdtempSync(join(tmpdir(), 'dsh-version-badge-'))
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'bin'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1' }))
  const bin = join(dshDir, 'bin', 'dsh')
  writeFileSync(bin, '')
  const previousArgv = process.argv[1]
  process.argv[1] = bin
  try {
    const ctx = new Context()
    try {
      await mountTree(ctx)
      const service = ctx.get('piTuiExtensions') as {
        _ledger(): import('../src/extension/internal/ledger.ts').ExtensionLedger
      }
      const host = new SurfaceHost(service._ledger(), () => app.requestRender())
      const vt = new VirtualTerminal(90, 24)
      const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
      app.start()
      await vt.waitForRender()
      host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
        surfaceId: host.surfaceId, generation: 1, width: 90, height: 24, fullscreen: false,
        focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
      })
      app.refreshChrome()
      await settle()
      await vt.waitForRender()
      const view = vt.getViewport().join('\n')
      assert.ok(
        /\[dsh-0\.1\.1-rc\.1 · tui-v\d+\.\d+\.\d+\]/.test(view),
        `dsh-first badge missing:\n${view}`,
      )
      app.stop()
    } finally {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
      }
    }
  } finally {
    process.argv[1] = previousArgv
  }
})
