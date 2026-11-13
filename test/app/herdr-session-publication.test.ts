/**
 * H2: the production Session ownership commit -> Client observer -> Herdr
 * reporter chain (plan §4.2).
 *
 * The four REAL publication shapes (`runOrdinaryCommit`, `runForkCommit`,
 * `runFirstSessionCommit`, `runResumeCommit`) publish through the production
 * `createSessionOwnershipCore`. The observer installed here is the SAME shape
 * the Client composition installs: one `subscribeScopeInvalidation` listener
 * that reads the CURRENT committed owner and calls the production
 * `herdrSessionProjection` — never a precomputed target and never a second
 * state authority. The sink is the REAL fake Herdr CLI process.
 *
 * @module @xmoon76/dsh-pi-tui/app/herdr-session-publication.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runFirstSessionCommit,
  runForkCommit,
  runOrdinaryCommit,
  runResumeCommit,
} from '../../src/app/session/commit-order.ts'
import { createSessionOwnershipCore, type SessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import type { SessionOwnerRef } from '../../src/app/session/subject.ts'
import { createHerdrReporter, type HerdrReporter } from '../../src/client/herdr/reporter.ts'
import { herdrSessionProjection, type HerdrSessionProjection } from '../../src/client/herdr/session.ts'
import { createHerdrCliFixture, type HerdrCliEntry, type HerdrCliFixture } from '../support/herdr-cli-fixture.ts'

const SESSION_R = `session-${'1'.repeat(32)}`
const SESSION_A = `session-${'a'.repeat(32)}`
const SESSION_B = `session-${'b'.repeat(32)}`
const SESSION_C = `session-${'c'.repeat(32)}`

function owner(label: string): SessionOwnerRef {
  return { label } as unknown as SessionOwnerRef
}

interface Observation {
  readonly fixture: HerdrCliFixture
  readonly reporter: HerdrReporter
  readonly ownership: SessionOwnershipCore
  /** Every projection the production observer handed to the reporter. */
  readonly observed: (HerdrSessionProjection | undefined)[]
  /** Stop the owner observer (the composition's abort path). */
  unsubscribe(): void
  /** The Session ids in CLI order. */
  sessions(): string[]
  /** The full CLI starts, in order. */
  starts(): HerdrCliEntry[]
  /** Wait for the Nth Session CLI command (bounded). */
  waitForSessions(count: number, label: string): Promise<void>
  waitForStates(count: number, label: string): Promise<void>
}

/**
 * Compose the SAME adapter `applyRunnerWithRuntime` installs: one subscription
 * to the official scope invalidation, an initial sample of the CURRENT owner
 * and the production projection function. `remote` selects the Remote shape
 * (undefined Direct profile) without inventing a second flag.
 */
function compose(t: Parameters<typeof createHerdrCliFixture>[0], options: { readonly remote?: boolean } = {}): Observation {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 10 })
  const reporter = createHerdrReporter(fixture.env, true)
  assert.ok(reporter !== undefined, 'the fixture must create the real reporter')
  const ownership = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  const observed: (HerdrSessionProjection | undefined)[] = []
  // The recording seam observes the ADAPTER CALL (for the microtask proof)
  // while delegating every fact to the production reporter/CLI sink.
  const recording: HerdrReporter = {
    publish: status => reporter.publish(status),
    observeSession: session => {
      observed.push(session)
      reporter.observeSession(session)
    },
    setQualified: qualified => reporter.setQualified(qualified),
    dispose: () => reporter.dispose(),
  }
  const directProfile = options.remote === true ? undefined : 'pi-tui'
  const publishCurrent = (): void => {
    recording.observeSession(herdrSessionProjection(ownership.currentSessionId(), directProfile))
  }
  const unsubscribe = ownership.subscribeScopeInvalidation(publishCurrent)
  publishCurrent()
  const sessions = (): string[] => fixture.sessions().map(entry => entry.sessionId)
  const starts = (): HerdrCliEntry[] => fixture.starts()
  return {
    fixture,
    reporter,
    ownership,
    observed,
    unsubscribe,
    sessions,
    starts,
    async waitForSessions(count, label) {
      await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
        && entry.argv?.[1] === 'report-agent-session').length >= count, label)
    },
    async waitForStates(count, label) {
      await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
        && entry.argv?.[1] === 'report-agent').length >= count, label)
    },
  }
}

