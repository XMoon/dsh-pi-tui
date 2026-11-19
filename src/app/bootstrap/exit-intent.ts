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
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/exit-intent
 */

import type { LiveSessionScope } from '../session/scope.ts'
import {
  classifyExitIntent,
  type ExitBackendKind,
  type ExitIntentEntry,
  type ExitSessionActivity,
} from '../../domain/command/policy.ts'
import {
  exitChoiceAsking,
  exitChoiceStopping,
  exitChoiceUnconfirmed,
  type ExitChoiceKind,
  type ExitChoiceModel,
  type ExitChoiceOption,
  type SurfaceExitChoiceSeam,
} from '../surface/exit-choice.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { ExitDiagLike } from './exit.ts'

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
   * ONE synchronous capture of the exact scope and authoritative activity.
   * `scope` is undefined only for a sessionless surface; a pending submission
   * admission without a Session must report `activity: 'working'` (the
   * classifier then fails safe).
   */
  capture(): {
    readonly scope: LiveSessionScope | undefined
    readonly activity: ExitSessionActivity
    /** The Remote transport identity captured beside the scope (undefined on Direct). */
    readonly transportToken?: unknown
  }
  /** Whether a captured scope still pins the live owner AND its transport. */
  isScopeCurrent(scope: LiveSessionScope, transportToken: unknown): boolean
}

