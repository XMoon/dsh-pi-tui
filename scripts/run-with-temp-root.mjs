#!/usr/bin/env node
/**
 * Generic test-run temp-root containment: run any command with TMPDIR/TMP/
 * TEMP pointed at a disposable directory, then remove that directory once
 * the child settles — so a forgotten fixture cleanup can only ever leave
 * one runner root behind, not hundreds of scattered `dsh-*` directories in
 * the system temp root. SIGKILL/power loss may still leave the parent root
 * (that is the OS temp hygiene's domain, not ours).
 *
 * The child is spawned WITHOUT a shell, so glob patterns are never
 * shell-expanded. Instead the runner expands argv entries that contain
 * glob metacharacters itself (fs.globSync, sorted; an entry with no
 * matches is passed through literally so the command can report it).
 * Commands that accept explicit file lists (node --test) therefore work
 * with both quoted and unquoted patterns.
 *
 * On Windows, commands like `pnpm` are .cmd shims that CreateProcess
 * cannot run directly; buildSpawnPlan resolves them on PATH and delegates
 * to cmd.exe /d /s /c with a properly quoted command line (each argument
 * double-quoted, embedded quotes doubled — cmd's own escaping rule), so
 * argv semantics survive the shell handoff.
 *
 * NOT for `dev:bootstrap`: its ephemeral source distribution outlives the
 * bootstrap process (other shells keep using it), so it must never run
 * under a root that dies with this runner.
 *
 * SIGNALS: on POSIX the child leads its OWN process group, so a forwarded
 * SIGINT/SIGTERM/SIGHUP reaches the processes it started (a shell's command,
 * pnpm's script processes), and the root is removed only once the whole group
 * is provably gone — a bounded grace, then ONE SIGKILL escalation. The direct
 * child's `close` alone is not the group's end, on a NORMAL exit either: a
 * command that left a descendant running keeps (and reports) its root instead
 * of deleting a directory that process still uses. On Windows there is no
 * group id to address, so the signal is forwarded to the direct child only.
 *
 * EXIT STATUS: a clean run passes the child's status through, but an
 * INTERRUPTED run reports the first received SIGINT/SIGTERM/SIGHUP
 * (128+signo), even when the child handles the signal and exits 0. A cleanup
 * that cannot be proven is NON-ZERO as well: a command's success does not
 * excuse a temp root (or a process group) left behind.
 *
 * Set DSH_TEST_KEEP_TMP=1 to keep (and print) the run root for debugging.
 */
import { spawn } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { groupStillAlive, stopOwnedGroup } from './lib/owned-process-group.mjs'

const usage = 'usage: node scripts/run-with-temp-root.mjs <command> [args...]'

const GLOB_METACHARACTERS = /[*?[\]{}]/u

function expandGlob(argument) {
  if (!GLOB_METACHARACTERS.test(argument)) return [argument]
  let matches = []
  try {
    matches = globSync(argument, { nodir: false })
  } catch {
    // globSync unavailable or the pattern is invalid: pass through.
    return [argument]
  }
  if (matches.length === 0) return [argument]
  return matches.sort()
}

/** cmd.exe quoting: wrap in double quotes, double any embedded quote. */
function cmdQuote(part) {
  return `"${String(part).replaceAll('"', '""')}"`
}

