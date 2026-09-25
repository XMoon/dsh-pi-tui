/**
 * The Direct owner retirement (A2 §3.3): the ONE implementation of the
 * Direct-owned session retirement and the exactly-once cancel / abort-aware
 * quiesce machinery behind the transport-neutral `SessionOwnerRetirement` port.
 *
 * The port speaks only opaque `SessionOwnerRef`s; every Direct fact (the Agent,
 * the AgentHandle, the cancel policy, the descendant drain, the durable flush)
 * stays inside this module or is supplied as a boundary dependency. The FULL
 * abort-listener mechanism lives HERE so transport-neutral `app/session` never
 * freezes "client lifecycle abort ⇒ cancel the Host Agent" as a cross-backend
 * semantic.
 * @module @xmoon76/dsh-pi-tui/app/direct/owner-retirement
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Diag } from '../../diag.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import {
  retireDirectOwnedSession,
  type RetirementFailure,
  type RetirementReport,
} from '../../runtime/direct/owned-session-retirement.ts'
import type { SessionOwnerRef } from '../session/subject.ts'
import type { SessionOwnerRetirement, SessionRetirementReport } from '../session/owner-access.ts'
import type { DirectOwnerRegistry } from './owner-registry.ts'

/** The Direct boundary facts the retirement needs. */
export interface DirectOwnerRetirementDeps {
  readonly owners: DirectOwnerRegistry
  readonly diag: Diag
  /** Whether the runner lifecycle was aborted (shutdown-time cancel semantics). */
  isLifecycleAborted(): boolean
  /** Drain one Agent's continuable descendants. */
  drainContinuableDescendants(agent: Agent): Promise<void>
  /** The final durable flush of one session. */
  flushSession(session: unknown): Promise<void>
  /** Park one owner handle for a future reopen (the Direct owner pool). */
  parkHandle(handle: AgentHandle): void
  /** Drain every parked Direct owner (agent + handle) for the exit retirement. */
  takeAllParkedOwners(): Array<{ agent: Agent; handle: AgentHandle }>
}

/**
 * The Direct adapter for the consumer-owned `SessionOwnerRetirement` port. An
 * owner with no Direct attachment (a Remote generation) has nothing to quiesce,
 * flush or dispose, so those calls are no-ops.
 */
