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
import type { Diag } from '../src/diag.ts'
import { createRemoteSessionOwnerServices } from '../src/app/remote/session-owners.ts'
import { createSessionOwnershipCore } from '../src/app/session/ownership-core.ts'
import { bindSessionRuntime, type SessionRuntimeSurface } from '../src/app/session/runtime.ts'
import type { SessionOwnerRef } from '../src/app/session/subject.ts'
import type {
  CreateResult,
  ForkResult,
  OpenResult,
  SessionHandle,
  SessionLifecycle,
} from '../src/runtime/session-lifecycle-port.ts'
import type { ClientSessionOwner } from '../src/runtime/session-lifecycle-port.ts'

const fakeDiag: Diag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

/** One binding generation in the fake Client model. */
interface FakeBinding {
  readonly sessionId: string
  readonly session: {
    getSnapshot(): { readonly running: boolean }
    subscribe(fn: () => void): () => void
  }
  setRunning(running: boolean): void
}

function makeBinding(sessionId: string): FakeBinding {
  const listeners = new Set<() => void>()
  let running = false
  return {
    sessionId,
    session: {
      getSnapshot: (): { readonly running: boolean } => ({ running }),
      subscribe: (fn: () => void): (() => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
    setRunning: (next: boolean): void => {
      running = next
      for (const fn of [...listeners]) fn()
    },
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

function harness() {
  const events: string[] = []
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

  const services = createRemoteSessionOwnerServices({
    binding: (id: string) => live.get(id)?.binding,
  })
  let failCompletionIdentity = false
  let failNextSessionId = false
  const countingOwners = {
    owners: {
      ...services.owners,
      fromHandle: (handle: SessionHandle): SessionOwnerRef | undefined => {
        calls.fromHandle += 1
        return services.owners.fromHandle(handle)
      },
      sessionId: (owner: SessionOwnerRef): string => {
        if (failNextSessionId) {
          failNextSessionId = false
          throw new Error('sessionId exploded before the fork commit')
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

  let disposed = false
  const surface: SessionRuntimeSurface = {
    warnRetirement: () => {},
    warnRetirementSkipped: () => {},
    isSurfaceDisposed: (): boolean => disposed,
    beginOpening: (sessionId) => ({ sessionId }),
    clearOpening: () => {},
    settlePendingQueueRecalls: (committed) => { events.push(`recalls:${committed}`) },
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    setCompletionOwner: (identity) => { events.push(`completion:${String(identity)}`) },
    initLiveSession: async (owner) => { events.push(`init:${services.owners.sessionId(owner)}`) },
    refreshLiveCatalog: async (owner) => { events.push(`catalog:${services.owners.sessionId(owner)}`) },
    reportSwitch: (from, to) => { events.push(`switch:${from ?? '(none)'}->${services.owners.sessionId(to)}`) },
    clearUnpinnedDrafts: () => {},
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
    retirement: services.retirement,
    lifecycle,
    lifecycleSignal: controller.signal,
    surface,
    isScopeCurrent: () => true,
    diag: fakeDiag,
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
    failNextCompletionIdentity: (): void => { failCompletionIdentity = true },
    failNextSessionId: (): void => { failNextSessionId = true },
  }
}

test('H1: ordinary switch = retain NEW → commit NEW → release OLD → post-handoff init', async () => {
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

test('H2: a NEW superseded before commit is released; OLD stays current; no init', async () => {
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

test('H3: a same-id reopen is a NEW owner generation; the stale owner never becomes current', async () => {
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

test('H4: rapid A → B(superseded) → C commits only C and releases each reference once', async () => {
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

test('H5: a Remote fork adopts the published child through exactly one open and releases the source once', async () => {
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

test('H6: a fork stale before adoption never opens the child', async () => {
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

test('H7: a fork stale AFTER the adoption open releases the NEW owner exactly once', async () => {
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

test('H8: a failed adoption open never redispatches the fork and keeps the current owner', async () => {  const h = harness()
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

test('H9: a reconnect that preserves the exact binding preserves the owner identity', async () => {
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

test('H10: a full scope retire and re-materialize changes the owner identity', async () => {
  const h = harness()
  const ownerA = h.publishRetained('session-x').owner
  await h.runtime.retireOwnedSession()
  assert.equal(h.countRefs('session-x'), 0, 'the scope is fully retired')
  const ownerB = h.publishRetained('session-x').owner
  assert.notEqual(ownerB, ownerA, 'a re-materialized scope is a NEW owner generation')
})

test('H11: an exit after the fork retain but before commit releases NEW once; OLD retirement is preserved', async () => {
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

test('H12: a fatal after commit never rolls back to OLD; the retirement releases NEW once', async () => {
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
  assert.equal(falseCount, 3,
    'each failure restored the recalls (transitionTo finally + the switch wrapper no-op + the direct transitionTo finally)')
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
