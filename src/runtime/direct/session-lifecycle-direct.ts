/**
 * The Direct session lifecycle (M1.5, contract-reviewed) — the in-process
 * implementation of `SessionLifecycle` over the dsh `agents` service. The
 * adapter is the ONLY module in the session create/resume path that
 * touches `ctx` and the preset composition; the semantic request (preset
 * id, provider/model) is converted HERE into the Direct shapes (`setup`
 * callback, `SessionId`, seed), and a Remote adapter will implement the
 * same interface over the wire. The runner keeps the Direct-mode
 * ownership machinery (owner.lock, lease/cooling, PINNED, transition
 * gate, operation barrier) around the port calls.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-lifecycle-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CreateSessionRequest, ResumeSessionRequest, SessionHandle, SessionLifecycle } from '../session-lifecycle-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The preset composition the adapter resolves internally (the runner's
 * compose function satisfies this structurally). */
export interface CompositionLike {
  agentPreset?: string
  setup: (agentCtx: Context) => Promise<void> | void
}

/** The structural `agents` service surface the lifecycle needs. */
export interface AgentsServiceLike {
  create(options: {
    sessionId: ReturnType<typeof SessionId>
    meta: Record<string, unknown>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context) => Promise<void> | void
    seed?: readonly SessionEvent[]
    signal?: AbortSignal
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: ReturnType<typeof SessionId>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context) => Promise<void> | void
  }): Promise<AgentHandle>
}

/** The Direct backend's session lifecycle: the `ctx.agents` service behind
 * the semantic `SessionLifecycle` interface. The preset composition (and
 * with it the agent-setup callback) is resolved HERE from the request's
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
      signal: request.signal,
    })
    // The ownership escape preserves BOTH the live agent and the real
    // AgentHandle: `dispose()` is the ownership capability the runner
    // needs at retirement (a lost handle previously pinned old leases —
    // the P1 regression class). The semantic `session` identity stays
    // transport-neutral.
    return { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } }
  }

  async resume(request: ResumeSessionRequest): Promise<SessionHandle> {
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) throw new Error('agents service unavailable')
    const composition = await this.compose(request.agentPreset)
    const handle = await agents.resume({
      resumeSessionId: SessionId(request.resumeSessionId),
      agentOptions: { provider: request.provider, model: request.model },
      setup: composition.setup,
    })
    return { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } }
  }
}