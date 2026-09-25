/**
 * The BOUND session runtime (A2 plan §1.1 phase 3): the session layer's session
 * orchestration. It currently owns the RETIREMENT COORDINATION (§4.1) and the
 * ORDINARY TRANSITION/switch (§4A); the read facade (§3.4), the fork adoption
 * and the first-session / startup-resume flows join it in the following slices,
 * together with their first consumers.
 *
 * Every backend or Host operation arrives as a consumer-owned port
 * (`SessionOwnerAccess`, `SessionOwnerRetirement`) or a runner-supplied surface
 * hook, so this module never sees an `Agent`, an `AgentHandle` or a Direct
 * module.
 * @module @xmoon76/dsh-pi-tui/app/session/runtime
 */

import type { Diag } from '../../diag.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import {
  runOrdinaryCommit,
} from './commit-order.ts'
import type {
  SessionOwnerAccess,
  SessionOwnerRetirement,
  SessionRetirementReport,
} from './owner-access.ts'
import type { SessionOwnershipCore } from './ownership-core.ts'
import type { SessionOwnerRef } from './subject.ts'
import { runTransitionTo, type TransitionOutcome, type TransitionSteps } from '../../transition.ts'

/** The runner-supplied surface operations the runtime drives. */
export interface SessionRuntimeSurface {
  /** ALL user-facing retirement reporting stays with the runner (it owns the
   *  terminal writer); the runtime calls this ONCE with the MERGED report
   *  (current owner + every parked owner). */
  warnRetirement(report: SessionRetirementReport): void
  /** The coordinator-level warning: the gate/barrier guard skipped a retirement
   *  that would have raced an active transition (no backend phase ran). */
  warnRetirementSkipped(reason: string): void
  /** Whether the surface is already disposed (`cleanedUp`). */
  isSurfaceDisposed(): boolean
  /** The opening-session journal (opaque token; the runner owns the journal). */
  beginOpening(sessionId: string): unknown
  clearOpening(token: unknown): void
  // The commit seams the ordinary transition drives.
  settlePendingQueueRecalls(committed: boolean): void
  settleLocalSubmitAck(reason: string): void
  resetSubmitLatency(): void
  setCompletionOwner(identity: string | undefined): void
  // Post-commit surface work. These receive the opaque owner; the runner
  // resolves its own Direct attachment inside the provider.
  initLiveSession(owner: SessionOwnerRef): Promise<void>
  refreshLiveCatalog(owner: SessionOwnerRef): Promise<void>
  /** Report a committed switch (the runner logs it and adds its own Direct
   *  session detail). */
  reportSwitch(from: string | undefined, to: SessionOwnerRef): void
}

/**
 * The in-flight work the retirement must drain before it retires the owner.
 * TRANSITIONAL (A2-3b-1): the ledgers are still owned by the runner and move
 * into this runtime with the fork / command-settlement flows (3b-3 / 3b-5),
 * at which point this seam disappears.
 */
export interface SessionPendingWork {
  forks(): readonly Promise<unknown>[]
  settlement(): readonly Promise<unknown>[]
  sourceRetirements(): readonly Promise<void>[]
}

export interface SessionRuntimeDeps {
  /** The opaque owner mapping (backend-side). */
  readonly owners: SessionOwnerAccess
  /** The owner retirement port (backend-side implementation). */
  readonly retirement: SessionOwnerRetirement
  /** The runner lifecycle abort signal (the quiesces observe it). */
  readonly lifecycleSignal: AbortSignal
  readonly surface: SessionRuntimeSurface
  readonly pendingWork: SessionPendingWork
  /** Diagnostics; the runtime logs per-owner retirement failures and disposes
   *  the sink at the end of the exit retirement (its last consumer). */
  readonly diag: Diag
}

/** The narrow entries the runner consumes. */
export interface SessionRuntime {
  /** Run one ordinary session transition/switch (plan §4A). */
  transitionTo<T>(steps: TransitionSteps<T>): Promise<TransitionOutcome<T>>
  // retirement coordination (§4.1)
  retireOwnedSession(): Promise<SessionRetirementReport>
  preCancelOwnedSession(): void
}

