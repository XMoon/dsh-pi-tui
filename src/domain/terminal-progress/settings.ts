/**
 * Terminal-progress preference parsing (plan: native OSC 9;4 presentation).
 * The persisted TUI settings document carries the raw string; this pure
 * parser is the single authority on the semantic value, failing SAFE to the
 * default on any missing/invalid input.
 *
 * The default is `on`: a corrupt or absent document must never silently
 * disable the capability. This preference gates the terminal-native OSC 9;4
 * projection only — it is deliberately distinct from `progressUpdates`,
 * which controls the Agent's narration cadence.
 * @module @xmoon76/dsh-pi-tui/domain/terminal-progress/settings
 */

/** Whether the terminal-native OSC 9;4 progress projection is reported. */
export type TerminalProgressMode = 'on' | 'off'

/** The default mode: native terminal progress is reported. */
export const DEFAULT_TERMINAL_PROGRESS_MODE: TerminalProgressMode = 'on'

/** Parse a persisted mode string; anything invalid falls back to the
 * default (`on`) — an invalid stored value must never silently disable the
 * capability. */
export function parseTerminalProgressMode(value: string | undefined): TerminalProgressMode {
  if (value === 'off' || value === 'on') return value
  return DEFAULT_TERMINAL_PROGRESS_MODE
}
