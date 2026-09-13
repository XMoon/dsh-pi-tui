/**
 * The Direct session lifecycle (D2.1 contract convergence) — the in-process
 * implementation of `SessionLifecycle` over the dsh `agents` service. The
 * semantic `open()` operation still calls the Direct `agents.resume()` API;
 * this Host implementation detail is intentionally hidden at the port.
 *
 * The adapter is the only module in the session create/open path that touches
 * `ctx` and the preset composition. It converts the transitional lifecycle
 * request into Direct shapes (`setup` callback, `SessionId`, seed) and keeps
 * the real AgentHandle ownership escape required by the current runner.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-lifecycle-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CreateSessionRequest, OpenSessionRequest, SessionHandle, SessionLifecycle } from '../session-lifecycle-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The preset composition the adapter resolves internally (the runner's
 * compose function satisfies this structurally). */
export interface CompositionLike {
  agentPreset?: string
  setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
}

/** The structural `agents` service surface the lifecycle needs. */
export interface AgentsServiceLike {
  create(options: {
    sessionId: ReturnType<typeof SessionId>
    meta: Record<string, unknown>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
    seed?: readonly SessionEvent[]
    /** Exact fork-inherited prefix length when `meta.isSeeded` is set. */
    inheritedEventCount?: ReturnType<typeof SessionLogOffset>
    signal?: AbortSignal
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: ReturnType<typeof SessionId>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
    signal?: AbortSignal
  }): Promise<AgentHandle>
}

/** The Direct backend's session lifecycle: the `ctx.agents` service behind
 * the semantic `SessionLifecycle` interface. The preset composition (and
 * with it the agent-setup callback) is resolved here from the request's
 * preset id — it never crosses the port contract. */
export class DirectSessionLifecycle implements SessionLifecycle {
  private readonly ctx: HostContextLike
  private readonly compose: (presetId?: string) => Promise<CompositionLike>

  constructor(ctx: HostContextLike, compose: (presetId?: string) => Promise<CompositionLike>) {
    this.ctx = ctx
    this.compose = compose
  }

  async create(request: CreateSessionRequest): Promise<SessionHandle> {
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) throw new Error('agents service unavailable')
    // The preset composition (with its agent-setup callback) is a Direct
    // concern: resolved inside the adapter from the request's preset id.
    const composition = await this.compose(request.agentPreset)
    const handle = await agents.create({
      sessionId: SessionId(request.sessionId),
      meta: request.meta,
      agentOptions: { provider: request.provider, model: request.model },
      setup: composition.setup,
      seed: request.seed as readonly SessionEvent[] | undefined,
      ...request.inheritedEventCount === undefined ? {} : { inheritedEventCount: SessionLogOffset(request.inheritedEventCount) },
      signal: request.signal,
    })
    // Preserve both the live Agent and the real AgentHandle. The latter is
    // the ownership capability the runner disposes at retirement.
    return { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } }
  }

  async open(request: OpenSessionRequest): Promise<SessionHandle> {
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) throw new Error('agents service unavailable')
    const composition = await this.compose(request.agentPreset)
    // `resume` is deliberately the Direct service call; `open` is the
    // transport-neutral semantic exposed to the runner and future clients.
    const handle = await agents.resume({
      resumeSessionId: SessionId(request.resumeSessionId),
      agentOptions: { provider: request.provider, model: request.model },
      setup: composition.setup,
      signal: request.signal,
    })
    return { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } }
  }
}
