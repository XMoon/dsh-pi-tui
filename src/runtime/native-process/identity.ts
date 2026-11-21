/**
 * Kernel process identity and process-group membership: the single OS seam for
 * "is this numeric pid still the process we captured?".
 *
 * Every consumer that signals a process group must prove ownership first:
 * the footer command runner's TERM->SIGKILL escalation, the owned-process-group
 * teardown used by the test runners, and (later) the Host scope/seat layer.
 * This module answers that one question per platform and keeps NO state: every
 * observation is a fresh kernel read.
 *
 * - Linux reads `/proc/<pid>/stat` (fields 3/4/5/6/22); a real zombie is
 *   `alive` with state `Z`, and a genuinely absent entry is `gone`.
 * - Darwin reads libproc through the lazy native bridge (`./darwin.ts`):
 *   `proc_pidinfo` flavor 3 (136-byte `proc_bsdinfo`), the private flavor 17
 *   (56-byte `proc_uniqidentifierinfo`), `kern.bootsessionuuid` and `getsid`.
 *   Each observation is bracketed BSD -> unique -> BSD with the boot UUID on
 *   both sides; an identity that changes or disagrees mid-read is `unknown`,
 *   never `alive`. A zombie is invisible to libproc and reads as `gone`.
 *
 * Permission failures, an unsupported native ABI and an unstable read are all
 * `unknown` — they never mean "dead" and never authorize a signal or a
 * takeover. 64-bit Darwin ids are returned as exact decimal strings so no JS
 * `Number` precision is silently lost.
 *
 * @module runtime/native-process/identity
 */

import { readdirSync, readFileSync } from 'node:fs'
import {
  listDarwinProcessGroupPids,
  readDarwinBootSessionUuid,
  readDarwinBsdInfo,
  readDarwinSessionId,
  readDarwinUniqueInfo,
} from './darwin.ts'

/** Why a kernel read could not produce a usable observation. */
export type KernelReadFailureCode = 'ACCESS_DENIED' | 'NATIVE_UNAVAILABLE' | 'ABI_UNSUPPORTED' | 'READ_FAILED'

/** One Linux process identity: pid-reuse is proven by `startTicks`. */
export interface LinuxKernelProcessIdentity {
  readonly platform: 'linux'
  readonly pid: number
  /** `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot). */
  readonly startTicks: string
  readonly ppid: number
  readonly pgid: number
  readonly sid: number
  /** Single-letter Linux task state (`R`/`S`/`D`/`Z`, …). */
  readonly state: string
}

/** One Darwin process identity: pid reuse is proven by the boot session plus
 * the kernel's unique process id and start timestamp. */
export interface DarwinKernelProcessIdentity {
  readonly platform: 'darwin'
  readonly pid: number
  /** `kern.bootsessionuuid`: a pid alone never spans boots. */
  readonly bootUUID: string
  /** flavor-17 `p_uniqueid`, exact decimal string. */
  readonly uniqueId: string
  /** flavor-17 `p_puniqueid`, exact decimal string. */
  readonly parentUniqueId: string
  /** flavor-17 `p_uuid`, lowercase hex. */
  readonly processUUID: string
  /** `proc_bsdinfo.pbi_start_tvsec`, exact decimal string. */
  readonly startSec: string
  /** `proc_bsdinfo.pbi_start_tvusec`, exact decimal string. */
  readonly startUsec: string
  readonly ppid: number
  readonly pgid: number
  /** `getsid(pid)`. */
  readonly sid: number
  readonly uid: number
  /** `proc_bsdinfo.pbi_status` (2 = running; 5 = zombie, invisible to libproc). */
  readonly state: number
}

/** A versioned process identity for the current platform. */
export type KernelProcessIdentity = LinuxKernelProcessIdentity | DarwinKernelProcessIdentity

/** One kernel observation: a verified identity, a definitive absence, or an
 * unverifiable failure that must be treated as "cannot prove". */
export type KernelObservation =
  | { readonly kind: 'alive'; readonly identity: KernelProcessIdentity }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode }

/** The answer to "is this still the process I captured?". */
export type KernelProcessClassification = 'same' | 'different' | 'gone' | 'unknown'

/** The narrow legacy view of one Linux `/proc/<pid>/stat` (compatibility with
 * `app/remote-process/local-scope.ts`'s long-standing exports). */
export interface LinuxProcessStat {
  /** Single-letter Linux task state: R/S/D/T/t/Z/X/x/K/W/P/I. */
  readonly state: string
  /** Starttime in clock ticks since boot. */
  readonly starttime: string
}

/** The full positional tail this module needs from one `/proc/<pid>/stat`. */
interface LinuxStatFields extends LinuxProcessStat {
  readonly ppid: number
  readonly pgid: number
  readonly sid: number
}

