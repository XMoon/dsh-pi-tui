/**
 * Win32 native process identity, kernel seats, per-instance stop events and
 * private object-security primitives.
 *
 * This module is the ONLY owner of the Win32 FFI layout for these operations.
 * It lazily loads Koffi from the running DSH installation (the verified anchor
 * -> `@deepseek-ai/dsh-subprocess-local` -> that package's own declared
 * `koffi`), decodes exact kernel facts and never decides product policy.
 *
 * The module is imported on every platform (it is part of the native-process
 * layer), but no DLL is loaded until a Win32 function is actually called.
 *
 * @module runtime/native-process/win32
 */

import { createRequire } from 'node:module'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { KernelObservation, KernelReadFailureCode, Win32KernelProcessIdentity } from './identity.ts'
import { installedDshAnchor, resolveDshKoffi } from './installed-dsh.ts'

/** Stable Win32 native failure codes that are not kernel-observation outcomes. */
export type Win32NativeFailure = 'NATIVE_UNAVAILABLE' | 'ABI_UNSUPPORTED' | 'ACCESS_DENIED' | 'READ_FAILED'

/** A held Win32 kernel handle. Koffi pointer values are opaque BigInt handles. */
export type Win32Handle = bigint & { readonly __win32Handle?: never }

/** One owned Win32 process handle and the exact identity it names. */
export interface Win32ProcessCapture {
  readonly handle: Win32Handle
  readonly identity: Win32KernelProcessIdentity
}

/** The result of opening a process handle for a destructive operation. */
export type Win32ProcessOpen =
  | { readonly kind: 'ok'; readonly capture: Win32ProcessCapture }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode }

/** One bounded native wait outcome. */
export interface Win32WaitOutcome {
  readonly kind: 'terminal' | 'timeout' | 'failed'
  readonly code: number
}

/** The security descriptor view this module verifies for private objects. */
export interface Win32SecurityView {
  readonly ownerSid: string | null
  readonly daclPresent: boolean
  readonly daclProtected: boolean
  readonly daclNull: boolean
  readonly aces: readonly { readonly sid: string; readonly mask: number; readonly type: number; readonly flags: number }[]
}

/** A held named kernel seat. */
export interface Win32KernelSeat {
  assertCurrent(): void
  close(): Promise<void>
}

/** One per-instance stop-event waiter owned by the Host entry. */
export interface Win32StopWaiter {
  /** The exact event name derived from scopeId + instanceId. */
  readonly eventName: string
  /** Resolves once when the stop event is signalled; a cancel does not resolve it. */
  readonly stopped: Promise<void>
  /** Wake and join the native waiter, then close both handles. Idempotent. */
  close(): Promise<void>
}

/** One opened control-side stop event. */
export interface Win32StopSignal {
  setOnce(): void
  close(): void
}

interface BindingContext {
  readonly koffi: typeof import('koffi')
  readonly kernel32: ReturnType<typeof import('koffi').load>
  readonly advapi32: ReturnType<typeof import('koffi').load>
}

interface Win32Bridge {
  readonly koffi: typeof import('koffi')
  readonly closeHandle: (handle: Win32Handle) => boolean
  readonly getLastError: () => number
  readonly setLastError: (code: number) => void
  readonly openProcess: (access: number, inherit: boolean, pid: number) => Win32Handle | null
  readonly getProcessTimes: (handle: Win32Handle, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer) => boolean
  readonly waitForSingleObject: ((handle: Win32Handle, milliseconds: number) => number) & { async(handle: Win32Handle, milliseconds: number, callback: (error: Error | null, code: number) => void): void }
  readonly waitForMultipleObjects: ((count: number, handles: BigInt64Array | bigint[], waitAll: number, milliseconds: number) => number) & { async(count: number, handles: BigInt64Array | bigint[], waitAll: number, milliseconds: number, callback: (error: Error | null, code: number) => void): void }
  readonly openProcessToken: (handle: Win32Handle, access: number, tokenOut: Buffer) => boolean
  readonly getTokenInformation: (token: Win32Handle, cls: number, info: Buffer, len: number, retLen: Buffer) => boolean
  readonly createMutexW: (attributes: Buffer | null, initialOwner: number, name: string) => Win32Handle | null
  readonly releaseMutex: (handle: Win32Handle) => boolean
  readonly createEventW: (attributes: Buffer | null, manualReset: number, initialState: number, name: string | null) => Win32Handle | null
  readonly openEventW: (access: number, inherit: number, name: string) => Win32Handle | null
  readonly setEvent: (handle: Win32Handle) => boolean
  readonly createDirectoryW: (path: string, attributes: Buffer | null) => boolean
  readonly createFileW: (path: string, access: number, share: number, attributes: Buffer | null, disposition: number, flags: number, template: null) => Win32Handle | null
  readonly getFileAttributesW: (path: string) => number
  readonly getDriveTypeW: (root: string) => number
  readonly getVolumeInformationW: (root: string, name: Buffer | null, nameLen: number, serial: Buffer | null, maxComponent: Buffer | null, flags: Buffer | null, fsName: Buffer, fsNameLen: number) => boolean
  readonly convertStringSecurityDescriptor: (sddl: string, revision: number, sdOut: Buffer, sizeOut: Buffer) => boolean
  readonly getSecurityInfo: (handle: Win32Handle, objectType: number, securityInfo: number, ownerOut: Buffer, groupOut: Buffer, daclOut: Buffer, saclOut: Buffer, sdOut: Buffer) => number
  readonly getSecurityDescriptorLength: (sd: Win32Handle) => number
  readonly getSecurityDescriptorControl: (sd: Win32Handle, controlOut: Buffer, revisionOut: Buffer) => boolean
  readonly localFree: (memory: Win32Handle) => Win32Handle | null
}

