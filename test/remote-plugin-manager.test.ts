/**
 * Remote Plugin Manager adapter tests (Pre-M3 PR2): the generated
 * `pluginManager` Remote face is mapped onto the SAME semantic facts as the
 * Direct Host service, refusals normalize to one thrown Error, and the install
 * event subscriptions release both forwarded events.
 * @module @xmoon76/dsh-pi-tui/remote-plugin-manager.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemotePluginManagerPort,
  type RemotePluginManagerNamespace,
  type RemotePluginManagerSource,
} from '../src/runtime/remote/plugin-manager-remote.ts'
import { DirectPluginManagerPort, type PluginManagerServiceLike } from '../src/runtime/direct/plugin-manager-direct.ts'
import { pluginInstallRequestId } from '../src/runtime/plugin-manager-mapping.ts'
import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallLogChunk,
  PluginInstallProgress,
} from '@deepseek-ai/dsh-plugin-manager'
import type { PluginInstallEvent } from '../src/runtime/plugin-manager-port.ts'

const entryId = (value: string): PluginEntryId => value as PluginEntryId

const BUNDLE: BundleInfo = {
  name: 'bundle-a',
  version: '1.2.3',
  meta: { title: { en: 'Bundle A' }, description: 'Local description' },
  enabled: true,
  installed: true,
  optional: false,
  removable: true,
  rows: [{ rowId: 'row-1', moduleName: 'module-1', meta: { title: 'Row one' }, entryId: entryId('entry-1') }],
  overrides: ['builtin-row'],
}

const PLUGIN: PluginInfo = {
  entryId: entryId('entry-1'),
  moduleName: 'module-1',
  enabled: false,
  fiberPhase: 'active',
  patchId: 'patch-1',
}

const CHANGE: ChangeResult = {
  changed: true,
  application: 'applied',
  stage: 'enable',
  target: 'bundle-a',
  bundle: 'bundle-a',
  warnings: ['already inactive'],
}

const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value })
const refused = (message: string): { readonly ok: false; readonly error: unknown } => ({
  ok: false,
  error: { code: 'gateway/internal', message },
})

interface RemotePluginManagerFixture extends RemotePluginManagerSource {
  readonly calls: string[]
  readonly installOptions: InstallBundleOptions[]
  emitState(progress: PluginInstallProgress): void
  emitLog(chunk: PluginInstallLogChunk): void
  refuse(operation: string, message: string): void
  failOn(event: string, error: unknown): void
  readonly subscriptions: number
}

function remoteFixture(): RemotePluginManagerFixture {
  const calls: string[] = []
  const installOptions: InstallBundleOptions[] = []
  const failures = new Map<string, string>()
  const stateListeners = new Set<(payload: PluginInstallProgress) => void>()
  const logListeners = new Set<(payload: PluginInstallLogChunk) => void>()
  const eventFailures = new Map<string, unknown>()
  /** Record the call and fold a scripted refusal into the official result. */
  const settle = <T>(operation: string, value: T): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } => {
    calls.push(operation)
    const message = failures.get(operation)
    return message === undefined ? ok(value) : refused(message)
  }
  const pluginManager: RemotePluginManagerNamespace = {
    listBundles: async () => settle('listBundles', [BUNDLE]),
    listPlugins: async () => settle('listPlugins', [PLUGIN]),
    registries: async () => settle('registries', {
      registry: 'https://r.example',
      fallbackRegistries: ['https://f.example'],
      resolved: 'https://r.example',
    }),
    listVersionExemptions: async () => settle('listVersionExemptions', {
      exemptions: { 'pkg@1.0.0': ['0.1.7-rc.2'] },
      warnings: ['unreadable entry'],
    }),
    inspect: async (spec, options) => settle('inspect', spec === 'bad'
      ? {
        status: 'refused' as const,
        problem: 'not-found' as const,
        reason: 'no such package',
        registries: [options?.registry ?? null],
      }
      : {
        status: 'accepted' as const,
        kind: 'registry' as const,
        name: 'pkg',
        version: '1.0.0',
        bundle: true,
        registry: options?.registry ?? null,
      }),
    setBundleEnabled: async (name, enabled) => settle('setBundleEnabled', {
      ...CHANGE, stage: 'enable' as const, target: `${name}:${String(enabled)}`,
    }),
    setPluginEnabled: async (id, enabled) => settle('setPluginEnabled', {
      ...CHANGE, stage: 'enable' as const, target: `${id}:${String(enabled)}`,
    }),
    removeBundle: async name => settle('removeBundle', { ...CHANGE, stage: 'remove' as const, target: name }),
    installBundle: async (spec, options) => {
      if (options !== undefined) installOptions.push(options)
      return settle('installBundle', { ...CHANGE, stage: 'install' as const, target: spec })
    },
    waitForInstall: async requestId => settle('waitForInstall', String(requestId) === 'r-null'
      ? null
      : { ...CHANGE, stage: 'install' as const, target: String(requestId) }),
    cancelInstall: async () => settle('cancelInstall', { status: 'cancelled' as const }),
  }
  return {
    pluginManager,
    // The fixture stores listeners for BOTH forwarded events; the official
    // face is overloaded per event, so the storage signature is the loose
    // call-site type and each event branch narrows its own listener.
    $on: (event: string, listener: (payload: never) => void) => {
      // Fault injection: the fixture can script a synchronous subscription
      // failure for either forwarded event.
      if (eventFailures.has(event)) throw eventFailures.get(event)
      if (event === 'plugin-manager/install-state') {
        const typed = listener as (payload: PluginInstallProgress) => void
        stateListeners.add(typed)
        return () => { stateListeners.delete(typed) }
      }
      const typed = listener as (payload: PluginInstallLogChunk) => void
      logListeners.add(typed)
      return () => { logListeners.delete(typed) }
    },
    get calls() { return calls },
    get installOptions() { return installOptions },
    get subscriptions() { return stateListeners.size + logListeners.size },
    emitState(progress) { for (const listener of [...stateListeners]) listener(progress) },
    emitLog(chunk) { for (const listener of [...logListeners]) listener(chunk) },
    refuse(operation, message) { failures.set(operation, message) },
    failOn(event, error) { eventFailures.set(event, error) },
  }
}

