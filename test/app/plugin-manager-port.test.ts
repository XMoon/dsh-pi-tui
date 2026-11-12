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
import { AUTO_REVIEW_BUNDLE, PLUGIN_ACTION, bundleValue, buildPluginDetailView, entryValue } from '../../src/app/plugin-manager/model.ts'
import { PluginManagerStaleResultError } from '../../src/runtime/plugin-manager-port.ts'
import type {
  PluginBundleFact,
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
  PluginUpdateProgressFact,
  PluginUpdateResultFact,
  PluginVersionFact,
  PluginVersionListFact,
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
    update: undefined,
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
  listVersionCalls: unknown[]
  updateCalls: unknown[]
  snapshotImpl: () => Promise<PluginManagerSnapshot>
  inspectImpl: (spec: string, registry: string | null, signal?: AbortSignal) => Promise<PluginSpecInspectionFact>
  installImpl: (request: unknown) => Promise<PluginChangeFact>
  waitImpl: (requestId: string) => Promise<PluginChangeFact | null>
  cancelImpl: (requestId: string) => Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }>
  versionsImpl: (name: string, signal?: AbortSignal) => Promise<PluginVersionListFact>
  updateImpl: (name: string, version: string, registry: string | null, requestId: string) => Promise<PluginUpdateResultFact>
  setBundleImpl?: (name: string, enabled: boolean) => Promise<PluginChangeFact>
}

