/**
 * The ONE Client-owned exit-intent coordinator (M6 UX PR1).
 *
 * Every exit entry — `/exit`, `/quit`, a plain `exit`, an effective exit key,
 * the TSP exit gesture — funnels through {@link ExitIntentCoordinator.request}.
 * The coordinator reads the LIVE authority facts, classifies the intent with
 * the pure domain classifier, and either commits the existing exit controller
 * immediately or presents the ONE Client-local Exit Choice and executes the
 * user's selection.
 *
 * What this module owns:
 * - the transient state of the ONE open choice (asking / stopping /
 *   unconfirmed) and its currentness fence;
 * - the decision to keep working (no Host write), to stop exactly one captured
 *   Session (delegated to the injected exact-owner operation), or to detach;
 * - the single call into the existing exit controller at final commit.
 *
 * What it deliberately does NOT own: Host running truth (read fresh on every
 * request and confirmation), the cancel/idle-proof mechanics (the injected
 * `stopCurrentWork`), the final TTY/disposal orchestration (`createExitController`)
 * and any renderer state. It keeps no cached Host-running fact and never turns
 * an unknown state into idle.
 *
 * Identity rules:
 * - the choice captures a FULL `SessionScope`, so a sessionless choice is
 *   invalidated by the first Session publication exactly like a switched live
 *   owner;
 * - every confirmation re-checks the backend, the scope and the Remote
 *   transport token BEFORE any action;
 * - a close can synchronously restore another owner's focus and run plugin
 *   callbacks that open a NEWER intent or publish a NEWER owner: the final
 *   commit therefore re-proves that the old intent still owns the decision
 *   after the close, and the newer operation always wins.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/exit-intent
 */

import type { LiveSessionScope, SessionScope } from '../session/scope.ts'
import {
  classifyExitIntent,
  type ExitBackendKind,
  type ExitIntentEntry,
  type ExitSessionActivity,
} from '../../domain/command/policy.ts'
import {
  exitChoiceAsking,
  exitChoiceHostStop,
  exitChoiceStopping,
  exitChoiceUnconfirmed,
  exitChoiceVerifying,
  type ExitChoiceKind,
  type ExitChoiceModel,
  type ExitChoiceOption,
  type SurfaceExitChoiceSeam,
} from '../surface/exit-choice.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'

/**
 * The exact owner-cancel + idle-proof result of one daemon Stop. Only `stopped`
 * means the captured Session's work is proven finished; every other outcome is
 * explicitly unconfirmed (never a silent "probably stopped").
 */
export type StopCurrentWorkOutcome =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unconfirmed'; readonly detail: string }

/** The live facts the coordinator reads (never cached). */
export interface ExitIntentFacts {
  /** The backend selected for THIS process (never a cold-launch preference). */
  currentBackend(): ExitBackendKind
  /**
   * ONE synchronous capture of the exact scope, its live projection and the
   * authoritative activity. `live` is undefined for a sessionless surface,
   * while `scope` is ALWAYS a real identity (the sessionless generation
   * included); a pending submission admission without a Session reports
   * `activity: 'working'` and a pending navigation reports `'unknown'`.
   */
  capture(): {
    readonly scope: SessionScope
    readonly live: LiveSessionScope | undefined
    readonly activity: ExitSessionActivity
    /** A Client-owned `!`/`!!` Host user shell is in flight. */
    readonly shellRunning: boolean
    /** The Remote transport identity captured beside the scope (undefined on Direct). */
    readonly transportToken?: unknown
  }
  /** Whether a captured scope still pins the live owner AND its transport. */
  isScopeCurrent(scope: SessionScope, transportToken: unknown): boolean
  /**
   * M6 UX PR2: the SYNC local part of the whole-Host-stop eligibility — the
   * process-lifetime transient daemon→direct intent, the daemon backend and
   * the admin capability. It decides whether to intercept at all; the FRESH
   * authoritative read runs in {@link hostStopEligible}.
   */
  hostStopIntentCurrent(): boolean
  /**
   * M6 UX PR2: whether THIS Client may ask, at exit, about stopping the old
   * Profile Host. It re-reads the LIVE facts on every check: the process must
   * still run the daemon backend, the process-lifetime transient
   * daemon→direct conversion intent must still hold, and a FRESH authoritative
   * Profile preference read (never a stale mirror snapshot) must still read
   * `direct` with a ready configuration. It is a permission to ASK — never a
   * command to stop. Async because the fresh read is a Host round-trip.
   */
  hostStopEligible(): Promise<boolean>
}

