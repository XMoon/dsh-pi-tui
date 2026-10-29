/**
 * M3-2 L6: the generic `app/session` runtime over REAL Remote owner services —
 * retain NEW → commit NEW → release OLD ordering, supersession, same-id
 * generation rollover, Remote fork publication→open adoption, and exit/fatal
 * release proof. The semantic lifecycle is a Remote-shaped fake (exact-binding
 * reference model); the owner services under test are the production module.
 * No TUI mount, no Remote product backend.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { createRemoteSessionOwnerServices } from '../../src/app/remote/session-owners.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { bindSessionRuntime, type SessionRuntimeSurface } from '../../src/app/session/runtime.ts'
import { bindSubmissionRuntime } from '../../src/app/submission/runtime.ts'
import type { SessionOwnerRef } from '../../src/app/session/subject.ts'
import type { SessionOwnerRetirement } from '../../src/app/session/owner-access.ts'
import {
  createSessionScopeAuthority,
  SessionScopeSupersededError,
  type SessionScope,
  type SessionScopeAuthority,
  type SessionScopeLive,
} from '../../src/app/session/scope.ts'
import type {
  CreateResult,
  ForkResult,
  OpenResult,
  SessionHandle,
  SessionLifecycle,
} from '../../src/runtime/session-lifecycle-port.ts'
import type { ClientSessionOwner } from '../../src/runtime/session-lifecycle-port.ts'
import type { RemoteConnectionGenerationSource } from '../../src/runtime/remote/session-reader-remote.ts'
import type { RemoteResultLike } from '../../src/runtime/remote/session-writer-remote.ts'

const fakeDiag: Diag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

/** One binding generation in the fake Client model. */
interface FakeBinding {
  readonly sessionId: string
  readonly session: {
    getSnapshot(): { readonly running: boolean }
    subscribe(fn: () => void): () => void
    cancel(): Promise<RemoteResultLike<{ readonly accepted: true }>>
  }
  setRunning(running: boolean): void
  setCancelResult(result: RemoteResultLike<{ readonly accepted: true }>): void
  cancelCalls(): number
}

function makeBinding(sessionId: string): FakeBinding {
  const listeners = new Set<() => void>()
  let running = false
  let cancels = 0
  let cancelResult: RemoteResultLike<{ readonly accepted: true }> = { ok: true, value: { accepted: true } }
  return {
    sessionId,
    session: {
      getSnapshot: (): { readonly running: boolean } => ({ running }),
      subscribe: (fn: () => void): (() => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      cancel: async (): Promise<RemoteResultLike<{ readonly accepted: true }>> => {
        cancels += 1
        return cancelResult
      },
    },
    setRunning: (next: boolean): void => {
      running = next
      for (const fn of [...listeners]) fn()
    },
    setCancelResult: (result): void => { cancelResult = result },
    cancelCalls: (): number => cancels,
  }
}

interface OpenArm {
  /** Runs inside the fake open AFTER the retain; the open still succeeds (the
   *  supersession is then observed by the RUNTIME's fence, not the adapter). */
  duringOpen?: () => Promise<void> | void
  /** The adapter-level supersession contract: release the new reference and
   *  report a superseded open. */
  supersede?: boolean
  /** Fail the open with `unavailable` before retaining. */
  fail?: boolean
}

function harness(options: { retirement?: Partial<SessionOwnerRetirement> } = {}) {
  const events: string[] = []
  const diagnostics: Array<{ readonly message: string; readonly fields?: Record<string, unknown> }> = []
  const diag: Diag = {
    ...fakeDiag,
    error: (message, fields) => { diagnostics.push({ message, fields }) },
  }
  const calls = { forks: 0, opens: [] as string[], creates: 0, fromHandle: 0 }
  const live = new Map<string, { binding: FakeBinding; refs: number }>()
  const arms = new Map<string, OpenArm>()
  let forkHook: (() => void) | undefined
  let nextChildId = 0

  const retain = (sessionId: string): ClientSessionOwner => {
    const existing = live.get(sessionId)
    if (existing === undefined) {
      const binding = makeBinding(sessionId)
      live.set(sessionId, { binding, refs: 1 })
      return wrapOwner(sessionId, binding)
    }
    existing.refs += 1
    return wrapOwner(sessionId, existing.binding)
  }

  const wrapOwner = (sessionId: string, binding: FakeBinding): ClientSessionOwner => {
    let released = false
    return {
      bindingIdentity: binding,
      release: (): void => {
        if (released) return
        released = true
        // Record the core's CURRENT session at release time: the ownership
        // handoff ordering proof (the core must already point at NEW when OLD
        // is released).
        events.push(`release:${sessionId}@current=${core.currentSessionId() ?? '(none)'}`)
        const entry = live.get(sessionId)
        if (entry === undefined) return
        entry.refs -= 1
        if (entry.refs <= 0) live.delete(sessionId)
      },
    }
  }

  let generationState: { id: number } | undefined = { id: 1 }
  const generation: RemoteConnectionGenerationSource = {
    getSnapshot: () => generationState,
    subscribe: () => () => {},
  }
  const services = createRemoteSessionOwnerServices({
    binding: (id: string) => live.get(id)?.binding,
  }, generation)
  let failCompletionIdentity = false
  let currentScope = true
  let scopeAuthority: SessionScopeAuthority | undefined
  let failNextSessionId = false
  let sessionIdCalls = 0
  let throwOnSessionIdCall = 0
  /** Every queue-recall settlement, with the transition state at settle time
   *  (the deferred-recall restoration must happen AFTER the gate cleared). */
  const recallSettlements: Array<{ committed: boolean; inTransition: boolean; gateBusy: boolean }> = []
  /** A test probe run after each settlement — the place to model a pull-back
   *  writer that finishes exactly at a transition boundary. */
  let recallSettleObserver: ((entry: { committed: boolean; inTransition: boolean; gateBusy: boolean }) => void) | undefined
  const countingOwners = {
    owners: {
      ...services.owners,
      fromHandle: (handle: SessionHandle): SessionOwnerRef | undefined => {
        calls.fromHandle += 1
        return services.owners.fromHandle(handle)
      },
      sessionId: (owner: SessionOwnerRef): string => {
        sessionIdCalls += 1
        if (failNextSessionId) {
          failNextSessionId = false
          throw new Error('sessionId exploded before the fork commit')
        }
        if (throwOnSessionIdCall === sessionIdCalls) {
          throwOnSessionIdCall = 0
          throw new Error('sessionId re-read after the publication snapshot')
        }
        return services.owners.sessionId(owner)
      },
      completionIdentity: (owner: SessionOwnerRef): string | undefined => {
        if (failCompletionIdentity) {
          failCompletionIdentity = false
          throw new Error('completionIdentity exploded after publication')
        }
        return services.owners.completionIdentity(owner)
      },
    },
    retirement: services.retirement,
  }

  const lifecycle: SessionLifecycle = {
    create: async (request): Promise<CreateResult> => {
      calls.creates += 1
      const wrapper = retain(request.sessionId)
      return {
        ownership: 'current',
        outcome: { kind: 'created', handle: { session: { id: request.sessionId }, client: wrapper } },
      }
    },
    open: async (request): Promise<OpenResult> => {
      calls.opens.push(request.sessionId)
      events.push(`open:${request.sessionId}`)
      const arm = arms.get(request.sessionId)
      if (arm?.fail === true) {
        return { ownership: 'current', outcome: { kind: 'unavailable', message: `session "${request.sessionId}" is not available in Client state` } }
      }
      const wrapper = retain(request.sessionId)
      if (arm?.duringOpen !== undefined) await arm.duringOpen()
      if (arm?.supersede === true) {
        wrapper.release()
        return { ownership: 'superseded', outcome: { kind: 'cancelled' } }
      }
      return {
        ownership: 'current',
        outcome: { kind: 'opened', handle: { session: { id: request.sessionId }, client: wrapper } },
      }
    },
    fork: async (request): Promise<ForkResult> => {
      calls.forks += 1
      forkHook?.()
      nextChildId += 1
      // Publication only: catalogued identity, NO retain, NO binding.
      return { ownership: 'current', outcome: { kind: 'forked', handle: { session: { id: `child-${nextChildId}` } } } }
    },
  }

  // The REAL queue-recall ledger (its defer/settle pair), so a test can hold a
  // deferred recall across an aborted navigation exactly like an admitted
  // Alt+Up pull-back would.
  const queueRecalls = bindSubmissionRuntime({ surface: {} as never })
  let disposed = false
  let failNextCatalog = false
  const surface: SessionRuntimeSurface = {
    warnRetirement: () => {},
    warnRetirementSkipped: () => {},
    isSurfaceDisposed: (): boolean => disposed,
    beginOpening: (sessionId) => ({ sessionId }),
    clearOpening: () => {},
    settlePendingQueueRecalls: (committed) => {
      events.push(`recalls:${committed}`)
      const entry = {
        committed,
        inTransition: core.barrier.inTransition,
        gateBusy: core.gate.busy,
      }
      recallSettlements.push(entry)
      queueRecalls.settleQueueRecalls(committed)
      recallSettleObserver?.(entry)
    },
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    setCompletionOwner: (identity) => { events.push(`completion:${String(identity)}`) },
    initLiveSession: async (owner) => { events.push(`init:${services.owners.sessionId(owner)}`) },
    refreshLiveCatalog: async (owner) => {
      const sessionId = services.owners.sessionId(owner)
      events.push(`catalog:${sessionId}`)
      if (failNextCatalog) {
        failNextCatalog = false
        throw new Error('controlled catalog refresh failure')
      }
    },
    reportSwitch: (from, to) => { events.push(`switch:${from ?? '(none)'}->${services.owners.sessionId(to)}`) },
    clearUnpinnedDrafts: () => {},
    dropOutgoingActiveDraft: () => { events.push('dropDraft') },
    beginInputHistoryScope: (owner) => { events.push(`inputHistoryScope:${owner}`) },
    retireStaleHistorySeat: () => {},
    withdrawReplacedPresentation: () => { events.push('withdrawReplacedPresentation') },
    reportSwitchFailure: (sessionId, message) => { events.push(`switchfail:${sessionId}:${message}`) },
    launchComposition: async () => ({ composition: {} }),
    setResumeFailure: () => {},
    reportFirstSessionCreateFailure: (message) => { events.push(`firstfail:${message}`) },
    notifyResumeFailure: () => {},
    awaitPendingDefaultWrite: async () => {},
    newSessionId: () => 'session-first',
    sessionCreateCwd: () => '/workspace',
    currentOpening: () => undefined,
    resetOpening: () => {},
  }

  let explodeNextGenerationReset = false
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: (): boolean => disposed,
    resetForGeneration: (): void => {
      if (explodeNextGenerationReset) {
        explodeNextGenerationReset = false
        throw new Error('generation reset exploded after the bump')
      }
    },
  })
  const controller = new AbortController()
  const runtime = bindSessionRuntime(core, {
    owners: countingOwners.owners,
    retirement: { ...services.retirement, ...options.retirement },
    lifecycle,
    lifecycleSignal: controller.signal,
    surface,
    isScopeCurrent: (scope) => scopeAuthority?.isCurrent(scope) ?? currentScope,
    captureScope: () => scopeAuthority?.capture() ?? ({ sessionId: core.currentSessionId() } as SessionScope),
    diag,
  })

  /** Publish one retained session as the current owner (the startup-resume shape). */
  const publishRetained = (sessionId: string): { owner: SessionOwnerRef; wrapper: ClientSessionOwner } => {
    const wrapper = retain(sessionId)
    runtime.publishResumedOwner({ session: { id: sessionId }, client: wrapper }, () => undefined)
    const owner = core.owner()
    assert.ok(owner !== undefined, `publishing ${sessionId} must set a current owner`)
    return { owner, wrapper }
  }

  /** Make the NEXT commit section throw before publication (the
   *  resetSubmitLatency seam runs before bumpGeneration/publishOwner in both
   *  the ordinary and fork commit orders). */
  const failNextCommitBeforePublication = (): void => {
    const original = surface.resetSubmitLatency
    surface.resetSubmitLatency = (): void => {
      surface.resetSubmitLatency = original
      throw new Error('commit seam exploded before publication')
    }
  }

  /** Make the NEXT setCompletionOwner seam throw AFTER the owner publication
   *  (it is the last seam in both commit orders). */
  const failNextCompletionOwnerAfterPublication = (): void => {
    const original = surface.setCompletionOwner
    surface.setCompletionOwner = (identity: string | undefined): void => {
      surface.setCompletionOwner = original
      original(identity)
      throw new Error('completion seam exploded after publication')
    }
  }

  /**
   * PR3-B §7.3 (B2 F1, publication atomicity): make the NEXT
   * `dropOutgoingActiveDraft` seam throw SYNCHRONOUSLY — the shape a
   * throwing renderer render inside the drop would produce. The recorded
   * `droppedBeforeThrow` fact lets a test prove the OLD draft's clear
   * was attempted before the publication (the exact hazard under test).
   */
  const failNextDropWithSideEffect = (): { droppedBeforeThrow(): boolean } => {
    let dropped = false
    const original = surface.dropOutgoingActiveDraft
    surface.dropOutgoingActiveDraft = (): void => {
      surface.dropOutgoingActiveDraft = original
      dropped = true
      throw new Error('drop seam exploded (render IO) before publication')
    }
    return { droppedBeforeThrow: () => dropped }
  }

  return {
    events,
    calls,
    core,
    runtime,
    services,
    controller,
    arms,
    publishRetained,
    retain,
    bindingOf: (id: string): FakeBinding | undefined => live.get(id)?.binding,
    isLive: (id: string): boolean => live.has(id),
    countRefs: (id: string): number => live.get(id)?.refs ?? 0,
    disposeSurface: (): void => { disposed = true },
    setForkHook: (hook: (() => void) | undefined): void => { forkHook = hook },
    failNextGenerationReset: (): void => { explodeNextGenerationReset = true },
    failNextCommitBeforePublication,
    failNextCompletionOwnerAfterPublication,
    failNextDropWithSideEffect,
    failNextCompletionIdentity: (): void => { failCompletionIdentity = true },
    failNextSessionId: (): void => { failNextSessionId = true },
    setScopeCurrent: (current: boolean): void => { currentScope = current },
    setScopeAuthority: (authority: SessionScopeAuthority): void => { scopeAuthority = authority },
    failNextCatalogRefresh: (): void => { failNextCatalog = true },
    diagnostics,
    queueRecalls,
    recallSettlements,
    setRecallSettleObserver: (observer: typeof recallSettleObserver): void => { recallSettleObserver = observer },
    setGeneration: (next: { id: number } | undefined): void => { generationState = next },
    sessionIdCallCount: (): number => sessionIdCalls,
    throwOnSessionIdCall: (call: number): void => { throwOnSessionIdCall = call },
  }
}