/**
 * Wait until every started fake-CLI child has exited, so the reporter queue is
 * provably idle before a negative observation.
 */
function settledPids(entries: readonly HerdrCliEntry[]): boolean {
  // Compare by PID: every started child must have its OWN end line. Counting
  // starts against ends alone can observe an "equal" prefix while the next
  // child is already starting, which makes a negative observation racy.
  const started = new Set(entries.filter(entry => entry.phase === 'start').map(entry => entry.pid))
  const ended = new Set(entries.filter(entry => entry.phase === 'end').map(entry => entry.pid))
  return started.size > 0 && [...started].every(pid => ended.has(pid))
}

async function settleQueue(observation: Observation, label: string): Promise<void> {
  await observation.fixture.waitFor(settledPids, label)
}

/**
 * Yield the ONE coalesced official scope microtask: the ownership core schedules
 * its notification with `queueMicrotask`, so this continuation is queued behind
 * it. Two turns also drain any continuation that notification itself queued.
 */
async function scopeSettled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Run the production ordinary-transition shape through the real core. */
function ordinary(ownership: SessionOwnershipCore, sessionId: string, ref: SessionOwnerRef, publish = true): void {
  runOrdinaryCommit({
    isSurfaceDisposed: () => false,
    settlePendingQueueRecalls: () => {},
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    bumpGeneration: () => ownership.bumpGeneration(),
    publishOwner: (next) => {
      if (publish) ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
  }, ref)
}

/** Run the production fork-adoption shape through the real core. */
function fork(ownership: SessionOwnershipCore, sessionId: string, ref: SessionOwnerRef): void {
  runForkCommit({
    settlePendingQueueRecalls: () => {},
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    bumpGeneration: () => ownership.bumpGeneration(),
    publishOwner: (next) => {
      ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
  }, ref)
}

/** Run the production first-session shape through the real core. */
async function first(ownership: SessionOwnershipCore, sessionId: string, ref: SessionOwnerRef): Promise<void> {
  await runFirstSessionCommit({
    bumpGeneration: () => ownership.bumpGeneration(),
    publishOwner: (next) => {
      ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
    quiesceChild: async () => false,
    initChild: async () => {},
  }, ref)
}

/** Run the production startup-resume shape through the real core. */
function resume(ownership: SessionOwnershipCore, sessionId: string, ref: SessionOwnerRef): void {
  runResumeCommit({
    publishOwner: (next) => {
      ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
  }, ref)
}

test('HSP-01 all four production commit shapes report the committed canonical Session after the H1 state', async (t) => {
  const observation = compose(t)
  observation.reporter.publish({ state: 'idle' })
  await observation.waitForStates(1, 'the initial idle state')

  resume(observation.ownership, SESSION_R, owner('resume'))
  await observation.waitForSessions(1, 'the startup-resume Session')
  ordinary(observation.ownership, SESSION_A, owner('ordinary-a'))
  await observation.waitForSessions(2, 'the ordinary-transition Session')
  fork(observation.ownership, SESSION_B, owner('fork-b'))
  await observation.waitForSessions(3, 'the fork-adoption Session')
  await first(observation.ownership, SESSION_C, owner('first-c'))
  await observation.waitForSessions(4, 'the first-session Session')

  assert.deepEqual(observation.sessions(), [SESSION_R, SESSION_A, SESSION_B, SESSION_C])
  const observedIds = observation.observed
    .filter((projection): projection is HerdrSessionProjection => projection !== undefined)
    .map(projection => projection.sessionId)
    // The first-session shape publishes the owner and THEN bumps the
    // generation after its awaited idle; that same-id notification is silent at
    // the CLI sink and is deduped here.
    .filter((id, index, all) => index === 0 || all[index - 1] !== id)
  assert.deepEqual(observedIds, [SESSION_R, SESSION_A, SESSION_B, SESSION_C],
    'every publication reaches the observer with the committed id')
  for (const invocation of observation.fixture.sessions()) {
    assert.deepEqual(invocation.resumeArgv,
      ['dsh', '--profile', 'pi-tui', '--session', invocation.sessionId],
      'Direct reports the exact public cold-open argv')
  }
  const commands = observation.starts().map(entry => entry.argv?.[1])
  assert.equal(commands[0], 'report-agent', 'the H1 status must register the Pane before any Session')
  const seqs = observation.starts().map(entry => Number((entry.argv ?? [])[(entry.argv ?? []).indexOf('--seq') + 1]))
  for (let index = 1; index < seqs.length; index += 1) assert.ok(seqs[index] > seqs[index - 1])
})

test('HSP-02 a startup Resume committed before the observer install is sampled once', async (t) => {
  const ownership = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  resume(ownership, SESSION_R, owner('startup-resume'))
  // The owner committed BEFORE the Client observer existed (the pre-mount
  // resume). The install-time sample must cover it; no listener replay is
  // needed or allowed.
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 10 })
  const reporter = createHerdrReporter(fixture.env, true)
  assert.ok(reporter !== undefined)
  const observed: (HerdrSessionProjection | undefined)[] = []
  const recording: HerdrReporter = {
    publish: status => reporter.publish(status),
    observeSession: session => { observed.push(session); reporter.observeSession(session) },
    setQualified: qualified => reporter.setQualified(qualified),
    dispose: () => reporter.dispose(),
  }
  const publishCurrent = (): void => {
    recording.observeSession(herdrSessionProjection(ownership.currentSessionId(), 'pi-tui'))
  }
  ownership.subscribeScopeInvalidation(publishCurrent)
  publishCurrent()
  // The install-time sample already sees the committed resume; the coalesced
  // notification for that SAME commit is a legal second observation of the same
  // identity (the reporter dedupes it). The CLI sink is the authority here.
  assert.ok(observed.some(projection => projection?.sessionId === SESSION_R),
    'the install-time sample must observe the resume committed before it')
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'report-agent-session').length === 1, 'the startup-resume Session')
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_R])
  await fixture.waitFor(settledPids, 'the queue after the sampled startup resume')
  assert.equal(fixture.starts().filter(entry => entry.argv?.[1] === 'report-agent-session').length, 1,
    'the sampled resume must be reported exactly once')
})

