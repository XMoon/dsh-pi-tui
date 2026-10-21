/**
 * Untrusted-text projections for terminal-bound presentation.
 *
 * Source bytes, Session/Job facts and copy payloads stay authoritative and
 * untouched; only the disposable display string is projected here. Two
 * explicit policies exist:
 *
 * - {@link sanitizeDisplayText}: plain untrusted text (prose, labels,
 *   Markdown, command arguments). Every recognized ANSI/VT sequence and every
 *   unsafe C0/C1 character is removed. CRLF normalizes to LF, a lone CR to one
 *   ASCII space, TAB to three spaces. Nothing terminal-active survives.
 * - {@link sanitizeDisplayLog}: untrusted log/terminal text. Same control
 *   removal, except strictly whitelisted complete CSI SGR (`ESC [ … m`) is
 *   retained and a lone CR becomes LF so progress frames read as log history
 *   instead of screen overwrite. The result ends in an app-owned `ESC[0m`
 *   whenever any SGR survives, so no source-controlled terminal state leaks
 *   past its display block.
 *
 * One linear-time scanner handles ESC/C1 introducers, whole CSI/OSC/DCS/SOS/
 * PM/APC sequences (including unterminated tails) and the remaining control
 * bytes. It is a pure `string -> string` projection: no cache, no process
 * state, no side effects.
 *
 * @module @xmoon76/dsh-pi-tui/tui/presentation/terminal-text
 */

const ESC = 0x1b
const BEL = 0x07
const LF = 0x0a
const CR = 0x0d
const TAB = 0x09
const DEL = 0x7f
const C1_CSI = 0x9b
const C1_ST = 0x9c
const C1_OSC = 0x9d
const C1_DCS = 0x90
const C1_SOS = 0x98
const C1_PM = 0x9e
const C1_APC = 0x9f
const BACKSLASH = 0x5c

/** The app-owned reset appended after a display block that kept any SGR. */
const SGR_RESET = '\u001b[0m'

/** SGR parameters permitted by the log whitelist (non-color attributes). */
const SGR_ATTRIBUTES = new Set([0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 39, 49])

/** True when any code unit needs the scanner (a C0 control, DEL or C1). */
function needsScan(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i)
    if (code < 0x20 || (code >= DEL && code <= 0x9f)) return true
  }
  return false
}

/** True for the standard 8/16-color foreground/background parameter set. */
function isStandardColor(value: number): boolean {
  return (value >= 30 && value <= 37)
    || (value >= 40 && value <= 47)
    || (value >= 90 && value <= 97)
    || (value >= 100 && value <= 107)
}

/**
 * Validate one SGR parameter string (the bytes between `[` and `m`). Only
 * decimal fields, the attribute set, standard colors and the `38/48;5;n` /
 * `38/48;2;r;g;b` extended-color groups are accepted; every malformed,
 * unknown, colon, empty or out-of-range parameter rejects the WHOLE sequence.
 */
function isWhitelistedSgrParams(body: string): boolean {
  if (body === '') return true
  const parts = body.split(';')
  for (const part of parts) {
    if (part.length === 0 || part.length > 4) return false
    for (let k = 0; k < part.length; k++) {
      const code = part.charCodeAt(k)
      if (code < 0x30 || code > 0x39) return false
    }
  }
  let i = 0
  while (i < parts.length) {
    const value = Number(parts[i])
    if (value === 38 || value === 48) {
      const mode = parts[i + 1]
      if (mode === '5') {
        const n = parts[i + 2]
        if (n === undefined || Number(n) > 255) return false
        i += 3
        continue
      }
      if (mode === '2') {
        const r = parts[i + 2]
        const g = parts[i + 3]
        const b = parts[i + 4]
        if (r === undefined || g === undefined || b === undefined) return false
        if (Number(r) > 255 || Number(g) > 255 || Number(b) > 255) return false
        i += 5
        continue
      }
      return false
    }
    if (!SGR_ATTRIBUTES.has(value) && !isStandardColor(value)) return false
    i++
  }
  return true
}

/**
 * Consume one CSI sequence starting at its first parameter byte. Returns the
 * index just past the sequence, plus the sequence itself when it is a complete
 * `ESC [ … m` satisfying the log whitelist.
 *
 * A byte outside the parameter/intermediate/final classes ends the sequence
 * early and resumes normal scanning at that byte; running off the end consumes
 * the unterminated remainder.
 */
