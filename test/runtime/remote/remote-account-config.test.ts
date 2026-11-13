import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteConfigPort, type RemoteAccountRemotes, type RemoteAccountStreamHandle } from '../../../src/runtime/remote/config-remote.ts'
import type { RemoteConfigRuntimeSource } from '../../../src/runtime/remote/config-remote.ts'
import type { AccountObservationLease, AccountWatchEvent } from '../../../src/runtime/config-port.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'
import type { RemoteResultLike } from '../../../src/runtime/remote/session-writer-remote.ts'

const HOST_ORIGIN = 'http://127.0.0.1:43121'
const ACCOUNT_VIEW = {
  status: 'credential-stored',
  links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' },
  attempt: {
    id: 'attempt-exact',
    phase: 'waiting-browser',
    authorizeUrl: 'https://platform.example/dsh/authorize',
    expiresAt: 1_800_000_000_000,
  },
}

class AccountStream implements RemoteAccountStreamHandle<unknown> {
  private closed = false
  private readonly queue: unknown[]
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<unknown>) => void
    readonly reject: (error: Error) => void
  }> = []
  disposeCalls = 0

  constructor(initial: unknown) {
    this.queue = [initial]
  }

  push(value: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value })
    else this.queue.push(value)
  }

  carrierFailed(error = Object.assign(new Error('api gateway: Remote stream WebSocket failed'), { name: 'RemoteStreamCarrierError' })): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  dispose(): void {
    this.disposeCalls += 1
    this.close()
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const value = this.queue.shift()
        if (value !== undefined) return { done: false, value }
        if (this.closed) return { done: true, value: undefined }
        return await new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }) })
      },
      return: async (): Promise<IteratorResult<unknown>> => {
        this.close()
        return { done: true, value: undefined }
      },
    }
  }
}

function makePort(options: {
  readonly trustedHostOrigin?: string | null
  readonly accountAvailable?: boolean
  readonly generation?: RemoteConnectionGeneration | undefined
} = {}) {
  let snapshot: RemoteConnectionGeneration | undefined = options.generation === undefined
    ? { id: 'generation-1' }
    : options.generation
  const generationListeners = new Set<() => void>()
  const generation = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = []
  const state: {
    view: unknown
    profile: unknown
    balance: unknown
    running: boolean
  } = {
    view: { ...ACCOUNT_VIEW, grantPayload: 'must not escape' },
    profile: {
      status: 'ready',
      value: { id: 'account-id', name: 'Account Name', contact: 'm***@example.com', avatarUrl: null, privateField: 'must not escape' },
    },
    balance: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '12.5000', privateField: 'must not escape' }],
      bonusWallets: [{ currency: 'CNY', balance: '3.0000000000000000' }],
    },
    running: false,
  }
  const stream = new AccountStream({ type: 'snapshot', state: state.view })
  const streams = [stream]
  let watchCalls = 0
  let account: RemoteAccountRemotes
  account = {
    getState: async function (this: unknown): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account, 'generated account methods keep their namespace receiver')
      calls.push({ method: 'getState', args: [] })
      return { ok: true, value: state.view }
    },
    getProfile: async function (this: unknown, client): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account)
      calls.push({ method: 'getProfile', args: [client] })
      return { ok: true, value: state.profile }
    },
    getBalance: async function (this: unknown, client): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account)
      calls.push({ method: 'getBalance', args: [client] })
      return { ok: true, value: state.balance }
    },
    startSignIn: async function (this: unknown, client, callbackOrigin, loginSource): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account)
      calls.push({ method: 'startSignIn', args: [client, callbackOrigin, loginSource] })
      return { ok: true, value: state.view }
    },
    cancelSignIn: async function (this: unknown, attemptId): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account)
      calls.push({ method: 'cancelSignIn', args: [attemptId] })
      return { ok: true, value: state.view }
    },
    signOut: async function (this: unknown, client): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account)
      calls.push({ method: 'signOut', args: [client] })
      return { ok: true, value: state.view }
    },
    hasRunningAccountTasks: async function (this: unknown): Promise<RemoteResultLike<unknown>> {
      assert.equal(this, account)
      calls.push({ method: 'hasRunningAccountTasks', args: [] })
      return { ok: true, value: state.running }
    },
    watch: function (this: unknown): RemoteAccountStreamHandle<unknown> {
      assert.equal(this, account)
      calls.push({ method: 'watch', args: [] })
      watchCalls += 1
      if (watchCalls === 1) return stream
      const next = new AccountStream({ type: 'snapshot', state: state.view })
      streams.push(next)
      return next
    },
  }

  const remote = {
    settings: {
      describe: async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } }),
      update: async () => ({ ok: true as const, value: {} }),
      replace: async () => ({ ok: true as const, value: {} }),
      mutate: async () => ({ ok: true as const, value: {} }),
    },
    credentials: {
      describe: async () => ({ ok: true as const, value: {} }),
      set: async () => ({ ok: true as const, value: undefined }),
      unset: async () => ({ ok: true as const, value: undefined }),
    },
    commands: { execute: async () => ({ ok: false as const, error: { code: 'unused', message: 'unused' } }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    $on: (_event: string, _listener: (...args: unknown[]) => void) => () => {},
  }
  let accountGetterCalls = 0
  Object.defineProperty(remote, 'account', {
    enumerable: false,
    get(this: unknown) {
      assert.equal(this, remote, 'the root ClientRemote identity is preserved')
      accountGetterCalls += 1
      return options.accountAvailable === false ? undefined : account
    },
  })
  const trustedHostOrigin = options.trustedHostOrigin === null
    ? undefined
    : options.trustedHostOrigin ?? HOST_ORIGIN
  const port = new RemoteConfigPort({
    remote,
    connection: { generation },
    ...(trustedHostOrigin === undefined ? {} : { trustedHostOrigin }),
  } as unknown as RemoteConfigRuntimeSource)
  return {
    port,
    account,
    calls,
    state,
    streams,
    get currentGeneration() { return snapshot },
    get accountGetterCalls() { return accountGetterCalls },
    get activeGenerationListeners() { return generationListeners.size },
    setGeneration(value: RemoteConnectionGeneration | undefined) {
      snapshot = value
      for (const listener of [...generationListeners]) listener()
    },
  }
}

