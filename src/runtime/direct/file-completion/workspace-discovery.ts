/**
 * The Direct Host WORKSPACE discovery implementation (TS8-A): the DIRECT
 * process's filesystem behind the neutral {@link LocalDiscoveryDriver}
 * contract, used only by the sessionless `HostFileScope { kind: 'workspace',
 * cwd }` compatibility path of `DirectHostFilePort`.
 *
 * A live Session `@` discovery never runs through this adapter — that path is
 * the OFFICIAL Host authority's (`ctx.fileReferences.list` through the port),
 * whose candidates arrive already filtered, ranked and bounded, and it has no
 * official Remote carrier, so the workspace compatibility path stays
 * Direct-only.
 *
 * It owns the Direct Host process's own PATH/PATHEXT finder detection, its
 * `node:fs` facts and its fd/fdfind process. The small syscall-level
 * duplication against `client/file-completion/local-discovery.ts` is
 * deliberate: the two adapters read DIFFERENT machines under Remote, and one
 * concrete source owner for both localities is exactly what TS8-A removes.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/file-completion/workspace-discovery
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { PathQueryEnvironment } from '../../../domain/file-completion/query.ts'
import {
  escapeFinderRegex,
  MAX_FINDER_RESULTS,
  normalizeFinderRecords,
  type LocalDirectoryEntry,
  type LocalDiscoveryDriver,
} from '../../../domain/file-completion/discovery-policy.ts'
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

/** Run the Direct Host finder for one WORKSPACE query. Returns NULL on finder
 * FAILURE (the neutral policy then runs the bounded fallback), `[]` on a
 * genuine no-match or an abort. */
function runHostFinder(
  fdPath: string,
  baseDir: string,
  term: string,
  signal: AbortSignal,
): Promise<readonly PathCandidate[] | null> {
  const args = [
    '--base-directory', baseDir,
    '--max-results', String(MAX_FINDER_RESULTS),
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
        settle(null)
        return
      }
      const results: PathCandidate[] = []
      for (const record of normalizeFinderRecords(stdout)) {
        let isDirectory = record.directoryHint
        if (!isDirectory) {
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
 * The Direct WORKSPACE compatibility discovery driver: the Direct Host
 * process's OWN filesystem, with a Host PATH finder when present.
 *
 * `fdPath` is a test/API pin: `undefined` probes the Host PATH, `null` FORCES
 * the bounded fallback (no finder), a string pins one finder.
 */
export class DirectWorkspaceDiscoveryDriver implements LocalDiscoveryDriver {
  private readonly fdPathValue: string | null

  constructor(fdPath: string | null | undefined = undefined) {
    this.fdPathValue = fdPath === undefined ? resolveFdPath() : fdPath
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
    return runHostFinder(this.fdPathValue, baseDir, term, signal)
  }
}
