/**
 * S5-PR4 L6: the Schedule workspace controller state machine.
 *
 * Failure classes this suite owns (plan §11 L6): a local form refusal without a
 * Host call, one mutation per draft, CAS conflict preservation, unknown outcome
 * without a replay, read-epoch ordering, history-cursor paging, official result
 * recognition, invalidation coalescing and teardown fences.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-workspace-controller.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ScheduleWorkspaceController,
  type ScheduleOwnedRunner,
} from '../../src/app/schedule/workspace-controller.ts'
import {
  ScheduleOutcomeUnknownError,
  ScheduleUnavailableError,
  type ScheduleCatalogEntry,
  type ScheduleCreateRequest,
  type ScheduleDeliveryHistoryRequest,
  type ScheduleDeliveryHistoryResult,
  type ScheduleEditRequest,
  type ScheduleEditResult,
  type ScheduleListRequest,
  type ScheduleListResult,
  type SchedulePort,
  type ScheduleRunRequest,
  type ScheduleRunResult,
  type ScheduleViewRequest,
  type ScheduleViewResult,
} from '../../src/runtime/schedule-port.ts'
import type {
  SessionProjectionSummary,
  SessionReader,
  SessionSummary,
} from '../../src/runtime/session-reader-port.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'
import { SCHEDULE_COPY } from '../../src/app/schedule/presentation.ts'

function entry(overrides: Partial<ScheduleCatalogEntry> = {}): ScheduleCatalogEntry {
  const base: ScheduleCatalogEntry = {
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
  // The override is an official field subset (status/execution facts/kind and
  // the per-kind rule fields); the fixture never invents a field.
  return { ...base, ...overrides } as ScheduleCatalogEntry
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

class FakePort implements SchedulePort {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = []
  entries: readonly ScheduleCatalogEntry[] = [entry()]
  catalogDeferred = false
  catalogGate: ReturnType<typeof deferred<readonly ScheduleCatalogEntry[]>> | undefined
  catalogError: unknown
  viewResults = new Map<string, ScheduleViewResult | Promise<ScheduleViewResult>>()
  historyResults = new Map<string, ScheduleDeliveryHistoryResult | Promise<ScheduleDeliveryHistoryResult>>()
  createResult: ((request: ScheduleCreateRequest) => Promise<ScheduleCatalogEntry>) | undefined
  editResult: ((request: ScheduleEditRequest) => Promise<ScheduleEditResult>) | undefined
  runResult: ((request: ScheduleRunRequest) => Promise<ScheduleRunResult>) | undefined
  deleteInactiveResult: (() => Promise<{ deleted: number }>) | undefined
  readonly listeners = new Set<() => void>()
  limits = { newSessionIntervalSeconds: 60 }

  async catalog(): Promise<readonly ScheduleCatalogEntry[]> {
    this.calls.push({ method: 'catalog', args: [] })
    if (this.catalogError !== undefined) {
      const error = this.catalogError
      this.catalogError = undefined
      throw error
    }
    if (this.catalogGate !== undefined) {
      const gate = this.catalogGate
      this.catalogGate = undefined
      return gate.promise
    }
    return this.entries
  }

  async list(request: ScheduleListRequest): Promise<ScheduleListResult> {
    this.calls.push({ method: 'list', args: [request] })
    return { items: [...this.entries], shown: this.entries.length, total: this.entries.length, limit: 100, offset: 0 }
  }

  async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
    this.calls.push({ method: 'view', args: [request] })
    const value = this.viewResults.get(String(request.id))
    if (value !== undefined) return value
    const found = this.entries.find(candidate => candidate.id === request.id)
    return found ?? { id: request.id, code: 'schedule_not_found' }
  }

  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    this.calls.push({ method: 'history', args: [request] })
    const value = this.historyResults.get(String(request.before ?? 'first'))
    assert.ok(value !== undefined, `the fixture has no history page for ${String(request.before ?? 'first')}`)
    return value
  }

  async deliveryLimits(): Promise<{ readonly newSessionIntervalSeconds: number }> {
    this.calls.push({ method: 'deliveryLimits', args: [] })
    return this.limits
  }

  async create(request: ScheduleCreateRequest): Promise<ScheduleCatalogEntry> {
    this.calls.push({ method: 'create', args: [request] })
    if (this.createResult === undefined) throw new Error('the fixture never creates')
    return this.createResult(request)
  }

  async edit(request: ScheduleEditRequest): Promise<ScheduleEditResult> {
    this.calls.push({ method: 'edit', args: [request] })
    if (this.editResult === undefined) throw new Error('the fixture never edits')
    return this.editResult(request)
  }

  async run(request: ScheduleRunRequest): Promise<ScheduleRunResult> {
    this.calls.push({ method: 'run', args: [request] })
    if (this.runResult === undefined) throw new Error('the fixture never runs')
    return this.runResult(request)
  }

  async deleteInactive(): Promise<{ deleted: number }> {
    this.calls.push({ method: 'deleteInactive', args: [] })
    if (this.deleteInactiveResult === undefined) throw new Error('the fixture never clears')
    return this.deleteInactiveResult()
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  invalidate(): void {
    for (const listener of [...this.listeners]) listener()
  }

  methods(): readonly string[] {
    return this.calls.map(call => call.method)
  }
}

class FakeSessionReader implements SessionReader {
  rows: SessionSummary[] = [
    { id: 'session-a', updatedAt: 2, live: false },
    { id: 'session-child', updatedAt: 1, live: false, origin: 'subagent' },
  ]
  readonly projections = new Map<string, SessionProjectionSummary>([['session-a', { title: 'Alpha' }]])

  async list(): Promise<SessionSummary[]> {
    return this.rows
  }

  async projectionBatch(rows: readonly SessionSummary[]): Promise<Map<string, SessionProjectionSummary>> {
    const out = new Map<string, SessionProjectionSummary>()
    for (const row of rows) {
      const value = this.projections.get(row.id)
      if (value !== undefined) out.set(row.id, value)
    }
    return out
  }

  async search(): Promise<undefined> { return undefined }
  blank(): undefined { return undefined }
  measureContext(): undefined { return undefined }
  turnOutline(): undefined { return undefined }
  sessionStatus(): undefined { return undefined }
}

interface Harness {
  readonly port: FakePort
  readonly reader: FakeSessionReader
  readonly controller: ScheduleWorkspaceController
  readonly owned: Array<{ readonly label: string; readonly task: () => Promise<void> }>
  readonly snapshots: number
}

function harness(options: { readonly autoRun?: boolean } = {}): Harness {
  const port = new FakePort()
  const reader = new FakeSessionReader()
  const owned: Array<{ label: string; task: () => Promise<void> }> = []
  const state = { snapshots: 0 }
  const runOwned: ScheduleOwnedRunner = (label, task) => {
    owned.push({ label, task })
    // Production `runOwned` is detached; the fixture keeps the task runnable
    // and awaits it through `controller.whenIdle()`.
    if (options.autoRun !== false) void task()
  }
  let controller!: ScheduleWorkspaceController
  controller = new ScheduleWorkspaceController({
    port,
    sessionReader: reader,
    runOwned,
    onChange: () => { state.snapshots += 1 },
  })
  return {
    port,
    reader,
    controller,
    owned,
    get snapshots() { return state.snapshots },
  }
}

async function opened(options: { readonly autoRun?: boolean } = {}): Promise<Harness> {
  const value = harness(options)
  value.controller.open()
  await flush()
  return value
}

/**
 * One event-loop turn: every already-resolved fixture promise (the read's
 * `Promise.all`, the publication continuation, the owned mutation's
 * settlement) has run by then. This is a deterministic yield, NOT a time
 * window: no contract here depends on elapsed time.
 */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