test('ordinary switch = retain NEW → commit NEW → release OLD → post-handoff init', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const beforeMap = h.calls.fromHandle
  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  // NEW was opened exactly once and the owner was mapped exactly once for the
  // transition (the resume publication is the +1 before).
  assert.deepEqual(h.calls.opens, ['session-b'])
  assert.equal(h.calls.fromHandle - beforeMap, 1, 'the committed handle is mapped to an owner exactly once')
  // The EXACT event order: retain/open NEW → release OLD (with the core
  // already committed to NEW) → post-handoff init → catalog → switch report.
  const order = ['open:session-b', 'release:session-a@current=session-b', 'init:session-b', 'catalog:session-b', 'switch:session-a->session-b']
  let previous = -1
  for (const marker of order) {
    const index = h.events.indexOf(marker)
    assert.ok(index > previous, `expected "${marker}" after "${order[order.indexOf(marker) - 1] ?? 'start'}" in ${JSON.stringify(h.events)}`)
    previous = index
  }
  assert.equal(h.countRefs('session-a'), 0, 'the OLD generation is fully released')
  assert.equal(h.core.currentSessionId(), 'session-b')
  assert.ok(h.isLive('session-b'), 'the NEW generation stays retained')
})

test('a committed switch survives a post-commit catalog failure and reports it', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextCatalogRefresh()

  assert.equal(await h.runtime.switchSession('session-b'), undefined,
    'the post-commit catalog failure does not turn a committed switch into a refusal')
  assert.equal(h.core.currentSessionId(), 'session-b', 'the published child remains current')
  assert.equal(h.countRefs('session-a'), 0, 'the old owner is still retired')
  assert.deepEqual(h.calls.opens, ['session-b'])
  const catalogIndex = h.events.indexOf('catalog:session-b')
  const reportIndex = h.events.indexOf('switch:session-a->session-b')
  assert.ok(catalogIndex >= 0 && reportIndex > catalogIndex,
    'switch reporting follows the attempted catalog refresh')
  const failure = h.diagnostics.find((entry) => entry.message === 'transition retire failed (child committed)')
  assert.deepEqual(failure?.fields?.['failures'], ['catalog refresh: controlled catalog refresh failure'],
    'the post-commit failure is recorded with its truthful catalog phase')
})

test('the drop rides the publication commit — BEFORE the new session\'s init/catalog', async () => {
  // The external review's probe-886 shape: the OLD draft must be gone
  // BEFORE the new session becomes editable (its hydration lifts the input
  // fence) — i.e. before ANY post-commit await (init/catalog), never after
  // the whole transition settles. Witnessed on the real runtime's event
  // order: the drop event must precede BOTH the new session's init and its
  // catalog refresh.
  const h = harness()
  h.publishRetained('session-a')
  assert.equal(h.events.some(entry => entry.startsWith('inputHistoryScope')), false,
    'the resume publication opens NO scope: the mounted app\'s sessionless pool is already open')
  await h.runtime.switchSession('session-b')
  const dropIndex = h.events.indexOf('dropDraft')
  const initIndex = h.events.findIndex(event => event === 'init:session-b')
  const catalogIndex = h.events.findIndex(event => event === 'catalog:session-b')
  assert.ok(dropIndex !== -1, 'the drop fired')
  assert.ok(initIndex !== -1 && dropIndex < initIndex,
    `the drop precedes the new session's init (drop@${dropIndex}, init@${initIndex})`)
  assert.ok(catalogIndex !== -1 && dropIndex < catalogIndex,
    `the drop precedes the new session's catalog refresh (drop@${dropIndex}, catalog@${catalogIndex})`)
  // The editor-recall scope of the PUBLISHED owner opens at the SAME commit,
  // carrying that owner's id: the new session's hydration reseeds ↕ recall
  // afterwards, and an input accepted in between must survive that reseed.
  const scopeIndex = h.events.indexOf('inputHistoryScope:session-b')
  assert.ok(scopeIndex !== -1 && scopeIndex < initIndex,
    `the editor-recall scope opens before the new session's hydration (scope@${scopeIndex}, init@${initIndex})`)
})

test('a THROWING drop seam is a pre-publication failure — OLD owner/draft stand, NEW is released', async () => {
  // The external review's publication-atomicity probe: the drop used to
  // carry renderer render IO, so a synchronous throw left the OLD draft
  // already cleared while the publication was rolled back to a
  // pre-publication failure (the user stayed on A with a lost draft). The
  // production fix makes the drop PURE STATE at the seam, but the CONTRACT
  // this pins is the runtime's: even if the drop seam THROWS (any future
  // implementation), the transaction is a PRE-publication failure —
  // OLD stays current, the NEW owner is released exactly once, the queued
  // recalls settle ABORTED (restorable) — and the TSP-side pure-state clear
  // means the real renderer never throws here (the tern-tsp-submission
  // suite pins the pure-state primitive itself).
  const h = harness()
  h.publishRetained('session-a')
  const probe = h.failNextDropWithSideEffect()
  const outcome = await h.runtime.switchSession('session-b')
  // The switch FAILED (a pre-publication seam throw propagates as the
  // switch's error string).
  assert.ok(typeof outcome === 'string' && outcome.includes('switch failed'),
    `the throwing drop surfaced as a failed switch: ${outcome}`)
  assert.ok(probe.droppedBeforeThrow(), 'the probe really injected the throw at the drop seam')
  // OLD stands current; NEW is fully released.
  assert.equal(h.core.currentSessionId(), 'session-a', 'the OLD session stayed current')
  assert.equal(h.countRefs('session-b'), 0, 'the NEW reference is released exactly once')
  // The queued recalls settled ABORTED (a pre-publication failure keeps
  // them restorable).
  assert.ok(h.events.includes('recalls:false'),
    'the pre-publication failure settled the queued recalls as aborted')
  // A RETRY after the failure succeeds and drops exactly once (the seam
  // self-restored on first call).
  const retry = await h.runtime.switchSession('session-c')
  assert.equal(retry, undefined, 'the retry switch succeeded')
  assert.equal(h.core.currentSessionId(), 'session-c')
  assert.equal(h.events.filter(event => event === 'dropDraft').length, 1,
    'the successful retry dropped exactly once')
})

