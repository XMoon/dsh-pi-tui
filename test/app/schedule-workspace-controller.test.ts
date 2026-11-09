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
import { editorFields, scheduleSessionId } from '../../src/domain/schedule/form.ts'
import type {
  SessionProjectionSummary,
  SessionReader,
  SessionSummary,
} from '../../src/runtime/session-reader-port.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'
import { SCHEDULE_COPY } from '../../src/app/schedule/presentation.ts'
import type { SessionSwitchOutcome } from '../../src/app/session/runtime.ts'

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
  readonly listCalls: Array<{ readonly currentSessionId: string | undefined; readonly signal: AbortSignal | undefined }> = []
  trace: string[] | undefined
  listResult: SessionSummary[] | undefined = this.rows
  listError: unknown
  listGate: ReturnType<typeof deferred<SessionSummary[] | undefined>> | undefined
  projectionGate: ReturnType<typeof deferred<Map<string, SessionProjectionSummary>>> | undefined

  async list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined> {
    this.listCalls.push({ currentSessionId, signal })
    this.trace?.push('roster-list')
    if (this.listError !== undefined) {
      const error = this.listError
      this.listError = undefined
      throw error
    }
    if (this.listGate !== undefined) {
      const gate = this.listGate
      this.listGate = undefined
      return gate.promise
    }
    return this.listResult
  }

  async projectionBatch(rows: readonly SessionSummary[]): Promise<Map<string, SessionProjectionSummary>> {
    if (this.projectionGate !== undefined) {
      const gate = this.projectionGate
      this.projectionGate = undefined
      return gate.promise
    }
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
  readonly switchCalls: string[]
  readonly trace: string[]
  readonly captures: number
  readonly closeCount: number
  readonly snapshots: number
}

function harness(options: {
  readonly autoRun?: boolean
  readonly switchOutcome?: SessionSwitchOutcome | (() => Promise<SessionSwitchOutcome>)
} = {}): Harness {
  const port = new FakePort()
  const reader = new FakeSessionReader()
  const trace: string[] = []
  reader.trace = trace
  const owned: Array<{ label: string; task: () => Promise<void> }> = []
  const switchCalls: string[] = []
  const counters = { snapshots: 0, captures: 0, closeCount: 0 }
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
    captureSessionSwitch: () => {
      counters.captures += 1
      trace.push('capture-scope')
      return async sessionId => {
        switchCalls.push(sessionId)
        const outcome = options.switchOutcome ?? { kind: 'failed', message: 'fixture refusal' }
        return typeof outcome === 'function' ? outcome() : outcome
      }
    },
    closeWorkspace: () => { counters.closeCount += 1 },
    onChange: () => { counters.snapshots += 1 },
  })
  return {
    port,
    reader,
    controller,
    owned,
    switchCalls,
    trace,
    get captures() { return counters.captures },
    get closeCount() { return counters.closeCount },
    get snapshots() { return counters.snapshots },
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
/** The explicit reload is LOSSY: a dirty draft confirms first. */
function reloadNow(life: { controller: ScheduleWorkspaceController }): void {
  life.controller.dispatch({ kind: 'reload-latest' })
  if (life.controller.snapshot().confirm?.kind === 'reload') life.controller.dispatch({ kind: 'confirm' })
}

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
      entry({ id: 'schedule-b' as never, title: 'Alpha deploy', prompt: 'check logs', status: 'active' }),
      entry({ id: 'schedule-c' as never, title: 'Beta review', prompt: 'read imports', status: 'paused' }),
      entry({ id: 'schedule-d' as never, title: 'Gamma cleanup', prompt: 'remove artifacts', status: 'ended' }),
    ]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    const before = life.port.calls.length
    assert.deepEqual(life.controller.snapshot().statusCounts, { active: 2, paused: 1, ended: 1 })
    assert.equal(life.controller.snapshot().total, 4)

    for (const [filter, expectedRows] of [['active', 2], ['paused', 1], ['ended', 1], ['all', 4]] as const) {
      life.controller.dispatch({ kind: 'set-filter', filter })
      assert.equal(life.controller.snapshot().rows.length, expectedRows)
      assert.deepEqual(life.controller.snapshot().statusCounts, { active: 2, paused: 1, ended: 1 })
      assert.equal(life.controller.snapshot().total, 4)
    }
    life.controller.dispatch({ kind: 'set-query', query: 'IMPORTS' })
    assert.deepEqual(life.controller.snapshot().rows.map(row => row.title), ['Beta review'])
    life.controller.dispatch({ kind: 'set-query', query: 'zzz' })
    assert.deepEqual(life.controller.snapshot().rows, [])
    assert.deepEqual(life.controller.snapshot().statusCounts, { active: 2, paused: 1, ended: 1 })
    assert.equal(life.controller.snapshot().total, 4)
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
    captureSessionSwitch: () => async () => ({ kind: 'failed', message: 'unused' }),
    closeWorkspace: () => {},
  })
  try {
    controller.open()
    await flush()
    assert.equal(controller.snapshot().status, 'error')
    assert.deepEqual(controller.snapshot().rows, [])
    assert.deepEqual(controller.snapshot().statusCounts, { active: 0, paused: 0, ended: 0 })
    assert.equal(controller.snapshot().statusMessage, SCHEDULE_COPY.serviceUnavailable)
    port.entries = [entry({ status: 'active' }), entry({ id: 'schedule-paused' as never, status: 'paused' })]
    controller.dispatch({ kind: 'refresh' })
    await flush()
    assert.equal(controller.snapshot().status, 'ready')
    assert.deepEqual(controller.snapshot().statusCounts, { active: 1, paused: 1, ended: 0 })
    port.catalogError = new Error('boom')
    controller.dispatch({ kind: 'refresh' })
    await flush()
    assert.equal(controller.snapshot().status, 'stale')
    assert.equal(controller.snapshot().rows.length, 2, 'the last successful rows survive')
    assert.deepEqual(controller.snapshot().statusCounts, { active: 1, paused: 1, ended: 0 }, 'stale counts come from the retained catalog')
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
    life.port.entries = [entry({ title: 'After invalidation', status: 'paused' })]
    life.port.invalidate()
    gate.resolve([entry({ title: 'Obsolete', status: 'active' })])
    await flush()
    assert.equal(life.controller.snapshot().rows[0].title, 'After invalidation')
    assert.deepEqual(life.controller.snapshot().statusCounts, { active: 0, paused: 1, ended: 0 },
      'the committed counts follow the accepted invalidation read, not the obsolete epoch')
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
      timing: { kind: 'after', after_seconds: 3600 },
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
    assert.equal(life.controller.snapshot().editorRecovery, 'unknown')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.createUnknown)
    assert.equal(life.port.methods().filter(method => method === 'create').length, 1, 'never replayed')
    assert.equal(life.port.methods().filter(method => method === 'catalog').length, 2, 'the workspace re-read the Host')
    life.controller.dispatch({ kind: 'save' })
    await flush()
    assert.equal(life.port.methods().filter(method => method === 'create').length, 1, 'a settled unknown create stays locked')
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
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.runPendingInfo)
    assert.equal(life.controller.snapshot().notice?.kind, 'info')
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