test('L6: open reads the catalog and limits once and paints ready rows', async () => {
  const life = await opened()
  try {
    const snapshot = life.controller.snapshot()
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.rows.length, 1)
    assert.equal(snapshot.selectedId, 'schedule-1')
    assert.deepEqual(snapshot.limits, { newSessionIntervalSeconds: 60 })
    assert.deepEqual(life.port.methods(), ['catalog', 'deliveryLimits'])
  } finally {
    life.controller.dispose()
  }
})

test('L6: filter and search project the committed catalog with no Host call', async () => {
  const life = await opened()
  try {
    life.port.entries = [
      entry({ id: 'schedule-a' as never, title: 'Alpha build', prompt: 'run tests', status: 'active' }),
      entry({ id: 'schedule-b' as never, title: 'Beta review', prompt: 'read imports', status: 'paused' }),
    ]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    const before = life.port.calls.length
    life.controller.dispatch({ kind: 'set-filter', filter: 'paused' })
    assert.deepEqual(life.controller.snapshot().rows.map(row => row.title), ['Beta review'])
    life.controller.dispatch({ kind: 'set-query', query: 'IMPORTS' })
    assert.deepEqual(life.controller.snapshot().rows.map(row => row.title), ['Beta review'])
    life.controller.dispatch({ kind: 'set-query', query: 'zzz' })
    assert.deepEqual(life.controller.snapshot().rows, [])
    assert.equal(life.port.calls.length, before, 'filter/search never reaches the Host')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a burst of refresh requests coalesces into ONE newest read', async () => {
  const life = await opened()
  try {
    const gate = deferred<readonly ScheduleCatalogEntry[]>()
    life.port.catalogGate = gate
    life.controller.dispatch({ kind: 'refresh' })
    life.controller.dispatch({ kind: 'refresh' })
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    const catalogs = life.port.methods().filter(method => method === 'catalog').length
    assert.equal(catalogs, 2, 'the open read plus ONE in-flight read; the burst waits')
    life.port.entries = [entry({ title: 'Newest' })]
    gate.resolve([entry({ title: 'Newest' })])
    await flush()
    assert.equal(life.controller.snapshot().rows[0].title, 'Newest')
    assert.equal(life.port.methods().filter(method => method === 'catalog').length, 3, 'exactly one queued read follows')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a first failure is an explicit error, a later failure keeps rows as stale', async () => {
  const port = new FakePort()
  port.catalogError = new ScheduleUnavailableError(SCHEDULE_COPY.serviceUnavailable)
  const controller = new ScheduleWorkspaceController({
    port,
    sessionReader: new FakeSessionReader(),
    runOwned: async (_label, task) => { await task() },
  })
  try {
    controller.open()
    await flush()
    assert.equal(controller.snapshot().status, 'error')
    assert.deepEqual(controller.snapshot().rows, [])
    assert.equal(controller.snapshot().statusMessage, SCHEDULE_COPY.serviceUnavailable)
    controller.dispatch({ kind: 'refresh' })
    await flush()
    assert.equal(controller.snapshot().status, 'ready')
    port.catalogError = new Error('boom')
    controller.dispatch({ kind: 'refresh' })
    await flush()
    assert.equal(controller.snapshot().status, 'stale')
    assert.equal(controller.snapshot().rows.length, 1, 'the last successful rows survive')
  } finally {
    controller.dispose()
  }
})

test('L6: a late view of the previous selection never repaints the newer one', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ id: 'schedule-a' as never, title: 'A' }), entry({ id: 'schedule-b' as never, title: 'B' })]
    const lateA = deferred<ScheduleViewResult>()
    life.port.viewResults.set('schedule-a', lateA.promise)
    life.port.viewResults.set('schedule-b', entry({ id: 'schedule-b' as never, title: 'B' }))
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-a' })
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-b' })
    lateA.resolve(entry({ id: 'schedule-a' as never, title: 'A' }))
    await flush()
    assert.equal(life.controller.snapshot().detail?.id, 'schedule-b')
    assert.equal(life.controller.snapshot().selectedId, 'schedule-b')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an invalidated read never publishes and the invalidation re-reads once', async () => {
  const life = await opened()
  try {
    const gate = deferred<readonly ScheduleCatalogEntry[]>()
    life.port.catalogGate = gate
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.port.entries = [entry({ title: 'After invalidation' })]
    life.port.invalidate()
    gate.resolve([entry({ title: 'Obsolete' })])
    await flush()
    assert.equal(life.controller.snapshot().rows[0].title, 'After invalidation')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a local form refusal never reaches the Host and keeps the draft', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-create' })
    const before = life.port.calls.length
    life.controller.dispatch({ kind: 'save' })
    await flush()
    assert.equal(life.port.calls.length, before, 'an empty title is a local refusal')
    assert.equal(life.controller.snapshot().mode, 'editor')
    assert.equal(life.controller.snapshot().notice?.kind, 'error')
  } finally {
    life.controller.dispose()
  }
})

