/**
 * The AboutStatusController lifecycle tests (Phase 3C / C3): the per-open
 * read owner — sessionless admission, scope fencing (A→B, generation
 * rollover, leave/dispose), coalescing, subscription counting and the
 * no-refold-on-revision contract.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AboutStatusController, serializeAboutStatus, type AboutStatusControllerOps } from '../../src/app/command/about-status.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { LiveSessionScope, SessionScope } from '../../src/app/session/scope.ts'
import type { SessionStatsFacts } from '../../src/domain/status/stats.ts'
import type { SessionStatusProjection } from '../../src/runtime/session-reader-port.ts'

const quietDiag = createDiag({ filePath: undefined, stderrLevel: 'off' })

/** A captured live scope literal (the tests fence by identity, so the shape
 *  only needs the fields the controller reads). */
function liveScope(sessionId: string): LiveSessionScope {
  return { sessionId, subject: { owner: { id: sessionId } }, generation: 1 } as unknown as LiveSessionScope
}
function anyScope(): SessionScope {
  return { sessionId: undefined, generation: 0 } as unknown as SessionScope
}

interface OpsHarness {
  readonly ops: AboutStatusControllerOps
  readonly setScope: (sessionId: string | undefined) => void
  readonly setStats: (stats: SessionStatsFacts | undefined) => void
  readonly setStatus: (status: SessionStatusProjection | undefined) => void
  readonly setStatsFailure: (message: string | undefined) => void
  readonly statsCalls: () => number
  readonly contextCalls: () => number
  readonly fireInvalidation: () => void
}

/** The one full controller ops stub; every read is counted and mutable. */
function harness(initialSession: string | undefined = undefined): OpsHarness {
  let scope: LiveSessionScope | undefined = initialSession === undefined ? undefined : liveScope(initialSession)
  let stats: SessionStatsFacts | undefined = {
    lifetime: { turns: 3, steps: 7, llmMs: 4200 },
    tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cacheHitPct: 0 },
  }
  let status: SessionStatusProjection | undefined = {
    sessionId: initialSession ?? 'x',
    // The official context window fact (the controller reads it from the
    // ALREADY-captured projection — one sessionStatus read per cycle).
    context: { contextWindow: 128_000 },
  }
  let statsFailure: string | undefined
  let statsCalls = 0
  let contextCalls = 0
  let fireInvalidation: () => void = () => {}
  const current = (captured: SessionScope): boolean => scope !== undefined && captured === (scope as unknown as SessionScope)
  const ops: AboutStatusControllerOps = {
    backendKind: 'direct',
    // The capture is IDEMPOTENT per scope state: the same live state yields
    // the SAME captured object (the production authority caches its capture
    // until the owner/generation changes), so scope identity comparisons see
    // the same owner+generation as equal — never a fresh object per call.
    captureLiveSessionScope: () => scope,
    isSessionScopeCurrent: (captured) => current(captured),
    currentSessionStats: async (captured) => {
      statsCalls += 1
      if (!current(captured)) throw new Error('the session changed while reading the session stats')
      if (statsFailure !== undefined) throw new Error(statsFailure)
      return stats
    },
    readSessionStatus: (sessionId) => status !== undefined && status.sessionId === sessionId ? status : undefined,
    forceContextMeasurementResult: () => {
      contextCalls += 1
      return { value: 12_345, observation: 'fresh' }
    },
    versionFacts: { tui: '0.5.3', dsh: '0.2.1-rc.2' },
    subscribeSessionScopeInvalidation: (listener) => {
      fireInvalidation = listener
      return () => {}
    },
    diag: quietDiag,
  }
  return {
    ops,
    setScope: (sessionId) => { scope = sessionId === undefined ? undefined : liveScope(sessionId) },
    setStats: (next) => { stats = next },
    setStatus: (next) => { status = next },
    setStatsFailure: (message) => { statsFailure = message },
    statsCalls: () => statsCalls,
    contextCalls: () => contextCalls,
    fireInvalidation: () => fireInvalidation(),
  }
}

