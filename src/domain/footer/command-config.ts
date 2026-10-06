/**
 * The footer command configuration DTO (TS5 §13.1): the validated
 * `footerCommand` bounds the USER-layer trust parser produces and the terminal
 * runner executes. Transport/UI-neutral — it names no terminal, process or
 * scheduling behavior.
 * @module @xmoon76/dsh-pi-tui/domain/footer/command-config
 */

/** The validated command config (bounds per plan §17.3). */
export interface FooterCommandConfig {
  readonly command: string
  readonly timeoutMs: number
  readonly refreshIntervalMs: number
  readonly maxRows: number
}

/** The default hard timeout (plan §17.3). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300
/** The timeout ceiling. */
export const MAX_COMMAND_TIMEOUT_MS = 1000
/** The minimum refresh interval (plan §17.7). */
export const MIN_COMMAND_REFRESH_MS = 1000
