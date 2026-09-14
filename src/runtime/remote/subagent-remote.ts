/**
 * Experimental Remote implementation of the semantic SubagentPort (D2.2).
 *
 * Continuation prompts use the official generated `subagents.prompt` Remote with
 * the exact durable direct-parent address and the required `continuable`
 * discriminator; interruption uses `subagents.interruptByParent` with the
 * caller's explicit parent/child pair. The adapter never calls
 * `ClientSessions.openSubagent()` merely to send or stop a child, and never
 * infers parent authority from UI nesting.
 *
 * The request identity is minted once, before the call, per human submit — a
 * retry that represents a new submit mints a fresh id, and an indeterminate
 * outcome is never replayed automatically with a new identity.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/subagent-remote
 */

import { randomUUID } from 'node:crypto'
import {
  classifySubagentPromptSettlement,
  type SubagentPromptContentPart,
} from '../../subagent-viewer-submit.ts'
import type { SubagentPromptOutcome } from '../../subagent-viewer-submit.ts'
import type {
  SubagentInterruptOutcome,
  SubagentInterruptRequest,
  SubagentPromptContext,
  SubagentPort,
} from '../subagent-port.ts'
import { remoteFailureMessage } from './write-failure.ts'

/** Structural official `RemoteResult`. */
export type RemoteSubagentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** The official `subagents.prompt` request (the mode discriminator is required). */
export interface RemoteSubagentPromptRequest {
  readonly requestId: string
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'continuable'
  readonly delivery: 'queue' | 'steer'
  readonly content: readonly SubagentPromptContentPart[]
  readonly clientTimeZone?: string
}

/** The official generated subagent control Remote face consumed here. */
export interface RemoteSubagentSource {
  prompt(
    request: RemoteSubagentPromptRequest,
    signal?: AbortSignal,
  ): Promise<RemoteSubagentResult<{ readonly messageId: unknown }>>
  interruptByParent(
    childSessionId: string,
    parentSessionId: string,
    mode: 'continuable',
  ): Promise<RemoteSubagentResult<{ readonly accepted: true }>>
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function classifyInterruptFailure(error: unknown): SubagentInterruptOutcome {
  const message = remoteFailureMessage(error)
  switch (errorCode(error)) {
    case 'subagent/not-found':
    case 'subagent/catalog-diagnostic':
    case 'subagent/parent-unavailable':
    case 'subagent/delivery-unavailable':
      return { kind: 'rejected', reason: { kind: 'unavailable', message } }
    case 'subagent/unauthorized':
    case 'UNAUTHORIZED':
      return { kind: 'rejected', reason: { kind: 'unauthorized', message } }
    case 'gateway/bad-request':
      return { kind: 'rejected', reason: { kind: 'error', message } }
    default:
      // A carrier/internal failure after dispatch may already have stopped the
      // child; never a proven no-op and never a blind retry.
      return { kind: 'indeterminate', message }
  }
}

/** Map a failed viewer prompt onto the port outcome: a proven refusal keeps
 * its reason; an ambiguous post-dispatch failure is `indeterminate`. */
function promptOutcomeOf(error: unknown): SubagentPromptOutcome {
  const settlement = classifySubagentPromptSettlement(error)
  return settlement.kind === 'rejected'
    ? { kind: 'rejected', reason: settlement.reason }
    : settlement
}

/** The experimental Remote subagent port. */
export class RemoteSubagentPort implements SubagentPort {
  private readonly subagents: RemoteSubagentSource
  /** Canonicalization is async, so serialize calls per parent/child target
   * before the official prompt admission observes them — the same ordering
   * invariant the Direct adapter preserves. */
  private readonly promptTails = new Map<string, Promise<void>>()

  constructor(subagents: RemoteSubagentSource) {
    this.subagents = subagents
  }

  prompt(
    request: {
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly delivery: 'queue' | 'steer'
      readonly content: readonly SubagentPromptContentPart[]
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
        return await this.deliver(request, context)
      } finally {
        releaseTail()
        if (this.promptTails.get(key) === turn) this.promptTails.delete(key)
      }
    })
  }

  private async deliver(
    request: {
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly delivery: 'queue' | 'steer'
      readonly content: readonly SubagentPromptContentPart[]
    },
    context: SubagentPromptContext,
  ): Promise<SubagentPromptOutcome> {
    // Pre-dispatch preparation. Any failure here happens BEFORE prompt() is
    // called, so it is a KNOWN non-dispatch (never indeterminate). The request
    // identity is minted here too: it is an argument evaluated before the call,
    // so a mint failure must not be mistaken for an ambiguous delivery.
    let signal: AbortSignal
    let canonical: SubagentPromptContentPart[]
    let requestId: string
    try {
      signal = context.makeSignal()
      canonical = []
      for (const part of request.content) {
        if (part.type === 'text') {
          canonical.push({ type: 'text', text: await context.canonicalizeText?.(part.text) ?? part.text })
        } else {
          canonical.push(part)
        }
      }
      if (signal.aborted) return { kind: 'rejected', reason: { kind: 'cancelled' } }
      // The identity is minted BEFORE the call and persisted on the accepted
      // message; only a NEW human submit mints another.
      requestId = randomUUID()
    } catch (error) {
      return { kind: 'rejected', reason: { kind: 'error', message: remoteFailureMessage(error) } }
    }
    // Dispatch. The generated Remote resolves to `RemoteResult` (carrier
    // failures are in the error branch); a rejection is an assembly/programming
    // defect and must propagate, never become an ambiguous delivery.
    const result = await this.subagents.prompt(
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
    if (result.ok) return { kind: 'ok', messageId: result.value.messageId }
    return promptOutcomeOf(result.error)
  }

  async interrupt(request: SubagentInterruptRequest): Promise<SubagentInterruptOutcome> {
    // No defensive catch: the generated Remote resolves to `RemoteResult`.
    const result = await this.subagents.interruptByParent(
      request.childSessionId,
      request.parentSessionId,
      'continuable',
    )
    if (result.ok) return { kind: 'committed' }
    return classifyInterruptFailure(result.error)
  }
}