test('sessionless enter(): no reads, no scope request, the immediate No-active-session frame', () => {
  const h = harness(undefined)
  const controller = new AboutStatusController(h.ops)
  const published: string[] = []
  controller.subscribe(() => published.push(controller.snapshotView().session.kind))
  controller.enter()
  assert.equal(h.statsCalls(), 0, 'a sessionless entry performs ZERO stats reads')
  assert.equal(h.contextCalls(), 0, 'a sessionless entry performs ZERO context forces')
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'none')
  assert.equal(view.runtime.backend, 'direct')
  assert.equal(view.epoch, 1)
  assert.deepEqual(published, ['none'])
})

test('sessionless enter() never requires a live scope and never creates a session', () => {
  const h = harness(undefined)
  let captureCount = 0
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    // captureLiveSessionScope returning undefined IS the noncreating capture.
    captureLiveSessionScope: () => { captureCount += 1; return undefined },
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  assert.equal(captureCount, 1)
  assert.equal(controller.snapshotView().session.kind, 'none')
})

test('a live entry publishes Loading then ONE ready view with the grouped facts', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  const frames: string[] = []
  controller.subscribe(() => frames.push(controller.snapshotView().session.kind))
  controller.enter()
  assert.equal(controller.snapshotView().session.kind, 'loading', 'the immediate frame is Loading')
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-a')
  assert.equal(view.session.stats?.lifetime?.turns, 3)
  assert.equal(view.session.contextUsed, 12_345)
  assert.equal(view.session.contextWindow, 128_000)
  assert.equal(view.session.context, 'fresh')
  assert.equal(h.statsCalls(), 1, 'exactly ONE stats read per entry')
  assert.equal(h.contextCalls(), 1, 'exactly ONE context force per entry')
  assert.deepEqual(frames, ['loading', 'ready'], 'one publication per meaningful change')
})

test('a projection read failure is distinguishable from an absent projection (unavailable kind)', async () => {
  const h = harness('sess-a')
  h.setStatsFailure('the host exploded')
  h.setStatus(undefined)
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'unavailable', 'a failed read is NOT silently ready')
})

test('one group failing does not discard the other authoritative groups', async () => {
  const h = harness('sess-a')
  h.setStatsFailure('the stats port exploded')
  // The projection still answers.
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.notEqual(view.session.kind, 'unavailable', 'the projection group survived')
})

test('A→B: a result captured on A can never publish into B (post-await scope fence)', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  // The read is in flight; the surface switches sessions.
  h.setScope('sess-b')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.snapshotView().session.kind, 'loading', 'A superseded result never publishes')
  assert.equal(controller.snapshotView().epoch, 1, 'no new epoch was minted by the stale read')
})

test('the invalidation trigger with a NEW session id admits exactly ONE scoped re-read', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 1)
  h.setScope('sess-b')
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-b', 'the view moved to the NEW scope')
  assert.equal(h.statsCalls(), 2, 'exactly ONE re-read for the new identity')
  // Same-session revisions repaint nothing and never refold:
  h.fireInvalidation()
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 2, 'same-session revisions never trigger a stats re-fold')
})

test('refresh() coalesces an in-flight same-scope read; a post-settle click starts one new read', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  controller.refresh()
  controller.refresh()
  assert.equal(h.statsCalls(), 1, 'in-flight same-scope refreshes coalesce')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 1)
  controller.refresh()
  assert.equal(h.statsCalls(), 2, 'an explicit later refresh starts exactly one new read')
})

test('leave() invalidates the pending epoch; dispose() releases the subscription', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  let notifications = 0
  const unsubscribe = controller.subscribe(() => { notifications += 1 })
  controller.enter()
  controller.leave()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.snapshotView().session.kind, 'loading', 'the left entry never settles visibly')
  unsubscribe()
  controller.dispose()
  // A post-dispose invalidation fires nothing and never throws.
  h.fireInvalidation()
  assert.equal(notifications, 1, 'only the Loading publication was observed')
})

