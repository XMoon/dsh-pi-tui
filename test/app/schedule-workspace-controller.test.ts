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
  /** Ordered answers for consecutive `view` calls (reload races). */
  viewQueue: Array<ScheduleViewResult | Promise<ScheduleViewResult>> = []
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
    const queued = this.viewQueue.shift()
    if (queued !== undefined) return queued
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
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-ended' })
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
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
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

    // The delete action belongs to Detail; re-open it and the row's official
    // revision is captured again.
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
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
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
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
    // From Detail with a moved (detail-less) selection the edit-open read really
    // happens; its failure is visible instead of a silent no-op.
    life.port.entries = [entry({ id: 'schedule-a' as never, title: 'A' }), entry({ id: 'schedule-b' as never, title: 'B' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-a' })
    await flush()
    life.controller.dispatch({ kind: 'move', delta: 1 })
    const failed = deferred<ScheduleViewResult>()
    life.port.viewResults.set('schedule-b', failed.promise)
    life.controller.dispatch({ kind: 'open-edit' })
    // The fake `view` adopts the stored promise one microtask later; reject
    // only once that adoption handler exists, so the rejection is the real
    // awaited failure rather than an unhandled-rejection artifact.
    await flush()
    failed.reject(new Error('view failed'))
    await flush()
    assert.equal(life.controller.snapshot().mode, 'detail')
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
    // Leave the dirty editor through the CONFIRMED discard, then navigate.
    life.controller.dispatch({ kind: 'back' })
    assert.equal(life.controller.snapshot().confirm?.kind, 'discard')
    life.controller.dispatch({ kind: 'confirm' })
    assert.equal(life.controller.snapshot().mode, 'list')
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

test('L6: cycling timing/target away and back preserves NON-DEFAULT typed values', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({
      id: 'schedule-cron' as never,
      kind: 'cron',
      expression: '0 17 * * 1-5',
      timeZone: 'UTC',
      target: { kind: 'new_once', sessionId: 'session-9' as never, create: { cwd: '/work' } },
    })]
    life.port.editResult = async () => entry({ id: 'schedule-cron' as never, title: 'Renamed cron' })
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-cron' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'select-timing-kind', timing: 'daily' })
    life.controller.dispatch({ kind: 'select-timing-kind', timing: 'cron' })
    life.controller.dispatch({ kind: 'select-target-kind', target: 'new' })
    life.controller.dispatch({ kind: 'select-target-kind', target: 'new_once' })
    const editor = life.controller.snapshot().editor
    assert.equal(editor?.timing.kind, 'cron')
    assert.equal(editor?.timing.kind === 'cron' ? editor.timing.expression : '', '0 17 * * 1-5',
      'the stored expression is not reset to a default')
    assert.equal(editor?.target.kind, 'new_once')
    assert.equal(editor?.target.kind === 'new_once' ? editor.target.cwd : '', '/work',
      'the stored creation directory survives the kind cycle')
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed cron' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edit = life.port.calls.find(call => call.method === 'edit')
    assert.deepEqual(edit?.args[0], {
      id: 'schedule-cron',
      action: 'update',
      patch: { title: 'Renamed cron' },
      expectedUpdatedAt: '2026-01-01T08:00:00.000Z',
    }, 'a kind cycle never re-sends the rule or the reserved new_once target')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an invalid intermediate timing is DIRTY, never an exception out of Esc', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ id: 'schedule-cron' as never, kind: 'cron', expression: '0 17 * * 1-5', timeZone: 'UTC' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-cron' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'timing-cron', value: '' })
    // Esc on an invalid intermediate value must ask to discard, not throw.
    assert.doesNotThrow(() => life.controller.dispatch({ kind: 'back' }))
    assert.equal(life.controller.snapshot().confirm?.kind, 'discard')
  } finally {
    life.controller.dispose()
  }
})