function directFixture(): PluginManagerServiceLike & { calls: string[] } {
  const calls: string[] = []
  return {
    listBundles: async () => { calls.push('listBundles'); return [BUNDLE] },
    listPlugins: async () => { calls.push('listPlugins'); return [PLUGIN] },
    registries: async () => {
      calls.push('registries')
      return { registry: 'https://r.example', fallbackRegistries: ['https://f.example'], resolved: 'https://r.example' }
    },
    listVersionExemptions: () => {
      calls.push('listVersionExemptions')
      return { exemptions: { 'pkg@1.0.0': ['0.1.7-rc.2'] }, warnings: ['unreadable entry'] }
    },
    inspect: async () => {
      calls.push('inspect')
      return { status: 'accepted', kind: 'registry', name: 'pkg', version: '1.0.0', bundle: true, registry: null }
    },
    setBundleEnabled: async () => { calls.push('setBundleEnabled'); return CHANGE },
    setPluginEnabled: async () => { calls.push('setPluginEnabled'); return CHANGE },
    removeBundle: async () => { calls.push('removeBundle'); return CHANGE },
    installBundle: async () => { calls.push('installBundle'); return CHANGE },
    waitForInstall: async () => { calls.push('waitForInstall'); return null },
    cancelInstall: async () => { calls.push('cancelInstall'); return { status: 'not-running' } },
    get calls() { return calls },
  }
}

/** The Direct adapter over a stub Cordis context holding one Host service. */
function directPort(service: PluginManagerServiceLike): DirectPluginManagerPort {
  return new DirectPluginManagerPort({
    get: name => name === 'pluginManager' ? service : undefined,
    on: () => () => {},
  })
}

test('the Remote snapshot maps bundles, plugins, registries and exemptions like the Direct adapter', async () => {
  const remoteFacts = await new RemotePluginManagerPort(remoteFixture()).snapshot()
  const directFacts = await directPort(directFixture()).snapshot()
  assert.deepEqual(remoteFacts, directFacts)
  assert.deepEqual(remoteFacts.bundles[0], {
    name: 'bundle-a',
    version: '1.2.3',
    title: 'Bundle A',
    description: 'Local description',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: 'row-1', moduleName: 'module-1', title: 'Row one', entryId: 'entry-1' }],
    overrides: ['builtin-row'],
  })
  assert.deepEqual(remoteFacts.plugins[0], {
    entryId: 'entry-1',
    moduleName: 'module-1',
    enabled: false,
    fiberPhase: 'active',
    patchId: 'patch-1',
  })
  assert.deepEqual(remoteFacts.registries, {
    registry: 'https://r.example',
    fallbackRegistries: ['https://f.example'],
    resolved: 'https://r.example',
  })
  assert.deepEqual(remoteFacts.exemptions, [{ packageVersion: 'pkg@1.0.0', runtimeVersions: ['0.1.7-rc.2'] }])
  assert.deepEqual(remoteFacts.exemptionWarnings, ['unreadable entry'])
})

test('the Remote inspect maps accepted and refused inspections', async () => {
  const port = new RemotePluginManagerPort(remoteFixture())
  assert.deepEqual(await port.inspect('pkg', 'https://r.example'), {
    status: 'accepted',
    kind: 'registry',
    name: 'pkg',
    version: '1.0.0',
    bundle: true,
    registry: 'https://r.example',
  })
  assert.deepEqual(await port.inspect('bad', 'https://r.example'), {
    status: 'refused',
    problem: 'not-found',
    reason: 'no such package',
    registries: ['https://r.example'],
  })
})

