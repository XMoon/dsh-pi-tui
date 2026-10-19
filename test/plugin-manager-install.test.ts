/**
 * Install-lifecycle integration tests (P1-A3) over a fake Host: request-id
 * correlation of the official install events, unrelated events excluded, the
 * bounded presentation log, and the close→reopen invariant that must never
 * increment the `installBundle()` call count.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-install.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type {
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
} from '../src/runtime/plugin-manager-port.ts'

function emptySnapshot(): PluginManagerSnapshot {
  return {
    bundles: [],
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

function change(overrides: Partial<PluginChangeFact> = {}): PluginChangeFact {
  return { changed: true, application: 'applied', stage: 'install', target: 'pkg', ...overrides }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function harness(): { controller: PluginManagerController; installCalls: unknown[]; emit: (event: PluginInstallEvent) => void; gate: ReturnType<typeof deferred<PluginChangeFact>> } {
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const installCalls: unknown[] = []
  const gate = deferred<PluginChangeFact>()
  const port: PluginManagerPort = {
    snapshot: async () => emptySnapshot(),
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async (request) => { installCalls.push(request); return gate.promise },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    subscribeInvalidation: () => () => {},
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return { controller, installCalls, emit: event => { for (const listener of listeners) listener(event) }, gate }
}

function installPage(controller: PluginManagerController): PluginManagerWorkspacePanel {
  return new PluginManagerWorkspacePanel(controller, {
    rows: () => 40,
    columns: () => 120,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
}

test('install events are correlated by request id and unrelated events are ignored', async () => {
  const { controller, installCalls, emit, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId

  emit({ kind: 'phase', phase: { requestId: 'someone-else', phase: 'installing' } })
  assert.equal(controller.installView()?.phase, 'starting')

  emit({ kind: 'log', log: { requestId: 'someone-else', jobId: 'j', stream: 'stdout', text: 'foreign' } })
  assert.deepEqual([...controller.installView()!.log], [])

  emit({ kind: 'phase', phase: { requestId, phase: 'installing', attempt: { registry: 'https://r', index: 1, total: 2 } } })
  assert.equal(controller.installView()?.phase, 'installing')
  assert.match(controller.installView()?.message ?? '', /1\/2/)

  emit({ kind: 'log', log: { requestId, jobId: 'job-a', stream: 'stdout', text: 'line one\n' } })
  emit({ kind: 'log', log: { requestId, jobId: 'job-b', stream: 'stderr', text: 'line two' } })
  assert.deepEqual([...controller.installView()!.log], ['line one', '! line two'])

  gate.resolve(change({ application: 'restart-required' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')
})

test('the presentation log is bounded', async () => {
  const { controller, installCalls, emit, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId
  emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  for (let i = 0; i < 200; i += 1) {
    emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: `line ${i}` } })
  }
  const log = controller.installView()!.log
  assert.ok(log.length <= 40, `bounded tail, got ${log.length}`)
  assert.equal(log[log.length - 1], 'line 199')
  gate.resolve(change())
  await tick()
})

test('close then reopen never dispatches a second installBundle call', async () => {
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  controller.hideInstall()
  controller.beginManualInstall()
  controller.hideInstall()
  controller.beginManualInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  assert.equal(controller.installView()?.requestId, (installCalls[0] as { requestId: string }).requestId)
  gate.resolve(change())
  await tick()
})

// ── interrupted-operation recovery (rc.2 P1-B, plan §14) ────────────────────

/** One install lifecycle over a scripted dispatch/recovery Host. */
function recoveryHarness(options: {
  startInstall: () => Promise<PluginChangeFact>
  waitForInstall?: (requestId: string) => Promise<PluginChangeFact | null>
}): {
  controller: PluginManagerController
  installCalls: unknown[]
  waitCalls: string[]
  cancelCalls: string[]
  counters: { snapshotCalls: number }
} {
  const installCalls: unknown[] = []
  const waitCalls: string[] = []
  const cancelCalls: string[] = []
  const counters = { snapshotCalls: 0 }
  const port: PluginManagerPort = {
    snapshot: async () => { counters.snapshotCalls += 1; return emptySnapshot() },
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async (request) => { installCalls.push(request); return options.startInstall() },
    waitForInstall: async (requestId) => {
      waitCalls.push(String(requestId))
      return options.waitForInstall === undefined ? null : options.waitForInstall(String(requestId))
    },
    cancelInstall: async (requestId) => { cancelCalls.push(String(requestId)); return { status: 'cancelled' } },
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return { controller, installCalls, waitCalls, cancelCalls, counters }
}

test('an interrupted install recovers through the official waitForInstall and never re-dispatches', async () => {
  const harness = recoveryHarness({
    startInstall: async () => { throw new Error('carrier lost') },
    waitForInstall: async () => change({ application: 'restart-required' }),
  })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  assert.equal(harness.installCalls.length, 1, 'exactly one startInstall for one request id')
  assert.equal(harness.waitCalls.length, 1, 'the indeterminate dispatch recovers through the official waitForInstall')
  const view = harness.controller.installView()
  assert.equal(view?.phase, 'done')
  assert.equal(view?.outcome?.application, 'restart-required', 'the recovered official outcome is presented')
})

test('an interrupted install with no recoverable run reports unknown, refreshes inventory, and never retries', async () => {
  const harness = recoveryHarness({
    startInstall: async () => { throw new Error('carrier lost') },
    waitForInstall: async () => null,
  })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  assert.equal(harness.installCalls.length, 1, 'recovery must never auto-retry installBundle')
  assert.equal(harness.waitCalls.length, 1)
  const view = harness.controller.installView()
  assert.equal(view?.phase, 'unknown')
  assert.match(view?.message ?? '', /not retried automatically/)
  assert.ok(harness.counters.snapshotCalls >= 1, 'the inventory is re-read authoritatively')
})

test('cancel delegates to the official cancelInstall for the active request id', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = recoveryHarness({ startInstall: () => gate.promise })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  const requestId = String((harness.installCalls[0] as { requestId: unknown }).requestId)
  harness.controller.cancelInstall()
  await tick()
  assert.deepEqual(harness.cancelCalls, [requestId], 'cancel forwards the exact active request id')
  assert.equal(harness.controller.installView()?.phase, 'done')
  gate.resolve(change())
  await tick()
})

