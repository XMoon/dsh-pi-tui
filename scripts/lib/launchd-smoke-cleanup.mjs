/**
 * Ownership-safe cleanup for the macOS D4L smoke's tracked LaunchAgents.
 *
 * The smoke may only remove a plist/job that THIS run installed. A path or
 * label string is not ownership: the current file must still have the recorded
 * `(dev,ino,content)` identity, and a loaded job must report that exact
 * canonical plist path as its source. A missing/failed manager or a changed
 * file/job is reported and preserved, never guessed at.
 *
 * The IO seam is injected so the decision branches can be tested without
 * touching the real launchd domain.
 */

/** Compare one recorded plist identity with a current one. */
export function sameLaunchdIdentity(recorded, current) {
  return recorded !== undefined
    && current !== undefined
    && typeof recorded.dev === 'string'
    && typeof recorded.ino === 'string'
    && typeof recorded.sha256 === 'string'
    && recorded.dev === current.dev
    && recorded.ino === current.ino
    && recorded.sha256 === current.sha256
}

/**
 * @typedef {{
 *   label: string,
 *   plistPath: string,
 *   identity?: { dev: string, ino: string, sha256: string },
 * }} TrackedLaunchdResource
 * @typedef {{
 *   print: (label: string) => Promise<{ status: number, stdout: string }>,
 *   bootout: (label: string) => Promise<{ status: number }>,
 *   readIdentity: (path: string) => Promise<{ dev: string, ino: string, sha256: string } | undefined>,
 *   realpath: (path: string) => Promise<string>,
 *   unlink: (path: string) => Promise<void>,
 *   sleep: (ms: number) => Promise<void>,
 *   maxWaitAttempts?: number,
 *   pollMs?: number,
 * }} LaunchdCleanupIo
 */

/**
 * Remove one tracked plist/job only when its recorded ownership is still
 * provable. Returns `removed`, `absent` (already gone) or `preserve` with a
 * concrete reason.
 *
 * @param {TrackedLaunchdResource} tracked
 * @param {LaunchdCleanupIo} io
 * @returns {Promise<{ action: 'removed' | 'absent' | 'preserve', reason?: string }>}
 */
export async function cleanupTrackedLaunchdResource(tracked, io) {
  const print = await io.print(tracked.label)
  if (print.status !== 0 && print.status !== 113) {
    return { action: 'preserve', reason: `the manager query exited ${String(print.status)}` }
  }
  const loaded = print.status === 0
  const current = await io.readIdentity(tracked.plistPath)
  if (current === undefined) {
    if (loaded) return { action: 'preserve', reason: 'the job is loaded but the recorded plist is absent or not a regular file' }
    return { action: 'absent' }
  }
  if (!sameLaunchdIdentity(tracked.identity, current)) {
    return { action: 'preserve', reason: 'the current plist identity differs from the recorded identity' }
  }
  if (loaded) {
    const source = /^\s*path = (.+)$/mu.exec(print.stdout)?.[1]
    const expectedSource = await io.realpath(tracked.plistPath)
    if (source === undefined || source !== expectedSource) {
      return { action: 'preserve', reason: 'the loaded job source is not the recorded plist' }
    }
    const bootout = await io.bootout(tracked.label)
    if (bootout.status !== 0 && bootout.status !== 3) {
      return { action: 'preserve', reason: `bootout exited ${String(bootout.status)}` }
    }
    let unloaded = false
    for (let attempt = 0; attempt < (io.maxWaitAttempts ?? 50); attempt += 1) {
      if ((await io.print(tracked.label)).status === 113) {
        unloaded = true
        break
      }
      await io.sleep(io.pollMs ?? 100)
    }
    if (!unloaded) return { action: 'preserve', reason: 'the job did not leave the domain within the bounded wait' }
  }
  const beforeUnlink = await io.readIdentity(tracked.plistPath)
  if (!sameLaunchdIdentity(tracked.identity, beforeUnlink)) {
    return { action: 'preserve', reason: 'the plist identity changed again before removal' }
  }
  await io.unlink(tracked.plistPath)
  return { action: 'removed' }
}
