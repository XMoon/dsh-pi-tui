/**
 * Remote Session owner services: the exact-`SessionBinding` provider of
 * the consumer-owned `SessionOwnerAccess` / `SessionOwnerRetirement` seams.
 *
 * Identity authority (see `docs/architecture/host-client.md`): the exact
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
 * The ONE Host mutation here is `cancel`: the explicit user Stop addresses the
 * EXACT captured binding generation through the official `SessionFace.cancel`
 * verb; it never substitutes a same-id replacement and never releases the
 * Client reference. The Connection generation is captured before dispatch and
 * re-checked with the exact binding after the reply, so a superseded reply is
 * `indeterminate`, never the current generation's definite result. The same
 * one-shot verb serves the navigation audience through `cancelForNavigation`,
 * which resolves the dispatch PHASE (a dispatched reply whose classification is
 * a caller/carrier `cancelled` is dispatched-unproven there) without changing
 * the control `cancel` taxonomy; only `committed` lets navigation proceed.
 *
 * Composition note: the Remote application runtime constructs this provider
 * ONCE over the official Client's sessions and Connection generation source.
 * Tests may construct it directly over a fake binding/generation source.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/session-owners
 */

import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { clientOwnerOf, type ClientSessionOwner, type SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import type { WriteOutcome } from '../../runtime/session-writer-port.ts'
import type { RemoteConnectionGenerationSource } from '../../runtime/remote/session-reader-remote.ts'
import { classifyRemoteWriteFailure } from '../../runtime/remote/write-failure.ts'
import type { RemoteResultLike } from '../../runtime/remote/session-writer-remote.ts'
import type {
  NavigationCancelSettlement,
  NavigationStopReceipt,
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

/** The official `SessionFace` cancellation verb addressed by EXACT binding. */
interface RemoteOwnerCancelFace extends RemoteOwnerRunningFace {
  cancel(): Promise<RemoteResultLike<{ readonly accepted: true }>>
}

/** Structural official `SessionBinding` observation subset (`session` face). */
export interface RemoteOwnerBindingFace {
  readonly session: RemoteOwnerCancelFace
}

/**
 * Structural official `ISessions.binding(id)` borrow source: the only
 * Remote-domain fact the owner services need. A real `ISessions` satisfies
 * this shape; the borrow never extends a generation's lifetime.
 */
export interface RemoteOwnerBindingSource {
  binding(id: string): RemoteOwnerBindingFace | undefined
  /** Official `ISessions.retainInfo(id)`: a stable observable of the local
   *  reference counts. A same-id binding replacement necessarily changes those
   *  counts (the new retain and/or the old release), so it is the liveness
   *  event that catches a rollover even when the OLD face emits no snapshot
   *  change. Optional so a narrow test source can omit it; the production
   *  `ISessions` always provides it. */
  retainInfo?(id: string): RemoteRetainInfoSource
}

/** The official local-retain-count observable subset. */
export interface RemoteRetainInfoSource {
  getSnapshot(): { readonly referenceCount: number }
  subscribe(listener: () => void): () => void
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
 * Build the Remote Session owner services over one binding borrow source and
 * the Connection generation source. `owners` and `retirement` share the SAME
 * registry state; constructing two independent mappings would create a second
 * owner truth. The generation source is the SAME official pre-dispatch fence
 * the Remote session writer uses: an owner mutation's reply is only a definite
 * outcome for the generation it was dispatched on.
 */
export function createRemoteSessionOwnerServices(
  source: RemoteOwnerBindingSource,
  generation: RemoteConnectionGenerationSource,
): RemoteSessionOwnerServices {
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

  /**
   * The ONE exact-owner cancel body. `dispatched` records whether the official
   * `SessionFace.cancel()` was actually invoked: a local fence can prove it was
   * not; every reply (including a cancelled/superseded one) is about a call
   * that WAS made. The control audience projects only `outcome` (PR-A's
   * taxonomy is unchanged); the navigation audience resolves the phase.
   */
  const cancelExactOwner = async (owner: SessionOwnerRef): Promise<{
    readonly outcome: WriteOutcome<undefined>
    readonly dispatched: boolean
    readonly receipt?: NavigationStopReceipt
  }> => {
    const notDispatched = (outcome: WriteOutcome<undefined>): { outcome: WriteOutcome<undefined>; dispatched: false } =>
      ({ outcome, dispatched: false })
    const record = recordOf(owner)
    if (record.currentWrapper === undefined) return notDispatched({ kind: 'cancelled' })
    const capturedGeneration = generation.getSnapshot()
    if (capturedGeneration === undefined) return notDispatched({ kind: 'cancelled' })
    const borrowed = source.binding(record.sessionId)
    if (borrowed === undefined || !Object.is(borrowed, record.bindingIdentity)) {
      return notDispatched({ kind: 'cancelled' })
    }
    // The borrow and the generation re-read are synchronous; a replacement
    // observed here proves the official call was never dispatched.
    if (!Object.is(capturedGeneration, generation.getSnapshot())) return notDispatched({ kind: 'cancelled' })
    const result = await borrowed.session.cancel()
    // Post-dispatch identity fence (host-client.md: every Remote async result
    // is generation-bound; a superseded reply is never the current
    // generation's definite outcome). The call happened, so this is
    // indeterminate — not a refusal, not a success, never a replay.
    const currentGeneration = generation.getSnapshot()
    if (currentGeneration === undefined
      || !Object.is(capturedGeneration, currentGeneration)
      || record.currentWrapper === undefined
      || !Object.is(source.binding(record.sessionId), record.bindingIdentity)) {
      return {
        outcome: {
          kind: 'indeterminate',
          error: {
            code: 'session/cancel-superseded',
            message: 'the session owner or connection generation changed while the cancel was in flight',
          },
        },
        dispatched: true,
      }
    }
    if (result.ok) {
      return {
        outcome: { kind: 'committed', value: undefined },
        dispatched: true,
        // Pin the EXACT generation this accepted stop belongs to; the quiesce
        // must validate against this token, never a generation captured later.
        receipt: { token: capturedGeneration },
      }
    }
    return { outcome: classifyRemoteWriteFailure(result.error), dispatched: true }
  }

  /** The control (Busy Esc / Stop) audience: PR-A's shared write taxonomy. */
  const cancel = async (owner: SessionOwnerRef): Promise<WriteOutcome<undefined>> =>
    (await cancelExactOwner(owner)).outcome

  /**
   * The navigation audience. The phase is resolved HERE, without changing
   * `cancel`:
   * - a pre-dispatch local fence is `cancelled` (the request was not addressed;
   *   never permission to switch);
   * - a DISPATCHED reply classified as a caller/carrier cancellation is
   *   `indeterminate` (the Host may have executed it) — the control audience
   *   still sees PR-A's `cancelled`;
   * - a dispatched superseded reply is already `indeterminate`;
   * - a proven business refusal is `rejected`, success `committed`.
   */
  const cancelForNavigation = async (owner: SessionOwnerRef): Promise<NavigationCancelSettlement> => {
    const { outcome, dispatched, receipt } = await cancelExactOwner(owner)
    switch (outcome.kind) {
      case 'committed': return { kind: 'committed', ...receipt === undefined ? {} : { receipt } }
      case 'rejected': return { kind: 'rejected', detail: outcome.error.message }
      case 'unsupported': return { kind: 'rejected', detail: outcome.reason }
      case 'cancelled':
        return dispatched
          ? {
              kind: 'indeterminate',
              detail: 'the Host session cancel was dispatched but its reply was a caller/carrier cancellation',
            }
          : { kind: 'cancelled' }
      case 'indeterminate': return { kind: 'indeterminate', detail: outcome.error.message }
    }
  }

  const whenIdleOrAbort = (
    owner: SessionOwnerRef,
    signal: AbortSignal,
    receipt?: NavigationStopReceipt,
  ): Promise<boolean | 'unobservable'> => {
    const record = recordOf(owner)
    // The accepted navigation stop pins its EXACT Connection generation in the
    // receipt; the quiesce must observe THAT generation, never one captured
    // after a later reconnect. A missing/foreign receipt generation is not a
    // proof either.
    const capturedGeneration = (receipt === undefined ? generation.getSnapshot() : receipt.token) as
      | ReturnType<typeof generation.getSnapshot>
      | undefined
    if (capturedGeneration === undefined) return Promise.resolve('unobservable')
    // If the stop's generation is already no longer the live one, the quiesce
    // cannot prove anything about it.
    if (!Object.is(generation.getSnapshot(), capturedGeneration)) return Promise.resolve('unobservable')
    // Borrow the live binding and fence it by exact identity: a replaced or
    // fully retired generation is not observable through the official borrow,
    // and the wait must never observe a NEW same-id generation instead.
    const borrowed = source.binding(record.sessionId)
    if (borrowed === undefined || !Object.is(borrowed, record.bindingIdentity)) {
      // The exact generation is no longer observable: this is NOT proof that
      // its Host Turn is idle.
      return Promise.resolve('unobservable')
    }
    const exactBindingCurrent = (): boolean =>
      Object.is(source.binding(record.sessionId), record.bindingIdentity)
      && Object.is(generation.getSnapshot(), capturedGeneration)
    const face = borrowed.session
    if (!face.getSnapshot().running) return Promise.resolve(exactBindingCurrent() ? false : 'unobservable')
    if (signal.aborted) return Promise.resolve(true)
    return new Promise<boolean | 'unobservable'>(resolve => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      let offAbort: (() => void) | undefined
      let offGeneration: (() => void) | undefined
      let offRetain: (() => void) | undefined
      const retainInfo = source.retainInfo?.(record.sessionId)
      const settle = (result: boolean | 'unobservable'): void => {
        if (settled) return
        settled = true
        unsubscribe?.()
        offAbort?.()
        offGeneration?.()
        offRetain?.()
        resolve(result)
      }
      // A Connection-generation replacement, or a same-id binding rollover
      // (observed through the local retain-count source), makes the exact
      // generation unobservable IMMEDIATELY — the wait must not depend on the
      // old face's next snapshot notification.
      const onGeneration = (): void => {
        if (!Object.is(generation.getSnapshot(), capturedGeneration)) settle('unobservable')
      }
      const onRetain = (): void => {
        if (!exactBindingCurrent()) settle('unobservable')
      }
      const onSnapshot = (): void => {
        if (!face.getSnapshot().running) settle(exactBindingCurrent() ? false : 'unobservable')
      }
      const onAbort = (): void => { settle(true) }
      // Arm the abort cleanup BEFORE subscribing: `subscribe` may invoke the
      // snapshot callback synchronously, and that settle must be able to
      // remove every listener it is already responsible for.
      signal.addEventListener('abort', onAbort, { once: true })
      offAbort = (): void => { signal.removeEventListener('abort', onAbort) }
      offGeneration = generation.subscribe(onGeneration)
      if (settled) offGeneration()
      offRetain = retainInfo?.subscribe(onRetain)
      if (settled) offRetain?.()
      unsubscribe = face.subscribe(onSnapshot)
      // A synchronous settle during `subscribe` could not remove the
      // subscription yet (the unsubscribe handle did not exist); remove it
      // now instead of leaking it.
      if (settled) unsubscribe()
      // Lost-wakeup fence: the running → idle transition may have happened
      // before this subscriber registered, so re-check the snapshot after
      // subscribing — with the same exact-binding/generation fence.
      if (!face.getSnapshot().running) settle(exactBindingCurrent() ? false : 'unobservable')
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
      cancel,
      cancelForNavigation,
      // Host-owned durability: rc.2 has no Client flush verb.
      flush: async (): Promise<void> => {},
      // Synchronous by contract; the real Remote cancel is this adapter's
      // `cancel` (the official SessionFace.cancel on the exact binding).
      preCancel: (): void => {},
      retire,
      park,
      retireParked,
    },
  }
}
