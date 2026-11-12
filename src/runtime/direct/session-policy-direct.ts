/**
 * The Direct `SessionPolicyPort` (M6-1 F8): the official in-process
 * `ctx.approval` / `ctx.sandboxPolicy` services behind the shared neutral
 * contract, with the same outcome classification the Remote adapter serves.
 *
 * The official services stay the ONLY authority: this adapter owns no cache,
 * no second policy store and no preset inference. Identity is resolved to the
 * EXACT live Session/Agent inside the adapter (never across the port).
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-policy-direct
 */

import type {
  ApprovalPolicy,
  PolicySide,
  SandboxMode,
  SessionPolicyPort,
  SessionPolicyRead,
  SessionPolicySetOutcome,
} from '../session-policy-port.ts'

/** The structural official approval service face. */
export interface DirectApprovalServiceLike {
  overrideOf(session: unknown): ApprovalPolicy | undefined
  setPolicy(agent: unknown, policy: ApprovalPolicy): void
  readonly config: { readonly policy?: ApprovalPolicy }
}

/** The structural official sandbox-policy service face. */
export interface DirectSandboxPolicyServiceLike {
  overrideOf(session: unknown): SandboxMode | undefined
  resolve(request?: { readonly session?: unknown }): { readonly mode: SandboxMode }
}

/** The minimal Direct Host context face (service resolution per call). */
export interface DirectSessionPolicyContextLike {
  get(name: string): unknown
}

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** The Direct session-policy adapter over the official in-process services.
 *
 * Identity is the runner's EXACT live-Agent resolver: the Agent object is the
 * Direct authority for its Session (the semantic port never crosses an Agent).
 * The captured Agent identity is re-checked before any answer is committed and
 * immediately before the official write, so a replaced Agent/Session cannot
 * carry an old read or write across.
 */
export class DirectSessionPolicyPort implements SessionPolicyPort {
  private readonly ctx: DirectSessionPolicyContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined

  constructor(
    ctx: DirectSessionPolicyContextLike,
    agentFor: (sessionId: string) => unknown | undefined,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async read(sessionId: string, signal?: AbortSignal): Promise<SessionPolicyRead> {
    signal?.throwIfAborted()
    const exact = this.exactAgent(sessionId)
    if (exact === undefined) {
      return { kind: 'unavailable', sessionId, reason: 'session-not-live' }
    }
    const approval = this.approvalSide(exact.session)
    const sandbox = this.sandboxSide(exact.session)
    signal?.throwIfAborted()
    if (this.agentFor(sessionId) !== exact.agent) {
      return { kind: 'unavailable', sessionId, reason: 'session-not-live' }
    }
    return { kind: 'ready', sessionId, approval, sandbox }
  }

  async setApproval(sessionId: string, policy: ApprovalPolicy, signal?: AbortSignal): Promise<SessionPolicySetOutcome> {
    signal?.throwIfAborted()
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return { kind: 'refused', reason: 'session-not-live' }
    const session = (agent as { readonly session?: unknown }).session
    if (session === undefined) return { kind: 'refused', reason: 'agent-not-live' }
    const exact = { agent, session }
    const approval = this.ctx.get('approval') as DirectApprovalServiceLike | undefined
    if (approval === undefined) return { kind: 'refused', reason: 'approval-unavailable' }
    // No await between the last identity check and the single official call.
    signal?.throwIfAborted()
    if (this.agentFor(sessionId) !== exact.agent) return { kind: 'refused', reason: 'agent-not-live' }
    try {
      approval.setPolicy(exact.agent, policy)
    } catch (error) {
      // The official setter threw after admission: whether the session log
      // changed is unknown — never guess "refused".
      return { kind: 'unconfirmed', reason: errorMessage(error) }
    }
    return { kind: 'applied', sessionId }
  }

  /** The exact live Agent plus its Session, or undefined when the resolver has
   *  no live Agent for the id (a definite "not live" fact). */
  private exactAgent(sessionId: string): { readonly agent: unknown; readonly session: unknown } | undefined {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return undefined
    const session = (agent as { readonly session?: unknown }).session
    if (session === undefined) return undefined
    return { agent, session }
  }

  private approvalSide(session: unknown): PolicySide<ApprovalPolicy> {
    const approval = this.ctx.get('approval') as DirectApprovalServiceLike | undefined
    if (approval === undefined) {
      return { state: 'unavailable', reason: 'service-not-installed' }
    }
    const override = approval.overrideOf(session)
    if (override !== undefined && override !== 'ask' && override !== 'never') {
      throw new Error('session policy: the approval service returned an unknown policy')
    }
    // The configured deployment default is ALSO a closed vocabulary: a bad
    // value must fail the read, never become a ready `effective`.
    const configured = approval.config.policy
    if (configured !== undefined && configured !== 'ask' && configured !== 'never') {
      throw new Error('session policy: the approval service config carries an unknown policy')
    }
    return {
      state: 'ready',
      effective: override ?? configured ?? 'ask',
      ...(override === undefined ? {} : { override }),
    }
  }

  private sandboxSide(session: unknown): PolicySide<SandboxMode> {
    const service = this.ctx.get('sandboxPolicy') as DirectSandboxPolicyServiceLike | undefined
    if (service === undefined) {
      return { state: 'unavailable', reason: 'service-not-installed' }
    }
    const override = service.overrideOf(session)
    if (override !== undefined && !SANDBOX_MODES.includes(override)) {
      throw new Error('session policy: the sandbox service returned an unknown mode')
    }
    const mode = service.resolve({ session }).mode
    if (!SANDBOX_MODES.includes(mode)) {
      throw new Error('session policy: the sandbox service resolved an unknown mode')
    }
    return { state: 'ready', effective: mode, ...(override === undefined ? {} : { override }) }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
