/**
 * Darwin native process-identity bridge: libproc and libc through a lazily
 * loaded Koffi binding. This module is the ONLY owner of the Darwin FFI layout
 * and errno taxonomy; it decodes kernel facts and returns them, and never
 * decides whether a numeric pid may be signalled.
 *
 * The binding is loaded on first use, so importing this module on Linux loads
 * neither the Koffi native addon nor `libproc.dylib`. The ABI is checked before
 * any read: the two struct sizes this build expects (136-byte `proc_bsdinfo`
 * and the 56-byte private flavor-17 `proc_uniqidentifierinfo`) are asserted
 * with `koffi.sizeof`, and every read must return EXACTLY the expected byte
 * count — a shorter or longer reply is an unsupported ABI, never a silently
 * truncated identity.
 *
 * @module runtime/native-process/darwin
 */

import { createRequire } from 'node:module'
import type { KernelReadFailureCode } from './identity.ts'

/** `sizeof(struct proc_bsdinfo)` on the qualified Darwin ABI (Q0: 136 bytes). */
export const DARWIN_BSDINFO_BYTES = 136
/** `sizeof(struct proc_uniqidentifierinfo)` on flavor 17 (Q0: 56 bytes). A
 * kernel that answers the historical 40-byte struct is an unsupported ABI. */
export const DARWIN_UNIQINFO_BYTES = 56
/** `<sys/proc_info.h>`: PROC_PIDTBSDINFO. */
const PROC_PIDTBSDINFO_FLAVOR = 3
/** XNU's private flavor 17 (PROC_PIDUNIQIDENTIFIERINFO), not in the public SDK. */
const PROC_PIDUNIQIDENTIFIER_FLAVOR = 17
const LIBPROC = '/usr/lib/libproc.dylib'
const LIBSYSTEM = '/usr/lib/libSystem.B.dylib'
const ESRCH = 3
const EPERM = 1
const EACCES = 13
const EINVAL = 22
/** `kern.bootsessionuuid` capacity — the UUID text is 36 bytes plus NUL. */
const BOOT_UUID_CAPACITY = 128

/** The identity fields this build needs from `proc_bsdinfo`. */
export interface DarwinBsdInfo {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly uid: number
  /** `pbi_status` (2 = running, 5 = zombie; a zombie is invisible to libproc). */
  readonly status: number
  readonly startSec: string
  readonly startUsec: string
}

/** The identity fields this build needs from flavor 17. */
export interface DarwinUniqueInfo {
  readonly uniqueId: string
  readonly parentUniqueId: string
  /** The process UUID (`p_uuid`) as lowercase hex. */
  readonly processUuid: string
}

/** One decoded native fact, or the reason it could not be decoded. */
export type DarwinNativeResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode }

/**
 * Classify one libproc read outcome into this repository's observation
 * taxonomy. `expectedBytes` is the ABI struct size this build was written for;
 * `actualBytes` is what the kernel reported. A positive-but-different reply is
 * an ABI mismatch even when the kernel also set an errno: the reply must never
 * be truncated or reinterpreted.
 */
export function classifyDarwinReadOutcome(
  expectedBytes: number,
  actualBytes: number,
  errno: number,
): { readonly kind: 'ok' } | { readonly kind: 'gone' } | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode } {
  if (actualBytes === expectedBytes && expectedBytes > 0) return { kind: 'ok' }
  if (actualBytes > 0) return { kind: 'unknown', code: 'ABI_UNSUPPORTED' }
  if (errno === ESRCH) return { kind: 'gone' }
  if (errno === EPERM || errno === EACCES) return { kind: 'unknown', code: 'ACCESS_DENIED' }
  if (errno === EINVAL) return { kind: 'unknown', code: 'ABI_UNSUPPORTED' }
  return { kind: 'unknown', code: 'READ_FAILED' }
}

/** A 64-bit kernel counter as an exact decimal string (Koffi yields a BigInt
 * only when the value would lose precision as a JS number). */
function decimal(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new Error(`expected an exact 64-bit integer, got ${String(value)}`)
}

interface DarwinBridge {
  readonly koffi: typeof import('koffi')
  readonly procPidinfoBsd: (...args: unknown[]) => number
  readonly procPidinfoUniq: (...args: unknown[]) => number
  readonly procListPgrpPids: (...args: unknown[]) => number
  readonly sysctlByName: (...args: unknown[]) => number
  readonly getsid: (...args: unknown[]) => number
}

