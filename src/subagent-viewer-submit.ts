/**
 * The interactive subagent viewer's HUMAN PROMPT delivery seam — the pure,
 * dependency-injected layer between TuiApp's semantic submit event and the
 * DSH official subagent control API (plan §17; DSH 0.1.2-alpha.4). It owns
 * validation, the `ctx.subagents.prompt(...)` call, and error
 * classification; the runner owns the surface effects (draft restore,
 * notices, stale-viewer guards).
 *
 * The write path is DELIBERATELY narrow:
 *
 * ```text
 * TuiApp (Enter in a continuable viewer)
 *   ↓ onSubagentSubmit({ parentSessionId, childSessionId, text })
 * submitSubagentPrompt(...)
 *   ↓ canonicalize the TUI @-mention grammar (client-owned, Host-neutral)
 *   ↓ ctx.subagents.prompt({ requestId, parentSessionId, childSessionId,
 *                           mode: 'continuable', content }, signal)
 *   ↓ child Agent inbox (the ONLY queue — a distinct FIFO turn)
 * ```
 *
 * This is a HUMAN prompt (user provenance, next distinct turn), which is
 * why the official seam is `subagents.prompt()` — never
 * `subagents.sendMessage()` (that is the Agent-authored Steer path) and
 * never the parent session's submit/steer/queue path. Parent authority is
 * the Host's: the official call rejects a parent that is not the exact
 * live owner (`subagent/parent-unavailable` / `subagent/unauthorized`).
 *
 * No TUI component is touched here — the module only decides; the caller
 * restores drafts and notifies.
 * @module @xmoon76/dsh-pi-tui/subagent-viewer-submit
 */

/** One human-authored content part for a viewer prompt. The DTO mirrors
 * the official `PromptContentPart` vocabulary (alpha.4's official
 * `prompt()` admits image parts through the Host attachment store), so the
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
 * SubagentViewerSubmit without importing TuiApp). The `requestId` and
 * `mode: 'continuable'` are added at the Host adapter boundary. */
export interface SubagentViewerSubmitRequest {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly content: readonly SubagentPromptContentPart[]
}

/** The official `ctx.subagents.prompt` control surface (structural — never
 * a package dependency; the service resolves from the dsh installation).
 * The request shape is the official `SubagentPromptRequest` vocabulary:
 * caller-minted `requestId`, durable parent/child address, the required
 * `continuable` discriminator, prompt parts, and the optional browser
 * zone. */
export interface SubagentPromptService {
  prompt(
    request: {
      readonly requestId: string
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly mode: 'continuable'
      readonly content: readonly SubagentPromptContentPart[]
      readonly clientTimeZone?: string
    },
    signal: AbortSignal,
  ): Promise<{ readonly messageId: unknown }>
}

