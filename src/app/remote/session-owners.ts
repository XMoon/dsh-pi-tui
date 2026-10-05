/**
 * M3-2 Remote Session owner services: the exact-`SessionBinding` provider of
 * the consumer-owned `SessionOwnerAccess` / `SessionOwnerRetirement` seams.
 *
 * Identity authority (frozen in `docs/concurrency.md`): the exact
 * `SessionReference.binding` OBJECT a retained `ClientSessionOwner` carries is
 * the generation token —
 *
 * ```text
 * same exact binding object          -> same SessionOwnerRef
 * same sessionId + new binding object -> DIFFERENT SessionOwnerRef
 * ```
 *
 * `sessionId`, connection generation ids, `SessionReference.ready` and wrapper
 * identities are NEVER owner identity. The official `retain()` may hand out
 * several independent reference wrappers for one materialized binding, so the
 * registry keeps ONE authoritative wrapper per generation and transfers it
 * explicitly (commit the new authority, then release the replaced TUI
 * reference exactly once).
 *
 * Retirement is Client-local only: the Host stays the execution and durability
 * owner, so `flush`/`preCancel` are deliberate no-ops, `retire` releases the
 * exact Client reference exactly once, and `whenIdleOrAbort` observes the
 * official `SessionSnapshot.running` without ever cancelling the Host session.
 *
 * M3-2 composition note: this provider is not wired into any production
 * bootstrap yet (M3-3B/M3-4 own the Remote runtime selection seam). Tests and
 * the future Remote composition construct it directly.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/session-owners
 */

