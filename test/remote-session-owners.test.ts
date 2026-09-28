/**
 * M3-2 L6: the Remote Session owner services — exact `SessionBinding` identity
 * mapping, wrapper transfer, exactly-once release, snapshot-observed idle wait
 * and the parked-owner drain. The harness models the official Client reference
 * lifetime: a binding generation exists only while at least one reference is
 * retained, and a same-id re-retain after full release yields a NEW binding
 * object.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientSessionOwner, SessionHandle } from '../src/runtime/session-lifecycle-port.ts'
import {
  createRemoteSessionOwnerServices,
  type RemoteOwnerBindingFace,
} from '../src/app/remote/session-owners.ts'
import type { SessionOwnerRef } from '../src/app/session/subject.ts'

/** A counting AbortSignal stand-in: proves listener removal precisely. */
function fakeSignal(): AbortSignal & { listenerCount(): number; abortNow(): void } {
  const listeners = new Set<() => void>()
  let aborted = false
  const signal = {
    get aborted(): boolean { return aborted },
    addEventListener(_type: 'abort', cb: () => void): void { listeners.add(cb) },
    removeEventListener(_type: 'abort', cb: () => void): void { listeners.delete(cb) },
  } as AbortSignal
  return Object.assign(signal, {
    listenerCount: (): number => listeners.size,
    abortNow: (): void => {
      aborted = true
      for (const cb of [...listeners]) cb()
    },
  })
}

/** One observable binding generation in the harness model. */
interface HarnessBinding extends RemoteOwnerBindingFace {
  readonly sessionId: string
  /** Test-side state control. */
  setRunning(running: boolean): void
  /** Snapshot invalidation (the official subscribe contract). */
  notify(): void
  subscribeCalls(): number
  unsubscribeCalls(): number
}

function harness() {
  const calls = {
    releases: [] as string[],
    retainedIds: [] as string[],
  }
  const live = new Map<string, { binding: HarnessBinding; refs: number }>()

  const makeBinding = (sessionId: string): HarnessBinding => {
    const listeners = new Set<() => void>()
    let running = false
    let subscribes = 0
    let unsubscribes = 0
    const binding: HarnessBinding = {
      sessionId,
      session: {
        getSnapshot: (): { readonly running: boolean } => ({ running }),
        subscribe: (fn: () => void): (() => void) => {
          subscribes += 1
          listeners.add(fn)
          return () => {
            unsubscribes += 1
            listeners.delete(fn)
          }
        },
      },
      setRunning: (next: boolean): void => {
        running = next
        for (const fn of [...listeners]) fn()
      },
      notify: (): void => {
        for (const fn of [...listeners]) fn()
      },
      subscribeCalls: (): number => subscribes,
      unsubscribeCalls: (): number => unsubscribes,
    }
    return binding
  }

  /** Model `sessions.retain`: a first reference materializes the generation. */
  const retain = (sessionId: string): ClientSessionOwner => {
    calls.retainedIds.push(sessionId)
    const existing = live.get(sessionId)
    if (existing === undefined) {
      const binding = makeBinding(sessionId)
      live.set(sessionId, { binding, refs: 1 })
      return wrap(sessionId, binding)
    }
    existing.refs += 1
    return wrap(sessionId, existing.binding)
  }

  const wrap = (sessionId: string, binding: HarnessBinding): ClientSessionOwner => {
    let released = false
    return {
      bindingIdentity: binding,
      release: (): void => {
        if (released) return
        released = true
        calls.releases.push(sessionId)
        const entry = live.get(sessionId)
        if (entry === undefined) return
        entry.refs -= 1
        if (entry.refs <= 0) live.delete(sessionId)
      },
    }
  }

  /** Model `ISessions.binding(id)`: the official borrow of a retained generation. */
  const bindingSource = {
    binding: (id: string): RemoteOwnerBindingFace | undefined => live.get(id)?.binding,
  }

  const services = createRemoteSessionOwnerServices(bindingSource)
  /** `fromHandle` with the retained-handle owner contract asserted. */
  const ownerOf = (handle: SessionHandle): SessionOwnerRef => {
    const owner = services.owners.fromHandle(handle)
    assert.ok(owner !== undefined, 'a retained handle must map to an owner')
    return owner
  }
  return {
    calls,
    services,
    ownerOf,
    retain,
    bindingOf: (id: string): HarnessBinding | undefined => live.get(id)?.binding,
    isLive: (id: string): boolean => live.has(id),
    handleOf: (sessionId: string, client?: ClientSessionOwner): SessionHandle => ({
      session: { id: sessionId },
      ...client === undefined ? {} : { client },
    }),
  }
}

