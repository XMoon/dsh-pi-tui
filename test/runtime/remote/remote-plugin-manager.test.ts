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
} from '../../../src/runtime/remote/plugin-manager-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../../src/runtime/remote/session-reader-remote.ts'
import { DirectPluginManagerPort, type PluginManagerServiceLike } from '../../../src/runtime/direct/plugin-manager-direct.ts'
import { pluginInstallRequestId } from '../../../src/runtime/plugin-manager-mapping.ts'
import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallLogChunk,
  PluginInstallProgress,
} from '@deepseek-ai/dsh-plugin-manager'
import { PluginManagerStaleResultError } from '../../../src/runtime/plugin-manager-port.ts'
import type { PluginInstallEvent } from '../../../src/runtime/plugin-manager-port.ts'

const entryId = (value: string): PluginEntryId => value as PluginEntryId

const BUNDLE: BundleInfo = {
  name: 'bundle-a',
  version: '1.2.3',
  official: false,
  availability: 'profile',
  source: 'file:/tmp/bundle-a',
  meta: { title: { en: 'Bundle A' }, description: 'Local description' },
  // The rc.1 default-listing decision and update capability are Host facts the
  // shared mapping must carry through BOTH backends without inventing values.
  listedByDefault: false,
  enabled: true,
  installed: true,
  optional: false,
  removable: true,
  update: 'registry',
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
  /** How many times each forwarded-event disposer was actually invoked. */
  readonly offCalls: { readonly installState: number; readonly installLog: number; readonly changed: number; readonly updateState: number }
  emitState(progress: PluginInstallProgress): void
  emitLog(chunk: PluginInstallLogChunk): void
  emitChanged(): void
  emitUpdate(progress: { readonly requestId: string; readonly step: 'checking' | 'removing' | 'installing' | 'restoring' }): void
  refuse(operation: string, message: string): void
  failOn(event: string, error: unknown): void
  readonly subscriptions: number
}

/** The official Connection generation source fixture: the store dedupes by
 *  identity itself, but the adapter must not double-fire either. */
interface GenerationFixture extends RemoteConnectionGenerationSource {
  set(id: number | undefined): void
  /** How many times the subscription's disposer was actually invoked. */
  readonly offCalls: number
  readonly subscriptions: number
}

function generationFixture(initial?: number): GenerationFixture {
  let current: { readonly id: number } | undefined = initial === undefined ? undefined : { id: initial }
  const listeners = new Set<() => void>()
  let offCalls = 0
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { offCalls += 1; listeners.delete(listener) }
    },
    set(id) {
      // The real store returns a NEW object per established generation and
      // publishes `undefined` on loss (Object.is-deduped).
      const next = id === undefined ? undefined : { id }
      if (Object.is(current, next)) return
      current = next
      for (const listener of [...listeners]) listener()
    },
    get offCalls() { return offCalls },
    get subscriptions() { return listeners.size },
  }
}

function portOf(
  remote: RemotePluginManagerFixture,
  generation: GenerationFixture = generationFixture(),
): RemotePluginManagerPort {
  return new RemotePluginManagerPort(remote, generation)
}