function fakePort(state: Partial<FakeState> = {}): {
  port: PluginManagerPort
  state: FakeState
  emit: (event: PluginInstallEvent) => void
  emitUpdate: (progress: PluginUpdateProgressFact) => void
  invalidate: () => void
  offCalls: { install: number; update: number; invalidation: number }
  installSubscriptions: () => number
  updateSubscriptions: () => number
  invalidationSubscriptions: () => number
} {
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const updateListeners = new Set<(progress: PluginUpdateProgressFact) => void>()
  const invalidationListeners = new Set<() => void>()
  const offCalls = { install: 0, update: 0, invalidation: 0 }
  const full: FakeState = {
    snapshotCalls: 0,
    setBundle: [],
    setPlugin: [],
    removeBundle: [],
    installCalls: [],
    inspectCalls: [],
    waitCalls: [],
    cancelCalls: [],
    listVersionCalls: [],
    updateCalls: [],
    snapshotImpl: async () => snapshot([
      bundle({ name: SELF_BUNDLE, source: 'file:/tui' }),
      bundle(),
    ]),
    inspectImpl: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1.0.0', bundle: true, registry: null }),
    installImpl: async () => change({ stage: 'install' }),
    waitImpl: async () => null,
    cancelImpl: async () => ({ status: 'not-running' }),
    versionsImpl: async () => ({
      status: 'listed',
      installed: '1.0.0',
      registry: 'https://registry.example/',
      attempts: [{ registry: 'https://registry.example/' }],
      versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }],
      omitted: 0,
    }),
    updateImpl: async (name, version) => ({
      from: '1.0.0',
      to: version,
      step: 'install',
      result: { changed: true, application: 'applied', stage: 'install', target: name, version },
    }),
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
    listVersions: async (name, signal) => {
      full.listVersionCalls.push({ name })
      return full.versionsImpl(name, signal)
    },
    updateBundle: async (name, version, registry, requestId) => {
      full.updateCalls.push({ name, version, registry, requestId })
      return full.updateImpl(name, version, registry, requestId)
    },
    subscribeInstall: (listener) => {
      listeners.add(listener)
      return () => { offCalls.install += 1; listeners.delete(listener) }
    },
    subscribeUpdate: (listener) => {
      updateListeners.add(listener)
      return () => { offCalls.update += 1; updateListeners.delete(listener) }
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
    emitUpdate: progress => { for (const listener of [...updateListeners]) listener(progress) },
    invalidate: () => { for (const listener of [...invalidationListeners]) listener() },
    offCalls,
    installSubscriptions: () => listeners.size,
    updateSubscriptions: () => updateListeners.size,
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
        enabled: false,
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
  assert.deepEqual(offCalls, { install: 1, update: 1, invalidation: 1 })
  invalidate()
  assert.deepEqual(offCalls, { install: 1, update: 1, invalidation: 1 }, 'a disposed controller never re-subscribes or re-releases')
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
  assert.deepEqual(offCalls, { install: 1, update: 1, invalidation: 1 })
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
  assert.deepEqual(offCalls, { install: 1, update: 1, invalidation: 1 })

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

// ── S5-PR2: official registry bundle update lifecycle ──────────────────────

function updatable(overrides: Partial<PluginBundleFact> = {}): PluginBundleFact {
  return bundle({
    name: 'updatable',
    update: 'registry',
    source: 'https://registry.example/updatable',
    version: '1.0.0',
    ...overrides,
  })
}

function stableVersion(overrides: Partial<PluginVersionFact> = {}): PluginVersionFact {
  return { version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true, ...overrides }
}

function listed(versions: readonly PluginVersionFact[], overrides: Partial<{
  installed: string
  registry: string | null
  omitted: number
}> = {}): PluginVersionListFact {
  return {
    status: 'listed',
    installed: '1.0.0',
    registry: 'https://registry.example/',
    attempts: [{ registry: 'https://registry.example/' }],
    versions,
    omitted: 0,
    ...overrides,
  }
}

async function openedUpdate(
  state: Partial<FakeState> = {},
): Promise<ReturnType<typeof fakePort> & { controller: PluginManagerController }> {
  const fake = fakePort({
    snapshotImpl: async () => snapshot([updatable()]),
    ...state,
  })
  const { controller } = controllerOf(fake.port)
  controller.open()
  await tick()
  return { ...fake, controller }
}

test('update: one official write with the Host-answered registry and a target-install-only stop', async () => {
  const updateGate = deferred<PluginUpdateResultFact>()
  const cancelGate = deferred<{ status: 'cancelled' | 'too-late' | 'not-running' }>()
  let observed = '1.0.0'
  const fixture = await openedUpdate({
    snapshotImpl: async () => snapshot([updatable({ version: observed })]),
    updateImpl: () => updateGate.promise,
    cancelImpl: () => cancelGate.promise,
  })
  const { controller, state, emit, emitUpdate } = fixture

  controller.beginUpdate(bundleValue('updatable'))
  assert.equal(controller.updateView()?.phase, 'checking')
  await tick()
  const selecting = controller.updateView()!
  assert.equal(selecting.phase, 'selecting')
  assert.equal(selecting.versions?.status, 'listed')
  assert.equal(selecting.selectedExactVersion, '1.1.0', 'the first eligible stable version is suggested')
  assert.equal(selecting.registry, 'https://registry.example/')
  assert.equal(state.listVersionCalls.length, 1)

  controller.confirmUpdateVersion()
  assert.equal(controller.updateView()?.phase, 'confirm')
  controller.executeUpdate()
  await tick(2)
  const running = controller.updateView()!
  assert.equal(running.phase, 'running')
  assert.ok(running.requestId !== undefined)
  assert.equal(state.updateCalls.length, 1)
  assert.deepEqual(state.updateCalls[0], {
    name: 'updatable',
    version: '1.1.0',
    registry: 'https://registry.example/',
    requestId: running.requestId,
  })
  assert.equal(controller.busy(), bundleValue('updatable'))
  assert.equal(controller.hasDispatchedInstall(), false)

  // A wrong request id never advances the lifecycle; the real steps do.
  emitUpdate({ requestId: 'another-update', step: 'installing' })
  assert.equal(controller.updateView()?.hostStep, undefined)
  emitUpdate({ requestId: running.requestId!, step: 'checking' })
  assert.equal(controller.updateView()?.hostStep, 'checking')
  assert.equal(controller.updateView()?.canStopTargetInstall, false, 'stop is not offered during the check/remove steps')
  emitUpdate({ requestId: running.requestId!, step: 'installing' })
  assert.equal(controller.updateView()?.canStopTargetInstall, false, 'the matched install-state must also say installing')
  emit({ kind: 'phase', phase: { requestId: running.requestId!, phase: 'installing' } })
  assert.equal(controller.updateView()?.canStopTargetInstall, true)

  controller.stopUpdateTargetInstall()
  await tick()
  assert.deepEqual(state.cancelCalls, [running.requestId])
  cancelGate.resolve({ status: 'cancelled' })
  await tick()
  assert.equal(controller.updateView()?.phase, 'running', 'a cancellation alone never ends the update')
  assert.equal(controller.updateView()?.cancelStatus, 'cancelled')
  assert.match(controller.updateView()?.message ?? '', /awaiting Host restoration\/result/u)

  // A refresh while the update runs must not discard its request id.
  controller.refresh()
  await tick()
  observed = '1.1.0'
  updateGate.resolve({
    from: '1.0.0',
    to: '1.1.0',
    step: 'install',
    result: change({ stage: 'install', application: 'applied', version: '1.1.0' }),
  })
  await tick(10)
  const done = controller.updateView()!
  assert.equal(done.phase, 'done')
  assert.equal(done.result?.to, '1.1.0')
  assert.equal(done.readback, 'ready')
  assert.equal(done.lastObservedVersion, '1.1.0')
  assert.equal(controller.busy(), undefined)
  assert.equal(state.updateCalls.length, 1, 'exactly one Host write per confirmed update')
  assert.equal(state.listVersionCalls.length, 1, 'a running update never repeats the registry read')
})

test('update: version eligibility marks disabled rows and never guesses a prerelease target', async () => {
  const versions = [
    stableVersion({ version: '1.1.0', bundle: false }),
    stableVersion({
      version: '1.2.0',
      incompatible: {
        name: 'updatable',
        version: '1.2.0',
        runtimeVersion: '0.2.2-rc.1',
        requirements: { 'engines.dsh': '>=9' },
      },
    }),
    stableVersion({ version: '1.3.0', deprecated: 'use the 2.x line' }),
    stableVersion({ version: '1.4.0-rc.1', prerelease: true, tags: ['next'] }),
  ]
  const fixture = await openedUpdate({
    versionsImpl: async () => listed(versions),
  })
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.updateView()?.selectedExactVersion, undefined,
    'a list without an eligible stable version starts with NO selection')

  for (const disabled of ['1.1.0', '1.2.0', '1.3.0']) {
    controller.selectUpdateVersion(disabled)
    assert.equal(controller.updateView()?.selectedExactVersion, undefined, `${disabled} is not selectable`)
    assert.match(controller.notice() ?? '', /no bundle|cannot replace|Deprecated|rejects DSH/u)
  }
  controller.confirmUpdateVersion()
  assert.equal(controller.updateView()?.phase, 'selecting', 'a disabled row never reaches confirmation')

  controller.selectUpdateVersion('1.4.0-rc.1')
  assert.equal(controller.updateView()?.selectedExactVersion, '1.4.0-rc.1')
  controller.confirmUpdateVersion()
  assert.equal(controller.updateView()?.phase, 'confirm', 'a user-chosen prerelease is allowed with its warning')
  controller.cancelUpdateConfirmation()
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(state.updateCalls.length, 0)
})