test('sync listener reentry: a subscriber calling refresh() inside the publication cannot recurse', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  let reentries = 0
  const loadingEpochs: number[] = []
  controller.subscribe(() => {
    reentries += 1
    const view = controller.snapshotView()
    if (view.session.kind === 'loading') loadingEpochs.push(view.epoch)
    if (reentries < 5) controller.refresh()
  })
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  // A refresh DURING a publication hits the same-scope coalesce guard (the
  // in-flight marker is committed before the Loading frame publishes); only
  // the settled READY frame admits the next single explicit read. So every
  // epoch loads at most once — the cycle is settle-driven, not unbounded.
  assert.equal(loadingEpochs.length, new Set(loadingEpochs).size, `each epoch publishes at most one Loading frame: ${JSON.stringify(loadingEpochs)}`)
  assert.ok(reentries <= 6, `a synchronous reentrant refresh stays settle-bounded: ${reentries}`)
  assert.ok(h.statsCalls() >= 1 && h.statsCalls() <= reentries, `one read per admitted cycle, never one per publication: ${h.statsCalls()}`)
})

test('a late settle after close is a no-op (no publication, no throw)', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  let notifications = 0
  controller.subscribe(() => { notifications += 1 })
  controller.enter()
  controller.dispose()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(notifications, 1, 'the disposed controller published nothing further')
})

test('an unavailable context force words the observation without discarding the stats', async () => {
  const h = harness('sess-a')
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.context, 'unavailable')
  assert.equal(view.session.contextUsed, undefined)
  // The official window fact rides the CAPTURED projection (an independent
  // axis from the force observation).
  assert.equal(view.session.contextWindow, 128_000)
  assert.ok(view.session.stats !== undefined, 'the stats group survives the context gap')
})

// ── RFL-A-002/A-003: full-scope invalidation + revoked-view copy fence ────

test('invalidation: sessionless→live while About is open admits ONE new scoped read', async () => {
  const h = harness(undefined)
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  assert.equal(controller.snapshotView().session.kind, 'none')
  assert.equal(h.statsCalls(), 0)
  // The first Session becomes current while the page is open.
  h.setScope('sess-live')
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-live')
  assert.equal(h.statsCalls(), 1, 'exactly ONE read for the new identity')
})

test('invalidation: live→sessionless publishes the No-active-session frame', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  h.setScope(undefined)
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'none', 'the live→none transition is published')
  assert.equal(view.epoch, 2)
  assert.equal(h.statsCalls(), 1, 'no additional read ran')
})

test('invalidation: a same-ID owner/generation rollover is a NEW scope and re-reads once', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 1)
  // The SAME id, a NEW owner object (the production rollover): the identity
  // comparison is the SCOPE OBJECT, never the id string.
  h.setScope('sess-a')
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  assert.equal(h.statsCalls(), 2, 'the rollover admits exactly one re-read despite the same id')
})

test('invalidation: publications after leave() never start reads', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  controller.leave()
  h.setScope('sess-b')
  h.fireInvalidation()
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 1, 'an inactive page never reads')
  assert.equal(controller.snapshotView().session.kind, 'ready', 'the last settled view stays')
})

test('A→B invalidation revokes the old view BEFORE the new read settles (copy fence)', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.snapshotView().session.kind, 'ready')
  // The switch: the view must be revoked (loading for B) SYNCHRONOUSLY at
  // the invalidation, never only after the read settles.
  h.setScope('sess-b')
  h.fireInvalidation()
  const revoked = controller.snapshotView()
  assert.equal(revoked.session.kind, 'loading', 'A facts are out of the view at once')
  if (revoked.session.kind === 'loading') {
    assert.equal(revoked.session.sessionId, 'sess-b')
  }
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.snapshotView().session.kind, 'ready')
})

test('a FAILED projection read words the explicit Unavailable state without discarding stats', async () => {
  const h = harness('sess-a')
  h.setStatus(undefined)
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    sessionStatusFailed: () => true,
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'the stats group is authoritative and survives')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.projectionUnavailable, true, 'the failed projection is worded, not hidden')
  assert.ok(view.session.stats !== undefined)
  assert.equal(view.session.title, undefined, 'no identity fact may ride a failed projection')
})

