/**
 * Pre-mount startup status: a single-line, TTY-only progress hint shown
 * while the runner waits BEFORE the TUI mounts (the explicit session
 * resume path). Pure presentation — it never owns session lifecycle
 * state, never starts timers, never touches the alt screen, and never
 * appends permanent scrollback.
 *
 * The line strategy is CR + erase-current-line: every `show` overwrites
 * the previous status in place, and `clear` erases the line entirely, so
 * a successful mount leaves no stale text behind. Writes are TOTAL (a throwing
 * output seam can never fail the boot or escape an abort listener), and a clear
 * that did not land keeps the row owned so a later clear retries it. Non-TTY
 * output is silent (a pipe / CI must not be polluted).
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
  // status is pure presentation and must never outrank the work it narrates.
  // The boolean says whether the text actually LANDED, which is what decides
  // ownership: see `clear` below.
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
      if (!tty) return
      // Ownership is claimed by ATTEMPTING a show, even if that write failed:
      // the terminal may hold partial text, so a later clear must still try to
      // release the row.
      write(`${ERASE_LINE}${message}`)
      shown = true
    },
    clear() {
      if (!tty || !shown) return
      // Ownership is released only when the erase LANDED. A failed erase keeps
      // the row owned, so the next clear — the terminal fatal root, or the
      // mount-time clear — retries it instead of leaving stale status text on
      // screen.
      if (write(ERASE_LINE)) shown = false
    },
  }
}