test('a whole-panel teardown then reopen preserves the in-flight install and never re-dispatches', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = recoveryHarness({ startInstall: () => gate.promise })
  // The first surface: open the install dialog, inspect and dispatch.
  const firstPanel = new PluginManagerWorkspacePanel(harness.controller, { rows: () => 24, columns: () => 80, requestRender: () => {}, notice: () => undefined, onCopy: () => {} }, {})
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  const requestId = String((harness.installCalls[0] as { requestId: unknown }).requestId)
  assert.equal(harness.controller.installView()?.phase, 'starting', 'the dispatch is in flight')

  // The WHOLE panel surface is torn down (e.g. the Settings parent overlay is
  // hidden): the panel releases its owner exactly once while the controller —
  // and therefore the official operation — survives.
  const released: number[] = []
  const ownedPanel = new PluginManagerWorkspacePanel(harness.controller, { rows: () => 24, columns: () => 80, requestRender: () => {}, notice: () => undefined, onCopy: () => {} }, { onDispose: () => released.push(1) })
  firstPanel.dispose()
  ownedPanel.dispose()
  assert.deepEqual(released, [1], 'the panel teardown releases its surface owner exactly once')

  // Reopen the surface through the panel-open entry: a NEW panel over the SAME
  // controller resumes the dispatched install with the same request id.
  harness.controller.open('direct-command')
  const reopened = new PluginManagerWorkspacePanel(harness.controller, { rows: () => 24, columns: () => 80, requestRender: () => {}, notice: () => undefined, onCopy: () => {} }, {})
  await tick()
  assert.equal(harness.installCalls.length, 1, 'reopening the surface must not dispatch a second installBundle')
  assert.equal(harness.controller.installView()?.requestId, requestId, 'the same request id is preserved')
  assert.equal(harness.controller.installView()?.phase, 'starting',
    'a dispatched install reopens as the same install view, never a fresh dialog')
  assert.ok(reopened.render(60).length > 0, 'the reopened panel renders the resumed install view')
  reopened.dispose()
  gate.resolve(change())
  await tick()
})