const metadata = { version: '0.5.6', locale: 'zh-HK', timezoneOffsetSeconds: 28_800 }

test('the Remote Account adapter detaches only safe state, profile, and balance facts', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  const observation = await harness.port.account.getState()
  assert.deepEqual(observation.view, ACCOUNT_VIEW)
  assert.notEqual(observation.view, harness.state.view)
  assert.equal(harness.port.account.isObservationCurrent(observation.lease), true)
  assert.equal('grantPayload' in observation.view, false)
  assert.equal('privateField' in observation.view.links, false)

  const profile = await harness.port.account.getProfile(metadata, observation.lease)
  assert.deepEqual(profile, {
    status: 'ready',
    value: { id: 'account-id', name: 'Account Name', contact: 'm***@example.com', avatarUrl: null },
  })
  const originalProfile = (harness.state.profile as { readonly value: unknown }).value
  assert.notEqual(profile?.status === 'ready' ? profile.value : undefined, originalProfile)
  const balance = await harness.port.account.getBalance(metadata, observation.lease)
  assert.deepEqual(balance, {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.5000' }],
    bonusWallets: [{ currency: 'CNY', balance: '3.0000000000000000' }],
  })
  assert.deepEqual(harness.calls.map(call => call.method), ['getState', 'getProfile', 'getBalance'])
  assert.deepEqual(harness.calls[1]?.args, [metadata])
  assert.notEqual(harness.calls[1]?.args[0], metadata, 'metadata is copied per operation')
  assert.deepEqual(harness.calls[2]?.args, [metadata])
  assert.equal(harness.accountGetterCalls, 1, 'the account namespace is read once from the original remote object')
})

test('null, failed, and RPC error account query outcomes remain distinct', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  let profileCalls = 0
  let balanceCalls = 0
  const observation = await harness.port.account.getState()
  harness.account.getProfile = async () => {
    profileCalls += 1
    return { ok: true, value: null }
  }
  harness.account.getBalance = async () => {
    balanceCalls += 1
    return { ok: true, value: { status: 'failed' } }
  }
  assert.equal(await harness.port.account.getProfile(metadata, observation.lease), null)
  assert.deepEqual(await harness.port.account.getBalance(metadata, observation.lease), { status: 'failed' })
  harness.account.getState = async () => ({ ok: false, error: { code: 'account/read-denied', message: 'the Host refused the read' } })
  await assert.rejects(harness.port.account.getState(), /the Host refused the read/u)
  assert.equal(profileCalls, 1)
  assert.equal(balanceCalls, 1)
})

