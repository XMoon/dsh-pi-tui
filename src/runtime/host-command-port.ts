/**
 * The Host command execution domain port (D2.1): a narrow semantic seam for
 * the runner's already-authorized Host command invocation. Claim precedence
 * and TUI/client command routing remain in the runner; this port only
 * executes the selected Host line and returns the settled command result.
 *
 * Attachments stay opaque at this boundary. The Direct adapter passes the
 * existing command attachment values through unchanged; no new attachment
 * DTO or parser belongs here.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/host-command-port
 */

import type { WriteError } from './write-outcome.ts'

/** The semantic request for one already-routed Host command. */
export interface HostCommandRequest {
  readonly sessionId: string
  readonly line: string
  readonly attachments: readonly unknown[]
  /** Caller-owned lifecycle cancellation; the adapter must forward this exact signal. */
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
  execute(request: HostCommandRequest): Promise<HostCommandOutcome>
}
