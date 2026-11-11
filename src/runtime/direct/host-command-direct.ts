/**
 * The Direct Host command adapter (D2.1): resolve the live Agent by session
 * id at call time and invoke the official `commands.execute` service. Claim
 * classification, line precedence, TUI-local commands and skill wrappers stay
 * in the runner; this adapter passes the selected line and prepared wire
 * through unchanged.
 *
 * `stageFileReceipt` is Direct's ONE official receipt seam: it resolves the
 * Host `fileUploads` service (registered by the official file-upload row, whose
 * receipt resolver `commands.execute` consumes) and streams the Client file
 * snapshot into that Session's staged receipt. It never falls back to the
 * plain prompt attachment store: a durable attachment reference is not a
 * command receipt.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-command-direct
 */

import { safeErrorMessage } from '../process/errors.ts'
import type {
  HostCommandExecution,
  HostCommandFileStageRequest,
  HostCommandOutcome,
  HostCommandPort,
  HostCommandRequest,
} from '../host-command-port.ts'
import type { WriteError } from '../write-outcome.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the service resolves from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The live Agent scope required by the Direct command service. */
export interface LiveAgentLike {
  readonly session: { readonly id: string }
}

/** The official Direct command service shape needed by this adapter. */
export interface CommandsServiceLike {
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<HostCommandExecution | undefined>
}

/** The official Host file-upload service shape needed by this adapter. */
export interface FileUploadsServiceLike {
  uploadStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<{ readonly receiptId: string }>
}

function rejected(code: string, message: string): { kind: 'rejected'; error: WriteError } {
  return { kind: 'rejected', error: { code, message } }
}

function indeterminate(error: unknown): Extract<HostCommandOutcome, { readonly kind: 'indeterminate' }> {
  return {
    kind: 'indeterminate',
    error: {
      code: 'session/write-indeterminate',
      message: safeErrorMessage(error),
    },
  }
}

/** The Direct backend's Host command port. */
export class DirectHostCommandPort implements HostCommandPort {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async stageFileReceipt(request: HostCommandFileStageRequest): Promise<{ readonly receiptId: string }> {
    request.signal.throwIfAborted()
    if (request.file.source.kind !== 'client-stream') {
      throw new Error(`stored file "${request.file.name}" cannot be re-uploaded by this Client`)
    }
    const uploads = this.ctx.get('fileUploads') as FileUploadsServiceLike | undefined
    if (uploads === undefined) throw new Error('fileUploads service unavailable')
    // The receiving Session must be the exact live Agent this adapter would
    // dispatch the command to; a disposed/replaced Agent fails closed before
    // any bytes are stored.
    if (this.agentFor(request.sessionId) === undefined) {
      throw new Error(`session "${request.sessionId}" is not available`)
    }
    const uploaded = await uploads.uploadStream({
      sessionId: request.sessionId,
      data: request.file.source.open(request.signal),
      signal: request.signal,
      name: request.file.name,
    })
    request.signal.throwIfAborted()
    if (typeof uploaded.receiptId !== 'string' || uploaded.receiptId === '') {
      throw new Error('file upload returned no receipt')
    }
    return { receiptId: uploaded.receiptId }
  }

  async execute(request: HostCommandRequest): Promise<HostCommandOutcome> {
    const commands = this.ctx.get('commands') as CommandsServiceLike | undefined
    if (commands === undefined) return rejected('service/unavailable', 'commands service unavailable')
    const agent = this.agentFor(request.sessionId)
    if (agent === undefined) return rejected('session/not-found', `session "${request.sessionId}" is not available`)
    // The caller-owned lifecycle signal is forwarded unchanged; do not mint a
    // replacement that could outlive the TUI surface.
    if (request.signal.aborted) return { kind: 'cancelled' }
    // Once the Host command is dispatched, a cancellation-shaped throw is NOT
    // proof that nothing happened: the pinned executor appends `command/run`
    // before the handler and `command/done` after it, so an aborted handler may
    // already have run (and side-effected). Such a failure is therefore
    // indeterminate, never a known `cancelled`.
    try {
      const execution = await commands.execute(agent, request.line, request.attachments, request.signal)
      if (execution === undefined) return { kind: 'committed', matched: false }
      return { kind: 'committed', matched: true, execution }
    } catch (error) {
      return indeterminate(error)
    }
  }
}