const ERROR_INVALID_PARAMETER = 87
const ERROR_ACCESS_DENIED = 5
const ERROR_INVALID_HANDLE = 6
const ERROR_INSUFFICIENT_BUFFER = 122
const WAIT_OBJECT_0 = 0
const WAIT_ABANDONED = 0x80
const WAIT_TIMEOUT = 0x102
const WAIT_FAILED = 0xffffffff
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x100000
const TOKEN_QUERY = 0x0008
const EVENT_MODIFY_STATE = 0x0002
const READ_CONTROL = 0x00020000
const FILE_READ_ATTRIBUTES = 0x80
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const FILE_SHARE_ALL = 0x7
const OPEN_EXISTING = 3
const DRIVE_FIXED = 3
const SE_FILE_OBJECT = 1
const SE_KERNEL_OBJECT = 6
const OBJECT_INHERIT_ACE = 0x1
const CONTAINER_INHERIT_ACE = 0x2
const OWNER_SECURITY_INFORMATION = 0x1
const DACL_SECURITY_INFORMATION = 0x4
const SE_DACL_PRESENT = 0x0004
const SE_DACL_PROTECTED = 0x1000
const SDDL_REVISION_1 = 1

let loaded: { readonly ok: true; readonly bridge: Win32Bridge } | { readonly ok: false; readonly code: Win32NativeFailure } | undefined

type NativeCall = (...args: never[]) => unknown

function bind(context: BindingContext, library: ReturnType<typeof import('koffi').load>, name: string, result: string, args: readonly string[]): NativeCall {
  return library.func('__stdcall', name, result, [...args]) as unknown as NativeCall
}

