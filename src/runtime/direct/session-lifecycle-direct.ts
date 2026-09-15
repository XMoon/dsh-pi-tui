/**
 * The Direct session lifecycle (D2.1 contract convergence, D2.3 semantic
 * convergence) — the in-process implementation of `SessionLifecycle` over the
 * dsh `agents` service.
 *
 * D2.3 moved the Direct-only activation requirements INSIDE the adapter: the
 * cross-backend request carries only the semantic create/open intent, while
 * the adapter resolves the Host global default for `agentOptions` and the
 * persisted recorded preset for an open. The semantic `open()` operation
 * still calls the Direct `agents.resume()` API; this Host implementation
 * detail is intentionally hidden at the port.
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
import { recordedSessionPreset } from './session-preset-direct.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { CreateResult, CreateSessionRequest, OpenResult, OpenSessionRequest, SessionLifecycle } from '../session-lifecycle-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Host default-model service the Direct activation fallback reads. */
export interface DefaultModelServiceLike {
  currentSelection(): { readonly provider: string; readonly model: string } | undefined
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
 * preset id — it never crosses the port contract. The activation
 * provider/model fallback is the Host global default, exactly like the
 * official `ApiSessionAgentController.agentOptions()`. */
export class DirectSessionLifecycle implements SessionLifecycle {
  private readonly ctx: HostContextLike
  private readonly compose: (presetId?: string) => Promise<CompositionLike>

  constructor(ctx: HostContextLike, compose: (presetId?: string) => Promise<CompositionLike>) {
    this.ctx = ctx
    this.compose = compose
  }

  /** The in-process activation fallback: the Host global default, never a
   *  cross-backend request input. */
  private agentOptions(): { provider?: string; model?: string } {
    const selection = (this.ctx.get('agentDefaultModel') as DefaultModelServiceLike | undefined)?.currentSelection()
    return selection === undefined ? {} : { provider: selection.provider, model: selection.model }
  }

  async create(request: CreateSessionRequest): Promise<CreateResult> {
    if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) {
      return currentCreateRejected('session/create-unavailable', 'agents service unavailable')
    }
    try {
      // The preset composition (with its agent-setup callback) is a Direct
      // concern: resolved inside the adapter from the request's preset id.
      const composition = await this.compose(request.agentPreset)
      // The semantic `agentPreset` is the SINGLE preset authority: the adapter
      // persists the preset it actually composed. A legacy seeded/fork caller
      // that still carries `meta.agentPreset` must agree with it (D2.4 folds
      // that transition path away).
      const metaPreset = request.meta.agentPreset
      if (metaPreset !== undefined && composition.agentPreset !== undefined && metaPreset !== composition.agentPreset) {
        throw new Error(`create meta.agentPreset "${String(metaPreset)}" disagrees with the semantic agentPreset "${composition.agentPreset}"`)
      }
      const handle = await agents.create({
        sessionId: SessionId(request.sessionId),
        meta: composition.agentPreset === undefined
          ? request.meta
          : { ...request.meta, agentPreset: composition.agentPreset },
        agentOptions: this.agentOptions(),
        setup: composition.setup,
        seed: request.seed as readonly SessionEvent[] | undefined,
        ...request.inheritedEventCount === undefined ? {} : { inheritedEventCount: SessionLogOffset(request.inheritedEventCount) },
        signal: request.signal,
      })
      // Preserve both the live Agent and the real AgentHandle. The latter is
      // the ownership capability the runner disposes at retirement. The Direct
      // adapter is the only writer for its own in-process Agent, so its result
      // always owns the current surface.
      return {
        ownership: 'current',
        outcome: { kind: 'created', handle: { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } } },
      }
    } catch (error) {
      // The upstream `agents.create` signal is a PRE-PUBLICATION cancellation
      // contract: an abort mid-create provably did not publish (v2 §0.2.4), so
      // it stays `cancelled` instead of a bogus rejection.
      if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
      // Any other in-process create failure is a proven pre-publication
      // rejection (there is no wire ambiguity in the Direct path).
      return currentCreateRejected('session/create-failed', safeErrorMessage(error))
    }
  }

  async open(request: OpenSessionRequest): Promise<OpenResult> {
    if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) {
      return { ownership: 'current', outcome: { kind: 'unavailable', message: 'agents service unavailable' } }
    }
    try {
      // The Direct adapter owns the persisted-preset lookup the official open
      // semantic needs in-process: the recorded preset wins (a session that
      // switched while blank ran every turn under the newer composition).
      const recorded = await recordedSessionPreset(this.ctx, request.sessionId, request.signal)
      const composition = await this.compose(recorded)
      // `resume` is deliberately the Direct service call; `open` is the
      // transport-neutral semantic exposed to the runner and future clients.
      const handle = await agents.resume({
        resumeSessionId: SessionId(request.sessionId),
        agentOptions: this.agentOptions(),
        setup: composition.setup,
        signal: request.signal,
      })
      return {
        ownership: 'current',
        outcome: { kind: 'opened', handle: { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } } },
      }
    } catch (error) {
      // A mid-open abort is a client-local cancellation, not an unavailable
      // Session (v2 §0.2.4/§0.5).
      if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
      return { ownership: 'current', outcome: { kind: 'unavailable', message: safeErrorMessage(error) } }
    }
  }
}

/** A Direct create rejection that still owns the local surface. */
function currentCreateRejected(code: string, message: string): CreateResult {
  return { ownership: 'current', outcome: { kind: 'rejected', error: { code, message } } }
}
