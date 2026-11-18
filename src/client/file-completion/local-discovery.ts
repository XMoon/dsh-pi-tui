/**
 * The Client-LOCAL discovery implementation (TS8-A): the Client process's own
 * filesystem behind the neutral {@link LocalDiscoveryDriver} contract. It owns
 * the Client PATH/PATHEXT finder detection, the Client `node:fs` facts and the
 * Client fd/fdfind process — nothing about the Host workspace, the session
 * scope or terminal presentation.
 *
 * `/attach` and `/image` path arguments and the Save Location directory chooser
 * are CLIENT-local capabilities: under a future Remote attach they must keep
 * reading the CLIENT filesystem, which is exactly why this adapter cannot be
 * owned by `runtime/direct`.
 * @module @xmoon76/dsh-pi-tui/client/file-completion/local-discovery
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { PathQueryEnvironment } from '../../domain/file-completion/query.ts'
import {
  createFinderRecordStream,
  escapeFinderRegex,
  MAX_FINDER_WALL_MS,
  type LocalDirectoryEntry,
  type LocalDiscoveryDriver,
} from '../../domain/file-completion/discovery-policy.ts'
import { createBoundedFinderCandidateCollector } from '../../domain/file-completion/ranking.ts'
import type { PathCandidate } from '../../domain/file-completion/types.ts'

/**
 * The Client process's explicit path-query environment facts. The domain
 * resolver never discovers these itself; the locality owner supplies them.
 */
export function clientPathQueryEnvironment(): PathQueryEnvironment {
  return { homeDir: homedir(), windowsHost: process.platform === 'win32' }
}

/**
 * Locate an executable file-finder on the CLIENT PATH: `fd` preferred,
 * `fdfind` (Debian/Ubuntu's fd-find) second (kimi parity). Bare command names
 * resolve through PATH at spawn time; absolute/relative entries must exist and
 * be X_OK. The platform PATH delimiter and PATHEXT suffixes keep the same probe
 * correct on Windows hosts too.
 */
export function resolveFdPath(): string | null {
  const pathEntries = process.env.PATH?.split(delimiter) ?? []
  const pathExt = process.env.PATHEXT || (process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : '')
  const suffixes = pathExt
    .split(';')
    .map(suffix => suffix.trim())
    .filter(suffix => suffix !== '')
    .flatMap(suffix => suffix.toLowerCase() === suffix ? [suffix] : [suffix, suffix.toLowerCase()])
  for (const name of ['fd', 'fdfind']) {
    for (const entry of pathEntries) {
      // An empty POSIX PATH component means the current directory. Keep it
      // rather than silently changing the shell's lookup semantics.
      const dir = entry === '' ? '.' : entry
      for (const suffix of ['', ...suffixes]) {
        const candidate = join(dir, `${name}${suffix}`)
        try {
          // X_OK alone also succeeds for a directory on POSIX. Only return a
          // regular file that is executable; a directory named `fd` must not
          // poison discovery before the fallback gets a chance to run.
          if (statSync(candidate).isFile() && accessSync(candidate, fsConstants.X_OK) === undefined) {
            return candidate
          }
        } catch {
          // Not here; keep scanning.
        }
      }
    }
  }
  return null
}

/** Whether one Dirent is a directory (symlinks followed; a broken link is a
 * file candidate — the fork's rule). */
