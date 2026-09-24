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

/** Create the pre-mount status writer. `isTTY` defaults to true when the
 * output does not declare itself (the runner passes
 * `process.stdout.isTTY` explicitly). */
export function createStartupStatus(output: StartupStatusOutput): StartupStatus {
  const tty = output.isTTY ?? true
  let shown = false
  // TOTAL write, deliberately: the output seam has no never-throws contract and
  // this helper is called from places where a throw is unrecoverable — an
  // `AbortSignal` listener (Node turns a listener exception into an
  // `uncaughtException`) and the terminal startup-failure root (a throw there
  // would skip the logs, the abort, the owner retirement and `exit(1)`). The
  // status is pure presentation and must never outrank the work it narrates;
  // a broken stream therefore leaves the row exactly as it is instead of
  // failing the boot. `shown` keeps the original state semantics: a show marks
  // the line as owned, a clear releases it.
  const write = (text: string): void => {
    try {
      output.write(text)
    } catch {
      // Best effort: a broken status stream is not a startup failure.
    }
  }
  return {
    show(message) {
      if (!tty) return
      write(`${ERASE_LINE}${message}`)
      shown = true
    },
    clear() {
      if (!tty || !shown) return
      write(ERASE_LINE)
      shown = false
    },
  }
}
