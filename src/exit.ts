/**
 * The TUI exit contract: latch the exit request, dispose/restore the Client
 * surface, apply the resume-hint policy, then request the launcher's
 * `appExit`. Pure and injectable so the resolve/reject/hang paths are
 * testable without a Cordis context.
 *
 * Host-owned final durability is NOT this controller's job: the Direct
 * owned-session retirement (cancel → idle → drain descendants → final flush
 * → AgentHandle.dispose) runs inside the application-tree disposal that
 * `appExit` starts, under the DSH process-shutdown watchdog — see
 * `src/runtime/direct/owned-session-retirement.ts` and
 * `docs/concurrency.md`. The exit controller only stops the Client surface
 * and requests the exit; it never awaits a potentially long Host teardown
 * in front of `appExit`. (The former flush-failure warning was removed
 * with the flush: retirement failures are recorded by the retirement
 * diagnostics, not by a user-facing exit warning.)
 *
 * Zero-unhandled guarantee: the exit root is a terminal lifecycle boundary
 * — every step (cleanup, hint, exit) and every error observation is
 * individually protected, so no throw can skip a later step, leak a
 * rejection, or leave the process running with a stopped TUI.
 * @module @xmoon76/dsh-pi-tui/exit
 */

import { safeErrorMessage } from './error-boundary.ts'

/** Diagnostics sink used by the exit controller (subset of Diag). */
export interface ExitDiagLike {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Injectable dependencies of {@link createExitController}. */
export interface ExitControllerDeps {
  /** The runner diagnostics channel. */
  diag: ExitDiagLike
  /** Idempotent Client-surface teardown (abort lifecycle, stop TUI). The
   * Direct owned-session retirement is NOT part of this step — it runs in
   * the application-tree disposal after `exit` (see the module doc). */
  cleanup(): void
  /** Print the resume hint to stdout (after the terminal restores). */
  hint(message: string): void
  /** The interactive-quit resume hint, or undefined without a session. */
  resumeHint(): string | undefined
  /** Process exit (the launcher's `appExit`). */
  exit(code: number): void
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
 * resume-hint policy → request `appExit`. Idempotent: later requests while
 * one is in flight (or after it finished) are no-ops, so double Ctrl+C or a
 * command plus a key cannot double-cleanup or double-exit.
 *
 * TERMINAL ROOT: every step (cleanup, hint, exit) is individually
 * protected, so no throw can skip a later step or leak a rejection, and
 * cleanup/exit always run (exit exactly once, last).
 * @param deps - the injectable surface.
 * @returns `requestExit()` — safe to call from any entry, any number of times.
 */
export function createExitController(deps: ExitControllerDeps): { requestExit(): void } {
  let started = false
  const requestExit = (): void => {
    if (started) return
    started = true
    void (async () => { // allowlist: exit lifecycle root — see AGENTS.md
      // Terminal policy: each step is individually protected so a throw in
      // one can never skip a later step; cleanup and exit are guaranteed
      // (exit runs last, exactly once). The Direct Host retirement runs
      // inside the appExit disposal (see the module doc).
      safeDiag(deps.diag, 'info', 'exit', { code: 0 })
      try {
        deps.cleanup()
      } catch (cleanupError) {
        safeDiag(deps.diag, 'error', 'cleanup failed', { error: safeErrorMessage(cleanupError) })
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
        deps.exit(0)
      } catch {
        // The last step; there is no lower sink.
      }
    })()
  }
  return { requestExit }
}
