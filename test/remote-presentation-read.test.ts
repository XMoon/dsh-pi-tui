import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemotePresentationReader,
  type RemotePresentationBinding,
  type RemotePresentationEventEntry,
  type RemotePresentationSessionsSource,
} from '../src/runtime/remote/presentation-read-remote.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'

function constructOfficialReader(sessions: ISessions, generation: ConnectionGenerationState): RemotePresentationReader {
  return new RemotePresentationReader(sessions, generation)
}

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  return {
    source: { getSnapshot: () => current, subscribe: () => () => {} },
    set(value) { current = value },
  }
}

function durable(seq: number, type = 'turn/start', data: Record<string, unknown> = { turn: seq }): RemotePresentationEventEntry {
  return {
    type: 'event',
    event: { type, seq, time: 1_700_000_000_000 + seq, data },
  }
}

function live(
  attemptId: string,
  turn: number,
  step: number,
  time: number,
  text: string,
): RemotePresentationEventEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      time,
      data: {
        attemptId,
        turn,
        step,
        chunk: { type: 'text-delta', index: 0, text },
      },
    },
  }
}

function harness(options: {
  entries?: readonly RemotePresentationEventEntry[]
  hasMore?: boolean
  openState?: 'cold' | 'loading' | 'open' | 'error'
  loadingOlder?: boolean
  loadOlder?: () => Promise<void>
} = {}): {
  readonly source: RemotePresentationSessionsSource
  readonly binding: RemotePresentationBinding
  setEntries(entries: readonly RemotePresentationEventEntry[]): void
  setHasMore(value: boolean): void
  setLoadingOlder(value: boolean): void
  loadCalls: number
} {
  let entries = options.entries ?? []
  let hasMore = options.hasMore ?? false
  let loadingOlder = options.loadingOlder ?? false
  let loadCalls = 0
  const binding: RemotePresentationBinding = {
    session: {
      getSnapshot: () => ({ openState: options.openState ?? 'open', loadingOlder }),
      async loadOlder() {
        loadCalls += 1
        await options.loadOlder?.()
      },
    },
    eventSource: {
      getSnapshot: () => ({ entries, hasMore, revision: entries.length }),
    },
  }
  return {
    source: { binding: id => id === 'session' ? binding : undefined },
    binding,
    setEntries(value) { entries = value },
    setHasMore(value) { hasMore = value },
    setLoadingOlder(value) { loadingOlder = value },
    get loadCalls() { return loadCalls },
  }
}

test('official Client Sessions and Connection faces satisfy the presentation adapter boundary', () => {
  assert.equal(typeof constructOfficialReader, 'function')
})

test('reconstructs one synthetic start per live tuple and keeps source entry order', async () => {
  const fixture = harness({
    entries: [
      durable(0),
      live('attempt-a', 0, 0, 10, 'one'),
      durable(1, 'user/message', { turn: 0, id: 'user' }),
      live('attempt-a', 0, 0, 11, 'two'),
      live('attempt-b', 0, 1, 12, 'retry'),
    ],
  })
  const reader = new RemotePresentationReader(fixture.source, generationHarness().source)

  const snapshot = await reader.read('session')
  assert.deepEqual(snapshot?.durableEvents.map(event => event.seq), [0, 1])
  assert.deepEqual(snapshot?.liveInputs.map(input => input.kind), ['start', 'chunk', 'chunk', 'start', 'chunk'])
  assert.deepEqual(snapshot?.orderedInputs.map(input => input.kind), ['durable', 'live', 'live', 'durable', 'live', 'live', 'live'])
  assert.equal(snapshot?.liveInputs.filter(input => input.kind === 'start').length, 2)
  assert.equal(snapshot?.liveInputs.some(input => input.kind === 'end'), false)
})

