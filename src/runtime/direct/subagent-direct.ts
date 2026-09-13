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
import { submitSubagentPrompt, type SubagentPromptService } from '../../subagent-viewer-submit.ts'
import type { SubagentPromptOutcome } from '../../subagent-viewer-submit.ts'
import type {
  SubagentInterruptOutcome,
  SubagentInterruptRequest,
  SubagentPromptContext,
  SubagentPort,
} from '../subagent-port.ts'
import { safeErrorMessage } from '../../error-boundary.ts'

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

function classifyInterruptFailure(error: unknown): SubagentInterruptOutcome | undefined {
  switch (errorCode(error)) {
    case 'subagent/parent-unavailable':
    case 'subagent/delivery-unavailable':
      return { kind: 'rejected', reason: { kind: 'unavailable', message: safeErrorMessage(error) } }
    case 'subagent/unauthorized':
    case 'UNAUTHORIZED':
      return { kind: 'rejected', reason: { kind: 'unauthorized', message: safeErrorMessage(error) } }
    default:
      return undefined
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
    request: { readonly parentSessionId: string; readonly childSessionId: string; readonly content: readonly unknown[] },
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
      const classified = classifyInterruptFailure(error)
      if (classified !== undefined) return classified
      throw error
    }
    return { kind: 'committed' }
  }
}