function loadBridge(): { readonly ok: true; readonly bridge: Win32Bridge } | { readonly ok: false; readonly code: Win32NativeFailure } {
  if (loaded !== undefined) return loaded
  let result: { readonly ok: true; readonly bridge: Win32Bridge } | { readonly ok: false; readonly code: Win32NativeFailure }
  try {
    const anchor = installedDshAnchor()
    if (anchor === undefined) throw new Error('native win32: no installed DSH anchor')
    const koffi = createRequire(import.meta.url)(resolveDshKoffi(anchor)) as typeof import('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const context: BindingContext = { koffi, kernel32, advapi32 }
    result = {
      ok: true,
      bridge: {
        koffi,
        closeHandle: bind(context, kernel32, 'CloseHandle', 'int', ['void *']) as unknown as Win32Bridge['closeHandle'],
        getLastError: bind(context, kernel32, 'GetLastError', 'uint32', []) as unknown as Win32Bridge['getLastError'],
        setLastError: bind(context, kernel32, 'SetLastError', 'void', ['uint32']) as unknown as Win32Bridge['setLastError'],
        openProcess: bind(context, kernel32, 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']) as unknown as Win32Bridge['openProcess'],
        getProcessTimes: bind(context, kernel32, 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *']) as unknown as Win32Bridge['getProcessTimes'],
        waitForSingleObject: bind(context, kernel32, 'WaitForSingleObject', 'uint32', ['void *', 'uint32']) as unknown as Win32Bridge['waitForSingleObject'],
        waitForMultipleObjects: bind(context, kernel32, 'WaitForMultipleObjects', 'uint32', ['uint32', 'uintptr_t *', 'int', 'uint32']) as unknown as Win32Bridge['waitForMultipleObjects'],
        openProcessToken: bind(context, kernel32, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *']) as unknown as Win32Bridge['openProcessToken'],
        getTokenInformation: bind(context, advapi32, 'GetTokenInformation', 'int', ['void *', 'uint32', 'void *', 'uint32', 'void *']) as unknown as Win32Bridge['getTokenInformation'],
        createMutexW: bind(context, kernel32, 'CreateMutexW', 'void *', ['void *', 'int', 'const char16_t *']) as unknown as Win32Bridge['createMutexW'],
        releaseMutex: bind(context, kernel32, 'ReleaseMutex', 'int', ['void *']) as unknown as Win32Bridge['releaseMutex'],
        createEventW: bind(context, kernel32, 'CreateEventW', 'void *', ['void *', 'int', 'int', 'const char16_t *']) as unknown as Win32Bridge['createEventW'],
        openEventW: bind(context, kernel32, 'OpenEventW', 'void *', ['uint32', 'int', 'const char16_t *']) as unknown as Win32Bridge['openEventW'],
        setEvent: bind(context, kernel32, 'SetEvent', 'int', ['void *']) as unknown as Win32Bridge['setEvent'],
        createDirectoryW: bind(context, kernel32, 'CreateDirectoryW', 'int', ['const char16_t *', 'void *']) as unknown as Win32Bridge['createDirectoryW'],
        createFileW: bind(context, kernel32, 'CreateFileW', 'void *', ['const char16_t *', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']) as unknown as Win32Bridge['createFileW'],
        getFileAttributesW: bind(context, kernel32, 'GetFileAttributesW', 'uint32', ['const char16_t *']) as unknown as Win32Bridge['getFileAttributesW'],
        getDriveTypeW: bind(context, kernel32, 'GetDriveTypeW', 'uint32', ['const char16_t *']) as unknown as Win32Bridge['getDriveTypeW'],
        getVolumeInformationW: bind(context, kernel32, 'GetVolumeInformationW', 'int', ['const char16_t *', 'void *', 'uint32', 'void *', 'void *', 'void *', 'void *', 'uint32']) as unknown as Win32Bridge['getVolumeInformationW'],
        convertStringSecurityDescriptor: bind(context, advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['const char16_t *', 'uint32', 'void *', 'void *']) as unknown as Win32Bridge['convertStringSecurityDescriptor'],
        getSecurityInfo: bind(context, advapi32, 'GetSecurityInfo', 'uint32', ['void *', 'int', 'uint32', 'void *', 'void *', 'void *', 'void *', 'void *']) as unknown as Win32Bridge['getSecurityInfo'],
        getSecurityDescriptorLength: bind(context, advapi32, 'GetSecurityDescriptorLength', 'uint32', ['void *']) as unknown as Win32Bridge['getSecurityDescriptorLength'],
        getSecurityDescriptorControl: bind(context, advapi32, 'GetSecurityDescriptorControl', 'int', ['void *', 'void *', 'void *']) as unknown as Win32Bridge['getSecurityDescriptorControl'],
        localFree: bind(context, kernel32, 'LocalFree', 'void *', ['void *']) as unknown as Win32Bridge['localFree'],
      },
    }
  } catch {
    result = { ok: false, code: 'NATIVE_UNAVAILABLE' }
  }
  loaded = result
  return result
}

/** `GetLastError()` from the live bridge, or 0 when the native addon is unavailable. */
function lastError(bridge: Win32Bridge): number {
  return bridge.getLastError()
}

/** A wide (UTF-16RO) Koffi string is passed through the `const char16_t *` type. */
function parseSid(bytes: Buffer, offset: number): string {
  const revision = bytes[offset]!
  const count = bytes[offset + 1]!
  let authority = 0n
  for (let i = 0; i < 6; i += 1) authority = (authority << 8n) | BigInt(bytes[offset + 2 + i]!)
  let value = `S-${revision}-${authority}`
  for (let i = 0; i < count; i += 1) value += `-${bytes.readUInt32LE(offset + 8 + i * 4)}`
  return value
}

function filetimeFrom(buffer: Buffer, offset: number): string {
  const low = buffer.readUInt32LE(offset)
  const high = buffer.readUInt32LE(offset + 4)
  return ((BigInt(high) << 32n) | BigInt(low)).toString(10)
}

/** The SID of the token's real user (TokenUser), never a username or environment value. */
export function win32CurrentTokenSid(): string | undefined {
  const load = loadBridge()
  if (!load.ok) return undefined
  const bridge = load.bridge
  const processHandle = bridge.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, process.pid)
  if (processHandle === null || processHandle === undefined) return undefined
  const token = Buffer.alloc(8)
  if (!bridge.openProcessToken(processHandle, TOKEN_QUERY, token)) {
    bridge.closeHandle(processHandle)
    return undefined
  }
  const tokenHandle = token.readBigUInt64LE(0) as unknown as Win32Handle
  try {
    const needed = Buffer.alloc(4)
    bridge.getTokenInformation(tokenHandle, 1, Buffer.alloc(0), 0, needed)
    const length = needed.readUInt32LE(0)
    if (length === 0) return undefined
    const info = Buffer.alloc(length)
    if (!bridge.getTokenInformation(tokenHandle, 1, info, length, needed)) return undefined
    const sidAddress = info.readBigUInt64LE(0)
    return parseSid(info, Number(sidAddress - (bridge.koffi.address(info) as unknown as bigint)))
  } finally {
    bridge.closeHandle(tokenHandle)
    bridge.closeHandle(processHandle)
  }
}

/** Read one process identity through a freshly opened observation handle. */
function readWin32KernelProcess(pid: number): KernelObservation {
  const opened = openWin32Process(pid)
  if (opened.kind !== 'ok') return opened
  const load = loadBridge()
  if (!load.ok) {
    closeWin32Handle(opened.capture.handle)
    return { kind: 'unknown', code: load.code }
  }
  try {
    const code = load.bridge.waitForSingleObject(opened.capture.handle, 0)
    if (code === WAIT_TIMEOUT) return { kind: 'alive', identity: opened.capture.identity }
    if (code === WAIT_OBJECT_0) return { kind: 'gone' }
    return { kind: 'unknown', code: 'READ_FAILED' }
  } finally {
    closeWin32Handle(opened.capture.handle)
  }
}

/** Read the current kernel identity of one pid through Win32. */
export function readWin32KernelProcessObservation(pid: number): KernelObservation {
  if (process.platform !== 'win32') return { kind: 'unknown', code: 'NATIVE_UNAVAILABLE' }
  return readWin32KernelProcess(pid)
}

/** Open a process handle for a destructive stop and return its exact identity. */
export function openWin32Process(pid: number): Win32ProcessOpen {
  const load = loadBridge()
  if (!load.ok) return { kind: 'unknown', code: load.code }
  const bridge = load.bridge
  const handle = bridge.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid)
  if (!handle) {
    const code = lastError(bridge)
    if (code === ERROR_INVALID_PARAMETER) return { kind: 'gone' }
    if (code === ERROR_ACCESS_DENIED) return { kind: 'unknown', code: 'ACCESS_DENIED' }
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  const fail = (code: KernelReadFailureCode): Win32ProcessOpen => {
    bridge.closeHandle(handle)
    return { kind: 'unknown', code }
  }
  try {
    const times = Buffer.alloc(32)
    if (!bridge.getProcessTimes(handle, times, Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32))) {
      return fail(lastError(bridge) === ERROR_ACCESS_DENIED ? 'ACCESS_DENIED' : 'READ_FAILED')
    }
    const token = Buffer.alloc(8)
    if (!bridge.openProcessToken(handle, TOKEN_QUERY, token)) {
      return fail(lastError(bridge) === ERROR_ACCESS_DENIED ? 'ACCESS_DENIED' : 'READ_FAILED')
    }
    const tokenHandle = token.readBigUInt64LE(0) as unknown as Win32Handle
    let sid: string | undefined
    try {
      const needed = Buffer.alloc(4)
      bridge.getTokenInformation(tokenHandle, 1, Buffer.alloc(0), 0, needed)
      const length = needed.readUInt32LE(0)
      if (length === 0) return fail('READ_FAILED')
      const info = Buffer.alloc(length)
      if (!bridge.getTokenInformation(tokenHandle, 1, info, length, needed)) return fail('READ_FAILED')
      const sidAddress = info.readBigUInt64LE(0)
      sid = parseSid(info, Number(sidAddress - (bridge.koffi.address(info) as unknown as bigint)))
    } finally {
      bridge.closeHandle(tokenHandle)
    }
    if (sid === undefined) return fail('READ_FAILED')
    const wait = bridge.waitForSingleObject(handle, 0)
    if (wait === WAIT_OBJECT_0) {
      bridge.closeHandle(handle)
      return { kind: 'gone' }
    }
    if (wait !== WAIT_TIMEOUT) return fail('READ_FAILED')
    return {
      kind: 'ok',
      capture: {
        handle,
        identity: {
          platform: 'win32',
          pid,
          ownerSid: sid,
          creationFiletime: filetimeFrom(times, 0),
        },
      },
    }
  } catch {
    bridge.closeHandle(handle)
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
}

/** Close one Win32 handle; callers track ownership exactly once. */
export function closeWin32Handle(handle: Win32Handle): void {
  const load = loadBridge()
  if (!load.ok) return
  load.bridge.closeHandle(handle)
}

/** Wait for one held process handle to become terminal within a bound. */
export async function waitWin32Handle(handle: Win32Handle, timeoutMs: number): Promise<Win32WaitOutcome> {
  const load = loadBridge()
  if (!load.ok) return { kind: 'failed', code: WAIT_FAILED }
  return await new Promise<Win32WaitOutcome>((resolve) => {
    load.bridge.waitForSingleObject.async(handle, timeoutMs, (error: Error | null, code: number) => {
      if (error !== null) resolve({ kind: 'failed', code: WAIT_FAILED })
      else if (code === WAIT_OBJECT_0) resolve({ kind: 'terminal', code })
      else if (code === WAIT_TIMEOUT) resolve({ kind: 'timeout', code })
      else resolve({ kind: 'failed', code })
    })
  })
}

/** Read the security descriptor of one open kernel/file handle. */
function readSecurityInfo(handle: Win32Handle, objectType: number): Win32SecurityView | undefined {
  const load = loadBridge()
  if (!load.ok) return undefined
  const bridge = load.bridge
  const owner = Buffer.alloc(8)
  const group = Buffer.alloc(8)
  const dacl = Buffer.alloc(8)
  const sacl = Buffer.alloc(8)
  const sd = Buffer.alloc(8)
  if (bridge.getSecurityInfo(handle, objectType, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, owner, group, dacl, sacl, sd) !== 0) return undefined
  if (sd.readBigUInt64LE(0) === 0n) return undefined
  const sdPtr = sd.readBigUInt64LE(0) as unknown as Win32Handle
  try {
    const length = bridge.getSecurityDescriptorLength(sdPtr)
    if (length === 0) return undefined
    const bytes = Buffer.from(bridge.koffi.decode(sdPtr, 'uint8', length) as Uint8Array)
    const control = Buffer.alloc(2)
    const revision = Buffer.alloc(4)
    if (!bridge.getSecurityDescriptorControl(sdPtr, control, revision)) return undefined
    const flags = control.readUInt16LE(0)
    const ownerOffset = bytes.readUInt32LE(4)
    const daclOffset = bytes.readUInt32LE(16)
    const aces: { sid: string; mask: number; type: number; flags: number }[] = []
    if (daclOffset !== 0) {
      const aceCount = bytes.readUInt16LE(daclOffset + 4)
      let offset = daclOffset + 8
      for (let i = 0; i < aceCount; i += 1) {
        const type = bytes[offset]!
        const aceFlags = bytes[offset + 1]!
        const size = bytes.readUInt16LE(offset + 2)
        const mask = bytes.readUInt32LE(offset + 4)
        aces.push({ sid: parseSid(bytes, offset + 8), mask, type, flags: aceFlags })
        offset += size
      }
    }
    return {
      ownerSid: ownerOffset === 0 ? null : parseSid(bytes, ownerOffset),
      daclPresent: (flags & SE_DACL_PRESENT) !== 0,
      daclProtected: (flags & SE_DACL_PROTECTED) !== 0,
      daclNull: daclOffset === 0,
      aces,
    }
  } finally {
    bridge.localFree(sdPtr)
  }
}

/** Turn one SDDL into a SECURITY_ATTRIBUTES buffer for a new kernel object. */
function securityAttributesForSddl(bridge: Win32Bridge, sddl: string): { readonly attributes: Buffer; readonly sd: Win32Handle } {
  const sd = Buffer.alloc(8)
  const size = Buffer.alloc(4)
  if (!bridge.convertStringSecurityDescriptor(sddl, SDDL_REVISION_1, sd, size)) {
    throw new Error(`native win32: invalid security descriptor (${String(lastError(bridge))})`)
  }
  const sdPtr = sd.readBigUInt64LE(0) as unknown as Win32Handle
  const attributes = Buffer.alloc(24)
  attributes.writeUInt32LE(24, 0)
  attributes.writeBigUInt64LE(sd.readBigUInt64LE(0), 8)
  attributes.writeUInt32LE(0, 16)
  return { attributes, sd: sdPtr }
}

/** Check one SD is exactly the protected owner-only descriptor this product
 * creates for kernel objects and directories. */
function isOwnerOnly(view: Win32SecurityView | undefined, sid: string): boolean {
  return view !== undefined
    && view.daclPresent
    && view.daclProtected
    && !view.daclNull
    && view.ownerSid === sid
    && view.aces.length === 1
    && view.aces[0]?.sid === sid
}

/** A product-created directory must also pass its owner-only ACE to ordinary
 * children. A protected owner-only DACL without OI/CI would leave a new file
 * with no inheritable grant at all; that is not a private directory for this
 * product. */
function isOwnerOnlyContainer(view: Win32SecurityView | undefined, sid: string): boolean {
  if (!isOwnerOnly(view, sid)) return false
  const flags = view!.aces[0]!.flags
  return (flags & OBJECT_INHERIT_ACE) !== 0 && (flags & CONTAINER_INHERIT_ACE) !== 0
}

/** A private file inherits the protected directory ACE; inheritance does not
 * set SE_DACL_PROTECTED on the child, so only the owner/ACE equality applies. */
function isOwnerOnlyFile(view: Win32SecurityView | undefined, sid: string): boolean {
  return view !== undefined
    && view.daclPresent
    && !view.daclNull
    && view.ownerSid === sid
    && view.aces.length === 1
    && view.aces[0]?.sid === sid
}

/** A held named mutex seat with one idempotent release. */
class NamedMutexSeat implements Win32KernelSeat {
  private handle: Win32Handle | undefined
  private readonly bridge: Win32Bridge
  private readonly sid: string
  private readonly name: string

  constructor(bridge: Win32Bridge, handle: Win32Handle, sid: string, name: string) {
    this.bridge = bridge
    this.handle = handle
    this.sid = sid
    this.name = name
  }

  assertCurrent(): void {
    if (this.handle === undefined) throw new Error(`native win32: seat ${this.name} is already closed`)
    const view = readSecurityInfo(this.handle, SE_KERNEL_OBJECT)
    if (!isOwnerOnly(view, this.sid)) throw new Error(`native win32: seat ${this.name} lost its owner-only descriptor`)
    if (this.bridge.waitForSingleObject(this.handle, 0) !== WAIT_OBJECT_0) {
      throw new Error(`native win32: seat ${this.name} is no longer held`)
    }
    // The wait above acquired one additional recursion level of the mutex this
    // thread already owns. Release exactly that level so close() stays the one
    // real release of the seat.
    if (!this.bridge.releaseMutex(this.handle)) {
      throw new Error(`native win32: seat ${this.name} could not release its currentness probe`)
    }
  }

  async close(): Promise<void> {
    const handle = this.handle
    if (handle === undefined) return
    this.handle = undefined
    this.bridge.releaseMutex(handle)
    this.bridge.closeHandle(handle)
  }
}

/**
 * Acquire one named `Global\` mutex seat. `conflictCode` is thrown when another
 * live process holds it; a foreign/broad/wrong-type object is refused by the
 * descriptor and type checks instead of being adopted.
 */
export async function acquireWin32KernelSeat(name: string, conflictCode: 'HOST_ALREADY_OWNED' | 'CLIENT_ALREADY_ACTIVE' | 'DAEMON_CONTROL_BUSY'): Promise<Win32KernelSeat> {
  const load = loadBridge()
  if (!load.ok) throw new Error(`native win32: ${load.code}`)
  const bridge = load.bridge
  const sid = win32CurrentTokenSid()
  if (sid === undefined) throw new Error('native win32: the current token SID is unavailable')
  const security = securityAttributesForSddl(bridge, `D:P(A;;GA;;;${sid})`)
  let handle: Win32Handle | null
  let createError = 0
  try {
    handle = bridge.createMutexW(security.attributes, 0, name)
    createError = handle === null ? lastError(bridge) : 0
  } finally {
    bridge.localFree(security.sd)
  }
  if (handle === null || handle === undefined) {
    if (createError === ERROR_ACCESS_DENIED) throw new Error('native win32: the named seat is owned by another account')
    if (createError === ERROR_INVALID_HANDLE) throw new Error('native win32: the named seat is another object type')
    throw new Error(`native win32: the named seat could not be created (${String(createError)})`)
  }
  try {
    if (!isOwnerOnly(readSecurityInfo(handle, SE_KERNEL_OBJECT), sid)) {
      throw new Error('native win32: the named seat has a foreign or broad security descriptor')
    }
    const wait = bridge.waitForSingleObject(handle, 0)
    if (wait === WAIT_TIMEOUT) throw Object.assign(new Error('native win32: the named seat is already held'), { code: conflictCode })
    if (wait !== WAIT_OBJECT_0 && wait !== WAIT_ABANDONED) throw new Error(`native win32: the named seat wait failed (${String(wait)})`)
    return new NamedMutexSeat(bridge, handle, sid, name)
  } catch (error) {
    bridge.closeHandle(handle)
    throw error
  }
}

/** The deterministic Host/admin mutex name: no secret, bound to scopeId only. */
export function win32SeatName(scopeId: string, purpose: 'host' | 'admin'): string {
  return `Global\\dsh-pi-tui-${purpose}-${scopeId.slice(0, 48)}`
}

/** The deterministic per-instance stop event name. */
export function win32StopEventName(scopeId: string, instanceId: string): string {
  return `Global\\dsh-pi-tui-stop-${scopeId.slice(0, 24)}-${instanceId}`
}

/** Open one control-side per-instance stop event and verify its owner-only descriptor. */
export function openWin32StopSignal(scopeId: string, instanceId: string): Win32StopSignal {
  const load = loadBridge()
  if (!load.ok) throw new Error(`native win32: ${load.code}`)
  const bridge = load.bridge
  const sid = win32CurrentTokenSid()
  if (sid === undefined) throw new Error('native win32: the current token SID is unavailable')
  const handle = bridge.openEventW(EVENT_MODIFY_STATE | SYNCHRONIZE | READ_CONTROL, 0, win32StopEventName(scopeId, instanceId))
  if (handle === null || handle === undefined) {
    const code = lastError(bridge)
    if (code === 5) throw new Error('native win32: the stop event is owned by another account')
    throw new Error(`native win32: the stop event is unavailable (${String(code)})`)
  }
  if (!isOwnerOnly(readSecurityInfo(handle, SE_KERNEL_OBJECT), sid)) {
    bridge.closeHandle(handle)
    throw new Error('native win32: the stop event has a foreign or broad security descriptor')
  }
  let set = false
  let closed = false
  return {
    setOnce(): void {
      if (set || closed) return
      set = true
      if (!bridge.setEvent(handle)) throw new Error(`native win32: SetEvent failed (${String(lastError(bridge))})`)
    },
    close(): void {
      if (closed) return
      closed = true
      bridge.closeHandle(handle)
    },
  }
}

/**
 * Create the Host-side per-instance stop event pair and start one asynchronous
 * native wait. `stopped` resolves only on the stop event; cancellation wakes the
 * native wait without resolving it and is used by `close()`.
 */
export function createWin32StopWaiter(scopeId: string, instanceId: string): Win32StopWaiter {
  const load = loadBridge()
  if (!load.ok) throw new Error(`native win32: ${load.code}`)
  const bridge = load.bridge
  const sid = win32CurrentTokenSid()
  if (sid === undefined) throw new Error('native win32: the current token SID is unavailable')
  const security = securityAttributesForSddl(bridge, `D:P(A;;GA;;;${sid})`)
  const eventName = win32StopEventName(scopeId, instanceId)
  let stopHandle: Win32Handle | null
  let cancelHandle: Win32Handle | null
  let stopExists = false
  let createError = 0
  let cancelError = 0
  try {
    bridge.setLastError(0)
    stopHandle = bridge.createEventW(security.attributes, 0, 0, eventName)
    createError = stopHandle === null ? lastError(bridge) : 0
    stopExists = stopHandle !== null && lastError(bridge) === 183
    bridge.setLastError(0)
    // The cancellation wakeup has no cross-process consumer. Keep it unnamed:
    // no second Global name, stale-object branch or accidental public handle.
    cancelHandle = bridge.createEventW(security.attributes, 0, 0, null)
    cancelError = cancelHandle === null ? lastError(bridge) : 0
  } finally {
    bridge.localFree(security.sd)
  }
  if (stopExists) {
    if (stopHandle !== null && stopHandle !== undefined) bridge.closeHandle(stopHandle)
    if (cancelHandle !== null && cancelHandle !== undefined) bridge.closeHandle(cancelHandle)
    throw new Error('native win32: a stale per-instance stop event already exists')
  }
  if (stopHandle === null || stopHandle === undefined || cancelHandle === null || cancelHandle === undefined) {
    if (stopHandle !== null && stopHandle !== undefined) bridge.closeHandle(stopHandle)
    if (cancelHandle !== null && cancelHandle !== undefined) bridge.closeHandle(cancelHandle)
    throw new Error(`native win32: the per-instance stop event could not be created (${String(stopHandle === null ? createError : cancelError)})`)
  }
  if (!isOwnerOnly(readSecurityInfo(stopHandle, SE_KERNEL_OBJECT), sid) || !isOwnerOnly(readSecurityInfo(cancelHandle, SE_KERNEL_OBJECT), sid)) {
    bridge.closeHandle(stopHandle)
    bridge.closeHandle(cancelHandle)
    throw new Error('native win32: the per-instance stop event has a foreign descriptor')
  }
  // Qualification-only failure injection: exercises the production Host's
  // publication guard without inventing a second native waiter. Production
  // never sets this variable.
  const forcedFailure = process.env.SPLIT_PROCESS_HOST_FORCE_NATIVE_WAITER_FAILURE === '1'
  let stopResolve: (() => void) | undefined
  let stopReject: ((error: Error) => void) | undefined
  const stopped = new Promise<void>((resolve, reject) => {
    stopResolve = resolve
    stopReject = reject
  })
  let closed = false
  let handlesClosed = false
  const closeHandles = (): void => {
    if (handlesClosed) return
    handlesClosed = true
    bridge.closeHandle(stopHandle)
    bridge.closeHandle(cancelHandle)
  }
  const loop = (async () => {
    try {
      if (forcedFailure) throw new Error('native win32: qualification forced stop-waiter failure')
      for (;;) {
        const code = await new Promise<number>((resolve, reject) => {
          bridge.waitForMultipleObjects.async(2, [stopHandle, cancelHandle], 0, 0xffffffff, (error: Error | null, value: number) => {
            if (error !== null) reject(error)
            else resolve(value)
          })
        })
        if (code === WAIT_OBJECT_0) {
          stopResolve?.()
          return
        }
        if (code === WAIT_OBJECT_0 + 1) {
          if (closed) return
          continue
        }
        throw new Error(`native win32: the stop-event wait returned ${String(code)}`)
      }
    } catch (error) {
      stopReject?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  })()
  // A rejected loop is delivered through `stopped`; close() below joins it.
  const loopSettled = loop.catch(() => {})
  return {
    eventName,
    stopped,
    async close(): Promise<void> {
      if (closed) {
        await loopSettled
        closeHandles()
        return
      }
      closed = true
      bridge.setEvent(cancelHandle)
      await loopSettled
      closeHandles()
    },
  }
}

/** Whether a path is on a local fixed NTFS volume (the PR2 supported domain). */
export function isWin32LocalFixedNtfs(path: string): boolean {
  const load = loadBridge()
  if (!load.ok) return false
  const bridge = load.bridge
  const root = path.slice(0, 2) + '\\'
  if (!/^[A-Za-z]:\\/u.test(root)) return false
  if (bridge.getDriveTypeW(root) !== DRIVE_FIXED) return false
  const fsNameChars = 32
  const fsName = Buffer.alloc(fsNameChars * 2)
  const flags = Buffer.alloc(4)
  return bridge.getVolumeInformationW(root, null, 0, null, null, flags, fsName, fsNameChars)
    && fsName.toString('utf16le').replace(/\0.*$/u, '').toUpperCase() === 'NTFS'
}

/** Read Win32 file attributes; undefined when the path is absent or unreadable. */
export function win32FileAttributes(path: string): { readonly directory: boolean; readonly reparse: boolean } | undefined {
  const load = loadBridge()
  if (!load.ok) return undefined
  const value = load.bridge.getFileAttributesW(path) >>> 0
  if (value === 0xffffffff) return undefined
  return {
    directory: (value & FILE_ATTRIBUTE_DIRECTORY) !== 0,
    reparse: (value & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
  }
}

/** Open one existing path for a security-descriptor read without following a final reparse. */
function openExistingPath(path: string): Win32Handle | undefined {
  const load = loadBridge()
  if (!load.ok) return undefined
  const handle = load.bridge.createFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null)
  return handle === null || handle === undefined ? undefined : handle
}

/** Verify one existing product directory is a real, non-reparse, owner-only object. */
export function win32PrivateDirectorySafe(path: string): boolean {
  const attributes = win32FileAttributes(path)
  if (attributes === undefined || !attributes.directory || attributes.reparse) return false
  const handle = openExistingPath(path)
  if (handle === undefined) return false
  try {
    const sid = win32CurrentTokenSid()
    return sid !== undefined && isOwnerOnlyContainer(readSecurityInfo(handle, SE_FILE_OBJECT), sid)
  } finally {
    closeWin32Handle(handle)
  }
}

/** Verify one existing product file is a real, non-reparse, owner-only object. */
export function win32PrivateFileSafe(path: string): boolean {
  const attributes = win32FileAttributes(path)
  if (attributes === undefined || attributes.directory || attributes.reparse) return false
  const handle = openExistingPath(path)
  if (handle === undefined) return false
  try {
    const sid = win32CurrentTokenSid()
    return sid !== undefined && isOwnerOnlyFile(readSecurityInfo(handle, SE_FILE_OBJECT), sid)
  } finally {
    closeWin32Handle(handle)
  }
}

/** Classify one existing product file before any write/append/cleanup. Only a
 * true missing path is `missing`; every other lstat/open/type/ACL failure is
 * `unsafe` so a caller cannot treat a dangling link or unreadable target as
 * absent. */
export function win32PrivateFileStatus(path: string): 'missing' | 'private' | 'unsafe' {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
  if (info.isSymbolicLink() || !info.isFile()) return 'unsafe'
  return win32PrivateFileSafe(path) ? 'private' : 'unsafe'
}

/** Create one directory with a protected owner-only DACL; existing safe dirs are reused. */
export function ensureWin32PrivateDirectory(path: string): void {
  const load = loadBridge()
  if (!load.ok) throw new Error(`native win32: ${load.code}`)
  const bridge = load.bridge
  const sid = win32CurrentTokenSid()
  if (sid === undefined) throw new Error('native win32: the current token SID is unavailable')
  const security = securityAttributesForSddl(bridge, `D:P(A;OICI;FA;;;${sid})`)
  let created: boolean
  let createError = 0
  try {
    created = bridge.createDirectoryW(path, security.attributes)
    if (!created) createError = lastError(bridge)
  } finally {
    bridge.localFree(security.sd)
  }
  if (created) {
    if (!win32PrivateDirectorySafe(path)) throw new Error('native win32: the created private directory did not retain its owner-only descriptor')
    return
  }
  if (createError !== 183) throw new Error(`native win32: the private directory could not be created (${String(createError)})`)
  if (!win32PrivateDirectorySafe(path)) throw new Error('native win32: an existing private directory is not owner-only')
}
