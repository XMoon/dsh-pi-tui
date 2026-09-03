/**
 * The subagent domain port (M1.2) — the semantic contract between the TUI
 * and the subagent domain, implemented by `src/runtime/direct/` (Direct)
 * today and by a Remote adapter in a later milestone. The port is narrow:
 * it owns the human prompt delivery path (the interactive viewer's
 * submit); list/interrupt/history join the port in later cuts.
 *
 * The pure delivery core stays in `src/subagent-viewer-submit.ts`
 * (validation, the official `ctx.subagents.prompt(...)` call, error
 * classification); the port formalizes the seam so the runner depends on
 * the interface, and the Direct adapter owns the `ctx` access and the
 * requestId minting.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/subagent-port
 */

import type {
  SubagentPromptOutcome,
  SubagentViewerSubmitRequest,
} from '../subagent-viewer-submit.ts'

/** The caller-owned per-call context for a prompt delivery (cancellation,
 * text canonicalization). The runner provides these; the port never
 * reaches into the session itself — parent/child authority is validated
 * by the official Host call. */
export interface SubagentPromptContext {
  /** A fresh per-call cancellation source (the caller owns aborting it). */
  makeSignal(): AbortSignal
  /** Canonicalize the final user text BEFORE delivery (the main session's
   * `@`-file mention expansion). MAY be async (migration M1.10 — the
   * Host-file port); the default passes text through. */
  canonicalizeText?(text: string): string | Promise<string>
}

/** The subagent domain port. */
export interface SubagentPort {
  /** Deliver one viewer HUMAN PROMPT to a continuable child through the
   * official subagent control API, or classify why it could not be
   * delivered. Never throws for a classified rejection. */
  prompt(
    request: SubagentViewerSubmitRequest,
    context: SubagentPromptContext,
  ): Promise<SubagentPromptOutcome>
}