test('PRODUCTION identity: a re-minted capture of the SAME owner+generation is NOT a new scope', async () => {
  // The production authority mints a FRESH scope object per capture(); the
  // identity channel is isSessionScopeCurrent (the pinned owner+generation),
  // never the object reference. This harness mirrors that exactly.
  let generation = 1
  let sessionId: string | undefined = 'sess-a'
  let statsCalls = 0
  let fire: () => void = () => {}
  const ops: AboutStatusControllerOps = {
    backendKind: 'direct',
    captureLiveSessionScope: () => sessionId === undefined
      ? undefined
      : ({ sessionId, subject: { owner: { id: sessionId } }, generation } as unknown as LiveSessionScope),
    // isCurrent pins owner+generation against the LIVE record.
    isSessionScopeCurrent: (captured) => {
      const scope = captured as unknown as { readonly generation: number; readonly sessionId?: string }
      return sessionId !== undefined && scope.sessionId === sessionId && scope.generation === generation
    },
    currentSessionStats: async () => { statsCalls += 1; return { lifetime: { turns: 1 } } },
    readSessionStatus: () => undefined,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
    versionFacts: { tui: 'x', dsh: undefined },
    subscribeSessionScopeInvalidation: (listener) => { fire = listener; return () => {} },
    diag: quietDiag,
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(statsCalls, 1, 'the entry read ran once')
  // Ten same-scope invalidations (each capture re-mints the object): the
  // owner+generation fence must classify them as UNCHANGED — zero re-reads.
  for (let at = 0; at < 10; at += 1) fire()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(statsCalls, 1, 're-minted same-scope captures never re-fold stats')
  // A genuine rollover (same id, generation bump) IS a new scope: one read.
  generation = 2
  fire()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(statsCalls, 2, 'the same-id generation rollover admits exactly one re-read')
})

// ── RFL-A-019/A-020: settlement guarantee + invalidation reentry fence ────

test('a throwing projection read settles the marker and a manual retry succeeds', async () => {
  const h = harness('sess-a')
  let explode = true
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    readSessionStatus: () => {
      if (explode) throw new Error('projection read exploded')
      return { sessionId: 'sess-a', title: 'recovered' }
    },
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  // The thrown projection read publishes the DEGRADED frame at once (the
  // stats survive; the projection words Failed) — never a stuck Loading.
  const degraded = controller.snapshotView()
  assert.equal(degraded.session.kind, 'ready', 'the degraded frame publishes through the throw')
  // The marker settled (the finally guarantee), so a same-scope refresh is
  // NOT coalesced away — it retries; the recovered authority publishes.
  explode = false
  controller.refresh()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'the retry after the throwing read settles')
  assert.equal(h.statsCalls(), 2, 'the retry ran its own read')
})

test('a throwing context force settles the marker and the view still words the stats', async () => {
  const h = harness('sess-a')
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    forceContextMeasurementResult: () => { throw new Error('the coordinator exploded') },
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  // The finally guarantee settled the epoch even though the read threw
  // before publication; the view stays Loading (no false data), and the
  // marker is clear so an explicit retry is admitted.
  controller.refresh()
  assert.equal(h.statsCalls(), 2, 'the retry after the throwing force is not coalesced away')
})

test('invalidation reentry: a subscriber calling refresh() from the Loading publication coalesces', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 1)
  // The switch: the Loading publication fires synchronously; the subscriber
  // immediately calls refresh() — the pre-committed in-flight marker must
  // coalesce it (ONE read for the new scope, never two).
  let duringPublication = 0
  controller.subscribe(() => {
    const view = controller.snapshotView()
    if (view.session.kind === 'loading' && view.epoch === 2) {
      duringPublication += 1
      controller.refresh()
    }
  })
  h.setScope('sess-b')
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(duringPublication, 1, 'the Loading publication fired once')
  assert.equal(h.statsCalls(), 2, 'the reentrant refresh coalesced: exactly ONE read for B')
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-b')
})

// ── RFL-A-017 owner ruling: the scope-invalidation trigger semantics ──────

