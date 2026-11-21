/**
 * The Host-owned exact-Session policy bridge (M6-1 F8).
 *
 * The official `ctx.approval` and `ctx.sandboxPolicy` services remain the ONLY
 * policy authorities: this service never writes a session event itself, never
 * caches a policy value, never touches the permission-preset table and never
 * fabricates an `unconfirmed` outcome (that classification is Client-side).
 *
 * ```text
 * read(sessionId)            -> approval/sandbox override + effective facts
 * setApproval(sessionId, p)  -> the official approval.setPolicy(liveAgent, p)
 * ```
 *
 * Both methods are Owner-only and fail closed BEFORE any official service is
 * read or the Session log is touched. A Host without the approval service
 * (or without the sandbox service) still becomes Ready — the missing side is
 * reported as its own `service-not-installed` fact, and a missing approval
 * service makes `setApproval` a definite refusal.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/session-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ApprovalPolicy,
  PolicySide,
  SandboxMode,
  SessionPolicyRead,
} from '../../../runtime/session-policy-port.ts'
import type { SessionPolicySetWireOutcome } from '../../../runtime/remote/pi-tui-session-policy-contract.ts'
import {
  PI_TUI_SESSION_POLICY_NAMESPACE,
  parseSessionApprovalPolicy,
} from '../../../runtime/remote/pi-tui-session-policy-contract.ts'

/** Structural faces the Host runtime resolves per call (never hard-injected:
 *  a missing optional service must not stop the Host from becoming Ready). */
export interface SessionLike {
  readonly id: string
}

export interface ApprovalServiceLike {
  overrideOf(session: SessionLike): ApprovalPolicy | undefined
  setPolicy(agent: unknown, policy: ApprovalPolicy): void
  readonly config: { readonly policy?: ApprovalPolicy }
}

export interface SandboxPolicyServiceLike {
  overrideOf(session: SessionLike): SandboxMode | undefined
  resolve(request?: { readonly session?: SessionLike }): { readonly mode: SandboxMode }
}

export interface PiTuiSessionPolicyHostDeps {
  sessions(): { get(sessionId: string): SessionLike | undefined } | undefined
  agents(): { get(sessionId: string): unknown } | undefined
  approval(): ApprovalServiceLike | undefined
  sandboxPolicy(): SandboxPolicyServiceLike | undefined
}

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

export class PiTuiSessionPolicyHostService extends TypertRemoteService {
  static readonly inject = ['typert']

  private readonly deps: PiTuiSessionPolicyHostDeps

  constructor(ctx: Context, deps: PiTuiSessionPolicyHostDeps) {
    super(ctx, PI_TUI_SESSION_POLICY_NAMESPACE)
    this.deps = deps
  }

  /**
   * The exact-Session two-knob read. Identity first (the exact live Session),
   * then each official service INDEPENDENTLY: a missing service is that
   * side's `unavailable` fact, and a THROWING service fails the whole read —
   * never a fabricated "no override".
   */
  async read(sessionId: string, signal: AbortSignal): Promise<SessionPolicyRead> {
    signal.throwIfAborted()
    this.assertOwner()
    const session = this.liveSession(sessionId)
    if (session === undefined) {
      return { kind: 'unavailable', sessionId, reason: 'session-not-live' }
    }
    const approval = this.approvalSide(session)
    const sandbox = this.sandboxSide(session)
    // The answer describes the session object it was derived from: a
    // synchronous registry replacement invalidates it before the return.
    signal.throwIfAborted()
    if (this.deps.sessions()?.get(sessionId) !== session) {
      return { kind: 'unavailable', sessionId, reason: 'session-not-live' }
    }
    return { kind: 'ready', sessionId, approval, sandbox }
  }

  /**
   * The exact-Session approval write. The official setter is called EXACTLY
   * once, with no Host-side same-value append, no sandbox mutation and no
   * synthetic model notice (the official setter owns the notice). An
   * already-effective value is the official no-op and still returns `applied`.
   */
  async setApproval(sessionId: string, policy: ApprovalPolicy, signal: AbortSignal): Promise<SessionPolicySetWireOutcome> {
    signal.throwIfAborted()
    this.assertOwner()
    const exact = parseSessionApprovalPolicy(policy)
    const session = this.liveSession(sessionId)
    if (session === undefined) {
      return { kind: 'refused', reason: 'session-not-live' }
    }
    const agents = this.deps.agents()
    const agent = agents?.get(sessionId)
    if (agent === undefined) {
      return { kind: 'refused', reason: 'agent-not-live' }
    }
    if (this.deps.sessions()?.get(sessionId) !== session || (agent as { readonly session?: unknown }).session !== session) {
      return { kind: 'refused', reason: 'agent-not-live' }
    }
    const approval = this.deps.approval()
    if (approval === undefined) {
      return { kind: 'refused', reason: 'approval-unavailable' }
    }
    // No await between the last identity check and the single official call.
    signal.throwIfAborted()
    approval.setPolicy(agent, exact)
    return { kind: 'applied', sessionId }
  }

  private approvalSide(session: SessionLike): PolicySide<ApprovalPolicy> {
    const approval = this.deps.approval()
    if (approval === undefined) {
      return { state: 'unavailable', reason: 'service-not-installed' }
    }
    // `overrideOf` may throw (the official projection read); that failure
    // propagates — it is never a silent "no override".
    const override = approval.overrideOf(session)
    if (override !== undefined && override !== 'ask' && override !== 'never') {
      throw new Error('piTuiSessionPolicy: the approval service returned an unknown policy')
    }
    // The configured deployment default is ALSO a closed vocabulary: a bad
    // value must fail the read, never become a ready `effective`.
    const configured = approval.config.policy
    if (configured !== undefined && configured !== 'ask' && configured !== 'never') {
      throw new Error('piTuiSessionPolicy: the approval service config carries an unknown policy')
    }
    const effective = override ?? configured ?? 'ask'
    return { state: 'ready', effective, ...(override === undefined ? {} : { override }) }
  }

  private sandboxSide(session: SessionLike): PolicySide<SandboxMode> {
    const service = this.deps.sandboxPolicy()
    if (service === undefined) {
      return { state: 'unavailable', reason: 'service-not-installed' }
    }
    const override = service.overrideOf(session)
    if (override !== undefined && !SANDBOX_MODES.includes(override)) {
      throw new Error('piTuiSessionPolicy: the sandbox service returned an unknown mode')
    }
    // The session-scoped resolve ONLY: the agentless default never substitutes
    // for a live session's policy.
    const mode = service.resolve({ session }).mode
    if (!SANDBOX_MODES.includes(mode)) {
      throw new Error('piTuiSessionPolicy: the sandbox service resolved an unknown mode')
    }
    return { state: 'ready', effective: mode, ...(override === undefined ? {} : { override }) }
  }

  private liveSession(sessionId: string): SessionLike | undefined {
    const sessions = this.deps.sessions()
    const session = sessions?.get(sessionId)
    if (session === undefined || session.id !== sessionId) return undefined
    return session
  }

  /** The exact authenticated-Owner gate, run before any service access. */
  private assertOwner(): void {
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      throw new Error('piTuiSessionPolicy: session policy is restricted to the authenticated Owner peer')
    }
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }
}