export function createDirectOwnerRetirement(deps: DirectOwnerRetirementDeps): SessionOwnerRetirement {
  // Keyed by Agent OBJECT identity, never by session id, so a committed
  // transition's NEW owner is still cancelled. A cancel that throws is
  // deliberately NOT recorded, so a later shutdown-aware path retries it.
  const shutdownCancelledAgents = new WeakSet<Agent>()

  // ONE exactly-once shutdown cancel. Every shutdown-aware cancel funnels here:
  //   - `whenIdleOrAbort`'s lifecycle-abort listener, which fires while
  //     `disposeSurface()` aborts the controller and unblocks a transition
  //     parked in its pre/post-commit quiesce;
  //   - the synchronous exit preparation and the memoized retirement entry;
  //   - the transition / fork retirements that can still commit AFTER the exit
  //     began (via `cancelRetiredOwner` below).
  // `agent.cancel` is idempotent, but a second call must not land after the
  // root teardown unregistered the inbox projection — that ordering is the
  // exact failure this hardening fixes, and it is what makes the cancel phase
  // report `cannot read inbox state: its projection registration is not
  // active`.
  const cancelShutdownAgent = (agent: Agent): void => {
    if (shutdownCancelledAgents.has(agent)) return
    agent.cancel({ kind: 'user' })
    shutdownCancelledAgents.add(agent)
  }

  // The cancel phase of a transition / fork retirement. During shutdown it
  // MUST join the exactly-once set: the owner it retires may already have been
  // shutdown-cancelled, and a late non-cooperative child create can commit
  // after `appExit` started the root teardown. Outside shutdown the ordinary
  // cancel semantics are unchanged — the set is shutdown bookkeeping only.
  const cancelRetiredOwner = (agent: Agent): void => {
    if (deps.isLifecycleAborted()) cancelShutdownAgent(agent)
    else agent.cancel({ kind: 'user' })
  }

  const attachmentOf = (owner: SessionOwnerRef): { agent: Agent; handle: AgentHandle } | undefined =>
    deps.owners.attachmentOf(owner) as { agent: Agent; handle: AgentHandle } | undefined

  const flush = async (owner: SessionOwnerRef): Promise<void> => {
    const record = attachmentOf(owner)
    if (record === undefined) return
    await deps.flushSession(record.agent.session)
  }

  const preCancel = (owner: SessionOwnerRef): void => {
    const record = attachmentOf(owner)
    if (record === undefined) return
    const agent = record.agent
    if (shutdownCancelledAgents.has(agent)) return
    deps.diag.info('retire cancel', { session: agent.session.id })
    try {
      cancelShutdownAgent(agent)
    } catch (error) {
      // Do NOT mark success: the appExit-disposal cancel phase must retry.
      // A failure here must never throw into the exit controller — appExit
      // has to follow regardless.
      deps.diag.error('retire pre-cancel failed', {
        session: agent.session.id,
        error: safeErrorMessage(error),
      })
    }
  }

  const retireParkedOne = async (agent: Agent, handle: AgentHandle): Promise<RetirementReport> =>
    retireDirectOwnedSession({
      // A parked owner is retired ONLY by this path, exactly once: it is never
      // the CURRENT owner, so neither the exit pre-cancel nor the lifecycle-abort
      // listener can have cancelled it. It therefore keeps the plain cancel and
      // is deliberately outside `shutdownCancelledAgents` (see plan §8.7).
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
      drainDescendants: () => deps.drainContinuableDescendants(agent),
      flush: () => deps.flushSession(agent.session),
      disposeOwner: () => handle.dispose(),
    })

  const retireTransition = (agent: Agent, handle: AgentHandle): Promise<RetirementReport> =>
    retireDirectOwnedSession({
      cancel: () => cancelRetiredOwner(agent),
      whenIdle: () => agent.whenIdle(),
      drainDescendants: () => deps.drainContinuableDescendants(agent),
      flush: () => deps.flushSession(agent.session),
      disposeOwner: () => handle.dispose(),
    })

  const retireShutdown = (agent: Agent, handle: AgentHandle): Promise<RetirementReport> => {
    deps.diag.info('retire start', { session: agent.session.id })
    return retireDirectOwnedSession({
      cancel: () => {
        // The exactly-once shutdown cancel already covered THIS exact Agent
        // (the ordinary interactive path, or the lifecycle-abort listener that
        // unblocked a parked quiesce). Re-cancelling is idempotent, but skipping
        // it keeps every shutdown path at exactly one cancel and — more
        // importantly — keeps the second cancel from landing after the root
        // teardown unregistered the inbox projection. A DIFFERENT Agent here
        // means a committed transition replaced the owner, and that one must be
        // cancelled now.
        if (shutdownCancelledAgents.has(agent)) return
        deps.diag.info('retire cancel', { session: agent.session.id })
        cancelShutdownAgent(agent)
      },
      whenIdle: async () => {
        deps.diag.info('retire idle', { session: agent.session.id })
        await agent.whenIdle()
      },
      drainDescendants: () => {
        deps.diag.info('retire descendants', { session: agent.session.id })
        return deps.drainContinuableDescendants(agent)
      },
      flush: () => {
        deps.diag.info('retire flush', { session: agent.session.id })
        return deps.flushSession(agent.session)
      },
      disposeOwner: async () => {
        deps.diag.info('retire dispose', { session: agent.session.id })
        await handle.dispose()
      },
    })
  }

  // Deliberately NOT `async`: the callers already await one frame per
  // retirement, and an extra async layer here shifts the microtask timing the
  // shutdown invariants are locked against.
  const retire = (
    owner: SessionOwnerRef,
    mode: 'transition' | 'shutdown',
  ): Promise<RetirementReport> => {
    const record = attachmentOf(owner)
    if (record === undefined) return Promise.resolve<RetirementReport>({ failures: [], durabilityFailure: undefined })
    return mode === 'shutdown'
      ? retireShutdown(record.agent, record.handle)
      : retireTransition(record.agent, record.handle)
  }

  const retireParked = async (): Promise<RetirementReport> => {
    const failures: RetirementFailure[] = []
    let durabilityFailure: RetirementFailure | undefined
    for (const { agent, handle } of deps.takeAllParkedOwners()) {
      const report = await retireParkedOne(agent, handle)
      // Attribute each parked owner's failures to ITS OWN session: the runner's
      // merged summary must not re-label them as the current session's.
      for (const failure of report.failures) {
        deps.diag.error('retire phase failed', {
          session: agent.session.id,
          phase: failure.phase,
          error: failure.error,
        })
      }
      failures.push(...report.failures)
      durabilityFailure ??= report.durabilityFailure
    }
    return { failures, durabilityFailure }
  }

  const park = (owner: SessionOwnerRef): void => {
    const record = attachmentOf(owner)
    if (record !== undefined) deps.parkHandle(record.handle)
  }

  const whenIdleOrAbort = async (owner: SessionOwnerRef, signal: AbortSignal): Promise<boolean> => {
    const record = attachmentOf(owner)
    // No Direct attachment (a Remote generation): nothing to quiesce.
    if (record === undefined) return false
    const agent = record.agent
    if (signal.aborted) {
      cancelShutdownAgent(agent)
      await agent.whenIdle()
      return true
    }
    let aborted = false
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        aborted = true
        // The lifecycle abort IS a shutdown cancel, so it shares the ONE
        // exactly-once path with the exit preparation / retirement entry:
        // otherwise this cancel and the later cancel phase hit the same
        // Agent twice. The throw is contained INSIDE the listener: an
        // AbortSignal is a Node EventTarget, so a listener exception never
        // surfaces to the `abort()` caller (the `disposeSurface()` try/catch
        // cannot see it) — Node turns it into an uncaughtException instead.
        // Rejecting this promise instead fails the parked transition
        // cleanly, and the memoized retirement retries the cancel later
        // (nothing was recorded, because `cancelShutdownAgent` records only
        // a successful cancel).
        try {
          cancelShutdownAgent(agent)
        } catch (error) {
          // Reject with the RAW value, exactly like the sibling
          // `whenIdle()`-rejection path below: ANY formatting step here
          // (`String(error)`, an unprotected `instanceof`, a `.message` read)
          // can itself throw for a hostile value — a null-prototype object
          // has no coercion — and that throw would escape this EventTarget
          // listener as an uncaughtException, bypassing the containment.
          // Downstream observation goes through the repo's total formatters.
          reject(error)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      agent.whenIdle().then(
        () => { signal.removeEventListener('abort', onAbort); resolve() },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
      )
    })
    return aborted
  }

  return { whenIdleOrAbort, flush, preCancel, retire, park, retireParked }
}