test('update: old write entrances are refused while the update owns the path', async () => {
  const updateGate = deferred<PluginUpdateResultFact>()
  const fixture = await openedUpdate({ updateImpl: () => updateGate.promise })
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(2)
  assert.equal(controller.updateView()?.phase, 'running')

  controller.executeUpdate()
  await tick()
  assert.equal(state.updateCalls.length, 1, 'a second execute never writes')
  controller.toggleCard(bundleValue('updatable'))
  await tick()
  assert.equal(state.setBundle.length, 0, 'toggle is refused during the update')
  assert.match(controller.notice() ?? '', /still in progress/u)
  assert.equal(controller.toggleRow(bundleValue('updatable'), 'e1'), false)
  assert.equal(controller.requestRemove(bundleValue('updatable')), false)
  assert.equal(controller.beginManualInstall(), false)
  assert.equal(state.installCalls.length, 0)
  assert.equal(controller.beginOfficialInstall(bundleValue('updatable')), false)

  updateGate.resolve({
    from: '1.0.0',
    to: '1.1.0',
    step: 'install',
    result: change({ stage: 'install', application: 'applied', version: '1.1.0' }),
  })
  await tick(10)
  assert.equal(controller.updateView()?.phase, 'done')
  controller.toggleCard(bundleValue('updatable'))
  await tick()
  assert.equal(state.setBundle.length, 1, 'a terminal done update releases the write path')
})