test('the Remote mutations map the official change result', async () => {
  const port = new RemotePluginManagerPort(remoteFixture())
  assert.deepEqual(await port.setBundleEnabled('bundle-a', true), {
    changed: true,
    application: 'applied',
    stage: 'enable',
    target: 'bundle-a:true',
    warnings: ['already inactive'],
    bundle: 'bundle-a',
  })
  assert.deepEqual(await port.setPluginEnabled('entry-1', false), {
    changed: true,
    application: 'applied',
    stage: 'enable',
    target: 'entry-1:false',
    warnings: ['already inactive'],
    bundle: 'bundle-a',
  })
  assert.equal((await port.removeBundle('bundle-a')).stage, 'remove')
})

test('startInstall preserves the caller requestId, registry and enabled flag', async () => {
  const remote = remoteFixture()
  const port = new RemotePluginManagerPort(remote)
  await port.startInstall({ requestId: 'req-1', spec: 'pkg', registry: 'https://r.example', enabled: false })
  assert.equal(remote.installOptions.length, 1)
  assert.equal(String(remote.installOptions[0]?.requestId), 'req-1')
  assert.equal(remote.installOptions[0]?.registry, 'https://r.example')
  assert.equal(remote.installOptions[0]?.enabled, false)
})

test('waitForInstall settles null for an unknown result and maps a real one', async () => {
  const port = new RemotePluginManagerPort(remoteFixture())
  assert.equal(await port.waitForInstall('r-null'), null)
  const fact = await port.waitForInstall('req-1')
  assert.equal(fact?.stage, 'install')
  assert.equal(fact?.target, 'req-1')
})

test('cancelInstall maps the official cancellation status', async () => {
  const port = new RemotePluginManagerPort(remoteFixture())
  assert.deepEqual(await port.cancelInstall('req-1'), { status: 'cancelled' })
})

test('subscribeInstall maps both forwarded install events and releases both on dispose', () => {
  const remote = remoteFixture()
  const port = new RemotePluginManagerPort(remote)
  const events: PluginInstallEvent[] = []
  const dispose = port.subscribeInstall(event => events.push(event))
  remote.emitState({
    requestId: pluginInstallRequestId('req-1'),
    phase: 'installing',
    attempt: { registry: null, index: 1, total: 2 },
  })
  remote.emitLog({ jobId: 'job-1', argv: [], cwd: '/tmp', stream: 'stdout', text: 'added 1 package' })
  assert.deepEqual(events, [
    { kind: 'phase', phase: { requestId: 'req-1', phase: 'installing', attempt: { registry: null, index: 1, total: 2 } } },
    { kind: 'log', log: { jobId: 'job-1', stream: 'stdout', text: 'added 1 package' } },
  ])
  dispose()
  assert.equal(remote.subscriptions, 0)
  remote.emitState({ requestId: pluginInstallRequestId('req-2'), phase: 'applying' })
  remote.emitLog({ jobId: 'job-2', argv: [], cwd: '/tmp', stream: 'stderr', text: 'late' })
  assert.equal(events.length, 2, 'a disposed subscription must not deliver later events')
})

test('a refused Remote call surfaces as one thrown Error (never application: failed)', async () => {
  const remote = remoteFixture()
  const port = new RemotePluginManagerPort(remote)
  remote.refuse('setBundleEnabled', 'profile is read-only')
  await assert.rejects(() => port.setBundleEnabled('bundle-a', true), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /pluginManager\.setBundleEnabled failed: profile is read-only/)
    return true
  })
})

test('a snapshot refusal rejects the whole read instead of publishing partial facts', async () => {
  const remote = remoteFixture()
  const port = new RemotePluginManagerPort(remote)
  remote.refuse('listPlugins', 'carrier offline')
  await assert.rejects(() => port.snapshot(), /carrier offline/)
})

test('a failed second event subscription releases the first (no leaked listener)', () => {
  const remote = remoteFixture()
  const port = new RemotePluginManagerPort(remote)
  const events: PluginInstallEvent[] = []
  remote.failOn('plugin-manager/install-log', new Error('the subscription was refused'))
  assert.throws(() => port.subscribeInstall(event => events.push(event)), /subscription was refused/)
  assert.equal(remote.subscriptions, 0, 'the state subscription must be rolled back')
  // No leaked listener may still deliver after the failed subscribe.
  remote.failOn('plugin-manager/install-log', undefined)
  remote.emitState({ requestId: pluginInstallRequestId('req-1'), phase: 'applying' })
  assert.equal(events.length, 0, 'the rolled-back subscription must not deliver')
})
