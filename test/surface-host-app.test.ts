/**
 * M2 contract gate: the SurfaceHost attached to a live TuiApp. Extension
 * registrations (through the real Cordis service) render into the host's
 * header/dock/footer chrome; state setters mirror into the immutable
 * snapshots; disposal detaches cleanly. Regular AND fullscreen both refresh
 * through the active screen.
 * @module @xmoon76/dsh-pi-tui/surface-host-app.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Text } from '@xmoon76/pi-tui'
import { setTheme } from '../src/theme.ts'
import type { DockItem, HeaderBadge } from '../src/extension/public-types.ts'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import { TuiApp } from '../src/tui-app.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function makeApp(ledger: ExtensionLedger): { vt: VirtualTerminal; app: TuiApp; host: SurfaceHost } {
  const vt = new VirtualTerminal(80, 24)
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  return { vt, app, host }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('extension badges/dock/footer render into the TuiApp chrome', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  // Attach the host chrome (the runner does this once per generation).
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()

  // A plugin registers a header badge + a dock item + a footer segment.
  ledger.register('chrome.header.badge', { id: 'ext' }, { text: 'ext', tone: 'warning' }, 'plugin-a')
  ledger.register('input.dock.item', { id: 'ext-dock' }, {
    label: [{ text: 'ext-dock-item' }],
  }, 'plugin-a')
  ledger.register('chrome.footer.status', { id: 'ext-footer' }, {
    spans: [{ text: 'EXT' }],
  }, 'plugin-a')
  host.refreshOutlets()
  // The host re-renders its chrome rows after extension content changes.
  app.refreshChrome()
  app.setStatus({ model: 'm', cwd: '/w', branch: '', turns: 1, steps: 1, statsLine: '' })
  await vt.waitForRender()

  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('[ext]'), `header badge missing:\n${view}`)
  assert.ok(view.includes('ext-dock-item'), `dock item missing:\n${view}`)
  assert.ok(view.includes('EXT'), `footer segment missing:\n${view}`)
  app.stop()
})

test('extension state setters mirror into immutable snapshots', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  app.setStatus({ model: 'm1', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: 'workspace-write' })
  app.setTasks([{ id: 't1', label: 'build', status: 'running', kind: 'bash' }])
  app.setAgents([{ id: 'a1', label: 'child', activity: 'running' }])
  app.setQueueItems([{ id: 'q1', text: 'follow up', mode: 'followup' }])
  app.setTodoSummary([{ content: 'todo', status: 'in_progress' }])
  app.setPlanMode(true)
  await settle()

  const activity = host.state().activity
  assert.equal(activity.taskCount, 1)
  assert.equal(activity.childAgentCount, 1)
  assert.equal(activity.queuedCount, 1)
  assert.equal(activity.todoCount, 1)
  const session = host.state().session
  assert.equal(session.model, 'm1')
  assert.equal(session.cwd, '/ws')
  assert.equal(session.branch, 'main')
  assert.equal(session.permission, 'workspace-write')
  assert.equal(session.planMode, true)
  // The review-round mirrors: todoCount through setTodoSummary alone (the
  // count must DIFFER from the earlier mirror to be a real gate — F-13),
  // busy through setWorking, sessionId/workspaceRoot through setWelcomeCard.
  app.setTodoSummary([
    { content: 'todo one', status: 'pending' },
    { content: 'todo two', status: 'in_progress' },
  ])
  await settle()
  assert.equal(host.state().activity.todoCount, 2, 'setTodoSummary must mirror todoCount')
  app.setBusy(true)
  await settle()
  assert.equal(host.state().session.busy, true, 'setBusy must mirror busy')
  app.setWorking(true)
  await settle()
  assert.equal(host.state().activity.working, true, 'setWorking must mirror the working indicator')
  app.setBusy(false)
  await settle()
  assert.equal(host.state().session.busy, false, 'setBusy(false) must clear busy')
  app.setWorking(false)
  app.setWelcomeCard({ cwd: '/ws', sessionId: 'sid-1', model: 'm1', version: '1.0' })
  await settle()
  assert.equal(host.state().session.sessionId, 'sid-1')
  assert.equal(host.state().session.workspaceRoot, '/ws')
  // The surface slice tracks fullscreen + theme switches.
  app.setFullscreen(true)
  await settle()
  assert.equal(host.state().surface.fullscreen, true)
  app.applyTheme('light')
  await settle()
  assert.equal(host.state().surface.themeId, 'light')
  assert.ok(host.state().surface.themeRevision > 0)
  app.stop()
})

test('fullscreen refresh keeps extension chrome on the alt screen', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  // Reset the global palette: an earlier test may have switched it (F-14
  // assertions must start from a known state).
  setTheme('dark')
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  // The badge tone is 'warning' so a theme switch must RE-BAKE the ANSI.
  // The viewport strips ANSI (translateToString), so assert on the outlet
  // text bytes, RELATIVELY: the bytes must change when the palette changes
  // (the absolute dark/light hex depends on the global palette state left
  // by earlier tests — F-14).
  ledger.register('chrome.header.badge', { id: 'fs' }, { text: 'fsbadge', tone: 'warning' }, 'plugin-a')
  host.refreshOutlets()
  app.refreshChrome()
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('fsbadge'), `header badge missing in fullscreen:\n${view}`)
  const darkBytes = host.headerBadgeText()
  assert.ok(darkBytes.includes('\x1b['), `badge must carry ANSI styling (F-14): ${darkBytes}`)
  // Theme switch re-renders every surface including outlets.
  app.applyTheme('light')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('fsbadge'), `header badge missing after theme switch:\n${view}`)
  const lightBytes = host.headerBadgeText()
  assert.notEqual(lightBytes, darkBytes, `a theme switch must re-bake the badge ANSI (F-14): ${lightBytes} vs ${darkBytes}`)
  app.setFullscreen(false)
  app.stop()
})

test('dispose detaches the extension host (stale outlets are inert)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  ledger.register('chrome.header.badge', { id: 'gone' }, { text: 'goner' }, 'plugin-a')
  host.refreshOutlets()
  app.refreshChrome()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('goner'))
  app.dispose()
  assert.equal(host.isDisposed(), true)
  // Stale outlet refresh after dispose: benign no-op.
  host.refreshOutlets()
  await settle()
  assert.equal(host.capabilitiesOf().size, 0)
})

test('a throwing contribution recovers after a successful replace (P2: health recovery)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  // A badge whose text getter THROWS (a hostile contribution): the outlet
  // must isolate it (P1-4) and record the failure.
  const handle = ledger.register('chrome.header.badge', { id: 'fragile' }, {
    get text(): string { throw new Error('badge exploded') },
  } as unknown as HeaderBadge, 'plugin-a')
  host.refreshOutlets()
  await settle()
  let health = ledger.healthSnapshot().find(record => record.id === 'fragile')
  assert.equal(health?.state, 'failed', 'a throwing contribution must be recorded failed')
  assert.ok(health?.lastError?.includes('badge exploded'))

  // Replace with a VALID badge: the outlet renders it successfully and
  // clears the failure (P2: recovery — the record is active again).
  handle.replace({ text: 'recovered' })
  host.refreshOutlets()
  await settle()
  health = ledger.healthSnapshot().find(record => record.id === 'fragile')
  assert.equal(health?.state, 'active', 'a successful render must clear the failure (P2)')
  assert.equal(health?.errorGeneration, undefined)
  assert.equal(health?.lastError, undefined)
  assert.ok(host.headerBadgeText().includes('recovered'), 'the recovered badge must render')

  // A NEW failure after recovery starts a NEW generation.
  handle.replace({ get text(): string { throw new Error('second boom') } } as unknown as HeaderBadge)
  host.refreshOutlets()
  await settle()
  health = ledger.healthSnapshot().find(record => record.id === 'fragile')
  assert.equal(health?.state, 'failed')
  assert.equal(health?.errorGeneration, 2, 'a post-recovery failure must start a NEW generation (P2)')
  app.stop()
})

test('an EMPTY dock contribution recovers health too (P2-2: abdication is a successful render)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  const handle = ledger.register('input.dock.item', { id: 'empty-rec' }, {
    get label(): never { throw new Error('dock exploded') },
  } as unknown as DockItem, 'plugin-a')
  host.refreshOutlets()
  await settle()
  let health = ledger.healthSnapshot().find(record => record.id === 'empty-rec')
  assert.equal(health?.state, 'failed', 'a throwing dock contribution must be recorded failed')

  // Replace with a VALID EMPTY label: `{ label: [] }` is a legitimate
  // no-display abdication — the outlet must treat it as a successful
  // render and clear the failure (P2-2).
  handle.replace({ label: [] } satisfies DockItem)
  host.refreshOutlets()
  await settle()
  health = ledger.healthSnapshot().find(record => record.id === 'empty-rec')
  assert.equal(health?.state, 'active', 'an empty dock render must clear the failure (P2-2)')
  assert.equal(health?.errorGeneration, undefined)
  assert.equal(host.dockText(), '', 'an empty dock renders nothing')
  app.stop()
})

test('a Cordis plugin registering through the real service renders into the surface', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    // Mount a minimal tuiStartup provider + the extension host + a plugin.
    const startupFiber = ctx.plugin((c) => {
      c.provide('tuiStartup', { shippedPresetRoot: '/ws' })
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber

    const pluginFiber = ctx.plugin((c) => {
      const service = c.get('piTuiExtensions') as {
        register(slot: string, spec: { id: string }, value: { text: string }): unknown
      }
      service.register('chrome.header.badge', { id: 'cordis-badge' }, { text: 'cordis-badge' })
    })
    await pluginFiber

    // The service's ledger now holds the contribution; a SurfaceHost over
    // that ledger renders it.
    const service = ctx.get('piTuiExtensions') as { _ledger(): ExtensionLedger }
    const vt = new VirtualTerminal(80, 24)
    const host = new SurfaceHost(service._ledger(), () => app.requestRender())
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    await vt.waitForRender()
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
      focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    app.refreshChrome()
    host.refreshOutlets()
    app.setStatus({ model: 'm', cwd: '/w', branch: '', turns: 0, steps: 0, statsLine: '' })
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('cordis-badge'), `cordis-registered badge missing:\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('surface recreation keeps caller-owned registrations alive; old handles stay live (P1-2)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host: hostA } = makeApp(ledger)
  await vt.waitForRender()
  hostA.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 'a', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  // A caller fiber registers a badge (the registration is caller-owned,
  // NOT surface-owned — P1-2).
  const handleA = ledger.register('chrome.header.badge', { id: 'gen-a' }, { text: 'A' }, 'plugin-a')
  hostA.refreshOutlets()
  app.refreshChrome()
  await settle()
  assert.ok(hostA.headerBadgeText().includes('A'))

  // Host B attaches (a NEW surface generation) to the SAME ledger.
  const hostB = new SurfaceHost(ledger, () => app.requestRender())
  hostB.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 'b', generation: 2, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  hostB.refreshOutlets()
  await settle()
  assert.ok(hostB.headerBadgeText().includes('A'), `the still-live registration must render on the NEW surface (P1-2):\n${hostB.headerBadgeText()}`)

  // Dispose the OLD host A: it is a LEDGER CONSUMER — dispose stops
  // consuming; the registration and the old handle stay fully live.
  hostA.dispose()
  await settle()
  handleA.replace({ text: 'A-mutated' } as HeaderBadge)
  hostB.refreshOutlets()
  await settle()
  assert.ok(hostB.headerBadgeText().includes('A-mutated'), `the OLD handle must still mutate the NEWER surface (P1-2):\n${hostB.headerBadgeText()}`)

  // A second recreation (host C) still sees the same live registration.
  const hostC = new SurfaceHost(ledger, () => app.requestRender())
  hostC.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 'c', generation: 3, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  hostC.refreshOutlets()
  await settle()
  assert.ok(hostC.headerBadgeText().includes('A-mutated'), `a second recreation must keep rendering the live registration (P1-2):\n${hostC.headerBadgeText()}`)
  // Only the caller-fiber unload (or an explicit dispose) removes it.
  handleA.dispose()
  hostC.refreshOutlets()
  await settle()
  assert.ok(!hostC.headerBadgeText().includes('A-mutated'), 'an explicit dispose must remove the contribution')
  app.stop()
})

test('a plugin invalidate after attach reaches the screen WITHOUT a manual refreshChrome (F-17)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  // Register AFTER attach: the ledger sink (wired by attach) must re-bake
  // the outlet AND re-merge the chrome on the batched flush — no manual
  // refreshOutlets/refreshChrome call.
  ledger.register('chrome.header.badge', { id: 'late' }, { text: 'late-badge', tone: 'warning' }, 'plugin-a')
  await settle()
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('late-badge'), `post-attach registration must reach the screen (F-17):\n${view}`)
  // A replace also re-bakes (F-16) — no manual refresh needed.
  const handle = ledger.register('chrome.header.badge', { id: 'rep' }, { text: 'v1' }, 'plugin-a')
  await settle()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('v1'))
  handle.replace({ text: 'v2', tone: 'success' } as HeaderBadge)
  await settle()
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('v2'), `replace() must reach the screen (F-16):\n${view}`)
  assert.ok(!view.includes('v1'), `stale v1 survived replace (F-16):\n${view}`)
  // A batch of invalidations in one tick: ONE flush (the batcher).
  let flushes = 0
  host.setChromeRefresher(() => { flushes += 1 })
  handle.invalidate()
  handle.invalidate()
  handle.replace({ text: 'v3' })
  await settle()
  assert.ok(flushes <= 2, `invalidation burst must coalesce (${flushes} flushes)`)
  // In-place mutation + invalidate() must reach the screen (round-4
  // finding 2): the handle's invalidate bumps the ledger revision. Assert
  // on the outlet text (the viewport wraps long badge runs). The mutation
  // is IN PLACE on the registration's value object (record.value.text =
  // ...), matching how a plugin mutates its own contribution object.
  const mutable = ledger.register('chrome.header.badge', { id: 'mut' }, { text: 'm1' } as HeaderBadge, 'plugin-a')
  await settle()
  await vt.waitForRender()
  assert.ok(host.headerBadgeText().includes('[m1]'), `m1 missing after register: ${host.headerBadgeText()}`)
  const record = ledger.snapshot<HeaderBadge>('chrome.header.badge').records.find(r => r.id === 'mut')
  ;(record!.value as { text: string }).text = 'm2'
  mutable.invalidate()
  await settle()
  await vt.waitForRender()
  assert.ok(host.headerBadgeText().includes('[m2]'), `invalidate() must re-bake an in-place mutation (round-4 finding 2): ${host.headerBadgeText()}`)
  assert.ok(!host.headerBadgeText().includes('[m1]'), `stale m1 survived invalidate (round-4 finding 2): ${host.headerBadgeText()}`)
  app.stop()
})

test('setFooterPreset compact drops low-importance extension segments on an ALREADY-BAKED host (round-4 finding 1)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  ledger.register('chrome.footer.status', { id: 'model', order: 0 }, {
    spans: [{ text: '[model-x]' }],
  }, 'p1')
  ledger.register('chrome.footer.status', { id: 'hint', order: 1 }, {
    spans: [{ text: 'press ? for help' }],
    importance: -1,
  }, 'p2')
  host.refreshOutlets()
  app.refreshChrome()
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('press ? for help'), `hint segment missing before compact:\n${view}`)
  // The /settings footer: compact path: toggling compact on an already
  // baked host must DROP the low-importance segment (round-4 finding 1).
  app.setFooterPreset('compact')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('press ? for help'), `low-importance segment survived compact (round-4 finding 1):\n${view}`)
  assert.ok(view.includes('[model-x]'), `high-importance segment must survive compact:\n${view}`)
  // Back to full restores it.
  app.setFooterPreset('full')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('press ? for help'), `segment must return on full (round-4 finding 1):\n${view}`)
  app.stop()
})

test('a Cordis plugin registering BEFORE attach renders once the surface attaches (F-17)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide('tuiStartup', { shippedPresetRoot: '/ws' })
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber
    const pluginFiber = ctx.plugin((c) => {
      const service = c.get('piTuiExtensions') as {
        register(slot: string, spec: { id: string }, value: { text: string }): unknown
      }
      service.register('chrome.header.badge', { id: 'pre-attach' }, { text: 'pre-attach-badge' })
    })
    await pluginFiber

    const service = ctx.get('piTuiExtensions') as { _ledger(): ExtensionLedger }
    const vt = new VirtualTerminal(80, 24)
    const host = new SurfaceHost(service._ledger(), () => app.requestRender())
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    await vt.waitForRender()
    // Attach AFTER the registration: attach re-bakes the outlets from the
    // current ledger, so the pre-attach badge renders immediately.
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
      focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    await settle()
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('pre-attach-badge'), `pre-attach registration must render on attach:\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a repeated attach on the SAME host is idempotent (round-3 finding 1)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  // A second attach must NOT mint a new sink lease: the host keeps its
  // FIRST token, so a later dispose releases exactly that attachment's
  // sink (P1-2: registrations are caller-owned and never affected).
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  const handle = ledger.register('chrome.header.badge', { id: 'repeat-attach' }, { text: 'R' }, 'plugin-a')
  host.refreshOutlets()
  await settle()
  assert.ok(host.headerBadgeText().includes('R'))
  // Dispose: the host stops consuming — the registration stays LIVE (P1-2:
  // only the owner fiber unload / explicit dispose makes it inert).
  host.dispose()
  await settle()
  handle.replace({ text: 'R-mutated' } as HeaderBadge)
  assert.equal(ledger.snapshot<HeaderBadge>('chrome.header.badge').records[0]?.value.text, 'R-mutated',
    'a repeated attach must not leak a sink; the caller-owned registration stays live (P1-2)')
  app.stop()
})

test('an EXPLICIT stale permission clears the extension snapshot (no stale badge)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  app.setStatus({ model: 'm1', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: 'workspace-write' })
  await settle()
  assert.equal(host.state().session.permission, 'workspace-write', 'the permission must be set first')
  // The runner's refreshStatus passes permission: undefined when the
  // permission service/agent is unavailable — the extension snapshot must
  // CLEAR the permission, never keep the stale value.
  app.setStatus({ model: 'm1', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: undefined })
  await settle()
  assert.equal(host.state().session.permission, undefined, 'a cleared permission must not stay in the extension snapshot')
  app.stop()
})

test('runner permission projection clears on service/agent absence (runner-level guard)', async () => {
  // The runner's refreshStatus decides the permission via the pure
  // deriveRunnerPermission: a missing permission service OR a missing
  // live agent must yield EXPLICIT undefined (never the stale value) —
  // that explicit undefined is what clears the extension snapshot.
  const { deriveRunnerPermission } = await import('../src/status/derive-permission.ts')
  const agent = { session: { events: [{ kind: 'session/created' }] } }
  const presets = { current: (events: unknown) => (events as unknown[]).length > 0 ? 'workspace-write' : undefined }
  assert.equal(deriveRunnerPermission(presets, agent as never), 'workspace-write')
  assert.equal(deriveRunnerPermission(undefined, agent as never), undefined,
    'a missing permission service must yield undefined (clear)')
  assert.equal(deriveRunnerPermission(presets, undefined), undefined,
    'a missing live agent must yield undefined (clear)')
})