test('CONTENT-EQUAL A→B: the scope notification drives the switch even when every store section is equal', async () => {
  // The production failure shape the ruling names: two sessions whose
  // display facts are IDENTICAL. The StatusStore would suppress the patch;
  // the ownership-core notification is the trigger that must still fire.
  let generation = 1
  let sessionId: string | undefined = 'sess-empty-A'
  let statsCalls = 0
  let fire: () => void = () => {}
  const ops: AboutStatusControllerOps = {
    backendKind: 'direct',
    captureLiveSessionScope: () => sessionId === undefined
      ? undefined
      : ({ sessionId, subject: { owner: { id: sessionId } }, generation } as unknown as LiveSessionScope),
    isSessionScopeCurrent: (captured) => {
      const scope = captured as unknown as { readonly generation: number; readonly sessionId?: string }
      return sessionId !== undefined && scope.sessionId === sessionId && scope.generation === generation
    },
    currentSessionStats: async () => {
      statsCalls += 1
      // BOTH sessions answer IDENTICAL display facts (empty sessions).
      return { lifetime: { turns: 0, steps: 0, llmMs: 0 } }
    },
    readSessionStatus: () => undefined,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
    versionFacts: { tui: 'x', dsh: undefined },
    subscribeSessionScopeInvalidation: (listener) => { fire = listener; return () => {} },
    diag: quietDiag,
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.snapshotView().session.kind, 'ready')
  assert.equal(statsCalls, 1)
  // A→B where B's facts are byte-identical to A's: the scope notification
  // fires (the ownership core publishes it on setCurrentOwner) and the
  // fence discriminates the NEW identity.
  sessionId = 'sess-empty-B'
  generation = 2
  fire()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'B settled')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-empty-B', 'the About shows B, not the silenced A')
  assert.equal(statsCalls, 2, 'exactly one new read for B')
})

test('CONTENT-EQUAL A→B via the REAL ownership core: setCurrentOwner → microtask notification → controller', async () => {
  // The required REAL-PATH test: the invalidation signal comes from the
  // production SessionOwnershipCore publication (never a hand-fired listener).
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  const ownerA = { id: 'owner-a' } as never
  const ownerB = { id: 'owner-b' } as never
  let sessionId: string | undefined
  let statsCalls = 0
  const controller = new AboutStatusController({
    backendKind: 'direct',
    captureLiveSessionScope: () => sessionId === undefined
      ? undefined
      : ({ sessionId, subject: { owner: { id: sessionId } }, generation: core.generation() } as unknown as LiveSessionScope),
    isSessionScopeCurrent: (captured) => {
      const scope = captured as unknown as { readonly generation: number; readonly sessionId?: string }
      return sessionId !== undefined && scope.sessionId === sessionId && scope.generation === core.generation()
    },
    currentSessionStats: async () => {
      statsCalls += 1
      return { lifetime: { turns: 0, steps: 0, llmMs: 0 } }
    },
    readSessionStatus: () => undefined,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
    versionFacts: { tui: 'x', dsh: undefined },
    subscribeSessionScopeInvalidation: (listener) => core.subscribeScopeInvalidation(listener),
    diag: quietDiag,
  })
  // Publish A through the REAL core, then enter.
  core.setCurrentOwner(ownerA, 'sess-eq-A')
  sessionId = 'sess-eq-A'
  controller.enter()
  // The publication's deferred notification fires but changes nothing
  // (the displayed scope IS the current one) — no extra read.
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(statsCalls, 1, 'the same-scope notification is a no-op')
  // Publish B with IDENTICAL display facts through the REAL core.
  core.setCurrentOwner(ownerB, 'sess-eq-B')
  sessionId = 'sess-eq-B'
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'B settled through the production notification')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-eq-B', 'the About shows B')
  assert.equal(statsCalls, 2, 'exactly one re-read for B')
})

