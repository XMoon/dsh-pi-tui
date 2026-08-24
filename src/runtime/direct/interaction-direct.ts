/**
 * The Direct interaction adapter (M1.6) — the in-process implementation of
 * `InteractionPort` over the dsh `userQuestions` / `approval` services and
 * the Cordis `approval/request` event. This is the ONLY module in the
 * interaction path that touches `ctx`; the listeners/providers stay
 * runner-owned (they render through TuiApp), and a Remote adapter will
 * implement the same interface in a later milestone.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/interaction-direct
 */

import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalRequestListener, InteractionPort } from '../interaction-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on(event: string, listener: unknown): unknown
}

/** The structural `userQuestions` service surface. */
export interface UserQuestionsServiceLike {
  registerProvider(provider: UserQuestionProvider): unknown
}

/** The structural `approval` service surface. */
export interface ApprovalServiceLike {
  setPolicy?(agent: unknown, policy: ApprovalPolicy): unknown
}

/** The Direct backend's interaction port: the ctx services/events behind
 * the semantic `InteractionPort` interface. */
export class DirectInteractionPort implements InteractionPort {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  registerQuestionProvider(provider: UserQuestionProvider): boolean {
    const userQuestions = this.ctx.get('userQuestions') as UserQuestionsServiceLike | undefined
    if (userQuestions === undefined) return false
    userQuestions.registerProvider(provider)
    return true
  }

  onApprovalRequest(listener: ApprovalRequestListener): void {
    this.ctx.on('approval/request', listener)
  }

  setApprovalPolicy(agent: unknown, policy: ApprovalPolicy): boolean {
    const approval = this.ctx.get('approval') as ApprovalServiceLike | undefined
    if (approval === undefined || approval.setPolicy === undefined) return false
    approval.setPolicy(agent, policy)
    return true
  }
}