/**
 * Client-local shell completion capability (TS8-E): the real-shell `compgen`
 * bridge (docs/input-and-card-polish.md §1). Command names come from
 * `compgen -A command` (cached per cwd+PATH for 30s), `$VAR` names from
 * `compgen -A variable`, and subcommands from a small per-command table
 * (`git --list-cmds`). Path completion stays with the fork's fd-backed
 * provider — the bridge never competes with it.
 *
 * This is a CLIENT-LOCAL platform capability (a subprocess on the Client
 * machine): it returns plain candidate strings, never PiTui types. The
 * editor's trigger grammar and suggestion shaping live in
 * `tui/interaction/autocomplete/shell.ts`.
 *
 * Decisions that matter (design doc):
 * - `bash -lc`, never `-ic`: an interactive shell sources `.bashrc` on
 *   every keystroke (slow, and runs user startup code). Alias completion
 *   is therefore not provided — accepted limitation.
 * - One spawn per request, hard-capped at COMPGEN_TIMEOUT_MS and wired to
 *   the editor's AbortSignal; the caller commits latest-only. A slow or
 *   missing `bash` degrades to no suggestions, never an error.
 * - The completion prefix crosses to bash through an environment variable
 *   (COMPGEN_WORD), never string interpolation — no shell injection from
 *   the user's own draft.
 * @module @xmoon76/dsh-pi-tui/client/shell/compgen
 */

import { spawn } from 'node:child_process'

/**
 * Hard cap on one compgen spawn (ms). GitHub Actions runners are markedly
 * slower at a `bash -lc` cold start (measured 260-310ms in CI vs ~60ms
 * locally — a login shell sources /etc/profile, which is heavy on the
 * runner image), so a single tight cap made the suite flaky there (three
 * CI failures, every one at the 300ms boundary). CI therefore runs with a
 * generous 3000ms cap; local runs get 1000ms — a tight local cap (300ms)
 * hit the SAME boundary under parallel test load (a cold login-shell
 * spawn measured ~125ms standalone but exceeded 300ms while the node
 * --test runner saturated the CPU; two pre-push gate failures, every one
 * the first spawn of the file). Both caps are still hard bounds, never a
 * hang.
 */
const COMPGEN_TIMEOUT_MS = process.env.GITHUB_ACTIONS === 'true' ? 3000 : 1000
/** Command-name cache TTL (ms): command sets change rarely. */
const COMMAND_CACHE_TTL_MS = 30_000
/** Suggestion cap per request (the fork's own lists are capped too). */
export const MAX_SHELL_CANDIDATES = 50

/** One settled compgen run: whether the shell completed cleanly (exit 0)
 * and its stdout lines. `ok: false` covers timeout kills, aborts, spawn
 * failures and non-zero exits — the caller must NOT treat it as a valid
 * empty result (a failed run cached as "no commands" would suppress
 * completion for the whole TTL). */
export interface CompgenRun {
  readonly ok: boolean
  readonly lines: readonly string[]
}

/** The compgen runner seam: the real spawn is default; tests inject a fake
 * runner to make timeout/abort/failure/cache behavior deterministic. */
export type CompgenRunner = (cwd: string, expression: string, prefix: string, signal: AbortSignal) => Promise<CompgenRun>

let compgenRunner: CompgenRunner = (cwd, expression, prefix, signal) => runCompgenSpawn(cwd, expression, prefix, signal)

/** Test seam: replace the spawn-backed runner (restore with
 * {@link setCompgenRunnerForTest} and the original). */
export function setCompgenRunnerForTest(runner: CompgenRunner | undefined): void {
  if (runner === undefined) {
    compgenRunner = (cwd, expression, prefix, signal) => runCompgenSpawn(cwd, expression, prefix, signal)
    return
  }
  compgenRunner = runner
}

/** Test seam: drop every cached command list (a failed run must never have
 * cached anything; this also resets between tests that mutate PATH). */
export function resetCommandCacheForTest(): void {
  commandCache.clear()
}

