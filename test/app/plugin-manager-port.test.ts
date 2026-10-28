/**
 * Controller contract tests (S4-D1): the operation/inventory owner over a fake
 * semantic port. Covers read/refresh currentness, the Current-TUI
 * self-protection guard at dispatch (not only in the UI), mutation identity,
 * the remove-confirmation epoch, and the install lifecycle (request identity,
 * recovery, cancel, approval and close/reopen without a duplicate install).
 * @module @xmoon76/dsh-pi-tui/plugin-manager-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SELF_BUNDLE } from '../../src/app/plugin-manager/classify.ts'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { PLUGIN_ACTION, bundleValue, buildPluginDetailView, entryValue } from '../../src/app/plugin-manager/model.ts'
import { PluginManagerStaleResultError } from '../../src/runtime/plugin-manager-port.ts'
import type {
  PluginBundleFact,
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
} from '../../src/runtime/plugin-manager-port.ts'

function change(overrides: Partial<PluginChangeFact> = {}): PluginChangeFact {
  return { changed: true, application: 'applied', stage: 'enable', target: 'x', ...overrides }
}

function bundle(overrides: Partial<PluginBundleFact> = {}): PluginBundleFact {
  return {
    name: 'ordinary',
    official: false,
    availability: 'profile',
    source: 'file:/tmp/ordinary',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...overrides,
  }
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

async function tick(times = 6): Promise<void> {
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
      bundle({ name: SELF_BUNDLE, source: 'file:/tui' }),
      bundle(),
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
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return { controller, renders: () => renders }
}

function card(controller: PluginManagerController, value: string) {
  return controller.card(value)
}

test('opening reads once; a failed refresh keeps the last good snapshot', async () => {
  let fail = false
  const { port, state } = fakePort({ snapshotImpl: async () => { if (fail) throw new Error('boom'); return snapshot([bundle()]) } })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.equal(state.snapshotCalls, 1)
  assert.equal(controller.status().state, 'ready')
  assert.ok(card(controller, bundleValue('ordinary')) !== undefined)

  fail = true
  controller.refresh()
  await tick()
  assert.equal(state.snapshotCalls, 2)
  assert.equal(controller.status().state, 'error')
  // The previous good snapshot is still rendered.
  assert.ok(card(controller, bundleValue('ordinary')) !== undefined)
  assert.match(controller.notice() ?? '', /refresh failed/)
})

test('the four sections are exposed in frozen order (Experimental last)', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
      bundle({ name: '@deepseek-ai/dsh-experimental-auto-review', official: true, availability: 'missing', installed: false, optional: true, removable: false, source: undefined, installTarget: { spec: 'x@1', version: '1' } }),
      bundle(),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.deepEqual(controller.sections().map(section => section.id), ['tui', 'official', 'third-party', 'experimental'])
  assert.deepEqual(controller.sections().at(-1)!.cards.map(entry => entry.name), ['@deepseek-ai/dsh-experimental-auto-review'])
})

test('Current-TUI self-protection rejects disable/remove at dispatch with zero Host mutation', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.open()
  await tick()

  await controller.toggleCard(bundleValue(SELF_BUNDLE))
  await tick()
  assert.equal(state.setBundle.length, 0, 'self bundle must never dispatch setBundleEnabled')
  assert.match(controller.notice() ?? '', /Current TUI/)

  assert.equal(controller.requestRemove(bundleValue(SELF_BUNDLE)), false, 'no confirmation for the self bundle')

  // The detail projection never offers an enabled destructive action either.
  const self = card(controller, bundleValue(SELF_BUNDLE))!
  const detail = buildPluginDetailView(self)
  assert.ok(!detail.actions.some(action => action.value === PLUGIN_ACTION.toggle), 'no self toggle action')
  assert.ok(!detail.actions.some(action => action.value === PLUGIN_ACTION.remove), 'no self remove action')
  assert.deepEqual(detail.actions.map(action => action.value), [PLUGIN_ACTION.back])
})

test('an ordinary bundle toggles through the official port and then re-reads', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.open()
  await tick()

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.deepEqual(state.setBundle, [{ name: 'ordinary', enabled: false }])
  assert.equal(state.snapshotCalls, 2, 'a mutation is followed by a fresh official inventory read')
  assert.equal(controller.notice(), 'enable applied')
})

test('a stale remove confirmation never mutates', async () => {
  let dropOrdinary = false
  const { port, state } = fakePort({
    snapshotImpl: async () => snapshot(dropOrdinary ? [] : [bundle()]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()

  assert.equal(controller.requestRemove(bundleValue('ordinary')), true)
  assert.equal(controller.confirmingName(), 'ordinary')

  // A refresh replaces/removes the row while the confirmation is open.
  dropOrdinary = true
  controller.refresh()
  await tick()
  assert.equal(controller.confirmingCard(), undefined, 'the epoch fence invalidates the old confirmation')
  controller.confirmRemove()
  await tick()
  assert.deepEqual(state.removeBundle, [], 'the stale confirmation must not mutate')
})

test('remove success goes through the official service and refreshes', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.equal(controller.requestRemove(bundleValue('ordinary')), true)
  controller.confirmRemove()
  await tick()
  assert.deepEqual(state.removeBundle, [{ name: 'ordinary' }])
  assert.equal(state.snapshotCalls, 2)
})

test('install: one request id; hide/reopen does not dispatch a second install', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state } = fakePort({ installImpl: () => gate.promise })
  const { controller } = controllerOf(port)

  assert.equal(controller.beginManualInstall(), true)
  controller.inspect('pkg', null)
  await tick()
  assert.equal(state.inspectCalls.length, 1)
  assert.equal(controller.installView()?.phase, 'confirm')

  controller.confirmInstall()
  await tick()
  assert.equal(state.installCalls.length, 1)
  assert.equal(controller.installView()?.phase, 'starting')
  assert.equal(controller.hasDispatchedInstall(), true)

  // Hide and reopen: the SAME active operation is resumed.
  controller.hideInstall()
  assert.equal(controller.beginManualInstall(), false, 'a live operation is reopened, never replaced')
  assert.equal(controller.installView()?.phase, 'starting')
  assert.equal(state.installCalls.length, 1, 'reopening must not call installBundle again')

  gate.resolve(change({ stage: 'install', application: 'restart-required', restartReason: 'no-hmr', version: '2.0.0' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')
  assert.match(controller.installView()?.message ?? '', /restart required/)
  assert.equal(controller.installView()?.outcome?.version, '2.0.0')
  assert.equal(state.snapshotCalls, 1, 'the final outcome refreshes the inventory')
})

test('official missing card install starts from the Host installTarget, never a toggle', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({
        name: '@deepseek-ai/dsh-experimental-auto-review',
        official: true,
        availability: 'missing',
        installed: false,
        optional: true,
        removable: false,
        source: undefined,
        installTarget: { spec: '@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2', version: '0.2.1-rc.2' },
      }),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()

  // A direct toggle of a missing bundle is refused and never dispatches.
  await controller.toggleCard(bundleValue('@deepseek-ai/dsh-experimental-auto-review'))
  await tick()
  assert.equal(state.setBundle.length, 0)
  assert.match(controller.notice() ?? '', /not installed/)

  assert.equal(controller.beginOfficialInstall(bundleValue('@deepseek-ai/dsh-experimental-auto-review')), true)
  await tick()
  assert.equal(state.inspectCalls.length, 1)
  assert.equal((state.inspectCalls[0] as { spec: string }).spec, '@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2')
  assert.equal(controller.installView()?.officialName, '@deepseek-ai/dsh-experimental-auto-review')
  assert.equal(controller.installView()?.phase, 'confirm')
})

test('editing an official install spec drops the official catalog context', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({
        name: '@deepseek-ai/dsh-experimental-auto-review',
        official: true,
        availability: 'missing',
        installed: false,
        optional: true,
        removable: false,
        source: undefined,
        installTarget: { spec: '@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2', version: '0.2.1-rc.2' },
      }),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.equal(controller.beginOfficialInstall(bundleValue('@deepseek-ai/dsh-experimental-auto-review')), true)
  await tick()
  assert.equal(controller.installView()?.officialName, '@deepseek-ai/dsh-experimental-auto-review')
  controller.inspect('/tmp/local-bundle', null)
  await tick()
  assert.equal(controller.installView()?.phase, 'confirm')
  assert.equal(controller.installView()?.officialName, undefined,
    'a user-edited spec is a manual install, not an install of the original catalog card')
})

test('install recovery: an indeterminate throw reconciles through waitForInstall and never retries', async () => {
  const { port, state } = fakePort({
    installImpl: async () => { throw new Error('socket closed') },
    waitImpl: async () => change({ stage: 'install', application: 'applied' }),
  })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
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
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(controller.installView()?.phase, 'unknown')
  assert.equal(state.installCalls.length, 1)
  assert.match(controller.installView()?.message ?? '', /not retried automatically/)
})

test('reconcileInstall rereads through waitForInstall and never re-dispatches', async () => {
  const { port, state } = fakePort({
    installImpl: async () => { throw new Error('socket closed') },
    waitImpl: async () => null,
  })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(controller.installView()?.phase, 'unknown')
  controller.reconcileInstall()
  await tick()
  assert.equal(state.installCalls.length, 1, 'reconcile never calls installBundle again')
  assert.equal(state.waitCalls.length, 2)
  assert.match(controller.installView()?.message ?? '', /inventory reread/)
})

test('approving pending builds uses a NEW request id and the exact Host-reported names', async () => {
  const firstAttempt = deferred<PluginChangeFact>()
  const secondAttempt = deferred<PluginChangeFact>()
  let installAttempt = 0
  const { port, state } = fakePort({
    installImpl: async () => {
      installAttempt += 1
      return installAttempt === 1 ? firstAttempt.promise : secondAttempt.promise
    },
    snapshotImpl: async () => snapshot([bundle()]),
  })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const firstId = (state.installCalls[0] as { requestId: string }).requestId
  firstAttempt.resolve(change({
    stage: 'install',
    application: 'failed',
    packageResult: { exitCode: 1, output: 'blocked', truncated: false, kind: 'build-blocked' },
    pendingBuilds: ['esbuild', 'sharp'],
    failedAt: 'registry',
  }))
  await tick()
  assert.equal(controller.installView()?.phase, 'failed')
  assert.deepEqual(controller.approvableBuilds(), ['esbuild', 'sharp'])

  controller.approvePendingBuilds()
  await tick()
  assert.equal(state.installCalls.length, 2)
  const second = state.installCalls[1] as { requestId: string; approvedBuilds: readonly string[]; spec: string }
  assert.notEqual(second.requestId, firstId, 'approval is a new explicit request')
  assert.deepEqual(second.approvedBuilds, ['esbuild', 'sharp'])
  assert.equal(second.spec, 'pkg')
  secondAttempt.resolve(change({ stage: 'install', application: 'applied', version: '1.2.3' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')
  assert.equal(controller.installView()?.outcome?.version, '1.2.3')
})

test('install cancel: too-late keeps the operation running and applying disables cancel', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state, emit } = fakePort({
    installImpl: () => gate.promise,
    cancelImpl: async () => ({ status: 'too-late' }),
  })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
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

test('a stale-generation cancel is indeterminate and rereads the inventory', async () => {
  const { port, state } = fakePort({
    installImpl: () => new Promise<PluginChangeFact>(() => {}),
    cancelImpl: async () => { throw new PluginManagerStaleResultError('cancelInstall') },
  })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const before = state.snapshotCalls
  controller.cancelInstall()
  await tick()
  assert.equal(controller.installView()?.phase, 'unknown')
  assert.match(controller.installView()?.message ?? '', /superseded currentness context/)
  assert.ok(state.snapshotCalls > before, 'the authoritative inventory is reread')
  controller.dispose()
})

test('a stale-generation install reconcile is indeterminate and rereads the inventory', async () => {
  const { port, state } = fakePort({
    installImpl: async () => { throw new Error('carrier lost') },
    waitImpl: async () => { throw new PluginManagerStaleResultError('waitForInstall') },
  })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(controller.installView()?.phase, 'unknown')
  const before = state.snapshotCalls
  controller.reconcileInstall()
  await tick()
  assert.equal(controller.installView()?.phase, 'unknown')
  assert.match(controller.installView()?.message ?? '', /superseded currentness context/)
  assert.ok(state.snapshotCalls > before, 'the authoritative inventory is reread')
  controller.dispose()
})

test('a custom registry is validated before any Host dispatch', async () => {
  const { port, state } = fakePort()
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
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
  controller.open()
  await tick()
  controller.toggleCard(entryValue('e-free'))
  await tick()
  assert.deepEqual(state.setPlugin, [{ id: 'e-free', enabled: false }])
})

test('an ordinary read-only bundle exposes no enabled mutation affordance and rejects a direct dispatch', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => snapshot([bundle({
      name: 'managed',
      removable: false,
      readOnlyReason: 'management-required',
    })]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const managed = card(controller, bundleValue('managed'))!
  const detail = buildPluginDetailView(managed)
  assert.equal(detail.actions.find(action => action.value === PLUGIN_ACTION.toggle)?.enabled, false)
  assert.ok(!detail.actions.some(action => action.value === PLUGIN_ACTION.remove),
    'a non-removable shipped/read-only bundle has no Remove action at all')
  await controller.toggleCard(bundleValue('managed'))
  await tick()
  assert.equal(state.setBundle.length, 0)
  assert.match(controller.notice() ?? '', /DSH management/)
  assert.equal(controller.requestRemove(bundleValue('managed')), false)
})

test('a late old mutation cannot overwrite a newer refresh', async () => {
  const gate = deferred<PluginChangeFact>()
  let drop = false
  const { port } = fakePort({
    setBundleImpl: () => gate.promise,
    snapshotImpl: async () => snapshot(drop ? [] : [bundle()]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  controller.toggleCard(bundleValue('ordinary')) // dispatch the slow mutation
  await tick()
  drop = true
  controller.refresh()
  await tick()
  assert.equal(controller.card(bundleValue('ordinary')), undefined)
  gate.resolve(change())
  await tick()
  assert.equal(controller.card(bundleValue('ordinary')), undefined, 'the newest truth still wins')
})

test('a second mutation is refused while the first is still in flight (no lost final reread)', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state } = fakePort({ setBundleImpl: () => gate.promise })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 1, 'the second dispatch never reaches the Host')
  assert.match(controller.notice() ?? '', /still in progress/)
  assert.equal(state.snapshotCalls, 1, 'the first mutation has not settled yet')

  gate.resolve(change())
  await tick()
  assert.equal(controller.notice(), 'enable applied')
  assert.equal(state.snapshotCalls, 2, 'the first mutation still performs its authoritative reread')

  // The guard is released after settlement: a later explicit action dispatches.
  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 2)
})

test('toggle admission is held until the authoritative reread completes (deferred snapshot)', async () => {
  let enabled = false
  let reads = 0
  const reread = deferred<PluginManagerSnapshot>()
  const { port, state } = fakePort({
    snapshotImpl: async () => {
      reads += 1
      if (reads === 1) return snapshot([bundle({ name: 'ordinary', enabled })])
      if (reads === 2) return reread.promise
      return snapshot([bundle({ name: 'ordinary', enabled })])
    },
    setBundleImpl: async (_name, next) => { enabled = next; return change() },
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.equal(controller.card(bundleValue('ordinary'))?.enabled, false)

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 1)
  assert.equal(controller.busy(), bundleValue('ordinary'), 'busy is held across the post-write read')
  assert.equal(reads, 2, 'the authoritative read has started and is pending')

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 1, 'no write may use the pre-read snapshot')
  assert.equal(controller.card(bundleValue('ordinary'))?.enabled, false)

  reread.resolve(snapshot([bundle({ name: 'ordinary', enabled: true })]))
  await tick()
  assert.equal(controller.busy(), undefined)
  assert.equal(controller.card(bundleValue('ordinary'))?.enabled, true)

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 2)
  assert.equal((state.setBundle[1] as { enabled: boolean }).enabled, false,
    'the second user action is based on the authoritative enabled=true state')
})

test('row toggle admission is held through the authoritative reread too', async () => {
  let reads = 0
  const reread = deferred<PluginManagerSnapshot>()
  const rowSnapshot = (): PluginManagerSnapshot => ({
    ...snapshot([bundle({
      name: 'row-owner',
      enabled: false,
      rows: [{ rowId: 'row-a', moduleName: 'row-a', entryId: 'e-row' }],
    })]),
    plugins: [{ entryId: 'e-row', moduleName: 'row-a', enabled: false, fiberPhase: 'active', patchId: 'row-a' }],
  })
  const { port, state } = fakePort({
    snapshotImpl: async () => {
      reads += 1
      if (reads === 1) return rowSnapshot()
      if (reads === 2) return reread.promise
      return rowSnapshot()
    },
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  controller.toggleRow(bundleValue('row-owner'), 'e-row')
  await tick()
  assert.equal(state.setPlugin.length, 1, 'the row action is addressable')
  assert.equal(controller.busy(), 'action:toggle-row:e-row')
  controller.toggleRow(bundleValue('row-owner'), 'e-row')
  await tick()
  assert.equal(state.setPlugin.length, 1, 'the stale snapshot cannot dispatch a second row write')
  reread.resolve(rowSnapshot())
  await tick()
  assert.equal(controller.busy(), undefined)
})

test('a failed post-write reread blocks further writes until a successful refresh', async () => {
  let enabled = false
  let reads = 0
  const { port, state } = fakePort({
    snapshotImpl: async () => {
      reads += 1
      if (reads === 1) return snapshot([bundle({ name: 'ordinary', enabled })])
      if (reads === 2) throw new Error('snapshot unavailable')
      return snapshot([bundle({ name: 'ordinary', enabled })])
    },
    setBundleImpl: async (_name, next) => { enabled = next; return change() },
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(controller.status().state, 'error')
  assert.equal(controller.busy(), undefined)

  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 1, 'a stale inventory must not admit another write')
  assert.match(controller.notice() ?? '', /stale after a failed refresh/)

  controller.refresh()
  await tick()
  assert.equal(controller.status().state, 'ready')
  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(state.setBundle.length, 2)
})

test('remove admission is held through its authoritative reread as well', async () => {
  let reads = 0
  const reread = deferred<PluginManagerSnapshot>()
  const { port, state } = fakePort({
    snapshotImpl: async () => {
      reads += 1
      if (reads === 1) return snapshot([bundle({ name: 'ordinary' })])
      if (reads === 2) return reread.promise
      return snapshot([])
    },
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.equal(controller.requestRemove(bundleValue('ordinary')), true)
  controller.confirmRemove()
  await tick()
  assert.equal(state.removeBundle.length, 1)
  assert.equal(controller.busy(), bundleValue('ordinary'))
  assert.equal(controller.requestRemove(bundleValue('ordinary')), false, 'no second remove while the reread is pending')

  reread.resolve(snapshot([]))
  await tick()
  assert.equal(controller.busy(), undefined)
})

test('row-level self protection never offers a toggle row action', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => ({
      bundles: [bundle({
        name: SELF_BUNDLE,
        source: 'file:/tui',
        rows: [{ rowId: 'app', moduleName: SELF_BUNDLE, entryId: 'e-app' }],
      })],
      plugins: [{ entryId: 'e-app', moduleName: SELF_BUNDLE, enabled: true, fiberPhase: 'active', patchId: 'app' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const self = card(controller, bundleValue(SELF_BUNDLE))!
  const detail = buildPluginDetailView(self)
  assert.ok(!detail.actions.some(action => action.value.startsWith('action:toggle-row:')), 'no self row toggle action')
  controller.toggleRow(bundleValue(SELF_BUNDLE), 'e-app')
  await tick()
  assert.equal(state.setPlugin.length, 0)
})

test('a settlement-side hook throw never misclassifies a successful install', async () => {
  let settleThrow = false
  const { port } = fakePort({
    installImpl: async () => {
      settleThrow = true
      return change({ stage: 'install' })
    },
  })
  const controller = new PluginManagerController(port, {
    requestRender: () => { if (settleThrow) throw new Error('render boom') },
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick(8)
  assert.equal(controller.installView()?.phase, 'done', 'the successful outcome must not be overwritten by a settlement throw')
})

test('the Refresh action clears a stale read-failure notice', async () => {
  let fail = true
  const { port } = fakePort({
    snapshotImpl: async () => {
      if (fail) throw new Error('boom')
      return snapshot([bundle()])
    },
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  assert.match(controller.notice() ?? '', /refresh failed/)
  fail = false
  controller.refresh()
  await tick()
  assert.equal(controller.status().state, 'ready')
  assert.equal(controller.notice(), undefined, 'a successful refresh clears the stale notice')
})

test('an operation outcome message survives an explicit refresh', async () => {
  const { port } = fakePort()
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  controller.toggleCard(bundleValue('ordinary'))
  await tick()
  assert.equal(controller.notice(), 'enable applied')
  controller.refresh()
  await tick()
  assert.equal(controller.notice(), 'enable applied', 'refresh must not wipe an operation outcome')
})

test('a protected TUI-module entry is refused with the module wording and never mutated', async () => {
  const { port, state } = fakePort({
    snapshotImpl: async () => ({
      bundles: [bundle({
        name: SELF_BUNDLE,
        source: 'file:/tui',
        // No entryId: the row cannot exclude the live entry by id.
        rows: [{ rowId: 'builtins', moduleName: `${SELF_BUNDLE}/builtins` }],
      })],
      plugins: [{ entryId: 'include:builtins', moduleName: `${SELF_BUNDLE}/builtins`, enabled: true, fiberPhase: 'active', patchId: 'builtins' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  controller.toggleCard(entryValue('include:builtins'))
  await tick()
  assert.equal(state.setPlugin.length, 0)
  assert.match(controller.notice() ?? '', /Controlled by the Current TUI composition/)
})

// ── invalidation / read currentness / disposal ─────────────────────────────

function bundleOnly(name: string): PluginManagerSnapshot {
  return snapshot([bundle({ name, source: `file:/tmp/${name}` })])
}

test('latest-started read wins: a newer read start invalidates every older in-flight read', async () => {
  const older = deferred<PluginManagerSnapshot>()
  const newer = deferred<PluginManagerSnapshot>()
  const queue = [older, newer]
  const { port, state } = fakePort({ snapshotImpl: () => queue.shift()!.promise })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  controller.refresh()
  await tick()
  assert.equal(state.snapshotCalls, 2)

  newer.resolve(bundleOnly('fresh-b'))
  await tick()
  assert.ok(controller.card(bundleValue('fresh-b')) !== undefined)

  older.resolve(bundleOnly('stale-a'))
  await tick()
  assert.ok(controller.card(bundleValue('fresh-b')) !== undefined, 'the newer read owns the commit')
  assert.equal(controller.card(bundleValue('stale-a')), undefined, 'an older read must not repaint')
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
  controller.open()
  await tick()
  assert.ok(controller.card(bundleValue('good')) !== undefined)

  controller.refresh()
  await tick()
  controller.refresh()
  await tick()
  assert.equal(controller.status().state, 'error')
  assert.match(controller.notice() ?? '', /refresh failed/)

  stale.resolve(bundleOnly('stale-b'))
  await tick()
  assert.equal(controller.status().state, 'error')
  assert.match(controller.notice() ?? '', /refresh failed/)
  assert.ok(controller.card(bundleValue('good')) !== undefined, 'the last good snapshot stays visible')
  assert.equal(controller.card(bundleValue('stale-b')), undefined)
})

test('invalidation reads only while a surface is showing the inventory', async () => {
  let open = false
  const { port, state, invalidate } = fakePort()
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    notify: () => {},
    isOpen: () => open,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })

  invalidate()
  await tick()
  assert.equal(state.snapshotCalls, 0, 'a never-opened controller must not start a background read')

  open = true
  controller.open()
  await tick()
  assert.equal(state.snapshotCalls, 1)

  invalidate()
  await tick()
  assert.equal(state.snapshotCalls, 2)

  open = false
  invalidate()
  await tick()
  assert.equal(state.snapshotCalls, 2, 'a closed panel must not start a background read')

  open = true
  controller.open()
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
  assert.equal(installSubscriptions(), 0)
  assert.equal(invalidationSubscriptions(), 0)
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 })
  invalidate()
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 }, 'a disposed controller never re-subscribes or re-releases')
})

test('a throwing install-event unsubscribe cannot strand the invalidation release', () => {
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
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 })
  assert.equal(installSubscriptions(), 0)
  assert.equal(invalidationSubscriptions(), 0)

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
    controller.open()
    await tick()
    assert.equal(state.snapshotCalls, 1)
    const rendersAtDispose = renders()

    controller.dispose()
    controller.dispose()
    if (settlement === 'success') readGate.resolve(bundleOnly('late-read'))
    else readGate.reject(new Error('carrier offline'))
    await tick()

    assert.equal(renders(), rendersAtDispose, `a late ${settlement} settlement must not repaint`)
    assert.equal(controller.status().state, 'loading', 'a late settlement never commits a state')
    assert.equal(controller.card(bundleValue('late-read')), undefined)
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
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  assert.ok(inspectSignal !== undefined)
  assert.equal(inspectSignal.aborted, false)
  assert.equal(installSubscriptions(), 1)
  assert.equal(invalidationSubscriptions(), 1)
  const rendersAtDispose = renders()

  controller.dispose()
  assert.equal(inspectSignal.aborted, true, 'dispose aborts the in-flight inspect')
  assert.equal(installSubscriptions(), 0)
  assert.equal(invalidationSubscriptions(), 0)
  assert.deepEqual(offCalls, { install: 1, invalidation: 1 })

  invalidate()
  inspectGate.resolve({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null })
  await tick()
  assert.equal(state.snapshotCalls, 0, 'a disposed controller performs no read')
  assert.equal(state.cancelCalls.length, 0, 'dispose must never cancel a Host install')
  assert.equal(controller.installView()?.phase, 'inspecting', 'a late inspect result never advances the phase')
  assert.equal(renders(), rendersAtDispose, 'a late inspect result never repaints a disposed controller')
})

test('a superseded inspection result returns to the editor and never paints confirm', async () => {
  const inspectGate = deferred<PluginSpecInspectionFact>()
  const { port } = fakePort({ inspectImpl: () => inspectGate.promise })
  const { controller } = controllerOf(port)
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  assert.equal(controller.installView()?.phase, 'inspecting')
  inspectGate.reject(new PluginManagerStaleResultError('inspect'))
  await tick()
  const view = controller.installView()
  assert.equal(view?.phase, 'editing', 'a superseded inspection stays in the editor')
  assert.equal(view?.inspection, undefined, 'no stale inspection facts are retained')
  assert.match(view?.message ?? '', /currentness context was superseded/u)
})

test('dispose during a Host install neither cancels nor retries it and ignores a late install event', async () => {
  const gate = deferred<PluginChangeFact>()
  const { port, state, emit, installSubscriptions } = fakePort({ installImpl: () => gate.promise })
  const { controller, renders } = controllerOf(port)
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(state.installCalls.length, 1)
  const requestId = (state.installCalls[0] as { requestId: string }).requestId
  const rendersAtDispose = renders()

  controller.dispose()
  assert.equal(installSubscriptions(), 0, 'dispose released the install-event subscription')
  emit({ kind: 'phase', phase: { requestId, phase: 'applying' } })
  assert.equal(controller.installView()?.phase, 'starting', 'a late install event cannot be delivered')

  gate.resolve(change({ stage: 'install' }))
  await tick()
  assert.equal(state.cancelCalls.length, 0, 'dispose must never cancel a Host install')
  assert.equal(state.waitCalls.length, 0, 'dispose must never retry/recover an install')
  assert.equal(renders(), rendersAtDispose, 'a late settlement never repaints a disposed controller')
})

// ── D3-1 / v9 F10: upgrade guidance projection ─────────────────────────────

function detailFact(detail: ReturnType<typeof buildPluginDetailView>, label: string) {
  for (const group of detail.groups) {
    for (const entry of group.facts) if (entry.label === label) return entry
  }
  return undefined
}

function upgradeText(detail: ReturnType<typeof buildPluginDetailView>): string | undefined {
  return detailFact(detail, 'Upgrade')?.value
}

test('shipped bundles guide a DSH upgrade and never expose an in-place update/Remove', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', installed: true, removable: false, source: undefined, version: '0.2.1-rc.2' }),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const target = card(controller, bundleValue('@deepseek-ai/dsh-base'))!
  const detail = buildPluginDetailView(target)
  assert.match(upgradeText(detail) ?? '', /Upgrade: Shipped with DSH\. Upgrade the DSH installation/u)
  assert.match(upgradeText(detail) ?? '', /cannot update it in place/u)
  assert.ok(!detail.actions.some(action => action.value === PLUGIN_ACTION.remove), 'a shipped bundle never offers Remove through guidance')
  assert.ok(!detail.actions.some(action => /update/i.test(action.value)), 'no Update business action exists')
})

test('profile-owned bundles guide Remove-then-explicit-Install and never assume an offered version', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({ name: 'profile-owned', availability: 'profile', installed: true, removable: true, source: 'file:/tmp/owned', version: '1.0.0' }),
      bundle({
        name: 'profile-read-only',
        availability: 'profile',
        installed: true,
        removable: true,
        readOnlyReason: 'management-required',
        source: 'file:/tmp/read-only',
        version: '1.0.0',
      }),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const removed = buildPluginDetailView(card(controller, bundleValue('profile-owned'))!)
  assert.match(upgradeText(removed) ?? '', /Upgrade: Profile-owned\. Remove the current bundle first, then explicitly install the desired package version\. No in-place update\.$/u)
  assert.doesNotMatch(upgradeText(removed) ?? '', /new version|latest|available version/u, 'no offered version is invented')
  assert.ok(removed.actions.some(action => action.value === PLUGIN_ACTION.remove), 'the real Remove action remains the separate D1 path')

  const readOnly = buildPluginDetailView(card(controller, bundleValue('profile-read-only'))!)
  assert.match(upgradeText(readOnly) ?? '', /Removal is not permitted from this profile; do not reinstall over it here\./u)
  const readOnlyRemove = readOnly.actions.find(action => action.value === PLUGIN_ACTION.remove)
  assert.equal(readOnlyRemove?.enabled, false, 'Host read-only removal stays refused')
  assert.match(readOnlyRemove?.reason ?? '', /Required by DSH management/u)
})

test('missing catalog entries use the official offered target or state that none was supplied', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({
        name: 'offered',
        official: true,
        availability: 'missing',
        installed: false,
        removable: false,
        source: undefined,
        installTarget: { spec: 'offered@0.2.1-rc.2', version: '0.2.1-rc.2' },
      }),
      bundle({
        name: 'no-target',
        official: true,
        availability: 'missing',
        installed: false,
        removable: false,
        source: undefined,
      }),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const offered = buildPluginDetailView(card(controller, bundleValue('offered'))!)
  assert.match(upgradeText(offered) ?? '', /^Install: Use the official offered target offered@0\.2\.1-rc\.2 \(version 0\.2\.1-rc\.2\); this is not an in-place update\.$/u)
  assert.ok(offered.actions.some(action => action.value === PLUGIN_ACTION.officialInstall && action.enabled), 'the existing Install… path is unchanged')
  assert.equal(detailFact(offered, 'Current version')?.value, 'unavailable', 'an unknown current version is stated, not fabricated')

  const missing = buildPluginDetailView(card(controller, bundleValue('no-target'))!)
  assert.equal(upgradeText(missing), 'Install unavailable: No official install target was supplied.')
  assert.ok(missing.actions.some(action => action.value === PLUGIN_ACTION.officialInstall && action.enabled === false), 'the Install action stays disabled')
})

test('the Current TUI bundle states external ownership and a standalone entry carries no package route', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => ({
      bundles: [bundle({ name: SELF_BUNDLE, availability: 'profile', installed: true, removable: true, source: 'file:/tmp/tui', version: '0.5.3' })],
      plugins: [{ entryId: 'e-free', moduleName: 'free-entry', enabled: true, fiberPhase: 'active', patchId: 'free' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const self = buildPluginDetailView(card(controller, bundleValue(SELF_BUNDLE))!)
  assert.equal(upgradeText(self), 'The Current TUI bundle is managed outside this screen.')
  assert.doesNotMatch(upgradeText(self) ?? '', /remove|install/iu, 'self-protection never suggests changing the running TUI')

  const entry = buildPluginDetailView(card(controller, entryValue('e-free'))!)
  assert.equal(upgradeText(entry), undefined, 'a standalone Loader entry has no package upgrade route')
})

test('version difference, equal version and masked sources never leak credentials', async () => {
  const { port } = fakePort({
    snapshotImpl: async () => snapshot([
      bundle({
        name: 'different',
        official: true,
        availability: 'missing',
        installed: false,
        removable: false,
        source: 'https://user:secret@example.com/pkg.git',
        version: '0.2.0-rc.2',
        installTarget: { spec: 'https://user:secret@example.com/pkg.git#0.2.1-rc.2', version: '0.2.1-rc.2' },
      }),
      bundle({
        name: 'same',
        official: true,
        availability: 'missing',
        installed: false,
        removable: false,
        source: undefined,
        version: '0.2.1-rc.2',
        installTarget: { spec: 'same@0.2.1-rc.2', version: '0.2.1-rc.2' },
      }),
    ]),
  })
  const { controller } = controllerOf(port)
  controller.open()
  await tick()
  const different = buildPluginDetailView(card(controller, bundleValue('different'))!)
  assert.equal(detailFact(different, 'Version difference')?.value, 'Current 0.2.0-rc.2 · offered 0.2.1-rc.2.')
  assert.match(upgradeText(different) ?? '', /https:\/\/\*\*\*@example\.com\/pkg\.git#0\.2\.1-rc\.2/u)
  const painted = different.groups.flatMap(group => group.facts.map(entry => entry.value)).join('\n')
  assert.doesNotMatch(painted, /user:secret|secret@/u, 'no credential crosses the Detail projection')

  const same = buildPluginDetailView(card(controller, bundleValue('same'))!)
  assert.equal(detailFact(same, 'Version difference'), undefined, 'equal versions are not a fabricated update')
  assert.doesNotMatch(same.groups.flatMap(group => group.facts.map(entry => entry.value)).join('\n'), /latest|up to date/iu,
    'equal versions do not claim the offered version is the latest')
})
