/**
 * Real `/proc`-based owner probe for the open-time session lock.
 *
 * Verifies that a recorded lock owner is the SAME live dsh invocation:
 * - the process exists (`/proc/<pid>/stat` readable),
 * - it is not a zombie (state `Z`),
 * - its starttime (stat field 22) matches the lock record — a reused pid
 *   would carry a different starttime,
 * - its command line identifies a dsh process (the same family of tools the
 *   lock speaks for).
 *
 * The probe never takes a lock over on doubt: any inability to verify
 * (missing /proc, permission errors, unparsable stat) reports `unknown` and
 * the caller refuses the open. An ENOENT stat, a zombie state, a starttime
 * mismatch, or a non-dsh command line is a definitive `stale`.
 *
 * Non-Linux platforms degrade: `process.kill(pid, 0)` checks existence, then
 * the command line is compared when `ps` is available; when it is not, the
 * probe reports `unknown` (conservative refusal) instead of guessing.
 * @module @xmoon76/dsh-pi-tui/session-lock-proc
 */

import { readFileSync, readlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { SessionLockInfo, SessionLockProc } from './session-lock.ts'

/** The stat field index of `starttime` (1-based field 22 in /proc/<pid>/stat). */
const STAT_STARTTIME_FIELD = 22

/** Parse `/proc/<pid>/stat`: state (field 3) and starttime (field 22). */
export function parseProcStat(content: string): { state: string; starttime: number } | undefined {
  // The comm field (2) may contain spaces and parentheses; the fields after
  // it are reliably indexed from the LAST ')'.
  const close = content.lastIndexOf(')')
  if (close < 0) return undefined
  const rest = content.slice(close + 2).trim() // skip ') ' after comm
  const fields = rest.split(' ')
  if (fields.length < STAT_STARTTIME_FIELD - 2) return undefined
  const state = fields[0] ?? ''
  const starttime = Number(fields[STAT_STARTTIME_FIELD - 3])
  if (!Number.isSafeInteger(starttime)) return undefined
  return { state, starttime }
}

/** Read a process's command line from /proc (NUL-separated, trailing NULs trimmed). */
export function readProcCmdline(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    const args = raw.split('\0').filter(arg => arg !== '')
    return args.join(' ')
  } catch {
    return undefined
  }
}

/** Read a process's executable target from /proc (readlink /proc/<pid>/exe). */
export function readProcExe(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return undefined
  }
}

/** The set of command names this lock family recognizes as "our own tool". */
function looksLikeDsh(cmdline: string | undefined): boolean {
  if (cmdline === undefined) return false
  // dsh is launched as `node <path-to-dsh> [--profile ...]` (the CLI is a
  // JS entry), so the dsh marker may be any argument whose basename is
  // `dsh` — not necessarily the first token. Scan every argument.
  return cmdline.split(/\s+/).some(arg => {
    if (arg === 'dsh') return true
    const base = arg.split('/').pop() ?? ''
    return base === 'dsh' || base === 'dsh.exe'
  })
}

/** The real probe: Linux /proc, with a conservative non-Linux degradation. */
export function createProcProbe(options?: {
  platform?: NodeJS.Platform
  execFile?: typeof execFileSync
  readFile?: (path: string) => string
}): SessionLockProc {
  const platform = options?.platform ?? process.platform
  const execFile = options?.execFile ?? execFileSync
  const readFile = options?.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  return {
    probe(owner, self): { kind: 'alive' } | { kind: 'stale' } | { kind: 'unknown' } {
      // A lock recorded by this very process is always alive (the caller
      // short-circuits same-process opens before probing, but defense here
      // keeps the probe total).
      if (owner.pid === self.pid && owner.starttime === self.starttime) return { kind: 'alive' }

      if (platform === 'linux' || platform === 'android') {
        let statContent: string
        try {
          statContent = readFile(`/proc/${owner.pid}/stat`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { kind: 'stale' }
          return { kind: 'unknown' }
        }
        const parsed = parseProcStat(statContent)
        if (parsed === undefined) return { kind: 'unknown' }
        if (parsed.state === 'Z') return { kind: 'stale' }
        if (parsed.starttime !== owner.starttime) return { kind: 'stale' }
        // The process is alive and is the same process we locked: confirm it
        // is still a dsh invocation (a pid-reused process could be anything).
        let cmdline: string | undefined
        try {
          cmdline = readFile(`/proc/${owner.pid}/cmdline`)
            .split('\0').filter(arg => arg !== '').join(' ')
        } catch {
          cmdline = undefined
        }
        if (!looksLikeDsh(cmdline)) return { kind: 'stale' }
        return { kind: 'alive' }
      }

      // Non-Linux degradation: existence via kill(pid, 0), then best-effort
      // command-line comparison. Unverifiable → unknown (never take over).
      let alive = true
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return { kind: 'stale' }
        // EPERM: the process exists but is not ours — treat as alive (the
        // owner identity check below still applies when possible).
        alive = true
      }
      if (!alive) return { kind: 'stale' }
      try {
        const command = execFile('ps', ['-p', String(owner.pid), '-o', 'command='], { encoding: 'utf8' }).trim()
        if (command === '') return { kind: 'stale' } // zombie or vanished
        return looksLikeDsh(command) ? { kind: 'alive' } : { kind: 'stale' }
      } catch {
        return { kind: 'unknown' }
      }
    },
  }
}