/**
 * Parse the fixed positional tail of one `/proc/<pid>/stat`. The comm field may
 * contain spaces and parentheses, so everything after the LAST ')' is the
 * fixed tail whose first entry is field 3 (`state`); `starttime` is field 22
 * (index 19). A tail without a single-letter state, numeric starttime or
 * numeric ppid/pgrp/session is malformed and yields `undefined`.
 */
function parseLinuxStatFields(stat: string): LinuxStatFields | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 2).trim().split(/\s+/u)
  const state = fields[0]
  const starttime = fields[19]
  const ppid = Number.parseInt(fields[1]!, 10)
  const pgid = Number.parseInt(fields[2]!, 10)
  const sid = Number.parseInt(fields[3]!, 10)
  if (state === undefined || !/^[A-Za-z]$/u.test(state)) return undefined
  if (starttime === undefined || !/^\d+$/u.test(starttime)) return undefined
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(sid)) return undefined
  return { state, starttime, ppid, pgid, sid }
}

/** Parse field 3 (`state`) and field 22 (`starttime`) from one
 * `/proc/<pid>/stat` text (external behavior preserved from local-scope). */
export function parseProcessStat(stat: string): LinuxProcessStat | undefined {
  const fields = parseLinuxStatFields(stat)
  return fields === undefined ? undefined : { state: fields.state, starttime: fields.starttime }
}

/** Parse only field 22 (`starttime`) from one `/proc/<pid>/stat`. */
export function parseProcessStatStarttime(stat: string): string | undefined {
  return parseProcessStat(stat)?.starttime
}

/** Best-effort Linux `starttime` read (undefined where `/proc` is absent). */
export function readProcessStarttime(pid: number = process.pid): string | undefined {
  try {
    return parseProcessStatStarttime(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'))
  } catch {
    return undefined
  }
}

function linuxReadFailure(error: unknown): KernelObservation {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return { kind: 'gone' }
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'unknown', code: 'ACCESS_DENIED' }
  return { kind: 'unknown', code: 'READ_FAILED' }
}

function readLinuxKernelProcess(pid: number): KernelObservation {
  let stat: string
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  } catch (error) {
    return linuxReadFailure(error)
  }
  const fields = parseLinuxStatFields(stat)
  if (fields === undefined) return { kind: 'unknown', code: 'READ_FAILED' }
  return {
    kind: 'alive',
    identity: {
      platform: 'linux',
      pid,
      startTicks: fields.starttime,
      ppid: fields.ppid,
      pgid: fields.pgid,
      sid: fields.sid,
      state: fields.state,
    },
  }
}

/** A Darwin native result mapped onto the observation taxonomy. */
function darwinFailure(result: { readonly kind: 'gone' } | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode }): KernelObservation {
  return result.kind === 'gone' ? { kind: 'gone' } : { kind: 'unknown', code: result.code }
}

function readDarwinKernelProcess(pid: number): KernelObservation {
  const bootBefore = readDarwinBootSessionUuid()
  if (bootBefore.kind !== 'ok') return darwinFailure(bootBefore)
  const before = readDarwinBsdInfo(pid)
  if (before.kind !== 'ok') return darwinFailure(before)
  const unique = readDarwinUniqueInfo(pid)
  if (unique.kind !== 'ok') return darwinFailure(unique)
  const after = readDarwinBsdInfo(pid)
  if (after.kind !== 'ok') return darwinFailure(after)
  const session = readDarwinSessionId(pid)
  if (session.kind !== 'ok') return darwinFailure(session)
  const bootAfter = readDarwinBootSessionUuid()
  if (bootAfter.kind !== 'ok') return darwinFailure(bootAfter)
  // The boot session is the outermost bracket: a reboot invalidates the whole
  // observation even when the numeric fields happen to agree.
  if (bootBefore.value !== bootAfter.value) return { kind: 'unknown', code: 'READ_FAILED' }
  // The two BSD reads must describe the SAME process: any disagreement means
  // the numeric pid was reused or the reply was torn while we read it.
  if (before.value.startSec !== after.value.startSec
    || before.value.startUsec !== after.value.startUsec
    || before.value.ppid !== after.value.ppid
    || before.value.pgid !== after.value.pgid
    || before.value.uid !== after.value.uid) {
    return { kind: 'unknown', code: 'READ_FAILED' }
  }
  return {
    kind: 'alive',
    identity: {
      platform: 'darwin',
      pid,
      bootUUID: bootBefore.value,
      uniqueId: unique.value.uniqueId,
      parentUniqueId: unique.value.parentUniqueId,
      processUUID: unique.value.processUuid,
      startSec: before.value.startSec,
      startUsec: before.value.startUsec,
      ppid: before.value.ppid,
      pgid: before.value.pgid,
      sid: session.value,
      uid: before.value.uid,
      state: before.value.status,
    },
  }
}

