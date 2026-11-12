/**
 * The ONE transport-neutral session-policy port (M6-1 F8): the independent
 * approval-policy and sandbox-mode facts of one exact live Host Session, and
 * the single exact-Session approval write.
 *
 * The official Host services (`ctx.approval`, `ctx.sandboxPolicy`) are the
 * ONLY authority. This DTO is detached: it never carries a Host Session or
 * Agent object, a workspace path, a permission-preset table or a token, and
 * it is never cached on the Client — every `ready` value is Host-derived and
 * generation-fenced by the adapters that produce it.
 *
 * Contract highlights (frozen plan §3.1):
 *
 * - `override` is ABSENT when the official read succeeded and the session has
 *   no override; the `effective` value then already includes the Host config
 *   default. `override: undefined` never means "read failed" — failures throw.
 * - `service-not-installed` / `session-not-live` are DEFINITE Host facts; a
 *   transport failure or an unreadable projection is a thrown error (or the
 *   write-side `unconfirmed`), never a fake `unavailable`.
 * - The approval side and the sandbox side fail INDEPENDENTLY: one missing
 *   official service never erases the other side's proven fact.
 * - `applied` only proves the official setter returned; it is NOT a Client
 *   readback. The official `setPolicy` is a no-op when the effective policy
 *   already matches, and that no-op is still a legitimate `applied`.
 * - `unconfirmed` means the write was dispatched but its outcome is unknown.
 *   It is never retried and never rendered as "not applied".
 *
 * @module @xmoon76/dsh-pi-tui/runtime/session-policy-port
 */

/** The official per-session approval policy vocabulary. */
export type ApprovalPolicy = 'ask' | 'never'

/** The official sandbox mode vocabulary (policy facts, never enforcement proof). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** One knob's proven fact: the effective value, plus the session override
 *  when the Host states one. */
export type PolicySide<T extends string> =
  | { readonly state: 'ready'; readonly effective: T; readonly override?: T }
  | { readonly state: 'unavailable'; readonly reason: 'service-not-installed' }

/** The read result for one exact session id. */
export type SessionPolicyRead =
  | {
    readonly kind: 'ready'
    readonly sessionId: string
    readonly approval: PolicySide<ApprovalPolicy>
    readonly sandbox: PolicySide<SandboxMode>
  }
  | { readonly kind: 'unavailable'; readonly sessionId: string; readonly reason: 'session-not-live' }

/** The outcome of one exact-Session approval-policy write attempt. */
export type SessionPolicySetOutcome =
  | { readonly kind: 'applied'; readonly sessionId: string }
  | {
    readonly kind: 'refused'
    /** `session-not-live`/`agent-not-live`/`approval-unavailable` are the
     *  Host's proven identity/service facts; `invalid-request` is the Client
     *  adapter's proven pre-invocation refusal (nothing was sent). */
    readonly reason: 'session-not-live' | 'agent-not-live' | 'approval-unavailable' | 'invalid-request'
  }
  | { readonly kind: 'unconfirmed'; readonly reason: string }

/** The transport-neutral session-policy port both backends serve. */
export interface SessionPolicyPort {
  /** One authoritative read for `sessionId`. No Client cache; each success is
   *  Host-derived and generation-fenced by the adapter. */
  read(sessionId: string, signal?: AbortSignal): Promise<SessionPolicyRead>
  /** A single exact-Session official setPolicy attempt; never replayed. */
  setApproval(sessionId: string, policy: ApprovalPolicy, signal?: AbortSignal): Promise<SessionPolicySetOutcome>
}