function remoteFixture(): RemotePluginManagerFixture {
  const calls: string[] = []
  const installOptions: InstallBundleOptions[] = []
  const failures = new Map<string, string>()
  const stateListeners = new Set<(payload: PluginInstallProgress) => void>()
  const logListeners = new Set<(payload: PluginInstallLogChunk) => void>()
  const changedListeners = new Set<() => void>()
  const updateListeners = new Set<(payload: { readonly requestId: string; readonly step: 'checking' | 'removing' | 'installing' | 'restoring' }) => void>()
  const eventFailures = new Map<string, unknown>()
  const offCalls = { installState: 0, installLog: 0, changed: 0, updateState: 0 }
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
    listVersions: async (name) => settle('listVersions', {
      status: 'listed' as const,
      installed: '1.0.0',
      registry: 'https://r.example',
      attempts: [{ registry: 'https://r.example' }],
      versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }],
      omitted: 0,
    }),
    updateBundle: async (name, version) => settle('updateBundle', {
      from: '1.0.0',
      to: version,
      step: 'install' as const,
      result: { ...CHANGE, stage: 'install' as const, target: `${name}@${version}`, version },
    }),
  }
  return {
    pluginManager,
    // The fixture stores listeners for ALL forwarded events; the official
    // face is overloaded per event, so the storage signature is the loose
    // call-site type and each event branch narrows its own listener.
    $on: (event: string, listener: (payload: never) => void) => {
      // Fault injection: the fixture can script a synchronous subscription
      // failure for any forwarded event.
      if (eventFailures.has(event)) throw eventFailures.get(event)
      if (event === 'plugin-manager/install-state') {
        const typed = listener as (payload: PluginInstallProgress) => void
        stateListeners.add(typed)
        return () => { offCalls.installState += 1; stateListeners.delete(typed) }
      }
      if (event === 'plugin-manager/changed') {
        const typed = listener as () => void
        changedListeners.add(typed)
        return () => { offCalls.changed += 1; changedListeners.delete(typed) }
      }
      if (event === 'plugin-manager/update-state') {
        const typed = listener as (payload: { readonly requestId: string; readonly step: 'checking' | 'removing' | 'installing' | 'restoring' }) => void
        updateListeners.add(typed)
        return () => { offCalls.updateState += 1; updateListeners.delete(typed) }
      }
      const typed = listener as (payload: PluginInstallLogChunk) => void
      logListeners.add(typed)
      return () => { offCalls.installLog += 1; logListeners.delete(typed) }
    },
    get calls() { return calls },
    get installOptions() { return installOptions },
    get offCalls() { return offCalls },
    get subscriptions() { return stateListeners.size + logListeners.size + changedListeners.size + updateListeners.size },
    emitState(progress) { for (const listener of [...stateListeners]) listener(progress) },
    emitLog(chunk) { for (const listener of [...logListeners]) listener(chunk) },
    emitChanged() { for (const listener of [...changedListeners]) listener() },
    emitUpdate(progress) { for (const listener of [...updateListeners]) listener(progress) },
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
    listVersions: async () => { calls.push('listVersions'); return {
      status: 'listed',
      installed: '1.0.0',
      registry: 'https://r.example',
      attempts: [{ registry: 'https://r.example' }],
      versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }],
      omitted: 0,
    } },
    updateBundle: async (name, version) => { calls.push('updateBundle'); return {
      from: '1.0.0',
      to: version,
      step: 'install',
      result: { ...CHANGE, stage: 'install', target: `${name}@${version}`, version },
    } },
    get calls() { return calls },
  }
}

/** The Direct adapter over a stub Cordis context holding one Host service. */
function directPort(service: PluginManagerServiceLike): DirectPluginManagerPort {
  return new DirectPluginManagerPort({
    get: name => name === 'pluginManager' ? service : undefined,
    on: () => () => false,
  })
}