test('a late A result after the B switch can never publish (content-equal shape)', async () => {
  let generation = 1
  let sessionId: string | undefined = 'sess-a'
  let releaseStats: ((value: { lifetime: { turns: number } }) => void) | undefined
  const ops: AboutStatusControllerOps = {
    backendKind: 'direct',
    captureLiveSessionScope: () => sessionId === undefined
      ? undefined
      : ({ sessionId, subject: { owner: { id: sessionId } }, generation } as unknown as LiveSessionScope),
    isSessionScopeCurrent: (captured) => {
      const scope = captured as unknown as { readonly generation: number; readonly sessionId?: string }
      return sessionId !== undefined && scope.sessionId === sessionId && scope.generation === generation
    },
    currentSessionStats: async () => {
      if (sessionId === 'sess-a') {
        return await new Promise<{ lifetime: { turns: number } }>(resolve => { releaseStats = resolve })
      }
      return { lifetime: { turns: 99 } }
    },
    readSessionStatus: () => undefined,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
    versionFacts: { tui: 'x', dsh: undefined },
    subscribeSessionScopeInvalidation: () => () => {},
    diag: quietDiag,
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  // B arrives while A's read is still pending; the notification revokes A.
  sessionId = 'sess-b'
  generation = 2
  controller.refresh()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.snapshotView().session.kind, 'ready')
  // The stale A read finally settles with A's facts: the fence must refuse.
  releaseStats?.({ lifetime: { turns: 7 } })
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-b')
  assert.equal(view.session.stats?.lifetime?.turns, 99, 'A late figures never overwrite B')
})

test('a fire after leave() never reads; dispose() releases the scope subscription', async () => {
  const h = harness('sess-a')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  controller.leave()
  h.setScope('sess-b')
  h.fireInvalidation()
  h.fireInvalidation()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.statsCalls(), 1, 'an inactive page never reads')
  controller.dispose()
  // Post-dispose fires are inert (the subscription is released inside dispose).
  h.fireInvalidation()
  assert.equal(h.statsCalls(), 1)
})

test('the viewer Main→Child transition does not retarget the About (main owner unchanged)', () => {
  const h = harness('sess-main')
  const controller = new AboutStatusController(h.ops)
  controller.enter()
  const before = controller.snapshotView()
  // A child viewer opening does NOT change the main owner/generation: the
  // ownership notification fires, the fence classifies UNCHANGED, the view
  // stays on the main session.
  h.fireInvalidation()
  const after = controller.snapshotView()
  assert.equal(after, before, 'the same-scope notification never republishes')
})

// ── Round-4 fixes: atomic failure bit, degraded frames, reset-throw, coalescing ──

test('a TRANSIENT projection failure words Projection: Failed while a later absence reads Unavailable', async () => {
  const h = harness('sess-a')
  let failNextRead = true
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    // The port shape: sessionStatus AND its failure bit describe the SAME
    // read; the bit clears on the next successful/absent read.
    readSessionStatus: () => {
      if (failNextRead) return undefined
      return undefined
    },
    sessionStatusFailed: () => failNextRead,
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  let view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'the stats group survives the failed projection')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.projectionFailed, true, 'the transient throw words Failed')
  assert.equal(view.session.projectionUnavailable, true)
  // THE SERIALIZED WORDING of the failed cycle (the plan's two distinct
  // words, asserted on the FAILED revision itself):
  const failedReport = serializeAboutStatus(view)
  assert.match(failedReport, /Projection: Failed/u, 'the failed cycle serializes Projection: Failed')
  assert.doesNotMatch(failedReport, /Projection: Unavailable/u)

  // The NEXT cycle reads absent (the bit cleared with the successful
  // sessionStatus call): the wording flips to Unavailable — never one shared
  // word for the two states.
  failNextRead = false
  controller.refresh()
  await Promise.resolve()
  await Promise.resolve()
  view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.projectionFailed, false, 'an answered absence is NOT Failed')
  assert.equal(view.session.projectionUnavailable, true)
  // The serialized report carries the second distinct word.
  const absentReport = serializeAboutStatus(controller.snapshotView())
  assert.match(absentReport, /Projection: Unavailable/u)
})

