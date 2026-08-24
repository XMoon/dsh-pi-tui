/**
 * The Direct session lifecycle (M1.5) — the in-process implementation of
 * `SessionLifecycle` over the dsh `agents` service. This is the ONLY module
 * in the session create/resume path that touches `ctx`; the runner keeps
 * the Direct-mode ownership machinery (owner.lock, lease/cooling, PINNED,
 * transition gate, operation barrier) around the port calls, and a Remote
 * adapter will implement the same interface in a later milestone.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-lifecycle-direct
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CreateSessionOptions, ResumeSessionOptions, SessionLifecycle } from '../session-lifecycle-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The structural `agents` service surface the lifecycle needs. */
export interface AgentsServiceLike {
  create(options: CreateSessionOptions): Promise<AgentHandle>
  resume(options: ResumeSessionOptions): Promise<AgentHandle>
}

/** The Direct backend's session lifecycle: the `ctx.agents` service behind
 * the semantic `SessionLifecycle` interface. */
export class DirectSessionLifecycle implements SessionLifecycle {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  async create(options: CreateSessionOptions): Promise<AgentHandle> {
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) throw new Error('agents service unavailable')
    return agents.create(options)
  }

  async resume(options: ResumeSessionOptions): Promise<AgentHandle> {
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) throw new Error('agents service unavailable')
    return agents.resume(options)
  }
}