test('L6: create sends ONE explicit new_once request and re-reads the catalog', async () => {
  const life = await opened()
  try {
    life.port.createResult = async request => entry({ id: 'schedule-new' as never, title: request.title, prompt: request.prompt })
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Nightly' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Check nightly' })
    life.controller.dispatch({ kind: 'save' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    await flush()
    const creates = life.port.calls.filter(call => call.method === 'create')
    assert.equal(creates.length, 1, 'a double Ctrl+S dispatches one create')
    assert.deepEqual(creates[0].args[0], {
      title: 'Nightly',
      prompt: 'Check nightly',
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } },
      target: { kind: 'new_once' },
    })
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.updated)
  } finally {
    life.controller.dispose()
  }
})

test('L6: an unknown create outcome is reported, re-read, and the draft is kept', async () => {
  const life = await opened()
  try {
    life.port.createResult = async () => { throw new ScheduleOutcomeUnknownError('lost the reply') }
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Maybe' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Maybe ran' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    await flush()
    assert.equal(life.controller.snapshot().mode, 'editor', 'the draft is preserved')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.outcomeUnknown)
    assert.equal(life.port.methods().filter(method => method === 'create').length, 1, 'never replayed')
    assert.equal(life.port.methods().filter(method => method === 'catalog').length, 2, 'the workspace re-read the Host')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an edit sends the minimal CAS patch and preserves the draft on conflict', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    assert.equal(life.controller.snapshot().mode, 'editor')
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    await flush()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    assert.equal(edits.length, 1)
    assert.deepEqual(edits[0].args[0], {
      id: 'schedule-1',
      action: 'update',
      patch: { title: 'Renamed' },
      expectedUpdatedAt: '2026-01-01T08:00:00.000Z',
    })
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)
    assert.equal(life.controller.snapshot().mode, 'editor', 'the conflict keeps the draft')
    assert.equal(life.controller.snapshot().editor?.title, 'Renamed')
  } finally {
    life.controller.dispose()
  }
})

