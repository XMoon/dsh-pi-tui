/**
 * The subagent domain port (D2.1 extension) — the semantic contract
 * between the TUI and subagent control. Direct implements it over the dsh
 * official service today; a Remote adapter is a later milestone.
 *
 * The port owns human prompt delivery and continuable-child interruption.
 * Parent/child authority is explicit for both operations; no UI row or root
 * inference crosses this boundary.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/subagent-port
 */

import type {
  SubagentPromptOutcome,
  SubagentViewerSubmitRequest,
} from '../subagent-viewer-submit.ts'

/** The caller-owned per-call context for a prompt delivery (cancellation,
 * text canonicalization). The runner provides these; the port never reaches
 * into the session itself. */
export interface SubagentPromptContext {
  /** A fresh per-call cancellation source (the caller owns aborting it). */
  makeSignal(): AbortSignal
  /** Canonicalize the final user text BEFORE delivery (the main session's
   * `@`-file mention expansion). MAY be async (migration M1.10 — the
   * Host-file port); the default passes text through. */
  canonicalizeText?(text: string): string | Promise<string>
}

/** The explicit semantic target for stopping a continuable child. */
export interface SubagentInterruptRequest {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'continuable'
}

/** Expected interruption refusal categories. Unknown Direct exceptions still
 * throw through the existing owned-task failure sink. */
export type SubagentInterruptReject =
  | { readonly kind: 'unavailable'; readonly message?: string }
  | { readonly kind: 'unauthorized'; readonly message?: string }
  | { readonly kind: 'error'; readonly message: string }

/** Settlement of the semantic interruption request. */
export type SubagentInterruptOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'rejected'; readonly reason: SubagentInterruptReject }

/** The subagent domain port. */
export interface SubagentPort {
  /** Deliver one viewer HUMAN PROMPT to a continuable child through the
   * official subagent control API, or classify why it could not be
   * delivered. */
  prompt(
    request: SubagentViewerSubmitRequest,
    context: SubagentPromptContext,
  ): Promise<SubagentPromptOutcome>

  /** Interrupt one explicit continuable child on behalf of its direct parent.
   * A completed/idle child remains an official service no-op. */
  interrupt(request: SubagentInterruptRequest): Promise<SubagentInterruptOutcome>
}
