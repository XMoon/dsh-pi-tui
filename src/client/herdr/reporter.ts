/**
 * Herdr pane agent-state reporter (H1) and main-Session reporter (H2).
 *
 * ONE Client-local owner of the `pane report-agent` / `report-agent-session` /
 * `pane release-agent` external IO of the Pane this TUI Client really occupies.
 * It is fed ONLY with the already-derived main-Agent logical status
 * (`TuiApp.effectiveProgramStatus` through the read-only `onProgramStatus`
 * observation) and with the already-committed main Session projection
 * (`observeSession`, built by the Client composition from the official
 * ownership core). The status maps onto the closed Herdr three-state
 * vocabulary: `idle` / `working` / `blocked`. The non-running `done`/`error`
 * records are Herdr `idle`; a `clear` presentation record is not a business
 * change and is ignored.
 *
 * The external contract (Herdr `add-herdr-support`):
 * - qualification is the Herdr-injected environment (`HERDR_ENV=1` plus the
 *   Pane id, CLI path and socket path), never a terminal-brand guess;
 * - every dispatch is one `spawn` with a fixed argv array and no shell;
 * - `--seq` is monotone per source and initialized from the wall clock so a
 *   restarted process never restarts at 1;
 * - at most one child process is live and at most one newer intent waits behind
 *   it (latest wins), so rapid status churn cannot build a backlog;
 * - a child is bounded to 500 ms and every failure is contained: the reporter
 *   never throws into the Agent/Session/render path and never logs argv,
 *   stderr or environment values;
 * - ONLY a `release-agent` that really exited 0 may claim a saved resume target
 *   was withdrawn. A failed/timed-out withdrawal keeps that cleanup outstanding
 *   and also keeps the Pane unregistered, so nothing can claim a wrong restore
 *   target; a LATER real lifecycle event (a new main-owner Session fact, a real
 *   Agent state change or a requalification) retries it once — never a loop, a
 *   timer or a poll.
 *
 * The Remote branch's qualification is owned by the composition root: the
 * reporter starts UNqualified there and only a valid Host snapshot can
 * `setQualified(true)`; losing the current Host watch requalifies to `false`,
 * which withdraws the Pane registration with an ordered `release-agent`.
 *
 * @module @xmoon76/dsh-pi-tui/client/herdr/reporter
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { ProgramStatus } from '../../domain/terminal-progress/program-status.ts'
import type { HerdrSessionProjection } from './session.ts'

/** The three states Herdr `pane report-agent --state` accepts. */
export type HerdrAgentState = 'idle' | 'working' | 'blocked'

/**
 * The ONE Client-local reporter. `publish` is synchronous and never throws;
 * the actual CLI work is dispatched in the background.
 */
export interface HerdrReporter {
  /** Observe one already-derived main-Agent logical status. */
  publish(status: ProgramStatus): void
  /**
   * Observe the CURRENT committed main-owner Session projection, or undefined
   * when there is no reportable Session. The composition decides the owner;
   * the reporter never re-reads Session or Host state.
   */
  observeSession(session: HerdrSessionProjection | undefined): void
  /** Whether this Client currently owns a valid Pane registration source. */
  setQualified(qualified: boolean): void
  /** Stop new publication and withdraw a started registration (best effort). */
  dispose(): void
}

/** The fixed third-party identity this Client registers under. */
const HERDR_SOURCE = 'dsh-pi-tui'
const HERDR_AGENT = 'dsh-pi-tui'

/** The hard upper bound of one external CLI invocation. */
const REPORT_TIMEOUT_MS = 500

/** The Herdr-injected target values this reporter owns. */
interface HerdrTarget {
  readonly paneId: string
  readonly binPath: string
}

/** One queued intent: a state report, a Session report or the ordered
 *  registration withdrawal. All three share one queue and one sequence. */
interface ReportIntent {
  readonly kind: 'report'
  readonly state: HerdrAgentState
}
interface SessionIntent {
  readonly kind: 'session'
  readonly session: HerdrSessionProjection
}
interface ReleaseIntent {
  readonly kind: 'release'
}
type Intent = ReportIntent | SessionIntent | ReleaseIntent