test('a Detail conversation switch captures scope before fresh roster validation and follows the latest receipt receiver', async () => {
  const life = harness({ switchOutcome: { kind: 'committed', sessionId: 'session-b' } })
  try {
    const task = entry({
      target: { kind: 'session', sessionId: scheduleSessionId('session-a') },
      lastDelivery: {
        scheduledAt: '2026-01-01T09:00:00.000Z',
        deliveredAt: '2026-01-01T09:01:00.000Z',
        messageId: 'receipt-b' as never,
        targetSessionId: 'session-b' as never,
      },
    })
    life.port.entries = [task]
    life.reader.rows.push({ id: 'session-b', updatedAt: 3, live: false })
    life.reader.projections.set('session-b', { title: 'Beta' })
    life.controller.open()
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.trace.length = 0
    const freshRoster = deferred<SessionSummary[] | undefined>()
    life.reader.listGate = freshRoster

    life.controller.dispatch({ kind: 'open-detail-conversation' })
    assert.deepEqual(life.trace.slice(0, 2), ['capture-scope', 'roster-list'],
      'the current owner is frozen in the same synchronous turn before the fresh roster await')
    assert.equal(life.controller.snapshot().navigationPending, true)
    assert.deepEqual(life.switchCalls, [], 'the Session lifecycle is not called before roster revalidation')

    freshRoster.resolve(life.reader.rows)
    await flush()
    await flush()
    assert.deepEqual(life.switchCalls, ['session-b'], 'the last delivery receiver wins over the task current target')
    assert.equal(life.closeCount, 1, 'only a committed switch releases the Schedule lease')
  } finally {
    life.controller.dispose()
  }
})

