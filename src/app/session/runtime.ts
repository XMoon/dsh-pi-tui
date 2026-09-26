/**
 * The BOUND session runtime (A2 plan §1.1 phase 3): the session layer's session
 * orchestration. It owns the RETIREMENT COORDINATION (§4.1), the ORDINARY
 * TRANSITION/switch (§4A), the FORK ADOPTION (§4B), the FIRST-SESSION COMMIT
 * (§4C), the STARTUP-RESUME PUBLICATION (§4D) and the COMMAND SETTLEMENT (§3.5).
 * The read authority is the ownership core (`app/session/ownership-core.ts`),
 * which the runner may consult directly.
 *
 * Every backend or Host operation arrives as a consumer-owned port
 * (`SessionOwnerAccess`, `SessionOwnerRetirement`) or a runner-supplied surface
 * hook, so this module never sees an `Agent`, an `AgentHandle` or a Direct
 * module.
 * @module @xmoon76/dsh-pi-tui/app/session/runtime
 */

import type { Diag } from '../../diag.ts'
import { observeSettled, runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import {
  LifecycleError,
  requireCreated,
  requireOpened,
  type SessionHandle,
  type SessionLifecycle,
} from '../../runtime/session-lifecycle-port.ts'
import { isRewindIdentityCurrent, type RewindLiveIdentity } from '../../session-fork.ts'
import { runFirstSessionCommit, runForkCommit, runOrdinaryCommit, runResumeCommit } from './commit-order.ts'
import type {
  SessionOwnerAccess,
  SessionOwnerRetirement,
  SessionRetirementReport,
} from './owner-access.ts'
import type { ForkSourcePin, SessionOwnershipCore } from './ownership-core.ts'
import { SessionScopeSupersededError, type LiveSessionScope, type SessionScope } from './scope.ts'
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
  /** Drop the unpinned per-session drafts after a committed switch/fork. */
  clearUnpinnedDrafts(): void
  /** Report a failed switch (the runner owns the logger + diagnostics). */
  reportSwitchFailure(sessionId: string, message: string): void
  // First-session (deferred creation) runner operations.
  /** Build the launch composition for the first session. */
  launchComposition(): Promise<{ failure?: string; composition: { agentPreset?: string } }>
  /** Record a first-session failure for the next resume notice. */
  setResumeFailure(failure: string): void
  /** Report a failed first-session create (the runner logs + records it). */
  reportFirstSessionCreateFailure(message: string): void
  /** Show (and clear) the pending resume notice. */
  notifyResumeFailure(): void
  /** Quiesce every sessionless `/model` default write before the create. */
  awaitPendingDefaultWrite(signal: AbortSignal): Promise<void>
  /** Generate the first session's id (the runner owns the Host id type). */
  newSessionId(): string
  /** The cwd the first-session create request carries. */
  sessionCreateCwd(): string
  /** The current opening-journal token (opaque to the session layer). */
  currentOpening(): unknown
  /** Reset the whole opening journal (the first-session finally). */
  resetOpening(): void
}

export interface SessionRuntimeDeps {
  /** The opaque owner mapping (backend-side). */
  readonly owners: SessionOwnerAccess
  /** The owner retirement port (backend-side implementation). */
  readonly retirement: SessionOwnerRetirement
  /** The session lifecycle port (open/create/fork). */
  readonly lifecycle: SessionLifecycle
  /** The runner lifecycle abort signal (the quiesces observe it). */
  readonly lifecycleSignal: AbortSignal
  readonly surface: SessionRuntimeSurface
  /** Synchronous scope-currentness read (the runner's scope authority). */
  isScopeCurrent(scope: SessionScope): boolean
  /** Diagnostics; the runtime logs per-owner retirement failures and disposes
   *  the sink at the end of the exit retirement (its last consumer). */
  readonly diag: Diag
}

/**
 * The outcome of one fork navigation. Structurally a `CommandResult` (the
 * command layer renders it), but defined here so `app/session` never imports
 * the Host command package.
 */
