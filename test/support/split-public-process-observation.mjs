/**
 * Test-only public-process observation seam.
 *
 * This module answers ONE narrow question for the public daemon qualification:
 * "is this numeric pid still the exact installed public entry I captured, with
 * this Scene's home/profile/anchor, the required controlling tty and a proven
 * direct parent edge?"
 *
 * It is deliberately NOT a second kernel-identity owner. The OS birth and
 * liveness facts always come from the production `readKernelProcess` /
 * `listKernelGroupMembers` readers that the caller passes in. This module adds
 * only the observations those readers do not expose (exact argv/env bytes,
 * controlling tty, bounded child/global enumeration) and one shared admission
 * predicate for the Supervisor's normal, late and destructive callers plus the
 * independent external probe.
 *
 * Every read is tri-state: `alive`, `gone`, or `unknown`. `unknown` never means
 * "gone", never authorizes a signal, and never proves absence. All decoders are
 * strict: duplicate/malformed environment entries, invalid UTF-8, ambiguous
 * argv/env framing and truncated or oversized sysctl copies are `unknown`, not
 * a best-effort value.
 *
 * Platforms: Linux (`/proc` exact NUL framing) and Darwin arm64 (libproc
 * flavor 3 ctty, `KERN_PROCARGS2`). Any other platform is unsupported.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

import {
  DARWIN_BSDINFO_BYTES,
  classifyDarwinReadOutcome,
  readDarwinUniqueInfo,
} from '../../src/runtime/native-process/darwin.ts'

const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin'])

const LIBPROC = '/usr/lib/libproc.dylib'
const LIBSYSTEM = '/usr/lib/libSystem.B.dylib'
const PROC_PIDTBSDINFO = 3
const PROC_FLAG_CONTROLT = 0x80
const NODEV32 = 0xffffffff
const BSDINFO_BYTES = DARWIN_BSDINFO_BYTES
const SHORTBSDINFO_BYTES = 64
const PROC_PIDT_SHORTBSDINFO = 13
const CTL_KERN = 1
const KERN_PROCARGS2 = 49
const KERN_ARGMAX = 8
const ESRCH = 3
const EPERM = 1
const EACCES = 13
const EINVAL = 22
const EFAULT = 14
const ENOMEM = 12

const MAX_PID_ENUMERATION = 1_048_576
const MAX_DESCENDANTS = 4096
/** The XNU kernel appends these non-environment strings after the env section. */
const DARWIN_APPLE_STRING_KEYS = new Set([
  'ptr_munge', 'main_stack', 'executable_file', 'dyld_file', 'executable_cdhash',
  'executable_boothash', 'arm64e_abi', 'th_te', 'wq_stack', 'th_port', 'security_config',
])
const MAX_DESCENDANT_DEPTH = 32

const UTF8 = new TextDecoder('utf-8', { fatal: true })

export class PublicObservationError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PublicObservationError'
    this.code = code
    this.detail = detail
  }
}

export function isPublicObservationPlatformSupported(platform = process.platform) {
  return SUPPORTED_PLATFORMS.has(platform)
}

function unknown(code, detail = {}) {
  return { kind: 'unknown', code, ...detail }
}

function gone(detail = {}) {
  return { kind: 'gone', ...detail }
}

function requireInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PublicObservationError('ABI_UNSUPPORTED', `${label} is not an integer`)
  }
  return value
}

function decimal(value) {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new PublicObservationError('ABI_UNSUPPORTED', 'expected an exact 64-bit integer')
}

function decodeUtf8(bytes) {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new PublicObservationError('INVALID_UTF8', 'the kernel bytes are not valid UTF-8')
  }
}

function classifyErrno(errno) {
  if (errno === EPERM || errno === EACCES) return 'ACCESS_DENIED'
  if (errno === EINVAL) return 'ABI_UNSUPPORTED'
  return 'READ_FAILED'
}

function canonicalEntry(path) {
  if (typeof path !== 'string' || path === '') return undefined
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** One exact path: present | absent. Any other lstat failure is thrown, never absent. */
export function publicPathPresence(path) {
  try {
    lstatSync(path)
    return 'present'
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent'
    throw new PublicObservationError('PATH_UNKNOWN', `the path is not readable/unknown: ${path}`)
  }
}

/**
 * Strict Linux `/proc/<pid>/cmdline` decoder.
 *
 * The kernel writes argv entries NUL-separated with one trailing NUL. Empty
 * interior arguments are preserved. A missing trailing NUL, an empty exec path
 * or invalid UTF-8 is `unknown`.
 */
export function parseLinuxCommandLine(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer[buffer.length - 1] !== 0) {
    return unknown('ARGV_FRAMING')
  }
  const argv = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    try {
      argv.push(decodeUtf8(buffer.subarray(start, index)))
    } catch {
      return unknown('INVALID_UTF8')
    }
    start = index + 1
  }
  // The loop above dropped the final empty segment after the trailing NUL.
  if (argv.length === 0 || argv[0] === '') return unknown('ARGV_FRAMING')
  return { kind: 'ok', argv }
}

/**
 * Strict Linux `/proc/<pid>/environ` decoder. An empty buffer is a present but
 * empty environment. Every entry is split at the FIRST '='; duplicate keys,
 * entries without '=', empty keys and invalid UTF-8 are `unknown`.
 */
export function parseLinuxEnvironment(buffer) {
  if (!Buffer.isBuffer(buffer)) return unknown('ENV_FRAMING')
  if (buffer.length === 0) {
    return { kind: 'ok', envEntries: [], envMap: new Map(), envPresent: false, envSectionBytes: 0 }
  }
  if (buffer[buffer.length - 1] !== 0) return unknown('ENV_FRAMING')
  const envEntries = []
  const envMap = new Map()
  const duplicateKeys = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    const raw = buffer.subarray(start, index)
    start = index + 1
    if (raw.length === 0) {
      // The trailing NUL is the only permitted empty segment.
      if (index === buffer.length - 1) continue
      return unknown('ENV_FRAMING')
    }
    let text
    try {
      text = decodeUtf8(raw)
    } catch {
      return unknown('INVALID_UTF8')
    }
    const equals = text.indexOf('=')
    if (equals <= 0) return unknown('MALFORMED_ENV_ITEM', { rawLength: text.length })
    const key = text.slice(0, equals)
    const value = text.slice(equals + 1)
    envEntries.push({ key, value })
    if (envMap.has(key)) duplicateKeys.push(key)
    else envMap.set(key, value)
  }
  if (start !== buffer.length) return unknown('ENV_FRAMING')
  if (duplicateKeys.length > 0) return unknown('DUPLICATE_ENV_KEY', { duplicateKeys: [...new Set(duplicateKeys)] })
  return {
    kind: 'ok',
    envEntries,
    envMap,
    envPresent: true,
    envSectionBytes: buffer.length,
  }
}

/** Deterministic PID-slot framing: holes are empty, negatives are invalid. */
export function decodePidSlots(values) {
  const pids = []
  let emptySlots = 0
  for (const value of values) {
    if (!Number.isInteger(value)) return { kind: 'unknown', code: 'ENUMERATION_FRAMING' }
    if (value === 0) { emptySlots += 1; continue }
    if (value < 0) return { kind: 'unknown', code: 'ENUMERATION_FRAMING' }
    pids.push(value)
  }
  return { kind: 'ok', pids, emptySlots }
}

function readCString(data, offset) {
  if (offset < 0 || offset >= data.length) return undefined
  const end = data.indexOf(0, offset)
  if (end < 0) return undefined
  let value
  try {
    value = decodeUtf8(data.subarray(offset, end))
  } catch {
    return { invalidUtf8: true }
  }
  return { value, next: end + 1 }
}

/**
 * The argv part of one `KERN_PROCARGS2` copy, without interpreting env. This is
 * a prefilter only: it can exclude a non-target, never admit one.
 */