test('a selected History receipt navigates to its own receiver and preserves its recorded prompt', async () => {
  const life = harness({ switchOutcome: { kind: 'already-current', message: 'already on this session' } })
  try {
    life.port.entries = [entry({ target: { kind: 'session', sessionId: scheduleSessionId('session-a') } })]
    life.reader.rows.push({ id: 'session-b', updatedAt: 3, live: false })
    life.port.historyResults.set('first', {
      id: 'schedule-1' as never,
      records: [{
        scheduledAt: '2026-01-01T09:00:00.000Z',
        deliveredAt: '2026-01-01T09:01:00.000Z',
        messageId: 'receipt-b' as never,
        targetSessionId: 'session-b' as never,
        prompt: 'the saved instruction, not the current task prompt',
      }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    life.controller.open()
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-history' })
    await flush()
    const history = life.controller.snapshot().history
    assert.equal(history?.records[0]?.targetSessionId, 'session-b')
    assert.equal(history?.records[0]?.prompt, 'the saved instruction, not the current task prompt')
    assert.deepEqual(history?.retention, { days: 30, records: 200 })

    life.controller.dispatch({ kind: 'open-delivery-conversation', messageId: 'receipt-b' })
    await flush()
    await flush()
    assert.deepEqual(life.switchCalls, ['session-b'])
    assert.equal(life.closeCount, 1, 'already-current is a successful settled navigation')
  } finally {
    life.controller.dispose()
  }
})

test('a rejected Session switch publishes its failure and retains the History lease without retry', async () => {
  const failure = new Error('Session switch exploded')
  const life = harness({ switchOutcome: async () => { throw failure } })
  try {
    const task = entry({
      target: { kind: 'session', sessionId: scheduleSessionId('session-a') },
      lastDelivery: {
        scheduledAt: '2026-01-01T09:00:00.000Z',
        deliveredAt: '2026-01-01T09:01:00.000Z',
        messageId: 'receipt-switch-reject' as never,
        targetSessionId: 'session-a' as never,
      },
    })
    life.port.entries = [task]
    life.port.historyResults.set('first', {
      id: task.id,
      records: [{
        scheduledAt: '2026-01-01T09:00:00.000Z',
        deliveredAt: '2026-01-01T09:01:00.000Z',
        messageId: 'receipt-switch-reject' as never,
        targetSessionId: 'session-a' as never,
        prompt: 'Saved receipt instruction',
      }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    life.controller.open()
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: task.id })
    await flush()
    life.controller.dispatch({ kind: 'open-history' })
    await flush()
    const selectedId = life.controller.snapshot().selectedId

    life.controller.dispatch({ kind: 'open-delivery-conversation', messageId: 'receipt-switch-reject' })
    await flush()
    await flush()
    assert.deepEqual(life.switchCalls, ['session-a'], 'one rejected transition is never retried')
    assert.equal(life.controller.snapshot().mode, 'history')
    assert.equal(life.controller.snapshot().selectedId, selectedId)
    assert.equal(life.controller.snapshot().notice?.kind, 'error')
    assert.equal(life.controller.snapshot().notice?.text, 'Session switch exploded')
    assert.equal(life.controller.snapshot().navigationPending, false)
    assert.equal(life.closeCount, 0, 'a rejected switch retains the existing workspace lease')
  } finally {
    life.controller.dispose()
  }
})

test('authorized Session navigation is not blocked by its optional title projection', async () => {
  const life = harness({ switchOutcome: { kind: 'committed', sessionId: 'session-a' } })
  try {
    life.controller.open()
    await flush()
    life.port.entries = [entry({
      target: { kind: 'session', sessionId: scheduleSessionId('session-a') },
      lastDelivery: {
        scheduledAt: '2026-01-01T09:00:00.000Z',
        deliveredAt: '2026-01-01T09:01:00.000Z',
        messageId: 'receipt-projection-pending' as never,
        targetSessionId: 'session-a' as never,
      },
    })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    const delayedTitles = deferred<Map<string, SessionProjectionSummary>>()
    life.reader.projectionGate = delayedTitles

    life.controller.dispatch({ kind: 'open-detail-conversation' })
    await flush()
    await flush()
    assert.equal(life.controller.snapshot().sessionRosterState, 'ready')
    assert.ok(life.controller.snapshot().availableSessionIds.includes('session-a'))
    assert.deepEqual(life.switchCalls, ['session-a'], 'the latest authorized roster reaches SessionRuntime before titles settle')
    assert.equal(life.closeCount, 1, 'a successful switch is not held by title presentation work')

    life.controller.dispose()
    delayedTitles.resolve(new Map([['session-a', { title: 'late stale title' }]]))
    await flush()
    assert.notEqual(life.controller.snapshot().sessions.find(session => session.id === 'session-a')?.title, 'late stale title',
      'after the successful close, a late projection cannot publish into the retired workspace')
  } finally {
    life.controller.dispose()
  }
})

test('a late Session title projection cannot overwrite a newer roster', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ target: { kind: 'session', sessionId: scheduleSessionId('session-a') } })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()

    const oldProjection = deferred<Map<string, SessionProjectionSummary>>()
    life.reader.projections.set('session-a', { title: 'current roster title' })
    life.reader.projectionGate = oldProjection
    life.controller.dispatch({ kind: 'refresh-session-roster' })
    await flush()
    await flush()
    assert.equal(life.controller.snapshot().sessionRosterState, 'ready',
      'Session IDs authorize links before optional title projection settles')

    life.controller.dispatch({ kind: 'refresh-session-roster' })
    await flush()
    await flush()
    assert.equal(life.controller.snapshot().sessions.find(session => session.id === 'session-a')?.title, 'current roster title')
    oldProjection.resolve(new Map([['session-a', { title: 'obsolete roster title' }]]))
    await flush()
    assert.equal(life.controller.snapshot().sessions.find(session => session.id === 'session-a')?.title, 'current roster title',
      'a projection captured by the replaced roster can never overwrite the current title')
  } finally {
    life.controller.dispose()
  }
})

test('an unavailable, failed, or unlisted fresh Session roster never dispatches a switch', async () => {
  const cases = [
    { label: 'undefined capability', setup: (reader: FakeSessionReader) => { reader.listResult = undefined }, copy: SCHEDULE_COPY.sessionRosterUnavailable },
    { label: 'read failure', setup: (reader: FakeSessionReader) => { reader.listError = new Error('roster failed') }, copy: SCHEDULE_COPY.sessionRosterError },
    { label: 'missing receiver', setup: (reader: FakeSessionReader) => { reader.listResult = [] }, copy: SCHEDULE_COPY.sessionNotListed },
  ] as const
  for (const scene of cases) {
    const life = harness()
    try {
      life.port.entries = [entry({ target: { kind: 'session', sessionId: scheduleSessionId('session-a') } })]
      life.controller.open()
      await flush()
      life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
      await flush()
      scene.setup(life.reader)
      life.controller.dispatch({ kind: 'open-detail-conversation' })
      await flush()
      await flush()
      assert.deepEqual(life.switchCalls, [], scene.label)
      assert.equal(life.closeCount, 0, scene.label)
      assert.equal(life.controller.snapshot().notice?.text, scene.copy, scene.label)
      assert.equal(life.controller.snapshot().navigationPending, false, scene.label)
    } finally {
      life.controller.dispose()
    }
  }
})

test('an undelivered new_once reservation is not treated as an existing conversation', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail-conversation' })
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.pendingFirstDelivery)
    assert.equal(life.captures, 0)
    assert.deepEqual(life.switchCalls, [])
  } finally {
    life.controller.dispose()
  }
})

