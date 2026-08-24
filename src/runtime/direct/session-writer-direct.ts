/**
 * The Direct session writer (M1.4) — the in-process implementation of
 * `SessionWriter` over the live agent/session objects and the dsh
 * `sessionTitle` service. This is the ONLY module in the session-write
 * path that touches `ctx`; the runner keeps the Direct-mode orchestration
 * (divergence guard, transition fence, operation barrier) around the port
 * calls, and a Remote adapter will implement the same interface in a later
 * milestone.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-writer-direct
 */

import { steerAll } from '../../steer.ts'
import type { SteerAllOptions, SteerDeps, SteerOutcome } from '../../steer.ts'
import type { AgentLike, CancelAgentLike, SessionLike, SessionWriter } from '../session-writer-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The structural `sessionTitle` service surface. */
export interface SessionTitleServiceLike {
  rename(session: unknown, name: string): void
  refresh(session: unknown, signal: AbortSignal): Promise<{ title: string } | undefined>
}

/** The Direct backend's session writer: raw agent/session operations and
 * the `ctx.sessionTitle` service behind the semantic `SessionWriter`
 * interface. */
export class DirectSessionWriter implements SessionWriter {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  followup(agent: AgentLike, message: unknown): void {
    agent.followup(message)
  }

  steer(deps: SteerDeps, text: string, options?: SteerAllOptions): Promise<SteerOutcome> {
    // The guard-orchestrated steer seam (steer.ts) stays the pure core;
    // the port is the boundary a Remote adapter will implement over the
    // wire.
    return steerAll(deps, text, options)
  }

  dequeue(agent: AgentLike, messageId: string): void {
    agent.inbox.remove(messageId)
  }

  cancel(agent: CancelAgentLike, reason: unknown, options: { keepInbox: boolean }): void {
    agent.cancel(reason, options)
  }

  rename(session: SessionLike, name: string): boolean {
    const titles = this.ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) return false
    titles.rename(session, name)
    return true
  }

  async refreshTitle(session: SessionLike, signal: AbortSignal): Promise<
    | { kind: 'unavailable' }
    | { kind: 'ok'; title: string | undefined }
  > {
    const titles = this.ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) return { kind: 'unavailable' }
    const regenerated = await titles.refresh(session, signal)
    return { kind: 'ok', title: regenerated?.title }
  }
}