/** The dependency surface the submit function needs. */
export interface SubagentViewerSubmitDeps {
  /** The `ctx.subagents` runtime (undefined = continuation unavailable). */
  subagents(): SubagentPromptService | undefined
  /** A fresh per-call cancellation source (the caller owns aborting it). */
  makeSignal(): AbortSignal
  /** Mint the caller-owned identity for THIS prompt, before the call —
   * every retry that represents a NEW human submit mints a fresh id (the
   * Host persists it on the accepted message). */
  mintRequestId(): string
  /** Canonicalize the final user text BEFORE delivery (the main session's
   * `@`-file mention expansion — `@src/foo.ts` → the absolute path — must
   * apply to viewer prompts too, or the model would see the concise
   * relative form it cannot resolve; this is TUI input grammar, the
   * official subagent prompt does not own it). MAY be async (migration
   * M1.10: the Host-file port's canonicalization); the default passes the
   * text through untouched. */
  canonicalizeText?(text: string): string | Promise<string>
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

/** Whether a settled prompt may still touch the CURRENT surface: the
 * viewer session that started the send must be unchanged — the SAME
 * child is still being viewed, the viewer generation has not moved (a
 * viewer open/close/switch bumps it, so a close → reopen of the SAME
 * child is stale), and the live parent session is still the one the
 * viewer was opened from. Anything else is a STALE settle: the result
 * may only touch the child's OWN draft slot (map-only), never the
 * visible surface (plan §12). This is CLIENT presentation consistency —
 * the official `prompt()` validates Host authority, but it cannot keep a
 * settled UI surface isolated, so this guard stays. */
export type SubagentSettleTarget =
  | { readonly kind: 'current'; readonly label: string }
  | { readonly kind: 'stale' }

export interface SubagentSettleViewerState {
  /** The child currently being viewed (undefined = viewer closed). */
  readonly viewingChildId: string | undefined
  /** The viewed child's display label. */
  readonly viewingLabel: string | undefined
  /** The exact parent the current viewer was opened from. */
  readonly viewingParentSessionId: string | undefined
  /** The viewer generation captured when the send started. */
  readonly viewerGenerationAtSend: number
  /** The viewer generation NOW (open/close/switch bump it). */
  readonly viewerGenerationNow: number
  /** The live parent session id at settle time. */
  readonly liveParentSessionId: string | undefined
}

export function resolveSubagentSettleTarget(
  request: SubagentViewerSubmitRequest,
  view: SubagentSettleViewerState,
): SubagentSettleTarget {
  if (view.viewingChildId !== request.childSessionId) return { kind: 'stale' }
  if (view.viewingParentSessionId !== request.parentSessionId) return { kind: 'stale' }
  if (view.viewerGenerationNow !== view.viewerGenerationAtSend) return { kind: 'stale' }
  if (view.liveParentSessionId !== request.parentSessionId) return { kind: 'stale' }
  return { kind: 'current', label: view.viewingLabel ?? request.childSessionId }
}

/**
 * The Host-file scope one viewer prompt canonicalizes against: the VIEWED
 * CHILD's workspace when the viewer knows it (the child may have been born
 * in another directory — rewriting its mentions against the PARENT cwd
 * would resolve them to the wrong tree), the live parent session
 * otherwise (an unknown cold-child cwd). Pure so the race is
 * unit-testable (review finding: parent cwd ≠ child cwd).
 */
export function viewerCanonicalizeScope(
  viewingCwd: string | undefined,
  liveParentSessionId: string | undefined,
): { kind: 'workspace'; cwd: string } | { kind: 'session'; sessionId: string } {
  return viewingCwd !== undefined && viewingCwd !== ''
    ? { kind: 'workspace', cwd: viewingCwd }
    : { kind: 'session', sessionId: liveParentSessionId ?? '' }
}

/**
 * Deliver one viewer prompt to a continuable child through the official
 * subagent control API, or classify why it could not be delivered. Never
 * throws for a classified rejection; an unexpected throw surfaces as
 * `{ kind: 'error' }`.
 */
export async function submitSubagentPrompt(
  request: SubagentViewerSubmitRequest,
  deps: SubagentViewerSubmitDeps,
): Promise<SubagentPromptOutcome> {
  try {
    // 1. The official control surface, read lazily: the continuation
    //    runtime may appear/disappear between calls (draining / activation
    //    disposal).
    const subagents = deps.subagents()
    if (subagents === undefined) {
      return { kind: 'rejected', reason: { kind: 'unavailable' } }
    }
    const signal = deps.makeSignal()
    // 2. The TUI's own @-mention grammar is canonicalized BEFORE delivery
    //    (the editor keeps `@src/foo.ts`, the child model receives the
    //    absolute path). The canonicalization MAY be async (migration
    //    M1.10 — the Host-file port), so the caller signal is re-checked
    //    after the await: an implementation that does not synchronously
    //    reject an already-aborted signal must never accept the message
    //    while the UI already treats the send as stale (the draft is
    //    restored by the caller). Parent/child authority itself is the
    //    Host's job — the official prompt() rejects it authoritatively.
    const canonical: SubagentPromptContentPart[] = []
    for (const part of request.content) {
      if (part.type === 'text') {
        canonical.push({ type: 'text', text: await deps.canonicalizeText?.(part.text) ?? part.text })
      } else {
        // Image parts are forwarded VERBATIM: the Host admits and persists
        // them through the attachment store before delivery (the official
        // prompt contract) — the TUI never rewrites them, and the
        // @-mention canonicalization applies to text only.
        canonical.push(part)
      }
    }
    if (signal.aborted) return { kind: 'rejected', reason: { kind: 'cancelled' } }
    // 3. The ONE correct write path: the official browser prompt contract.
    //    A HUMAN-authored message to a continuable direct child — the
    //    child inbox queues it as its own distinct FIFO turn (enqueue
    //    while running, wake while waiting, cold resume when absent), and
    //    the requestId (minted fresh for THIS submit, before the call) is
    //    persisted on the accepted message.
    const receipt = await subagents.prompt(
      {
        requestId: deps.mintRequestId(),
        parentSessionId: request.parentSessionId,
        childSessionId: request.childSessionId,
        mode: 'continuable',
        content: canonical,
      },
      signal,
    )
    return { kind: 'ok', messageId: receipt.messageId }
  } catch (error) {
    return { kind: 'rejected', reason: classifySubagentPromptError(error) }
  }
}

/**
 * Classify an official prompt failure into the stable reason set. The
 * Direct adapter reads the official RemoteError vocabulary structurally
 * (the `code` string; the subagent package stays resolvable from the dsh
 * installation, never an import here).
 */
export function classifySubagentPromptError(error: unknown): SubagentPromptReject {
  if (isAbortError(error)) return { kind: 'cancelled' }
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof code === 'string') {
    if (code === 'gateway/cancelled') return { kind: 'cancelled' }
    if (code === 'subagent/parent-unavailable') return { kind: 'parent-unavailable' }
    if (code === 'subagent/not-resumable') return { kind: 'stale-child' }
    if (code === 'subagent/unauthorized') return { kind: 'unauthorized' }
    if (code === 'subagent/delivery-unavailable') return { kind: 'unavailable' }
  }
  return { kind: 'error', message: safeErrorMessage(error) }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

/** One-line safe error text (never throws on hostile values). */
function safeErrorMessage(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    const message = error.message
    return message === '' ? error.name : message
  }
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