test('update: an indeterminate outcome keeps the write lock until a successful reread and acknowledgment', async () => {
  let failReads = false
  const fixture = await openedUpdate({
    snapshotImpl: async () => {
      if (failReads) throw new Error('inventory offline')
      return snapshot([updatable()])
    },
    updateImpl: async () => { throw new PluginManagerStaleResultError('updateBundle') },
  })
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const unknown = controller.updateView()!
  assert.equal(unknown.phase, 'unknown')
  assert.equal(unknown.result, undefined, 'no result is fabricated')
  assert.match(unknown.message ?? '', /outcome unknown/u)
  assert.match(unknown.message ?? '', /not retried automatically/u)
  assert.equal(unknown.readback, 'ready')
  assert.equal(controller.busy(), bundleValue('updatable'), 'the write lock stays held')
  assert.equal(state.updateCalls.length, 1)

  controller.executeUpdate()
  await tick()
  assert.equal(state.updateCalls.length, 1, 'an unknown outcome is never retried')

  controller.acknowledgeUpdateUncertainty()
  assert.equal(controller.updateView()?.acknowledged, true)
  assert.equal(controller.busy(), undefined, 'an explicit acknowledgment releases the local write lock')

  // An acknowledged outcome allows a NEW check for the same bundle.
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(state.listVersionCalls.length, 2)
  assert.equal(controller.updateView()?.phase, 'selecting')

  // A failed reread leaves the acknowledgment disabled until a successful one.
  failReads = true
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  assert.equal(controller.updateView()?.phase, 'running')
  await tick(10)
  assert.equal(controller.updateView()?.phase, 'unknown')
  assert.equal(controller.updateView()?.readback, 'error')
  controller.acknowledgeUpdateUncertainty()
  assert.equal(controller.updateView()?.acknowledged, false)
  assert.match(controller.notice() ?? '', /reread must succeed/u)
  failReads = false
  controller.refresh()
  await tick()
  assert.equal(controller.updateView()?.readback, 'ready')
  controller.acknowledgeUpdateUncertainty()
  assert.equal(controller.updateView()?.acknowledged, true)
})

test('update: a new authoritative inventory invalidates an unconfirmed list and never re-queries implicitly', async () => {
  const fixture = await openedUpdate()
  const { controller, state, invalidate } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.updateView()?.versions?.status, 'listed')

  // A Host invalidation / refresh changes the installed-version premise.
  invalidate()
  await tick()
  const invalidated = controller.updateView()!
  assert.equal(invalidated.phase, 'selecting')
  assert.equal(invalidated.versions, undefined)
  assert.equal(invalidated.selectedExactVersion, undefined)
  assert.match(invalidated.message ?? '', /Bundle changed; check versions again/u)
  assert.equal(state.listVersionCalls.length, 1, 'No implicit registry re-query')

  controller.retryUpdateCheck()
  await tick()
  assert.equal(state.listVersionCalls.length, 2, 'the explicit retry is the only re-query')
  assert.equal(controller.updateView()?.versions?.status, 'listed')

  controller.confirmUpdateVersion()
  assert.equal(controller.updateView()?.phase, 'confirm')
  controller.refresh()
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting', 'a changed inventory withdraws the stale confirmation')
  controller.executeUpdate()
  await tick()
  assert.equal(state.updateCalls.length, 0, 'a withdrawn confirmation never writes')
})

test('update: a superseded version list is indeterminate and never writes', async () => {
  const fixture = await openedUpdate({
    versionsImpl: async () => { throw new PluginManagerStaleResultError('listVersions') },
  })
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.updateView()?.versions, undefined)
  assert.match(controller.updateView()?.message ?? '', /superseded currentness context/u)
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick()
  assert.equal(state.updateCalls.length, 0)
})

