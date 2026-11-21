import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import { captureScheduleSessionSwitch, openScheduleWorkspace } from '../../src/app/schedule/runtime.ts'
import { TuiApp } from '../../src/tui-app.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  SchedulePort,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleViewRequest,
  ScheduleViewResult,
} from '../../src/runtime/schedule-port.ts'
import type { SessionReader, SessionSummary } from '../../src/runtime/session-reader-port.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function scheduleEntry(): ScheduleCatalogEntry {
  return {
    id: 'schedule-nav' as never,
    kind: 'daily',
    title: 'Morning report',
    prompt: 'Current task prompt',
    time: '09:00:00',
    timeZone: 'UTC',
    scheduledAt: '2026-06-01T09:00:00.000Z',
    target: { kind: 'session', sessionId: 'session-current-target' as never },
    lastDelivery: {
      scheduledAt: '2026-06-01T09:00:00.000Z',
      deliveredAt: '2026-06-01T09:01:00.000Z',
      messageId: 'receipt-message' as never,
      targetSessionId: 'session-receipt-target' as never,
    },
    involvedSessionIds: [],
    status: 'active',
    updatedAt: '2026-06-01T08:00:00.000Z',
  }
}

function createSchedulePort(entry: ScheduleCatalogEntry): SchedulePort {
  return {
    async catalog() { return [entry] },
    async list(_request: ScheduleListRequest): Promise<ScheduleListResult> {
      return { items: [entry], shown: 1, total: 1, limit: 20, offset: 0 }
    },
    async view(_request: ScheduleViewRequest): Promise<ScheduleViewResult> { return entry },
    async history(_request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
      return {
        id: entry.id,
        records: [{
          scheduledAt: '2026-06-01T09:00:00.000Z',
          deliveredAt: '2026-06-01T09:01:00.000Z',
          messageId: 'receipt-message' as never,
          targetSessionId: 'session-receipt-target' as never,
          prompt: 'Stored delivery instruction',
        }],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
      }
    },
    async deliveryLimits() { return { newSessionIntervalSeconds: 60 } },
    async create(): Promise<ScheduleCatalogEntry> { throw new Error('not used') },
    async edit(_request: ScheduleEditRequest): Promise<ScheduleEditResult> { throw new Error('not used') },
    async run(_request: ScheduleRunRequest): Promise<ScheduleRunResult> { throw new Error('not used') },
    async deleteInactive() { throw new Error('not used') },
    onChanged() { return () => {} },
  }
}

interface Life {
  readonly app: TuiApp
  readonly generation: { value: number }
  readonly events: string[]
  readonly scopeAuthority: ReturnType<typeof createSessionScopeAuthority>
  readonly switchTargets: string[]
  readonly terminal: VirtualTerminal
  readonly owned: Promise<void>[]
  readonly reader: SessionReader
  rosterGate?: ReturnType<typeof deferred<SessionSummary[] | undefined>>
  dispose(): void
}

function createLife(): Life {
  const terminal = new VirtualTerminal(100, 30)
  const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const generation = { value: 1 }
  const events: string[] = []
  const scopeAuthority = createSessionScopeAuthority({
    current: () => ({ subject: undefined, sessionId: undefined, generation: generation.value }),
    isSubjectCurrent: () => false,
  })
  const switchTargets: string[] = []
  const rows: SessionSummary[] = [
    { id: 'session-current-target', updatedAt: 3, live: false },
    { id: 'session-receipt-target', updatedAt: 2, live: false },
  ]
  const owned: Promise<void>[] = []
  const rosterState: { gate: ReturnType<typeof deferred<SessionSummary[] | undefined>> | undefined } = { gate: undefined }
  const reader: SessionReader = {
    async list(_currentSessionId, _signal) {
      events.push('roster-list')
      if (rosterState.gate !== undefined) {
        const pending = rosterState.gate
        rosterState.gate = undefined
        return pending.promise
      }
      return rows
    },
    async projectionBatch() { return new Map() },
    async search() { return undefined },
    blank() { return undefined },
    measureContext() { return undefined },
    turnOutline() { return undefined },
    sessionStatus() { return undefined },
  }
  const life: Life = {
    app,
    generation,
    events,
    scopeAuthority,
    switchTargets,
    terminal,
    owned,
    get rosterGate() { return rosterState.gate },
    set rosterGate(value) { rosterState.gate = value },
    reader,
    dispose: () => { app.dispose() },
  }
  return life
}

function open(life: Life): void {
  const result = openScheduleWorkspace({
    port: createSchedulePort(scheduleEntry()),
    sessionReader: life.reader,
    runOwned: (_label, task) => { life.owned.push(task()) },
    captureSessionSwitch: () => {
      const scope = life.scopeAuthority.capture()
      life.events.push('capture-scope')
      return async sessionId => {
        life.switchTargets.push(sessionId)
        return life.scopeAuthority.isCurrent(scope)
          ? { kind: 'committed', sessionId }
          : { kind: 'superseded', message: 'the session changed before this switch could start' }
      }
    },
    app: () => life.app,
  })
  assert.deepEqual(result, { kind: 'success' })
}