test('the active-draft drop fires ONLY at the committed cross-owner switch', async () => {
  // The production call positions: a successful ordinary switch drops the
  // outgoing draft exactly once (AFTER the publication, with the new owner
  // current); a superseded/pre-publication failed switch NEVER drops; and
  // the first-session creation (commit shape C) NEVER drops — there is no
  // outgoing session. The drop is NOT at the generation reset (every shape
  // bumps it).
  const h = harness()
  h.publishRetained('session-a')
  assert.equal(h.events.includes('dropDraft'), false, 'no drop before any switch')
  // A superseded open (pre-publication failure): OLD stays current.
  h.arms.set('session-b', { supersede: true })
  await h.runtime.switchSession('session-b')
  assert.equal(h.events.includes('dropDraft'), false,
    'a pre-publication failed switch never drops the draft (the old owner stands)')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the OLD session stayed current')
  // The committed switch: exactly one drop.
  await h.runtime.switchSession('session-c')
  assert.equal(h.events.filter(event => event === 'dropDraft').length, 1,
    'the committed cross-owner switch dropped the outgoing draft exactly once')
  assert.equal(h.core.currentSessionId(), 'session-c')
  // A same-id open is a no-op switch: no further drop.
  await h.runtime.switchSession('session-c')
  assert.equal(h.events.filter(event => event === 'dropDraft').length, 1,
    'a same-id no-op switch never drops again')
})

test('a NEW superseded before commit is released; OLD stays current; no init', async () => {
  const h = harness()
  h.publishRetained('session-a')
  // The adapter-level supersession contract: the connection generation moved
  // while the retain was in flight, so the adapter releases the NEW reference
  // and reports a superseded open.
  h.arms.set('session-b', { supersede: true })
  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  assert.equal(h.countRefs('session-b'), 0, 'the superseded NEW reference is released exactly once')
  assert.equal(h.core.currentSessionId(), 'session-a', 'OLD remains current')
  assert.ok(!h.events.some(entry => entry.startsWith('init:')), 'no surface init may run for a superseded NEW')
  assert.ok(!h.events.some(entry => entry.startsWith('switch:')), 'no switch may be reported')
})

test('a guarded switch rechecks scope inside the gate before navigation side effects', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const expectedScope = { sessionId: 'session-a' } as SessionScope
  let releaseOpen!: () => void
  const heldOpen = new Promise<void>((resolve) => { releaseOpen = resolve })
  h.arms.set('session-c', { duringOpen: () => heldOpen })
  let switchC: Promise<string | undefined> | undefined
  let switchB: Promise<string | undefined> | undefined
  try {
    switchC = h.runtime.switchSession('session-c')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(h.calls.opens, ['session-c'], 'C holds the transition gate during open')

    const epochBeforeB = h.core.navigationEpoch()
    switchB = h.runtime.switchSession('session-b', expectedScope)
    assert.equal(h.core.navigationEpoch(), epochBeforeB, 'the captured UI intent does not bump navigation before gate admission')
    assert.deepEqual(h.calls.opens, ['session-c'], 'B remains queued behind C')

    h.setScopeCurrent(false)
    releaseOpen()
    assert.equal(await switchC, undefined)
    const epochAfterC = h.core.navigationEpoch()
    assert.equal(await switchB, undefined, 'the stale queued intent is silently refused')
    assert.equal(h.core.currentSessionId(), 'session-c')
    assert.deepEqual(h.calls.opens, ['session-c'], 'stale B never reaches SessionLifecycle.open')
    assert.equal(h.core.navigationEpoch(), epochAfterC, 'stale B has no post-gate navigation side effect')
  } finally {
    releaseOpen()
    if (switchC !== undefined) await switchC
    if (switchB !== undefined) await switchB
  }
})

test('a queued captured scope stays stale through A→C→A even when the Session ID returns', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = createSessionScopeAuthority({
    current: (): SessionScopeLive => {
      const sessionId = h.core.currentSessionId()
      const subject = h.core.captureSubject()
      if (sessionId === undefined || subject === undefined) {
        assert.equal(sessionId, undefined)
        assert.equal(subject, undefined)
        return { subject: undefined, sessionId: undefined, generation: h.core.generation() }
      }
      return { subject, sessionId, generation: h.core.generation() }
    },
    isSubjectCurrent: (subject) => h.core.isSubjectCurrent(subject),
  })
  h.setScopeAuthority(scopeAuthority)
  const capturedA = scopeAuthority.captureLive()
  assert.ok(capturedA)

  let releaseC!: () => void
  const heldC = new Promise<void>((resolve) => { releaseC = resolve })
  h.arms.set('session-c', { duringOpen: () => heldC })
  let switchC: Promise<string | undefined> | undefined
  let reopenA: Promise<string | undefined> | undefined
  let staleB: Promise<string | undefined> | undefined
  try {
    switchC = h.runtime.switchSession('session-c')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(h.calls.opens, ['session-c'], 'C holds the transition gate during open')

    reopenA = h.runtime.switchSession('session-a')
    const epochBeforeStaleB = h.core.navigationEpoch()
    staleB = h.runtime.switchSession('session-b', capturedA)
    assert.equal(h.core.navigationEpoch(), epochBeforeStaleB,
      'the captured UI intent does not bump navigation while queued')
    assert.deepEqual(h.calls.opens, ['session-c'], 'A and B remain queued behind C')

    releaseC()
    assert.equal(await switchC, undefined)
    assert.equal(await reopenA, undefined)
    assert.equal(h.core.currentSessionId(), 'session-a', 'the same Session ID has returned under a new generation')
    assert.equal(scopeAuthority.isCurrent(capturedA), false, 'the original captured owner remains stale')
    const epochAfterReopen = h.core.navigationEpoch()

    assert.equal(await staleB, undefined, 'the old UI intent is silently refused inside the gate')
    assert.equal(h.core.currentSessionId(), 'session-a')
    assert.deepEqual(h.calls.opens, ['session-c', 'session-a'], 'stale B never reaches SessionLifecycle.open')
    assert.equal(h.core.navigationEpoch(), epochAfterReopen, 'stale B has no post-gate navigation side effect')
  } finally {
    releaseC()
    if (switchC !== undefined) await switchC
    if (reopenA !== undefined) await reopenA
    if (staleB !== undefined) await staleB
  }
})

test('a same-id reopen is a NEW owner generation; the stale owner never becomes current', async () => {
  const h = harness()
  const ownerA = h.publishRetained('session-x').owner
  // Capture the stale owner's completion subject BEFORE the rollover: a late
  // completion keyed on owner A's generation must never read as current.
  const staleSubject = h.core.captureSubject()
  assert.ok(staleSubject !== undefined)
  assert.equal(await h.runtime.switchSession('session-y'), undefined)
  assert.equal(await h.runtime.switchSession('session-x'), undefined)
  const ownerB = h.core.owner()
  assert.ok(ownerB !== undefined)
  assert.notEqual(ownerB, ownerA, 'the same id with a new binding is a DIFFERENT owner')
  assert.equal(h.services.owners.sessionId(ownerB), 'session-x')
  assert.equal(h.core.currentSessionId(), 'session-x')
  // The stale owner's captured subject is not current under ANY later
  // generation: the completion fence follows the exact owner object.
  assert.ok(!h.core.isSubjectCurrent(staleSubject),
    'a subject captured on the stale owner generation must never be current')
  // The stale generation's reference is fully released by its retirement.
  assert.equal(h.countRefs('session-x'), 1, 'exactly the new generation\'s reference remains')
})

test('rapid A → B(superseded) → C commits only C and releases each reference once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  let supersedeB!: () => void
  const gate = new Promise<void>(resolve => { supersedeB = resolve })
  h.arms.set('session-b', { duringOpen: () => gate, supersede: true })
  const switchB = h.runtime.switchSession('session-b')
  await new Promise(resolve => setImmediate(resolve))
  // C is admitted while B's acquire is still in flight (queued behind the gate).
  const switchC = h.runtime.switchSession('session-c')
  await new Promise(resolve => setImmediate(resolve))
  supersedeB()
  assert.equal(await switchB, undefined, 'the superseded switch is silent')
  assert.equal(await switchC, undefined)
  assert.equal(h.core.currentSessionId(), 'session-c', 'C is current')
  assert.equal(h.countRefs('session-b'), 0, 'B\'s retained reference was released exactly once')
  assert.ok(!h.events.some(entry => entry === 'init:session-b'), 'B never committed any surface work')
  assert.ok(h.events.includes('init:session-c'))
  // A is retired by the transition that actually committed (C's).
  assert.equal(h.countRefs('session-a'), 0, 'A is released once, by C\'s commit')
})

test('a Remote fork adopts the published child through exactly one open and releases the source once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(outcome.kind, 'success')
  assert.equal(h.calls.forks, 1, 'exactly one Host fork dispatch')
  assert.equal(h.calls.opens.length, 1, 'exactly one adoption open')
  assert.equal(h.calls.opens[0], h.core.currentSessionId(), 'the opened child is the committed session')
  assert.ok(h.core.currentSessionId() !== 'session-a', 'the child is current')
  assert.ok(h.core.currentSessionId()!.startsWith('child-'))
  assert.equal(h.countRefs('session-a'), 0, 'the source owner is released exactly once')
  assert.ok(h.events.includes(`release:session-a@current=${h.core.currentSessionId()!}`),
    'the source owner is released only after the child was committed')
  assert.equal(h.countRefs(h.core.currentSessionId()!), 1, 'the child holds exactly its retained reference')
  assert.ok(h.events.includes(`init:${h.core.currentSessionId()!}`), 'the child surface init ran')
})

test('a THROWING drop seam fails the adoption pre-publication — source/draft stand', async () => {
  // The fork-adoption sibling of the ordinary-switch atomicity probe: the
  // drop rides the adoption's publication seam too, so a synchronous throw
  // there must classify as a PRE-publication failure — the source owner
  // stays current, the acquired child owner is released exactly once, and
  // the recalls settle aborted — never a half-committed child with the
  // source draft already cleared.
  const h = harness()
  h.publishRetained('session-a')
  const probe = h.failNextDropWithSideEffect()
  const outcome = await h.runtime.forkSession('session-a')
  assert.ok(outcome.kind === 'error', `the throwing drop failed the adoption: ${JSON.stringify(outcome)}`)
  assert.ok(probe.droppedBeforeThrow(), 'the probe injected the throw at the drop seam')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the SOURCE session stayed current')
  assert.ok(h.events.includes('recalls:false'),
    'the pre-publication failure settled the queued recalls as aborted')
  // The child owner the Host published was released by the adoption cleanup
  // (never parked, never current).
  assert.equal(h.core.currentSessionId(), 'session-a', 'no child became current')
})

test('a fork stale before adoption never opens the child', async () => {
  const h = harness()
  h.publishRetained('session-a')
  // Bump the navigation epoch while the Host fork dispatch is in flight: the
  // fake fork is async, so this bump lands after admission and before adoption.
  const pending = h.runtime.forkSession('session-a')
  h.core.bumpNavigationEpoch()
  const outcome = await pending
  assert.equal(outcome.kind, 'success')
  assert.equal(h.calls.forks, 1, 'the Host fork still dispatched exactly once')
  assert.equal(h.calls.opens.length, 0, 'a stale navigation must not adopt or open the child')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source remains current')
  assert.equal(h.countRefs('session-a'), 1, 'the source reference stays held')
  assert.equal(h.events.filter(entry => entry.startsWith('recalls:')).length, 0,
    'this stale path never entered the transition gate, so no recall was deferred and none may settle')
})