export function parseDarwinProcargsArgv(buffer, used) {
  if (!Buffer.isBuffer(buffer) || !Number.isInteger(used) || used < 4 || used > buffer.length) {
    return unknown('ABI_UNSUPPORTED')
  }
  const argc = buffer.readInt32LE(0)
  if (!Number.isInteger(argc) || argc < 0 || argc > 262_144) return unknown('ABI_UNSUPPORTED', { argc })
  const data = buffer.subarray(4, used)
  let offset = 0
  const execPath = readCString(data, offset)
  if (execPath === undefined || execPath.invalidUtf8 === true || execPath.value === '') {
    return unknown('ARGV_FRAMING', { stage: 'exec-path' })
  }
  offset = execPath.next
  while (offset < data.length && data[offset] === 0) offset += 1
  const argv = []
  for (let index = 0; index < argc; index += 1) {
    const item = readCString(data, offset)
    if (item === undefined || item.invalidUtf8 === true) return unknown('ARGV_FRAMING', { stage: 'argv', index })
    argv.push(item.value)
    offset = item.next
  }
  return { kind: 'ok', argc, execPath: execPath.value, argv, argvEnd: offset }
}

/**
 * Strict Darwin `KERN_PROCARGS2` decoder.
 *
 * Layout: int32 argc, NUL-terminated exec path, alignment NULs, exactly argc
 * NUL-terminated argv entries, then NUL-terminated environment entries with
 * page-padding zeros. Empty argv entries are preserved (the admission predicate
 * still requires a non-empty argv[0] for the real Node entry). Duplicate keys,
 * malformed entries, invalid UTF-8 and ambiguous padding are `unknown`.
 */
export function parseDarwinProcargs(buffer, used) {
  if (!Buffer.isBuffer(buffer) || !Number.isInteger(used) || used < 4 || used > buffer.length) {
    return unknown('ABI_UNSUPPORTED')
  }
  const argc = buffer.readInt32LE(0)
  if (!Number.isInteger(argc) || argc < 0 || argc > 262_144) {
    return unknown('ABI_UNSUPPORTED', { argc })
  }
  const data = buffer.subarray(4, used)
  let offset = 0
  const execPath = readCString(data, offset)
  if (execPath === undefined) return unknown('ARGV_FRAMING', { stage: 'exec-path' })
  if (execPath.invalidUtf8 === true) return unknown('INVALID_UTF8', { stage: 'exec-path' })
  if (execPath.value === '') return unknown('ARGV_FRAMING', { stage: 'exec-path' })
  offset = execPath.next
  // XNU pads the exec path to pointer alignment with extra NULs.
  while (offset < data.length && data[offset] === 0) offset += 1
  const argv = []
  for (let index = 0; index < argc; index += 1) {
    const item = readCString(data, offset)
    if (item === undefined) return unknown('ARGV_FRAMING', { stage: 'argv', index, argc })
    if (item.invalidUtf8 === true) return unknown('INVALID_UTF8', { stage: 'argv', index })
    argv.push(item.value)
    offset = item.next
  }
  const argvEnd = offset
  let envEnd = offset
  const envEntries = []
  const envMap = new Map()
  const duplicateKeys = []
  let envStarted = false
  for (;;) {
    if (offset >= data.length) break
    if (data[offset] === 0) {
      // XNU may place NUL separators between argv and the first environment
      // entry. Once the environment has started, the first zero run is the
      // actual end of the env section; the kernel then appends its own
      // "apple" strings (ptr_munge, main_stack, executable_*, ...). Those are
      // NOT environment variables. An unknown tail token is ambiguous framing
      // and fails closed instead of being admitted as an env entry.
      while (offset < data.length && data[offset] === 0) offset += 1
      if (offset >= data.length) break
      if (envStarted) {
        const appleKeys = []
        let appleSectionBytes = 0
        while (offset < data.length) {
          if (data[offset] === 0) {
            offset += 1
            continue
          }
          const tail = readCString(data, offset)
          if (tail === undefined || tail.invalidUtf8 === true) {
            return unknown('ENV_FRAMING', { stage: 'apple-tail' })
          }
          const equals = tail.value.indexOf('=')
          const key = equals > 0 ? tail.value.slice(0, equals) : ''
          if (!DARWIN_APPLE_STRING_KEYS.has(key)) {
            return unknown('ENV_FRAMING', { stage: 'apple-tail', key })
          }
          appleKeys.push(key)
          appleSectionBytes += tail.next - offset
          offset = tail.next
        }
        if (duplicateKeys.length > 0) {
          return unknown('DUPLICATE_ENV_KEY', { duplicateKeys: [...new Set(duplicateKeys)] })
        }
        return {
          kind: 'ok',
          argc,
          execPath: execPath.value,
          argv,
          argvEnd,
          envEntries,
          envMap,
          envPresent: envEntries.length > 0,
          envSectionBytes: envEnd - argvEnd,
          appleKeys,
          appleSectionBytes,
        }
      }
      continue
    }
    const item = readCString(data, offset)
    if (item === undefined) return unknown('ENV_FRAMING', { stage: 'env' })
    if (item.invalidUtf8 === true) return unknown('INVALID_UTF8', { stage: 'env' })
    const equals = item.value.indexOf('=')
    if (equals <= 0) return unknown('MALFORMED_ENV_ITEM', { stage: 'env' })
    const key = item.value.slice(0, equals)
    if (envStarted !== true && DARWIN_APPLE_STRING_KEYS.has(key)) {
      // The process has an empty environment: the first kernel apple string is
      // the section start, not an environment entry.
      const appleKeys = [key]
      let appleSectionBytes = item.next - offset
      offset = item.next
      while (offset < data.length) {
        if (data[offset] === 0) {
          offset += 1
          continue
        }
        const tail = readCString(data, offset)
        if (tail === undefined || tail.invalidUtf8 === true) {
          return unknown('ENV_FRAMING', { stage: 'apple-tail' })
        }
        const tailEquals = tail.value.indexOf('=')
        const tailKey = tailEquals > 0 ? tail.value.slice(0, tailEquals) : ''
        if (!DARWIN_APPLE_STRING_KEYS.has(tailKey)) {
          return unknown('ENV_FRAMING', { stage: 'apple-tail', key: tailKey })
        }
        appleKeys.push(tailKey)
        appleSectionBytes += tail.next - offset
        offset = tail.next
      }
      return {
        kind: 'ok',
        argc,
        execPath: execPath.value,
        argv,
        argvEnd,
        envEntries: [],
        envMap,
        envPresent: false,
        envSectionBytes: 0,
        appleKeys,
        appleSectionBytes,
      }
    }
    envStarted = true
    offset = item.next
    envEnd = offset
    const value = item.value.slice(equals + 1)
    envEntries.push({ key, value })
    if (envMap.has(key)) duplicateKeys.push(key)
    else envMap.set(key, value)
  }
  if (duplicateKeys.length > 0) return unknown('DUPLICATE_ENV_KEY', { duplicateKeys: [...new Set(duplicateKeys)] })
  return {
    kind: 'ok',
    argc,
    execPath: execPath.value,
    argv,
    argvEnd,
    envEntries,
    envMap,
    envPresent: envEntries.length > 0,
    envSectionBytes: envEnd - argvEnd,
    appleKeys: [],
    appleSectionBytes: data.length - envEnd,
  }
}

function parseLinuxStat(stat) {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 2).trim().split(/\s+/u)
  const state = fields[0]
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const sid = Number(fields[3])
  const ttyNr = Number(fields[4])
  const starttime = fields[19]
  if (!/^[A-Za-z]$/u.test(state) || !Number.isInteger(ppid) || !Number.isInteger(pgid)
    || !Number.isInteger(sid) || !Number.isInteger(ttyNr) || ttyNr < 0
    || typeof starttime !== 'string' || !/^\d+$/u.test(starttime)) {
    return undefined
  }
  return { state, ppid, pgid, sid, ttyNr, starttime }
}

function readProcDirUid(pid) {
  try {
    return statSync(`/proc/${String(pid)}`).uid
  } catch {
    return undefined
  }
}