test('update: target and restore outcomes stay independent, including a failed restoration', async () => {
  const fixture = await openedUpdate({
    updateImpl: async () => ({
      from: '1.0.0',
      to: '1.1.0',
      step: 'install',
      result: change({
        stage: 'install',
        application: 'failed',
        error: { code: 'operation-error', diagnostic: 'target install failed' },
      }),
      restore: change({
        stage: 'install',
        application: 'failed',
        version: '1.0.0',
        error: { code: 'operation-error', diagnostic: 'restore failed' },
      }),
    }),
  })
  const { controller } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const done = controller.updateView()!
  assert.equal(done.phase, 'done')
  assert.equal(done.result?.result.application, 'failed')
  assert.equal(done.result?.restore?.application, 'failed', 'a failed restoration is reported separately')
  assert.equal(done.readback, 'ready')
})

test('update: a failed authoritative reread is reported, never a fabricated current version', async () => {
  let reads = 0
  const fixture = await openedUpdate({
    snapshotImpl: async () => {
      reads += 1
      if (reads > 1) throw new Error('inventory offline')
      return snapshot([updatable({ version: '1.0.0' })])
    },
    updateImpl: async (_name, version) => ({
      from: '1.0.0',
      to: version,
      step: 'install',
      result: change({ stage: 'install', application: 'applied', version }),
    }),
  })
  const { controller } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const done = controller.updateView()!
  assert.equal(done.phase, 'done')
  assert.equal(done.readback, 'error')
  assert.equal(done.lastObservedVersion, undefined)
  assert.equal(controller.status().state, 'error')
})

test('update: hide never cancels or re-dispatches the Host operation', async () => {
  const updateGate = deferred<PluginUpdateResultFact>()
  const fixture = await openedUpdate({ updateImpl: () => updateGate.promise })
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(2)
  controller.hideUpdate()
  assert.equal(controller.updateView()?.phase, 'running')
  assert.equal(state.updateCalls.length, 1)
  assert.equal(state.cancelCalls.length, 0)
  updateGate.resolve({
    from: '1.0.0',
    to: '1.1.0',
    step: 'install',
    result: change({ stage: 'install', application: 'applied', version: '1.1.0' }),
  })
  await tick(10)
  assert.equal(controller.updateView()?.phase, 'done')
  assert.equal(state.updateCalls.length, 1)
})

test('update: subscriptions are acquired transactionally and disposed together', () => {
  // A throwing update subscription releases the install subscription.
  {
    const { port, offCalls } = fakePort()
    port.subscribeUpdate = () => { throw new Error('update subscription refused') }
    assert.throws(() => controllerOf(port), /update subscription refused/)
    assert.deepEqual(offCalls, { install: 1, update: 0, invalidation: 0 })
  }
  // A throwing invalidation subscription releases install AND update.
  {
    const { port, offCalls } = fakePort()
    port.subscribeInvalidation = () => { throw new Error('invalidation subscription refused') }
    assert.throws(() => controllerOf(port), /invalidation subscription refused/)
    assert.deepEqual(offCalls, { install: 1, update: 1, invalidation: 0 })
  }
})

test('update: dispose aborts an in-flight version read and never cancels the Host update', async () => {
  let signal: AbortSignal | undefined
  const fixture = await openedUpdate({
    versionsImpl: (_name, versionSignal) => {
      signal = versionSignal
      return new Promise<PluginVersionListFact>(() => {})
    },
  })
  const { controller, state, offCalls, updateSubscriptions } = fixture
  assert.equal(updateSubscriptions(), 1)
  controller.beginUpdate(bundleValue('updatable'))
  await tick(2)
  assert.ok(signal !== undefined)
  assert.equal(signal.aborted, false)
  controller.dispose()
  assert.equal(signal.aborted, true, 'dispose aborts the un-sent version read')
  assert.deepEqual(offCalls, { install: 1, update: 1, invalidation: 1 })
  assert.equal(updateSubscriptions(), 0)
  assert.equal(state.cancelCalls.length, 0, 'dispose never cancels a Host update')
  assert.equal(state.updateCalls.length, 0)
})