/** Mint an owned handle for one retained generation. */
function retainedHandle(h: ReturnType<typeof harness>, sessionId: string): {
  handle: SessionHandle
  wrapper: ClientSessionOwner
} {
  const wrapper = h.retain(sessionId)
  return { handle: h.handleOf(sessionId, wrapper), wrapper }
}

test('R1: a Remote handle maps to an owner named by its exact binding', () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-x')
  const owner = h.ownerOf(handle)
  assert.ok(owner !== undefined, 'a retained Remote handle must map to an owner')
  assert.equal(h.services.owners.sessionId(owner), 'session-x')
  assert.equal(h.services.owners.completionIdentity(owner), undefined,
    'Remote completionIdentity is deliberately undefined (never the sessionId)')
})

test('a Direct handle and a publication-only fork handle map to no Remote owner', () => {
  const h = harness()
  assert.equal(h.services.owners.fromHandle({ session: { id: 'session-direct' } }), undefined,
    'a Direct handle carries no Client owner')
  assert.equal(h.services.owners.fromHandle({ session: { id: 'session-child' } }), undefined,
    'a publication-only Remote fork handle carries no Client owner')
})

test('R2: the same exact binding and wrapper resolve to the SAME owner with no release', () => {
  const h = harness()
  const { handle, wrapper } = retainedHandle(h, 'session-a')
  const first = h.services.owners.fromHandle(handle)
  const second = h.services.owners.fromHandle(h.handleOf('session-a', wrapper))
  assert.equal(second, first, 'the same binding must keep the same SessionOwnerRef')
  assert.deepEqual(h.calls.releases, [], 're-wrapping the same wrapper must not release anything')
})

test('R3: a new wrapper on the same binding transfers authority and releases the old reference once', () => {
  const h = harness()
  const { wrapper: first } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(h.handleOf('session-a', first))
  const second = h.retain('session-a')
  const again = h.services.owners.fromHandle(h.handleOf('session-a', second))
  assert.equal(again, owner, 'the same binding keeps the same owner through a wrapper transfer')
  assert.deepEqual(h.calls.releases, ['session-a'], 'the replaced wrapper is released exactly once')
  assert.ok(h.isLive('session-a'), 'the new wrapper keeps the generation alive')
  // The authoritative wrapper is now the second one: retiring releases it.
  void h.services.retirement.retire(owner, 'transition')
  assert.deepEqual(h.calls.releases, ['session-a', 'session-a'], 'retire releases only the authoritative wrapper')
  assert.ok(!h.isLive('session-a'), 'both TUI references are gone')
})

test('R4: a released wrapper cannot resurrect ownership', async () => {
  const h = harness()
  const { wrapper: first } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(h.handleOf('session-a', first))
  const second = h.retain('session-a')
  void h.services.owners.fromHandle(h.handleOf('session-a', second))
  await h.services.retirement.retire(owner, 'transition')
  assert.equal(h.calls.releases.length, 2)
  // The stale authoritative wrapper is passed again after its release: the
  // dead ownership claim must be refused outright so it can never publish an
  // owner with no retained Client reference.
  assert.equal(h.services.owners.fromHandle(h.handleOf('session-a', second)), undefined,
    'a stale released wrapper must not resolve to an owner')
  // The wrapper replaced by the transfer is equally dead.
  assert.equal(h.services.owners.fromHandle(h.handleOf('session-a', first)), undefined,
    'a wrapper released by transfer must not resolve to an owner')
  await h.services.retirement.retire(owner, 'shutdown')
  assert.equal(h.calls.releases.length, 2, 'a stale released wrapper must never release twice')
  // A FRESH retain of the same catalogued id re-activates ownership only
  // through a new binding generation (a new object, a new owner).
  const third = retainedHandle(h, 'session-a')
  const reactivated = h.services.owners.fromHandle(third.handle)
  assert.ok(reactivated !== undefined && reactivated !== owner,
    'a fresh retain after full release is a NEW owner generation (new binding object)')
})

test('a new TUI retain of a still-live binding re-activates the SAME owner', () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  // Another official reference keeps the exact binding generation alive.
  const external = h.retain('session-a')
  void h.services.retirement.retire(owner, 'transition')
  assert.ok(h.isLive('session-a'), 'the external reference keeps the generation alive')
  // The TUI re-enters the SAME binding through a fresh retain: the owner
  // identity follows the binding, not the TUI's own release history.
  const fresh = retainedHandle(h, 'session-a')
  assert.equal(h.services.owners.fromHandle(fresh.handle), owner,
    'a fresh retain of the SAME live binding re-activates the SAME owner')
  void external
})