test('callback origin is the canonical verified Host listener and SignIn fixes the web source', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  assert.equal(harness.port.account.available(), true)
  assert.equal(harness.port.account.getCallbackOrigin(), HOST_ORIGIN)
  const current = await harness.port.account.getState()
  const before = harness.calls.length
  const started = await harness.port.account.startSignIn(metadata, current.lease)
  assert.deepEqual(started.view, ACCOUNT_VIEW)
  assert.deepEqual(harness.calls.at(-1), {
    method: 'startSignIn',
    args: [metadata, HOST_ORIGIN, 'web'],
  })
  assert.equal(harness.calls.length, before + 1, 'SignIn dispatches once')

  for (const origin of [
    null,
    'http://localhost:43121',
    'http://127.0.0.1:043121',
    'http://127.0.0.1:43121/path',
    'http://127.0.0.1:65536',
    'https://127.0.0.1:43121',
  ] as const) {
    const invalid = makePort({ trustedHostOrigin: origin })
    try {
      assert.equal(invalid.port.account.available(), true, 'read-only account availability does not depend on callback capability')
      assert.equal(invalid.port.account.getCallbackOrigin(), undefined)
      const observation = await invalid.port.account.getState()
      await assert.rejects(invalid.port.account.startSignIn(metadata, observation.lease), /callback listener is unavailable/u)
      assert.equal(invalid.calls.some(call => call.method === 'startSignIn'), false,
        `non-canonical origin ${String(origin)} must be refused before dispatch`)
    } finally {
      invalid.port.dispose()
    }
  }
})

test('an Account result from an older Connection generation cannot commit', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  let rpcCalls = 0
  let release!: (result: RemoteResultLike<unknown>) => void
  harness.account.getProfile = async () => {
    rpcCalls += 1
    return await new Promise(resolve => { release = resolve })
  }
  const current = await harness.port.account.getState()
  const read = harness.port.account.getProfile(metadata, current.lease)
  await new Promise<void>(resolve => setImmediate(resolve))
  harness.setGeneration({ id: 'generation-2' })
  release({ ok: true, value: { status: 'ready', value: { id: 'old-host', name: 'Old', contact: null } } })
  await assert.rejects(read, error => error instanceof Error && error.name === 'SupersededReadError')
  assert.equal(rpcCalls, 1, 'the stale generated RPC is not replayed')
})

test('a captured Remote Account observation is stale immediately when its Connection generation changes', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  const old = await harness.port.account.getState()
  assert.equal(harness.port.account.isObservationCurrent(old.lease), true)
  harness.setGeneration(undefined)
  assert.equal(harness.port.account.isObservationCurrent(old.lease), false,
    'disconnect invalidates the old observation before an Account watch frame can arrive')
  const beforeStaleCancel = harness.calls.filter(call => call.method === 'cancelSignIn').length
  await assert.rejects(harness.port.account.cancelSignIn('attempt-exact', old.lease), /no current Host observation/u)
  assert.equal(harness.calls.filter(call => call.method === 'cancelSignIn').length, beforeStaleCancel,
    'the stale exact-attempt Cancel never reaches the generated namespace')
  harness.setGeneration({ id: 'generation-2' })
  assert.equal(harness.port.account.isObservationCurrent(old.lease), false,
    'a new authenticated generation never revives an old Account lease')
  const fresh = await harness.port.account.getState()
  assert.equal(harness.port.account.isObservationCurrent(fresh.lease), true)
  assert.equal(harness.port.account.isObservationCurrent(old.lease), false)
})