test('update: request-id-matched events update the one log and duplicate steps do not advance semantics', async () => {
  const updateGate = deferred<PluginUpdateResultFact>()
  const fixture = await openedUpdate({ updateImpl: () => updateGate.promise })
  const { controller, emit, emitUpdate } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(2)
  const requestId = controller.updateView()?.requestId
  assert.ok(requestId !== undefined)

  const before = controller.semanticTransitionsCount()
  emitUpdate({ requestId, step: 'installing' })
  const after = controller.semanticTransitionsCount()
  assert.ok(after > before, 'a real new step notifies')
  emitUpdate({ requestId, step: 'installing' })
  assert.equal(controller.semanticTransitionsCount(), after, 'a repeated step is not a new semantic transition')

  emit({ kind: 'log', log: { requestId: 'some-other-install', jobId: 'job', stream: 'stdout', text: 'leaked' } })
  assert.deepEqual(controller.updateView()?.log, [], 'another request id never leaks into the update log')
  emit({ kind: 'log', log: { requestId, jobId: 'job', stream: 'stdout', text: 'target output' } })
  assert.deepEqual(controller.updateView()?.log, ['target output'])
  updateGate.resolve({
    from: '1.0.0',
    to: '1.1.0',
    step: 'install',
    result: change({ stage: 'install', application: 'applied', version: '1.1.0' }),
  })
  await tick(10)
})

test('update: begin refuses a bundle the Host does not declare updatable without any registry read', async () => {
  const fixture = fakePort({
    snapshotImpl: async () => snapshot([
      updatable({ name: 'fixed', update: undefined }),
      updatable({ name: '@vendor/official', official: true, availability: 'installation', source: undefined, update: undefined }),
    ]),
  })
  const { controller } = controllerOf(fixture.port)
  controller.open()
  await tick()
  for (const name of ['fixed', '@vendor/official']) {
    controller.beginUpdate(bundleValue(name))
    assert.equal(controller.updateView(), undefined)
    assert.match(controller.notice() ?? '', /does not support Host updates/u)
  }
  assert.equal(fixture.state.listVersionCalls.length, 0)
})

test('update: the terminal done state waits for the authoritative reread', async () => {
  const readGate = deferred<PluginManagerSnapshot>()
  let reads = 0
  const fixture = await openedUpdate({
    snapshotImpl: async () => {
      reads += 1
      if (reads === 1) return snapshot([updatable({ version: '1.0.0' })])
      return readGate.promise
    },
    updateImpl: async (_name, version) => ({
      from: '1.0.0',
      to: version,
      step: 'install',
      result: change({ stage: 'install', application: 'applied', version }),
    }),
  })
  const { controller } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const settling = controller.updateView()!
  assert.equal(settling.phase, 'running', 'the official result alone is never painted as done')
  assert.equal(settling.settling, true)
  assert.equal(settling.readback, 'pending')
  assert.equal(settling.canStopTargetInstall, false, 'stop is closed once the Host already returned')
  assert.equal(controller.busy(), bundleValue('updatable'), 'the write lock is held through the reread')
  readGate.resolve(snapshot([updatable({ version: '1.1.0' })]))
  await tick(10)
  assert.equal(controller.updateView()?.phase, 'done')
  assert.equal(controller.updateView()?.readback, 'ready')
  assert.equal(controller.updateView()?.lastObservedVersion, '1.1.0')
  assert.equal(controller.busy(), undefined)
})

test('update: a superseded authoritative reread never becomes ready', async () => {
  let reads = 0
  const fixture = await openedUpdate({
    snapshotImpl: async () => {
      reads += 1
      if (reads > 1) throw new PluginManagerStaleResultError('snapshot')
      return snapshot([updatable({ version: '1.0.0' })])
    },
    updateImpl: async (_name, version) => ({
      from: '1.0.0',
      to: version,
      step: 'install',
      result: change({ stage: 'install', application: 'applied', version }),
    }),
  })
  const { controller } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const done = controller.updateView()!
  assert.equal(done.phase, 'done')
  assert.equal(done.readback, 'error', 'a superseded snapshot is NOT the authoritative readback')
  assert.equal(done.lastObservedVersion, undefined)
  assert.equal(controller.busy(), undefined)
})