import { safeErrorMessage } from '../../error-boundary.ts'
import { clientOwnerOf, type ClientSessionOwner, type SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import type {
  SessionOwnerAccess,
  SessionOwnerRetirement,
  SessionRetirementFailure,
  SessionRetirementReport,
} from '../session/owner-access.ts'
import type { SessionOwnerRef } from '../session/subject.ts'

/** The official `SessionFace` running snapshot subset the idle wait observes. */
interface RemoteOwnerRunningFace {
  getSnapshot(): { readonly running: boolean }
  subscribe(fn: () => void): () => void
}

/** Structural official `SessionBinding` observation subset (`session` face). */
export interface RemoteOwnerBindingFace {
  readonly session: RemoteOwnerRunningFace
}

/**
 * Structural official `ISessions.binding(id)` borrow source: the only
 * Remote-domain fact the owner services need. A real `ISessions` satisfies
 * this shape; the borrow never extends a generation's lifetime.
 */
export interface RemoteOwnerBindingSource {
  binding(id: string): RemoteOwnerBindingFace | undefined
}

/** The registry record behind one opaque Remote owner. */
interface RemoteOwnerRecord {
  readonly sessionId: string
  /** The exact binding object this owner's generation was minted from. */
  readonly bindingIdentity: object
  /** The ONE authoritative TUI reference wrapper; detached on retire. */
  currentWrapper: ClientSessionOwner | undefined
}

/** The Remote owner provider pair sharing one registry state. */
export interface RemoteSessionOwnerServices {
  readonly owners: SessionOwnerAccess
  readonly retirement: SessionOwnerRetirement
}

/**
 * Build the Remote Session owner services over one binding borrow source.
 * `owners` and `retirement` share the SAME registry state; constructing two
 * independent mappings would create a second owner truth.
 */
export function createRemoteSessionOwnerServices(source: RemoteOwnerBindingSource): RemoteSessionOwnerServices {
  // Identity is keyed by the exact binding object, never by session id.
  const byBinding = new WeakMap<object, SessionOwnerRef>()
  const byOwner = new WeakMap<SessionOwnerRef, RemoteOwnerRecord>()
  // Wrappers whose TUI reference was already released: a stale handle re-using
  // such a wrapper must not resurrect authoritative ownership.
  const releasedWrappers = new WeakSet<ClientSessionOwner>()
  // Parked retained owners, strongly held per session id until the exit drain.
  const parked = new Map<string, Set<SessionOwnerRef>>()

  const recordOf = (owner: SessionOwnerRef): RemoteOwnerRecord => {
    const record = byOwner.get(owner)
    if (record === undefined) throw new Error('session owner is not registered in the Remote owner registry')
    return record
  }

  const fromHandle = (handle: SessionHandle): SessionOwnerRef | undefined => {
    // A Direct handle and a Remote publication-only fork handle both carry no
    // Client generation owner.
    const wrapper = clientOwnerOf(handle)
    if (wrapper === undefined) return undefined
    const binding = wrapper.bindingIdentity
    const existing = byBinding.get(binding)
    if (existing === undefined) {
      const owner = {} as SessionOwnerRef
      byBinding.set(binding, owner)
      byOwner.set(owner, {
        sessionId: handle.session.id,
        bindingIdentity: binding,
        currentWrapper: wrapper,
      })
      return owner
    }
    // Same exact binding: the SAME owner, with one authoritative wrapper.
    const record = recordOf(existing)
    if (record.currentWrapper === wrapper) return existing
    if (releasedWrappers.has(wrapper)) {
      // A wrapper this registry already released is a dead ownership claim:
      // its TUI reference is gone, so resolving it would publish an owner
      // with no retained Client reference. Refuse the handle outright (fail
      // fast at the caller's owned-generation invariant) — the binding may
      // still be alive through other official references, and a later NEW
      // retain mints a fresh wrapper that maps to the same owner normally.
      return undefined
    }
    const previous = record.currentWrapper
    // Commit the new authority FIRST, then release the replaced TUI reference
    // exactly once: `release()` may synchronously notify listeners, and every
    // application currentness read must already name the new wrapper.
    record.currentWrapper = wrapper
    if (previous !== undefined) {
      releasedWrappers.add(previous)
      previous.release()
    }
    return existing
  }

  const sessionId = (owner: SessionOwnerRef): string => recordOf(owner).sessionId

  const whenIdleOrAbort = (owner: SessionOwnerRef, signal: AbortSignal): Promise<boolean> => {
    const record = recordOf(owner)
    // Borrow the live binding and fence it by exact identity: a replaced or
    // fully retired generation is not observable through the official borrow,
    // and the wait must never observe a NEW same-id generation instead.
    const borrowed = source.binding(record.sessionId)
    if (borrowed === undefined || !Object.is(borrowed, record.bindingIdentity)) {
      // Nothing of this owner's generation is observable client-side anymore;
      // there is no running work this wait could see.
      return Promise.resolve(false)
    }
    const face = borrowed.session
    if (!face.getSnapshot().running) return Promise.resolve(false)
    if (signal.aborted) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      let offAbort: (() => void) | undefined
      const settle = (aborted: boolean): void => {
        if (settled) return
        settled = true
        unsubscribe?.()
        offAbort?.()
        resolve(aborted)
      }
      const onSnapshot = (): void => {
        if (!face.getSnapshot().running) settle(false)
      }
      const onAbort = (): void => { settle(true) }
      // Arm the abort cleanup BEFORE subscribing: `subscribe` may invoke the
      // snapshot callback synchronously, and that settle must be able to
      // remove the abort listener it is already responsible for.
      signal.addEventListener('abort', onAbort, { once: true })
      offAbort = (): void => { signal.removeEventListener('abort', onAbort) }
      unsubscribe = face.subscribe(onSnapshot)
      // A synchronous settle during `subscribe` could not remove the
      // subscription yet (the unsubscribe handle did not exist); remove it
      // now instead of leaking it.
      if (settled) unsubscribe()
      // Lost-wakeup fence: the running → idle transition may have happened
      // before this subscriber registered, so re-check the snapshot after
      // subscribing.
      if (!face.getSnapshot().running) settle(false)
      if (signal.aborted) settle(true)
    })
  }

  const retire = async (
    owner: SessionOwnerRef,
    _mode: 'transition' | 'shutdown',
  ): Promise<SessionRetirementReport> => {
    const record = recordOf(owner)
    const wrapper = record.currentWrapper
    if (wrapper === undefined) return { failures: [], durabilityFailure: undefined }
    // Detach FIRST: `release()` may synchronously retire the binding scope and
    // re-enter listeners; a second retire or a release callback must already
    // see the registry state as released.
    record.currentWrapper = undefined
    releasedWrappers.add(wrapper)
    const failures: SessionRetirementFailure[] = []
    try {
      wrapper.release()
    } catch (error) {
      failures.push({ phase: 'release', error: safeErrorMessage(error) })
    }
    // A Remote reference release is never a durability flush.
    return { failures, durabilityFailure: undefined }
  }

  const park = (owner: SessionOwnerRef): void => {
    const record = byOwner.get(owner)
    // An owner with no retained wrapper (a publication-only fork child) parks
    // nothing: it only lives in the catalog.
    if (record?.currentWrapper === undefined) return
    const set = parked.get(record.sessionId) ?? new Set<SessionOwnerRef>()
    set.add(owner)
    parked.set(record.sessionId, set)
  }

  const retireParked = async (): Promise<SessionRetirementReport> => {
    const owners = [...parked.values()].flatMap(set => [...set])
    parked.clear()
    const failures: SessionRetirementFailure[] = []
    for (const owner of owners) {
      const report = await retire(owner, 'shutdown')
      failures.push(...report.failures)
    }
    return { failures, durabilityFailure: undefined }
  }

  return {
    owners: {
      fromHandle,
      sessionId,
      // rc.2 has no public per-generation completion string, and the sessionId
      // is deliberately NOT one (a same-id rollover must change it). Remote
      // completion presentation (M3-4) routes through SessionSnapshot.running.
      completionIdentity: (): undefined => undefined,
    },
    retirement: {
      whenIdleOrAbort,
      // Host-owned durability: rc.2 has no Client flush verb.
      flush: async (): Promise<void> => {},
      // Synchronous by contract; the real Remote cancel is SessionWriter.cancel.
      preCancel: (): void => {},
      retire,
      park,
      retireParked,
    },
  }
}