/** Read the Herdr qualification facts from the Pane environment. */
function herdrTarget(env: NodeJS.ProcessEnv): HerdrTarget | undefined {
  if (env.HERDR_ENV !== '1') return undefined
  const paneId = env.HERDR_PANE_ID
  const binPath = env.HERDR_BIN_PATH
  const socketPath = env.HERDR_SOCKET_PATH
  if (paneId === undefined || paneId === '') return undefined
  if (binPath === undefined || binPath === '') return undefined
  if (socketPath === undefined || socketPath === '') return undefined
  return { paneId, binPath }
}

/** Map the logical program status onto the closed Herdr three-state set.
 *  `clear` is a presentation retirement, not a business status change. */
function agentStateOf(status: ProgramStatus): HerdrAgentState | undefined {
  switch (status.state) {
    case 'idle':
    case 'done':
    case 'error':
      return 'idle'
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'clear':
      return undefined
  }
}

/**
 * Create the ONE reporter of this Pane, or `undefined` when this process is not
 * inside a complete Herdr Pane environment. `initialQualified` is the
 * composition root's starting authority fact: Direct owns its Pane immediately,
 * while the Remote branch must wait for a valid Host snapshot.
 */
export function createHerdrReporter(
  env: NodeJS.ProcessEnv,
  initialQualified: boolean,
  diag?: Diag,
): HerdrReporter | undefined {
  const target = herdrTarget(env)
  if (target === undefined) return undefined

  let disposed = false
  let qualified = initialQualified
  /** The newest LOGICAL state, retained while unqualified for requalification. */
  let latest: HerdrAgentState | undefined
  /** The state the queue currently owns while qualified (dedupe baseline). */
  let registered: HerdrAgentState | undefined
  /** The state of the live child when it is a report (not a withdrawal). */
  let activeState: HerdrAgentState | undefined
  /** The last report dispatched by this reporter, for idle-queue dedupe. */
  let lastDispatched: HerdrAgentState | undefined
  /** The newest main-owner Session projection, retained while unqualified. */
  let latestSession: HerdrSessionProjection | undefined
  /** At most one newer Session projection waits behind the live child. */
  let pendingSession: HerdrSessionProjection | undefined
  /** The Session projection of the live child, when it is a session intent. */
  let activeSession: HerdrSessionProjection | undefined
  /** The last Session intent this reporter DELIVERED (exit code 0). */
  let lastSession: HerdrSessionProjection | undefined
  /** Whether a `report-agent` child exited 0 in this registration cycle: the
   *  external Pane authority every Session report must wait for. */
  let paneAcknowledged = false
  /** Whether THIS process dispatched a resume argv that Herdr may have saved.
   *  Only a release that really exited 0 may clear it; it is not a second
   *  Session authority. */
  let reportedResumePresent = false
  /** An outstanding withdrawal of a possibly-saved resume target. It is set
   *  when such a cleanup is needed and survives a failed release, so a LATER
   *  real lifecycle event can retry it; it is never retried by itself. */
  let cleanupRequired = false
  /** A real lifecycle event arrived while the registration cycle had no Pane
   *  authority, so ONE ordered re-registration is owed when the queue drains.
   *  A boolean (never a counter) keeps this a single attempt per event. */
  let registrationRetryOwed = false
  /** The one live child, or `undefined` when the queue is idle. */
  let active: { readonly child: ChildProcess; readonly timer: NodeJS.Timeout; readonly kind: Intent['kind'] } | undefined
  /** At most one newer report waits behind the live child (latest wins). */
  let pendingReport: HerdrAgentState | undefined
  /** The ordered withdrawal barrier: it always precedes a newer report. */
  let pendingRelease = false
  /** The newest `--seq` value this process dispatched. */
  let lastSeq = 0

  /** Exact Session-intent identity: same id and same resume argv. */
  const sameSession = (a: HerdrSessionProjection | undefined, b: HerdrSessionProjection | undefined): boolean => {
    if (a === undefined || b === undefined) return a === b
    if (a.sessionId !== b.sessionId) return false
    if (a.resumeArgv === undefined || b.resumeArgv === undefined) return a.resumeArgv === b.resumeArgv
    return a.resumeArgv.length === b.resumeArgv.length
      && a.resumeArgv.every((arg, index) => arg === b.resumeArgv?.[index])
  }

  /** D6: each ACTUAL dispatch takes `max(last+1, Date.now()*1000)`; reports
   *  and releases share the one sequence. */
  const nextSeq = (): number => {
    lastSeq = Math.max(lastSeq + 1, Date.now() * 1000)
    return lastSeq
  }

  /** Re-establish the Pane registration with the CURRENT facts. Only a proven
   *  clean state may call this: never on the strength of a failed withdrawal. */
  const requeueCurrentFacts = (): void => {
    if (disposed || !qualified) return
    pendingReport = latest
    pendingSession = latestSession
  }

  /** A withdrawal that ended SUCCESSFULLY (exit code 0) is the only proof that
   *  the Pane registration and every resume target of this source are gone.
   *  `finishActive` then re-queues the CURRENT facts behind the clean state. */
  const withdrawalSucceeded = (): void => {
    reportedResumePresent = false
    cleanupRequired = false
  }

  /** A withdrawal that FAILED (non-zero, ENOENT, spawn throw, timeout) proves
   *  nothing: keep the cleanup outstanding so the next real lifecycle event
   *  retries it, and never re-register the Pane on the strength of it.
   *
   *  An attempt remembered by a real event that arrived WHILE this withdrawal
   *  was in flight is NOT cleared here: that event is newer than the failed
   *  attempt, so its one retry is still owed (an attempt recorded before the
   *  cleanup obligation existed was already discarded when it was created). */
  const withdrawalFailed = (): void => {
    if (reportedResumePresent) cleanupRequired = true
  }

  /** Dispatch the next queued intent, if any. A withdrawal always precedes a
   *  newer report, then the latest state, then the current Session; at most one
   *  report and one Session projection are retained (latest wins). */
  const advanceQueue = (): void => {
    if (pendingRelease) {
      pendingRelease = false
      dispatch({ kind: 'release' })
      return
    }
    // An unproven cleanup outranks every report: the Pane must not be
    // re-registered (and no Session claimed) while a wrong restore target may
    // still be saved upstream.
    if (cleanupRequired) return
    const state = pendingReport
    if (state !== undefined) {
      pendingReport = undefined
      dispatch({ kind: 'report', state })
      return
    }
    const session = pendingSession
    if (session !== undefined) {
      // A Session report is only legal once this registration cycle has a REAL
      // successful `report-agent`; otherwise Herdr answers resume_not_accepted.
      // Until then the latest projection stays buffered (no retry loop).
      if (!paneAcknowledged) return
      pendingSession = undefined
      dispatch({ kind: 'session', session })
    }
  }

  /**
   * A real lifecycle event arrived while this registration cycle has no Pane
   * authority yet (the first `report-agent` failed) or while a cleanup is still
   * outstanding. Re-attempt exactly the one thing that is owed — the cleanup
   * release, otherwise the ordered registration — ONCE from THIS event: a
   * successful state re-registers the Pane and lets `advanceQueue` deliver the
   * current Session after it. Nothing here schedules its own retry.
   *
   * The event may arrive while a FAILED child is still settling (its `close`
   * has not run yet). The attempt is therefore REMEMBERED as one boolean and
   * consumed by `finishActive`, so the event cannot be silently swallowed — and
   * still cannot become a loop, because a later event only ever sets it again.
   */
  const reattemptRegistration = (): void => {
    if (disposed || !qualified) return
    if (active !== undefined || pendingRelease) {
      registrationRetryOwed = true
      return
    }
    if (cleanupRequired) {
      dispatch({ kind: 'release' })
      return
    }
    if (latest === undefined) return
    pendingReport = latest
    advanceQueue()
  }

  /**
   * Consume a remembered re-registration attempt, if one is owed.
   *
   * The event was recorded while a child was still in flight, so the decision
   * is taken HERE, on the settled facts: a registration that really succeeded
   * needs no duplicate `report-agent` (its baseline already dedupes the state);
   * only an unestablished Pane or an outstanding cleanup is retried.
   *
   * It stays OWED while the queue is busy: acting then would start a second
   * child (the one-live-child invariant) and could dispatch the Session before
   * the state report it must follow. The next settle consumes it.
   */
  const consumeRegistrationRetry = (): void => {
    if (!registrationRetryOwed) return
    if (active !== undefined || pendingRelease) return
    registrationRetryOwed = false
    if (!paneAcknowledged || cleanupRequired) reattemptRegistration()
    else advanceQueue()
  }

  const finishActive = (): void => {
    const settled = active
    if (settled === undefined) return
    active = undefined
    activeState = undefined
    activeSession = undefined
    clearTimeout(settled.timer)
    // A failed withdrawal leaves the cleanup outstanding; in that case the Pane
    // is NOT re-registered and no current fact is queued behind it.
    if (settled.kind === 'release' && !cleanupRequired) requeueCurrentFacts()
    advanceQueue()
    consumeRegistrationRetry()
  }

  /** One bounded, shell-free external invocation. */
  const dispatch = (intent: Intent): void => {
    const args = intent.kind === 'report'
      ? [
        'pane', 'report-agent', target.paneId,
        '--source', HERDR_SOURCE,
        '--agent', HERDR_AGENT,
        '--state', intent.state,
        '--seq', String(nextSeq()),
      ]
      : intent.kind === 'release'
        ? [
          'pane', 'release-agent', target.paneId,
          '--source', HERDR_SOURCE,
          '--agent', HERDR_AGENT,
          '--seq', String(nextSeq()),
        ]
        : [
          'pane', 'report-agent-session', target.paneId,
          '--source', HERDR_SOURCE,
          '--agent', HERDR_AGENT,
          '--seq', String(nextSeq()),
          '--agent-session-id', intent.session.sessionId,
          ...(intent.session.resumeArgv === undefined ? [] : ['--', ...intent.session.resumeArgv]),
        ]
    let child: ChildProcess
    try {
      child = spawn(target.binPath, args, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
    } catch (error) {
      diag?.warn('herdr pane report failed', {
        reason: intent.kind,
        error: error instanceof Error ? error.name : 'spawn',
      })
      // No child was created: a withdrawal proves nothing, and a failed attempt
      // to register the Pane leaves it unregistered.
      if (intent.kind === 'release') withdrawalFailed()
      else if (intent.kind === 'report') paneAcknowledged = false
      advanceQueue()
      return
    }
    const timer = setTimeout(() => {
      diag?.warn('herdr pane report timed out', { reason: intent.kind })
      child.kill('SIGKILL')
    }, REPORT_TIMEOUT_MS)
    timer.unref()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      finishActive()
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      diag?.warn('herdr pane report failed', {
        reason: intent.kind,
        error: error.code ?? error.name,
      })
      // A child that never ran (ENOENT) proves nothing about the Pane.
      if (intent.kind === 'release') withdrawalFailed()
      else if (intent.kind === 'report') paneAcknowledged = false
      finish()
    })
    child.once('close', (code) => {
      if (settled) return
      if (code === 0) {
        if (intent.kind === 'report') {
          // The Pane is now held by this source: only from here may a Session
          // report follow (Herdr would reject it earlier).
          paneAcknowledged = true
        } else if (intent.kind === 'session') {
          lastSession = intent.session
        } else {
          withdrawalSucceeded()
        }
      } else {
        // Non-zero (including a killed timed-out child) or a null code: the
        // external effect is UNKNOWN, so nothing may be claimed.
        diag?.warn('herdr pane report failed', { reason: intent.kind, code })
        if (intent.kind === 'release') withdrawalFailed()
        else if (intent.kind === 'report') paneAcknowledged = false
      }
      finish()
    })
    // The CLI is a short-lived, stdio-detached helper: it must never keep the
    // TUI process alive or block exit.
    child.unref()
    if (intent.kind === 'report') {
      activeState = intent.state
      lastDispatched = intent.state
    } else if (intent.kind === 'session') {
      activeSession = intent.session
      // A dispatched resume argv may already be persisted by Herdr: only a
      // release that really exited 0 can withdraw it from this point of view.
      if (intent.session.resumeArgv !== undefined) {
        reportedResumePresent = true
        cleanupRequired = false
      }
    } else {
      activeState = undefined
      // The withdrawal is IN FLIGHT: nothing is proven yet, so the previous
      // registration facts are neither cleared nor re-queued here.
      paneAcknowledged = false
      lastSession = undefined
    }
    active = { child, timer, kind: intent.kind }
  }

  const enqueue = (intent: ReportIntent | ReleaseIntent): void => {
    if (intent.kind === 'release') {
      // A withdrawal clears every queued status and Session: an old fact must
      // never be written after the registration it belonged to was withdrawn.
      pendingReport = undefined
      pendingSession = undefined
      if (active === undefined) dispatch(intent)
      else pendingRelease = true
      return
    }
    // While a cleanup is unproven, no state may re-register the Pane: the
    // current fact waits behind the successful withdrawal.
    if (cleanupRequired || active !== undefined) {
      pendingReport = intent.state
      return
    }
    dispatch(intent)
  }

  /** Queue the CURRENT Session fact from the retained desired projection.
   *  A Session target without a recoverable resume argv can only replace an
   *  older resume target through Herdr's ordered release -> re-register cycle. */
  const reconcileSession = (): void => {
    const desired = latestSession
    if (cleanupRequired) {
      // An earlier cleanup withdrawal failed. A real Session fact is exactly the
      // lifecycle event allowed to retry that ONE outstanding release; until it
      // succeeds the Pane stays unregistered, so a wrong restore target can
      // never be re-claimed.
      reattemptRegistration()
      return
    }
    if (desired !== undefined && desired.resumeArgv !== undefined) {
      if (sameSession(pendingSession ?? activeSession ?? lastSession, desired)) return
      pendingSession = desired
      if (active === undefined) advanceQueue()
      return
    }
    if (reportedResumePresent) {
      // No public Herdr command clears only the resume argv: withdraw this
      // source's registration, then re-acquire it with the current facts. Until
      // that withdrawal SUCCEEDS the cleanup stays outstanding, and the cleanup
      // is now the ONLY owed action — a registration attempt remembered from an
      // earlier event must not fire as a self-made retry of the withdrawal.
      pendingSession = undefined
      cleanupRequired = true
      registrationRetryOwed = false
      enqueue({ kind: 'release' })
      return
    }
    if (desired === undefined) {
      pendingSession = undefined
      return
    }
    if (sameSession(pendingSession ?? activeSession ?? lastSession, desired)) return
    pendingSession = desired
    if (active === undefined) advanceQueue()
  }

  /**
   * Reconcile the DESIRED main-Session fact with what was actually DELIVERED,
   * after any real Agent/Session lifecycle event.
   *
   * This is the recovery path for a FAILED `report-agent-session`: the intent
   * leaves `pendingSession` when it is dispatched, so after a failure only this
   * process's own exit-0 record (`lastSession`) proves what Herdr holds. Without
   * this step Herdr keeps the superseded Session's resume command until some
   * unrelated event happens to re-report it.
   *
   * It adds no authority: the desired fact is `latestSession` from the
   * composition and the delivered fact is the local exit-0 record. It never
   * retries by itself — only a real lifecycle event calls it — and it keeps the
   * one-child / `release` > state > Session ordering: a Session is queued and
   * `advanceQueue` dispatches it behind the state registration.
   */
  const reconcileDesiredSession = (): void => {
    if (disposed || !qualified) return
    if (cleanupRequired) {
      // The withdrawal of a possibly-saved target is the owed action: nothing
      // may be claimed until it succeeds.
      reattemptRegistration()
      return
    }
    const desired = latestSession
    // No Session fact of its own means no Session work: an Agent-state dedupe is
    // NOT a reason to re-register the Pane (H1 already owns state delivery).
    if (desired === undefined) return
    if (sameSession(pendingSession ?? activeSession ?? lastSession, desired)) return
    pendingSession = desired
    if (!paneAcknowledged) {
      // The Pane is not held, so the Session cannot be delivered yet: the owed
      // action is the ordered registration, not the Session report.
      reattemptRegistration()
      return
    }
    if (active === undefined) advanceQueue()
  }

  return {
    publish(status) {
      const state = agentStateOf(status)
      if (state === undefined) return
      latest = state
      if (disposed || !qualified) return
      registered = state
      // Dedupe against the queue TAIL, not only the last dispatched state: a
      // 100-flip burst that returns to the state already in flight (or already
      // waiting) has no physical work to do.
      const queued = pendingReport ?? activeState ?? lastDispatched
      if (queued !== state) enqueue({ kind: 'report', state })
      // EVERY real state fact reconciles an owed cleanup or an undelivered
      // Session, whether or not it produced a new state dispatch.
      reconcileDesiredSession()
    },
    observeSession(session) {
      if (disposed) return
      latestSession = session
      if (!qualified) {
        // The last Host generation's Session intent never survives a
        // qualification loss; the CURRENT projection is re-sampled on requalify.
        pendingSession = undefined
        return
      }
      reconcileSession()
      // A new main-owner Session fact is a real lifecycle event: when this
      // registration cycle has no Pane authority yet, it re-attempts the ordered
      // registration (a Session report is illegal before the Pane is held). An
      // outstanding cleanup is NOT retried from here: `reconcileSession` has just
      // dispatched that withdrawal, and this same event must not queue a second
      // attempt behind it.
      if (!paneAcknowledged && !cleanupRequired) reattemptRegistration()
    },
    setQualified(next) {
      if (disposed || qualified === next) return
      qualified = next
      if (!next) {
        // Every per-registration Session fact is void, but an outstanding
        // cleanup obligation is NOT: the resume target may still be saved
        // upstream and only a successful release can withdraw it.
        const hadRegistration = lastDispatched !== undefined || active?.kind === 'report'
        pendingSession = undefined
        paneAcknowledged = false
        lastSession = undefined
        registered = undefined
        // The withdrawn baseline can never dedupe the first report of a later
        // qualification.
        lastDispatched = undefined
        // A withdrawal is owed only when this reporter may have registered the
        // Pane (a dispatched state) or dispatched a resume target.
        if (hadRegistration || reportedResumePresent || cleanupRequired || active !== undefined || pendingRelease) {
          enqueue({ kind: 'release' })
        }
        return
      }
      // Requalification re-registers only the CURRENT facts: the state caller
      // just accepted plus the CURRENT main-owner Session projection. A stale
      // Session from the previous registration can never be replayed.
      paneAcknowledged = false
      lastSession = undefined
      pendingSession = latestSession
      // An outstanding cleanup is not stale: requalification is a real lifecycle
      // event and must finish withdrawing a possibly-saved resume target before
      // the Pane may be registered again.
      if (cleanupRequired) {
        reattemptRegistration()
        return
      }
      if (latest === undefined) return
      registered = latest
      enqueue({ kind: 'report', state: latest })
    },
    dispose() {
      if (disposed) return
      disposed = true
      qualified = false
      pendingSession = undefined
      paneAcknowledged = false
      lastSession = undefined
      // Dispose still owes AT MOST ONE withdrawal: an in-flight or queued
      // release already covers this cleanup, so a second one is never started.
      const releaseCovered = (active !== undefined && active.kind === 'release') || pendingRelease
      const owed = registered !== undefined || reportedResumePresent || cleanupRequired
        || (active !== undefined && !releaseCovered)
      registered = undefined
      if (releaseCovered || !owed) return
      enqueue({ kind: 'release' })
    },
  }
}