test('a fork stale AFTER the adoption open releases the NEW owner exactly once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  // The epoch moves during the adoption open (after the retain): the child id
  // is deterministic (child-1 for the first fork).
  h.arms.set('child-1', { duringOpen: () => { h.core.bumpNavigationEpoch() } })
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(outcome.kind, 'success')
  assert.equal(h.calls.opens.length, 1, 'the adoption open ran exactly once')
  assert.equal(h.countRefs('child-1'), 0, 'the retained NEW owner was released exactly once')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source remains current')
  assert.ok(!h.events.some(entry => entry.startsWith('init:child')), 'no child surface init ran')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0, 'nothing may commit the recalls')
  assert.equal(h.events.filter(entry => entry === 'recalls:false').length, 1,
    'the unified fork transaction-finally restores the deferred recall exactly once')
})

test('a failed adoption open never redispatches the fork and keeps the current owner', async () => {  const h = harness()
  h.publishRetained('session-a')
  h.arms.set('child-1', { fail: true })
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(h.calls.forks, 1, 'the Host fork dispatched exactly once (no retry)')
  assert.equal(h.calls.opens.length, 1, 'exactly one adoption open attempt')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the current owner is unchanged')
  assert.equal(h.countRefs('child-1'), 0, 'no Client reference leaked')
  assert.equal(h.countRefs('session-a'), 1, 'the source reference stays held')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0, 'nothing may commit the recalls')
  assert.equal(h.events.filter(entry => entry === 'recalls:false').length, 1,
    'the unified fork transaction-finally restores the deferred recall exactly once')
  // The child is real: the outcome is truthful about the publication, never
  // "the fork did not happen".
  if (outcome.kind === 'error') {
    assert.match(outcome.text, /child-1/)
  } else {
    assert.fail(`a failed adoption must not be reported as a bare success: ${JSON.stringify(outcome)}`)
  }
})

test('a reconnect that preserves the exact binding preserves the owner identity', async () => {
  const h = harness()
  const { owner, wrapper } = h.publishRetained('session-a')
  // Model a normal reconnect: the connection generation changes but the exact
  // binding object AND the TUI's own reference survive. Re-mapping the SAME
  // real wrapper must neither mint a new owner nor release/replace anything.
  const refsBefore = h.countRefs('session-a')
  const remapped = h.services.owners.fromHandle({ session: { id: 'session-a' }, client: wrapper })
  assert.equal(remapped, owner, 'the same exact binding keeps the SAME SessionOwnerRef')
  assert.equal(h.countRefs('session-a'), refsBefore, 're-mapping the live wrapper releases nothing')
  assert.equal(h.core.owner(), owner)
})

test('a full scope retire and re-materialize changes the owner identity', async () => {
  const h = harness()
  const ownerA = h.publishRetained('session-x').owner
  await h.runtime.retireOwnedSession()
  assert.equal(h.countRefs('session-x'), 0, 'the scope is fully retired')
  const ownerB = h.publishRetained('session-x').owner
  assert.notEqual(ownerB, ownerA, 'a re-materialized scope is a NEW owner generation')
})

test('an exit after the fork retain but before commit releases NEW once; OLD retirement is preserved', async () => {
  const h = harness()
  h.publishRetained('session-a')
  // The surface is disposed while the adoption open runs: the NEW owner was
  // retained but must never commit.
  h.arms.set('child-1', { duringOpen: () => { h.disposeSurface() } })
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(outcome.kind, 'success')
  assert.equal(h.countRefs('child-1'), 0, 'the un-committed NEW owner is released exactly once')
  assert.equal(h.core.currentSessionId(), 'session-a', 'no commit happened')
  assert.ok(!h.events.some(entry => entry.startsWith('init:child')), 'no child surface init ran')
  // The exit retirement then releases the CURRENT (old) owner exactly once.
  await h.runtime.retireOwnedSession()
  assert.equal(h.countRefs('session-a'), 0, 'the old owner is retired exactly once')
})

test('a fatal after commit never rolls back to OLD; the retirement releases NEW once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(outcome.kind, 'success')
  const childId = h.core.currentSessionId()!
  assert.notEqual(childId, 'session-a')
  assert.equal(h.countRefs('session-a'), 0, 'OLD was retired by the committed transition')
  // Fatal teardown after the commit: NEW belongs to the core and is released
  // exactly once by the retirement — never handed back to OLD.
  h.disposeSurface()
  await h.runtime.retireOwnedSession()
  assert.equal(h.countRefs(childId), 0, 'NEW is released exactly once')
  assert.equal(h.core.currentSessionId(), childId, 'no rollback to OLD')
})

test('a Direct-shaped owned fork handle adopts directly without any lifecycle open', async () => {
  const h = harness()
  // A Direct provider recognizes `direct` handles; the fake lifecycle records
  // every open. The fork handle below already owns its agent.
  const directOwner = {} as SessionOwnerRef
  const owners = {
    fromHandle: (handle: SessionHandle): SessionOwnerRef | undefined =>
      handle.direct === undefined ? undefined : directOwner,
    sessionId: (): string => 'session-direct-child',
    completionIdentity: (): string | undefined => 'direct-child',
  }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  const sourceOwner = {} as SessionOwnerRef
  core.setCurrentOwner(sourceOwner, 'session-direct-source')
  const runtime = bindSessionRuntime(core, {
    owners,
    retirement: {
      whenIdleOrAbort: async () => false,
      cancel: async () => ({ kind: 'committed', value: undefined }),
      cancelForNavigation: async () => ({ kind: 'committed' as const }),
      flush: async () => {},
      preCancel: () => {},
      retire: async () => ({ failures: [], durabilityFailure: undefined }),
      park: () => {},
      retireParked: async () => ({ failures: [], durabilityFailure: undefined }),
    },
    lifecycle: {
      create: async () => { throw new Error('unexpected create') },
      open: async (request) => {
        h.calls.opens.push(request.sessionId)
        return { ownership: 'current', outcome: { kind: 'unavailable', message: 'unexpected open' } }
      },
      fork: async () => ({
        ownership: 'current',
        outcome: {
          kind: 'forked',
          handle: {
            session: { id: 'session-direct-child' },
            direct: { agent: {}, ownerHandle: {} },
          },
        },
      }),
    },
    lifecycleSignal: new AbortController().signal,
    surface: {
      warnRetirement: () => {},
      warnRetirementSkipped: () => {},
      isSurfaceDisposed: () => false,
      beginOpening: (sessionId) => ({ sessionId }),
      clearOpening: () => {},
      settlePendingQueueRecalls: () => {},
      settleLocalSubmitAck: () => {},
      resetSubmitLatency: () => {},
      setCompletionOwner: () => {},
      initLiveSession: async () => {},
      refreshLiveCatalog: async () => {},
      reportSwitch: () => {},
      clearUnpinnedDrafts: () => {},
    dropOutgoingActiveDraft: () => {},
    beginInputHistoryScope: () => {},
    retireStaleHistorySeat: () => {},
    withdrawReplacedPresentation: () => {},
      reportSwitchFailure: () => {},
      launchComposition: async () => ({ composition: {} }),
      setResumeFailure: () => {},
      reportFirstSessionCreateFailure: () => {},
      notifyResumeFailure: () => {},
      awaitPendingDefaultWrite: async () => {},
      newSessionId: () => 'session-first',
      sessionCreateCwd: () => '/workspace',
      currentOpening: () => undefined,
      resetOpening: () => {},
    } satisfies SessionRuntimeSurface,
    isScopeCurrent: () => true,
    captureScope: () => ({ sessionId: core.currentSessionId() } as SessionScope),
    diag: fakeDiag,
  })
  const outcome = await runtime.forkSession('session-direct-source')
  assert.equal(outcome.kind, 'success')
  assert.deepEqual(h.calls.opens, [], 'a Direct fork must NEVER trigger the extra adoption open')
  assert.equal(core.currentSessionId(), 'session-direct-child')
})

test('a pre-publication commit throw releases the acquired NEW owner; OLD stays current (ordinary switch)', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextCommitBeforePublication()
  const result = await h.runtime.switchSession('session-b')
  assert.match(String(result), /commit seam exploded before publication/,
    'the original failure surfaces to the caller')
  assert.equal(h.core.currentSessionId(), 'session-a', 'OLD remains current')
  assert.ok(!h.events.some(entry => entry.startsWith('init:session-b')), 'no NEW surface init ran')
  assert.ok(!h.events.some(entry => entry.startsWith('switch:')), 'no switch was reported')
  assert.ok(!h.events.includes('recalls:true'),
    'a pre-publication failure must NOT commit the queued recalls')
  assert.ok(h.events.includes('recalls:false'),
    'a pre-publication failure restores the queued recalls')
  // The transition awaits the exactly-once release of the acquired NEW owner
  // before it settles, so the reference count is already zero here.
  assert.equal(h.countRefs('session-b'), 0, 'the pre-commit NEW owner is released exactly once')
  assert.ok(!h.isLive('session-b'))
  // Direct-transitionTo probe (no switchSession wrapper): the recall restore
  // must come from the transition's OWN finally — `transitionCommitted` flips
  // only at the publication, so a pre-publication failure restores the
  // recalls even for callers without an outer settle(false) backstop.
  h.failNextCommitBeforePublication()
  let directError: unknown
  await h.runtime.transitionTo<SessionHandle>({
    target: { id: 'session-c' },
    create: async () => ({ session: { id: 'session-c' }, client: h.retain('session-c') }),
  }).catch(error => { directError = error })
  assert.match(String(directError), /commit seam exploded before publication/,
    'a direct transitionTo caller sees the original failure as a rejection')
  assert.equal(h.core.currentSessionId(), 'session-a', 'OLD remains current after the direct transition failure')
  assert.equal(h.countRefs('session-c'), 0, 'the direct transition released its acquired owner too')
  const falseCount = h.events.filter(entry => entry === 'recalls:false').length
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0,
    'neither failed transition committed the recalls')
  assert.equal(falseCount, 4,
    'each failure restored the recalls (transitionTo finally + the switch body finally + the navigation gate close + the DIRECT transitionTo finally)')
})

