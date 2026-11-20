/**
 * The private `piTuiPromptPresence` Host service (M6 PR-C C3): the ONE
 * authenticated per-Peer presence projection the Split Host folds into the
 * per-Turn TUI prompt decision.
 *
 * ```text
 * syncView(viewedSessionId|null, displayPreset, revision)
 *   -> the authenticated Owner Peer's CURRENT view is replaced atomically
 *      (one record per exact `RemoteInvocation.peer.id`) and the ACK is
 *      emitted AFTER that commit
 * snapshotVoters(session)
 *   -> { eligible, focus } folded over the records that currently show that
 *      EXACT Session object (any-Focus-wins)
 * ```
 *
 * Authority discipline:
 *
 * - The record key is the EXACT peer identity of the calling Peer. A
 *   Client-supplied id, a socket id or a Session id is never a key, so one
 *   Client can never speak for another.
 * - A viewed Session id must resolve FRESH to the live Host `Session` AND the
 *   live `Agent` of that Session (`agent.session === session`), and the
 *   Session must be ordinary (`header.origin !== 'subagent'`). Anything else
 *   is a definite `session-not-live` refusal — a subagent-origin Session can
 *   never acquire TUI prompt policy through presence.
 * - The record holds the EXACT Session/Agent objects accepted at commit; the
 *   per-Turn fold compares object identity against the CURRENT registries, so
 *   a same-id replacement invalidates the voter instead of voting.
 * - The display preset stays CLIENT-LOCAL. This service stores the reported
 *   preset as a detached fact and never becomes a second display authority;
 *   it does not write any Session event.
 * - A record is retired when its Peer's `peer.signal` aborts (Client exit,
 *   transport loss, Host teardown), so a dead Client can never keep a
 *   Session nominally Focus.
 * - A stale or duplicated revision is refused WITHOUT touching the committed
 *   record, so an out-of-order delivery cannot resurrect a withdrawn
 *   membership. A malformed/unauthorized call changes nothing.
 *
 * LAYER NOTE: the Host row lives in `app/host/features/**` (the built-in Host
 * Runtime owns it and its lifetime). The per-Turn LATCH stays a separate
 * neutral owner (`app/agent/turn-policy.ts`: sampled ONCE at the official
 * `turn/start`, frozen for the Turn) — this service only answers "who is
 * showing that Session right now".
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/prompt-presence
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { DisplayPreset } from '../../../domain/display/preset.ts'
import { isFocusDisplayPreset } from '../../../domain/display/preset.ts'
import {
  PI_TUI_PROMPT_PRESENCE_NAMESPACE,
  type PiTuiPromptPresenceRefusal,
  type PiTuiPromptPresenceSyncResult,
  type PiTuiPromptVoterSnapshot,
} from '../../../runtime/remote/pi-tui-prompt-presence-contract.ts'

/** The structural Host Session face this service validates and stores. */
export interface PromptPresenceSessionLike {
  readonly id: string
  /** The official creation header; `origin === 'subagent'` marks a subagent. */
  readonly header: { readonly origin?: string }
}

/** The structural Host Agent face this service validates and stores. */
export interface PromptPresenceAgentLike {
  /** The exact durable Session this Agent drives (`agent.session`). */
  readonly session: PromptPresenceSessionLike
}

/** The authoritative Host registries, resolved PER CALL (never captured). */
export interface PiTuiPromptPresenceHostDeps {
  sessions(): { get(sessionId: string): PromptPresenceSessionLike | undefined } | undefined
  agents(): { get(sessionId: string): PromptPresenceAgentLike | undefined } | undefined
}

/** One committed presence record: the accepted view and its exact objects. */
export interface PromptPresenceRecord {
  /** The exact Peer identity that owns this record. */
  readonly peerId: string
  /** The exact Session object accepted at commit (`null` = no viewed Session). */
  readonly session: PromptPresenceSessionLike | null
  /** The exact Agent object accepted at commit (`null` = no viewed Session). */
  readonly agent: PromptPresenceAgentLike | null
  /** The exact Session this Peer currently shows, or `null` (surface with none). */
  readonly viewedSessionId: string | null
  /** The Client-local display preset this Peer reported. */
  readonly displayPreset: DisplayPreset
  /** The monotonic Client revision of this record. */
  readonly revision: number
  /** The Peer lifetime; an aborted signal removes the record's vote. */
  readonly peerSignal: AbortSignal
}

/**
 * The Host endpoint. One instance per built-in Host Runtime; its records and
 * its subscriptions leave with the owning fiber.
 */
export class PiTuiPromptPresenceHostService extends TypertRemoteService {
  /** The Typert registry owns the explicit invocation definitions. */
  static readonly inject = ['typert']

  /** The committed records, keyed by the EXACT Peer identity. */
  private readonly records = new Map<string, PromptPresenceRecord>()
  /** The row lifetime: a disposed scope refuses instead of committing. */
  private readonly lifecycle = new AbortController()
  private readonly deps: PiTuiPromptPresenceHostDeps