export function bindSessionRuntime(core: SessionOwnershipCore, deps: SessionRuntimeDeps): SessionRuntime {
  let retirementPromise: Promise<SessionRetirementReport> | undefined

  /**
   * Run one ordinary session transition/switch: quiesce + flush the old owner,
   * run the caller's preflight/create, commit the visible handle through the
   * fixed order (`runOrdinaryCommit`, plan §4A) and retire the old owner. The
   * committed child always stands: a post-commit failure is contained and
   * reported as a failed step. ONE deliberate exception: when the lifecycle
   * aborts during the post-commit child quiesce, the transition returns early —
   * the surface init and the switch report are skipped (the exiting runner's
   * retirement takes over) and the outcome stays successful.
   */
  const transitionTo = async <T>(steps: TransitionSteps<T>): Promise<TransitionOutcome<T>> => {
    core.bumpNavigationEpoch()
    const from = core.currentSessionId()
    const opening = deps.surface.beginOpening(steps.target.id)
    // The OLD owner is captured at ADMISSION: the post-commit retirement must
    // retire exactly the owner this transition replaced.
    const oldOwner = core.owner()
    let transitionCommitted = false
    return runTransitionTo<T>({
      quiesceOld: async () => {
        const owner = core.owner()
        if (owner === undefined) return
        // QUIESCE first: after whenIdle the old owner can no longer produce turn
        // events, so the final flush below is truly final. The wait is
        // abort-aware: an exit during the quiesce cancels the CURRENT owner
        // (which may be a NEW owner committed by an earlier queued transition),
        // so the transition settles instead of hanging past the appExit
        // watchdog.
        await deps.retirement.whenIdleOrAbort(owner, deps.lifecycleSignal)
        // Final flush before the switch. The owner is re-read AFTER the quiesce
        // (the abort path may have swapped it), matching the pre-cutover read.
        const flushOwner = core.owner()
        if (flushOwner === undefined) return
        await deps.retirement.flush(flushOwner)
      },
      commit: (next) => {
        transitionCommitted = true
        // The commit ORDER is fixed by `runOrdinaryCommit`: the generation reset
        // runs BEFORE the new owner is published, so it observes the OLD owner;
        // a disposed surface still publishes the late child for retirement but
        // touches nothing else.
        runOrdinaryCommit({
          isSurfaceDisposed: deps.surface.isSurfaceDisposed,
          settlePendingQueueRecalls: deps.surface.settlePendingQueueRecalls,
          settleLocalSubmitAck: deps.surface.settleLocalSubmitAck,
          resetSubmitLatency: deps.surface.resetSubmitLatency,
          bumpGeneration: core.bumpGeneration,
          publishOwner: (owner) => {
            const nextOwner = deps.owners.fromHandle(owner as SessionHandle)
            if (nextOwner === undefined) throw new Error('ordinary transition published a handle without a Direct owner')
            core.setCurrentOwner(nextOwner, deps.owners.sessionId(nextOwner))
            return deps.owners.completionIdentity(nextOwner)
          },
          setCompletionOwner: deps.surface.setCompletionOwner,
        }, next)
      },
      retireOld: async (next) => {
        const retired: string[] = []
        // Retire the OLD owner through the retirement port (which owns the
        // official close order): the pre-commit quiesce already idled + flushed,
        // so this covers the window where the old owner was re-woken by a
        // Host-side continuation and releases its handle.
        if (oldOwner !== undefined) {
          const report = await deps.retirement.retire(oldOwner, 'transition')
          for (const failure of report.failures) {
            // A failed dispose means the old session may still have writers; the
            // child stays current and the failure is recorded (the DSH
            // SessionWriteLease still guards the session cross-process).
            retired.push(`old ${failure.phase}: ${failure.error}`)
          }
        }
        const nextOwner = deps.owners.fromHandle(next as SessionHandle)
        if (nextOwner === undefined) {
          // Direct invariant: a committed transition child always has an owner.
          retired.push('child whenIdle: committed transition child has no Direct owner')
        } else {
          try {
            // The child quiesce is abort-aware too: an exit during this
            // post-commit phase must cancel the NEW owner instead of hanging past
            // the watchdog. When the lifecycle aborted, the surface is already
            // disposed and the retirement takes over: skip the surface
            // initialization below (it would repaint into the disposed app) and
            // let the committed child stand.
            const aborted = await deps.retirement.whenIdleOrAbort(nextOwner, deps.lifecycleSignal)
            if (aborted) {
              // The lifecycle is exiting: the committed child stands and the
              // retirement takes over. Skip the surface init AND the switch
              // report (the `finally` still clears the opening journal).
              retired.push('child quiesce aborted by lifecycle')
              return
            }
          } catch (error) {
            retired.push(`child whenIdle: ${safeErrorMessage(error)}`)
          }
          try {
            await deps.surface.initLiveSession(nextOwner)
          } catch (error) {
            retired.push(`surface rebuild: ${safeErrorMessage(error)}`)
          }
          // The new owner's catalog refresh is AWAITED before the switch is
          // reported: the old wrappers became revalidating transitions at the
          // target change, and the report must not precede the new catalog (a
          // failed attempt still returns a successful switch — the coordinator
          // warns and the transition commands keep re-validating).
          try {
            await deps.surface.refreshLiveCatalog(nextOwner)
          } catch (error) {
            retired.push(`catalog refresh: ${safeErrorMessage(error)}`)
          }
        }
        deps.surface.clearOpening(opening)
        if (retired.length > 0) {
          deps.diag.error('transition retire failed (child committed)', {
            to: nextOwner === undefined ? undefined : deps.owners.sessionId(nextOwner),
            failures: retired,
          })
        }
        if (nextOwner !== undefined) deps.surface.reportSwitch(from, nextOwner)
      },
      recordFailure: (phase, error) => {
        deps.diag.error(`transition ${phase} failed`, { from, error: safeErrorMessage(error) })
        deps.surface.clearOpening(opening)
      },
    }, steps).finally(() => {
      if (!transitionCommitted) deps.surface.settlePendingQueueRecalls(false)
      deps.surface.clearOpening(opening)
    })
  }

  /**
   * The synchronous shutdown preparation: ask the retirement port to cancel the
   * CURRENT owner's work BEFORE the Host tree is torn down (the port keeps that
   * exactly-once with its lifecycle-abort cancel).
   */
  const preCancelOwnedSession = (): void => {
    const owner = core.owner()
    if (owner !== undefined) deps.retirement.preCancel(owner)
  }

  /**
   * Report the MERGED retirement (the current owner PLUS every parked owner), so
   * a parked owner's failure — a durability failure above all — reaches the user
   * even when the current owner retired cleanly. The per-owner failure
   * diagnostics were already logged by the owner that produced them.
   */
  const reportRetirement = (report: SessionRetirementReport): void => {
    if (report.failures.length > 0) deps.surface.warnRetirement(report)
    deps.diag.info('retire complete', { failures: report.failures.length })
  }

  const retireOwnedSession = (): Promise<SessionRetirementReport> => {
    if (retirementPromise !== undefined) return retirementPromise
    // Every entry (interactive exit, HMR unload, fatal teardown) shares the ONE
    // synchronous pre-cancel before the memoized retirement is created.
    preCancelOwnedSession()
    retirementPromise = (async (): Promise<SessionRetirementReport> => {
      const retire = async (): Promise<SessionRetirementReport> => {
        // Re-read the CURRENT owner INSIDE the gate (plan §4.1): a transition
        // committed while the shutdown waited must be the one retired, never a
        // pre-cancelled capture.
        const owner = core.owner()
        if (owner === undefined) return { failures: [], durabilityFailure: undefined }
        const ownerSessionId = deps.owners.sessionId(owner)
        const report = await deps.retirement.retire(owner, 'shutdown')
        // Attribute each failure to the owner it came from (the parked owners
        // log their own, with their own ids).
        for (const failure of report.failures) {
          deps.diag.error('retire phase failed', {
            session: ownerSessionId,
            phase: failure.phase,
            error: failure.error,
          })
        }
        return report
      }
      try {
        // Serialize against an in-flight session transition: the gate queue is
        // FIFO, so this no-op task waits for a running transition to settle. The
        // barrier freezes TUI writers for the retirement's write boundary.
        let pendingForks = deps.pendingWork.forks()
        while (pendingForks.length > 0) {
          await Promise.allSettled([...pendingForks])
          pendingForks = deps.pendingWork.forks()
        }
        // A `/fork` command's SOURCE Session is retired by ITS OWN command
        // settlement, never by navigation: wait for every in-flight command
        // first (that `command/done` append included), then for every source
        // retirement it queued.
        let settlement = deps.pendingWork.settlement()
        while (settlement.length > 0) {
          await Promise.allSettled([...settlement])
          settlement = deps.pendingWork.settlement()
        }
        let sourceRetirements = deps.pendingWork.sourceRetirements()
        while (sourceRetirements.length > 0) {
          await Promise.allSettled([...sourceRetirements])
          sourceRetirements = deps.pendingWork.sourceRetirements()
        }
        return await core.gate.run(() => core.barrier.runTransition(async () => {
          const current = await retire()
          const parked = await deps.retirement.retireParked()
          const report: SessionRetirementReport = {
            failures: [...current.failures, ...parked.failures],
            durabilityFailure: current.durabilityFailure ?? parked.durabilityFailure,
          }
          reportRetirement(report)
          return report
        }))
      } catch (error) {
        // Defensive: a reentrant gate/barrier means a transition is STILL active
        // — retiring now would race it. SKIP the retirement (the process is
        // exiting; the appExit watchdog bounds it) and report it as a
        // COORDINATOR failure: no backend retirement phase ran, so it must not
        // masquerade as one.
        const reason = safeErrorMessage(error)
        deps.diag.error('retire barrier failed', { error: reason })
        deps.surface.warnRetirementSkipped(reason)
        return { failures: [], durabilityFailure: undefined }
      } finally {
        deps.diag.dispose()
      }
    })()
    return retirementPromise
  }

  return {
    transitionTo,
    retireOwnedSession,
    preCancelOwnedSession,
  }
}
