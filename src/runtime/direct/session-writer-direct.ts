/**
 * The Direct session writer (M1.4, contract-reviewed round 2) — the
 * in-process implementation of `SessionWriter` over the live agent objects
 * and the dsh `sessionTitle` service. The contract is identity-based: the
 * adapter resolves the live agent/session FROM THE SESSION ID through the
 * runner-injected resolver (never a stale captured object — the resolver
 * re-reads the live surface on every call). This is the ONLY module in the
 * session-write path that touches `ctx`; a Remote adapter will implement
 * the same interface over the wire.
 *
 * Steer ORCHESTRATION (fence / barrier — steerAll in src/steer.ts)
 * stays in the runner; the FINAL steer delivery goes through this port.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-writer-direct
 */

import type { SessionWriter } from '../session-writer-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The live-agent surface the Direct adapter drives (structural). */
export interface LiveAgentLike {
  readonly session: { readonly id: string }
  followup(message: unknown): void
  /** Deliver the steered batch into the next step (the agent's steer). */
  steer(message: unknown): void
  cancel(reason: unknown, options: { keepInbox: boolean }): void
  readonly inbox: { remove(id: string): void }
}

/** The structural `sessionTitle` service surface. */
export interface SessionTitleServiceLike {
  rename(session: unknown, name: string): void
  refresh(session: unknown, signal: AbortSignal): Promise<{ title: string } | undefined>
}

/** The Direct backend's session writer: identity-based operations over the
 * live agents and the `ctx.sessionTitle` service. The agent resolver is
 * injected by the runner (a closure over the live surface), so a session
 * switch between calls is observed at call time. */
export class DirectSessionWriter implements SessionWriter {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  followup(sessionId: string, message: unknown): void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return
    agent.followup(message)
  }

  steer(sessionId: string, messages: readonly unknown[]): void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return
    for (const message of messages) agent.steer(message)
  }

  dequeue(sessionId: string, messageId: string): void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return
    agent.inbox.remove(messageId)
  }

  cancel(sessionId: string, reason: unknown, options: { keepInbox: boolean }): void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return
    agent.cancel(reason, options)
  }

  rename(sessionId: string, name: string): boolean {
    const titles = this.ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) return false
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return false
    titles.rename(agent.session, name)
    return true
  }

  async refreshTitle(sessionId: string, signal: AbortSignal): Promise<
    | { kind: 'unavailable' }
    | { kind: 'ok'; title: string | undefined }
  > {
    const titles = this.ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) return { kind: 'unavailable' }
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return { kind: 'unavailable' }
    const regenerated = await titles.refresh(agent.session, signal)
    return { kind: 'ok', title: regenerated?.title }
  }
}