function entryIsDirectory(
  baseDir: string,
  name: string,
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      return statSync(join(baseDir, name)).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

/** Run the CLIENT finder for one query. Returns NULL on finder FAILURE
 * (non-zero exit, spawn error, truncated output, over-bound record, over-budget
 * run — NOT a valid empty result: the neutral policy then runs the bounded
 * fallback), `[]` on a genuine no-match or an abort.
 *
 * The finder runs UNBOUNDED by any argv result cap: every match it produces
 * competes in the neutral two-top-50 collector (all types + directories only)
 * as it streams out of the process, so a highly relevant late match is never
 * lost to an early-output cutoff. The ONE wall-clock budget
 * ({@link MAX_FINDER_WALL_MS}, Owner amendment D4) bounds the whole run: an
 * over-budget finder is killed and settles as a failure, never as a partial
 * success. Neither the whole stdout nor the whole record list is retained. */
function runClientFinder(
  fdPath: string,
  baseDir: string,
  term: string,
  signal: AbortSignal,
  finderWallMs: number,
  now: () => number = performance.now,
): Promise<readonly PathCandidate[] | null> {
  const args = [
    '--base-directory', baseDir,
    // The finder's DEFAULT is smart-case (case-insensitive for a lowercase
    // query, case-SENSITIVE when the query contains uppercase) — but the
    // shared ranking contract is case-INSENSITIVE (scorePathCandidate
    // lowercases both sides). Forced --ignore-case keeps the finder discovery
    // semantics aligned with the ranking model: @FOO finds foo.txt, exactly
    // like the bounded-scan fallback path.
    '-i',
    '--full-path',
    '--print0',
    '--type', 'f',
    '--type', 'd',
    // Include symlinks as candidates but do not follow them during descent;
    // the bounded fallback exposes symlink entries and classifies a symlink
    // to a directory as a directory without traversing it.
    '--type', 'l',
    '--hidden',
    '--exclude', '.git',
    '--exclude', '.git/*',
    '--exclude', '.git/**',
  ]
  // The finder matches the query against the FULL relative path: an unscoped
  // `@src` must also see a candidate such as `src/readme`, not only an entry
  // whose basename is `src`. The pattern is a REGEX — a user's literal term
  // containing regex metacharacters (`foo[1].ts`, `a+b.ts`) would silently
  // match nothing, so the term is escaped to its literal form. The filenames
  // themselves (candidate paths the finder prints) are taken VERBATIM.
  if (term !== '') args.push(escapeFinderRegex(term))
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve([])
      return
    }
    let child
    try {
      // stderr is intentionally ignored: discovery treats every non-zero exit
      // as a fallback signal, and a pipe that is never drained can deadlock a
      // noisy finder before it reaches its close event.
      child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const collector = createBoundedFinderCandidateCollector(term)
    // The ONE wall-clock budget (Owner amendment D4): a monotonic deadline the
    // timer AND the per-record processing both check, so a synchronous
    // record/stat burst cannot starve the timer and run on unbounded.
    const deadline = now.call(performance) + finderWallMs
    let settled = false
    let budgetTimer: NodeJS.Timeout | undefined
    const stopBudget = (): void => {
      if (budgetTimer !== undefined) {
        clearTimeout(budgetTimer)
        budgetTimer = undefined
      }
    }
    const settle = (results: readonly PathCandidate[] | null): void => {
      if (settled) return
      settled = true
      stopBudget()
      signal.removeEventListener('abort', onAbort)
      resolve(results)
    }
    const onAbort = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL')
      // Do not wait for a misbehaving child to acknowledge SIGKILL before the
      // editor request settles. The close handler is idempotent and will only
      // discard the eventual process event.
      settle([])
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // With the production clock the timer enforces the same wall budget.
    // A custom clock (tests) controls the deadline deterministically; the
    // timer is unnecessary there and would race the injected decisions.
    if (now === performance.now) {
      budgetTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        settle(null)
      }, finderWallMs)
    }
    // Record classification must re-check the deadline at least every 64
    // records (amendment D5): the emit callback runs inside the synchronous
    // stream push, where a timer cannot fire.
    let recordsSinceDeadlineCheck = 0
    const records = createFinderRecordStream((record) => {
      let isDirectory = record.directoryHint
      if (!isDirectory) {
        // The finder's default print format does not guarantee a trailing
        // `/` for directories: classify the fact against the Client fs
        // (statSync follows symlinks, so a symlink dir still completes with
        // the directory kind).
        try {
          isDirectory = statSync(join(baseDir, record.path)).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      collector.offer({ path: record.path, kind: isDirectory ? 'directory' : 'file' })
      recordsSinceDeadlineCheck += 1
      if (recordsSinceDeadlineCheck >= 64) {
        recordsSinceDeadlineCheck = 0
        if (now.call(performance) >= deadline) {
          if (child.exitCode === null) child.kill('SIGKILL')
          settle(null)
        }
      }
    }, { shouldStop: () => settled })
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      // A settled request (abort, budget or an earlier failure) never consumes
      // later stdout: no partial candidate may publish after its request ended.
      if (settled) return
      if (!records.push(chunk)) {
        // An over-bound unterminated record or an abandoned run is an external
        // process failure: discard the partial collector so the neutral
        // fallback answers.
        if (child.exitCode === null) child.kill('SIGKILL')
        settle(null)
      }
    })
    child.on('error', () => settle(null))
    child.stdout.on('error', () => {
      // A stdout stream error is an INCOMPLETE finder run: stop the producer
      // so nothing keeps filling a dead pipe and settle once as a failure.
      if (child.exitCode === null) child.kill('SIGKILL')
      settle(null)
    })
    child.on('close', (code) => {
      if (signal.aborted) {
        settle([])
        return
      }
      if (code !== 0) {
        // The finder FAILED (missing binary race, malformed invocation, cwd
        // permission): NOT a valid empty result — the bounded scan fallback
        // must answer.
        settle(null)
        return
      }
      if (now.call(performance) >= deadline) {
        // The whole finder work — spawn through the last record and the close
        // itself — owns ONE budget (amendment D4): a late close is a failure,
        // never a partial success.
        settle(null)
        return
      }
      if (!records.finish()) {
        settle(null)
        return
      }
      // `finish()` synchronously classifies any buffered newline-dialect
      // records; a slow burst can cross the deadline INSIDE it. Re-check AFTER
      // the work, so an over-budget run can never settle as a success.
      if (now.call(performance) >= deadline) {
        settle(null)
        return
      }
      settle(collector.finish())
    })
  })
}

