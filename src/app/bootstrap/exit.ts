/**
 * The TUI exit contract: latch the exit request, dispose/restore the Client
 * surface, run one synchronous Host-retirement preparation hook, apply the
 * resume-hint policy, then request the launcher's `appExit`. Pure and
 * injectable so the resolve/reject/hang paths are testable without a Cordis
 * context.
 *
 * Host-owned final durability is NOT this controller's job: the Direct
 * owned-session retirement (cancel → idle → drain descendants → final flush
 * → AgentHandle.dispose) runs inside the application-tree disposal that
 * `appExit` starts, under the DSH process-shutdown watchdog — see
 * `src/runtime/direct/owned-session-retirement.ts` and
 * `docs/architecture/concurrency.md`. The exit controller may invoke ONE injected
 * synchronous Host-retirement preparation hook (the Direct owner's first
 * cancel, so it lands before the root teardown unregisters the inbox
 * projection), but it NEVER awaits full Host retirement in front of
 * `appExit`. (The former flush-failure warning was removed with the flush:
 * retirement failures are recorded by the retirement diagnostics, not by a
 * user-facing exit warning.)
 *
 * Zero-unhandled guarantee: the exit root is a terminal lifecycle boundary
 * — every step (cleanup, preparation, hint, exit) and every error
 * observation is individually protected, so no throw can skip a later step,
 * leak a rejection, or leave the process running with a stopped TUI.
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/exit
 */

import { safeErrorMessage } from '../../runtime/process/errors.ts'

/**
 * The fixed daemon-Client detach block printed AFTER the terminal restores.
 * It states only what this Client can observe: the Host was not stopped by this
 * action, the REAL effective profile and Session (when one exists) and the
 * management commands. It never claims a Host state, PID or Turn outcome.
 * @param facts - the exact profile/session facts and the verified-stop flag.
 * @returns the complete multi-line hint.
 */
export function formatDaemonDetachHint(facts: {
  readonly profile: string
  readonly sessionId: string
  readonly workStopped: boolean
  /**
   * Whether the resume command must carry `DSH_PI_TUI_BACKEND=daemon`. A
   * temporary environment override is NOT persisted in the Profile, so a plain
   * `dsh --profile ... --session ...` would select the Profile's (possibly
   * Direct) backend on the next launch instead of reconnecting to this daemon.
   */
  readonly backendOverride?: boolean
  /**
   * M6 UX PR2: the outcome of the ONE explicit whole-Host stop. `confirmed`
   * replaces the ordinary "not stopped" line; `unconfirmed` keeps that line and
   * adds the truthful refusal. It is NEVER folded into `workStopped` (which
   * only ever proves one Session Turn).
   */
  readonly hostStop?: { readonly confirmed: boolean; readonly detail?: string }
}): string {
  const profile = shellQuote(facts.profile)
  const lines = [
    'Disconnected from dsh-pi-tui (daemon client).',
    ...(facts.hostStop?.confirmed === true
      ? ['Daemon Host stopped for this Profile.']
      : facts.hostStop?.confirmed === false
        // An unconfirmed stop (refusal/timeout/unknown) is NOT a proven
        // "not stopped": say exactly that, and never the ordinary detach line.
        ? [
            `Daemon Host stop was not confirmed${facts.hostStop.detail === undefined ? '' : `: ${facts.hostStop.detail}`}`,
            'The daemon Host state is unconfirmed; check it with `daemon status` before resuming.',
          ]
        : ['The daemon Host was not stopped by this action.']),
    ...(facts.workStopped ? ['Current work: stopped.'] : []),
  ]
  const sessionId = facts.sessionId.trim()
  if (sessionId !== '') {
    const backend = facts.backendOverride === true ? 'DSH_PI_TUI_BACKEND=daemon ' : ''
    lines.push('', 'Resume this session:', `  ${backend}dsh --profile ${profile} --session ${shellQuote(sessionId)}`)
  }
  lines.push(
    '',
    'Manage the daemon:',
    `  dsh --profile ${profile} daemon status`,
    `  dsh --profile ${profile} daemon logs`,
    `  dsh --profile ${profile} daemon stop`,
  )
  return lines.join('\n')
}

