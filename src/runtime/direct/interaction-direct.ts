/**
 * The Direct interaction adapter (M1.6, contract-reviewed round 4) — the
 * in-process implementation of `InteractionPort` over the dsh
 * `userQuestions` / `approval` services and the Cordis `approval/request`
 * event. This is the ONLY module in the interaction path that touches
 * `ctx`; the listeners/providers stay runner-owned (they render through
 * TuiApp), and a Remote adapter will implement the same interface in a
 * later milestone. The identity-based `setApprovalPolicy(sessionId)` is
 * resolved to the live Agent HERE (runner-injected resolver); the
 * approval request listener is adapted from the official ApprovalRequest
 * (which carries a same-process Agent) onto the transport-neutral
 * ApprovalRequestLike.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/interaction-direct
 */

import type { ApprovalPolicy, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestLike, ApprovalRequestListener, InteractionPort, UserQuestionProvider } from '../interaction-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on(event: string, listener: unknown): unknown
}

/** The structural `approval` service surface. */
export interface ApprovalServiceLike {
  setPolicy?(agent: unknown, policy: ApprovalPolicy): unknown
}

/** The Direct backend's interaction port: the ctx services/events behind
 * the semantic `InteractionPort` interface. The `agentFor` resolver
 * converts the identity-based policy call into the live Agent. */
export class DirectInteractionPort implements InteractionPort {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => unknown | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  registerQuestionProvider(provider: UserQuestionProvider): boolean {
    if (this.ctx.get('userQuestions') === undefined) return false
    // DSH 0.1.2 exposes question answerers on the scoped waterfall; the old
    // userQuestions.registerProvider API was removed with the 1.2 contract.
    this.ctx.on('user-questions/request', provider)
    return true
  }

  onApprovalRequest(listener: ApprovalRequestListener): void {
    this.ctx.on('approval/request', (req: ApprovalRequest, next: unknown) => {
      // Adapt the same-process ApprovalRequest onto the transport-neutral
      // shape the TUI consumes (the listener never needs req.agent).
      const like: ApprovalRequestLike = {
        ...req.signal !== undefined ? { signal: req.signal } : {},
        callId: req.callId !== undefined ? String(req.callId) : undefined,
        toolName: req.toolName,
        reason: req.reason,
      }
      return listener(like, next)
    })
  }

  setApprovalPolicy(sessionId: string, policy: ApprovalPolicy): boolean {
    const approval = this.ctx.get('approval') as ApprovalServiceLike | undefined
    if (approval === undefined || approval.setPolicy === undefined) return false
    // Identity → live Agent resolution happens HERE (never across the
    // port): a Remote backend maps sessionId to the official wire
    // capability instead.
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return false
    approval.setPolicy(agent, policy)
    return true
  }
}