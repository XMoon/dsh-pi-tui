/**
 * The BOUND session runtime (A2 plan §1.1 phase 3): the session layer's session
 * orchestration. This first slice owns the RETIREMENT COORDINATION; the read
 * facade (§3.4) and the transition / fork / ensure flows join it in the
 * following slices, together with their first consumers.
 *
 * Every backend or Host operation arrives as a consumer-owned port
 * (`SessionOwnerAccess`, `SessionOwnerRetirement`) or a runner-supplied surface
 * hook, so this module never sees an `Agent`, an `AgentHandle` or a Direct
 * module.
 * @module @xmoon76/dsh-pi-tui/app/session/runtime
 */

import type { Diag } from '../../diag.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type {
  SessionOwnerAccess,
  SessionOwnerRetirement,
  SessionRetirementReport,
} from './owner-access.ts'
import type { SessionOwnershipCore } from './ownership-core.ts'

/** The runner-supplied surface operations the runtime drives. */
export interface SessionRuntimeSurface {
  /** ALL user-facing retirement reporting stays with the runner (it owns the
   *  terminal writer); the runtime calls this ONCE with the MERGED report
   *  (current owner + every parked owner). */
  warnRetirement(report: SessionRetirementReport): void
  /** The coordinator-level warning: the gate/barrier guard skipped a retirement
   *  that would have raced an active transition (no backend phase ran). */
  warnRetirementSkipped(reason: string): void
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
  readonly surface: SessionRuntimeSurface
  readonly pendingWork: SessionPendingWork
  /** Diagnostics; the runtime logs per-owner retirement failures and disposes
   *  the sink at the end of the exit retirement (its last consumer). */
  readonly diag: Diag
}

/** The narrow entries the runner consumes. */
export interface SessionRuntime {
  // retirement coordination (§4.1)
  retireOwnedSession(): Promise<SessionRetirementReport>
  preCancelOwnedSession(): void
}

export function bindSessionRuntime(core: SessionOwnershipCore, deps: SessionRuntimeDeps): SessionRuntime {
  let retirementPromise: Promise<SessionRetirementReport> | undefined

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
    retireOwnedSession,
    preCancelOwnedSession,
  }
}