test('L6: conflict recovery reloads the latest revision while keeping the draft', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'My edit' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)
    assert.equal(life.controller.snapshot().editor?.title, 'My edit')

    life.port.viewResults.set('schedule-1', entry({
      title: 'Host side edit',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloadConflict('the title'))
    assert.equal(life.controller.snapshot().notice?.kind, 'error', 'a field edited on BOTH sides is an observable conflict')
    assert.equal(life.controller.snapshot().editor?.title, 'My edit', 'the user draft is never overwritten')
    assert.equal(life.controller.snapshot().editor?.expectedUpdatedAt, '2026-01-02T00:00:00.000Z',
      'the rebased CAS revision is the latest Host one')

    life.port.editResult = async () => entry({ title: 'My edit', updatedAt: '2026-01-03T00:00:00.000Z' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    assert.equal((edits[edits.length - 1]?.args[0] as ScheduleEditRequest).expectedUpdatedAt, '2026-01-02T00:00:00.000Z')
  } finally {
    life.controller.dispose()
  }
})

test('L6: Help under an in-flight history page keeps its answer, and invalidation re-reads', async () => {
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
    const page = deferred<ScheduleDeliveryHistoryResult>()
    life.port.historyResults.set('m1', page.promise)
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-history' })
    await flush()
    life.controller.dispatch({ kind: 'history-more' })
    await flush()
    life.controller.dispatch({ kind: 'open-help' })
    assert.equal(life.controller.snapshot().mode, 'help')
    page.resolve({
      id: 'schedule-1' as never,
      records: [{ scheduledAt: '2026-01-01T09:00:00.000Z', deliveredAt: '2026-01-01T09:00:00.100Z', messageId: 'm2' as never, targetSessionId: 'session-1' as never }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    await flush()
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'history')
    assert.equal(life.controller.snapshot().history?.status, 'ready', 'the underlay page is not left loading forever')
    assert.equal(life.controller.snapshot().history?.records.length, 1)

    // An invalidation while Help is the underlay never closes Help and never
    // resets the user's history pagination: it is a background data signal, not
    // a navigation.
    life.controller.dispatch({ kind: 'open-help' })
    const callsBefore = life.port.calls.filter(call => call.method === 'history').length
    life.port.invalidate()
    await flush()
    assert.equal(life.controller.snapshot().mode, 'help', 'a schedule/changed signal never closes Help')
    assert.equal(life.port.calls.filter(call => call.method === 'history').length, callsBefore,
      'a user-owned history page is not reset by a background invalidation')
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'history')
    assert.equal(life.controller.snapshot().history?.records.length, 1, 'the page context is preserved')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a multi-line Prompt keeps its exact bytes through an edit and save', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ prompt: 'first line\nsecond line' })]
    life.port.editResult = async () => entry({ prompt: 'first line\nsecond lineX' })
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    assert.equal(life.controller.snapshot().editor?.prompt, 'first line\nsecond line',
      'opening the editor preserves the stored newline')
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'first line\nsecond lineX' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edit = life.port.calls.find(call => call.method === 'edit')
    const request = edit?.args[0] as ScheduleEditRequest | undefined
    assert.equal(request?.action, 'update')
    assert.equal(request?.action === 'update' ? request.patch.prompt : undefined, 'first line\nsecond lineX',
      'the submitted patch carries the original lines plus the one changed character')
  } finally {
    life.controller.dispose()
  }
})

test('L6: the delete confirmation freezes the CAS revision it asked about', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'ask-delete' })
    // Another Client changes the task AFTER the question opened: the local
    // snapshot now carries a newer revision, but the question confirmed V1.
    life.port.entries = [entry({ title: 'Host side rename', updatedAt: '2026-01-02T00:00:00.000Z' })]
    let submitted: ScheduleEditRequest | undefined
    life.port.editResult = async request => {
      submitted = request
      return { id: 'schedule-1' as never, code: 'schedule_conflict' }
    }
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(submitted?.action, 'delete')
    assert.equal((submitted as Extract<ScheduleEditRequest, { action: 'delete' }>).expectedUpdatedAt,
      '2026-01-01T08:00:00.000Z', 'the confirmed V1 revision is submitted, not the newer V2 one')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)
    assert.equal(life.controller.snapshot().notice?.kind, 'error', 'a conflict never claims the deletion')
    assert.equal(life.controller.snapshot().selectedId, 'schedule-1', 'the still-existing task stays selected')
  } finally {
    life.controller.dispose()
  }
})

