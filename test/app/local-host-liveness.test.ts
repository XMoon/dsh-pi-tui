/**
 * Host-liveness observer contracts: source classification, priority, epoch
 * invalidation, bounded reads and subscription cleanup.
 *
 * These are unit-level proofs against the real observer class with narrow
 * structural fakes for the official Host services. The real two-PID
 * source→status evidence lives in `scripts/split-process-smoke.mjs`.
 *
 * @module @xmoon76/dsh-pi-tui/local-host-liveness.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  HostActivityObserver,
  type HostActivitySnapshot,
} from '../../src/app/remote-process/host-liveness.ts'
import { createControlDispatcher } from '../../src/app/remote-process/entry-control.ts'

interface FakeAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly inbox: {
    readonly nextTurn: readonly unknown[]
    readonly nextStep: readonly unknown[]
  }
  readonly session?: unknown
}

interface FakeJob {
  readonly id: string
  readonly status: string
  readonly owner?: string
  readonly label?: string
}

function agent(
  id: string,
  status: 'idle' | 'running',
  pending: { readonly nextTurn?: number; readonly nextStep?: number } = {},
): FakeAgent {
  return {
    id,
    status,
    inbox: {
      nextTurn: Array.from({ length: pending.nextTurn ?? 0 }, (_value, index) => ({ text: `${id}:turn:${String(index)}` })),
      nextStep: Array.from({ length: pending.nextStep ?? 0 }, (_value, index) => ({ text: `${id}:step:${String(index)}` })),
    },
  }
}

/** Provide the minimal official AgentRegistry view. */
function provideAgents(
  context: Context,
  agents: readonly FakeAgent[],
  options: { readonly roots?: readonly FakeAgent[]; readonly listThrows?: boolean } = {},
): void {
  context.provide('agents', {
    list: () => {
      if (options.listThrows === true) throw new Error('agent registry exploded')
      return agents
    },
    roots: () => options.roots ?? agents,
  } as never)
}

type JobEventListener = (event: { readonly type: string; readonly job?: FakeJob }) => void

