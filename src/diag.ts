/**
 * Structured process diagnostics for the TUI.
 *
 * The TUI cannot rely on `ctx.logger` for human-visible troubleshooting:
 * no dsh server-side package registers a logger exporter, so those lines
 * only fill cordis's in-memory buffer. This module owns a dedicated
 * diagnostics channel instead — one line per event, written to stderr
 * (warn/error by default, matching the legacy `[tui]` fd-2 lines) and to a
 * log file (info by default) under `$DSH_HOME/logs/`.
 *
 * Configuration (env):
 * - `DSH_PI_TUI_LOG` — log file path, or `off` to disable the file sink.
 * - `DSH_PI_TUI_LOG_LEVEL` — one of debug/info/warn/error (default `info`).
 *
 * Writes are best-effort and never throw; a failed file sink is disabled
 * silently so diagnostics can never take the TUI down.
 * @module @xmoon76/dsh-pi-tui/diag
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeErrorMessage } from './error-boundary.ts'

/** Diagnostic severity, ascending. */
export type DiagLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<DiagLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** One line sink. Implementations must never throw. */
export interface DiagSink {
  write(line: string): void
}

export interface DiagOptions {
  /** Threshold for the file sink; lines below it are dropped. Default `info`. */
  fileLevel?: DiagLevel
  /** Threshold for the stderr sink; `off` disables it. Default `warn`. */
  stderrLevel?: DiagLevel | 'off'
  /** Log file path; absent disables the file sink. */
  filePath?: string
  /** Extra sinks (tests). */
  sinks?: DiagSink[]
  /** Injectable clock. */
  now?: () => Date
}

export interface Diag {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  /** Release the file handle, if one is open. */
  dispose(): void
}

/** `2026-08-15T10:00:00.000+08:00` — local wall time with the zone offset. */
export function formatDiagTime(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${offset}`
}

/** Render a single field value for the `k=v` line format. */
function formatField(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // The JSON path failed (e.g. a circular object); the fallback must
    // never throw either (a hostile toString/toPrimitive yields a fixed
    // placeholder) — "writes are best-effort and never throw" holds.
    return safeErrorMessage(value)
  }
}

/** The dsh home directory (`$DSH_HOME`, defaulting to `~/.dsh`). */
export function dshHome(env: NodeJS.ProcessEnv): string {
  const explicit = env.DSH_HOME
  if (explicit !== undefined && explicit !== '') return explicit
  return join(homedir(), '.dsh')
}

/** Build the default diagnostics log path: `$DSH_HOME/logs/pi-tui-<pid>.log`. */
export function defaultDiagLogPath(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.DSH_PI_TUI_LOG
  if (configured === 'off' || configured === '') return undefined
  if (configured !== undefined) return configured
  return join(dshHome(env), 'logs', `pi-tui-${process.pid}.log`)
}

/** Resolve the effective file level from `DSH_PI_TUI_LOG_LEVEL`. */
export function diagLevelFromEnv(env: NodeJS.ProcessEnv): DiagLevel {
  const configured = env.DSH_PI_TUI_LOG_LEVEL
  if (configured === 'debug' || configured === 'info' || configured === 'warn' || configured === 'error') return configured
  return 'info'
}

/** Create the diagnostics channel from the process environment. */
export function diagFromEnv(env: NodeJS.ProcessEnv): Diag {
  return createDiag({
    fileLevel: diagLevelFromEnv(env),
    filePath: defaultDiagLogPath(env),
  })
}

/** Create one diagnostics channel. Writes are best-effort, never throw. */
export function createDiag(options: DiagOptions = {}): Diag {
  const fileLevel = options.fileLevel ?? 'info'
  const stderrLevel = options.stderrLevel ?? 'warn'
  const now = options.now ?? (() => new Date())
  const sinks: DiagSink[] = [...(options.sinks ?? [])]

  let fileHandle: number | undefined
  let fileDisabled = false
  if (options.filePath !== undefined) {
    try {
      const dir = options.filePath.slice(0, Math.max(options.filePath.lastIndexOf('/'), 0))
      if (dir !== '') mkdirSync(dir, { recursive: true })
      fileHandle = openSync(options.filePath, 'a')
    } catch {
      fileDisabled = true
    }
  }

  const emit = (level: DiagLevel, message: string, fields: Record<string, unknown> | undefined): void => {
    const stamp = formatDiagTime(now())
    const suffix = fields === undefined ? '' : ` ${Object.entries(fields).map(([key, value]) => `${key}=${formatField(value)}`).join(' ')}`
    const line = `[tui] ${stamp} ${level.toUpperCase()} ${message}${suffix}\n`
    for (const sink of sinks) {
      try {
        sink.write(line)
      } catch {
        // A failing custom sink must not take the TUI down.
      }
    }
    if (stderrLevel !== 'off' && LEVEL_RANK[level] >= LEVEL_RANK[stderrLevel]) {
      try {
        // Raw fd write: cordis wraps process.stderr and drops writeSync.
        writeSync(2, line)
      } catch {
        // Best-effort: a closed descriptor is not a failure.
      }
    }
    if (fileHandle !== undefined && !fileDisabled && LEVEL_RANK[level] >= LEVEL_RANK[fileLevel]) {
      try {
        writeSync(fileHandle, line)
      } catch {
        fileDisabled = true
        try {
          // Keep a best-effort stderr record of the sink loss.
          writeSync(2, `[tui] ${formatDiagTime(now())} WARN diag file sink disabled\n`)
        } catch {
          // Nothing left to do.
        }
      }
    }
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    dispose: () => {
      if (fileHandle !== undefined) {
        try {
          closeSync(fileHandle)
        } catch {
          // Ignore.
        }
        fileHandle = undefined
      }
    },
  }
}
