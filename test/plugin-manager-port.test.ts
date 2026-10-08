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
import { SELF_BUNDLE } from '../src/app/plugin-manager/classify.ts'
import { PluginManagerController } from '../src/app/plugin-manager/controller.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { PLUGIN_ACTION, bundleValue, entryValue } from '../src/app/plugin-manager/model.ts'
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
  inspectImpl: (spec: string, registry: string | null, signal?: AbortSignal) => Promise<PluginSpecInspectionFact>
  installImpl: (request: unknown) => Promise<PluginChangeFact>
  waitImpl: (requestId: string) => Promise<PluginChangeFact | null>
  cancelImpl: (requestId: string) => Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }>
  setBundleImpl?: (name: string, enabled: boolean) => Promise<PluginChangeFact>
}

function fakePort(state: Partial<FakeState> = {}): {
  port: PluginManagerPort
  state: FakeState
  emit: (event: PluginInstallEvent) => void
  invalidate: () => void
  /** How many times each subscription's disposer was actually invoked. */
  offCalls: { install: number; invalidation: number }
  installSubscriptions: () => number
  invalidationSubscriptions: () => number
} {
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const invalidationListeners = new Set<() => void>()
  const offCalls = { install: 0, invalidation: 0 }
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
    inspect: async (spec, registry, signal) => {
      full.inspectCalls.push({ spec, registry })
      return full.inspectImpl(spec, registry ?? null, signal)
    },
    setBundleEnabled: async (name, enabled) => {
      full.setBundle.push({ name, enabled })
      return full.setBundleImpl === undefined ? change() : full.setBundleImpl(name, enabled)
    },
    setPluginEnabled: async (id, enabled) => { full.setPlugin.push({ id, enabled }); return change() },
    removeBundle: async (name) => { full.removeBundle.push({ name }); return change({ stage: 'remove' }) },
    startInstall: async (request) => { full.installCalls.push(request); return full.installImpl(request) },
    waitForInstall: async (requestId) => { full.waitCalls.push(requestId); return full.waitImpl(requestId) },
    cancelInstall: async (requestId) => { full.cancelCalls.push(requestId); return full.cancelImpl(requestId) },
    subscribeInstall: (listener) => {
      listeners.add(listener)
      return () => { offCalls.install += 1; listeners.delete(listener) }
    },
    subscribeInvalidation: (listener) => {
      invalidationListeners.add(listener)
      return () => { offCalls.invalidation += 1; invalidationListeners.delete(listener) }
    },
  }
  return {
    port,
    state: full,
    emit: event => { for (const listener of listeners) listener(event) },
    invalidate: () => { for (const listener of [...invalidationListeners]) listener() },
    offCalls,
    installSubscriptions: () => listeners.size,
    invalidationSubscriptions: () => invalidationListeners.size,
  }
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
    snapshotImpl: async () => ({
      bundles: [{
        name: SELF_BUNDLE,
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        rows: [{ rowId: 'app', moduleName: SELF_BUNDLE, entryId: 'e-app' }],
        overrides: [],
      }],
      // The self row is LIVE and addressable: absent the self policy its
      // effective toggle would be true.
      plugins: [{ entryId: 'e-app', moduleName: SELF_BUNDLE, enabled: true, fiberPhase: 'active', patchId: 'app' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
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

test('a settlement-side hook throw never misclassifies a successful install', async () => {
  let settleThrow = false
  const { port } = fakePort({
    installImpl: async () => {
      // Arm the throw so it fires from SETTLEMENT, after startInstall resolved.
      settleThrow = true
      return change({ stage: 'install' })
    },
  })
  const controller = new PluginManagerController(port, {
    requestRender: () => { if (settleThrow) throw new Error('render boom') },
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick(8)
  assert.equal(controller.installView()?.phase, 'done', 'the successful outcome must not be overwritten by a settlement throw')
})

test('the Refresh action row clears a stale read-failure notice', async () => {
  let fail = true
  const { port } = fakePort({
    snapshotImpl: async () => {
      if (fail) throw new Error('boom')
      return snapshot([{ name: 'ordinary', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }])
    },
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  assert.match(controller.notice() ?? '', /refresh failed/)
  fail = false
  select(controller, PLUGIN_ACTION.refresh)
  controller.activate()
  await tick()
  assert.equal(controller.status().state, 'ready')
  assert.equal(controller.notice(), undefined, 'a successful action-row refresh clears the stale notice')
})

test('an operation outcome message survives an explicit refresh', async () => {
  const { port } = fakePort()
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, bundleValue('ordinary'))
  controller.activate()
  select(controller, PLUGIN_ACTION.toggle)
  controller.activate()
  await tick()
  assert.equal(controller.notice(), 'enable applied')
  controller.refresh()
  await tick()
  assert.equal(controller.notice(), 'enable applied', 'refresh must not wipe an operation outcome')
})

test('a protected TUI-module entry is refused with the module wording and never mutated', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => ({
      bundles: [{
        name: SELF_BUNDLE,
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        // No entryId: the row cannot exclude the live entry by id.
        rows: [{ rowId: 'builtins', moduleName: `${SELF_BUNDLE}/builtins` }],
        overrides: [],
      }],
      plugins: [{ entryId: 'include:builtins', moduleName: `${SELF_BUNDLE}/builtins`, enabled: true, fiberPhase: 'active', patchId: 'builtins' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  select(controller, entryValue('include:builtins'))
  await controller.toggleSelectedCard()
  await tick()
  assert.equal(state.setPlugin.length, 0)
  assert.match(controller.notice() ?? '', /controlled by the Current TUI composition/)
})

// ── invalidation / read currentness / disposal (M3-5 PR4) ─────────────────────

function bundleOnly(name: string): PluginManagerSnapshot {
  return snapshot([{ name, enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }])
}

test('latest-started read wins: a newer read start invalidates every older in-flight read', async () => {
  const older = deferred<PluginManagerSnapshot>()
  const newer = deferred<PluginManagerSnapshot>()
  const queue = [older, newer]
  const { port, state } = fakePort({ snapshotImpl: () => queue.shift()!.promise })
  const { controller } = controllerOf(port)
  controller.open('direct-command') // read A
  await tick()
  controller.refresh() // read B starts while A is still in flight
  await tick()
  assert.equal(state.snapshotCalls, 2)

  // B settles first with B: final model is B.
  newer.resolve(bundleOnly('fresh-b'))
  await tick()
  assert.ok(controller.rows().some(row => row.value === bundleValue('fresh-b')))

  // A then settles with A: it started before B and must never commit.
  older.resolve(bundleOnly('stale-a'))
  await tick()
  assert.ok(controller.rows().some(row => row.value === bundleValue('fresh-b')), 'the newer read owns the commit')
  assert.ok(!controller.rows().some(row => row.value === bundleValue('stale-a')), 'an older read must not repaint')
})

test('an older read completing while a newer read is in flight never commits', async () => {
  const older = deferred<PluginManagerSnapshot>()
  const newer = deferred<PluginManagerSnapshot>()
  const queue = [older, newer]
  const { port } = fakePort({ snapshotImpl: () => queue.shift()!.promise })
  const { controller } = controllerOf(port)
  controller.open('direct-command') // read A
  await tick()
  controller.refresh() // read B starts while A is still in flight
  await tick()

  // A settles BEFORE B: it already lost the currentness race at B's start.
  older.resolve(bundleOnly('stale-a'))
  await tick()
  assert.ok(!controller.rows().some(row => row.value === bundleValue('stale-a')), 'A must not commit once B started')

  newer.resolve(bundleOnly('fresh-b'))
  await tick()
  assert.ok(controller.rows().some(row => row.value === bundleValue('fresh-b')))
})

test('a newest read failure keeps the last good snapshot; a stale older success cannot clear it', async () => {
  const stale = deferred<PluginManagerSnapshot>()
  let call = 0
  const { port } = fakePort({
    snapshotImpl: () => {
      call += 1
      if (call === 1) return Promise.resolve(bundleOnly('good'))
      if (call === 2) return stale.promise
      return Promise.reject(new Error('carrier offline'))
    },
  })
  const { controller } = controllerOf(port)
  controller.open('direct-command')
  await tick()
  assert.ok(controller.rows().some(row => row.value === bundleValue('good')))

  controller.refresh() // read B (stale, held)
  await tick()
  controller.refresh() // read C (newest, fails)
  await tick()
  assert.equal(controller.status().state, 'error')
  assert.match(controller.notice() ?? '', /refresh failed/)

  // The stale B success settles afterwards: it must neither repaint stale
  // inventory nor clear the newer failure.
  stale.resolve(bundleOnly('stale-b'))
  await tick()
  assert.equal(controller.status().state, 'error')
  assert.match(controller.notice() ?? '', /refresh failed/)
  assert.ok(controller.rows().some(row => row.value === bundleValue('good')), 'the last good snapshot stays visible')
  assert.ok(!controller.rows().some(row => row.value === bundleValue('stale-b')))
})

test('invalidation reads only while a surface is showing the inventory', async () => {
  let open = false
  const { port, state, invalidate } = fakePort()
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => open,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })

  invalidate()
  await tick()
  assert.equal(state.snapshotCalls, 0, 'a never-opened controller must not start a background read')

  open = true
  controller.open('direct-command')
  await tick()
  assert.equal(state.snapshotCalls, 1, 'open performs the authoritative read')

  invalidate()
  await tick()
  assert.equal(state.snapshotCalls, 2, 'an invalidation while open rereads')

  open = false
  invalidate()
  await tick()
  assert.equal(state.snapshotCalls, 2, 'a closed panel must not start a background read')

  open = true
  controller.open('direct-command')
  await tick()
  assert.equal(state.snapshotCalls, 3, 'reopening always performs a fresh read')
})

test('a throwing invalidation subscription releases the install subscription and rethrows', () => {
  const { port, offCalls } = fakePort()
  port.subscribeInvalidation = () => { throw new Error('invalidation subscription refused') }
  assert.throws(() => controllerOf(port), /invalidation subscription refused/)
  assert.equal(offCalls.install, 1, 'the already-installed install subscription is released exactly once')
})

test('dispose releases BOTH subscriptions exactly once and is idempotent', () => {
  const { port, invalidate, offCalls, installSubscriptions, invalidationSubscriptions } = fakePort()
  const { controller } = controllerOf(port)
  assert.equal(installSubscriptions(), 1)
  assert.equal(invalidationSubscriptions(), 1)

  controller.dispose()
  controller.dispose()
  assert.equal(installSubscriptions(), 0, 'the install-event subscription is released')
  assert.equal(invalidationSubscriptions(), 0, 'the invalidation subscription is released')
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 }, 'each subscription disposer runs exactly once')
  invalidate()
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 }, 'a disposed controller never re-subscribes or re-releases')
})

test('M3-6 PR3: a throwing install-event unsubscribe cannot strand the invalidation release', () => {
  const failure = new Error('install unsubscribe failed')
  const base = fakePort()
  const { offCalls, invalidate, emit, installSubscriptions, invalidationSubscriptions, state } = base
  const port: PluginManagerPort = {
    ...base.port,
    subscribeInstall: (listener) => {
      const release = base.port.subscribeInstall(listener)
      return () => {
        release()
        throw failure
      }
    },
  }
  const { controller, renders } = controllerOf(port)
  assert.equal(installSubscriptions(), 1)
  assert.equal(invalidationSubscriptions(), 1)

  assert.throws(() => controller.dispose(), (error: unknown) => error === failure)
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 },
    'the second unsubscribe still ran after the first threw')
  assert.equal(installSubscriptions(), 0)
  assert.equal(invalidationSubscriptions(), 0)

  // The disposed latch stays committed: a second dispose is inert and no later
  // invalidation/install event can read or repaint.
  controller.dispose()
  const rendersAtDispose = renders()
  invalidate()
  emit({ kind: 'phase', phase: { requestId: 'r1', phase: 'applying' } })
  assert.equal(state.snapshotCalls, 0, 'a disposed controller performs no read')
  assert.equal(renders(), rendersAtDispose, 'a disposed controller never repaints')
})

test('a held inventory read settled after dispose never commits nor repaints (success and failure)', async () => {
  for (const settlement of ['success', 'failure'] as const) {
    const readGate = deferred<PluginManagerSnapshot>()
    const { port, state } = fakePort({ snapshotImpl: () => readGate.promise })
    const { controller, renders } = controllerOf(port)
    controller.open('direct-command')
    await tick()
    assert.equal(state.snapshotCalls, 1, 'the inventory read is genuinely in flight')
    const rendersAtDispose = renders()

    controller.dispose()
    controller.dispose()
    if (settlement === 'success') readGate.resolve(bundleOnly('late-read'))
    else readGate.reject(new Error('carrier offline'))
    await tick()

    assert.equal(renders(), rendersAtDispose, `a late ${settlement} settlement must not repaint`)
    assert.equal(controller.status().state, 'loading', 'a late settlement never commits a state')
    assert.ok(!controller.rows().some(row => row.value === bundleValue('late-read')))
  }
})

test('dispose aborts an in-flight inspect, releases both subscriptions and never cancels an install', async () => {
  const inspectGate = deferred<PluginSpecInspectionFact>()
  let inspectSignal: AbortSignal | undefined
  const { port, state, invalidate, offCalls, installSubscriptions, invalidationSubscriptions } = fakePort({
    inspectImpl: (_spec, _registry, signal) => {
      inspectSignal = signal
      return inspectGate.promise
    },
  })
  const { controller, renders } = controllerOf(port)
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  assert.ok(inspectSignal !== undefined, 'the inspect was dispatched')
  assert.equal(inspectSignal.aborted, false)
  assert.equal(installSubscriptions(), 1)
  assert.equal(invalidationSubscriptions(), 1, 'the controller owns one invalidation subscription')
  const rendersAtDispose = renders()

  controller.dispose()
  assert.equal(inspectSignal.aborted, true, 'dispose aborts the in-flight inspect')
  assert.equal(installSubscriptions(), 0, 'dispose releases the install-event subscription')
  assert.equal(invalidationSubscriptions(), 0, 'dispose releases the invalidation subscription')
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 }, 'neither subscription is released twice')

  invalidate()
  inspectGate.resolve({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null })
  await tick()
  assert.equal(state.snapshotCalls, 0, 'a disposed controller performs no read')
  assert.equal(state.cancelCalls.length, 0, 'dispose must never cancel a Host install')
  assert.equal(controller.installView()?.phase, 'inspecting', 'a late inspect result never advances the phase')
  assert.equal(renders(), rendersAtDispose, 'a late inspect result never repaints a disposed controller')
})