test('a pre-publication commit throw after the adoption open releases the retained child exactly once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextCommitBeforePublication()
  const outcome = await h.runtime.forkSession('session-a')
  // The Host fork DID publish the child; only the commit seam failed, so the
  // outcome must not disguise the publication.
  if (outcome.kind === 'success') {
    assert.match(outcome.text ?? '', /child-1/)
  } else {
    assert.match(outcome.text, /child-1/, 'the truthful outcome names the published child')
  }
  assert.equal(h.calls.forks, 1, 'no fork redispatch')
  assert.equal(h.calls.opens.length, 1, 'exactly one adoption open ran')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source remains current')
  assert.equal(h.countRefs('child-1'), 0, 'the retained child owner is released exactly once')
  assert.ok(!h.events.some(entry => entry.startsWith('init:child')), 'no child surface init ran')
  assert.ok(!h.events.includes('recalls:true'), 'a pre-publication fork failure must NOT commit the queued recalls')
  assert.ok(h.events.includes('recalls:false'), 'a pre-publication fork failure restores the queued recalls')
})

test('a Direct pre-publication commit throw releases the child once and never re-parks the released handle', async () => {
  // Direct shape: the fork handle already owns its agent, so the pre-commit
  // cleanup retires (disposes) it. The fork error path must NOT park that
  // released handle back into the Direct owner pool (a later claim would hand
  // out a disposed handle, and the exit drain would double-retire).
  const directChildOwner = {} as SessionOwnerRef
  const sourceOwner = {} as SessionOwnerRef
  const retirementCalls: string[] = []
  let explodeCommit = false
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner(sourceOwner, 'session-direct-source')
  const runtime = bindSessionRuntime(core, {
    owners: {
      fromHandle: (handle: SessionHandle): SessionOwnerRef | undefined =>
        handle.direct === undefined ? undefined : directChildOwner,
      sessionId: (owner: SessionOwnerRef): string =>
        owner === directChildOwner ? 'session-direct-child' : 'session-direct-source',
      completionIdentity: (): string | undefined => 'direct-child',
    },
    retirement: {
      whenIdleOrAbort: async () => false,
      cancel: async () => ({ kind: 'committed', value: undefined }),
      cancelForNavigation: async () => ({ kind: 'committed' as const }),
      flush: async () => {},
      preCancel: () => {},
      retire: async (owner, mode) => {
        retirementCalls.push(`retire:${owner === directChildOwner ? 'child' : 'source'}:${mode}`)
        return { failures: [], durabilityFailure: undefined }
      },
      park: (owner) => { retirementCalls.push(`park:${owner === directChildOwner ? 'child' : 'source'}`) },
      retireParked: async () => ({ failures: [], durabilityFailure: undefined }),
    },
    lifecycle: {
      create: async () => { throw new Error('unexpected create') },
      open: async () => ({ ownership: 'current' as const, outcome: { kind: 'unavailable' as const, message: 'unexpected open' } }),
      fork: async () => ({
        ownership: 'current' as const,
        outcome: {
          kind: 'forked' as const,
          handle: {
            session: { id: 'session-direct-child' },
            direct: { agent: {}, ownerHandle: {} },
          },
        },
      }),
    },
    lifecycleSignal: new AbortController().signal,
    surface: {
      warnRetirement: () => {},
      warnRetirementSkipped: () => {},
      isSurfaceDisposed: () => false,
      beginOpening: (sessionId) => ({ sessionId }),
      clearOpening: () => {},
      settlePendingQueueRecalls: (committed) => { retirementCalls.push(`recalls:` + String(committed)) },
      settleLocalSubmitAck: () => {},
      resetSubmitLatency: (): void => {
        if (explodeCommit) {
          explodeCommit = false
          throw new Error('commit seam exploded before publication')
        }
      },
      setCompletionOwner: () => {},
      initLiveSession: async () => {},
      refreshLiveCatalog: async () => {},
      reportSwitch: () => {},
      clearUnpinnedDrafts: () => {},
    dropOutgoingActiveDraft: () => {},
    beginInputHistoryScope: () => {},
    retireStaleHistorySeat: () => {},
    withdrawReplacedPresentation: () => {},
      reportSwitchFailure: () => {},
      launchComposition: async () => ({ composition: {} }),
      setResumeFailure: () => {},
      reportFirstSessionCreateFailure: () => {},
      notifyResumeFailure: () => {},
      awaitPendingDefaultWrite: async () => {},
      newSessionId: () => 'session-first',
      sessionCreateCwd: () => '/workspace',
      currentOpening: () => undefined,
      resetOpening: () => {},
    } satisfies SessionRuntimeSurface,
    isScopeCurrent: () => true,
    captureScope: () => ({ sessionId: core.currentSessionId() } as SessionScope),
    diag: fakeDiag,
  })
  explodeCommit = true
  const outcome = await runtime.forkSession('session-direct-source')
  assert.equal(outcome.kind, 'error')
  if (outcome.kind === 'error') {
    assert.match(outcome.text, /session-direct-child/, 'the truthful outcome names the published child')
    assert.match(outcome.text, /commit seam exploded/, 'the seam failure is preserved')
  }
  assert.deepEqual(retirementCalls, ['retire:child:transition', 'recalls:false'],
    'the child owner is released exactly once and the recalls are restored by the unified transaction-finally; the child is NEVER re-parked')
  assert.equal(core.currentSessionId(), 'session-direct-source', 'the source remains current')
})

test('a post-publication completion-seam throw is contained: the transition completes and OLD is still retired', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextCompletionOwnerAfterPublication()
  // The seam explodes AFTER core.setCurrentOwner(NEW): the child IS
  // committed, so the failure must be contained as a failed post-commit step —
  // the transition proceeds to the OLD retirement instead of aborting with a
  // half-committed state (NEW current + OLD retained).
  assert.equal(await h.runtime.switchSession('session-b'), undefined,
    'the committed switch stands (the contained seam failure is not a switch failure)')
  assert.equal(h.core.currentSessionId(), 'session-b', 'NEW is current')
  assert.equal(h.countRefs('session-a'), 0, 'OLD is still released by the post-commit retirement')
  assert.ok(h.events.includes('release:session-a@current=session-b'),
    'the OLD release happens with the core already committed to NEW')
  assert.ok(h.events.includes('init:session-b'), 'the post-handoff surface init still runs')
  assert.ok(h.events.includes('switch:session-a->session-b'), 'the switch is still reported')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 1,
    'the queued recalls are committed exactly once (the publication is the commit point)')
  assert.ok(h.events.indexOf('recalls:true') < h.events.indexOf('recalls:false'),
    'no recall restore may precede the commit (the trailing empty-list settle(false) from the switch wrapper is a harmless no-op)')
})

test('a Direct fork post-publication completion-seam throw never rolls back or re-parks the committed child', async () => {
  // Direct shape with a recording retirement: setCompletionOwner explodes
  // AFTER the child was published. The adoption must CONTINUE (source
  // retirement, adopted=true, no park of the now-current child).
  const directChildOwner = {} as SessionOwnerRef
  const sourceOwner = {} as SessionOwnerRef
  const retirementCalls: string[] = []
  let explodeCompletion = false
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner(sourceOwner, 'session-direct-source')
  const runtime = bindSessionRuntime(core, {
    owners: {
      fromHandle: (handle: SessionHandle): SessionOwnerRef | undefined =>
        handle.direct === undefined ? undefined : directChildOwner,
      sessionId: (owner: SessionOwnerRef): string =>
        owner === directChildOwner ? 'session-direct-child' : 'session-direct-source',
      completionIdentity: (): string | undefined => 'direct-child',
    },
    retirement: {
      whenIdleOrAbort: async () => false,
      cancel: async () => ({ kind: 'committed', value: undefined }),
      cancelForNavigation: async () => ({ kind: 'committed' as const }),
      flush: async () => {},
      preCancel: () => {},
      retire: async (owner, mode) => {
        retirementCalls.push(`retire:${owner === directChildOwner ? 'child' : 'source'}:${mode}`)
        return { failures: [], durabilityFailure: undefined }
      },
      park: (owner) => { retirementCalls.push(`park:${owner === directChildOwner ? 'child' : 'source'}`) },
      retireParked: async () => ({ failures: [], durabilityFailure: undefined }),
    },
    lifecycle: {
      create: async () => { throw new Error('unexpected create') },
      open: async () => ({ ownership: 'current' as const, outcome: { kind: 'unavailable' as const, message: 'unexpected open' } }),
      fork: async () => ({
        ownership: 'current' as const,
        outcome: {
          kind: 'forked' as const,
          handle: {
            session: { id: 'session-direct-child' },
            direct: { agent: {}, ownerHandle: {} },
          },
        },
      }),
    },
    lifecycleSignal: new AbortController().signal,
    surface: {
      warnRetirement: () => {},
      warnRetirementSkipped: () => {},
      isSurfaceDisposed: () => false,
      beginOpening: (sessionId) => ({ sessionId }),
      clearOpening: () => {},
      settlePendingQueueRecalls: (committed) => { retirementCalls.push(`recalls:` + String(committed)) },
      settleLocalSubmitAck: () => {},
      resetSubmitLatency: () => {},
      setCompletionOwner: (): void => {
        if (explodeCompletion) {
          explodeCompletion = false
          throw new Error('completion seam exploded after publication')
        }
      },
      initLiveSession: async () => {},
      refreshLiveCatalog: async () => {},
      reportSwitch: () => {},
      clearUnpinnedDrafts: () => {},
    dropOutgoingActiveDraft: () => {},
    beginInputHistoryScope: () => {},
    retireStaleHistorySeat: () => {},
    withdrawReplacedPresentation: () => {},
      reportSwitchFailure: () => {},
      launchComposition: async () => ({ composition: {} }),
      setResumeFailure: () => {},
      reportFirstSessionCreateFailure: () => {},
      notifyResumeFailure: () => {},
      awaitPendingDefaultWrite: async () => {},
      newSessionId: () => 'session-first',
      sessionCreateCwd: () => '/workspace',
      currentOpening: () => undefined,
      resetOpening: () => {},
    } satisfies SessionRuntimeSurface,
    isScopeCurrent: () => true,
    captureScope: () => ({ sessionId: core.currentSessionId() } as SessionScope),
    diag: fakeDiag,
  })
  explodeCompletion = true
  const outcome = await runtime.forkSession('session-direct-source')
  assert.equal(outcome.kind, 'success', 'the committed fork stands')
  assert.deepEqual(retirementCalls, ['recalls:true', 'retire:source:transition'],
    "the recalls stay committed exactly once and the SOURCE is retired post-commit; the committed child is neither retired nor parked")
  assert.equal(core.currentSessionId(), 'session-direct-child', 'the child stays current — no rollback')
})

