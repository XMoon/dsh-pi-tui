/**
 * The subagent domain port (D2.1 extension) — the semantic contract
 * between the TUI and subagent control. Direct implements it over the dsh
 * official service; an experimental Remote adapter implements the same port
 * over the wire. Direct remains the production/default backend.
 *
 * The port owns human prompt delivery and continuable-child interruption, and
 * the DETACHED wire/application DTOs that cross it (TS8-F4 owns them here so the
 * adapter modules never depend on an application/root module). Parent/child
 * authority is explicit for both operations; no UI row or root inference
 * crosses this boundary.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/subagent-port
 */

/** One human-authored content part for a viewer prompt. The DTO mirrors
 * the official `PromptContentPart` vocabulary from the DSH subagent API;
 * `prompt()` admits image parts through the Host attachment store, so the
 * delivery contract is not locked to text-only — the viewer's image intake
 * joins in a later milestone without another port change. */
export type SubagentPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: string
    readonly data: string
    readonly name?: string
  }

/** The semantic prompt request from the viewer (mirrors
 * SubagentViewerSubmit without importing TuiApp). The runner resolves the
 * composer gesture to `delivery`; the `requestId` and `mode: 'continuable'`
 * are added at the Host adapter boundary. */
export interface SubagentViewerSubmitRequest {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly delivery: 'queue' | 'steer'
  readonly content: readonly SubagentPromptContentPart[]
}

/** Why a prompt was NOT accepted (the child inbox never received it). */
export type SubagentPromptReject =
  /** The addressed parent session is not live or is not the viewer's
   * parent anymore (switch / new / resume / teardown while sending). */
  | { readonly kind: 'parent-unavailable' }
  /** The child id no longer carries a supported continuation state
   * (one-shot id, unknown id, not resumable). */
  | { readonly kind: 'stale-child' }
  /** The parent authority / ownership was rejected by the runtime. */
  | { readonly kind: 'unauthorized' }
  /** The continuation runtime is absent or the child's inbox cannot admit
   * the message right now (draining / activation disposal). */
  | { readonly kind: 'unavailable' }
  /** The caller's signal aborted the delivery BEFORE inbox acceptance. */
  | { readonly kind: 'cancelled' }
  /** Any other failure (message only; safeErrorMessage-style text). */
  | { readonly kind: 'error'; readonly message: string }

export type SubagentPromptOutcome =
  | { readonly kind: 'ok'; readonly messageId: unknown }
  | { readonly kind: 'rejected'; readonly reason: SubagentPromptReject }
  /** The delivery was dispatched but no settlement could be proven (a carrier
   * failure or an unidentified internal error): the child may already own the
   * message. Never a proven "not sent", and never an automatic replay. */
  | { readonly kind: 'indeterminate'; readonly message: string }

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

/** Expected interruption refusal categories. A caller cancellation is not a
 * rejection here; an unidentified failure that leaves the stopped state
 * unproven settles `indeterminate` instead of throwing. */
export type SubagentInterruptReject =
  | { readonly kind: 'unavailable'; readonly message?: string }
  | { readonly kind: 'unauthorized'; readonly message?: string }
  | { readonly kind: 'error'; readonly message: string }

/** Settlement of the semantic interruption request. */
export type SubagentInterruptOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'rejected'; readonly reason: SubagentInterruptReject }
  /** The interrupt was dispatched but no settlement could be proven: the child
   * may already have been stopped. Never a proven no-op and never a replay. */
  | { readonly kind: 'indeterminate'; readonly message: string }

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