test('L6: switching to another task immediately retires the previous detail', async () => {
  const life = await opened()
  try {
    const alpha = entry({ id: 'task-alpha' as never, title: 'Alpha', updatedAt: '2026-01-01T01:00:00.000Z' })
    const beta = entry({ id: 'task-beta' as never, title: 'Beta', updatedAt: '2026-02-02T02:00:00.000Z' })
    life.port.entries = [alpha, beta]
    life.port.viewResults.set('task-alpha', alpha)
    const pendingBeta = deferred<ScheduleViewResult>()
    life.port.viewResults.set('task-beta', pendingBeta.promise)
    life.controller.dispatch({ kind: 'refresh' })
    await flush()

    life.controller.dispatch({ kind: 'open-detail', id: 'task-alpha' })
    await flush()
    assert.equal(life.controller.snapshot().detail?.id, 'task-alpha')

    // B's view is still in flight: the right pane must not keep showing A.
    life.controller.dispatch({ kind: 'open-detail', id: 'task-beta' })
    await flush()
    assert.equal(life.controller.snapshot().selectedId, 'task-beta')
    assert.equal(life.controller.snapshot().detail, undefined,
      'the previous task detail is retired as soon as the selection changes')

    // Space (pause/resume) during the switch must act on B, never on A.
    let submitted: ScheduleEditRequest | undefined
    life.port.editResult = async request => {
      submitted = request
      return { ...beta, title: 'Beta' } as never
    }
    life.controller.dispatch({ kind: 'toggle-active' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(submitted?.id, 'task-beta', 'Space never mutates the task the user left')
    assert.equal((submitted as Extract<ScheduleEditRequest, { action: 'update' }>).expectedUpdatedAt,
      '2026-02-02T02:00:00.000Z', "the update carries B's own revision")
    assert.equal(life.port.calls.some(call => call.method === 'edit'
      && (call.args[0] as ScheduleEditRequest).id === 'task-alpha'), false,
    'no write may ever target the previous task')

    // The confirmation target follows the CURRENT selection too.
    await flush()
    life.controller.dispatch({ kind: 'ask-run' })
    const runConfirm = life.controller.snapshot().confirm
    assert.equal(runConfirm?.kind === 'run' ? runConfirm.id : undefined, 'task-beta')
    life.controller.dispatch({ kind: 'cancel' })
    // History belongs to the current selection as well.
    life.controller.dispatch({ kind: 'open-history' })
    await flush()
    const historyCall = life.port.calls.filter(call => call.method === 'history').at(-1)
    assert.equal((historyCall?.args[0] as { id?: string } | undefined)?.id, 'task-beta',
      'the history page belongs to the current selection')

    pendingBeta.resolve(beta)
    await flush()
    assert.equal(life.controller.snapshot().detail?.id, 'task-beta')
  } finally {
    life.controller.dispose()
  }
})

test('L6: reload-latest never overwrites fields another client changed but the user did not', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ title: 'A', prompt: 'P' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    // The user edits ONLY the prompt.
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'P2' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)

    // Meanwhile another client renamed the task; the user never touched the title.
    life.port.viewResults.set('schedule-1', entry({
      title: 'B',
      prompt: 'P',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded,
      'no field was edited on both sides: this is a clean rebase')
    assert.equal(life.controller.snapshot().editor?.title, 'B', "the untouched field follows the Host's newer value")
    assert.equal(life.controller.snapshot().editor?.prompt, 'P2', 'the user edit is kept')

    life.port.editResult = async () => entry({ title: 'B', prompt: 'P2', updatedAt: '2026-01-03T00:00:00.000Z' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    const request = edits[edits.length - 1]?.args[0] as Extract<ScheduleEditRequest, { action: 'update' }> | undefined
    assert.deepEqual(request?.patch, { prompt: 'P2' },
      "the untouched title is NOT re-sent, so the other client's rename survives")
    assert.equal(request?.expectedUpdatedAt, '2026-01-02T00:00:00.000Z')
  } finally {
    life.controller.dispose()
  }
})

test('L6: reload-latest keeps the user value for the SAME field and reports the overlap', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ title: 'A', prompt: 'P' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Mine' })
    life.port.viewResults.set('schedule-1', entry({
      title: 'A',
      prompt: 'Theirs',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().notice?.kind, 'error')
    assert.match(life.controller.snapshot().notice?.text ?? '', /also changed the prompt/u)
    assert.equal(life.controller.snapshot().editor?.prompt, 'Mine', 'the user value is preserved for the field they edited')
    life.port.editResult = async () => entry({ prompt: 'Mine', updatedAt: '2026-01-03T00:00:00.000Z' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    const request = edits[edits.length - 1]?.args[0] as Extract<ScheduleEditRequest, { action: 'update' }> | undefined
    assert.deepEqual(request?.patch, { prompt: 'Mine' })
  } finally {
    life.controller.dispose()
  }
})

test('L6: consecutive reloads adopt each Host revision without inventing user intent', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ title: 'A', prompt: 'P' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'P2' })

    // First reload: another client renamed A -> B; the user never touched title.
    life.port.viewResults.set('schedule-1', entry({ title: 'B', prompt: 'P', updatedAt: '2026-01-02T00:00:00.000Z' }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'B')
    assert.equal(life.controller.snapshot().editor?.prompt, 'P2')

    // Second reload: the title changed AGAIN (B -> C) while the user still only
    // edits the prompt. The adopted B must not be mistaken for user intent.
    life.port.viewResults.set('schedule-1', entry({ title: 'C', prompt: 'P', updatedAt: '2026-01-03T00:00:00.000Z' }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'C', 'the twice-adopted title follows the Host')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded)

    life.port.editResult = async () => entry({ title: 'C', prompt: 'P2', updatedAt: '2026-01-04T00:00:00.000Z' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    const request = edits[edits.length - 1]?.args[0] as Extract<ScheduleEditRequest, { action: 'update' }> | undefined
    assert.deepEqual(request?.patch, { prompt: 'P2' }, 'only the user-edited prompt travels')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a Run receipt never lands on the page the user switched to', async () => {
  const life = await opened()
  try {
    const alpha = entry({ id: 'task-alpha' as never, title: 'Alpha' })
    const beta = entry({ id: 'task-beta' as never, title: 'Beta' })
    life.port.entries = [alpha, beta]
    life.port.viewResults.set('task-alpha', alpha)
    life.port.viewResults.set('task-beta', beta)
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'task-alpha' })
    await flush()
    const pending = deferred<ScheduleRunResult>()
    life.port.runResult = () => pending.promise
    life.controller.dispatch({ kind: 'ask-run' })
    life.controller.dispatch({ kind: 'confirm' })
    // The user moves to B while A's Host run is still in flight.
    life.controller.dispatch({ kind: 'move', delta: 1 })
    await flush()
    pending.resolve({ ...alpha, status: 'active' } as never)
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().selectedId, 'task-beta', 'the selection stays on B')
    assert.equal(life.controller.snapshot().detail?.id ?? undefined, undefined,
      "A's receipt never becomes B's Detail")
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.deliveryQueued,
      'the Host receipt is still reported')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a schedule/changed signal refreshes a Help underlay without closing it', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-help' })
    assert.equal(life.controller.snapshot().mode, 'help')
    life.port.invalidate()
    await flush()
    assert.equal(life.controller.snapshot().mode, 'help', 'the underlay refresh is not a navigation')
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().detail?.id, 'schedule-1')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a value reverted to the baseline is not a pending edit', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ title: 'A', prompt: 'P' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'X' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'A' })
    assert.equal(life.controller.snapshot().editor?.title, 'A')
    life.port.viewResults.set('schedule-1', entry({ title: 'B', prompt: 'P', updatedAt: '2026-01-02T00:00:00.000Z' }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'B', 'the reverted title is untouched and follows the Host')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded, 'no overlap was invented')
  } finally {
    life.controller.dispose()
  }
})

