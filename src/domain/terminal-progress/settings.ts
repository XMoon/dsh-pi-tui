/**
 * Terminal-progress preference parsing and settled-outcome vocabulary.
 *
 * The persisted TUI settings document carries one raw string; this pure parser
 * is the single authority on the semantic value, failing SAFE to the default on
 * any missing/invalid input. The default is `9;4+7501`: a corrupt or absent
 * document must never silently disable the capability, and the two protocols
 * are both enabled by default.
 *
 * The preference gates the terminal-native presentation only (OSC 9;4 pane
 * progress and/or the OSC 7501 semantic program status) — it is deliberately
 * distinct from `progressUpdates`, which controls the Agent's narration cadence.
 * @module @xmoon76/dsh-pi-tui/domain/terminal-progress/settings
 */

/** Which terminal protocols report the main Agent's presentation status. */
export type TerminalProgressMode = 'off' | '9;4' | '7501' | '9;4+7501'

/** The default mode: both the OSC 9;4 pane progress and the OSC 7501 program
 * status are reported. */
export const DEFAULT_TERMINAL_PROGRESS_MODE: TerminalProgressMode = '9;4+7501'

/** The settled outcome of the current main-Agent running interval, as far as
 * the presentation is allowed to claim it. `idle` is the honest default when
 * no matched turn/end evidence exists. */
export type TerminalProgressOutcome = 'idle' | 'done' | 'error'

/** Parse a persisted mode string; anything invalid falls back to the default —
 * an invalid stored value must never silently disable the capability. The
 * retired `on` value is retained as a persisted-profile read compatibility and
 * resolves to the dual-protocol default. */
export function parseTerminalProgressMode(value: string | undefined): TerminalProgressMode {
  switch (value) {
    case 'off': return 'off'
    case '9;4': return '9;4'
    case '7501': return '7501'
    case '9;4+7501': return '9;4+7501'
    case 'on': return '9;4+7501' // compatibility for old USER profile override
    default: return DEFAULT_TERMINAL_PROGRESS_MODE
  }
}

/** Whether the mode reports the OSC 9;4 pane progress protocol. */
export function emitsOsc94(mode: TerminalProgressMode): boolean {
  return mode === '9;4' || mode === '9;4+7501'
}

/** Whether the mode reports the OSC 7501 semantic program status. */
export function emitsOsc7501(mode: TerminalProgressMode): boolean {
  return mode === '7501' || mode === '9;4+7501'
}
