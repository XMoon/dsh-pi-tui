/**
 * Narrow stdin control channel for the M4-A0 qualification entries.
 *
 * The two process entries are internal qualification surfaces, not public
 * commands: a launcher starts one OS process per role and drives it with
 * newline-delimited JSON on stdin. With `DSH_PI_TUI_ENTRY_RECORDS=1` the
 * process reports that structured qualification protocol as JSON lines on
 * stdout; without it the default sink keeps only the concise Host production
 * log. This module owns only that protocol and the Linux process start
 * identity; it carries no application state.
 *
 * @module app/remote-process/entry-control
 */

import type { Diag } from '../../runtime/process/diagnostics.ts'
import { readProcessStarttime } from './local-scope.ts'

/** One structured record sink owned by the process entry. */
export type EntryRecordSink = (record: Record<string, unknown>) => void

/** The single opt-in for the raw M4-A0 JSONL stream, frozen at process start. */
const ENTRY_RECORDS_ENABLED = process.env.DSH_PI_TUI_ENTRY_RECORDS === '1'

/** The longest free-text fragment the default Host production log prints. */
const MAX_ENTRY_LOG_TEXT = 1024

/** One existing string field as a single bounded log line fragment. */
function logText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\r\n]+/gu, ' ')
  return text.length <= MAX_ENTRY_LOG_TEXT ? text : text.slice(0, MAX_ENTRY_LOG_TEXT)
}

/**
 * The default sink's Host production projection.
 *
 * A Host runs with its stdout/stderr redirected into the user-visible
 * `host.log`/journal/launchd stream, so the default sink writes a few readable
 * lifecycle lines instead of the qualification JSON. Only an actual Host
 * process owns production messages; every other record is qualification data
 * and stays silent unless the explicit JSONL opt-in is set.
 */
function hostProductionLine(record: Record<string, unknown>): { readonly stdout: boolean; readonly text: string } | undefined {
  if (record.processRole !== 'host') return undefined
  switch (record.m4a0) {
    case 'ready':
      return { stdout: true, text: `dsh-pi-tui host: ready (profile=${String(record.profile)}, pid=${String(record.pid)})` }
    case 'failure': {
      const phase = logText(record.phase)
      const code = logText(record.code)
      const context = [phase === undefined ? undefined : `[phase=${phase}]`, code === undefined ? undefined : `[code=${code}]`]
        .filter(part => part !== undefined)
        .join(' ')
      return {
        stdout: false,
        text: `dsh-pi-tui host: startup failed${context === '' ? '' : ` ${context}`}: ${logText(record.error) ?? ''}`,
      }
    }
    case 'cleanup-failure': {
      const step = logText(record.step)
      const context = step === undefined ? '' : ` [step=${step}]`
      return { stdout: false, text: `dsh-pi-tui host: cleanup failed${context}: ${logText(record.error) ?? ''}` }
    }
    case 'diagnostic': {
      const code = logText(record.code) ?? 'unknown'
      const failure = logText(record.failure) ?? 'unknown'
      const state = logText(record.state)
      const detail = state === undefined ? failure : `${failure}, state=${state}`
      return { stdout: false, text: `dsh-pi-tui host: warning ${code} (${detail})` }
    }
    case 'diag': {
      if (record.level !== 'warn' && record.level !== 'error') return undefined
      const message = logText(record.message) ?? 'unknown message'
      return { stdout: false, text: `dsh-pi-tui host: ${record.level}: ${message}` }
    }
    case 'web-autostart':
      return { stdout: true, text: 'dsh-pi-tui host: web autostart enabled' }
    case 'acp-autostart':
      return { stdout: true, text: 'dsh-pi-tui host: ACP autostart enabled' }
    case 'cleanup':
      return { stdout: true, text: 'dsh-pi-tui host: stopped' }
    default:
      return undefined
  }
}

/**
 * The default sink: the qualification JSONL control channel when explicitly
 * enabled, otherwise the minimal readable Host production log. An explicitly
 * provided sink always receives every record unchanged.
 */
const stdoutRecordSink: EntryRecordSink = record => {
  if (ENTRY_RECORDS_ENABLED) {
    process.stdout.write(`${JSON.stringify(record)}\n`)
    return
  }
  const line = hostProductionLine(record)
  if (line === undefined) return
  const stream = line.stdout ? process.stdout : process.stderr
  stream.write(`${line.text}\n`)
}

/** One structured line emitted by a process entry. */
export function writeEntryRecord(record: Record<string, unknown>, sink: EntryRecordSink = stdoutRecordSink): void {
  sink(record)
}

/**
 * The kernel start identity of a process: field 22 of `/proc/<pid>/stat`
 * (`starttime`, in clock ticks since boot). It distinguishes PID reuse from
 * the same live process. `undefined` when the platform does not expose it.
 */
export function readProcessStartIdentity(pid: number = process.pid): string | undefined {
  return readProcessStarttime(pid)
}

/** A role-labelled structured diagnostics sink for the entry's detached work.
 *  The surface entry supplies its private JSONL file sink; the qualification
 *  entries keep the default stdout control channel. */
export function createEntryDiag(processRole: 'host' | 'client', sink?: EntryRecordSink): Diag {
  const emit = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: Record<string, unknown>): void => {
      writeEntryRecord({ m4a0: 'diag', processRole, level, message, ...fields }, sink)
    }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'), dispose: () => {} }
}

