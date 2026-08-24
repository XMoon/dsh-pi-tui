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

/** The footer command runner. */
export class FooterCommandRunner {
  private readonly options: FooterCommandRunnerOptions
  private generation = 0
  private lastStartAt = 0
  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined
  private errorGeneration = 0
  private disposed = false

  constructor(options: FooterCommandRunnerOptions) {
    this.options = options
    options.signal.addEventListener('abort', () => this.dispose())
  }

  /** Request a refresh: at most one start per refresh interval; requests
   * within the interval coalesce onto the NEXT start (which reads the
   * LATEST snapshot — the plan's "only the newest snapshot survives"). */
  requestRefresh(): void {
    if (this.disposed) return
    const now = Date.now()
    const elapsed = now - this.lastStartAt
    if (elapsed >= this.options.config.refreshIntervalMs) {
      this.start()
      return
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.start()
    }, this.options.config.refreshIntervalMs - elapsed)
  }

  /** Replace the config (a settings change) and refresh. */
  setConfig(config: FooterCommandConfig): void {
    this.options.config = config
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
    let output = ''
    let settled = false
    const finish = (rows: string[] | undefined): void => {
      if (settled || this.disposed || generation !== this.generation) return
      settled = true
      if (this.child === child) this.child = undefined
      this.onResult(rows)
    }
    const timeout = setTimeout(() => {
      this.killChild()
      finish(undefined)
    }, Math.min(config.timeoutMs, MAX_COMMAND_TIMEOUT_MS))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < MAX_COMMAND_OUTPUT_BYTES) {
        output += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT_BYTES - output.length)
      }
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
      const sanitized = sanitizeCommandOutput(output)
      const lines = sanitized.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')
      if (lines.length === 0) {
        finish(undefined)
        return
      }
      finish(lines.slice(0, Math.max(1, config.maxRows)))
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

  /** Best-effort process-tree termination (the child is a group leader). */
  private killChild(): void {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }

  /** Dispose: terminate the child, drop the coalescing timer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.killChild()
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}
