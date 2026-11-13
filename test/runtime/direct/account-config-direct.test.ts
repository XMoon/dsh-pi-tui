import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectAccountConfig, type HostContextLike } from '../../../src/runtime/direct/config-direct.ts'

function directAccount(agents: { list(): readonly unknown[] } | undefined): DirectAccountConfig {
  const context: HostContextLike = {
    get: name => name === 'agents'
      ? agents
      : name === 'deepseekAccount'
        ? { getState: async () => ({ status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }) }
        : undefined,
  }
  return new DirectAccountConfig(context)
}

test('Direct running-account-task reads follow the live Host Agent predicate without caching', async () => {
  const request = { provider: 'deepseek-account' }
  const running = { status: 'running', session: { requestContext: () => request } }
  const idle = { status: 'idle', session: { requestContext: () => request } }
  const otherProvider = { status: 'running', session: { requestContext: () => ({ provider: 'other' }) } }
  const rows: unknown[] = [idle, otherProvider]
  const adapter = directAccount({ list: () => rows })

  let observation = await adapter.getState()
  const first = adapter.hasRunningAccountTasks(observation.lease)
  assert.ok(first instanceof Promise, 'the Direct semantic port is asynchronous')
  assert.equal(await first, false)
  rows.push(running)
  observation = await adapter.getState()
  assert.equal(await adapter.hasRunningAccountTasks(observation.lease), true)
  rows.splice(rows.indexOf(running), 1)
  observation = await adapter.getState()
  assert.equal(await adapter.hasRunningAccountTasks(observation.lease), false, 'each query reads the current Host list')
})