test('the Remote snapshot maps bundles, plugins, registries and exemptions like the Direct adapter', async () => {
  const remoteFacts = await portOf(remoteFixture()).snapshot()
  const directFacts = await directPort(directFixture()).snapshot()
  assert.deepEqual(remoteFacts, directFacts)
  assert.deepEqual(remoteFacts.bundles[0], {
    name: 'bundle-a',
    official: false,
    availability: 'profile',
    source: 'file:/tmp/bundle-a',
    version: '1.2.3',
    title: 'Bundle A',
    description: 'Local description',
    listedByDefault: false,
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    update: 'registry',
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
  const port = portOf(remoteFixture())
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
  const port = portOf(remoteFixture())
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
  const port = portOf(remote)
  await port.startInstall({
    requestId: 'req-1',
    spec: 'pkg',
    registry: 'https://r.example',
    enabled: false,
    approvedBuilds: ['esbuild', 'node-gyp'],
  })
  assert.equal(remote.installOptions.length, 1)
  assert.equal(String(remote.installOptions[0]?.requestId), 'req-1')
  assert.equal(remote.installOptions[0]?.registry, 'https://r.example')
  assert.equal(remote.installOptions[0]?.enabled, false)
  assert.deepEqual(remote.installOptions[0]?.approvedBuilds, ['esbuild', 'node-gyp'])
})

test('waitForInstall settles null for an unknown result and maps a real one', async () => {
  const port = portOf(remoteFixture())
  assert.equal(await port.waitForInstall('r-null'), null)
  const fact = await port.waitForInstall('req-1')
  assert.equal(fact?.stage, 'install')
  assert.equal(fact?.target, 'req-1')
})

test('cancelInstall maps the official cancellation status', async () => {
  const port = portOf(remoteFixture())
  assert.deepEqual(await port.cancelInstall('req-1'), { status: 'cancelled' })
})

test('subscribeInstall maps both forwarded install events and releases both on dispose', () => {
  const remote = remoteFixture()
  const port = portOf(remote)
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
  dispose()
  assert.equal(remote.subscriptions, 0)
  assert.deepEqual(remote.offCalls, { installState: 1, installLog: 1, changed: 0, updateState: 0 },
    'each install-event disposer runs EXACTLY once, even when dispose is repeated')
  remote.emitState({ requestId: pluginInstallRequestId('req-2'), phase: 'applying' })
  remote.emitLog({ jobId: 'job-2', argv: [], cwd: '/tmp', stream: 'stderr', text: 'late' })
  assert.equal(events.length, 2, 'a disposed subscription must not deliver later events')
  assert.deepEqual(remote.offCalls, { installState: 1, installLog: 1, changed: 0, updateState: 0 })
})

test('a refused Remote call surfaces as one thrown Error (never application: failed)', async () => {
  const remote = remoteFixture()
  const port = portOf(remote)
  remote.refuse('setBundleEnabled', 'profile is read-only')
  await assert.rejects(() => port.setBundleEnabled('bundle-a', true), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /pluginManager\.setBundleEnabled failed: profile is read-only/)
    return true
  })
})

test('a snapshot refusal rejects the whole read instead of publishing partial facts', async () => {
  const remote = remoteFixture()
  const port = portOf(remote)
  remote.refuse('listPlugins', 'carrier offline')
  await assert.rejects(() => port.snapshot(), /carrier offline/)
})

test('a failed second event subscription releases the first (no leaked listener)', () => {
  const remote = remoteFixture()
  const port = portOf(remote)
  const events: PluginInstallEvent[] = []
  remote.failOn('plugin-manager/install-log', new Error('the subscription was refused'))
  assert.throws(() => port.subscribeInstall(event => events.push(event)), /subscription was refused/)
  assert.equal(remote.subscriptions, 0, 'the state subscription must be rolled back')
  // No leaked listener may still deliver after the failed subscribe.
  remote.failOn('plugin-manager/install-log', undefined)
  remote.emitState({ requestId: pluginInstallRequestId('req-1'), phase: 'applying' })
  assert.equal(events.length, 0, 'the rolled-back subscription must not deliver')
})

test('a forwarded plugin-manager/changed maps to exactly one invalidation and dispose releases it', () => {
  const remote = remoteFixture()
  const generation = generationFixture(1)
  const port = portOf(remote, generation)
  let invalidations = 0
  const dispose = port.subscribeInvalidation(() => { invalidations += 1 })
  remote.emitChanged()
  assert.equal(invalidations, 1, 'the forwarded Host change is an invalidation hint')
  dispose()
  dispose()
  assert.equal(remote.subscriptions, 0, 'the changed subscription is released')
  assert.equal(generation.subscriptions, 0, 'the generation subscription is released')
  assert.deepEqual(remote.offCalls, { installState: 0, installLog: 0, changed: 1, updateState: 0 },
    'the changed disposer runs EXACTLY once, even when dispose is repeated')
  assert.equal(generation.offCalls, 1, 'the generation disposer runs EXACTLY once')
  remote.emitChanged()
  generation.set(2)
  assert.equal(invalidations, 1, 'a disposed subscription must not deliver later invalidations')
  assert.deepEqual(remote.offCalls, { installState: 0, installLog: 0, changed: 1, updateState: 0 })
  assert.equal(generation.offCalls, 1)
})