test('executionActive blocks Run, pause and delete without opening confirmation or writing', async () => {
  const life = harness()
  try {
    life.port.entries = [entry({ executionActive: true })]
    life.controller.open()
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    for (const kind of ['ask-run', 'toggle-active', 'ask-delete'] as const) {
      life.controller.dispatch({ kind })
      assert.equal(life.controller.snapshot().confirm, undefined, `${kind} has no confirmation`)
      assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.executionBusy)
    }
    assert.equal(life.port.calls.some(call => call.method === 'run' || call.method === 'edit'), false)
  } finally {
    life.controller.dispose()
  }
})

test('execution that starts while Run confirmation is open is refused before the Host write', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'ask-run' })
    assert.equal(life.controller.snapshot().confirm?.kind, 'run')
    life.port.entries = [entry({ executionActive: true, updatedAt: '2026-01-02T00:00:00.000Z' })]
    life.port.viewResults.set('schedule-1', life.port.entries[0]!)
    life.port.invalidate()
    await flush()
    life.controller.dispatch({ kind: 'confirm' })
    assert.equal(life.port.calls.some(call => call.method === 'run'), false)
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.executionBusy)
  } finally {
    life.controller.dispose()
  }
})

test('a Host floor never disables Run for paused/ended tasks and an archived refusal stays explicit', async () => {
  const life = harness()
  try {
    life.port.entries = [
      entry({ id: 'schedule-paused' as never, status: 'paused', deliveryFloorEndsAt: '2099-01-01T00:00:00.000Z' }),
      entry({ id: 'schedule-ended' as never, status: 'ended', deliveryFloorEndsAt: '2099-01-01T00:00:00.000Z' }),
    ]
    life.controller.open()
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-paused' })
    await flush()
    life.port.runResult = async request => entry({ id: request.id, status: 'paused' })
    life.controller.dispatch({ kind: 'ask-run' })
    assert.equal(life.controller.snapshot().confirm?.kind, 'run', 'a delivery floor is display-only')
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    assert.equal((life.port.calls.find(call => call.method === 'run')?.args[0] as ScheduleRunRequest).id, 'schedule-paused')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.deliveryQueued)

    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-ended' })
    await flush()
    life.port.runResult = async () => { throw Object.assign(new Error('target refusal'), { code: 'schedule/target-archived' }) }
    life.controller.dispatch({ kind: 'ask-run' })
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.targetArchived)
    assert.equal(life.controller.snapshot().notice?.kind, 'error')
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

test('L6: every guided timing preset selects its official rule without translating advanced text', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'every-seconds' })
    assert.deepEqual(life.controller.snapshot().editor?.timing, {
      kind: 'every', everySeconds: '60', quantityUnit: 'seconds',
    })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'once-after' })
    const expected = [
      ['once-after', 'after'],
      ['once-at', 'at'],
      ['every-minutes', 'every'],
      ['every-hours', 'every'],
      ['every-seconds', 'every'],
      ['daily', 'daily'],
      ['weekly', 'weekly'],
      ['cron', 'cron'],
      ['rrule', 'rrule'],
    ] as const
    for (const [preset, kind] of expected) {
      life.controller.dispatch({ kind: 'select-timing-preset', preset })
      const timing = life.controller.snapshot().editor?.timing
      assert.equal(timing?.kind, kind, `${preset} selects the intended official kind`)
      if (preset === 'once-at') {
        assert.equal(timing?.kind === 'at' ? timing.timeZone : undefined, 'UTC')
        assert.match(timing?.kind === 'at' ? timing.time : '', /^\d{2}:\d{2}:\d{2}$/u)
      }
      if (preset === 'every-seconds') {
        assert.deepEqual(timing, { kind: 'every', everySeconds: '3600', quantityUnit: 'seconds' })
      }
      if (preset === 'rrule') {
        assert.match(timing?.kind === 'rrule' ? timing.rrule : '', /^DTSTART:\d{8}T\d{6}Z\nRRULE:FREQ=DAILY$/u)
      }
    }
  } finally {
    life.controller.dispose()
  }
})