/**
 * Read the current kernel identity of one pid. Never cached: the caller decides
 * whether an observation is still the process it captured.
 */
export function readKernelProcess(pid: number): KernelObservation {
  if (process.platform === 'linux') return readLinuxKernelProcess(pid)
  if (process.platform === 'darwin') return readDarwinKernelProcess(pid)
  return { kind: 'unknown', code: 'NATIVE_UNAVAILABLE' }
}

/**
 * Classify one fresh observation against the identity a caller captured
 * earlier. `gone` and `unknown` are answers about the observation itself, not
 * about ownership; only `same` may authorize a signal or a takeover.
 */
export function sameKernelProcess(expected: KernelProcessIdentity, observed: KernelObservation): KernelProcessClassification {
  if (observed.kind === 'unknown') return 'unknown'
  if (observed.kind === 'gone') return 'gone'
  const actual = observed.identity
  if (actual.platform !== expected.platform || actual.pid !== expected.pid) return 'different'
  if (expected.platform === 'linux' && actual.platform === 'linux') {
    return actual.startTicks === expected.startTicks ? 'same' : 'different'
  }
  if (expected.platform === 'darwin' && actual.platform === 'darwin') {
    return actual.bootUUID === expected.bootUUID
      && actual.uniqueId === expected.uniqueId
      && actual.processUUID === expected.processUUID
      && actual.startSec === expected.startSec
      && actual.startUsec === expected.startUsec
      ? 'same'
      : 'different'
  }
  return 'different'
}

/** Whether one identity is a member of BOTH the target process group and the
 * session the owner created for it (`setsid`: sid === pgid). A member that
 * changed its group/session no longer proves ownership of the captured group. */
function isOwnedGroupMember(identity: KernelProcessIdentity, pgid: number): boolean {
  return identity.pgid === pgid && identity.sid === pgid
}

/**
 * Re-read every captured member and keep only the ones that are still the SAME
 * process and still inside the owned group+session. This second pass is what
 * turns a snapshot into an authorization witness: a pid that exited, was
 * reused, or left the group is dropped. Any unverifiable read makes the whole
 * scan `unknown` — an empty result is never derived from "we could not see".
 */
function verifyCapturedMembers(captured: KernelObservation[], pgid: number): KernelObservation[] | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode } {
  const verified: KernelObservation[] = []
  for (const observation of captured) {
    if (observation.kind !== 'alive') continue
    const current = readKernelProcess(observation.identity.pid)
    if (current.kind === 'unknown') return current
    if (current.kind === 'gone' || !isOwnedGroupMember(current.identity, pgid)) continue
    if (sameKernelProcess(observation.identity, current) === 'same') verified.push(current)
  }
  return verified
}

function listLinuxKernelGroupMembers(pgid: number): KernelObservation[] | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode } {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: 'unknown', code: code === 'EACCES' || code === 'EPERM' ? 'ACCESS_DENIED' : 'READ_FAILED' }
  }
  const captured: KernelObservation[] = []
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const observation = readLinuxKernelProcess(Number(entry))
    if (observation.kind === 'unknown') return observation
    if (observation.kind === 'gone' || !isOwnedGroupMember(observation.identity, pgid)) continue
    captured.push(observation)
  }
  return verifyCapturedMembers(captured, pgid)
}

function listDarwinKernelGroupMembers(pgid: number): KernelObservation[] | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode } {
  const listed = listDarwinProcessGroupPids(pgid)
  if (listed.kind === 'gone') return []
  if (listed.kind !== 'ok') return { kind: 'unknown', code: listed.code }
  const captured: KernelObservation[] = []
  for (const pid of listed.value) {
    const observation = readDarwinKernelProcess(pid)
    if (observation.kind === 'unknown') return observation
    if (observation.kind === 'gone' || !isOwnedGroupMember(observation.identity, pgid)) continue
    captured.push(observation)
  }
  return verifyCapturedMembers(captured, pgid)
}

/**
 * List the verifiable members of the process group AND session `pgid` (the
 * owner-created `setsid` group used by every wrapper here). Only identities
 * that are the same process in both passes and still belong to the group are
 * returned; a suspicious read makes the WHOLE scan `unknown` so no caller can
 * mistake "not scanned" for "no member".
 */
export function listKernelGroupMembers(pgid: number): KernelObservation[] | { readonly kind: 'unknown'; readonly code: KernelReadFailureCode } {
  if (process.platform === 'linux') return listLinuxKernelGroupMembers(pgid)
  if (process.platform === 'darwin') return listDarwinKernelGroupMembers(pgid)
  return { kind: 'unknown', code: 'NATIVE_UNAVAILABLE' }
}
