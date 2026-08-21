/**
 * Bash completion for `!`/`!!` shell lines: a real-shell `compgen` bridge
 * (docs/input-and-card-polish.md §1). Command names come from
 * `compgen -A command` (cached per cwd+PATH for 30s), `$VAR` names from
 * `compgen -A variable`, and subcommands from a small per-command table
 * (`git --list-cmds`). Path completion stays with the fork's fd-backed
 * provider — the bridge never competes with it.
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
 * @module @xmoon76/dsh-pi-tui/shell-completion
 */

import { spawn } from 'node:child_process'
import type { AutocompleteSuggestions } from '@xmoon76/pi-tui'
import { parseShellWords } from './shell-words.ts'

/**
 * Hard cap on one compgen spawn (ms). GitHub Actions runners are markedly
 * slower at a `bash -lc` cold start (measured 260-310ms in CI vs ~60ms
 * locally — a login shell sources /etc/profile, which is heavy on the
 * runner image), so a single tight cap made the suite flaky there (three
 * CI failures, every one at the 300ms boundary). The cap is therefore
 * raised under GitHub Actions only; local runs keep the tight cap.
 */
const COMPGEN_TIMEOUT_MS = process.env.GITHUB_ACTIONS === 'true' ? 1500 : 300
/** Command-name cache TTL (ms): command sets change rarely. */
const COMMAND_CACHE_TTL_MS = 30_000
/** Suggestion cap per request (the fork's own lists are capped too). */
const MAX_SUGGESTIONS = 50

/** Which completion the cursor needs on a `!` line. */
export type ShellCompletionKind = 'command' | 'subcommand' | 'variable'

/** The parsed completion context at the cursor on a `!` line. */
export interface ShellCompletionContext {
  readonly kind: ShellCompletionKind
  /** The word being completed ('' when the cursor sits right after a space). */
  readonly prefix: string
  /** The parsed words BEFORE the current word (no `!` prefix). */
  readonly priorWords: readonly string[]
}

/**
 * Parse the editor line at the cursor for shell completion. Returns a
 * context only when the line is a `!`/`!!` line AND the cursor completes a
 * shell-bridge word (command name, subcommand, `$VAR`); a path position
 * returns undefined so the caller falls through to the fork's fd
 * completion — paths are not the bridge's job.
 * @param line - the full editor line.
 * @param col - the cursor column.
 */
export function shellCompletionContext(line: string, col: number): ShellCompletionContext | undefined {
  if (!line.startsWith('!')) return undefined
  const prefixLength = line.startsWith('!!') ? 2 : 1
  const before = line.slice(prefixLength, col)
  const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t'))
  const currentWord = before.slice(lastSpace + 1)
  const prior = lastSpace === -1 ? '' : before.slice(0, lastSpace)
  const priorWords = parseShellWords(prior)
  if (priorWords.length === 0) {
    // The first word: a command name. An explicit path (`.`, `..`, `/`,
    // `~`) is a path, not a command — the fd provider owns it.
    if (currentWord.startsWith('.') || currentWord.startsWith('/') || currentWord.startsWith('~')) return undefined
    return { kind: 'command', prefix: currentWord, priorWords }
  }
  if (currentWord.startsWith('$')) {
    return { kind: 'variable', prefix: currentWord, priorWords }
  }
  if (priorWords.length === 1 && SUBCOMMAND_TABLE[priorWords[0]!] !== undefined) {
    return { kind: 'subcommand', prefix: currentWord, priorWords }
  }
  return undefined
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
type CompgenRunner = (cwd: string, expression: string, prefix: string, signal: AbortSignal) => Promise<CompgenRun>

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

/** Filter one candidate list to the prefix and cap it ('' prefix keeps all). */
function matchesFor(prefix: string, candidates: readonly string[]): AutocompleteSuggestions | null {
  const matched = prefix === ''
    ? candidates
    : candidates.filter(name => name.startsWith(prefix))
  if (matched.length === 0) return null
  return {
    items: matched.slice(0, MAX_SUGGESTIONS).map(name => ({ value: name, label: name })),
    prefix,
  }
}

/**
 * Suggest shell completions for a parsed `!` line context. Returns null
 * when nothing matches or the shell is unavailable — the editor then shows
 * no suggestions (the caller falls through to the fork's own provider).
 * @param context - the parsed cursor context.
 * @param cwd - the session workspace (compgen runs there).
 * @param options - the editor's request options (signal; force: an empty
 *   command prefix lists the cached commands on explicit Tab, while a
 *   natural trigger with an empty prefix stays quiet).
 */
export async function suggestShellCompletion(
  context: ShellCompletionContext,
  cwd: string,
  options: { signal: AbortSignal; force?: boolean },
): Promise<AutocompleteSuggestions | null> {
  // An already-aborted request never spawns a shell (the editor's latest
  // request won this race; a stale one must stay silent).
  if (options.signal.aborted) return null
  if (context.kind === 'command') {
    // A natural trigger with an empty prefix would flash the whole command
    // list on every `!` keystroke — only explicit Tab asks for it.
    if (context.prefix === '' && options.force !== true) return null
    const commands = await cachedCommands(cwd, options.signal)
    return matchesFor(context.prefix, commands)
  }
  if (context.kind === 'variable') {
    const run = await compgenRunner(cwd, 'compgen -A variable -- "$COMPGEN_WORD"', context.prefix.slice(1), options.signal)
    if (!run.ok) return null
    const items = run.lines.slice(0, MAX_SUGGESTIONS).map(name => ({ value: `$${name}`, label: `$${name}` }))
    return items.length === 0 ? null : { items, prefix: context.prefix }
  }
  // Subcommand of a known listable command: the live lister wins, the
  // static fallback covers commands/versions that cannot list themselves
  // (a failed lister is NOT a valid empty list).
  const command = context.priorWords[0]!
  const entry = SUBCOMMAND_TABLE[command]
  const run = await compgenRunner(cwd, entry.lister, '', options.signal)
  const candidates = run.ok && run.lines.length > 0
    ? run.lines.map(line => line.trim()).filter(line => line !== '')
    : entry.fallback
  return matchesFor(context.prefix, candidates)
}