test('R5: the same session id with a new binding is a different owner generation', () => {  const h = harness()
  const first = retainedHandle(h, 'session-x')
  const ownerA = h.ownerOf(first.handle)
  void h.services.retirement.retire(ownerA, 'transition')
  assert.ok(!h.isLive('session-x'))
  const second = retainedHandle(h, 'session-x')
  const ownerB = h.ownerOf(second.handle)
  assert.notEqual(ownerB, ownerA, 'a new binding object must mint a NEW SessionOwnerRef')
  assert.equal(h.services.owners.sessionId(ownerB), 'session-x')
})

test('R6: an unknown owner fails fast in sessionId', () => {
  const h = harness()
  assert.throws(() => h.services.owners.sessionId({} as SessionOwnerRef), /not registered/)
})

test('R7: an idle generation resolves immediately with no listener', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  const signal = fakeSignal()
  assert.equal(await h.services.retirement.whenIdleOrAbort(owner, signal), false)
  assert.equal(h.bindingOf('session-a')?.subscribeCalls(), 0, 'the idle fast path must not subscribe')
  assert.equal(signal.listenerCount(), 0, 'no abort listener may remain')
})

test('R8: a running generation settles when running flips to false, unsubscribing once', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  h.bindingOf('session-a')!.setRunning(true)
  const signal = fakeSignal()
  let settled: boolean | undefined
  const pending = h.services.retirement.whenIdleOrAbort(owner, signal).then(result => { settled = result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, undefined, 'a running generation must not settle early')
  h.bindingOf('session-a')!.setRunning(false)
  await pending
  assert.equal(settled, false)
  const binding = h.bindingOf('session-a')!
  assert.ok(binding.subscribeCalls() >= 1)
  assert.equal(binding.unsubscribeCalls(), binding.subscribeCalls(), 'the snapshot subscription is removed on settle')
  assert.equal(signal.listenerCount(), 0, 'the abort listener is removed on settle')
})

test('a synchronous snapshot notification during subscribe leaves no listener behind', async () => {
  // The official `subscribe` may invoke the callback synchronously before its
  // unsubscribe handle exists. That settle must still remove BOTH the
  // subscription (once the handle arrives) and the abort listener.
  let running = true
  let unsubscribed = 0
  const listeners = new Set<() => void>()
  const binding: RemoteOwnerBindingFace = {
    session: {
      getSnapshot: (): { readonly running: boolean } => ({ running }),
      subscribe: (fn: () => void): (() => void) => {
        running = false
        fn()
        listeners.add(fn)
        return () => {
          unsubscribed += 1
          listeners.delete(fn)
        }
      },
    },
  }
  const services = createRemoteSessionOwnerServices({ binding: () => binding })
  const owner = services.owners.fromHandle({
    session: { id: 'session-a' },
    client: { bindingIdentity: binding, release: () => {} },
  })
  assert.ok(owner !== undefined)
  const signal = fakeSignal()
  assert.equal(await services.retirement.whenIdleOrAbort(owner, signal), false)
  assert.equal(unsubscribed, 1, 'the synchronously-settled subscription is removed once its handle exists')
  assert.equal(signal.listenerCount(), 0, 'the abort listener is removed')
})

test('a running→false flip before the subscription registers cannot be lost', async () => {  // The official snapshot contract notifies on invalidation; a flip that
  // happens BEFORE the subscriber registers fires that notification with no
  // listeners. A read-then-subscribe implementation would hang forever, so the
  // wait must re-check the snapshot after subscribing.
  let running = true
  const listeners = new Set<() => void>()
  const binding: RemoteOwnerBindingFace = {
    session: {
      getSnapshot: (): { readonly running: boolean } => ({ running }),
      subscribe: (fn: () => void): (() => void) => {
        running = false
        for (const cb of [...listeners]) cb()
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
  }
  const services = createRemoteSessionOwnerServices({ binding: () => binding })
  const owner = services.owners.fromHandle({
    session: { id: 'session-a' },
    client: { bindingIdentity: binding, release: () => {} },
  })
  assert.ok(owner !== undefined)
  assert.equal(await services.retirement.whenIdleOrAbort(owner, fakeSignal()), false,
    'the post-subscribe snapshot re-check must observe the already-idle state')
})

test('R9: abort stops the LOCAL wait only — no cancel, no release, listeners removed', async () => {
  const h = harness()
  const { handle, wrapper } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  h.bindingOf('session-a')!.setRunning(true)
  const signal = fakeSignal()
  let settled: boolean | undefined
  const pending = h.services.retirement.whenIdleOrAbort(owner, signal).then(result => { settled = result })
  await new Promise(resolve => setImmediate(resolve))
  signal.abortNow()
  await pending
  assert.equal(settled, true, 'the abort resolves the wait as aborted')
  const binding = h.bindingOf('session-a')!
  assert.equal(binding.unsubscribeCalls(), binding.subscribeCalls(), 'the snapshot subscription is removed')
  assert.equal(signal.listenerCount(), 0, 'the abort listener is removed')
  assert.ok(binding.session.getSnapshot().running, 'the Host session keeps running (no cancel)')
  assert.deepEqual(h.calls.releases, [], 'aborting the wait must not release the reference')
  void wrapper
})

test('an already-aborted signal never leaves a subscription behind', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  h.bindingOf('session-a')!.setRunning(true)
  const signal = fakeSignal()
  signal.abortNow()
  assert.equal(await h.services.retirement.whenIdleOrAbort(owner, signal), true)
  const binding = h.bindingOf('session-a')!
  assert.equal(binding.unsubscribeCalls(), binding.subscribeCalls(), 'no subscription may outlive the call')
  assert.equal(signal.listenerCount(), 0)
})

test('R10: retire releases the active Client reference exactly once across modes', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  await h.services.retirement.retire(owner, 'transition')
  await h.services.retirement.retire(owner, 'shutdown')
  assert.deepEqual(h.calls.releases, ['session-a'], 'the wrapper is released exactly once in total')
  assert.ok(!h.isLive('session-a'), 'the generation is fully retired')
})