export type SessionForkOutcome =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** The narrow entries the runner consumes. */
export interface SessionRuntime {
  /**
   * Run one scope-bound TUI writer. The admission is a NO-YIELD section:
   * `isScopeCurrent(scope)` and the barrier occupancy happen in the SAME
   * synchronous call stack, so a transition started immediately after this
   * returns must wait for the writer. A stale scope is refused with
   * {@link SessionScopeSupersededError} (never the barrier's
   * `TransitionInProgressError`) BEFORE the task runs; a frozen transition
   * keeps the barrier's own refusal (no auto retry).
   */
  withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
  /** Run one ordinary session transition/switch (plan §4A). */
  transitionTo<T>(steps: TransitionSteps<T>): Promise<TransitionOutcome<T>>
  /** Hand the TUI over to another persisted session (never throws). */
  switchSession(sessionId: string): Promise<string | undefined>
  /** Adopt one forked child inside the gate (plan §4B). */
  adoptFork(
    handle: SessionHandle,
    expected: RewindLiveIdentity,
    onAdopted?: () => void,
    pin?: ForkSourcePin,
  ): Promise<boolean>
  /** Fork one source Session (capture → pin → Host fork → supersession fence →
   *  adopt/park). Never throws. */
  forkSession(
    sourceSessionId: string,
    atSeq?: number,
    onAdopted?: () => void,
    pickerIdentity?: RewindLiveIdentity,
  ): Promise<SessionForkOutcome>
  /** Park one refused fork's owner for a later claim. */
  parkForkOwner(handle: SessionHandle | undefined): void
  /** Whether a captured fork/rewind identity still owns the visible surface. */
  isNavigationCurrent(expected: RewindLiveIdentity): boolean
  /** Track one in-flight fork (the exit retirement drains them first). */
  trackFork(promise: Promise<unknown>): void
  hasPendingForks(): boolean
  /** Track one in-flight command settlement / nested submission. */
  trackSettlementWork(promise: Promise<unknown>): void
  // command settlement (§3.5)
  beginCommandSettlement(): void
  abortCommandSettlement(): void
  settleCommandSettlement(): Promise<void>
  /** Run the first-session commit (plan §4C). Returns whether the child
   *  committed (`false` = the lifecycle aborted during its quiesce). */
  commitFirstSession(handle: SessionHandle): Promise<boolean>
  /** Create the first session lazily (deferred session creation). */
  ensureSession(): Promise<void>
  /** Publish the startup-resume owner synchronously (plan §4D: publish →
   *  completion → pre-mount quiesce). Returns the quiesce promise only when the
   *  runner's hook produced one, so a sessionless startup stays synchronous. */
  publishResumedOwner(
    handle: SessionHandle | undefined,
    preMountQuiesce: (owner: SessionOwnerRef) => Promise<unknown> | undefined,
  ): Promise<unknown> | undefined
  // retirement coordination (§4.1)
  retireOwnedSession(): Promise<SessionRetirementReport>
  preCancelOwnedSession(): void
}

