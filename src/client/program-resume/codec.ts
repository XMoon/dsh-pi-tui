/**
 * The OSC 7577 Program Resume Protocol v0.5 encoder (sender side).
 *
 * Pure computation only: no terminal IO, no process state and no clock. The
 * caller supplies the owning pid, the current Unix second and the already
 * validated resume command. Every argument is standard Base64 of UTF-8 and
 * the frame is `ESC ] 7577 ; body :mac=<sha256> ESC \`.
 *
 * The MAC is a plain SHA-256 of `body:token`, NOT an HMAC. A valid frame is an
 * offer to the terminal, never an acknowledgement.
 *
 * @module @xmoon76/dsh-pi-tui/client/program-resume/codec
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** The protocol's application budget: complete frame bytes including OSC/ST. */
export const PROGRAM_RESUME_MAX_WIRE_BYTES = 2048
/** The protocol's application budget: resume command elements. */
export const PROGRAM_RESUME_MAX_ARGV = 64

/** The protocol token grammar. */
const TOKEN = /^[A-Za-z0-9_-]{22,64}$/u
/** C0, DEL and C1 are forbidden in decoded text. */
const FORBIDDEN_TEXT = /[\u0000-\u001F\u007F-\u009F]/u
const OSC_PREFIX = '\u001B]7577;'
const ST = '\u001B\\'

/** One report frame's inputs. */
export interface ProgramResumeReportInput {
  readonly token: string
  readonly pid: number
  /** Unix seconds sampled when this frame is built. */
  readonly time: number
  readonly argv: readonly string[]
  /**
   * Optional at the protocol layer; the product target builder always supplies
   * the real launch cwd (the product is deliberately stricter than v0.5).
   */
  readonly cwd?: string
}

/** One clear frame's inputs. */
export interface ProgramResumeClearInput {
  readonly token: string
  readonly pid: number
  /** Unix seconds sampled when this frame is built. */
  readonly time: number
}

/** Whether `value` is a legal protocol capability token. */
export function isProgramResumeToken(value: string | undefined): value is string {
  return value !== undefined && TOKEN.test(value)
}

/** A positive safe integer rendered without signs or decimals. */
function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`program resume: ${field} must be a positive safe integer`)
  return value
}

/** Standard Base64 of one UTF-8 argument, rejecting invalid Unicode/control. */
function encodeText(value: string, field: string, allowEmpty: boolean): string {
  if (!allowEmpty && value === '') throw new Error(`program resume: ${field} must not be empty`)
  if (FORBIDDEN_TEXT.test(value)) throw new Error(`program resume: ${field} contains a control character`)
  const bytes = Buffer.from(value, 'utf8')
  // Buffer replaces unpaired UTF-16 surrogates with U+FFFD; a byte-exact
  // roundtrip is the portable proof that the input was valid UTF-8 text.
  if (bytes.toString('utf8') !== value) throw new Error(`program resume: ${field} is not valid Unicode text`)
  return bytes.toString('base64')
}

/** The resume command's first element: an absolute path or a bare command name. */
function encodeExecutable(value: string): string {
  if (value === '' || value.startsWith('-')) throw new Error('program resume: argv[0] must be a command name or absolute path')
  if (!isAbsolute(value) && value.includes('/')) throw new Error('program resume: a relative argv[0] path is forbidden')
  return encodeText(value, 'argv[0]', false)
}

function encodeArgv(argv: readonly string[]): string {
  if (argv.length === 0 || argv.length > PROGRAM_RESUME_MAX_ARGV) {
    throw new Error(`program resume: argv must contain 1..${String(PROGRAM_RESUME_MAX_ARGV)} elements`)
  }
  const encoded = [encodeExecutable(argv[0] as string)]
  for (let index = 1; index < argv.length; index += 1) {
    encoded.push(encodeText(argv[index] as string, `argv[${String(index)}]`, true))
  }
  return encoded.join(',')
}

function macOf(body: string, token: string): string {
  if (!isProgramResumeToken(token)) throw new Error('program resume: the token is not a legal capability token')
  return createHash('sha256').update(`${body}:${token}`, 'utf8').digest('hex')
}

function frameOf(body: string, token: string): string {
  const frame = `${OSC_PREFIX}${body}:mac=${macOf(body, token)}${ST}`
  if (Buffer.byteLength(frame, 'utf8') > PROGRAM_RESUME_MAX_WIRE_BYTES) {
    throw new Error(`program resume: the complete frame exceeds ${String(PROGRAM_RESUME_MAX_WIRE_BYTES)} bytes`)
  }
  return frame
}

/**
 * Encode one resume report. Throws rather than truncating or emitting a
 * partial frame; the caller may send a legal clear instead.
 */
export function encodeProgramResumeReport(input: ProgramResumeReportInput): string {
  const pid = positiveInteger(input.pid, 'pid')
  const time = positiveInteger(input.time, 'time')
  const cwdValue = input.cwd
  let cwd = ''
  if (cwdValue !== undefined) {
    if (!isAbsolute(cwdValue)) throw new Error('program resume: cwd must be absolute')
    cwd = `:cwd=${encodeText(cwdValue, 'cwd', false)}`
  }
  const body = `pid=${String(pid)}:time=${String(time)}:argv=${encodeArgv(input.argv)}${cwd}`
  return frameOf(body, input.token)
}

/**
 * Encode one clear report. A clear removes the matching record; it is the
 * only legal replacement for a resume command the product cannot express.
 */
export function encodeProgramResumeClear(input: ProgramResumeClearInput): string {
  const pid = positiveInteger(input.pid, 'pid')
  const time = positiveInteger(input.time, 'time')
  return frameOf(`pid=${String(pid)}:time=${String(time)}:clear=1`, input.token)
}