test('a settled install triggers an authoritative inventory refresh', async () => {
  const harness = recoveryHarness({ startInstall: async () => change() })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  const before = harness.counters.snapshotCalls
  harness.controller.confirmInstall()
  await tick()
  assert.ok(harness.counters.snapshotCalls > before, 'settlement re-reads the official inventory')
})

test('install inspection metadata and progress rows fold hostile values onto ONE physical row', async () => {
  const hostile = 'First\nSecond\r\nThird\tTabbed\u001b]52;c;YXR0YWNr\u0007tail'
  const collapsed = 'First Second Third   Tabbedtail'
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const installCalls: unknown[] = []
  const gate = deferred<PluginChangeFact>()
  const port: PluginManagerPort = {
    snapshot: async () => emptySnapshot(),
    inspect: async () => ({
      status: 'accepted',
      kind: hostile,
      name: hostile,
      version: hostile,
      description: hostile,
      bundle: true,
      registry: hostile,
      host: hostile,
    }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async (request) => { installCalls.push(request); return gate.promise },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    subscribeInvalidation: () => () => {},
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  const panel = new PluginManagerPanel(controller, () => {})
  panel.setMaxRows(40)
  const assertPhysicalRows = (rendered: readonly string[], where: string): string => {
    const text = rendered.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    for (const line of rendered) {
      assert.ok(!line.includes('\n') && !line.includes('\r'),
        `${where}: a rendered row carries an embedded line break: ${JSON.stringify(line)}`)
      assert.ok(!line.includes('YXR0YWNr'), `${where}: the OSC payload reaches a row`)
      assert.ok(!line.includes('\u001b]52') && !line.includes('\u009b'), `${where}: a raw control introducer reaches a row`)
    }
    return text
  }

  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  assert.equal(controller.installView()?.phase, 'confirm')
  const confirmText = assertPhysicalRows(panel.render(160), 'confirm')
  assert.ok(confirmText.includes(collapsed), `the collapsed inspection metadata survives:\n${confirmText}`)

  controller.confirmInstall()
  await tick()
  const requestId = String((installCalls[0] as { requestId: unknown }).requestId)
  const emit = (event: PluginInstallEvent): void => { for (const listener of listeners) listener(event) }
  emit({ kind: 'phase', phase: { requestId, phase: 'installing', attempt: { registry: hostile, index: 1, total: 2 } } })
  emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: `progress\r\n\t${hostile}` } })
  const runningText = assertPhysicalRows(panel.render(160), 'running')
  // The phase message carries the attempt registry on ONE row; the log is
  // line-oriented (the controller splits LF), so its own hostile TAB/OSC/C1
  // element must also stay on one row.
  assert.ok(runningText.includes(`installing from ${collapsed} (1/2)`),
    `the collapsed progress message survives:\n${runningText}`)
  assert.ok(runningText.includes('Third   Tabbedtail'), `the collapsed log row survives:\n${runningText}`)

  gate.resolve(change())
  await tick()
})


