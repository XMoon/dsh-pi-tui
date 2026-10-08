/**
 * The Direct subagent adapter (D2.1 extension) — the in-process
 * implementation of `SubagentPort` over the dsh `ctx.subagents` official
 * control surface. The runner depends on the port; this adapter is the only
 * subagent control path that touches `ctx`.
 *
 * The prompt service remains lazy per call and mints the caller-owned request
 * id. Interruption maps the explicit semantic parent/child request to the
 * official Direct authority shape.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/subagent-direct
 */

import { randomUUID } from 'node:crypto'
import {
  classifySubagentPromptSettlement,
  safeSubagentErrorMessage,
} from '../subagent-outcome.ts'
import type {
  SubagentInterruptOutcome,
  SubagentInterruptRequest,
  SubagentPromptContentPart,
  SubagentPromptContext,
  SubagentPromptOutcome,
  SubagentPort,
  SubagentViewerSubmitRequest,
} from '../subagent-port.ts'
import { safeErrorMessage } from '../process/errors.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the service resolves from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Direct interrupt surface of `ctx.subagents`. */
export interface SubagentInterruptServiceLike {
  interrupt(
    targetSessionId: string,
    authority: { readonly kind: 'user'; readonly parentSessionId: string },
  ): void
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Classify an interrupt failure. Known authority/business codes are proven
 * refusals; an unidentified throw leaves the child's stopped state unproven, so
 * it settles `indeterminate` rather than throwing the caller into a false
 * "not stopped" (or a blind retry).
 */
function classifyInterruptFailure(error: unknown): SubagentInterruptOutcome {
  switch (errorCode(error)) {
    case 'subagent/not-found':
    case 'subagent/catalog-diagnostic':
    case 'subagent/parent-unavailable':
    case 'subagent/delivery-unavailable':
      return { kind: 'rejected', reason: { kind: 'unavailable', message: safeErrorMessage(error) } }
    case 'subagent/unauthorized':
    case 'UNAUTHORIZED':
      return { kind: 'rejected', reason: { kind: 'unauthorized', message: safeErrorMessage(error) } }
    default:
      return { kind: 'indeterminate', message: safeErrorMessage(error) }
  }
}

/** The Direct backend's subagent port. */
export class DirectSubagentPort implements SubagentPort {
  private readonly ctx: HostContextLike
  /** Canonicalization is async, so serialize calls per parent/child target
   * before the official prompt admission can observe them. */
  private readonly promptTails = new Map<string, Promise<void>>()

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  prompt(
    request: {
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly delivery: 'queue' | 'steer'
      readonly content: readonly unknown[]
    },
    context: SubagentPromptContext,
  ): Promise<SubagentPromptOutcome> {
    const key = `${request.parentSessionId}\u0000${request.childSessionId}`
    const predecessor = this.promptTails.get(key) ?? Promise.resolve()
    let releaseTail!: () => void
    const turn = new Promise<void>(resolve => { releaseTail = resolve })
    this.promptTails.set(key, turn)
    return predecessor.then(async () => {
      try {
        return await submitSubagentPrompt(request as Parameters<typeof submitSubagentPrompt>[0], {
          // Lazy per-call read: the continuation runtime may appear/disappear
          // between calls (draining / activation disposal).
          subagents: () => this.ctx.get('subagents') as SubagentPromptService | undefined,
          makeSignal: context.makeSignal,
          // One fresh caller-minted identity per human submit, minted before the
          // call (a retry that represents a NEW submit mints a new id).
          mintRequestId: () => randomUUID(),
          canonicalizeText: context.canonicalizeText,
        })
      } finally {
        releaseTail()
        if (this.promptTails.get(key) === turn) this.promptTails.delete(key)
      }
    })
  }