test('L6: selecting the current Once-after preset preserves its exact stored seconds', async () => {
  for (const seconds of [90, 61, 3600]) {
    const life = await opened()
    try {
      life.port.entries = [entry({ kind: 'after', afterSeconds: seconds })]
      life.controller.dispatch({ kind: 'refresh' })
      await flush()
      life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
      await flush()
      life.controller.dispatch({ kind: 'open-edit' })
      await flush()

      const original = life.controller.snapshot().editor?.timing
      assert.deepEqual(original, {
        kind: 'after',
        afterSeconds: String(seconds),
        quantityUnit: seconds % 3600 === 0 ? 'hours' : 'seconds',
      })
      life.controller.dispatch({ kind: 'select-timing-preset', preset: 'once-after' })
      assert.deepEqual(life.controller.snapshot().editor?.timing, original,
        `reselecting Once-after does not change ${seconds} stored seconds`)

      life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Renamed' })
      life.port.editResult = async request => {
        if (request.action !== 'update') throw new Error('expected one update request')
        assert.deepEqual(request.patch, { title: 'Renamed' }, 'reselecting Once-after adds no timing patch')
        return entry({ title: 'Renamed', kind: 'after', afterSeconds: seconds })
      }
      life.controller.dispatch({ kind: 'save' })
      await flush()
      await life.controller.whenIdle()
      const request = life.port.calls.find(call => call.method === 'edit')?.args[0] as ScheduleEditRequest
      if (request.action !== 'update') throw new Error('expected one update request')
      assert.deepEqual(request.patch, { title: 'Renamed' })
    } finally {
      life.controller.dispose()
    }
  }
})

test('L6: guided timing presets convert quantities without rounding the current rule', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-create' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Interval' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Run interval task' })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'every-minutes' })
    assert.deepEqual(life.controller.snapshot().editor?.timing, {
      kind: 'every', everySeconds: '60', quantityUnit: 'minutes',
    })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'timing-quantity', value: '90' })
    assert.deepEqual(life.controller.snapshot().editor?.timing, {
      kind: 'every', everySeconds: '5400', quantityUnit: 'minutes',
    })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'every-hours' })
    assert.deepEqual(life.controller.snapshot().editor?.timing, {
      kind: 'every', everySeconds: '3600', quantityUnit: 'hours',
    }, 'a non-exact unit conversion starts at one selected unit instead of rounding')
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'every-minutes' })
    assert.deepEqual(life.controller.snapshot().editor?.timing, {
      kind: 'every', everySeconds: '3600', quantityUnit: 'minutes',
    }, 'after an explicit non-exact unit switch, the current rule stays at one hour')
    life.port.createResult = async request => {
      assert.deepEqual(request.timing, { kind: 'every', every_seconds: 3600 })
      return entry({ id: 'schedule-interval' as never, kind: 'every', everySeconds: 3600 })
    }
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.port.methods().filter(method => method === 'create').length, 1)
  } finally {
    life.controller.dispose()
  }
})

test('L6: unknown edit blocks repeated writes until a successful Review read', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'My title' })
    life.port.editResult = async () => { throw new ScheduleOutcomeUnknownError('lost edit reply') }
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().editorRecovery, 'unknown')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.editorUnknown)
    life.controller.dispatch({ kind: 'save' })
    await flush()
    assert.equal(life.port.methods().filter(method => method === 'edit').length, 1)

    const pending = deferred<ScheduleViewResult>()
    life.port.viewQueue = [pending.promise]
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Typed during Review' })
    pending.resolve(entry({ title: 'Host title', prompt: 'Host prompt', updatedAt: '2026-01-04T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().editorRecovery, 'unknown')
    assert.equal(life.controller.snapshot().editor?.title, 'My title')
    assert.equal(life.controller.snapshot().editor?.prompt, 'Typed during Review',
      'a local edit invalidates the pending Review answer')

    life.port.viewResults.set('schedule-1', entry({
      title: 'Host title', prompt: 'Host prompt', updatedAt: '2026-01-05T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    assert.equal(life.controller.snapshot().editorRecovery, undefined)
    assert.equal(life.controller.snapshot().editor?.title, 'My title')
    assert.equal(life.controller.snapshot().editor?.prompt, 'Typed during Review')
    life.port.editResult = async () => entry({ title: 'My title', prompt: 'Typed during Review' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    assert.deepEqual(edits[1]?.args[0], {
      id: 'schedule-1',
      action: 'update',
      patch: { title: 'My title', prompt: 'Typed during Review' },
      expectedUpdatedAt: '2026-01-05T00:00:00.000Z',
    })
  } finally {
    life.controller.dispose()
  }
})

test('L6: a missing edit keeps the draft and never becomes a Create or retry path', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Keep draft' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_not_found' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().editorRecovery, 'missing')
    life.controller.dispatch({ kind: 'save' })
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    life.controller.dispatch({ kind: 'reload-latest' })
    await flush()
    assert.equal(life.controller.snapshot().confirm, undefined, 'missing does not offer reload as a task recreation path')
    assert.equal(life.port.methods().filter(method => method === 'edit').length, 1)
    assert.equal(life.port.methods().filter(method => method === 'create').length, 0)
    assert.equal(life.controller.snapshot().editor?.title, 'Keep draft')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a failed conflict Review read keeps the recovery lock and complete draft', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Conflict draft' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const failedRead = deferred<ScheduleViewResult>()
    life.port.viewQueue = [failedRead.promise]
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    failedRead.reject(new Error('review read failed'))
    await flush()
    assert.equal(life.controller.snapshot().editorRecovery, 'conflict')
    assert.equal(life.controller.snapshot().editor?.title, 'Conflict draft')
    assert.match(life.controller.snapshot().notice?.text ?? '', /review read failed/u)
    life.controller.dispatch({ kind: 'save' })
    await flush()
    assert.equal(life.port.methods().filter(method => method === 'edit').length, 1)
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
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'cron' })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'daily' })
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
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'daily' })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'cron' })
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

