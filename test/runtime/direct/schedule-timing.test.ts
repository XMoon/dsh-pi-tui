/**
 * S5-PR4 L5/F5: the official Host Schedule timer and wall-clock rules, driven
 * by an INJECTED clock.
 *
 * This follows the official DSH Schedule test layout (`packages/schedule/
 * schedule/tests/{harness,runtime,delivery,daily}.spec.ts`): a REAL
 * `ScheduleService` over the REAL storage domain, an explicit Session
 * resolver/agent fixture and a `session/flush` listener — never a fake
 * Schedule. Time is advanced with the runtime's own timer facility (Node's
 * `mock.timers`, the `node:test` equivalent of the upstream `vi.useFakeTimers`
 * suite), so the due occurrence, the delivery floor and the daylight-saving
 * wall-clock rules are evaluated at exact instants instead of waiting 60
 * real seconds.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-timing.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import type { ScheduleCatalogEntry, ScheduleService as ScheduleServiceType } from '@deepseek-ai/dsh-schedule'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

const SESSION = SessionId('timing-session')

interface TimingHarness {
  readonly ctx: Context
  readonly service: ScheduleServiceType
  readonly followups: Array<{ readonly source?: { readonly kind?: string } }>
  readonly flushes: { count: number }
  dispose(): Promise<void>
}

/** Build the narrow real-Schedule harness over one storage root. */
async function mountTimingHarness(root: string, storageName: string): Promise<TimingHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, storageName) })
  await ctx.plugin(StorageDomain, { backend: 'json' })

  ctx.sessions.create(SESSION)
  const followups: Array<{ readonly source?: { readonly kind?: string } }> = []
  const agent = {
    id: SESSION,
    session: ctx.sessions.get(SESSION),
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], remove: () => {} },
    followup(message: { readonly source?: { readonly kind?: string } }) { followups.push(message) },
    whenIdle: async () => {},
  }
  // The official harness substitutes exactly these two Host boundaries: the
  // Session resolver and the persistence acknowledgment listener. Storage, the
  // Schedule domain, its serialized queue and its timer are REAL.
  // The official runtime runs its delivery drive inside the Agent registry's
  // initiator scope; only that scope wrapper and the live-Agent lookup are
  // substituted (the upstream harness supplies the real registry instead).
  ctx.provide('agents', {
    get: () => undefined,
    withoutInitiator: <T>(operation: () => Promise<T>): Promise<T> => operation(),
  })
  ctx.provide('sessionController', {
    resolveAgent: async (sessionId: unknown) => {
      if (String(sessionId) !== String(SESSION)) return { error: new Error('missing Session') }
      return { agent }
    },
  })
  ctx.provide('sessionPersistence', {
    stat: async () => ({ header: { id: SESSION, delegationDepth: 0 } }),
  })
  const flushes = { count: 0 }
  ctx.on('session/flush', async () => { flushes.count += 1 })

  const fiber = await ctx.plugin(ScheduleService, {})
  return {
    ctx,
    service: ctx.schedule as unknown as ScheduleServiceType,
    followups,
    flushes,
    dispose: async () => { await fiber.dispose() },
  }
}

/**
 * Advance the injected clock and let the REAL asynchronous chain it unblocks
 * run: the serialized FIFO, the JSON-backed storage domain and the flush pass
 * are real I/O, so the drain yields real macrotasks (not a timed wait).
 */
async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms)
  await drainUntil(() => true, 'the injected clock turn')
}

/**
 * Drive the injected clock's zero-delay timers and the REAL asynchronous chain
 * until `probe` observes the authoritative fact. A bounded loop over real
 * macrotask turns — never a timed sleep — so a slow storage flush cannot make
 * the assertion flaky.
 */
async function drainUntil(
  probe: () => Promise<boolean> | boolean,
  label: string,
  cap = 5000,
): Promise<void> {
  for (let index = 0; index < cap; index += 1) {
    // Zero-delay timers scheduled by the async chain belong to the same
    // injected clock: run them between the real macrotask yields.
    mock.timers.tick(0)
    if (await probe()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`${label} did not settle`)
}

function enableClock(instant: string): void {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  mock.timers.setTime(new Date(instant).getTime())
}

/** The local wall clock of one instant in a zone, `YYYY-MM-DD HH:mm`. */
function localWallClock(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instant))
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour') === '24' ? '00' : value('hour')}:${value('minute')}`
}

test('the official Host timer fires a due `after` occurrence at its exact instant', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('schedule-timing-after')
  enableClock('2026-09-16T00:00:00.000Z')
  const harness = await mountTimingHarness(root, 'storages')
  life.defer(() => harness.dispose())
  life.defer(() => { mock.timers.reset() })

  const created = await harness.service.remoteCreate({
    title: 'timing after',
    prompt: 'Timing prompt',
    timing: { kind: 'after', after_seconds: 60 },
    target: { kind: 'session', sessionId: SESSION },
  })
  assert.equal(created.scheduledAt, '2026-09-16T00:01:00.000Z')

  await advance(59_000)
  assert.equal(harness.followups.length, 0, 'nothing is delivered before the committed instant')
  mock.timers.tick(1_000)
  await drainUntil(() => harness.followups.length === 1, 'the due occurrence delivery')
  assert.equal(harness.followups[0]?.source?.kind, 'schedule', 'the delivered message keeps the schedule source')
  assert.equal(harness.flushes.count >= 1, true, 'the delivery was acknowledged through Session persistence')

  await drainUntil(async () => (await harness.service.view({ id: created.id }) as ScheduleCatalogEntry).lastDelivery !== undefined,
    'the durable receipt commit')
  const view = await harness.service.view({ id: created.id }) as ScheduleCatalogEntry
  assert.ok(view.lastDelivery !== undefined)
  assert.equal(view.lastDelivery?.scheduledAt, '2026-09-16T00:01:00.000Z')
  assert.equal(view.status, 'ended', 'a one-shot becomes ended after its delivery')

  // A second drive never re-delivers the consumed occurrence.
  await advance(86_400_000)
  assert.equal(harness.followups.length, 1)
})