/**
 * The `/attach` + `/image` + Save Location completion driver: the Client's OWN
 * filesystem, with a Client PATH finder when present.
 *
 * The constructor injection seam is deterministic and preserved from the
 * pre-TS8-A local source: `undefined` probes the Client PATH, `null` FORCES
 * the bounded fallback (no finder), a string pins one finder.
 */
export class ClientLocalDiscoveryDriver implements LocalDiscoveryDriver {
  private readonly fdPathValue: string | null
  private readonly finderWallMsValue: number
  private readonly nowValue: () => number

  constructor(
    fdPath: string | null | undefined = undefined,
    finderWallMs: number = MAX_FINDER_WALL_MS,
    now: () => number = performance.now,
  ) {
    this.fdPathValue = fdPath === undefined ? resolveFdPath() : fdPath
    this.finderWallMsValue = finderWallMs
    this.nowValue = now
  }

  /** The pinned/detected Client finder (null = bounded-fallback only). */
  get fdPath(): string | null {
    return this.fdPathValue
  }

  async listDirectory(
    baseDir: string,
    relativeDir: string,
    signal: AbortSignal,
  ): Promise<readonly LocalDirectoryEntry[] | null> {
    if (signal.aborted) return null
    let entries
    try {
      entries = readdirSync(join(baseDir, relativeDir), { withFileTypes: true })
    } catch {
      return null
    }
    if (signal.aborted) return null
    const dir = join(baseDir, relativeDir)
    return entries.map(entry => ({
      name: entry.name,
      kind: entryIsDirectory(dir, entry.name, entry) ? 'directory' : 'file',
      descendable: entry.isDirectory() && !entry.isSymbolicLink(),
    }))
  }

  async find(baseDir: string, term: string, signal: AbortSignal): Promise<readonly PathCandidate[] | null> {
    if (this.fdPathValue === null) return null
    return runClientFinder(this.fdPathValue, baseDir, term, signal, this.finderWallMsValue, this.nowValue)
  }
}