test('a new Connection generation invalidates once; a lost generation does not', () => {
  const remote = remoteFixture()
  const generation = generationFixture(1)
  const port = portOf(remote, generation)
  let invalidations = 0
  const dispose = port.subscribeInvalidation(() => { invalidations += 1 })

  // The identity-stable generation the subscription captured: no duplicate.
  generation.set(1)
  assert.equal(invalidations, 0, 'the same generation identity is not a new generation')

  // Disconnect: no fabricated inventory, no invalidation.
  generation.set(undefined)
  assert.equal(invalidations, 0, 'a lost generation must not fabricate inventory or invalidate')

  // Reconnect: undefined -> new defined generation is a new generation to reread.
  generation.set(2)
  assert.equal(invalidations, 1, 'reconnect rereads once')
  generation.set(3)
  assert.equal(invalidations, 2, 'a replaced generation rereads once')
  dispose()
  dispose()
  assert.equal(remote.subscriptions, 0)
  assert.equal(generation.subscriptions, 0)
  assert.equal(generation.offCalls, 1, 'the generation disposer runs EXACTLY once, even when dispose is repeated')
  generation.set(4)
  assert.equal(invalidations, 2, 'a disposed subscription must not deliver later invalidations')
  assert.equal(generation.offCalls, 1)
})

test('a failed invalidation subscription releases the already-installed listener', () => {
  const remote = remoteFixture()
  const generation = generationFixture(1)
  const port = portOf(remote, generation)
  // The generation subscribe is the second registration: a synchronous failure
  // there must not leak the changed listener.
  const originalSubscribe = generation.subscribe
  let invalidations = 0
  generation.subscribe = () => { throw new Error('generation subscription refused') }
  assert.throws(() => port.subscribeInvalidation(() => { invalidations += 1 }), /generation subscription refused/)
  assert.equal(remote.subscriptions, 0, 'the changed subscription must be rolled back')
  assert.equal(remote.offCalls.changed, 1, 'the rollback releases the changed subscription exactly once')
  generation.subscribe = originalSubscribe
  remote.emitChanged()
  generation.set(2)
  assert.equal(invalidations, 0, 'the rolled-back subscriptions must not deliver')
})

test('a Remote inspection carried by a superseded Connection generation is refused', async (t) => {
  const remote = remoteFixture()
  const original = remote.pluginManager.inspect
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  remote.pluginManager.inspect = async (spec, options, signal) => {
    reached()
    await gate
    return original(spec, options, signal)
  }
  t.after(() => { release() })
  const generation = generationFixture(1)
  const port = portOf(remote, generation)
  const pending = port.inspect('pkg', 'https://r.example')
  await started
  generation.set(2)
  release()
  await assert.rejects(pending, error => error instanceof PluginManagerStaleResultError
    && /currentness context was superseded/.test(error.message))
  assert.deepEqual(remote.calls, ['inspect'], 'the real inspect ran; only its stale result was refused')

  // The same inspection on an unchanged generation still resolves normally.
  remote.pluginManager.inspect = original
  const accepted = await port.inspect('pkg', 'https://r.example')
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.name, 'pkg')

  // A refused inspection carried by a superseded generation is indeterminate too.
  const refused = remoteFixture()
  refused.refuse('inspect', 'no such package')
  const refusedOriginal = refused.pluginManager.inspect
  let refusedRelease!: () => void
  const refusedGate = new Promise<void>(resolve => { refusedRelease = resolve })
  refused.pluginManager.inspect = async (spec, options, signal) => {
    await refusedGate
    return refusedOriginal(spec, options, signal)
  }
  t.after(() => { refusedRelease() })
  const refusedGeneration = generationFixture(1)
  const refusedPort = portOf(refused, refusedGeneration)
  const refusedPending = refusedPort.inspect('bad', 'https://r.example')
  refusedGeneration.set(2)
  refusedRelease()
  await assert.rejects(refusedPending, error => error instanceof PluginManagerStaleResultError)
})