  async interrupt(request: SubagentInterruptRequest): Promise<SubagentInterruptOutcome> {
    const service = this.ctx.get('subagents') as SubagentInterruptServiceLike | undefined
    if (service === undefined) {
      return { kind: 'rejected', reason: { kind: 'unavailable', message: 'subagent service unavailable' } }
    }
    try {
      service.interrupt(request.childSessionId, {
        kind: 'user',
        parentSessionId: request.parentSessionId,
      })
    } catch (error: unknown) {
      return classifyInterruptFailure(error)
    }
    return { kind: 'committed' }
  }
}

/** The official `ctx.subagents.prompt` control surface (structural — never
 * a package dependency; the service resolves from the dsh installation).
 * The request shape is the official `SubagentPromptRequest` vocabulary:
 * caller-minted `requestId`, durable parent/child address, the required
 * `continuable` discriminator, explicit `queue` or `steer` delivery, prompt
 * parts, and the optional browser zone. */
export interface SubagentPromptService {
  prompt(
    request: {
      readonly requestId: string
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly mode: 'continuable'
      readonly delivery: 'queue' | 'steer'
      readonly content: readonly SubagentPromptContentPart[]
      readonly clientTimeZone?: string
    },
    signal: AbortSignal,
  ): Promise<{ readonly messageId: unknown }>
}

/** The dependency surface the Direct submit helper needs. */
export interface SubagentViewerSubmitDeps {
  /** The `ctx.subagents` runtime (undefined = continuation unavailable). */
  subagents(): SubagentPromptService | undefined
  /** A fresh per-call cancellation source (the caller owns aborting it). */
  makeSignal(): AbortSignal
  /** Mint the caller-owned identity for THIS prompt, before the call —
   * every retry that represents a NEW human submit mints a fresh id (the
   * Host persists it on the accepted message). */
  mintRequestId(): string
  /** The send seam for the final user text BEFORE delivery (the official
   * `@`-mention semantics keep it LITERAL — the Host's
   * FILE_REFERENCE_PROMPT resolves relative paths from the workspace
   * root, on the main surface and in viewer prompts alike). MAY be async;
   * the default passes the text through untouched. */
  canonicalizeText?(text: string): string | Promise<string>
}

/**
 * Deliver one viewer prompt to a continuable child through the official
 * subagent control API, or settle why it could not be delivered. Never throws:
 * a pre-dispatch preparation failure is `{ kind: 'rejected' }` (a restorable
 * draft), a proven dispatch-phase refusal is `{ kind: 'rejected' }`, and only
 * an unidentified failure OF the `prompt()` dispatch itself settles
 * `{ kind: 'indeterminate' }` (see {@link classifySubagentPromptSettlement}).
 *
 * INTERNAL to the Direct adapter: application code consumes the semantic
 * `SubagentPort.prompt` on `DirectSubagentPort`, never this helper.
 */
export async function submitSubagentPrompt(
  request: SubagentViewerSubmitRequest,
  deps: SubagentViewerSubmitDeps,
): Promise<SubagentPromptOutcome> {
  // ── Pre-dispatch preparation. Every failure here happens BEFORE
  //    `prompt()` is called, so it is a KNOWN non-dispatch: the caller may
  //    restore its draft and it is never indeterminate.
  let subagents: SubagentPromptService
  let signal: AbortSignal
  let canonical: SubagentPromptContentPart[]
  let requestId: string
  try {
    // 1. The official control surface, read lazily: the continuation
    //    runtime may appear/disappear between calls (draining / activation
    //    disposal).
    const resolved = deps.subagents()
    if (resolved === undefined) {
      return { kind: 'rejected', reason: { kind: 'unavailable' } }
    }
    subagents = resolved
    signal = deps.makeSignal()
    // 2. The send seam passes the text BEFORE delivery (the official
    //    mention semantics keep it literal). The seam MAY be async, so the
    //    caller signal is re-checked after the await: an implementation
    //    that does not synchronously reject an already-aborted signal must
    //    never accept the message while the UI already treats the send as
    //    stale (the draft is restored by the caller). Parent/child
    //    authority itself is the Host's job — the official prompt()
    //    rejects it authoritatively.
    canonical = []
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
    // 3. Mint the caller-owned identity in the PRE-DISPATCH phase: it is an
    //    argument evaluated before `prompt()`, so a mint failure is a known
    //    non-dispatch, not an ambiguous delivery.
    requestId = deps.mintRequestId()
  } catch (error) {
    return { kind: 'rejected', reason: { kind: 'error', message: safeSubagentErrorMessage(error) } }
  }
  // ── Dispatch. Only a failure of the `prompt()` call itself can leave the
  //    child's ownership unproven.
  try {
    // The ONE correct write path: the official browser prompt contract.
    // A HUMAN-authored message to a continuable direct child — the
    // resolved queue/steer delivery is passed unchanged to the child;
    // the child owns the selected placement;
    // the requestId (minted fresh for THIS submit, before the call) is
    // persisted on the accepted message.
    const receipt = await subagents.prompt(
      {
        requestId,
        parentSessionId: request.parentSessionId,
        childSessionId: request.childSessionId,
        mode: 'continuable',
        delivery: request.delivery,
        content: canonical,
      },
      signal,
    )
    return { kind: 'ok', messageId: receipt.messageId }
  } catch (error) {
    const settlement = classifySubagentPromptSettlement(error)
    return settlement.kind === 'rejected'
      ? { kind: 'rejected', reason: settlement.reason }
      : settlement
  }
}