function runCompgenSpawn(cwd: string, expression: string, prefix: string, signal: AbortSignal): Promise<CompgenRun> {
  return new Promise<CompgenRun>((resolve) => {
    const settle = (ok: boolean, lines: readonly string[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ ok, lines })
    }
    let settled = false
    const onAbort = (): void => {
      child.kill()
      settle(false, [])
    }
    const child = spawn('bash', ['-lc', expression], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COMPGEN_WORD: prefix },
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(false, [])
    }, COMPGEN_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    // stderr is ignored: a missing command or a bash error is "no
    // suggestions", never an editor-visible error.
    child.stderr.on('data', () => {})
    child.on('error', () => settle(false, []))
    child.on('close', (code) => {
      settle(code === 0, out.split('\n').filter(line => line !== ''))
    })
  })
}

interface CommandCacheEntry {
  readonly expires: number
  readonly commands: readonly string[]
}

/** Command-name cache, keyed by cwd + PATH (30s TTL). Only SUCCESSFUL runs
 * are cached — a failed run (timeout/abort/spawn error) must not suppress
 * completion for the whole TTL, so the next request retries the spawn. */
const commandCache = new Map<string, CommandCacheEntry>()

/** The cached `compgen -A command` list for one cwd+PATH, refreshed on
 * expiry or after a failed run. */
async function cachedCommands(cwd: string, signal: AbortSignal): Promise<readonly string[]> {
  const key = `${cwd}\0${process.env.PATH ?? ''}`
  const entry = commandCache.get(key)
  if (entry !== undefined && entry.expires > Date.now()) return entry.commands
  const run = await compgenRunner(cwd, 'compgen -A command', '', signal)
  if (!run.ok) return []
  commandCache.set(key, { expires: Date.now() + COMMAND_CACHE_TTL_MS, commands: run.lines })
  return run.lines
}

/**
 * Per-command subcommand completion. `lister` emits the live list (one
 * name per line, no headers) when the installed command supports it;
 * `fallback` covers older versions (e.g. git before 2.18 has no
 * `--list-cmds`) and is used when the lister produces nothing. Extend the
 * table with one entry per command.
 */
const SUBCOMMAND_TABLE: Readonly<Record<string, { lister: string; fallback: readonly string[] }>> = {
  git: {
    lister: 'git --list-cmds 2>/dev/null',
    fallback: [
      'add', 'am', 'archive', 'bisect', 'branch', 'bundle', 'checkout',
      'cherry-pick', 'clean', 'clone', 'commit', 'config', 'diff', 'fetch',
      'init', 'log', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset',
      'restore', 'revert', 'rm', 'show', 'stash', 'status', 'switch', 'tag',
    ],
  },
}

/** Whether one command has subcommand completion in the shell bridge. The
 * editor's trigger grammar asks this synchronously to decide whether a
 * second word is a subcommand position. */
export function hasSubcommandCompletion(command: string): boolean {
  return SUBCOMMAND_TABLE[command] !== undefined
}

/** What candidate set the caller needs on a `!` line. */
export type ShellCandidateRequest =
  | { readonly kind: 'commands' }
  | { readonly kind: 'variables'; readonly prefix: string }
  | { readonly kind: 'subcommands'; readonly command: string }

/**
 * Acquire one plain candidate list for the shell adapter. Never throws and
 * never returns a PiTui type: a missing `bash` or a failed run degrades to an
 * empty list (the editor then shows no suggestions). The subcommand path uses
 * the live lister when it succeeds and the static fallback otherwise.
 * @param request - the candidate kind (variables carry the prefix WITHOUT `$`).
 * @param cwd - the directory compgen runs in.
 * @param signal - the editor's request signal.
 */
export async function requestShellCandidates(
  request: ShellCandidateRequest,
  cwd: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (request.kind === 'commands') return cachedCommands(cwd, signal)
  if (request.kind === 'variables') {
    const run = await compgenRunner(cwd, 'compgen -A variable -- "$COMPGEN_WORD"', request.prefix, signal)
    return run.ok ? run.lines.slice(0, MAX_SHELL_CANDIDATES) : []
  }
  const entry = SUBCOMMAND_TABLE[request.command]
  const run = await compgenRunner(cwd, entry.lister, '', signal)
  return run.ok && run.lines.length > 0
    ? run.lines.map(line => line.trim()).filter(line => line !== '')
    : entry.fallback
}
