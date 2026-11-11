/**
 * The Client-local launch-cwd / Host-directory equivalence classifier
 * (M6-1/F5-B §4.5): the ONLY evidence that may turn a Client process's own
 * launch directory into an AUTOMATIC Host Workspace proposal.
 *
 * It is read-only and Client-local: it talks to the kernel (`/proc`, `stat`)
 * and to nothing else — no Host RPC, no network, no workspace mutation. The
 * prerequisite is the existing authenticated local Host identity (the registry
 * `instanceId` / `hostPid` / `hostStarttime` the Client already verified); the
 * classifier then requires ALL of:
 *
 * ```text
 * Linux                                   (the /proc root view only exists there)
 * /proc/<authenticated hostPid>/stat      starttime equals the authenticated one
 * stat(client launch cwd)                 is a directory
 * stat('/proc/<hostPid>/root' + cwd)      is a directory
 * (dev, ino) of the two                   EXACTLY equal
 * the same starttime again                after all facts were observed
 * ```
 *
 * Same path SPELLING is never evidence; a different inode/device (another
 * mount namespace, a symlinked view, a replaced directory) classifies
 * `unverified`. ANY unreadable/exceptional fact is `unverified` too — the
 * classifier never guesses, and a failed classification only means the user
 * must choose a Host Workspace through the existing Browser.
 *
 * The verdict permits an AUTOMATIC host-path PROPOSAL only. It grants no Host
 * file permission: a manual Host path or WorkspaceId still goes through the
 * official Host `workspaceController`/`workspaceRegistry`. {@link
 * LaunchWorkspaceProof.revalidate} re-runs the SAME evidence before a Host
 * `workspace.create` and again before the resulting `workspaceId` is adopted.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/local-workspace-equivalence
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseProcessStatStarttime } from './local-scope.ts'

/** The authenticated Host identity facts the Client already verified. */
export interface AuthenticatedHostIdentity {
  readonly instanceId: string
  readonly hostPid: number
  readonly hostStarttime: string
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
      readonly hostStarttime: string
      readonly device: number
      readonly inode: number
      /** Re-check the exact same evidence now. `false` = not eligible. */
      revalidate(): boolean
    }
  | { readonly kind: 'unverified'; readonly reason: string }

/** The classification inputs (the proc root is injectable only for the
 *  fail-closed contract tests). */
export interface LaunchWorkspaceOptions {
  readonly procRoot?: string
  readonly platform?: NodeJS.Platform
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

/**
 * Classify whether this Client's launch directory is the SAME directory object
 * the authenticated Host process sees at that pathname. Never throws: every
 * unreadable fact is an `unverified` verdict with its reason.
 */
export function classifyLaunchWorkspace(
  identity: AuthenticatedHostIdentity | undefined,
  launchCwd: string,
  options: LaunchWorkspaceOptions = {},
): LaunchWorkspaceVerdict {
  const platform = options.platform ?? process.platform
  const procRoot = options.procRoot ?? '/proc'
  if (identity === undefined) {
    return { kind: 'unverified', reason: 'the local Host identity is unavailable' }
  }
  if (platform !== 'linux') {
    return { kind: 'unverified', reason: 'the Host/Client directory equivalence check is only available on Linux' }
  }
  if (identity.hostPid < 1 || identity.hostStarttime === '') {
    return { kind: 'unverified', reason: 'the authenticated Host identity is incomplete' }
  }
  const observedStarttime = readProcessStarttimeAt(identity.hostPid, procRoot)
  if (observedStarttime === undefined) {
    return { kind: 'unverified', reason: `the Host process /proc/${String(identity.hostPid)}/stat is not readable` }
  }
  if (observedStarttime !== identity.hostStarttime) {
    return { kind: 'unverified', reason: 'the Host process starttime no longer matches the authenticated identity' }
  }
  let clientDevice: number
  let clientInode: number
  try {
    const client = statSync(launchCwd)
    if (!client.isDirectory()) {
      return { kind: 'unverified', reason: 'the Client launch directory is not a directory' }
    }
    clientDevice = client.dev
    clientInode = client.ino
  } catch {
    return { kind: 'unverified', reason: 'the Client launch directory cannot be inspected' }
  }
  const hostViewPath = join(procRoot, String(identity.hostPid), 'root', launchCwd)
  try {
    const hostView = statSync(hostViewPath)
    if (!hostView.isDirectory()) {
      return { kind: 'unverified', reason: 'the Host view of the launch path is not a directory' }
    }
    if (hostView.dev !== clientDevice || hostView.ino !== clientInode) {
      return { kind: 'unverified', reason: 'the Client and Host see different directory objects at the launch path' }
    }
  } catch {
    return { kind: 'unverified', reason: 'the Host view of the launch path cannot be inspected' }
  }
  if (readProcessStarttimeAt(identity.hostPid, procRoot) !== identity.hostStarttime) {
    return { kind: 'unverified', reason: 'the Host process changed while the launch directory was compared' }
  }

  const revalidate = (): boolean => {
    if (readProcessStarttimeAt(identity.hostPid, procRoot) !== identity.hostStarttime) return false
    try {
      const client = statSync(launchCwd)
      const hostView = statSync(hostViewPath)
      return client.isDirectory()
        && hostView.isDirectory()
        && client.dev === clientDevice
        && client.ino === clientInode
        && hostView.dev === clientDevice
        && hostView.ino === clientInode
    } catch {
      return false
    }
  }

  return {
    kind: 'verified',
    launchCwd,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
    hostStarttime: identity.hostStarttime,
    device: clientDevice,
    inode: clientInode,
    revalidate,
  }
}
