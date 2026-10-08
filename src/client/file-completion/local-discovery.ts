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
  escapeFinderRegex,
  MAX_FINDER_RESULTS,
  normalizeFinderRecords,
  type LocalDirectoryEntry,
  type LocalDiscoveryDriver,
} from '../../domain/file-completion/discovery-policy.ts'
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
 * (non-zero exit, spawn error — NOT a valid empty result: the neutral policy
 * then runs the bounded fallback), `[]` on a genuine no-match or an abort. */
function runClientFinder(
  fdPath: string,
  baseDir: string,
  term: string,
  signal: AbortSignal,
): Promise<readonly PathCandidate[] | null> {
  const args = [
    '--base-directory', baseDir,
    '--max-results', String(MAX_FINDER_RESULTS),
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
    let stdout = ''
    let settled = false
    const settle = (results: readonly PathCandidate[] | null): void => {
      if (settled) return
      settled = true
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
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => settle(null))
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
      const results: PathCandidate[] = []
      for (const record of normalizeFinderRecords(stdout)) {
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
        results.push({ path: record.path, kind: isDirectory ? 'directory' : 'file' })
      }
      settle(results)
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

  constructor(fdPath: string | null | undefined = undefined) {
    this.fdPathValue = fdPath === undefined ? resolveFdPath() : fdPath
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
    return runClientFinder(this.fdPathValue, baseDir, term, signal)
  }
}
