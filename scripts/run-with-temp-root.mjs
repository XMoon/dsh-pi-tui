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
 * Set DSH_TEST_KEEP_TMP=1 to keep (and print) the run root for debugging.
 */
import { spawn } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  const plan = buildSpawnPlan(command.flatMap(expandGlob))
  const child = spawn(plan.command, plan.args, {
    stdio: 'inherit',
    shell: plan.shell,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  })

  const forwardSignal = (signal) => {
    if (!child.killed) {
      try {
        child.kill(signal)
      } catch {
        // The child may have settled between the check and the kill.
      }
    }
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))
  process.on('SIGHUP', () => forwardSignal('SIGHUP'))

  function disposeRoot() {
    if (keep) {
      process.stderr.write(`[run-with-temp-root] keeping ${root} (DSH_TEST_KEEP_TMP=1)\n`)
      return
    }
    rmSync(root, { recursive: true, force: true })
  }

  child.on('error', (error) => {
    disposeRoot()
    console.error(`[run-with-temp-root] failed to spawn ${plan.command}: ${error.message}`)
    process.exit(1)
  })

  child.on('close', (code, signal) => {
    disposeRoot()
    if (code !== null) {
      process.exitCode = code
      return
    }
    // Mirror death-by-signal with the conventional 128+signo exit code.
    const signo = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 0
    process.exitCode = signo > 0 ? 128 + signo : 1
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
}
