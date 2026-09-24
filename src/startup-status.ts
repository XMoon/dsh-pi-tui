/**
 * Pre-mount startup status: a single-line, TTY-only progress hint shown
 * while the runner waits BEFORE the TUI mounts (the explicit session
 * resume path). Pure presentation — it never owns session lifecycle
 * state, never starts timers, never touches the alt screen, and never
 * appends permanent scrollback.
 *
 * The line strategy is CR + erase-current-line: every `show` overwrites
 * the previous status in place, and `clear` erases the line entirely, so
 * a successful mount leaves no stale text behind. Non-TTY output is
 * silent (a pipe / CI must not be polluted).
 *
 * FAILURE CONTRACT (deliberately narrow: the output seam has no
 * never-throws guarantee):
 * - A write exception can never escape — `show`/`clear` are total — so no
 *   status write can skip a caller's logs, the lifecycle abort, the owner
 *   retirement or `exit(1)`.
 * - `clear()` finishes its attempts BEFORE it returns, so a "clear the status,
 *   then log" call site orders the erase ahead of its own log line, and one
 *   immediate retry absorbs a one-off write failure.
 * - Once those attempts are exhausted this instance stops writing for good: it
 *   never touches the shared cursor again, so a LATER clear cannot erase a log
 *   line that was written after the give-up.
 * - NOT guaranteed: physically erasing a persistently broken stream. A bounded
 *   retry cannot do that, and the cosmetic residue is preferable to damaging
 *   error output. `write()` returning false (backpressure) is not a failure,
 *   and a non-throwing write does not by itself prove the bytes reached the
 *   screen.
 * @module @xmoon76/dsh-pi-tui/startup-status
 */

/** The output seam the status writes through (injectable for tests). */
export interface StartupStatusOutput {
  /** Whether the output is an interactive terminal; false = silent. */
  readonly isTTY?: boolean
  write(text: string): unknown
}

/** The pre-mount status surface. */
export interface StartupStatus {
  /** Overwrite the current line with the message (CR + erase-line). */
  show(message: string): void
  /** Erase the status line (idempotent; no-op when nothing was shown). */
  clear(): void
}

/** The erase-current-line sequence (EL) used to overwrite in place. */
const ERASE_LINE = '\r\x1b[2K'

/** Erase attempts one `clear` makes before this instance gives up on the
 * stream: the original attempt plus ONE immediate retry. That is exactly the
 * one-off write failure the clear-then-log ordering must survive — it is NOT a
 * general I/O recovery policy, so it is deliberately a constant. */
const CLEAR_ATTEMPTS = 2

/** Create the pre-mount status writer. `isTTY` defaults to true when the
 * output does not declare itself (the runner passes
 * `process.stdout.isTTY` explicitly). */
export function createStartupStatus(output: StartupStatusOutput): StartupStatus {
  const tty = output.isTTY ?? true
  let shown = false
  // Terminal for this instance once the bounded erase attempts are exhausted:
  // the stream is treated as unusable and the shared cursor is left alone from
  // then on, so no later clear can erase a line this helper no longer owns.
  let disabled = false
  // TOTAL write, deliberately: the output seam is called from places where a
  // throw is unrecoverable — an `AbortSignal` listener (Node turns a listener
  // exception into an `uncaughtException`) and the terminal startup-failure
  // root (a throw there would skip the logs, the abort, the owner retirement
  // and `exit(1)`). The status is pure presentation and must never outrank the
  // work it narrates. The boolean says whether the text actually LANDED, which
  // is what decides ownership (see `clear`).
  const write = (text: string): boolean => {
    try {
      output.write(text)
      return true
    } catch {
      // Best effort: a broken status stream is not a startup failure.
      return false
    }
  }
  return {
    show(message) {
      if (!tty || disabled) return
      // Ownership is claimed by ATTEMPTING a show, even if that write failed:
      // the terminal may hold partial text, so a later clear must still try to
      // release the row.
      write(`${ERASE_LINE}${message}`)
      shown = true
    },
    clear() {
      if (!tty || !shown || disabled) return
      // Release ownership only when the erase LANDS; give up on the stream
      // after the bounded attempts so a later clear cannot touch a log line.
      for (let attempt = 0; attempt < CLEAR_ATTEMPTS && shown; attempt += 1) {
        if (write(ERASE_LINE)) {
          shown = false
          return
        }
      }
      disabled = true
    },
  }
}