function readLinuxComm(pid) {
  try {
    return readFileSync(`/proc/${String(pid)}/comm`, 'utf8').replace(/\n$/u, '')
  } catch {
    return undefined
  }
}

function readLinuxUid(pid) {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/status`, 'utf8')
    const match = /^Uid:\s+(\d+)/mu.exec(raw)
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

function readLinuxFd0(pid) {
  try {
    return { kind: 'ok', value: readlinkSync(`/proc/${String(pid)}/fd/0`) }
  } catch (error) {
    if (error.code === 'ENOENT') return unknown('FD_UNREADABLE')
    if (error.code === 'EACCES' || error.code === 'EPERM') return unknown('ACCESS_DENIED')
    return unknown('FD_UNREADABLE')
  }
}

function ttyFromLinux(ttyNr, fd0) {
  return {
    platform: 'linux',
    ttyNr,
    fd0: fd0.kind === 'ok' ? fd0.value : null,
    fd0Readable: fd0.kind === 'ok',
    hasControllingTty: ttyNr !== 0,
    noControllingTty: ttyNr === 0,
    fd0IsPts: fd0.kind === 'ok' && /^\/dev\/pts\/\d+$/u.test(fd0.value),
  }
}

function decodeFixed(bytes) {
  if (bytes === undefined || bytes === null) return ''
  const array = bytes instanceof Uint8Array
    ? bytes
    : typeof bytes === 'string'
      ? Uint8Array.from(bytes.split(',').map(Number))
      : Array.isArray(bytes) ? Uint8Array.from(bytes) : undefined
  if (array === undefined) return ''
  const end = array.indexOf(0)
  try {
    return decodeUtf8(Buffer.from(array.subarray(0, end < 0 ? array.length : end)))
  } catch {
    return ''
  }
}

function ttyFromDarwin(bsd) {
  return {
    platform: 'darwin',
    eTdev: bsd.eTdev,
    eTpgid: bsd.eTpgid,
    flags: bsd.flags,
    hasControllingTty: bsd.hasControllingTty,
    noControllingTty: bsd.noControllingTty,
    fd0IsPts: null,
  }
}

/**
 * Compare one observation's tty requirement against a captured shell tty.
 * `shellTty` is the tty facts captured from the real native PTY owner.
 */
function admitTty(observation, spec) {
  if (spec === undefined) return undefined
  const tty = observation.tty
  if (tty === undefined) return 'tty-unproven'
  if (spec.kind === 'foreground') {
    const shell = spec.shell
    if (shell === undefined) return 'tty-shell-unproven'
    if (tty.platform === 'darwin') {
      if (tty.hasControllingTty !== true) return 'tty-mismatch'
      if (shell.platform !== 'darwin' || shell.hasControllingTty !== true) return 'tty-shell-unproven'
      return tty.eTdev === shell.eTdev ? undefined : 'tty-mismatch'
    }
    if (tty.ttyNr === 0) return 'tty-mismatch'
    if (!tty.fd0Readable || tty.fd0IsPts !== true) return 'tty-unproven'
    if (shell.platform !== 'linux' || shell.ttyNr === 0) return 'tty-shell-unproven'
    return tty.ttyNr === shell.ttyNr ? undefined : 'tty-mismatch'
  }
  if (spec.kind === 'detached') {
    if (tty.platform === 'darwin') {
      if (tty.noControllingTty !== true || tty.eTdev !== NODEV32) return 'tty-mismatch'
      return undefined
    }
    if (tty.ttyNr !== 0) return 'tty-mismatch'
    if (!tty.fd0Readable) return 'tty-unproven'
    return tty.fd0IsPts === true ? 'tty-mismatch' : undefined
  }
  return 'tty-mismatch'
}

/**
 * The ONE shared admission predicate. The caller supplies expected facts that
 * were derived from the Scene reservation, never from the candidate itself.
 */
export function admitPublicObservation(observation, expected = {}) {
  if (observation?.kind === 'gone') return { admitted: false, reason: 'observation-gone' }
  if (observation?.kind !== 'alive') {
    return { admitted: false, reason: 'observation-unknown', code: observation?.code ?? 'UNKNOWN' }
  }
  if (expected.birth !== undefined && observation.birth !== expected.birth) {
    return { admitted: false, reason: 'birth-mismatch' }
  }
  const argv = observation.argv
  if (!Array.isArray(argv) || argv.length < 2 || typeof argv[0] !== 'string' || argv[0] === ''
    || typeof argv[1] !== 'string' || argv[1] === '') {
    return { admitted: false, reason: 'argv-invalid' }
  }
  if (expected.entry !== undefined) {
    const actual = canonicalEntry(argv[1])
    if (actual === undefined) return { admitted: false, reason: 'canonical-entry-unreadable' }
    if (actual !== canonicalEntry(expected.entry)) {
      return { admitted: false, reason: 'canonical-entry-mismatch' }
    }
  }
  if (expected.uid !== undefined && observation.uid !== expected.uid) {
    return { admitted: false, reason: 'uid-mismatch' }
  }
  const envMap = observation.envMap
  if (expected.requireEnv === true && observation.envPresent !== true) {
    return { admitted: false, reason: 'env-missing' }
  }
  for (const [key, value] of [
    ['DSH_HOME', expected.home],
    ['SPLIT_PROCESS_PROFILE', expected.profile],
    ['SPLIT_PROCESS_DSH_ANCHOR', expected.anchor],
  ]) {
    if (value === undefined) continue
    if (envMap === undefined || !envMap.has(key)) {
      return { admitted: false, reason: 'env-missing', key }
    }
    if (envMap.get(key) !== value) return { admitted: false, reason: `${key.toLowerCase().replaceAll('_', '-')}-mismatch` }
  }
  for (const key of expected.forbidEnv ?? []) {
    if (envMap !== undefined && envMap.has(key)) return { admitted: false, reason: 'forbidden-env-present', key }
  }
  const ttyFailure = admitTty(observation, expected.tty)
  if (ttyFailure !== undefined) return { admitted: false, reason: ttyFailure }
  if (expected.groupLeader === true
    && (observation.pgid !== observation.pid || observation.sid !== observation.pid)) {
    return { admitted: false, reason: 'group-not-leader' }
  }
  if (expected.parentPid !== undefined) {
    const edge = observation.parentEdge
    if (edge?.proven !== true) {
      return { admitted: false, reason: 'parent-edge-unproven', detail: edge?.reason, definitive: edge?.definitive === true }
    }
    if (edge.parentPid !== expected.parentPid) return { admitted: false, reason: 'parent-edge-unproven' }
    if (expected.parentBirth !== undefined && edge.parentBirth !== expected.parentBirth) {
      return { admitted: false, reason: 'parent-edge-unproven' }
    }
  }
  return { admitted: true, reason: 'admitted' }
}

const DEFINITIVE_ADMISSION_REASONS = new Set([
  'birth-mismatch', 'canonical-entry-mismatch', 'uid-mismatch', 'dsh-home-mismatch',
  'split-process-profile-mismatch', 'split-process-dsh-anchor-mismatch',
  'forbidden-env-present', 'tty-mismatch', 'group-not-leader',
])

/** admitted | not-target | unknown; only a positively read mismatch may exclude. */
export function publicAdmissionDisposition(admitted) {
  if (admitted?.admitted === true) return 'admitted'
  if (admitted?.definitive === true || DEFINITIVE_ADMISSION_REASONS.has(admitted?.reason)) return 'not-target'
  return 'unknown'
}

/** The ONE capture classification: gone/unknown/captured/not-target. */
export function publicCaptureDisposition(light, full, admitted) {
  if (full?.kind === 'gone' || light?.kind === 'gone') return 'gone'
  if (full?.kind !== 'alive' || light?.kind !== 'alive') return 'unknown'
  if (light.birth !== full.birth) return 'unknown'
  if (admitted?.admitted === true) return 'captured'
  return publicAdmissionDisposition(admitted)
}

function publicTtyFacts(tty) {
  if (tty === undefined) return null
  return tty.platform === 'darwin'
    ? { platform: 'darwin', eTdev: tty.eTdev, controlling: tty.hasControllingTty }
    : { platform: 'linux', ttyNr: tty.ttyNr, fd0: tty.fd0, controlling: tty.hasControllingTty }
}

function publicProcessFacts(observation, expected) {
  return {
    pid: observation.pid,
    birth: observation.birth,
    entry: expected.receiptEntry ?? expected.entry,
    entryRealpath: canonicalEntry(observation.argv[1]),
    ppid: observation.ppid,
    parentBirth: observation.parentEdge?.parentBirth ?? null,
    pgid: observation.pgid,
    sid: observation.sid,
    uid: observation.uid,
    tty: publicTtyFacts(observation.tty),
    officialProfile: observation.envMap?.get('SPLIT_PROCESS_PROFILE') ?? null,
    officialAnchor: observation.envMap?.get('SPLIT_PROCESS_DSH_ANCHOR') ?? null,
    argv0: observation.argv[0],
    argv1: observation.argv[1],
  }
}

/**
 * Create the platform observation seam. `kernel` must be the production
 * readers: `{ read, serialize, classify, listMembers }`.
 */
export function createPublicObservation({ anchor, koffiEntry, kernel, platform = process.platform } = {}) {
  if (!isPublicObservationPlatformSupported(platform)) {
    throw new PublicObservationError('PLATFORM_UNSUPPORTED', `the public process observation does not support ${platform}`)
  }
  if (kernel === null || typeof kernel !== 'object'
    || typeof kernel.read !== 'function' || typeof kernel.serialize !== 'function'
    || typeof kernel.classify !== 'function') {
    throw new PublicObservationError('INPUT_UNQUALIFIED', 'the production kernel readers are required')
  }

  let darwin
  if (platform === 'darwin') {
    if (typeof koffiEntry !== 'string' || koffiEntry === '' || typeof anchor !== 'string' || anchor === '') {
      throw new PublicObservationError('INPUT_UNQUALIFIED', 'Darwin observation requires the installed DSH anchor and its Koffi entry')
    }
    // The production Darwin readers resolve their own bridge through the
    // installed DSH anchor. This Supervisor process is not the public CLI, so
    // set only the process-local anchor fact (the public child env is explicit).
    process.env.SPLIT_PROCESS_DSH_ANCHOR = anchor
    darwin = createDarwinBridge(koffiEntry)
  }

  function kernelState(pid) {
    let observation
    try {
      observation = kernel.read(pid)
    } catch {
      return { state: 'unknown', code: 'READ_FAILED' }
    }
    if (observation.kind === 'gone') return { state: 'gone' }
    if (observation.kind === 'unknown') return { state: 'unknown', code: observation.code }
    const classified = kernel.classify(observation)
    if (classified.state === 'unknown') return { state: 'unknown', code: 'CLASSIFY_UNKNOWN' }
    return {
      state: classified.state,
      birth: kernel.serialize(observation.identity),
      identity: observation.identity,
    }
  }

  function readDarwinTty(pid) {
    const bsd = darwin.readBsd(pid)
    if (bsd.kind !== 'ok') return bsd
    return { kind: 'ok', value: ttyFromDarwin(bsd.value), bsd: bsd.value }
  }

  function readLinuxTty(pid) {
    let stat
    try {
      stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    } catch (error) {
      return error.code === 'ENOENT' ? gone() : unknown(classifyErrno(error.code === undefined ? 0 : error.errno))
    }
    const parsed = parseLinuxStat(stat)
    if (parsed === undefined) return unknown('ABI_UNSUPPORTED')
    const fd0 = readLinuxFd0(pid)
    return { kind: 'ok', value: ttyFromLinux(parsed.ttyNr, fd0), stat: parsed, fd0 }
  }

  /**
   * The cheapest ownership prefilter: uid/name/topology without the production
   * identity bracket. It never authorizes a signal; it only avoids reading the
   * full argv/env of every unrelated system process during a global scan.
   */
  function basic(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unknown', code: 'INPUT_UNQUALIFIED' }
    if (platform === 'darwin') {
      const bsd = darwin.readBsd(pid)
      if (bsd.kind === 'ok') {
        return {
          kind: 'ok',
          pid,
          uid: bsd.value.uid,
          name: bsd.value.name,
          comm: bsd.value.comm,
          ppid: bsd.value.ppid,
          pgid: bsd.value.pgid,
        }
      }
      if (bsd.kind === 'unknown') {
        // Some system processes deny the full proc_bsdinfo read. The
        // short-bsd flavor is the real kernel UID/name prefilter; an unreadable
        // value remains unknown and fails closed.
        const short = darwin.readShortBsd(pid)
        if (short.kind === 'ok') {
          return {
            kind: 'ok',
            pid,
            uid: short.value.uid,
            name: short.value.comm,
            comm: short.value.comm,
            ppid: short.value.ppid,
            pgid: short.value.pgid,
            foreign: short.value.uid !== process.getuid?.(),
          }
        }
        return short
      }
      return bsd
    }
    const stat = readLinuxTty(pid)
    if (stat.kind !== 'ok') return stat
    let uid = readLinuxUid(pid)
    if (uid === undefined) {
      // A hidepid-style `/proc` can deny another user's status. The `/proc`
      // directory inode owner is still the kernel's process UID fact; an
      // unreadable value stays unknown.
      uid = readProcDirUid(pid)
    }
    if (!Number.isInteger(uid) || uid < 0) return unknown('ACCESS_DENIED')
    return {
      kind: 'ok',
      pid,
      uid,
      name: readLinuxComm(pid) ?? '',
      comm: readLinuxComm(pid) ?? '',
      ppid: stat.stat.ppid,
      pgid: stat.stat.pgid,
    }
  }

  function bsdBindsIdentity(bsd, identity) {
    return bsd.ppid === identity.ppid && bsd.pgid === identity.pgid && bsd.uid === identity.uid
      && bsd.startSec === identity.startSec && bsd.startUsec === identity.startUsec
      && bsd.status === identity.state
  }

  function linuxStatBindsIdentity(statFields, identity) {
    return statFields.ppid === identity.ppid && statFields.pgid === identity.pgid
      && statFields.sid === identity.sid && statFields.starttime === identity.startTicks
  }

  function identityTopologyMatches(left, right) {
    if (left.pid !== right.pid || left.ppid !== right.ppid || left.pgid !== right.pgid
      || left.sid !== right.sid || left.uid !== right.uid) return false
    if (left.platform === 'darwin' || right.platform === 'darwin') {
      return left.platform === 'darwin' && right.platform === 'darwin'
        && left.parentUniqueId === right.parentUniqueId
    }
    return true
  }

  /** One light observation: production identity plus controlling-tty facts. */
  function observe(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unknown', code: 'INPUT_UNQUALIFIED' }
    if (platform === 'darwin') {
      const stateBefore = kernelState(pid)
      if (stateBefore.state !== 'alive') return stateBefore.state === 'gone' ? gone() : unknown(stateBefore.code)
      const before = darwin.readBsd(pid)
      if (before.kind !== 'ok') return before
      if (!bsdBindsIdentity(before.value, stateBefore.identity)) return unknown('TORN_OBSERVATION')
      const stateAfter = kernelState(pid)
      if (stateAfter.state !== 'alive') return stateAfter.state === 'gone' ? gone() : unknown(stateAfter.code)
      if (stateAfter.birth !== stateBefore.birth
        || !identityTopologyMatches(stateBefore.identity, stateAfter.identity)) return unknown('TORN_OBSERVATION')
      const after = darwin.readBsd(pid)
      if (after.kind !== 'ok') return after
      if (!bsdBindsIdentity(after.value, stateAfter.identity)) return unknown('TORN_OBSERVATION')
      const a = before.value
      const b = after.value
      if (a.startSec !== b.startSec || a.startUsec !== b.startUsec || a.ppid !== b.ppid
        || a.pgid !== b.pgid || a.uid !== b.uid || a.flags !== b.flags || a.eTdev !== b.eTdev
        || a.eTpgid !== b.eTpgid || a.status !== b.status) {
        return unknown('TORN_OBSERVATION')
      }
      return {
        kind: 'alive',
        pid,
        birth: stateAfter.birth,
        identity: stateAfter.identity,
        ppid: stateAfter.identity.ppid,
        pgid: stateAfter.identity.pgid,
        sid: stateAfter.identity.sid,
        uid: stateAfter.identity.uid,
        name: a.name,
        comm: a.comm,
        tty: ttyFromDarwin(a),
      }
    }
    const stateBefore = kernelState(pid)
    if (stateBefore.state !== 'alive') return stateBefore.state === 'gone' ? gone() : unknown(stateBefore.code)
    const before = readLinuxTty(pid)
    if (before.kind !== 'ok') return before
    if (!linuxStatBindsIdentity(before.stat, stateBefore.identity)) return unknown('TORN_OBSERVATION')
    const uidBefore = readLinuxUid(pid)
    if (!Number.isInteger(uidBefore) || uidBefore < 0) return unknown('ACCESS_DENIED')
    const stateAfter = kernelState(pid)
    if (stateAfter.state !== 'alive') return stateAfter.state === 'gone' ? gone() : unknown(stateAfter.code)
    if (stateAfter.birth !== stateBefore.birth
      || !identityTopologyMatches(stateBefore.identity, stateAfter.identity)) return unknown('TORN_OBSERVATION')
    const after = readLinuxTty(pid)
    if (after.kind !== 'ok') return after
    if (!linuxStatBindsIdentity(after.stat, stateAfter.identity)) return unknown('TORN_OBSERVATION')
    const uidAfter = readLinuxUid(pid)
    if (!Number.isInteger(uidAfter) || uidAfter < 0) return unknown('ACCESS_DENIED')
    const a = before.stat
    const b = after.stat
    if (a.starttime !== b.starttime || a.ppid !== b.ppid || a.pgid !== b.pgid
      || a.sid !== b.sid || a.ttyNr !== b.ttyNr || uidBefore !== uidAfter) {
      return unknown('TORN_OBSERVATION')
    }
    return {
      kind: 'alive',
      pid,
      birth: stateAfter.birth,
      identity: stateAfter.identity,
      ppid: stateAfter.identity.ppid,
      pgid: stateAfter.identity.pgid,
      sid: stateAfter.identity.sid,
      uid: uidAfter,
      name: readLinuxComm(pid) ?? '',
      tty: before.value,
    }
  }

  function readParentEdge(pid, parentPid, parentBirth, expectedUid, childBirth) {
    const parentBefore = observe(parentPid)
    if (parentBefore.kind !== 'alive') {
      return { proven: false, definitive: false, reason: `parent-${parentBefore.kind === 'gone' ? 'gone' : 'unknown'}` }
    }
    if (parentBirth !== undefined && parentBefore.birth !== parentBirth) {
      return { proven: false, definitive: true, reason: 'parent-birth-mismatch' }
    }
    if (expectedUid !== undefined && parentBefore.uid !== expectedUid) {
      return { proven: false, definitive: true, reason: 'parent-uid-mismatch' }
    }
    const child = observe(pid)
    if (child.kind !== 'alive') return { proven: false, definitive: false, reason: `child-${child.kind}` }
    if (typeof childBirth === 'string' && child.birth !== childBirth) {
      return { proven: false, definitive: false, reason: 'child-changed' }
    }
    if (child.ppid !== parentPid) return { proven: false, definitive: true, reason: 'ppid-mismatch' }
    if (child.uid !== parentBefore.uid) return { proven: false, definitive: true, reason: 'uid-mismatch' }
    if (platform === 'darwin') {
      const childUnique = darwin.readUnique(pid)
      if (childUnique.kind !== 'ok') return { proven: false, definitive: false, reason: `child-unique-${childUnique.kind}` }
      if (childUnique.value.parentUniqueId !== parentBefore.identity.uniqueId) {
        return { proven: false, definitive: true, reason: 'parent-unique-id-mismatch' }
      }
    }
    const listedBefore = children(parentPid)
    if (listedBefore.kind !== 'ok') {
      return { proven: false, definitive: false, reason: `children-${listedBefore.kind}` }
    }
    if (!listedBefore.pids.includes(pid)) return { proven: false, definitive: true, reason: 'not-a-direct-child' }
    const parentAfter = observe(parentPid)
    if (parentAfter.kind !== 'alive' || parentAfter.birth !== parentBefore.birth) {
      return { proven: false, definitive: false, reason: 'parent-changed' }
    }
    const childAfter = observe(pid)
    if (childAfter.kind !== 'alive' || childAfter.birth !== child.birth || childAfter.ppid !== parentPid) {
      return { proven: false, definitive: false, reason: 'child-changed' }
    }
    const listedAfter = children(parentPid)
    if (listedAfter.kind !== 'ok') return { proven: false, definitive: false, reason: `children-${listedAfter.kind}` }
    if (!listedAfter.pids.includes(pid)) return { proven: false, definitive: true, reason: 'not-a-direct-child' }
    return {
      proven: true,
      parentPid,
      parentBirth: parentBefore.birth,
      ppid: child.ppid,
      parentUid: parentBefore.uid,
      childUid: child.uid,
    }
  }

  /**
   * Full observation: production identity is read before and after the narrow
   * platform facts, and every returned field must bind to those identities.
   * A parent edge is bracketed by fresh parent/child/child-enumeration reads.
   */
  function observeFull(pid, options = {}) {
    if (platform === 'darwin') {
      const stateBefore = kernelState(pid)
      if (stateBefore.state !== 'alive') return stateBefore.state === 'gone' ? gone() : unknown(stateBefore.code)
      const before = darwin.readBsd(pid)
      if (before.kind !== 'ok') return before
      if (!bsdBindsIdentity(before.value, stateBefore.identity)) return unknown('TORN_OBSERVATION')
      const queried = darwin.procargsSize(pid)
      if (queried.rc !== 0) {
        return unknown(darwin.classifyProcargsErrno(queried.errno, pid), { stage: 'size' })
      }
      const parsed = darwin.readProcargs(pid)
      if (parsed.kind !== 'ok') return parsed
      if (queried.size !== parsed.used) {
        return unknown('PROCARGS_LENGTH_MISMATCH', { query: queried.size, used: parsed.used })
      }
      const stateAfter = kernelState(pid)
      if (stateAfter.state !== 'alive') return stateAfter.state === 'gone' ? gone() : unknown(stateAfter.code)
      if (stateAfter.birth !== stateBefore.birth
        || !identityTopologyMatches(stateBefore.identity, stateAfter.identity)) return unknown('TORN_OBSERVATION')
      const after = darwin.readBsd(pid)
      if (after.kind !== 'ok') return after
      if (!bsdBindsIdentity(after.value, stateAfter.identity)) return unknown('TORN_OBSERVATION')
      const a = before.value
      const b = after.value
      if (a.startSec !== b.startSec || a.startUsec !== b.startUsec || a.ppid !== b.ppid
        || a.pgid !== b.pgid || a.uid !== b.uid || a.flags !== b.flags || a.eTdev !== b.eTdev
        || a.eTpgid !== b.eTpgid || a.status !== b.status) {
        return unknown('TORN_OBSERVATION')
      }
      const observation = {
        kind: 'alive',
        pid,
        birth: stateAfter.birth,
        identity: stateAfter.identity,
        ppid: stateAfter.identity.ppid,
        pgid: stateAfter.identity.pgid,
        sid: stateAfter.identity.sid,
        uid: stateAfter.identity.uid,
        tty: ttyFromDarwin(a),
        execPath: parsed.execPath,
        argv: parsed.argv,
        envEntries: parsed.envEntries,
        envMap: parsed.envMap,
        envPresent: parsed.envPresent,
        envSectionBytes: parsed.envSectionBytes,
        argc: parsed.argc,
        procargs: { querySize: queried.size, used: parsed.used, argmax: parsed.argmax },
      }
      if (options.parentPid !== undefined) {
        observation.parentEdge = readParentEdge(pid, options.parentPid, options.parentBirth, observation.uid, observation.birth)
      }
      return observation
    }

    const stateBefore = kernelState(pid)
    if (stateBefore.state !== 'alive') return stateBefore.state === 'gone' ? gone() : unknown(stateBefore.code)
    const before = readLinuxTty(pid)
    if (before.kind !== 'ok') return before
    if (!linuxStatBindsIdentity(before.stat, stateBefore.identity)) return unknown('TORN_OBSERVATION')
    const uidBefore = readLinuxUid(pid)
    if (!Number.isInteger(uidBefore) || uidBefore < 0) return unknown('ACCESS_DENIED')
    let cmdline
    let environ
    try {
      cmdline = readFileSync(`/proc/${String(pid)}/cmdline`)
    } catch (error) {
      return unknown('ARGV_UNREADABLE', { errno: error.code })
    }
    try {
      environ = readFileSync(`/proc/${String(pid)}/environ`)
    } catch (error) {
      return unknown('ENV_UNREADABLE', { errno: error.code })
    }
    const parsedArgv = parseLinuxCommandLine(cmdline)
    if (parsedArgv.kind !== 'ok') return parsedArgv
    const parsedEnv = parseLinuxEnvironment(environ)
    if (parsedEnv.kind !== 'ok') return parsedEnv
    const stateAfter = kernelState(pid)
    if (stateAfter.state !== 'alive') return stateAfter.state === 'gone' ? gone() : unknown(stateAfter.code)
    if (stateAfter.birth !== stateBefore.birth
      || !identityTopologyMatches(stateBefore.identity, stateAfter.identity)) return unknown('TORN_OBSERVATION')
    const after = readLinuxTty(pid)
    if (after.kind !== 'ok') return after
    if (!linuxStatBindsIdentity(after.stat, stateAfter.identity)) return unknown('TORN_OBSERVATION')
    const uidAfter = readLinuxUid(pid)
    if (!Number.isInteger(uidAfter) || uidAfter < 0) return unknown('ACCESS_DENIED')
    const a = before.stat
    const b = after.stat
    if (a.starttime !== b.starttime || a.ppid !== b.ppid || a.pgid !== b.pgid
      || a.sid !== b.sid || a.ttyNr !== b.ttyNr || uidBefore !== uidAfter) {
      return unknown('TORN_OBSERVATION')
    }
    const observation = {
      kind: 'alive',
      pid,
      birth: stateAfter.birth,
      identity: stateAfter.identity,
      ppid: stateAfter.identity.ppid,
      pgid: stateAfter.identity.pgid,
      sid: stateAfter.identity.sid,
      uid: uidAfter,
      tty: before.value,
      execPath: parsedArgv.argv[0],
      argv: parsedArgv.argv,
      envEntries: parsedEnv.envEntries,
      envMap: parsedEnv.envMap,
      envPresent: parsedEnv.envPresent,
      envSectionBytes: parsedEnv.envSectionBytes,
      argc: parsedArgv.argv.length,
    }
    if (options.parentPid !== undefined) {
      observation.parentEdge = readParentEdge(pid, options.parentPid, options.parentBirth, observation.uid, observation.birth)
    }
    return observation
  }

  /**
   * The canonical exec entry from argv only. Used as a global-scan prefilter so
   * an unrelated same-user Node process with an unreadable env tail is not
   * mistaken for a target; a real target still goes through full admission.
   */
  function argvEntry(pid) {
    if (platform === 'darwin') {
      const parsed = darwin.readProcargs(pid, { argvOnly: true })
      if (parsed.kind !== 'ok') return parsed
      if (!Array.isArray(parsed.argv) || parsed.argv.length < 2
        || typeof parsed.argv[1] !== 'string' || parsed.argv[1] === ''
        || !isAbsolute(parsed.argv[1])) {
        return { kind: 'ok', entry: null, argv: parsed.argv }
      }
      const entry = canonicalEntry(parsed.argv[1])
      if (entry === undefined) return unknown('ENTRY_UNREADABLE', { argv: parsed.argv })
      return { kind: 'ok', entry, argv: parsed.argv }
    }
    let cmdline
    try {
      cmdline = readFileSync(`/proc/${String(pid)}/cmdline`)
    } catch {
      return unknown('ARGV_UNREADABLE')
    }
    const parsed = parseLinuxCommandLine(cmdline)
    if (parsed.kind !== 'ok') return parsed
    if (!Array.isArray(parsed.argv) || parsed.argv.length < 2
      || typeof parsed.argv[1] !== 'string' || parsed.argv[1] === ''
      || !isAbsolute(parsed.argv[1])) {
      return { kind: 'ok', entry: null, argv: parsed.argv }
    }
    const entry = canonicalEntry(parsed.argv[1])
    if (entry === undefined) return unknown('ENTRY_UNREADABLE', { argv: parsed.argv })
    return { kind: 'ok', entry, argv: parsed.argv }
  }

  function capture(pid, expected = {}) {
    const light = observe(pid)
    if (light.kind === 'gone') return { kind: 'gone' }
    if (light.kind !== 'alive') return { kind: 'unknown', pid, code: light.code }
    if (expected.birth !== undefined && light.birth !== expected.birth) {
      return { kind: 'not-target', pid, reason: 'birth-mismatch' }
    }
    const full = observeFull(pid, {
      parentPid: expected.parentPid,
      parentBirth: expected.parentBirth,
    })
    const admitted = full.kind === 'alive' ? admitPublicObservation(full, expected) : undefined
    const disposition = publicCaptureDisposition(light, full, admitted)
    if (disposition === 'gone') return { kind: 'gone' }
    if (disposition === 'not-target') {
      return { kind: 'not-target', pid, reason: admitted.reason, detail: admitted }
    }
    if (disposition === 'unknown') {
      return {
        kind: 'unknown',
        pid,
        code: full.kind !== 'alive' ? full.code : (full.birth !== light.birth ? 'TORN_OBSERVATION' : `ADMISSION_${String(admitted.reason).toUpperCase().replaceAll('-', '_')}`),
        detail: admitted,
      }
    }
    return { kind: 'captured', pid, process: publicProcessFacts(full, expected), observation: full }
  }

  function children(pid, options = {}) {
    if (platform === 'darwin') {
      const before = kernelState(pid)
      if (before.state !== 'alive') return before.state === 'gone' ? gone() : unknown(before.code)
      const listed = darwin.listPids('child', pid, options.startCapacity ?? 64)
      if (listed.kind === 'gone') {
        const current = kernelState(pid)
        if (current.state === 'gone') return gone()
        return current.state === 'unknown' ? unknown(current.code) : unknown('ENUMERATION_CONTRADICTION')
      }
      if (listed.kind !== 'ok') return listed
      const after = kernelState(pid)
      if (after.state !== 'alive') return after.state === 'gone' ? gone() : unknown(after.code)
      if (after.birth !== before.birth) return unknown('TORN_OBSERVATION')
      if (listed.pids.length > 0) return listed
      // Zero is an empty child set only when the same parent birth bracketed
      // the successful list call and the API reported no error (handled by
      // listPids' errno discriminator above).
      return listed
    }
    let raw
    try {
      raw = readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        const state = kernelState(pid)
        if (state.state === 'gone') return gone()
        if (state.state === 'unknown') return unknown(state.code)
        return unknown('CHILDREN_UNREADABLE')
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') return unknown('ACCESS_DENIED')
      return unknown('READ_FAILED')
    }
    const trimmed = raw.trim()
    if (trimmed === '') {
      const state = kernelState(pid)
      if (state.state !== 'alive') return state.state === 'gone' ? gone() : unknown(state.code)
      return { kind: 'ok', pids: [], count: 0, capacity: null }
    }
    const pids = []
    for (const token of trimmed.split(/\s+/u)) {
      if (!/^\d+$/u.test(token)) return unknown('CHILDREN_FRAMING')
      pids.push(Number(token))
    }
    return { kind: 'ok', pids, count: pids.length, capacity: null }
  }

  function allPids(options = {}) {
    if (platform === 'darwin') {
      const listed = darwin.listPids('all', 0, options.startCapacity ?? 1024)
      if (listed.kind === 'ok' && listed.count === 0) return unknown('ENUMERATION_EMPTY')
      return listed
    }
    let entries
    try {
      entries = readdirSync('/proc')
    } catch (error) {
      return unknown(error.code === 'EACCES' || error.code === 'EPERM' ? 'ACCESS_DENIED' : 'READ_FAILED')
    }
    const pids = []
    for (const entry of entries) {
      if (/^\d+$/u.test(entry)) pids.push(Number(entry))
    }
    return { kind: 'ok', pids, count: pids.length, capacity: null }
  }

  /** Bounded recursive descendants. Any unknown child read fails the whole scan. */
  function descendants(rootPid) {
    const seen = new Set()
    const pending = [{ pid: rootPid, depth: 0 }]
    const pids = []
    const samples = []
    while (pending.length > 0) {
      const current = pending.shift()
      if (!Number.isInteger(current.pid) || current.pid <= 0 || seen.has(current.pid)) continue
      if (current.depth > MAX_DESCENDANT_DEPTH) return unknown('DESCENDANT_DEPTH_EXCEEDED')
      seen.add(current.pid)
      if (current.pid !== rootPid) pids.push(current.pid)
      if (pids.length > MAX_DESCENDANTS) return unknown('DESCENDANT_LIMIT_EXCEEDED')
      const listed = children(current.pid)
      if (listed.kind === 'gone') continue
      if (listed.kind === 'unknown') return listed
      samples.push({ pid: current.pid, count: listed.count, capacity: listed.capacity })
      for (const child of listed.pids) pending.push({ pid: child, depth: current.depth + 1 })
    }
    return { kind: 'ok', pids, samples }
  }

  function groupMembers(pgid) {
    if (!Number.isInteger(pgid) || pgid <= 0) return unknown('INPUT_UNQUALIFIED')
    let members
    try {
      members = kernel.listMembers(pgid)
    } catch {
      return unknown('READ_FAILED')
    }
    if (!Array.isArray(members)) return unknown(members.code ?? 'READ_FAILED')
    return {
      kind: 'ok',
      members: members.map(observation => ({
        pid: observation.identity.pid,
        birth: kernel.serialize(observation.identity),
      })),
    }
  }

  /**
   * Scan a known process tree for one admitted candidate. `none` carries the
   * unknown reads seen in this pass so the caller can report NOT_VERIFIED
   * instead of mistaking an unreadable tree for absence.
   */
  function scan(rootPid, expected = {}, options = {}) {
    const listed = descendants(rootPid)
    if (listed.kind === 'unknown') return { kind: 'unknown', code: listed.code }
    if (listed.kind === 'gone') return { kind: 'gone' }
    const candidates = options.includeRoot === true ? [rootPid, ...listed.pids] : listed.pids
    const unknownReads = []
    const notTarget = []
    for (const pid of candidates) {
      if (options.excludePids?.includes(pid) === true) continue
      const captured = capture(pid, expected)
      if (captured.kind === 'captured') return { kind: 'found', process: captured.process }
      if (captured.kind === 'unknown') unknownReads.push({ pid, code: captured.code })
      if (captured.kind === 'gone' && pid === rootPid) unknownReads.push({ pid, code: 'ROOT_GONE' })
      if (captured.kind === 'not-target') notTarget.push({ pid, reason: captured.reason })
    }
    return { kind: 'none', unknown: unknownReads, notTarget }
  }

  return {
    platform,
    probe() {
      if (platform === 'darwin') {
        return { platform, bsdBytes: BSDINFO_BYTES, argmax: darwin.argmax(), anchor }
      }
      return { platform, proc: existsSync('/proc/self/stat') }
    },
    classify(pid) {
      return kernelState(pid)
    },
    basic,
    observe,
    observeFull,
    admit: admitPublicObservation,
    parentEdge(pid, parentPid, parentBirth, childBirth) {
      return readParentEdge(pid, parentPid, parentBirth, undefined, childBirth)
    },
    capture,
    argvEntry,
    scan,
    children,
    descendants,
    allPids,
    groupMembers,
    presence: publicPathPresence,
    canonicalEntry,
    ttyFacts(pid) {
      const light = observe(pid)
      return light.kind === 'alive' ? publicTtyFacts(light.tty) : null
    },
    ttyCompareFacts(pid) {
      const light = observe(pid)
      return light.kind === 'alive' ? light.tty : null
    },
  }
}

function createDarwinBridge(koffiEntry) {
  const require = createRequire(import.meta.url)
  const koffi = require(koffiEntry)
  const libproc = koffi.load(LIBPROC)
  const libsystem = koffi.load(LIBSYSTEM)
  const bsdStruct = koffi.struct({
    pbi_flags: 'uint32',
    pbi_status: 'uint32',
    pbi_xstatus: 'uint32',
    pbi_pid: 'uint32',
    pbi_ppid: 'uint32',
    pbi_uid: 'uint32',
    pbi_gid: 'uint32',
    pbi_ruid: 'uint32',
    pbi_rgid: 'uint32',
    pbi_svuid: 'uint32',
    pbi_svgid: 'uint32',
    rfu_1: 'uint32',
    pbi_comm: koffi.array('uint8', 16),
    pbi_name: koffi.array('uint8', 32),
    pbi_nfiles: 'uint32',
    pbi_pgid: 'uint32',
    pbi_pjobc: 'uint32',
    e_tdev: 'uint32',
    e_tpgid: 'uint32',
    pbi_nice: 'int32',
    pbi_start_tvsec: 'uint64',
    pbi_start_tvusec: 'uint64',
  })
  const shortStruct = koffi.struct({
    pbsi_pid: 'uint32',
    pbsi_ppid: 'uint32',
    pbsi_pgid: 'uint32',
    pbsi_status: 'uint32',
    pbsi_comm: koffi.array('uint8', 16),
    pbsi_flags: 'uint32',
    pbsi_uid: 'uint32',
    pbsi_gid: 'uint32',
    pbsi_ruid: 'uint32',
    pbsi_rgid: 'uint32',
    pbsi_svuid: 'uint32',
    pbsi_svgid: 'uint32',
    pbsi_rfu: 'uint32',
  })
  if (koffi.sizeof(bsdStruct) !== BSDINFO_BYTES) {
    throw new PublicObservationError('ABI_UNSUPPORTED', `proc_bsdinfo ABI is ${String(koffi.sizeof(bsdStruct))} bytes`)
  }
  if (koffi.sizeof(shortStruct) !== SHORTBSDINFO_BYTES) {
    throw new PublicObservationError('ABI_UNSUPPORTED', `proc_bsdshortinfo ABI is ${String(koffi.sizeof(shortStruct))} bytes`)
  }
  const procPidinfoBsd = libproc.func('proc_pidinfo', 'int', ['int', 'int', 'uint64', koffi.out(koffi.pointer(bsdStruct)), 'int'])
  const procPidinfoShort = libproc.func('proc_pidinfo', 'int', ['int', 'int', 'uint64', koffi.out(koffi.pointer(shortStruct)), 'int'])
  const procListChildPids = libproc.func('proc_listchildpids', 'int', ['int', 'void *', 'int'])
  const procListAllPids = libproc.func('proc_listallpids', 'int', ['void *', 'int'])
  const sysctl = libsystem.func('sysctl', 'int', ['int *', 'uint', 'void *', koffi.inout(koffi.pointer(koffi.types.size_t)), 'void *', 'size_t'])
  const sysctlByName = libsystem.func('sysctlbyname', 'int', ['const char *', 'void *', koffi.inout(koffi.pointer(koffi.types.size_t)), 'void *', 'size_t'])

  function classifyLibproc(expected, actual) {
    return classifyDarwinReadOutcome(expected, actual, koffi.errno())
  }

  function readBsd(pid) {
    const out = {}
    let actual
    try {
      actual = procPidinfoBsd(pid, PROC_PIDTBSDINFO, 0, out, BSDINFO_BYTES)
    } catch {
      return unknown('READ_FAILED')
    }
    const classified = classifyLibproc(BSDINFO_BYTES, actual)
    if (classified.kind !== 'ok') return classified
    try {
      const observedPid = requireInteger(out.pbi_pid, 'pbi_pid')
      if (observedPid !== pid) return unknown('ABI_UNSUPPORTED')
      const flags = requireInteger(out.pbi_flags, 'pbi_flags')
      const eTdev = requireInteger(out.e_tdev, 'e_tdev')
      return {
        kind: 'ok',
        value: {
          pid: observedPid,
          ppid: requireInteger(out.pbi_ppid, 'pbi_ppid'),
          pgid: requireInteger(out.pbi_pgid, 'pbi_pgid'),
          uid: requireInteger(out.pbi_uid, 'pbi_uid'),
          status: requireInteger(out.pbi_status, 'pbi_status'),
          flags,
          eTdev,
          eTpgid: requireInteger(out.e_tpgid, 'e_tpgid'),
          comm: decodeFixed(out.pbi_comm),
          name: decodeFixed(out.pbi_name),
          hasControllingTty: (flags & PROC_FLAG_CONTROLT) !== 0,
          noControllingTty: (flags & PROC_FLAG_CONTROLT) === 0 && eTdev === NODEV32,
          startSec: decimal(out.pbi_start_tvsec),
          startUsec: decimal(out.pbi_start_tvusec),
        },
      }
    } catch {
      return unknown('ABI_UNSUPPORTED')
    }
  }

  function readShortBsd(pid) {
    const out = {}
    let actual
    try {
      actual = procPidinfoShort(pid, PROC_PIDT_SHORTBSDINFO, 0, out, SHORTBSDINFO_BYTES)
    } catch {
      return unknown('READ_FAILED')
    }
    const classified = classifyLibproc(SHORTBSDINFO_BYTES, actual)
    if (classified.kind !== 'ok') return classified
    try {
      const observedPid = requireInteger(out.pbsi_pid, 'pbsi_pid')
      if (observedPid !== pid) return unknown('ABI_UNSUPPORTED')
      return {
        kind: 'ok',
        value: {
          pid: observedPid,
          ppid: requireInteger(out.pbsi_ppid, 'pbsi_ppid'),
          pgid: requireInteger(out.pbsi_pgid, 'pbsi_pgid'),
          status: requireInteger(out.pbsi_status, 'pbsi_status'),
          flags: requireInteger(out.pbsi_flags, 'pbsi_flags'),
          uid: requireInteger(out.pbsi_uid, 'pbsi_uid'),
          comm: decodeFixed(out.pbsi_comm),
        },
      }
    } catch {
      return unknown('ABI_UNSUPPORTED')
    }
  }

  function readUnique(pid) {
    const result = readDarwinUniqueInfo(pid)
    if (result.kind !== 'ok') return result
    return {
      kind: 'ok',
      value: {
        uniqueId: result.value.uniqueId,
        parentUniqueId: result.value.parentUniqueId,
        processUUID: result.value.processUuid,
      },
    }
  }

  function argmax() {
    const bytes = Buffer.alloc(4)
    const length = [4]
    let rc
    try {
      rc = sysctlByName('kern.argmax', bytes, length, null, 0)
    } catch {
      return unknown('READ_FAILED')
    }
    if (rc !== 0 || length[0] !== 4) return unknown('READ_FAILED')
    return { kind: 'ok', value: bytes.readInt32LE(0) }
  }

  function procargsSize(pid) {
    const mib = [CTL_KERN, KERN_PROCARGS2, pid]
    const size = [0]
    let rc
    try {
      rc = sysctl(mib, mib.length, null, size, null, 0)
    } catch {
      return { rc: -1, errno: EFAULT, size: 0, mib }
    }
    return { rc, errno: koffi.errno(), size: size[0], mib }
  }

  function classifyProcargsErrno(errno, pid) {
    if (errno === ESRCH) return 'PROCARGS_GONE'
    if (errno === EPERM || errno === EACCES) return 'ACCESS_DENIED'
    if (errno === EFAULT || errno === ENOMEM) return 'READ_FAILED'
    if (errno !== EINVAL) return 'READ_FAILED'
    const bsd = readBsd(pid)
    if (bsd.kind === 'gone') return 'PROCARGS_GONE'
    if (bsd.kind === 'unknown' && bsd.code === 'ACCESS_DENIED') return 'ACCESS_DENIED'
    return 'READ_FAILED'
  }

  function readProcargs(pid, options = {}) {
    const max = argmax()
    if (max.kind !== 'ok' || max.value <= 0 || max.value > 16 * 1024 * 1024) {
      return unknown('ABI_UNSUPPORTED')
    }
    const queried = procargsSize(pid)
    if (queried.rc !== 0) return unknown(classifyProcargsErrno(queried.errno, pid), { stage: 'size' })
    const size = queried.size
    if (!Number.isInteger(size) || size < 4 || size > max.value) return unknown('ABI_UNSUPPORTED')
    const buffer = Buffer.alloc(size)
    const length = [size]
    let rc
    try {
      rc = sysctl(queried.mib, queried.mib.length, buffer, length, null, 0)
    } catch {
      return unknown('READ_FAILED', { stage: 'read' })
    }
    if (rc !== 0) return unknown(classifyProcargsErrno(koffi.errno(), pid), { stage: 'read' })
    const used = length[0]
    if (!Number.isInteger(used) || used < 4 || used > size) return unknown('ABI_UNSUPPORTED')
    if (used !== size) return unknown('PROCARGS_LENGTH_MISMATCH', { query: size, used })
    const parsed = parseDarwinProcargs(buffer, used)
    if (parsed.kind !== 'ok') {
      if (options?.argvOnly === true) {
        const argvOnly = parseDarwinProcargsArgv(buffer, used)
        if (argvOnly.kind === 'ok') return { ...argvOnly, used, argmax: max.value }
      }
      return parsed
    }
    return { ...parsed, used, argmax: max.value }
  }

  function listPids(kind, arg, startCapacity) {
    let capacity = startCapacity
    for (;;) {
      if (capacity > MAX_PID_ENUMERATION) return unknown('ENUMERATION_LIMIT')
      const bytes = Buffer.alloc(capacity * 4)
      let count
      koffi.errno(0)
      try {
        count = kind === 'all'
          ? procListAllPids(bytes, bytes.length)
          : procListChildPids(arg, bytes, bytes.length)
      } catch {
        return unknown('READ_FAILED')
      }
      const errno = koffi.errno()
      if (count < 0 || (count === 0 && errno !== 0)) {
        if (errno === ESRCH) return gone()
        if (errno === EPERM || errno === EACCES) return unknown('ACCESS_DENIED')
        return unknown('ENUMERATION_ERROR', { count, errno })
      }
      if (count > capacity) return unknown('ENUMERATION_OVERSIZE', { count, capacity })
      const values = []
      for (let index = 0; index < count; index += 1) values.push(bytes.readInt32LE(index * 4))
      const decoded = decodePidSlots(values)
      if (decoded.kind !== 'ok') return unknown(decoded.code)
      if (decoded.pids.length === 0 && kind === 'all') {
        return unknown('ENUMERATION_EMPTY', { count, emptySlots: decoded.emptySlots })
      }
      if (count < capacity) {
        return { kind: 'ok', pids: decoded.pids, count, capacity, emptySlots: decoded.emptySlots }
      }
      capacity *= 2
    }
  }

  return {
    readBsd,
    readShortBsd,
    readUnique,
    procargsSize,
    classifyProcargsErrno,
    readProcargs,
    argmax,
    listPids,
  }
}