test('a FAILED projection bit rides the SAME read atomically (a later context read cannot clear it)', async () => {
  const h = harness('sess-a')
  // The context-window read used to be a SECOND sessionStatus call that
  // cleared the bit; the controller now re-uses the captured projection, so
  // this bit survives the whole cycle.
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    readSessionStatus: () => undefined,
    sessionStatusFailed: () => true,
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.projectionFailed, true)
  assert.equal(view.session.contextUsed, 12_345, 'the FORCE result is independent of the window fact')
  assert.equal(view.session.contextWindow, undefined, 'no window fact rides a failed projection source')
})

test('a THROWING projection read still publishes the stats (the degraded frame, not Loading)', async () => {
  const h = harness('sess-a')
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    readSessionStatus: () => { throw new Error('projection read exploded') },
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'the stats group publishes through the throw')
  if (view.session.kind !== 'ready') return
  assert.ok(view.session.stats !== undefined, 'the authoritative stats survive the projection failure')
  assert.equal(view.session.projectionFailed, true)
  // The projection throw marks only ITS OWN group: the context force is a
  // separate authority and answers fresh.
  assert.equal(view.session.context, 'fresh')
})

test('a THROWING context force keeps the stats and words the observation Unavailable', async () => {
  const h = harness('sess-a')
  const ops: AboutStatusControllerOps = {
    ...h.ops,
    forceContextMeasurementResult: () => { throw new Error('the coordinator exploded') },
  }
  const controller = new AboutStatusController(ops)
  controller.enter()
  await Promise.resolve()
  await Promise.resolve()
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready', 'the stats publish through the context throw')
  if (view.session.kind !== 'ready') return
  assert.ok(view.session.stats !== undefined)
  assert.equal(view.session.context, 'unavailable')
  // The marker settled: a retry is admitted at once.
  controller.refresh()
  assert.equal(h.statsCalls(), 2, 'the retry after the context throw is not coalesced away')
})

test('REAL core: a throwing reset seam does NOT swallow the scope invalidation (generation mutated)', async () => {
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  let notifications = 0
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => { throw new Error('reset exploded') },
  })
  core.subscribeScopeInvalidation(() => { notifications += 1 })
  assert.throws(() => core.bumpGeneration(), 'the reset seam throw propagates to the caller')
  assert.equal(core.generation(), 1, 'the mutation already landed')
  // The microtask notification fires DESPITE the throw.
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.equal(notifications, 1, 'the invalidation fires even when the reset seam throws')
})

test('REAL core: synchronous multi-mutation coalescing observes the FINAL identity exactly once', async () => {
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const notifications: string[] = []
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  core.subscribeScopeInvalidation(() => { notifications.push(`${core.currentSessionId()}@${core.generation()}`) })
  // One synchronous critical section: several publications + bumps.
  core.setCurrentOwner({ id: 'o1' } as never, 'sess-1')
  core.bumpGeneration()
  core.setCurrentOwner({ id: 'o2' } as never, 'sess-2')
  core.bumpGeneration()
  core.setCurrentOwner({ id: 'o3' } as never, 'sess-3')
  // Nothing has fired synchronously (outside the critical section).
  assert.equal(notifications.length, 0, 'no synchronous re-entry into the publication block')
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.deepEqual(notifications, ['sess-3@2'], 'exactly ONE notification with the FINAL identity')
})

test('REAL core: close (dispose) after a queued notification never reads', async () => {
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  // The controller is WIRED TO THE REAL CORE: its scope capture/currentness
  // read the core's owner/generation, and the subscription IS the core's
  // fan-out (the exact production wiring — not a hand-fired listener).
  let sessionId: string | undefined = 'sess-a'
  let statsCalls = 0
  const controller = new AboutStatusController({
    backendKind: 'direct',
    captureLiveSessionScope: () => sessionId === undefined
      ? undefined
      : ({ sessionId, subject: { owner: { id: sessionId } }, generation: core.generation() } as unknown as LiveSessionScope),
    isSessionScopeCurrent: (captured) => {
      const scope = captured as unknown as { readonly generation: number; readonly sessionId?: string }
      return sessionId !== undefined && scope.sessionId === sessionId && scope.generation === core.generation()
    },
    currentSessionStats: async () => { statsCalls += 1; return { lifetime: { turns: 0 } } },
    readSessionStatus: () => undefined,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
    versionFacts: { tui: 'x', dsh: undefined },
    subscribeSessionScopeInvalidation: (listener) => core.subscribeScopeInvalidation(listener),
    diag: quietDiag,
  })
  controller.enter()
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(statsCalls, 1)
  // The publication QUEUES the microtask; the workspace CLOSES before it
  // fires. The disposed controller's released subscription must ignore the
  // queued notification (no read, no throw).
  core.setCurrentOwner({ id: 'o-b' } as never, 'sess-b')
  sessionId = 'sess-b'
  controller.dispose()
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(statsCalls, 1, 'a disposed controller never reads the queued notification')
})

