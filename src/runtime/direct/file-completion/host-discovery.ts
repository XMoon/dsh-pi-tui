/**
 * The Direct Host discovery implementation (TS8-A, renamed by TS8-HF1): the
 * DIRECT process's filesystem behind the neutral {@link LocalDiscoveryDriver}
 * contract. Its ONE legitimate consumer is the explicit-path `@` navigation
 * route of the Session scope
 * (`runtime/direct/host-file-augmentation-direct.ts`), where the user
 * explicitly typed the scope (`@src/`, `@../`, `@/abs`, `@~/`).
 *
 * A BARE Session `@` query (`@foo`) never runs through this adapter — that
 * path is the OFFICIAL Host authority's (`ctx.fileReferences.list` through the
 * port), whose candidates arrive already filtered, ranked and bounded. The
 * sessionless `HostFileScope { kind: 'workspace', workspaceId }` route is the
 * OFFICIAL `WorkspaceFileSearch`
 * (`runtime/direct/file-completion/official-workspace-search.ts`) — this
 * finder never answers it.
 *
 * It owns the Direct Host process's own PATH/PATHEXT finder detection, its
 * `node:fs` facts and its fd/fdfind process. The small syscall-level
 * duplication against `client/file-completion/local-discovery.ts` is
 * deliberate: the two adapters read DIFFERENT machines under Remote, and one
 * concrete source owner for both localities is exactly what TS8-A removes.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/file-completion/host-discovery
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { PathQueryEnvironment } from '../../../domain/file-completion/query.ts'
import {
  createFinderRecordStream,
  escapeFinderRegex,
  MAX_FINDER_WALL_MS,
  type LocalDirectoryEntry,
  type LocalDiscoveryDriver,
} from '../../../domain/file-completion/discovery-policy.ts'
import { createBoundedFinderCandidateCollector } from '../../../domain/file-completion/ranking.ts'
import type { PathCandidate } from '../../../domain/file-completion/types.ts'

/**
 * The Direct Host process's explicit path-query environment facts. Under
 * Remote these are the HOST machine's facts, never the Client's; today Direct
 * runs in-process, so the numbers coincide — that coincidence is deliberately
 * not encoded in the domain contract.
 */
export function hostPathQueryEnvironment(): PathQueryEnvironment {
  return { homeDir: homedir(), windowsHost: process.platform === 'win32' }
}

/**
 * Locate an executable file-finder on the Direct Host process's PATH: `fd`
 * preferred, `fdfind` second. See the Client adapter for the probe contract.
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

/** Join a Host path WITHOUT collapsing a `..` segment. The Host's filesystem
 * backend anchors a POSIX path containing a `..` segment with its physical
 * spelling (the kernel resolves an intermediate symlink before the parent step),
 * so a search base that deliberately keeps that traversal may not be lexically
 * re-normalized on the way to a syscall. For every base the neutral resolver
 * already normalized (no `..` left) this is identical to `path.join`. */
function hostJoin(baseDir: string, relative: string): string {
  if (relative === '') return baseDir
  return baseDir.endsWith('/') ? `${baseDir}${relative}` : `${baseDir}/${relative}`
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
      return statSync(hostJoin(baseDir, name)).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

/** Run the Direct Host finder for one scoped query. Returns NULL on finder
 * FAILURE (non-zero exit, spawn error, truncated output, over-bound record,
 * over-budget run — the neutral policy then runs the bounded fallback), `[]`
 * on a genuine no-match or an abort.
 *
 * Like the Client adapter, the Host finder runs without an argv result cap,
 * streams every match into the same neutral two-top-50 collector, and owns the
 * ONE {@link MAX_FINDER_WALL_MS} wall budget (Owner amendment D4). */
function runHostFinder(
  fdPath: string,
  baseDir: string,
  term: string,
  signal: AbortSignal,
  finderWallMs: number,
  now: () => number = performance.now,
): Promise<readonly PathCandidate[] | null> {
  const args = [
    '--base-directory', baseDir,
    '-i',
    '--full-path',
    '--print0',
    '--type', 'f',
    '--type', 'd',
    '--type', 'l',
    '--hidden',
    '--exclude', '.git',
    '--exclude', '.git/*',
    '--exclude', '.git/**',
  ]
  if (term !== '') args.push(escapeFinderRegex(term))
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve([])
      return
    }
    let child
    try {
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
        try {
          isDirectory = statSync(hostJoin(baseDir, record.path)).isDirectory()
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
      if (settled) return
      if (!records.push(chunk)) {
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
 * The Direct Host discovery driver: the Direct Host process's OWN filesystem,
 * with a Host PATH finder when present.
 *
 * `fdPath` is a test/API pin: `undefined` probes the Host PATH, `null` FORCES
 * the bounded fallback (no finder), a string pins one finder.
 */
export class DirectHostDiscoveryDriver implements LocalDiscoveryDriver {
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

  /** The pinned/detected Host finder (null = bounded-fallback only). */
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
      entries = readdirSync(hostJoin(baseDir, relativeDir), { withFileTypes: true })
    } catch {
      return null
    }
    if (signal.aborted) return null
    const dir = hostJoin(baseDir, relativeDir)
    return entries.map(entry => ({
      name: entry.name,
      kind: entryIsDirectory(dir, entry.name, entry) ? 'directory' : 'file',
      descendable: entry.isDirectory() && !entry.isSymbolicLink(),
    }))
  }

  async find(baseDir: string, term: string, signal: AbortSignal): Promise<readonly PathCandidate[] | null> {
    if (this.fdPathValue === null) return null
    return runHostFinder(this.fdPathValue, baseDir, term, signal, this.finderWallMsValue, this.nowValue)
  }
}