export function bindSessionRuntime(core: SessionOwnershipCore, deps: SessionRuntimeDeps): SessionRuntime {
  let retirementPromise: Promise<SessionRetirementReport> | undefined

  /**
   * The scope-bound writer admission (A3 §1.3). The stale check and the
   * barrier occupancy run in the same synchronous stack: there is deliberately
   * NO await between them, so a writer that has already admitted CANNOT be
   * overtaken by a transition that starts right after this returns. A stale
   * scope rejects with its OWN signal before the task body runs.
   */
  const withWriter = <T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T> => {
    if (!deps.isScopeCurrent(scope)) return Promise.reject(new SessionScopeSupersededError())
    return core.barrier.runWriter(scope.sessionId, async () => task())
  }

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
   * Hand the TUI over to another persisted session. Never throws: every failure
   * (unknown session, broken log, preset mount) returns an error string so the
   * caller's `.then(error => ...)` needs no rejection path. The whole switch
   * (open → commit) runs inside the session-transition gate, so it can never
   * interleave with another ordinary transition.
   */
  const switchSession = (sessionId: string): Promise<string | undefined> => {
    core.bumpNavigationEpoch()
    return core.gate.run(() => core.barrier.runTransition(async () => {
      try {
        return await switchSessionLocked(sessionId)
      } finally {
        // Preflight can fail before `transitionTo` is reached; settle any
        // recall that was waiting on this transition in that case.
        deps.surface.settlePendingQueueRecalls(false)
      }
    }))
  }

  const switchSessionLocked = async (sessionId: string): Promise<string | undefined> => {
    // A switch INTO the session we are already on is a no-op.
    if (core.currentSessionId() === sessionId) {
      return 'already on this session'
    }
    // Draft cleanup happens ONLY after the switch committed (the transaction
    // returned ok): a refused/failed switch keeps the CURRENT session and its
    // staged drafts intact — clearing up front would orphan the editor's
    // placeholders on every failed switch.
    try {
      // The unified transaction: the OLD session is flushed FIRST, then the
      // resume publishes the child. A failure anywhere before the create leaves
      // the current session live — there is nothing to re-acquire (the DSH
      // SessionWriteLease is the only writer authority). The recorded preset
      // drives the Direct adapter's internal resume composition; the
      // cross-backend open request carries only the Session identity.
      if (deps.lifecycleSignal.aborted) return undefined
      const result = await transitionTo({
        target: { id: sessionId },
        // A rejected open leaves the target untouched: no pin, no retry — the
        // CURRENT session stays live and the user can retry the switch.
        create: async () => requireOpened(await deps.lifecycle.open({
          sessionId,
          signal: deps.lifecycleSignal,
        })),
      })
      if (!result.ok) {
        if (result.error instanceof LifecycleError) {
          // Preserve the machine-readable cause even on the silent path.
          deps.diag.warn('session switch did not own the surface', {
            settlement: result.error.settlement,
            ownership: result.error.ownership,
            publishedSessionId: result.error.publishedSessionId,
            requestedSessionId: result.error.requestedSessionId,
          })
          // A locally SUPERSEDED open/switch emits no error notice: the surface
          // moved, so the message belongs to a stale operation.
          if (result.error.ownership === 'superseded') return undefined
        }
        // The resume failed: the CURRENT session is still live.
        return result.message
      }
      // The switch COMMITTED: staged drafts are per-session UI state — drop the
      // unpinned ones now (never durable attachments). In-flight submissions
      // keep their pinned drafts so a stale submission can still restore its
      // text with a live backing draft.
      deps.surface.clearUnpinnedDrafts()
      return undefined
    } catch (error) {
      const message = safeErrorMessage(error)
      deps.surface.reportSwitchFailure(sessionId, message)
      // The CURRENT session is still live.
      return `switch failed: ${message}`
    }
  }

  // The fork + source-retirement ledgers (A2-3b-3): they moved out of the
  // runner together with the flows that fill them. The command-settlement
  // window state lives here too, because a committed `/fork` QUEUES its source
  // retirement while an executor is still appending `command/done`.
  const pendingForks = new Set<Promise<unknown>>()
  const pendingSourceRetirements = new Set<Promise<void>>()
  // In-flight command settlements / nested submissions (reachable only from a
  // later callback, so the exit retirement waits for them explicitly).
  const pendingSettlementWork = new Set<Promise<unknown>>()
  let commandExecutionDepth = 0
  const deferredSourceRetirements: Array<{ sessionId: string; retire: () => Promise<void> }> = []

  /** Track one in-flight fork (the exit retirement drains them first). */
  const trackFork = (promise: Promise<unknown>): void => {
    pendingForks.add(promise)
    // `then(onSettled, onSettled)`: tracking must not add an unhandled rejection
    // branch next to the fork's own failure handling.
    observeSettled(promise, () => { pendingForks.delete(promise) })
  }

  const hasPendingForks = (): boolean => pendingForks.size > 0

  /** Track one in-flight command settlement / nested submission. */
  const trackSettlementWork = (promise: Promise<unknown>): void => {
    pendingSettlementWork.add(promise)
    // `then(onSettled, onSettled)`: tracking must not add an unhandled rejection
    // branch next to `runOwned`'s own failure handling.
    observeSettled(promise, () => { pendingSettlementWork.delete(promise) })
  }

  /** Whether a captured fork/rewind identity still owns the visible surface. */
  const isNavigationCurrent = (expected: RewindLiveIdentity): boolean =>
    isRewindIdentityCurrent(core.captureNavigationIdentity(), expected)

  /** Park one refused fork's Direct owner for a later claim. */
  const parkForkOwner = (handle: SessionHandle | undefined): void => {
    const owner = handle === undefined ? undefined : deps.owners.fromHandle(handle)
    if (owner !== undefined) deps.retirement.park(owner)
  }

  /**
   * Start one source retirement through the owned-task model AND register its
   * promise, so teardown can wait for it before the Host teardown. The task
   * promise is returned so a non-command caller can preserve the awaited
   * ordering.
   */
  const startSourceRetirement = (sessionId: string, retire: () => Promise<void>): Promise<void> | undefined => {
    let pending: Promise<void> | undefined
    runOwned('fork source retirement', () => {
      const task = retire()
      pending = task
      return task
    }, { diag: deps.diag, sessionId: () => undefined })
    if (pending !== undefined) {
      const tracked = pending
      pendingSourceRetirements.add(tracked)
      observeSettled(tracked, () => { pendingSourceRetirements.delete(tracked) })
    }
    return pending
  }

  /**
   * Retire the source owner. A DSH command defers it to its own settlement (the
   * executor's `command/done` append must land first) and returns `undefined`;
   * outside a command the retirement promise is returned so the caller keeps the
   * baseline ordering.
   *
   * `finishRelease` settles the fork's admission pin when the retirement has
   * FINISHED — success or a CONTAINED failure: a failed phase is recorded in the
   * retirement report (never a rejection), and holding the pin on a failed
   * dispose would leave `open`/`resume` pending forever.
   */
  const retireSourceOwnerAfterSettlement = (
    sessionId: string,
    retire: () => Promise<void>,
    finishRelease: () => void,
  ): Promise<void> | undefined => {
    const run = async (): Promise<void> => {
      try {
        await retire()
      } finally {
        finishRelease()
      }
    }
    if (commandExecutionDepth === 0) return startSourceRetirement(sessionId, run)
    deferredSourceRetirements.push({ sessionId, retire: run })
    return undefined
  }

  /** Start every retirement queued by the settled command(s) and return the
   *  started promises so the settlement can WAIT for them. */
  const flushSourceRetirementsAfterSettlement = (): Promise<void>[] => {
    const started: Promise<void>[] = []
    while (deferredSourceRetirements.length > 0) {
      const entry = deferredSourceRetirements.shift()
      if (entry === undefined) continue
      const pending = startSourceRetirement(entry.sessionId, entry.retire)
      if (pending !== undefined) started.push(pending)
    }
    return started
  }

  /** Open one command-settlement window: while any is open a committed `/fork`
   *  QUEUES its source retirement instead of detaching the Session whose
   *  executor is still appending `command/done`. */
  const beginCommandSettlement = (): void => { commandExecutionDepth += 1 }
  /** Close a window whose handler never ran: nothing was queued. */
  const abortCommandSettlement = (): void => { commandExecutionDepth -= 1 }
  /** Close one window EXACTLY once and WAIT for the retirements it queued: the
   *  command workflow must not report completion (nor release the submit FIFO)
   *  while the old owner still holds its write lease. */
  const settleCommandSettlement = async (): Promise<void> => {
    commandExecutionDepth -= 1
    if (commandExecutionDepth === 0) await Promise.allSettled(flushSourceRetirementsAfterSettlement())
  }

  /**
   * Adopt one forked child inside the gate: re-check the navigation fence, park
   * a refused child, commit through the fixed §4B order, retire the source owner
   * (deferred to its command settlement when one is open) and rebuild the
   * child's surface. Returns whether the child was adopted.
   */
  const adoptFork = async (
    handle: SessionHandle,
    expected: RewindLiveIdentity,
    onAdopted?: () => void,
    pin?: ForkSourcePin,
  ): Promise<boolean> => {
    let adopted = false
    try {
      await core.gate.run(() => core.barrier.runTransition(async () => {
        if (deps.surface.isSurfaceDisposed() || !isNavigationCurrent(expected)) {
          parkForkOwner(handle)
          return
        }
        const oldOwner = core.owner()
        const nextOwner = deps.owners.fromHandle(handle)
        if (nextOwner === undefined) throw new Error(`forked session "${handle.session.id}" has no Direct owner`)
        const nextSessionId = deps.owners.sessionId(nextOwner)
        // The fork-adoption commit ORDER is fixed by `runForkCommit` (plan §4B):
        // the generation reset runs BEFORE the child is published, exactly like
        // the ordinary transition.
        runForkCommit({
          settlePendingQueueRecalls: deps.surface.settlePendingQueueRecalls,
          settleLocalSubmitAck: deps.surface.settleLocalSubmitAck,
          resetSubmitLatency: deps.surface.resetSubmitLatency,
          bumpGeneration: core.bumpGeneration,
          publishOwner: () => {
            core.setCurrentOwner(nextOwner, nextSessionId)
            return deps.owners.completionIdentity(nextOwner)
          },
          setCompletionOwner: deps.surface.setCompletionOwner,
        }, handle)
        adopted = true
        try {
          onAdopted?.()
        } catch (error) {
          deps.diag.error('fork adoption callback failed after child commit', { error: safeErrorMessage(error), session: nextSessionId })
        }
        if (oldOwner !== undefined) {
          const oldSessionId = deps.owners.sessionId(oldOwner)
          // The retirement now owns the fork's admission pin: it is released
          // only when the source owner has actually been disposed.
          if (pin !== undefined) pin.state.retirementOwnsRelease = true
          const retirement = retireSourceOwnerAfterSettlement(oldSessionId, async () => {
            const report = await deps.retirement.retire(oldOwner, 'transition')
            if (report.failures.length > 0) {
              deps.diag.error('fork old-owner retirement failed (child committed)', { from: oldSessionId, failures: report.failures })
            }
          }, pin?.release ?? ((): void => {}))
          // A DSH command defers (`undefined`): the source owner must stay
          // attached through its own `command/done` append. Every OTHER path
          // (the rewind picker) awaits it here, so the handoff cannot report
          // success until the source is disposed — an immediate open/resume after
          // that success would otherwise race its own retirement.
          if (retirement !== undefined) await retirement
        }
        let aborted = false
        try {
          aborted = await deps.retirement.whenIdleOrAbort(nextOwner, deps.lifecycleSignal)
        } catch (error) {
          deps.diag.error('fork child quiescence failed after commit', { error: safeErrorMessage(error), session: nextSessionId })
        }
        if (!aborted) {
          try {
            await deps.surface.initLiveSession(nextOwner)
          } catch (error) {
            deps.diag.error('fork child initialization failed after commit', { error: safeErrorMessage(error), session: nextSessionId })
          }
        }
        try {
          await deps.surface.refreshLiveCatalog(nextOwner)
        } catch (error) {
          deps.diag.error('fork child catalog refresh failed after commit', { error: safeErrorMessage(error), session: nextSessionId })
        }
      }))
    } catch (error) {
      if (!adopted) throw error
      deps.diag.error('fork post-commit handoff failed', { error: safeErrorMessage(error), session: handle.session.id })
    }
    return adopted
  }

  /**
   * Fork one source Session: capture the navigation identity, claim the
   * operation epoch, pin the source for the whole fork, dispatch the Host fork,
   * apply the supersession fence to every outcome, then adopt or park the child.
   * Never throws.
   */
  const forkSession = async (
    sourceSessionId: string,
    atSeq?: number,
    onAdopted?: () => void,
    pickerIdentity?: RewindLiveIdentity,
  ): Promise<SessionForkOutcome> => {
    // A rewind picker captures identity BEFORE its overlay can yield to a newer
    // navigation. Validate that capture against the live surface before claiming
    // a fresh operation epoch; A → B → A must not revive A's row.
    const before = core.captureNavigationIdentity()
    const pickerCurrent = pickerIdentity === undefined || isRewindIdentityCurrent(before, pickerIdentity)
    const expectedSessionId = pickerIdentity?.sessionId ?? before.sessionId
    // Reject an obsolete picker before consuming an epoch. A stale A picker must
    // not invalidate a newer legitimate A fork that already admitted.
    if (deps.surface.isSurfaceDisposed() || !pickerCurrent || expectedSessionId !== sourceSessionId) {
      return { kind: 'error' as const, text: 'the session changed before fork dispatch' }
    }
    const expected: RewindLiveIdentity = {
      sessionId: expectedSessionId,
      generation: pickerIdentity?.generation ?? before.generation,
      navigationEpoch: core.bumpNavigationEpoch(),
    }
    // Pin the source for the WHOLE fork (from admission, before the child is
    // created): an open/resume of it must wait until the fork settles and, if it
    // committed, until the source owner has been retired.
    const pin = core.beginForkSourcePin(sourceSessionId)
    let settleFork!: () => void
    let forkedHandle: SessionHandle | undefined
    const pending = new Promise<void>(resolve => { settleFork = resolve })
    trackFork(pending)
    try {
      const result = await deps.lifecycle.fork({
        sourceSessionId,
        ...atSeq === undefined ? {} : { atSeq },
      })
      const outcome = result.outcome
      if (outcome.kind === 'unavailable') {
        // Client-local pre-dispatch refusal: nothing reached the Host, so there
        // is no child to park and no Host settlement to report.
        if (result.ownership === 'superseded' || !isNavigationCurrent(expected)) return { kind: 'success' as const }
        return { kind: 'error' as const, text: outcome.message }
      }
      if (outcome.kind === 'rejected' || outcome.kind === 'indeterminate' || outcome.kind === 'published-with-error') {
        if (outcome.kind === 'published-with-error') parkForkOwner(outcome.handle)
        // A Direct failure is still returned as `current` because Direct has no
        // transport generation to supersede it. Navigation owns whether that
        // failure may be shown, so apply the same fence as success.
        if (result.ownership === 'superseded' || !isNavigationCurrent(expected)) {
          return { kind: 'success' as const }
        }
        return { kind: 'error' as const, text: `${outcome.error.message} (${outcome.error.code})` }
      }
      if (result.ownership === 'superseded' || !isNavigationCurrent(expected)) {
        parkForkOwner(outcome.handle)
        return { kind: 'success' as const, text: `forked as ${outcome.handle.session.id}; navigation stayed on the newer session` }
      }
      forkedHandle = outcome.handle
      const adopted = await adoptFork(outcome.handle, expected, onAdopted, pin)
      if (!adopted) return { kind: 'success' as const, text: `forked as ${outcome.handle.session.id}` }
      deps.surface.clearUnpinnedDrafts()
      return { kind: 'success' as const, text: `forked as ${outcome.handle.session.id}` }
    } catch (error) {
      if (forkedHandle !== undefined) parkForkOwner(forkedHandle)
      if (!isNavigationCurrent(expected)) return { kind: 'success' as const }
      return { kind: 'error' as const, text: `fork failed: ${safeErrorMessage(error)}` }
    } finally {
      settleFork()
      // If the fork committed, its source retirement owns the pin (released when
      // that retirement finishes); otherwise the source was never detached and
      // is immediately reopenable.
      if (!pin.state.retirementOwnsRelease) pin.release()
    }
  }

  /**
   * Run the first-session commit (plan §4C: publish → completion → await the
   * child's idle → bump → init). Post-create initialization is best-effort: the
   * child is committed, so a failure is warned (never a fallback), the same
   * retire-warn-only semantics as every other transition.
   */
  const commitFirstSession = async (handle: SessionHandle): Promise<boolean> => {
    const childOwner = deps.owners.fromHandle(handle)
    if (childOwner === undefined) throw new Error('first-session create published a handle without a Direct owner')
    return runFirstSessionCommit({
      publishOwner: () => {
        core.setCurrentOwner(childOwner, deps.owners.sessionId(childOwner))
        return deps.owners.completionIdentity(childOwner)
      },
      setCompletionOwner: deps.surface.setCompletionOwner,
      bumpGeneration: core.bumpGeneration,
      quiesceChild: async () => {
        try {
          return await deps.retirement.whenIdleOrAbort(childOwner, deps.lifecycleSignal)
        } catch (error) {
          deps.diag.warn('first session whenIdle failed', { error: safeErrorMessage(error) })
          return false
        }
      },
      initChild: async () => {
        try {
          await deps.surface.initLiveSession(childOwner)
        } catch (error) {
          deps.diag.warn('first session surface rebuild failed', { error: safeErrorMessage(error) })
        }
      },
    }, handle)
  }

  /**
   * Publish the startup-resume owner (plan §4D). The publication itself is
   * SYNCHRONOUS, and the runner's `preMountQuiesce` hook is consulted only once
   * an owner exists — a sessionless (deferred) startup therefore gains no
   * microtask yield here.
   */
  const publishResumedOwner = (
    handle: SessionHandle | undefined,
    preMountQuiesce: (owner: SessionOwnerRef) => Promise<unknown> | undefined,
  ): Promise<unknown> | undefined =>
    runResumeCommit({
      publishOwner: (owner) => {
        const resumed = owner as SessionHandle | undefined
        const nextOwner = resumed === undefined ? undefined : deps.owners.fromHandle(resumed)
        core.setCurrentOwner(nextOwner, nextOwner === undefined ? undefined : deps.owners.sessionId(nextOwner))
        return nextOwner === undefined ? undefined : deps.owners.completionIdentity(nextOwner)
      },
      setCompletionOwner: deps.surface.setCompletionOwner,
      preMountQuiesce: () => {
        const owner = core.owner()
        return owner === undefined ? undefined : preMountQuiesce(owner)
      },
    }, handle)
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
        // barrier freezes TUI writers for the retirement's write boundary. Each
        // ledger is re-snapshotted until it is empty (a drain can be extended
        // while it runs).
        let forks = [...pendingForks]
        while (forks.length > 0) {
          await Promise.allSettled(forks)
          forks = [...pendingForks]
        }
        // A `/fork` command's SOURCE Session is retired by ITS OWN command
        // settlement, never by navigation: wait for every in-flight command
        // first (that `command/done` append included), then for every source
        // retirement it queued.
        let settlement = [...pendingSettlementWork]
        while (settlement.length > 0) {
          await Promise.allSettled(settlement)
          settlement = [...pendingSettlementWork]
        }
        let sourceRetirements = [...pendingSourceRetirements]
        while (sourceRetirements.length > 0) {
          await Promise.allSettled(sourceRetirements)
          sourceRetirements = [...pendingSourceRetirements]
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

  let creating: Promise<void> | undefined

  /**
   * Create the FIRST session lazily — the first user message triggers it
   * (deferred session creation). Opening the TUI with no `--session` carries zero
   * session side-effects: no agent, no log, no persistence. The creation is a
   * session transition too, so it runs inside the single-writer gate and can
   * never interleave with an ordinary transition already in flight.
   */
  const ensureSession = async (): Promise<void> => {
    if (core.owner() !== undefined) return
    if (creating !== undefined) return creating
    creating = core.gate.run(() => core.barrier.runTransition(async () => {
      const launched = await deps.surface.launchComposition()
      if (launched.failure !== undefined) deps.surface.setResumeFailure(launched.failure)
      // The first-session creation follows the same transaction shape as every
      // other transition: the id is pre-generated and the DSH create publishes
      // the session; a create failure leaves the surface sessionless — the next
      // user input starts a NEW attempt (no pin, no second fresh fallback).
      let created: SessionHandle
      try {
        const sessionId = deps.surface.newSessionId()
        deps.surface.beginOpening(sessionId)
        // Quiesce EVERY sessionless `/model` default write (and its fenced
        // correction) BEFORE the create: the Direct adapter captures the settled
        // persisted Host default for Agent activation. A failed latest intent is
        // NOT seeded — the fresh Session uses the actual Host default, not a
        // fabricated choice.
        await deps.surface.awaitPendingDefaultWrite(deps.lifecycleSignal)
        deps.lifecycleSignal.throwIfAborted()
        created = requireCreated(await deps.lifecycle.create({
          sessionId,
          // The semantic `agentPreset` is the sole preset authority; the Direct
          // adapter writes the actually composed preset into the durable header
          // (never a duplicated meta field).
          cwd: deps.surface.sessionCreateCwd(),
          agentPreset: launched.composition.agentPreset,
          signal: deps.lifecycleSignal,
        }))
      } catch (error) {
        if (error instanceof LifecycleError && error.ownership === 'superseded') {
          // A superseded first-session create is UI-silent — no degradation
          // notice; the surface simply stays sessionless.
          deps.diag.warn('first session creation superseded', {
            settlement: error.settlement,
            publishedSessionId: error.publishedSessionId,
            requestedSessionId: error.requestedSessionId,
          })
          return
        }
        // A failed create leaves the surface sessionless — the next user input
        // starts a NEW attempt (no pin, no second fresh fallback). Preset mount
        // failures are no longer auto-replaced; the resolve-level fallback
        // (requested → default) already happened inside `launchComposition`,
        // BEFORE any DSH call.
        const message = safeErrorMessage(error)
        deps.surface.reportFirstSessionCreateFailure(message)
        throw error
      }
      const opening = deps.surface.currentOpening()
      const committed = await commitFirstSession(created)
      if (!committed) {
        // The lifecycle aborted during the first-session quiesce: the surface is
        // disposed and the retirement takes over — skip the surface
        // initialization below.
        return
      }
      if (opening !== undefined) deps.surface.clearOpening(opening)
      const owner = core.owner()
      if (owner === undefined) throw new Error('first-session commit published no owner')
      // The first real session's catalog comes from the REAL owner: await the
      // coordinator refresh so the first submission rides the live scope (the
      // probe snapshot is never execution authorization). Provider issues degrade
      // fields inside the snapshot; a failed attempt is warned, never fatal.
      try {
        await deps.surface.refreshLiveCatalog(owner)
      } catch (error) {
        deps.diag.warn('first session catalog refresh failed', { error: safeErrorMessage(error) })
      }
      deps.surface.notifyResumeFailure()
    })).finally(() => {
      creating = undefined
      deps.surface.resetOpening()
    })
    return creating
  }
  return {
    withWriter,
    transitionTo,
    switchSession,
    adoptFork,
    forkSession,
    parkForkOwner,
    isNavigationCurrent,
    trackFork,
    hasPendingForks,
    trackSettlementWork,
    beginCommandSettlement,
    abortCommandSettlement,
    settleCommandSettlement,
    commitFirstSession,
    ensureSession,
    publishResumedOwner,
    retireOwnedSession,
    preCancelOwnedSession,
  }
}