test('HSP-03 a synchronous publish block reaches the CLI only after the coalesced scope microtask, with the FINAL id', async (t) => {
  const observation = compose(t)
  observation.reporter.publish({ state: 'idle' })
  await observation.waitForStates(1, 'the initial idle state')
  observation.observed.length = 0
  const startCount = observation.starts().length

  // Two owner publications inside ONE synchronous block: the official core
  // coalesces them into one microtask notification.
  ordinary(observation.ownership, SESSION_A, owner('sync-a'))
  ordinary(observation.ownership, SESSION_B, owner('sync-b'))
  assert.equal(observation.observed.length, 0,
    'a synchronous publisher commit must NOT enter the Client observer/adapter')
  assert.equal(observation.starts().length, startCount,
    'a synchronous publisher commit must NOT spawn a CLI child')

  await Promise.resolve()
  assert.deepEqual(observation.observed.map(projection => projection?.sessionId), [SESSION_B],
    'the settled scope reports the FINAL committed identity exactly once')
  await observation.waitForSessions(1, 'the final Session B')
  assert.deepEqual(observation.sessions(), [SESSION_B], 'the superseded A was never reported')
})

test('HSP-04 a failed-before-commit transition and a navigation epoch bump never report a Session; sessionless cleans up', async (t) => {
  const observation = compose(t)
  observation.reporter.publish({ state: 'idle' })
  await observation.waitForStates(1, 'the initial idle state')
  ordinary(observation.ownership, SESSION_A, owner('a'))
  await observation.waitForSessions(1, 'Session A')

  // The navigation failed BEFORE the owner publication: the production shape
  // still bumps/blocks as its caller does, but no new owner was committed.
  ordinary(observation.ownership, SESSION_B, owner('failed'), false)
  await scopeSettled()
  await settleQueue(observation, 'the queue after the failed-before-commit navigation')
  assert.deepEqual(observation.sessions(), [SESSION_A], 'a failed-before-commit navigation reports nothing')

  // A navigation epoch change is not a Session commit at all.
  observation.ownership.bumpNavigationEpoch()
  await scopeSettled()
  await settleQueue(observation, 'the queue after the navigation epoch bump')
  assert.deepEqual(observation.sessions(), [SESSION_A])

  // Sessionless: the previous Direct resume argv must be withdrawn by ONE
  // ordered release, then the Pane re-registers with H1 state only.
  observation.ownership.setCurrentOwner(undefined, undefined)
  await observation.fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'release-agent').length === 1, 'the sessionless cleanup release')
  await observation.fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'report-agent').length === 2, 'the re-registration')
  assert.deepEqual(observation.sessions(), [SESSION_A], 'a sessionless owner reports no Session after the release')

  ordinary(observation.ownership, SESSION_B, owner('b-after'))
  await observation.waitForSessions(2, 'the Session after sessionless')
  assert.deepEqual(observation.sessions(), [SESSION_A, SESSION_B])
})