test('Direct Watch failure revokes read and watch leases before any later mutation dispatch', async () => {
  const state = { status: 'signed-out' as const, links: { usageUrl: '', topUpUrl: '' }, attempt: null }
  let rejectWatch!: (error: Error) => void
  let signalWatchReady!: () => void
  const watchReady = new Promise<void>(resolve => { signalWatchReady = resolve })
  let signInCalls = 0
  const account = {
    getState: async () => state,
    getProfile: async () => null,
    getBalance: async () => null,
    watch: async function* (signal: AbortSignal) {
      yield { type: 'snapshot', state }
      await new Promise<void>((_resolve, reject) => {
        rejectWatch = reject
        signalWatchReady()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    startSignIn: async () => { signInCalls += 1; return state },
    cancelSignIn: async () => state,
    signOut: async () => state,
  }
  const adapter = new DirectAccountConfig({
    get: name => name === 'deepseekAccount' ? account : name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:43121' } : undefined,
  })
  const read = await adapter.getState()
  const controller = new AbortController()
  const iterator = adapter.watch(controller.signal)[Symbol.asyncIterator]()
  const initial = await iterator.next()
  assert.equal(initial.value?.kind, 'current')
  if (initial.value?.kind !== 'current') assert.fail('Direct Host Watch must publish its complete current initial observation')
  assert.equal(adapter.isObservationCurrent(read.lease), true)
  assert.equal(adapter.isObservationCurrent(initial.value.observation.lease), true)
  const failedNext = iterator.next()
  await watchReady
  rejectWatch(new Error('Host watch failed'))
  assert.deepEqual((await failedNext).value, { kind: 'invalidated', reason: 'watch-failed' })
  assert.equal(adapter.isObservationCurrent(read.lease), false,
    'terminal Watch failure revokes an earlier Direct getState lease')
  assert.equal(adapter.isObservationCurrent(initial.value.observation.lease), false,
    'terminal Watch failure revokes the current Watch lease')
  await assert.rejects(adapter.startSignIn({ version: 'test', locale: 'en-US', timezoneOffsetSeconds: 0 }, initial.value.observation.lease), /current Host observation/u)
  assert.equal(signInCalls, 0, 'an invalid Direct lease cannot reach the official Host mutation')
  const ended = iterator.next()
  controller.abort()
  assert.equal((await ended).done, true)
})

test('a replaced Direct Host Account service immediately invalidates its previous observation', async () => {
  const view = { status: 'signed-out' as const, links: { usageUrl: '', topUpUrl: '' }, attempt: null }
  let startCalls = 0
  let watchPendingResolve!: () => void
  const watchPending = new Promise<void>(resolve => { watchPendingResolve = resolve })
  const makeHostAccount = () => ({
    getState: async () => view,
    watch: async function* (signal: AbortSignal) {
      yield { type: 'snapshot', state: view }
      await new Promise<void>(resolve => {
        watchPendingResolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    startSignIn: async () => { startCalls += 1; return view },
  })
  let installed = makeHostAccount()
  let serviceChanged!: (name: string, value: unknown) => void
  const adapter = new DirectAccountConfig({
    get: name => name === 'deepseekAccount' ? installed : name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:43121' } : undefined,
    on: ((event: string, listener: (name: string, value: unknown) => void) => {
      assert.equal(event, 'internal/service')
      serviceChanged = listener
      return () => true
    }) as HostContextLike['on'],
  })
  const old = await adapter.getState()
  assert.equal(adapter.isObservationCurrent(old.lease), true)
  const controller = new AbortController()
  const iterator = adapter.watch(controller.signal)[Symbol.asyncIterator]()
  const initial = await iterator.next()
  if (initial.value?.kind !== 'current') assert.fail('Direct Account watch must start with a current Host snapshot')
  const watchLease = initial.value.observation.lease
  const waiting = iterator.next()
  await watchPending
  installed = makeHostAccount()
  serviceChanged('deepseekAccount', installed)
  assert.equal(adapter.available(), true, 'the namespace still exists after the service owner changes')
  assert.equal(adapter.isObservationCurrent(old.lease), false)
  assert.equal(adapter.isObservationCurrent(watchLease), false)
  assert.deepEqual((await waiting).value, { kind: 'invalidated', reason: 'service-changed' },
    'the active Direct watch is invalidated immediately while its old Host iterator is pending')
  await assert.rejects(adapter.startSignIn({ version: 'test', locale: 'en-US', timezoneOffsetSeconds: 0 }, old.lease), /current Host observation/u)
  assert.equal(startCalls, 0, 'the replacement service receives no mutation from the old lease')
  const ended = iterator.next()
  controller.abort()
  assert.equal((await ended).done, true)
})

test('a missing Direct Host Agent authority rejects instead of claiming no running account tasks', async () => {
  const adapter = directAccount(undefined)
  const observation = await adapter.getState()
  await assert.rejects(adapter.hasRunningAccountTasks(observation.lease), /Host Agent service unavailable/u)
})

test('Direct Watch unwraps the rc.2 AccountUpdate envelope for both frame types', async () => {
  const signedOut = { status: 'signed-out' as const, links: { usageUrl: '', topUpUrl: '' }, attempt: null }
  const stored = {
    status: 'credential-stored' as const,
    links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' },
    attempt: null,
  }
  const account = {
    getState: async () => signedOut,
    watch: async function* (signal: AbortSignal) {
      yield { type: 'snapshot', state: signedOut }
      yield { type: 'credentials-changed', state: stored }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  }
  const adapter = new DirectAccountConfig({ get: name => name === 'deepseekAccount' ? account : undefined })
  const controller = new AbortController()
  const iterator = adapter.watch(controller.signal)[Symbol.asyncIterator]()
  const initial = await iterator.next()
  if (initial.value?.kind !== 'current') assert.fail('the snapshot frame must surface its current Host state')
  assert.deepEqual(initial.value.observation.view, signedOut)
  const changed = await iterator.next()
  if (changed.value?.kind !== 'current') assert.fail('a credentials-changed frame must surface its current Host state')
  assert.deepEqual(changed.value.observation.view, stored,
    'a credentials-changed frame is a fresh snapshot, not a sign-out')
  assert.equal(adapter.isObservationCurrent(changed.value.observation.lease), true)
  const ended = iterator.next()
  controller.abort()
  assert.equal((await ended).done, true)
})

test('Direct Watch rejects a non-envelope frame instead of surfacing undefined state', async () => {
  const bareView = { status: 'signed-out' as const, links: { usageUrl: '', topUpUrl: '' }, attempt: null }
  const account = {
    getState: async () => bareView,
    watch: async function* () {
      // The rc.1 bare-`AccountView` payload is NOT the rc.2 wire shape: the
      // adapter must fail closed (invalidated), never show an empty state.
      yield bareView as never
    },
  }
  const adapter = new DirectAccountConfig({ get: name => name === 'deepseekAccount' ? account : undefined })
  const controller = new AbortController()
  const iterator = adapter.watch(controller.signal)[Symbol.asyncIterator]()
  assert.deepEqual((await iterator.next()).value, { kind: 'invalidated', reason: 'watch-failed' })
  controller.abort()
  assert.equal((await iterator.next()).done, true)
})
