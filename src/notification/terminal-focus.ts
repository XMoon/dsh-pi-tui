/**
 * Terminal focus tracking for the completion notification policy (plan
 * §5): the TUI enables terminal focus reporting (`CSI ? 1004 h`) and the
 * tracker consumes the `ESC[I` (focused) / `ESC[O` (unfocused) reports.
 *
 * The state defaults to `focused` — the SAFE assumption: a user who just
 * started/operated the TUI is looking at it, and an unsupported terminal
 * (no focus reporting) must never notify while the user is watching.
 * Only a real `ESC[O` flips the state to `unfocused`; the `unfocused`
 * mode therefore under-notifies on unsupported terminals rather than
 * falsely notifying (plan: default `unfocused` may miss notifications on
 * terminals without focus reporting — `always` is the explicit opt-out).
 *
 * The tracker is a pure state machine: the runner feeds it the focus
 * reports (through the app's `onTerminalFocus` seam) and the controller
 * reads `state` at settle time. It never writes to the terminal itself —
 * the runner owns the `CSI ? 1004 h/l` mode writes.
 * @module @xmoon76/dsh-pi-tui/terminal-focus
 */

/** The terminal focus reports (CSI ? 1004): `ESC[I` = focused,
 * `ESC[O` = unfocused. */
export const FOCUS_IN_SEQUENCE = '\x1b[I'
export const FOCUS_OUT_SEQUENCE = '\x1b[O'

/** Enable terminal focus reporting. */
export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h'
/** Disable terminal focus reporting. */
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'

/** The tracker's focus state. */
export type TerminalFocusState = 'focused' | 'unfocused'

/** Whether one raw input chunk is a terminal focus report. */
export function isFocusReport(data: string): boolean {
  return data === FOCUS_IN_SEQUENCE || data === FOCUS_OUT_SEQUENCE
}

/**
 * The terminal focus state machine. Defaults to `focused`; only a real
 * `ESC[O` report flips to `unfocused`, and `ESC[I` (or an explicit
 * `markFocused()`) restores it.
 */
export class TerminalFocusTracker {
  private _state: TerminalFocusState = 'focused'

  /** The current focus state (defaults to `focused` — the safe
   * assumption on terminals without focus reporting). */
  get state(): TerminalFocusState {
    return this._state
  }

  /** Feed one focus report; returns whether the chunk WAS a focus report
   * (so the caller can consume it). Ordinary input returns false and is
   * left untouched. */
  handleFocusReport(data: string): boolean {
    if (data === FOCUS_IN_SEQUENCE) {
      this._state = 'focused'
      return true
    }
    if (data === FOCUS_OUT_SEQUENCE) {
      this._state = 'unfocused'
      return true
    }
    return false
  }

  /** Defensive restore: any real user interaction may reset the state to
   * focused (a missed FOCUS_IN must not leave the tracker believing the
   * terminal is unfocused). */
  markFocused(): void {
    this._state = 'focused'
  }
}
