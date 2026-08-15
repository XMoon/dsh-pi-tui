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
