/**
 * The interactive subagent viewer's FOLLOW-UP delivery seam — the pure,
 * dependency-injected layer between TuiApp's semantic submit event and the
 * DSH continuation runtime (plan §17). It owns validation, the
 * `ctx.subagents.followup(...)` call, and error classification; the runner
 * owns the surface effects (draft restore, notices, stale-viewer guards).
 *
 * The write path is DELIBERATELY narrow:
 *
 * ```text
 * TuiApp (Enter in a continuable viewer)
 *   ↓ onSubagentSubmit({ parentSessionId, childSessionId, text })
 * submitSubagentFollowup(...)
 *   ↓ exact live direct parent check (the DSH continuation contract)
 *   ↓ ctx.subagents.followup(exactParent, childId, content, …)
 *   ↓ continuation manager → child Agent inbox (the ONLY queue)
 * ```
 *
 * Never a second subagent message queue, never `ctx.agents.get(childId)
 * .followup(...)` (that bypasses the continuation manager, breaks cold
 * resume and the direct-parent authority), and never the parent's
 * submit/steer/queue path.
 *
 * No TUI component is touched here — the module only decides; the caller
 * restores drafts and notifies.
 * @module @xmoon76/dsh-pi-tui/subagent-viewer-submit
 */

/** The semantic follow-up request from the viewer (mirrors
 * SubagentViewerSubmit without importing TuiApp). */
export interface SubagentViewerSubmitRequest {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly text: string
}

/** The exact live direct parent (structural Agent projection). */
export interface SubagentParentLike {
  readonly session: { readonly id: string }
}

/** The structural `ctx.subagents` followup surface (never a package
 * dependency — the service resolves from the dsh installation). */
export interface SubagentFollowupService {
  followup(
    parent: SubagentParentLike,
    childId: string,
    content: readonly { readonly type: 'text'; readonly text: string }[],
    options: { readonly source: unknown; readonly signal: AbortSignal },
  ): Promise<unknown>
}

/** The dependency surface the submit function needs. */
export interface SubagentViewerSubmitDeps {
  /** The CURRENT live main-session agent (may be undefined after a
   * session switch or teardown). */
  currentParent(): SubagentParentLike | undefined
  /** The `ctx.subagents` runtime (undefined = continuation unavailable). */
  subagents(): SubagentFollowupService | undefined
  /** A fresh per-call cancellation source (the caller owns aborting it). */
  makeSignal(): AbortSignal
  /** Build the durable message source for the delivered message. */
  makeSource(): unknown
  /** Canonicalize the final user text BEFORE delivery (the main session's
   * `@`-file mention expansion — `@src/foo.ts` → the absolute path — must
   * apply to viewer follow-ups too, or the model would see the concise
   * relative form it cannot resolve). The default passes the text through
   * untouched; the runner wires the real expansion. */
  canonicalizeText?(text: string): string
}

/** Why a follow-up was NOT accepted (the child inbox never received it). */
export type SubagentFollowupReject =
  /** The exact live direct parent is gone or is a DIFFERENT session than
   * the viewer target (switch / new / resume / teardown while sending). */
  | { readonly kind: 'parent-unavailable' }
  /** The child id no longer carries a supported continuation state
   * (one-shot id, unknown id, not resumable). */
  | { readonly kind: 'stale-child' }
  /** The parent authority / ownership was rejected by the runtime. */
  | { readonly kind: 'unauthorized' }
  /** The continuation runtime is absent or closing (draining / activation
   * disposal). */
  | { readonly kind: 'unavailable' }
  /** The caller's signal aborted the delivery BEFORE inbox acceptance. */
  | { readonly kind: 'cancelled' }
  /** Any other failure (message only; safeErrorMessage-style text). */
  | { readonly kind: 'error'; readonly message: string }

export type SubagentFollowupOutcome =
  | { readonly kind: 'ok'; readonly messageId: unknown }
  | { readonly kind: 'rejected'; readonly reason: SubagentFollowupReject }

/** Whether a settled follow-up may still touch the CURRENT surface: the
 * viewer session that started the send must be unchanged — the SAME
 * child is still being viewed, the viewer generation has not moved (a
 * viewer open/close/switch bumps it, so a close → reopen of the SAME
 * child is stale), and the live parent session is still the one the
 * viewer was opened from. Anything else is a STALE settle: the result
 * may only touch the child's OWN draft slot (map-only), never the
 * visible surface (plan §12). */
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
 * Deliver one viewer follow-up to a continuable child, or classify why it
 * could not be delivered. Never throws for a classified rejection; an
 * unexpected throw surfaces as `{ kind: 'error' }`.
 */
export async function submitSubagentFollowup(
  request: SubagentViewerSubmitRequest,
  deps: SubagentViewerSubmitDeps,
): Promise<SubagentFollowupOutcome> {
  try {
    // 1. The EXACT live direct parent (plan §9.1): the child may only be
    //    continued by the parent session the viewer was opened from. A
    //    session switch / /new / /resume while the user typed is a hard
    //    reject — never route the text to a different main Agent.
    const parent = deps.currentParent()
    if (parent === undefined || parent.session.id !== request.parentSessionId) {
      return { kind: 'rejected', reason: { kind: 'parent-unavailable' } }
    }
    const subagents = deps.subagents()
    if (subagents === undefined) {
      return { kind: 'rejected', reason: { kind: 'unavailable' } }
    }
    const signal = deps.makeSignal()
    // 2. Text-only follow-ups (the viewer phase-1 scope; images are a
    //    later milestone — the main-session image store is deliberately
    //    never shared with the child). The text runs through the same
    //    canonicalization as the main session's submissions (`@`-file
    //    mention expansion), so the child sees exactly what the parent
    //    would have sent.
    const canonical = deps.canonicalizeText?.(request.text) ?? request.text
    const content = [{ type: 'text', text: canonical }] as const
    // 3. The ONE correct write path: the continuation manager owns the
    //    child's inbox (enqueue while running, wake while waiting, cold
    //    resume when absent) and the direct-parent authority.
    const messageId = await subagents.followup(
      parent,
      request.childSessionId,
      content,
      { source: deps.makeSource(), signal },
    )
    return { kind: 'ok', messageId }
  } catch (error) {
    return { kind: 'rejected', reason: classifySubagentFollowupError(error) }
  }
}

/**
 * Classify a followup failure into the stable reason set (structural error
 * reading — the subagent package stays a type-only import, resolved from
 * the dsh installation at runtime).
 */
export function classifySubagentFollowupError(error: unknown): SubagentFollowupReject {
  if (isAbortError(error)) return { kind: 'cancelled' }
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof code === 'string') {
    if (code === 'UNAUTHORIZED') return { kind: 'unauthorized' }
    if (code === 'PARENT_UNAVAILABLE') return { kind: 'parent-unavailable' }
    if (code === 'NOT_RESUMABLE') return { kind: 'stale-child' }
    if (code === 'DRAINING' || code === 'ACTIVATION_CLOSING') return { kind: 'unavailable' }
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
