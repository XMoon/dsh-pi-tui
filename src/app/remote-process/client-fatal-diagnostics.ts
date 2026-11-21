/**
 * Private Client fatal diagnostics.
 *
 * The Split Client runs in its own process; its launcher inherits this
 * process's terminal but cannot report the child's cause, and the official
 * `daemon logs` command must remain a Host-only source. This module is the ONE
 * Client-owned fatal artifact writer: on a real surface fatal it stores a
 * bounded, redacted, human-readable report under the private
 * `$DSH_HOME/logs/pi-tui-client/` directory and returns a terminal-safe
 * locator. It writes nothing on a successful start, depends on no Cordis /
 * Host / Remote state, and an IO failure is a secondary result that never
 * replaces the primary failure.
 *
 * The file is private incident data, not a shareable report: mode 0600 is
 * mandatory, and redaction covers only the well-known credential carriers.
 * Arbitrary secrets embedded in a user-thrown error cannot be fully
 * recognized; never treat this file as safe to share anonymously.
 * @module app/remote-process/client-fatal-diagnostics
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../../runtime/process/diagnostics.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

/** The existing lifecycle state a fatal is observed from. */
export type ClientFatalPhase = 'pre-entry' | 'pre-context' | 'client-assembly' | 'client-runtime'

/** The controlled terminal/file classification of one Client fatal. */
export type ClientFatalKind = 'CLIENT_MODULE_MISSING' | 'CLIENT_STARTUP_FAILED' | 'CLIENT_RUNTIME_FAILED'

/** The single write attempt result: a locator, an explicit opt-out, or a controlled IO failure. */
export type ClientFatalWriteResult =
  | { readonly kind: 'written'; readonly fileName: string }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable'; readonly errno: string }

/** The bounded, redacted preview shared by the writer and its unit tests. */
export interface ClientFatalPreview {
  readonly kind: ClientFatalKind
  readonly text: string
}

const HEADER = 'dsh-pi-tui client fatal v1'
const MAX_FILE_BYTES = 32 * 1024
const MAX_MESSAGE_BYTES = 2 * 1024
const MAX_STACK_BYTES = 12 * 1024
const MAX_CAUSE_DEPTH = 4
const MAX_NAME_BYTES = 128
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
/** Only the Node module-loader codes are Client dependency misses. */
const MODULE_MISSING_CODE_PATTERN = /^(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)$/u
const SAFE_MODULE_SPECIFIER_PATTERN = /^[A-Za-z0-9@._/-]{1,96}$/u
const SAFE_ERRNO_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/u
const MODULE_NOT_FOUND_SENTENCE = /Cannot find (?:package|module) '([^']+)'/u

/** A deliberate policy refusal with a controlled errno-shaped code. */
class DiagnosticWriteRefusal extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'DiagnosticWriteRefusal'
    this.code = code
  }
}

/** Read one error-like field without letting a hostile getter or proxy escape. */
function readField(value: unknown, field: 'name' | 'message' | 'stack' | 'code' | 'cause' | 'errors'): unknown {
  try {
    return (value as Record<string, unknown>)[field]
  } catch {
    return undefined
  }
}

/** The controlled errno name of a thrown IO/policy failure, or `UNKNOWN`. */
function controlledErrno(error: unknown): string {
  const code = readField(error, 'code')
  return typeof code === 'string' && SAFE_ERRNO_PATTERN.test(code) ? code : 'UNKNOWN'
}

/** The legal error code of a thrown value, if it has one. */
function legalErrorCode(error: unknown): string | undefined {
  const code = readField(error, 'code')
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined
}

/** Whether this is the exact Node loader shape of a missing Client dependency. */
function isModuleMissing(error: unknown): boolean {
  const code = legalErrorCode(error)
  return code !== undefined && MODULE_MISSING_CODE_PATTERN.test(code)
}

/**
 * The only module specifier that may reach the terminal: the standard Node
 * `Cannot find ...` sentence, a bounded package-shaped name with no path or
 * URL shape. An unknown shape stays unknown rather than guessing.
 */