test('L6: a conflicted edit reviews the latest Host groups and saves only the merged user patch', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()

    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Local prompt' })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'weekly' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'timing-time', value: '10:30' })
    life.controller.dispatch({ kind: 'select-target-kind', target: 'new' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()

    assert.equal(life.controller.snapshot().editorRecovery, 'conflict')
    assert.equal(life.port.calls.filter(call => call.method === 'edit').length, 1)
    life.port.viewResults.set('schedule-1', entry({
      title: 'Host title',
      time: '08:00:00',
      target: { kind: 'session', sessionId: scheduleSessionId('session-a') },
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()

    const reviewed = life.controller.snapshot()
    assert.equal(reviewed.editorRecovery, undefined)
    assert.equal(reviewed.editor?.title, 'Host title', 'Host-only title is adopted')
    assert.equal(reviewed.editor?.prompt, 'Local prompt', 'local-only prompt is preserved')
    assert.deepEqual(reviewed.editor?.timing, {
      kind: 'weekly', time: '10:30', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5],
    }, 'the locally changed timing group wins')
    assert.equal(reviewed.editor?.target.kind, 'new', 'the locally changed destination group wins')
    assert.equal(reviewed.editor?.expectedUpdatedAt, '2026-01-02T00:00:00.000Z')
    assert.equal(reviewed.notice?.text, SCHEDULE_COPY.bothChanged('Repeat/Destination'))
    assert.equal(life.port.calls.filter(call => call.method === 'edit').length, 1, 'Review is a read and performs no write')

    life.port.editResult = async () => entry({ title: 'Host title', prompt: 'Local prompt' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    assert.deepEqual(edits[1]?.args[0], {
      id: 'schedule-1',
      action: 'update',
      patch: {
        prompt: 'Local prompt',
        timing: { kind: 'weekly', weekly: { time: '10:30:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] } },
        target: { kind: 'new' },
      },
      expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
    })
  } finally {
    life.controller.dispose()
  }
})

test('L6: Review reports a shared final value as already matching and never writes again', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Merged title' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()

    life.port.viewResults.set('schedule-1', entry({
      title: 'Merged title',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    assert.equal(life.controller.snapshot().editorDirty, false)
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.hostMatchesWithOverlap('Title'))
    assert.equal(life.port.calls.filter(call => call.method === 'edit').length, 1)

    life.controller.dispatch({ kind: 'save' })
    await flush()
    assert.equal(life.port.calls.filter(call => call.method === 'edit').length, 1, 'a clean reviewed draft sends no Host write')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.hostMatchesWithOverlap('Title'),
      'Ctrl+S keeps the truthful already-matches result')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a Review read settles into the same Editor under Help and keeps its rebased draft', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local title' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()

    const read = deferred<ScheduleViewResult>()
    life.port.viewQueue = [read.promise]
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    life.controller.dispatch({ kind: 'open-help' })
    assert.equal(life.controller.snapshot().mode, 'help')
    read.resolve(entry({ title: 'Remote title', updatedAt: '2026-01-11T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().mode, 'help')
    assert.equal(life.controller.snapshot().editor?.title, 'Local title')
    assert.equal(life.controller.snapshot().editor?.expectedUpdatedAt, '2026-01-11T00:00:00.000Z')
    life.controller.dispatch({ kind: 'close-help' })
    assert.equal(life.controller.snapshot().mode, 'editor')
    assert.equal(life.controller.snapshot().editor?.title, 'Local title')
  } finally {
    life.controller.dispose()
  }
})

test('L6: opening the lossy reload confirmation cancels an older Review answer', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local title' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()

    const read = deferred<ScheduleViewResult>()
    life.port.viewQueue = [read.promise]
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    life.controller.dispatch({ kind: 'reload-latest' })
    assert.equal(life.controller.snapshot().confirm?.kind, 'reload')
    read.resolve(entry({ title: 'Late Host title', updatedAt: '2026-01-12T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().confirm?.kind, 'reload')
    assert.equal(life.controller.snapshot().editorRecovery, 'conflict')
    assert.equal(life.controller.snapshot().editor?.title, 'Local title')
    life.controller.dispatch({ kind: 'cancel' })
    assert.equal(life.controller.snapshot().editor?.title, 'Local title')
    assert.equal(life.controller.snapshot().editorRecovery, 'conflict')
  } finally {
    life.controller.dispose()
  }
})

test('L6: a Review answer from Editor A cannot replace the newly opened Editor B', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({ id: 'schedule-a' as never, title: 'A' }), entry({ id: 'schedule-b' as never, title: 'B' })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-a' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local A' })
    life.port.editResult = async () => ({ id: 'schedule-a' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()

    const oldRead = deferred<ScheduleViewResult>()
    life.port.viewResults.set('schedule-a', oldRead.promise)
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    life.controller.dispatch({ kind: 'back' })
    life.controller.dispatch({ kind: 'confirm' })
    assert.equal(life.controller.snapshot().mode, 'detail')
    life.controller.dispatch({ kind: 'back' })
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-b' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'B')
    oldRead.resolve(entry({ id: 'schedule-a' as never, title: 'Late A', updatedAt: '2026-01-13T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().editor?.id, 'schedule-b')
    assert.equal(life.controller.snapshot().editor?.title, 'B')
    assert.equal(life.controller.snapshot().editorRecovery, undefined)
  } finally {
    life.controller.dispose()
  }
})

test('L6: a Review answer settling after dispose publishes nothing', async () => {
  const life = await opened()
  life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
  await flush()
  life.controller.dispatch({ kind: 'open-edit' })
  await flush()
  life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local title' })
  life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
  life.controller.dispatch({ kind: 'save' })
  await flush()
  await life.controller.whenIdle()
  const read = deferred<ScheduleViewResult>()
  life.port.viewQueue = [read.promise]
  life.controller.dispatch({ kind: 'review-with-my-edits' })
  await flush()
  let publications = 0
  life.controller.subscribe(() => { publications += 1 })
  life.controller.dispose()
  const settledPublications = publications
  read.resolve(entry({ title: 'Late Host', updatedAt: '2026-01-14T00:00:00.000Z' }))
  await flush()
  assert.equal(publications, settledPublications)
  assert.equal(life.controller.snapshot().editor?.title, 'Local title')
})

test('L6: Review settles without restoring a stale field focus', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local title' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()

    const read = deferred<ScheduleViewResult>()
    life.port.viewQueue = [read.promise]
    life.controller.dispatch({ kind: 'review-with-my-edits' })
    await flush()
    life.controller.dispatch({ kind: 'focus-field', index: 1 })
    assert.equal(life.controller.snapshot().editor?.focused, 1)
    read.resolve(entry({
      title: 'Host title',
      prompt: 'Host prompt',
      updatedAt: '2026-01-15T00:00:00.000Z',
    }))
    await flush()
    const editor = life.controller.snapshot().editor
    assert.equal(editor?.focused, 1)
    assert.equal(editorFields(editor!).map(field => field.id)[editor!.focused], 'prompt')
  } finally {
    life.controller.dispose()
  }
})

test('L6: Reload settles without restoring a stale field focus', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local title' })

    const read = deferred<ScheduleViewResult>()
    life.port.viewQueue = [read.promise]
    life.controller.dispatch({ kind: 'reload-latest' })
    assert.equal(life.controller.snapshot().confirm?.kind, 'reload')
    life.controller.dispatch({ kind: 'confirm' })
    await flush()
    life.controller.dispatch({ kind: 'focus-field', index: 1 })
    read.resolve(entry({
      title: 'Host title',
      prompt: 'Host prompt',
      updatedAt: '2026-01-16T00:00:00.000Z',
    }))
    await flush()
    const editor = life.controller.snapshot().editor
    assert.equal(editor?.focused, 1)
    assert.equal(editorFields(editor!).map(field => field.id)[editor!.focused], 'prompt')
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
    reloadNow(life)
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded)
    assert.equal(life.controller.snapshot().editor?.title, 'B', "the editor now displays the Host's newer value")
    assert.equal(life.controller.snapshot().editor?.prompt, 'P', 'no automatic field-level merge carries the old edit')

    // The user re-applies the prompt change manually on top of the latest facts.
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'P2' })
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

test('L6: reload-latest shows the Host value for a field edited on both sides', async () => {
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
    reloadNow(life)
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded)
    assert.equal(life.controller.snapshot().editor?.prompt, 'Theirs',
      'the Host value is displayed; the user decides what to re-apply')
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Mine' })
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
    reloadNow(life)
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'B')
    assert.equal(life.controller.snapshot().editor?.prompt, 'P', 'the old edit is not carried automatically')
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'P2' })

    // Second reload: the title changed AGAIN (B -> C) while the user still only
    // edits the prompt. The adopted B must not be mistaken for user intent.
    life.port.viewResults.set('schedule-1', entry({ title: 'C', prompt: 'P', updatedAt: '2026-01-03T00:00:00.000Z' }))
    reloadNow(life)
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'C', 'the editor shows the Host each time')
    assert.equal(life.controller.snapshot().editor?.prompt, 'P', 'still no automatic carry-over')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded)
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'P2' })

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