/** The narrow dependencies of the coordinator. */
export interface ExitIntentCoordinatorDeps {
  readonly diag: Diag
  readonly facts: ExitIntentFacts
  /**
   * The ONE final exit commit — the existing `createExitController.requestExit`.
   * `workStopped` is true ONLY after the captured owner's authoritative idle
   * proof, and only that commit may print the stopped line. `hostStopRequested`
   * is the ONE explicit whole-Host stop authorization (M6 UX PR2): the final
   * exit root runs the admin stop after the terminal is restored; it is never
   * set by an ordinary detach.
   */
  readonly commit: (options: { readonly workStopped: boolean; readonly hostStopRequested?: boolean }) => void
  /** The mounted renderer's choice seam, or undefined before a mount. */
  readonly presenter: () => SurfaceExitChoiceSeam | undefined
  /**
   * Daemon only: send ONE official cancel to the captured owner's exact
   * generation under the control admission, then — outside that admission —
   * wait for the SAME owner's authorized idle proof. Never resolves to
   * `stopped` on an ACK alone.
   */
  readonly stopCurrentWork: (scope: LiveSessionScope, signal: AbortSignal) => Promise<StopCurrentWorkOutcome>
}

/** The coordinator surface consumed by the composition root and the input layers. */
export interface ExitIntentCoordinator {
  /** One exit intent. Repeated requests while a choice is open are no-ops. */
  request(entry: ExitIntentEntry): void
  /** The LIVE activity fact for the keyboard Ctrl+C/Ctrl+D ladder (never cached). */
  activity(): ExitSessionActivity
  /**
   * Retire the OPEN choice when the captured identity is no longer current
   * (a committed Session switch, a Connection/binding rollover, a backend
   * flip). Zero business action; the user re-triggers a fresh Exit Intent.
   */
  retireIfStale(): void
  /** Retire the open choice and abort any Stop wait (surface teardown). */
  dispose(): void
}

/** The frozen identity one open choice addresses. */
interface CapturedChoice {
  readonly kind: ExitChoiceKind
  readonly backend: ExitBackendKind
  readonly scope: SessionScope
  readonly live: LiveSessionScope | undefined
  readonly transportToken: unknown
}

/**
 * Build the ONE exit-intent coordinator.
 * @param deps - the narrow integrated surface.
 * @returns the request/activity/dispose surface.
 */
