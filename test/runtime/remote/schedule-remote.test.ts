/**
 * S5-PR4 L3: the Remote Host Schedule adapter.
 *
 * The adapter is a generation-fenced view of the ONE official generated
 * `schedule` Client namespace: a read from a superseded Connection generation
 * is never presented as the current Host state, and a MUTATION that was
 * dispatched but can no longer be proven is an unknown outcome — it is never
 * replayed and never reported as a rollback.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSchedulePort,
  type RemoteScheduleEvents,
  type RemoteScheduleNamespace,
} from '../../../src/runtime/remote/schedule-remote.ts'
import {
  ScheduleOutcomeUnknownError,
  ScheduleUnavailableError,
  type ScheduleCatalogEntry,
  type ScheduleDeliveryHistoryResult,
  type ScheduleEditResult,
  type ScheduleListResult,
  type ScheduleRunResult,
  type ScheduleViewResult,
} from '../../../src/runtime/schedule-port.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from '../../../src/runtime/remote/session-reader-remote.ts'

const ENTRY: ScheduleCatalogEntry = {
  id: 'schedule-1' as ScheduleCatalogEntry['id'],
  kind: 'cron',
  title: 'Cron',
  prompt: 'Prompt',
  expression: '0 17 * * 1-5',
  timeZone: 'UTC',
  scheduledAt: '2026-01-01T17:00:00.000Z',
  target: { kind: 'session', sessionId: 'session-1' as never },
  involvedSessionIds: [],
  status: 'active',
  updatedAt: '2026-01-01T08:00:00.000Z',
}

const LIST: ScheduleListResult = { items: [ENTRY], shown: 1, total: 1, limit: 100, offset: 0 }
const VIEW: ScheduleViewResult = ENTRY
const HISTORY: ScheduleDeliveryHistoryResult = {
  id: ENTRY.id,
  records: [],
  earlierRecordsUnavailable: true,
  earlierRecordsPruned: false,
  retention: { days: 30, records: 200 },
}
const EDIT: ScheduleEditResult = { ...ENTRY, title: 'Renamed' }
const RUN: ScheduleRunResult = ENTRY

let generationSequence = 0

class FakeGeneration implements RemoteConnectionGenerationSource {
  current: RemoteConnectionGeneration | undefined = { id: ++generationSequence }
  readonly listeners = new Set<() => void>()

  getSnapshot(): RemoteConnectionGeneration | undefined {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replace(): void {
    this.current = { id: ++generationSequence }
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeNamespace implements RemoteScheduleNamespace {
  readonly calls: string[] = []
  readonly signals: Array<AbortSignal | undefined> = []
  catalogImpl: () => Promise<{ ok: true; value: readonly ScheduleCatalogEntry[] } | { ok: false; error: unknown }> =
    async () => ({ ok: true, value: [ENTRY] })
  createImpl: () => Promise<{ ok: true; value: ScheduleCatalogEntry } | { ok: false; error: unknown }> =
    async () => ({ ok: true, value: ENTRY })

  catalog(): ReturnType<RemoteScheduleNamespace['catalog']> {
    this.calls.push('catalog')
    return this.catalogImpl() as ReturnType<RemoteScheduleNamespace['catalog']>
  }

  create(_request: unknown, signal?: AbortSignal): ReturnType<RemoteScheduleNamespace['create']> {
    this.calls.push('create')
    this.signals.push(signal)
    return this.createImpl() as ReturnType<RemoteScheduleNamespace['create']>
  }

  deleteInactive(): ReturnType<RemoteScheduleNamespace['deleteInactive']> {
    this.calls.push('deleteInactive')
    return Promise.resolve({ ok: true, value: { deleted: 2 } })
  }

  deliveryLimits(): ReturnType<RemoteScheduleNamespace['deliveryLimits']> {
    this.calls.push('deliveryLimits')
    return Promise.resolve({ ok: true, value: { newSessionIntervalSeconds: 60 } })
  }

  edit(): ReturnType<RemoteScheduleNamespace['edit']> {
    this.calls.push('edit')
    return Promise.resolve({ ok: true, value: EDIT })
  }

  history(): ReturnType<RemoteScheduleNamespace['history']> {
    this.calls.push('history')
    return Promise.resolve({ ok: true, value: HISTORY })
  }

  list(): ReturnType<RemoteScheduleNamespace['list']> {
    this.calls.push('list')
    return Promise.resolve({ ok: true, value: LIST })
  }

  run(): ReturnType<RemoteScheduleNamespace['run']> {
    this.calls.push('run')
    return Promise.resolve({ ok: true, value: RUN })
  }

  view(): ReturnType<RemoteScheduleNamespace['view']> {
    this.calls.push('view')
    return Promise.resolve({ ok: true, value: VIEW })
  }
}

class FakeEvents implements RemoteScheduleEvents {
  readonly listeners = new Set<() => void>()
  readonly names: string[] = []

  $on(event: 'schedule/changed', listener: () => void): () => void {
    this.names.push(event)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

test('L3: every port method reaches the official generated namespace method', async () => {
  const namespace = new FakeNamespace()
  const port = new RemoteSchedulePort(namespace, new FakeEvents(), new FakeGeneration())
  assert.deepEqual(await port.catalog(), [ENTRY])
  assert.deepEqual(await port.list({ active: true }), LIST)
  assert.deepEqual(await port.view({ id: ENTRY.id }), VIEW)
  assert.deepEqual(await port.history({ id: ENTRY.id, limit: 20 }), HISTORY)
  assert.deepEqual(await port.deliveryLimits(), { newSessionIntervalSeconds: 60 })
  assert.deepEqual(await port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } }), ENTRY)
  assert.deepEqual(await port.edit({ id: ENTRY.id, action: 'update', patch: { title: 'Renamed' } }), EDIT)
  assert.deepEqual(await port.run({ id: ENTRY.id }), RUN)
  assert.deepEqual(await port.deleteInactive(), { deleted: 2 })
  assert.deepEqual(
    namespace.calls,
    ['catalog', 'list', 'view', 'history', 'deliveryLimits', 'create', 'edit', 'run', 'deleteInactive'],
  )
})

test('L3: no namespace or no authenticated Connection generation is the truthful unavailable', async () => {
  const disconnected = new FakeGeneration()
  disconnected.current = undefined
  await assert.rejects(
    new RemoteSchedulePort(undefined, new FakeEvents(), new FakeGeneration()).catalog(),
    (error: unknown) => error instanceof ScheduleUnavailableError,
  )
  await assert.rejects(
    new RemoteSchedulePort(new FakeNamespace(), new FakeEvents(), disconnected).catalog(),
    (error: unknown) => error instanceof ScheduleUnavailableError,
  )
})

test('L3: a read settled in a superseded generation is superseded, never the current state', async () => {
  const namespace = new FakeNamespace()
  const generation = new FakeGeneration()
  let release!: (value: { ok: true; value: readonly ScheduleCatalogEntry[] }) => void
  namespace.catalogImpl = () => new Promise(resolve => { release = resolve })
  const port = new RemoteSchedulePort(namespace, new FakeEvents(), generation)
  const pending = port.catalog()
  generation.replace()
  release({ ok: true, value: [ENTRY] })
  await assert.rejects(pending, (error: unknown) => error instanceof SupersededReadError)
})

test('L3: a dispatched mutation with an unprovable outcome is unknown and is NEVER replayed', async () => {
  const namespace = new FakeNamespace()
  namespace.createImpl = async () => { throw new Error('socket closed') }
  const port = new RemoteSchedulePort(namespace, new FakeEvents(), new FakeGeneration())
  await assert.rejects(
    port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } }),
    (error: unknown) => error instanceof ScheduleOutcomeUnknownError,
  )
  assert.deepEqual(namespace.calls, ['create'], 'the write is never retried')
})

test('L3: a mutation settling after a generation replacement is unknown, not success', async () => {
  const namespace = new FakeNamespace()
  const generation = new FakeGeneration()
  let release!: (value: { ok: true; value: ScheduleCatalogEntry }) => void
  namespace.createImpl = () => new Promise(resolve => { release = resolve })
  const port = new RemoteSchedulePort(namespace, new FakeEvents(), generation)
  const pending = port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } })
  generation.replace()
  release({ ok: true, value: ENTRY })
  await assert.rejects(pending, (error: unknown) => error instanceof ScheduleOutcomeUnknownError)
  assert.equal(namespace.calls.length, 1)
})

test('L3: an official refusal keeps its own code and details (never an unknown outcome)', async () => {
  const namespace = new FakeNamespace()
  const refusal = { code: 'schedule/input-invalid', message: 'not in the future', details: { code: 'not_future' } }
  namespace.createImpl = async () => ({ ok: false, error: refusal })
  const port = new RemoteSchedulePort(namespace, new FakeEvents(), new FakeGeneration())
  await assert.rejects(
    port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } }),
    (error: unknown) => error === refusal,
  )
})

test('L3: onChanged covers the Host commit AND a Connection replacement; dispose unsubscribes both', () => {
  const events = new FakeEvents()
  const generation = new FakeGeneration()
  const port = new RemoteSchedulePort(new FakeNamespace(), events, generation)
  let count = 0
  const unsubscribe = port.onChanged(() => { count += 1 })
  events.emit()
  generation.replace()
  assert.equal(count, 2)
  assert.deepEqual(events.names, ['schedule/changed'])
  unsubscribe()
  events.emit()
  generation.replace()
  assert.equal(count, 2, 'the unsubscribe removes both subscriptions')
  assert.equal(events.listeners.size, 0)
  assert.equal(generation.listeners.size, 0)
})