test('R11: flush and preCancel invent no Host action', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  h.bindingOf('session-a')!.setRunning(true)
  await h.services.retirement.flush(owner)
  h.services.retirement.preCancel(owner)
  assert.ok(h.bindingOf('session-a')!.session.getSnapshot().running, 'preCancel must not cancel the Host session')
  assert.deepEqual(h.calls.releases, [], 'neither call releases the reference')
  assert.equal(h.bindingOf('session-a')!.subscribeCalls(), 0, 'neither call subscribes')
})

test('R12: a parked retained owner is drained exactly once', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  h.services.retirement.park(owner)
  assert.ok(h.isLive('session-a'), 'a parked owner is strongly held')
  const report = await h.services.retirement.retireParked()
  assert.deepEqual(report.failures, [])
  assert.deepEqual(h.calls.releases, ['session-a'], 'the parked owner is released once')
  const second = await h.services.retirement.retireParked()
  assert.deepEqual(second.failures, [])
  assert.deepEqual(h.calls.releases, ['session-a'], 'a drained park never releases twice')
})

test('parking an ownerless generation (a publication-only child) parks nothing', async () => {
  const h = harness()
  h.services.retirement.park({} as SessionOwnerRef)
  // An unknown owner has no retained wrapper; the park must not throw and the
  // drain stays empty. (A real publication-only child never reaches park with
  // an owner; this locks the no-wrapper behavior.)
  const report = await h.services.retirement.retireParked()
  assert.deepEqual(report.failures, [])
  assert.deepEqual(h.calls.releases, [])
})

test('a release failure is contained as a phase failure and never re-released', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  // Make the authoritative wrapper's release throw.
  const original = h.calls.releases
  original.push = (() => { throw new Error('release exploded') }) as typeof original.push
  const report = await h.services.retirement.retire(owner, 'shutdown')
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].phase, 'release')
  assert.equal(report.durabilityFailure, undefined, 'a Remote release is not a durability flush')
  // A second retire must not attempt a second release of the detached wrapper.
  const second = await h.services.retirement.retire(owner, 'shutdown')
  assert.deepEqual(second.failures, [])
})

test('whenIdleOrAbort on a fully retired generation has nothing to wait for', async () => {
  const h = harness()
  const { handle } = retainedHandle(h, 'session-a')
  const owner = h.ownerOf(handle)
  await h.services.retirement.retire(owner, 'transition')
  // The generation is no longer observable through the official borrow.
  assert.equal(await h.services.retirement.whenIdleOrAbort(owner, fakeSignal()), false)
})

test('whenIdleOrAbort refuses to observe a replaced same-id generation', async () => {
  const h = harness()
  const first = retainedHandle(h, 'session-a')
  const ownerA = h.ownerOf(first.handle)
  assert.ok(ownerA !== undefined)
  // Model a full release + re-retain: the same id now names a NEW generation.
  void h.services.retirement.retire(ownerA, 'transition')
  const second = retainedHandle(h, 'session-a')
  h.bindingOf('session-a')!.setRunning(true)
  // The old owner's binding identity is no longer the live generation: the
  // wait must not observe the NEW generation's running state.
  assert.equal(await h.services.retirement.whenIdleOrAbort(ownerA, fakeSignal()), false)
  void second
})