/** A control request sent by the launcher. */
export interface EntryControlRequest {
  readonly op: string
  /** Optional qualification correlation id; status responses echo it. */
  readonly requestId?: string
  /** Qualification-only non-TUI answering Peer payload. */
  readonly kind?: string
  readonly callId?: string
  readonly eventId?: string
  readonly clientId?: string
  readonly sessionId?: string
  readonly value?: unknown
  /**
   * Qualification-only target of the `qualification-web-access` op: absent asks
   * for the official Web frontend status, otherwise the value is passed to the
   * Host's private `piTuiWebAccess.setEnabled` UNVALIDATED so the v2 Remote
   * contract is the only authority on it. Internal control channel only — never
   * a published CLI, Surface or HTTP surface.
   */
  readonly webAccessEnabled?: unknown
  /**
   * Qualification-only target of the `qualification-web-autostart` op: absent
   * asks for the profile's current Web startup preference, otherwise the value
   * is passed to the official generated `settings.mutate` as the next-launch
   * `autoStart`. Internal control channel only.
   */
  readonly webAutoStart?: unknown
  /**
   * Qualification-only fields of the `qualification-tui-preferences` op: absent
   * asks for the canonical `pi-tui-preferences` row, otherwise the string field
   * and value are written through the official generated `settings.mutate` with
   * `tuiPreferencesRevision` as the expected revision. Internal control channel
   * only — never a published CLI, Surface or HTTP surface.
   */
  readonly tuiPreferencesField?: unknown
  readonly tuiPreferencesValue?: unknown
  readonly tuiPreferencesRevision?: unknown
  /**
   * Qualification-only target of the `qualification-acp-access` op (PO-1B):
   * absent asks for the local ACP listener status, otherwise the value is passed
   * to the Host's private `piTuiAcpAccess.setEnabled` UNVALIDATED so the v2
   * Remote contract is the only authority on it. Internal control channel only.
   */
  readonly acpEnabled?: unknown
  /**
   * Qualification-only target of the `qualification-acp-autostart` op (PO-1B):
   * absent asks for the profile's current ACP startup preference, otherwise the
   * value is passed to the official generated `settings.mutate` as the
   * next-launch `autoStart`. Internal control channel only.
   */
  readonly acpAutoStart?: unknown
  /**
   * Qualification-only target of the `qualification-workspace-create` op: an
   * existing absolute directory the qualification Peer adopts as a Workspace
   * through the official generated `workspace.create` wire. Internal control
   * channel only.
   */
  readonly workspacePath?: unknown
}

/** Handles one control request; `true` means the process should stop reading. */
export type EntryControlHandler = (request: EntryControlRequest) => Promise<boolean> | boolean

/** One serialized control-request dispatcher. */
export interface ControlDispatcher {
  /** Queue one line; the returned promise settles after it (and its failure) is handled. */
  dispatch(line: string): Promise<void>
}

/**
 * Build the serialized control queue. A malformed request or a rejecting
 * handler is reported as a structured `control-failure` line and the queue
 * continues: the launcher owns the process, and one bad status query must not
 * strand later shutdown/status requests or crash the Host outside its official
 * disposer. The handler failure is never swallowed silently.
 */
export function createControlDispatcher(
  handler: EntryControlHandler,
  options: { readonly emit?: (record: Record<string, unknown>) => void; readonly onStop?: () => void } = {},
): ControlDispatcher {
  const emit = options.emit ?? writeEntryRecord
  let chain = Promise.resolve()
  return {
    dispatch(line: string): Promise<void> {
      chain = chain.then(async () => {
        let request: EntryControlRequest
        try {
          request = JSON.parse(line) as EntryControlRequest
        } catch (error) {
          emit({ m4a0: 'control-error', error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (typeof request !== 'object' || request === null || typeof request.op !== 'string') {
          emit({ m4a0: 'control-error', error: 'control request must be an object with a string op' })
          return
        }
        const stop = await handler(request)
        if (stop) options.onStop?.()
      }).catch((error: unknown) => {
        emit({
          m4a0: 'control-failure',
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        })
      })
      return chain
    },
  }
}

/**
 * The ONE stdin control channel an entry attached, with the release that ends
 * it. A process whose shutdown has completed releases the channel: the launcher
 * holds the other end of that pipe, so a resumed stdin would otherwise keep the
 * event loop alive and the process resident after its own shutdown finished.
 */
export interface EntryControlChannel {
  /**
   * Stop reading the control channel: drop the listener this attachment owns
   * and pause stdin. Idempotent, so the control `shutdown` op and the signal
   * shutdown owner can both release the SAME channel.
   */
  release(): void
}

/**
 * The narrow stdin surface the control channel owns and releases. Structural so
 * a contract test can drive the same attachment over a fake stream instead of
 * the test runner's own stdin.
 */
export interface EntryControlStdin {
  setEncoding(encoding: BufferEncoding): unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  off(event: 'data', listener: (chunk: string) => void): unknown
}

/**
 * Read newline-delimited JSON control requests from stdin. Malformed input is
 * reported as a structured `control-error` line and otherwise ignored: the
 * launcher is the only writer, and a typo must not crash a live Host.
 * @param handler - the entry's control handler.
 * @param stdin - the control stream (the process stdin by default).
 * @returns the channel, whose {@link EntryControlChannel.release} the shutdown
 *   owner calls once no further control request can be admitted.
 */
export function attachEntryControl(
  handler: EntryControlHandler,
  stdin: EntryControlStdin = process.stdin,
): EntryControlChannel {
  let released = false
  let buffer = ''
  const onData = (chunk: string): void => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      void dispatcher.dispatch(line) // allowlist: queue owns its terminal failure handling
    }
  }
  const release = (): void => {
    if (released) return
    released = true
    stdin.off('data', onData)
    stdin.pause()
  }
  stdin.setEncoding('utf8')
  stdin.resume()
  const dispatcher = createControlDispatcher(handler, { onStop: release })
  stdin.on('data', onData)
  return { release }
}