test('L6: reload never re-sends a reverted or old draft value', async () => {
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
    life.port.viewResults.set('schedule-1', entry({ title: 'B', prompt: 'P', updatedAt: '2026-01-02T00:00:00.000Z' }))
    reloadNow(life)
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'B')
    assert.equal(life.controller.snapshot().editor?.prompt, 'P')
    life.controller.dispatch({ kind: 'save' })
    await flush()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.reloaded)
    assert.equal(life.port.calls.some(call => call.method === 'edit'), false,
      'a reverted/old draft value is never sent on the new revision')
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
    reloadNow(life)
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
    reloadNow(life)
    reloadNow(life)
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
    reloadNow(life)
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
    reloadNow(life)
    reloadNow(life)
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
    reloadNow(life)
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
    reloadNow(life)
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

test('L6: a reload started before a save cannot rewrite the pending save', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Draft title' })
    const reload = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload.promise]
    reloadNow(life)
    const save = deferred<ScheduleEditResult>()
    life.port.editResult = () => save.promise
    life.controller.dispatch({ kind: 'save' })
    assert.equal(life.controller.snapshot().busy, true)
    // The reload settles while the save is pending: it must not touch the draft
    // or the revision the save already fixed.
    reload.resolve(entry({ title: 'Host newer', prompt: 'Host prompt', updatedAt: '2026-01-09T00:00:00.000Z' }))
    await flush()
    save.resolve(entry({ title: 'Draft title', updatedAt: '2026-01-10T00:00:00.000Z' }))
    await flush()
    await life.controller.whenIdle()
    const edits = life.port.calls.filter(call => call.method === 'edit')
    const request = edits[edits.length - 1]?.args[0] as Extract<ScheduleEditRequest, { action: 'update' }> | undefined
    assert.deepEqual(request?.patch, { title: 'Draft title' })
    assert.equal(request?.expectedUpdatedAt, '2026-01-01T08:00:00.000Z',
      'the save keeps the revision it captured, not the reload answer')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an in-flight reload never overwrites input typed while it waits', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const titleBefore = life.controller.snapshot().editor?.title
    const reload = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload.promise]
    reloadNow(life)
    // The user keeps typing while the read is in flight.
    life.controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'typed while waiting' })
    reload.resolve(entry({ title: 'Host', prompt: 'Host prompt', updatedAt: '2026-01-09T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().editor?.prompt, 'typed while waiting',
      'the user edit survives the older reload answer')
    assert.equal(life.controller.snapshot().editor?.title, titleBefore, 'the reload did not replace the other field either')
  } finally {
    life.controller.dispose()
  }
})

