/**
 * S5-PR4 L4: Direct/Remote management parity.
 *
 * The two adapters share ONE semantic contract: the same official Host record,
 * refusal code, history cursor and deletion count must cross either transport
 * unchanged. This is the "one feature semantics, two transports" evidence; it is
 * NOT a wire test (the L5 suites own the real Client/Host delivery).
 *
 * @module @xmoon76/dsh-pi-tui/schedule-management-parity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSchedulePort, type DirectScheduleHostContext } from '../../../src/runtime/direct/schedule-direct.ts'
import { RemoteSchedulePort, type RemoteScheduleEvents } from '../../../src/runtime/remote/schedule-remote.ts'
import type { RemoteScheduleNamespace } from '../../../src/runtime/remote/schedule-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../../src/runtime/remote/session-reader-remote.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryResult,
  ScheduleEditResult,
  ScheduleListResult,
  ScheduleRunResult,
  ScheduleViewResult,
} from '../../../src/runtime/schedule-port.ts'

const ONCE: ScheduleCatalogEntry = {
  id: 'schedule-once' as ScheduleCatalogEntry['id'],
  kind: 'after',
  title: 'One-shot',
  prompt: 'Prompt',
  afterSeconds: 60,
  scheduledAt: '2026-01-01T00:01:00.000Z',
  target: { kind: 'new_once', sessionId: 'session-1' as never, create: {} },
  involvedSessionIds: ['session-1' as never],
  status: 'ended',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.100Z',
  executionActive: true,
  deliveryFloorEndsAt: '2026-01-01T00:02:00.000Z',
  lastDelivery: {
    scheduledAt: '2026-01-01T00:01:00.000Z',
    deliveredAt: '2026-01-01T00:01:00.100Z',
    messageId: 'message-1' as never,
    targetSessionId: 'session-1' as never,
  },
}

const HISTORY: ScheduleDeliveryHistoryResult = {
  id: ONCE.id,
  records: [{
    scheduledAt: '2026-01-01T00:01:00.000Z',
    deliveredAt: '2026-01-01T00:01:00.100Z',
    messageId: 'message-1' as never,
    targetSessionId: 'session-1' as never,
    prompt: 'Prompt',
  }],
  earlierRecordsUnavailable: true,
  earlierRecordsPruned: true,
  retention: { days: 30, records: 200 },
  nextBefore: 'message-1' as never,
}

const CONFLICT: ScheduleEditResult = { id: ONCE.id, code: 'schedule_conflict' }
const MISS: ScheduleViewResult = { id: ONCE.id, code: 'schedule_not_found' }
const PENDING: ScheduleRunResult = { id: ONCE.id, code: 'schedule_execution_pending' }

class HostService {
  async catalog(): Promise<ScheduleCatalogEntry[]> { return [ONCE] }
  async remoteList(): Promise<ScheduleListResult> {
    return { items: [ONCE], shown: 1, total: 1, limit: 100, offset: 0 }
  }
  async view(): Promise<ScheduleViewResult> { return MISS }
  async remoteHistory(): Promise<ScheduleDeliveryHistoryResult> { return HISTORY }
  deliveryLimits(): { readonly newSessionIntervalSeconds: number } { return { newSessionIntervalSeconds: 60 } }
  async remoteCreate(): Promise<ScheduleCatalogEntry> { return ONCE }
  async remoteEdit(): Promise<ScheduleEditResult> { return CONFLICT }
  async run(): Promise<ScheduleRunResult> { return PENDING }
  async deleteInactive(): Promise<{ deleted: number }> { return { deleted: 0 } }
}

const hostContext: DirectScheduleHostContext = {
  get: name => (name === 'schedule' ? new HostService() : undefined),
  on: () => () => true,
}

const SNAPSHOT = { id: 1 }
const generation: RemoteConnectionGenerationSource = {
  getSnapshot: () => SNAPSHOT,
  subscribe: () => () => {},
}

const namespace: RemoteScheduleNamespace = {
  catalog: async () => ({ ok: true, value: [ONCE] }),
  create: async () => ({ ok: true, value: ONCE }),
  deleteInactive: async () => ({ ok: true, value: { deleted: 0 } }),
  deliveryLimits: async () => ({ ok: true, value: { newSessionIntervalSeconds: 60 } }),
  edit: async () => ({ ok: true, value: CONFLICT }),
  history: async () => ({ ok: true, value: HISTORY }),
  list: async () => ({ ok: true, value: { items: [ONCE], shown: 1, total: 1, limit: 100, offset: 0 } }),
  run: async () => ({ ok: true, value: PENDING }),
  view: async () => ({ ok: true, value: MISS }),
}

const events: RemoteScheduleEvents = { $on: () => () => {} }

test('L4: the same official records, codes and cursors cross both transports unchanged', async () => {
  const direct = new DirectSchedulePort(hostContext)
  const remote = new RemoteSchedulePort(namespace, events, generation)

  assert.deepEqual(await direct.catalog(), await remote.catalog())
  assert.deepEqual(await direct.list({}), await remote.list({}))
  assert.deepEqual(await direct.view({ id: ONCE.id }), await remote.view({ id: ONCE.id }))
  assert.deepEqual(await direct.history({ id: ONCE.id, limit: 20 }), await remote.history({ id: ONCE.id, limit: 20 }))
  assert.deepEqual(await direct.deliveryLimits(), await remote.deliveryLimits())
  assert.deepEqual(await direct.deleteInactive(), await remote.deleteInactive())

  // Every refusal is the same official VALUE on both transports.
  assert.deepEqual(
    await direct.edit({ id: ONCE.id, action: 'update', patch: { title: 'X' } }),
    await remote.edit({ id: ONCE.id, action: 'update', patch: { title: 'X' } }),
  )
  assert.deepEqual(await direct.run({ id: ONCE.id }), await remote.run({ id: ONCE.id }))

  // The full official record keeps every field: status, execution facts, the
  // separate delivery floor and the receipt are NOT collapsed into a status.
  const record = (await direct.catalog())[0]
  assert.equal(record.status, 'ended')
  assert.equal(record.executionActive, true)
  assert.equal(record.deliveryFloorEndsAt, '2026-01-01T00:02:00.000Z')
  assert.equal(record.lastDelivery?.messageId, 'message-1')
  assert.deepEqual(record.involvedSessionIds, ['session-1'])

  // The history page keeps its cursor and both "earlier records" semantics.
  const history = await remote.history({ id: ONCE.id, limit: 20 })
  assert.equal('nextBefore' in history ? history.nextBefore : undefined, 'message-1')
  assert.equal('earlierRecordsUnavailable' in history ? history.earlierRecordsUnavailable : undefined, true)
  assert.equal('earlierRecordsPruned' in history ? history.earlierRecordsPruned : undefined, true)
})