test('a Remote mutation result carried by a superseded Connection generation is refused, never presented as success', async (t) => {
  const remote = remoteFixture()
  const generation = generationFixture(1)
  const original = remote.pluginManager.setBundleEnabled
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  remote.pluginManager.setBundleEnabled = async (name, enabled) => {
    reached()
    await gate
    return original(name, enabled)
  }
  t.after(() => { release() })
  const port = portOf(remote, generation)
  const pending = port.setBundleEnabled('bundle-a', true)
  await started
  // A NEW Connection generation is established while the wire call is pending.
  generation.set(2)
  release()
  await assert.rejects(pending, error => error instanceof PluginManagerStaleResultError
    && /currentness context was superseded/.test(error.message))
  assert.deepEqual(remote.calls, ['setBundleEnabled'], 'the real call really ran; only its stale result was refused')

  // The SAME mutation on an unchanged generation still resolves normally.
  remote.pluginManager.setBundleEnabled = original
  const change = await port.setBundleEnabled('bundle-a', true)
  assert.equal(change.stage, 'enable')
  assert.equal(change.target, 'bundle-a:true')
})

test('a Remote refusal or transport rejection after a generation change is indeterminate; the current generation keeps the real error', async (t) => {
  const hold = <T>(call: () => Promise<T>): { pending: Promise<T>; release: () => void } => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    return { pending: (async () => { await gate; return call() })(), release }
  }

  // Official refusal carried by a superseded generation.
  const refused = remoteFixture()
  refused.refuse('setBundleEnabled', 'host refused')
  const refusedOriginal = refused.pluginManager.setBundleEnabled
  const refusedHold = hold(() => refusedOriginal('bundle-a', true))
  refused.pluginManager.setBundleEnabled = () => refusedHold.pending
  t.after(() => { refusedHold.release() })
  const refusedGeneration = generationFixture(1)
  const refusedPort = portOf(refused, refusedGeneration)
  const refusedPending = refusedPort.setBundleEnabled('bundle-a', true)
  refusedGeneration.set(2)
  refusedHold.release()
  await assert.rejects(refusedPending, error => error instanceof PluginManagerStaleResultError)

  // Transport rejection carried by a superseded generation.
  const lost = remoteFixture()
  let releaseLost!: () => void
  const lostGate = new Promise<void>(resolve => { releaseLost = resolve })
  t.after(() => { releaseLost() })
  lost.pluginManager.setBundleEnabled = async () => {
    await lostGate
    throw new Error('transport lost')
  }
  const lostGeneration = generationFixture(1)
  const lostPort = portOf(lost, lostGeneration)
  const lostPending = lostPort.setBundleEnabled('bundle-a', true)
  lostGeneration.set(2)
  releaseLost()
  await assert.rejects(lostPending, error => error instanceof PluginManagerStaleResultError)

  // An UNCHANGED generation keeps the genuine refusal and transport error.
  const currentRefused = remoteFixture()
  currentRefused.refuse('setBundleEnabled', 'host refused')
  await assert.rejects(
    portOf(currentRefused).setBundleEnabled('bundle-a', true),
    /pluginManager\.setBundleEnabled failed: host refused/,
  )
  const currentLost = remoteFixture()
  currentLost.pluginManager.setBundleEnabled = async () => { throw new Error('transport lost') }
  await assert.rejects(portOf(currentLost).setBundleEnabled('bundle-a', true), /transport lost/)
})