test('dispose during a Host install neither cancels nor retries it and ignores a late install event', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state, emit, installSubscriptions } = fakePort({ installImpl: () => gate.promise })
  const { controller, renders } = controllerOf(port)
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(state.installCalls.length, 1)
  const requestId = (state.installCalls[0] as { requestId: string }).requestId
  const rendersAtDispose = renders()

  controller.dispose()
  // The DECISIVE mechanism for "no later install event reaches the controller"
  // is the released subscription itself: once disposed there is no listener to
  // deliver to (releasing it is proven by the off-call counts).
  assert.equal(installSubscriptions(), 0, 'dispose released the install-event subscription')
  emit({ kind: 'phase', phase: { requestId, phase: 'applying' } })
  assert.equal(controller.installView()?.phase, 'starting', 'a late install event cannot be delivered')

  // The late SETTLEMENT is an async continuation that does resume after
  // disposal, so its own disposed fence is what this assertion discriminates.
  gate.resolve(change({ stage: 'install' }))
  await tick()
  assert.equal(state.cancelCalls.length, 0, 'dispose must never cancel a Host install')
  assert.equal(state.waitCalls.length, 0, 'dispose must never retry/recover an install')
  assert.equal(state.snapshotCalls, 0, 'a late install settlement cannot mutate a disposed controller')
  assert.equal(controller.installView()?.phase, 'starting', 'the disposed controller never settles and never advances the install')
  assert.equal(renders(), rendersAtDispose, 'a disposed controller never repaints')
})
