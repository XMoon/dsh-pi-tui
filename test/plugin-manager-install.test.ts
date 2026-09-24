/**
 * Install-lifecycle integration tests (P1-A3) over a fake Host: request-id
 * correlation of the official install events, unrelated events excluded, the
 * bounded presentation log, and the close→reopen invariant that must never
 * increment the `installBundle()` call count.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-install.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../src/plugin-manager/controller.ts'
import { PluginManagerPanel } from '../src/plugin-manager/panel.ts'
import { createDiag } from '../src/diag.ts'
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

test('install events are correlated by request id and unrelated events are ignored', async () => {
  const { controller, installCalls, emit, gate } = harness()
  controller.openInstall()
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
  controller.openInstall()
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
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  controller.closeInstall()
  controller.openInstall()
  controller.closeInstall()
  controller.openInstall()
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
  harness.controller.openInstall()
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
  harness.controller.openInstall()
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
  harness.controller.openInstall()
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
  const firstPanel = new PluginManagerPanel(harness.controller, () => {}, {})
  harness.controller.openInstall()
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
  const ownedPanel = new PluginManagerPanel(harness.controller, () => {}, { onDispose: () => released.push(1) })
  firstPanel.dispose()
  ownedPanel.dispose()
  assert.deepEqual(released, [1], 'the panel teardown releases its surface owner exactly once')

  // Reopen the surface through the panel-open entry: a NEW panel over the SAME
  // controller resumes the dispatched install with the same request id.
  harness.controller.open('direct-command')
  const reopened = new PluginManagerPanel(harness.controller, () => {}, {})
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
  harness.controller.openInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  const before = harness.counters.snapshotCalls
  harness.controller.confirmInstall()
  await tick()
  assert.ok(harness.counters.snapshotCalls > before, 'settlement re-reads the official inventory')
})