test('a failed install reopens with the same request id and New install is explicit', async () => {
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId
  gate.resolve(change({ application: 'failed', pendingBuilds: ['evil-pkg'] }))
  await tick()
  assert.equal(controller.installView()?.phase, 'failed')
  assert.equal(controller.installView()?.requestId, requestId)

  const page = installPage(controller)
  assert.equal(page.currentView(), 'install', 'a new page restores the failed attempt')
  const failedFrame = page.render(120).join('\n')
  assert.match(failedFrame, /Approve and retry evil-pkg/)
  assert.match(failedFrame, /New install/, 'the explicit new-install action is visible')

  const short = new PluginManagerWorkspacePanel(controller, {
    rows: () => 10,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const shortFrame = short.render(80).join('\n')
  assert.match(shortFrame, /Build scripts blocked/, 'the risk names remain visible at 80x10')
  assert.doesNotMatch(shortFrame, /Approve/, 'approval is not offered when its risk cannot be fully shown')
  short.handleInput('\r')
  await tick()
  assert.equal(installCalls.length, 1, 'Enter on the short frame cannot approve a hidden risk')
  short.dispose()

  const tall = new PluginManagerWorkspacePanel(controller, {
    rows: () => 24,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const tallFrame = tall.render(80).join('\n')
  assert.match(tallFrame, /Approve and retry evil-pkg/)
  assert.match(tallFrame, /execute scripts with your user privileges/, 'both risk facts and approval are visible at 80x24')
  tall.dispose()

  // Another official card's Install action must not bypass recovery and replace
  // this terminal record; New install is the explicit replacement path.
  assert.equal(controller.beginOfficialInstall('another-official-card'), false)
  assert.equal(controller.installView()?.requestId, requestId)
  assert.match(controller.notice() ?? '', /install result is still open/)

  page.handleInput('\x1b') // hide the install view
  await tick()
  assert.equal(page.currentView(), 'list')
  page.handleInput('i') // reopen, never replace
  await tick()
  assert.equal(page.currentView(), 'install')
  assert.equal(controller.installView()?.requestId, requestId, 'i preserves the original request id')
  assert.equal(controller.installView()?.phase, 'failed')

  page.handleInput('n') // explicit new
  await tick()
  assert.equal(page.currentView(), 'install')
  assert.equal(controller.installView()?.phase, 'editing')
  assert.notEqual(controller.installView()?.requestId, requestId, 'n creates a genuinely new request')
  page.dispose()
})

test('a recently completed install also reopens without a new request', async () => {
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId
  gate.resolve(change({ application: 'applied' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')

  const page = installPage(controller)
  assert.equal(page.currentView(), 'install')
  page.handleInput('\x1b')
  page.handleInput('i')
  await tick()
  assert.equal(page.currentView(), 'install')
  assert.equal(controller.installView()?.requestId, requestId)
  page.dispose()
})

test('an unknown install reopens with its request id and reconciliation action', async () => {
  const rejected = new PluginManagerController({
    snapshot: async () => emptySnapshot(),
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async () => { throw new Error('host lost') },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  rejected.beginManualInstall()
  rejected.inspect('pkg', null)
  await tick()
  rejected.confirmInstall()
  await tick()
  const unknownId = rejected.installView()?.requestId
  assert.equal(rejected.installView()?.phase, 'unknown')
  const page = installPage(rejected)
  assert.equal(page.currentView(), 'install')
  const unknownFrame = page.render(120).join('\n')
  assert.match(unknownFrame, /Check installation status/)
  assert.doesNotMatch(unknownFrame, /New install/, 'unknown must not offer a replacement request')
  page.handleInput('\x1b')
  page.handleInput('i')
  await tick()
  assert.equal(rejected.installView()?.requestId, unknownId)
  assert.equal(rejected.installView()?.phase, 'unknown')
  page.handleInput('n')
  await tick()
  assert.equal(rejected.installView()?.requestId, unknownId, 'n cannot replace an unknown request')
  assert.equal(rejected.beginManualInstall(), false)
  assert.equal(rejected.beginOfficialInstall('another-official-card'), false)
  assert.equal(rejected.installView()?.requestId, unknownId)
  page.dispose()
  rejected.dispose()
})
