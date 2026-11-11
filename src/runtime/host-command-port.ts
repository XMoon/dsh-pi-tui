/**
 * The Host command execution domain port (D2.1): a narrow semantic seam for
 * the runner's already-authorized Host command invocation. Claim precedence
 * and TUI/client command routing remain in the runner; this port only
 * executes the selected Host line and returns the settled command result.
 *
 * The submitted command wire stays opaque at `execute`: the application has
 * already encoded images and staged file receipts. `stageFileReceipt` is the
 * ONE official receipt seam for a Client generic file — the Host mints the
 * Session-scoped receipt, so no Client-side receipt registry or private upload
 * transport belongs here.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/host-command-port
 */

import type { WriteError } from './write-outcome.ts'
import type { PreparedFile } from './prepared-prompt.ts'

/** The semantic request for one already-routed Host command. */
export interface HostCommandRequest {
  readonly sessionId: string
  readonly line: string
  readonly attachments: readonly unknown[]
  /** Caller-owned lifecycle cancellation; the adapter must forward this exact signal. */
  readonly signal: AbortSignal
}

/** One submit-time Client file to stage as an official command receipt. */
export interface HostCommandFileStageRequest {
  /** The ACTUAL Session the command will execute in (never a guessed id). */
  readonly sessionId: string
  /** The gesture's immutable Client file source snapshot. */
  readonly file: PreparedFile
  readonly signal: AbortSignal
}

/** The detached command result needed by the existing TUI result sink. It is
 * intentionally structural so the port does not publish a Host package type. */
export interface HostCommandExecution {
  readonly result: unknown
}

/** Settlement of one Host command invocation. `matched` is false only when the
 * official executor returned undefined; an execution with an error result is
 * still committed because the official command lifecycle settled. */
export type HostCommandOutcome =
  | { readonly kind: 'committed'; readonly matched: false }
  | { readonly kind: 'committed'; readonly matched: true; readonly execution: HostCommandExecution }
  | { readonly kind: 'rejected'; readonly error: WriteError }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'indeterminate'; readonly error: WriteError }

/** The Host command execution domain port. */
export interface HostCommandPort {
  /**
   * Stage ONE Client file as an official Session-scoped receipt. The Host
   * stores the bytes and mints the opaque `receiptId` the command wire cites;
   * the adapter never returns a durable attachment reference as a receipt.
   * A failure here PROVES no command was dispatched.
   */
  stageFileReceipt(request: HostCommandFileStageRequest): Promise<{ readonly receiptId: string }>
  execute(request: HostCommandRequest): Promise<HostCommandOutcome>
}
