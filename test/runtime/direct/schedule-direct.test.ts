/**
 * S5-PR4 L2: the Direct Host Schedule adapter.
 *
 * The adapter is a FORWARDING boundary over the one official in-process
 * `ctx.schedule` service: every call reaches the official method (the `remote*`
 * human forms for the validated methods), the caller's cancellation is
 * observed on both sides of a read and passed into the official write form, and
 * a Host that mounts no Schedule domain answers the one truthful unavailable
 * error instead of an empty catalog.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSchedulePort, type DirectScheduleHostContext } from '../../../src/runtime/direct/schedule-direct.ts'
import { ScheduleUnavailableError } from '../../../src/runtime/schedule-port.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryResult,
  ScheduleEditResult,
  ScheduleListResult,
  ScheduleRunResult,
  ScheduleViewResult,
} from '../../../src/runtime/schedule-port.ts'

const ENTRY: ScheduleCatalogEntry = {
  id: 'schedule-1' as ScheduleCatalogEntry['id'],
  kind: 'daily',
  title: 'Daily',
  prompt: 'Prompt',
  time: '09:00:00',
  timeZone: 'UTC',
  scheduledAt: '2026-01-01T09:00:00.000Z',
  target: { kind: 'new_once', sessionId: 'session-1' as never, create: {} },
  involvedSessionIds: [],
  status: 'active',
  updatedAt: '2026-01-01T08:00:00.000Z',
}

const LIST: ScheduleListResult = { items: [ENTRY], shown: 1, total: 1, limit: 100, offset: 0 }
const VIEW: ScheduleViewResult = ENTRY
const HISTORY: ScheduleDeliveryHistoryResult = {
  id: ENTRY.id,
  records: [{ scheduledAt: '2026-01-01T09:00:00.000Z', deliveredAt: '2026-01-01T09:00:00.100Z', messageId: 'message-1' as never, targetSessionId: 'session-1' as never, prompt: 'Prompt' }],
  earlierRecordsUnavailable: false,
  earlierRecordsPruned: false,
  retention: { days: 30, records: 200 },
}
const EDIT: ScheduleEditResult = { ...ENTRY, title: 'Renamed' }
const RUN: ScheduleRunResult = ENTRY
const DELETED = { id: ENTRY.id, deleted: true as const }

/** The official Host service fake: records the exact method each call reaches. */
class FakeHostSchedule {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = []
  readonly signals: Array<AbortSignal | undefined> = []
  catalogImpl: () => Promise<ScheduleCatalogEntry[]> = async () => [ENTRY]
  listImpl: () => Promise<ScheduleListResult> = async () => LIST
  viewImpl: () => Promise<ScheduleViewResult> = async () => VIEW
  historyImpl: () => Promise<ScheduleDeliveryHistoryResult> = async () => HISTORY
  createImpl: () => Promise<ScheduleCatalogEntry> = async () => ENTRY
  editImpl: () => Promise<ScheduleEditResult> = async () => EDIT
  runImpl: () => Promise<ScheduleRunResult> = async () => RUN
  deleteInactiveImpl: () => Promise<{ deleted: number }> = async () => ({ deleted: 1 })

  deliveryLimits(): { readonly newSessionIntervalSeconds: number } {
    this.calls.push({ method: 'deliveryLimits', args: [] })
    return { newSessionIntervalSeconds: 60 }
  }

  catalog(): Promise<ScheduleCatalogEntry[]> {
    this.calls.push({ method: 'catalog', args: [] })
    return this.catalogImpl()
  }

  remoteList(request: unknown): Promise<ScheduleListResult> {
    this.calls.push({ method: 'remoteList', args: [request] })
    return this.listImpl()
  }

  view(request: unknown): Promise<ScheduleViewResult> {
    this.calls.push({ method: 'view', args: [request] })
    return this.viewImpl()
  }

  remoteHistory(request: unknown): Promise<ScheduleDeliveryHistoryResult> {
    this.calls.push({ method: 'remoteHistory', args: [request] })
    return this.historyImpl()
  }

  remoteCreate(request: unknown, signal?: AbortSignal): Promise<ScheduleCatalogEntry> {
    this.calls.push({ method: 'remoteCreate', args: [request] })
    this.signals.push(signal)
    return this.createImpl()
  }

  remoteEdit(request: unknown, signal?: AbortSignal): Promise<ScheduleEditResult> {
    this.calls.push({ method: 'remoteEdit', args: [request] })
    this.signals.push(signal)
    return this.editImpl()
  }

  run(request: unknown, signal?: AbortSignal): Promise<ScheduleRunResult> {
    this.calls.push({ method: 'run', args: [request] })
    this.signals.push(signal)
    return this.runImpl()
  }

  deleteInactive(): Promise<{ deleted: number }> {
    this.calls.push({ method: 'deleteInactive', args: [] })
    return this.deleteInactiveImpl()
  }
}

