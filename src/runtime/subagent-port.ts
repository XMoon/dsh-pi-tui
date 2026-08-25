/**
 * The subagent domain port (M1.2) — the semantic contract between the TUI
 * and the subagent domain, implemented by `src/runtime/direct/` (Direct)
 * today and by a Remote adapter in a later milestone. The port is narrow:
 * it owns the follow-up delivery path (the interactive viewer's submit);
 * list/interrupt/history join the port in later cuts.
 *
 * The pure delivery core stays in `src/subagent-viewer-submit.ts`
 * (validation, the `ctx.subagents.followup(...)` call, error
 * classification); the port formalizes the seam so the runner depends on
 * the interface, and the Direct adapter owns the `ctx` access.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/subagent-port
 */

import type {
  SubagentFollowupOutcome,
  SubagentParentLike,
  SubagentViewerSubmitRequest,
} from '../subagent-viewer-submit.ts'

/** The caller-owned per-call context for a follow-up delivery (session
 * identity, cancellation, attribution, text canonicalization). The runner
 * provides these; the port never reaches into the session itself. */
export interface SubagentFollowupContext {
  /** The CURRENT live main-session agent (undefined after a session switch
   * or teardown) — the exact live direct parent check. */
  currentParent(): SubagentParentLike | undefined
  /** A fresh per-call cancellation source (the caller owns aborting it). */
  makeSignal(): AbortSignal
  /** Build the durable message source for the delivered message. */
  makeSource(): unknown
  /** Canonicalize the final user text BEFORE delivery (the main session's
   * `@`-file mention expansion). MAY be async (migration M1.10 — the
   * Host-file port); the default passes text through. */
  canonicalizeText?(text: string): string | Promise<string>
}

/** The subagent domain port. */
export interface SubagentPort {
  /** Deliver one viewer follow-up to a continuable child, or classify why
   * it could not be delivered. Never throws for a classified rejection. */
  followup(
    request: SubagentViewerSubmitRequest,
    context: SubagentFollowupContext,
  ): Promise<SubagentFollowupOutcome>
}
