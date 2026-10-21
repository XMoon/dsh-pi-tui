/**
 * The neutral notification policy types (TS5 §14.1): the focus-state fact the
 * completion policy consumes. It carries no terminal object, sequence or
 * writer — the terminal tracker that produces it lives in
 * `tui/notification/terminal-focus.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/notification/types
 */

/** The terminal focus state the completion policy consumes. */
export type TerminalFocusState = 'focused' | 'unfocused'