  /**
   * @param ctx - the Host context this row is mounted in.
   * @param deps - the authoritative Session/Agent registries, per call.
   */
  constructor(ctx: Context, deps: PiTuiPromptPresenceHostDeps) {
    super(ctx, PI_TUI_PROMPT_PRESENCE_NAMESPACE)
    this.deps = deps
    ctx.effect(() => () => {
      this.lifecycle.abort()
      this.records.clear()
    }, 'pi-tui-prompt-presence')
  }

  /** The live record count (qualification/tests; never a policy input). */
  recordCount(): number {
    return this.records.size
  }

  /** The committed record of one exact Peer id, or undefined. */
  recordOf(peerId: string): PromptPresenceRecord | undefined {
    return this.records.get(peerId)
  }

  /**
   * Replace the calling Peer's current view. Owner-only and fail-closed BEFORE
   * any state change; the ACK is returned only AFTER the map commit, so a
   * Client that lost the ACK knows its presence is unconfirmed.
   */
  async syncView(
    viewedSessionId: string | null,
    displayPreset: DisplayPreset,
    revision: number,
    signal: AbortSignal,
  ): Promise<PiTuiPromptPresenceSyncResult> {
    signal.throwIfAborted()
    const refusal = this.refusalOf(this.ctx.invocation, signal)
    if (refusal !== undefined) return { kind: 'refused', reason: refusal }
    const invocation = this.ctx.invocation!
    const peerId = invocation.peer.id
    const current = this.records.get(peerId)
    if (current !== undefined && revision <= current.revision) {
      return { kind: 'refused', reason: 'stale-revision' }
    }
    // A `null` view is always acceptable (a surface with no Session carries no
    // vote); a Session id must resolve to the LIVE ordinary pair right now.
    let session: PromptPresenceSessionLike | undefined
    let agent: PromptPresenceAgentLike | undefined
    if (viewedSessionId !== null) {
      session = this.deps.sessions()?.get(viewedSessionId)
      agent = session === undefined ? undefined : this.deps.agents()?.get(viewedSessionId)
      if (
        session === undefined
        || agent === undefined
        || agent.session !== session
        || session.header.origin === 'subagent'
      ) {
        return { kind: 'refused', reason: 'session-not-live' }
      }
    }
    const record: PromptPresenceRecord = {
      peerId,
      session: session ?? null,
      agent: agent ?? null,
      viewedSessionId,
      displayPreset,
      revision,
      peerSignal: invocation.peer.signal,
    }
    this.records.set(peerId, record)
    // ONE retirement observer per Peer lifetime (never per sync): the peer
    // record is replaced on every later revision, but the observer is
    // installed exactly on the peer's FIRST accepted call.
    if (current === undefined) this.watchPeerLifetime(invocation)
    return { kind: 'applied', revision }
  }

  /**
   * Fold the current voters of one EXACT Session object. The Host-internal
   * per-Turn sampler: it compares object identity with the CURRENT live
   * Session and Agent, filters signal-aborted/mismatched records, and ORs the
   * presets (any Focus wins). Never throws: a degraded registry is the honest
   * ineligible answer, never a guessed vote.
   */
  snapshotVoters(session: PromptPresenceSessionLike): PiTuiPromptVoterSnapshot {
    const sessions = this.deps.sessions()
    const agents = this.deps.agents()
    if (sessions === undefined || agents === undefined) return { eligible: false, focus: false }
    if (sessions.get(session.id) !== session) return { eligible: false, focus: false }
    let eligible = false
    let focus = false
    for (const record of this.records.values()) {
      if (record.viewedSessionId !== session.id) continue
      if (record.session !== session) continue
      if (record.agent !== agents.get(session.id)) continue
      if (record.peerSignal.aborted) continue
      eligible = true
      if (isFocusDisplayPreset(record.displayPreset)) focus = true
    }
    return { eligible, focus: eligible && focus }
  }

  /** The exact authenticated-Owner gate, run before any state access. */
  private refusalOf(
    invocation: RemoteInvocation | undefined,
    signal: AbortSignal,
  ): PiTuiPromptPresenceRefusal | undefined {
    if (this.lifecycle.signal.aborted) return 'scope-unavailable'
    if (invocation === undefined) return 'owner-required'
    if (invocation.peer.principal.kind !== 'owner') return 'owner-required'
    if (signal.aborted || invocation.signal.aborted || invocation.peer.signal.aborted) return 'owner-required'
    return undefined
  }

  /**
   * Retire one Peer's record when its lifetime ends. The registration is
   * installed ONCE per Peer; the abort listener and the record drop are the
   * same fact, so a racing Client exit cannot leave a live-looking record.
   */
  private watchPeerLifetime(invocation: RemoteInvocation): void {
    const peerId = invocation.peer.id
    // Presence is per-Peer, so the observation must outlive one invocation:
    // register through the peer's own connection-lifetime Context.
    invocation.peer.ctx.effect(() => () => {
      this.records.delete(peerId)
    }, 'pi-tui-prompt-presence peer record')
  }
}