test('L6: pause/resume is one CAS update on the official revision and an ended resume is not guessed', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ id: 'schedule-ended' as never, status: 'ended', updatedAt: '2026-01-01T07:00:00.000Z' })]
    life.port.editResult = async request => entry({ ...(request as never as { patch: object }), id: 'schedule-ended' as never })
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'toggle-active' })
    await flush()
    await life.controller.whenIdle()
    const edit = life.port.calls.find(call => call.method === 'edit')
    assert.deepEqual(edit?.args[0], {
      id: 'schedule-ended',
      action: 'update',
      patch: { active: true },
      expectedUpdatedAt: '2026-01-01T07:00:00.000Z',
    }, 'an ended task is resumed through the official update, never a client guess')
  } finally {
    life.controller.dispose()
  }
})

test('L6: delete and clear-ended require one confirmation and commit exactly one write', async () => {
  const life = await opened()
  try {
    life.port.editResult = async () => ({ id: 'schedule-1' as never, deleted: true })
    life.port.deleteInactiveResult = async () => ({ deleted: 3 })
    const before = life.port.calls.length
    life.controller.dispatch({ kind: 'ask-delete' })
    assert.equal(life.controller.snapshot().confirm?.kind, 'delete')
    life.controller.dispatch({ kind: 'cancel' })
    assert.equal(life.port.calls.length, before, 'cancel writes nothing')
    life.controller.dispatch({ kind: 'ask-delete' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    await flush()
    const deletes = life.port.calls.filter(call => call.method === 'edit' && (call.args[0] as ScheduleEditRequest).action === 'delete')
    assert.equal(deletes.length, 1)
    assert.equal(life.controller.snapshot().mode, 'list')

    // A delete from the LIST (no open detail) still sends the row's official
    // revision: the list projection carries the same CAS value.
    life.controller.dispatch({ kind: 'ask-delete' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    const listDeletes = life.port.calls.filter(call => call.method === 'edit' && (call.args[0] as ScheduleEditRequest).action === 'delete')
    assert.equal(listDeletes.length, 2)
    assert.equal((listDeletes[1].args[0] as ScheduleEditRequest).expectedUpdatedAt, '2026-01-01T08:00:00.000Z')

    life.controller.dispatch({ kind: 'ask-clear-ended' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    await flush()
    assert.equal(life.port.methods().filter(method => method === 'deleteInactive').length, 1)
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.cleared(3))
  } finally {
    life.controller.dispose()
  }
})

test('L6: run-now distinguishes a queued delivery from a pending execution', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.port.runResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_execution_pending' })
    life.controller.dispatch({ kind: 'ask-run' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.executionPending)
    life.port.runResult = async () => entry({ lastDelivery: { scheduledAt: '2026-01-01T09:00:00.000Z', deliveredAt: '2026-01-01T09:00:00.100Z', messageId: 'm' as never, targetSessionId: 'session-1' as never } })
    life.controller.dispatch({ kind: 'ask-run' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.deliveryQueued)
  } finally {
    life.controller.dispose()
  }
})

test('L6: history pages only by the official nextBefore cursor and reports a vanished cursor', async () => {
  const life = await opened()
  try {
    const page = (nextBefore?: string): ScheduleDeliveryHistoryResult => ({
      id: 'schedule-1' as never,
      records: [{ scheduledAt: '2026-01-01T09:00:00.000Z', deliveredAt: '2026-01-01T09:00:00.100Z', messageId: 'm1' as never, targetSessionId: 'session-1' as never }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
      ...(nextBefore === undefined ? {} : { nextBefore: nextBefore as never }),
    })
    life.port.historyResults.set('first', page('m1'))
    life.port.historyResults.set('m1', { id: 'schedule-1' as never, code: 'delivery_cursor_not_found' })
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-history' })
    await flush()
    assert.equal(life.controller.snapshot().mode, 'history')
    assert.equal(life.controller.snapshot().history?.nextBefore, 'm1')
    life.controller.dispatch({ kind: 'history-more' })
    await flush()
    const calls = life.port.calls.filter(call => call.method === 'history')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].args[0], { id: 'schedule-1', limit: 20, before: 'm1' })
    assert.equal(life.controller.snapshot().history?.status, 'error')
    assert.equal(life.controller.snapshot().history?.message, SCHEDULE_COPY.historyChanged)
    life.controller.dispatch({ kind: 'history-more' })
    await flush()
    assert.equal(life.port.calls.filter(call => call.method === 'history').length, 2, 'no cursor means no further page')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a discarded write is unknown, never a claimed rollback; dispose stops publication', async () => {
  const life = await opened()
  try {
    const gate = deferred<ScheduleCatalogEntry>()
    life.port.createResult = () => gate.promise
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'In flight' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'In flight' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    life.controller.dispose()
    gate.reject(new SupersededReadError('closed'))
    await flush()
    assert.equal(life.port.listeners.size, 0, 'dispose drops the Host-change subscription')
    assert.equal(life.controller.snapshot().mode, 'editor', 'the closed workspace publishes nothing new')
  } finally {
    life.controller.dispose()
  }
})

test('L6: the Session chooser lists non-subagent Sessions with their projection titles', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-create' })
    await flush()
    assert.deepEqual(life.controller.snapshot().sessions, [{ id: 'session-a', title: 'Alpha' }])
    life.controller.dispatch({ kind: 'select-target-kind', target: 'session' })
    life.controller.dispatch({ kind: 'select-target-session', sessionId: 'session-a' })
    assert.equal(life.controller.snapshot().editor?.target.kind, 'session')
    const target = life.controller.snapshot().editor?.target
    assert.equal(target?.kind === 'session' ? target.sessionId : undefined, 'session-a')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a delete that lost the task reports the miss instead of success', async () => {
  const life = await opened()
  try {
    life.port.editResult = async () => {
      // The task really is gone on the Host: the following authoritative
      // re-read must show it.
      life.port.entries = []
      return { id: 'schedule-1' as never, deleted: false, code: 'schedule_not_found' }
    }
    life.controller.dispatch({ kind: 'ask-delete' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.taskGone)
    assert.equal(life.controller.snapshot().notice?.kind, 'error')
    assert.equal(life.controller.snapshot().mode, 'list')
    assert.equal(life.controller.snapshot().selectedId, undefined, 'the vanished task stops being selected')
  } finally {
    life.controller.dispose()
  }
})

test('L6: cycling the timing/target away and back sends no patch for them', async () => {
  const life = await opened()
  try {
    life.port.editResult = async () => entry({ title: 'Renamed' })
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'select-timing-kind', timing: 'cron' })
    life.controller.dispatch({ kind: 'select-timing-kind', timing: 'daily' })
    life.controller.dispatch({ kind: 'select-target-kind', target: 'session' })
    life.controller.dispatch({ kind: 'select-target-kind', target: 'new_once' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edit = life.port.calls.find(call => call.method === 'edit')
    assert.deepEqual(edit?.args[0], {
      id: 'schedule-1',
      action: 'update',
      patch: { title: 'Renamed' },
      expectedUpdatedAt: '2026-01-01T08:00:00.000Z',
    }, 'only the real change travels: no rule recompile, no re-reserved new_once target')
  } finally {
    life.controller.dispose()
  }
})

test('L6: the edit-open read is fenced and its failure is surfaced', async () => {
  const life = await opened()
  try {
    const late = deferred<ScheduleViewResult>()
    life.port.viewResults.set('schedule-1', late.promise)
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    // The user leaves Detail while the read is in flight: the late answer must
    // NOT open an editor over the restored list.
    life.controller.dispatch({ kind: 'back' })
    late.resolve(entry())
    await flush()
    assert.equal(life.controller.snapshot().mode, 'list')

    // From the list (no detail snapshot) the edit read really happens, and its
    // failure is a visible error instead of a silent no-op.
    const failed = deferred<ScheduleViewResult>()
    life.port.viewResults.set('schedule-1', failed.promise)
    life.controller.dispatch({ kind: 'open-edit' })
    // The fake `view` adopts the stored promise one microtask later; reject
    // only once that adoption handler exists, so the rejection is the real
    // awaited failure rather than an unhandled-rejection artifact.
    await flush()
    failed.reject(new Error('view failed'))
    await flush()
    assert.equal(life.controller.snapshot().mode, 'list')
    assert.equal(life.controller.snapshot().notice?.kind, 'error')
    assert.match(life.controller.snapshot().notice?.text ?? '', /view failed/u)
  } finally {
    life.controller.dispose()
  }
})

test('L6: Help is an underlay that returns to the exact page and draft', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Keep me' })
    life.controller.dispatch({ kind: 'open-help' })
    assert.equal(life.controller.snapshot().mode, 'help')
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'editor')
    assert.equal(life.controller.snapshot().editor?.title, 'Keep me')
    // A confirmation owns the surface: Help never steals it.
    life.controller.dispatch({ kind: 'back' })
    life.controller.dispatch({ kind: 'back' })
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'ask-delete' })
    life.controller.dispatch({ kind: 'open-help' })
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().confirm?.kind, 'delete')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a history page already loading cannot be paged twice', async () => {
  const life = await opened()
  try {
    life.port.historyResults.set('first', {
      id: 'schedule-1' as never,
      records: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
      nextBefore: 'm1' as never,
    })
    const second = deferred<ScheduleDeliveryHistoryResult>()
    life.port.historyResults.set('m1', second.promise)
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-history' })
    await flush()
    life.controller.dispatch({ kind: 'history-more' })
    life.controller.dispatch({ kind: 'history-more' })
    await flush()
    assert.equal(life.port.calls.filter(call => call.method === 'history').length, 2, 'the loading page owns the cursor')
    second.resolve({
      id: 'schedule-1' as never,
      records: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    await flush()
    assert.equal(life.controller.snapshot().history?.status, 'ready')
  } finally {
    life.controller.dispose()
  }
})
