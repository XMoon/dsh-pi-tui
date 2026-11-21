#!/usr/bin/env node
/**
 * The system `script(1)` argv builder: how each platform spells "run this
 * shell command under a real PTY, quietly, without a typescript file".
 *
 * The two implementations are NOT interchangeable:
 *
 *   - GNU (Linux) `script -qefc '<command>' /dev/null` runs the command
 *     through `/bin/sh -c` itself, returns the child's exit status, and `-e`
 *     makes `script` exit with it;
 *   - BSD (macOS) `script -qF /dev/null /bin/sh -c '<command>'` requires the
 *     command as separate argv (no `-c` combo flag), `-F` flushes after every
 *     write, and the exit status is the LAST command's.
 *
 * The builder takes the ALREADY-SINGLE-STRING `sh -c` command the callers
 * compose with `shellQuote` and returns the platform argv; it never re-splits
 * or re-quotes the command. Windows has no `script(1)`: the caller refuses
 * (`NOT_SUPPORTED`) instead of pretending a PTY exists.
 *
 * DARWIN STDIN LIMIT (measured on macOS 27): BSD `script(1)` aborts with
 * `tcgetattr/ioctl: Operation not supported on socket` when its OWN stdin is a
 * socketpair (a Node `stdio: 'pipe'` child) or a FIFO; a regular file or
 * `/dev/null` is accepted. The PTY it creates for the command is fully
 * interactive either way, but a driver that streams live keystrokes from a
 * non-TTY parent must create a TTY on the DRIVER side (the split-smoke
 * surface-input path, deferred to the macOS Split work); pre-written input
 * files already exercise the real PTY data path.
 *
 * @module scripts/lib/pty-script
 */

/** The spawn plan for one `script(1)` invocation. */
export function ptyScriptArgv(platform, command, { program = 'script' } = {}) {
  if (command === undefined || command === null || command === '') {
    throw new Error('pty-script: a command string is required')
  }
  if (platform === 'linux') return { program, args: ['-qefc', command, '/dev/null'] }
  if (platform === 'darwin') return { program, args: ['-qF', '/dev/null', '/bin/sh', '-c', command] }
  return { program: undefined, args: [], unsupported: `pty-script: system script(1) is not supported on ${String(platform)}` }
}

/** Convenience wrapper: the spawn arguments for the CURRENT platform. */
export function currentPtyScriptArgv(command, options) {
  const plan = ptyScriptArgv(process.platform, command, options)
  if (plan.unsupported !== undefined) throw new Error(plan.unsupported)
  return plan
}
