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
 * Linux                                     (the /proc root view only exists there)
 * /proc/<authenticated hostPid>/stat        starttime equals the authenticated one
 * launch object (dev, ino), captured at     the Client's OWN start directory object
 *   launch (or the real stat('.'))          (a rename+recreate of the path is refused)
 * stat(client launch cwd)                   is a directory
 * stat('/proc/<hostPid>/root' + cwd)        is a directory
 * (dev, ino) of launch / cwd / Host view    ALL EXACTLY equal
 * the same starttime again                  after all facts were observed
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

/** One directory object identity (`dev`, `ino`). */
export interface DirectoryObject {
  readonly device: number
  readonly inode: number
}

/** The classification inputs. `procRoot`, `readStarttime` and `launchObject`
 *  exist so the fail-closed contract tests (including the revalidation identity
 *  race and the rename-and-recreate negative) are deterministic; production
 *  passes the object the Client captured at launch. */
export interface LaunchWorkspaceOptions {
  readonly procRoot?: string
  readonly platform?: NodeJS.Platform
  readonly readStarttime?: (pid: number, procRoot: string) => string | undefined
  /** The `(dev, ino)` captured at CLIENT LAUNCH (before any later rename or
   *  recreation of the path). When absent the CURRENT process cwd object is
   *  used — still a real object, never a guess. */
  readonly launchObject?: DirectoryObject
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
  const readStarttime = options.readStarttime ?? readProcessStarttimeAt
  if (identity === undefined) {
    return { kind: 'unverified', reason: 'the local Host identity is unavailable' }
  }
  if (platform !== 'linux') {
    return { kind: 'unverified', reason: 'the Host/Client directory equivalence check is only available on Linux' }
  }
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
  let launchObject: DirectoryObject
  try {
    if (options.launchObject !== undefined) {
      launchObject = options.launchObject
    } else {
      const dot = statSync('.')
      if (!dot.isDirectory()) {
        return { kind: 'unverified', reason: 'the Client process directory is not a directory' }
      }
      launchObject = { device: dot.dev, inode: dot.ino }
    }
  } catch {
    return { kind: 'unverified', reason: 'the Client launch object cannot be inspected' }
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
  if (clientDevice !== launchObject.device || clientInode !== launchObject.inode) {
    return {
      kind: 'unverified',
      reason: 'the launch path no longer names the directory the Client started in (renamed or recreated)',
    }
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
  if (readStarttime(identity.hostPid, procRoot) !== identity.hostStarttime) {
    return { kind: 'unverified', reason: 'the Host process changed while the launch directory was compared' }
  }

  const revalidate = (): boolean => {
    // The SAME observation-window rule the initial classification applies: the
    // Host process identity is checked BEFORE the two stats AND again AFTER
    // them, so a PID restart/reuse inside the window can never leave a stale
    // directory comparison standing as a live proof.
    if (readStarttime(identity.hostPid, procRoot) !== identity.hostStarttime) return false
    let same: boolean
    try {
      const client = statSync(launchCwd)
      const hostView = statSync(hostViewPath)
      same = client.isDirectory()
        && hostView.isDirectory()
        && client.dev === clientDevice
        && client.ino === clientInode
        && hostView.dev === clientDevice
        && hostView.ino === clientInode
        // The path must still be the object the Client STARTED in: a rename +
        // recreation between launch and revalidation revokes the proof even
        // when both current views agree with each other.
        && client.dev === launchObject.device
        && client.ino === launchObject.inode
    } catch {
      return false
    }
    if (readStarttime(identity.hostPid, procRoot) !== identity.hostStarttime) return false
    return same
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
