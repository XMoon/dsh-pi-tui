/**
 * Controller contract tests (P1-A1/A2/A3): the operation/presentation owner
 * over a fake semantic port. Covers read/refresh policy, the Current-TUI
 * self-protection guard at dispatch (not only in the UI), mutation
 * identity/staleness, and the install lifecycle (request identity, recovery,
 * cancel and close/reopen without a duplicate install).
 * @module @xmoon76/dsh-pi-tui/plugin-manager-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SELF_BUNDLE } from '../src/plugin-manager/classify.ts'
import { PluginManagerController } from '../src/plugin-manager/controller.ts'
import { createDiag } from '../src/diag.ts'
import { PLUGIN_ACTION, bundleValue, entryValue } from '../src/plugin-manager/model.ts'
import type {
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
} from '../src/runtime/plugin-manager-port.ts'

function change(overrides: Partial<PluginChangeFact> = {}): PluginChangeFact {
  return { changed: true, application: 'applied', stage: 'enable', target: 'x', ...overrides }
}

function snapshot(bundles: PluginManagerSnapshot['bundles']): PluginManagerSnapshot {
  return {
    bundles,
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

interface FakeState {
  snapshotCalls: number
  setBundle: unknown[]
  setPlugin: unknown[]
  removeBundle: unknown[]
  installCalls: unknown[]
  inspectCalls: unknown[]
  waitCalls: unknown[]
  cancelCalls: unknown[]
  snapshotImpl: () => Promise<PluginManagerSnapshot>
  inspectImpl: (spec: string, registry: string | null) => Promise<PluginSpecInspectionFact>
  installImpl: (request: unknown) => Promise<PluginChangeFact>
  waitImpl: (requestId: string) => Promise<PluginChangeFact | null>
  cancelImpl: (requestId: string) => Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }>
  setBundleImpl?: (name: string, enabled: boolean) => Promise<PluginChangeFact>
}

function fakePort(state: Partial<FakeState> = {}): { port: PluginManagerPort; state: FakeState; emit: (event: PluginInstallEvent) => void } {
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const full: FakeState = {
    snapshotCalls: 0,
    setBundle: [],
    setPlugin: [],
    removeBundle: [],
    installCalls: [],
    inspectCalls: [],
    waitCalls: [],
    cancelCalls: [],
    snapshotImpl: async () => snapshot([
      { name: SELF_BUNDLE, enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] },
      { name: 'ordinary', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] },
    ]),
    inspectImpl: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1.0.0', bundle: true, registry: null }),
    installImpl: async () => change({ stage: 'install' }),
    waitImpl: async () => null,
    cancelImpl: async () => ({ status: 'not-running' }),
    ...state,
  }
  const port: PluginManagerPort = {
    snapshot: async () => { full.snapshotCalls += 1; return full.snapshotImpl() },
    inspect: async (spec, registry) => { full.inspectCalls.push({ spec, registry }); return full.inspectImpl(spec, registry ?? null) },
    setBundleEnabled: async (name, enabled) => {
      full.setBundle.push({ name, enabled })
      return full.setBundleImpl === undefined ? change() : full.setBundleImpl(name, enabled)
    },
    setPluginEnabled: async (id, enabled) => { full.setPlugin.push({ id, enabled }); return change() },
    removeBundle: async (name) => { full.removeBundle.push({ name }); return change({ stage: 'remove' }) },
    startInstall: async (request) => { full.installCalls.push(request); return full.installImpl(request) },
    waitForInstall: async (requestId) => { full.waitCalls.push(requestId); return full.waitImpl(requestId) },
    cancelInstall: async (requestId) => { full.cancelCalls.push(requestId); return full.cancelImpl(requestId) },
    subscribeInstall: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return { port, state: full, emit: event => { for (const listener of listeners) listener(event) } }
}

function controllerOf(port: PluginManagerPort): { controller: PluginManagerController; renders: () => number } {
  let renders = 0
  const controller = new PluginManagerController(port, {
    requestRender: () => { renders += 1 },
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return { controller, renders: () => renders }
}

function select(controller: PluginManagerController, value: string): void {
  const selectable = controller.rows().filter(row => row.selectable)
  const target = selectable.findIndex(row => row.value === value)
  assert.ok(target >= 0, `row ${value} must exist`)
  for (let i = 0; i < selectable.length + 1; i += 1) {
    if (controller.selectedValue() === value) return
    controller.move(1)
  }
  assert.equal(controller.selectedValue(), value)
}

test('opening reads once; a failed refresh keeps the last good snapshot', async () => {
  let fail = false
  const { port, state } = fakePort({ snapshotImpl: async () => { if (fail) throw new Error('boom'); return snapshot([{ name: 'ordinary', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }]) } })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  assert.equal(state.snapshotCalls, 1)
  assert.equal(controller.status().state, 'ready')
  assert.ok(controller.rows().some(row => row.value === bundleValue('ordinary')))

  fail = true
  controller.refresh()
  await tick()
  assert.equal(state.snapshotCalls, 2)
  assert.equal(controller.status().state, 'error')
  // The previous good snapshot is still rendered.
  assert.ok(controller.rows().some(row => row.value === bundleValue('ordinary')))
  assert.match(controller.notice() ?? '', /refresh failed/)
})

test('Current-TUI self-protection rejects disable/remove at dispatch with zero Host mutation', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()

  // The UI omits the action; the dispatch guard must still reject a direct
  // attempt on the selected self card.
  select(controller, bundleValue(SELF_BUNDLE))
  await controller.toggleSelectedCard()
  await tick()
  assert.equal(state.setBundle.length, 0, 'self bundle must never dispatch setBundleEnabled')
  assert.match(controller.notice() ?? '', /current TUI/)

  controller.requestRemoveSelected()
  assert.ok(!controller.rows().some(row => row.value === PLUGIN_ACTION.confirmRemove), 'no confirmation for the self bundle')

  // The detail page never offers the destructive actions either.
  controller.activate()
  assert.ok(!controller.rows().some(row => row.value === PLUGIN_ACTION.toggle))
  assert.ok(!controller.rows().some(row => row.value === PLUGIN_ACTION.remove))
})

test('an ordinary bundle toggles through the official port and then re-reads', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()

  select(controller, bundleValue('ordinary'))
  controller.activate()
  select(controller, PLUGIN_ACTION.toggle)
  controller.activate()
  await tick()
  assert.deepEqual(state.setBundle, [{ name: 'ordinary', enabled: false }])
  assert.equal(state.snapshotCalls, 2, 'a mutation is followed by a fresh official inventory read')
  assert.equal(controller.notice(), 'enable applied')
})

test('a stale remove confirmation never mutates', async () => {
  let dropOrdinary = false
  const { port, state } = fakePort({
    snapshotImpl: async () => snapshot(dropOrdinary
      ? []
      : [{ name: 'ordinary', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }]),
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()

  select(controller, bundleValue('ordinary'))
  controller.activate()
  select(controller, PLUGIN_ACTION.remove)
  controller.activate()
  assert.equal(controller.rows().some(row => row.value === PLUGIN_ACTION.confirmRemove), true)

  // A refresh replaces/removes the row while the confirmation is open.
  dropOrdinary = true
  controller.refresh()
  await tick()
  select(controller, PLUGIN_ACTION.confirmRemove)
  controller.activate()
  await tick()
  assert.deepEqual(state.removeBundle, [], 'the stale confirmation must not mutate')
})

test('install: one request id, close/reopen does not dispatch a second install', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state } = fakePort({ installImpl: () => gate.promise })
  const { controller } = controllerOf(port)

  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  assert.equal(state.inspectCalls.length, 1)
  assert.equal(controller.installView()?.phase, 'confirm')

  controller.confirmInstall()
  await tick()
  assert.equal(state.installCalls.length, 1)
  const requestId = (state.installCalls[0] as { requestId: string }).requestId
  assert.equal(controller.installView()?.phase, 'starting')

  // Close and reopen: the SAME active operation is resumed.
  controller.closeInstall()
  controller.openInstall()
  assert.equal(controller.installView()?.phase, 'starting')
  assert.equal(state.installCalls.length, 1, 'reopening must not call installBundle again')

  gate.resolve(change({ stage: 'install', application: 'restart-required' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')
  assert.match(controller.installView()?.message ?? '', /restart the profile/)
  assert.equal(state.snapshotCalls, 1, 'the final outcome refreshes the inventory')
  void requestId
})

test('install recovery: an indeterminate throw reconciles through waitForInstall and never retries', async () => {
  const { port, state } = fakePort({
    installImpl: async () => { throw new Error('socket closed') },
    waitImpl: async () => change({ stage: 'install', application: 'applied' }),
  })
  const { controller } = controllerOf(port)
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(state.installCalls.length, 1)
  assert.equal(state.waitCalls.length, 1)
  assert.equal(controller.installView()?.phase, 'done')
})

test('install recovery: waitForInstall null marks the result unknown without a retry', async () => {
  const { port, state } = fakePort({
    installImpl: async () => { throw new Error('socket closed') },
    waitImpl: async () => null,
  })
  const { controller } = controllerOf(port)
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(controller.installView()?.phase, 'unknown')
  assert.equal(state.installCalls.length, 1)
  assert.match(controller.installView()?.message ?? '', /not retried automatically/)
})

test('install cancel: too-late keeps the operation running and applying disables cancel', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state, emit } = fakePort({
    installImpl: () => gate.promise,
    cancelImpl: async () => ({ status: 'too-late' }),
  })
  const { controller } = controllerOf(port)
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()

  const requestId = (state.installCalls[0] as { requestId: string }).requestId
  emit({ kind: 'phase', phase: { requestId, phase: 'applying' } })
  assert.equal(controller.installView()?.phase, 'applying')
  assert.equal(controller.installView()?.cancellable, false, 'cancel is disabled once applying')

  // A cancel during installing returns too-late and does not fabricate success.
  emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  controller.cancelInstall()
  await tick()
  assert.deepEqual(state.cancelCalls, [requestId])
  assert.equal(controller.installView()?.phase, 'applying')
  assert.match(controller.installView()?.message ?? '', /too late/)
  gate.resolve(change({ stage: 'install' }))
  await tick()
})

test('a custom registry is validated before any Host dispatch', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.openInstall()
  controller.inspect('pkg', 'not-a-url')
  await tick()
  assert.equal(state.inspectCalls.length, 0)
  assert.match(controller.installView()?.message ?? '', /http\(s\) URL/)
})

test('standalone entry toggle uses the official plugin-entry mutation', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => ({
      bundles: [],
      plugins: [{ entryId: 'e-free', moduleName: 'free', enabled: true, fiberPhase: 'active', patchId: 'free' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, entryValue('e-free'))
  controller.activate()
  select(controller, PLUGIN_ACTION.toggle)
  controller.activate()
  await tick()
  assert.deepEqual(state.setPlugin, [{ id: 'e-free', enabled: false }])
})

test('remove success goes through the official service and refreshes', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, bundleValue('ordinary'))
  controller.activate()
  select(controller, PLUGIN_ACTION.remove)
  controller.activate()
  select(controller, PLUGIN_ACTION.confirmRemove)
  controller.activate()
  await tick()
  assert.deepEqual(state.removeBundle, [{ name: 'ordinary' }])
  assert.equal(state.snapshotCalls, 2)
})

test('an ordinary read-only bundle exposes no mutation affordance and rejects a direct dispatch', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => snapshot([
      { name: 'managed', enabled: true, installed: true, optional: false, removable: false, readOnlyReason: 'management-required', rows: [], overrides: [] },
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, bundleValue('managed'))
  controller.activate()
  assert.ok(!controller.rows().some(row => row.value === PLUGIN_ACTION.toggle))
  assert.ok(!controller.rows().some(row => row.value === PLUGIN_ACTION.remove))
  controller.back()
  select(controller, bundleValue('managed'))
  await controller.toggleSelectedCard()
  await tick()
  assert.equal(state.setBundle.length, 0)
  assert.match(controller.notice() ?? '', /management-required/)
  controller.requestRemoveSelected()
  assert.ok(!controller.rows().some(row => row.value === PLUGIN_ACTION.confirmRemove))
})

test('a late old mutation cannot overwrite a newer refresh', async () => {
  const gate = deferred<PluginChangeFact>()
  let drop = false
  const { port } = fakePort({
    setBundleImpl: () => gate.promise,
    snapshotImpl: async () => snapshot(drop
      ? []
      : [{ name: 'ordinary', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }]),
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, bundleValue('ordinary'))
  controller.activate()
  select(controller, PLUGIN_ACTION.toggle)
  controller.activate() // dispatch the slow mutation
  await tick()
  // A newer refresh commits a snapshot without the bundle…
  drop = true
  controller.refresh()
  await tick()
  assert.ok(!controller.rows().some(row => row.value === bundleValue('ordinary')))
  // …then the old mutation settles and re-reads; the newest truth still wins.
  gate.resolve(change())
  await tick()
  assert.ok(!controller.rows().some(row => row.value === bundleValue('ordinary')))
})

test('row-level self protection never offers a toggle row action', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => snapshot([
      {
        name: SELF_BUNDLE,
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        rows: [{ rowId: 'app', moduleName: SELF_BUNDLE, entryId: 'e-app' }],
        overrides: [],
      },
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, bundleValue(SELF_BUNDLE))
  controller.activate()
  const rows = controller.rows()
  assert.ok(rows.some(row => row.label === 'Plugin rows'))
  assert.ok(!rows.some(row => row.value.startsWith('action:toggle-row:')), 'no self row toggle action')
  assert.equal(state.setPlugin.length, 0)
})
