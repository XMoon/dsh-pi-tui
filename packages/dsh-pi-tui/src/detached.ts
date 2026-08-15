/**
 * The unified entry point for fire-and-forget async work in the runner.
 * Every detached task gets: rejection capture (zero unhandled rejections),
 * cancellation classification (abort/cancel → debug-level only), a
 * user-notification hook for recoverable failures, and diagnostics that
 * name the task and the live session — never the payload.
 * @module @xmoon76/dsh-pi-tui/detached
 */

import type { Diag } from './diag.ts'

export interface DetachedTaskOptions {
  /** The runner's diagnostics channel (stderr + log file). */
  diag: Diag
  /** Surface a user-recoverable failure (e.g. settings persistence). */
  notify?: (message: string) => void
  /** The live session id, re-read at settle time (for diagnostics). */
  sessionId?: () => string | undefined
  /** Classify a failure as user-recoverable (default: false → warn only). */
  recoverable?: (error: unknown) => boolean
}

/** Whether an error represents an abort/cancel rather than a real failure. */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
}

/**
 * Attach rejection handling to a fire-and-forget task. Every rejection is
 * caught and classified:
 * - cancellation → debug diagnostics only (never a user error);
 * - recoverable (per the options hook) → notify + warn;
 * - anything else → warn.
 * The log line carries the task label and the live session id — never the
 * task payload (no API keys, prompt bodies, or shell output).
 */
export function runDetached(label: string, task: Promise<unknown>, options: DetachedTaskOptions): void {
  void task.catch((error: unknown) => {
    if (isCancellation(error)) {
      options.diag.debug(label, { session: options.sessionId?.(), cancelled: true })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    if (options.recoverable?.(error) === true) {
      options.notify?.(`${label}: ${message}`)
    }
    options.diag.warn(label, { session: options.sessionId?.(), error: message })
  })
}
