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
 * Attachment values remain opaque here (the same structural payload the Direct
 * adapter forwards): the caller's attachment-preparation pipeline already
 * refused an unsupported D4-only local file before this port was invoked, so
 * the adapter must never strip or rewrite the payload.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/host-command-remote
 */

import type {
  HostCommandExecution,
  HostCommandOutcome,
  HostCommandPort,
  HostCommandRequest,
} from '../host-command-port.ts'
import { classifyRemoteWriteFailure } from './write-failure.ts'

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
    signal?: AbortSignal,
  ): Promise<RemoteCommandResult>
}

/**
 * Maps the official generated command execution onto the existing
 * `HostCommandOutcome`. `matched:false` is exactly the official `undefined`
 * result; a settled execution with an error result is still committed.
 */
export class RemoteHostCommandPort implements HostCommandPort {
  private readonly commands: RemoteCommandsSource

  constructor(commands: RemoteCommandsSource) {
    this.commands = commands
  }

  async execute(request: HostCommandRequest): Promise<HostCommandOutcome> {
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
    const failure = classifyRemoteWriteFailure(result.error)
    if (failure.kind === 'cancelled') return { kind: 'cancelled' }
    if (failure.kind === 'rejected') return { kind: 'rejected', error: failure.error }
    return { kind: 'indeterminate', error: failure.error }
  }
}