test('installBundle, waitForInstall and cancelInstall settlements are generation-fenced', async (t) => {
  const hold = <T>(call: () => Promise<T>): { pending: Promise<T>; release: () => void } => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    return { pending: (async () => { await gate; return call() })(), release }
  }

  // A successful install result carried by a superseded generation.
  const startRemote = remoteFixture()
  const startOriginal = startRemote.pluginManager.installBundle
  const startHold = hold(() => startOriginal('pkg', { requestId: pluginInstallRequestId('r-start') }))
  startRemote.pluginManager.installBundle = () => startHold.pending
  t.after(() => { startHold.release() })
  const startGeneration = generationFixture(1)
  const startPort = portOf(startRemote, startGeneration)
  const starting = startPort.startInstall({ requestId: 'r-start', spec: 'pkg', registry: null })
  startGeneration.set(2)
  startHold.release()
  await assert.rejects(starting, error => error instanceof PluginManagerStaleResultError)

  // A refused install result carried by a superseded generation.
  const refusedRemote = remoteFixture()
  refusedRemote.refuse('installBundle', 'install refused')
  const refusedOriginal = refusedRemote.pluginManager.installBundle
  const refusedHold = hold(() => refusedOriginal('pkg', { requestId: pluginInstallRequestId('r-refused') }))
  refusedRemote.pluginManager.installBundle = () => refusedHold.pending
  t.after(() => { refusedHold.release() })
  const refusedGeneration = generationFixture(1)
  const refusedPort = portOf(refusedRemote, refusedGeneration)
  const refusedStarting = refusedPort.startInstall({ requestId: 'r-refused', spec: 'pkg', registry: null })
  refusedGeneration.set(2)
  refusedHold.release()
  await assert.rejects(refusedStarting, error => error instanceof PluginManagerStaleResultError)

  // waitForInstall (a real result) and cancelInstall settlements are fenced too.
  const waitRemote = remoteFixture()
  const waitOriginal = waitRemote.pluginManager.waitForInstall
  const waitHold = hold(() => waitOriginal(pluginInstallRequestId('r-1')))
  waitRemote.pluginManager.waitForInstall = () => waitHold.pending
  t.after(() => { waitHold.release() })
  const waitGeneration = generationFixture(1)
  const waitPort = portOf(waitRemote, waitGeneration)
  const waiting = waitPort.waitForInstall('r-1')
  waitGeneration.set(2)
  waitHold.release()
  await assert.rejects(waiting, error => error instanceof PluginManagerStaleResultError)

  const cancelRemote = remoteFixture()
  const cancelOriginal = cancelRemote.pluginManager.cancelInstall
  const cancelHold = hold(() => cancelOriginal(pluginInstallRequestId('r-1')))
  cancelRemote.pluginManager.cancelInstall = () => cancelHold.pending
  t.after(() => { cancelHold.release() })
  const cancelGeneration = generationFixture(1)
  const cancelPort = portOf(cancelRemote, cancelGeneration)
  const cancelling = cancelPort.cancelInstall('r-1')
  cancelGeneration.set(2)
  cancelHold.release()
  await assert.rejects(cancelling, error => error instanceof PluginManagerStaleResultError)

  // The same settlements on an unchanged generation still resolve normally.
  const currentStart = remoteFixture()
  const currentPort = portOf(currentStart)
  const started = await currentPort.startInstall({ requestId: 'r-current', spec: 'pkg', registry: null })
  assert.equal(started.stage, 'install')
  assert.deepEqual(await currentPort.waitForInstall('r-1'), { ...CHANGE, stage: 'install', target: 'r-1' })
  assert.deepEqual(await currentPort.cancelInstall('r-1'), { status: 'cancelled' })
})

