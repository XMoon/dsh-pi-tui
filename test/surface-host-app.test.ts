/**
 * M2 contract gate: the SurfaceHost attached to a live TuiApp. Extension
 * registrations (through the real Cordis service) render into the host's
 * header/dock/footer chrome; state setters mirror into the immutable
 * snapshots; disposal detaches cleanly. Regular AND fullscreen both refresh
 * through the active screen.
 * @module @xmoon76/dsh-pi-tui/surface-host-app.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Text } from '@xmoon76/pi-tui'
import { setTheme } from '../src/theme.ts'
import type { DockItem, HeaderBadge } from '../src/extension/public-types.ts'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import { TuiApp } from '../src/tui-app.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { enterChildDisplaySubject, exitChildDisplaySubject } from './support/display-subject.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function makeApp(ledger: ExtensionLedger): { vt: VirtualTerminal; app: TuiApp; host: SurfaceHost } {
  const vt = new VirtualTerminal(80, 24)
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  startedApps.add(app)
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
      c.provide('tuiStartup', {})
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
    startedApps.add(app)
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
      c.provide('tuiStartup', {})
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
    startedApps.add(app)
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

test('whole-PR F3: a known -> missing model CLEARS the extension session snapshot (both writers)', async (t) => {
  // The extension snapshot merge is PER FIELD, so an OMITTED model kept the
  // previous value alive: a session whose model projection became unavailable
  // (or a switch to such a session) reported the OLD model as the new session's
  // fact. Both production writers must therefore ALWAYS write the field —
  // `undefined` clears it, exactly like `permission` above.
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  // Writer 1 (the live status sync): the model is known, then missing.
  app.refreshChrome()
  app.setStatus({ model: 'known-model', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: undefined })
  await settle()
  assert.equal(host.state().session.model, 'known-model', 'the model must be set first')
  app.setStatus({ model: '', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: undefined })
  await settle()
  assert.equal(host.state().session.model, undefined,
    'a missing model must not keep the previous value in the extension snapshot')
  // Writer 2 (the welcome card / session identity mirror) across a SESSION
  // SWITCH: session A is known, session B's model projection is unavailable.
  app.refreshChrome()
  app.setWelcomeCard({ cwd: '/ws', sessionId: 'session-a', model: 'model-a', version: '0.0.0' })
  await settle()
  assert.equal(host.state().session.sessionId, 'session-a')
  assert.equal(host.state().session.model, 'model-a')
  app.setWelcomeCard({ cwd: '/ws', sessionId: 'session-b', version: '0.0.0' })
  await settle()
  assert.equal(host.state().session.sessionId, 'session-b', 'the switch took effect')
  assert.equal(host.state().session.model, undefined,
    "session B must never inherit session A's model fact")
  app.stop()
})

test('whole-PR F3 sibling: an emptied cwd/branch CLEARS the extension snapshot (same per-field merge)', async (t) => {
  // Same root cause as the model: `updateSession` is a shallow merge, so an
  // OMITTED field keeps its previous value. `cwd` is a required snapshot field
  // (canonical unknown = ''), `branch` is optional (canonical clear =
  // undefined) — both must be WRITTEN, never omitted.
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  app.setStatus({ model: 'm1', cwd: '/repo/a', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: undefined })
  await settle()
  assert.equal(host.state().session.cwd, '/repo/a')
  assert.equal(host.state().session.branch, 'main')
  app.setStatus({ model: 'm1', cwd: '', branch: '', turns: 2, steps: 3, statsLine: '', permission: undefined })
  await settle()
  assert.equal(host.state().session.cwd, '',
    'an emptied cwd must not leave the previous directory in the extension snapshot')
  assert.equal(host.state().session.branch, undefined,
    'an emptied branch must not leave the previous branch in the extension snapshot')
  app.stop()
})

test('whole-PR R15-2: a session SWITCH keeps the NEW subject branch (the later identity commit must not clear it)', async (t) => {
  // PRODUCTION ORDER: `status.refresh()` for B (which writes B's model/cwd/
  // branch) runs BEFORE the welcome identity commit. A switch-clear in the
  // welcome commit therefore overwrote a fact the new subject had just proved
  // (`extension snapshot.branch = undefined` while B's branch was known).
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  app.setStatus({ model: 'm1', cwd: '/repo/a', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: undefined })
  app.setWelcomeCard({ cwd: '/repo/a', sessionId: 'session-a', model: 'model-a', version: '0.0.0' })
  await settle()
  assert.equal(host.state().session.sessionId, 'session-a')
  assert.equal(host.state().session.branch, 'main')
  // B's STATUS commit first (the production order), then B's identity commit.
  app.setStatus({ model: 'm2', cwd: '/repo/b', branch: 'feature-b', turns: 1, steps: 1, statsLine: '', permission: undefined })
  app.setWelcomeCard({ cwd: '/repo/b', sessionId: 'session-b', version: '0.0.0' })
  await settle()
  assert.equal(host.state().session.sessionId, 'session-b', 'the switch took effect')
  assert.equal(host.state().session.cwd, '/repo/b', "the switch commits the NEW session's workspace")
  assert.equal(host.state().session.branch, 'feature-b',
    "the later identity commit must not clear the branch the NEW subject already proved")
  app.stop()
})

test('whole-PR R15-2 control: a switch to a subject whose branch is ABSENT clears the previous one', async (t) => {
  // The clear lives in the STATUS writer (explicit `undefined` for an absent
  // branch), which runs FIRST for the new subject — never in the later identity
  // commit, which cannot know whether the new subject has a branch.
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  app.refreshChrome()
  app.setStatus({ model: 'm1', cwd: '/repo/a', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: undefined })
  app.setWelcomeCard({ cwd: '/repo/a', sessionId: 'session-a', model: 'model-a', version: '0.0.0' })
  await settle()
  assert.equal(host.state().session.branch, 'main')
  app.setStatus({ model: 'm2', cwd: '/repo/b', branch: '', turns: 1, steps: 1, statsLine: '', permission: undefined })
  app.setWelcomeCard({ cwd: '/repo/b', sessionId: 'session-b', version: '0.0.0' })
  await settle()
  assert.equal(host.state().session.sessionId, 'session-b')
  assert.equal(host.state().session.branch, undefined,
    "session B must never inherit session A's branch when B has none")
  app.stop()
})

test('runner permission projection clears on service/agent absence (runner-level guard)', async () => {
  // The runner's refreshStatus decides the permission via the pure
  // deriveRunnerPermission: a missing permission service OR a missing
  // live agent must yield EXPLICIT undefined (never the stale value) —
  // that explicit undefined is what clears the extension snapshot.
  const { deriveRunnerPermission } = await import('../src/domain/status/derive-permission.ts')
  // Alpha.4: `permission.current(session)` reads the session's own knob
  // state — the service surface is session-oriented, never an event list.
  const agent = { session: { id: 'session-a' } }
  const presets = { current: (session: unknown) => (session as { id?: string })?.id !== undefined ? 'workspace-write' : undefined }
  assert.equal(deriveRunnerPermission(presets, agent as never), 'workspace-write')
  assert.equal(deriveRunnerPermission(undefined, agent as never), undefined,
    'a missing permission service must yield undefined (clear)')
  assert.equal(deriveRunnerPermission(presets, undefined), undefined,
    'a missing live agent must yield undefined (clear)')
})

test('M3-5 PR1: the extension snapshot keeps v2 live-session semantics and publishes the display subject additively', async () => {
  // Contract decision (M3-5 PR1): `SessionSnapshot` (v2, released) describes the
  // LIVE session owner everywhere — a viewer transition must NOT re-point it.
  // The session the user is looking at is published additively as
  // `session.displaySubject`, which is present only while a child viewer is
  // mounted. The first-party todo dock renders the display subject's summary.
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  const published: ReturnType<typeof host.state>[] = []
  host.subscribeState(state => { published.push(state) })

  app.refreshChrome()
  app.setStatus({ model: 'parent-model', cwd: '/parent', branch: 'main', turns: 2, steps: 3, statsLine: '', permission: 'danger-full-access' })
  app.setTodoSummary([{ content: 'parent todo', status: 'in_progress' }])
  app.setSessionTitle('parent title')
  app.setWelcomeCard({ cwd: '/parent', sessionId: 'session-main', model: 'parent-model', version: '0.0.0' })
  app.toggleTodoPanel()
  await settle()
  await vt.waitForRender()
  assert.equal(host.state().session.sessionId, 'session-main')
  assert.equal(host.state().session.displaySubject, undefined, 'no display subject without a viewer')
  assert.equal(host.state().activity.todoCount, 1)

  // CHILD A: the LIVE-session fields keep their v2 meaning; the child appears
  // only in the additive displaySubject projection.
  enterChildDisplaySubject(app, {
    id: 'child-a', label: 'a', mode: 'continuable', activity: 'running',
    cwd: '/child-a', turns: 5, steps: 7,
    model: { provider: 'deepseek', model: 'child-a-model' },
    permission: 'read-only',
    todos: [{ content: 'child-a todo', status: 'in_progress' }],
    title: 'child-a title',
    goal: 'goal ● child-a objective',
  })
  await settle()
  await vt.waitForRender()
  const a = host.state()
  assert.equal(a.session.viewerMode, true)
  assert.equal(a.session.sessionId, 'session-main', 'the live owner must not re-point while viewing')
  assert.equal(a.session.workspaceRoot, '/parent')
  assert.equal(a.session.cwd, '/parent')
  assert.equal(a.session.model, 'parent-model')
  assert.equal(a.session.permission, 'danger-full-access')
  assert.equal(a.session.title, 'parent title')
  assert.equal(a.session.turns, 2)
  assert.equal(a.session.steps, 3)
  assert.equal(a.activity.todoCount, 1, 'the live session’s todo count (v2)')
  assert.deepEqual(a.session.displaySubject, {
    sessionId: 'child-a',
    title: 'child-a title',
    workspaceRoot: '/child-a',
    cwd: '/child-a',
    model: 'deepseek/child-a-model',
    permission: 'read-only',
    turns: 5,
    steps: 7,
    todoCount: 1,
  }, 'the display subject carries the child’s own identity and status')
  // The ALREADY-OPEN todo panel follows the display-subject list.
  const panelA = vt.getViewport().join('\n')
  assert.ok(panelA.includes('child-a todo'), `the open child todo panel must render the child list:\n${panelA}`)
  assert.ok(!panelA.includes('parent todo'), `the parent todo list must not render while viewing:\n${panelA}`)

  // While the child is displayed the LIVE session's OWN facts must stay
  // CURRENT: the same commit merges them into the live slot (the extension v2
  // fields) without touching the child's sections (M3-5 PR1 review R5).
  enterChildDisplaySubject(app, {
    id: 'child-a', label: 'a', mode: 'continuable', activity: 'running',
    cwd: '/child-a', turns: 5, steps: 7,
    model: { provider: 'deepseek', model: 'child-a-model' },
    permission: 'read-only',
    todos: [{ content: 'child-a todo', status: 'in_progress' }],
    title: 'child-a title',
    live: { model: 'parent-model-v2', cwd: '/parent-v2', branch: 'main', turns: 9, steps: 11, permission: 'workspace-write' },
  })
  await settle()
  await vt.waitForRender()
  const advanced = host.state()
  assert.equal(advanced.session.turns, 9, 'the LIVE counters must keep advancing while the child is displayed')
  assert.equal(advanced.session.steps, 11)
  assert.equal(advanced.session.model, 'parent-model-v2', 'the LIVE model must keep advancing')
  assert.equal(advanced.session.cwd, '/parent-v2', 'the LIVE cwd must keep advancing')
  assert.equal(advanced.session.branch, 'main')
  assert.equal(advanced.session.permission, 'workspace-write', 'the LIVE permission must keep advancing')
  assert.equal(advanced.session.sessionId, 'session-main', 'and the LIVE identity still must not re-point')
  assert.equal(advanced.session.displaySubject?.turns, 5, 'the child’s own counters stay the child’s')
  assert.equal(advanced.session.displaySubject?.steps, 7)
  assert.equal(advanced.session.displaySubject?.model, 'deepseek/child-a-model')

  // A same-child republish that CLEARS the optional child facts (here: the model
  // and permission projections become unavailable) must clear them from the
  // published projection — a deletion-only change, never a stale reuse
  // (M3-5 PR1 review R8).
  enterChildDisplaySubject(app, {
    id: 'child-a', label: 'a', mode: 'continuable', activity: 'running',
    cwd: '/child-a', turns: 5, steps: 7,
    title: 'child-a title',
    todos: [{ content: 'child-a todo', status: 'in_progress' }],
  })
  await settle()
  await vt.waitForRender()
  const clearedSubject = host.state().session.displaySubject
  assert.equal(clearedSubject?.sessionId, 'child-a')
  assert.equal(clearedSubject?.model, undefined, 'the unavailable child model must be cleared')
  assert.equal(clearedSubject?.permission, undefined, 'the unavailable child permission must be cleared')
  assert.equal(clearedSubject?.todoCount, 1, 'the required child facts stay')

  // The MAIN todo list keeps updating behind the child: the LIVE fields follow
  // it, the displaySubject does not.
  app.setTodoSummary([{ content: 'parent todo v2', status: 'pending' }])
  await settle()
  await vt.waitForRender()
  const afterMainWrite = host.state()
  assert.equal(afterMainWrite.activity.todoCount, 1, 'the live session follows the hidden main write')
  assert.equal(afterMainWrite.session.displaySubject?.todoCount, 1, 'the display subject keeps the child list')
  assert.ok(vt.getViewport().join('\n').includes('child-a todo'),
    'the open panel must keep the child list after the hidden main write')

  // With the panel closed both summary texts exist: the LIVE activity keeps the
  // main summary (v2) and the display subject carries the child's own.
  app.toggleTodoPanel()
  await settle()
  await vt.waitForRender()
  const closed = host.state()
  assert.ok(closed.activity.todoSummary?.includes('parent todo v2'),
    `the live summary must stay the main’s: ${closed.activity.todoSummary}`)
  assert.ok(closed.session.displaySubject?.todoSummary?.includes('child-a todo'),
    `the display subject must carry the child summary: ${closed.session.displaySubject?.todoSummary}`)

  // CHILD B: no A residue in the additive projection.
  enterChildDisplaySubject(app, {
    id: 'child-b', label: 'b', mode: 'one-shot', activity: 'inactive',
    cwd: '/child-b', turns: 1, steps: 1,
    model: { provider: 'deepseek', model: 'child-b-model' },
    todos: [{ content: 'child-b todo', status: 'pending' }],
    title: 'child-b title',
  })
  await settle()
  await vt.waitForRender()
  const b = host.state()
  assert.equal(b.session.displaySubject?.sessionId, 'child-b')
  assert.equal(b.session.displaySubject?.model, 'deepseek/child-b-model')
  assert.equal(b.session.displaySubject?.permission, undefined, 'B has no permission — A’s must not survive')
  assert.equal(b.session.displaySubject?.title, 'child-b title')
  assert.equal(b.session.displaySubject?.cwd, '/child-b')
  assert.equal(b.session.displaySubject?.todoCount, 1)
  assert.equal(b.session.sessionId, 'session-main', 'the live owner still must not re-point')
  assert.ok(b.session.displaySubject?.todoSummary?.includes('child-b todo'),
    `B's own todo summary must be published: ${b.session.displaySubject?.todoSummary}`)

  // EXIT: the additive projection disappears and the LIVE fields carry the
  // LATEST main state.
  exitChildDisplaySubject(app, { model: 'parent-model', cwd: '/parent', branch: 'main', turns: 2, steps: 3, permission: 'danger-full-access' })
  app.setTodoSummary([{ content: 'parent todo v3', status: 'in_progress' }])
  await settle()
  await vt.waitForRender()
  const main = host.state()
  assert.equal(main.session.viewerMode, false)
  assert.equal(main.session.displaySubject, undefined, 'the additive projection clears on exit')
  assert.equal(main.session.sessionId, 'session-main')
  assert.equal(main.session.cwd, '/parent')
  assert.equal(main.session.model, 'parent-model')
  assert.equal(main.session.permission, 'danger-full-access')
  assert.equal(main.session.title, 'parent title')
  assert.equal(main.activity.todoCount, 1, 'the LATEST main todo count')
  assert.ok(main.activity.todoSummary?.includes('parent todo v3'),
    `the latest main todo summary returns: ${main.activity.todoSummary}`)

  // Every published snapshot keeps the two concepts separate: the LIVE fields
  // name the main session in EVERY state, and the display subject appears only
  // while a viewer is mounted, naming a child.
  for (const state of published) {
    assert.ok(state.session.sessionId === undefined || state.session.sessionId === 'session-main',
      `the live session identity must never re-point: ${JSON.stringify(state.session)}`)
    if (state.session.displaySubject !== undefined) {
      assert.ok(state.session.viewerMode, 'a display subject is only published while a viewer is mounted')
      assert.ok(state.session.displaySubject.sessionId.startsWith('child-'),
        `the display subject must name the child: ${JSON.stringify(state.session.displaySubject)}`)
      assert.ok(state.session.displaySubject.cwd.startsWith('/child-'),
        `the display subject must carry the child workspace: ${JSON.stringify(state.session.displaySubject)}`)
      assert.notEqual(state.session.displaySubject.model, 'parent-model')
    }
  }
  app.stop()
})