test('update: a Host check-step refusal is a done result, not an indeterminate outcome', async () => {
  const fixture = await openedUpdate({
    updateImpl: async (_name, version) => ({
      from: '1.0.0',
      to: version,
      step: 'check',
      result: change({
        stage: 'install',
        application: 'failed',
        error: { code: 'incompatible-version' },
      }),
    }),
  })
  const { controller } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const done = controller.updateView()!
  assert.equal(done.phase, 'done')
  assert.equal(done.result?.step, 'check')
  assert.equal(done.result?.result.application, 'failed')
  assert.equal(done.result?.restore, undefined)
  assert.equal(done.readback, 'ready')
})

test('update: a failed target with a successful restore reports both outcomes separately', async () => {
  const fixture = await openedUpdate({
    updateImpl: async (_name, version) => ({
      from: '1.0.0',
      to: version,
      step: 'install',
      result: change({
        stage: 'install',
        application: 'failed',
        error: { code: 'operation-error', diagnostic: 'target failed' },
      }),
      restore: change({ stage: 'install', application: 'applied', version: '1.0.0' }),
    }),
  })
  const { controller } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  const done = controller.updateView()!
  assert.equal(done.result?.result.application, 'failed')
  assert.equal(done.result?.restore?.application, 'applied')
  assert.equal(done.result?.restore?.version, '1.0.0')
})

test('update: a read-only version preview never blocks the other plugin mutations', async () => {
  const fixture = await openedUpdate()
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting')

  // Toggle the same bundle while the read-only preview exists: it is admitted.
  controller.toggleCard(bundleValue('updatable'))
  await tick()
  assert.equal(state.setBundle.length, 1, 'a registry preview never owns the Host write path')
  // The mutation's authoritative reread revokes the stale preview.
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.updateView()?.versions, undefined)
  assert.match(controller.updateView()?.message ?? '', /Bundle changed; check versions again/u)

  // The other write entrances are admitted too.
  assert.equal(controller.beginManualInstall(), true)
  controller.hideInstall()
  assert.equal(controller.requestRemove(bundleValue('updatable')), true)
  controller.cancelConfirmation()
})