test('replace snapshots rebuild transient inputs and detach nested event data', async () => {
  const payload = { nested: { value: 1 } }
  const fixture = harness({ entries: [durable(0, 'custom/event', payload)] })
  const generations = generationHarness()
  const reader = new RemotePresentationReader(fixture.source, generations.source)
  const first = await reader.read('session')
  assert.ok(first)
  assert.equal(Object.hasOwn(first, 'binding'), false)
  assert.equal(Object.hasOwn(first, 'session'), false)
  payload.nested.value = 2
  assert.equal((first?.durableEvents[0]?.data as { nested: { value: number } }).nested.value, 1)
  assert.equal(Object.isFrozen((first?.durableEvents[0]?.data as { nested: object }).nested), true)

  fixture.setEntries([live('attempt-a', 0, 0, 10, 'fresh')])
  const active = await reader.read('session')
  assert.deepEqual(active?.liveInputs.map(input => input.kind), ['start', 'chunk'])

  // A replacement after upstream settlement has no transient row and must not
  // synthesize an attempt or an end notification.
  fixture.setEntries([durable(1, 'assistant/message', { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'done' }] } })])
  const settled = await reader.read('session')
  assert.deepEqual(settled?.liveInputs, [])
  assert.deepEqual(settled?.orderedInputs.map(input => input.kind), ['durable'])
})

test('pages history only through SessionFace.loadOlder and respects current flags', async () => {
  const fixture = harness({ entries: [durable(1)], hasMore: true })
  const generations = generationHarness()
  const reader = new RemotePresentationReader(fixture.source, generations.source)
  const first = await reader.read('session')
  assert.equal(first?.hasMore, true)
  fixture.setEntries([durable(0), durable(1)])
  const older = await reader.loadOlder('session')
  assert.equal(fixture.loadCalls, 1)
  assert.deepEqual(older?.durableEvents.map(event => event.seq), [0, 1])

  fixture.setHasMore(false)
  fixture.setEntries([durable(0), durable(1), durable(2)])
  await reader.loadOlder('session')
  assert.equal(fixture.loadCalls, 1)

  fixture.setHasMore(true)
  fixture.setLoadingOlder(true)
  await reader.loadOlder('session')
  assert.equal(fixture.loadCalls, 1)
})

test('discards stale or cancelled paging results after the official operation settles', async () => {
  const generations = generationHarness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fixture = harness({ entries: [durable(1)], hasMore: true, loadOlder: () => gate })
  const reader = new RemotePresentationReader(fixture.source, generations.source)
  const stale = reader.loadOlder('session')
  generations.set({ id: 2 })
  release()
  assert.equal(await stale, undefined)

  generations.set({ id: 3 })
  let cancelRelease!: () => void
  const cancelGate = new Promise<void>(resolve => { cancelRelease = resolve })
  const cancelledFixture = harness({ entries: [durable(1)], hasMore: true, loadOlder: () => cancelGate })
  const controller = new AbortController()
  const cancelled = new RemotePresentationReader(cancelledFixture.source, generations.source)
    .loadOlder('session', controller.signal)
  controller.abort()
  cancelRelease()
  await assert.rejects(cancelled, { name: 'AbortError' })
})

test('discards a late history-page failure after the generation changes', async () => {
  const generations = generationHarness()
  let rejectPage!: (error: unknown) => void
  const page = new Promise<void>((_resolve, reject) => { rejectPage = reject })
  const fixture = harness({ entries: [durable(1)], hasMore: true, loadOlder: () => page })
  const reader = new RemotePresentationReader(fixture.source, generations.source)
  const pending = reader.loadOlder('session')
  generations.set({ id: 2 })
  rejectPage(new Error('late history-page failure'))
  assert.equal(await pending, undefined)
})

test('returns unavailable for a missing binding or disconnected generation', async () => {
  const generations = generationHarness()
  const missing = new RemotePresentationReader({ binding: () => undefined }, generations.source)
  assert.equal(await missing.read('session'), undefined)

  generations.set(undefined)
  const fixture = harness()
  const disconnected = new RemotePresentationReader(fixture.source, generations.source)
  assert.equal(await disconnected.read('session'), undefined)
})
