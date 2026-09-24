/**
 * Contract tests for the Direct Plugin Manager adapter (P1-A): the only layer
 * that knows the official `pluginManager` Host service. It must map official
 * records onto detached TUI facts, forward semantic operations unchanged, and
 * correlate install events by request id without exposing a Host object.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectPluginManagerPort,
  type PluginManagerHostContextLike,
  type PluginManagerServiceLike,
} from '../src/runtime/direct/plugin-manager-direct.ts'

function change(overrides: Record<string, unknown> = {}): never {
  return {
    changed: true,
    application: 'applied',
    stage: 'enable',
    target: 'x',
    ...overrides,
  } as never
}

function fakeService(overrides: Partial<PluginManagerServiceLike> = {}): PluginManagerServiceLike {
  return {
    listBundles: async () => [],
    listPlugins: async () => [],
    registries: async () => ({ registry: null, fallbackRegistries: [], resolved: null }),
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
    inspect: async () => ({ status: 'refused', problem: 'unknown', reason: 'nope' }),
    setBundleEnabled: async () => change(),
    setPluginEnabled: async () => change(),
    removeBundle: async () => change({ stage: 'remove' }),
    installBundle: async () => change({ stage: 'install' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    ...overrides,
  } as PluginManagerServiceLike
}

function host(service: unknown): { ctx: PluginManagerHostContextLike; listeners: Map<string, Set<(payload: unknown) => void>> } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const ctx: PluginManagerHostContextLike = {
    get: (name: string) => name === 'pluginManager' ? service : undefined,
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => { set.delete(listener) }
    },
  }
  return { ctx, listeners }
}

test('snapshot maps bundles/plugins/registries/exemptions onto frozen detached facts', async () => {
  const port = new DirectPluginManagerPort(host(fakeService({
    listBundles: async () => [
      {
        name: '@xmoon76/dsh-pi-tui',
        version: '0.4.8',
        meta: { title: { en: 'TUI' }, description: 'the surface' },
        description: 'manifest description',
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        rows: [{ rowId: 'tui-app', moduleName: '@xmoon76/dsh-pi-tui', meta: { title: 'App' }, entryId: 'e-app' as never }],
        overrides: ['tool-bash'],
      },
    ],
    listPlugins: async () => [
      { entryId: 'e-app' as never, moduleName: '@xmoon76/dsh-pi-tui', meta: { description: 'app row' }, enabled: true, fiberPhase: 'active', patchId: 'tui-app' },
      { entryId: 'e-ro' as never, moduleName: 'locked', enabled: false, fiberPhase: 'failed', readOnlyReason: 'unaddressable' },
    ],
    registries: async () => ({ registry: 'https://r', fallbackRegistries: ['https://f'], resolved: 'https://r' }),
    listVersionExemptions: () => ({ exemptions: { 'pkg@1.0.0': ['0.1.7-rc.1'] }, warnings: ['bad record'] }),
  })).ctx)

  const snapshot = await port.snapshot()
  assert.equal(snapshot.bundles.length, 1)
  const bundle = snapshot.bundles[0]!
  assert.equal(bundle.name, '@xmoon76/dsh-pi-tui')
  assert.equal(bundle.title, 'TUI')
  assert.equal(bundle.description, 'manifest description')
  assert.equal(bundle.rows[0]!.title, 'App')
  assert.equal(bundle.rows[0]!.entryId, 'e-app')
  assert.deepEqual([...bundle.overrides], ['tool-bash'])
  assert.equal(snapshot.plugins[0]!.patchId, 'tui-app')
  assert.equal(snapshot.plugins[0]!.title, undefined)
  assert.equal(snapshot.plugins[0]!.description, 'app row')
  assert.equal(snapshot.plugins[1]!.readOnlyReason, 'unaddressable')
  assert.deepEqual(snapshot.registries, { registry: 'https://r', fallbackRegistries: ['https://f'], resolved: 'https://r' })
  assert.equal(snapshot.exemptions[0]!.packageVersion, 'pkg@1.0.0')
  assert.deepEqual([...snapshot.exemptions[0]!.runtimeVersions], ['0.1.7-rc.1'])
  assert.deepEqual([...snapshot.exemptionWarnings], ['bad record'])
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(bundle))
  assert.ok(Object.isFrozen(snapshot.plugins))
  // No Host object leaks: the mapped bundle carries only primitive arrays.
  assert.equal((snapshot.bundles[0] as { error?: unknown }).error, undefined)
})

test('inspect/mutations forward the exact spec, registry and request id', async () => {
  const calls: unknown[] = []
  const port = new DirectPluginManagerPort(host(fakeService({
    inspect: async (spec, options, signal) => {
      calls.push({ spec, options, aborted: signal?.aborted })
      return { status: 'accepted', kind: 'registry', name: 'pkg', version: '1.0.0', bundle: true, registry: 'https://r' }
    },
    setBundleEnabled: async (name, enabled) => { calls.push({ name, enabled }); return change() },
    setPluginEnabled: async (id, enabled) => { calls.push({ id, enabled }); return change() },
    installBundle: async (spec, options) => { calls.push({ spec, options }); return change({ stage: 'install' }) },
    waitForInstall: async (requestId) => { calls.push({ waitFor: String(requestId) }); return null },
    cancelInstall: async (requestId) => { calls.push({ cancelFor: String(requestId) }); return { status: 'too-late' } },
  })).ctx)

  const signal = new AbortController().signal
  const inspection = await port.inspect('pkg', 'https://r', signal)
  assert.equal(inspection.status, 'accepted')
  assert.deepEqual(calls[0], { spec: 'pkg', options: { registry: 'https://r' }, aborted: false })

  await port.setBundleEnabled('@xmoon76/dsh-pi-tui', false)
  assert.deepEqual(calls[1], { name: '@xmoon76/dsh-pi-tui', enabled: false })
  await port.setPluginEnabled('e1', true)
  assert.deepEqual(calls[2], { id: 'e1', enabled: true })

  await port.startInstall({ requestId: 'req-1', spec: 'pkg', registry: 'https://r', enabled: true })
  assert.equal((calls[3] as { spec: string }).spec, 'pkg')
  assert.equal(String((calls[3] as { options: { requestId: unknown } }).options.requestId), 'req-1')
  await port.waitForInstall('req-1')
  assert.deepEqual(calls[4], { waitFor: 'req-1' })
  const cancellation = await port.cancelInstall('req-1')
  assert.equal(cancellation.status, 'too-late')
})

test('subscribeInstall delivers detached phase/log events and unsubscribes', () => {
  const { ctx, listeners } = host(fakeService())
  const port = new DirectPluginManagerPort(ctx)
  const received: unknown[] = []
  const off = port.subscribeInstall(event => received.push(event))

  const state = [...listeners.get('plugin-manager/install-state')!][0]!
  state({ requestId: 'req-1', phase: 'installing', attempt: { registry: 'https://r', index: 1, total: 2 } })
  const log = [...listeners.get('plugin-manager/install-log')!][0]!
  log({ requestId: 'req-1', jobId: 'job-1', argv: ['pnpm'], cwd: '/p', stream: 'stderr', text: 'boom', exitCode: 1 })

  assert.deepEqual(received[0], {
    kind: 'phase',
    phase: { requestId: 'req-1', phase: 'installing', attempt: { registry: 'https://r', index: 1, total: 2 } },
  })
  assert.deepEqual(received[1], {
    kind: 'log',
    log: { requestId: 'req-1', jobId: 'job-1', stream: 'stderr', text: 'boom' },
  })
  off()
  assert.equal([...listeners.get('plugin-manager/install-state')!].length, 0)
  assert.equal([...listeners.get('plugin-manager/install-log')!].length, 0)
})

test('a missing pluginManager service fails loud, never silently', async () => {
  const port = new DirectPluginManagerPort({ get: () => undefined, on: () => () => {} })
  await assert.rejects(() => port.snapshot(), /pluginManager service unavailable/)
})
