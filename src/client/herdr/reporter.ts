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
 *   stderr or environment values.
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
   *  Only a release can withdraw it; it is not a second Session authority. */
  let reportedResumePresent = false
  /** A cleanup release must re-register the Pane and the CURRENT projection. */
  let requeueAfterRelease = false
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

  /** After an ordered withdrawal, a cleanup release must re-register the Pane
   *  with the CURRENT H1 state and then the CURRENT Session projection. */
  const requeueAfterWithdrawal = (): void => {
    if (!requeueAfterRelease) return
    requeueAfterRelease = false
    if (disposed || !qualified) return
    pendingReport = latest
    pendingSession = latestSession
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

  const finishActive = (): void => {
    const settled = active
    if (settled === undefined) return
    active = undefined
    activeState = undefined
    activeSession = undefined
    clearTimeout(settled.timer)
    if (settled.kind === 'release') requeueAfterWithdrawal()
    advanceQueue()
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
      // No child was created, so the queue continues exactly like a settle.
      if (intent.kind === 'release') requeueAfterWithdrawal()
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
      finish()
    })
    child.once('close', (code) => {
      if (settled) return
      if (code !== 0 && code !== null) {
        diag?.warn('herdr pane report failed', { reason: intent.kind, code })
      } else if (code === 0 && intent.kind === 'report') {
        // The Pane is now held by this source: only from here may a Session
        // report follow (Herdr would reject it earlier).
        paneAcknowledged = true
      } else if (code === 0 && intent.kind === 'session') {
        lastSession = intent.session
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
      // A dispatched resume argv may already be persisted by Herdr: only an
      // ordered release can withdraw it from this process's point of view.
      if (intent.session.resumeArgv !== undefined) reportedResumePresent = true
    } else {
      activeState = undefined
      // The registration (and any saved resume target) is being withdrawn.
      reportedResumePresent = false
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
    if (active === undefined) dispatch(intent)
    else pendingReport = intent.state
  }

  /** Queue the CURRENT Session fact from the retained desired projection.
   *  A Session target without a recoverable resume argv can only replace an
   *  older resume target through Herdr's ordered release -> re-register cycle. */
  const reconcileSession = (): void => {
    const desired = latestSession
    if (desired !== undefined && desired.resumeArgv !== undefined) {
      if (sameSession(pendingSession ?? activeSession ?? lastSession, desired)) return
      pendingSession = desired
      if (active === undefined) advanceQueue()
      return
    }
    if (reportedResumePresent) {
      // No public Herdr command clears only the resume argv: withdraw this
      // source's registration, then re-acquire it with the current facts.
      pendingSession = undefined
      requeueAfterRelease = true
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
      if (queued === state) return
      enqueue({ kind: 'report', state })
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
    },
    setQualified(next) {
      if (disposed || qualified === next) return
      qualified = next
      if (!next) {
        // Never withdraw a registration this reporter never started, but every
        // per-registration Session fact is already void.
        pendingSession = undefined
        requeueAfterRelease = false
        paneAcknowledged = false
        lastSession = undefined
        if (registered === undefined) return
        registered = undefined
        // The withdrawn baseline can never dedupe the first report of a later
        // qualification.
        lastDispatched = undefined
        enqueue({ kind: 'release' })
        return
      }
      // Requalification re-registers only the CURRENT facts: the state caller
      // just accepted plus the CURRENT main-owner Session projection. A stale
      // Session from the previous registration can never be replayed.
      paneAcknowledged = false
      lastSession = undefined
      pendingSession = latestSession
      if (latest === undefined) return
      registered = latest
      enqueue({ kind: 'report', state: latest })
    },
    dispose() {
      if (disposed) return
      disposed = true
      qualified = false
      pendingSession = undefined
      requeueAfterRelease = false
      paneAcknowledged = false
      lastSession = undefined
      if (registered === undefined) return
      registered = undefined
      enqueue({ kind: 'release' })
    },
  }
}