// ── S5-PR2: official version listing and update over the generated Remote ───

test('the Remote version list and update result match the Direct adapter exactly', async () => {
  const remote = portOf(remoteFixture())
  const direct = directPort(directFixture())
  assert.deepEqual(await remote.listVersions('bundle-a', new AbortController().signal), await direct.listVersions('bundle-a'))
  assert.deepEqual(
    await remote.updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update'),
    await direct.updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update'),
  )
})

test('the Remote update write forwards the exact version, Host-answered registry and request id', async () => {
  const remote = remoteFixture()
  const port = portOf(remote)
  const fact = await port.updateBundle('bundle-a', '1.2.0', 'https://r.example', 'req-update')
  assert.deepEqual([...remote.calls], ['updateBundle'])
  assert.equal(fact.from, '1.0.0')
  assert.equal(fact.to, '1.2.0')
  assert.equal(fact.step, 'install')
  assert.equal(fact.result.target, 'bundle-a@1.2.0')
})

test('subscribeUpdate maps the forwarded update state and releases exactly one listener', () => {
  const remote = remoteFixture()
  const port = portOf(remote)
  const received: unknown[] = []
  const dispose = port.subscribeUpdate(progress => received.push(progress))
  remote.emitUpdate({ requestId: 'req-update', step: 'checking' })
  remote.emitUpdate({ requestId: 'req-update', step: 'installing' })
  assert.deepEqual(received, [
    { requestId: 'req-update', step: 'checking' },
    { requestId: 'req-update', step: 'installing' },
  ])
  dispose()
  dispose()
  assert.equal(remote.subscriptions, 0)
  assert.deepEqual(remote.offCalls, { installState: 0, installLog: 0, changed: 0, updateState: 1 },
    'the update-state disposer runs EXACTLY once')
  remote.emitUpdate({ requestId: 'req-update', step: 'restoring' })
  assert.equal(received.length, 2, 'a disposed subscription delivers nothing later')
})

test('a version list or update reply carried by a superseded Connection generation is indeterminate', async (t) => {
  const hold = <T>(call: () => Promise<T>): { pending: Promise<T>; release: () => void } => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    return { pending: (async () => { await gate; return call() })(), release }
  }

  // A successful version list carried by a superseded generation.
  const listRemote = remoteFixture()
  const listOriginal = listRemote.pluginManager.listVersions
  const listHold = hold(() => listOriginal('bundle-a', undefined, undefined))
  listRemote.pluginManager.listVersions = () => listHold.pending
  t.after(() => { listHold.release() })
  const listGeneration = generationFixture(1)
  const listPort = portOf(listRemote, listGeneration)
  const listing = listPort.listVersions('bundle-a')
  listGeneration.set(2)
  listHold.release()
  await assert.rejects(listing, error => error instanceof PluginManagerStaleResultError)

  // A successful update result carried by a superseded generation.
  const updateRemote = remoteFixture()
  const updateOriginal = updateRemote.pluginManager.updateBundle
  const updateHold = hold(() => updateOriginal('bundle-a', '1.1.0', { registry: 'https://r.example' }))
  updateRemote.pluginManager.updateBundle = () => updateHold.pending
  t.after(() => { updateHold.release() })
  const updateGeneration = generationFixture(1)
  const updatePort = portOf(updateRemote, updateGeneration)
  const updating = updatePort.updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update')
  updateGeneration.set(2)
  updateHold.release()
  await assert.rejects(updating, error => error instanceof PluginManagerStaleResultError)
  assert.deepEqual([...updateRemote.calls], ['updateBundle'], 'the real call ran; only its stale reply was refused')

  // A refused or transport-rejected update carried by a superseded generation is indeterminate.
  const refusedRemote = remoteFixture()
  refusedRemote.refuse('updateBundle', 'host refused')
  const refusedOriginal = refusedRemote.pluginManager.updateBundle
  const refusedHold = hold(() => refusedOriginal('bundle-a', '1.1.0', { registry: 'https://r.example' }))
  refusedRemote.pluginManager.updateBundle = () => refusedHold.pending
  t.after(() => { refusedHold.release() })
  const refusedGeneration = generationFixture(1)
  const refusedPort = portOf(refusedRemote, refusedGeneration)
  const refusedUpdating = refusedPort.updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update')
  refusedGeneration.set(2)
  refusedHold.release()
  await assert.rejects(refusedUpdating, error => error instanceof PluginManagerStaleResultError)

  const lostRemote = remoteFixture()
  let releaseLost!: () => void
  const lostGate = new Promise<void>(resolve => { releaseLost = resolve })
  t.after(() => { releaseLost() })
  lostRemote.pluginManager.updateBundle = async () => {
    await lostGate
    throw new Error('transport lost')
  }
  const lostGeneration = generationFixture(1)
  const lostPort = portOf(lostRemote, lostGeneration)
  const lostUpdating = lostPort.updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update')
  lostGeneration.set(2)
  releaseLost()
  await assert.rejects(lostUpdating, error => error instanceof PluginManagerStaleResultError)

  // An UNCHANGED generation keeps the genuine refusal and resolves the real reply.
  const currentRefused = remoteFixture()
  currentRefused.refuse('updateBundle', 'host refused')
  await assert.rejects(
    portOf(currentRefused).updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update'),
    /pluginManager\.updateBundle failed: host refused/,
  )
  const current = remoteFixture()
  const currentPort = portOf(current)
  const settled = await currentPort.updateBundle('bundle-a', '1.1.0', 'https://r.example', 'req-update')
  assert.equal(settled.to, '1.1.0')
  assert.deepEqual([...current.calls], ['updateBundle'], 'one write per call, never a retry')
})

