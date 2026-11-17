/**
 * The Client-local launch-cwd / Host-directory equivalence classifier
 * (M6-1/F5-B §4.5): the ONLY evidence that may turn a Client process's own
 * launch directory into an AUTOMATIC Host Workspace proposal.
 *
 * The verdict permits an AUTOMATIC host-path PROPOSAL only. It grants no Host
 * file permission and is never a WorkspaceId: a manual Host path or
 * WorkspaceId still goes through the official Host
 * `workspaceController`/`workspaceRegistry`. {@link
 * LaunchWorkspaceProof.revalidate} re-runs the SAME evidence asynchronously
 * before a Host `workspace.create` and again before the resulting
 * `workspaceId` is adopted.
 *
 * Linux uses its long-lived kernel view: the authenticated Host
 * `/proc/<pid>/stat` starttime and `/proc/<pid>/root` directory object. macOS
 * cannot read another process's `/proc` view, so the Host process itself
 * answers through the Owner-only read-only workspace-object route. Both
 * platforms require the SAME directory object the Client started in — a path
 * spelling alone is never evidence — and a failed/unverifiable observation
 * only means the user must choose a Host Workspace through the existing
 * Browser.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/local-workspace-equivalence
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseProcessStatStarttime, type LocalScope } from './local-scope.ts'
import {
  assertRecordedHostKernelIdentityCurrent,
  readLocalRecord,
  sameLocalInstanceRecord,
  type LocalInstanceRecord,
} from './local-discovery.ts'
import { observeHostWorkspaceObject } from './local-workspace-object.ts'
import {
  readKernelProcess,
  type KernelObservation,
} from '../../runtime/native-process/identity.ts'

/** One directory object identity as exact decimal strings (never JS
 *  `number`, so a 64-bit inode is not silently truncated). */
export interface DirectoryObject {
  readonly device: string
  readonly inode: string
}

/**
 * The verdict. A `verified` verdict carries the captured launch cwd and the
 * directory-object evidence that produced it; {@link revalidate} re-observes
 * the live facts (a stale proof never authorizes a Host create).
 */
export type LaunchWorkspaceVerdict =
  | {
      readonly kind: 'verified'
      readonly launchCwd: string
      readonly instanceId: string
      readonly hostPid: number
      readonly device: string
      readonly inode: string
      /** Re-check the exact same evidence now. `false` = not eligible. */
      revalidate(): Promise<boolean>
    }
  | { readonly kind: 'unverified'; readonly reason: string }

/** The narrow authenticated Host transport the Darwin proof borrows: the SAME
 *  live Connection generation and Cookie-bearing fetch, never a second
 *  Connection or a stored Cookie copy. */
export interface LaunchWorkspaceTransport {
  status(): { readonly transport: 'connecting' | 'connected' | 'disconnected'; readonly generationId?: number }
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>
}

/** The classification inputs. `procRoot`, `readStarttime`, `launchObject` and
 *  the read seams exist so the fail-closed contract tests are deterministic;
 *  production passes the object the Client captured at launch, the live
 *  transport and the official scope. */
export interface LaunchWorkspaceOptions {
  readonly procRoot?: string
  readonly platform?: NodeJS.Platform
  readonly readStarttime?: (pid: number, procRoot: string) => string | undefined
  /** The `(dev, ino)` captured at CLIENT LAUNCH (before any later rename or
   *  recreation of the path). When absent the CURRENT process cwd object is
   *  used — still a real object, never a guess. */
  readonly launchObject?: DirectoryObject
  /** The live authenticated Client transport (required by the Darwin proof). */
  readonly transport?: LaunchWorkspaceTransport
  /** The official local scope whose current registry record is re-read. */
  readonly scope?: LocalScope
  readonly readRecord?: (scope: LocalScope) => LocalInstanceRecord | undefined
  readonly readKernel?: (pid: number) => KernelObservation
}

/** The Linux `starttime` of one PID, read through the shared official parser
 *  (the `procRoot` seam exists only for the fail-closed contract tests). */