test('L6: an in-flight reload cannot overwrite the conflict draft a save just kept', async () => {
  const life = await opened()
  try {
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const reload = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload.promise]
    reloadNow(life)
    life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Conflicted draft' })
    life.port.editResult = async () => ({ id: 'schedule-1' as never, code: 'schedule_conflict' })
    life.controller.dispatch({ kind: 'save' })
    await flush()
    await life.controller.whenIdle()
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)
    reload.resolve(entry({ title: 'Host newer', prompt: 'Host prompt', updatedAt: '2026-01-09T00:00:00.000Z' }))
    await flush()
    assert.equal(life.controller.snapshot().editor?.title, 'Conflicted draft',
      'the conflict draft is preserved, not the stale reload answer')
    assert.equal(life.controller.snapshot().notice?.text, SCHEDULE_COPY.conflict)
  } finally {
    life.controller.dispose()
  }
})

test('L6: an explicit reload clears the per-kind field memories it replaced', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({
      kind: 'cron',
      expression: '0 17 * * 1-5',
      timeZone: 'UTC',
    })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    // Build a per-kind memory for the daily editor.
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'daily' })
    life.controller.dispatch({ kind: 'set-field', fieldId: 'timing-time', value: '23:45' })
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'cron' })
    life.port.viewResults.set('schedule-1', entry({
      kind: 'cron',
      expression: '0 9 * * *',
      timeZone: 'UTC',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    reloadNow(life)
    await flush()
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'daily' })
    const timing = life.controller.snapshot().editor?.timing
    assert.equal(timing?.kind === 'daily' ? timing.time : undefined, '09:00:00',
      'the old 23:45 memory was cleared by the explicit reload')
  } finally {
    life.controller.dispose()
  }
})

test('L6: every accepted draft mutation supersedes an in-flight reload', async () => {
  const life = await opened()
  try {
    life.port.entries = [entry({
      kind: 'cron',
      expression: '0 17 * * 1-5',
      timeZone: 'UTC',
      target: { kind: 'new_once', sessionId: 'reserved' as never, create: { cwd: '/work' } },
    })]
    life.controller.dispatch({ kind: 'refresh' })
    await flush()
    life.controller.dispatch({ kind: 'open-detail', id: 'schedule-1' })
    await flush()
    life.controller.dispatch({ kind: 'open-edit' })
    await flush()
    const host = entry({
      kind: 'cron',
      expression: '0 9 * * *',
      timeZone: 'UTC',
      target: { kind: 'new_once', sessionId: 'reserved' as never, create: { cwd: '/host' } },
      updatedAt: '2026-01-09T00:00:00.000Z',
    })

    const reload1 = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload1.promise]
    reloadNow(life)
    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'daily' })
    reload1.resolve(host)
    await flush()
    assert.equal(life.controller.snapshot().editor?.timing.kind, 'daily',
      'a timing-kind change typed during the reload survives')

    life.controller.dispatch({ kind: 'select-timing-preset', preset: 'weekly' })
    const reload2 = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload2.promise]
    reloadNow(life)
    life.controller.dispatch({ kind: 'toggle-weekday', weekday: 6 })
    reload2.resolve(host)
    await flush()
    const weekly = life.controller.snapshot().editor?.timing
    assert.equal(weekly?.kind === 'weekly' ? weekly.weekdays.includes(6) : false, true,
      'a weekday toggle made during the reload survives')

    const reload3 = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload3.promise]
    reloadNow(life)
    life.controller.dispatch({ kind: 'select-target-kind', target: 'new' })
    reload3.resolve(host)
    await flush()
    assert.equal(life.controller.snapshot().editor?.target.kind, 'new',
      'a target-kind change made during the reload survives')

    const reload4 = deferred<ScheduleViewResult>()
    life.port.viewQueue = [reload4.promise]
    reloadNow(life)
    life.controller.dispatch({ kind: 'select-target-session', sessionId: 'session-9' })
    reload4.resolve(host)
    await flush()
    const target = life.controller.snapshot().editor?.target
    assert.equal(target?.kind === 'session' ? target.sessionId : undefined, 'session-9',
      'a Session selection made during the reload survives')
  } finally {
    life.controller.dispose()
  }
})