test('the ordinary pre-publication release is AWAITED: a slow Direct retire keeps the transition open', async () => {
  // Direct shape with a gated retire: the NEW owner's cleanup release blocks
  // on an external gate. The failed transition must NOT settle (and the
  // transition gate must not reopen) until that release actually completes —
  // an exit retirement or a same-session reopen can never race past it.
  const newOwner = {} as SessionOwnerRef
  const oldOwner = {} as SessionOwnerRef
  const retirementCalls: string[] = []
  let releaseRetire!: () => void
  const retireGate = new Promise<void>(resolve => { releaseRetire = resolve })
  let explodeCommit = false
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner(oldOwner, 'session-old')
  const runtime = bindSessionRuntime(core, {
    owners: {
      fromHandle: (): SessionOwnerRef | undefined => newOwner,
      sessionId: (owner: SessionOwnerRef): string => owner === newOwner ? 'session-new' : 'session-old',
      completionIdentity: (): string | undefined => undefined,
    },
    retirement: {
      whenIdleOrAbort: async () => false,
      cancel: async () => ({ kind: 'committed', value: undefined }),
      cancelForNavigation: async () => ({ kind: 'committed' as const }),
      flush: async () => {},
      preCancel: () => {},
      retire: async (owner, mode) => {
        retirementCalls.push(`retire:${owner === newOwner ? 'new' : 'old'}:${mode}`)
        if (owner === newOwner) await retireGate
        return { failures: [], durabilityFailure: undefined }
      },
      park: () => {},
      retireParked: async () => ({ failures: [], durabilityFailure: undefined }),
    },
    lifecycle: {
      create: async () => { throw new Error('unexpected create') },
      open: async () => ({
        ownership: 'current' as const,
        outcome: { kind: 'opened' as const, handle: { session: { id: 'session-new' } } },
      }),
      fork: async () => { throw new Error('unexpected fork') },
    },
    lifecycleSignal: new AbortController().signal,
    surface: {
      warnRetirement: () => {},
      warnRetirementSkipped: () => {},
      isSurfaceDisposed: () => false,
      beginOpening: (sessionId) => ({ sessionId }),
      clearOpening: () => {},
      settlePendingQueueRecalls: (committed) => { retirementCalls.push(`recalls:` + String(committed)) },
      settleLocalSubmitAck: () => {},
      resetSubmitLatency: (): void => {
        if (explodeCommit) {
          explodeCommit = false
          throw new Error('commit seam exploded before publication')
        }
      },
      setCompletionOwner: () => {},
      initLiveSession: async () => {},
      refreshLiveCatalog: async () => {},
      reportSwitch: () => {},
      clearUnpinnedDrafts: () => {},
    dropOutgoingActiveDraft: () => {},
    beginInputHistoryScope: () => {},
    retireStaleHistorySeat: () => {},
    withdrawReplacedPresentation: () => {},
      reportSwitchFailure: () => {},
      launchComposition: async () => ({ composition: {} }),
      setResumeFailure: () => {},
      reportFirstSessionCreateFailure: () => {},
      notifyResumeFailure: () => {},
      awaitPendingDefaultWrite: async () => {},
      newSessionId: () => 'session-first',
      sessionCreateCwd: () => '/workspace',
      currentOpening: () => undefined,
      resetOpening: () => {},
    } satisfies SessionRuntimeSurface,
    isScopeCurrent: () => true,
    captureScope: () => ({ sessionId: core.currentSessionId() } as SessionScope),
    diag: fakeDiag,
  })
  explodeCommit = true
  let settled = false
  const pending = runtime.switchSession('session-new').then(result => { settled = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'the transition must stay open while the NEW owner release is in flight')
  assert.deepEqual(retirementCalls, ['retire:new:transition'], 'the exactly-once release started (recall restore follows in the transition finally)')
  releaseRetire()
  const result = await pending
  assert.match(String(result), /commit seam exploded before publication/, 'the original failure still surfaces')
  assert.equal(core.currentSessionId(), 'session-old', 'OLD stays current')
  assert.deepEqual(retirementCalls.filter(entry => entry.startsWith('retire:')), ['retire:new:transition'],
    'no second release of the NEW owner')
  assert.ok(retirementCalls.indexOf('recalls:false') > retirementCalls.indexOf('retire:new:transition'),
    'the recalls are restored only AFTER the awaited release (the second empty-list settle(false) is the pre-existing switch-wrapper no-op)')
  assert.ok(!retirementCalls.includes('recalls:true'), 'a pre-publication failure never commits the recalls')
})

test('a completionIdentity throw is PRE-publication: nothing commits and the recalls restore (ordinary)', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextCompletionIdentity()
  // The owner-metadata lookup runs BEFORE core.setCurrentOwner (the seamless
  // commit point), so its throw is a pre-publication failure: the transition
  // aborts, the acquired NEW owner is released, and the recalls restore.
  const result = await h.runtime.switchSession('session-b')
  assert.match(String(result), /completionIdentity exploded/,
    'the original failure surfaces to the caller')
  assert.equal(h.core.currentSessionId(), 'session-a', 'OLD stays current')
  assert.equal(h.countRefs('session-b'), 0, 'the acquired NEW owner is released exactly once')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0,
    'nothing may commit the recalls')
  assert.ok(h.events.includes('recalls:false'), 'the recalls are restored')
})

test('a completionIdentity throw is PRE-publication: nothing commits and the recalls restore (fork)', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextCompletionIdentity()
  // The owner-metadata lookup runs BEFORE core.setCurrentOwner, and the
  // navigation identity no longer contains the surface generation, so this
  // post-bump pre-publication throw is NOT misclassified as supersession:
  // the caller gets the truthful adoption failure naming the published child.
  const outcome = await h.runtime.forkSession('session-a')
  if (outcome.kind === 'error') {
    assert.match(outcome.text, /child-1/, 'the truthful outcome names the published child')
    assert.match(outcome.text, /completionIdentity exploded/, 'the seam failure is preserved')
  } else {
    assert.fail('a pre-publication fork failure must not report adoption success')
  }
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source stays current')
  assert.equal(h.countRefs('child-1'), 0, 'the retained child owner is released exactly once')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0, 'nothing may commit the recalls')
  assert.equal(h.events.filter(entry => entry === 'recalls:false').length, 1,
    'the unified fork transaction-finally restores the recalls exactly once')
})

test('a fork refused inside adoptFork (surface disposed during dispatch) restores the deferred recall', async () => {
  const h = harness()
  h.publishRetained('session-a')
  // The surface dies while the Host fork dispatch is in flight: forkSession's
  // own fence does not check disposal, so adoptFork ENTERS the gate (a
  // finishing writer may defer a recall against it) and refuses at its
  // internal fence. The unified transaction-finally must restore the recall.
  h.setForkHook(() => { h.disposeSurface() })
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(outcome.kind, 'success')
  assert.equal(h.calls.opens.length, 0, 'a disposed surface must not adopt or open the child')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source remains current')
  assert.equal(h.countRefs('session-a'), 1, 'the source reference stays held')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0, 'nothing may commit the recalls')
  assert.equal(h.events.filter(entry => entry === 'recalls:false').length, 1,
    'the gate-held refusal restores the deferred recall exactly once through the unified finally')
})

test('a post-bump generation-reset throw is a truthful failure, never supersession silence', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextGenerationReset()
  // runForkCommit bumps the generation and THEN resets the presentation; the
  // reset throws BEFORE the owner publication. The navigation identity
  // (session id + navigation epoch) is untouched by the bump, so this local
  // commit-seam failure must NOT be misclassified as user supersession: the
  // caller gets the truthful adoption failure, the source stays current, the
  // acquired child owner is released exactly once, and the recalls restore.
  const outcome = await h.runtime.forkSession('session-a')
  if (outcome.kind === 'error') {
    assert.match(outcome.text, /child-1/, 'the truthful outcome names the published child')
    assert.match(outcome.text, /generation reset exploded/, 'the seam failure is preserved')
  } else {
    assert.fail('a post-bump pre-publication commit failure must surface, not go silent')
  }
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source stays current')
  assert.equal(h.countRefs('child-1'), 0, 'the retained child owner is released exactly once')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0, 'nothing may commit the recalls')
  assert.equal(h.events.filter(entry => entry === 'recalls:false').length, 1,
    'the unified fork transaction-finally restores the deferred recall exactly once')
  // The generation stays bumped (no rollback): a same-owner surface with a
  // new presentation generation is a valid state.
  assert.ok(h.core.generation() >= 1, 'the generation bump is not rolled back')
})

test('a sessionId throw inside the fork commit region releases the open-retained child exactly once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  h.failNextSessionId()
  // The lookup throws INSIDE the protected pre-publication region (after the
  // adoption open retained the child, before any publication): the child
  // owner must be released exactly once, the recalls restored exactly once by
  // the unified finally, and the caller gets the truthful failure.
  const outcome = await h.runtime.forkSession('session-a')
  if (outcome.kind === 'error') {
    assert.match(outcome.text, /child-1/, 'the truthful outcome names the published child')
    assert.match(outcome.text, /sessionId exploded/, 'the seam failure is preserved')
  } else {
    assert.fail('a pre-publication fork failure must not report adoption success')
  }
  assert.equal(h.core.currentSessionId(), 'session-a', 'the source stays current')
  assert.equal(h.countRefs('child-1'), 0, 'the open-retained child owner is released exactly once — no leak')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 0, 'nothing may commit the recalls')
  assert.equal(h.events.filter(entry => entry === 'recalls:false').length, 1,
    'the unified fork transaction-finally restores the deferred recall exactly once')
})

test('no owner metadata re-read after the publication: a contained ordinary failure still retires OLD', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const baseline = h.sessionIdCallCount()
  // Call 1 after arming = the pre-publication snapshot (must succeed); any
  // LATER sessionId call (a post-publication re-read) throws. The completion
  // seam then throws post-publication: the containment must consume the
  // snapshot only — OLD still retires, NEW stays current.
  h.throwOnSessionIdCall(baseline + 1 + 1)
  h.failNextCompletionOwnerAfterPublication()
  assert.equal(await h.runtime.switchSession('session-b'), undefined,
    'the contained failure must not turn into a half-commit through a metadata re-read')
  assert.equal(h.core.currentSessionId(), 'session-b', 'NEW is current')
  assert.equal(h.countRefs('session-a'), 0, 'OLD is still retired by the post-commit retirement')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 1, 'the recalls stay committed exactly once')
})

test('no owner metadata re-read after the publication: the fork still retires the source exactly once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const baseline = h.sessionIdCallCount()
  // Calls 1-2 after arming = the pre-publication snapshot (child + source,
  // both must succeed); any LATER call (a post-publication OLD re-read)
  // throws. The fork must still retire the source exactly once and succeed.
  h.throwOnSessionIdCall(baseline + 2 + 1)
  const outcome = await h.runtime.forkSession('session-a')
  assert.equal(outcome.kind === 'success' && outcome.text !== undefined, true,
    'the fork succeeds — the source retirement consumed the snapshot')
  assert.ok(h.core.currentSessionId()!.startsWith('child-'), 'the child is current')
  assert.equal(h.countRefs('session-a'), 0, 'the source owner is retired exactly once')
  assert.equal(h.events.filter(entry => entry === 'recalls:true').length, 1, 'the recalls stay committed exactly once')
})