export function clientModuleSpecifier(error: unknown): string | undefined {
  const sentence = MODULE_NOT_FOUND_SENTENCE.exec(safeErrorMessage(error))
  const specifier = sentence?.[1]
  if (specifier === undefined) return undefined
  if (!SAFE_MODULE_SPECIFIER_PATTERN.test(specifier)) return undefined
  if (specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../')) return undefined
  if (specifier.includes('/../') || specifier.includes('//') || specifier.includes('\\')) return undefined
  return specifier
}

/** The controlled classification of one fatal observation. */
export function clientFatalKind(error: unknown, phase: ClientFatalPhase): ClientFatalKind {
  if (isModuleMissing(error)) return 'CLIENT_MODULE_MISSING'
  return phase === 'client-runtime' ? 'CLIENT_RUNTIME_FAILED' : 'CLIENT_STARTUP_FAILED'
}

/**
 * Redact the known credential carriers from private diagnostic text. Bounded
 * on purpose: the file contract states that arbitrary secret formats cannot
 * be fully recognized.
 */
function redactPrivateText(text: string): string {
  return text
    .replace(/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]*/giu, '$1: <redacted>')
    // A private incident file is not a place for any live Host/launch URL.
    .replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]+/gu, '<url>')
    .replace(/([?&](?:token|access_token|cookie)=)[^&#\s]+/giu, '$1<redacted>')
    // Quoted values are common in self-authored diagnostics; consume the whole
    // quoted literal so its closing quote cannot leave the secret visible.
    .replace(/\b(token|access_token|password)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/giu, '$1=<redacted>')
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** Collapse a single-line field without letting control characters cross fields. */
function singleLine(text: string, maxBytes: number): string {
  return truncateUtf8(redactPrivateText(text).replace(/[\r\n]+/gu, ' '), maxBytes)
}

/** Observe Error/AggregateError identity without a hostile trap escaping. */
function isErrorLike(value: unknown): boolean {
  try {
    return value instanceof Error
  } catch {
    return false
  }
}

function isAggregateErrorLike(value: unknown): boolean {
  try {
    return value instanceof AggregateError
  } catch {
    return false
  }
}

/** The direct cause children of one layer: `.cause` plus `AggregateError.errors`. */
function causeChildren(value: unknown): unknown[] {
  const children: unknown[] = []
  const cause = readField(value, 'cause')
  if (cause !== undefined) children.push(cause)
  if (isAggregateErrorLike(value)) {
    const errors = readField(value, 'errors')
    try {
      if (Array.isArray(errors)) children.push(...errors)
    } catch {
      // A hostile errors accessor is not a serializable cause.
    }
  }
  return children
}

/** Append one primary/cause layer to the fixed field list. */
function appendErrorFields(lines: string[], error: unknown, depth: number): void {
  const prefix = depth === 0 ? 'error' : `cause[${depth}]`
  const name = readField(error, 'name')
  const fallbackName = isErrorLike(error) ? 'Error' : 'NonError'
  lines.push(`${prefix}.name: ${typeof name === 'string' && name !== '' ? singleLine(name, MAX_NAME_BYTES) : fallbackName}`)
  const code = legalErrorCode(error)
  if (code !== undefined) lines.push(`${prefix}.code: ${code}`)
  lines.push(`${prefix}.message: ${truncateUtf8(redactPrivateText(safeErrorMessage(error)), MAX_MESSAGE_BYTES)}`)
  const stack = readField(error, 'stack')
  if (typeof stack === 'string' && stack !== '') {
    lines.push(`${prefix}.stack: ${truncateUtf8(redactPrivateText(stack), MAX_STACK_BYTES)}`)
  }
}

/**
 * Append up to MAX_CAUSE_DEPTH cause layers. `AggregateError.errors` is part
 * of the visible chain because the cleanup merge (`mergeCause`) creates one
 * when a primary already carries a cause; ignoring it would hide both.
 */
function appendCauseChain(lines: string[], root: unknown): void {
  const seen = new Set<unknown>()
  let remaining = MAX_CAUSE_DEPTH
  let index = 0
  const visit = (value: unknown): void => {
    if (remaining <= 0 || value === undefined) return
    if (seen.has(value)) {
      lines.push(`cause[${index + 1}].name: <circular cause>`)
      return
    }
    seen.add(value)
    remaining -= 1
    index += 1
    appendErrorFields(lines, value, index)
    if (remaining <= 0) return
    for (const child of causeChildren(value)) {
      if (remaining <= 0) break
      visit(child)
    }
  }
  for (const child of causeChildren(root)) visit(child)
}

/** Bound the whole document to the frozen 32 KiB contract. */
function boundFileText(text: string): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= MAX_FILE_BYTES) return text
  const marker = '\n[truncated]\n'
  return `${truncateUtf8(text, MAX_FILE_BYTES - Buffer.byteLength(marker, 'utf8'))}${marker}`
}

/**
 * Build the bounded, redacted private text for one fatal. Shared with the
 * writer so the security/size rules live in exactly one implementation.
 */
export function clientFatalErrorDetails(error: unknown, phase: ClientFatalPhase): ClientFatalPreview {
  const kind = clientFatalKind(error, phase)
  const lines: string[] = [
    HEADER,
    `time: ${new Date().toISOString()}`,
    `phase: ${phase}`,
    `kind: ${kind}`,
  ]
  appendErrorFields(lines, error, 0)
  appendCauseChain(lines, error)
  return { kind, text: boundFileText(`${lines.join('\n')}\n`) }
}