type BridgeLoad = { readonly ok: true; readonly bridge: DarwinBridge } | { readonly ok: false; readonly code: KernelReadFailureCode }

let loaded: BridgeLoad | undefined

/** Load and ABI-check the Darwin bridge once per process. The loader itself
 * never throws: an unavailable dylib/addon or an unexpected struct size is a
 * classified observation, and the caller fails closed. */
function loadBridge(): BridgeLoad {
  if (loaded !== undefined) return loaded
  let result: BridgeLoad
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as typeof import('koffi')
    const libproc = koffi.load(LIBPROC)
    const libsystem = koffi.load(LIBSYSTEM)
    const bsdInfo = koffi.struct({
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
    const uniqueInfo = koffi.struct({
      p_uuid: koffi.array('uint8', 16),
      p_uniqueid: 'uint64',
      p_puniqueid: 'uint64',
      p_reserve: koffi.array('int32', 6),
    })
    if (koffi.sizeof(bsdInfo) !== DARWIN_BSDINFO_BYTES || koffi.sizeof(uniqueInfo) !== DARWIN_UNIQINFO_BYTES) {
      result = { ok: false, code: 'ABI_UNSUPPORTED' }
    } else {
      result = {
        ok: true,
        bridge: {
          koffi,
          procPidinfoBsd: libproc.func('proc_pidinfo', 'int', ['int', 'int', 'uint64', koffi.out(koffi.pointer(bsdInfo)), 'int']),
          procPidinfoUniq: libproc.func('proc_pidinfo', 'int', ['int', 'int', 'uint64', koffi.out(koffi.pointer(uniqueInfo)), 'int']),
          procListPgrpPids: libproc.func('proc_listpgrppids', 'int', ['int', 'void *', 'int']),
          sysctlByName: libsystem.func('sysctlbyname', 'int', ['const char *', 'void *', koffi.inout(koffi.pointer(koffi.types.size_t)), 'void *', 'size_t']),
          getsid: libsystem.func('getsid', 'int', ['int']),
        },
      }
    }
  } catch {
    result = { ok: false, code: 'NATIVE_UNAVAILABLE' }
  }
  loaded = result
  return result
}

/** One libproc read, classified. `read` returns the kernel byte count. */
function readRecord<T>(expectedBytes: number, read: (out: Record<string, unknown>, bridge: DarwinBridge) => number, decode: (out: Record<string, unknown>) => T): DarwinNativeResult<T> {
  const load = loadBridge()
  if (!load.ok) return { kind: 'unknown', code: load.code }
  const out: Record<string, unknown> = {}
  let actual: number
  try {
    actual = read(out, load.bridge)
  } catch {
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  const classified = classifyDarwinReadOutcome(expectedBytes, actual, load.bridge.koffi.errno())
  if (classified.kind !== 'ok') return classified
  try {
    return { kind: 'ok', value: decode(out) }
  } catch {
    // A structurally unusable reply (missing/wrong-typed fields) is not an
    // identity: treat it as an unsupported ABI rather than guessing.
    return { kind: 'unknown', code: 'ABI_UNSUPPORTED' }
  }
}

function integerField(out: Record<string, unknown>, name: string): number {
  const value = out[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name} is not an integer`)
  return value
}

/** `proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ...)` decoded. */
export function readDarwinBsdInfo(pid: number): DarwinNativeResult<DarwinBsdInfo> {
  return readRecord(DARWIN_BSDINFO_BYTES, (out, bridge) => bridge.procPidinfoBsd(pid, PROC_PIDTBSDINFO_FLAVOR, 0, out, DARWIN_BSDINFO_BYTES), (out) => {
    const observedPid = integerField(out, 'pbi_pid')
    if (observedPid !== pid) throw new Error('proc_pidinfo returned another pid')
    return {
      pid: observedPid,
      ppid: integerField(out, 'pbi_ppid'),
      pgid: integerField(out, 'pbi_pgid'),
      uid: integerField(out, 'pbi_uid'),
      status: integerField(out, 'pbi_status'),
      startSec: decimal(out['pbi_start_tvsec']),
      startUsec: decimal(out['pbi_start_tvusec']),
    }
  })
}

/** `proc_pidinfo(pid, flavor 17, 0, ...)` decoded. */
export function readDarwinUniqueInfo(pid: number): DarwinNativeResult<DarwinUniqueInfo> {
  return readRecord(DARWIN_UNIQINFO_BYTES, (out, bridge) => bridge.procPidinfoUniq(pid, PROC_PIDUNIQIDENTIFIER_FLAVOR, 0, out, DARWIN_UNIQINFO_BYTES), (out) => {
    const uuid = out['p_uuid']
    if (!(uuid instanceof Uint8Array) || uuid.length !== 16) throw new Error('p_uuid is not 16 bytes')
    return {
      uniqueId: decimal(out['p_uniqueid']),
      parentUniqueId: decimal(out['p_puniqueid']),
      processUuid: [...uuid].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    }
  })
}

/** `sysctlbyname("kern.bootsessionuuid")` decoded. */
export function readDarwinBootSessionUuid(): DarwinNativeResult<string> {
  const load = loadBridge()
  if (!load.ok) return { kind: 'unknown', code: load.code }
  const bytes = Buffer.alloc(BOOT_UUID_CAPACITY)
  const length = [BOOT_UUID_CAPACITY]
  let rc: number
  try {
    rc = load.bridge.sysctlByName('kern.bootsessionuuid', bytes, length, null, 0)
  } catch {
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  if (rc !== 0) return classifySysctlFailure(load.bridge.koffi.errno())
  const used = length[0]
  if (typeof used !== 'number' || used < 2 || used > BOOT_UUID_CAPACITY || bytes[used - 1] !== 0) {
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  const value = bytes.toString('utf8', 0, used - 1)
  if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu.test(value)) {
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  return { kind: 'ok', value }
}

function classifySysctlFailure(errno: number): { readonly kind: 'unknown'; readonly code: KernelReadFailureCode } {
  if (errno === EPERM || errno === EACCES) return { kind: 'unknown', code: 'ACCESS_DENIED' }
  if (errno === EINVAL) return { kind: 'unknown', code: 'ABI_UNSUPPORTED' }
  return { kind: 'unknown', code: 'READ_FAILED' }
}

/** `getsid(pid)`: the kernel session id of one process. */
export function readDarwinSessionId(pid: number): DarwinNativeResult<number> {
  const load = loadBridge()
  if (!load.ok) return { kind: 'unknown', code: load.code }
  let sid: number
  try {
    sid = load.bridge.getsid(pid)
  } catch {
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  if (sid > 0) return { kind: 'ok', value: sid }
  const errno = load.bridge.koffi.errno()
  if (errno === ESRCH) return { kind: 'gone' }
  if (errno === EPERM || errno === EACCES) return { kind: 'unknown', code: 'ACCESS_DENIED' }
  return { kind: 'unknown', code: 'READ_FAILED' }
}

/**
 * `proc_listpgrppids(pgid)`: the pids currently in one process group. The
 * buffer grows until the kernel reports it fits; a negative reply is a
 * classified read failure, never an empty group.
 */
export function listDarwinProcessGroupPids(pgid: number): DarwinNativeResult<number[]> {
  const load = loadBridge()
  if (!load.ok) return { kind: 'unknown', code: load.code }
  let capacity = 32
  for (;;) {
    const bytes = Buffer.alloc(capacity * 4)
    let count: number
    try {
      count = load.bridge.procListPgrpPids(pgid, bytes, bytes.length)
    } catch {
      return { kind: 'unknown', code: 'READ_FAILED' }
    }
    if (count < 0) {
      const errno = load.bridge.koffi.errno()
      if (errno === EPERM || errno === EACCES) return { kind: 'unknown', code: 'ACCESS_DENIED' }
      if (errno === ESRCH) return { kind: 'gone' }
      return { kind: 'unknown', code: 'READ_FAILED' }
    }
    const pids: number[] = []
    for (let index = 0; index < Math.min(count, capacity); index += 1) {
      const pid = bytes.readInt32LE(index * 4)
      if (pid > 0) pids.push(pid)
    }
    // A full buffer may have been truncated: grow and re-read.
    if (count < capacity) return { kind: 'ok', value: pids }
    capacity *= 2
  }
}