/** Resolve a command name to an executable on PATH (Windows PATHEXT order). */
function resolveWindowsCommand(command, pathEnv, pathextEnv, cwd) {
  if (command.includes('\\') || command.includes('/')) return command
  const extensions = (pathextEnv ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const directory of (pathEnv ?? '').split(';')) {
    for (const extension of extensions) {
      // An empty PATH entry means the current directory on Windows — it
      // must be honored, not skipped.
      const candidate = directory === '' ? join(cwd, command + extension.toLowerCase()) : join(directory, command + extension.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Decide how to spawn an argv: on POSIX the command runs directly; on
 * Windows a resolved .cmd/.bat shim is delegated to cmd.exe with a quoted
 * command line, and a real executable (or an explicit path) runs directly.
 * Exported and platform-injectable so the Windows paths are unit-testable
 * from any host.
 */
export function buildSpawnPlan(argv, { platform = process.platform, comspec = process.env.ComSpec, pathEnv = process.env.PATH, pathextEnv = process.env.PATHEXT, cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv
  if (platform !== 'win32') return { command, args: rest, shell: false }
  const resolved = resolveWindowsCommand(command, pathEnv, pathextEnv, cwd)
  if (resolved === undefined) return { command, args: rest, shell: false }
  if (/\.(cmd|bat)$/iu.test(resolved)) {
    // cmd.exe /d /s /c strips the FIRST and LAST quote of the command
    // line, so the whole line is wrapped in an outer quote pair: the inner
    // per-argument quotes survive and paths with spaces parse correctly.
    const line = `"${[resolved, ...rest].map(cmdQuote).join(' ')}"`
    return { command: comspec ?? 'cmd.exe', args: ['/d', '/s', '/c', line], shell: false }
  }
  return { command: resolved, args: rest, shell: false }
}

const SCRIPT_PATH = fileURLToPath(import.meta.url)

function main() {
  const command = process.argv.slice(2)
  if (command.length === 0) {
    console.error(usage)
    process.exit(2)
  }

  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-test-run-'))
  const keep = process.env.DSH_TEST_KEEP_TMP === '1'
  // POSIX only: the direct child leads its own process group, which is what a
  // forwarded signal can address as a TREE. Windows has no group id, so it
  // keeps the previous direct-child forwarding.
  const ownsGroup = process.platform !== 'win32'

  const plan = buildSpawnPlan(command.flatMap(expandGlob))
  const child = spawn(plan.command, plan.args, {
    stdio: 'inherit',
    shell: plan.shell,
    detached: ownsGroup,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  })

  let childResult
  let resolveClosed
  /** Resolves on the direct child's `close`, never on a group fact. */
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  let finished = false
  let teardownStarted = false

  function disposeRoot() {
    if (keep) {
      process.stderr.write(`[run-with-temp-root] keeping ${root} (DSH_TEST_KEEP_TMP=1)\n`)
      return
    }
    rmSync(root, { recursive: true, force: true })
  }

  /**
   * The ONE place this runner finishes: whatever combination of child close,
   * spawn failure and signal teardown reaches it first, the temp root is
   * removed at most once and the exit code is set at most once.
   */
  const SIGNAL_EXIT = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 }
  // The first interruption signal this runner received, if any. It owns the
  // runner's exit status: a child that "handles" SIGTERM and exits 0 must not
  // turn an interrupted run into a success.
  let receivedSignal
  /** The runner's OWN status; the child's result is diagnostic. */
  const exitCodeOf = () => {
    if (receivedSignal !== undefined) return 128 + (SIGNAL_EXIT[receivedSignal] ?? 0)
    if (childResult === undefined) return 1
    if (childResult.code !== null) return childResult.code
    // Mirror death-by-signal with the conventional 128+signo exit code.
    const signo = SIGNAL_EXIT[childResult.signal] ?? 0
    return signo > 0 ? 128 + signo : 1
  }
  const describeChild = () => (childResult === undefined
    ? 'the direct child did not finish'
    : childResult.code !== null ? `the direct child exited ${childResult.code}` : `the direct child was terminated by ${childResult.signal}`)
  function finish(settled, detail) {
    if (finished) return
    finished = true
    if (settled) {
      disposeRoot()
    } else {
      // The root IS the child's TMPDIR. Removing it while a descendant still
      // runs would delete the very directory that process is using, so an
      // unproven group keeps the root and says so instead of claiming a
      // cleanup it cannot prove.
      process.stderr.write(`[run-with-temp-root] cleanup unproven: keeping ${root}: ${detail} (${describeChild()})\n`)
    }
    // A cleanup that cannot be proven is NOT a pass: the run gets a non-zero
    // status and the child's own result stays diagnostic. The interruption
    // signal already makes the status non-zero on its own path.
    process.exitCode = settled || receivedSignal !== undefined ? exitCodeOf() : 1
  }

  child.on('error', (error) => {
    // A child that never spawned has no group and no status: the spawn failure
    // wins and is reported as such.
    if (finished) return
    finished = true
    disposeRoot()
    console.error(`[run-with-temp-root] failed to spawn ${plan.command}: ${error.message}`)
    process.exitCode = 1
  })

  child.on('close', (code, signal) => {
    childResult = { code, signal }
    resolveClosed()
    if (teardownStarted) return
    // A normal close is only the DIRECT child's end. A descendant it started
    // can still be using the root, and the root must not be deleted
    // underneath it — the same rule the signal path follows.
    if (ownsGroup && groupStillAlive(child)) {
      finish(false, `process group ${child.pid} still has live members after the direct child exited`)
      return
    }
    finish(true)
  })

  const onSignal = (signal) => {
    if (teardownStarted || finished) return
    teardownStarted = true
    receivedSignal = signal
    void (async () => {
      let settled = true
      if (ownsGroup) {
        settled = await stopOwnedGroup(child, signal)
      } else {
        try {
          child.kill(signal)
        } catch {
          // The child may have settled between the check and the kill.
        }
      }
      if (!settled) {
        finish(false, `process group ${child.pid} still has live members after SIGKILL`)
        return
      }
      await closed
      finish(true)
    })()
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGHUP', () => onSignal('SIGHUP'))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
}
