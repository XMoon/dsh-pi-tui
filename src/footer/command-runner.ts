/**
 * The footer command runner (plan §17.6–§17.12): an ASYNC, cached,
 * coalesced executor for the user-configured status-line command. The
 * render path never waits for the command; a stale child can never
 * overwrite a newer snapshot; the output is capped, sanitized and
 * row-limited; failures fall back to the native layout with a one-shot
 * diagnostic (never a per-second notify).
 * @module @xmoon76/dsh-pi-tui/footer/command-runner
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { truncateToWidth } from '@xmoon76/pi-tui'
import { sanitizeCommandOutput } from './ansi-sanitize.ts'
import { buildCommandInput } from './command-protocol.ts'
import type { StatusSnapshot } from '../status/types.ts'

/** The validated command config (bounds per plan §17.3). */
export interface FooterCommandConfig {
  readonly command: string
  readonly timeoutMs: number
  readonly refreshIntervalMs: number
  readonly maxRows: number
}

/** The runner's options. */
export interface FooterCommandRunnerOptions {
  config: FooterCommandConfig
  /** The live snapshot getter (read at SPAWN time — the latest wins). */
  readonly snapshot: () => StatusSnapshot
  readonly width: () => number
  readonly height: () => number
  /** The output sink: the sanitized rows, or undefined = native fallback. */
  readonly onOutput: (rows: string[] | undefined) => void
  /** One-shot diagnostics (the first failure of an error generation). */
  readonly onNotifyOnce?: (message: string) => void
  readonly signal: AbortSignal
}

/** The stdout cap (plan §17.9). */
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024
/** The default hard timeout (plan §17.3). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300
/** The timeout ceiling. */
export const MAX_COMMAND_TIMEOUT_MS = 1000
/** The minimum refresh interval (plan §17.7). */
export const MIN_COMMAND_REFRESH_MS = 1000
/** The grace between SIGTERM and SIGKILL when terminating a command: a
 * TERM-resistant child (e.g. `trap "" TERM`) must not leak as a detached
 * orphan — the escalation is the hard kill that actually reclaims it. */
export const KILL_GRACE_MS = 500

/** A process's starttime (the /proc/&lt;pid&gt;/stat field 22 — a stable
 * process identity). The group-reuse guard reads it: when a group leader
 * dies its pid slot is freed IMMEDIATELY, so a pgid we captured can be
 * reallocated to an UNRELATED process before the escalation fires — a
 * different starttime under the same numeric pid proves the reuse, and
 * the group must then never be signalled. Undefined when /proc is
 * unavailable (non-Linux) or the entry is gone. */
function statStarttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The comm field (2) may contain spaces/parens — slice past the LAST
    // ')' before splitting; starttime is field 22, index 19 after comm.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim()
    return afterComm.split(' ')[19]
  } catch {
    return undefined
  }
}

/** The footer command runner. */
export class FooterCommandRunner {
  private readonly options: FooterCommandRunnerOptions
  private generation = 0
  private lastStartAt = 0
  private child: ChildProcess | undefined
  private readonly terminating = new Set<ChildProcess>()
  private timer: NodeJS.Timeout | undefined
  private errorGeneration = 0
  private disposed = false

  constructor(options: FooterCommandRunnerOptions) {
    this.options = options
    if (options.signal.aborted) {
      // The caller already cancelled: never spawn.
      this.disposed = true
      return
    }
    options.signal.addEventListener('abort', () => this.dispose(), { once: true })
  }