// ── the control admission: Stop during a frozen navigation transition ─────

/** Install the production scope authority over this harness's ownership core. */
function installScope(h: ReturnType<typeof harness>): SessionScopeAuthority {
  const authority = createSessionScopeAuthority({
    current: (): SessionScopeLive => {
      const sessionId = h.core.currentSessionId()
      const subject = h.core.captureSubject()
      if (sessionId === undefined || subject === undefined) {
        assert.equal(sessionId, undefined)
        assert.equal(subject, undefined)
        return { subject: undefined, sessionId: undefined, generation: h.core.generation() }
      }
      return { subject, sessionId, generation: h.core.generation() }
    },
    isSubjectCurrent: (subject) => h.core.isSubjectCurrent(subject),
  })
  h.setScopeAuthority(authority)
  return authority
}

test('the control interrupt reaches the EXACT old binding while a navigation transition is frozen, before its writer drains', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)

  // An ordinary writer admitted BEFORE the navigation: it holds the barrier
  // drain open while the transition is already frozen.
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = h.runtime.withWriter(oldScope, async () => {
    h.events.push('writer-start')
    await writerGate
    h.events.push(`writer-end@${h.core.currentSessionId() ?? '(none)'}`)
  })
  const transition = h.runtime.switchSession('session-b')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.core.barrier.inTransition, true, 'the navigation transition froze the writer barrier')
  assert.equal(h.core.barrier.activeWriters, 1, 'the admitted writer is still outstanding')
  assert.equal(h.events.includes('open:session-b'), false, 'the transition body has not run yet')
  // The navigation admission already stopped the captured old generation ONCE,
  // before the drain (the PR-B order).
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 1,
    'the navigation stop reached the exact old binding before the writer drain')

  // The Busy Esc / Stop control entry: it is admitted while frozen, captures
  // the SAME exact OLD owner and cancels only that generation's binding again
  // (a user Stop after the navigation stop is a Host no-op, but it must still
  // be addressed exactly).
  assert.deepEqual(await h.runtime.interrupt(oldScope), { kind: 'committed', value: undefined })
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 2, 'the OLD exact binding received the control cancel')
  assert.equal(h.bindingOf('session-b'), undefined, 'the NEW binding was not even materialized by the control')
  assert.equal(h.events.includes('open:session-b'), false, 'the control did not shortcut the writer drain')

  releaseWriter()
  await writer
  assert.ok(h.events.includes('writer-end@session-a'),
    'the admitted writer resumed while OLD was still the current owner: it could never address the NEW owner')
  assert.equal(await transition, undefined)
  assert.equal(h.core.currentSessionId(), 'session-b', 'the transition still committed the NEW owner')
  assert.equal(h.bindingOf('session-b')!.cancelCalls(), 0, 'the control cancel never touched the NEW owner')
  assert.equal(h.countRefs('session-a'), 0, 'the transition retirement released OLD exactly once')
})

test('the control interrupt refuses a stale captured scope before any backend cancel', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)

  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  assert.equal(h.core.currentSessionId(), 'session-b')

  assert.deepEqual(await h.runtime.interrupt(oldScope), { kind: 'cancelled' },
    'a superseded capture is a confirmed pre-dispatch cancellation, never a generic failure')
  assert.equal(h.bindingOf('session-b')!.cancelCalls(), 0, 'the stale capture never cancels the current generation')
  await assert.rejects(
    h.runtime.withControl(oldScope, () => { throw new Error('the control task must never run') }),
    (error: unknown) => error instanceof SessionScopeSupersededError,
    'the control admission keeps the same exact-scope refusal as a writer',
  )
})

test('the control interrupt with an aborted runner is cancelled and never reaches the backend', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  h.controller.abort()
  assert.deepEqual(await h.runtime.interrupt(scope), { kind: 'cancelled' })
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 0)
})

// ── the navigation admission: stop the captured old generation, then switch ─
//
// A selected-session switch and `/new` are USER NAVIGATIONS: the captured OLD
// generation is stopped EXACTLY once, after the barrier freeze and BEFORE the
// admitted-writer drain, and a refused/unproven stop aborts BEFORE any target
// open/create. The stop is the official one-shot Host cancel of the exact
// binding generation (`SessionFace.cancel` in the fake model), never a
// `preCancel` no-op.

test('a selected-session switch stops the exact captured owner BEFORE its writer drain, then commits', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)

  // An ordinary writer admitted BEFORE the navigation holds the drain open.
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = h.runtime.withWriter(oldScope, async () => {
    h.events.push('writer-start')
    await writerGate
    h.events.push('writer-end')
  })
  const transition = h.runtime.switchSession('session-b', oldScope)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.core.barrier.inTransition, true, 'the switch froze the barrier')
  assert.equal(h.core.barrier.activeWriters, 1, 'the admitted writer is still outstanding')
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 1,
    'the navigation stop reached the exact captured binding while the writer still drains')
  assert.deepEqual(h.calls.opens, [], 'the target open has not run before the drain')

  releaseWriter()
  await writer
  assert.equal(await transition, undefined)
  assert.equal(h.core.currentSessionId(), 'session-b', 'the switch committed after the drain')
  assert.equal(h.bindingOf('session-b')!.cancelCalls(), 0, 'the target generation never receives the old stop')
  assert.deepEqual(h.calls.opens, ['session-b'], 'the target is opened exactly once, after the drain')
  assert.equal(h.countRefs('session-a'), 0, 'the replaced owner is released exactly once')
})

test('a REFUSED navigation stop keeps the old session current and never opens the target', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)
  // A pinned domain refusal (a proven pre-dispatch rejection): the stop did NOT
  // happen, so navigation must not create/switch behind a possibly running Turn.
  h.bindingOf('session-a')!.setCancelResult({
    ok: false,
    error: { code: 'session/not-found', message: 'no live Agent for the addressed session' },
  })
  const message = await h.runtime.switchSession('session-b', oldScope)
  assert.equal(h.core.currentSessionId(), 'session-a', 'the old session stays current')
  assert.deepEqual(h.calls.opens, [], 'the target is never opened')
  assert.equal(h.countRefs('session-b'), 0, 'no target generation is retained')
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 1, 'the refused stop was dispatched exactly once')
  assert.match(String(message), /the current turn could not be stopped/)
  assert.doesNotMatch(String(message), /may already have stopped/,
    'a proven refusal must not claim the old Turn may have stopped')
  assert.match(String(message), /the session was not switched/)
})

test('an INDETERMINATE navigation stop aborts with the may-have-stopped statement and never opens the target', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)
  // An unproven carrier failure after dispatch: the cancel may have taken
  // effect, so the navigation aborts (no child) and never retries.
  h.bindingOf('session-a')!.setCancelResult({
    ok: false,
    error: { code: 'gateway/internal', message: 'carrier internal' },
  })
  const message = await h.runtime.switchSession('session-b', oldScope)
  assert.equal(h.core.currentSessionId(), 'session-a', 'the old session stays current')
  assert.deepEqual(h.calls.opens, [], 'the target is never opened')
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 1, 'an indeterminate stop is never replayed')
  assert.match(String(message), /unconfirmed result/)
  assert.match(String(message), /the current turn may already have stopped/,
    'the failure must state that the old Turn may already be stopped')
  assert.match(String(message), /the session was not switched/)
})

test('a stale captured scope never stops the replacement session', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)
  // Another navigation commits first: the captured A scope is now stale.
  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  assert.equal(h.core.currentSessionId(), 'session-b')
  const cancelCallsBefore = h.bindingOf('session-b')!.cancelCalls()
  const opensBefore = [...h.calls.opens]
  const superseded = await h.runtime.switchSession('session-c', oldScope)
  assert.equal(superseded, undefined, 'a superseded queued switch settles silently')
  assert.equal(h.bindingOf('session-b')!.cancelCalls(), cancelCallsBefore,
    'the stale intent never stops the replacement generation')
  assert.deepEqual(h.calls.opens, opensBefore, 'the stale intent never opens its target')
  assert.equal(h.core.currentSessionId(), 'session-b')
})

test('withNavigation writes the admission fact BEFORE the body and stops the captured owner once', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const intent = {
    scope: scopeAuthority.capture(),
    admission: { oldStopAccepted: false },
  }
  // A held writer keeps the drain open: the body must not run until it settles,
  // while the stop has already been dispatched.
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const oldScope = scopeAuthority.captureLive()
  assert.ok(oldScope !== undefined)
  const writer = h.runtime.withWriter(oldScope, async () => { await writerGate })
  const task = h.runtime.withNavigation(intent, async () => {
    assert.equal(intent.admission.oldStopAccepted, true,
      'the body must observe the accepted stop fact')
    h.events.push('navigation-body')
    return 'created'
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 1, 'the admission stopped the captured owner')
  assert.equal(h.events.includes('navigation-body'), false, 'the body still waits for the writer drain')
  releaseWriter()
  await writer
  assert.equal(await task, 'created')
  assert.ok(h.events.includes('navigation-body'))
})

test('a refused navigation stop aborts withNavigation BEFORE its body (create is never dispatched)', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const intent = {
    scope: scopeAuthority.capture(),
    admission: { oldStopAccepted: false },
  }
  h.bindingOf('session-a')!.setCancelResult({
    ok: false,
    error: { code: 'session/not-found', message: 'no live Agent for the addressed session' },
  })
  let bodyRan = false
  await assert.rejects(
    h.runtime.withNavigation(intent, () => { bodyRan = true; return 'created' }),
    (error: unknown) => error instanceof Error
      && error.name === 'SessionNavigationStopError'
      && /could not be stopped/.test(error.message),
    'the refused stop aborts the navigation with the typed failure',
  )
  assert.equal(bodyRan, false, 'the transition body never runs')
  assert.equal(intent.admission.oldStopAccepted, false, 'no stop may be reported')
  assert.equal(h.core.currentSessionId(), 'session-a')
  assert.equal(h.core.barrier.inTransition, false, 'the aborted admission unfreezes the barrier')
  assert.equal(h.core.barrier.activeWriters, 0)
})

test('a caller-cancelled cancel still aborts navigation: only a COMMITTED stop may proceed', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  // The official call was dispatched, then its reply was a caller/carrier
  // cancellation (PR-A's `cancelled`). The navigation must NOT read that as
  // permission to switch: only a committed stop may enter quiesce/create.
  h.bindingOf('session-a')!.setCancelResult({
    ok: false,
    error: { code: 'gateway/cancelled', message: 'carrier cancelled the reply' },
  })
  const message = await h.runtime.switchSession('session-b', scope)
  assert.equal(h.core.currentSessionId(), 'session-a', 'the old session stays current')
  assert.deepEqual(h.calls.opens, [], 'the target is never opened')
  assert.equal(h.bindingOf('session-a')!.cancelCalls(), 1, 'the dispatched cancel is never replayed')
  assert.match(String(message), /unconfirmed result/)
  assert.match(String(message), /the current turn may already have stopped/,
    'a DISPATCHED caller cancellation is the dispatched-unproven settlement for navigation')
})