test('cancel, sign-out, and running-task reads use one official Account namespace call', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  harness.state.running = true
  const observation = await harness.port.account.getState()
  assert.equal(await harness.port.account.hasRunningAccountTasks(observation.lease), true)
  assert.deepEqual((await harness.port.account.cancelSignIn('attempt-exact', observation.lease)).view, ACCOUNT_VIEW)
  assert.deepEqual((await harness.port.account.signOut(metadata, observation.lease)).view, ACCOUNT_VIEW)
  assert.deepEqual(harness.calls.map(call => call.method), [
    'getState', 'hasRunningAccountTasks', 'cancelSignIn', 'signOut',
  ])
  assert.deepEqual(harness.calls[2]?.args, ['attempt-exact'], 'attempt identity is passed byte-for-byte')
  assert.notEqual(harness.calls[3]?.args[0], metadata)

  let failedTaskCalls = 0
  harness.account.hasRunningAccountTasks = async () => {
    failedTaskCalls += 1
    return {
      ok: false,
      error: { code: 'gateway/internal', message: 'Host task query failed' },
    }
  }
  await assert.rejects(harness.port.account.hasRunningAccountTasks(observation.lease), /Host task query failed/u)
  assert.equal(failedTaskCalls, 1, 'the error is rejected rather than converted to false or retried')
})

test('watch supplies its initial snapshot and releases only its own stream once', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  const controller = new AbortController()
  const iterator = harness.port.account.watch(controller.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value?.kind, 'current')
  if (first.value?.kind !== 'current') assert.fail('the official initial watch result must be a current Account observation')
  assert.deepEqual(first.value.observation.view, ACCOUNT_VIEW)
  assert.equal(harness.port.account.isObservationCurrent(first.value.observation.lease), true)
  const lease = first.value.observation.lease
  // rc.2 `account/watch` frames are `{type, state}`: a `credentials-changed`
  // frame is a fresh Host snapshot (not a sign-out), and its `state` is what
  // the Client may surface.
  const changedView = { status: 'credential-stored', links: ACCOUNT_VIEW.links, attempt: null }
  harness.streams[0]!.push({ type: 'credentials-changed', state: changedView })
  const changed = await iterator.next()
  if (changed.value?.kind !== 'current') assert.fail('a credentials-changed frame must surface a current observation')
  assert.deepEqual(changed.value.observation.view, changedView)
  assert.equal(harness.port.account.isObservationCurrent(changed.value.observation.lease), true)
  controller.abort()
  const ended = await iterator.next()
  assert.equal(ended.done, true)
  assert.equal(harness.port.account.isObservationCurrent(changed.value.observation.lease), false)
  assert.equal(harness.streams[0]?.disposeCalls, 1)
  harness.port.dispose()
  assert.equal(harness.streams[0]?.disposeCalls, 1, 'port disposal does not release the same watch twice')
})

test('a carrier failure on the current generation waits for and consumes the replacement Host baseline', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  const controller = new AbortController()
  const iterator = harness.port.account.watch(controller.signal)[Symbol.asyncIterator]()
  const initial = await iterator.next()
  if (initial.value?.kind !== 'current') assert.fail('the official initial watch result must be current')
  const oldLease = initial.value.observation.lease
  const generationOne = harness.streams[0]!
  assert.equal(harness.currentGeneration?.id, 'generation-1')
  const listenersBeforeFailure = harness.activeGenerationListeners
  const oldStreamNext = iterator.next()
  await new Promise<void>(resolve => setImmediate(resolve))
  generationOne.carrierFailed()
  const invalidated = await oldStreamNext
  assert.deepEqual(invalidated.value, { kind: 'invalidated', reason: 'watch-failed' })
  assert.equal(harness.port.account.isObservationCurrent(oldLease), false,
    'carrier failure invalidates same-generation Account observations immediately')
  const replacementBaseline = iterator.next()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(harness.activeGenerationListeners, listenersBeforeFailure + 1,
    'carrier failure on the still-current generation subscribes for its replacement')
  harness.setGeneration(undefined)
  harness.setGeneration({ id: 'generation-2' })
  const reopened = {
    status: 'signed-out',
    links: ACCOUNT_VIEW.links,
    attempt: null,
  }
  harness.state.view = reopened
  const replacement = await replacementBaseline
  if (replacement.value?.kind !== 'current') assert.fail('replacement generation must provide a complete current baseline')
  assert.deepEqual(replacement.value.observation.view, reopened,
    'the same page watch consumes the new Host initial snapshot')
  assert.equal(harness.port.account.isObservationCurrent(replacement.value.observation.lease), true)
  assert.equal(harness.streams.length, 2, 'one new generated handle opens after Connection replacement')
  assert.equal(harness.streams[0]?.disposeCalls, 1, 'the previous generation handle is retired exactly once')
  controller.abort()
  assert.equal((await iterator.next()).done, true)
  assert.equal(harness.streams[1]?.disposeCalls, 1, 'page close disposes the replacement handle exactly once')
})