test('a recurring wall-clock rule follows the official daylight-saving semantics', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('schedule-timing-dst')

  // Spring forward (America/New_York, 2026-03-08 02:00 -> 03:00): the 02:30 wall
  // clock does not exist and the official rule SKIPS that date.
  // 2026-03-07 19:00 EST: the next 02:30 wall clock is the gap day.
  enableClock('2026-03-08T00:00:00.000Z')
  const spring = await mountTimingHarness(root, 'storages-spring')
  life.defer(() => spring.dispose())
  try {
    const created = await spring.service.remoteCreate({
      title: 'dst gap',
      prompt: 'DST prompt',
      timing: { kind: 'daily', daily: { time: '02:30:00', time_zone: 'America/New_York' } },
      target: { kind: 'session', sessionId: SESSION },
    })
    assert.equal(created.kind, 'daily')
    assert.equal((created as Extract<ScheduleCatalogEntry, { kind: 'daily' }>).scheduledAt, '2026-03-09T06:30:00.000Z',
      'the nonexistent 2026-03-08 02:30 wall clock is skipped to 2026-03-09 02:30 EDT')
    assert.equal(localWallClock((created as Extract<ScheduleCatalogEntry, { kind: 'daily' }>).scheduledAt, 'America/New_York'),
      '2026-03-09 02:30')
  } finally {
    await spring.dispose()
    mock.timers.reset()
  }

  // Fall back (2026-11-01 02:00 -> 01:00): the 01:30 wall clock happens twice and
  // the official rule uses the EARLIER instant (EDT, -04:00).
  // 2026-10-31 20:00 EDT: the next 01:30 wall clock is the ambiguous one.
  enableClock('2026-11-01T00:00:00.000Z')
  const fall = await mountTimingHarness(root, 'storages-fall')
  life.defer(() => fall.dispose())
  life.defer(() => { mock.timers.reset() })
  const created = await fall.service.remoteCreate({
    title: 'dst overlap',
    prompt: 'DST prompt',
    timing: { kind: 'daily', daily: { time: '01:30:00', time_zone: 'America/New_York' } },
    target: { kind: 'session', sessionId: SESSION },
  })
  assert.equal((created as Extract<ScheduleCatalogEntry, { kind: 'daily' }>).scheduledAt, '2026-11-01T05:30:00.000Z',
    'the ambiguous 2026-11-01 01:30 wall clock resolves to the earlier EDT instant')
  assert.equal(localWallClock((created as Extract<ScheduleCatalogEntry, { kind: 'daily' }>).scheduledAt, 'America/New_York'),
    '2026-11-01 01:30')

  // The due occurrence fires at the committed instant and re-arms for the next
  // local day at the same wall clock.
  mock.timers.tick(6 * 60 * 60 * 1000)
  await drainUntil(() => fall.followups.length === 1, 'the DST occurrence delivery')
  await drainUntil(async () => (await fall.service.view({ id: created.id }) as Extract<ScheduleCatalogEntry, { kind: 'daily' }>).scheduledAt === '2026-11-02T06:30:00.000Z',
    'the re-armed next occurrence')
  const next = await fall.service.view({ id: created.id }) as ScheduleCatalogEntry
  assert.equal((next as Extract<ScheduleCatalogEntry, { kind: 'daily' }>).scheduledAt, '2026-11-02T06:30:00.000Z',
    'the repeatable task moves to 2026-11-02 01:30 EST')
})

test('the durable task store survives a Host restart and keeps its occurrence', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('schedule-timing-restart')
  enableClock('2026-09-16T00:00:00.000Z')
  const first = await mountTimingHarness(root, 'storages')
  const created = await first.service.remoteCreate({
    title: 'restart task',
    prompt: 'Restart prompt',
    timing: { kind: 'after', after_seconds: 3600 },
    target: { kind: 'session', sessionId: SESSION },
  })
  await first.dispose()
  mock.timers.reset()

  enableClock('2026-09-16T00:30:00.000Z')
  const second = await mountTimingHarness(root, 'storages')
  life.defer(() => second.dispose())
  life.defer(() => { mock.timers.reset() })
  const restored = (await second.service.catalog()).find(entry => entry.id === created.id)
  assert.ok(restored !== undefined, 'the restarted Host re-opened the durable task store')
  assert.equal((restored as Extract<ScheduleCatalogEntry, { kind: 'after' }>).scheduledAt, '2026-09-16T01:00:00.000Z')
  mock.timers.tick(30 * 60 * 1000)
  await drainUntil(() => second.followups.length === 1, 'the restarted delivery')
})
