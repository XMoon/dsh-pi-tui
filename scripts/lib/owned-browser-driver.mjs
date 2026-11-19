/**
 * Ownership for ONE detached real-Browser driver process group.
 *
 * The Browser drivers spawn their own Chromium children. A timeout, a failed
 * assertion or a hung `browser.close()` must not leave that group (or its
 * pipes) behind for the smoke lane. This helper makes the process group an
 * explicit owner on every exit path: the bounded wait runs inside `try`, and
 * the `finally` kills the whole group and waits for the real exit.
 *
 * @module scripts/lib/owned-browser-driver
 */

import { spawn } from 'node:child_process'

/**
 * Run one detached driver and always reap its process group.
 *
 * @param command - executable (normally `process.execPath`).
 * @param args - executable arguments.
 * @param options - spawn options; `detached` is forced on.
 * @param timeoutMs - how long the driver may run before the bound reports a timeout.
 * @param cleanupMs - how long the killed group may take to exit before the lane gives up.
 * @param bounded - `(exit, timeoutMs, tag) => Promise<{code, signal}>` bound helper.
 * @param tag - diagnostic prefix for both bounds.
 * @param onSpawn - optional observer called synchronously with the child (attach stream listeners here).
 * @returns the spawn result plus the final bounded exit and the actual exit promise.
 */
export async function runOwnedDetachedDriver({
  command,
  args,
  options,
  timeoutMs,
  cleanupMs,
  bounded,
  tag,
  onSpawn,
}) {
  const child = spawn(command, args, { ...options, detached: true })
  const exit = new Promise((resolveExit) => {
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })
  onSpawn?.(child)
  let finished
  try {
    finished = await bounded(exit, timeoutMs, `${tag}_TIMEOUT`)
  } finally {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
    await bounded(exit, cleanupMs, `${tag}_CLEANUP`)
  }
  return { child, exit, finished }
}