test('Remote watch invalidates immediately on Connection generation change before any carrier frame', async t => {
  const harness = makePort()
  t.after(() => harness.port.dispose())
  const controller = new AbortController()
  const iterator = harness.port.account.watch(controller.signal)[Symbol.asyncIterator]()
  const initial = await iterator.next()
  if (initial.value?.kind !== 'current') assert.fail('Remote watch must begin with a complete current Host snapshot')
  const oldLease = initial.value.observation.lease
  assert.equal(harness.port.account.isObservationCurrent(oldLease), true)

  const invalidationRead = iterator.next()
  harness.setGeneration(undefined)
  const invalidated = await invalidationRead
  assert.deepEqual(invalidated.value, { kind: 'invalidated', reason: 'connection-changed' },
    'generation loss alone wakes the logical Account watch without waiting for RemoteStreamCarrierError')
  assert.equal(harness.port.account.isObservationCurrent(oldLease), false,
    'the old generation lease is revoked before the replacement generation exists')
  const replacementBaseline = iterator.next()
  assert.equal(harness.streams[0]?.disposeCalls, 1, 'the old generation StreamHandle is retired exactly once')
  harness.setGeneration({ id: 'generation-2' })
  const reopened = { status: 'signed-out', links: ACCOUNT_VIEW.links, attempt: null }
  harness.state.view = reopened
  const replacement = await replacementBaseline
  if (replacement.value?.kind !== 'current') assert.fail('the replacement Connection must publish a complete Host baseline')
  assert.deepEqual(replacement.value.observation.view, reopened)
  assert.equal(harness.port.account.isObservationCurrent(replacement.value.observation.lease), true)
  const ended = iterator.next()
  controller.abort()
  assert.equal((await ended).done, true)
})

test('ConfigPort disposal cancels a logical Account watch waiting for a replacement generation', async t => {
  const harness = makePort()
  const controller = new AbortController()
  const iterator = harness.port.account.watch(controller.signal)[Symbol.asyncIterator]()
  const initial = await iterator.next()
  if (initial.value?.kind !== 'current') assert.fail('the official initial watch result must be current')
  const oldLease = initial.value.observation.lease
  const oldHandle = harness.streams[0]!
  harness.setGeneration(undefined)
  const invalidated = iterator.next()
  oldHandle.carrierFailed()
  assert.deepEqual((await invalidated).value, { kind: 'invalidated', reason: 'connection-changed' })
  assert.equal(harness.port.account.isObservationCurrent(oldLease), false)
  const pending = iterator.next()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(harness.activeGenerationListeners > 0, 'the live logical watch owns a reconnect listener')
  harness.port.dispose()
  assert.equal((await pending).done, true, 'adapter disposal terminates the outer watch iterator')
  assert.equal(harness.activeGenerationListeners, 0, 'adapter disposal releases its Connection generation subscription')
  assert.equal(oldHandle.disposeCalls, 1, 'the old generated stream handle is released once')
})

test('missing Account namespace or Connection generation is unavailable, never signed out', async t => {
  const missing = makePort({ accountAvailable: false, trustedHostOrigin: null })
  t.after(() => missing.port.dispose())
  assert.equal(missing.port.account.available(), false)
  assert.equal(missing.port.account.getCallbackOrigin(), undefined)
  await assert.rejects(missing.port.account.getState(), /namespace is unavailable/u)

  const disconnected = makePort()
  t.after(() => disconnected.port.dispose())
  disconnected.setGeneration(undefined)
  assert.equal(disconnected.port.account.available(), false)
  assert.equal(disconnected.port.account.getCallbackOrigin(), undefined)
  await assert.rejects(disconnected.port.account.getState(), /while disconnected/u)
})