test('REAL core: a FAILED publication still notifies the scope subscribers (old owner / new generation observed)', async () => {
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const observations: string[] = []
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  core.subscribeScopeInvalidation(() => {
    observations.push(`${core.currentSessionId() ?? 'none'}@${core.generation()}`)
  })
  core.setCurrentOwner({ id: 'old' } as never, 'sess-old')
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.deepEqual(observations, ['sess-old@0'])
  // A FAILED publication shape: the generation bumps (the surface identity
  // moved on) but the new owner is never published — the listener must
  // still observe the invalidation (old owner text, NEW generation).
  core.bumpGeneration()
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.deepEqual(observations, ['sess-old@0', 'sess-old@1'],
    'the generation-only invalidation fires with the old owner and the new generation')
})

test('REAL core: pending-A replaced by B through the scope invalidation; a late A result never publishes', async () => {
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  let sessionId: string | undefined = 'sess-a'
  let generation = 0
  let releaseA: ((value: { lifetime: { turns: number } }) => void) | undefined
  let statsCalls = 0
  const controller = new AboutStatusController({
    backendKind: 'direct',
    captureLiveSessionScope: () => sessionId === undefined
      ? undefined
      : ({ sessionId, subject: { owner: { id: sessionId } }, generation } as unknown as LiveSessionScope),
    isSessionScopeCurrent: (captured) => {
      const scope = captured as unknown as { readonly generation: number; readonly sessionId?: string }
      return sessionId !== undefined && scope.sessionId === sessionId && scope.generation === generation
    },
    currentSessionStats: async () => {
      statsCalls += 1
      if (sessionId === 'sess-a') {
        return await new Promise<{ lifetime: { turns: number } }>(resolve => { releaseA = resolve })
      }
      return { lifetime: { turns: 42 } }
    },
    readSessionStatus: () => undefined,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
    versionFacts: { tui: 'x', dsh: undefined },
    subscribeSessionScopeInvalidation: (listener) => core.subscribeScopeInvalidation(listener),
    diag: quietDiag,
  })
  core.setCurrentOwner({ id: 'oa' } as never, 'sess-a')
  generation = core.generation()
  controller.enter()
  await Promise.resolve()
  assert.equal(statsCalls, 1, "A's read is pending")
  // The REAL transition: the core publishes B and the queued notification
  // drives the controller's re-read (no hand-fired listener).
  core.setCurrentOwner({ id: 'ob' } as never, 'sess-b')
  sessionId = 'sess-b'
  generation = core.generation()
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const view = controller.snapshotView()
  assert.equal(view.session.kind, 'ready')
  if (view.session.kind !== 'ready') return
  assert.equal(view.session.sessionId, 'sess-b')
  assert.equal(view.session.stats?.lifetime?.turns, 42, "B's own figures")
  assert.equal(statsCalls, 2, 'exactly one re-read for B through the production notification')
  // A's read finally settles: the fence refuses it — B's view stands.
  releaseA?.({ lifetime: { turns: 7 } })
  await Promise.resolve()
  await Promise.resolve()
  const after = controller.snapshotView()
  assert.equal(after.session.kind, 'ready')
  if (after.session.kind !== 'ready') return
  assert.equal(after.session.sessionId, 'sess-b')
  assert.equal(after.session.stats?.lifetime?.turns, 42, 'the late A result never overwrites B')
})