/**
 * Whether the daemon resume hint must pin `DSH_PI_TUI_BACKEND=daemon`.
 *
 * The hint answers "how do I get back to the daemon Host this Client left", so
 * it must NOT be derived from the synced config mirror: that is last-known and
 * may be stale while another Client's write notification is still in flight.
 *
 * - ordinary detach / Leave (no Stop verdict): pin daemon explicitly — the old
 *   Host is the one this Client was attached to;
 * - confirmed stop: the Host is proven gone, so the next launch follows the
 *   persisted Profile and is never forced back to daemon;
 * - unconfirmed stop: the Host state is UNKNOWN, so the hint must not pretend
 *   the old Host is resumable; it follows the Profile and points at the real
 *   `daemon status` check.
 * @param hostStop - the ONE authoritative Host-stop outcome of this exit.
 * @returns true when the resume command needs `DSH_PI_TUI_BACKEND=daemon`.
 */
export function daemonResumeBackendOverride(
  hostStop?: { readonly confirmed: boolean },
): boolean {
  return hostStop === undefined
}

/** POSIX-safe single-argument quoting for a copy-paste shell hint. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Diagnostics sink used by the exit controller (subset of Diag). */
export interface ExitDiagLike {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Injectable dependencies of {@link createExitController}. */
export interface ExitControllerDeps {
  /** The runner diagnostics channel. */
  diag: ExitDiagLike
  /**
   * Idempotent Client-surface teardown (abort lifecycle, stop TUI). The
   * Direct owned-session retirement is NOT part of this step — it runs in
   * the application-tree disposal after `exit` (see the module doc).
   *
   * PR3-A: may return a promise — the ONE renderer-release promise (the SDK
   * tty restore on the TSP branch). It is AWAITED before the retirement
   * preparation, the resume hint and `appExit`, so no exit byte or successor
   * renderer can race the terminal still owned by the previous renderer. A
   * rejection is recorded and never skips a later step.
   */
  cleanup(): void | Promise<void>
  /**
   * Synchronous Direct-host retirement preparation, invoked after `cleanup`
   * and before the resume hint / `appExit`. It must NOT await the full Host
   * teardown (no `whenIdle`, no descendant drain, no flush, no handle
   * dispose): the only thing brought forward is the current owner's first
   * cancel. A throw is contained and never blocks `appExit`.
   */
  prepareRetirement?(): void
  /** Print the resume hint to stdout (after the terminal restores). */
  hint(message: string): void
  /** The interactive-quit resume hint, or undefined without a session. */
  resumeHint(): string | undefined
  /** Process exit (the launcher's `appExit`). */
  exit(code: number): void
  /**
   * M6 UX PR2 (F3): the SAME selected-runtime Remote transport owner the
   * runner's teardown already uses. On the ONE explicit whole-Host Stop path
   * it is released AFTER the terminal restore and BEFORE {@link adminStop}:
   * the Host's graceful shutdown otherwise waits for THIS Client's still-open
   * Remote transport while the Client waits for the Host PID, a mutual wait
   * that can only time out. Idempotent; the runner's later teardown reuses the
   * same memoized owner. Never called for Leave/Stay/ordinary exits.
   */
  releaseTransport?(): Promise<void>
  /**
   * M6 UX PR2 (RFL-017): the ONE authoritative whole-Host stop outcome that
   * drove this exit, including the local refusals that never reached the
   * control plane (unproven terminal restore, no admin capability). The hint
   * consumes THIS result, so a refused Stop can never read as an ordinary
   * Leave. Called at most once and only when a Stop verdict was committed.
   */
  hostStopOutcome?(outcome: { readonly confirmed: boolean; readonly detail?: string }): void
  /**
   * M6 UX PR2 (N1): whether the ONE teardown PROVED the terminal restored.
   * The confirmed whole-Host Stop is a destructive admin action, so it runs
   * only when the TTY-release half of the teardown succeeded; an unproven or
   * failed release refuses the stop and keeps the exit non-zero instead of
   * driving a Host stop behind a renderer that still owns the terminal.
   * `undefined` means the composition could not observe the release at all.
   */
  rendererReleased?(): 'released' | 'failed' | undefined
  /**
   * M6 UX PR2: the ONE explicit whole-Host stop, run ONLY when the exit
   * carries the confirmed `hostStopRequested` verdict. It runs AFTER the
   * terminal restore and BEFORE the hint/`appExit`, exactly once, and it owns
   * the admin lifetime independently of the surface: the caller supplies the
   * profile-bound control plane. The result is the existing control plane's
   * own result (code 0 = proven stopped; 3/4/5 = the stable refusal classes).
   */
  adminStop?: () => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>
}

/** Best-effort diagnostics write: a throwing diag can never break the
 * exit state machine. */
function safeDiag(diag: ExitDiagLike, level: 'info' | 'error', message: string, fields?: Record<string, unknown>): void {
  try {
    if (level === 'info') diag.info(message, fields)
    else diag.error(message, fields)
  } catch {
    // No lower sink.
  }
}

/**
 * The ONE exit orchestration shared by every exit entry (Ctrl+C, Ctrl+D,
 * `/exit`, `/quit`): latch once → dispose/restore the Client surface →
 * synchronous Host-retirement preparation → resume-hint policy → request
 * `appExit`. Idempotent: later requests while one is in flight (or after it
 * finished) are no-ops, so double Ctrl+C or a command plus a key cannot
 * double-cleanup or double-exit.
 *
 * TERMINAL ROOT: every step (cleanup, preparation, hint, exit) is
 * individually protected, so no throw can skip a later step or leak a
 * rejection, and cleanup/exit always run (exit exactly once, last).
 * @param deps - the injectable surface.
 * @returns `requestExit()` — safe to call from any entry, any number of times.
 */
export function createExitController(deps: ExitControllerDeps): {
  requestExit(options?: { readonly hostStopRequested?: boolean }): void
} {
  let started = false
  const requestExit = (options?: { readonly hostStopRequested?: boolean }): void => {
    if (started) return
    started = true
    // The ONE explicit whole-Host stop verdict, captured at the latch: a later
    // request can never add or revoke it, and the admin stop runs at most once.
    const hostStopRequested = options?.hostStopRequested === true
    void (async () => { // allowlist: exit lifecycle root — see AGENTS.md
      // Terminal policy: each step is individually protected so a throw in
      // one can never skip a later step; cleanup and exit are guaranteed
      // (exit runs last, exactly once). The full Direct Host retirement runs
      // inside the appExit disposal (see the module doc).
      safeDiag(deps.diag, 'info', 'exit', { code: 0 })
      try {
        // PR3-A: AWAIT the renderer release (a no-op on PiTui) so the tty is
        // restored before the hint/appExit; a rejection lands in the same
        // recorded, non-truncating step.
        await deps.cleanup()
      } catch (cleanupError) {
        safeDiag(deps.diag, 'error', 'cleanup failed', { error: safeErrorMessage(cleanupError) })
      }
      // The Direct owner's FIRST cancel is synchronous and must land before
      // the root teardown unregisters the inbox projection. A failing
      // preparation is recorded and never blocks the exit: the full
      // retirement inside the appExit disposal retries the cancel.
      try {
        deps.prepareRetirement?.()
      } catch (preparationError) {
        safeDiag(deps.diag, 'error', 'retirement preparation failed', { error: safeErrorMessage(preparationError) })
      }
      // M6 UX PR2 (F3): on the ONE explicit Stop path release the selected
      // runtime's Remote transport AFTER the terminal restore and BEFORE the
      // control plane. The connected Client's own `daemon stop` otherwise
      // races the Host's graceful shutdown: the Host waits for this Client's
      // transport while the Client waits for the Host PID. The release is the
      // SAME memoized owner the runner teardown uses. A failure is recorded
      // and never assumed to mean the connection is gone; the control plane's
      // own post-proof stays the only success source.
      let transportReleaseError: string | undefined
      if (hostStopRequested && deps.releaseTransport !== undefined) {
        try {
          await deps.releaseTransport()
          safeDiag(deps.diag, 'info', 'remote transport released before the daemon host stop')
        } catch (releaseError) {
          transportReleaseError = safeErrorMessage(releaseError)
          safeDiag(deps.diag, 'error', 'remote transport release failed before the daemon host stop', { error: transportReleaseError })
        }
      }
      // M6 UX PR2: the ONE explicit whole-Host stop, ONLY for a confirmed
      // verdict. It runs after the terminal is restored and before the hint,
      // so the summary is truthful and the exit code reflects the control
      // plane's own result. An unexpected throw is the manager/OS failure
      // class (4): the Client still exits, never claiming success.
      let hostStop: { readonly code: number; readonly detail?: string } | undefined
      // N1: a destructive Host stop may only follow a PROVEN terminal restore.
      // A teardown whose TTY-release half failed or never settled is not a
      // permission to stop a shared Host, and it must not be reported as one.
      const releaseVerdict = hostStopRequested ? deps.rendererReleased?.() : undefined
      if (hostStopRequested && deps.rendererReleased !== undefined && releaseVerdict !== 'released') {
        hostStop = {
          code: 4,
          detail: releaseVerdict === 'failed'
            ? 'the terminal was not restored, so this Client did not run the Host stop'
            : 'the terminal restore was not proven, so this Client did not run the Host stop',
        }
        safeDiag(deps.diag, 'error', 'daemon host stop refused: the terminal restore was not proven', {
          outcome: releaseVerdict ?? 'not-observed',
        })
      } else if (hostStopRequested) {
        if (deps.adminStop === undefined) {
          // A confirmed Stop verdict with no admin capability is NOT a success:
          // report the unconfirmed result and a non-zero exit (the manager/OS
          // failure class), never a silent exit 0.
          hostStop = { code: 4, detail: 'the daemon administration capability is unavailable' }
        } else {
          try {
            const result = await deps.adminStop()
            const refusal = adminStopDetail(result)
            hostStop = result.code === 0
              ? { code: 0 }
              : {
                  code: result.code,
                  detail: transportReleaseError === undefined
                    ? refusal
                    : `${refusal} (the Client transport release also failed: ${transportReleaseError})`,
                }
          } catch (adminError) {
            safeDiag(deps.diag, 'error', 'daemon host stop failed', { error: safeErrorMessage(adminError) })
            hostStop = { code: 4, detail: 'the management call failed before the control plane reported a result' }
          }
        }
      }
      // RFL-017: publish the ONE Host Stop outcome (0, refusal, or local
      // refusal) before the hint reads it. A throwing sink must never skip the
      // hint/exit steps.
      if (hostStop !== undefined) {
        try {
          deps.hostStopOutcome?.({ confirmed: hostStop.code === 0, ...(hostStop.detail === undefined ? {} : { detail: hostStop.detail }) })
        } catch {
          // No lower sink.
        }
      }
      // pi parity: after the terminal restores, print how to re-enter the
      // session (skipped when the deferred start never made one).
      try {
        const resume = deps.resumeHint()
        if (resume !== undefined) deps.hint(resume)
      } catch {
        // A throwing hint cannot skip the exit.
      }
      try {
        deps.exit(hostStop?.code ?? 0)
      } catch {
        // The last step; there is no lower sink.
      }
    })()
  }
  return { requestExit }
}

/**
 * The safe one-line refusal summary for a failed whole-Host stop: the control
 * plane already sanitizes its stderr (no argv, cookie, private path or secret),
 * so its first line is the stable reason the terminal may show.
 */
function adminStopDetail(result: { readonly stderr: string }): string {
  const line = result.stderr.split('\n').map(part => part.trim()).find(part => part !== '')
  return line === undefined || line === '' ? 'the stop could not be confirmed' : line
}
