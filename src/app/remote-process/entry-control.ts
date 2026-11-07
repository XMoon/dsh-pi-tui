/**
 * Narrow stdin control channel for the M4-A0 qualification entries.
 *
 * The two process entries are internal qualification surfaces, not public
 * commands: a launcher starts one OS process per role and drives it with
 * newline-delimited JSON on stdin, while the process reports structured JSON
 * lines on stdout. This module owns only that protocol and the Linux process
 * start identity; it carries no application state.
 *
 * @module app/remote-process/entry-control
 */

import type { Diag } from '../../runtime/process/diagnostics.ts'
import { readProcessStarttime } from './local-scope.ts'

/** One structured record sink owned by the process entry. */
export type EntryRecordSink = (record: Record<string, unknown>) => void

/** The default JSONL sink: the qualification control channel on stdout. */
const stdoutRecordSink: EntryRecordSink = record => {
  process.stdout.write(`${JSON.stringify(record)}\n`)
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
 * Read newline-delimited JSON control requests from stdin. Malformed input is
 * reported as a structured `control-error` line and otherwise ignored: the
 * launcher is the only writer, and a typo must not crash a live Host.
 */
export function attachEntryControl(handler: EntryControlHandler): void {
  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  const dispatcher = createControlDispatcher(handler, { onStop: () => process.stdin.pause() })
  let buffer = ''
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      void dispatcher.dispatch(line) // allowlist: queue owns its terminal failure handling
    }
  })
}