/** The narrow dependencies of the coordinator. */
export interface ExitIntentCoordinatorDeps {
  readonly diag: ExitDiagLike
  readonly facts: ExitIntentFacts
  /**
   * The ONE final exit commit — the existing `createExitController.requestExit`.
   * `workStopped` is true ONLY after the captured owner's authoritative idle
   * proof, and only that commit may print the stopped line.
   */
  readonly commit: (options: { readonly workStopped: boolean }) => void
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
  readonly scope: LiveSessionScope | undefined
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
  /** The in-flight daemon Stop wait, if any. */
  let stopWait: AbortController | undefined
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
      safeDiag('error', 'exit choice surface unavailable', { error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  const clearChoice = (): void => {
    open = undefined
    captured = undefined
    stopWait = undefined
  }

  /** Hide the open choice and return to the idle state. */
  const closeChoice = (): void => {
    const hadOpen = open !== undefined
    clearChoice()
    if (hadOpen) presenter()?.close()
  }

  /** Renderer-initiated withdrawal with zero business action. */
  const dismiss = (): void => {
    clearChoice()
    // The renderer dropped the seat itself (Host modal preemption / teardown):
    // tell the seam only if it still owns a window; a redundant close is idle.
    presenter()?.close()
  }

  const select = (option: ExitChoiceOption): void => {
    if (disposed) return
    const model = open
    const identity = captured
    if (model === undefined || identity === undefined) return
    // The Stop-in-flight window is locked: repeated confirmations must never
    // dispatch a second cancel.
    if (model.phase === 'stopping') return
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
    const facts = deps.facts.capture()
    const backend = deps.facts.currentBackend()
    // The choice captured an exact identity. A backend flip retires it with no
    // action; the user re-triggers a fresh Exit Intent.
    if (backend !== identity.backend) {
      safeDiag('info', 'exit choice retired: backend changed', { captured: identity.backend, live: backend })
      closeChoice()
      return
    }
    const scope = identity.scope
    if (scope !== undefined && !deps.facts.isScopeCurrent(scope, identity.transportToken)) {
      safeDiag('info', 'exit choice retired: the captured session scope is no longer current')
      closeChoice()
      return
    }
    // `stop-and-exit` runs the EXISTING Direct controller: its owned-session
    // retirement is the only Direct cancel. Nothing is claimed as stopped here.
    if (option === 'stop-and-exit' || option === 'exit-local') {
      closeChoice()
      deps.commit({ workStopped: false })
      return
    }
    if (option === 'keep-and-disconnect' || option === 'disconnect-without-stop') {
      closeChoice()
      deps.commit({ workStopped: false })
      return
    }
    if (option === 'stop-and-disconnect') {
      const kind = identity.kind
      if (kind !== 'daemon-busy') {
        // Defensive: an option never offered by this family. Retire untouched.
        closeChoice()
        return
      }
      if (scope === undefined) {
        // No live Session remains: nothing to stop; detach without a cancel.
        closeChoice()
        deps.commit({ workStopped: false })
        return
      }
      if (facts.activity === 'idle') {
        // The exact owner became idle by itself: the SAME captured identity is
        // already proven current above, so detach without sending a cancel.
        closeChoice()
        deps.commit({ workStopped: true })
        return
      }
      if (facts.activity === 'unknown') {
        // The running state became unobservable between open and confirm: the
        // captured choice is invalid, and no Stop can be proven. Retire it.
        safeDiag('info', 'exit choice retired: the running state became unobservable')
        closeChoice()
        return
      }
      void runStop(scope) // allowlist: the ONE Stop wait owns its own unconfirmed settlement; every rejection is converted into the same-seat unconfirmed state, never leaked
      return
    }
    // An option this model did not offer: keep the choice, dispatch nothing.
    safeDiag('error', 'exit choice received an unsupported option', { option })
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
    captured = { kind, backend, scope: facts.scope, transportToken: facts.transportToken }
    open = exitChoiceAsking(kind, select, dismiss)
    seam.open(open)
  }

  const runStop = async (scope: LiveSessionScope): Promise<void> => {
    const identity = captured
    if (identity === undefined) return
    const controller = new AbortController()
    stopWait = controller
    open = exitChoiceStopping(select, dismiss)
    presenter()?.update(open)
    let outcome: StopCurrentWorkOutcome
    try {
      outcome = await deps.stopCurrentWork(scope, controller.signal)
    } catch (error) {
      // An unexpected stop failure is never a "stopped" claim and never
      // escapes as an unhandled rejection: the same unconfirmed state owns it.
      if (disposed || stopWait !== controller) return
      stopWait = undefined
      open = exitChoiceUnconfirmed(`The stop request failed: ${safeErrorMessage(error)}`, select, dismiss)
      presenter()?.update(open)
      return
    }
    if (disposed || stopWait !== controller) return
    stopWait = undefined
    if (outcome.kind === 'stopped') {
      // The idle proof is bound to the exact generation; re-check the session
      // scope it belongs to before committing the ONE exit.
      if (identity.scope === undefined || !deps.facts.isScopeCurrent(identity.scope, identity.transportToken)) {
        open = exitChoiceUnconfirmed('The captured session is no longer current.', select, dismiss)
        presenter()?.update(open)
        return
      }
      closeChoice()
      deps.commit({ workStopped: true })
      return
    }
    open = exitChoiceUnconfirmed(outcome.detail, select, dismiss)
    presenter()?.update(open)
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
      sessionPresence: facts.scope === undefined ? 'none' : 'live',
      activity: facts.activity,
      entry,
    })
    switch (decision) {
      case 'direct-exit':
      case 'client-detach':
        deps.commit({ workStopped: false })
        return
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

  return {
    request,
    activity: () => deps.facts.capture().activity,
    retireIfStale: () => {
      if (disposed) return
      const identity = captured
      if (open === undefined || identity === undefined) return
      const backend = deps.facts.currentBackend()
      if (backend !== identity.backend
        || (identity.scope !== undefined && !deps.facts.isScopeCurrent(identity.scope, identity.transportToken))) {
        // The Stop wait (if any) is abandoned too: it can only prove a
        // generation the Client already left, so it can never commit an exit.
        stopWait?.abort()
        safeDiag('info', 'exit choice retired: the captured identity is no longer current')
        closeChoice()
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stopWait?.abort()
      clearChoice()
    },
  }
}