/** Provide the minimal official JobRegistry view plus its all-owner event stream. */
function provideJobs(
  context: Context,
  view: { readonly unowned?: readonly FakeJob[]; readonly owned?: Readonly<Record<string, readonly FakeJob[]>> },
): (event: { readonly type: string; readonly job?: FakeJob }) => void {
  const listeners = new Set<JobEventListener>()
  context.provide('jobs', {
    list: (caller?: string) => caller === undefined ? view.unowned ?? [] : view.owned?.[caller] ?? [],
    events: {
      subscribe: (_filter: unknown, listener: JobEventListener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  } as never)
  return event => {
    for (const listener of [...listeners]) listener(event)
  }
}

/** Provide the minimal official GoalService view. */
function provideGoals(
  context: Context,
  goals: Readonly<Record<string, { readonly phase: string; readonly activation: string }>>,
): void {
  context.provide('goals', {
    get: (target: unknown) => goals[(target as FakeAgent).id],
  } as never)
}

/** Provide the minimal official ScheduleService view. */
function provideSchedule(
  context: Context,
  catalog: () => Promise<readonly { readonly status: 'active' | 'inactive' }[]>,
): void {
  context.provide('schedule', { catalog } as never)
}

/** Provide the two unobservable-in-rc.4 source owners. */
/** Provide the Loader as the real Host Context exposes it (a direct property, not the reflect store). */
function provideLoader(context: Context, entries: readonly Record<string, unknown>[]): void {
  Object.defineProperty(context, 'loader', {
    configurable: true,
    value: { entries: () => entries },
  })
}

/** Provide the two unobservable-in-rc.4 source owners. */
function provideUnobservableOwners(context: Context): void {
  context.provide('typertGateway', {} as never)
  context.provide('sessionPersistence', {} as never)
}

/** Dispose the plain test Context after the observer is closed. */
async function disposeContext(context: Context): Promise<void> {
  await (context as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose().catch(() => undefined)
}

/** One closed observer still returns a snapshot; this checks the diagnostic shape. */
function assertUnknownOnly(snapshot: HostActivitySnapshot): void {
  assert.equal(snapshot.verdict, 'UNKNOWN')
  assert.ok(snapshot.reasons.includes('source-unavailable'))
}

test('an empty, fully covered Host observes quiescence', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'OBSERVED_QUIESCENT')
    assert.deepEqual(snapshot.reasons, [])
    assert.deepEqual(snapshot.sourceStates, {
      agent: 'IDLE',
      jobs: 'IDLE',
      goal: 'IDLE',
      schedule: 'ABSENT',
      pending: 'ABSENT',
      write: 'ABSENT',
      other: 'IDLE',
    })
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a running Agent blocks while every unobservable source stays visible', async () => {
  const context = new Context()
  provideAgents(context, [agent('session-running', 'running')])
  provideJobs(context, {})
  provideGoals(context, {})
  provideUnobservableOwners(context)
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('agent-running'))
    assert.ok(snapshot.reasons.includes('pending-interaction-unobservable'))
    assert.ok(snapshot.reasons.includes('inflight-write-unproven'))
    assert.equal(snapshot.sourceStates.agent, 'ACTIVE')
    assert.equal(snapshot.sourceStates.pending, 'UNKNOWN')
    assert.equal(snapshot.sourceStates.write, 'UNKNOWN')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an idle Agent cannot be certified quiescent while maintenance is unobservable', async () => {
  const context = new Context()
  provideAgents(context, [agent('session-idle', 'idle')])
  provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.notEqual(snapshot.verdict, 'OBSERVED_QUIESCENT')
    assert.ok(snapshot.reasons.includes('agent-maintenance-unproven'))
    assert.equal(snapshot.sourceStates.agent, 'UNKNOWN')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a queued inbox message blocks even when the Agent is idle', async () => {
  const context = new Context()
  provideAgents(context, [agent('session-inbox', 'idle', { nextTurn: 1 })])
  provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('agent-inbox'))
    assert.equal(snapshot.sourceStates.agent, 'ACTIVE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an armed Goal blocks while the Agent itself is idle', async () => {
  const context = new Context()
  const subject = agent('session-goal', 'idle')
  provideAgents(context, [subject])
  provideJobs(context, {})
  provideGoals(context, { 'session-goal': { phase: 'active', activation: 'armed' } })
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('goal-armed'))
    assert.equal(snapshot.sourceStates.goal, 'ACTIVE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a paused Goal does not contribute a keepalive reason', async () => {
  const context = new Context()
  provideAgents(context, [agent('session-paused', 'running')])
  provideJobs(context, {})
  provideGoals(context, { 'session-paused': { phase: 'paused', activation: 'armed' } })
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.reasons.includes('goal-armed'), false)
    assert.equal(snapshot.sourceStates.goal, 'IDLE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an owned Job missing from the unowned list still blocks', async () => {
  const context = new Context()
  const subject = agent('session-owned', 'idle')
  provideAgents(context, [subject])
  provideJobs(context, {
    unowned: [],
    owned: {
      'session-owned': [{ id: 'job-owned', status: 'running', owner: 'session-owned' }],
    },
  })
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('job-running'))
    assert.equal(snapshot.sourceStates.jobs, 'ACTIVE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a stopping Job blocks with its distinct reason', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, { unowned: [{ id: 'job-stopping', status: 'stopping' }] })
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('job-stopping'))
    assert.equal(snapshot.sourceStates.jobs, 'ACTIVE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a registered Job hint blocks until the official settled event clears it', async () => {
  const context = new Context()
  provideAgents(context, [])
  const emitJob = provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    emitJob({ type: 'registered', job: { id: 'job-hint', status: 'running' } })
    const blocked = await observer.snapshot()
    assert.equal(blocked.verdict, 'BLOCKED')
    assert.ok(blocked.reasons.includes('job-running'), 'the hint must cover the pre-list visibility window')
    emitJob({ type: 'settled', job: { id: 'job-hint', status: 'completed' } })
    const settled = await observer.snapshot()
    assert.equal(settled.reasons.includes('job-running'), false)
    assert.equal(settled.sourceStates.jobs, 'IDLE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an unmounted Schedule is ABSENT rather than UNKNOWN', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.sourceStates.schedule, 'ABSENT')
    assert.equal(snapshot.reasons.includes('source-unavailable'), false)
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an active Schedule entry blocks with schedule-active', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideSchedule(context, async () => [{ status: 'active' }])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('schedule-active'))
    assert.equal(snapshot.sourceStates.schedule, 'ACTIVE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an inactive Schedule entry does not block', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideSchedule(context, async () => [{ status: 'inactive' }])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.reasons.includes('schedule-active'), false)
    assert.equal(snapshot.sourceStates.schedule, 'IDLE')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a failing Schedule catalog is UNKNOWN, never an empty idle source', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideSchedule(context, async () => { throw new Error('catalog exploded') })
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
    assert.equal(snapshot.sourceStates.schedule, 'UNKNOWN')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a Schedule change during the catalog read invalidates the snapshot', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  let releaseCatalog: ((entries: readonly { status: 'active' | 'inactive' }[]) => void) | undefined
  provideSchedule(context, () => new Promise(resolve => { releaseCatalog = resolve }))
  const observer = new HostActivityObserver(context)
  try {
    const pending = observer.snapshot()
    ;(context as unknown as { emit(name: string): void }).emit('schedule/changed')
    releaseCatalog?.([])
    const snapshot = await pending
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('observation-changed'))
    assert.notEqual(snapshot.verdict, 'OBSERVED_QUIESCENT')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a hung Schedule catalog returns UNKNOWN within the observation deadline', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideSchedule(context, () => new Promise(() => undefined))
  const observer = new HostActivityObserver(context, { observationDeadlineMs: 40 })
  try {
    const started = Date.now()
    const snapshot = await observer.snapshot()
    assert.ok(Date.now() - started < 1_000, 'the snapshot must settle inside its own bound')
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
    assert.equal(snapshot.sourceStates.schedule, 'UNKNOWN')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a timed-out status read lets the next control request run', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideSchedule(context, () => new Promise(() => undefined))
  const observer = new HostActivityObserver(context, { observationDeadlineMs: 40 })
  try {
    const seen: string[] = []
    const dispatcher = createControlDispatcher(async request => {
      seen.push(`${request.op}:start`)
      if (request.op === 'status') {
        await observer.snapshot()
        seen.push('status:done')
        return false
      }
      seen.push('shutdown:done')
      return true
    })
    await dispatcher.dispatch('{"op":"status","requestId":"first"}')
    await dispatcher.dispatch('{"op":"shutdown"}')
    assert.deepEqual(seen, ['status:start', 'status:done', 'shutdown:start', 'shutdown:done'])
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('closing the observer unsubscribes every listener and ignores later events', async () => {
  const context = new Context()
  provideAgents(context, [])
  const emitJob = provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  const before = await observer.snapshot()
  await observer.close()
  await observer.close()
  emitJob({ type: 'registered', job: { id: 'job-after-close', status: 'running' } })
  ;(context as unknown as { emit(name: string): void }).emit('agent/status')
  const closed = await observer.snapshot()
  assert.equal(closed.epoch, before.epoch, 'a closed observer must not advance its epoch')
  assertUnknownOnly(closed)
  await disposeContext(context)
})

test('the snapshot carries no prompt, objective, Job label or token material', async () => {
  const context = new Context()
  const secretAgent: FakeAgent = {
    id: 'session-secret',
    status: 'idle',
    inbox: { nextTurn: [{ text: 'SECRET-PROMPT' }], nextStep: [] },
  }
  provideAgents(context, [secretAgent])
  provideJobs(context, {
    unowned: [{ id: 'SECRET-JOB-ID', status: 'running', label: 'SECRET-JOB-LABEL' }],
  })
  provideGoals(context, { 'session-secret': { phase: 'active', activation: 'armed' } })
  provideUnobservableOwners(context)
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    const serialized = JSON.stringify(snapshot)
    assert.doesNotMatch(serialized, /SECRET-PROMPT|SECRET-JOB-ID|SECRET-JOB-LABEL|SECRET-GOAL/u)
    assert.deepEqual(Object.keys(snapshot).sort(), ['epoch', 'reasons', 'sourceStates', 'verdict'])
    assert.equal(Object.hasOwn(snapshot, 'shutdownAuthorized'), false)
    assert.equal(Object.hasOwn(snapshot, 'canShutdown'), false)
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a running child Agent contributes child-active', async () => {
  const context = new Context()
  const child = agent('child-running', 'running')
  provideAgents(context, [child], { roots: [] })
  provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'BLOCKED')
    assert.ok(snapshot.reasons.includes('child-active'))
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('an official autonomous terminal-controller row is an unqualified Host source', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [
    { options: { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' }, fiber: { state: 2 } },
  ])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('unqualified-host-source'))
    assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('a qualified stock Loader row is not treated as an unqualified source', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [
    { options: { id: 'agent', name: '@deepseek-ai/dsh-agent' }, fiber: { state: 2 } },
  ])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.reasons.includes('unqualified-host-source'), false)
    assert.equal(snapshot.sourceStates.other, 'IDLE')
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('an allowed row id bound to a different official plugin is unqualified', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [
    { options: { id: 'schedule', name: '@deepseek-ai/dsh-api-terminal-controller' }, fiber: { state: 2 } },
  ])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('unqualified-host-source'))
    assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('a qualified plugin in LOADING or UNLOADING is UNKNOWN', async () => {
  for (const state of [1, 5]) {
    const context = new Context()
    provideAgents(context, [])
    provideJobs(context, {})
    provideGoals(context, {})
    provideLoader(context, [
      { options: { id: 'agent', name: '@deepseek-ai/dsh-agent' }, fiber: { state } },
    ])
    const observer = new HostActivityObserver(context)
    try {
      const snapshot = await observer.snapshot()
      assert.equal(snapshot.verdict, 'UNKNOWN', `fiber state ${String(state)} must not be idle`)
      assert.ok(snapshot.reasons.includes('source-unavailable'))
      assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
    } finally {
      observer.close()
      await disposeContext(context)
    }
  }
})

test('an unqualified plugin in UNLOADING still reports UNKNOWN', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [
    { options: { id: 'custom-unloading', name: 'file:///tmp/custom-unloading.mjs' }, fiber: { state: 5 } },
  ])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('unqualified-host-source'))
    assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('a FAILED Loader row is source-unavailable rather than idle', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [
    { options: { id: 'agent', name: '@deepseek-ai/dsh-agent' }, fiber: { state: 3 } },
  ])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
    assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('an active third-party Loader row is an unqualified Host source', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  provideLoader(context, [
    { options: { id: 'official', name: '@deepseek-ai/dsh-agent' }, fiber: { state: 2 } },
    { options: { id: 'third-party', name: 'file:///tmp/third-party-plugin.mjs' }, fiber: { state: 2 } },
  ])
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('unqualified-host-source'))
    assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a previously mounted Job registry that disappears is UNKNOWN, not ABSENT', async () => {
  const context = new Context()
  provideAgents(context, [])
  const disposeJobs = context.provide('jobs', {
    list: () => [],
    events: { subscribe: () => () => {} },
  } as never)
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    await observer.snapshot()
    disposeJobs()
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.sourceStates.jobs, 'UNKNOWN')
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
  } finally {
    await observer.close()
    await disposeContext(context)
  }
})

test('a failing Agent registry read is UNKNOWN rather than idle', async () => {
  const context = new Context()
  provideAgents(context, [], { listThrows: true })
  provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.equal(snapshot.sourceStates.agent, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
    assert.notEqual(snapshot.verdict, 'OBSERVED_QUIESCENT')
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('a failing Goal read is UNKNOWN rather than an empty goal source', async () => {
  const context = new Context()
  provideAgents(context, [agent('session-goal-error', 'running')])
  provideJobs(context, {})
  context.provide('goals', {
    get: () => { throw new Error('goal read exploded') },
  } as never)
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.sourceStates.goal, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('a missing Loader service is UNKNOWN rather than an implicitly empty Host', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  const observer = new HostActivityObserver(context)
  try {
    const snapshot = await observer.snapshot()
    assert.equal(snapshot.sourceStates.other, 'UNKNOWN')
    assert.equal(snapshot.verdict, 'UNKNOWN')
    assert.ok(snapshot.reasons.includes('source-unavailable'))
  } finally {
    observer.close()
    await disposeContext(context)
  }
})

test('a previously mounted Schedule that disappears is UNKNOWN, not ABSENT', async () => {
  const context = new Context()
  provideAgents(context, [])
  provideJobs(context, {})
  provideGoals(context, {})
  const disposeSchedule = context.provide('schedule', { catalog: async () => [] } as never)
  const observer = new HostActivityObserver(context)
  try {
    const mounted = await observer.snapshot()
    assert.equal(mounted.sourceStates.schedule, 'IDLE')
    disposeSchedule()
    const missing = await observer.snapshot()
    assert.equal(missing.sourceStates.schedule, 'UNKNOWN')
    assert.equal(missing.verdict, 'UNKNOWN')
    assert.ok(missing.reasons.includes('source-unavailable'))
  } finally {
    observer.close()
    await disposeContext(context)
  }
})
