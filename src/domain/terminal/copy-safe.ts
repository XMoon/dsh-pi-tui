/**
 * The shared clipboard control-sequence guard used by the About status report
 * and the Plugin Manager Diagnostics report.
 *
 * Underlying values stay verbatim EXCEPT terminal-active control sequences: an
 * OSC 52 clipboard-write payload or a CSI rewrite inside a title/error must
 * never ride a clipboard copy. A linear scan drops whole ESC/C1-introduced
 * sequences and the remaining C0/C1 controls; ordinary Unicode passes through
 * untouched. TAB/LF/CR are represented by their visible `\t`/`\n`/`\r` escapes
 * so a raw Session or extension field can never forge a line in a fixed,
 * line-oriented report.
 *
 * The module is pure and UI/Host-neutral. The TUI display projection is owned
 * by `src/tui/presentation/terminal-text.ts`; this is the copy-boundary policy
 * only, shared by both report consumers.
 *
 * @module @xmoon76/dsh-pi-tui/domain/terminal/copy-safe
 */

export function copySafe(value: string): string {
  // Fast path: ANY C0 control (including TAB/LF/CR, which are escaped), DEL,
  // or ANY C1 control (0x80–0x9F) needs the scanner.
  if (!/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return value
  let out = ''
  let at = 0
  const length = value.length

  /** Drop one CSI sequence whose parameter/intermediate/final bytes start at
   *  `at`. Mirrors the terminal-text lexer: 0x20–0x3F continues, 0x40–0x7E is
   *  the final, and any other byte stops WITHOUT consuming it — that ordinary
   *  Unicode/control byte then flows through the normal path. */
  const consumeCsi = (): void => {
    while (at < length) {
      const code = value.charCodeAt(at)
      if (code >= 0x20 && code <= 0x3f) { at += 1; continue }
      if (code >= 0x40 && code <= 0x7e) { at += 1; return }
      return
    }
  }

  /** Drop one OSC/DCS/SOS/PM/APC string sequence whose content starts at `at`.
   *  ST is ESC `\` or the C1 ST (0x9C); OSC additionally ends on BEL. An
   *  unterminated sequence drops to the end. */
  const consumeString = (allowBel: boolean): void => {
    while (at < length) {
      const code = value.charCodeAt(at)
      if (allowBel && code === 0x07) { at += 1; return }
      if (code === 0x9c) { at += 1; return }
      if (code === 0x1b && value.charCodeAt(at + 1) === 0x5c) { at += 2; return }
      at += 1
    }
  }

  while (at < length) {
    const code = value.charCodeAt(at)
    if (code === 0x1b) {
      // ESC introducer: CSI, OSC, DCS, SOS, PM or APC consumes its whole
      // sequence. A generic ESC form is intermediate bytes (0x20–0x2F)* plus
      // one final byte (0x30–0x7E) and drops whole; a bare/unknown ESC drops
      // ONLY the ESC so the following ordinary Unicode character survives.
      const next = value.charCodeAt(at + 1)
      if (next === 0x5b) { at += 2; consumeCsi(); continue }
      if (next === 0x5d) { at += 2; consumeString(true); continue }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        at += 2
        consumeString(false)
        continue
      }
      if (next >= 0x20 && next <= 0x2f) {
        at += 1
        while (at < length && value.charCodeAt(at) >= 0x20 && value.charCodeAt(at) <= 0x2f) at += 1
        if (at < length && value.charCodeAt(at) >= 0x30 && value.charCodeAt(at) <= 0x7e) at += 1
        continue
      }
      if (next >= 0x30 && next <= 0x7e) { at += 2; continue }
      at += 1
      continue
    }
    // The C1 introducers are the exact equivalents of the ESC forms above.
    if (code === 0x9b) { at += 1; consumeCsi(); continue }
    if (code === 0x9d) { at += 1; consumeString(true); continue }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      at += 1
      consumeString(false)
      continue
    }
    // Preserve the whitespace INFORMATION without letting a raw control break
    // the line-oriented report: escape TAB/LF/CR visibly.
    if (code === 0x09) { out += '\\t'; at += 1; continue }
    if (code === 0x0a) { out += '\\n'; at += 1; continue }
    if (code === 0x0d) { out += '\\r'; at += 1; continue }
    // Remaining C0/C1 controls (including the standalone 0x80–0x8F range and
    // the C1 ST) are dropped; ordinary Unicode passes through.
    if ((code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      at += 1
      continue
    }
    out += value[at]
    at += 1
  }
  return out
}