test('a Remote snapshot carried by a superseded Connection generation is never authoritative', async (t) => {
  const holdPlugins = (remote: RemotePluginManagerFixture): { release: () => void } => {
    const original = remote.pluginManager.listPlugins
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    remote.pluginManager.listPlugins = async () => {
      await gate
      return original()
    }
    t.after(() => { release() })
    return { release }
  }

  // A successful snapshot whose four reads started on generation A and settle
  // on generation B is indeterminate, never the new generation's inventory.
  const successRemote = remoteFixture()
  const successHold = holdPlugins(successRemote)
  const successGeneration = generationFixture(1)
  const successPort = portOf(successRemote, successGeneration)
  const pendingSnapshot = successPort.snapshot()
  await new Promise<void>(resolve => setImmediate(resolve))
  successGeneration.set(2)
  successHold.release()
  await assert.rejects(pendingSnapshot, error => error instanceof PluginManagerStaleResultError)
  assert.ok(successRemote.calls.includes('listBundles'), 'the real inventory reads ran')

  // A REFUSED snapshot carried by a superseded generation is indeterminate too.
  const refusedRemote = remoteFixture()
  refusedRemote.refuse('listBundles', 'inventory denied')
  const refusedHold = holdPlugins(refusedRemote)
  const refusedGeneration = generationFixture(1)
  const refusedPort = portOf(refusedRemote, refusedGeneration)
  const refusedSnapshot = refusedPort.snapshot()
  await new Promise<void>(resolve => setImmediate(resolve))
  refusedGeneration.set(2)
  refusedHold.release()
  await assert.rejects(refusedSnapshot, error => error instanceof PluginManagerStaleResultError)

  // An UNCHANGED generation keeps the real refusal and resolves a real snapshot.
  const currentRefused = remoteFixture()
  currentRefused.refuse('listBundles', 'inventory denied')
  await assert.rejects(portOf(currentRefused).snapshot(), /pluginManager\.listBundles failed: inventory denied/)
  const current = await portOf(remoteFixture()).snapshot()
  assert.equal(current.bundles.length, 1)
})
