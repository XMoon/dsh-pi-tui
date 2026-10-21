/**
 * The composition's ONE physical-terminal output gate.
 *
 * The application layer never owns the terminal. Whoever took it — the PiTui
 * `ProcessTerminal`, or the TSP SDK session — owns every byte on stdout, so the
 * three application-side terminal writers must be gated by ONE policy instead of
 * scattering `if (tsp)` through the owners:
 *
 * - the window title (`OSC 0`, `tui/terminal/title.ts`),
 * - the completion notification (`OSC 9` / `OSC 777`, the notification
 *   presentation's writer),
 * - the focus-reporting mode (`CSI ? 1004 h/l`, the same presentation: the exit
 *   cleanup disables the mode through it).
 *
 * The composition arms this gate from the renderer decision: suspended while a
 * TSP attempt is in flight (the connector owns the tty from the moment it
 * starts), resumed only when the SDK honestly declined and PiTui takes over —
 * the unchanged default.
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/terminal-output
 */

/** The ONE gate for the application-side terminal writers. */
export interface TerminalOutputGate {
  /** A TSP attempt owns the tty: application-side terminal writes are suspended. */
  suspend(): void
  /** PiTui owns the tty (the unchanged default): application-side writes resume. */
  resume(): void
  /** Whether the application may write terminal control sequences right now. */
  applicationOwnsTerminal(): boolean
}

/** Create the gate. It starts permissive: PiTui is the default owner. */
export function createTerminalOutputGate(): TerminalOutputGate {
  let suspended = false
  return {
    suspend: () => { suspended = true },
    resume: () => { suspended = false },
    applicationOwnsTerminal: () => !suspended,
  }
}