class FakeContext implements DirectScheduleHostContext {
  readonly service: FakeHostSchedule | undefined
  readonly listeners = new Map<string, Set<() => void>>()

  constructor(service: FakeHostSchedule | undefined) {
    this.service = service
  }

  get(name: string): unknown {
    return name === 'schedule' ? this.service : undefined
  }

  on(event: 'schedule/changed', listener: () => void): () => boolean {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

test('L2: every port method forwards to the official Host method', async () => {
  const service = new FakeHostSchedule()
  const port = new DirectSchedulePort(new FakeContext(service))
  assert.deepEqual(await port.catalog(), [ENTRY])
  assert.deepEqual(await port.list({ active: true }), LIST)
  assert.deepEqual(await port.view({ id: ENTRY.id }), VIEW)
  const history = await port.history({ id: ENTRY.id, limit: 20 })
  assert.equal(history.id, HISTORY.id)
  assert.deepEqual(port.deliveryLimits && await port.deliveryLimits(), { newSessionIntervalSeconds: 60 })
  assert.deepEqual(await port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } }), ENTRY)
  assert.deepEqual(await port.edit({ id: ENTRY.id, action: 'update', patch: { title: 'Renamed' } }), EDIT)
  assert.deepEqual(await port.run({ id: ENTRY.id }), RUN)
  assert.deepEqual(await port.deleteInactive(), { deleted: 1 })
  assert.deepEqual(
    service.calls.map(call => call.method),
    ['catalog', 'remoteList', 'view', 'remoteHistory', 'deliveryLimits', 'remoteCreate', 'remoteEdit', 'run', 'deleteInactive'],
    'the human management surface uses the official remote* forms for the validated methods',
  )
})

test('L2: no Host Schedule service is the ONE truthful unavailable, never an empty catalog', async () => {
  const port = new DirectSchedulePort(new FakeContext(undefined))
  await assert.rejects(port.catalog(), (error: unknown) => error instanceof ScheduleUnavailableError)
  await assert.rejects(
    port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } }),
    (error: unknown) => error instanceof ScheduleUnavailableError,
  )
})

test('L2: a read is cancelled before it dispatches and never publishes after an abort', async () => {
  const service = new FakeHostSchedule()
  let release!: (entries: ScheduleCatalogEntry[]) => void
  service.catalogImpl = () => new Promise(resolve => { release = resolve })
  const port = new DirectSchedulePort(new FakeContext(service))

  const before = new AbortController()
  before.abort()
  await assert.rejects(port.catalog(before.signal), (error: unknown) => (error as Error).name === 'AbortError')
  assert.equal(service.calls.length, 0, 'an aborted read never reaches the Host')

  const during = new AbortController()
  const pending = port.catalog(during.signal)
  during.abort()
  release([ENTRY])
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError')
})

test('L2: a mutation passes the caller signal INTO the official Host form', async () => {
  const service = new FakeHostSchedule()
  const port = new DirectSchedulePort(new FakeContext(service))
  const controller = new AbortController()
  await port.create({ title: 'T', prompt: 'P', timing: { kind: 'after', after_seconds: 60 } }, controller.signal)
  await port.edit({ id: ENTRY.id, action: 'update', patch: { title: 'Renamed' } }, controller.signal)
  await port.run({ id: ENTRY.id }, controller.signal)
  assert.equal(service.signals.length, 3)
  assert.equal(service.signals.every(signal => signal === controller.signal), true)
})

test('L2: onChanged is exactly the official post-commit event and its unsubscribe', () => {
  const context = new FakeContext(new FakeHostSchedule())
  const port = new DirectSchedulePort(context)
  const seen: string[] = []
  const unsubscribe = port.onChanged(() => seen.push('changed'))
  context.emit('schedule/changed')
  context.emit('schedule/changed')
  unsubscribe()
  context.emit('schedule/changed')
  assert.deepEqual(seen, ['changed', 'changed'])
})

test('L2: an official refusal value is returned unchanged, never converted into success', async () => {
  const service = new FakeHostSchedule()
  service.editImpl = async () => ({ id: ENTRY.id, code: 'schedule_conflict' })
  service.runImpl = async () => ({ id: ENTRY.id, code: 'schedule_execution_pending' })
  service.viewImpl = async () => ({ id: ENTRY.id, code: 'schedule_not_found' })
  const port = new DirectSchedulePort(new FakeContext(service))
  assert.deepEqual(await port.edit({ id: ENTRY.id, action: 'update', patch: { title: 'X' } }), { id: ENTRY.id, code: 'schedule_conflict' })
  assert.deepEqual(await port.run({ id: ENTRY.id }), { id: ENTRY.id, code: 'schedule_execution_pending' })
  assert.deepEqual(await port.view({ id: ENTRY.id }), { id: ENTRY.id, code: 'schedule_not_found' })
})
