/**
 * The footer command output sanitizer (plan §17.10): a user-configured
 * status-line command is an escape hatch that MAY style its output, but
 * arbitrary terminal control must never reach the TUI. Allowed: plain
 * text, SGR color/style sequences, and OSC 8 hyperlinks. Everything else
 * — cursor movement, screen clears, OSC title, OSC 52 clipboard, device
 * control, unknown ESC sequences, C0 controls — is stripped.
 * @module @xmoon76/dsh-pi-tui/footer/ansi-sanitize
 */

/** One KEEP alternative: an SGR sequence (`ESC [ params m`) or an OSC 8
 * hyperlink (`ESC ] 8 ; ; uri ST`). The URI character set EXCLUDES C0/C1
 * controls (a control byte inside the URI must never ride through as
 * part of the kept sequence — the sanitizer's contract strips all of
 * them). */
const KEEP = String.raw`\x1b\[[0-9;:]*m|\x1b\]8;;[^\x00-\x1f\x7f-\x9f]*(?:\x07|\x1b\\)`

/** One STRIP alternative: any other ESC-led sequence (CSI/OSC/DCS/PM/APC)
 * or a lone ESC (the group is optional — a truncated sequence consumes
 * just the ESC, never the next character) or a C0 control (except
 * tab/newline/CR, which are legal layout whitespace). */
const STRIP = String.raw`\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P^_X][^\x07\x1b]*(?:\x07|\x1b\\))?|[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]`

const SANITIZE = new RegExp(`(${KEEP})|(${STRIP})`, 'g')

/**
 * Sanitize one command output chunk: keep SGR + OSC 8, strip everything
 * else. The result is safe to render (the composer's truncate/wrap
 * helpers measure it ANSI-safely afterwards).
 */
export function sanitizeCommandOutput(text: string): string {
  return text.replace(SANITIZE, (_match, keep: string | undefined) => keep ?? '')
}