test('update: the read-only preview leaves Auto Review and row toggles admitted', async () => {
  const fixture = fakePort({
    snapshotImpl: async () => ({
      bundles: [
        updatable(),
        bundle({
          name: AUTO_REVIEW_BUNDLE,
          enabled: true,
          rows: [{ rowId: 'review-row', moduleName: 'review', entryId: 'e-review' }],
        }),
      ],
      plugins: [{ entryId: 'e-review', moduleName: 'review', enabled: true, fiberPhase: 'active', patchId: 'review-row' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  })
  const { controller } = controllerOf(fixture.port)
  controller.open()
  await tick()
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.requestAutoDisable(bundleValue(AUTO_REVIEW_BUNDLE)), true,
    'the Auto Review confirmation is not blocked by a read-only preview')
  controller.cancelConfirmation()
  assert.equal(controller.toggleRow(bundleValue(AUTO_REVIEW_BUNDLE), 'e-review'), true,
    'a row-level toggle is not blocked by a read-only preview')
  controller.cancelConfirmation()
})

test('update: another bundle Check updates replaces a read-only preview', async () => {
  const fixture = fakePort({
    snapshotImpl: async () => snapshot([
      updatable({ name: 'first' }),
      updatable({ name: 'second' }),
    ]),
  })
  const { controller } = controllerOf(fixture.port)
  controller.open()
  await tick()
  controller.beginUpdate(bundleValue('first'))
  await tick()
  assert.equal(controller.updateView()?.name, 'first')
  controller.beginUpdate(bundleValue('second'))
  await tick()
  assert.equal(controller.updateView()?.name, 'second')
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.deepEqual(fixture.state.listVersionCalls, [{ name: 'first' }, { name: 'second' }],
    'the previous preview read is abandoned for the new bundle')
})

test('update: another mutation revokes an open confirmation before any write', async () => {
  const fixture = await openedUpdate()
  const { controller, state } = fixture
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  assert.equal(controller.updateView()?.phase, 'confirm')
  controller.toggleCard(bundleValue('updatable'))
  await tick()
  assert.equal(state.setBundle.length, 1)
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.updateView()?.versions, undefined)
  controller.executeUpdate()
  await tick()
  assert.equal(state.updateCalls.length, 0, 'a withdrawn confirmation never dispatches the Host update')
})

test('update: an official catalog install entry is admitted during a read-only preview', async () => {
  const fixture = fakePort({
    snapshotImpl: async () => snapshot([
      updatable(),
      bundle({
        name: 'official-missing',
        official: true,
        availability: 'missing',
        installed: false,
        removable: false,
        source: undefined,
        installTarget: { spec: 'official-missing@1.0.0', version: '1.0.0' },
      }),
    ]),
  })
  const { controller } = controllerOf(fixture.port)
  controller.open()
  await tick()
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  assert.equal(controller.updateView()?.phase, 'selecting')
  assert.equal(controller.beginOfficialInstall(bundleValue('official-missing')), true,
    'the official catalog install entry is not blocked by a read-only preview')
  controller.dispose()
})

test('update: Check updates after a completed update starts a fresh lifecycle and never re-dispatches', async () => {
  let check = 0
  let installed = '1.0.0'
  const updates: string[] = []
  const fixture = fakePort({
    snapshotImpl: async () => snapshot([updatable({ version: installed })]),
    versionsImpl: async () => {
      check += 1
      const target = check === 1 ? '1.1.0' : '1.2.0'
      return listed([stableVersion({ version: target }), stableVersion({ version: '9.9.9' })], { installed })
    },
    updateImpl: async (_name, version) => {
      updates.push(version)
      installed = version
      return {
        from: '1.0.0',
        to: version,
        step: 'install',
        result: change({ stage: 'install', application: 'applied', version }),
      }
    },
  })
  const { controller } = controllerOf(fixture.port)
  controller.open()
  await tick()

  // First update: 1.0.0 -> 1.1.0.
  controller.beginUpdate(bundleValue('updatable'))
  await tick()
  controller.confirmUpdateVersion()
  controller.executeUpdate()
  await tick(10)
  assert.equal(controller.updateView()?.phase, 'done')
  assert.equal(controller.updateView()?.lastObservedVersion, '1.1.0')
  const firstRequest = controller.updateView()?.requestId
  assert.ok(firstRequest !== undefined)
  assert.equal(fixture.state.updateCalls.length, 1)

  // A completed update is historical evidence; Check updates… is a new intent.
  controller.beginUpdate(bundleValue('updatable'))
  assert.equal(controller.updateView()?.phase, 'checking', 'the done result is replaced by a fresh check')
  await tick()
  const second = controller.updateView()!
  assert.equal(second.phase, 'selecting')
  assert.equal(second.versions?.status, 'listed')
  assert.equal(second.selectedExactVersion, '1.2.0')
  assert.equal(second.requestId, undefined, 'the new check has no update request id')
  assert.equal(second.result, undefined, 'the new check carries no previous result')
  assert.equal(fixture.state.listVersionCalls.length, 2)
  assert.equal(fixture.state.updateCalls.length, 1, 'a new check never re-dispatches the update')

  controller.confirmUpdateVersion()
  assert.equal(controller.updateView()?.phase, 'confirm')
  controller.executeUpdate()
  await tick(10)
  assert.equal(fixture.state.updateCalls.length, 2)
  assert.deepEqual(updates, ['1.1.0', '1.2.0'])
  assert.equal(controller.updateView()?.phase, 'done')
  assert.equal(controller.updateView()?.lastObservedVersion, '1.2.0')
  assert.notEqual(controller.updateView()?.requestId, firstRequest, 'the second update has its own request id')
})
