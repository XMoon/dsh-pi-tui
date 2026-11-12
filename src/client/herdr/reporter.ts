/**
 * Herdr pane agent-state reporter (H1).
 *
 * ONE Client-local owner of the `pane report-agent` / `pane release-agent`
 * external IO of the Pane this TUI Client really occupies. It is fed ONLY with
 * the already-derived main-Agent logical status (`TuiApp.effectiveProgramStatus`
 * through the read-only `onProgramStatus` observation) and maps it onto the
 * closed Herdr three-state vocabulary: `idle` / `working` / `blocked`. The
 * non-running `done`/`error` records are Herdr `idle`; a `clear` presentation
 * record is not a business change and is ignored.
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

/** The three states Herdr `pane report-agent --state` accepts. */
export type HerdrAgentState = 'idle' | 'working' | 'blocked'

/**
 * The ONE Client-local reporter. `publish` is synchronous and never throws;
 * the actual CLI work is dispatched in the background.
 */
export interface HerdrReporter {
  /** Observe one already-derived main-Agent logical status. */
  publish(status: ProgramStatus): void
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

/** One queued intent: a state report or the ordered registration withdrawal. */
interface ReportIntent {
  readonly kind: 'report'
  readonly state: HerdrAgentState
}
interface ReleaseIntent {
  readonly kind: 'release'
}
type Intent = ReportIntent | ReleaseIntent

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
  /** The one live child, or `undefined` when the queue is idle. */
  let active: { readonly child: ChildProcess; readonly timer: NodeJS.Timeout } | undefined
  /** At most one newer report waits behind the live child (latest wins). */
  let pendingReport: HerdrAgentState | undefined
  /** The ordered withdrawal barrier: it always precedes a newer report. */
  let pendingRelease = false
  /** The newest `--seq` value this process dispatched. */
  let lastSeq = 0

  /** D6: each ACTUAL dispatch takes `max(last+1, Date.now()*1000)`; reports
   *  and releases share the one sequence. */
  const nextSeq = (): number => {
    lastSeq = Math.max(lastSeq + 1, Date.now() * 1000)
    return lastSeq
  }

  /** Dispatch the next queued intent, if any. A withdrawal always precedes a
   *  newer report, and at most one report is retained (latest wins). */
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
    }
  }

  const finishActive = (): void => {
    const settled = active
    if (settled === undefined) return
    active = undefined
    activeState = undefined
    clearTimeout(settled.timer)
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
      : [
        'pane', 'release-agent', target.paneId,
        '--source', HERDR_SOURCE,
        '--agent', HERDR_AGENT,
        '--seq', String(nextSeq()),
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
      if (code !== 0 && code !== null) diag?.warn('herdr pane report failed', { reason: intent.kind, code })
      finish()
    })
    // The CLI is a short-lived, stdio-detached helper: it must never keep the
    // TUI process alive or block exit.
    child.unref()
    if (intent.kind === 'report') {
      activeState = intent.state
      lastDispatched = intent.state
    } else {
      activeState = undefined
    }
    active = { child, timer }
  }

  const enqueue = (intent: Intent): void => {
    if (intent.kind === 'release') {
      // A withdrawal clears every queued status: an old state must never be
      // written after the registration it belonged to was withdrawn.
      pendingReport = undefined
      if (active === undefined) dispatch(intent)
      else pendingRelease = true
      return
    }
    if (active === undefined) dispatch(intent)
    else pendingReport = intent.state
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
    setQualified(next) {
      if (disposed || qualified === next) return
      qualified = next
      if (!next) {
        // Never withdraw a registration this reporter never started.
        if (registered === undefined) return
        registered = undefined
        // The withdrawn baseline can never dedupe the first report of a later
        // qualification.
        lastDispatched = undefined
        enqueue({ kind: 'release' })
        return
      }
      // Requalification republishes only the CURRENT logical fact: the caller
      // has just accepted a fresh authoritative snapshot, so no older state
      // from the previous qualification is replayed.
      if (latest === undefined) return
      registered = latest
      enqueue({ kind: 'report', state: latest })
    },
    dispose() {
      if (disposed) return
      disposed = true
      qualified = false
      if (registered === undefined) return
      registered = undefined
      enqueue({ kind: 'release' })
    },
  }
}