/** The terminal-safe locator for one write result: never a private absolute path. */
export function clientDiagnosticLocation(result: ClientFatalWriteResult): string {
  if (result.kind === 'written') {
    return `Client diagnostics: $DSH_HOME/logs/pi-tui-client/${result.fileName} (default DSH_HOME: ~/.dsh)`
  }
  if (result.kind === 'disabled') return 'Client diagnostic file disabled (DSH_PI_TUI_LOG=off)'
  return `Client diagnostics unavailable (DIAGNOSTIC_WRITE_FAILURE: ${result.errno})`
}

/** Create (or tighten) the Client-only directory and prove it is a private 0700 real directory. */
function ensurePrivateClientDirectory(path: string, uid: number | undefined): string {
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(path)
  } catch (error) {
    if (controlledErrno(error) !== 'ENOENT') throw error
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (mkdirError) {
      if (controlledErrno(mkdirError) !== 'EEXIST') throw mkdirError
    }
    info = lstatSync(path)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DiagnosticWriteRefusal('ELOOP')
  if (uid !== undefined && info.uid !== uid) throw new DiagnosticWriteRefusal('EPERM')
  if ((info.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700)
    info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
      throw new DiagnosticWriteRefusal('EPERM')
    }
    if (uid !== undefined && info.uid !== uid) throw new DiagnosticWriteRefusal('EPERM')
  }
  return path
}

/**
 * Resolve the real DSH home, prove the actual `logs` parent and the Client-only
 * child are uid-owned real directories, and create only the Client-specific
 * directory when missing. The shared `logs` directory is never chmodded.
 */
function prepareDiagnosticDirectory(env: NodeJS.ProcessEnv): string {
  const home = realpathSync(dshHome(env))
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const homeInfo = statSync(home)
  if (!homeInfo.isDirectory()) throw new DiagnosticWriteRefusal('ENOTDIR')
  if (uid !== undefined && homeInfo.uid !== uid) throw new DiagnosticWriteRefusal('EPERM')
  const logs = join(home, 'logs')
  let logsInfo: ReturnType<typeof lstatSync>
  try {
    logsInfo = lstatSync(logs)
  } catch (error) {
    if (controlledErrno(error) !== 'ENOENT') throw error
    mkdirSync(logs, { mode: 0o700 })
    logsInfo = lstatSync(logs)
  }
  if (logsInfo.isSymbolicLink() || !logsInfo.isDirectory()) throw new DiagnosticWriteRefusal('ELOOP')
  if (uid !== undefined && logsInfo.uid !== uid) throw new DiagnosticWriteRefusal('EPERM')
  // A group/other-writable parent could let another account replace the
  // Client-only directory between proof and write. A normal `logs` is 0755.
  if ((logsInfo.mode & 0o022) !== 0) throw new DiagnosticWriteRefusal('EPERM')
  const directory = ensurePrivateClientDirectory(join(logs, 'pi-tui-client'), uid)
  if (realpathSync(directory) !== directory) throw new DiagnosticWriteRefusal('ELOOP')
  return directory
}

/**
 * Write the whole UTF-8 buffer. `writeSync` may legally return a short count
 * for a regular file (for example a full disk); a short/zero write is an IO
 * failure, never a successful `written` result.
 */
export function writeAllBytes(fd: number, text: string, write: typeof writeSync = writeSync): void {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new DiagnosticWriteRefusal('EIO')
    offset += written
  }
}

/**
 * Write ONE Client fatal artifact. Returns the terminal-safe locator facts; a
 * disabled or failed write is reported explicitly and never throws into the
 * application startup root.
 */
export function writeClientFatalDiagnostic(
  error: unknown,
  phase: ClientFatalPhase,
  env: NodeJS.ProcessEnv,
): ClientFatalWriteResult {
  const configured = env.DSH_PI_TUI_LOG
  if (configured === 'off' || configured === '') return { kind: 'disabled' }
  let directory: string
  try {
    directory = prepareDiagnosticDirectory(env)
  } catch (ioError) {
    return { kind: 'unavailable', errno: controlledErrno(ioError) }
  }
  const fileName = `startup-${randomUUID()}.log`
  const target = join(directory, fileName)
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    let info = fstatSync(fd)
    if (!info.isFile()) throw new DiagnosticWriteRefusal('EPERM')
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && info.uid !== uid) throw new DiagnosticWriteRefusal('EPERM')
    if ((info.mode & 0o777) !== 0o600) {
      fchmodSync(fd, 0o600)
      info = fstatSync(fd)
    }
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) {
      throw new DiagnosticWriteRefusal('EPERM')
    }
    writeAllBytes(fd, clientFatalErrorDetails(error, phase).text)
    closeSync(fd)
    fd = undefined
    return { kind: 'written', fileName }
  } catch (ioError) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Best effort: the original IO failure stays primary.
      }
    }
    if (created) {
      try {
        rmSync(target, { force: true })
      } catch {
        // Best effort: a leaked private file must not mask the primary failure.
      }
    }
    return { kind: 'unavailable', errno: controlledErrno(ioError) }
  }
}