test('HSP-05 a generation-only bump and a same-id re-publication are silent; a real owner change is not', async (t) => {
  const observation = compose(t)
  observation.reporter.publish({ state: 'idle' })
  await observation.waitForStates(1, 'the initial idle state')
  ordinary(observation.ownership, SESSION_A, owner('a'))
  await observation.waitForSessions(1, 'Session A')

  observation.ownership.bumpGeneration()
  await scopeSettled()
  await settleQueue(observation, 'the queue after the generation-only bump')
  assert.deepEqual(observation.sessions(), [SESSION_A], 'a generation-only bump does not re-report')

  observation.ownership.setCurrentOwner(owner('a-again'), SESSION_A)
  await scopeSettled()
  await settleQueue(observation, 'the queue after the same-id re-publication')
  assert.deepEqual(observation.sessions(), [SESSION_A], 'the same Session id re-published stays deduped')

  ordinary(observation.ownership, SESSION_B, owner('b'))
  await observation.waitForSessions(2, 'the real owner change')
  assert.deepEqual(observation.sessions(), [SESSION_A, SESSION_B])
  // The H1 state queue is untouched by Session reporting.
  observation.reporter.publish({ state: 'blocked', kind: 'permission' })
  await observation.fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'report-agent').length === 2, 'the blocked state')
  const lastState = observation.starts().filter(entry => entry.argv?.[1] === 'report-agent').at(-1)
  assert.equal(lastState?.argv?.[lastState.argv.indexOf('--state') + 1], 'blocked')
})

test('HSP-06 unsubscribe stops Session observation; dispose is the ONE ordered release and never respawns', async (t) => {
  const observation = compose(t)
  observation.reporter.publish({ state: 'idle' })
  await observation.waitForStates(1, 'the initial idle state')
  ordinary(observation.ownership, SESSION_A, owner('a'))
  await observation.waitForSessions(1, 'Session A')

  observation.unsubscribe()
  observation.observed.length = 0
  ordinary(observation.ownership, SESSION_B, owner('b'))
  await scopeSettled()
  await settleQueue(observation, 'the queue after the unsubscribed publication')
  assert.deepEqual(observation.observed, [], 'an unsubscribed owner observer is never called')
  assert.deepEqual(observation.sessions(), [SESSION_A], 'no Session may be reported after unsubscribe')

  observation.reporter.dispose()
  observation.reporter.dispose()
  await observation.fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'release-agent').length === 1, 'the dispose release')
  await settleQueue(observation, 'the queue after dispose')
  const afterDispose = observation.starts().length
  observation.reporter.setQualified(true)
  observation.reporter.publish({ state: 'idle' })
  await scopeSettled()
  await settleQueue(observation, 'the queue after the refused requalification')
  assert.equal(observation.starts().length, afterDispose, 'dispose is idempotent and requalification is refused')
  assert.equal(observation.starts().filter(entry => entry.argv?.[1] === 'release-agent').length, 1)
})