export function createExitIntentCoordinator(deps: ExitIntentCoordinatorDeps): ExitIntentCoordinator {
  /** The currently presented model, or undefined when no choice is open. */
  let open: ExitChoiceModel | undefined
  /** The exact identity the open choice captured (frozen at open). */
  let captured: CapturedChoice | undefined
  /** The in-flight daemon Stop wait, if any (owned by the open choice). */
  let stopWait: AbortController | undefined
  /**
   * M6 UX PR2: the workStopped fact of the PR1 decision that led into the
   * whole-Host stop confirm. The confirm itself commits nothing until the user
   * chooses; `stay` drops it and the next exit re-decides from live facts.
   */
  let pendingHostStopWorkStopped = false
  /**
   * Monotonic identity of the LATEST exit operation/decision. Every request,
   * dismissal, stale retirement and dispose bumps it, so a close-time focus
   * callback cannot hand the decision away and back again without the old
   * confirmation observing it: `open === undefined` alone is not proof that no
   * newer operation happened.
   */
  let operationEpoch = 0
  let disposed = false

  const safeDiag = (level: 'info' | 'error', message: string, fields?: Record<string, unknown>): void => {
    try {
      if (level === 'info') deps.diag.info(message, fields)
      else deps.diag.error(message, fields)
    } catch {
      // No lower sink.
    }
  }

  const presenter = (): SurfaceExitChoiceSeam | undefined => {
    try {
      return deps.presenter()
    } catch (error) {
      safeDiag('error', 'exit choice surface unavailable', { error: safeErrorMessage(error) })
      return undefined
    }
  }

  /**
   * Drop the coordinator's choice state. A local Stop wait is OWNED by the
   * choice, so retiring the choice always aborts it first: a dismissed or
   * disposed seat must never leave an idle/generation listener behind, and a
   * later settlement can never commit an exit the user withdrew.
   */
  const clearChoice = (): void => {
    stopWait?.abort()
    stopWait = undefined
    open = undefined
    captured = undefined
    pendingHostStopWorkStopped = false
  }

  /** Hide the open choice and return to the idle state. */
  const closeChoice = (): void => {
    const hadOpen = open !== undefined
    clearChoice()
    if (hadOpen) presenter()?.close()
  }

  /** Renderer-initiated withdrawal with zero business action. */
  const dismiss = (): void => {
    operationEpoch += 1
    clearChoice()
    // The renderer dropped the seat itself (Host modal preemption / teardown):
    // tell the seam only if it still owns a window; a redundant close is idle.
    presenter()?.close()
  }

  /** Whether the captured identity still owns the decision. */
  const identityCurrent = (identity: CapturedChoice): boolean =>
    deps.facts.currentBackend() === identity.backend
    && deps.facts.isScopeCurrent(identity.scope, identity.transportToken)

  /**
   * Close the choice, then commit ONLY if the close did not hand the decision
   * to a newer operation. Closing can synchronously restore another owner's
   * focus; its `onFocus` callback may open a fresh Exit Choice or publish a new
   * Session owner. The newer operation always wins: an old confirmation never
   * exits a surface it no longer owns.
   */
  const commitAfterClose = (identity: CapturedChoice, workStopped: boolean, epoch: number, hostStopRequested = false): void => {
    closeChoice()
    // The close may synchronously restore another owner's focus and run
    // callbacks that start (and even withdraw) a NEWER operation. Only the
    // SAME operation epoch, still-current identity and a live coordinator may
    // commit; a newer request/dismiss/retire/dispose always wins.
    if (disposed) return
    if (operationEpoch !== epoch) return
    if (!identityCurrent(identity)) return
    // A Host-stop verdict must ALSO survive the close-time re-read: a close
    // callback can change the local intent, and an unproven transition must
    // never execute the stop (the FRESH authoritative read already ran just
    // before this commit; this catches a synchronous close-time revert).
    if (hostStopRequested && !deps.facts.hostStopIntentCurrent()) {
      safeDiag('info', 'host stop declined: the transition intent is no longer current at commit')
      deps.commit({ workStopped })
      return
    }
    deps.commit(hostStopRequested
      ? { workStopped, hostStopRequested: true }
      : { workStopped })
  }

  /**
   * M6 UX PR2: the non-repeatable verification wait. Runs ONE owned async
   * fresh authoritative Backend read on the SAME seat/operation (no epoch
   * bump), then commits. A failure/disconnect/rollover/abort degrades to the
   * ordinary detach and never executes the Host stop. The verdict is captured
   * for the final exit root; the OS stop itself runs only after the terminal
   * restore.
   */
  const verifyThenAcceptStop = (identity: CapturedChoice, workStopped: boolean, epoch: number): void => {
    if (disposed) return
    // Publish the guard BEFORE painting: a synchronous Host-modal preemption in
    // the update callback must not let the later read run as if still current.
    const controller = new AbortController()
    stopWait = controller
    open = exitChoiceVerifying(select, dismiss)
    presenter()?.open(open)
    // The update callback may synchronously dismiss (a Host modal) and start a
    // NEWER operation: abort this verification rather than read/commit for a
    // decision the user already withdrew.
    if (disposed || stopWait !== controller || operationEpoch !== epoch) {
      if (stopWait === controller) stopWait = undefined
      return
    }
    runOwned('exit intent host-stop verify', async () => {
      let ok = false
      try {
        ok = await deps.facts.hostStopEligible()
      } catch {
        ok = false
      }
      // A newer operation or a dispose owns the seat now: this late settlement
      // must NEVER touch it. Only clear/close the seat THIS wait still owns
      // (RFL-011 regression guard).
      if (disposed || stopWait !== controller || operationEpoch !== epoch) return
      stopWait = undefined
      if (!ok) {
        safeDiag('info', 'host stop declined: the fresh authoritative Backend read did not confirm the transition')
        commitAfterClose(identity, workStopped, epoch)
        return
      }
      if (!identityCurrent(identity)) {
        // The identity went stale while THIS wait still owns the seat: retire it
        // cleanly rather than leave it locked.
        closeChoice()
        return
      }
      commitAfterClose(identity, workStopped, epoch, true)
    }, {
      diag: deps.diag,
      onCancel: () => { if (stopWait === controller) stopWait = undefined },
      onError: (error) => {
        if (stopWait === controller) stopWait = undefined
        safeDiag('error', 'host stop verification failed', { error: safeErrorMessage(error) })
        if (!disposed && operationEpoch === epoch) commitAfterClose(identity, workStopped, epoch)
      },
    })
  }

  /**
   * M6 UX PR2: verify BEFORE offering the whole-Host stop confirm. The
   * non-repeatable verifying seat shows while the fresh authoritative read
   * settles; only a confirmed transition opens the dangerous confirm, otherwise
   * the exit commits the ordinary detach with zero Host management.
   */
  const verifyThenOpenHostStop = (
    facts: ReturnType<ExitIntentFacts['capture']>,
    backend: ExitBackendKind,
    workStopped: boolean,
  ): void => {
    if (disposed) return
    // Capture THIS operation's epoch and publish the guard BEFORE painting: a
    // newer request/dismiss must win, and a synchronous Host-modal preemption in
    // the update callback must not revive this withdrawn decision later.
    const epoch = operationEpoch
    const identity: CapturedChoice = { kind: 'daemon-host-stop', backend, scope: facts.scope, live: facts.live, transportToken: facts.transportToken }
    const controller = new AbortController()
    stopWait = controller
    // Publish the captured identity BEFORE the seat is shown, so a scope or
    // transport change during the pending read can retire this wait
    // (retireIfStale) instead of leaving it locked forever.
    captured = identity
    open = exitChoiceVerifying(select, dismiss)
    presenter()?.open(open)
    // The update callback may synchronously dismiss (a Host modal) and start a
    // NEWER operation: abort this verification rather than revive it.
    if (disposed || stopWait !== controller || operationEpoch !== epoch) {
      if (stopWait === controller) stopWait = undefined
      return
    }
    runOwned('exit intent host-stop verify', async () => {
      let ok = false
      try {
        ok = await deps.facts.hostStopEligible()
      } catch {
        ok = false
      }
      // The read settled. A newer operation or a dispose owns the seat now: its own
      // seat is managed by it, so this late settlement must NEVER touch it. Only
      // clear/close the seat THIS wait still owns (RFL-010 regression guard).
      if (disposed || stopWait !== controller || operationEpoch !== epoch) return
      stopWait = undefined
      if (!ok) {
        safeDiag('info', 'host stop declined: the fresh authoritative Backend read did not confirm the transition')
        commitAfterClose(identity, workStopped, epoch)
        return
      }
      if (!identityCurrent(identity)) {
        // The identity went stale while THIS wait still owns the seat: retire it
        // cleanly rather than leave it locked.
        closeChoice()
        return
      }
      // Still THIS operation: only a current, undismissed decision opens the
      // confirm. This is the dangerous revival gate.
      openHostStopChoice(facts, backend, workStopped)
    }, {
      diag: deps.diag,
      onCancel: () => { if (stopWait === controller) stopWait = undefined },
      onError: (error) => {
        if (stopWait === controller) stopWait = undefined
        safeDiag('error', 'host stop verification failed', { error: safeErrorMessage(error) })
        if (!disposed && operationEpoch === epoch) commitAfterClose(identity, workStopped, epoch)
      },
    })
  }

  /** Show the same-seat unconfirmed state; never a stopped claim. */
  const settleUnconfirmed = (detail: string): void => {
    if (disposed) return
    open = exitChoiceUnconfirmed(detail, select, dismiss, deps.facts.capture().shellRunning)
    presenter()?.update(open)
  }

  /** The whole Stop task's failure settlement, bound to its OWN wait. */
  const settleStopFailure = (controller: AbortController, error: unknown): void => {
    // runOwned has already recorded the task failure; this is the SEAT
    // settlement. An old/withdrawn task must not rewrite a newer choice nor
    // clear a newer task's ownership: only the CURRENT wait of the still-open
    // choice may settle. A throwing presentation here is a handler failure
    // captured by runOwned's handler-failure sink — never an unhandled
    // rejection, never a stopped claim.
    if (disposed || stopWait !== controller) return
    stopWait = undefined
    settleUnconfirmed(`The stop request failed: ${safeErrorMessage(error)}`)
  }

  const select = (option: ExitChoiceOption): void => {
    if (disposed) return
    const model = open
    const identity = captured
    if (model === undefined || identity === undefined) return
    // The Stop-in-flight window is locked: repeated confirmations must never
    // dispatch a second cancel.
    if (model.phase === 'stopping' || model.phase === 'verifying') return
    // Only an option the CURRENT model really offered may act. A renderer
    // cannot reach a business path its painted frame never presented.
    if (!model.options.some(candidate => candidate.id === option)) {
      safeDiag('error', 'exit choice received an option the current frame did not offer', { option })
      return
    }
    if (option === 'stay') {
      closeChoice()
      return
    }
    // The operation identity of THIS confirmation. Any close-time/newer
    // operation bumps the coordinator epoch and makes this confirmation
    // unable to commit afterwards.
    const epoch = operationEpoch
    const facts = deps.facts.capture()
    const backend = deps.facts.currentBackend()
    // An ALREADY-ACCEPTED `!`/`!!` submission can start its shell owner AFTER
    // this choice opened (`ensureSession().then(shell.run)` in the submission
    // controller). The exit options are preserved (Owner decision), but the
    // user must SEE the shell reminder before acting: an un-warned confirmation
    // refreshes the SAME phase with the reminder instead of committing. The
    // refresh never mints a NEW captured identity (a Connection/binding
    // rollover must retire the choice, not rebind the old intent to the new
    // transport generation), and it never leaves the current phase: an
    // Unconfirmed seat keeps its refusal facts and its safe option set, and is
    // never rebuilt into a Busy choice that re-offers a second Stop.
    if (facts.shellRunning && model.shellRunning !== true) {
      if (backend !== identity.backend) {
        safeDiag('info', 'exit choice retired: backend changed', { captured: identity.backend, live: backend })
        closeChoice()
        return
      }
      if (!deps.facts.isScopeCurrent(identity.scope, identity.transportToken)) {
        safeDiag('info', 'exit choice retired: the captured session scope is no longer current')
        closeChoice()
        return
      }
      if (model.phase === 'unconfirmed') {
        open = exitChoiceUnconfirmed(model.status, select, dismiss, true)
        presenter()?.update(open)
        return
      }
      // The asking phase refreshes ONLY the model in place: the captured
      // identity (scope + exact transport token) stays the one the user chose.
      open = exitChoiceAsking(identity.kind, select, dismiss, true)
      presenter()?.update(open)
      return
    }
    // The choice captured an exact identity. A backend flip retires it with no
    // action; the user re-triggers a fresh Exit Intent.
    if (backend !== identity.backend) {
      safeDiag('info', 'exit choice retired: backend changed', { captured: identity.backend, live: backend })
      closeChoice()
      return
    }
    if (!deps.facts.isScopeCurrent(identity.scope, identity.transportToken)) {
      safeDiag('info', 'exit choice retired: the captured session scope is no longer current')
      closeChoice()
      return
    }
    // `stop-and-exit` runs the EXISTING Direct controller: its owned-session
    // retirement is the only Direct cancel. Nothing is claimed as stopped here.
    if (option === 'stop-and-exit' || option === 'exit-local') {
      commitAfterClose(identity, false, epoch)
      return
    }
    // M6 UX PR2: the whole-Host stop confirm. `Leave` is the ordinary PR1
    // Client detach (zero Host management), `Stop` is the ONE explicit
    // Profile-management authorization handed to the final exit root — the
    // admin stop runs only after the terminal is restored, and never twice.
    if (option === 'leave-host-and-exit') {
      commitAfterClose(identity, pendingHostStopWorkStopped, epoch)
      return
    }
    if (option === 'stop-host-and-exit') {
      // The verdict is only valid after a FRESH authoritative Backend read
      // confirms the daemon→direct transition. A revert by another Client, a
      // stale/unknown configuration or a Direct re-read must NOT execute the
      // Host stop: the exit degrades to the ordinary detach (plan §3.3 — never
      // treat unknown as verified). The check runs on the SAME seat/operation
      // with a non-repeatable verifying state.
      verifyThenAcceptStop(identity, pendingHostStopWorkStopped, epoch)
      return
    }
    if (option === 'keep-and-disconnect' || option === 'disconnect-without-stop') {
      if (interceptHostStopConfirm(identity, facts, false, epoch)) return
      commitAfterClose(identity, false, epoch)
      return
    }
    if (option === 'stop-and-disconnect') {
      const kind = identity.kind
      if (kind !== 'daemon-busy') {
        // Defensive: an option never offered by this family. Retire untouched.
        closeChoice()
        return
      }
      if (facts.activity === 'idle') {
        // The exact owner became idle by itself: the SAME captured identity is
        // already proven current above, so detach without sending a cancel.
        // A running user shell is not proven by the Agent waiter: no stopped claim.
        if (interceptHostStopConfirm(identity, facts, !facts.shellRunning, epoch)) return
        commitAfterClose(identity, !facts.shellRunning, epoch)
        return
      }
      if (facts.activity === 'unknown') {
        // The running state became unobservable between open and confirm: the
        // captured choice is invalid, and no Stop can be proven. Retire it.
        safeDiag('info', 'exit choice retired: the running state became unobservable')
        closeChoice()
        return
      }
      if (identity.live === undefined) {
        // No live Session remains: nothing to stop; detach without a cancel.
        if (interceptHostStopConfirm(identity, facts, false, epoch)) return
        commitAfterClose(identity, false, epoch)
        return
      }
      // The WHOLE async Stop task (both presenter calls and the exact-owner
      // operation) is one owned task. The task's own AbortSignal + typed
      // outcomes express legitimate cancellation; a THROWN cancellation-shaped
      // error is not a business cancellation of the decision, so BOTH terminal
      // routes settle through the same controller fence. An old task can only
      // record diagnostics, never rewrite a newer choice or clear its wait.
      const controller = new AbortController()
      stopWait = controller
      runOwned('exit intent stop', () => runStop(identity, epoch, controller), {
        diag: deps.diag,
        sessionId: () => identity.live?.sessionId,
        onCancel: (error) => { settleStopFailure(controller, error) },
        onError: (error) => { settleStopFailure(controller, error) },
      })
      return
    }
    // An option this model did not offer: keep the choice, dispatch nothing.
    safeDiag('error', 'exit choice received an unsupported option', { option })
  }

  /**
   * M6 UX PR2: the ONE post-decision gate. Before ANY PR1 commit that leaves
   * the daemon Client, check the transient conversion intent against the LIVE
   * Profile facts; when it holds, replace the direct commit with the whole-Host
   * stop confirm (which itself commits nothing until the user chooses). The
   * epoch of this confirmation is the NEW choice's epoch, so the old
   * confirmation can never commit behind it. Returns true when the confirm
   * took over; the caller must NOT commit.
   */
  const interceptHostStopConfirm = (
    identity: CapturedChoice,
    facts: ReturnType<ExitIntentFacts['capture']>,
    workStopped: boolean,
    _epoch: number,
  ): boolean => {
    // Only a daemon Client has an old shared Host to ask about; a Direct exit
    // always commits directly even if a stale intent somehow lingers. The
    // cheap SYNC intent check decides whether to intercept at all; the FRESH
    // authoritative read runs in verifyThenOpenHostStop before the option is
    // ever shown.
    if (identity.backend !== 'daemon') return false
    if (!deps.facts.hostStopIntentCurrent()) return false
    // The SAME identity, revalidated live; the confirm is a NEW operation.
    if (facts.shellRunning && open?.shellRunning !== true) {
      // A user shell reminder must be seen before the dangerous confirm too;
      // refresh the SAME phase with the reminder and let the next confirmation
      // reach this gate again.
      open = exitChoiceAsking(identity.kind, select, dismiss, true)
      presenter()?.update(open)
      return true
    }
    verifyThenOpenHostStop(facts, identity.backend, workStopped)
    return true
  }

  /** Present the ONE asking-phase choice for one captured identity. */
  const openChoice = (
    kind: ExitChoiceKind,
    facts: ReturnType<ExitIntentFacts['capture']>,
    backend: ExitBackendKind,
  ): void => {
    const seam = presenter()
    if (seam === undefined) {
      // Fail closed: a composition without a mounted choice surface must never
      // degrade a dangerous choice into an immediate exit or an implicit Stay
      // claim. Nothing is committed and nothing is written.
      safeDiag('error', 'exit intent requires a choice but no surface is mounted')
      return
    }
    // A new choice is a NEWER operation: any earlier confirmation still
    // unwinding can no longer commit after it.
    operationEpoch += 1
    captured = {
      kind,
      backend,
      scope: facts.scope,
      live: facts.live,
      transportToken: facts.transportToken,
    }
    open = exitChoiceAsking(kind, select, dismiss, facts.shellRunning)
    seam.open(open)
  }

  /**
   * M6 UX PR2: present the ONE whole-Host stop confirm. It is a NEW operation
   * over the SAME captured identity: the epoch bump fences any earlier
   * confirmation, and the choice itself performs ZERO Host management on open.
   * `pendingHostStopWorkStopped` carries the PR1 decision's proof forward so
   * the final commit keeps its truthful wording.
   */
  const openHostStopChoice = (
    facts: ReturnType<ExitIntentFacts['capture']>,
    backend: ExitBackendKind,
    workStopped: boolean,
  ): void => {
    const seam = presenter()
    if (seam === undefined) {
      // Fail closed exactly like the PR1 choice: with no surface the exit is
      // NOT committed and NOTHING is stopped.
      safeDiag('error', 'exit intent requires the host-stop choice but no surface is mounted')
      return
    }
    operationEpoch += 1
    pendingHostStopWorkStopped = workStopped
    captured = {
      kind: 'daemon-host-stop',
      backend,
      scope: facts.scope,
      live: facts.live,
      transportToken: facts.transportToken,
    }
    open = exitChoiceHostStop(select, dismiss, facts.shellRunning)
    seam.open(open)
  }

  const runStop = async (
    identity: CapturedChoice,
    epoch: number,
    controller: AbortController,
  ): Promise<void> => {
    const live = identity.live
    if (live === undefined) throw new Error('a daemon Stop requires a captured live Session')
    open = exitChoiceStopping(select, dismiss)
    presenter()?.update(open)
    // The Stopping presentation is SYNCHRONOUS: a higher-priority Host modal
    // may withdraw the choice from inside that very update (dismiss/dispose),
    // which aborts this controller. The Stop may only leave with the choice
    // that dispatched it still open, this wait still current and un-aborted,
    // and the captured identity unchanged — otherwise zero Cancel, zero commit.
    if (disposed || open === undefined || stopWait !== controller || controller.signal.aborted) return
    if (!identityCurrent(identity)) return
    const outcome = await deps.stopCurrentWork(live, controller.signal)
    // The choice (or the whole coordinator) was withdrawn while waiting: its
    // abort/settlement owns the state now, and no exit may be committed.
    if (disposed || stopWait !== controller) return
    stopWait = undefined
    if (outcome.kind === 'stopped') {
      // The idle proof is bound to the exact generation; the commit re-checks
      // the captured identity and the operation epoch after the close-time
      // focus callbacks.
      if (!identityCurrent(identity)) {
        settleUnconfirmed('The captured session is no longer current.')
        return
      }
      // The Agent idle proof does not prove a Client-owned shell finished; the
      // stopped line is withheld while a shell is still running.
      const workStopped = !deps.facts.capture().shellRunning
      if (interceptHostStopConfirm(identity, deps.facts.capture(), workStopped, epoch)) return
      commitAfterClose(identity, workStopped, epoch)
      return
    }
    settleUnconfirmed(outcome.detail)
  }

  const request = (entry: ExitIntentEntry): void => {
    if (disposed) return
    // One choice at a time: a repeated exit key/slash while the choice (or the
    // Stop wait) owns the decision must never stack a second window or send a
    // second cancel.
    if (open !== undefined) return
    const facts = deps.facts.capture()
    const backend = deps.facts.currentBackend()
    const decision = classifyExitIntent({
      currentBackend: backend,
      sessionPresence: facts.scope.sessionId === undefined ? 'none' : 'live',
      activity: facts.activity,
      entry,
    })
    switch (decision) {
      case 'direct-exit':
      case 'client-detach': {
        // M6 UX PR2: the ONE post-decision confirm. Only a daemon Client that
        // earned the transient daemon→direct conversion intent is asked about
        // the old Host, and only after a FRESH authoritative Backend read
        // confirms it; every ordinary exit/detach commits directly and never
        // stops a Host. A Direct exit always commits directly.
        if (backend === 'daemon' && deps.facts.hostStopIntentCurrent()) {
          verifyThenOpenHostStop(facts, backend, false)
          return
        }
        deps.commit({ workStopped: false })
        return
      }
      case 'show-daemon-choice':
        openChoice('daemon-busy', facts, backend)
        return
      case 'show-direct-choice':
        openChoice('direct-busy', facts, backend)
        return
      case 'show-unknown-choice':
        openChoice(backend === 'daemon' ? 'daemon-unknown' : 'direct-unknown', facts, backend)
        return
    }
  }

  const retireIfStale = (): void => {
    if (disposed) return
    const identity = captured
    if (open === undefined || identity === undefined) return
    if (!identityCurrent(identity)) {
      // The Stop wait (if any) is abandoned too: it can only prove a generation
      // the Client already left, so it can never commit an exit.
      safeDiag('info', 'exit choice retired: the captured identity is no longer current')
      operationEpoch += 1
      closeChoice()
    }
  }

  return {
    request,
    activity: () => deps.facts.capture().activity,
    retireIfStale,
    dispose: () => {
      if (disposed) return
      disposed = true
      operationEpoch += 1
      clearChoice()
    },
  }
}