async function drainOwned(life: Life): Promise<void> {
  while (life.owned.length > 0) await life.owned.shift()
}

async function waitForFrame(life: Life, predicate: (frame: string) => boolean): Promise<string> {
  for (let turn = 0; turn < 40; turn += 1) {
    await drainOwned(life)
    await life.terminal.waitForRender()
    const frame = life.terminal.getViewport().map(stripTerminalSequences).join('\n')
    if (predicate(frame)) return frame
    await flush()
  }
  assert.fail(`the expected Schedule frame did not paint:\n${life.terminal.getViewport().join('\n')}`)
}

async function openHistory(life: Life): Promise<void> {
  await waitForFrame(life, frame => frame.includes('Morning report'))
  life.terminal.sendInput('\r')
  await waitForFrame(life, frame => frame.includes('Schedule · Details'))
  life.terminal.sendInput('h')
  await waitForFrame(life, frame => frame.includes('Stored delivery instruction'))
}

test('the production Schedule switch closure passes its pre-roster SessionScope after the await', async () => {
  const generation = { value: 7 }
  const authority = createSessionScopeAuthority({
    current: () => ({ subject: undefined, sessionId: undefined, generation: generation.value }),
    isSubjectCurrent: () => false,
  })
  const rosterRead = deferred<SessionSummary[] | undefined>()
  const capturedGenerations: number[] = []
  const dispatched: string[] = []
  const captureSessionSwitch = captureScheduleSessionSwitch(
    () => {
      capturedGenerations.push(generation.value)
      return authority.capture()
    },
    async (sessionId, expectedScope) => {
      dispatched.push(sessionId)
      return authority.isCurrent(expectedScope)
        ? { kind: 'committed', sessionId }
        : { kind: 'superseded', message: 'the session changed before this switch could start' }
    },
  )

  const switchCapturedScope = captureSessionSwitch()
  assert.deepEqual(capturedGenerations, [7], 'the production callback captures once synchronously before any roster await')
  const pendingSwitch = (async () => {
    const rows = await rosterRead.promise
    assert.ok(rows?.some(row => row.id === 'session-receipt-target'))
    return switchCapturedScope('session-receipt-target')
  })()
  generation.value += 1
  rosterRead.resolve([{ id: 'session-receipt-target', updatedAt: 1, live: false }])
  assert.deepEqual(await pendingSwitch, {
    kind: 'superseded', message: 'the session changed before this switch could start',
  })
  assert.deepEqual(dispatched, ['session-receipt-target'])
})

test('real VirtualTerminal History input routes the receipt receiver through the lease close callback', async () => {
  const life = createLife()
  try {
    open(life)
    await drainOwned(life)
    await openHistory(life)
    life.events.length = 0
    life.terminal.sendInput('\r')
    const frame = await waitForFrame(life, current => !current.includes('Schedule · History'))
    assert.deepEqual(life.events.slice(0, 2), ['capture-scope', 'roster-list'])
    assert.deepEqual(life.switchTargets, ['session-receipt-target'],
      'the selected official receipt receiver is used instead of the task current target')
    assert.ok(!frame.includes('Schedule · History'), 'a committed Session outcome releases the real TuiApp lease')
  } finally {
    life.dispose()
  }
})

test('a SessionScope superseded during fresh roster validation keeps the History lease open', async () => {
  const life = createLife()
  try {
    open(life)
    await drainOwned(life)
    await openHistory(life)
    const gate = deferred<SessionSummary[] | undefined>()
    life.rosterGate = gate
    life.events.length = 0
    life.terminal.sendInput('\r')
    for (let turn = 0; turn < 20 && !life.events.includes('roster-list'); turn += 1) await flush()
    assert.deepEqual(life.events.slice(0, 2), ['capture-scope', 'roster-list'])
    const navigation = life.owned.shift()
    assert.ok(navigation !== undefined, 'the real History key created one owned navigation task')
    life.generation.value += 1
    gate.resolve([
      { id: 'session-current-target', updatedAt: 3, live: false },
      { id: 'session-receipt-target', updatedAt: 2, live: false },
    ])
    await navigation
    await life.terminal.waitForRender()
    const frame = life.terminal.getViewport().map(stripTerminalSequences).join('\n')
    assert.ok(frame.includes('Schedule · History'), 'a superseded result never closes the physical lease')
    assert.ok(frame.includes('the session changed before this switch could start'))
    assert.deepEqual(life.switchTargets, ['session-receipt-target'])
  } finally {
    life.dispose()
  }
})