test('an UNADDRESSABLE exact generation aborts navigation: cancelled is NOT permission to switch', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  // A disconnected Connection generation: the official cancel can never be
  // dispatched (PR-A's `cancelled`), but that does NOT prove the Host has no
  // running work for the exact generation. Navigation keeps the PR-A
  // classification (no fake `indeterminate`) and aborts before any open.
  const oldBinding = h.bindingOf('session-a')!
  h.setGeneration(undefined)
  const message = await h.runtime.switchSession('session-b', scope)
  assert.match(String(message), /the current turn could not be stopped/)
  assert.match(String(message), /not been proven stopped/)
  assert.doesNotMatch(String(message), /may already have stopped/)
  assert.equal(h.core.currentSessionId(), 'session-a', 'the old session stays current')
  assert.deepEqual(h.calls.opens, [], 'the target is never opened')
  assert.equal(oldBinding.cancelCalls(), 0, 'no cancel was dispatched on the disconnected generation')
})

test('a RELEASED exact owner reference aborts navigation: cancelled is not permission to switch', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  const owner = h.core.owner()
  assert.ok(owner !== undefined)
  const oldBinding = h.bindingOf('session-a')!
  // The exact owner reference was released while the app-level subject still
  // reports it as current (the adapter's pre-dispatch `cancelled` family), and
  // the same Session id is re-materialized as a NEW binding generation.
  await h.services.retirement.retire(owner, 'transition')
  const replacement = h.retain('session-a')
  const replacementBinding = h.bindingOf('session-a')!
  const message = await h.runtime.switchSession('session-b', scope)
  assert.match(String(message), /the current turn could not be stopped/)
  assert.match(String(message), /not been proven stopped/)
  assert.equal(h.core.currentSessionId(), 'session-a', 'the old session stays current')
  assert.deepEqual(h.calls.opens, [], 'the target is never opened')
  assert.equal(oldBinding.cancelCalls(), 0, 'no official cancel was dispatched')
  assert.equal(replacementBinding.cancelCalls(), 0,
    'the replaced same-id generation never receives the old owner cancel')
  replacement.release()
})

test('a failed navigation stop restores the deferred queue recall AFTER the gate clears (no leak into a later transition)', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  // Hold the official stop call: this is the window in which an already
  // admitted Alt+Up pull-back can finish, remove its occurrences and DEFER its
  // local restore to the pending transition. The stop then fails, so the
  // transition body and its own settlement never run.
  const binding = h.bindingOf('session-a')!
  let releaseDispatch!: () => void
  const dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve })
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const originalCancel = binding.session.cancel
  binding.session.cancel = async () => {
    entered()
    await dispatchGate
    return { ok: false, error: { code: 'gateway/internal', message: 'carrier internal' } }
  }
  const transition = h.runtime.switchSession('session-b', scope)
  await enteredPromise
  assert.equal(h.core.barrier.inTransition, true, 'the stop runs inside the frozen transition')
  assert.deepEqual(h.calls.opens, [], 'the body has not run')
  assert.equal(h.recallSettlements.length, 0, 'nothing has been settled while the stop is in flight')
  releaseDispatch()
  const message = await transition
  assert.match(String(message), /unconfirmed result/)
  assert.deepEqual(h.calls.opens, [], 'the aborted navigation never opens its target')
  assert.equal(h.core.currentSessionId(), 'session-a')
  assert.equal(h.recallSettlements.length, 1,
    'the aborted admission settles the one deferred recall exactly once')
  assert.deepEqual(h.recallSettlements[0], { committed: false, inTransition: false, gateBusy: false },
    'the recall is restored only AFTER the barrier unfroze AND the gate cleared')
  // The barrier/gate are reusable, and a later navigation settles its own
  // (empty) recall ledger without replaying the old one.
  binding.session.cancel = originalCancel
  assert.equal(await h.runtime.switchSession('session-b', scope), undefined)
  assert.equal(h.core.currentSessionId(), 'session-b')
  // The successful navigation's own ledger is empty: its commit settles `true`
  // and its body/gate settles are no-ops. The failed admission's restore stays
  // the FIRST and only aborted settlement.
  assert.deepEqual(h.recallSettlements.map(entry => entry.committed), [false, true, false, false])
  assert.deepEqual(h.recallSettlements[0], { committed: false, inTransition: false, gateBusy: false })
})

test('a scoped switch to the CURRENT session is a no-op: no stop, no open (seam contract)', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  const binding = h.bindingOf('session-a')!
  // No current production scoped caller (the TSP browser filters the same id
  // before it reaches the runtime), but the seam contract must not cancel the
  // current turn if a future caller passes it.
  assert.equal(await h.runtime.switchSession('session-a', scope), 'already on this session')
  assert.equal(h.core.currentSessionId(), 'session-a')
  assert.equal(binding.cancelCalls(), 0, 'a no-op switch must not stop the current owner turn')
  assert.deepEqual(h.calls.opens, [], 'a no-op switch must not reopen the current Session')
  assert.equal(h.recallSettlements.length, 2, 'the no-op gesture still settles its recall fence (in-task and at gate close)')
  assert.deepEqual(h.recallSettlements[0], { committed: false, inTransition: false, gateBusy: true },
    'the no-op settles INSIDE its gate task (no freeze, no body)')
  assert.deepEqual(h.recallSettlements[1], { committed: false, inTransition: false, gateBusy: false },
    'the navigation gate close runs after the task cleared and before any next task')
})

test('a failed admission aborts its deferred recall BEFORE the queued next navigation starts', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  const binding = h.bindingOf('session-a')!
  // The first navigation's official stop is HELD; the second navigation queues
  // behind it in the same FIFO. The first stop then fails.
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  let stopEntered!: () => void
  const stopEnteredPromise = new Promise<void>(resolve => { stopEntered = resolve })
  let cancelCalls = 0
  const originalCancel = binding.session.cancel
  binding.session.cancel = async () => {
    cancelCalls += 1
    if (cancelCalls === 1) {
      stopEntered()
      await stopGate
      return { ok: false, error: { code: 'gateway/internal', message: 'carrier internal' } }
    }
    return { ok: true, value: { accepted: true } }
  }
  const recallLog: string[] = []
  // The exact deferred ledger an admitted Alt+Up pull-back would park while the
  // transition is pending (`deferQueueRecall` is its production entry).
  h.queueRecalls.deferQueueRecall({
    commit: () => recallLog.push('commit'),
    abort: () => recallLog.push('abort'),
  })
  const first = h.runtime.switchSession('session-b', scope)
  await stopEnteredPromise
  assert.equal(h.core.barrier.inTransition, true, 'the first navigation holds the frozen barrier')
  const second = h.runtime.switchSession('session-c')
  assert.equal(h.core.gate.pending, true, 'the second navigation is QUEUED behind the first')
  releaseStop()
  assert.match(String(await first), /unconfirmed result/)
  assert.equal(await second, undefined)
  assert.deepEqual(recallLog, ['abort'],
    'the deferred recall is aborted once, before the next transition can commit it')
  assert.equal(h.core.currentSessionId(), 'session-c', 'the queued navigation still commits normally')
  assert.equal(h.recallSettlements[0]!.gateBusy, false,
    'the restore ran after the gate cleared and BEFORE the queued next task started')
  assert.equal(h.recallSettlements[0]!.inTransition, false)
  assert.equal(h.recallSettlements.filter(entry => entry.committed).length, 1,
    'the second navigation commits only its own (already empty) ledger')
})

test('a recall deferred at a boundary is settled by the QUEUED stale navigation, never leaked', async () => {
  const h = harness()
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scopeA = scopeAuthority.captureLive()
  assert.ok(scopeA !== undefined)
  const binding = h.bindingOf('session-a')!
  // The first navigation commits B (with one keepInbox stop); the second scoped
  // intent was captured while A was current and is STALE by the time its gate
  // turn comes, so it returns silently without a body.
  const first = h.runtime.switchSession('session-b', scopeA)
  const second = h.runtime.switchSession('session-c', scopeA)
  assert.equal(h.core.gate.pending, true, 'the second intent is queued behind the first')
  const recallLog: string[] = []
  let injected = false
  // Model the production late writer: `isTransitionPending` is
  // `gate.pending || barrier.inTransition`, so a pull-back finishing exactly
  // after the FIRST navigation's gate close (and while the stale second is
  // queued) still defers. The observer fires on that first close.
  h.setRecallSettleObserver(entry => {
    if (injected || entry.committed || entry.inTransition || entry.gateBusy) return
    injected = true
    h.queueRecalls.deferQueueRecall({
      commit: () => recallLog.push('commit'),
      abort: () => recallLog.push('abort'),
    })
  })
  assert.equal(await first, undefined)
  assert.equal(await second, undefined, 'the stale scoped intent is refused silently')
  assert.equal(h.core.currentSessionId(), 'session-b')
  assert.deepEqual(h.calls.opens, ['session-b'], 'the stale intent never opens its target')
  assert.equal(injected, true, 'the boundary deferral was actually injected')
  assert.deepEqual(recallLog, ['abort'],
    'the queued stale navigation still closed the deferred-recall window instead of leaking it')
  assert.equal(binding.cancelCalls(), 1, 'only the first navigation stopped the old owner')
})

test('a binding rollover after an accepted cancel reports "requested, not confirmed", never a stopped Turn', async () => {
  // The Host ACCEPTED the cancel (committed), then the exact Remote binding
  // became unobservable before the quiesce: `whenIdleOrAbort` reports
  // 'unobservable' (NOT idle). A subsequent open failure must use the weak
  // claim.
  const h = harness({
    retirement: {
      cancelForNavigation: async () => ({ kind: 'committed' }),
      whenIdleOrAbort: async () => 'unobservable',
      flush: async () => {},
    },
  })
  h.publishRetained('session-a')
  const scopeAuthority = installScope(h)
  const scope = scopeAuthority.captureLive()
  assert.ok(scope !== undefined)
  const message = await h.runtime.switchSession('session-b', scope)
  assert.match(String(message), /no longer observable/)
  assert.match(String(message), /turn stop requested \(not yet confirmed\)/)
  assert.doesNotMatch(String(message), /old turn stopped \(cannot resume\)/,
    'an unobservable binding is not proof that the old Turn stopped')
  assert.equal(h.core.currentSessionId(), 'session-a', 'the old session stays current')
  assert.deepEqual(h.calls.opens, [], 'the target open is NEVER attempted without a confirmed old quiesce')
})
