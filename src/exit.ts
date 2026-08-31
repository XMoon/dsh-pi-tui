/**
 * The TUI exit contract: flush the live session with a HARD timeout, record
 * the outcome, then let the runner tear down. Pure and injectable so the
 * resolve/reject/hang paths are testable without a Cordis context.
 *
 * Zero-unhandled guarantee: the exit root is a terminal lifecycle boundary
 * — every dependency read (`session()`), every step (flush, diagnostics,
 * cleanup, warn, hint, exit) and every error observation is individually
 * protected, so no throw can skip a later step, leak a rejection, or leave
 * the process running with a stopped TUI.
 * @module @xmoon76/dsh-pi-tui/exit
 */

import { safeErrorMessage } from './error-boundary.ts'

export type FlushOutcome =
  | { kind: 'ok'; tookMs: number }
  | { kind: 'failed'; error: string; tookMs: number }
  | { kind: 'timed-out'; tookMs: number }

/** Elapsed time without ever throwing (an injectable hostile clock
 * degrades to 0 rather than breaking the flush state machine). */
function elapsed(now: () => number, started: number): number {
  try {
    return now() - started
  } catch {
    return 0
  }
}

/**
 * Flush the session but never wait forever: a flush that exceeds `timeoutMs`
 * resolves `timed-out` so the exit can proceed (a hung provider must not
 * trap the user in the TUI). The timer is unref'd and cleared on settle, so
 * it never holds the process open.
 *
 * The failure branch RETURNS a `FlushOutcome` (never a possibly-skipped
 * `finish()` side effect): a hostile thrown value yields a deterministic
 * `failed` outcome immediately, `timed-out` is never misreported for a real
 * failure, the disabled-timeout path always settles, and no internal chain
 * is ever left unobserved.
 * @param flush - the durable flush (e.g. `sessions.flush`).
 * @param timeoutMs - hard timeout; 0 or negative disables the timeout.
 * @param now - injectable clock.
 */
export function flushWithTimeout(
  flush: () => Promise<unknown>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<FlushOutcome> {
  let started = 0
  try {
    started = now()
  } catch {
    // A hostile injectable clock degrades to 0; it must not break the
    // flush state machine.
  }
  // The flush outcome is a REAL value the chain resolves with — its
  // failure branch cannot throw (safe description + safe clock), so this
  // promise never rejects and is always safe to observe.
  const flushOutcome = Promise.resolve()
    .then(flush)
    .then(() => ({ kind: 'ok' as const, tookMs: elapsed(now, started) }))
    .catch((error: unknown) => ({
      kind: 'failed' as const,
      error: safeErrorMessage(error),
      tookMs: elapsed(now, started),
    }))
  return new Promise<FlushOutcome>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (outcome: FlushOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ kind: 'timed-out', tookMs: elapsed(now, started) }), timeoutMs)
      timer.unref?.()
    }
    // flushOutcome never rejects (see above), so this observation can
    // never produce an unhandled rejection.
    void flushOutcome.then(finish) // allowlist: exit-root terminal observation — see AGENTS.md
  })
}

/** The live session the exit flush targets; undefined when none was created. */
export interface ExitSessionLike {
  readonly id: string
  readonly events: { readonly length: number }
}

/** Diagnostics sink used by the exit controller (subset of Diag). */
export interface ExitDiagLike {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Injectable dependencies of {@link createExitController}. */
export interface ExitControllerDeps {
  /** The session to flush, re-read at request time (never created lazily). */
  session(): ExitSessionLike | undefined
  /** The durable flush (e.g. `sessions.flush`). */
  flush(session: ExitSessionLike): Promise<unknown>
  /** Hard flush timeout; 0 or negative disables it. */
  timeoutMs: number
  /** The runner diagnostics channel. */
  diag: ExitDiagLike
  /** Idempotent teardown (abort lifecycle, stop TUI, close diag). */
  cleanup(): void
  /** Print a user-visible warning to stderr (after the terminal restores). */
  warn(message: string): void
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
 * `/exit`, `/quit`): invalidate nothing here (runner-owned state is the
 * runner's concern) — flush with a hard timeout → record → cleanup → warn on a
 * failed/timed-out flush → print the resume hint → exit. Idempotent: later
 * requests while one is in flight (or after it finished) are no-ops, so
 * double Ctrl+C or a command plus a key cannot double-flush or double-exit.
 * A flush that hangs can never trap the process; an unexpected internal
 * error still exits (code 1) instead of leaving the TUI stopped forever.
 *
 * TERMINAL ROOT: the whole body — including `session()`, which sits inside
 * the try — plus every later step (cleanup, warn, hint, exit) is
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
      let flushOutcome: FlushOutcome | undefined
      let failed = false
      try {
        // `session()` is INSIDE the protection: a throwing dependency read
        // must not leak from the discarded IIFE (no cleanup, no exit).
        const exitSession = deps.session()
        if (exitSession !== undefined) {
          flushOutcome = await flushWithTimeout(() => deps.flush(exitSession), deps.timeoutMs)
          safeDiag(deps.diag, 'info', 'flush', {
            session: exitSession.id,
            outcome: flushOutcome.kind,
            tookMs: flushOutcome.tookMs,
            events: exitSession.events.length,
            ...flushOutcome.kind === 'failed' ? { error: flushOutcome.error } : {},
          })
        }
      } catch (error) {
        // Defensive: an unexpected failure in the orchestration itself must
        // not leave the process running with a stopped TUI.
        failed = true
        safeDiag(deps.diag, 'error', 'exit orchestration failed', { error: safeErrorMessage(error) })
      }
      // Terminal policy, OUTSIDE the try: each step is individually
      // protected so a throw in one can never skip a later step; cleanup
      // and exit are guaranteed (exit runs last, exactly once).
      safeDiag(deps.diag, 'info', 'exit', { code: failed ? 1 : 0, flush: flushOutcome?.kind })
      try {
        deps.cleanup()
      } catch (cleanupError) {
        safeDiag(deps.diag, 'error', 'cleanup failed', { error: safeErrorMessage(cleanupError) })
      }
      // A failed or timed-out flush is surfaced AFTER the terminal
      // restores, where the user can actually read it. The process still
      // exits.
      if (!failed && flushOutcome !== undefined && flushOutcome.kind !== 'ok') {
        const reason = flushOutcome.kind === 'timed-out'
          ? 'timed out'
          : `failed (${flushOutcome.error})`
        try {
          deps.warn(`session flush ${reason} — the latest events may not be persisted`)
        } catch {
          // A throwing warn cannot skip the exit.
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
        deps.exit(failed ? 1 : 0)
      } catch {
        // The last step; there is no lower sink.
      }
    })()
  }
  return { requestExit }
}