  /** Request a refresh: at most one start per refresh interval; requests
   * within the interval coalesce onto the NEXT start (which reads the
   * LATEST snapshot — the plan's "only the newest snapshot survives"). */
  requestRefresh(): void {
    if (this.disposed) return
    const now = Date.now()
    const elapsed = now - this.lastStartAt
    if (elapsed >= this.options.config.refreshIntervalMs) {
      // A pending coalesced timer from an EARLIER interval must not fire
      // later (a config switch to a shorter interval would otherwise
      // spawn an extra command): clear it before starting.
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      this.start()
      return
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.start()
    }, this.options.config.refreshIntervalMs - elapsed)
  }

  /** Replace the config (a settings change): the in-flight child is
   * invalidated and terminated immediately (its result must never commit
   * under the new config), the committed rows of the OLD configuration are
   * cleared at once (stale output must not linger while the new command
   * runs), then a refresh starts with the new config. */
  setConfig(config: FooterCommandConfig): void {
    this.generation += 1
    this.killChild()
    this.options.config = config
    this.errorGeneration = 0
    // The old config's rows describe a surface the user no longer has
    // configured: clear them synchronously (the next result repaints).
    // Direct sink call — no failure accounting (a config change is not
    // a failure).
    this.options.onOutput(undefined)
    this.requestRefresh()
  }

  /** Start one run: spawn, feed the JSON stdin, cap the stdout, enforce
   * the hard timeout, and commit only the CURRENT generation's result. */
  private start(): void {
    if (this.disposed) return
    this.lastStartAt = Date.now()
    const generation = ++this.generation
    // An in-flight child is superseded: terminate it (the new snapshot
    // wins; a stale child must never commit).
    this.killChild()
    const config = this.options.config
    const child = spawn(config.command, { shell: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    // The child's STDERR is never surfaced: DRAIN it (a user command that
    // writes enough stderr to fill the pipe buffer would BLOCK and get
    // misjudged as a timeout otherwise).
    child.stderr?.on('data', () => {})
    let output = ''
    let outputBytes = 0
    // The decoder buffers a PARTIAL multibyte sequence across chunks, so a
    // byte-budget slice never emits U+FFFD replacement characters.
    const decoder = new StringDecoder('utf8')
    let settled = false
    const finish = (rows: string[] | undefined): void => {
      if (settled || this.disposed || generation !== this.generation) return
      settled = true
      if (this.child === child) this.child = undefined
      this.onResult(rows)
    }
    const timeout = setTimeout(() => {
      // The timeout is generation- AND child-scoped: if a NEW child has
      // already replaced this one (a config change / refresh started
      // while this child's close event was delayed), the stale timeout
      // must NOT kill the current process. `finish` below already
      // guards the generation; this guards the kill.
      if (this.child === child) this.killChild()
      finish(undefined)
    }, Math.min(config.timeoutMs, MAX_COMMAND_TIMEOUT_MS))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outputBytes >= MAX_COMMAND_OUTPUT_BYTES) return
      // The cap is a UTF-8 BYTE cap (the plan's 16 KiB): the CONSUMED
      // INPUT bytes are the budget — the decoder may complete a buffered
      // multibyte tail (a few bytes over the raw budget, never a U+FFFD),
      // but no further input is fed once the budget is exhausted.
      const room = MAX_COMMAND_OUTPUT_BYTES - outputBytes
      const slice = chunk.subarray(0, room)
      output += decoder.write(slice)
      outputBytes += slice.length
    })
    child.on('error', () => {
      clearTimeout(timeout)
      finish(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        finish(undefined)
        return
      }
      // A trailing INCOMPLETE multibyte sequence is DROPPED (the decoder
      // keeps it buffered without end()); end() would emit a U+FFFD
      // replacement, which the status surface must never show — the raw
      // output string below holds only fully-decoded characters.
      const sanitized = sanitizeCommandOutput(output)
      const lines = sanitized.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')
      if (lines.length === 0) {
        finish(undefined)
        return
      }
      // Each row is width-truncated ANSI-safely (the status surface is
      // single-line per row — a long row must never wrap or overflow).
      const width = Math.max(1, this.options.width())
      finish(lines.slice(0, Math.max(1, config.maxRows)).map(line => truncateToWidth(line, width, '…')))
    })
    const input = JSON.stringify(buildCommandInput(
      this.options.snapshot(),
      this.options.width(),
      this.options.height(),
    ))
    try {
      child.stdin?.write(input)
      child.stdin?.end()
    } catch {
      // A closed stdin (the child exited instantly) is not a failure of
      // the runner — the close handler settles the result.
    }
  }

  /** The result sink: recovery clears the error generation; the FIRST
   * failure of a generation notifies once (plan §17.11). */
  private onResult(rows: string[] | undefined): void {
    if (rows !== undefined) {
      this.errorGeneration = 0
    } else {
      this.errorGeneration += 1
      if (this.errorGeneration === 1) {
        this.options.onNotifyOnce?.('footer command failed — using the native layout')
      }
    }
    this.options.onOutput(rows)
  }

  /** Best-effort process-tree termination (the child is a group leader).
   * SIGTERM first, then — when a TERM-resistant member ignores it — a
   * hard SIGKILL after a bounded grace. The escalation is GROUP-scoped:
   * the LEADER may exit on TERM while a TERM-resistant DESCENDANT keeps
   * the process group alive (the review's P1 scenario: `cmd & wait` with
   * the background job trapping TERM and its stdio redirected — the
   * leader's close fires and would cancel a leader-bound timer), so the
   * grace timer is NOT cancelled by the leader's close: it probes the
   * WHOLE group (kill(-pgid, 0)) and SIGKILLs it while any member
   * survives. The timer holds the CAPTURED pgid — a newer child is a
   * different group and can never be signalled by mistake. */
  private killChild(): void {
    const child = this.child
    if (child === undefined || this.terminating.has(child)) return
    this.terminating.add(child)
    const pgid = child.pid
    // The leader's starttime, captured WHILE it is alive: the escalation
    // later proves the numeric pgid still identifies OUR group (a reused
    // pid carries a different starttime).
    const leaderStarttime = pgid === undefined ? undefined : statStarttime(pgid)
    /** Whether ANY member of the captured process group still exists. */
    const groupAlive = (): boolean => {
      if (pgid === undefined) return false
      try {
        process.kill(-pgid, 0)
        return true
      } catch {
        return false
      }
    }
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, signal)
        } catch {
          // Already gone.
        }
      }
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
    }
    signalGroup('SIGTERM')
    const escalation = setTimeout(() => {
      if (pgid === undefined) return
      // The GROUP probe, never a leader check: the leader may already
      // have closed while a TERM-resistant descendant still runs.
      if (!groupAlive()) return
      // Pgid-reuse guard (the review's P1): once the leader is dead its
      // pid slot is free, and a fast pid allocator can hand the SAME
      // numeric pgid to an unrelated process before the grace fires —
      // that group must never receive OUR SIGKILL. The group is provably
      // ours while the leader is alive, or when the pid slot is
      // unallocated (a group whose leader pid is free can only hold the
      // leader's own descendants — no unrelated process can join it), or
      // when the current occupant is still the SAME process (a not-yet-
      // reaped leader zombie). A reallocated pid with a different
      // starttime skips the kill (a descendant may leak — the safe
      // failure).
      if (leaderStarttime !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
        const current = statStarttime(pgid)
        if (current !== undefined && current !== leaderStarttime) return
      }
      signalGroup('SIGKILL')
    }, KILL_GRACE_MS)
    child.once('close', () => {
      // Drop the child from the termination ledger — the set must not
      // retain every terminated ChildProcess (streams + listeners) for
      // the runner's lifetime.
      this.terminating.delete(child)
      // Cancel the escalation ONLY when the WHOLE GROUP is already gone
      // (an empty group id cannot gain new members, so ESRCH here is
      // final). A live descendant must keep the timer armed — the review
      // scenario the leader-based clear missed.
      if (!groupAlive()) clearTimeout(escalation)
    })
  }

  /** Dispose: terminate the child, drop the coalescing timer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.killChild()
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}
