/**
 * The TUI exit contract: flush the live session with a HARD timeout, record
 * the outcome, then let the runner tear down. Pure and injectable so the
 * resolve/reject/hang paths are testable without a Cordis context.
 * @module @xmoon76/dsh-pi-tui/exit
 */

export type FlushOutcome =
  | { kind: 'ok'; tookMs: number }
  | { kind: 'failed'; error: string; tookMs: number }
  | { kind: 'timed-out'; tookMs: number }

/**
 * Flush the session but never wait forever: a flush that exceeds `timeoutMs`
 * resolves `timed-out` so the exit can proceed (a hung provider must not
 * trap the user in the TUI). The timer is unref'd and cleared on settle, so
 * it never holds the process open.
 * @param flush - the durable flush (e.g. `sessions.flush`).
 * @param timeoutMs - hard timeout; 0 or negative disables the timeout.
 * @param now - injectable clock.
 */
export function flushWithTimeout(
  flush: () => Promise<unknown>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<FlushOutcome> {
  return new Promise<FlushOutcome>((resolve) => {
    const started = now()
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (outcome: FlushOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ kind: 'timed-out', tookMs: now() - started }), timeoutMs)
      timer.unref?.()
    }
    Promise.resolve()
      .then(flush)
      .then(() => finish({ kind: 'ok', tookMs: now() - started }))
      .catch((error: unknown) => finish({
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
        tookMs: now() - started,
      }))
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

/**
 * The ONE exit orchestration shared by every exit entry (Ctrl+C, Ctrl+D,
 * `/exit`, `/quit`): invalidate nothing here (the guard token is the runner's
 * concern) — flush with a hard timeout → record → cleanup → warn on a
 * failed/timed-out flush → print the resume hint → exit. Idempotent: later
 * requests while one is in flight (or after it finished) are no-ops, so
 * double Ctrl+C or a command plus a key cannot double-flush or double-exit.
 * A flush that hangs can never trap the process; an unexpected internal
 * error still exits (code 1) instead of leaving the TUI stopped forever.
 * @param deps - the injectable surface.
 * @returns `requestExit()` — safe to call from any entry, any number of times.
 */
export function createExitController(deps: ExitControllerDeps): { requestExit(): void } {
  let started = false
  const requestExit = (): void => {
    if (started) return
    started = true
    void (async () => {
      let flushOutcome: FlushOutcome | undefined
      const exitSession = deps.session()
      try {
        if (exitSession !== undefined) {
          flushOutcome = await flushWithTimeout(() => deps.flush(exitSession), deps.timeoutMs)
          deps.diag.info('flush', {
            session: exitSession.id,
            outcome: flushOutcome.kind,
            tookMs: flushOutcome.tookMs,
            events: exitSession.events.length,
            ...flushOutcome.kind === 'failed' ? { error: flushOutcome.error } : {},
          })
        }
        deps.diag.info('exit', { code: 0, flush: flushOutcome?.kind })
        deps.cleanup()
        // A failed or timed-out flush is surfaced AFTER the terminal
        // restores, where the user can actually read it. The process still
        // exits.
        if (flushOutcome !== undefined && flushOutcome.kind !== 'ok') {
          const reason = flushOutcome.kind === 'timed-out'
            ? 'timed out'
            : `failed (${flushOutcome.error})`
          deps.warn(`session flush ${reason} — the latest events may not be persisted`)
        }
        // pi parity: after the terminal restores, print how to re-enter the
        // session (skipped when the deferred start never made one).
        const resume = deps.resumeHint()
        if (resume !== undefined) deps.hint(resume)
        deps.exit(0)
      } catch (error) {
        // Defensive: an unexpected failure in the orchestration itself must
        // not leave the process running with a stopped TUI.
        deps.diag.error('exit orchestration failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        deps.cleanup()
        deps.exit(1)
      }
    })()
  }
  return { requestExit }
}