function scanCsi(source: string, start: number, allowSgr: boolean): { end: number; sgr?: string } {
  const len = source.length
  let j = start
  while (j < len) {
    const code = source.charCodeAt(j)
    if (code >= 0x20 && code <= 0x3f) {
      j++
      continue
    }
    if (code >= 0x40 && code <= 0x7e) {
      if (allowSgr && code === 0x6d) {
        const body = source.slice(start, j)
        if (isWhitelistedSgrParams(body)) return { end: j + 1, sgr: `\u001b[${body}m` }
      }
      return { end: j + 1 }
    }
    break
  }
  return { end: j }
}

/**
 * Consume one string control (OSC/DCS/SOS/PM/APC) starting at its first
 * payload byte. BEL terminates only OSC; `ESC \` and C1 ST terminate every
 * string control. An unterminated string consumes to end of input.
 */
function scanString(source: string, start: number, belTerminates: boolean): number {
  const len = source.length
  let j = start
  while (j < len) {
    const code = source.charCodeAt(j)
    if (belTerminates && code === BEL) return j + 1
    if (code === C1_ST) return j + 1
    if (code === ESC && j + 1 < len && source.charCodeAt(j + 1) === BACKSLASH) return j + 2
    j++
  }
  return len
}

/** Project one source string under either display policy. */
function project(source: string, keepSgr: boolean): string {
  if (!needsScan(source)) return source
  const len = source.length
  let out = ''
  let keptSgr = false
  let i = 0
  while (i < len) {
    const code = source.charCodeAt(i)
    if (code === ESC) {
      const next = i + 1 < len ? source.charCodeAt(i + 1) : -1
      if (next === 0x5b) {
        const csi = scanCsi(source, i + 2, keepSgr)
        if (csi.sgr !== undefined) {
          out += csi.sgr
          keptSgr = true
        }
        i = csi.end
        continue
      }
      if (next === 0x5d) {
        i = scanString(source, i + 2, true)
        continue
      }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = scanString(source, i + 2, false)
        continue
      }
      if (next >= 0x20 && next <= 0x2f) {
        let j = i + 1
        while (j < len && source.charCodeAt(j) >= 0x20 && source.charCodeAt(j) <= 0x2f) j++
        if (j < len && source.charCodeAt(j) >= 0x30 && source.charCodeAt(j) <= 0x7e) j++
        i = j
        continue
      }
      if (next >= 0x30 && next <= 0x7e) {
        i += 2
        continue
      }
      // A bare/unknown ESC form never emits its ESC.
      i++
      continue
    }
    if (code === C1_CSI) {
      // A raw C1 CSI is dropped even when it expresses SGR: no C1 reaches the TTY.
      i = scanCsi(source, i + 1, false).end
      continue
    }
    if (code === C1_OSC) {
      i = scanString(source, i + 1, true)
      continue
    }
    if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) {
      i = scanString(source, i + 1, false)
      continue
    }
    if (code === LF) {
      out += '\n'
      i++
      continue
    }
    if (code === CR) {
      if (i + 1 < len && source.charCodeAt(i + 1) === LF) {
        out += '\n'
        i += 2
        continue
      }
      out += keepSgr ? '\n' : ' '
      i++
      continue
    }
    if (code === TAB) {
      out += '   '
      i++
      continue
    }
    if (code < 0x20 || code === DEL || (code >= 0x80 && code <= 0x9f)) {
      i++
      continue
    }
    out += source[i]
    i++
  }
  if (keepSgr && keptSgr) out += SGR_RESET
  return out
}

/**
 * Project untrusted plain text onto terminal-safe display text: every escape
 * sequence and unsafe control character is removed, CRLF becomes LF, a lone CR
 * becomes one space and TAB becomes three spaces. Ordinary Unicode passes
 * through verbatim and the exact input string is returned when no code unit
 * needs projection.
 */
export function sanitizeDisplayText(source: string): string {
  return project(source, false)
}

/**
 * Project untrusted log/terminal text onto terminal-safe display text:
 * whitelisted complete SGR survives, a lone CR becomes LF so progress frames
 * stay readable as history, and any retained SGR ends with an app-owned reset.
 */
export function sanitizeDisplayLog(source: string): string {
  return project(source, true)
}
