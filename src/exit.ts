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
 * `docs/concurrency.md`. The exit controller may invoke ONE injected
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
export function createExitController(deps: ExitControllerDeps): { requestExit(): void } {
  let started = false
  const requestExit = (): void => {
    if (started) return
    started = true
    void (async () => { // allowlist: exit lifecycle root — see AGENTS.md
      // Terminal policy: each step is individually protected so a throw in
      // one can never skip a later step; cleanup and exit are guaranteed
      // (exit runs last, exactly once). The full Direct Host retirement runs
      // inside the appExit disposal (see the module doc).
      safeDiag(deps.diag, 'info', 'exit', { code: 0 })
      try {
        deps.cleanup()
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