// ── H2 abnormal recovery through the REAL publication path (review F1/F2) ────

test('HSP-07 a failed cleanup withdrawal is retried by the NEXT real owner commit, and the new owner is reported', async (t) => {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 20 })
  const reporter = createHerdrReporter(fixture.env, true)
  assert.ok(reporter !== undefined)
  const ownership = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  const publishCurrent = (): void => {
    reporter.observeSession(herdrSessionProjection(ownership.currentSessionId(), 'pi-tui'))
  }
  ownership.subscribeScopeInvalidation(publishCurrent)
  // The install-time sample is what the composition performs after subscribing.
  publishCurrent()
  const sessions = (): string[] => fixture.sessions().map(entry => entry.sessionId)
  const releases = (): number => fixture.starts().filter(entry => entry.argv?.[1] === 'release-agent').length

  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'report-agent').length === 1, 'the idle registration')
  ordinary(ownership, SESSION_A, owner('a'))
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'report-agent-session').length === 1, 'Session A')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after A')

  // The owner goes away while the withdrawal of A's resume target FAILS.
  fixture.env.HERDR_FAKE_EXIT_CODE = '3'
  ownership.setCurrentOwner(undefined, undefined)
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'start'
    && entry.argv?.[1] === 'release-agent').length === 1, 'the failed cleanup withdrawal')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the failed withdrawal settled')
  assert.equal(sessions().length, 1, 'a failed withdrawal must not claim a new Session')

  // Herdr recovers and the NEXT real owner commit is the lifecycle event that
  // retries the outstanding cleanup; only its SUCCESS may re-register.
  fixture.env.HERDR_FAKE_EXIT_CODE = '0'
  ordinary(ownership, SESSION_B, owner('b'))
  await fixture.waitFor(entries => releases() === 2, 'the retried cleanup withdrawal')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the retried cleanup settled')
  await fixture.waitFor(entries => sessions().length === 2, 'Session B after the successful retry')
  assert.deepEqual(sessions(), [SESSION_A, SESSION_B],
    'the committed owner is reported after the retried cleanup succeeded')
  // Every started child has its OWN end line, so this sequence is the DISPATCH
  // order and not a partially written log.
  await fixture.waitFor(settledPids, 'the whole queue settled')
  const commands = fixture.starts().map(entry => entry.argv?.[1] === 'release-agent'
    ? 'release'
    : entry.argv?.[1] === 'report-agent-session' ? 'session' : 'state')
  assert.deepEqual(commands, ['state', 'session', 'release', 'release', 'state', 'session'],
    `the retried cleanup precedes the re-registration and the new Session: ${JSON.stringify(commands)}`)
  assert.deepEqual(fixture.sessions()[1].resumeArgv,
    ['dsh', '--profile', 'pi-tui', '--session', SESSION_B])
})

test('HSP-08 a first registration failure is repaired by a Session-only commit (no Agent-state change)', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = createHerdrReporter(fixture.env, true)
  assert.ok(reporter !== undefined)
  const ownership = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  ownership.subscribeScopeInvalidation(() => {
    reporter.observeSession(herdrSessionProjection(ownership.currentSessionId(), 'pi-tui'))
  })
  fixture.env.HERDR_FAKE_EXIT_CODE = '3'
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end' && entry.code === 3),
    'the failed first registration')

  // Herdr recovers; the ONLY new fact is the committed owner. The Agent state
  // stays idle, so the H1 state dedupe alone would never dispatch again.
  fixture.env.HERDR_FAKE_EXIT_CODE = '0'
  ordinary(ownership, SESSION_B, owner('b'))
  await fixture.waitFor(entries => fixture.sessions().length === 1, 'the repaired Session report')
  const commands = fixture.starts().map(entry => entry.argv?.[1] === 'release-agent'
    ? 'release'
    : entry.argv?.[1] === 'report-agent-session' ? 'session' : 'state')
  assert.deepEqual(commands, ['state', 'state', 'session'],
    `the Session-only commit re-registers the Pane first: ${JSON.stringify(commands)}`)
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_B])
})