export function readProcessStarttimeAt(pid: number, procRoot = '/proc'): string | undefined {
  try {
    return parseProcessStatStarttime(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'))
  } catch {
    return undefined
  }
}

/** One real directory object as exact decimal strings. */
function statDirectoryObject(path: string): DirectoryObject | undefined {
  try {
    const stat = statSync(path, { bigint: true })
    if (!stat.isDirectory()) return undefined
    return { device: stat.dev.toString(), inode: stat.ino.toString() }
  } catch {
    return undefined
  }
}

/**
 * Classify whether this Client's launch directory is the SAME directory object
 * the authenticated Host process sees at that pathname. Never throws: every
 * unreadable fact is an `unverified` verdict with its reason.
 */
export async function classifyLaunchWorkspace(
  identity: LocalInstanceRecord | undefined,
  launchCwd: string,
  options: LaunchWorkspaceOptions = {},
): Promise<LaunchWorkspaceVerdict> {
  const platform = options.platform ?? process.platform
  if (identity === undefined) {
    return { kind: 'unverified', reason: 'the local Host identity is unavailable' }
  }
  if (platform === 'darwin') return await classifyDarwinLaunchWorkspace(identity, launchCwd, options)
  if (platform !== 'linux') {
    return { kind: 'unverified', reason: 'the Host/Client directory equivalence check is only available on Linux and macOS' }
  }
  if (identity.schema !== 1) {
    return { kind: 'unverified', reason: 'the Host publication is not a Linux schema 1 record' }
  }
  return classifyLinuxLaunchWorkspace(identity, launchCwd, options)
}

/** The frozen Linux proof: `/proc` starttime plus `/proc/<pid>/root`. */
function classifyLinuxLaunchWorkspace(
  identity: Extract<LocalInstanceRecord, { schema: 1 }>,
  launchCwd: string,
  options: LaunchWorkspaceOptions,
): LaunchWorkspaceVerdict {
  const procRoot = options.procRoot ?? '/proc'
  const readStarttime = options.readStarttime ?? readProcessStarttimeAt
  if (identity.hostPid < 1 || identity.hostStarttime === '') {
    return { kind: 'unverified', reason: 'the authenticated Host identity is incomplete' }
  }
  const observedStarttime = readStarttime(identity.hostPid, procRoot)
  if (observedStarttime === undefined) {
    return { kind: 'unverified', reason: `the Host process /proc/${String(identity.hostPid)}/stat is not readable` }
  }
  if (observedStarttime !== identity.hostStarttime) {
    return { kind: 'unverified', reason: 'the Host process starttime no longer matches the authenticated identity' }
  }
  // The object the Client REALLY started in. A rename-and-recreate of the
  // launch path produces a NEW object at the same spelling: comparing the path
  // with the Host view alone would then confirm the WRONG directory, so the
  // launch object is part of the proof.
  const launchObject = options.launchObject ?? statDirectoryObject('.')
  if (launchObject === undefined) {
    return { kind: 'unverified', reason: 'the Client launch object cannot be inspected' }
  }
  const client = statDirectoryObject(launchCwd)
  if (client === undefined) {
    return { kind: 'unverified', reason: 'the Client launch directory cannot be inspected' }
  }
  if (client.device !== launchObject.device || client.inode !== launchObject.inode) {
    return {
      kind: 'unverified',
      reason: 'the launch path no longer names the directory the Client started in (renamed or recreated)',
    }
  }
  try {
    const hostView = statSync(join(procRoot, String(identity.hostPid), 'root', launchCwd), { bigint: true })
    if (!hostView.isDirectory()) {
      return { kind: 'unverified', reason: 'the Host view of the launch path is not a directory' }
    }
    if (hostView.dev.toString() !== client.device || hostView.ino.toString() !== client.inode) {
      return { kind: 'unverified', reason: 'the Client and Host see different directory objects at the launch path' }
    }
  } catch {
    return { kind: 'unverified', reason: 'the Host view of the launch path cannot be inspected' }
  }
  if (readStarttime(identity.hostPid, procRoot) !== identity.hostStarttime) {
    return { kind: 'unverified', reason: 'the Host process changed while the launch directory was compared' }
  }

  const revalidate = async (): Promise<boolean> => {
    // The SAME observation-window rule the initial classification applies: the
    // Host process identity is checked BEFORE the two stats AND again AFTER
    // them, so a PID restart/reuse inside the window can never leave a stale
    // directory comparison standing as a live proof.
    if (readStarttime(identity.hostPid, procRoot) !== identity.hostStarttime) return false
    const now = statDirectoryObject(launchCwd)
    if (now === undefined || now.device !== launchObject.device || now.inode !== launchObject.inode) return false
    try {
      const hostView = statSync(join(procRoot, String(identity.hostPid), 'root', launchCwd), { bigint: true })
      if (!hostView.isDirectory()
        || hostView.dev.toString() !== launchObject.device
        || hostView.ino.toString() !== launchObject.inode) return false
    } catch {
      return false
    }
    return readStarttime(identity.hostPid, procRoot) === identity.hostStarttime
  }

  return {
    kind: 'verified',
    launchCwd,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
    device: launchObject.device,
    inode: launchObject.inode,
    revalidate,
  }
}

/**
 * The macOS proof: the Host itself stats the same absolute path through the
 * Owner-only route, and BOTH the kernel identity and the official Connection
 * generation must be unchanged before and after the observation.
 */
async function classifyDarwinLaunchWorkspace(
  identity: LocalInstanceRecord,
  launchCwd: string,
  options: LaunchWorkspaceOptions,
): Promise<LaunchWorkspaceVerdict> {
  if (identity.schema !== 2) {
    return { kind: 'unverified', reason: 'the Host publication is not a macOS schema 2 record' }
  }
  if (identity.hostPid < 1) {
    return { kind: 'unverified', reason: 'the authenticated Host identity is incomplete' }
  }
  const transport = options.transport
  if (transport === undefined) {
    return { kind: 'unverified', reason: 'the authenticated Host transport is unavailable' }
  }
  const scope = options.scope
  const readRecord = options.readRecord ?? readLocalRecord
  if (scope === undefined) {
    return { kind: 'unverified', reason: 'the official local scope is unavailable' }
  }
  const readKernel = options.readKernel ?? readKernelProcess
  const generation = transport.status()
  if (generation.transport !== 'connected' || generation.generationId === undefined) {
    return { kind: 'unverified', reason: 'the official Host Connection generation is not ready' }
  }
  const capturedGeneration = generation.generationId
  if (!recordIsCurrent(identity, readKernel, readRecord, scope)) {
    return { kind: 'unverified', reason: 'the current Host publication does not match the authenticated identity' }
  }
  const launchObject = options.launchObject ?? statDirectoryObject('.')
  if (launchObject === undefined) {
    return { kind: 'unverified', reason: 'the Client launch object cannot be inspected' }
  }
  const client = statDirectoryObject(launchCwd)
  if (client === undefined) {
    return { kind: 'unverified', reason: 'the Client launch directory cannot be inspected' }
  }
  if (client.device !== launchObject.device || client.inode !== launchObject.inode) {
    return {
      kind: 'unverified',
      reason: 'the launch path no longer names the directory the Client started in (renamed or recreated)',
    }
  }
  const hostObject = await observeHostWorkspaceObject(
    (input, init) => transport.authenticatedFetch(input, init),
    identity.origin,
    identity.instanceId,
    launchCwd,
  )
  if (hostObject.kind !== 'observed') {
    return { kind: 'unverified', reason: hostObject.reason }
  }
  if (hostObject.device !== client.device || hostObject.inode !== client.inode) {
    return { kind: 'unverified', reason: 'the Client and Host see different directory objects at the launch path' }
  }
  if (!recordIsCurrent(identity, readKernel, readRecord, scope)
    || transport.status().generationId !== capturedGeneration) {
    return { kind: 'unverified', reason: 'the Host identity or Connection generation changed during the observation' }
  }

  const revalidate = async (): Promise<boolean> => {
    try {
      const now = transport.status()
      if (now.transport !== 'connected' || now.generationId !== capturedGeneration) return false
      if (!recordIsCurrent(identity, readKernel, readRecord, scope)) return false
      // The SAME launch object is re-observed; a rename+recreate revokes the
      // proof even when the new path is also a directory.
      const clientNow = statDirectoryObject(launchCwd)
      if (clientNow === undefined
        || clientNow.device !== launchObject.device
        || clientNow.inode !== launchObject.inode) return false
      const observed = await observeHostWorkspaceObject(
        (input, init) => transport.authenticatedFetch(input, init),
        identity.origin,
        identity.instanceId,
        launchCwd,
      )
      if (observed.kind !== 'observed'
        || observed.device !== launchObject.device
        || observed.inode !== launchObject.inode) return false
      if (transport.status().generationId !== capturedGeneration) return false
      return recordIsCurrent(identity, readKernel, readRecord, scope)
    } catch {
      return false
    }
  }

  return {
    kind: 'verified',
    launchCwd,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
    device: launchObject.device,
    inode: launchObject.inode,
    revalidate,
  }
}

/** The live Host publication and kernel identity are still the authenticated
 *  ones. Any exception (unreadable registry, unknown kernel read) is `false`,
 *  never an assumed success. */
function recordIsCurrent(
  identity: LocalInstanceRecord,
  readKernel: (pid: number) => KernelObservation,
  readRecord: (scope: LocalScope) => LocalInstanceRecord | undefined,
  scope: LocalScope,
): boolean {
  try {
    assertRecordedHostKernelIdentityCurrent(identity, readKernel)
    const recorded = readRecord(scope)
    return recorded !== undefined && sameLocalInstanceRecord(recorded, identity)
  } catch {
    return false
  }
}
