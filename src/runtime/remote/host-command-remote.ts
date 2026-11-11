/**
 * Experimental Remote implementation of the semantic HostCommandPort (D2.2).
 *
 * The official generated `commands.execute(agentId, line, attachments, signal)`
 * Remote is the attachment-preserving Host execution path; the convenience
 * `SessionFace.command(line)` is deliberately NOT used because it executes with
 * an empty attachment list. Claim classification, line precedence, and TUI-local
 * command routing stay in the runner — this adapter only forwards the already
 * selected line, its declared attachment payload, and the caller-owned signal.
 *
 * `stageFileReceipt` reuses the SAME F4 receipt uploader the production
 * prompt serializer uses (one composition-owned instance), so a command file
 * goes through the official authenticated raw-upload route and the Host mints
 * its Session-scoped receipt. The uploader is REQUIRED: a composition that
 * cannot stage a receipt must fail loudly rather than silently drop a file.
 *
 * The prepared attachment wire stays opaque at `execute`: the application has
 * already encoded images and staged the file receipts, and the adapter must
 * never strip or rewrite the payload.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/host-command-remote
 */

import type {
  HostCommandExecution,
  HostCommandFileStageRequest,
  HostCommandOutcome,
  HostCommandPort,
  HostCommandRequest,
} from '../host-command-port.ts'
import type { RemoteFileReceiptUploader } from './file-upload-remote.ts'
import { classifyRemoteWriteFailure, remoteFailureCode, remoteFailureMessage } from './write-failure.ts'

/** Structural official `RemoteResult`. */
export type RemoteCommandResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

/** The official generated commands Remote face consumed here. */
export interface RemoteCommandsSource {
  execute(
    agentId: string,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<RemoteCommandResult>
}

/**
 * Maps the official generated command execution onto the existing
 * `HostCommandOutcome`. `matched:false` is exactly the official `undefined`
 * result; a settled execution with an error result is still committed.
 */
export class RemoteHostCommandPort implements HostCommandPort {
  private readonly commands: RemoteCommandsSource
  private readonly uploader: RemoteFileReceiptUploader

  constructor(commands: RemoteCommandsSource, uploader: RemoteFileReceiptUploader) {
    this.commands = commands
    this.uploader = uploader
  }

  async stageFileReceipt(request: HostCommandFileStageRequest): Promise<{ readonly receiptId: string }> {
    // The uploader owns source preflight (fingerprint before the Host sees a
    // request), bounded streaming and FD release; a failure here proves no
    // command was dispatched.
    const uploaded = await this.uploader.upload(request.sessionId, request.file, request.signal)
    return { receiptId: uploaded.receiptId }
  }

  async execute(request: HostCommandRequest): Promise<HostCommandOutcome> {
    // A signal already aborted BEFORE dispatch proves the command never ran.
    if (request.signal.aborted) return { kind: 'cancelled' }
    // The generated Remote resolves to `RemoteResult`; carrier failures are in
    // the error branch, so a rejection is an assembly/programming defect and
    // propagates rather than becoming an ambiguous command result.
    const result = await this.commands.execute(request.sessionId, request.line, request.attachments, request.signal)
    if (result.ok) {
      if (result.value === undefined) return { kind: 'committed', matched: false }
      // The official Remote yields the whole `CommandExecution`
      // (`{ commandId, result }`); the port's structural `HostCommandExecution`
      // is that same object. Pass it through unchanged — wrapping it would lose
      // the lifecycle pairing id the runner needs.
      return { kind: 'committed', matched: true, execution: result.value as HostCommandExecution }
    }
    // Once dispatched, a cancellation-shaped failure is NOT proof that nothing
    // happened: the pinned executor appends `command/run` before the handler, so
    // an aborted handler may already have run (and side-effected). Such a
    // failure is indeterminate, never a known `cancelled`.
    const code = remoteFailureCode(result.error)
    if (code === 'gateway/cancelled') {
      return {
        kind: 'indeterminate',
        error: { code, message: remoteFailureMessage(result.error) },
      }
    }
    const failure = classifyRemoteWriteFailure(result.error)
    if (failure.kind === 'rejected') return { kind: 'rejected', error: failure.error }
    return {
      kind: 'indeterminate',
      error: {
        code: code ?? 'session/write-indeterminate',
        message: remoteFailureMessage(result.error),
      },
    }
  }
}