test('L6: toggling Advanced alone never counts as a Target edit', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({
      target: { kind: 'new_once', sessionId: 'reserved' as never, create: { cwd: '/work' } },
    })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'toggle-advanced' })
    life.controller.dispatch({ kind: 'toggle-advanced' })
    life.port.viewResults.set('schedule-1', entry({
      target: { kind: 'new_once', sessionId: 'reserved' as never, create: { cwd: '/host-new' } },
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    const target = life.controller.snapshot().editor?.target
    assert.equal(target?.kind === 'new_once' ? target.cwd : undefined, '/host-new',
      'an untouched target follows the Host even after Advanced was toggled')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded)
  } finally {
    life.controller.dispose()
  }
})

test('L6: an edit receipt settles under Help and never closes it', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed' })
    const pending = deferred<ScheduleEditResult>()
    life.port.editResult = () => pending.promise
    life.controller.dispatch({ kind: 'save' })
    life.controller.dispatch({ kind: 'open-help' })
    pending.resolve(entry({ title: 'Renamed', updatedAt: '2026-01-02T00:00:00.000Z' }))
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().mode, 'help', 'the receipt never closes Help')
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'detail', 'closing Help shows the settled Detail')
    assert.equal(life.controller.snapshot().editor, undefined)
    assert.equal(life.controller.snapshot().detail?.title, 'Renamed')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a not-found pause receipt never resets the page the user switched to', async () => {
  const life = await opened()
  try {
    const alpha = entry({ id: 'task-alpha' as never, title: 'Alpha' })
    const beta = entry({ id: 'task-beta' as never, title: 'Beta' })
    life.port.entries = [alpha, beta]
    life.port.viewResults.set('task-alpha', alpha)
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'task-alpha' })
    await flush()
    const pending = deferred<ScheduleEditResult>()
    life.port.editResult = () => pending.promise
    life.controller.dispatch({ kind: 'toggle-active' })
    life.controller.dispatch({ kind: 'move', delta: 1 })
    await flush()
    pending.resolve({ id: 'task-alpha' as never, code: 'schedule_not_found' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().selectedId, 'task-beta', 'the stale miss does not clear the new selection')
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.notEqual(life.controller.snapshot().detail?.id, 'task-alpha')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a pending save freezes the draft it is saving (edit and create)', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ title: 'A', prompt: 'P' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Saved title' })
    const pending = deferred<ScheduleEditResult>()
    life.port.editResult = () => pending.promise
    life.controller.dispatch({ kind: 'save' })
    // A second edit during the pending write must not enter the draft that the
    // receipt will clear.
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'late prompt' })
    assert.equal(life.controller.snapshot().editor?.prompt, 'P', 'typing is frozen while the save is pending')
    pending.resolve(entry({ title: 'Saved title', prompt: 'P', updatedAt: '2026-01-03T00:00:00.000Z' }))
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().mode, 'detail')

    // Create has the same window (the create entry belongs to the list page).
    life.controller.dispatch({ kind: 'back' })
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'New task' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'created prompt' })
    const creating = deferred<ScheduleCatalogEntry>()
    life.port.createResult = () => creating.promise
    life.controller.dispatch({ kind: 'save' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'late title' })
    assert.equal(life.controller.snapshot().editor?.title, 'New task', 'create typing is frozen too')
    creating.resolve(entry({ id: 'task-new' as never, title: 'New task' }))
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().mode, 'detail')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a failed save unfreezes the unchanged draft', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().mode, 'editor')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)
    // After settlement the editor is live again.
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'second edit' })
    assert.equal(life.controller.snapshot().editor?.prompt, 'second edit')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an older reload answer never rolls the editor back', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const newer = deferred<ScheduleViewResult>()
    const older = deferred<ScheduleViewResult>()
    // R1 (older request) gets `older`, R2 (newest) gets `newer`; R2 settles first.
    life.port.viewQueue = [older.promise, newer.promise]
    life.controller.dispatch({ kind: 'reload-latest' })
    life.controller.dispatch({ kind: 'reload-latest' })
    newer.resolve(entry({ title: 'V2', updatedAt: '2026-01-03T00:00:00.000Z' }))
    await flush()
    older.resolve(entry({ title: 'V1', updatedAt: '2026-01-02T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'V2', 'the newest reload wins')
    assert.equal(life.controller.snapshot().editor?.expectedUpdatedAt, '2026-01-03T00:00:00.000Z')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a reload from a closed editor never touches the reopened one', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const pending = deferred<ScheduleViewResult>()
    life.port.viewQueue = [pending.promise]
    life.controller.dispatch({ kind: 'reload-latest' })
    // Close the editor (confirmed discard) and reopen the SAME task.
    life.controller.dispatch({ kind: 'back' })
    life.controller.dispatch({ kind: 'confirm' })
    assert.equal(life.controller.snapshot().mode, 'detail')
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'fresh draft' })
    pending.resolve(entry({ title: 'stale reload', updatedAt: '2026-01-09T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().mode, 'editor')
    assert.equal(life.controller.snapshot().editor?.title, 'fresh draft', 'the old reload result is discarded')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a deleted underlay task keeps Help open and returns to the list', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-help' })
    life.port.viewResults.set('schedule-1', { id: 'schedule-1' as never, code: 'schedule_not_found' })
    life.port.entries = []
    life.port.invalidate()
    await flush()
    assert.equal(life.controller.snapshot().mode, 'help', 'a background not-found never closes Help')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.taskGone)
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'list', 'the underlay became the list')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an older reload failure never replaces the newest success notice', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const newer = deferred<ScheduleViewResult>()
    const older = deferred<ScheduleViewResult>()
    life.port.viewQueue = [older.promise, newer.promise]
    life.controller.dispatch({ kind: 'reload-latest' })
    life.controller.dispatch({ kind: 'reload-latest' })
    newer.resolve(entry({ title: 'V2', updatedAt: '2026-01-03T00:00:00.000Z' }))
    await flush()
    older.reject(new Error('stale network error'))
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded, 'the superseded failure is silent')
    assert.equal(life.controller.snapshot().editor?.title, 'V2')
    assert.equal(life.controller.snapshot().editor?.expectedUpdatedAt, '2026-01-03T00:00:00.000Z')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a reload that finishes after the editor closed publishes nothing', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const failed = deferred<ScheduleViewResult>()
    life.port.viewQueue = [failed.promise]
    life.controller.dispatch({ kind: 'reload-latest' })
    life.controller.dispatch({ kind: 'back' }) // a clean editor leaves without a question
    assert.equal(life.controller.snapshot().mode, 'detail')
    failed.reject(new Error('stale reload error'))
    await flush()
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().notice, undefined, 'a closed editor never receives the old error')

    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const missing = deferred<ScheduleViewResult>()
    life.port.viewQueue = [missing.promise]
    life.controller.dispatch({ kind: 'reload-latest' })
    life.controller.dispatch({ kind: 'back' })
    missing.resolve({ id: 'schedule-1' as never, code: 'schedule_not_found' })
    await flush()
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().notice, undefined, 'nor a stale "task gone" notice')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a catalog refresh during a pending Create never strands the successful receipt', async () => {
  const life = await opened()
  try {
    life.port.entries = []
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    assert.equal(life.controller.snapshot().selectedId, undefined)
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Task A' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'prompt A' })
    const pending = deferred<ScheduleCatalogEntry>()
    life.port.createResult = () => pending.promise
    life.controller.dispatch({ kind: 'save' })
    // Another client creates B; the background catalog read moves the cursor.
    life.port.entries = [entry({ id: 'task-b' as never, title: 'B' })]
    life.port.invalidate()
    await flush()
    assert.equal(life.controller.snapshot().selectedId, 'task-b', 'the cursor drifted while Create was pending')
    life.port.entries = [entry({ id: 'task-b' as never, title: 'B' }), entry({ id: 'task-a' as never, title: 'Task A' })]
    pending.resolve(entry({ id: 'task-a' as never, title: 'Task A' }))
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().editor, undefined, 'the successful Create closes its OWN editor')
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().selectedId, 'task-a')
    assert.equal(life.controller.snapshot().detail?.id, 'task-a')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a catalog refresh during a pending Edit never strands the successful receipt', async () => {
  const life = await opened()
  try {
    const a = entry({ id: 'task-a' as never, title: 'A' })
    life.port.entries = [a]
    life.port.viewResults.set('task-a', a)
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed A' })
    const pending = deferred<ScheduleEditResult>()
    life.port.editResult = () => pending.promise
    life.controller.dispatch({ kind: 'save' })
    life.port.entries = [entry({ id: 'task-b' as never, title: 'B' })]
    life.port.invalidate()
    await flush()
    assert.notEqual(life.controller.snapshot().selectedId, 'task-a', 'the cursor drifted away from the edited task')
    life.port.entries = [entry({ id: 'task-b' as never, title: 'B' }), entry({ id: 'task-a' as never, title: 'Renamed A' })]
    pending.resolve(entry({ id: 'task-a' as never, title: 'Renamed A', updatedAt: '2026-01-05T00:00:00.000Z' }))
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().editor, undefined, 'the successful Edit closes its OWN editor')
    assert.equal(life.controller.snapshot().mode, 'detail')
    assert.equal(life.controller.snapshot().detail?.id, 'task-a')
  } finally {
    life.controller.dispose()
  }
})
